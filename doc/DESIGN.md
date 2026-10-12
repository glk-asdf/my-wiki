# LLM Wiki 最小实现 —— 设计文档

> 学习项目。目标不是做一个能用的知识库产品，而是**亲手把「编译式知识管理」这条链路跑通一次**，
> 并能在代码里指着说：这一步就是文档里说的「摄入时编译」，那一步就是它和 RAG 的分水岭。

---

## 1. 学习目标与非目标

### 1.1 要学到的（本项目的存在理由）

| # | 学习点 | 落到哪个模块 |
| :-- | :-- | :-- |
| L1 | 「编译」与「检索」的工程差异：什么时候做功、成本花在哪 | `compile.ts` vs `query.ts` |
| L2 | 多 Pass 编译器结构：抽取 → 规划 → 应用 → 重建索引 | `compile.ts` 四个阶段 |
| L3 | 知识网络的表示：`[[wikilink]]` + 反向链接 + 目录索引 | `links.ts` / `reindex` |
| L4 | Schema 驱动：用提示词规则约束 LLM 的写入行为 | `schema/*.md` |
| L5 | 让 LLM 输出可被程序消费：JSON 契约 + zod 校验 + 重试 | `llm.ts` |
| L6 | 复利效应的可观测性：新增资料后已有页面被更新 | `manifest.json` + 幂等/增量 |

### 1.2 明确不做（防止项目膨胀成第二个 Notion）

- 不做向量库 / 语义检索（本项目的对照面就是它，实现它等于丢了对照组）
- 不做多用户、权限、云同步、Web 服务
- 不做图谱可视化 UI（只在 M6 留一个输出 Mermaid 的口子）
- 不做 PDF/网页抓取，输入统一是 Markdown 文本

预计代码量：**800 ~ 1200 行 TypeScript**（实际落地约 3000 行 `src/`，多出来的部分主要是
LLM 输出的容错与校验——真实模型的输出比预想脏得多，详见 `doc/DEVELOPMENT.md`）。

---

## 2. 三层架构落成目录

严格对照 `doc/wiki.md` 的三层，一层一个目录：

```
my-wiki/
├─ doc/                        # 项目文档
│  ├─ DESIGN.md                #   本设计文档
│  ├─ DEVELOPMENT.md           #   分步开发文档
│  └─ wiki.md                  #   概念说明文档（M0 作为第一份原材料复制进 raw/）
├─ raw/                        # ① 原始素材层 —— 只读，事实基准
│  └─ llm-wiki-intro.md        #   由 doc/wiki.md 复制而来
├─ wiki/                       # ② Wiki 层 —— 程序 + LLM 共同维护（编译产物）
│  ├─ index.md                 #   自动生成的总目录（人工不编辑）
│  ├─ sources/                 #   每份原材料一个摘要页
│  ├─ concepts/                #   概念页：RAG、编译器模式、复利效应…
│  └─ entities/                #   实体页：人物、项目、工具…
├─ schema/                     # ③ Schema 层 —— 人写，约束 LLM
│  ├─ rules.md                 #   维护规则：何时新建页、何时更新页、禁止什么
│  ├─ taxonomy.md              #   页面类型与命名规范
│  ├─ query.md                 #   回答生成的元规则
│  └─ templates/{concept,entity,source}.md
├─ src/                        # 程序
│  ├─ cli.ts                   #   命令入口
│  ├─ types.ts                 #   zod schema + Page / Op / Index 类型（唯一契约来源）
│  ├─ llm.ts                   #   LLM 调用 + JSON 校验 + 重试
│  ├─ store.ts                 #   文件读写、frontmatter、路径映射
│  ├─ links.ts                 #   [[link]] 解析、反向链接计算
│  ├─ schema.ts                #   加载 schema/ 文本
│  ├─ reindex.ts               #   重建 index.json / index.md / 反向链接
│  ├─ compile.ts               #   编译流水线（核心，Pass 1~3）
│  └─ query.ts                 #   问答流水线（核心对照面）
├─ .state/                     # 运行状态（整目录可删，功能不受损）
│  ├─ manifest.json            #   真状态：已编译原材料指纹（删了 = 下一轮全量重编译）
│  ├─ index.json               #   派生缓存：页面索引，reindex 可随时重建
│  └─ passes/                  #   调试用：每个 Pass 的入参/出参 JSON
├─ scripts/
│  └─ offline-smoke.ts         # 注入假 LLM 的离线冒烟：不花钱验证整条编译管路
├─ tests/                      # 纯函数与离线行为单测（node:test，无需 API Key）
├─ package.json / tsconfig.json
└─ README.md
```

