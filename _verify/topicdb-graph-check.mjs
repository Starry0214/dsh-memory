// topicdb-graph-check.mjs —— task-29（知识图谱：/graph.json + canvas 力导向）脚本级验收
//
// 做法（照抄 _verify/topicdb-panel-check.mjs 的 harness）：
//   · DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指到**临时目录** ⇒ 绝不碰真实 ~/.dsh/memory；
//   · 用 _fixture-ctx.mjs 的公共 fake ctx，并额外给一个**假 webServer** 把路由 handler 抓出来直调；
//   · 夹具库在插件加载**之前**用 memtopic 的 backend 直接造（420 主题：7 域 / 29 项目线 / 364 明细 / 20 未归类
//     + 1 个合并主主题；含稀有 trigger、泛化 trigger、同系列、同源文件、合并关系），全程只读真实仓库、不写 ~/.dsh。
//
// 覆盖（G01–G12）：
//   G01 graph.json 结构齐全（nodes/links/stats 字段、端点闭合、degree 自洽）
//   G02 默认节点/边数在 caps 内（默认 350）
//   G03 focus+depth 收敛子图且包含 focus（depth=2 ⊃ depth=1）
//   G04 maxNodes 生效 + truncated 标记正确（硬上限 2000，2026-11-02 由 600 提升）
//   G05 边类型过滤（只传 tree ⇒ 无 trigger/merge/source/series 边）
//   G06 注入块零外部 URL（无 http(s)://、无 CDN）
//   G07 面板含 canvas + 搜索框 + 图例 + 无 canvas 列表兜底
//   G08 只读（无 POST/PUT/DELETE、无内联 onclick、无 XHR；连续请求后库/审计/健康计数零变化）
//   G09 flag 关：无 graph 路由、区块不注入、stats.json 无 topicdb 段
//   G10 性能：420 主题冷构建 ≤300ms（3 次均值，逐次清缓存）
//   G11 泛化 trigger 不产生边（路由级 + stub 级阈值判定）
//   G12 空库 / 单主题构建不崩（nodes=0 / 1）
//   G13 标签降噪（精简 <80 次 drawText / 18 字截断 / 底衬 / 三档开关）
//   G14 「显示标签」开关存在、无 inline onclick、addEventListener 绑定
//   G15 布局参数（charge 自适应 -180~-260 / collide 4~16 / link distance 分层）
//   G16 结构优先截断：域/项目线一个不少（含 degree=0 空域）
//   G17 未归类节点全部保留（保留真实 ID）
//   G18 截断口径自洽（kept 和 == nodes、truncated ⇔ truncatedDetails>0）
//   G19 默认排除 archived；byLevel.project 与面板 main.projects 一致
//   G20 includeArchived=1 归档节点出现、excludedArchived=0、前端开关存在
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";
const MEMTOPIC_SRC = "E:/工具/插件开发调整/memtopic/src/";
const EDGE_TYPES = ["tree", "merge", "trigger", "source", "series"];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-graphcheck-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
const DB_FILE = path.join(MEM, ".memtopic", "mem.db");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 图谱检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");

process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = DB_FILE;
delete process.env.MEMTOPIC_DIR;

// ───────────────────────── ① 夹具：420 主题 / 层级 / trigger / 系列 / 同源 / 合并 ─────────────────────────
const { MemoryStore } = await import(pathToFileURL(MEMTOPIC_SRC + "memory-store.mjs").href);
const { SqliteBackend } = await import(pathToFileURL(MEMTOPIC_SRC + "backend-sqlite.mjs").href);

const be = new SqliteBackend(DB_FILE);
const STAMP = Date.now();
let SEQ = 0;
const pad2 = (n) => String(n).padStart(2, "0");
function alpha(n) {
  let s = "";
  let x = Number(n) || 0;
  do { s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } while (x > 0);
  return s;
}
function addTopic({ name, level, parentId, state, triggers, sentences, src }) {
  SEQ += 1;
  const id = "T-" + String(SEQ).padStart(4, "0");
  be.insertTopic({ id, name, norm: "graphfix-" + id.toLowerCase(), aliases: [], triggers: triggers || [], state: state || "draft", createdAt: STAMP, updatedAt: STAMP, lastHitAt: null, writeCount: 0 });
  be.setMeta("level:" + id, level);
  if (parentId) be.setMeta("parent:" + id, parentId);
  be.setMeta("state.since:" + id, String(STAMP));
  be.setMeta("hits:" + id, "0");
  let ord = 0;
  for (const text of (sentences || [])) {
    ord += 1;
    be.insertSentence({ topicId: id, ord: ord, sha: "g" + id + "-" + ord, text: text, chars: text.length, createdAt: STAMP, updatedAt: STAMP, src: src || null });
  }
  return id;
}

