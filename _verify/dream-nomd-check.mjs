// dream-nomd-check.mjs —— task-54：dream 去 md 化（体检 / 任务书 / dream_patch 三处切主题寻址）
//
// 运行：node dsh-memory-plugin/_verify/dream-nomd-check.mjs
// 纪律：全部临时 DSH_HOME/MEMORY_ROOT；真实 ~/.dsh 只 stat；不部署不重启。
// 依赖线上内部钩子（__dreamHooks.apply / buildPrompt / buildOverLimitHealthLib / buildOverLimitHealthMd / spawnIntegrate）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = "E:/工具/插件开发调整";
const PLUGIN = ROOT + "/dsh-memory-plugin/index.js";
const FIXTURE = ROOT + "/dsh-memory-plugin/_fixture-ctx.mjs";

// D3 基线：task-54 改动前（sha16 2511945414A2D68C）用固定 fixture 实测的 flag 关任务书（归一化后）
const BASE_PROMPT = { chars: 10031, sha256: "9ceb86ddfe0dc9bb3c8c0591cefaed229ef1936399aa782cb0bb801ccdfe5334" };
// D3 体检基线：改造前 md 口径字符串（逐字）
const BASE_MD_HEALTH = "projects/面板.md 仍超限（字符 14551 > 9000，本轮未写）——下次整合优先提取";

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + String(detail).slice(0, 300) : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + String(detail).slice(0, 500) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exportMdRe = /(projects|knowledge|sessions|tools)[\\/][^\s，。；：)（]*\.md/;
const portable = (p) => String(p).replace(/\\/g, "/");

function mkEnv(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dream-nomd-" + tag + "-"));
  const home = path.join(tmp, "dsh-home");
  const mem = path.join(home, "memory");
  for (const d of ["sessions", "projects", "knowledge", "tools"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
  fs.writeFileSync(path.join(mem, "global.md"), "# 全局记忆\n- 画像句\n", "utf8");
  fs.writeFileSync(path.join(mem, "index.md"), "# 记忆索引\n- x\n", "utf8");
  fs.writeFileSync(path.join(mem, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
  return { tmp, home, mem };
}
function writeMd(mem, rel, text) { const f = path.join(mem, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, "utf8"); }
async function boot(e, cfg, query) {
  process.env.DSH_HOME = e.home; process.env.DSH_MEMORY_ROOT = e.mem; process.env.MEMTOPIC_DB = path.join(e.mem, ".memtopic", "mem.db"); delete process.env.MEMTOPIC_DIR;
  const mod = await import(pathToFileURL(PLUGIN).href + "?" + query + "=" + Date.now());
  const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);
  const fx = createFixtureCtx();
  let threw = null; try { mod.default.apply(fx.ctx, cfg || {}); } catch (x) { threw = x; }
  return { mod, fx, threw };
}
async function waitReady(mod, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store) return true; await sleep(100); }
  return false;
}
async function preExec(fx, exec) {
  const hs = (fx.captured.handlers || []).filter((h) => h.event === "tools/pre-execute");
  const next = async () => ({ kind: "allow", via: "next" });
  let last = await next();
  for (const h of hs) {
    let r = null;
    try { r = await h.fn(exec, next); } catch (x) { r = null; }
    if (r && r.kind === "deny") return r;
    if (r && r.kind === "allow") last = r;
  }
  return last;
}
function runChecker(file, expectPass) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "dsh-memory-plugin", "_verify", file)], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
  const out = String(r.stdout || "") + String(r.stderr || "");
  let passN = -1, totalN = -1;
  const m0 = out.match(/结果:\s*PASS=(\d+)\s+FAIL=(\d+)/); if (m0) { passN = Number(m0[1]); totalN = Number(m0[1]) + Number(m0[2]); }
  const m1 = out.match(/全部通过\s*(\d+)\s*\/\s*(\d+)/); if (passN < 0 && m1) { passN = Number(m1[1]); totalN = Number(m1[2]); }
  if (passN < 0) { const m2 = out.match(/(\d+)\s*\/\s*(\d+)\s*通过/); if (m2) { passN = Number(m2[1]); totalN = Number(m2[2]); } }
  if (passN < 0) { const m3 = out.match(/(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/); if (m3) { passN = Number(m3[1]); totalN = Number(m3[1]) + Number(m3[2]); } }
  return { code: r.status, pass: passN, total: totalN, expect: expectPass, tail: out.trim().split(/\r?\n/).slice(-2).join(" | ") };
}

