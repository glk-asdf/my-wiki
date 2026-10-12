# LLM Wiki 最小实现 —— 分步开发文档

> 配套文档：`doc/DESIGN.md`（讲**为什么这样设计**）。本文件只讲**按什么顺序敲代码**。
> 每一步都保证「做完就能跑、就能看到东西」，不做需要两步才能验证的行为。

---

## 0. 怎么用这份文档

三条铁律：

1. **不许跳步。** 每一步的前置依赖都已列明，跳步的代价是调试一个你还没建立心智模型的系统。
2. **每步必须跑「验证」那条命令。** 看不到预期输出就别进下一步——LLM 项目里，靠猜往下写会连本带利地还回来。
3. **每步结束提交一次。** 没有 git 就复制一份 `src/` 备份。后面调 prompt 会反复把代码改坏，你需要一个能回退的点。

### 总览与依赖

| 步骤 | 内容 | 依赖 | 有无 LLM | 对应里程碑 |
| :-- | :-- | :-- | :-- | :-- |
| S0 | 环境与骨架 | — | 无 | M0 |
| S1 | 类型契约 `types.ts` | S0 | 无 | M0 |
| S2 | Schema 层 + 加载器 | S0 | 无 | M0 |
| S3 | `store.ts` 页面读写 | S1 | 无 | M1 |
| S4 | `links.ts` 链接解析 | S3 | 无 | M1 |
| S5 | `reindex.ts` + `status` | S4 | 无 | M1 |
| S6 | `llm.ts` 结构化调用 | S1 | **有** | M2 |
| S7 | Pass 1 `extract` | S6 | 有 | M3 |
| S8 | Pass 2 `plan` + `--dry-run` | S7 | 有 | M3 |
| S9 | Pass 3 `apply` + 原子落盘 | S8 | 有 | M3 |
| S10 | `manifest` 增量与续跑 | S9 | 有 | M4 |
| S11 | `update` / `link` / `noop` + 复利实验 | S10 | 有 | M4 |
| S12 | `query.ts` 问答 | S5 + S6 | 有 | M5 |
| S13 | 可选扩展 | S12 | 有 | M6 |

**S0 ~ S5 全程不需要 API Key**，可以先把「不必动脑的部分」一次性写完。
**S6 是分水岭**，从这一步起每次调试都要花钱，所以 S7 之前的准备工作要扎实。

---

## S0. 环境与骨架

**目标**：`pnpm dev status` 能跑起来并打印「0 页面」。

**改哪些文件**

```
package.json  tsconfig.json  .gitignore  .env.example
src/cli.ts    src/env.ts
raw/llm-wiki-intro.md      （从 doc/wiki.md 复制）
空目录：wiki/ schema/ .state/
```

**实现要点**

1. `node -v` 确认 ≥ 20（要原生 `fetch` 和 `node:util` 的 `parseArgs`）。
2. 依赖只装四个，多一个都不要：
   ```bash
   pnpm add openai zod gray-matter
   pnpm add -D typescript tsx @types/node
   ```
3. `package.json` 的 scripts：
   ```jsonc
   {
     "dev": "tsx src/cli.ts",
     "typecheck": "tsc --noEmit"
   }
   ```
4. `tsconfig.json` 关键项：`"strict": true`、`"module": "nodenext"`、`"moduleResolution": "nodenext"`、
   `"target": "es2023"`、`"noUncheckedIndexedAccess": true`。最后一项很重要——
   解析 frontmatter 时经常出现「可能是 undefined」，类型系统会逼你处理掉。
5. `src/cli.ts` 只做三件事：`parseArgs` 解析、分发到命令、`catch` 后 `process.exit(1)`。
   命令实现先全部是 `console.log('TODO')` 占位。
6. `src/env.ts`：读环境变量并**在缺失时抛出清晰错误**，不要留到调 LLM 时才报 401。
7. 把 `doc/wiki.md` 复制为 `raw/llm-wiki-intro.md`（原始素材层保持只读，改素材只改 raw 下的副本）。

**验证**

```bash
pnpm dev status
# 期望：0 页面，0 死链     ← 因为 wiki/ 是空的
pnpm typecheck
# 期望：无输出（无类型错误）
```

**坑**

- Windows PowerShell 下 `pnpm dev -- --dry-run` 的参数透传会多一个 `--`，`parseArgs` 配置里
  记得 `allowPositionals: true`，并且用 `node:util` 的 `parseArgs` 而不是手写 `process.argv` 切片。
- `.gitignore` 别忘了 `.state/`、`.env`；但**不要**忽略 `wiki/`——它是产物，也是要看的成果。
- **退出码要逐个验一遍**（`pnpm dev; $LASTEXITCODE`）：`status`/`reindex`/`--help` 应为 0，
  无参数、未知参数、未知命令、以及所有未实现的命令应为 1。
  最容易写错的是 `--help`：如果 `--help` 分支复用「没给命令」的判定，它会被算成用法错误而返回 1。

---

## S1. 类型契约 `types.ts`

**目标**：把所有跨模块的数据形状一次性定死在文件里。**先写类型，再写实现**，这是本项目最重要的一条纪律。

**实现要点**

```ts
// 页面类型枚举，与 schema/taxonomy.md 必须一致
export const PAGE_TYPES = ['source', 'concept', 'entity'] as const;

// ① Wiki 页面：frontmatter + 正文
export interface PageMeta {
  id: string;              // 例 concepts/retrieval-augmented-generation
  type: 'source' | 'concept' | 'entity';
  title: string;
  oneLiner: string;        // 索引卡片用，10~20 字
  aliases: string[];
  tags: string[];
  sources: string[];       // 指向 raw/ 下的文件
  updated: string;         // YYYY-MM-DD
}
/**
 * body **包含**由 reindex 维护的反向链接区块。
 * 因此任何「分析本页链接」的地方都必须先剥掉它，见 S4 的 parseOwnLinks。
 */
export interface Page {
  meta: PageMeta;
  body: string;
  /** schema 未声明的 frontmatter 字段，原样保留，否则手加字段会在 reindex 时被静默抹掉 */
  extraMeta?: Record<string, unknown>;
}

// ② Pass 1 产物
export interface Extract {
  summary: string;
  claims: string[];                                  // 带事实的断言，供 plan 判断该写进哪个页面
  entities: { name: string; kind: string; evidence: string }[];
  concepts: { name: string; definition: string; evidence: string }[];
  relationHints: { from: string; to: string; relation: string }[];
}

// ③ Pass 2 产物：操作计划（判别联合，不要写成一个带 optional 字段的大接口）
export type Op =
  | { op: 'create'; type: PageMeta['type']; title: string; oneLiner: string; reason: string }
  | { op: 'update'; targetId: string; patch: string; reason: string }
  | { op: 'link';   fromId: string; toId: string; reason: string }
  | { op: 'noop';   reason: string };

// ④ 索引
export interface IndexEntry {
  id: string; type: PageMeta['type']; title: string; oneLiner: string;
  tags: string[]; outLinks: string[]; inLinks: string[]; updated: string;
}
export interface WikiIndex { pages: IndexEntry[]; generatedAt: string; }

// ⑤ manifest
export interface PassState { extract: string; plan: string; apply: string; }  // 'ok' | 'failed: …' | 'pending'
export interface ManifestEntry {
  hash: string; compiledAt: string; appliedOps: string[]; passes: PassState;
}
```

对应的 zod schema **紧跟类型定义写在同一个文件**，用 `z.infer` 反推类型，
但**建议手写 interface + zod 双份**：zod 推导出的类型在错误提示里可读性差，学习阶段手写更清楚。

**验证**

```bash
pnpm typecheck
```

**坑**

- `Op` 一定要用**判别联合**。写成 `{ op: string; targetId?: string }` 会让 S9 的 `switch` 失去穷尽性检查，
  到 S11 加 `noop` 时会漏掉分支。
