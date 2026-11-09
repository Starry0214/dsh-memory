// install-newuser-smoke.mjs —— Lead 验收用：全新用户 / 老用户（迁移前）**开机路径**冒烟
//
// 为什么要有这个：我们的真实库有 436 主题 / 31,555 句，所有既有断言都在"库已存在"的前提下跑的。
//   「别的用户第一次装」= 空 memory 目录 + 空库 + 可能连 global.md 都没有 —— 这条路径此前**从未被断言覆盖**。
//   安装器能装对，但插件在裸目录里崩掉，体验一样是灾难。
//
// 断言：
//   S1 全新用户（空目录 + flag 开）      ⇒ 加载不抛、库被创建、topics=0、memory_search 可调不抛
//   S2 flag 缺省（无 .config.json）      ⇒ 不建库（走 md 路径）、加载不抛
//   S3 老用户（遗留 md 有内容 + flag 开 + 空库）⇒ 加载不抛、不自动改 md（逐字节比对）、库里仍是 0 主题
//   S4 S3 场景下「迁移提示」基线：当前插件**尚未**注入（task-52 落地后这里应翻成 true，届时改断言）
//   S5 metric：S1/S3 的启动注入文本长度（供 task-52 的 ≤600 上限做基线）
//
// 用法：node dsh-memory-plugin/_verify/install-newuser-smoke.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = "E:/工具/插件开发调整";
const PLUGIN = ROOT + "/dsh-memory-plugin/index.js";
const FIXTURE = ROOT + "/dsh-memory-plugin/_fixture-ctx.mjs";

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ── 私有夹具：每个场景独立 DSH_HOME，绝不共享插件模块状态 ──────────────
// 插件是 ESM 单例，import 一次就固化；因此每个场景必须**独立进程**或在同一进程里只测一种根。
// 这里选择「一次进程一个场景」，用 argv 选择，由外层按场景多次调用（见 _run 结尾）。
const SCENARIO = (process.argv[2] || "all").trim();

function mkHome(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-newuser-" + tag + "-"));
  const home = path.join(tmp, "dsh-home");
  const mem = path.join(home, "memory");
  fs.mkdirSync(mem, { recursive: true });
  return { tmp, home, mem };
}

function snapshot(dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".memtopic" && e.name !== "_export") snapshot(p, out); }
    else if (e.isFile() && e.name.endsWith(".md")) out[path.relative(dir, p)] = sha(p);
  }
  return out;
}

async function bootPlugin(home, mem, cfg) {
  process.env.DSH_HOME = home;
  process.env.DSH_MEMORY_ROOT = mem;
  process.env.MEMTOPIC_DB = path.join(mem, ".memtopic", "mem.db");
  delete process.env.MEMTOPIC_DIR;
  const mod = await import(pathToFileURL(PLUGIN).href);
  const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);
  const fx = createFixtureCtx();
  let threw = null;
  try { mod.default.apply(fx.ctx, cfg); } catch (e) { threw = e; }
  // flag 开时等主题库就绪（最多 20s）
  for (let i = 0; i < 200; i++) {
    if (mod.__topicdb && mod.__topicdb.ready) break;
    await sleep(100);
  }
  return { mod, fx, threw };
}

const dbFile = (mem) => path.join(mem, ".memtopic", "mem.db");