**`.state/` 下的两类数据必须分清**：
`manifest.json` 是**真状态**（记录哪些素材编译过，丢了就得重编），
`index.json` 是**纯派生缓存**（内容完全由 `wiki/*.md` 决定）。
因此 `status` / `query` / `compile` 启动时若发现 `index.json` 缺失或比 `wiki/` 旧，会先自动 `reindex`，
保证 `.state/` 整目录删掉后仍能一键恢复。

**为什么 `.state/passes/` 要落盘**：编译器的中间表示能直接肉眼检查。
LLM 项目 90% 的调试时间是「它到底想到了什么」，把中间态持久化是最高性价比的一行代码。

---

## 3. 数据契约

### 3.1 Wiki 页面格式

````markdown
---
id: concepts/retrieval-augmented-generation
type: concept
title: 检索增强生成（RAG）
aliases: [RAG]
tags: [架构模式, 检索]
sources: [raw/llm-wiki-intro.md]
updated: 2026-10-12
---

## 定义
每次提问都现场从原始文档库中翻找、拼凑片段，再让大模型推理出答案的模式。

## 与 [[concepts/compile-vs-retrieve]] 的关系
RAG 是本项目要对照的「解释器」一侧。

## 出处
- [[sources/llm-wiki-intro.md]]：「同一个问题问 100 次，它就要重复这个过程 100 次」

<!-- AUTO-BACKLINKS: 由 reindex 生成，勿手动编辑 -->
## 反向链接
- [[concepts/compile-vs-retrieve]] · [[entities/andrej-karpathy]]
````

约定：

- `id` = 相对 `wiki/` 的无扩展名路径，**全局唯一，是链接与索引的主键**
- 页面路径由 `type` + slug 决定，slug 由程序生成（不交给 LLM），保证可寻址
- 正文里的 `[[id|显示名]]` 中 `id` 必须存在，否则编译报错（防止产生死链）
- 反向链接区块由程序写入，LLM 输出中若出现该区块一律剥离
- **`sources` 字段与 `[[sources/xxx]]` 链接不是一回事**：前者是 frontmatter 里的溯源指针，值形如 `raw/llm-wiki-intro.md`；
  后者是正文里指向 wiki 摘要页的链接，值形如 `sources/llm-wiki-intro`（无扩展名，因为它是一个页面 id）

### 3.2 索引 `.state/index.json`

```jsonc
{
  "pages": [
    {
      "id": "concepts/retrieval-augmented-generation",
      "type": "concept",
      "title": "检索增强生成（RAG）",
      "oneLiner": "查询时做功的解释器模式",   // 供选页阶段使用，10~20 字
      "tags": ["架构模式"],
      "outLinks": ["concepts/compile-vs-retrieve"],
      "inLinks": ["concepts/compile-vs-retrieve"],
      "updated": "2026-10-12"
    }
  ],
  "generatedAt": "2026-10-12T10:00:00Z"
}
```

`oneLiner` 是整个设计的杠杆点：**问答时喂给 LLM 的是这张卡片列表，而不是全文**。
它把「选哪些页面」的 token 成本从 O(总字数) 压到 O(页面数 × 20 字)。

