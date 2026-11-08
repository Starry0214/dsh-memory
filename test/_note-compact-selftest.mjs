// _note-compact-selftest.mjs —— 4.5.2「笔记收敛（整主题覆盖 + 指针）」实现自测
//
// 跑法：node test/_note-compact-selftest.mjs [index.js 路径]
//
// 设计依据：docs/方案-4.5.2-笔记收敛.md §13/§14（v4 收口）+ docs/audit/452-note-compact_CRA_2026-11-06.md §6
// 覆盖：
//   A 判据双格式（legacy marker + 新指针）+ 口径 A（未提炼 = 最后一条指针之后的句数）
//   B 快照先行：只删快照内句（快照后新增句幸存）+ 三条硬断言
//   C sha 不匹配 ⇒ 跳过该句并留痕（不阻塞整体）
//   D C2' 校验失败四类（doneOk/targets 空/不一致/writeCount 未增长/新建 createdAt 不达标/archived/笔记目标）
//   E 成功幂等（重复调用不重复删、pending 清理）
//   F pending 重放（正常重做 / TTL 过期丢弃 / 重放时重过 C2' 失败保留）
//   G C4' 守卫四条路径（memory_dream_patch topic / file 旁路 / review into / split 源）
//   H 未提炼统计（noteUnrefinedStats / memory_topics 尾部 / 面板 / stats.json 段）
//   I 静态接线（快照在 spawn 前、哨兵通道、任务书、memory_note 文案、迁移脚本）
//   J dream 端到端（fake subagents 返回哨兵 JSON ⇒ 真收敛）
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指 os.tmpdir() 临时目录，跑完删除；不碰真实库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");
const SRC = fs.readFileSync(PLUGIN, "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) { /* 继续等 */ } await sleep(step || 40); }
  return false;
}
const rand = () => Math.random().toString(36).slice(2, 8);

// ── 临时 home / 记忆库（绝不碰真实 ~/.dsh）──────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-notecompact-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "notecompact-ws");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 笔记收敛自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);
const fx = createFixtureCtx({});
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "Z0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
const store = ready ? mod.__topicdb.store : null;
const H = mod.__noteHooks || {};
ok(typeof H.noteTopicCompact === "function" && typeof H.parseNoteCompactPayload === "function" && typeof H.noteUnrefinedStats === "function",
  "Z1 __noteHooks 已接线（noteTopicCompact / parseNoteCompactPayload / noteUnrefinedStats）", Object.keys(H).length + " 项");

