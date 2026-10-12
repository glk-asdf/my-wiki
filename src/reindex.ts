/**
 * 重建派生数据：反向链接、.state/index.json、wiki/index.md。
 * 单向依赖——页面是唯一事实来源，派生数据坏了随时可以重建。
 */
import { parseOwnLinks, withBacklinks } from './links.js';
import {
  isIndexStale,
  listPageIds,
  listRawFiles,
  readManifest,
  readPage,
  rawHash,
  withBody,
  writeIndex,
  writePage,
  writeWikiIndexMd,
} from './store.js';
import { byTypeCounts, type IndexEntry, type Page, type PageType, type WikiIndex } from './types.js';

export interface ScanResult {
  ids: string[];
  pages: Map<string, Page>;
  outLinks: Map<string, string[]>;
  inLinks: Map<string, string[]>;
  /** 指向不存在页面的链接 */
  deadLinks: { from: string; to: string }[];
  /** 没有任何反向链接的页面（孤立页） */
  orphans: string[];
  byType: Record<PageType, number>;
}

/** 只读扫描：不写任何文件，供 status 与 reindex 共用 */
export async function scan(): Promise<ScanResult> {
  const ids = await listPageIds();
  const idSet = new Set(ids);

  const pages = new Map<string, Page>();
  const outLinks = new Map<string, string[]>();
  const inLinks = new Map<string, string[]>();

  for (const id of ids) {
    const page = await readPage(id);
    pages.set(id, page);
    // 用 parseOwnLinks 而不是 parseLinks：后者会把本页的反向链接（别人的链接）也当成出链
    outLinks.set(id, parseOwnLinks(page.body));
    inLinks.set(id, []);
  }

  const deadLinks: { from: string; to: string }[] = [];
  for (const id of ids) {
    for (const to of outLinks.get(id) ?? []) {
      if (!idSet.has(to)) {
        deadLinks.push({ from: id, to });
        continue;
      }
      inLinks.get(to)?.push(id);
    }
  }

  const orphans = ids.filter((id) => (inLinks.get(id) ?? []).length === 0);
  const byType = byTypeCounts(ids.map((id) => pages.get(id)?.meta.type ?? 'concept'));

  return { ids, pages, outLinks, inLinks, deadLinks, orphans, byType };
}

export interface ReindexResult extends ScanResult {
  /** 实际落盘的页面数（内容有变化的才算） */
  writtenPages: number;
  indexEntries: IndexEntry[];
}

export async function reindex(): Promise<ReindexResult> {
  const result = await scan();

  let writtenPages = 0;
  for (const id of result.ids) {
    const page = result.pages.get(id);
    if (page === undefined) continue;
    const nextBody = withBacklinks(page.body, result.inLinks.get(id) ?? []);
    if (nextBody === page.body) continue;
    if (await writePage(withBody(page, nextBody))) writtenPages += 1;
  }

  const indexEntries: IndexEntry[] = result.ids.flatMap((id) => {
    const page = result.pages.get(id);
    if (page === undefined) return [];
    return [
      {
        id,
        type: page.meta.type,
        title: page.meta.title,
        oneLiner: page.meta.oneLiner,
        aliases: page.meta.aliases,
        tags: page.meta.tags,
        outLinks: result.outLinks.get(id) ?? [],
        inLinks: result.inLinks.get(id) ?? [],
        updated: page.meta.updated,
      },
    ];
  });

  const index: WikiIndex = { pages: indexEntries, generatedAt: new Date().toISOString() };
  await writeIndex(index);
  await writeWikiIndexMd(indexEntries);

  return { ...result, writtenPages, indexEntries };
}

/** 索引缺失或过期时自动重建；新鲜则返回 null */
export async function ensureIndex(): Promise<ReindexResult | null> {
  return (await isIndexStale()) ? reindex() : null;
}

export interface StatusReport extends ScanResult {
  /** raw/ 里还没编译成功、或内容已变的素材 */
  uncompiledRaw: string[];
  compiledRaw: number;
}

export async function statusReport(): Promise<StatusReport> {
  const result = await scan();
  const manifest = await readManifest();

  const uncompiledRaw: string[] = [];
  let compiledRaw = 0;
  for (const relPath of await listRawFiles()) {
    const entry = manifest[relPath];
    if (entry !== undefined && entry.passes.apply === 'ok' && entry.hash === (await rawHash(relPath))) {
      compiledRaw += 1;
      continue;
    }
    uncompiledRaw.push(relPath);
  }

  return { ...result, uncompiledRaw, compiledRaw };
}
