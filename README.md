# my-wiki

把 `raw/` 下的原始素材**编译**成一张互相链接的 Markdown wiki，而不是在提问时临时检索。

这是一个学习项目：把 [Karpathy 提出的 LLM Wiki 范式](doc/wiki.md) 落到实处，
用于对照理解它和传统 RAG 的差异。零框架、零向量库，依赖只有 `openai` + `zod` + `gray-matter`。

规模：`src/` 11 个文件约 3000 行、`tests/` 约 900 行、离线冒烟脚本约 900 行、schema 规则约 170 行。
其中**只有那 170 行的 `schema/` 是人写的自然语言规则**——产物质量主要由它决定，而不是由 TypeScript 决定。

---

## 它和 RAG 的区别

| | 传统 RAG | 本项目（LLM Wiki） |
| :-- | :-- | :-- |
| 做功时机 | **查询时**：每次提问都重新切块、检索、拼答案 | **摄入时**：素材进来自动编译成结构化页面 |
| 产出物 | 一次性的答案，问完即消失 | 持续累积的页面，会互相链接、会被更新 |
| 「索引」是什么 | 原始文档的向量切块 | **被编译出来的**知识页与它们的链接网络 |
| 复利效应 | 没有：第 100 次提问和第一次一样贵 | 有：新素材能让**已有页面**更准更全 |

真正的差别在最后一行。新素材的价值通常不是多一个页面，而是**让旧页面长出新的关联**——
这也是本项目最难的验收项（见下方「当前状态」）。

---

## 快速开始

需要 Node 20+ 与 pnpm。

```bash
pnpm install

cp .env.example .env      # 填入 API Key，任何 OpenAI 兼容端点都行（智谱 / DeepSeek / 本地 Ollama）
pnpm dev check            # 先验证连通性，它会打印 HTTP 状态码并给出针对性建议

pnpm dev compile --all    # 编译 raw/ 下的素材
pnpm dev status           # 看页面数、死链、孤立页
pnpm dev query "LLM Wiki 和 RAG 有什么区别？"
```

`.env` 里只有四个变量：`MY_WIKI_LLM_BASE_URL` / `MY_WIKI_LLM_API_KEY` / `MY_WIKI_LLM_MODEL` / `MY_WIKI_LLM_TIMEOUT_MS`。
换后端只改前三个，不需要动代码。

---

## 命令

| 命令 | 作用 |
| :-- | :-- |
| `pnpm dev check` | 验证 LLM 配置是否可用（key / 端点 / 模型名） |
| `pnpm dev status` | 页面数、死链、孤立页、未编译素材 |
| `pnpm dev compile --all` | 增量编译 `raw/` 下所有未编译素材 |
| `pnpm dev compile raw/foo.md` | 编译指定素材 |
| `pnpm dev compile --all --dry-run` | 只跑到计划，打印出来但不落盘 |
| `pnpm dev compile --all --force` | 忽略 manifest 重编译 |
| `pnpm dev query "问题"` | 基于 wiki 回答：选页 → 生成 → **引用校验** |
| `pnpm dev graph` | 链接图的形状：连通块 / 超级节点 / 孤立页 |
| `pnpm dev graph --mermaid` | 额外输出可粘贴的 Mermaid 代码块 |
| `pnpm dev reindex` | 重建 `index.json` / `index.md` / 反向链接 |

---

## 三层结构

```
raw/        ① 原始素材层   只读，事实基准。你往里放，程序只读不改
wiki/       ② Wiki 层      程序 + LLM 共同维护的编译产物
schema/     ③ Schema 层    人写的规则，约束 LLM 该怎么写
```

真正被编译出来的是 `wiki/`：

```
wiki/
├─ index.md            自动生成的总目录（人工不编辑）
├─ sources/            每份素材一个摘要页，含逐字原文摘录
├─ concepts/           概念页：RAG、复利效应、三层架构…
└─ entities/           实体页：人物、项目、工具…
```

