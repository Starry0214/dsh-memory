// _memory-toast-selftest.mjs —— 记忆操作 Toast（host 环形缓冲 + client 队列/防抖/Toast 接线）自测
//
// 跑法：node test/_memory-toast-selftest.mjs
//
// 覆盖（Lead 指定 6 项）：
//   ① 环形缓冲上限 50（超限丢最旧、seq 单调）
//   ② 端点 since 过滤（只返回 ts > since；无 since 返回最近 ≤50）
//   ③ 合并键（工具名+成败）/ 合并窗口 2s（同类累加 ×N；超窗新开一条）
//   ④ 队列上限 3（成功条目超限丢最旧）
//   ⑤ 失败永不合并、永不丢弃
//   ⑥ 静态接线（Toast / holdMs 2000 / shell.overlay / 2s 轮询 / 隐藏页暂停 / 端点接线）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const HOST_SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
const CLIENT_SRC = fs.readFileSync(path.join(PLUGIN, "client", "lib", "client.js"), "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}

// ── 加载 client 模块（stub window.__ModuleLoader__ + 依赖）────────────────
function loadClient() {
  let captured = null;
  const fakeReact = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  };
  const fakeStore = { defineStore: () => ({}) };
  const fakePrimitives = { Toast: function Toast() { return null; } };
  const req = (id) => {
    if (id === "react") return fakeReact;
    if (id === "@deepseek-ai/dsh-client-store") return fakeStore;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return fakePrimitives;
    throw new Error("unexpected require: " + id);
  };
  const win = { __ModuleLoader__: { load: (def) => { captured = def; } } };
  const g = globalThis;
  const prevWin = g.window;
  g.window = win;
  try {
    const code = CLIENT_SRC;
    const fn = new Function("window", "globalThis", code + "\n;return window.__ModuleLoader__;");
    fn(win, g);
  } finally { g.window = prevWin; }
  if (!captured || typeof captured.factory !== "function") throw new Error("client factory not captured");
  return captured.factory(req);
}

// ── ① host 环形缓冲上限 50 ────────────────────────────────────────────
try {
  const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
  const rec = mod.__recordMemoryOp, ring = mod.__memoryOpsRing, max = mod.__memoryOpsMax, payload = mod.__memoryOpsPayload;
  ok(typeof rec === "function" && Array.isArray(ring) && max === 50, "A1 host 环形缓冲导出（上限 50）", "max=" + max);
  ring.length = 0;
  const realNow0 = Date.now;
  let fake0 = realNow0();
  Date.now = () => (fake0 += 1000);
  try {
    for (let i = 0; i < 60; i++) {
      rec("memory_search", { arguments: { query: "q" + i } }, { isError: false, content: [{ type: "text", text: "命中 " + i + " 个文件" }] });
    }
  } finally { Date.now = realNow0; }
  ok(ring.length === max, "A2 60 次记录后环形缓冲恒为 50（超限丢最旧）", "len=" + ring.length);
  ok(ring[0].seq === 11 && ring[ring.length - 1].seq === 60, "A3 seq 单调且最旧被淘汰（首 seq=11，尾 seq=60）", ring[0].seq + ".." + ring[ring.length - 1].seq);
  ok(ring.every((x) => typeof x.ts === "number" && x.tool && typeof x.ok === "boolean" && typeof x.summary === "string"), "A4 条目形状 {ts,tool,ok,summary}", JSON.stringify(ring[0]));
  // 非记忆工具不入缓冲
  const n0 = ring.length;
  rec("read", { arguments: { file: "a" } }, { isError: false, content: [{ type: "text", text: "x" }] });
  ok(ring.length === n0, "A5 非记忆类工具不记录（白名单 6 个）", "len=" + ring.length);
  // ② since 过滤
  const mid = ring[Math.floor(ring.length / 2)].ts;
  const p1 = payload("/dsh-memory/ops.json?since=" + mid);
  ok(p1.ok === true && p1.total === 50 && p1.ops.length > 0 && p1.ops.every((x) => x.ts > mid), "B1 since 过滤：只返回 ts > since", "ops=" + p1.ops.length + "/" + p1.total);
  const p2 = payload("/dsh-memory/ops.json");
  ok(p2.ops.length === 50 && p2.since === 0, "B2 无 since ⇒ 返回最近 50 条", "ops=" + p2.ops.length);
  const p3 = payload("/dsh-memory/ops.json?since=" + (Date.now() + 60000));
  ok(p3.ops.length === 0, "B3 since 在未来 ⇒ 空列表（不报错）", "ops=" + p3.ops.length);
} catch (e) { ok(false, "A/B host 场景异常", (e && e.message) || String(e)); }

