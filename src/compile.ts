/**
 * 编译流水线：把 raw/ 下的素材编译成互相链接的 wiki 页面。
 *
 * 三趟 LLM 调用 + 一趟纯计算：
 *   [0] scan    算 hash，对 manifest → apply 已 ok 且内容未变则跳过
 *   [1] extract Pass 1  只读素材，抽概念/实体/断言
 *   [2] plan    Pass 2  输入 = 抽取结果 + 索引卡片列表（不是全文！），输出操作计划
 *   [3] apply   Pass 3  逐 Op 生成正文 → 全部在内存装配 → 统一校验 → 原子落盘
 *   [4] reindex 重建索引与反向链接，然后才把 manifest 标记为 ok
 *
 * 串行处理素材：顺序很重要，后一份素材必须能看到前一份编译出的页面，这就是复利效应。
 */
import path from 'node:path';
import { parseOwnLinks, stripAutoBacklinks } from './links.js';
import { JSON_ONLY, createLlmClient, type LlmClient } from './llm.js';
import { ensureIndex, reindex } from './reindex.js';
import { loadRules, loadTaxonomy, loadTemplate } from './schema.js';
import type { ZodType } from 'zod';
import {
  ensureDirs,
  listPageIds,
  listRawFiles,
  passCachePath,
  readIndex,
  readManifest,
  readPage,
  readPassCache,
  readRaw,
  rawHash,
  slugify,
  upsertManifestEntry,
  withBody,
  writePage,
  writePassCache,
} from './store.js';
import {
  PASS_NAMES,
  TYPE_DIRS,
  emptyPassState,
  extractSchema,
  pageDraftSchema,
  planSchema,
  today,
  type Extract,
  type IndexEntry,
  type Op,
  type Page,
  type PageType,
  type PassName,
  type PassState,
} from './types.js';

/** 单份素材交给 LLM 的字数上限，超过就截断并告警（避免把上下文一次打满） */
const MAX_RAW_CHARS = 60_000;
/** 喂给模型的可链接页面数量上限 */
const MAX_LINK_CANDIDATES = 40;



export interface CompileOptions {
  /** 指定素材（相对项目根的路径，如 raw/foo.md）；为空时配合 all 使用 */
  targets: string[];
  all: boolean;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
  /** 注入用（测试）；不传则按环境变量建真实客户端 */
  llm?: LlmClient;
  /** 注入用（测试）；不传则打到 stdout */
  log?: (line: string) => void;
}

export interface CompileSummary {
  compiled: number;
  skipped: number;
  /** dry-run 下只跑到计划，不落盘；用这个字段如实反映「跑了但没写」 */
  planned: number;
  created: string[];
  updated: string[];
  llmCalls: number;
}

export function sourceIdOf(rawRelPath: string): string {
  const stem = path.basename(rawRelPath).replace(/\.md$/i, '');
  return `sources/${slugify(stem)}`;
}

function renderCards(cards: readonly IndexEntry[]): string {
  if (cards.length === 0) return '（空）';
  return cards
    .map((card) => {
      const aliases = card.aliases.length > 0 ? card.aliases.join('/') : '无';
      return `- ${card.id} | ${card.type} | ${card.title} | ${card.oneLiner} | 别名: ${aliases}`;
    })
    .join('\n');
}

/**
 * 渲染「可链接的页面 id」清单。
 *
 * **摘要页 id 必须列进来**（而不是只列本批新建的页面）：它是程序创建的，
 * 模型无从猜到确切写法，而模板又要求它在「出处」小节链接摘要页。少了这一条，
 * 模型只能拿手上的素材路径去凑，于是写出 `[[raw/llm-wiki-intro]]` 这种非法链接
 * ——本项目实测就是这样卡住了一次真实编译。
 */
export function renderLinkCandidates(
  cards: readonly IndexEntry[],
  extraIds: readonly string[],
  sourceId: string,
): string {
  const lines: string[] = [];
  for (const card of cards.slice(0, MAX_LINK_CANDIDATES)) lines.push(`- ${card.id} — ${card.oneLiner}`);
  for (const id of extraIds) {
    if (!lines.some((line) => line.startsWith(`- ${id} `))) lines.push(`- ${id} — （本次新建）`);
  }
  if (!lines.some((line) => line.startsWith(`- ${sourceId} `))) {
    lines.push(`- ${sourceId} — 本素材的摘要页（程序本次创建）。「出处」小节请链接它，不要写 raw/ 路径`);
  }
  return lines.length === 0 ? '（暂无，本次不要使用任何链接）' : lines.join('\n');
}

