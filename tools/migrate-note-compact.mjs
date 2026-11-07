#!/usr/bin/env node
/**
 * dsh-memory · 4.5.2「笔记收敛」历史迁移脚本（**默认 dry-run**，`--apply` 才写库）
 * ============================================================================
 * 做什么（docs/方案-4.5.2-笔记收敛.md §13.1-C3' + §12.2-M6/M7 定稿）：
 *   只处理「**最后一句是 legacy marker**（`已提炼 → T-xxxx`）」的 `笔记·` 主题：
 *     ① 同一事务内删除 marker **之前**的所有句（它们已被 P0-1 过滤，永不再提炼，也不该继续占正文）；
 *     ② marker 句**就地** replace 成新指针格式（不增不减、不重排）：
 *        `<YYYY-MM-DD> 已提炼 <N> 句 → <T-id 列表>（原文 session_search sid8=<sid8> 可回溯）`
 *   ⇒ 迁移后主题 = 1 条指针句（「已提炼完」唯一判据），不会反复进 dream。
 *
 * 绝对不做：
 *   · 不碰「最后一句不是 marker/指针」的主题（部分提炼 / 未提炼 ⇒ 原样不动，C3' 防误伤）；
 *   · 不碰新指针格式主题（已是 4.5.2 口径 ⇒ no-op 跳过）；
 *   · 不新建/不删除主题、不改状态、不动其它主题。
 *
 * 安全：
 *   · 写前 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO` 备份 mem.db（失败回退复制 db+wal+shm）；
 *   · `--apply` 全部主题写入包在**一个事务**里（任一失败整体回滚）；
 *   · `--dry-run` 先打印对账表（主题 / 句数变化 / 删除数 / 新指针 / 跳过原因）。
 *
 * 用法：
 *   node tools/migrate-note-compact.mjs                 # dry-run（默认）
 *   node tools/migrate-note-compact.mjs --apply         # 真正写库（单事务 + 自动备份）
 *   node tools/migrate-note-compact.mjs --db <mem.db>   # 指定库（测试/演练用副本）
 *   node tools/migrate-note-compact.mjs --json          # dry-run 额外打印 JSON 计划
 *   node tools/migrate-note-compact.mjs --limit 20      # 明细最多打印 n 条（默认 50）
 *   node tools/migrate-note-compact.mjs --help
 *
 * 依赖：`node:sqlite`（Node ≥22.5）+ 插件同目录 `memtopic/src/*`（零第三方依赖）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, ".dsh", "memory", ".memtopic", "mem.db");

// ───────────────────────────── 共享判据（与 index.js 同口径） ─────────────────────────────
const NOTE_TOPIC_PREFIX_RE = /^笔记·/;
const NOTE_POINTER_RE = /(已提炼\s*→\s*T-\d+)|(^\d{4}-\d{2}-\d{2} 已提炼 \d+ 句 → T-\d+)/;
const LEGACY_MARKER_RE = /^已提炼\s*→\s*T-\d+/;
const isNoteTopicName = (n) => NOTE_TOPIC_PREFIX_RE.test(String(n == null ? "" : n));
const isNotePointerText = (t) => NOTE_POINTER_RE.test(String(t == null ? "" : t));
const isLegacyMarker = (t) => LEGACY_MARKER_RE.test(String(t == null ? "" : t).trim());
const notePointerTargets = (p) => [...new Set(String(p == null ? "" : p).match(/T-\d+/g) || [])];
function parseSessionTopicName(name) {
  const raw = String(name == null ? "" : name).trim();
  const m = /^([^\s/\\]{1,200})\/([0-9a-f]{8})(?:\s*[·・]\s*([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  return { wsKey: m[1], sid8: m[2], title: m[3] == null ? null : (String(m[3]).trim() || null) };
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function noteFormatPointer({ count, targets, sid8 }) {
  const list = [...new Set((targets || []).map(String).filter((x) => /^T-\d+$/.test(x)))];
  return todayStr() + " 已提炼 " + Math.max(0, Math.floor(Number(count) || 0)) + " 句 → " + (list.join("/") || "T-0000")
    + (sid8 ? "（原文 session_search sid8=" + sid8 + " 可回溯）" : "");
}

// ───────────────────────────── CLI ─────────────────────────────
function usage() {
  return [
    "4.5.2 笔记收敛历史迁移（默认 dry-run；--apply 才写库）",
    "",
    "  node tools/migrate-note-compact.mjs [选项]",
    "",
    "选项：",
    "  --apply            写库（单事务 + 写前 PRAGMA wal_checkpoint(TRUNCATE) + VACUUM INTO 备份）",
    "  --force            跳过「DSH 宿主在运行」检查（仅演练/确知无并发写入时用；默认拒绝在宿主运行时 --apply）",
    "  --db <path>        指定 mem.db（默认 ~/.dsh/memory/.memtopic/mem.db）",
    "  --json             dry-run 时额外打印 JSON 计划",
    "  --limit <n>        明细最多打印 n 条（默认 50）",
    "  --verbose          打印每条 skipped 原因",
    "  --help             本帮助",
    "",
    "规则：只处理「最后一句是 legacy marker（已提炼 → T-xxxx）」的 笔记· 主题：",
    "  同一事务内删 marker 之前所有句 + marker 就地改写为新指针格式（不增不减、不重排）。",
  ].join("\n");
}
function parseArgs(argv) {
  const o = { apply: false, db: DEFAULT_DB, json: false, limit: 50, verbose: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--force") o.force = true;
    else if (a === "--json") o.json = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--db") o.db = String(argv[++i] || "");
    else if (a === "--limit") o.limit = Math.max(1, Number(argv[++i]) || 50);
    else if (a === "--help" || a === "-h") { console.log(usage()); process.exit(0); }
    else if (a.startsWith("--")) { console.error("未知参数：" + a + "\n\n" + usage()); process.exit(2); }
  }
  if (!o.db) { console.error("--db 需要路径"); process.exit(2); }
  return o;
}

// ───────────────────────────── 只读快照（dry-run 与 apply 共用） ─────────────────────────────
function readSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 8000");
    const topics = db.prepare("SELECT id,name,state FROM topics ORDER BY id").all();
    const sentsStmt = db.prepare("SELECT id,ord,sha,body FROM sentences WHERE topic_id=? ORDER BY ord");
    // [D7 墓碑过滤] `sentences` 物理行保留已删句（soft delete），读路径按 meta.deleted.index 过滤；
    //   迁移是**直接 SQL 读**，必须复刻同一过滤，否则：
    //   ① 中间墓碑会被当成"要删的旧句"（deleteSentence 抛 SENTENCE_NOT_FOUND 被吞 → 计数虚高）；
    //   ② 末句是墓碑时会把墓碑误判成 marker（replaceSentence 抛 TEXT_NOT_FOUND → 整事务回滚）。
    let tombIds = new Set();
    let tombLegacy = new Map();   // topicId -> Set<sha>（早期无 sentenceId 的写法，按 sha 兜底）
    let tombCountByTopic = new Map();   // [句数修复] topicId -> 墓碑条数（用于算「已提炼 N 句」）
    try {
      const raw = db.prepare("SELECT value FROM meta WHERE key='deleted.index'").get();
      const arr = raw ? JSON.parse(String(raw.value)) : [];
      const topicOfSentence = new Map();   // sentenceId -> topicId（旧式 entry 可能缺 topicId，用物理行反查）
      const stmtTopicOfSent = db.prepare("SELECT topic_id FROM sentences WHERE id=?");
      const bump = (tid) => { const k = String(tid == null ? "" : tid); if (!k) return; tombCountByTopic.set(k, (tombCountByTopic.get(k) || 0) + 1); };
      for (const e of (Array.isArray(arr) ? arr : [])) {
        if (!e) continue;
        if (e.sentenceId != null) {
          const sid = Number(e.sentenceId);
          tombIds.add(sid);
          let tid = (e.topicId == null ? null : String(e.topicId));
          if (tid == null) {
            if (!topicOfSentence.has(sid)) { try { const r = stmtTopicOfSent.get(sid); topicOfSentence.set(sid, r ? String(r.topic_id) : ""); } catch (eQ) { topicOfSentence.set(sid, ""); } }
            tid = topicOfSentence.get(sid);
          }
          bump(tid);
        } else if (e.sha) {
          const tk = String(e.topicId == null ? "" : e.topicId);
          if (!tombLegacy.has(tk)) tombLegacy.set(tk, new Set());
          tombLegacy.get(tk).add(String(e.sha));
          bump(tk);
        }
      }
    } catch (eT) { tombIds = new Set(); tombLegacy = new Map(); tombCountByTopic = new Map(); console.warn("⚠ 墓碑索引读取失败（按无墓碑处理）：" + ((eT && eT.message) || eT)); }
    const isTomb = (topicId, r) => tombIds.has(Number(r.id)) || (tombLegacy.get(String(topicId)) || new Set()).has(String(r.sha || ""));
    const tombCountOf = (topicId) => tombCountByTopic.get(String(topicId)) || 0;
    const plan = [];
    for (const t of topics) {
      if (!isNoteTopicName(t.name)) continue;
      const rawRows = sentsStmt.all(t.id).map((r) => ({ id: Number(r.id), ord: Number(r.ord), sha: String(r.sha || ""), text: String(r.body || "") }));
      const tombstoned = rawRows.filter((r) => isTomb(t.id, r)).length;
      const rows = rawRows.filter((r) => !isTomb(t.id, r));   // 只对 live 句做判据/删除计划
      const item = { topicId: String(t.id), name: String(t.name), state: String(t.state || ""), before: rows.length, rawBefore: rawRows.length, tombstoned: tombstoned, refined: 0, action: "skip", reason: "", deletes: [], pointer: "", after: rows.length };
      if (!rows.length) { item.reason = "empty-topic"; plan.push(item); continue; }
      const last = rows[rows.length - 1];
      if (isNotePointerText(last.text) && !isLegacyMarker(last.text)) { item.reason = "already-pointer"; plan.push(item); continue; }
      if (!isLegacyMarker(last.text)) { item.reason = "last-not-marker"; plan.push(item); continue; }
      const targets = notePointerTargets(last.text);
      if (!targets.length) { item.reason = "marker-without-target"; plan.push(item); continue; }
      const parsed = parseSessionTopicName(String(t.name));
      const sid8 = parsed ? parsed.sid8 : "";
      const deletes = rows.slice(0, -1);
      // [句数修复] 已提炼句数 = marker 前 live 句数 + 该主题墓碑数（删除只来自收敛/迁移且为软删除，
      //   每句墓碑都带 topicId ⇒ 可考；写 0 会往库里留假数据。兼容旧式缺 topicId 的 entry：按 sentenceId 反查物理行。）
      const refined = deletes.length + tombCountOf(t.id);
      item.action = "migrate";
      item.reason = "legacy-marker";
      item.deletes = deletes.map((r) => r.id);
      item.refined = refined;
      item.pointer = noteFormatPointer({ count: refined, targets, sid8 });
      item.after = 1;
      plan.push(item);
    }
    return { db, plan };
  } catch (e) {
    try { db.close(); } catch (e2) { /* noop */ }
    throw e;
  }
}

