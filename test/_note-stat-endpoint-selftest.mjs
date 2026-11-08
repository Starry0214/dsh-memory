// _note-stat-endpoint-selftest.mjs —— 设置页「会话笔记未提炼」端点 + client 静态接线自测
//
// 跑法：node test/_note-stat-endpoint-selftest.mjs
//
// 覆盖：
//   A host 端点 GET /dsh-memory/note-stat.json：注册路径 / 结构 / cache-control / 口径 A / 未就绪 disabled
//   B client.js：NoteStatRow 存在、fetch 一次 + 3s AbortController 超时 + no-store、失败/未就绪/flag 关/零值静默隐藏、
//     插在「记忆使用统计」之后、过期 400 注释已更新、语法可解析
//   C 真库副本耗时（仅打印，不硬断言 25ms；CRA 实测 ~25ms）
//
// 隔离：临时 DSH_HOME/临时库（os.tmpdir）；真库只复制到临时目录读，不写真实库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const CLIENT = path.join(PLUGIN, "client", "lib", "client.js");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
const CJS = fs.readFileSync(CLIENT, "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(step || 100); }
  return false;
}

// ── A. host 端点（真实 apply + 捕获 webServer 路由）──────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-note-stat-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const { createFixtureCtx } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
const fx = createFixtureCtx({});
const routes = [];
// fixture 的 inject 只记录不回调；这里给 webServer 回调补一个假服务，捕获插件注册的路由
fx.ctx.inject = (names, cb) => {
  try {
    if (Array.isArray(names) && names.indexOf("webServer") >= 0 && typeof cb === "function") {
      const wctx = Object.assign({}, fx.ctx, { webServer: { port: 12345, register(def) { routes.push(def); return () => { /* dispose */ }; } } });
      cb(wctx);
    }
  } catch (e) { /* 注入失败按无服务处理 */ }
  return () => { /* disposer */ };
};
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const route = routes.find((r) => r && r.path === "/dsh-memory/note-stat.json");
ok(!!route, "A1 host 已注册 exact 路由 /dsh-memory/note-stat.json", routes.map((r) => r.path).join(","));
function fakeRes() {
  return {
    headers: {}, statusCode: 200, body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    end(s) { this.body = String(s == null ? "" : s); },
  };
}
async function callRoute() {
  const res = fakeRes();
  const t0 = process.hrtime.bigint();
  await route.handler({ method: "GET", url: "/dsh-memory/note-stat.json" }, res);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { json = null; }
  return { res, json, ms };
}
// A2 未就绪（apply 后立即调，topicdb 异步初始化中）⇒ disabled:true 零值
if (route) {
  const early = await callRoute();
  ok(early.json && early.json.ok === true && (early.json.disabled === true || early.json.ready === false),
    "A2 库未就绪 ⇒ ok:true + disabled:true/ready:false + 零值", JSON.stringify(early.json));
}

const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "A3 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
if (ready && route) {
  const store = mod.__topicdb.store;
  const mk = (name, texts) => {
    const r = store.seedTopic({ name: name, triggers: [], actor: "plugin" });
    const id = r && (r.id || (r.topic && r.topic.id));
    try { store.setState(id, "active", { actor: "runtime" }); } catch (e) { /* 忽略 */ }
    for (const t of texts) store.appendSentence({ topic: id, text: t, actor: "runtime" });
    return id;
  };
  mk("笔记·STAT-WS/aaaaaaaa", ["未提炼1", "未提炼2"]);                       // 2 句
  mk("笔记·STAT-WS/bbbbbbbb", ["未提炼3"]);                                   // 1 句
  mk("笔记·STAT-WS/cccccccc", ["2026-11-06 已提炼 9 句 → T-0001（原文 session_search sid8=cccccccc 可回溯）"]); // 0 句（已收敛）
  const got = await callRoute();
  ok(got.res.headers["content-type"] && /application\/json/.test(got.res.headers["content-type"]), "A4 content-type JSON", got.res.headers["content-type"]);
  ok(got.res.headers["cache-control"] === "no-store", "A5 cache-control: no-store", got.res.headers["cache-control"]);
  ok(got.json && got.json.ok === true && got.json.disabled === false && got.json.ready === true, "A6 就绪时 ok:true/disabled:false/ready:true", JSON.stringify(got.json));
  ok(got.json && got.json.topics === 2 && got.json.sentences === 3, "A7 口径 A 正确（2 主题 / 3 句；已收敛主题不计）", JSON.stringify({ topics: got.json && got.json.topics, sentences: got.json && got.json.sentences }));
  ok(typeof got.ms === "number" && got.ms < 1000, "A8 端点耗时 < 1000ms", got.ms.toFixed(1) + "ms");
  // A9 异常不抛：store.readTopic 抛错 ⇒ ok:false / 或仍返回结构（不抛到 Host）
  const origList = store.be.listTopics;
  try {
    store.be.listTopics = () => { throw new Error("boom"); };
    const bad = await callRoute();
    ok(bad.json && bad.json.ok === false, "A9 内部异常 ⇒ ok:false（不抛到 Host）", JSON.stringify(bad.json));
  } catch (e) { ok(false, "A9 内部异常 ⇒ ok:false（不抛到 Host）", String((e && e.message) || e)); }
  finally { store.be.listTopics = origList; }
}