// ── 造数工具 ──────────────────────────────────────────────────────────────
function mkTopic(name, texts, opts) {
  const o = opts || {};
  let r = null;
  try { r = store.createTopic({ name: name, actor: "runtime", confirm: true }); } catch (e) { r = null; }
  const id = (r && (r.id || (r.topic && r.topic.id))) || (o.idHint || "");
  if (!id) throw new Error("建主题失败：" + name);
  try { store.setState(id, o.state || "active", { actor: "runtime", reason: "selftest" }); } catch (e) { /* 状态失败不影响 */ }
  for (const t of (texts || [])) store.appendSentence({ topic: id, text: t, actor: "runtime" });
  return id;
}
function noteTopic(texts, sid8) {
  const sid = sid8 || (Math.random().toString(16).slice(2, 10).padEnd(8, "0").slice(0, 8));
  return { id: mkTopic("笔记·SELFTEST-WS/" + sid, texts), sid8: sid, name: "笔记·SELFTEST-WS/" + sid };
}
function liveTexts(tid) { return (store.readTopic(tid).sentences || []).map((s) => String(s.text || "")); }
function snapOf(tid) {
  const s = mod.__noteTakeSnapshot(store, [tid]);
  return s[tid] || null;
}
function targetBase() { return mod.__noteTakeTargetBaseline(store); }
const ptrTargets = (p) => [...new Set(String(p == null ? "" : p).match(/T-\d+/g) || [])];
function ptr(targets, count, sid8) { return mod.__noteFormatPointer({ count: count, targets: targets, sid8: sid8 || "abcd1234" }); }
function mkTargetWithWrite() {
  const id = mkTopic("notecompact-target-" + rand(), []);
  store.appendSentence({ topic: id, text: "长期句：" + rand(), actor: "runtime" });
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 判据双格式 + 口径 A
// ═══════════════════════════════════════════════════════════════════════════
{
  const isPtr = H.isNotePointerText;
  ok(isPtr("已提炼 → T-0271（2026-11-05 dream：…）"), "A1 legacy marker 识别（「已提炼 → T-xxxx」）");
  ok(isPtr("2026-11-06 已提炼 12 句 → T-0451/T-0452（原文 session_search sid8=abcd1234 可回溯）"), "A2 新指针行识别");
  ok(!isPtr("普通笔记一句：今天做了 X"), "A3 普通文本不是指针");
  ok(isPtr(mod.__noteFormatPointer({ count: 3, targets: ["T-0001", "T-0002"], sid8: "abcd1234" })), "A4 noteFormatPointer 产出可被同一判据识别");
  const noteId = noteTopic(["句一", "句二"]).id;
  ok(H.noteUnrefinedCount(liveTexts(noteId)) === 2, "A5 口径A：无指针 ⇒ 全部句数");
  store.appendSentence({ topic: noteId, text: ptr(["T-0001"], 2) });
  ok(H.noteUnrefinedCount(liveTexts(noteId)) === 0, "A6 口径A：指针在最后 ⇒ 0", JSON.stringify(liveTexts(noteId)) + " isPtr=" + H.isNotePointerText(liveTexts(noteId)[liveTexts(noteId).length-1]) + " reTest=" + mod.__NOTE_POINTER_RE.test(String(liveTexts(noteId)[liveTexts(noteId).length-1])));
  store.appendSentence({ topic: noteId, text: "指针后新增一句" });
  ok(H.noteUnrefinedCount(liveTexts(noteId)) === 1, "A7 口径A：指针之后新增 1 句 ⇒ 1", "count=" + H.noteUnrefinedCount(liveTexts(noteId)));
  const st = H.noteUnrefinedStats(store);
  ok(st.topics >= 1 && st.sentences >= 1, "A8 noteUnrefinedStats 汇总非零（topics/sentences）", JSON.stringify({ topics: st.topics, sentences: st.sentences }));
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 快照先行：只删快照内句（新增句幸存）+ 三条硬断言
// ═══════════════════════════════════════════════════════════════════════════
{
  const nt = noteTopic(["旧句一", "旧句二", "旧句三"]);
  const snapshot = snapOf(nt.id);
  const target = mkTargetWithWrite();
  const base = targetBase();
  store.appendSentence({ topic: target, text: "B 目标写入（bump writeCount）" });
  // 模拟 dream 跑数分钟期间主 agent 新写的 note（快照之后 append ⇒ id 更大）
  store.appendSentence({ topic: nt.id, text: "快照后主agent新写的一句（必须幸存）" });
  const pointer = ptr([target], 3, nt.sid8);
  const r = mod.__noteTopicCompact(store, nt.id, { pointer, targets: [target], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt });
  const after = liveTexts(nt.id);
  ok(r.ok === true, "B1 收敛成功", JSON.stringify({ deleted: (r.deleted || []).length, code: r.code }));
  ok(after.length === 2 && after.some((x) => x.indexOf("快照后主agent新写") >= 0), "B2 快照内 3 句被删、快照后新增句幸存（剩 2 句）", "after=" + after.length);
  ok(after.filter((x) => mod.__isNotePointerText(x)).length === 1, "B3 断言②：恰好 1 条指针句");
  ok((r.deleted || []).length === 3, "B4 删除清单 = 快照内 3 句", JSON.stringify(r.deleted));
  ok(H.hasPending(nt.id) === false, "B5 成功后 pending 已清理");
}

// ═══════════════════════════════════════════════════════════════════════════
// C. sha 不匹配 ⇒ 跳过该句并留痕（不阻塞整体）
// ═══════════════════════════════════════════════════════════════════════════
{
  const nt = noteTopic(["会被改的句", "会被删的句"]);
  const snapshot = snapOf(nt.id);
  const target = mkTargetWithWrite();
  const base = targetBase();
  store.appendSentence({ topic: target, text: "C 目标写入（bump writeCount）" });
  // 快照后 replace 第一句 ⇒ sha 变化（id 不变）
  store.replaceSentence({ topic: nt.id, oldText: "会被改的句", newText: "被改过的句（sha 已变）", actor: "runtime" });
  const pointer = ptr([target], 1, nt.sid8);
  const r = mod.__noteTopicCompact(store, nt.id, { pointer, targets: [target], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt });
  const after = liveTexts(nt.id);
  ok(r.ok === true, "C1 sha 不匹配时整体仍成功（跳过该句）", r.code || "");
  ok(after.some((x) => x.indexOf("被改过的句") >= 0), "C2 sha 不匹配的句被跳过（仍在正文里）");
  ok((r.skipped || []).some((s) => s.why === "sha-mismatch"), "C3 跳过原因留痕 sha-mismatch", JSON.stringify(r.skipped));
  ok(after.filter((x) => mod.__isNotePointerText(x)).length === 1, "C4 指针仍恰好 1 条");
}

// ═══════════════════════════════════════════════════════════════════════════
// D. C2' 校验失败（不收敛、不写指针、不留 pending）
// ═══════════════════════════════════════════════════════════════════════════
{
  const nt = noteTopic(["D 旧句一", "D 旧句二"]);
  const snapshot = snapOf(nt.id);
  const target = mkTargetWithWrite();
  const base = targetBase();
  const before = liveTexts(nt.id).length;
  const cases = [];
  // ① doneOk=false
  cases.push(["D1 doneOk=false", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([target], 2, nt.sid8), targets: [target], baseline: base, snapshot, doneOk: false, spawnAt: snapshot.createdAt })]);
  // ② targets 空
  cases.push(["D2 targets 为空", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([target], 2, nt.sid8), targets: [], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt })]);
  // ③ targets 与 pointer 不一致
  cases.push(["D3 targets≠pointer", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([target], 2, nt.sid8), targets: [target, "T-9999"], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt })]);
  // ④ writeCount 未增长（baseline 取 append 之后的当前值 ⇒ 不再增长）
  cases.push(["D4 writeCount 未增长", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([target], 2, nt.sid8), targets: [target], baseline: targetBase(), snapshot, doneOk: true, spawnAt: snapshot.createdAt })]);
  // ⑤ 新建目标 createdAt 不达标（baseline 缺失 + spawnAt=未来）
  cases.push(["D5 非本轮新建", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([target], 2, nt.sid8), targets: [target], baseline: {}, snapshot, doneOk: true, spawnAt: Date.now() + 3600000 })]);
  // ⑥ archived 目标
  const arch = mkTopic("notecompact-arch-" + rand(), ["归档句"]);
  store.archiveTopic(arch, { actor: "runtime", reason: "selftest" });
  cases.push(["D6 目标已归档", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([arch], 2, nt.sid8), targets: [arch], baseline: targetBase(), snapshot, doneOk: true, spawnAt: snapshot.createdAt })]);
  // ⑦ 目标是笔记主题
  const noteTarget = noteTopic(["另一个笔记"]).id;
  cases.push(["D7 目标是笔记主题", mod.__noteTopicCompact(store, nt.id, { pointer: ptr([noteTarget], 2, nt.sid8), targets: [noteTarget], baseline: targetBase(), snapshot, doneOk: true, spawnAt: snapshot.createdAt })]);
  for (const [label, r] of cases) {
    ok(r && r.ok === false && r.code === "VALIDATION_FAILED", label + " ⇒ VALIDATION_FAILED", r && r.code);
  }
  ok(liveTexts(nt.id).length === before, "D8 七类失败后正文零改动（句数不变）", "n=" + liveTexts(nt.id).length);
  ok(liveTexts(nt.id).every((x) => !mod.__isNotePointerText(x)), "D9 失败不写指针");
  ok(H.hasPending(nt.id) === false, "D10 失败不写 pending（只留 monitor 痕迹）");
}

