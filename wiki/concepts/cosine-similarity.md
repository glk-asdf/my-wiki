---
id: concepts/cosine-similarity
type: concept
title: 余弦相似度
oneLiner: 衡量两个向量接近程度的指标，只看向量方向不看长度
aliases: []
tags: []
sources:
  - raw/vector-search-notes.md
updated: '2026-10-12'
---

## 定义
余弦相似度是衡量两个向量接近程度的指标，只看向量方向不看长度。

## 与其他概念的关系
余弦相似度是[[concepts/vector-retrieval]]中衡量向量相似度的方法。在[[concepts/embedding]]过程中，语义相近的文本，其向量在空间中的距离也更近，这时可以使用余弦相似度来衡量它们的相似程度。

## 出处
- [[sources/vector-search-notes]]：「常用余弦相似度衡量两个向量的接近程度。它只看向量方向、不看长度，因此对文本长短不敏感。」

<!-- AUTO-BACKLINKS -->
## 反向链接

- [[concepts/embedding]]
- [[concepts/vector-retrieval]]
- [[concepts/vector-search-technology]]
- [[sources/vector-search-notes]]
