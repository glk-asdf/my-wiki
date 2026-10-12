import assert from 'node:assert/strict';
import test from 'node:test';
import matter from 'gray-matter';
import {
  normalizeBody,
  pagePath,
  passCachePath,
  PASSES_DIR,
  renderPage,
  renderWikiIndexMd,
  slugify,
  withBody,
} from '../src/store.js';
import type { IndexEntry, Page } from '../src/types.js';

const basePage: Page = {
  meta: {
    id: 'concepts/retrieval-augmented-generation',
    type: 'concept',
    title: '检索增强生成（RAG）',
    oneLiner: '查询时做功的解释器模式',
    aliases: ['RAG'],
    tags: ['架构模式'],
    sources: ['raw/llm-wiki-intro.md'],
    updated: '2026-10-12',
  },
  body: '## 定义\n\n每次提问都现场检索。',
};

test('slugify：英文标题得到干净 slug', () => {
  assert.equal(slugify('Retrieval Augmented Generation'), 'retrieval-augmented-generation');
  assert.equal(slugify('  Compiler vs Interpreter  '), 'compiler-vs-interpreter');
  assert.equal(slugify('llm_notebook'), 'llm-notebook');
});

test('slugify：中文与全角括号不产生连续连字符', () => {
  assert.equal(slugify('检索增强生成（RAG）'), '检索增强生成-rag');
  assert.equal(slugify('复利效应'), '复利效应');
});

test('slugify：没有可用字符时退化为 untitled', () => {
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(slugify('   '), 'untitled');
});

test('normalizeBody：CRLF、行尾空白、多余空行、首尾空行', () => {
  assert.equal(normalizeBody('a\r\nb'), 'a\nb');
  assert.equal(normalizeBody('a   \nb'), 'a\nb');
  assert.equal(normalizeBody('\n\n\na\n\n\n\nb\n\n'), 'a\n\nb');
  assert.equal(normalizeBody('a\n\n\n'), 'a');
});

test('normalizeBody 幂等：重复调用结果不变', () => {
  const once = normalizeBody('\r\n\r\n## 标题  \r\n\r\n\r\n正文\r\n');
  assert.equal(normalizeBody(once), once);
});

test('renderPage → matter 往返：meta 完整，updated 是字符串而不是 Date', () => {
  const parsed = matter(renderPage(basePage));
  assert.equal(typeof parsed.data['updated'], 'string');
  assert.equal(parsed.data['updated'], '2026-10-12');
  assert.equal(parsed.data['id'], basePage.meta.id);
  assert.equal(parsed.data['type'], 'concept');
  assert.equal(parsed.data['title'], '检索增强生成（RAG）');
  assert.deepEqual(parsed.data['aliases'], ['RAG']);
  assert.deepEqual(parsed.data['sources'], ['raw/llm-wiki-intro.md']);
  assert.equal(normalizeBody(parsed.content), basePage.body);
});

test('renderPage 往返幂等：再渲染一次结果逐字节相同', () => {
  const once = renderPage(basePage);
  const roundTripped: Page = { meta: basePage.meta, body: normalizeBody(matter(once).content) };
  assert.equal(renderPage(roundTripped), once);
});

test('renderPage：标题里的冒号、引号、井号不会破坏 YAML', () => {
  const tricky = '编译器：从「检索」到 "编译" #不是注释';
  const parsed = matter(renderPage({ ...basePage, meta: { ...basePage.meta, title: tricky } }));
  assert.equal(parsed.data['title'], tricky);
});

test('extraMeta：schema 未声明的字段被保留而不是丢失', () => {
  const page = withBody({ ...basePage, extraMeta: { priority: 'high', reviewed: true } }, '## 定义\n\n新内容。');
  const parsed = matter(renderPage(page));
  assert.equal(parsed.data['priority'], 'high');
  assert.equal(parsed.data['reviewed'], true);
  // 已声明字段仍然按固定顺序在前
  assert.deepEqual(Object.keys(parsed.data).slice(0, 8), [
    'id',
    'type',
    'title',
    'oneLiner',
    'aliases',
    'tags',
    'sources',
    'updated',
  ]);
});

test('withBody：换正文时保住 meta 与 extraMeta', () => {
  const page: Page = { ...basePage, extraMeta: { priority: 'high' } };
  const next = withBody(page, '## 定义\n\n改过的内容。');
  assert.equal(next.body, '## 定义\n\n改过的内容。');
  assert.deepEqual(next.meta, page.meta);
  assert.deepEqual(next.extraMeta, { priority: 'high' });
  assert.deepEqual(withBody(basePage, 'x').extraMeta, undefined);
});

test('passCachePath：键用素材相对路径，同名文件不会互相覆盖', () => {
  const a = passCachePath('extract', 'raw/a/notes.md');
  const b = passCachePath('extract', 'raw/b/notes.md');
  assert.notEqual(a, b, 'raw/a/notes.md 与 raw/b/notes.md 必须落在不同缓存文件上');
  assert.notEqual(a, passCachePath('plan', 'raw/a/notes.md'), '不同 Pass 的缓存不能撞车');
  assert.ok(a.startsWith(PASSES_DIR));
  assert.ok(a.endsWith('.json'));
  assert.ok(!a.includes('..'));
});

test('passCachePath：同一素材同一 Pass 的路径稳定（续跑靠它找回缓存）', () => {
  assert.equal(passCachePath('plan', 'raw/llm-wiki-intro.md'), passCachePath('plan', 'raw/llm-wiki-intro.md'));
  // 扩展名去掉后不应留下点号之类的干扰字符
  assert.ok(!passCachePath('extract', 'raw/llm-wiki-intro.md').includes('.md'));
});

test('pagePath：拒绝越界与空 id', () => {
  assert.ok(pagePath('concepts/rag').endsWith(`concepts${process.platform === 'win32' ? '\\' : '/'}rag.md`));
  assert.throws(() => pagePath('../etc/passwd'), /非法页面 id/);
  assert.throws(() => pagePath('/abs/path'), /非法页面 id/);
  assert.throws(() => pagePath(''), /非法页面 id/);
});

test('renderWikiIndexMd：空输入、分组顺序、按 id 排序', () => {
  assert.match(renderWikiIndexMd([]), /共 0 个页面/);

  const entry = (id: string, type: IndexEntry['type']): IndexEntry => ({
    id,
    type,
    title: id,
    oneLiner: '一句话',
    aliases: [],
    tags: [],
    outLinks: [],
    inLinks: [],
    updated: '2026-10-12',
  });
  const md = renderWikiIndexMd([
    entry('sources/a', 'source'),
    entry('entities/b', 'entity'),
    entry('concepts/z', 'concept'),
    entry('concepts/a', 'concept'),
  ]);

  assert.ok(md.indexOf('## 概念') < md.indexOf('## 实体'), '概念应在实体之前');
  assert.ok(md.indexOf('## 实体') < md.indexOf('## 素材'), '实体应在素材之前');
  assert.ok(md.indexOf('[[concepts/a]]') < md.indexOf('[[concepts/z]]'), '同组内应按 id 排序');
  assert.ok(md.endsWith('\n'));
});
