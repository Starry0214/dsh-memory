// 查：① 18:35-18:42 北京时段有无 writer 子代理会话 / ② 主题库检查点现状
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = "C:/Users/Starry/.dsh/sessions";
const A = Date.parse("2026-11-02T18:30:00+08:00");
const B = Date.parse("2026-11-02T18:45:00+08:00");
console.log("=== 18:30-18:45 有活动的会话 ===");
const found = [];
for (const ws of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, ws);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const s of fs.readdirSync(p)) {
    const d = path.join(p, s);
    let dt; try { dt = fs.statSync(d); } catch { continue; }
    if (!dt.isDirectory()) continue;
    const f = path.join(d, "session.v4.jsonl.zstd");
    let sf; try { sf = fs.statSync(f); } catch { continue; }
    if (sf.mtimeMs >= A && sf.mtimeMs <= B) found.push({ ws, sid: s.slice(0, 22), born: dt.birthtime, mtime: sf.mtime, size: sf.size, file: f });
  }
}
found.sort((x, y) => x.mtime - y.mtime);
for (const f of found) console.log(" ", f.mtime.toISOString().slice(11, 19), f.sid, "| born", f.born.toISOString().slice(11, 19), "|", Math.round(f.size / 1024) + "KB", "|", f.ws.slice(0, 40));

// 读每个会话的最后 6 条事件类型 + 任何 error
console.log("\n=== 逐个看尾部（找 stopReason/error）===");
for (const f of found) {
  try {
    const txt = zlib.zstdDecompressSync(fs.readFileSync(f.file)).toString("utf8");
    const lines = txt.split("\n").filter(Boolean);
    console.log("\n── " + f.sid + " (" + lines.length + " 事件) ──");
    for (const ln of lines.slice(-8)) {
      let j; try { j = JSON.parse(ln); } catch { continue; }
      const s = JSON.stringify(j.data || {}).slice(0, 220);
      console.log("  ", j.type, s);
    }
  } catch (e) { console.log("  read fail:", e.message); }
}
