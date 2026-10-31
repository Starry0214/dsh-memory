// 归类提案引擎（只读）—— task-17（task-12 驳回版重做）
//
// 驳回原因（Lead 2026-10-29 复核，必须记住）：
//   上一版用"单链接连通分量 + MST 切分"，一条弱边就能把两个项目桥接，再靠"凑满 24 人"把簇做大。
//   结果 19 个簇里 15 个是链式效应：24 人簇 density 只有 0.098、avgNameSim 0.14、avgJaccard 0.000，
//   把 `.HNSZF 标书解包` / `agent周事项` / `bid-system-api` / `发改委补档` 硬串在一起。
//   **数字达标是假的，不能用于合并。**
//
// 本版三条硬要求（缺一不可）：
//   1) 强内聚闸：簇必须 density≥0.35 且 avgNameSim≥0.35 且（avgJaccard≥0.05 或 ≥60% 成员共享高区分度 trigger），
//      达不到 ⇒ 整个簇不进 clusters（进 rejectedClusters 供人工看）。
//   2) 禁链式：边需 ≥2 类独立证据（name / jaccard / high-trigger）；单证据边只能进 ≤3 人簇；
//      簇内每个成员度数 ≥2（2 人簇除外，那正是"单证据≤3 人簇"的用例）。
//   3) 项目级族边界：去 MEMORY-/日期/md/模板话术后比"项目主体"（最长公共前缀规则），
//      **跨族硬禁止同簇**（任何证据组合都不能突破）。
//
// 另一条产品口径：**不许为凑 ≤60 牺牲纯度**。本模块同时报 strict（只采纳过闸簇）与 familyPlan（按族分层、需人工确认）两个主主题数。
//
// 只读保证：只调 store.topics() / be.listSentences()；CLI 检测到未 checkpoint 的 -wal 时复制快照读取，
// 原库文件 sha256 前后必须一致（spec X07 / C11 断言）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeName, normalizeTrigger, nameSimilarity, triggerCoverage,
} from './governance.mjs';

// ---------------------------------------------------------------------------
// 0. 配置与错误
// ---------------------------------------------------------------------------

/**
 * 归类提案默认配置。全部可被 proposeClusters(store, cfg) 的 cfg 覆盖。
 *
 * 关键口径（Lead 2026-10-29 驳回后修订）：
 *   · 强内聚闸 minDensity/minAvgNameSim/minAvgJaccard/minTriggerMemberRatio —— 不达标不提案
 *   · jaccardThreshold 从 0.15 降到 0.05：正文重叠的证据阈值与闸门保持一致（0.15 在真实库只命中 33 对）
 *   · trivialSentenceChars 8：短于 8 字的句子（分隔线/单个词）不算"正文重叠"证据，否则模板行会制造假证据
 *   · highTriggerMinChars 4 / highTriggerMaxTopics 3：高区分度 trigger 定义（Lead 指定）
 *   · 族边界：纯汉字前缀≥3 / 纯字母数字前缀≥5 / 混合前缀≥4 且含汉字
 */
export const DEFAULT_CURATION_CONFIG = Object.freeze({
  // ---- 簇形态 ----
  maxClusterSize: 24,          // 上限（本版不再靠"凑满"聚类；超限直接拒绝而不是硬切）
  minClusterTopics: 2,
  singleEvidenceMaxSize: 3,    // 单证据边只能进 ≤3 人簇
  includeStates: Object.freeze(['draft', 'active', 'needs_review', 'dormant']),

  // ---- 项目级族边界（去修饰后 LCP 规则）----
  familyCjkPrefixMin: 3,       // 纯汉字前缀 ≥3 字才算同项目（"长沙" 2 字不算，"发改委" 3 字算）
  familyLatinPrefixMin: 5,     // 纯字母数字前缀 ≥5 字（"dsh" 不算，"dshmemory" 算）
  familyMixedPrefixMin: 4,     // 混合前缀 ≥4 字且含汉字（"107服务器"、"epointmsg插件"）

  // ---- 证据 ----
  nameSimThreshold: 0.6,
  jaccardThreshold: 0.05,
  trivialSentenceChars: 8,
  highTriggerMinChars: 4,
  highTriggerMaxTopics: 3,     // 覆盖率 ≤3（Lead：不是 5）
  triggerDenyList: Object.freeze([
    'md', 'mjs', 'cjs', 'js', 'json', 'jsonl', 'ps1', 'py', 'txt', 'yml', 'yaml', 'db', 'html', 'css', 'sh',
    'oa', 'mb', 'memory', 'global', 'tools', 'sessions', 'knowledge', 'index',
    '原文一字未删', '原文逐字未改', '原文逐字未删', '原文照搬', '原样保留',
  ]),

  // ---- 强内聚闸 ----
  minDensity: 0.35,
  minAvgNameSim: 0.35,
  minAvgJaccard: 0.05,
  minTriggerMemberRatio: 0.6,

  // ---- 三级结构 / series 判据（task-19）----
  seriesMaxGapDays: 7,         // 相邻两期日期差 ≤7 天 ⇒ 同一 series 组
  seriesMaxSpanDays: 30,       // 单组跨度上限（防链式把 8 月与 12 月串成一组）
  seriesPatterns: Object.freeze(['日摘要', '会话摘要', '摘要']),
  sessionHotDays: 7,           // D7 会话检查点的"最近 N 天"窗口（滚动 7 热 / 30 温 / 90 沉）

  // ---- keep 建议 / 标题 ----
  keepMaxSentences: 120,
  keepMaxChars: 6000,
  titleMaxChars: 48,
  hugeTopicChars: 200000,

  targets: Object.freeze({
    maxActiveMainTopics: 60,
    maxAvgSentencesPerMain: 120,
  }),
});

export function mergeCurationConfig(cfg = {}) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const c = { ...DEFAULT_CURATION_CONFIG, ...src };
  c.targets = { ...DEFAULT_CURATION_CONFIG.targets, ...(src.targets || {}) };
  c.includeStates = Array.isArray(c.includeStates) && c.includeStates.length
    ? c.includeStates.slice()
    : DEFAULT_CURATION_CONFIG.includeStates.slice();
  c.triggerDenySet = new Set((c.triggerDenyList || []).map(normalizeTrigger).filter(Boolean));
  return c;
}

export class CurationError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CurationError';
    this.code = code;
    this.detail = detail || null;
  }
}

/** 写库入口 —— 本阶段故意不实现（归类应用阶段是 task-13，不在本模块）。 */
export function applyProposals() {
  throw new CurationError('NOT_IMPLEMENTED', '归类提案引擎本阶段只读：--apply 未实现（禁止写库）', {
    hint: '先由 Lead 逐簇人工裁决；写库在 task-13（mergeCluster/linkParent）单独实现并配审计。',
  });
}

// ---------------------------------------------------------------------------
// 1. 只读取数
// ---------------------------------------------------------------------------

function sentencesOf(store, topicId) {
  const be = store && store.be;
  if (be && typeof be.listSentences === 'function') return be.listSentences(topicId) || [];
  if (store && typeof store.readTopic === 'function') {
    try { return (store.readTopic(topicId).sentences || []); } catch { return []; }
  }
  return [];
}

function activeTriggersOf(topic) {
  if (!topic) return [];
  if (Array.isArray(topic.activeTriggers)) return topic.activeTriggers;
  return Array.isArray(topic.triggers) ? topic.triggers : [];
}

function sentenceKey(row) {
  if (!row) return '';
  if (row.sha) return 'sha:' + row.sha;
  const txt = typeof row.text === 'string' ? row.text : '';
  return 'txt:' + normalizeName(txt) + '#' + txt.length;
}

// ---------------------------------------------------------------------------
// 2. 项目级族识别（Lead 修法 3）
// ---------------------------------------------------------------------------

/**
 * 去掉"文件名/日期/模板"修饰，留下项目主体候选串。
 *
 * 为什么不能直接用字符串前缀：真实库里 115 个主题以 `MEMORY-` 开头、大量主题带 `（2026-10-22 …）`
 * 与 `.md`。这些是文件修饰，不是项目名；拿它们当前缀会把 `.HNSZF 标书解包` 与 `agent周事项`
 * 这种完全无关的东西连成一族（上一版翻车根因之一）。
 */
export function stripDecorations(name) {
  let s = normalizeName(name);
  s = s.replace(/^memory/, '');                                  // MEMORY- 文件前缀
  s = s.replace(/(19|20)\d{2}(\d{4}|\d{2})?/g, '');              // 2026 / 202610 / 20261022
  s = s.replace(/\d{1,2}月\d{1,2}日?/g, '');                     // 10月22日
  s = s.replace(/原文一字未删|原文逐字未改|原文逐字未删|原文照搬|原样保留|逐字未改/g, '');
  s = s.replace(/md$/, '');                                      // 尾部 .md
  return s;
}

/** 最长公共前缀长度 */
export function commonPrefixLen(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
  const n = Math.min(A.length, B.length);
  let i = 0;
  while (i < n && A[i] === B[i]) i += 1;
  return i;
}

/**
 * 两个"项目主体候选串"是否属于同一项目族（对称，不保证传递 ⇒ 用并查集取等价类）。
 *
 * 规则（全部基于去修饰后的串）：
 *   · 完全相同 ⇒ 同族；
 *   · 纯数字前缀不算（"2026" 会误连）；
 *   · 纯汉字前缀 ≥ familyCjkPrefixMin(3) ⇒ 同族（"发改委" 3 字 ✓；"长沙" 2 字 ✗ 防误连长沙项目/长沙数据分析）；
 *   · 纯字母数字前缀 ≥ familyLatinPrefixMin(5) ⇒ 同族（"dshmemory" ✓；"dsh" 3 字母 ✗ 防 dsh-memory 与 dsh-remote 混）；
 *   · 混合前缀总长 ≥ familyMixedPrefixMin(4) 且含汉字 ⇒ 同族（"107服务器"、"epointmsg插件"）。
 */
export function sameProjectFamily(baseA, baseB, cfg = DEFAULT_CURATION_CONFIG) {
  const c = { ...DEFAULT_CURATION_CONFIG, ...(cfg || {}) };
  const A = String(baseA == null ? '' : baseA);
  const B = String(baseB == null ? '' : baseB);
  if (!A || !B) return false;
  if (A === B) return true;
  const len = commonPrefixLen(A, B);
  if (!len) return false;
  const L = A.slice(0, len);
  if (/^\d+$/.test(L)) return false;
  if (/^[\u4e00-\u9fa5]+$/.test(L) && L.length >= c.familyCjkPrefixMin) return true;
  if (/^[a-z0-9]+$/.test(L) && L.length >= c.familyLatinPrefixMin) return true;
  if (L.length >= c.familyMixedPrefixMin && /[\u4e00-\u9fa5]/.test(L)) return true;
  return false;
}

/**
 * 对全部主题做族等价类（并查集）。
 * 返回 { basesByTopic, familyRootOf, familyIndex, familyOfRoot }：
 *   familyRootOf: topicId -> root；familyIndex: root -> [topicId]；familyOfRoot: root -> {key, members}
 */
export function buildProjectFamilies(topics, cfg = DEFAULT_CURATION_CONFIG) {
  const c = { ...DEFAULT_CURATION_CONFIG, ...(cfg || {}) };
  const nameById = new Map(topics.map((t) => [t.id, t.name == null ? '' : String(t.name)]));
  const bases = new Map(topics.map((t) => [t.id, stripDecorations(t.name)]));
  /**
   * 族键兜底（Lead 2026-10-29 复验：D6 里 117 个族键退化成 `T-0283` 这种主题 ID = 未归类黑洞）。
   * 顺序：去修饰主干 → 去 MEMORY-/日期/.md 后再去数字 → 归一化后前 N 字符 → 原文前 12 字 → topic-xxxx。
   * 绝不再回落成主题 ID。
   */
  const fallbackKey = (id) => {
    const base = bases.get(id) || '';
    if (base) return base;
    const raw = normalizeName(nameById.get(id) || '');
    const cleaned = raw
      .replace(/^memory/, '')
      .replace(/(19|20)\d{2}(\d{4}|\d{2})?/g, '')
      .replace(/md$/, '')
      .replace(/\d+/g, '');
    if (cleaned) return cleaned.slice(0, 16);
    const alpha = raw.replace(/\d+/g, '');
    if (alpha) return alpha.slice(0, 12);
    const original = (nameById.get(id) || '').trim();
    if (original) return original.slice(0, 12);
    return 'topic-' + String(id).slice(-6);
  };
  const parent = new Map(topics.map((t) => [t.id, t.id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  const ids = topics.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (!sameProjectFamily(bases.get(ids[i]), bases.get(ids[j]), c)) continue;
      const ra = find(ids[i]);
      const rb = find(ids[j]);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);   // 字典序挂根 ⇒ 确定性
    }
  }
  const familyIndex = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!familyIndex.has(r)) familyIndex.set(r, []);
    familyIndex.get(r).push(id);
  }
  const familyRootOf = new Map();
  const familyOfRoot = new Map();
  for (const [root, members] of familyIndex) {
    members.sort();
    let key = '';
    if (members.length > 1) {
      let lcpKey = bases.get(members[0]) || '';
      for (const id of members.slice(1)) {
        const b = bases.get(id) || '';
        lcpKey = lcpKey.slice(0, commonPrefixLen(lcpKey, b));
        if (!lcpKey) break;
      }
      if (lcpKey.length >= 2) key = lcpKey;
    }
    if (!key) key = fallbackKey(members[0]);
    familyOfRoot.set(root, { key, members });
    for (const id of members) familyRootOf.set(id, root);
  }
  // 族键去重（确定性：按 root 字典序遍历）
  const seenKey = new Map();
  for (const root of [...familyOfRoot.keys()].sort()) {
    const info = familyOfRoot.get(root);
    const baseKey = info.key || 'family';
    const n = (seenKey.get(baseKey) || 0) + 1;
    seenKey.set(baseKey, n);
    info.key = n > 1 ? `${baseKey}#${n}` : baseKey;
  }
  return { basesByTopic: bases, familyRootOf, familyIndex, familyOfRoot };
}

// ---------------------------------------------------------------------------
// 3. 高区分度 trigger（Lead 修法 4）
// ---------------------------------------------------------------------------

/**
 * 高区分度 trigger：长度 ≥4、非纯数字/日期、非文件后缀/通用词、覆盖率 ≤3。
 * 只有这种 trigger 才能当"两个主题相似"的独立证据；2026/MB/OA/原文一字未删/dream/global 等
 * 都会被挡掉（长度不够、纯数字、在 denyList、或覆盖率超阈值）。
 */
