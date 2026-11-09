// P3-3c 记账补全 ②：maint + rebuildInject（锚点唯一）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-cost3-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① maint：成功路径（recordMaintSample result:"ok" 之后）═══
const MAINT_ANCHOR = '        recordMaintSample(Object.assign({ fname, beforeChars, afterChars: merged.length, result: "ok", overBudget: overBudgetInject }, slimStats ? { slimCalls: slimStats.calls, slimLens: slimStats.lens, stuckReason: slimStats.reason } : {}));   // v0.5（P0-2）；v2.5.2（P2）：slim 统计随样入账';
rep(
  MAINT_ANCHOR,
  MAINT_ANCHOR + `

        // [P3-3 记账][2026-11-02] 合并维护成功一次：只记字符压缩比（token 由 hostUsage 归因覆盖，不重复记）
        try {
          p3CostBump("maint", { n: 1, beforeChars: beforeChars, afterChars: merged.length },
            { sid: "", trigger: "maint", ok: 1,
              note: fname + (overBudgetInject ? " over-budget" : "") + (slimStats && slimStats.calls ? " slim" + slimStats.calls : "") });
        } catch (eP3m) { /* 记账失败不影响维护 */ }`,
  "maint"
);

// ═══ ② rebuildInject：压缩后重灌（p4NoteRehydrateId 之后、REHYDRATE_STATS.count 之前）═══
const RI_ANCHOR = `                    p4NoteRehydrateId(compactionId);
                    REHYDRATE_STATS.count += 1;`;
rep(
  RI_ANCHOR,
  `                    p4NoteRehydrateId(compactionId);
                    // [P3-3 记账][2026-11-02] 压缩后重灌的注入字符量（R2）
                    try {
                      p3CostBump("rebuildInject", { n: 1, injectedChars: (rehydrate.chars || rehydrate.text.length) },
                        { sid: String((targetAgent && targetAgent.session && targetAgent.session.id) || ""), trigger: "R2", note: "post-compact-rehydrate" });
                    } catch (eP3ri) { /* 记账失败不影响重灌 */ }
                    REHYDRATE_STATS.count += 1;`,
  "rebuildInject"
);

fs.writeFileSync(P, t, "utf8");
console.log("written:", before, "->", t.length);
