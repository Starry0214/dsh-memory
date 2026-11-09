// collectKinds：host* 三桶的 n 是「宿主轮次」，不计入插件记账次数 totalN
import fs from "node:fs";
const P = "E:/工具/插件开发调整/dsh-memory-plugin/p3-cost.js";
let t = fs.readFileSync(P, "utf8");
const OLD = '    const n = k === "hostUsage" ? rec.turns : rec.n;';
const NEW = '    // host* 三个桶记的是「宿主轮次」，不是插件记账次数 ⇒ 不计入 totalN（面板「次数」列口径）\n' +
  '    const isHost = k === "hostUsage" || k === "hostMain" || k === "hostSub";\n' +
  '    const n = isHost ? (rec.turns || rec.n) : rec.n;';
const OLD2 = '    if (k !== "hostUsage") totalN += n;';
const NEW2 = '    if (!isHost) totalN += n;';
const i = t.indexOf(OLD);
if (i < 0) throw new Error("anchor1 not found");
if (t.indexOf(OLD, i + 1) >= 0) throw new Error("anchor1 not unique");
t = t.replace(OLD, NEW);
const j = t.indexOf(OLD2);
if (j < 0) throw new Error("anchor2 not found");
t = t.replace(OLD2, NEW2);
fs.writeFileSync(P, t, "utf8");
console.log("OK collectKinds fixed, size:", t.length);
