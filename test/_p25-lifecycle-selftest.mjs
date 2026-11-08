// _p25-lifecycle-selftest.mjs —— P2.5 生命周期归档接线 + 记账字段补全自测（task-20）
//
// 跑法：node test/_p25-lifecycle-selftest.mjs [index.js 路径]
//
// 覆盖（7 类 + 记账 + 静态接线）：
//   ① 超 30 天 → 归档       ② 线内第 101 名 → 归档      ③ 第 100 名 → 不动
//   ④ 已 archived → 跳过（幂等，不重复调 archiveTopic）   ⑤ 单次最多归档 20 条
//   ⑥ 历史线「会话检查点」/ 历史日期主题 / 名字不可解析的子主题 / 跨线 wsKey 不匹配 → 一律不碰
//   ⑦ 单条 archiveTopic 抛错 → 记录后继续，不中断整轮
//   记账：archive 的 inChars、memorySearch 的 resultChars/miss 真被 bumpKind 累加
//   静态：低频 tick 已挂进既有 ctx.interval、钩子接线、archiveTopic(pointer:true) 调用形态
//
// 安全：os.tmpdir() 临时 home；fake store 全部在内存，绝不写真实 ~/.dsh/memory/。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-p25life-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- P25 自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- 测试主题 → knowledge/P25.md（P2.5 自测）\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const P25 = await import(pathToFileURL(path.join(here, "..", "p25-topics.js")).href);
const COMPAT = await import(pathToFileURL(path.join(here, "_accept-p0-lib.mjs")).href);
const p3cost = await import(pathToFileURL(path.join(here, "..", "p3-cost.js")).href);

// ═══════════════════════════════════════════════════════════════════════════
// fake store：内存 Map，level 用 store.be.getMeta("level:<id>") 提供（与真实 store 同口径）
// ═══════════════════════════════════════════════════════════════════════════
function mkFakeStore(specs) {
  const levels = new Map();
  const rows = [];
  const archived = [];
  for (const s of specs) {
    const t = {
      id: String(s.id), name: String(s.name), parentId: s.parentId == null ? null : String(s.parentId),
      state: String(s.state || "active"), updated_at: Number(s.updatedAt || 0), created_at: Number(s.createdAt || 0),
      _broken: !!s.broken,
    };
    rows.push(t);
    if (s.level) levels.set(t.id, String(s.level));
  }
  return {
    rows: rows, archived: archived,
    topics: () => rows,
    readTopic: (id) => ({ sentences: [{ id: 1, text: "## 检查点\n- fake body" }] }),
    archiveTopic: (id, opts) => {
      const t = rows.find((x) => x.id === String(id));
      if (!t) throw new Error("topic-not-found:" + id);
      if (t._broken) throw new Error("fake-archive-failure");
      t.state = "archived";
      archived.push({ id: String(id), opts: opts || {} });
      return { ok: true };
    },
    be: { getMeta: (k) => { const m = /^level:(.+)$/.exec(String(k)); return m ? (levels.get(m[1]) || null) : null; } },
  };
}
const NOW = Date.UTC(2026, 10, 3, 0, 0, 0);
const DAY = 86400000;
const OLD = NOW - 40 * DAY;          // 超 30 天
const FRESH = (i) => NOW - 3600000 - (i || 0) * 60000;   // 1 小时前起，按分钟递减
const sid8Of = (i) => (i >>> 0).toString(16).padStart(8, "0");
const D8 = { id: "d8", name: P25.D8_DOMAIN_NAME, level: "domain" };

// 前置：sweep 导出与钩子接线（apply 在临时 home 上跑）
ok(typeof mod.__p25LifecycleSweep === "function", "H0 模块导出 __p25LifecycleSweep");
const fx = COMPAT.makeCtx({});
COMPAT.applyPlugin(mod, { memoryTopicDbEnabled: true }, fx.ctx);
const ready = await COMPAT.waitTopicDb(mod, 20000);
ok(ready, "H1 前置：flag 开 ⇒ 主题库就绪（apply 正常）");
const H = mod.__p25Hooks || {};
ok(typeof H.sweep === "function" && typeof H.decide === "function" && typeof H.tick === "function",
  "H2 __p25Hooks 已接线（sweep/decide/tick）", JSON.stringify(Object.keys(H)));
