/**
 * 命令入口。只做三件事：解析参数、分发、统一异常处理。
 * 业务逻辑一律在 reindex / store / compile / query 里。
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalTitleKey, renderLinkCandidates, runCompile } from './compile.js';
import { loadDotEnv, llmConfig } from './env.js';
import { createLlmClient } from './llm.js';
import { analyzeGraph, formatGraphReport, renderMermaid } from './graph.js';
import { repairDeadLinks } from './links.js';
import {
  applySplit,
  buildSplitSystem,
  buildSplitUser,
  countChars,
  isOverLimit,
  splitProposalSchema,
  type SplitProposal,
} from './split.js';
import {
  applyConflicts,
  buildConflictSystem,
  buildConflictUser,
  conflictProposalSchema,
  formatConflictReport,
  hasDisputes,
  parseDisputes,
  type ConflictProposal,
} from './conflict.js';
import { runQuery } from './query.js';
import { ensureIndex, reindex, scan, statusReport, type StatusReport } from './reindex.js';
import type { IndexEntry } from './types.js';
import { ensureDirs, nextFreeId, readIndex, readPage, readRaw, ROOT, slugify, withBody, writePage } from './store.js';

const CLI_OPTIONS = {
  all: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  mermaid: { type: 'boolean', default: false },
  'max-nodes': { type: 'string', default: '0' },
  limit: { type: 'string', default: '400' },
  detect: { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
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
  pnpm dev repair                     把死链按别名/标题就近改写为正确 id（--dry-run 预览）
  pnpm dev split                      把超过字数上限的页面拆成「枢纽页 + 子主题页」（--dry-run 预览，--limit N 调阈值）
  pnpm dev conflict                   报告所有已记录的「争议」小节（离线）
  pnpm dev conflict --detect          用 LLM 比对多素材页面，找出隐藏的矛盾
  pnpm dev conflict --detect --apply  找出矛盾并写入「争议」小节（再 reindex）

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

    case 'repair': {
      await ensureDirs();
      const dryRun = parsed.values['dry-run'];
      // 先保证索引/反向链接是最新的，再扫描页面正文
      await ensureIndex();
      const snapshot = await scan();

      const idSet = new Set(snapshot.ids);
      // 标题/别名 → id（与 compile 的 buildTitleIndex 同样用 canonicalTitleKey 归一化）
      const titleIndex = new Map<string, string>();
      for (const id of snapshot.ids) {
        const page = snapshot.pages.get(id);
        if (page === undefined) continue;
        for (const name of [page.meta.title, ...page.meta.aliases]) {
          const key = canonicalTitleKey(name);
          if (key !== '' && !titleIndex.has(key)) titleIndex.set(key, id);
        }
      }
      // 就近匹配：先比 id 末段，再比标题/别名
      const resolve = (id: string): string | null => {
        const bare = id.replace(/^[a-z]+\//i, '');
        const key = canonicalTitleKey(bare);
        if (key === '') return null;
        for (const known of snapshot.ids) {
          if (canonicalTitleKey(known.split('/').pop() ?? '') === key) return known;
        }
        return titleIndex.get(key) ?? null;
      };

      let totalRepairs = 0;
      const allUnrepaired = new Set<string>();
      let written = 0;
      for (const id of snapshot.ids) {
        const page = snapshot.pages.get(id);
        if (page === undefined) continue;
        const { body, repairs, unrepaired } = repairDeadLinks(page.body, (x) => idSet.has(x), resolve);
        if (repairs.length === 0) continue;
        totalRepairs += repairs.length;
        for (const r of repairs) console.log(`  ${id}：${r.from} → ${r.to}`);
        for (const u of unrepaired) allUnrepaired.add(u);
        if (!dryRun && (await writePage(withBody(page, body)))) written += 1;
      }

      if (totalRepairs === 0) {
        console.log(dryRun ? '未发现可修复的死链（dry-run）。' : '未发现可修复的死链。');
      } else if (dryRun) {
        console.log(`\n[dry-run] 将修复 ${totalRepairs} 条死链，未改动任何文件。`);
      } else {
        await reindex();
        const tail =
          allUnrepaired.size > 0
            ? `；${allUnrepaired.size} 条无法修复（${[...allUnrepaired].join('、')}），需人工处理。`
            : '。';
        console.log(`\n已修复 ${totalRepairs} 条死链（回写 ${written} 个页面）${tail}`);
      }
      return;
    }

    case 'split': {
      // 参数校验放在碰 wiki 之前
      const limit = Number(parsed.values.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        console.error(`--limit 必须是正整数，当前值：${JSON.stringify(parsed.values.limit)}`);
        process.exitCode = 1;
        return;
      }

      await ensureDirs();
      const dryRun = parsed.values['dry-run'];
      await ensureIndex();
      const snapshot = await scan();

      const idSet = new Set(snapshot.ids);
      const titleIndex = new Map<string, string>();
      for (const id of snapshot.ids) {
        const page = snapshot.pages.get(id);
        if (page === undefined) continue;
        for (const name of [page.meta.title, ...page.meta.aliases]) {
          const key = canonicalTitleKey(name);
          if (key !== '' && !titleIndex.has(key)) titleIndex.set(key, id);
        }
      }
      const resolve = (id: string): string | null => {
        const bare = id.replace(/^[a-z]+\//i, '');
        const key = canonicalTitleKey(bare);
        if (key === '') return null;
        for (const known of snapshot.ids) {
          if (canonicalTitleKey(known.split('/').pop() ?? '') === key) return known;
        }
        return titleIndex.get(key) ?? null;
      };

      // 候选页清单：供 LLM 知道能链哪些 id（用 index 卡片渲染，与 compile 一致）
      const cards: IndexEntry[] = snapshot.ids.map((id) => {
        const p = snapshot.pages.get(id);
        return {
          id,
          type: p?.meta.type ?? 'concept',
          title: p?.meta.title ?? id,
          oneLiner: p?.meta.oneLiner ?? '',
          aliases: p?.meta.aliases ?? [],
          tags: p?.meta.tags ?? [],
          outLinks: [],
          inLinks: [],
          updated: p?.meta.updated ?? '',
        };
      });
      const config = llmConfig();
      const llm = createLlmClient({ config });

      const targets = snapshot.ids.filter((id) => {
        const page = snapshot.pages.get(id);
        if (page === undefined || page.meta.type === 'source') return false;
        return isOverLimit(page.body, limit);
      });

      if (targets.length === 0) {
        console.log(dryRun ? `未发现超过 ${limit} 字的页面（dry-run）。` : `未发现超过 ${limit} 字的页面。`);
        return;
      }

      let splitCount = 0;
      const allWarnings: string[] = [];
      let written = 0;
      const newIds: string[] = [];

      for (const id of targets) {
        const page = snapshot.pages.get(id);
        if (page === undefined) continue;
        const chars = countChars(page.body);
        if (dryRun) {
          console.log(`  [dry-run] ${id}（${chars} 字）将拆分为子主题页`);
          splitCount += 1;
          continue;
        }

        const linkCandidates = renderLinkCandidates(cards, newIds, id);
        let proposal: SplitProposal;
        try {
          proposal = (await llm.structured({
            tag: `split-${slugify(id.replace(/\//g, '-'))}`,
            system: await buildSplitSystem(),
            user: await buildSplitUser(page, limit, linkCandidates),
            schema: splitProposalSchema,
          })) as SplitProposal;
        } catch (error) {
          console.error(
            `  ${id}：LLM 拆分失败，跳过（${error instanceof Error ? error.message : String(error)}）`,
          );
          continue;
        }

        // 先分配不冲突的子页 id，再交给纯函数 applySplit 落实
        const subIds: string[] = [];
        for (const sub of proposal.subpages) {
          subIds.push(await nextFreeId(page.meta.type, slugify(sub.slug)));
        }
        const result = applySplit(page, proposal, { knownIds: idSet, subIds, resolve });

        if (await writePage(result.hub)) written += 1;
        for (const sub of result.subpages) if (await writePage(sub)) written += 1;
        for (const subId of subIds) {
          idSet.add(subId);
          newIds.push(subId);
        }
        splitCount += 1;
        console.log(
          `  ${id}（${chars} 字）→ 枢纽页 + ${result.subpages.length} 个子页：${subIds.join('、')}`,
        );
        for (const w of result.warnings) allWarnings.push(`${id}：${w}`);
      }

      if (dryRun) {
        console.log(`\n[dry-run] 将拆分 ${splitCount} 个页面，未改动任何文件。`);
        return;
      }

      await reindex();
      const tail =
        allWarnings.length > 0 ? `\n  警告：\n${allWarnings.map((w) => `    - ${w}`).join('\n')}` : '';
      console.log(`\n已拆分 ${splitCount} 个页面（回写 ${written} 个文件）${tail}`);
      return;
    }

    case 'conflict': {
      await ensureDirs();
      const snapshot = await scan();
      const detect = parsed.values.detect;
      const apply = parsed.values.apply;

      if (!detect) {
        // 报告模式（离线）：列出所有已记录「争议」小节的页面
        const items = snapshot.ids
          .map((id) => {
            const page = snapshot.pages.get(id);
            const disputes = page === undefined ? null : parseDisputes(page.body);
            return disputes === null ? null : { id, disputes };
          })
          .filter((x): x is { id: string; disputes: string } => x !== null);
        console.log(formatConflictReport(items));
        return;
      }

      // 检测模式：只对「≥2 个素材、且尚无争议小节」的 concept/entity 页跑 LLM
      const candidates = snapshot.ids.filter((id) => {
        const page = snapshot.pages.get(id);
        if (page === undefined || page.meta.type === 'source') return false;
        return page.meta.sources.length >= 2 && !hasDisputes(page.body);
      });

      if (candidates.length === 0) {
        console.log('没有需要检测的多素材页面（或它们都已记录过争议）。');
        return;
      }

      const config = llmConfig();
      const llm = createLlmClient({ config });
      let found = 0;
      let written = 0;

      for (const id of candidates) {
        const page = snapshot.pages.get(id);
        if (page === undefined) continue;

        // 收集该页引用的素材原文（缺失则跳过该素材并提示）
        const sourceTexts: { id: string; text: string }[] = [];
        for (const src of page.meta.sources) {
          try {
            sourceTexts.push({ id: src, text: await readRaw(src) });
          } catch {
            console.error(`  ${id}：素材 ${src} 读取失败，跳过该素材`);
          }
        }
        if (sourceTexts.length < 2) {
          console.log(`  ${id}：可用素材不足 2 份，跳过`);
          continue;
        }

        let proposal: ConflictProposal;
        try {
          proposal = (await llm.structured({
            tag: `conflict-${slugify(id.replace(/\//g, '-'))}`,
            system: await buildConflictSystem(),
            user: await buildConflictUser(page, sourceTexts),
            schema: conflictProposalSchema,
          })) as ConflictProposal;
        } catch (error) {
          console.error(
            `  ${id}：LLM 冲突检测失败，跳过（${error instanceof Error ? error.message : String(error)}）`,
          );
          continue;
        }

        if (proposal.conflicts.length === 0) {
          console.log(`  ${id}：未检测到矛盾`);
          continue;
        }
        found += 1;
        console.log(
          `  ${id}：检测到 ${proposal.conflicts.length} 条矛盾（${proposal.conflicts
            .map((c) => c.topic)
            .join('、')}）`,
        );
        if (apply) {
          if (await writePage(applyConflicts(page, proposal))) written += 1;
        }
      }

      if (!apply) {
        console.log(
          `\n[dry-run] 检测到 ${found} 个页面存在隐藏矛盾；加 --apply 才会写入「争议」小节。`,
        );
      } else {
        await reindex();
        console.log(`\n已检测 ${candidates.length} 个页面，发现 ${found} 个有矛盾，回写 ${written} 个文件。`);
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
