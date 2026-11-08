// _p3-cost-selftest.mjs — dsh-memory · P3-3 消耗记账数据层自测（node 直接跑，零依赖）
// 运行：node test/_p3-cost-selftest.mjs
// 覆盖：空账本 / bumpKind 全字段 / addDaily / pruneDaily 30 天滚动 / pushEvent 环形 500 裁剪 /
//       summarize 输出结构 / estTokens 边界(0,1,3,4,5) / 容错 / JSON 回读稳定性 / 无 IO·时间全局
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mod from "../p3-cost.js";

const {
  COST_VERSION, KIND_LIST, emptyCost, bumpKind, addDaily,
  pushEvent, pruneDaily, summarize, estTokens
} = mod;

let pass = 0;
let fail = 0;
const failed = [];
function t(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failed.push(name);
    console.log("FAIL  " + name + "\n      " + ((e && e.message) || String(e)).split("\n").join("\n      "));
  }
}

const DAY = 86400000;
function keyOffset(base, off) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(base);
  assert.ok(m, "bad base key " + base);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + off * DAY);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}
const allZero = (rec) => Object.keys(rec).every((k) => rec[k] === 0);

// 契约里的 delta 字段全集（用于「只累加各自字段」的全环节覆盖测试）
const DELTA_ALL = {
  n: 1, inTokens: 10, outTokens: 5, cacheReadTokens: 7, totalTokens: 22,
  inChars: 40, outChars: 8, injectedChars: 400, estTokens: 99, resultChars: 30,
  bytes: 1024, durMs: 200, fail: 1, retry: 1, timeout: 1, ok: 1,
  miss: 1, written: 1, beforeChars: 100, afterChars: 90,
  cacheRead: 3, cacheWrite: 2, turns: 1
};
function expectedField(f, d) {
  if (f === "cacheReadTokens") return d.cacheReadTokens;
  if (f === "cacheRead") return d.cacheRead;
  if (f === "turns") return d.turns;
  return d[f];
}

// ───────────────────────────── 模块表面 ─────────────────────────────

t("exports: 契约函数/常量齐全", () => {
  assert.equal(COST_VERSION, 1);
  for (const fn of ["emptyCost", "bumpKind", "addDaily", "pushEvent", "pruneDaily", "summarize", "estTokens"]) {
    assert.equal(typeof mod[fn], "function", "缺少导出 " + fn);
  }
});

t("KIND_LIST: 15 环节（2026-11-02 口径拆分 +hostMain/+hostSub）且顺序与契约一致、已冻结", () => {
  assert.deepEqual(KIND_LIST.slice(), [
    "checkpointWrite", "rebuildInject", "startupInject", "recallReminder",
    "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export",
    "hostUsage", "hostMain", "hostSub"
  ]);
  assert.equal(KIND_LIST.length, 15);
  assert.ok(Object.isFrozen(KIND_LIST));
});

// ───────────────────────────── 空账本 ─────────────────────────────

t("emptyCost: 顶层结构（version/since/totals/daily/events/limits）", () => {
  const c = emptyCost();
  assert.equal(c.version, 1);
  assert.equal(c.since, 0);
  assert.deepEqual(c.daily, {});
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.limits, { dailyEstTokens: 0, perKind: {} });
  assert.deepEqual(Object.keys(c.totals).sort(), KIND_LIST.slice().sort());
});

t("emptyCost: 15 环节字段集与 §5.2 一致且全为 0", () => {
  const c = emptyCost();
  const EXPECT = {
    checkpointWrite: "n,inTokens,outTokens,cacheReadTokens,totalTokens,inChars,outChars,estTokens,durMs,fail,retry,timeout",
    rebuildInject: "n,injectedChars,estTokens",
    startupInject: "n,injectedChars,estTokens",
    recallReminder: "n,injectedChars",
    hintA: "n,injectedChars",
    hintB: "n,injectedChars",
    hintC: "n,injectedChars",
    memorySearch: "n,resultChars,durMs,miss",
    dream: "n,inTokens,outTokens,cacheReadTokens,totalTokens,durMs,ok",
    maint: "n,inTokens,outTokens,totalTokens,beforeChars,afterChars",
    archive: "n,inTokens,outTokens,totalTokens,written,inChars",
    export: "n,bytes,durMs",
    hostUsage: "inTokens,outTokens,totalTokens,cacheRead,cacheWrite,turns",
    hostMain: "n,inTokens,outTokens,totalTokens,cacheRead,cacheWrite",
    hostSub: "n,inTokens,outTokens,totalTokens,cacheRead,cacheWrite"
  };
  for (const k of KIND_LIST) {
    assert.deepEqual(Object.keys(c.totals[k]), EXPECT[k].split(","), k + " 字段集不对");
    assert.ok(allZero(c.totals[k]), k + " 初值应为全 0");
  }
});

