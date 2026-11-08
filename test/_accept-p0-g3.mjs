// _accept-p0-g3.mjs — P0-2（G3）独立验收：检查点「失败不丢」——去重标记后移 + 持久化重试队列 + 补火
//
// 背景（02-plugin-status.md G3）：
//   改前 `archivedCompactionIds.add()` 在 spawn **之前**，而 spawnIntentCheckpoint 所有早退只 clog；
//   同一 compactionId 的迟到重试又被去重挡掉 ⇒ 单次瞬时失败 = 该次检查点**永久丢失**。
//
// 验收断言（可执行）：
//   F1 事件链路：subagents 不可用 ⇒ compactionId 进 .integrate.json 的 intentRetry（持久化），不是无声丢弃
//   F2 失败后再去重集合不含该 id（经 __p0Hooks.isArchivedCompactionId 观测；无钩子则 SKIP）
//   F3 失败时不落盘（sessions/*.md 无该 marker）——不伪造成功
//   F4 失败有可观测痕迹（.monitor.json 有该 id 或 retry/补火类事件）——不是只 clog
//   F5 恢复 subagents + fireIntentRetryNow({force:true}) ⇒ 检查点补写入 sessions/<today>.md
//   F6 补火成功后 intentRetry 清理（不留残条）
//   F7 补火成功后 archivedCompactionIds 含该 id（经钩子；无钩子 SKIP）
//   B1/B2 退避阶梯 __intentRetryBackoffMs(1/2/3)=60s/300s/900s、(≥4)=null 熔断
//   C1~C3 冷成功路径（直调 __p0Hooks.spawnIntentCheckpoint）：落盘、队列空、入档
//   D1 同 id 重复直调：幂等（marker 只 1 份）
//
// 跑法：node test/_accept-p0-g3.mjs [index.js 路径]（改前预期：F1/F4 FAIL、钩子项 SKIP）
// 安全：全部 os.tmpdir 临时 home；不碰真实 ~/.dsh/memory、不写运行副本、不重启 DSH。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  TARGET, mkHome, useHome, freshPlugin, makeCtx, mkAgent, applyPlugin,
  callCreated, fireCompaction, readIntegrate, readMonitor, readSessionMd, jsonContains,
  todayStr, makeReporter, finish, sleep,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P0-G3 失败重试验收");
const CFG_OFF = {};
const hostSummary = "宿主压缩摘要（验收构造）：本会话正在做 P0 G3 失败重试链路验收，"
  + "内容必须足够长以满足 40 字符门槛，并保留一个唯一标记 " + "G3-HOST-" + Math.random().toString(36).slice(2, 8) + "。";

function okSubagents(counter) {
  return {
    start: async () => {
      counter.calls += 1;
      const text = "## 本次目标\n- G3 子代理输出唯一标记 " + counter.mark + "\n## 下一步行动\n- 写回检查点\n## 关键结论\n- 补火成功";
      return { id: "g3-run-" + counter.calls, result: Promise.resolve({ output: [{ type: "text", text: text }], stopReason: "completed" }) };
    },
  };
}

