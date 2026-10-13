/**
 * 极简 Web UI：本地静态服务，把编译好的 wiki 以可点击的「页面 + 反向链接 + 搜索」形式查看。
 *
 * 设计取舍（极简、零前端依赖、只读）：
 * - 不引任何前端框架 / Markdown 库——内置一个覆盖本 wiki 语法的极简渲染器（标题/列表/粗体/
 *   行内代码/引用/代码块/`[[wikilink]]`），避免 CDN/打包，离线即可用。
 * - 服务端只**读** `wiki/` 与 `.state/index.json`，绝不写盘（与只读命令同样的约束）：
 *   `/api/index.json` 给导航与反向链接数据，`/page/<id>` 返回已渲染的 HTML。
 * - 链接用 hash 路由（`#/page/<id>`），点击原生触发 `hashchange`，无需拦截。
 * - `handleRequest` 是纯函数式处理器（注入 index / loadBody / uiHtml），便于单测，不绑端口。
 */
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readIndex, readPage } from './store.js';
import { stripAutoBacklinks } from './links.js';
import { scan } from './reindex.js';
import { llmConfig } from './env.js';
import { createLlmClient } from './llm.js';
import { buildReadOnlyTools, runAgent, MAX_AGENT_STEPS } from './agent.js';
import type { WikiIndex } from './types.js';

/** 读取并解析 POST 请求体（JSON）。空体返回 {}；非法 JSON 抛错。 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(); // 防滥用：单请求体上限 1MB
    });
    req.on('end', () => {
      if (data === '') return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 行内渲染：先转义，再处理行内代码、粗体、wikilink（顺序无关，因三者字符不重叠）。 */
export function renderInline(text: string, titleOf: (id: string) => string | null): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const parts = inner.split('|');
    const id = parts[0]!.trim();
    const display = (parts.slice(1).join('|').trim() || titleOf(id) || id).trim();
    const known = titleOf(id) !== null || parts.length > 1;
    if (!known) {
      return `<span class="deadlink" title="未知页面：${escapeHtml(id)}">${escapeHtml(display)}</span>`;
    }
    return `<a href="#/page/${encodeURIComponent(id)}" class="wikilink">${escapeHtml(display)}</a>`;
  });
  return s;
}

/** 极简块级 Markdown → HTML。覆盖本 wiki 实际用到的语法子集。 */
export function renderMarkdown(md: string, titleOf: (id: string) => string | null): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (listType !== null) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const isSpecial = (l: string): boolean =>
    /^(#{1,6})\s|^\s*-\s|^\s*\d+\.\s|^\s*>\s?|^```/.test(l);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i += 1;
      }
      i += 1; // 跳过收尾的 ```
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(buf.join(' '), titleOf)}</blockquote>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1]!.length;
      out.push(`<h${lvl}>${renderInline(h[2]!, titleOf)}</h${lvl}>`);
      i += 1;
      continue;
    }
    const ul = line.match(/^\s*-\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(ul[1]!, titleOf)}</li>`);
      i += 1;
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(ol[1]!, titleOf)}</li>`);
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      closeList();
      i += 1;
      continue;
    }
    closeList();
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !isSpecial(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(' '), titleOf)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export interface ServeContext {
  index: WikiIndex;
  uiHtml: string;
  loadBody: (id: string) => Promise<string | null>;
}

/** 默认 loader：读页面并剥掉反向链接区块（UI 用侧栏/反向链接面板呈现，避免重复）。 */
export const defaultLoadBody = async (id: string): Promise<string | null> => {
  try {
    const page = await readPage(id);
    return stripAutoBacklinks(page.body);
  } catch {
    return null;
  }
};

function titleMap(index: WikiIndex): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of index.pages) m.set(p.id, p.title);
  return m;
}

