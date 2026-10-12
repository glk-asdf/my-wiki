---
id: concepts/vector-retrieval
type: concept
title: 向量检索
oneLiner: 把文本映射成向量，用语义距离代替字面匹配的检索方法
aliases: []
tags: []
sources:
  - raw/vector-search-notes.md
updated: '2026-10-12'
---

## 定义
向量检索把文本映射成向量，用语义距离代替字面匹配，因此能召回说法不同但意思相近的内容。

## 机制
一次典型的向量检索分三步：把文档切成块并逐块计算嵌入、把用户查询也转成向量、在向量库里做近邻搜索。向量归一化之后，余弦相似度与欧氏距离给出的排序完全等价。嵌入模型的质量直接决定检索效果。

## 与其他概念的关系
[[concepts/embedding]]是向量检索的核心组成部分。[[concepts/cosine-similarity]]是向量检索中衡量向量相似度的方法。向量检索常作为[[concepts/retrieval-augmented-generation]]系统的检索组件。

## 出处
- [[sources/vector-search-notes]]：「向量检索把文本映射成向量，用语义距离代替字面匹配，因此能召回说法不同但意思相近的内容。」
- [[sources/vector-search-notes]]：「一次典型的向量检索分三步：把文档切成块并逐块计算嵌入、把用户查询也转成向量、在向量库里做近邻搜索。」
- [[sources/vector-search-notes]]：「向量归一化之后，余弦相似度与欧氏距离给出的排序完全等价。」
- [[sources/vector-search-notes]]：「嵌入模型的质量直接决定检索效果。」

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/cosine-similarity]]
- [[concepts/embedding]]
- [[sources/vector-search-notes]]
