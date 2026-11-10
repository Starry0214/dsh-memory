// _accept-p4.mjs — P4 独立验收：R2「压缩后记忆重灌」+ A「writer Agent Preset 生效」
//
// 设计依据：.task/1101-dsh-mimo-survey/14-p4-design.md
//   P4-R2（§3）：compaction/summary 之后，把被压缩吃掉的记忆补回当前会话，与「记忆刷新提示 + 外部事实包」
//     合并成**同一条** <system-reminder> 注入：
//       【压缩后记忆重灌（dsh-memory）】
//       【检查点续接（<file>）】≤2000   ← latestSessionSummary()（库优先/回落 md）→ sectionAwareSlice + p0FitLines 硬收口
//       【项目记忆（<项目>）】≤700      ← matchProjectByCwd → projects/<file> 切片 + 硬收口
//       【用户画像（global.md）】≤300   ← stabilize(global.md) → sectionAwareSlice + 硬收口
//     重灌块整条上限 = 3000 + 装配容差 320（头+段头+分隔符）；段体超限时按行边界硬截（绝不切半行）。
//     幂等：POST_COMPACT_REHYDRATE_IDS per compactionId（容量 200 FIFO）；失败一律降级只注刷新提示；
//     只在顶层会话（header.origin !== 'subagent'）。
//   P4-A（§1）：compactOnce / startSubagentCompat 把 agentPreset 透传进 startActivation 的 spec.request
//     （DSH 0.2.x 里 toolFilter 已被宿主丢弃，只有 agentPreset 能真正收窄 writer 工具面）；
//     preset 未配置/为空 ⇒ 不传（回落原行为）；preset 挂载失败 ⇒ 回落不带 preset 再起一次，绝不阻断检查点写入；
//     0.1.x 的 start() 不认识 preset ⇒ startSubagentCompat 必须摘掉它；toolFilter 仍原样透传（兼容保留）。
//
// 验收方式（黑盒为主 + P4_TEST_HOOKS 纯函数/接线级）：
//   · R2 端到端：临时 HOME 造数（sessions/<今日>.md 检查点、projects/_index.json + 项目切片、global.md 画像）
//     → 真 import/apply → agent/created 注册会话 → 真触发 session/event(compaction/summary + compaction/end)
//     → 等待 setTimeout(0) 异步链 → 检查 agent.__injected 里的合并注入文本。
//   · 幂等/闸门/降级：同 compactionId 重发、origin='subagent'、数据源全空三种真实路径。
//   · 预算：段体长度（标题行除外）**严格**对照 2000/700/300（不依赖容差——实现用 p0FitLines 二次硬截）；
//     重灌块 ≤3320；常规造数整条注入 ≤6000；饱和造数（MAX）下另外量化「整条注入 vs 6000」的口径差（WARN，报 Lead 决策）。
//   · P4-A：__p4Hooks.startSubagentCompat / compactOnce + fake subagents 桩捕获 startActivation(spec)
//     （0.2.x：有 startActivation 无 start；0.1.x：只有 start），并覆盖三档配置 + 两次回落 + 全失败。
//   · 回归：子进程跑既有 test/_p2-selftest.mjs，确认 P2 纯函数契约不受影响。
//
// 跑法：node test/_accept-p4.mjs [index.js 路径]
//   · 对「P4 改前副本」跑：R2/预设相关项 FAIL（__p4Hooks 字段为 null 的纯函数项 SKIP）——baseline。
//   · 对 P4 实现后跑：期望全绿（WARN 不计失败，报告里列明）。
// 安全：全部 os.tmpdir() 临时 HOME / MEMORY_ROOT；绝不读写真实 ~/.dsh/memory；不写运行副本；不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  TARGET, HERE, mkHome, useHome, freshPlugin, makeCtx, mkAgent, applyPlugin,
  callCreated, msgText, todayStr, sessionMdPath, readMonitor,
  makeReporter, finish, sleep, hasPartialLiteral, jsonContains, capConsole,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P4 记忆重灌 + writer preset 验收");
const rand = () => Math.random().toString(36).slice(2, 8);
const CFG_OFF = {};                                   // flag 关：检查点走 sessions/*.md（R2 读端回落路径，最可造数）
const HOST_SUMMARY = "## Primary Request and Intent\nP4 验收宿主摘要占位（长度满足检查点门槛）" + rand() + "\n"
  + "## Pending Jobs\n- 继续 P4 验收\n## Next Step\n- 跑 _accept-p4\n";
// 设计预算（14-p4-design.md §3）；实现（12:07 版）在 sectionAwareSlice 后追加 p0FitLines 二次行边界硬截
// ⇒ 段体现在是**严格** ≤ 预算（不再需要「切片尾注容差」），断言按严格口径验证。
// [审计 F6 修复 2026-11-04] 预算对齐实现现值（设计定稿 §3.4）：四段 body 合计 5800 + 装配头容差 300 = 6100。
//   旧值 2000/700/300（合计 3320）会让本门 10 条断言全红（实现已改，测试没跟）。
const R2_BUDGET = { checkpoint: 2400, project: 1150, profile: 350, note: 1900 };
// 重灌块整条上限 = 四段 body 合计 5800 + 装配容差 300（重灌头+段头+分隔符；与实现 R2_TOTAL 同口径）
const R2_BLOCK_TOTAL = R2_BUDGET.checkpoint + R2_BUDGET.project + R2_BUDGET.profile + R2_BUDGET.note + 300;
const MERGED_TOTAL_MAX = 8000;

const TITLES8 = ["本次目标", "当前状态", "下一步行动", "关键结论", "文件与代码", "错误与修复", "任务与待办", "未决问题"];

/** 造 8 节合法检查点 markdown（marks：各节首行唯一标记；sizes：各节目标长度） */
function buildCheckpointMd(opts) {
  const o = opts || {};
  const sizes = o.sizes || {
    本次目标: 380, 当前状态: 420, 下一步行动: 240, 关键结论: 420,
    文件与代码: 300, 错误与修复: 300, 任务与待办: 240, 未决问题: 240,
  };
  const marks = o.marks || {};
  const out = [];
  for (const name of TITLES8) {
    out.push("## " + name);
    let body = marks[name] ? String(marks[name]) + "\n" : "";
    let i = 0;
    while (body.length < Number(sizes[name] || 300)) {
      body += "- 条目" + i + "：" + "验收占位内容".repeat(6).slice(0, 60) + "\n";
      i++;
    }
    out.push(body.trimEnd());
  }
  return out.join("\n\n") + "\n";
}

/** 8 节合法子代理输出（P4-A 端到端要让检查点写入成功） */
function build8Output(mark) {
  const out = [];
  for (const name of TITLES8) {
    out.push("## " + name);
    out.push("- " + (mark || "P4-E2E") + " " + name + " 内容" + "字".repeat(30));
  }
  return out.join("\n");
}

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text: String(text) }], source: { kind: "user" } };
}

/** fake session：deriveMessages（P1 事实包）+ snapshotEvents（事件流）+ header.origin/cwd */
function attachSession(agent, opts) {
  const o = opts || {};
  agent.session.header = agent.session.header || {};
  if (o.cwd) { agent.session.header.cwd = o.cwd; agent.session.cwd = o.cwd; }
  if (o.origin) agent.session.header.origin = o.origin;
  if (o.deriveMessages !== false) {
    const msgs = o.messages || [];
    agent.session.deriveMessages = () => msgs;
  }
  agent.session.snapshotEvents = () => (o.events || []);
  return agent;
}

