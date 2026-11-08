// _p0-impl-selftest.mjs —— P0（task-3）「检查点断链三改动」实现侧自测
//
// 跑法：node test/_p0-impl-selftest.mjs [index.js 路径]
//
// 覆盖：
//   P0-1（G2）注入端先读主题库、读不到回落 md：
//     · topicDbReadIntentSummary 纯函数（读 D8「会话检查点」线 → 最近 7 天日期主题 → 句子，最新在前）
//     · latestSessionSummary：flag 开 + 库内有句子 ⇒ source="db"；flag 关/库空 ⇒ 逐字回落原 md 扫描
//     · 非当日语义（fake now 让"今天"没有主题 ⇒ 命中昨天且 isToday=false）
//     · 项目隔离：dbCheckpointSlice 整句过滤（命中项目词才保留 / 0 命中返回 hit=0）
//     · 端到端：真 apply + 真触发 agent/created ⇒ 注入消息里出现库内检查点原文（断链已通）
//   P0-2（G3）失败不丢：
//     · spawnIntentCheckpoint 失败 ⇒ .integrate.json `intentRetry` 入队、未进 archivedCompactionIds
//     · 同 id 再失败 ⇒ 队列只留 1 条且 attempts 递增（退避 1min）
//     · force 补火成功 ⇒ 队列清空 + archivedCompactionIds 命中 + 库内句子 +1
//     · 连续失败 4 次 ⇒ 熔断丢弃（retry=false + 队列无该条 + .monitor.json 有 retry-breaker）
//   P0-3 注入预算分槽：
//     · buildSummaryInjection 总长 ≤ budget、槽位上限、超限砍序（taskState → userQuotes → checkpoint 最后）
//     · 字面量不被截断（长行/URL/路径整行保留或整行丢弃，不做半行）
//     · 端到端：agent/created 注入消息含「最近用户原话 / 任务状态」两槽与原文
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全部指向 os.tmpdir() 下临时目录；
//   绝不读写真实 ~/.dsh/memory（除本文件不涉及）。跑完删临时目录。
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
  while (Date.now() - t0 < (ms || 5000)) {
    try { if (fn()) return true; } catch (e) { /* 继续等 */ }
    await sleep(step || 50);
  }
  return false;
}
const dayStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
};

// ── 临时 home / memory（绝不碰真实 ~/.dsh）──────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-p0-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "p0-selftest-ws");   // 深路径（自动建档会用它做 project key）
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- P0 自测占位画像\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