- 别把 `body` 里的 `[[id]]` 抽成结构化字段。正文保持纯字符串，链接信息由 S4 按需解析——
  否则每次改写正文都要同步维护两份数据，必然不一致。

---

## S2. Schema 层

**目标**：`schema/*.md` 写出来，`schema.ts` 能按名加载。

**实现要点**

1. 四个文件的内容照 `doc/DESIGN.md` §6 落地：`rules.md`（维护规则）、`taxonomy.md`（类型与 slug 规范）、
   `query.md`（回答元规则）、`templates/` 三个骨架。
2. `taxonomy.md` 里必须明确 **slug 生成约定**，因为中文标题转文件名是绕不开的问题：
   - 优先用英文专名（`retrieval-augmented-generation`）
   - 无英文名时用**中文拼音全拼**（`fu-li-xiao-ying`），不要留中文字符做文件名
   - 同一 concept 重复出现时以已有页面为准（由 S8 的卡片列表保证）
3. `src/schema.ts` 暴露三个函数：
   ```ts
   loadRules(): string          // rules.md 全文
   loadQueryRules(): string     // query.md 全文
   loadTemplate(type): string   // templates/<type>.md
   ```
   全部**带缓存**（进程内 Map），因为一次 compile 会调用几十次。

**验证**

```bash
pnpm dev status
# 临时在 cli.ts 里打印 loadRules().length，确认能读到文件；确认后删掉
```

**坑**

- 把 schema 当作**提示词的一部分**，而不是独立文档。写法上要用命令式、可判定的句子
  （「必须」「禁止」「超过 400 字则拆分」），避免「尽量」「建议」——LLM 对后者基本无视。
- 不要在 schema 里写具体业务内容（比如「RAG 是查询时做功」），只写**规则**。具体内容是原材料的职责。

---

## S3. `store.ts` 页面读写

**目标**：能在 `wiki/` 下读写带 frontmatter 的页面，且写入是原子的。

**实现要点**

```ts
readPage(id: string): Promise<Page>             // 不存在则抛错；frontmatter 非法时指出具体字段
writePage(page: Page): Promise<boolean>         // 内容未变则不落盘，返回是否真的写了
listPageIds(): Promise<string[]>                // 递归扫 wiki/，排除 index.md
pagePath(id: string): string                    // id ↔ 磁盘路径的唯一定义处
slugify(title: string): string
nextFreeId(type: PageType, slug: string): Promise<string>   // 冲突时加 -2、-3 后缀
withBody(page: Page, body: string): Page        // 换正文但保住 meta 与 extraMeta
removeStaleTempFiles(): Promise<number>         // 清理崩溃残留的 *.tmp
```

四个细节决定了后面调试的难易：

1. **`pagePath` 只写一次**。所有模块都调它，绝不出现字符串拼接路径。
   顺手加一道防线：id 里出现 `..`、前导 `/` 或为空就直接抛错——id 可能来自 LLM 或页面正文。
2. **原子写**：先写 `xxx.md.tmp` 再 `fs.rename`。否则 S9 中途崩溃会留下半截文件，
   而 `listPageIds` 会把它当合法页面读进来。
   **rename 必须带退避重试**（`EPERM`/`EACCES`/`EBUSY` 各重试 5 次）：Windows 上杀软与索引器
   会短暂占用刚写过的文件，本项目连续跑 3 次 `reindex` 就复现过 `EPERM: rename ... index.md.tmp`。
   同时在 `ensureDirs` 里挂上清理残留 `*.tmp` 的动作——它们被 `listPageIds` 排除，会无声堆积到永远。
3. **frontmatter 字段顺序固定**（按 S1 的 `PageMeta` 顺序输出）。这样 `git diff` 干净，
   后面验证「字节级不变」才有意义。用 `gray-matter` 的 `stringify`，但自己控制 key 顺序。
4. **未声明的 frontmatter 字段要原样保留**。zod 默认会剥掉未声明的键，于是用户手加的
   `priority: high` 会在下一次 reindex 回写时被静默抹掉——这种丢数据最难排查。
   做法是把被剥掉的键收进 `extraMeta`，渲染时排在已声明字段之后。
   **任何改写正文的地方都用 `withBody(page, body)`，不要手写 `{ meta, body }`**，否则迟早漏掉它。

**验证**

写个临时脚本（或临时 CLI 命令 `debug:store`）：构造 3 个假页面 `writePage` 落盘 → `listPageIds` 读回
→ `readPage` 拿到的 `meta` 与写入一致。**先用手写假页面，不要等 LLM 通了再测存储层**，
否则存储层的 bug 会被误判成「LLM 输出不对」。

**坑**

- `gray-matter` 会把 YAML 里不带引号的 `updated: 2026-10-12` 解析成 **`Date` 对象**。
  若按 `z.string()` 校验，手写页面便会直接报「frontmatter 不合法」（本项目实现时已实测踩到）。
  正确做法是**在读入侧归一化**：`z.union([z.string(), z.date()]).transform(formatDate)`；
  写入侧由 js-yaml 固定输出带引号的 `'2026-10-12'`。两侧都不丢信息，且不依赖用户记得加引号。
- 日期一律用本地时间格式化，不要用 `toISOString()`——那是 UTC，东八区凌晨会算成前一天。
- Windows 路径分隔符：`id` 内部一律用 `/`，只在 `pagePath` 里转成 `path.join`。

---

## S4. `links.ts` 链接解析

**目标**：能从正文里抽出 `[[id|显示名]]`，能整体替换正文（供反向链接区块使用）。

**实现要点**

```ts
parseLinks(body: string): string[]                        // 纯语法解析，去重，保持出现顺序
parseOwnLinks(body: string): string[]                     // = parseLinks(stripAutoBacklinks(body))，分析出链只能用这个
stripAutoBacklinks(body: string): string                  // 剥掉 <!-- AUTO-BACKLINKS --> 之后的内容
renderBacklinks(inLinks: string[]): string                // 生成「## 反向链接」区块（含哨兵注释）
withBacklinks(body: string, inLinks: string[]): string    // 先剥后写
findDeadLinks(body: string, known: Set<string>): string[]
replaceLinkDisplay(body: string, id: string, name: string): string
```

正则不要贪心跨行：`/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g`。

**`parseOwnLinks` 与 `parseLinks` 必须分开，这是本项目最隐蔽的一个坑（已实测踩到）**：
页面 body 里包含了 reindex 写入的反向链接区块，而那个区块里装的是**别人的链接**。
若分析出链时直接用 `parseLinks`，就会形成

```
我的入链  →  被当成我的出链  →  变成对方的入链  →  对方被回写  →  下一轮继续放大
```

的死循环：链接图越算越错（`hub` 的 outLinks 里凭空多出 keeper/linker），
回写次数永不归零（幂等性失效），甚至可能长期振荡。**一道防线不够，要两道**：
`parseOwnLinks` 兜住分析侧，`withBacklinks` 的先剥后写兜住写入侧。
写完 S5 必须跑「连续 3 次 reindex，第二次起回写数必须是 0」来验证这个环确实被切断了。

**这是全项目唯一需要「小心写」的纯函数**，建议直接写单测（`node:test` 即可，不必引 vitest）：

```
"见 [[concepts/rag]]"                          → 1 个链接
"见 [[concepts/rag|RAG 模式]]"                  → id 正确、别名正确
"[[a]] 与 [[a]]"                                → 去重为 1
"[[ ]] 与 [[a|]]"                               → 忽略非法链接
```

**坑**

- **哨兵注释 `<!-- AUTO-BACKLINKS -->` 是幂等性的关键**。`stripAutoBacklinks` 必须先剥后写，
  否则 S10 重编译时反向链接会一层层叠加。
- 反向链接区块永远追加在正文**末尾**，且只有非空时才渲染。