async function main() {
  // ══ 场景 A：flag 开（库模式）══
  console.log("\n=== A. flag 开：任务书/体检/dream_patch 全线主题寻址 ===");
  const eA = mkEnv("a");
  writeMd(eA.mem, "projects/面板.md", "# 面板\n- md 句\n");
  writeMd(eA.mem, "sessions/2026-10-29.md", "# 会话\n- md 句\n");
  writeMd(eA.mem, "_export/2026-10-30/x.md", "# 导出快照\n- e\n");
  const { mod, fx, threw } = await boot(eA, { memoryTopicDbEnabled: true }, "a");
  ok(!threw, "A0 插件加载不抛错", threw && threw.message);
  ok(await waitReady(mod), "A0 主题库就绪");
  const store = mod.__topicdb.store;
  const dom = store.createDomain("任务54域", { actor: "lead" });
  const seed = store.seedTopic({ name: "面板主题", triggers: [], src: "projects/面板.md" });
  // [Lead 2026-10-31] 三档口径后 9,500 字符对 detail(40K 档) 不算超限；本场景要测的是**主主题档**（9K），故标 project。
store.setLevel(seed.id, "project", { actor: "lead" }); store.linkParent(seed.id, dom.id, { actor: "lead" });
  store.appendSentence({ topic: seed.id, text: "超".repeat(9500), src: "projects/面板.md", actor: "plugin" });
  const H = mod.__dreamHooks;

  // D1 库模式任务书
  const dp = await H.buildPrompt({});
  const pt = String(dp.promptText || "");
  ok(dp.libMode === true, "D1 任务书走库模式（libMode=true）", "bytes=" + Buffer.byteLength(pt, "utf8"));
  ok(!exportMdRe.test(pt), "D1 任务书不含导出视图 md 路径（projects|knowledge|sessions|tools/*.md）", (pt.match(exportMdRe) || [])[0] || "(无)");
  ok(/memory_read/.test(pt) && /memory_search/.test(pt), "D1 任务书写明用 memory_read/memory_search 读主题");
  ok(pt.includes(seed.id), "D1 任务书含主题 ID（候选/超限主题）", seed.id);
  ok(/splitTopic/.test(pt), "D1 任务书含 splitTopic 建议动作");
  ok(/md 是导出视图/.test(pt), "D1 任务书明确「md 是导出视图」");
  ok(/global\.md/.test(pt) && /index\.md/.test(pt), "D1 保留人工稳定层例外（global.md/index.md）");

  // D2 库模式体检
  const ol = H.buildOverLimitHealthLib({ writtenTopics: new Set() });
  const keys = Object.keys(ol.stuck || {});
  ok(keys.length === 1 && keys[0] === seed.id, "D2 体检键 = topicId（库内回显）", JSON.stringify(keys));
  ok(!/\.md/.test(ol.healthLines.join("\n")) && !/projects\//.test(ol.healthLines.join("\n")), "D2 体检文案不含 .md 路径", ol.healthLines[0]);
  ok(/主题「面板主题」（T-\d+）超限 9500 字符（上限 9000）/.test(ol.healthLines[0]), "D2 体检文案「主题 XXX 超限 N 字符（上限 M）」", ol.healthLines[0]);
  const stuckRow = ol.stuck[seed.id] || {};
  ok(stuckRow.name === "面板主题" && stuckRow.chars === 9500 && stuckRow.limit === 9000 && stuckRow.overBy === 500 && stuckRow.rounds === 1,
    "D2 体检结构 {name,chars,limit,overBy(=chars-limit),rounds,tier}", JSON.stringify(stuckRow));

  // D4 dream_patch topic 寻址
  let r4 = null; try { r4 = H.apply([{ topic: "面板主题", action: "append", content: "topic 寻址新增句" }], {}); } catch (x) { r4 = { err: x.message }; }
  const live4 = (store.readTopic(seed.id).sentences || []).map((s) => String(s.text));
  ok(r4 && r4.ok === true && r4.channel === "db" && Array.isArray(r4.topicIds) && r4.topicIds.includes(seed.id) && r4.topicId === seed.id,
    "D4 memory_dream_patch({topic:\"<名字>\"}) 写入成功、落到该主题、返回 topicId", JSON.stringify({ ok: r4 && r4.ok, channel: r4 && r4.channel, topicIds: r4 && r4.topicIds }));
  ok(live4.includes("topic 寻址新增句"), "D4 主题正文实际包含新句", "sentences=" + live4.length);

  // D5 裸导出视图 file（tool 路径）⇒ 整批拒绝（task-55 起；不再"兼容写库"）
  const tool = (fx.captured.tools || []).find((t) => t && t.name === "memory_dream_patch");
  let r5 = null; const errs5 = [];
  try { r5 = H.apply([{ file: "projects/面板.md", action: "append", content: "裸导出视图不该写" }], { dream: true }); }
  catch (x) { errs5.push(x.message); }
  ok(!!tool && !errs5.length && r5 && r5.ok === false && r5.error === "EXPORT_VIEW_READONLY" && r5.wrote === 0,
    "D5 裸导出视图 file ⇒ 整批拒绝（ok=false / EXPORT_VIEW_READONLY / wrote=0）", errs5[0] || JSON.stringify({ ok: r5 && r5.ok, error: r5 && r5.error, wrote: r5 && r5.wrote }));
  ok(!!r5 && typeof r5.message === "string" && /导出视图/.test(r5.message) && /topic/.test(r5.message) && /memory_topics|memory_search/.test(String(r5.hint || "")),
    "D5 拒绝文案含「导出视图 + 改用 topic 寻址 + 先 memory_topics/memory_search」", r5 && (r5.message + " ｜ " + r5.hint));

  // D6 global.md / index.md 人工稳定层不受影响
  let r6 = null, r6b = null;
  try { const a = JSON.parse(String(await tool.execute({ patches: [{ file: "global.md", action: "append", content: "- 人工层新句" }] }))); r6 = a; } catch (x) { r6 = { err: x.message }; }
  try { const b = JSON.parse(String(await tool.execute({ patches: [{ file: "index.md", action: "append", content: "- 索引新行 → projects/面板.md" }] }))); r6b = b; } catch (x) { r6b = { err: x.message }; }
  const globalTxt = fs.readFileSync(path.join(eA.mem, "global.md"), "utf8");
  const indexTxt = fs.readFileSync(path.join(eA.mem, "index.md"), "utf8");
  ok(r6 && r6.ok === true && globalTxt.includes("人工层新句"), "D6 global.md 写入不受影响（实测落盘）", r6 && r6.err);
  ok(r6b && r6b.ok === true && indexTxt.includes("索引新行"), "D6 index.md 写入不受影响（实测落盘）", r6b && r6b.err);

  // ── D9（task-55 闸1）：裸 file 导出视图 ⇒ 整批拒绝 + 库句数不变 + md 未写 ──
  {
    const beforeN = (store.readTopic(seed.id).sentences || []).length;
    const mdBefore = fs.readFileSync(path.join(eA.mem, "projects/面板.md"), "utf8");
    let r9 = null;
    try { r9 = H.apply([{ file: "projects/面板.md", action: "append", content: "裸 file 不该落库" }], { dream: true }); } catch (x) { r9 = { err: x.message }; }
    const afterN = (store.readTopic(seed.id).sentences || []).length;
    const mdAfter = fs.readFileSync(path.join(eA.mem, "projects/面板.md"), "utf8");
    ok(r9 && r9.ok === false && r9.error === "EXPORT_VIEW_READONLY" && r9.wrote === 0 && r9.rejected === true,
      "D9 裸导出视图 file ⇒ 整批拒绝（EXPORT_VIEW_READONLY / rejected / wrote=0）", JSON.stringify({ ok: r9 && r9.ok, error: r9 && r9.error, wrote: r9 && r9.wrote }));
    ok(beforeN === afterN && (store.readTopic(seed.id).sentences || []).every((x) => String(x.text) !== "裸 file 不该落库"),
      "D9 硬拒后库内句数/内容不变（绝不半批落盘）", "before=" + beforeN + " after=" + afterN);
    ok(mdBefore === mdAfter, "D9 导出视图 md 未被写");
  }

  // ── D10：同时给 topic+file ⇒ 以 topic 为准（成功写入，不报错）──
  {
    const mdBefore = fs.readFileSync(path.join(eA.mem, "projects/面板.md"), "utf8");
    let r10 = null;
    try { r10 = H.apply([{ topic: "面板主题", file: "projects/面板.md", action: "append", content: "topic+file 以 topic 为准" }], { dream: true }); } catch (x) { r10 = { err: x.message }; }
    const topicHas = (store.readTopic(seed.id).sentences || []).some((x) => String(x.text) === "topic+file 以 topic 为准");
    ok(r10 && r10.ok === true && r10.channel === "db" && Array.isArray(r10.topicIds) && r10.topicIds.includes(seed.id),
      "D10 同时给 topic+file ⇒ 以 topic 写入成功（不报 EXPORT_VIEW_READONLY）", JSON.stringify({ ok: r10 && r10.ok, channel: r10 && r10.channel, error: r10 && r10.error }));
    ok(topicHas && fs.readFileSync(path.join(eA.mem, "projects/面板.md"), "utf8") === mdBefore, "D10 内容落到主题、导出视图 md 未被写");
  }

  // ── D11：人工稳定层与 _export 读取不受影响 ──
  {
    const dG = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "global.md") } });
    const dI = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "index.md") } });
    const dE = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "_export/2026-10-30/x.md") } });
    ok(dG && dG.kind === "allow" && dI && dI.kind === "allow", "D11 global.md / index.md 读取不被拦（人工稳定层例外）", JSON.stringify(dG) + " " + JSON.stringify(dI));
    ok(dE && dE.kind === "allow", "D11 _export/** 读取不被拦（导出快照允许读）", JSON.stringify(dE));
  }

  // ── D12（task-55 闸2）：拦 projects/knowledge 的 md 读取；sessions 不拦 ──
  {
    const dP = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "projects/面板.md") } });
    const dK = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "knowledge/明细.md") } });
    const dS = await preExec(fx, { name: "read", arguments: { path: path.join(eA.mem, "sessions/2026-10-29.md") } });
    ok(dP && dP.kind === "deny" && dP.code === "EXPORT_VIEW_READONLY" && /导出视图/.test(String(dP.reason)) && /memory_read/.test(String(dP.reason)),
      "D12 projects/*.md 读取被拦（deny + 导出视图提示）", JSON.stringify(dP));
    ok(dK && dK.kind === "deny", "D12 knowledge/*.md 读取被拦", JSON.stringify(dK));
    ok(dS && dS.kind === "allow", "D12 sessions/*.md 读取**不被拦**（归档链路）", JSON.stringify(dS));
  }

  // D7 库模式任务书生成：导出视图 md 的 readFileSync 次数 = 0
  const origRead = fs.readFileSync;
  const hits = [];
  fs.readFileSync = function (p, ...rest) {
    try { const s = String(p); if (/(projects|knowledge|sessions|tools)[\\/][^\s]*\.md$/i.test(s)) hits.push(s); } catch (x) { /* noop */ }
    return origRead.call(this, p, ...rest);
  };
  let dp7 = null;
  try { dp7 = await H.buildPrompt({ calibStats: "D 样本不足", eCalibStats: "E 样本不足", wCalibStats: "W 样本不足", brkCalibStats: "Break 样本不足", maintStats: "Maint 样本不足", lessonFeedText: "" }); }
  finally { fs.readFileSync = origRead; }
  ok(!!dp7 && String(dp7.promptText || "").length > 0, "D7 任务书生成成功（非空）", "bytes=" + (dp7 ? Buffer.byteLength(String(dp7.promptText), "utf8") : 0));
  ok(hits.length === 0, "D7 库模式任务书生成全程：导出视图 md 的 fs.readFileSync 次数 = 0", "hits=" + hits.length + (hits.length ? " " + JSON.stringify(hits.slice(0, 3)) : ""));

  // ══ 场景 B：flag 关（md 口径逐字等价）══
  console.log("\n=== B. flag 关：任务书/体检与改动前逐字等价（D3）===");
  const eB = mkEnv("b");
  writeMd(eB.mem, "global.md", "# 全局记忆\n- 画像句一\n");
  writeMd(eB.mem, "index.md", "# 记忆索引\n- 项目 → projects/面板.md\n");
  writeMd(eB.mem, "sessions/2026-10-29.md", "# 2026-10-29\n\n## 当日要点\n- 会话句一\n- 会话句二\n");
  writeMd(eB.mem, "projects/面板.md", "# 面板\n\n## 归档\n" + "- 旧句".repeat(3200) + "\n");
  writeMd(eB.mem, "knowledge/明细.md", "# 明细\n- 明细句\n");
  const { mod: modB, fx: fxB } = await boot(eB, {}, "b");
  const H2 = modB.__dreamHooks;
  const parent = { options: {}, session: { id: "parent-d3", header: { origin: "user", cwd: "E:/work/demo" } }, inject() {} };
  const crH = (fxB.captured.handlers || []).find((x) => x.event === "agent/created");
  if (crH) crH.fn({ agent: parent, source: "startup" });
  await sleep(600);
  const captured = [];
  const origStart = fxB.subagents.start;
  fxB.subagents.start = async (...args) => { captured.push(args); return { result: { ok: true }, label: "fake-dream" }; };
  let spawnErr = null;
  try { await H2.spawnIntegrate(parent, "手动"); } catch (x) { spawnErr = x; }
  for (let i = 0; i < 40 && !captured.length; i++) await sleep(100);
  fxB.subagents.start = origStart;
  const obj = captured.length ? captured[0].find((x) => x && typeof x === "object") : null;
  const promptB = ((obj && (obj.prompt || obj.messages)) || []).map((x) => (x && (x.type === "text" ? x.text : (typeof x === "string" ? x : "")) || "")).join("");
  const norm = (t) => String(t).split(portable(eB.mem)).join("<MEM>").split(portable(eB.home)).join("<HOME>").split(portable(eB.tmp)).join("<TMP>").replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  const got = { chars: norm(promptB).length, sha256: createHash("sha256").update(norm(promptB)).digest("hex") };
  ok(!spawnErr && captured.length === 1, "D3 flag 关：任务书仍可生成（md 路径未被破坏）", spawnErr ? spawnErr.message : "captured=" + captured.length);
  ok(got.chars === BASE_PROMPT.chars && got.sha256 === BASE_PROMPT.sha256,
    "D3 flag 关：任务书与改造前基线**逐字等价**", "got=" + JSON.stringify(got) + " base=" + JSON.stringify(BASE_PROMPT));
  const mdHealth = H2.buildOverLimitHealthMd([{ rel: "projects/面板.md", chars: 14551 }], new Set());
  ok(mdHealth.length === 1 && mdHealth[0] === BASE_MD_HEALTH, "D3 flag 关：md 体检文案与改造前逐字等价", mdHealth[0]);

  // ── D13（flag 关）：D9/D12 两个场景回到原行为 ──
  {
    writeMd(eB.mem, "projects/小文件.md", "# 小文件\n- 句\n");   // D3 基线 fixture 之后再加，避免改任务书候选
    const mdPath = path.join(eB.mem, "projects/小文件.md");
    const mdBefore = fs.readFileSync(mdPath, "utf8");
    let r13 = null;
    try { r13 = H2.apply([{ file: "projects/小文件.md", action: "append", content: "flag 关仍写 md" }], { dream: true }); } catch (x) { r13 = { err: x.message }; }
    ok(r13 && r13.ok === true && r13.channel === "md" && fs.readFileSync(mdPath, "utf8").includes("flag 关仍写 md") && fs.readFileSync(mdPath, "utf8") !== mdBefore,
      "D13 flag 关：裸导出视图 file 仍按原行为写 md（不硬拒）", JSON.stringify({ ok: r13 && r13.ok, channel: r13 && r13.channel, error: r13 && r13.error }));
    const dP13 = await preExec(fxB, { name: "read", arguments: { path: path.join(eB.mem, "projects/面板.md") } });
    ok(dP13 && dP13.kind === "allow", "D13 flag 关：projects/*.md 读取不被拦（零变化）", JSON.stringify(dP13));
  }

  // ══ D8：既有门不破 ══
  console.log("\n=== D8 既有断言基线（只跑不改）===");
  const gates = [
    ["D8/D14 sink 42", "topicdb-sink-check.mjs", 42],
    ["D8/D14 compat 39", "topicdb-compat-check.mjs", 39],
    ["D8/D14 migrate-notice 52", "migrate-notice-check.mjs", 52],
    ["D8/D14 panel 143", "topicdb-panel-check.mjs", 143],
    ["D8/D14 p6 38", "topicdb-p6-check.mjs", 38],
    ["D8/D14 p5 30", "topicdb-p5-check.mjs", 30],
    ["D8/D14 dreampatch 28", "topicdb-dreampatch-check.mjs", 28],
  ];
  for (const [name, file, expect] of gates) {
    const r = runChecker(file, expect);
    ok(r.code === 0 && r.pass === expect && r.total === expect, name, "exit=" + r.code + " " + r.pass + "/" + r.total + " | " + r.tail);
  }

  console.log("\n结果: PASS=" + pass + " FAIL=" + fails.length);
  if (fails.length) console.log("失败项: " + fails.join(" | "));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("检查器崩溃：", (e && e.stack) || e); process.exit(2); });
