import { z } from 'zod';

/** 页面类型枚举，必须与 schema/taxonomy.md 保持一致 */
export const PAGE_TYPES = ['source', 'concept', 'entity'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** type → wiki/ 下的目录名 */
export const TYPE_DIRS: Record<PageType, string> = {
  source: 'sources',
  concept: 'concepts',
  entity: 'entities',
};

/** wiki/ 下的目录名 → type（解析 id 前缀用） */
export const DIR_TO_TYPE: Record<string, PageType> = {
  sources: 'source',
  concepts: 'concept',
  entities: 'entity',
};

/** 本地日期字符串。不要用 toISOString——那是 UTC，东八区凌晨会算成前一天。 */
export function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today(date: Date = new Date()): string {
  return formatDate(date);
}

/**
 * frontmatter 契约。
 * 字段顺序 = 落盘顺序，改动会污染所有页面的 diff，别随意调整。
 */
export const pageMetaSchema = z.object({
  id: z.string().min(1),
  type: z.enum(PAGE_TYPES),
  title: z.string().min(1),
  oneLiner: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  // 手写页面容易漏引号：YAML 里裸的 2026-10-12 会被解析成 Date，这里统一收敛为字符串
  updated: z
    .union([z.string(), z.date()])
    .transform((value) => (value instanceof Date ? formatDate(value) : value))
    .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), 'updated 必须是 YYYY-MM-DD'),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

/** 一个 wiki 页面：frontmatter + 正文（正文含反向链接区块，由 reindex 维护） */
export interface Page {
  meta: PageMeta;
  body: string;
  /**
   * frontmatter 里 schema 未声明的字段，原样保留。
   * 不保留的话，用户手加的字段会在下一次 reindex 时被静默抹掉——这种丢数据最难排查。
   */
  extraMeta?: Record<string, unknown>;
}

/** Pass 1 产物：对单份原素材的结构化抽取。LLM 直接产出这个结构，故用 zod 定义并以它为准。 */
export const extractSchema = z.object({
  /** 素材标题，用作 source 摘要页的标题 */
  title: z.string().min(1),
  /** 这份素材在讲什么，10~20 字 */
  oneLiner: z.string().min(1),
  summary: z.string().min(1),
  /** 带事实的断言，供 plan 判断该写进哪个页面 */
  claims: z.array(z.string()),
  entities: z.array(z.object({ name: z.string().min(1), kind: z.string(), evidence: z.string() })),
  concepts: z.array(
    z.object({ name: z.string().min(1), definition: z.string(), evidence: z.string() }),
  ),
  relationHints: z.array(
    z.object({ from: z.string().min(1), to: z.string().min(1), relation: z.string() }),
  ),
});
export type Extract = z.infer<typeof extractSchema>;

/**
 * Pass 2 产物：单个操作。
 * 判别联合，不要合并成一个带可选字段的大接口——否则 switch 会失去穷尽性检查。
 */
export const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    type: z.enum(PAGE_TYPES),
    title: z.string().min(1),
    oneLiner: z.string().min(1),
    slug: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    op: z.literal('update'),
    targetId: z.string().min(1),
    patch: z.string().min(1),
    reason: z.string(),
  }),
  z.object({ op: z.literal('link'), fromId: z.string().min(1), toId: z.string().min(1), reason: z.string() }),
  z.object({ op: z.literal('noop'), reason: z.string() }),
]);
export type Op = z.infer<typeof opSchema>;

/** 用对象包一层而不是裸数组：模型对 { "ops": [...] } 的遵循度明显更高 */
export const planSchema = z.object({ ops: z.array(opSchema) });
export type Plan = z.infer<typeof planSchema>;

/** Pass 3 产物：页面正文草稿（frontmatter 由程序装配，不让模型碰） */
export const pageDraftSchema = z.object({
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
});
export type PageDraft = z.infer<typeof pageDraftSchema>;

/** query 阶段的选页结果 */
export const selectionSchema = z.object({
  ids: z.array(z.string()),
  reason: z.string().default(''),
});
export type Selection = z.infer<typeof selectionSchema>;

export interface IndexEntry {
  id: string;
  type: PageType;
  title: string;
  oneLiner: string;
  /** 供 plan 判定「这就是同一个页面」；缺了它，rules.md 里「别名命中必须 update」那条规则无法执行 */
  aliases: string[];
  tags: string[];
  outLinks: string[];
  inLinks: string[];
  updated: string;
}

export interface WikiIndex {
  pages: IndexEntry[];
  generatedAt: string;
}

export const PASS_NAMES = ['extract', 'plan', 'apply'] as const;
export type PassName = (typeof PASS_NAMES)[number];

/** 每个 Pass 的终态：'ok' | 'pending' | 'failed: 原因' */
export type PassState = Record<PassName, string>;

export interface ManifestEntry {
  hash: string;
  compiledAt: string;
  /** 审计线索：这份素材改过哪些页面 */
  appliedOps: string[];
  passes: PassState;
}

/** 键是原材料相对项目根的路径，如 "raw/llm-wiki-intro.md" */
export type Manifest = Record<string, ManifestEntry>;

export function emptyPassState(): PassState {
  return { extract: 'pending', plan: 'pending', apply: 'pending' };
}

export function isPassOk(state: PassState, pass: PassName): boolean {
  return state[pass] === 'ok';
}

/** 'concepts/rag' → 'concepts' 对应的 PageType；未知前缀返回 null */
export function typeOfId(id: string): PageType | null {
  const prefix = id.split('/')[0] ?? '';
  return DIR_TO_TYPE[prefix] ?? null;
}

export function idPrefix(type: PageType): string {
  return TYPE_DIRS[type];
}

export function byTypeCounts(types: readonly PageType[]): Record<PageType, number> {
  const counts: Record<PageType, number> = { source: 0, concept: 0, entity: 0 };
  for (const t of types) counts[t] += 1;
  return counts;
}