---

## S5. `reindex.ts` + `status`（M1 完成）

**目标**：一条命令从 `wiki/*.md` 重建全部索引与反向链接。

**实现要点**

1. `listPageIds` → 逐个 `readPage` → 组装 `IndexEntry`（`outLinks` 来自 `parseLinks`）。
2. **两趟计算**：第一趟建 `id → entry`，第二趟才填 `inLinks`（因为反向链接依赖别人已经解析完）。
3. 写回每个页面的反向链接区块：`writePage({ meta, body: stripAutoBacklinks(body) + renderBacklinks(inLinks) })`。
   **只在内容真变化时才写盘**，避免每次都刷新 `updated` 时间戳。
4. 生成 `wiki/index.md`：按 type 分组，每行 `- [[id]] — oneLiner`。
5. 写 `.state/index.json`。
6. `status` 命令输出四行：
   ```
   页面：12（concept 8 / entity 3 / source 1）
   死链：2    ← 列出 id 与所在页面
   孤立页：1  ← 没有任何 inLinks 的页面（index.md 除外）
   未引用素材：0
   ```

**验证（M1 验收）**

```
① 手写 3 个假页面：A 链 B、B 链回 A、C 链一个不存在的 id
   → index.json 正确；A、B 互为反向链接；死链 1 条；孤立页只有 C
② 连续跑三次 reindex：从第二次起「回写 N 个文件」必须都是 0
   → 这是唯一能证明反馈环已被切断的检查，千万不要只看一次
③ 给某个页面加一个 schema 未声明的字段（如 priority: high），
   再制造一次真实回写（让别的页面链向它），确认该字段仍在，且排在 updated 之后
④ 手工删掉 .state/ 与 wiki/index.md，再跑 status：两份派生数据应自动重建
```

第 ② 条如果失败（回写数不归零或链接图出现凭空多出的出链），
说明分析出链时用了 `parseLinks` 而不是 `parseOwnLinks`，回到 S4 看那个反馈环。

**坑**

- **自动 reindex 的触发条件**要写在这一步，四条缺一不可（本项目实现时已实测踩到第二条）：
  （a）`index.json` 不存在；
  （b）**页面 id 集合与索引里记录的不一致**；
  （c）`wiki/` 里有文件的 mtime 晚于 `index.json`；
  （d）`wiki/index.md` 不存在。
  只写 (a)+(c) 会漏掉「删除页面」——删文件不会更新任何现存文件的 mtime，
  于是索引里留着幽灵条目、`index.md` 里留着幽灵链接，而所有命令都以为索引是新鲜的。
  另外别写成「每次命令都全量 reindex」，S12 的 query 会因此变慢；也别写成「从不自动」，
  否则删掉 `.state/` 后 query 直接报错。
- **验收这条设计承诺**：把 `.state/` 整个删掉、`wiki/index.md` 也删掉，再跑 `status`，
  两份派生数据都应自动重建，而 `manifest.json` 不应被凭空造出来（那会伪装成「已编译」）。
- `wiki/index.md` 自己不能出现在索引里，否则它会成为一个被所有人链接又链接所有人的怪页面。

---

## S6. `llm.ts` 结构化调用（M2，第一个花钱的步骤）

**目标**：一个函数，输入 prompt 与 zod schema，输出**保证合法**的 JS 对象。

**实现要点**

```ts
async function callStructured<T>(args: {
  tag: string;              // 'extract' | 'plan' | 'apply' | 'select' | 'answer'，用于 passes 落盘
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxRetries?: number;      // 默认 2
}): Promise<T>
```

调用循环（**这是本项目最值得抄走的一段代码**）：

```
attempt = 0
loop:
  raw = await chat(system, user)            // temperature 建议 0.2，不用 0（会退化成复读）
  落盘 .state/passes/<tag>-<ts>-attempt<N>.json  { system, user, raw }
  try: json = JSON.parse(stripFences(raw))
  catch: 把「你的输出不是合法 JSON」+ 原始输出 追加进 messages → retry
  result = schema.safeParse(json)
  if (!result.success):
     把「zod 报错路径 + 原始输出」追加进 messages → retry    ← 关键：把错误喂回去，而不是原样重试
  if (attempt++ >= maxRetries) throw new Error(...)
  return result.data
```

要点：

- `stripFences`：去掉 LLM 爱加的 ```json 围栏。
- **重试必须携带错误信息**。原样重试等于浪费一次调用（LLM 不知道自己错了）。
- 统计调用次数（模块内计数器 + `reportCalls()`），S10 的验收标准 1 需要它。
- `passes` 落盘要记录**实际发出的 `messages`**，而不是原始的 `system`/`user`。
  重试时 `messages` 里多了上一轮的原始输出与错误说明，只记 `system`/`user` 会让两次调用
  看起来一模一样——本项目就因此误判过「它卡在重试里没有新记录」，其实记录一直在写，只是内容相同。
- `text()`（不校验结构的那条路径）**也要重试传输层失败**。否则它和 `structured()` 行为不对称，
  而问答的生成步骤恰好用的是它——免费档一次超时就整个失败。

**验证**（**这一步完全不需要 API Key**：把 `chat` 做成可注入依赖，用假实现就能测完）

```
① 裸 JSON / ```json 围栏 / 前后夹带解释文字 / 顶层数组 → 都能解析出来
② 结构不符 → 第二次调用必须带上「模型上一次的原始输出」和「具体哪个字段错了」
③ 坏 JSON → 与 ② 走同一条重试路径
④ 重试用尽 → 抛出的错误里必须包含最后一次的原始输出
⑤ .state/passes/ 下有落盘，且同一 tag 只保留最近 5 份
⑥ 缺环境变量 → createLlmClient 立刻抛出可读错误，而不是等发请求时才 401
⑦ 空内容 → 报错要指向 reasoning_content 这个具体嫌疑（思考型模型会把答案放那儿）
⑧ 中文文本里的裸双引号 → 必须能救回来（见下）
⑨ text()：传输层失败重试两次后成功；重试用尽抛出最后一次的错误
```

以上 9 条已落成 `tests/llm.test.ts`（`pnpm test`）。

**最值得单独记住的一个坑：中文模型会写出未转义的 ASCII 双引号（实测）**

接真实模型（智谱 `glm-4.5-flash`）后第一次编译就死在这里：一条 2310 字的响应里出现
**204 个裸 `"`、0 个中文引号**——它在中文文本里直接写 `"` 且不转义，于是
`{"summary":"它用"提前编译"替代传统RAG的"临时检索"…"}` 在第 135 个字符处就不是 JSON 了。
三次重试全都复现同一种错误。两道防线一起上：

1. **提示词侧**：所有要求结构化输出的提示词共用一句
   「字符串内部一律使用中文引号「」或转义后的 `\"`，不要出现未转义的英文双引号」。
   实测加上之后 extract 一次通过、零重试。
2. **程序侧**：`escapeInnerQuotes()` 做语法层修复——扫描文本，处在字符串内部时遇到 `"`
   就向后看第一个非空白字符：是 `,` `:` `}` `]` 或已到结尾才算真闭合，否则它就是正文里的引号，转义之。
   **不要用「找第一个 { 到最后一个 }」这种粗暴修复**，那修不了字符串内部的引号。
   修复只在正常 `JSON.parse` 失败后作为第二手段启用。

另外注意报错本身也会误导人：如果错误信息打印的是**带围栏的原文**，看起来就像「围栏没剥掉」，
而真实原因是 JSON 非法。打印实际试图解析的那段文本。

**坑**

- **不要用 SDK 的 `response_format: json_schema`** 作为唯一保障。DeepSeek / Ollama 的支持度参差不齐，
  用「提示词要求 JSON + zod 校验 + 带错误重试」这条通用路径，换任何后端都能跑。