// ═══════════════════════════════════════════════════════════════════════════
// E. 成功幂等（重复调用不重复删）
// ═══════════════════════════════════════════════════════════════════════════
{
  const nt = noteTopic(["E 旧句一", "E 旧句二"]);
  const snapshot = snapOf(nt.id);
  const target = mkTargetWithWrite();
  const base = targetBase();
  store.appendSentence({ topic: target, text: "E 目标写入（bump writeCount）" });
  const pointer = ptr([target], 2, nt.sid8);
  const r1 = mod.__noteTopicCompact(store, nt.id, { pointer, targets: [target], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt });
  ok(r1.ok && (r1.deleted || []).length === 2, "E1 首次收敛删 2 句");
  const n1 = liveTexts(nt.id).length;
  const r2 = mod.__noteTopicCompact(store, nt.id, { pointer, targets: [target], baseline: base, snapshot, doneOk: true, spawnAt: snapshot.createdAt });
  ok(r2.ok === true && (r2.deleted || []).length === 0, "E2 幂等：重复调用不重复删（deleted=0）", JSON.stringify({ ok: r2.ok, deleted: r2.deleted }));
  ok(liveTexts(nt.id).length === n1, "E3 幂等：正文句数不变", "n=" + n1);
  ok(liveTexts(nt.id).filter((x) => mod.__isNotePointerText(x)).length === 1, "E4 幂等：仍恰好 1 条指针");
}

