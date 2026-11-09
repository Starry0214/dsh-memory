/**
 * 实测：P2.5 会话主题是否「恒 1 句」（只保留最新一份）+ 历史是否在 audit 表。
 * 只读。
 */
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/Starry/.dsh/memory/.memtopic/mem.db", { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);

// 会话主题 = 名字形如 <wsKey>/<8位hex>
const rows = q("SELECT id, name, state, created_at, updated_at FROM topics").filter((r) =>
  /^[^/]+\/[0-9a-f]{8}$/.test(String(r.name || ""))
);
console.log("会话主题总数:", rows.length);

const dist = {};
let multi = [];
for (const r of rows) {
  const n = q("SELECT COUNT(*) c FROM sentences WHERE topic_id = ?", r.id)[0].c;
  dist[n] = (dist[n] || 0) + 1;
  if (n > 1) multi.push({ name: r.name, n });
}
console.log("句数分布:", JSON.stringify(dist));
if (multi.length) {
  console.log("多于 1 句的会话主题（前 10）:");
  for (const m of multi.slice(0, 10)) console.log("   ", m.name, "句数=" + m.n);
}

// 抽一个会话主题看 audit 历史条数
const sample = rows.slice(0, 3);
for (const s of sample) {
  const a = q("SELECT COUNT(*) c FROM audit WHERE topic_id = ?", s.id)[0].c;
  const ar = q(
    "SELECT at, op, length(old_text) lo, length(new_text) ln FROM audit WHERE topic_id = ? ORDER BY at DESC LIMIT 3",
    s.id
  );
  console.log("\n样本:", s.name, "| state=" + s.state, "| audit 条数=" + a);
  for (const x of ar) console.log("   audit:", new Date(x.at).toLocaleString("zh-CN", { hour12: false }), x.op, "old_len=" + x.lo, "new_len=" + x.ln);
}

// 全库 audit 规模
console.log("\naudit 总条数:", q("SELECT COUNT(*) c FROM audit")[0].c);
console.log("audit op 分布:", JSON.stringify(q("SELECT op, COUNT(*) c FROM audit GROUP BY op")));

db.close();
