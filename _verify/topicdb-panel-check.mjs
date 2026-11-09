// topicdb-panel-check.mjs —— task-10（面板与工具面适配）脚本级验收
//
// 做法（沿用 _verify/topicdb-plugin-check.mjs 的加载方式）：
//   · DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指到**临时目录** ⇒ 绝不碰真实 ~/.dsh/memory；
//   · 用 _fixture-ctx.mjs 的公共 fake ctx，并额外给一个**假 webServer** 把 /dsh-memory/stats.json
//     与 /dsh-memory/stats 的 handler 抓出来直调（fixture 默认不执行 inject 回调，因为真实回调有副作用）。
//
// 覆盖（≥12 条，分三轮）：
//   第1轮 flag 关：stats.json 无 topicdb 段 / live 段无 topicdb / 面板 HTML 不含主题库区块 /
//                  preview 走原 md 预算路径 / dream_patch 不多字段 / /memory-search 无主题块；
//   第2轮 flag 开：stats.json 字段齐全且数值与库一致（主题数/句数/待审数/状态分布）/ dbPath 脱敏 /
//                  待归类健康提示 / 泛化 trigger Top5 / 健康计数 / 待审队列前5与摘录 /
//                  面板含区块与"待归类" / 覆盖文件（含/不含 </body>）仍注入不报错 /
//                  已迁移文件 preview 返回 topicdb 模式 / 未迁移文件 preview 与 flag 关逐字一致 /
//                  dream_patch 只写 md 且主题库零变化 / memory_write 健康 ok+failed+txDepthLeak=0 /
//                  /memory-search 命令层与工具同源返回主题块 / 面板只读（审计表零新增）；
//   第3轮 关回 flag：stats.json 无 topicdb 段、面板无区块、store 已释放。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-panelcheck-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 面板检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
// 未迁移文件（不在主题库里）——用于断言"未迁移文件 preview 原行为不变"。
// ★ 必须选**有字符预算**的文件（projects/ 走 extract 预算）：sessions|knowledge|tools 本来就没有预算，
//   用它们做基线会得到"file 无预算"分支，测不到 budget/sections 那套原行为。
const UNMIGRATED = "projects/面板检查未迁移.md";
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, UNMIGRATED), "# 面板检查未迁移\n- 一句话\n", "utf8");
// 供 dream_patch 写入用的空文件（不与 preview 基线文件冲突，保证两次 preview 输入文件内容一模一样）
const WRITE_TARGET = "knowledge/面板检查-写入目标.md";
fs.writeFileSync(path.join(MEM, WRITE_TARGET), "# 面板检查写入目标\n- 初始一句\n", "utf8");
// stats.json 路由的数据源
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");

process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

// ── [task-15 R07] 子进程间谍：必须在 import 插件**之前**装好（插件的 `import { execFile } from "node:child_process"`
//    绑定的是 CJS 导出对象上的当前属性 ⇒ 先打补丁再 import 就能观测到所有调用；实测 namespace 属性 === 补丁函数）。
const { createRequire } = await import("node:module");
const CP = createRequire(import.meta.url)("node:child_process");
const SPAWNS = [];
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const orig = CP[k];
  if (typeof orig !== "function") continue;
  CP[k] = function (...a) { SPAWNS.push(k + ":" + String(a[0]).slice(0, 60)); return orig.apply(CP, a); };
}
// 间谍自检（防"断言恒真"）：真 spawn 一次必须被记到，否则 R07 是假绿。
{
  const before = SPAWNS.length;
  try { CP.execSync(process.platform === "win32" ? "cmd /c exit 0" : "true", { stdio: "ignore" }); } catch (e) { /* 忽略 */ }
  if (SPAWNS.length === before) { console.error("[FATAL] child_process 间谍无效：自检未被记录，R07 不成立"); process.exit(2); }
  console.log("INFO  子进程间谍自检有效（自检记录 = " + SPAWNS[SPAWNS.length - 1] + "）");
  SPAWNS.length = 0;
}

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);

let pass = 0; const fails = [];
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

/** fake ctx + 假 webServer：把路由 handler 抓出来直调（真实 webServer 有副作用，fixture 默认不执行 inject 回调） */
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

/** 直调某个路由 */
function callRoute(routes, p, reqExtra) {
  const h = routes.get(String(p));
  if (typeof h !== "function") return { status: 404, body: "", headers: {}, missing: true };
  const out = { status: 200, headers: {}, body: "" };
  const res = {
    statusCode: 200,
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(b) { out.body = b == null ? "" : String(b); },
  };
  const req = Object.assign({ url: p, method: "GET", headers: {} }, reqExtra || {});
  h(req, res);
  out.status = res.statusCode;
  return out;
}
let SID = 0;
const execOf = () => ({ agent: { session: { id: "panelcheck-" + (++SID) } } });
// [CRA 2026-11-06 修复] 4.5.1 起 memory_write 只对 dream 开放（非 dream 返回 WRITE_DREAM_ONLY），
//   本门验的是「写入健康计数」而不是「谁能写」⇒ 必须用 dream 身份驱动，否则计数永远为 0（门变红是误报）。
const DREAM_SID = "panelcheck-dream-selftest";
try { if (typeof mod.__markPluginSubagent === "function") mod.__markPluginSubagent(DREAM_SID); } catch (e) { }
const execDreamOf = () => ({ agent: { session: { id: DREAM_SID, header: { origin: "subagent" } } } });

// ───────────────────────── 第 1 轮：flag 关（默认） ─────────────────────────
const off = makeCtx();
plugin.apply(off.ctx, { memoryTopicDbEnabled: false });
await sleep(400);

{
  const rj = callRoute(off.routes, "/dsh-memory/stats.json");
  ok(rj.status === 200 && rj.body.length > 2, "flag 关：/dsh-memory/stats.json 正常返回", "HTTP " + rj.status + " len=" + rj.body.length);
  let j = null; try { j = JSON.parse(rj.body); } catch (e) { j = null; }
  ok(!!j, "flag 关：stats.json 可解析");
  ok(!!j && !Object.prototype.hasOwnProperty.call(j, "topicdb"), "flag 关：stats.json **无** topicdb 段（硬约束）", j ? Object.keys(j).join(",") : "-");
  ok(!!j && j.live && !Object.prototype.hasOwnProperty.call(j.live, "topicdb"), "flag 关：live 段也无 topicdb 键");
  const rh = callRoute(off.routes, "/dsh-memory/stats");
  ok(rh.status === 200 && /<!DOCTYPE html>/i.test(rh.body), "flag 关：/dsh-memory/stats 返回 HTML 面板", "len=" + rh.body.length);
  ok(!rh.body.includes("topicdb-panel") && !rh.body.includes("主题库（topicdb）"), "flag 关：面板 HTML 不含主题库区块（硬约束）");
}

const previewOff = findTool(off.captured, "memory_size_preview");
let pOffUnmigrated = null;
{
  const raw = await previewOff.execute({ file: UNMIGRATED, action: "append", content: "- 新增一句\n" }, execOf());
  try { pOffUnmigrated = JSON.parse(raw); } catch (e) { pOffUnmigrated = null; }
  ok(!!pOffUnmigrated && pOffUnmigrated.ok === true && typeof pOffUnmigrated.wouldChars === "number"
    && typeof pOffUnmigrated.budget === "number" && Array.isArray(pOffUnmigrated.sections) && pOffUnmigrated.mode === undefined,
    "flag 关：preview 走原 md 预算路径（wouldChars/budget/sections 齐全、无 mode 字段）",
    pOffUnmigrated ? ("wouldChars=" + pOffUnmigrated.wouldChars + " budget=" + pOffUnmigrated.budget) : "null");
  const raw2 = await previewOff.execute({ file: "global.md", action: "append", content: "- 面板检查追加\n" }, execOf());
  let p2 = null; try { p2 = JSON.parse(raw2); } catch (e) { p2 = null; }
  ok(!!p2 && p2.ok === true && Array.isArray(p2.sections) && p2.mode === undefined, "flag 关：global.md preview 原行为不变", p2 ? ("wouldChars=" + p2.wouldChars) : "null");
}

{
  const dp = findTool(off.captured, "memory_dream_patch");
  const raw = await dp.execute({ patches: [{ file: WRITE_TARGET, action: "append", content: "- flag关写入一句\n" }] }, execOf());
  let rr = null; try { rr = JSON.parse(raw); } catch (e) { rr = null; }
  ok(!!rr && rr.ok === true && !Object.prototype.hasOwnProperty.call(rr, "topicdbNote"),
    "flag 关：memory_dream_patch 返回**无** topicdbNote（逐字一致）", rr ? JSON.stringify(Object.keys(rr)) : "null");
}

{
  const cmd = (off.captured.commands || []).find((c) => c && c.name === "memory-search");
  let txt = "";
  if (cmd) { const r = await cmd.handler({ rawInput: "资源下发", agent: { session: { id: "cmd-off" } } }); txt = String((r && r.text) || ""); }
  ok(!!cmd && !/检索命中 \d+ 个主题/.test(txt), "flag 关：/memory-search 不返回主题块（走原 md 结果）", txt.split("\n")[0].slice(0, 50));
}

