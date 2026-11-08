// _header-indicator-selftest.mjs —— 会话标题栏「本会话记忆状态」指示器 + note-stat ?sid= 自测
//
// 跑法：node test/_header-indicator-selftest.mjs
//
// 依据：docs/audit/header-memory-indicator_CRA_2026-11-07.md
// 覆盖：
//   A 端点 ?sid= 过滤：① 两会话不同句数（per-session 准确）② 无 sid 走全局 ③ 无效 sid ⇒ 0 ④ 无对应主题 ⇒ 0
//     ⑤ flag 关 ⇒ disabled:true ⑥ 复用 noteUnrefinedCount 口径（指针后句数）
//   B client 静态接线：slot 名/id/order、props.sessionId、优先级 等待>积压>隐藏、正常态 null、
//     abort/切会话清旧值、卸载清 timer、2s/15s 轮询、失败静默、桌面/ web 点击、DOM HUD 已退役
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(PLUGIN, "client", "lib", "client.js"), "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(100); } return false; }

// ── A. 端点 ?sid= 过滤（真实 apply + 造两个会话笔记主题）─────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-header-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const { createFixtureCtx } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
const fx = createFixtureCtx({});
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000);
ok(ready, "A0 前置：主题库就绪");
const H = mod.__headerHooks || {};
ok(typeof H.noteStatPayload === "function", "A0b 前置：noteStatPayload 测试钩子已接线");

function seedNote(store, name, n) {
  const t = store.seedTopic({ name: name, triggers: ["笔记"], src: "sessions/test.md" });
  for (let i = 0; i < n; i++) store.appendSentence({ topic: t.id, text: "笔记句 " + name + " #" + i, src: "sessions/test.md", actor: "runtime" });
  return t;
}
try {
  const store = mod.__topicdb.store;
  seedNote(store, "笔记·wsA/aaaaaaaa", 30);
  seedNote(store, "笔记·wsB/bbbbbbbb", 7);
  // 非笔记主题不计入
  const plain = store.seedTopic({ name: "普通主题", triggers: ["x"], src: "knowledge/x.md" });
  store.appendSentence({ topic: plain.id, text: "普通句", actor: "runtime" });
  ok(true, "A1 造数：笔记 A=30 句 / 笔记 B=7 句 / 普通主题 1 句");
} catch (eSeed) { ok(false, "A1 造数失败", (eSeed && eSeed.message) || String(eSeed)); }

const FULL_A = "session-aaaaaaaa-1111-2222-3333-444455556666";
const p = H.noteStatPayload || (() => null);
const g = p("/dsh-memory/note-stat.json");
ok(g && g.ok === true && g.disabled === false && g.topics === 2 && g.sentences === 37 && g.sid8 === "", "A2 无 sid ⇒ 全局 2 主题 / 37 句（向后兼容）", JSON.stringify(g));
const a = p("/dsh-memory/note-stat.json?sid=" + FULL_A);
ok(a && a.topics === 1 && a.sentences === 30 && a.sid8 === "aaaaaaaa", "A3 ?sid=完整 sessionId ⇒ 本会话 1 主题 / 30 句", JSON.stringify(a));
const a8 = p("/dsh-memory/note-stat.json?sid=aaaaaaaa");
ok(a8 && a8.topics === 1 && a8.sentences === 30 && a8.sid8 === "aaaaaaaa", "A4 ?sid=sid8 形式同样准确", JSON.stringify(a8));
const b = p("/dsh-memory/note-stat.json?sid=session-bbbbbbbb-0000");
ok(b && b.topics === 1 && b.sentences === 7 && b.sid8 === "bbbbbbbb", "A5 另一会话 1 主题 / 7 句（per-session 不串）", JSON.stringify(b));
const bad = p("/dsh-memory/note-stat.json?sid=zzzz-not-hex");
ok(bad && bad.ok === true && bad.topics === 0 && bad.sentences === 0 && bad.sid8 === "", "A6 无效 sid ⇒ 0/0（不报错）", JSON.stringify(bad));
const none = p("/dsh-memory/note-stat.json?sid=deadbeef-0000-0000-0000-000000000000");
ok(none && none.topics === 0 && none.sentences === 0 && none.sid8 === "deadbeef", "A7 无对应笔记主题 ⇒ 0/0", JSON.stringify(none));
ok(/const st = noteUnrefinedStats\(store, rows\);/.test(SRC), "A8 复用既有 noteUnrefinedStats 口径（不新写算法）");
ok(/nm\.indexOf\("笔记·"\) === 0 && nm\.length > suffix\.length && nm\.slice\(-suffix\.length\) === suffix/.test(SRC), "A9 过滤条件 = 笔记主题名以 /<sid8> 结尾");

