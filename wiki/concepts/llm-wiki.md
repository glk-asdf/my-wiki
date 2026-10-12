---
id: concepts/llm-wiki
type: concept
title: LLM Wiki
oneLiner: 一种全新的知识管理架构和模式
aliases: []
tags: []
sources:
  - raw/llm-wiki-intro.md
updated: '2026-10-12'
---

## 定义
LLM Wiki不是指某个具体的维基百科网站，而是一种知识管理架构和模式。由AI领域知名研究者Andrej Karpathy在2026年4月提出。

## 机制
LLM Wiki的核心是用"提前编译"替代传统RAG的"临时检索"。它由三个层次构成：原始素材层、Wiki层和Schema层。这种模式能产生显著的"复利效应"，新增资料时会更新所有相关页面。

## 与其他概念的关系
LLM Wiki使用[[concepts/提前编译]]替代传统RAG的[[concepts/临时检索]]，采用[[concepts/三层架构]]构建系统，并产生[[concepts/复利效应]]的特性。

## 出处
- [[sources/llm-wiki-intro]]：「它不是指某个具体的维基百科网站，而是由 AI 领域知名研究者 Andrej Karpathy 在 2026 年 4 月提出的一种**全新的知识管理架构和模式**。」
- [[sources/llm-wiki-intro]]：「LLM Wiki 的核心思路，是用"**提前编译**"替代传统 RAG（检索增强生成）的"**临时检索**"。」
- [[sources/llm-wiki-intro]]：「它通常由三个清晰的层次构成：1. **原始素材层**：存放你提供的所有原始资料（论文、笔记、网页等），这一层是**只读**的，作为事实基准。2. **Wiki 层**：这是核心，由大模型负责创建和维护。3. **Schema 层**：定义 Wiki 的结构、维护规则和回答生成的元规则。」
- [[sources/llm-wiki-intro]]：「这种模式能产生显著的"**复利效应**"。当你新增一份资料时，模型不只是简单地写个摘要，它会通读整个现有 Wiki，找出新内容与已有页面的关联，并**更新所有相关页面**。」

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/三层架构]]
- [[concepts/复利效应]]
- [[concepts/提前编译]]
- [[sources/llm-wiki-intro]]