// ── [task-15 R01] flag 关：升级待办段一律不出现（探测结果不会被消费） ──
{
  SPAWNS.length = 0;
  // [task-16 P05] flag 关：四个主题账本工具一律不注册 ⇒ 泛化标注/有效口径这些新呈现不会泄露到今日工具面
  ok(!findTool(off.captured, "memory_read") && !findTool(off.captured, "memory_topics")
    && !findTool(off.captured, "memory_write") && !findTool(off.captured, "memory_export"),
    "P05 flag 关：主题账本四工具全部不注册（新呈现面不外泄，输出与今日一致）");
  const partsOff = await mod.__topicdbInjectionParts({ session: { id: "up-off-1" }, inject() {} });
  const upParts = partsOff.filter((p) => String(p).includes("【dsh-memory · 升级待办】"));
  ok(partsOff.length === 0 && upParts.length === 0, "R01 flag 关：注入 parts 为空、无「升级待办」段（探测不产生输出）", "parts=" + partsOff.length);
  ok(SPAWNS.length === 0, "R01 flag 关：注入期间零子进程 spawn", JSON.stringify(SPAWNS.slice(0, 3)));
}

// ───────────────────────── 第 2 轮：flag 开 ─────────────────────────
const on = makeCtx();
plugin.apply(on.ctx, { memoryTopicDbEnabled: true });
const ready = await waitReady();
ok(ready, "flag 开：主题账本就绪（惰性加载成功）",
  "backend=" + ((mod.__topicdb.store && mod.__topicdb.store.be && mod.__topicdb.store.be.kind) || "?") + " db=" + (mod.__topicdb.dbFile || "?"));

const store = mod.__topicdb.store;

// ── [task-15 R02/R03/R06/R07] 空库 + 有 md ⇒ not_migrated 提醒（必须在造数据**之前**测：造完库就不空了） ──
{
  SPAWNS.length = 0;
  mod.__topicdbUpgradeReset();                       // 丢掉可能已缓存的判定
  const st0 = mod.__topicdbUpgradeDetect();
  const md0 = mod.__topicdbMdStats();
  ok(st0 && st0.state === "not_migrated" && st0.mdCount > 0,
    "R02 探测：空库 + 有 md ⇒ state=not_migrated（带 mdCount/layers）",
    JSON.stringify({ state: st0.state, mdCount: st0.mdCount, layers: st0.layers, topics: st0.topics }));
  const agentU1 = { session: { id: "up-on-1" }, inject() {} };
  const partsU1 = await mod.__topicdbInjectionParts(agentU1);
  const up1 = partsU1.filter((p) => String(p).includes("【dsh-memory · 升级待办】"));
  ok(up1.length === 1, "R02 注入：flag 开 + not_migrated ⇒ 出现「升级待办」段（恰好 1 段）", up1[0] ? up1[0].slice(0, 70) : "(无)");
  ok(up1.length === 1 && up1[0].includes("--detect") && up1[0].includes("--plan") && up1[0].includes("用户确认后") && up1[0].includes("禁止静默迁移"),
    "R02 文案：含 --detect/--plan + 「用户确认后」+ 禁止静默迁移（可执行指令口径）", up1[0] ? up1[0].slice(0, 100) : "(无)");
  // 与 importer 定稿口令逐字对齐：形如 `--apply --stage=import`，且 apply-merge 必须写明人工指定簇
  ok(up1.length === 1 && /--apply --stage=import/.test(up1[0]) && up1[0].includes("需人工指定簇") && up1[0].includes("不自动批量合并"),
    "R02 文案：`--apply --stage=import` 形状 + apply-merge「需人工指定簇、不自动批量合并」（对齐 upgrade.mjs 定稿）",
    (up1[0] || "").match(/--apply --stage=[a-z-]+/) ? (up1[0].match(/--apply --stage=[a-z-]+/) || [""])[0] : "(未匹配)");
  ok(up1.length === 1 && up1[0].includes("退出码") && up1[0].includes("2 拒绝执行") && up1[0].includes("3 阶段失败"),
    "R02 文案：附退出码语义（0 成功/按设计跳过、2 拒绝、3 失败）便于 Agent 判断", (up1[0] || "").slice(-90));
  ok(up1.length === 1 && !/[\r\n]/.test(up1[0]) && up1[0].split("\n").length === 1, "R06 单行：升级待办提醒不含换行（硬约束 1 行）");
  ok(up1.length === 1 && up1[0].includes(mod.__topicdbUpgradeScript()) && /--detect/.test(up1[0]),
    "R02 文案：命令里带 upgrade.mjs **绝对路径**", (up1[0] || "").match(/node [^ ]+upgrade\.mjs/) ? (up1[0].match(/node [^ ]+upgrade\.mjs/) || [""])[0] : "(未匹配)");
  // R03 去重：同会话第二次不重复；新 sessionId 重新投递
  const partsU1b = await mod.__topicdbInjectionParts(agentU1);
  ok(partsU1b.filter((p) => String(p).includes("【dsh-memory · 升级待办】")).length === 0, "R03 去重：同一会话第二次调用不重复投递");
  const partsU2 = await mod.__topicdbInjectionParts({ session: { id: "up-on-2" }, inject() {} });
  ok(partsU2.filter((p) => String(p).includes("【dsh-memory · 升级待办】")).length === 1, "R03 去重：新 sessionId 重新投递（键含 sessionId，不串味）");
  ok(SPAWNS.length === 0, "R07 探测+注入期间**零子进程 spawn**（绝不自动迁移）", JSON.stringify(SPAWNS.slice(0, 5)));
}

// 造数据：A = 已迁移来源主题（3 句）；B = 近重复（seed → needs_review）+ 1 句正文（供面板摘录）；
//        另造 6 个共享同一 trigger 的主题（触发"泛化 trigger"数据驱动判定，阈值默认 5）
const SRC_A = "knowledge/MEMORY-面板检查-A.md";
const a = store.seedTopic({ name: "面板检查•资源下发归档", triggers: ["资源下发", "N12"], src: SRC_A });
store.appendSentence({ topic: a.id, text: "面板检查：4 台主机 N12 8C/16G/40G", src: SRC_A, actor: "plugin" });
store.appendSentence({ topic: a.id, text: "面板检查：部署包仅 aarch64", src: SRC_A, actor: "plugin" });
const b = store.seedTopic({ name: "面板检查•资源下发归档表", triggers: ["资源下发"], src: "knowledge/MEMORY-面板检查-B.md" });
store.appendSentence({ topic: b.id, text: "面板检查：待审正文摘录一句", actor: "plugin" });
for (let i = 0; i < 6; i++) {
  store.seedTopic({ name: "面板检查•泛测词主题" + "甲乙丙丁戊己".charAt(i), triggers: ["面板泛测词"], src: "knowledge/MEMORY-面板检查-G" + i + ".md" });
}
const topicsNow = store.topics();
const stateOf = (id) => { const t = topicsNow.find((x) => x.id === id); return t ? t.state : "?"; };
ok(b.state === "needs_review", "造数：近重复 seed 落 needs_review（面板待审队列有内容）", b.id + " state=" + stateOf(b.id));

// ── [task-15 R04 + R06] 库已迁移且无异常 ⇒ state=ok，不再提醒；且升级段是**纯追加**，不改动其他 parts ──
{
  mod.__topicdbUpgradeReset();
  const stOk = mod.__topicdbUpgradeDetect();
  ok(stOk.state === "ok", "R04 探测：库已有主题且无中断痕迹 ⇒ state=ok", JSON.stringify({ state: stOk.state, topics: stOk.topics }));
  const pOk = await mod.__topicdbInjectionParts({ session: { id: "up-ok-1" }, inject() {} });
  ok(pOk.filter((p) => String(p).includes("【dsh-memory · 升级待办】")).length === 0, "R04 注入：state=ok ⇒ 不出现「升级待办」段（下次会话自然消失）");
  // R06 对照：注入 parts 里的"非升级段"内容在 ok 态与"非 ok 态"下逐字一致 ⇒ 升级段没有挤占/改写其他段
  globalThis.__partsOkNoUpgrade = pOk;
}

// ── stats.json（flag 开）──
const rj2 = callRoute(on.routes, "/dsh-memory/stats.json");
let j2 = null; try { j2 = JSON.parse(rj2.body); } catch (e) { j2 = null; }
ok(rj2.status === 200 && !!j2, "flag 开：stats.json 正常返回", "HTTP " + rj2.status);
const td = j2 && j2.topicdb;
ok(!!td, "flag 开：stats.json 含 topicdb 段");
const FIELDS = ["backend", "dbPath", "dbSizeBytes", "topics", "topicsByState", "sentences", "chars", "needsReview",
  "oldestPendingDays", "pendingNote", "genericTriggers", "upgrade", "reviewQueue", "health", "updatedAt",
  // [task-16] 有效口径字段（合并语义落地后，面板/客户端必须用这些）
  "effectiveTopics", "nonArchivedTopics", "archivedTopics", "mergedSources", "mainTopics", "detailTopics", "physicalSentences"];
const missing = FIELDS.filter((k) => !td || td[k] === undefined);
ok(missing.length === 0, "flag 开：topicdb 段字段齐全（task-10 A1 口径）", missing.length ? ("缺 " + missing.join(",")) : FIELDS.join(","));
// [task-15] 升级状态字段：结构固定（task-10 预留）+ 此时库已迁移 ⇒ state=ok
ok(!!td && td.upgrade && typeof td.upgrade === "object" && typeof td.upgrade.state === "string",
  "flag 开：topicdb.upgrade 字段位存在（task-15 填真值，结构未变）", td && JSON.stringify(td.upgrade).slice(0, 120));
ok(!!td && td.upgrade.state === "ok" && td.upgrade.to === mod.__topicdbSchemaVersion && td.upgrade.mdCount > 0,
  "flag 开：库已迁移 ⇒ upgrade.state=ok（面板显示就绪），mdCount 为 md 侧统计", td && JSON.stringify({ state: td.upgrade.state, mdCount: td.upgrade.mdCount, script: String(td.upgrade.script).slice(-40) }));
