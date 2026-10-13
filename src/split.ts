/**
 * 页面拆分：把超过字数上限的页面拆成「枢纽页 + 若干子主题页」。
 *
 * 设计取舍（与 repair 同风格——显式命令、可 dry-run、核心逻辑是纯函数）：
 * - 拆分是**有损风险**操作（要把长正文切开、改写出链），所以做成 `pnpm dev split` 让用户主动触发，
 *   不塞进 reindex 自动跑；`--dry-run` 可先看哪些页会被拆。
 * - LLM 只负责「切成哪些子主题、各自写什么」这种高判断力的活；
 *   **链接重写（枢纽链子页、子页回链枢纽、死链修复）由程序确定性完成**，不交给模型，避免造出死链。
 * - 枢纽页保留原页的标题/别名/标签/出处，只把长正文换成「简短概述 + 子主题列表 + 原出链」，
 *   因此其它页面指向原 id 的链接依然有效（它们本来就是指这个大主题）。
 * - source 类型不参与拆分：它是一份素材的摘要页，拆成子摘要页语义不成立。
 */
import { z } from 'zod';
import { loadRules, loadTemplate } from './schema.js';
import { JSON_ONLY } from './llm.js';
import { parseLinks, parseOwnLinks, repairDeadLinks, stripAutoBacklinks } from './links.js';
import { type Page, type PageMeta } from './types.js';

/** 默认字数上限：与 apply 阶段对单页「不超过 400 字」的约定一致 */
export const DEFAULT_SPLIT_LIMIT = 400;

/**
 * 字数统计：中文按字符数、英文/数字按词数，二者相加近似「字数」。
 * 统计前剥掉自动反向链接区块与代码块——它们不是正文内容，不应计入上限。
 */
