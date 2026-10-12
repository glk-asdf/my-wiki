/**
 * wikilink 解析与反向链接区块维护。
 * 这是全项目唯一需要「小心写」的纯函数集合，配套 tests/links.test.ts。
 */

export const BACKLINKS_SENTINEL = '<!-- AUTO-BACKLINKS -->';
export const BACKLINKS_HEADING = '## 反向链接';

const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** 去掉代码块与行内代码，避免把示例里的 [[x]] 当成真链接 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** 归一化链接目标：去空白、去前导斜杠、去 .md 后缀、压掉重复斜杠 */
export function normalizeLinkId(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\/{2,}/g, '/');
}

/** 抽出正文里的全部链接 id：去重、保持出现顺序 */
export function parseLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of stripCode(body).matchAll(LINK_RE)) {
    const id = normalizeLinkId(match[1] ?? '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 解析「页面自己的」出链。**必须先把反向链接区块剥掉**：
 * 那个区块里写的是别人的链接，如果当成自己的出链解析，就会形成
 * 「我的入链 → 我的出链 → 对方的入链」的反馈环，链接图越算越错且永不收敛。
 * 所有分析页面链接的地方都要用这个函数，不要直接用 parseLinks。
 */
export function parseOwnLinks(body: string): string[] {
  return parseLinks(stripAutoBacklinks(body));
}

/** 返回正文中指向未知页面的链接（死链） */
export function findDeadLinks(body: string, known: ReadonlySet<string>): string[] {
  return parseLinks(body).filter((id) => !known.has(id));
}

/** 剥掉正文末尾由程序生成的反向链接区块（含哨兵注释），幂等性的关键 */
export function stripAutoBacklinks(body: string): string {
  const at = body.indexOf(BACKLINKS_SENTINEL);
  const head = at === -1 ? body : body.slice(0, at);
  return head.replace(/\s+$/, '');
}

/** 渲染反向链接区块；按 id 排序以保证输出稳定（否则每次编译都产生无意义 diff） */
export function renderBacklinks(inLinks: readonly string[]): string {
  if (inLinks.length === 0) return '';
  const lines = [...inLinks].sort().map((id) => `- [[${id}]]`);
  return `${BACKLINKS_SENTINEL}\n${BACKLINKS_HEADING}\n\n${lines.join('\n')}`;
}

/** 先剥后写：这是防止反向链接层层叠加的唯一正确顺序 */
export function withBacklinks(body: string, inLinks: readonly string[]): string {
  const base = stripAutoBacklinks(body);
  const section = renderBacklinks(inLinks);
  return section === '' ? base : `${base}\n\n${section}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把正文里指向 id 的链接统一改写成 [[id|name]]（供 link 操作使用） */
export function replaceLinkDisplay(body: string, id: string, name: string): string {
  const re = new RegExp(`\\[\\[${escapeRegExp(id)}(?:\\|[^\\]]*)?\\]\\]`, 'g');
  return body.replace(re, `[[${id}|${name}]]`);
}
