// _alignment-discipline-selftest.mjs —— [对齐 MiMo-Code 三处纪律] 溯源引用 / 检索纪律 / 时效索引
//
// 跑法：node test/_alignment-discipline-selftest.mjs [index.js 路径]
//
// 背景（starry 2026-11-04）：查完 MiMo-Code 源码后判定「不改架构（它 = 我们 md 时代），只对齐三处纪律」：
//   ① 溯源引用：每句带来源，可回原文核对（MiMo: 条目带 [ses_xxx] + trajectory DB 兜底）
//   ② 检索纪律：命中即信 / 要精确字面量查原文别从摘要猜（MiMo: memory 工具描述里写死）
//   ③ 时效索引：把断在 10-31 的「结论时效表」接回库模式（MiMo 只有手工维护的修正历史档）
//
// 覆盖：
//   A 溯源引用：memory_read / memory_search 渲染带 ⟪src⟫；split 的 sentence_texts 会剥掉该后缀
//   B 检索纪律：memory_search 描述含「⟪…⟫ 是来源」「要精确字面量→session_search」「不要从摘要反推」
//   C 时效索引：纯函数 + 写入语义（排除自身产出 / 恒 1 句 / 内容没变不写 / 接在 doneOk 分支）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");
const src = fs.readFileSync(PLUGIN, "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) { } await sleep(step || 50); }
  return false;
}

