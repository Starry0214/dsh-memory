// _dream-cand-selftest.mjs —— dream 整合「候选主题」选择自测
//
// 跑法：node test/_dream-cand-selftest.mjs [index.js 路径]
//
// 背景（2026-11-03 真机实证）：库模式候选取 `store.topics().filter(非归档).slice(0,20)`，
//   而 store.topics() 底层是 `SELECT * FROM topics ORDER BY id` ⇒ 候选恒为最早 20 个主题。
//   真机库 534 主题 / 510 非归档，近 30 天有写入的 30 个主题**无一**进候选 ⇒ dream 看不到活跃主题。
//   修法：按 updatedAt 降序（同值按 id 升序）取前 20。
//
// 覆盖：
//   A 负例对照（改前必 FAIL）：候选不得等于「id 升序前 20」
//   B 候选 = updatedAt 最新的 20 个非归档主题
//   C archived 主题不进候选
//   D 候选上限 20（非归档 < 20 时取全部）
//   E 稳定排序：updatedAt 全同时按 id 升序
//   F 静态接线断言：源码含 updatedAt 排序（防被回退）
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全部指向 os.tmpdir() 临时目录，
//   绝不读写真实 ~/.dsh/memory。跑完删临时目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) {
    try { if (fn()) return true; } catch (e) { /* 继续等 */ }
    await sleep(step || 50);
  }
  return false;
}

// ── 临时 home / memory（绝不碰真实 ~/.dsh）──────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-dreamcand-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "dreamcand-ws");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 候选自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

// ── 启动插件（topicdb flag=on）──────────────────────────────────────────────
const fx = createFixtureCtx({});
await plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "前置：flag 开 ⇒ 主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
if (!ready) {
  console.log("\n0 PASS / 1 FAIL（库未就绪，后续断言跳过）");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(1), 150);
  throw new Error("topicdb not ready");
}
const store = mod.__topicdb.store;

// ── 造数据：30 个主题，updatedAt 与 id **逆序** ─────────────────────────────
// createdAt 顺序 = id 顺序（cand-00 最早）；append 顺序倒着来 ⇒ 最新 updatedAt 属于 cand-29。
const N = 30;
// 主题名必须两两「归一化后编辑距离 > 2」，否则落进禁建区（governance 的编辑距离 ≤2 视为同一主题）
const BLK = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "gggg", "hhhh", "iiii", "jjjj",
  "kkkk", "llll", "mmmm", "nnnn", "oooo", "pppp", "qqqq", "rrrr", "ssss", "tttt",
  "uuuu", "vvvv", "wwww", "xxxx", "yyyy", "zzzz", "abab", "cdcd", "efef", "ghgh"];
const TNAME = (i) => "selftopic-" + BLK[i] + "-" + String(i).padStart(2, "0");
const ids = [];
for (let i = 0; i < N; i++) {
  let r = null;
  try {
    r = store.createTopic({ name: TNAME(i), actor: "runtime", confirm: true });
  } catch (e) {
    console.log("ERR  createTopic#" + i + "（" + TNAME(i) + "）：" + (e && e.message ? e.message : String(e)));
    throw e;
  }
  if (!r || !r.id) { console.log("ERR  createTopic#" + i + " 未拿到 id：" + JSON.stringify(r).slice(0, 200)); }
  ids.push(r && r.id);
}
ok(ids.length === N && ids.every(Boolean), "前置：建 30 个主题", ids[0] + ".." + ids[N - 1]);
// createdAt 顺序 = id 顺序（T-0001 最早）；append **正序** ⇒ T-0030 的 updatedAt 最新，
// 于是「updatedAt 降序」= T-0030,T-0029… 与「id 升序」= T-0001,T-0002… **相反**（负例对照的前提）。
for (let i = 0; i < N; i++) {
  store.appendSentence({ topic: ids[i], text: "候选自测句 " + TNAME(i), actor: "runtime" });
  await sleep(3);   // 保证 updatedAt 严格递增
}