ok(H.limit === 20, "H3 钩子单次上限常量 = 20", String(H.limit));
ok(H.decide({ archivedAt: NOW - 40 * DAY, now: NOW }) === "archived" && H.decide({ archivedAt: NOW - 1000, now: NOW }) === "active",
  "H4 __p25Hooks.decide 与 p25-topics.decideLifecycle 同源（30 天边界）");

// ═══════════════════════════════════════════════════════════════════════════
// ① 超 30 天 → 归档
// ═══════════════════════════════════════════════════════════════════════════
{
  const store = mkFakeStore([
    D8,
    { id: "L1", name: "会话检查点·WS-30D", parentId: "d8", level: "project" },
    { id: "T1", name: "WS-30D/aaaaaaaa", parentId: "L1", level: "detail", updatedAt: OLD },
  ]);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r.lines === 1 && r.scanned === 1 && r.archived === 1, "①超 30 天：1 条被归档", JSON.stringify(r));
  ok(store.rows.find((t) => t.id === "T1").state === "archived", "①归档后 state=archived");
  ok(store.archived.length === 1 && store.archived[0].opts.pointer === true && store.archived[0].opts.actor === "runtime"
    && /p2\.5-lifecycle/.test(String(store.archived[0].opts.reason || "")), "①archiveTopic 调用形态正确（pointer:true / actor:runtime / reason=p2.5-lifecycle）", JSON.stringify(store.archived[0] && store.archived[0].opts));
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 第 101 名 → 归档；③ 第 100 名 → 不动
// ═══════════════════════════════════════════════════════════════════════════
{
  const specs = [D8, { id: "L2", name: "会话检查点·WS-101", parentId: "d8", level: "project" }];
  for (let i = 0; i < 105; i++) specs.push({ id: "T2-" + i, name: "WS-101/" + sid8Of(i), parentId: "L2", level: "detail", updatedAt: FRESH(i) });
  const store = mkFakeStore(specs);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  const archivedIds = new Set(store.archived.map((x) => x.id));
  const idx101 = "T2-4";   // FRESH(4) 排序后 = 第 5 新……见下方按 updatedAt 复算
  // 复算真实排名（updatedAt 越大越新）：FRESH(i) 单调递减 ⇒ 排名 = i+1
  const rank = (i) => i + 1;
  let archivedByRank = 0;
  for (let i = 0; i < 105; i++) if (archivedIds.has("T2-" + i)) archivedByRank++;
  ok(r.scanned === 105, "②③ 扫描 105 条会话主题", String(r.scanned));
  ok(archivedByRank === 5, "②线内排名 >100 的 5 条被归档", "archived=" + archivedByRank);
  ok(archivedIds.has("T2-100") === true, "②第 101 名（rank=101）被归档");
  ok(archivedIds.has("T2-99") === false && store.rows.find((t) => t.id === "T2-99").state === "active",
    "③第 100 名（rank=100）不动", "idx=" + rank(99));
  ok(store.archived.every((x) => x.opts.pointer === true), "②③全部 pointer:true");
  void idx101;
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 已 archived → 跳过（不重复归档）；同一 store 再跑 ⇒ 0 新增（幂等）
// ═══════════════════════════════════════════════════════════════════════════
{
  const store = mkFakeStore([
    D8,
    { id: "L4", name: "会话检查点·WS-ARCH", parentId: "d8", level: "project" },
    { id: "T4A", name: "WS-ARCH/0000000a", parentId: "L4", level: "detail", updatedAt: OLD, state: "archived" },
    { id: "T4B", name: "WS-ARCH/0000000b", parentId: "L4", level: "detail", updatedAt: OLD },
  ]);
  const r1 = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r1.archived === 1 && store.archived.length === 1 && store.archived[0].id === "T4B",
    "④已 archived 的跳过、只归档另一条", "archived=" + JSON.stringify(store.archived.map((x) => x.id)));
  const r2 = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r2.archived === 0 && store.archived.length === 1, "④幂等：同 store 再跑 0 新增（不重复调 archiveTopic）", "archived=" + r2.archived);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 单次上限 20 条