// ── A 溯源引用（静态）──
ok(/t\.sentences\.map\(\(s\) => "- " \+ s\.text \+ \(s\.src \? " ⟪"/.test(src), "A1 memory_read 行尾渲染 ⟪src⟫");
ok(/hs\.map\(\(x\) => "  - " \+ x\.text \+ \(x\.src \? " ⟪"/.test(src), "A2 memory_search 行尾渲染 ⟪src⟫");
ok(/hits\.push\(\{ text: r\.text, src: r\.src \|\| "" \}\)/.test(src), "A3 search 命中保留 src（原实现只 push 纯文本）");
ok(/const stripSrcTag = \(x\) => String\(x == null \? "" : x\)\.replace\(\/\\s\*⟪\[\^⟫\]\*⟫\\s\*\$\/, ""\)\.trim\(\)/.test(src), "A4 split 的 sentence_texts 会剥掉 ⟪…⟫ 后缀");
ok(/a\.sentence_texts\.map\(stripSrcTag\)/.test(src), "A5 split 用 stripSrcTag 归一后再逐字匹配");

// ── B 检索纪律（静态）──
ok(/命中行尾的 `⟪…⟫` 是该句来源/.test(src), "B1 描述说明 ⟪…⟫ = 来源");
ok(/要精确字面量/.test(src) && /session_search 回原始会话捞逐字原文/.test(src), "B2 描述要求精确字面量回查原文");
ok(/不要从摘要反推或猜/.test(src), "B3 描述禁止从摘要猜字面量");
ok(/命中即信/.test(src), "B4 「命中即信」未回归（保留原有纪律）");

// ── C 时效索引（静态）──
ok(/function buildConflictIndexText\(store, opts\)/.test(src), "C1 索引生成纯函数存在");
ok(/function writeConflictIndex\(store\)/.test(src), "C2 索引写入函数存在");
ok(/const CONFLICT_SELF_RE = \/结论时效表\|主题时效链\|时效索引\//.test(src), "C3 排除自身产出（防自我复读膨胀）");
ok(/cur\.length === 1 && String\(cur\[0\]\.text \|\| ""\) === text\) return \{ changed: false/.test(src), "C4 内容没变不写（changed:false）");
ok(/store\.deleteSentence\(t\.id, \{ sentenceId: s\.id \}/.test(src), "C5 覆盖式：先删旧句再写新句");
ok(/if \(doneOk\) \{[\s\S]{0,200}writeConflictIndex\(TOPICDB\.store\)/.test(src), "C6 接在 dream 成功轮（doneOk）分支");
ok(/const CONFLICT_INDEX_TOPIC = "结论时效表·自动索引"/.test(src), "C7 专用主题名（不碰人工维护的 T-0224）");

// ── D 库层端到端 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-align-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 对齐自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);
const fx = createFixtureCtx({});
await plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "D0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));

if (ready) {
  const store = mod.__topicdb.store;
  const hooks = mod.__dreamHooks || {};
  const memRead = findTool(fx.captured, "memory_read");
  const memSearch = findTool(fx.captured, "memory_search");

  // D1/D2 溯源：造一个带 src 的主题，读出来要带 ⟪src⟫
  const t1 = store.createTopic({ name: "溯源自测主题甲", actor: "runtime", confirm: true });
  store.appendSentence({ topic: t1.id, text: "带来源的句子：部署路径 E:\\部署\\20261029。", src: "knowledge/MEMORY-测试.md", actor: "runtime" });
  const rd = await memRead.execute({ topic: t1.id }, { agent: { session: { id: "s1" } } });
  ok(String(rd).indexOf("⟪knowledge/MEMORY-测试.md⟫") >= 0, "D1 memory_read 真跑带 ⟪src⟫", String(rd).slice(0, 120));

  const sr = await memSearch.execute({ query: "带来源的句子" }, { agent: { session: { id: "s1" } } });
  ok(String(sr).indexOf("⟪knowledge/MEMORY-测试.md⟫") >= 0, "D2 memory_search 真跑带 ⟪src⟫", String(sr).slice(0, 160));

  // D3 时效索引：造 3 个含标记主题（其中一个名字含「结论时效表」应被排除）
  const mk = (name, texts) => {
    const t = store.createTopic({ name: name, actor: "runtime", confirm: true });
    for (const x of texts) store.appendSentence({ topic: t.id, text: x, src: "sessions/2026-11-04.md", actor: "runtime" });
    return t.id;
  };
  mk("部署清单归档", ["旧结论：默认走普通会话。", "该定案已被 2026-10-09 用户硬性约束推翻，处置作废。"]);
  mk("接口耗时排查", ["接口返回 200。", "先前判断有误，实测为 302。", "该口径已过时。"]);
  mk("结论时效表·人工旧档", ["作废：这条不该被统计（自身产出）。"]);
  const text1 = hooks.buildConflictIndexText(store);
  ok(!!text1 && /命中标记 4 条/.test(text1), "D3 索引统计正确（4 条，排除自身产出）", String(text1).slice(0, 160));
  ok(!!text1 && text1.indexOf("部署清单归档") >= 0 && text1.indexOf("人工旧档") < 0, "D4 自身产出被排除");

  const w1 = hooks.conflictIndex(store);
  ok(!!(w1 && w1.changed === true), "D5 首次写入 changed=true", JSON.stringify(w1));
  const idx = (store.topics() || []).find((x) => String(x.name) === "结论时效表·自动索引");
  ok(!!idx, "D6 自动索引主题已建");
  const body1 = store.readTopic(idx.id).sentences;
  ok(body1.length === 1, "D7 恒 1 句（覆盖式，不膨胀）", String(body1.length));

  const w2 = hooks.conflictIndex(store);
  ok(!!(w2 && w2.changed === false), "D8 内容没变 → changed=false（不写库）", JSON.stringify(w2));
  const body2 = store.readTopic(idx.id).sentences;
  ok(body2.length === 1, "D9 二次运行仍恒 1 句", String(body2.length));

  // D10 内容变化 → 重写且仍 1 句
  store.appendSentence({ topic: t1.id, text: "新增：该方案已废弃。", src: "sessions/2026-11-04.md", actor: "runtime" });
  const w3 = hooks.conflictIndex(store);
  ok(!!(w3 && w3.changed === true), "D10 内容变化 → changed=true", JSON.stringify(w3));
  ok(store.readTopic(idx.id).sentences.length === 1, "D11 重写后仍恒 1 句");

  try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);