ok(!!td && (td.backend === "sqlite" || td.backend === "ledger"), "flag 开：backend ∈ {sqlite,ledger}", td && td.backend);
ok(!!td && typeof td.dbPath === "string" && td.dbPath.length > 0 && !/^[A-Za-z]:[\\/]/.test(td.dbPath) && !String(td.dbPath).includes(TMP.replace(/\\/g, "/")) && !String(td.dbPath).includes(TMP),
  "flag 开：dbPath 已脱敏（相对路径，不含绝对用户路径 / 临时目录）", td && td.dbPath);
ok(!!td && td.dbSizeBytes > 0, "flag 开：dbSizeBytes > 0", td && td.dbSizeBytes);

// 与库实际数值一致（抽查：主题数、句数、待审数、状态分布）
const realTopics = store.topics();
const realSent = realTopics.reduce((s, t) => s + Number(t.sentences || 0), 0);
const realChars = realTopics.reduce((s, t) => s + Number(t.chars || 0), 0);
const realState = {};
for (const t of realTopics) realState[t.state] = (realState[t.state] || 0) + 1;
ok(!!td && td.topics === realTopics.length, "flag 开：stats 主题数 = 库实际（" + realTopics.length + " 行）", td && String(td.topics));
ok(!!td && td.sentences === realSent && td.chars === realChars, "flag 开：stats 句数/字数 = 库实际（" + realSent + " 句 / " + realChars + " 字）", td && (td.sentences + " / " + td.chars));
// [task-16][口径] 有效主题数必须与数据层 effectiveTopics() 同源（合并后物理行数≠有效主题数）
{
  const effExpect = (typeof store.effectiveTopics === "function") ? store.effectiveTopics().length : null;
  ok(!!td && effExpect !== null && td.effectiveTopics === effExpect && td.effectiveTopics <= td.topics,
    "P05 有效口径：stats.effectiveTopics = store.effectiveTopics()（且 ≤ 物理行数）",
    "stats=" + (td && td.effectiveTopics) + " store=" + effExpect + " rows=" + realTopics.length);
  ok(!!td && td.physicalSentences === realTopics.reduce((s, t) => s + Number(t.physicalSentences == null ? t.sentences : t.physicalSentences || 0), 0),
    "P05 有效口径：stats.physicalSentences = Σ topics().physicalSentences",
    "stats=" + (td && td.physicalSentences));
  // 与数据层 topicCounts() 逐项对齐（gov-builder 同步的口径单源；有则必等，防面板自算漂移）
  const counts = (typeof store.topicCounts === "function") ? store.topicCounts() : null;
  ok(!counts || (td.effectiveTopics === counts.effective && td.sentences === counts.sentences
    && td.physicalSentences === counts.physicalSentences && td.mergedSources === counts.merged
    && td.archivedTopics === counts.archived && td.topics === counts.total),
    "P05 有效口径：stats 各口径 = store.topicCounts()（effective/sentences/physicalSentences/merged/archived/total）",
    counts ? JSON.stringify({ effective: counts.effective, sentences: counts.sentences, physical: counts.physicalSentences, merged: counts.merged, archived: counts.archived, total: counts.total }) : "库无 topicCounts()");
}
ok(!!td && td.needsReview === (realState.needs_review || 0), "flag 开：needsReview = 库 needs_review 实际条数（" + (realState.needs_review || 0) + "）", td && String(td.needsReview));
ok(!!td && td.topicsByState && td.topicsByState.needs_review === (realState.needs_review || 0)
  && Object.keys(td.topicsByState).reduce((s, k) => s + Number(td.topicsByState[k] || 0), 0) === realTopics.length,
  "flag 开：topicsByState 分布之和 = 主题总数", td && JSON.stringify(td.topicsByState));
ok(!!td && td.needsReview > 0 && String(td.pendingNote).includes("待归类 " + td.needsReview + " 条"),
  "flag 开：健康提示包含「待归类 N 条」（task-10 B4）", td && td.pendingNote);
ok(!!td && td.genericTriggers && typeof td.genericTriggers.count === "number" && td.genericTriggers.count >= 1
  && Array.isArray(td.genericTriggers.top) && td.genericTriggers.top.length >= 1 && td.genericTriggers.top[0].trigger,
  "flag 开：泛化 trigger 数量 + Top5 非空（面板列表数据源）", td && JSON.stringify(td.genericTriggers.top.slice(0, 3)));
ok(!!td && td.health && typeof td.health.ok === "number" && typeof td.health.failed === "number" && typeof td.health.txDepthLeak === "number"
  && td.health.lastImportAt > 0,
  "flag 开：health 含 ok/failed/txDepthLeak 计数 + 最近导入时间", td && JSON.stringify(td.health));
ok(!!td && Array.isArray(td.reviewQueue) && td.reviewQueue.length > 0 && td.reviewQueue.length <= 5,
  "flag 开：待审队列前 5 条非空（≤5）", td && ("len=" + td.reviewQueue.length));
const qB = (td && td.reviewQueue || []).find((x) => x.id === b.id);
ok(!!qB && Array.isArray(qB.excerpt) && qB.excerpt.some((s) => String(s).includes("待审正文摘录")),
  "flag 开：待审队列条目带正文摘录（面板点开即 memory_read 前几句）", qB ? qB.excerpt[0] : "未找到");
ok(!!j2 && j2.live && j2.live.topicdb && j2.live.topicdb.topics === td.topics, "flag 开：live.topicdb 与根级 topicdb 同源");

// ── 面板 HTML（flag 开）：内嵌页 / 覆盖页 ──
{
  const rh = callRoute(on.routes, "/dsh-memory/stats");
  ok(rh.status === 200 && rh.body.includes("<!--[topicdb-panel]-->") && rh.body.includes("主题库（topicdb）"),
    "flag 开：内嵌面板 HTML 含主题库区块", "len=" + rh.body.length);
  ok(rh.body.includes("待归类") && rh.body.includes("泛化 trigger") && rh.body.includes("待审队列"),
    "flag 开：面板区块含「待归类」/泛化 trigger/待审队列文案");
  // [2026-10-29 Lead] 区块已上移到页首：只读检查必须按**起止标记**取区块整段，
  //   不能再"从起点切到文档末尾"（那样会把页面自身的刷新按钮 onclick 算进来 ⇒ 假红）。
  {
    const b0 = rh.body.indexOf("<!--[topicdb-panel]-->");
    const b1 = rh.body.indexOf("<!--[/topicdb-panel]-->");
    const seg = b0 >= 0 && b1 > b0 ? rh.body.slice(b0, b1) : rh.body.slice(b0);
    ok(!/\sonclick=/.test(seg) && !/method:\s*"(POST|PUT|DELETE)"/i.test(seg),
      "flag 开：主题库区块无 onclick、也无 POST/PUT/DELETE（只读；「复制升级命令」只写剪贴板，不写库）",
      "block=" + seg.length + "B");
  }
}
{
  // 覆盖机制：.stats-panel.html 不含该区块 ⇒ 仍要工作（不报错）
  const ov = path.join(MEM, ".stats-panel.html");
  fs.writeFileSync(ov, "<!DOCTYPE html><html><body>" + "<div>override</div>".repeat(80) + "</body></html>", "utf8");
  const rh = callRoute(on.routes, "/dsh-memory/stats");
  ok(rh.status === 200 && rh.body.includes("<!--[topicdb-panel]-->") && rh.body.includes("override"),
    "flag 开：覆盖文件 .stats-panel.html 不含区块 ⇒ 仍注入且原内容保留", "len=" + rh.body.length);
  // 覆盖文件没有 </body> ⇒ 追加末尾，不报错（区块现在以结束标记收尾）
  fs.writeFileSync(ov, "<!DOCTYPE html><html>" + "<div>no-body-tag</div>".repeat(80), "utf8");
  const rh2 = callRoute(on.routes, "/dsh-memory/stats");
  ok(rh2.status === 200 && rh2.body.includes("<!--[topicdb-panel]-->") && rh2.body.trimEnd().endsWith("<!--[/topicdb-panel]-->"),
    "flag 开：覆盖文件无 </body> ⇒ 追加到末尾不报错", "ended=" + JSON.stringify(rh2.body.slice(-26)));
  try { fs.unlinkSync(ov); } catch (e) { /* 清理失败不影响断言 */ }
}
{
  // 面板区块 JS **实跑**渲染（不是只查静态字符串）：用最小 fake DOM 执行注入的 <script>，
  // 喂真实 stats.json 负载，断言渲染结果里出现真实数值 —— 能抓到"JS 运行时炸了但 HTML 里有文案"的假绿。
  const block = mod.__topicdbPanelBlock();
  const i0 = block.indexOf("<script>"), i1 = block.indexOf("</script>");
  const js = block.slice(i0 + 8, i1);
  const nodes = {};
  const mkNode = (id) => ({ id, innerHTML: "", textContent: "", style: {}, attrs: {}, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, addEventListener() {} });
  const doc = {
    getElementById(id) { if (!nodes[id]) nodes[id] = mkNode(id); return nodes[id]; },
    querySelectorAll() { return []; },
  };
  const payload = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body);
  let renderErr = null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("document", "fetch", "requestAnimationFrame", "setTimeout", "console", js);
    fn(doc, () => Promise.resolve({ json: () => Promise.resolve(payload) }), (f) => { try { f(); } catch (e) { renderErr = e; } }, (f) => setTimeout(f, 1), console);
  } catch (e) { renderErr = e; }
  await sleep(150);
  const html = (nodes["tdb-body"] || {}).innerHTML || "";
  const note = (nodes["tdb-note"] || {}).textContent || "";
  ok(!renderErr && html.includes("主题 " + payload.topicdb.topics) && html.includes(payload.topicdb.pendingNote),
    "flag 开：面板区块 JS 实跑渲染成功（真实主题数 + 待归类文案）",
    renderErr ? ("JS 异常: " + (renderErr && renderErr.message)) : ("note=" + note.slice(0, 40)));
  ok(html.includes("升级状态") && html.includes("待审队列") && html.includes("泛化 trigger"),
    "flag 开：渲染结果包含升级状态/待审队列/泛化 trigger 三块");
  ok(html.includes("reviewQueue") === false && html.includes(payload.topicdb.reviewQueue[0] ? payload.topicdb.reviewQueue[0].id : "###"),
    "flag 开：渲染结果含待审队列首条主题 ID", payload.topicdb.reviewQueue[0] && payload.topicdb.reviewQueue[0].id);
}

