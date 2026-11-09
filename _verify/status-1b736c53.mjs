/**
 * 会话 1b736c53 现状核查（只读）—— 有效句数 / audit / monitor / cost
 * 有效句 = sentences 物理行 - deleted.index 墓碑（与 store.readTopic 同口径）
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SID8 = "1b736c53";
const MEM = "C:/Users/Starry/.dsh/memory";
const fmt = (t) => new Date(Number(t) || 0).toLocaleString("zh-CN", { hour12: false });

const db = new DatabaseSync(MEM + "/.memtopic/mem.db", { readOnly: true });
const q = (s, ...p) => db.prepare(s).all(...p);
const t = q("SELECT id, name, state, updated_at FROM topics WHERE name LIKE ?", "%/" + SID8)[0];
console.log("=== 主题 ===");
if (!t) { console.log("未找到"); db.close(); process.exit(0); }
console.log(t.name, "| state=" + t.state, "| updated=" + fmt(t.updated_at), "| id=" + t.id);

// 墓碑集合（deleted.index 存在 meta 表）
let deletedIds = new Set();
try {
  const row = q("SELECT value FROM meta WHERE key = 'deleted.index'").slice(-1)[0];
  if (row && row.value) {
    const arr = JSON.parse(row.value);
    if (Array.isArray(arr)) for (const d of arr) if (d && d.sentenceId != null) deletedIds.add(Number(d.sentenceId));
  }
} catch (e) { console.log("[deleted.index 读失败]", e.message); }

const ss = q("SELECT id, ord, chars, src, created_at FROM sentences WHERE topic_id = ? ORDER BY ord", t.id);
const live = ss.filter((s) => !deletedIds.has(Number(s.id)));
console.log("\n=== 句子 ===");
console.log("物理行 =", ss.length, "| 已墓碑 =", ss.length - live.length, "| 有效 =", live.length, live.length === 1 ? "✅ 恒 1 句" : "❌ 异常");
for (const s of ss) console.log("  id=" + s.id, "ord=" + s.ord, "chars=" + s.chars, "src=" + s.src, "created=" + fmt(s.created_at), deletedIds.has(Number(s.id)) ? "[已删]" : "[有效]");

console.log("\n=== audit（最近 10）===");
for (const a of q("SELECT at, op, actor, sentence_id, length(old_text) lo, length(new_text) ln FROM audit WHERE topic_id = ? ORDER BY at DESC LIMIT 10", t.id)) {
  console.log(fmt(a.at), "|", String(a.op).padEnd(16), "| actor=" + String(a.actor || "-").padEnd(8), "| sent=" + a.sentence_id, "old=" + a.lo, "new=" + a.ln);
}
db.close();

// monitor
const mon = JSON.parse(fs.readFileSync(MEM + "/.monitor.json", "utf8"));
const intents = (mon.events || []).filter((e) => e.type === "intent" && String(e.detail || "").includes(SID8));
console.log("\n=== monitor intent（最近 8）===");
for (const e of intents.slice(-8)) console.log(fmt(e.t), "|", String(e.detail).slice(0, 130));
const guards = (mon.events || []).filter((e) => JSON.stringify(e.detail || "").includes("p25-guard-error"));
console.log("p25-guard-error 事件数:", guards.length);

const cost = ((mon.cost && mon.cost.events) || []).filter((e) => String(e.sid || "").includes(SID8));
console.log("\n=== cost.events（最近 10）===");
for (const e of cost.slice(-10)) {
  console.log(fmt(e.t), "|", String(e.kind).padEnd(15), "|", String(e.trigger || "-").padEnd(6), "| ok=" + (e.ok == null ? "-" : e.ok), "in=" + (e.inChars || 0), "out=" + (e.outChars || 0), "durMs=" + (e.durMs || 0));
}
const tot = (mon.cost && mon.cost.totals && mon.cost.totals.checkpointWrite) || {};
console.log("\ncheckpointWrite totals:", JSON.stringify({ n: tot.n, fail: tot.fail, retry: tot.retry }));