t("emptyCost: 多次调用返回互相独立的账本", () => {
  const a = emptyCost();
  const b = emptyCost();
  a.totals.dream.n = 5;
  assert.equal(b.totals.dream.n, 0);
  assert.notEqual(a.totals, b.totals);
  assert.notEqual(a.events, b.events);
});

// ───────────────────────────── bumpKind ─────────────────────────────

t("bumpKind: checkpointWrite 12 字段一次累加", () => {
  const c = emptyCost();
  bumpKind(c, "checkpointWrite", {
    n: 1, inTokens: 100, outTokens: 20, cacheReadTokens: 300, totalTokens: 420,
    inChars: 5000, outChars: 800, estTokens: 1450, durMs: 15000,
    fail: 1, retry: 1, timeout: 0
  });
  assert.deepEqual(c.totals.checkpointWrite, {
    n: 1, inTokens: 100, outTokens: 20, cacheReadTokens: 300, totalTokens: 420,
    inChars: 5000, outChars: 800, estTokens: 1450, durMs: 15000,
    fail: 1, retry: 1, timeout: 0
  });
});

t("bumpKind: 多次累加（n/durMs/fail 递增）", () => {
  const c = emptyCost();
  bumpKind(c, "checkpointWrite", { n: 1, durMs: 1000 });
  bumpKind(c, "checkpointWrite", { n: 2, durMs: 500, fail: 1 });
  const r = c.totals.checkpointWrite;
  assert.equal(r.n, 3);
  assert.equal(r.durMs, 1500);
  assert.equal(r.fail, 1);
});

t("bumpKind: 缺省/未知字段不写入（各环节只累加各自字段）", () => {
  const base = emptyCost();
  for (const k of KIND_LIST) {
    const c = emptyCost();
    bumpKind(c, k, DELTA_ALL);
    assert.deepEqual(Object.keys(c.totals[k]), Object.keys(base.totals[k]), k + " 字段集应稳定");
    for (const f of Object.keys(c.totals[k])) {
      assert.equal(c.totals[k][f], expectedField(f, DELTA_ALL), k + "." + f + " 累加值不对");
    }
  }
});

t("bumpKind: 未知 kind 静默忽略（不新增键、不抛错）", () => {
  const c = emptyCost();
  bumpKind(c, "bogusKind", { n: 5 });
  bumpKind(c, undefined, { n: 5 });
  bumpKind(c, 123, { n: 5 });
  assert.equal(c.totals.bogusKind, undefined);
  assert.equal(Object.keys(c.totals).length, 15);
});

t("bumpKind: memorySearch.miss / archive.written / maint 前后字符", () => {
  const c = emptyCost();
  bumpKind(c, "memorySearch", { n: 1, resultChars: 1200, durMs: 80, miss: 1 });
  bumpKind(c, "archive", { n: 1, inTokens: 30, outTokens: 4, totalTokens: 34, written: 2, inChars: 5600 });
  bumpKind(c, "maint", { n: 1, beforeChars: 900, afterChars: 700 });
  assert.deepEqual(c.totals.memorySearch, { n: 1, resultChars: 1200, durMs: 80, miss: 1 });
  assert.equal(c.totals.archive.written, 2);
  assert.equal(c.totals.archive.inChars, 5600);   // [task-20] 归档送入消息流字符数
  assert.equal(c.totals.maint.beforeChars, 900);
  assert.equal(c.totals.maint.afterChars, 700);
});

t("bumpKind: dream.ok 布尔 → 1 且只计真值", () => {
  const c = emptyCost();
  bumpKind(c, "dream", { n: 1, ok: true });
  bumpKind(c, "dream", { n: 1, ok: false });
  assert.equal(c.totals.dream.n, 2);
  assert.equal(c.totals.dream.ok, 1);
});