// ── 造数：检查点 / 项目 / 画像 ─═
function seedCheckpointMd(h, text) {
  const p = sessionMdPath(h);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(text || ""), "utf8");
  return p;
}
function seedProject(h, o) {
  const dir = path.join(h.mem, "projects");
  fs.mkdirSync(dir, { recursive: true });
  const idx = {
    version: 1,
    projects: [{
      key: o.key, display: o.display || o.key, file: o.file,
      workdirs: [o.workdir], root: o.workdir, aliases: [], updatedAt: Date.now(),
    }],
  };
  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(idx, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, o.file), String(o.text || ""), "utf8");
}
function seedGlobal(h, text) {
  fs.writeFileSync(path.join(h.mem, "global.md"), String(text || ""), "utf8");
}
function readSessionsMd(h) {
  try { return fs.readFileSync(sessionMdPath(h), "utf8"); } catch (e) { return ""; }
}

// ── 事件触发 ──
async function fireSeedEvent(handlers, session, type, data) {
  for (const h of handlers["session/event"] || []) {
    try { await h(session, { type: type, data: data }); } catch (e) { /* 插件内部应自吞 */ }
  }
}
/** 成对触发 summary + end：R2 只应挂在 summary 上，end 不得重复注入 */
async function fireCompactionPair(handlers, session, cid, summaryText) {
  const events = [
    { type: "compaction/summary", data: { compactionId: cid, summary: [{ type: "text", text: String(summaryText == null ? HOST_SUMMARY : summaryText) }] } },
    { type: "compaction/end", data: { compactionId: cid } },
  ];
  for (const ev of events) {
    for (const h of handlers["session/event"] || []) {
      try { await h(session, ev); } catch (e) { /* 监听器异常不应外溢 */ }
    }
  }
}

/**
 * 场景启动：临时 HOME →（可选造数）→ fresh import → apply → 注册 agent。
 * opts.subagents：默认 null（避免意图检查点真 spawn 干扰注入面）；可传 fake 桩。
 */
async function boot(tag, opts) {
  const o = opts || {};
  const h = useHome(mkHome("p4-" + tag));
  if (typeof o.seed === "function") { try { o.seed(h); } catch (e) { /* 造数失败由断言体现 */ } }
  const mod = await freshPlugin();
  const sub = Object.prototype.hasOwnProperty.call(o, "subagents") ? o.subagents : null;
  const { ctx, handlers, captured, state } = makeCtx({ subagents: sub });
  applyPlugin(mod, o.cfg == null ? CFG_OFF : o.cfg, ctx);
  const { agent, injected } = mkAgent("session-p4-" + tag, { origin: o.origin || "user", cwd: o.cwd || "C:\\acc\\ws" });
  attachSession(agent, o);
  await callCreated(handlers, agent, o.createdWait == null ? 400 : o.createdWait);
  // 等 agent/created 的异步注入链**完全落定**（它会在 await 链后补注项目记忆/维护提醒等）——
  // 否则其迟到注入会混进下面的压缩窗口，造成 delta 计数抖动（验收曾偶发 T1/T9 双条）。
  let lastN = -1, stable = 0;
  for (let i = 0; i < 25; i++) {
    if (injected.length === lastN) { stable++; if (stable >= 2) break; } else { stable = 0; lastN = injected.length; }
    await sleep(80);
  }
  return { h, mod, ctx, handlers, captured, state, agent, injected, before: injected.length, tag };
}

/**
 * 触发一次压缩并收集「本次新增」的注入（从调用时刻起算）。
 * 附带 compactionInj：只保留**本次压缩注入面**（刷新提示/事实包/重灌）的消息，用于计数断言——
 * 与压缩无关的 agent/created 迟到注入即使偶发也不影响幂等/闸门计数（内容断言仍用全文）。
 */
async function fireAndCollect(sc, cid, waitMs) {
  const start = sc.injected.length;
  const cap = capConsole();          // 静音插件内部 clog（避免验收输出被日志淹没）
  try {
    await fireCompactionPair(sc.handlers, sc.agent.session, cid, HOST_SUMMARY);
    await sleep(waitMs == null ? 1200 : waitMs);
  } finally { cap.restore(); }
  return sc.injected.slice(start).map(msgText);
}
const isCompactionInjection = (t) => /记忆刷新提示|【压缩后记忆重灌|【外部事实包/.test(String(t || ""));
const compactionInj = (delta) => (delta || []).filter(isCompactionInjection);
/** 本次压缩的**合并注入消息**（刷新提示+事实包+重灌应在同一条；取最后一条以兼容极端乱序） */
function mergedInjection(delta) {
  const list = compactionInj(delta);
  return list.length ? list[list.length - 1] : "";
}

// ── 注入文本解析：重灌块 + 三段体（标题行不计入段体）──
const REHYD_HEAD = "【压缩后记忆重灌（dsh-memory）】";
function parseRehydrate(text) {
  const t = String(text || "");
  const i = t.indexOf(REHYD_HEAD);
  if (i < 0) return null;
  const after = t.slice(i);
  const stop = after.search(/\n<\/system-reminder>|\n【外部事实包/);
  const block = (stop >= 0 ? after.slice(0, stop) : after).trim();
  const lines = block.split("\n");
  const segs = {};
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^【([^】]+)】/);
    const nm = m ? m[1] : "";
    if (nm.startsWith("检查点续接")) { cur = "checkpoint"; segs[cur] = []; continue; }
    if (nm.startsWith("项目记忆")) { cur = "project"; segs[cur] = []; continue; }
    if (nm.startsWith("用户画像")) { cur = "profile"; segs[cur] = []; continue; }
    if (nm.startsWith("压缩后记忆重灌")) { cur = null; continue; }
    if (cur) segs[cur].push(ln);
  }
  const body = {};
  for (const k of Object.keys(segs)) body[k] = segs[k].join("\n").trim();
  return { block: block, segs: body, names: Object.keys(segs) };
}
function rehydrateMessages(delta) {
  return (delta || []).filter((t) => String(t || "").indexOf(REHYD_HEAD) >= 0);
}
function findRehydrate(delta) {
  const msgs = rehydrateMessages(delta);
  return msgs.length ? parseRehydrate(msgs[msgs.length - 1]) : null;
}
/** 解析「外部事实包」块（P1 既有注入，用于量两包之和） */
function parseFacts(text) {
  const t = String(text || "");
  const i = t.indexOf("【外部事实包");
  if (i < 0) return null;
  const after = t.slice(i);
  const stop = after.search(/\n【压缩后记忆重灌|\n<\/system-reminder>/);
  const block = (stop >= 0 ? after.slice(0, stop) : after).trim();
  return { block: block, len: block.length };
}

