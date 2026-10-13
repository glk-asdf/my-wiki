# Agent 层设计 —— 让"只读知识库"变成"可对话、可深挖、可追溯、可执行的接口"

> 配套文档：`doc/DEVELOPMENT.md` S13 之后（可选扩展 #4 之前）的下一个里程碑。
> 本文件讲**为什么这样设计**与**长什么样**；落地步骤另见后续补充的 S14。
>
> 一句话定位：当前 `serve` 是**静态只读**查看器，`query` 是**一次性 2-call 检索问答**；
> 二者都"只能看 / 只能答一次"。Agent 层在上面套一个 **ReAct 风格的工具调用循环**，
> 让使用者能多步推理、按需追到 `raw/` 原文、执行任务（找矛盾、查依赖、提拆分），
> 而所有"动手"仍走项目既有的**确定性纯函数内核**。

> **进度（2026-10-13）**：S14 已落地，Phase 0~3 全部完成。`runAgent` 内核、`pnpm dev agent`（`--chat`/`--verbose`/`--apply`）、
> `POST /api/agent` + 浏览器聊天侧栏、写入类工具（`propose_split`/`propose_conflict`，只出计划不落盘）均已实现；
> `tests/agent.test.ts` 8 项离线单测全绿。落地步骤见 `doc/DEVELOPMENT.md` S14。

---

## 0. 动机：为什么"单知识库只能查看"不够

| 现状 | 局限 |
| :-- | :-- |
| `serve` 只读浏览（`src/serve.ts` 的 `handleRequest`） | 人得自己顺着 wikilink 翻；不会主动告诉你"A 和 B 矛盾""X 依赖 Y" |
| `query` 一次性问答（`src/query.ts` 的 `runQuery`） | 只"选页→作答"一次：不能多步深挖、不能按需去读某条出处的 `raw/` 原文、不能跨页串证据、不能执行任务 |

知识库真正的价值不在"存"，而在"被用"——被问、被追、被核对。Agent 是把已有的
**结构化页面 + wikilink 图 + 出处溯源 + 争议区块** 这些东西串起来用的那一层。

设计上必须守住项目已有的三条铁律（见 `DEVELOPMENT.md` 开篇）：

1. **确定性内核 + LLM 只做判断**：写入文件系统永远走纯函数（`applySplit`/`applyConflicts`/`repairDeadLinks`/`writePage`），LLM 只决定"调哪个工具、传什么参数、是否真矛盾"。绝不把改结构、造链接这种事交给模型。
2. **不依赖厂商特性**：工具调用用 **ReAct 风格的 prompt + zod 解析**，复用已有的 `LlmClient.text()` + `extractJson` + 重试落盘（`src/llm.ts`），不绑死 OpenAI function-calling。
3. **引用必须可信**：答案里出现的 `[[id]]` 必须真实存在（复用 `query.ts` 的 `validateCitations`）。

---

## 1. 架构总览

新增一个 `src/agent.ts`（Agent Runner），对已有的 `LlmClient` 做编排，**不改动 LLM 层**。

```
                 ┌──────────────────────────────────────────┐
   用户问题 ───▶ │  Agent Runner (src/agent.ts)             │
                 │   维护 messages，ReAct 循环：             │
                 │     LLM → {thought, action, action_input} │
                 │     → 跑 Tool → observation 喂回          │
                 │     → 直到 action == "finish"            │
                 └───────────────┬──────────────────────────┘
                                 │ 调用
        ┌───────────────┬────────┴─────────┬───────────────┬──────────────┐
        ▼               ▼                  ▼               ▼              ▼
  search_pages    read_page/read_source  get_links/      list_disputes   ask
  (selectPass)    (readPage/readRaw)     find_path       (conflict)      (runQuery)
        │               │                  (graph/scan)       │              │
        └───────────────┴──────────────────┴──────────────────┴──────────────┘
                         全部复用既有纯函数（store / links / graph / conflict / query）
                         写入类工具只"产计划"，落盘需 --apply 或显式确认
```

**关键决策：用 ReAct（prompt 驱动）而不是 function-calling。**
理由与 S6「不依赖各家 response_format / json_schema」一脉相承——工具调用也是厂商支持度
参差不齐的能力。用 `text()` 让模型输出固定 JSON `{thought, action, action_input}`，
再用 `extractJson` + zod 解析，重试/落盘逻辑**完全复用** `src/llm.ts`，不新增一套调用栈。

---

## 2. 工具注册表（第一版）

