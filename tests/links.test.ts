import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKLINKS_SENTINEL,
  findDeadLinks,
  normalizeLinkId,
  parseLinks,
  parseOwnLinks,
  repairDeadLinks,
  renderBacklinks,
  replaceLinkDisplay,
  stripAutoBacklinks,
  withBacklinks,
} from '../src/links.js';

test('parseLinks：基本形态与显示名', () => {
  assert.deepEqual(parseLinks('见 [[concepts/rag]]。'), ['concepts/rag']);
  assert.deepEqual(parseLinks('见 [[concepts/rag|RAG 模式]]。'), ['concepts/rag']);
});

test('parseLinks：去重且保持出现顺序', () => {
  assert.deepEqual(parseLinks('[[b]] 与 [[a]] 与 [[b]]'), ['b', 'a']);
});

test('parseLinks：忽略非法链接', () => {
  assert.deepEqual(parseLinks('[[ ]] 与 [[a|]] 与 [[]]'), []);
});

test('parseLinks：忽略代码块与行内代码里的伪链接', () => {
  assert.deepEqual(parseLinks('```\n[[concepts/fake]]\n```\n真链接 [[concepts/real]]'), ['concepts/real']);
  assert.deepEqual(parseLinks('行内 `[[concepts/fake]]` 与 [[concepts/real]]'), ['concepts/real']);
});

test('normalizeLinkId：容忍 .md 后缀与多余斜杠', () => {
  assert.equal(normalizeLinkId(' /concepts/rag.md '), 'concepts/rag');
  assert.equal(normalizeLinkId('concepts//rag'), 'concepts/rag');
});

test('findDeadLinks：只报未知目标', () => {
  const known = new Set(['concepts/rag']);
  assert.deepEqual(findDeadLinks('[[concepts/rag]] 与 [[concepts/nope]]', known), ['concepts/nope']);
});

test('反向链接区块：可反复剥离与重建（幂等）', () => {
  const body = '## 定义\n\n内容。';
  const once = withBacklinks(body, ['concepts/b', 'concepts/a']);

  assert.ok(once.includes(BACKLINKS_SENTINEL));
  assert.equal(withBacklinks(once, ['concepts/b', 'concepts/a']), once);
  assert.equal(withBacklinks(once, ['concepts/a', 'concepts/b']), once);
  assert.equal(stripAutoBacklinks(once), body);
  assert.equal(withBacklinks(once, []), body);
});

test('renderBacklinks：无入链时不产生区块，有入链时排序稳定', () => {
  assert.equal(renderBacklinks([]), '');
  assert.equal(renderBacklinks(['b', 'a']), renderBacklinks(['a', 'b']));
});

test('parseOwnLinks：不能把反向链接当成自己的出链（回归：曾导致链接图反馈环）', () => {
  const page = withBacklinks('指向 [[concepts/hub]]。', ['concepts/a', 'concepts/b']);

  // 天真实现会把反向链接一并读成出链，于是出链集合被污染
  assert.deepEqual(parseLinks(page), ['concepts/hub', 'concepts/a', 'concepts/b']);
  // 正确实现只认正文自己的链接
  assert.deepEqual(parseOwnLinks(page), ['concepts/hub']);
});

test('replaceLinkDisplay：统一改写指向同一 id 的链接', () => {
  assert.equal(replaceLinkDisplay('见 [[concepts/rag]]。', 'concepts/rag', 'RAG'), '见 [[concepts/rag|RAG]]。');
  assert.equal(replaceLinkDisplay('见 [[concepts/rag|旧名]]。', 'concepts/rag', 'RAG'), '见 [[concepts/rag|RAG]]。');
  assert.equal(replaceLinkDisplay('见 [[concepts/other]]。', 'concepts/rag', 'RAG'), '见 [[concepts/other]]。');
});

test('repairDeadLinks：按 id 末段归一化修复（含补类型前缀、归一化大小写）', () => {
  const known = new Set(['concepts/llm-wiki']);
  const norm = (id: string): string => id.replace(/^[a-z]+\//i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolve = (id: string): string | null => (norm(id) === 'llmwiki' ? 'concepts/llm-wiki' : null);
  const { body, repairs, unrepaired } = repairDeadLinks(
    '见 [[concepts/LLM Wiki]] 与 [[LLM Wiki|大语言模型维基]]。',
    (x) => known.has(x),
    resolve,
  );
  // 两条都归一化到 concepts/llm-wiki：第一条补了大小写/空格，第二条补了类型前缀
  assert.deepEqual(repairs, [
    { from: 'concepts/LLM Wiki', to: 'concepts/llm-wiki' },
    { from: 'LLM Wiki', to: 'concepts/llm-wiki' },
  ]);
  assert.deepEqual(unrepaired, []);
  assert.equal(body, '见 [[concepts/llm-wiki]] 与 [[concepts/llm-wiki|大语言模型维基]]。');
});

test('repairDeadLinks：无法匹配的链接保持不动并计入 unrepaired', () => {
  const known = new Set(['concepts/rag']);
  const { body, repairs, unrepaired } = repairDeadLinks(
    '[[concepts/rag]] 与 [[concepts/ghost]]',
    (x) => known.has(x),
    () => null,
  );
  assert.deepEqual(repairs, []);
  assert.deepEqual(unrepaired, ['concepts/ghost']);
  assert.equal(body, '[[concepts/rag]] 与 [[concepts/ghost]]');
});

test('repairDeadLinks：跳过代码块与行内代码里的伪死链', () => {
  const known = new Set(['concepts/real']);
  const { body, repairs } = repairDeadLinks(
    '```\n[[concepts/fake]]\n```\n行内 `[[concepts/fake]]` 与 [[concepts/real]]',
    (x) => known.has(x),
    () => 'concepts/real',
  );
  assert.deepEqual(repairs, []);
  assert.ok(body.includes('[[concepts/fake]]'));
});

test('repairDeadLinks：同一死链多次出现各修各的', () => {
  const known = new Set(['concepts/t']);
  const { body, repairs } = repairDeadLinks(
    '[[concepts/x]] 和 [[concepts/x]]',
    (x) => known.has(x),
    () => 'concepts/t',
  );
  assert.equal(repairs.length, 2);
  assert.equal(body, '[[concepts/t]] 和 [[concepts/t]]');
});
