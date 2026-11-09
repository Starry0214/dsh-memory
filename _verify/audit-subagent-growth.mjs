// 查：① 今日 48 个会话里多少是 dsh-memory 子代理 ② spawnIntentCheckpoint 的 spawn 方式
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = "C:/Users/Starry/.dsh/sessions";
const today = allTodaySubagents();
function allTodaySubagents() {
  const out = [];
  for (const ws of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, ws);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const s of fs.readdirSync(p)) {
      const d = path.join(p, s);
      let dt; try { dt = fs.statSync(d); } catch { continue; }
      if (!dt.isDirectory()) continue;
      if (dt.birthtime.toISOString().slice(0, 10) !== "2026-11-02") continue;
      const f = path.join(d, "session.v4.jsonl.zstd");
      let sf; try { sf = fs.statSync(f); } catch { continue; }
      let label = "";
      try {
        const txt = zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8");
        const m = txt.match(/"label":"([^"]{0,60})"/);
        const sp = txt.match(/"subagent\/descriptor"[^\n]{0,300}/);
        const ttl = txt.match(/"title":"([^"]{0,40})"/);
        label = (m && m[1]) || (sp && sp[0].slice(0, 120)) || (ttl && ttl[1]) || "";
      } catch {}
      out.push({ sid: s.slice(0, 14), born: dt.birthtime, label });
    }
  }
  return out.sort((a, b) => a.born - b.born);
}
console.log("今日新建会话:", today.length);
const sub = today.filter((x) => /dsh-memory|检查点|归档|整合|writer/i.test(x.label));
console.log("其中 dsh-memory 子代理:", sub.length);
for (const x of sub) console.log("  ", x.born.toISOString().slice(11, 19), x.sid, "|", x.label.slice(0, 50));
const user = today.filter((x) => !sub.includes(x));
console.log("\n主/其他会话:", user.length);
for (const x of user.slice(-12)) console.log("  ", x.born.toISOString().slice(11, 19), x.sid, "|", x.label.slice(0, 50));
