import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createLlmClient, escapeInnerQuotes, extractJson, type ChatMessage } from '../src/llm.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'my-wiki-llm-'));
}

test('extractJson：裸 JSON、围栏、夹带解释文字', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n希望有帮助'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
  assert.deepEqual(extractJson('前言\n[{"a":1}]\n后记'), [{ a: 1 }]);
});

test('extractJson：拿不到 JSON 时抛出可读错误', () => {
  assert.throws(() => extractJson('这里没有任何 JSON'), /不是合法 JSON/);
  assert.throws(() => extractJson('{"a":'), /不是合法 JSON/);
});

test('extractJson：中文文本里的裸双引号必须能被救回来（真实踩到的失败）', () => {
  // 形状来自实测：智谱 glm-4.5-flash 把中文引号写成了未转义的 ASCII "，
  // 一条 2310 字的响应里出现 204 个裸引号，JSON 在第 135 字符处就废了
  const raw = [
    '```json',
    '{',
    '  "title": "LLM Wiki知识架构",',
    '  "summary": "它用"提前编译"替代传统RAG的"临时检索"，共两层含义。",',
    '  "concepts": [{ "name": "复利效应", "evidence": "产生显著的"复利效应"" }],',
    '  "entities": [],',
    '  "claims": ["知识只整理一次"],',
    '  "relationHints": []',
    '}',
    '```',
  ].join('\n');

  const parsed = extractJson(raw) as { summary: string; concepts: { evidence: string }[] };
  assert.equal(parsed.summary, '它用"提前编译"替代传统RAG的"临时检索"，共两层含义。');
  assert.equal(parsed.concepts[0]?.evidence, '产生显著的"复利效应"');
});

test('escapeInnerQuotes：真闭合引号不能被误转义', () => {
  const good = '{"a":"b","c":{"d":"e"},"f":["g"]}';
  assert.equal(escapeInnerQuotes(good), good, '合法 JSON 原样通过');
  assert.equal(escapeInnerQuotes('{"a":"他说"你好""}'), '{"a":"他说\\"你好\\""}');
  assert.equal(escapeInnerQuotes('{"a":"已转义的 \\" 保持不动"}'), '{"a":"已转义的 \\" 保持不动"}');
});

test('extractJson：空内容要指向 reasoning_content 这个具体嫌疑', () => {
  assert.throws(() => extractJson(''), /模型返回了空内容[\s\S]*reasoning_content/);
  assert.throws(() => extractJson('   \n  '), /模型返回了空内容/);
});

test('structured：结构不符时，把原始输出与错误一起喂回去重试', async () => {
  const dir = await tempDir();
  const seen: ChatMessage[][] = [];
  const replies = ['{"nope":1}', '{"ok":"yes"}'];

  const client = createLlmClient({
    passesDir: dir,
    chat: async (messages) => {
      seen.push([...messages]);
      return replies[seen.length - 1] ?? '';
    },
  });

  const result = await client.structured({
    tag: 't',
    system: 'sys',
    user: 'usr',
    schema: z.object({ ok: z.string() }),
  });

  assert.deepEqual(result, { ok: 'yes' });
  assert.equal(client.callCount(), 2, '应该发生两次底层调用');

  const second = seen[1] ?? [];
  assert.ok(
    second.some((message) => message.role === 'assistant' && message.content === '{"nope":1}'),
    '第二次必须带上模型上一次的原始输出',
  );
  assert.ok(
    second.some((message) => message.content.includes('未通过结构校验')),
    '第二次必须说明错在哪',
  );

  await rm(dir, { recursive: true, force: true });
});

test('structured：坏 JSON 也走同一条重试路径', async () => {
  const dir = await tempDir();
  let calls = 0;
  const client = createLlmClient({
    passesDir: dir,
    chat: async () => {
      calls += 1;
      return calls === 1 ? '抱歉，我无法输出 JSON' : '```json\n{"ok":1}\n```';
    },
  });

  const result = await client.structured({ tag: 't', system: 's', user: 'u', schema: z.object({ ok: z.number() }) });
  assert.deepEqual(result, { ok: 1 });
  assert.equal(calls, 2);

  await rm(dir, { recursive: true, force: true });
});

test('structured：重试用尽后抛出带原始输出的错误', async () => {
  const dir = await tempDir();
  const client = createLlmClient({ passesDir: dir, chat: async () => '永远不是 JSON' });

  await assert.rejects(
    () =>
      client.structured({ tag: 't', system: 's', user: 'u', schema: z.object({}), maxRetries: 1 }),
    /2 次尝试后仍无法得到合法输出[\s\S]*永远不是 JSON/,
  );
  assert.equal(client.callCount(), 2, 'maxRetries=1 表示首次 + 1 次重试');

  await rm(dir, { recursive: true, force: true });
});

test('中间产物落盘：每次调用都留痕，且同一 tag 只保留最近 5 份', async () => {
  const dir = await tempDir();
  const client = createLlmClient({ passesDir: dir, chat: async () => '{"ok":1}' });

  for (let i = 0; i < 7; i += 1) {
    await client.structured({ tag: 'prunetag', system: 's', user: `u${i}`, schema: z.object({ ok: z.number() }) });
  }
  const dumped = (await readdir(dir)).filter((name) => name.startsWith('prunetag-'));
  assert.equal(dumped.length, 5, `期望保留 5 份，实际 ${dumped.length} 份`);

  await rm(dir, { recursive: true, force: true });
});

test('text：传输层失败也要重试（否则慢速免费档一次超时就白跑）', async () => {
  const dir = await tempDir();
  let calls = 0;
  const client = createLlmClient({
    passesDir: dir,
    chat: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('Request timed out.');
      return '第三次才成功的回答';
    },
  });

  assert.equal(await client.text({ tag: 'answer', system: 's', user: 'u' }), '第三次才成功的回答');
  assert.equal(calls, 3, '两次传输失败后第三次成功');
  // 失败的尝试不该留下假响应，只有成功那次会落盘
  assert.equal((await readdir(dir)).length, 1);

  await rm(dir, { recursive: true, force: true });
});

test('text：重试用尽后把最后一次的错误抛出', async () => {
  const dir = await tempDir();
  let calls = 0;
  const client = createLlmClient({
    passesDir: dir,
    chat: async () => {
      calls += 1;
      throw new Error(`第 ${calls} 次也超时`);
    },
  });

  await assert.rejects(() => client.text({ tag: 'answer', system: 's', user: 'u' }), /第 3 次也超时/);
  await rm(dir, { recursive: true, force: true });
});

test('text：不做结构校验，但同样落盘', async () => {
  const dir = await tempDir();
  const client = createLlmClient({ passesDir: dir, chat: async () => '随便一段文字' });

  assert.equal(await client.text({ tag: 'plain', system: 's', user: 'u' }), '随便一段文字');
  assert.equal(client.callCount(), 1);
  assert.equal((await readdir(dir)).length, 1);

  await rm(dir, { recursive: true, force: true });
});

test('缺少环境变量时，构造真实客户端会给出可读错误', () => {
  const saved = { ...process.env };
  delete process.env['MY_WIKI_LLM_BASE_URL'];
  delete process.env['MY_WIKI_LLM_API_KEY'];
  delete process.env['MY_WIKI_LLM_MODEL'];
  try {
    assert.throws(
      () => createLlmClient({ passesDir: os.tmpdir() }).callCount(),
      /缺少环境变量：MY_WIKI_LLM_BASE_URL, MY_WIKI_LLM_API_KEY, MY_WIKI_LLM_MODEL/,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
});
