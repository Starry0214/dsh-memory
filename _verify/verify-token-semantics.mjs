// 验证 usage.totalTokens 语义：上下文快照 vs 单次消耗
import fs from "node:fs";

const P = "C:/Temp/dsh-sub-verify/session.v4.jsonl";
const lines = fs.readFileSync(P, "utf8").split("\n").filter(Boolean);
const us = [];
for (const ln of lines) {
  let j; try { j = JSON.parse(ln); } catch { continue; }
  if (j.type === "assistant/message" && j.data && j.data.usage) us.push(j.data.usage);
}
console.log("usage 条数:", us.length);
console.log("\n序列抽样（totalTokens 是不是逐步增长 = 上下文累积？）");
for (let i = 0; i < us.length; i++) {
  if (i < 6 || i >= us.length - 3) {
    const u = us[i];
    console.log(`  #${String(i + 1).padStart(2)}  in=${u.inputTokens || 0}  cacheRead=${u.cacheReadTokens || 0}  out=${u.outputTokens || 0}  total=${u.totalTokens || 0}`);
  }
}
const sum = (f) => us.reduce((a, u) => a + (f(u) || 0), 0);
console.log("\n=== 三种算法的结果 ===");
console.log("累加 totalTokens      =", sum((u) => u.totalTokens), "  <= 每轮上下文总量之和（无意义，会爆大）");
console.log("累加 (in+out)         =", sum((u) => (u.inputTokens || 0) + (u.outputTokens || 0)), "  <= 真实增量消耗");
console.log("累加 cacheRead        =", sum((u) => u.cacheReadTokens), "  <= 缓存命中读取量（便宜 10 倍）");
const last = us[us.length - 1] || {};
console.log("最后一条 totalTokens  =", last.totalTokens || 0, "  <= 结束时的上下文压力");
console.log("MAX totalTokens       =", Math.max(...us.map((u) => u.totalTokens || 0)), "  <= 峰值上下文");
