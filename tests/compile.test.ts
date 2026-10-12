import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bodyLength,
  buildSourcePage,
  canonicalTitleKey,
  checkSelfLinks,
  checkUpdateIntegrity,
  formatPlan,
  headingsOf,
  isVerbatim,
  nearDuplicateTitles,
  planToWorkItems,
  renderLinkCandidates,
  sanitizeDraftBody,
  sourceIdOf,
  sourceRelatedIds,
  suggestId,
} from '../src/compile.js';
import { withBacklinks } from '../src/links.js';
import type { Extract, IndexEntry, Op } from '../src/types.js';

const RAW = 'raw/llm-wiki-intro.md';

const extract: Extract = {
  title: 'LLM Wiki 概念介绍',
  oneLiner: '从临时检索到提前编译的知识管理范式',
  summary: '介绍一种把原始资料提前编译成结构化 Markdown 页面的知识管理方式。',
  claims: ['LLM Wiki 用提前编译替代 RAG 的临时检索'],
  concepts: [
    { name: '检索增强生成', definition: '查询时现场检索', evidence: '同一个问题问 100 次，它就要重复这个过程 100 次' },
    { name: '编造出来的摘录', definition: '不存在', evidence: '这句话原文里根本没有' },
  ],
  entities: [{ name: 'Andrej Karpathy', kind: '人物', evidence: '由 AI 领域知名研究者 Andrej Karpathy' }],
  relationHints: [{ from: '检索增强生成', to: 'LLM Wiki', relation: '两者是不同范式' }],
};

test('sourceIdOf：由素材文件名机械推导，中文与空格都被规范化', () => {
  assert.equal(sourceIdOf('raw/llm-wiki-intro.md'), 'sources/llm-wiki-intro');
  assert.equal(sourceIdOf('raw/子目录/My Note.md'), 'sources/my-note');
});

test('sanitizeDraftBody：剥掉模型擅自加的 frontmatter 与反向链接区块', () => {
  const withFrontmatter = '---\nid: concepts/x\ntype: concept\n---\n\n## 定义\n\n内容。';
  assert.equal(sanitizeDraftBody(withFrontmatter), '## 定义\n\n内容。');

  const withBacklinks = '## 定义\n\n内容。\n\n<!-- AUTO-BACKLINKS -->\n## 反向链接\n\n- [[concepts/a]]';
  assert.equal(sanitizeDraftBody(withBacklinks), '## 定义\n\n内容。');
});

test('isVerbatim：忽略空白差异的逐字命中，拒绝编造与过短片段', () => {
  const raw = '这种模式能产生显著的"复利效应"。当你新增一份资料时，\n模型会通读整个现有 Wiki。';
  assert.equal(isVerbatim('当你新增一份资料时，模型会通读整个现有 Wiki', raw), true, '换行差异应被忽略');
  assert.equal(isVerbatim('当你新增一份资料时，模型会通读整个现有 Wiki。做更多事', raw), false, '编造的不算');
  assert.equal(isVerbatim('复利效应', raw), false, '过短片段不予采信，避免伪命中');
});

test('isVerbatim：原文是弯引号、模型抄成直引号时，仍算逐字（回归：实测丢了 2 条真实摘录）', () => {
  const raw = '它的核心思路，是用“提前编译”替代传统 RAG 的“临时检索”。这种模式能产生“复利效应”。';
  const copied = '它的核心思路，是用"提前编译"替代传统 RAG 的"临时检索"';
  assert.equal(isVerbatim(copied, raw), true, '引号类型不该影响逐字判定');

  // 但换了词或语序就不算
  assert.equal(isVerbatim('它的核心思路，是用"预先编译"替代传统 RAG 的"临时检索"', raw), false);
  assert.equal(isVerbatim('它的核心思路，是用"临时检索"替代传统 RAG 的"提前编译"', raw), false, '语序调换不算逐字');
});

