/**
 * 离线冒烟：用注入的假 LLM 把整条编译流水线跑一遍。
 *
 * 目的：在没有 API Key、不花钱的情况下验证「管路」是否正确——
 *   plan → 工作项 → 内存装配 → 链接校验 → 原子落盘 → reindex → manifest
 * 它**不**验证提示词质量（那必须用真实模型跑）。
 *
 * 用法：
 *   pnpm smoke            跑一遍并自动清理产物
 *   pnpm smoke --keep     保留产物，便于人工检查 wiki/
 *
 * 安全：运行前会把真实 wiki/ 与 .state/ 整体备份到临时目录，万一内存快照还原
 * （snapshotWiki/restoreWiki）将来再出 bug，也能从磁盘备份兜底还原，绝不会把
 * 用户用真实模型编译出来的产物弄丢。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headingsOf, runCompile, type CompileSummary } from '../src/compile.js';
import { parseOwnLinks, stripAutoBacklinks } from '../src/links.js';
import { NO_COVERAGE_ANSWER, runQuery } from '../src/query.js';
import { extractJson, type ChatFn, type ChatMessage, type LlmClient } from '../src/llm.js';
import type { Page } from '../src/types.js';
import { reindex } from '../src/reindex.js';
import {
  listPageIds,
  MANIFEST_FILE,
  pagePath,
  PASSES_DIR,
  passCachePath,
  readManifest,
  readPage,
  readRaw,
  STATE_DIR,
  WIKI_DIR,
  writeManifest,
  writePage,
  writePassCache,
  writeRawFile,
} from '../src/store.js';

const RAW = 'raw/llm-wiki-intro.md';
/** 第二份素材：与第一份有交集（RAG、知识积累），所以才有理由产生 update —— 复利效应的燃料 */
const RAW2 = 'raw/vector-search-notes.md';
const SECOND_MARK = '向量检索';

const EXTRACT = {
  title: 'LLM Wiki 概念介绍',
  oneLiner: '从临时检索到提前编译的知识管理范式',
  summary:
    '介绍一种把原始资料提前编译成结构化 Markdown 页面的知识管理方式：知识只整理一次，之后持续复用。',
  claims: [
    'LLM Wiki 用摄入时编译替代传统 RAG 的查询时检索',
    '新增资料后模型会通读整个 Wiki 并更新所有相关页面，形成复利效应',
  ],
  concepts: [
    {
      name: '检索增强生成（RAG）',
      definition: '每次提问都现场去原始文档库翻找、拼凑片段，再让大模型推理出答案',
      evidence: '同一个问题问 100 次，它就要重复这个过程 100 次，没有任何知识积累',
    },
    {
      name: '编译式知识管理',
      definition: '一次性通读资料并编译成结构化、互相链接的 Wiki 页面，之后直接查阅页面',
      evidence: '知识只整理一次，但可以持续复用和更新',
    },
    {
      name: '这条摘录原文里根本没有',
      definition: '用来验证程序会把无法逐字命中的摘录丢掉',
      evidence: '这句话是编造的，原文里绝对不存在',
    },
  ],
  entities: [
    {
      name: 'Andrej Karpathy',
      kind: '人物',
      evidence: '由 AI 领域知名研究者 Andrej Karpathy 在 2026 年 4 月提出',
    },
  ],
  relationHints: [
    { from: '检索增强生成（RAG）', to: '编译式知识管理', relation: '前者查询时做功，后者摄入时做功' },
  ],
};

const PLAN = {
  ops: [
    {
      op: 'create',
      type: 'concept',
      title: '检索增强生成（RAG）',
      oneLiner: '查询时做功的解释器模式',
      slug: 'retrieval-augmented-generation',
      reason: '清单中没有等价页面',
    },
    {
      op: 'create',
      type: 'concept',
      title: '编译式知识管理',
      oneLiner: '摄入时做功的编译器模式',
      slug: 'compile-time-knowledge',
      reason: '清单中没有等价页面',
    },
    {
      op: 'create',
      type: 'entity',
      title: 'Andrej Karpathy',
      oneLiner: 'LLM Wiki 概念的提出者',
      slug: 'andrej-karpathy',
      reason: '人物需要独立的实体页',
    },
    {
      op: 'link',
      fromId: 'concepts/retrieval-augmented-generation',
      toId: 'concepts/根本不存在',
      reason: '故意指向不存在的页面，用来观察它被跳过',
    },
    {
      op: 'link',
      fromId: 'concepts/retrieval-augmented-generation',
      toId: 'concepts/compile-time-knowledge',
      reason: '与 create 收敛出的 update 命中同一页，用来观察两者被合并成一次编辑',
    },
  ],
};

/** 第二份素材的抽取结果：概念与第一份有交集，但页面是新的 */
const EXTRACT2 = {
  title: '向量检索笔记',
  oneLiner: '以语义距离替代字面匹配的检索方式',
  summary: '记录向量检索的基本机制、它与 RAG 的关系，以及它不积累知识的局限。',
  claims: [
    '向量检索用语义距离代替字面匹配',
    '向量检索没有知识积累，问题问一百次就要跑一百次近邻搜索',
  ],
  concepts: [
    {
      name: '向量检索',
      definition: '把文本映射成向量，用语义距离做近邻搜索',
      evidence: '向量检索把文本映射成向量，用语义距离代替字面匹配',
    },
    {
      name: '嵌入',
      definition: '把一段文本映射成固定长度向量的过程',
      evidence: '嵌入（embedding）是把一段文本映射成一个固定长度向量的过程',
    },
  ],
  entities: [],
  relationHints: [{ from: '向量检索', to: 'RAG', relation: '常被用作 RAG 的检索阶段实现' }],
};