const DOMAIN_NAMES = ["图谱域D1-招投标与交易", "图谱域D2-手机影像逆向", "图谱域D3-DSH工具链", "图谱域D4-跨项目纪律", "图谱域D5-记忆归档流水", "图谱域D6-未归类待判定", "图谱域D7-会话流水"];
const domainIds = DOMAIN_NAMES.map((name, i) => addTopic({ name, level: "domain", parentId: null, state: "active", triggers: [], sentences: ["域占位句 " + (i + 1)], src: "knowledge/MEMORY-图谱域" + (i + 1) + ".md" }));
const projectIds = [];
for (let i = 0; i < 29; i++) {
  // [task-32] 只挂前 6 个域 ⇒ 第 7 个域（对齐真实库 D6「未归类待判定」）degree=0，
  //   用于验证"结构优先截断不裁空域"（旧实现会被 degree 排序裁掉）
  projectIds.push(addTopic({
    name: "图谱项目线" + alpha(i) + "-" + (i + 1),
    level: "project", parentId: domainIds[i % 6], state: "active",
    triggers: ["图谱项目词" + alpha(i)],
    sentences: ["项目线占位句 " + (i + 1)],
    src: "knowledge/MEMORY-图谱项目" + (i + 1) + ".md",
  }));
}
const RARE_COUNT = 12;
const GEN_FROM = 36, GEN_TO = 76;          // 40 个主题挂泛化词 "2026"
const SERIES_FROM = 76, SERIES_TO = 93;    // 17 个"日摘要"同系列
const SHARED_FROM = 93, SHARED_TO = 98;    // 5 个主题同源文件
const SHARED_SRC = "knowledge/MEMORY-图谱共享源.md";
const detailIds = [];
for (let k = 0; k < 363; k++) {
  const state = (k % 13 === 0) ? "needs_review" : (k % 11 === 0 ? "dormant" : (k % 7 === 0 ? "active" : "draft"));
  const triggers = [];
  if (k < RARE_COUNT * 3) triggers.push("图谱稀有词R" + alpha(Math.floor(k / 3)));   // 每个稀有词恰好 3 个主题
  if (k >= GEN_FROM && k < GEN_TO) triggers.push("2026");                              // 泛化词（覆盖 40 > 阈值）
  let name = "图谱明细记录" + alpha(k);
  if (k >= SERIES_FROM && k < SERIES_TO) name = "图谱日摘要 2026-10-" + pad2(k - SERIES_FROM + 1);
  const src = (k >= SHARED_FROM && k < SHARED_TO) ? SHARED_SRC : ("knowledge/MEMORY-图谱明细-" + alpha(k) + ".md");
  detailIds.push(addTopic({
    name, level: "detail", parentId: projectIds[k % 29], state, triggers,
    sentences: ["明细正文甲 " + alpha(k), "明细正文乙 " + alpha(k)],
    src,
  }));
}
const unmappedIds = [];
for (let i = 0; i < 20; i++) {
  unmappedIds.push(addTopic({
    name: "图谱未归类" + alpha(i),
    level: "detail", parentId: null, state: "draft", triggers: [],
    sentences: ["未归类正文 " + alpha(i)],
    src: "knowledge/MEMORY-图谱未归类" + alpha(i) + ".md",
  }));
}
// [task-39] 2 个"已归档的空项目线容器"（复现真实库 D8 落库后归档的旧容器：无子节点 ⇒ 默认图上孤立点；
//   默认应从 graph.json 排除，includeArchived=1 时才以灰色虚线加入）
const archivedProjectIds = [];
for (let i = 0; i < 2; i++) {
  archivedProjectIds.push(addTopic({
    name: "图谱归档容器" + alpha(i),
    level: "project", parentId: null, state: "archived", triggers: [],
    sentences: ["归档容器占位句 " + alpha(i)],
    src: "knowledge/MEMORY-图谱归档容器" + alpha(i) + ".md",
  }));
}
// 合并关系：让 2 个明细并入 1 个主主题（产生 merge 边 + 2 个 archived 源主题）；
// 总行 = 7 域 + 29 项目线 + 363 明细 + 20 未归类 + 2 归档容器 + 1 合并主主题 = 422
let mergeMainId = null;
try {
  const storeSeed = new MemoryStore(be);
  const merged = storeSeed.mergeCluster({ members: [detailIds[100], detailIds[101]], title: "图谱检查合并主主题", actor: "lead" });
  mergeMainId = merged && (merged.mainTopicId || merged.mainId) || null;
} catch (e) {
  console.log("[FATAL] 夹具 mergeCluster 失败：" + ((e && e.message) || e));
  process.exit(2);
}
const seededRows = be.listTopics();
if (seededRows.length !== 422 || !mergeMainId) {
  console.log("[FATAL] 夹具规模异常：topics=" + seededRows.length + " mergeMain=" + mergeMainId);
  process.exit(2);
}
be.close();

// ───────────────────────── ② 加载插件 + harness（临时 DSH_HOME，绝不碰真实 ~/.dsh） ─────────────────────────
const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store) return true;
    await sleep(100);
  }
  return false;
}
function makeCtx() {
  const fx = createFixtureCtx({});
  const routes = new Map();
  const origInject = fx.ctx.inject.bind(fx.ctx);
  fx.ctx.inject = (names, cb) => {
    const arr = Array.isArray(names) ? names : [String(names)];
    if (arr.includes("webServer")) {
      try {
        cb({ webServer: { port: 0, register(def) { if (def && def.path) routes.set(String(def.path), def.handler); return () => {}; } } });
      } catch (e) { /* 路由采集失败只影响本脚本断言，不影响插件 */ }
    }
    return origInject(names, () => {});
  };
  return { ctx: fx.ctx, captured: fx.captured, routes: routes };
}
function callRoute(routes, p, url) {
  const h = routes.get(String(p));
  if (typeof h !== "function") return { status: 404, body: "", headers: {}, missing: true };
  const out = { status: 200, headers: {}, body: "" };
  const res = {
    statusCode: 200,
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(b) { out.body = b == null ? "" : String(b); },
  };
  h({ url: url || p, method: "GET", headers: {} }, res);
  out.status = res.statusCode;
  return out;
}
const GRAPH_PATH = "/dsh-memory/graph.json";
function graphJson(routes, qs) {
  const r = callRoute(routes, GRAPH_PATH, qs ? (GRAPH_PATH + "?" + qs) : GRAPH_PATH);
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { j = null; }
  return { status: r.status, body: r.body, j: j };
}
function stubStore(rows) {
  return {
    topics() { return rows.map((r) => Object.assign({}, r)); },
    be: { getMeta() { return null; }, listSentences() { return []; } },
  };
}

// ───────────────────────── 第 1 轮：flag 关（G09） ─────────────────────────
const off = makeCtx();
plugin.apply(off.ctx, { memoryTopicDbEnabled: false });
await sleep(400);
{
  ok(!off.routes.has(GRAPH_PATH), "G09 flag 关：**不存在** /dsh-memory/graph.json 路由（路由表里就没有）", "routes=" + [...off.routes.keys()].join(","));
  const offDetect = (function () { try { return mod.__topicdbGraphRouteEnsure(); } catch (e) { return "throw:" + ((e && e.message) || e); } })();
  ok(offDetect === false && !off.routes.has(GRAPH_PATH), "G09 flag 关：ensure 补挂也拒绝（flag 关不注册）", String(offDetect));
  const rj = callRoute(off.routes, "/dsh-memory/stats.json");
  let j0 = null; try { j0 = JSON.parse(rj.body); } catch (e) { j0 = null; }
  ok(!!j0 && !Object.prototype.hasOwnProperty.call(j0, "topicdb"), "G09 flag 关：stats.json 无 topicdb 段（逐字不变）", j0 ? Object.keys(j0).join(",") : "-");
  const rh = callRoute(off.routes, "/dsh-memory/stats");
  ok(rh.status === 200 && !rh.body.includes("topicdb-graph") && !rh.body.includes("tdbg-canvas") && !rh.body.includes("知识图谱"),
    "G09 flag 关：面板 HTML 不含图谱区块/canvas（区块不注入）", "len=" + rh.body.length);
}

// ───────────────────────── 第 2 轮：flag 开（G01–G08、G10–G12） ─────────────────────────
const on = makeCtx();
plugin.apply(on.ctx, { memoryTopicDbEnabled: true });
const ready = await waitReady();
ok(ready, "准备：flag 开且主题账本就绪（临时夹具库）",
  "backend=" + ((mod.__topicdb.store && mod.__topicdb.store.be && mod.__topicdb.store.be.kind) || "?") + " db=" + (mod.__topicdb.dbFile || "?"));
ok(on.routes.has(GRAPH_PATH), "准备：flag 开时 /dsh-memory/graph.json 路由已注册");
const store = mod.__topicdb.store;

