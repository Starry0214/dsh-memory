// [P4-C][增量检查点] 上次检查点作为新 writer 的增量基线（14b 报告推荐的替代方案）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-p4c-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① 模块级缓存 + 存取（插在 buildIntentInput 之前）═══
rep(
  "    function buildIntentInput(session, summaryText) {",
  `    // ═══ [P4-C][2026-11-02] 增量检查点：本会话上次检查点正文缓存 ═══
    //   依据 14b-reuse-report.md §④「更优的质量型替代」：不复用子会话，改为把上次检查点
    //   正文（≤2000 字）作为新材料喂给新 writer —— +600 tokens/次、零上下文污染、无脆弱链路。
    //   容量 32 FIFO；只在写成功时更新（失败不污染基线）。
    const P4C_LAST_CP = new Map();
    const P4C_LAST_CP_CAP = 32;
    function p4cRememberCheckpoint(sid, text) {
      try {
        const k = String(sid || "");
        const body = String(text || "").trim();
        if (!k || !body) return;
        P4C_LAST_CP.set(k, body.slice(0, 2000));
        if (P4C_LAST_CP.size > P4C_LAST_CP_CAP) {
          const first = P4C_LAST_CP.keys().next().value;
          if (first !== undefined) P4C_LAST_CP.delete(first);
        }
      } catch (eC) { /* 缓存失败不影响检查点 */ }
    }
    function p4cLastCheckpoint(sid) {
      try { return P4C_LAST_CP.get(String(sid || "")) || ""; } catch (e) { return ""; }
    }

    function buildIntentInput(session, summaryText) {`,
  "P4C cache"
);

// ═══ ② buildIntentInput 加第 3 段（上次检查点），摘要顺延为第 4 段 ═══
rep(
  `      parts.push("===== 任务与待办 =====\\n" + (tasks || "（无 todo/goal 快照）"));
      parts.push("===== 宿主压缩摘要 =====\\n" + String(summaryText == null ? "" : summaryText));`,
  `      parts.push("===== 任务与待办 =====\\n" + (tasks || "（无 todo/goal 快照）"));
      // [P4-C] 上次检查点：增量基线（≤2000 字）。无则整段省略（不占预算、不改变非增量轮的行为）。
      let prevCp = "";
      try { prevCp = p4cLastCheckpoint(session && session.id); } catch (eP) { prevCp = ""; }
      if (prevCp) parts.push("===== 上次检查点（增量基线）=====\\n" + prevCp);
      parts.push("===== 宿主压缩摘要 =====\\n" + String(summaryText == null ? "" : summaryText));`,
  "input prev checkpoint"
);

// ═══ ③ INTENT_INSTRUCTION 加增量规则（插在「纪律（分节预算」之前）═══
rep(
  `      "纪律（分节预算，严格）：`,
  `      "增量模式（**仅当材料含「===== 上次检查点（增量基线）=====」块时生效**）：该块是本会话上一版检查点。\\n" +
      "  · 与基线**相同**的条目：该节正文写「（同上）」即可，**不要整段重抄**；\\n" +
      "  · 只写**本周期新增/变更**：新决策、新踩坑、状态推进、下一步调整；\\n" +
      "  · 基线结论若被推翻/修正，**必须显式改写**该条（禁止照抄旧结论）——这是本机制唯一的质量风险；\\n" +
      "  · 「文件与代码」「任务与待办」等清单类：只列新增/变更项，未变的省略。\\n" +
      "  · 无该块时按完整 8 节写（首次检查点行为不变）。\\n" +
      "纪律（分节预算，严格）：`,
  "instruction incremental"
);

// ═══ ④ 写成功后更新基线（db 路由 + md 路由两处）═══
rep(
  `          intentRetrySucceed(compactionId);   // P0-2：落库成功才进去重集 + 清重试队列`,
  `          intentRetrySucceed(compactionId);   // P0-2：落库成功才进去重集 + 清重试队列
          try { p4cRememberCheckpoint(sessionId, sum); } catch (eP4c1) { /* 基线缓存失败不影响落库 */ }`,
  "remember db"
);
rep(
  `        intentRetrySucceed(compactionId);   // P0-2：md 写回成功才进去重集 + 清重试队列`,
  `        intentRetrySucceed(compactionId);   // P0-2：md 写回成功才进去重集 + 清重试队列
        try { p4cRememberCheckpoint(sessionId, sum); } catch (eP4c2) { /* 基线缓存失败不影响落库 */ }`,
  "remember md"
);

fs.writeFileSync(P, t, "utf8");
console.log("written:", before, "->", t.length);
