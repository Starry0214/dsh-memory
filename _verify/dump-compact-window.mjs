// 打印指定会话 04:47~04:53 区间全部事件类型与关键字段
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SESSION = process.argv[2] || "C:\\Users\\Starry\\.dsh\\sessions\\--E-~5DE5~5177-~63D2~4EF6~5F00~53D1~8C03~6574--\\session-0ff4d9";
const SINCE = Date.parse(process.argv[3] || "2026-11-02T12:46:00+08:00");
const UNTIL = Date.parse(process.argv[4] || "2026-11-02T12:53:00+08:00");

// 找 session 目录
let dir = SESSION;
if (!fs.existsSync(dir)) {
  const base = "C:\\Users\\Starry\\.dsh\\sessions";
  for (const ws of fs.readdirSync(base)) {
    for (const sid of fs.readdirSync(path.join(base, ws))) {
      if (sid.startsWith(SESSION)) dir = path.join(base, ws, sid);
    }
  }
}
console.log("DIR:", dir);
const file = path.join(dir, "session.v4.jsonl.zstd");
const lines = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
console.log(`总行 ${lines.length}\n`);

function tms(v) { if (typeof v === "number") return v; const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }

const counts = new Map();
for (const ln of lines) {
  let j; try { j = JSON.parse(ln); } catch { continue; }
  const tm = tms(j.time ?? j.ts);
  if (tm < SINCE || tm > UNTIL) continue;
  const t = j.type || "?";
  counts.set(t, (counts.get(t) || 0) + 1);
  const d = j.data || {};
  let brief = "";
  if (t === "agent/created") brief = JSON.stringify({ id: d.id, mode: d.mode, label: d.label, preset: d.agentPreset, provider: d.agentProvider, model: d.agentModel, toolFilter: d.toolFilter ? "Y" : "N" });
  else if (t === "compaction/start" || t === "compaction/end") brief = JSON.stringify(d).slice(0, 200);
  else if (t === "compaction/summary") brief = `text=${(Array.isArray(d.summary) ? d.summary.map(x => x.text).join("") : "").length}字`;
  else if (t === "assistant/message") brief = "usage=" + JSON.stringify(d.usage || {});
  else if (t === "subagent/created" || t === "subagent/start" || t === "subagent/settled" || t === "subagent/end") brief = JSON.stringify(d).slice(0, 300);
  else if (t.startsWith("user/message")) brief = JSON.stringify(d).slice(0, 160);
  else brief = JSON.stringify(d).slice(0, 140);
  console.log(`${new Date(tm).toISOString().slice(11, 19)} ${t}  ${brief}`);
}
console.log("\n=== 事件类型统计 ===");
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
