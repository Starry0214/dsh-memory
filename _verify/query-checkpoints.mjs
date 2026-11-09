// 查记忆库里的检查点数据：主题结构、句数、最近内容
import { DatabaseSync } from "node:sqlite";

const DB = "C:/Users/Starry/.dsh/memory/.memtopic/mem.db";
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log("=== 1) 与检查点相关的主题（按最近更新）===");
const topics = all(
  `SELECT t.id, t.name, t.state, t.state, count(s.id) AS n, max(s.updated_at) AS up
   FROM topics t LEFT JOIN sentences s ON s.topic_id = t.id
   WHERE t.name LIKE '%检查点%' OR t.name LIKE '2026-11-%' OR t.name LIKE '2026-10-3%'
   GROUP BY t.id ORDER BY up DESC LIMIT 14`
);
for (const r of topics) {
  const up = r.up ? new Date(Number(r.up)).toISOString().slice(0, 16).replace("T", " ") : "";
  console.log(`${r.id} | ${String(r.level || "").padEnd(7)} | ${r.name} | 句数=${r.n} | ${up}`);
}

console.log("\n=== 2) 最近 8 条检查点句（前 100 字）===");
const rows = all(
  `SELECT s.id, s.topic_id, substr(s.body, 1, 100) AS b, s.chars, s.updated_at, t.name
   FROM sentences s JOIN topics t ON t.id = s.topic_id
   WHERE t.name LIKE '%检查点%' OR t.name LIKE '2026-11-%'
   ORDER BY s.updated_at DESC LIMIT 8`
);
for (const r of rows) {
  const t = new Date(Number(r.updated_at)).toISOString().slice(5, 16).replace("T", " ");
  console.log(`[${t}] (${r.name}) ${String(r.b || "").replace(/\s+/g, " ")} … (${r.chars} 字)`);
}

console.log("\n=== 3) 总计 ===");
const tot = all(
  `SELECT count(*) AS n FROM sentences s JOIN topics t ON t.id = s.topic_id
   WHERE t.name LIKE '%检查点%' OR t.name LIKE '2026-11-%'`
);
console.log("检查点类句子总数:", tot[0].n);
db.close();
