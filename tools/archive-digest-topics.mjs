/**
 * 一次性工具：归档「子代理对话摘要」四主题（T-0436 / T-0578 / T-0579 / T-0580）
 *
 * 背景：这 4 个主题是 digest 通道（子代理摘要归档）的产物，该通道已于 2026-11-05 停写、
 * 能力由 `session_search list:true` 替代（4.5.6 已验收）。用户裁决方案 A：转 archived。
 *
 * 依据：原文（子代理会话日志）仍可被 `session_search` 检索 ⇒ 归档派生物不丢信息；
 * 留着会占注入预算、干扰 memory_topics 与主题卫生指标。
 *
 * 用法：
 *   node tools/archive-digest-topics.mjs            # dry-run（只读，打印将归档什么）
 *   node tools/archive-digest-topics.mjs --apply    # 写库（写前 WAL checkpoint + VACUUM INTO 备份）
 *
 * 安全：--apply 前检查 WAL checkpoint 结果；busy≠0 ⇒ 有活动连接，拒绝继续。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const TARGETS = ["T-0436", "T-0578", "T-0579", "T-0580"];
const REASON = "digest-retired";

const apply = process.argv.includes("--apply");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, ".dsh");
const MEM_ROOT = process.env.MEMORY_ROOT || path.join(DSH_HOME, "memory");
const DB_PATH = path.join(MEM_ROOT, ".memtopic", "mem.db");

function resolveMemtopicDir() {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const cands = [
    process.env.MEMTOPIC_DIR,
    path.join(selfDir, "..", "memtopic"),
    path.join(MEM_ROOT, "memtopic"),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, "src", "memory-store.mjs"))) return c;
  }
  return null;
}

function sqlQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function backupDb(db) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = DB_PATH + ".bak-archive-digest-" + stamp;
  try { db.exec("VACUUM INTO " + sqlQuote(target)); }
  catch (e) {
    fs.copyFileSync(DB_PATH, target);
  }
  return target;
}

function checkpointOk(db) {
  try {
    const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return { ok: Number(r && r.busy || 0) === 0, raw: r };
  } catch (e) { return { ok: false, raw: String(e && e.message || e) }; }
}

const memtopicDir = resolveMemtopicDir();
if (!memtopicDir) { console.error("❌ 未找到 memtopic/src"); process.exit(1); }
if (!fs.existsSync(DB_PATH)) { console.error("❌ 库不存在：" + DB_PATH); process.exit(1); }

const storeMod = await import(pathToFileURL(path.join(memtopicDir, "src", "memory-store.mjs")).href);
const backendMod = await import(pathToFileURL(path.join(memtopicDir, "src", "backend-sqlite.mjs")).href);

// dry-run 用只读连接；apply 用读写连接
const be = new backendMod.SqliteBackend(DB_PATH);
const store = new storeMod.MemoryStore(be);
const db = be.db || be._db || null;

const tomb = (() => {
  try { return JSON.parse(String(be.getMeta("deleted.index") || "[]")); } catch (e) { return []; }
})();
const tombIds = new Set((Array.isArray(tomb) ? tomb : []).map((x) => (x && (x.sentenceId ?? x.id))).filter((x) => x != null));

function liveOf(id) {
  const rows = (be.listSentences ? be.listSentences(id) : []) || [];
  return rows.filter((r) => !tombIds.has(r.id));
}

console.log("库：" + DB_PATH);
console.log("模式：" + (apply ? "APPLY（写库）" : "DRY-RUN（只读）"));
console.log("");

const plan = [];
for (const id of TARGETS) {
  let t = null;
  try { t = store.readTopic(id); } catch (e) { t = null; }
  if (!t || !t.id) { console.log(id + "  —— 不存在，跳过"); continue; }
  const live = t.sentences || [];
  const chars = live.reduce((a, r) => a + String(r.text ?? r.body ?? "").length, 0);
  plan.push({ id: t.id, name: t.name, state: t.state, sentences: live.length, chars });
  console.log(
    t.id + "  [" + t.state + "]  「" + String(t.name).slice(0, 40) + "」  句=" + live.length + " 字=" + chars
  );
}

console.log("");
console.log("合计：" + plan.length + " 个主题 / " + plan.reduce((a, p) => a + p.chars, 0) + " 字");

if (!plan.length) { console.log("没有可归档的主题。"); process.exit(0); }
if (plan.some((p) => p.state === "archived")) {
  console.log("⚠️ 其中有已归档主题（幂等，会跳过）。");
}

if (!apply) {
  console.log("");
  console.log("（dry-run 完成，未写库。确认无误后加 --apply 执行；写前会自动 WAL checkpoint + VACUUM INTO 备份。）");
  process.exit(0);
}

// ---- apply ----
const ck = checkpointOk(db);
if (!ck.ok) { console.error("❌ WAL checkpoint 未通过（可能有活动连接）：" + JSON.stringify(ck.raw)); process.exit(2); }
const backup = backupDb(db);
console.log("已备份：" + backup + "（" + (fs.statSync(backup).size / 1024 / 1024).toFixed(2) + " MB）");
console.log("");

let done = 0;
for (const p of plan) {
  if (p.state === "archived") { console.log(p.id + " 已是 archived，跳过"); continue; }
  try {
    store.archiveTopic(p.id, { actor: "runtime", reason: REASON, pointer: true });
    console.log("✅ " + p.id + " → archived");
    done++;
  } catch (e) {
    console.error("❌ " + p.id + " 失败：" + ((e && e.message) || e));
  }
}

console.log("");
console.log("完成：" + done + " 个主题已归档。");
