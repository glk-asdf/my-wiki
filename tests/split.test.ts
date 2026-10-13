import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySplit,
  countChars,
  isOverLimit,
  type SplitProposal,
} from '../src/split.js';
import type { Page } from '../src/types.js';

function makePage(body: string, id = 'concepts/foo'): Page {
  return {
    meta: {
      id,
      type: 'concept',
      title: 'Foo',
      oneLiner: '测试父页',
      aliases: [],
      tags: ['t1'],
      sources: ['raw/x.md'],
      updated: '2026-10-12',
    },
    body,
  };
}

test('countChars：中文按字、英文按词', () => {
  assert.equal(countChars('中文测试'), 4);
  assert.equal(countChars('hello world'), 2);
  assert.equal(countChars('中文abc 中文'), 5);
});

test('countChars：忽略代码块与反向链接区块', () => {
  const body = '正文一百字'.repeat(10) + '\n```\n' + '码'.repeat(200) + '\n```\n<!-- AUTO-BACKLINKS -->\n## 反向链接\n- [[concepts/x]]';
  // 正文 50 字（正文一百字 ×10），代码与反向链接不应计入
  assert.equal(countChars(body), 50);
});

test('isOverLimit：超过阈值才为真', () => {
  assert.equal(isOverLimit('中'.repeat(500)), true);
  assert.equal(isOverLimit('中'.repeat(300)), false);
});

test('applySplit：枢纽页含子主题链接与原出链，子页回链枢纽', () => {
  const page = makePage(
    '## 定义\n\nFoo 的内容，提到 [[concepts/a]] 与 [[concepts/b]]。\n\n## 出处\n- [[sources/x]]：「摘录」',
  );
  const proposal: SplitProposal = {
    hubIntro: 'Foo 的概述。',
    subpages: [
      { slug: 'aspect1', title: 'Foo 方面一', oneLiner: '一', body: '## 定义\n\n涉及 [[concepts/a]]。' },
      { slug: 'aspect2', title: 'Foo 方面二', oneLiner: '二', body: '## 定义\n\n涉及 [[concepts/b]]，且已链回 [[concepts/foo]]。' },
    ],
  };
  const result = applySplit(page, proposal, {
    knownIds: new Set(['concepts/foo', 'concepts/a', 'concepts/b', 'sources/x']),
    subIds: ['concepts/foo-aspect1', 'concepts/foo-aspect2'],
    today: '2026-10-13',
  });

  // 枢纽页
  assert.match(result.hub.body, /## 子主题/);
  assert.match(result.hub.body, /- \[\[concepts\/foo-aspect1\|Foo 方面一\]\]/);
  assert.match(result.hub.body, /- \[\[concepts\/foo-aspect2\|Foo 方面二\]\]/);
  assert.match(result.hub.body, /## 相关/);
  assert.match(result.hub.body, /- \[\[concepts\/a\]\]/);
  assert.match(result.hub.body, /- \[\[concepts\/b\]\]/);
  assert.equal(result.hub.meta.updated, '2026-10-13');
  assert.equal(result.hub.meta.tags[0], 't1');

  // 子页一：未链回枢纽 → 自动补「隶属主题」
  assert.match(result.subpages[0]!.body, /隶属主题：\[\[concepts\/foo\]\]/);
  // 子页二：已链回枢纽 → 不再重复补
  assert.doesNotMatch(result.subpages[1]!.body, /隶属主题：/);
  assert.match(result.subpages[1]!.body, /\[\[concepts\/foo\]\]/);

  assert.equal(result.warnings.length, 0);
});

test('applySplit：子页死链在 resolve 为 null 时记为告警并保留', () => {
  const page = makePage('## 定义\n\n内容 [[concepts/a]]。');
  const proposal: SplitProposal = {
    hubIntro: '概述',
    subpages: [
      { slug: 'x', title: 'X', oneLiner: 'x', body: '## 定义\n\n引用了 [[concepts/ghost]]。' },
    ],
  };
  const result = applySplit(page, proposal, {
    knownIds: new Set(['concepts/foo', 'concepts/a']),
    subIds: ['concepts/foo-x'],
    today: '2026-10-13',
  });
  assert.match(result.subpages[0]!.body, /\[\[concepts\/ghost\]\]/);
  assert.ok(result.warnings.some((w) => w.includes('无法修复的死链 concepts/ghost')));
});

test('applySplit：传入 resolve 时死链被修复', () => {
  const page = makePage('## 定义\n\n内容。');
  const proposal: SplitProposal = {
    hubIntro: '概述',
    subpages: [{ slug: 'x', title: 'X', oneLiner: 'x', body: '## 定义\n\n引用了 [[concepts/ghost]]。' }],
  };
  const result = applySplit(page, proposal, {
    knownIds: new Set(['concepts/foo', 'concepts/a']),
    subIds: ['concepts/foo-x'],
    resolve: (id) => (id === 'concepts/ghost' ? 'concepts/a' : null),
    today: '2026-10-13',
  });
  assert.match(result.subpages[0]!.body, /\[\[concepts\/a\]\]/);
  assert.equal(result.warnings.length, 0);
});

test('applySplit：子页拆分后仍超长会告警', () => {
  const page = makePage('短。');
  const proposal: SplitProposal = {
    hubIntro: '概述',
    subpages: [{ slug: 'x', title: 'X', oneLiner: 'x', body: '长'.repeat(500) }],
  };
  const result = applySplit(page, proposal, {
    knownIds: new Set(['concepts/foo']),
    subIds: ['concepts/foo-x'],
    today: '2026-10-13',
  });
  assert.ok(result.warnings.some((w) => w.includes('仍超过字数上限')));
});
