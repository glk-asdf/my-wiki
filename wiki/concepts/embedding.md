---
id: concepts/embedding
type: concept
title: 嵌入
oneLiner: 把一段文本映射成一个固定长度向量的过程
aliases: []
tags: []
sources:
  - raw/vector-search-notes.md
updated: '2026-10-12'
---

## 定义
嵌入是把一段文本映射成一个固定长度向量的过程。语义相近的文本，其向量在空间中的距离也更近。

## 机制
嵌入模型的质量直接决定检索效果。向量归一化之后，余弦相似度与欧氏距离给出的排序完全等价。

## 与其他概念的关系
嵌入是[[concepts/vector-retrieval]]的核心组成部分，通过[[concepts/cosine-similarity]]衡量向量间的相似性，并常用于[[concepts/retrieval-augmented-generation]]系统的检索阶段。

## 出处
- [[sources/vector-search-notes]]：「嵌入（embedding）是把一段文本映射成一个固定长度向量的过程。语义相近的文本，其向量在空间中的距离也更近。」

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/cosine-similarity]]
- [[concepts/vector-retrieval]]
- [[concepts/vector-search-technology]]
- [[sources/vector-search-notes]]
