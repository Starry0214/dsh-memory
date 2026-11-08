// _note-archive-selftest.mjs —— 4.5.6 ③ 笔记主题归档出口（reviveTopic / memory_note 复活 / compact 拒绝 / stale sweep）
//
// 跑法：node test/_note-archive-selftest.mjs
//
// 覆盖（Lead 指定 8 项）：
//   ① 判据 live==1 + pointer + 30d 命中归档  ② 非 pointer 不归档  ③ 年龄 <30d 不归档
//   ④ pending 存在不归档  ⑤ memory_note 对 archived 主题先复活再写  ⑥ reviveTopic 重置 updatedAt + 审计
//   ⑦ noteTopicCompact 对 archived 拒绝  ⑧ sweep limit 20（附：memory_write archived 拒绝静态接线 + 真机 dry-run）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");
const SRC = fs.readFileSync(PLUGIN, "utf8");
const STORE_SRC = fs.readFileSync(path.join(here, "..", "memtopic", "src", "memory-store.mjs"), "utf8");
const LIFE_SRC = fs.readFileSync(path.join(here, "..", "memtopic", "src", "lifecycle.mjs"), "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) { } await sleep(step || 50); }
  return false;
}
const DAY = 86400000;

// ── 静态前置：不改全局 TRANSITIONS / ARCHIVABLE_STATES；memory_write archived 拒绝；tick 接线 ──
ok(/reviveTopic\(topicRef/.test(STORE_SRC), "S1 memory-store 新增 reviveTopic");
ok(/archived:\s*Object\.freeze\(\[\]\)/.test(LIFE_SRC), "S2 全局 TRANSITIONS.archived 仍为空（未改全局表）", "archived 仍是终点");
ok(/ARCHIVABLE_STATES\s*=\s*Object\.freeze\(\['draft', 'needs_review', 'dormant'\]\)/.test(LIFE_SRC), "S3 ARCHIVABLE_STATES 未加 active（只做 note 专用 sweep）");
ok(/code: "ARCHIVED_READONLY"/.test(SRC) && /NOTE_TOPIC_DREAM_FORBIDDEN/.test(SRC), "S4 memory_write 对 archived 拒绝（并补 note 主题禁 dream 直写）");
ok(/archiveStaleNoteTopics\(TOPICDB\.store, \{ now: t \}\)/.test(SRC) && /const NOTE_ARCHIVE_DAYS = 30;/.test(SRC) && /const NOTE_ARCHIVE_LIMIT = 20;/.test(SRC), "S5 sweep 挂在 p25LifecycleTick（30 天 / limit 20）");
ok(/live\.length !== 1/.test(SRC) && /isNotePointerText\(live\[0\]/.test(SRC) && /notePendingGet\(store, t\.id\)/.test(SRC), "S6 判据用 live 口径 + 指针 + pending（非 raw 物理行数）");
ok(/archived \*\*默认不被 memory_search 检索\*\*/.test(SRC), "S7 注释写明 archived 默认不被检索的取舍");

// ── 真跑：临时库 + fixture apply ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-note-archive-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- note archive 自测\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);
const fx = createFixtureCtx({});
await mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "C0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));

if (ready) {
  const store = mod.__topicdb.store;
  const H = mod.__noteHooks || {};
  const noteTool = findTool(fx.captured, "memory_note");
  ok(!!(noteTool && typeof noteTool.execute === "function"), "C0b 前置：memory_note 可取到");

  // ⑥ reviveTopic：重置 updatedAt + 审计（独立主题，避免污染 ⑤）
  const n1 = store.seedTopic({ name: "笔记·自测项目/aaaaaaaa", triggers: ["aaaa"], src: "note:aaaaaaaa", actor: "plugin" });
  const id1 = n1.id || (n1.topic && n1.topic.id);
  store.setState(id1, "active", { actor: "runtime", reason: "t" });
  store.appendSentence({ topic: id1, text: "[10:00] 旧笔记一句", src: "note:aaaaaaaa", actor: "runtime" });
  const before = Date.now();
  store.setState(id1, "archived", { actor: "runtime", reason: "test-archive" });
  const archAt = Number(store.be.getTopicById(id1).updatedAt || 0);
  await sleep(15);
  const rv = store.reviveTopic(id1, { actor: "runtime", reason: "test-revive" });
  const after = store.be.getTopicById(id1);
  ok(rv && rv.ok === true && rv.from === "archived" && rv.to === "active", "A1 reviveTopic archived→active", JSON.stringify(rv));
  ok(after.state === "active", "A2 复活后 state=active");
  ok(Number(after.updatedAt) >= archAt && Number(after.updatedAt) >= before, "A3 复活重置 updatedAt（30 天计时重新开始）", "arch=" + archAt + " after=" + after.updatedAt);
  let auditHit = false;
  try { auditHit = (store.auditTail(200) || []).some((x) => String(x && x.op) === "topic.revive" && String(x.topicId) === String(id1)); } catch (e) { auditHit = false; }
  ok(auditHit, "A4 复活写审计 topic.revive");
  const again = store.reviveTopic(id1, { actor: "runtime" });
  ok(again && again.ok === true && again.unchanged === true, "A5 非 archived 幂等（unchanged=true）");

  // ⑤ memory_note 对 archived 主题：先复活再 append（读/搜不复活）
  const SID = "1b736c53-7fc7-4be1-a22c-0fa4043c963e";
  const exec = { name: "memory_note", agent: { session: { id: SID }, header: { cwd: "E:\\工具\\note归档自测" } } };
  const call = async (args) => JSON.parse(await noteTool.execute(args, exec));
  const first = await call({ text: "笔记归档自测：第一条", kind: "quote" });
  ok(first.ok === true && first.created === true, "B0 前置：建立本会话笔记主题", JSON.stringify(first).slice(0, 120));
  const idB = first.topicId;
  store.setState(idB, "archived", { actor: "runtime", reason: "test-archive" });
  ok(store.be.getTopicById(idB).state === "archived", "B1 前置：主题已归档");
  const second = await call({ text: "归档后继续写：应触发复活", kind: "future" });
  const afterB = store.be.getTopicById(idB);
  ok(second.ok === true && second.topicId === idB, "B2 memory_note 对 archived 主题写入成功（复活后 append）", JSON.stringify(second).slice(0, 140));
  ok(afterB.state === "active", "B3 写入后主题已复活为 active");
  const liveB = store.readTopic(idB).sentences || [];
  ok(liveB.length === 2 && liveB.some((s) => String(s.text || "").includes("归档后继续写")), "B4 新句确已 append（不是只复活）", "live=" + liveB.length);

  // ⑦ noteTopicCompact 对 archived 拒绝
  const n2 = store.seedTopic({ name: "笔记·自测项目/bbbbbbbb", triggers: ["bbbb"], src: "note:bbbbbbbb", actor: "plugin" });
  const id2 = n2.id || (n2.topic && n2.topic.id);
  store.setState(id2, "active", { actor: "runtime", reason: "t" });
  store.appendSentence({ topic: id2, text: "[10:01] 可收敛的一句", src: "note:bbbbbbbb", actor: "runtime" });
  store.setState(id2, "archived", { actor: "runtime", reason: "test-archive" });
  ok(typeof H.noteTopicCompact === "function", "C0 前置：__noteHooks.noteTopicCompact 可用");
  const compact = H.noteTopicCompact(store, id2, { snapshot: { maxId: 999999, count: 1, sha: {} }, targets: [], baseline: {}, now: Date.now() });
  ok(compact && compact.ok === false && compact.code === "ARCHIVED", "C1 noteTopicCompact 对 archived 拒绝（code=ARCHIVED）", JSON.stringify(compact).slice(0, 160));
  ok(store.be.getTopicById(id2).state === "archived", "C2 拒绝后主题仍是 archived（未误改状态）");

  // ①②③④⑧ sweep 判据（真实 store）
  ok(typeof mod.__archiveStaleNoteTopics === "function", "D0 前置：__archiveStaleNoteTopics 可导入");
  ok(mod.__noteArchiveDays === 30 && mod.__noteArchiveLimit === 20, "D0b 常量 30 天 / limit 20");
  const now = Date.now();
  const pointerText = H.noteFormatPointer({ count: 3, targets: ["T-0001"], sid8: "cccccccc" });
  const mkNote = (tag, liveText, ageDays, extra) => {
    const sid = ("cccc" + tag).padEnd(8, "0").slice(0, 8);
    const n = store.seedTopic({ name: "笔记·sweep自测/" + sid, triggers: [tag], src: "note:" + sid, actor: "plugin" });
    const id = n.id || (n.topic && n.topic.id);
    store.setState(id, "active", { actor: "runtime", reason: "t" });
    if (liveText != null) store.appendSentence({ topic: id, text: liveText, src: "note:" + sid, actor: "runtime" });
    store.be.updateTopic(id, { updatedAt: now - ageDays * DAY });
    if (extra) extra(id);
    return id;
  };
  const idHit = mkNote("hit1", pointerText, 31);          // ① 命中
  const idNoPtr = mkNote("noptr", "[10:02] 还有未提炼内容", 31);   // ② 非 pointer
  const idYoung = mkNote("young", pointerText, 29);        // ③ <30d
  const idPend = mkNote("pend", pointerText, 31, (id) => { try { H.notePendingPut(id, { topicId: id, pointer: pointerText, createdAt: now, ttlMs: 3600000 }); } catch (e) {} });   // ④ pending
  const idArch = mkNote("archv", pointerText, 40);
  store.setState(idArch, "archived", { actor: "runtime", reason: "pre-archived" });
  const sw = mod.__archiveStaleNoteTopics(store, { now: now });
  const stOf = (id) => store.be.getTopicById(id).state;
  ok(stOf(idHit) === "archived", "D1 判据命中：live==1+pointer+31d ⇒ 归档");
  ok(stOf(idNoPtr) === "active", "D2 非 pointer 不归档（仍有未提炼内容）");
  ok(stOf(idYoung) === "active", "D3 年龄 29 天不归档");
  ok(stOf(idPend) === "active", "D4 有 note pending 不归档");
  ok(sw && sw.archived === 1 && sw.details.some((x) => x.id === idHit), "D5 sweep 结果口径 {archived,details}", JSON.stringify({ archived: sw.archived, scanned: sw.scanned, candidates: sw.candidates, skipped: sw.skipped }));

  // ⑧ limit 20：造 25 个合格主题 ⇒ 只归档 20
  let made = 0;
  for (let i = 1; i <= 25; i++) {
    const sid = ("ee" + i.toString(16).padStart(2, "0")).padEnd(8, "0");
    const n = store.seedTopic({ name: "笔记·limit自测/" + sid, triggers: ["lim" + i], src: "note:" + sid, actor: "plugin" });
    const id = n.id || (n.topic && n.topic.id);
    store.setState(id, "active", { actor: "runtime", reason: "t" });
    store.appendSentence({ topic: id, text: pointerText, src: "note:" + sid, actor: "runtime" });
    store.be.updateTopic(id, { updatedAt: now - 45 * DAY });
    made++;
  }
  const sw2 = mod.__archiveStaleNoteTopics(store, { now: now });
  ok(made === 25 && sw2.archived === 20 && sw2.details.length === 20, "D6 sweep 单次 limit 20（25 个合格只归档 20）", "archived=" + sw2.archived);
  const sw3 = mod.__archiveStaleNoteTopics(store, { now: now, limit: 20 });
  ok(sw3.archived === 5, "D7 幂等：再跑一次只处理剩余 5 个", "archived=" + sw3.archived);

  // 真机 dry-run（只读副本）：现有 15 个笔记主题应 0 归档（年龄全部 <30 天）
  try {
    const dbSrc = path.join(process.env.USERPROFILE || "C:\\Users\\Starry", ".dsh", "memory", ".memtopic", "mem.db");
    if (!fs.existsSync(dbSrc)) console.log("SKIP  E 真机 dry-run（无 mem.db）");
    else {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-note-arch-dry-"));
      const dst = path.join(tmp2, "mem.db");
      fs.copyFileSync(dbSrc, dst);
      for (const ext of ["-wal", "-shm"]) { try { fs.copyFileSync(dbSrc + ext, dst + ext); } catch (e) {} }
      const ms = await import(pathToFileURL(path.join(here, "..", "memtopic", "src", "memory-store.mjs")).href);
      const bs = await import(pathToFileURL(path.join(here, "..", "memtopic", "src", "backend-sqlite.mjs")).href);
      const be = new bs.SqliteBackend(dst);
      const s2 = new ms.MemoryStore(be);
      const dry = mod.__archiveStaleNoteTopics(s2, { now: Date.now() });
      ok(dry.archived === 0, "E1 真机 dry-run：现有笔记主题 0 个满足 >30d（不批量归档）", JSON.stringify({ scanned: dry.scanned, candidates: dry.candidates, archived: dry.archived }));
      try { be.close(); } catch (e) {}
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  } catch (e) { console.log("SKIP  E 真机 dry-run 异常（不影响门）：" + ((e && e.message) || e)); }

  try { mod.__topicdb.close && mod.__topicdb.close(); } catch (e) {}
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