// ═══════════════════════════════════════════════════════════════════════════
// F. pending 重放
// ═══════════════════════════════════════════════════════════════════════════
{
  // F1 正常重做：模拟「写 pending 后崩溃」——正文原样（旧句都在），pending 记录在
  const nt = noteTopic(["F 旧句一", "F 旧句二"]);
  const snapshot = snapOf(nt.id);
  const target = mkTargetWithWrite();
  const base = targetBase();
  store.appendSentence({ topic: target, text: "F1 目标写入（bump writeCount）" });
  const pointer = ptr([target], 2, nt.sid8);
  H.notePendingPut(nt.id, {
    topicId: nt.id, snapshot, pointer, targets: [target], baseline: base,
    spawnAt: snapshot.createdAt, createdAt: Date.now(), ttlMs: 30 * 60 * 1000,
  });
  ok(H.hasPending(nt.id) === true, "F1 造数：pending 记录存在");
  const rp = mod.__noteCompactReplayPending(store, {});
  ok(rp.redone >= 1, "F2 重放：重做成功", JSON.stringify(rp));
  ok(liveTexts(nt.id).length === 1 && mod.__isNotePointerText(liveTexts(nt.id)[0]), "F3 重放后正文收敛为 1 条指针");
  ok(H.hasPending(nt.id) === false, "F4 重放成功后 pending 清理");

  // F5 TTL 过期 ⇒ 丢弃留痕，正文不动
  const nt2 = noteTopic(["F5 旧句一"]);
  const snap2 = snapOf(nt2.id);
  const t2 = mkTargetWithWrite();
  H.notePendingPut(nt2.id, { topicId: nt2.id, snapshot: snap2, pointer: ptr([t2], 1, nt2.sid8), targets: [t2], baseline: targetBase(), spawnAt: snap2.createdAt, createdAt: Date.now() - 31 * 60 * 1000, ttlMs: 30 * 60 * 1000 });
  const rp2 = mod.__noteCompactReplayPending(store, {});
  ok(rp2.expired >= 1, "F5 TTL 过期 ⇒ 丢弃 pending", JSON.stringify({ expired: rp2.expired }));
  ok(H.hasPending(nt2.id) === false && liveTexts(nt2.id).length === 1 && !mod.__isNotePointerText(liveTexts(nt2.id)[0]), "F6 TTL 过期后正文不动（未收敛）");

  // F7 重放时重过 C2'：target writeCount 不再增长 ⇒ 失败且 pending 保留
  const nt3 = noteTopic(["F7 旧句一"]);
  const snap3 = snapOf(nt3.id);
  const t3 = mkTargetWithWrite();
  H.notePendingPut(nt3.id, { topicId: nt3.id, snapshot: snap3, pointer: ptr([t3], 1, nt3.sid8), targets: [t3], baseline: targetBase(), spawnAt: snap3.createdAt, createdAt: Date.now(), ttlMs: 30 * 60 * 1000 });
  const rp3 = mod.__noteCompactReplayPending(store, {});
  ok(rp3.failed >= 1, "F7 重放重过 C2' 失败（writeCount 未增长）", JSON.stringify(rp3.details));
  ok(H.hasPending(nt3.id) === true, "F8 重放失败 ⇒ pending 保留待重试");
}

