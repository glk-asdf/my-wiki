/**
 * Schema 层加载器。schema/*.md 是本项目的「源码」——它决定 LLM 怎么写页面。
 * 进程内缓存：一次 compile 会调用几十次。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_DIR, relToRoot } from './store.js';
import type { PageType } from './types.js';

const cache = new Map<string, string>();

async function readCached(file: string, label: string): Promise<string> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`缺少 schema 文件 ${label}：${relToRoot(file)}`);
  }
  cache.set(file, text);
  return text;
}

/** 维护规则：编译阶段（extract / plan / apply）的 system 提示词主体 */
export function loadRules(): Promise<string> {
  return readCached(path.join(SCHEMA_DIR, 'rules.md'), '维护规则');
}

/** 回答生成规则：query 阶段的 system 提示词主体 */
export function loadQueryRules(): Promise<string> {
  return readCached(path.join(SCHEMA_DIR, 'query.md'), '回答规则');
}

/** 页面类型与命名规范 */
export function loadTaxonomy(): Promise<string> {
  return readCached(path.join(SCHEMA_DIR, 'taxonomy.md'), '页面类型规范');
}

/** 指定类型的页面骨架，作为 apply 阶段的输出格式约束 */
export function loadTemplate(type: PageType): Promise<string> {
  return readCached(path.join(SCHEMA_DIR, 'templates', `${type}.md`), `${type} 页面模板`);
}

export function clearSchemaCache(): void {
  cache.clear();
}
