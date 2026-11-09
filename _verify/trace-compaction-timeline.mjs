/**
 * 追踪单会话的压缩时间线：compaction/start → summary → end → 检查点 → 重灌
 * 用法：node _verify/trace-compaction-timeline.mjs <session.v4.jsonl.zstd> [limit]
 */
import fs from "node:fs";
import zlib from "node:zlib";

const p = process.argv[2];
const LIMIT = Number(process.argv[3] || 200);
if (!p) { console.error("用法: node trace-compaction-timeline.mjs <session.v4.jsonl.zstd>"); process.exit(2); }

const raw = fs.readFileSync(p);
let text;
try {
  text = zlib.zstdDecompressSync(raw).toString("utf8");
} catch (e) {
  // 多帧拼接：逐帧尝试
  console.error("[warn] 整块解压失败，尝试多帧:", e.message);
  let all = "";
  let off = 0;
  while (off < raw.length) {
    let ok = false;
    for (const probe of [1 << 20, 1 << 18, 1 << 16, 1 << 14, 4096]) {
      try {
        const chunk = raw.subarray(off, Math.min(raw.length, off + probe));
        const dec = zlib.zstdDecompressSync(chunk).toString("utf8");
        all += dec; off += chunk.length; ok = true; break;
      } catch { /* try smaller */ }
    }
    if (!ok) break;
  }
  text = all;
}

const lines = text.split("\n").filter(Boolean);
const rows = [];
for (let i = 0; i < lines.length; i++) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  rows.push({ i, o });
}

function tsOf(o) {
  const t = o.at || o.ts || o.time || o.createdAt || (o.payload && (o.payload.at || o.payload.ts));
  if (typeof t === "number") return new Date(t);
  if (typeof t === "string") { const d = new Date(t); if (!isNaN(d)) return d; }
  return null;
}
const fmt = (d) => d ? d.toLocaleString("zh-CN", { hour12: false }) : "?";

const interesting = [];
for (const { i, o } of rows) {
  if (!o || typeof o !== "object") continue;
  const type = String(o.type || o.kind || o.name || "");
  const pType = o.payload && typeof o.payload === "object" ? String(o.payload.type || o.payload.kind || "") : "";
  const all = type + " " + pType;
  if (!/compaction|compact|summary|checkpoint|intent|rehydrat|inject/i.test(all)) continue;
  interesting.push({ i, t: tsOf(o), type: all.trim(), o });
}

console.log("总行数:", lines.length, "命中:", interesting.length);
const tail = interesting.slice(-LIMIT);
for (const r of tail) {
  let extra = "";
  const pl = r.o.payload || r.o;
  if (pl && typeof pl === "object") {
    const keys = ["id", "compactionId", "cid", "reason", "msgs", "messages", "tokens", "at", "turns"];
    const bits = [];
    for (const k of keys) if (pl[k] != null) bits.push(k + "=" + String(JSON.stringify(pl[k])).slice(0, 60));
    extra = bits.join(" ");
  }
  console.log(`#${r.i} ${fmt(r.t)} [${r.type}] ${extra}`);
}
