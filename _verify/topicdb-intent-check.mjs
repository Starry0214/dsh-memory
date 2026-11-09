// topicdb-intent-check.mjs —— task-40（P1：意图检查点改写主题库 D8 检查点线）脚本级验收 I01–I06
//
// 做法（不重启宿主、不需要真 UI）：
//   1. DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指到**临时目录** ⇒ 绝不碰真实 ~/.dsh/memory；
//   2. fake ctx（_fixture-ctx.mjs）跑 plugin.apply 让主题库真加载（flag 开）；
//   3. 直接调 **导出钩子** `__topicdbIntentRoute` / `__topicdbWriteIntent` —— 它们与 spawnIntentCheckpoint
//      里那段分支**是同一份代码**（线上跑什么，这里就测什么）；
//   4. I03 用"md 写回段原文 sha16 冻结"证明 flag 关的老路径逐字未改。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";
const MD_BLOCK_SHA16_EXPECT = "b3e5df2283d778ab";   // spawnIntentCheckpoint 里"md 写回段"的冻结指纹（flag 关行为不变）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-intent-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 意图检查点检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
// 当天 md（flag 开时**不该**被动）
const DAY = "2026-10-30";
const MD_FILE = path.join(MEM, "sessions", DAY + ".md");
fs.writeFileSync(MD_FILE, "# " + DAY + "\n\n## 当日要点\n- 既有 md 内容一行\n", "utf8");

process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha16 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store) return true;
    await sleep(100);
  }
  return false;
}