// ── G01 结构 ──
const dflt = graphJson(on.routes, "");
const g = dflt.j || {};
{
  ok(dflt.status === 200 && !!g && g.ok === true, "G01 graph.json 正常返回（HTTP 200 + ok:true）", "len=" + dflt.body.length);
  ok(Array.isArray(g.nodes) && Array.isArray(g.links) && g.stats && typeof g.stats === "object",
    "G01 顶层含 nodes[] / links[] / stats{}", "nodes=" + (g.nodes || []).length + " links=" + (g.links || []).length);
  ok(g.stats && g.stats.nodes === g.nodes.length && g.stats.links === g.links.length
    && typeof g.stats.truncated === "boolean" && typeof g.stats.buildMs === "number"
    && g.stats.buildMs >= 0 && g.stats.capsUsed && g.stats.capsUsed.hardMaxNodes === 2000 && g.stats.capsUsed.defaultMaxNodes === 350,
    "G01 stats 字段齐全（nodes/links/truncated/capsUsed/buildMs）", JSON.stringify({ nodes: g.stats && g.stats.nodes, links: g.stats && g.stats.links, truncated: g.stats && g.stats.truncated, buildMs: g.stats && g.stats.buildMs, caps: g.stats && g.stats.capsUsed }));
  const nodeKeys = ["id", "name", "level", "state", "sentences", "chars", "degree", "triggers"];
  ok(g.nodes.length > 0 && g.nodes.every((n) => nodeKeys.every((k) => n[k] !== undefined) && Array.isArray(n.triggers) && ["domain", "project", "detail"].includes(n.level)),
    "G01 节点字段齐全（id/name/level/state/sentences/chars/degree/triggers）", "n=" + g.nodes.length);
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  ok(g.links.length > 0 && g.links.every((l) => l.s && l.t && EDGE_TYPES.includes(l.type) && typeof l.w === "number" && l.w >= 1)
    && g.links.every((l) => nodeIds.has(l.s) && nodeIds.has(l.t)),
    "G01 边字段齐全且端点闭合（s/t/type∈5 类/w≥1）", "links=" + g.links.length);
  const deg = new Map();
  for (const l of g.links) { deg.set(l.s, (deg.get(l.s) || 0) + 1); deg.set(l.t, (deg.get(l.t) || 0) + 1); }
  ok(g.nodes.every((n) => (deg.get(n.id) || 0) === n.degree), "G01 节点 degree 与实际返回边一致（前端高亮/大小自洽）");
  ok(g.stats.totalNodes === 422 && g.stats.totalLinks > 0, "G01 全量口径字段正确（夹具 422 总行，含 4 归档）", JSON.stringify({ totalNodes: g.stats.totalNodes, totalLinks: g.stats.totalLinks }));
}

// ── G02 默认 caps ──
{
  ok(g.nodes.length <= 350 && g.stats.capsUsed.maxNodes === 350,
    "G02 默认节点数在 caps 内（≤350，capsUsed.maxNodes=350）", "nodes=" + g.nodes.length);
  ok(g.stats.truncated === true && g.stats.truncatedNodes === g.stats.scopeNodes - g.nodes.length && typeof g.stats.truncatedNote === "string",
    "G02 非归档 418>350 ⇒ truncated=true 且 truncatedNodes 自洽", JSON.stringify({ truncated: g.stats.truncated, truncatedNodes: g.stats.truncatedNodes, scopeNodes: g.stats.scopeNodes }));
  ok(g.links.length > 0 && g.links.every((l) => { const ids = new Set(g.nodes.map((n) => n.id)); return ids.has(l.s) && ids.has(l.t); }),
    "G02 默认视图边全部落在返回节点内");
}

// 全量图（maxNodes=600 < 硬上限 2000，且 > 夹具非归档数 ⇒ 不截断）——供 G04/G05/G11 与边计数使用
const full = graphJson(on.routes, "maxNodes=600").j || {};
{
  ok(full.nodes.length === 418 && full.stats.truncated === false && full.stats.capsUsed.maxNodes === 600,
    "G04 maxNodes=600（低于硬上限 2000）⇒ 返回 418 个非归档节点且 truncated=false", JSON.stringify({ nodes: full.nodes.length, truncated: full.stats.truncated }));
  ok(full.stats.byEdge && full.stats.byEdge.tree === 390 && full.stats.byEdge.merge === 0 && full.stats.byEdge.trigger === 24 && full.stats.byEdge.source === 4 && full.stats.byEdge.series === 16,
    "G04 全量边构成符合夹具设计（默认排除 4 个归档 ⇒ tree=390/merge=0/trigger=24/source=4/series=16）",
    JSON.stringify(full.stats.byEdge));
}

// ── G03 focus+depth ──
{
  const focus = projectIds[0];
  const d1 = graphJson(on.routes, "focus=" + focus + "&depth=1").j || {};
  const d2 = graphJson(on.routes, "focus=" + focus + "&depth=2").j || {};
  ok(d1.ok === true && d1.stats.focus === focus && d1.stats.depth === 1, "G03 focus 生效（stats.focus/depth 回显）", JSON.stringify({ focus: d1.stats && d1.stats.focus, depth: d1.stats && d1.stats.depth }));
  ok(d1.nodes.some((n) => n.id === focus), "G03 收敛子图包含 focus 节点", "nodes=" + d1.nodes.length);
  ok(d1.nodes.length < 418 && d1.stats.totalNodes === 422, "G03 depth=1 子图节点数 < 非归档全量（确实收敛）", "d1=" + d1.nodes.length + " < 418");
  ok(d2.nodes.length >= d1.nodes.length && d2.stats.depth === 2, "G03 depth=2 覆盖 depth=1（层级深度参数生效）", "d1=" + d1.nodes.length + " d2=" + d2.nodes.length);
  const fullAdj = new Map();
  for (const l of full.links) {
    if (!fullAdj.has(l.s)) fullAdj.set(l.s, new Set());
    if (!fullAdj.has(l.t)) fullAdj.set(l.t, new Set());
    fullAdj.get(l.s).add(l.t);
    fullAdj.get(l.t).add(l.s);
  }
  const nb = fullAdj.get(focus) || new Set();
  ok(d1.nodes.every((n) => n.id === focus || nb.has(n.id)), "G03 depth=1 子图恰为 focus 的一跳邻居（语义正确）", "neighbors=" + nb.size);
  const missing = graphJson(on.routes, "focus=T-9999&depth=1").j || {};
  ok(missing.ok === true && missing.stats.focusMissing === true && missing.stats.focus === null && missing.stats.truncated === true,
    "G03 不存在的 focus 优雅回退全图（focusMissing 标记，不报错）", JSON.stringify({ focusMissing: missing.stats && missing.stats.focusMissing, nodes: missing.nodes && missing.nodes.length }));
}

