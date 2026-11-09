// topicdb-p6-check.mjs —— task-47（P6）自动导出 + md 只读标记 + 导入侧忽略标记行
// 断言：M01 自动导出 / M02 节流 / M03 不覆盖原 md / M04 --mark-md 开关 / M05 默认不加标记 / M06 坏库不抛错
//       + M07 真实重导入：标记行不进库、句数不变
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = "E:/工具/插件开发调整";
const PLUGIN = ROOT + "/dsh-memory-plugin/index.js";
const FIXTURE = ROOT + "/dsh-memory-plugin/_fixture-ctx.mjs";
const IMPORT_MJS = ROOT + "/memtopic/src/import.mjs";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-p6-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects", "tools"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
const F_GLOBAL = path.join(MEM, "global.md");
const F_INDEX = path.join(MEM, "index.md");
const F_AGENTS = path.join(MEM, "AGENTS.md");
const F_SESS = path.join(MEM, "sessions", "2026-10-30.md");
const F_KNOW = path.join(MEM, "knowledge", "知识甲.md");
fs.writeFileSync(F_GLOBAL, "# 全局记忆\n- 稳定层内容（人工维护）\n", "utf8");
fs.writeFileSync(F_INDEX, "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(F_AGENTS, "# 协议\n- 定稿不改\n", "utf8");
fs.writeFileSync(F_SESS, "# 会话甲\n- 会话句一\n- 会话句二\n", "utf8");
fs.writeFileSync(F_KNOW, "# 知识甲\n- 知识句\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;
delete process.env.DSH_MEMORY_MARK_MD;
delete process.env.MEMORY_MARK_MD;

const mod = await import(pathToFileURL(PLUGIN).href);
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);
const { importDir } = await import(pathToFileURL(IMPORT_MJS).href);
const { MemoryStore } = await import(pathToFileURL(ROOT + "/memtopic/src/memory-store.mjs").href);
const { SqliteBackend } = await import(pathToFileURL(ROOT + "/memtopic/src/backend-sqlite.mjs").href);
let pass = 0; const fails = [];
function ok(c, n, d) { if (c) { pass++; console.log("PASS  " + n + (d ? "  —  " + d : "")); } else { fails.push(n); console.log("FAIL  " + n + (d ? "  —  " + d : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha16 = (p) => (fs.existsSync(p) ? createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16) : "(缺失)");
const sha16s = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
const today = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
const EXPORT_ROOT = path.join(MEM, "_export");
function exportFiles() { return fs.existsSync(EXPORT_ROOT) ? fs.readdirSync(EXPORT_ROOT, { recursive: true }).map(String).filter((x) => x.endsWith(".md")).sort() : []; }
function walkUserFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "_export" && e.name !== ".memtopic") walkUserFiles(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}
function userSnapshot() { return JSON.stringify(walkUserFiles(MEM).map((p) => [path.relative(MEM, p).split(path.sep).join("/"), sha16(p)])); }

const MARK = "<!-- dsh-memory:";
const MARK_LINE = "<!-- dsh-memory: 本文件由主题库维护，手工修改不会生效；改动请用 memory_write / memory_dream_patch -->";

{
  const fx = createFixtureCtx({});
  mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
  for (let i = 0; i < 200; i++) { if (mod.__topicdb && mod.__topicdb.ready) break; await sleep(100); }
  ok(!!(mod.__topicdb && mod.__topicdb.ready), "前置：flag 开 ⇒ 主题库就绪");
  ok(typeof mod.__topicdbAutoExport === "function" && typeof mod.__topicdbMarkMd === "function",
    "前置：自动导出/标记函数已导出（直调线上同一份实现）");
}
const store = mod.__topicdb.store;
// 主题 + 句级 src 映射（只读标记只认这种映射）
const mk = (name, src, text) => {
  const t = store.seedTopic({ name, src: null });
  store.appendSentence({ topic: t.id, text, src, actor: "lead" });
  return t;
};
mk("会话甲", "sessions/2026-10-30.md", "- 会话句一");
mk("知识甲", "knowledge/知识甲.md", "- 知识句");
mk("全局记忆", "global.md", "- 稳定层内容（人工维护）");
mk("记忆索引", "index.md", "- global.md");
mk("协议", "AGENTS.md", "- 定稿不改");
mk("缺失文件主题", "knowledge/不存在.md", "- 缺失句");
mk("越界文件主题", "../outside.md", "- 越界句");

const BEFORE = userSnapshot();
const PROTECTED_BEFORE = { g: sha16(F_GLOBAL), i: sha16(F_INDEX), a: sha16(F_AGENTS) };

// ── M01 自动导出：模拟结构变更（write 理由，走与 healthTick 调度同一个函数）──
let exp1 = null;
{
  const marker = mod.__topicdbResetExportLock;
  const r = mod.__topicdbAutoExport({ reason: "write", force: true });
  exp1 = r;
  ok(r && r.ok === true, "M01 自动导出成功（reason=write）", JSON.stringify({ ok: r && r.ok, skipped: r && r.skipped, error: r && r.error }));
  ok(!!r.file && fs.existsSync(path.join(MEM, r.file)), "M01 导出 md 文件已生成", r && r.file);
  const mdFresh = store.exportMd();
  const fileText = fs.readFileSync(path.join(MEM, r.file), "utf8");
  ok(fileText === mdFresh, "M01 导出内容与 store.exportMd() 逐字一致");
  ok(r.export && r.export.sha256 === sha16s(fileText), "M01 manifest sha256 = 文件内容 sha（可校验）", r.export && r.export.sha256);
  const topicsN = store.topics().length;
  let sent = 0, chars = 0;
  for (const t of store.topics()) { sent += Number(t.physicalSentences == null ? t.sentences || 0 : t.physicalSentences); chars += Number(t.physicalChars == null ? t.chars || 0 : t.physicalChars); }
  ok(r.export && r.export.topics === topicsN && r.export.sentences === sent && r.export.chars === chars,
    "M01 manifest 主题数/句数/字符数与库一致", JSON.stringify({ manifest: r.export && { topics: r.export.topics, sentences: r.export.sentences, chars: r.export.chars }, store: { topics: topicsN, sentences: sent, chars } }));
  ok(r.export && r.export.mdChars === fileText.length, "M01 manifest mdChars = 导出 md 长度");
  const gMan = JSON.parse(fs.readFileSync(path.join(MEM, "_export", ".manifest.json"), "utf8"));
  const dMan = JSON.parse(fs.readFileSync(path.join(MEM, path.dirname(r.file), ".manifest.json"), "utf8"));
  ok(gMan.lastExportAt > 0 && gMan.lastExport && gMan.lastExport.sha256 === r.export.sha256 && Array.isArray(gMan.exports) && gMan.exports.length === 1,
    "M01 全局 _export/.manifest.json：lastExportAt/lastExport/sha 正确", JSON.stringify({ lastExportAt: gMan.lastExportAt, exports: gMan.exports && gMan.exports.length }));
  ok(dMan.date === today && Array.isArray(dMan.exports) && dMan.exports.length === 1,
    "M01 当日 _export/<日期>/.manifest.json 正确", JSON.stringify({ date: dMan.date, exports: dMan.exports && dMan.exports.length }));
}

// ── M02 节流：30 分钟内二次触发 ⇒ skipped:throttled；session 6h 条件独立生效 ──
{
  const n0 = exportFiles().length;
  const r2 = mod.__topicdbAutoExport({ reason: "write" });
  ok(r2 && r2.ok === false && r2.skipped === "throttled" && r2.lastExportAt > 0,
    "M02 30 分钟内二次触发 ⇒ skipped:throttled", JSON.stringify({ ok: r2 && r2.ok, skipped: r2 && r2.skipped, retryAfterMs: r2 && r2.retryAfterMs }));
  ok(exportFiles().length === n0, "M02 节流期间不新增导出文件");
  const rs = mod.__topicdbAutoExport({ reason: "session", throttleMs: 0 });
  ok(rs && rs.skipped === "session-gap", "M02 会话触发：距上次 <6h ⇒ skipped:session-gap（与 30min 节流独立）", JSON.stringify({ skipped: rs && rs.skipped }));
  const sched = mod.__topicdbScheduleAutoExport("write");
  ok(sched === false, "M02 节流期内调度器直接返回 false（不排定时器）");
}

// ── M01b 结构变更（healthTick）真实调度：备份旧 manifest 以模拟"上次导出已过期" ──
let schedFile = null;
{
  const manPath = path.join(MEM, "_export", ".manifest.json");
  const bak = manPath + ".m01bak";
  try { fs.renameSync(manPath, bak); } catch (e) {}
  mod.__topicdbExportReset();
  try { fs.rmSync(manPath, { force: true }); } catch (e) {}
  const before = exportFiles().length;
  const scheduled = mod.__topicdbScheduleAutoExport("write");
  mod.__topicdbHealthTick(true, null, store);   // 模拟一次成功写库（结构变更）
  await sleep(500);
  const after = exportFiles().length;
  const last = mod.__topicdbExportState.lastResult;
  schedFile = last && last.file;
  ok(scheduled === true && after > before && last && last.ok === true && last.reason === "write",
    "M01b healthTick 后自动调度导出（reason=write，异步、不阻塞）", JSON.stringify({ scheduled, before, after, ok: last && last.ok, reason: last && last.reason }));
  try { fs.rmSync(bak, { force: true }); } catch (e) {}
}

// ── M03 不覆盖现有 md：导出前后用户 md 路径+sha 完全不变 ──
{
  const after = userSnapshot();
  ok(after === BEFORE, "M03 导出不覆盖现有 md：全库用户 md 路径+sha 前后一致", after === BEFORE ? "" : "有变化");
  ok(sha16(F_SESS) === JSON.parse(BEFORE).find((x) => x[0] === "sessions/2026-10-30.md")[1], "M03 sessions/ 文件 sha 未变");
  ok(sha16(F_KNOW) === JSON.parse(BEFORE).find((x) => x[0] === "knowledge/知识甲.md")[1], "M03 knowledge/ 文件 sha 未变");
  ok(sha16(F_GLOBAL) === PROTECTED_BEFORE.g && sha16(F_INDEX) === PROTECTED_BEFORE.i && sha16(F_AGENTS) === PROTECTED_BEFORE.a,
    "M03 global/index/AGENTS sha 未变");
}

// ── M05 默认（未开 --mark-md）不加标记：dry-run 只报告、不写盘 ──
{
  const before = userSnapshot();
  const dry = mod.__topicdbMarkMd({});
  ok(dry && dry.ok === true && dry.apply === false && dry.marked.length === 0 && dry.wouldMark.length > 0,
    "M05 默认 dry-run：只报告 wouldMark、marked=0", JSON.stringify({ marked: dry && dry.marked.length, wouldMark: dry && dry.wouldMark.length }));
  ok(userSnapshot() === before && !fs.readFileSync(F_SESS, "utf8").startsWith(MARK),
    "M05 默认不写盘：用户 md 无标记、sha 不变");
  ok(mod.__topicdbMarkMdEnabled({}) === false, "M05 默认开关关闭（env/argv 均未设）");
}

// ── M04 --mark-md 开关：只标记有 src 映射的文件；稳定层永不加；幂等 ──
{
  const shaBeforeSess = sha16(F_SESS), shaBeforeKnow = sha16(F_KNOW);
  const r = mod.__topicdbMarkMd({ apply: true });
  const markedSet = new Set((r.marked || []).map((x) => x.replace(/\\/g, "/")));
  ok(r && r.ok === true && markedSet.has("sessions/2026-10-30.md") && markedSet.has("knowledge/知识甲.md"),
    "M04 --mark-md：有 src 映射的 sessions/knowledge 文件被加标记",
    JSON.stringify({ marked: r.marked, shaBefore: { sessions: shaBeforeSess, knowledge: shaBeforeKnow }, shaAfter: { sessions: sha16(F_SESS), knowledge: sha16(F_KNOW) } }));
  const sessText = fs.readFileSync(F_SESS, "utf8");
  ok(sessText.split(/\r?\n/)[0] === MARK_LINE && sessText.includes("- 会话句一"),
    "M04 标记在首行（精确文案）且原文逐字保留");
  ok(!fs.readFileSync(F_GLOBAL, "utf8").includes(MARK) && !fs.readFileSync(F_INDEX, "utf8").includes(MARK) && !fs.readFileSync(F_AGENTS, "utf8").includes(MARK),
    "M04 global.md/index.md/AGENTS.md 永不加标记");
  const pr = new Set((r.skippedProtected || []).map((x) => x.replace(/\\/g, "/")));
  ok(pr.has("global.md") && pr.has("index.md") && pr.has("AGENTS.md"), "M04 稳定层被显式列入 skippedProtected", JSON.stringify(r.skippedProtected));
  ok((r.skippedMissing || []).some((x) => x.includes("不存在")), "M04 缺失文件跳过（skippedMissing）");
  ok((r.skippedUnsafe || []).some((x) => x.includes("outside")), "M04 越界路径拒绝（skippedUnsafe）");
  const r2 = mod.__topicdbMarkMd({ apply: true });
  const already = new Set((r2.skippedAlready || []).map((x) => x.replace(/\\/g, "/")));
  ok(r2.marked.length === 0 && already.has("sessions/2026-10-30.md") && already.has("knowledge/知识甲.md"),
    "M04 幂等：已有标记不重复加（marked=0 / skippedAlready 命中）", JSON.stringify({ marked: r2.marked, skippedAlready: r2.skippedAlready }));
  ok(fs.readFileSync(F_SESS, "utf8").split(MARK_LINE).length - 1 === 1, "M04 标记只出现一次（无重复）");
  // 开关三通道：参数 / env / argv
  process.env.DSH_MEMORY_MARK_MD = "1";
  const envOn = mod.__topicdbMarkMdEnabled({});
  delete process.env.DSH_MEMORY_MARK_MD;
  ok(envOn === true && mod.__topicdbMarkMdEnabled({ flag: "--mark-md" }) === true,
    "M04 开关可手动触发：env=1 / --mark-md 均生效（默认关）");
}

// ── M07 真实重导入：带标记文件 ⇒ 标记行不进库、句数不变 ──
{
  const importRoot = path.join(TMP, "reimport-root");
  fs.mkdirSync(path.join(importRoot, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(importRoot, "sessions", "2026-10-30.md"), fs.readFileSync(F_SESS));
  const db2 = path.join(TMP, "reimport.db");
  const be2 = new SqliteBackend(db2);
  const st2 = new MemoryStore(be2);
  const r1 = importDir(st2, { root: importRoot });
  const t2 = be2.listTopics().find((x) => x.name === "会话甲");
  const texts = t2 ? st2.readTopic(t2.id).sentences.map((s) => String(s.text)) : [];
  ok(r1.sentencesAdded === 2 && t2 && texts.length === 2 && !texts.some((x) => x.startsWith(MARK)),
    "M07 带标记文件真实重导入：+2 句正文、标记行不进库", JSON.stringify({ added: r1.sentencesAdded, texts }));
  const r2 = importDir(st2, { root: importRoot });
  const texts2 = t2 ? st2.readTopic(t2.id).sentences.map((s) => String(s.text)) : [];
  ok(r2.sentencesAdded === 0 && texts2.length === 2 && !texts2.some((x) => x.startsWith(MARK)),
    "M07 重导入幂等：+0 句、句数不变（2）且无标记行", JSON.stringify({ added: r2.sentencesAdded, count: texts2.length }));
  try { be2.close(); } catch (e) {}
}

// ── M06 坏库/导出失败：cwarn、主流程不抛错 ──
{
  const good = mod.__topicdb.store;
  let threw = null;
  let r = null;
  try {
    mod.__topicdb.store = { exportMd() { throw new Error("simulated: bad db"); } };
    r = mod.__topicdbAutoExport({ reason: "write", force: true });
  } catch (e) { threw = e; }
  mod.__topicdb.store = good;
  ok(!threw && r && r.ok === false && String(r.error).includes("simulated"),
    "M06 坏库：不抛错、ok:false、error 透出（调用方不受影响）", threw ? ("抛了: " + threw.message) : JSON.stringify({ ok: r && r.ok, error: r && r.error }));
  let threw2 = null;
  try { mod.__topicdbHealthTick(true, null, { transactionDepth() { throw new Error("bad depth"); } }); } catch (e) { threw2 = e; }
  ok(!threw2, "M06 healthTick 遇到坏 store 也不抛错（写路径不受连带影响）");
  const r2 = mod.__topicdbAutoExport({ reason: "write", force: true, store: { topics() { return []; }, exportMd() { return ""; } } });
  ok(r2 && r2.ok === true, "M06 空库导出也不崩（md 空串仍可写）", JSON.stringify({ ok: r2 && r2.ok, file: r2 && r2.file }));
}

// ── M08 导出目录安全面：所有导出产物都在 _export/ 下，无外部写 ──
{
  const unexpected = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && !f.startsWith(EXPORT_ROOT + path.sep)) {
        if (path.basename(f).startsWith("memory-export-")) unexpected.push(f);
      }
    }
  };
  walk(MEM);
  ok(unexpected.length === 0, "M08 导出文件全部落在 _export/ 下（无外部写）", JSON.stringify(unexpected));
  const man = JSON.parse(fs.readFileSync(path.join(MEM, "_export", ".manifest.json"), "utf8"));
  ok(man.dir === "_export" && Array.isArray(man.exports) && man.exports.length >= 2,
    "M08 导出历史累计在 manifest.exports（跨触发多次导出）", JSON.stringify({ dir: man.dir, exports: man.exports && man.exports.length }));
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
console.log("备注：P6 = 自动导出（30min 节流 + 会话 6h 门槛）+ md 只读标记（--mark-md 才写）+ 导入侧恒忽略标记行。");
console.log("导出样例目录：" + (exp1 && exp1.dir ? exp1.dir : "(无)") + " ；文件：" + (exp1 && exp1.file ? exp1.file : "(无)"));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) {}
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);
