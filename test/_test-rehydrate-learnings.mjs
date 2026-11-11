// _test-rehydrate-learnings.mjs —— 4.5.15 门（R2 压缩后重灌「累积学习 learnings」段，db 模式造数）
//
// 跑法：node test/_test-rehydrate-learnings.mjs [index.js 路径]
//
// 依据：
//   · docs/方案-4.5.15-记忆检索提醒与升级协议.md §9.6（L-6）+ §10.1（B1：R2_TOTAL 6100→6900）
//   · docs/audit/recall-reminder_v2_AUDIT_2026-11-11.md（N-4：dreamCheckpointEvidence 不按当前 wsKey 收窄）
//   · docs/audit/recall-reminder_v3_AUDIT_2026-11-11.md（B1：预算与砍序门不自洽 ⇒ 6900）
//
// 覆盖：
//   L1 跨工作区收窄：同 wsKey 2 个 + 异 wsKey 1 个 + 本会话 1 个检查点 ⇒ learnings 只收同 wsKey 的 2 个
//      （不含本会话字面量、不含异 wsKey 字面量）
//   L2 结构：≤2 条/节、每条 ≤100 字、learnings 段 ≤900 字、段头在【检查点续接】**之前**
//   L3 预算：cpBody ≤2400；块总长 ≤6900（R2_TOTAL=6900）
//   L4 砍序：饱和夹具 ⇒ dropped 含 "learnings"、**不含** profile/project/checkpoint（learnings 是第一刀）
//   L5 一次取数：buildPostCompactRehydrate 每次只调 1 次 store.topics()（入口一份 rows 三处共用）
//   L6 flag 关：rebuildLearnings=false ⇒ 无 learnings 段（字节级回退，见 _test-recall-reminder H10 sha16 门）
//   L7 观测：monitorEvent("rehydrate", …) 含 learn=<条数>
//   L8 降级：只有 1 个同 wsKey 检查点 ⇒ learnings 仍生成（不报错）
//   L9 静态：R2_TOTAL=6900 / R2_LEARN_SEG_MAX=900 / 砍序 learnings 在 profile 之前
//
// 说明（口径，审计④ N-4 定稿）：饱和门**用生产 6900 真饱和**，不传 opts.budget：
//   各段内容都超过 R2 既有 cap ⇒ 被行边界/字符硬截**正好卡满**（checkpoint 2400 / project 1150 /
//   profile 350 / note ≤1900），实测四段块 = 6025 字；+ learnings 段（≤900，实测 ≈890）+ 分隔符 > 6900
//   ⇒ 第一刀砍 learnings。对照 build（rebuildLearnings=false）单独量四段块，证明「饱和窗口真实存在」。
//
// 隔离纪律：全部场景在 os.tmpdir() 下造独立 DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB（复用 test/_accept-p0-lib.mjs），
//   **不碰真实 ~/.dsh/memory**；不写运行副本；不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkHome, useHome, freshPlugin, makeCtx, applyPlugin, mkAgent, waitTopicDb, seedD8, todayStr,
  makeReporter, finish, readMonitor, sleep,
} from "./_accept-p0-lib.mjs";
import * as p25 from "../p25-topics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const SRC = fs.readFileSync(PLUGIN, "utf8");
const R = makeReporter("4.5.15 R2 累积学习（learnings）");
// 本门 fresh import 多个插件实例（每个实例挂 crash observer 监听器）⇒ 放开监听器上限
try { process.setMaxListeners(0); } catch (e) { }

const LEARN_HEAD = "【累积学习";
const CP_HEAD = "【检查点续接";
const SEG_MAX = 900;
const R2_TOTAL = 6900;
const CP_BODY_MAX = 2400;

