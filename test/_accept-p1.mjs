// _accept-p1.mjs — P1 独立验收：压缩后「外部事实包」（用户原话/todo/goal/记忆命中/改动文件清单）
//
// 背景（task-5 / .task/1101-dsh-mimo-survey/03-梳理与方案.md §4 P1）：
//   DSH 压缩后回灌的 8 节摘要是 LLM 二手回忆；P1 在 compaction/summary 之后用 agent.inject() 给**当前会话**
//   追加一条 <system-reminder>，补 5 类外部事实，并与现有「记忆刷新提示」**合并成一条**注入；总预算 ≤3000 字，
//   超限按 5→4→3→2 砍段（先砍文件清单，最后砍用户原话），字面量不截断；同一 compactionId 只注入一次；
//   origin==='subagent' 不注入；数据源缺失时降级注入其余段、不抛异常、不阻塞压缩主流程。
//
// 验收方式（黑盒为主 + 钩子纯函数级）：
//   临时 HOME + 真 import/apply + 真触发 session/event（compaction/summary，另附 compaction/end 证明不会重复触发）；
//   压缩前把种子事件同时经 session/event 与 session.snapshotEvents()/deriveMessages() 供给实现
//   （宿主真实形状：todo/write {todos:[{content,status}]}、goal/change {kind,version,operation,goal{...}}、
//    tool/call {name,arguments:{path}}、user/message {role,content,source:{kind:"user"}}）。
//
// 断言分组（任务板 task-7）：
//   T  触发：compaction ⇒ 恰好 1 条新注入（记忆刷新提示 + 外部事实包合并；单个 <system-reminder>；compactionId 头）；
//   C  5 段内容：用户原话 / todo / goal / 记忆命中 / 改动文件清单 的种子标记分别出现（含 5 个段标题）；
//   V  verbatim：用户原话逐字（GUID、Windows 路径、多行不被改写）；
//   B  预算：合并后 ≤3000+容差；超大造数下砍序（文件清单先没、用户原话保留）；字面量不切半；
//   I  幂等：同一 compactionId 重复触发只注入一次；换 compactionId 仍再注入（非进程级 once）；
//   G  闸门：origin==='subagent' 不注入；
//   R  容错：无 todo/goal/记忆/deriveMessages 时降级注入其余段、不抛异常；处理器同步返回（inject 在 setTimeout(0)）；
//   H  钩子纯函数（有 __buildExternalFacts 时）：五段/总预算/砍序 5→4→3→2/字面量不切半/空输入。
//
// 跑法：node test/_accept-p1.mjs [index.js 路径]
//   对「P1 改前」副本跑：T3/T4/C*/V*/B4 预期 FAIL（hook 项 SKIP）；对改后：期望全绿。
// 安全：全部 os.tmpdir 临时 home；不碰真实 ~/.dsh/memory、不写运行副本、不重启 DSH。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  TARGET, mkHome, useHome, freshPlugin, makeCtx, mkAgent, applyPlugin,
  callCreated, msgText, waitTopicDb, seedD8, todayStr,
  makeReporter, finish, sleep, hasPartialLiteral,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P1 外部事实包验收");
const rand = () => Math.random().toString(36).slice(2, 8);
const CFG_ON = { memoryTopicDbEnabled: true };
const HOST_SUMMARY = "## Primary Request and Intent\nP1 外部事实包验收（宿主摘要占位，长度满足门槛）\n## Pending Jobs\n- 无\n";

// ── 造数标记 ──
const MARKS = {
  quote: "P1-QUOTE-MARK-" + rand(),
  guid: randomUUID(),
  quotePath: "C:\\验收\\P1-路径\\原话逐字-" + rand() + ".md",
  todo: "P1-TODO-MARK-" + rand(),
  goal: "P1-GOAL-MARK-" + rand(),
  mem: "P1-MEM-MARK-" + rand(),
  file: "P1-FILE-MARK-" + rand(),
};

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text: text }], source: { kind: "user" } };
}

/** 造 fake session（deriveMessages + snapshotEvents 双通道，模拟宿主） */
function attachSession(agent, opts) {
  const o = opts || {};
  const msgs = o.messages || [];
  agent.session.header = agent.session.header || {};
  if (o.cwd) { agent.session.header.cwd = o.cwd; agent.session.cwd = o.cwd; }
  if (o.origin) agent.session.header.origin = o.origin;
  if (o.deriveMessages !== false) agent.session.deriveMessages = () => msgs;
  agent.session.snapshotEvents = () => (o.events || []);
  return agent;
}

