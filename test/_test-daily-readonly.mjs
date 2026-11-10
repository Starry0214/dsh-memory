// _test-daily-readonly.mjs —— [4.5.13 I'-7][用户追加 2026-11-10] 日记忆（D8）对 dream 只读门
//
// 跑法：node test/_test-daily-readonly.mjs [index.js 路径]
//
// 背景（用户追加要求）：「日记忆（按天流水）」及其子主题对 dream **只读**——
//   · D8 域「日记忆（按天流水）」；
//   · 线「会话检查点」（历史日期流水线）与「会话检查点·<wsKey>」；
//   · 日期主题 `YYYY-MM-DD`（D8 线下的按天流水 detail）；
//   · P2.5 会话主题 `<wsKey>/<sid8>`（已有 p25 护栏，保持 P25_SESSION_TOPIC 码）。
//   为什么：D8 是插件按天机械维护的流水，dream 改写会破坏「按天追加 + 恒 1 句覆盖」且不可自愈。
//
// 覆盖：
//   A 候选池排除（日期主题 / D8 域 / 会话检查点线不进候选）
//   B A1 预筛关联排除（D8 主题不作为关联主题出现）
//   C 写护栏（代码级）：dream_patch 对日期主题/线/域 ⇒ DAILY_MEMORY_READONLY 整批拒且句数不变；
//      同批普通主题也不落盘（不半批）；P2.5 会话主题仍走 P25_SESSION_TOPIC（码不混）
//   D split 源 / review merge into / rename 同样拒
//   E 普通主题正常写入不被误伤；A2 检查点证据不含 D8 日期主题
//   F 静态接线（helper + 五处护栏落点 + 候选/预筛排除）
//
// 隔离纪律：os.tmpdir() 临时 DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB（复用 test/_accept-p0-lib.mjs），
//   不碰真实 ~/.dsh/memory；不用 fake store。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkHome, useHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, seedD8, todayStr,
  makeReporter, finish, sleep,
} from "./_accept-p0-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const SRC = fs.readFileSync(PLUGIN, "utf8");
const R = makeReporter("4.5.13 I'-7：日记忆（D8）对 dream 只读");
const CFG_ON = { memoryTopicDbEnabled: true };
const CWD_A = "E:\\工具\\测试项目A";
const D8_DOMAIN = "日记忆（按天流水）";

const H = mkHome("daily-readonly");
useHome(H);
const mod = await freshPlugin();
const { ctx, captured } = makeCtx();
applyPlugin(mod, CFG_ON, ctx);
const ready = await waitTopicDb(mod);
R.ok(ready, "0 前置：主题库就绪", ready ? "ready" : String((mod.__topicdb && mod.__topicdb.err) || "not-ready"));
if (!ready) { finish(R); await sleep(300); process.exit(1); }
const store = mod.__topicdb.store;
const hooks = mod.__dreamHooks || {};
R.ok(typeof hooks.buildPrompt === "function" && typeof hooks.apply === "function", "0b 前置：测试钩子可用");
R.ok(typeof mod.__isDailyMemoryTopicName === "function" && typeof mod.__isDailyMemoryTopic === "function", "0c 前置：D8 只读 helper 已导出");

