/**
 * Agent 层 —— 把「只读知识库」升级成「可对话、可深挖、可追溯」的接口。
 *
 * 设计要点（对应 doc/AGENT.md）：
 * - **不依赖厂商特性**：工具调用用 ReAct 风格的 prompt + extractJson 解析，
 *   复用 `LlmClient.text()` 与重试/落盘纪律（src/llm.ts），不绑死 function-calling。
 * - **确定性内核 + LLM 只做判断**：所有工具都是对 store/graph/conflict/query 既有纯函数的
 *   薄封装；agent 只决定「调哪个工具、传什么参数」，绝不自己改文件。
 * - **读写为先、写入后置**：本文件只注册只读工具；写入类工具（split/conflict 提案）在
 *   Phase 3 才接，且必须走 apply* 纯函数 + 显式 --apply，沿用既有 dry-run 范式。
 * - **引用可信**：最终答案经 `validateCitations` 校验，所有 [[id]] 必须真实存在。
 */
import { z } from 'zod';
import { extractJson, JSON_ONLY, type LlmClient } from './llm.js';
import { readPage, readRaw } from './store.js';
import { stripAutoBacklinks } from './links.js';
import { analyzeGraph, formatGraphReport } from './graph.js';
import {
  buildConflictSystem,
  buildConflictUser,
  conflictProposalSchema,
  ConflictProposal,
  formatConflictReport,
  parseDisputes,
} from './conflict.js';
import { renderLinkCandidates } from './compile.js';
import { buildSplitSystem, buildSplitUser, isOverLimit, splitProposalSchema, SplitProposal } from './split.js';
import { runQuery, validateCitations } from './query.js';
import type { IndexEntry } from './types.js';

/** 单轮 agent 最多走的步数；超限强制收尾，避免不收敛烧钱 */
export const MAX_AGENT_STEPS = 8;

export interface Tool {
  name: string;
  description: string;
  /** 入参 schema（用 zod 解析，避免模型乱填字段） */
  schema: z.ZodTypeAny;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface AgentStep {
  thought: string;
  action: string;
  actionInput: Record<string, unknown> | null;
  observation: string;
}

export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  /** 答案里指向不存在页面的引用（非空即代表校验失败） */
  citations: string[];
  /** 完整对话记录（每轮 user 消息），供 --chat 多轮累积上下文 */
  transcript: string;
}

interface ParsedAction {
  thought: string;
  action: string;
  actionInput: Record<string, unknown>;
  answer?: string;
}

function parseAction(raw: string): ParsedAction {
  const data = extractJson(raw) as Record<string, unknown>;
  const actionInput =
    data.action_input !== undefined && data.action_input !== null && typeof data.action_input === 'object'
      ? (data.action_input as Record<string, unknown>)
      : {};
  return {
    thought: typeof data.thought === 'string' ? data.thought : '',
    action: typeof data.action === 'string' ? data.action : 'finish',
    actionInput,
    answer: typeof data.answer === 'string' ? data.answer : undefined,
  };
}

/** 把工具清单拼进 system prompt，并写清输出格式与纪律 */
export function buildAgentSystem(tools: readonly Tool[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    '你是这个 wiki 知识库的助手。你可以调用下列工具来检索与核对信息，必要时多步调用，',
    '最后用 action="finish" 给出答案（answer 字段写最终回答）。',
    '',
    '可用工具：',
    list,
    '',
    '每轮只输出一个 JSON：{"thought":"...","action":"工具名 或 finish","action_input":{...},"answer":"最终答案，仅 finish 时需要"}',
    '规则：',
    '- 涉及事实的主张要尽量用 read_source 追到素材原文。',
    '- 涉及不同说法必须先 list_disputes 或读页面 ## 争议，如实呈现矛盾。',
    '- 答案里引用其他页面必须用真实的 [[页面id]]，不要编造 id。',
    '- 需要执行写操作（如拆分、写入矛盾）时，只说明计划、请求用户确认，不要自行修改。',
    JSON_ONLY,
  ].join('\n');
}