const TITLES = ["本次目标", "当前状态", "下一步行动", "关键结论", "文件与代码", "错误与修复", "任务与待办", "未决问题"];
/** 造 8 节合法检查点（mark 打在各节首行；size 控制每节填充量） */
function ckptMd(mark, size) {
  const out = [];
  for (const n of TITLES) {
    out.push("## " + n);
    out.push("- " + mark + "-" + n + " " + "占位内容".repeat(Math.max(1, Math.ceil((size || 40) / 4))));
    out.push("- " + mark + "-" + n + "-2 第二条 " + "内容".repeat(20));
  }
  return out.join("\n") + "\n";
}
function seedProjectProfile(h) {
  const pdir = path.join(h.mem, "projects");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "_index.json"), JSON.stringify({
    version: 1, projects: [{ key: "r415ws", display: "r415ws", file: "r415ws.md", workdirs: ["C:\\r415\\ws"], root: "C:\\r415\\ws", aliases: [], updatedAt: 1 }],
  }), "utf8");
  fs.writeFileSync(path.join(pdir, "r415ws.md"), "# r415ws\n\n## Rules\n- " + "项目规则行".repeat(60)
    + "\n\n## 当前状态与下一步\n" + "- 状态行".repeat(60) + "\n\n## Gotchas\n" + "- 坑位行".repeat(60)
    + "\n\n## Architecture decisions\n" + "- 决策行".repeat(60) + "\n", "utf8");
  fs.writeFileSync(path.join(h.mem, "global.md"), "# 全局记忆\n- 画像标记\n" + "- 画像行".repeat(100) + "\n", "utf8");
}

/**
 * 在**已 apply 且主题库就绪**的实例里造 P2.5 结构主题：
 *   D8 域（seedD8）→ 每个 wsKey 一条线（`会话检查点·<wsKey>`）→ 检查点主题（`<wsKey>/<sid8>`，挂线、active）
 *   + 本会话笔记主题（`笔记·<wsKey>/<sid8>`）。
 * opts: { wsKey, wsKey2, ownSid8, learnSids, otherSid8, ownMark, noteCount, cpSize }
 */
function seedTopics(mod, opts) {
  const o = opts || {};
  const store = mod.__topicdb.store;
  const d8 = seedD8(mod);
  const dom = d8.dom;
  const mkLine = (ws) => {
    const name = p25.lineName(ws);
    const r = store.seedTopic({ name: name, triggers: [ws], src: "sessions/CHECKPOINT.md", actor: "plugin" });
    try { store.setLevel(r.id, "project", { actor: "lead" }); } catch (e) { }
    try { store.linkParent(r.id, dom.id, { actor: "lead" }); } catch (e) { }
    try { store.setState(r.id, "active", { actor: "runtime", reason: "learnings-gate" }); } catch (e) { }
    return r.id;
  };
  const mkCp = (ws, sid8, text, lineId) => {
    const name = p25.sessionTopicName(ws, sid8);
    const r = store.seedTopic({ name: name, triggers: [sid8], src: "sessions/CHECKPOINT.md", actor: "plugin" });
    try { store.linkParent(r.id, lineId, { actor: "lead" }); } catch (e) { }
    try { store.setLevel(r.id, "detail", { actor: "lead" }); } catch (e) { }
    try { store.setState(r.id, "active", { actor: "runtime", reason: "learnings-gate" }); } catch (e) { }
    store.appendSentence({ topic: r.id, text: String(text), src: "sessions/CHECKPOINT.md", actor: "runtime" });
    return r.id;
  };
  const line1 = mkLine(o.wsKey);
  const line2 = mkLine(o.wsKey2);
  const cpSize = o.cpSize == null ? 700 : o.cpSize;
  // 本会话检查点（当前快照段来源；其「关键结论」标记绝不能出现在 learnings 里）
  if (o.ownMark) mkCp(o.wsKey, o.ownSid8, ckptMd(o.ownMark, cpSize), line1);
  for (const s8 of (o.learnSids || [])) mkCp(o.wsKey, s8, ckptMd(o.learnMarkOf ? o.learnMarkOf(s8) : s8.toUpperCase(), cpSize), line1);
  if (o.otherSid8) mkCp(o.wsKey2, o.otherSid8, ckptMd("OTHERWS", cpSize), line2);
  if (o.noteCount > 0) {
    const nt = store.seedTopic({ name: "笔记·" + o.wsKey + "/" + o.ownSid8, triggers: [], src: "sessions/NOTE.md", actor: "plugin" });
    for (let i = 0; i < o.noteCount; i++) store.appendSentence({ topic: nt.id, text: "NOTE-" + i + " " + "笔记内容".repeat(20), src: "sessions/x.md", actor: "runtime" });
  }
  return { store: store, dom: dom, line1: line1, line2: line2 };
}

