// _unmapped-system-topics-selftest.mjs —— 4.5.6 ①②：未归类口径排除系统主题 + 面板拆开显示
//
// 跑法：node test/_unmapped-system-topics-selftest.mjs
//
// 覆盖：
//   A ① hierarchy：笔记·*、P2.5 会话检查点 <wsKey>/<sid8> 不计入未归类；系统主题单列（笔记/检查点分别计数）
//   B ② 面板：账本口径/摘要条拆成「未归类」+「会话笔记 … 待提炼 …」两组（静态接线）
//   C ② memory_topics：层级头/未归类组/会话笔记尾三处同口径（静态接线）
//   D 真实数据口径（只读快照；跳过时不算失败）：真实未归类 = 0、会话笔记 = 15
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const hierFn = mod.__topicDbHierarchy;
ok(typeof hierFn === "function", "A0 __topicDbHierarchy 可导入");

// ── A. hierarchy 口径 ─────────────────────────────────────────────────
try {
  const rows = [
    { id: "T-d1", name: "域一", state: "active", parentId: null },
    { id: "T-p1", name: "项目线一", state: "active", parentId: "T-d1" },
    { id: "T-x1", name: "明细一", state: "active", parentId: "T-p1" },
    { id: "T-u1", name: "真实未归类一", state: "active", parentId: null },
    { id: "T-u2", name: "真实未归类二", state: "dormant", parentId: null },
    { id: "T-n1", name: "笔记·E-工具-X/1b736c53", state: "active", parentId: null },   // 笔记主题（也以 /sid8 结尾）
    { id: "T-n2", name: "笔记·C-项目/99a80181", state: "active", parentId: null },
    { id: "T-c1", name: "E-工具-插件开发调整/0ff4d999", state: "active", parentId: null },  // P2.5 会话检查点
    { id: "T-c2", name: "C-项目/12345678", state: "dormant", parentId: null },
    { id: "T-arch", name: "归档主题", state: "archived", parentId: null },
  ];
  const lv = new Map([["T-d1", "domain"], ["T-p1", "project"], ["T-x1", "detail"], ["T-u1", "detail"], ["T-u2", "detail"], ["T-n1", "detail"], ["T-n2", "detail"], ["T-c1", "detail"], ["T-c2", "detail"], ["T-arch", "detail"]]);
  const h = hierFn({}, rows, lv);
  ok(h.unmapped === 2, "A1 未归类只算真实待归类（笔记/检查点不计入）", "unmapped=" + h.unmapped);
  ok(h.systemTopics === 4, "A2 系统主题单列总数 = 笔记 2 + 检查点 2", "system=" + h.systemTopics);
  ok(h.noteTopics === 2, "A3 会话笔记数（名字以 /sid8 结尾的笔记主题仍归笔记，不被会话正则抢走）", "note=" + h.noteTopics);
  ok(h.checkpointTopics === 2, "A4 P2.5 会话检查点数", "checkpoint=" + h.checkpointTopics);
  ok(h.main.domains === 1 && h.main.projects === 1 && h.details === 1, "A5 主主题/明细口径不变", JSON.stringify(h.main) + " details=" + h.details);
  ok(h.unmappedItems.length === 2 && h.unmappedItems.every((x) => /^T-u/.test(x.id)), "A6 unmappedItems 只列真实未归类", JSON.stringify(h.unmappedItems.map((x) => x.id)));
  ok(h.counts.unmapped === 2 && h.counts.system === 4 && h.counts.notes === 2, "A7 counts 同步新增 system/notes 字段", JSON.stringify(h.counts));
} catch (e) { ok(false, "A hierarchy 场景异常", (e && e.message) || String(e)); }