t("bumpKind: hostUsage 别名（turns←n、cacheReadTokens→cacheRead），无 n 字段", () => {
  const c = emptyCost();
  bumpKind(c, "hostUsage", { n: 1, inTokens: 5578, outTokens: 73, totalTokens: 101139, cacheReadTokens: 95488 });
  const r = c.totals.hostUsage;
  assert.equal(r.turns, 1);
  assert.equal(r.inTokens, 5578);
  assert.equal(r.totalTokens, 101139);
  assert.equal(r.cacheRead, 95488);
  assert.equal(r.n, undefined);
});

t("bumpKind: 注入型环节 estTokens 自动派生（injectedChars/4）", () => {
  const c = emptyCost();
  bumpKind(c, "startupInject", { n: 1, injectedChars: 6000 });
  bumpKind(c, "rebuildInject", { n: 1, injectedChars: 4001 });   // 4001/4 = 1000.25 → 1001
  bumpKind(c, "recallReminder", { n: 3, injectedChars: 480 });   // 该环节无 estTokens 字段
  assert.equal(c.totals.startupInject.estTokens, 1500);
  assert.equal(c.totals.rebuildInject.estTokens, 1001);
  assert.equal(c.totals.recallReminder.estTokens, undefined);
});

t("bumpKind: 显式 estTokens 优先于自动派生", () => {
  const c = emptyCost();
  bumpKind(c, "startupInject", { n: 1, injectedChars: 6000, estTokens: 777 });
  assert.equal(c.totals.startupInject.estTokens, 777);
});

t("bumpKind: checkpointWrite 自动 est = ceil(in/4)+ceil(out/4)", () => {
  const c = emptyCost();
  bumpKind(c, "checkpointWrite", { n: 1, inChars: 5001, outChars: 801 });   // 1251 + 201
  assert.equal(c.totals.checkpointWrite.estTokens, 1452);
});

t("bumpKind: 布尔 fail/retry → 1", () => {
  const c = emptyCost();
  bumpKind(c, "checkpointWrite", { n: 1, fail: true, retry: true });
  assert.equal(c.totals.checkpointWrite.fail, 1);
  assert.equal(c.totals.checkpointWrite.retry, 1);
});

t("bumpKind: 负数 delta 可用于修正", () => {
  const c = emptyCost();
  bumpKind(c, "export", { n: 5, bytes: 500 });
  bumpKind(c, "export", { n: -2, bytes: -100 });
  assert.equal(c.totals.export.n, 3);
  assert.equal(c.totals.export.bytes, 400);
});

t("bumpKind: cost 缺失/损坏时自动建账或修补", () => {
  const c1 = bumpKind(undefined, "export", { n: 1, bytes: 10 });
  assert.equal(c1.version, 1);
  assert.equal(c1.totals.export.bytes, 10);
  const c2 = bumpKind({ totals: { export: { n: "oops", bytes: null } } }, "export", { n: 2, bytes: 3 });
  assert.equal(c2.totals.export.n, 2);
  assert.equal(c2.totals.export.bytes, 3);
  const c3 = bumpKind({ totals: [] }, "dream", { n: 1 });
  assert.equal(c3.totals.dream.n, 1);
});

t("bumpKind: 返回同一对象（可链式 cost = bumpKind(cost,...)）", () => {
  const c = emptyCost();
  assert.equal(bumpKind(c, "export", { n: 1 }), c);
});

// ───────────────────────────── addDaily ─────────────────────────────

t("addDaily: 建 daily 桶、不动 totals", () => {
  const c = emptyCost();
  addDaily(c, "2026-11-02", "checkpointWrite", { n: 1, inChars: 4000, outChars: 400, durMs: 1000 });
  assert.equal(c.totals.checkpointWrite.n, 0);
  assert.equal(c.daily["2026-11-02"].checkpointWrite.n, 1);
  assert.equal(c.daily["2026-11-02"].checkpointWrite.estTokens, 1100);   // 1000 + 100
  assert.deepEqual(Object.keys(c.daily["2026-11-02"]), ["checkpointWrite"]);   // 懒建
});