function printPlan(plan, o) {
  const migrate = plan.filter((x) => x.action === "migrate");
  const skip = plan.filter((x) => x.action !== "migrate");
  const skippedBy = {};
  for (const s of skip) skippedBy[s.reason] = (skippedBy[s.reason] || 0) + 1;
  console.log("== 4.5.2 笔记收敛迁移" + (o.apply ? "（--apply 写库）" : "（dry-run，不写库）") + " ==");
  console.log("笔记主题总数：" + plan.length + " · 待迁移 " + migrate.length + " · 跳过 " + skip.length
    + (skip.length ? "（" + Object.keys(skippedBy).map((k) => k + "=" + skippedBy[k]).join("、") + "）" : ""));
  console.log("");
  if (migrate.length) {
    console.log("对账表（待迁移，最多 " + o.limit + " 条）：");
    for (const m of migrate.slice(0, o.limit)) {
      console.log("  " + m.topicId + "「" + m.name + "」 句 " + m.before + " → " + m.after + "（删 " + m.deletes.length + "，已提炼 " + m.refined + " 句）"
        + (m.tombstoned ? "（墓碑已过滤 " + m.tombstoned + "）" : ""));
      console.log("     新指针：" + m.pointer);
    }
    if (migrate.length > o.limit) console.log("  … 另有 " + (migrate.length - o.limit) + " 条（--limit 调大）");
  } else {
    console.log("（没有需要迁移的主题）");
  }
  if (o.verbose && skip.length) {
    console.log("");
    console.log("跳过明细：");
    for (const s of skip) console.log("  " + s.topicId + "「" + s.name + "」 reason=" + s.reason);
  }
  console.log("");
  console.log("合计：删除旧句 " + migrate.reduce((a, x) => a + x.deletes.length, 0) + " 条；改写 marker " + migrate.length + " 条");
  return { migrate, skip, skippedBy };
}

