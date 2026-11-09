// 更新 p3-cost 自测：跟随 2026-11-02 口径变更（KIND_LIST +2 / hostUsage 拆 hostMain+hostSub / totalTokens 改 in+out）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/test/_p3-cost-selftest.mjs";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-realign-" + Date.now().toString(36), t);

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ① KIND_LIST 断言
rep(
  't("KIND_LIST: 13 环节且顺序与契约一致、已冻结", () => {\n  assert.deepEqual(KIND_LIST.slice(), [\n    "checkpointWrite", "rebuildInject", "startupInject", "recallReminder",\n    "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export", "hostUsage"\n  ]);\n  assert.equal(KIND_LIST.length, 13);',
  't("KIND_LIST: 15 环节（2026-11-02 口径拆分 +hostMain/+hostSub）且顺序与契约一致、已冻结", () => {\n  assert.deepEqual(KIND_LIST.slice(), [\n    "checkpointWrite", "rebuildInject", "startupInject", "recallReminder",\n    "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export",\n    "hostUsage", "hostMain", "hostSub"\n  ]);\n  assert.equal(KIND_LIST.length, 15);',
  "KIND_LIST"
);

// ② emptyCost EXPECT
rep(
  '    hostUsage: "inTokens,outTokens,totalTokens,cacheRead,cacheWrite,turns"\n  };',
  '    hostUsage: "inTokens,outTokens,totalTokens,cacheRead,cacheWrite,turns",\n' +
  '    hostMain: "n,inTokens,outTokens,totalTokens,cacheRead,cacheWrite",\n' +
  '    hostSub: "n,inTokens,outTokens,totalTokens,cacheRead,cacheWrite"\n  };',
  "EXPECT"
);
rep('t("emptyCost: 13 环节字段集与 §5.2 一致且全为 0"', 't("emptyCost: 15 环节字段集与 §5.2 一致且全为 0"', "emptyCost title");

// ③ 未知 kind：totals 键数 13→15
rep("  assert.equal(Object.keys(c.totals).length, 13);", "  assert.equal(Object.keys(c.totals).length, 15);", "unknown-kind count");

// ④ est.byKind 长度
rep("    assert.equal(Object.keys(x.est.byKind).length, 13);", "    assert.equal(Object.keys(x.est.byKind).length, 15);", "est.byKind length");

// ⑤ buildSample：hostUsage → hostMain + 新增 hostSub
rep(
  '  bumpKind(c, "hostUsage", { n: 4, inTokens: 1200, outTokens: 340, totalTokens: 9000, cacheReadTokens: 8400000 });',
  '  // [2026-11-02 口径拆分] 主会话 = hostMain（对照）；子代理 = hostSub（插件真实成本）\n' +
  '  bumpKind(c, "hostMain", { n: 4, inTokens: 1200, outTokens: 340, cacheReadTokens: 8400000 });\n' +
  '  bumpKind(c, "hostSub", { n: 2, inTokens: 500, outTokens: 100, cacheReadTokens: 200000 });',
  "bumpSample hostMain/hostSub"
);
rep(
  '  addDaily(c, today, "hostUsage", { n: 4, inTokens: 1200, outTokens: 340, totalTokens: 9000, cacheReadTokens: 8400000 });',
  '  addDaily(c, today, "hostMain", { n: 4, inTokens: 1200, outTokens: 340, cacheReadTokens: 8400000 });\n' +
  '  addDaily(c, today, "hostSub", { n: 2, inTokens: 500, outTokens: 100, cacheReadTokens: 200000 });',
  "addDaily hostMain/hostSub"
);

// ⑥ today.real 断言（现在 = hostSub）；补 realMain 断言
rep(
  '  assert.deepEqual(s.today.real, {\n    inTokens: 1200, outTokens: 340, cacheRead: 8400000, cacheWrite: 0, totalTokens: 9000, turns: 4\n  });',
  '  // [2026-11-02] real = 插件真实成本（hostSub 子代理桶）；realMain 才是用户对话（对照）\n' +
  '  assert.deepEqual(s.today.real, {\n    inTokens: 500, outTokens: 100, cacheRead: 200000, cacheWrite: 0, totalTokens: 600, turns: 2\n  });\n' +
  '  assert.deepEqual(s.today.realMain, {\n    inTokens: 1200, outTokens: 340, cacheRead: 8400000, cacheWrite: 0, totalTokens: 1540, turns: 4\n  });',
  "today.real"
);

// ⑦ cumulative.real.turns → hostSub 的 turns
rep("  assert.equal(s.cumulative.real.turns, 4);", "  assert.equal(s.cumulative.real.turns, 2);   // hostSub（子代理）轮次", "cumulative.real.turns");

// ⑧ 兜底断言：totalTokens 改 in+out（不含 cacheRead）
rep(
  't("summarize: real.totalTokens 缺省时按 in+out+cacheRead+cacheWrite 兜底", () => {\n  const c = emptyCost();\n  addDaily(c, "2026-11-02", "hostUsage", { n: 1, inTokens: 5578, outTokens: 73, cacheReadTokens: 95488 });\n  const s = summarize(c, { todayKey: "2026-11-02" });\n  assert.equal(s.today.real.totalTokens, 101139);   // 实测口径\n  assert.equal(s.today.real.cacheRead, 95488);\n});',
  't("summarize: real.totalTokens = 计费口径 in+out（2026-11-02 修正：不再累加上下文快照、不含 cacheRead）", () => {\n  const c = emptyCost();\n  addDaily(c, "2026-11-02", "hostSub", { n: 1, inTokens: 5578, outTokens: 73, cacheReadTokens: 95488 });\n  const s = summarize(c, { todayKey: "2026-11-02" });\n  assert.equal(s.today.real.totalTokens, 5651);     // 5578 + 73（cacheRead 单独列，不并入消耗）\n  assert.equal(s.today.real.cacheRead, 95488);\n});',
  "real fallback"
);

fs.writeFileSync(P, t, "utf8");
console.log("selftest written:", t.length);
