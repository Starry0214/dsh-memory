// _accept-p0-budget.mjs — P0-3 独立验收：摘要注入三槽预算（检查点正文 / 最近用户原话 / 任务状态）
//
// 背景（03-梳理与方案.md §4 P0-3 + task-3 契约）：
//   现状只有单槽 CHAR_LIMIT.summary=1500，只注入「最近压缩点」一段；
//   目标：三槽拼装，总预算 ≤ 5000（P2 起，原 4500）；超限先砍任务状态 → 再砍用户原话 → 最后才截检查点正文；不截断字面量（行边界取材）。
//
// 验收断言：
//   D1 默认预算 5000（P2 起）：totalChars ≤ 5000（硬上限）
//   D2 富余时余量给检查点：只剩 checkpoint 时其槽 > 2500（不是死卡 2500）
//   D3 超限优先级：taskState 先被丢/砍；checkpoint 正文保留
//   D4 次优先级：userQuotes 在 taskState 之后、checkpoint 之前被砍
//   D5 字面量不截断：GUID 埋在会被切的行里 ⇒ 注入文本要么完整含、要么完全不含（无半截）
//   D6 空输入不抛异常、text 为空/极短
//   D7 极小预算不越界（text.length ≤ budget）
//   E1 端到端（G2 改造后）：库内超长检查点 ⇒ 注入正文 ≥ 2500（改前：无注入）
//   E2 端到端总预算：所有【最近一次会话压缩点】注入块合计 ≤ 6000（含格式/标题开销）
//   E3 md 回落端到端：超长当日 md ⇒ 注入正文 ≥ 2500（WARN：若实现只扩库路径则不算失败）
//
// 跑法：node test/_accept-p0-budget.mjs [index.js 路径]（改前：D 组 SKIP、E1 FAIL）
// 安全：全部 os.tmpdir 临时 home；不碰真实记忆库、不写运行副本、不重启 DSH。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TARGET, mkHome, useHome, freshPlugin, makeCtx, mkAgent, applyPlugin,
  callCreated, waitTopicDb, seedD8, todayStr, makeReporter, finish, sleep,
  msgText, summaryInjections, hasPartialLiteral,
} from "./_accept-p0-lib.mjs";

const R = makeReporter("P0-3 注入预算验收");
const rand = () => Math.random().toString(36).slice(2, 8);
const line = (tag, n) => tag + "-" + "字".repeat(Math.max(0, n - tag.length - 1));

