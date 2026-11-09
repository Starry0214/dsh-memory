/**
 * 深挖：会话主题 E-工具-徕卡一瞬/1b736c53 为何出现 2 句（应恒 1 句）+ 时间线。只读。
 */
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/Starry/.dsh/memory/.memtopic/mem.db", { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
const fmt = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false });

const t = q("SELECT id, name, state, updated_at FROM topics WHERE name = 'E-工具-徕卡一瞬/1b736c53'")[0];
if (!t) { console.log("未找到主题"); db.close(); process.exit(0); }
console.log("主题:", t.name, "id=" + t.id, "state=" + t.state, "updated=" + fmt(t.updated_at));

const ss = q("SELECT id, ord, chars, created_at, updated_at, src, substr(body,1,80) head FROM sentences WHERE topic_id = ? ORDER BY ord", t.id);
console.log("\n=== 当前句子（" + ss.length + " 句）===");
for (const s of ss) console.log(`  id=${s.id} ord=${s.ord} chars=${s.chars} src=${s.src} created=${fmt(s.created_at)}`);
for (const s of ss) {
  const body = q("SELECT body FROM sentences WHERE id = ?", s.id)[0].body;
  console.log(`\n--- 句 ${s.id} 前 160 字 ---\n${String(body).slice(0, 160)}`);
}

console.log("\n=== audit 时间线（该主题全部）===");
for (const a of q("SELECT at, op, sentence_id, actor, detail, length(old_text) lo, length(new_text) ln FROM audit WHERE topic_id = ? ORDER BY at", t.id)) {
  console.log(fmt(a.at), "|", a.op, "| sent=" + a.sentence_id, "| actor=" + a.actor, "| old_len=" + a.lo + " new_len=" + a.ln, "|", String(a.detail || "").slice(0, 90));
}

db.close();