export function countChars(text: string): number {
  const stripped = stripAutoBacklinks(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const cjk = (stripped.match(/[一-鿿]/g) ?? []).length;
  const words = (stripped.match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + words;
}

export function isOverLimit(body: string, limit: number = DEFAULT_SPLIT_LIMIT): boolean {
  return countChars(body) > limit;
}

export interface SplitSubProposal {
  slug: string;
  title: string;
  oneLiner: string;
  body: string;
}
export interface SplitProposal {
  hubIntro: string;
  subpages: SplitSubProposal[];
}
/** LLM 输出契约：枢纽概述 + 2~6 个子页（子页类型继承父页，所以 schema 里不再让模型选 type） */
export const splitProposalSchema = z.object({
  hubIntro: z.string().min(1),
  subpages: z
    .array(
      z.object({
        slug: z.string().min(1),
        title: z.string().min(1),
        oneLiner: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .min(2)
    .max(6),
});

export interface SplitOptions {
  /** 拆分前已知的全部页面 id（用于死链校验） */
  knownIds: ReadonlySet<string>;
  /** 已由调用方用 nextFreeId 分配好的子页 id，与 proposal.subpages 一一对应 */
  subIds: string[];
  /** 死链就近解析（可选，复用 repair 的 canonicalTitleKey 逻辑）；不传则死链只告警不修 */
  resolve?: (id: string) => string | null;
  today?: string;
}

export interface SplitResult {
  hub: Page;
  subpages: Page[];
  warnings: string[];
}

/**
 * 把 LLM 的拆分提案落实成页面。纯函数——不碰磁盘、不调 LLM，方便单测。
 * 链接重写在这里确定性完成：
 *   - 每个子页若没链回枢纽，补一句「隶属主题：[[枢纽id]]」；
 *   - 子页里的死链用 resolve 修复，修不了的记进 warnings；
 *   - 枢纽页 = 概述 + 子主题链接列表 + 原页出链（保证图连通不丢）。
 */
export function applySplit(page: Page, proposal: SplitProposal, opts: SplitOptions): SplitResult {
  const parentId = page.meta.id;
  const type = page.meta.type;
  const todayStr = opts.today ?? new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];

  if (proposal.subpages.length !== opts.subIds.length) {
    throw new Error(
      `子页数量不一致：提案 ${proposal.subpages.length} 个，已分配 id ${opts.subIds.length} 个`,
    );
  }

  const idSet = new Set<string>([...opts.knownIds, parentId, ...opts.subIds]);

  const subpages: Page[] = proposal.subpages.map((sub, i) => {
    const subId = opts.subIds[i]!;
    let body = sub.body;

    // 回链枢纽：正文未链接父页则补一句
    if (!parseLinks(body).includes(parentId)) {
      body = `${body.replace(/\s+$/, '')}\n\n隶属主题：[[${parentId}]]`;
    }

    // 死链修复（有 resolve 才修，否则保留并告警）
    const repaired = repairDeadLinks(body, (x) => idSet.has(x), (id) => opts.resolve?.(id) ?? null);
    for (const u of repaired.unrepaired) warnings.push(`${subId}：无法修复的死链 ${u}`);
    body = repaired.body;

    const meta: PageMeta = {
      id: subId,
      type,
      title: sub.title,
      oneLiner: sub.oneLiner,
      aliases: [],
      tags: page.meta.tags,
      sources: page.meta.sources,
      updated: todayStr,
    };
    if (isOverLimit(body, DEFAULT_SPLIT_LIMIT)) {
      warnings.push(`${subId}：拆分后正文仍超过字数上限`);
    }
    return { meta, body };
  });

  // 枢纽页：保留原页的元信息，正文换成概述 + 子主题 + 原出链
  const originalOut = parseOwnLinks(page.body).filter((l) => !opts.subIds.includes(l));
  const subBullets = proposal.subpages
    .map((sub, i) => `- [[${opts.subIds[i]}|${sub.title}]]`)
    .join('\n');
  const relatedBullets = originalOut.map((l) => `- [[${l}]]`).join('\n');

  const parts: string[] = [];
  parts.push(proposal.hubIntro.trim());
  parts.push('## 子主题');
  parts.push('');
  parts.push(subBullets);
  if (relatedBullets !== '') {
    parts.push('## 相关');
    parts.push('');
    parts.push(relatedBullets);
  }
  const hubBody = parts.join('\n');

  const hub: Page = {
    meta: { ...page.meta, updated: todayStr },
    body: hubBody,
    ...(page.extraMeta === undefined ? {} : { extraMeta: page.extraMeta }),
  };

  return { hub, subpages, warnings };
}

/** 拆分提示词（system）：规则 + 任务说明 + JSON 输出约定 */
export async function buildSplitSystem(): Promise<string> {
  return [
    await loadRules(),
    '',
    '# 任务',
    '你要把一个过长（超过约定字数）的 wiki 页面拆成若干「子主题页」，原页面变成枢纽（索引）页。',
    '每个子页必须是自包含、可独立理解的小主题；枢纽页只放简短概述 + 指向子页的链接。',
    JSON_ONLY,
  ].join('\n');
}

/** 拆分提示词（user）：把页面现状、可链接清单、模板、约束都给齐 */
export async function buildSplitUser(page: Page, limit: number, linkCandidates: string): Promise<string> {
  const template = await loadTemplate(page.meta.type);
  return [
    `页面 id：${page.meta.id}`,
    `页面标题：${page.meta.title}`,
    `字数上限：${limit}（当前正文已超，必须拆分）`,
    '',
    '【可链接的页面 id（子页与枢纽只能链接这些，禁止编造 id、禁止链接 raw/ 文件）】',
    linkCandidates,
    '',
    '【页面模板】',
    template,
    '',
    '【原页面正文（完整）】',
    stripAutoBacklinks(page.body),
    '',
    '【要求】',
    '- 输出 JSON：{ "hubIntro": "枢纽页的简短概述（≤80字）", "subpages": [ { "slug", "title", "oneLiner", "body" } ] }',
    '- subpages 至少 2 个、至多 6 个；每个 body 严格按上面模板结构组织，且自身不超过字数上限。',
    `- 每个子页都要在正文里链接回枢纽页 id（[[${page.meta.id}]]）。`,
    '- 子页的 slug 用简短英文或拼音（会出现在链接里，保持可读）。',
    '- 子页 body 的链接只能来自上面清单；不得新增模板之外的章节。',
    '- 只输出 JSON，不要解释、不要代码围栏。',
  ].join('\n');
}