每个工具就是一个纯对象：`{ name, description, schema(zod), run(args) }`。
`run` 内部全部调用已有模块，Agent Runner 不认识任何"业务知识"，只认识"调工具、读返回值"。

### 2.1 只读工具（默认开启，零副作用）

| 工具 | 复用现有实现 | 作用 |
| :-- | :-- | :-- |
| `search_pages(q)` | `query.ts` 的 `selectPass` / 关键词匹配 `IndexEntry` 卡片 | 按问题从页面清单挑相关 id（拿不准就少选） |
| `read_page(id)` | `store.readPage` | 取某页全文（含 `## 出处`/`## 争议`） |
| `read_source(ref)` | `store.readRaw` | **溯源**：按 `出处` 里写的 `sources/xxx` 取素材原文 |
| `get_links(id)` | `IndexEntry.outLinks`（`reindex`/`scan`） | 某页指向了谁 |
| `get_backlinks(id)` | `IndexEntry.inLinks` | 谁指向了某页（依赖关系） |
| `find_path(a, b)` | 在 `graph` 的邻接表上做 BFS | 两页之间最短链接路径（概念怎么连到实体） |
| `list_disputes()` | `conflict.parseDisputes` + `formatConflictReport` | 离线列出所有已记录的矛盾 |
| `graph_stats()` | `graph.analyzeGraph` | 连通块 / 超级节点 / 孤立页 |
| `ask(q)` | `query.runQuery` | 把"快速 RAG"当子工具，省一轮手工选页 |

> `read_source` 是 Agent 相对 `query` 的**最大增量**：`query` 的答案顶多引到页面，
> Agent 能顺着页面 `## 出处` 里的 `[[sources/xxx]]` 一路摸到 `raw/` 原文，做到真正的"可追溯"。

### 2.2 写入工具（默认**关闭**，需 `--apply` 或显式确认）

沿用 `split`（`--dry-run`）/`conflict`（`--detect` 默认 dry-run）的保守范式——
Agent **只产出计划、不静默落盘**，避免模型"顺手"改了知识库。

| 工具 | 复用现有实现 | 行为 |
| :-- | :-- | :-- |
| `propose_split(id)` | `split.isOverLimit` / `buildSplit*`（先只返回提案） | 返回"拆成枢纽页+子页"计划，不写 |
| `propose_conflict(id, ...)` | `conflict.buildConflictUser` / `conflictProposalSchema` | 返回检测到的矛盾，写盘需确认 |

 Agent 任何写动作的最终落盘，都必须经过 `writePage` / `applySplit` / `applyConflicts` 这些
已测纯函数，并触发 `reindex`（重算反向链接），与 CLI 既有命令走同一通道。

---

## 3. 系统提示词要点

Agent 的 system prompt 把项目约定翻译成"工具使用纪律"：

- 每条结论必须能回溯到一个页面，涉及事实的主张尽量再追到 `read_source` 的 `raw/` 原文。
- 涉及不同说法时，**必须**先调 `list_disputes` 或读页面 `## 争议`，并把矛盾如实呈现，不替用户"和稀泥"。
- 答案/计划里出现的所有 `[[id]]` 必须是真实存在的页面（最终用 `validateCitations` 兜底校验，非空即失败）。
- 需要执行写操作时，只能产出计划并请求确认，绝不自行调用写盘。
- 工具返回空/不存在时，如实说"wiki 中未收录"，**不拿常识补**（与 `query.NO_COVERAGE_ANSWER` 一致）。

---

## 4. 接入方式（两处，解决"只能查看"）

### 4.1 CLI（先落地，最稳）

```bash
pnpm dev agent "余弦相似度和内积有什么区别？"      # 一次性 agentic 回答，带思考链
pnpm dev agent --chat                             # 多轮 REPL，上下文持续累积
pnpm dev agent "把超过 400 字的概念页列出来" --apply   # 写入类工具需显式开启
```

新增 `case 'agent'` 分支（结构照搬 `case 'query'`/`case 'conflict'`）：
解析 `--chat` / `--apply` / `--verbose`，构造 `AgentRunner`，循环到 `finish` 后打印答案 +
思考过程 + 引用校验结果（复用 `validateCitations`）。

### 4.2 Web UI（直击"只能查看"痛点）

在 `src/serve.ts` 增加 `POST /api/agent` 端点（handler 保持纯函数式、便于单测），
在 `serve-ui.html` 加一个聊天侧栏。这样现有的只读查看器，左侧翻页、右侧直接对话，
"查看"与"问 agent"在同一个浏览器里完成——这是最贴合本次诉求的一步。