// ───────────────────────────── 写前备份 ─────────────────────────────
function sqlQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function backupDb(db, dbPath) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = dbPath + ".bak-note-compact-" + ts;
  if (fs.existsSync(target)) throw new Error("备份目标已存在：" + target);
  let mode = "vacuum-into";
  try { db.exec("VACUUM INTO " + sqlQuote(target)); }
  catch (e) {
    mode = "file-copy";
    try { fs.copyFileSync(dbPath, target); } catch (e2) {
      throw new Error("备份失败（VACUUM INTO：" + ((e && e.message) || e) + "；复制：" + ((e2 && e2.message) || e2) + "）");
    }
    for (const ext of ["-wal", "-shm"]) { try { if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, target + ext); } catch (e3) { /* noop */ } }
  }
  return { path: target, size: fs.existsSync(target) ? fs.statSync(target).size : 0, mode };
}

function resolveMemtopicDir() {
  const cands = [process.env.MEMTOPIC_DIR, path.join(PLUGIN_DIR, "memtopic"), path.join(HERE, "..", "memtopic")].filter(Boolean);
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, "src", "memory-store.mjs")) && fs.existsSync(path.join(d, "src", "backend-sqlite.mjs"))) return d;
    } catch (e) { /* noop */ }
  }
  return null;
}

