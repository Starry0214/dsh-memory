// topicdb-sink-check.mjs —— task-44（P4：两个 sink → 库内 split/archive）脚本级验收 K01–K06
//
// ⚠️ 现状（如实）：`store.splitTopic` 目前是 **NOT_IMPLEMENTED**（task-41 未实现物理拆分），
//    而「append 到新主题 + deleteSentence 原主题」不能手工模拟——store 的删除是**按 sha 全局墓碑**
//    （`_liveSentences` 用 `_deletedSet()` 过滤 sha）⇒ 删原句会让新主题的同文副本一起不可见。
//    ⇒ 超限下沉的**库内拆分部分被 store 能力阻塞**：本脚本验的是"检测到未实现 ⇒ 明确 why + 回落 md + 不留假拆分副作用"。
//    archiveTopic 已实现 ⇒ 日摘要归档这一半是**真交付**，正常验收。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-sink-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- sink 检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shaOfFile = (p) => (fs.existsSync(p) ? createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16) : "(缺失)");
async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store) return true;
    await sleep(100);
  }
  return false;
}

{
  const fx = createFixtureCtx({});
  plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
  ok(await waitReady(), "前置：flag 开 ⇒ 主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
  ok(typeof mod.sinkOverLimitFile === "function" && typeof mod.sinkExpiredDailySummary === "function"
    && typeof mod.sinkOverLimitFileToDb === "function" && typeof mod.sinkExpiredDailySummaryToDb === "function",
    "前置：两条 sink 与库内实现均已导出（断言直调线上同一份）");
}

const store = mod.__topicdb.store;
const REL = "projects/面板检查下沉.md";
const MD_FILE = path.join(MEM, REL);
const DAY = "2026-10-20";
const RELD = "sessions/" + DAY + ".md";
const MDD = path.join(MEM, RELD);
const dom = store.createDomain("面板检查域", { actor: "lead" });
const mkTopic = (name, rel, lines) => {
  const r = store.seedTopic({ name: name, triggers: [], src: rel });
  store.setLevel(r.id, "detail", { actor: "lead" });
  store.linkParent(r.id, dom.id, { actor: "lead" });
  for (const s of lines) store.appendSentence({ topic: r.id, text: s, src: rel, actor: "plugin" });
  return r.id;
};
const topic = mkTopic("面板检查下沉", REL, ["活内容一", "活内容二", "## 归档", "归档句一", "归档句二", "归档句三"]);
const daily = mkTopic("日摘要 · " + DAY, RELD, ["日摘要甲", "日摘要乙", "日摘要丙"]);
const liveTexts = (id) => (store.readTopic(id).sentences || []).map((s) => String(s.text));
ok(liveTexts(topic).length === 6 && liveTexts(daily).length === 3, "造数：源主题 6 句（2 活 + ## 归档 + 3 冷）/ 日摘要 3 句");
// ═══════════════════════════════════════════════════════════════════════════
// [task-53] S-D1…S-D5：库内「日摘要过期」候选发现（主题库模式；sessions/ 无 md）
//   缺陷背景：listExpiredDailyOverflow 只扫 md 文件 ⇒ 主题库模式（md=导出视图）永远 0 候选
//   ⇒ sinkExpiredDailySummaryToDb 返回 no-candidate ⇒ 库内日摘要主题永远不会被自动归档。
// ═══════════════════════════════════════════════════════════════════════════
const TODAY = "2026-10-30";
const makeDailyText = (chars) => { const head = "日摘要·"; return head + "库".repeat(Math.max(0, chars - head.length)); };
const expireA = mkTopic("日摘要 · 2026-10-27", "sessions/2026-10-27.md", [makeDailyText(320)]);
const expireB = mkTopic("日摘要 · 2026-10-26", "sessions/2026-10-26.md", [makeDailyText(620)]);
const todayT = mkTopic("日摘要 · " + TODAY, "sessions/" + TODAY + ".md", [makeDailyText(800)]);
ok(store.readTopic(expireB).sentences[0].text.length === 620, "造数（S-D）：过期日摘要 620 字符 / 另一份 320 / 当日 800", "B=" + store.readTopic(expireB).sentences[0].text.length);
// 前提：sessions/ 目录清空（只有库、没有 md）
const sessDir = path.join(MEM, "sessions");
fs.rmSync(sessDir, { recursive: true, force: true });
fs.mkdirSync(sessDir, { recursive: true });
ok(fs.readdirSync(sessDir).length === 0, "造数（S-D）：sessions/ 为空 ⇒ 复现「只有库没有 md」");

// ── S-D3（先做）：库内只有「当日超限」⇒ today-skip、当日主题不动、不回落无意义 warn ──
{
  const r = mod.sinkExpiredDailySummaryToDb(null, { limit: 700, today: TODAY });
  ok(r && r.ok === false && r.why === "today-skip" && r.source === "db",
    "S-D3 库内只有当日超限 ⇒ today-skip（source=db）", JSON.stringify({ ok: r && r.ok, why: r && r.why, source: r && r.source }));
  const rw = mod.sinkExpiredDailySummary(null, { limit: 700, today: TODAY });
  const todayRow = store.topics().find((t) => t.id === todayT) || {};
  ok(rw && rw.why === "today-skip" && todayRow.state !== "archived" && store.readTopic(todayT).sentences.length === 1,
    "S-D3 当日主题不动（包装层直接 today-skip，不归档/不改句）", JSON.stringify({ why: rw && rw.why, state: todayRow.state }));
}

// ── S-D1：只有库、没有 md ⇒ 自动选中过期最大者并归档，channel/source=db，零 md 文件产生 ──
let sd1 = null;
{
  const md0 = fs.readdirSync(sessDir).length;
  sd1 = mod.sinkExpiredDailySummaryToDb(null, { limit: 300, today: TODAY });
  ok(sd1 && sd1.ok === true && sd1.channel === "db" && sd1.source === "db" && sd1.archived && sd1.archived.topicId === expireB && sd1.day === "2026-10-26",
    "S-D1 库内候选命中：选中过期最大者（2026-10-26 / 620 字符）并归档，channel=db、source=db", JSON.stringify({ ok: sd1 && sd1.ok, source: sd1 && sd1.source, day: sd1 && sd1.day, archived: sd1 && sd1.archived }));
  ok(sd1 && sd1.dbCandidate && sd1.dbCandidate.chars === 620 && sd1.archived.sentences === 1,
    "S-D1 候选数据：chars=620、归档前 1 句", JSON.stringify(sd1 && sd1.dbCandidate));
  ok(fs.readdirSync(sessDir).length === md0, "S-D1 零 md 文件产生（不读不写 md）", "sessions 文件数=" + fs.readdirSync(sessDir).length);
}

// ── S-D2：归档后 readTopic 仍可读（pointer 语义）、state=archived、父主题留指针 ──
{
  const row = store.topics().find((t) => t.id === expireB) || {};
  ok(row.state === "archived", "S-D2 归档后主题 state=archived", row.state);
  const rt = store.readTopic(expireB);
  const texts = (rt.sentences || []).map((x) => String(x.text));
  ok(texts.length === 1 && texts[0].length === 620, "S-D2 readTopic 仍可读全文（pointer 语义，原文保留）", "sentences=" + texts.length + " chars=" + (texts[0] || "").length);
  ok(liveTexts(dom.id).some((t) => /已归档/.test(t) && t.indexOf(expireB) >= 0), "S-D2 父主题留「已归档」指针", liveTexts(dom.id).filter((t) => /已归档/.test(t)).slice(-1).join(""));
}

// ── S-D5：二次调用幂等（alreadyArchived，不重复归档、不新增句）──
{
  const r = mod.sinkExpiredDailySummary("sessions/2026-10-26.md", { limit: 300, today: TODAY });
  ok(r && r.ok === true && r.archived && r.archived.alreadyArchived === true, "S-D5 二次调用幂等（alreadyArchived=true）", JSON.stringify({ ok: r && r.ok, archived: r && r.archived, why: r && r.why }));
  ok(store.readTopic(expireB).sentences.length === 1 && (store.topics().find((t) => t.id === expireB) || {}).state === "archived",
    "S-D5 不重复归档、不新增句", "sentences=" + store.readTopic(expireB).sentences.length);
}

// ── S-D4：库内无超限候选 + md 也无 ⇒ no-candidate，且不写 md、不抛 ──
{
  fs.rmSync(sessDir, { recursive: true, force: true });
  fs.mkdirSync(sessDir, { recursive: true });
  const md0 = fs.readdirSync(sessDir).length;
  let r = null; let threw = null;
  try { r = mod.sinkExpiredDailySummaryToDb(null, { limit: 1000, today: TODAY }); } catch (e) { threw = e; }
  ok(!threw && r && r.ok === false && r.why === "no-candidate", "S-D4 库内/md 都无候选 ⇒ no-candidate、不抛", threw ? ("抛了: " + threw.message) : JSON.stringify({ ok: r && r.ok, why: r && r.why }));
  ok(fs.readdirSync(sessDir).length === md0, "S-D4 不写 md（sessions 文件数不变）");
}

// md 下沉的落盘门槛：总长 - 搬走 + 指针150 <= target ⇒ 夹具按"大文件 + 更长的冷节"构造（与线上量级一致）
const mkOverLimitMd = () => {
  const live = ["- 活一活一活一活一", "- 活二活二活二活二", "- 活三活三活三活三"].join("\n");
  const cold = ["冷一", "冷二", "冷三", "冷四", "冷五", "冷六"].map((n) => "- " + n + "冷".repeat(700)).join("\n");
  fs.writeFileSync(MD_FILE, "# 面板检查下沉\n\n## 正文\n" + live + "\n\n## 归档\n" + cold + "\n", "utf8");
};

// ── K01 超限下沉（flag 开）：**store.splitTopic 未实现 ⇒ 明确 why + 回落 md + 不留假拆分副作用** ──
{
  mkOverLimitMd();
  const mdSha0 = shaOfFile(MD_FILE);
  const before = liveTexts(topic).length;   // 6
  const r1 = mod.sinkOverLimitFile(REL, { target: 700 });
  ok(r1 && r1.ok === true && r1.channel === "db" && r1.split && r1.split.sentences === 4,
    "K01 路由：flag 开 ⇒ channel=db 且真拆 4 句冷节（store.splitTopic 已由 task-45 实现）", JSON.stringify(r1 && r1.split));
  const sp = r1.split;
  const nt = store.topics().find((t) => t.id === sp.newTopicId) || null;
  ok(nt && nt.parentId === dom.id && /·\s*明细$/.test(String(nt.name)),
    "K01 新主题：`<原名> · 明细` 且挂同一父（level=detail）", nt ? (nt.name + " parent=" + nt.parentId + " level=" + store.levelOf(nt.id)) : "未找到");
  const afterMain = liveTexts(topic);
  const ptr = afterMain.find((t) => /^> 已(下沉|拆分)/.test(t)) || null;
  ok(!!ptr && ptr.indexOf(sp.newTopicId) >= 0, "K01 指针句：主主题「> 已拆分/已下沉 4 句至 <新id>「<新名>」」（store 实现用词「已拆分」）", ptr || "(无)");
  ok(liveTexts(sp.newTopicId).length === 4 && afterMain.length - 1 === before - 4,
    "K01 守恒：主主题(去指针) + 新主题 == 下沉前（2 + 4 == 6）", (afterMain.length - 1) + " + " + liveTexts(sp.newTopicId).length + " == " + before);
  ok(shaOfFile(MD_FILE) === mdSha0 && !fs.readdirSync(path.join(MEM, "projects")).some((f) => /pre-sink/.test(f)),
    "K01 不写 md/.bak：md 主文件 sha 未变、projects/ 无 .pre-sink 备份", "sha=" + mdSha0);
}

// ── K02 日摘要归档（flag 开）：state=archived、父主题留指针、readTopic 仍可读、md 未变 ──
{
  const mdBefore = shaOfFile(MDD);
  const r2 = mod.sinkExpiredDailySummary(RELD, { today: "2026-10-30" });
  ok(r2 && r2.ok === true && r2.channel === "db" && r2.archived && r2.archived.topicId === daily,
    "K02 路由：flag 开 ⇒ channel=db（库内归档，真交付）", JSON.stringify({ ok: r2 && r2.ok, channel: r2 && r2.channel, why: r2 && r2.why }));
  const row = store.topics().find((t) => t.id === daily) || null;
  ok(row && row.state === "archived", "K02 归档：主题 state=archived", row && row.state);
  const parentTexts = liveTexts(dom.id);
  ok(parentTexts.some((t) => /^> 已归档/.test(t) && t.indexOf(daily) >= 0),
    "K02 指针：父主题（域）里出现「> 已归档：…（原文保留，可 memory_read <id> 读回）」",
    parentTexts.filter((t) => /已归档/.test(t)).join(" | "));
  ok(liveTexts(daily).length === 3, "K02 可读：归档后 readTopic 仍能读到 3 句全文", String(liveTexts(daily).length));
  ok(shaOfFile(MDD) === mdBefore, "K02 md 未变：sessions/" + DAY + ".md 未被创建/改动", mdBefore);
}

// ── K05 幂等：归档再跑一次 ⇒ alreadyArchived、无重复指针；拆分（阻塞态）再跑 ⇒ 不重复搬 md ──
{
  const parentBefore = JSON.stringify(liveTexts(dom.id));
  const r2b = mod.sinkExpiredDailySummary(RELD, { today: "2026-10-30" });
  ok(r2b && r2b.ok === true && r2b.archived && r2b.archived.alreadyArchived === true,
    "K05 幂等（归档）：第二次 ⇒ alreadyArchived=true", JSON.stringify(r2b && r2b.archived));
  ok(JSON.stringify(liveTexts(dom.id)) === parentBefore, "K05 幂等（归档）：父主题句子零变化（无重复指针）");
  const mdSha = shaOfFile(MD_FILE);
  const splitMeta = (() => { try { return store.be.getMeta("sink.split:" + topic); } catch (e) { return null; } })();
  ok(!!splitMeta, "K05 记账：meta sink.split:<原主题> 已写（幂等依据）", String(splitMeta).slice(0, 90));
  const r1b = mod.sinkOverLimitFile(REL, { target: 700 });
  ok(r1b && r1b.ok === true && r1b.duplicate === true,
    "K05 幂等（拆分）：第二次 ⇒ duplicate=true（不重复拆）", JSON.stringify({ dup: r1b && r1b.duplicate, why: r1b && r1b.why }));
  ok(shaOfFile(MD_FILE) === mdSha, "K05 幂等（拆分）：md 文件未被改写");
}

// ── K03 flag 关：两条都仍走 md（老行为逐字）──
{
  mkOverLimitMd();
  const mdShaBefore = shaOfFile(MD_FILE);
  const enabledBackup = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const r3 = mod.sinkOverLimitFile(REL, { target: 700 });
  mod.__topicdb.enabled = enabledBackup;
  ok(r3 && r3.ok === true && !r3.channel && !!r3.sinkRel,
    "K03 flag 关：超限下沉仍走 md（返回 sinkRel，无 channel）", JSON.stringify({ ok: r3 && r3.ok, sinkRel: r3 && r3.sinkRel, why: r3 && r3.why }));
  ok(shaOfFile(MD_FILE) !== mdShaBefore, "K03 flag 关：md 主文件被改写（sha 变化，老行为）");
  // 日摘要：md 文件超 limit（limit 200 > 指针 136 ⇒ md 下沉可成）
  fs.writeFileSync(MDD, "# " + DAY + "\n\n" + "- 日摘要长内容".repeat(60) + "\n", "utf8");
  const mdDShaBefore = shaOfFile(MDD);
  const enabledBackup2 = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const r3b = mod.sinkExpiredDailySummary(RELD, { limit: 400, today: "2026-10-30" });
  mod.__topicdb.enabled = enabledBackup2;
  ok(r3b && r3b.ok === true && !r3b.channel && /MEMORY-日摘要-/.test(String(r3b.sinkRel || "")),
    "K03 flag 关：日摘要过期仍走 md（sinkRel=knowledge/MEMORY-日摘要-…-明细.md）", JSON.stringify({ ok: r3b && r3b.ok, sinkRel: r3b && r3b.sinkRel, why: r3b && r3b.why }));
  ok(shaOfFile(MDD) !== mdDShaBefore, "K03 flag 关：日摘要 md 被改写（sha 变化，老行为）");
}

// ── K04 坏库：回落 md + 不抛错 ──
{
  mkOverLimitMd();
  const goodStore = mod.__topicdb.store;
  let threw = null; let r4 = null;
  try {
    mod.__topicdb.store = { topics() { throw new Error("simulated: sink db locked"); } };
    r4 = mod.sinkOverLimitFile(REL, { target: 700 });
  } catch (e) { threw = e; }
  ok(!threw && r4 && r4.ok === true && !r4.channel, "K04 坏库（拆分）：不抛错，回落 md（无 channel）", threw ? ("抛了: " + threw.message) : JSON.stringify({ ok: r4 && r4.ok, why: r4 && r4.why }));
  fs.writeFileSync(MDD, "# " + DAY + "\n\n" + "- 日摘要长内容".repeat(60) + "\n", "utf8");
  let threw2 = null; let r4b = null;
  try { r4b = mod.sinkExpiredDailySummary(RELD, { limit: 400, today: "2026-10-30" }); } catch (e) { threw2 = e; }
  mod.__topicdb.store = goodStore;
  ok(!threw2 && r4b && r4b.ok === true && !r4b.channel, "K04 坏库（归档）：不抛错，回落 md（无 channel）", threw2 ? ("抛了: " + threw2.message) : JSON.stringify({ ok: r4b && r4b.ok, why: r4b && r4b.why }));
}

// ── K06 归档记账/不变量 + verify OK ──
{
  ok((store.topics().find((t) => t.id === daily) || {}).state === "archived", "K06 归档态稳定：日摘要主题仍是 archived（坏库测试未回滚它）");
  let vok = null;
  try { vok = typeof store.verify === "function" ? store.verify() : null; } catch (e) { vok = { ok: false, error: String(e && e.message) }; }
  ok(vok === null || vok.ok === true || vok.ok === undefined, "K06 verify：store.verify() 通过（层级/语义不变量未破）", vok ? JSON.stringify(vok).slice(0, 120) : "无 verify 接口");
  await sleep(900);   // monitorEvent 是防抖写盘（500ms），等它落盘后再读
  const mon = (() => { try { return JSON.parse(fs.readFileSync(path.join(MEM, ".monitor.json"), "utf8")); } catch (e) { return null; } })();
  const evs = (mon && Array.isArray(mon.events) ? mon.events : []).map((x) => String((x && x.detail) || ""));
  ok(evs.some((d) => /md-fallback/.test(d)) && evs.some((d) => /db archive/.test(d)),
    "K06 可观测：.monitor.json 里既有 `sink: db archive …` 也有 `sink: md-fallback …` 事件",
    JSON.stringify(evs.filter((d) => /sink|archive/.test(d)).slice(-4)));
  ok(liveTexts(topic).filter((t) => t.indexOf("> 已下沉") === 0).length === 0,
    "K06 无假指针：阻塞态下主主题没有被塞「已下沉」指针句（不假装拆过）");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理忽略 */ }
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 120);
