// _dream-review-tool-selftest.mjs —— [dream 待审裁决] memory_review_topic 的接线、护栏与真实执行
//
// 跑法：node test/_dream-review-tool-selftest.mjs [index.js 路径]
//
// 背景（starry 2026-11-04）：「这个问题我觉得应该放在 dream 管线里面。因为对于一个实际用户来讲，
//   他不会在意这些，他也不知道这些。如果真的推送给他了，他也不知道怎么处理。」
// 实证：needs_review 14 条全部来自导入期 seed 的**名字级**近重复判定（gradeCreate 只比 norm/triggers，
//   不比内容）；内容实测大多不重复（最低 19%），真重复仅 2~3 条（最高 80.5%）；面板只读、无操作按钮 ⇒ 永久积压。
// 落地：dream 专用工具 memory_review_topic（keep=转 active / merge=独有句子并入目标 + 源归档留指针）。
//
// 覆盖：
//   A 工具已注册 + 参数形态 + 仅 dream 描述
//   B pre-execute 闸覆盖 review（与 split 同闸）
//   C 工具内二次身份闸 DREAM_ONLY
//   D 单轮上限 6 且每轮清零
//   E 容量闸（MERGE_OVERFLOW，按本档上限）
//   F append 失败即中止且**不归档**（MERGE_APPEND_FAILED）
//   G 归档走 archiveTopic（非物理删除）
//   H 精确文本去重（目标已有的句子不重复搬）
//   I 成功置 LAST_DREAM_WROTE_AT + DREAM_REVIEW_ROUND
//   J 任务书含「待审队列」区块 + 裁决规则 + memory_review_topic
//   K toolFilter 含 memory_review_topic
//   L 面板措辞改为「dream 自动裁决」（不再像"等你处理"）
//   M listReviewQueueFromDb 最旧优先 + limit + total
//   N 库层端到端：真跑工具 execute（模拟 dream 身份）——keep / merge / 去重 / 归档 / 错误码 / 轮次上限
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

