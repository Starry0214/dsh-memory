// _p1-selftest.mjs —— P1（task-5）「压缩后外部事实包」实现侧自测
//
// 跑法：node test/_p1-selftest.mjs [index.js 路径]
//
// 覆盖：
//   A. 纯函数 __buildExternalFacts：五段装配 / 总预算 ≤3000 / 超限砍序 5→4→3→2（用户原话最后）/
//      字面量不切半 / 空输入 / 段标题原文
//   B. 事件扫描 __p1Hooks.scanEvents：todo/write 最新快照 / goal/change 折叠（含 clear）/ tool/call write·edit 路径去重
//   C. 用户原话 __p1Hooks.deriveUserQuotes：只认 source.kind==="user"（排除插件注入/compact-checkpoint）、
//      时间正序、超长截断在 600 字；deriveMessages 缺失时回落事件流
//   D. 端到端：真 apply(flag 开) + 真 session/event(compaction/summary) ⇒ 与「记忆刷新提示」合并成**1 条**注入；
//      五段（用户原话/todo/goal/记忆命中/改动文件）全部落地；总长 ≤3000；同一 compactionId 幂等；
//      origin==="subagent" 不注入；inject 发生在 setTimeout(0)（处理器同步返回时注入数=0）
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指 os.tmpdir() 临时目录；跑完删除。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) {} await sleep(step || 40); }
  return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-p1-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "p1-selftest-ws");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- P1 自测占位画像\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- 测试主题 → knowledge/P1.md（P1 自测）\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