/**
 * 第二份素材的计划：**关键在于它更新了一个已存在的页面**。
 * 这正是复利效应的可观察形态——不是简单堆新页，而是旧页被改写并长出新的链接。
 */
const PLAN2 = {
  ops: [
    {
      op: 'update',
      targetId: 'concepts/retrieval-augmented-generation',
      patch: '在「与其他概念的关系」下补充：向量检索是 RAG 检索阶段最常见的实现方式。',
      reason: '新素材补充了检索阶段的具体实现，且该页已存在，应更新而非新建',
    },
    {
      op: 'create',
      type: 'concept',
      title: '向量检索',
      oneLiner: '用语义距离代替字面匹配',
      slug: 'vector-search',
      reason: '清单中没有等价页面',
    },
    {
      op: 'create',
      type: 'concept',
      title: '嵌入',
      oneLiner: '把文本映射成固定长度向量',
      slug: 'embedding',
      reason: '清单中没有等价页面',
    },
    {
      op: 'link',
      fromId: 'concepts/compile-time-knowledge',
      toId: 'concepts/vector-search',
      reason: '两者的取舍关系需要连起来',
    },
  ],
};

function candidateIds(user: string): string[] {
  const section = user.split('【可链接的页面 id（只能链接这些）】')[1] ?? '';
  return [...section.matchAll(/^- (\S+) — /gm)].map((match) => match[1] ?? '');
}

function pageIdOf(user: string): string {
  return /页面 id：(\S+)/.exec(user)?.[1] ?? '';
}

interface FakeOptions {
  /** 在第 N 次 apply 草稿生成时抛错，用来验证「中途失败不留下半成品」 */
  failApplyAtCall?: number;
}