// ── G04 maxNodes 生效 ──
{
  const m60 = graphJson(on.routes, "maxNodes=60").j || {};
  ok(m60.nodes.length === 60 && m60.stats.capsUsed.maxNodes === 60 && m60.stats.truncated === true && m60.stats.truncatedNodes === 358,
    "G04 maxNodes=60 生效（60 节点 + truncated + 截断 358）", JSON.stringify({ nodes: m60.nodes.length, truncatedNodes: m60.stats.truncatedNodes }));
  const mBad = graphJson(on.routes, "maxNodes=99999").j || {};
  ok(mBad.stats.capsUsed.maxNodes === 2000 && mBad.nodes.length === 418 && mBad.stats.truncated === false,
    "G04 maxNodes 超硬上限被夹到 2000（不越界；418 个非归档节点）", JSON.stringify({ caps: mBad.stats.capsUsed.maxNodes, nodes: mBad.nodes.length }));
  const mZero = graphJson(on.routes, "maxNodes=0").j || {};
  ok(mZero.stats.capsUsed.maxNodes === 350 && mZero.nodes.length === 350,
    "G04 非法 maxNodes（0）回落默认 350", "caps=" + (mZero.stats && mZero.stats.capsUsed.maxNodes));
}

// ── G05 边类型过滤 ──
{
  const t1 = graphJson(on.routes, "edgeTypes=tree").j || {};
  ok(t1.links.length > 0 && t1.links.every((l) => l.type === "tree") && t1.stats.edgeTypes.length === 1 && t1.stats.edgeTypes[0] === "tree",
    "G05 只传 edgeTypes=tree ⇒ 返回边全部是 tree（无 trigger/merge/source/series）", "links=" + t1.links.length);
  ok(t1.stats.byEdge.trigger === 0 && t1.stats.byEdge.merge === 0 && t1.stats.byEdge.source === 0 && t1.stats.byEdge.series === 0,
    "G05 边统计同步归零（byEdge 只 tree）", JSON.stringify(t1.stats.byEdge));
  const t2 = graphJson(on.routes, "edgeTypes=tree,merge").j || {};
  ok(t2.links.length > 0 && t2.links.every((l) => l.type === "tree" || l.type === "merge") && t2.stats.edgeTypes.join(",") === "tree,merge",
    "G05 多选 edgeTypes=tree,merge 生效", "links=" + t2.links.length);
}

// ── G06/G07/G08 注入块（面板 HTML） ──
let blockHtml = "";
{
  const rh = callRoute(on.routes, "/dsh-memory/stats");
  const html = rh.body;
  const mi = html.indexOf("<!--[topicdb-graph]-->");
  const me = html.indexOf("<!--[/topicdb-graph]-->");
  blockHtml = (mi >= 0 && me > mi) ? html.slice(mi, me) : "";
  ok(mi >= 0 && me > mi, "G06 图谱区块以自有起止标记注入（<!--[topicdb-graph]-->…<!--[/topicdb-graph]-->）", "bytes=" + Buffer.byteLength(blockHtml || "", "utf8"));
  ok(blockHtml.length > 8000, "G06 图谱区块内容非空（≈30KB 内联 CSS/HTML/JS 同体）", "bytes=" + Buffer.byteLength(blockHtml, "utf8"));
  ok(!/https?:\/\//i.test(blockHtml), "G06 注入块内**零** http(s):// 外部 URL（离线可用）");
  ok(!/\/\/cdn|cdnjs|unpkg|jsdelivr|googleapis/i.test(blockHtml), "G06 注入块内无 CDN/第三方域名");
  ok(blockHtml.includes('id="tdbg-canvas"') && blockHtml.includes("<canvas") && blockHtml.includes('id="tdbg-q"') && blockHtml.includes('id="tdbg-legend"'),
    "G07 面板含 canvas + 搜索框 + 图例", JSON.stringify({ canvas: blockHtml.includes('id="tdbg-canvas"'), search: blockHtml.includes('id="tdbg-q"'), legend: blockHtml.includes('id="tdbg-legend"') }));
  ok(blockHtml.includes("renderList") && blockHtml.includes("无 canvas") && blockHtml.includes("hasCanvas"),
    "G07 无 canvas 时退化为列表视图（renderList 兜底分支存在）");
  ok(blockHtml.includes("ESC") && blockHtml.includes("depth=2") && blockHtml.includes("memory_read") && blockHtml.includes("addEventListener"),
    "G07 交互要素齐全（ESC 复位 / 双击 depth=2 / 可复制 memory_read 命令 / addEventListener）");
  const panelIdx = html.indexOf("<!--[/topicdb-panel]-->");
  ok(panelIdx >= 0 && mi > panelIdx, "G07 图谱区块紧跟在主题库区块之后注入（不改动既有摘要条/两栏/层级树结构）", "panelEnd=" + panelIdx + " graphAt=" + mi);
  ok(!/onclick\s*=/i.test(blockHtml), "G08 只读：注入块无内联 onclick（全部 addEventListener）");
  ok(!/method\s*[:=]\s*["'](POST|PUT|DELETE)/i.test(blockHtml) && !/XMLHttpRequest/.test(blockHtml) && !/<form/i.test(blockHtml),
    "G08 只读：无 POST/PUT/DELETE、无 XHR、无 form");
  const fetches = blockHtml.match(/fetch\(/g) || [];
  ok(fetches.length >= 1 && blockHtml.includes('fetch(url, { cache: "no-store" })'),
    "G08 只读：唯一数据请求是 GET 同源 graph.json（fetch 无 method=POST）", "fetch 次数=" + fetches.length);
}

// ── G08 只读行为：连续请求后库/审计/健康计数零变化 ──
{
  const before = {
    topics: store.topics().length,
    sentences: store.topicCounts().sentences,
    auditTail: (store.auditTail(500) || []).length,
    ok: Number(mod.__topicdbHealth && mod.__topicdbHealth.ok || 0),
    failed: Number(mod.__topicdbHealth && mod.__topicdbHealth.failed || 0),
  };
  for (let i = 0; i < 3; i++) {
    graphJson(on.routes, "");
    graphJson(on.routes, "focus=" + projectIds[1] + "&depth=2");
    graphJson(on.routes, "edgeTypes=tree&maxNodes=80");
  }
  const after = {
    topics: store.topics().length,
    sentences: store.topicCounts().sentences,
    auditTail: (store.auditTail(500) || []).length,
    ok: Number(mod.__topicdbHealth && mod.__topicdbHealth.ok || 0),
    failed: Number(mod.__topicdbHealth && mod.__topicdbHealth.failed || 0),
  };
  ok(JSON.stringify(before) === JSON.stringify(after), "G08 只读：9 次图谱请求后主题数/句数/审计/写入健康计数全部零变化", JSON.stringify({ before, after }));
}

// ── 图谱内联 JS 运行期 harness（node:vm + 最小 fake DOM；G07b / G13 / G14 / G15 共用） ──
const vmMod = await import("node:vm");
const graphClientJs = (() => {
  const i0 = blockHtml.indexOf("<script>") + "<script>".length;
  const i1 = blockHtml.indexOf("</script>", i0);
  return blockHtml.slice(i0, i1);
})();
function mkGraphDomEnv(withCanvas, graph) {
  const els = {};
  const texts = [];
  const rects = [];
  const winListeners = {};
  const mk = (id, extra) => {
    const e = Object.assign({ id: id, innerHTML: "", textContent: "", hidden: false, value: "", style: {}, listeners: {}, addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }, getAttribute() { return null; } }, extra || {});
    els[id] = e;
    return e;
  };
  const ctx2d = {
    setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
    fillRect(x, y, w, h) { rects.push([x, y, w, h]); },
    measureText(t) { return { width: String(t == null ? "" : t).length * 6 }; },
    fillText(t) { texts.push(String(t == null ? "" : t)); },
  };
  mk("tdbg-canvas", { getContext() { return withCanvas ? ctx2d : null; }, clientWidth: 900, clientHeight: 520, width: 0, height: 0, getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 520 }; }, setPointerCapture() {} });
  mk("tdbg-note"); mk("tdbg-q"); mk("tdbg-hit-note"); mk("tdbg-hits"); mk("tdbg-detail"); mk("tdbg-legend"); mk("tdbg-msg"); mk("tdbg-list"); mk("tdbg-unfocus");
  mk("tdbg-level", { value: "" }); mk("tdbg-state", { value: "" }); mk("tdbg-reset"); mk("tdbg-zoomin"); mk("tdbg-zoomout");
  mk("tdbg-labels", { value: "lite" });
  mk("tdbg-incl-arch", { checked: false });
  const document = {
    getElementById(id) { return els[id] || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return { style: {}, appendChild() {}, removeChild() {}, select() {} }; },
    execCommand() {},
    body: { appendChild() {}, removeChild() {} },
  };
  const rafs = [];
  const window = {
    requestAnimationFrame(cb) { rafs.push(cb); return rafs.length; },
    addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    devicePixelRatio: 1,
  };
  const sandbox = {
    document: document, window: window,
    fetch() { return Promise.resolve({ ok: true, status: 200, json() { return Promise.resolve(JSON.parse(JSON.stringify(graph))); } }); },
    setTimeout: setTimeout, clearTimeout: clearTimeout, encodeURIComponent: encodeURIComponent,
    isNaN: isNaN, Number: Number, String: String, Math: Math, Object: Object, Array: Array, JSON: JSON, console: console,
    navigator: { clipboard: null },
  };
  sandbox.globalThis = sandbox;
  return { sandbox: sandbox, els: els, rafs: rafs, texts: texts, rects: rects, winListeners: winListeners };
}
async function runGraphClient(withCanvas, graph) {
  const env = mkGraphDomEnv(withCanvas, graph);
  vmMod.createContext(env.sandbox);
  const out = { env: env, evalThrow: null, frameThrow: null, note: "", legendLen: 0, listRows: 0, hitText: "", hitBtns: 0 };
  try { vmMod.runInContext(graphClientJs, env.sandbox, { timeout: 5000 }); } catch (e) { out.evalThrow = e; }
  await sleep(80);
  if (env.rafs.length) {
    try { const fn = env.rafs.shift(); fn(); } catch (e) { out.frameThrow = e; }
  }
  out.note = String(env.els["tdbg-note"].textContent || "");
  out.legendLen = String(env.els["tdbg-legend"].innerHTML || "").length;
  out.listRows = (String(env.els["tdbg-list"].innerHTML || "").match(/<tr/g) || []).length;
  try {
    env.els["tdbg-q"].value = "稀有词甲";
    const fns = (env.els["tdbg-q"].listeners && env.els["tdbg-q"].listeners.input) || [];
    for (const fn of fns) fn({});
    await sleep(240);
    out.hitText = String(env.els["tdbg-hit-note"].textContent || "");
    out.hitBtns = (String(env.els["tdbg-hits"].innerHTML || "").match(/tdbg-hit/g) || []).length;
  } catch (e) { out.searchThrow = e; }
  return out;
}
function fireEl(env, id, ev) {
  const fns = (env.els[id] && env.els[id].listeners && env.els[id].listeners[ev]) || [];
  for (const fn of fns) fn({});
}
function fireWin(env, ev) {
  const fns = env.winListeners[ev] || [];
  for (const fn of fns) fn({});
}

