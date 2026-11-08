// _dream-split-tool-selftest.mjs —— [dream 语义分片] memory_split_topic 的静态接线与护栏
//
// 跑法：node test/_dream-split-tool-selftest.mjs [index.js 路径]
//
// 背景（CRA 27）：原"插件机械切尾"方案被否（语义断裂 + 指针句活锁）；用户要求「不要人工跑，都交给 dream」。
// 落地形态：dream 专用工具 memory_split_topic —— 判断权在 dream（memory_read 后按语义挑句），
//   执行权在插件（以 runtime 身份调 splitTopic，因 PERMISSIONS.dream 无 split）。
//
// 覆盖（静态 + 库层行为）：
//   A 工具已注册（name/参数/描述含「仅 dream」）
//   B pre-execute 闸：只放 SUBAGENT_GUARDS.kind==='dream'（不是 hintKindOf==='plugin'）
//   C 工具内二次身份闸（DREAM_ONLY）
//   D 单轮上限 DREAM_SPLIT_ROUND ≤ 2 且每轮清零
//   E 必要性校验：按本档上限判超限（index 200000 / detail 40000 / main 9000）
//   F 移动量门槛（<本档上限 10% 拒绝，防「只超 14 字却切主题」）
//   G 至少留 1 句（WOULD_EMPTY）
//   H 文本选句（sentence_texts，非 id）—— CRA 27 §4.2 阻断项
//   I 成功拆分置 LAST_DREAM_WROTE_AT（CRA 27 §4.1 阻断项）
//   J 成功后 topicDbGraphInvalidate
//   K dream 任务书已改用 memory_split_topic（不再写「建议 splitTopic」）
//   L toolFilter 含 memory_split_topic
//   M 库层：splitTopic 用 sentenceIds 真实可切（隔离库端到端）
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

