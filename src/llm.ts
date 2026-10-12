/**
 * LLM 调用层：把「一段提示词」变成「一个通过 zod 校验的对象」。
 *
 * 设计要点（对应 doc/DEVELOPMENT.md S6）：
 * - 不依赖各家的 response_format / json_schema（支持度参差不齐），只靠提示词 + zod + 带错误重试
 * - 重试必须把「上次的输出」和「校验错误」喂回去，否则模型不知道自己错在哪
 * - 每次调用的入参与原始输出都落盘到 .state/passes/，LLM 项目 90% 的调试时间花在这上面
 * - chat 可注入，于是重试逻辑可以完全离线测试
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import type { ZodType } from 'zod';
import { llmConfig, type LlmConfig } from './env.js';
import { PASSES_DIR } from './store.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 所有「要求结构化输出」的提示词共用的约束。
 *
 * 最后一句不是客套：中文模型会把引号写成**未转义的 ASCII `"`**，直接毁掉整份 JSON
 * （实测智谱 glm-4.5-flash 一条 2310 字的响应里出现 204 个裸引号、0 个中文引号，
 * JSON 在第 135 个字符处就废了）。提示词里点明能显著减少修复次数；
 * 程序侧另有 escapeInnerQuotes 兜底。
 */
export const JSON_ONLY =
  '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 围栏。' +
  '字符串内部一律使用中文引号「」或转义后的 \\"，不要出现未转义的英文双引号。';

/** 一次底层对话调用：输入消息数组，返回模型原始文本 */
export type ChatFn = (messages: readonly ChatMessage[]) => Promise<string>;

export interface Prompt {
  /** 'extract' | 'plan' | 'apply:create' | 'apply:update' | 'select' | 'answer'，用于落盘文件名 */
  tag: string;
  system: string;
  user: string;
}

export interface StructuredPrompt<T> extends Prompt {
  schema: ZodType<T>;
  /** 首次 + 重试次数上限，默认 2 次重试 */
  maxRetries?: number;
}

export interface LlmClient {
  /** 只要文本，不做结构校验 */
  text(prompt: Prompt): Promise<string>;
  /** 要结构化结果：JSON 解析 + zod 校验 + 出错重试 */
  structured<T>(prompt: StructuredPrompt<T>): Promise<T>;
  /** 已发生的底层调用次数（S10 的「第二次编译 0 次调用」验收要用） */
  callCount(): number;
}

/**
 * 把「字符串内部的裸双引号」转义掉。
 *
 * 为什么需要它：中文模型（**实测智谱 glm-4.5-flash**）在中文文本里会直接写 ASCII `"`
 * 而不是中文引号，也不转义——一次 2310 字的响应里出现 204 个裸引号、0 个中文引号，
 * 于是整份 JSON 在第 135 个字符处就废了。这种输出如果只靠「报错重试」，在免费档上
 * 每次重试都要 12~60 秒，是纯粹的浪费；先修再看能不能用，明显更划算。
 *
 * 判断规则：处于字符串内部时遇到 `"`，向后找到第一个非空白字符——若它是 `,` `:` `}` `]`
 * 或已到结尾，那这个引号是真闭合；否则它就是正文里的裸引号，需要转义。
 */
export function escapeInnerQuotes(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';

    if (char === '\\') {
      // 已转义的序列原样保留（连同它的转义目标）
      out += char + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char !== '"') {
      out += char;
      continue;
    }
    if (!inString) {
      inString = true;
      out += char;
      continue;
    }

    let next = i + 1;
    while (next < text.length && /\s/.test(text[next] ?? '')) next += 1;
    const follower = text[next] ?? '';
    if (follower === ':' || follower === ',' || follower === '}' || follower === ']' || follower === '') {
      inString = false;
      out += char;
    } else {
      out += '\\"';
    }
  }

  return out;
}

