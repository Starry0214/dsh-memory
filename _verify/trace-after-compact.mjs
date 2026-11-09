/**
 * 打印压缩后（指定起始行之后）每条记录的时间/类型/摘要，用于判断"等待是否阻塞主会话"
 * 用法：node _verify/trace-after-compact.mjs <file> <fromLine>
 */
import fs from "node:fs";
import zlib from "node:zlib";

const p = process.argv[2];
const from = Number(process.argv[3] || 0);
const raw = fs.readFileSync(p);
const text = zlib.zstdDecompressSync(raw).toString("utf8");
const lines = text.split("\n").filter(Boolean);

function tsOf(o) {
  const t = o.at || o.ts || o.time || o.createdAt;
  if (typeof t === "number") return new Date(t);
  if (typeof t === "string") { const d = new Date(t); if (!isNaN(d)) return d; }
  return null;
}
const fmt = (d) => d ? d.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0") : "?";

for (let i = from; i < lines.length; i++) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  const t = tsOf(o);
  const type = String(o.type || o.kind || o.name || "");
  const pl = o.payload || {};
  let brief = "";
  if (/message|user|assistant|turn/i.test(type)) {
    const role = pl.role || o.role || "";
    const content = pl.content || o.content;
    let txt = "";
    if (typeof content === "string") txt = content;
    else if (Array.isArray(content)) txt = content.map((c) => (typeof c === "string" ? c : (c && c.text) || "")).join(" ");
    else if (content && typeof content === "object") txt = content.text || "";
    brief = role + " " + String(txt).replace(/\s+/g, " ").slice(0, 90);
  } else {
    brief = JSON.stringify(pl).replace(/\s+/g, " ").slice(0, 110);
  }
  console.log(`#${i} ${fmt(t)} [${type}] ${brief}`);
}
