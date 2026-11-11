// _test-recall-reminder.mjs —— 4.5.15 门（每轮记忆检索提醒 RT + R3 每 8 轮兜底 + 升级协议文案）
//
// 跑法：node test/_test-recall-reminder.mjs [index.js 路径]
//
// 依据：
//   · docs/方案-4.5.15-记忆检索提醒与升级协议.md §9（L-1~L-8）+ §10（v4 定稿，冲突处以此为准）
//   · docs/audit/recall-reminder_v2_AUDIT_2026-11-11.md（宿主 app.asar 证据：messages = inbox.claim 批 / R3 时序）
//   · docs/audit/recall-reminder_v3_AUDIT_2026-11-11.md（L 项复核 + 3 条文档级阻断由 §10 解决）
//
// 覆盖（门编号对应方案/审计条目）：
//   H1 handler 注册序：A 仍是第 1 个 pre-step handler、recall = 第 2 个（`_rehydrate-gate-selftest` 的取首个断言不变）
//   H2 三闸：step!==1 / 子代理 / decision.kind!=="enter" ⇒ 0 注入（内层自查；A 的早退拦不住它）
//   H3 认领批语义：messages=[] / 合成消息（source.kind!=="user"）/ 无 source ⇒ 0 注入且不抛
//   H4 去重：同一条 user 消息第二次 ⇒ 0（id 键）；无 id ⇒ p4cMsgKey 指纹仍只 1 次
//   H5 触发条件：checkpointAt>0 ⇒ 注入；无目标 ⇒ 0；db 模式「只有 todo」⇒ 注入；「只有别的会话 todo」⇒ 0；笔记未提炼 ⇒ 注入
//   H6 R3 兜底：flag 关 ⇒ 8 轮兜底；recall 命中 ⇒ R3 让位（R3-won）；delta 口径（turn-lastNudge>=8，非取模）；append 成功才置位
//   H7 成本：RT 不传 ev（events 环 0 条 recallReminder）；R3 保留 ev{trigger:"R3"}；totals 都记 n
//   H8 文案：db/md 两模式定稿文本各 ≤180（含标签）；mode-aware（md 不含 memory_read/memory_topics）
//   H9 工具描述升级协议：memory_search 三段式 / session_search「仅在 memory_search 无有用结果」/ 0 结果文案指向 session_search
//   H10 R2 sha16 基线：rebuildLearnings=false ⇒ R2 文本 sha16 == 4.5.14 冻结基线（md 模式固定夹具）
//   H11 skip 观测（M-1）：monitorEvent("recall","skip reason=…") 逐条落字符串
//   N-3（审计④补门）：动态抛错门（内层链只跑一次 / catch 返回 decision）+ §6-4 只 append 到尾部门
//                    （原元素引用不变 / 不写会话历史 / 只增不减 / 末元素是 system-reminder）
//
// 隔离纪律：全部场景在 os.tmpdir() 下造独立 DSH_HOME / DSH_MEMORY_ROOT（复用 test/_accept-p0-lib.mjs），
//   **不碰真实 ~/.dsh/memory**；不写运行副本；不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  mkHome, useHome, freshPlugin, makeCtx, applyPlugin, mkAgent, waitTopicDb, todayStr,
  makeReporter, finish, readMonitor, sleep,
} from "./_accept-p0-lib.mjs";
import * as p25 from "../p25-topics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const SRC = fs.readFileSync(PLUGIN, "utf8");
const R = makeReporter("4.5.15 每轮记忆检索提醒（RT）+ R3 兜底");
// 本门会 fresh import 多个插件实例（每个实例挂 crash observer 监听器）⇒ 放开监听器上限，避免 MaxListeners 噪声
try { process.setMaxListeners(0); } catch (e) { }

const RECALL_MARK = "【记忆检索】";
const R3_MARK = "记忆轻提醒";
const sha16 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
// R2 sha16 基线（4.5.14 冻结；口径：md 模式固定夹具 + 日期归一化；改夹具需重新基线）
const R2_GOLDEN_SHA16 = "31fb4a9f50217a4e";

function userMsg(text, id) {
  const m = { role: "user", content: [{ type: "text", text: String(text) }], source: { kind: "user" } };
  if (id !== undefined) m.id = id;
  return m;
}
function synthMsg(text) { return { role: "user", content: [{ type: "text", text: String(text) }], source: { kind: "plugin:dsh-memory" } }; }
const preSteps = (handlers) => handlers["agent/pre-step"] || [];
const msgTexts = (d) => ((d && Array.isArray(d.messages)) ? d.messages : []).map((m) => {
  try { return (m.content || []).map((b) => (b && b.text) || "").join(""); } catch (e) { return ""; }
});
const recallCount = (d) => msgTexts(d).filter((t) => t.indexOf(RECALL_MARK) >= 0).length;
const r3Count = (d) => msgTexts(d).filter((t) => t.indexOf(R3_MARK) >= 0).length;

/** 直调 recall handler（第 2 个 pre-step）；next() 返回固定 decision（不跑内层链，避免副作用干扰计数） */
async function callRecall(hs, agent, messages, opts) {
  const o = opts || {};
  const decision = o.decision || { kind: "enter", messages: [] };
  const next = async () => decision;
  const cap = { log: console.log, warn: console.warn, err: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    return await hs[1]({ agent: agent, messages: messages, step: o.step == null ? 1 : o.step, signal: null }, next);
  } finally { console.log = cap.log; console.warn = cap.warn; console.error = cap.err; }
}