export function isHighDiscriminatorTrigger(raw, coverage, cfg = DEFAULT_CURATION_CONFIG) {
  const c = { ...DEFAULT_CURATION_CONFIG, ...(cfg || {}) };
  const deny = c.triggerDenySet || new Set((c.triggerDenyList || []).map(normalizeTrigger).filter(Boolean));
  const n = normalizeTrigger(raw);
  if (!n || n.length < c.highTriggerMinChars) return false;
  if (/^\d+$/.test(n)) return false;
  if (/^(19|20)\d{2}(\d{2})?(\d{2})?$/.test(n)) return false;
  if (/^\d{1,2}月\d{1,2}日?$/.test(n)) return false;
  if (deny.has(n)) return false;
  const cov = Number(coverage);
  if (!Number.isFinite(cov) || cov > c.highTriggerMaxTopics) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 4. 建索引
// ---------------------------------------------------------------------------

function buildIndex(store, cfg) {
  const all = store.topics();
  const include = new Set(cfg.includeStates);
  // 已落树的容器（level=domain/project）是"结构壳"，不是内容：必须排除。
  // 否则上一版 apply 建的 36 个容器会被当成叶子收进新树（成员数虚高、层级爆炸）。
  const levelOfTopic = (id) => {
    try {
      if (typeof store.levelOf === 'function') return store.levelOf(id);
      if (store.be && typeof store.be.getMeta === 'function') return store.be.getMeta('level:' + id);
    } catch { /* 读不到 level ⇒ 当普通主题 */ }
    return null;
  };
  const containerIds = [];
  const topics = [];
  for (const t of all) {
    if (!include.has(t.state)) continue;
    const lv = levelOfTopic(t.id);
    if (lv === 'domain' || lv === 'project') { containerIds.push(t.id); continue; }
    topics.push(t);
  }
  const byId = new Map();
  const norm = new Map();
  const shas = new Map();        // topicId -> Set<sentenceKey>（只含有效句）
  const shaIndex = new Map();    // sentenceKey -> Set<topicId>
  const stat = new Map();
  let totalSentences = 0;
  let totalChars = 0;

  for (const t of topics) {
    byId.set(t.id, t);
    norm.set(t.id, t.norm || normalizeName(t.name));
    const rows = sentencesOf(store, t.id);
    const set = new Set();
    let chars = 0;
    for (const r of rows) {
      const charsOf = Number.isFinite(Number(r.chars)) ? Number(r.chars) : String(r.text || '').length;
      chars += charsOf;
      // 有效句：短句（分隔线/单词/模板标记）不进"正文重叠"证据，否则会制造假相似
      if (charsOf < cfg.trivialSentenceChars) continue;
      const k = sentenceKey(r);
      if (!k) continue;
      set.add(k);
      if (!shaIndex.has(k)) shaIndex.set(k, new Set());
      shaIndex.get(k).add(t.id);
    }
    shas.set(t.id, set);
    stat.set(t.id, { sentences: rows.length, chars, effectiveSentences: set.size });
    totalSentences += rows.length;
    totalChars += chars;
  }

  const byState = {};
  for (const t of topics) byState[t.state] = (byState[t.state] || 0) + 1;

  // trigger 覆盖率（只看生效中的 triggers）
  const cov = triggerCoverage(topics.map((t) => ({ id: t.id, triggers: activeTriggersOf(t) })));
  const highNorms = new Set();
  const highTriggers = [];
  const genericTriggers = [];
  for (const e of cov.values()) {
    if (isHighDiscriminatorTrigger(e.trigger, e.coverage, cfg)) {
      highNorms.add(e.norm);
      highTriggers.push({ trigger: e.trigger, norm: e.norm, coverage: e.coverage });
    } else if (e.coverage > cfg.highTriggerMaxTopics) {
      genericTriggers.push({ trigger: e.trigger, norm: e.norm, coverage: e.coverage });
    }
  }
  highTriggers.sort((a, b) => (a.coverage - b.coverage) || (a.norm < b.norm ? -1 : 1));
  genericTriggers.sort((a, b) => b.coverage - a.coverage || (a.norm < b.norm ? -1 : 1));

  // 项目族
  const fam = buildProjectFamilies(topics, cfg);
  const familyKeyOf = new Map();
  const familyMembers = new Map();
  for (const [root, info] of fam.familyOfRoot) {
    familyMembers.set(root, info.members);
    for (const id of info.members) familyKeyOf.set(id, info.key);
  }

  return {
    store,
    allTopics: all,
    topics,
    byId,
    norm,
    shas,
    shaIndex,
    stat,
    cov,
    highNorms,
    highTriggers,
    genericTriggers,
    bases: fam.basesByTopic,
    familyRootOf: fam.familyRootOf,
    familyKeyOf,
    familyMembers,
    totals: { topics: topics.length, allTopics: all.length, sentences: totalSentences, chars: totalChars },
    byState,
    skippedContainers: containerIds.length,
    containerIds,
  };
}

// ---------------------------------------------------------------------------
// 5. 证据（边）
// ---------------------------------------------------------------------------

const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const EVIDENCE_LABELS = { name: 'name-similarity', jac: 'shared-sentences', trig: 'high-trigger' };

/**
 * 候选对与证据。**只在同一项目族内建边**（跨族硬禁止，任何证据都不能突破）。
 * 证据三类：
 *   name —— 名字相似度 ≥ nameSimThreshold
 *   jac  —— 有效句 Jaccard ≥ jaccardThreshold（短句不计）
 *   trig —— 共享 ≥1 个高区分度 trigger
 * 边能否用：≥2 证据 = 强边；=1 证据 = 弱边（只能进 ≤3 人簇）。
 */
function buildEvidence(idx, cfg) {
  const pairs = new Map();
  // 跨族证据统计：证明"跨族硬禁止"不是口号 —— 这些对即使证据很硬也不会进 pairs。
  // Lead 验收要求"rejectedClusters 里要能看到跨族原因"，跨族在建边阶段就被拦下，
  // 所以这里单独把它量化出来（数 + 样例），比在 rejected 里塞假簇更诚实。
  const crossFamily = { namePairs: 0, triggerPairs: 0, jacPairs: 0, samples: [] };
  const noteCross = (kind, a, b, extra) => {
    if (kind === 'name') crossFamily.namePairs += 1;
    else if (kind === 'trig') crossFamily.triggerPairs += 1;
    else crossFamily.jacPairs += 1;
    if (crossFamily.samples.length < 12) {
      crossFamily.samples.push({
        kind,
        a, b,
        aName: (idx.byId.get(a) || {}).name || a,
        bName: (idx.byId.get(b) || {}).name || b,
        ...extra,
      });
    }
  };
  const get = (a, b) => {
    const k = pairKey(a, b);
    let o = pairs.get(k);
    if (!o) {
      const A = a < b ? a : b;
      const B = a < b ? b : a;
      o = {
        a: A, b: B,
        familyKey: idx.familyKeyOf.get(A) || idx.familyKeyOf.get(B) || null,
        evidence: new Set(),
        nameSim: 0,
        jaccard: 0,
        sharedHigh: [],
      };
      pairs.set(k, o);
    }
    return o;
  };
  const sameFamily = (a, b) => idx.familyRootOf.get(a) === idx.familyRootOf.get(b);
  const ids = idx.topics.map((t) => t.id);

  // 1) 名字相似
  const maxDistRatio = 1 - cfg.nameSimThreshold;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const na = idx.norm.get(a);
      const nb = idx.norm.get(b);
      const maxLen = Math.max(na.length, nb.length) || 1;
      if (Math.abs(na.length - nb.length) > maxDistRatio * maxLen) continue;
      const sim = nameSimilarity(na, nb);
      if (sim.sim < cfg.nameSimThreshold) continue;
      if (!sameFamily(a, b)) { noteCross('name', a, b, { sim: sim.sim }); continue; }
      const o = get(a, b);
      o.nameSim = Math.max(o.nameSim, sim.sim);
      o.evidence.add('name');
    }
  }

  // 2) 高区分度 trigger 重合
  const highInv = new Map();
  for (const t of idx.topics) {
    const seen = new Set();
    for (const raw of activeTriggersOf(t)) {
      const n = normalizeTrigger(raw);
      if (!n || seen.has(n) || !idx.highNorms.has(n)) continue;
      seen.add(n);
      if (!highInv.has(n)) highInv.set(n, []);
      highInv.get(n).push(t.id);
    }
  }
  for (const [n, list] of highInv) {
    const uniq = [...new Set(list)].sort();
    if (uniq.length < 2) continue;
    const cov = idx.cov.get(n);
    const rec = { trigger: cov ? cov.trigger : n, norm: n, coverage: cov ? cov.coverage : uniq.length };
    for (let i = 0; i < uniq.length; i += 1) {
      for (let j = i + 1; j < uniq.length; j += 1) {
        if (!sameFamily(uniq[i], uniq[j])) { noteCross('trig', uniq[i], uniq[j], { trigger: rec.trigger }); continue; }
        const o = get(uniq[i], uniq[j]);
        if (!o.sharedHigh.some((x) => x.norm === n)) o.sharedHigh.push(rec);
        o.evidence.add('trig');
      }
    }
  }

  // 3) 有效句 Jaccard（只对有共享有效句的对；否则 Jaccard=0 不可能达标）
  const pairShared = new Map();
  for (const [, topicSet] of idx.shaIndex) {
    if (topicSet.size < 2) continue;
    const arr = [...topicSet];
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const k = pairKey(arr[i], arr[j]);
        pairShared.set(k, (pairShared.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, shared] of pairShared) {
    const [a, b] = k.split('|');
    const sa = (idx.shas.get(a) || new Set()).size;
    const sb = (idx.shas.get(b) || new Set()).size;
    if (!sa || !sb) continue;
    const union = sa + sb - shared;
    const jac = union > 0 ? shared / union : 0;
    if (jac < cfg.jaccardThreshold) continue;
    if (!sameFamily(a, b)) { noteCross('jac', a, b, { jaccard: Number(jac.toFixed(4)) }); continue; }
    const o = get(a, b);
    o.jaccard = Math.max(o.jaccard, Number(jac.toFixed(4)));
    o.evidence.add('jac');
  }

  return { pairs, crossFamily };
}

// ---------------------------------------------------------------------------
// 6. 聚类（禁链式）
// ---------------------------------------------------------------------------

