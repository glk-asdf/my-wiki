/**
 * 链接图分析。
 *
 * 为什么要单独做这件事：这个项目的产出不是「一堆页面」，而是一张**网络**。
 * 页面数量是骗人的指标——100 个互不链接的页面和 10 个链接良好的页面，
 * 哪个更有价值一目了然。所以需要能一眼看出网络的形状：
 * 有没有孤岛、有没有超级节点、有没有被割裂成互不相干的几块。
 *
 * 数据全部来自 `.state/index.json`，不需要额外扫描，也不调 LLM。
 */
import type { IndexEntry } from './types.js';

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  /** 度为 0 的页面：写了但没接进网络 */
  isolated: string[];
  /** 度数最高的几个节点，按度数降序 */
  hubs: { id: string; degree: number }[];
  /** 连通分量（把链接视为无向边），按规模降序；多于一块说明网络被割裂了 */
  components: string[][];
  /** 自己链自己的页面；正常情况下应为空（编译期有 checkSelfLinks 拦截） */
  selfLoops: string[];
}

/** 无向邻接表：链接是单向的，但「是否连通」要看无向图 */
function buildAdjacency(entries: readonly IndexEntry[]): Map<string, Set<string>> {
  const ids = new Set(entries.map((entry) => entry.id));
  const adjacency = new Map<string, Set<string>>();
  for (const entry of entries) adjacency.set(entry.id, new Set());

  for (const entry of entries) {
    for (const target of entry.outLinks) {
      // 死链不计入图：它指向的页面不存在，画进图里会造出幽灵节点
      if (!ids.has(target)) continue;
      adjacency.get(entry.id)?.add(target);
      adjacency.get(target)?.add(entry.id);
    }
  }
  return adjacency;
}

export function analyzeGraph(entries: readonly IndexEntry[]): GraphStats {
  const adjacency = buildAdjacency(entries);

  const selfLoops = entries.filter((entry) => entry.outLinks.includes(entry.id)).map((entry) => entry.id);

  // 边数按「有向边」计：A→B 与 B→A 是两条，符合人们的直觉
  const ids = new Set(entries.map((entry) => entry.id));
  const edgeCount = entries.reduce(
    (sum, entry) => sum + entry.outLinks.filter((target) => ids.has(target)).length,
    0,
  );

  const components: string[][] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const stack = [entry.id];
    const group: string[] = [];
    seen.add(entry.id);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      group.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(group.sort());
  }
  components.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));

  const hubs = entries
    .map((entry) => ({ id: entry.id, degree: (adjacency.get(entry.id) ?? new Set()).size }))
    .filter((node) => node.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

  return {
    nodeCount: entries.length,
    edgeCount,
    isolated: entries
      .filter((entry) => (adjacency.get(entry.id) ?? new Set()).size === 0)
      .map((entry) => entry.id)
      .sort(),
    hubs,
    components,
    selfLoops,
  };
}

/**
 * 渲染成 Mermaid。
 * 节点标签里可能有 `/`、中文、空格，所以用生成的 `nN` 当 id、把页面 id 放进标签，
 * 避免 Mermaid 解析器被特殊字符绊倒。
 */
export function renderMermaid(entries: readonly IndexEntry[], maxHubs = 0): string {
  const ids = new Set(entries.map((entry) => entry.id));
  let nodes = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  if (maxHubs > 0 && nodes.length > maxHubs) {
    const ranked = analyzeGraph(entries).hubs.map((hub) => hub.id);
    nodes = ranked.slice(0, maxHubs).map((id) => entries.find((entry) => entry.id === id) as IndexEntry);
    nodes.sort((a, b) => a.id.localeCompare(b.id));
  }

  const alias = new Map<string, string>();
  nodes.forEach((entry, index) => alias.set(entry.id, `n${index}`));

  const lines = ['```mermaid', 'graph LR'];
  for (const entry of nodes) {
    lines.push(`  ${alias.get(entry.id)}["${entry.id}"]`);
  }
  for (const entry of nodes) {
    for (const target of entry.outLinks) {
      if (!alias.has(target)) continue;
      lines.push(`  ${alias.get(entry.id)} --> ${alias.get(target)}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/** 给人看的文本报告 */
export function formatGraphReport(stats: GraphStats): string {
  const lines: string[] = [
    `节点 ${stats.nodeCount} 个 · 有向边 ${stats.edgeCount} 条 · 连通块 ${stats.components.length} 个`,
  ];

  const componentSizes = stats.components.slice(0, 5).map((group) => group.length);
  lines.push(`  各连通块规模：${componentSizes.join(' / ')}${stats.components.length > 5 ? ' …' : ''}`);

  // 单节点的块已经被「孤立页」那条覆盖了，这里只提示「自成一块的小网络」——
  // 那才是最值得注意的情况：几个页面互相链接，却整块与主网络隔绝
  const detached = stats.components.slice(1).filter((group) => group.length > 1);
  if (detached.length > 0) {
    const pages = detached.reduce((sum, group) => sum + group.length, 0);
    lines.push(`  有 ${detached.length} 块自成网络、共 ${pages} 个页面，与主网络没有链接：${detached.map((g) => g.join('/')).join(' ｜ ')}`);
  }

  if (stats.hubs.length > 0) {
    const top = stats.hubs.slice(0, 5).map((hub) => `${hub.id}(${hub.degree})`).join(' · ');
    lines.push(`  连接最多：${top}`);
  }
  if (stats.isolated.length > 0) {
    lines.push(`  孤立页 ${stats.isolated.length} 个：${stats.isolated.slice(0, 8).join(', ')}${stats.isolated.length > 8 ? ' …' : ''}`);
  }
  if (stats.selfLoops.length > 0) {
    lines.push(`  自链接 ${stats.selfLoops.length} 个（异常，编译期本应拦下）：${stats.selfLoops.join(', ')}`);
  }
  return lines.join('\n');
}