页面之间靠 `[[concepts/rag]]` 这样的链接连成网络，反向链接由程序维护（不需要手写）。

**`schema/` 才是这个项目的「源码」**——`rules.md` 写维护规则、`taxonomy.md` 写类型与命名、
`templates/*.md` 写页面骨架。产物质量主要取决于这里的文本质量，而不是 TypeScript 代码。

---

## 编译流水线

```
raw/foo.md
   │
   ├─[0] scan     算 hash，查 manifest → 已编译且未变则跳过
   │
   ├─[1] extract  LLM Pass 1：只读这份素材 → { title, summary, claims, concepts[], entities[], relationHints[] }
   │
   ├─[2] plan     LLM Pass 2：输入 = 抽取结果 + 页面卡片列表（不是全文！）
   │              → Op[]：create / update / link / noop
   │
   ├─[3] apply    LLM Pass 3：逐 Op 生成正文（此处才读被更新页的全文）
   │              ① 先在内存里装配全部页面，不落盘
   │              ② 统一校验：id 冲突 / 标题重名 / [[id]] 可达性
   │              ③ 全部通过才原子落盘
   │
   └─[4] reindex  重建 index.json / index.md / 反向链接
```

几个关键设计决定：

- **`plan` 阶段只喂卡片列表，不喂全文**。这对应 RAG 里的检索步，但「索引」是被编译出来的，不是切块。
- **`apply` 是第三次 LLM 调用，不是模板渲染**。`patch` 只是变更指令（「在定义下补充…」），
  只有 LLM 能把它写成贴合上下文的段落。这是 token 最贵的一步，所以 `plan` 必须先收敛。
- **所有 Op 先在内存装配，统一校验后原子落盘**。否则「A 引用 B 本次新建的页面」会因 B 尚未执行而误判死链。
- **`noop` 是合法操作**。复利效应不等于每次都要改东西；强制产出会让 LLM 编造无关更新。

---

## 目录结构

```
my-wiki/
├─ doc/            设计文档（DESIGN.md）、分步开发文档（DEVELOPMENT.md）、素材（wiki.md）
├─ raw/            原始素材
├─ wiki/           编译产物
├─ schema/         规则与模板（人写）
├─ src/            TypeScript 源码
│  ├─ cli.ts         命令入口
│  ├─ types.ts       zod 契约（唯一类型来源）
│  ├─ llm.ts         LLM 调用 + JSON 校验 + 带错误重试
│  ├─ store.ts       文件读写、原子写、frontmatter、路径映射
│  ├─ links.ts       [[link]] 解析、反向链接维护
│  ├─ schema.ts      加载 schema/ 文本
│  ├─ compile.ts     编译流水线（核心）
│  ├─ query.ts       问答流水线（核心对照面）
│  ├─ reindex.ts     索引与反向链接重建
│  └─ graph.ts       链接图分析
├─ tests/          单测（纯函数，离线可跑）
├─ scripts/        离线冒烟脚本（注入假模型，不花钱）
└─ .state/         运行状态（整目录可删，功能不受损）
```

`.state/` 下有两类数据，必须分清：

- `manifest.json` —— **真状态**：记录哪些素材编译过。删了 = 下一轮全量重编译。
- `index.json` / `wiki/index.md` —— **纯派生缓存**：内容完全由 `wiki/*.md` 决定，随时可重建。
  只有 `manifest.json` 丢了才有代价——它能区分「素材改了」和「素材没变」。

---

## 开发与测试

```bash
pnpm typecheck    # strict + noUncheckedIndexedAccess
pnpm test         # 70 个单测，纯函数，不需要 API Key
pnpm smoke        # 离线冒烟：注入假模型跑通整条流水线，不花钱
pnpm smoke --keep # 保留产物人工检查
```

`pnpm smoke` 是这一层最有用的东西：它用假 LLM 把 `scan → extract → plan → apply → reindex`
跑一整遍，并在过程中断言 7 组性质：