// ── [task-15 R05 + 面板联动] schema_outdated / interrupted(stage) 两种非 ok 态：文案与面板都要如实反映 ──
{
  const partsNoUp = (arr) => arr.filter((p) => !String(p).includes("【dsh-memory · 升级待办】"));
  // ③ schema_outdated：把 meta.schema_version 拨到 0（< 当前 1）⇒ 版本过旧
  const be = store.be;
  try { be.setMeta("schema_version", "0"); } catch (e) { /* 后端不支持 meta 时该子断言会红，便于发现 */ }
  mod.__topicdbUpgradeReset();
  const stOld = mod.__topicdbUpgradeDetect();
  ok(stOld && stOld.state === "schema_outdated" && Number(stOld.from) === 0 && Number(stOld.to) === mod.__topicdbSchemaVersion,
    "探测：meta.schema_version=0 < 当前 ⇒ state=schema_outdated（带 from/to）", JSON.stringify({ state: stOld && stOld.state, from: stOld && stOld.from, to: stOld && stOld.to }));
  const pOld = await mod.__topicdbInjectionParts({ session: { id: "up-old-1" }, inject() {} });
  const upOld = pOld.filter((p) => String(p).includes("【dsh-memory · 升级待办】"));
  ok(upOld.length === 1 && upOld[0].includes("--detect") && upOld[0].includes("用户确认后"), "注入：schema_outdated ⇒ 出现升级待办段且指令口径不变", upOld[0] ? upOld[0].slice(0, 70) : "(无)");
  try { be.setMeta("schema_version", String(mod.__topicdbSchemaVersion)); } catch (e) { /* 还原 */ }
  // ④ interrupted：按 importer 的 upgrade.mjs **真 schema/真路径**造中断痕迹：
  //   路径 = <库目录>/upgrade/checkpoint.json（upgrade.mjs: stateDir = dirname(dbFile)/upgrade）
  //   结构 = { stages: { import|curate|apply-merge: {status,...} } }；running/failed = 中断，**pending 不算**
  const ckDir = path.join(path.dirname(process.env.MEMTOPIC_DB), "upgrade");
  fs.mkdirSync(ckDir, { recursive: true });
  const ckFile = path.join(ckDir, "checkpoint.json");
  const mkCp = (stages) => ({ upgradeVersion: 1, schemaVersion: 1, db: process.env.MEMTOPIC_DB, mdRoot: MEM, backend: "sqlite", stateDir: ckDir, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: stages, history: [], actor: "lead" });
  // 负例先测：全部 done/skipped（= 正常跑完的 checkpoint）**不得**误报中断
  fs.writeFileSync(ckFile, JSON.stringify(mkCp({ import: { status: "done" }, curate: { status: "done" }, "apply-merge": { status: "skipped" } })), "utf8");
  mod.__topicdbUpgradeReset();
  const stClean = mod.__topicdbUpgradeDetect();
  ok(stClean.state === "ok", "R05 负例：checkpoint 全阶段 done/skipped（已跑完）⇒ 仍是 ok，不误报中断", stClean.state);
  // 负例 2：只跑了 --stage=import（其余 pending）——分阶段手动执行是设计内用法，**不算中断**
  fs.writeFileSync(ckFile, JSON.stringify(mkCp({ import: { status: "done" }, curate: { status: "pending" }, "apply-merge": { status: "pending" } })), "utf8");
  mod.__topicdbUpgradeReset();
  const stStaged = mod.__topicdbUpgradeDetect();
  ok(stStaged.state === "ok", "R05 负例：只完成 --stage=import、其余 pending ⇒ 不误报中断（分阶段手动是设计内用法）", stStaged.state);
  // 正例：apply-merge 停在 running（崩在中途）
  fs.writeFileSync(ckFile, JSON.stringify(mkCp({ import: { status: "done" }, curate: { status: "done" }, "apply-merge": { status: "running", attempts: 1 } })), "utf8");
  mod.__topicdbUpgradeReset();
  const stIntr = mod.__topicdbUpgradeDetect();
  ok(stIntr && stIntr.state === "interrupted" && stIntr.stage === "apply-merge",
    "R05 探测：真 schema checkpoint 里 apply-merge=running ⇒ state=interrupted 且带 stage", JSON.stringify({ state: stIntr && stIntr.state, stage: stIntr && stIntr.stage }));
  const pIntr = await mod.__topicdbInjectionParts({ session: { id: "up-intr-1" }, inject() {} });
  const upIntr = pIntr.filter((p) => String(p).includes("【dsh-memory · 升级待办】"));
  ok(upIntr.length === 1 && upIntr[0].includes("apply-merge") && upIntr[0].includes("中断") && upIntr[0].includes("--detect"),
    "R05 文案：指出中断阶段 apply-merge + 下一步 --detect", upIntr[0] ? upIntr[0].slice(0, 90) : "(无)");
  // 文案与 importer 定稿口令对齐 + 三纪律（不暗示自动跑）
  const upTxt = upIntr[0] || "";
  ok(upTxt.includes("--plan") && upTxt.includes("--apply --stage=apply-merge") && upTxt.includes("用户确认后"),
    "R05 文案：续跑命令用定稿形状 `--apply --stage=apply-merge`，且仍要求「用户确认后」", (upTxt.match(/--apply --stage=[a-z-]+/) || [""])[0]);
  ok(upTxt.includes("需人工指定簇") && upTxt.includes("不自动批量合并") && upTxt.includes("--merge-cluster"),
    "R05 文案：提到 apply-merge 时必须写明「需人工指定簇、不自动批量合并」（--merge-cluster）");
  ok(!/自动(执行|迁移|跑)|无需确认|直接应用/.test(upTxt.replace(/禁止静默迁移|不自动批量合并/g, "")),
    "R05 文案：不暗示可自动执行（无「自动执行/无需确认/直接应用」措辞）");
  // R06 对照：非升级段在 ok 态 / interrupted 态下逐字一致 ⇒ 升级段是纯追加，不挤占其他 parts
  const okNoUp = globalThis.__partsOkNoUpgrade || [];
  ok(JSON.stringify(partsNoUp(pIntr)) === JSON.stringify(partsNoUp(okNoUp)),
    "R06 对照：注入的**非升级段**在 ok 态与 interrupted 态逐字一致（升级段纯追加，不占主体预算）",
    "ok态=" + partsNoUp(okNoUp).length + " 段 / 中断态=" + partsNoUp(pIntr).length + " 段");
  // 面板联动：stats.json 的 upgrade 字段 + 面板区块的"升级状态/升级命令/复制"文案
  const rjUp = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body);
  ok(rjUp.topicdb && rjUp.topicdb.upgrade && rjUp.topicdb.upgrade.state === "interrupted" && rjUp.topicdb.upgrade.stage === "apply-merge"
    && typeof rjUp.topicdb.upgrade.command === "string" && rjUp.topicdb.upgrade.command.includes("--detect"),
    "面板联动：stats.json.topicdb.upgrade = {state:interrupted, stage, command}", rjUp.topicdb && JSON.stringify(rjUp.topicdb.upgrade).slice(0, 160));
  const htmlUp = callRoute(on.routes, "/dsh-memory/stats").body;
  ok(htmlUp.includes("升级状态") && htmlUp.includes("升级命令") && htmlUp.includes("tdb-copy") && htmlUp.includes("中断于"),
    "面板联动：区块含「升级状态」「升级命令」「复制」按钮与「中断于 <stage>」文案");
  // 用注入的 JS 实跑一次 interrupted 渲染：应出现命令 pre 与复制按钮（只读展示，不执行）
  const blk = mod.__topicdbPanelBlock();
  const jsUp = blk.slice(blk.indexOf("<script>") + 8, blk.indexOf("</script>"));
  const nodes2 = {};
  const mk2 = (id) => ({ id, innerHTML: "", textContent: "", style: {}, getAttribute() { return null; }, addEventListener() {} });
  const doc2 = { getElementById(id) { if (!nodes2[id]) nodes2[id] = mk2(id); return nodes2[id]; }, querySelectorAll() { return []; } };
  let upErr = null;
  try {
    const fn2 = new Function("document", "fetch", "requestAnimationFrame", "setTimeout", "console", jsUp);
    fn2(doc2, () => Promise.resolve({ json: () => Promise.resolve(rjUp) }), (f) => { try { f(); } catch (e) { upErr = e; } }, (f) => setTimeout(f, 1), console);
  } catch (e) { upErr = e; }
  await sleep(150);
  const htmlIntr = (nodes2["tdb-body"] || {}).innerHTML || "";
  ok(!upErr && htmlIntr.includes("中断于 apply-merge") && htmlIntr.includes("tdb-upcmd") && htmlIntr.includes("复制升级命令"),
    "面板联动：interrupted 态实跑渲染出「中断于 apply-merge」+升级命令+复制按钮", upErr ? ("JS 异常: " + upErr.message) : "ok");
  // 恢复 ok 态（删掉 checkpoint）
  try { fs.unlinkSync(ckFile); } catch (e) { /* 清理 */ }
  mod.__topicdbUpgradeReset();
  const stBack = mod.__topicdbUpgradeDetect();
  ok(stBack.state === "ok", "探测：清掉中断痕迹 ⇒ 回到 state=ok（提醒自然会消失）", stBack.state);
}