### 3.3 已编译清单 `.state/manifest.json`

键是**原材料相对 `raw/` 的路径**（注意别写成 wiki 页面 id，两者长得很像）：

```jsonc
{
  "raw/llm-wiki-intro.md": {
    "hash": "sha256:...",
    "compiledAt": "2026-10-12T10:00:00Z",
    "appliedOps": ["create:concepts/rag", "update:concepts/llm-wiki"],  // 审计线索：这份素材改过哪些页
    "passes": {                       // 每个 Pass 的终态，用于断点续跑
      "extract": "ok",
      "plan": "failed: zod 校验失败",
      "apply": "pending"
    }
  }
}
```

**写入时机**：每完成一个 Pass 就把它置为 `ok` 并**立刻落盘**（extract 是最贵的一趟，
绝不能因为后面 plan 崩了而白跑）。`scan` 的跳过条件是**三个 Pass 全为 `ok`** 且 hash 未变——
只查 `apply` 在实践中等价（apply=ok 必然意味着前两趟也 ok），但只要有人手工改过 manifest、
或以后新增了能在 apply 之后失效的 Pass，就只剩它一个把关了。

中途失败留下 `failed` / `pending`，重跑时**只重做没 ok 的 Pass**：缓存的 Pass 产物放在
`.state/passes/cache-<pass>-<素材路径>.json`（键用相对路径，避免 `<dir>/a/x.md` 与 `<dir>/b/x.md` 撞车），
读回时仍要过一遍 zod 校验，结构不符就等同于没有缓存。这样既不会把半成品当成已完成，
也不会污染 wiki。

---

## 4. 编译流水线（`compile.ts`）

这是本项目的心脏。**串行**逐份处理素材——顺序很重要，因为「复利」要求后一份素材能看到前面编译出的页面。

```
raw/foo.md
   │
   ├─[0] scan     算 hash，查 manifest → apply 已 ok 且 hash 未变则跳过
   │
   ├─[1] extract  LLM Pass 1：只读这份素材，输出
   │              { summary, entities[], concepts[], claims[], relationHints[] }
   │
   ├─[2] plan     LLM Pass 2：输入 = extract 结果 + index.json 卡片列表（不是全文！）
   │              输出操作计划 Op[]：
   │                { op:"create", type, title, oneLiner, reason }
   │                { op:"update", targetId, patch:"在『定义』下补充…", reason }
   │                { op:"link",   fromId, toId, reason }
   │                { op:"noop",   reason }        // 明确允许「不做事」
   │
   ├─[3] apply    LLM Pass 3：逐 Op 生成页面正文（此处才读被更新页全文）
   │              ① 先在内存里装配全部页面，不落盘
   │              ② 统一校验：id 冲突 / 页面重名 / [[id]] 可达性
   │              ③ 全部通过才原子落盘（单个 Op 失败独立重试，不牵连同批）
   │
   └─[4] reindex  重建 index.json / index.md / 全部反向链接
                  → 全部成功才把 manifest 标记为 ok
```

### 关键设计决定与理由

| 决定 | 理由（学习点） |
| :-- | :-- |
| extract 与 plan **拆成两次调用** | 一次调用做两件事会导致「抽取」被「决定写哪些页」的焦虑污染；拆分后可单独调优 |
| plan 阶段只喂卡片列表，不喂全文 | 对应 RAG 里「先检索再生成」的检索步，但我们的「索引」是**被编译出来的**，不是原始文档切块 |
| `apply` 是**第三次 LLM 调用**，不是模板渲染 | `patch` 只是变更指令（「在定义下补充…」），只有 LLM 能把它写成贴合上下文的段落。这是 token 最贵的一步，所以 plan 必须先收敛 |
| 所有 Op 先在内存装配，统一校验后原子落盘 | 否则「A 引用 B 本次新建的页面」会因 B 尚未执行而误判死链；集中落盘也保证失败时不残留半成品 |
| 同批 Op 中标题重名视为同一页，合并处理 | LLM 一次输出里重复 `create` 同一概念很常见，交给它自己去重不可靠 |
| plan 允许 `noop` | 复利效应不等于每次都要改东西。强制产出会让 LLM 编造无关更新 |
| 每个 Op 独立执行 + 独立重试 | 单个页面失败不影响其他页面；错误定位到 Op 粒度 |
| 增量以「原材料 hash」为粒度，不是「页面」 | 页面是共享产物，无法单独判断「哪个页面该因这份素材而变」 |