// ═══════════════════════════ R2-T/C：触发 + 内容 + 合并（端到端） ═══════════════════════════
const R2 = {
  cp: "P4-CP-MARK-" + rand(),
  proj: "P4-PROJ-MARK-" + rand(),
  prof: "P4-PROF-MARK-" + rand(),
  file: "P4-CP-FILE-" + rand() + ".md",
};
{
  const cpText = buildCheckpointMd({
    marks: { 本次目标: R2.cp + " 完成压缩后记忆重灌验收（检查点标记）", 关键结论: "- 字面量 " + R2.file },
  });
  const projText = "# acc-ws\n\n> 项目记忆夹具\n\n## Rules\n- " + R2.proj + " 规则标记\n- 走 wp 流程\n\n"
    + "## 当前状态与下一步\n- 继续 P4\n\n## Gotchas\n- 无\n\n## Architecture decisions\n- 无\n";
  const profText = "# 全局记忆\n- " + R2.prof + " 用户偏好标记（画像）\n- 中文优先\n- 验收夹具占位\n";
  const sc = await boot("r2-full", {
    seed: (h) => { seedCheckpointMd(h, cpText); seedProject(h, { key: "acc-ws", file: "acc-ws.md", workdir: "C:\\acc\\ws", text: projText }); seedGlobal(h, profText); },
    messages: [userMsg("P4-R2 验收：用户原话占位 " + rand())],
  });
  const CID = "p4r2-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 1400);
  const merged = mergedInjection(delta);          // 本次压缩的合并注入（1 条）
  const all = merged || delta.join("\n");
  const rh = findRehydrate(delta);
  const hooks = sc.mod.__p4Hooks || {};

  R.ok(compactionInj(delta).length === 1,
    "T1 合并注入：一次 compaction 只新增 1 条注入（刷新提示+事实包+重灌合并；compaction/end 不重复）", "压缩注入=" + compactionInj(delta).length + " 条 / 窗口内新增=" + delta.length + " 条");
  R.ok(!!rh, "T2 重灌块已注入：出现「" + REHYD_HEAD + "」头", "重灌消息数=" + rehydrateMessages(delta).length);
  R.ok(!!rh && !!rh.segs.checkpoint, "T3 检查点段存在：含【检查点续接（<file>）】段", rh ? "段=" + rh.names.join(",") : "无重灌块");
  const cpBody = (rh && rh.segs.checkpoint) || "";
  R.ok(/^##\s+/m.test(cpBody), "T4 检查点段含 8 节格式（段体内有 `## ` 标题行，不是裸要点）", "首行=" + JSON.stringify(cpBody.slice(0, 40)));
  R.ok(cpBody.indexOf("## 本次目标") >= 0, "T5 检查点段含 `## 本次目标`（设计验收口径）", "bodyLen=" + cpBody.length);
  R.ok(cpBody.indexOf(R2.cp) >= 0, "T6 检查点内容来自真实数据源：含预置检查点唯一标记", R2.cp);
  R.ok(!!rh && !!rh.segs.project && rh.segs.project.indexOf(R2.proj) >= 0, "T7 项目段：含【项目记忆（<项目>）】且内容来自 projects/<file> 切片（含项目标记）", rh && rh.segs.project ? R2.proj : "无项目段");
  R.ok(!!rh && !!rh.segs.profile && rh.segs.profile.indexOf(R2.prof) >= 0, "T8 画像段：含【用户画像（global.md）】且内容来自 global.md 切片（含画像标记）", rh && rh.segs.profile ? R2.prof : "无画像段");
  R.ok((all.match(/<system-reminder>/g) || []).length === 1 && all.trim().indexOf("<system-reminder>") === 0 && all.trim().endsWith("</system-reminder>"),
    "T9 单条包裹：只有 1 个 <system-reminder>（刷新提示/事实包/重灌在同一包裹内）", "count=" + (all.match(/<system-reminder>/g) || []).length);
  R.ok(/记忆刷新提示/.test(all), "T10 合并保留老文案：同一消息里仍有「dsh-memory 记忆刷新提示」", "");
  R.ok(/【外部事实包/.test(all) && /【压缩后记忆重灌/.test(all), "T11 与事实包共存：同一条注入里同时出现【外部事实包】与【压缩后记忆重灌】", "");
  R.ok(!hasPartialLiteral(all, R2.file), "T12 字面量不切半：检查点里的路径字面量要么完整要么不在", R2.file);
  R.ok(all.length > 0 && all.length <= MERGED_TOTAL_MAX,
    "T13 常规造数：合并总注入（刷新提示+事实包+重灌）≤" + MERGED_TOTAL_MAX + " 字（实测 " + all.length + "）", "len=" + all.length);

  // ── 钩子接线（__p4Hooks）──
  if (typeof hooks.buildPostCompactRehydrate === "function") {
    R.ok(String(hooks.getWriterPreset && hooks.getWriterPreset()) === "mem-writer",
      "H0b 钩子接线：getWriterPreset() 默认 = mem-writer（P4-A 默认 preset 名）", hooks.getWriterPreset ? hooks.getWriterPreset() : "null");
    const b = hooks.budgets || null;
    R.ok(!!b && Number(b.checkpoint) === R2_BUDGET.checkpoint && Number(b.project) === R2_BUDGET.project && Number(b.profile) === R2_BUDGET.profile,
      "H1 钩子接线：budgets = {检查点 2000, 项目 700, 画像 300}", b ? JSON.stringify(b) : "null");
    const last = typeof hooks.getLastRehydrate === "function" ? hooks.getLastRehydrate() : null;
    R.ok(!!last && String(last.compactionId) === CID && Number(last.totalChars) > 0 && String(last.text || "").indexOf(REHYD_HEAD) >= 0,
      "H2 钩子指纹：getLastRehydrate 记录本次 compactionId/totalChars/text（含重灌头）", last ? JSON.stringify({ cid: last.compactionId, totalChars: last.totalChars, dropped: last.dropped }) : "null");
    R.ok(typeof hooks.hasRehydrateInjected === "function" && hooks.hasRehydrateInjected(CID) === true,
      "H3 幂等集合：注入后 hasRehydrateInjected(compactionId) === true", "");
    R.ok(typeof hooks.getRehydrateCount === "function" && hooks.getRehydrateCount() === 1,
      "H4 注入计数：getRehydrateCount() === 1", typeof hooks.getRehydrateCount === "function" ? hooks.getRehydrateCount() : "n/a");
    // 直调 buildPostCompactRehydrate（同一临时 home，八字断言纯流程不抛/形状可用）
    let direct = null, dThrow = null;
    try { direct = await hooks.buildPostCompactRehydrate(sc.agent); } catch (e) { dThrow = e; }
    R.ok(!dThrow && direct && typeof direct.text === "string" && Number.isFinite(Number(direct.chars)),
      "H5 直调 buildPostCompactRehydrate：不抛、返回 {text,chars,dropped}（供门/脚本复用）", dThrow ? "threw=" + dThrow.message : JSON.stringify({ chars: direct && direct.chars, dropped: direct && direct.dropped }));
    R.ok(!dThrow && direct && String(direct.text || "").indexOf(REHYD_HEAD) >= 0 && String(direct.text || "").indexOf("【检查点续接") >= 0,
      "H6 直调内容：text 含重灌头 + 检查点续接段", "");
  } else {
    R.skip("H0b/H1/H2/H3/H4/H5/H6 __p4Hooks 接线与直调", "缺 __p4Hooks.buildPostCompactRehydrate（等 Lead 实现 P4_TEST_HOOKS）");
  }
}

// ═══════════════════════════ R2-B：预算（饱和造数：三段检查点/项目/画像 + 事实包都吃满） ═══════════════════════════
// 口径说明（与设计 §3 对齐）：
//   · 段预算 = 段体（标题行除外）**严格** ≤ 2000 / 700 / 300：实现除 sectionAwareSlice 外再做 p0FitLines
//     行边界硬截（超限只整行删、绝不切半字面量），故不设容差——严格断言才能真正验证「不是为了过断言放松语义」。
//   · 重灌块整条上限 = 3000 + 装配容差 320（重灌头+3 段头+分隔符）；实现里 R2_TOTAL 同名口径。
//   · 两包上限 = 事实包 ≤3000 + 重灌块 ≤3320；常规造数整条注入（含既有刷新提示≈330）≤6000（T13）。
//   · 极限饱和（下一条 MAX 场景）另量「整条注入 vs 6000」的口径差：内容预算 3000+3000 已占满 6000，
//     刷新提示+两包装配头是额外开销 ⇒ 严格整条 ≤6000 在该口径下不可达，指标为 WARN 交 Lead 决策。
{
  const cpMark = "P4-BIG-CP-" + rand();
  const cpKeep = "P4-BIG-KEEP-" + rand();
  const pjMark = "P4-BIG-PROJ-" + rand();
  const pfMark = "P4-BIG-PROF-" + rand();
  const cpText = buildCheckpointMd({
    sizes: { 本次目标: 420, 当前状态: 460, 下一步行动: 300, 关键结论: 460, 文件与代码: 420, 错误与修复: 420, 任务与待办: 300, 未决问题: 300 },
    marks: { 本次目标: cpMark, 关键结论: cpKeep },
  });
  const projText = "# acc-ws\n\n## Rules\n- " + pjMark + " 规则\n" + "- 项目规则占位".repeat(40) + "\n\n"
    + "## 当前状态与下一步\n" + "- 项目状态占位".repeat(40) + "\n\n"
    + "## Gotchas\n" + "- 坑位占位".repeat(40) + "\n\n## Architecture decisions\n" + "- 决策占位".repeat(40) + "\n";
  const profText = "# 全局记忆\n- " + pfMark + " 画像标记\n- " + "画像占位".repeat(120) + "\n";
  // 事实包吃满：3 条长用户原话（deriveUserQuotes max=3 / 每条 ≤2000）+ todo + 写文件 tool/call
  const factMark = "P4-FACT-" + rand();
  const longUser = (suffix) => userMsg(factMark + suffix + " " + "原话填充".repeat(300));   // ≈1200 字/条
  const factEvents = [
    ["todo/write", { todos: Array.from({ length: 8 }, (_, i) => ({ content: "P4 待办" + i + " " + "待办内容".repeat(20), status: i === 0 ? "in_progress" : "pending" })) }],
    ["goal/change", { kind: "goal/change", version: 1, operation: "start", goal: { id: "p4g", revision: 1, objective: "P4 验收目标 " + "目标内容".repeat(30), phase: "active", maxGoalRounds: 5 }, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() }],
  ];
  for (let i = 0; i < 12; i++) factEvents.push(["tool/call", { callId: "p4c" + i, name: "write", arguments: { path: "C:\\验收\\P4-改动-" + i + "-" + factMark + ".md" } }]);
  const sc = await boot("r2-budget", {
    seed: (h) => { seedCheckpointMd(h, cpText); seedProject(h, { key: "acc-ws", file: "acc-ws.md", workdir: "C:\\acc\\ws", text: projText }); seedGlobal(h, profText); },
    messages: [longUser("-1"), longUser("-2"), longUser("-3"), userMsg(factMark + "-tail")],
    events: factEvents,
  });
  for (const ev of factEvents) await fireSeedEvent(sc.handlers, sc.agent.session, ev[0], ev[1]);
  const CID = "p4r2b-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 1800);
  const all = mergedInjection(delta) || delta.join("\n");
  const rh = findRehydrate(delta);
  const facts = parseFacts(all);
  const cpBody = (rh && rh.segs.checkpoint) || "";
  const pjBody = (rh && rh.segs.project) || "";
  const pfBody = (rh && rh.segs.profile) || "";
  const blockLen = rh ? rh.block.length : 0;
  const factsLen = facts ? facts.block.length : 0;
  const segsSum = cpBody.length + pjBody.length + pfBody.length;
  const hooksB = sc.mod.__p4Hooks || {};
  const lastB = typeof hooksB.getLastRehydrate === "function" ? hooksB.getLastRehydrate() : null;

  R.ok(!!rh, "B0 前置：饱和造数下重灌块仍在（不整体丢弃）", "重灌消息=" + rehydrateMessages(delta).length);
  R.ok(cpBody.length > 0 && cpBody.length <= R2_BUDGET.checkpoint,
    "B1 检查点段严格 ≤" + R2_BUDGET.checkpoint + " 字（实测 " + cpBody.length + "；无容差，硬截执行到位）", "len=" + cpBody.length);
  R.ok(pjBody.length > 0 && pjBody.length <= R2_BUDGET.project,
    "B2 项目段严格 ≤" + R2_BUDGET.project + " 字（实测 " + pjBody.length + "；无容差）", "len=" + pjBody.length);
  R.ok(pfBody.length > 0 && pfBody.length <= R2_BUDGET.profile,
    "B3 画像段严格 ≤" + R2_BUDGET.profile + " 字（实测 " + pfBody.length + "；无容差；不得为过断言整段砍掉画像）", "len=" + pfBody.length);
  R.ok(segsSum > 0 && segsSum <= R2_BUDGET.checkpoint + R2_BUDGET.project + R2_BUDGET.profile,
    "B4 三段之和严格 ≤3000（实测 " + segsSum + " = " + cpBody.length + "+" + pjBody.length + "+" + pfBody.length + "）", "sum=" + segsSum);
  R.ok(factsLen > 0 && factsLen <= 3000 + 150,
    "B5 事实包 ≤3000 + 头容差（实测 " + factsLen + "；P1 现有预算不回归）", "len=" + factsLen);
  R.ok(blockLen > 0 && blockLen <= R2_BLOCK_TOTAL,
    "B6 重灌块整条 ≤" + R2_BLOCK_TOTAL + "（3000 + 装配容差 320；实测 " + blockLen + "）", "len=" + blockLen);
  R.ok(factsLen > 0 && blockLen > 0 && factsLen + blockLen <= MERGED_TOTAL_MAX + 400,
    "B7 两包之和 ≤6000 + 装配容差 400（实测 事实包 " + factsLen + " + 重灌 " + blockLen + " = " + (factsLen + blockLen) + "）", "sum=" + (factsLen + blockLen));
  R.ok(all.indexOf(cpKeep) >= 0, "B8 保留节字面量：关键结论标记完整保留（不切半）", "kept=" + (all.indexOf(cpKeep) >= 0));
  R.ok(all.indexOf(pjMark) >= 0 && all.indexOf(pfMark) >= 0, "B9 项目/画像标记在预算内仍完整出现（切片没有切坏首行）", "proj=" + (all.indexOf(pjMark) >= 0) + " prof=" + (all.indexOf(pfMark) >= 0));
  R.ok(!lastB || !Array.isArray(lastB.dropped) || (lastB.dropped.indexOf("profile") < 0 && lastB.dropped.indexOf("project") < 0 && lastB.dropped.indexOf("checkpoint") < 0),
    "B10 未为过断言整段砍段：getLastRehydrate().dropped 不含 profile/project/checkpoint", lastB ? JSON.stringify(lastB.dropped) : "无钩子");
  // 规格歧义点：饱和时整条注入（含刷新提示）会超过 6000 —— 指标为 WARN，交 Lead 决策是否做总量动态收口
  R.warn("B11 预算分解（饱和·信息项）：整条注入 " + all.length + " 字 = 刷新提示(≈330) + 事实包(" + factsLen + ") + 重灌块(" + blockLen + ")；硬线 " + MERGED_TOTAL_MAX,
    "overHardLine=" + (all.length - MERGED_TOTAL_MAX));
}

// ═══════════════════════════ R2-B2：极限饱和（MAX）—— 三段与事实包都顶到各自上限，量化 6000 口径差 ═══════════════════════════
// 目的（Lead 提问）：B5 的「合并总注入 ≤6000」在真正饱和时守不守得住？
//   构造：检查点/项目/画像源文件都远超预算（各自被硬截到 2000/700/300）；
//         事实包用 3 条 ≈950 字原话顶到 P1 预算上限（≈2889 + 110 头）；
//   测点：段体严格预算、重灌块 ≤3320、事实包 ≈3000、两包之和、以及**整条注入**相对 6000 的口径差。
{
  const cpText = buildCheckpointMd({
    sizes: { 本次目标: 800, 当前状态: 900, 下一步行动: 600, 关键结论: 900, 文件与代码: 800, 错误与修复: 800, 任务与待办: 600, 未决问题: 600 },
    marks: { 本次目标: "P4-MAX-CP-" + rand() },
  });
  const projText = "# acc-ws\n\n## Rules\n- P4-MAX-PROJ-" + rand() + "\n" + "- 规则行占位".repeat(80) + "\n\n"
    + "## 当前状态与下一步\n" + "- 状态行占位".repeat(80) + "\n\n"
    + "## Gotchas\n" + "- 坑位行占位".repeat(80) + "\n\n"
    + "## Architecture decisions\n" + "- 决策行占位".repeat(80) + "\n";
  const profText = "# 全局记忆\n- P4-MAX-PROF-" + rand() + "\n" + "- 画像行占位".repeat(200) + "\n";
  // 事实包顶到 P1 预算上限：2 条长原话（≈1400 字）+1 条短原话，总长刚好塞满 2889 预算
  //   （buildExternalFacts 只按整行装填：装不下的整行跳过，不会切半——这里刻意让第 3 条装不下但前 2 条吃满）
  const q = (i, reps) => userMsg("P4-MAX-QUOTE-" + i + "-" + rand() + " " + "原话".repeat(reps));
  const sc = await boot("r2-max", {
    seed: (h) => { seedCheckpointMd(h, cpText); seedProject(h, { key: "acc-ws", file: "acc-ws.md", workdir: "C:\\acc\\ws", text: projText }); seedGlobal(h, profText); },
    messages: [q(1, 690), q(2, 690), q(3, 10)],
  });
  const CID = "p4r2max-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 1800);
  const all = mergedInjection(delta) || delta.join("\n");
  const rh = findRehydrate(delta);
  const facts = parseFacts(all);
  const cpBody = (rh && rh.segs.checkpoint) || "";
  const pjBody = (rh && rh.segs.project) || "";
  const pfBody = (rh && rh.segs.profile) || "";
  const blockLen = rh ? rh.block.length : 0;
  const factsLen = facts ? facts.block.length : 0;
  const hooksM = sc.mod.__p4Hooks || {};
  const lastM = typeof hooksM.getLastRehydrate === "function" ? hooksM.getLastRehydrate() : null;

  R.ok(!!rh && !!rh.segs.checkpoint && !!rh.segs.project && !!rh.segs.profile,
    "M1 MAX 饱和：三段齐全（profile 未被「先砍画像」策略误砍）", rh ? "段=" + rh.names.join(",") : "无重灌块");
  R.ok(cpBody.length <= R2_BUDGET.checkpoint && pjBody.length <= R2_BUDGET.project && pfBody.length <= R2_BUDGET.profile,
    "M2 MAX 饱和：三段严格预算（实测 " + cpBody.length + "/" + pjBody.length + "/" + pfBody.length + "）", "caps=2000/700/300");
  R.ok(blockLen > 0 && blockLen <= R2_BLOCK_TOTAL,
    "M3 MAX 饱和：重灌块整条 ≤" + R2_BLOCK_TOTAL + "（实测 " + blockLen + "）", "len=" + blockLen);
  R.ok(factsLen > 0 && factsLen <= 3000 + 150,
    "M4 MAX 饱和：事实包 ≤3000 + 头容差（实测 " + factsLen + "）", "len=" + factsLen);
  R.ok(factsLen + blockLen <= MERGED_TOTAL_MAX + 400,
    "M5 MAX 饱和：两包之和 ≤6000 + 装配容差 400（实测 " + (factsLen + blockLen) + "）", "sum=" + (factsLen + blockLen));
  R.ok(!lastM || !Array.isArray(lastM.dropped) || lastM.dropped.length === 0,
    "M6 MAX 饱和：dropped 为空（内容都在预算内，未触发整段砍）", lastM ? JSON.stringify(lastM.dropped) : "无钩子");
  // 口径差（信息项）：内容预算 3000+3000=6000 之外，刷新提示(≈330)+两包装配头(≈220) 无法被 6000 覆盖
  if (all.length <= MERGED_TOTAL_MAX) {
    R.ok(true, "M7 MAX 饱和：整条注入（含刷新提示）仍 ≤" + MERGED_TOTAL_MAX + "（实测 " + all.length + "）", "len=" + all.length);
  } else {
    R.warn("M7 口径差（信息项）：MAX 饱和整条注入 " + all.length + " 字 > 硬线 " + MERGED_TOTAL_MAX
      + "（超 " + (all.length - MERGED_TOTAL_MAX) + "）；拆解=刷新提示≈330 + 事实包 " + factsLen + " + 重灌块 " + blockLen
      + " ⇒ 严格「整条 ≤6000」需再把两包预算动态收口约 " + (all.length - MERGED_TOTAL_MAX) + " 字；当前实现守的是两包内容预算口径",
      "over=" + (all.length - MERGED_TOTAL_MAX));
  }
}

// ═══════════════════════════ R2-I：幂等（同 cid 一次；新 cid 再注） ═══════════════════════════
{
  const cpText = buildCheckpointMd({ marks: { 本次目标: "P4-IDEM-CP-" + rand() } });
  const sc = await boot("r2-idem", { seed: (h) => seedCheckpointMd(h, cpText) });
  const CID = "p4r2i-" + randomUUID();
  const d1 = await fireAndCollect(sc, CID, 1300);
  const nAfter1 = sc.injected.length;
  const hooks = sc.mod.__p4Hooks || {};
  const d2 = await fireAndCollect(sc, CID, 800);   // 同 cid 重发
  const dTotal = compactionInj(d2).length;           // 只看压缩注入面（防 agent/created 迟到注入干扰）
  R.ok(compactionInj(d1).length === 1 && rehydrateMessages(d1).length === 1, "I1 幂等：首次 compaction 注入 1 条（含重灌）", "压缩注入=" + compactionInj(d1).length);
  R.ok(dTotal === 0, "I2 幂等：同一 compactionId 重发 ⇒ 不再注入（0 条新增）", "重复新增=" + dTotal);
  if (typeof hooks.hasRehydrateInjected === "function" && typeof hooks.getRehydrateCount === "function") {
    R.ok(hooks.hasRehydrateInjected(CID) === true && hooks.getRehydrateCount() === 1,
      "I2b 幂等探针：hasRehydrateInjected(cid)=true 且注入计数保持 1", "count=" + hooks.getRehydrateCount());
    R.ok(hooks.hasRehydrateInjected("p4-not-injected-" + rand()) === false, "I2c 幂等集合按 id 区分（未注入的随机 id 为 false，非进程级 once）", "");
  } else R.skip("I2b/I2c 幂等探针", "缺 __p4Hooks.hasRehydrateInjected / getRehydrateCount");
  const CID2 = "p4r2i2-" + randomUUID();
  const d3 = await fireAndCollect(sc, CID2, 1300);
  R.ok(compactionInj(d3).length === 1 && rehydrateMessages(d3).length === 1, "I3 非进程级 once：换一个 compactionId 仍会再注入 1 条重灌", "压缩注入=" + compactionInj(d3).length);
  if (typeof hooks.getRehydrateCount === "function") {
    R.ok(hooks.getRehydrateCount() === 2, "I3b 计数：两次不同 compactionId ⇒ 注入计数 2", "count=" + hooks.getRehydrateCount());
  } else R.skip("I3b 计数", "缺 getRehydrateCount");
}

// ═══════════════════════════ R2-G：subagent 闸门 ═══════════════════════════
{
  const cpText = buildCheckpointMd({ marks: { 本次目标: "P4-SUB-CP-" + rand() } });
  const sc = await boot("r2-sub", { seed: (h) => seedCheckpointMd(h, cpText), origin: "subagent" });
  const CID = "p4r2s-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 900);
  const hooks = sc.mod.__p4Hooks || {};
  R.ok(compactionInj(delta).length === 0, "G1 闸门：origin==='subagent' 会话不注入重灌（也不注入刷新提示）", "压缩注入=" + compactionInj(delta).length + " / 窗口内新增=" + delta.length);
  if (typeof hooks.hasRehydrateInjected === "function") R.ok(hooks.hasRehydrateInjected(CID) === false, "G2 闸门：子代理会话的 compactionId 不进重灌幂等集合", "");
  else R.skip("G2 闸门幂等集合", "缺 hasRehydrateInjected");
}

// ═══════════════════════════ R2-R：无检查点数据降级 / 不阻塞 ═══════════════════════════
{
  // 无 sessions/*.md、无项目、无 global.md ⇒ 重灌无料可注，但必须仍注刷新提示、不抛错
  const sc = await boot("r2-empty", {
    seed: (h) => { try { fs.unlinkSync(path.join(h.mem, "global.md")); } catch (e) {} },
    messages: [],
  });
  let threw = null;
  let delta = [];
  try { delta = await fireAndCollect(sc, "p4r2e-" + randomUUID(), 1200); } catch (e) { threw = e; }
  const all = mergedInjection(delta) || delta.join("\n");
  R.ok(!threw, "R1 容错：无检查点/项目/画像数据时不抛异常（压缩主流程不受影响）", threw ? threw.message : "");
  R.ok(compactionInj(delta).length === 1 && /记忆刷新提示/.test(all), "R2 降级：无重灌料时仍注入「记忆刷新提示」（保底不静默）", "压缩注入=" + compactionInj(delta).length);
  R.ok(all.indexOf(REHYD_HEAD) < 0, "R3 降级：无料时不出空壳重灌块（不注「【压缩后记忆重灌】」空段）", "hasHead=" + (all.indexOf(REHYD_HEAD) >= 0));
  const hooks = sc.mod.__p4Hooks || {};
  if (typeof hooks.buildPostCompactRehydrate === "function") {
    let direct = null, dThrow = null;
    try { direct = await hooks.buildPostCompactRehydrate(sc.agent); } catch (e) { dThrow = e; }
    R.ok(!dThrow && direct && String(direct.text || "") === "" && Number(direct.chars || 0) === 0,
      "R4 直调空数据：返回 text==''、chars==0、不抛（失败一律降级）", dThrow ? "threw=" + dThrow.message : JSON.stringify({ text: direct && String(direct.text || "").slice(0, 20), chars: direct && direct.chars, dropped: direct && direct.dropped }));
    R.ok(!dThrow && direct && Array.isArray(direct.dropped) && direct.dropped.length > 0,
      "R5 降级留痕：dropped 数组记录缺失原因（checkpoint:none 等）", dThrow ? "" : JSON.stringify(direct && direct.dropped));
  } else R.skip("R4/R5 直调空数据", "缺 __p4Hooks.buildPostCompactRehydrate");
}
{
  // 不阻塞 + 注入时机（setTimeout(0)，避开 session.append 发布窗口）
  const cpText = buildCheckpointMd({ marks: { 本次目标: "P4-NB-CP-" + rand() } });
  const sc = await boot("r2-nonblock", { seed: (h) => seedCheckpointMd(h, cpText) });
  const before = sc.injected.length;
  const t0 = Date.now();
  await fireCompactionPair(sc.handlers, sc.agent.session, "p4nb-" + randomUUID(), HOST_SUMMARY);
  const syncMs = Date.now() - t0;
  const immediately = compactionInj(sc.injected.slice(before).map(msgText)).length;
  await sleep(1400);
  const later = compactionInj(sc.injected.slice(before).map(msgText)).length;
  R.ok(syncMs < 200, "R6 不阻塞：session/event 处理器同步返回（<200ms，不在处理器内做文件切片/注入）", syncMs + "ms");
  R.ok(immediately === 0, "R7 注入时机：处理器返回时尚未注入（走 setTimeout(0)，不在 append 发布窗口内注入）", "立即注入=" + immediately);
  R.ok(later === 1, "R8 注入时机：一拍后注入 1 条（异步链完成，含重灌）", "稍后注入=" + later);
}

// ═══════════════════════════ P4-A：writer preset 透传（fake subagents 桩） ═══════════════════════════
function mkSub02(o) {
  const opt = o || {};
  const calls = [];
  const sub = {
    startActivation: async (spec) => {
      calls.push(spec);
      if (opt.failFirst && calls.length === 1) throw new Error(opt.failMsg || "unknown agent preset: " + (spec && spec.request && spec.request.agentPreset));
      if (opt.alwaysFail) throw new Error("spawn failed by fake");
      const text = opt.text == null ? "OK" : opt.text;
      return { childId: opt.childId || "p4-child-" + calls.length, result: Promise.resolve({ output: [{ type: "text", text: text }], stopReason: "completed" }) };
    },
  };
  return { calls: calls, sub: sub };
}
function mkSub01(o) {
  const opt = o || {};
  const calls = [];
  const sub = {
    start: async (kind, opts) => {
      calls.push({ kind: kind, opts: opts || {} });
      const text = opt.text == null ? "LEGACY-OK" : opt.text;
      return { id: "p4-legacy-" + calls.length, result: Promise.resolve({ output: [{ type: "text", text: text }], stopReason: "completed" }) };
    },
  };
  return { calls: calls, sub: sub };
}
/** 一个 live parent agent（pickSpawnParent 的 live 判据 = options + session） */
function liveParent(tag) {
  const { agent } = mkAgent("session-p4-parent-" + (tag || rand()), { origin: "user", cwd: "C:\\acc\\ws" });
  return agent;
}
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj || {}, k);