// ═══════════ F：事件链路（失败 → 入队 → 补火） ═══════════
{
  const h = useHome(mkHome("g3-evt"));
  const mod = await freshPlugin();
  const state = { subagents: null };              // 先模拟 subagents 不可用
  const { ctx, handlers, captured } = makeCtx({ subagents: null });
  // ctx.get 每次返回 state.subagents（便于中途「恢复通道」）
  ctx.get = ((orig) => (name) => (name === "subagents" ? state.subagents : orig(name)))(ctx.get);
  applyPlugin(mod, CFG_OFF, ctx);
  const hooks = mod.__p0Hooks || {};
  const CID = "g3e-" + randomUUID();
  const SID = "session-g3e";

  const { agent } = mkAgent(SID);
  await callCreated(handlers, agent, 400);
  await fireCompaction(handlers, { id: SID, header: { origin: "user" } }, CID, hostSummary, 700);

  const integ = readIntegrate(h);
  R.ok(jsonContains(integ, CID), "F1 G3 失败不丢：subagents 不可用 ⇒ compactionId 进入持久化重试队列 intentRetry（改前：无队列、永久丢）",
    integ ? ("integrate keys=" + Object.keys(integ).join(",")) : ".integrate.json 不存在/不可解析");
  const retryArr = (() => { try { const r = integ && integ.intentRetry; return Array.isArray(r) ? r : []; } catch (e) { return []; } })();
  const ent = retryArr.find((x) => x && String(x.id) === CID) || null;
  if (ent) {
    R.ok(Number(ent.attempts) >= 1, "F1b G3 队列字段：attempts 从 1 起计数", "attempts=" + ent.attempts);
    R.ok(Number(ent.nextAt) > Date.now(), "F1c G3 退避字段：nextAt 在未来（不是立即空转重试）", "nextAt=" + ent.nextAt);
    R.ok(String(ent.lastReason || "").length > 0, "F1d G3 队列字段：lastReason 记录失败原因（可定位）", String(ent.lastReason).slice(0, 80));
  } else if (typeof hooks.getIntentRetry === "function") {
    const snap = await hooks.getIntentRetry();
    R.ok(jsonContains(snap, CID), "F1b G3 队列（钩子口径）：getIntentRetry 含该 id", JSON.stringify(snap).slice(0, 120));
  } else {
    R.skip("F1b/F1c/F1d 队列字段", "integrate.intentRetry 无该条目且无 getIntentRetry 钩子");
  }
  if (typeof hooks.isArchivedCompactionId === "function") {
    R.ok(hooks.isArchivedCompactionId(CID) === false, "F2 G3 去重标记后移：失败后 archivedCompactionIds **不含**该 id（改前：已含 ⇒ 迟到重试被挡）");
  } else {
    R.skip("F2 G3 去重标记后移", "缺 __p0Hooks.isArchivedCompactionId 钩子（改前预期缺）");
  }
  R.ok(!(readSessionMd(h) || "").includes(CID), "F3 G3 失败不伪造：sessions/<today>.md 无该检查点 marker");
  const monStr = JSON.stringify(readMonitor(h) || {});
  R.ok(monStr.includes(CID) || /retry|重试|补火|requeue/i.test(monStr), "F4 G3 可观测：.monitor.json 留下入队/重试痕迹（改前只有一行 clog）",
    "events=" + ((readMonitor(h) || {}).events || []).length);

  // 恢复通道 → 强制补火
  const counter = { calls: 0, mark: "F5-MARK-" + Math.random().toString(36).slice(2, 8) };
  state.subagents = okSubagents(counter);
  if (typeof hooks.fireIntentRetryNow === "function") {
    let rr = null, threw = null;
    try { rr = await hooks.fireIntentRetryNow({ force: true }); } catch (e) { threw = e; }
    await sleep(400);
    const md = readSessionMd(h) || "";
    R.ok(!threw, "F5a G3 补火接口不抛异常", threw ? threw.message : "");
    R.ok(md.includes("<!-- intent: " + CID), "F5 G3 补火成功：force 补火后检查点写入 sessions/<today>.md", "cd=" + (counter.calls) + " result=" + JSON.stringify(rr).slice(0, 120));
    R.ok(!jsonContains(readIntegrate(h), CID), "F6 G3 队列清理：补火成功后 intentRetry 不再含该 id（改前无此状态）");
    if (typeof hooks.isArchivedCompactionId === "function") {
      R.ok(hooks.isArchivedCompactionId(CID) === true, "F7 G3 成功入档：补火成功后 archivedCompactionIds 含该 id");
    } else R.skip("F7 G3 成功入档", "缺 isArchivedCompactionId 钩子");
  } else {
    R.skip("F5/F6/F7 G3 补火链路", "缺 __p0Hooks.fireIntentRetryNow 钩子（改前预期缺；这里有队列才说明失败不丢，补火待改后验）");
  }
}

// ═══════════ B：退避阶梯纯函数 ═══════════
{
  useHome(mkHome("g3-bo"));
  const mod = await freshPlugin();
  const f = mod.__intentRetryBackoffMs || mod.intentRetryBackoffMs;   // 实现实际导出名可能是无 __ 前缀的同名函数
  if (typeof f !== "function") {
    R.skip("B1/B2 退避阶梯", "缺模块级导出 __intentRetryBackoffMs（改前预期缺）");
  } else {
    R.ok(f(1) === 60000 && f(2) === 300000 && f(3) === 900000, "B1 G3 退避阶梯：attempts 1/2/3 ⇒ 60s/300s/900s",
      [f(1), f(2), f(3)].join("/"));
    R.ok(f(4) === null && f(0) === null && f(99) === null, "B2 G3 熔断：attempts∉{1,2,3} ⇒ null（该次丢弃+monitor 熔断）",
      [f(4), f(0), f(99)].join("/"));
  }
}