t("addDaily: 同日累加 + 两日互相独立", () => {
  const c = emptyCost();
  addDaily(c, "2026-11-02", "dream", { n: 1, inTokens: 100, outTokens: 10 });
  addDaily(c, "2026-11-02", "dream", { n: 2, inTokens: 50, outTokens: 5 });
  addDaily(c, "2026-11-03", "dream", { n: 4, inTokens: 1, outTokens: 1 });
  assert.equal(c.daily["2026-11-02"].dream.n, 3);
  assert.equal(c.daily["2026-11-02"].dream.inTokens, 150);
  assert.equal(c.daily["2026-11-03"].dream.n, 4);
  assert.equal(c.daily["2026-11-03"].dream.inTokens, 1);
});

t("addDaily: 记录结构同 totals（完整字段集）", () => {
  const c = emptyCost();
  addDaily(c, "2026-11-02", "export", { n: 1, bytes: 9 });
  assert.deepEqual(Object.keys(c.daily["2026-11-02"].export), Object.keys(emptyCost().totals.export));
});

t("addDaily: 非法 dateKey / 未知 kind 静默忽略", () => {
  const c = emptyCost();
  addDaily(c, "2026-13-01", "export", { n: 1 });
  addDaily(c, "2026-02-30", "export", { n: 1 });
  addDaily(c, "20261102", "export", { n: 1 });
  addDaily(c, "", "export", { n: 1 });
  addDaily(c, null, "export", { n: 1 });
  addDaily(c, "2026-11-02", "bogus", { n: 1 });
  assert.deepEqual(c.daily, {});
});

t("addDaily: 返回同一对象", () => {
  const c = emptyCost();
  assert.equal(addDaily(c, "2026-11-02", "export", { n: 1 }), c);
});

// ───────────────────────────── pruneDaily ─────────────────────────────

function fillRange(days, baseKey) {
  const c = emptyCost();
  for (let i = days - 1; i >= 0; i--) addDaily(c, keyOffset(baseKey, -i), "export", { n: 1, bytes: 10 });
  return c;
}

t("pruneDaily: 30 天滚动（35 天数据 → 只留最近 30 天）", () => {
  const today = "2026-11-02";
  const c = fillRange(35, today);
  assert.equal(Object.keys(c.daily).length, 35);
  pruneDaily(c, 30, today);
  assert.equal(Object.keys(c.daily).length, 30);
  assert.ok(c.daily[keyOffset(today, -29)], "cutoff 当天（30 天前）应保留");
  assert.equal(c.daily[keyOffset(today, -30)], undefined, "第 31 天前应删除");
  assert.ok(c.daily[today], "今天应保留");
});

t("pruneDaily: 30 天边界精确（2026-11-02 → 保留 2026-10-04 起）", () => {
  const c = fillRange(40, "2026-11-02");
  pruneDaily(c, 30, "2026-11-02");
  assert.ok(c.daily["2026-10-04"], "2026-10-04 = 第 30 天，应保留");
  assert.equal(c.daily["2026-10-03"], undefined, "2026-10-03 = 第 31 天，应删除");
  assert.deepEqual(Object.keys(c.daily).sort()[0], "2026-10-04");
});

t("pruneDaily: keepDays=1 只留今天", () => {
  const c = fillRange(5, "2026-11-02");
  pruneDaily(c, 1, "2026-11-02");
  assert.deepEqual(Object.keys(c.daily), ["2026-11-02"]);
});

t("pruneDaily: 不认识的历史键保留（不毁灭未知数据）", () => {
  const c = emptyCost();
  addDaily(c, "2026-11-02", "export", { n: 1 });
  c.daily["legacy-key"] = { export: { n: 9 } };
  c.daily["2026-xx-01"] = { export: { n: 8 } };
  pruneDaily(c, 30, "2026-11-02");
  assert.ok(c.daily["legacy-key"]);
  assert.ok(c.daily["2026-xx-01"]);
});

t("pruneDaily: todayKey 缺失/非法 → 不动账本", () => {
  const c = fillRange(40, "2026-11-02");
  pruneDaily(c, 30, undefined);
  pruneDaily(c, 30, "not-a-date");
  assert.equal(Object.keys(c.daily).length, 40);
});