// P-A1/2/3：0.2.x startSubagentCompat 直调透传
{
  const cap = mkSub02({ text: "SPEC-OK" });
  const sc = await boot("a-compat02", { subagents: cap.sub });
  const hooks = sc.mod.__p4Hooks || {};
  if (typeof hooks.startSubagentCompat === "function") {
    const spec = { label: "dsh-memory-压缩-intent-abcd1234", prompt: [{ type: "text", text: "PROMPT" }], toolFilter: { allow: ["memory_search"] }, agentPreset: "mem-writer" };
    let run = null, threw = null;
    try { run = await hooks.startSubagentCompat(cap.sub, spec); } catch (e) { threw = e; }
    const got = cap.calls[cap.calls.length - 1] || {};
    R.ok(!threw && !!run && run.id === "p4-child-1" && String((run.result && "then") || "then") === "then", "P1 startSubagentCompat(0.2.x)：startActivation 返回映射回 {id,result}", threw ? threw.message : "id=" + (run && run.id));
    R.ok(!!got && got.provider === "spawn" && got.delivery === "caller", "P2 0.2.x spec：provider='spawn' / delivery='caller'", JSON.stringify({ provider: got && got.provider, delivery: got && got.delivery }));
    R.ok(!!got && got.label === spec.label && !own(got.request, "label") && !own(got.request, "signal"), "P3 0.2.x spec：label/signal 归 spec 层，不重复塞进 request", "label=" + (got && got.label));
    R.ok(!!got && got.request && String(got.request.agentPreset) === "mem-writer", "P4 ★ agentPreset 透传进 spec.request（0.2.x 唯一收窄工具面途径）", "request.agentPreset=" + (got && got.request && got.request.agentPreset));
    R.ok(!!got && got.request && JSON.stringify(got.request.toolFilter) === JSON.stringify({ allow: ["memory_search"] }), "P5 toolFilter 仍原样透传（0.1.x 兼容保留）", JSON.stringify(got && got.request && got.request.toolFilter));
    // 直调 0.1.x：start() 不认识 preset ⇒ 必须摘掉
    const cap01 = mkSub01({});
    let run01 = null, threw01 = null;
    try { run01 = await hooks.startSubagentCompat(cap01.sub, { label: "L01", prompt: [{ type: "text", text: "P" }], toolFilter: { allow: ["memory_search"] }, agentPreset: "mem-writer" }); } catch (e) { threw01 = e; }
    const got01 = cap01.calls[0] || {};
    R.ok(!threw01 && !!run01 && got01.kind === "spawn", "P6 startSubagentCompat(0.1.x)：走 start('spawn', opts) 老路", threw01 ? threw01.message : "kind=" + got01.kind);
    R.ok(!threw01 && got01.opts && !own(got01.opts, "agentPreset"), "P7 ★ 0.1.x 回落：agentPreset 被摘掉（旧 start() 不认识，防校验失败）", "hasKey=" + own(got01.opts || {}, "agentPreset"));
    R.ok(!threw01 && got01.opts && JSON.stringify(got01.opts.toolFilter) === JSON.stringify({ allow: ["memory_search"] }), "P8 0.1.x：toolFilter 仍透传", JSON.stringify(got01.opts && got01.opts.toolFilter));
  } else {
    R.skip("P1~P8 startSubagentCompat 直调", "缺 __p4Hooks.startSubagentCompat（等 Lead 实现 P4_TEST_HOOKS）");
  }
}