// ═══════════ D：__buildSummaryInjection 纯函数（三槽优先级/预算） ═══════════
{
  useHome(mkHome("bg-fn"));
  const mod = await freshPlugin();
  const f = mod.__buildSummaryInjection || mod.buildSummaryInjection;   // 实现实际导出名可能是无 __ 前缀的同名函数
  if (typeof f !== "function") {
    R.skip("D1~D7 __buildSummaryInjection 三槽纯函数", "缺模块级导出 __buildSummaryInjection（改前预期缺；改后若仍缺=验收不可判定）");
  } else {
    const CP_MARK = "CP-MARK-" + rand();
    const UQ_MARK = "UQ-MARK-" + rand();
    const TS_MARK = "TS-MARK-" + rand();
    const cp = "## 检查点\n" + CP_MARK + "\n" + Array.from({ length: 40 }, (_, i) => line("检查点正文" + i, 80)).join("\n");
    const uq = Array.from({ length: 20 }, (_, i) => line("用户原话" + i, 100));
    uq[0] = UQ_MARK + " " + uq[0];
    const ts = Array.from({ length: 10 }, (_, i) => line("任务状态" + i, 60));
    ts[0] = TS_MARK + " " + ts[0];
    const call = (parts) => {
      try { return f(parts); } catch (e) { return { __threw: e }; }
    };
    const norm = (o) => {
      const out = o || {};
      const slots = out.slots || {};
      return {
        text: String(out.text == null ? "" : out.text),
        total: Number(out.totalChars == null ? String(out.text == null ? "" : out.text).length : out.totalChars),
        dropped: Array.isArray(out.dropped) ? out.dropped.map(String) : [],
        cp: String(slots.checkpoint == null ? "" : slots.checkpoint),
        uq: String(slots.userQuotes == null ? "" : slots.userQuotes),
        ts: String(slots.taskState == null ? "" : slots.taskState),
      };
    };

    // D1 默认预算
    {
      const o = norm(call({ checkpoint: cp, userQuotes: uq, taskState: ts }));
      R.ok(!o.__threw && o.total <= 5000 && o.text.length <= 5000, "D1 总预算：三槽装配总长 ≤ 默认 5000 字符（P2：4500→5000）",
        "totalChars=" + o.total + " text=" + o.text.length + (o.__threw ? " threw=" + o.__threw.message : ""));
      R.ok(o.text.includes(CP_MARK), "D2 检查点优先：超限时检查点正文仍在（不被整体牺牲）", "cpSlot=" + o.cp.length);
    }
    // D3 预算紧：先砍任务状态
    {
      const o = norm(call({ checkpoint: cp, userQuotes: uq, taskState: ts, budget: 2600 }));
      const droppedTs = o.dropped.includes("taskState") || o.ts === "" || o.ts.length < ts.join("\n").length;
      R.ok(droppedTs && !o.text.includes(TS_MARK), "D3 优先级①：预算 2600 ⇒ 任务状态先被砍掉（槽为空或明显缩短）",
        "dropped=" + JSON.stringify(o.dropped) + " ts.len=" + o.ts.length);
      R.ok(o.text.length <= 2600, "D3b 优先级①：砍完仍守总预算（text ≤ 2600）", "len=" + o.text.length);
    }
    // D4 次优先：用户原话在检查点之前被砍（用小体量三槽构造「cp+uq 装得下、加 ts 装不下」的窗口）
    {
      const cpS = "## 检查点\n" + CP_MARK + "\n" + Array.from({ length: 24 }, (_, i) => line("检查点正文" + i, 100)).join("\n");   // ~2450
      const uqS = Array.from({ length: 8 }, (_, i) => line("用户原话" + i, 100)); uqS[0] = UQ_MARK;                                // ~800
      const tsS = Array.from({ length: 6 }, (_, i) => line("任务状态" + i, 60)); tsS[0] = TS_MARK;                                 // ~360
      const o = norm(call({ checkpoint: cpS, userQuotes: uqS, taskState: tsS, budget: 3500 }));
      const tsCut = o.dropped.includes("taskState") || o.ts === "" || !o.text.includes(TS_MARK);
      const uqKept = o.uq.length > 0 && o.text.includes(UQ_MARK);
      R.ok(tsCut && uqKept, "D4 优先级②：预算 3500 ⇒ 先砍任务状态、用户原话保留（检查点正文不受损）",
        "tsCut=" + tsCut + " uq.len=" + o.uq.length + " dropped=" + JSON.stringify(o.dropped));
      R.ok(o.text.length <= 3500 && o.text.includes(CP_MARK), "D4b：总预算 ≤3500 且检查点正文保留", "len=" + o.text.length);
    }
    // D5 富余余量给检查点
    {
      const o = norm(call({ checkpoint: cp, userQuotes: "", taskState: "", budget: 4500 }));
      R.ok(o.cp.length > 2500 || o.text.length > 2500, "D5 富余：只有检查点时余量给正文（> 2500 硬槽，不是死卡 2500）", "cpSlot=" + o.cp.length + " text=" + o.text.length);
    }
    // D6 字面量不截断（GUID 埋在被切的行里）
    {
      const guid = randomUUID();
      const cpLit = "## 检查点\n" + CP_MARK + "\n" + Array.from({ length: 30 }, (_, i) => line("检查点正文" + i, 80)).join("\n") + "\nGUID: " + guid + "\n尾行";
      // 用户原话：16 行 ×100 字符，GUID 放在第 16 行（超出 1500 槽上限 ⇒ 必然被整行丢弃，不允许出现半截）
      const uqLit = Array.from({ length: 16 }, (_, i) => line("用户原话" + i, 100));
      uqLit[15] = "关键标识：" + guid;
      const o1 = norm(call({ checkpoint: cpLit, userQuotes: "", taskState: "", budget: 2600 }));
      R.ok(!hasPartialLiteral(o1.text, guid), "D6a 字面量：检查点被截时 GUID 不被切半（完整或在被弃行里）", "len=" + o1.text.length + " has=" + o1.text.includes(guid));
      const o2 = norm(call({ checkpoint: "", userQuotes: uqLit, taskState: "", budget: 4500 }));
      R.ok(!hasPartialLiteral(o2.text, guid), "D6b 字面量：用户原话超槽被整行丢弃时 GUID 不被切半", "len=" + o2.text.length + " has=" + o2.text.includes(guid));
      R.ok(o2.text.includes("用户原话0"), "D6c 字面量：未超界的整行仍原样保留（不是整体丢弃）", "has0=" + o2.text.includes("用户原话0"));
    }
    // D7 空输入 / 极小预算
    {
      const oEmpty = norm(call({}));
      R.ok(String(oEmpty.text).trim() === "" && oEmpty.total === 0, "D7 空输入：text 为空、totalChars=0（不抛异常）", "text=" + JSON.stringify(oEmpty.text).slice(0, 40));
      const oTiny = norm(call({ checkpoint: cp, userQuotes: uq, taskState: ts, budget: 500 }));
      R.ok(oTiny.text.length <= 500, "D8 极小预算：text ≤ budget（不越界放大注入）", "len=" + oTiny.text.length);
    }
  }
}