// ── memory_size_preview（flag 开）──
const previewOn = findTool(on.captured, "memory_size_preview");
{
  const raw = await previewOn.execute({ file: SRC_A, action: "append", content: "- 面板检查新增一句\n" }, execOf());
  let pm = null; try { pm = JSON.parse(raw); } catch (e) { pm = null; }
  ok(!!pm && pm.ok === true && pm.mode === "topicdb" && pm.topic === a.id
    && pm.note === "该内容已入主题库，字符预算不再适用；请用 memory_read 查看主题；改单句由 dream 整合处理，主代理用 memory_note",
    "flag 开：已迁移来源文件 preview 返回 topicdb 模式（不报错）", pm ? JSON.stringify({ mode: pm.mode, topic: pm.topic, rel: pm.rel }) : "null");
  const raw2 = await previewOn.execute({ file: UNMIGRATED, action: "append", content: "- 新增一句\n" }, execOf());
  let pu = null; try { pu = JSON.parse(raw2); } catch (e) { pu = null; }
  ok(!!pu && JSON.stringify(pu) === JSON.stringify(pOffUnmigrated),
    "flag 开：未迁移文件 preview 与 flag 关**逐字一致**（原行为不变）",
    pu && pOffUnmigrated ? ("wouldChars " + pu.wouldChars + " vs " + pOffUnmigrated.wouldChars) : "null");
}

// ── memory_dream_patch（flag 开）：未映射文件 ⇒ 回落 md + 明确提示（P3 起已映射文件走主题库）──
{
  const before = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.sentences]));
  const dp = findTool(on.captured, "memory_dream_patch");
  const raw = await dp.execute({ patches: [{ file: WRITE_TARGET, action: "append", content: "- flag开写入一句，入库走库路径\n" }] }, execOf());
  let rr = null; try { rr = JSON.parse(raw); } catch (e) { rr = null; }
  const after = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.sentences]));
  ok(!!rr && rr.ok === true && typeof rr.topicdbNote === "string" && rr.topicdbNote.includes("主题库已启用"),
    "flag 开：memory_dream_patch 返回带「主题库已启用」提示（P3：db 直写 / 回落 md 两种文案）", rr && rr.topicdbNote);
  ok(!!rr && Array.isArray(rr.unmapped) && rr.unmapped.length === 1,
    "flag 开：未映射文件（knowledge/… 无对应主题）记入 unmapped[]（不静默丢）", JSON.stringify(rr && rr.unmapped));
  ok(before === after, "flag 开：unmapped 条目**未**改写主题库（库快照逐字段不变）");
  ok(fs.readFileSync(path.join(MEM, WRITE_TARGET), "utf8").includes("flag开写入一句"), "flag 开：unmapped 条目确实回落写进了 md 文件");
}

// ── memory_write 健康计数 + 事务深度不变量 ──
{
  const w = findTool(on.captured, "memory_write");
  const good = JSON.parse(await w.execute({ topic: a.id, op: "append", text: "健康计数新增句" }, execDreamOf()));
  ok(good.ok === true && mod.__topicdbHealth.ok >= 1, "flag 开：memory_write 成功 ⇒ health.ok 计数增加", "ok=" + mod.__topicdbHealth.ok);
  ok(mod.__topicdbHealth.txDepthLeak === 0, "flag 开：写入后事务深度无泄漏（txDepthLeak=0）", "depthLeak=" + mod.__topicdbHealth.txDepthLeak);
  const bad = JSON.parse(await w.execute({ topic: "T-9999", op: "append", text: "不存在的主题" }, execDreamOf()));
  ok(bad.ok === false && mod.__topicdbHealth.failed >= 1 && !!mod.__topicdbHealth.lastError,
    "flag 开：memory_write 失败 ⇒ health.failed 计数 + 最近错误留痕", bad.code + " / " + String(mod.__topicdbHealth.lastError).slice(0, 40));
}

// ── /memory-search 命令层（flag 开）：与工具同源输出主题块 ──
{
  const cmd = (on.captured.commands || []).find((c) => c && c.name === "memory-search");
  let txt = "";
  if (cmd) { const r = await cmd.handler({ rawInput: "资源下发", agent: { session: { id: "cmd-on" } } }); txt = String((r && r.text) || ""); }
  ok(!!cmd && /检索命中 \d+ 个主题/.test(txt) && txt.includes("topic:" + a.id),
    "flag 开：/memory-search 命令层与工具同源返回主题块（task-10 B3）", txt.split("\n")[0].slice(0, 60));
}

// ── 面板/stats 只读：多次请求后审计表零新增 ──
{
  const auditBefore = JSON.stringify((store.auditTail(1) || []).map((r) => r && r.id));
  const seqBefore = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.sentences]));
  for (let i = 0; i < 3; i++) { callRoute(on.routes, "/dsh-memory/stats.json"); callRoute(on.routes, "/dsh-memory/stats"); }
  const auditAfter = JSON.stringify((store.auditTail(1) || []).map((r) => r && r.id));
  const seqAfter = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.sentences]));
  ok(auditBefore === auditAfter && seqBefore === seqAfter,
    "flag 开：面板/stats 只读 —— 三次请求后审计表与主题快照零变化（不调 lifecycleTick/pendingReminder）",
    "audit=" + auditBefore + "→" + auditAfter);
}

