// 零依赖降级后端：append-only 账本文件（.jsonl）
// 用途：node:sqlite 不可用的环境（Electron/Node 版本差异、安装包裁剪）。
// 契约与 SqliteBackend 完全一致；差别只在物理形态。
// 事务：操作先入缓冲并即时应用到内存；commit 时一次 append + fsync；rollback 时从磁盘重放恢复。
import fs from 'node:fs';

export class LedgerBackend {
  constructor(file) {
    this.kind = 'ledger';
    this.file = file;
    this.topics = new Map();     // id -> topic
    this.normIndex = new Map();  // norm -> id
    this.sentences = new Map();  // id -> sentence
    this.ordIndex = new Map();   // topicId -> [sentenceId] (按 ord 升序)
    this.audits = [];            // 完整审计（append-only）
    this.metaMap = new Map();
    this.nextSentId = 1;
    this._tx = null;             // 事务缓冲行
    this._replay();
  }

  close() { /* 无句柄常驻 */ }

  // ---------- 内部 ----------
  _replay() {
    this.topics.clear(); this.normIndex.clear(); this.sentences.clear();
    this.ordIndex.clear(); this.audits = []; this.metaMap.clear(); this.nextSentId = 1;
    if (!fs.existsSync(this.file)) return;
    const txt = fs.readFileSync(this.file, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }   // 半写行（崩溃）跳过，不破坏其余
      this._apply(op);
    }
  }

  _apply(op) {
    switch (op.o) {
      case 'topic.insert': {
        const t = op.v;
        this.topics.set(t.id, { triggers: [], aliases: [], writeCount: 0, lastHitAt: null, state: 'active', ...t });
        this.normIndex.set(t.norm, t.id);
        if (!this.ordIndex.has(t.id)) this.ordIndex.set(t.id, []);
        break;
      }
      case 'topic.update': {
        const cur = this.topics.get(op.id);
        if (!cur) break;
        const next = { ...cur, ...op.v };
        if (op.v.norm && op.v.norm !== cur.norm) { this.normIndex.delete(cur.norm); this.normIndex.set(op.v.norm, op.id); }
        this.topics.set(op.id, next);
        break;
      }
      case 'sent.append': {
        const s = op.v;
        this.sentences.set(s.id, { ...s });
        const arr = this.ordIndex.get(s.topicId) || [];
        arr.push(s.id);
        arr.sort((a, b) => this.sentences.get(a).ord - this.sentences.get(b).ord);
        this.ordIndex.set(s.topicId, arr);
        if (s.id >= this.nextSentId) this.nextSentId = s.id + 1;
        break;
      }
      case 'sent.update': {
        const cur = this.sentences.get(op.id);
        if (cur) this.sentences.set(op.id, { ...cur, ...op.v });
        break;
      }
      case 'sent.move': {
        const cur = this.sentences.get(op.id);
        if (!cur) break;
        const oldArr = (this.ordIndex.get(cur.topicId) || []).filter((x) => x !== op.id);
        if (oldArr.length) this.ordIndex.set(cur.topicId, oldArr); else this.ordIndex.delete(cur.topicId);
        this.sentences.set(op.id, { ...cur, topicId: op.topicId, ord: op.ord });
        const arr = this.ordIndex.get(op.topicId) || [];
        if (!arr.includes(op.id)) arr.push(op.id);
        arr.sort((a, b) => (this.sentences.get(a).ord - this.sentences.get(b).ord));
        this.ordIndex.set(op.topicId, arr);
        break;
      }
      case 'audit': this.audits.push(op.v); break;
      case 'meta': this.metaMap.set(op.k, op.v); break;
      case 'meta.del': this.metaMap.delete(op.k); break;
      default: break;
    }
  }

  _emit(op) {
    if (this._tx) { this._tx.push(op); this._apply(op); return; }
    // ⚠ 关键：非事务路径必须立即落盘，否则"重开就丢"（本 bug 由契约测试 15 抓到）
    this._apply(op);
    this._flush([op]);
  }

  _flush(ops) {
    if (!ops.length) return;
    const data = ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  // ---------- 事务 ----------
  // 深度感知（Lead 裁决B）：外层开缓冲、一次 fsync；嵌套层只计数，不重开缓冲
  //（否则内层 begin() 会把外层的 _tx 覆盖掉，外层提交就丢数据）。
  begin() {
    if (this._txDepth > 0) { this._txDepth += 1; return; }
    this._tx = [];
    this._txDepth = 1;
  }
  commit() {
    if (this._txDepth > 1) { this._txDepth -= 1; return; }
    const ops = this._tx || [];
    this._tx = null;
    this._txDepth = 0;
    this._flush(ops);
  }
  rollback() {
    if (this._txDepth > 1) { this._txDepth -= 1; return; }   // 内层回滚交给外层（整批重放）
    this._tx = null;
    this._txDepth = 0;
    this._replay();                                          // 从磁盘重放，丢弃未提交
  }
  transactionDepth() { return this._txDepth; }

  /** 不变量自检（Lead P0 修复要求）：事务结束后深度必须归 0 */
  assertDepth0(label = '') {
    if (this._txDepth !== 0) {
      throw new Error(`事务深度泄漏：${label || 'tx'} 后 _txDepth=${this._txDepth}（应为 0）`);
    }
    return true;
  }

  // ---------- topics ----------
  listTopics() { return [...this.topics.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(clone); }
  getTopicById(id) { const t = this.topics.get(id); return t ? clone(t) : null; }
  getTopicByNorm(norm) { const id = this.normIndex.get(norm); return id ? clone(this.topics.get(id)) : null; }
  nextTopicId() {
    let max = 0;
    for (const id of this.topics.keys()) { const n = parseInt(String(id).replace('T-', ''), 10); if (n > max) max = n; }
    return 'T-' + String(max + 1).padStart(4, '0');
  }
  insertTopic(t) {
    this._emit({ o: 'topic.insert', v: { ...clone(t), aliases: t.aliases || [], triggers: t.triggers || [], state: t.state || 'active', writeCount: t.writeCount || 0, lastHitAt: t.lastHitAt || null } });
  }
  updateTopic(id, patch) {
    if (!this.topics.get(id)) throw new Error('topic not found: ' + id);
    this._emit({ o: 'topic.update', id, v: clone(patch) });
  }

  // ---------- sentences ----------
  listSentences(topicId) {
    return (this.ordIndex.get(topicId) || []).map((id) => clone(this.sentences.get(id)));
  }
  /** [perf 2026-11-09] 与 SqliteBackend 同签名：内存版一次分组（零 IO）。 */
  listSentencesByTopic() {
    const map = new Map();
    for (const s of this.sentences.values()) {
      const row = { id: s.id, topicId: s.topicId, ord: s.ord, sha: s.sha, text: s.text, chars: s.chars, src: s.src, createdAt: s.createdAt, updatedAt: s.updatedAt };
      if (!map.has(row.topicId)) map.set(row.topicId, []);
      map.get(row.topicId).push(row);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.ord - b.ord);
    return map;
  }
  /** [perf 2026-11-09] 与 SqliteBackend 同签名：全部 meta。 */
  listMeta() { return [...this.metaMap.entries()].map(([key, value]) => ({ key, value })); }
  /** [perf 2026-11-09] 与 SqliteBackend 同签名：正文 token 预过滤（内存版）。 */
  searchSentencesByTokens(tokens) {
    const uniq = [...new Set((Array.isArray(tokens) ? tokens : []).map((x) => String(x == null ? '' : x)).filter((x) => x.trim()))];
    const map = new Map();
    if (!uniq.length) return map;
    for (const s of this.sentences.values()) {
      const low = String(s.text == null ? '' : s.text).toLowerCase();
      if (!uniq.some((t) => low.includes(t))) continue;
      if (!map.has(s.topicId)) map.set(s.topicId, []);
      map.get(s.topicId).push({ id: s.id, text: s.text, src: s.src || '' });
    }
    for (const [tid, arr] of map) { const ordOf = new Map([...this.sentences.values()].filter((x) => x.topicId === tid).map((x) => [x.id, x.ord])); arr.sort((a, b) => (ordOf.get(a.id) || 0) - (ordOf.get(b.id) || 0)); }
    return map;
  }
  /** [perf 2026-11-09] 与 SqliteBackend 同签名：每主题句数/字数和。 */
  sentenceStatsByTopic() {
    const m = new Map();
    for (const s of this.sentences.values()) {
      const cur = m.get(s.topicId) || { topicId: s.topicId, n: 0, chars: 0 };
      cur.n += 1; cur.chars += Number(s.chars || 0);
      m.set(s.topicId, cur);
    }
    return [...m.values()];
  }
  /** [perf 2026-11-09] 与 SqliteBackend 同签名：按 id 批量取句。 */
  sentencesByIds(ids) {
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : [])) { const s = this.sentences.get(Number(id)); if (s) out.push({ id: s.id, topicId: s.topicId, chars: s.chars }); }
    return out;
  }
  nextOrd(topicId) {
    const arr = this.ordIndex.get(topicId) || [];
    return arr.length ? this.sentences.get(arr[arr.length - 1]).ord + 1 : 1;
  }
  insertSentence(s) {
    const id = this.nextSentId++;
    this._emit({ o: 'sent.append', v: { id, ...clone(s) } });
    return id;
  }
  getSentenceSha(id) { const s = this.sentences.get(id); return s ? s.sha : null; }
  updateSentence(id, patch) { this._emit({ o: 'sent.update', id, v: clone(patch) }); }
  /** task-45：物理移动单句到另一主题（splitTopic 用；不动 sha 墓碑） */
  moveSentence(id, { topicId, ord }) {
    if (!this.sentences.has(id)) return false;
    this._emit({ o: 'sent.move', id, topicId, ord });
    return true;
  }

  // ---------- audit / meta ----------
  appendAudit(a) { this._emit({ o: 'audit', v: clone(a) }); }
  listAudit(limit = 50) { return this.audits.slice(-limit).reverse().map(clone); }
  historicShas(topicId) {
    const s = new Set();
    for (const a of this.audits) {
      if (a.topicId !== topicId) continue;
      if (a.oldSha) s.add(a.oldSha);
      if (a.newSha) s.add(a.newSha);
    }
    return s;
  }
  getMeta(k) { return this.metaMap.has(k) ? this.metaMap.get(k) : null; }
  setMeta(k, v) { this._emit({ o: 'meta', k, v: String(v) }); }
  deleteMeta(k) {
    if (!this.metaMap.has(k)) return false;
    this._emit({ o: 'meta.del', k });
    return true;
  }
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }
