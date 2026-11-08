#!/usr/bin/env node
/**
 * _p2-selftest.mjs —— P2 检查点升级 实现方自测（纯函数层）
 *
 * 与独立验收脚本 `_accept-p2.mjs`（44 条端到端断言）互补：本文件只测纯函数/常量，
 * 快速回归 P2 的四个契约面：8 节定义、结构校验、归一化删序、注入槽预算。
 *
 * 跑法：node test/_p2-selftest.mjs [index.js 路径]
 * 只读：临时 HOME，不动真实记忆库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TARGET = process.argv[2] || path.join(process.cwd(), "index.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p2-self-"));
process.env.DSH_HOME = tmp;
process.env.DSH_MEMORY_ROOT = path.join(tmp, "memory-only");

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? " — " + detail : ""));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const mod = await import(pathToFileURL(TARGET).href);
const S8 = mod.__intentSections8;
const LEGACY = mod.__intentLegacySections;
const TB = mod.__intentTotalBudget;
const DEL = mod.__intentDeleteOrder;
const V = mod.__validateMdStructure;
const N = mod.__normalizeCheckpoint;
const BI = mod.__buildSummaryInjection;
const SUMB = mod.SUMMARY_SLOT_BUDGET;
const CK = mod.__p2Hooks || {};

const TITLES = ["本次目标", "当前状态", "下一步行动", "关键结论", "文件与代码", "错误与修复", "任务与待办", "未决问题"];
const mk = (sizes, marks) => TITLES.map((n) => {
  const size = Number((sizes && sizes[n]) || 300);
  const mark = (marks && marks[n]) ? marks[n] + "\n" : "";
  const lines = [];
  let cur = mark.length;
  for (let i = 0; cur < size; i++) { const ln = "内容" + i + "-" + "字".repeat(Math.max(1, 34 - String(i).length)); lines.push(ln); cur += ln.length + 1; }
  return "## " + n + "\n" + mark + lines.join("\n");
}).join("\n\n") + "\n";

// ① 8 节定义
ok(Array.isArray(S8) && S8.length === 8, "S1 sections 为 8 节", S8 && S8.length);
ok(eq(S8.map((x) => x.name), TITLES), "S2 8 节标题逐字+顺序", JSON.stringify(S8.map((x) => x.name)));
ok(S8.filter((x) => x.core).length === 4, "S3 核心节 4 个（本次目标/当前状态/下一步行动/关键结论）", JSON.stringify(S8.filter((x) => x.core).map((x) => x.name)));
ok(eq(Array.from(LEGACY), ["本次目标", "下一步行动", "关键结论"]), "S4 历史三节兼容列表", JSON.stringify(LEGACY));
ok(TB === 3000, "S5 总预算 3000", TB);
ok(eq(Array.from(DEL), ["文件与代码", "错误与修复", "任务与待办", "未决问题"]), "S6 删序 文件→错误→任务→未决（v4.5.4 反转）", JSON.stringify(DEL));

// ② 结构校验
const good = mk();
ok(V(good, { requireSections: true, sections: S8 }).ok === true, "S7 8 节合规 ⇒ 通过");
ok(V(good, { requireSections: true }).ok === true, "S8 不传 sections ⇒ 老兼容模式仍通过");
const miss = good.replace(/## 错误与修复[\s\S]*?(?=\n## )/, "");
ok(V(miss, { requireSections: true, sections: S8 }).ok === false, "S9 缺节 ⇒ 拒绝");
const swapped = good.replace(/## 本次目标\n([\s\S]*?)\n## 当前状态/, "## 当前状态\n$1\n## 本次目标");
ok(V(swapped, { requireSections: true, sections: S8 }).ok === false, "S10 乱序 ⇒ 拒绝");
ok(V(good, { requireSections: true, sections: S8, allowLegacySections: true }).ok === true, "S11 allowLegacy 不误伤 8 节");

// ③ 归一化删序
const n1 = N(mk({ 未决问题: 1400 }), { sections: S8, totalBudget: TB, deleteOrder: DEL });
ok(n1.dropped[0] === "文件与代码" && n1.text.includes("## 未决问题") && !n1.text.includes("## 文件与代码"), "N1 超限先删「文件与代码」，未决问题保留", JSON.stringify(n1.dropped));
ok(n1.text.includes("## 本次目标") && n1.text.includes("## 关键结论"), "N2 核心节不删");
ok(n1.chars <= TB, "N3 删除后 ≤3000", n1.chars);
const n2 = N(mk({ 文件与代码: 1200, 错误与修复: 800, 任务与待办: 400, 未决问题: 400 }),
  { sections: S8, totalBudget: TB, deleteOrder: DEL });
ok(n2.dropped[0] === "文件与代码" && !n2.text.includes("## 文件与代码") && n2.text.includes("## 未决问题") && n2.text.includes("## 任务与待办") && n2.text.includes("## 错误与修复"),
  "N4 新删序先删文件与代码（未决/任务/错误保留）", JSON.stringify(n2.dropped));
ok(n2.dropped.join("/") === "文件与代码" && n2.text.includes("## 未决问题"), "N5 删序：文件最先、未决最后（本 case 未决仍在）", JSON.stringify(n2.dropped));
ok(n2.chars <= TB, "N6 case3 ≤3000", n2.chars);
const half = N(mk({ 未决问题: 400 }, { 关键结论: "GUID-12345678-abcdef" }), { sections: S8, totalBudget: 100, deleteOrder: DEL });
ok(!/GUID-12345678-abcd[^b]/.test(half.text.replace(/\n/g, " ")) || half.text.includes("GUID-12345678-abcdef"), "N7 不切半字面量", "residual=" + half.residual);
// [v4.5.4] 指针断言：只在末尾出现一次、chars 含指针、dropped 不含未决
const nPtr = N(mk({ 未决问题: 1400 }), { sections: S8, totalBudget: TB, deleteOrder: DEL, sid8: "1b736c53" });
ok(/> 预算压缩：已删「/.test(nPtr.pointer) && /session_search sid8=1b736c53/.test(nPtr.pointer), "N9 指针行含删节列表 + sid8", nPtr.pointer);
ok((nPtr.text.match(/> 预算压缩：/g) || []).length === 1 && nPtr.text.slice(-nPtr.pointer.length) === nPtr.pointer, "N10 指针只在末尾出现一次（footer，不逐节）");
ok(nPtr.chars === nPtr.text.length && nPtr.text.includes(nPtr.pointer) && nPtr.chars > nPtr.pointer.length, "N11 norm.chars 含指针字数", "chars=" + nPtr.chars + " ptr=" + nPtr.pointer.length);
ok(!nPtr.dropped.includes("未决问题"), "N12 dropped 不含未决问题", JSON.stringify(nPtr.dropped));
// 注入端 priority：未决加入后，2400 截断时其正文保留量显著高于未加时
const SAMPLE8 = ["本次目标","当前状态","下一步行动","关键结论","文件与代码","错误与修复","任务与待办","未决问题"].map((n) => "## " + n + "\n" + "L".repeat(n === "未决问题" ? 1500 : 300)).join("\n\n");
const _sliceSeg = (t) => t.slice(t.indexOf("## 未决问题"));
const _withPrio = mod.__sectionAwareSlice(SAMPLE8, 2400, "t", { priority: ["本次目标", "当前状态", "下一步行动", "关键结论", "未决问题"] });
const _noPrio = mod.__sectionAwareSlice(SAMPLE8, 2400, "t", { priority: ["本次目标", "当前状态", "下一步行动", "关键结论"] });
ok(_sliceSeg(_withPrio.text).length > _sliceSeg(_noPrio.text).length * 2 && _sliceSeg(_withPrio.text).length > 500, "N13 注入 priority 含未决：2400 截断后未决正文保留量 > 未加时 2 倍", "with=" + _sliceSeg(_withPrio.text).length + " without=" + _sliceSeg(_noPrio.text).length);
const empty = N("", { sections: S8 });
ok(empty.text === "" && empty.chars === 0, "N8 空输入不抛");

// ④ 注入槽预算
ok(Number(SUMB.checkpoint) === 3000, "J1 检查点槽 3000", JSON.stringify(SUMB));
ok(Number(SUMB.userQuotes) === 1500 && Number(SUMB.taskState) === 500, "J2 用户原话 1500 / 任务状态 500", JSON.stringify(SUMB));
const LONG = "行".repeat(6000);
const b1 = BI({ checkpoint: LONG, userQuotes: "", taskState: "" });
ok(b1.totalChars <= 5000, "J3 默认总预算 5000", b1.totalChars);
ok(b1.slots.checkpoint.length <= 3000, "J4 检查点单槽 ≤3000（超出按行截断）", b1.slots.checkpoint.length);
ok(b1.dropped.includes("checkpoint:truncated"), "J5 截断留痕", JSON.stringify(b1.dropped));
const b2 = BI({ checkpoint: "## 本次目标\nA\n\n## 下一步行动\nB\n\n## 关键结论\nC", userQuotes: "原话", taskState: "任务" });
ok(b2.text.includes("## 关键结论") && b2.text.includes("原话"), "J6 历史三节检查点仍可注入（不报错）");
const b3 = BI({ checkpoint: "", userQuotes: "", taskState: "" });
ok(b3.totalChars === 0, "J7 空注入 → 0 字");

// ⑤ 提示词（8 节 + 两段材料标记）
if (typeof CK.buildCheckpointPrompt === "function") {
  const p = CK.buildCheckpointPrompt("===== 最近对话原文 =====\nQUOTE\n===== 任务与待办 =====\nTODO\n===== 宿主压缩摘要 =====\nSUM");
  ok(TITLES.every((n) => p.includes("## " + n)), "P1 提示词含 8 节标题", "");
  ok(p.includes("===== 最近对话原文 =====") && p.includes("===== 任务与待办 ====="), "P2 提示词含两段材料标记", "");
} else {
  console.log("SKIP P1/P2 提示词钩子（apply 后才赋值；由 _accept-p2 S1-S3 端到端覆盖）");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nP2 selftest: PASS ${pass} / FAIL ${fails.length}`);
if (fails.length) { console.log("FAIL 清单："); for (const f of fails) console.log("  - " + f); process.exit(1); }
console.log("全部通过 " + pass + "/" + pass);