test('isVerbatim：全角标点与半角等价（NFKC 覆盖的那一类）', () => {
  const raw = '它通常由三个层次构成：原始素材层（只读）、Wiki 层、Schema 层。';
  assert.equal(isVerbatim('它通常由三个层次构成:原始素材层(只读)、Wiki 层、Schema 层。', raw), true);
});

test('isVerbatim：原文带 Markdown 强调记号时，仍然认可这是逐字引用', () => {
  // 回归：原文写作 `**Andrej Karpathy**`，模型抄录时去掉了星号，
  // 早期实现只忽略空白，于是把这条真实摘录误判成编造并丢弃
  const raw = '由 AI 领域知名研究者 **Andrej Karpathy** 在 2026 年 4 月提出。';
  assert.equal(isVerbatim('由 AI 领域知名研究者 Andrej Karpathy 在 2026 年 4 月提出', raw), true);
  assert.equal(isVerbatim('由另一位研究者 Andrej Karpathy 在 2026 年 4 月提出', raw), false, '改了字就不算逐字');
});

test('headingsOf：只取一级小节标题', () => {
  assert.deepEqual(headingsOf('# 大标题\n\n## 定义\n\n### 子标题\n\n## 出处\n'), ['定义', '出处']);
  assert.deepEqual(headingsOf('没有标题的正文'), []);
});

test('checkUpdateIntegrity：原有小节被丢掉时必须报出来', () => {
  const before = '## 定义\n\n内容。\n\n## 机制\n\n内容。\n\n## 出处\n\n- 摘录';
  const good = '## 定义\n\n新内容。\n\n## 机制\n\n内容。\n\n## 出处\n\n- 摘录';
  assert.deepEqual(checkUpdateIntegrity(before, good), []);

  // 模型把整篇重写，顺手丢掉了「机制」
  const lost = '## 定义\n\n重写后的内容。\n\n## 出处\n\n- 摘录';
  assert.deepEqual(checkUpdateIntegrity(before, lost), ['原有小节「机制」在更新后消失了']);
});

test('checkUpdateIntegrity：禁止新增兜底小节与重复小节', () => {
  const before = '## 定义\n\n内容。';
  const withBoilerplate = '## 定义\n\n内容。\n\n## 补充说明\n\n堆在这里的新事实';
  assert.deepEqual(checkUpdateIntegrity(before, withBoilerplate), ['新增了兜底小节「补充说明」']);

  const duplicated = '## 定义\n\n内容。\n\n## 定义\n\n又一遍';
  assert.deepEqual(checkUpdateIntegrity(before, duplicated), ['小节「定义」重复出现']);

  // 已经存在的小节不算「新增」
  const keepExisting = '## 补充说明\n\n内容。';
  assert.deepEqual(checkUpdateIntegrity('## 补充说明\n\n旧内容。', keepExisting), []);

  // 合法的新增小节不该被拦
  assert.deepEqual(checkUpdateIntegrity(before, '## 定义\n\n内容。\n\n## 局限\n\n新写的'), []);
});

test('checkUpdateIntegrity：忽略程序生成的反向链接区块', () => {
  const before = withBacklinks('## 定义\n\n内容。', ['concepts/a']);
  const after = withBacklinks('## 定义\n\n新内容。', ['concepts/a', 'concepts/b']);
  assert.deepEqual(checkUpdateIntegrity(before, after), [], '反向链接区块不属于模型要维护的小节');
});

test('checkSelfLinks：页面不得链接到自己', () => {
  assert.deepEqual(checkSelfLinks('见 [[concepts/rag]]。', 'concepts/rag'), [
    '正文里出现了指向自己的链接 [[concepts/rag]]，没有意义，请去掉',
  ]);
  assert.deepEqual(checkSelfLinks('见 [[concepts/other]]。', 'concepts/rag'), []);
  // 反向链接区块里出现自己的名字不算自链接（那是别人指过来造成的）
  assert.deepEqual(checkSelfLinks(withBacklinks('内容。', ['concepts/rag']), 'concepts/rag'), []);
});