- `maxRetries` 到顶时抛出的错误必须**包含最后一次的原始输出**，否则你只知道失败了，不知道错在哪。
- **必须关掉 SDK 自己的重试**（`maxRetries: 0`）：它和外层重试会**叠乘**，
  最坏情况 3 × 3 × 超时 = 单趟十几分钟卡在一个请求上（本项目实测卡过 4 分钟无输出）。
  重试的决定权要留在**会落盘、能诊断**的那一层。
- 超时要**可配置**（`GLK_LLM_TIMEOUT_MS`，默认 180s）。固定的 120s 在免费档高峰期实测被突破过。
- 传输层失败（超时/断连）**不要**把「超时」当成模型的结构化错误喂回去——那跟它的输出无关，
  原样重试即可，否则白白浪费一次调用。

---

## S7. Pass 1：`extract`

**目标**：`pnpm dev compile raw/llm-wiki-intro.md --only-extract` 打印出结构化的抽取结果。

**实现要点**

- system = `loadRules()` + 「你是抽取器，只做抽取，不做决定。输出必须是 JSON」
- user = 原材料全文 + `Extract` 的 JSON 形状说明 + 「`evidence` 必须逐字摘自原文」
- 结果落 `.state/passes/extract-raw/llm-wiki-intro.md.json`（按素材名，便于复跑对比）

`compile.ts` 这一阶段的骨架：

```ts
async function compileOne(rawRelPath: string, opts: CompileOpts) {
  const text = await readRaw(rawRelPath);
  const extract = await extractPass(text);
  const plan = await planPass(extract, await loadIndex());
  const applied = await applyPass(plan, rawRelPath);
  await reindex();
  return applied;
}
```

**验证**

人工检查三件事（这一步无法自动化）：

1. `concepts` 是否抓到了 `RAG` / `LLM Wiki` / `编译器模式` 这类真概念，而不是「介绍」「特点」这种空词。
2. 每条 `evidence` 是否**真的能在 `raw/llm-wiki-intro.md` 里搜到**（程序可查：断言它是否原文子串）。
3. `relationHints` 是否抓到了 **RAG ↔ LLM Wiki 的对比关系**——这是本文档最有价值的一条边。

**「逐字」判定要宽容到只忽略排版差异（这里连续踩了两次）**

`evidence` 的用途是给摘要页做「原文摘录」，所以必须能验证它真的来自原文。但**模型抄录时会做
一串无害的字符规范化**，如果比对太严，一条真实存在的摘录会被判成「编造」而丢弃——
这是最难发现的错误：日志显示「丢弃 N 条」，看起来像模型在编造，实际是校验器在误伤。

实测踩到的两种（各自丢掉了真实摘录）：

| 模型做的事 | 原文 | 模型抄的 | 处理 |
| :-- | :-- | :-- | :-- |
| 去掉 Markdown 强调记号 | `**Andrej Karpathy**` | `Andrej Karpathy` | 比对前剔除 `` ` `` `*` `_` `~` `>` |
| 把弯引号写成直引号 | `“复利效应”` | `"复利效应"` | 比对前把所有引号变体统一 |
| 全角标点换半角 | `（只读）、` | `(只读),` | `normalize('NFKC')` 覆盖这一类 |

注意 `NFKC` **不**处理弯引号 → 直引号（U+201C 没有到 U+0022 的兼容分解），必须单独写一条映射。

不会因此放过「改写」：改写动的是**用词与语序**，归一化只动排版字符。
实现时顺手把「丢了几条」拆成两个数字，因为它们是两件完全不同的事：

- `notVerbatim`：没能逐字命中——**值得警惕**，可能是模型改写了措辞
- `duplicates`：逐字命中但已收录——**完全正常**，多个实体共用同一句原文很常见
  （本项目实测：一句列出四个工具的话被 4 个实体引用）

混成一个「丢弃 N 条」的日志，会让人得出相反的结论。

**坑**

- 抽取结果里出现「列表」「总结」「特点」这类词，说明 `rules.md` 的第 2 节不够硬。**先改 schema，别改代码。**
- 如果不给 `Extract` 的 JSON 形状，LLM 会自由发挥出嵌套五层的结构。形状说明要**带一个具体示例**。
- **阈值不能只按字符数定到很小**：比对前会剔除空白与标点，短片段（如「复利效应」4 个字）
  在长文里太容易伪命中，所以设了 6 个字的门槛。

---

## S8. Pass 2：`plan` + `--dry-run`

**目标**：能看到一份操作计划，且 `--dry-run` 不污染 `wiki/`。

**实现要点**

- system = `loadRules()` + `taxonomy.md` + **「你只能输出 Op 数组」** + Op 的四种形状说明
- user = `JSON.stringify(extract)` + **卡片列表**（从 `index.json` 取 `id / type / title / oneLiner / tags`）
  + 「wiki 当前为空」这类状态说明
- **卡片列表为空时**（首次编译）要显式告诉 LLM「此时只可能 create，不可能 update」，
  否则它会凭空编出 `update` 一个不存在的 `targetId`
- `--dry-run`：跑完 extract + plan 后直接打印并退出，**不调用 applyPass、不写 manifest**

计划打印格式（按 op 分组，一眼能看出它想干什么）：

```
[create] concept  检索增强生成（RAG）        ← 查询时做功的解释器模式
[create] concept  编译式知识管理              ← 摄入时批量整理的结构化知识层
[update] concepts/llm-wiki                    ← 在「与 RAG 的对比」下补充成本对比
[noop]  无                            ← 已有页面已覆盖「复利效应」
```

**验证**

```
① pnpm dev compile --all --dry-run     → 打印计划，git status 显示 wiki/ 无任何改动
② 计划里 create 数量在 4~8 之间（少于 4 说明 rules.md 的粒度太粗，多于 8 说明太细）
③ 反复跑 3 次 dry-run，观察计划的**稳定性**。如果每次差异巨大，先把 temperature 降到 0.1
```

**坑**

- 这是全项目**最需要反复调 prompt 的地方**。请在这里多花时间，别急着进 S9——
  计划错了，apply 写得再对也是错的。
- 若 LLM 倾向「每次都要 create 新页面」，在 rules.md 里加一条硬规则：
  「若卡片列表中存在语义等价的标题或别名，必须 update，禁止 create」。
- `title` 让它给**中文显示名**，slug 由程序（`slugify`）生成。别让 LLM 直接给文件名。

---

## S9. Pass 3：`apply` + 原子落盘（M3 完成）

**目标**：跑完一次 compile，`wiki/` 下出现 4~8 个互相链接的页面。

**实现要点**

严格按 DESIGN §4 的三段式：

```
① 内存装配（不落盘）
   for op of plan:
     create → system = rules + templates/<type>.md；user = extract 摘要 + 该页面应覆盖的内容
               结果 = { meta: {...程序生成 id/updated/sources}, body }
     update → 先 readPage(targetId)，把 body + patch 指令一起给 LLM
              要求「返回完整的新正文，保持已有段落顺序」   ← 关键：返回全量，不是 diff
     link   → 不调 LLM，纯字符串改写（replaceLinkDisplay 或追加一个「相关页面」小节）
     noop   → 跳过
② 统一校验（全部通过才继续）
   · 同批 create 的 slug 与现有 id 不冲突（冲突走 nextFreeId）
   · 同批内 title 重名 → 合并为一个页面，其余 op 转成 link
   · body 里所有 [[id]] 必须存在于「现有 id ∪ 本批 create 的 id」   ← 否则 A 引用 B 会误判死链
   · 校验失败 → 只重试这一个 op，把「id 不存在」的错误喂回去
