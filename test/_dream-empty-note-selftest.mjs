// _dream-empty-note-selftest.mjs —— dream 空轮判定必须把「笔记未提炼」算作有活（bugfix 2026-11-07）
//
// 跑法：node test/_dream-empty-note-selftest.mjs
//
// 背景（真机）：18:22 monitor 已建出 cand-topics（含笔记主题），18:23 却「空轮跳过（无候选会话/无超限文件/无待沉淀条目）」，
//   而当时 6 个笔记主题 / 42 句未提炼 ⇒ 4.5.0 起笔记提炼是 dream 主职责，却被 9 月的空轮前置检查饿死。
// 口径：阈值 = 0（topics>0 或 sentences>0 即不跳过）；不做 N 句防抖——触发由天级 integrateDays 控制，token 成本天然有界。
//
// 覆盖：
//   A 静态接线：skip 条件含 _noteHasWork、复用 noteRows、无阈值常量、文案含「无待提炼笔记」
//   B 行为：6 主题/42 句 + 三老通道全空 ⇒ 不跳过（真 spawn）；1 句 ⇒ 不跳过；0 句 ⇒ 跳过
//   C 性能：buildDreamPrompt 复用 rows（不新增全库扫描），返回 noteRows
//
// 隔离：临时 DSH_HOME/临时库；fake subagents 立即返回空结果；不写真实库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(step || 100); }
  return false;
}

// ── A. 静态接线 ─────────────────────────────────────────────────────────
ok(SRC.indexOf("const _noteHasWork = Number(_notePending.topics) > 0 || Number(_notePending.sentences) > 0;") >= 0, "A1 skip 条件含 _noteHasWork（topics>0 或 sentences>0）");
ok(SRC.indexOf("lessonPickN === 0 && !_noteHasWork") >= 0, "A2 空轮条件已接入 _noteHasWork");
ok(SRC.indexOf("noteUnrefinedStats(_stN, (Array.isArray(_dp.noteRows) ? _dp.noteRows : undefined))") >= 0, "A3 复用任务书 rows（noteRows），不新增全库扫描");
ok(SRC.indexOf("noteRows: _allRows") >= 0, "A4 buildDreamPromptLibrary 返回 noteRows");
ok(SRC.indexOf("DREAM_NOTE_MIN_PENDING") < 0, "A5 未引入阈值常量 DREAM_NOTE_MIN_PENDING（阈值=0）");
ok(SRC.indexOf("/无待提炼笔记") >= 0 && SRC.indexOf("无待提炼笔记——记忆库已稳定") >= 0, "A6 文案已加「无待提炼笔记」（clog/summary/转播）");
ok(/阈值 = \*\*0\*\*/.test(SRC) && /天级 integrateDays 控制/.test(SRC), "A7 代码注释写明阈值 0 的理由（天级触发，token 成本有界）");

// ── B. 行为（真实 apply + fake subagents）─────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-dream-empty-note-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const { createFixtureCtx } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
const fx = createFixtureCtx({});
const started = [];
fx.subagents.start = async (_kind, opts) => {
  started.push({ at: Date.now(), label: String((opts && opts.label) || "") });
  return { id: "empty-note-child-" + started.length, result: Promise.resolve({ output: [{ type: "text", text: "noop" }], stopReason: "completed" }) };
};
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 30000, 100);
ok(ready, "B0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
const hooks = mod.__dreamHooks || {};
const store = ready ? mod.__topicdb.store : null;
if (ready) {
  const created = (fx.captured.handlers || []).find((h) => h.event === "agent/created");
  const fakeAgent = { options: {}, session: { id: "session-empty-note-" + Math.random().toString(36).slice(2, 8), header: { origin: "main", cwd: TMP }, cwd: TMP }, inject() {} };
  try { created.fn({ agent: fakeAgent, source: "startup", signal: { aborted: false } }); } catch (e) { /* 注册失败则后续可能无父 */ }
  await sleep(300);

  const mkNote = (name, n) => {
    const r = store.seedTopic({ name: name, triggers: [], actor: "plugin" });
    const id = r && (r.id || (r.topic && r.topic.id));
    try { store.setState(id, "active", { actor: "runtime" }); } catch (e) { /* 忽略 */ }
    for (let i = 0; i < n; i++) store.appendSentence({ topic: id, text: "未提炼句 " + name + " #" + i, actor: "runtime" });
    return id;
  };
  const noteIds = [];
  for (let i = 0; i < 6; i++) noteIds.push(mkNote("笔记·EMPTY-WS/" + (0x10000000 + i).toString(16), 7));   // 6×7=42 句
  const st1 = mod.__noteUnrefinedStats(store);
  ok(st1.topics === 6 && st1.sentences === 42, "B1 造数：6 主题 / 42 句未提炼", JSON.stringify({ topics: st1.topics, sentences: st1.sentences }));

  // B2 三老通道全空 + 笔记 6/42 ⇒ 不跳过（真 spawn）
  let n0 = started.length;
  const r1 = await hooks.spawnIntegrate(fakeAgent, "selftest-note-pending");
  await sleep(400);
  ok(r1 !== "skipped" && started.length > n0, "B2 笔记 6 主题/42 句 + 三老通道全空 ⇒ 不跳过（已 spawn）", "ret=" + JSON.stringify(r1) + " started=" + (started.length - n0));

  // B3 归档全部笔记主题 ⇒ 0 句 ⇒ 跳过
  for (const id of noteIds) { try { store.archiveTopic(id, { actor: "runtime", reason: "selftest" }); } catch (e) { /* 忽略 */ } }
  const st0 = mod.__noteUnrefinedStats(store);
  ok(st0.topics === 0 && st0.sentences === 0, "B3 造数：归档后 0 主题/0 句", JSON.stringify({ topics: st0.topics, sentences: st0.sentences }));
  n0 = started.length;
  const r2 = await hooks.spawnIntegrate(fakeAgent, "selftest-empty");
  await sleep(400);
  ok(r2 === "skipped" && started.length === n0, "B4 笔记 0 句 + 三老通道全空 ⇒ 跳过", "ret=" + JSON.stringify(r2) + " started+=" + (started.length - n0));

  // B5 仅 1 句（阈值 0）⇒ 不跳过
  mkNote("笔记·EMPTY-WS/0badf00d", 1);
  const st2 = mod.__noteUnrefinedStats(store);
  ok(st2.sentences === 1, "B5 造数：仅 1 句未提炼", JSON.stringify({ topics: st2.topics, sentences: st2.sentences }));
  n0 = started.length;
  const r3 = await hooks.spawnIntegrate(fakeAgent, "selftest-one-sentence");
  await sleep(400);
  ok(r3 !== "skipped" && started.length > n0, "B6 笔记仅 1 句（阈值 0）⇒ 不跳过", "ret=" + JSON.stringify(r3) + " started=" + (started.length - n0));

  // C. rows 复用：buildDreamPrompt 只扫一次 topics()，并返回 noteRows
  let calls = 0;
  const origTopics = store.topics.bind(store);
  store.topics = () => { calls += 1; return origTopics(); };
  try {
    calls = 0;
    const dp = await hooks.buildPrompt({});
    ok(Array.isArray(dp.noteRows) && dp.noteRows.length > 0, "C1 buildDreamPrompt 返回 noteRows（供空轮判定复用）", "rows=" + (dp.noteRows ? dp.noteRows.length : "null"));
    ok(calls <= 2, "C2 任务书构建的 store.topics() 调用 ≤2 次（不因笔记统计新增全库扫描）", "calls=" + calls);
  } finally { store.topics = origTopics; }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