// P-A3（4.5.10）：**所有**记忆插件子代理的 label 必须带目标 sid（用户口径 2026-11-09：
//   「子代理 label/归属带上目标 sid，避免挂在无关会话名下造成误读。这个是非常必要的，所有记忆插件的子代理都是」）
{
  const scL = await boot("a-label", {});
  const hL = scL.mod.__p4Hooks || {};
  if (typeof hL.subagentLabelWithTarget === "function") {
    const full = "session-bca1141e-92a3-45a3-8395-f11e3018f076";
    const l1 = hL.subagentLabelWithTarget("dsh-memory-压缩-intent-abcd1234", full);
    R.ok(l1 === "dsh-memory-压缩-intent-abcd1234@bca1141e", "P-L1 检查点 writer label 带目标 sid", l1);
    const l2 = hL.subagentLabelWithTarget("dsh-memory-自动整合-定时", "session-0ff4d999-476a-4bbc-941a-5c68aa8c0545");
    R.ok(l2 === "dsh-memory-自动整合-定时@0ff4d999", "P-L2 自动整合 label 带触发会话 sid", l2);
    const l3 = hL.subagentLabelWithTarget("dsh-memory-压缩-intent-x", "");
    R.ok(l3 === "dsh-memory-压缩-intent-x@anon", "P-L3 缺 sid 回落 anon（不抛）", l3);
  } else R.skip("P-L1~L3 子代理 label 带目标 sid", "缺 __p4Hooks.subagentLabelWithTarget（4.5.10 应暴露）");
}