test('bodyLength：只数非空白字符，且不含反向链接区块', () => {
  assert.equal(bodyLength('一二三'), 3);
  assert.equal(bodyLength('一二 三\n四'), 4);
  assert.equal(bodyLength(withBacklinks('一二三', ['concepts/a'])), 3);
});

test('renderLinkCandidates：必须列出程序创建的摘要页 id（回归：曾让真实编译卡住）', () => {
  // 摘要页由程序创建，模型无从猜到 id；模板却要求它在「出处」链接摘要页。
  // 少了这一条，模型只能拿素材路径去凑，写出 [[raw/llm-wiki-intro.md]] 这种非法链接
  const text = renderLinkCandidates([], ['concepts/llm-wiki'], 'sources/llm-wiki-intro');
  assert.match(text, /- concepts\/llm-wiki — （本次新建）/);
  assert.match(text, /- sources\/llm-wiki-intro — 本素材的摘要页.*不要写 raw\/ 路径/);

  // 摘要页已出现在卡片列表里时不重复
  const cards: IndexEntry[] = [
    {
      id: 'sources/llm-wiki-intro',
      type: 'source',
      title: '摘要页',
      oneLiner: '一句话',
      aliases: [],
      tags: [],
      outLinks: [],
      inLinks: [],
      updated: '2026-10-12',
    },
  ];
  const deduped = renderLinkCandidates(cards, [], 'sources/llm-wiki-intro');
  assert.equal(deduped.split('\n').filter((line) => line.startsWith('- sources/llm-wiki-intro ')).length, 1);
});

test('suggestId：拿标题拼出来的 id 要能给出正确建议（真实踩到的重试原因）', () => {
  const known = ['concepts/llm-wiki', 'concepts/提前编译', 'entities/andrej-karpathy'];
  const byTitle = new Map([
    ['llmwiki', 'concepts/llm-wiki'],
    ['andrejkarpathy', 'entities/andrej-karpathy'],
  ]);

  // 实测模型写过 [[concepts/LLM Wiki]]：前缀对、末段是标题、还带空格
  assert.equal(suggestId('concepts/LLM Wiki', known, byTitle), 'concepts/llm-wiki');
  // 只写标题、不带前缀
  assert.equal(suggestId('LLM Wiki', known, byTitle), 'concepts/llm-wiki');
  // 中文标题靠别名索引兜住
  assert.equal(suggestId('concepts/提前编译', known, byTitle), 'concepts/提前编译');
  // 完全对不上的，不要瞎猜
  assert.equal(suggestId('concepts/毫无关系的东西', known, byTitle), null);
});

test('nearDuplicateTitles：只报「规范键不同但仍是前缀关系」的存疑对，已能自动合并的不再报', () => {
  // 规范键相同（含修饰后缀剥离）→ 已被批内合并自动处理，这里不再报警
  assert.deepEqual(nearDuplicateTitles(['向量检索技术', '向量检索']), []);
  assert.deepEqual(nearDuplicateTitles(['RAG 系统', 'RAG']), []);
  // 规范键不同、但存在前缀包含（可能是不同粒度：向量 / 向量检索）→ 仍要提醒人判断
  const warn = nearDuplicateTitles(['向量', '向量检索']);
  assert.equal(warn.length, 1);
  assert.ok(warn[0]!.includes('向量') && warn[0]!.includes('向量检索'), `实际警告：${warn[0]}`);
  // 完全不相关的不要乱报
  assert.deepEqual(nearDuplicateTitles(['向量检索', '关键词检索', '复利效应']), []);
});

test('canonicalTitleKey：剥离中文修饰性后缀，把 X技术 / X 视作同一概念', () => {
  assert.equal(canonicalTitleKey('向量检索技术'), canonicalTitleKey('向量检索'));
  assert.equal(canonicalTitleKey('RAG 系统'), canonicalTitleKey('RAG'));
  assert.equal(canonicalTitleKey('RAG 算法'), canonicalTitleKey('RAG'));
  // 没有修饰后缀则原样归约
  assert.equal(canonicalTitleKey('余弦相似度'), '余弦相似度');
  // 整个词就是后缀（如单字「技术」）不能误并
  assert.equal(canonicalTitleKey('技术'), '技术');
  // 区分不同粒度：向量 与 向量检索 规范键不同
  assert.notEqual(canonicalTitleKey('向量'), canonicalTitleKey('向量检索'));
});

