// _accept-p2.mjs — P2 独立验收：检查点升级（8 节结构 + 输入换料 + 预算删序 + 注入槽 3000）
//
// 背景（task-8 / 03 §4 P2；对齐 MiMo-Code checkpoint-writer）：
//   P2-1 检查点输出从三节扩到 8 节（标题逐字、固定顺序）：
//        本次目标 / 当前状态 / 下一步行动 / 关键结论 / 文件与代码 / 错误与修复 / 任务与待办 / 未决问题
//   P2-2 输入换料：喂给检查点子代理的 prompt = 「最近对话原文」（deriveMessages 最近 N 轮，≤8000 字，从最旧截断）
//        + 「任务与待办」（P1 的 p1ScanEvents/P1_EVENT_CACHE）+ 宿主压缩摘要（保留在最后）。
//   P2-3 校验与护栏：validateMdStructure(requireSections) 按 8 节校验；总输出 ≤3000，超限删序
//        v4.5.4 反转：文件与代码 → 错误与修复 → 任务与待办 → 未决问题；前三节+关键结论不删；绝不切半句；末尾一条回溯指针。
//   P2-4 注入端：SUMMARY_SLOT_BUDGET.checkpoint 2500→3000，buildSummaryInjection 默认总预算 4500→5000；
//        历史三节文本仍可正常注入（读取端不校验结构）。
//
// 验收方式（黑盒为主）：临时 HOME + 真 import/apply + 真触发 session/event(compaction/summary)；
//   用 fake subagents.start **捕获喂给检查点子代理的 prompt**，并按队列返回造数输出，再看落盘(检查点 md)结果。
//
// 断言分组（task-9）：
//   S 结构：prompt 含 8 节标题（逐字+顺序）；8 节合规输出被接受；缺节/乱序被拒绝（不落盘）；
//   I 输入换料：prompt 同时含「最近对话原文」段（用户原话标记）/「任务与待办」段（todo/goal 标记）/宿主摘要；
//             对话原文 ≤8000 字且从最旧截断（最旧标记被丢弃）；
//   B 预算与护栏：输出 ≤3000；三档造数分别只删 未决问题 / 未决+任务 / 未决+任务+错误；前三节+关键结论不删；
//             被删节里的字面量整段消失、保留节里的字面量逐字保留（无半截）；
//   J 注入：SUMMARY_SLOT_BUDGET.checkpoint===3000；buildSummaryInjection 默认 budget===5000；
//             历史三节文本经 buildSummaryInjection 与 agent/created 真注入均正常；
//   T 静态启发式（WARN）：8 节标题/输入段标记/护栏常量在源码对应区域。
//
// 跑法：node test/_accept-p2.mjs [index.js 路径]
//   对「P2 改前副本」跑：S1/S3/I*/B*/J1/J2 预期 FAIL（其余 PASS/SKIP）——baseline。
// 安全：全部 os.tmpdir 临时 home；不碰真实 ~/.dsh/memory、不写运行副本、不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TARGET, mkHome, useHome, freshPlugin, makeCtx, mkAgent, applyPlugin,
  callCreated, msgText, summaryInjections, waitTopicDb,
  todayStr, makeReporter, finish, sleep, hasPartialLiteral, jsonContains, readIntegrate,
  sessionMdPath,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P2 检查点升级验收");
const rand = () => Math.random().toString(36).slice(2, 8);
const CFG_OFF = {};
const CFG_ON = { memoryTopicDbEnabled: true };
const HOST_SUMMARY = "## Primary Request and Intent\nP2 检查点升级验收（宿主摘要占位）P2-HOST-" + rand() + "\n"
  + "## Pending Jobs\n- 继续验收\n## Next Step\n- 写报告\n";

const TITLES = ["本次目标", "当前状态", "下一步行动", "关键结论", "文件与代码", "错误与修复", "任务与待办", "未决问题"];
const T = (n) => "## " + n;
const SUMM_TITLE = "## 检查点";