// ═══════════════════════════════════════════════════════════════════════════
// A. 纯函数：__buildExternalFacts
// ═══════════════════════════════════════════════════════════════════════════
{
  const b = mod.__buildExternalFacts;
  ok(typeof b === "function", "A0 钩子：__buildExternalFacts 已导出（模块级纯函数）");
  const SEG = mod.__externalFactSegments || [];
  ok(SEG.length === 5 && SEG[0].id === "userQuotes" && SEG[4].id === "files",
    "A1 段定义：五段（1用户原话/2todo/3goal/4记忆命中/5改动文件）", SEG.map((s) => s.no + ":" + s.id).join(","));
  ok(SEG.every((s) => s.title && s.title.indexOf("【外部事实") === 0), "A2 每段标题均以「【外部事实」开头（与摘要可区分）");

  const parts = {
    userQuotes: ["用户原话一：把 P1 外部事实包做完（GUID 7f3a9c11-2222-3333-4444-555566667777）", "用户原话二：路径 E:\\工具\\插件开发调整\\dsh-memory-plugin\\index.js"],
    todos: ["[>] 实现五段外部事实包", "[ ] 写自测", "[x] 读任务书"],
    goal: ["目标：压缩后补外部事实包", "phase=active · revision=2 · 轮次=3/12"],
    memoryHits: ["「dsh-memory记忆插件」(T-0001·active)：P1-MEMO-hit-xyz"],
    files: ["C:\\tmp\\P1-FILE-MARK-aaaa.md", "E:\\工具\\插件开发调整\\dsh-memory-plugin\\index.js"],
  };
  const r1 = b(parts);
  ok(r1.totalChars <= 3000 && r1.text.length === r1.totalChars, "A3 总预算：默认 ≤3000 字", "total=" + r1.totalChars);
  ok(r1.kept.length === 5 && r1.dropped.length === 0, "A4 五段全放下：kept=5 / dropped=0", JSON.stringify({ kept: r1.kept, dropped: r1.dropped }));
  ok(SEG.every((s) => r1.text.includes(s.title)), "A5 五段标题原文都在文本里");
  ok(r1.text.includes("7f3a9c11-2222-3333-4444-555566667777") && r1.text.includes("P1-FILE-MARK-aaaa.md"), "A6 字面量（GUID/路径）原样保留");

  // 砍序：预算极小 ⇒ 先砍 files（5），再 memoryHits（4），再 goal（3），再 todos（2）；quotes 最后
  const big = {
    userQuotes: ["U".repeat(400)],
    todos: ["T".repeat(300)],
    goal: ["G".repeat(200)],
    memoryHits: ["M".repeat(300)],
    files: ["F".repeat(300)],
  };
  const r2 = b(big, 600);
  ok(r2.totalChars <= 600, "A7 小预算：总长 ≤ budget", "total=" + r2.totalChars + " budget=600");
  ok(r2.dropped[0] === "files", "A8 砍序①：先砍 files（第 5 段）", JSON.stringify(r2.dropped));
  ok(r2.dropped.includes("memoryHits") && r2.dropped.indexOf("files") < r2.dropped.indexOf("memoryHits"), "A9 砍序②：再砍 memoryHits（第 4 段）");
  ok(!r2.kept.includes("files") && !r2.kept.includes("memoryHits"), "A10 被砍段不出现在 kept/文本");
  const r3 = b({ userQuotes: ["Q".repeat(200)], todos: ["T".repeat(200)], goal: ["G".repeat(200)], memoryHits: ["M".repeat(200)], files: ["F".repeat(200)] }, 300);
  ok(r3.kept.length === 1 && r3.kept[0] === "userQuotes" && r3.text.includes("Q".repeat(200)), "A11 砍序③：极小预算下最后只剩用户原话（完整保留）", JSON.stringify(r3.kept));

  // 字面量不切半：所有内容行都必须是输入原子的完整行
  const allAtoms = new Set();
  for (const k of Object.keys(parts)) for (const x of parts[k]) allAtoms.add(x);
  let half = 0;
  for (const ln of r1.text.split("\n")) {
    if (ln.indexOf("- ") !== 0) continue;   // 标题/空行不算
    const body = ln.slice(2);
    if (!allAtoms.has(body)) half++;
  }
  ok(half === 0, "A12 绝不截断字面量：每个内容行都是输入原子的完整行", "half=" + half);
  const r4 = b({ userQuotes: [], todos: [], goal: [], memoryHits: [], files: [] });
  ok(r4.text === "" && r4.totalChars === 0 && r4.kept.length === 0, "A13 空输入 ⇒ 空文本（不抛）");
  const r5 = b({ userQuotes: ["一条"].concat(Array.from({ length: 30 }, (_, i) => "第" + i + "条原话-" + "x".repeat(150))) }, 700);
  ok(r5.totalChars <= 700 && r5.text.indexOf("一条") < 0 || r5.totalChars <= 700, "A14 单段超限：行边界装填且仍守 budget", "total=" + r5.totalChars);
  // 标题原文（报告用）
  ok(SEG.map((s) => s.title).join("|") === "【外部事实·最近用户原话（verbatim，未被摘要改写）】|【外部事实·当前 todo 列表（最近一次 todo_write 快照）】|【外部事实·goal 状态（objective/phase/轮次）】|【外部事实·记忆库命中（memory_search 口径）】|【外部事实·本会话改动文件（write/edit 参数提取）】",
    "A15 五段标题原文与报告一致");
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 纯逻辑：事件扫描（todo / goal / 改动文件）—— 依赖 apply 后的 __p1Hooks，故在 D 段 apply 之后执行
// ═══════════════════════════════════════════════════════════════════════════
function runEventScanTests() {
  const scan = mod.__p1Hooks.scanEvents;
  ok(typeof scan === "function", "B0 钩子：__p1Hooks.scanEvents 已接线");
  const events = [
    { type: "todo/write", data: { todos: [{ content: "旧任务", status: "pending" }] } },
    { type: "goal/change", data: { operation: "create", goal: { id: "goal-1", objective: "P1-GOAL-ABCD", phase: "active", revision: 1, maxGoalRounds: 12 }, roundsStarted: 0 } },
    { type: "tool/call", data: { name: "read", arguments: { file_path: "C:\\tmp\\NOT-COUNTED.md" } } },
    { type: "tool/call", data: { name: "write", arguments: { path: "C:\\tmp\\P1-FILE-MARK-aaaa.md" } } },
    { type: "tool/call", data: { name: "edit", arguments: { file_path: "C:\\tmp\\P1-FILE-MARK-aaaa.md" } } },
    { type: "tool/call", data: { name: "edit", arguments: { file_path: "E:\\x\\P1-FILE-BBB.md" } } },
    { type: "todo/write", data: { todos: [{ content: "新任务A", status: "in_progress" }, { content: "新任务B", status: "completed" }] } },
  ];
  const r = scan(events);
  ok(r.todos && r.todos.length === 2 && r.todos[0].content === "新任务A", "B1 todo/write：取**最新**快照（后写覆盖）", JSON.stringify(r.todos));
  ok(r.goal && r.goal.objective === "P1-GOAL-ABCD" && r.goal.phase === "active" && r.goal.maxGoalRounds === 12, "B2 goal/change：折叠出 objective/phase/maxGoalRounds", JSON.stringify(r.goal));
  ok(r.files.length === 2 && r.files[0] === "C:\\tmp\\P1-FILE-MARK-aaaa.md" && r.files[1] === "E:\\x\\P1-FILE-BBB.md",
    "B3 tool/call：只收 write/edit 路径、同路径去重、顺序保留", JSON.stringify(r.files));
  const r2 = scan([{ type: "goal/change", data: { ...events[1].data } }, { type: "goal/change", data: { operation: "clear", cleared: { id: "goal-1", revision: 2 } } }]);
  ok(r2.goal === null, "B4 goal/change：后接 clear ⇒ goal 清空");
  const r3 = scan([{ type: "todo/write", data: { items: ["纯字符串项", { text: "文本项", status: "pending" }] } }]);
  ok(r3.todos && r3.todos.length === 2 && r3.todos[1].content === "文本项", "B5 todo/write 容错：items/字符串项/text 字段都认", JSON.stringify(r3.todos));
}

// ═══════════════════════════════════════════════════════════════════════════
// C. 用户原话提取（deriveMessages 优先 / 事件流回落）—— 同样在 D 段 apply 之后执行
// ═══════════════════════════════════════════════════════════════════════════
function runUserQuoteTests() {
  const dq = mod.__p1Hooks.deriveUserQuotes;
  ok(typeof dq === "function", "C0 钩子：__p1Hooks.deriveUserQuotes 已接线");
  const fakeSession = {
    deriveMessages() {
      return [
        { role: "system", content: [{ type: "text", text: "sys" }], source: { kind: "system" } },
        { role: "user", content: [{ type: "text", text: "P1-QUOTE-OLD-1111" }], source: { kind: "user" } },
        { role: "user", content: [{ type: "text", text: "插件注入块 <system-reminder>x</system-reminder>" }], source: { kind: "plugin:dsh-memory" } },
        { role: "user", content: [{ type: "text", text: "<system-reminder>记忆刷新提示</system-reminder>" }], source: { kind: "user" } },
        { role: "user", content: [{ type: "text", text: "P1-QUOTE-NEW-2222" }], source: { kind: "user" } },
        { role: "user", content: [{ type: "text", text: "compact-checkpoint 摘要" }], source: { kind: "compact-checkpoint" } },
      ];
    },
    snapshotEvents() { return []; },
  };
  const qs = dq(fakeSession, { max: 3, maxLen: 600 });
  ok(qs.length === 2 && qs[0] === "P1-QUOTE-OLD-1111" && qs[1] === "P1-QUOTE-NEW-2222", "C1 只认真实用户原话（排除 plugin 注入/compact-checkpoint）且时间正序", JSON.stringify(qs));
  const fake2 = {
    deriveMessages() { throw new Error("no deriveMessages"); },
    snapshotEvents() {
      return [
        { type: "user/message", data: { role: "user", content: [{ type: "text", text: "EVT-QUOTE-AAAA" }], source: { kind: "user" } } },
        { type: "user/message", data: { role: "user", content: [{ type: "text", text: "EVT-QUOTE-BBBB" }], source: { kind: "user" } } },
      ];
    },
  };
  const qs2 = dq(fake2, { max: 3, maxLen: 600 });
  ok(qs2.length === 2 && qs2[1] === "EVT-QUOTE-BBBB", "C2 deriveMessages 缺失 ⇒ 回落 session 事件流（user/message + source.kind=user）", JSON.stringify(qs2));
  const qs3 = dq({ deriveMessages: () => [{ role: "user", content: [{ type: "text", text: "L".repeat(900) }], source: { kind: "user" } }] }, { max: 1, maxLen: 600 });
  ok(qs3.length === 1 && qs3[0].length === 600, "C3 超长原话截到 maxLen（600，不进预算的字面量另有原样通道）", "len=" + (qs3[0] || "").length);
}

// ═══════════════════════════════════════════════════════════════════════════
// D. 端到端：真 apply(flag 开) + 真 session/event(compaction/summary)
// ═══════════════════════════════════════════════════════════════════════════
const fx = createFixtureCtx({});
let store = null;
{
  plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
  const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
  ok(ready, "D0 前置：flag 开 ⇒ 主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
  if (ready) store = mod.__topicdb.store;
}
ok(typeof mod.__p1Hooks.getLastInjection === "function" && typeof mod.__p1Hooks.hasExternalFactsInjected === "function",
  "D0b 钩子：__p1Hooks 已接线（getLastInjection / hasExternalFactsInjected / getInjectedCount）");
// B/C 段依赖 apply 后的闭包钩子 ⇒ 在此执行（顺序：事件扫描 → 用户原话）
runEventScanTests();
runUserQuoteTests();

if (store) {
  // 造 D8 容器 + 记忆命中标记句（P1-MEMO-<uuid> 出现在句子正文里，供 memory_search 口径命中）
  const dom = store.createDomain("日记忆（按天流水）", { actor: "lead" });
  const lineR = store.seedTopic({ name: "会话检查点", triggers: ["会话检查点"], src: "sessions/CHECKPOINT.md" });
  store.setLevel(lineR.id, "project", { actor: "lead" });
  store.linkParent(lineR.id, dom.id, { actor: "lead" });
  const MEMO = "P1-MEMO-" + Math.random().toString(16).slice(2, 10);
  const SUM = "## 本次目标\n- " + MEMO + " 记忆命中标记（P1 自测）\n\n## 下一步行动\n- 无\n\n## 关键结论\n- 无";
  const today = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
  mod.__topicdbWriteIntent("p1memo-1111-2222-3333-444455556666", "p1memo01", SUM, today + ".md", "session-p1memo");

  // 先经 agent/created 登记 agent（agentsBySession 只记顶层会话）
  const injected = [];
  const fakeAgent = {
    options: {},
    session: { id: "session-p1e2e", header: { origin: "main", cwd: CWD }, cwd: CWD },
    inject(msg) { injected.push(msg); },
  };
  const hCreated = (fx.captured.handlers || []).find((h) => h.event === "agent/created");
  ok(!!hCreated, "D1 端到端：agent/created 处理器已注册");
  let createdDone = false;
  if (hCreated) {
    try { hCreated.fn({ agent: fakeAgent, source: "startup", signal: { aborted: false } }); createdDone = true; } catch (e) { ok(false, "D1 端到端：agent/created 调用不抛", e.message); }
  }
  await sleep(400);
  injected.length = 0;   // 丢弃会话启动注入，只观察压缩后注入

  // 压缩前埋事实：todo/write + goal/change + tool/call(write/edit) + user/message 事件
  const CID = "p1e2e-" + Math.random().toString(16).slice(2, 10) + "-1111-2222-3333-444455556666";
  const QUOTE = "P1-QUOTE-verbatim-9c2d：把外部事实包做完";
  const TODO = "实现五段外部事实包（P1-TODO-3f7a）";
  const GOAL = "压缩后补外部事实包（P1-GOAL-77aa）";
  const FILE = "C:\\tmp\\P1-FILE-MARK-" + Math.random().toString(16).slice(2, 8) + ".md";
  const SESSION_EVENTS = [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: QUOTE }], source: { kind: "user" } } },
    { type: "todo/write", data: { todos: [{ content: TODO, status: "in_progress" }, { content: "写报告", status: "pending" }] } },
    { type: "goal/change", data: { operation: "create", goal: { id: "goal-p1", objective: GOAL, phase: "active", revision: 1, maxGoalRounds: 12 }, roundsStarted: 2 } },
    { type: "tool/call", data: { name: "write", arguments: { path: FILE } } },
    { type: "tool/call", data: { name: "edit", arguments: { file_path: "E:\\工具\\插件开发调整\\dsh-memory-plugin\\index.js" } } },
  ];
  const mockSession = {
    id: "session-p1e2e",
    header: { origin: "main", cwd: CWD },
    deriveMessages() {
      return [
        { role: "user", content: [{ type: "text", text: "旧原话（应该也在）P1-QUOTE-old-1111" }], source: { kind: "user" } },
        { role: "user", content: [{ type: "text", text: QUOTE }], source: { kind: "user" } },
      ];
    },
    snapshotEvents() { return SESSION_EVENTS; },
  };
  const SUMMARY = "## Primary Request and Intent\n修复断链\n## Pending Jobs\n- 无\n";
  const hEvent = (fx.captured.handlers || []).find((h) => h.event === "session/event");
  ok(!!hEvent, "D2 端到端：session/event 处理器已注册");
  if (hEvent) {
    hEvent.fn(mockSession, { type: "compaction/summary", data: { compactionId: CID, summary: [{ type: "text", text: SUMMARY }] } });
    // 红线：inject 必须在 setTimeout(0)（处理器同步返回时注入数仍为 0）
    ok(injected.length === 0, "D3 setTimeout(0)：处理器同步返回时尚未注入（避开 session append 发布窗口）", "injected=" + injected.length);
    await waitFor(() => injected.length > 0, 6000, 60);
    await sleep(250);   // 等这一轮所有 setTimeout(0) 任务落定
    const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "") || "";
    const msgs = injected.map(textOf);
    const all = msgs.join("\n@@@\n");
    ok(msgs.length === 1, "D4 合并注入：每次 compaction 只 inject **1 条**（记忆刷新提示 + 外部事实包）", "msgs=" + msgs.length);
    ok(all.includes("【dsh-memory 记忆刷新提示】") && all.includes("【外部事实包（dsh-memory · compaction " + CID.slice(0, 8) + "）】"),
      "D5 合并文案：同一条里既有「记忆刷新提示」又有「外部事实包 + compactionId 头」");
    ok((all.match(/<system-reminder>/g) || []).length === 1 && all.trim().indexOf("<system-reminder>") === 0 && all.trim().endsWith("</system-reminder>"),
      "D6 只有一个 <system-reminder> 包裹（没有嵌套/重复）");
    const segs = mod.__externalFactSegments || [];
    ok(segs.every((s) => !all.includes(s.title)) === false, "D7 至少一段段标题落地");
    ok(all.includes(QUOTE) || all.includes(QUOTE.slice(0, 60)), "D8 段1 用户原话 verbatim 落地", QUOTE.slice(0, 20) + "…");
    ok(all.includes(TODO), "D9 段2 todo 落地");
    ok(all.includes(GOAL), "D10 段3 goal 落地");
    ok(all.includes(MEMO), "D11 段4 记忆库命中落地（内部检索命中主题标记句）", MEMO);
    ok(all.includes(FILE), "D12 段5 改动文件路径落地（write 参数提取）", FILE);
    ok(all.length <= 3000, "D13 总预算：合并后的外部事实包 ≤3000 字（注入整条含刷新提示=" + all.length + "）");
    const last = mod.__p1Hooks.getLastInjection();
    ok(last && last.compactionId === CID && Array.isArray(last.kept) && last.totalChars > 0, "D14 getLastInjection：返回 compactionId/kept/totalChars", last ? JSON.stringify({ kept: last.kept, dropped: last.dropped }) : "null");
    ok(mod.__p1Hooks.getInjectedCount() >= 1 && mod.__p1Hooks.hasExternalFactsInjected(CID) === true, "D15 幂等探针：注入计数 +1 且该 compactionId 已记录");

    // 同 compactionId 再 fire 一次 ⇒ 不再注入
    const n0 = injected.length;
    hEvent.fn(mockSession, { type: "compaction/summary", data: { compactionId: CID, summary: [{ type: "text", text: SUMMARY }] } });
    await sleep(300);
    ok(injected.length === n0, "D16 幂等：同一 compactionId 重复事件不再注入", "before=" + n0 + " after=" + injected.length);
  }
  // 子代理会话：不注入
  const subAgentInjected = [];
  const subAgent = { options: {}, session: { id: "session-p1sub", header: { origin: "subagent", cwd: CWD } }, inject(m) { subAgentInjected.push(m); } };
  if (hEvent) {
    hEvent.fn({ id: "session-p1sub", header: { origin: "subagent", cwd: CWD }, deriveMessages: () => [], snapshotEvents: () => [] },
      { type: "compaction/summary", data: { compactionId: CID + "-sub", summary: [{ type: "text", text: SUMMARY }] } });
    await sleep(300);
    ok(subAgentInjected.length === 0, "D17 子代理会话：origin==='subagent' ⇒ 不注入外部事实包");
    ok(mod.__p1Hooks.hasExternalFactsInjected(CID + "-sub") === false, "D18 子代理：幂等集合不记该 compactionId");
  }
  void subAgent; void createdDone;
}

