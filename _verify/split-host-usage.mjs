// 口径拆分：hostUsage（历史混合桶）→ hostMain（主会话，对照）+ hostSub（子代理，插件真实成本）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/p3-cost.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-split-" + Date.now().toString(36), t);

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("anchor NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("anchor NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ① KIND_LIST 追加两个桶
rep(
  '  "memorySearch", "dream", "maint", "archive", "export", "hostUsage"\n]);',
  '  "memorySearch", "dream", "maint", "archive", "export",\n' +
  '  // [2026-11-02 口径拆分] 原 hostUsage 是「主会话 + 子代理」混在一起的桶，被当成"记忆插件消耗"展示会严重误导\n' +
  '  //   （主会话 tokens 是用户与 Agent 对话本身的开销，不是插件成本）。现拆成：\n' +
  '  //     hostMain = 主会话 usage（**非插件开销**，仅作对照基线）\n' +
  '  //     hostSub  = 子代理 usage（writer/dream/archive，**这才是插件的真实成本**）\n' +
  '  //   hostUsage 保留 = 拆分前的历史混合数据（只读兼容，新数据不再写入）。\n' +
  '  "hostUsage", "hostMain", "hostSub"\n]);',
  "KIND_LIST"
);

// ② KIND_FIELDS 加两个桶
rep(
  '  hostUsage: ["inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite", "turns"]\n});',
  '  hostUsage: ["inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite", "turns"],\n' +
  '  hostMain: ["n", "inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite"],\n' +
  '  hostSub: ["n", "inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite"]\n});',
  "KIND_FIELDS"
);

// ③ today.real → hostSub，并给出 realMain / realLegacy
rep(
  '      real: realOf(day.kinds.hostUsage),',
  '      real: realOf(day.kinds.hostSub),            // 插件真实成本 = 子代理 usage\n' +
  '      realMain: realOf(day.kinds.hostMain),       // 对照：用户对话消耗（非插件开销）\n' +
  '      realLegacy: realOf(day.kinds.hostUsage),    // 历史混合桶（口径拆分前）',
  "today.real"
);

// ④ cumulative.real
rep(
  '      real: realOf(cum.kinds.hostUsage),',
  '      real: realOf(cum.kinds.hostSub),\n' +
  '      realMain: realOf(cum.kinds.hostMain),\n' +
  '      realLegacy: realOf(cum.kinds.hostUsage),',
  "cumulative.real"
);

fs.writeFileSync(P, t, "utf8");
console.log("p3-cost.js written:", t.length);