/** 去掉模型偶尔自作主张加上的 frontmatter 与反向链接区块——它们由程序负责 */
export function sanitizeDraftBody(body: string): string {
  const withoutFrontmatter = body.replace(/^\s*---\n[\s\S]*?\n---\n?/, '');
  return stripAutoBacklinks(withoutFrontmatter).replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * 逐字比对前的归一化。
 *
 * 模型「抄录」时会做一串无害的**字符规范化**，这些都不是改写内容：
 *   ① 去掉 `**加粗**` 记号、把换行重新折行（本项目实测踩到，丢了真实摘录）
 *   ② 把全角标点换成半角（`，` → `,`、`（` → `(`）——交给 NFKC
 *   ③ 把弯引号换成直引号（原文的 `“复利效应”` 被抄成 `"复利效应"`）
 *      ——NFKC **不**覆盖这一项，必须单独处理（实测丢了 2 条真实摘录）
 *
 * 注意这不会让「改写」蒙混过关：改写动的是**用词与语序**，归一化只动排版字符。
 */
export function squashForVerbatim(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[“”„‟「」『』'']/g, '"')
    .replace(/[`*_~>\s]/g, '');
}

/**
 * 引用是否逐字来自原文。
 * 阈值 6 个字：过短的片段容易在长文里伪命中。
 */
export function isVerbatim(evidence: string, rawText: string): boolean {
  const needle = squashForVerbatim(evidence);
  return needle.length >= 6 && squashForVerbatim(rawText).includes(needle);
}

/** rules.md 里的正文长度上限，超了只告警不截断——截断会切断链接语法 */
const MAX_BODY_CHARS = 400;

/** 兜底小节黑名单：模型在 update 时最爱加这些来「安放」新内容 */
const FORBIDDEN_HEADINGS = ['补充说明', '其他', '杂记', '相关阅读', '总结', '参考资料'];

/** 正文里的一级小节标题（已剥掉程序生成的反向链接区块） */
export function headingsOf(body: string): string[] {
  return stripAutoBacklinks(body)
    .split('\n')
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim());
}

/**
 * 更新后的正文不得损坏已有结构。
 * 复利效应的最大风险是「越更新越像流水账」：模型把整篇重写、顺手丢掉几节，
 * 或新开一个「补充说明」把新事实堆进去。这两件事都不会报错，只会让 wiki 慢慢烂掉，
 * 所以必须在写盘前拦住。
 */
export function checkUpdateIntegrity(before: string, after: string): string[] {
  const beforeHeadings = headingsOf(before);
  const afterHeadings = headingsOf(after);
  const problems: string[] = [];

  for (const heading of beforeHeadings) {
    if (!afterHeadings.includes(heading)) problems.push(`原有小节「${heading}」在更新后消失了`);
  }

  const duplicates = [...new Set(afterHeadings.filter((heading, index) => afterHeadings.indexOf(heading) !== index))];
  for (const heading of duplicates) problems.push(`小节「${heading}」重复出现`);

  for (const heading of afterHeadings) {
    const forbidden = FORBIDDEN_HEADINGS.find((bad) => heading.includes(bad));
    if (forbidden !== undefined && !beforeHeadings.includes(heading)) {
      problems.push(`新增了兜底小节「${heading}」`);
    }
  }

  return problems;
}

/** 正文长度（不含空白），用于对照 rules.md 的上限 */
export function bodyLength(body: string): number {
  return [...stripAutoBacklinks(body).replace(/\s/g, '')].length;
}

/**
 * 页面不得链接到自己。
 * 看着很蠢，但模型在「补一个相关链接」时真的会写出自链接（本项目实测踩到），
 * 它会凭空把这一页塞进自己的反向链接里，污染整张图。
 */
export function checkSelfLinks(body: string, id: string): string[] {
  return parseOwnLinks(body)
    .filter((link) => link === id)
    .map(() => `正文里出现了指向自己的链接 [[${id}]]，没有意义，请去掉`);
}

// ------------------------------------------------------------------ Pass 1

async function extractPass(llm: LlmClient, rawRelPath: string, rawText: string): Promise<Extract> {
  const [rules, taxonomy] = await Promise.all([loadRules(), loadTaxonomy()]);
  const stem = slugify(path.basename(rawRelPath).replace(/\.md$/i, ''));

  return llm.structured({
    tag: `extract-${stem}`,
    system: [
      rules,
      taxonomy,
      '',
      '# 本阶段职责',
      '你是**抽取器**，只从素材里抽取结构化信息，**不做任何「该写哪些页面」的决定**。',
      JSON_ONLY,
    ].join('\n'),
    user: [
      '下面是原始素材全文。请抽取：',
      '',
      '- `title`：这份素材的标题（10 字左右，概括主题，不要照抄文件名）',
      '- `oneLiner`：一句话说清它在讲什么（10~20 字）',
      '- `summary`：概要（150 字以内）',
      '- `concepts`：其中的概念/方法/理论/模式，每个给 `name`、`definition`（一句话）、`evidence`（逐字摘自原文的短句）',
      '- `entities`：人物、组织、项目、工具，每个给 `name`、`kind`、`evidence`',
      '- `claims`：带事实的断言列表（每条都必须能对应回原文，不要写自己的推论）',
      '- `relationHints`：概念之间的关系，`from`/`to` 用第 4、5 项里出现过的名称，`relation` 描述是什么关系',
      '',
      '硬性要求：',
      '',
      '- `evidence` 必须**逐字复制**原文，不得改写、翻译、概括。拿不出原文依据的就不要写。',
      '- `concepts` 控制在 3~8 个：优先抽取反复出现、充当论述主干的词，不要抽「介绍」「特点」「总结」这类空词。',
      '- `claims` 控制在 3~8 条。',
      '',
      '输出格式示例（字段齐全，内容仅为示意）：',
      '```json',
      JSON.stringify(
        {
          title: '示例素材标题',
          oneLiner: '示例：一句话说明',
          summary: '示例概要。',
          concepts: [{ name: '示例概念', definition: '一句话定义', evidence: '原文里的原句' }],
          entities: [{ name: '某个人物', kind: '人物', evidence: '原文里的原句' }],
          claims: ['示例断言'],
          relationHints: [{ from: '示例概念', to: '另一个概念', relation: '前者是后者的实现方式' }],
        },
        null,
        2,
      ),
      '```',
      '',
      '【素材】',
      rawText.slice(0, MAX_RAW_CHARS),
    ].join('\n'),
    schema: extractSchema,
  });
}

// ------------------------------------------------------------------ Pass 2

/**
 * 为每个抽取出的概念/实体挑出最相关的已有页面——只看标题/id/oneLiner 的重叠，不读正文。
 * 这是 plan 阶段决定「update 还是 create」的关键输入：模型只有看到了已有页面的**内容**，
 * 才判断得出「向量检索」讲的其实就是「临时检索」的检索阶段。卡片清单只有一句话摘要，
 * 信息量不够，所以这里再把命中候选的**正文摘录**喂给模型（见 renderRelatedPages）。
 */
function relatedEntries(extract: Extract, cards: readonly IndexEntry[]): IndexEntry[] {
  if (cards.length === 0) return [];
  const names = [
    ...extract.concepts.map((item) => item.name),
    ...extract.entities.map((item) => item.name),
  ];
  const scored = new Map<string, number>();
  for (const name of names) {
    const nk = titleKey(name);
    if (nk.length < 2) continue;
    for (const page of cards) {
      const pk = titleKey(page.title);
      let score = 0;
      if (pk.includes(nk) || nk.includes(pk)) score += 3; // 名字互相包含：强信号
      else if (titleKey(page.oneLiner).includes(nk)) score += 1; // oneLiner 提到该名字
      if (score > 0) scored.set(page.id, Math.max(scored.get(page.id) ?? 0, score));
    }
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => cards.find((card) => card.id === id))
    .filter((card): card is IndexEntry => card !== undefined);
}

