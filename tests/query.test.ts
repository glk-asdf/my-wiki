import assert from 'node:assert/strict';
import test from 'node:test';
import { citationsOf, MAX_SELECTED_PAGES, NO_COVERAGE_ANSWER, validateCitations } from '../src/query.js';

test('citationsOf：取出答案里的引用，去重并保持顺序', () => {
  assert.deepEqual(citationsOf('答案见 [[concepts/rag]]。'), ['concepts/rag']);
  assert.deepEqual(citationsOf('A [[concepts/a|甲]] 与 B [[concepts/b]] 与 [[concepts/a]]'), [
    'concepts/a',
    'concepts/b',
  ]);
  assert.deepEqual(citationsOf('没有任何引用的一段话'), []);
});

test('validateCitations：只报引用里不存在的页面（验收标准 6 的实现）', () => {
  const known = new Set(['concepts/rag', 'sources/llm-wiki-intro']);
  assert.deepEqual(validateCitations('见 [[concepts/rag]]。', known), []);

  // 幻觉引用与「引用 raw/ 素材文件」是两种典型失败，都要被抓出来
  assert.deepEqual(validateCitations('见 [[concepts/不存在]]。', known), ['concepts/不存在']);
  assert.deepEqual(validateCitations('依据 [[raw/llm-wiki-intro]]。', known), ['raw/llm-wiki-intro']);
});

test('validateCitations：代码块里的 [[x]] 不算引用（免得拿示例当结论去校验）', () => {
  const known = new Set(['concepts/rag']);
  const answer = '引用写法是 `[[概念id]]`，例如：\n\n```\n[[concepts/rag]]\n```\n\n所以这里不算引用。';
  assert.deepEqual(validateCitations(answer, known), [], '围栏与行内代码里的都不该被当成引用');
  assert.deepEqual(validateCitations('真的引用了 [[concepts/rag]]。', known), []);
});

test('常量：默认上限与「未收录」措辞是契约的一部分', () => {
  assert.equal(MAX_SELECTED_PAGES, 8);
  assert.match(NO_COVERAGE_ANSWER, /^wiki 中未收录/);
});