// ───────────────────────────── --apply ─────────────────────────────
async function applyPlan(dbPath, plan, o) {
  const migrate = plan.filter((x) => x.action === "migrate");
  if (!migrate.length) return { migrated: 0, errors: [] };
  const memtopicDir = resolveMemtopicDir();
  if (!memtopicDir) throw new Error("未找到 memtopic/src（可用 MEMTOPIC_DIR 指定）");
  const storeMod = await import(pathToFileURL(path.join(memtopicDir, "src", "memory-store.mjs")).href);
  const backendMod = await import(pathToFileURL(path.join(memtopicDir, "src", "backend-sqlite.mjs")).href);
  const be = new backendMod.SqliteBackend(dbPath);
  const store = new storeMod.MemoryStore(be);
  const errors = [];
  let migrated = 0;
  // [句数修复] 与 dry-run 同口径：已提炼句数 = marker 前 live 句数 + 该主题墓碑数
  //   （删除只来自收敛/迁移且为软删除，meta.deleted.index 每条带 topicId；旧式缺 topicId 时按 sentenceId 反查物理行）
  const tombCountByTopic = (() => {
    const map = new Map();
    try {
      const raw = be.getMeta ? be.getMeta("deleted.index") : null;
      const arr = raw ? JSON.parse(String(raw)) : [];
      const sidTopic = new Map();
      for (const e of (Array.isArray(arr) ? arr : [])) {
        if (!e) continue;
        let tid = (e.topicId == null ? null : String(e.topicId));
        if (tid == null && e.sentenceId != null) {
          const sid = Number(e.sentenceId);
          if (!sidTopic.has(sid)) {
            try { const r = be.db.prepare("SELECT topic_id FROM sentences WHERE id=?").get(sid); sidTopic.set(sid, r ? String(r.topic_id) : ""); }
            catch (eQ) { sidTopic.set(sid, ""); }
          }
          tid = sidTopic.get(sid);
        }
        if (!tid) continue;
        map.set(tid, (map.get(tid) || 0) + 1);
      }
    } catch (eT) { /* 墓碑不可读 ⇒ 按 0 计（与旧行为一致，不阻断迁移） */ }
    return (tid) => map.get(String(tid)) || 0;
  })();
  try {
    try { be.db.exec("PRAGMA busy_timeout = 8000"); } catch (e) { /* noop */ }
    // 单事务：任一主题失败 ⇒ 整体回滚（M7）
    store.runInTransaction(() => {
      for (const m of migrate) {
        const st = (store.readTopic(m.topicId).sentences || []);
        if (!st.length) { errors.push(m.topicId + "：读回为空，跳过"); continue; }
        const last = st[st.length - 1];
        if (!isLegacyMarker(last.text)) { errors.push(m.topicId + "：最后一句已不是 legacy marker（并发变更），跳过"); continue; }
        const targets = notePointerTargets(last.text);
        if (!targets.length) { errors.push(m.topicId + "：marker 无 T-id，跳过"); continue; }
        const parsed = parseSessionTopicName(String(m.name));
        const refined = (st.length - 1) + tombCountByTopic(m.topicId);
        const pointer = noteFormatPointer({ count: refined, targets, sid8: parsed ? parsed.sid8 : "" });
        // ① 删 marker 之前的旧句（独立 reason=note-migrate，审计可区分）
        for (const s of st.slice(0, -1)) {
          try { store.deleteSentence(m.topicId, { sentenceId: s.id }, { actor: "runtime", reason: "note-migrate" }); }
          catch (eD) { if (!(eD && eD.code === "SENTENCE_NOT_FOUND")) throw eD; }
        }
        // ② marker 就地改写为新指针（replace 单句；marker 在末尾 ⇒ 无重排风险）
        store.replaceSentence({ topic: m.topicId, oldText: String(last.text), newText: pointer, actor: "runtime" });
        migrated += 1;
      }
    });
  } finally {
    try { be.db.close(); } catch (e) { /* noop */ }
  }
  return { migrated, errors };
}

