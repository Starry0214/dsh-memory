/**
 * 独立复核 task-21（P2.5 历史迁移 apply）结果 —— 只读，不写库。
 */
import { DatabaseSync } from "node:sqlite";

const DB = "C:/Users/Starry/.dsh/memory/.memtopic/mem.db";
const db = new DatabaseSync(DB, { readOnly: true });
const q = (sql, ...params) => db.prepare(sql).all(...params);
const line = (label, val) => console.log(String(label).padEnd(30, "."), val);

console.log("=== schema ===");
for (const r of q("SELECT name, sql FROM sqlite_master WHERE type='table'")) {
  console.log("--", r.name, ":", String(r.sql || "").replace(/\s+/g, " ").slice(0, 260));
}

console.log("\n=== counts ===");
line("topics", q("SELECT COUNT(*) c FROM topics")[0].c);
line("sentences", q("SELECT COUNT(*) c FROM sentences")[0].c);

console.log("\n=== P2.5 lines ===");
for (const l of q("SELECT * FROM topics WHERE name LIKE '会话检查点·%' ORDER BY name")) {
  line(l.name, "state=" + l.state + " id=" + l.id);
}

console.log("\n=== p25-migrate sentences ===");
line("src=p25-migrate", q("SELECT COUNT(*) c FROM sentences WHERE src='p25-migrate'")[0].c);

db.close();