/** 全部数据源种子事件（真实 DSH payload 形状） */
function seedAllSources() {
  const userData = userMsg("用户原话：" + MARKS.quote + " GUID " + MARKS.guid + "\n第二行：路径 " + MARKS.quotePath);
  userData.message = { role: "user", content: userData.content, source: userData.source };   // data 本身 / data.message 双形态
  return [
    ["user/message", userData],
    ["todo/write", {
      todos: [
        { content: MARKS.todo + " 完成 P1 验收", status: "in_progress" },
        { content: "补充回归", status: "pending" },
      ],
      counts: { pending: 1, inProgress: 1, completed: 0 },
    }],
    ["goal/change", {
      kind: "goal/change", version: 1, operation: "start",
      goal: { id: "g1", revision: 1, objective: MARKS.goal + "：P1 外部事实包上线", phase: "active", maxGoalRounds: 5 },
      roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(),
    }],
    ["tool/call", { callId: "c1", name: "write", arguments: { path: MARKS.file } }],
    ["tool/call", { callId: "c2", name: "edit", arguments: { file_path: MARKS.file } }],
    ["tool/call", { callId: "c3", name: "Read", arguments: { path: "C:\\验收\\无关读取.txt" } }],
  ];
}

/** 记忆库造数：D8 检查点句（含用户原话/mem 标记，供内部 topicDbSearchTopics 命中）+ 独立主题 */
async function seedMemory(mod) {
  try {
    const ready = await waitTopicDb(mod);
    const st = mod.__topicdb && mod.__topicdb.store;
    if (!ready || !st) return;
    seedD8(mod);
    const SUM = "## 本次目标\n- 记忆命中：" + MARKS.mem + "；相关原话 " + MARKS.quote + "；待办 " + MARKS.todo + "\n"
      + "## 下一步行动\n- 继续验收\n## 关键结论\n- 命中样本";
    try { mod.__topicdbIntentRoute("p1mem-" + randomUUID(), "p1mem01", SUM, todayStr() + ".md", "session-p1mem"); } catch (e) {}
    try {
      const dom = st.createDomain("P1验收域", { actor: "lead" });
      const t = st.seedTopic({ name: "P1验收记忆 " + MARKS.mem, triggers: [MARKS.mem, MARKS.quote], src: "knowledge/P1.md" });
      st.setLevel(t.id, "project", { actor: "lead" });
      st.linkParent(t.id, dom.id, { actor: "lead" });
      if (typeof st.appendSentence === "function") {
        try { st.appendSentence(t.id, "记忆命中句：" + MARKS.mem + " / 原话 " + MARKS.quote, { actor: "runtime" }); } catch (e) {}
      }
    } catch (e) {}
  } catch (e) { /* 造数失败 ⇒ 记忆段缺失，由对应断言体现 */ }
}

async function fireSeedEvent(handlers, session, type, data) {
  for (const h of handlers["session/event"] || []) {
    try { await h(session, { type: type, data: data }); } catch (e) { /* 插件内部应自吞 */ }
  }
}

/** 场景：临时 home + 插件实例 + 注册 agent + 种子事件；返回捕获面 */
async function runScenario(tag, opts) {
  const o = opts || {};
  const h = useHome(mkHome("p1-" + tag));
  const mod = await freshPlugin();
  const { ctx, handlers, captured } = makeCtx({ subagents: null });
  applyPlugin(mod, o.cfg == null ? CFG_ON : o.cfg, ctx);
  if (o.seedMemory !== false) await seedMemory(mod);
  const { agent, injected } = mkAgent("session-p1-" + tag, { origin: o.origin || "user", cwd: o.cwd || "C:\\acc\\ws" });
  attachSession(agent, o);
  await callCreated(handlers, agent, 350);
  const before = injected.length;
  for (const ev of (o.events || [])) await fireSeedEvent(handlers, agent.session, ev[0], ev[1]);
  return { h, mod, ctx, handlers, captured, agent, injected, before, tag };
}

/**
 * 触发一次「压缩」：真实宿主在 summary 之后还会发 compaction/end；P1 只应挂在 summary 上（end 不应重复注入）。
 * 成对 fire 可同时验证「挂在 summary」与「不在 end 上重复触发」。
 */