// ── 启动：flag 开 ──
{
  const fx = createFixtureCtx({});
  plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
  const ready = await waitReady();
  ok(ready, "前置：flag 开 ⇒ 主题库惰性加载就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
  if (!ready) { console.log("\n前置失败，终止"); process.exit(2); }
}

const store = mod.__topicdb.store;
// ── 造 D8 容器：域「日记忆（按天流水）」+ 线「会话检查点」 ──
const dom = store.createDomain("日记忆（按天流水）", { actor: "lead" });
const lineR = store.seedTopic({ name: "会话检查点", triggers: ["会话检查点"], src: "sessions/CHECKPOINT.md" });
store.setLevel(lineR.id, "project", { actor: "lead" });
store.linkParent(lineR.id, dom.id, { actor: "lead" });
ok(store.levelOf(lineR.id) === "project", "造数：D8 检查点线已建（level=project）", lineR.id + " " + store.levelOf(lineR.id));

const SUM = "## 本次目标\n- 验证意图检查点改写主题库（P1）\n\n## 关键结论\n- flag 开时不再写 md，改写 D8 检查点线当日主题\n\n## 下一步\n- 等 Lead 部署后真机触发 compact 观察";
const CID = "c1a2b3c4-1111-2222-3333-444455556666";
const SID8 = "abc12345";
const mdShaBefore = sha16(fs.readFileSync(MD_FILE));

// ── I01 flag 开：一次调用 ⇒ 库里当日主题 +1 句，sessions md **零变化** ──
{
  const r = mod.__topicdbIntentRoute(CID, SID8, SUM, DAY + ".md", "session-" + SID8);
  ok(r && r.mode === "db" && r.ok === true && r.duplicate !== true,
    "I01 路由：flag 开 ⇒ mode=db（写库成功，不回落 md）", JSON.stringify({ mode: r && r.mode, topic: r && r.topicName, created: r && r.created }));
  ok(r && r.topicName === DAY, "I01 主题名：按当天日期建/取（YYYY-MM-DD，与 D8 既有 58 期同名规则一致）", r && r.topicName);
  const day = store.topics().find((t) => t.parentId === lineR.id && String(t.name) === DAY);
  ok(!!day && day.sentences === 1, "I01 落库：检查点线下出现当日主题且**恰好 1 句**", day ? (day.id + " sentences=" + day.sentences) : "未找到");
  ok(sha16(fs.readFileSync(MD_FILE)) === mdShaBefore,
    "I01 不写 md：sessions/" + DAY + ".md 的 sha16 前后一致（flag 开时 md 未被触碰）", mdShaBefore);
  // 当天原本没有 md 的日子也不应被"顺手建文件"
  const r2 = mod.__topicdbIntentRoute("d5e6f7a8-9999-0000-1111-222233334444", SID8, SUM, "2026-10-31.md", "session-" + SID8);
  ok(r2 && r2.mode === "db" && !fs.existsSync(path.join(MEM, "sessions", "2026-10-31.md")),
    "I01 不写 md：库里建了 2026-10-31 主题，但 sessions/2026-10-31.md **根本没被创建**", r2 && r2.topicName);

  // ── I02 幂等：同 compactionId 再调 ⇒ 不再 +1 ──
  const before = store.topics().find((t) => t.parentId === lineR.id && String(t.name) === DAY).sentences;
  const r3 = mod.__topicdbIntentRoute(CID, SID8, SUM, DAY + ".md", "session-" + SID8);
  const after = store.topics().find((t) => t.parentId === lineR.id && String(t.name) === DAY).sentences;
  ok(r3 && r3.mode === "db" && r3.duplicate === true && after === before,
    "I02 幂等：同 compactionId 连调两次 ⇒ duplicate=true 且句子数不变（只 +1）", before + " → " + after);
  const raw = mod.__topicdbWriteIntent(CID, SID8, SUM, DAY + ".md", "session-" + SID8);
  ok(raw && raw.ok === true && raw.duplicate === true, "I02 幂等：底层写库钩子同样识别重复（meta intent:<cid> 生效）");

  // ── I05 原文逐字保真（除注释 marker）──
  const topic = store.topics().find((t) => t.parentId === lineR.id && String(t.name) === DAY);
  const sentences = store.readTopic(topic.id).sentences || [];
  const expect = "## 检查点（目标与下一步，压缩 " + CID.slice(0, 8) + " · sid " + SID8 + "）\n\n" + SUM.trim();
  ok(sentences.length === 1 && String(sentences[0].text) === expect,
    "I05 保真：写入句子与预期逐字一致（=标题行 + summaryText 原文，无 HTML 注释 marker）",
    sentences.length ? ("len " + String(sentences[0].text).length + " / expect " + expect.length) : "无句子");
  ok(!/<!--/.test(String(sentences[0] && sentences[0].text)) && String(sentences[0] && sentences[0].text).includes(SUM.split("\n")[1]),
    "I05 保真：不含 `<!--` 注释 marker，且要点行原样在句子里");
}

// ── I03 flag 关：仍走 md（老行为逐字）──
{
  const enabledBackup = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const r = mod.__topicdbIntentRoute("e1e2e3e4-5555-6666-7777-888899990000", SID8, SUM, DAY + ".md", "session-" + SID8);
  mod.__topicdb.enabled = enabledBackup;
  ok(r && r.mode === "md" && r.reason === "flag-off",
    "I03 路由：flag 关 ⇒ mode=md（继续走原 md 写回路径，不写库）", JSON.stringify(r));
  // md 写回段原文冻结：逐字未改 + 关键语句齐全 + 位置在路由分支之后
  const src = fs.readFileSync(PLUGIN, "utf8");
  const a = src.indexOf('const block = "<!-- intent: "');
  const bMark = "try { refreshMemorySessionsIndex(); } catch (e2) {}";
  const b = src.indexOf(bMark, a);
  const mdBlock = a >= 0 && b > a ? src.slice(a, b + bMark.length) : "";
  // [P2.5][2026-11-02] 调用签名新增可选第 6 参 cwd（会话主题归族用）；断言放宽为「可带 _cwP25」。
const routeIdx = src.search(/topicDbIntentRoute\(compactionId, sid8, sum, fname, sessionId(?:, _cwP25)?\)/);
  ok(sha16(Buffer.from(mdBlock, "utf8")) === MD_BLOCK_SHA16_EXPECT,
    "I03 老行为冻结：md 写回段 sha16 == " + MD_BLOCK_SHA16_EXPECT + "（逐字未改）", mdBlock.length + " 字节");
  ok(mdBlock.includes("insertIntentToSection(") && mdBlock.includes("stripOldIntentBlocks(")
    && mdBlock.includes("writeFileAtomic(targetFull, finalIntentText") && mdBlock.includes("readbackVerify(targetFull, finalIntentText)")
    && mdBlock.includes("refreshMemorySessionsIndex"),
    "I03 老行为：md 路径的 strip/insert/原子写/回读校验/索引刷新五步都在");
  ok(routeIdx > 0 && a > routeIdx, "I03 代码结构：路由分支在 md 写回段之前（flag 开时可提前 return，flag 关直落 md）");
  ok(store.topics().filter((t) => String(t.name) === "2026-11-01").length === 0,
    "I03 flag 关不写库：没有为 flag 关那次调用新建任何主题");
}

// ── I04 坏库：写库失败 ⇒ 回落 md 且不抛错 ──
{
  const goodStore = mod.__topicdb.store;
  const goodReady = mod.__topicdb.ready;
  let threw = null;
  let r = null;
  try {
    mod.__topicdb.store = { topics() { throw new Error("simulated: db locked"); } };
    r = mod.__topicdbIntentRoute("f0f0f0f0-aaaa-bbbb-cccc-dddddddddddd", SID8, SUM, DAY + ".md", "session-" + SID8);
  } catch (e) { threw = e; }
  const wr = (() => { try { return mod.__topicdbWriteIntent("f0f0f0f0-aaaa-bbbb-cccc-dddddddddddd", SID8, SUM, DAY + ".md", "s"); } catch (e) { return { ok: false, error: "threw " + e.message }; } })();
  mod.__topicdb.store = goodStore; mod.__topicdb.ready = goodReady;
  ok(!threw && r && r.mode === "md" && /simulated/.test(String(r.reason)),
    "I04 坏库：写库抛错 ⇒ 路由回落 mode=md 且带原因（不抛异常）", threw ? ("抛了: " + threw.message) : JSON.stringify(r));
  ok(wr && wr.ok === false && /simulated/.test(String(wr.error)), "I04 坏库：底层钩子返回 {ok:false,error} 供调用方兜底", JSON.stringify(wr).slice(0, 100));
  // 库不可用（ready=false）同样回落
  const goodReady2 = mod.__topicdb.ready;
  mod.__topicdb.ready = false;
  const r2 = mod.__topicdbIntentRoute("a0a0a0a0-1111-2222-3333-444444444444", SID8, SUM, DAY + ".md", "session-" + SID8);
  mod.__topicdb.ready = goodReady2;
  ok(r2 && r2.mode === "md", "I04 库未就绪：路由回落 mode=md（检查点不丢）", JSON.stringify(r2));
}

// ── I06 D8 容器缺失：回落 md（不硬编码 ID、不瞎建域）──
{
  const origTopics = store.topics.bind(store);
  store.topics = () => origTopics().filter((t) => String(t.name) !== "会话检查点");
  const r = mod.__topicdbIntentRoute("b0b0b0b0-5555-6666-7777-888888888888", SID8, SUM, DAY + ".md", "session-" + SID8);
  store.topics = origTopics;
  ok(r && r.mode === "md" && /会话检查点/.test(String(r.reason)),
    "I06 D8 缺失：找不到「会话检查点」线 ⇒ 回落 md 并给出原因（不会自建域/线）", JSON.stringify(r));
  ok(store.topics().filter((t) => t.name === "日记忆（按天流水）" && store.levelOf(t.id) === "domain").length === 1,
    "I06 兜底纪律：整个过程只存在 1 个 D8 域（未重复建域）");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库失败忽略 */ }
// 插件留定时器/监听（真实宿主语义），门跑完主动退出
setTimeout(() => process.exit(fails.length ? 1 : 0), 120);
