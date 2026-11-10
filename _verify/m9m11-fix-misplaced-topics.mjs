// _verify/m9m11-fix-misplaced-topics.mjs — M11 错位工作区线一次性审计与处置（CRA 2026-11-09 MF8）
//
// 背景：4.5.11 之前 fireIntentRetry 用「触发者 agent」当父 ⇒ 重试检查点写进触发者工作区线。
//   生产实证 T-0557：session 1b736c53 真实 cwd=E:\工具\徕卡一瞬，检查点却写进
//   「会话检查点·E-工具-插件开发调整」线 ⇒ 该线的新会话可能被桥接注入（跨项目污染）。
//
// 用法：
//   node _verify/m9m11-fix-misplaced-topics.mjs            # 只扫描（dry-run，不写库）
//   node _verify/m9m11-fix-misplaced-topics.mjs --apply    # 备份 → 扫描 → 归档错位主题 → 重扫
//
// 处置口径（审计 MF8）：只 archive（保留正文/审计），不 delete 句子；处置前备份 mem.db（含 -wal/-shm）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const APPLY = process.argv.includes("--apply");
const HERE = path.dirname(path.resolve(process.argv[1] || "."));
const MEM = process.env.DSH_MEMORY_ROOT || path.join(os.homedir(), ".dsh", "memory");
const DB = process.env.MEMTOPIC_DB || path.join(MEM, ".memtopic", "mem.db");
const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
const p25 = await import(pathToFileURL(path.join(HERE, "..", "p25-topics.js")).href);

function norm(p) { return String(p || "").replace(/\\/g, "/"); }
function findSessionCwd(sid8) {
  try {
    const wsDirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of wsDirs) {
      const dir = path.join(SESSIONS, d.name);
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        if (!n.startsWith("session-" + sid8)) continue;
        const f = path.join(dir, n, "session.v4.jsonl.zstd");
        if (!fs.existsSync(f)) continue;
        try {
          const txt = zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8");
          const first = txt.split("\n")[0];
          const j = JSON.parse(first);
          return String(j.cwd || "");
        } catch (e) { /* 读失败继续找 */ }
      }
    }
  } catch (e) { /* 扫描失败按无法核对处理 */ }
  return null;
}

const store = await (async () => {
  const dir = path.join(HERE, "..");
  const ms = await import(pathToFileURL(path.join(dir, "memtopic", "src", "memory-store.mjs")).href);
  const bs = await import(pathToFileURL(path.join(dir, "memtopic", "src", "backend-sqlite.mjs")).href);
  return new ms.MemoryStore(new bs.SqliteBackend(DB));
})();

function scan() {
  const rows = store.topics() || [];
  const cands = [];
  for (const t of rows) {
    const name = String(t.name || "");
    if (name.startsWith("笔记·")) continue;
    const m = /^([^\s/\\]{1,200})\/([0-9a-f]{8})$/.exec(name);
    if (!m) continue;
    cands.push({ id: t.id, name: name, wsKey: m[1], sid8: m[2], state: String(t.state || "") });
  }
  const out = { total: cands.length, ok: [], mismatch: [], unverifiable: [], archived: [] };
  for (const c of cands) {
    if (c.state === "archived") { out.archived.push(c); continue; }
    const cwd = findSessionCwd(c.sid8);
    if (cwd == null) { out.unverifiable.push(c); continue; }
    const ws = p25.normalizeWorkspace(cwd);
    if (ws && ws === c.wsKey) out.ok.push(c);
    else out.mismatch.push(Object.assign({ cwd: cwd, realWs: ws }, c));
  }
  return out;
}

console.log("== 数据库：" + norm(DB));
const before = scan();
console.log(`[扫描] 候选 ${before.total}｜一致 ${before.ok.length}｜错位 ${before.mismatch.length}｜无法核对 ${before.unverifiable.length}｜已归档 ${before.archived.length}`);
for (const m of before.mismatch) console.log("  ✗ " + m.id + "  " + m.name + "  ← 真实 cwd=" + m.cwd + "（wsKey=" + m.realWs + "）");
for (const u of before.unverifiable) console.log("  ? " + u.id + "  " + u.name + "（session 目录不存在，无法核对）");

if (!APPLY) {
  console.log("[dry-run] 未写库；加 --apply 执行「备份 → 归档错位主题 → 重扫」。");
  process.exit(before.mismatch.length === 0 ? 0 : 2);
}

// ① 备份（含 WAL/SHM；先备份再写）
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const bak = DB + ".bak-pre-m9m11-" + ts;
fs.copyFileSync(DB, bak);
for (const ext of ["-wal", "-shm"]) {
  const f = DB + ext;
  if (fs.existsSync(f)) fs.copyFileSync(f, bak + ext);
}
console.log("[备份] " + norm(bak) + "  (" + fs.statSync(bak).size + " B)");

// ② 归档错位主题（只 archive，不 delete）
let archived = 0;
for (const m of before.mismatch) {
  try {
    const r = store.archiveTopic(m.id, { actor: "runtime", reason: "M11 错位工作区线一次性处置（CRA MF8，真实 cwd=" + m.cwd + "）" });
    archived += 1;
    console.log("[归档] " + m.id + " → " + (r && r.state) + (r && r.pointerSentenceId ? " pointer=" + r.pointerSentenceId : ""));
  } catch (e) {
    console.log("[归档失败] " + m.id + "：" + ((e && e.message) || e));
  }
}

// ③ 重扫
const after = scan();
console.log(`[重扫] 候选 ${after.total}｜一致 ${after.ok.length}｜错位 ${after.mismatch.length}｜无法核对 ${after.unverifiable.length}｜已归档 ${after.archived.length}`);
console.log(JSON.stringify({ db: norm(DB), backup: norm(bak), archived: archived, before: { mismatch: before.mismatch.length, unverifiable: before.unverifiable.length }, after: { mismatch: after.mismatch.length, unverifiable: after.unverifiable.length } }));
try { store.be && store.be.close && store.be.close(); } catch (e) {}
process.exit(after.mismatch.length === 0 ? 0 : 1);