// ── ③④⑤ client 队列 / 合并 / 失败规则 ────────────────────────────────
try {
  const cli = loadClient();
  const T = cli.__opsTest;
  ok(!!T && typeof T.enqueue === "function" && Array.isArray(T.queue), "C1 client __opsTest 钩子可用", "");
  ok(T.holdMs === 2000 && T.pollMs === 2000 && T.mergeMs === 2000 && T.queueMax === 3, "C2 常量：holdMs/poll/merge=2000、queueMax=3", JSON.stringify({ holdMs: T.holdMs, pollMs: T.pollMs, mergeMs: T.mergeMs, queueMax: T.queueMax }));
  // 固定时间轴
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  try {
    T.reset();
    // ③ 合并：2s 内同类 5 次 ⇒ 一条 ×5
    for (let i = 0; i < 5; i++) { fake += 100; T.enqueue({ tool: "memory_search", ok: true, summary: "命中 3 处", ts: fake }); }
    const act = T.active();
    ok(!!act && act.count === 5 && /×5$/.test(T.itemText(act)) && /已查询记忆/.test(T.itemText(act)), "C3 2s 窗口同类合并 ×5（合并键=工具名+成败）", act ? T.itemText(act) : "null");
    // 超窗 ⇒ 新开一条（先推进时间，并把当前 active 完成）
    fake += 2100;
    T.done();
    T.enqueue({ tool: "memory_search", ok: true, summary: "命中 1 处", ts: fake });
    const act2 = T.active();
    ok(!!act2 && act2.count === 1 && !/×/.test(T.itemText(act2)), "C4 超过 2s 窗口不合并（新开一条 ×1）", act2 ? T.itemText(act2) : "null");
    // 不同工具不合并
    T.done();
    T.reset();
    fake += 10;
    T.enqueue({ tool: "memory_read", ok: true, summary: "T-0493", ts: fake });
    T.enqueue({ tool: "memory_search", ok: true, summary: "命中 2 处", ts: fake });
    ok(T.queue.length === 1 || (T.active() && T.active().tool === "memory_read"), "C5 合并键含工具名：不同工具不合并", JSON.stringify(T.queue.map((x) => x.tool)));
    // ④ 队列上限 3：连续 6 个不同成功操作 ⇒ 成功待显示 ≤3
    T.reset();
    fake += 1000;
    const tools = ["memory_search", "memory_read", "memory_note", "memory_topics", "session_search", "memory_onboard"];
    for (const t of tools) { fake += 10; T.enqueue({ tool: t, ok: true, summary: "", ts: fake }); }
    const okN = T.queue.filter((x) => x.ok).length;
    ok(okN <= 3, "C6 队列上限 3（成功条目超限丢最旧）", "pendingOk=" + okN);
    // ⑤ 失败：不合并、不丢弃、不参与上限淘汰
    T.reset();
    fake += 10;
    T.enqueue({ tool: "memory_search", ok: true, summary: "命中 1 处", ts: fake });
    fake += 10;
    T.enqueue({ tool: "memory_search", ok: false, summary: "缓存未建", ts: fake });
    const q1 = (T.active() ? [T.active()] : []).concat(T.queue.slice());
    ok(q1.some((x) => x.ok === false) && q1.some((x) => x.ok === true), "C7 失败单独成条（不与同工具成功合并）", JSON.stringify(q1.map((x) => x.ok)));
    const failItem = q1.find((x) => x.ok === false);
    ok(failItem && /^❌ /.test(failItem.base) && /查询记忆失败/.test(failItem.base) && /缓存未建/.test(failItem.base), "C8 失败文案 ❌ <动作>失败 · <原因>", failItem ? failItem.base : "null");
    // 连续失败超上限也不丢
    T.reset();
    for (let i = 0; i < 6; i++) { fake += 10; T.enqueue({ tool: "memory_note", ok: false, summary: "原因" + i, ts: fake }); }
    const failN = T.queue.filter((x) => !x.ok).length + (T.active() && !T.active().ok ? 1 : 0);
    ok(failN === 6, "C9 失败永不丢弃（6 条失败全在，超出队列上限仍保留）", "failN=" + failN);
    // 合并时 active 也在计数（视觉上 ×N 递增）
    T.reset();
    fake += 10;
    T.enqueue({ tool: "memory_note", ok: true, summary: "12 字", ts: fake });
    fake += 100;
    T.enqueue({ tool: "memory_note", ok: true, summary: "12 字", ts: fake });
    ok(T.active() && T.active().count === 2 && /×2$/.test(T.itemText(T.active())), "C10 正在显示的条目也能被 2s 内同类累加（×2）", T.active() ? T.itemText(T.active()) : "null");
  } finally { Date.now = realNow; }
} catch (e) { ok(false, "C client 场景异常", (e && e.message) || String(e)); }