---

## 5. 问答流水线（`query.ts`）—— 与 RAG 的对照面

```
用户问题
   ├─[1] 读 index.json 卡片列表（全量，便宜）
   ├─[2] LLM 选页：输出相关页面 id + 理由（结构化输出）；程序按相关度截断到 8 个
   ├─[3] 读这些页面全文 + 它们一跳邻居的 oneLiner（补上下文，不深挖）
   ├─[4] LLM 生成答案，规则来自 schema/query.md：
   │        · 每个结论必须带 [[id]] 引用
   │        · 只能用提供的页面内容，不得引入外部知识
   │        · 信息不足时明确回答「wiki 中未收录」
   └─[5] 程序校验：答案中出现的所有 [[id]] 必须真实存在
```

注意 step 3 不是一次 LLM 调用：「读选中页面全文 + 拼一跳邻居的一句话摘要」是纯计算，
所以整条流水线稳定是**两次调用**（选页、生成），`llmCalls` 也拿它当验收数字。

**选页为空时不许退化**：模型返回空数组时，**不要**退回「把全部页面塞进上下文」，
而是直接给出「wiki 中未收录」的结论。这条写死的好处是：你永远能分清「选页坏了」
与「知识确实没有」——否则两者会长得一模一样。

**学习重点**：step 2 是「用自然语言做的元数据检索」。它比不上向量检索的召回率，
但它展示了一件事——**当知识已经被编译成结构化的、带摘要的页面之后，检索这个问题本身被简化了**。
这就是 `doc/wiki.md` 里「成本主要集中在初次编译」的代码形态。

答案例子：

```
LLM Wiki 与传统 RAG 的核心差异在「做功时机」：前者在摄入时编译成结构化页面 [[concepts/llm-wiki]]，
后者在查询时现场检索 [[concepts/retrieval-augmented-generation]]。因此 RAG 无知识积累，
而 Wiki 有复利效应 [[concepts/compounding-effect]]。（依据：[[sources/llm-wiki-intro.md]]）
```

---

## 6. Schema 层（人写的规则）

`schema/rules.md` 骨架——**这个文件的质量直接决定产物质量，它是本项目的「源码」**：

```markdown
# Wiki 维护规则

## 页面粒度
- 一个概念一个页面。若一个页面超过 400 字或包含 3 个以上独立概念，必须拆分为多个页面并互相链接。
- 实体页（人/组织/项目）与概念页（方法/理论/模式）严格分开。

## 事实来源（最重要）
- 所有事实性陈述必须能在 sources 中找到依据，禁止补充原材料之外的常识或外部知识。
- 每条事实在「出处」区块附上原始语句的简短摘录。

## 更新优先于新建
- 若卡片列表中存在语义等价的页面（含别名），必须 update 而非 create。
- update 时保持已有段落顺序，新内容追加到语义最接近的章节下，不要重写整篇。

## 禁止
- sources/ 摘要页里的「原文摘录」必须逐字复制自 raw/ 原文，不得改写、翻译或补全。
- 禁止输出「反向链接」区块。
- 禁止创建以「列表」「杂记」「其他」命名的页面。
```

`schema/taxonomy.md`：定义 `type` 枚举、目录归属、slug 生成规则（中英混排时的转写约定）。
`schema/templates/*.md`：页面骨架，`apply` 阶段拼进 prompt 作为输出格式约束。

---

