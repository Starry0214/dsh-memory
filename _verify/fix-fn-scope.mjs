// 把误插进 try{} 块内的 P3-1 函数块移到 apply 函数体层级（修复 "is not defined"）
import fs from "node:fs";

const FILE = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let txt = fs.readFileSync(FILE, "utf8");
const backup = FILE + ".bak-movefn-" + Date.now().toString(36);
fs.writeFileSync(backup, txt);
console.log("backup:", backup);

const anchorA = "    // ═══════════════════════════════════════════════════════════════════════════\n    // [P3-1 写侧触发·Patch 2]";
const anchorB = "      ctx.interval(() => {\n        checkIntegrate();";
const anchorC = "    // 定时器：每小时检查一次（宿主常驻进程；fiber 清理时自动 dispose）\n    try {";

const ia = txt.indexOf(anchorA);
const ib = txt.indexOf(anchorB);
const ic = txt.indexOf(anchorC);
console.log("ia=", ia, "ib=", ib, "ic=", ic);
if (ia < 0 || ib < 0 || ic < 0) { console.error("anchor not found"); process.exit(1); }


const block = txt.slice(ia, ib);
console.log("block lines:", block.split("\n").length, "chars:", block.length);
console.log("block head:", JSON.stringify(block.slice(0, 80)));
console.log("block tail:", JSON.stringify(block.slice(-120)));

// 校验：块内必须含三个函数定义，且不含 checkIntegrate
for (const fn of ["function p3SpawnThresholdCheckpoint", "function p3SessionEndSweep", "function p3CoverageSweep"]) {
  if (!block.includes(fn)) { console.error("missing in block:", fn); process.exit(1); }
}
if (block.includes("checkIntegrate()")) { console.error("block unexpectedly contains checkIntegrate()"); process.exit(1); }

// 删除块 → 插到 try 之前
let out = txt.slice(0, ia) + txt.slice(ib);
const ic2 = out.indexOf(anchorC);
out = out.slice(0, ic2) + block + out.slice(ic2);

fs.writeFileSync(FILE, out, "utf8");
console.log("written. new size:", out.length, "delta:", out.length - txt.length);
