/**
 * 查会话 1b736c53 在 10:25:57 附近的注入内容，确认重灌用的是本次检查点（cid 4044b558）
 */
import fs from "node:fs";
import zlib from "node:zlib";

const P = "C:/Users/Starry/.dsh/sessions/--E-~5DE5~5177-~5F95~5361~4E00~77AC--/session-1b736c53-7fc7-4be1-a22c-0fa4043c963e/session.v4.jsonl.zstd";
const text = zlib.zstdDecompressSync(fs.readFileSync(P)).toString("utf8");
const lines = text.split("\n").filter(Boolean);
console.log("总行数:", lines.length);

const fmt = (t) => new Date(Number(t) || 0).toLocaleString("zh-CN", { hour12: false });
const hits = [];
for (let i = 34000; i < lines.length; i++) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  if (o.type !== "agent/inbox/spliced") continue;
  const ins = (o.data && o.data.inserted) || [];
  for (const m of ins) {
    const c = m.content;
    let txt = "";
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
    if (!txt) continue;
    if (!txt.includes("压缩后记忆重灌") && !txt.includes("检查点续接")) continue;
    hits.push({ i, t: o.time, txt });
  }
}
console.log("重灌注入条数:", hits.length);
for (const h of hits) {
  console.log("\n=== #" + h.i + " " + fmt(h.t) + " len=" + h.txt.length + " ===");
  const m = h.txt.match(/【检查点续接（([^）]*)）】/);
  console.log("检查点段头:", m ? m[1] : "无");
  const cp = h.txt.match(/压缩\s+([0-9a-f]{8})/gi);
  console.log("正文内压缩 id:", cp ? JSON.stringify(cp.slice(0, 4)) : "无");
  const i2 = h.txt.indexOf("【检查点续接");
  if (i2 >= 0) console.log("检查点段前 260 字:\n" + h.txt.slice(i2, i2 + 260));
}