/** 切分 learnings 段（段头在【检查点续接】之前；到下一个【段头/块尾】为止） */
function learnSegment(text) {
  const t = String(text || "");
  const i = t.indexOf(LEARN_HEAD);
  if (i < 0) return "";
  const after = t.slice(i);
  const stop = after.slice(1).search(/\n【/);
  return (stop >= 0 ? after.slice(0, stop + 1) : after).trim();
}
function segBody(text, head) {
  const t = String(text || "");
  const i = t.indexOf(head);
  if (i < 0) return "";
  const after = t.slice(i);
  const nl = after.indexOf("\n");
  if (nl < 0) return "";
  const rest = after.slice(nl + 1);
  const stop = rest.search(/\n【/);
  return (stop >= 0 ? rest.slice(0, stop) : rest).trim();
}
/** 数一段里的条目行（`- 关键结论：…` / `- 错误与修复：…`） */
function learnItems(seg) {
  return String(seg || "").split("\n").map((l) => l.trim()).filter((l) => /^- (关键结论|错误与修复)：/.test(l));
}

/** 场景启动（db 模式）：临时 HOME → fresh import → apply → 等主题库就绪 */
async function bootDb(tag, cfg) {
  const h = useHome(mkHome("r415l-" + tag));
  seedProjectProfile(h);
  const mod = await freshPlugin();
  const { ctx } = makeCtx({ subagents: null });
  applyPlugin(mod, Object.assign({ memoryTopicDbEnabled: true }, cfg || {}), ctx);
  const ready = await waitTopicDb(mod, 20000);
  return { h: h, mod: mod, ready: ready, store: ready ? mod.__topicdb.store : null };
}

const WS = p25.normalizeWorkspace("C:\\r415\\ws");
const WS2 = p25.normalizeWorkspace("D:\\other\\proj");
const OWN_S8 = "a1111111";
const { agent } = mkAgent("session-" + OWN_S8, { cwd: "C:\\r415\\ws" });