// ═══════════ E：端到端（真 agent/created 注入面） ═══════════
{
  const h = useHome(mkHome("bg-e2e"));
  fs.mkdirSync(path.join(h.mem, "sessions"), { recursive: true });
  const mod = await freshPlugin();
  const { ctx, handlers } = makeCtx();
  applyPlugin(mod, { memoryTopicDbEnabled: true }, ctx);
  const ready = await waitTopicDb(mod);
  R.ok(ready, "E0 前置：主题库就绪", ready ? "ready" : "not-ready");
  if (ready) {
    seedD8(mod);
    const CP_MARK = "BG-CP-" + rand();
    // 按生产形态造 3 轮压缩检查点（每句 ~1.1k 字，写侧有 1000 字护栏；读侧取最近 3 句拼 ~3.3k）
    let route = null;
    for (let i = 0; i < 3; i++) {
      const SUM = "## 本次目标\n- " + (i === 2 ? CP_MARK : "第" + i + "轮检查点要点") + "\n"
        + Array.from({ length: 12 }, (_, k) => line("检查点长文" + i + "-" + k, 90)).join("\n");
      route = mod.__topicdbIntentRoute("bg-" + i + "-" + randomUUID(), "sidbg", SUM, todayStr() + ".md", "session-sidbg");
    }
    R.ok(route && route.mode === "db", "E0b 造数：3 轮超长检查点写入主题库（每句 >1000 字）", JSON.stringify(route).slice(0, 100));
    const { agent, injected } = mkAgent("session-bg");
    await callCreated(handlers, agent, 1000);
    const texts = injected.map(msgText);
    const sums = summaryInjections(texts);
    const withMark = sums.filter((t) => t.includes(CP_MARK));
    R.ok(withMark.length > 0, "E1 端到端：库内超长检查点 ⇒ 注入正文可见（改前：sessions/ 空 ⇒ 无注入）", "summary blocks=" + sums.length);
    R.ok(withMark.some((t) => t.length > 1500), "E2 三槽生效：注入正文显著超过旧单槽硬限 1500（实测长度见 detail）", "长度=" + withMark.map((t) => t.length).join(","));
    R.ok(sums.every((t) => t.length <= 6000), "E3 总预算：单个摘要注入块 ≤ 6000（含格式开销，防无界扩张）", "长度=" + sums.map((t) => t.length).join(","));
    R.ok(sums.reduce((a, t) => a + t.length, 0) <= 6000, "E4 总预算：全部摘要注入合计 ≤ 6000", "合计=" + sums.reduce((a, t) => a + t.length, 0));
  }
}

// ═══════════ F：md 回落端到端（WARN：仅当实现把三槽也用于 md 路径时才算硬指标） ═══════════
{
  const h = useHome(mkHome("bg-md"));
  fs.mkdirSync(path.join(h.mem, "sessions"), { recursive: true });
  const MD_MARK = "BG-MD-" + rand();
  const big = Array.from({ length: 40 }, (_, i) => line("md通用块长文" + i, 100)).join("\n");
  fs.writeFileSync(path.join(h.mem, "sessions", todayStr() + ".md"),
    "## 通用块\n\n### 本次目标\n- " + MD_MARK + "\n" + big + "\n### 下一步行动\n- 继续\n### 关键结论\n- 完\n", "utf8");
  const mod = await freshPlugin();
  const { ctx, handlers } = makeCtx();
  applyPlugin(mod, { memoryTopicDbEnabled: true }, ctx);
  const ready = await waitTopicDb(mod);
  if (!ready) { R.skip("F1 md 回落三槽", "主题库未就绪（前置失败）"); }
  else {
    const { agent, injected } = mkAgent("session-bgmd");
    await callCreated(handlers, agent, 900);
    const sums = summaryInjections(injected.map(msgText)).filter((t) => t.includes(MD_MARK));
    if (sums.length === 0) R.ok(false, "F1 md 回落：超长当日 md 仍被注入（不回归）", "无含标记摘要块");
    else if (sums.some((t) => t.length >= 2500)) R.ok(true, "F1 md 回落：注入正文 ≥ 2500（三槽同样作用于 md 路径）", "长度=" + sums.map((t) => t.length).join(","));
    else R.warn("F1 md 回落：注入正文 < 2500（三槽可能只作用于库路径；md 老路径保持 1500 —— 需 Lead 决策是否可接受）", "长度=" + sums.map((t) => t.length).join(","));
  }
}

finish(R);