async function fireCompactionPair(handlers, session, cid, summaryText) {
  const events = [
    { type: "compaction/summary", data: { compactionId: cid, summary: [{ type: "text", text: String(summaryText == null ? HOST_SUMMARY : summaryText) }] } },
    { type: "compaction/end", data: { compactionId: cid } },
  ];
  for (const ev of events) {
    for (const h of handlers["session/event"] || []) {
      try { await h(session, ev); } catch (e) { /* 监听器异常不应外溢 */ }
    }
  }
}
async function fireAndCollect(sc, cid, waitMs, summaryText) {
  await fireCompactionPair(sc.handlers, sc.agent.session, cid, summaryText);
  await sleep(waitMs == null ? 800 : waitMs);
  return sc.injected.slice(sc.before).map(msgText);
}

const SEG_TITLES = [
  "【外部事实·最近用户原话（verbatim，未被摘要改写）】",
  "【外部事实·当前 todo 列表（最近一次 todo_write 快照）】",
  "【外部事实·goal 状态（objective/phase/轮次）】",
  "【外部事实·记忆库命中（memory_search 口径）】",
  "【外部事实·本会话改动文件（write/edit 参数提取）】",
];

// ═══════════════════════════ T / C / V：触发 + 5 段内容 + verbatim ═══════════════════════════
{
  const EVENTS = seedAllSources();
  const sc = await runScenario("full", {
    events: EVENTS,
    messages: [userMsg("旧原话（应也在）：P1-OLD-QUOTE-1111"), userMsg("用户原话（deriveMessages）：" + MARKS.quote + " GUID=" + MARKS.guid + "\n第二行：路径=" + MARKS.quotePath)],
  });
  const CID = "p1-" + randomUUID();
  const delta = await fireAndCollect(sc, CID);
  const all = delta.join("\n");

  R.ok(delta.length === 1, "T1 合并注入：一次 compaction 只新增 1 条注入（刷新提示 + 事实包合并；compaction/end 不重复触发）", "新增=" + delta.length + " 条");
  R.ok(/记忆刷新提示/.test(all), "T2 合并保留老文案：同一消息里仍有「记忆刷新提示」");
  R.ok(/【外部事实包/.test(all), "T3 外部事实包已注入（出现【外部事实包（dsh-memory · compaction <cid8>）】头）", all.slice(0, 90).replace(/\n/g, " "));
  R.ok(all.includes("【外部事实包（dsh-memory · compaction " + CID.slice(0, 8) + "）】"), "T4 来源可核对：注入文本含本次 compactionId 头（便于日志核对）", "cid8=" + CID.slice(0, 8));
  R.ok((all.match(/<system-reminder>/g) || []).length === 1 && all.trim().indexOf("<system-reminder>") === 0 && all.trim().endsWith("</system-reminder>"),
    "T5 单条包裹：只有 1 个 <system-reminder>（刷新提示与事实包合并在同一包裹内）", "count=" + (all.match(/<system-reminder>/g) || []).length);
  for (let i = 0; i < SEG_TITLES.length; i++) {
    R.ok(all.includes(SEG_TITLES[i]), "C0-" + (i + 1) + " 段标题落地：" + SEG_TITLES[i].replace("【外部事实·", "").replace("】", ""), "");
  }
  R.ok(all.includes(MARKS.quote), "C1 用户原话段：注入含用户原话唯一标记", MARKS.quote);
  R.ok(all.includes(MARKS.guid) && all.includes(MARKS.quotePath), "V1 verbatim：GUID 与 Windows 路径逐字出现（未被改写/截断）", "guid=" + all.includes(MARKS.guid) + " path=" + all.includes(MARKS.quotePath));
  R.ok(all.includes("第二行"), "V2 verbatim：多行原话保留（第二行未被吞）", "");
  R.ok(all.includes(MARKS.todo), "C2 todo 段：注入含 todo 唯一标记", MARKS.todo);
  R.ok(all.includes(MARKS.goal), "C3 goal 段：注入含 goal 唯一标记（goal/change 折叠）", MARKS.goal);
  R.ok(all.includes(MARKS.mem), "C4 记忆命中段：注入含记忆库唯一标记（内部 topicDbSearchTopics 命中）", MARKS.mem);
  R.ok(all.includes(MARKS.file), "C5 改动文件清单段：注入含 tool/call write/edit 路径标记", MARKS.file);
  R.ok(all.length <= 3600, "B1 预算（黑盒）：合并后单条注入 ≤3600 字符（事实包 3000 + 刷新提示/头容差）", "len=" + all.length);
  const hooks = sc.mod.__p1Hooks || {};
  if (typeof hooks.getLastInjection === "function" && typeof hooks.hasExternalFactsInjected === "function") {
    const last = hooks.getLastInjection();
    R.ok(!!last && String(last.compactionId) === CID && Array.isArray(last.kept) && Number(last.totalChars) > 0,
      "T6 钩子指纹：getLastInjection 返回本次 compactionId/kept/dropped/totalChars", last ? JSON.stringify({ kept: last.kept, dropped: last.dropped, totalChars: last.totalChars }) : "null");
    R.ok(hooks.hasExternalFactsInjected(CID) === true, "T7 幂等探针：hasExternalFactsInjected 已记录该 compactionId");
  } else {
    R.skip("T6/T7 钩子指纹", "缺 __p1Hooks.getLastInjection / hasExternalFactsInjected（改前预期缺）");
  }
}

