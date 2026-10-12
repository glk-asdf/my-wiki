---
id: sources/vector-search-notes
type: source
title: 向量检索技术
oneLiner: 向量检索通过语义匹配提升信息检索效果。
aliases: []
tags: []
sources:
  - raw/vector-search-notes.md
updated: '2026-10-12'
---

## 概要

向量检索将文本映射为向量，利用语义距离而非字面匹配进行检索，能召回语义相近但表述不同的内容。它包括嵌入、相似度计算和检索流程三个主要环节，与传统RAG系统密切相关但也存在局限性，如缺乏知识积累和需要重新计算向量库等。

## 关键论点

- 关键词检索依赖字面匹配。
- 嵌入模型的质量直接决定检索效果。
- 向量归一化之后，余弦相似度与欧氏距离给出的排序完全等价。
- 一次典型的向量检索分三步：把文档切成块并逐块计算嵌入、把用户查询也转成向量、在向量库里做近邻搜索。
- RAG 的瓶颈往往不在检索而在生成。
- 向量检索没有知识积累。

## 原文摘录

- 「向量检索把文本映射成向量，用语义距离代替字面匹配，因此能召回说法不同但意思相近的内容。」
- 「嵌入（embedding）是把一段文本映射成一个固定长度向量的过程。语义相近的文本，其向量在空间中的距离也更近。」
- 「常用余弦相似度衡量两个向量的接近程度。它只看向量方向、不看长度，因此对文本长短不敏感。」
- 「传统 RAG 的检索阶段常由向量检索实现，但 RAG 并不强制使用向量检索。」

## 相关页面

- [[concepts/cosine-similarity]]
- [[concepts/embedding]]
- [[concepts/retrieval-augmented-generation]]
- [[concepts/vector-retrieval]]
- [[concepts/vector-search-technology]]

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/cosine-similarity]]
- [[concepts/embedding]]
- [[concepts/retrieval-augmented-generation]]
- [[concepts/vector-retrieval]]
- [[concepts/vector-search-technology]]