function renderPageHtml(id: string, body: string, index: WikiIndex, titles: Map<string, string>): string {
  const main = renderMarkdown(body, (x) => titles.get(x) ?? null);
  const inLinks = index.pages.find((p) => p.id === id)?.inLinks ?? [];
  const back =
    inLinks.length === 0
      ? ''
      : `<div class="backlinks"><h3>反向链接</h3><ul>${inLinks
          .map(
            (b) =>
              `<li><a href="#/page/${encodeURIComponent(b)}" class="wikilink">${escapeHtml(
                titles.get(b) ?? b,
              )}</a></li>`,
          )
          .join('')}</ul></div>`;
  return `<article class="page">${main}</article>${back}`;
}

/** 纯请求处理器：给定路径与上下文，返回响应。便于单测，不绑端口、不写盘。 */
export async function handleRequest(
  pathname: string,
  ctx: ServeContext,
): Promise<{ status: number; contentType: string; body: string }> {
  if (pathname === '/' || pathname === '') {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: ctx.uiHtml };
  }
  if (pathname === '/api/index.json') {
    return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(ctx.index) };
  }
  const pm = pathname.match(/^\/page\/(.+)$/);
  if (pm) {
    const id = decodeURIComponent(pm[1]!);
    const body = await ctx.loadBody(id);
    if (body === null) {
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: `页面不存在：${id}` };
    }
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: renderPageHtml(id, body, ctx.index, titleMap(ctx.index)),
    };
  }
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: `Not found: ${pathname}` };
}

/** 取索引：优先读 .state/index.json；缺失/损坏时由 scan 在内存中现算（不写盘，保持只读）。 */
async function loadIndexForServe(): Promise<WikiIndex> {
  try {
    const existing = await readIndex();
    if (existing !== null) return existing;
  } catch {
    // 索引损坏则回退到现算
  }
  const s = await scan();
  const pages = s.ids.map((id: string) => {
    const p = s.pages.get(id)!;
      return {
        id,
        type: p.meta.type,
        title: p.meta.title,
        oneLiner: p.meta.oneLiner,
        aliases: p.meta.aliases,
        tags: p.meta.tags,
        outLinks: s.outLinks.get(id) ?? [],
        inLinks: s.inLinks.get(id) ?? [],
        updated: p.meta.updated,
      };
    });
    return { pages, generatedAt: new Date().toISOString() };
}

/** 启动本地服务（开发期查看用）。只读，不写任何文件。 */
export async function startServer(port: number): Promise<void> {
  const uiHtml = await readFile(fileURLToPath(new URL('./serve-ui.html', import.meta.url)), 'utf8');
  const index = await loadIndexForServe();
  const ctx: ServeContext = { index, uiHtml, loadBody: defaultLoadBody };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'POST' && pathname === '/api/agent') {
        const body = (await readJsonBody(req)) as {
          question?: unknown;
          seedTranscript?: unknown;
          allowWrite?: unknown;
        };
        const question = typeof body.question === 'string' ? body.question : '';
        if (question.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('缺少 question');
          return;
        }
        const llm = createLlmClient({ config: llmConfig() });
        const knownIds = new Set(index.pages.map((e) => e.id));
        const tools = buildReadOnlyTools(index.pages, llm);
        const result = await runAgent({
          question,
          llm,
          tools,
          entries: index.pages,
          knownIds,
          seedTranscript: typeof body.seedTranscript === 'string' ? body.seedTranscript : undefined,
          maxSteps: MAX_AGENT_STEPS,
          allowWrite: body.allowWrite === true,
        });
        const payload = {
          answer: result.answer,
          steps: result.steps,
          citations: result.citations,
          transcript: result.transcript,
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }
      const r = await handleRequest(pathname, ctx);
      res.writeHead(r.status, { 'Content-Type': r.contentType });
      res.end(r.body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`服务器错误：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  server.listen(port, () => {
    console.log(`Wiki UI 已启动：http://localhost:${port}/  （Ctrl+C 退出）`);
  });
}