// ───────────────────────────── D8：宿主检测 + WAL checkpoint 校验 ─────────────────────────────
/** 检测 DSH 宿主进程（Windows: tasklist；macOS/Linux: ps）。返回 {running,names,method,error} */
function detectDshHost() {
  const out = { running: false, names: [], method: "", error: "" };
  try {
    if (process.platform === "win32") {
      out.method = "tasklist";
      const raw = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      for (const line of String(raw).split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line);
        if (!m) continue;
        const name = m[1];
        if (/deepseek\s*harness|^dsh(\.exe)?$/i.test(name)) out.names.push(name);
      }
    } else {
      out.method = "ps";
      const raw = execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8", timeout: 8000 });
      for (const line of String(raw).split(/\r?\n/)) {
        const name = line.trim();
        if (!name) continue;
        if (/deepseek[-_ ]?harness|(^|\/)dsh(\.exe)?$/i.test(name)) out.names.push(name);
      }
    }
    out.running = out.names.length > 0;
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}
/** --apply 前置：宿主在跑 ⇒ 拒绝（--force 可显式跳过，仅演练用） */
function assertNoHost(o) {
  const h = detectDshHost();
  if (h.error) {
    console.warn("⚠ 无法检测 DSH 宿主是否在运行（" + h.method + "：" + h.error + "）");
    if (!o.force) throw new Error("无法确认宿主已退出（检测失败）：请先完全退出 DSH 后重试，或加 --force 显式跳过");
    return h;
  }
  if (h.running) {
    const msg = "检测到 DSH 宿主在运行（" + h.names.slice(0, 3).join("、") + (h.names.length > 3 ? " 等 " + h.names.length + " 个进程" : "")
      + "）：迁移会与宿主并发写 mem.db。请先**完全退出 DSH**（含托盘/后台进程）后重试；确需演练可加 --force。";
    if (!o.force) throw new Error(msg);
    console.warn("⚠ " + msg + "（已用 --force 跳过宿主检查）");
  } else {
    console.log("宿主检查：未检测到 DSH 进程（" + h.method + "）");
  }
  return h;
}
/** PRAGMA wal_checkpoint(TRUNCATE) 并校验结果（busy≠0 ⇒ 有活动连接，拒绝继续）
 *  [D8 修订] 必须在**可写连接**上执行：readOnly 快照连接在活动写连接下会抛 `disk I/O error`（不是 busy=1），
 *  崩溃遗留 WAL 时还会误挡正常迁移。错误按 code 区分：CHECKPOINT_BUSY / CHECKPOINT_IO / CHECKPOINT_FAIL。 */