/** 把命中候选页面的正文摘录拼成一段，供 plan 阶段判断语义等价 */
async function renderRelatedPages(cards: readonly IndexEntry[], extract: Extract): Promise<string> {
  const related = relatedEntries(extract, cards);
  if (related.length === 0) return '（没有疑似相关的已有页面）';
  const blocks: string[] = [];
  for (const page of related) {
    let body: string;
    try {
      body = stripAutoBacklinks((await readPage(page.id)).body);
    } catch {
      continue;
    }
    const headings = headingsOf(body);
    const excerpt = body.replace(/^#.*\n/, '').replace(/\n{2,}/g, ' ').trim().slice(0, 220);
    blocks.push(
      `### ${page.title} (${page.id}) — ${page.oneLiner}\n` +
        `小节：${headings.join(' / ')}\n` +
        `正文摘录：「${excerpt}」`,
    );
  }
  return blocks.join('\n\n');
}

async function planPass(
  llm: LlmClient,
  extract: Extract,
  cards: readonly IndexEntry[],
  rawRelPath: string,
): Promise<Op[]> {
  const [rules, taxonomy, relatedBlock] = await Promise.all([
    loadRules(),
    loadTaxonomy(),
    renderRelatedPages(cards, extract),
  ]);
  const stem = slugify(path.basename(rawRelPath).replace(/\.md$/i, ''));
  const isEmpty = cards.length === 0;

  const plan = await llm.structured({
    tag: `plan-${stem}`,
    system: [
      rules,
      taxonomy,
      '',
      '# 本阶段职责',
      '你是编译器的**规划阶段**：根据一次抽取结果与现有页面清单，决定要对 wiki 做哪些操作。',
      JSON_ONLY,
      '输出的顶层结构固定为 {"ops":[...]}。',
    ].join('\n'),
    user: [
      '【本次抽取结果】',
      JSON.stringify(extract, null, 2),
      '',
      '【wiki 现有页面清单】(id | 类型 | 标题 | 一句话摘要 | 别名)',
      renderCards(cards),
      '',
      '【可能相关的已有页面正文】下面这些已存在页面，按「与本次取材标题的重叠」挑出来。' +
        '判断 update 还是 create 时**必看**：如果其中某页已经讲了这件事，必须 update 它，不要另起新页。',
      relatedBlock,
      '',
      `【当前状态】共 ${cards.length} 个页面。`,
      isEmpty
        ? 'wiki 目前为空，因此**不可能**出现 update 或 link，只能 create。'
        : '若某条内容能放进已有页面，必须 update 它，不要另起新页。',
      '',
      '【可用操作】',
      '- {"op":"create","type":"concept|entity","title":"中文标题","oneLiner":"10~20 字","slug":"可选，英文小写连字符","reason":"为什么新建"}',
      '- {"op":"update","targetId":"已有页面 id","patch":"在『某个章节』下补充哪一条事实","reason":"为什么更新"}',
      '- {"op":"link","fromId":"已有页面 id","toId":"已有页面 id","reason":"为什么该连上"}',
      '- {"op":"noop","reason":"没有需要做的事"}',
      '',
      '【要求】',
      '- **对每一个候选概念，必须先做这一步判断**：它在清单里有没有语义等价的页面？',
      '  · 有（哪怕标题不同、是近义说法、或命中别名）→ 必须 update 它，patch 要写明「在哪个小节下补充哪一句事实」',
      '  · 没有 → 才允许 create',
      '- 判断「语义等价」看的是**讲的是不是同一件事**，不是名字像不像。',
      '  「向量检索」与「向量检索技术」是同一个概念；同一个概念在一次输出里只能出现一次。',
      '- 复利效应正体现在这里：新素材的价值常常不是建新页，而是让旧页更准、更全。',
      '  **如果全是 create，说明你只是在堆摘要，没有在做知识管理。**',
      '- create 数量控制在 2~6 个；不要创建标题为「列表」「杂记」「其他」「总结」的页面。',
      '- **不要**为素材摘要页（`sources/*`）创建 op，程序会自己处理。',
      `- 本批新建页面的链接目标是允许的；但 update/link 的 id 必须来自上面的清单。`,
      `- 本次素材是 ${rawRelPath}。`,
      '',
      '【输出示例】下面两条演示形状，id 与标题都要替换成你实际要用的：',
      '{"ops":[',
      '  {"op":"create","type":"concept","title":"余弦相似度","oneLiner":"衡量两个向量的接近程度","slug":"cosine-similarity","reason":"清单中没有等价页面"},',
      '  {"op":"update","targetId":"<清单里真实存在的 id>","patch":"在『与其他概念的关系』下补充：……","reason":"这条事实讲的就是这个已有页面的概念，不能另起新页"}',
      ']}',
    ].join('\n'),
    schema: planSchema,
  });

  return plan.ops;
}

export function formatPlan(ops: readonly Op[]): string {
  const labels: Record<Op['op'], string> = {
    create: '[create]',
    update: '[update]',
    link: '[link]  ',
    noop: '[noop]  ',
  };
  return ops
    .map((op) => {
      switch (op.op) {
        case 'create':
          return `${labels.create} ${op.type.padEnd(7)} ${op.title}  ← ${op.oneLiner}`;
        case 'update':
          return `${labels.update} ${op.targetId}  ← ${op.patch}`;
        case 'link':
          return `${labels.link} ${op.fromId} -> ${op.toId}`;
        case 'noop':
          return `${labels.noop} ${op.reason}`;
      }
    })
    .join('\n');
}

// ------------------------------------------------------------------ Pass 3

/**
 * 标题/别名的归一化键，用于识别「模型嘴上说 create，其实这个页面已经存在」。
 * 这类重复页一旦生成就会各自长出反向链接，很难再合并回去，所以必须在写入前拦住。
 */
function titleKey(text: string): string {
  return text.toLowerCase().replace(/[\s（）()【】\[\]「」『』：:、,，.。·\-_/]/g, '');
}

/**
 * 中文概念常带「修饰性后缀」：`向量检索技术`、`RAG 系统`、`RAG 算法` 与 `向量检索`/`RAG`
 * 是同一个概念的两种叫法。把后缀剥掉得到**规范键**，用于：
 *   - 批内去重（两个 create 归一到同一键 → 合并）
 *   - 已有页面匹配（模型写了 `RAG技术` 而页面叫 `RAG` → 收敛成 update）
 *
 * 只剥「X 的修饰语」这种组合：键必须以 X 开头、且 X 至少 2 字，避免把 `技术` 这种独立词误并。
 */
const MODIFIER_SUFFIXES = [
  '技术', '方法', '方式', '系统', '模型', '机制', '算法', '工具', '平台', '思想',
  '范式', '概念', '方案', '框架', '流程', '策略', '原理', '实现', '应用', '实践',
  '理论', '引擎', '服务', '组件', '模块', '结构', '模式', '协议', '标准', '能力', '特性',
];

function stripModifierSuffix(key: string): string {
  for (const suffix of MODIFIER_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const base = key.slice(0, key.length - suffix.length);
      if (base.length >= 2) return base;
    }
  }
  return key;
}