/** 假模型：按 system 里的阶段标记决定返回什么，并故意制造一次「链接不可达」 */
function makeFakeChat(report: string[], options: FakeOptions = {}): ChatFn {
  let injectedBadLink = false;
  let applyDraftCalls = 0;
  /**
   * 当前草稿被标记为「必须失败」。
   *
   * 不能只在 structured 里抛一次就完事——compile 的 apply 对每个页面都有
   * 「结构化失败 → 纯文本兜底」的降级（见 src/compile.ts），只抛一次会被兜底
   * 悄悄消化成一次成功，检查就会以「Missing expected rejection」失败。
   * 所以兜底请求必须跟着一起失败，故障才真的能传到 runCompile 外面。
   */
  let failingDraft = false;

  const countApplyDraft = (): void => {
    applyDraftCalls += 1;
    failingDraft = options.failApplyAtCall === applyDraftCalls;
    if (failingDraft) {
      throw new Error(`模拟的 apply 故障：第 ${applyDraftCalls} 个页面草稿生成失败`);
    }
  };

  return async (messages: readonly ChatMessage[]) => {
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const user = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');

    const isSecond = user.includes(SECOND_MARK);

    // 纯文本兜底请求（它的 system 里同样带「新页面写正文」那句，所以必须排在前面判断）
    if (system.includes('只输出正文的 Markdown 本身')) {
      if (failingDraft) {
        throw new Error(`模拟的 apply 故障：第 ${applyDraftCalls} 个页面草稿生成失败（兜底同样失败）`);
      }
      return '兜底正文占位——正常场景不该走到纯文本兜底。';
    }

    if (system.includes('抽取器')) {
      report.push(`extract   → 返回${isSecond ? '第二份素材' : '第一份素材'}的抽取结果（含 1 条编造摘录）`);
      return JSON.stringify(isSecond ? EXTRACT2 : EXTRACT);
    }

    if (system.includes('规划阶段')) {
      // 这里**不能**用 isSecond 判断：plan 的【要求】里本来就用「向量检索」举了例子，
      // 用正文特征判断会永远为真，结果第一份素材也拿到 PLAN2，RAG 页根本建不出来。
      // plan 的提示词里写明了素材路径，用它区分才可靠。
      if (user.includes(RAW2)) {
        const cards = user.split('【wiki 现有页面清单】')[1] ?? '';
        report.push(
          `plan      → 第二份素材：清单${cards.includes('（空）') ? '为空' : '里已有页面'}；返回 1 update + 2 create + 1 link`,
        );
        return JSON.stringify(PLAN2);
      }
      const empty = (user.split('【当前状态】')[1] ?? '').includes('共 0 个页面');
      report.push(`plan      → wiki ${empty ? '为空，只能 create' : '已有页面'}；返回 3 create + 1 link(不可达)`);
      return JSON.stringify(PLAN);
    }

    if (system.includes('你在为一个 wiki **新页面**写正文。')) {
      countApplyDraft();
      const id = pageIdOf(user);

      if (!injectedBadLink) {
        injectedBadLink = true;
        report.push(`apply     → ${id}：第一次故意返回不可达链接`);
        return JSON.stringify({ body: '## 定义\n\n见 [[concepts/这个页面不存在]]。', tags: [], aliases: [] });
      }
      if (user.includes('【上一次尝试的问题，必须修正】')) {
        report.push(`apply     → ${id}：收到「链接不可达」提示后重试成功`);
      }

      const others = candidateIds(user).filter((candidate) => candidate !== id).slice(0, 2);
      // 实体页模板（schema/templates/entity.md）的小节与概念页不同，
      // 套概念页结构会被「新增了兜底小节」的更新完整性校验拦下
      const isEntity = system.includes('页面模板（entity）');
      const body = isEntity
        ? [
            '## 是什么',
            '',
            `「${id}」的身份与定位，由离线冒烟脚本生成。`,
            '',
            '## 为什么重要',
            '',
            ...others.map((other) => `- 与 [[${other}]] 相关。`),
            '',
            '## 出处',
            '',
            '- [[sources/llm-wiki-intro]]：「同一个问题问 100 次，它就要重复这个过程 100 次」',
          ].join('\n')
        : [
            '## 定义',
            '',
            `「${id}」的定义占位，由离线冒烟脚本生成。`,
            '',
            '## 与其他概念的关系',
            '',
            ...others.map((other) => `- 与 [[${other}]] 相关。`),
            '',
            '## 出处',
            '',
            '- [[sources/llm-wiki-intro]]：「同一个问题问 100 次，它就要重复这个过程 100 次」',
          ].join('\n');
      return JSON.stringify({
        body,
        tags: ['冒烟'],
        aliases: [],
      });
    }

    if (system.includes('你在**更新**一个已有的 wiki 页面。')) {
      countApplyDraft();
      const id = pageIdOf(user);
      // 真实模型拿到的是「完整正文」，这里照做：在原文基础上追加，而不是整体重写
      const current = ((user.split('【页面现状（完整正文）】')[1] ?? '').split('【需要补充的内容】')[0] ?? '').trim();
      const patch = ((user.split('【需要补充的内容】')[1] ?? '').split('【要求】')[0] ?? '').trim();

      // 第二份素材的场景：update 必须给已有页面接上指向新页面的链接——
      // 这就是复利效应在文件里留下的痕迹，也是本项目最想看到的那一行 diff。
      // 注意要插进已有小节，不能新开同名标题（否则会触发更新完整性校验）
      const linkTarget = isSecond
        ? candidateIds(user).find(
            (candidate) => candidate !== id && !current.includes(`[[${candidate}]]`),
          )
        : undefined;
      // 插入点必须落在**该模板本来就有**的小节下，否则等于新开兜底小节
      const heading = system.includes('页面模板（entity）')
        ? '## 为什么重要'
        : '## 与其他概念的关系';
      const body =
        linkTarget === undefined
          ? current
          : current.includes(heading)
            ? `${current.replace(`${heading}\n`, `${heading}\n\n- 与 [[${linkTarget}]] 相关。\n`)}`
            : `${current}\n\n${heading}\n\n- 与 [[${linkTarget}]] 相关。`;

      report.push(`apply     → update ${id}${linkTarget === undefined ? '' : `（新增指向 [[${linkTarget}]] 的链接）`}`);
      return JSON.stringify({
        body: `${body}\n\n（离线冒烟补充：${patch.split('\n')[0] ?? ''}）`,
        tags: [],
        aliases: [],
      });
    }

    report.push(`！！未知阶段：${system.slice(0, 60)}`);
    return '{}';
  };
}

function totalCalls(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const value of counts.values()) sum += value;
  return sum;
}

/** 用真实客户端之外的最小实现：JSON 提取与 zod 校验走真实代码，只有网络调用被替换 */
function fakeClient(report: string[], chat: ChatFn, counts: Map<string, number>): LlmClient {
  return {
    callCount: () => totalCalls(counts),
    // 不能固定返回空串：兜底路径要真的经过假模型，故障才能从里面传出来。
    // 计数也要照 structured 那样记——answer 走的是 text，漏记会让「恰好 2 次调用」的断言落空
    text: async (prompt) => {
      const stage = prompt.tag.split('-')[0] ?? prompt.tag;
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      return chat([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]);
    },
    structured: async (prompt) => {
      const stage = prompt.tag.split('-')[0] ?? prompt.tag;
      counts.set(stage, (counts.get(stage) ?? 0) + 1);

      const raw = await chat([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]);
      const checked = prompt.schema.safeParse(extractJson(raw));
      if (!checked.success) {
        const issues = checked.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new Error(`[${prompt.tag}] 假模型输出未通过校验：${issues}`);
      }
      return checked.data;
    },
  };
}

/**
 * S10 验收：增量跳过 + Pass 级断点续跑。
 * 这两件事只有「多次调用之间」才能观察到，所以单独拉出来验。
 */
