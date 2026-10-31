// 存储后端能力探测（阶段 1）
// 目标：新装用户环境不可控（Electron/Node 版本不一），绝不能因存储把用户搞崩。
// 探测顺序：node:sqlite → 失败即降级 ledger（零依赖）。探测失败原因必须可解释。
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

export function detectSqlite() {
  if (process.env.MEMTOPIC_NO_SQLITE === '1') {
    return { ok: false, kind: 'sqlite', reason: 'env MEMTOPIC_NO_SQLITE=1（压测/演练用）' };
  }
  try {
    const mod = require_('node:sqlite');
    const { DatabaseSync } = mod;
    if (typeof DatabaseSync !== 'function') {
      return { ok: false, kind: 'sqlite', reason: 'node:sqlite 存在但无 DatabaseSync' };
    }
    // 真做一次建表 + 写入 + 事务，避免"能 require 但实际不可用"
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER)');
    db.exec('BEGIN');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    db.exec('COMMIT');
    const n = db.prepare('SELECT COUNT(*) AS n FROM t').get().n;
    db.close();
    if (n !== 1) return { ok: false, kind: 'sqlite', reason: '自检写入未生效' };
    return { ok: true, kind: 'sqlite', reason: 'node:sqlite 自检通过' };
  } catch (e) {
    return { ok: false, kind: 'sqlite', reason: (e && e.code ? e.code + ': ' : '') + ((e && e.message) || String(e)) };
  }
}

export function pickBackendKind() {
  const forced = process.env.MEMTOPIC_BACKEND;
  if (forced === 'ledger') return { kind: 'ledger', reason: 'env MEMTOPIC_BACKEND=ledger（强制）' };
  const d = detectSqlite();
  if (d.ok) return { kind: 'sqlite', reason: d.reason };
  return { kind: 'ledger', reason: 'sqlite 不可用 → 降级 ledger（' + d.reason + '）' };
}
