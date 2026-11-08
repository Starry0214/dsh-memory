#!/usr/bin/env node
/**
 * _p3-readside-selftest.mjs —— P3-2 读侧纯函数自测（R1 启动纪律头 / 上会话桥接 / R3 轻提醒）
 *
 * 跑法：node test/_p3-readside-selftest.mjs
 * 覆盖：全空输入、只有纪律头、超预算丢段顺序（纪律头永存）、bridge 无上会话返回空、
 *       ageHours 文案（0/1/23/25 小时）、nudge 轮次 0/7/8/9/16/17、topicHint 空降级、
 *       纯函数纪律（无 import/时钟/IO）、单文件行数上限。
 * 只读：模块本身纯函数无 IO；本脚本只额外读自己的模块源码做静态纪律检查。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_BUDGETS,
  buildStartupHeader,
  buildPreviousSessionBridge,
  buildRecallNudge,
  shouldNudge,
  formatAgeHours,
} from "../p3-readside.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "..", "p3-readside.js");

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail !== undefined ? " — " + detail : ""));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 造一段约 chars 字的正文（每行 ~35 字，便于验证「行边界截断」不留半行） */
function mkBody(chars, tag) {
  const lines = [];
  let n = 0;
  for (let i = 0; n < chars; i++) {
    const ln = tag + "-" + String(i).padStart(3, "0") + "-" + "记忆".repeat(12);
    lines.push(ln);
    n += ln.length + 1;
  }
  return lines.join("\n");
}

// ══ A. R1 启动纪律头 ═══════════════════════════════════════════════════════
// A1-A8 全空 / 只有纪律头
const a0 = buildStartupHeader({});
ok(a0.text.includes("【读取纪律】"), "A1 全空输入仍出纪律头");
ok(a0.sections.length === 1 && a0.sections[0].key === "discipline", "A2 全空 ⇒ 只 1 段（纪律）", JSON.stringify(a0.sections.map((s) => s.key)));
ok(a0.dropped.length === 0, "A3 全空 dropped 为空", JSON.stringify(a0.dropped));
ok(a0.chars === a0.text.length, "A4 chars = text.length", a0.chars + " vs " + a0.text.length);
ok(a0.text.includes("先看记忆再动手") && a0.text.includes("有疑问先 memory_search"), "A5 纪律含两条硬口径（先看记忆再动手 / 有疑问先 memory_search）");
ok(a0.text.includes("不要重复") && a0.text.includes("用户最新消息"), "A6 纪律含「勿重复 read」+「以用户最新消息为准」");
ok(a0.sections[0].chars === a0.text.length && a0.sections[0].bodyChars > 0, "A7 sections[0].chars 与 text 一致", a0.sections[0].chars + " vs " + a0.chars);
const aBlank = buildStartupHeader({ checkpoint: "   ", previousBridge: "", projectMemory: null, profileText: "\n" });
ok(aBlank.sections.length === 1, "A8 空白段不装配（只留纪律）", JSON.stringify(aBlank.sections.map((s) => s.key)));

// A9-A13 五段固定顺序 + 装配口径
const CP = mkBody(900, "CP");
const BR = mkBody(900, "BR");
const PJ = mkBody(900, "PJ");
const PF = mkBody(900, "PF");
const makeAll = (budgetChars) => buildStartupHeader({
  checkpoint: CP, previousBridge: BR, projectMemory: PJ, profileText: PF,
  ...(budgetChars === undefined ? {} : { budgetChars }),
});
const full = makeAll();
const ORDER = ["【读取纪律】", "【当前会话检查点】", "【上一个会话桥接】", "【项目记忆】", "【用户画像】"];
const idx = ORDER.map((h) => full.text.indexOf(h));
ok(idx.every((x, i) => x >= 0 && (i === 0 || x > idx[i - 1])), "A9 五段固定顺序 纪律→检查点→桥接→项目→画像", JSON.stringify(idx));
ok(full.sections.length === 5, "A10 sections 5 段", full.sections.length);
ok(full.dropped.length === 0 && full.chars <= READ_BUDGETS.startup, "A11 默认 6000 内不丢段", JSON.stringify({ dropped: full.dropped, chars: full.chars }));
ok(full.text.includes("\n\n【"), "A12 段间空行分隔");
const sumSec = full.sections.reduce((n, s) => n + s.chars, 0);
ok(sumSec + 2 * (full.sections.length - 1) === full.chars, "A13 sections.chars+分隔符 = 总 chars", sumSec + "+" + 2 * (full.sections.length - 1) + " vs " + full.chars);