③ 原子落盘（逐个 writePage，已由 S3 保证原子）
```

新增一条校验（极易搞错）：**frontmatter 的 `sources` 与正文里的 `[[...]]` 语义不同**——

- `sources` 填 `raw/llm-wiki-intro.md`（溯源指针），必须能在 `raw/` 下找到
- 正文「出处」里的 `[[sources/llm-wiki-intro]]` 是**页面 id**（指向 wiki 摘要页，无扩展名）

把这两者混用会立刻产生死链，而这条错误几乎必然出现在 LLM 的第一次输出里。

**接真实模型后，这一阶段暴露了三个必须处理的现实问题**（都已在代码里修掉）：

**① 摘要页 id 必须出现在「可链接的页面 id」清单里。**
摘要页是**程序**创建的，模型无从猜到确切写法；而模板却要求它在「出处」小节链接摘要页。
少了这一条，模型只能拿手上唯一的素材路径去凑，于是写出 `[[raw/llm-wiki-intro]]`（甚至
`[[sources/raw/llm-wiki-intro]]`），重试时喂回去的错误是「id 不存在」——**它无从修起**，
只能重复犯错。这条契约缺陷让一次真实编译彻底卡死。清单里要把它连同用途一起写明：
`sources/llm-wiki-intro — 本素材的摘要页（程序本次创建）。「出处」小节请链接它，不要写 raw/ 路径`。

**② 重试反馈必须「可执行」，不能只说「id 不存在」。** 实测模型会拿**标题**去拼 id：
`[[concepts/LLM Wiki]]`——前缀对、末段是标题、还带了个空格，而它要的其实是 `concepts/llm-wiki`。
反馈里直接给出正确写法（`你要的是 [[concepts/llm-wiki]]`）比让它自己去清单里翻快得多。
就近匹配用 `suggestId()`：剥掉类型前缀后按已有的标题/别名归一化键比对。
免费档上一次重试就是 30~60 秒，**把改法说清楚的价值是可量化的**。

**③ 长正文要放在 JSON 的最后一个字段。**
输出形状写成 `{"tags":[...],"aliases":[...],"body":"..."}`，而不是把 `body` 放最前。
实测模型会在 `body` 这个长中文字符串结束处「忘了自己在写 JSON」，把下一个键的引号打成
`'tags":`——三次重试一字不差地复现。把结构字段提到前面、尾巴只剩 `"}`，这类错误就少得多。

**结构化输出彻底失败时要有纯文本兜底**：捕获 `structured()` 的错误后，改调 `text()`
要「纯 Markdown 正文」，代价是这一次拿不到 `tags`/`aliases`（可选字段，沿用页面已有值即可）。
实现要点：兜底用的 prompt 必须**真的去掉**「输出 JSON」那句和那个输出示例，
否则只是换个说法继续失败；而构造 user 提示词时**不要用正则**去替换输出示例
（前面「抽取结果」的 JSON 里同样有花括号，正则会打错目标），
把输出说明固定成数组的最后一项、按位置切掉即可。这条路径要有离线验收——本项目第一版就是
「实现了但没有测试覆盖」，而假模型永远返回合法 JSON，永远走不到它。

**验证（M3 验收）**

先跑**不需要 API Key** 的离线冒烟（`scripts/offline-smoke.ts` 注入假模型，跑完自动清理产物）：

```bash
pnpm smoke            # 跑一遍并自动清理产物
pnpm smoke --keep     # 保留 wiki/ 产物，人工检查 frontmatter / 反向链接 / 索引
pnpm smoke --dry-run  # 断言「dry-run 一个字节都没写」
```

期望看到的轨迹：不可达的 link op 被跳过并打印原因；某个页面的第一次正文因链接不可达被退回、
带上原因重试后通过；最后 `reindex → N 个页面 · 死链 0`。
再跑一次 `pnpm smoke --keep`，此时 wiki 非空 —— 假模型的 create 会全部被**收敛为 update**，
页面总数不变、不出现 `-2` 后缀的重复页。

做到这一步必须能通过下面四项检查（都是踩过坑才加的，别省）：

| 检查 | 怎么看出来 |
| :-- | :-- |
| 链接不可达会带着原因重试 | 轨迹里出现「收到提示后重试成功」，而不是直接失败 |
| create 收敛为 update | 第二次编译日志出现「已有同名页面，create 收敛为 update」，页面数不变 |
| 同一页被多条 op 命中只编辑一次 | 第二条 link op 与 create 收敛出的 update 指向同一页时，`apply` 只报一次那页 |
| dry-run 不落盘 | `pnpm smoke --dry-run` 断言 wiki/ 与 manifest 均未改动 |
| **重编译后 source 页的「相关页面」不变** | 两次 `pnpm smoke --keep` 后对比该小节，逐字相同 |

接上真实模型后跑：

```
① pnpm dev compile raw/llm-wiki-intro.md
   → wiki/ 出现 4~8 个页面，concepts/ 与 entities/ 都有内容
② pnpm dev status
   → 死链 0；孤立页可以有（首次编译时正常）
③ 打开 wiki/concepts/*.md 人工检查：
   · 每个 [[链接]] 点进去都能找到对应文件
   · 每个概念页都有「出处」，且摘录能在 raw/llm-wiki-intro.md 里搜到
④ 检查 index.md 生成正常
```

**坑**

- `update` 让 LLM 返回**完整正文**而不是 diff。diff 格式（patch/替换片段）在 LLM 手里错误率极高，
  而全量重写在几百字的页面上成本可以忽略。这个取舍在 S11 会再一次印证。
- **给模型的「页面现状」必须剥掉反向链接区块**（已实测踩到）。若把含 `<!-- AUTO-BACKLINKS -->`
  的完整正文交给它，模型很容易把新内容追加到区块之后，而 `sanitizeDraftBody` 会从哨兵处截断——
  于是新增内容被静默丢弃，页面看起来「更新了」其实一个字没变。正确做法是
  `stripAutoBacklinks(current.body)` 之后再放进提示词。
- **create 必须有一道「已有同名页面则收敛为 update」的兜底**（已实测踩到）。别信 `rules.md` 里
  「优先 update」的约定：清单非空时模型照样会返回 create，此时按 `nextFreeId` 加 `-2` 后缀
  就造出了重复页，而重复页会各自长出反向链接，事后几乎无法合并。
  做法是用 `title` + `aliases` 建一个归一化索引，命中就把 create 改写成 update，
  并把这次改写打进日志——**不要静默改写模型的意图**，否则你不知道它在乱来。
- **source 摘要页的「相关页面」不能用「本批新建的 id」来生成**（已实测踩到，后果最严重）。
  重编译时没有任何新建页，那个列表会变成空 → 「相关页面」被清空 → source 页与整张知识网络断开，
  而且结果不再幂等（第一次编译有链接、第二次没有）。正确做法是把抽取出的概念/实体名
  按**标题与别名归一化后映射到已有页面**上：首次编译映射到的正是刚建出的页面，
  后续编译映射结果不变。别忘了一并做全角括号/大小写的归一化，模型抽出的名称常与页面标题差几个字符。
- **同一个页面被多条 op 命中时必须合并 patch**（已实测踩到）。`create` 收敛出的 update 与指向
  同一页的 `link` 折出的 update 会撞在一起；若各自生成一份正文，后写的那份会覆盖先写的编辑，
  而两次生成的输入都是**同一份旧正文**，所以先写的那次改动直接凭空消失。
  做法是在 `planToWorkItems` 里按 id 合并，天然只调用一次模型。
- 「相关页面」小节的排序要稳定（按 id 排序），否则每次编译都产生无意义的 diff。
- 第一次编译大概率会产出**过长**的页面（LLM 喜欢写全）。此时回去加强 `rules.md` 的 400 字限制，
  而不是在代码里截断——截断会切断链接语法。

---

## S10. `manifest` 增量与断点续跑（M4 前半）

**目标**：第二次编译零 LLM 调用；中断后重跑不重做已完成的 Pass。

**实现要点**