// ── B. 面板拆开显示（构建真实 panel block HTML）─────────────────────
try {
  const blockFn = mod.__topicDbPanelBlock;
  ok(typeof blockFn === "function", "B0 __topicDbPanelBlock 可导入");
  const html = String(blockFn());
  ok(html.includes("会话笔记") && html.includes("待提炼") && html.includes("num(nu0.sentences)"), "B1 面板含「会话笔记 … 待提炼 N 句」一行");
  ok(html.includes("未归类</span>") && html.includes("num(t.unmapped)"), "B2 摘要条保留「未归类」独立数字");
  ok(html.includes("parent=null，未挂进任何域树"), "B3 账本口径未归类行带解释（parent=null，未挂进任何域树）");
  ok(html.includes("num(t.noteTopics)") && html.includes("系统主题，无需归类"), "B4 面板用 noteTopics（系统主题，无需归类）");
  ok(html.includes("var nu0 = t.noteUnrefined"), "B5 待提炼句数复用 noteUnrefined.sentences");
} catch (e) { ok(false, "B 面板场景异常", (e && e.message) || String(e)); }

// ── C. memory_topics 输出口径（静态接线）───────────────────────────
try {
  const has = (n) => SRC.includes(n);
  ok(has('" · 会话笔记 " + hier.noteTopics'), "C1 层级头含「会话笔记 N（系统主题，无需归类）」");
  ok(has('"[未归类] parent=null 的明细 " + hier.unmapped') && has("会话笔记/会话检查点等系统主题不计入"), "C2 未归类组说明系统主题不计入");
  ok(has('"[会话笔记] " + hier.noteTopics + " 个（系统主题，无需归类） · 待提炼 "'), "C3 尾部「会话笔记 N 个 · 待提炼 M 句」");
  ok(has("out.systemTopics = hier.systemTopics") && has("out.noteTopics = hier.noteTopics") && has("out.checkpointTopics = hier.checkpointTopics"), "C4 stats.json 暴露 systemTopics/noteTopics/checkpointTopics");
} catch (e) { ok(false, "C 静态接线异常", (e && e.message) || String(e)); }

// ── D. 真实库口径（只读快照；无库/无权限时跳过）───────────────────
try {
  const dbSrc = path.join(process.env.USERPROFILE || "C:\\Users\\Starry", ".dsh", "memory", ".memtopic", "mem.db");
  if (!fs.existsSync(dbSrc)) { console.log("SKIP  D 真实库快照（无 mem.db）"); }
  else {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || ".", "dsh-456-"));
    const dst = path.join(tmp, "mem.db");
    fs.copyFileSync(dbSrc, dst);
    for (const ext of ["-wal", "-shm"]) { try { fs.copyFileSync(dbSrc + ext, dst + ext); } catch (e) { /* 无 wal 正常 */ } }
    const ms = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "memory-store.mjs")).href);
    const bs = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "backend-sqlite.mjs")).href);
    const be = new bs.SqliteBackend(dst);
    const store = new ms.MemoryStore(be);
    const rows = store.topics();
    const h = hierFn(store, rows, mod.__topicDbLevelMap(store, rows));
    const nu = mod.__noteUnrefinedStats(store, rows);
    ok(h.unmapped <= 3, "D1 真实库未归类已收敛（排除系统主题后 ≤3；实测 " + h.unmapped + "）", "unmapped=" + h.unmapped);
    ok(h.noteTopics >= 15 && h.systemTopics === h.noteTopics + h.checkpointTopics && h.checkpointTopics === 0, "D2 真实库系统主题全部是会话笔记（≥15、无检查点混入；笔记主题不计入未归类）", "system=" + h.systemTopics + " notes=" + h.noteTopics + " cp=" + h.checkpointTopics);
    ok(h.unmappedItems.every((x) => !/^笔记·/.test(x.name) && !/\/[0-9a-f]{8}$/.test(x.name)), "D3 unmappedItems 里没有系统主题名", JSON.stringify(h.unmappedItems.map((x) => x.name)));
    ok(typeof nu.sentences === "number", "D4 待提炼句数可读（面板同源）", JSON.stringify(nu));
    try { be.close(); } catch (e) {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} catch (e) { console.log("SKIP  D 真实库快照异常（不影响门）：" + ((e && e.message) || e)); }

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