export function canonicalTitleKey(title: string): string {
  return stripModifierSuffix(titleKey(title));
}

function buildTitleIndex(pages: ReadonlyMap<string, Page>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, page] of pages) {
    for (const name of [page.meta.title, ...page.meta.aliases]) {
      const key = canonicalTitleKey(name);
      if (key !== '' && !index.has(key)) index.set(key, id);
    }
  }
  return index;
}

/**
 * 「你是不是想链接这个？」——把非法链接就近匹配到一个已知 id。
 *
 * 为什么需要它：模型会拿**标题**去拼 id（实测写出 `[[concepts/LLM Wiki]]`：前缀对、末段是标题、
 * 还带了个空格），而它要的其实是 `concepts/llm-wiki`。只说「id 不存在」，模型得自己在清单里翻；
 * 直接告诉它正确写法，重试的成功率和速度都完全不同——免费档上一次重试就是 30~60 秒。
 */
export function suggestId(
  badLink: string,
  known: Iterable<string>,
  byTitle: ReadonlyMap<string, string>,
): string | null {
  const bare = badLink.replace(/^[a-z]+\//i, '');
  const key = titleKey(bare);
  if (key === '') return null;

  for (const id of known) {
    if (titleKey(id.split('/').pop() ?? '') === key) return id;
  }
  return byTitle.get(key) ?? null;
}

/**
 * 找出「看起来是同一个概念的两种叫法」的标题。
 *
 * 实测踩到：模型在一次计划里同时给出 `向量检索技术` 与 `向量检索`，于是同一个概念被建成了两页，
 * 而两页会各自长出反向链接，事后很难合并。
 *
 * **只报警，不擅自合并**：自动合并需要判断「两个名字指的是不是一件事」，
 * 而前缀关系既可能是同义（复利 / 复利效应），也可能是不同粒度（向量 / 向量检索）。
 * 猜错的代价是丢概念，比留一个重复页更糟。所以把判断交给人和提示词。
 *
 * 注意：规范键相同的一对（如 `向量检索技术` / `向量检索`）已被 `planToWorkItems` 的批内合并自动处理，
 * 这里不再重复报警，只对「前缀关系但仍不同概念」之类存疑的情况提醒。
 */
export function nearDuplicateTitles(titles: readonly string[]): string[] {
  const warnings: string[] = [];
  const keyed = titles.map((title) => ({ title, key: canonicalTitleKey(title) }));

  for (let i = 0; i < keyed.length; i += 1) {
    for (let j = i + 1; j < keyed.length; j += 1) {
      const a = keyed[i];
      const b = keyed[j];
      if (a === undefined || b === undefined || a.key === '' || b.key === '') continue;
      const [short, long] = a.key.length <= b.key.length ? [a, b] : [b, a];
      // 规范键相同 → 已被批内合并自动处理，跳过
      if (short.key === long.key) continue;
      if (short.key.length >= 2 && long.key.startsWith(short.key)) {
        warnings.push(`「${short.title}」与「${long.title}」看起来是同一概念的两种叫法（前缀关系），请确认是否应合并为一页`);
      }
    }
  }
  return warnings;
}

interface WorkItem {
  kind: 'create' | 'update';
  id: string;
  type: PageType;
  title: string;
  oneLiner: string;
  patch: string;
  reason: string;
}

/** 把操作计划展开成「要写哪些页面」，并在内存里定好 id（此时还没有任何写盘） */
export function planToWorkItems(
  ops: readonly Op[],
  existingIds: ReadonlySet<string>,
  existing: ReadonlyMap<string, Page>,
  existingByTitle: ReadonlyMap<string, string>,
): { items: WorkItem[]; skipped: string[]; convertedToUpdate: string[]; warnings: string[] } {
  const taken = new Set(existingIds);
  const items: WorkItem[] = [];
  const skipped: string[] = [];
  const byTitle = new Map<string, WorkItem>();
  const convertedToUpdate: string[] = [];

  /** 同一个页面被多条 op 命中时合并 patch，否则后一条会覆盖前一条的编辑 */
  const pushUpdate = (item: WorkItem): void => {
    const existingItem = items.find((candidate) => candidate.kind === 'update' && candidate.id === item.id);
    if (existingItem === undefined) {
      items.push(item);
      return;
    }
    existingItem.patch = `${existingItem.patch}\n${item.patch}`;
  };

  for (const op of ops) {
    if (op.op === 'noop') continue;

    if (op.op === 'link') {
      // link 折成一次 update：让模型把链接放到语义最贴近的章节，而不是机械追加小节
      if (!taken.has(op.toId)) {
        skipped.push(`link ${op.fromId} -> ${op.toId}（目标页面不存在）`);
        continue;
      }
      if (!existing.has(op.fromId)) {
        // 首次编译时模型常在新页面之间互相 link。fromId 若也是本批新建的，
        // 无法立刻更新它——但它的 id 已经作为「可链接候选」交给生成阶段了，不会丢链接。
        skipped.push(
          taken.has(op.fromId)
            ? `link ${op.fromId} -> ${op.toId}（fromId 本次新建，链接已在生成正文时作为候选给出）`
            : `link ${op.fromId} -> ${op.toId}（源页面不存在）`,
        );
        continue;
      }
      if (parseOwnLinks(existing.get(op.fromId)?.body ?? '').includes(op.toId)) {
        skipped.push(`link ${op.fromId} -> ${op.toId}（已有该链接）`);
        continue;
      }
      const target = existing.get(op.fromId);
      pushUpdate({
        kind: 'update',
        id: op.fromId,
        type: target?.meta.type ?? 'concept',
        title: target?.meta.title ?? op.fromId,
        oneLiner: target?.meta.oneLiner ?? '',
        patch: `只做一件事：在语义最贴近的章节里增加一个指向 [[${op.toId}]] 的链接。除此之外不得改动任何内容、不得新增小节。`,
        reason: op.reason,
      });
      continue;
    }

    if (op.op === 'update') {
      const target = existing.get(op.targetId);
      if (target === undefined) {
        skipped.push(`update ${op.targetId}（页面不存在）`);
        continue;
      }
      pushUpdate({
        kind: 'update',
        id: op.targetId,
        type: target.meta.type,
        title: target.meta.title,
        oneLiner: target.meta.oneLiner,
        patch: op.patch,
        reason: op.reason,
      });
      continue;
    }

    // create：同批内视为同一页的，合并处理，保留更「泛」的那个标题。
    // 用**规范化键**而不是原始字符串，覆盖三类等价：
    //   · `LLM Wiki` 与 `llm-wiki` 归一化后相同 → 明确同一概念，合并
    //   · `向量检索技术` 与 `向量检索` → 剥掉「技术」修饰后缀后归一到同一键，合并
    //   · `RAG 系统` 与已有页面 `RAG` → 同样归一到同一键，收敛成 update
    const key = canonicalTitleKey(op.title);
    const merged = byTitle.get(key);
    if (merged !== undefined) {
      merged.patch = `${merged.patch}\n${op.reason}`;
      // 取更短（更泛）的标题作为页面名，并同步 slug/id，避免出现「向量检索」内容却叫「向量检索技术」
      if (op.title.trim().length < merged.title.length) {
        merged.title = op.title.trim();
        const slug = slugify(op.slug !== undefined && op.slug.trim() !== '' ? op.slug : op.title);
        merged.id = `${TYPE_DIRS[op.type]}/${slug}`;
      }
      continue;
    }

    // 已有同名或别名命中的页面时，把 create 收敛成 update，绝不造重复页
    const samePageId = existingByTitle.get(canonicalTitleKey(op.title));
    if (samePageId !== undefined) {
      const target = existing.get(samePageId);
      convertedToUpdate.push(`${op.title} → ${samePageId}`);
      pushUpdate({
        kind: 'update',
        id: samePageId,
        type: target?.meta.type ?? op.type,
        title: target?.meta.title ?? op.title,
        oneLiner: target?.meta.oneLiner ?? op.oneLiner,
        patch: `把本次素材里与「${op.title}」有关的新事实补充进去（${op.reason}）。若已有内容已覆盖，则原样返回正文。`,
        reason: op.reason,
      });
      continue;
    }

    const slug = slugify(op.slug !== undefined && op.slug.trim() !== '' ? op.slug : op.title);
    let id = `${TYPE_DIRS[op.type]}/${slug}`;
    for (let n = 2; taken.has(id); n += 1) id = `${TYPE_DIRS[op.type]}/${slug}-${n}`;
    taken.add(id);

    const item: WorkItem = {
      kind: 'create',
      id,
      type: op.type,
      title: op.title,
      oneLiner: op.oneLiner,
      patch: op.reason,
      reason: op.reason,
    };
    byTitle.set(key, item);
    items.push(item);
  }

  // 同一个页面被 create 与 update 同时命中时，update 优先（不要覆盖已有内容）
  const createIds = new Set(items.filter((item) => item.kind === 'create').map((item) => item.id));
  const filtered = items.filter((item) => !(item.kind === 'update' && createIds.has(item.id)));

  const warnings = nearDuplicateTitles(
    filtered.filter((item) => item.kind === 'create').map((item) => item.title),
  );

  return { items: filtered, skipped, convertedToUpdate, warnings };
}

interface ApplyContext {
  rawRelPath: string;
  extract: Extract;
  rawText: string;
  cards: readonly IndexEntry[];
  knownIds: ReadonlySet<string>;
  newIds: readonly string[];
  /** 标题/别名 → id，用于在链接写错时就近给出「你要的是哪个 id」 */
  titleIndex: ReadonlyMap<string, string>;
}

/**
 * source 摘要页要链到哪些页面。
 *
 * **不能只用「本批新建的 id」**：重编译时没有任何新建页，那个列表会变成空，
 * 于是「相关页面」被清空、source 页与整张网络断开，而且结果不再幂等（已实测踩到）。
 * 正确做法是把抽取出的概念/实体名按标题与别名映射到**已有页面**上——
 * 首次编译时映射到的正是刚建出来的页面，后续编译映射结果不变。
 */
export function sourceRelatedIds(
  extract: Extract,
  existingByTitle: ReadonlyMap<string, string>,
  newIds: readonly string[],
): string[] {
  const ids = new Set(newIds);
  const names = [...extract.concepts.map((item) => item.name), ...extract.entities.map((item) => item.name)];
  for (const name of names) {
    const id = existingByTitle.get(canonicalTitleKey(name));
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}

/** 程序自己生成 source 摘要页：摘录必须逐字来自 raw/，这件事不该交给模型 */
export function buildSourcePage(
  ctx: ApplyContext,
  relatedIds: readonly string[],
): { page: Page; notVerbatim: number; duplicates: number } {
  const id = sourceIdOf(ctx.rawRelPath);
  const evidences = [
    ...ctx.extract.concepts.map((item) => item.evidence),
    ...ctx.extract.entities.map((item) => item.evidence),
  ].filter((evidence) => evidence.trim() !== '');

  const verified: string[] = [];
  let notVerbatim = 0;
  let duplicates = 0;
  for (const evidence of evidences) {
    if (!isVerbatim(evidence, ctx.rawText)) {
      notVerbatim += 1;
      continue;
    }
    if (verified.includes(evidence)) {
      duplicates += 1;
      continue;
    }
    verified.push(evidence);
  }

  const body = [
    '## 概要',
    '',
    ctx.extract.summary,
    '',
    '## 关键论点',
    '',
    ...(ctx.extract.claims.length > 0 ? ctx.extract.claims.map((claim) => `- ${claim}`) : ['- （无）']),
    '',
    '## 原文摘录',
    '',
    ...(verified.length > 0 ? verified.map((item) => `- 「${item}」`) : ['- （无）']),
    '',
    '## 相关页面',
    '',
    ...(relatedIds.length > 0 ? relatedIds.map((id) => `- [[${id}]]`) : ['- （无）']),
  ].join('\n');

  return {
    page: {
      meta: {
        id,
        type: 'source',
        title: ctx.extract.title,
        oneLiner: ctx.extract.oneLiner,
        aliases: [],
        tags: [],
        sources: [ctx.rawRelPath],
        updated: today(),
      },
      body,
    },
    notVerbatim,
    duplicates,
  };
}

async function draftPass(
  llm: LlmClient,
  item: WorkItem,
  ctx: ApplyContext,
  current: Page | undefined,
  linkCandidates: string,
  /** 重试时把上一次的失败原因喂回去 */
  hint?: string,
): Promise<{ body: string; tags: string[]; aliases: string[] }> {
  const rules = await loadRules();
  const template = await loadTemplate(item.type);

  const system = [
    rules,
    '',
    `# 页面模板（${item.type}）`,
    template,
    '',
    item.kind === 'create'
      ? '你在为一个 wiki **新页面**写正文。'
      : '你在**更新**一个已有的 wiki 页面。',
    JSON_ONLY,
  ].join('\n');

  const common = [
    `页面 id：${item.id}`,
    `页面标题：${item.title}`,
    `一句话摘要：${item.oneLiner}`,
    '',
    // 表头必须点明「写完整 id」：实测模型最常犯的两种错是漏掉类型前缀（`[[提前编译]]`）
    // 与自行改写大小写/连字符（`[[concepts/LLM-Wiki]]`）。说清楚能省下一次 30~60 秒的重试。
    '【可链接的页面 id（只能链接这些）】必须原样照抄完整 id，包含 concepts/ entities/ sources/ 前缀，不要只写标题、不要改写大小写或连字符：',
    linkCandidates,
    '',
    '【素材】',
    ctx.rawRelPath,
    ...(hint === undefined ? [] : ['', '【上一次尝试的问题，必须修正】', hint]),
  ];

  // 输出示例固定放在最后一行：兜底路径要能安全地把它换掉，
  // 不能用正则去找（前面「抽取结果」的 JSON 里也有花括号，正则会打错目标）
  const outputLine = '- 输出：{"tags":[...],"aliases":[...],"body":"<页面正文的 Markdown>"}';
  const userLines =
    item.kind === 'create'
      ? [
          ...common,
          '',
          '【抽取结果】下面是从原素材抽取出的全部内容。请只挑与「页面标题」相关的事实写成这一页，',
          '不要写与标题无关的内容，也不要在一页里塞多个概念。',
          JSON.stringify(ctx.extract, null, 2),
          '',
          '【要求】',
          '- `body` 只写正文，**不要**写 frontmatter（id/type/sources 由程序装配），也不要写「反向链接」。',
          '- 严格按上面的模板结构组织，不要新增模板之外的章节。',
          '- 每条事实都要在「出处」小节给出逐字摘录。',
          '- 正文不超过 400 字；只能链接上面列出的 id，禁止凭空造 id 或链接到 raw/ 文件。',
          outputLine,
        ]
      : [
          ...common,
          '',
          '【页面现状（完整正文）】',
          // 必须剥掉反向链接区块再给模型：否则它可能把新内容追加到区块之后，
          // 而 sanitizeDraftBody 会从哨兵处截断，新增内容就被静默丢掉了。
          stripAutoBacklinks(current?.body ?? ''),
          '',
          '【需要补充的内容】',
          item.patch,
          '',
          '【要求】',
          '- 返回**完整的新正文**，不是 diff、不是补丁片段。',
          '- 保持已有段落顺序与标题不变，把新内容插入到语义最接近的章节下。',
          '- 不要新增「补充说明」「其他」「相关阅读」这类兜底小节；不要在正文里写 frontmatter。',
          '- 正文不超过 400 字；只能链接上面列出的 id。',
          outputLine,
        ];

  const user = userLines.join('\n');

  const tag = `apply-${item.kind}-${slugify(item.id.replace(/\//g, '-'))}`;
  try {
    const draft = await llm.structured({ tag, system, user, schema: pageDraftSchema });
    return { ...draft, body: sanitizeDraftBody(draft.body) };
  } catch {
    // 兜底：结构化输出彻底失败时，改要「纯 Markdown 正文」。
    //
    // 实测依据：模型会在 `body` 与 `tags` 的边界上把键的引号打错（写成 `'tags":`），
    // 而且 temperature 0.2 下三次重试**复现了完全相同的错误**——同一个提示词再问一次
    // 是纯粹的浪费。把长正文单独要出来反而稳，代价是这一次拿不到 tags/aliases
    // （它们会沿用页面已有的值，本来就是可选字段）。
    const raw = await llm.text({
      tag: `${tag}-bodyonly`,
      system: [
        rules,
        '',
        `# 页面模板（${item.type}）`,
        template,
        '',
        item.kind === 'create' ? '你在为一个 wiki **新页面**写正文。' : '你在**更新**一个已有的 wiki 页面。',
        '只输出正文的 Markdown 本身：不要 JSON、不要代码围栏、不要任何解释或开场白。',
      ].join('\n'),
      // 直接砍掉最后那行「输出：{...}」——outputLine 是构造时就固定在末尾的，
      // 不用正则去找（前面「抽取结果」的 JSON 里同样有花括号，正则会打错目标）
      user: [...userLines.slice(0, -1), '直接输出正文 Markdown，不要 JSON、不要围栏。'].join('\n'),
    });
    return { body: sanitizeDraftBody(raw), tags: [], aliases: [] };
  }
}

/**
 * 生成正文并校验；任何一条不通过就把原因喂回去重试一次。
 * 注意 create 分支的 prompt 里没有 patch 字段，所以错误必须作为独立的 hint 传入。
 *
 * 两类校验：
 *   ① 链接可达 —— 防止写出指向不存在页面的死链
 *   ② 更新完整性 —— 防止 update 丢掉原有小节或新增兜底小节（见 checkUpdateIntegrity）
 */
async function draftWithValidation(
  llm: LlmClient,
  item: WorkItem,
  ctx: ApplyContext,
): Promise<{ body: string; tags: string[]; aliases: string[] }> {
  const current = item.kind === 'update' ? await readPage(item.id) : undefined;
  const linkCandidates = renderLinkCandidates(ctx.cards, ctx.newIds, sourceIdOf(ctx.rawRelPath));

  let hint: string | undefined;
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const draft = await draftPass(llm, item, ctx, current, linkCandidates, hint);
    const problems: string[] = [];

    const dead = parseOwnLinks(draft.body).filter((link) => !ctx.knownIds.has(link));
    if (dead.length > 0) {
      // 反馈必须**可执行**。实测两种典型错误，只说「id 不存在」模型都无从修起：
      //   ① 链接到素材文件（[[raw/x]] / [[sources/raw/x]]）→ 告诉它该链哪个摘要页
      //   ② 拿标题拼 id（[[concepts/LLM Wiki]]）→ 直接告诉它正确写法是 [[concepts/llm-wiki]]
      // 免费档上一次重试要 30~60 秒，把改法说清楚的价值是可量化的。
      const rawLinks = dead.filter((link) => link.includes('raw/'));
      const otherLinks = dead.filter((link) => !link.includes('raw/'));
      const parts: string[] = [];

      if (rawLinks.length > 0) {
        parts.push(
          `不要链接到素材文件（${rawLinks.map((link) => `[[${link}]]`).join('、')}）；` +
            `引用素材时请链接它的摘要页 [[${sourceIdOf(ctx.rawRelPath)}]]`,
        );
      }
      if (otherLinks.length > 0) {
        const described = otherLinks.map((link) => {
          const suggestion = suggestId(link, ctx.knownIds, ctx.titleIndex);
          return suggestion === null ? `[[${link}]]` : `[[${link}]]（你要的是 [[${suggestion}]]）`;
        });
        parts.push(`这些 id 不存在：${described.join('、')}`);
      }

      problems.push(`${parts.join('；')}。只能使用「可链接的页面 id」里列出的 id。`);
    }
    problems.push(...checkSelfLinks(draft.body, item.id));
    if (current !== undefined) problems.push(...checkUpdateIntegrity(current.body, draft.body));

    if (problems.length === 0) return draft;

    lastError = problems.join('；');
    hint = lastError;
  }

  throw new Error(`页面 ${item.id} 的正文未通过校验，重试后仍未修正：${lastError}`);
}

// ------------------------------------------------------------------ 编排

/** 某个 Pass 结束就立刻落盘：extract 是最贵的一趟，绝不能因为后面 plan 崩了而白跑 */
async function trackPass<T>(
  pass: PassName,
  passes: PassState,
  persist: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    passes[pass] = 'ok';
    await persist();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    passes[pass] = `failed: ${message.split('\n')[0]?.slice(0, 160) ?? ''}`;
    await persist();
    throw error;
  }
}

