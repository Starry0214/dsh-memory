// 查：主题库会话主题里有没有子代理会话（isSub 是否漏到写侧）
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const d = new DatabaseSync("C:/Users/Starry/.dsh/memory/.memtopic/mem.db", { readOnly: true });
console.log("=== 会话主题（名字形如 <ws>/<sid8>）===");
const rows = d.prepare("SELECT id,name,state,updated_at FROM topics WHERE name LIKE '%/%' AND length(name) < 90 ORDER BY updated_at DESC LIMIT 30").all();
const sids = [];
for (const r of rows) {
  const n = String(r.name);
  if (!/\//.test(n)) continue;
  const sid = n.slice(n.lastIndexOf("/") + 1);
  if (!/^[0-9a-f]{8}$/.test(sid)) { console.log("  [非会话主题]", r.id, n.slice(0, 60)); continue; }
  sids.push(sid);
  console.log("  ", r.id, r.state, "|", n.slice(0, 56), "|", new Date(r.updated_at).toISOString().slice(5, 16));
}
console.log("\n会话 sid 数:", sids.length);

// 这些 sid 里哪些是子代理？（从会话目录 label 判断）
const ROOT = "C:/Users/Starry/.dsh/sessions";
const labelOf = new Map();
for (const ws of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, ws);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const s of fs.readdirSync(p)) {
    const m = String(s).match(/session-([0-9a-f]{8})/);
    if (!m) continue;
    const d2 = path.join(p, s);
    try { labelOf.set(m[1], s.slice(0, 60)); } catch {}
  }
}
console.log("\n=== 每个 sid 的会话目录名（看是否 dsh-memory 子代理）===");
for (const sid of sids) console.log("  ", sid, "→", (labelOf.get(sid) || "(未找到目录)").slice(0, 60));
d.close();
