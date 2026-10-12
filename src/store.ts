/**
 * 文件系统层：目录常量、页面读写、索引/manifest 读写。
 * 所有路径拼接只在这里发生，其他模块一律调这些函数。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import {
  TYPE_DIRS,
  pageMetaSchema,
  type IndexEntry,
  type Manifest,
  type ManifestEntry,
  type Page,
  type PageType,
  type WikiIndex,
} from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, '..');
export const RAW_DIR = path.join(ROOT, 'raw');
export const WIKI_DIR = path.join(ROOT, 'wiki');
export const SCHEMA_DIR = path.join(ROOT, 'schema');
export const STATE_DIR = path.join(ROOT, '.state');
export const PASSES_DIR = path.join(STATE_DIR, 'passes');
export const INDEX_FILE = path.join(STATE_DIR, 'index.json');
export const MANIFEST_FILE = path.join(STATE_DIR, 'manifest.json');
export const WIKI_INDEX_FILE = path.join(WIKI_DIR, 'index.md');

/** wiki/index.md 是生成的目录页，不算一个页面 */
export const WIKI_INDEX_ID = 'index';

export async function ensureDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(RAW_DIR, { recursive: true }),
    fs.mkdir(WIKI_DIR, { recursive: true }),
    fs.mkdir(PASSES_DIR, { recursive: true }),
  ]);
  await removeStaleTempFiles();
}

/**
 * 清掉原子写留下的 *.tmp。正常情况下 rename 会带走它们，
 * 只有进程被杀才会残留——而它们被 listPageIds 排除，因此会无声堆积。
 */
export async function removeStaleTempFiles(): Promise<number> {
  let removed = 0;

  for (const dir of [WIKI_DIR, STATE_DIR]) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 页面目录只有一层，但按递归写更保险
        const inner = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
        for (const child of inner) {
          if (child.isFile() && child.name.endsWith('.tmp')) {
            await fs.rm(path.join(abs, child.name), { force: true });
            removed += 1;
          }
        }
        continue;
      }
      if (entry.name.endsWith('.tmp')) {
        await fs.rm(abs, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

export function relToRoot(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------- 底层 IO

async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Windows 上杀软/索引器会短暂占用刚写过的目标文件，rename 会报 EPERM/EBUSY。
 * 实测连续跑 reindex 就会偶发，退避重试即可，不要在这里失败。
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !retryable.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 30));
    }
  }
}

/** 先写 .tmp 再 rename：否则中途崩溃会留下半截文件，被当成合法页面读进来 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await renameWithRetry(tmp, file);
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** 正文归一化：统一换行、去行尾空白、折叠多余空行，保证落盘结果可比较 */
export function normalizeBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

// ---------------------------------------------------------------- 页面

/** id ↔ 磁盘路径的唯一定义处，任何地方都不要自己拼路径 */
export function pagePath(id: string): string {
  // id 可能来自 LLM 或页面正文的 [[...]]，别让它跳出 wiki/
  if (id === '' || id.startsWith('/') || id.split('/').includes('..')) {
    throw new Error(`非法页面 id：${JSON.stringify(id)}`);
  }
  return `${path.join(WIKI_DIR, ...id.split('/'))}.md`;
}

export async function pageExists(id: string): Promise<boolean> {
  return existsSync(pagePath(id));
}

/** 递归列出全部页面 id（相对 wiki/ 的无扩展名路径，'/' 分隔，已排序） */
export async function listPageIds(): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      // 'x.md.tmp' 不以 .md 结尾，天然被排除，无需额外判断
      if (!entry.name.endsWith('.md')) continue;
      const id = `${prefix}${entry.name.slice(0, -3)}`;
      if (id === WIKI_INDEX_ID) continue;
      out.push(id);
    }
  }

  await walk(WIKI_DIR, '');
  return out.sort();
}

function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((issue) => `    - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

const KNOWN_META_KEYS = new Set(['id', 'type', 'title', 'oneLiner', 'aliases', 'tags', 'sources', 'updated']);

/** zod 默认会剥掉未声明的键，这里把被剥掉的键捞回来，避免丢数据 */
function collectExtraMeta(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_META_KEYS.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length === 0 ? undefined : extra;
}

export async function readPage(id: string): Promise<Page> {
  const file = pagePath(id);
  const raw = await readFileIfExists(file);
  if (raw === null) throw new Error(`页面不存在：${id}（${relToRoot(file)}）`);

  const parsed = matter(raw);
  const checked = pageMetaSchema.safeParse(parsed.data);
  if (!checked.success) {
    throw new Error(`frontmatter 不合法：${relToRoot(file)}\n${formatZodIssues(checked.error)}`);
  }
  const meta = checked.data;
  if (meta.id !== id) {
    throw new Error(`frontmatter id（${meta.id}）与文件路径（${id}）不一致：${relToRoot(file)}`);
  }

  const extraMeta = collectExtraMeta(parsed.data as Record<string, unknown>);
  return extraMeta === undefined
    ? { meta, body: normalizeBody(parsed.content) }
    : { meta, body: normalizeBody(parsed.content), extraMeta };
}

/** 换正文但保住其余字段：任何「改写页面」的地方都该用它，避免漏掉 extraMeta */
export function withBody(page: Page, body: string): Page {
  return page.extraMeta === undefined
    ? { meta: page.meta, body }
    : { meta: page.meta, body, extraMeta: page.extraMeta };
}

/** 渲染成文件内容；frontmatter 字段顺序由这里固定，未声明的字段排在最后 */
export function renderPage(page: Page): string {
  const meta: Record<string, unknown> = {
    id: page.meta.id,
    type: page.meta.type,
    title: page.meta.title,
    oneLiner: page.meta.oneLiner,
    aliases: page.meta.aliases,
    tags: page.meta.tags,
    sources: page.meta.sources,
    updated: page.meta.updated,
  };
  if (page.extraMeta !== undefined) Object.assign(meta, page.extraMeta);
  // 正文前多一个空行，让 frontmatter 与正文之间可读；normalizeBody 会把它吃掉，不影响幂等
  return matter.stringify(`\n${normalizeBody(page.body)}\n`, meta);
}

/** 内容没变就不落盘（避免 mtime 抖动破坏「字节级不变」的验收）；返回是否真的写了 */
export async function writePage(page: Page): Promise<boolean> {
  const file = pagePath(page.meta.id);
  const content = renderPage(page);
  if ((await readFileIfExists(file)) === content) return false;
  await writeFileAtomic(file, content);
  return true;
}

export async function writeRawFile(relPath: string, content: string): Promise<void> {
  await writeFileAtomic(path.join(ROOT, ...relPath.split('/')), content);
}

// ---------------------------------------------------------------- id / slug

/**
 * 从标题推导 slug。ASCII 标题得到干净的英文 slug；
 * 纯中文标题会保留汉字（文件路径与链接都支持），由 plan 阶段给出的英文 slug 优先覆盖。
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

/** 生成一个不与现有页面冲突的 id：冲突时加 -2、-3 后缀 */
export async function nextFreeId(type: PageType, slug: string): Promise<string> {
  const taken = new Set(await listPageIds());
  const base = `${TYPE_DIRS[type]}/${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- raw 素材

/** 列出 raw/ 下的全部 Markdown，返回相对项目根的路径，如 'raw/llm-wiki-intro.md' */
export async function listRawFiles(): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
        out.push(`raw/${prefix}${entry.name}`);
      }
    }
  }

  await walk(RAW_DIR, '');
  return out;
}

