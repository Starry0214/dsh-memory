// _accept-p0-lib.mjs — P0 独立验收公共夹具（mem-p0-accept / task-4）
//
// 纪律（红线）：
//   ① 全部场景在 os.tmpdir() 下造独立 DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB —— 绝不读写真实 ~/.dsh/memory；
//   ② 不写运行副本 C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js；
//   ③ 被验 index.js 只读：默认 ../index.js，可用 `node xxx.mjs <index.js 路径>` 覆盖（用于对「改前副本」跑基线）；
//   ④ 不重启 DSH、不写宿主设置。
//
// 用法约定（各脚本同）：
//   node test/_accept-p0-g2.mjs [index.js 路径]
//   exit 0 = 全部 PASS（或 SKIP 不计失败）；exit 1 = 有 FAIL；exit 2 = 夹具/前置失败。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DEFAULT = path.resolve(path.join(HERE, "..", "index.js"));
export const TARGET = path.resolve(process.argv[2] || PLUGIN_DEFAULT);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

/** 本地日期 YYYY-MM-DD（与插件 dateStr 同口径：本地时区） */
export function dateStr(d) {
  const x = d || new Date();
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}
export const todayStr = () => dateStr(new Date());
export function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - Number(n || 0));
  return dateStr(d);
}

let _seq = 0;
/** 全新模块实例（cache-buster）；必须在 useHome() 之后调用 —— 插件在模块顶层捕获 MEMORY_ROOT 等 env。 */
export async function freshPlugin() {
  const url = pathToFileURL(TARGET).href + "?accept=" + Date.now().toString(36) + "-" + (++_seq);
  return await import(url);
}