## 7. 技术栈与依赖

| 项 | 选择 | 说明 |
| :-- | :-- | :-- |
| 运行时 | Node.js ≥ 20 | 原生 `fetch`、`node:fs/promises` |
| 语言 | TypeScript（strict） | 结构化输出校验离不开类型 |
| 执行 | `tsx` | 免构建，改完即跑 |
| LLM | `openai` SDK + `baseURL` 覆写 | 兼容 OpenAI / DeepSeek / Ollama / vLLM |
| 校验 | `zod` | 所有 LLM JSON 输出的守门人 |
| Frontmatter | `gray-matter` | 自己写也行，但没必要 |
| CLI 参数 | `node:util` 的 `parseArgs` | 不引 commander，保持小 |

刻意不引的：向量库、LangChain 类框架、ORM。**框架会替你隐藏掉本项目要学的那部分。**

### 环境变量

任何 **OpenAI 兼容端点**都能用，换后端只改这三行：

```
# 智谱 GLM（默认）：免费档实测可用
MY_WIKI_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
MY_WIKI_LLM_API_KEY=<到 https://open.bigmodel.cn 新建>
MY_WIKI_LLM_MODEL=glm-4.5-flash     # 128K；更强的是 glm-4.7-flash（200K），但它会过载

# DeepSeek：https://api.deepseek.com/v1 + deepseek-chat
# 本地 Ollama：http://localhost:11434/v1 + qwen2.5:14b（key 填任意非空值）
```

填完先跑 `pnpm dev check`——它用**一次最小调用**同时验证 key、端点与模型名，
免得跑完整编译才在第三次调用上撞到 401。失败时它会挖出响应体里的 `code` 并给出针对性建议
（`1302` 账户限速 · `1305` 模型过载 · `1301` key 失效 · `1113` 额度用尽），
因为各家真正的错误原因都塞在响应体里，只看 HTTP 状态码分不清「该重试」还是「该换型号」。

**免费档的三个实测约束**（2026-10-12 实测）：

1. **限 1 个并发请求**。本项目的编译本来就是串行的（§4 的「顺序很重要」那一条），天然吻合；
   但如果哪天为了提速改成并行处理多份素材，免费档会立刻开始返 429。
2. **热门型号会过载**。`glm-4.7-flash` 当时持续返回 429/`1305`「该模型当前访问量过大」，
   而 `glm-4.5-flash` 正常。换型号只需改 `.env` 一行，不需要动代码——这正是「只依赖 OpenAI 兼容协议
   最基础子集」的回报。
3. **别用思考型模型**。实测 `glm-5.3-flash` 回复两个字就烧掉 125 个 `reasoning_tokens`；
   本项目是 JSON 密集的短任务，思维链只带来延迟，不带来质量。

---

## 8. CLI 设计

```bash
pnpm dev compile --all               # 编译 raw/ 下所有未编译素材（增量）
pnpm dev compile raw/foo.md          # 编译指定素材
pnpm dev compile --all --dry-run     # 只跑 extract+plan，打印计划不落盘
pnpm dev compile --all --force       # 忽略 manifest 重编译（验收标准 2 用）
pnpm dev query "LLM Wiki 和 RAG 有什么区别？"
pnpm dev reindex                     # 重建索引与反向链接
pnpm dev status                      # 列出 wiki 页面、孤立页、死链
pnpm dev graph --mermaid             # 输出 Mermaid 链接图（M6）
```

`--dry-run` 是学习利器：调 `schema/rules.md` 时反复看计划变不变，不用污染 wiki。

---

## 9. 里程碑（每个都能独立验收）