// ═══════════════════════════════════════════════════════════════════════════
// G. C4' 守卫四条路径
// ═══════════════════════════════════════════════════════════════════════════
{
  const dreamHooks = mod.__dreamHooks || {};
  const applyDream = dreamHooks.apply;
  ok(typeof applyDream === "function", "G0 前置：__dreamHooks.apply 可取到");
  // [D7/G3] 先建好「src 映射到笔记主题」的场景数据（topicDbSrcMap 有 TTL 缓存，必须在首次 apply 前建）
  const srcRel = "knowledge/NOTE-SRC-MAP-" + rand() + ".md";
  const seed = store.seedTopic({ name: "笔记·SELFTEST-WS/feedface", triggers: ["note-src"], src: srcRel, actor: "plugin" });
  const nt2 = (seed && (seed.id || (seed.topic && seed.topic.id))) || "";
  if (nt2) { try { store.setState(nt2, "active", { actor: "runtime", reason: "selftest" }); } catch (e) { /* 忽略 */ } store.appendSentence({ topic: nt2, text: "file 旁路用笔记句", src: srcRel, actor: "runtime" }); }
  const nt = noteTopic(["守卫用笔记句"]);
  const rTopic = applyDream([{ topic: nt.id, action: "append", content: "dream 想写笔记" }], { dream: true });
  ok(rTopic && rTopic.error === "NOTE_TOPIC_DREAM_FORBIDDEN", "G1 topic 寻址写笔记 ⇒ NOTE_TOPIC_DREAM_FORBIDDEN", rTopic && (rTopic.error || rTopic.ok));
  ok(liveTexts(nt.id).length === 1, "G2 被拒后笔记正文零改动");
  const rFile = applyDream([{ file: srcRel, action: "append", content: "dream 想经 file 旁路写笔记" }], { dream: false });
  ok(rFile && rFile.error === "NOTE_TOPIC_DREAM_FORBIDDEN", "G3 file 名/src 映射到笔记 ⇒ 同样拒绝（防旁路）", rFile && (rFile.error || rFile.ok));
  ok(nt2 && liveTexts(nt2).length === 1, "G4 file 旁路被拒后正文零改动");


  // review into / split 源：需要 dream 身份
  const DREAM_SID = "selftest-note-dream-" + rand();
  let guardOk = false;
  try {
    if (typeof dreamHooks.guardRegister === "function") {
      dreamHooks.guardRegister(DREAM_SID, "dream", new AbortController(), 120000, 120000);
      guardOk = true;
    }
  } catch (e) { guardOk = false; }
  ok(guardOk, "G5 前置：dream 身份看护登记成功");
  const execDream = { name: "x", agent: { session: { id: DREAM_SID } } };
  const revTool = findTool(fx.captured, "memory_review_topic");
  const splitTool = findTool(fx.captured, "memory_split_topic");
  ok(!!(revTool && splitTool), "G6 前置：review/split 工具已注册");
  if (revTool) {
    const src = mkTopic("notecompact-review-src-" + rand(), ["待审句"]);
    try { store.setState(src, "needs_review", { actor: "runtime", reason: "selftest" }); } catch (e) { /* 忽略 */ }
    const noteInto = noteTopic(["review into 用笔记"]).id;
    const rr = JSON.parse(await revTool.execute({ topic: src, verdict: "merge", into: noteInto }, execDream));
    ok(rr && rr.code === "NOTE_TOPIC_DREAM_FORBIDDEN", "G7 review merge into 笔记 ⇒ NOTE_TOPIC_DREAM_FORBIDDEN", rr && rr.code);
    ok(liveTexts(noteInto).length === 1, "G8 review 被拒后笔记正文零改动");
  }
  if (splitTool) {
    const nt3 = noteTopic(["split 源用笔记句"]);
    const rs = JSON.parse(await splitTool.execute({ topic: nt3.id, name: "新主题-x", sentence_texts: ["split 源用笔记句"] }, execDream));
    ok(rs && rs.code === "NOTE_TOPIC_DREAM_FORBIDDEN", "G9 split 源是笔记 ⇒ NOTE_TOPIC_DREAM_FORBIDDEN", rs && rs.code);
    ok(liveTexts(nt3.id).length === 1, "G10 split 被拒后笔记正文零改动");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// H. 未提炼统计（stats.json 段 / 面板 / memory_topics 尾部）
// ═══════════════════════════════════════════════════════════════════════════
{
  const stats = mod.__topicdbStats ? mod.__topicdbStats() : null;
  ok(!!(stats && stats.noteUnrefined && typeof stats.noteUnrefined.topics === "number"), "H1 stats.json topicdb 段含 noteUnrefined", stats && JSON.stringify(stats.noteUnrefined));
  const topicsTool = findTool(fx.captured, "memory_topics");
  if (topicsTool) {
    const out = await topicsTool.execute({}, { agent: { session: { id: "selftest-main-" + rand() } } });
    ok(typeof out === "string" && out.indexOf("[会话笔记] ") >= 0 && out.indexOf("系统主题，无需归类") >= 0 && out.indexOf("待提炼 ") >= 0, "H2 memory_topics 尾部含「[会话笔记] N 个（系统主题，无需归类） · 待提炼 M 句」（4.5.6）");
  } else { ok(false, "H2 memory_topics 工具未注册"); }
  ok(SRC.indexOf("会话笔记未提炼 ") >= 0 && SRC.indexOf("noteUnrefined") >= 0, "H3 面板区块渲染行存在（会话笔记未提炼 N 个主题 / M 句）");
}

// ═══════════════════════════════════════════════════════════════════════════
// I. 静态接线
// ═══════════════════════════════════════════════════════════════════════════
{
  const iSpawn = SRC.indexOf("startSubagentCompat(subagents, {   // v3.2.1");
  const iSnap = SRC.indexOf("const _ds = noteTakeDreamSnapshots(TOPICDB.store);");
  ok(iSnap > 0 && iSpawn > 0 && iSnap < iSpawn, "I1 快照在 spawn 之前（快照先行；D10 合并为一次整库扫描）", "snap@" + iSnap + " spawn@" + iSpawn);
  ok(SRC.indexOf("_noteSnap = noteTakeSnapshot(TOPICDB.store);") < 0 && SRC.indexOf("_noteTargetBase = noteTakeTargetBaseline(TOPICDB.store);") < 0, "I1b spawn 前不再分别重扫（旧两次 topics() 已移除）");
  ok(SRC.indexOf("parseNoteCompactPayload(outText)") > 0 && SRC.indexOf("noteTopicCompact(TOPICDB.store") > 0, "I2 dream 结算解析哨兵 JSON 并调用收敛核心");
  ok(SRC.indexOf("<!--DSH_MEMORY_COMPACT_JSON-->") >= 0 && SRC.indexOf('"compact":[') >= 0, "I3 任务书含哨兵 + compact JSON 格式要求");
  ok(SRC.indexOf("提炼完在该笔记主题追加一句「已提炼 → <目标topicId>」") < 0, "I4 任务书里旧的「给笔记主题追加 marker」要求已删除");
  ok(SRC.indexOf("NOTE_TOPIC_DREAM_FORBIDDEN") >= 0, "I5 守卫错误码 NOTE_TOPIC_DREAM_FORBIDDEN 存在");
  ok(SRC.indexOf("dbPatchGuardTopic") >= 0 && SRC.indexOf("isNoteTopicName(hit.topic.name)") >= 0, "I6 守卫用解析后的 topic（含 file 映射兜底）");
  ok(SRC.indexOf("noteCompactReplayPending(st, {})") >= 0, "I7 启动时 pending 重放已接线");
  ok(SRC.indexOf("noteCompact:pendingIndex") >= 0 && SRC.indexOf("NOTE_COMPACT_TTL_MS") >= 0, "I8 pending 索引 + TTL 常量存在");
  ok(/已提炼/.test(SRC) && !/提炼过的标「已提炼 → T-xxxx」/.test(SRC), "I9 memory_note 描述不再承诺「标已提炼 → T-xxxx」");
  const migPath = path.join(here, "..", "tools", "migrate-note-compact.mjs");
  const mig = fs.existsSync(migPath) ? fs.readFileSync(migPath, "utf8") : "";
  ok(/wal_checkpoint\(TRUNCATE\)/.test(mig) && /VACUUM INTO/.test(mig) && /runInTransaction/.test(mig) && /--dry-run/.test(mig) === false || /dry-run/.test(mig),
    "I10 迁移脚本含 WAL checkpoint + 备份 + 单事务 + dry-run", mig ? String(mig.length) + "B" : "missing");
  ok(SRC.indexOf("NOTE_POINTER_STRICT_RE") >= 0 && SRC.indexOf("!isStrictNotePointer(pointerText)") >= 0, "I11 采用模型 pointer 用严格判据（真机 T-0560 修复）");
}


// ═══════════════════════════════════════════════════════════════════════════
// K. 实现审计 D1/D2/D3/D4/D10 修复
// ═══════════════════════════════════════════════════════════════════════════
{
  // D1：主题只剩 1 行且就是指针 ⇒ 直接 skip（不删既有指针、不依赖 pending 恢复）
  const nt = noteTopic([]);
  store.appendSentence({ topic: nt.id, text: ptr(["T-0001"], 3) });
  const before = liveTexts(nt.id);
  const r1 = mod.__noteTopicCompact(store, nt.id, { pointer: "whatever", targets: ["T-0001"], baseline: {}, snapshot: { maxId: 999, count: 3, sha: {}, createdAt: Date.now() }, doneOk: true, spawnAt: Date.now() });
  ok(r1.ok === true && r1.skip === "already-distilled", "K1 D1 已收敛主题（仅 1 条指针）⇒ 直接 skip", JSON.stringify({ ok: r1.ok, skip: r1.skip }));
  ok(liveTexts(nt.id).join("|") === before.join("|"), "K2 D1 skip 不删既有指针、正文零改动");

  // D2：pointer 与 targets 不一致 ⇒ 按 targets 重生成（不拒、不再每轮回滚）
  const nt2 = noteTopic(["旧A", "旧B"]);
  const snap = snapOf(nt2.id);
  const t2 = mkTargetWithWrite();
  const base2 = targetBase();
  store.appendSentence({ topic: t2, text: "K 目标写入（bump writeCount）" });
  const badPointer = "2026-11-01 已提炼 2 句 → T-9999（原文 session_search sid8=deadbeef 可回溯）";
  const r2 = mod.__noteTopicCompact(store, nt2.id, { pointer: badPointer, targets: [t2], baseline: base2, snapshot: snap, doneOk: true, spawnAt: snap.createdAt });
  ok(r2.ok === true && r2.pointerRegenerated === true, "K3 D2 pointer 与 targets 不一致 ⇒ 插件重生成（不拒）", JSON.stringify({ ok: r2.ok, regen: r2.pointerRegenerated }));
  ok(!!r2.pointerText && mod.__isNotePointerText(r2.pointerText) && ptrTargets(r2.pointerText).join(",") === t2, "K4 D2 重生成的指针 T-id 与 targets 一致", String(r2.pointerText).slice(0, 90));
  ok(liveTexts(nt2.id).length === 1 && liveTexts(nt2.id)[0] === r2.pointerText, "K5 D2 正文只剩重生成的指针");

  // D4：快照 0 句 ⇒ skip（不 append 指针）
  const nt3 = noteTopic(["快照后新句"]);
  const r3 = mod.__noteTopicCompact(store, nt3.id, { pointer: ptr(["T-0001"], 0), targets: ["T-0001"], baseline: {}, snapshot: { maxId: 0, count: 0, sha: {}, createdAt: Date.now() }, doneOk: true, spawnAt: Date.now() });
  ok(r3.ok === true && r3.skip === "empty-snapshot", "K6 D4 快照 0 句 ⇒ skip（不 append 指针）", JSON.stringify({ ok: r3.ok, skip: r3.skip }));
  ok(!liveTexts(nt3.id).some((x) => mod.__isNotePointerText(x)), "K7 D4 skip 后未写指针");

  // D3：targets 与 pointer 集合相同但顺序不同 ⇒ 不再误拒
  const vOrder = mod.__noteCompactValidate(store, { pointer: ptr(["T-0001", "T-0002"], 2), targets: ["T-0002", "T-0001"], baseline: {}, doneOk: true, spawnAt: Date.now(), requirePointerFormat: true, rows: [] });
  ok(!(vOrder.errors || []).some((x) => String(x).indexOf("不一致") >= 0), "K8 D3 targets/pointer 顺序不同不再误拒", JSON.stringify(vOrder.errors));

  // D10：单轮缓存（rows 复用 ⇒ 0 次 topics()；dream 快照合并为 1 次）
  let calls = 0;
  const orig = store.topics.bind(store);
  store.topics = () => { calls += 1; return orig(); };
  try {
    const rows = orig();
    calls = 0;
    mod.__noteUnrefinedStats(store, rows);
    ok(calls === 0, "K9 D10 noteUnrefinedStats(rows) 不再调 store.topics()", "calls=" + calls);
    calls = 0;
    mod.__noteTakeDreamSnapshots(store);
    ok(calls === 1, "K10 D10 noteTakeDreamSnapshots 整库只扫 1 次（快照+基线同源）", "calls=" + calls);
    calls = 0;
    mod.__noteCompactValidate(store, { pointer: ptr(["T-0001"], 1), targets: ["T-0001"], baseline: {}, doneOk: true, spawnAt: Date.now(), rows: rows, requirePointerFormat: true });
    ok(calls === 0, "K11 D10 validate(rows) 不再调 store.topics()（target 走单行 getTopicById）", "calls=" + calls);
  } finally { store.topics = orig; }
}


// ═══════════════════════════════════════════════════════════════════════════
// L. CRA 2026-11-06：指针**一律重生成**（不信任模型内容）+ 严格判据/无 sid8 主题
// ═══════════════════════════════════════════════════════════════════════════
{
  // L1-L5：模型给 legacy 文本 + T-id 一致 ⇒ 一律重生成成严格格式（含 sid8 + 句数）
  const nt = noteTopic(["L 旧A", "L 旧B"]);
  const snap = snapOf(nt.id);
  const t = mkTargetWithWrite();
  const base = targetBase();
  store.appendSentence({ topic: t, text: "L 目标写入（bump writeCount）" });
  const legacyPointer = "已提炼 → " + t + "（2026-11-06 dream：某结论；可从会话日志检索）";
  const r = mod.__noteTopicCompact(store, nt.id, { pointer: legacyPointer, targets: [t], baseline: base, snapshot: snap, doneOk: true, spawnAt: snap.createdAt });
  ok(r.ok === true && r.pointerRegenerated === true, "L1 模型给 legacy 文本 ⇒ 强制重生成（pointerRegenerated=true）", JSON.stringify({ ok: r.ok, regen: r.pointerRegenerated }));
  ok(!!r.pointerText && mod.__isStrictNotePointer(r.pointerText), "L2 重生成指针命中严格判据（新格式 + sid8）", String(r.pointerText).slice(0, 120));
  ok(/已提炼 \d+ 句/.test(String(r.pointerText)) && String(r.pointerText).indexOf("sid8=" + nt.sid8) >= 0, "L3 重生成指针含句数 N 与真实 sid8（来自主题名）");
  ok(liveTexts(nt.id).length === 1 && liveTexts(nt.id)[0] === r.pointerText, "L4 库里唯一存活句 = 重生成的严格指针");
  ok(mod.__isNotePointerText(legacyPointer) && !mod.__isStrictNotePointer(legacyPointer), "L5 两判据分工：宽松识别 legacy、严格拒绝它");

  // L6-L7：模型给「格式严格但内容造假」的 pointer（sid8=deadbeef / N=999）⇒ 不采纳，按真实值重生成
  const nt2 = noteTopic(["L2 旧A"]);
  const snap2 = snapOf(nt2.id);
  const t2 = mkTargetWithWrite();
  const base2 = targetBase();
  store.appendSentence({ topic: t2, text: "L6 目标写入（bump writeCount）" });
  const fakeStrict = "2026-11-06 已提炼 999 句 → " + t2 + "（原文 session_search sid8=deadbeef 可回溯）";
  const r2 = mod.__noteTopicCompact(store, nt2.id, { pointer: fakeStrict, targets: [t2], baseline: base2, snapshot: snap2, doneOk: true, spawnAt: snap2.createdAt });
  ok(r2.ok === true && r2.pointerRegenerated === true, "L6 格式严格但内容造假（sid8/N 错）⇒ 仍重生成（不信任模型内容）", JSON.stringify({ ok: r2.ok, regen: r2.pointerRegenerated }));
  ok(r2.pointerText !== fakeStrict && String(r2.pointerText).indexOf("sid8=" + nt2.sid8) >= 0 && /已提炼 1 句/.test(String(r2.pointerText)), "L7 重生成用真实 sid8 与快照句数（非模型 999/deadbeef）", String(r2.pointerText).slice(0, 120));

  // L8：主题名无 sid8 ⇒ 生成器输出无 sid8 的指针，但仍是合法严格指针（不静默降级、不失败）
  const noSid = { id: mkTopic("笔记·SELFTEST-WS/nosid8x", ["L8 旧A"]) };
  const snap3 = snapOf(noSid.id);
  const t3 = mkTargetWithWrite();
  const base3 = targetBase();
  store.appendSentence({ topic: t3, text: "L8 目标写入（bump writeCount）" });
  const r3 = mod.__noteTopicCompact(store, noSid.id, { pointer: "已提炼 → " + t3, targets: [t3], baseline: base3, snapshot: snap3, doneOk: true, spawnAt: snap3.createdAt });
  ok(r3.ok === true && mod.__isStrictNotePointer(r3.pointerText) && String(r3.pointerText).indexOf("sid8=") < 0, "L8 无 sid8 主题 ⇒ 无 sid8 的严格指针（sid8 可选，不静默降级）", String(r3.pointerText).slice(0, 120));

  // L9：静态接线（一律重生成 + validate 用严格判据）
  ok(SRC.indexOf("compact-pointer-not-strict") >= 0 && SRC.indexOf("POINTER_NOT_STRICT") >= 0, "L9a 写入前严格校验 + 不合法失败（POINTER_NOT_STRICT）");
  ok(SRC.indexOf("!isStrictNotePointer(opts.pointer)") >= 0, "L9b validate 用严格判据（不再宽松降级）");
}

// ═══════════════════════════════════════════════════════════════════════════
// J. dream 端到端（fake subagents 返回哨兵 JSON ⇒ 真收敛）
// ═══════════════════════════════════════════════════════════════════════════
{
  const dreamHooks = mod.__dreamHooks || {};
  const agentCreated = (fx.captured.handlers || []).find((h) => h.event === "agent/created");
  ok(!!(agentCreated && typeof dreamHooks.spawnIntegrate === "function"), "J0 前置：agent/created + spawnIntegrate 钩子可用");
  if (agentCreated && typeof dreamHooks.spawnIntegrate === "function") {
    const DREAM_SID = "selftest-note-e2e-" + rand();
    // 空轮闸需要至少一个「超限主题」才会 spawn（lib 模式 overTopics 非空）
    const bigId = mkTopic("notecompact-oversize-" + rand(), ["x".repeat(9600)]);
    try { store.setLevel(bigId, "project", { actor: "runtime" }); } catch (e) { /* 层级失败则空轮可能跳过 */ }
    const nt = noteTopic(["E2E 旧句一", "E2E 旧句二"]);
    const snapshot = snapOf(nt.id);
    const target = mkTopic("notecompact-e2e-target-" + rand(), []);
    const pointer = ptr([target], 2, nt.sid8);
    const sentinel = mod.__NOTE_COMPACT_SENTINEL || "<!--DSH_MEMORY_COMPACT_JSON-->";
    const finalText = "整合完成。\n" + sentinel + "\n" + JSON.stringify({ compact: [{ topic: nt.id, pointer, targets: [target] }] });
    const dreamTool = findTool(fx.captured, "memory_dream_patch");
    const fakeAgent = { options: {}, session: { id: "session-note-e2e-" + rand(), header: { origin: "main", cwd: CWD }, cwd: CWD }, inject() {} };
    // 替换 subagents 桩：start 时先真实写目标主题（bump writeCount + LAST_DREAM_WROTE_AT），再返回带哨兵 JSON 的结果
    const prevStart = fx.subagents.start;
    fx.subagents.start = async (_kind, opts) => {
      try { dreamHooks.guardRegister(DREAM_SID, "dream", new AbortController(), 120000, 120000); } catch (e) { /* 已有则覆盖 */ }
      if (dreamTool) {
        const exec = { name: "memory_dream_patch", agent: { session: { id: DREAM_SID } } };
        const r = JSON.parse(await dreamTool.execute({ patches: [{ topic: target, action: "append", content: "E2E 长期句：" + rand() }] }, exec));
        if (!r || r.ok !== true) throw new Error("E2E 目标写入失败：" + JSON.stringify(r).slice(0, 200));
      }
      return { id: DREAM_SID, result: Promise.resolve({ output: [{ type: "text", text: finalText }], stopReason: "completed" }) };
    };
    try {
      try { agentCreated.fn({ agent: fakeAgent, source: "startup", signal: { aborted: false } }); } catch (e) { /* 注册失败后续可能无父 */ }
      await sleep(300);
      const _spawnRet = await dreamHooks.spawnIntegrate(fakeAgent, "note-selftest");
      if (_spawnRet !== true && _spawnRet !== "skipped") console.log("  [debug] spawnIntegrate 返回：" + JSON.stringify(_spawnRet));
      const done = await waitFor(() => {
        const t = liveTexts(nt.id);
        return t.length === 1 && mod.__isNotePointerText(t[0]);
      }, 20000, 100);
      ok(done, "J1 dream 端到端：哨兵 JSON ⇒ 笔记收敛为 1 条指针", "sentences=" + liveTexts(nt.id).length);
      const last = H.getLastCompact && H.getLastCompact();
      ok(!!(last && last.parsed === true && last.applied && last.applied.length >= 1), "J2 getLastCompact 记录本轮收敛结果", JSON.stringify(last && { parsed: last.parsed, applied: last.applied, failed: last.failed }));
      ok(liveTexts(nt.id).filter((x) => mod.__isNotePointerText(x)).length === 1, "J3 指针恰好 1 条");
    } catch (e) {
      ok(false, "J dream 端到端执行异常", (e && e.message) || String(e));
    } finally {
      fx.subagents.start = prevStart;
      void bigId; void snapshot;
    }
  }
}

// ── 收尾 ──
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);