function walCheckpointTruncate(db) {
  let r = null;
  try { r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); }
  catch (e) {
    const msg = String((e && e.message) || e);
    const code = /disk\s*I\/O|SQLITE_IOERR|i\/o error/i.test(msg) ? "CHECKPOINT_IO"
      : (/busy|locked/i.test(msg) ? "CHECKPOINT_BUSY" : "CHECKPOINT_FAIL");
    throw Object.assign(new Error("WAL checkpoint 执行失败（" + code + "）：" + msg), { code: code });
  }
  const pick = (k, idx) => {
    if (r && typeof r === "object" && r[k] != null) return Number(r[k]);
    if (Array.isArray(r)) return Number(r[idx]);
    return NaN;
  };
  const busy = pick("busy", 0);
  const logN = pick("log", 1);
  const ck = pick("checkpointed", 2);
  if (!Number.isFinite(busy) || busy !== 0) {
    throw Object.assign(
      new Error("WAL checkpoint 未完成（CHECKPOINT_BUSY，busy=" + (Number.isFinite(busy) ? busy : JSON.stringify(r)) + "）：宿主/其他连接仍在读写 mem.db，拒绝继续（先完全退出 DSH 再重试）"),
      { code: "CHECKPOINT_BUSY", busy: busy, log: logN, checkpointed: ck },
    );
  }
  return { busy: busy, log: logN, checkpointed: ck, raw: r };
}
/** checkpoint 失败的可区分文案（宿主在跑 / WAL 被占 / 磁盘 I/O） */
function explainCheckpointError(e) {
  const code = String((e && e.code) || "");
  const msg = String((e && e.message) || e);
  if (code === "CHECKPOINT_BUSY") {
    return [msg, "  ⇒ 原因：WAL 被占（宿主/其他连接仍在写）。先完全退出 DSH 后重试 --apply；演练可加 --force。"];
  }
  if (code === "CHECKPOINT_IO") {
    return [msg, "  ⇒ 原因：磁盘 I/O 错误（只读介质/权限/库损坏，或崩溃遗留 WAL 被异常占用）。"
      + " 检查磁盘与库权限；确认无 DSH 进程后，可先手动删除 " + "mem.db-wal / mem.db-shm 再重试（删除前务必确认无进程占用）。"];
  }
  return [msg, "  ⇒ 原因：WAL checkpoint 失败（未知）。请先退出 DSH 重试；持续失败请检查磁盘与库完整性（PRAGMA integrity_check）。"];
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(o.db)) { console.error("库不存在：" + o.db); process.exit(1); }
  console.log("库：" + o.db + "（" + (fs.statSync(o.db).size / 1024 / 1024).toFixed(2) + " MB）");
  let snap = readSnapshot(o.db);
  const { db, plan } = snap;
  let res = null;
  try {
    const printed = printPlan(plan, o);
    if (o.json) console.log("\nJSON 计划：\n" + JSON.stringify({ apply: o.apply, plan }, null, 2));
    if (!o.apply) {
      console.log("\n（dry-run 完成，未写库。确认无误后加 --apply 执行；写前会自动 WAL checkpoint + VACUUM INTO 备份。）");
      db.close();
      return;
    }
    if (!printed.migrate.length) { console.log("\n无需迁移，未写库。"); db.close(); return; }
    // [D8] 写前：①宿主检测（在跑就拒绝，--force 才跳过）②**可写连接**上 WAL checkpoint(TRUNCATE) 并校验 busy=0 ③备份
    try {
      assertNoHost(o);
    } catch (eH) {
      console.error("\n✗ 拒绝写库：" + ((eH && eH.message) || eH));
      console.error("  （dry-run 不受影响；确认已完全退出 DSH 后重试 --apply，演练可用 --force）");
      db.close(); process.exitCode = 2; return;
    }
    // [D8 修订] checkpoint/备份都改在**可写连接**上：readOnly 快照连接在活动写连接下会抛 `disk I/O error`（非 busy=1），
    //   崩溃遗留 WAL 时还会误挡正常迁移。先关只读快照连接，再开可写连接做 checkpoint+备份，完成即关。
    try { db.close(); } catch (eDC) { /* 已关闭也无妨 */ }
    let wdb = null;
    try {
      wdb = new DatabaseSync(o.db);
      wdb.exec("PRAGMA busy_timeout = 8000");
    } catch (eW) {
      console.error("\n✗ 拒绝写库：无法打开可写连接（CHECKPOINT_IO）：" + ((eW && eW.message) || eW));
      console.error("  ⇒ 检查库文件权限/磁盘可写性；确认无 DSH 进程占用后重试。");
      process.exitCode = 3; return;
    }
    let ck = null;
    try {
      ck = walCheckpointTruncate(wdb);
      console.log("WAL checkpoint(TRUNCATE)：busy=0，log=" + ck.log + "，checkpointed=" + ck.checkpointed + "（写连接）");
    } catch (eCk) {
      for (const line of explainCheckpointError(eCk)) console.error("\n✗ 拒绝写库：" + line);
      try { wdb.close(); } catch (eC0) { /* noop */ }
      process.exitCode = 3; return;
    }
    const backup = backupDb(wdb, o.db);
    console.log("已备份：" + backup.path + "（" + (backup.size / 1024 / 1024).toFixed(2) + " MB，" + backup.mode + "）");
    try { wdb.close(); } catch (eC1) { /* noop */ }
    const ar = await applyPlan(o.db, plan, o);
    res = { backup, migrated: ar.migrated, errors: ar.errors };
    console.log("已迁移 " + ar.migrated + " 个主题" + (ar.errors.length ? "（" + ar.errors.length + " 条异常，见下）" : ""));
    for (const e of ar.errors.slice(0, 20)) console.log("  ⚠ " + e);
    // 迁移后复核：再跑一次只读快照，应 0 待迁移（幂等）
    const after = readSnapshot(o.db);
    try {
      const left = after.plan.filter((x) => x.action === "migrate");
      console.log("复核：剩余待迁移 " + left.length + " 个" + (left.length ? "（异常，需人工看）" : "（幂等 OK）"));
    } finally { after.db.close(); }
  } finally {
    try { if (snap && snap.db) snap.db.close(); } catch (e) { /* noop */ }
  }
  if (res && res.errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error("迁移失败：" + ((e && e.stack) || e)); process.exit(1); });