// ── G07b 运行期冒烟：canvas 模式 / 无 canvas 兜底（最小 3 节点图） ──
const GRAPH_STUB = {
  ok: true,
  nodes: [
    { id: "T-0001", name: "测试域甲", level: "domain", domain: "T-0001", domainName: "测试域甲", state: "active", sentences: 2, chars: 10, degree: 1, parent: null, mergedInto: null, unmapped: false, triggers: [], genericTriggers: [] },
    { id: "T-0002", name: "测试项目线甲", level: "project", domain: "T-0001", domainName: "测试域甲", state: "active", sentences: 5, chars: 30, degree: 2, parent: "T-0001", mergedInto: null, unmapped: false, triggers: ["稀有词甲"], genericTriggers: [] },
    { id: "T-0003", name: "测试明细甲 2026-10-01", level: "detail", domain: "T-0001", domainName: "测试域甲", state: "draft", sentences: 1, chars: 8, degree: 1, parent: "T-0002", mergedInto: null, unmapped: false, triggers: ["稀有词甲", "2026"], genericTriggers: ["2026"] },
  ],
  links: [{ s: "T-0001", t: "T-0002", type: "tree", w: 3 }, { s: "T-0002", t: "T-0003", type: "tree", w: 1.5 }],
  stats: { nodes: 3, links: 2, totalNodes: 3, totalLinks: 2, truncated: false, buildMs: 1.2, byEdge: { tree: 2, merge: 0, trigger: 0, source: 0, series: 0 }, byLevel: { domain: 1, project: 1, detail: 1 }, domainCount: 1, focus: null, capsUsed: { maxNodes: 350 } },
};
{
  const rc = await runGraphClient(true, GRAPH_STUB);
  ok(rc.evalThrow === null && rc.frameThrow === null && rc.note.includes("3 节点") && rc.legendLen > 100,
    "G07b 内联 JS 运行期冒烟（canvas 模式：执行/首帧无异常，统计与图例渲染）", JSON.stringify({ eval: rc.evalThrow && rc.evalThrow.message, frame: rc.frameThrow && rc.frameThrow.message, note: rc.note, legendLen: rc.legendLen }));
  ok(rc.hitText.includes("命中") && rc.hitBtns >= 2,
    "G07b 内联 JS 搜索冒烟（名字/trigger 子串命中 → 命中列表）", JSON.stringify({ hitText: rc.hitText, hitBtns: rc.hitBtns }));
  const rf = await runGraphClient(false, GRAPH_STUB);
  ok(rf.evalThrow === null && rf.frameThrow === null && rf.note.includes("列表视图") && rf.listRows >= 3 && rf.hitText.includes("命中"),
    "G07b 无 canvas 兜底冒烟（执行无异常 + 列表视图 + 搜索命中）", JSON.stringify({ eval: rf.evalThrow && rf.evalThrow.message, note: rf.note, listRows: rf.listRows, hitText: rf.hitText }));
}