// ── 造数：D8 域 + 历史线 + 日期主题 + P2.5 线/会话主题 + 普通主题 ──
const seeded = seedD8(mod);
R.ok(!!seeded, "0d 前置：D8 域 + 「会话检查点」线已建");
const domId = seeded && seeded.dom && seeded.dom.id;
const histLineId = seeded && seeded.line && seeded.line.id;
// 日期主题（D8 历史线下）
let dateTopicId = null;
try {
  const dt = store.seedTopic({ name: "2026-11-10", triggers: ["2026-11-10"], src: "sessions/2026-11-10.md", actor: "plugin" });
  dateTopicId = dt.id;
  store.appendSentence({ topic: dateTopicId, text: "## 2026-11-10 日流水\n- 按天追加的机械记忆条目一。", actor: "runtime" });
  try { store.setLevel(dateTopicId, "detail", { actor: "runtime" }); } catch (eL) { /* 忽略 */ }
  try { store.linkParent(dateTopicId, histLineId, { actor: "runtime" }); } catch (eP) { /* 忽略 */ }
} catch (e) { dateTopicId = null; }
R.ok(!!dateTopicId, "0e 前置：日期主题已建（挂在「会话检查点」线下）", String(dateTopicId));
// P2.5 工作区线 + 会话主题（真检查点，走插件写入路径）
const w = mod.__topicdbIntentRoute("ab12cd34-1111", "11112222", "## 关键结论\n- D8 只读门 fixture", todayStr() + ".md", "session-11112222", CWD_A);
R.ok(w && w.p25 === true, "0f 前置：P2.5 会话主题已建（父线 会话检查点·<wsKey>）", JSON.stringify(w && w.topicName));
const cpId = w && w.topicId;
// 普通主题
const plain = store.seedTopic({ name: "普通可写主题", triggers: ["普通"], src: "selftest", actor: "plugin" });
store.appendSentence({ topic: plain.id, text: "普通主题正文，dream 可以正常追加。", actor: "runtime" });
// 一条未提炼笔记（A1 关联用；内容故意含日期与「会话检查点」字样，诱使误关联）
const note = store.seedTopic({ name: "笔记·selftest-ws/aaaa1111", triggers: [], src: "selftest", actor: "plugin" });
store.appendSentence({ topic: note.id, text: "2026-11-10 会话检查点 日记忆 按天流水 逐日记录。", actor: "runtime" });
const byId = () => new Map(store.topics().map((t) => [String(t.id), t]));
const dailyIds = () => [domId, histLineId, dateTopicId].filter(Boolean).map(String);
const sentCount = (id) => ((store.readTopic(id) || {}).sentences || []).length;

// ════════════════════════════════════════════════════════════════════════
// A：候选池排除
// ════════════════════════════════════════════════════════════════════════
{
  const dp = await hooks.buildPrompt({});
  const pt = (dp && dp.promptText) || "";
  const candLine = pt.split("\n").find((l) => l.includes("候选主题")) || "";
  const candIds = [...candLine.matchAll(/(T-\d+)「/g)].map((m) => m[1]);
  R.ok(candIds.length > 0, "A1 候选行存在", "n=" + candIds.length);
  const bad = dailyIds().filter((id) => candIds.includes(id));
  R.ok(bad.length === 0, "A2 候选池不含 D8 主题（域/线/日期主题）", JSON.stringify(bad));
  R.ok(!candLine.includes(D8_DOMAIN) && !candLine.includes("会话检查点") && !candLine.includes("2026-11-10"), "A3 候选行文本不含 D8 名/日期");
  // B：A1 预筛关联排除
  const ps = (dp && dp.prescreen) || { items: [] };
  const links = (ps.items || []).flatMap((x) => (x.links || []).map((l) => String(l.id)));
  const badLink = links.filter((id) => dailyIds().includes(id));
  R.ok(badLink.length === 0, "B1 预筛关联不含 D8 主题", JSON.stringify(badLink));
  // E：A2 检查点证据不含 D8 日期主题
  const ce = (dp && dp.checkpointEvidence) || { ids: [] };
  const badCk = (ce.ids || []).filter((id) => dailyIds().includes(String(id)));
  R.ok(badCk.length === 0 && (ce.ids || []).every((id) => String(id) === String(cpId) || true), "E1 检查点证据不含 D8 日期主题", JSON.stringify(ce.ids));
  R.ok((ce.ids || []).map(String).includes(String(cpId)), "E2 检查点证据仍含真检查点（双条件口径）", JSON.stringify(ce.ids));
}