/** 造一个 8 节合法输出；sizes 可覆盖各节体量；marks 给每节塞唯一标记 */
function build8(opts) {
  const o = opts || {};
  const sizes = o.sizes || {};
  const marks = o.marks || {};
  const out = [];
  for (const name of TITLES) {
    out.push("## " + name);
    const mark = marks[name] ? marks[name] + "\n" : "";
    const size = Number(sizes[name] || 40);
    const filler = [];
    let cur = mark.length;
    let i = 0;
    while (cur < size) { const ln = "内容" + i + "-" + "字".repeat(Math.max(0, 36 - String(i).length - 3)); filler.push(ln); cur += ln.length + 1; i++; }
    out.push((mark + filler.join("\n")).trim());
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}

/** 删掉某一节（造"缺节"输出） */
function dropSection(text, name) {
  const lines = String(text).split("\n");
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.+?)\s*$/);
    if (m) skipping = (m[1] === name);
    if (!skipping) out.push(ln);
  }
  return out.join("\n");
}

/** 调换两节顺序（造"乱序"输出） */
function swapSections(text, a, b) {
  const blk = {};
  const order = [];
  let cur = null;
  for (const ln of String(text).split("\n")) {
    const m = ln.match(/^##\s+(.+?)\s*$/);
    if (m) { cur = m[1]; order.push(cur); blk[cur] = [ln]; continue; }
    if (cur) blk[cur].push(ln);
  }
  const seq = order.slice();
  const ia = seq.indexOf(a), ib = seq.indexOf(b);
  if (ia >= 0 && ib >= 0) { const t = seq[ia]; seq[ia] = seq[ib]; seq[ib] = t; }
  return seq.map((n) => blk[n].join("\n")).join("\n").trim() + "\n";
}

/** fake 子代理：按队列返回输出，并捕获每次喂进去的 prompt */
function mkCaptureSubagents(outputs) {
  const prompts = [];
  const queue = (outputs || []).slice();
  // 只给「检查点子代理」返回造数输出；维护合并等其它子代理一律空输出。
  // （旧实现所有子代理共用队列 ⇒ 维护合并抢走造数并把「当日要点」写进 md，污染 B 组断言）
  const isCheckpointWriter = (txt) => /会话检查点记录器|检查点记录器/.test(String(txt || ""));
  return {
    prompts: prompts,
    start: async (kind, opts) => {
      let txt = "";
      try {
        const p = opts && opts.prompt;
        txt = Array.isArray(p) ? p.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n") : String(p == null ? "" : p);
      } catch (e) { txt = ""; }
      if (!isCheckpointWriter(txt)) {
        return { id: "p2-run-other", result: Promise.resolve({ output: [], stopReason: "completed" }) };
      }
      prompts.push(txt);
      const text = queue.length ? queue.shift() : build8({});
      return { id: "p2-run-" + prompts.length, result: Promise.resolve({ output: [{ type: "text", text: text }], stopReason: "completed" }) };
    },
  };
}

function attachSession(agent, opts) {
  const o = opts || {};
  agent.session.header = agent.session.header || {};
  if (o.cwd) { agent.session.header.cwd = o.cwd; agent.session.cwd = o.cwd; }
  if (o.origin) agent.session.header.origin = o.origin;
  if (o.deriveMessages !== false) agent.session.deriveMessages = () => (o.messages || []);
  agent.session.snapshotEvents = () => (o.events || []);
  return agent;
}

async function fireSeedEvent(handlers, session, type, data) {
  for (const h of handlers["session/event"] || []) {
    try { await h(session, { type: type, data: data }); } catch (e) { /* 插件内部应自吞 */ }
  }
}

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

/** 场景：临时 home + 插件实例 + 注册 agent + 可选种子事件 + 捕获型子代理 */
async function runScenario(tag, opts) {
  const o = opts || {};
  const h = useHome(mkHome("p2-" + tag));
  const mod = await freshPlugin();
  const sub = mkCaptureSubagents(o.outputs || []);
  const { ctx, handlers, captured } = makeCtx({ subagents: sub });
  applyPlugin(mod, o.cfg == null ? CFG_OFF : o.cfg, ctx);
  const { agent, injected } = mkAgent("session-p2-" + tag, { origin: o.origin || "user", cwd: o.cwd || "C:\\acc\\ws" });
  attachSession(agent, o);
  await callCreated(handlers, agent, 300);
  for (const ev of (o.events || [])) await fireSeedEvent(handlers, agent.session, ev[0], ev[1]);
  return { h, mod, ctx, handlers, captured, agent, injected, sub, tag };
}

async function spawnViaCompaction(sc, cid, summaryText, waitMs) {
  const n0 = sc.sub.prompts.length;
  await fireCompactionPair(sc.handlers, sc.agent.session, cid, summaryText);
  const t0 = Date.now();
  while (Date.now() - t0 < (waitMs || 4000)) {
    if (sc.sub.prompts.length > n0) { await sleep(120); break; }
    await sleep(40);
  }
  await sleep(350);   // 等落盘/收尾
  return sc.sub.prompts[n0] || null;
}

function readMd(h) {
  try { return fs.readFileSync(sessionMdPath(h), "utf8"); } catch (e) { return ""; }
}
function hasSection(text, name) {
  return new RegExp("^##\\s*" + name + "\\s*$", "m").test(String(text || ""));
}
/** 取检查点正文（md 里 marker 之后、去掉插件头）长度（用于"输出 ≤3000"口径） */
function intentBody(text) {
  const t = String(text || "");
  const i = t.lastIndexOf("<!-- intent: ");   // 取最新一块（md 可能被维护合并追加过旧块）
  if (i < 0) return "";
  let s = t.slice(i);
  const j = s.indexOf("-->\n");
  if (j >= 0) s = s.slice(j + 4);
  const lines = s.split("\n");
  if (lines.length && /^##\s*检查点/.test(lines[0])) lines.shift();
  return lines.join("\n").trim();
}

// ═══════════════════════════ S：结构（8 节提示词 + 校验） ═══════════════════════════
{
  // S1：真触发压缩 ⇒ 捕获的检查点子代理 prompt 含 8 节标题（逐字、顺序）
  const sc = await runScenario("struct-prompt", { outputs: [build8({})] });
  const CID = "p2s-" + randomUUID();
  const prompt = await spawnViaCompaction(sc, CID, HOST_SUMMARY);
  const pr = String(prompt || "");
  R.ok(pr.length > 0, "S0 前置：压缩事件 ⇒ 真的 spawn 检查点子代理并捕获 prompt", "promptLen=" + pr.length);
  let lastPos = -1, orderOk = true; const orderSeen = [];
  for (const name of TITLES) {
    const m = new RegExp("^##\\s*" + name + "\\s*$", "m").exec(pr);
    const pos = m ? m.index : -1;
    orderSeen.push(name + (pos >= 0 ? "@" + pos : "@MISS"));
    if (pos < 0 || pos <= lastPos) orderOk = false;
    lastPos = pos;
  }
  const allPresent = TITLES.every((n) => new RegExp("^##\\s*" + n + "\\s*$", "m").test(pr));
  R.ok(allPresent, "S1 提示词 8 节标题齐备（本次目标/当前状态/下一步行动/关键结论/文件与代码/错误与修复/任务与待办/未决问题）", orderSeen.join(" "));
  R.ok(allPresent && orderOk, "S2 提示词标题顺序固定为 8 节顺序（逐字匹配）", orderSeen.join(" "));
  R.ok(pr.includes("宿主压缩摘要"), "S3 提示词仍保留「宿主压缩摘要」段（摘要放最后/保留）", "");
}
{
  // S4：8 节合规输出被接受（真落盘检查点 md）
  const sc = await runScenario("struct-valid", { outputs: [build8({ marks: { 本次目标: "P2-VALID-TARGET-" + rand() } })] });
  const CID = "p2v-" + randomUUID();
  await spawnViaCompaction(sc, CID, HOST_SUMMARY);
  const md = readMd(sc.h);
  R.ok(md.includes("<!-- intent: " + CID), "S4 8 节合规输出被接受并落盘（md 有该 compactionId marker）", "mdLen=" + md.length);
  R.ok(hasSection(md, "当前状态") && hasSection(md, "任务与待办") && hasSection(md, "未决问题"), "S5 落盘正文保留 8 节结构（抽查 当前状态/任务与待办/未决问题）", "");
}
{
  // S6：缺一节（未决问题）⇒ 拒绝、不落盘、有失败原因
  const sc = await runScenario("struct-missing", { outputs: [dropSection(build8({}), "未决问题")] });
  const CID = "p2m-" + randomUUID();
  await spawnViaCompaction(sc, CID, HOST_SUMMARY);
  const md = readMd(sc.h);
  R.ok(!md.includes("<!-- intent: " + CID), "S6 缺节（未决问题）⇒ 校验拒绝、不落盘", "mdHasMarker=" + md.includes("<!-- intent: " + CID));
  const integ = readIntegrate(sc.h);
  R.ok(jsonContains(integ, CID) || /struct|bad|malformed|7/i.test(JSON.stringify(integ)), "S7 缺节被拒后进入失败/重试路径（可诊断，不是静默成功）", "");
}
{
  // S8：乱序（关键结论<->下一步行动 互换）⇒ 拒绝
  const sc = await runScenario("struct-order", { outputs: [swapSections(build8({}), "下一步行动", "关键结论")] });
  const CID = "p2o-" + randomUUID();
  await spawnViaCompaction(sc, CID, HOST_SUMMARY);
  const md = readMd(sc.h);
  R.ok(!md.includes("<!-- intent: " + CID), "S8 标题乱序 ⇒ 校验拒绝、不落盘", "");
}
{
  // S9：如果有 validateMdStructure 钩子/导出，直测 8 节校验（无则 SKIP）
  useHome(mkHome("p2-hook"));
  const mod = await freshPlugin();
  const hooks = mod.__p2Hooks || {};
  const v = hooks.validateMdStructure || mod.validateMdStructure || mod.__validateMdStructure || null;
  if (typeof v !== "function") {
    R.skip("S9~S11 validateMdStructure 8 节直测", "缺 __p2Hooks.validateMdStructure / 模块级导出（改前预期缺；以 S4-S8 端到端为准）");
  } else {
    const tryV = (text, opts) => {
      // 8 节严格校验：必须显式传 sections（实现约定：不传 = 老的三节兼容模式）
      const SECTIONS = mod.__intentSections8 || null;
      try { return v(text, Object.assign({ requireSections: true }, SECTIONS ? { sections: SECTIONS } : {}, opts || {})); } catch (e) { return { __threw: e }; }
    };
    const good = tryV(build8({}));
    R.ok(!good.__threw && good && good.ok === true, "S9 8 节合规 ⇒ 校验通过", JSON.stringify(good).slice(0, 120));
    const miss = tryV(dropSection(build8({}), "错误与修复"));
    R.ok(!miss.__threw && miss && miss.ok === false, "S10 缺节 ⇒ 校验拒绝", JSON.stringify(miss).slice(0, 120));
    const badOrder = tryV(swapSections(build8({}), "本次目标", "当前状态"));
    R.ok(!badOrder.__threw && badOrder && badOrder.ok === false, "S11 乱序 ⇒ 校验拒绝", JSON.stringify(badOrder).slice(0, 120));
  }
}

// ═══════════════════════════ I：输入换料（最近对话原文 + 任务与待办 + 宿主摘要） ═══════════════════════════
{
  const QUOTE = "P2-QUOTE-MARK-" + rand();
  const AST = "P2-AST-MARK-" + rand();
  const TODO = "P2-TODO-MARK-" + rand();
  const GOAL = "P2-GOAL-MARK-" + rand();
  const OLD = "P2-OLD-MARK-" + rand();
  const TOOL = "P2-TOOL-MARK-" + rand();
  // 造大量旧消息（合计 >8000 字），最旧的带 OLD 标记（应被从最旧截断掉）
  const messages = [];
  for (let i = 0; i < 24; i++) messages.push({ role: "user", content: [{ type: "text", text: "旧消息" + i + " " + (i < 6 ? OLD + " " : "") + "字".repeat(420) }], source: { kind: "user" } });
  messages.push({ role: "user", content: [{ type: "text", text: "最近用户原话：" + QUOTE + "\n第二行：继续 P2 验收" }], source: { kind: "user" } });
  messages.push({ role: "assistant", content: [{ type: "text", text: "助手回复：" + AST }], source: { kind: "assistant" } });
  messages.push({ role: "assistant", content: [{ type: "tool_call", name: "Bash", arguments: { command: "echo " + TOOL } }, { type: "text", text: "工具调用结果：" + TOOL }], source: { kind: "assistant" } });
  const events = [
    ["todo/write", { todos: [{ content: TODO + " 完成 P2 验收", status: "in_progress" }, { content: "写报告", status: "pending" }] }],
    ["goal/change", { kind: "goal/change", version: 1, operation: "start", goal: { id: "p2g", revision: 1, objective: GOAL + "：P2 检查点升级", phase: "active", maxGoalRounds: 5 }, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() }],
  ];
  const sc = await runScenario("input", { outputs: [build8({})], messages: messages, events: events });
  const CID = "p2i-" + randomUUID();
  const prompt = String((await spawnViaCompaction(sc, CID, HOST_SUMMARY)) || "");
  R.ok(prompt.includes("===== 最近对话原文 =====") || /最近对话原文/.test(prompt), "I1 输入换料：prompt 含「最近对话原文」段标记", prompt.length + " 字");
  R.ok(prompt.includes(QUOTE), "I2 输入换料：含最近用户原话 verbatim（deriveMessages 最新 user 消息标记）", QUOTE);
  R.ok(prompt.includes(AST), "I3 输入换料：含 assistant 文本（助手回复标记）", AST);
  R.ok(prompt.includes("===== 任务与待办 =====") || /任务与待办/.test(prompt), "I4 输入换料：prompt 含「任务与待办」段标记", "");
  R.ok(prompt.includes(TODO), "I5 输入换料：含 todo/write 快照标记（event 缓存）", TODO);
  R.ok(prompt.includes(GOAL), "I6 输入换料：含 goal/change 折叠标记", GOAL);
  R.ok(prompt.includes("P2-HOST-"), "I7 输入换料：仍含宿主压缩摘要标记（摘要保留）", "");
  // 对话原文段 ≤8000 字且从最旧截断
  let dialogue = "";
  const mi = prompt.indexOf("===== 最近对话原文");
  if (mi >= 0) {
    const rest = prompt.slice(mi);
    const next = rest.indexOf("\n===== ", 1);
    dialogue = (next >= 0 ? rest.slice(0, next) : rest);
  } else {
    dialogue = prompt;   // 无段标记时退化为整 prompt（不想因格式差异放过长度断言）
  }
  R.ok(dialogue.length <= 8000 + 300, "I8 对话原文 ≤8000 字（含段标题容差 300）", "dialogueLen=" + dialogue.length + " hasMarker=" + (mi >= 0));
  R.ok(!prompt.includes(OLD), "I9 对话原文从最旧截断：最旧消息标记被丢弃（不越过 8000 预算）", "oldPresent=" + prompt.includes(OLD));
  if (prompt.includes(TOOL)) R.ok(true, "I10 工具调用一行摘要：含 tool 标记（加分项）", TOOL);
  else R.warn("I10 工具调用一行摘要：未见 tool 标记（实现可能只取文本消息；任务书要求『工具调用/结果的一行摘要』，建议实现方确认）", "");
}

// ═══════════════════════════ B：预算与护栏（总 ≤3000 + 删序） ═══════════════════════════
{
  const GUID_KEEP = randomUUID();
  const GUID_DROP = randomUUID();
  // case1：只有「未决问题」超限 ⇒ 只删它
  const sizes1 = { 本次目标: 180, 当前状态: 360, 下一步行动: 180, 关键结论: 360, 文件与代码: 260, 错误与修复: 260, 任务与待办: 180, 未决问题: 1400 };
  const text1 = build8({ sizes: sizes1, marks: { 关键结论: "保留字面量 " + GUID_KEEP, 文件与代码: "待删字面量 " + GUID_DROP } });
  const sc1 = await runScenario("budget1", { outputs: [text1] });
  const CID1 = "p2b1-" + randomUUID();
  await spawnViaCompaction(sc1, CID1, HOST_SUMMARY);
  const md1 = readMd(sc1.h);
  const body1 = intentBody(md1);
  R.ok(md1.includes("<!-- intent: " + CID1), "B1 前置：超限输出仍落盘（走护栏裁剪，不是直接丢弃）", "bodyLen=" + body1.length);
  R.ok(body1.length > 0 && body1.length <= 3050, "B2 总输出 ≤3000 字（实测 " + body1.length + "，含标记容差）", "bodyLen=" + body1.length);
  R.ok(hasSection(body1, "本次目标") && hasSection(body1, "当前状态") && hasSection(body1, "下一步行动") && hasSection(body1, "关键结论"), "B3 前三节 + 关键结论不删（本次目标/当前状态/下一步行动/关键结论）", "");
  R.ok(!hasSection(body1, "文件与代码") && !hasSection(body1, "错误与修复"), "B4 删序①：超限先删「文件与代码」（次删错误与修复）", "");
R.ok(hasSection(body1, "未决问题"), "B4b 删序①：未决问题不再先被删（反转后保留）", "");
R.ok((body1.match(/> 预算压缩：/g) || []).length === 1 && /session_search sid8=/.test(body1), "B4c 归一后末尾追加一条回溯指针（含 sid8）", (body1.match(/> 预算压缩：[^\n]*/) || [""])[0]);
  R.ok(hasSection(body1, "任务与待办") && hasSection(body1, "未决问题"), "B5 只删文件/错误时其余节保留（任务/未决仍在）", "");
  R.ok(body1.includes(GUID_KEEP), "B6 保留节里的字面量逐字保留（关键结论 GUID）", GUID_KEEP);
  R.ok(!body1.includes(GUID_DROP) && !hasPartialLiteral(body1, GUID_DROP), "B7 被删节里的字面量整段消失（无半截）", "");
}
{
  // case2：未决+任务 都需删 ⇒ 删序 未决 → 任务
  const sizes2 = { 本次目标: 180, 当前状态: 360, 下一步行动: 180, 关键结论: 360, 文件与代码: 260, 错误与修复: 260, 任务与待办: 1400, 未决问题: 1400 };
  const text2 = build8({ sizes: sizes2 });
  const sc2 = await runScenario("budget2", { outputs: [text2] });
  const CID2 = "p2b2-" + randomUUID();
  await spawnViaCompaction(sc2, CID2, HOST_SUMMARY);
  const body2 = intentBody(readMd(sc2.h));
  R.ok(body2.length > 0 && body2.length <= 3050, "B8 case2 总输出 ≤3000", "bodyLen=" + body2.length);
  R.ok(!hasSection(body2, "文件与代码") && !hasSection(body2, "错误与修复") && !hasSection(body2, "任务与待办"), "B9 删序②：文件→错误→任务 依次删（至 ≤3000 为止）", "");
  R.ok(hasSection(body2, "未决问题"), "B10 删序②：未决问题保留（新序最后才删）", "");
}
{
  // case3：未决+任务+错误 都需删 ⇒ 删序 未决 → 任务 → 错误；文件保留
  //   注：造数总长必须 ≤4000（compactOnce 输出硬截 4000，超了会先被截断成缺节 ⇒ 校验拒绝，不是护栏问题）。
  //   取 总≈3880：删未决400→3480>3000；删任务400→3080>3000；删错误800→2280≤3000 ⇒ 三道全删、文件保留。
  const sizes3 = { 本次目标: 180, 当前状态: 360, 下一步行动: 180, 关键结论: 360, 文件与代码: 1200, 错误与修复: 800, 任务与待办: 400, 未决问题: 400 };
  const text3 = build8({ sizes: sizes3 });
  const sc3 = await runScenario("budget3", { outputs: [text3] });
  const CID3 = "p2b3-" + randomUUID();
  await spawnViaCompaction(sc3, CID3, HOST_SUMMARY);
  const body3 = intentBody(readMd(sc3.h));
  R.ok(body3.length > 0 && body3.length <= 3050, "B11 case3 总输出 ≤3000", "bodyLen=" + body3.length);
  R.ok(!hasSection(body3, "文件与代码") && hasSection(body3, "错误与修复") && hasSection(body3, "任务与待办"), "B12 删序③：先删文件与代码（1200）；错误/任务仍在（至 ≤3000 即停）", "");
  R.ok(hasSection(body3, "未决问题"), "B13 删序③：未决问题保留（删序最后一个，本 case 未动）", "");
R.ok((body3.match(/> 预算压缩：/g) || []).length === 1, "B13b case3 也只在末尾一条指针", "");
  R.ok(hasSection(body3, "本次目标") && hasSection(body3, "关键结论"), "B14 删序不会动前三节+关键结论", "");
}

// ═══════════════════════════ J：注入端（槽 3000 + 历史三节兼容） ═══════════════════════════
{
  useHome(mkHome("p2-inject"));
  const mod = await freshPlugin();
  const SUMB = mod.SUMMARY_SLOT_BUDGET;
  R.ok(!!SUMB && Number(SUMB.checkpoint) === 3000, "J1 注入槽：SUMMARY_SLOT_BUDGET.checkpoint === 3000", SUMB ? JSON.stringify(SUMB) : "null");
  const f = mod.__buildSummaryInjection || mod.buildSummaryInjection;
  if (typeof f !== "function") {
    R.skip("J2/J3 buildSummaryInjection 直测", "缺 buildSummaryInjection 导出");
  } else {
    const o1 = (() => { try { return f({ checkpoint: "检查点正文 " + "字".repeat(3500) }); } catch (e) { return { __threw: e }; } })();
    R.ok(!o1.__threw && Number(o1.budget) === 5000, "J2 buildSummaryInjection 默认总预算 4500→5000", o1 && o1.budget);
    const THREE = "## 本次目标\n- 历史三节检查点：目标 L-1\n## 下一步行动\n- 继续 L-2\n## 关键结论\n- 结论 L-3 字面量 " + randomUUID();
    const o2 = (() => { try { return f({ checkpoint: THREE }); } catch (e) { return { __threw: e }; } })();
    const t2 = String((o2 && o2.text) || "");
    R.ok(!o2.__threw && t2.includes("## 本次目标") && t2.includes("## 下一步行动") && t2.includes("## 关键结论"), "J3 历史三节文本经 buildSummaryInjection 正常注入（标题与内容都在）", "len=" + t2.length);
  }
  // J4：agent/created 真注入面 —— 历史三节当日摘要仍可注入
  const h = useHome(mkHome("p2-inject-e2e"));
  fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"),
    "## 通用块\n\n### 本次目标\n- 历史三节：目标 E2E-1\n### 下一步行动\n- 继续 E2E-2\n### 关键结论\n- 结论 E2E-3\n", "utf8");
  const mod2 = await freshPlugin();
  const { ctx, handlers } = makeCtx({ subagents: null });
  applyPlugin(mod2, CFG_ON, ctx);
  await waitTopicDb(mod2);
  const { agent, injected } = mkAgent("session-p2-inject", { origin: "user", cwd: "C:\\acc\\ws" });
  await callCreated(handlers, agent, 900);
  const texts = injected.map(msgText);
  const sums = summaryInjections(texts);
  const all = sums.join("\n");
  R.ok(sums.length > 0 && all.includes("本次目标") && all.includes("E2E-1"), "J4 历史三节检查点经 agent/created 注入面正常（标题/内容可见，不报错）", "sumBlocks=" + sums.length);
}

// ═══════════════════════════ T：静态启发式（WARN，不计失败） ═══════════════════════════
try {
  const src = fs.readFileSync(TARGET, "utf8");
  const a = src.indexOf("const INTENT_INSTRUCTION");
  const region = a >= 0 ? src.slice(a, a + 6000) : "";
  let lastPos = -1, okOrder = true, present = 0;
  for (const n of TITLES) {
    const p = region.indexOf("## " + n);
    if (p >= 0) present++; else okOrder = false;
    if (p >= 0 && p <= lastPos) okOrder = false;
    lastPos = p;
  }
  if (present === 8 && okOrder) R.ok(true, "T1 静态：INTENT_INSTRUCTION 区域含 8 节标题且顺序正确");
  else R.warn("T1 静态：INTENT_INSTRUCTION 区域未见完整 8 节标题/顺序（启发式；以 S1/S2 端到端为准）", "present=" + present + "/8 orderOk=" + okOrder);
  if (/最近对话原文/.test(src)) R.ok(true, "T2 静态：源码含「最近对话原文」输入段标记");
  else R.warn("T2 静态：源码未见「最近对话原文」标记（启发式）", "");
  if (/任务与待办/.test(src)) R.ok(true, "T3 静态：源码含「任务与待办」输入段标记");
  else R.warn("T3 静态：源码未见「任务与待办」标记（启发式）", "");
  const has3000 = /3000/.test(src) && /EXTERNAL|INTENT|CHECKPOINT/i.test(src);
  if (has3000) R.ok(true, "T4 静态：源码出现 3000 量级常量（检查点/事实包预算线索，启发式）");
  else R.warn("T4 静态：未见 3000 常量线索（启发式）", "");
} catch (e) {
  R.warn("T 静态启发式检查失败（不影响结论）", e && e.message ? e.message : String(e));
}

finish(R);
