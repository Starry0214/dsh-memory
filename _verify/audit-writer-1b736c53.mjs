/**
 * 会话 1b736c53 的检查点子代理工作状况核查（只读）
 * - cost 台账里的 checkpointWrite（T0/T1/T4/T5/I-ok/I-fail/I-retry）
 * - monitor intent 事件（pre-start/pre-reuse/normalize/topicdb/malformed/bad-structure）
 * - .integrate.json 的 intentRetry 队列
 * - 会话主题 audit 时间线（覆盖/收敛）
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SID = "session-1b736c53-7fc7-4be1-a22c-0fa4043c963e";
const SID8 = "1b736c53";
const MEM = "C:/Users/Starry/.dsh/memory";
const fmt = (t) => new Date(Number(t) || 0).toLocaleString("zh-CN", { hour12: false });

const mon = JSON.parse(fs.readFileSync(MEM + "/.monitor.json", "utf8"));
const evs = ((mon.cost && mon.cost.events) || []).filter((e) => String(e.sid || "").includes(SID8));
console.log("=== cost.events（该会话，共 " + evs.length + " 条）===");
for (const e of evs) {
  console.log(
    fmt(e.t), "|",
    String(e.kind).padEnd(15), "|",
    String(e.trigger || "-").padEnd(8), "|",
    "ok=" + (e.ok == null ? "-" : e.ok),
    "fail=" + (e.fail || 0),
    "in=" + (e.inChars || 0),
    "out=" + (e.outChars || 0),
    "durMs=" + (e.durMs || 0),
    "|", String(e.note || "")
  );
}

const monEvents = (mon.events || []).filter((e) => e.type === "intent" && String(e.detail || "").includes(SID8));
console.log("\n=== monitor intent 事件（含 sid8，共 " + monEvents.length + " 条，最近 20）===");
for (const e of monEvents.slice(-20)) console.log(fmt(e.t), "|", String(e.detail || "").slice(0, 160));

// intentRetry 队列
try {
  const integ = JSON.parse(fs.readFileSync(MEM + "/.integrate.json", "utf8"));
  const q = integ.intentRetry || integ.intentRetryQueue || null;
  console.log("\n=== intentRetry 队列 ===");
  if (!q) console.log("（无该字段）");
  else {
    const keys = Object.keys(q);
    console.log("队列条数:", keys.length);
    for (const k of keys) {
      const v = q[k];
      const s = JSON.stringify(v).slice(0, 200);
      if (s.includes(SID8) || keys.length <= 5) console.log("  ", k, "=>", s);
    }
  }
} catch (e) { console.log("\n[ integrate.json 读失败 ]", e.message); }

// 会话主题 audit
try {
  const db = new DatabaseSync(MEM + "/.memtopic/mem.db", { readOnly: true });
  const t = db.prepare("SELECT id, name, state, updated_at FROM topics WHERE name LIKE ?").get("%/" + SID8);
  if (!t) { console.log("\n[ 未找到会话主题 ]"); }
  else {
    console.log("\n=== 会话主题 " + t.name + " state=" + t.state + " ===");
    const ss = db.prepare("SELECT id, ord, chars, src, created_at FROM sentences WHERE topic_id = ? ORDER BY ord").all(t.id);
    console.log("当前句数:", ss.length);
    for (const s of ss) console.log("  句 id=" + s.id, "ord=" + s.ord, "chars=" + s.chars, "src=" + s.src, "created=" + fmt(s.created_at));
    console.log("audit（最近 12 条）:");
    const au = db.prepare("SELECT at, op, actor, sentence_id, length(old_text) lo, length(new_text) ln, detail FROM audit WHERE topic_id = ? ORDER BY at DESC LIMIT 12").all(t.id);
    for (const a of au) console.log("  ", fmt(a.at), "|", String(a.op).padEnd(18), "| actor=" + String(a.actor || "-").padEnd(8), "| sent=" + a.sentence_id, "old=" + a.lo, "new=" + a.ln, "|", String(a.detail || "").slice(0, 70));
  }
  db.close();
} catch (e) { console.log("\n[ db 读失败 ]", e.message); }
