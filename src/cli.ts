/**
 * 命令入口。只做三件事：解析参数、分发、统一异常处理。
 * 业务逻辑一律在 reindex / store / compile / query 里。
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCompile } from './compile.js';
import { loadDotEnv, llmConfig } from './env.js';
import { createLlmClient } from './llm.js';
import { analyzeGraph, formatGraphReport, renderMermaid } from './graph.js';
import { runQuery } from './query.js';
import { ensureIndex, reindex, statusReport, type StatusReport } from './reindex.js';
import { ensureDirs, readIndex, ROOT } from './store.js';

const CLI_OPTIONS = {
  all: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  mermaid: { type: 'boolean', default: false },
  'max-nodes': { type: 'string', default: '0' },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `my-wiki —— 把 raw/ 下的素材编译成互相链接的 Markdown wiki

用法：
  pnpm dev check                      验证 LLM 配置（key / 端点 / 模型名）是否可用
  pnpm dev status                     查看页面数、死链、孤立页、未编译素材
  pnpm dev reindex                    重建 index.json / index.md / 反向链接
  pnpm dev compile --all              编译 raw/ 下所有未编译素材（增量）
  pnpm dev compile raw/foo.md         编译指定素材
  pnpm dev compile --all --dry-run    只跑到计划，打印出来但不落盘
  pnpm dev compile --all --force      忽略 manifest 重编译
  pnpm dev query "问题"                基于 wiki 回答（选页 → 生成 → 引用校验）
  pnpm dev graph                      看链接图的形状：连通块、超级节点、孤立页
  pnpm dev graph --mermaid            额外输出 Mermaid（可贴进任何 Markdown 渲染）
  pnpm dev graph --mermaid --max-nodes 30   页面很多时只画连接最多的 30 个

选项：--all --force --dry-run --mermaid --max-nodes N --verbose  -h, --help

实现进度见 doc/DEVELOPMENT.md。
`;

function parseCli(): ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>> | null {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: CLI_OPTIONS,
    });
  } catch (error) {
    console.error(`参数解析失败：${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return null;
  }
}

/** 各家把真正的原因塞在响应体的 code 里，得挖出来，否则只剩一句泛泛的 429 */
const LLM_ERROR_HINTS: Record<string, string> = {
  '1302': '账户级限速（请求频率过高）。稍等再试；本项目的编译是串行的，正常不该触发。',
  '1305': '该模型当前过载。免费档常见，稍后重试，或把 MY_WIKI_LLM_MODEL 换成另一个免费型号。',
  '1301': 'API Key 无效或已失效，请到控制台重新生成。',
  '1210': '请求参数不合法（例如 messages 格式或温度取值）。',
  '1113': '账户余额或免费额度已用尽。',
};

function reportLlmFailure(error: unknown): void {
  const probe = error as { status?: number; message?: string; error?: unknown };
  const body = (probe.error ?? {}) as { code?: string | number; message?: string };
  const code = body.code === undefined ? '' : String(body.code);

  console.error('连通失败 ✗');
  console.error(`  HTTP ${probe.status ?? '?'}${code === '' ? '' : ` · code ${code}`}`);
  console.error(`  ${body.message ?? probe.message ?? '（无更多信息）'}`);
  if (code !== '' && LLM_ERROR_HINTS[code] !== undefined) console.error(`  处理：${LLM_ERROR_HINTS[code]}`);

  if (probe.status === undefined) {
    console.error('  没有拿到 HTTP 状态码，通常是网络不通、baseURL 写错，或**单次请求超时**。');
  }
  if (/timed out|timeout/i.test(probe.message ?? '')) {
    console.error('  单次请求超时。免费档高峰期很常见，两个办法：');
    console.error('    ① 调大超时：在 .env 里加 MY_WIKI_LLM_TIMEOUT_MS=300000');
    console.error('    ② 直接重跑：已完成的 Pass 会复用缓存，不会白跑（extract 是最贵的一趟）');
  }
  console.error('  （注意：连接失败时不会有 .state/passes/ 落盘——那里只记录成功返回的响应）');
  process.exitCode = 1;
}

/** SDK 的错误未必带 status（例如超时只有 name），别只看 status 就把它当普通异常 */
function looksLikeLlmError(error: unknown): boolean {
  const probe = error as { status?: number; name?: string };
  return probe.status !== undefined || (probe.name ?? '').startsWith('API');
}

function printStatus(report: StatusReport, reindexedPages: number | null): void {
  const { byType, deadLinks, orphans, uncompiledRaw, compiledRaw } = report;
  console.log(`Wiki 状态（${path.basename(ROOT)}）`);

  if (reindexedPages !== null) {
    console.log(`  索引缺失或过期，已自动 reindex（回写 ${reindexedPages} 个文件）`);
  }
  console.log(
    `  页面：${report.ids.length}（concept ${byType.concept} / entity ${byType.entity} / source ${byType.source}）`,
  );
  console.log(`  死链：${deadLinks.length}`);
  for (const link of deadLinks) console.log(`    - ${link.from} -> ${link.to}`);
  console.log(`  孤立页：${orphans.length}`);
  for (const id of orphans) console.log(`    - ${id}`);
  console.log(`  素材：已编译 ${compiledRaw} / 未编译 ${uncompiledRaw.length}`);
  for (const relPath of uncompiledRaw) console.log(`    - ${relPath}`);
}