/** 写 .monitor.json 的 p3.sessions 状态（recall/R3 的账本与判据来源）——**必须在 apply 之前调用**（MONITOR_DATA 有内存缓存） */
function seedP3(h, sid, fields) {
  const p = path.join(h.mem, ".monitor.json");
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d.p3 = (d.p3 && d.p3.v === 1) ? d.p3 : { v: 1, sessions: {} };
  d.p3.sessions[sid] = Object.assign({
    fired: [], lastFireAt: 0, lastActivityAt: Date.now(), checkpointAt: 0,
    endFiredAt: 0, checkpointPendingAt: 0, t5Fails: 0, t5FailAt: 0,
  }, d.p3.sessions[sid] || {}, fields || {});
  fs.writeFileSync(p, JSON.stringify(d));
}
function recallEvents(h) {
  const d = readMonitor(h) || {};
  return (d.events || []).filter((e) => e && e.type === "recall").map((e) => String(e.detail || ""));
}
/**
 * 场景启动：临时 HOME →（可选 seed：**apply 之前**造数）→ fresh import → apply → 等启动异步链落定。
 * 注意：MONITOR_DATA 有内存缓存 ⇒ p3 状态/成本账本必须在 apply 前写盘，否则实例看不到。
 */
async function boot(tag, cfg, seed) {
  const h = useHome(mkHome("r415-" + tag));
  if (typeof seed === "function") { try { seed(h); } catch (e) { /* 造数失败由断言体现 */ } }
  const mod = await freshPlugin();
  const { ctx, handlers, captured } = makeCtx({ subagents: null });
  applyPlugin(mod, cfg || {}, ctx);
  await sleep(250);
  return { h: h, mod: mod, handlers: handlers, captured: captured, hs: preSteps(handlers), hooks: mod.__recallHooks || {} };
}

// ═══════════════════════════════════════════════════════════════════════════
// H1/H2a/H8/H9：静态与接线（md 模式实例）
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await boot("static", {});
  R.ok(S.hs.length >= 2, "H1a pre-step handler 数 ≥2（A + recall）", "count=" + S.hs.length);
  const aSrc = String(S.hs[0] && S.hs[0].toString ? S.hs[0].toString() : "");
  const rSrc = String(S.hs[1] && S.hs[1].toString ? S.hs[1].toString() : "");
  R.ok(aSrc.indexOf("dsh-memory 提示") >= 0 && aSrc.indexOf("recallSkip") < 0,
    "H1b A 类 handler 仍是第 1 个（含「dsh-memory 提示」、不含 recall 逻辑）", "len=" + aSrc.length);
  R.ok(rSrc.indexOf("recallSkip") >= 0 && rSrc.indexOf("recallHasTarget") >= 0 && rSrc.indexOf("recallR3Text") >= 0,
    "H1c recall handler = 第 2 个（含 recallSkip / recallHasTarget / recallR3Text）", "len=" + rSrc.length);
  R.ok(rSrc.indexOf("step !== 1") >= 0 && rSrc.indexOf("isTopLevelSession(agent)") >= 0 && rSrc.indexOf('decision.kind !== "enter"') >= 0,
    "H2a 三闸自查在 handler 源码内（step===1 / isTopLevelSession / decision.kind===\"enter\"）", "");
  R.ok(SRC.indexOf("function recallTopicRows()") >= 0 && SRC.indexOf("RECALL_ROWS_TTL_MS") >= 0 && /now - RECALL_ROWS_CACHE\.at < RECALL_ROWS_TTL_MS/.test(SRC),
    "H2f 判据② 的 store.topics() 走共用缓存且被 30s TTL 包住（L-5 热路径 ≤1 次库调用）", "");
  R.ok(rSrc.indexOf("await next()") >= 0 && rSrc.indexOf("catch (eNext)") >= 0 && (rSrc.match(/await next\(\)/g) || []).length === 1,
    "H2b 只 await 一次 next()：catch 分支不重跑 next（防 A 的 catch 双发内层链）", "nextCount=" + (rSrc.match(/await next\(\)/g) || []).length);

  const RH = S.hooks;
  R.ok(typeof RH.text === "function" && typeof RH.r3Text === "function", "H8a 测试钩子可用（text/r3Text）", "");
  const dbT = String(RH.text("db") || ""), mdT = String(RH.text("md") || "");
  R.ok([...dbT].length <= 180, "H8b db 模式定稿文本 ≤180 字（含标签）", "len=" + [...dbT].length);
  R.ok([...mdT].length <= 180, "H8c md 模式定稿文本 ≤180 字（含标签）", "len=" + [...mdT].length);
  R.ok(dbT.indexOf("memory_read") >= 0, "H8d db 文本含 memory_read（升级阶梯直读档）", "");
  R.ok(mdT.indexOf("read 直读") >= 0 && mdT.indexOf("memory_read") < 0 && mdT.indexOf("memory_topics") < 0,
    "H8e md 文本含「read 直读」且不含 memory_read/memory_topics（mode-aware，M-2/B3）", "");
  R.ok(dbT.indexOf(RECALL_MARK) >= 0 && mdT.indexOf(RECALL_MARK) >= 0
    && dbT.indexOf("不要问用户记忆里已记过的事") >= 0 && mdT.indexOf("不要问用户记忆里已记过的事") >= 0,
    "H8f 两模式都含【记忆检索】与 S-2 原句「不要问用户记忆里已记过的事」", "");
  R.ok(dbT.indexOf("命中即信") >= 0 && dbT.indexOf("session_search") >= 0 && dbT.indexOf("放宽范围") >= 0,
    "H8g 文本含三段纪律（命中即信 / session_search / 放宽范围）", "");
  const r3 = String(RH.r3Text() || "");
  R.ok(r3.length > 0 && r3.length <= 200 && r3.indexOf(R3_MARK) >= 0, "H6a R3 兜底文本可复用（≤200 字）", "len=" + r3.length);
  const nRecall = (SRC.match(/recallPerTurn/g) || []).length;
  const nRebuild = (SRC.match(/rebuildLearnings/g) || []).length;
  R.ok(nRecall >= 5 && nRebuild >= 5, "H8h flag 落点四处齐（recallPerTurn / rebuildLearnings）", "recall=" + nRecall + " rebuild=" + nRebuild);
  // 工具描述升级协议（B1/B2/B3）
  R.ok(SRC.indexOf("**使用纪律（升级协议）**") >= 0 && SRC.indexOf("逐级升级") >= 0,
    "H9a memory_search 描述含三段式升级协议（命中即信 / 逐级升级）", "");
  R.ok(SRC.indexOf("**仅在 memory_search 无有用结果、或需要逐字原文时使用**") >= 0,
    "H9b session_search 描述含「仅在 memory_search 无有用结果…」", "");
  R.ok(SRC.indexOf("用 session_search 检索**原始会话日志**") >= 0 && SRC.indexOf("查最近会话摘要：memory_search 查 会话") < 0,
    "H9c memory_search 0 结果文案统一指向 session_search（旧「查最近会话摘要：memory_search 查 会话」已删）", "");
  R.ok(SRC.indexOf("要精确字面量") >= 0 && SRC.indexOf("session_search 回原始会话捞逐字原文") >= 0
    && SRC.indexOf("不要从摘要反推或猜") >= 0 && SRC.indexOf("命中行尾的 `⟪…⟫` 是该句来源") >= 0,
    "H9d 对齐纪律四短语逐字保留（_alignment-discipline-selftest B1-B4）", "");
}

