// _text-degeneration-selftest.mjs —— [E 类补强] 文本退化检测：滑窗盲区（单消息内反复刷同一句）
//
// 跑法：node test/_text-degeneration-selftest.mjs [index.js 路径]
//
// 背景（session-1b736c53，2026-11-04 20:35）：turn 920 step 6 的 assistant/message 里**只有一个 reasoning 块**、
//   25634 字，尾部全是 "Let me call." / "Let me do it." 交替（各 1300+ 次）。该 step 没有任何 tool-call
//   ⇒ spiralObserve 一次没被调用 ⇒ 滑窗不动 ⇒ D/E/W 三类全部失明（滑窗按「工具步」计量）。
//   本检测补这条盲区：从 assistant/message 的 content 直接判「块内同质重复」。
//
// 覆盖：
//   A 静态接线：函数/阈值/事件挂点/提示清洗
//   B 真样本：用真会话日志里的退化块 → 必须命中；正常块 → 必须不命中
//   C 负例：markdown 表格、代码块、正常长 reasoning、短文本 → 不命中
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const src = fs.readFileSync(PLUGIN, "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
}

// ── A 静态接线 ──
ok(/function detectTextDegeneration\(blocks\)/.test(src), "A1 检测函数存在");
ok(/const TEXT_DEG_MIN_ROWS = 20;/.test(src) && /const TEXT_DEG_MIN_REPEAT = 10;/.test(src), "A2 阈值常量（行数 20 / 重复 10）");
ok(/const TEXT_DEG_MAX_UNIQ_RATIO = 0\.25;/.test(src), "A3 唯一行占比上限 25%");
ok(/event\.type === "assistant\/message"[\s\S]{0,300}detectTextDegeneration\(_content\)/.test(src), "A4 挂在 session/event 的 assistant/message");
ok(/enqueueRegressionReminder\(session\.id, "E:text-loop"/.test(src), "A5 走 D/E 同款排队通道（下次 pre-step 直入）");
ok(/const _safeLine = String\(_deg\.maxLine \|\| ""\)\.replace\(\/\[<>\]\/g, ""\)/.test(src), "A6 提示注入清洗（剥尖括号）");
ok(/monitorHintE\(\)/.test(src) && /monitorEvent\("spiral", "text-degeneration/.test(src), "A7 提醒与埋点计数");
ok(/export \{ detectTextDegeneration as __detectTextDegeneration \}/.test(src), "A8 纯函数导出（门可直测）");
// 熔断档（2026-11-04 starry 要求「有什么办法直接熔断/终止」）
ok(/const TEXT_DEG_CANCEL_REPEAT = 50;/.test(src), "A10 熔断阈值 50 次");
ok(/if \(_deg\.cancelWorthy === true \|\| _deg\.maxN >= TEXT_DEG_CANCEL_REPEAT\)/.test(src), "A11 达到阈值才熔断（长行 50 次 / 短行 cancelWorthy≥40；低于只提醒）");
ok(/_ag\.cancel\(\{ kind: "hook", reason: "text-degeneration/.test(src), "A12 用宿主 AgentCancelCause 的 {kind:'hook'}（插件专用原因）");
ok(/_ag\.cancel\(\{[^}]*\}, \{ keepInbox: true \}\)/.test(src), "A13 keepInbox:true（保留用户排队输入，只中止当前 turn）");
ok(/typeof _ag\.cancel === "function"/.test(src), "A14 能力探测（旧宿主无 cancel 不炸）");

// ── 载入插件取纯函数 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-textdeg-"));
process.env.DSH_HOME = path.join(TMP, "home");
process.env.DSH_MEMORY_ROOT = path.join(TMP, "home", "memory");
process.env.MEMTOPIC_DB = path.join(TMP, "home", "memory", ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;
const mod = await import(pathToFileURL(PLUGIN).href);
const detect = mod.__detectTextDegeneration;
ok(typeof detect === "function", "A9 导出可取到", typeof detect);

if (typeof detect === "function") {
  // ── B 真样本（会话日志里的真实退化块）──
  const LOG = "C:/Users/Starry/.dsh/sessions/--E-~5DE5~5177-~5F95~5361~4E00~77AC--/session-1b736c53-7fc7-4be1-a22c-0fa4043c963e/session.v4.jsonl.zstd";
  let realDeg = null, realOk = null;
  try {
    const raw = zlib.zstdDecompressSync(fs.readFileSync(LOG)).toString("utf8");
    const lines = raw.split("\n");
    // 退化样本：line 46453（turn 920 step 6，25634 字）
    const j1 = JSON.parse(lines[46452]);
    const c1 = (j1.data && j1.data.message && j1.data.message.content) || [];
    realDeg = c1.find((b) => b && b.type === "reasoning") || null;
    // 正常样本：最后一条 assistant/message 的 reasoning（turn 921 step 13）
    const j2 = JSON.parse(lines[46572]);
    const c2 = (j2.data && j2.data.message && j2.data.message.content) || [];
    realOk = c2.find((b) => b && b.type === "reasoning") || null;
  } catch (e) {
    console.log("（读真日志失败，跳过 B 组：" + e.message + "）");
  }
  if (realDeg) {
    const d = detect([realDeg]);
    ok(!!d, "B1 真退化块（25634 字，Let me call×1342）必命中", d ? JSON.stringify(d).slice(0, 180) : "null");
    ok(!!d && d.maxN >= 10 && d.ratio >= 50, "B2 命中细节合理（重复≥10 次、占比≥50%）", d ? "maxN=" + d.maxN + " ratio=" + d.ratio + "%" : "-");
    ok(!!d && d.kind === "reasoning", "B3 识别为 reasoning 块（不是 text）", d && d.kind);
  } else {
    ok(true, "B1/B2/B3 跳过（无真样本）");
  }
  if (realOk) {
    const d2 = detect([realOk]);
    ok(!d2, "B4 真正常块（turn 921 step 13）不误报", d2 ? JSON.stringify(d2).slice(0, 160) : "null（正确）");
  } else {
    ok(true, "B4 跳过（无真样本）");
  }

  // ── C 合成负例 ──
  const mk = (t, n) => ({ type: "reasoning", text: Array.from({ length: n }, (_, i) => "分析第 " + i + " 点：这里的内容各不相同，用来模拟正常推理。").join("\n") });
  ok(!detect([mk("x", 30)]), "C1 正常长 reasoning（30 行各不相同）不误报");

  const table = { type: "text", text: "| 项 | 值 |\n|---|---|\n" + Array.from({ length: 30 }, (_, i) => "| 行" + i + " | 值" + i + " |").join("\n") };
  ok(!detect([table]), "C2 markdown 表格不误报（分隔行已排除）");

  const code = { type: "text", text: Array.from({ length: 40 }, (_, i) => "    console.log('line " + i + "');").join("\n") };
  ok(!detect([code]), "C3 代码块（每行不同）不误报");

  const short = { type: "text", text: "Let me call.\nLet me do it.\nLet me call.\nLet me do it." };
  ok(!detect([short]), "C4 短文本（<800 字）不误报");

  const deg2 = { type: "reasoning", text: Array.from({ length: 40 }, (_, i) => (i % 2 ? "Let me do it." : "Let me call.")).join("\n") };
  const d3 = detect([deg2]);
  ok(!!d3 && d3.maxN === 20, "C5 交替重复 40 行必命中（各 20 次）", d3 ? "maxN=" + d3.maxN + " ratio=" + d3.ratio + "%" : "null");

  // 混合块：一个正常块 + 一个退化块 → 应命中退化那个
  const d4 = detect([mk("y", 25), deg2]);
  ok(!!d4 && d4.maxN === 20, "C6 多块消息里命中退化块", d4 ? "maxN=" + d4.maxN : "null");

  // ── E 实时熔断（流式钩子）──
  const tail = mod.__textStreamTailRepeat;
  ok(typeof tail === "function", "E1 textStreamTailRepeat 导出可取到", typeof tail);
  if (typeof tail === "function") {
    ok(/compatOn\(ctx, "agent\/assistant-stream"/.test(src), "E2 已挂 agent/assistant-stream 流式钩子");
    // [CRA 2026-11-06] 原断言是 `... === false || true`（恒真、空断言）⇒ 改成可证伪的真断言：
    //   只累积 reasoning-delta / text-delta，其他 chunk 类型（tool-call-delta 等）不进缓冲区。
    ok(/c\.type !== "reasoning-delta" && c\.type !== "text-delta"/.test(src), "E3 只统计 reasoning/text delta（其他 chunk 不累积）");
    ok(/ag\.cancel\(\{ kind: "hook", reason: "text-degeneration-stream/.test(src), "E4 流式熔断用 {kind:'hook'}");
    ok(/if \(frame\.type === "end"\) \{ TEXT_STREAM_BUF\.delete\(key\)/.test(src), "E5 end 帧释放缓冲（防 Map 无限增长）");
    ok(/const sid = key\.split\(":"\)\[0\];/.test(src), "E6 attemptId 反解 sessionId");

    // 真样本：退化块尾部 3000 字必须命中
    if (realDeg) {
      const t = String(realDeg.text || "").slice(-3000);
      const h = tail(t);
      ok(!!h, "E7 真退化块尾部 3000 字必命中", h ? JSON.stringify(h).slice(0, 140) : "null");
    } else { ok(true, "E7 跳过（无真样本）"); }

    // 正常文本不误报
    const normalTail = Array.from({ length: 60 }, (_, i) => "第 " + i + " 行：这里是正常分析内容，每行都不一样。").join("\n");
    ok(!tail(normalTail), "E8 正常文本不误报");
    // 表格不误报
    const tableTail = "| a | b |\n|---|---|\n" + Array.from({ length: 40 }, (_, i) => "| 行" + i + " | 值" + i + " |").join("\n");
    ok(!tail(tableTail), "E9 表格不误报");
    // 退化必命中（流式尾部 40 行交替）
    const degTail = Array.from({ length: 40 }, (_, i) => (i % 2 ? "Let me do it." : "Let me call.")).join("\n");
    const h2 = tail(degTail);
    ok(!!h2 && h2.maxN === 20, "E10 流式尾部交替重复必命中", h2 ? "maxN=" + h2.maxN : "null");
    // 低于阈值的少量重复不熔断
    const few = Array.from({ length: 30 }, (_, i) => (i < 5 ? "重复行" : "正常行 " + i)).join("\n");
    ok(!tail(few), "E11 少量重复（5 次 < 30）不熔断");

    // ── [熔断补漏 2026-11-05] 短行退化：「做。」×N —— 既有 `s.length<6` 过滤造成的盲区 ──
    // 真机证据：本会话两次失控输出 = 「做。」数百行（每行 2 字符）⇒ rows 恒空 ⇒ 熔断代码在跑但永不命中。
    const shortRep = Array.from({ length: 300 }, () => "做。").join("\n");
    const hS = tail(shortRep);
    ok(!!hS && hS.kind === "short" && hS.maxN === 300, "E12 短行重复 300x'做。' 必命中（改前恒 null）", hS ? JSON.stringify(hS).slice(0, 120) : "null");
    ok(!tail(Array.from({ length: 60 }, () => "}").join("\n")), "E13 纯符号短行（代码块 } ）不误报");
    ok(!tail(Array.from({ length: 25 }, () => "做。").join("\n")), "E14 短行仅 25 行（<30 行闸）不熔断");
    ok(!tail(Array.from({ length: 25 }, () => "做。").concat(Array.from({ length: 5 }, () => "好。")).join("\n")), "E15 短行占比 83%（<85%）不熔断");
    const detShort = mod.__detectTextDegeneration([{ type: "text", text: shortRep }]);
    ok(!!detShort && detShort.kind === "short", "E16 消息级短行退化同样命中", detShort ? "maxN=" + detShort.maxN : "null");

    // ── [CRA 2026-11-06] 长短混排：旧写法 `if (rows.length < 15) …` 会让短行分支被长行数量短路 ──
    const longs = (n) => Array.from({ length: n }, (_, i) => "第" + i + "段：这是一条各不相同的正常分析句子内容。").join("\n");
    const shorts = (n, s) => Array.from({ length: n }, () => s).join("\n");
    const mixed = longs(20) + "\n" + shorts(30, "是");
    const hMix = tail(mixed);
    ok(!!hMix && hMix.kind === "short" && hMix.maxN === 30, "E17 混排（20 长各异 + 30 短）必命中（改前恒 null）", hMix ? JSON.stringify(hMix).slice(0, 100) : "null");
    ok(!tail(longs(20) + "\n" + shorts(5, "是")), "E18 混排但短行仅 5 条 ⇒ 不误报");
    ok(!tail(longs(60)), "E19 60 行长句各异 ⇒ 不误报（长短混排不引入长行误报）");
    const detMix = mod.__detectTextDegeneration([{ type: "text", text: mixed }]);
    ok(!!detMix && detMix.kind === "short", "E20 消息级混排同样命中", detMix ? "maxN=" + detMix.maxN : "null");
    // 短文本（<400 字）也曾被长度下限整段跳过
    const tiny = Array.from({ length: 100 }, () => "做。").join("\n");   // 299 字
    const detTiny = mod.__detectTextDegeneration([{ type: "text", text: tiny }]);
    ok(!!detTiny && detTiny.kind === "short", "E21 短文本（299 字）短行退化必命中（改前被 400 字下限挡住）", detTiny ? "maxN=" + detTiny.maxN : "null");
    // 取消档：短行 40 次才 cancelWorthy
    const hBig = tail(Array.from({ length: 300 }, () => "做。").join("\n"));
    const hSmall = tail(longs(20) + "\n" + shorts(30, "是"));
    ok(!!hBig && hBig.cancelWorthy === true, "E22 短行 300 次 ⇒ cancelWorthy=true（够熔断档）");
    ok(!!hSmall && hSmall.cancelWorthy === false, "E23 短行 30 次 ⇒ cancelWorthy=false（只提醒不熔断）");
  }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
