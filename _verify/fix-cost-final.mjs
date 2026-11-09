// 收尾修正：realOf.turns 兜底 n；buildTrend 的 real 改 hostSub；自测残余 13→15
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/p3-cost.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-final-" + Date.now().toString(36), t);

function rep(s, oldS, newS, label) {
  const i = s.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (s.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  return s.slice(0, i) + newS + s.slice(i + oldS.length);
}

// ① realOf.turns：hostMain/hostSub 用 n 当轮次
t = rep(
  t,
  '  return { inTokens: inTokens, outTokens: outTokens, cacheRead: cacheRead, cacheWrite: cacheWrite, totalTokens: totalTokens, turns: toNum(r.turns) };',
  '  // turns：历史 hostUsage 用 turns 字段；hostMain/hostSub 用 n 当轮次（KIND_FIELDS 里没 turns）\n' +
  '  const turns = toNum(r.turns) || toNum(r.n);\n' +
  '  return { inTokens: inTokens, outTokens: outTokens, cacheRead: cacheRead, cacheWrite: cacheWrite, totalTokens: totalTokens, turns: turns };',
  "realOf.turns"
);

// ② buildTrend 的 real：hostUsage → hostSub
const oldReal = 'real: realOf(col.kinds.hostUsage).totalTokens';
if (t.indexOf(oldReal) >= 0) {
  t = rep(t, oldReal, 'real: realOf(col.kinds.hostSub).totalTokens', "trend.real");
} else {
  // 兜底：可能是别种写法
  const m = t.match(/real: realOf\([^)]*\)[^,\n]*/g);
  console.log("trend real patterns:", JSON.stringify(m));
}

fs.writeFileSync(P, t, "utf8");
console.log("OK p3-cost.js final:", t.length);

// ③ 自测残余 13→15
const Q = "E:/工具/插件开发调整/dsh-memory-plugin/test/_p3-cost-selftest.mjs";
let q = fs.readFileSync(Q, "utf8");
const before = q;
q = q.split("assert.equal(Object.keys(c.totals).length, 13);").join("assert.equal(Object.keys(c.totals).length, 15);");
q = q.split("assert.equal(Object.keys(x.est.byKind).length, 13);").join("assert.equal(Object.keys(x.est.byKind).length, 15);");
if (q !== before) { fs.writeFileSync(Q, q, "utf8"); console.log("OK selftest 13->15"); }