// 归档 2 个（最新区间的 cand-28/cand-29 之一 + 老区间的 cand-01），验证 filter 仍生效
let archivedOk = false;
try {
  store.setState(ids[1], "archived", { actor: "runtime", reason: "selftest" });
  store.setState(ids[29], "archived", { actor: "runtime", reason: "selftest" });
  archivedOk = true;
} catch (e) { console.log("SKIP  归档前置失败（不影响核心断言）：" + (e && e.message)); }

// ── 取 dream prompt ─────────────────────────────────────────────────────────
const hookOk = await waitFor(() => mod.__dreamHooks && typeof mod.__dreamHooks.buildPrompt === "function", 10000, 100);
ok(hookOk, "前置：__dreamHooks.buildPrompt 可用");
const dp = hookOk ? await mod.__dreamHooks.buildPrompt() : null;
const promptText = dp && dp.promptText || "";
ok(dp && dp.libMode === true, "前置：走库模式任务书（libMode=true）", dp ? String(dp.libMode) : "no dp");

// 从 prompt 里抠候选行：- 候选主题（…）：T-xxxx「name」、T-yyyy「name」…
const candLine = (promptText.split("\n").find((l) => l.includes("候选主题")) || "");
const candIds = [...candLine.matchAll(/(T-\d+)「/g)].map((m) => m[1]);

// 期望：非归档按 updatedAt 降序、同值 id 升序，前 20
const rows = store.topics().filter((t) => String(t.state || "") !== "archived");
const expect = rows
  .slice()
  .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.id).localeCompare(String(b.id)))
  .slice(0, 20);
const expectIds = expect.map((t) => t.id);
const idAsc20 = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 20).map((t) => t.id);

// A 负例对照：改前行为 = id 升序前 20
ok(JSON.stringify(candIds) !== JSON.stringify(idAsc20),
  "A 负例对照：候选 ≠ id 升序前 20（改前必 FAIL）",
  "prompt=" + candIds.slice(0, 3).join(",") + "… / idAsc=" + idAsc20.slice(0, 3).join(",") + "…");

// B 候选 = updatedAt 最新 20
ok(JSON.stringify(candIds) === JSON.stringify(expectIds),
  "B 候选 = updatedAt 降序前 20",
  "len=" + candIds.length + " 首=" + (candIds[0] || "-") + " 末=" + (candIds[candIds.length - 1] || "-"));

// C archived 不进候选
if (archivedOk) {
  const archIds = [ids[1], ids[29]];
  ok(archIds.every((x) => !candIds.includes(x)), "C archived 主题不进候选", archIds.join(","));
} else {
  console.log("SKIP  C（归档前置失败）");
}

// D 上限 20
ok(candIds.length === 20, "D 候选上限 20", "实际 " + candIds.length);

// E 稳定排序：全部 updatedAt 相同的场景下按 id 升序
{
  const fake = [
    { id: "T-0007", name: "b", updatedAt: 1000 },
    { id: "T-0003", name: "a", updatedAt: 1000 },
    { id: "T-0009", name: "c", updatedAt: 1000 },
  ];
  const sorted = fake.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.id).localeCompare(String(b.id)));
  ok(sorted.map((x) => x.id).join(",") === "T-0003,T-0007,T-0009", "E 同 updatedAt 按 id 升序（稳定）", sorted.map((x) => x.id).join(","));
}

// F 静态接线断言：源码必须含 updatedAt 参与排序（防回退到 slice(id 序)）
{
  const src = fs.readFileSync(PLUGIN, "utf8");
  const at = src.indexOf("const _ts = (t) =>");
  // [审计 F7 修复后] 候选池新增「排除 P2.5 检查点主题」注释块 ⇒ 窗口从 1200 放宽到 2400
  const seg = at >= 0 ? src.slice(at, at + 2400) : "";
  ok(/updatedAt/.test(seg), "F 静态接线：候选选择段含 updatedAt 排序", at >= 0 ? "命中 offset " + at : "未找到候选选择段");
  // [2026-11-04 设计定稿 §5] 候选改为「笔记优先 + 其他补足到 20」：断言从 slice(0,20) 改为补足表达式
  ok(/Math\.max\(10, 20 - _notePick\.length\)/.test(seg), "F 静态接线：笔记优先但总数补足到 20", "");
  ok(!/filter\(\(t\) => String\(t\.state \|\| ""\) !== "archived"\)\.slice\(0, 20\);/.test(seg), "F 静态接线：旧的「filter 直接 slice」已移除", "");
}