// ── B. client.js 静态接线 ───────────────────────────────────────────────
ok(/function NoteStatRow\(props\)/.test(CJS), "B1 client.js 有 NoteStatRow 组件");
ok(CJS.indexOf("/dsh-memory/note-stat.json") >= 0 && /cache:\s*"no-store"/.test(CJS), "B2 fetch 端点 + cache no-store");
ok(/new AbortController/.test(CJS) && /},\s*3000\)/.test(CJS), "B3 3s AbortController 超时");
ok(/useEffect\(\(\) => \{[\s\S]{0,2000}?\}, \[\]\);/.test(CJS), "B4 useEffect([]) 只 fetch 一次（依赖数组为空）");
ok(/disabled === true/.test(CJS) && /ready === false/.test(CJS), "B5 disabled/ready 守卫（未就绪/flag 关隐藏）");
ok(/Number\.isFinite\(n\)/.test(CJS) && /Number\.isFinite\(m\)/.test(CJS), "B6 数字守卫（不渲染 undefined）");
ok(/if \(n <= 0 && m <= 0\) return;/.test(CJS), "B7 零值静默隐藏");
ok(/if \(!txt\) return null;/.test(CJS), "B8 无数据整行不渲染");
ok(/toLocaleString/.test(CJS), "B9 千分位格式化（toLocaleString）");
const iUsage = CJS.indexOf('"记忆使用统计"');
const iNoteRow = CJS.indexOf("react.createElement(NoteStatRow, {");
const iCost = CJS.indexOf("react.createElement(CostPanel, null)");
ok(iUsage > 0 && iNoteRow > iUsage && iCost > iNoteRow, "B10 插在「记忆使用统计」之后、「消耗」之前", iUsage + "/" + iNoteRow + "/" + iCost);
ok(!/实测 HTTP 400/.test(CJS) && !/访问不到插件路由/.test(CJS) && /转发给已认证 Host/.test(CJS), "B11 过期 400 注释已更新为「桌面端转发可达」");
ok(!/源访问不到插件路由/.test(CJS) && !/dsh-app:\/\/ 源访问不到/.test(CJS), "B12 桌面端点击提示不再引用旧「访问不到插件路由」结论");
let clientParseOk = false;
try { execFileSync(process.execPath, ["--check", CLIENT], { encoding: "utf8" }); clientParseOk = true; } catch (e) { clientParseOk = false; }
ok(clientParseOk, "B13 client.js 语法可解析（node --check）");
ok(/noteUnrefinedStats\(store, rows\)/.test(SRC) && /listTopics/.test(SRC), "B14 host 复用 noteUnrefinedStats + listTopics（不做全库快照）");

// ── C. 真库副本耗时（只打印，不硬断言）────────────────────────────────
const realDb = path.join(os.homedir(), ".dsh", "memory", ".memtopic", "mem.db");
if (fs.existsSync(realDb)) {
  try {
    const CP = path.join(TMP, "realcopy");
    fs.mkdirSync(CP, { recursive: true });
    const dst = path.join(CP, "mem.db");
    for (const ext of ["", "-wal", "-shm"]) { if (fs.existsSync(realDb + ext)) fs.copyFileSync(realDb + ext, dst + ext); }
    const backendMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "backend-sqlite.mjs")).href);
    const storeMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "memory-store.mjs")).href);
    const be = new backendMod.SqliteBackend(dst);
    const store = new storeMod.MemoryStore(be);
    const t0 = process.hrtime.bigint();
    const rows = (store.be && typeof store.be.listTopics === "function") ? store.be.listTopics() : store.topics();
    const st = mod.__noteUnrefinedStats(store, rows);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log("INFO 真库副本：listTopics+noteUnrefinedStats = " + ms.toFixed(1) + "ms（" + rows.length + " 主题 → " + st.topics + " 个未提炼 / " + st.sentences + " 句）");
    try { be.db.close(); } catch (e) { /* noop */ }
  } catch (e) { console.log("INFO 真库副本耗时测量失败（忽略）：" + ((e && e.message) || e)); }
} else {
  console.log("INFO 真库不存在，跳过耗时测量");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);
