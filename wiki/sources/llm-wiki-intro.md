---
id: sources/llm-wiki-intro
type: source
title: LLM Wiki 知识管理架构
oneLiner: LLM Wiki：从临时检索到提前编译的知识管理模式
aliases: []
tags: []
sources:
  - raw/llm-wiki-intro.md
updated: '2026-10-12'
---

## 概要

LLM Wiki是由Andrej Karpathy在2026年4月提出的一种全新知识管理架构，它用"提前编译"替代传统RAG的"临时检索"。系统通过三层架构（原始素材层、Wiki层、Schema层）将原始资料编译成结构化、相互链接的Markdown维基页面，产生知识复利效应，实现从"检索信息"到"经营知识"的范式转变。

## 关键论点

- LLM Wiki 不是指某个具体的维基百科网站，而是一种知识管理架构和模式。
- LLM Wiki 的核心是用'提前编译'替代传统RAG的'临时检索'。
- LLM Wiki 由三个层次构成：原始素材层、Wiki层和Schema层。
- LLM Wiki 能产生显著的'复利效应'，新增资料时会更新所有相关页面。
- LLM Wiki 目前已有一些开源实现，如llm-notebook和@syasas/llm-wiki等工具。
- LLM Wiki 更适合个人或小团队的知识管理，在企业级知识库应用中存在局限。

## 原文摘录

- 「它不是指某个具体的维基百科网站，而是由 AI 领域知名研究者 Andrej Karpathy 在 2026 年 4 月提出的一种**全新的知识管理架构和模式**。」
- 「可以把传统 RAG 想象成一个**解释器**：每次你提问，它都要现场去原始文档库里翻找、拼凑片段，再让大模型现场推理出答案。」
- 「由 AI 领域知名研究者 **Andrej Karpathy** 在 2026 年 4 月提出」
- 「例如 `llm-notebook`、`@syasas/llm-wiki` 等工具」
- 「可以将你的 Claude Code、Cursor 等工具的对话记录编译成个人 Wiki」

## 相关页面

- [[concepts/llm-wiki]]
- [[concepts/三层架构]]
- [[concepts/临时检索]]
- [[concepts/复利效应]]
- [[concepts/提前编译]]
- [[entities/andrej-karpathy]]

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/llm-wiki]]
- [[concepts/三层架构]]
- [[concepts/临时检索]]
- [[concepts/复利效应]]
- [[concepts/提前编译]]
- [[entities/andrej-karpathy]]