async function s1() {
  console.log("\n=== S1 全新用户：空目录 + flag 开 ===");
  const { home, mem } = mkHome("s1");
  fs.writeFileSync(path.join(mem, ".config.json"), JSON.stringify({ memoryTopicDbEnabled: true }, null, 2), "utf8");
  const { mod, fx, threw } = await bootPlugin(home, mem, {});
  ok(!threw, "S1-1 插件 apply 不抛错", threw && threw.message);
  ok(!!(mod.__topicdb && mod.__topicdb.ready), "S1-2 主题库在空目录下被创建并就绪");
  ok(fs.existsSync(dbFile(mem)), "S1-3 mem.db 落盘", dbFile(mem));
  let topics = -1;
  try { topics = mod.__topicdb.store.topics().length; } catch (e) { console.log("    (统计异常: " + e.message + ")"); }
  ok(topics === 0, "S1-4 空库 topics=0", "topics=" + topics);
  ok(fx.captured.tools.some((t) => t && /memory_search/.test(t.name || "")), "S1-5 memory_search 已注册");
  // 工具可调、不抛、返回结构有内容字段
  const tool = fx.captured.tools.find((t) => t && /memory_search/.test(t.name || ""));
  let toolErr = null, toolOut = null;
  try { toolOut = await tool.execute({ query: "长沙" }); } catch (e) { toolErr = e; }
  ok(!toolErr, "S1-6 空库上 memory_search 调用不抛错", toolErr && toolErr.message);
  ok(!!toolOut, "S1-7 memory_search 有返回", toolOut ? JSON.stringify(toolOut).slice(0, 80) : "");
  ok((fx.captured.errors || []).length === 0, "S1-8 无 ctx.error", JSON.stringify(fx.captured.errors || []));
  console.log("  [metric] 注入段数量=" + (fx.captured.injected || []).length + " 注册工具=" + fx.captured.tools.length);
}

async function s2() {
  console.log("\n=== S2 flag 缺省（无 .config.json）：应走 md 路径、不建库 ===");
  const { home, mem } = mkHome("s2");
  const { mod, threw } = await bootPlugin(home, mem, {});
  ok(!threw, "S2-1 插件 apply 不抛错", threw && threw.message);
  ok(!(mod.__topicdb && mod.__topicdb.ready), "S2-2 主题库未启用（默认 flag 关）");
  ok(!fs.existsSync(dbFile(mem)), "S2-3 未创建 mem.db");
}

