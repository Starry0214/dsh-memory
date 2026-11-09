// topicdb-dreampatch-check.mjs —— task-43（P3：memory_dream_patch 改写主题库）脚本级验收 D01–D07
//
// 做法（不重启宿主）：DSH_HOME/DSH_MEMORY_ROOT/MEMTOPIC_DB 全指临时目录；fake ctx 跑 plugin.apply（flag 开）；
//   用 `__dreamHooks.apply` 直调**线上同一份** applyPatches（不是测试专用复制品）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLUGIN = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
const FIXTURE = "E:/工具/插件开发调整/dsh-memory-plugin/_fixture-ctx.mjs";
const IMPORT = "E:/工具/插件开发调整/memtopic/src/import.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topicdb-dream-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- dream patch 检查占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
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
const shaOfFile = (p) => (fs.existsSync(p) ? sha16(fs.readFileSync(p)) : "(缺失)");
async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store) return true;
    await sleep(100);
  }
  return false;
}

{
  const fx = createFixtureCtx({});
  plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
  ok(await waitReady(), "前置：flag 开 ⇒ 主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
  ok(!!(mod.__dreamHooks && typeof mod.__dreamHooks.apply === "function"), "前置：dream patch 测试钩子已装配（直调线上 applyPatches）");
}

const store = mod.__topicdb.store;
const H = mod.__dreamHooks;
const REL = "projects/面板检查.md";
const MD_FILE = path.join(MEM, "projects", "面板检查.md");
const S1 = "第一句：原文甲";
const S2 = "第二句：原文乙";
const S3 = "第三句：原文丙";
// 造主题：src 指向 REL（映射靠句子 src 索引）
const seed = store.seedTopic({ name: "面板检查模板", triggers: ["面板检查"], src: REL });
for (const t of [S1, S2, S3]) store.appendSentence({ topic: seed.id, text: t, src: REL, actor: "plugin" });
const texts = () => (store.readTopic(seed.id).sentences || []).map((x) => String(x.text));
ok(texts().length === 3, "造数：主题「面板检查模板」3 句，src=projects/面板检查.md", JSON.stringify(texts()));
const mdBefore = shaOfFile(MD_FILE);   // 此时磁盘上没有该 md（"(缺失)"）

// ── D01 flag 开：append / edit / delete 三种 patch ⇒ 库正确、md 零变化 ──
const P1 = { file: REL, action: "append", content: "新增要点丙" };
const P2 = { file: REL, action: "edit", old_string: S2, new_string: "第二句：改写乙" };
const P3 = { file: REL, action: "delete", content: S3 };
let r1 = null;
{
  r1 = H.apply([P1, P2, P3]);
  const t = texts();
  ok(r1 && r1.ok === true && r1.mode === "db" && r1.channel === "db",
    "D01 路由：flag 开 ⇒ mode=db / channel=db（写主题库）", JSON.stringify({ mode: r1 && r1.mode, channel: r1 && r1.channel }));
  ok(r1 && r1.sentencesAdded === 1 && r1.sentencesReplaced === 1 && r1.sentencesDeleted === 1,
    "D01 计数：append +1 / replace 1 / delete 1", JSON.stringify({ add: r1 && r1.sentencesAdded, rep: r1 && r1.sentencesReplaced, del: r1 && r1.sentencesDeleted }));
  ok(t.includes("新增要点丙") && t.includes("第二句：改写乙") && !t.includes(S2) && !t.includes(S3),
    "D01 落库：append 新增 / edit 整句替换 / delete 移除，三动作语义正确", JSON.stringify(t));
  ok(shaOfFile(MD_FILE) === mdBefore, "D01 不写 md：projects/面板检查.md 全程未被创建/改动", mdBefore);
}

// ── D03 删除后同文本再 import 不复活（依赖 store 历史 sha）──
{
  const delText = S1;
  const rDel = H.apply([{ file: REL, action: "delete", content: delText }]);
  ok(rDel && rDel.ok === true && rDel.sentencesDeleted === 1, "D03 删除：delete patch 生效", JSON.stringify({ del: rDel && rDel.sentencesDeleted }));
  ok(!texts().includes(delText), "D03 删除后库里不再有该句");
  const hist = (typeof store.historicShas === "function") ? store.historicShas(seed.id) : null;
  const shaOfDel = createHash("sha256").update(delText, "utf8").digest("hex").slice(0, 16);
  ok(hist && hist.has && hist.has(shaOfDel), "D03 历史 sha 留存：historicShas 含被删句 sha（导入端据此拦复活）", shaOfDel);
  // 真跑导入器：把被删句写回 md，再 importDir ⇒ 应判 skippedHistoricSha，且不复活
  fs.writeFileSync(MD_FILE, "# 面板检查模板\n\n" + delText + "\n", "utf8");
  const mdShaBeforeImport = shaOfFile(MD_FILE);
  const IMP = await import(pathToFileURL(IMPORT).href);
  const rep = IMP.importDir(store, { root: MEM, dirs: ["projects"], actor: "plugin" });
  ok(Number(rep.sentencesAdded || 0) === 0 && (Number(rep.skippedHistoricSha || 0) + Number(rep.skippedDuplicate || 0)) >= 1,
    "D03 真实导入：同文本再导入被拦（skippedHistoricSha/Duplicate ≥1、新增 0）——不复活",
    "skippedHistoricSha=" + rep.skippedHistoricSha + " / skippedDuplicate=" + rep.skippedDuplicate + " / added=" + rep.sentencesAdded);
  ok(!texts().includes(delText), "D03 不复活：导入后主题里仍没有该句", JSON.stringify(texts()));
  ok(shaOfFile(MD_FILE) === mdShaBeforeImport, "D03 只读：导入器未改动 md 源文件（sha 不变）");
}

// ── D02 CAS 冲突：old_string 不匹配 ⇒ conflicts[] 且零变化 ──
{
  const before = JSON.stringify(texts());
  const r2 = H.apply([{ file: REL, action: "edit", old_string: "不存在的句子X", new_string: "" }]);
  const after = JSON.stringify(texts());
  ok(r2 && r2.ok === false && Array.isArray(r2.conflicts) && r2.conflicts.length === 1
    && (r2.conflicts[0].code === "SENTENCE_NOT_FOUND" || /NOT_FOUND/.test(String(r2.conflicts[0].code))),
    "D02 CAS 冲突：old_string 不匹配 ⇒ conflicts[1]（SENTENCE_NOT_FOUND）", JSON.stringify(r2 && r2.conflicts));
  ok(before === after, "D02 不部分生效：冲突后该 patch 零净变化（整体回滚语义）", before === after ? "一致" : "变了");
  ok(Array.isArray(r2 && r2.errors) && r2.errors.length === 1 && /已回滚/.test(r2.errors[0]), "D02 可诊断：errors 里明确写「该条已回滚，零改动」");
}

// ── D04 unmapped file ⇒ 回落 md 且 unmapped 计数 ──
{
  const REL2 = "projects/未映射面板检查.md";
  const F2 = path.join(MEM, REL2);
  const before = JSON.stringify(texts());
  const r4 = H.apply([{ file: REL2, action: "append", content: "未映射兜底一句" }]);
  ok(r4 && Array.isArray(r4.unmapped) && r4.unmapped.length === 1 && /未映射面板检查/.test(String(r4.unmapped[0])),
    "D04 unmapped：匹配不到主题的文件记 unmapped[]", JSON.stringify(r4 && r4.unmapped));
  ok(fs.existsSync(F2) && fs.readFileSync(F2, "utf8").includes("未映射兜底一句"),
    "D04 回落 md：该条走原 md 落盘（不静默丢）");
  ok(before === JSON.stringify(texts()), "D04 不误写：unmapped 条目不污染已映射主题");
}

// ── D05 flag 关：老行为逐字（写 md），库零变化 ──
{
  const before = JSON.stringify(texts());
  const mdShaBefore = shaOfFile(MD_FILE);
  const enabledBackup = mod.__topicdb.enabled;
  mod.__topicdb.enabled = false;
  const r5 = H.apply([{ file: REL, action: "append", content: "flag关闭md一句" }]);
  mod.__topicdb.enabled = enabledBackup;
  ok(r5 && r5.ok === true && r5.mode === "written" && r5.channel === "md",
    "D05 flag 关：mode=written / channel=md（走原 md 路径）", JSON.stringify({ mode: r5 && r5.mode, channel: r5 && r5.channel }));
  ok(fs.readFileSync(MD_FILE, "utf8").includes("flag关闭md一句"), "D05 老行为：内容真的写进了 md 文件");
  ok(shaOfFile(MD_FILE) !== mdShaBefore, "D05 md 确实被改写（sha 变化）");
  ok(before === JSON.stringify(texts()), "D05 不写库：flag 关时主题句子零变化");
}

// ── D06 坏库 ⇒ 回落 md、不抛错 ──
{
  const goodStore = mod.__topicdb.store;
  let threw = null; let r6 = null;
  try {
    mod.__topicdb.store = { topics() { throw new Error("simulated: dream db locked"); } };
    r6 = H.apply([{ file: REL, action: "append", content: "坏库回落一句" }]);
  } catch (e) { threw = e; }
  mod.__topicdb.store = goodStore;
  ok(!threw && r6 && r6.ok === true && r6.channel === "md",
    "D06 坏库：写库抛错 ⇒ 整批回落 md（channel=md）且不抛异常", threw ? ("抛了: " + threw.message) : JSON.stringify({ channel: r6 && r6.channel }));
  ok(fs.readFileSync(MD_FILE, "utf8").includes("坏库回落一句"), "D06 兜底：内容仍落在 md 里（不丢）");
}

// ── D07 幂等：同一批 patch 重复提交 ⇒ duplicate:true、0 变化 ──
{
  const before = JSON.stringify(texts());
  const r7 = H.apply([P1, P2, P3]);
  ok(r7 && r7.ok === true && r7.duplicate === true,
    "D07 幂等：同批 patch 重复提交 ⇒ duplicate=true（meta dreampatch:<sha>）", JSON.stringify({ dup: r7 && r7.duplicate }));
  ok(before === JSON.stringify(texts()), "D07 幂等：主题句子零变化", before === JSON.stringify(texts()) ? "一致" : "变了");
  ok(r7 && r7.sentencesAdded === 0 && r7.sentencesDeleted === 0, "D07 幂等：计数全 0（未重复落库）");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { /* 关库忽略 */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 120);