// ═══════════════════════════════════════════════════════════════════════════
// L1~L3/L5/L7/L9：非饱和主夹具（同 wsKey 2 + 异 wsKey 1 + 本会话 1）
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await bootDb("main", {});
  R.ok(S.ready, "L0 前置：主题库就绪", S.ready ? "ready" : String((S.mod.__topicdb && S.mod.__topicdb.err) || "not-ready"));
  if (S.ready) {
    seedTopics(S.mod, {
      wsKey: WS, wsKey2: WS2, ownSid8: OWN_S8, ownMark: "OWNCP",
      learnSids: ["b2222222", "c3333333"], learnMarkOf: (s8) => (s8 === "b2222222" ? "LEARNB" : "LEARNC"),
      otherSid8: "d4444444", noteCount: 8, cpSize: 300,
    });
    // 一次取数：build 期间 store.topics() 只调 1 次
    let nTopics = 0;
    const orig = S.store.topics.bind(S.store);
    S.store.topics = (...a) => { nTopics++; return orig(...a); };
    let r = null, threw = null;
    try { r = await S.mod.__p4Hooks.buildPostCompactRehydrate(agent); } catch (e) { threw = e; }
    S.store.topics = orig;
    R.ok(!threw && !!r, "L0b buildPostCompactRehydrate 不抛、返回 {text,chars,dropped}", threw ? "threw=" + threw.message : "chars=" + (r && r.chars));
    const text = (r && r.text) || "";
    const learn = learnSegment(text);
    const items = learnItems(learn);
    R.ok(learn.length > 0 && learn.indexOf("LEARNB-关键结论") >= 0 && learn.indexOf("LEARNC-关键结论") >= 0,
      "L1a learnings 段存在且收同 wsKey 的 2 个检查点（LEARNB / LEARNC 标记都在）", "learnLen=" + learn.length);
    R.ok(learn.indexOf("OWNCP-关键结论") < 0, "L1b 排除本会话检查点：learnings 不含本会话「关键结论」标记", "");
    R.ok(learn.indexOf("OTHERWS") < 0, "L1c 按当前 wsKey 收窄：learnings 不含异工作区检查点字面量", "");
    R.ok(learn.length <= SEG_MAX, "L2a learnings 段 ≤900 字（含段头）", "len=" + learn.length);
    R.ok(items.length > 0 && items.length <= 8, "L2b learnings 条目 ≤2 检查点×2 节×2 条 = 8", "items=" + items.length);
    const badLen = items.filter((l) => {
      const body = l.replace(/^- (关键结论|错误与修复)：/, "");
      return [...body].length > 100;
    });
    R.ok(badLen.length === 0, "L2c 每条 learnings 条目 ≤100 字（超长按字符硬截）", "bad=" + badLen.length);
    const nK = items.filter((l) => l.indexOf("- 关键结论：") === 0).length;
    const nE = items.filter((l) => l.indexOf("- 错误与修复：") === 0).length;
    R.ok(nK <= 4 && nE <= 4, "L2d 每节 ≤2 条 × 2 检查点（关键结论 ≤4 / 错误与修复 ≤4）", "k=" + nK + " e=" + nE);
    const iLearn = text.indexOf(LEARN_HEAD), iCp = text.indexOf(CP_HEAD);
    R.ok(iLearn >= 0 && iCp >= 0 && iLearn < iCp, "L2e 段头位置：learnings 在【检查点续接】**之前**", "learn@" + iLearn + " cp@" + iCp);
    const cpBody = segBody(text, CP_HEAD);
    R.ok(cpBody.length > 0 && cpBody.length <= CP_BODY_MAX, "L3a 检查点段体 ≤2400 字", "len=" + cpBody.length);
    R.ok(text.length > 0 && text.length <= R2_TOTAL, "L3b 重灌块总长 ≤6900（R2_TOTAL）", "total=" + text.length);
    R.ok(nTopics === 1, "L5 一次取数：buildPostCompactRehydrate 期间 store.topics() 恰好 1 次（入口一份 rows 三处共用）", "calls=" + nTopics);
    R.ok(Number(r && r.learnings) === items.length && items.length > 0, "L7a 返回值 learnings 条数与段内条目一致", "learnings=" + (r && r.learnings) + " items=" + items.length);
    await sleep(900);
    const ev = ((readMonitor(S.h) || {}).events || []).filter((e) => e && e.type === "rehydrate").map((e) => String(e.detail || "")).pop() || "";
    R.ok(new RegExp("learn=" + items.length + "(\\s|$)").test(ev), "L7b monitorEvent(\"rehydrate\") 含 learn=<条数>", ev.slice(0, 160));

    // ── L4 生产 6900 **真饱和**（无 opts.budget）：四段各打满 R2 既有 cap + learnings ≤900 ⇒ 总 >6900 ──
    //   做法（审计④ N-4）：各段内容都超过 cap ⇒ 被行边界/字符硬截**正好卡满**：
    //   checkpoint 2400（md fallback 单行 2400）/ project 1150（单行）/ profile 350（单行）/
    //   note ≤1900（单长句 1897，N=1000 条使段头带「只注最近 1 条」）/ learnings 8 条 ×100 字 ≤900。
    //   实测：四段块 = 6025 字；learnings 段 ≈890 ⇒ 装配后 >6900 ⇒ 第一刀砍 learnings。
    //   对照（rebuildLearnings=false）用于量四段块并证明各段卡满 cap。
    const MAX_WS = WS, MAX_OWN = "a1111111";
    const seedMax = (h) => {
      fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"), "C".repeat(2400), "utf8");
      const pdir = path.join(h.mem, "projects");
      const display = "长沙交易场地智能化系统升级改造（大模型应用）项目";   // 24 字（真实长项目名量级；段头随之变长）
      fs.writeFileSync(path.join(pdir, "_index.json"), JSON.stringify({
        version: 1, projects: [{ key: "r415ws", display: display, file: "r415ws.md", workdirs: ["C:\\r415\\ws"], root: "C:\\r415\\ws", aliases: [], updatedAt: 1 }],
      }), "utf8");
      fs.writeFileSync(path.join(pdir, "r415ws.md"), "P".repeat(1150), "utf8");
      fs.writeFileSync(path.join(h.mem, "global.md"), "G".repeat(350), "utf8");
    };
    const seedMaxTopics = (S2) => {
      const store2 = S2.mod.__topicdb.store;
      const d8b = seedD8(S2.mod);
      const mkLine2 = (ws) => {
        const r = store2.seedTopic({ name: p25.lineName(ws), triggers: [ws], src: "sessions/CHECKPOINT.md", actor: "plugin" });
        try { store2.setLevel(r.id, "project", { actor: "lead" }); } catch (e) { }
        try { store2.linkParent(r.id, d8b.dom.id, { actor: "lead" }); } catch (e) { }
        try { store2.setState(r.id, "active", { actor: "runtime", reason: "max" }); } catch (e) { }
        return r.id;
      };
      const line2 = mkLine2(MAX_WS);
      const mkCp2 = (s8) => {
        const r = store2.seedTopic({ name: p25.sessionTopicName(MAX_WS, s8), triggers: [s8], src: "sessions/CHECKPOINT.md", actor: "plugin" });
        try { store2.linkParent(r.id, line2, { actor: "lead" }); } catch (e) { }
        try { store2.setLevel(r.id, "detail", { actor: "lead" }); } catch (e) { }
        try { store2.setState(r.id, "active", { actor: "runtime", reason: "max" }); } catch (e) { }
        // 2 节 × 2 条 × 100 字（每行 >100 ⇒ r2LearnSectionItems 截到 100）
        const body = "## 关键结论\n- K" + s8 + "A" + "甲".repeat(99) + "\n- K" + s8 + "B" + "乙".repeat(99)
          + "\n## 错误与修复\n- E" + s8 + "A" + "丙".repeat(99) + "\n- E" + s8 + "B" + "丁".repeat(99) + "\n";
        store2.appendSentence({ topic: r.id, text: body, src: "sessions/CHECKPOINT.md", actor: "runtime" });
      };
      mkCp2("b2222222"); mkCp2("c3333333");
      // 笔记：999 短句 + 1 条 1897 长句（尾部优先 ⇒ 只注长句；N=1000 使段头「只注最近 1 条」）
      const nt2 = store2.seedTopic({ name: "笔记·" + MAX_WS + "/" + MAX_OWN, triggers: [], src: "sessions/NOTE.md", actor: "plugin" });
      for (let i = 0; i < 999; i++) store2.appendSentence({ topic: nt2.id, text: "n" + i, src: "sessions/x.md", actor: "runtime" });
      store2.appendSentence({ topic: nt2.id, text: "N".repeat(1897), src: "sessions/x.md", actor: "runtime" });
    };
    const maxAgent = mkAgent("session-" + MAX_OWN, { cwd: "C:\\r415\\ws" }).agent;
    // 对照：learnings 关 ⇒ 四段块（用于量 cap 与总长）
    const C = await bootDb("maxctl", { rebuildLearnings: false }, seedMax);
    R.ok(C.ready, "L4-0 前置：真饱和对照实例主题库就绪", C.ready ? "ready" : "not-ready");
    let ctl = null;
    if (C.ready) { seedMax(C.h); seedMaxTopics(C); ctl = await C.mod.__p4Hooks.buildPostCompactRehydrate(maxAgent); }
    const ctlText = (ctl && ctl.text) || "";
    const ctlCp = segBody(ctlText, CP_HEAD), ctlPj = segBody(ctlText, "【项目记忆"), ctlPf = segBody(ctlText, "【用户画像"), ctlNote = segBody(ctlText, "【会话笔记");
    R.ok(ctlCp.length === 2400, "L4a 真饱和对照：检查点段体卡满 2400（cap）", "len=" + ctlCp.length);
    R.ok(ctlPj.length === 1150, "L4b 真饱和对照：项目段体卡满 1150（cap）", "len=" + ctlPj.length);
    R.ok(ctlPf.length === 350, "L4c 真饱和对照：画像段体卡满 350（cap）", "len=" + ctlPf.length);
    R.ok(ctlNote.length > 1800 && ctlNote.length <= 1900, "L4d 真饱和对照：笔记段体 ≤1900 cap（实测 1899，尾部优先单长句）", "len=" + ctlNote.length);
    R.ok(ctlText.length < R2_TOTAL && ctlText.length + 2 + SEG_MAX > R2_TOTAL,
      "L4e 真饱和对照：四段块 <6900，但 +learnings（≤900）必然 >6900（即饱和窗口真实存在）", "four=" + ctlText.length);
    // 真饱和：learnings 开、**不传 budget** ⇒ 总长 >6900 ⇒ 第一刀砍 learnings
    const M = await bootDb("maxsat", {}, seedMax);
    R.ok(M.ready, "L4-1 前置：真饱和实例主题库就绪", M.ready ? "ready" : "not-ready");
    let r2 = null, threw2 = null;
    if (M.ready) { seedMax(M.h); seedMaxTopics(M); try { r2 = await M.mod.__p4Hooks.buildPostCompactRehydrate(maxAgent); } catch (e) { threw2 = e; } }
    const text2 = (r2 && r2.text) || "";
    const dropped2 = (r2 && r2.dropped) || [];
    R.ok(!threw2 && !!r2, "L4f 真饱和 build 不抛（无 opts.budget）", threw2 ? "threw=" + threw2.message : "chars=" + (r2 && r2.chars));
    R.ok(dropped2.indexOf("learnings") >= 0, "L4g ★ 真饱和（四段满+learnings>6900）⇒ dropped 含 \"learnings\"（第一刀）", JSON.stringify(dropped2));
    R.ok(dropped2.indexOf("profile") < 0 && dropped2.indexOf("project") < 0 && dropped2.indexOf("checkpoint") < 0,
      "L4h 砍 learnings 后不再砍 profile/project/checkpoint（四段原样保留）", JSON.stringify(dropped2));
    R.ok(text2.indexOf(LEARN_HEAD) < 0 && Number(r2 && r2.learnings) === 0, "L4i 真饱和后 learnings 段整段移除（learnings=0）", "learnings=" + (r2 && r2.learnings));
    R.ok(text2.length <= R2_TOTAL && Math.abs(text2.length - ctlText.length) <= 2,
      "L4j 真饱和后总长 ≤6900 且等于四段块（砍掉 learnings 即回落）", "total=" + text2.length + " four=" + ctlText.length);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// L6：flag 关（rebuildLearnings=false）⇒ 无 learnings 段
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await bootDb("off", { rebuildLearnings: false });
  R.ok(S.ready, "L6-0 前置：主题库就绪", S.ready ? "ready" : "not-ready");
  if (S.ready) {
    seedTopics(S.mod, {
      wsKey: WS, wsKey2: WS2, ownSid8: OWN_S8, ownMark: "OWNCP",
      learnSids: ["b2222222", "c3333333"], learnMarkOf: (s8) => (s8 === "b2222222" ? "LEARNB" : "LEARNC"),
      otherSid8: "d4444444", noteCount: 8, cpSize: 300,
    });
    const r = await S.mod.__p4Hooks.buildPostCompactRehydrate(agent);
    const text = (r && r.text) || "";
    R.ok(text.length > 0 && text.indexOf(LEARN_HEAD) < 0, "L6a rebuildLearnings=false ⇒ 无【累积学习】段", "total=" + text.length);
    R.ok(Number(r && r.learnings) === 0, "L6b 返回值 learnings=0", "learnings=" + (r && r.learnings));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// L8：只有 1 个同 wsKey 检查点 ⇒ 降级但可用
// ═══════════════════════════════════════════════════════════════════════════
{
  const S = await bootDb("one", {});
  R.ok(S.ready, "L8-0 前置：主题库就绪", S.ready ? "ready" : "not-ready");
  if (S.ready) {
    seedTopics(S.mod, {
      wsKey: WS, wsKey2: WS2, ownSid8: OWN_S8, ownMark: "OWNCP",
      learnSids: ["b2222222"], learnMarkOf: () => "LEARNB",
      otherSid8: "d4444444", noteCount: 3, cpSize: 300,
    });
    const r = await S.mod.__p4Hooks.buildPostCompactRehydrate(agent);
    const learn = learnSegment((r && r.text) || "");
    R.ok(learn.length > 0 && learn.indexOf("LEARNB-关键结论") >= 0 && learnItems(learn).length <= 4,
      "L8a 只有 1 个同 wsKey 检查点 ⇒ learnings 降级生成（≤4 条），不报错", "items=" + learnItems(learn).length);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// L9：静态（预算常量 + 砍序）
// ═══════════════════════════════════════════════════════════════════════════
{
  R.ok(/Math\.min\(6900, Math\.floor\(_budgetRaw\)\)/.test(SRC) && /: 6900;/.test(SRC),
    "L9a 静态：R2_TOTAL 收口 6100→6900（clamp + 默认两处字面量）", "");
  R.ok(/const R2_LEARN_SEG_MAX = 900;/.test(SRC) && /const R2_LEARN_MAX_CP = 2;/.test(SRC) && /const R2_LEARN_ITEM_CHARS = 100;/.test(SRC),
    "L9b 静态：learnings 预算常量（段 ≤900 / ≤2 检查点 / 每条 ≤100）", "");
  const iL = SRC.indexOf('s.key === "learnings"');
  const iP = SRC.indexOf('s.key === "profile"');
  R.ok(iL >= 0 && iP > iL, "L9c 静态：砍序 learnings 在 profile 之前（第一刀）", "learn@" + iL + " profile@" + iP);
  R.ok(SRC.indexOf("learn=\" + learnN") >= 0, "L9d 静态：monitorEvent(\"rehydrate\") 带 learn= 观测", "");
}

finish(R);
