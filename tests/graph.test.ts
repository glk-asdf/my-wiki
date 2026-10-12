import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeGraph, formatGraphReport, renderMermaid } from '../src/graph.js';
import type { IndexEntry } from '../src/types.js';

function entry(id: string, outLinks: string[] = []): IndexEntry {
  return {
    id,
    type: id.startsWith('sources/') ? 'source' : id.startsWith('entities/') ? 'entity' : 'concept',
    title: id,
    oneLiner: '一句话',
    aliases: [],
    tags: [],
    outLinks,
    inLinks: [],
    updated: '2026-10-12',
  };
}

test('analyzeGraph：出链与入链都算度数（链接是无向的「连通」关系）', () => {
  const stats = analyzeGraph([entry('concepts/a', ['concepts/b']), entry('concepts/b')]);
  assert.equal(stats.nodeCount, 2);
  assert.equal(stats.edgeCount, 1);
  assert.deepEqual(stats.isolated, []);
  assert.deepEqual(
    stats.hubs.map((hub) => `${hub.id}:${hub.degree}`),
    ['concepts/a:1', 'concepts/b:1'],
    'a 指向 b，但 b 的度数同样是 1',
  );
});

test('analyzeGraph：死链不进图，否则会造出幽灵节点', () => {
  const stats = analyzeGraph([entry('concepts/a', ['concepts/不存在'])]);
  assert.equal(stats.edgeCount, 0, '指向不存在页面的链接不算边');
  assert.equal(stats.nodeCount, 1, '幽灵节点不该出现在节点里');
  assert.deepEqual(stats.isolated, ['concepts/a']);
});

test('analyzeGraph：连通块揭示网络是否被割裂', () => {
  const stats = analyzeGraph([
    entry('concepts/a', ['concepts/b']),
    entry('concepts/b', ['concepts/a']),
    entry('concepts/c', ['concepts/d']),
    entry('concepts/d'),
    entry('concepts/lonely'),
  ]);
  assert.equal(stats.components.length, 3);
  assert.deepEqual(stats.components[0], ['concepts/a', 'concepts/b'], '最大的块排最前');
  assert.deepEqual(stats.components[2], ['concepts/lonely']);
  assert.deepEqual(stats.isolated, ['concepts/lonely']);
});

test('analyzeGraph：自链接要单独报出来（编译期本应拦下）', () => {
  const stats = analyzeGraph([entry('concepts/a', ['concepts/a'])]);
  assert.deepEqual(stats.selfLoops, ['concepts/a']);
});

test('renderMermaid：用生成的别名承载特殊字符，标签里保留原 id', () => {
  const mermaid = renderMermaid([entry('concepts/a', ['sources/b']), entry('sources/b')]);
  const lines = mermaid.split('\n');
  assert.equal(lines[0], '```mermaid');
  assert.equal(lines[1], 'graph LR');
  assert.match(mermaid, /n0\["concepts\/a"\]/);
  assert.match(mermaid, /n1\["sources\/b"\]/);
  assert.match(mermaid, /n0 --> n1/);
  assert.equal(lines.at(-1), '```', '必须是可粘贴的围栏代码块');
});

test('renderMermaid：maxNodes 只保留连接最多的节点', () => {
  const entries = [
    entry('concepts/hub', ['concepts/a', 'concepts/b', 'concepts/c']),
    entry('concepts/a'),
    entry('concepts/b'),
    entry('concepts/c'),
    entry('concepts/leaf'),
  ];
  const mermaid = renderMermaid(entries, 2);
  assert.match(mermaid, /concepts\/hub/);
  assert.ok(!mermaid.includes('concepts/leaf'), '未入选的节点不该出现在图里');
  // 被裁掉的节点不能留下悬空边
  for (const line of mermaid.split('\n').filter((item) => item.includes('-->'))) {
    assert.match(line, /n0|n1/);
  }
});

test('formatGraphReport：孤立页与超级节点都要说人话', () => {
  const report = formatGraphReport(
    analyzeGraph([
      entry('concepts/hub', ['concepts/a', 'concepts/b']),
      entry('concepts/a'),
      entry('concepts/b'),
      entry('concepts/lonely'),
    ]),
  );
  assert.match(report, /节点 4 个 · 有向边 2 条 · 连通块 2 个/);
  // 度数相同时按 id 排序，保证输出稳定（hub 度数为 2，稳稳排第一）
  assert.match(report, /连接最多：concepts\/hub\(2\) · concepts\/a\(1\) · concepts\/b\(1\)/);
  assert.match(report, /孤立页 1 个：concepts\/lonely/);
  assert.ok(!report.includes('自成网络'), '只有孤立页时不该报「独立小网络」');
});

test('formatGraphReport：与主网络隔绝的小网络要单独提示（它比孤立页更容易被忽略）', () => {
  const report = formatGraphReport(
    analyzeGraph([
      // 主网络刻意做成 3 个节点：两块规模相同时会按 id 排序，「岛」有可能排到前面去
      entry('concepts/main', ['concepts/other', 'concepts/third']),
      entry('concepts/other', ['concepts/main']),
      entry('concepts/third', ['concepts/main']),
      entry('concepts/islandA', ['concepts/islandB']),
      entry('concepts/islandB', ['concepts/islandA']),
    ]),
  );
  assert.match(report, /有 1 块自成网络、共 2 个页面/);
  assert.match(report, /concepts\/islandA\/concepts\/islandB/);
});