async function checkIncrementalAndResume(): Promise<void> {
  console.log('\n===== S10 检查：增量与 Pass 级续跑 =====');
  const report: string[] = [];

  // ① 内容未变 → 必须整体跳过，一次模型都不调
  const counts = new Map<string, number>();
  const second = await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(`  ① 内容未变：编译 ${second.compiled} 份 · 跳过 ${second.skipped} 份 · LLM 调用 ${totalCalls(counts)} 次`);
  assert.equal(second.skipped, 1, '第二次编译应跳过');
  assert.equal(totalCalls(counts), 0, '跳过时不得调用模型');

  // ② 人为把 plan 标成失败 → extract 必须复用缓存，plan/apply 重跑
  const manifest = await readManifest();
  const entry = manifest[RAW];
  assert.ok(entry !== undefined, 'manifest 里应当有该素材的记录');
  entry.passes.plan = 'failed: 人为破坏，用于验证断点续跑';
  manifest[RAW] = entry;
  await writeManifest(manifest);

  counts.clear();
  const resumed = await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  const extractCalls = counts.get('extract') ?? 0;
  const planCalls = counts.get('plan') ?? 0;
  const applyCalls = counts.get('apply') ?? 0;
  console.log(`  ② plan 标为失败后重跑：extract ${extractCalls} 次 · plan ${planCalls} 次 · apply ${applyCalls} 次`);
  assert.equal(extractCalls, 0, 'extract 已 ok 且有缓存，不应重新调用（它是最贵的一趟）');
  assert.ok(planCalls > 0, 'plan 被标失败，必须重跑');
  assert.ok(applyCalls > 0, '计划重跑了，apply 也必须重跑');
  assert.equal(resumed.compiled, 1);

  // ③ 续跑成功后应重新回到「跳过且零调用」
  counts.clear();
  const third = await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(`  ③ 续跑完成后：跳过 ${third.skipped} 份 · LLM 调用 ${totalCalls(counts)} 次`);
  assert.equal(third.skipped, 1);
  assert.equal(totalCalls(counts), 0);

  // ④ 缓存损坏时必须退回重新调用，而不是把坏数据当结果或直接崩掉
  const manifest2 = await readManifest();
  const entry2 = manifest2[RAW];
  assert.ok(entry2 !== undefined);
  entry2.passes.plan = 'failed: 再次人为破坏';
  manifest2[RAW] = entry2;
  await writeManifest(manifest2);
  await writePassCache(passCachePath('extract', RAW), { 这不是: '一份合法的 Extract' });

  counts.clear();
  await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(`  ④ 缓存损坏后重跑：extract ${counts.get('extract') ?? 0} 次（应 >0，即重新抽取）`);
  assert.ok((counts.get('extract') ?? 0) > 0, '缓存结构不符时应重新调用而不是采信坏数据');
}

/** 真正的失败路径：apply 中途抛错，必须「什么都没写」且能从断点续上 */
async function checkApplyFailureLeavesNoResidue(): Promise<void> {
  console.log('\n===== S10 检查：apply 中途失败不留下半成品 =====');

  // 需要干净现场，测完恢复
  const snapshot = await snapshotWiki();
  await wipeWiki();

  const report: string[] = [];
  try {
    const counts = new Map<string, number>();
    await assert.rejects(
      () =>
        runCompile({
          targets: [RAW],
          all: false,
          force: true,
          dryRun: false,
          verbose: false,
          llm: fakeClient(report, makeFakeChat(report, { failApplyAtCall: 3 }), counts),
        }),
      /模拟的 apply 故障/,
    );

    assert.deepEqual(await listPageIds(), [], '前两个页面已装配在内存里，第三个失败就都不许落盘');
    const passes = (await readManifest())[RAW]?.passes;
    assert.ok(passes !== undefined, '失败也要留下 manifest 记录');
    assert.equal(passes.extract, 'ok');
    assert.equal(passes.plan, 'ok');
    assert.match(passes.apply, /^failed: 模拟的 apply 故障/, 'apply 必须记下失败原因');
    console.log(`  ① 失败后：wiki 页面 ${(await listPageIds()).length} 个（应为 0）· passes.apply = "${passes.apply.slice(0, 40)}…"`);

    // 续跑：extract/plan 都不该重做
    counts.clear();
    const resumed = await runCompile({
      targets: [RAW],
      all: false,
      force: false,
      dryRun: false,
      verbose: false,
      llm: fakeClient(report, makeFakeChat(report), counts),
    });
    console.log(
      `  ② 续跑：extract ${counts.get('extract') ?? 0} 次 · plan ${counts.get('plan') ?? 0} 次 · apply ${counts.get('apply') ?? 0} 次`,
    );
    assert.equal(counts.get('extract') ?? 0, 0, 'extract 有缓存，不该重做');
    assert.equal(counts.get('plan') ?? 0, 0, 'plan 已 ok，不该重做');
    assert.ok((counts.get('apply') ?? 0) > 0, 'apply 必须重做');
    assert.equal(resumed.compiled, 1);
    assert.ok((await listPageIds()).length > 0, '续跑后页面应被创建出来');
    console.log(`  ③ 续跑完成：页面 ${(await listPageIds()).length} 个 · 状态回到全 ok`);
  } finally {
    await restoreWiki(snapshot);
  }
}

/**
 * S11 的离线版：第二份素材必须让**已有页面被改写**并长出指向新页面的链接。
 * 注意——这验证的是「update 管路」，不是「模型会不会想到要 update」。
 * 后者只能在真实模型上观察。
 */
