// SQLite 后端（首选）
// 契约：正文明文（不加密 —— 用户 2026-10-29 决定），压缩只省空间、不当安全手段。
// 事务：真事务（BEGIN IMMEDIATE / COMMIT / ROLLBACK）。
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  norm        TEXT NOT NULL UNIQUE,
  aliases     TEXT NOT NULL DEFAULT '[]',
  triggers    TEXT NOT NULL DEFAULT '[]',
  state       TEXT NOT NULL DEFAULT 'active',   -- draft/active/dormant/archived/needs_review
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_hit_at INTEGER,
  write_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sentences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  sha        TEXT NOT NULL,
  body       TEXT NOT NULL,          -- 明文（不加密）
  chars      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  src        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sent_ord ON sentences(topic_id, ord);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  op          TEXT NOT NULL,
  topic_id    TEXT,
  sentence_id INTEGER,
  old_sha     TEXT,
  new_sha     TEXT,
  old_text    TEXT,
  new_text    TEXT,
  actor       TEXT,
  detail      TEXT
);
`;

export class SqliteBackend {
  constructor(file) {
    this.kind = 'sqlite';
    this.file = file;
    this._txDepth = 0;              // 事务嵌套深度（Lead 裁决B：嵌套不重复 BEGIN）
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  close() { try { this.db.close(); } catch { /* noop */ } }

  // ---- 事务 ----
  // 只做"深度感知"的最小改动（不改 schema、不改既有语义）：
  //   外层：真 BEGIN IMMEDIATE / COMMIT / ROLLBACK
  //   嵌套层：只计数，不重复 BEGIN，避免 sqlite 的 "cannot start a transaction within a transaction"
  //   嵌套层不单独回滚自身语句（sqlite 无 SAVEPOINT 时不支持部分回滚）⇒
  //     内层异常应向上冒泡，由外层 ROLLBACK 整批撤回（store.runInTransaction 的约定）。
  begin() {
    if (this._txDepth > 0) { this._txDepth += 1; return; }
    this.db.exec('BEGIN IMMEDIATE');
    this._txDepth = 1;
  }
  commit() {
    if (this._txDepth > 1) { this._txDepth -= 1; return; }
    if (this._txDepth === 1) {
      this.db.exec('COMMIT');
      this._txDepth = 0;
    }
  }
  rollback() {
    if (this._txDepth > 1) { this._txDepth -= 1; return; }
    if (this._txDepth === 1) {
      try { this.db.exec('ROLLBACK'); } finally { this._txDepth = 0; }
    }
  }
  transactionDepth() { return this._txDepth; }

  /**
   * 不变量自检（Lead P0 修复要求）：事务结束后深度必须归 0。
   * 之前这里残留过一个同名裸 `rollback()` 覆盖了深度感知版 ⇒ 回滚后深度永久=1、
   * 后续事务静默退化成 autocommit（回滚空转 + 性能回退）。此方法用于把该缺陷变成显式报错。
   */
  assertDepth0(label = '') {
    if (this._txDepth !== 0) {
      throw new Error(`事务深度泄漏：${label || 'tx'} 后 _txDepth=${this._txDepth}（应为 0）`);
    }
    return true;
  }

  // ---- topics ----
  listTopics() {
    return this.db.prepare('SELECT * FROM topics ORDER BY id').all().map(row2topic);
  }
  getTopicById(id) {
    const r = this.db.prepare('SELECT * FROM topics WHERE id=?').get(id);
    return r ? row2topic(r) : null;
  }
  getTopicByNorm(norm) {
    const r = this.db.prepare('SELECT * FROM topics WHERE norm=?').get(norm);
    return r ? row2topic(r) : null;
  }
  nextTopicId() {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM topics').get();
    const n = r && r.m ? parseInt(String(r.m).replace('T-', ''), 10) + 1 : 1;
    return 'T-' + String(n).padStart(4, '0');
  }
  insertTopic(t) {
    this.db.prepare('INSERT INTO topics (id,name,norm,aliases,triggers,state,created_at,updated_at,last_hit_at,write_count) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.name, t.norm, JSON.stringify(t.aliases || []), JSON.stringify(t.triggers || []),
        t.state || 'active', t.createdAt, t.updatedAt, t.lastHitAt || null, t.writeCount || 0);
  }
  updateTopic(id, patch) {
    const cur = this.getTopicById(id);
    if (!cur) throw new Error('topic not found: ' + id);
    const next = { ...cur, ...patch };
    // [4.5.7 P0] patch 带 norm 时必须持久化：原 SQL 不写 norm ⇒ rename 后新名 exact 不中、旧名 exact 仍中、
    //   冲突检测失真（sqlite/ledger 行为分叉）。不带 norm 的既有调用方沿用当前值（零行为变化）。
    const nextNorm = next.norm != null ? String(next.norm) : String(cur.norm || '');
    this.db.prepare('UPDATE topics SET name=?,norm=?,aliases=?,triggers=?,state=?,updated_at=?,last_hit_at=?,write_count=? WHERE id=?')
      .run(next.name, nextNorm, JSON.stringify(next.aliases), JSON.stringify(next.triggers), next.state,
        next.updatedAt, next.lastHitAt || null, next.writeCount || 0, id);
  }

  // ---- sentences ----
  listSentences(topicId) {
    return this.db.prepare('SELECT * FROM sentences WHERE topic_id=? ORDER BY ord').all(topicId)
      .map((r) => ({ id: r.id, topicId: r.topic_id, ord: r.ord, sha: r.sha, text: r.body, chars: r.chars, src: r.src, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  nextOrd(topicId) {
    const r = this.db.prepare('SELECT COALESCE(MAX(ord),0) AS m FROM sentences WHERE topic_id=?').get(topicId);
    return r.m + 1;
  }
  insertSentence(s) {
    const id = Number(this.db.prepare('INSERT INTO sentences (topic_id,ord,sha,body,chars,created_at,updated_at,src) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.topicId, s.ord, s.sha, s.text, s.chars, s.createdAt, s.updatedAt, s.src || null).lastInsertRowid);
    return id;
  }
  getSentenceSha(id) {
    const r = this.db.prepare('SELECT sha FROM sentences WHERE id=?').get(id);
    return r ? r.sha : null;
  }
  updateSentence(id, { text, sha, chars, updatedAt }) {
    this.db.prepare('UPDATE sentences SET body=?,sha=?,chars=?,updated_at=? WHERE id=?').run(text, sha, chars, updatedAt, id);
  }

  /** task-45：物理移动单句到另一主题（splitTopic 用；不动 sha 墓碑） */
  moveSentence(id, { topicId, ord }) {
    const r = this.db.prepare('UPDATE sentences SET topic_id=?, ord=? WHERE id=?').run(topicId, ord, id);
    return r.changes > 0;
  }

  // ---- audit ----
  appendAudit(a) {
    this.db.prepare('INSERT INTO audit (at,op,topic_id,sentence_id,old_sha,new_sha,old_text,new_text,actor,detail) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(a.at, a.op, a.topicId || null, a.sentenceId || null, a.oldSha || null, a.newSha || null,
        a.oldText == null ? null : a.oldText, a.newText == null ? null : a.newText, a.actor || null, a.detail ? JSON.stringify(a.detail) : null);
  }
  listAudit(limit = 50) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(row2audit);
  }
  historicShas(topicId) {
    const rows = this.db.prepare('SELECT old_sha,new_sha FROM audit WHERE topic_id=? AND (old_sha IS NOT NULL OR new_sha IS NOT NULL)').all(topicId);
    const s = new Set();
    for (const r of rows) { if (r.old_sha) s.add(r.old_sha); if (r.new_sha) s.add(r.new_sha); }
    return s;
  }

  // ---- meta ----
  getMeta(k) { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null; }
  setMeta(k, v) { this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)); }
  deleteMeta(k) { this.db.prepare('DELETE FROM meta WHERE key=?').run(k); }
}

function row2topic(r) {
  return {
    id: r.id, name: r.name, norm: r.norm,
    aliases: JSON.parse(r.aliases || '[]'),
    triggers: JSON.parse(r.triggers || '[]'),
    state: r.state,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastHitAt: r.last_hit_at, writeCount: r.write_count,
  };
}
function row2audit(r) {
  return {
    id: r.id, at: r.at, op: r.op, topicId: r.topic_id, sentenceId: r.sentence_id,
    oldSha: r.old_sha, newSha: r.new_sha, oldText: r.old_text, newText: r.new_text,
    actor: r.actor, detail: r.detail ? JSON.parse(r.detail) : null,
  };
}