const HOMES = [];
/** 造一套假 DSH home（模板骨架 + 最小稳定层），返回 {base, home, mem} */
export function mkHome(tag) {
  const base = path.join(os.tmpdir(), "dsh-accept-p0-" + String(tag || "x") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6));
  const home = path.join(base, "dsh-home");
  const mem = path.join(home, "memory");
  fs.mkdirSync(path.join(mem, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(mem, "projects"), { recursive: true });
  fs.mkdirSync(path.join(mem, "tools"), { recursive: true });
  fs.mkdirSync(path.join(mem, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(home, "AGENTS.md"), "# 协议\n(验收夹具占位，不是真实全局协议)\n", "utf8");
  fs.writeFileSync(path.join(mem, "global.md"), "# 全局记忆\n- 验收夹具占位（不读真实库）\n", "utf8");
  fs.writeFileSync(path.join(mem, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
  fs.writeFileSync(path.join(mem, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
  const h = { base: base, home: home.replace(/\\/g, "/"), mem: mem.replace(/\\/g, "/") };
  HOMES.push(h);
  return h;
}

/** 把 process env 指向该假 home（每个场景一份，避免串味） */
export function useHome(h) {
  process.env.DSH_HOME = h.home;
  process.env.DSH_MEMORY_ROOT = h.mem;
  process.env.MEMTOPIC_DB = h.mem + "/.memtopic/mem.db";
  // memtopic 是插件目录下的源码模块（不是 npm 包）：被验 index.js 若在别的目录（如「改前副本」），
  // 模块解析会找不到 ⇒ 显式把 MEMTOPIC_DIR 指向被验目标同级的 memtopic（只读引用，DB 仍写临时 home）。
  const cand = path.join(path.dirname(TARGET), "memtopic");
  const fallback = path.join(path.dirname(PLUGIN_DEFAULT), "memtopic");
  if (fs.existsSync(cand)) process.env.MEMTOPIC_DIR = cand;
  else if (fs.existsSync(fallback)) process.env.MEMTOPIC_DIR = fallback;   // 「改前副本」场景：只读借用同仓 memtopic
  else delete process.env.MEMTOPIC_DIR;
  process.env.DSH_MEMORY_RAW = "https://example.invalid/accept-mirror";
  return h;
}

export function cleanupHomes() {
  for (const h of HOMES) { try { fs.rmSync(h.base, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ } }
  HOMES.length = 0;
}

/**
 * 假 cordis ctx。能力只给插件实际用到的面；subagents 可注入或置 null（模拟「不可用」）。
 * opts.subagents: undefined = 默认可用的假子代理；null = 明确不可用；对象 = 自定义。
 */
export function makeCtx(opts) {
  const o = opts || {};
  const handlers = {};
  const injected = [];          // agent.inject(makeMessage(...)) 的原始消息对象
  const captured = { tools: [], commands: [], intervals: [], errors: [], injectedDeps: [] };
  const defaultSubagents = {
    start: async () => ({ id: "fix-run-1", result: Promise.resolve({ output: [], stopReason: "completed" }) }),
  };
  const state = { subagents: Object.prototype.hasOwnProperty.call(o, "subagents") ? o.subagents : defaultSubagents };
  const ctx = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    get(name) {
      if (name === "tools") return { register(def) { captured.tools.push(def); return () => {}; } };
      if (name === "subagents") return state.subagents;
      return undefined;
    },
    inject(names, cb) { captured.injectedDeps.push(Array.isArray(names) ? names.join(",") : String(names)); return () => {}; },
    interval(fn, ms) { captured.intervals.push({ fn: fn, ms: ms }); return () => {}; },
    effect(fn) { try { const d = fn(); return typeof d === "function" ? d : () => {}; } catch (e) { return () => {}; } },
    error(msg) { captured.errors.push(String(msg)); },
    commands: { register(def) { captured.commands.push(def); return () => {}; }, execute: async () => "" },
    fs: {},
    timer: {},
    skills: { get: () => undefined, list: async () => [] },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, handlers, injected, captured, state };
}

/** 假顶层会话 agent：pickSpawnParent 的 live 判据需要 options + session */
export function mkAgent(id, opts) {
  const o = opts || {};
  const cwd = o.cwd || "C:\\acc\\ws";
  const agent = {
    options: {},
    session: { id: id, header: { cwd: cwd, origin: o.origin || "user" }, cwd: cwd },
    inject: (m) => { agent.__injected.push(m); },
    __injected: [],
  };
  return { agent: agent, injected: agent.__injected };
}

export function msgText(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m.content)) return m.content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m)) return m.map(msgText).join("\n");
  if (typeof m.text === "string") return m.text;
  return JSON.stringify(m);
}

/** 静音插件 stdout/stderr，同时收集告警（便于断言「不静默失败」） */
export function capConsole() {
  const ow = console.warn, oe = console.error, ol = console.log;
  const warns = [];
  console.log = () => {};
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
  console.error = (...a) => { warns.push(a.map(String).join(" ")); };
  return { warns, restore() { console.warn = ow; console.error = oe; console.log = ol; } };
}

/** 真 apply（cfg 是 loader config 层，例如 {memoryTopicDbEnabled:true}） */
export function applyPlugin(mod, cfg, ctx) {
  const cap = capConsole();
  try { mod.default.apply(ctx, cfg || {}); }
  finally { cap.restore(); }
  return mod;
}

/** 触发 agent/created（handler 是同步返回的 fire-and-forget 异步链 ⇒ 必须等在捕获窗口内跑完） */
export async function callCreated(handlers, agent, waitMs) {
  const cap = capConsole();
  try {
    for (const h of handlers["agent/created"] || []) await h({ agent: agent });
    await sleep(waitMs == null ? 800 : waitMs);
  } finally { cap.restore(); }
}

/** 触发 agent/pre-step（waterfall：next() 返回进入决策） */
export async function callPreStep(handlers, agent, userText) {
  const messages = [{ role: "user", content: userText || "继续" }];
  let decision = { kind: "enter", messages: [] };
  const cap = capConsole();
  try {
    for (const h of handlers["agent/pre-step"] || []) {
      const r = await h({ agent: agent, messages: messages, step: 1, signal: null }, async () => decision);
      if (r) decision = r;
    }
  } finally { cap.restore(); }
  return decision;
}

/** 触发 session/event(type=compaction/summary)：与宿主同构 —— session 对象 + event.data.summary blocks */
export async function fireCompaction(handlers, session, compactionId, summaryText, waitMs) {
  const ev = { type: "compaction/summary", data: { compactionId: compactionId, summary: [{ type: "text", text: String(summaryText || "") }] } };
  const cap = capConsole();
  try {
    for (const h of handlers["session/event"] || []) await h(session, ev);
    await sleep(waitMs == null ? 500 : waitMs);
  } finally { cap.restore(); }
}

export async function waitFor(pred, timeoutMs, stepMs) {
  const t0 = Date.now();
  const step = stepMs || 50;
  while (Date.now() - t0 < (timeoutMs || 3000)) {
    let v = false;
    try { v = await pred(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(step);
  }
  return false;
}

/** 等主题库惰性加载就绪（flag 开时 apply 后异步 ensure） */
export async function waitTopicDb(mod, timeoutMs) {
  const ok = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, timeoutMs || 20000, 100);
  return ok;
}

/** 造 D8 容器：域「日记忆（按天流水）」+ 线「会话检查点」（与线上 topicDbIntentRoute 写入路径同构） */
export function seedD8(mod) {
  const st = mod.__topicdb && mod.__topicdb.store;
  if (!st) return null;
  const store = st;
  const dom = store.createDomain("日记忆（按天流水）", { actor: "lead" });
  const line = store.seedTopic({ name: "会话检查点", triggers: ["会话检查点"], src: "sessions/CHECKPOINT.md" });
  store.setLevel(line.id, "project", { actor: "lead" });
  store.linkParent(line.id, dom.id, { actor: "lead" });
  return { store: store, dom: dom, line: line };
}

/** 读临时 home 里的 .integrate.json（不存在返回 null） */
export function readIntegrate(h) {
  try { return JSON.parse(fs.readFileSync(h.mem + "/.integrate.json", "utf8")); } catch (e) { return null; }
}
/** 读临时 home 里的 .monitor.json（不存在返回 null） */
export function readMonitor(h) {
  try { return JSON.parse(fs.readFileSync(h.mem + "/.monitor.json", "utf8")); } catch (e) { return null; }
}
export function sessionMdPath(h, day) { return h.mem + "/sessions/" + (day || todayStr()) + ".md"; }
export function readSessionMd(h, day) {
  try { return fs.readFileSync(sessionMdPath(h, day), "utf8"); } catch (e) { return null; }
}

/** 递归扫对象里是否出现某字符串（用于「字段名未知但值已知」的持久化断言） */
export function jsonContains(obj, needle) {
  try { return JSON.stringify(obj).indexOf(String(needle)) !== -1; } catch (e) { return false; }
}

/**
 * 摘要/检查点注入消息筛选：插件文案以【最近一次会话压缩点】为锚点（老行为）。
 * 注意不能宽匹配「会话检查点」——主题注册表维护提醒里也会出现该词（改前验收曾因此假 PASS）。
 */
export function summaryInjections(texts) {
  return (texts || []).filter((t) => /【[^】]*(压缩点|检查点)[^】]*】/.test(t));
}

/**
 * 结果记录器：PASS/FAIL/SKIP 三态；SKIP 不计失败（报告里必须列明原因）。
 * 输出末行 ACCEPT_RESULT <json> 供 Lead/脚本机器解析。
 */
export function makeReporter(title) {
  const checks = [];
  const c = { pass: 0, fail: 0, skip: 0 };
  function emit(status, name, detail) {
    const line = status + "  " + name + (detail ? "  —  " + String(detail) : "");
    try { console.log(line); } catch (e) {}
  }
  return {
    title: title,
    checks: checks,
    ok(cond, name, detail) {
      const status = cond ? "PASS" : "FAIL";
      checks.push({ name: name, status: status, detail: detail == null ? "" : String(detail) });
      if (cond) c.pass++; else c.fail++;
      emit(status, name, detail == null ? "" : detail);
      return !!cond;
    },
    skip(name, why) {
      checks.push({ name: name, status: "SKIP", detail: why == null ? "" : String(why) });
      c.skip++;
      emit("SKIP", name, why == null ? "" : why);
    },
    warn(name, detail) {
      checks.push({ name: name, status: "WARN", detail: detail == null ? "" : String(detail) });
      emit("WARN", name, detail == null ? "" : detail);
    },
    counts() { return { pass: c.pass, fail: c.fail, skip: c.skip }; },
    done() {
      const r = { title: title, target: TARGET, pass: c.pass, fail: c.fail, skip: c.skip, checks: checks };
      try {
        console.log("\n" + title + "：PASS " + c.pass + " / FAIL " + c.fail + " / SKIP " + c.skip);
        console.log("ACCEPT_RESULT " + JSON.stringify(r));
      } catch (e) {}
      return r;
    },
  };
}

/** 脚本收尾：清理临时 home、给插件定时器一点余量后按失败数退出 */
export function finish(reporter, exitCodeOnFail) {
  const r = reporter.done();
  try { cleanupHomes(); } catch (e) {}
  setTimeout(() => process.exit(r.fail > 0 ? (exitCodeOnFail == null ? 1 : exitCodeOnFail) : 0), 150);
  return r;
}

/** 判断 text 里是否出现 literal 的「非完整前缀/中段」（= 字面量被截断的直接证据） */
export function hasPartialLiteral(text, literal) {
  const t = String(text || "");
  const lit = String(literal || "");
  if (!lit) return false;
  if (t.includes(lit)) return false;   // 完整出现 ⇒ 没被截断
  const maxLen = Math.min(lit.length - 1, 40);
  for (let len = maxLen; len >= 8; len--) {
    for (let i = 0; i + len <= lit.length; i++) {
      if (t.includes(lit.slice(i, i + len))) return true;
    }
  }
  return false;
}