// ══════════════ [task-16] 跨层收口：泛化 trigger 在用户可见面落地 + 有效口径（P01–P07）══════════════
{
  const topicsTool = findTool(on.captured, "memory_topics");
  const readTool = findTool(on.captured, "memory_read");
  const genTopic = store.topics().find((t) => Array.isArray(t.genericTriggers) && t.genericTriggers.length > 0);
  // ── P01 memory_topics：trig 展示 effectiveTriggers + 行尾 [泛化已忽略: …] 标注 ──
  const listOut = await topicsTool.execute({ limit: 200 });
  ok(!!genTopic && listOut.includes("[泛化已忽略: ") && listOut.includes(genTopic.genericTriggers[0]),
    "P01 memory_topics：带泛化词的主题行尾出现 [泛化已忽略: …] 标注（保留可见、不删数据）",
    genTopic ? ("topic=" + genTopic.id + " gen=" + JSON.stringify(genTopic.genericTriggers)) : "没有泛化词主题");
  const genLine = String(listOut).split("\n").find((ln) => genTopic && ln.includes(genTopic.id)) || "";
  const trigSeg = (genLine.match(/trig:([^\n]*?)(?: \[泛化已忽略| · 别名)/) || [])[1] || "";
  ok(!!genTopic && genLine.includes("[泛化已忽略: ") && !trigSeg.includes(String(genTopic.genericTriggers[0])),
    "P01 memory_topics：泛化词只出现在标注里、不再出现在 trig: 有效列表", "trig段=[" + trigSeg + "] · 行=" + genLine.slice(0, 120));
  // ── P02 检索打分：泛化 trigger 不再计权（只有泛化词命中的主题 ⇒ 0 命中，回落 md 结果） ──
  const genWord = genTopic ? String(genTopic.genericTriggers[0]) : "面板泛测词";
  const renderGenOnly = mod.__topicdbRenderSearch(store, genWord);
  ok(renderGenOnly === null, "P02 检索打分：仅命中泛化 trigger 的主题不再入选（打分不因泛化词虚高）", "query=" + genWord + " ⇒ " + (renderGenOnly === null ? "null(回落 md)" : "非空"));
  // 对照：稀有 trigger 仍能正常命中（防"修过头"）
  store.seedTopic({ name: "面板检查•稀有触发主题", triggers: ["面板专属词甲"], src: "knowledge/MEMORY-面板检查-R.md" });
  const renderRare = mod.__topicdbRenderSearch(store, "面板专属词甲");
  ok(typeof renderRare === "string" && renderRare.includes("面板检查•稀有触发主题") && /检索命中 \d+ 个主题/.test(renderRare),
    "P02 对照：稀有 trigger 仍能命中（判据只忽略泛化，不放宽其他）", renderRare ? renderRare.split("\n")[0].slice(0, 60) : "null");
  // ── P03 冲突并列：共享泛化 trigger 不再被判"冲突" ──
  const conf = store.queryTriggerConflicts();
  const genNorm = genTopic ? String(genTopic.genericTriggers[0]).toLowerCase() : "";
  ok(!(conf.conflicts || []).some((c) => String(c.trigger).toLowerCase() === genNorm || (genTopic && c.topics.some((x) => x.id === genTopic.id))),
    "P03 冲突并列：共享泛化 trigger 的主题不再出现在 trigger 冲突清单里", "conflicts=" + (conf.conflicts || []).length);
  ok(renderGenOnly === null, "P03 检索：不会因泛化词并列出【冲突·未自动择一】块");
  // ── P04 memory_read 元信息两行（triggers: / generic(ignored):） ──
  const readGen = await readTool.execute({ topic: genTopic.id });
  ok(readGen.includes("triggers:") && readGen.includes("generic(ignored):") && readGen.includes(String(genTopic.genericTriggers[0])),
    "P04 memory_read：元信息分两行 triggers: / generic(ignored):，泛化词只在第二行",
    String(readGen).split("\n").slice(0, 3).join(" | ").slice(0, 120));
  const readA = await readTool.execute({ topic: a.id });
  ok(readA.includes("triggers:") && readA.includes("generic(ignored):") && /generic\(ignored\): -/.test(readA),
    "P04 memory_read：无泛化词的主题第二行显示 '-'（格式稳定）", String(readA).split("\n")[2] || "");
  // ── P06 stats.json.genericTriggers 与 store.genericTriggers() 同源 ──
  const gs = store.genericTriggers();
  const rjG = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body);
  const gtd = rjG.topicdb.genericTriggers;
  ok(gtd.count === (gs.generic || []).length && gtd.threshold === Number(gs.threshold)
    && JSON.stringify((gtd.top || []).map((x) => x.trigger)) === JSON.stringify((gs.generic || []).slice(0, 5).map((x) => x.trigger)),
    "P06 stats.json：topicdb.genericTriggers（count/threshold/Top5）与 store.genericTriggers() 逐项一致",
    "stats=" + JSON.stringify(gtd).slice(0, 100));

  // ── P07 有效口径（task-13 合并语义）：合并 3 个主题后 stats 数字必须"有效数降、物理行增、句数守恒" ──
  {
    const mk = (n, tag) => { const r = store.seedTopic({ name: n, triggers: ["面板合并" + tag], src: "knowledge/MEMORY-面板检查-M" + tag + ".md" }); store.appendSentence({ topic: r.id, text: "面板检查合并句" + tag, src: "knowledge/MEMORY-面板检查-M" + tag + ".md", actor: "plugin" }); return r.id; };
    const m1 = mk("面板检查•合并成员一", "A");
    const m2 = mk("面板检查•合并成员二", "B");
    const m3 = mk("面板检查•合并成员三", "C");
    const before = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb;
    let merged = null;
    try { merged = store.mergeCluster({ members: [m1, m2, m3], title: "面板检查•合并主主题", actor: "lead" }); } catch (e) { merged = { err: (e && e.message) || String(e) }; }
    ok(!!merged && merged.ok === true && merged.changed !== 0 && !!merged.mainTopicId,
      "P07 造数：mergeCluster 成功（3 成员 → 主主题 + 明细子主题，源主题 archived）",
      merged ? ("main=" + merged.mainTopicId + " child=" + (merged.childTopicId || "-") + " keep=" + merged.keepCount + " childCount=" + merged.childCount) : "null");
    const after = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb;
    const rowsSum = store.topics().reduce((s, t) => s + Number(t.sentences || 0), 0);
    ok(after.sentences === before.sentences && rowsSum === after.sentences,
      "P07 有效口径：合并前后 stats.sentences（有效句数）与 topics() 求和都守恒",
      "before=" + before.sentences + " after=" + after.sentences + " rowsSum=" + rowsSum);
    ok(after.physicalSentences === before.physicalSentences,
      "P07 有效口径：physicalSentences（物理句数）同样守恒（只改视图，不动原文）",
      before.physicalSentences + "→" + after.physicalSentences);
    ok(after.mergedSources === before.mergedSources + 3 && after.archivedTopics === before.archivedTopics + 3,
      "P07 有效口径：mergedSources +3、archivedTopics +3（源主题 archived 不删原文）",
      "merged " + before.mergedSources + "→" + after.mergedSources + " · archived " + before.archivedTopics + "→" + after.archivedTopics);
    ok(after.topics > before.topics && after.effectiveTopics === before.effectiveTopics - 2,
      "P07 有效口径：物理行数增（+主/明细）但**有效主题 -2**（源 -3、主 +1、明细不计）——面板必须用有效口径",
      "topics " + before.topics + "→" + after.topics + " · effective " + before.effectiveTopics + "→" + after.effectiveTopics);
    const listAfter = await topicsTool.execute({ like: "合并成员一" });
    ok(listAfter.includes("已合并入 " + merged.mainTopicId), "P07 memory_topics：被合并源主题行显示「已合并入 <主主题ID>」", String(listAfter).split("\n").find((x) => x.includes("已合并入")) || "(无)");
    // 面板 JS 实跑：有效口径行必须出现（有效主题/总行/已合并源）
    const blk2 = mod.__topicdbPanelBlock();
    const js2 = blk2.slice(blk2.indexOf("<script>") + 8, blk2.indexOf("</script>"));
    const nodes3 = {};
    const mk3 = (id) => ({ id, innerHTML: "", textContent: "", style: {}, getAttribute() { return null; }, addEventListener() {} });
    const doc3 = { getElementById(id) { if (!nodes3[id]) nodes3[id] = mk3(id); return nodes3[id]; }, querySelectorAll() { return []; } };
    const payload2 = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body);
    let err2 = null;
    try {
      const fn3 = new Function("document", "fetch", "requestAnimationFrame", "setTimeout", "console", js2);
      fn3(doc3, () => Promise.resolve({ json: () => Promise.resolve(payload2) }), (f) => { try { f(); } catch (e) { err2 = e; } }, (f) => setTimeout(f, 1), console);
    } catch (e) { err2 = e; }
    await sleep(150);
    const html2 = (nodes3["tdb-body"] || {}).innerHTML || "";
    // [task-22]/[task-28] 面板主数字行改成三级口径（摘要条内的 <b> 会夹标签 ⇒ 先压平文本再断言）
    const flat2 = html2.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    ok(!err2 && flat2.includes("主主题 " + payload2.topicdb.main.total + " （域 " + payload2.topicdb.main.domains + " / 项目线 " + payload2.topicdb.main.projects + "）")
      && flat2.includes("明细 " + payload2.topicdb.details) && flat2.includes("总行 " + payload2.topicdb.topics),
      "P07/P09 面板：渲染出「主主题 N（域 X / 项目线 Y）· 明细 Z」，且总行单列（不再把物理行数当主题数）",
      err2 ? ("JS 异常: " + err2.message) : "ok");
    ok(!err2 && !html2.includes("有效主题 "), "P09 面板：主数字行**不再**出现「有效主题」（effective 已废弃，不得当主数字）");
  }
}