// A14-A17 宽容输入 / 别名（Lead 口径：主用 previousBridge，sessionTopic/bridge 兼容）
const aObj = buildStartupHeader({
  checkpoint: { text: "CP-标记" }, previousBridge: { body: "BR-标记" },
  projectMemory: { md: "PJ-标记" }, profileText: { text: "PF-标记" },
});
ok(["CP-标记", "BR-标记", "PJ-标记", "PF-标记"].every((m) => aObj.text.includes(m)), "A14 对象输入取 text/body/md 字段");
const aAlias = buildStartupHeader({ sessionTopic: "来自 sessionTopic" });
ok(aAlias.text.includes("【上一个会话桥接】") && aAlias.text.includes("来自 sessionTopic"), "A15 sessionTopic 兼容别名可用");
const aBridge = buildStartupHeader({ sessionTopic: "旧-标记", bridge: "新-标记" });
ok(aBridge.text.includes("新-标记") && !aBridge.text.includes("旧-标记"), "A16 bridge 别名优先于 sessionTopic");
ok(buildStartupHeader({ previousBridge: "主用 previousBridge" }).text.includes("主用 previousBridge"), "A17 previousBridge 主参数可用");

// A18-A28 超预算倒序丢：画像 → 项目 → 桥接（纪律头永不丢）
const d1 = makeAll(full.chars - 1);
ok(eq(d1.dropped, ["profile"]), "A18 超 1 字先丢画像", JSON.stringify(d1.dropped));
ok(d1.text.includes("【读取纪律】") && !d1.text.includes("【用户画像】"), "A19 丢画像后纪律头仍在、画像消失");
const d2 = makeAll(d1.chars - 1);
ok(eq(d2.dropped, ["profile", "project"]), "A20 再超 ⇒ 丢项目记忆", JSON.stringify(d2.dropped));
ok(d2.text.includes("【上一个会话桥接】") && !d2.text.includes("【项目记忆】"), "A21 桥接未动、项目消失");
const d3 = makeAll(d2.chars - 1);
ok(eq(d3.dropped, ["profile", "project", "bridge"]), "A22 再超 ⇒ 丢上会话桥接", JSON.stringify(d3.dropped));
ok(!d3.text.includes("【上一个会话桥接】") && d3.text.includes("【当前会话检查点】"), "A23 桥接消失、检查点保留");
const d4 = makeAll(d3.chars - 1);
ok(eq(d4.dropped, ["profile", "project", "bridge", "checkpoint:truncated"]), "A24 三段丢完仍超 ⇒ 按行边界截检查点", JSON.stringify(d4.dropped));
ok(d4.text.includes("【读取纪律】") && d4.text.includes("【当前会话检查点】") && d4.chars <= d3.chars - 1, "A25 截检查点仍保纪律头且落回预算内", d4.chars + " vs " + (d3.chars - 1));
const d5 = makeAll(1);
ok(d5.text.startsWith("【读取纪律】") && !d5.text.includes("【当前会话检查点】"), "A26 预算小于纪律头 ⇒ 仍返回纪律头（永不丢）");
ok(eq(d5.dropped, ["profile", "project", "bridge", "checkpoint"]), "A27 极端预算 dropped 留痕完整", JSON.stringify(d5.dropped));
ok(d1.chars <= full.chars - 1 && d2.chars <= d1.chars - 1 && d3.chars <= d2.chars - 1, "A28 逐级丢段后长度单调下降");

// ══ B. 上会话桥接 ═════════════════════════════════════════════════════════
// B1-B3 空输入
const b0 = buildPreviousSessionBridge({});
ok(b0.text === "" && b0.chars === 0 && b0.dropped.length === 0, "B1 无上会话 ⇒ 返回空", JSON.stringify(b0));
ok(buildPreviousSessionBridge({ prevCheckpoint: "   \n\t " }).text === "", "B2 空白上会话 ⇒ 返回空");
ok(buildPreviousSessionBridge({ prevCheckpoint: null, wsKey: "E-工具-插件开发调整", ageHours: 3 }).text === "", "B3 prevCheckpoint=null ⇒ 返回空（wsKey 不兜底乱注）");

// B4-B10 正常装配 + 首行标注 + ≤1500
const CP_PREV = "## 本次目标\n继续做 P3-2 读侧\n## 下一步行动\n接线 index.js";
const eb = buildPreviousSessionBridge({ prevCheckpoint: CP_PREV, wsKey: "E-工具-插件开发调整", ageHours: 3 });
ok(eb.text.split("\n")[0] === "（上一个会话 · 3 小时前）", "B4 首行「（上一个会话 · N 小时前）」", eb.text.split("\n")[0]);
ok(eb.text.includes(CP_PREV), "B5 正文原样保留（精确字面量不改写）");
ok(eb.chars === eb.text.length && eb.chars <= READ_BUDGETS.bridge, "B6 ≤1500 且 chars 正确", eb.chars);
ok(eb.text.split("\n")[1] === "## 本次目标", "B7 首行标注独立成行、正文从第二行开始");
ok(buildPreviousSessionBridge({ prevCheckpoint: CP_PREV, wsKey: "A", ageHours: 3 }).text
  === buildPreviousSessionBridge({ prevCheckpoint: CP_PREV, wsKey: "B", ageHours: 3 }).text, "B8 wsKey 不进正文（选择逻辑在调用方）");