// ═══════════════════════════════════════════════════════════════════════════
{
  const specs = [D8, { id: "L5", name: "会话检查点·WS-LIMIT", parentId: "d8", level: "project" }];
  for (let i = 0; i < 25; i++) specs.push({ id: "T5-" + i, name: "WS-LIMIT/" + sid8Of(i), parentId: "L5", level: "detail", updatedAt: OLD - i * 1000 });
  const store = mkFakeStore(specs);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r.archived === 20, "⑤单次最多归档 20 条", "archived=" + r.archived);
  ok(store.archived.length === 20 && store.rows.filter((t) => t.name.startsWith("WS-LIMIT/") && t.state === "active").length === 5,
    "⑤其余 5 条保持 active（等下一轮）");
  ok(r.candidates === 25, "⑤candidates=25 / skipped≥5", JSON.stringify({ candidates: r.candidates, skipped: r.skipped }));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 历史线 / 日期主题 / 不可解析名 / 跨线 wsKey 不匹配 → 一律不碰
// ═══════════════════════════════════════════════════════════════════════════
{
  const store = mkFakeStore([
    D8,
    // 历史线（无 · 后缀）——即使旧也绝不归档其子主题
    { id: "LEGACY", name: P25.LEGACY_LINE_NAME, parentId: "d8", level: "project" },
    { id: "TL", name: "WSX/deadbeef", parentId: "LEGACY", level: "detail", updatedAt: OLD },
    // 历史日期主题（不是「会话检查点·」线）
    { id: "TDAY", name: "2026-11-01", parentId: "d8", level: "detail", updatedAt: OLD },
    // 正常线 + 不可解析子主题 + 跨线 wsKey 子主题
    { id: "L6", name: "会话检查点·WS-OK", parentId: "d8", level: "project" },
    { id: "T6-BAD", name: "这不是会话主题名", parentId: "L6", level: "detail", updatedAt: OLD },
    { id: "T6-X", name: "WS-OTHER/deadbeef", parentId: "L6", level: "detail", updatedAt: OLD },
  ]);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r.lines === 1 && r.scanned === 0 && r.archived === 0 && store.archived.length === 0,
    "⑥历史线/日期主题/不可解析名/跨线主题全不碰（lines 只算「会话检查点·」线）", JSON.stringify(r));
  ok(store.rows.every((t) => t.state === "active"), "⑥无任何 state 被改");
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 单条失败不中断
// ═══════════════════════════════════════════════════════════════════════════
{
  const store = mkFakeStore([
    D8,
    { id: "L7", name: "会话检查点·WS-ERR", parentId: "d8", level: "project" },
    { id: "T7A", name: "WS-ERR/00000001", parentId: "L7", level: "detail", updatedAt: OLD, broken: true },
    { id: "T7B", name: "WS-ERR/00000002", parentId: "L7", level: "detail", updatedAt: OLD - 1000 },
  ]);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r.archived === 1 && store.archived.length === 1 && store.archived[0].id === "T7B",
    "⑦单条抛错不影响下一条（broken 跳过，另一条归档）", JSON.stringify({ archived: r.archived, skipped: r.skipped }));
  ok(!r.error, "⑦整轮不抛异常（返回结构完整）");
  ok(typeof r.lines === "number" && typeof r.scanned === "number" && typeof r.candidates === "number" && typeof r.skipped === "number",
    "⑦返回结构 {lines,scanned,archived,candidates,skipped}");
}
{
  const store = mkFakeStore([]);
  const r = mod.__p25LifecycleSweep(store, { now: NOW });
  ok(r.lines === 0 && r.archived === 0, "⑦空库：不抛、0 归档");
  const bad = mod.__p25LifecycleSweep(null, { now: NOW });
  ok(bad && bad.error === "store-unavailable" && bad.archived === 0, "⑦store 不可用：返回 error 不抛", JSON.stringify(bad));
}