`/api/agent` 的请求体 `{ question, history? }` → 复用 `AgentRunner` → 返回 `{ answer, steps, citations }`。
UI 把 `steps`（thought/action/observation）渲染成可折叠的"思考过程"，让溯源可见。

---

## 5. 落地节奏（最小可用优先）

| 阶段 | 内容 | 产出 | 是否调 LLM |
| :-- | :-- | :-- | :-- |
| **Phase 0** | `src/agent.ts`：ReAct 循环 + 只读工具注册表 + `runAgent` + 单测 | 内核可离线测（注入假 `LlmClient`） | 测试时注入 |
| **Phase 1** | CLI `agent` 命令（一次性 + `--chat`） | `pnpm dev agent` 可用 | 是 |
| **Phase 2** | `serve` 加 `/api/agent` + 聊天侧栏 | 浏览器里对话 | 是 |
| **Phase 3** | 写入类工具（split/conflict 提案）+ 确认流程 | agent 能"出计划、等人点头再写" | 是 |

Phase 0 是地基，不依赖任何 UI；Phase 2 最贴合"只能查看"的痛点，可优先于 Phase 3。

> **落地状态（2026-10-13）**：Phase 0~3 全部实现并通过单测。CLI `agent` 命令、`POST /api/agent`、聊天侧栏、
> 以及 `--apply` 下的写入类工具（仅产出计划）均可用；离线 `tests/agent.test.ts` 覆盖 ReAct 循环与工具分发。

---

## 6. 验收标准（沿用项目既有口径）

1. **引用可信**：Agent 最终答案经 `validateCitations` 校验，所有 `[[id]]` 真实存在；非空即非 0 退出（同 `query`）。
2. **溯源可证**：当问题涉及事实主张时，测试断言 Agent 至少调用过一次 `read_source`，且答案能指到 `raw/` 原文片段。
3. **矛盾不藏**：被测问题中若显式涉及已知矛盾，Agent 必须引用 `## 争议` 或调过 `list_disputes`。
4. **只读安全**：不传 `--apply` 时，Phase 0~2 全程 `wiki/`、`raw/` 零改动（同 `conflict` 报告模式的"只读"纪律，注意**不要再误调 `ensureIndex` 重写 `wiki/index.md`**——这是 S13 踩过的坑）。
5. **可离线测**：Agent Runner 通过注入假 `LlmClient` 完成 ReAct 循环与工具分发的单测，不烧 API。

---

## 7. 风险与取舍

- **ReAct 比 function-calling 多耗 token / 多一轮往返**：换来厂商无关 + 复用既有落盘/重试。
  对"个人知识库"场景，调用频次低，可接受；真要省，再考虑让 `LlmClient` 暴露 `chat(messages)` 接原生 tool_call。
- **工具太多会乱**：第一版只读工具控制在 ~9 个；写入工具刻意后置（Phase 3），避免 Agent 乱写。
- **循环可能不收敛**：给 `finish` 动作 + 最大步数上限（如 8 步），超限强制收尾并提示"未达结论"。

---

## 8. 代码复用清单（实现时照着接）

- LLM 层：`createLlmClient`、`LlmClient.text`、`extractJson`、`JSON_ONLY`（`src/llm.ts`）
- 页面/素材读写：`readPage`、`readRaw`、`readIndex`、`scan`、`nextFreeId`、`slugify`、`writePage`（`src/store.ts`）
- 链接：`parseOwnLinks`、`repairDeadLinks`（`src/links.ts`）
- 图：`analyzeGraph`、`renderMermaid`（`src/graph.ts`）
- 矛盾：`parseDisputes`、`formatConflictReport`、`applyConflicts`、`conflictProposalSchema`（`src/conflict.ts`）
- 拆分：`isOverLimit`、`applySplit`、`buildSplitUser`（`src/split.ts`）
- 既有问答：`runQuery`、`selectPass`、`validateCitations`、`citationsOf`（`src/query.ts`）
- 查看器：`handleRequest`、`scan`、`IndexEntry`（`src/serve.ts`、`src/types.ts`）

> 一句话总结：Agent 不发明新能力，只是把"页面 + 图 + 出处 + 争议 + 既有命令"用 ReAct 循环
> 重新编排成"可对话"的形态；所有"动手"仍归确定性内核，所有"判断"才交给 LLM。