/** 注册只读工具集（Phase 0~2）。entries 来自 readIndex()，全程不写盘。 */
export function buildReadOnlyTools(entries: readonly IndexEntry[], llm: LlmClient): Tool[] {
  const byId = new Map(entries.map((e) => [e.id, e]));

  const search_pages: Tool = {
    name: 'search_pages',
    description: '按关键词列出相关页面（id | 类型 | 标题 | 摘要），用于定位要读的页面',
    schema: z.object({ q: z.string().default('') }),
    run: async (args) => {
      const q = String(args.q ?? '').trim().toLowerCase();
      const tokens = q ? q.split(/\s+/) : [];
      const scored = entries
        .map((e) => {
          const hay = [e.id, e.title, e.oneLiner, ...e.aliases, ...e.tags].join(' ').toLowerCase();
          const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
          return { e, score };
        })
        .filter((x) => tokens.length === 0 || x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      if (scored.length === 0) return '没有匹配的页面。';
      return scored.map(({ e }) => `- ${e.id} | ${e.type} | ${e.title} | ${e.oneLiner}`).join('\n');
    },
  };

  const read_page: Tool = {
    name: 'read_page',
    description: '读取某页全文（含「出处」「争议」等小节），id 形如 concepts/xxx',
    schema: z.object({ id: z.string().min(1) }),
    run: async (args) => {
      const id = String(args.id);
      try {
        const page = await readPage(id);
        return stripAutoBacklinks(page.body).slice(0, 6000);
      } catch {
        return `页面不存在：${id}`;
      }
    },
  };

  const read_source: Tool = {
    name: 'read_source',
    description: '溯源到素材原文：传来源页 id（如 sources/xxx），会顺着它的 sources 字段读 raw/ 原文',
    schema: z.object({ ref: z.string().min(1) }),
    run: async (args) => {
      const ref = String(args.ref);
      let rel = ref;
      if (ref.startsWith('sources/') || ref.includes('/')) {
        try {
          const p = await readPage(ref);
          rel = p.meta.sources[0] ?? ref;
        } catch {
          // 当作原始 relPath 直接读
        }
      }
      try {
        const text = await readRaw(rel);
        return `【素材原文 ${rel}】\n${text.slice(0, 4000)}`;
      } catch {
        return `素材读取失败：${rel}`;
      }
    },
  };

  const get_links: Tool = {
    name: 'get_links',
    description: '某页指向了哪些页面（出链）',
    schema: z.object({ id: z.string().min(1) }),
    run: async (args) => {
      const e = byId.get(String(args.id));
      if (!e) return '页面不存在';
      return e.outLinks.length ? e.outLinks.join('\n') : '（无出链）';
    },
  };

  const get_backlinks: Tool = {
    name: 'get_backlinks',
    description: '哪些页面指向了某页（入链 / 依赖关系）',
    schema: z.object({ id: z.string().min(1) }),
    run: async (args) => {
      const e = byId.get(String(args.id));
      if (!e) return '页面不存在';
      return e.inLinks.length ? e.inLinks.join('\n') : '（无入链）';
    },
  };

  const find_path: Tool = {
    name: 'find_path',
    description: '两页之间通过 wikilink 的最短路径（a、b 为页面 id）',
    schema: z.object({ a: z.string().min(1), b: z.string().min(1) }),
    run: async (args) => {
      const a = String(args.a);
      const b = String(args.b);
      if (!byId.has(a) || !byId.has(b)) return '起点或终点不存在';
      if (a === b) return a;
      const adj = new Map(entries.map((e) => [e.id, e.outLinks]));
      const prev = new Map<string, string>();
      const queue: string[] = [a];
      const seen = new Set([a]);
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        if (cur === b) break;
        for (const nxt of adj.get(cur) ?? []) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            prev.set(nxt, cur);
            queue.push(nxt);
          }
        }
      }
      if (!prev.has(b)) return `无路径：${a} → ${b}`;
      const path = [b];
      let c = b;
      while (c !== a) {
        c = prev.get(c) as string;
        path.unshift(c);
      }
      return path.join(' → ');
    },
  };

  const list_disputes: Tool = {
    name: 'list_disputes',
    description: '离线列出所有已记录的「争议」小节（矛盾）',
    schema: z.object({}),
    run: async () => {
      const items: { id: string; disputes: string }[] = [];
      for (const e of entries) {
        try {
          const page = await readPage(e.id);
          const d = parseDisputes(page.body);
          if (d) items.push({ id: e.id, disputes: d });
        } catch {
          // 跳过读不到的页面
        }
      }
      return formatConflictReport(items);
    },
  };

  const graph_stats: Tool = {
    name: 'graph_stats',
    description: '连通性 / 超级节点 / 孤立页等图统计',
    schema: z.object({}),
    run: async () => formatGraphReport(analyzeGraph(entries)),
  };

  const ask: Tool = {
    name: 'ask',
    description: '用内置 RAG 快速回答一个子问题（自动选页+作答）',
    schema: z.object({ q: z.string().min(1) }),
    run: async (args) => {
      const r = await runQuery({
        question: String(args.q),
        llm,
        skipIndex: true,
        index: { pages: entries as IndexEntry[], generatedAt: new Date().toISOString() },
      });
      return `【RAG 答案】${r.answer}\n【引用】${r.selectedIds.join(', ')}`;
    },
  };

  return [search_pages, read_page, read_source, get_links, get_backlinks, find_path, list_disputes, graph_stats, ask];
}

/**
 * 写入类工具（Phase 3，默认关闭）。
 * 严守项目纪律：只「产出计划」、绝不静默落盘——落盘走 split/conflict 既有 CLI 命令。
 * 这样 Agent 永远不自己改文件，避免模型「顺手」改坏知识库。
 */