t("pruneDaily: keepDays 非正/非法 → 回落 30；返回同一对象", () => {
  const c = fillRange(35, "2026-11-02");
  assert.equal(pruneDaily(c, 0, "2026-11-02"), c);
  assert.equal(Object.keys(c.daily).length, 30);
});

// ───────────────────────────── pushEvent ─────────────────────────────

t("pushEvent: 字段白名单 + 类型/长度归一", () => {
  const c = emptyCost();
  pushEvent(c, {
    t: 123, kind: "checkpointWrite", sid: "s".repeat(100), trigger: "T1",
    note: "n".repeat(300), d: "2026-11-02", inChars: "500", estTokens: 125,
    durMs: 10, ok: true, fail: false, retry: true, bogusKey: 42
  });
  const ev = c.events[0];
  assert.equal(ev.t, 123);
  assert.equal(ev.kind, "checkpointWrite");
  assert.equal(ev.sid.length, 64);
  assert.equal(ev.trigger, "T1");
  assert.equal(ev.note.length, 200);
  assert.equal(ev.d, "2026-11-02");
  assert.equal(ev.inChars, 500);
  assert.equal(ev.estTokens, 125);
  assert.equal(ev.durMs, 10);
  assert.equal(ev.ok, 1);
  assert.equal(ev.fail, 0);
  assert.equal(ev.retry, 1);
  assert.equal(ev.bogusKey, undefined);
});

t("pushEvent: 环形 500 条裁剪（600 条 → 留最后 500，首条 t=101）", () => {
  const c = emptyCost();
  for (let i = 1; i <= 600; i++) pushEvent(c, { t: i, kind: "checkpointWrite" });
  assert.equal(c.events.length, 500);
  assert.equal(c.events[0].t, 101);
  assert.equal(c.events[499].t, 600);
});

t("pushEvent: 自定义 cap=10 生效", () => {
  const c = emptyCost();
  for (let i = 1; i <= 25; i++) pushEvent(c, { t: i, kind: "export" }, 10);
  assert.equal(c.events.length, 10);
  assert.equal(c.events[0].t, 16);
  assert.equal(c.events[9].t, 25);
});

t("pushEvent: cap=0/非法回落默认 500", () => {
  const c = emptyCost();
  for (let i = 1; i <= 600; i++) pushEvent(c, { t: i, kind: "export" }, 0);
  assert.equal(c.events.length, 500);
});

t("pushEvent: 非对象 ev 也能安全记账（t=0、无异常）", () => {
  const c = emptyCost();
  pushEvent(c, null);
  pushEvent(c, "oops");
  pushEvent(c, undefined);
  assert.equal(c.events.length, 3);
  assert.deepEqual(c.events[0], { t: 0 });
});

t("pushEvent: events 非数组时自愈重建；返回同一对象", () => {
  const c = emptyCost();
  c.events = "broken";
  assert.equal(pushEvent(c, { t: 1, kind: "export" }), c);
  assert.ok(Array.isArray(c.events));
  assert.equal(c.events.length, 1);
});

// ───────────────────────────── estTokens 边界 ─────────────────────────────

t("estTokens: 边界 0/1/3/4/5 → 0/1/1/1/2", () => {
  assert.equal(estTokens(0), 0);
  assert.equal(estTokens(1), 1);
  assert.equal(estTokens(3), 1);
  assert.equal(estTokens(4), 1);
  assert.equal(estTokens(5), 2);
});

t("estTokens: 负数/非数字/null/undefined/布尔", () => {
  assert.equal(estTokens(-100), 0);
  assert.equal(estTokens(NaN), 0);
  assert.equal(estTokens(null), 0);
  assert.equal(estTokens(undefined), 0);
  assert.equal(estTokens("8"), 2);
  assert.equal(estTokens(true), 1);
  assert.equal(estTokens("abc"), 0);
});

// ───────────────────────────── summarize ─────────────────────────────

