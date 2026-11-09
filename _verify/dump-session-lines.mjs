/**
 * 打印指定行号的完整记录（含 payload 正文），用于核对重灌注入内容
 * 用法：node _verify/dump-session-lines.mjs <file> <line1,line2,...> [maxChars]
 */
import fs from "node:fs";
import zlib from "node:zlib";

const p = process.argv[2];
const which = String(process.argv[3] || "").split(",").filter(Boolean).map(Number);
const MAX = Number(process.argv[4] || 4000);
const raw = fs.readFileSync(p);
const text = zlib.zstdDecompressSync(raw).toString("utf8");
const lines = text.split("\n").filter(Boolean);

for (const i of which) {
  const s = lines[i];
  if (!s) { console.log(`#${i} <空>`); continue; }
  let o;
  try { o = JSON.parse(s); } catch { console.log(`#${i} <非JSON>`); continue; }
  const t = o.at || o.ts;
  const when = typeof t === "number" ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "?";
  console.log(`\n========== #${i} ${when} type=${o.type || o.kind} ==========`);
  console.log(JSON.stringify(o, null, 1).slice(0, MAX));
}
