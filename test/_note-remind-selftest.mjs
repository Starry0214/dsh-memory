// _note-remind-selftest.mjs —— [note 提醒] 按上下文占用每 15% 提醒一次 + 压缩后重置
//
// 背景（starry 2026-11-05）：「是不是应该按照上下文占用来？每到15%推送一次更好？压缩后就重新注入」
// 实测依据：40 个真实会话中位数 2.3 轮/时、压缩间隔 10.86h ⇒「每 30 轮」≈13.2h（等于没有），
//   定时又太贵；上下文占用是会话进展的自然度量（与 token 消耗挂钩、长短会话自适应、压缩后归零）。
//
// 覆盖：
//   A 静态接线（常量/函数/两处调用点）
//   B 档位判定（15% 步进、单调不重复、冷却、非法输入）
//   C 压缩后重置
//   D 文案（含 memory_note 引导 + 「宁可多记」）
import fs from "node:fs";
import path from "node:path";
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
const mod = await import(pathToFileURL(PLUGIN).href);
const check = mod.__noteRemindCheck, reset = mod.__noteRemindReset, text = mod.__noteRemindText, STEP = mod.__NOTE_REMIND_STEP;
const THRESH = 838860;   // P3_THRESHOLD_TOKENS_DEFAULT

// ── A 静态 ──
ok(STEP === 0.15, "A1 档位步进 15%", String(STEP));
ok(typeof check === "function" && typeof reset === "function" && typeof text === "function", "A2 三个纯函数可取到");
ok(/noteRemindPeek\(sid, total\)/.test(src), "A3 assistant/message 处有调用点（peek 两步式）");
ok(/noteRemindCommit\(sid, _nh\.level\)/.test(src), "A3b 投递成功才消费档位（CRA M3 修复）");
ok(/noteRemindReset\(session\.id\)/.test(src), "A4 压缩后有重置点");
ok(/enqueueRegressionReminder\(sid, "note-remind"/.test(src), "A5 走 REGRESSION_QUEUE 注入（前缀缓存安全）");
// [CRA M1/M2 修复] head 不再塞引导（会挤掉画像段），改为压缩后单独入队 + 清旧队列
ok(!/刚被压缩掉的那段里若有/.test(src), "A6 head 已移除 note 引导（M1 预算修复）");
ok(/purgeRegressionReminders\(session\.id, "note-remind"\)/.test(src), "A7 压缩后清旧 note 提醒（M2）");
ok(/enqueueRegressionReminder\(session\.id, "note-remind-compact"/.test(src), "A8 压缩后单独入队提醒（重新注入）");

// ── B 档位判定 ──
if (typeof check === "function") {
  const sid = "selftest-remind-1";
  reset(sid);
  ok(check(sid, Math.floor(THRESH * 0.10)) === null, "B1 未到 15% 不提醒", "10%");
  const h15 = check(sid, Math.floor(THRESH * 0.16));
  ok(!!h15 && h15.level === 1 && h15.ratio === 16, "B2 16% 命中第 1 档", JSON.stringify(h15));
  ok(check(sid, Math.floor(THRESH * 0.20)) === null, "B3 同档不重复（单调）", "20% 仍属第 1 档");
  // 冷却：跳到下一档但 60s 内不提醒
  ok(check(sid, Math.floor(THRESH * 0.32)) === null, "B4 冷却内跨档也不提醒", "32% 第 2 档，但 60s 冷却");
  // 冷却过后（把 lastAt 改老）——用新 sid 模拟
  const sid2 = "selftest-remind-2";
  reset(sid2);
  check(sid2, Math.floor(THRESH * 0.16));
  const st = mod.__noteRemindState.get(sid2);
  if (st) st.lastAt = Date.now() - 120000;
  const h2 = check(sid2, Math.floor(THRESH * 0.32));
  ok(!!h2 && h2.level === 2, "B5 冷却过后跨档提醒第 2 档", JSON.stringify(h2));
  const st2 = mod.__noteRemindState.get(sid2);
  if (st2) st2.lastAt = Date.now() - 120000;
  const h6 = check(sid2, Math.floor(THRESH * 0.95));
  ok(!!h6 && h6.level === 6, "B6 95% 命中第 6 档", JSON.stringify(h6));
  // 非法输入
  ok(check("", 1000) === null, "B7 空 sid → null");
  ok(check("x", NaN) === null, "B8 NaN → null");
  ok(check("x", -1) === null, "B9 负数 → null");
  ok(check("x", 0) === null, "B10 0 → null");
  // 重置后可重新从第 1 档提醒
  reset(sid2);
  const hAgain = check(sid2, Math.floor(THRESH * 0.16));
  ok(!!hAgain && hAgain.level === 1, "B11 重置后重新从第 1 档开始", JSON.stringify(hAgain));
}

// ── D 文案 ──
if (typeof text === "function") {
  const t = text("上下文已用约 45%（第 3 档）。");
  ok(/【会话笔记提醒】/.test(t), "D1 有醒目标题");
  ok(/memory_note/.test(t), "D2 明确指向 memory_note");
  ok(/宁可多记/.test(t), "D3 含「宁可多记」");
  ok(/用户原话\/口径/.test(t) && /未解问题/.test(t) && /精确字面量/.test(t), "D4 列出必记类型");
  ok(t.length < 400, "D5 单条 ≤400 字（成本可控）", t.length + " 字");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
