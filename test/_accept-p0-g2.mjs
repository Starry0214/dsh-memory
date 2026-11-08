// _accept-p0-g2.mjs — P0-1（G2）独立验收：注入端「先读主题库检查点，再回落 sessions/*.md」
//
// 背景（.task/1101-dsh-mimo-survey/02-plugin-status.md G2，已实测）：
//   flag=memoryTopicDbEnabled:true 时检查点写进 mem.db 的 D8「会话检查点」线且**不写 md**；
//   而注入端 latestSessionSummary() 只读 sessions/<YYYY-MM-DD>.md ⇒ 检查点永远注不进下一个会话。
//
// 验收断言（可执行）：
//   A 库有「今日」检查点 + sessions/ 为空  ⇒ agent/created 注入面必须出现【最近一次会话压缩点】且正文含库内唯一标记
//                                            （改前：无摘要注入 ⇒ FAIL；改后：PASS）
//   B 库空 + md 有当日摘要                ⇒ 仍注入 md 正文（老行为不回归；改前改后都应 PASS）
//   C 库空 + md 空                        ⇒ 不注入摘要（不虚构；改前改后都应 PASS）
//   D 库只有「昨日」检查点 + sessions/ 空  ⇒ 保留「非当日一行」语义：一行「停在 YYYY-MM-DD」，不注昨日正文
//   E 库有「今日」检查点 + md 只有昨日旧摘要 ⇒ 库优先（今日正文），不被旧 md 抢走
//   另附静态启发式提示（WARN，不计失败）。
//
// 跑法：node test/_accept-p0-g2.mjs [index.js 路径]
//   对「改前副本」跑：期望 A/D/E 部分 FAIL；对「改后」跑：期望全 PASS。
// 安全：全部写在 os.tmpdir() 临时 home；不触碰真实 ~/.dsh/memory、不写运行副本、不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import {
  TARGET, mkHome, useHome, freshPlugin, makeCtx, mkAgent, msgText, applyPlugin,
  callCreated, waitTopicDb, seedD8, todayStr, daysAgoStr, makeReporter, finish,
  summaryInjections,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P0-G2 注入读库验收");
const CFG_ON = { memoryTopicDbEnabled: true };
const rand = () => Math.random().toString(36).slice(2, 8);
const SUM_OF = (mark) => "## 本次目标\n- " + mark + " 验收标记\n## 下一步行动\n- 观察下一个会话注入面\n## 关键结论\n- 检查点已落库";

function textsOf(injected) { return (injected || []).map(msgText); }

// ═══════════ A：库有当日检查点 + sessions/ 为空 ⇒ 注入库内检查点正文 ═══════════
{
  const h = useHome(mkHome("g2a"));
  const mod = await freshPlugin();
  const { ctx, handlers, injected } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "A0 前置：flag 开 ⇒ 主题库就绪", ready ? "ready" : ("err=" + ((mod.__topicdb && mod.__topicdb.err) || "?")));
  if (ready) {
    const seeded = seedD8(mod);
    R.ok(!!seeded, "A1 造数：D8「日记忆（按天流水）」→「会话检查点」线已建");
    if (seeded) {
      const MARK = "G2-DB-MARK-" + rand();
      const cid = "a2b3c4d5-1111-2222-3333-" + String(Date.now());
      const route = mod.__topicdbIntentRoute(cid, "sidg2a", SUM_OF(MARK), todayStr() + ".md", "session-sidg2a");
      R.ok(route && route.mode === "db" && route.ok !== false, "A2 造数：检查点写入主题库（mode=db）", JSON.stringify(route));
      R.ok(!fs.readdirSync(path.join(h.mem, "sessions")).length, "A3 夹具自检：sessions/ 为空（正文只能来自库）", "");
      const { agent, injected: agInj } = mkAgent("session-g2a");
      await callCreated(handlers, agent, 900);
      const texts = textsOf(agInj);
      const sums = summaryInjections(texts);
      R.ok(texts.some((t) => t.includes(MARK)), "A4 G2：库内今日检查点正文出现在注入面（改前：完全没有）", "总注入=" + texts.length);
      R.ok(sums.some((t) => t.includes(MARK)), "A5 G2：正文挂在【最近一次会话压缩点】注入块内（不是无关提醒）", "摘要块=" + sums.length);
      R.ok(sums.some((t) => t.includes(MARK) && t.length >= 200), "A6 G2：注入的是检查点正文而非一行通知", "长度=" + sums.map((t) => t.length).join(","));
    }
  }
}