/** 从缓存读回某个 Pass 的产物；缓存缺失或结构不符都当作「没有缓存」 */
async function readCachedPass<T>(
  rawRelPath: string,
  kind: 'extract' | 'plan',
  schema: ZodType<T>,
): Promise<T | null> {
  const raw = await readPassCache(passCachePath(kind, rawRelPath));
  if (raw === null) return null;
  const checked = schema.safeParse(raw);
  return checked.success ? checked.data : null;
}

interface ApplyArgs {
  llm: LlmClient;
  ops: readonly Op[];
  rawRelPath: string;
  extract: Extract;
  rawText: string;
  cards: readonly IndexEntry[];
  log: (line: string) => void;
}

interface ApplyOutcome {
  created: string[];
  updated: string[];
  /** 摘录没能在原文中逐字命中：可能是模型改写，也可能是我们的归一化还不够 */
  notVerbatim: number;
  /** 逐字命中但已收录过：只是重复，不是问题 */
  duplicateExcerpts: number;
  pageCount: number;
  deadLinkCount: number;
}

/**
 * Pass 3：把操作计划变成磁盘上的页面。
 * 三段落盘纪律——① 全部在内存装配 ② 统一校验 ③ 才原子落盘，
 * 这样任何一个 Op 失败都不会留下半成品目录。
 */