function buildSample() {
  const today = "2026-11-02";
  const yest = "2026-11-01";
  const c = emptyCost();
  // 累计态
  bumpKind(c, "checkpointWrite", { n: 1, inChars: 8000, outChars: 1200, durMs: 8000, fail: 1, retry: 1 });
  bumpKind(c, "checkpointWrite", { n: 9, inChars: 40000, outChars: 4000, durMs: 9000 });   // 累计 est 再 +11000
  bumpKind(c, "startupInject", { n: 1, injectedChars: 6000 });
  bumpKind(c, "export", { n: 1, bytes: 1024, durMs: 30 });
  // [2026-11-02 口径拆分] 主会话 = hostMain（对照）；子代理 = hostSub（插件真实成本）
  bumpKind(c, "hostMain", { n: 4, inTokens: 1200, outTokens: 340, cacheReadTokens: 8400000 });
  bumpKind(c, "hostSub", { n: 2, inTokens: 500, outTokens: 100, cacheReadTokens: 200000 });
  // 今日日账
  addDaily(c, today, "checkpointWrite", { n: 1, inChars: 8000, outChars: 1200, durMs: 8000, fail: 1, retry: 1 });
  addDaily(c, today, "startupInject", { n: 1, injectedChars: 6000 });
  addDaily(c, today, "hostMain", { n: 4, inTokens: 1200, outTokens: 340, cacheReadTokens: 8400000 });
  addDaily(c, today, "hostSub", { n: 2, inTokens: 500, outTokens: 100, cacheReadTokens: 200000 });
  // 昨日日账（只进趋势，不扰动今日口径）
  addDaily(c, yest, "checkpointWrite", { n: 1, inChars: 400, outChars: 40 });
  // 事件：今日 T1×2、T4×1；昨日 T2×1；另有一条非 checkpoint 事件
  pushEvent(c, { t: 1, kind: "checkpointWrite", sid: "s1", trigger: "T1", d: today, inChars: 4000, outChars: 400, estTokens: 1100, durMs: 8000, ok: 1 });
  pushEvent(c, { t: 2, kind: "checkpointWrite", sid: "s1", trigger: "T1", d: today, inChars: 4000, outChars: 400, estTokens: 1100, durMs: 8000, fail: 1 });
  pushEvent(c, { t: 3, kind: "checkpointWrite", sid: "s2", trigger: "T4", d: today, inChars: 2000, outChars: 200, estTokens: 550, durMs: 3000 });
  pushEvent(c, { t: 4, kind: "checkpointWrite", sid: "s2", trigger: "T2", d: yest, inChars: 100, outChars: 10, estTokens: 28 });
  pushEvent(c, { t: 5, kind: "memorySearch", sid: "s1", d: today, resultChars: 300, durMs: 40 });
  return { c, today, yest };
}

t("summarize: 顶层输出结构稳定", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.deepEqual(Object.keys(s).sort(), [
    "byKind", "cumulative", "events", "kindList", "limits", "since",
    "today", "todayKey", "topSessions", "trend", "trend7d", "version"
  ]);
  assert.equal(s.version, 1);
  assert.equal(s.todayKey, today);
  assert.equal(s.today.dateKey, today);
  assert.deepEqual(s.kindList, KIND_LIST.slice());
  assert.deepEqual(s.limits, { dailyEstTokens: 0, perKind: {} });
  assert.deepEqual(s.byKind, s.today.kinds);          // 面板便捷别名
  assert.equal(s.trend7d.length, 7);                  // 固定 7 天口径
  assert.deepEqual(s.trend7d, s.trend);
  for (const scope of ["today", "cumulative"]) {
    const x = s[scope];
    assert.equal(typeof x.n, "number");
    assert.deepEqual(Object.keys(x.real), ["inTokens", "outTokens", "cacheRead", "cacheWrite", "totalTokens", "turns"]);
    assert.deepEqual(Object.keys(x.est), ["byKind", "total"]);
    assert.equal(Object.keys(x.est.byKind).length, 15);
    assert.equal(typeof x.fails.total, "number");
    assert.equal(typeof x.fails.byKind, "object");
    assert.deepEqual(Object.keys(x.kinds), KIND_LIST);
    for (const k of KIND_LIST) assert.equal(typeof x.kinds[k].avgDurMs, "number", k + ".avgDurMs");
  }
});

