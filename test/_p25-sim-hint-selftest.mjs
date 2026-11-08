// _p25-sim-hint-selftest.mjs —— [写入侧相似度提示] append 前查同主题相近句
//
// 跑法：node test/_p25-sim-hint-selftest.mjs [index.js 路径]
//
// 背景（2026-11-03 真机数据）：近 14 天主会话 append:replace = 181:3，同一件事有新进展时倾向"再加一句"，
//   主题越积越长（26 个主题 >200 句）。本改动在 append 前做只读相似度检查（字符 2-gram Dice），
//   命中则在返回里带 sim + hint 引导改用 replace；**不拦截写入**。
//
// 覆盖：
//   A 完全相同 ⇒ score=1
//   B 改几个字 ⇒ score ≥ 0.8（改写/续写能识别）
//   C 无关句 ⇒ 0 命中
//   D 短句（归一化后 <24 字）⇒ 返回 null（不值得提示）
//   E 长度差过大 ⇒ 不进 checked（长度预筛）
//   F 超大主题 ⇒ 只扫最后 maxScan 句（scanned ≤ maxScan）
//   G 静态接线：append 分支调 p25SimilarSentences + 只对 actor=lead + 检查在 append 之前（不拦截）
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指向 os.tmpdir()。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) {
    try { if (fn()) return true; } catch (e) { /* 继续等 */ }
    await sleep(step || 50);
  }
  return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-simhint-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "ws-sim");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 相似度自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

const fx = createFixtureCtx({});
await plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
if (!ready) {
  console.log("\n0 PASS / 1 FAIL（库未就绪）");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  setTimeout(() => process.exit(1), 100);
  throw new Error("topicdb not ready");
}
const store = mod.__topicdb.store;
ok(typeof mod.__p25SimilarSentences === "function", "前置：__p25SimilarSentences 已导出");

// 造一个主题（名称避开治理禁建区）
const t = store.createTopic({ name: "simtest-alpha-0001", actor: "runtime", confirm: true });
const TID = t && t.id;
ok(!!TID, "前置：建测试主题", String(TID));

const BASE = "报销单 BX2609300211 共 63 笔、合计 2227.03 元，错挂 0、待补关联 0，逐日报销额与日志费用额 24/25 天相等，差 19092.00 来自房屋租赁不在本批次。";
store.appendSentence({ topic: TID, text: BASE, actor: "runtime" });
store.appendSentence({ topic: TID, text: "招标文件第三章评标办法：综合评估法，权重 0.4/0.3/0.3，需逐条核对评分细则与废标条款是否一致。", actor: "runtime" });
store.appendSentence({ topic: TID, text: "短句。", actor: "runtime" });

// A 完全相同
const a = mod.__p25SimilarSentences(store, TID, BASE);
ok(!!(a && a.hits.length && a.hits[0].score === 1), "A 完全相同 ⇒ score=1", a && a.hits[0] ? String(a.hits[0].score) : "null");

// B 改几个字（同一件事的新进展）
const bTxt = BASE.replace("2227.03", "2299.10").replace("24/25 天相等", "25/25 天相等");
const b = mod.__p25SimilarSentences(store, TID, bTxt);
ok(!!(b && b.hits.length && b.hits[0].score >= 0.8), "B 改几个字 ⇒ score ≥ 0.8", b && b.hits[0] ? String(b.hits[0].score) : "null");

// C 无关句
const c = mod.__p25SimilarSentences(store, TID, "今天天气晴朗适合去橘子洲头散步顺便看看湘江风光带的人流情况如何。");
ok(!!(c && c.hits.length === 0), "C 无关句 ⇒ 0 命中", c ? String(c.hits.length) : "null");

// D 短句（归一化 <24 字）
const d = mod.__p25SimilarSentences(store, TID, "已修复");
ok(d === null, "D 短句 ⇒ 返回 null（不查）", JSON.stringify(d));

// E 长度预筛：超长句不应把短句计入 checked
const e = mod.__p25SimilarSentences(store, TID, "一".repeat(600));
ok(!!(e && e.checked <= 1), "E 长度差过大 ⇒ 预筛生效（checked ≤ 1）", e ? ("checked=" + e.checked + "/total=" + e.total) : "null");

// F 超大主题只扫最后 maxScan
for (let i = 0; i < 30; i++) store.appendSentence({ topic: TID, text: "填充句 " + i + "：这是一条用于测试扫描上限的中等长度句子，内容彼此不同以避免相似度干扰。", actor: "runtime" });
const f = mod.__p25SimilarSentences(store, TID, BASE, { maxScan: 20 });   // 实现有 20 句下限，取恰好 20 验证截断
ok(!!(f && f.scanned <= 20 && f.scanned < f.total), "F 扫描上限生效（scanned ≤ maxScan < total）", f ? ("scanned=" + f.scanned + " total=" + f.total) : "null");

// G 静态接线（相似度闸：拦主会话/普通子代理，放行插件子代理）
const src = fs.readFileSync(PLUGIN, "utf8");
ok(/const _isPluginSub = \(actor === "dream"\);/.test(src), "G1 静态：插件子代理按 actor=dream 识别（不拦）");
ok(/if \(!_isPluginSub\) _sim = p25SimilarSentences\(store, topic, text\);/.test(src), "G2 静态：只对非插件子代理做相似度检查");
ok(/code: "SIMILAR_EXISTS"/.test(src) && /retryWithConfirm: true/.test(src), "G3 静态：命中返回 SIMILAR_EXISTS + retryWithConfirm");
ok(/confirm: \{ type: "boolean"/.test(src), "G4 静态：memory_write 已暴露 confirm 参数");
ok(/if \(_sim && _sim\.hits && _sim\.hits\.length && !_confirm\) \{[\s\S]{0,900}store\.appendSentence/.test(src), "G5 静态：拦截发生在 append **之前**（命中不落库）");
ok(/【相似度闸】/.test(src) && /【更新优先 replace】/.test(src), "G6 静态：工具描述含「相似度闸」+「更新优先 replace」");

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