// ════════════════════════════════════════════════════════════════════════
// C：写护栏（dream_patch 整批拒）
// ════════════════════════════════════════════════════════════════════════
{
  const n0 = sentCount(dateTopicId);
  const r1 = hooks.apply([{ topic: "2026-11-10", action: "append", content: "dream 违规追加" }], { dream: true });
  R.ok(r1 && r1.ok === false && r1.error === "DAILY_MEMORY_READONLY" && r1.rejected === true, "C1 dream_patch append 日期主题 ⇒ DAILY_MEMORY_READONLY 整批拒", JSON.stringify(r1).slice(0, 180));
  R.ok(sentCount(dateTopicId) === n0, "C2 被拒后日期主题句数不变", "n=" + sentCount(dateTopicId));
  const r2 = hooks.apply([{ topic: "会话检查点", action: "append", content: "dream 违规追加线" }], { dream: true });
  R.ok(r2 && r2.error === "DAILY_MEMORY_READONLY", "C3 dream_patch append 会话检查点线 ⇒ DAILY_MEMORY_READONLY", JSON.stringify(r2).slice(0, 160));
  const r3 = hooks.apply([{ topic: D8_DOMAIN, action: "append", content: "dream 违规追加域" }], { dream: true });
  R.ok(r3 && r3.error === "DAILY_MEMORY_READONLY", "C4 dream_patch append D8 域 ⇒ DAILY_MEMORY_READONLY", JSON.stringify(r3).slice(0, 160));
  // 整批不半批：同批普通主题 + 日期主题
  const pn0 = sentCount(plain.id);
  const r4 = hooks.apply([
    { topic: plain.id, action: "append", content: "同批普通主题句-不应落盘" },
    { topic: "2026-11-10", action: "append", content: "同批日期主题句" },
  ], { dream: true });
  R.ok(r4 && r4.error === "DAILY_MEMORY_READONLY" && sentCount(plain.id) === pn0, "C5 整批拒绝：同批普通主题也不落盘（绝不半批）", "plain " + pn0 + "→" + sentCount(plain.id));
  // P2.5 码不混：会话主题仍走 P25_SESSION_TOPIC
  const r5 = hooks.apply([{ topic: w.topicName, action: "append", content: "dream 违规追加检查点" }], { dream: true });
  R.ok(r5 && r5.error === "P25_SESSION_TOPIC", "C6 P2.5 会话主题仍返回 P25_SESSION_TOPIC（码不混）", JSON.stringify(r5).slice(0, 160));
  R.ok(sentCount(cpId) === 1, "C7 会话主题句数仍为 1", "n=" + sentCount(cpId));
  // E：普通主题不误伤
  const r6 = hooks.apply([{ topic: plain.id, action: "append", content: "普通主题正常追加句-daily-gate" }], { dream: true });
  R.ok(r6 && r6.ok === true, "E3 普通主题 append 正常成功（护栏零误伤）", JSON.stringify(r6).slice(0, 160));
}

// ════════════════════════════════════════════════════════════════════════
// D：split 源 / review merge into / rename
// ════════════════════════════════════════════════════════════════════════
{
  const DREAM_SID = "daily-gate-dream-sid-0001";
  try { hooks.guardRegister(DREAM_SID, "dream", new AbortController(), 120000, 120000); } catch (e) { /* 忽略 */ }
  const execDream = (name) => ({ name: name, agent: { session: { id: DREAM_SID } } });
  const splitTool = (captured.tools || []).find((t) => t && t.name === "memory_split_topic");
  if (splitTool) {
    const body = String(((store.readTopic(dateTopicId) || {}).sentences || [])[0]?.text || "");
    const rs = JSON.parse(await splitTool.execute({ topic: "2026-11-10", name: "日期主题拆分目标", sentence_texts: [body], reason: "selftest" }, execDream("memory_split_topic")));
    R.ok(rs && rs.ok === false && rs.code === "DAILY_MEMORY_READONLY", "D1 split_topic 源=日期主题 ⇒ DAILY_MEMORY_READONLY", JSON.stringify(rs).slice(0, 180));
    R.ok(sentCount(dateTopicId) >= 1, "D2 split 被拒后日期主题句数不变", "n=" + sentCount(dateTopicId));
  } else { R.skip("D1/D2 split 源", "工具未注册"); }
  const revTool = (captured.tools || []).find((t) => t && t.name === "memory_review_topic");
  if (revTool) {
    let srcId = null;
    try {
      const st = store.createTopic({ name: "待审重复源主题日记忆", triggers: [], actor: "runtime", confirm: true });
      srcId = st.id;
      store.appendSentence({ topic: srcId, text: "待审独有句：合并会污染日记忆流水。", actor: "runtime" });
      store.setState(srcId, "needs_review", { actor: "runtime", reason: "selftest" });
    } catch (e) { srcId = null; }
    if (srcId) {
      const rv = JSON.parse(await revTool.execute({ topic: srcId, verdict: "merge", into: "2026-11-10", note: "selftest" }, execDream("memory_review_topic")));
      R.ok(rv && rv.ok === false && rv.code === "DAILY_MEMORY_READONLY", "D3 review merge into=日期主题 ⇒ DAILY_MEMORY_READONLY", JSON.stringify(rv).slice(0, 180));
      R.ok(String((store.readTopic(srcId) || {}).state || "") === "needs_review", "D4 merge 被拒后源主题未归档（不落盘）", String((store.readTopic(srcId) || {}).state));
    } else { R.skip("D3/D4 review merge into", "造数失败"); }
  } else { R.skip("D3/D4 review merge into", "工具未注册"); }
  const renTool = (captured.tools || []).find((t) => t && t.name === "memory_rename_topic");
  if (renTool) {
    const rr1 = JSON.parse(await renTool.execute({ topic: "2026-11-10", new_name: "改日期主题试试", reason: "selftest" }, execDream("memory_rename_topic")));
    R.ok(rr1 && rr1.ok === false && rr1.code === "SYSTEM_TOPIC_READONLY", "D5 rename 日期主题 ⇒ SYSTEM_TOPIC_READONLY", JSON.stringify(rr1).slice(0, 160));
    const rr2 = JSON.parse(await renTool.execute({ topic: "会话检查点", new_name: "改流水线试试", reason: "selftest" }, execDream("memory_rename_topic")));
    R.ok(rr2 && rr2.ok === false && rr2.code === "SYSTEM_TOPIC_READONLY", "D6 rename 会话检查点线 ⇒ SYSTEM_TOPIC_READONLY", JSON.stringify(rr2).slice(0, 160));
  } else { R.skip("D5/D6 rename", "工具未注册"); }
}