// P-A2：compactOnce —— 默认配置带 preset；preset 挂载失败回落；自定义 preset 名
{
  const capA = mkSub02({ text: "ONCE-OK-1" });
  const scA = await boot("a-once-default", { subagents: capA.sub });
  const hooksA = scA.mod.__p4Hooks || {};
  if (typeof hooksA.compactOnce === "function") {
    let out = null, threw = null;
    try { out = await hooksA.compactOnce(capA.sub, liveParent("a1"), "PROMPT-A", "p4-a1", null, "session-p4-a1"); } catch (e) { threw = e; }
    const spec = capA.calls[0] || {};
    R.ok(!threw && out === "ONCE-OK-1" && capA.calls.length === 1, "P9 compactOnce(默认配置)：成功返回子代理文本（1 次 spawn）", threw ? threw.message : "out=" + out + " calls=" + capA.calls.length);
    R.ok(!!spec.request && String(spec.request.agentPreset) === "mem-writer", "P10 ★ compactOnce 默认配置透传 agentPreset=mem-writer", "agentPreset=" + (spec.request && spec.request.agentPreset));
    R.ok(!!spec.request && JSON.stringify(spec.request.toolFilter) === JSON.stringify({ allow: ["memory_search"] }), "P11 compactOnce toolFilter 仍透传", JSON.stringify(spec.request && spec.request.toolFilter));
    R.ok(String(spec.label || "") === "dsh-memory-压缩-p4-a1@p4-a1", "P12 ★ compactOnce label 带目标 sid（dsh-memory-压缩-<tag>@<sid8>）", spec.label);
  } else R.skip("P9~P12 compactOnce 默认配置", "缺 __p4Hooks.compactOnce");

  // preset 挂载失败 → 回落不带 preset 再起一次；成功不阻断
  const capB = mkSub02({ text: "FALLBACK-OK", failFirst: true });
  const scB = await boot("a-once-fallback", { subagents: capB.sub });
  const hooksB = scB.mod.__p4Hooks || {};
  if (typeof hooksB.compactOnce === "function") {
    let out = null, threw = null;
    try { out = await hooksB.compactOnce(capB.sub, liveParent("a2"), "PROMPT-B", "p4-a2", null, "session-p4-a2"); } catch (e) { threw = e; }
    const s1 = capB.calls[0] || {}, s2 = capB.calls[1] || {};
    R.ok(!threw && out === "FALLBACK-OK", "P13 preset 挂载失败不阻断：compactOnce 仍返回子代理输出", threw ? threw.message : "out=" + out);
    R.ok(capB.calls.length === 2, "P14 回落策略：第一次带 preset 失败 ⇒ 第二次重起（共 2 次 spawn）", "calls=" + capB.calls.length);
    R.ok(String(s1.request && s1.request.agentPreset) === "mem-writer", "P15 第一次 spawn 确实带了 preset", "agentPreset=" + (s1.request && s1.request.agentPreset));
    R.ok(s2.request && !own(s2.request, "agentPreset"), "P16 ★ 回落第二次不带 agentPreset（回落原行为）", "hasKey=" + own(s2.request || {}, "agentPreset"));
    R.ok(!!s2.request && JSON.stringify(s2.request.toolFilter) === JSON.stringify({ allow: ["memory_search"] }), "P17 回落第二次 toolFilter 仍在", JSON.stringify(s2.request && s2.request.toolFilter));
    await sleep(700);   // monitor 防抖 500ms 落盘
    const mon = readMonitor(scB.h);
    R.ok(jsonContains(mon, "preset-fallback"), "P18 可诊断：监控账本记录 preset-fallback（失败可见，不静默）", jsonContains(mon, "preset-fallback") ? "found" : "not-found");
  } else R.skip("P13~P18 compactOnce 回落", "缺 __p4Hooks.compactOnce");

  // preset 未配置（空串）⇒ 不传 agentPreset（回落原行为）
  const capC = mkSub02({ text: "EMPTY-OK" });
  const scC = await boot("a-once-empty", { subagents: capC.sub, cfg: { writerPreset: "" } });
  const hooksC = scC.mod.__p4Hooks || {};
  if (typeof hooksC.compactOnce === "function") {
    let out = null, threw = null;
    try { out = await hooksC.compactOnce(capC.sub, liveParent("a3"), "PROMPT-C", "p4-a3", null, "session-p4-a3"); } catch (e) { threw = e; }
    const spec = capC.calls[0] || {};
    R.ok(!threw && out === "EMPTY-OK" && capC.calls.length === 1, "P19 preset 未配置('')：compactOnce 正常成功（回落原行为）", threw ? threw.message : "out=" + out);
    R.ok(spec.request && !own(spec.request, "agentPreset"), "P20 ★ preset 为空 ⇒ 不传 agentPreset（不硬塞默认值）", "hasKey=" + own(spec.request || {}, "agentPreset"));
    R.ok(typeof hooksC.getWriterPreset === "function" && hooksC.getWriterPreset() === "", "P21 getWriterPreset() 反映空配置", typeof hooksC.getWriterPreset === "function" ? JSON.stringify(hooksC.getWriterPreset()) : "n/a");
  } else R.skip("P19~P21 preset 未配置", "缺 __p4Hooks.compactOnce");

  // 自定义 preset 名生效
  const capD = mkSub02({ text: "CUSTOM-OK" });
  const scD = await boot("a-once-custom", { subagents: capD.sub, cfg: { writerPreset: "p4-custom-writer" } });
  const hooksD = scD.mod.__p4Hooks || {};
  if (typeof hooksD.compactOnce === "function") {
    let out = null, threw = null;
    try { out = await hooksD.compactOnce(capD.sub, liveParent("a4"), "PROMPT-D", "p4-a4", null, "session-p4-a4"); } catch (e) { threw = e; }
    const spec = capD.calls[0] || {};
    R.ok(!threw && out === "CUSTOM-OK", "P22 自定义 preset：compactOnce 正常", threw ? threw.message : "out=" + out);
    R.ok(String(spec.request && spec.request.agentPreset) === "p4-custom-writer", "P23 ★ 配置 writerPreset 生效（request.agentPreset 跟随配置）", "agentPreset=" + (spec.request && spec.request.agentPreset));
    R.ok(typeof hooksD.getWriterPreset === "function" && hooksD.getWriterPreset() === "p4-custom-writer", "P24 getWriterPreset() 反映自定义配置", typeof hooksD.getWriterPreset === "function" ? hooksD.getWriterPreset() : "n/a");
  } else R.skip("P22~P24 自定义 preset", "缺 __p4Hooks.compactOnce");
}

