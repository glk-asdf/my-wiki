import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyConflicts,
  formatConflictReport,
  hasDisputes,
  parseDisputes,
  parseSection,
  setSection,
} from '../src/conflict.js';
import type { Page } from '../src/types.js';

function makePage(body: string, sources: string[] = []): Page {
  return {
    meta: {
      id: 'concepts/foo',
      type: 'concept',
      title: 'Foo',
      oneLiner: '测试页',
      aliases: [],
      tags: [],
      sources,
      updated: '2026-10-12',
    },
    body,
  };
}

test('parseSection：抽取指定小节、遇下一个 ## 或哨兵为止', () => {
  const body = '## 定义\n\nfoo\n\n## 争议\n\n- a\n- b\n\n## 出处\n\nx';
  assert.equal(parseSection(body, '争议'), '- a\n- b');
  assert.equal(parseSection(body, '定义'), 'foo');
  assert.equal(parseSection(body, '不存在'), null);
});

test('parseDisputes / hasDisputes：有内容才算有争议，空小节算无', () => {
  assert.equal(hasDisputes('## 定义\n\nx\n\n## 争议\n\n- 真矛盾'), true);
  assert.equal(hasDisputes('## 定义\n\nx\n\n## 争议\n\n（无）'), false);
  assert.equal(hasDisputes('## 定义\n\nx'), false);
  assert.equal(parseDisputes('## 定义\n\nx'), null);
});

test('setSection：原无小节时插到反向链接哨兵之前', () => {
  const body = '## 定义\n\nfoo\n\n<!-- AUTO-BACKLINKS -->\n## 反向链接\n';
  const out = setSection(body, '争议', '- 新争议');
  assert.ok(out.indexOf('## 争议') < out.indexOf('AUTO-BACKLINKS'));
  assert.match(out, /<!-- AUTO-BACKLINKS -->/);
});

test('setSection：已有小节时替换为新内容（且只出现一次）', () => {
  const body = '## 定义\n\nfoo\n\n## 争议\n\n旧的\n\n## 出处\n\nx';
  const out = setSection(body, '争议', '新的');
  assert.match(out, /新的/);
  assert.doesNotMatch(out, /旧的/);
  assert.equal((out.match(/## 争议/g) ?? []).length, 1);
});

test('setSection：既无哨兵也无该小节时追加到末尾', () => {
  const body = '## 定义\n\nfoo';
  const out = setSection(body, '争议', 'z');
  assert.ok(out.endsWith('## 争议\n\nz\n'));
  assert.match(out, /foo/);
});

test('applyConflicts：无矛盾时原样返回（不改动）', () => {
  const page = makePage('## 定义\n\nx');
  const result = applyConflicts(page, { conflicts: [] });
  assert.equal(result, page);
});

test('applyConflicts：有矛盾时写入争议小节并更新日期', () => {
  const page = makePage('## 定义\n\nx\n\n## 出处\n\n- [[sources/a]]：「摘录」', ['raw/a.md', 'raw/b.md']);
  const result = applyConflicts(page, {
    conflicts: [
      { topic: '范围', viewA: '小', sourceA: 'raw/a.md', viewB: '大', sourceB: 'raw/b.md' },
    ],
  }, '2026-10-13');
  assert.match(result.body, /## 争议/);
  assert.match(result.body, /\*\*范围\*\*：小（引自 raw\/a\.md）；另一种说法：大（引自 raw\/b\.md）。/);
  assert.equal(result.meta.updated, '2026-10-13');
  // 原出处小节仍在
  assert.match(result.body, /## 出处/);
});

test('formatConflictReport：空与有内容两种形态', () => {
  assert.match(formatConflictReport([]), /未发现已记录的争议/);
  const out = formatConflictReport([{ id: 'concepts/foo', disputes: '- a' }]);
  assert.match(out, /发现 1 个页面/);
  assert.match(out, /concepts\/foo/);
});
