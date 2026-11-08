// _p3-threshold-spawn-selftest.mjs — P3-1 三阈值「真正写检查点」（Patch 2）端到端自测
//
// 验证：
//   A 900K tokens（>90% 档 = 754,974）⇒ 真的 spawn 了 check writer
//   B .monitor.json 的 p3.sessions[sid].fired 含 3
//   C cost.totals.checkpointWrite 有记账（trigger=T3）
//   D 同档重复不重复 spawn
//   E T1 档（420K）= 独立触发
//
// 安全：os.tmpdir() 临时 home；fake subagents 不真启子进程；不碰真实记忆库。
import fs from "node:fs";
import { useHome, mkHome, freshPlugin, makeCtx, applyPlugin, callCreated, mkAgent, waitTopicDb, makeReporter, finish } from "./_accept-p0-lib.mjs";

const R = makeReporter("P3-1 三阈值写检查点");
const EIGHT = [
  "## 本次目标", "- 阈值触发自测", "## 当前状态", "- 写检查点", "## 下一步行动", "- 验证落库",
  "## 关键结论", "- 8 节格式合规", "## 文件与代码", "- a.md", "## 错误与修复", "- 无",
  "## 任务与待办", "- t1", "## 未决问题", "- 无",
].join("\n");

function makeSubagents(rec) {
  const ret = async () => ({
    id: "fake-" + rec.length,
    result: Promise.resolve({ output: [{ type: "text", text: EIGHT }], stopReason: "completed" }),
  });
  return {
    startActivation: async (spec) => { rec.push({ kind: "activation", spec }); return ret(); },
    start: async (...a) => { rec.push({ kind: "start", args: a }); return ret(); },
    join: async () => ({ ok: true }),
  };
}

const h = useHome(mkHome("p3ts"));
const mod = await freshPlugin();
const spawned = [];
const { ctx, handlers } = makeCtx({ subagents: makeSubagents(spawned) });
applyPlugin(mod, { memoryTopicDbEnabled: true }, ctx);
const ready = await waitTopicDb(mod);
R.ok(ready, "A0 前置：主题库就绪", ready ? "ready" : "not-ready");

const { agent } = mkAgent("session-p3ts01");
agent.session.deriveMessages = () => [
  { role: "user", content: "这是足够长的测试用户消息，用于让 buildIntentInput 有材料。".repeat(20) },
  { role: "assistant", content: "收到，正在处理这批任务。".repeat(20) },
];
await callCreated(handlers, agent, 600);
const seList = handlers["session/event"] || [];
const seFn = seList[0];
R.ok(typeof seFn === "function", "A1 取到 session/event handler", typeof seFn);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fire(totalTokens) {
  seFn(agent.session, { type: "assistant/message", data: { usage: { totalTokens: totalTokens, inputTokens: 5000, outputTokens: 500 } } });
}

// ── A：900K ⇒ 应触发 T3（90% 档 = 754,974）──
spawned.length = 0;
fire(900000);
await sleep(1500);
R.ok(spawned.length > 0, "A2 900K tokens ⇒ 真的 spawn 了 writer", "spawns=" + spawned.length);

const mon = JSON.parse(fs.readFileSync(h.mem + "/.monitor.json", "utf8"));
const st = mon.p3 && mon.p3.sessions && mon.p3.sessions["session-p3ts01"];
R.ok(st && Array.isArray(st.fired) && st.fired.includes(3), "A3 p3.fired 含 T3", JSON.stringify(st && st.fired));
const ck = mon.cost && mon.cost.totals && mon.cost.totals.checkpointWrite;
R.ok(ck && ck.n >= 1, "A4 cost.checkpointWrite 已记账", JSON.stringify(ck && { n: ck.n, inChars: ck.inChars, estTokens: ck.estTokens }));
const evs = (mon.cost && mon.cost.events) || [];
R.ok(evs.some((e) => e && e.trigger === "T3"), "A5 cost.events 有 T3 明细", "events=" + evs.length);

// ── B：同档重复 ⇒ 不再 spawn ──
spawned.length = 0;
fire(910000);
await sleep(900);
R.ok(spawned.length === 0, "B1 同档重复不重复 spawn", "spawns=" + spawned.length);

// ── C：换一个会话，T1 档（420K，>50% = 419,430）⇒ 独立触发 ──
const second = mkAgent("session-p3ts02");
second.agent.session.deriveMessages = () => [
  { role: "user", content: "第二个会话的长消息用于触发 T1 档。".repeat(20) },
  { role: "assistant", content: "好的。".repeat(20) },
];
await callCreated(handlers, second.agent, 600);
spawned.length = 0;
seFn(second.agent.session, { type: "assistant/message", data: { usage: { totalTokens: 430000 } } });
await sleep(1500);
R.ok(spawned.length > 0, "C1 第二个会话 430K ⇒ 触发 T1 并 spawn", "spawns=" + spawned.length);
const mon2 = JSON.parse(fs.readFileSync(h.mem + "/.monitor.json", "utf8"));
const st2 = mon2.p3 && mon2.p3.sessions && mon2.p3.sessions["session-p3ts02"];
R.ok(st2 && Array.isArray(st2.fired) && st2.fired.includes(1), "C2 第二会话 p3.fired 含 T1", JSON.stringify(st2 && st2.fired));

// ── D：低于 T1（400K < 419K）⇒ 不触发 ──
const third = mkAgent("session-p3ts03");
third.agent.session.deriveMessages = () => [{ role: "user", content: "第三个会话".repeat(30) }];
await callCreated(handlers, third.agent, 600);
spawned.length = 0;
seFn(third.agent.session, { type: "assistant/message", data: { usage: { totalTokens: 400000 } } });
await sleep(900);
R.ok(spawned.length === 0, "D1 400K < T1 阈值 ⇒ 不触发", "spawns=" + spawned.length);

finish(R, true);