// ── ⑥ 静态接线 ───────────────────────────────────────────────────────
try {
  const has = (src, s) => src.includes(s);
  ok(has(CLIENT_SRC, 'require("@deepseek-ai/dsh-client-ui-primitives")'), "D1 client require Toast 原语（已声明依赖）");
  ok(has(CLIENT_SRC, "holdMs: OPS_HOLD_MS") && has(CLIENT_SRC, "const OPS_HOLD_MS = 2000"), "D2 Toast holdMs=2000（+默认 1000 淡出 = 3s）");
  ok(has(CLIENT_SRC, 'name: "shell.overlay"') && has(CLIENT_SRC, 'ctx.slots.inject("shell.overlay"'), "D3 挂 shell.overlay（kind:list，可多条目）");
  ok(has(CLIENT_SRC, "const OPS_POLL_MS = 2000") && has(CLIENT_SRC, "/dsh-memory/ops.json?since="), "D4 轮询 ops.json 间隔 2s");
  ok(has(CLIENT_SRC, 'document.visibilityState === "hidden"') && has(CLIENT_SRC, "stopOpsPolling()"), "D5 隐藏页暂停 + 卸载清 timer");
  ok(has(HOST_SRC, "/dsh-memory/ops.json") && has(HOST_SRC, "memoryOpsPayload"), "D6 host 端点 /dsh-memory/ops.json 已注册");
  ok(has(HOST_SRC, "const MEMORY_OPS_MAX = 50") && has(HOST_SRC, "while (MEMORY_OPS.length > MEMORY_OPS_MAX) MEMORY_OPS.shift()"), "D7 host 环形缓冲上限 50");
  ok(has(HOST_SRC, "recordMemoryOp(toolName, exec, result)") && /tools\/result/.test(HOST_SRC), "D8 tools/result 钩子记录工具名+成败+摘要");
  const whitelist = ["memory_search", "memory_read", "memory_note", "memory_topics", "session_search", "memory_onboard"];
  ok(whitelist.every((t) => has(HOST_SRC, '"' + t + '"')), "D9 白名单 6 个记忆类工具");
} catch (e) { ok(false, "D 静态接线异常", (e && e.message) || String(e)); }

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