export function buildWriteTools(entries: readonly IndexEntry[], llm: LlmClient): Tool[] {
  const propose_split: Tool = {
    name: 'propose_split',
    description: '把超过字数上限的页面拆成「枢纽页+子主题页」的计划（只产出计划，落盘需另跑 pnpm dev split）',
    schema: z.object({ id: z.string().min(1), limit: z.coerce.number().int().positive().default(400) }),
    run: async (args) => {
      const id = String(args.id);
      const page = await readPage(id).catch(() => null);
      if (page === null) return `页面不存在：${id}`;
      const limit = Number(args.limit);
      if (!isOverLimit(page.body, limit)) return `页面未超过字数上限（${limit} 字），无需拆分：${id}`;
      const proposal: SplitProposal = await llm.structured({
        tag: `agent-split-${id.replace(/\W+/g, '-')}`,
        system: await buildSplitSystem(),
        user: await buildSplitUser(page, limit, renderLinkCandidates(entries, [], id)),
        schema: splitProposalSchema,
      });
      const subs = proposal.subpages.map((s) => `- ${s.title}（slug: ${s.slug}）：${s.oneLiner}`).join('\n');
      return `【拆分计划】${id}\n枢纽概述：${proposal.hubIntro}\n子页：\n${subs}\n（如需落盘，请运行 pnpm dev split）`;
    },
  };

  const propose_conflict: Tool = {
    name: 'propose_conflict',
    description: '扫描某页引用的多份素材，找出隐藏矛盾（只产出计划，落盘需 pnpm dev conflict --detect --apply）',
    schema: z.object({ id: z.string().min(1) }),
    run: async (args) => {
      const id = String(args.id);
      const page = await readPage(id).catch(() => null);
      if (page === null) return `页面不存在：${id}`;
      const sourceTexts: { id: string; text: string }[] = [];
      for (const ref of page.meta.sources) {
        const text = await readRaw(ref).catch(() => null);
        if (text !== null) sourceTexts.push({ id: ref, text });
      }
      const proposal: ConflictProposal = await llm.structured({
        tag: `agent-conflict-${id.replace(/\W+/g, '-')}`,
        system: await buildConflictSystem(),
        user: await buildConflictUser(page, sourceTexts),
        schema: conflictProposalSchema,
      });
      if (proposal.conflicts.length === 0) return `未发现矛盾：${id}`;
      const lines = proposal.conflicts
        .map((c) => `- ${c.topic}：${c.viewA}（${c.sourceA}） vs ${c.viewB}（${c.sourceB}）`)
        .join('\n');
      return `【矛盾计划】${id}\n${lines}\n（如需落盘，请运行 pnpm dev conflict --detect --apply）`;
    },
  };

  return [propose_split, propose_conflict];
}

export interface RunAgentOptions {
  question: string;
  llm: LlmClient;
  tools: Tool[];
  /** 页面清单：构造链接候选 / 写入类工具时用 */
  entries: readonly IndexEntry[];
  /** 用于引用校验的已知页面 id 集合 */
  knownIds: ReadonlySet<string>;
  /** 多轮对话时，上一轮的对话记录（作为本轮起点） */
  seedTranscript?: string;
  maxSteps?: number;
  /** 是否启用写入类工具（propose_split / propose_conflict）。默认 false，保持只读 */
  allowWrite?: boolean;
}

/**
 * ReAct 主循环：把整段对话塞进「一个 user 消息」里反复喂给 llm.text()，
 * 每轮解析出 action → 跑工具 → 把 observation 拼回 transcript，直到 finish 或步数耗尽。
 * 这样无需改动 LlmClient（它只支持单 system+user），且重试/落盘纪律完全复用。
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { question, llm, entries, knownIds } = options;
  const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;
  const tools = options.allowWrite
    ? [...options.tools, ...buildWriteTools(entries, llm)]
    : options.tools;
  const system = buildAgentSystem(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const intro = `【用户问题】\n${question}\n\n请先思考，再决定调用哪个工具，或 action="finish" 给出答案。`;
  let transcript = options.seedTranscript ? `${options.seedTranscript}\n\n${intro}` : intro;

  const steps: AgentStep[] = [];
  let answer = '';

  for (let i = 0; i < maxSteps; i += 1) {
    const raw = await llm.text({ tag: 'agent', system, user: transcript });
    const parsed = parseAction(raw);

    if (parsed.action === 'finish') {
      answer = parsed.answer ?? parsed.thought;
      steps.push({ thought: parsed.thought, action: 'finish', actionInput: null, observation: '' });
      break;
    }

    const tool = toolMap.get(parsed.action);
    let observation: string;
    if (!tool) {
      observation = `未知工具「${parsed.action}」。可用工具：${tools.map((t) => t.name).join(', ')}`;
    } else {
      try {
        const args = tool.schema.parse(parsed.actionInput) as Record<string, unknown>;
        observation = await tool.run(args);
      } catch (error) {
        observation = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    steps.push({
      thought: parsed.thought,
      action: parsed.action,
      actionInput: parsed.actionInput,
      observation,
    });

    transcript +=
      `\n\n【你的上次输出】\n${raw}\n【工具 ${parsed.action} 返回】\n${observation}` +
      `\n\n请继续（再调工具，或 action="finish" 给最终答案）。`;

    if (i === maxSteps - 1) {
      answer = `（未在 ${maxSteps} 步内得出结论）最后得到的线索：\n${observation}`;
    }
  }

  return {
    answer,
    steps,
    citations: validateCitations(answer, knownIds),
    transcript,
  };
}