// ── G13/G14/G15：350 节点真实规模图（域 7 / 项目线 29 / 明细 314 + 混合边）──
const BIG_GRAPH = (() => {
  const pad = (n) => String(n).padStart(2, "0");
  const nodes = [];
  const links = [];
  const domains = [];
  for (let i = 0; i < 7; i++) {
    const id = "T-BD" + pad(i);
    domains.push(id);
    nodes.push({ id, name: "图谱域D" + (i + 1) + "-超长域名称用于验证标签截断逻辑", level: "domain", domain: id, domainName: "图谱域D" + (i + 1), state: "active", sentences: 3, chars: 20, degree: 0, parent: null, mergedInto: null, unmapped: false, triggers: [], genericTriggers: [] });
  }
  for (let i = 0; i < 29; i++) {
    nodes.push({ id: "T-BP" + pad(i), name: "图谱项目线" + (i + 1), level: "project", domain: domains[i % 7], domainName: "图谱域D" + ((i % 7) + 1), state: "active", sentences: 4, chars: 30, degree: 0, parent: domains[i % 7], mergedInto: null, unmapped: false, triggers: [], genericTriggers: [] });
    links.push({ s: domains[i % 7], t: "T-BP" + pad(i), type: "tree", w: 3 });
  }
  for (let i = 0; i < 314; i++) {
    const id = "T-BX" + String(i).padStart(3, "0");
    nodes.push({ id, name: "图谱明细记录" + i + "·" + "这是一条用于验证十八字截断的超长主题名称", level: "detail", domain: domains[i % 7], domainName: "图谱域D" + ((i % 7) + 1), state: i % 9 === 0 ? "active" : "draft", sentences: (i % 6) + 1, chars: 10 + (i % 9) * 3, degree: 0, parent: "T-BP" + pad(i % 29), mergedInto: null, unmapped: false, triggers: [], genericTriggers: [] });
    links.push({ s: "T-BP" + pad(i % 29), t: id, type: "tree", w: 1.5 });
  }
  for (let i = 0; i < 90; i++) {
    const a = "T-BX" + String((i * 3) % 314).padStart(3, "0");
    const b = "T-BX" + String((i * 11 + 7) % 314).padStart(3, "0");
    if (a !== b) links.push({ s: a, t: b, type: "trigger", w: 1, via: "稀有词" + i });
  }
  const deg = new Map();
  for (const l of links) { deg.set(l.s, (deg.get(l.s) || 0) + 1); deg.set(l.t, (deg.get(l.t) || 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;
  return { ok: true, nodes: nodes, links: links, stats: { nodes: nodes.length, links: links.length, totalNodes: nodes.length, totalLinks: links.length, truncated: false, buildMs: 2, byEdge: {}, byLevel: { domain: 7, project: 29, detail: 314 }, domainCount: 7, focus: null, capsUsed: { maxNodes: 350 } } };
})();
const bigRun = await runGraphClient(true, BIG_GRAPH);
{
  // G13 标签降噪：默认"精简"模式下一次 render 的 drawText 次数 < 80（域 7 + 项目线 29 + Top30 = 66）
  const env = bigRun.env;
  env.texts.length = 0;
  env.rects.length = 0;
  fireWin(env, "resize");
  const liteCount = env.texts.length;
  const rectCount = env.rects.length;
  ok(liteCount > 0 && liteCount < 80,
    "G13 精简标签：默认一次渲染 drawText 调用 < 80（候选 域7+项目线29+Top30；碰撞避让后实际绘制数）", "drawText=" + liteCount);
  ok(env.texts.every((t) => String(t).length <= 19 && (String(t).length <= 18 || String(t).slice(-1) === "…")),
    "G13 标签截断：全部标签 ≤18 字（超长以 … 结尾）", "maxLen=" + Math.max(0, ...env.texts.map((t) => String(t).length)));
  ok(rectCount >= liteCount && rectCount > 0,
    "G13 标签底衬：每条标签都有半透明底衬（fillRect 次数 ≥ 文本次数）", "fillRect=" + rectCount + " drawText=" + liteCount);
  // "全部"档 ⇒ 350 个节点全画；"无"档 ⇒ 0
  env.els["tdbg-labels"].value = "all";
  fireEl(env, "tdbg-labels", "change");
  env.texts.length = 0;
  fireWin(env, "resize");
  const allCount = env.texts.length;
  env.els["tdbg-labels"].value = "none";
  fireEl(env, "tdbg-labels", "change");
  env.texts.length = 0;
  fireWin(env, "resize");
  const noneCount = env.texts.length;
  ok(allCount >= 300 && noneCount === 0,
    "G13 标签三档开关生效（全部 ⇒ ≥300 条；无 ⇒ 0 条）", "all=" + allCount + " none=" + noneCount);
  // 恢复默认，避免影响后续断言
  env.els["tdbg-labels"].value = "lite";
  fireEl(env, "tdbg-labels", "change");
}

{
  // G14 开关存在 + 无 inline onclick + 绑定 addEventListener
  ok(blockHtml.includes('id="tdbg-labels"') && blockHtml.includes("显示标签") && blockHtml.includes("精简") && blockHtml.includes("全部") && blockHtml.includes("无"),
    "G14 工具栏含「显示标签」三档开关（精简/全部/无，默认精简）");
  ok(!/onclick\s*=/i.test(blockHtml) && ((bigRun.env.els["tdbg-labels"].listeners.change || []).length >= 1),
    "G14 开关无 inline onclick 且用 addEventListener 绑定（change 监听存在）",
    "changeListeners=" + ((bigRun.env.els["tdbg-labels"].listeners.change || []).length) + " onclick=" + /onclick\s*=/i.test(blockHtml));
}

{
  // G15 布局参数（从内联 JS 暴露的 window.__tdbgGraphLayout 直读）
  const L = bigRun.env.sandbox.window && bigRun.env.sandbox.window.__tdbgGraphLayout;
  ok(!!L && typeof L.chargeOf === "function" && Math.abs(L.chargeMin) >= 150 && Math.abs(L.chargeMax) >= 150
    && Math.abs(L.chargeOf(350)) >= 180 && Math.abs(L.chargeOf(350)) <= 260,
    "G15 布局参数：charge 绝对值 ≥150（350 节点自适应到 180~260）", L ? JSON.stringify({ min: L.chargeMin, max: L.chargeMax, at350: Math.round(L.chargeOf(350)) }) : "missing");
  ok(!!L && L.collideMin === 4 && L.collideMax === 16 && L.collideOf({ sentences: 0 }) >= 4 && L.collideOf({ sentences: 100 }) <= 16 && L.collideOf({ sentences: 100 }) > L.collideOf({ sentences: 0 }),
    "G15 布局参数：collide 半径按句数映射 min4/max16", L ? JSON.stringify({ min: L.collideMin, max: L.collideMax, s0: L.collideOf({ sentences: 0 }), s100: Math.round(L.collideOf({ sentences: 100 }) * 10) / 10 }) : "missing");
  const treeD = L ? [L.linkDistanceOf({ type: "tree", w: 1.5 }), L.linkDistanceOf({ type: "tree", w: 3 })] : [];
  const otherD = L ? [L.linkDistanceOf({ type: "series" }), L.linkDistanceOf({ type: "trigger" }), L.linkDistanceOf({ type: "source" }), L.linkDistanceOf({ type: "merge" })] : [];
  ok(!!L && treeD.every((d) => d >= 60 && d <= 90) && otherD.every((d) => d >= 40 && d <= 60),
    "G15 布局参数：link distance 分层（tree 60~90；其余 40~60）", JSON.stringify({ tree: treeD, other: otherD }));
}



// ── G10 性能（420 主题冷构建 3 次均值 ≤300ms） ──
let fullGraph = null;
{
  const times = [];
  for (let i = 0; i < 3; i++) {
    mod.__topicdbGraphInvalidate();          // 逐次清缓存 ⇒ 每次都测"冷构建"
    const t0 = performance.now();
    const r = graphJson(on.routes, "maxNodes=600");
    const wall = performance.now() - t0;
    const j = r.j || {};
    fullGraph = j;
    times.push({ buildMs: Number(j.stats && j.stats.buildMs), buildMsBase: Number(j.stats && j.stats.buildMsBase), wallMs: Math.round(wall * 10) / 10, nodes: j.stats && j.stats.nodes, totalNodes: j.stats && j.stats.totalNodes, cached: j.stats && j.stats.cached });
  }
  const avgBuild = times.reduce((a, x) => a + x.buildMs, 0) / times.length;
  const avgWall = times.reduce((a, x) => a + x.wallMs, 0) / times.length;
  ok(times.every((x) => x.totalNodes === 422), "G10 性能样本口径：每次都是全库 422 总行（418 非归档）", "totalNodes=" + times.map((x) => x.totalNodes).join(","));
  ok(times.every((x) => x.cached === false), "G10 逐次清缓存后均为冷构建（cached=false，测的是真实构建成本）", times.map((x) => x.cached).join(","));
  ok(avgBuild <= 300, "G10 420 主题冷构建均值 ≤300ms（stats.buildMs）", "avg=" + avgBuild.toFixed(1) + "ms times=" + times.map((x) => x.buildMs).join("/"));
  ok(avgWall <= 300, "G10 端到端均值 ≤300ms（路由 + JSON 序列化）", "avgWall=" + avgWall.toFixed(1) + "ms times=" + times.map((x) => x.wallMs).join("/"));
  console.log("INFO  G10 明细：" + JSON.stringify(times));
}

// ── G11 泛化 trigger 不产生边 ──
{
  const full2 = fullGraph || graphJson(on.routes, "maxNodes=600").j || {};
  const trig = (full2.links || []).filter((l) => l.type === "trigger");
  const nodeById = new Map((full2.nodes || []).map((n) => [n.id, n]));
  const covOf = (tr) => (full2.nodes || []).filter((n) => (n.triggers || []).includes(tr)).length;
  ok(trig.length === 24, "G11 路由级：稀有 trigger 边数 = 设计值 24（12 个稀有词 × 每个 2 条）", "triggerLinks=" + trig.length);
  ok(trig.every((l) => typeof l.via === "string" && l.via.length > 0), "G11 路由级：trigger 边带 via（可核对是哪个 trigger）");
  ok(trig.every((l) => covOf(l.via) <= 5 && covOf(l.via) >= 2), "G11 路由级：所有 trigger 边的 via 覆盖率都在 [2, 阈值 5]（泛化词被排除）",
    "maxCov=" + Math.max(0, ...trig.map((l) => covOf(l.via))));
  ok(!trig.some((l) => String(l.via).includes("2026")), "G11 路由级：泛化词 2026 不产生任何边（节点 triggers 里也已剔除）");
  ok((full2.stats && full2.stats.triggerThreshold) === 5, "G11 阈值来源 = store 的 genericTriggerMaxTopics（默认 5）", "threshold=" + (full2.stats && full2.stats.triggerThreshold));
  // stub 级：直接喂"原始 triggers"（含覆盖率 40 的泛化词），验证构建器自身的阈值过滤（不只依赖 store 的 effectiveTriggers）
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ id: "T-9" + pad2(i), name: "泛化主题" + i, state: "draft", triggers: ["2026"], sentences: 1, chars: 3 });
  for (let i = 0; i < 3; i++) rows.push({ id: "T-8" + pad2(i), name: "稀有主题" + i, state: "draft", triggers: ["图谱稀有词甲"], sentences: 2, chars: 5 });
  const gs = mod.__topicdbGraph(stubStore(rows), { maxNodes: 600, edgeTypes: ["trigger"] });
  const gsTrig = (gs.links || []).filter((l) => l.type === "trigger");
  ok(gsTrig.length === 2 && gsTrig.every((l) => l.via === "图谱稀有词甲"),
    "G11 stub 级：覆盖率 40 的泛化 trigger 不产生边；覆盖率 3 的稀有 trigger 正常连（2 条）", "triggerLinks=" + gsTrig.length + " vias=" + JSON.stringify(gsTrig.map((l) => l.via)));
}

// ── G12 空库 / 单主题不崩 ──
{
  const e = mod.__topicdbGraph(stubStore([]), {});
  ok(e && e.ok === true && e.nodes.length === 0 && e.links.length === 0 && e.stats.nodes === 0 && e.stats.links === 0 && e.stats.truncated === false,
    "G12 空库：nodes=0/links=0 正常返回（不抛错）", JSON.stringify({ ok: e.ok, nodes: e.nodes.length, links: e.links.length }));
  const one = mod.__topicdbGraph(stubStore([{ id: "T-0001", name: "单主题", state: "draft", triggers: ["甲"], sentences: 1, chars: 3 }]), {});
  ok(one && one.ok === true && one.nodes.length === 1 && one.links.length === 0 && one.nodes[0].id === "T-0001" && one.stats.totalNodes === 1,
    "G12 单主题：nodes=1/links=0 正常返回", JSON.stringify({ ok: one.ok, nodes: one.nodes.length, level: one.nodes[0] && one.nodes[0].level }));
  const emptyRoute = graphJson(on.routes, "focus=&depth=&maxNodes=&edgeTypes=");
  ok(emptyRoute.status === 200 && emptyRoute.j && emptyRoute.j.ok === true && emptyRoute.j.nodes.length > 0,
    "G12 空查询串（参数全空）⇒ 回落默认全图，不崩", "nodes=" + (emptyRoute.j && emptyRoute.j.nodes.length));
}

// ── G16/G17/G18 截断策略：结构优先（域/项目线/未归类必须保留，只有明细可裁） ──
{
  const defIds = new Set(g.nodes.map((n) => n.id));
  const fullDomains = full.nodes.filter((n) => n.level === "domain");
  const fullProjects = full.nodes.filter((n) => n.level === "project");
  const fullUnmapped = full.nodes.filter((n) => n.unmapped === true);
  const fullDetails = full.nodes.filter((n) => n.level === "detail" && !n.unmapped);
  // G16：cap=350 时域/项目线一个不少（含 degree=0 的空域 —— 真实库 D6「未归类待判定」场景）
  ok(!!g.stats.kept && g.stats.kept.domains === fullDomains.length && g.stats.kept.projects === fullProjects.length
    && fullDomains.every((n) => defIds.has(n.id)) && fullProjects.every((n) => defIds.has(n.id))
    && g.nodes.filter((n) => n.level === "domain").length === fullDomains.length
    && g.nodes.filter((n) => n.level === "project").length === fullProjects.length,
    "G16 结构优先：cap=350 下域/项目线节点一个不少（" + fullDomains.length + " 域 / " + fullProjects.length + " 项目线，含 degree=0 空域）",
    JSON.stringify({ kept: g.stats.kept, nodesLevel: { domain: g.nodes.filter((n) => n.level === "domain").length, project: g.nodes.filter((n) => n.level === "project").length } }));
  ok(g.nodes.some((n) => n.level === "domain" && n.degree === 0),
    "G16 结构优先：degree=0 的空域节点仍在图里（复现真实库 D6「未归类待判定」）",
    "emptyDomains=" + g.nodes.filter((n) => n.level === "domain" && n.degree === 0).map((n) => n.id + ":" + n.name).join(","));
  // G17：未归类全部保留（保留真实 ID，可直接复制 memory_read；未聚合为虚拟节点）
  ok(!!g.stats.kept && g.stats.kept.unmapped === fullUnmapped.length && fullUnmapped.length > 0
    && fullUnmapped.every((n) => defIds.has(n.id))
    && g.nodes.filter((n) => n.unmapped === true).length === fullUnmapped.length,
    "G17 未归类保留：cap=350 下未归类节点全部在图里（" + fullUnmapped.length + " 条，保留真实 ID 便于 memory_read）",
    JSON.stringify({ keptUnmapped: g.stats.kept && g.stats.kept.unmapped, fullUnmapped: fullUnmapped.length }));
  // G18：kept 四项之和 == nodes.length；truncated ⇔ truncatedDetails>0；truncatedDetails 与 scope 对得上
  const k = g.stats.kept || {};
  const keptSum = Number(k.domains || 0) + Number(k.projects || 0) + Number(k.details || 0) + Number(k.unmapped || 0);
  ok(!!g.stats.scope && g.stats.truncated === (g.stats.truncatedDetails > 0)
    && keptSum === g.nodes.length
    && g.stats.truncatedDetails === (Number(g.stats.scope.details) - Number(k.details))
    && g.stats.truncatedNodes === g.stats.truncatedDetails,
    "G18 截断口径自洽：kept 四项和 == nodes.length，truncated ⇔ truncatedDetails>0，truncatedDetails == scope.details - kept.details",
    JSON.stringify({ keptSum: keptSum, nodes: g.nodes.length, truncated: g.stats.truncated, truncatedDetails: g.stats.truncatedDetails, scope: g.stats.scope, kept: k }));
  ok(full.stats.truncated === false && full.stats.truncatedDetails === 0 && !!full.stats.kept && full.stats.kept.details === fullDetails.length,
    "G18 maxNodes=600（覆盖全库）⇒ 不截断、全部明细保留", JSON.stringify({ truncated: full.stats.truncated, truncatedDetails: full.stats.truncatedDetails, kept: full.stats.kept }));
}

// ── G19/G20 归档口径：默认排除 archived（与面板 main 口径对齐），includeArchived=1 才加入 ──
{
  const counts = store.topicCounts();
  const defArchived = g.nodes.filter((n) => n.state === "archived" || n.archived === true);
  ok(defArchived.length === 0 && g.stats.includeArchived === false && g.stats.excludedArchived === 4,
    "G19 默认排除归档：nodes 中无 state=archived，excludedArchived=4（夹具 2 归档容器 + 2 合并源）",
    JSON.stringify({ archivedInNodes: defArchived.length, includeArchived: g.stats.includeArchived, excludedArchived: g.stats.excludedArchived }));
  ok(g.stats.byLevel.project === counts.main.projects && g.stats.byLevel.domain === counts.main.domains && counts.main.projects === 29,
    "G19 层级口径与面板一致：byLevel.project == stats.json main.projects（29）、domain == main.domains（7）",
    JSON.stringify({ byLevel: g.stats.byLevel, main: counts.main }));
  const inc = graphJson(on.routes, "includeArchived=1&maxNodes=600").j || {};
  const incArchived = inc.nodes.filter((n) => n.archived === true);
  ok(inc.stats.includeArchived === true && inc.stats.excludedArchived === 0 && incArchived.length === 4
    && incArchived.every((n) => n.state === "archived"),
    "G20 includeArchived=1：归档节点出现（4 个）、stats.includeArchived=true、excludedArchived=0",
    JSON.stringify({ includeArchived: inc.stats.includeArchived, excludedArchived: inc.stats.excludedArchived, archivedNodes: incArchived.length, byLevel: inc.stats.byLevel }));
  ok(inc.nodes.length === 422 && inc.stats.byLevel.project === 31 && inc.nodes.some((n) => n.archived && n.level === "project"),
    "G20 含归档全量：422 节点、project=31（29 + 2 归档容器），归档 project 节点在列",
    JSON.stringify({ nodes: inc.nodes.length, byLevel: inc.stats.byLevel }));
  ok(blockHtml.includes('id="tdbg-incl-arch"') && blockHtml.includes("含归档") && !/onclick\s*=/i.test(blockHtml),
    "G20 前端：「含归档」开关存在且无 inline onclick（addEventListener 绑定）");
}

// ───────────────────────── 汇总 ─────────────────────────
console.log("");
console.log("────────────────────────────────────────");
console.log("图谱检查完成：" + pass + " PASS / " + fails.length + " FAIL");
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  - " + f);
} else {
  console.log("夹具：422 总行（7 域 / 29 项目线 / 363 已挂明细 / 21 未归类[20 显式 + 1 合并主主题] / 2 归档容器 + 2 合并源归档），默认图 418 非归档；全量边=" + JSON.stringify((fullGraph && fullGraph.stats.byEdge) || {}));
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败忽略 */ }
// 插件会留定时器/事件监听（真实宿主语义），门跑完后必须主动退出，否则要等 60s 定时器才自然结束
process.exit(fails.length ? 1 : 0);