test('planToWorkItems：批内两个近义标题合并为一页，保留更泛的标题', () => {
  const ops: Op[] = [
    { op: 'create', type: 'concept', title: '向量检索技术', oneLiner: 'x', slug: 'vector-search-technology', reason: 'r1' },
    { op: 'create', type: 'concept', title: '向量检索', oneLiner: 'y', slug: 'vector-retrieval', reason: 'r2' },
  ];
  const { items } = planToWorkItems(ops, new Set(), new Map(), new Map());
  assert.equal(items.length, 1, '两个近义标题应合并成一个 create');
  assert.equal(items[0]!.title, '向量检索', '应保留更泛的标题');
  assert.equal(items[0]!.id, 'concepts/vector-retrieval', 'id 应随更泛的标题同步');
  assert.ok(items[0]!.patch.includes('r1') && items[0]!.patch.includes('r2'), '两方的 patch 都要保留');
});

test('planToWorkItems：模型写了 X技术 而已有页面叫 X 时，create 收敛为 update', () => {
  const ops: Op[] = [{ op: 'create', type: 'concept', title: 'RAG 系统', oneLiner: 'x', slug: 'rag-system', reason: 'r' }];
  const existingByTitle = new Map([['rag', 'concepts/rag']]);
  const existing = new Map([
    ['concepts/rag', { meta: { id: 'concepts/rag', type: 'concept', title: 'RAG', oneLiner: '检索增强生成', aliases: [] } } as never],
  ]);
  const { items, convertedToUpdate } = planToWorkItems(ops, new Set(), existing, existingByTitle);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'update', '应收敛为 update');
  assert.equal(items[0]!.id, 'concepts/rag');
  assert.deepEqual(convertedToUpdate, ['RAG 系统 → concepts/rag']);
});

test('formatPlan：四种操作都能打印', () => {
  const ops: Op[] = [
    { op: 'create', type: 'concept', title: '检索增强生成（RAG）', oneLiner: '查询时做功', reason: 'r' },
    { op: 'update', targetId: 'concepts/llm-wiki', patch: '在对比下补充成本', reason: 'r' },
    { op: 'link', fromId: 'concepts/a', toId: 'concepts/b', reason: 'r' },
    { op: 'noop', reason: '已覆盖' },
  ];
  const text = formatPlan(ops);
  assert.match(text, /\[create\] concept 检索增强生成（RAG）/);
  assert.match(text, /\[update\] concepts\/llm-wiki/);
  assert.match(text, /\[link\]\s+concepts\/a -> concepts\/b/);
  assert.match(text, /\[noop\]\s+已覆盖/);
});

test('buildSourcePage：无法逐字命中的摘录被丢弃，而不是写进 wiki', () => {
  const { page, notVerbatim, duplicates } = buildSourcePage(
    {
      rawRelPath: RAW,
      extract,
      rawText:
        '文中说：同一个问题问 100 次，它就要重复这个过程 100 次。\n另外，由 AI 领域知名研究者 Andrej Karpathy 提出。',
      cards: [],
      titleIndex: new Map(),
      knownIds: new Set(['concepts/rag', 'sources/llm-wiki-intro']),
      newIds: ['concepts/rag'],
    },
    ['concepts/rag'],
  );

  assert.equal(page.meta.id, 'sources/llm-wiki-intro');
  assert.equal(page.meta.type, 'source');
  assert.equal(page.meta.title, extract.title);
  assert.deepEqual(page.meta.sources, [RAW]);

  assert.ok(page.body.includes('同一个问题问 100 次'), '命中的摘录应保留');
  assert.ok(page.body.includes('Andrej Karpathy'), '实体摘录同样保留');
  assert.ok(!page.body.includes('这句话原文里根本没有'), '编造的摘录必须被丢掉');
  assert.equal(notVerbatim, 1);
  assert.equal(duplicates, 0);
});