async function applyPlan(args: ApplyArgs): Promise<ApplyOutcome> {
  const { llm, ops, rawRelPath, extract, rawText, cards, log } = args;

  const existingIds = new Set(await listPageIds());
  const existing = new Map<string, Page>();
  for (const id of existingIds) existing.set(id, await readPage(id));
  const existingByTitle = buildTitleIndex(existing);

  const { items, skipped, convertedToUpdate, warnings } = planToWorkItems(
    ops,
    existingIds,
    existing,
    existingByTitle,
  );
  for (const reason of skipped) log(`  plan    → 跳过：${reason}`);
  for (const item of convertedToUpdate) log(`  plan    → 已有同名页面，create 收敛为 update：${item}`);
  for (const warning of warnings) log(`  plan    → 注意：${warning}`);

  const sourceId = sourceIdOf(rawRelPath);
  const newIds = items.filter((item) => item.kind === 'create').map((item) => item.id);
  const knownIds = new Set([...existingIds, ...newIds, sourceId]);

  const ctx: ApplyContext = { rawRelPath, extract, rawText, cards, knownIds, newIds, titleIndex: existingByTitle };

  // ① 全部在内存装配，此阶段一个字节都不落盘
  const pending: Page[] = [];
  const created: string[] = [];
  const updated: string[] = [];

  for (const item of items) {
    const draft = await draftWithValidation(llm, item, ctx);
    const current = existing.get(item.id);
    const page: Page = {
      meta: {
        id: item.id,
        type: item.type,
        title: item.title,
        oneLiner: item.oneLiner === '' ? (current?.meta.oneLiner ?? item.title) : item.oneLiner,
        aliases: draft.aliases.length > 0 ? draft.aliases : (current?.meta.aliases ?? []),
        tags: draft.tags.length > 0 ? draft.tags : (current?.meta.tags ?? []),
        sources: current?.meta.sources.includes(rawRelPath)
          ? current.meta.sources
          : [...(current?.meta.sources ?? []), rawRelPath],
        updated: today(),
      },
      body: draft.body,
    };
    pending.push(current === undefined ? page : withBody({ ...current, meta: page.meta }, draft.body));
    if (current === undefined) created.push(item.id);
    else updated.push(item.id);
  }

  const source = buildSourcePage(ctx, sourceRelatedIds(extract, existingByTitle, newIds));
  const existingSource = existing.get(source.page.meta.id);
  pending.push(
    existingSource === undefined
      ? source.page
      : withBody(
          {
            ...existingSource,
            // 标题/摘要由本次抽取决定，但用户给摘录页加的标签与别名不该被抹掉
            meta: { ...source.page.meta, aliases: existingSource.meta.aliases, tags: existingSource.meta.tags },
          },
          source.page.body,
        ),
  );
  if (existingSource === undefined) created.push(source.page.meta.id);
  else updated.push(source.page.meta.id);

  // ② 统一校验：本批所有页面的出链都必须可达（此时新页面 id 已在 knownIds 里）
  for (const page of pending) {
    const dead = parseOwnLinks(page.body).filter((link) => !knownIds.has(link));
    if (dead.length > 0) {
      throw new Error(`校验未通过，本次不写入任何文件：${page.meta.id} 的链接不可达 → ${dead.join(', ')}`);
    }
  }

  // ③ 全部通过，原子落盘
  for (const page of pending) await writePage(page);

  const rebuilt = await reindex();

  log(
    `  apply   → 新建 ${created.length} 个（${created.join(', ') || '无'}）· 更新 ${updated.length} 个（${updated.join(', ') || '无'}）`,
  );
  // 两类要分开报：一种是模型改写了（值得警惕），另一种只是重复（正常现象）。
  // 混成一句「丢弃 N 条」会让人误以为模型在编造，而实际上大半是同一条摘录被多个实体共用。
  if (source.notVerbatim > 0) {
    log(`  apply   → 丢弃 ${source.notVerbatim} 条无法在原文中逐字命中的摘录（模型改写了措辞）`);
  }
  if (source.duplicates > 0) {
    log(`  apply   → 合并 ${source.duplicates} 条重复摘录（多个条目共用同一句原文）`);
  }
  log(`  reindex → ${rebuilt.ids.length} 个页面 · 死链 ${rebuilt.deadLinks.length}`);

  // 超过 rules.md 的字数上限只告警、不截断：截断会切断链接语法，
  // 而该拆分页面是模型的活（见 doc/DEVELOPMENT.md S13）
  for (const page of pending) {
    const length = bodyLength(page.body);
    if (length > MAX_BODY_CHARS) {
      log(`  apply   → 注意：${page.meta.id} 正文 ${length} 字，超过 rules.md 的 ${MAX_BODY_CHARS} 字上限，考虑拆分`);
    }
  }

  return {
    created,
    updated,
    notVerbatim: source.notVerbatim,
    duplicateExcerpts: source.duplicates,
    pageCount: rebuilt.ids.length,
    deadLinkCount: rebuilt.deadLinks.length,
  };
}