function components(ids, strongPairs) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  for (const o of strongPairs) {
    const ra = find(o.a);
    const rb = find(o.b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  return [...groups.values()].map((g) => g.slice().sort());
}

/** 簇内度数（只计强边） */
function degreesOf(members, pairs) {
  const set = new Set(members);
  const deg = new Map(members.map((m) => [m, 0]));
  for (const o of pairs.values()) {
    if (!set.has(o.a) || !set.has(o.b)) continue;
    if (o.evidence.size < 2) continue;      // 只有强边计入度数
    deg.set(o.a, deg.get(o.a) + 1);
    deg.set(o.b, deg.get(o.b) + 1);
  }
  return deg;
}

/** 裁剪叶子：簇内度数 <2 的成员剔除；有剔除 ⇒ 该簇被判链式（整体拒绝，不再从里面捞子簇） */
function pruneLeaves(members, pairs) {
  const keep = new Set(members);
  const removed = [];
  for (;;) {
    if (keep.size <= 2) break;
    const cur = [...keep].sort();
    const deg = degreesOf(cur, pairs);
    const drop = cur.filter((id) => (deg.get(id) || 0) < 2);
    if (!drop.length) break;
    for (const id of drop) { removed.push(id); keep.delete(id); }
  }
  return { kept: [...keep].sort(), removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// 7. 强内聚闸
// ---------------------------------------------------------------------------

/**
 * 簇指标（Lead 要一眼看出纯度）：
 *   density            = 强边数 / C(n,2)
 *   avgNameSim         = 所有成员对的真实名字相似度均值（不是只看有边的对）
 *   avgJaccard         = 所有成员对的 Jaccard 均值（无边按 0）
 *   triggerMemberRatio = 至少与一个成员共享高区分度 trigger 的成员数 / n
 */
export function computeClusterMetrics(members, pairs, normOf) {
  const n = members.length;
  const norm = (id) => (typeof normOf === 'function' ? normOf(id) : ((normOf && normOf.get && normOf.get(id)) || ''));
  if (n < 2) {
    return { n, density: 0, avgNameSim: 0, avgJaccard: 0, triggerMemberRatio: 0, strongEdges: 0, totalPairs: 0 };
  }
  let totalPairs = 0;
  let strongEdges = 0;
  let simSum = 0;
  let jacSum = 0;
  const trigMembers = new Set();
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      totalPairs += 1;
      simSum += nameSimilarity(norm(members[i]), norm(members[j])).sim;
      const o = pairs.get(pairKey(members[i], members[j]));
      if (!o) continue;
      if (o.evidence.size >= 2) strongEdges += 1;
      jacSum += o.jaccard;
      if (o.evidence.has('trig')) { trigMembers.add(members[i]); trigMembers.add(members[j]); }
    }
  }
  return {
    n,
    density: Number((strongEdges / totalPairs).toFixed(4)),
    avgNameSim: Number((simSum / totalPairs).toFixed(4)),
    avgJaccard: Number((jacSum / totalPairs).toFixed(4)),
    triggerMemberRatio: Number((trigMembers.size / n).toFixed(4)),
    strongEdges,
    totalPairs,
  };
}

/** 强内聚闸（纯函数，便于单测）。返回 {accepted, rejectReasons[], rejectCodes[]} */
export function evaluateClusterGate(metrics, cfg = DEFAULT_CURATION_CONFIG) {
  const c = { ...DEFAULT_CURATION_CONFIG, ...(cfg || {}) };
  const reasons = [];
  const codes = [];
  if (!(metrics.density >= c.minDensity)) {
    reasons.push(`density ${metrics.density} < ${c.minDensity}`);
    codes.push('low-density');
  }
  if (!(metrics.avgNameSim >= c.minAvgNameSim)) {
    reasons.push(`avgNameSim ${metrics.avgNameSim} < ${c.minAvgNameSim}`);
    codes.push('low-name-similarity');
  }
  const bodyOrTrigger = (metrics.avgJaccard >= c.minAvgJaccard) || (metrics.triggerMemberRatio >= c.minTriggerMemberRatio);
  if (!bodyOrTrigger) {
    reasons.push(`avgJaccard ${metrics.avgJaccard} < ${c.minAvgJaccard} 且 triggerMemberRatio ${metrics.triggerMemberRatio} < ${c.minTriggerMemberRatio}`);
    codes.push('no-body-overlap');
  }
  return { accepted: reasons.length === 0, rejectReasons: reasons, rejectCodes: codes };
}

// ---------------------------------------------------------------------------
// 8. 每簇产出
// ---------------------------------------------------------------------------

function stateRankOf(state) {
  switch (state) {
    case 'active': return 0;
    case 'draft': return 1;
    case 'needs_review': return 2;
    case 'dormant': return 3;
    case 'archived': return 4;
    default: return 5;
  }
}

const TEMPLATE_TAIL_RES = [
  /[（(]\s*原文(?:一字未删|逐字未改|逐字未删|原样保留|原文照搬)\s*[）)]/g,
  /[,，]\s*原文(?:一字未删|逐字未改|逐字未删|原样保留|原文照搬)\s*/g,
];

/** 建议标题：主主题名 → 去 .md / MEMORY- 文件前缀 → 去"原文一字未删"类模板后缀 → 截断 */
export function suggestTitle(primaryName, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  let title = String(primaryName == null ? '' : primaryName).trim();
  const original = title;
  title = title.replace(/\.md$/i, '').trim();
  const stripped = title.replace(/^MEMORY[\s\-_·・]+/i, '').trim();
  if (stripped.length >= 4) title = stripped;
  for (const re of TEMPLATE_TAIL_RES) title = title.replace(re, '');
  title = title.replace(/[\s·・—\-]+$/g, '').trim();
  if (!title) title = original;
  let truncated = false;
  if (title.length > c.titleMaxChars) {
    title = title.slice(0, Math.max(1, c.titleMaxChars - 1)) + '…';
    truncated = true;
  }
  return { title, truncated, cleaned: title !== original };
}

/** 泛化标题判定（"2026-09-30"/"结论（一句话）"/"子代理对话" 这类不能当主主题名） */
export function looksGenericTitle(name) {
  const n = normalizeName(name);
  if (!n) return true;
  if (/^[\d\s\-./:]+$/.test(n)) return true;
  if (n.length <= 6) return true;
  if (n.length <= 12 && /^(结论|小结|总结|备注|其他|其它|主题|目录|索引|概览|总览|附录|未命名|无标题|项目|记录|日志|说明|清单|正文|细节|补充|子代理)/.test(n)) return true;
  return false;
}

// ---- 句子打分（keep 建议）----
const DECISION_WORDS = [
  ['拍板', 5], ['铁律', 5], ['硬约束', 5],
  ['根因', 4], ['结论', 4], ['决策', 4], ['定案', 4], ['口径', 4], ['一律', 4], ['务必', 4],
  ['必须', 4], ['禁止', 4], ['不许', 4], ['不要用', 4],
  ['决定', 3], ['规则', 3], ['约定', 3], ['只能', 3], ['统一', 3], ['默认', 3], ['优先', 3],
  ['改用', 3], ['改成', 3], ['契约', 3], ['验收', 3], ['判定', 3], ['坑', 3], ['教训', 3],
  ['缺陷', 3], ['bug', 3], ['原则', 3], ['结论是', 4], ['定性', 3],
  ['方案', 2], ['边界', 2], ['注意', 2], ['原因', 2], ['为什么', 2], ['因此', 2], ['建议', 2],
  ['目标', 2], ['要求', 2], ['确认', 2], ['实测', 2], ['验证', 2], ['失败', 2], ['修复', 2],
  ['风险', 2], ['限制', 2], ['正确', 2], ['错误', 2], ['做法', 2], ['本质', 2], ['已知', 2],
];

const HARD_PATTERNS = [
  [/\d/, 1.5, '数字'],
  [/[A-Za-z]:\\|\/[\w.-]+\//, 2, '路径'],
  [/\.(mjs|js|cjs|json|jsonl|md|db|ps1|py|txt|sh|yml|yaml)\b/i, 2, '扩展名'],
  [/--?[a-zA-Z][\w-]{2,}/, 1.5, '命令参数'],
  [/[Tt]-\d{4}/, 3, '主题ID'],
  [/\b[0-9a-f]{8,}\b/i, 2, 'sha/长ID'],
  [/\d+\.\d+(\.\d+)?/, 1.5, '版本号'],
  [/(MB|KB|GB|ms|字符|行|台|个|秒|天|条|次)/, 1, '计量'],
  [/[""「」『』]/, 1, '引号'],
  [/\|\s*\S+\s*\|/, 1, '表格'],
];

export function scoreSentence(text) {
  const s = String(text == null ? '' : text);
  let score = 1;
  const why = [];
  for (const [w, wt] of DECISION_WORDS) {
    if (s.includes(w)) { score += wt; if (why.length < 5) why.push(w); }
  }
  for (const [re, wt, label] of HARD_PATTERNS) {
    if (re.test(s)) { score += wt; if (why.length < 5) why.push(label); }
  }
  const len = s.length;
  if (len >= 20 && len <= 400) score += 1;
  else if (len > 800) score -= 1;
  if (/^\s*\|/.test(s)) score += 0.5;
  if (/^\s*#/.test(s)) score += 0.5;
  return { score: Number(score.toFixed(2)), why };
}

/**
 * 每簇给主主题的"该保留哪些句"。
 * 返回 keep（按 ord 升序）、archiveCount（主主题未保留句数）、clusterArchiveCount（全簇未保留句数）。
 */
export function keepSuggestions(store, cluster, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  const members = Array.isArray(cluster) ? cluster.slice() : (cluster && Array.isArray(cluster.members) ? cluster.members.slice() : []);
  if (!members.length) {
    return { primaryTopicId: null, primaryName: null, totalSentences: 0, totalChars: 0, keep: [], keepCount: 0, keepChars: 0, archiveCount: 0, keepRatio: 0, otherMembersSentences: 0, clusterArchiveCount: 0 };
  }
  const hint = !Array.isArray(cluster) && cluster ? cluster : {};
  const sentenceCounts = hint.sentenceCounts || null;
  const countOf = (id) => {
    if (!sentenceCounts) return null;
    const v = sentenceCounts instanceof Map ? sentenceCounts.get(id) : sentenceCounts[id];
    return v == null ? null : Number(v);
  };
  let primaryId = hint.primaryTopicId || null;
  let primaryName = hint.primaryName || null;
  if (!primaryId || !members.includes(primaryId)) {
    const tops = store.topics().filter((t) => members.includes(t.id));
    tops.sort((x, y) => (stateRankOf(x.state) - stateRankOf(y.state))
      || (Number(y.sentences || 0) - Number(x.sentences || 0))
      || (x.id < y.id ? -1 : 1));
    primaryId = tops.length ? tops[0].id : members[0];
    primaryName = tops.length ? tops[0].name : primaryName;
  }
  if (!primaryName) {
    const hit = store.topics().find((t) => t.id === primaryId);
    primaryName = hit ? hit.name : null;
  }
  const rows = sentencesOf(store, primaryId);
  const totalSentences = rows.length;
  const totalChars = rows.reduce((a, r) => a + (Number.isFinite(Number(r.chars)) ? Number(r.chars) : String(r.text || '').length), 0);

  const scored = rows.map((r, i) => {
    const s = scoreSentence(r.text);
    return {
      sentenceId: r.id == null ? null : r.id,
      ord: Number.isFinite(Number(r.ord)) ? Number(r.ord) : i + 1,
      chars: Number.isFinite(Number(r.chars)) ? Number(r.chars) : String(r.text || '').length,
      score: s.score,
      why: s.why,
      preview: String(r.text || '').replace(/\s+/g, ' ').slice(0, 80),
      _norm: normalizeName(r.text),
    };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.chars - a.chars) || (a.ord - b.ord));
  const seenNorm = new Set();
  const picked = [];
  let keepChars = 0;
  for (const r of scored) {
    if (picked.length >= c.keepMaxSentences) break;
    if (keepChars + r.chars > c.keepMaxChars) continue;
    if (r._norm && seenNorm.has(r._norm)) continue;
    if (r._norm) seenNorm.add(r._norm);
    picked.push(r);
    keepChars += r.chars;
  }
  picked.sort((a, b) => a.ord - b.ord);
  const keep = picked.map(({ _norm, ...rest }) => rest);

  let otherMembersSentences = 0;
  let countsIncomplete = false;
  for (const id of members) {
    if (id === primaryId) continue;
    const n = countOf(id);
    if (n == null) { countsIncomplete = true; break; }
    otherMembersSentences += n;
  }
  if (countsIncomplete) {
    otherMembersSentences = members.filter((id) => id !== primaryId).reduce((a, id) => a + sentencesOf(store, id).length, 0);
  }
  const clusterSentences = totalSentences + otherMembersSentences;
  return {
    primaryTopicId: primaryId,
    primaryName,
    totalSentences,
    totalChars,
    keep,
    keepCount: keep.length,
    keepChars,
    archiveCount: Math.max(0, totalSentences - keep.length),
    keepRatio: totalSentences ? Number((keep.length / totalSentences).toFixed(4)) : 0,
    otherMembersSentences,
    clusterArchiveCount: Math.max(0, clusterSentences - keep.length),
  };
}

/** 主主题：非泛化名优先 → 加权度最高 → 名字有信息量 → 状态正式 → 句数多 → id */
function choosePrimary(members, pairs, idx) {
  const degree = new Map(members.map((id) => [id, 0]));
  for (const o of pairs.values()) {
    if (!degree.has(o.a) || !degree.has(o.b)) continue;
    if (o.evidence.size < 2) continue;
    degree.set(o.a, degree.get(o.a) + 1);
    degree.set(o.b, degree.get(o.b) + 1);
  }
  const nameQuality = (id) => {
    const nm = (idx.byId.get(id) || {}).name || '';
    const cjk = (nm.match(/[\u4e00-\u9fa5]/g) || []).length;
    return (looksGenericTitle(nm) ? -3 : 0) + Math.min(nm.length, 40) * 0.03 + Math.min(cjk, 12) * 0.08;
  };
  const genericRank = (id) => (looksGenericTitle((idx.byId.get(id) || {}).name || '') ? 1 : 0);
  const sorted = members.slice().sort((x, y) => (
    (genericRank(x) - genericRank(y))
    || (degree.get(y) - degree.get(x))
    || (nameQuality(y) - nameQuality(x))
    || (stateRankOf((idx.byId.get(x) || {}).state) - stateRankOf((idx.byId.get(y) || {}).state))
    || (Number((idx.byId.get(y) || {}).sentences || 0) - Number((idx.byId.get(x) || {}).sentences || 0))
    || (x < y ? -1 : 1)
  ));
  return sorted[0];
}

function memberDetailsOf(members, idx) {
  return members.map((id) => {
    const t = idx.byId.get(id) || {};
    const st = idx.stat.get(id) || { sentences: 0, chars: 0, effectiveSentences: 0 };
    return {
      id,
      name: t.name || id,
      state: t.state || null,
      sentences: st.sentences,
      chars: st.chars,
      effectiveSentences: st.effectiveSentences,
      triggers: activeTriggersOf(t),
      familyKey: idx.familyKeyOf.get(id) || null,
    };
  });
}

function nameQualityOf(name) {
  const nm = String(name || '');
  const cjk = (nm.match(/[\u4e00-\u9fa5]/g) || []).length;
  return (looksGenericTitle(nm) ? -3 : 0) + Math.min(nm.length, 40) * 0.03 + Math.min(cjk, 12) * 0.08;
}

function suggestTitleForCluster(primaryName, memberDetails, sharedHigh, cfg) {
  // 标题取"名字最有信息量的成员"（可读性优先），不必是 hub
  const best = memberDetails.slice().sort((x, y) => (
    (nameQualityOf(y.name) - nameQualityOf(x.name))
    || (stateRankOf(x.state) - stateRankOf(y.state))
    || (x.id < y.id ? -1 : 1)
  ))[0];
  let titleInfo = suggestTitle(best ? best.name : primaryName, cfg);
  let titleFromTriggers = false;
  if (looksGenericTitle(titleInfo.title) && sharedHigh.length) {
    const altRaw = sharedHigh.slice(0, 2).map((x) => x.trigger).join(' · ');
    if (altRaw && !looksGenericTitle(altRaw)) {
      const truncatedAlt = altRaw.length > cfg.titleMaxChars;
      titleInfo = {
        title: truncatedAlt ? altRaw.slice(0, Math.max(1, cfg.titleMaxChars - 1)) + '…' : altRaw,
        truncated: truncatedAlt,
        cleaned: true,
      };
      titleFromTriggers = true;
    }
  }
  return { ...titleInfo, titleFromTriggers, titleSourceTopicId: best ? best.id : null };
}

function confidenceOf(metrics) {
  // 置信度直接由纯度指标加权（不再用"图密度 + 名字 + jaccard + trigger"的旧公式）
  const score = 0.4 * Math.min(1, metrics.avgNameSim / 0.7)
    + 0.3 * Math.min(1, metrics.density / 0.8)
    + 0.2 * Math.min(1, metrics.avgJaccard / 0.2)
    + 0.1 * Math.min(1, metrics.triggerMemberRatio);
  const s = Number(Math.max(0, Math.min(1, score)).toFixed(4));
  return { confidenceScore: s, confidence: s >= 0.6 ? 'high' : (s >= 0.4 ? 'medium' : 'low') };
}

function evidenceSummaryOf(members, pairs) {
  const set = new Set(members);
  let strongEdges = 0;
  let monoEdges = 0;
  const types = new Set();
  const combo = new Map();
  for (const o of pairs.values()) {
    if (!set.has(o.a) || !set.has(o.b)) continue;
    if (o.evidence.size >= 2) {
      strongEdges += 1;
      const k = [...o.evidence].sort().join('+');
      combo.set(k, (combo.get(k) || 0) + 1);
    } else if (o.evidence.size === 1) {
      monoEdges += 1;
    }
    for (const e of o.evidence) types.add(e);
  }
  return { strongEdges, monoEdges, types: [...types], combos: Object.fromEntries([...combo.entries()].sort()) };
}

function sharedHighTriggersOf(memberDetails, idx) {
  const trigCount = new Map();
  for (const m of memberDetails) {
    const seen = new Set();
    for (const raw of m.triggers) {
      const n = normalizeTrigger(raw);
      if (!n || seen.has(n) || !idx.highNorms.has(n)) continue;
      seen.add(n);
      if (!trigCount.has(n)) {
        const cov = idx.cov.get(n);
        trigCount.set(n, { trigger: cov ? cov.trigger : raw, norm: n, coverage: cov ? cov.coverage : 0, members: 0 });
      }
      trigCount.get(n).members += 1;
    }
  }
  return [...trigCount.values()]
    .filter((x) => x.members >= 2)
    .sort((a, b) => (b.members - a.members) || (a.coverage - b.coverage) || (a.norm < b.norm ? -1 : 1))
    .slice(0, 8);
}

function buildCluster({ members, pairs, idx, cfg, evidenceSummary, metrics, familyKey }) {
  const memberDetails = memberDetailsOf(members, idx);
  const primaryId = choosePrimary(members, pairs, idx);
  const primary = memberDetails.find((m) => m.id === primaryId) || memberDetails[0];
  const sharedHigh = sharedHighTriggersOf(memberDetails, idx);
  const reasons = [...new Set(evidenceSummary.types)].sort().map((t) => EVIDENCE_LABELS[t] || t);
  const titleInfo = suggestTitleForCluster(primary.name, memberDetails, sharedHigh, cfg);

  const riskFlags = [];
  if (metrics.n === 2) riskFlags.push('two-member');
  if (evidenceSummary.monoEdges > 0) riskFlags.push('single-evidence-cluster');
  const states = [...new Set(memberDetails.map((m) => m.state).filter(Boolean))];
  if (states.length >= 2) riskFlags.push('cross-state-mix');
  if (looksGenericTitle(primary.name) || looksGenericTitle(titleInfo.title)) riskFlags.push('title-too-generic');
  if (titleInfo.truncated) riskFlags.push('title-truncated');
  if (memberDetails.some((m) => m.chars > cfg.hugeTopicChars)) riskFlags.push('has-huge-member');

  const sentenceCounts = new Map(memberDetails.map((m) => [m.id, m.sentences]));
  const keepInfo = keepSuggestions(idx.store, {
    members, primaryTopicId: primaryId, primaryName: primary.name, sentenceCounts,
  }, cfg);
  const clusterSentences = memberDetails.reduce((a, m) => a + m.sentences, 0);
  const clusterChars = memberDetails.reduce((a, m) => a + m.chars, 0);
  const clusterId = 'C-' + createHash('sha256').update(members.slice().sort().join('|'), 'utf8').digest('hex').slice(0, 10);
  const { confidence, confidenceScore } = confidenceOf(metrics);

  return {
    clusterId,
    accepted: true,
    familyKey,
    members: members.slice().sort(),
    memberCount: members.length,
    memberDetails,
    primaryTopicId: primaryId,
    primaryName: primary.name,
    primaryState: primary.state,
    suggestedTitle: titleInfo.title,
    titleTruncated: titleInfo.truncated,
    titleFromTriggers: titleInfo.titleFromTriggers,
    titleSourceTopicId: titleInfo.titleSourceTopicId,
    density: metrics.density,
    avgNameSim: metrics.avgNameSim,
    avgJaccard: metrics.avgJaccard,
    triggerMemberRatio: metrics.triggerMemberRatio,
    strongEdges: metrics.strongEdges,
    totalPairs: metrics.totalPairs,
    evidence: evidenceSummary,
    reasons,
    sharedRareTriggers: sharedHigh,     // 兼容旧字段名：本版只含高区分度 trigger
    sharedHighTriggers: sharedHigh,
    confidence,
    confidenceScore,
    riskFlags,
    gate: { accepted: true, rejectReasons: [] },
    clusterSentences,
    clusterChars,
    keep: {
      primaryTopicId: keepInfo.primaryTopicId,
      keepCount: keepInfo.keepCount,
      keepChars: keepInfo.keepChars,
      archiveCount: keepInfo.archiveCount,
      keepRatio: keepInfo.keepRatio,
      clusterArchiveCount: keepInfo.clusterArchiveCount,
      otherMembersSentences: keepInfo.otherMembersSentences,
      previews: keepInfo.keep.slice(0, 12),
    },
  };
}

function buildRejected({ members, pairs, idx, cfg, evidenceSummary, metrics, familyKey, rejectReasons, rejectCodes }) {
  const memberDetails = memberDetailsOf(members, idx);
  const clusterId = 'R-' + createHash('sha256').update(members.slice().sort().join('|'), 'utf8').digest('hex').slice(0, 10);
  const primaryId = choosePrimary(members, pairs, idx);
  const primary = memberDetails.find((m) => m.id === primaryId) || memberDetails[0];
  const title = suggestTitle(primary.name, cfg);
  return {
    clusterId,
    accepted: false,
    familyKey,
    members: members.slice().sort(),
    memberCount: members.length,
    memberDetails,
    primaryTopicId: primaryId,
    primaryName: primary.name,
    suggestedTitle: title.title,
    density: metrics.density,
    avgNameSim: metrics.avgNameSim,
    avgJaccard: metrics.avgJaccard,
    triggerMemberRatio: metrics.triggerMemberRatio,
    strongEdges: metrics.strongEdges,
    totalPairs: metrics.totalPairs,
    evidence: evidenceSummary,
    rejectReason: rejectReasons || [],
    rejectCodes: rejectCodes || [],
    gate: { accepted: false, rejectReasons: rejectReasons || [], rejectCodes: rejectCodes || [] },
  };
}

// ---------------------------------------------------------------------------
// 9. 主入口
// ---------------------------------------------------------------------------

/**
 * 产出归类提案（只读）。
 *
 * 流程：
 *   1) 取主题 + 有效句 + trigger 覆盖率 → 项目族（跨族硬禁止）
 *   2) 同族内建三类证据 → pairs
 *   3) 强边（≥2 证据）连通分量 → 裁剪叶子（度数 <2 剔除；有剔除 ⇒ 整簇判链式拒绝）
 *   4) 强内聚闸 → accepted（进 clusters）或 rejected（进 rejectedClusters）
 *   5) 未入簇主题用单证据边组 ≤3 人小簇（同样过闸；过不了也进 rejectedClusters）
 *   6) 剩余 = singletons
 */
export function proposeClusters(store, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  const idx = buildIndex(store, c);
  const ids = idx.topics.map((t) => t.id);
  const evidence = buildEvidence(idx, c);
  const pairs = evidence.pairs;

  const strongPairs = [...pairs.values()].filter((o) => o.evidence.size >= 2);
  const monoPairs = [...pairs.values()].filter((o) => o.evidence.size === 1);
  const normOf = (id) => idx.norm.get(id) || '';

  const clusters = [];
  const rejectedClusters = [];
  const used = new Set();
  const familyOfTopics = (idsArr) => {
    const counts = new Map();
    for (const id of idsArr) {
      const k = idx.familyKeyOf.get(id) || '';
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };

  // ---- 1) 强边分量 ----
  for (const comp of components(ids, strongPairs)) {
    if (comp.length < c.minClusterTopics) continue;
    const pruned = pruneLeaves(comp, pairs);
    const familyKey = familyOfTopics(comp);
    if (pruned.kept.length !== comp.length) {
      // 有叶子被剔除 ⇒ 链式效应（上一版翻车根因），整簇拒绝，不再从里面捞子簇
      const metrics = computeClusterMetrics(comp, pairs, normOf);
      rejectedClusters.push(buildRejected({
        members: comp, pairs, idx, cfg: c, evidenceSummary: evidenceSummaryOf(comp, pairs), metrics, familyKey,
        rejectReasons: [`链式效应：${pruned.removed.length} 个成员簇内度数 <2（${pruned.removed.join(',')}）`],
        rejectCodes: ['chain-linked'],
      }));
      for (const id of comp) used.add(id);
      continue;
    }
    if (comp.length > c.maxClusterSize) {
      const metrics = computeClusterMetrics(comp, pairs, normOf);
      rejectedClusters.push(buildRejected({
        members: comp, pairs, idx, cfg: c, evidenceSummary: evidenceSummaryOf(comp, pairs), metrics, familyKey,
        rejectReasons: [`簇成员 ${comp.length} 超过上限 ${c.maxClusterSize}，需要人工先拆族`],
        rejectCodes: ['oversized'],
      }));
      for (const id of comp) used.add(id);
      continue;
    }
    const metrics = computeClusterMetrics(comp, pairs, normOf);
    const gate = evaluateClusterGate(metrics, c);
    if (!gate.accepted) {
      rejectedClusters.push(buildRejected({
        members: comp, pairs, idx, cfg: c, evidenceSummary: evidenceSummaryOf(comp, pairs), metrics, familyKey,
        rejectReasons: gate.rejectReasons, rejectCodes: gate.rejectCodes,
      }));
    } else {
      clusters.push(buildCluster({
        members: comp, pairs, idx, cfg: c, evidenceSummary: evidenceSummaryOf(comp, pairs), metrics, familyKey,
      }));
    }
    for (const id of comp) used.add(id);
  }

  // ---- 2) 单证据小簇（只对完全没进任何簇的主题；≤3 人；仍需过闸）----
  const monoAdj = new Map();
  for (const o of monoPairs) {
    if (used.has(o.a) || used.has(o.b)) continue;
    if (!monoAdj.has(o.a)) monoAdj.set(o.a, []);
    if (!monoAdj.has(o.b)) monoAdj.set(o.b, []);
    monoAdj.get(o.a).push(o.b);
    monoAdj.get(o.b).push(o.a);
  }
  const monoVisited = new Set();
  const monoGroups = [];
  for (const id of ids.sort()) {
    if (used.has(id) || monoVisited.has(id) || !monoAdj.has(id)) continue;
    const group = [id];
    monoVisited.add(id);
    for (const nb of (monoAdj.get(id) || []).slice().sort()) {
      if (group.length >= c.singleEvidenceMaxSize) break;
      if (monoVisited.has(nb)) continue;
      const ok = group.some((x) => (monoAdj.get(nb) || []).includes(x));
      if (!ok) continue;
      group.push(nb);
      monoVisited.add(nb);
    }
    monoGroups.push(group.sort());
  }
  for (const group of monoGroups) {
    if (group.length < 2) continue;
    const metrics = computeClusterMetrics(group, pairs, normOf);
    const gate = evaluateClusterGate(metrics, c);
    const ev = evidenceSummaryOf(group, pairs);
    const familyKey = familyOfTopics(group);
    if (gate.accepted) {
      clusters.push(buildCluster({ members: group, pairs, idx, cfg: c, evidenceSummary: ev, metrics, familyKey }));
    } else {
      rejectedClusters.push(buildRejected({
        members: group, pairs, idx, cfg: c, evidenceSummary: ev, metrics, familyKey,
        rejectReasons: [...gate.rejectReasons, '单证据边只能进 ≤3 人簇，且该簇未过强内聚闸'],
        rejectCodes: [...gate.rejectCodes, 'single-evidence'],
      }));
    }
    for (const id of group) used.add(id);
  }

  clusters.sort((a, b) => (b.memberCount - a.memberCount) || (a.clusterId < b.clusterId ? -1 : 1));
  rejectedClusters.sort((a, b) => (b.memberCount - a.memberCount) || (a.clusterId < b.clusterId ? -1 : 1));

  const singletons = ids.filter((id) => !used.has(id)).sort();

  // 族清单
  const acceptedByTopic = new Map();
  for (const cl of clusters) for (const id of cl.members) acceptedByTopic.set(id, cl.clusterId);
  const rejectedByTopic = new Map();
  for (const rj of rejectedClusters) for (const id of rj.members) rejectedByTopic.set(id, rj.clusterId);
  const families = [];
  for (const [root, members] of idx.familyMembers) {
    const key = idx.familyKeyOf.get(members[0]) || root;
    families.push({
      familyKey: key,
      topicCount: members.length,
      members: members.slice().sort(),
      acceptedClusterIds: [...new Set(members.map((id) => acceptedByTopic.get(id)).filter(Boolean))],
      rejectedClusterIds: [...new Set(members.map((id) => rejectedByTopic.get(id)).filter(Boolean))],
      singletons: members.filter((id) => !acceptedByTopic.has(id) && !rejectedByTopic.has(id)).sort(),
    });
  }
  families.sort((a, b) => (b.topicCount - a.topicCount) || (a.familyKey < b.familyKey ? -1 : 1));

  const evidenceCounts = { name: 0, jac: 0, trig: 0 };
  const combos = {};
  for (const o of pairs.values()) {
    for (const e of o.evidence) evidenceCounts[e] = (evidenceCounts[e] || 0) + 1;
    if (o.evidence.size >= 2) {
      const k = [...o.evidence].sort().join('+');
      combos[k] = (combos[k] || 0) + 1;
    }
  }

  return {
    clusters,
    rejectedClusters,
    families,
    stats: {
      topics: ids.length,
      allTopics: idx.totals.allTopics,
      sentences: idx.totals.sentences,
      chars: idx.totals.chars,
      byState: idx.byState,
      familyCount: families.length,
      multiTopicFamilyCount: families.filter((f) => f.topicCount > 1).length,
      singleTopicFamilyCount: families.filter((f) => f.topicCount === 1).length,
      highTriggerCount: idx.highTriggers.length,
      genericTriggerCount: idx.genericTriggers.length,
      genericTriggers: idx.genericTriggers,
      highTriggers: idx.highTriggers.slice(0, 20),
      candidatePairs: pairs.size,
      strongPairCount: strongPairs.length,
      monoPairCount: monoPairs.length,
      crossFamily: evidence.crossFamily,
      evidenceCounts,
      strongCombos: combos,
      acceptedCount: clusters.length,
      acceptedTopics: clusters.reduce((a, cl) => a + cl.memberCount, 0),
      rejectedCount: rejectedClusters.length,
      rejectedTopics: rejectedClusters.reduce((a, rj) => a + rj.memberCount, 0),
      singletonCount: singletons.length,
      skippedContainers: idx.skippedContainers,
      containerIds: idx.containerIds,
    },
    scan: { topics: idx.topics, singletons, byState: idx.byState, totals: idx.totals, skippedContainers: idx.skippedContainers, containerIds: idx.containerIds },
    config: c,
  };
}

// ---------------------------------------------------------------------------
// 10. 规模体检
// ---------------------------------------------------------------------------

/**
 * 规模体检（真实值，不许凑）。
 *
 * 三个主主题口径都报：
 *   · strict            = accepted 簇合并后 + 其余每个主题各算 1 个主主题（只采纳过闸簇）
 *   · familyPlan        = 每个项目族 1 个主主题（active）+ 族内其余主题作为 dormant 明细子主题
 *                         （需要人工逐族确认；族边界是项目级，跨族不混）
 *   · ifRejectedMerged  = 若被拒簇全部经人工确认可合并（上限估计，仅供参考）
 */
export function reportScale(store, cfg = {}, proposal = null) {
  const c = mergeCurationConfig(cfg);
  const p = proposal || proposeClusters(store, c);
  const total = p.stats.topics;
  const acceptedClusters = p.clusters;
  const rejectedClusters = p.rejectedClusters;
  const singletons = p.scan.singletons;
  const acceptedTopics = p.stats.acceptedTopics;
  const rejectedTopics = p.stats.rejectedTopics;

  const topicById = new Map(p.scan.topics.map((t) => [t.id, t]));
  const sentenceCounts = new Map(p.scan.topics.map((t) => [t.id, Number(t.sentences || 0)]));

  const strictMainTopics = acceptedClusters.length + (total - acceptedTopics);
  const familyPlanMainTopics = p.families.length;
  const ifRejectedMerged = acceptedClusters.length + rejectedClusters.length + (total - acceptedTopics - rejectedTopics);

  let keepSum = 0;
  for (const cl of acceptedClusters) keepSum += cl.keep.keepCount;
  const nonAccepted = [];
  for (const id of singletons) nonAccepted.push(id);
  for (const rj of rejectedClusters) for (const id of rj.members) nonAccepted.push(id);
  for (const id of nonAccepted) {
    const t = topicById.get(id);
    const k = keepSuggestions(store, {
      members: [id], primaryTopicId: id, primaryName: t ? t.name : null, sentenceCounts,
    }, c);
    keepSum += k.keepCount;
  }
  const avgSentencesPerMain = strictMainTopics ? Number((keepSum / strictMainTopics).toFixed(2)) : 0;

  const targets = c.targets;
  const okStrict = strictMainTopics <= targets.maxActiveMainTopics;
  const okFamilyPlan = familyPlanMainTopics <= targets.maxActiveMainTopics;
  const okAvg = avgSentencesPerMain <= targets.maxAvgSentencesPerMain;

  const acceptedSizes = acceptedClusters.map((cl) => cl.memberCount).sort((a, b) => a - b);
  const sizeDistribution = {};
  for (const cl of acceptedClusters) sizeDistribution[cl.memberCount] = (sizeDistribution[cl.memberCount] || 0) + 1;
  const rejectReasonCounts = {};
  for (const rj of rejectedClusters) {
    for (const code of rj.rejectCodes || []) rejectReasonCounts[code] = (rejectReasonCounts[code] || 0) + 1;
  }

  return {
    total: {
      topics: total,
      allTopics: p.stats.allTopics,
      sentences: p.stats.sentences,
      chars: p.stats.chars,
      byState: p.stats.byState,
    },
    families: {
      count: p.stats.familyCount,
      multiTopic: p.stats.multiTopicFamilyCount,
      singleTopic: p.stats.singleTopicFamilyCount,
      top: p.families.slice(0, 15).map((f) => ({ familyKey: f.familyKey, topicCount: f.topicCount })),
    },
    evidence: {
      candidatePairs: p.stats.candidatePairs,
      strongPairs: p.stats.strongPairCount,
      monoPairs: p.stats.monoPairCount,
      crossFamily: p.stats.crossFamily,
      byType: p.stats.evidenceCounts,
      strongCombos: p.stats.strongCombos,
      highTriggerCount: p.stats.highTriggerCount,
      genericTriggerCount: p.stats.genericTriggerCount,
      genericTriggers: p.stats.genericTriggers.slice(0, 15),
      highTriggers: p.stats.highTriggers,
    },
    clustering: {
      acceptedCount: acceptedClusters.length,
      acceptedTopics,
      coverageRatio: total ? Number((acceptedTopics / total).toFixed(4)) : 0,
      rejectedCount: rejectedClusters.length,
      rejectedTopics,
      rejectReasonCounts,
      singletonCount: singletons.length,
      sizeDistribution,
      maxSize: acceptedSizes.length ? acceptedSizes[acceptedSizes.length - 1] : 0,
      meanSize: acceptedSizes.length ? Number((acceptedSizes.reduce((a, b) => a + b, 0) / acceptedSizes.length).toFixed(2)) : 0,
      accepted: acceptedClusters,
      rejected: rejectedClusters,
    },
    projected: {
      topicsNow: total,
      // ② 严格口径（只采纳过闸簇）：真实值，不许凑
      strictMainTopics,
      strictDetailTopics: total - strictMainTopics,
      // ②' 族级分层方案（需人工逐族确认）
      familyPlanMainTopics,
      familyPlanDetailTopics: total - familyPlanMainTopics,
      // ②'' 若被拒簇全部人工确认可合并（上限估计）
      ifRejectedMergedMainTopics: ifRejectedMerged,
      needsHumanReview: {
        rejectedClusters: rejectedClusters.length,
        rejectedTopics,
        singleTopicFamilies: p.stats.singleTopicFamilyCount,
        singletons,
      },
      avgSentencesPerMain,
      keepSentenceSum: keepSum,
    },
    targets: {
      maxActiveMainTopics: targets.maxActiveMainTopics,
      maxAvgSentencesPerMain: targets.maxAvgSentencesPerMain,
    },
    ok: {
      strict: okStrict,
      familyPlan: okFamilyPlan,
      avgSentences: okAvg,
      // 纯度优先：达标不是目标，纯度是硬门槛；这里只如实报告两个口径是否 ≤60
      all: okStrict && okAvg,
    },
    acceptedClusters,
    rejectedClusters,
    familyList: p.families,
  };
}

// ---------------------------------------------------------------------------
// 11. 输出格式
// ---------------------------------------------------------------------------

/** 人工决策用的单行摘要（含纯度指标，Lead 要"一眼看出纯度"） */
export function clusterSummaryLine(cl) {
  const status = cl.accepted === false ? 'REJECT' : cl.confidence;
  const reasons = (cl.reasons || []).slice(0, 2).join('+') || (cl.rejectCodes || []).join('+') || '-';
  const risks = cl.accepted === false
    ? (cl.rejectReason || []).join('；')
    : ((cl.riskFlags || []).length ? cl.riskFlags.join(',') : '-');
  const conf = cl.confidenceScore == null ? '-' : Number(cl.confidenceScore).toFixed(2);
  return `${cl.clusterId} | ${cl.memberCount} | ${cl.suggestedTitle} | ${status}(${conf}) | d=${Number(cl.density).toFixed(2)} sim=${Number(cl.avgNameSim).toFixed(2)} jac=${Number(cl.avgJaccard).toFixed(3)} trig=${Number(cl.triggerMemberRatio).toFixed(2)} | ${reasons} | ${risks}`;
}

const CSV_COLUMNS = [
  'status', 'clusterId', 'memberCount', 'familyKey', 'suggestedTitle', 'primaryTopicId', 'primaryState',
  'density', 'avgNameSim', 'avgJaccard', 'triggerMemberRatio', 'strongEdges', 'totalPairs',
  'confidence', 'confidenceScore', 'reasons', 'riskFlags', 'rejectCodes', 'rejectReason',
  'keepCount', 'keepChars', 'archiveCount', 'clusteredSentences', 'clusteredChars', 'memberIds',
];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 簇清单 → CSV（accepted 与 rejected 同表，按 status/指标可排序） */
export function clustersToCsv(clusters, opts = {}) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const cl of clusters || []) {
    rows.push([
      cl.accepted === false ? 'rejected' : 'accepted',
      cl.clusterId,
      cl.memberCount,
      cl.familyKey || '',
      cl.suggestedTitle,
      cl.primaryTopicId,
      cl.primaryState || '',
      cl.density,
      cl.avgNameSim,
      cl.avgJaccard,
      cl.triggerMemberRatio,
      cl.strongEdges,
      cl.totalPairs,
      cl.confidence || '',
      cl.confidenceScore == null ? '' : cl.confidenceScore,
      (cl.reasons || []).join('+'),
      (cl.riskFlags || []).join('+'),
      (cl.rejectCodes || []).join('+'),
      (cl.rejectReason || []).join('；'),
      cl.keep ? cl.keep.keepCount : '',
      cl.keep ? cl.keep.keepChars : '',
      cl.keep ? cl.keep.archiveCount : '',
      cl.clusterSentences == null ? '' : cl.clusterSentences,
      cl.clusterChars == null ? '' : cl.clusterChars,
      (cl.members || []).join(' '),
    ].map(csvCell).join(','));
  }
  const body = rows.join('\n') + '\n';
  return opts.bom ? '\ufeff' + body : body;
}

// ---------------------------------------------------------------------------
// 12. 三级结构提案（域 → 项目线 → 明细）—— task-19
//
// 用户 2026-10-29 拍板：不再追求"平面 ≤60 个主主题"，改成三级结构。
//   L1 域（6 个，≤15）：由 DOMAIN_RULES 的映射规则决定（族名/主题名归一化后包含匹配，未命中 → D6）
//   L2 项目线 = 多成员族（≈28）+ 日摘要/会话摘要两个 series（各算 1 条项目线）
//   L3 明细 = 单主题族 + 系列内每期 + 被下沉成员（dormant 挂 parent）
//   计数口径：**主主题 = L1 + L2**（≈34，≤60 ✓）；L3 不计入。
//
// 为什么域是"提案侧"而不是"store 侧"：域映射规则是本模块的分析结论（关键词表），
// store 只需要在 apply 时接收 domain/project/detail 三级与 parent 关系。
// ---------------------------------------------------------------------------

/**
 * L1 域映射规则（Lead 定，**可配置、人工可改**）。
 * 匹配口径：族名（familyKey）与族内主题名归一化后做"包含匹配"，按数组顺序取**第一个命中的域**；
 * 全部未命中 → D6。短关键词（长度 ≤3，如 REA/M9/HDR/frp）用"词边界"匹配，防止误命中 create/real 之类子串。
 *
 * 2026-10-29 Lead 复验后补充（D6 缺口实测）：
 *   · D5 增补：sessions / 会话 / 漏网 / 补档 / 检查点 / 知识库 / 迁移 / 汇编 / 自projects迁出
 *   · D3 增补：dsh远程 / 远程访问 / frp / 隧道（"dsh远程访问"是中文，原来匹配不到 dsh-remote）
 */
export const DEFAULT_DOMAIN_RULES = Object.freeze([
  {
    domainId: 'D1',
    name: '招投标与交易系统',
    keywords: ['长沙交易场地', '长沙交易', '长沙数据分析', '长沙数据', '长沙项目', '长沙', '智检', '评标', '招投标', '发改委', '107服务器', '标书', '新点', '省平台', '省本级', '省中心', '签字单', 'OA申请单', 'oa申请单', 'bid-system', 'bidsystem', 'epointmsg', 'EpointMsg'],
    // 结构兜底：OA 系（oaexam/oalogfill/oamailexpense/oassotoken/oaweeklyextract/oa访问…）、湖南公共资源（hnszf/hnsggzy）
    patterns: Object.freeze(['^oa', '^hns']),
  },
  {
    domainId: 'D2',
    name: '手机影像逆向',
    keywords: ['徕卡一瞬', '徕卡', '相机', '水印', 'HDR', '变焦', 'APK逆向', 'apk逆向', 'M9', 'M10R', '成像'],
  },
  {
    domainId: 'D3',
    name: 'DSH 工具链与插件',
    keywords: ['dsh-memory', 'dshmemory', 'dsh-remote', 'dshremote', 'dsh-desktop', 'dshdesktop', 'dsh远程', '远程访问', 'REA', 'browser', '浏览器', 'terminal', 'ralph', 'frp', '隧道', '工具排查', 'dsh工具', '插件', 'adb', '微信', '脚本', '文档'],
    // 结构兜底：裸 dsh 前缀（dsh021rc3/dshagentteams/dshmuseproxy/dsh桌面端）、rea 前缀（reareverseengineeranything）
    patterns: Object.freeze(['^dsh', '^rea', 'adb']),
  },
  {
    domainId: 'D4',
    name: '跨项目经验与纪律',
    keywords: ['global', '跨项目', '纪律', '偏好', '踩坑补编', '工程纪律', '全局', '经验', '结论'],
  },
  {
    domainId: 'D5',
    name: '记忆与归档流水',
    keywords: ['知识库', '迁移', '汇编', '自projects迁出', 'index', '索引', '容量治理', '归档规则', '机制'],
    // 结构兜底：日期开头但**带描述**的主题（"2026-09-10 xxx"；精确 `YYYY-MM-DD` 已由 D8 检查点收走）
    patterns: Object.freeze(['^20\\d{6}']),
  },
  {
    // 2026-10-29 用户裁决：**D7 只保留"漏网归档"**（dream 待整合队列）。
    // 原"会话检查点"线已迁到 D8「日记忆（按天流水）」。
    domainId: 'D7',
    name: '会话流水与整合队列',
    keywords: ['漏网', '补档', 'stale-archive', '归档待整合'],
    lines: Object.freeze([
      { lineId: 'D7-leak', name: '漏网归档待整合', mode: 'dream-queue', consumedByDefault: false, consumed: false },
    ]),
  },
  {
    // 2026-10-29 用户裁决：新增 **D8「日记忆（按天流水）」**，把散落在 D5/D7 的"按日期一条"主题收拢成 4 条线。
    // 优先级：项目域(D1–D4) → D8 → D7 漏网 → D5 → D6（D1–D4 里带日期的项目日志不许挪）。
    // 判定：checkpoint 只认**名字精确** `YYYY-MM-DD`；其余按名字含 日摘要 / 会话摘要 / sessions 分线。
    domainId: 'D8',
    name: '日记忆（按天流水）',
    keywords: [],
    lines: Object.freeze([
      { lineId: 'D8-checkpoint', name: '会话检查点', mode: 'daily-append', exactDate: true, hotDays: 7, warmDays: 30, coldDays: 90 },
      { lineId: 'D8-daily', name: '日摘要明细', mode: 'daily-append', nameIncludes: '日摘要' },
      { lineId: 'D8-session', name: '会话摘要', mode: 'daily-append', nameIncludes: '会话摘要' },
      { lineId: 'D8-archive', name: 'sessions 原始归档', mode: 'daily-append', nameIncludes: 'sessions' },
    ]),
  },
  {
    // 2026-10-30 用户裁决（D6 清零）：新增 **D9「自研应用与内容生产」**，收 6 条自研 App / 内容生成工具。
    // 只用**显式成员规则**（EXPLICIT_PLACEMENT 精确族键），不设宽泛关键词——避免抢 D3 的"系统工具与调试"。
    domainId: 'D9',
    name: '自研应用与内容生产',
    keywords: [],
    lines: Object.freeze([
      { lineId: 'D9-tools', name: '剪贴板与效率工具', mode: null },
      { lineId: 'D9-checkin', name: '打卡助手', mode: null },
      { lineId: 'D9-media', name: '视频与课件生成', mode: null },
      { lineId: 'D9-docs', name: '文档与图像处理', mode: null },
    ]),
  },
  {
    // 2026-10-30 用户裁决（D6 清零）：新增 **D10「基础设施与运维」**，收 4 条 VPS/远程/本机运维。
    domainId: 'D10',
    name: '基础设施与运维',
    keywords: [],
    lines: Object.freeze([
      { lineId: 'D10-server', name: '服务器与网络', mode: null },
      { lineId: 'D10-remote', name: '远程运维与打印', mode: null },
      { lineId: 'D10-local', name: '本机运维', mode: null },
    ]),
  },
]);

export const D6_DOMAIN = Object.freeze({ domainId: 'D6', name: '未归类待判定', keywords: Object.freeze([]) });

/**
 * **显式归属表**（2026-10-30 用户裁决，task-48：D6 清零）。
 * 按**族键精确匹配**（normalizeName 后）或**成员名精确匹配**，把 20 个未归类族钉到目标域/线，
 * 避免下次 re-curate 又掉回 D6；也避免被 D1–D4 的宽泛关键词抢走。
 *   · domainId        归属域
 *   · lineId          （可选）D9/D10 的线容器：该成员聚进这条线
 *   · lineKey         （可选）并入**现有族**（如「长沙交易场地」「长沙项目」「徕卡一瞬」）：把该主题从原族移入目标族
 */
export const EXPLICIT_PLACEMENT = Object.freeze([
  // ---- D9 自研应用与内容生产（4 线 6 成员）----
  { key: '剪贴板工具windowswpf+android', name: '剪贴板工具（Windows WPF + Android）', domainId: 'D9', lineId: 'D9-tools' },
  { key: '打卡助手appandroid自研', name: '打卡助手 App（Android，自研）', domainId: 'D9', lineId: 'D9-checkin' },
  { key: '授课视频生成pptx课件→40分钟讲解视频', name: '授课视频生成（PPTX 课件 → 40 分钟讲解视频）', domainId: 'D9', lineId: 'D9-media' },
  { key: '讲解视频生成管线文章材料→1080p深色讲解片', name: '讲解视频生成管线（文章/材料 → 1080p 深色讲解片）', domainId: 'D9', lineId: 'D9-media' },
  { key: '海报改字jpeg块级无损编辑', name: '海报改字 / JPEG 块级无损编辑', domainId: 'D9', lineId: 'D9-docs' },
  { key: 'word修订痕迹trackedchanges的程序化生成', name: 'Word 修订痕迹（tracked changes）的程序化生成', domainId: 'D9', lineId: 'D9-docs' },
  // ---- D10 基础设施与运维（3 线 4 成员）----
  { key: 'racknerdcloudreve', name: 'MEMORY-racknerd-cloudreve.md', domainId: 'D10', lineId: 'D10-server' },
  { key: '远程运维', name: '远程运维', domainId: 'D10', lineId: 'D10-remote' },
  { key: '远程打印与ca', name: 'MEMORY-远程打印与CA.md', domainId: 'D10', lineId: 'D10-remote' },
  { key: '本机bitcenter看门狗与显示适配器运维本机运维非项目', name: 'MEMORY-本机 BitCenter 看门狗与显示适配器运维（本机运维，非项目）', domainId: 'D10', lineId: 'D10-local' },
  // ---- 吸收进现有域（域下明细 / 并入现有线）----
  { key: '专项调查', name: 'MEMORY-专项调查.md', domainId: 'D1' },
  { key: '星易服原型', name: 'MEMORY-星易服原型.md', domainId: 'D1', lineKey: '长沙交易场地' },
  { key: 'ai问答助手原型cloneaitest', name: 'AI 问答助手原型（_clone_aitest）', domainId: 'D1', lineKey: '长沙项目' },
  { key: '月度报销日志合同对账', name: '月度报销日志合同对账', domainId: 'D1' },
  { key: 'axmlmanifest修补器axmlmanifestpy', name: 'AXML manifest 修补器（axml_manifest.py）', domainId: 'D2', lineKey: '徕卡一瞬' },
  { key: '中转wkapipro悟空ai计费结构vsdeepseek官方实测定案', name: '中转 wkapi.pro（悟空 ai）计费结构 vs DeepSeek 官方（2026-10-26 实测定案）', domainId: 'D3' },
  { key: '系统工具与调试', name: '系统工具与调试', domainId: 'D3' },
  { key: '录屏压缩与api', name: 'MEMORY-录屏压缩与API.md', domainId: 'D3' },
  { key: '主题时效链', name: '主题时效链', domainId: 'D5' },
  { key: '子代理对话', name: '子代理对话', domainId: 'D7' },
]);

/** 显式表命中：族键精确匹配优先，其次成员名精确匹配；返回规则或 null */
export function findExplicitPlacement(family, topicsById) {
  if (!family) return null;
  const fk = normalizeName(family.familyKey || '');
  const memberNorms = (family.members || []).map((id) => normalizeName((topicsById.get(id) || {}).name || ''));
  for (const p of EXPLICIT_PLACEMENT) {
    const k = normalizeName(p.key);
    if (k && fk && k === fk) return p;
    if (k && memberNorms.some((n) => n && n === k)) return p;
    if (p.name) {
      const nm = normalizeName(p.name);
      if (memberNorms.some((n) => n && nm && n === nm)) return p;
    }
  }
  return null;
}

/**
 * D8 四条线的**真实库基线**（2026-10-29 在 `.run/retrigger/formal/mem.db` 实测；Lead 拍板固化）。
 * 检查点 = **全部**名字精确 `YYYY-MM-DD` 的主题（58 个），**不是**"最近 7 天"的 7 个——
 * 7 天是旧 D7 的显示窗口（提醒用），不是归属规则；51 个更早日期主题若回流 D5 会破坏"D5 只留机制/规则"。
 * CLI 会把实测值与本基线对照；spec Z11 钉住这四个数（防口径漂移）。
 */
export const D8_REAL_BASELINE = Object.freeze({
  checkpoint: 58,
  daily: 20,
  session: 17,
  archive: 4,
  sourceDate: '2026-10-29',
  sourceDb: '.run/retrigger/formal/mem.db',
  note: '检查点=全部精确日期主题（无时间窗口）；日摘要/会话摘要/sessions 按名字包含匹配',
});

/** 域规则解析：显式 cfg.domainRules > env MEMTOPIC_DOMAIN_RULES（JSON 数组） > 默认 6 条 */
export function resolveDomainRules(cfg = {}) {
  const c = cfg || {};
  if (Array.isArray(c.domainRules) && c.domainRules.length) return c.domainRules;
  const envRaw = process.env.MEMTOPIC_DOMAIN_RULES;
  if (envRaw) {
    try {
      const arr = JSON.parse(envRaw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* 非法 JSON 忽略，回落默认 */ }
  }
  return DEFAULT_DOMAIN_RULES;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 关键词包含匹配：≥4 字直接 includes；≤3 字的**纯 ASCII** 关键词用词边界（防 rea 命中 create）；
 *  含中文的短关键词直接 includes（中文没有单词边界，边界规则会把"everything插件登记"误判成不匹配）。 */
export function keywordMatches(normText, normKeyword) {
  const t = String(normText == null ? '' : normText);
  const k = String(normKeyword == null ? '' : normKeyword);
  if (!t || !k) return false;
  if (k.length >= 4) return t.includes(k);
  if (/^[a-z0-9]+$/.test(k)) return new RegExp(`(^|[^a-z0-9])${escapeRe(k)}([^a-z0-9]|$)`).test(t);
  return t.includes(k);
}

function matchDomainByTexts(texts, rules) {
  for (const rule of rules || []) {
    if (!rule || !rule.domainId) continue;
    for (const kw of rule.keywords || []) {
      const nk = normalizeName(kw);
      if (!nk) continue;
      if (texts.some((t) => t && keywordMatches(t, nk))) return rule.domainId;
    }
    // patterns：对归一化后的族键/主题名做正则匹配（用于"纯日期/日期开头"这类结构特征）
    for (const pat of rule.patterns || []) {
      let re = null;
      try { re = new RegExp(pat); } catch { continue; }
      if (texts.some((t) => t && re.test(t))) return rule.domainId;
    }
  }
  return null;
}

// ---- D7 漏网分流（2026-10-29 二次裁决：D7 只留漏网归档；检查点迁 D8）----
const D7_LEAK_RE = /漏网|补档|stale|归档待整合/;
const D7_DAILY_RE = /日摘要/;   // 仅用于 buildSessionInfo 的 isDaily 标记（供 D8/D7 判定参考）

/**
 * D7 判定：只认漏网/补档/stale-archive（dream 待整合队列，mode=dream-queue）。
 * 检查点线已迁到 D8「日记忆」——这里不再返回 'checkpoint'。
 * 注意：项目域（D1–D4）优先，调用方已先跑过项目关键词 ⇒ 这里只会拿到"无项目前缀"的族。
 */
export function classifyD7Family(family, topicsById) {
  const keyText = normalizeName(family && family.familyKey ? family.familyKey : '');
  const memberNames = (family && family.members ? family.members : [])
    .map((id) => normalizeName((topicsById.get(id) || {}).name || ''));
  const texts = [keyText, ...memberNames].filter(Boolean);
  if (texts.some((t) => D7_LEAK_RE.test(t))) return 'leak';
  return null;
}

// ---- D8 日记忆分流（2026-10-29 用户裁决：按天流水收拢成 4 条线）----
const D8_EXACT_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;

/**
 * D8 判定：返回命中的 lineId（'D8-checkpoint'|'D8-daily'|'D8-session'|'D8-archive'）或 null。
 * 规则来自 DOMAIN_RULES.D8.lines（可配置）：
 *   · checkpoint: 名字**精确** `YYYY-MM-DD`（不含描述；带描述的日期主题仍归 D5/项目域）
 *   · daily/session/archive: 名字包含 日摘要 / 会话摘要 / sessions
 * 判定顺序按 lines 数组；项目域(D1–D4)在调用方先跑，故"徕卡一瞬 · 2026-10-09 …"不会被抢。
 */
export function classifyD8Family(family, topicsById, rule = null) {
  const defs = (rule && Array.isArray(rule.lines) && rule.lines.length)
    ? rule.lines
    : DEFAULT_DOMAIN_RULES.find((r) => r.domainId === 'D8').lines;
  const rawNames = [];
  if (family && family.familyKey) rawNames.push(String(family.familyKey));
  for (const id of (family && family.members) || []) {
    rawNames.push(String((topicsById.get(id) || {}).name || ''));
  }
  const names = rawNames.map((x) => x.trim()).filter(Boolean);
  const normNames = names.map((x) => normalizeName(x));
  // 漏网/补档是 dream 待整合队列，归 D7——即使名字里带 sessions 也不进 D8 归档线
  if (normNames.some((x) => /漏网|补档/.test(x))) return null;
  for (const def of defs) {
    if (def.exactDate) {
      if (names.some((x) => D8_EXACT_DATE_RE.test(x))) return def.lineId;
      continue;
    }
    if (def.nameIncludes) {
      const needle = normalizeName(def.nameIncludes);
      if (needle && normNames.some((x) => x.includes(needle))) return def.lineId;
    }
  }
  return null;
}

/**
 * 会话检查点判定用的 src 信息：对每个主题看它的句子 src 是否 `sessions/*.md` 且日期落在最近 hotDays。
 * cfg.now 可注入（ms 或 Date），测试用固定时间保证确定性；CLI 用系统时间。
 */
export function buildSessionInfo(store, topics, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  const hotDays = Number.isFinite(Number(c.sessionHotDays)) ? Number(c.sessionHotDays) : 7;
  let now = Date.now();
  if (cfg && cfg.now != null) now = cfg.now instanceof Date ? cfg.now.getTime() : Number(cfg.now);
  if (!Number.isFinite(now)) now = Date.now();
  const recentMs = hotDays * 86400000;
  const info = new Map();
  for (const t of topics || []) {
    const name = t.name || '';
    const isDaily = D7_DAILY_RE.test(name);
    let recentSessionSrc = false;
    if (!isDaily) {
      const rows = sentencesOf(store, t.id);
      for (const r of rows) {
        const src = String((r && r.src) || '');
        if (!/sessions[\\/]/i.test(src)) continue;
        const m = src.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
        if (!m) continue;
        const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (now - d <= recentMs && d <= now + 86400000) { recentSessionSrc = true; break; }
      }
    }
    info.set(t.id, { recentSessionSrc, isDaily });
  }
  return info;
}

/**
 * 族 → 域。优先级（Lead 2026-10-30 三次裁决，避免"两头抢"）：
 *   0) 显式归属表 EXPLICIT_PLACEMENT（人工裁决，最高优先；D6 清零的 20 条靠它钉死）
 *   1) 项目域（D1–D4/自定义）—— 族键优先，其次成员名（"徕卡一瞬 · 2026-10-09 …" 归 D2，绝不进 D8）
 *   2) D8 日记忆（检查点精确日期 / 日摘要 / 会话摘要 / sessions 归档）
 *   3) D7 漏网归档（dream-queue）
 *   4) D5 记忆机制/规则类知识
 *   5) D9 自研应用 / D10 基础设施（只靠显式表，无宽泛关键词）
 *   6) D6 兜底
 */
export function assignDomainToFamily(family, topicsById, rules = DEFAULT_DOMAIN_RULES, extras = {}) {
  // 0) 显式归属表（人工裁决，最高优先）
  const explicit = findExplicitPlacement(family, topicsById);
  if (explicit) return explicit.domainId;
  const keyText = normalizeName(family && family.familyKey ? family.familyKey : '');
  const memberTexts = (family && family.members ? family.members : [])
    .map((id) => normalizeName((topicsById.get(id) || {}).name || ''));
  const allTexts = [keyText, ...memberTexts].filter(Boolean);
  const flowIds = new Set(['D5', 'D7', 'D8']);
  const preRules = (rules || []).filter((r) => r && r.domainId && !flowIds.has(r.domainId));
  // 1) 项目域（D1–D4，项目日志优先，不挪）
  const byKey = keyText ? matchDomainByTexts([keyText], preRules) : null;
  if (byKey) return byKey;
  const byMember = matchDomainByTexts(memberTexts, preRules);
  if (byMember) return byMember;
  // 2) D8 日记忆（4 条线）
  const d8Rule = (rules || []).find((r) => r && r.domainId === 'D8');
  if (d8Rule && classifyD8Family(family, topicsById, d8Rule)) return 'D8';
  // 3) D7 漏网归档
  const d7Rule = (rules || []).find((r) => r && r.domainId === 'D7');
  if (d7Rule && classifyD7Family(family, topicsById)) return 'D7';
  // 4) D5 记忆机制/规则类知识
  const d5Rule = (rules || []).find((r) => r && r.domainId === 'D5');
  if (d5Rule) {
    const hit = (keyText ? matchDomainByTexts([keyText], [d5Rule]) : null)
      || matchDomainByTexts(memberTexts, [d5Rule]);
    if (hit) return 'D5';
  }
  // 5) 兜底
  return matchDomainByTexts(allTexts, rules) || D6_DOMAIN.domainId;
}

/**
 * 落地"并入现有族"的显式规则（EXPLICIT_PLACEMENT 里带 `lineKey` 的条目）：
 * 把源族（族键精确匹配 key）的成员移入目标族（族键精确匹配 lineKey），并删除变空的源族。
 * 返回 moved 明细（含失败原因），供断言/日志核对。
 */
export function applyExplicitFamilyMoves(families, topicsById) {
  const moved = [];
  for (const p of EXPLICIT_PLACEMENT) {
    if (!p.lineKey) continue;
    const srcKey = normalizeName(p.key);
    const dstKey = normalizeName(p.lineKey);
    const src = families.find((f) => normalizeName(f.familyKey || '') === srcKey);
    const dst = families.find((f) => normalizeName(f.familyKey || '') === dstKey);
    if (!src || !dst || src === dst) {
      moved.push({ key: p.key, lineKey: p.lineKey, ok: false, why: !src ? 'src-missing' : !dst ? 'dst-missing' : 'same-family' });
      continue;
    }
    const ids = src.members.slice();
    for (const id of ids) if (!dst.members.includes(id)) dst.members.push(id);
    src.members = [];
    dst.members.sort();
    dst.topicCount = dst.members.length;
    moved.push({ key: p.key, lineKey: p.lineKey, ok: true, ids, from: src.familyKey, to: dst.familyKey });
  }
  for (let i = families.length - 1; i >= 0; i--) if (!families[i].members.length) families.splice(i, 1);
  return moved;
}

/** 系列主干：去 MEMORY-/日期/md/模板话术后再去掉残留数字（"日摘要 · 2026-10-08（明细…）" ⇒ "日摘要明细容量治理下沉"） */
export function seriesStemOf(name) {
  return stripDecorations(name).replace(/\d+/g, '');
}

/** 从主题名里取第一个 8 位日期（兼容 "2026-08-23 会话摘要" 与 "日摘要 · 2026-10-08…"） */
export function extractSeriesDate(name) {
  const n = normalizeName(name);
  const m = n.match(/(20\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

const isoDate = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

/** 是否"系列族"（日摘要/会话摘要这类按天/按会话逐期记录的族） */
export function isSeriesFamily(family, topicsById, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  const patterns = (c.seriesPatterns || ['日摘要', '会话摘要', '摘要']).map((x) => normalizeName(x)).filter(Boolean);
  const texts = [normalizeName((family && family.familyKey) || '')];
  for (const id of (family && family.members ? family.members.slice(0, 8) : [])) {
    texts.push(normalizeName((topicsById.get(id) || {}).name || ''));
  }
  return patterns.some((p) => texts.some((t) => t && t.includes(p)));
}

/**
 * 系列分组：同族内、主干**相同或互相包含**、相邻日期差 ≤ seriesMaxGapDays(7)、
 * 且组跨度 ≤ seriesMaxSpanDays(30) ⇒ 同一 series 组（组内每期是 L3 明细）。
 *
 * 2026-10-29 Lead 裁决：日摘要 20 期里有"...容量治理下沉 / 自sessionsmd整档下沉 / 整节下沉"等后缀变体，
 * 按"主干完全相同"会拆成 4 组；改成"主干互相包含"后并成 1 组（日期链仍 ≤7 天，跨度 ≤30 天）。
 * 主干毫无包含关系（如"明细" vs "汇总"）/跨族/日期跳跃过大 ⇒ 仍分开，Y04 用这些做反例。
 */
export function buildSeriesGroups(members, topicsById, cfg = {}) {
  const c = mergeCurationConfig(cfg);
  const items = (members || []).map((id) => {
    const name = (topicsById.get(id) || {}).name || '';
    return { id, stem: seriesStemOf(name) || normalizeName(name) || String(id), date: extractSeriesDate(name) };
  });
  // 主干类：并查集，两两"相等或互相包含"即同类
  const parent = items.map((_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].stem;
      const b = items[j].stem;
      if (!a || !b) continue;
      if (a === b || a.includes(b) || b.includes(a)) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const byClass = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!byClass.has(r)) byClass.set(r, []);
    byClass.get(r).push(it);
  });
  const groups = [];
  for (const [, list] of byClass) {
    // 组键取类内最长的主干（信息量最大、可读）
    const stem = list.map((x) => x.stem).sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1))[0] || '';
    const dated = list.filter((x) => x.date != null).sort((a, b) => (a.date - b.date) || (a.id < b.id ? -1 : 1));
    const undated = list.filter((x) => x.date == null).sort((a, b) => (a.id < b.id ? -1 : 1));
    let cur = [];
    let start = null;
    const flush = () => {
      if (!cur.length) return;
      groups.push({
        key: stem,
        members: cur.map((x) => x.id),
        firstDate: isoDate(cur[0].date),
        lastDate: isoDate(cur[cur.length - 1].date),
      });
      cur = [];
      start = null;
    };
    for (const it of dated) {
      if (!cur.length) { cur = [it]; start = it.date; continue; }
      const prev = cur[cur.length - 1].date;
      const gapDays = (it.date - prev) / 86400000;
      const spanDays = (it.date - start) / 86400000;
      if (gapDays <= c.seriesMaxGapDays && spanDays <= c.seriesMaxSpanDays) cur.push(it);
      else { flush(); cur = [it]; start = it.date; }
    }
    flush();
    for (const it of undated) groups.push({ key: stem, members: [it.id], firstDate: null, lastDate: null });
  }
  // 大组优先，其次按 key 稳定排序
  return groups.sort((a, b) => (b.members.length - a.members.length) || (a.key < b.key ? -1 : 1));
}

/**
 * 产物：三级结构提案树（只读）。
 * 返回 { domains, counts, families, acceptedClusters, rejectedClusters, stats, config }
 *   domains: [{ domainId, name, families: [{familyKey, tier:'multi'|'single'|'series', members, seriesGroups}], stats }]
 *   counts:  { domains, multiFamilies, singleFamilies, seriesFamilies, seriesGroups,
 *              l1, l2, mainTopics, l3Details, totalTopics, unmappedFamilies, unmappedTopics }
 */
export function proposeTopicTree(store, cfg = {}, proposal = null) {
  const c = mergeCurationConfig(cfg);
  const p = proposal || proposeClusters(store, c);  // 允许复用已算好的平铺提案（CLI 只读一次库）
  const topics = p.scan.topics;
  const byId = new Map(topics.map((t) => [t.id, t]));
  const rules = resolveDomainRules(c).filter((r) => r && r.domainId && r.domainId !== D6_DOMAIN.domainId);
  const domains = rules.map((r) => ({ domainId: r.domainId, name: r.name, families: [], stats: {} }));
  domains.push({ domainId: D6_DOMAIN.domainId, name: D6_DOMAIN.name, families: [], stats: {} });
  const domainById = new Map(domains.map((d) => [d.domainId, d]));

  // D7 的 src 判定需要"会话检查点"信息（sessions/*.md 且日期落在最近 hotDays）
  const nowMs = c.now != null ? (c.now instanceof Date ? c.now.getTime() : Number(c.now)) : Date.now();
  const sessionInfo = buildSessionInfo(store, topics, { ...c, now: nowMs });

  // 显式"并入现有族"（如 星易服原型→长沙交易场地线 / AXML修补器→徕卡一瞬线）：先重挂成员，再算域/线
  const explicitMoves = applyExplicitFamilyMoves(p.families, byId);

  const d8RuleForFam = rules.find((r) => r && r.domainId === 'D8');
  for (const fam of p.families) {
    const domainId = assignDomainToFamily(fam, byId, rules, { sessionInfo });
    const seriesLike = isSeriesFamily(fam, byId, c);          // 是否归档系列族（日摘要/会话摘要…），与成员数无关
    const tier = fam.topicCount === 1 ? 'single' : (seriesLike ? 'series' : 'multi');
    const d8LineId = domainId === 'D8' ? classifyD8Family(fam, byId, d8RuleForFam) : null;
    const explicit = findExplicitPlacement(fam, byId);
    const lineGroupId = explicit && explicit.lineId ? explicit.lineId : null;   // D9/D10 线容器
    // D7：只有真漏网族进 dream-queue 线；其它显式归 D7 的主题（如"子代理对话"）挂域下直接明细（mode=null）
    const d7Kind = domainId === 'D7' ? classifyD7Family(fam, byId) : null;
    const mode = domainId === 'D8'
      ? 'daily-append'                                        // D8 四条线都是按天追加
      : (domainId === 'D7' ? (d7Kind === 'leak' ? 'dream-queue' : null)
        : (domainId === 'D5' && seriesLike ? 'archive-series' : null));
    const node = {
      familyKey: fam.familyKey,
      tier,
      mode,
      members: fam.members.slice().sort(),
      topicCount: fam.topicCount,
      seriesGroups: tier === 'series' ? buildSeriesGroups(fam.members, byId, c) : [],
    };
    if (d8LineId) node.d8LineId = d8LineId;                   // 聚合进 D8 线容器时用
    if (lineGroupId) node.lineGroupId = lineGroupId;          // 聚合进 D9/D10 线容器时用
    if (mode === 'dream-queue') node.consumed = false;   // dream 队列每条带 consumed（初始 false，消费后置 true）
    const d = domainById.get(domainId) || domainById.get(D6_DOMAIN.domainId);
    d.families.push(node);
  }

  for (const d of domains) {
    d.families.sort((a, b) => (b.topicCount - a.topicCount) || (a.familyKey < b.familyKey ? -1 : 1));
    d.stats = {
      familyCount: d.families.length,
      topicCount: d.families.reduce((a, f) => a + f.topicCount, 0),
      projectLines: d.families.filter((f) => f.tier !== 'single').length,
      seriesGroups: d.families.reduce((a, f) => a + f.seriesGroups.length, 0),
      modes: d.families.reduce((acc, f) => { if (f.mode) acc[f.mode] = (acc[f.mode] || 0) + 1; return acc; }, {}),
    };
  }

  // D7 两条固定线（会话检查点 daily-append / 漏网归档待整合 dream-queue）——
  // Lead 2026-10-29 要求：**同 mode 的族必须收进"线容器"**（1 条项目线 + N 期明细），
  // 否则 7 个日期主题各留成 single 族直接挂域下，d7Lines=2 与树里项目线数对不上。
  const d7 = domainById.get('D7');
  const d7SourceFamilyCount = d7 ? d7.families.length : 0;   // 聚合前的族数（用于 familyNodes 口径自洽）
  if (d7) {
    const d7Rule = rules.find((r) => r.domainId === 'D7');
    const lineDefs = (d7Rule && Array.isArray(d7Rule.lines) && d7Rule.lines.length)
      ? d7Rule.lines
      : [{ lineId: 'D7-leak', name: '漏网归档待整合', mode: 'dream-queue', consumedByDefault: false, consumed: false }];
    const lineNodes = lineDefs.map((def) => {
      const bucket = d7.families.filter((f) => f.mode === def.mode);
      const members = bucket.flatMap((f) => f.members).sort();
      const node = {
        lineId: def.lineId,
        name: def.name,                            // 线名（面板/日志用）
        familyKey: def.name,                       // 线名即族键（tree-apply 用 familyKey 建 L2 节点）
        tier: 'line',
        level: 'project',
        mode: def.mode,
        members,
        topicCount: members.length,
        seriesGroups: [],
        details: members.map((id) => ({ id, level: 'detail', parent: def.lineId })),
        consumedByDefault: false,
        sourceFamilyKeys: bucket.map((f) => f.familyKey),   // 原族键（可追溯；落库时按 members 建父子）
      };
      if (def.mode === 'dream-queue') node.consumed = def.consumed === true;
      if (def.hotDays != null) { node.hotDays = def.hotDays; node.warmDays = def.warmDays; node.coldDays = def.coldDays; }
      return node;
    });
    d7.lines = lineNodes;
    // 线容器替换 dream-queue 族；D7 域下的**其它显式明细**（如"子代理对话"，mode=null）保留为单族挂域下
    const others = domainById.get('D7').families.filter((f) => f.mode !== 'dream-queue');
    d7.families = [...lineNodes, ...others];
    d7.stats = {
      familyCount: d7.families.length,
      topicCount: d7.families.reduce((a, f) => a + f.topicCount, 0),
      projectLines: d7.families.filter((f) => f.tier !== 'single').length,
      seriesGroups: 0,
      modes: d7.families.reduce((acc, f) => { if (f.mode) acc[f.mode] = (acc[f.mode] || 0) + 1; return acc; }, {}),
      lines: d7.lines.length,
      leakTopics: (d7.lines.find((x) => x.mode === 'dream-queue') || {}).topicCount || 0,
      domainDetails: others.reduce((a, f) => a + f.topicCount, 0),
    };
  }

  // D8 四条固定线（会话检查点 / 日摘要明细 / 会话摘要 / sessions 原始归档）——
  // 与 D7 同一套"线容器"语义：同线族收成 1 条项目线 + N 期明细（否则 20+17+7+4 期各成 single 族，主主题数会虚高）。
  const d8 = domainById.get('D8');
  const d8SourceFamilyCount = d8 ? d8.families.length : 0;
  if (d8) {
    const d8Rule = rules.find((r) => r.domainId === 'D8');
    const lineDefs = (d8Rule && Array.isArray(d8Rule.lines) && d8Rule.lines.length)
      ? d8Rule.lines
      : [
        { lineId: 'D8-checkpoint', name: '会话检查点', mode: 'daily-append', exactDate: true, hotDays: 7, warmDays: 30, coldDays: 90 },
        { lineId: 'D8-daily', name: '日摘要明细', mode: 'daily-append', nameIncludes: '日摘要' },
        { lineId: 'D8-session', name: '会话摘要', mode: 'daily-append', nameIncludes: '会话摘要' },
        { lineId: 'D8-archive', name: 'sessions 原始归档', mode: 'daily-append', nameIncludes: 'sessions' },
      ];
    const lineNodes = lineDefs.map((def) => {
      const bucket = d8.families.filter((f) => f.d8LineId === def.lineId);
      const members = bucket.flatMap((f) => f.members).sort();
      const node = {
        lineId: def.lineId,
        name: def.name,
        familyKey: def.name,
        tier: 'line',
        level: 'project',
        mode: def.mode || 'daily-append',
        members,
        topicCount: members.length,
        seriesGroups: buildSeriesGroups(members, byId, c),   // 线内按期分组（日摘要 20 期→1 组；会话摘要按日期跳跃分组）
        details: members.map((id) => ({ id, level: 'detail', parent: def.lineId })),
        sourceFamilyKeys: bucket.map((f) => f.familyKey),
      };
      if (def.hotDays != null) { node.hotDays = def.hotDays; node.warmDays = def.warmDays; node.coldDays = def.coldDays; }
      return node;
    });
    d8.lines = lineNodes;
    d8.families = lineNodes.slice();                // D8 = 4 条项目线
    const lineCount = (lineId) => (lineNodes.find((x) => x.lineId === lineId) || {}).topicCount || 0;
    d8.stats = {
      familyCount: d8.families.length,
      topicCount: d8.families.reduce((a, f) => a + f.topicCount, 0),
      projectLines: d8.families.filter((f) => f.tier !== 'single').length,
      seriesGroups: 0,
      modes: d8.families.reduce((acc, f) => { if (f.mode) acc[f.mode] = (acc[f.mode] || 0) + 1; return acc; }, {}),
      lines: d8.lines.length,
      checkpointTopics: lineCount('D8-checkpoint'),
      dailyTopics: lineCount('D8-daily'),
      sessionTopics: lineCount('D8-session'),
      archiveTopics: lineCount('D8-archive'),
    };
  }

  // D9 / D10 线容器（自研应用 / 基础设施与运维）：成员由 EXPLICIT_PLACEMENT 的 lineId 决定，
  // 把同线的单族收成 1 条项目线 + N 明细（否则 6/4 条各成 single 族，主主题虚高且不成组）。
  const d9 = domainById.get('D9');
  const d10 = domainById.get('D10');
  const d9SourceFamilyCount = d9 ? d9.families.length : 0;
  const d10SourceFamilyCount = d10 ? d10.families.length : 0;
  for (const domainId of ['D9', 'D10']) {
    const d = domainById.get(domainId);
    if (!d) continue;
    const rule = rules.find((r) => r && r.domainId === domainId);
    const lineDefs = (rule && Array.isArray(rule.lines)) ? rule.lines : [];
    const lineNodes = lineDefs.map((def) => {
      const bucket = d.families.filter((f) => f.lineGroupId === def.lineId);
      const members = bucket.flatMap((f) => f.members).sort();
      const node = {
        lineId: def.lineId,
        name: def.name,
        familyKey: def.name,
        tier: 'line',
        level: 'project',
        mode: def.mode != null ? def.mode : null,
        members,
        topicCount: members.length,
        seriesGroups: [],
        details: members.map((id) => ({ id, level: 'detail', parent: def.lineId })),
        sourceFamilyKeys: bucket.map((f) => f.familyKey),
      };
      return node;
    });
    d.lines = lineNodes;
    d.families = lineNodes.slice();
    d.stats = {
      familyCount: d.families.length,
      topicCount: d.families.reduce((a, f) => a + f.topicCount, 0),
      projectLines: d.families.filter((f) => f.tier !== 'single').length,
      seriesGroups: 0,
      modes: {},
      lines: d.lines.length,
      lineCounts: Object.fromEntries(lineNodes.map((l) => [l.lineId, l.topicCount])),
    };
  }

  // 树节点口径：只数"有成员"的节点（D7 的空队列线仍会出现在树里供面板展示，但不算族节点/项目线）
  const filled = (f) => (f.members ? f.members.length > 0 : false);
  const treeNodes = domains.reduce((a, d) => a + d.families.filter(filled).length, 0);
  const projectLines = domains.reduce((a, d) => a + d.families.filter((f) => f.tier !== 'single' && filled(f)).length, 0);
  const singleNodes = treeNodes - projectLines;
  const seriesFamilies = p.families.filter((f) => f.topicCount > 1 && isSeriesFamily(f, byId, c));
  const totalTopics = topics.length;
  const l1 = domains.length;
  const l2 = projectLines;                          // 项目线数（含 D7 两条线容器）
  const d6 = domainById.get(D6_DOMAIN.domainId);
  const d5 = domainById.get('D5');
  const domainMemberSum = domains.reduce((a, d) => a + d.stats.topicCount, 0);
  const counts = {
    domains: l1,
    multiFamilies: l2,                              // 保持旧字段名；值 = 树里 tier!=='single' 的节点数（项目线）
    singleFamilies: singleNodes,
    familyNodes: treeNodes,                         // 树里族节点总数
    familyTotal: p.families.length,                 // 族层面总数（D7 原 9 族已聚合为 2 条线）
    seriesFamilies: seriesFamilies.length,
    seriesGroups: domains.reduce((a, d) => a + d.stats.seriesGroups, 0),
    l1,
    l2,
    // ---- Lead 2026-10-29 指定口径四项（不要用 effective 当主数字）----
    mainTopics: l1 + l2,               // 主主题 = 域 + 项目线（L3 不计入）
    l3Details: totalTopics - l2,       // 实挂明细 = 总主题 - 项目线主题
    unmapped: d6.stats.topicCount,     // D6 未归类主题数
    totalTopics,                       // 全部主题（含 D6）
    // ---- 细项（供面板/apply 用）----
    skippedContainers: p.scan.skippedContainers || 0,   // 被跳过的已落树容器（level=domain/project）
    unmappedFamilies: d6.stats.familyCount,
    unmappedTopics: d6.stats.topicCount,
    domainMemberSum,                   // 全部域成员之和（必须 === totalTopics）
    d5Topics: d5 ? d5.stats.topicCount : 0,
    d7Topics: d7 ? d7.stats.topicCount : 0,
    d7Lines: d7 ? d7.lines.length : 0,
    d7AggregatedFamilies: Math.max(0, d7SourceFamilyCount - (d7 ? d7.families.length : 0)),
    d7LeakTopics: d7 ? d7.stats.leakTopics : 0,
    d7Stats: d7 ? d7.stats : null,
    // ---- D8 日记忆（4 条线）----
    d8Topics: d8 ? d8.stats.topicCount : 0,
    d8Lines: d8 ? d8.lines.length : 0,
    d8AggregatedFamilies: Math.max(0, d8SourceFamilyCount - (d8 ? d8.families.length : 0)),
    d8CheckpointTopics: d8 ? d8.stats.checkpointTopics : 0,
    d8DailyTopics: d8 ? d8.stats.dailyTopics : 0,
    d8SessionTopics: d8 ? d8.stats.sessionTopics : 0,
    d8ArchiveTopics: d8 ? d8.stats.archiveTopics : 0,
    d8Stats: d8 ? d8.stats : null,
    // ---- D9 自研应用 / D10 基础设施（显式归属，D6 清零）----
    d9Topics: d9 ? d9.stats.topicCount : 0,
    d9Lines: d9 ? d9.lines.length : 0,
    d9AggregatedFamilies: Math.max(0, d9SourceFamilyCount - (d9 ? d9.families.length : 0)),
    d9LineCounts: d9 ? d9.stats.lineCounts : {},
    d10Topics: d10 ? d10.stats.topicCount : 0,
    d10Lines: d10 ? d10.lines.length : 0,
    d10AggregatedFamilies: Math.max(0, d10SourceFamilyCount - (d10 ? d10.families.length : 0)),
    d10LineCounts: d10 ? d10.stats.lineCounts : {},
    explicitMoves: explicitMoves || [],
  };
  return {
    domains,
    counts,
    families: p.families,
    acceptedClusters: p.clusters,
    rejectedClusters: p.rejectedClusters,
    stats: p.stats,
    config: c,
    sessionWindow: { now: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(), hotDays: Number(c.sessionHotDays) || 7 },
  };
}

/** CLI 用的域摘要（一行一域，最多 maxLines 行） */
export function treeSummaryLines(tree, maxLines = 20) {
  const lines = [];
  for (const d of tree.domains) {
    const projectLines = d.stats.projectLines;
    const singles = d.stats.familyCount - projectLines;
    const modePart = d.lines && d.lines.length
      ? ` | 线 ${d.lines.map((l) => `${l.name}(${l.mode} ${l.topicCount})`).join(' / ')}`
      : (d.stats.seriesGroups ? ` | 系列组 ${d.stats.seriesGroups}` : '');
    lines.push(`${d.domainId} ${d.name} | 族 ${d.stats.familyCount}（项目线 ${projectLines} / 单主题 ${singles}）| 主题 ${d.stats.topicCount}${modePart}`);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 13. CLI（dry-run only）
// ---------------------------------------------------------------------------

const USAGE = `用法：node src/curation.mjs --db <file> [--out <dir>] [选项]

归类提案引擎（只读 dry-run）。强内聚闸 + 禁链式 + 项目级族边界；
主产物是**三级结构提案**（域 → 项目线 → 明细），同时保留平铺簇质量信息。
不过闸的簇不进提案（进 rejectedClusters 供人工看）。

落盘：curation-tree.json（三级结构，主产物）/ curation-proposals.json / curation-proposals.csv。

必填：
  --db <file>            库文件（.db = sqlite / .jsonl = ledger 降级后端）

可选：
  --out <dir>            输出目录（默认当前目录）
  --top <n>              只打印前 n 条 accepted（默认全部）
  --no-csv               不写 CSV
  --apply                **未实现**（本阶段严禁写库，直接 NOT_IMPLEMENTED 退出）
  -h, --help             显示本帮助

退出码：0 = 体检完成且零写入；2 = 参数错误/NOT_IMPLEMENTED；3 = 检测到库文件被改动（异常）
`;

function parseArgs(argv) {
  const out = { db: null, out: null, top: null, csv: true, apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = (key) => {
      if (a.startsWith('--' + key + '=')) return a.slice(key.length + 3);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { i += 1; return argv[i]; }
      return null;
    };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--no-csv') out.csv = false;
    else if (a === '--db' || a.startsWith('--db=')) out.db = take('db');
    else if (a === '--out' || a.startsWith('--out=')) out.out = take('out');
    else if (a === '--top' || a.startsWith('--top=')) out.top = Number(take('top'));
    else if (a.startsWith('--')) throw new CurationError('BAD_ARG', `未知参数：${a}`);
  }
  return out;
}

function digestDbFiles(file) {
  const parts = [];
  for (const f of [file, file + '-wal', file + '-shm']) {
    try {
      if (fs.existsSync(f)) {
        parts.push(path.basename(f) + '=' + createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
      }
    } catch { /* 读不到就跳过 */ }
  }
  return parts.join(';');
}

async function openStore(dbFile) {
  const kind = /\.(jsonl|ledger)$/i.test(dbFile) ? 'ledger' : 'sqlite';
  const { MemoryStore } = await import('./memory-store.mjs');
  if (kind === 'sqlite') {
    const { SqliteBackend } = await import('./backend-sqlite.mjs');
    const be = new SqliteBackend(dbFile);
    try { if (be.db && typeof be.db.exec === 'function') be.db.exec('PRAGMA query_only = ON'); } catch { /* 老版本 sqlite */ }
    return { store: new MemoryStore(be), be, kind };
  }
  const { LedgerBackend } = await import('./backend-ledger.mjs');
  const be = new LedgerBackend(dbFile);
  return { store: new MemoryStore(be), be, kind };
}

/**
 * 只读打开目标：若存在未 checkpoint 的 -wal（别的进程正在写），直接打开会触发 WAL 恢复、
 * 关闭时把 wal checkpoint 回主文件 —— dry-run 就等于改了库。复制快照读，原库零写入。
 */
function prepareReadTarget(dbFile, outDir) {
  const wal = dbFile + '-wal';
  if (!fs.existsSync(wal)) return { file: dbFile, snapshotDir: null, note: null };
  const snapDir = path.join(outDir, '.curation-snapshot-' + process.pid + '-' + Date.now());
  fs.mkdirSync(snapDir, { recursive: true });
  const target = path.join(snapDir, path.basename(dbFile));
  fs.copyFileSync(dbFile, target);
  try { fs.copyFileSync(wal, target + '-wal'); } catch { /* wal 恰好在复制前被 checkpoint 删掉 */ }
  return {
    file: target,
    snapshotDir: snapDir,
    note: '检测到未 checkpoint 的 -wal（库正在被写入）：已复制一致性快照后读取（原库零写入）',
  };
}

function fmtNum(x) { return Number(x || 0).toLocaleString('zh-CN'); }

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    console.error(String((e && e.message) || e));
    console.error(USAGE);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.apply) {
    console.error('NOT_IMPLEMENTED: --apply 未实现。归类提案引擎本阶段只读，禁止写库。');
    console.error('下一步：Lead 逐簇人工裁决后，由 task-13（mergeCluster/linkParent）执行写库。');
    return 2;
  }
  if (!args.db) { console.error('缺少 --db <file>'); console.error(USAGE); return 2; }
  const dbFile = path.resolve(args.db);
  if (!fs.existsSync(dbFile)) {
    console.error(`库文件不存在：${dbFile}（dry-run 不会新建库）`);
    return 2;
  }

  const cfg = {};
  const outDir = path.resolve(args.out || process.cwd());
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'curation-proposals.json');
  const csvPath = path.join(outDir, 'curation-proposals.csv');
  const treePath = path.join(outDir, 'curation-tree.json');

  const before = digestDbFiles(dbFile);
  const readTarget = prepareReadTarget(dbFile, outDir);
  const { store, be, kind } = await openStore(readTarget.file);
  let p;
  let rep;
  let tree;
  try {
    p = proposeClusters(store, cfg);
    rep = reportScale(store, cfg, p);
    tree = proposeTopicTree(store, cfg, p);          // 三级结构提案（复用同一份平铺结果）
  } finally {
    try { be.close(); } catch { /* noop */ }
    if (readTarget.snapshotDir) {
      try { fs.rmSync(readTarget.snapshotDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
  const after = digestDbFiles(dbFile);
  const zeroWrite = before === after;

  const allClusters = [...p.clusters, ...p.rejectedClusters];
  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'memtopic/src/curation.mjs',
    version: 3,
    mode: 'dry-run',
    db: dbFile,
    backend: kind,
    readMode: readTarget.snapshotDir ? 'snapshot' : 'direct',
    readNote: readTarget.note,
    config: p.config,
    zeroWrite,
    dbDigest: { before, after },
    // 三级结构（主产物）：域 → 项目线 → 明细
    topicTree: { counts: tree.counts, domains: tree.domains },
    report: rep,
    acceptedClusters: p.clusters,
    rejectedClusters: p.rejectedClusters,
    families: p.families,
    summaryLines: allClusters.map(clusterSummaryLine),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  if (args.csv) fs.writeFileSync(csvPath, clustersToCsv(allClusters, { bom: true }), 'utf8');

  // 树形提案单独落盘（供 curation-apply 与面板消费；任务要求路径 curation-tree.json）
  const treePayload = {
    generatedAt: new Date().toISOString(),
    tool: 'memtopic/src/curation.mjs',
    version: 3,
    mode: 'dry-run',
    db: dbFile,
    backend: kind,
    readMode: readTarget.snapshotDir ? 'snapshot' : 'direct',
    zeroWrite,
    dbDigest: { before, after },
    domainRules: resolveDomainRules(cfg).map((r) => ({ domainId: r.domainId, name: r.name, keywords: r.keywords ? r.keywords.slice() : [] })),
    counts: tree.counts,
    domains: tree.domains,
    quality: {
      acceptedClusters: p.clusters.length,
      rejectedClusters: p.rejectedClusters.length,
      families: p.families.length,
      note: '质量信息仅供人工参考；树形结构的 L1/L2/L3 与它无关（族边界是硬约束，内聚闸只影响"哪几族能显著合并"）',
    },
  };
  fs.writeFileSync(treePath, JSON.stringify(treePayload, null, 2), 'utf8');

  const R = rep;
  const L = [];
  L.push('=== 归类提案 dry-run（只读）· 三级结构版 ===');
  L.push(`库：${dbFile}`);
  L.push(`后端：${kind} ｜ 数据库 sha256 前：${(before.split(';')[0] || '-')}`);
  if (readTarget.note) L.push(`读取方式：${readTarget.note}`);
  L.push('');
  L.push('— 规模 —');
  L.push(`主题：${fmtNum(R.total.topics)}（${Object.entries(R.total.byState).map(([k, v]) => `${k} ${v}`).join(' / ')}）｜ 句：${fmtNum(R.total.sentences)} ｜ 字：${fmtNum(R.total.chars)}`);
  L.push(`项目族：${R.families.count}（多主题族 ${R.families.multiTopic} / 单主题族 ${R.families.singleTopic}）`);
  L.push(`高区分度 trigger（长度≥${p.config.highTriggerMinChars}、非数字/日期/后缀、覆盖≤${p.config.highTriggerMaxTopics}）：${fmtNum(R.evidence.highTriggerCount)} 个`);
  L.push(`泛化 trigger（覆盖>${p.config.highTriggerMaxTopics}，不作证据）：${fmtNum(R.evidence.genericTriggerCount)} 个 ｜ Top：${(R.evidence.genericTriggers || []).slice(0, 8).map((x) => `${x.trigger}(${x.coverage})`).join(' ｜ ') || '-'}`);
  L.push('');
  L.push('— 三级结构（L1 域 → L2 项目线 → L3 明细）—');
  const C = tree.counts;
  L.push(`域 ${C.domains} ｜ 项目线（多成员族）${C.multiFamilies} ｜ 单主题族 ${C.singleFamilies} ｜ series 族 ${C.seriesFamilies}（系列组 ${C.seriesGroups}）`);
  L.push(`主主题 = L1 ${C.l1} + L2 ${C.l2} = ${C.mainTopics}（目标 ≤${R.targets.maxActiveMainTopics} ${C.mainTopics <= R.targets.maxActiveMainTopics ? '✓' : ' ✗'}）；L3 明细 ${C.l3Details} 不计入；主题总数 ${C.totalTopics}`);
  L.push(`D5 记忆机制 ${C.d5Topics} 主题 ｜ D7 漏网队列 ${C.d7Topics} 主题（线 ${C.d7Lines} 条）｜ D6 未归类 ${C.unmapped}`);
  L.push(`D8 日记忆 ${C.d8Topics} 主题（线 ${C.d8Lines} 条）：检查点 ${C.d8CheckpointTopics} / 日摘要 ${C.d8DailyTopics} / 会话摘要 ${C.d8SessionTopics} / sessions归档 ${C.d8ArchiveTopics}`);
  {
    const actual = { checkpoint: C.d8CheckpointTopics, daily: C.d8DailyTopics, session: C.d8SessionTopics, archive: C.d8ArchiveTopics };
    const base = D8_REAL_BASELINE;
    const same = ['checkpoint', 'daily', 'session', 'archive'].every((k) => actual[k] === base[k]);
    L.push(`D8 基线对照（${base.sourceDate} ${base.sourceDb}）：实测 ${actual.checkpoint}/${actual.daily}/${actual.session}/${actual.archive} vs 基线 ${base.checkpoint}/${base.daily}/${base.session}/${base.archive} ${same ? '✓' : '⚠️ 与基线不一致（库或规则变了，请复核）'}`);
  }
  {
    const fmt = (m) => Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join(' / ') || '-';
    L.push(`D9 自研应用 ${C.d9Topics} 主题（线 ${C.d9Lines} 条）：${fmt(C.d9LineCounts)}`);
    L.push(`D10 基础设施 ${C.d10Topics} 主题（线 ${C.d10Lines} 条）：${fmt(C.d10LineCounts)}`);
    const moves = (C.explicitMoves || []);
    const okMoves = moves.filter((m) => m.ok);
    const badMoves = moves.filter((m) => !m.ok);
    L.push(`显式并入现有线：${okMoves.length ? okMoves.map((m) => `${m.key}→${m.to}`).join(' / ') : '（无）'}${badMoves.length ? ` ⚠️ 失败 ${badMoves.map((m) => `${m.key}(${m.why})`).join(',')}` : ''}`);
  }
  L.push(`层级：主主题 ${C.mainTopics}（域 ${C.l1} + 项目线 ${C.l2}）｜ L3 明细 ${C.l3Details} ｜ 主题总数 ${C.totalTopics} ｜ 域成员合计 ${C.domainMemberSum}`);
  L.push(`跳过已落树容器 ${C.skippedContainers} 个（level=domain/project，不是内容；库内总行 ${C.totalTopics + C.skippedContainers}）`);
  for (const line of treeSummaryLines(tree, 12)) L.push('  ' + line);
  L.push(`未命中 → D6：族 ${C.unmappedFamilies} / 主题 ${C.unmappedTopics}；域成员合计 ${C.domainMemberSum}（应 = 主题总数 ${C.totalTopics}）`);
  L.push('');
  L.push('— 证据（同族内）—');
  L.push(`候选对 ${fmtNum(R.evidence.candidatePairs)} ｜ 强边(≥2证据) ${fmtNum(R.evidence.strongPairs)} ｜ 弱边(单证据) ${fmtNum(R.evidence.monoPairs)}`);
  L.push(`证据类型命中：名字 ${R.evidence.byType.name} / 正文 ${R.evidence.byType.jac} / 高区分度trigger ${R.evidence.byType.trig}`);
  L.push(`强边组合：${Object.entries(R.evidence.strongCombos).map(([k, v]) => `${k} ${v}`).join(' / ') || '（无）'}`);
  const xf = R.evidence.crossFamily || { namePairs: 0, triggerPairs: 0, jacPairs: 0 };
  L.push(`跨族证据被硬拦（在建边阶段就丢弃，不进任何簇）：名字 ${xf.namePairs} / 正文 ${xf.jacPairs} / trigger ${xf.triggerPairs}；样例：${(xf.samples || []).slice(0, 3).map((s) => `${s.aName.slice(0, 16)}×${s.bName.slice(0, 16)}`).join(' ｜ ') || '-'}`);
  L.push('');
  L.push('— 聚类（强内聚闸）—');
  const dist = R.clustering.sizeDistribution;
  L.push(`accepted 簇 ${R.clustering.acceptedCount} 个，覆盖 ${fmtNum(R.clustering.acceptedTopics)} 主题（${(R.clustering.coverageRatio * 100).toFixed(1)}%）`);
  L.push(`  大小分布：${Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}人×${v}`).join(' / ') || '（无）'}`);
  L.push(`rejected 簇 ${R.clustering.rejectedCount} 个，覆盖 ${fmtNum(R.clustering.rejectedTopics)} 主题（链式/低内聚，不进提案）｜ 原因分布：${Object.entries(R.clustering.rejectReasonCounts).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`);
  L.push(`单例 ${R.clustering.singletonCount} 个`);
  L.push('');
  L.push('— 归类后规模（真实值，不许凑）—');
  L.push(`① 现有主题总数：${fmtNum(R.projected.topicsNow)}（一条不丢）`);
  L.push(`② 严格口径（只采纳过闸簇）主主题：${fmtNum(R.projected.strictMainTopics)}（目标 ≤${R.targets.maxActiveMainTopics}）${R.ok.strict ? '✓' : ' ✗'}`);
  L.push(`   其中：accepted 簇 ${R.clustering.acceptedCount} + 其余主题各算 1（${fmtNum(R.projected.strictMainTopics - R.clustering.acceptedCount)}）`);
  L.push(`②' 族级分层方案（每族 1 主主题 + 其余 dormant 明细，需人工逐族确认）：${fmtNum(R.projected.familyPlanMainTopics)}（明细 ${fmtNum(R.projected.familyPlanDetailTopics)}）`);
  L.push(`②'' 若 rejected 簇全部人工确认可合并（上限估计）：${fmtNum(R.projected.ifRejectedMergedMainTopics)}`);
  L.push(`③ 需人工判断的碎片：rejected 簇 ${R.projected.needsHumanReview.rejectedClusters} 个（${R.projected.needsHumanReview.rejectedTopics} 主题）+ 单例 ${fmtNum(R.projected.needsHumanReview.singletons.length)} 个`);
  L.push(`主主题平均保留句数：${R.projected.avgSentencesPerMain}（上限 ${R.targets.maxAvgSentencesPerMain}）${R.ok.avgSentences ? '✓' : ' ✗'}`);
  L.push('');
  const shown = Number.isFinite(args.top) ? R.acceptedClusters.slice(0, args.top) : R.acceptedClusters;
  L.push(`— accepted 簇（${R.acceptedClusters.length} 个，全部列在 JSON/CSV）—`);
  L.push('簇ID | n | 标题 | 置信度 | d=密度 sim=名字 jac=正文 trig=trigger覆盖 | 理由 | 风险');
  for (const cl of shown) L.push(clusterSummaryLine(cl));
  if (R.rejectedClusters.length) {
    L.push('');
    L.push(`— rejected Top5（共 ${R.rejectedClusters.length} 个：链式/低内聚，不能直接合并）—`);
    for (const rj of R.rejectedClusters.slice(0, 5)) {
      L.push(`${rj.clusterId} | n=${rj.memberCount} | d=${Number(rj.density).toFixed(2)} sim=${Number(rj.avgNameSim).toFixed(2)} jac=${Number(rj.avgJaccard).toFixed(3)} | ${rj.suggestedTitle.slice(0, 30)} | 原因：${(rj.rejectReason || []).join('；')}`);
      L.push(`   成员：${rj.members.slice(0, 8).join(' ')}${rj.members.length > 8 ? ' …' : ''}`);
    }
  }
  L.push('');
  L.push(`数据库 sha256 后：${(after.split(';')[0] || '-')}`);
  L.push(`零写入校验：${zeroWrite ? '✓ 一致（未写入任何数据）' : '✗ 不一致（库文件被改动！）'}`);
  L.push(`落盘：${jsonPath}`);
  L.push(`落盘：${treePath}（三级结构提案，供 apply/面板）`);
  if (args.csv) L.push(`落盘：${csvPath}`);
  L.push('提示：--apply 为 NOT_IMPLEMENTED（本阶段只读）。');
  console.log(L.join('\n'));

  if (!zeroWrite) {
    console.error('警告：dry-run 前后库文件 sha256 不一致 —— 归类引擎不应写库，请立即排查。');
    return 3;
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    const a1 = process.argv[1];
    if (!a1) return false;
    return path.resolve(a1).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(String((e && e.stack) || e));
    process.exitCode = 1;
  });
}
