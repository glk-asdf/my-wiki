/**
 * 问答流水线 —— 与 compile 构成设计上的对照面。
 *
 * 刻意**不走向量检索**：选页靠的是「拿卡片列表让模型挑」这种自然语言做的元数据检索。
 * 它比不上向量检索的召回率，但它展示的是另一件事——当知识已经被编译成
 * 带一句话摘要的结构化页面之后，检索这个问题本身被简化了。
 * 这就是 DESIGN §5 里「成本主要集中在初次编译」的代码形态。
 *
 * 两次 LLM 调用：选页、生成答案。中间那段「读全文 + 一跳邻居」是纯计算。
 */
import { parseOwnLinks } from './links.js';
import { JSON_ONLY, createLlmClient, type LlmClient } from './llm.js';
import { ensureIndex } from './reindex.js';
import { loadQueryRules } from './schema.js';
import { readIndex, readPage } from './store.js';
import { selectionSchema, type IndexEntry, type Selection } from './types.js';

/** 一次最多喂给模型的页面数。由程序强制执行，不依赖模型自觉 */
export const MAX_SELECTED_PAGES = 8;

/** 覆盖不了问题时给的原话：宁可说没有，也不让模型拿常识去补 */
export const NO_COVERAGE_ANSWER = 'wiki 中未收录：现有页面里没有能支撑这个问题的内容。';

export interface QueryOptions {
  question: string;
  verbose?: boolean;
  /** 注入用（测试/离线冒烟）；不传则按环境变量建真实客户端 */
  llm?: LlmClient;
  log?: (line: string) => void;
}

export interface QueryResult {
  answer: string;
  selectedIds: string[];
  selectionReason: string;
  /** 答案里指向不存在页面的引用（非空即代表校验失败） */
  badCitations: string[];
  llmCalls: number;
}

/** 答案里出现的引用 id（去重、保持顺序） */
export function citationsOf(answer: string): string[] {
  return parseOwnLinks(answer);
}

/** 返回答案中指向未知页面的引用；这个函数就是「引用可信」那条验收标准的实现 */
export function validateCitations(answer: string, known: ReadonlySet<string>): string[] {
  return citationsOf(answer).filter((id) => !known.has(id));
}

function renderCards(cards: readonly IndexEntry[]): string {
  return cards
    .map((card) => `- ${card.id} | ${card.type} | ${card.title} | ${card.oneLiner}`)
    .join('\n');
}

async function selectPass(
  llm: LlmClient,
  question: string,
  cards: readonly IndexEntry[],
): Promise<Selection> {
  return llm.structured({
    tag: 'select',
    system: [
      '你是检索器，**只负责从给定列表里挑出与问题相关的页面 id**，不要回答问题，不要编造 id。',
      JSON_ONLY,
      '输出的顶层结构固定为 {"ids":[...],"reason":"..."}。',
      '拿不准就少选：选错页面会让后面的答案带上无关内容，比漏选更糟。',
    ].join('\n'),
    user: [
      '【wiki 页面清单】(id | 类型 | 标题 | 一句话摘要)',
      renderCards(cards),
      '',
      '【问题】',
      question,
      '',
      '只输出与你判断相关的页面 id（最多几个即可）。若清单里没有任何页面能支撑这个问题，返回空的 ids 数组。',
    ].join('\n'),
    schema: selectionSchema,
  });
}

async function answerPass(llm: LlmClient, question: string, context: string): Promise<string> {
  const rules = await loadQueryRules();
  return llm.text({
    tag: 'answer',
    system: rules,
    user: [`【可用的 wiki 页面】`, context, '', '【问题】', question].join('\n'),
  });
}