async function main(): Promise<void> {
  loadDotEnv();

  const parsed = parseCli();
  if (parsed === null) return;

  // 显式 --help 是正常路径；什么都没给才算用法错误
  if (parsed.values.help) {
    console.log(USAGE);
    return;
  }

  const command = parsed.positionals[0];
  if (command === undefined) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'status': {
      await ensureDirs();
      const rebuilt = await ensureIndex();
      printStatus(await statusReport(), rebuilt === null ? null : rebuilt.writtenPages);
      return;
    }

    case 'reindex': {
      await ensureDirs();
      const result = await reindex();
      console.log(
        `已重建索引：${result.ids.length} 个页面（回写 ${result.writtenPages} 个文件）` +
          ` · 死链 ${result.deadLinks.length} · 孤立页 ${result.orphans.length}`,
      );
      return;
    }

    case 'check': {
      // 花一次最小调用把「key / 端点 / 模型名」三件事一次验清楚，
      // 免得跑完整编译才在第三次调用上撞到 401
      const config = llmConfig();
      const llm = createLlmClient({ config });
      const started = Date.now();
      try {
        const reply = await llm.text({
          tag: 'check',
          system: '你是一个连通性测试端点，回答必须极简。',
          user: '只回复两个字：可用',
        });
        console.log('连通 ✓');
        console.log(`  端点：${config.baseUrl}`);
        console.log(`  模型：${config.model}`);
        console.log(`  密钥：已设置（${config.apiKey.length} 字符，不回显）`);
        console.log(`  耗时：${Date.now() - started}ms`);
        console.log(`  回复：${reply.trim().replace(/\s+/g, ' ').slice(0, 80) || '（空）'}`);
      } catch (error) {
        reportLlmFailure(error);
      }
      return;
    }

    case 'compile': {
      await ensureDirs();
      const summary = await runCompile({
        targets: parsed.positionals.slice(1),
        all: parsed.values.all,
        force: parsed.values.force,
        dryRun: parsed.values['dry-run'],
        verbose: parsed.values.verbose,
      });
      console.log('');
      console.log(
        parsed.values['dry-run']
          ? `dry-run 完成：计划 ${summary.planned} 份（未落盘）· LLM 调用 ${summary.llmCalls} 次`
          : `完成：编译 ${summary.compiled} 份 · 跳过 ${summary.skipped} 份 · ` +
              `新建 ${summary.created.length} 页 · 更新 ${summary.updated.length} 页 · LLM 调用 ${summary.llmCalls} 次`,
      );
      return;
    }

    case 'query': {
      await ensureDirs();
      const question = parsed.positionals.slice(1).join(' ').trim();
      if (question === '') {
        console.error('用法：pnpm dev query "你的问题"');
        process.exitCode = 1;
        return;
      }
      const result = await runQuery({ question, verbose: parsed.values.verbose });
      console.log('');
      console.log(result.answer);
      console.log('');
      console.log(
        `引用校验：${result.badCitations.length === 0 ? '通过' : `失败 → ${result.badCitations.join(', ')}`}` +
          ` · 选中 ${result.selectedIds.length} 页 · LLM 调用 ${result.llmCalls} 次`,
      );
      // 引用了不存在的页面 = 答案不可信，必须以非 0 退出，别让脚本把它当成功
      if (result.badCitations.length > 0) process.exitCode = 1;
      return;
    }

    case 'graph': {
      // 参数校验放在碰 wiki 之前：非法值要立刻报错，而不是静默忽略，
      // 也避免「参数错了却先触发一次 reindex」这种莫名其妙的副作用
      const maxNodes = Number(parsed.values['max-nodes']);
      if (!Number.isInteger(maxNodes) || maxNodes < 0) {
        console.error(`--max-nodes 必须是非负整数，当前值：${JSON.stringify(parsed.values['max-nodes'])}`);
        process.exitCode = 1;
        return;
      }

      await ensureIndex();
      const index = await readIndex();
      const entries = index?.pages ?? [];
      console.log(formatGraphReport(analyzeGraph(entries)));
      if (parsed.values.mermaid) {
        console.log('');
        console.log(renderMermaid(entries, maxNodes));
      }
      return;
    }

    default:
      console.error(`未知命令：${command}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // 编译中途撞到 API 错误（限流、过载、超时、鉴权）时，也走同一套带 code 的报告，
  // 否则只剩一句「429 ...」或「Request timed out.」看不出该重试还是该换型号
  if (looksLikeLlmError(error)) {
    reportLlmFailure(error);
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