async function checkCompoundingUpdate(): Promise<void> {
  console.log('\n===== S11 检查：复利效应（第二份素材触发 update）=====');

  const snapshot = await snapshotWiki();
  await wipeWiki();

  const report: string[] = [];
  try {
    // 第一份素材：先建立初始知识网络
    await runCompile({
      targets: [RAW],
      all: false,
      force: true,
      dryRun: false,
      verbose: false,
      llm: fakeClient(report, makeFakeChat(report), new Map()),
    });
    const afterFirst = new Set(await listPageIds());
    const ragBefore = await readPage('concepts/retrieval-augmented-generation');
    console.log(`  ① 第一份素材编译完成：${afterFirst.size} 个页面 · 已有页面小节：${headingsOf(ragBefore.body).join(' / ')}`);

    // 第二份素材：应当 update 已有页面，而不是只堆新页
    const counts = new Map<string, number>();
    const traceFrom = report.length;
    const second = await runCompile({
      targets: [RAW2],
      all: false,
      force: false,
      dryRun: false,
      verbose: false,
      llm: fakeClient(report, makeFakeChat(report), counts),
    });
    const updatedExisting = second.updated.filter((id) => afterFirst.has(id));
    console.log(
      `  ② 第二份素材：新建 ${second.created.length} 页 · 更新 ${second.updated.length} 页（其中已有页面 ${updatedExisting.length} 个：${updatedExisting.join(', ')}）`,
    );
    assert.ok(updatedExisting.length > 0, '第二份素材必须更新已有页面，否则复利效应不存在');
    console.log('    假模型轨迹：');
    for (const line of report.slice(traceFrom)) console.log(`      ${line}`);

    // 必须用 parseOwnLinks 判出链：readPage 返回的正文里还带着**反向链接区块**，
    // 直接 includes('[[...]]') 会被「别人指向我」满足，从而验不出「我指向别人」
    const ragOutBefore = parseOwnLinks(ragBefore.body);
    const ragAfter = await readPage('concepts/retrieval-augmented-generation');
    const ragOutAfter = parseOwnLinks(ragAfter.body);
    assert.ok(!ragOutBefore.includes('concepts/vector-search'), '前置条件：更新前不该有这条出链');
    assert.ok(ragOutAfter.includes('concepts/vector-search'), '被更新的页面必须长出指向新页面的链接');
    assert.deepEqual(headingsOf(ragAfter.body), headingsOf(ragBefore.body), '更新不得改动小节结构');
    console.log(`  ③ 已有页面的出链：${ragOutBefore.join(', ')} → ${ragOutAfter.join(', ')}`);
    console.log(`     小节结构未变：${headingsOf(ragAfter.body).join(' / ')}`);

    // 反向链接必须对称：新页面的入链里要出现刚更新过它的页面
    const rebuilt = await reindex();
    const vector = rebuilt.indexEntries.find((entry) => entry.id === 'concepts/vector-search');
    assert.ok(vector !== undefined, '新页面 concepts/vector-search 应存在');
    assert.ok(
      vector.inLinks.includes('concepts/retrieval-augmented-generation'),
      '新页面的反向链接应含刚更新它的页面',
    );
    assert.equal(rebuilt.deadLinks.length, 0, '不得产生死链');
    console.log(`  ④ 反向链接对称：concepts/vector-search 的入链 = ${vector.inLinks.join(', ')}`);
    console.log(`  ⑤ 死链 ${rebuilt.deadLinks.length} · 页面总数 ${rebuilt.ids.length}`);
  } finally {
    await restoreWiki(snapshot);
  }
}

/**
 * S9 兜底路径的验收：结构化输出彻底失败时，改要纯 Markdown 正文。
 *
 * 这条路径上一版**完全没有测试覆盖**——假模型永远返回合法 JSON，永远走不到兜底。
 * 而它恰恰是真实运行里最需要的那条（实测模型会在 body 与 tags 边界上打出 `'tags":`，
 * 三次重试一字不差地复现，只能靠兜底救）。
 */