| 里程碑 | 内容 | 验收方式 |
| :-- | :-- | :-- |
| **M0 骨架** | 目录、tsconfig、`parseArgs` 入口、空 schema；把 `doc/wiki.md` 复制到 `raw/` | `pnpm dev status` 打印「0 页面」 |
| **M1 存储与链接** | `store.ts` + `links.ts` + `reindex.ts`；手写 3 个假页面 | `index.json` 生成正确；反向链接对称；死链被报出 |
| **M2 LLM 封装** | `llm.ts`：JSON schema 约束 + zod 校验 + 失败重试 2 次（带上一次错误信息） | 故意返回坏 JSON，观察自动重试并最终成功/报错 |
| **M3 编译闭环** | `extract` → `plan` → `apply`，先只支持 `create` | 编译 `raw/llm-wiki-intro.md`，得到 4~8 个互相链接的页面 |
| **M4 更新与复利** | 支持 `update` / `link` / `noop`；`manifest.json` 增量 | 详见下方验收 |
| **M5 问答** | `query.ts` 四步流水线 + 引用校验 | 答案中每个 `[[id]]` 都能在 wiki 找到 |
| **M6 扩展（可选）** | Mermaid 图 / 冲突检测 / 断链自动修复 / 极简 Web UI | —— |

**M4 的核心验收（本项目的灵魂）**：
新增第二份素材（例如手写一份关于「向量检索」的笔记）并编译，
观察日志中必须出现**至少一个 `op:"update"`**，且被更新的页面新增了指向新页面的 `[[链接]]`。
这条观察成功 = 你亲眼看到了「复利效应」，而不只是读到了这个词。

---

## 10. 验收标准（可脚本化）

1. **增量幂等**：连续两次 `compile --all`，第二次 LLM 调用次数为 **0**，`wiki/` 文件字节级不变——注意这是「靠 manifest 跳过」得到的幂等，不是靠 LLM 输出稳定。
2. **重编译不重复**：`compile --all --force` 忽略 manifest 重跑后，同一段落不得被追加两次（允许措辞有差异）。
3. **可重跑**：`plan` 阶段强制抛错后重跑，wiki 无残留半成品、manifest 未标记 ok，且 `extract` 不重复调用。
4. **无死链**：`status` 报出 0 死链。
5. **反向链接对称**：A 链 B ⇒ B 的反向链接含 A。
6. **引用可信**：`query` 输出中出现的所有 `[[id]]` 都经程序校验存在于 `index.json`，校验失败则命令非 0 退出。
7. **来源可溯**：每个 `concepts/*` 与 `entities/*` 页面的 `sources` 至少一项指向 `raw/` 中真实存在的文件。

---

## 11. 风险与对策

| 风险 | 对策 |
| :-- | :-- |
| LLM 幻觉写入 wiki，污染知识库 | `schema/rules.md` 强制「事实必须有出处」；`apply` 阶段校验 sources 里的摘录是否为原文子串 |
| 页面越滚越大、越来越像笔记 | 400 字上限 + 超限触发拆分；禁止「列表 / 杂记」类页面 |
| plan 阶段选页不准（无向量检索的代价） | 卡片列表带上 `tags` 与 `oneLiner`；先保证 10 页以内规模下的准确率，规模问题留给 M6 讨论 |
| 同一份素材重复编译导致内容重复追加 | 以 hash 做 manifest，幂等跳过 |
| 调试困难（LLM 不可复现） | `.state/passes/` 落盘每次调用入参与出参；`--dry-run` 不落盘 |
| 成本失控 | plan 阶段只喂卡片；update 只读目标页全文；后续考虑小模型做 extract、大模型做 plan |

---

## 12. 学完自测（能回答即出师）

1. 为什么关联发现要放在**编译时**做，而不是查询时？这个选择的成本代价是什么？
2. 为什么 `plan` 阶段不把 wiki 全文喂给 LLM？如果喂了会发生什么？
3. 反向链接为什么由**程序**生成，而不是让 LLM 顺手写？
4. 「增量编译」以原材料 hash 为粒度，为什么不能以页面为粒度？
5. 如果素材量到 5000 份、页面到 2 万篇，当前设计的哪一步会最先崩？替代方案是什么？