// ═══════════════════════════════════════════════════════════════════════════
// H2/H3：三闸与认领批语义（md 模式，无记忆目标）
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await boot("gates", {});
  const { agent } = mkAgent("session-a1111111", { cwd: "C:\\r415\\ws" });
  let d = await callRecall(S.hs, agent, [userMsg("继续", "g1")], { step: 2 });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "step>1", "H2c 闸①：step=2 ⇒ 0 注入（skip reason=step>1）", "skip=" + S.hooks.lastSkip());
  const sub = mkAgent("session-a2222222", { cwd: "C:\\r415\\ws", origin: "subagent" }).agent;
  d = await callRecall(S.hs, sub, [userMsg("继续", "g2")], { step: 1 });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "subagent", "H2d 闸②：子代理 ⇒ 0 注入（skip reason=subagent）", "skip=" + S.hooks.lastSkip());
  d = await callRecall(S.hs, agent, [userMsg("继续", "g3")], { step: 1, decision: { kind: "reject" } });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "not-enter", "H2e 闸③：decision.kind=reject ⇒ 0 注入（skip reason=not-enter）", "skip=" + S.hooks.lastSkip());
  let threw = null;
  try { d = await callRecall(S.hs, agent, [], { step: 1 }); } catch (e) { threw = e; }
  R.ok(!threw && recallCount(d) === 0 && S.hooks.lastSkip() === "empty", "H3a messages=[] ⇒ 0 注入且不抛（skip reason=empty）", "skip=" + S.hooks.lastSkip());
  d = await callRecall(S.hs, agent, [synthMsg("插件注入消息")], { step: 1 });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "synthetic", "H3b 合成消息（source.kind=plugin）⇒ 0 注入（skip reason=synthetic）", "skip=" + S.hooks.lastSkip());
  d = await callRecall(S.hs, agent, [{ role: "user", content: [{ type: "text", text: "无 source 的消息" }] }], { step: 1 });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "synthetic", "H3c 无 source 的 user 消息 ⇒ 按合成处理、0 注入（_test-size-warn-parity 夹具 out 不变）", "skip=" + S.hooks.lastSkip());
}