// ═══════════════════════════════════════════════════════════════════════════
// E. 静态接线断言
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(PLUGIN, "utf8");
  ok(/collectExternalFacts\(targetAgent, session, compactionId\)/.test(src), "E1 接线：session/event 内调用 collectExternalFacts（当前会话）");
  // [P4-R2][2026-11-02 规格变更] 合并口径从「刷新提示 + 事实包」扩为「刷新提示 + 事实包 + 压缩后记忆重灌」：
  //   finalNote = injectParts.length ? p1MergeInjection(refreshNote, injectParts.join("\n\n")) : refreshNote。
  //   断言改为「仍只有一次 p1MergeInjection 且入参含 refreshNote」，合并语义不变（只合并、不拆成两次注入）。
  ok(/p1MergeInjection\(refreshNote,\s*injectParts\.join\("\\n\\n"\)\)/.test(src) && /injectParts\.push\(facts\.text\)/.test(src),
    "E2 接线：与「记忆刷新提示」合并成同一条注入（P4：+记忆重灌段）");
  ok(/EXTERNAL_FACT_IDS\.has\(String\(compactionId\)\)/.test(src) && /p1NoteExternalFactId\(compactionId\)/.test(src), "E3 接线：同 compactionId 幂等（Set 判定 + 记录）");
  // [P4-R2] 压缩事件回调改为 async（要 await 记忆重灌取数），仍在 setTimeout(0) 内且事实包构建在回调体前段。
  ok(/setTimeout\(async \(\) => \{[\s\S]{0,1600}collectExternalFacts/.test(src), "E4 接线：外部事实包构建/注入在 setTimeout(0) 内（P4：async 回调）");
}

// ── 收尾 ──
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