export async function runCompile(options: CompileOptions): Promise<CompileSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  await ensureDirs();

  const targets =
    options.targets.length > 0
      ? options.targets.map((target) => target.replace(/\\/g, '/').replace(/^\.\//, ''))
      : options.all
        ? await listRawFiles()
        : [];

  if (targets.length === 0) {
    throw new Error('没有指定素材。用法：pnpm dev compile --all 或 pnpm dev compile raw/foo.md');
  }

  const llm = options.llm ?? createLlmClient();
  await ensureIndex();

  const summary: CompileSummary = {
    compiled: 0,
    skipped: 0,
    planned: 0,
    created: [],
    updated: [],
    llmCalls: 0,
  };

  for (const [position, rawRelPath] of targets.entries()) {
    const prefix = `[${position + 1}/${targets.length}] ${rawRelPath}`;
    const hash = await rawHash(rawRelPath);
    const previous = (await readManifest())[rawRelPath];
    /** hash 变了或加了 --force，就不能沿用上次的 Pass 状态，全部重来 */
    const reusable = !options.force && previous !== undefined && previous.hash === hash;
    const passes: PassState = reusable ? { ...previous.passes } : emptyPassState();
    const appliedOps: string[] = reusable ? [...previous.appliedOps] : [];

    // 必须「每一趟都是 ok」才算已编译。只查 apply 在实践中等价，但只要有人手工改过 manifest、
    // 或以后新增了能在 apply 之后失效的 Pass，就会静默沿用陈旧结果。
    const allPassesOk = PASS_NAMES.every((pass) => passes[pass] === 'ok');
    if (allPassesOk) {
      log(`${prefix} → 已编译且内容未变，跳过`);
      summary.skipped += 1;
      continue;
    }

    // 先把「声称可复用」的 Pass 产物**真正读出来**，日志才不会撒谎：
    // passes.extract 可能是 'ok' 而缓存文件缺失或结构损坏，那样实际仍会重新调用模型。
    // 另外 apply 是纯写入、没有缓存，上游一变就必须重做，不该被列进「复用」。
    const cachedExtract =
      passes.extract === 'ok' ? await readCachedPass(rawRelPath, 'extract', extractSchema) : null;
    const cachedPlan = passes.plan === 'ok' ? await readCachedPass(rawRelPath, 'plan', planSchema) : null;
    const reusablePasses = [cachedExtract === null ? null : 'extract', cachedPlan === null ? null : 'plan'].filter(
      (name): name is string => name !== null,
    );
    log(
      `${prefix} → 编译中…${reusablePasses.length > 0 ? `（续跑：${reusablePasses.join('、')} 复用上次结果）` : ''}`,
    );

    const persist = async (): Promise<void> => {
      if (options.dryRun) return; // dry-run 的承诺是一个字节都不写
      await upsertManifestEntry(rawRelPath, {
        hash,
        compiledAt: passes.apply === 'ok' ? new Date().toISOString() : (previous?.compiledAt ?? ''),
        appliedOps: [...appliedOps],
        passes: { ...passes },
      });
    };

    const saveCache = async (kind: 'extract' | 'plan', value: unknown): Promise<void> => {
      if (options.dryRun) return;
      await writePassCache(passCachePath(kind, rawRelPath), value);
    };

    const rawText = await readRaw(rawRelPath);
    if (rawText.length > MAX_RAW_CHARS) {
      log(`  注意：素材超过 ${MAX_RAW_CHARS} 字，本次只把前 ${MAX_RAW_CHARS} 字交给模型`);
    }

    // ---- Pass 1: extract
    let extract: Extract;
    if (cachedExtract !== null) {
      extract = cachedExtract;
      log('  extract → 复用上次结果，未调用模型');
    } else {
      extract = await trackPass('extract', passes, persist, async () => {
        const result = await extractPass(llm, rawRelPath, rawText);
        await saveCache('extract', result);
        return result;
      });
      log(
        `  extract → 概念 ${extract.concepts.length} · 实体 ${extract.entities.length} · 断言 ${extract.claims.length} · 关系 ${extract.relationHints.length}`,
      );
    }

    // ---- Pass 2: plan
    const index = await readIndex();
    const cards = index?.pages ?? [];
    let ops: Op[];
    if (cachedPlan !== null) {
      ops = cachedPlan.ops;
      log(`  plan    → 复用上次计划（${ops.length} 个操作），未调用模型`);
    } else {
      ops = await trackPass('plan', passes, persist, async () => {
        const result = await planPass(llm, extract, cards, rawRelPath);
        await saveCache('plan', { ops: result });
        return result;
      });
      log(`  plan    → ${ops.map((op) => op.op).join(' · ') || '（空）'}`);
    }
    if (options.dryRun || options.verbose) {
      log(formatPlan(ops).replace(/^/gm, '    '));
    }

    if (options.dryRun) {
      summary.planned += 1;
      continue;
    }

    // ---- Pass 3: apply
    const outcome = await trackPass('apply', passes, persist, async () => {
      const result = await applyPlan({ llm, ops, rawRelPath, extract, rawText, cards, log });
      appliedOps.length = 0;
      appliedOps.push(
        ...result.created.map((id) => `create:${id}`),
        ...result.updated.map((id) => `update:${id}`),
      );
      return result;
    });

    summary.compiled += 1;
    summary.created.push(...outcome.created);
    summary.updated.push(...outcome.updated);
  }

  summary.llmCalls = llm.callCount();
  return summary;
}