// ═══════════════════════════════════════════════════════════════════════════
// H5a/H5b/H4/H7：md 模式「有检查点」⇒ 注入 + 去重 + 成本
// ═══════════════════════════════════════════════════════════════════════════
{
  const sid = "session-a3333333";
  const S = await boot("inject", {}, (h) => seedP3(h, sid, { turn: 3, checkpointAt: Date.now() - 1000 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  let d = await callRecall(S.hs, agent, [userMsg("继续", "i1")], { step: 1 });
  const t1 = msgTexts(d).filter((t) => t.indexOf(RECALL_MARK) >= 0);
  R.ok(t1.length === 1 && [...t1[0]].length <= 180, "H5b 本会话有检查点 ⇒ pre-step 注入 1 条 recall（≤180 字）", "len=" + (t1[0] ? [...t1[0]].length : 0));
  R.ok(t1.length === 1 && t1[0].indexOf("read 直读") >= 0 && t1[0].indexOf("memory_read") < 0, "H8i md 模式实际注入文本为 md 变体（read 直读、无 memory_read）", "");
  const inj = S.hooks.lastInject();
  R.ok(!!inj && inj.kind === "RT" && inj.chars > 0, "H7b RT 注入留观测（kind=RT / chars）", JSON.stringify(inj));
  // 同一条消息第二次 ⇒ 去重
  d = await callRecall(S.hs, agent, [userMsg("继续", "i1")], { step: 1 });
  R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "dedup", "H4a 同一条 user 消息第二次 ⇒ 0 注入（id 去重，skip=dedup）", "skip=" + S.hooks.lastSkip());
  // 两条不同消息 ⇒ 各 1 次
  d = await callRecall(S.hs, agent, [userMsg("继续", "i2")], { step: 1 });
  const c2 = recallCount(d);
  d = await callRecall(S.hs, agent, [userMsg("继续", "i3")], { step: 1 });
  R.ok(c2 === 1 && recallCount(d) === 1, "H4b 两条不同 user 消息 ⇒ 各注入 1 次", "c2=" + c2 + " c3=" + recallCount(d));
  // 无 id ⇒ 指纹去重
  d = await callRecall(S.hs, agent, [userMsg("同一内容无 id")], { step: 1 });
  const cA = recallCount(d);
  d = await callRecall(S.hs, agent, [userMsg("同一内容无 id")], { step: 1 });
  R.ok(cA === 1 && recallCount(d) === 0, "H4c 无 id 消息 ⇒ p4cMsgKey 指纹去重仍只 1 次", "cA=" + cA);
  // 成本：RT 不传 ev ⇒ cost.events 里 0 条 recallReminder；totals 记 n
  await sleep(900);
  const mon = readMonitor(S.h) || {};
  const cost = mon.cost || {};
  const evs = (cost.events || []).filter((e) => e && e.kind === "recallReminder");
  const tot = (cost.totals && cost.totals.recallReminder) || {};
  R.ok(evs.length === 0, "H7c RT 记账不传 ev：cost.events 环内 recallReminder 条数 = 0（L-3）", "evs=" + evs.length);
  R.ok(Number(tot.n) >= 3, "H7d RT 记账仍进 totals（recallReminder.n ≥3）", "n=" + tot.n);
}

// ═══════════════════════════════════════════════════════════════════════════
// H6：R3 兜底（flag 关 / recall 让位 / delta 口径 / append 成功才置位）
// ═══════════════════════════════════════════════════════════════════════════
{
  // ① flag 关 + turn=8 + 有检查点 ⇒ R3 兜底 1 条（recall 关）
  const sid = "session-b1111111";
  const S = await boot("r3off", { recallPerTurn: false }, (h) => seedP3(h, sid, { turn: 8, lastNudgeTurn: 0, checkpointAt: Date.now() - 1000 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  let d = await callRecall(S.hs, agent, [userMsg("继续", "r1")], { step: 1 });
  R.ok(recallCount(d) === 0 && r3Count(d) === 1, "H6b recallPerTurn=false ⇒ R3 按 8 轮兜底注入 1 条（L-1 夹具 D）", "recall=" + recallCount(d) + " r3=" + r3Count(d));
  R.ok(S.hooks.lastSkip() === "flag-off", "H6c flag 关时 recall 分支 skip reason=flag-off（M-1）", "skip=" + S.hooks.lastSkip());
  await sleep(900);
  const st = ((readMonitor(S.h) || {}).p3 || {}).sessions || {};
  R.ok(Number((st[sid] || {}).lastNudgeTurn) === 8, "H6d R3 append 成功后才置 lastNudgeTurn=8（K-2 双失修复）", "lastNudgeTurn=" + ((st[sid] || {}).lastNudgeTurn));
  const costEvs = (((readMonitor(S.h) || {}).cost || {}).events || []).filter((e) => e && e.kind === "recallReminder");
  R.ok(costEvs.length >= 1 && String(costEvs[costEvs.length - 1].trigger) === "R3", "H7e R3 保留 ev{trigger:\"R3\"}（成本可区分 R3/RT）", "evs=" + costEvs.length);
  // ⑦ flag 关 + R3 未到点 ⇒ pre-step **零字节注入**（L-7 的独立夹具：与 R2 无关）
  const sid7 = "session-b7777777";
  const S7 = await boot("r3offzero", { recallPerTurn: false }, (h) => seedP3(h, sid7, { turn: 3, lastNudgeTurn: 0, checkpointAt: Date.now() - 1000 }));
  const { agent: ag7 } = mkAgent(sid7, { cwd: "C:\\r415\\ws" });
  const d7 = await callRecall(S7.hs, ag7, [userMsg("继续", "r7")], { step: 1 });
  R.ok((d7.messages || []).length === 0 && S7.hooks.lastSkip() === "flag-off", "H6k flag 关 + R3 未到点 ⇒ pre-step 零字节注入（L-7 独立夹具）", "msgs=" + (d7.messages || []).length);
}
{
  // ② turn=7 + flag 开 + 有检查点 ⇒ 只 recall，无 R3
  const sid = "session-b2222222";
  const S = await boot("r3turn7", {}, (h) => seedP3(h, sid, { turn: 7, lastNudgeTurn: 0, checkpointAt: Date.now() - 1000 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  const d = await callRecall(S.hs, agent, [userMsg("继续", "r2")], { step: 1 });
  R.ok(recallCount(d) === 1 && r3Count(d) === 0, "H6e turn=7 ⇒ 只 recall 1 条、R3 不到点（L-1 夹具 B）", "recall=" + recallCount(d) + " r3=" + r3Count(d));
}
{
  // ③ turn=8 + flag 开 + 有检查点 ⇒ recall 占位、R3 让位（1 条同类提示）
  const sid = "session-b3333333";
  const S = await boot("r3won", {}, (h) => seedP3(h, sid, { turn: 8, lastNudgeTurn: 0, checkpointAt: Date.now() - 1000 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  const d = await callRecall(S.hs, agent, [userMsg("继续", "r3")], { step: 1 });
  R.ok(recallCount(d) === 1 && r3Count(d) === 0 && S.hooks.lastR3Skip() === "R3-won",
    "H6f turn=8 两通道都可触发 ⇒ 同类提示 1 条（recall 占位、R3-won 留痕，L-1 夹具 A）", "recall=" + recallCount(d) + " r3skip=" + S.hooks.lastR3Skip());
}
{
  // ④ delta 口径：flag 关 + turn=9 + lastNudgeTurn=0 ⇒ 9-0>=8 ⇒ R3 触发（非「turn%8==0」）
  const sid = "session-b4444444";
  const S = await boot("r3delta", { recallPerTurn: false }, (h) => seedP3(h, sid, { turn: 9, lastNudgeTurn: 0, checkpointAt: 0 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  const d = await callRecall(S.hs, agent, [userMsg("继续", "r4")], { step: 1 });
  R.ok(r3Count(d) === 1, "H6g R3 到点 = turn-lastNudgeTurn>=8（turn=9 也触发，delta 口径而非取模）", "r3=" + r3Count(d));
}
{
  // ⑤ 已提醒过（turn=8, lastNudgeTurn=8）⇒ 不再注入
  const sid = "session-b5555555";
  const S = await boot("r3done", { recallPerTurn: false }, (h) => seedP3(h, sid, { turn: 8, lastNudgeTurn: 8, checkpointAt: 0 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  const d = await callRecall(S.hs, agent, [userMsg("继续", "r5")], { step: 1 });
  R.ok(recallCount(d) === 0 && r3Count(d) === 0 && S.hooks.lastR3Skip() === "R3-not-due",
    "H6h 同轮已提醒（delta=0）⇒ 0 注入（skip=R3-not-due）", "r3skip=" + S.hooks.lastR3Skip());
}
{
  // ⑥ flag 关 + 无检查点 + turn=8 ⇒ R3 仍兜底（夹具 C：不依赖 agentsBySession 投递，直接 append 到 decision）
  const sid = "session-b6666666";
  const S = await boot("r3notarget", { recallPerTurn: false }, (h) => seedP3(h, sid, { turn: 8, lastNudgeTurn: 0, checkpointAt: 0 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  const d = await callRecall(S.hs, agent, [userMsg("继续", "r6")], { step: 1 });
  R.ok(r3Count(d) === 1, "H6i 无记忆目标也按 8 轮兜底（R3 语义保留，不因 recall 条件不满足而消失）", "r3=" + r3Count(d));
}

// ═══════════════════════════════════════════════════════════════════════════
// H5：db 模式触发条件（todo 支 / 别的会话 todo / 笔记未提炼 / rows TTL）
// ═══════════════════════════════════════════════════════════════════════════
{
  const sidA = "session-d1111111", sidB = "session-d2222222", sidC = "session-d3333333";
  const S = await boot("db", { memoryTopicDbEnabled: true });
  const ready = await waitTopicDb(S.mod, 20000);
  R.ok(ready, "H5c 前置：主题库就绪", ready ? "ready" : String((S.mod.__topicdb && S.mod.__topicdb.err) || "not-ready"));
  if (ready) {
    const { agent: agA } = mkAgent(sidA, { cwd: "C:\\r415\\ws" });
    const { agent: agC } = mkAgent(sidC, { cwd: "C:\\r415\\ws" });
    const fire = async (session, type, data) => { for (const h of (S.handlers["session/event"] || [])) { try { await h(session, { type: type, data: data }); } catch (e) { } } };
    // 只有 todo（无检查点）⇒ 注入（P1 per-session 源）
    await fire({ id: sidA }, "todo/write", { todos: [{ content: "R415-TODO 待办", status: "pending" }] });
    let d = await callRecall(S.hs, agA, [userMsg("继续", "d1")], { step: 1 });
    R.ok(recallCount(d) === 1, "H5d db 模式只有 todo、无检查点 ⇒ 注入（判据③ P1_EVENT_CACHE，不用 readRecentSessionFacts）", "recall=" + recallCount(d));
    const dbText = msgTexts(d).filter((t) => t.indexOf(RECALL_MARK) >= 0)[0] || "";
    R.ok(dbText.indexOf("memory_read") >= 0, "H8j db 模式实际注入文本含 memory_read（mode-aware）", "");
    // 只有**别的会话**的 todo ⇒ 不注入
    await fire({ id: sidB }, "todo/write", { todos: [{ content: "R415-OTHER 待办", status: "pending" }] });
    d = await callRecall(S.hs, agC, [userMsg("继续", "d2")], { step: 1 });
    R.ok(recallCount(d) === 0 && S.hooks.lastSkip() === "no-target", "H5e 只有别的会话 todo ⇒ 不注入（假阳防护，skip=no-target）", "skip=" + S.hooks.lastSkip());
    // 笔记未提炼 ⇒ 注入（判据②；与 rows 共用 TTL 缓存）
    const wsKey = p25.normalizeWorkspace("C:\\r415\\ws");
    const s8 = p25.sid8Of(sidC);
    const store = S.mod.__topicdb.store;
    const nt = store.seedTopic({ name: "笔记·" + wsKey + "/" + s8, triggers: [], src: "sessions/NOTE.md", actor: "plugin" });
    store.appendSentence({ topic: nt.id, text: "R415-NOTE 未提炼笔记一条", src: "sessions/x.md", actor: "runtime" });
    // TTL 缓存里没有刚建的笔记主题 ⇒ 显式失效（模拟 30s TTL 到期；门用钩子而非 sleep 30s）
    S.hooks.resetRowsCache();
    d = await callRecall(S.hs, agC, [userMsg("继续", "d3")], { step: 1 });
    R.ok(recallCount(d) === 1, "H5f db 模式本会话笔记未提炼 ⇒ 注入（判据②，只 readTopic 本会话主题）", "recall=" + recallCount(d));
    // 热路径预算：多次不同会话 pre-step ⇒ store.topics() 仍 ≤1（30s TTL 包住）
    for (let i = 0; i < 3; i++) {
      const { agent: agN } = mkAgent("session-d" + (i + 4) + "444444", { cwd: "C:\\r415\\ws" });
      await callRecall(S.hs, agN, [userMsg("继续", "dt" + i)], { step: 1 });
    }
    const fetches = S.hooks.rowsFetches();
    R.ok(fetches <= 1, "H5g 热路径库调用 ≤1 次：多次 pre-step 共用 30s TTL 的 store.topics() 缓存", "rowsFetches=" + fetches);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// H10：R2 sha16 基线（rebuildLearnings=false ⇒ 与 4.5.14 逐字一致；md 固定夹具）
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = useHome(mkHome("r415-r2sha"));
  const TITLES = ["本次目标", "当前状态", "下一步行动", "关键结论", "文件与代码", "错误与修复", "任务与待办", "未决问题"];
  const ck = [];
  for (const n of TITLES) {
    ck.push("## " + n);
    ck.push("- R2SHA-" + n + " 固定造数行 " + "内容".repeat(20));
    ck.push("- 第二条 " + n + " 占位");
  }
  fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"), ck.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(h.mem, "projects", "_index.json"), JSON.stringify({
    version: 1, projects: [{ key: "r415ws", display: "r415ws", file: "r415ws.md", workdirs: ["C:\\r415\\ws"], root: "C:\\r415\\ws", aliases: [], updatedAt: 1 }],
  }), "utf8");
  fs.writeFileSync(path.join(h.mem, "projects", "r415ws.md"), "# r415ws\n\n## Rules\n- R2SHA-PROJ 规则\n\n## 当前状态与下一步\n- 继续\n\n## Gotchas\n- 无\n\n## Architecture decisions\n- 无\n", "utf8");
  fs.writeFileSync(path.join(h.mem, "global.md"), "# 全局记忆\n- R2SHA-PROF 画像\n- 中文优先\n", "utf8");
  const mod = await freshPlugin();
  const { ctx } = makeCtx({ subagents: null });
  applyPlugin(mod, { memoryTopicDbEnabled: false, rebuildLearnings: false }, ctx);
  await sleep(300);
  const { agent } = mkAgent("session-a4444444", { cwd: "C:\\r415\\ws" });
  const H4 = mod.__p4Hooks || {};
  let r = null, threw = null;
  try { r = await H4.buildPostCompactRehydrate(agent); } catch (e) { threw = e; }
  const norm = (s) => String(s || "")
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  const got = (!threw && r) ? sha16(norm(r.text)) : "ERR";
  R.ok(!threw && got === R2_GOLDEN_SHA16, "H10 flag 关（rebuildLearnings=false）⇒ R2 文本 sha16 == 4.5.14 冻结基线", "got=" + got + " want=" + R2_GOLDEN_SHA16 + (threw ? " threw=" + threw.message : ""));
  R.ok(!threw && r && r.text.indexOf("【累积学习") < 0, "H10b flag 关时 R2 文本无【累积学习】段（字节级回退）", "");
}

// ═══════════════════════════════════════════════════════════════════════════
// N-3（审计④ 补门）：动态抛错门（L-2）+ §6-4 只 append 到尾部门
//   N-3.1：mock「recall 逻辑抛错」⇒ ① pre-step 内层链**只跑一次**（回归 dequeue=1 /
//          drainCmdEcho=1 / maint spawn ≤1；验证 catch 返回 decision、不重调 next）
//          ② 返回的 decision 仍是内层链产出的**原对象**（消息未被替换）
//   N-3.2：注入只 append 到 decision.messages 尾部（原元素引用不变 / 不写会话历史 / 只增不减）
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── N-3.1 动态抛错门：真嵌套链（A→recall→回归→maint→D3→cmdEcho），故障注入点 = TOPICDB.enabled
  //    一次性 getter 抛错（recall 注入分支在 next() 之后才读它；其余 handler 不读 ⇒ 只炸 recall 的 outer try）。
  const sid = "session-c1111111";
  const S = await boot("n3throw", {}, (h) => {
    seedP3(h, sid, { turn: 3, checkpointAt: Date.now() - 1000 });
    // maint 触发燃料：当日 sessions md 注入面 ≥ maintTriggerChars(1100)
    fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"),
      "## 当日要点\n" + "维护燃料占位行，用于触发合并维护。".repeat(80) + "\n", "utf8");
  });
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  let appends = 0, injects = 0;
  agent.session.append = () => { appends += 1; };
  agent.inject = () => { injects += 1; };
  const fire = async (session, type, data) => { for (const h of (S.handlers["session/event"] || [])) { try { await h(session, { type: type, data: data }); } catch (e) { } } };
  // ① 回归队列 ×2（真实触发：文本退化 assistant/message；≥400 字 + 25 行重复 ⇒ 命中检测）
  const degText = Array.from({ length: 30 }, (_, i) => (i < 25 ? "这是一条重复的退化占位行，用来触发文本退化检测（N3 门）" : "唯一行" + i)).join("\n") + "\n";
  await fire(agent.session, "assistant/message", { message: { content: [{ type: "text", text: degText }] } });
  await fire(agent.session, "assistant/message", { message: { content: [{ type: "text", text: degText }] } });
  // ② 命令回传队列（真实触发：/memory-search 命令 handler 入队）
  const cmdDef = (S.captured.commands || []).find((c) => c && c.name === "memory-search");
  R.ok(!!cmdDef && typeof cmdDef.handler === "function", "N3-0a 前置：memory-search 命令可调用（命令回传入队用）", cmdDef ? "ok" : "missing");
  if (cmdDef) { try { await cmdDef.handler({ rawInput: "test", agent: agent }); } catch (e) { } }
  R.ok(S.hooks.chainCounts && typeof S.hooks.chainCounts === "function", "N3-0b 前置：内层链副作用计数钩子可用", "");
  S.hooks.resetChainCounts();
  // ③ 真嵌套链（模拟宿主 waterfall：next() 调下一 handler，末层返回默认 decision）
  const hs = S.hs;
  const calls = new Array(hs.length).fill(0);
  const defaultDecision = { kind: "enter", messages: [{ id: "n3-keep", role: "user", content: [{ type: "text", text: "keep-me" }], source: { kind: "plugin:dsh-memory" } }] };
  let innerDecision = null;
  const invoke = async (i, payload) => {
    if (i >= hs.length) return defaultDecision;
    calls[i] += 1;
    const next = async () => {
      const d = await invoke(i + 1, payload);
      if (i === 1) innerDecision = d;   // recall 的 next() 返回值 = 内层链产出
      return d;
    };
    return hs[i](payload, next);
  };
  // ④ 故障注入：TOPICDB.enabled 一次性抛错（仅 recall 的注入分支读它，且在 next() 之后）
  const TOPICDB = S.mod.__topicdb;
  const desc = Object.getOwnPropertyDescriptor(TOPICDB, "enabled");
  let boom = 0;
  Object.defineProperty(TOPICDB, "enabled", {
    configurable: true,
    get() { try { Object.defineProperty(TOPICDB, "enabled", desc); } catch (e) { } boom += 1; throw new Error("N3 recall boom"); },
  });
  const payload = { agent: agent, messages: [userMsg("继续", "n3-1")], step: 1, signal: null };
  let res = null, threw = null;
  try { res = await invoke(0, payload); } catch (e) { threw = e; }
  finally { try { if (Object.getOwnPropertyDescriptor(TOPICDB, "enabled").get) Object.defineProperty(TOPICDB, "enabled", desc); } catch (e) { } }
  await sleep(300);
  R.ok(boom === 1 && !threw, "N3-1a 故障注入生效且未外溢：recall 逻辑抛错 1 次、pre-step 链无异常（catch 返回 decision）", "boom=" + boom + (threw ? " threw=" + threw.message : ""));
  R.ok(calls.length === hs.length && calls.every((n) => n === 1),
    "N3-1b ★ pre-step 内层链只跑一次（A/recall/回归/maint/D3/cmdEcho 每个 handler 调用次数都 =1；catch 未重调 next）", JSON.stringify(calls));
  const cc = S.hooks.chainCounts ? S.hooks.chainCounts() : {};
  R.ok(Number(cc.dequeue) === 1, "N3-1c 回归 dequeue 计数 =1（未被 A 的 catch 重跑；双发会是 2）", "dequeue=" + cc.dequeue);
  R.ok(Number(cc.cmdEchoDrain) === 1, "N3-1d drainCmdEcho 计数 =1（未被重跑）", "cmdEchoDrain=" + cc.cmdEchoDrain);
  R.ok(Number(cc.maintSpawn) <= 1, "N3-1e maint spawn 计数 ≤1（未被重跑）", "maintSpawn=" + cc.maintSpawn);
  R.ok(res && innerDecision && res === innerDecision && res.kind === "enter",
    "N3-1f ★ 返回的 decision 仍是内层链产出的原对象（未替换；catch 直接 return decision）", "sameRef=" + (res === innerDecision));
  const resMsgs = (res && Array.isArray(res.messages)) ? res.messages : [];
  R.ok(resMsgs === (innerDecision && innerDecision.messages) && resMsgs.length > 0 && resMsgs.every((t) => msgTexts({ messages: [t] })[0].indexOf(RECALL_MARK) < 0),
    "N3-1g 消息未被替换：res.messages 与内层链同一数组引用、且不含 recall 文本（抛错发生在 append 之前）", "len=" + resMsgs.length);
  R.ok(S.hooks.lastSkip() === "error" && !S.hooks.lastInject(), "N3-1h 抛错留痕：skip reason=error、无 RT 注入观测", "skip=" + S.hooks.lastSkip());
  R.ok(appends === 0 && injects === 0, "N3-1i 抛错路径不写会话历史（session.append=0 / agent.inject=0）", "appends=" + appends + " injects=" + injects);
}
{
  // ── N-3.2 §6-4 门：注入只 append 到 decision.messages **尾部**
  const sid = "session-c2222222";
  const S = await boot("n3append", {}, (h) => seedP3(h, sid, { turn: 3, checkpointAt: Date.now() - 1000 }));
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  let appends = 0, injects = 0;
  agent.session.append = () => { appends += 1; };
  agent.inject = () => { injects += 1; };
  const m0 = { id: "keep-0", role: "user", content: [{ type: "text", text: "原有消息0" }], source: { kind: "user" } };
  const m1 = { id: "keep-1", role: "user", content: [{ type: "text", text: "原有消息1" }], source: { kind: "plugin:dsh-memory" } };
  const origMsgs = [m0, m1];
  const decision = { kind: "enter", messages: origMsgs, tag: "keep-extra" };
  const d = await callRecall(S.hs, agent, [userMsg("继续", "ap-1")], { step: 1, decision });
  R.ok(origMsgs.length === 2 && origMsgs[0] === m0 && origMsgs[1] === m1,
    "N3-2a 注入前后原 messages 数组未被就地修改（长度 2、元素引用不变）", "len=" + origMsgs.length);
  const out = (d && Array.isArray(d.messages)) ? d.messages : [];
  R.ok(out.length === 3 && out[0] === m0 && out[1] === m1,
    "N3-2b 注入是**追加**：前 N 个元素逐个 ===（引用/内容不变），只多出尾部 1 条", "len=" + out.length);
  R.ok(out.length > origMsgs.length && out[out.length - 1] !== m0 && out[out.length - 1] !== m1,
    "N3-2c 长度只增不减、末元素是新注入的 system-reminder", "len=" + out.length);
  const lastText = msgTexts({ messages: [out[out.length - 1]] })[0] || "";
  R.ok(lastText.indexOf("<system-reminder>") === 0 && lastText.indexOf(RECALL_MARK) >= 0,
    "N3-2d 末元素是 recall 的 <system-reminder>（【记忆检索】）", "head=" + JSON.stringify(lastText.slice(0, 30)));
  R.ok(d.kind === "enter" && d.tag === "keep-extra",
    "N3-2e 其余 decision 字段原样保留（kind/tag 未被覆盖）", "kind=" + (d && d.kind) + " tag=" + (d && d.tag));
  R.ok(appends === 0 && injects === 0,
    "N3-2f ★ 不写会话历史：session.append=0 / agent.inject=0（只改当轮 PreStepDecision.messages）", "appends=" + appends + " injects=" + injects);
  R.ok(Array.isArray(d.messages) && d.messages !== origMsgs,
    "N3-2g 返回新数组（不改原数组引用），符合 PreStepDecision 不可变约定", "sameArray=" + (d.messages === origMsgs));
}

// ═══════════════════════════════════════════════════════════════════════════
// H11：skip 观测（M-1）——monitorEvent("recall","skip reason=…")
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await boot("mon", {});
  const sid = "session-e1111111";
  const { agent } = mkAgent(sid, { cwd: "C:\\r415\\ws" });
  await callRecall(S.hs, agent, [userMsg("继续", "m1")], { step: 2 });                 // step>1
  await callRecall(S.hs, agent, [], { step: 1 });                                      // empty
  await callRecall(S.hs, agent, [userMsg("继续", "m2")], { step: 1 });                 // no-target
  await sleep(900);
  R.ok(S.hooks.lastSkip() === "no-target" && S.hooks.lastR3Skip() === "R3-not-due",
    "H6j 两个分支 skip 独立观测（lastSkip=no-target、lastR3Skip=R3-not-due，互不覆盖）", "skip=" + S.hooks.lastSkip() + " r3skip=" + S.hooks.lastR3Skip());
  const evs = recallEvents(S.h).join("\n");
  R.ok(/skip reason=step>1/.test(evs) && /skip reason=empty/.test(evs) && /skip reason=no-target/.test(evs),
    "H11 monitorEvent(\"recall\") 逐条落 skip reason 字符串（M-1：step>1 / empty / no-target）", "events=" + evs.split("\n").filter(Boolean).length);
}

finish(R);