// ═══════════ B：库空 + md 有当日摘要 ⇒ 仍注入 md（老行为不回归） ═══════════
{
  const h = useHome(mkHome("g2b"));
  const MARK = "G2-MD-MARK-" + rand();
  fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"),
    "## 通用块\n\n### 本次目标\n- " + MARK + "\n### 下一步行动\n- 继续老路径\n### 关键结论\n- md 回落正文\n", "utf8");
  const mod = await freshPlugin();
  const { ctx, handlers, injected } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "B0 前置：主题库就绪且库内无检查点", ready ? "ready" : "not-ready");
  const { agent, injected: agInj } = mkAgent("session-g2b");
  await callCreated(handlers, agent, 900);
  const sums = summaryInjections(textsOf(agInj));
  R.ok(sums.some((t) => t.includes(MARK)), "B1 不回归：库空 + md 有 ⇒ 仍注入 md 正文", MARK);
  R.ok(sums.some((t) => t.includes(MARK) && !/停在\s*\d{4}-\d{2}-\d{2}/.test(t)), "B2 不回归：当日 md 走正文分支（不是「停在」一行通知）");
}

// ═══════════ C：库空 + md 空 ⇒ 不注入摘要（不虚构） ═══════════
{
  useHome(mkHome("g2c"));
  const mod = await freshPlugin();
  const { ctx, handlers, injected } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "C0 前置：主题库就绪且库/ md 均空", ready ? "ready" : "not-ready");
  const { agent, injected: agInj } = mkAgent("session-g2c");
  let threw = null;
  try { await callCreated(handlers, agent, 700); } catch (e) { threw = e; }
  const texts = textsOf(agInj);
  R.ok(!threw, "C1 边界：无任何摘要源时不抛异常", threw ? threw.message : "");
  R.ok(!summaryInjections(texts).length, "C2 边界：无摘要源 ⇒ 不注入【最近一次会话压缩点】（不虚构检查点）", "条数=" + summaryInjections(texts).length);
}

// ═══════════ D：库只有昨日检查点 ⇒ 「非当日一行」语义保留 ═══════════
{
  useHome(mkHome("g2d"));
  const mod = await freshPlugin();
  const { ctx, handlers, injected } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "D0 前置：主题库就绪", ready ? "ready" : "not-ready");
  if (ready) {
    seedD8(mod);
    const YDAY = daysAgoStr(1);
    const MARK = "G2-DB-YDAY-" + rand();
    const cid = "d4e5f6a7-1111-2222-3333-" + String(Date.now());
    const route = mod.__topicdbIntentRoute(cid, "sidg2d", SUM_OF(MARK), YDAY + ".md", "session-sidg2d");
    R.ok(route && route.mode === "db", "D1 造数：昨日检查点写入主题库（主题名=" + YDAY + "）", JSON.stringify(route));
    const { agent, injected: agInj } = mkAgent("session-g2d");
    await callCreated(handlers, agent, 900);
    const texts = textsOf(agInj);
    const sums = summaryInjections(texts);
    R.ok(texts.some((t) => t.includes(YDAY) && /停在/.test(t)), "D2 G2 非当日语义：库只有昨日检查点 ⇒ 发出「停在 YYYY-MM-DD」通知（不是完全静默）", "摘要块=" + sums.length);
    R.ok(sums.some((t) => t.includes(YDAY) && /停在/.test(t)), "D3 G2 非当日语义：通知在【最近一次会话压缩点】块内且写明日期", YDAY);
    R.ok(!texts.some((t) => t.includes(MARK)), "D4 G2 非当日语义：不注入昨日检查点正文（只一行）", MARK);
  }
}