1. `hash = sha256(raw 文件内容)`。**不要**用 mtime，`git checkout` 会改 mtime 但内容不变。
2. **跳过条件是「所有 Pass 都是 `ok`」且 hash 未变**，别只查 `passes.apply`。
   正常流程下二者等价（apply=ok 必然意味着前两趟也 ok），但只要有人手工改过 manifest，
   或以后新增了能在 apply 之后失效的 Pass，只查 apply 就会静默沿用陈旧结果。
3. **Pass 级续跑**：每一步开始前查 `passes`：
   ```
   if (passes.extract === 'ok' && 缓存可反序列化回 Extract)  跳过，读缓存
   else  跑，把产物写进缓存文件，再把 passes.extract 置为 'ok' 并落盘
   ```
   顺序很关键：**先写缓存、再标记 ok**。反过来的话，进程在两者之间被杀就会留下
   「标记为 ok 但没有缓存」的状态——虽然下一轮会因读不到缓存而重跑（不至于出错），
   但 `passes` 记录的就不再是事实了。
   缓存文件放 `.state/passes/cache-extract-<素材路径>.json`，键用素材**相对路径**而不是文件名，
   否则 `raw/a/x.md` 与 `raw/b/x.md` 会互相覆盖。`plan` 同理，缓存 `{ops:[...]}`。
4. `appliedOps` 在 apply 成功后记录成 `['create:concepts/rag', 'update:concepts/llm-wiki']`。
5. `--force`：忽略 hash 与 passes，全量重跑（缓存会被覆盖，不删也行）。
6. 每个 Pass 用同一个 `try/catch` 包起来：失败就把该 Pass 写成 `failed: <首行原因>`（截断到 160 字）
   并立刻落盘，然后原样抛出。这样下一轮能准确地从失败的那一趟续上。
7. **dry-run 必须连缓存也不写**。`persist()` 与 `saveCache()` 都要在 dryRun 时变成空操作，
   否则「dry-run 不落盘」这条承诺就只剩 wiki/ 和 manifest 了。

**验证（验收标准 1、2、3）**

这一段的验收天然要「多次调用之间、甚至跨进程」才能观察，所以全部做成 `pnpm smoke` 里的断言
（三个检查函数，共 12 项）：

```
checkIncrementalAndResume
  ① 内容未变            → 跳过 1 份、LLM 调用 0 次
  ② passes.plan 改成 failed → extract 0 次（复用缓存）· plan ≥1 次 · apply ≥1 次
  ③ 续跑完成后          → 重新回到「跳过、0 次调用」
  ④ extract 缓存被写坏   → 退回重新抽取（1 次），而不是采信坏数据或直接崩

checkApplyFailureLeavesNoResidue
  ① apply 第 3 个草稿抛错 → wiki/ 里 0 个页面（前两个已装配在内存，也一个都不许落盘）
                           passes.apply = "failed: …"，extract/plan 仍是 ok
  ② 续跑                → extract 0 次 · plan 0 次 · apply ≥1 次，页面最终建出来

checkForceAndHashChange
  ① --force            → extract、plan 都 >0（忽略缓存与 manifest）
  ② 素材改一点点        → hash 变，三个 Pass 全部重跑
  ③④ 素材还原          → 第一次必然重跑（manifest 里存的是改过版本的 hash），第二次才跳过
```

写这套检查时踩到一个**测试框架自身的坑**：断言失败后脚本中途抛出，清理代码没执行，
于是 4 个页面留在了 `wiki/` 里，下一次运行看到的「初始现场」就是脏的。
所以清理必须放在 `try/catch` 之后的**无条件**路径上，并且失败时以非零码退出。

在真实模型上再补一条（离线假模型测不了）：

```
pnpm dev compile --all --force → 允许内容变化，但页面里不得出现同一段落两次
```

**坑**

- **每完成一个 Pass 就落盘**，不要在 compileOne 结束时统一写 manifest。
  否则「extract 成功、plan 崩了」会导致下次从头再来，而 extract 是长文本输入，最贵。
- `.state/passes/` 会随重试无限增长。加一条：同一 `tag + 素材名` 只保留最近 5 份。
  注意**裁剪要按 tag 前缀做，别把 `cache-*` 一起删掉**——缓存文件是续跑的依据，不是调试产物。
- 续跑日志只该列出真正能复用的 Pass（`extract` / `plan`）。把 `apply` 也写进「复用」是骗人的：
  上游一变，apply 必然重做（它没有缓存，也注定是纯写入）。
- **日志要基于「缓存真的读到了」，而不是基于 `passes` 的自述**（已实测踩到）。
  `passes.extract === 'ok'` 但缓存文件缺失或结构不符时，程序实际会重新抽取，
  可日志却写着「复用上次结果」——这种日志比没有日志更坏，它会让你在排查成本时得出相反结论。
  做法是先尝试读缓存，再根据读到的结果决定日志措辞。

---

## S11. `update` / `link` / `noop` 与复利实验（M4 完成，本项目的高光时刻）

**目标**：亲眼看到「新增一份素材 → 已有页面被改写并长出新的链接」。

**准备第二份素材**

手写 `raw/vector-search-notes.md`，内容要**与第一份有交集但不重复**，建议包含：

- 向量检索 / 嵌入 / 相似度的基本定义
- 一句明确关联既有的句子，例如「向量检索是 RAG 的检索阶段常用实现」
- 一个第一份素材里**没有**的新概念（如「召回率」）

交集是复利的燃料：**没有交集，就不会有 update**。

**这一步必须先加两道校验，否则「复利」会变成「慢性腐烂」**

更新是唯一会改动已有内容的操作，而模型改内容时最常犯两种错，两种都不会报错、只会让 wiki 慢慢烂掉：

1. **丢掉原有小节**（把整篇重写，顺手删掉一两节）
2. **新开兜底小节**把新事实堆进去（`## 补充说明` / `## 其他`）

做法是 `checkUpdateIntegrity(before, after)`：比对更新前后的**一级小节标题集合**——
原有标题必须全部还在、不许重复、不许出现兜底标题（黑名单在 `FORBIDDEN_HEADINGS`），
任一不满足就把问题喂回去重试。注意合法的新增小节（如 `## 局限`）不该被拦。

顺带加两条便宜但有用的校验：

- **自链接**（`checkSelfLinks`）：模型在「补一个相关链接」时真的会写出指向自己的链接
  （本项目实测踩到），它会凭空把这一页塞进自己的反向链接里。
- **正文超长告警**：`bodyLength` 超过 `rules.md` 的 400 字上限时只告警不截断——
  截断会切断链接语法，而「拆页」是模型的活（S13）。

**验证（M4 验收，DESIGN §9）**

离线部分已做进 `pnpm smoke`（`checkCompoundingUpdate`）：

```
① 编译第一份素材 → 4 个页面
② 编译第二份素材 → 新建 3 页 + 更新 2 页，其中**至少一个 update 落在已有页面上**
③ 该页面的**出链**新增了指向新页面的链接，且小节结构未变
④ 新页面的反向链接含刚更新它的页面（对称性）
⑤ 死链 0
```

第 ③ 步有个必须注意的写法：**断言一定要判「出链」，不能判正文文本**。
`readPage` 返回的正文里还带着**反向链接区块**，直接 `body.includes('[[concepts/vector-search]]')`
会被「别人指向我」满足，于是「我到底有没有指向别人」这件事根本没被验到——
本项目就是这么写出过一条假绿断言的。用 `parseOwnLinks()` 才判得准。

真实模型上的验收：

```
① 先记录编译前 wiki/concepts/retrieval-augmented-generation.md 的 hash
② pnpm dev compile --all --verbose
③ 日志里必须出现至少一个 [update]，并能看到它改了哪个页面的哪一节
④ 该页面文件的 hash 变了，且出链里新增了指向新概念页的 [[链接]]
⑤ pnpm dev status → 死链 0、反向链接对称
⑥ 再跑一次 compile --all → 两个素材都被跳过，LLM 调用 0 次
```