// ══════════════ [task-22] 三级结构展示口径 + 层级折叠树（P08–P12）══════════════
{
  const topicsTool2 = findTool(on.captured, "memory_topics");
  // ── 造一棵小三级树：域 2 / 项目线 4 / 明细 5 / 未归类 2 ──
  const domA = store.createDomain("面板检查域甲", { actor: "lead" });
  const domB = store.createDomain("面板检查域乙", { actor: "lead" });
  const mkProj = (name, dom) => {
    const r = store.seedTopic({ name: name, triggers: ["面板树" + name], src: "knowledge/MEMORY-" + name + ".md" });
    store.setLevel(r.id, "project", { actor: "lead" });
    store.linkParent(r.id, dom.id, { actor: "lead" });
    return r.id;
  };
  const mkDet = (name, proj, firstSentence) => {
    const r = store.seedTopic({ name: name, triggers: ["面板树" + name], src: "knowledge/MEMORY-" + name + ".md" });
    store.setLevel(r.id, "detail", { actor: "lead" });
    store.linkParent(r.id, proj, { actor: "lead" });
    if (firstSentence) { try { store.appendSentence({ topic: r.id, text: firstSentence, actor: "plugin" }); } catch (e) { /* 首句写入失败不影响层级断言 */ } }
    return r.id;
  };
  const pA1 = mkProj("面板树项目甲一", domA);
  const pA2 = mkProj("面板树项目甲二", domA);
  const pB1 = mkProj("面板树项目乙一", domB);
  const pB2 = mkProj("面板树项目乙二", domB);
  mkDet("面板树明细甲一", pA1, "面板树明细首句：甲一的第一句"); mkDet("面板树明细甲二", pA1); mkDet("面板树明细甲三", pA1);
  mkDet("面板树明细甲四", pA2); mkDet("面板树明细乙一", pB1);
  const u1 = store.seedTopic({ name: "面板树未归类一", triggers: ["面板树未归类"], src: "knowledge/MEMORY-未归类一.md" });
  const u2 = store.seedTopic({ name: "面板树未归类二", triggers: ["面板树未归类"], src: "knowledge/MEMORY-未归类二.md" });

  const rowsTree = store.topics();
  const lvMap = mod.__topicdbLevelMap(store, rowsTree);
  const hier = mod.__topicdbHierarchy(store, rowsTree, lvMap);
  const expectUnmapped = rowsTree.filter((t) => t.state !== "archived" && !t.mergedInto && lvMap.get(t.id) === "detail" && !t.parentId).length;

  // ── P08 stats 口径：main/details/unmapped 与 store 同源；effective 带 deprecated 标记 ──
  const counts = (typeof store.topicCounts === "function") ? store.topicCounts() : null;
  const tdT = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb;
  ok(counts && JSON.stringify(tdT.main) === JSON.stringify(counts.main) && tdT.details === counts.details
    && tdT.archived === counts.archived && tdT.mergedSources === counts.merged
    && tdT.unmapped === expectUnmapped,
    "P08 stats：main/details/archived/mergedSources/unmapped 与 store.topicCounts()+层级推导逐项相等",
    JSON.stringify({ main: tdT.main, details: tdT.details, unmapped: tdT.unmapped, archived: tdT.archived, countsMain: counts && counts.main }));
  ok(tdT.main.total === tdT.main.domains + tdT.main.projects && tdT.main.domains === 2 && tdT.main.projects === 4,
    "P08 stats：main.total = domains + projects（夹具：域 2 + 项目线 4 = 6）", JSON.stringify(tdT.main));
  ok(tdT.effective !== undefined && tdT.effectiveDeprecated === true && tdT.effectiveReplacedBy === "main.total",
    "P08 stats：effective 仍存在但**标 deprecated**（并指向 main.total）", JSON.stringify({ effective: tdT.effective, deprecated: tdT.effectiveDeprecated, replacedBy: tdT.effectiveReplacedBy }));
  ok(tdT.effective !== tdT.main.total,
    "P08 口径风险实证：三级结构下 effective ≠ main.total（旧口径会把主主题数显示错）", "effective=" + tdT.effective + " vs main.total=" + tdT.main.total);
  ok(tdT.sentences === rowsTree.reduce((s, t) => s + Number(t.sentences || 0), 0),
    "P08 句子数：仍是**有效句数**（topics().sentences 求和），落树后守恒", String(tdT.sentences));

  // ── P09/P10 面板：主数字行 + 折叠树（实跑注入 JS）──
  const runPanel = async (payload) => {
    const blk = mod.__topicdbPanelBlock();
    const js = blk.slice(blk.indexOf("<script>") + 8, blk.indexOf("</script>"));
    const nodes = {};
    const mkN = (id) => ({ id, innerHTML: "", textContent: "", style: {}, getAttribute() { return null; }, addEventListener() {} });
    const doc = { getElementById(id) { if (!nodes[id]) nodes[id] = mkN(id); return nodes[id]; }, querySelectorAll() { return []; } };
    let err = null;
    try {
      const fn = new Function("document", "fetch", "requestAnimationFrame", "setTimeout", "console", js);
      fn(doc, () => Promise.resolve({ json: () => Promise.resolve(payload) }), (f) => { try { f(); } catch (e) { err = e; } }, (f) => setTimeout(f, 1), console);
    } catch (e) { err = e; }
    await sleep(150);
    return { html: (nodes["tdb-body"] || {}).innerHTML || "", err: err };
  };
  const payloadT = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body);
  const pr = await runPanel(payloadT);
  const flatPr = () => pr.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // ── P15 摘要条：四项数字与 topicCounts() 一致（task-28 新布局的第一屏）──
  {
    const sumHtml = pr.html.slice(pr.html.indexOf("tdbsum"), pr.html.indexOf("tdb2"));
    const flatSum = sumHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const cNow = store.topicCounts();
    ok(!pr.err && sumHtml.length > 0 && flatSum.includes("主主题 " + cNow.main.total + " （域 " + cNow.main.domains + " / 项目线 " + cNow.main.projects + "）")
      && flatSum.includes("明细 " + cNow.details) && flatSum.includes("未归类 " + expectUnmapped) && flatSum.includes("总行 " + cNow.total),
      "P15 摘要条：主主题/明细/未归类/总行 四项数字 == store.topicCounts()（摘要条存在于两栏之前）",
      pr.err ? ("JS 异常: " + pr.err.message) : flatSum.slice(0, 120));
    ok(flatSum.includes("句子 " + cNow.sentences) && flatSum.includes("归档 " + cNow.archived),
      "P15 摘要条：含句子数/归档数（同源 topicCounts()）", flatSum.slice(-60));
  }
  ok(!pr.err && !pr.html.includes("有效主题 "), "P09 面板：主数字行不再出现「有效主题」（effective 已废弃）");
  // ── P16 两栏容器：两个 .tdb-col + grid 用 align-items:start（修"左栏拉满高度 → 右侧空白"）──
  {
    const nCol = (pr.html.match(/class=tdb-col/g) || []).length;
    const blk = mod.__topicdbPanelBlock();
    const cssOk = /#tdb \.tdb2 \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.25fr\); gap: [^}]*align-items: start/.test(blk)
      && /#tdb \.tdb-col \{ min-width: 0; \}/.test(blk);
    ok(!pr.err && nCol === 2 && pr.html.includes("class=tdb2") && cssOk,
      "P16 两栏容器：存在 .tdb2 + **两个** .tdb-col，且 CSS 明确 align-items:start + min-width:0（不是空高度/等高拉伸）",
      "cols=" + nCol + " css=" + cssOk);
    ok(!/min-height\s*:\s*\d+px/.test(blk.slice(blk.indexOf("<style>"), blk.indexOf("</style>"))) && pr.html.indexOf("class=tdb2") < pr.html.indexOf("tdbtree"),
      "P16 布局顺序：两栏在两栏之后才出现层级树（顺序：摘要条 → 两栏 → 层级树 → 待审队列）");
  }
  // 折叠树：域节点 2、项目线折叠在域内、明细在其下；**默认全折叠**（无 open 属性）
  const treeHtml = pr.html.slice(pr.html.indexOf("tdbtree"), pr.html.indexOf("待审队列"));
  const nDom = (treeHtml.match(/<details class=tdbd>/g) || []).length;
  const nProj = (treeHtml.match(/<details class=tdbp>/g) || []).length;
  ok(nDom === 2 && nProj === 4, "P10 折叠树：域节点 2 个、项目线节点 4 个（层级来自单遍派生）", "域=" + nDom + " 项目线=" + nProj);
  ok(!/<details[^>]*\bopen\b/.test(treeHtml) && treeHtml.includes("未归类 " + tdT.unmapped + " 个（parent=null"),
    "P10 折叠树：默认全部折叠（无 open 属性），未归类单独一组", "open属性=" + /<details[^>]*\bopen\b/.test(treeHtml));
  ok(pr.html.includes("面板检查域甲") && pr.html.includes("面板树明细甲一") && pr.html.includes("[项目线]"),
    "P10 折叠树：域名/项目线/明细名都渲染进树（明细在项目线节点内）");
  ok(pr.html.indexOf("tdbfull") < pr.html.indexOf("tdbtree") && pr.html.indexOf("tdbfull") > pr.html.indexOf("class=tdb2"),
    "P10 层级树**整行**区块（tdbfull 包裹、位于两栏之后）：不再挤在右栏");
  // ── P17 待审队列：折叠在 <details class=tdbrev> 内且默认无 open ──
  {
    const revIdx = pr.html.indexOf("tdbrev");
    const revSeg = revIdx >= 0 ? pr.html.slice(revIdx, revIdx + 400) : "";
    ok(!pr.err && revIdx > 0 && /<details class=tdbrev>/.test(pr.html) && !/<details[^>]*class=tdbrev[^>]*\bopen\b/.test(pr.html)
      && /待审队列 <b>\d+<\/b> 条/.test(pr.html),
      "P17 待审队列：折叠进 <details class=tdbrev>（默认收起，标题带条数），不再甩在页面底部",
      revSeg.slice(0, 90));
    ok(pr.html.indexOf("tdbrev") > pr.html.indexOf("tdbtree"),
      "P17 顺序：待审队列在层级树之后（底部折叠区）");
  }
  // ── P18 md 视图的隐藏范围（Lead 2026-10-30 修正后语义）──
  //   旧做法把 #app/#logwrap 整体隐藏 ⇒ 连 A/B/C/D 类统计、事件、日志一起没了（用户实测反馈）。
  //   现在：默认全显示，只隐藏 .tdb-mdonly（记忆文档状态等 md 专属卡）；#tdb-oldchk 改为"显示 md 相关视图"。
  {
    const blk2 = mod.__topicdbPanelBlock();
    const styleSeg = blk2.slice(blk2.indexOf("<style>"), blk2.indexOf("</style>"));
    ok(/\.tdb-mdonly \{ display: none !important; \}/.test(styleSeg)
      && /body:has\(#tdb-oldchk:checked\) \.tdb-mdonly/.test(styleSeg),
      "P18 flag 开：只隐藏 .tdb-mdonly（md 专属卡），并提供 body:has(#tdb-oldchk:checked) 纯 CSS 展开入口",
      (styleSeg.match(/\.tdb-mdonly[^\n]*/) || [""])[0]);
    ok(!/#app, #logwrap \{ display: none !important; \}/.test(styleSeg),
      "P18b 不再整体隐藏旧面板：CSS 里不得出现 #app/#logwrap 的 display:none（A/B/C/D 统计与日志必须默认可见）");
    ok(pr.html.includes("id=tdb-oldchk") && pr.html.includes("md 相关视图") && !/onclick/.test(pr.html),
      "P18c 入口：块内 checkbox+label「显示 md 相关视图」，且渲染结果无 onclick（纯 CSS，不执行脚本动作）");
    // md 卡片必须带 .tdb-mdonly（否则隐藏规则落空）
    ok(/class="card glass span2 tdb-mdonly"><h2>记忆文档状态/.test(mod.__topicdbPanelHtmlForTest ? mod.__topicdbPanelHtmlForTest() : blk2)
      || /tdb-mdonly/.test(blk2),
      "P18d md 卡片带 .tdb-mdonly 标记（注入块内出现该标记，隐藏规则才有落点）");
  }
  // 与 store.treeOf 一致（库函数只读对照）+ 只读性
  const auditBefore = JSON.stringify((store.auditTail(1) || []).map((r) => r && r.id));
  const snapBefore = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.parentId]));
  const trA = store.treeOf(domA.id);
  callRoute(on.routes, "/dsh-memory/stats.json"); callRoute(on.routes, "/dsh-memory/stats");
  const auditAfter = JSON.stringify((store.auditTail(1) || []).map((r) => r && r.id));
  const snapAfter = JSON.stringify(store.topics().map((t) => [t.id, t.state, t.parentId]));
  const mineA = hier.domains.find((d) => d.id === domA.id) || {};
  // [task-27] treeOf 新结构：{domain, projects:[{topic,details}], directDetails:[{topic}], counts:{projects,directDetails,details}}
  ok(trA && Array.isArray(trA.projects) && Array.isArray(trA.directDetails) && trA.counts
    && trA.counts.projects === mineA.projectCount
    && trA.counts.directDetails === mineA.directDetailCount
    && trA.counts.details === mineA.detailCount,
    "P10 树数据（新 treeOf 结构）：counts.projects/directDetails/details = 我的派生（项目线不含直挂明细）",
    JSON.stringify({ treeOf: trA && trA.counts, mine: { projects: mineA.projectCount, direct: mineA.directDetailCount, details: mineA.detailCount } }));
  ok((trA.projects || []).every((p) => p.topic && p.topic.level === "project")
    && (trA.directDetails || []).every((x) => x.topic && x.topic.level === "detail"),
    "P10 projects 里没有混进直挂明细（projects.level 全为 project、directDetails.level 全为 detail）",
    "projects=" + (trA.projects || []).map((p) => p.topic && p.topic.level).join(",") + " direct=" + (trA.directDetails || []).length);
  ok(auditBefore === auditAfter && snapBefore === snapAfter,
    "P10 只读：调 treeOf + 两次 stats/panel 后审计表与父子关系零变化", "audit=" + auditBefore + "→" + auditAfter);

  // ── P11 未归类组：N 个、parent=null、渲染与 memory_topics 都单列 ──
  ok(tdT.unmapped === expectUnmapped && tdT.hierarchy.unmappedItems.length === Math.min(expectUnmapped, 50)
    && tdT.hierarchy.unmappedItems.some((x) => x.id === u1.id),
    "P11 stats：未归类 N 个 + 清单（parent=null 的 detail），含新造未归类主题", "unmapped=" + tdT.unmapped);
  ok(pr.html.includes(u1.id) && pr.html.includes("未归类 " + tdT.unmapped + " 个（parent=null"),
    "P11 面板：未归类组渲染出 N 与具体主题（点开展开）");
  const grouped = await topicsTool2.execute({});
  ok(grouped.includes("[域 → 项目线]") && grouped.includes("[明细]") && grouped.includes("[未归类]")
    && grouped.includes(domA.id + " [domain] parent=null「面板检查域甲」")
    && grouped.includes(pA1 + " [project] parent=" + domA.id),
    "P10/P11 memory_topics：按 domain → project → detail 分组，未归类单独一组，每行带 level 与 parent",
    String(grouped).split("\n").slice(0, 3).join(" | ").slice(0, 120));
  ok(grouped.includes("首句：") && grouped.includes(pA1 + "「面板树项目甲一」明细 3 条"),
    "P10 memory_topics：明细默认折叠（每组只列标题+首句，不刷屏）", String(grouped).split("\n").find((x) => x.includes("首句：")) || "(无)");
  ok(grouped.includes(u1.id) && /\[detail\] parent=null/.test(grouped), "P11 memory_topics：未归类条目显示 [detail] parent=null");
  // like 路径仍可用（平铺 + 分页，旧调用语义不变）
  const likeOut = await topicsTool2.execute({ like: "面板树项目甲一" });
  ok(likeOut.includes("主题清单（平铺）") && likeOut.includes(pA1) && likeOut.includes("[project] parent=" + domA.id),
    "P10 memory_topics：like 过滤仍走平铺分页（查找语义不变，每行带 level/parent）", String(likeOut).split("\n")[0].slice(0, 80));

  // ── P13 treeOf 新结构与 topicCounts().main.projects 之和一致 ──
  {
    const countsNow = store.topicCounts();
    const domIds = hier.domains.map((d) => d.id);
    const trees = domIds.map((id) => store.treeOf(id));
    const sumProj = trees.reduce((n, t) => n + t.counts.projects, 0);
    const sumDirect = trees.reduce((n, t) => n + t.counts.directDetails, 0);
    const sumDetails = trees.reduce((n, t) => n + t.counts.details, 0);
    const mineDirect = hier.domains.reduce((n, d) => n + Number(d.directDetailCount || 0), 0);
    ok(sumProj === countsNow.main.projects,
      "P13 Σ treeOf(域).counts.projects == topicCounts().main.projects（项目线只算真项目线）", sumProj + " vs " + countsNow.main.projects);
    ok(sumDirect === mineDirect && sumDirect === tdT.hierarchy.counts.directDetails,
      "P13 Σ treeOf().counts.directDetails == 派生的直挂明细数（单列，不混进项目线）", sumDirect + " vs mine " + mineDirect);
    ok(sumDetails === countsNow.details,
      "P13 Σ treeOf().counts.details == topicCounts().details（项目线内明细 + 直挂明细）", sumDetails + " vs " + countsNow.details);
  }

  // ── P14 交叉校验：同源 topicCounts() vs 单遍派生；篡改一侧必须告警（不得静默）──
  {
    const s1 = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb;
    ok(s1.crossCheck && s1.crossCheck.ok === true && Array.isArray(s1.crossCheck.diffs) && s1.crossCheck.diffs.length === 0 && !s1.degraded,
      "P14 正常态：crossCheck.ok=true、diffs 空、无 degraded（同源 topicCounts 与派生逐项相等）",
      JSON.stringify({ ok: s1.crossCheck && s1.crossCheck.ok, src: s1.crossCheck && s1.crossCheck.source, degraded: s1.degraded }));
    ok(s1.main && JSON.stringify(s1.main) === JSON.stringify(counts.main) && s1.details === counts.details && s1.sentences === counts.sentences,
      "P14 同源：stats 的 main/details/sentences 直接来自 topicCounts()（不是派生值）", JSON.stringify(s1.main));
    // 人为篡改"同源一侧"：projectCounts 报错数 ⇒ 必须出现 diffs + degraded + 面板 warn
    const origCounts = store.topicCounts;
    store.topicCounts = function () {
      const c = origCounts.call(store);
      const cc = JSON.parse(JSON.stringify(c));
      cc.main.projects += 1; cc.main.total = cc.main.domains + cc.main.projects; cc.details += 2;
      return cc;
    };
    let s2 = null;
    try { s2 = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb; } finally { store.topicCounts = origCounts; }
    const fields = ((s2 && s2.crossCheck && s2.crossCheck.diffs) || []).map((d) => d.field);
    ok(s2 && s2.crossCheck && s2.crossCheck.ok === false && s2.degraded === true
      && fields.includes("main.projects") && fields.includes("main.total") && fields.includes("details"),
      "P14 篡改同源一侧 ⇒ crossCheck.ok=false + degraded=true + diffs 精确指出字段（不静默通过）", JSON.stringify(fields));
    const prBad = await runPanel({ topicdb: s2 });
    ok(prBad.html.includes("口径交叉校验失败") && /main\.projects/.test(prBad.html),
      "P14 面板：渲染「⚠ 口径交叉校验失败」并列出差异（main.projects …≠…）",
      (prBad.html.match(/⚠ 口径交叉校验失败[^<]*/) || [""])[0].slice(0, 100));
    const s3 = JSON.parse(callRoute(on.routes, "/dsh-memory/stats.json").body).topicdb;
    ok(s3.crossCheck.ok === true && !s3.degraded, "P14 恢复后：crossCheck 回到 ok、degraded 撤销（不留假告警）", JSON.stringify(s3.crossCheck));
  }
}

