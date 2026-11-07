// 契约层：主题解析 / 治理门控 / 单句 CAS 写入 / 生命周期 / 审计 / 导出 / 完整性
// 与后端无关（sqlite / ledger 走同一套逻辑）。
//
// 分层（阶段 2/3 之后）：
//   governance.mjs  纯函数：归一化 / 相似度分档 / 权限矩阵 / trigger 冲突
//   lifecycle.mjs   纯函数：状态迁移表 / 曝光阶梯(7-30-90) / 队列封顶 / 自动转正
//   memory-store.mjs（本文件）：把两者接到后端上 —— 负责事务、审计、抛 MemError、时钟。
// 依赖单向：governance ← lifecycle ← memory-store（无循环 import）。
import { createHash } from 'node:crypto';
import {
  normalizeName, levenshtein, gradeCreate, findTriggerConflicts,
  resolveActor, can, createStatesFor, isKnownActor, DEFAULT_GOVERNANCE,
  genericTriggersOf, triggerCoverage,
} from './governance.mjs';
import {
  STATES, TRANSITIONS, DEFAULT_LIFECYCLE_CONFIG,
  canTransition, daysBetween, stateSinceOf, planExposure, planArchivable,
  pickOverflowVictim, shouldAutoPromote,
} from './lifecycle.mjs';

// 阶段 1 的公共 API 保持原样导出（既有调用方与契约测试依赖它）
export { normalizeName };
export { STATES as LIFECYCLE_STATES };

export class MemError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

export const sha16 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

const candidateView = (x) => ({
  id: x.id, name: x.name, dist: x.dist, sim: x.sim, contains: x.contains,
  triggerOverlap: x.triggerOverlap, sharedTriggers: x.sharedTriggers,
  // [2026-10-29 P0] 泛化 trigger 证据：raw=不计泛化时的重合数，ignored=被忽略的泛化词（保留在证据里）
  rawTriggerOverlap: x.rawTriggerOverlap, ignoredGenericTriggers: x.ignoredGenericTriggers || [],
  forbiddenReasons: x.forbiddenReasons,
});

// ---------------------------------------------------------------------------
// [task-13] 归类应用（参考式合并）内部工具
// ---------------------------------------------------------------------------
const MERGE_KEEP_RE = /(必须|禁止|不要|不能|口径|结论|决策|定稿|裁决|规范|契约|约定|默认|已验证|实测|根因|修复|教训|重要|必读)/;