t("summarize: today 今日口径（真实 tokens / 估算 tokens / 次数）", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.today.n, 2);   // checkpointWrite 1 + startupInject 1（hostUsage 不计入 n）
  // [2026-11-02] real = 插件真实成本（hostSub 子代理桶）；realMain 才是用户对话（对照）
  assert.deepEqual(s.today.real, {
    inTokens: 500, outTokens: 100, cacheRead: 200000, cacheWrite: 0, totalTokens: 600, turns: 2
  });
  assert.deepEqual(s.today.realMain, {
    inTokens: 1200, outTokens: 340, cacheRead: 8400000, cacheWrite: 0, totalTokens: 1540, turns: 4
  });
  assert.equal(s.today.est.byKind.checkpointWrite, 2300);
  assert.equal(s.today.est.byKind.startupInject, 1500);
  assert.equal(s.today.est.total, 3800);
  assert.equal(s.today.kinds.checkpointWrite.avgDurMs, 8000);
});

t("summarize: cumulative 累计口径与今日不同", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.cumulative.est.total, 14800);   // 11000 + 2300 + 1500
  assert.equal(s.cumulative.kinds.checkpointWrite.n, 10);
  assert.equal(s.cumulative.kinds.checkpointWrite.avgDurMs, 1700);   // 17000 / 10
  assert.equal(s.cumulative.real.turns, 2);   // hostSub（子代理）轮次
  assert.equal(s.today.est.total, 3800);
});

t("summarize: triggers 按日归集（T1×2、T4×1；昨日 T2 不计入今日）", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.today.triggers.T1, 2);
  assert.equal(s.today.triggers.T2, 0);
  assert.equal(s.today.triggers.T4, 1);
  assert.equal(s.today.triggers.total, 3);
  assert.equal(s.today.triggers.other, 0);
});

t("summarize: fails 聚合（fail 总数 + byKind 明细）", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.today.fails.total, 1);
  assert.deepEqual(s.today.fails.byKind.checkpointWrite, { fail: 1, retry: 1, timeout: 0 });
  assert.equal(s.cumulative.fails.total, 1);
});

t("summarize: trend 7 天、升序、末日=今天、缺日补零", () => {
  const { c, today, yest } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.trend.length, 7);
  assert.equal(s.trend[6].date, today);
  assert.equal(s.trend[5].date, yest);
  for (let i = 1; i < s.trend.length; i++) assert.ok(s.trend[i].date > s.trend[i - 1].date, "trend 应按日期升序");
  assert.equal(s.trend[6].estTokens, 3800);
  assert.equal(s.trend[6].n, 2);
  assert.equal(s.trend[6].real, 600);   // [2026-11-02] real = hostSub（插件真实成本），不再用 hostUsage 混合桶
  assert.equal(s.trend[5].estTokens, 110);   // 100 + 10
  assert.equal(s.trend[0].estTokens, 0, "缺日应补零");
  assert.equal(s.trend[6].triggers, 3);
  assert.equal(s.trend[5].triggers, 1);
});

t("summarize: topSessions 按会话聚合、按估算 tokens 降序", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today });
  assert.equal(s.topSessions.length, 2);
  assert.deepEqual(s.topSessions[0], {
    sid: "s1", n: 2, inChars: 8000, outChars: 800, estTokens: 2200, durMs: 16000, fail: 1
  });
  assert.equal(s.topSessions[1].sid, "s2");
  assert.equal(s.topSessions[1].n, 1);
});

t("summarize: events 明细条数可配（events:2 → 最近 2 条）", () => {
  const { c, today } = buildSample();
  const s = summarize(c, { todayKey: today, events: 2 });
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].kind, "memorySearch");
  assert.equal(summarize(c, { todayKey: today, events: 0 }).events.length, 0);
});

t("summarize: 无 todayKey → today 空态、trend 为空（时间不外猜）", () => {
  const { c } = buildSample();
  const s = summarize(c);
  assert.equal(s.todayKey, null);
  assert.deepEqual(s.trend, []);
  assert.equal(s.today.n, 0);
  assert.equal(s.today.est.total, 0);
  assert.equal(s.cumulative.est.total, 14800);
  assert.equal(s.topSessions.length, 2);   // 无 d 过滤时按最近窗口统计
});

t("summarize: 非法 todayKey（2026-02-30）按缺失处理", () => {
  const { c } = buildSample();
  assert.equal(summarize(c, { todayKey: "2026-02-30" }).todayKey, null);
  assert.equal(summarize(c, { todayKey: 123 }).todayKey, null);
});