第 ③ 步是本项目的全部意义所在。如果只出现了 `create` 而没有 `update`，说明：

- **`rules.md` 的「更新优先于新建」不够硬** → 加一句「若存在语义等价的页面而选择 create，则整个计划无效」
- **卡片列表的 `oneLiner` 太短/太泛** → LLM 认不出这是同一个概念 → 把 `oneLiner` 写得更具区分度
- **`patch` 指令太模糊** → 改 `plan` 的 prompt，要求它必须写明「在哪个章节下、补充哪一句事实」

**坑**

- 这一步最容易出现「越更新越像流水账」：LLM 会把新素材整段粘进去。除了 `rules.md` 与 update prompt
  里的约束，`checkUpdateIntegrity` 是最后一道闸——它拦不住「在正确的小节里塞太多」，但拦得住
  「丢小节」和「开兜底小节」这两种结构性劣化。
- 如果 update 把页面写超过 400 字，要能触发**拆分**——这是 S13 的活，先记一笔，别在此处发散。

**实测记录：第一次跑真实模型时，复利效应完全没有发生**

第二份素材（向量检索笔记）的计划是 **5 个 create、0 个 update**，而且其中两页是同一个概念
（`向量检索技术` 与 `向量检索`）。归因到三个具体缺陷，都不是「模型太笨」：

1. **plan 提示词的输出示例只有 `create` 一种**，而且示例里的概念恰好就是它后来新建的那一页
   （`检索增强生成（RAG）`）。**示例比规则更有引导力**——你说「优先 update」，却只演示 create，
   模型就会 create。修法：示例里补一条 `update`，并说明「id 与标题都要替换成你实际要用的」。
2. **规则缺配套的判断过程**。`rules.md` 原本只有「若存在语义等价的页面，必须 update」这一条结果性规则，
   没有告诉模型**怎么判断**。修法：改成过程性要求——「对每个候选概念，先在清单里找语义等价的页面；
   找到即 update，找不到才 create」，并点明「语义等价看的是讲的是不是同一件事，不是名字像不像」。
   再加一句动机说明：「如果全是 create，说明你只是在堆摘要，没有在做知识管理。」
3. **同一批里出现同一概念的两种叫法**。批内去重原本只比原始字符串，`向量检索技术` 与 `向量检索`
   于是都建了页。分两种情况处理：
   - **归一化后键完全相同**（`LLM Wiki` / `llm-wiki`）→ 直接合并，这是明确无疑的同一概念；
   - **前缀关系**（`向量检索` / `向量检索技术`）→ **只报警、不擅自合并**。
     自动合并需要判断「两个名字指的是不是一件事」，而前缀既可能是同义（复利 / 复利效应），
     也可能是不同粒度（向量 / 向量检索）——猜错的代价是丢概念，比留一个重复页更糟。

这条经验可以推广：**当模型不遵守某条规则时，先检查提示词里是不是存在一个更强的反向暗示**
（示例、字段措辞、示例中的具体值）。改规则文本往往没用，改示例才有用。

---

## S12. `query.ts`（M5）

**目标**：问一个问题，得到带真实引用的答案。

**实现要点**：两次 LLM 调用（选页 + 生成），不走向量检索。

```
① ensureIndex()                          // S5 的自动 reindex
② selectPass(question, index.pages)
     system = 「你是检索器，只能从给定列表里选 id」
     user   = 卡片列表 + 问题
     输出   = { ids: string[], reason: string }
     程序：过滤掉不存在的 id、按顺序截断到 8 个
③ reasonPass(question, pages, neighbors)
     pages     = 选中页面的全文
     neighbors = 选中页 outLinks/inLinks 一跳邻居的 oneLiner（只给一行，不读全文）
④ answerPass(question, context)
     system = loadQueryRules()
     输出   = markdown 答案，每个结论后带 [[id]]
⑤ validateCitations(answer)
     抽出所有 [[id]] → 必须都在 index 里 → 任一不存在则非 0 退出并打印非法 id
```

注意第 ③ 步**不是**第三次 LLM 调用——「读全文 + 拼一跳邻居的一句话摘要」是纯计算。
所以 `runQuery` 正好两次调用，`llmCalls` 也拿它当验收数字。

**验证（验收标准 6）**

离线部分已做进 `pnpm smoke`（`checkQuery`，用假模型跑四个场景）：

```
① 正常引用        → 选中 1 页、引用校验通过、LLM 调用恰好 2 次
② 选页为空        → 直接回答「wiki 中未收录」，且**没有多花一次调用**（llmCalls 停在 1）
③ 幻觉引用        → badCitations 抓出 [[concepts/凭空编造]]
④ 选页给了非法 id  → 被程序过滤，不会传进上下文
```

真实模型上的验收：

```
① pnpm dev query "LLM Wiki 和 RAG 有什么区别？"
   → 答案里出现 [[concepts/...]] 等真实链接，且结尾报「引用校验：通过」
② pnpm dev query "作者是谁？"     → 应正确答出 Karpathy（若 entities 页已生成）
③ pnpm dev query "如何做红烧肉？"  → 必须回答「wiki 中未收录」，而不是编造
④ 手工把答案里的某个 [[]] 改成不存在的 id → 命令以非 0 退出并打印非法 id
```

第 ③ 条是**幻觉压力测试**，比任何正常问题都重要。如果它编了，说明 `query.md` 的「信息不足时明确回答未收录」
写得不够前置（要放在 system 开头，而不是结尾）。

**坑**

- 选页这一步可能返回空数组。此时**不要**退回「拿全部页面」——直接回答「wiki 中未收录」，
  并打印「选页为空」的提示。写死这条，否则 S13 之前你无法判断是选页坏了还是知识真没有。
- 上下文里的页面要带 `id` 标识（`### id: concepts/rag`），否则 LLM 无法产出正确的 `[[id]]`。
- 「引用校验」要复用 `parseOwnLinks` 的语义，而不是自己写个 `[[...]]` 正则：
  模型在解释「引用怎么写」时会把示例放进反引号或代码围栏，那些**不算结论的引用**，
  拿它们去校验会误报失败。（`citationsOf` 直接调 `parseOwnLinks`，白拿这个性质。）
- **引用了不存在的页面必须让命令以非 0 退出**。否则脚本会把一次幻觉回答当成成功，
  而「引用可信」是 DESIGN §10 里唯一能自动判定的质量指标。

---

## S13. 可选扩展（M6，按兴趣选做）

**已实现：`graph --mermaid`**（`src/graph.ts`）

```bash
pnpm dev graph                       # 连通块 / 超级节点 / 孤立页 / 自链接
pnpm dev graph --mermaid             # 额外输出可直接粘贴的 Mermaid 代码块
pnpm dev graph --mermaid --max-nodes 30   # 页面多了只画连接最多的 30 个
```

实现要点（都不涉及 LLM，纯函数、可离线测）：

- **数据只来自 `.state/index.json`**，不额外扫盘。
- **度数按无向图算**：链接是单向的，但「两个页面是否连在一起」是双向的事。
  只看 outLinks 会让 `sources/` 这类「只被指向」的页面全部变成孤立页。
- **死链不进图**：指向不存在页面的链接如果算成边，会凭空造出幽灵节点，
  而 `status` 已经单独报死链了，图里不必再混进这种噪声。
- **Mermaid 用生成的别名（`n0`/`n1`）承载节点**，把页面 id 放进标签：
  id 里有 `/`、中文、可能的空格，直接当 Mermaid 节点 id 会被解析器绊倒。