export async function readRaw(relPath: string): Promise<string> {
  const file = path.join(ROOT, ...relPath.split('/'));
  const text = await readFileIfExists(file);
  if (text === null) throw new Error(`原素材不存在：${relPath}`);
  return text;
}

/** 用内容 hash 而不是 mtime：git checkout 会改 mtime 但内容不变 */
export async function rawHash(relPath: string): Promise<string> {
  const text = await readRaw(relPath);
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------- Pass 级缓存

/**
 * Pass 级续跑的缓存文件路径。
 * 键用素材的相对路径而不是文件名：`raw/a/x.md` 与 `raw/b/x.md` 不能撞车。
 */
export function passCachePath(kind: 'extract' | 'plan', rawRelPath: string): string {
  const key = rawRelPath.replace(/\.md$/i, '').replace(/[^\w\u4e00-\u9fff]+/g, '-');
  return path.join(PASSES_DIR, `cache-${kind}-${key}.json`);
}

export async function readPassCache(file: string): Promise<unknown> {
  const text = await readFileIfExists(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 缓存损坏等同于没有缓存，重跑一遍即可
  }
}

export async function writePassCache(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- 索引 / manifest

export async function readIndex(): Promise<WikiIndex | null> {
  const text = await readFileIfExists(INDEX_FILE);
  if (text === null) return null;
  try {
    return JSON.parse(text) as WikiIndex;
  } catch {
    return null;
  }
}

export async function writeIndex(index: WikiIndex): Promise<void> {
  await writeFileAtomic(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
}

export async function readManifest(): Promise<Manifest> {
  const text = await readFileIfExists(MANIFEST_FILE);
  if (text === null) return {};
  try {
    return JSON.parse(text) as Manifest;
  } catch {
    return {};
  }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  await writeFileAtomic(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function upsertManifestEntry(key: string, entry: ManifestEntry): Promise<void> {
  const manifest = await readManifest();
  manifest[key] = entry;
  await writeManifest(manifest);
}

export async function writeWikiIndexMd(entries: readonly IndexEntry[]): Promise<void> {
  await writeFileAtomic(WIKI_INDEX_FILE, renderWikiIndexMd(entries));
}

export function renderWikiIndexMd(entries: readonly IndexEntry[]): string {
  const groups: { type: PageType; label: string }[] = [
    { type: 'concept', label: '概念' },
    { type: 'entity', label: '实体' },
    { type: 'source', label: '素材' },
  ];
  const lines = [
    '# Wiki 目录',
    '',
    '> 本文件由程序自动生成，请勿手动编辑。',
    `> 共 ${entries.length} 个页面。`,
    '',
  ];
  for (const { type, label } of groups) {
    const group = entries.filter((entry) => entry.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${label}`, '');
    for (const entry of [...group].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- [[${entry.id}]] — ${entry.oneLiner}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * index.json 是否过期。两个条件缺一不可：
 *   ① 页面集合与索引一致 —— 能发现新增与「删除」；
 *   ② 没有比索引更新的页面 —— 能发现内容被改写。
 * 只看 mtime 会漏掉删除：删文件不会更新任何现存文件的 mtime。
 */
export async function isIndexStale(): Promise<boolean> {
  const index = await readIndex();
  if (index === null) return true;
  // index.md 同样是派生数据，被手工删掉后也应自动恢复
  if (!existsSync(WIKI_INDEX_FILE)) return true;

  const ids = await listPageIds();
  const indexed = new Set(index.pages.map((page) => page.id));
  if (ids.length !== indexed.size || ids.some((id) => !indexed.has(id))) return true;

  const indexMtime = await mtimeOf(INDEX_FILE);
  if (indexMtime === null) return true;

  let newestPageMtime = 0;
  for (const id of ids) {
    const mtime = await mtimeOf(pagePath(id));
    if (mtime !== null && mtime > newestPageMtime) newestPageMtime = mtime;
  }
  return newestPageMtime > indexMtime + 5;
}
