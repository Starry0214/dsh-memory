// topicdb-p5-check.mjs —— task-46（P5）字面量通道：L01/L04/L05/L06（digest/整理写回见文件尾"待续"说明）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-p5-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- p5 检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);
let pass = 0; const fails = [];
function ok(c, n, d) { if (c) { pass++; console.log("PASS  " + n + (d ? "  —  " + d : "")); } else { fails.push(n); console.log("FAIL  " + n + (d ? "  —  " + d : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shaOfFile = (p) => (fs.existsSync(p) ? createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16) : "(缺失)");
const LITMD = path.join(MEM, "knowledge", "字面量.md");

{
  const fx = createFixtureCtx({});
  mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
  for (let i = 0; i < 200; i++) { if (mod.__topicdb && mod.__topicdb.ready) break; await sleep(100); }
  ok(!!(mod.__topicdb && mod.__topicdb.ready), "前置：flag 开 ⇒ 主题库就绪");
  ok(typeof mod.writeLiteralsIdempotent === "function" && typeof mod.writeLiteralsToDb === "function", "前置：字面量写库函数已导出（直调线上同一份）");
}
const store = mod.__topicdb.store;
const litTopic = store.seedTopic({ name: "精确字面量索引", triggers: ["字面量"], src: "knowledge/字面量.md" });
const litTexts = () => (store.readTopic(litTopic.id).sentences || []).map((s) => String(s.text));
const E1 = { literal: "GUID 11111111-2222-3333-4444-555555555555", sid: "abcdef12", date: "2026-10-30" };
const E2 = { literal: "命令 node _run-suite.mjs --no-matrix", sid: "abcdef12", date: "2026-10-30" };

// ── L01 flag 开：进库、md 不写、幂等 ──
{
  const r1 = mod.writeLiteralsIdempotent(MEM, [E1, E2]);
  ok(r1 && r1.ok === true && r1.channel === "db" && r1.wrote === 2,
    "L01 路由：flag 开 ⇒ channel=db，写 2 条", JSON.stringify({ channel: r1 && r1.channel, wrote: r1 && r1.wrote }));
  ok(litTexts().length === 2 && litTexts().includes("- " + E1.literal + " ← abcdef12（2026-10-30）"),
    "L01 落库：主题句数 2 且格式与 md 逐字同构(- <字面量> ← <sid>（日期）)", JSON.stringify(litTexts()));
  ok(!fs.existsSync(LITMD), "L01 不写 md：knowledge/字面量.md 未被创建", "(缺失)");
  const r2 = mod.writeLiteralsIdempotent(MEM, [E1, E2]);
  ok(r2 && r2.ok === true && r2.wrote === 0 && r2.existed === 2,
    "L01 幂等：同批再写 ⇒ wrote=0 / existed=2（meta literal:<sha16>）", JSON.stringify({ wrote: r2 && r2.wrote, existed: r2 && r2.existed }));
  ok(litTexts().length === 2, "L01 幂等：库内仍 2 句（无重复）");
  ok(!fs.existsSync(LITMD), "L01 幂等：md 仍未创建（轮转也不需要）");
}

// ── L04 flag 关：走 md（sha 冻结/变化）──
{
  const before = litTexts().length;
  const enabledBackup = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const r4 = mod.writeLiteralsIdempotent(MEM, [{ literal: "flag关字面量 99999999-aaaa", sid: "abcdef12", date: "2026-10-30" }]);
  mod.__topicdb.enabled = enabledBackup;
  ok(r4 && r4.ok === true && !r4.channel && r4.wrote === 1, "L04 flag 关：仍走 md（无 channel 字段、wrote=1）", JSON.stringify({ ok: r4 && r4.ok, channel: r4 && r4.channel, wrote: r4 && r4.wrote }));
  ok(fs.existsSync(LITMD) && fs.readFileSync(LITMD, "utf8").includes("flag关字面量 99999999-aaaa"), "L04 flag 关：md 文件真的写入");
  ok(litTexts().length === before, "L04 flag 关：库内句数不变（不写库）");
}

// ── L05 坏库：回落 md、不抛错 ──
{
  const goodStore = mod.__topicdb.store;
  let threw = null; let r5 = null;
  try {
    mod.__topicdb.store = { topics() { throw new Error("simulated: p5 db locked"); } };
    r5 = mod.writeLiteralsIdempotent(MEM, [{ literal: "坏库字面量 77777777-bbbb", sid: "abcdef12", date: "2026-10-30" }]);
  } catch (e) { threw = e; }
  mod.__topicdb.store = goodStore;
  ok(!threw && r5 && r5.ok === true && !r5.channel, "L05 坏库：不抛错，回落 md（无 channel）", threw ? ("抛了: " + threw.message) : JSON.stringify({ ok: r5 && r5.ok, why: r5 && r5.why }));
  ok(fs.readFileSync(LITMD, "utf8").includes("坏库字面量 77777777-bbbb"), "L05 兜底：字面量没丢——md 里已有该条");
}

// ── L06 目标主题缺失：跳过 + 回落，不新建主题 ──
{
  const topicsBefore = store.topics().length;
  const origTopics = store.topics.bind(store);
  store.topics = () => origTopics().filter((t) => !/字面量/.test(String(t.name || "")));
  let r6 = null;
  try { r6 = mod.writeLiteralsIdempotent(MEM, [{ literal: "无主题字面量 55555555-cccc", sid: "abcdef12", date: "2026-10-30" }]); } finally { store.topics = origTopics; }
  ok(r6 && r6.ok === true && !r6.channel, "L06 主题缺失：不抛错、回落 md（无 channel）", JSON.stringify({ ok: r6 && r6.ok, why: r6 && r6.why }));
  ok(store.topics().length === topicsBefore, "L06 纪律：**没有**为字面量新建主题", String(topicsBefore) + " → " + String(store.topics().length));
  ok(fs.readFileSync(LITMD, "utf8").includes("无主题字面量 55555555-cccc"), "L06 兜底：md 里已有该条（唯一副本不丢）");
}

// ── L02 整理写回（flag 开）：库内 append、原 md 不动、幂等、flag 关/坏库/unmapped ──
{
  const REL_W = "sessions/2026-10-21.md";
  const MDW = path.join(MEM, REL_W);
  const wTopic = store.seedTopic({ name: "整理写回检查", triggers: [], src: REL_W });
  store.appendSentence({ topic: wTopic.id, text: "本日已有句", src: REL_W, actor: "plugin" });
  const wTexts = () => (store.readTopic(wTopic.id).sentences || []).map((s) => String(s.text));
  const wr1 = mod.__p5Hooks.writeback(REL_W, "## 当日要点（2026-10-21 机械收敛）\n\n- 整理回写甲\n- 整理回写乙\n> 指针行不写入\n", "converge");
  ok(wr1 && wr1.ok === true && wr1.channel === "db" && wr1.added === 2,
    "L02 路由：flag 开 ⇒ channel=db，追加 2 句（跳过标题/指针行）", JSON.stringify({ added: wr1 && wr1.added, why: wr1 && wr1.why }));
  ok(wTexts().includes("整理回写甲") && wTexts().includes("整理回写乙"), "L02 落库：两句都在主题里");
  ok(!fs.existsSync(MDW), "L02 不写 md：sessions/2026-10-21.md 未被创建", "(缺失)");
  const wr2 = mod.__p5Hooks.writeback(REL_W, "- 整理回写甲\n- 整理回写乙", "converge");
  ok(wr2 && wr2.ok === true && wr2.added === 0, "L02 幂等：同内容再写 ⇒ added=0（按现有句去重）", JSON.stringify({ added: wr2 && wr2.added }));
  const wr3 = mod.__p5Hooks.writeback("projects/没有这个主题.md", "- x", "test");
  ok(wr3 && wr3.ok === false && /unmapped/.test(String(wr3.why)), "L02 unmapped：命中不了主题 ⇒ ok:false(unmapped)（调用方回落 md）", JSON.stringify(wr3));
  const en = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const wr4 = mod.__p5Hooks.writeback(REL_W, "- x", "test");
  mod.__topicdb.enabled = en;
  ok(wr4 && wr4.ok === false && /flag-off/.test(String(wr4.why)), "L02 flag 关：库分支不启用（flag-off）⇒ 走原 md", JSON.stringify(wr4));
  const goodStore = mod.__topicdb.store;
  let threw = null; let wr5 = null;
  try { mod.__topicdb.store = { topics() { throw new Error("simulated: p5 writeback locked"); } }; wr5 = mod.__p5Hooks.writeback(REL_W, "- y", "test"); } catch (e) { threw = e; }
  mod.__topicdb.store = goodStore;
  ok(!threw && wr5 && wr5.ok === false, "L02 坏库：不抛错、ok:false（调用方回落 md）", threw ? ("抛了: " + threw.message) : JSON.stringify(wr5));
}


console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
console.log("备注：本脚本覆盖 P5 两条链路——字面量 L01/L04/L05/L06、整理写回 L02（子代理摘要 L03 随通道删除）。");
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) {}
setTimeout(() => process.exit(fails.length ? 1 : 0), 120);
