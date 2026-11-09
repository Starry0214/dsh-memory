// 面板口径更新：hostUsage 拆出 hostMain/hostSub（2026-11-02）
import fs from "node:fs";

const P = "C:/Users/Starry/.dsh/memory/.stats-panel.html";
let t = fs.readFileSync(P, "utf8");
const bak = P + ".bak-hosts-" + Date.now().toString(36);
fs.writeFileSync(bak, t);
console.log("backup:", bak);

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ① 表格顺序：hostMain/hostSub 追加在末尾
rep(
  'var COST_KIND_ORDER = ["checkpointWrite", "rebuildInject", "startupInject", "recallReminder", "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export", "hostUsage"];',
  'var COST_KIND_ORDER = ["checkpointWrite", "rebuildInject", "startupInject", "recallReminder", "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export", "hostSub", "hostMain", "hostUsage"];',
  "KIND_ORDER"
);

// ② 中文名
rep(
  '  export: "导出 _export",\n  hostUsage: "宿主 usage"\n};',
  '  export: "导出 _export",\n' +
  '  // [2026-11-02 口径拆分] 原 hostUsage 是主会话+子代理混桶，被当成"插件消耗"展示会误导；\n' +
  '  //   hostSub = 子代理（writer/dream/archive）= **插件真实成本**；hostMain = 用户对话（**非插件开销**，仅对照）；\n' +
  '  //   hostUsage = 拆分前的历史混合数据（新数据不再写入）。\n' +
  '  hostSub: "子代理 usage（插件真实成本）",\n' +
  '  hostMain: "主会话 usage（对照·非插件开销）",\n' +
  '  hostUsage: "宿主 usage（历史混合桶）"\n};',
  "KIND_LABEL"
);

// ③ turns 判断：三个 host* 桶都用 turns/n
const turnsFixes = [
  ['var n = kind === "hostUsage" ? costN(r.turns) : costN(r.n);', 'var n = /^host/.test(kind) ? (costN(r.turns) || costN(r.n)) : costN(r.n);'],
  ['if (f === "turns" && kind !== "hostUsage") continue;', 'if (f === "turns" && !/^host/.test(kind)) continue;'],
  ['costDur(r.durMs, kind === "hostUsage" ? r.turns : r.n)', 'costDur(r.durMs, /^host/.test(kind) ? (r.turns || r.n) : r.n)'],
];
for (const [o, n] of turnsFixes) {
  if (t.indexOf(o) >= 0) { t = t.split(o).join(n); console.log("OK turns-fix:", o.slice(0, 40)); }
}

fs.writeFileSync(P, t, "utf8");
console.log("panel written:", t.length);
