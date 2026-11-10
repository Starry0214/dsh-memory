/**
 * _p3-triggers-selftest.mjs — dsh-memory P3-1 写侧触发纯函数自测
 * 运行：node test/_p3-triggers-selftest.mjs
 * 只 import ../p3-triggers.js；node: 内置仅用于读模块源码做纯度断言。零第三方依赖。
 * 覆盖：三档边界矩阵（0/49/49.9/50/74.9/75/89.9/90/100/超100%）、冷却、同档重复、
 *       跨档递进、跨档跳跃合并、压缩后重置、子代理排除、hasCheckpoint 排除、
 *       收尾空闲边界、漏网扫描窗口/排序/条数、markFired 幂等/不可变、纯度。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  THRESHOLD_LEVELS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_IDLE_MS, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_COUNT,
  computeLevels, decideThresholdTrigger, markFired, resetAfterCompact, decideSessionEnd, decideMissed,
} from "../p3-triggers.js";

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; failures.push(`${name}: ${(e && e.message) || e}`); }
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
}
function ok(cond, label = "") { if (!cond) throw new Error(label || "assertion failed"); }

// 测试标尺：thresholdTokens=1000 ⇒ 三档 = 500 / 750 / 900
const TT = 1000;
const fire = (tokens, firedLevels = [], extra = {}) =>
  decideThresholdTrigger({ totalTokens: tokens, thresholdTokens: TT, firedLevels, now: 1000000, lastFireAt: null, ...extra });

// ═══ 1. 常量与导出面 ═══
test("常量 THRESHOLD_LEVELS = 0.5/0.75/0.9 且冻结", () => {
  eq(THRESHOLD_LEVELS, [0.5, 0.75, 0.9]);
  ok(Object.isFrozen(THRESHOLD_LEVELS), "应 Object.freeze");
});
test("默认值：冷却 5min / 收尾 30min / 漏网 7 天 3 条", () => {
  eq(DEFAULT_MIN_INTERVAL_MS, 300000);
  eq(DEFAULT_IDLE_MS, 1800000);
  eq(DEFAULT_MAX_AGE_DAYS, 7);
  eq(DEFAULT_MAX_COUNT, 3);
});
test("导出面：六个决策函数均为 function", () => {
  for (const fn of [computeLevels, decideThresholdTrigger, markFired, resetAfterCompact, decideSessionEnd, decideMissed]) {
    eq(typeof fn, "function", String(fn));
  }
});

// ═══ 2. computeLevels ═══
test("computeLevels(838860) 精确三档 = 419430/629145/754974", () => {
  eq(computeLevels(838860), { t1: 419430, t2: 629145, t3: 754974 });
});
test("computeLevels(1000) = 500/750/900", () => {
  eq(computeLevels(1000), { t1: 500, t2: 750, t3: 900 });
});
test("computeLevels 向下取整（1001 ⇒ 500/750/900，0.9 档 900.9→900）", () => {
  eq(computeLevels(1001), { t1: 500, t2: 750, t3: 900 });
});
test("computeLevels 非法输入 → null", () => {
  for (const bad of [0, -1, NaN, Infinity, "838860", null, undefined]) eq(computeLevels(bad), null, String(bad));
});

// ═══ 3. 三档边界矩阵（thresholdTokens=1000）═══
const boundary = [
  ["0%", 0, [], false, "below-t1", null],
  ["49%", 490, [], false, "below-t1", null],
  ["49.9%", 499, [], false, "below-t1", null],
  ["50% 整点", 500, [], true, "threshold", 1],
  ["74.9%", 749, [], true, "threshold", 1],
  ["75% 整点（T1 已触发）", 750, [1], true, "threshold", 2],
  ["89.9%（T1/T2 已触发）", 899, [1, 2], false, "already-fired", null],
  ["90% 整点（T1/T2 已触发）", 900, [1, 2], true, "threshold", 3],
  ["100%（三档已触发）", 1000, [1, 2, 3], false, "already-fired", null],
  ["超 100%（三档已触发）", 1500, [1, 2, 3], false, "already-fired", null],
  ["100% 但只触发过 T1（跨档合并取最高）", 1000, [1], true, "threshold", 3],
];
for (const [label, tokens, fired, wantFire, wantReason, wantLevel] of boundary) {
  test(`边界矩阵 ${label}`, () => {
    const r = fire(tokens, fired);
    eq(r.fire, wantFire, "fire");
    eq(r.reason, wantReason, "reason");
    eq(r.level, wantLevel, "level");
  });
}

// ═══ 4. 触发语义：同档重复 / 冷却 / 非法输入 ═══
test("同档重复：T1 已触发，60% 不重复", () => {
  eq(fire(600, [1]), { fire: false, level: null, reason: "already-fired" });
});
test("冷却期内（<5min）不触发，level 保持 null", () => {
  const r = fire(800, [1], { now: 1000000 + 299999, lastFireAt: 1000000 });
  eq(r, { fire: false, level: null, reason: "cooldown" });
});
test("冷却到期（=5min）允许触发 T2", () => {
  eq(fire(800, [1], { now: 1000000 + 300000, lastFireAt: 1000000 }), { fire: true, level: 2, reason: "threshold" });
});
test("minIntervalMs=0 关闭冷却", () => {
  eq(fire(800, [1], { now: 1000001, lastFireAt: 1000000, minIntervalMs: 0 }).level, 2);
});
test("minIntervalMs 非法 → 回退默认 5min", () => {
  eq(fire(800, [1], { now: 1000000 + 299999, lastFireAt: 1000000, minIntervalMs: -1 }).reason, "cooldown");
});
test("时钟回拨（now < lastFireAt）按冷却期内处理", () => {
  eq(fire(800, [1], { now: 999000, lastFireAt: 1000000 }).reason, "cooldown");
});
test("lastFireAt 缺省 → 不拦冷却", () => {
  eq(fire(520, [], { lastFireAt: undefined }), { fire: true, level: 1, reason: "threshold" });
});
test("非法 totalTokens → invalid-usage", () => {
  for (const bad of [NaN, -1, undefined, null, "800"]) eq(fire(bad).reason, "invalid-usage", String(bad));
});
test("非法 thresholdTokens → invalid-threshold", () => {
  for (const bad of [0, -1, NaN, undefined, "1000", null]) {
    eq(decideThresholdTrigger({ totalTokens: 900, thresholdTokens: bad, firedLevels: [] }), { fire: false, level: null, reason: "invalid-threshold" });
  }
});
test("firedLevels 支持 Set 与脏值（[0,9,'2',2,2] ⇒ 视为 [2]）", () => {
  eq(fire(800, new Set([1])).level, 2);
  eq(fire(800, [0, 9, "2", 2, 2]).reason, "already-fired");
  eq(fire(520, { weird: 1 }).level, 1);
});

// ═══ 5. 跨档递进 / 跨档跳跃 / 压缩后重置 ═══
test("跨档递进：T1→T2→T3 每档一次，压缩后重置回 T1", () => {
  let fired = [];
  const r1 = fire(520, fired);
  eq(r1, { fire: true, level: 1, reason: "threshold" });
  fired = markFired(fired, r1.level);
  eq(fire(740, fired).reason, "already-fired");
  const r2 = fire(760, fired);
  eq(r2, { fire: true, level: 2, reason: "threshold" });
  fired = markFired(fired, r2.level);
  eq(fire(899, fired).reason, "already-fired");
  const r3 = fire(910, fired);
  eq(r3, { fire: true, level: 3, reason: "threshold" });
  fired = markFired(fired, r3.level);
  eq(fire(1500, fired), { fire: false, level: null, reason: "already-fired" });
  const reset = resetAfterCompact();
  eq(reset, []);
  eq(fire(520, reset, { now: 2000000, lastFireAt: 1000000 }), { fire: true, level: 1, reason: "threshold" });
});
test("跨档跳跃：40%→92% 只触发最高档 T3，低档被视为覆盖", () => {
  const r = fire(920, []);
  eq(r, { fire: true, level: 3, reason: "threshold" });
  const fired = markFired([], r.level);
  eq(fired, [3]);
  eq(fire(920, fired), { fire: false, level: null, reason: "already-fired" });
  eq(fire(760, fired), { fire: false, level: null, reason: "already-fired" });
});

// ═══ 6. markFired / resetAfterCompact ═══
test("markFired：新数组、不改入参、升序去重", () => {
  const a = [3];
  const b = markFired(a, 1);
  eq(b, [1, 3]);
  eq(a, [3]);
  ok(b !== a, "应返回新数组");
});
test("markFired 幂等", () => {
  eq(markFired(markFired([], 2), 2), [2]);
  eq(markFired([1, 2], 2), [1, 2]);
});
test("markFired 非法 level → no-op（仍返回规范化副本）", () => {
  for (const bad of [0, 4, 1.5, "x", NaN, null, undefined]) eq(markFired([2], bad), [2], String(bad));
});
test("markFired 非法 firedLevels → 空基线", () => {
  eq(markFired(undefined, 1), [1]);
  eq(markFired("1,2", 1), [1]);
  eq(markFired({}, 3), [3]);
});
test("markFired 支持 Set 入参", () => { eq(markFired(new Set([1]), 2), [1, 2]); });
test("resetAfterCompact 返回空数组且每次独立", () => {
  const r1 = resetAfterCompact();
  const r2 = resetAfterCompact();
  eq(r1, []);
  ok(r1 !== r2, "应为新数组");
  r1.push(1);
  eq(r2, []);
});

// ═══ 7. decideSessionEnd（T5 会话收尾）═══
const NOW = 10000000;
test("收尾：子代理排除（空闲 1h、无检查点也不触发）", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, isSubagent: true }), { fire: false, reason: "subagent" });
});
test("收尾：已写检查点不重复写", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, hasCheckpoint: true }), { fire: false, reason: "has-checkpoint" });
});
test("收尾：空闲 30 分钟整点触发", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 1800000, now: NOW }), { fire: true, reason: "idle" });
});
test("收尾：空闲 29:59.999 不触发", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 1799999, now: NOW }), { fire: false, reason: "not-idle" });
});
test("收尾：自定义 idleMs（1 分钟）边界", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 60000, now: NOW, idleMs: 60000 }), { fire: true, reason: "idle" });
  eq(decideSessionEnd({ lastActivityAt: NOW - 59999, now: NOW, idleMs: 60000 }).reason, "not-idle");
});
test("收尾：lastActivityAt 非法 → no-activity", () => {
  for (const bad of [undefined, null, 0, -5, NaN, "x"]) {
    eq(decideSessionEnd({ lastActivityAt: bad, now: NOW }), { fire: false, reason: "no-activity" }, String(bad));
  }
});
test("收尾：now 非法 → invalid-now", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW, now: undefined }), { fire: false, reason: "invalid-now" });
});
test("收尾：lastActivityAt 在未来 → not-idle", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW + 5000, now: NOW }), { fire: false, reason: "not-idle" });
});
test("收尾：空参数对象安全降级", () => {
  eq(decideSessionEnd(), { fire: false, reason: "no-activity" });
});
// ═══ 7b. T5 修复（4.5.10 / CRA 2026-11-09）：归档排除 + 最大空闲窗 ═══
test("收尾：已归档会话排除（T5-1）", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, isArchived: true }), { fire: false, reason: "archived" });
});
test("收尾：归档优先于 hasCheckpoint 与 idle", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, isArchived: true, hasCheckpoint: true }).reason, "archived");
  eq(decideSessionEnd({ lastActivityAt: NOW, now: NOW, isArchived: true }).reason, "archived");
});
test("收尾：超过最大空闲窗（默认 7 天）⇒ too-old（T5-F）", () => {
  const D7 = 7 * 86400000;
  const BIG = 100 * 86400000;   // 用大基准：NOW(1e7) 减 7 天会变负数，会先命中 no-activity
  eq(decideSessionEnd({ lastActivityAt: BIG - D7, now: BIG }), { fire: true, reason: "idle" });
  eq(decideSessionEnd({ lastActivityAt: BIG - D7 - 1, now: BIG }), { fire: false, reason: "too-old" });
});
test("收尾：自定义 maxIdleMs 生效", () => {
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, maxIdleMs: 1800000 }).reason, "too-old");
  eq(decideSessionEnd({ lastActivityAt: NOW - 3600000, now: NOW, maxIdleMs: 7200000 }).reason, "idle");
});

// ═══ 8. decideMissed（T6 漏网扫描）═══
const D = 86400000;
const H = 3600000;
const MISS_NOW = 100 * D;
const missSessions = [
  { sid: "A", cwd: "/w", lastActivityAt: MISS_NOW - 1 * H, hasCheckpoint: false },   // 候选 0.04 天
  { sid: "G", cwd: "/w", lastActivityAt: MISS_NOW - 2 * H },                         // 候选 0.08 天（无 hasCheckpoint 字段）
  { sid: "B", cwd: "/w", lastActivityAt: MISS_NOW - 2 * D, hasCheckpoint: false },   // 候选 2 天
  { sid: "C", cwd: "/w", lastActivityAt: MISS_NOW - 10 * D, hasCheckpoint: false },  // 超窗（默认 7 天）
  { sid: "D", cwd: "/w", lastActivityAt: MISS_NOW - 1 * H, hasCheckpoint: true },    // 已写
  { sid: "E", cwd: "/w", lastActivityAt: MISS_NOW - 1 * H, isSubagent: true },       // 子代理
  { sid: "", cwd: "/w", lastActivityAt: MISS_NOW - 1 * H },                          // 无 sid
  { sid: "F", cwd: "/w", lastActivityAt: 0 },                                        // 无活动
];
test("漏网：筛选 + 最后活动时间倒序 + 默认 3 条 + 输出仅 3 键", () => {
  const r = decideMissed({ sessions: missSessions, now: MISS_NOW });
  eq(r, [
    { sid: "A", ageDays: 0.04, reason: "no-checkpoint" },
    { sid: "G", ageDays: 0.08, reason: "no-checkpoint" },
    { sid: "B", ageDays: 2, reason: "no-checkpoint" },
  ]);
  eq(Object.keys(r[0]), ["sid", "ageDays", "reason"]);
});
test("漏网：maxCount=1 截断 / maxCount=0 本轮不补", () => {
  eq(decideMissed({ sessions: missSessions, now: MISS_NOW, maxCount: 1 }).map((x) => x.sid), ["A"]);
  eq(decideMissed({ sessions: missSessions, now: MISS_NOW, maxCount: 0 }), []);
});
test("漏网：maxAgeDays 窗口收紧(1天)与放宽(30天)", () => {
  eq(decideMissed({ sessions: missSessions, now: MISS_NOW, maxAgeDays: 1 }).map((x) => x.sid), ["A", "G"]);
  eq(decideMissed({ sessions: missSessions, now: MISS_NOW, maxAgeDays: 30, maxCount: 10 }).map((x) => x.sid), ["A", "G", "B", "C"]);
});
test("漏网：同活动时间按 sid 升序稳定", () => {
  const ss = [{ sid: "b", lastActivityAt: MISS_NOW - D }, { sid: "a", lastActivityAt: MISS_NOW - D }];
  eq(decideMissed({ sessions: ss, now: MISS_NOW }).map((x) => x.sid), ["a", "b"]);
});
test("漏网：空/非法输入安全降级", () => {
  eq(decideMissed({ sessions: [], now: MISS_NOW }), []);
  eq(decideMissed({ sessions: "nope", now: MISS_NOW }), []);
  eq(decideMissed({ sessions: missSessions, now: NaN }), []);
  eq(decideMissed(), []);
});

// ═══ 9. 纯度：模块零 I/O、零系统时钟、零第三方依赖 ═══
test("纯度：源码不含系统时钟/随机/环境/IO/第三方 import", () => {
  const src = readFileSync(fileURLToPath(new URL("../p3-triggers.js", import.meta.url)), "utf8");
  for (const bad of ["Date.now", "new Date(", "Math.random", "process.", "require(", "node:", "fs.readFile"]) {
    ok(src.indexOf(bad) === -1, `模块源码不应出现 ${bad}`);
  }
  ok(!/^\s*import\s/m.test(src), "模块不应有 import 语句");
  ok(!/^\s*export\s+(async\s+)?function\s+\w+\s*\([^)]*\)\s*\{[^}]*\bawait\b/m.test(src), "不应含 await");
});

// ═══ 汇总 ═══
for (const f of failures) console.log("FAIL - " + f);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