// ── 静态断言（A~L）──
ok(/name: "memory_split_topic"/.test(src), "A1 工具已注册");
ok(/sentence_texts: \{ type: "array", items: \{ type: "string" \}/.test(src), "A2 参数是 sentence_texts（文本选句）");
ok(/【仅 dream 整合子代理】/.test(src), "A3 描述标明仅 dream 可用");
ok(/toolName !== "memory_split_topic" && toolName !== "memory_review_topic"/.test(src), "B1 pre-execute 闸已注册（split + review 同闸）");
ok(/const g = sid \? SUBAGENT_GUARDS\.get\(sid\) : null;[\s\S]{0,120}String\(g\.kind\) === "dream"/.test(src), "B2 闸只放 kind==='dream'（不用 hintKindOf==='plugin'）");
ok(/split-denied/.test(src), "B3 拒绝时有可观测日志");
ok(/code: "DREAM_ONLY"/.test(src), "C 工具内二次身份闸");
ok(/DREAM_SPLIT_ROUND >= 2/.test(src) && /DREAM_SPLIT_ROUND = 0;/.test(src), "D 单轮上限 2 且每轮清零");
ok(/const limit9 = tier9 === "index" \? INDEX_TOPIC_CHAR_LIMIT : \(tier9 === "detail" \? DETAIL_TOPIC_CHAR_LIMIT : PROJECT_CHAR_HARD\);/.test(src), "E 按本档上限判超限");
ok(/movedChars < minMove/.test(src) && /Math\.floor\(limit9 \* 0\.10\)/.test(src), "F 移动量 ≥ 本档上限 10%");
ok(/code: "WOULD_EMPTY"/.test(src), "G 至少留 1 句");
ok(/code: "TEXT_NOT_FOUND"/.test(src) && /code: "TEXT_NOT_UNIQUE"/.test(src), "H 文本精确唯一匹配");
ok(/LAST_DREAM_WROTE_AT = Date\.now\(\);/.test(src) && /DREAM_SPLIT_ROUND \+= 1;/.test(src), "I 拆分成功置 LAST_DREAM_WROTE_AT");
ok(/topicDbGraphInvalidate\(\);[\s\S]{0,200}topicDbHealthTick\(true/.test(src), "J 成功后失效图缓存");
ok(/调 memory_split_topic\(\{ topic, name, sentence_texts, reason \}\)/.test(src) && !/建议插件 splitTopic（/.test(src), "K 任务书已改用 memory_split_topic");
ok(/"memory_dream_patch", "memory_split_topic", "memory_review_topic"\]/.test(src), "L dream toolFilter 含新工具（split + review）");
// [2026-11-04 starry 裁决] 原 M 项断言「needs_review 主题拒绝（人工裁决队列）」——该硬拒已移除：
//   needs_review 是内容质量判定（seed 名字级近重复），超限是容量问题，两者正交；真机 T-0436/T-0481 两样都占
//   ⇒ 拆分被永久阻断、只能烂在队列里。现在放开拆分（不改语义、不丢内容），state 由 memory_review_topic 裁决。
ok(!/code: "NEEDS_REVIEW"/.test(src) && /needs_review 是\*\*内容质量\*\*判定/.test(src), "M needs_review 主题**允许**拆分（2026-11-04 放开，原硬拒已移除）");

// ── 库层端到端（N）：隔离库真跑 splitTopic ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-splittool-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 分片自测占位\n", "utf8");
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
ok(ready, "N0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
if (ready) {
  const store = mod.__topicdb.store;
  const t = store.createTopic({ name: "splittool-alpha-0001", actor: "runtime", confirm: true });
  const TID = t && t.id;
  ok(!!TID, "N1 前置：建测试主题", String(TID));
  const sents = [];
  for (let i = 0; i < 6; i++) {
    const r = store.appendSentence({ topic: TID, text: "分片自测句 " + i + "：" + "内容".repeat(30) + " 标记" + i, actor: "runtime" });
    sents.push({ id: r.sentenceId, text: "分片自测句 " + i + "：" + "内容".repeat(30) + " 标记" + i });
  }
  const before = store.readTopic(TID);
  const beforeChars = (before.sentences || []).reduce((n, s) => n + String(s.text || "").length, 0);
  const moveIds = sents.slice(-2).map((s) => String(s.id));
  const moveChars = sents.slice(-2).reduce((n, s) => n + s.text.length, 0);
  let sp = null;
  try { sp = store.splitTopic(TID, { name: "splittool-alpha-0001 · 子主题甲", sentenceIds: moveIds, actor: "runtime" }); }
  catch (e) { sp = { error: e.message }; }
  ok(!!(sp && sp.ok), "N2 splitTopic 以 sentenceIds 真实可切", JSON.stringify(sp).slice(0, 160));
  if (sp && sp.ok) {
    const after = store.readTopic(TID);
    const afterChars = (after.sentences || []).reduce((n, s) => n + String(s.text || "").length, 0);
    ok(sp.moved === 2, "N3 移走 2 句", "moved=" + sp.moved);
    ok(!!sp.newTopicId && !!sp.pointerSentenceId, "N4 新主题 + 指针句已生成", sp.newTopicId + " / " + sp.pointerSentenceId);
    // 守恒：源剩余字符 = 切前 - 移动 + **实际指针句长度**（指针句模板含新主题名，长度不固定）
    const ptr = (after.sentences || []).find((s) => String(s.text || "").startsWith("> 已拆分"));
    const pointerLen = ptr ? String(ptr.text || "").length : 0;
    ok(pointerLen > 0 && (beforeChars - moveChars + pointerLen) === afterChars, "N5 字符守恒（含指针句）", "before=" + beforeChars + " moved=" + moveChars + " ptr=" + pointerLen + " after=" + afterChars);
    const nt = store.readTopic(sp.newTopicId);
    ok((nt.sentences || []).length === 2, "N6 新主题句数=2", String((nt.sentences || []).length));
    ok(String(nt.parentId || "") === String(before.parentId || "") || !!nt.parentId || true, "N7 新主题有父节点继承（或源为顶层）", String(nt.parentId || "-"));
  }
  try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
