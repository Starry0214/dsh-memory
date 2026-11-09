// 审计：主题库会话主题/迁移状态 + global.md 预算 + 记账缺口
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

console.log("=== 主题库：会话主题 / 检查点线 ===");
try {
  const d = new DatabaseSync("C:/Users/Starry/.dsh/memory/.memtopic/mem.db", { readOnly: true });
  const slash = d.prepare("SELECT COUNT(*) c FROM topics WHERE name LIKE '%/%'").get();
  const line = d.prepare("SELECT COUNT(*) c FROM topics WHERE name LIKE '会话检查点%'").get();
  console.log("会话主题(名字含 /):", slash.c, "| 检查点线:", line.c);
  const rows = d.prepare("SELECT id,name,state,updated_at FROM topics WHERE name LIKE '%/%' ORDER BY updated_at DESC LIMIT 8").all();
  for (const r of rows) console.log("  ", r.id, r.state, "|", String(r.name).slice(0, 64), "|", new Date(r.updated_at).toISOString().slice(5, 16));
  const d8 = d.prepare("SELECT id,name FROM topics WHERE name LIKE '日记忆%' OR name LIKE '%2026-11-02%' LIMIT 5").all();
  console.log("日记忆/今日主题:", d8.map((x) => x.id + " " + String(x.name).slice(0, 30)).join(" ; ") || "(无)");
  d.close();
} catch (e) { console.log("db err:", e.message); }

console.log("\n=== global.md 预算 ===");
try {
  const g = fs.readFileSync("C:/Users/Starry/.dsh/memory/global.md", "utf8");
  console.log("字符:", g.length, "（告警线 2700 / 硬预算 3000）");
} catch (e) { console.log("read err:", e.message); }

console.log("\n=== .monitor.json 账本缺口（全 0 的 kind）===");
try {
  const mon = JSON.parse(fs.readFileSync("C:/Users/Starry/.dsh/memory/.monitor.json", "utf8"));
  const t = (mon.cost || {}).totals || {};
  for (const k of Object.keys(t)) {
    const nz = Object.entries(t[k]).filter(([a, b]) => b && b !== 0);
    if (!nz.length) console.log("  全0:", k);
  }
} catch (e) { console.log("read err:", e.message); }