// ═══════════════════════════ B：预算砍序（超大造数 → 5→2；字面量不切半） ═══════════════════════════
{
  const big = (n) => "长".repeat(n);
  const fileMarkB = "P1-BIG-FILE-" + rand();
  const quoteMarkB = "P1-BIG-QUOTE-" + rand();
  const events = [];
  for (let i = 0; i < 20; i++) events.push(["tool/call", { callId: "bc" + i, name: "write", arguments: { path: "C:\\验收\\大文件清单-" + i + "-" + fileMarkB + ".md" } }]);
  events.push(["todo/write", { todos: Array.from({ length: 8 }, (_, i) => ({ content: "待办" + i + " " + big(120), status: "pending" })) }]);
  events.push(["goal/change", { kind: "goal/change", version: 1, operation: "start", goal: { id: "bg", revision: 1, objective: "目标 " + big(300), phase: "active", maxGoalRounds: 5 }, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() }]);
  const sc = await runScenario("big", {
    events: events,
    messages: [userMsg("用户原话（大）：" + quoteMarkB + " " + big(1200) + " 结束")],
  });
  const CID = "p1big-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 900);
  const all = delta.join("\n");
  R.ok(delta.length >= 1, "B2 超大造数：仍注入（不因超限整体丢弃）", "新增=" + delta.length);
  R.ok(all.length <= 3600, "B3 预算（黑盒）：超大造数下整条注入仍 ≤3600 字符", "len=" + all.length);
  R.ok(all.includes(quoteMarkB), "B4 砍序：用户原话（第 1 段）保留到最后一档", "quoteMarker=" + all.includes(quoteMarkB));
  R.ok(!all.includes(fileMarkB), "B5 砍序：文件清单（第 5 段）先被砍掉", "fileMarker=" + all.includes(fileMarkB));
  R.ok(!hasPartialLiteral(all, MARKS.guid) && !hasPartialLiteral(all, fileMarkB), "B6 字面量不截断：标记要么完整要么完全不在（无半截）", "fileMarkerLen=" + fileMarkB.length);
}

// ═══════════════════════════ I：幂等（同 cid 一次；不同 cid 可再注） ═══════════════════════════
{
  const sc = await runScenario("idem", { events: seedAllSources() });
  const CID = "p1idem-" + randomUUID();
  const d1 = await fireAndCollect(sc, CID, 800);
  const nAfter1 = sc.injected.length;
  const hooks = sc.mod.__p1Hooks || {};
  const d2 = await fireAndCollect(sc, CID, 500);   // 同 cid 重发
  const dTotal = sc.injected.length - nAfter1;
  R.ok(d1.length === 1, "I1 幂等：首次 compaction 注入 1 条", "新增=" + d1.length);
  R.ok(dTotal === 0, "I2 幂等：同一 compactionId 重发 ⇒ 不再注入（0 条新增）", "重复新增=" + dTotal);
  if (typeof hooks.getInjectedCount === "function") {
    R.ok(hooks.getInjectedCount() === 1 && hooks.hasExternalFactsInjected(CID) === true, "I2b 幂等探针：注入计数=1 且该 id 已记录", "count=" + hooks.getInjectedCount());
  } else R.skip("I2b 幂等探针", "缺 __p1Hooks.getInjectedCount（改前预期缺）");
  const CID2 = "p1idem2-" + randomUUID();
  const before3 = sc.injected.length;
  await fireAndCollect(sc, CID2, 800);
  R.ok(sc.injected.length - before3 === 1, "I3 非进程级 once：换一个 compactionId 仍会再注入 1 条", "新增=" + (sc.injected.length - before3));
}

