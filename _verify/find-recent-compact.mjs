// 查 12:30 之后的压缩事件 + agent/created（修正 time 字段为 epoch ms）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = "C:\\Users\\Starry\\.dsh\\sessions";
const SINCE = Date.parse("2026-11-02T12:30:00+08:00");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^session.*\.jsonl\.zstd$/.test(e.name)) out.push(p);
  }
  return out;
}
function tms(v) {
  if (typeof v === "number") return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}
const files = walk(ROOT).map(p => ({ p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }))
  .filter(f => f.mtime >= SINCE).sort((a, b) => b.mtime - a.mtime);

console.log(`候选文件 ${files.length}\n`);
for (const f of files) {
  let txt;
  try { txt = zlib.zstdDecompressSync(fs.readFileSync(f.p)).toString("utf8"); } catch (e) { console.log(`!! ${f.p}: ${e.message}`); continue; }
  const hits = [];
  const lines = txt.split("\n").filter(Boolean);
  for (const ln of lines) {
    let j; try { j = JSON.parse(ln); } catch { continue; }
    const t = j.type || "", tm = tms(j.time ?? j.ts);
    if (tm < SINCE) continue;
    const d = j.data || {};
    if (/^compaction\//.test(t)) hits.push(`${new Date(tm).toISOString().slice(11,19)} ${t} ${JSON.stringify(d).slice(0,500)}`);
    if (t === "agent/created") hits.push(`${new Date(tm).toISOString().slice(11,19)} AGENT ${JSON.stringify({id:d.id,mode:d.mode,label:d.label,parent:d.parent,preset:d.agentPreset,agentProvider:d.agentProvider,agentModel:d.agentModel}).slice(0,320)}`);
    if (t === "session/meta" || t === "session/created") hits.push(`${new Date(tm).toISOString().slice(11,19)} ${t} ${JSON.stringify(d).slice(0,300)}`);
  }
  if (hits.length) {
    const ws = path.basename(path.dirname(path.dirname(f.p))).slice(0, 40);
    const sid = path.basename(path.dirname(f.p)).slice(0, 12);
    console.log(`=== ${ws} / ${sid}  ${new Date(f.mtime).toISOString().slice(11,19)}  ${(f.size/1e6).toFixed(1)}MB ===`);
    for (const h of hits.slice(0, 80)) console.log("  " + h);
    console.log();
  }
}