// ════════════════════════════════════════════════════════════════════════
// F：静态接线
// ════════════════════════════════════════════════════════════════════════
{
  const segOf = (a, b) => { const i = SRC.indexOf(a); if (i < 0) return ""; const j = b ? SRC.indexOf(b, i + a.length) : -1; return SRC.slice(i, j > i ? j : i + 6000); };
  const strip = (s) => String(s || "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  R.ok(/function isDailyMemoryTopicName/.test(SRC) && /function isDailyMemoryTopic\(/.test(SRC), "F1 helper 已实现（名字优先 + 父链兜底）");
  const segApply = strip(segOf("const applyPatches = (patches, opts)", "const errors = []; const seen"));
  R.ok(/DAILY_MEMORY_READONLY/.test(segApply) && /isDailyMemoryTopic\(/.test(segApply), "F2 applyPatches 整批预扫已接 D8 护栏");
  const segFallback = strip(segOf("const applyDreamPatchesToDb = (valid, opts2)", "// 人工稳定层：global.md"));
  R.ok(/DAILY_MEMORY_READONLY/.test(segFallback), "F3 applyDreamPatchesToDb 兜底已接 D8 护栏");
  R.ok(/DAILY_MEMORY_READONLY/.test(strip(segOf('name: "memory_split_topic"', 'name: "memory_review_topic"'))), "F4 split 源已接 D8 护栏");
  R.ok(/DAILY_MEMORY_READONLY/.test(strip(segOf('name: "memory_review_topic"', 'name: "memory_note"'))), "F5 review merge into 已接 D8 护栏");
  R.ok(/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(segOf("function isRenameProtectedTopicName", "function topicNormName")) || /日期主题/.test(segOf("function isRenameProtectedTopicName", "function topicNormName")), "F6 rename 保护名单含日期主题");
  R.ok(/isDailyMemoryTopicName/.test(strip(segOf("const _pool = _live.filter", "const _sorted = (arr)"))), "F7 候选池已排除 D8 只读族");
  R.ok(/isDailyMemoryTopicName/.test(strip(segOf("function dreamPrescreenExcluded", "function dreamWorkspaceRelated"))), "F8 A1 预筛已排除 D8 只读族");
  R.ok(/isDailyMemoryTopicName/.test(strip(segOf("function dreamCheckpointEvidence", "// [4.5.13 Part A][门用]"))), "F9 A2 检查点证据已排除 D8 形态");
}

finish(R);
