---
id: concepts/vector-search-technology
type: concept
title: 向量检索技术
oneLiner: 通过语义匹配提升信息检索效果
aliases: []
tags: []
sources:
  - raw/vector-search-notes.md
updated: '2026-10-12'
---

## 定义
向量检索技术是把文本映射成向量，用语义距离代替字面匹配的检索方法，能召回说法不同但意思相近的内容。

## 机制
向量检索包括三个主要环节：嵌入、相似度计算和检索流程。一次典型的向量检索分三步：把文档切成块并逐块计算嵌入、把用户查询也转成向量、在向量库里做近邻搜索。嵌入模型的质量直接决定检索效果。向量归一化之后，余弦相似度与欧氏距离给出的排序完全等价。

## 与其他概念的关系
- [[concepts/embedding]]：嵌入是向量检索的核心组成部分，把文本映射成固定长度向量
- [[concepts/cosine-similarity]]：余弦相似度是向量检索中衡量向量相似度的方法
- [[concepts/retrieval-augmented-generation]]：向量检索常作为RAG系统的检索组件

## 出处
- [[sources/vector-search-notes]]：「向量检索把文本映射成向量，用语义距离代替字面匹配，因此能召回说法不同但意思相近的内容。」
- [[sources/vector-search-notes]]：「嵌入（embedding）是把一段文本映射成一个固定长度向量的过程。语义相近的文本，其向量在空间中的距离也更近。」
- [[sources/vector-search-notes]]：「常用余弦相似度衡量两个向量的接近程度。它只看向量方向、不看长度，因此对文本长短不敏感。」
- [[sources/vector-search-notes]]：「一次典型的向量检索分三步：把文档切成块并逐块计算嵌入、把用户查询也转成向量、在向量库里做近邻搜索。」
- [[sources/vector-search-notes]]：「传统 RAG 的检索阶段常由向量检索实现，但 RAG 并不强制使用向量检索。」

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/retrieval-augmented-generation]]
- [[sources/vector-search-notes]]