/** 把选中页面的全文与它们一跳邻居的一句话摘要拼成上下文 */
function renderContext(
  selected: readonly IndexEntry[],
  pages: ReadonlyMap<string, { body: string }>,
  byId: ReadonlyMap<string, IndexEntry>,
): string {
  const selectedIds = new Set(selected.map((card) => card.id));
  return selected
    .map((card) => {
      const neighbors = [...new Set([...card.outLinks, ...card.inLinks])]
        .filter((id) => !selectedIds.has(id) && byId.has(id))
        .map((id) => `${id} — ${byId.get(id)?.oneLiner ?? ''}`);

      const head = [`### id: ${card.id}`, `标题：${card.title}`];
      if (neighbors.length > 0) {
        head.push(`一跳邻居（只给摘要，需要时可在答案里引用）：${neighbors.join(' ｜ ')}`);
      }
      // 别用 filter 去空行：那会把「正文之前的那个空行」一起吃掉，
      // 于是正文的 ## 小节紧贴在元信息后面，模型更难分清哪里是元信息、哪里是原文
      return [...head, '', pages.get(card.id)?.body ?? ''].join('\n');
    })
    .join('\n\n---\n\n');
}

export async function runQuery(options: QueryOptions): Promise<QueryResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const question = options.question.trim();
  if (question === '') {
    throw new Error('问题不能为空。用法：pnpm dev query "LLM Wiki 和 RAG 有什么区别？"');
  }

  await ensureIndex();
  const index = await readIndex();
  const cards = index?.pages ?? [];

  // wiki 是空的：不必花钱调模型，直说没有
  if (cards.length === 0) {
    log('wiki 当前没有任何页面（先跑 pnpm dev compile --all）');
    return { answer: NO_COVERAGE_ANSWER, selectedIds: [], selectionReason: '', badCitations: [], llmCalls: 0 };
  }

  const llm = options.llm ?? createLlmClient();
  const byId = new Map(cards.map((card) => [card.id, card]));
  const known = new Set(byId.keys());

  // ① 选页：模型给候选，程序做过滤与截断——「≤ 8 页」这条约束不能交给模型自觉
  const selection = await selectPass(llm, question, cards);
  const selectedIds = selection.ids.filter((id) => known.has(id)).slice(0, MAX_SELECTED_PAGES);
  // 选页这一步允许被丢弃的 id 只做日志，不算校验失败
  const dropped = selection.ids.filter((id) => !known.has(id));
  if (dropped.length > 0) log(`选页忽略了不存在的 id：${dropped.join(', ')}`);

  // ② 选页为空 → 不退回「拿全部页面」，直接给未收录的结论
  if (selectedIds.length === 0) {
    log(`选页为空（模型理由：${selection.reason || '未给出'}）→ 直接回答「wiki 中未收录」`);
    return {
      answer: NO_COVERAGE_ANSWER,
      selectedIds: [],
      selectionReason: selection.reason,
      badCitations: [],
      llmCalls: llm.callCount(),
    };
  }

  log(`选中 ${selectedIds.length} 个页面：${selectedIds.join(', ')}`);
  if (options.verbose) log(`  选页理由：${selection.reason}`);

  const selected = selectedIds.map((id) => byId.get(id)).filter((card): card is IndexEntry => card !== undefined);
  const pages = new Map<string, { body: string }>();
  for (const id of selectedIds) pages.set(id, { body: (await readPage(id)).body });

  // ③ 生成答案
  const answer = (await answerPass(llm, question, renderContext(selected, pages, byId))).trim();
  // 空答案绝不能当成「通过了引用校验」混过去：它可能是内容被拦、响应被截断，
  // 或是模型把答案放进了别的字段。落盘的原始响应能直接说明是哪种。
  if (answer === '') {
    throw new Error(
      '模型返回了空答案。原始响应已落盘到 .state/passes/answer-*.json——' +
        '先打开看它到底回了什么（内容被拦 / 思考型模型把答案放进了 reasoning_content / 被截断），再决定重试还是换模型。',
    );
  }

  // ④ 引用校验：所有 [[id]] 必须真实存在，否则命令以非 0 退出
  const badCitations = validateCitations(answer, known);
  if (badCitations.length > 0) {
    log(`引用校验失败：答案里出现了不存在的页面 id → ${badCitations.join(', ')}`);
  }

  return {
    answer,
    selectedIds,
    selectionReason: selection.reason,
    badCitations,
    llmCalls: llm.callCount(),
  };
}
