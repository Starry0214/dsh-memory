// 口径修正：① totalTokens 不再累加（改计费口径 in+out）② 主/子拆桶
import fs from "node:fs";

// ═══ A. p3-cost.js：realOf 的 totalTokens 改计费口径 ═══
const P = "E:/工具/插件开发调整/dsh-memory-plugin/p3-cost.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-realfix-" + Date.now().toString(36), t);
const A_OLD = "  // totalTokens 缺省时按宿主口径兜底（实测 subagent usage：5578+73+95488=101139）\n  const totalTokens = toNum(r.totalTokens) || (inTokens + outTokens + cacheRead + cacheWrite);";
const A_NEW = "  // [2026-11-02 口径修正] 宿主 usage.totalTokens 是**每轮上下文快照**（实测子代理 90 轮：10万→27.6万递增），\n" +
  "  //   累加 N 轮得到的是「上下文总量之和」而非消耗（90 轮累加 1870 万 vs 真实消耗 22.9 万，虚高约 80 倍）。\n" +
  "  //   统一改为**计费口径消耗** = 未命中缓存的输入 + 输出；cacheRead 单独返回（0.1x 单价，不并入消耗）。\n" +
  "  const totalTokens = inTokens + outTokens;";
if (t.indexOf(A_OLD) < 0) throw new Error("A anchor not found");
if (t.indexOf(A_OLD, t.indexOf(A_OLD) + 1) >= 0) throw new Error("A anchor not unique");
t = t.replace(A_OLD, A_NEW);
fs.writeFileSync(P, t, "utf8");
console.log("OK p3-cost.js realOf fixed:", t.length);

// ═══ B. index.js：主/子拆桶 + 不传 totalTokens ═══
const I = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let s = fs.readFileSync(I, "utf8");
fs.writeFileSync(I + ".bak-hostsplit-" + Date.now().toString(36), s);
const B_OLD = '        p3CostBump("hostUsage", { n: 1, inTokens: inT, outTokens: outT, cacheReadTokens: cacheT, totalTokens: total });';
const B_NEW = '        // [2026-11-02 口径拆分] 主会话 = hostMain（用户对话，**非插件开销**，只作对照）\n' +
  '        //   子代理 = hostSub（writer/dream/archive，**插件真实成本**）；不再混进一个 hostUsage 桶。\n' +
  '        //   也不传 totalTokens：那是每轮上下文快照，累加无意义（计入会虚高 ~80 倍），消耗看 in+out。\n' +
  '        p3CostBump(isSub ? "hostSub" : "hostMain", { n: 1, inTokens: inT, outTokens: outT, cacheReadTokens: cacheT });';
const bi = s.indexOf(B_OLD);
if (bi < 0) throw new Error("B anchor not found");
if (s.indexOf(B_OLD, bi + 1) >= 0) throw new Error("B anchor not unique");
s = s.replace(B_OLD, B_NEW);
fs.writeFileSync(I, s, "utf8");
console.log("OK index.js host split:", s.length);