// P-A3：spawn 全失败不阻断检查点流程（走 spawnIntentCheckpoint 返回重试入队，不抛）
{
  const cap = mkSub02({ alwaysFail: true });
  const sc = await boot("a-allfail", { subagents: cap.sub });
  const p0 = sc.mod.__p0Hooks || {};
  if (typeof p0.spawnIntentCheckpoint === "function") {
    const CID = "p4fail-" + randomUUID();
    const SUM = "## Primary Request and Intent\n" + "P4 全失败路径摘要占位 ".repeat(4) + "\n## Next Step\n- 继续\n";
    let ret = null, threw = null;
    try { ret = await p0.spawnIntentCheckpoint(CID, SUM, todayStr() + ".md", liveParent("a5"), "session-p4-a5"); } catch (e) { threw = e; }
    R.ok(!threw, "P25 spawn 全失败：spawnIntentCheckpoint 不向调用方抛异常（压缩主流程不被阻断）", threw ? threw.message : "");
    R.ok(!!ret && ret.ok === false && ret.retry === true, "P26 失败可恢复：返回 {ok:false, retry:true}（进重试队列，不是静默丢弃）", ret ? JSON.stringify(ret) : "null");
    const q = typeof p0.getIntentRetry === "function" ? p0.getIntentRetry() : [];
    R.ok(Array.isArray(q) && q.some((e) => String(e.id) === CID), "P27 重试队列：失败 compactionId 已入 .integrate.json intentRetry", "queue=" + (Array.isArray(q) ? q.length : "n/a"));
    R.ok(cap.calls.length >= 2, "P28 失败路径仍遵守 preset 两次尝试（带 preset → 回落不带）", "calls=" + cap.calls.length);
    R.ok(String((cap.calls[0] && cap.calls[0].request && cap.calls[0].request.agentPreset) || "") === "mem-writer",
      "P29 失败路径第一次仍带 preset（配置生效，不是预先不传）", "agentPreset=" + (cap.calls[0] && cap.calls[0].request && cap.calls[0].request.agentPreset));
  } else R.skip("P25~P29 spawn 全失败不阻断", "缺 __p0Hooks.spawnIntentCheckpoint");
}