| 检查 | 断言的关键性质 |
| :-- | :-- |
| 增量与断点续跑 | 第二次编译 0 次调用；`plan` 被标失败后重跑时，**最贵的 `extract` 不得重复调用**；缓存结构不符时不采信坏数据 |
| apply 失败不留残留 | 在内存里装配好的页面**一个都不许落盘**，manifest 要记下失败原因，续跑只重做 apply |
| 复利效应 | 第二份素材必须产生 `update`；被更新的页面必须长出新链接；更新**不得改动小节结构**；不得产生死链 |
| 纯文本兜底 | 结构化输出全部失败时，页面仍要建出来，且正文里的链接仍要通过可达性校验 |
| 问答 | 选页+生成恰好 2 次调用；选页为空时不多花一次调用；幻觉引用被抓出；选页里的非法 id 被程序过滤 |
| `--force` 与 hash | `--force` 忽略缓存重跑；素材改了必须重跑；hash 对齐后重新回到零调用 |
| `--dry-run` | wiki、manifest、passes 三处都不得被写入 |

**这些性质用真模型测不出来**——真模型的随机性会让「有时通过」看起来像通过。

代价差得也很明显：离线冒烟是秒级的；接真实模型后编译一份素材（产出 7 个页面）实测约 8~10 分钟，
因为每个页面都要一次生成调用，而免费档每次响应 30~60 秒。**先用冒烟把管路跑通，再花钱验模型。**

---

## 当前状态

已实现并验证的：

| 能力 | 状态 |
| :-- | :-- |
| 三层目录结构、CLI、退出码 | 完成 |
| 页面读写、原子落盘、frontmatter 契约 | 完成 |
| 反向链接维护、死链与孤立页检测 | 完成（连续多次 `reindex` 收敛为 0 回写） |
| 索引自愈（删掉 `.state/` 可一键重建） | 完成 |
| 三趟编译流水线 + 真实模型跑通 | 完成（一份素材 → 7 个页面、0 死链） |
| 结构化输出失败时退到纯文本模式 | 完成，有离线覆盖 |
| 链接图分析 | 完成 |

**已知未解决：复利效应尚未发生。** 跑第二份素材时，`plan` 给出了 5 个 `create`、**0 个 `update`**，
还会为同一概念建两页。已针对性修了三处（提示词示例偏置、规则缺少判断过程、批内去重太严），
但**尚未用真实模型复验**。这是本项目最值得继续观察的一项。

其他已知限制：

- **没有自动化端到端测试**。`store.ts` 用模块级常量定位 `wiki/`，测试无法指向临时目录；
  要补 E2E 得先把路径改成可注入，这属于 S13 的重构。
- **正文长度只告警、不截断**。实测模型会写出 750 字（`rules.md` 上限 400 字），
  截断会切断链接语法，正确做法是拆页——尚未实现。
- **`normalizeBody` 会折叠 3 个以上连续换行**，正文里若有多个空行会被压缩。对本项目影响极小。

---

## 文档

| 文件 | 内容 |
| :-- | :-- |
| [`doc/wiki.md`](doc/wiki.md) | 概念说明：LLM Wiki 范式本身（同时也是第一份原始素材） |
| [`doc/DESIGN.md`](doc/DESIGN.md) | 设计文档：架构、契约、验收标准、关键取舍 |
| [`doc/DEVELOPMENT.md`](doc/DEVELOPMENT.md) | 分步开发文档 S0~S13：每步的目标、验证命令、踩过的坑 |

`doc/DEVELOPMENT.md` 的调试手册一节记录了本项目实际踩到的坑（症状 → 原因 → 处理），
包括几个只在真实模型上才会暴露的问题：中文文本里的裸引号、
反向链接被当成出链导致的链接图反馈环、逐字校验误伤真实摘录、
以及「模型不遵守规则时，往往是因为提示词里存在更强的反向暗示」这条经验。
