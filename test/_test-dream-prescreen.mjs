// _test-dream-prescreen.mjs —— 4.5.13 Part A 门（dream 预筛 + 检查点证据 + P25 护栏 + P0-4 空轮短路）
//
// 跑法：node _test-dream-prescreen.mjs [index.js 路径]
//
// 依据：
//   · docs/方案-4.5.12-dream预筛与记忆面板v2.md §2（A0/A1/A2）+ §7（v3 修订，冲突处以 §7 为准）
//   · docs/audit/dream-prescreen-panel_v2_AUDIT_2026-11-10.md M'-1~M'-11 + V-1~V-10
//   · docs/audit/dream-prescreen-panel_AUDIT_2026-11-10.md F-1~F-12
//
// 覆盖（门编号沿用审计②）：
//   G1 预筛前后所有主题 lastHitAt 逐条相等；A1 源码段不含 markTopicHits / topicDbSearchTopics（F-1 不可逆污染）
//   G3 fixture 含 1,881 字单句 note ⇒ 摘录非空且 ≤400；no-snippet 计数 0（F-2/M-2）
//   G4 双预算：预筛块 ≤4,600 **且** 任务书总 ≤10,500；flag 关 sha16 == 基线；不出现 Expression tree is too large
//   G2 行为门：对真检查点 memory_dream_patch{append} ⇒ 整批 P25_SESSION_TOPIC 且句数不变；
//      split_topic 源为检查点 ⇒ 拒；review_topic{merge,into:检查点} ⇒ 拒；rename 检查点 ⇒ SYSTEM_TOPIC_READONLY
//   逻辑门：关联 ≤3 / 排除笔记·检查点·索引·归档 / 去重 / no-hit 与 no-snippet 分列 / 检查点证据只含真检查点
//   P0-2：listOverLimitTopicsFromDb 有 excludeNotes；库模式 overTopics 不含笔记（渲染/记账两处）
//   P0-4：空轮 fixture ⇒ spawnIntegrate 返回 skipped 且 buildDreamPrompt **未调用**、账本/转播齐全；rows 复用
//   静态：flag 落点四处（DEFAULT_CFG/SETTINGS_SCHEMA/normalizeCfg/WRITABLE）
//
// 隔离纪律：全部场景在 os.tmpdir() 下造独立 DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB（复用 test/_accept-p0-lib.mjs），
//   **不用 fake store**（审计：fake store 测不到墓碑/合并视图/readTopic 语义）；不碰真实 ~/.dsh/memory。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  mkHome, useHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, seedD8, todayStr, mkAgent,
  makeReporter, finish, readMonitor, readIntegrate, sleep, TARGET,
} from "./_accept-p0-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const SRC = fs.readFileSync(PLUGIN, "utf8");

const R = makeReporter("4.5.13 Part A：dream 预筛 + 检查点证据 + P25 护栏 + P0-4 空轮短路");
const CFG_ON = { memoryTopicDbEnabled: true };

// ── 基线（M'-3 口径）：**同提交、P0-0/P0-2/P0-4 落地后、dreamPrescreen=false** 的 golden。
//    注意：它只防未来回归，不证明「flag 关 = 旧字节」（P0-2 会改任务书：笔记超限行消失）。
//    sha16 = 对 promptText 做**时间戳归一化**后取 sha256 前 16 位（note 块含「更新 YYYY-MM-DD HH:MM」，
//    不归一化会每次跑都不同；归一化只抹掉时间，不抹任何结构/文本）。改 fixture 时需重新基线。
const GOLDEN_SHA16 = "1882fb3eb3f6e7c8";   // [I'-7] D8 只读族退出候选池后重定（候选行少 D8 域/线/日期主题）

