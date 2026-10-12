/**
 * 环境变量读取。缺失时立刻抛出可读的错误，不要留到调 LLM 时才报 401。
 * S6 起才真正被使用。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时（毫秒）。免费档高峰期会很慢，实测智谱免费档超过过 120s */
  timeoutMs: number;
}

/** 默认 180s：实测 30s 不够，120s 也曾在免费档上被触发 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Node 20.12+ 自带 .env 加载，不需要 dotenv 依赖 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // 没有 .env 文件是正常情况（例如只用 Ollama 且变量已导出）
  }
}

export function llmConfig(): LlmConfig {
  const required = ['GLK_LLM_BASE_URL', 'GLK_LLM_API_KEY', 'GLK_LLM_MODEL'] as const;
  const values = required.map((key) => [key, process.env[key]?.trim() ?? ''] as const);
  const missing = values.filter(([, value]) => value === '').map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量：${missing.join(', ')}\n` +
        '  处理：在项目根目录的 .env 里补上（模板见 .env.example）。\n' +
        '  智谱 GLM 免费示例：\n' +
        '    GLK_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4\n' +
        '    GLK_LLM_API_KEY=<到 https://open.bigmodel.cn 新建一个 API Key>\n' +
        '    GLK_LLM_MODEL=glm-4.5-flash（或 glm-4.7-flash，它更慢但上下文更大）',
    );
  }

  const [baseUrl, apiKey, model] = values.map(([, value]) => value) as [string, string, string];

  const timeoutRaw = process.env['GLK_LLM_TIMEOUT_MS']?.trim() ?? '';
  const timeoutMs = timeoutRaw === '' ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`GLK_LLM_TIMEOUT_MS 必须是正整数（毫秒），当前值：${JSON.stringify(timeoutRaw)}`);
  }

  return { baseUrl, apiKey, model, timeoutMs };
}