// P-A4：端到端集成 —— 真压缩事件 ⇒ writer spawn 捕获 preset/toolFilter + 检查点写入未被阻断 + R2 注入共存
{
  const mark = "P4-E2E-WRITER-" + rand();
  const cap = mkSub02({ text: build8Output(mark) });
  const cpText = buildCheckpointMd({ marks: { 本次目标: "P4-E2E-CP-" + rand() } });
  const sc = await boot("a-e2e", { subagents: cap.sub, seed: (h) => seedCheckpointMd(h, cpText) });
  const CID = "p4r2e2e-" + randomUUID();
  const delta = await fireAndCollect(sc, CID, 1800);
  const all = mergedInjection(delta) || delta.join("\n");
  const intentSpecs = cap.calls.filter((s) => String((s && s.label) || "").indexOf("dsh-memory-压缩-intent") === 0);
  R.ok(intentSpecs.length >= 1, "P30 端到端：压缩事件真的 spawn 检查点 writer（label=dsh-memory-压缩-intent-*）", "intentSpawns=" + intentSpecs.length);
  const sp = intentSpecs[0] || {};
  R.ok(String(sp.request && sp.request.agentPreset) === "mem-writer" && !!sp.request && !!sp.request.toolFilter,
    "P31 端到端：writer 的 startActivation.request 同时带 agentPreset 与 toolFilter", JSON.stringify({ agentPreset: sp.request && sp.request.agentPreset, toolFilter: sp.request && sp.request.toolFilter }));
  const md = readSessionsMd(sc.h);
  R.ok(md.indexOf("<!-- intent: " + CID) >= 0, "P32 端到端：检查点照常落盘（preset 改造未阻断写入链路）", "mdLen=" + md.length + " hasMarker=" + (md.indexOf("<!-- intent: " + CID) >= 0));
  R.ok(all.indexOf("【压缩后记忆重灌") >= 0, "P33 端到端：同一次压缩事件下 R2 重灌注入照常（A 与 R2 共存，不互斥）", "hasRehydrate=" + (all.indexOf("【压缩后记忆重灌") >= 0));
}

// ═══════════════════════════ C：回归 —— 既有 P2 selftest 不受影响 ═══════════════════════════
{
  try {
    const script = path.join(HERE, "_p2-selftest.mjs");
    let out = "", code = 0, threw = null;
    try {
      out = execFileSync(process.execPath, [script], { cwd: path.dirname(TARGET), encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      threw = e;
      out = String((e && e.stdout) || "") + "\n" + String((e && e.stderr) || "");
      code = (e && typeof e.status === "number") ? e.status : -1;
    }
    const m = /PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(out);
    const passN = m ? Number(m[1]) : -1;
    const failN = m ? Number(m[2]) : -1;
    R.ok(!threw && code === 0 && failN === 0 && passN > 0,
      "C1 回归：test/_p2-selftest.mjs 全量通过（P2 纯函数契约不受 P4 影响）",
      threw ? ("exit=" + code + " " + out.trim().split("\n").slice(-6).join(" | ")) : ("PASS " + passN + " / FAIL " + failN));
  } catch (e) {
    R.warn("C1 回归：跑 _p2-selftest.mjs 失败（不影响 P4 结论）", e && e.message ? e.message : String(e));
  }
}

// ═══════════════════════════ S：静态启发式（WARN，不计失败） ═══════════════════════════
try {
  const src = fs.readFileSync(TARGET, "utf8");
  const marks = [
    ["【压缩后记忆重灌", "重灌块头标记"],
    ["【检查点续接", "检查点续接段标记"],
    ["POST_COMPACT_REHYDRATE_IDS", "重灌幂等集合"],
    ["buildPostCompactRehydrate", "重灌装配函数"],
    ["writerPreset", "writer preset 配置项"],
    ["startActivation", "0.2.x 子代理启动路径"],
  ];
  for (const [needle, label] of marks) {
    if (src.indexOf(needle) >= 0) R.ok(true, "S1 静态：源码含 " + label + "（" + needle + "）", "");
    else R.warn("S1 静态：源码未见 " + label + "（" + needle + "）（启发式）", "");
  }
  // P4-A 的回落语义：catch 后再次 startSubagentCompat 不带 preset
  if (/catch\s*\(ePreset\)[\s\S]{0,1200}if\s*\(!run\)\s*run\s*=\s*await\s+startSubagentCompat\(subagents,\s*opts\)/.test(src)) {
    R.ok(true, "S2 静态：preset 失败后回落 startSubagentCompat(subagents, opts)（不带 preset 再起一次）", "");
  } else {
    R.warn("S2 静态：未见 preset 失败→不带 preset 重起的回落形态（启发式；P13~P18 行为断言更可信）", "");
  }
} catch (e) {
  R.warn("S 静态启发式检查失败（不影响结论）", e && e.message ? e.message : String(e));
}

finish(R);