async function checkBodyOnlyFallback(): Promise<void> {
  console.log('\n===== S9 检查：结构化输出失败时的纯文本兜底 =====');

  const snapshot = await snapshotWiki();
  await wipeWiki();

  const report: string[] = [];
  const bodyOnlyTags: string[] = [];
  let calls = 0;

  const fallbackBody = [
    '## 定义',
    '',
    '这是纯文本兜底产出的正文。',
    '',
    '## 出处',
    '',
    '- [[sources/llm-wiki-intro]]：「同一个问题问 100 次，它就要重复这个过程 100 次」',
  ].join('\n');

  // 只让 apply 的草稿失败（extract/plan 走正常假模型），模拟「模型稳定地打错 JSON」
  const llm: LlmClient = {
    callCount: () => calls,
    structured: async (prompt) => {
      calls += 1;
      if (prompt.tag.startsWith('apply-')) {
        throw new Error(`[${prompt.tag}] 3 次尝试后仍无法得到合法输出：输出不是合法 JSON`);
      }
      const raw = await makeFakeChat(report)([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]);
      const checked = prompt.schema.safeParse(extractJson(raw));
      if (!checked.success) throw new Error(`[${prompt.tag}] 假模型输出未通过校验`);
      return checked.data;
    },
    text: async (prompt) => {
      calls += 1;
      if (!prompt.tag.endsWith('-bodyonly')) throw new Error(`意外调用 text()：${prompt.tag}`);
      bodyOnlyTags.push(prompt.tag);
      // 兜底提示词里不能残留「输出 JSON」的要求，否则等于换了个说法继续失败
      if (prompt.system.includes('只输出一个 JSON 对象')) throw new Error('兜底提示词仍要求输出 JSON');
      if (prompt.user.includes('输出：{"tags"')) throw new Error('兜底提示词仍残留 JSON 输出示例');
      return fallbackBody;
    },
  };

  try {
    await runCompile({
      targets: [RAW],
      all: false,
      force: true,
      dryRun: false,
      verbose: false,
      llm,
    });

    const ids = await listPageIds();
    // 4 = PLAN 里的 3 个 create + 程序自动补的素材摘要页（sources/llm-wiki-intro）
    assert.ok(ids.length >= 4, `应把 4 个页面都建出来，实际 ${ids.length} 个`);
    // 只统计走 LLM 草稿的页面：sources/ 摘要页由程序装配，不经过草稿生成
    assert.equal(bodyOnlyTags.length, 3, '三个 create 的页面草稿都应走兜底路径');

    const page = await readPage('concepts/retrieval-augmented-generation');
    // reindex 会把反向链接区块追加进正文，比较前先剥掉
    assert.equal(stripAutoBacklinks(page.body).trim(), fallbackBody, '正文应来自纯文本模式');
    assert.deepEqual(page.meta.tags, [], '兜底拿不到 tags，应回落到空数组');
    assert.deepEqual(page.meta.aliases, []);
    assert.match(page.body, /\[\[sources\/llm-wiki-intro\]\]/, '兜底正文里的链接仍要通过校验');

    const rebuilt = await reindex();
    assert.equal(rebuilt.deadLinks.length, 0);
    console.log(`  ① apply 全部结构化失败 → ${bodyOnlyTags.length} 个页面经纯文本兜底建出`);
    console.log(`  ② 兜底页面 tags=[] · 链接校验通过 · 死链 ${rebuilt.deadLinks.length}`);
  } finally {
    await restoreWiki(snapshot);
  }
}

/**
 * 现场快照 / 还原。
 *
 * **只存 manifest 是不够的**——manifest 描述的是页面本身，删掉页面后留下那份 manifest
 * 等于留下一份指向不存在页面的「已编译」记录，后面的检查会以为 wiki 是满的。
 * 早期三个检查都犯了这个错，靠「后面还会再编译一次」侥幸掩盖。
 */
interface WikiSnapshot {
  pages: Map<string, Page>;
  manifest: Record<string, unknown>;
}

async function snapshotWiki(): Promise<WikiSnapshot> {
  const manifest = (await readManifest()) as unknown as Record<string, unknown>;
  const pages = new Map<string, Page>();
  for (const id of await listPageIds()) pages.set(id, await readPage(id));
  return { pages, manifest };
}

async function wipeWiki(): Promise<void> {
  for (const id of await listPageIds()) await rm(pagePath(id), { force: true });
  await writeManifest({});
  await reindex();
}

async function restoreWiki(snapshot: WikiSnapshot): Promise<void> {
  for (const id of await listPageIds()) await rm(pagePath(id), { force: true });
  for (const page of snapshot.pages.values()) await writePage(page);
  await writeManifest(snapshot.manifest as never);
  await reindex();
}

/**
 * 磁盘级兜底还原：把 main() 开头备份的 wiki/ 与 .state/ 整目录拷回。
 * 这是内存快照还原（restoreWiki）之外的安全网——只要备份在，真实产物就能找回。
 */
async function restoreWikiFromDisk(backup: string): Promise<void> {
  for (const sub of [WIKI_DIR, STATE_DIR]) {
    await rm(sub, { recursive: true, force: true });
    const src = path.join(backup, path.basename(sub));
    if (existsSync(src)) await cp(src, sub, { recursive: true });
  }
  await reindex();
}

/** 问答用的假模型：按 system 区分「选页」与「生成答案」两个阶段 */
function makeQueryChat(
  report: string[],
  scenario: { ids: string[]; answer: string },
): ChatFn {
  return async (messages: readonly ChatMessage[]) => {
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    if (system.includes('你是检索器')) {
      report.push(`select → 返回 ids=${JSON.stringify(scenario.ids)}`);
      return JSON.stringify({ ids: scenario.ids, reason: '离线冒烟固定选择' });
    }
    report.push('answer → 生成回答');
    return scenario.answer;
  };
}

/**
 * S12 的离线验收，重点是「答案不可信时必须被抓住」。
 * 这一段不需要真实 wiki 是空的——它复用前面已经建好的页面网络。
 */
