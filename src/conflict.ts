/**
 * 冲突检测：不同素材对同一概念/实体给出矛盾说法时，把它们显式记录在「争议」小节。
 *
 * 设计取舍（与 repair/split 同风格——核心纯函数、显式命令、离线与 LLM 两用）：
 * - 跨素材矛盾是**事后**现象：每页是逐份素材编译的，单趟编译看不到别的素材，
 *   所以检测放在独立的 `conflict` 命令里，用 LLM 比对「页面 + 它引用的全部素材原文」。
 * - 页面模板加了可选「争议」小节；LLM 只负责判断「是否真矛盾 + 怎么写」，
 *   写入/替换「争议」小节由纯函数 applyConflicts 确定性完成（不交给模型，避免破坏结构、避免凭空造链）。
 * - source 类型是素材摘要页，本身不该有「争议」小节，命令会跳过。
 */
import { z } from 'zod';
import { loadRules } from './schema.js';
import { JSON_ONLY } from './llm.js';
import { stripAutoBacklinks } from './links.js';
import { type Page, today } from './types.js';

const DISPUTE_HEADING = '## 争议';
const BACKLINK_SENTINEL = '<!-- AUTO-BACKLINKS -->';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 抽出正文里某个 `## 标题` 小节的正文（到下一个 ## 或反向链接哨兵为止）。无或为空则 null。 */
export function parseSection(body: string, heading: string): string | null {
  const name = heading.trim().replace(/^##\s*/, '');
  const re = new RegExp(`^##\\s+${escapeRe(name)}\\s*$`, 'm');
  const lines = stripAutoBacklinks(body).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i] ?? '')) break;
    out.push(lines[i] ?? '');
  }
  const text = out.join('\n').trim();
  return text === '' ? null : text;
}

/** 取页面的「争议」小节内容；没有、为空、或只是「无/无矛盾」这类占位符时返回 null。 */
export function parseDisputes(body: string): string | null {
  const text = parseSection(body, DISPUTE_HEADING);
  if (text === null) return null;
  const norm = text.replace(/[（）\s]/g, '');
  if (norm === '' || /^无[矛盾冲突]*$/.test(norm) || norm === '暂无' || norm.toLowerCase() === 'none') {
    return null;
  }
  return text;
}

export function hasDisputes(body: string): boolean {
  return parseDisputes(body) !== null;
}

/** 在正文里写入/替换一个 `## 标题` 小节；若原无该小节则插到反向链接哨兵之前（没有哨兵则追加到末尾）。 */
export function setSection(body: string, heading: string, content: string): string {
  const name = heading.trim().replace(/^##\s*/, '');
  const headingLine = `## ${name}`;
  const block = `${headingLine}\n\n${content.trim()}\n`;
  const re = new RegExp(
    `^##\\s+${escapeRe(name)}\\s*$[\\s\\S]*?(?=^##\\s+|^${escapeRe(BACKLINK_SENTINEL)})`,
    'm',
  );
  if (re.test(body)) {
    return body.replace(re, block.trimEnd() + '\n');
  }
  if (body.includes(BACKLINK_SENTINEL)) {
    return body.replace(BACKLINK_SENTINEL, `${block}\n${BACKLINK_SENTINEL}`);
  }
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}

export interface ConflictEntry {
  id: string;
  disputes: string;
}

/** 把已记录的争议渲染成可读报告（离线、纯函数）。 */
export function formatConflictReport(items: ConflictEntry[]): string {
  if (items.length === 0) {
    return '未发现已记录的争议：所有页面的「争议」小节均为空或不存在。';
  }
  const lines: string[] = [`发现 ${items.length} 个页面存在已记录的争议：`, ''];
  for (const it of items) {
    lines.push(`### ${it.id}`);
    lines.push(it.disputes);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// --------------------------------------------------------------- LLM 契约与提示词

export interface ConflictItem {
  topic: string;
  viewA: string;
  sourceA: string;
  viewB: string;
  sourceB: string;
}
export interface ConflictProposal {
  conflicts: ConflictItem[];
}
/** LLM 输出契约：一组确凿矛盾（无矛盾则为空数组） */
export const conflictProposalSchema = z.object({
  conflicts: z
    .array(
      z.object({
        topic: z.string().min(1),
        viewA: z.string().min(1),
        sourceA: z.string().min(1),
        viewB: z.string().min(1),
        sourceB: z.string().min(1),
      }),
    )
    .default([]),
});

export async function buildConflictSystem(): Promise<string> {
  return [
    await loadRules(),
    '',
    '# 任务',
    '你要在给定 wiki 页面与其引用的多份素材原文之间，判断是否存在**真正的矛盾**——即对同一事实/定义给出互斥的说法。',
    '只报告确凿的矛盾；不要报告「表述不同但意思一致」或「补充信息」，那不是冲突。',
    JSON_ONLY,
  ].join('\n');
}

export async function buildConflictUser(
  page: Page,
  sourceTexts: { id: string; text: string }[],
): Promise<string> {
  const srcBlock = sourceTexts.map((s) => `### 素材 ${s.id}\n\n${s.text}`).join('\n\n');
  return [
    `页面 id：${page.meta.id}`,
    `页面标题：${page.meta.title}`,
    '',
    '【页面当前正文（完整，已剥反向链接）】',
    stripAutoBacklinks(page.body),
    '',
    '【该页面引用的素材原文】',
    srcBlock,
    '',
    '【要求】',
    '- 逐条比较：若两份及以上素材（或素材与页面既有内容）对同一事实给出互斥说法，记为一条冲突。',
    '- 每条冲突输出：topic（争议点）、viewA/viewB（两种互斥说法，尽量贴近原文措辞）、sourceA/sourceB（分别引自哪个素材 id）。',
    '- 没有矛盾时输出空数组。',
    '- 只输出 JSON，不要解释、不要代码围栏。',
  ].join('\n');
}

/**
 * 把 LLM 的冲突提案落实进页面。纯函数。
 * - 没有任何冲突时原样返回（不改动、不清除已有争议）。
 * - 有冲突时写入/替换「争议」小节，并更新 updated 日期。
 */
export function applyConflicts(page: Page, proposal: ConflictProposal, todayStr?: string): Page {
  if (proposal.conflicts.length === 0) return page;
  const bullets = proposal.conflicts
    .map(
      (c) =>
        `- **${c.topic}**：${c.viewA}（引自 ${c.sourceA}）；另一种说法：${c.viewB}（引自 ${c.sourceB}）。`,
    )
    .join('\n');
  const newBody = setSection(page.body, DISPUTE_HEADING, bullets);
  return { ...page, body: newBody, meta: { ...page.meta, updated: todayStr ?? today() } };
}