// ═══════════ E：库有今日检查点 + md 只有昨日旧摘要 ⇒ 库优先 ═══════════
{
  const h = useHome(mkHome("g2e"));
  const YDAY = daysAgoStr(1);
  const MD_MARK = "G2-MD-YDAY-" + rand();
  fs.writeFileSync(path.join(h.mem, "sessions", YDAY + ".md"),
    "## 通用块\n\n### 本次目标\n- " + MD_MARK + "\n### 下一步行动\n- 旧\n### 关键结论\n- 旧\n", "utf8");
  const mod = await freshPlugin();
  const { ctx, handlers, injected } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "E0 前置：主题库就绪", ready ? "ready" : "not-ready");
  if (ready) {
    seedD8(mod);
    const DB_MARK = "G2-DB-TODAY-" + rand();
    const cid = "e5f6a7b8-1111-2222-3333-" + String(Date.now());
    const route = mod.__topicdbIntentRoute(cid, "sidg2e", SUM_OF(DB_MARK), todayStr() + ".md", "session-sidg2e");
    R.ok(route && route.mode === "db", "E1 造数：今日检查点写入主题库", JSON.stringify(route));
    const { agent, injected: agInj } = mkAgent("session-g2e");
    await callCreated(handlers, agent, 900);
    const texts = textsOf(agInj);
    const sums = summaryInjections(texts);
    R.ok(sums.some((t) => t.includes(DB_MARK)), "E2 G2 优先级：库有今日检查点 ⇒ 注入库内正文（不被旧的 md 摘要抢走）", DB_MARK);
    R.ok(!texts.some((t) => t.includes(MD_MARK)), "E3 G2 优先级：昨日旧 md 摘要不再以「当日正文」形态注入", MD_MARK);
  }
}

// ═══════════ H：__dbCheckpointSlice 项目隔离（P0-1 配套纯函数；无钩子 SKIP） ═══════════
{
  useHome(mkHome("g2h"));
  const mod = await freshPlugin();
  const f = mod.__dbCheckpointSlice;
  if (typeof f !== "function") {
    R.skip("H1~H4 __dbCheckpointSlice 项目隔离", "缺模块级导出 __dbCheckpointSlice（改前预期缺）");
  } else {
    // 与生产读库口径一致：句子是**字符串数组**（topicDbReadIntentSummary 已把 {text} 投影成 string）
    const sents = [
      "项目块甲：长沙项目 A 要点 LIT-A-" + rand(),
      "项目块乙：发改委 B 要点 LIT-B-" + rand(),
      "通用：今天修了 bug",
    ];
    const aMark = sents[0].match(/LIT-A-\w+/)[0];
    const bMark = sents[1].match(/LIT-B-\w+/)[0];
    const trySlice = (key, aliases, budget) => {
      try { return f(sents, key, aliases, budget); } catch (e) { return { __threw: e }; }
    };
    const all = trySlice("", [], 2000);
    R.ok(!all.__threw && all.hit === 3 && all.text.includes(aMark) && all.text.includes(bMark), "H1 全量：key 为空 ⇒ 3 句全取（不误隔离）", JSON.stringify({ hit: all.hit, used: all.used }));
    const only = trySlice("长沙", ["别名长沙"], 2000);
    R.ok(!only.__threw && only.hit === 1 && only.text.includes(aMark) && !only.text.includes(bMark), "H2 项目隔离：key 命中 ⇒ 只取该项目的句子（不跨项目）", JSON.stringify({ hit: only.hit }));
    const none = trySlice("不存在的项目XYZ", [], 2000);
    R.ok(!none.__threw && none.hit === 0, "H3 0 命中：hit=0（调用方走「0 命中一行通知」）", JSON.stringify({ hit: none.hit, text: String(none.text || "").slice(0, 20) }));
    const cut = trySlice("", [], 40);
    const segs = String(cut.text || "").split(/\n{2,}/).filter(Boolean);
    R.ok(!cut.__threw && segs.every((seg) => sents.some((s) => s === seg)), "H4 预算：小预算下整句取舍（返回的每一段都是原文整句，不切半句）", JSON.stringify(segs).slice(0, 120));
  }
}