t("summarize: days/topN/events 钳制 + trend7d 恒 7 天", () => {
  const { c, today } = buildSample();
  assert.equal(summarize(c, { todayKey: today, days: 999 }).trend.length, 90);
  assert.equal(summarize(c, { todayKey: today, days: -5 }).trend.length, 1);
  assert.equal(summarize(c, { todayKey: today, days: 3 }).trend.length, 3);
  assert.equal(summarize(c, { todayKey: today, days: 3 }).trend7d.length, 7);
  assert.ok(summarize(c, { todayKey: today, topN: 999 }).topSessions.length <= 50);
  assert.equal(summarize(c, { todayKey: today, events: -1 }).events.length, 0);
});

t("summarize: real.totalTokens = 计费口径 in+out（2026-11-02 修正：不再累加上下文快照、不含 cacheRead）", () => {
  const c = emptyCost();
  addDaily(c, "2026-11-02", "hostSub", { n: 1, inTokens: 5578, outTokens: 73, cacheReadTokens: 95488 });
  const s = summarize(c, { todayKey: "2026-11-02" });
  assert.equal(s.today.real.totalTokens, 5651);     // 5578 + 73（cacheRead 单独列，不并入消耗）
  assert.equal(s.today.real.cacheRead, 95488);
});

t("summarize: 空账本/损坏账本/缺参都安全（不抛错）", () => {
  const s1 = summarize(emptyCost(), { todayKey: "2026-11-02" });
  assert.equal(s1.today.est.total, 0);
  assert.equal(s1.trend.length, 7);
  assert.equal(s1.cumulative.n, 0);
  const s2 = summarize({ totals: [], daily: "x", events: 5, limits: null }, { todayKey: "2026-11-02" });
  assert.equal(s2.today.est.total, 0);
  assert.equal(Object.keys(s2.cumulative.kinds).length, 15);
  const s3 = summarize(null);
  assert.equal(s3.version, 1);
  assert.equal(s3.cumulative.est.total, 0);
});

t("summarize: JSON 回读（flush→load）后结果恒等", () => {
  const { c, today } = buildSample();
  const opts = { todayKey: today, days: 7, topN: 5, events: 5 };
  const again = JSON.parse(JSON.stringify(c));
  assert.deepEqual(summarize(again, opts), summarize(c, opts));
});

// ───────────────────────────── 纯函数纪律 ─────────────────────────────

t("purity: 源码无 IO / 网络 / 时间全局 / 随机 / import", () => {
  const src = readFileSync(new URL("../p3-cost.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");   // 去掉行注释（注释里会提到被禁 API）
  const forbidden = [
    [/Date\.now\s*\(/, "Date.now()"],
    [/new Date\s*\(\s*\)/, "new Date() 无参"],
    [/Math\.random\s*\(/, "Math.random()"],
    [/\brequire\s*\(/, "require()"],
    [/^\s*import\s/m, "import 语句（本模块应零依赖）"],
    [/\bfs\./, "fs API"],
    [/\bfetch\s*\(/, "fetch()"],
    [/process\./, "process"],
    [/setTimeout\s*\(|setInterval\s*\(/, "定时器"]
  ];
  for (const [re, label] of forbidden) assert.ok(!re.test(code), "命中禁用 " + label);
});

t("purity: 相同输入重复调用结果一致（无隐藏状态/时钟依赖）", () => {
  const a = emptyCost();
  const b = emptyCost();
  for (const c of [a, b]) {
    bumpKind(c, "checkpointWrite", { n: 1, inChars: 800, outChars: 80 });
    addDaily(c, "2026-11-02", "checkpointWrite", { n: 1, inChars: 800, outChars: 80 });
    pushEvent(c, { t: 1, kind: "checkpointWrite", sid: "s", trigger: "T1", d: "2026-11-02" });
    pruneDaily(c, 30, "2026-11-02");
  }
  assert.deepEqual(summarize(a, { todayKey: "2026-11-02" }), summarize(b, { todayKey: "2026-11-02" }));
  assert.deepEqual(a, b);
});

// ───────────────────────────── 结果 ─────────────────────────────

if (fail > 0) {
  console.log("\n失败用例：\n- " + failed.join("\n- "));
}
console.log("\nPASS " + pass + " / FAIL " + fail);
process.exitCode = fail > 0 ? 1 : 0;
