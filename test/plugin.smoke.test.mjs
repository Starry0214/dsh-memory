// v2.3.0 集成冒烟测试：真的 import 插件、真的跑 apply()，验证「新装用户会被引导初始化」与「查到新版会提醒」。
// 跑法：node test/plugin.smoke.test.mjs
// 前置：插件目录要能解析 @deepseek-ai/dsh-settings 与 @deepseek-ai/schemastery。
//   本机一条命令建好依赖视图（PowerShell，管理员非必需，junction 不需要）：
//   New-Item -ItemType Junction -Path .\node_modules -Target <DSH 安装目录>\node_modules
// 例：node_modules\@deepseek-ai\dsh\node_modules。CI/无该目录时本测试自动跳过（不算失败）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..");
if (!fs.existsSync(path.join(pluginDir, "node_modules", "@deepseek-ai", "dsh-settings"))) {
  console.log("SKIP  解析不到 @deepseek-ai/dsh-settings——先给插件目录建 node_modules junction（见本文件头注释）");
  process.exit(0);
}

let passed = 0, failed = 0;
function report(name, err) {
  if (err) { failed++; console.log("  FAIL  " + name + "   " + (err.message || err)); }
  else { passed++; console.log("  PASS  " + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(60);   // 注入都推迟到 setTimeout(0)，等一拍就落地

// --- 假 DSH home：每个场景一套，绝不碰真人的 ~/.dsh ---
const base = path.join(os.tmpdir(), "dsh-memory-smoke-" + Date.now());
function mkHome(seedMemory) {
  const home = path.join(base, "home" + Math.random().toString(36).slice(2, 8));
  const mem = path.join(home, "memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
  if (seedMemory) {
    fs.writeFileSync(path.join(mem, "global.md"), "# 全局记忆\n" + "x".repeat(400));
    fs.writeFileSync(path.join(mem, "index.md"), "# 记忆索引\n- 主题 → 文件.md（描述）");
    for (const d of ["sessions", "projects", "tools", "knowledge"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# 协议");
  }
  return { home: home.replace(/\\/g, "/"), mem: mem.replace(/\\/g, "/") };
}

// --- 假 cordis ctx：记录注册与处理器，供测试主动触发 ---
function makeCtx() {
  const handlers = {};
  const tools = [];
  const commandList = [];
  const intervals = [];
  const injected = [];
  const ctx = {
  handlers, tools, commandList, injected, intervals,
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    get(name) {
      if (name === "tools") return { register: (t) => { tools.push(t); return () => {}; } };
      return undefined;
    },
    inject(deps, fn) {   // ctx.inject(["settings"], (sctx) => {...})：给一个啥也不干的 settings scope
      const sctx = { settings: { register: () => ({ get: () => ({}), watch: () => {}, update: () => Promise.resolve() }) } };
      try { fn(sctx); } catch (e) {}
      return () => {};
    },
    commands: { register: (c) => { commandList.push(c); return () => {}; } },
    commandList,
    interval: (fn, ms) => { intervals.push({ fn, ms }); return () => {}; },
    fs: {}, timer: {}, skills: {},
  };
  ctx.makeAgent = (id) => ({
    inject: (msg) => { injected.push({ id, msg }); },
    session: { id: "session-" + id, header: { cwd: "/work/proj1", origin: "main" } },
  });
  return ctx;
}

async function startPlugin(seedMemory) {
  const h = mkHome(seedMemory);
  process.env.DSH_HOME = h.home;
  process.env.DSH_MEMORY_ROOT = h.mem;
  process.env.DSH_MEMORY_RAW = "https://example.invalid/mirror";
  const mod = path.join(pluginDir, "index.js") + "?t=" + Date.now() + Math.random();
  const plug = (await import(pathToFileURL(path.join(pluginDir, "index.js")).href + "?t=" + Date.now() + Math.random())).default;
  const ctx = makeCtx();
  plug.apply(ctx, {});
  await sleep(120);
  return { ...h, plug, ctx };
}

function tool(ctx, name) { return ctx.tools.find((t) => t.name === name); }
function cmd(ctx, name) { return ctx.commandList.find((c) => c.name === name); }
function lastInjectedText(ctx) {
  const last = ctx.injected[ctx.injected.length - 1];
  return last && last.msg && String(last.msg.content || (Array.isArray(last.msg) ? "" : last.msg.text) || JSON.stringify(last.msg));
}

const run = async () => {
  console.log("装配：插件能被真 import，工具/命令都挂上");
  const s = await startPlugin(false);
  report("import + apply 不抛异常", null);
  for (const tn of ["memory_search", "stale_archive", "dsh_spiral_thresh", "memory_onboard"]) {
    ts2("工具已注册：" + tn, !!tool(s.ctx, tn));
  }
  for (const cn of ["dream", "memory-init", "memory-update"]) {
    ts2("命令已注册：/" + cn, !!cmd(s.ctx, cn));
  }
  function ts2(name, ok) { report(name, ok ? null : new Error("未注册")); }

  console.log("");
  console.log("场景一：新装用户（空记忆库）");
  const agent = s.ctx.makeAgent("newbie");
  await s.ctx.handlers["agent/session-start"][0]({ agent });
  await sleep(150);
  const guide = s.ctx.injected.map((i) => JSON.stringify(i.msg)).find((t) => t.includes("首次初始化引导"));
  report("首个会话收到初始化引导", guide ? null : new Error("没注入引导：" + s.ctx.injected.length + " 条消息"));
  report("引导里带 ask_user_question 与落盘路径", guide && guide.includes("ask_user_question") && guide.includes(s.mem.replace(/\\/g, "\\\\")) ? null : new Error("引导内容不完整"));
  report("骨架目录已由插件补齐", ["sessions", "projects", "tools", "knowledge"].every((d) => fs.existsSync(path.join(s.mem, d))) ? null : new Error("目录没建"));
  report("引导节流状态已落盘 .onboard.json", fs.existsSync(path.join(s.mem, ".onboard.json")) ? null : new Error("没写状态文件"));
  const before = s.ctx.injected.length;
  await s.ctx.handlers["agent/session-start"][0]({ agent: s.ctx.makeAgent("second") });
  await sleep(150);
  report("同一天第二个会话不再重复引导", s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("首次初始化引导")).length === 1 ? null : new Error("重复提醒了"));

  console.log("");
  console.log("场景一续：模型可用 memory_onboard 工具接管");
  const t = tool(s.ctx, "memory_onboard");
  const stTxt = await t.execute({ action: "status" });
  report("status 回显含状态与版本", /uninitialized/.test(stTxt) && /v\d+\.\d+/.test(stTxt) ? null : new Error(stTxt));
  const snTxt = await t.execute({ action: "snooze", hours: 3 });
  report("snooze 3 小时生效并回显", /暂停初始化提醒 3 小时/.test(snTxt) ? null : new Error(snTxt));
  const st2 = JSON.parse(fs.readFileSync(path.join(s.mem, ".onboard.json"), "utf8"));
  report("snooze 已落盘（约 3 小时后到期）", st2.snoozeUntil - Date.now() > 2.5 * 3600000 && st2.snoozeUntil - Date.now() <= 3 * 3600000 ? null : new Error(JSON.stringify(st2)));
  const n0 = s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("首次初始化引导")).length;
  await s.ctx.handlers["agent/session-start"][0]({ agent: s.ctx.makeAgent("third") });
  await sleep(150);
  report("暂缓期内新会话不再被打扰", s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("首次初始化引导")).length === n0 ? null : new Error("snooze 没生效"));
  const initTxt = await t.execute({ action: "init" });
  await sleep(150);
  report("action=init 立刻绕过暂缓再引导一次", /已重新发出初始化引导/.test(initTxt) && s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("首次初始化引导")).length === n0 + 1 ? null : new Error(initTxt));

  console.log("");
  console.log("场景二：记忆库已就绪的老用户");
  const r2 = await startPlugin(true);
  const memTxt = await tool(r2.ctx, "memory_onboard").execute({ action: "status" });
  report("status 报 ready", /记忆库：ready/.test(memTxt) ? null : new Error(memTxt));
  await r2.ctx.handlers["agent/session-start"][0]({ agent: r2.ctx.makeAgent("old") });
  await sleep(150);
  report("就绪用户不会被初始化引导打扰", !r2.ctx.injected.some((i) => JSON.stringify(i.msg).includes("首次初始化引导")) ? null : new Error("误报了"));

  console.log("");
  console.log("场景三：升级检查（假远端版本）");
  const realFetch = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "9.9.9\n" }; };
  const up = await cmd(s.ctx, "memory-update").handler({ agent: s.ctx.makeAgent("upd") });
  await sleep(150);
  report("/memory-update 发现新版并回命令", up.kind === "success" && /9\.9\.9/.test(up.text) && /install\.ps1/.test(up.text) ? null : new Error(JSON.stringify(up)));
  report("升级检查打到了 version.txt", calls.some((u) => /version\.txt$/.test(u)) ? null : new Error(calls.join(",")));
  report("镜像地址走 DSH_MEMORY_RAW（内网可换源）", calls.every((u) => u.startsWith("https://example.invalid/mirror")) ? null : new Error(calls.join(",")));
  report("同时向会话注入一次升级提醒", s.ctx.injected.some((i) => JSON.stringify(i.msg).includes("升级提醒")) ? null : new Error("没注入升级提醒"));
  const nUp = s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("升级提醒")).length;
  await s.ctx.handlers["agent/session-start"][0]({ agent: s.ctx.makeAgent("upd2") });
  await sleep(150);
  report("同一天不重复提升级（一天一次）", s.ctx.injected.filter((i) => JSON.stringify(i.msg).includes("升级提醒")).length === nUp ? null : new Error("重复提醒"));
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "0.0.1" });
  const up2 = await cmd(s.ctx, "memory-update").handler({});
  report("远端更旧 → 报已最新", /已是最新/.test(up2.text) ? null : new Error(JSON.stringify(up2)));
  globalThis.fetch = async () => { throw new Error("ENOTFOUND"); };
  const up3 = await cmd(s.ctx, "memory-update").handler({});
  report("离线/断网：只报告不炸", up3.kind === "error" && /未完成|没查到/.test(up3.text) ? null : new Error(JSON.stringify(up3)));
  globalThis.fetch = realFetch;

  console.log("");
  console.log("场景四：升级检查可关闭");
  const s4 = await startPlugin(true);
  calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, text: async () => "9.9.9" }; };
  const obFile = path.join(s4.mem, ".onboard.json");
  const stObj = fs.existsSync(obFile)
    ? JSON.parse(fs.readFileSync(obFile, "utf8"))
    : { initPromptedAt: 0, snoozeUntil: 0, ready: true, update: { checkedAt: 0, latest: "", notifiedAt: 0, error: "" } };
  stObj.update.checkedAt = Date.now();   // 伪装"今天已经查过了"
  fs.writeFileSync(obFile, JSON.stringify(stObj));
  calls = [];
  await s4.ctx.handlers["agent/session-start"][0]({ agent: s4.ctx.makeAgent("t4") });   // 会话开始会带一次每日检查
  await sleep(150);
  report("当天已查过 → 会话开始不再发版本请求（省流量）", calls.length === 0 ? null : new Error("又发了 " + calls.length + " 次请求"));
  calls = [];
  await cmd(s4.ctx, "memory-update").handler({});
  report("手动 /memory-update 忽略每日节流、立刻真查", calls.length > 0 ? null : new Error("没发请求"));
  calls = [];
  s4.ctx.intervals.forEach((i) => { try { i.fn(); } catch (e) {} });
  await sleep(120);
  report("每小时 tick 也受每日节流约束", calls.length === 0 ? null : new Error("定时器发请求了"));
  globalThis.fetch = realFetch;

  fs.rmSync(base, { recursive: true, force: true });
  console.log("");
  console.log(failed ? "集成冒烟测试：" + failed + " 项失败 / " + passed + " 项通过" : "集成冒烟测试全部通过（" + passed + " 项）");
  process.exitCode = failed ? 1 : 0;
};
run().catch((e) => { console.log("测试自身异常：" + (e && e.stack || e)); process.exit(1); });