// ═══════════ 静态启发式（WARN，不计失败） ═══════════
try {
  const src = fs.readFileSync(TARGET, "utf8");
  const a = src.indexOf("function latestSessionSummary");
  const region = a >= 0 ? src.slice(a, a + 6000) : "";
  const hit = /会话检查点|topicDb|TOPICDB|mem\.db|intentRetry|readCheckpoint/i.test(region);
  if (hit) R.ok(true, "S1 静态：latestSessionSummary 区域出现主题库/检查点读取线索（启发式）");
  else R.warn("S1 静态：latestSessionSummary 区域未见主题库检查点读取线索（启发式，可能是改名/封装）", "region.len=" + region.length);
  const b = src.indexOf('compatOn(ctx, "session/event"');
  const c = src.indexOf('compatOn(ctx,', b + 10);
  const hRegion = (b >= 0 ? src.slice(b, c > b ? c : b + 12000) : "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // 剥注释（注释里提到旧顺序会造成假 WARN）
  const addPos = hRegion.indexOf("archivedCompactionIds.add(");
  const spawnPos = hRegion.indexOf("spawnIntentCheckpoint(");
  if (addPos >= 0 && spawnPos >= 0 && addPos < spawnPos) R.warn("S2 静态：session/event 处理器里 archivedCompactionIds.add 仍在 spawnIntentCheckpoint 调度之前（静态启发式；以 G3 行为断言为准）");
  else R.ok(true, "S2 静态：session/event 处理器里未见「先去重后 spawn」的旧顺序（启发式）");
} catch (e) {
  R.warn("S 静态启发式检查失败（不影响结论）", e && e.message ? e.message : String(e));
}

// ═══════════ Z：[P2.5.1] 同 session.id「新对话」（历史为空）⇒ 快照失效，必须全量注入 ═══════════
//   真机踩坑（2026-11-02 15:16 用户实测）：DSH 在同一 session.id 上开新对话（session/end-seed 后
//   turn 重来、历史 0 条 user 消息），注入快照却还留着上一次的 hash ⇒ 三档判定 silent ⇒ 新会话零记忆。
//   判据：历史里有没有非 system 消息。历史为空 ⇒ 强制 full；历史非空 ⇒ 正常三档。
{
  useHome(mkHome("g2z"));
  const mod = await freshPlugin();
  const { ctx, handlers } = makeCtx();
  applyPlugin(mod, CFG_ON, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "Z0 前置：主题库就绪", ready ? "ready" : "not-ready");

  // 第一次：新会话（fake agent 无 deriveMessages ⇒ 走原有 full 路径），产生注入 + 快照
  const first = mkAgent("session-g2z");
  await callCreated(handlers, first.agent, 700);
  const n1 = (first.injected || []).length;
  R.ok(n1 > 0, "Z1 首次注入发生（产生快照）", "注入=" + n1);

  // 模拟「同一 session.id 新对话」：历史为空
  const second = mkAgent("session-g2z");
  second.agent.session.deriveMessages = () => [];
  await callCreated(handlers, second.agent, 700);
  const n2 = (second.injected || []).length;
  R.ok(n2 > 0, "Z2 同 id 新对话（历史为空）⇒ 仍全量注入（不被旧快照误判 silent）", "注入=" + n2);

  // 对照组：历史非空（恢复会话）+ 三文件未变 ⇒ 应静默（不重复注入）
  const third = mkAgent("session-g2z");
  third.agent.session.deriveMessages = () => [
    { role: "user", content: "上一轮用户消息" },
    { role: "assistant", content: "上一轮助手回复" },
  ];
  await callCreated(handlers, third.agent, 700);
  const n3 = (third.injected || []).length;
  R.ok(n3 < n2, "Z3 对照：历史非空 + 内容未变 ⇒ 静默（注入数少于新对话）", "注入=" + n3 + " < " + n2);
}

finish(R);