// ═══════════ C：冷成功路径（直调实例钩子） ═══════════
{
  const h = useHome(mkHome("g3-ok"));
  const mod = await freshPlugin();
  const counter = { calls: 0, mark: "C1-MARK-" + Math.random().toString(36).slice(2, 8) };
  const { ctx } = makeCtx({ subagents: okSubagents(counter) });
  applyPlugin(mod, CFG_OFF, ctx);
  await sleep(120);
  const hooks = mod.__p0Hooks || {};
  const CID = "g3ok-" + randomUUID();
  if (typeof hooks.spawnIntentCheckpoint !== "function") {
    R.skip("C1~C4 冷成功路径", "缺 __p0Hooks.spawnIntentCheckpoint 钩子（改前预期缺）");
  } else {
    const { agent } = mkAgent("session-g3ok");
    let r = null, threw = null;
    try { r = await hooks.spawnIntentCheckpoint(CID, hostSummary, todayStr() + ".md", agent, "session-g3ok"); } catch (e) { threw = e; }
    R.ok(!threw, "C0 G3 直调不抛异常", threw ? threw.message : "");
    const md = readSessionMd(h) || "";
    R.ok(md.includes("<!-- intent: " + CID), "C1 G3 冷成功：检查点写入 sessions/<today>.md（mode=md，flag 关）", "spawnCalls=" + counter.calls + " r=" + JSON.stringify(r).slice(0, 120));
    R.ok(md.includes(counter.mark), "C2 G3 冷成功：md 里是子代理输出正文（含输出标记）", counter.mark);
    R.ok(!jsonContains(readIntegrate(h), CID), "C3 G3 冷成功：intentRetry 无残留（成功不入队）");
    if (typeof hooks.isArchivedCompactionId === "function") R.ok(hooks.isArchivedCompactionId(CID) === true, "C4 G3 冷成功：archivedCompactionIds 含该 id");
    else R.skip("C4 G3 冷成功入档", "缺 isArchivedCompactionId 钩子");
    // D1 幂等：同 id 再调一次不新增块
    try { await hooks.spawnIntentCheckpoint(CID, hostSummary, todayStr() + ".md", agent, "session-g3ok"); } catch (e) {}
    await sleep(150);
    const md2 = readSessionMd(h) || "";
    const n = (md2.match(new RegExp("<!-- intent: " + CID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    R.ok(n === 1, "D1 G3 幂等：同 compactionId 再调一次 ⇒ marker 仍只有 1 份（md 幂等语义保留）", "marker=" + n);
  }
}

// ═══════════ G：跨实例持久化（模拟进程重启后队列仍在：新模块实例只靠磁盘读） ═══════════
{
  const h = useHome(mkHome("g3-persist"));
  const mod1 = await freshPlugin();
  const { ctx: ctx1, handlers: h1 } = makeCtx({ subagents: null });
  applyPlugin(mod1, CFG_OFF, ctx1);
  const CID = "g3p-" + randomUUID();
  const SID = "session-g3p";
  const { agent } = mkAgent(SID);
  await callCreated(h1, agent, 400);
  await fireCompaction(h1, { id: SID, header: { origin: "user" } }, CID, hostSummary, 700);
  R.ok(jsonContains(readIntegrate(h), CID), "G1 G3 持久化：失败条目已写盘 .integrate.json intentRetry", "cid=" + CID.slice(0, 12));
  // 新模块实例（同一临时 home）——内存态全空，只能从磁盘读到队列
  const mod2 = await freshPlugin();
  const { ctx: ctx2 } = makeCtx({ subagents: null });
  applyPlugin(mod2, CFG_OFF, ctx2);
  const hooks2 = mod2.__p0Hooks || {};
  if (typeof hooks2.getIntentRetry !== "function") {
    R.skip("G2 G3 跨实例读回", "缺 __p0Hooks.getIntentRetry 钩子");
  } else {
    const snap = await hooks2.getIntentRetry();
    const hit = (snap || []).find((e) => String(e && e.id) === CID);
    R.ok(!!hit, "G2 G3 跨实例读回：重启后（新实例）getIntentRetry 仍能读到该条目（持久化生效）", "entries=" + (snap || []).length + " attempts=" + (hit && hit.attempts));
  }
}

// ═══════════ 静态启发式（WARN） ═══════════
try {
  const src = fs.readFileSync(TARGET, "utf8");
  const region = (() => { const a = src.indexOf("async function spawnIntentCheckpoint"); return a >= 0 ? src.slice(a, a + 9000) : ""; })();
  if (/intentRetry|retry|重试|退避/i.test(region)) R.ok(true, "S1 静态：spawnIntentCheckpoint 区域出现重试/退避线索（启发式）");
  else R.warn("S1 静态：spawnIntentCheckpoint 区域未见重试线索（启发式，可能封装在别处）", "region.len=" + region.length);
  const hb = src.indexOf('compatOn(ctx, "session/event"');
  const hc = src.indexOf("compatOn(ctx,", hb + 10);
  const hr = (hb >= 0 ? src.slice(hb, hc > hb ? hc : hb + 12000) : "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // 剥注释（注释里提到旧顺序会造成假 WARN）
  const addPos = hr.indexOf("archivedCompactionIds.add(");
  const spawnPos = hr.indexOf("spawnIntentCheckpoint(");
  if (addPos >= 0 && spawnPos >= 0 && addPos < spawnPos) R.warn("S2 静态：session/event 里 archivedCompactionIds.add 仍先于 spawn（以 F1/F2 行为断言为准）");
  else R.ok(true, "S2 静态：session/event 里已无「先 add 后 spawn」旧顺序（启发式）");
} catch (e) {
  R.warn("S 静态启发式检查失败（不影响结论）", e && e.message ? e.message : String(e));
}

finish(R);