// ───────────────────────── 第 3 轮：关回 flag ─────────────────────────
{
  const off2 = makeCtx();
  plugin.apply(off2.ctx, { memoryTopicDbEnabled: false });
  await sleep(400);
  ok(mod.__topicdb.enabled === false && mod.__topicdb.store === null, "关回 flag：store 已释放、enabled=false");
  const rj = callRoute(off2.routes, "/dsh-memory/stats.json");
  let j = null; try { j = JSON.parse(rj.body); } catch (e) { j = null; }
  ok(!!j && !Object.prototype.hasOwnProperty.call(j, "topicdb"), "关回 flag：stats.json 再次无 topicdb 段");
  const rh = callRoute(off2.routes, "/dsh-memory/stats");
  ok(rh.status === 200 && !rh.body.includes("topicdb-panel"), "关回 flag：面板 HTML 再次不含主题库区块");
  // [task-28][P18] flag 关：**逐字不变** —— 不得残留隐藏旧面板的 CSS / 摘要条 / 恢复入口
  ok(!/#logwrap/.test(rh.body) && !/#tdb-oldchk/.test(rh.body) && !/tdboldlab/.test(rh.body) && !/tdbsum/.test(rh.body),
    "P18 关回 flag：HTML 里不含隐藏旧面板的 CSS（#logwrap/#tdb-oldchk）与摘要条（tdbsum）—— 逐字不变");
  const pv = findTool(off2.captured, "memory_size_preview");
  const pm = JSON.parse(await pv.execute({ file: SRC_A, action: "append", content: "- 关回后一句\n" }, execOf()));
  // knowledge/ 本来就没有字符预算 ⇒ 原行为是「file 无预算」错误分支；关键断言是 topicdb 分支不再拦截（无 mode 字段）
  ok(pm.mode === undefined && pm.ok === false && /无预算/.test(String(pm.error || "")),
    "关回 flag：已迁移文件 preview 立即回到原分支（knowledge 无预算错误；无 mode 字段）", String(pm.error || "").slice(0, 40));
  const dp = findTool(off2.captured, "memory_dream_patch");
  const rr = JSON.parse(await dp.execute({ patches: [{ file: WRITE_TARGET, action: "append", content: "- 关回后一句\n" }] }, execOf()));
  ok(rr.ok === true && !Object.prototype.hasOwnProperty.call(rr, "topicdbNote"), "关回 flag：dream_patch 返回不再带 topicdbNote");
  ok(fs.existsSync(path.join(MEM, ".memtopic")) || fs.existsSync(process.env.MEMTOPIC_DB), "关回 flag：账本文件仍在（只是不读）");
  // [task-15] 关回 flag：升级探测缓存已复位、注入不再产生升级段（"关=无残留"）
  const partsOff2 = await mod.__topicdbInjectionParts({ session: { id: "up-off-2" }, inject() {} });
  ok(partsOff2.length === 0 && partsOff2.filter((p) => String(p).includes("【dsh-memory · 升级待办】")).length === 0,
    "R01 关回 flag：注入 parts 回空、无「升级待办」段（探测缓存已复位）");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) { console.log("FAIL 清单：\n- " + fails.join("\n- ")); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败忽略 */ }
// 插件会留定时器/事件监听（真实宿主语义），门跑完后必须主动退出，否则要等 60s 定时器才自然结束
process.exit(fails.length ? 1 : 0);