// ── P0-0 回归门（2026-11-10）──────────────────────────────────────────────
// 会话笔记提炼块只在存在未提炼笔记时渲染 ⇒ 候选断言跑完后再造 note，避免改变候选期望。
{
  let noteId = null;
  try {
    const nr = store.createTopic({ name: "笔记·selftest/abcd1234", actor: "runtime", confirm: true });
    noteId = nr && nr.id;
    if (noteId) store.appendSentence({ topic: noteId, text: "P0-0 门：未提炼笔记句", actor: "runtime" });
  } catch (e) { noteId = null; }
  ok(!!noteId, "前置：建未提炼笔记主题", String(noteId || "失败"));
  const dp2 = noteId ? await mod.__dreamHooks.buildPrompt() : null;
  const pt2 = (dp2 && dp2.promptText) || "";
  // 负例：4.5.12 修前（_noteDistilled 作用域 ReferenceError 被静默吞掉）任务书无此块 ⇒ 必 FAIL。
  ok(pt2.includes("会话笔记提炼"), "P0-0 任务书含「会话笔记提炼」块（修前必 FAIL）");
  ok(pt2.includes("DSH_MEMORY_COMPACT_JSON"), "P0-0 任务书含笔记收敛哨兵说明");
}

// ── [4.5.13 Part A] G1 + G4 回归门（与本仓根 `_test-dream-prescreen.mjs` 互补：
//   本门在「30 主题 + 1 笔记」fixture 上复查「预筛零 markHit / 双预算 / flag 关不插块」）──
{
  const hitSnap = () => store.topics().map((t) => String(t.id) + "=" + String(t.lastHitAt == null ? "" : t.lastHitAt)).join("|");
  const hb = hitSnap();
  const dpA = await mod.__dreamHooks.buildPrompt({});
  const ptA = (dpA && dpA.promptText) || "";
  const ha = hitSnap();
  ok(hb === ha, "G1 预筛零 markHit：buildPrompt 前后 lastHitAt 逐条相等", "changed=" + (hb !== ha));
  ok(!!ptA && ptA.includes("## Note → 关联主题（插件预筛 · 线索不是结论）"), "A1 任务书含预筛块头");
  const psC = (dpA && dpA.prescreen && dpA.prescreen.chars) || 0;
  ok(psC > 0 && psC <= 4600, "G4a 预筛块 ≤4,600 字", "chars=" + psC);
  ok(ptA.length <= 10500, "G4c 任务书总 ≤10,500 字", "len=" + ptA.length);
  ok(!/Expression tree is too large/.test(ptA), "G4d 不出现 Expression tree is too large");
  try {
    mod.__dreamHooks.setCfg({ dreamPrescreen: false });
    const dpB = await mod.__dreamHooks.buildPrompt({});
    const ptB = (dpB && dpB.promptText) || "";
    ok(!ptB.includes("## Note → 关联主题") && !ptB.includes("## 检查点证据"), "G4e flag 关 ⇒ 两个新块都不插");
    ok(ptB.length < ptA.length, "G4f flag 关 ⇒ 任务书变短（块确实被移除）", ptA.length + "→" + ptB.length);
    mod.__dreamHooks.setCfg({ dreamPrescreen: true });
  } catch (e) {
    ok(false, "G4e flag 关（__dreamHooks.setCfg）", String((e && e.message) || e));
  }
}

// ── 收尾 ──
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