// ── 静态断言（A~M）──
ok(/name: "memory_review_topic"/.test(src), "A1 工具已注册");
ok(/verdict: \{ type: "string", enum: \["keep", "merge"\]/.test(src), "A2 verdict 枚举 keep|merge");
ok(/into: \{ type: "string", description: "verdict=merge 必填/.test(src), "A3 into 参数（merge 必填）");
ok(/【仅 dream 整合子代理】裁决 needs_review/.test(src), "A4 描述标明仅 dream 可用");
ok(/toolName !== "memory_split_topic" && toolName !== "memory_review_topic"/.test(src), "B pre-execute 闸覆盖 review（与 split 同闸）");
ok(/memory_review_topic 仅 dream 整合子代理可用/.test(src), "C 工具内二次身份闸 DREAM_ONLY");
ok(/DREAM_REVIEW_ROUND >= 6/.test(src) && /DREAM_REVIEW_ROUND = 0;/.test(src), "D 单轮上限 6 且每轮清零");
ok(/code: "MERGE_OVERFLOW"/.test(src) && /dstChars \+ addChars > limitM/.test(src), "E 容量闸按本档上限");
ok(/code: "MERGE_APPEND_FAILED"/.test(src) && /源主题\*\*未归档\*\*/.test(src), "F append 失败即中止且不归档");
ok(/store\.archiveTopic\(srcId, \{/.test(src) && !/store\.deleteTopic\(/.test(src), "G 归档走 archiveTopic（非物理删除）");
ok(/have\.has\(tx\)/.test(src) && /精确文本去重/.test(src), "H 精确文本去重");
ok(/LAST_DREAM_WROTE_AT = Date\.now\(\);/.test(src) && /DREAM_REVIEW_ROUND \+= 1;/.test(src), "I 成功置 LAST_DREAM_WROTE_AT + 计数");
ok(/## 待审队列（needs_review · 由 dream 自动裁决，不推给用户）/.test(src) && /memory_review_topic\(\{ topic, verdict:/.test(src), "J 任务书含待审队列区块 + 裁决规则");
ok(/"memory_dream_patch", "memory_split_topic", "memory_review_topic"\]/.test(src), "K dream toolFilter 含 memory_review_topic");
ok(/由 dream 整合自动裁决（转 active 或并入重复主题），无需人工处理/.test(src), "L 面板措辞改为 dream 自动裁决");
ok(/function listReviewQueueFromDb\(store, maxN\)/.test(src) && /a\.stateSince - b\.stateSince/.test(src), "M 待审队列最旧优先");

// ── 库层端到端（N）：真跑工具 execute ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-reviewtool-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- 待审裁决自测占位\n", "utf8");
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
ok(ready, "N0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));

if (ready) {
  const store = mod.__topicdb.store;
  const hooks = mod.__dreamHooks || {};
  ok(typeof hooks.guardRegister === "function", "N0b 前置：guardRegister 测试钩子已装配");

  const tool = findTool(fx.captured, "memory_review_topic");
  ok(!!(tool && typeof tool.execute === "function"), "N0c 前置：工具定义可取到");

  // 模拟 dream 子代理身份
  const DREAM_SID = "selftest-dream-sid-review-0001";
  const ctrl = new AbortController();
  try { hooks.guardRegister(DREAM_SID, "dream", ctrl, 60000, 60000); } catch (e) { /* 钩子失败则后续 DREAM_ONLY */ }
  const execDream = { name: "memory_review_topic", agent: { session: { id: DREAM_SID } } };
  const execMain = { name: "memory_review_topic", agent: { session: { id: "selftest-main-sid-0001" } } };
  const call = async (args, exec) => JSON.parse(await tool.execute(args, exec || execDream));

  // 造目标主题（3 句）
  const dstName = "review-dst-0001";
  const dt = store.createTopic({ name: dstName, actor: "runtime", confirm: true });
  const DST = dt && dt.id;
  const dstTexts = ["目标句 A：项目 X 的部署包路径 E:\\部署\\20261029。", "目标句 B：接口返回 200 且耗时 87ms。", "目标句 C：口径以交易中心周报为准。"];
  for (const t of dstTexts) store.appendSentence({ topic: DST, text: t, actor: "runtime" });

  // 造待审主题（4 句：2 句与目标完全相同 + 2 句独有）
  const srcName = "review-src-0001";
  const st = store.createTopic({ name: srcName, actor: "runtime", confirm: true });
  const SRC = st && st.id;
  const srcTexts = [dstTexts[0], dstTexts[1], "独有句 D：本机实算 sha256=AB12CD34。", "独有句 E：复核结论为通过。"];
  for (const t of srcTexts) store.appendSentence({ topic: SRC, text: t, actor: "runtime" });
  store.setState(SRC, "needs_review", { actor: "runtime", reason: "selftest" });
  ok(store.readTopic(SRC).state === "needs_review", "N1 造数：源主题进 needs_review");

  // ── 错误路径（不消耗轮次）──
  const rBadVerdict = await call({ topic: SRC, verdict: "delete" });
  ok(rBadVerdict.code === "BAD_ARG", "N2 verdict 非法 → BAD_ARG", rBadVerdict.code);
  const rNoInto = await call({ topic: SRC, verdict: "merge" });
  ok(rNoInto.code === "BAD_ARG", "N3 merge 缺 into → BAD_ARG", rNoInto.code);
  const rBadTarget = await call({ topic: SRC, verdict: "merge", into: "不存在的主题-zzz" });
  ok(rBadTarget.code === "TARGET_NOT_FOUND", "N4 into 不存在 → TARGET_NOT_FOUND", rBadTarget.code);
  const rSelf = await call({ topic: SRC, verdict: "merge", into: SRC });
  ok(rSelf.code === "BAD_TARGET", "N5 into=自己 → BAD_TARGET", rSelf.code);
  const rNotNr = await call({ topic: DST, verdict: "keep" });
  ok(rNotNr.code === "BAD_STATE", "N6 非 needs_review → BAD_STATE", rNotNr.code);
  const rMain = await call({ topic: SRC, verdict: "keep" }, execMain);
  ok(rMain.code === "DREAM_ONLY", "N7 主代理调用 → DREAM_ONLY", rMain.code);

  // ── merge（真跑）：独有 2 句并入目标，源归档 ──
  const beforeDst = store.readTopic(DST).sentences.length;
  const rMerge = await call({ topic: SRC, verdict: "merge", into: DST, note: "自测：两句逐字重合" });
  ok(rMerge.ok === true && rMerge.action === "merge", "N8 merge 执行成功", JSON.stringify(rMerge).slice(0, 200));
  ok(rMerge.movedSentences === 2 && rMerge.skippedDuplicate === 2, "N9 去重：并入 2 句 / 跳过 2 句重复", "added=" + rMerge.movedSentences + " dup=" + rMerge.skippedDuplicate);
  const afterDst = store.readTopic(DST);
  ok(afterDst.sentences.length === beforeDst + 2, "N10 目标句数 +2", beforeDst + " → " + afterDst.sentences.length);
  ok(store.readTopic(SRC).state === "archived", "N11 源主题已归档（内容仍在库）", store.readTopic(SRC).state);
  ok(store.readTopic(SRC).sentences.length === 4, "N12 归档非删除：源主题 4 句仍在", String(store.readTopic(SRC).sentences.length));

  // ── keep（真跑）──
  const k1 = store.createTopic({ name: "review-keep-0001", actor: "runtime", confirm: true });
  store.appendSentence({ topic: k1.id, text: "keep 自测句：内容独特，不与任何主题重复。", actor: "runtime" });
  store.setState(k1.id, "needs_review", { actor: "runtime", reason: "selftest" });
  const rKeep = await call({ topic: k1.id, verdict: "keep", note: "自测：内容独特" });
  ok(rKeep.ok === true && rKeep.action === "keep" && rKeep.state === "active", "N13 keep → 转 active", JSON.stringify(rKeep).slice(0, 160));
  ok(store.readTopic(k1.id).state === "active", "N14 库内 state=active", store.readTopic(k1.id).state);

  // ── 容量闸：目标填到本档上限附近（tier 由 levelOf 决定，main 9000 / detail 40000），再并入必然超 ──
  const big = store.createTopic({ name: "review-big-dst-0001", actor: "runtime", confirm: true });
  let lvBig = "";
  try { lvBig = store.levelOf(big.id) || ""; } catch (eL) { lvBig = ""; }
  const tierBig = lvBig === "detail" ? "detail" : "main";
  const limitBig = tierBig === "detail" ? 40000 : 9000;
  const chunk = "填".repeat(1900);
  let filled = 0;
  while (filled < limitBig - 200) { store.appendSentence({ topic: big.id, text: chunk, actor: "runtime" }); filled += chunk.length; }
  const over = store.createTopic({ name: "review-over-src-0001", actor: "runtime", confirm: true });
  store.appendSentence({ topic: over.id, text: "超限并入句：" + "挤".repeat(400), actor: "runtime" });
  store.setState(over.id, "needs_review", { actor: "runtime", reason: "selftest" });
  const rOver = await call({ topic: over.id, verdict: "merge", into: big.id });
  ok(rOver.code === "MERGE_OVERFLOW", "N15 目标超本档上限 → MERGE_OVERFLOW", "tier=" + tierBig + " limit=" + limitBig + " got=" + rOver.code);
  ok(store.readTopic(over.id).state === "needs_review", "N16 容量闸拒绝后源主题**未被归档**", store.readTopic(over.id).state);

  // ── 轮次上限：已用 2 次（merge + keep），再 keep 4 次到 6，第 7 次拒绝 ──
  //   名字必须彼此差异大：createTopic 有禁建区（归一化编辑距离 ≤2 / 相似度 ≥0.90 会拒建），
  //   「review-round-0/1/2」这种序号式命名会整片撞进去（自测踩过）。
  const ROUND_NAMES = ["部署清单核验", "接口耗时统计", "周报口径确认", "证书过期排查"];
  for (let i = 0; i < ROUND_NAMES.length; i++) {
    const t = store.createTopic({ name: ROUND_NAMES[i], actor: "runtime", confirm: true });
    store.appendSentence({ topic: t.id, text: "轮次上限自测句 " + i + "：内容独特。", actor: "runtime" });
    store.setState(t.id, "needs_review", { actor: "runtime", reason: "selftest" });
    await call({ topic: t.id, verdict: "keep", note: "轮次自测" });
  }
  const t7 = store.createTopic({ name: "隧道配置复盘", actor: "runtime", confirm: true });
  store.appendSentence({ topic: t7.id, text: "轮次上限自测句 7。", actor: "runtime" });
  store.setState(t7.id, "needs_review", { actor: "runtime", reason: "selftest" });
  const rLimit = await call({ topic: t7.id, verdict: "keep" });
  ok(rLimit.code === "ROUND_LIMIT", "N17 第 7 次裁决 → ROUND_LIMIT（上限 6）", rLimit.code);

  // ── listReviewQueueFromDb（真库）──
  try {
    const q = mod.__dreamHooks && mod.__dreamHooks.buildPrompt
      ? null : null;
    // 直接验证渲染侧：任务书里出现待审队列区块（buildDreamPrompt 是 async，必须 await）
    const built = hooks.buildPrompt ? await hooks.buildPrompt({}) : null;
    const ptxt = built && (built.promptText || built.prompt || "");
    ok(!!ptxt && ptxt.indexOf("## 待审队列") >= 0, "N18 任务书真跑含待审队列区块");
    ok(!!ptxt && ptxt.indexOf("memory_review_topic") >= 0, "N19 任务书真跑含 memory_review_topic");
    ok(!!ptxt && /待审队列共 \d+ 条/.test(ptxt), "N20 任务书报出队列条数");
  } catch (eB) {
    ok(false, "N18 任务书真跑", String(eB && eB.message ? eB.message : eB));
  }

  try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
  try { ctrl.abort(); } catch (e) { }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);