// ═══════════════════════════ G：subagent 闸门 ═══════════════════════════
{
  const sc = await runScenario("sub", { events: seedAllSources(), origin: "subagent" });
  const CID = "p1sub-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 700);
  const hooks = sc.mod.__p1Hooks || {};
  R.ok(delta.length === 0, "G1 闸门：origin==='subagent' 会话不注入外部事实包（也不注入刷新提示）", "新增=" + delta.length);
  if (typeof hooks.hasExternalFactsInjected === "function") R.ok(hooks.hasExternalFactsInjected(CID) === false, "G2 闸门：子代理会话的 compactionId 不进幂等集合");
  else R.skip("G2 闸门幂等集合", "缺 hasExternalFactsInjected（改前预期缺）");
}

// ═══════════════════════════ R：容错 / 降级 / 不阻塞 ═══════════════════════════
{
  const sc = await runScenario("empty", { events: [], seedMemory: false, deriveMessages: false });
  let threw = null;
  let delta = [];
  try { delta = await fireAndCollect(sc, "p1empty-" + randomUUID(), 700); } catch (e) { threw = e; }
  R.ok(!threw, "R1 容错：无任何数据源（无 deriveMessages/snapshotEvents/todo/goal/记忆）时不抛异常", threw ? threw.message : "");
  R.ok(delta.length >= 1 && /记忆刷新提示/.test(delta.join("\n")), "R2 降级：数据源缺失时仍注入其余内容（至少保留记忆刷新提示）", "新增=" + delta.length);
}
{
  const sc = await runScenario("nonblock", { events: [] });
  const before = sc.injected.length;
  const nbCid = "p1nb-" + randomUUID();
  const t0 = Date.now();
  await fireCompactionPair(sc.handlers, sc.agent.session, nbCid, HOST_SUMMARY);
  const syncMs = Date.now() - t0;
  const immediately = sc.injected.length - before;
  await sleep(600);
  const later = sc.injected.length - before;
  R.ok(syncMs < 150, "R3 不阻塞：session/event 处理器同步返回（<150ms，不在处理器内做检索/注入）", syncMs + "ms");
  R.ok(immediately === 0, "R4 注入时机：处理器返回时尚未注入（说明走 setTimeout(0)，不在 append 发布窗口内注入）", "立即注入=" + immediately);
  R.ok(later === 1, "R5 注入时机：一拍后注入 1 条（异步链完成）", "稍后注入=" + later);
}