function sha16(s) { return createHash("sha256").update(String(s)).digest("hex").slice(0, 16); }
function normPrompt(s) {
  return String(s == null ? "" : s)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/g, "<TS>");
}
const segOf = (startAnchor, endAnchor) => {
  const a = SRC.indexOf(startAnchor);
  if (a < 0) return "";
  const b = endAnchor ? SRC.indexOf(endAnchor, a + startAnchor.length) : -1;
  return SRC.slice(a, b > a ? b : a + 12000);
};
// 静态断言要断言**代码**，不是注释：剥掉行注释（A1 纪律注释里会逐字写「不调 topicDbSearchTopics」等，
//   不剥会把「说明自己没调」误判成「调了」——假红）。
const stripComments = (s) => String(s || "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

// ════════════════════════════════════════════════════════════════════════
// 场景 1：主 fixture（真临时库；flag 开）
// ════════════════════════════════════════════════════════════════════════
const H = mkHome("prescreen");
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

// ── 造数 ──
const idOf = (r) => (r && r.id) || null;
const created = {};
function mkTopic(name, triggers, sentences) {
  const r = store.createTopic({ name: name, triggers: triggers || [], actor: "runtime", confirm: true });
  for (const s of (sentences || [])) store.appendSentence({ topic: r.id, text: s, actor: "runtime" });
  return idOf(r);
}
created.A = mkTopic("dream 预筛插件设计", ["预筛", "关联主题", "dream"], ["预筛块预算 4600 字；关联主题只作线索。", "第二句：禁止仅凭预筛关联做 merge。"]);
created.B = mkTopic("记忆面板六分区", ["记忆面板", "六分区", "面板"], ["面板六分区：概览/主题库/检查点/笔记/整合与成本/工具。"]);
created.C = mkTopic("P2.5 检查点恒一句", ["检查点", "恒 1 句", "P2.5"], ["检查点每会话恒 1 句，由插件覆盖写入。"]);
try { created.IDX = mkTopic("记忆索引", ["索引"], ["索引类主题占位。"]); } catch (e) { created.IDX = null; }
try {
  created.ARCH = mkTopic("归档测试主题", ["归档"], ["这条会被归档，不应出现在预筛关联里。"]);
  store.setState(created.ARCH, "archived", { actor: "runtime", reason: "selftest" });
} catch (e) { created.ARCH = null; }
const seeded = seedD8(mod);
R.ok(!!seeded, "0c 前置：D8 域 + 「会话检查点」线已建");

// 真检查点（P2.5 会话主题：`<wsKey>/<sid8>` + 父线）——A2 取数 / G2 护栏共用
const CWD_A = "E:\\工具\\测试项目A";
const cp1 = mod.__topicdbIntentRoute("ab12cd34-1111", "11112222", "## 关键结论\n- 预筛块预算 4600 字\n- 关联主题是线索不是结论\n## 错误与修复\n- markHit 不可逆，禁止调检索函数", todayStr() + ".md", "session-11112222", CWD_A);
const cp2 = mod.__topicdbIntentRoute("ef56ab78-2222", "33334444", "## 关键结论\n- 检查点证据只读，禁止改写", todayStr() + ".md", "session-33334444", CWD_A);
R.ok(cp1 && cp1.p25 === true && cp2 && cp2.p25 === true, "0d 前置：两个真检查点已建（P2.5 会话主题）", JSON.stringify([cp1 && cp1.topicName, cp2 && cp2.topicName]));
const cpIds = [cp1 && cp1.topicId, cp2 && cp2.topicId].filter(Boolean);

// 笔记：3 个填充（no-hit）+ noteC（no-hit）+ noteB（1,881 字单句）+ noteA（富内容，最新）
const NOTE = (sid) => "笔记·selftest-ws/" + sid;
function mkNote(sid, sentences) {
  const id = mkTopic(NOTE(sid), [], sentences);
  return id;
}
const nf1 = mkNote("dddd4444", ["填充笔记一：今天天气不错，出去散步。"]); await sleep(4);
const nf2 = mkNote("eeee5555", ["填充笔记二：午饭吃了面条。"]); await sleep(4);
const nf3 = mkNote("ffff6666", ["填充笔记三：明天要早起。"]); await sleep(4);
const nC = mkNote("cccc3333", ["今天天气不错，出去散步。"]); await sleep(4);
const LONG_SENT = "预筛：" + "填充内容".repeat(469) + "结束";   // 3 + 1,876 + 2 = 1,881 字单句
const nB = mkNote("bbbb2222", [LONG_SENT]); await sleep(4);
const nA = mkNote("aaaa1111", [
  "本轮在做 dream 预筛：把未提炼笔记关联到 dream 预筛插件设计主题，关联主题只作线索。",
  "检查点证据是只读材料，P2.5 恒 1 句不能被 dream 改写。",
]);
const noteIds = [nf1, nf2, nf3, nC, nB, nA].filter(Boolean);
R.ok(noteIds.length === 6, "0e 前置：6 个未提炼笔记主题", "n=" + noteIds.length);
R.ok(String((store.readTopic(nB) || {}).sentences?.[0]?.text || "").length === 1881, "0f 前置：noteB 单句 = 1,881 字（G3 fixture）");

// ── G1 前置：快照 lastHitAt（先给一个主题 markHit，保证断言非空转）──
try { store.markHit(created.A); } catch (e) { /* 忽略 */ }
const hitSnap = () => store.topics().map((t) => String(t.id) + "=" + String(t.lastHitAt == null ? "" : t.lastHitAt)).join("|");
const hitBefore = hitSnap();
R.ok(store.topics().some((t) => t.lastHitAt != null), "G1a 前置：lastHitAt 快照非空（断言非空转）");

// ════════════════════════════════════════════════════════════════════════
// A1 / A2：buildPrompt（flag 开）
// ════════════════════════════════════════════════════════════════════════
const dp = await hooks.buildPrompt({});
const pt = (dp && dp.promptText) || "";
const hitAfter = hitSnap();
R.ok(!!pt && dp.libMode === true, "1 前置：库模式任务书已构建", "len=" + pt.length);

// G1：lastHitAt 逐条相等（窗口严格限定 buildPrompt 前后）
R.ok(hitBefore === hitAfter, "G1 lastHitAt 前后逐条相等（预筛零 markHit 副作用）", "before!=after=" + (hitBefore !== hitAfter));
R.ok(store.topics().filter((t) => t.lastHitAt != null).length >= 1, "G1b lastHitAt 字段存在且非空（断言非空转）", "n=" + store.topics().filter((t) => t.lastHitAt != null).length);
{
  const segRaw = segOf("// [4.5.13 Part A1]", "// [task-54] 库模式任务书");
  const seg = stripComments(segRaw);
  R.ok(seg.length > 500, "G1c A1 源码段已定位", "len=" + seg.length);
  R.ok(!/markTopicHits/.test(seg), "G1d A1 源码段不含 markTopicHits（负例：旧字节必红）");
  R.ok(!/topicDbSearchTopics/.test(seg), "G1e A1 源码段不含 topicDbSearchTopics（F-1/F-3）");
  R.ok(!/searchSentencesByTokens/.test(seg), "G1f A1 源码段不含 searchSentencesByTokens（F-3 1255 token 崩溃）");
}

// 块存在 + 文案纪律
R.ok(pt.includes("## Note → 关联主题（插件预筛 · 线索不是结论）"), "A1-1 任务书含预筛块头");
R.ok(pt.includes("不得仅凭预筛关联做 merge"), "A1-2 含「不得仅凭预筛关联做 merge」纪律");
R.ok(pt.includes("## 检查点证据（只读 · 插件预筛）"), "A2-1 任务书含检查点证据块");
R.ok(/只读/.test(pt) && /禁止改写检查点主题/.test(pt), "A2-2 标注只读 + 禁止改写检查点");

// 位置：笔记块之后、lessons 之前（候选在 scope 内、笔记块之前 —— 审计 A1-7 已证该顺序不可满足，故按"笔记块之后"落）
{
  const iNote = pt.indexOf("## 会话笔记提炼");
  const iPs = pt.indexOf("## Note → 关联主题");
  const iCk = pt.indexOf("## 检查点证据");
  const iLess = pt.indexOf("## Pending Lessons");
  R.ok(iNote >= 0 && iPs > iNote && iCk > iPs && (iLess < 0 || iCk < iLess), "A1/A2-3 块顺序：笔记提炼 → 预筛 → 检查点证据 → lessons", JSON.stringify({ iNote, iPs, iCk, iLess }));
}

// G4 双预算
const psChars = (dp.prescreen && dp.prescreen.chars) || 0;
const ckChars = (dp.checkpointEvidence && dp.checkpointEvidence.chars) || 0;
R.ok(psChars > 0 && psChars <= 4600, "G4a 预筛块 ≤4,600 字", "chars=" + psChars);
R.ok(ckChars > 0 && ckChars <= 1200, "G4b 检查点证据块 ≤1,200 字", "chars=" + ckChars);
R.ok(pt.length <= 10500, "G4c 任务书总 ≤10,500 字", "len=" + pt.length);
R.ok(!/Expression tree is too large/.test(pt), "G4d 不出现 Expression tree is too large");

// A1 逻辑：note 数 / 关联数 / 排除 / 去重 / fallback 分列
const ps = dp.prescreen || { items: [] };
const items = Array.isArray(ps.items) ? ps.items : [];
R.ok(ps.notes === 5, "A1-4 note ≤5（6 个未提炼 ⇒ 渲染 5）", "notes=" + ps.notes);
R.ok(ps.dropped === 1, "A1-5 被预算/上限截断的 note 数 = 1（S'-4 dropped）", "dropped=" + ps.dropped);
R.ok(items.every((x) => (x.links || []).length <= 3), "A1-6 每 note 关联 ≤3", JSON.stringify(items.map((x) => (x.links || []).length)));
{
  const isCp = (nm) => { try { return typeof mod.__p25SessionTopicWriteGuard === "function" && /^[^\s/\\]{1,200}\/[0-9a-f]{8}/.test(String(nm)); } catch (e) { return false; } };
  const allLinkIds = items.flatMap((x) => (x.links || []).map((l) => l.id));
  const badNote = allLinkIds.filter((id) => noteIds.includes(id));
  const badCp = allLinkIds.filter((id) => cpIds.includes(id));
  const badArch = allLinkIds.filter((id) => created.ARCH && id === created.ARCH);
  const badIdx = allLinkIds.filter((id) => created.IDX && id === created.IDX);
  R.ok(badNote.length === 0 && badCp.length === 0 && badArch.length === 0 && badIdx.length === 0,
    "A1-7 关联排除笔记/检查点/归档/索引", JSON.stringify({ badNote, badCp, badArch, badIdx }));
  const dup = items.some((x) => { const ids = (x.links || []).map((l) => l.id); return new Set(ids).size !== ids.length; });
  R.ok(!dup, "A1-8 同一 note 内关联去重", "");
  const withLinks = items.filter((x) => (x.links || []).length > 0);
  R.ok(withLinks.length >= 1, "A1-9 至少一个 note 命中关联（词典/df 打分有效）", "hitNotes=" + withLinks.length);
  R.ok(items.every((x) => (x.links || []).every((l) => (l.tokens || []).length <= 3)), "A1-10 命中 token ≤3", "");
  R.ok(items.every((x) => (x.links || []).every((l) => String(l.name || "").length >= 1)), "A1-11 关联带 id/名字", "");
}
// G3：1,881 字单句摘录非空且 ≤400；no-snippet = 0
{
  const itB = items.find((x) => x.noteId === nB);
  R.ok(!!itB && itB.excerptLen > 0 && itB.excerptLen <= 400, "G3a 1,881 字单句 ⇒ 摘录非空且 ≤400", itB ? "excerptLen=" + itB.excerptLen : "no item");
  R.ok(ps.noSnippet === 0, "G3b no-snippet 计数 = 0（M-2：先截断再累计）", "noSnippet=" + ps.noSnippet);
  const itC = items.find((x) => x.noteId === nC);
  R.ok(!!itC && itC.fallback === "no-hit", "A1-12 无命中 ⇒ fallback=no-hit（与 no-snippet 分列）", itC ? String(itC.fallback) : "no item");
  R.ok(ps.noHit >= 1 && ps.fallback === ps.noHit + ps.noSnippet, "A1-13 fallback 计数 = no-hit + no-snippet", JSON.stringify({ fallback: ps.fallback, noHit: ps.noHit, noSnippet: ps.noSnippet }));
}

// A2 逻辑：只含真检查点 / ≤4 / 每节摘录 / 缺节降级
{
  const ce = dp.checkpointEvidence || { items: 0, ids: [] };
  R.ok(ce.items === 2 && ce.items <= 4, "A2-4 检查点证据取真检查点 2 个（≤4）", "items=" + ce.items);
  const rowsNow = store.topics();
  const byId = new Map(rowsNow.map((t) => [String(t.id), t]));
  const bad = (ce.ids || []).filter((id) => {
    const t = byId.get(String(id));
    if (!t) return true;
    if (/^笔记·/.test(String(t.name))) return true;
    return !/^[^\s/\\]{1,200}\/[0-9a-f]{8}/.test(String(t.name));
  });
  R.ok(bad.length === 0 && (ce.ids || []).length === 2, "A2-5 证据块只含真检查点（无笔记/普通主题）", JSON.stringify(bad));
  R.ok(/压缩 [0-9a-f]{6,}/.test(pt) && /sid [0-9a-f]{8}/.test(pt) && /cwd /.test(pt), "A2-6 首行含 压缩/sid/cwd");
  R.ok(/关键结论：/.test(pt) && /错误与修复：/.test(pt), "A2-7 含「关键结论」「错误与修复」两节");
  R.ok(pt.includes("（本检查点无此节）"), "A2-8 缺节降级文案（CP2 无错误与修复节）");
}

// 观测事件（monitor 落盘有 500ms 防抖）
await sleep(800);
{
  const md = readMonitor(H) || {};
  const ev = (md.events || []).map((x) => String((x && x.detail) || "")).filter((s) => /^prescreen notes=/.test(s));
  const last = ev.length ? ev[ev.length - 1] : "";
  R.ok(ev.length >= 1, "OBS-1 monitor 有 prescreen 事件", last.slice(0, 160));
  R.ok(/notes=\d+ related=\d+ fallback=\d+ chars=\d+ ms=\d+ dropped=\d+/.test(last), "OBS-2 事件字段齐全（notes/related/fallback/chars/ms/dropped）", last.slice(0, 160));
}

// ── G4：flag 关 ⇒ 逐字回基线 ──
let offPrompt = "";
if (typeof hooks.setCfg === "function") {
  hooks.setCfg({ dreamPrescreen: false });
  const dpOff = await hooks.buildPrompt({});
  offPrompt = (dpOff && dpOff.promptText) || "";
  R.ok(!offPrompt.includes("## Note → 关联主题") && !offPrompt.includes("## 检查点证据"), "G4e flag 关 ⇒ 两个新块都不插", "len=" + offPrompt.length);
  R.ok(offPrompt.length <= 10500, "G4f flag 关任务书仍 ≤10,500", "len=" + offPrompt.length);
  const sha = sha16(normPrompt(offPrompt));
  if (GOLDEN_SHA16 === "TBD") {
    R.warn("G4g flag 关 sha16 == 基线", "待基线：BASELINE_SHA16=" + sha);
  } else {
    R.ok(sha === GOLDEN_SHA16, "G4g flag 关 sha16 == 基线（M'-3 golden）", "sha=" + sha + " golden=" + GOLDEN_SHA16);
  }
  hooks.setCfg({ dreamPrescreen: true });
  // 恢复后块回来（热更新语义）
  const dpOn2 = await hooks.buildPrompt({});
  R.ok(((dpOn2 && dpOn2.promptText) || "").includes("## Note → 关联主题"), "G4h flag 热更新：重新打开 ⇒ 块回来", "");
} else {
  R.ok(false, "G4e 前置：__dreamHooks.setCfg 可用（flag 门必需）");
}

// ════════════════════════════════════════════════════════════════════════
// P0-2：overTopics 排除笔记（渲染 + 记账两处）
// ════════════════════════════════════════════════════════════════════════
{
  R.ok(/excludeNotes/.test(segOf("function listOverLimitTopicsFromDb", "function listReviewQueueFromDb")), "P0-2a listOverLimitTopicsFromDb 有 excludeNotes 选项");
  R.ok(/excludeNotes:\s*true/.test(segOf("function buildDreamPromptLibrary", "const lessons =")), "P0-2b 任务书 overTopics 传 excludeNotes:true");
  R.ok(/excludeNotes:\s*true/.test(segOf("function buildOverLimitHealthLibrary", "function renderOverLimitTopicsForPrompt")), "P0-2c 健康体检/overLimitStuck 传 excludeNotes:true");
  // 行为：造一个 >9,000 字的笔记主题（超限但 dream 修不了）⇒ 两处都不得把它当超限
  let bigNote = null;
  try {
    bigNote = mkTopic(NOTE("9999aaaa"), [], ["超限笔记：" + "巨".repeat(9500)]);
  } catch (e) { bigNote = null; }
  if (bigNote) {
    const dpBig = await hooks.buildPrompt({});
    const overIds = (dpBig.overTopics || []).map((x) => String(x.topicId));
    R.ok(!overIds.includes(String(bigNote)), "P0-2d 任务书 overTopics 不含超限笔记（源头一处决定）", JSON.stringify(overIds));
    const hl = hooks.buildOverLimitHealthLib ? hooks.buildOverLimitHealthLib({}) : null;
    const stuckKeys = hl && hl.stuck ? Object.keys(hl.stuck) : [];
    R.ok(!stuckKeys.includes(String(bigNote)), "P0-2e overLimitStuck 记账不含超限笔记（S'-1 死胡同修掉）", JSON.stringify(stuckKeys));
  } else {
    R.skip("P0-2d/e 超限笔记行为", "造数失败（governance 拒建）");
  }
}

// ════════════════════════════════════════════════════════════════════════
// G2：P25 护栏（dream_patch / split / review merge / rename）
// ════════════════════════════════════════════════════════════════════════
{
  const cpName = cp1.topicName;
  const cpTopicId = cp1.topicId;
  const cntCp = () => ((store.readTopic(cpTopicId) || {}).sentences || []).length;
  R.ok(cntCp() === 1, "G2-0 前置：检查点恒 1 句", "n=" + cntCp());

  // ① dream_patch append 到真检查点 ⇒ 整批 P25_SESSION_TOPIC，句数不变
  const r1 = hooks.apply([{ topic: cpName, action: "append", content: "违规追加句" }], { dream: true });
  R.ok(r1 && r1.ok === false && r1.error === "P25_SESSION_TOPIC", "G2-1 dream_patch append 检查点 ⇒ P25_SESSION_TOPIC（整批拒）", JSON.stringify(r1).slice(0, 180));
  R.ok(cntCp() === 1, "G2-2 被拒后检查点句数不变", "n=" + cntCp());

  // ② 整批不半批落盘：同批里普通主题 append + 检查点 append ⇒ 普通主题也不得写
  const normalId = created.A;
  const nBefore = ((store.readTopic(normalId) || {}).sentences || []).length;
  const r2 = hooks.apply([
    { topic: normalId, action: "append", content: "同批普通主题句-不应落盘" },
    { topic: cpName, action: "append", content: "同批检查点句" },
  ], { dream: true });
  const nAfter = ((store.readTopic(normalId) || {}).sentences || []).length;
  R.ok(r2 && r2.error === "P25_SESSION_TOPIC" && nAfter === nBefore, "G2-3 整批拒绝：同批普通主题也不落盘（绝不半批）", "n=" + nBefore + "→" + nAfter);

  // ③ split_topic 源为检查点 ⇒ 拒
  const splitTool = (captured.tools || []).find((t) => t && t.name === "memory_split_topic");
  R.ok(!!(splitTool && typeof splitTool.execute === "function"), "G2-4 前置：memory_split_topic 已注册");
  const DREAM_SID = "prescreen-dream-sid-0001";
  try { hooks.guardRegister(DREAM_SID, "dream", new AbortController(), 120000, 120000); } catch (e) { /* 钩子失败后续会 DREAM_ONLY */ }
  const execDream = { name: "memory_split_topic", agent: { session: { id: DREAM_SID } } };
  if (splitTool) {
    const cpBody = String(((store.readTopic(cpTopicId) || {}).sentences || [])[0]?.text || "");
    const rs = JSON.parse(await splitTool.execute({ topic: cpName, name: "检查点拆分目标", sentence_texts: [cpBody], reason: "selftest" }, execDream));
    R.ok(rs && rs.ok === false && rs.code === "P25_SESSION_TOPIC", "G2-5 split_topic 源=检查点 ⇒ P25_SESSION_TOPIC", JSON.stringify(rs).slice(0, 180));
    R.ok(cntCp() === 1, "G2-6 split 被拒后检查点句数不变", "n=" + cntCp());
  }

  // ④ review_topic{merge, into:检查点} ⇒ 拒（CRA② V-8 实锤漏洞）
  const revTool = (captured.tools || []).find((t) => t && t.name === "memory_review_topic");
  R.ok(!!(revTool && typeof revTool.execute === "function"), "G2-7 前置：memory_review_topic 已注册");
  if (revTool) {
    let srcId = null;
    try {
      const st = store.createTopic({ name: "待审重复源主题", triggers: [], actor: "runtime", confirm: true });
      srcId = st.id;
      store.appendSentence({ topic: srcId, text: "待审独有句：合并会污染检查点。", actor: "runtime" });
      store.setState(srcId, "needs_review", { actor: "runtime", reason: "selftest" });
    } catch (e) { srcId = null; }
    if (srcId) {
      const rv = JSON.parse(await revTool.execute({ topic: srcId, verdict: "merge", into: cpName, note: "selftest" }, { name: "memory_review_topic", agent: { session: { id: DREAM_SID } } }));
      R.ok(rv && rv.ok === false && rv.code === "P25_SESSION_TOPIC", "G2-8 review_topic merge into=检查点 ⇒ P25_SESSION_TOPIC", JSON.stringify(rv).slice(0, 180));
      R.ok(cntCp() === 1, "G2-9 merge 被拒后检查点句数不变", "n=" + cntCp());
      R.ok(String((store.readTopic(srcId) || {}).state || "") === "needs_review", "G2-10 merge 被拒后源主题未归档（整批不落盘）", String((store.readTopic(srcId) || {}).state));
    } else {
      R.skip("G2-8/9/10 review merge into 检查点", "造数失败");
    }
  }

  // ⑤ rename_topic 检查点 ⇒ SYSTEM_TOPIC_READONLY（既有护栏回归）
  const renTool = (captured.tools || []).find((t) => t && t.name === "memory_rename_topic");
  if (renTool) {
    const rr = JSON.parse(await renTool.execute({ topic: cpName, new_name: "改个名试试", reason: "selftest" }, execDream));
    R.ok(rr && rr.ok === false && rr.code === "SYSTEM_TOPIC_READONLY", "G2-11 rename_topic 检查点 ⇒ SYSTEM_TOPIC_READONLY", JSON.stringify(rr).slice(0, 160));
  } else {
    R.skip("G2-11 rename 检查点", "工具未注册");
  }

  // ⑥ 回归：普通主题 append 仍成功（护栏不误伤）
  const rOk = hooks.apply([{ topic: created.B, action: "append", content: "普通主题正常追加句-selftest" }], { dream: true });
  R.ok(rOk && rOk.ok === true, "G2-12 普通主题 append 仍成功（护栏零误伤）", JSON.stringify(rOk).slice(0, 160));
}

// ════════════════════════════════════════════════════════════════════════
// 静态接线：flag 落点 / P0-4 / 源码形状
// ════════════════════════════════════════════════════════════════════════
{
  R.ok(/dreamPrescreen:\s*true/.test(segOf("const DEFAULT_CFG = {", "const INTEGRATE_STATE_FILE")), "S-1 DEFAULT_CFG.dreamPrescreen = true");
  R.ok(/dreamPrescreen:\s*z\.boolean\(\)/.test(segOf("const SETTINGS_SCHEMA = z.object({", "});")), "S-2 SETTINGS_SCHEMA 含 dreamPrescreen 布尔");
  R.ok(/cfg\.dreamPrescreen !== "boolean"/.test(segOf("function normalizeCfg", "// ═══════════ v2.3.4")), "S-3 normalizeCfg 布尔归一 dreamPrescreen");
  R.ok(/"dreamPrescreen"\]/.test(segOf("const WRITABLE = new Set(", "const clean = {}")), "S-4 WRITABLE 含 dreamPrescreen（可写 + 热更新）");
  // [I'-3/I'-4/I'-6] 收敛与预算语义的静态落点（防被回退）
  R.ok(/DREAM_PRESCREEN_MAX_HIT_TOPICS = 100/.test(SRC) && /DREAM_PRESCREEN_TOKEN_USE = 48/.test(SRC), "S-4b I'-3 收敛常量（命中上限 100 / token 48）");
  R.ok(/df > dfCap\) continue/.test(SRC) && /DREAM_PRESCREEN_MIN_VIABLE/.test(SRC), "S-4c I'-3 df 上限丢弃 + I'-4 最小可行块常量");
  R.ok(/const sep = parts\.length \? 1 : 0/.test(SRC), "S-4d I'-6 摘录 join 分隔符计入累计");

  const segP04 = segOf("// ═══ [4.5.13 P0-4][CRA② M'-2] 空轮统一收尾", "const startedAt = Date.now();");
  R.ok(segP04.length > 300, "S-5 P0-4 段已定位", "len=" + segP04.length);
  R.ok(/if \(TOPICDB\.enabled && TOPICDB\.ready && TOPICDB\.store\)/.test(segP04), "S-6 空轮短路仅库模式（md 模式不短路）");
  // [I'-2] 预信号必须按**本档上限**（topicDbLevelMap 一次取档 + main/detail/index 三档），
  //   旧算式 chars>9000 在真库恒真（136 个 detail/index 主题）⇒ 短路永不触发（CRA③ N-1）。
  R.ok(/topicDbLevelMap/.test(segP04), "S-7a 预信号用 topicDbLevelMap 一次取档（O(主题)）");
  R.ok(/INDEX_TOPIC_CHAR_LIMIT/.test(segP04) && /DETAIL_TOPIC_CHAR_LIMIT/.test(segP04) && /PROJECT_CHAR_HARD/.test(segP04), "S-7b 三档上限齐全（main 9000 / detail 40000 / index 200000）");
  R.ok(!/_preRows\.some\(\(t\) => Number\(t && t\.chars\) > PROJECT_CHAR_HARD\)/.test(segP04), "S-7c 旧的一刀切 chars>9000 算式已移除");
  R.ok(/档位判定失败/.test(segP04) && /_overPossible = true/.test(segP04), "S-7d 取档失败按「可能有活」保守分支");
  R.ok(!/listOverLimitTopicsFromDb/.test(stripComments(segP04)), "S-8 预信号不调 listOverLimitTopicsFromDb（实测 1.33s）");
  R.ok(/rows:\s*_preRows/.test(segP04) && /noteStats:\s*_preNoteStats/.test(segP04), "S-9 _allRows / noteStats 传给 buildDreamPrompt 复用");
  R.ok(/_dreamEmptyRound\(/.test(segP04) && /return _dreamEmptyRound\(/.test(segP04), "S-10 短路复用同一空轮收尾（不另写 early-return）");
  R.ok(/lastIntegrateAt = Date\.now\(\)/.test(segP04) && /delete stE\.lastFailAt/.test(segP04) && /DREAM_PATCH\(\{ status: "skipped"/.test(segP04) && /DREAM_LISTENER = null/.test(segP04) && /return "skipped"/.test(segP04), "S-11 空轮收尾副作用齐全（账本/转播/监听/返回）");
}

// ════════════════════════════════════════════════════════════════════════
// P0-4：rows 复用（传 rows ⇒ buildDreamPromptLibrary 不自取 topics()）
// ════════════════════════════════════════════════════════════════════════
{
  const preRows = store.topics();
  const b0 = Number(hooks.libTopicsSelfFetch) || 0;
  await hooks.buildPrompt({ rows: preRows });
  const b1 = Number(hooks.libTopicsSelfFetch) || 0;
  R.ok(b1 === b0, "P0-4a 传 rows ⇒ 任务书构建不自取 topics()（复用）", "selfFetch " + b0 + "→" + b1);
  await hooks.buildPrompt({});
  const b2 = Number(hooks.libTopicsSelfFetch) || 0;
  R.ok(b2 === b1 + 1, "P0-4b 不传 rows ⇒ 恰好自取 1 次", "selfFetch " + b1 + "→" + b2);
}

// ════════════════════════════════════════════════════════════════════════
// 场景 2：空轮 fixture（独立临时库；P0-4 短路行为）
// ════════════════════════════════════════════════════════════════════════
{
  const H2 = mkHome("prescreen-empty");
  useHome(H2);
  const mod2 = await freshPlugin();
  const fx2 = makeCtx();
  applyPlugin(mod2, CFG_ON, fx2.ctx);
  const ready2 = await waitTopicDb(mod2);
  R.ok(ready2, "P0-4c 前置：空库就绪", ready2 ? "ready" : "not-ready");
  if (ready2) {
    const store2 = mod2.__topicdb.store;
    R.ok((store2.topics() || []).length === 0, "P0-4d 前置：空库 0 主题", "n=" + (store2.topics() || []).length);
    // 计 store.topics() 调用次数（预信号应恰好 1 次）
    let topicsCalls = 0;
    const origTopics = store2.topics.bind(store2);
    store2.topics = function (...a) { topicsCalls += 1; return origTopics(...a); };
    const cnt0 = Number(mod2.__dreamHooks.promptBuildCount) || 0;
    const { agent } = mkAgent("prescreen-empty-main-0001");
    const r = await mod2.__dreamHooks.spawnIntegrate(agent, "selftest");
    const cnt1 = Number(mod2.__dreamHooks.promptBuildCount) || 0;
    R.ok(r === "skipped", "P0-4e 空轮 ⇒ spawnIntegrate 返回 skipped", String(r));
    R.ok(cnt1 === cnt0, "P0-4f 空轮 ⇒ buildDreamPrompt **未调用**（短路生效）", "promptBuildCount " + cnt0 + "→" + cnt1);
    R.ok(topicsCalls === 1, "P0-4g 预信号 topics() 恰好 1 次（不调 listOverLimitTopicsFromDb）", "calls=" + topicsCalls);
    const st = readIntegrate(H2) || {};
    R.ok(Number(st.lastIntegrateAt) > 0, "P0-4h 空轮写 lastIntegrateAt（账本语义保留）", String(st.lastIntegrateAt));
    R.ok(st.lastFailAt == null, "P0-4i 空轮清 lastFailAt（防 2h 死循环重试）", String(st.lastFailAt));
    R.ok(st.progress && st.progress.status === "skipped", "P0-4j 空轮转播 DREAM_PATCH status=skipped", JSON.stringify(st.progress || {}).slice(0, 120));
  }
}

// ════════════════════════════════════════════════════════════════════════
// 场景 2b：[I'-2] P0-4 按本档上限的短路（detail 档 12,000 字未超 40,000 ⇒ 必须短路）
//   审计③ N-1 实测：旧算式 chars>9000 在真库恒真（136 个 detail/index 主题）⇒ 短路永不触发。
// ════════════════════════════════════════════════════════════════════════
{
  const H2b = mkHome("prescreen-tier");
  useHome(H2b);
  const mod2b = await freshPlugin();
  const fx2b = makeCtx();
  applyPlugin(mod2b, CFG_ON, fx2b.ctx);
  const ready2b = await waitTopicDb(mod2b);
  R.ok(ready2b, "I'-2a 前置：detail 档 fixture 库就绪", ready2b ? "ready" : "not-ready");
  if (ready2b) {
    const store2b = mod2b.__topicdb.store;
    // 造 detail 档 12,000 字主题（未超 detail 上限 40,000；旧算式 12,000>9,000 ⇒ 不短路）
    const big = store2b.seedTopic({ name: "detail档大主题", triggers: [], src: "selftest", actor: "plugin" });
    store2b.appendSentence({ topic: big.id, text: "详".repeat(12000), actor: "runtime" });
    try { store2b.setLevel(big.id, "detail", { actor: "runtime" }); } catch (eL) { /* 档位设置失败则本用例降级 */ }
    let lv = "";
    try { lv = String(store2b.levelOf(big.id) || ""); } catch (eL2) { lv = ""; }
    R.ok(lv === "detail", "I'-2b 前置：主题档位 = detail", "level=" + lv);
    const cnt0 = Number(mod2b.__dreamHooks.promptBuildCount) || 0;
    const { agent } = mkAgent("prescreen-tier-main-0001");
    const r = await mod2b.__dreamHooks.spawnIntegrate(agent, "selftest");
    const cnt1 = Number(mod2b.__dreamHooks.promptBuildCount) || 0;
    R.ok(r === "skipped", "I'-2c detail 12,000 字（未超 40,000）⇒ 空轮 skipped", String(r));
    R.ok(cnt1 === cnt0, "I'-2d 短路真生效：buildDreamPrompt **未调用**（旧算式会调 1 次）", "promptBuildCount " + cnt0 + "→" + cnt1);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 场景 3：[I'-3] M'-6 质量门 + [I'-6] 摘录 400 严格化 + [S'-3] 预算截断
// ════════════════════════════════════════════════════════════════════════
{
  const H3 = mkHome("prescreen-quality");
  useHome(H3);
  const mod3 = await freshPlugin();
  const fx3 = makeCtx();
  applyPlugin(mod3, CFG_ON, fx3.ctx);
  const ready3 = await waitTopicDb(mod3);
  R.ok(ready3, "I'-3a 前置：质量 fixture 库就绪", ready3 ? "ready" : "not-ready");
  if (ready3) {
    const store3 = mod3.__topicdb.store;
    const hooks3 = mod3.__dreamHooks;
    // ① 同工作区线 fixture：note 属 E-工具-dsh远程访问；正确归属 = 「dsh远程访问（项目线）」
    const wsLine = store3.seedTopic({ name: "dsh远程访问（项目线）", triggers: ["远程访问", "frp", "隧道"], src: "selftest", actor: "plugin" });
    store3.appendSentence({ topic: wsLine.id, text: "dsh远程访问项目：frp stcp 隧道与 wss 桥接配置。", actor: "runtime" });
    for (let i = 0; i < 6; i++) {
      const d = store3.seedTopic({ name: "远程访问周报 第" + (i + 1) + "期", triggers: ["远程访问", "周报"], src: "selftest", actor: "plugin" });
      store3.appendSentence({ topic: d.id, text: "远程访问周报：frp 隧道状态与 wss 桥接巡检记录 " + (i + 1) + "。", actor: "runtime" });
    }
    const noteWs = store3.seedTopic({ name: "笔记·E-工具-dsh远程访问/ccc872ea", triggers: [], src: "selftest", actor: "plugin" });
    store3.appendSentence({ topic: noteWs.id, text: "远程访问隧道 frp stcp 与 wss 桥接配置，dsh远程访问项目本轮完成。", actor: "runtime" });
    // ② 摘录严格 ≤400：两句各 200 字（join 分隔符也计入累计 ⇒ 恰 400）
    const noteEx = store3.seedTopic({ name: "笔记·E-工具-摘录/aaaabbbb", triggers: [], src: "selftest", actor: "plugin" });
    store3.appendSentence({ topic: noteEx.id, text: "甲".repeat(200), actor: "runtime" });
    store3.appendSentence({ topic: noteEx.id, text: "乙".repeat(200), actor: "runtime" });
    // ③ 命中数上限：40 组 × 3 候选共享同一独特 token ⇒ 单 note 原始命中 120（旧实现无上限 >100）
    const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
    const cnNum = (n) => {
      if (n <= 10) return CN[n - 1] + "号";
      if (n < 20) return "十" + CN[n - 11] + "号";
      return CN[Math.floor(n / 10) - 1] + "十" + (n % 10 ? CN[n % 10 - 1] : "") + "号";
    };
    const noteHits = store3.seedTopic({ name: "笔记·E-工具-命中/9999aaaa", triggers: [], src: "selftest", actor: "plugin" });
    const hitWords = [];
    for (let g = 1; g <= 40; g++) {
      const w = cnNum(g);
      hitWords.push("组" + w);
      for (const sfx of ["甲", "乙", "丙"]) {
        const t = store3.seedTopic({ name: "候选组" + w + sfx, triggers: [], src: "selftest", actor: "plugin" });
        store3.appendSentence({ topic: t.id, text: "候选 组" + w + sfx + " 正文。", actor: "runtime" });
      }
    }
    store3.appendSentence({ topic: noteHits.id, text: hitWords.join(" ") + "。", actor: "runtime" });
    const dp3 = await hooks3.buildPrompt({});
    const ps3 = dp3.prescreen || { items: [] };
    const items3 = ps3.items || [];
    R.ok(items3.length >= 3, "I'-3b 质量 fixture：≥3 个 note 进入预筛块", "notes=" + ps3.notes);
    // ① 命中数 ≤100
    const itHits = items3.find((x) => String(x.noteName).indexOf("命中") >= 0);
    R.ok(!!itHits && itHits.hitTopics <= 100, "I'-3c 单 note 命中候选主题数 ≤100（硬上限）", itHits ? ("hitTopics=" + itHits.hitTopics + " raw=" + itHits.hitTopicsRaw) : "no item");
    R.ok(!!itHits && itHits.hitTopicsRaw <= 100, "I'-3d df 上限收敛：原始命中数也 ≤100（旧实现无 df 上限/无 hitTopics 字段 ⇒ 本门必红）", itHits ? "raw=" + itHits.hitTopicsRaw : "no item");
    // ② top-1 与 note 工作区线一致率 ≥ 先测基线（审计③真库 2/4 = 50%）
    //    测法（写死）：note 名 `笔记·<wsKey>/<sid8>` ⇒ wsKey 按 [-_/、] 切段取长度 ≥2 的段；
    //      top-1 主题名 或 其父线名（归一化）包含任一段 ⇒ 一致。
    const nzW = (x) => String(x == null ? "" : x).replace(/[\s_\-·・,，.。:：/\\()（）\[\]【】]/g, "").toLowerCase();
    const rowById3 = new Map(store3.topics().map((t) => [String(t.id), t]));
    const parentName3 = (t) => { const p = t && t.parentId ? rowById3.get(String(t.parentId)) : null; return p ? String(p.name || "") : ""; };
    const wsSegs = (wsKey) => String(wsKey).split(/[-_/、]+/).map(nzW).filter((x) => x && x.length >= 2);
    const consistent = (it) => {
      if (!it || !it.links || !it.links.length) return false;
      const top = rowById3.get(String(it.links[0].id));
      if (!top) return false;
      const hay = nzW(top.name) + "|" + nzW(parentName3(top));
      return wsSegs(it.wsKey).some((s) => hay.indexOf(s) >= 0);
    };
    const itWs = items3.find((x) => String(x.noteName).indexOf("dsh远程访问") >= 0);
    R.ok(!!itWs && itWs.links.length >= 1, "I'-3e 同工作区 note 有 top-1 关联", itWs ? JSON.stringify(itWs.links.map((l) => l.name)) : "no item");
    R.ok(consistent(itWs), "I'-3f top-1 与 note 工作区线一致（同工作区线加权生效）", itWs ? String(itWs.links[0].name) : "no item");
    // 受控 2 note：1 同区（一致）+ 1 跨区（不一致）⇒ 一致率 1/2 = 50% ≥ 审计③基线 2/4
    const rate = [itWs, itHits].filter(consistent).length / 2;
    R.ok(rate >= 0.5, "I'-3g top-1 工作区线一致率 ≥ 基线 50%（受控 2 note）", "rate=" + rate);
    // ③ [I'-6] 两句各 200 ⇒ 摘录 ≤400
    const itEx = items3.find((x) => String(x.noteName).indexOf("摘录") >= 0);
    R.ok(!!itEx && itEx.excerptLen > 0 && itEx.excerptLen <= 400, "I'-6 两句各 200 字 ⇒ 摘录 ≤400（join 分隔符计入累计）", itEx ? "excerptLen=" + itEx.excerptLen : "no item");
    // ④ [S'-3] 预算截断分支（直接调纯函数）
    const notes3 = store3.topics().filter((t) => /^笔记·/.test(String(t.name)) && String(t.state || "") !== "archived");
    const trunc = mod3.__dreamPrescreenNoteLinks(store3.topics(), notes3, { store: store3, blockCap: 500 });
    R.ok(trunc.dropped >= 1, "S'-3 块预算 500 ⇒ note 级截断 + dropped 计数", "notes=" + trunc.notes + " dropped=" + trunc.dropped);
    const minViable = mod3.__dreamPrescreenNoteLinks(store3.topics(), notes3, { store: store3, blockCap: 1100 });
    R.ok(minViable.notes >= 1, "I'-4a 最小可行块（1,100）⇒ 至少保留 1 个 note", "notes=" + minViable.notes);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 场景 4：[I'-4] lessons 非空 ⇒ 预算耗尽不静默丢块（至少保留 1 note + monitor 告警）
// ════════════════════════════════════════════════════════════════════════
{
  const longLesson = "## Pending Lessons（回归闭环沉淀候选，插件已按规则算好本轮投喂：10 条）\n"
    + Array.from({ length: 10 }, (_, i) => "L" + (i + 1) + ". [resolved] sig-" + i + "（tool=pwsh）\n   error: " + "错".repeat(240) + "\n   args: " + "参".repeat(240) + "\n   solution: " + "解".repeat(200)).join("\n");
  R.ok(longLesson.length >= 6000, "I'-4b 前置：lessonFeedText 足够长（≥6,000 字，基线将 >10,500）", "len=" + longLesson.length);
  const dpL = await mod.__dreamHooks.buildPrompt({ lessonFeedText: longLesson });
  const psL = (dpL && dpL.prescreen) || {};
  R.ok(Number(psL.notes) >= 1, "I'-4c 预算耗尽仍保留 ≥1 个 note 块（不静默丢）", "notes=" + psL.notes + " chars=" + psL.chars);
  R.ok(psL.budgetExhausted === true && Number(psL.droppedBudget) >= 1, "I'-4d 标记 budget=exhausted / droppedBudget≥1", JSON.stringify({ exhausted: psL.budgetExhausted, dropped: psL.droppedBudget }));
  R.ok(((dpL && dpL.checkpointEvidence) || {}).droppedByBudget === 1, "I'-4e 检查点证据块本轮按预算丢弃（droppedByBudget=1）", String(((dpL && dpL.checkpointEvidence) || {}).droppedByBudget));
  await sleep(800);
  const mdL = readMonitor(H) || {};
  const evL = (mdL.events || []).map((x) => String((x && x.detail) || "")).filter((s) => /^prescreen notes=/.test(s));
  const lastL = evL.length ? evL[evL.length - 1] : "";
  R.ok(/budget=exhausted/.test(lastL) && /droppedBudget=[1-9]/.test(lastL), "I'-4f monitor 事件带 budget=exhausted/droppedBudget", lastL.slice(0, 200));
}

finish(R);