// 指针后句数口径（复用 noteUnrefinedCount）：追加指针句 ⇒ 未提炼归零
try {
  const store = mod.__topicdb.store;
  const t = seedNote(store, "笔记·wsC/cccccccc", 3);
  const ptr = (mod.__noteHooks && typeof mod.__noteHooks.noteFormatPointer === "function")
    ? mod.__noteHooks.noteFormatPointer({ count: 3, targets: ["T-0001"], sid8: "cccccccc" })
    : "已提炼 3 句 → 见 T-0001";
  store.appendSentence({ topic: t.id, text: ptr, actor: "runtime" });
  const c = p("/dsh-memory/note-stat.json?sid=cccccccc");
  ok(c && c.topics === 0 && c.sentences === 0, "A10 指针行之后的句数口径（最后一句是指针 ⇒ 未提炼 0）", JSON.stringify(c));
} catch (ePtr) { ok(false, "A10 指针口径测试异常", (ePtr && ePtr.message) || String(ePtr)); }

// flag 关 ⇒ disabled:true 零值（新实例覆盖钩子）
try {
  const fx2 = createFixtureCtx({});
  mod.default.apply(fx2.ctx, { memoryTopicDbEnabled: false });
  const H2 = mod.__headerHooks;
  const d = H2.noteStatPayload("/dsh-memory/note-stat.json?sid=" + FULL_A);
  ok(d && d.ok === true && d.disabled === true && d.ready === false && d.topics === 0 && d.sentences === 0, "A11 flag 关 ⇒ disabled:true 零值（前端隐藏，不误报）", JSON.stringify(d));
} catch (eFlag) { ok(false, "A11 flag 关场景异常", (eFlag && eFlag.message) || String(eFlag)); }