// ═══════════════════════════════════════════════════════════════════════════
// 一、P0-3 纯函数：buildSummaryInjection
// ═══════════════════════════════════════════════════════════════════════════
{
  const b = mod.__buildSummaryInjection;
  ok(typeof b === "function", "P0-3 钩子：__buildSummaryInjection 已导出");
  const mkCp = (n) => Array.from({ length: n }, (_, i) => "## 第" + i + "段\n- 内容-" + i + "-" + "x".repeat(40)).join("\n");
  const cpLong = mkCp(160);   // ≈ 9.6k 字符，远超 2500（验证"检查点正文槽 ≥2500"）
  const cpMid = "## 本次目标\n- " + "y".repeat(1200) + "\n## 下一步行动\n- " + "z".repeat(1200) + "\n## 关键结论\n- ok";   // ≈2.44k
  const cpMid3k = mkCp(55);   // ≈3.4k：三槽全放得下（验证两槽标题都在）
  const quotesSmall = ["用户原话一：把 P0 的检查点断链修了", "用户原话二：URL 逐字保留 https://example.com/a/b?x=1&y=2"];
  const quotesLong = ["用户原话一：" + "把 P0 的检查点断链修了并且逐字保留用户原话".repeat(100), "用户原话二：URL 逐字保留 https://example.com/a/b?x=1&y=2"];
  const taskSmall = "待办：补自测；下一步：写报告";
  const taskLong = "待办：补自测脚本；当前工作：P0 三处改动；下一步：写报告；" + "细节".repeat(200);
  const r1 = b({ checkpoint: cpMid3k, userQuotes: quotesSmall, taskState: taskSmall });
  ok(r1 && r1.totalChars <= 4500 && r1.text.length === r1.totalChars, "P0-3 总长≤budget(4500)", "total=" + (r1 && r1.totalChars));
  ok(r1.slots.checkpoint.length >= 2500, "P0-3 检查点正文槽 ≥2500", "cp=" + r1.slots.checkpoint.length);
  ok(r1.slots.userQuotes.length <= 1500 && r1.slots.taskState.length <= 500,
    "P0-3 用户原话 ≤1500 / 任务状态 ≤500", "uq=" + r1.slots.userQuotes.length + " ts=" + r1.slots.taskState.length);
  ok(/【最近用户原话/.test(r1.text) && /【任务状态/.test(r1.text), "P0-3 文本含两槽标题");
  const r0 = b({ checkpoint: cpLong, userQuotes: [], taskState: "" });
  ok(r0.slots.checkpoint.length >= 2500 && r0.totalChars <= 4500, "P0-3 超长正文被截到 ≥2500 且总长≤budget", "cp=" + r0.slots.checkpoint.length + " total=" + r0.totalChars);
  // 超限砍序：cpMid+长原话+长任务 超 budget 4300 ⇒ 先砍 taskState 而**保留** userQuotes
  const r2 = b({ checkpoint: cpMid, userQuotes: quotesLong, taskState: taskLong, budget: 4300 });
  ok(r2.totalChars <= 4300, "P0-3 预算收紧后总长≤4300", "total=" + r2.totalChars + " dropped=" + JSON.stringify(r2.dropped));
  ok(r2.slots.taskState === "" && r2.slots.userQuotes.length > 0,
    "P0-3 砍序①：超限先整槽砍 taskState，userQuotes 保留", JSON.stringify(r2.dropped));
  const r3 = b({ checkpoint: cpMid, userQuotes: quotesLong, taskState: taskLong, budget: 2000 });
  ok(r3.totalChars <= 2000 && r3.slots.taskState === "" && r3.slots.userQuotes === "" && r3.slots.checkpoint.length > 0,
    "P0-3 砍序②：再砍 userQuotes，checkpoint 最后", JSON.stringify(r3.dropped) + " total=" + r3.totalChars);
  // 字面量不被截断：整行保留或整行丢弃（不出现半行）
  const cpLit = "## 本次目标\n- 修 handler：E:\\工具\\插件开发调整\\dsh-memory-plugin\\index.js#L15510-L15580\n- URL https://example.com/a/very-long-path?q=1\n## 关键结论\n- OK";
  const r4 = b({ checkpoint: cpLit, userQuotes: [], taskState: "" });
  const keepLines = r4.text.split("\n").filter(Boolean);
  let halfLine = 0;
  for (const ln of keepLines) if (!cpLit.includes(ln)) halfLine++;
  ok(halfLine === 0, "P0-3 字面量不截断：输出每行都是原文完整行", "halfLine=" + halfLine);
  ok(r4.text.includes("https://example.com/a/very-long-path?q=1"), "P0-3 URL 原文完整保留");
  const r5 = b({});
  ok(r5 && r5.text === "" && r5.totalChars === 0, "P0-3 空输入 ⇒ 空文本（不抛）");
  // 预算富余时正文可 >2500（不因单槽上限把检查点截短）
  const r6 = b({ checkpoint: "行".repeat(3000), userQuotes: [], taskState: "" });
  ok(r6.slots.checkpoint.length > 2500 || r6.dropped.includes("checkpoint:truncated"), "P0-3 富余预算给正文（>2500 或明示截断）", "cp=" + r6.slots.checkpoint.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、启动插件（flag 开）+ 造 D8 容器 + 端到端 P0-1/P0-3
// ═══════════════════════════════════════════════════════════════════════════
const fx = createFixtureCtx({});
let store = null;
{
  plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
  const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
  ok(ready, "前置：flag 开 ⇒ 主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
  if (ready) store = mod.__topicdb.store;
}
ok(typeof mod.__p0Hooks === "object" && mod.__p0Hooks.latestSessionSummary, "前置：__p0Hooks 已接线（apply 内赋值）");
ok(mod.__p0Hooks.buildSummaryInjection === mod.__buildSummaryInjection, "前置：__p0Hooks.buildSummaryInjection == 模块导出纯函数");

if (store) {
  const TODAY = dayStr(new Date());
  const dom = store.createDomain("日记忆（按天流水）", { actor: "lead" });
  const lineR = store.seedTopic({ name: "会话检查点", triggers: ["会话检查点"], src: "sessions/CHECKPOINT.md" });
  store.setLevel(lineR.id, "project", { actor: "lead" });
  store.linkParent(lineR.id, dom.id, { actor: "lead" });
  const dayTopicOf = () => store.topics().find((t) => t.parentId === lineR.id && String(t.name) === TODAY) || null;

  // 唯一字面量：同时含自动建档 project key 词（p0-selftest-ws）+ 精确串
  const LIT_CP = "P0-SELFTEST-检查点字面量-4a7b";
  const LIT_QUOTE = "P0-SELFTEST-用户原话-9c2d";
  const LIT_TASK = "P0-SELFTEST-任务状态-1e3f";
  const SUM = "## 本次目标\n- 修复检查点断链（" + LIT_CP + "，项目 p0-selftest-ws）\n\n## 下一步行动\n- 补自测\n\n## 关键结论\n- 写库读库对偶";
  const CID_A = "aaaaaaaa-1111-2222-3333-444455556666";
  const SID8_A = "p0aa1111";
  const wr = mod.__topicdbWriteIntent(CID_A, SID8_A, SUM, TODAY + ".md", "session-" + SID8_A);
  ok(wr && wr.ok === true, "造数：检查点已写主题库（D8 线·当日主题）", wr && wr.topicName);
  ok(!!dayTopicOf(), "造数：当日日期主题存在");

  // P0-3 槽 2/3 的数据源：外部事实快照（正常由 session/event 压缩时 captureRecentSessionFacts 落）
  const integPath = path.join(MEM, ".integrate.json");
  let st0 = {};
  try { st0 = JSON.parse(fs.readFileSync(integPath, "utf8")); } catch (e) { st0 = {}; }
  st0.recentSessionFacts = { at: Date.now(), sid: "session-" + SID8_A, quotes: [{ at: Date.now(), text: LIT_QUOTE }], taskState: LIT_TASK, projKey: "p0-selftest-ws" };
  fs.writeFileSync(integPath, JSON.stringify(st0, null, 2), "utf8");

  // ── P0-1 纯函数：latestSessionSummary 读库 ──
  const ls1 = await mod.__p0Hooks.latestSessionSummary();
  ok(ls1 && ls1.source === "db" && ls1.file === TODAY + ".md" && ls1.isToday === true,
    "P0-1 latestSessionSummary：库内有句子 ⇒ source=db / file=当日 / isToday", ls1 ? JSON.stringify({ source: ls1.source, file: ls1.file, isToday: ls1.isToday }) : "null");
  ok(ls1 && ls1.text.includes(LIT_CP) && ls1.text.includes("## 通用块"), "P0-1 读库正文：含检查点原文 + ## 通用块 骨架");
  ok(ls1 && Array.isArray(ls1.sentences) && ls1.sentences.length >= 1, "P0-1 读库：返回 sentences 数组（项目隔离整句切片用）");

  // 非当日语义：把"今天"伪装成明天 ⇒ 明天无主题 → 命中今天，isToday=false
  const fakeTomorrow = new Date(Date.now() + 86400000);
  const lsNonToday = mod.__topicDbReadIntentSummary(store, { now: fakeTomorrow });
  ok(lsNonToday && lsNonToday.isToday === false && lsNonToday.file === TODAY + ".md",
    "P0-1 非当日：用 fake now 验证「最新有句子的日期」→ isToday=false（保留非当日一行语义的前提）",
    lsNonToday ? JSON.stringify({ file: lsNonToday.file, isToday: lsNonToday.isToday }) : "null");
  // 库内 7 天都无句子 ⇒ null（调用方才回落 md）
  const fakeFar = new Date(Date.now() + 30 * 86400000);
  ok(mod.__topicDbReadIntentSummary(store, { now: fakeFar }) === null, "P0-1 读库：7 天内无句子 ⇒ null（回落 md 的判据）");
  // fake store 不崩（坏库兜底）
  ok(mod.__topicDbReadIntentSummary({ topics() { throw new Error("bad"); } }) === null, "P0-1 读库：异常 store ⇒ null 不抛");

  // ── P0-1 项目隔离整句切片 ──
  const sents = ["## 检查点（甲）\n## 本次目标\n- 甲项目相关", "## 检查点（乙）\n## 本次目标\n- 乙项目相关", "## 检查点（丙）\n## 本次目标\n- 丙项目相关"];
  const sl1 = mod.__dbCheckpointSlice(sents, "甲项目", ["alias甲"], 4000);
  ok(sl1.hit === 1 && sl1.text.includes("甲项目") && !sl1.text.includes("乙项目"), "P0-1 项目隔离：整句命中过滤（只留甲）", JSON.stringify({ hit: sl1.hit }));
  const sl2 = mod.__dbCheckpointSlice(sents, "不存在的项目", [], 4000);
  ok(sl2.hit === 0 && sl2.text === "", "P0-1 项目隔离：0 命中 ⇒ hit=0（调用方走老「一行通知」）");
  const sl3 = mod.__dbCheckpointSlice(sents, "", null, 4000);
  ok(sl3.hit === 3 && sl3.text.includes("甲项目") && sl3.text.includes("丙项目"), "P0-1 项目隔离：未命中项目 ⇒ 全量注入");
  const sl4 = mod.__dbCheckpointSlice(sents, "", null, 20);
  ok(sl4.text.length <= 20 && sl4.hit === 3, "P0-1 项目隔离：预算截断只整句边界（不切半句）", "used=" + sl4.used);

  // ── P0-1/P0-3 端到端：真触发 agent/created → 注入消息 ──
  const injected = [];
  const fakeAgent = {
    options: {},
    session: { id: "session-p0inject01", header: { origin: "main", cwd: CWD }, cwd: CWD },
    inject(msg) { injected.push(msg); },
  };
  const hCreated = (fx.captured.handlers || []).find((h) => h.event === "agent/created");
  ok(!!hCreated, "端到端：agent/created 处理器已注册");
  if (hCreated) {
    try { hCreated.fn({ agent: fakeAgent, source: "startup", signal: { aborted: false } }); } catch (e) { ok(false, "端到端：agent/created 调用不抛", e.message); }
    const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "") || "";
    await waitFor(() => injected.some((m) => textOf(m).includes("【最近一次会话压缩点】")), 6000, 80);
    const all = injected.map(textOf).join("\n\n@@@\n\n");
    ok(all.includes(LIT_CP), "P0-1 端到端：注入消息包含**主题库内**检查点原文（G2 断链已修）");
    ok(/【最近用户原话/.test(all) && all.includes(LIT_QUOTE), "P0-3 端到端：注入含「最近用户原话」槽与原文");
    ok(/【任务状态/.test(all) && all.includes(LIT_TASK), "P0-3 端到端：注入含「任务状态」槽与原文");
    // 项目隔离命中路径：CWD 自动建档 project key = p0-selftest-ws，检查点句含该词 ⇒ 应命中断句而非 0 命中通知
    ok(!/当日无「/.test(all) || all.includes(LIT_CP), "P0-1 端到端：项目命中路径未落入 0 命中通知（含原文即可）");

    // ── [P0.1 补丁 §6.1][隐私] 当前会话**无项目归属** ⇒ 不掺外部事实（只注检查点正文）──
    //   用浅路径（<4 段）让 ensureProjectForCwd 不建档、matchProjectByCwd 无命中 ⇒ p0ProjKey=""。
    const injectedNoProj = [];
    const fakeAgentNoProj = {
      options: {},
      session: { id: "session-p0inject02", header: { origin: "main", cwd: "C:/tmp/p0-shallow" }, cwd: "C:/tmp/p0-shallow" },
      inject(msg) { injectedNoProj.push(msg); },
    };
    try { hCreated.fn({ agent: fakeAgentNoProj, source: "startup", signal: { aborted: false } }); } catch (e) { ok(false, "P0.1 隐私：无项目会话 agent/created 不抛", e.message); }
    await waitFor(() => injectedNoProj.some((m) => textOf(m).includes("【最近一次会话压缩点】")), 6000, 80);
    const allNo = injectedNoProj.map(textOf).join("\n\n@@@\n\n");
    ok(!/【最近用户原话/.test(allNo) && !allNo.includes(LIT_QUOTE), "P0.1 §6.1 隐私：未命中项目的会话**不注入用户原话**（改前会串项目）");
    ok(!/【任务状态/.test(allNo) && !allNo.includes(LIT_TASK), "P0.1 §6.1 隐私：未命中项目的会话**不注入任务状态**");
    ok(allNo.includes(LIT_CP), "P0.1 §6.1 隐私：检查点正文仍正常注入（只砍槽 2/3，不影响 P0-1）");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、P0-1 回落 md（flag 关）：老行为逐字保留
// ═══════════════════════════════════════════════════════════════════════════
{
  const TODAY = dayStr(new Date());
  const mdPath = path.join(MEM, "sessions", TODAY + ".md");
  const mdText = "# " + TODAY + "\n\n## 通用块\n\n## 检查点（md 来源 P0-SELFTEST-MD-7f8a）\n\n## 本次目标\n- md 回落验证\n\n## 下一步行动\n- 无\n\n## 关键结论\n- 无\n";
  fs.writeFileSync(mdPath, mdText, "utf8");
  const en = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;   // 等价 flag 关：不得读库
  const ls = await mod.__p0Hooks.latestSessionSummary();
  mod.__topicdb.enabled = en;
  ok(ls && ls.source === "md" && ls.file === TODAY + ".md" && ls.isToday === true,
    "P0-1 回落 md：flag 关 ⇒ 走原 md 扫描（source=md/isToday）", ls ? JSON.stringify({ source: ls.source, file: ls.file }) : "null");
  ok(ls && ls.text.includes("P0-SELFTEST-MD-7f8a"), "P0-1 回落 md：正文为原 md 内容（逐字）");
  ok(ls && typeof ls.sentences === "undefined", "P0-1 回落 md：md 来源不带 sentences（与库来源可区分）");
  // 非当日 md：只有昨天文件 → isToday=false
  fs.renameSync(mdPath, path.join(MEM, "sessions", dayStr(new Date(Date.now() - 86400000)) + ".md"));
  mod.__topicdb.enabled = false;
  const lsY = await mod.__p0Hooks.latestSessionSummary();
  mod.__topicdb.enabled = en;
  ok(lsY && lsY.isToday === false && lsY.source === "md", "P0-1 回落 md：非当日 ⇒ isToday=false（保留「停在 YYYY-MM-DD」语义）", lsY ? lsY.file : "null");
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、P0-2 失败重试队列（端到端：真 spawnIntentCheckpoint + 真 .integrate.json）
// ═══════════════════════════════════════════════════════════════════════════
{
  const TODAY = dayStr(new Date());
  const fname = TODAY + ".md";
  const parentAgent = { options: {}, session: { id: "session-p0retry01", header: { origin: "main", cwd: CWD } }, inject() {} };
  const integPath = path.join(MEM, ".integrate.json");
  const readQueue = () => {
    try { const j = JSON.parse(fs.readFileSync(integPath, "utf8")); return Array.isArray(j.intentRetry) ? j.intentRetry : []; } catch (e) { return []; }
  };
  const VALID = "## 本次目标\n- 补火成功 " + "P0-RETRY-OK-2b9c" + "\n\n## 下一步行动\n- 无\n\n## 关键结论\n- 无";
  const failStart = async () => ({ result: { output: [], stopReason: "completed" } });
  const okStart = async () => ({ result: { output: [{ type: "text", text: VALID }], stopReason: "completed" } });
  const origStart = fx.subagents.start;

  // C1：失败 ⇒ 入队 + 未进去重集
  fx.subagents.start = failStart;
  const CID1 = "bbbbbbbb-1111-2222-3333-444455556666";
  const r1 = await mod.__p0Hooks.spawnIntentCheckpoint(CID1, "宿主压缩摘要占位（P0 自测）".repeat(4), fname, parentAgent, "session-p0retry01");
  const q1 = readQueue();
  const e1 = q1.find((x) => x.id === CID1);
  ok(r1 && r1.ok === false && r1.retry === true, "P0-2 失败：spawn 返回 {ok:false,retry:true}", JSON.stringify(r1));
  ok(!!e1, "P0-2 失败：.integrate.json intentRetry 已入队", "entries=" + q1.length);
  ok(e1 && e1.attempts === 1 && Number(e1.nextAt) - Number(e1.firstAt) >= 59000,
    "P0-2 失败：attempts=1 且退避 1min", e1 ? "attempts=" + e1.attempts + " delta=" + (e1.nextAt - e1.firstAt) : "无");
  ok(mod.__p0Hooks.isArchivedCompactionId(CID1) === false, "P0-2 失败：**未**进 archivedCompactionIds（去重标记已后移）");
  ok(readQueue().filter((x) => x.id === CID1).length === 1, "P0-2 幂等：同 id 队列只留 1 条");

  // C2：同 id 再失败 ⇒ 仍 1 条、attempts=2、退避 5min
  const r2 = await mod.__p0Hooks.spawnIntentCheckpoint(CID1, "宿主压缩摘要占位（P0 自测）".repeat(4), fname, parentAgent, "session-p0retry01");
  const e2 = readQueue().find((x) => x.id === CID1);
  ok(r2 && r2.ok === false && e2 && e2.attempts === 2 && (e2.nextAt - e2.lastAt) >= 299000,
    "P0-2 同 id 再失败：attempts=2 且退避 5min", e2 ? "attempts=" + e2.attempts + " delta=" + (e2.nextAt - e2.lastAt) : "无");

  // C3：恢复子代理 → force 补火 ⇒ 成功、队列清理、去重集命中、库内 +1
  fx.subagents.start = okStart;
  const dayTopic = store ? store.topics().find((t) => t.parentId && String(t.name) === TODAY && String((t.triggers || []).indexOf(TODAY) >= 0 || true)) : null;
  const before = store ? (store.topics().find((t) => String(t.name) === TODAY && t.parentId) || {}).sentences || 0 : 0;
  const fireRes = await mod.__p0Hooks.fireIntentRetryNow({ force: true, agent: parentAgent });
  await sleep(120);
  const q3 = readQueue();
  ok(Array.isArray(fireRes) && fireRes.length >= 1 && fireRes[0].ok === true, "P0-2 补火：fireIntentRetryNow({force}) 返回成功", JSON.stringify(fireRes));
  ok(q3.findIndex((x) => x.id === CID1) === -1, "P0-2 补火成功：重试队列已清理该 id", "remain=" + q3.length);
  ok(mod.__p0Hooks.isArchivedCompactionId(CID1) === true, "P0-2 补火成功：成功落库后才进 archivedCompactionIds");
  if (store) {
    const after = (store.topics().find((t) => String(t.name) === TODAY && t.parentId) || {}).sentences || 0;
    ok(after === before + 1, "P0-2 补火成功：库内当日主题句子 +1（真的补写进去了）", before + " → " + after);
  }

  // C4：连续失败 4 次 ⇒ 熔断丢弃（retry=false + 队列无该条 + monitor retry-breaker）
  fx.subagents.start = failStart;
  const CID4 = "cccccccc-1111-2222-3333-444455556666";
  const codes = [];
  for (let i = 0; i < 4; i++) {
    // 每轮把 nextAt 拨到过去，模拟"退避到期后再失败"（不真等 1/5/15 分钟）
    const qq = readQueue();
    const idx = qq.findIndex((x) => x.id === CID4);
    if (idx >= 0) { qq[idx].nextAt = Date.now() - 1; fs.writeFileSync(integPath, JSON.stringify(JSON.parse(fs.readFileSync(integPath, "utf8")), null, 2), "utf8"); }
    const rr = await mod.__p0Hooks.spawnIntentCheckpoint(CID4, "宿主压缩摘要占位（P0 自测）".repeat(4), fname, parentAgent, "session-p0retry01");
    codes.push(rr && rr.retry);
  }
  ok(readQueue().findIndex((x) => x.id === CID4) === -1, "P0-2 熔断：连续失败超上限 ⇒ 队列丢弃该条", "attemptsCodes=" + JSON.stringify(codes));
  ok(codes[codes.length - 1] === false, "P0-2 熔断：最后一次返回 retry=false（明示已放弃，不再排）", JSON.stringify(codes));
  await sleep(900);   // .monitor.json 落盘有 500ms 防抖（scheduleMonitorSave）
  let mon = "";
  try { mon = fs.readFileSync(path.join(MEM, ".monitor.json"), "utf8"); } catch (e) { mon = ""; }
  ok(/retry-breaker/.test(mon), "P0-2 熔断：.monitor.json 有 retry-breaker 留痕");

  fx.subagents.start = origStart;
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、[P0.1 补丁] §6.1 事实准入纯函数 + §6.2 checkSizeOverflow 库来源豁免
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── §6.1 p0FactsAdmissible 四态（空 vs 空 / 空 vs 非空 / A vs B / A vs A）──
  const f = mod.__p0FactsAdmissible;
  ok(typeof f === "function", "P0.1 §6.1：__p0FactsAdmissible 已导出");
  ok(f("A项目", "A项目") === true && f(" A项目 ", "A项目") === true, "P0.1 §6.1 准入：两边非空且相等 ⇒ true（含 trim）");
  ok(f("", "") === false, "P0.1 §6.1 准入：空 vs 空 ⇒ false（无项目归属不掺）");
  ok(f("", "A") === false && f("A", "") === false, "P0.1 §6.1 准入：空 vs 非空 / 非空 vs 空 ⇒ false");
  ok(f("A", "B") === false, "P0.1 §6.1 准入：A vs B ⇒ false（跨项目不掺）");
  ok(f(null, undefined) === false && f(undefined, null) === false, "P0.1 §6.1 准入：null/undefined ⇒ false 不抛");
}
{
  // ── §6.2 行为：库来源（source="db"）不产出 summary 超限项；md 来源仍产出（未误关）──
  const cso = mod.__p0Hooks.checkSizeOverflow;
  ok(typeof cso === "function", "P0.1 §6.2：__p0Hooks.checkSizeOverflow 已接线");
  const TODAY2 = dayStr(new Date());
  // 造 3 条长检查点句（每句 ~1k 字）⇒ 库拼接文本 > summary 硬预算 1500（改前必报「非当日摘要」）
  for (let i = 0; i < 3; i++) {
    const SUM2 = "## 本次目标\n- 长检查点 " + i + " " + "PATCH2-LONG".repeat(120) + "\n\n## 关键结论\n- ok";
    mod.__topicdbWriteIntent("patch2-" + i + "-1111-2222-3333-44445555666" + i, "p2" + i + "00000", SUM2, TODAY2 + ".md", "session-p2");
  }
  const lsLong = await mod.__p0Hooks.latestSessionSummary();
  ok(lsLong && lsLong.source === "db" && lsLong.text.length > 1500,
    "P0.1 §6.2 造数：库来源检查点文本 > 1500 字符", lsLong ? "len=" + lsLong.text.length : "null");
  const issDb = await cso();
  ok(!(issDb || []).some((x) => x.key === "summary"),
    "P0.1 §6.2 生效：库来源**不产出** summary 超限项（改前会误报「非当日摘要建议精简」）",
    "keys=" + JSON.stringify((issDb || []).map((x) => x.key)));
  // 对照：flag 关 + 长 md ⇒ 仍必须产出 summary 项（证明只豁免库来源，不是把检查关了）
  const mdLong = "# " + TODAY2 + "\n\n## 通用块\n\n## 要点\n- " + "md-long-literal-".repeat(120) + "\n";
  const mdPath2 = path.join(MEM, "sessions", TODAY2 + ".md");
  fs.writeFileSync(mdPath2, mdLong, "utf8");
  const en2 = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  let issMd = [];
  try { issMd = await cso(); } finally { mod.__topicdb.enabled = en2; }
  const sMd = (issMd || []).find((x) => x.key === "summary");
  ok(!!sMd && sMd.source === "md" && sMd.truncated === true,
    "P0.1 §6.2 对照：md 来源仍正常产出 summary 项（source=md、truncated=true）",
    sMd ? JSON.stringify({ source: sMd.source, truncated: sMd.truncated, chars: sMd.chars }) : "none");
  // 库来源项若被手工塞回，/dream 候选必须过滤（第二道闸，见静态断言）
  try { fs.unlinkSync(mdPath2); } catch (e) { /* 忽略 */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、静态接线断言（两处补火触发点 + 三槽使用点 + P0.1 两补丁）
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(PLUGIN, "utf8");
  ok(/agent\/pre-step[\s\S]{0,800}scheduleIntentRetryDue\(/.test(src), "接线：agent/pre-step 内触发 pending 检查点补火");
  ok(/compaction\/summary[\s\S]{0,3000}fireIntentRetry\(/.test(src) || /fireIntentRetry\(parentAttempt/.test(src), "接线：compaction/summary 内也补火（双兜底）");
  ok(/buildSummaryInjection\(\{[\s\S]{0,400}checkpoint: p0Body/.test(src), "接线：agent/created 用 buildSummaryInjection 三槽装配");
  ok(/intentRetrySucceed\(compactionId\)/.test(src) && !/archivedCompactionIds\.add\(compactionId\);/.test(src), "接线：去重标记只在成功路径写（旧「spawn 前 add」已移除）");
  // [P0.1 补丁]
  ok(/p0FactsAdmissible\(p0ProjKey, _facts\.projKey\)/.test(src), "接线·补丁1：注入侧 _factsOk 走 p0FactsAdmissible（两边非空且相等才准入）");
  ok(/function checkSizeOverflow[\s\S]{0,3000}latest\.source !== "db"/.test(src), "接线·补丁2：checkSizeOverflow 对 source===\"db\" 跳过 summary 检查");
  ok(/\.filter\(\(x\) => x\.truncated && x\.file\)/.test(src) && /const _truncMd = _trunc\.filter\(\(x\) => x\.source !== "db"\)/.test(src), "接线·补丁2：/dream buildDreamPrompt 的 sessionCands 候选过滤掉 db 来源（保留旧表达式不破 D2 门）");
  ok(/if \(!i9\.truncated \|\| i9\.source === "db"\) continue;/.test(src), "接线·补丁2：/dream 容量下沉候选同样过滤 db 来源");
}

// ── 收尾 ──
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