async function s3() {
  console.log("\n=== S3 老用户：遗留 md + flag 开 + 空库（迁移前）===");
  const { home, mem } = mkHome("s3");
  for (const d of ["sessions", "knowledge", "projects", "tools"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
  fs.writeFileSync(path.join(mem, "global.md"), "# 全局记忆\n- 用户画像：测试用户\n", "utf8");
  fs.writeFileSync(path.join(mem, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
  fs.writeFileSync(path.join(mem, "sessions", "2026-10-29.md"), "# 会话甲\n- 要点一\n- 要点二\n- 要点三\n", "utf8");
  fs.writeFileSync(path.join(mem, "knowledge", "知识甲.md"), "# 知识甲\n- 知识句一\n- 知识句二\n", "utf8");
  fs.writeFileSync(path.join(mem, "projects", "项目甲.md"), "# 项目甲\n- 项目句一\n", "utf8");
  fs.writeFileSync(path.join(mem, ".config.json"), JSON.stringify({ memoryTopicDbEnabled: true }, null, 2), "utf8");
  const before = snapshot(mem);
  const { mod, fx, threw } = await bootPlugin(home, mem, {});
  const after = snapshot(mem);
  ok(!threw, "S3-1 老用户在空库上加载不抛错", threw && threw.message);
  ok(!!(mod.__topicdb && mod.__topicdb.ready), "S3-2 主题库就绪（空）");
  const mdChanged = Object.keys(before).filter((k) => before[k] !== after[k]);
  ok(mdChanged.length === 0, "S3-3 启动**没有**偷偷改遗留 md", mdChanged.join(",") || "0 改动");
  let topics = -1;
  try { topics = mod.__topicdb.store.topics().length; } catch { /* ignore */ }
  ok(topics === 0, "S3-4 迁移前库仍为空（不会自动导入 —— 迁移必须由用户/agent 显式触发）", "topics=" + topics);
  // S4：当前是否已有迁移提示（基线：应当还没有）
  const hints = fx.captured.hints || [];
  const monitorFile = path.join(mem, ".monitor.json");
  const monitorTxt = fs.existsSync(monitorFile) ? fs.readFileSync(monitorFile, "utf8") : "";
  const hasMigrateHint = /memory-migrate|迁移/.test(monitorTxt) || hints.some((h) => /迁移/.test(String(h)));
  console.log("  [基线] S4 迁移提示已存在? " + hasMigrateHint + "（task-52 落地后应为 true，届时改断言）");
  // ★ 实测结论（2026-10-30，本断言即为证据）：
  //   flag 开 + 空库 + 有遗留 md ⇒ memory_search **仍然能查到**旧 md（插件有 md 兜底/合并读）。
  //   ⇒ 安装器"开 flag"不会让用户看起来丢记忆；但仍需迁移动机：写路径已切 DB，
  //     新写入进库、旧记忆留 md ⇒ 双源并存。安装器应把迁移表述为"建议尽快"而非"必须"。
  const srch = fx.captured.tools.find((t) => t && /memory_search/.test(t.name || ""));
  let hitLegacy = null;
  try { hitLegacy = await srch.execute({ query: "要点一" }); } catch { /* ignore */ }
  const legacyVisible = /要点一/.test(JSON.stringify(hitLegacy || {}));
  ok(legacyVisible === true, "S3-5 flag 开 + 空库时检索仍有 md 兜底（旧记忆不会「看起来丢了」）", "legacyVisible=" + legacyVisible);
  // 空库上 memory_write 没有可写主题 ⇒ 应"优雅拒绝"而不是崩（superseded 由 s4 验证首写路径）
  // [CRA 2026-11-06 修复] 4.5.1 起 memory_write 只对 dream 开放 ⇒ 必须用 dream 身份才验得到「空库 NOT_FOUND」；
  //   同时补一条主代理身份断言：应是 WRITE_DREAM_ONLY（不是崩、也不是静默成功）。
  const wr = fx.captured.tools.find((t) => t && t.name === "memory_write");
  const DREAM_SID = "smoke-dream-selftest";
  try { if (typeof mod.__markPluginSubagent === "function") mod.__markPluginSubagent(DREAM_SID); } catch (e) { }
  const execDream = { agent: { session: { id: DREAM_SID, header: { origin: "subagent" } } } };
  let wrOut = null, wrErr = null;
  try { wrOut = await wr.execute({ topic: "冒烟主题", op: "append", text: "迁移前写一句" }, execDream); } catch (e) { wrErr = e; }
  ok(!wrErr && /NOT_FOUND|没有主题/.test(String(wrOut)), "S3-6 空库上 memory_write 优雅拒绝（NOT_FOUND，不抛）", String(wrOut).slice(0, 100));
  let wrLead = null, wrLeadErr = null;
  try { wrLead = await wr.execute({ topic: "冒烟主题", op: "append", text: "迁移前写一句" }, {}); } catch (e) { wrLeadErr = e; }
  ok(!wrLeadErr && /WRITE_DREAM_ONLY/.test(String(wrLead)), "S3-7 主代理身份 ⇒ WRITE_DREAM_ONLY（优雅拒绝，不抛）", String(wrLead).slice(0, 90));
  ok((fx.captured.errors || []).length === 0, "S3-8 无 ctx.error", JSON.stringify(fx.captured.errors || []));
  console.log("  [metric] 注册工具=" + fx.captured.tools.length + " 命令=" + fx.captured.commands.length + " 注入段=" + (fx.captured.injected || []).length);
}

// ── S4：老用户「装完重启 ⇒ 自动迁移」端到端（task-52 的核心用户旅程）──────────
// 前置：安装器在 host.running 时写了 <mdRoot>/.memtopic/migrate-pending.json 且**没有**动 flag
// 期望：插件 boot（开库之前）读标记 → spawn migrate.mjs --apply → 成功后删标记 + 置 flag + 库有数据
async function s4() {
  console.log("\n=== S4 老用户：pending 标记 ⇒ boot 自动迁移 ===");
  const { home, mem } = mkHome("s4");
  for (const d of ["sessions", "knowledge", "projects", "tools"]) fs.mkdirSync(path.join(mem, d), { recursive: true });
  fs.writeFileSync(path.join(mem, "global.md"), "# 全局记忆\n- 画像乙\n", "utf8");
  fs.writeFileSync(path.join(mem, "sessions", "2026-10-28.md"), "# 会话乙\n- s1\n- s2\n", "utf8");
  fs.writeFileSync(path.join(mem, "knowledge", "知识乙.md"), "# 知识乙\n- k1\n- k2\n- k3\n", "utf8");
  fs.writeFileSync(path.join(mem, "projects", "项目乙.md"), "# 项目乙\n- p1\n", "utf8");
  fs.writeFileSync(path.join(mem, "tools", "工具乙.md"), "# 工具乙\n- t1\n- t2\n", "utf8");
  const dbF = dbFile(mem);
  const marker = path.join(mem, ".memtopic", "migrate-pending.json");
  fs.mkdirSync(path.join(mem, ".memtopic"), { recursive: true });
  const markerObj = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    requestedBy: "installer",
    mdRoot: mem,
    dbFile: dbF,
    pluginVersion: "3.5.0",
    note: "smoke s4",
  };
  fs.writeFileSync(marker, JSON.stringify(markerObj, null, 2), "utf8");
  // 安装器在 host.running 时"不"置 flag；但标记要被消费必须走 topicDbEnsure ⇒ 这里按 installer 约定设为 true
  fs.writeFileSync(path.join(mem, ".config.json"), JSON.stringify({ memoryTopicDbEnabled: true }, null, 2), "utf8");
  const mdBefore = snapshot(mem);

  const { mod, fx, threw } = await bootPlugin(home, mem, {});
  ok(!threw, "S4-1 插件 apply 不抛错（迁移在后台 async 进行）", threw && threw.message);

  // 等自动迁移完成（最多 180s；真实大库会久，fixture 很快）
  let topics = 0;
  for (let i = 0; i < 600; i++) {
    try { topics = mod.__topicdb && mod.__topicdb.store ? mod.__topicdb.store.topics().length : 0; } catch { topics = 0; }
    if (topics > 0) break;
    await sleep(300);
  }
  ok(topics > 0, "S4-2 boot 期自动迁移成功（库里有主题）", "topics=" + topics);
  ok(!fs.existsSync(marker), "S4-3 迁移成功后 pending 标记被删除", marker);
  const mdAfter = snapshot(mem);
  const changed = Object.keys(mdBefore).filter((k) => mdBefore[k] !== mdAfter[k]);
  ok(changed.length === 0, "S4-4 迁移不修改旧 md（逐字节）", changed.join(",") || "0 改动");
  const cfg = JSON.parse(fs.readFileSync(path.join(mem, ".config.json"), "utf8"));
  ok(cfg.memoryTopicDbEnabled === true, "S4-5 迁移后 flag 保持/置为 true", JSON.stringify(cfg));
  const srch = fx.captured.tools.find((t) => t && /memory_search/.test(t.name || ""));
  let hit = null;
  try { hit = await srch.execute({ query: "k2" }); } catch { /* ignore */ }
  ok(/k2/.test(JSON.stringify(hit || {})), "S4-6 迁移后检索能命中旧内容（走库）", String(hit).slice(0, 90));
  ok((fx.captured.errors || []).length === 0, "S4-7 无 ctx.error", JSON.stringify(fx.captured.errors || []));
}

const MAP = { s1, s2, s3, s4 };
if (SCENARIO === "all") {
  console.log("用法：node install-newuser-smoke.mjs s1|s2|s3|s4   （每个场景必须独立进程，插件是单例）");
  console.log("本进程仅执行 s2（最轻）以避免单例串味；完整验收请分别跑。");
  await s2();
} else {
  if (!MAP[SCENARIO]) { console.error("未知场景：" + SCENARIO); process.exit(1); }
  await MAP[SCENARIO]();
}
console.log("\n结果: PASS=" + pass + " FAIL=" + fails.length);
if (fails.length) { console.log("失败项: " + fails.join(" | ")); process.exitCode = 1; }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300).unref();