// ═══════════════════════════════════════════════════════════════════════════
// 记账字段（task-20 二）：archive.inChars / memorySearch.resultChars+miss 真进 delta
// ═══════════════════════════════════════════════════════════════════════════
{
  const c = p3cost.emptyCost();
  p3cost.bumpKind(c, "archive", { n: 1, inTokens: 30, outTokens: 4, totalTokens: 34, written: 2, inChars: 5600 });
  p3cost.bumpKind(c, "memorySearch", { n: 1, resultChars: 1200, durMs: 80, miss: 1 });
  ok(c.totals.archive.inChars === 5600, "记账：archive.inChars 累加（此前恒 0）", String(c.totals.archive.inChars));
  ok(c.totals.archive.written === 2, "记账：archive.written 累加", String(c.totals.archive.written));
  ok(c.totals.memorySearch.resultChars === 1200 && c.totals.memorySearch.miss === 1,
    "记账：memorySearch.resultChars / miss 累加", JSON.stringify(c.totals.memorySearch));
  const empty = p3cost.emptyCost();
  ok(Object.prototype.hasOwnProperty.call(empty.totals.archive, "inChars"), "记账：emptyCost 的 archive 字段集已含 inChars");
  ok(Object.prototype.hasOwnProperty.call(empty.totals.memorySearch, "resultChars") && Object.prototype.hasOwnProperty.call(empty.totals.memorySearch, "miss"),
    "记账：emptyCost 的 memorySearch 字段集已含 resultChars/miss");
}

// ═══════════════════════════════════════════════════════════════════════════
// 静态接线断言
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(PLUGIN, "utf8");
  ok(/function p25LifecycleSweep\(store, opts\)/.test(src), "静态：p25LifecycleSweep 已定义");
  ok(/p25Topics\.decideLifecycle\(/.test(src), "静态：decideLifecycle 已有调用点（此前 0 处）");
  ok(/store\.archiveTopic\(c\.t\.id, \{ actor: "runtime", reason: "p2\.5-lifecycle/.test(src), "静态：archiveTopic(pointer:true, reason=p2.5-lifecycle) 调用存在");
  ok(/p25LifecycleTick\(Date\.now\(\)\)/.test(src), "静态：sweep 已挂进既有每小时 ctx.interval");
  ok(/t - P25_LIFE_ARMED_AT < 60000/.test(src), "静态：首跑延迟 ≥60s");
  ok(/24 \* 3600000/.test(src), "静态：每天最多一次（24h 闸）");
  ok(/p25LifeLastRun/.test(src), "静态：持久标记 p25LifeLastRun 已用");
  ok(/P25_TEST_HOOKS\.sweep =/.test(src) && /P25_TEST_HOOKS\.decide =/.test(src), "静态：P25_TEST_HOOKS 已接线");
  ok(/archive: \["n", "inTokens", "outTokens", "totalTokens", "written", "inChars"\]/.test(fs.readFileSync(path.join(here, "..", "p3-cost.js"), "utf8")),
    "静态：p3-cost.js archive 字段集含 inChars");
  // ★ 2026-11-04（用户指令「把漏网归档去掉」）：原断言钉的是**归档结算链**里的 `inChars: _p3ArchInChars`
  //   —— 该链（含 p3CostBump("archive") 调用点）已整体删除，归档 kind 只剩 p3-cost.js 的字段定义（上面那条仍守）。
  //   ⇒ 这里改为断言「归档记账调用点已不存在」，防止有人把它当活路径再引回来。
  ok(!/p3CostBump\("archive"/.test(src), "静态：归档链记账调用点已随漏网归档删除（p3-cost.js 的 kind 定义保留）");
}

// ── 收尾 ──
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