// ═══════════════════════════ H：钩子纯函数级（五段/预算/砍序/字面量） ═══════════════════════════
{
  useHome(mkHome("p1-hook"));
  const mod = await freshPlugin();
  const f = mod.__buildExternalFacts;
  const SEG = mod.__externalFactSegments || [];
  if (typeof f !== "function") {
    R.skip("H1~H9 __buildExternalFacts 纯函数", "缺模块级导出 __buildExternalFacts（改前预期缺；改后若仍缺则预算砍序仅黑盒判定）");
  } else {
    const Q = "H-QUOTE-" + rand(), F = "H-FILE-" + rand(), G = "H-GOAL-" + rand(), M = "H-MEM-" + rand(), T = "H-TODO-" + rand();
    const parts = {
      userQuotes: ["用户原话 " + Q + " " + "字".repeat(300)],
      todos: ["[>] " + T + " 待办"],
      goal: ["目标：" + G, "phase=active · revision=1"],
      memoryHits: ["「主题」" + M],
      files: ["C:\\验收\\" + F + ".md", "C:\\验收\\另一个.md"],
    };
    const call = (p, b) => { try { return f(p, b); } catch (e) { return { __threw: e }; } };
    const r1 = call(parts);
    R.ok(!r1.__threw && Number(r1.totalChars) <= 3000 && String(r1.text || "").length === Number(r1.totalChars), "H1 默认预算：totalChars ≤3000 且 text.length==totalChars", "total=" + (r1.totalChars || 0) + (r1.__threw ? " threw=" + r1.__threw.message : ""));
    R.ok(Array.isArray(SEG) && SEG.length === 5 && SEG.every((s) => s && String(s.title || "").indexOf("【外部事实") === 0), "H2 段定义：__externalFactSegments 五段且标题以「【外部事实」开头", JSON.stringify(SEG.map((s) => s && s.id)));
    R.ok(Array.isArray(r1.kept) && r1.kept.length === 5 && String(r1.text || "").includes(Q) && String(r1.text || "").includes(F), "H3 五段全放下：kept=5，用户原话/文件路径字面量原样", JSON.stringify(r1.kept));
    const bigParts = { userQuotes: ["U".repeat(400)], todos: ["T".repeat(300)], goal: ["G".repeat(200)], memoryHits: ["M".repeat(300)], files: ["F".repeat(300)] };
    const r2 = call(bigParts, 600);
    const dropped2 = Array.isArray(r2.dropped) ? r2.dropped : [];
    R.ok(!r2.__threw && Number(r2.totalChars) <= 600, "H4 小预算：budget=600 ⇒ totalChars ≤600", "total=" + (r2.totalChars || 0));
    R.ok(dropped2[0] === "files" && dropped2.includes("memoryHits") && dropped2.indexOf("files") < dropped2.indexOf("memoryHits"), "H5 砍序：先 files（5），再 memoryHits（4）", JSON.stringify(dropped2));
    R.ok(Array.isArray(r2.kept) && !r2.kept.includes("files") && !r2.kept.includes("memoryHits"), "H6 砍后一致：被砍段不在 kept", JSON.stringify(r2.kept));
    const r3 = call({ userQuotes: ["Q".repeat(200)], todos: ["T".repeat(200)], goal: ["G".repeat(200)], memoryHits: ["M".repeat(200)], files: ["F".repeat(200)] }, 300);
    R.ok(Array.isArray(r3.kept) && r3.kept.length === 1 && r3.kept[0] === "userQuotes", "H7 砍序终点：极小预算下只剩用户原话（最后被砍）", JSON.stringify(r3.kept));
    const atoms = new Set();
    for (const k of Object.keys(parts)) for (const x of parts[k]) atoms.add(String(x).trim());
    let half = 0;
    for (const ln of String(r1.text || "").split("\n")) {
      if (ln.indexOf("- ") !== 0) continue;
      const body = ln.slice(2).trim();
      if (!atoms.has(body)) half++;
    }
    R.ok(half === 0, "H8 字面量不截断：内容行都是输入原子的完整行（无半行）", "half=" + half);
    const r4 = call({ userQuotes: [], todos: [], goal: [], memoryHits: [], files: [] });
    R.ok(!r4.__threw && String(r4.text || "") === "" && Number(r4.totalChars) === 0, "H9 空输入：text 空、totalChars=0、不抛", "");
  }
}

// ═══════════════════════════ 静态启发式（WARN，不计失败；行为断言更可信） ═══════════════════════════
try {
  const src = fs.readFileSync(TARGET, "utf8");
  if (/collectExternalFacts\(targetAgent, session, compactionId\)/.test(src)) R.ok(true, "S1 静态：session/event 内调用 collectExternalFacts（当前会话）");
  else R.warn("S1 静态：未见 collectExternalFacts(targetAgent, session, compactionId) 调用形态（启发式）", "");
  // [P4-R2 规格变更 2026-11-02] 合并口径扩为「刷新提示 + 事实包 + 压缩后记忆重灌」：
  //   finalNote = injectParts.length ? p1MergeInjection(refreshNote, injectParts.join("\n\n")) : refreshNote
  if (/p1MergeInjection\(refreshNote, injectParts\.join\("\\n\\n"\)\)/.test(src) || /p1MergeInjection\(refreshNote, facts\.text\)/.test(src)) R.ok(true, "S2 静态：事实包与记忆重灌并入「记忆刷新提示」同一条注入");
  else R.warn("S2 静态：未见 p1MergeInjection(refreshNote, …) 合并形态（启发式）", "");
  if (/setTimeout\((async )?\(\) => \{[\s\S]{0,1800}collectExternalFacts/.test(src)) R.ok(true, "S3 静态：事实包构建/注入在 setTimeout(0) 内（避开 session.append 发布窗口）");
  else R.warn("S3 静态：未证实 collectExternalFacts 在 setTimeout 内（R4 行为断言更可信）", "");
  if (/EXTERNAL_FACT_IDS\.has\(String\(compactionId\)\)/.test(src) && /p1NoteExternalFactId\(compactionId\)/.test(src)) R.ok(true, "S4 静态：同 compactionId 幂等（Set 判定 + 记录）");
  else R.warn("S4 静态：未见 EXTERNAL_FACT_IDS 幂等接线（启发式）", "");
} catch (e) {
  R.warn("S 静态启发式检查失败（不影响结论）", e && e.message ? e.message : String(e));
}

finish(R);
