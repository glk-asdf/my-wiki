import { test } from 'node:test';
import assert from 'node:assert';
import { buildReadOnlyTools, runAgent, type AgentResult } from '../src/agent.js';
import type { LlmClient } from '../src/llm.js';
import type { IndexEntry } from '../src/types.js';

/** 注入式假模型：按调用次序返回预设的 ReAct 输出，绝不联网。 */
function fakeLlm(responses: string[]): LlmClient {
  let i = 0;
  return {
    async text() {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return r;
    },
    async structured() {
      throw new Error('structured 不在本测试路径');
    },
    callCount() {
      return i;
    },
  };
}

const entries: IndexEntry[] = [
  {
    id: 'concepts/rag',
    type: 'concept',
    title: 'RAG',
    oneLiner: '检索增强生成',
    aliases: [],
    tags: [],
    outLinks: ['concepts/llm-wiki'],
    inLinks: ['concepts/llm-wiki'],
    updated: '2026-01-01',
  },
  {
    id: 'concepts/llm-wiki',
    type: 'concept',
    title: 'LLM Wiki',
    oneLiner: '编译式知识库',
    aliases: [],
    tags: [],
    outLinks: ['concepts/rag'],
    inLinks: ['concepts/rag'],
    updated: '2026-01-01',
  },
];
const knownIds = new Set(entries.map((e) => e.id));

/** 用固定 fixtures 跑一次 agent，返回结果。 */
function run(llm: LlmClient, over: Partial<Parameters<typeof runAgent>[0]> = {}): Promise<AgentResult> {
  return runAgent({
    question: '测试问题',
    llm,
    tools: buildReadOnlyTools(entries, llm),
    entries,
    knownIds,
    maxSteps: 8,
    ...over,
  });
}

test('一步 finish：答案与引用校验都在', async () => {
  const r = await run(fakeLlm(['{"thought":"直接答","action":"finish","action_input":{},"answer":"这是答案 [[concepts/rag]]"}']));
  assert.equal(r.steps.length, 1);
  assert.equal(r.answer, '这是答案 [[concepts/rag]]');
  assert.deepEqual(r.citations, []);
  assert.match(r.transcript, /测试问题/);
});

test('多步工具分发：get_links 的 observation 被喂回下一轮', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"查链接","action":"get_links","action_input":{"id":"concepts/rag"}}',
      '{"thought":"够了","action":"finish","action_input":{},"answer":"rag 指向 llm-wiki"}',
    ]),
  );
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0]!.action, 'get_links');
  assert.match(r.steps[0]!.observation, /concepts\/llm-wiki/);
  assert.match(r.steps[1]!.thought, /够了/);
});

test('未知工具：observation 给出可用清单，agent 可继续收敛到 finish', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"写错名字","action":"get_link","action_input":{"id":"concepts/rag"}}',
      '{"thought":"改用正确工具","action":"get_links","action_input":{"id":"concepts/rag"}}',
      '{"thought":"结束","action":"finish","action_input":{},"answer":"ok"}',
    ]),
  );
  assert.equal(r.steps[0]!.action, 'get_link');
  assert.match(r.steps[0]!.observation, /未知工具/);
  assert.equal(r.steps[1]!.action, 'get_links');
  assert.equal(r.steps[2]!.action, 'finish');
});

test('步数上限：未达 finish 时答案提示未收敛', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"继续","action":"get_links","action_input":{"id":"concepts/rag"}}',
      '{"thought":"还在继续","action":"get_links","action_input":{"id":"concepts/rag"}}',
      '{"thought":"还不到头","action":"get_links","action_input":{"id":"concepts/rag"}}',
    ]),
    { maxSteps: 2 },
  );
  assert.equal(r.steps.length, 2);
  assert.match(r.answer, /未在 2 步内/);
});

test('引用校验：答案里的非法 [[id]] 被捕获', async () => {
  const r = await run(fakeLlm(['{"thought":"答","action":"finish","action_input":{},"answer":"见 [[concepts/nope]]"}']));
  assert.deepEqual(r.citations, ['concepts/nope']);
});

test('allowWrite=true：写入类工具可用（页面不存在路径不触发 structured）', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"拆一下","action":"propose_split","action_input":{"id":"concepts/missing"}}',
      '{"thought":"结束","action":"finish","action_input":{},"answer":"done"}',
    ]),
    { allowWrite: true },
  );
  assert.equal(r.steps[0]!.action, 'propose_split');
  assert.match(r.steps[0]!.observation, /页面不存在：concepts\/missing/);
});

test('allowWrite=false（默认）：propose_split 视为未知工具，不静默执行', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"想拆","action":"propose_split","action_input":{"id":"concepts/rag"}}',
      '{"thought":"结束","action":"finish","action_input":{},"answer":"done"}',
    ]),
  );
  assert.equal(r.steps[0]!.action, 'propose_split');
  assert.match(r.steps[0]!.observation, /未知工具/);
});

test('seedTranscript 多轮累积：上一轮上下文进入本轮 transcript', async () => {
  const r = await run(
    fakeLlm([
      '{"thought":"查","action":"get_links","action_input":{"id":"concepts/rag"}}',
      '{"thought":"结束","action":"finish","action_input":{},"answer":"x"}',
    ]),
    { seedTranscript: '上一轮上下文' },
  );
  assert.match(r.transcript, /上一轮上下文/);
});