- **`--max-nodes` 裁剪后不能留下悬空边**：只画两端都在图里的边。
- 「连通块」这一项最值得看：**孤立页**（度数为 0）和**自成一块的小网络**
  （几个页面互相链接、但整块与主网络无链接）是两种不同的问题，后者更隐蔽，要分开报。
- 这是本项目唯一一个「纯读」的命令，也是唯一一个**不依赖 LLM 质量**就能看出产物的地方——
  页面写得再好，如果是一盘散沙，这里一眼就能看出来。

**其余扩展未做**，按「收益 / 成本」排序：

| 扩展 | 成本 | 学到什么 |
| :-- | :-- | :-- |
| 断链自动修复（用别名或相似标题兜底） | 中 | 链接解析的健壮性；但也可能掩盖 schema 问题 |
| 页面超 400 字自动拆分 | 中 | 又一次「LLM 输出 + 程序校验」的组合拳，且要处理拆分后的链接重写 |
| 冲突检测（不同素材对同一概念给出矛盾定义） | 中 | 知识管理的真问题，需要在页面里引入「争议」区块 |
| 极简 Web UI | 高 | 与学习目标关系最弱，最后再做 |

---

## 附录 A：调试手册（症状 → 原因 → 处理）

| 症状 | 最可能的原因 | 处理 |
| :-- | :-- | :-- |
| 页面里出现 `[[concepts/rag]]` 但文件不存在 | S9 的校验只查了「现有 id」，漏了「本批 create 的 id」 | 补校验集合后再跑；已产生的死链用 `status` 定位 |
| 反向链接层层叠加、越跑越长 | 没先 `stripAutoBacklinks` 就追加 | 修 `links.ts`，然后整目录 `reindex` 一次即可自愈 |
| `reindex` 的回写数永不归零、链接图里出现凭空多出的出链（如 hub 的 outLinks 里多了 keeper） | 分析出链时用了 `parseLinks`，把本页的反向链接当成了自己的出链（反馈环） | 改用 `parseOwnLinks`；再跑三次 `reindex` 确认回写数归零、幽灵出链消失 |
| 手工加在 frontmatter 里的字段莫名消失 | zod 剥掉了未声明的键，且回写时没用 `withBody` | 收进 `extraMeta`，渲染时排在已声明字段之后 |
| update 之后页面看起来「更新了」却一个字没变 | 提示词里给了含反向链接区块的完整正文，模型把新内容追加到区块之后，被 `sanitizeDraftBody` 截掉了 | 传 `stripAutoBacklinks(current.body)` |
| 第二次编译出现 `xxx-2`、`xxx-3` 这类重复页 | 模型在清单非空时仍返回 create，程序按 nextFreeId 加了后缀 | 用 title + aliases 建归一化索引，把 create 收敛为 update（记得打日志） |
| 一条真实存在的摘录被判为「编造」而丢弃 | 原文里带 `**加粗**`、`` ` ``、换行，比对时没做归一化 | 比对前剔除空白与 Markdown 强调记号 |
| 重编译后 source 页的「相关页面」变成 `（无）`，网络断开 | 用「本批新建的 id」生成链接，重编译时没有新建页 | 改用「抽取名称 → 标题/别名映射到已有页面」，见 `sourceRelatedIds` |
| 某页面的编辑「只生效了一半」 | 同一页被 `create` 收敛出的 update 与 `link` 折出的 update 各写了一次，后写覆盖先写 | 在 `planToWorkItems` 里按 id 合并 patch |
| `--dry-run` 或 `--verbose` 没反应 | 参数解析了但没接到实现上 | 每个选项都要有明确行为，或干脆从用法里删掉 |
| 日志说「复用上次结果」，实际却重新调用了模型 | 用 `passes` 的自述判断能否复用，而不是去读缓存 | 先读缓存，再按实际结果决定日志措辞 |
| 改回原素材后仍然全量重编译 | manifest 里存的是「改过版本」的 hash，与还原后的内容不符 | 这是正确行为；重编译一次对齐 hash 后即恢复跳过 |
| 冒烟/测试失败后 wiki/ 里留下产物 | 断言抛出后清理代码没执行 | 清理放在无条件路径上，失败也要清理并以非零码退出 |
| 断言「页面新增了某条链接」却怎么都能通过 | 判的是正文文本，而正文里含反向链接区块，「别人指向我」也算命中 | 用 `parseOwnLinks()` 判出链 |
| 页面把自己列进了自己的反向链接 | 模型在「补相关链接」时写了个自链接 | `checkSelfLinks()` 拦在写盘前 |
| 更新后某些小节凭空消失 | 模型选择重写整篇而不是插入 | `checkUpdateIntegrity()` 比对小节标题集合并退回重试 |
| 重试反馈里出现 `concepts/LLM Wiki` 这类「前缀对、末段是标题」的 id | 模型拿**标题**去拼 id，而不是用清单里的 slug | 反馈里用 `suggestId()` 直接告诉它正确写法（实测能显著减少重试） |
| 模型把 `[[raw/foo.md]]` 写进正文当引用 | 摘要页 id 没出现在「可链接的页面 id」清单里，它只能拿素材路径凑 | 把 `sources/xxx` 列进清单并注明「本素材的摘要页」 |
| 同一个页面三次重试**一字不差**地失败 | temperature 0.2 下同一提示词只会复现同一错误，重试对这个错误无效 | 别加次数，改「让输出更简单」——长正文放 JSON 最后一项 + 结构化失败时退到纯文本模式 |
| 三次重试的 dump 看起来完全一样 | dump 记的是原始 `system`/`user`，而重试时真正不同的是 `messages`（含上一轮输出与错误说明） | 落盘改为记录实际发出的 `messages` |
| 兜底路径上线了却从未被触发 | 假模型永远返回合法 JSON，离线测试走不到失败分支 | 给兜底写一个「让 structured 一律抛错」的离线场景（见 `checkBodyOnlyFallback`） |
| 想知道提示词的摩擦点在哪 | —— | 打开 `.state/passes/`，看重试那次 dump 里的「上一次尝试的问题，必须修正」。**这就是最好的提示词调优输入**，别靠猜 |
| `reindex` 偶发 `EPERM: rename ... .tmp` | Windows 上杀软/索引器占用刚写过的文件 | `rename` 加退避重试；残留 `.tmp` 由 `ensureDirs` 清理 |
| 每次编译都产生大量 diff | 时间戳/字段顺序不稳定，或 backlinks 排序不稳定 | 固定 frontmatter key 顺序；backlinks 按 id 排序 |
| LLM 输出总是被 zod 拒 | schema 里的字段说明说了「数组」但没给元素示例 | 在 prompt 里给**一个完整的 JSON 示例**，比十句描述管用 |
| `update` 把页面写成流水账 | `patch` 指令模糊 + rules.md 缺少兜底小节禁令 | 见 S11 的坑 |
| 第二次编译仍调用 LLM | manifest 键写成了 wiki 页面 id（DESIGN §3.3 就是为此修正的） | 键必须是 `raw/xxx.md` |
| compile 崩了留下半截 md | 没用「先 tmp 再 rename」 | 修 `writePage` |
| plan 凭空 `update` 不存在的页面 | 首次编译时没告诉它「wiki 为空」 | 在 user 里显式声明当前页面数 |

## 附录 B：步骤与 DESIGN.md 章节对照

| 步骤 | 主要依据 |
| :-- | :-- |
| S1 / S3 / S4 | DESIGN §3.1 页面格式、§3.2 索引 |
| S2 | DESIGN §6 Schema 层 |
| S6 | DESIGN §1.1 L5、§11 调试困难 |
| S7 ~ S9 | DESIGN §4 编译流水线 |
| S10 | DESIGN §3.3 manifest、§10 验收 1~3 |
| S11 | DESIGN §9 M4 核心验收 |
| S12 | DESIGN §5 问答流水线 |
| S13 | DESIGN §1.2 不做清单、§9 M6 |