// B9-B15 ageHours 文案 0/1/23/25
const ageHead = (h) => buildPreviousSessionBridge({ prevCheckpoint: "X", ageHours: h }).text.split("\n")[0];
ok(ageHead(0) === "（上一个会话 · 不到 1 小时前）", "B9 ageHours=0 ⇒ 不到 1 小时前", ageHead(0));
ok(ageHead(1) === "（上一个会话 · 1 小时前）", "B10 ageHours=1 ⇒ 1 小时前", ageHead(1));
ok(ageHead(23) === "（上一个会话 · 23 小时前）", "B11 ageHours=23 ⇒ 23 小时前", ageHead(23));
ok(ageHead(25) === "（上一个会话 · 1 天前）", "B12 ageHours=25 ⇒ 1 天前", ageHead(25));
ok(ageHead(0.5) === "（上一个会话 · 不到 1 小时前）", "B13 ageHours=0.5 ⇒ 不到 1 小时前", ageHead(0.5));
ok(buildPreviousSessionBridge({ prevCheckpoint: "X" }).text.split("\n")[0] === "（上一个会话）", "B14 缺 ageHours ⇒ 只标「上一个会话」");
ok(formatAgeHours(null) === "" && formatAgeHours(-1) === "" && formatAgeHours(NaN) === "", "B15 缺省/非法 age ⇒ 空标注");

// B16-B21 截断：默认 1500 / 自定义预算 / 行边界 / 过小预算
const big = mkBody(5000, "BR");
const et = buildPreviousSessionBridge({ prevCheckpoint: big, ageHours: 2 });
ok(et.chars <= READ_BUDGETS.bridge, "B16 超长上会话 ⇒ 默认 ≤1500", et.chars);
ok(et.dropped.includes("bridge:truncated"), "B17 截断留痕 bridge:truncated", JSON.stringify(et.dropped));
ok(et.text.startsWith("（上一个会话 · 2 小时前）\n"), "B18 截断后首行标注仍在");
const bigLines = new Set(big.split("\n"));
ok(et.text.split("\n").slice(1).every((l) => bigLines.has(l)), "B19 行边界截断（无半截行）");
const eCustom = buildPreviousSessionBridge({ prevCheckpoint: mkBody(3000, "BR"), ageHours: 1, budgetChars: 300 });
ok(eCustom.chars <= 300 && eCustom.dropped.includes("bridge:truncated"), "B20 自定义 budgetChars 生效", eCustom.chars);
const eTiny = buildPreviousSessionBridge({ prevCheckpoint: "X", ageHours: 1, budgetChars: 5 });
ok(eTiny.text === "" && eTiny.dropped.includes("bridge:empty"), "B21 预算小到放不下正文 ⇒ 空（不留裸标题）", JSON.stringify(eTiny));

// ══ C. R3 轻提醒 ═══════════════════════════════════════════════════════════
// C1-C9 轮次 0/7/8/9/16/17 + everyN 可配
ok(buildRecallNudge({ turn: 0 }) === null, "C1 轮次 0 不提醒（启动已由 R1 注入）");
ok(buildRecallNudge({ turn: 7 }) === null, "C2 轮次 7 不提醒");
const n8 = buildRecallNudge({ turn: 8, topicHint: "OA 踩坑" });
ok(typeof n8 === "string" && n8.length > 0 && n8.length <= READ_BUDGETS.nudge, "C3 轮次 8 提醒且 ≤200 字", n8 && n8.length);
ok(n8.includes("如需历史细节") && n8.includes("memory_search：OA 踩坑"), "C4 文案含「如需历史细节可 memory_search：<topicHint>」", n8);
ok(buildRecallNudge({ turn: 9 }) === null, "C5 轮次 9 不提醒");
ok(typeof buildRecallNudge({ turn: 16 }) === "string", "C6 轮次 16 提醒");
ok(buildRecallNudge({ turn: 17 }) === null, "C7 轮次 17 不提醒");
ok(buildRecallNudge({ turn: 8, everyN: 4 }) !== null && buildRecallNudge({ turn: 9, everyN: 4 }) === null && buildRecallNudge({ turn: 4, everyN: 4 }) !== null, "C8 everyN 可配（4/8 提醒、9 不提醒）");
ok(buildRecallNudge({ turn: 8, everyN: 0 }) === null && buildRecallNudge({ turn: 8, everyN: -8 }) === null, "C9 everyN 非正 ⇒ 关闭");