async function checkQuery(): Promise<void> {
  console.log('\n===== S12 检查：问答与引用校验 =====');
  const known = (await listPageIds())[0];
  assert.ok(known !== undefined, '此时 wiki 里应当已有页面（前面的检查留下的）');
  const raw = RAW.replace(/^raw\//, '').replace(/\.md$/, '');
  const sourceId = `sources/${raw}`;
  console.log(`  使用页面：${known} · ${sourceId}`);

  const run = async (scenario: { ids: string[]; answer: string }): Promise<Awaited<ReturnType<typeof runQuery>>> => {
    const report: string[] = [];
    const counts = new Map<string, number>();
    return runQuery({
      question: '离线冒烟的问题',
      llm: fakeClient(report, makeQueryChat(report, scenario), counts),
      log: (line) => console.log(`    ${line}`),
    });
  };

  // ① 正常路径：引用真实存在的页面 → 校验通过
  const good = await run({ ids: [known], answer: `结论在这里 [[${known}]]。` });
  assert.deepEqual(good.selectedIds, [known]);
  assert.deepEqual(good.badCitations, []);
  assert.equal(good.llmCalls, 2, '选页 + 生成，两次调用');
  console.log(`  ① 正常引用：选中 ${good.selectedIds.length} 页 · 引用校验通过 · LLM 调用 ${good.llmCalls} 次`);

  // ② 幻觉压力测试：wiki 覆盖不了时不许编，必须直说未收录
  const noCoverage = await run({ ids: [], answer: '（这条不该被调用）' });
  assert.equal(noCoverage.answer, NO_COVERAGE_ANSWER);
  assert.equal(noCoverage.llmCalls, 1, '选页为空时不该再调一次生成');
  console.log('  ② 选页为空：直接回答「wiki 中未收录」，且没有多花一次调用');

  // ③ 幻觉引用必须被抓住（并让命令以非 0 退出）
  const hallucinated = await run({ ids: [known], answer: `见 [[concepts/凭空编造]] 与 [[${known}]]。` });
  assert.deepEqual(hallucinated.badCitations, ['concepts/凭空编造']);
  console.log(`  ③ 幻觉引用被抓出：${hallucinated.badCitations.join(', ')}`);

  // ④ 模型选了不存在的 id：程序过滤掉，而不是传给下一阶段
  const filtered = await run({ ids: ['concepts/根本不存在', known], answer: `结论 [[${known}]]。` });
  assert.deepEqual(filtered.selectedIds, [known], '不存在的 id 必须被程序过滤掉');
  console.log('  ④ 选页里的非法 id 被程序过滤，未进入上下文');

  // ⑤ 空答案不能被当成「通过了引用校验」混过去（内容被拦、被截断都会长这样）
  await assert.rejects(
    () => run({ ids: [known], answer: '   ' }),
    /模型返回了空答案/,
    '空答案必须报错，而不是当成一次成功的回答',
  );
  console.log('  ⑤ 空答案被拒绝，而不是当成成功回答');
}

/** --force 与「素材被改过」都必须让三个 Pass 全部重跑 */
async function checkForceAndHashChange(): Promise<void> {
  console.log('\n===== S10 检查：--force 与 hash 失效 =====');
  const report: string[] = [];
  const counts = new Map<string, number>();

  await runCompile({
    targets: [RAW],
    all: false,
    force: true,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(`  ① --force：extract ${counts.get('extract') ?? 0} 次 · plan ${counts.get('plan') ?? 0} 次（都应 >0）`);
  assert.ok((counts.get('extract') ?? 0) > 0, '--force 必须忽略缓存重跑 extract');
  assert.ok((counts.get('plan') ?? 0) > 0, '--force 必须忽略 manifest 重跑 plan');

  // 改一点点素材内容 → hash 变 → 三个 Pass 全部重跑
  const original = await readRaw(RAW);
  try {
    await writeRawFile(RAW, `${original}\n\n## 补充\n\n新增一段，用于验证内容变化会让整个编译失效。\n`);
    counts.clear();
    await runCompile({
      targets: [RAW],
      all: false,
      force: false,
      dryRun: false,
      verbose: false,
      llm: fakeClient(report, makeFakeChat(report), counts),
    });
    console.log(
      `  ② 素材变化后：extract ${counts.get('extract') ?? 0} 次 · plan ${counts.get('plan') ?? 0} 次 · apply ${counts.get('apply') ?? 0} 次`,
    );
    assert.ok((counts.get('extract') ?? 0) > 0, 'hash 变了就不能复用 extract 缓存');
    assert.ok((counts.get('plan') ?? 0) > 0, 'hash 变了就必须重新规划');
  } finally {
    await writeRawFile(RAW, original);
  }

  // 恢复内容后：
  // 此时 manifest 里存的是「改过的版本」的 hash，与还原后的内容不符，所以第一次必然重跑；
  // 重跑完 manifest 才重新对齐，第二次才应该跳过。这里顺带验证还原是逐字节的。
  counts.clear();
  const afterRestore = await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(
    `  ③ 素材还原后第一次：编译 ${afterRestore.compiled} 份（manifest 里存的是改过版本的 hash，必须重跑）· extract ${counts.get('extract') ?? 0} 次`,
  );
  assert.equal(afterRestore.compiled, 1, 'manifest 与当前内容不一致，必须重跑');
  assert.ok((counts.get('extract') ?? 0) > 0);

  counts.clear();
  const stable = await runCompile({
    targets: [RAW],
    all: false,
    force: false,
    dryRun: false,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), counts),
  });
  console.log(`  ④ 还原后第二次：跳过 ${stable.skipped} 份 · LLM 调用 ${totalCalls(counts)} 次`);
  assert.equal(stable.skipped, 1);
  assert.equal(totalCalls(counts), 0, 'hash 对齐后应重新变回零调用');
}

/** dry-run 的承诺：只跑到计划，一个字节都不写。这是必须守住的安全属性，故单独验一次 */
async function checkDryRunKeepsWikiUntouched(): Promise<void> {
  const pagesBefore = await listPageIds();
  const manifestBefore = await readManifest();
  const passesBefore = await readdir(PASSES_DIR).catch(() => [] as string[]);

  const report: string[] = [];
  const summary = await runCompile({
    targets: [RAW],
    all: false,
    force: true,
    dryRun: true,
    verbose: false,
    llm: fakeClient(report, makeFakeChat(report), new Map()),
  });

  assert.deepEqual(await listPageIds(), pagesBefore, 'dry-run 不得改动 wiki/');
  assert.deepEqual(await readManifest(), manifestBefore, 'dry-run 不得写 manifest');
  assert.deepEqual(
    await readdir(PASSES_DIR).catch(() => [] as string[]),
    passesBefore,
    'dry-run 不得写 Pass 缓存（否则它就不是「不落盘」了）',
  );
  console.log(`\n===== dry-run 检查 =====`);
  console.log(`  计划 ${summary.planned} 份 · LLM 调用 ${report.length} 次 · wiki/、manifest、Pass 缓存均未被改动 ✓`);
}

export async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const dryRunOnly = process.argv.includes('--dry-run');
  const pagesBefore = new Set(await listPageIds());
  const hadManifest = existsSync(MANIFEST_FILE);
  const manifestBefore = await readManifest();

  if (dryRunOnly) {
    await checkDryRunKeepsWikiUntouched();
    return;
  }

  const report: string[] = [];
  const counts = new Map<string, number>();
  let summary: CompileSummary | undefined;
  let failure: unknown = null;
  let diskBackup: string | undefined;

  // 磁盘安全网：先把真实 wiki/ 与 .state/ 整体备份到临时目录。
  // 后续的内存快照还原（restoreWiki）若再出 bug，这里能兜底还原，绝不会弄丢真实产物。
  diskBackup = await mkdtemp(path.join(os.tmpdir(), 'my-wiki-smoke-bak-'));
  if (existsSync(WIKI_DIR)) await cp(WIKI_DIR, path.join(diskBackup, 'wiki'), { recursive: true });
  if (existsSync(STATE_DIR)) await cp(STATE_DIR, path.join(diskBackup, '.state'), { recursive: true });

  try {
    // 检查失败也必须走完清理，否则会把产物留在 wiki/ 里，
    // 下一次运行看到的「初始现场」就是脏的（这个坑在开发时就踩到过一次）
    try {
      summary = await runCompile({
        targets: [RAW],
        all: false,
        force: true,
        dryRun: false,
        verbose: true,
        llm: fakeClient(report, makeFakeChat(report), counts),
      });

      console.log('\n===== 假模型调用轨迹 =====');
      for (const line of report) console.log(`  ${line}`);

      await checkIncrementalAndResume();
      await checkApplyFailureLeavesNoResidue();
      await checkForceAndHashChange();
      await checkCompoundingUpdate();
      await checkBodyOnlyFallback();
      await checkQuery();
    } catch (error) {
      failure = error;
      console.error(`\n✗ 检查未通过：${error instanceof Error ? error.message : String(error)}`);
    }

    const created = (await listPageIds()).filter((id) => !pagesBefore.has(id));
    console.log('\n===== 汇总 =====');
    console.log(
      `  编译 ${summary?.compiled ?? 0} 份 · 新建 ${summary?.created.length ?? 0} 页 · 更新 ${summary?.updated.length ?? 0} 页`,
    );
    console.log(`  wiki 中实际新增 ${created.length} 个页面：${created.join(', ') || '无'}`);

    if (keep && failure === null) {
      console.log('\n--keep 已指定，保留 wiki/ 产物供人工检查。');
    } else if (failure === null) {
      // 清理：删掉本次产物、Pass 缓存并恢复 manifest，避免冒烟数据污染真实编译。
      // 缓存虽只在 manifest 标记 ok 时才被读取（留着危害有限），但不清理就等于留下陷阱：
      // 以后谁手工把 manifest 改成 ok 却没意识到页面早被删了，就会拿旧抽取结果去重新生成页面。
      for (const id of created) await rm(pagePath(id), { force: true });
      for (const raw of [RAW, RAW2]) {
        await rm(passCachePath('extract', raw), { force: true });
        await rm(passCachePath('plan', raw), { force: true });
      }
      if (hadManifest) await writeManifest(manifestBefore);
      else await rm(MANIFEST_FILE, { force: true });
      const rebuilt = await reindex();
      console.log(`\n已清理产物，wiki 恢复为 ${rebuilt.ids.length} 个页面。`);
    }
    // failure !== null 时不走上面的清理——交给 finally 里的磁盘备份兜底还原
  } finally {
    // 失败时：内存快照若没救回来，用磁盘备份兜底还原（隔离副本）。
    // 真实 wiki/ 由外层 scripts/smoke.ts 的隔离机制保证不被触碰。
    if (failure !== null && diskBackup !== undefined) {
      await restoreWikiFromDisk(diskBackup);
      console.log('（已从磁盘备份还原隔离副本）');
    }
    if (diskBackup !== undefined) await rm(diskBackup, { recursive: true, force: true });
  }

  if (failure !== null) process.exitCode = 1;
}

// 仅当作为入口直接执行时才自动跑；被 scripts/smoke.ts 以隔离模式导入时不自动跑。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