test('buildSourcePage：逐字相同但重复的摘录算「合并」，不算「丢弃」', () => {
  // 实测踩到：4 个工具实体常共用同一句原文，早期实现把它算进「丢弃」，
  // 日志于是显示「丢弃 5 条无法逐字命中的摘录」，看日志的人会以为模型在编造
  const shared = '由 AI 领域知名研究者 Andrej Karpathy 提出';
  const dupExtract: Extract = {
    ...extract,
    concepts: [{ name: '甲', definition: '', evidence: shared }],
    entities: [
      { name: '乙', kind: '工具', evidence: shared },
      { name: '丙', kind: '工具', evidence: shared },
    ],
  };

  const { page, notVerbatim, duplicates } = buildSourcePage(
    {
      rawRelPath: RAW,
      extract: dupExtract,
      rawText: `另外，${shared}。`,
      cards: [],
      titleIndex: new Map(),
      knownIds: new Set(['sources/llm-wiki-intro']),
      newIds: [],
    },
    [],
  );

  assert.equal(notVerbatim, 0, '三条都是逐字命中，不该算作丢弃');
  assert.equal(duplicates, 2, '另外两条是重复');
  assert.equal(page.body.split(shared).length - 1, 1, '同一句原文在摘要页里只出现一次');
});

test('buildSourcePage：把相关页面列进「相关页面」，这是知识网络的接缝', () => {
  const { page } = buildSourcePage(
    {
      rawRelPath: RAW,
      extract,
      rawText: '同一个问题问 100 次，它就要重复这个过程 100 次',
      cards: [],
      titleIndex: new Map(),
      knownIds: new Set(['concepts/rag', 'entities/andrej-karpathy']),
      newIds: ['concepts/rag', 'entities/andrej-karpathy'],
    },
    ['concepts/rag', 'entities/andrej-karpathy'],
  );
  assert.match(page.body, /## 相关页面\n\n- \[\[concepts\/rag\]\]\n- \[\[entities\/andrej-karpathy\]\]/);
});

test('buildSourcePage：正文不含反向链接区块（那是 reindex 的职责）', () => {
  const { page } = buildSourcePage(
    {
      rawRelPath: RAW,
      extract,
      rawText: '同一个问题问 100 次，它就要重复这个过程 100 次',
      cards: [],
      titleIndex: new Map(),
      knownIds: new Set(),
      newIds: [],
    },
    [],
  );
  assert.ok(!page.body.includes('AUTO-BACKLINKS'));
  assert.ok(!page.body.includes('## 反向链接'));
});

test('sourceRelatedIds：重编译时仍能凭标题命中已有页面（回归：曾导致相关页面被清空）', () => {
  // 首次编译：页面是刚建出来的，只能靠 newIds
  const first = sourceRelatedIds(extract, new Map(), ['concepts/rag', 'concepts/compile-time']);
  assert.deepEqual(first, ['concepts/compile-time', 'concepts/rag']);

  // 第二次编译：没有新建页，但抽取出的名称可以映射回已有页面
  // 键是 titleKey 归一化后的形式：全小写、去掉空白与标点
  const existingByTitle = new Map([
    ['检索增强生成', 'concepts/rag'],
    ['andrejkarpathy', 'entities/andrej-karpathy'],
  ]);
  const second = sourceRelatedIds(extract, existingByTitle, []);
  assert.deepEqual(second, ['concepts/rag', 'entities/andrej-karpathy'], '链接不应凭空消失');

  // 归一化要吃掉全角括号与大小写差异：模型抽出的名称与页面标题常常不是逐字相同
  const withParen = {
    ...extract,
    concepts: [{ name: '检索增强生成（RAG）', definition: '', evidence: '' }],
    entities: [],
  };
  assert.deepEqual(sourceRelatedIds(withParen, new Map([['检索增强生成rag', 'concepts/rag']]), []), [
    'concepts/rag',
  ]);
});