// C10-C16 topicHint 空/超长降级 + 内容口径
const nEmpty = buildRecallNudge({ turn: 8, topicHint: "" });
ok(typeof nEmpty === "string" && nEmpty.includes("memory_search（") && !nEmpty.includes("memory_search：。"), "C10 topicHint 为空 ⇒ 降级文案（不出现空冒号）", nEmpty);
ok(!/memory_search：\s*。/.test(nEmpty), "C11 降级文案无空冒号");
ok(buildRecallNudge({ turn: 8 }) === nEmpty, "C12 缺 topicHint 与空串同款降级");
const nLong = buildRecallNudge({ turn: 8, topicHint: "关".repeat(500) });
ok(typeof nLong === "string" && nLong.length <= READ_BUDGETS.nudge, "C13 超长 topicHint 收口到 ≤200", nLong && nLong.length);
ok(nLong.includes("memory_search"), "C14 收口后仍保留检索指引");
ok(n8.includes("记忆是当时主张") && n8.includes("用户最新消息"), "C15 提醒含「用前验证 / 以用户最新为准」纪律口径");
ok(buildRecallNudge({ turn: null }) === null && buildRecallNudge({}) === null, "C16 非法轮次 ⇒ null");

// ══ D. shouldNudge 轮次边界 ════════════════════════════════════════════════
ok(shouldNudge({ turn: 8 }) === true, "D1 默认 everyN=8，轮次 8 ⇒ true");
ok(shouldNudge({ turn: 0 }) === false, "D2 轮次 0 ⇒ false");
ok(shouldNudge({ turn: 7 }) === false && shouldNudge({ turn: 9 }) === false && shouldNudge({ turn: 17 }) === false, "D3 非整数倍 ⇒ false");
ok(shouldNudge({ turn: 16 }) === true, "D4 轮次 16 ⇒ true");
ok(shouldNudge({ turn: 8, lastNudgeTurn: 8 }) === false, "D5 同一轮不重复");
ok(shouldNudge({ turn: 16, lastNudgeTurn: 8 }) === true, "D6 跨轮仍可提醒");
ok(shouldNudge({ turn: 8, everyN: 0 }) === false, "D7 everyN=0 ⇒ 关闭");
ok(shouldNudge({ turn: 7, everyN: 7 }) === true, "D8 everyN=7 时轮次 7 提醒");
ok(shouldNudge({ turn: null }) === false && shouldNudge({ turn: -8 }) === false, "D9 非法轮次 ⇒ false");
ok(shouldNudge({ turn: 8, lastNudgeTurn: "8" }) === false, "D10 lastNudgeTurn 字符串兼容");
let consist = true;
for (let t = 0; t <= 40; t++) {
  if (shouldNudge({ turn: t }) !== (buildRecallNudge({ turn: t }) !== null)) consist = false;
}
ok(consist, "D11 shouldNudge 与 buildRecallNudge 轮次口径一致（0..40）");

// ══ E. 常量 / 纯函数纪律 / 行数上限 ═══════════════════════════════════════
ok(READ_BUDGETS.startup === 6000 && READ_BUDGETS.bridge === 1500 && READ_BUDGETS.nudge === 200, "E1 READ_BUDGETS 值正确", JSON.stringify(READ_BUDGETS));
ok(Object.isFrozen(READ_BUDGETS), "E2 READ_BUDGETS 冻结");
const src = fs.readFileSync(SRC_PATH, "utf8");
ok(!/^\s*import\s/m.test(src), "E3 模块无 import（纯 ESM 零依赖）");
ok(!/\brequire\s*\(/.test(src), "E4 模块无 require");
ok(!/\bDate\.now\b|new\s+Date\s*\(/.test(src), "E5 模块不读系统时钟（时间由参数传入）");
ok(!/node:fs|node:net|node:http|\bfetch\s*\(/.test(src), "E6 模块不读盘/不联网");
ok(src.split("\n").length <= 350, "E7 模块单文件 ≤350 行", src.split("\n").length);
const p1 = buildStartupHeader({ checkpoint: CP_PREV, previousBridge: CP_PREV, projectMemory: PJ, profileText: PF });
const p2 = buildStartupHeader({ checkpoint: CP_PREV, previousBridge: CP_PREV, projectMemory: PJ, profileText: PF });
ok(p1.text === p2.text && eq(p1.sections, p2.sections), "E8 纯函数确定性（同输入同输出）");

// ══ 汇总 ═══════════════════════════════════════════════════════════════════
if (fails.length) {
  console.log("FAIL 清单：");
  for (const f of fails) console.log("  - " + f);
}
console.log(`\nP3-2 readside selftest: PASS ${pass} / FAIL ${fails.length}`);
if (fails.length) process.exit(1);
console.log("全部通过 " + pass + "/" + pass);