// ── B. client 静态接线 ─────────────────────────────────────────────────
ok(/ctx\.slots\.inject\("conversation\.session\.header\.actions"/.test(CLIENT), "B1 注入 conversation.session.header.actions");
ok(/id:\s*"dsh-memory-status"/.test(CLIENT) && /order:\s*20/.test(CLIENT), "B2 slot id 唯一 + order=20（不抢标题）");
ok(/function HeaderMemoryIndicator\(props\)/.test(CLIENT) && /props\.sessionId/.test(CLIENT) && /data-session-id/.test(CLIENT), "B3 组件从 props 取 sessionId 并落到 DOM（data-session-id）");
ok(/const HEADER_NOTE_MIN = 10;/.test(CLIENT) && /const HEADER_WAIT_MS = 2000;/.test(CLIENT) && /const HEADER_NOTE_MS = 15000;/.test(CLIENT), "B4 阈值 10 句 + 轮询 2s/15s（≥15s 要求）");
ok(/if \(!waiting && !\(noteN > 0\)\) return null;/.test(CLIENT) && /const isWait = waiting;/.test(CLIENT), "B5 优先级 等待 > 积压 > 隐藏；正常态整枚隐藏（return null）");
ok(/正在写入检查点/.test(CLIENT) && /上限 120s/.test(CLIENT) && /完成后本会话记忆会刷新/.test(CLIENT), "B6 等待态 title 定稿文案");
ok(/本会话有/.test(CLIENT) && /句笔记尚未整理进长期记忆/.test(CLIENT) && /建议跑 \/dream/.test(CLIENT), "B6b 积压态 title 定稿文案");
ok(/\("⏳ 整理中 " \+ secs \+ "s"\)/.test(CLIENT) && /\(noteN \+ " 句待整理"\)/.test(CLIENT), "B6c 文字化标签：⏳ 整理中 Ns / N 句待整理");
ok(!/\("●"/.test(CLIENT), "B6d 旧圆点标签（●N）已移除");
ok(/fontSize: 12,/.test(CLIENT) && /lineHeight: "18px"/.test(CLIENT) && /whiteSpace: "nowrap"/.test(CLIENT) && !/minWidth: "34px"/.test(CLIENT), "B6e 文字化样式：12px + nowrap + 去固定 minWidth（不挤标题）");
// ── 主题适配（浅/深色）：五处必须用 DSH 主题变量，主色不许写死十六进制 ──
ok(/var\(--dsw-alias-state-business-primary, #3b82f6\)/.test(CLIENT), "B20 等待色用主题变量 --dsw-alias-state-business-primary（fallback 仅在 var 第二参数）");
ok(/var\(--dsw-alias-state-warn-label, #b45309\)/.test(CLIENT), "B21 积压色用 --dsw-alias-state-warn-label（文字场景专用，浅色下更稳）");
ok(/var\(--dsw-alias-bg-layer-2, rgba\(127,127,127,0\.14\)\)/.test(CLIENT), "B22 胶囊背景用 --dsw-alias-bg-layer-2");
ok(/border: "1px solid var\(--dsw-alias-border-l2, rgba\(127,127,127,0\.28\)\)"/.test(CLIENT), "B23 边框用 --dsw-alias-border-l2");
ok(/var\(--dsw-alias-interactive-bg-hover, rgba\(127,127,127,0\.20\)\)/.test(CLIENT) && /onMouseEnter/.test(CLIENT) && /onMouseLeave/.test(CLIENT), "B24 hover 用 --dsw-alias-interactive-bg-hover（内联样式用 onMouseEnter/Leave 实现）");
ok(!/color: "#/.test(CLIENT) && !/background: "#/.test(CLIENT), "B25 主色/背景无独立写死十六进制（# 仅允许出现在 var() fallback 内）");
ok(/@keyframes dsh-memory-wait-breathe\{0%,100%\{opacity:\.65\}50%\{opacity:1\}\}/.test(CLIENT), "B26 呼吸动画只改 opacity（0.65↔1，不用颜色动画）");
ok(/AbortController/.test(CLIENT) && /\.abort\(\)/.test(CLIENT) && /genRef/.test(CLIENT), "B7 abort + generation 丢弃旧会话在途响应");
ok(/setWaitMs\(0\); setNoteN\(0\);/.test(CLIENT) && /\[sessionId, sid8\]/.test(CLIENT), "B8 切会话立即清旧值 + effect 依赖 sessionId");
ok(/clearInterval\(waitTimer\)/.test(CLIENT) && /clearInterval\(noteTimer\)/.test(CLIENT) && /removeEventListener\("visibilitychange"/.test(CLIENT), "B9 卸载必清 timer/监听（无泄漏）");
ok(/document\.visibilityState === "hidden"/.test(CLIENT), "B10 页面隐藏暂停轮询");
ok(/location\.protocol === "dsh-app:"/.test(CLIENT) && /\/memory-panel/.test(CLIENT) && /window\.open\("\/dsh-memory\/stats"/.test(CLIENT), "B11 点击：web 新标签开面板 / 桌面给 /memory-panel 指引");
ok(/fetch\("\/dsh-memory\/wait\.json"/.test(CLIENT) && /note-stat\.json\?sid=/.test(CLIENT), "B12 数据源：wait.json + note-stat ?sid=");
ok(/j\.active === true && s8 && s8 === sid8/.test(CLIENT), "B13 等待态按 sid8 匹配当前会话（别的会话压缩不串）");
ok(/j\.disabled === true \|\| j\.ready === false/.test(CLIENT), "B14 disabled/ready 守卫（失败/未就绪静默隐藏）");
ok(!/mountWaitHud/.test(CLIENT), "B15 旧 DOM 浮层 mountWaitHud 已退役（调用与函数均删）");
ok(!/dsh-memory-wait-hud/.test(CLIENT), "B16 旧浮层 DOM/样式节点已删（无 wait-hud 元素）");
ok(/note-stat\.json"/.test(CLIENT) && /NoteStatRow/.test(CLIENT), "B17 设置页全局 NoteStatRow 保留（无 sid，零行为变化）");
ok(/function HeaderMemoryIndicator/.test(CLIENT) && /react\.useEffect/.test(CLIENT) && /react\.useState/.test(CLIENT), "B18 组件用 React hooks（无自定义 portal）");
ok(/ensureHeaderStyle/.test(CLIENT) && /dsh-memory-wait-breathe/.test(CLIENT), "B19 等待态呼吸动画（keyframes 只注入一次）");

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