/** 默认保留句选择：按"决策/硬口径"关键词 + 数字/GUID/路径加权，上限句数/字符数；返回仍按原顺序 */
function pickKeepRefs(allRefs, maxSentences, maxChars) {
  const scored = allRefs.map((r, idx) => {
    const text = String(r.text || '');
    let score = 0;
    if (MERGE_KEEP_RE.test(text)) score += 3;
    if (/\d/.test(text)) score += 0.5;
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) score += 1;
    if (/[A-Za-z]:\\|~\/|\/[\w\u4e00-\u9fff]+\.(md|json|mjs|js|ps1|csv)/.test(text)) score += 1;
    return { r, idx, score };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = []; let chars = 0;
  for (const x of scored) {
    if (picked.length >= maxSentences) break;
    if (chars + x.r.chars > maxChars) continue;
    picked.push(x); chars += x.r.chars;
  }
  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((x) => x.r);
}

function mergeSig(titleNorm, ids) {
  return createHash('sha256').update(JSON.stringify({ t: titleNorm, m: ids.slice().sort() })).digest('hex').slice(0, 16);
}


export class MemoryStore {
  /**
   * @param {object} backend  SqliteBackend | LedgerBackend（同签名）
   * @param {object} [options]
   * @param {() => number} [options.nowFn]  可注入时钟（默认 Date.now）—— 生命周期测试靠它"拨钟"
   * @param {object} [options.governance]   覆盖 DEFAULT_GOVERNANCE
   * @param {object} [options.lifecycle]    覆盖 DEFAULT_LIFECYCLE_CONFIG
   */
  constructor(backend, options = {}) {
    this.be = backend;
    this._nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
    this.govCfg = { ...DEFAULT_GOVERNANCE, ...(options.governance || {}) };
    this.lifeCfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...(options.lifecycle || {}) };
    this._txDepth = 0;   // store 级事务嵌套深度（Lead 裁决B）
  }

  // ======================================================================
  // 0. 时钟与配置（生命周期测试必须能拨时钟，不用真 sleep）
  // ======================================================================
  nowMs() { return Number(this._nowFn()); }

  // ======================================================================
  // 0b. 批量事务入口（Lead 裁决B）
  // ======================================================================
  /**
   * 在一个事务里跑 fn（同步）。
   *
   * 语义（两后端一致）：
   *   · 最外层：真的 BEGIN → fn() → COMMIT；fn 抛错 ⇒ ROLLBACK 并把异常原样抛出（库回到事务前）；
   *   · 嵌套调用：**不再 BEGIN**，直接执行内层 fn（否则 sqlite 会报 "cannot start a transaction within a transaction"）；
   *     内层抛错不会单独回滚（sqlite 无 SAVEPOINT 时无法部分回滚）⇒ 异常向上冒泡，
   *     由最外层 ROLLBACK 整批撤回；内层若自己吞掉异常，则其写入仍属外层事务（要么一起提交要么一起回滚）。
   *   · 只支持同步函数：fn 返回 Promise 会被拒绝（异步提交语义不明确，宁可报错）。
   *
   * 用法（迁移器：一个文件一个事务）：
   *   store.runInTransaction(() => {
   *     for (const s of sentences) store.appendSentence({ topic, text: s, actor: 'plugin' });
   *   });
   *
   * 注意：`replaceSentence` / `mergeTopics` 内部已用本入口 ⇒ 不要在事务里再手工 begin()。
   */
  runInTransaction(fn) {
    if (typeof fn !== 'function') throw new MemError('BAD_ARG', 'runInTransaction(fn) 需要一个函数');
    const body = () => {
      const r = fn();
      if (r && typeof r.then === 'function') {
        throw new MemError('ASYNC_TX_UNSUPPORTED', 'runInTransaction 只支持同步函数（收到 Promise）');
      }
      return r;
    };
    if (this._txDepth > 0) {
      // 嵌套：直接执行，不重复 BEGIN/COMMIT/ROLLBACK
      this._txDepth += 1;
      try { return body(); } finally { this._txDepth -= 1; }
    }
    this.be.begin();
    this._txDepth = 1;
    let ret;
    try {
      ret = body();
    } catch (e) {
      try { this.be.rollback(); } catch { /* 保留原始异常，不要被回滚错误盖掉 */ }
      this._txDepth = 0;
      this._checkTransactionDepth(e, 'rollback');   // 不变量：异常路径结束后深度也必须归 0
      throw e;
    }
    this.be.commit();
    this._txDepth = 0;
    this._checkTransactionDepth(null, 'commit');    // 不变量：成功路径结束后深度也必须归 0
    return ret;
  }

  /**
   * 不变量检查（Lead P0 修复要求）：事务结束后后端 `_txDepth` 必须归 0。
   * 之前 sqlite 后端残留一个同名裸 rollback() 覆盖了深度感知版 ⇒ 回滚后深度永久=1，
   * 之后所有事务静默退化为 autocommit（回滚空转 + 性能回退 30×）。这里把该缺陷变成显式失败：
   *   · 成功路径：直接抛错（不要静默带病运行）；
   *   · 异常路径：挂到原始异常上（e.txDepthLeak），不覆盖真正的业务错误。
   */
  _checkTransactionDepth(origErr, label) {
    const depth = typeof this.be.transactionDepth === 'function' ? this.be.transactionDepth() : 0;
    if (depth === 0) return;
    const msg = `事务深度泄漏：${label} 后 transactionDepth=${depth}（应为 0）`;
    if (origErr) {
      try { origErr.txDepthLeak = msg; } catch { /* 冻结对象等极端情况忽略 */ }
      return;
    }
    throw new MemError('TX_DEPTH_LEAK', msg, { label, depth });
  }

  transactionDepth() { return this._txDepth; }

  /** setClock(null)=恢复真实时钟；setClock(ms)=固定到某时刻；setClock(fn)=自定义时钟 */
  setClock(v) {
    if (v == null) { this._nowFn = Date.now; return this; }
    if (typeof v === 'number' && Number.isFinite(v)) { const base = v; this._nowFn = () => base; return this; }
    if (typeof v === 'function') { this._nowFn = v; return this; }
    throw new MemError('BAD_CLOCK', `setClock 只接受 null / 毫秒时间戳 / 函数，收到 ${typeof v}`);
  }

  advanceClock(ms) {
    const d = Number(ms);
    if (!Number.isFinite(d)) throw new MemError('BAD_CLOCK', `advanceClock 需要毫秒数，收到 ${ms}`);
    this.setClock(this.nowMs() + d);
    return this;
  }

  getConfig() {
    return { governance: { ...this.govCfg }, lifecycle: { ...this.lifeCfg } };
  }

  configureLifecycle(patch = {}) { this.lifeCfg = { ...this.lifeCfg, ...patch }; return { ...this.lifeCfg }; }
  configureGovernance(patch = {}) { this.govCfg = { ...this.govCfg, ...patch }; return { ...this.govCfg }; }

  // ======================================================================
  // 1. 内部工具（审计 / meta / trigger 生效态）
  // ======================================================================
  _audit(op, patch = {}) {
    this.be.appendAudit({
      at: patch.at != null ? patch.at : this.nowMs(),
      op,
      topicId: patch.topicId || null,
      sentenceId: patch.sentenceId || null,
      oldSha: patch.oldSha || null,
      newSha: patch.newSha || null,
      oldText: patch.oldText == null ? null : patch.oldText,
      newText: patch.newText == null ? null : patch.newText,
      actor: patch.actor || null,
      detail: patch.detail || null,
    });
  }

  _metaGet(k) { return typeof this.be.getMeta === 'function' ? this.be.getMeta(k) : null; }
  _metaSet(k, v) { if (typeof this.be.setMeta === 'function') this.be.setMeta(k, String(v)); }
  _jsonMeta(k, dflt) {
    const raw = this._metaGet(k);
    if (raw == null || raw === '') return dflt;
    try { return JSON.parse(raw); } catch { return dflt; }
  }
  _setJsonMeta(k, val) { this._metaSet(k, JSON.stringify(val)); }

  _stateSince(topic) {
    const raw = this._metaGet('state.since:' + topic.id);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) return n;
    return stateSinceOf(topic);
  }

  _hitCount(topicId) {
    const raw = this._metaGet('hits:' + topicId);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  _retiredRecord(topicId) { return this._jsonMeta('triggers.retired:' + topicId, []); }
  _retiredNorms(topicId) { return this._retiredRecord(topicId).map(normalizeName).filter(Boolean); }

  /** 生效中的 triggers（已 retired 的不算；冲突判定、注入选择、检索加权都只看这份） */
  activeTriggersOf(topic) {
    if (!topic) return [];
    const retired = new Set(this._retiredNorms(topic.id));
    return (topic.triggers || []).filter((x) => {
      const n = normalizeName(x);
      return n && !retired.has(n);
    });
  }

  retiredTriggersOf(topicId) {
    const t = this.be.getTopicById(topicId);
    if (!t) return [];
    const retired = new Set(this._retiredNorms(topicId));
    return (t.triggers || []).filter((x) => retired.has(normalizeName(x)));
  }

  _insertTopic({ id, name, norm, aliases = [], triggers = [], state = 'active', createdAt, updatedAt, stateSince }) {
    this.be.insertTopic({
      id, name, norm, aliases, triggers, state,
      createdAt, updatedAt: updatedAt == null ? createdAt : updatedAt, writeCount: 0,
    });
    this._metaSet('state.since:' + id, String(stateSince == null ? createdAt : stateSince));
    this._metaSet('hits:' + id, '0');
  }

  // ---- 自动转正计数与"导入豁免"标记（Lead 2026-10-29 裁决规则 4）----
  // 为什么拆成两个计数：
  //   writeCount    = 真实写入次数（审计/面板用，谁都加）
  //   promote.writes= **推动转正的写入次数**：只有 lead/user 的写入才加；导入(seed)主题上
  //                   plugin/dream 的写入一概不加，因此"导入多少句都不会自己升格"。
  // 为什么用 meta 而不是加字段：后端 schema 冻结（不改 backend-*.mjs），meta 两后端都有。
  _noAutoPromote(topicId) { return this._metaGet('noAutoPromote:' + topicId) === '1'; }

  _promoteWrites(topic) {
    if (!topic) return 0;
    const raw = this._metaGet('promote.writes:' + topic.id);
    if (raw != null && raw !== '') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    // 兼容阶段3 之前建的主题（没有该 meta）：未被豁免时按真实写入次数算
    return this._noAutoPromote(topic.id) ? 0 : Number(topic.writeCount || 0);
  }

  _bumpPromoteWrites(topicId, delta = 1) {
    const t = this.be.getTopicById(topicId);
    if (!t) return 0;
    const next = this._promoteWrites(t) + delta;
    this._metaSet('promote.writes:' + topicId, String(next));
    return next;
  }

  /** 是否只有"人工身份"的写入才推动转正 —— lead/user（runtime 是内部等价 lead 的遗留身份） */
  _isHumanWrite(actor) { return actor === 'lead' || actor === 'user' || actor === 'runtime'; }

  /** 清除导入豁免标记（lead/user 处置转正/并入时自动调用；也可显式调用） */
  clearSeedExemption(topicRef, { actor = 'runtime', claimedActor, actualActor, reason = 'manual' } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'clearSeedExemption', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能清除导入豁免标记`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const flagged = this._noAutoPromote(t.id);
    if (!flagged) {
      return { ok: true, id: t.id, cleared: false, reason: 'not-flagged', noAutoPromote: false, promoteWrites: this._promoteWrites(t), writeCount: t.writeCount || 0 };
    }
    this._metaSet('noAutoPromote:' + t.id, '0');
    this._audit('topic.seed.exemption.cleared', {
      topicId: t.id, actor: ident.actor,
      detail: { reason, from: 'noAutoPromote=1', to: 'noAutoPromote=0' },
    });
    const t2 = this.be.getTopicById(t.id);
    return { ok: true, id: t.id, cleared: true, reason, noAutoPromote: false, promoteWrites: this._promoteWrites(t2), writeCount: t2.writeCount || 0 };
  }

  /** 是否导入(seed)来源 —— 裁决A：needs_review 封顶只算非 seed 条目 */
  _isSeedTopic(topicId) { return this._metaGet('seed.source:' + topicId) === '1'; }

  /** 查导入豁免现状（迁移器/面板/测试用） */
  seedExemptionOf(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    return {
      id: t.id,
      state: t.state,
      noAutoPromote: this._noAutoPromote(t.id),
      promoteWrites: this._promoteWrites(t),
      writeCount: t.writeCount || 0,
      seedSource: this._isSeedTopic(t.id),
    };
  }

  /** 冲突扫描范围：归档主题不参与（它只在原文检索里可见） */
  _conflictTopics() {
    return this.be.listTopics()
      .filter((t) => t.state !== 'archived')
      .map((t) => ({ id: t.id, name: t.name, triggers: this.activeTriggersOf(t) }));
  }

  _recordTriggerConflicts(topicId, actor, at) {
    const conflicts = findTriggerConflicts(this._conflictTopics())
      .filter((c) => c.topics.some((x) => x.id === topicId));
    for (const c of conflicts) {
      this._audit('trigger.conflict', { at, topicId, actor, newText: c.trigger, detail: c });
    }
    return conflicts;
  }

  _hasConflict(topicId) {
    const t = this.be.getTopicById(topicId);
    if (!t) return false;
    if (t.state === 'needs_review') return true;
    return findTriggerConflicts(this._conflictTopics()).some((c) => c.topics.some((x) => x.id === topicId));
  }

  // ======================================================================
  // 2. 主题清单（决策 16：dream 要能"一屏看全"）
  // ======================================================================
  topics() {
    const at = this.nowMs();
    const rows0 = this.be.listTopics();
    // [2026-10-29 P0 修复] 泛化 trigger（覆盖率 > genericTriggerMaxTopics）：保留存储，
    //   但在判定/检索加权里忽略；这里一次性算覆盖率，避免每个主题重复计算。
    const g = genericTriggersOf(
      rows0.filter((t) => t.state !== 'archived').map((t) => ({ id: t.id, triggers: this.activeTriggersOf(t) })),
      this.govCfg,
    );
    const mi = this._mergeViewIndex();   // [task-13/L2] 视图索引一次算好，供每行标注/有效口径使用
    return rows0.map((t) => {
      const rows = this._liveSentences(t.id);
      const physicalSentences = rows.length;
      const physicalChars = rows.reduce((a, s) => a + (s.chars || 0), 0);
      const since = this._stateSince(t);
      const active = this.activeTriggersOf(t);
      const genNames = active.filter((x) => g.norms.has(normalizeName(x)));
      // [task-13/L2] 有效口径统一：sentences/chars 返回**有效值**（视图优先）——
      //   主主题 = 保留句数、明细子主题 = 其余句数、被合并的源主题 = 0（其内容已在视图里）。
      //   面板/导出/stats 都直接求和 topics().sentences，这样"合并后总数不变"自动成立。
      //   物理句数保留在 physicalSentences/physicalChars（undo 复原、审计核对用）。
      const view = mi.byTopic.get(t.id) || null;             // {role, rec}
      const mergedInto = mi.sources.get(t.id) || null;       // 源主题 → 主主题 id
      const role = view ? view.role : null;
      const refs = view ? (role === 'main' ? (view.rec.keep || []) : (view.rec.child || [])) : [];
      let sentences = physicalSentences;
      let chars = physicalChars;
      if (view) {
        sentences = refs.length;
        chars = refs.reduce((a, r) => a + (r.chars || 0), 0);
      } else if (mergedInto) {
        sentences = 0;
        chars = 0;
      }
      return {
        ...t,
        sentences,
        chars,
        physicalSentences,
        physicalChars,
        activeTriggers: active,
        // 泛化 trigger 标注：存储不变（仍在 activeTriggers 里），这两个字段供 memory_topics/检索层区分
        genericTriggers: genNames,
        effectiveTriggers: active.filter((x) => !g.norms.has(normalizeName(x))),
        genericTriggerMaxTopics: g.maxTopics,
        parentId: this._metaGet('parent:' + t.id) || null,
        mergedInto,
        mergeId: view ? view.rec.mergeId : (mi.sourceMerge.get(t.id) || null),
        mergeRole: role,
        viewSentences: view ? sentences : 0,
        retiredTriggers: this.retiredTriggersOf(t.id),
        stateSince: since,
        daysInState: daysBetween(since, at),
        hitCount: this._hitCount(t.id),
        noAutoPromote: this._noAutoPromote(t.id),
        promoteWrites: this._promoteWrites(t),
      };
    });
  }

  /** task-41：已删除句索引（物理行保留以守住历史 sha；readTopic/topics/计数一律视作不存在） */
  _deletedEntries() {
    const raw = this._jsonMeta('deleted.index', []);
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * task-45 墓碑语义修正（两个集合分工）：
   *   · deleted.index 的 **sentenceId**：行级墓碑 ⇒ 只隐藏"这一行"，不会误伤其他主题里的同文副本（读路径用它）；
   *   · deleted.sha:<sha>（审计 oldSha/历史哈希）：**全局防复活**（import 的 skippedHistoricSha 用），不参与读过滤。
   * 兼容旧数据：若某条 index 记录没有 sentenceId（早期写法），按 sha + 该记录的 topicId 兜底过滤。
   */
  _deletedSentenceIds() {
    const ids = new Set();
    const legacyByTopic = new Map();
    for (const e of this._deletedEntries()) {
      if (e.sentenceId != null) ids.add(e.sentenceId);
      else if (e.sha) {
        if (!legacyByTopic.has(e.topicId)) legacyByTopic.set(e.topicId, new Set());
        legacyByTopic.get(e.topicId).add(e.sha);
      }
    }
    return { ids, legacyByTopic };
  }

  /** 取主题的"有效"句子（过滤已删除 tombstone；传入 rows 时按同样规则过滤） */
  _liveSentences(topicId, rows) {
    const base = Array.isArray(rows) ? rows : (this.be.listSentences(topicId) || []);
    const { ids, legacyByTopic } = this._deletedSentenceIds();
    const legacy = legacyByTopic.get(topicId);
    if (!ids.size && !legacy) return base;
    return base.filter((s) => !ids.has(s.id) && !(legacy && legacy.has(s.sha)));
  }

  /** 合并视图索引（一次读 merge.index，供 topics()/exportMd()/effectiveTopics()/mergedSources() 共用） */
  _mergeViewIndex() {
    const ids = this._jsonMeta('merge.index', []);
    const byTopic = new Map();
    const sources = new Map();
    const sourceMerge = new Map();
    const records = [];
    for (const id of ids) {
      const rec = this._jsonMeta('merge.record:' + id, null);
      if (!rec || rec.undoneAt) continue;
      records.push(rec);
      byTopic.set(rec.mainId, { role: 'main', rec });
      if (rec.childId) byTopic.set(rec.childId, { role: 'child', rec });
      for (const s of rec.sources || []) { sources.set(s.id, rec.mainId); sourceMerge.set(s.id, rec.mergeId); }
    }
    return { byTopic, sources, sourceMerge, records };
  }

  // ======================================================================
  // 2b. 三级结构（task-18）：域(L1) / 项目线(L2) / 明细(L3)
  //   零 schema 变更：level 存 meta `level:<id>`；父子沿用 `parent:<childId>`。
  //   计数口径（用户拍板）：**主主题 = 域 + 项目线**（≈34 ≤60）；明细不计入主主题。
  // ======================================================================
  _levelMetaOf(topicId) {
    const v = this._metaGet('level:' + topicId);
    return (v === 'domain' || v === 'project' || v === 'detail') ? v : null;
  }

  /** 父链根（无父返回自身；成环返回 null） */
  _rootOf(topicId) {
    let cur = topicId; const seen = new Set();
    while (cur) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const p = this._mergeParentOf(cur);
      if (!p) return cur;
      cur = p;
    }
    return null;
  }

  /**
   * 单遍层级索引（task-24 性能修复，topicCounts/treeOf/verify 共用）：
   *   一次 listTopics + 每行一次 parent/level meta get ⇒ 内存 Map，
   *   之后 level 推导 O(n)，**循环里绝不再调 be.listTopics()**。
   */
  _buildLevelIndex(rowsArg) {
    const rows = Array.isArray(rowsArg) ? rowsArg : this.be.listTopics();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parentOf = new Map();
    const explicit = new Map();
    const children = new Map();
    for (const r of rows) {
      const p = this._metaGet('parent:' + r.id);
      if (p) {
        parentOf.set(r.id, p);
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(r.id);
      }
      const lv = this._metaGet('level:' + r.id);
      if (lv === 'domain' || lv === 'project' || lv === 'detail') explicit.set(r.id, lv);
    }
    const levels = new Map();
    const resolve = (id, chain) => {
      if (levels.has(id)) return levels.get(id);
      const ex = explicit.get(id);
      if (ex) { levels.set(id, ex); return ex; }
      const seen = chain || new Set();
      if (seen.has(id)) { levels.set(id, 'detail'); return 'detail'; }
      seen.add(id);
      let lv;
      const p = parentOf.get(id);
      if (p) {
        const pl = resolve(p, seen);
        lv = pl === 'domain' ? 'project' : 'detail';
      } else {
        lv = (children.get(id) || []).length > 0 ? 'project' : 'detail';
      }
      levels.set(id, lv);
      seen.delete(id);
      return lv;
    };
    for (const r of rows) resolve(r.id);
    return { rows, byId, parentOf, children, explicit, levels, levelOf: (id) => (levels.has(id) ? levels.get(id) : resolve(id)) };
  }

  /** 删除 meta 键（tree-apply undo 清 level/parent 用；后端不支持删除时退化为空串，语义上等同"未设置"） */
  _metaDelete(key) {
    const be = this.be;
    if (typeof be.deleteMeta === 'function') { be.deleteMeta(key); return true; }
    be.setMeta(key, '');
    return false;
  }

  /** 面板用：一次扫描返回 id→level 的 Map（避免逐行 levelOf 造成的重复扫描） */
  levelMap() {
    return new Map(this._buildLevelIndex().levels);
  }

  /**
   * level 推导（task-18 口径）：显式 meta 优先；否则
   *   有父且父是域 ⇒ project；有子主题 ⇒ project；有父 ⇒ detail；无父无子 ⇒ detail。
   */
  levelOf(topicRef, _seen) {
    const t = (topicRef && typeof topicRef === 'object' && topicRef.id) ? topicRef : this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    const ex = this._levelMetaOf(t.id);
    if (ex) return ex;
    const seen = _seen || new Set();
    if (seen.has(t.id)) return 'detail';
    seen.add(t.id);
    const parentId = this._mergeParentOf(t.id);
    if (parentId) {
      const p = this.be.getTopicById(parentId);
      const pl = p ? this.levelOf(p, seen) : 'detail';
      return pl === 'domain' ? 'project' : 'detail';
    }
    const hasChild = this.be.listTopics().some((x) => this._mergeParentOf(x.id) === t.id);
    return hasChild ? 'project' : 'detail';
  }

  /** 显式设置层级（只有 user/lead/runtime；dream/plugin 只能提案） */
  setLevel(topicRef, level, { actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'setLevel', topic: String(topicRef), level, claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能改层级（只有 user/lead/runtime）`, { actor: ident.actor, action: 'setLevel' });
    }
    if (!['domain', 'project', 'detail'].includes(level)) {
      throw new MemError('BAD_LEVEL', `level 只支持 domain|project|detail，收到 ${String(level)}`, { allowed: ['domain', 'project', 'detail'], got: level });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    const at = this.nowMs();
    const before = this._levelMetaOf(t.id);
    this._metaSet('level:' + t.id, level);
    this._audit('topic.level', {
      at, topicId: t.id, actor: ident.actor, oldText: before, newText: level,
      detail: { from: before, to: level, explicit: true, derivedBefore: this.levelOf(t) },
    });
    return { ok: true, id: t.id, level, before, derivedAfter: this.levelOf(t) };
  }

  /**
   * 建 L1 域（根容器，state=active）。
   * 权限：只有 user/lead/runtime（plugin 的 seed 通道、dream 都不能建域）。
   * 同名域复用；同名但不是域 ⇒ NAME_TAKEN。
   */
  createDomain(name, { triggers = [], aliases = [], actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'createDomain', name: String(name), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能建域（plugin/seed 与 dream 只能导入/提案）`, { actor: ident.actor, action: 'createDomain' });
    }
    const raw = String(name == null ? '' : name).trim();
    const norm = normalizeName(raw);
    if (!norm) throw new MemError('EMPTY_NAME', 'createDomain 需要非空 name');
    const at = this.nowMs();
    const existing = this.be.getTopicByNorm(norm);
    if (existing) {
      if (this.levelOf(existing) !== 'domain') {
        throw new MemError('NAME_TAKEN', `同名主题 ${existing.id} 已存在且不是域`, { id: existing.id, name: existing.name, level: this.levelOf(existing) });
      }
      return { ok: true, id: existing.id, name: existing.name, level: 'domain', reused: true };
    }
    const id = this.be.nextTopicId();
    this._insertTopic({ id, name: raw, norm, aliases: Array.isArray(aliases) ? aliases.slice() : [], triggers: Array.isArray(triggers) ? triggers.slice() : [], state: 'active', createdAt: at, updatedAt: at, stateSince: at });
    this._metaSet('level:' + id, 'domain');
    this._audit('topic.domain', { at, topicId: id, actor: ident.actor, newText: raw, detail: { level: 'domain', triggers, reused: false } });
    return { ok: true, id, name: raw, level: 'domain', reused: false };
  }

  /** 域树视图（只读）：{domain, projects:[{topic, details:[...]}], counts} */
  treeOf(domainRef) {
    const d = this.be.getTopicById(this.resolveTopic(domainRef).id);
    if (!d) throw new MemError('NOT_FOUND', '主题不存在: ' + String(domainRef));
    const raw = this.be.listTopics();
    const idx = this._buildLevelIndex(raw);   // 单遍：parent/level 索引 + children 一次建好（task-24）
    const lvl = idx.levelOf(d.id);
    if (lvl !== 'domain') throw new MemError('NOT_DOMAIN', `主题 ${d.id} 不是域（level=${lvl}）`, { id: d.id, level: lvl });
    const mi = this._mergeViewIndex();
    const byId = new Map(raw.map((t) => [t.id, t]));
    const kidsOf = idx.children;
    // 树视图只展示"有效"节点：archived（含已合并源主题）不出现在树里，由面板单列"已合并/已归档"
    const visible = new Map(raw.filter((t) => t.state !== 'archived' && !mi.sources.has(t.id)).map((t) => [t.id, t]));
    const kids = (id) => (kidsOf.get(id) || []).filter((x) => visible.has(x)).sort();
    // 只对**可见节点**取句数（一次 listSentences/节点），不再整库 topics()（task-24：treeOf 单遍且轻）
    const node = (id) => {
      const row = byId.get(id) || { id, name: id, state: null };
      const phys = this._liveSentences(id).length;
      const view = mi.byTopic.get(id);
      let sentences = phys;
      if (view) sentences = view.role === 'main' ? (view.rec.keep || []).length : (view.rec.child || []).length;
      else if (mi.sources.has(id)) sentences = 0;
      return {
        id: row.id, name: row.name, state: row.state, level: idx.levelOf(id),
        parentId: idx.parentOf.get(id) || null, mergedInto: mi.sourceMerge.get(id) || null,
        sentences, physicalSentences: phys,
      };
    };
    const projects = [];
    const directDetails = [];
    for (const kid of kids(d.id)) {
      if (idx.levelOf(kid) === 'project') projects.push({ topic: node(kid), details: kids(kid).map((did) => node(did)) });
      else directDetails.push({ topic: node(kid) });   // 直挂域的单成员明细（原 single 族）
    }
    const projectDetails = projects.reduce((a, p) => a + p.details.length, 0);
    return {
      domain: node(d.id),
      projects,
      directDetails,
      counts: { projects: projects.length, directDetails: directDetails.length, details: projectDetails + directDetails.length },
    };
  }

  /**
   * 层级不变量（verify 会调用）：只对**显式 level** 的节点做严格校验（兼容历史扁平主题），
   * 另对任何父子关系做环检测与跨域校验。
   */
  assertLevelInvariants() {
    // task-24：单遍索引（不再逐行 levelOf/rootOf 重复扫描）
    const idx = this._buildLevelIndex();
    const rootOf = (id) => {
      let cur = id; const seen = new Set();
      while (cur) {
        if (seen.has(cur)) return null;
        seen.add(cur);
        const p = idx.parentOf.get(cur);
        if (!p) return cur;
        cur = p;
      }
      return null;
    };
    const violations = [];
    for (const t of idx.rows) {
      const ex = idx.explicit.get(t.id) || null;
      const p = idx.parentOf.get(t.id) || null;
      const root = rootOf(t.id);
      if (root == null) { violations.push({ code: 'PARENT_CYCLE', topicId: t.id }); continue; }
      if (ex === 'domain' && p) { violations.push({ code: 'DOMAIN_HAS_PARENT', topicId: t.id, parentId: p }); }
      if (ex === 'project') {
        if (!p) violations.push({ code: 'PROJECT_WITHOUT_PARENT', topicId: t.id });
        else {
          const pl = idx.levels.get(p) || null;
          if (pl !== 'domain') violations.push({ code: 'BAD_PARENT_LEVEL', topicId: t.id, parentId: p, parentLevel: pl, expected: 'domain' });
        }
      }
      if (ex === 'detail' && p) {
        const pl = idx.levels.get(p) || null;
        // [task-20] 单主题族=明细直接挂域；多成员族=明细挂项目线；series 组内可再挂明细
        if (pl !== 'project' && pl !== 'detail' && pl !== 'domain') violations.push({ code: 'BAD_PARENT_LEVEL', topicId: t.id, parentId: p, parentLevel: pl, expected: 'project|domain' });
      }
      if (p) {
        const rp = rootOf(p);
        if (rp && rp !== root) violations.push({ code: 'CROSS_DOMAIN_PARENT', topicId: t.id, parentId: p, rootA: root, rootB: rp });
      }
    }
    return { ok: violations.length === 0, violations, checked: idx.rows.length };
  }

  /**
   * 有效主题（对外"主题数"口径）：**非 archived 且不是明细子主题**。
   * 三级结构下等于"主主题数"（域+项目线）；历史扁平主题（无父）也计入（兼容旧行为）。
   */
  effectiveTopics() {
    return this.topics().filter((t) => t.state !== 'archived' && !t.parentId);
  }

  /** 有效主题的另一种口径（非 archived，含明细子主题）：面板要区分"主主题/明细"时用 */
  nonArchivedTopics() {
    return this.topics().filter((t) => t.state !== 'archived');
  }

  /** 被合并掉的源主题（带 active merge.view 记录）：面板显示"已合并 N 条"用 */
  mergedSources() {
    return this.topics().filter((t) => !!t.mergedInto);
  }

  /**
   * 主题口径汇总（面板/报告唯一真源）。
   * 三级结构口径：main = {domains, projects, total=domains+projects}（≤60 的目标量就是 main.total）；
   *   details 为 L3 明细（不计入主主题）；archived/mergedSources 单独列。
   * 兼容字段：effective（非 archived 且无父，历史口径）、mergeViews/detailViews（合并视图数量）。
   */
  /** 句数快照（task-24 性能）：优先用后端已有的批量能力，取不到则逐主题回退 */
  _sentenceCountMap() {
    const be = this.be;
    try {
      if (be && be.db && typeof be.db.prepare === 'function') {
        const rs = be.db.prepare('SELECT topic_id AS tid, COUNT(*) AS n FROM sentences GROUP BY topic_id').all();
        const m = new Map();
        for (const r of rs) m.set(r.tid, Number(r.n));
        return m;
      }
      if (be && be.sentences instanceof Map) {
        const m = new Map();
        for (const s of be.sentences.values()) m.set(s.topicId, (m.get(s.topicId) || 0) + 1);
        return m;
      }
    } catch { /* 回退到逐主题计数 */ }
    return null;
  }

  topicCounts() {
    // task-24：单遍扫描（rows + 一次 meta 索引），循环里不再调用 levelOf / be.listTopics()
    const rows = this.be.listTopics();
    const idx = this._buildLevelIndex(rows);
    const mi = this._mergeViewIndex();
    const mergedIds = mi.sources;          // Set<topicId>：被合并掉的源主题
    const sentCounts = this._sentenceCountMap();
    const delByTopic = new Map();
    for (const e of this._deletedEntries()) delByTopic.set(e.topicId, (delByTopic.get(e.topicId) || 0) + 1);
    const physOf = (id) => Math.max(0, (sentCounts ? (sentCounts.get(id) || 0) : (this.be.listSentences(id) || []).length) - (delByTopic.get(id) || 0));
    let physicalSentences = 0;
    for (const r of rows) physicalSentences += physOf(r.id);
    let domains = 0; let projects = 0; let details = 0; let sentences = 0;
    let archived = 0; let merged = 0; let mergeViews = 0; let detailViews = 0;
    let active = 0; let draft = 0; let needsReview = 0; let dormant = 0;
    for (const r of rows) {
      if (r.state === 'archived') archived += 1;
      if (r.state === 'active') active += 1;
      else if (r.state === 'draft') draft += 1;
      else if (r.state === 'needs_review') needsReview += 1;
      else if (r.state === 'dormant') dormant += 1;
      if (mergedIds.has(r.id)) { merged += 1; continue; }   // 已合并源主题（通常 archived）：不计主主题/明细/句数
      const view = mi.byTopic.get(r.id);
      if (view) {
        if (view.role === 'main') { mergeViews += 1; sentences += (view.rec.keep || []).length; }
        else { detailViews += 1; sentences += (view.rec.child || []).length; }
      } else sentences += physOf(r.id);
      if (r.state === 'archived') continue;
      const lv = idx.levels.get(r.id);
      const p = idx.parentOf.get(r.id);
      if (lv === 'domain') domains += 1;
      else if (lv === 'project') projects += 1;
      // details 只算"已挂到结构里的明细"（有父，或显式 level=detail）；未归类的扁平主题不计入 L3。
      else if (lv === 'detail' && (p || idx.explicit.get(r.id) === 'detail')) details += 1;
    }
    return {
      total: rows.length,                 // 物理主题行数（含 archived）
      effective: rows.filter((r) => r.state !== 'archived' && !idx.parentOf.get(r.id)).length,  // 历史口径（无父非归档）
      nonArchived: rows.length - archived,
      // 三级结构主口径：主主题 = L1 域 + L2 项目线（L3 明细不计入）
      main: { domains, projects, total: domains + projects },
      details,
      archived,
      merged,
      mergedSources: merged,
      mergeViews,
      detailViews,
      active,
      draft,
      needsReview,
      dormant,
      sentences,                          // 有效句数（合并源 0 / 视图按 keep|child 计）
      physicalSentences,
    };
  }

  /**
   * 泛化 trigger 清单（数据驱动区分度，Lead 2026-10-29 P0 修复）：
   *   覆盖率（多少主题挂了这个 trigger）> 阈值 ⇒ generic。
   * 语义：**保留存储**（只增不删不变），但在"禁建区重合计数 / 检索加权 / 冲突并列"里忽略。
   */
  genericTriggers() {
    const at = this.nowMs();
    const tps = this._conflictTopics().map((t) => ({ id: t.id, triggers: t.triggers }));
    const g = genericTriggersOf(tps, this.govCfg);
    return {
      at,
      threshold: g.maxTopics,
      totalTriggers: g.coverage.size,
      totalMounts: [...g.coverage.values()].reduce((a, e) => a + e.coverage, 0),
      generic: g.list.map((e) => ({ trigger: e.trigger, norm: e.norm, coverage: e.coverage, topicCount: e.topics.length, topics: e.topics.slice(0, 10) })),
    };
  }

  /** 单个 trigger 的覆盖率/是否泛化（检索层判断是否参与加权） */
  triggerInfo(trigger) {
    const norm = normalizeName(trigger);
    const tps = this._conflictTopics();
    const cov = triggerCoverage(tps);
    const e = cov.get(norm) || null;
    const g = genericTriggersOf(tps.map((t) => ({ id: t.id, triggers: t.triggers })), this.govCfg);
    return {
      trigger: String(trigger),
      norm,
      coverage: e ? e.coverage : 0,
      threshold: g.maxTopics,
      generic: !!(e && g.norms.has(norm)),
      topics: e ? e.topics.slice(0, 10) : [],
    };
  }

  // ======================================================================
  // 3. 解析：ID → 精确 → 别名 → 模糊（新建走治理门控）
  // ======================================================================
  resolveTopic(name, opts = {}) {
    const raw = String(name == null ? '' : name).trim();
    if (!raw) throw new MemError('EMPTY_NAME', '主题名不能为空');

    if (/^T-\d{4,}$/.test(raw)) {
      const t = this.be.getTopicById(raw);
      if (!t) throw new MemError('NOT_FOUND', '没有主题 ' + raw);
      return { id: t.id, name: t.name, how: 'id', state: t.state };
    }

    const norm = normalizeName(raw);
    if (!norm) throw new MemError('EMPTY_NAME', '主题名归一化后为空');

    const exact = this.be.getTopicByNorm(norm);
    if (exact) return { id: exact.id, name: exact.name, how: 'exact', state: exact.state };

    const all = this.be.listTopics();
    const byAlias = all.filter((t) => (t.aliases || []).some((a) => normalizeName(a) === norm));
    if (byAlias.length === 1) return { id: byAlias[0].id, name: byAlias[0].name, how: 'alias', state: byAlias[0].state };
    if (byAlias.length > 1) {
      throw new MemError('AMBIGUOUS', `「${raw}」命中 ${byAlias.length} 个别名`, byAlias.map((t) => ({ id: t.id, name: t.name })));
    }

    const fuzzy = [];
    for (const t of all) {
      const d = levenshtein(norm, t.norm);
      const contains = norm.length >= 3 && (t.norm.includes(norm) || norm.includes(t.norm));
      if (d <= 2 || contains) fuzzy.push({ id: t.id, name: t.name, dist: d, why: contains && d > 2 ? 'contains' : 'fuzzy' });
    }
    if (fuzzy.length === 1) return { id: fuzzy[0].id, name: fuzzy[0].name, how: fuzzy[0].why, state: (this.be.getTopicById(fuzzy[0].id) || {}).state };
    if (fuzzy.length > 1) {
      throw new MemError('AMBIGUOUS', `「${raw}」与 ${fuzzy.length} 个已有主题相似，请明确要写到哪一个`,
        fuzzy.map((x) => ({ id: x.id, name: x.name, dist: x.dist })));
    }

    if (!opts.create) {
      throw new MemError('NOT_FOUND', `没有主题「${raw}」`, all.slice(0, 8).map((t) => ({ id: t.id, name: t.name })));
    }
    // 新建：一律走治理门控（禁建区/灰区/安全区 + 权限矩阵）
    return this.createTopic({
      name: raw,
      actor: opts.actor,
      claimedActor: opts.claimedActor,
      actualActor: opts.actualActor,
      state: opts.state,
      confirm: opts.confirm,
      aliases: opts.aliases,
      triggers: opts.triggers,
    });
  }

  // ======================================================================
  // 4. 建主题：阈值分档（决策 14）+ 权限矩阵（决策 17）
  // ======================================================================
  createTopic({ name, aliases = [], triggers = [], actor, claimedActor, actualActor, state = null, confirm = false } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    const eff = ident.actor;
    const at = this.nowMs();
    const raw = String(name == null ? '' : name).trim();
    if (!raw) throw new MemError('EMPTY_NAME', '主题名不能为空');
    const norm = normalizeName(raw);
    if (!norm) throw new MemError('EMPTY_NAME', '主题名归一化后为空');

    // --- 4.1 权限：未知身份直接拒（不信任自报，决策 17）
    if (!isKnownActor(eff)) {
      this._audit('perm.denied', { at, actor: eff, detail: { action: 'create', reason: 'unknown-actor', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `未知身份「${eff}」没有建主题权限`, { actor: eff, claimed: ident.claimed });
    }
    const allowed = createStatesFor(eff);
    const requested = state == null ? null : String(state);
    if (requested && !STATES.includes(requested)) {
      throw new MemError('BAD_STATE', `未知状态「${requested}」，合法状态：${STATES.join('/')}`, { allowed: STATES, requested });
    }
    // 未指定状态时：dream 默认 draft（它不能定音），其余默认 active
    let desired = requested || (allowed.includes('active') ? 'active' : 'draft');
    if (!allowed.includes(desired)) {
      this._audit('perm.denied', {
        at, actor: eff,
        detail: { action: 'create', state: desired, allowedStates: allowed, claimed: ident.claimed, actual: ident.actual, impersonated: ident.impersonated },
      });
      throw new MemError('PERM_DENIED',
        `身份「${eff}」不能直接建 ${desired} 主题（可建：${allowed.join('/')}）`,
        { actor: eff, requested: desired, allowedStates: allowed, impersonated: ident.impersonated });
    }

    // --- 4.2 已存在（归一化精确命中）⇒ 直接返回，不新建
    const exist = this.be.getTopicByNorm(norm);
    if (exist) return { id: exist.id, name: exist.name, how: 'exact', state: exist.state };

    // --- 4.3 分档
    const existing = this.be.listTopics().map((t) => ({
      id: t.id, name: t.name, norm: t.norm, triggers: this.activeTriggersOf(t),
    }));
    const grade = gradeCreate({ norm, triggers, existing, cfg: this.govCfg });
    const baseDetail = {
      zone: grade.zone, name: raw, triggers, aliases,
      claimed: ident.claimed, actual: ident.actual, impersonated: ident.impersonated,
    };

    if (grade.zone === 'forbidden') {
      const cands = grade.forbidden.map(candidateView);
      this._audit('create.reject', {
        at, actor: eff,
        detail: { ...baseDetail, reason: grade.reason, reasonText: grade.reasonText, candidates: cands },
      });
      throw new MemError('CREATE_FORBIDDEN',
        `「${raw}」落入禁建区（${grade.reasonText}）：只能并入候选主题或给候选加别名，不能新建`,
        { zone: 'forbidden', reason: grade.reason, reasonText: grade.reasonText, candidates: cands });
    }

    if (grade.zone === 'gray' && !confirm) {
      const cands = grade.gray.map(candidateView);
      this._audit('create.needs_confirm', { at, actor: eff, detail: { ...baseDetail, candidates: cands } });
      return {
        id: null, name: raw, how: 'needs_confirm', requiresConfirm: true, zone: 'gray',
        suggestedState: 'draft', candidates: cands,
      };
    }

    let zone = grade.zone;
    if (grade.zone === 'gray') {
      // 灰区即使请求 active，也只能落 draft（决策 14：二次确认 + 先 draft）
      if (desired !== 'draft') {
        if (!allowed.includes('draft')) {
          this._audit('perm.denied', { at, actor: eff, detail: { action: 'create', state: 'draft', reason: 'gray-zone', allowedStates: allowed } });
          throw new MemError('PERM_DENIED', `身份「${eff}」在灰区不能建 draft 主题`, { allowedStates: allowed });
        }
        desired = 'draft';
      }
    }

    // --- 4.4 落库
    const id = this.be.nextTopicId();
    this._insertTopic({ id, name: raw, norm, aliases, triggers, state: desired, createdAt: at, updatedAt: at, stateSince: at });
    this._audit('topic.create', {
      at, topicId: id, actor: eff, newText: raw,
      detail: { ...baseDetail, zone: grade.zone, state: desired, confirm: !!confirm },
    });
    // [2026-10-29 P0 修复·留痕] 本次请求里带了多少"泛化 trigger"（被忽略、但仍照原样存进主题）
    const genericOnCreate = grade.candidateGenericTriggers || [];
    if (genericOnCreate.length) {
      this._audit('trigger.generic.ignored', {
        at, topicId: id, actor: eff,
        newText: genericOnCreate.map((x) => x.trigger).join('|'),
        detail: { reason: 'generic-trigger-coverage', threshold: grade.genericTriggerMaxTopics, hits: genericOnCreate, effect: '不参与禁建区重合计数/检索加权，照常存储' },
      });
    }
    const conflicts = this._recordTriggerConflicts(id, eff, at);

    const res = {
      id, name: raw, how: 'created', state: desired, zone,
      requiresConfirm: grade.zone === 'gray',
      candidates: grade.zone === 'safe' ? [] : grade.candidates.map(candidateView),
      ignoredGenericTriggers: genericOnCreate,
      conflicts,
    };
    // 决策 17：lead/user 建主题要"本轮可见"（一行提示，可被一句话否决）
    if (can(eff, 'setState')) res.notice = `新建主题：${raw}（${id} · ${desired}）`;
    return res;
  }

  // ======================================================================
  // 4b. 导入口（迁移/播种）专用：store.seedTopic(...)
  // ======================================================================
  /**
   * 迁移器/导入器建主题的唯一通道（Lead 2026-10-29 裁决，规则 1/2/3/4/5）。
   *
   * 与 createTopic 的差别：
   *   · 一律落 draft（任何情况下不直建 active —— 导入不许静默升格）；
   *   · 命中禁建区（相似度≥0.90 / 编辑距离≤2 / 包含 / triggers 重合≥2）**仍然落库**（不丢内容），
   *     但必须同时进 needs_review（reason='seed-near-duplicate'），候选主题写进审计；
   *     不静默并库、不自动择一、不直接 active；
   *   · 灰区（0.70–0.90）落 draft 后同样进 needs_review（reason='seed-gray'）；
   *   · 打 noAutoPromote 豁免标记：随后的导入写入不计入"推动转正的写入次数"，
   *     只有 lead/user 的写入才计数；lead/user 显式转正或并入时自动清除标记。
   *
   * 权限：只有 actor='plugin'（迁移器/导入器的身份）可以调用；user/lead/dream/runtime 拿不到这条通道
   *       （模型侧若能用 seed，等于绕开禁建区，等于决策 14 失效）。
   *
   * @param {object} p
   * @param {string} p.name        主题名（必填）
   * @param {string[]} [p.aliases]
   * @param {string[]} [p.triggers]
   * @param {string|null} [p.src]  来源（文件名/相对路径），只进审计，便于回溯
   * @param {string} [p.actor]     默认 'plugin'
   * @returns {{ok:boolean, id:string|null, name:string, state:string, created:boolean, how:string,
   *            zone:'existing'|'safe'|'gray'|'forbidden', needsReview:boolean,
   *            reason:'seed-near-duplicate'|'seed-gray'|null, candidates:Array,
   *            demoted:object|null, conflicts:Array, noAutoPromote:boolean, src:string|null}}
   */
  seedTopic({ name, aliases = [], triggers = [], src = null, actor = 'plugin', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    const eff = ident.actor;
    const at = this.nowMs();
    const raw = String(name == null ? '' : name).trim();
    if (!raw) throw new MemError('EMPTY_NAME', '主题名不能为空');
    const norm = normalizeName(raw);
    if (!norm) throw new MemError('EMPTY_NAME', '主题名归一化后为空');

    // 权限：只有导入器身份可以走 seed（规则 1/5）
    if (!can(eff, 'seed')) {
      this._audit('perm.denied', {
        at, actor: eff,
        detail: {
          action: 'seedTopic',
          reason: isKnownActor(eff) ? 'actor-cannot-seed' : 'unknown-actor',
          claimed: ident.claimed,
          hint: '迁移/导入用 actor=plugin；其他身份请走 createTopic（禁建区/灰区有门控）',
        },
      });
      throw new MemError('PERM_DENIED',
        `身份「${eff}」不能用 seed 通道建主题（只有导入器身份 plugin 可以；其他身份请走 createTopic 门控）`,
        { actor: eff, action: 'seed' });
    }

    // 精确 / 别名命中 ⇒ 复用已有主题，不新建（迁移的幂等基础，不产生第二份）
    const exact = this.be.getTopicByNorm(norm);
    if (exact) {
      return {
        ok: true, id: exact.id, name: exact.name, state: exact.state, created: false, how: 'exact',
        zone: 'existing', needsReview: false, reason: null, candidates: [], demoted: null, conflicts: [],
        noAutoPromote: this._noAutoPromote(exact.id), src: src || null,
      };
    }
    const byAlias = this.be.listTopics().find((t) => (t.aliases || []).some((a) => normalizeName(a) === norm));
    if (byAlias) {
      return {
        ok: true, id: byAlias.id, name: byAlias.name, state: byAlias.state, created: false, how: 'alias',
        zone: 'existing', needsReview: false, reason: null, candidates: [], demoted: null, conflicts: [],
        noAutoPromote: this._noAutoPromote(byAlias.id), src: src || null,
      };
    }

    // 分档（只用于决定"要不要进 needs_review"，不再用来拒绝落库）
    const existing = this.be.listTopics().map((t) => ({
      id: t.id, name: t.name, norm: t.norm, triggers: this.activeTriggersOf(t),
    }));
    const grade = gradeCreate({ norm, triggers, existing, cfg: this.govCfg });
    const candidates = (grade.zone === 'forbidden' ? grade.forbidden : grade.zone === 'gray' ? grade.gray : [])
      .map(candidateView);

    // 落库：恒 draft（规则 1）
    const id = this.be.nextTopicId();
    this._insertTopic({ id, name: raw, norm, aliases, triggers, state: 'draft', createdAt: at, updatedAt: at, stateSince: at });
    this._metaSet('noAutoPromote:' + id, '1');    // 规则 4
    this._metaSet('promote.writes:' + id, '0');
    this._metaSet('seed.source:' + id, '1');      // 裁决A：识别"导入来源"，封顶时豁免
    this._metaSet('seed.at:' + id, String(at));
    this._audit('topic.seed', {
      at, topicId: id, actor: eff, newText: raw,
      detail: {
        zone: grade.zone,
        gate: 'seed',
        state: 'draft',
        noAutoPromote: true,
        reason: grade.reason || null,
        reasonText: grade.reasonText || null,
        candidates,
        aliases, triggers,
        src: src || null,
        claimed: ident.claimed,
        impersonated: ident.impersonated,
        note: '导入口：不拒建（不丢内容），但一律 draft；近重复/灰区进 needs_review，不静默并库',
      },
    });

    // 规则 2/3：近重复与灰区必须进 needs_review
    let needsReview = false;
    let reason = null;
    let demoted = null;
    // [2026-10-29 P0 修复·留痕] 泛化 trigger 不参与禁建区计数（所以近重复判定更准），但仍照常存储
    const genericOnSeed = grade.candidateGenericTriggers || [];
    if (genericOnSeed.length) {
      this._audit('trigger.generic.ignored', {
        at, topicId: id, actor: eff,
        newText: genericOnSeed.map((x) => x.trigger).join('|'),
        detail: { reason: 'generic-trigger-coverage', threshold: grade.genericTriggerMaxTopics, hits: genericOnSeed, effect: '不参与禁建区重合计数/检索加权，照常存储' },
      });
    }
    if (grade.zone === 'forbidden') { needsReview = true; reason = 'seed-near-duplicate'; }
    else if (grade.zone === 'gray') { needsReview = true; reason = 'seed-gray'; }
    if (needsReview) {
      const r = this._enterNeedsReviewInternal(id, { reason, actor: eff, at });
      demoted = r.demoted || null;
    }

    const conflicts = this._recordTriggerConflicts(id, eff, at);
    const row = this.be.getTopicById(id);
    return {
      ok: true, id, name: raw, state: row ? row.state : 'draft', created: true, how: 'seeded',
      zone: grade.zone, needsReview, reason, candidates, demoted, conflicts,
      ignoredGenericTriggers: genericOnSeed,
      noAutoPromote: this._noAutoPromote(id), seedSource: this._isSeedTopic(id), src: src || null,
    };
  }

  // ======================================================================
  // 5. 别名 / triggers（只增不删；删除走 retired 标记）
  // ======================================================================
  addAlias(topicRef, alias, { actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const norm = normalizeName(alias);
    if (!norm) return { added: false, id: t.id };
    if ((t.aliases || []).some((a) => normalizeName(a) === norm)) return { added: false, id: t.id };
    this.be.updateTopic(t.id, { aliases: [...(t.aliases || []), String(alias).trim()], updatedAt: this.nowMs() });
    this._audit('topic.alias', { topicId: t.id, newText: String(alias).trim(), actor: ident.actor });
    return { added: true, id: t.id };
  }

  /**
   * 追加 triggers（只增不删）。
   * 已 retired 的 trigger 不会被这条路径复活（需要显式 revive:true —— 决策 10 删除=废弃标记）。
   */
  addTriggers(topicRef, triggers = [], { actor = 'runtime', claimedActor, actualActor, revive = false } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'addTrigger')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'addTrigger', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能追加 triggers`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在');
    const retired = new Set(this._retiredNorms(t.id));
    const have = new Set((t.triggers || []).map(normalizeName));
    const add = [];
    const skippedRetired = [];
    const skippedDup = [];
    for (const raw of triggers) {
      const s = String(raw == null ? '' : raw).trim();
      const n = normalizeName(s);
      if (!n) continue;
      if (retired.has(n) && !revive) { skippedRetired.push(s); continue; }
      if (have.has(n) && !retired.has(n)) { skippedDup.push(s); continue; }
      have.add(n);
      add.push(s);
      if (revive && retired.has(n)) this._setJsonMeta('triggers.retired:' + t.id, this._retiredRecord(t.id).filter((x) => normalizeName(x) !== n));
    }
    const at = this.nowMs();
    if (add.length) {
      const merged = [...(t.triggers || []), ...add.filter((a) => !(t.triggers || []).some((x) => normalizeName(x) === normalizeName(a)))];
      this.be.updateTopic(t.id, { triggers: merged, updatedAt: at });
      this._audit('topic.triggers', { at, topicId: t.id, actor: ident.actor, newText: add.join('|'), detail: { added: add.length, skippedRetired, skippedDup } });
      // [2026-10-29 P0 修复·留痕] 新加的 trigger 若已是泛化词：照常存，但标注"不参与判定/加权"
      try {
        const g = this.genericTriggers();
        const genAdd = (g.generic || []).filter((e) => add.some((a) => normalizeName(a) === e.norm));
        if (genAdd.length) {
          this._audit('trigger.generic.ignored', {
            at, topicId: t.id, actor: ident.actor,
            newText: genAdd.map((e) => e.trigger).join('|'),
            detail: { reason: 'generic-trigger-coverage', threshold: g.threshold, hits: genAdd, effect: '不参与禁建区重合计数/检索加权，照常存储' },
          });
        }
      } catch (e) { /* 标注失败不影响追加 */ }
    }
    const conflicts = add.length ? this._recordTriggerConflicts(t.id, ident.actor, at) : [];
    return {
      added: add.length, id: t.id, conflicts, skippedRetired, skippedDup,
      triggers: this.activeTriggersOf(this.be.getTopicById(t.id)),
      retiredTriggers: this.retiredTriggersOf(t.id),
    };
  }

  /** 删除 trigger = 打 retired 标记（物理数组不动，决策 10"只增不删"） */
  retireTrigger(topicRef, trigger, { actor = 'runtime', claimedActor, actualActor, reason } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'retireTrigger')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'retireTrigger', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能删除 triggers（只能由用户/lead 打废弃标记）`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const n = normalizeName(trigger);
    if (!n) throw new MemError('EMPTY_NAME', 'trigger 不能为空');
    const hit = (t.triggers || []).find((x) => normalizeName(x) === n);
    if (!hit) throw new MemError('TRIGGER_NOT_FOUND', `主题 ${t.id} 没有 trigger「${trigger}」`, { triggers: t.triggers || [] });
    const record = this._retiredRecord(t.id);
    if (record.some((x) => normalizeName(x) === n)) {
      return { id: t.id, trigger: hit, retired: true, alreadyRetired: true, activeTriggers: this.activeTriggersOf(t), retiredTriggers: this.retiredTriggersOf(t.id) };
    }
    this._setJsonMeta('triggers.retired:' + t.id, [...record, hit]);
    this._audit('trigger.retire', {
      topicId: t.id, actor: ident.actor, oldText: hit,
      detail: { reason: reason || null, physicalDelete: false, note: '只打 retired 标记；triggers 数组不变' },
    });
    const after = this.be.getTopicById(t.id);
    return {
      id: t.id, trigger: hit, retired: true,
      activeTriggers: this.activeTriggersOf(after),
      retiredTriggers: this.retiredTriggersOf(t.id),
    };
  }

  triggersWithState(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const retired = new Set(this._retiredNorms(t.id));
    return (t.triggers || []).map((x) => ({ trigger: x, retired: retired.has(normalizeName(x)) }));
  }

  // ======================================================================
  // 6. trigger 冲突查询（决策 10：并列返回，不自动择一）
  // ======================================================================
  queryTriggerConflicts(opts = {}) {
    const includeGeneric = opts.includeGeneric === true;
    const conflicts = findTriggerConflicts(this._conflictTopics(), { includeGeneric, cfg: this.govCfg });
    // [2026-10-29 P0 修复] 默认跳过泛化 trigger：否则"2026/MB"这种全域词会把冲突面板淹没
    let genericExcluded = 0;
    if (!includeGeneric) {
      try { genericExcluded = this.genericTriggers().generic.length; } catch (e) { genericExcluded = 0; }
    }
    return { at: this.nowMs(), count: conflicts.length, conflicts, genericExcluded, includeGeneric };
  }

  /**
   * 按 trigger 找主题：命中多个就并列全返回 —— 绝不自动挑一个。
   * [2026-10-29 P0 修复] 泛化 trigger（覆盖率 > genericTriggerMaxTopics）默认**不参与检索加权**：
   *   return [] + 说明；需要看"它到底覆盖了谁"用 store.triggerInfo(trigger)。
   */
  findByTrigger(trigger, opts = {}) {
    const n = normalizeName(trigger);
    if (!n) return [];
    if (opts.includeGeneric !== true) {
      const info = this.triggerInfo(trigger);
      if (info.generic) return [];
    }
    const out = [];
    for (const t of this.be.listTopics()) {
      if (t.state === 'archived') continue;
      const active = this.activeTriggersOf(t);
      if (active.some((x) => normalizeName(x) === n)) out.push({ id: t.id, name: t.name, state: t.state, triggers: active });
    }
    return out;
  }

  // ======================================================================
  // 7. 读
  // ======================================================================
  readTopic(topicRef) {
    const t = this.resolveTopic(topicRef);
    const row = this.be.getTopicById(t.id);
    // [task-13] 参考式合并：主主题/明细子主题的正文按 merge.record 的句子引用聚合（物理句子仍在源主题）
    const view = row ? this._mergeViewRecord(t.id) : null;
    if (view) {
      const refs = t.id === view.mainId ? (view.keep || []) : (view.childId === t.id ? (view.child || []) : []);
      const cache = new Map();
      const sentences = [];
      for (const r of refs) {
        if (!cache.has(r.topicId)) cache.set(r.topicId, this._liveSentences(r.topicId));
        const s = cache.get(r.topicId).find((x) => x.id === r.sentenceId);
        if (s) sentences.push({ ...s, viaMerge: view.mergeId, fromTopic: r.topicId, fromOrd: r.ord });
      }
      return {
        id: t.id, name: t.name, how: t.how,
        state: row.state,
        triggers: this.activeTriggersOf(row),
        sentences,
        text: sentences.map((r) => r.text).join('\n'),
        chars: sentences.reduce((a, r) => a + r.chars, 0),
        mergeView: {
          mergeId: view.mergeId,
          role: t.id === view.mainId ? 'main' : 'child',
          sources: [...new Set(refs.map((r) => r.topicId))],
          expected: refs.length, resolved: sentences.length,
        },
      };
    }
    const rows = this._liveSentences(t.id);
    return {
      id: t.id, name: t.name, how: t.how,
      state: row ? row.state : null,
      triggers: row ? this.activeTriggersOf(row) : [],
      sentences: rows,
      text: rows.map((r) => r.text).join('\n'),
      chars: rows.reduce((a, r) => a + r.chars, 0),
    };
  }

  // ======================================================================
  // 8. 写：追加一句（过权限，写后检查自动转正）
  // ======================================================================
  appendSentence({ topic, text, src, actor = 'runtime', claimedActor, actualActor }) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'write')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'appendSentence', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能写正文`, { actor: ident.actor });
    }
    const body = String(text == null ? '' : text);
    if (!body.trim()) throw new MemError('EMPTY_TEXT', '正文不能为空');
    const t = this.resolveTopic(topic, { create: false });
    const t0 = this.nowMs();
    const flagged = this._noAutoPromote(t.id);
    const promoteBefore = this._promoteWrites(this.be.getTopicById(t.id));
    const ord = this.be.nextOrd(t.id);
    const id = this.be.insertSentence({ topicId: t.id, ord, sha: sha16(body), text: body, chars: body.length, createdAt: t0, updatedAt: t0, src: src || null });
    const cur = this.be.getTopicById(t.id);
    this.be.updateTopic(t.id, { writeCount: (cur.writeCount || 0) + 1, updatedAt: t0 });
    // 只有 lead/user（人工）的写入才计入"推动转正的写入次数"；导入主题上 plugin/dream 的写入不计（裁决规则 4）
    if (!flagged || this._isHumanWrite(ident.actor)) this._metaSet('promote.writes:' + t.id, String(promoteBefore + 1));
    this._audit('sentence.append', {
      at: t0, topicId: t.id, sentenceId: id, newSha: sha16(body), newText: body, actor: ident.actor,
      detail: ident.impersonated ? { claimed: ident.claimed, actual: ident.actual } : null,
    });
    const promoted = this._autoPromoteIfDue(t.id);
    const now = this.be.getTopicById(t.id);
    return { ok: true, topic: t.id, sentenceId: id, ord, sha: sha16(body), state: now ? now.state : null, promoted: promoted ? promoted.to : null };
  }

  // ======================================================================
  // 9. 写：单句替换（CAS，唯一命中）
  // ======================================================================
  replaceSentence({ topic, oldText, newText, actor = 'runtime', claimedActor, actualActor }) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'write')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'replaceSentence', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能改正文`, { actor: ident.actor });
    }
    const t = this.resolveTopic(topic, { create: false });
    const next = String(newText == null ? '' : newText);
    if (!next.trim()) throw new MemError('EMPTY_TEXT', '新正文不能为空');
    const want = String(oldText == null ? '' : oldText);
    const rows = this._liveSentences(t.id);
    const hits = rows.filter((r) => r.text === want);

    if (hits.length === 0) {
      const cand = rows.map((r) => ({ id: r.id, text: r.text, dist: levenshtein(want, r.text) }))
        .sort((a, b) => a.dist - b.dist).slice(0, 3);
      throw new MemError('TEXT_MISMATCH', `原文不匹配：主题「${t.name}」(${t.id}) 里没有这一句`, cand);
    }
    if (hits.length > 1) {
      throw new MemError('TEXT_NOT_UNIQUE', `原文在主题「${t.name}」内出现 ${hits.length} 次`, hits.map((h) => ({ id: h.id, ord: h.ord })));
    }

    const target = hits[0];
    const t0 = this.nowMs();
    // 走统一的批量事务入口：单独调用时自成事务；被 runInTransaction 包住时自动并入外层（不重复 BEGIN）
    this.runInTransaction(() => {
      const curSha = this.be.getSentenceSha(target.id);
      if (curSha !== sha16(want)) throw new MemError('STALE', '这句刚被别的会话改过，请重新读取后再改', { sentenceId: target.id });
      this.be.updateSentence(target.id, { text: next, sha: sha16(next), chars: next.length, updatedAt: t0 });
      this._audit('sentence.replace', {
        at: t0, topicId: t.id, sentenceId: target.id,
        oldSha: sha16(want), newSha: sha16(next), oldText: want, newText: next, actor: ident.actor,
      });
    });
    const cur = this.be.getTopicById(t.id);
    const flagged = this._noAutoPromote(t.id);
    const promoteBefore = this._promoteWrites(cur);
    this.be.updateTopic(t.id, { writeCount: (cur.writeCount || 0) + 1, updatedAt: t0 });
    if (!flagged || this._isHumanWrite(ident.actor)) this._metaSet('promote.writes:' + t.id, String(promoteBefore + 1));
    const promoted = this._autoPromoteIfDue(t.id);
    return { ok: true, topic: t.id, sentenceId: target.id, ord: target.ord, oldSha: sha16(want), newSha: sha16(next), promoted: promoted ? promoted.to : null };
  }

  // ======================================================================
  // 9b. 写：删除单句（task-41，等价 dream_patch delete；CAS 唯一命中 + 历史 sha 防复活）
  // ======================================================================
  /**
   * deleteSentence(topicId, {sentenceId|sha|text}, {actor})
   *   · 只能删**本主题内**且当前"有效"的句子；找不到 ⇒ SENTENCE_NOT_FOUND；
   *   · text 命中多句 ⇒ TEXT_NOT_UNIQUE；
   *   · 不物理擦除：物理行保留、审计 `sentence.delete`（oldSha/oldText）⇒ historicShas 挡住再 import 复活；
   *   · readTopic/topics/topicCounts/export 全部按"已删"过滤（deleted.index）。
   * 返回 { ok, id, removedSha, topicId }
   */
  deleteSentence(topicRef, selector = {}, { actor = 'runtime', claimedActor, actualActor, reason = null } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'write')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'deleteSentence', topic: String(topicRef), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能删正文`, { actor: ident.actor, action: 'deleteSentence' });
    }
    const t = this.resolveTopic(topicRef, { create: false });
    const rows = this._liveSentences(t.id);
    let target = null;
    if (selector.sentenceId != null) {
      target = rows.find((r) => r.id === selector.sentenceId) || null;
      if (!target) throw new MemError('SENTENCE_NOT_FOUND', `主题「${t.name}」里没有句子 ${selector.sentenceId}`, { topicId: t.id, sentenceId: selector.sentenceId });
    } else if (selector.sha != null) {
      target = rows.find((r) => r.sha === selector.sha) || null;
      if (!target) throw new MemError('SENTENCE_NOT_FOUND', `主题「${t.name}」里没有 sha=${selector.sha} 的句子`, { topicId: t.id, sha: selector.sha });
    } else if (selector.text != null) {
      const want = String(selector.text);
      const hits = rows.filter((r) => r.text === want);
      if (hits.length === 0) throw new MemError('SENTENCE_NOT_FOUND', `主题「${t.name}」里没有这一句`, { topicId: t.id, text: want });
      if (hits.length > 1) throw new MemError('TEXT_NOT_UNIQUE', `原文在主题「${t.name}」内出现 ${hits.length} 次`, hits.map((h) => ({ id: h.id, ord: h.ord })));
      target = hits[0];
    } else {
      throw new MemError('SENTENCE_NOT_FOUND', 'deleteSentence 需要 sentenceId / sha / text 之一', { topicId: t.id });
    }
    const t0 = this.nowMs();
    const idx = this._deletedEntries();
    idx.push({ sha: target.sha, topicId: t.id, sentenceId: target.id, at: t0, actor: ident.actor, text: target.text });
    this._setJsonMeta('deleted.index', idx);
    this._metaSet('deleted.sha:' + target.sha, JSON.stringify({ topicId: t.id, sentenceId: target.id, at: t0 }));
    // 留审计（oldSha 会进 historicShas ⇒ 再 import 同文本被挡，不复活）
    this._audit('sentence.delete', {
      at: t0, topicId: t.id, sentenceId: target.id,
      oldSha: target.sha, oldText: target.text, newText: '', actor: ident.actor,
      // [4.5.2] H5：独立 reason（如 note-compact）让审计可区分「dream patch 删除」与「笔记收敛删除」；
      //   不传 reason 时保持旧口径 dreamPatchDelete:true（既有调用方零变化）。
      detail: Object.assign(
        { at: t0, by: ident.actor, removedSha: target.sha, historicRetained: true, dreamPatchDelete: reason ? false : true },
        reason ? { reason: String(reason).slice(0, 120) } : {},
      ),
    });
    return { ok: true, id: target.id, removedSha: target.sha, topicId: t.id };
  }

  // ======================================================================
  // 10. 生命周期：状态迁移 / 自动转正 / 撤销 / 命中续期 / 曝光提醒 / 排队封顶
  // ======================================================================
  _transition(topicId, next, { actor = 'lifecycle', why = null, detail = null, at } = {}) {
    const cur = this.be.getTopicById(topicId);
    if (!cur) throw new MemError('NOT_FOUND', '主题不存在: ' + topicId);
    if (!STATES.includes(next)) throw new MemError('BAD_STATE', `未知状态「${next}」，合法状态：${STATES.join('/')}`, { allowed: STATES });
    const at0 = at == null ? this.nowMs() : at;
    if (cur.state === next) {
      return { ok: true, id: topicId, from: next, to: next, unchanged: true, at: at0 };
    }
    if (!canTransition(cur.state, next)) {
      throw new MemError('STATE_TRANSITION', `不允许的状态迁移：${cur.state} → ${next}`,
        { from: cur.state, to: next, allowed: TRANSITIONS[cur.state].slice() });
    }
    this.be.updateTopic(topicId, { state: next, updatedAt: at0 });
    this._metaSet('state.since:' + topicId, String(at0));
    this._audit('topic.state', {
      at: at0, topicId, actor, oldText: cur.state, newText: next,
      detail: { from: cur.state, to: next, why, ...(detail || {}) },
    });
    return { ok: true, id: topicId, from: cur.state, to: next, at: at0 };
  }

  stateOf(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    return t ? t.state : null;
  }

  /**
   * task-41：归档主题（保留内容与审计；从有效树移除）。
   *   · 走 _transition → archived（审计 topic.state；指针元数据/审计由 setState 的 _writeArchivePointer 写）；
   *   · **有未归档子节点 ⇒ 拒绝 TOPIC_HAS_CHILDREN**（必须先拆/迁再归档）；
   *   · pointer（true 或自定义字符串）⇒ 往父主题/所属线追加一条指针句，返回 pointerSentenceId。
   */
  archiveTopic(topicRef, { actor = 'runtime', claimedActor, actualActor, reason = null, pointer = null } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'archiveTopic', topic: String(topicRef), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能归档主题`, { actor: ident.actor, action: 'archiveTopic' });
    }
    const t = this.resolveTopic(topicRef, { create: false });
    const row = this.be.getTopicById(t.id);
    if (!row) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    if (row.state === 'archived') {
      return { ok: true, id: t.id, state: 'archived', alreadyArchived: true, pointerSentenceId: null };
    }
    const children = this.be.listTopics()
      .filter((x) => x.state !== 'archived' && this._mergeParentOf(x.id) === t.id)
      .map((x) => x.id);
    if (children.length) {
      throw new MemError('TOPIC_HAS_CHILDREN', `主题「${row.name}」还有 ${children.length} 个子节点，必须先拆/迁再归档`, { id: t.id, children });
    }
    const r = this.setState(t.id, 'archived', { actor: ident.actor, reason: reason || 'archive' });
    let pointerSentenceId = null;
    const wantPointer = pointer === true || (typeof pointer === 'string' && pointer.trim().length > 0);
    if (wantPointer) {
      const parentId = this._mergeParentOf(t.id) || null;
      if (parentId) {
        const custom = typeof pointer === 'string' ? pointer.trim() : '';
        const text = custom.startsWith('>') ? custom
          : `> 已归档：${row.name}（${reason || '归档'}，原文保留，可 memory_read ${t.id} 读回）`;
        const ap = this.appendSentence({ topic: parentId, text, actor: ident.actor });
        pointerSentenceId = ap.sentenceId;
      }
    }
    return { ok: true, id: t.id, state: 'archived', from: r.from, pointerSentenceId };
  }

  /** 显式改状态（转正/归档/入队）。dream 不行 —— 它不能定音（决策 15/17）。 */
  setState(topicRef, next, { actor = 'runtime', claimedActor, actualActor, reason, detail } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'setState', to: next, claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能定状态（只能提案）`, { actor: ident.actor, to: next });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const beforeDays = daysBetween(this._stateSince(t), this.nowMs());
    const r = this._transition(t.id, next, { actor: ident.actor, why: reason || 'manual', detail });
    if (next === 'archived' && !r.unchanged) {
      this._writeArchivePointer(t.id, { from: r.from, days: beforeDays, why: reason || 'manual', at: r.at });
    }
    // Lead 裁决规则 4：lead/user 显式转正 ⇒ 清除导入豁免标记
    if (next === 'active' && !r.unchanged && this._isHumanWrite(ident.actor) && this._noAutoPromote(t.id)) {
      this._metaSet('noAutoPromote:' + t.id, '0');
      this._audit('topic.seed.exemption.cleared', {
        at: r.at, topicId: t.id, actor: ident.actor,
        detail: { reason: 'lead/user 显式转正', from: 'noAutoPromote=1', to: 'noAutoPromote=0' },
      });
    }
    return { ...r, state: next };
  }

  /** 自动转正：draft + **推动转正的写入** ≥ promoteAfterWrites 且无冲突 ⇒ active（可撤销，有审计） */
  _autoPromoteIfDue(topicId) {
    if (this._metaGet('promote.blocked:' + topicId) === '1') return null;   // 撤销过的不再自动转正
    const t = this.be.getTopicById(topicId);
    if (!t || t.state !== 'draft') return null;           // 只有 draft 才可能转正（绝大多数写入在这里短路）
    // 便宜的计数判定放前面：不满足就直接返回，**不做全库冲突扫描**。
    // 导入路径（seed 主题 promote.writes 恒为 0）与"写入 1 次"的常见情况都靠这两行短路，
    // 否则 3 万句导入时每句都 findTriggerConflicts(全库) ⇒ 分钟级膨胀（importer 实测反馈）。
    const writes = this._promoteWrites(t);
    if (!shouldAutoPromote(t, this.lifeCfg, { hasConflict: false, writes })) return null;
    // 计数够了（只可能是 lead/user 的写入把计数推上去）才值得做冲突扫描
    if (this._hasConflict(topicId)) return null;
    const flagged = this._noAutoPromote(topicId);
    const r = this._transition(topicId, 'active', {
      actor: 'lifecycle', why: 'auto_promote',
      detail: {
        promoteWrites: writes, writeCount: t.writeCount, noAutoPromote: flagged,
        rule: `draft 被 lead/user 写入 ≥${this.lifeCfg.promoteAfterWrites} 次且无冲突`,
      },
    });
    if (r.unchanged) return null;
    this._metaSet('auto.promoted:' + topicId, '1');
    this._audit('topic.promote', { at: r.at, topicId, actor: 'lifecycle', newText: 'active', detail: { from: 'draft', promoteWrites: writes, writeCount: t.writeCount } });
    // 人工写入推动的转正 ⇒ 导入豁免自然失效
    if (flagged) {
      this._metaSet('noAutoPromote:' + topicId, '0');
      this._audit('topic.seed.exemption.cleared', {
        at: r.at, topicId, actor: 'lifecycle',
        detail: { reason: 'lead/user 写入推动自动转正', from: 'noAutoPromote=1', to: 'noAutoPromote=0' },
      });
    }
    return r;
  }

  /** 撤销自动转正：状态回 draft，且该主题此后不再自动转正（直到 clearPromoteBlock） */
  undoPromote(topicRef, { actor = 'runtime', claimedActor, actualActor, reason } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'undoPromote', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能撤销转正`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (t.state !== 'active' || this._metaGet('auto.promoted:' + t.id) !== '1') {
      throw new MemError('NOT_AUTO_PROMOTED', `主题 ${t.id} 不是自动转正来的（state=${t.state}），无需撤销`, { id: t.id, state: t.state });
    }
    const r = this._transition(t.id, 'draft', { actor: ident.actor, why: 'undo_promote', detail: { reason: reason || null } });
    this._metaSet('auto.promoted:' + t.id, '0');
    this._metaSet('promote.blocked:' + t.id, '1');
    this._audit('topic.promote.undo', { at: r.at, topicId: t.id, actor: ident.actor, oldText: 'active', newText: 'draft', detail: { reason: reason || null } });
    return { ok: true, id: t.id, from: 'active', to: 'draft', at: r.at };
  }

  /** 解除"撤销后不再自动转正"的封锁（用户显式重新授权） */
  clearPromoteBlock(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    this._metaSet('promote.blocked:' + t.id, '0');
    return { ok: true, id: t.id };
  }

  /** 检索命中 ⇒ 续期（决策 13：被命中就不降级） */
  markHit(topicRef, { actor = 'runtime', claimedActor, actualActor, at } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'write')) {
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能记录命中`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    const t0 = at == null ? this.nowMs() : at;
    this.be.updateTopic(t.id, { lastHitAt: t0, updatedAt: t.updatedAt });
    const hits = this._hitCount(t.id) + 1;
    this._metaSet('hits:' + t.id, String(hits));
    this._audit('topic.hit', { at: t0, topicId: t.id, actor: ident.actor });
    return { id: t.id, lastHitAt: t0, hitCount: hits, state: t.state };
  }

  // ---- needs_review 队列（封顶 20，第 21 条把最旧最低频转 dormant）----
  enterNeedsReview(topicRef, { reason, actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'setState')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'enterNeedsReview', claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能把主题推进 needs_review`, { actor: ident.actor });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    return this._enterNeedsReviewInternal(t.id, { reason, actor: ident.actor });
  }

  /** 内部入队（不做权限判定）—— seed 通道用：导入器身份 plugin 没有 setState 权限，但裁决要求它必须入队 */
  _enterNeedsReviewInternal(topicId, { reason, actor = 'lifecycle', at } = {}) {
    const t = this.be.getTopicById(topicId);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + topicId);
    if (t.state === 'archived') throw new MemError('STATE_TRANSITION', '已归档主题不能再进 needs_review', { state: 'archived' });
    if (t.state === 'needs_review') {
      this._metaSet('review.reason:' + t.id, String(reason || ''));
      return { ok: true, id: t.id, state: 'needs_review', demoted: null, queueSize: this.needsReviewQueue().length, unchanged: true };
    }
    const r = this._transition(t.id, 'needs_review', { at, actor, why: 'needs_review', detail: { reason: reason || null } });
    this._metaSet('review.reason:' + t.id, String(reason || ''));
    this._audit('topic.needs_review', { at: r.at, topicId: t.id, actor, newText: reason || '', detail: { reason: reason || null } });

    const queue = this.needsReviewQueue();
    let demoted = null;
    // 裁决A：封顶只对"非 seed 来源"生效 —— 导入带来的冲突是最该被人看的，不能因封顶被静默埋掉
    const capPool = this.lifeCfg.needsReviewSeedExempt === false ? queue : queue.filter((x) => !x.seed);
    const pick = pickOverflowVictim(capPool, this.lifeCfg);
    if (pick) {
      const v = pick.victim;
      const rd = this._transition(v.id, 'dormant', {
        actor: 'lifecycle', why: 'needs_review_overflow',
        detail: { queueCap: this.lifeCfg.needsReviewCap, overflowBy: pick.overflowBy, reason: '最早且命中次数最少', capPool: capPool.length, seedExempt: this.lifeCfg.needsReviewSeedExempt !== false },
      });
      this._audit('topic.needs_review.overflow', { at: rd.at, topicId: v.id, actor: 'lifecycle', oldText: 'needs_review', newText: 'dormant', detail: { queueCap: this.lifeCfg.needsReviewCap } });
      demoted = { id: v.id, to: 'dormant' };
    }
    return { ok: true, id: t.id, state: 'needs_review', demoted, queueSize: this.needsReviewQueue().length };
  }

  needsReviewQueue() {
    return this.topics()
      .filter((t) => t.state === 'needs_review')
      .map((t) => ({ id: t.id, name: t.name, stateSince: t.stateSince, createdAt: t.createdAt, hitCount: t.hitCount, daysInState: t.daysInState, reason: this._metaGet('review.reason:' + t.id) || null, seed: this._isSeedTopic(t.id) }))
      .sort((a, b) => (a.stateSince - b.stateSince) || (a.hitCount - b.hitCount) || (a.id < b.id ? -1 : 1));
  }

  // ---- 曝光阶梯：7 天提醒 / 30 天文案升级 / 90 天自动归档 ----
  _writeArchivePointer(topicId, info = {}) {
    const at = info.at == null ? this.nowMs() : info.at;
    const d = new Date(at);
    const pointer = {
      topicId,
      from: info.from || null,
      days: info.days == null ? null : info.days,
      why: info.why || null,
      at,
      sessionsHref: `sessions/${d.toISOString().slice(0, 10)}.md#${topicId}`,
      note: '原文未删：readTopic 仍读得到；md 导出时渲染进 sessions/（决策 13/19）',
    };
    this._setJsonMeta('archive.pointer:' + topicId, pointer);
    this._audit('topic.archive', { at, topicId, actor: 'lifecycle', detail: pointer });
    return pointer;
  }

  archivePointer(topicRef) {
    const t = this.resolveTopic(topicRef);
    return this._jsonMeta('archive.pointer:' + t.id, null);
  }

  archivedTopics() {
    return this.topics()
      .filter((t) => t.state === 'archived')
      .map((t) => ({ id: t.id, name: t.name, sentences: t.sentences, chars: t.chars, stateSince: t.stateSince, pointer: this._jsonMeta('archive.pointer:' + t.id, null) }));
  }

  _archiveDue(at) {
    const topics = this.be.listTopics().map((t) => ({ ...t, stateSince: this._stateSince(t) }));
    const due = planArchivable(topics, at, this.lifeCfg);
    const out = [];
    for (const d of due) {
      const r = this._transition(d.id, 'archived', {
        actor: 'lifecycle', why: 'exposure_archive', at,
        detail: { days: d.days, from: d.from, ladder: [this.lifeCfg.remindAfterDays, this.lifeCfg.escalateAfterDays, this.lifeCfg.archiveAfterDays] },
      });
      const pointer = this._writeArchivePointer(d.id, { from: d.from, days: d.days, why: 'exposure_archive', at });
      out.push({ ...d, at, state: 'archived', pointer });
      this._audit('topic.archive.auto', { at, topicId: d.id, actor: 'lifecycle', detail: { days: d.days, fromState: r.from } });
    }
    return out;
  }

  _reminderPlan(at) {
    const topics = this.be.listTopics().map((t) => ({ ...t, stateSince: this._stateSince(t) }));
    return planExposure(topics, at, this.lifeCfg).reminder;
  }

  /** 会话开始的一次生命周期 tick：先把到期(90天)的归档，再产出提醒（只读计算） */
  lifecycleTick() {
    const at = this.nowMs();
    const archived = this._archiveDue(at);
    const reminder = this._reminderPlan(at);
    return { at, archived, reminder };
  }

  /** 供注入层消费：{line,count,oldestDays,level,items,hidden} 或 null；每会话最多 1 行 */
  pendingReminder() { return this.lifecycleTick().reminder; }

  scanLifecycle() { const at = this.nowMs(); return { at, archived: this._archiveDue(at) }; }

  // ======================================================================
  // 11. 结构变更：合并 / 拆分 / 删除（dream 一律只能提案）
  // ======================================================================
  mergeTopics({ from, into, actor = 'runtime', claimedActor, actualActor, reason } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'merge')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'merge', from: String(from), into: String(into), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED',
        `身份「${ident.actor}」只能出提案，不能执行合并（由用户或主会话定音）`,
        { actor: ident.actor, action: 'merge', from: String(from), into: String(into), proposal: '请把合并建议写成提案交给 lead/user' });
    }
    const src = this.be.getTopicById(this.resolveTopic(from).id);
    const dst = this.be.getTopicById(this.resolveTopic(into).id);
    if (src.id === dst.id) throw new MemError('SAME_TOPIC', '合并的源与目标不能是同一个主题', { id: src.id });
    if (src.state === 'archived') throw new MemError('STATE_TRANSITION', '已归档主题不能再合并进来', { id: src.id });

    const at = this.nowMs();
    const rows = this._liveSentences(src.id);
    let ord = this.be.nextOrd(dst.id);
    for (const r of rows) {
      const sid = this.be.insertSentence({
        topicId: dst.id, ord, sha: r.sha, text: r.text, chars: r.chars,
        createdAt: at, updatedAt: at, src: r.src || ('merged:' + src.id),
      });
      this._audit('sentence.append', {
        at, topicId: dst.id, sentenceId: sid, newSha: r.sha, newText: r.text, actor: ident.actor,
        detail: { mergedFrom: src.id, fromOrd: r.ord },
      });
      ord++;
    }

    // 别名与 triggers 迁到目标（triggers 已 retired 的不迁，决策 10）
    const aliases = [...(dst.aliases || [])];
    for (const a of [src.name, ...(src.aliases || [])]) {
      const s = String(a == null ? '' : a).trim();
      const n = normalizeName(s);
      if (n && !aliases.some((x) => normalizeName(x) === n)) aliases.push(s);
    }
    const triggers = [...(dst.triggers || [])];
    const retiredSrc = new Set(this._retiredNorms(src.id));
    for (const tr of src.triggers || []) {
      const n = normalizeName(tr);
      if (!n || retiredSrc.has(n)) continue;
      if (!triggers.some((x) => normalizeName(x) === n)) triggers.push(tr);
    }
    this.be.updateTopic(dst.id, { aliases, triggers, updatedAt: at });

    const beforeDays = daysBetween(this._stateSince(src), at);
    this._transition(src.id, 'archived', { actor: ident.actor, why: 'merge', at, detail: { into: dst.id, moved: rows.length } });
    this._writeArchivePointer(src.id, { from: src.state, days: beforeDays, why: 'merge_into:' + dst.id, at });
    // Lead 裁决规则 4：lead/user 执行并入 ⇒ 目标主题的导入豁免标记清除（已由人处置，之后按人工写入推动转正）
    let exemptionCleared = false;
    if (this._isHumanWrite(ident.actor) && this._noAutoPromote(dst.id)) {
      this._metaSet('noAutoPromote:' + dst.id, '0');
      exemptionCleared = true;
      this._audit('topic.seed.exemption.cleared', {
        at, topicId: dst.id, actor: ident.actor,
        detail: { reason: 'lead/user 并入', from: 'noAutoPromote=1', to: 'noAutoPromote=0', mergedFrom: src.id },
      });
    }
    this._audit('topic.merge', { at, topicId: dst.id, actor: ident.actor, oldText: src.id, newText: dst.id, detail: { from: src.id, into: dst.id, moved: rows.length, reason: reason || null, exemptionCleared } });
    const conflicts = this._recordTriggerConflicts(dst.id, ident.actor, at);
    return { ok: true, from: src.id, into: dst.id, moved: rows.length, sourceState: 'archived', exemptionCleared, conflicts };
  }

  /** 拆分：权限门已落地（dream 一律拒）；物理拆分需要人工确认，留到工具面阶段 */
  /** 新主题名撞名时加日期后缀（同日再撞加序号） */
  _freeTopicName(base) {
    const norm = normalizeName(base);
    if (!this.be.getTopicByNorm(norm)) return base;
    const d = new Date(this.nowMs());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    const cand = base + '（' + stamp + '）';
    if (!this.be.getTopicByNorm(normalizeName(cand))) return cand;
    for (let n = 2; n <= 20; n += 1) {
      const c = cand + ' ' + n;
      if (!this.be.getTopicByNorm(normalizeName(c))) return c;
    }
    return cand + ' ' + this.nowMs();
  }

  /**
   * task-45 真实现：把主题的部分句子**物理移动**到同父下的新明细主题（P4 超限下沉用）。
   *   · 选句：sentenceIds（⊆ 本主题且非空）/ count（尾部 N 句）/ predicate(row)
   *   · 新主题默认名 `<原名> · 明细`（撞名加日期），linkParent 到**同一父**，setLevel(detail)
   *   · 原主题追加指针句；审计 topic.split；幂等（同一组 sentenceIds 再调用 ⇒ alreadySplit）
   *   · 物理移动 ⇒ 不写墓碑、不动 sha、句子守恒天然成立
   * 返回 { ok, id, newTopicId, name, moved, movedSentences, pointerSentenceId }
   */
  splitTopic(topicRef, { actor = 'runtime', claimedActor, actualActor, name = null, sentenceIds = null, count = null, predicate = null } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'split')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'split', topic: String(topicRef), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」只能出提案，不能执行拆分`, { actor: ident.actor, action: 'split' });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    if (t.state === 'archived') throw new MemError('BAD_STATE', `归档主题不能拆分：${t.id}`, { id: t.id, state: t.state });

    const idList = Array.isArray(sentenceIds) ? [...new Set(sentenceIds.map(String))] : null;
    const idKey = idList && idList.length ? idList.slice().sort().join(',') : null;
    if (idKey) {
      const priorChild = this._metaGet('split.childOf:' + t.id + ':' + sha16(idKey));
      if (priorChild && this.be.getTopicById(priorChild)) {
        return { ok: true, alreadySplit: true, id: t.id, newTopicId: priorChild, moved: 0, movedSentences: [], pointerSentenceId: null };
      }
    }

    const liveRows = this._liveSentences(t.id);
    let picked = [];
    if (idList && idList.length) {
      const byId = new Map(liveRows.map((r) => [String(r.id), r]));
      const missing = idList.filter((sid) => !byId.has(String(sid)));
      if (missing.length) throw new MemError('SENTENCE_NOT_FOUND', `sentenceIds 中有 ${missing.length} 句不在主题「${t.name}」的当前正文里`, { topicId: t.id, missing });
      picked = idList.map((sid) => byId.get(String(sid)));
    } else if (typeof predicate === 'function') {
      picked = liveRows.filter((r) => predicate(r));
    } else if (count != null) {
      const n = Math.floor(Number(count));
      if (!Number.isFinite(n) || n <= 0) throw new MemError('BAD_ARG', `count 必须是正整数（收到 ${count}）`, { count });
      picked = liveRows.slice(-n);
    } else {
      throw new MemError('SENTENCE_NOT_FOUND', 'splitTopic 需要 sentenceIds / count / predicate 之一', { topicId: t.id });
    }
    if (!picked.length) throw new MemError('SENTENCE_NOT_FOUND', '没有可拆分的句子', { topicId: t.id });

    const at = this.nowMs();
    const baseName = name && String(name).trim() ? String(name).trim() : t.name + ' · 明细';
    const newName = this._freeTopicName(baseName);
    const norm = normalizeName(newName);
    const newId = this.be.nextTopicId();
    const parentId = this._mergeParentOf(t.id) || (this.levelOf(t.id) === 'domain' ? t.id : null);
    const moved = [];
    let pointerSentenceId = null;
    this.runInTransaction(() => {
      this._insertTopic({ id: newId, name: newName, norm, aliases: [], triggers: [], state: 'active', createdAt: at, updatedAt: at, stateSince: at });
      this.setLevel(newId, 'detail', { actor: ident.actor });
      if (parentId) this.linkParent(newId, parentId, { actor: ident.actor });
      const ordered = picked.slice().sort((a, b) => (a.ord - b.ord));
      ordered.forEach((row, i) => {
        const ok = this.be.moveSentence(row.id, { topicId: newId, ord: i });
        if (!ok) throw new MemError('SENTENCE_NOT_FOUND', `句子移动失败：${row.id}`, { sentenceId: row.id });
        moved.push(row.id);
      });
      const text = `> 已拆分 ${moved.length} 句至 ${newId}「${newName}」（原文保留，可 memory_read ${newId}）`;
      const ap = this.appendSentence({ topic: t.id, text, actor: ident.actor });
      pointerSentenceId = ap.sentenceId;
      this._metaSet('split.source:' + newId, t.id);
      if (idKey) this._metaSet('split.childOf:' + t.id + ':' + sha16(idKey), newId);
      this._audit('topic.split', {
        at, topicId: t.id, actor: ident.actor, oldText: t.name, newText: newName,
        detail: { sourceId: t.id, newTopicId: newId, moved: moved.length, sentenceIds: moved.slice(), name: newName, parentId, pointerSentenceId, mode: idList ? 'ids' : (typeof predicate === 'function' ? 'predicate' : 'count') },
      });
    });
    return { ok: true, id: t.id, newTopicId: newId, newName, moved: moved.length, movedSentences: moved, pointerSentenceId };
  }

  /** 删除 = 逻辑删除（归档 + 指针），绝不物理删原文（决策 19） */
  deleteTopic(topicRef, { actor = 'runtime', claimedActor, actualActor, reason } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'delete')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'delete', topic: String(topicRef), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能删除主题（只能提案）`, { actor: ident.actor, action: 'delete' });
    }
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (t.state === 'archived') return { ok: true, id: t.id, state: 'archived', alreadyArchived: true, physicalDelete: false };
    const beforeDays = daysBetween(this._stateSince(t), this.nowMs());
    const r = this._transition(t.id, 'archived', { actor: ident.actor, why: 'delete', detail: { reason: reason || null } });
    this._writeArchivePointer(t.id, { from: r.from, days: beforeDays, why: 'delete', at: r.at });
    this._audit('topic.delete', { at: r.at, topicId: t.id, actor: ident.actor, oldText: r.from, newText: 'archived', detail: { reason: reason || null, physicalDelete: false } });
    return { ok: true, id: t.id, state: 'archived', from: r.from, physicalDelete: false };
  }

  // ======================================================================
  // 12. 归类应用（task-13）：linkParent / childrenOf / mergeCluster / undoMergeCluster
  // ----------------------------------------------------------------------
  // 设计取舍（必读，别被"句子总数不变"与"归档可读全文"打架困惑）：
  //   后端 sqlite/ledger **都没有** deleteSentence / deleteTopic / 改 sentence.topicId 的 API，
  //   本轮又不许改 backend-*.mjs；而 task-13 硬指标要求：
  //     句子总数不变 + 每句 sha 都在 + verify OK + 归档主题仍 readTopic 可读全文 + undo 逐主题 sha 一致。
  //   ⇒ 采用**参考式合并（merged view）**：不物理复制/移动句子，只在 meta 登记
  //      "主主题保留哪些句 / 明细子主题持有哪些句"；readTopic() 对主/子主题按登记聚合，
  //      源主题原封不动（句子不丢、sha 不变，归档后仍可读全文）。
  //   好处：句子总数严格守恒、undo 只还原状态与标记（无需删除能力）、同簇重复 apply 天然幂等。
  //   代价：主/子主题的物理句数为 0（topics().sentences），真实句数看 topics().viewSentences /
  //        readTopic()；等后端具备 move/delete 后可按本 record 物化（record 里逐句 topicId+ord+sha 齐全）。
  // ======================================================================

  /** 父指针：meta `parent:<childId>` = parentId（不改 schema） */
  parentOf(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    return this._mergeParentOf(t.id);
  }

  _mergeParentOf(topicId) { return this._metaGet('parent:' + topicId) || null; }

  /** 有效合并视图记录（undo 过的不算） */
  _mergeViewRecord(topicId) {
    const mid = this._metaGet('merge.view:' + topicId);
    if (!mid) return null;
    const rec = this._jsonMeta('merge.record:' + mid, null);
    if (!rec || rec.undoneAt) return null;
    return rec;
  }

  linkParent(childRef, parentRef, { actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'merge')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'linkParent', child: String(childRef), parent: String(parentRef), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能建立父子关系（只能提案）`, { actor: ident.actor, action: 'linkParent' });
    }
    const child = this.be.getTopicById(this.resolveTopic(childRef).id);
    const parent = this.be.getTopicById(this.resolveTopic(parentRef).id);
    if (!child || !parent) throw new MemError('NOT_FOUND', 'child 或 parent 主题不存在');
    if (child.id === parent.id) throw new MemError('SAME_TOPIC', '父子不能是同一主题', { id: child.id });
    // [task-18] 层级约束（只对显式 level 的节点严格；历史扁平主题保持兼容）
    const childEx = this._levelMetaOf(child.id);
    const parentLevel = this.levelOf(parent);
    if (childEx === 'domain') throw new MemError('BAD_PARENT_LEVEL', `域 ${child.id} 不能有 parent（域是根）`, { child: child.id, parent: parent.id, parentLevel });
    if (childEx === 'project' && parentLevel !== 'domain') throw new MemError('BAD_PARENT_LEVEL', `项目线 ${child.id} 的 parent 必须是域（实际 ${parent.id} level=${parentLevel}）`, { child: child.id, parent: parent.id, parentLevel, expected: 'domain' });
    // [task-20] 明细可以直接挂域（"单主题族"落在域下作叶子）；挂项目线是常态，二者都合法。
    // 环检测：沿 parent 链上溯，遇到 child 即拒绝
    const seen = new Set([child.id]);
    let cur = parent;
    while (cur) {
      if (seen.has(cur.id)) throw new MemError('PARENT_CYCLE', `父子关系成环：${child.id} → ${parent.id}`, { child: child.id, parent: parent.id });
      seen.add(cur.id);
      const nxt = this._mergeParentOf(cur.id);
      cur = nxt ? this.be.getTopicById(nxt) : null;
    }
    // [task-18] 跨域父子禁止：child 已归属某域时，新 parent 必须仍在同一域根下
    const hadParent = this._mergeParentOf(child.id);
    if (hadParent) {
      const cr = this._rootOf(child.id);
      const pr = this._rootOf(parent.id);
      if (cr && pr && cr !== pr) {
        throw new MemError('CROSS_DOMAIN_PARENT', `跨域挂父子被拒：${child.id} 属于域根 ${cr}，新 parent ${parent.id} 属于域根 ${pr}`, { child: child.id, parent: parent.id, childRoot: cr, parentRoot: pr });
      }
    }
    const at = this.nowMs();
    this._metaSet('parent:' + child.id, parent.id);
    this._audit('topic.linkParent', { at, topicId: child.id, actor: ident.actor, newText: parent.id, detail: { child: child.id, parent: parent.id } });
    return { ok: true, child: child.id, parent: parent.id, at };
  }

  /** 子主题清单（dormant 明细）；viewSentences 为该子主题"视图句数"（物理句数为 0 是正常现象） */
  childrenOf(topicRef) {
    const t = this.be.getTopicById(this.resolveTopic(topicRef).id);
    if (!t) throw new MemError('NOT_FOUND', '主题不存在: ' + String(topicRef));
    const out = [];
    for (const row of this.be.listTopics()) {
      if (this._mergeParentOf(row.id) !== t.id) continue;
      const rows = this._liveSentences(row.id);
      const view = this._mergeViewRecord(row.id);
      out.push({
        id: row.id, name: row.name, state: row.state, parent: t.id,
        sentences: rows.length, chars: rows.reduce((a, s) => a + (s.chars || 0), 0),
        viewSentences: view && view.childId === row.id ? (view.child || []).length : 0,
        mergeId: view ? view.mergeId : null,
      });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** 直接改状态（绕过 TRANSITIONS 表；只给 undo/合并这类特权路径用，仍写审计） */
  _restoreState(topicId, state, { actor = 'runtime', at, why = 'restore' } = {}) {
    const cur = this.be.getTopicById(topicId);
    if (!cur) return { id: topicId, ok: false, why: 'missing' };
    const at0 = at == null ? this.nowMs() : at;
    if (cur.state === state) return { id: topicId, ok: true, from: state, to: state, unchanged: true };
    this.be.updateTopic(topicId, { state, updatedAt: at0 });
    this._metaSet('state.since:' + topicId, String(at0));
    this._audit('topic.state', { at: at0, topicId, actor, oldText: cur.state, newText: state, detail: { from: cur.state, to: state, why } });
    return { id: topicId, ok: true, from: cur.state, to: state };
  }

  /**
   * 簇合并（参考式）：建/复用主主题 → 保留句视图迁入（原序逐字）→ 其余转明细子主题（dormant+parent）
   * → 源主题 archived（不删原文）→ 写 merge 记录（可逆）。**单事务；失败整簇回滚。**
   *
   * @param {object} p
   * @param {Array<string>} p.members 成员主题 ref（≥2；名字/ID 都行）
   * @param {string} p.title          主主题名（已存在则复用：仅限"undo 后重放"或该主题是同一 merge 的 main）
   * @param {string[]} [p.keepSentenceShas] 保留句 sha16 列表（与 keepIds/keepRefs 三选一）
   * @param {(string|number)[]} [p.keepIds] 保留句 id 列表
   * @param {Array<{topicId:string,ord:number}>} [p.keepRefs] 保留句 (topicId, ord) 列表（task-12 提案直接可用）
   * @param {string} [p.actor]
   * @returns {{ok:boolean, changed:number, mergeId:string, mainTopicId:string, childTopicId:string|null, archived:string[], keepCount:number, childCount:number, stats:object}}
   */
  mergeCluster({ members, title, keepSentenceShas, keepIds, keepRefs, actor = 'runtime', claimedActor, actualActor, reason, maxKeep = 120 } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'merge')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'mergeCluster', members: (members || []).map(String), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能执行合并（只能提案，由用户或主会话定音）`, { actor: ident.actor, action: 'mergeCluster' });
    }
    const refsIn = Array.isArray(members) ? members : [];
    if (refsIn.length < 2) throw new MemError('BAD_MEMBERS', 'mergeCluster 需要 ≥2 个成员', { got: refsIn.length });
    const titleRaw = String(title == null ? '' : title).trim();
    if (!titleRaw) throw new MemError('EMPTY_NAME', 'mergeCluster 需要非空 title');
    const titleNorm = normalizeName(titleRaw);
    if (!titleNorm) throw new MemError('EMPTY_NAME', 'title 归一化后为空');

    // 解析成员（去重、保持输入顺序）
    const resolved = [];
    const seen = new Set();
    for (const r of refsIn) {
      const row = this.be.getTopicById(this.resolveTopic(r).id);
      if (!row) throw new MemError('NOT_FOUND', '成员主题不存在: ' + String(r));
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      resolved.push(row);
    }
    if (resolved.length < 2) throw new MemError('BAD_MEMBERS', '去重后成员仍不足 2 个', { members: resolved.map((t) => t.id) });

    // 幂等：同 (title, 成员集合) 的 active merge ⇒ 0 变更。
    // 注意必须在"已归档成员"校验**之前**判断：第二次 apply 时成员早已 archived，先校验状态会误报 ARCHIVED_MEMBER。
    const sig = mergeSig(titleNorm, resolved.map((t) => t.id));
    const priorId = this._metaGet('merge.bySig:' + sig);
    if (priorId) {
      const prior = this._jsonMeta('merge.record:' + priorId, null);
      if (prior && !prior.undoneAt) {
        return {
          ok: true, changed: 0, reused: true, mergeId: priorId, sig,
          mainTopicId: prior.mainId, childTopicId: prior.childId || null,
          mainId: prior.mainId, childId: prior.childId || null,   // 字段别名：mainId/childId 与 mainTopicId/childTopicId 等价
          archived: (prior.sources || []).map((s) => s.id),
          keepCount: (prior.keep || []).length, childCount: (prior.child || []).length,
          sentencesConserved: true,
        };
      }
    }

    for (const t of resolved) {
      if (t.state === 'archived') throw new MemError('ARCHIVED_MEMBER', `成员 ${t.id} 已归档，不能再合并`, { id: t.id, state: t.state });
      // [task-18] 允许合并"有子明细"的项目线：一层明细会在合并后转挂到主主题；
      //   但子节点本身还有下级（或子节点是域）时仍拒绝，避免多层结构被压平。
      const kids = this.be.listTopics().filter((x) => this._mergeParentOf(x.id) === t.id);
      const nestedKid = kids.find((k) => this.levelOf(k) === 'domain' || this.be.listTopics().some((x) => this._mergeParentOf(x.id) === k.id));
      if (nestedKid) throw new MemError('NESTED_MERGE', `成员 ${t.id} 的子节点 ${nestedKid.id} 还有下级，本阶段只支持一层明细转挂`, { id: t.id, child: nestedKid.id, children: kids.map((x) => x.id) });
    }

    // 主主题：复用同名主题（仅允许：它是某个 merge 的 main 且已 undo；否则视为重名冲突）
    const at = this.nowMs();
    const existingMain = this.be.getTopicByNorm(titleNorm);
    let mainRow = null; let mainWasCreated = false; let mainPrevState = null;
    if (existingMain) {
      if (resolved.some((t) => t.id === existingMain.id)) {
        throw new MemError('TITLE_CONFLICT', `title「${titleRaw}」与成员 ${existingMain.id} 同名，请给主主题换一个名字`, { title: titleRaw, member: existingMain.id });
      }
      const priorOfMain = this._jsonMeta('merge.mainIndex:' + existingMain.id, null);
      const priorRec = priorOfMain ? this._jsonMeta('merge.record:' + priorOfMain, null) : null;
      if (!(priorRec && priorRec.undoneAt)) {
        throw new MemError('TITLE_CONFLICT', `title「${titleRaw}」已存在主题 ${existingMain.id}（${existingMain.state}），本阶段不做增量并入，请换名字`, { id: existingMain.id, state: existingMain.state });
      }
      mainRow = existingMain;
      mainPrevState = priorRec.mainPrevState || 'active';
    }
    if (mainRow && mainRow.state === 'archived') mainPrevState = mainPrevState || 'active';

    // 收集全部句子引用（保持成员顺序 + 句 ord）
    const allRefs = [];
    for (const t of resolved) {
      const rows = this._liveSentences(t.id).slice().sort((a, b) => a.ord - b.ord);
      for (const s of rows) allRefs.push({ topicId: t.id, sentenceId: s.id, ord: s.ord, sha: s.sha, text: s.text, chars: s.chars });
    }
    let keep = [];
    let keepExplicit = false;
    if (Array.isArray(keepRefs) && keepRefs.length) {
      keepExplicit = true;
      const byKey = new Map(allRefs.map((r) => [r.topicId + '#' + r.ord, r]));
      for (const k of keepRefs) {
        const hit = byKey.get(String(k.topicId) + '#' + Number(k.ord));
        if (!hit) throw new MemError('KEEP_REF_INVALID', `保留句引用不存在：${k.topicId}#${k.ord}`, { ref: k });
        keep.push(hit);
      }
    } else if (Array.isArray(keepIds) && keepIds.length) {
      keepExplicit = true;
      const byId = new Map(allRefs.map((r) => [String(r.sentenceId), r]));
      for (const id of keepIds) {
        const hit = byId.get(String(id));
        if (!hit) throw new MemError('KEEP_ID_INVALID', `保留句 id 不存在于成员中：${id}`, { id });
        keep.push(hit);
      }
    } else if (Array.isArray(keepSentenceShas) && keepSentenceShas.length) {
      keepExplicit = true;
      const bySha = new Map(); for (const r of allRefs) { if (!bySha.has(r.sha)) bySha.set(r.sha, []); bySha.get(r.sha).push(r); }
      for (const sha of keepSentenceShas) {
        const arr = bySha.get(String(sha));
        if (!arr || !arr.length) throw new MemError('KEEP_SHA_INVALID', `保留句 sha 不存在于成员中：${sha}`, { sha });
        keep.push(arr.shift());
      }
    } else {
      keep = pickKeepRefs(allRefs, Math.min(maxKeep, 120), 6000);
    }
    if (keep.length > maxKeep) throw new MemError('KEEP_OVER_BUDGET', `保留句 ${keep.length} 句超过上限 ${maxKeep}`, { keep: keep.length, maxKeep });
    // 原序：按 allRefs 顺序重排（显式选择也按原文顺序迁入 —— task 要求"原顺序逐字"）
    const keepSet = new Set(keep.map((r) => r.topicId + '#' + r.sentenceId));
    keep = allRefs.filter((r) => keepSet.has(r.topicId + '#' + r.sentenceId));
    const child = allRefs.filter((r) => !keepSet.has(r.topicId + '#' + r.sentenceId));
    const keepShas = new Set(keep.map((r) => r.sha));

    // 共享稀有 trigger（排除泛化词，沿用 task-8 口径）；仅用于新建主主题
    const sharedTriggers = (() => {
      const cnt = new Map();
      for (const t of resolved) for (const tr of this.activeTriggersOf(t)) cnt.set(tr, (cnt.get(tr) || 0) + 1);
      const gen = genericTriggersOf(this.be.listTopics().map((t) => ({ id: t.id, triggers: this.activeTriggersOf(t) })), this.govCfg);
      return [...cnt.entries()]
        .filter(([tr, n]) => n >= 2 && !gen.norms.has(normalizeName(tr)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8).map(([tr]) => tr);
    })();

    const mergeId = 'M-' + at.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const sourcesMeta = resolved.map((t) => ({ id: t.id, name: t.name, prevState: t.state }));
    // [task-18] 三级结构继承：成员若同属一个域 ⇒ 主主题挂到该域（晋升为项目线）；
    //   成员的子节点（明细）在合并后转挂到主主题，避免"明细挂在已归档源主题下"变成孤儿。
    const parentSet = new Set(resolved.map((t) => this._mergeParentOf(t.id)));
    let mainParentId = null;
    if (parentSet.size === 1) {
      const only = [...parentSet][0];
      if (only) {
        const pr = this.be.getTopicById(only);
        if (pr && this.levelOf(pr) === 'domain') mainParentId = only;
      }
    }
    const rowsAll = this.be.listTopics();
    const reparent = [];
    for (const t of resolved) for (const x of rowsAll) if (this._mergeParentOf(x.id) === t.id) reparent.push({ id: x.id, from: t.id });
    const mainPrevParent = mainRow ? this._mergeParentOf(mainRow.id) : null;
    const beforeStats = {
      topics: this.be.listTopics().length,
      sentences: this.be.listTopics().reduce((a, t) => a + (this.be.listSentences(t.id) || []).length, 0),
      active: this.be.listTopics().filter((t) => t.state === 'active').length,
    };

    let out = null;
    this.runInTransaction(() => {
      // 1) 主主题
      let mainId;
      if (mainRow) {
        mainId = mainRow.id;
        if (mainRow.state !== 'active') this._restoreState(mainId, 'active', { actor: ident.actor, at, why: 'merge-replay' });
        this._audit('topic.merge.main', { at, topicId: mainId, actor: ident.actor, newText: titleRaw, detail: { mergeId, created: false, prevState: mainRow.state } });
      } else {
        mainId = this.be.nextTopicId();
        this._insertTopic({ id: mainId, name: titleRaw, norm: titleNorm, aliases: [], triggers: sharedTriggers, state: 'active', createdAt: at, updatedAt: at, stateSince: at });
        this._audit('topic.merge.main', { at, topicId: mainId, actor: ident.actor, newText: titleRaw, detail: { mergeId, created: true, triggers: sharedTriggers } });
      }
      // 2) 明细子主题（dormant + parent）
      let childId = null;
      if (child.length) {
        childId = this.be.nextTopicId();
        let cname = titleRaw + ' · 明细';
        let n = 2;
        while (this.be.getTopicByNorm(normalizeName(cname))) { cname = titleRaw + ' · 明细 ' + n; n += 1; }
        this._insertTopic({ id: childId, name: cname, norm: normalizeName(cname), aliases: [], triggers: [], state: 'dormant', createdAt: at, updatedAt: at, stateSince: at });
        this._metaSet('parent:' + childId, mainId);
        this._audit('topic.merge.child', { at, topicId: childId, actor: ident.actor, newText: cname, detail: { mergeId, parent: mainId, childCount: child.length } });
      }
      // 2b) [task-18] 层级继承：主主题挂到共同域（项目线）；源的明细子节点转挂到主主题
      if (mainParentId) {
        this._metaSet('parent:' + mainId, mainParentId);
        if (this._levelMetaOf(mainId) !== 'domain') this._metaSet('level:' + mainId, 'project');
        this._audit('topic.merge.level', { at, topicId: mainId, actor: ident.actor, newText: 'project', detail: { mergeId, parent: mainParentId, inherited: true } });
      }
      const reparented = [];
      for (const rp of reparent) {
        if (rp.id === mainId || (childId && rp.id === childId)) continue;
        this._metaSet('parent:' + rp.id, mainId);
        reparented.push(rp);
      }
      if (reparented.length) this._audit('topic.merge.reparent', { at, topicId: mainId, actor: ident.actor, detail: { mergeId, reparented } });
      // 3) 视图登记（readTopic 聚合依据）
      if (childId) this._metaSet('merge.view:' + childId, mergeId);
      this._metaSet('merge.view:' + mainId, mergeId);
      // 4) 源主题归档（不删原文：句子行原封不动）
      const archived = [];
      for (const s of sourcesMeta) {
        const row = this.be.getTopicById(s.id);
        if (row.state !== 'archived') {
          this._transition(s.id, 'archived', { actor: ident.actor, why: 'merge-cluster', at, detail: { mergeId, main: mainId } });
          this._writeArchivePointer(s.id, { from: s.prevState, days: daysBetween(this._stateSince(row), at), why: 'merge_into:' + mainId, at });
        }
        archived.push(s.id);
      }
      // 5) merge 记录 + 幂等索引
      //    ref 里不存 text（meta 别膨胀）；只保留坐标 topicId+ord+sentenceId+sha+chars，
      //    物化/统计/导出时按坐标回源主题取原文（源主题句子永不搬动）。
      const refView = (r) => ({ topicId: r.topicId, sentenceId: r.sentenceId, ord: r.ord, sha: r.sha, chars: r.chars });
      const record = {
        mergeId, at, actor: ident.actor, title: titleRaw, titleNorm, sig,
        mainId, childId, mainWasCreated: !mainRow, mainPrevState: mainRow ? (mainPrevState || 'active') : null,
        mainParentId, mainPrevParent, reparent: reparented,
        sources: sourcesMeta, keep: keep.map(refView), child: child.map(refView),
        counts: { keep: keep.length, child: child.length, sourcesSentences: allRefs.length, keepShas: keepShas.size },
        keepExplicit, reason: reason || null, step: 'task-13',
      };
      this._setJsonMeta('merge.record:' + mergeId, record);
      this._metaSet('merge.bySig:' + sig, mergeId);
      this._metaSet('merge.mainIndex:' + mainId, mergeId);
      const index = this._jsonMeta('merge.index', []);
      index.push(mergeId);
      this._setJsonMeta('merge.index', index);
      // 6) 审计（含 mergeId / from / to，可逆）
      this._audit('topic.merge.cluster', {
        at, topicId: mainId, actor: ident.actor, newText: titleRaw,
        detail: {
          mergeId, from: archived, to: mainId, child: childId, sig,
          keepCount: keep.length, childCount: child.length, sourcesSentences: allRefs.length,
          keepExplicit, reason: reason || null, mode: 'reference-view',
        },
      });
      const afterTopics = this.be.listTopics();
      const afterStats = {
        topics: afterTopics.length,
        sentences: afterTopics.reduce((a, t) => a + (this.be.listSentences(t.id) || []).length, 0),
        active: afterTopics.filter((t) => t.state === 'active').length,
      };
      out = {
        ok: true, changed: archived.length + 1 + (childId ? 1 : 0), mergeId, sig,
        mainTopicId: mainId, childTopicId: childId, archived,
        mainId, childId,   // 字段别名：mainId/childId 与 mainTopicId/childTopicId 等价（Lead 2026-10-29 要求统一）
        keepCount: keep.length, childCount: child.length, keepShas: keepShas.size,
        before: beforeStats, after: afterStats,
        sentencesConserved: beforeStats.sentences === afterStats.sentences,
      };
    });
    return out;
  }

  /**
   * 撤销合并（按 merge 记录逆操作）：源主题恢复原状态；主主题（若由合并新建）归档；明细子主题归档；
   * 视图标记关闭。**不删除任何句子/主题**（后端无删除能力，也符合"不删原文"）。
   */
  undoMergeCluster(mergeId, { actor = 'runtime', claimedActor, actualActor } = {}) {
    const ident = resolveActor({ claimed: claimedActor == null ? actor : claimedActor, actual: actualActor });
    if (!can(ident.actor, 'merge')) {
      this._audit('perm.denied', { actor: ident.actor, detail: { action: 'undoMergeCluster', mergeId: String(mergeId), claimed: ident.claimed } });
      throw new MemError('PERM_DENIED', `身份「${ident.actor}」不能撤销合并`, { actor: ident.actor, action: 'undoMergeCluster' });
    }
    const id = String(mergeId == null ? '' : mergeId).trim();
    const rec = this._jsonMeta('merge.record:' + id, null);
    if (!rec) throw new MemError('NOT_FOUND', '合并记录不存在: ' + id, { mergeId: id });
    if (rec.undoneAt) return { ok: true, changed: 0, alreadyUndone: true, mergeId: id, undoneAt: rec.undoneAt };
    let result = null;
    this.runInTransaction(() => {
      const at = this.nowMs();
      const restored = [];
      // 源主题恢复原状态（archived → prevState，绕过 TRANSITIONS 但写审计）
      for (const s of rec.sources || []) {
        const r = this._restoreState(s.id, s.prevState, { actor: ident.actor, at, why: 'merge-undo:' + id });
        restored.push({ id: s.id, to: s.prevState, ok: r.ok });
      }
      // 主主题：合并新建的 ⇒ 归档；复用的 ⇒ 恢复原状态
      let mainAction = null;
      if (rec.mainWasCreated) {
        const row = this.be.getTopicById(rec.mainId);
        if (row && row.state !== 'archived') { this._transition(rec.mainId, 'archived', { actor: ident.actor, why: 'merge-undo', at, detail: { mergeId: id } }); mainAction = 'archived'; }
      } else if (rec.mainPrevState) {
        this._restoreState(rec.mainId, rec.mainPrevState, { actor: ident.actor, at, why: 'merge-undo:' + id });
        mainAction = 'restored:' + rec.mainPrevState;
      }
      // 明细子主题归档
      let childAction = null;
      if (rec.childId) {
        const row = this.be.getTopicById(rec.childId);
        if (row && row.state !== 'archived') { this._transition(rec.childId, 'archived', { actor: ident.actor, why: 'merge-undo', at, detail: { mergeId: id } }); childAction = 'archived'; }
      }
      // [task-18] 还原层级：转挂到主主题的明细回原父；复用的主主题恢复原 parent（人工已调整过的不覆盖）
      const reparentedBack = [];
      for (const rp of rec.reparent || []) {
        if (this._mergeParentOf(rp.id) !== rec.mainId) continue;
        this._metaSet('parent:' + rp.id, rp.from);
        reparentedBack.push(rp);
      }
      if (!rec.mainWasCreated && rec.mainParentId && rec.mainPrevParent) this._metaSet('parent:' + rec.mainId, rec.mainPrevParent);
      // 视图关闭 + 记录更新
      this._metaSet('merge.view:' + rec.mainId, '');
      if (rec.childId) this._metaSet('merge.view:' + rec.childId, '');
      const rec2 = { ...rec, undoneAt: at, undoneBy: ident.actor, reparentedBack };
      this._setJsonMeta('merge.record:' + id, rec2);
      this._audit('topic.merge.undo', {
        at, topicId: rec.mainId, actor: ident.actor,
        detail: { mergeId: id, restored, mainAction, childAction, reparentedBack, physicalDelete: false,
          note: '参考式合并：源主题句子从未被移动/复制，undo 只还原状态/父指针与视图标记' },
      });
      const afterTopics = this.be.listTopics();
      result = {
        ok: true, changed: restored.length + (mainAction ? 1 : 0) + (childAction ? 1 : 0) + reparentedBack.length, mergeId: id,
        restored, mainAction, childAction, reparentedBack,
        stats: {
          topics: afterTopics.length,
          active: afterTopics.filter((t) => t.state === 'active').length,
          sentences: afterTopics.reduce((a, t) => a + (this.be.listSentences(t.id) || []).length, 0),
        },
      };
    });
    return result;
  }

  /** 合并记录清单（含 undone；按时间倒序） */
  listMerges({ includeUndone = true } = {}) {
    const ids = this._jsonMeta('merge.index', []);
    const out = [];
    for (const id of ids) {
      const rec = this._jsonMeta('merge.record:' + id, null);
      if (!rec) continue;
      if (!includeUndone && rec.undoneAt) continue;
      out.push({
        mergeId: rec.mergeId, at: rec.at, actor: rec.actor, title: rec.title,
        mainId: rec.mainId, childId: rec.childId || null,
        sources: (rec.sources || []).map((s) => s.id),
        keepCount: (rec.keep || []).length, childCount: (rec.child || []).length,
        undoneAt: rec.undoneAt || null, sig: rec.sig,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // ======================================================================
  // 12. 审计 / 完整性 / 导出
  // ======================================================================
  auditTail(n = 20) { return this.be.listAudit(n); }

  historicShas(topicRef) { return this.be.historicShas(this.resolveTopic(topicRef).id); }

  stateHistory(topicId) {
    return this.be.listAudit(1000)
      .filter((a) => a.topicId === topicId && a.op === 'topic.state')
      .map((a) => ({ at: a.at, from: a.oldText, to: a.newText, actor: a.actor, why: a.detail ? a.detail.why : null }))
      .reverse();
  }

  verify() {
    const bad = [];
    for (const t of this.be.listTopics()) {
      for (const s of this.be.listSentences(t.id)) {
        if (sha16(s.text) !== s.sha) bad.push({ topic: t.id, id: s.id, why: 'sha 不匹配' });
        if (s.text.length !== s.chars) bad.push({ topic: t.id, id: s.id, why: 'chars 不匹配' });
      }
    }
    // [task-18] 层级不变量并入 verify：域无 parent / 项目父必须是域 / 明细父必须是项目 / 跨域禁止 / 环
    const inv = this.assertLevelInvariants();
    for (const v of inv.violations) bad.push({ topic: v.topicId || null, why: 'level-invariant:' + v.code, detail: v });
    return { ok: bad.length === 0, bad, levelInvariants: inv };
  }

  /**
   * 导出 md（逐字、去重视图）。
   * [task-13/L1] 参考式合并后，源主题物理句子仍在（供 readTopic/undo），若原样导出会与主/子视图**重复**；
   *   因此带 active merge 记录的源主题只输出标题 + 一行"已合并入"注释，正文只在视图侧出现一次。
   */
  exportMd() {
    const out = ['# 记忆库导出（由插件渲染，非真源）', ''];
    for (const t of this.topics()) {
      out.push(`## ${t.name}  \`${t.id}\` · ${t.state}`, '');
      if (t.mergedInto) {
        // 源主题：正文/triggers 都不重复输出（triggers 已归并到主主题；正文在主/明细视图各一次）
        out.push(`> 已合并入 ${t.mergedInto}（见视图）`, '');
        continue;
      }
      if (t.activeTriggers && t.activeTriggers.length) out.push(`> triggers: ${t.activeTriggers.join(' / ')}`, '');
      for (const s of this.readTopic(t.id).sentences) out.push(s.text, '');
    }
    return out.join('\n');
  }
}