/** 先按原样解析，失败再尝试修复裸引号；两种都不行返回 undefined */
function tryParseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    // 继续尝试修复
  }
  try {
    return { value: JSON.parse(escapeInnerQuotes(text)) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * 从模型输出里抠出 JSON。容忍常见的四类脏输出：
 * ```json 围栏、前后多余的解释文字、被截断的括号、字符串内部的裸引号。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error(
      '输出不是合法 JSON：模型返回了空内容。' +
        '若该模型是思考型（如 GLM / DeepSeek 的 reasoning 系列），答案可能被放进了 reasoning_content 字段——' +
        '原始响应已落盘到 .state/passes/，打开确认后再决定是换模型还是加一层兜底。',
    );
  }

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const direct = tryParseJson(unfenced);
  if (direct !== undefined) return direct.value;

  // 前后夹带解释文字时，退化为「从最先出现的括号到它对应的最后一个闭合括号」。
  // 必须比较哪种括号先出现：固定先试 { 会把顶层数组 [{"a":1}] 误解析成它内部的第一个对象。
  let openAt = Number.POSITIVE_INFINITY;
  let closeAt = -1;
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const at = unfenced.indexOf(open);
    if (at === -1 || at >= openAt) continue;
    const end = unfenced.lastIndexOf(close);
    if (end <= at) continue;
    openAt = at;
    closeAt = end;
  }
  if (closeAt > openAt) {
    const sliced = tryParseJson(unfenced.slice(openAt, closeAt + 1));
    if (sliced !== undefined) return sliced.value;
  }

  // 打印「实际试图解析的内容」而不是带围栏的原文，否则会把人引向围栏没剥掉的错误方向
  throw new Error(`输出不是合法 JSON：${unfenced.slice(0, 200)}`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 同一 tag 的中间产物只保留最近 5 份，否则重试会把磁盘塞满 */
async function prunePassDumps(dir: string, tag: string, keep = 5): Promise<void> {
  const files = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`${tag}-`))
    .sort()
    .reverse();
  for (const name of files.slice(keep)) {
    await fs.rm(path.join(dir, name), { force: true });
  }
}

let dumpSeq = 0;

async function dumpPass(dir: string, tag: string, attempt: number, payload: unknown): Promise<void> {
  // 带上自增序号：同一毫秒内的两次落盘不会互相覆盖
  dumpSeq += 1;
  const file = path.join(dir, `${tag}-${stamp()}-a${attempt}-${dumpSeq}.json`);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await prunePassDumps(dir, tag);
}

export interface LlmClientOptions {
  /** 不传则读环境变量（缺失时抛出可读错误） */
  config?: LlmConfig;
  /** 不传则用 OpenAI 兼容端点；测试时注入假实现 */
  chat?: ChatFn;
  /** 中间产物落盘目录，默认 .state/passes */
  passesDir?: string;
  temperature?: number;
}

export function createLlmClient(options: LlmClientOptions = {}): LlmClient {
  const passesDir = options.passesDir ?? PASSES_DIR;
  const temperature = options.temperature ?? 0.2;
  /** 默认重试次数（首次之外再试几次）。传输层失败与结构化失败共用这个预算 */
  const defaultMaxRetries = 2;

  let calls = 0;
  const rawChat: ChatFn =
    options.chat ??
    (() => {
      const config = options.config ?? llmConfig();
      const client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        // 关掉 SDK 自己的重试。它重试的是网络/限流类错误，而我们外层已经有一套
        // 「带上错误原因重试」的循环（会落盘、能诊断）。两者叠乘过最坏情况会失控：
        // SDK 3 次 × 外层 3 次 × 120s ≈ 18 分钟卡在一趟上（本项目实测卡过 4 分钟）。
        // 宁可让单次请求快速失败，把重试决定权留在能记录过程的那一层。
        maxRetries: 0,
      });
      return async (messages) => {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          temperature,
        });
        return response.choices[0]?.message.content ?? '';
      };
    })();

  const chat: ChatFn = async (messages) => {
    calls += 1;
    return rawChat(messages);
  };

  return {
    callCount: () => calls,

    async text(prompt: Prompt): Promise<string> {
      const messages: ChatMessage[] = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];

      // 传输层失败（超时／连接中断）也重试：免费档高峰期一次调用就可能撞上，
      // 而这里没有 schema 可校验，失败一次就白跑——跟 structured() 的行为保持一致
      for (let attempt = 0; ; attempt += 1) {
        try {
          const raw = await chat(messages);
          await dumpPass(passesDir, prompt.tag, attempt, { messages, raw });
          return raw;
        } catch (error) {
          if (attempt >= defaultMaxRetries) throw error;
        }
      }
    },

    async structured<T>(prompt: StructuredPrompt<T>): Promise<T> {
      const maxRetries = prompt.maxRetries ?? defaultMaxRetries;
      const messages: ChatMessage[] = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];

      let lastRaw = '';
      let lastError = '';

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          lastRaw = await chat(messages);
        } catch (error) {
          // 传输层失败（超时、连接中断）：跟模型输出无关，别把「超时」当成它的
          // 结构化错误喂回去——那只会浪费一次调用。原样重试，用尽次数后抛出。
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt >= maxRetries) throw error;
          continue;
        }

        // 落盘**实际发出的 messages**：重试时它才包含上一轮的原始输出与错误说明，
        // 只记 system/user 会让你误以为两次调用完全一样（本项目就先被这么误导过）
        await dumpPass(passesDir, prompt.tag, attempt, { messages, raw: lastRaw });

        let parsed: unknown;
        try {
          parsed = extractJson(lastRaw);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          // 关键：把错误喂回去，而不是原样重试
          messages.push({ role: 'assistant', content: lastRaw });
          messages.push({
            role: 'user',
            content: `你的输出无法被解析为 JSON：${lastError}\n请只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 围栏。`,
          });
          continue;
        }

        const checked = prompt.schema.safeParse(parsed);
        if (checked.success) return checked.data;

        lastError = checked.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        messages.push({ role: 'assistant', content: lastRaw });
        messages.push({
          role: 'user',
          content: `输出未通过结构校验，问题如下：\n${lastError}\n请修正后重新输出完整 JSON。`,
        });
      }

      throw new Error(
        `[${prompt.tag}] ${maxRetries + 1} 次尝试后仍无法得到合法输出：${lastError}\n` +
          `最后一次的原始输出（已落盘 ${passesDir}）：\n${lastRaw.slice(0, 800)}`,
      );
    },
  };
}
