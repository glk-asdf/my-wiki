import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { handleRequest, renderInline, renderMarkdown, type ServeContext } from '../src/serve.js';
import type { WikiIndex } from '../src/types.js';

const index: WikiIndex = {
  pages: [
    {
      id: 'concepts/a',
      type: 'concept',
      title: '概念A',
      oneLiner: '',
      aliases: [],
      tags: [],
      outLinks: [],
      inLinks: ['concepts/b'],
      updated: '',
    },
    {
      id: 'concepts/b',
      type: 'concept',
      title: '概念B',
      oneLiner: '',
      aliases: [],
      tags: [],
      outLinks: ['concepts/a'],
      inLinks: [],
      updated: '',
    },
  ],
  generatedAt: '',
};

const ctx: ServeContext = {
  index,
  uiHtml: 'UI_HTML',
  loadBody: async (id) =>
    id === 'concepts/a'
      ? '## 定义\n\n这是 [[concepts/a]] 与 **粗体** 和 `代码`。\n\n- 一\n- 二\n\n> 引用'
      : null,
};

const titleOf = (id: string): string | null => index.pages.find((p) => p.id === id)?.title ?? null;

test('renderInline：已知 wikilink 渲染为锚点，未知渲染为 deadlink', () => {
  assert.match(renderInline('见 [[concepts/a]]', titleOf), /<a href="#\/page\/concepts%2Fa" class="wikilink">概念A<\/a>/);
  assert.match(renderInline('见 [[concepts/x]]', titleOf), /<span class="deadlink"/);
  assert.match(renderInline('[[concepts/a|自定义]]', titleOf), /自定义<\/a>/);
});

test('renderInline：粗体与行内代码', () => {
  assert.match(renderInline('**粗** 和 `码`', titleOf), /<strong>粗<\/strong> 和 <code>码<\/code>/);
});

test('renderMarkdown：标题/列表/引用/段落', () => {
  const html = renderMarkdown('## 标题\n\n段落一\n\n- a\n- b\n\n> 引语', titleOf);
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<p>段落一<\/p>/);
  assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<blockquote>引语<\/blockquote>/);
});

test('handleRequest：根路径返回 UI，api 返回索引 JSON', async () => {
  assert.equal((await handleRequest('/', ctx)).body, 'UI_HTML');
  const api = await handleRequest('/api/index.json', ctx);
  assert.equal(api.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(api.body), index);
});

test('handleRequest：/page/<id> 返回已渲染 HTML，未知页 404', async () => {
  const r = await handleRequest('/page/concepts%2Fa', ctx);
  assert.equal(r.status, 200);
  assert.match(r.body, /<h2>定义<\/h2>/);
  assert.match(r.body, /class="wikilink">概念A<\/a>/);
  assert.match(r.body, /<strong>粗体<\/strong>/);
  assert.match(r.body, /反向链接/); // 来自 inLinks
  const missing = await handleRequest('/page/concepts%2Fzzz', ctx);
  assert.equal(missing.status, 404);
});

test('handleRequest：未知路由 404', async () => {
  assert.equal((await handleRequest('/nope', ctx)).status, 404);
});

test('handleRequest：/ 返回真实 serve-ui.html（验证运行时文件路径正确）', async () => {
  const uiHtml = await readFile(new URL('../src/serve-ui.html', import.meta.url), 'utf8');
  const r = await handleRequest('/', { index, uiHtml, loadBody: async () => null });
  assert.equal(r.body, uiHtml);
  assert.match(r.body, /<!doctype html>/i);
});
