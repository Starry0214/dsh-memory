// migrate-notice-check.mjs —— task-52 断言 N01–N14（插件运行时：迁移提醒 / memory-migrate / boot 期 pending 迁移）
//
// 运行：node dsh-memory-plugin/_verify/migrate-notice-check.mjs
// 纪律：全部临时目录 + 假 MEMORY_ROOT；**绝不触碰真实 ~/.dsh/memory**（每个场景独立 DSH_HOME 临时目录）；
//      插件是 ESM 单例 ⇒ 每个场景用不同 query 重新 import（env 在 import 前设置）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = "E:/工具/插件开发调整";
const PLUGIN = ROOT + "/dsh-memory-plugin/index.js";
const FIXTURE = ROOT + "/dsh-memory-plugin/_fixture-ctx.mjs";
const MEMTOPIC = ROOT + "/memtopic";
const MIGRATE = MEMTOPIC + "/src/migrate.mjs";

// N03 基线：task-52 改动前（index.js sha16 873A3DB49D6CA6E4）用相同 fixture 实测的"flag 关注入正文"
const BASELINE = { count: 3, bytes: 3106, sha256: "885a06475432f91e74903fd4666f9dff58b4c6d4dff21f984696e7851cf31f23" };;

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  —  " + String(detail).slice(0, 260) : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + String(detail).slice(0, 400) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => createHash("sha256").update(t).digest("hex");
const portable = (p) => String(p).replace(/\\/g, "/");
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

function mkMem(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-notice-" + tag + "-"));
  const home = path.join(tmp, "dsh-home");
  const mem = path.join(home, "memory");
  fs.mkdirSync(mem, { recursive: true });
  return { tmp, home, mem };
}
function writeMd(mem, rel, text) {
  const f = path.join(mem, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
}
function setCfg(mem, cfg) { fs.writeFileSync(path.join(mem, ".config.json"), JSON.stringify(cfg, null, 2), "utf8"); }

async function boot(envObj, cfg, query) {
  process.env.DSH_HOME = envObj.home;
  process.env.DSH_MEMORY_ROOT = envObj.mem;
  delete process.env.MEMTOPIC_DIR;
  delete process.env.MEMTOPIC_DB;
  const mod = await import(pathToFileURL(PLUGIN).href + "?" + query + "=" + Date.now());
  const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);
  const fx = createFixtureCtx();
  let threw = null;
  try { mod.default.apply(fx.ctx, cfg || {}); } catch (e) { threw = e; }
  return { mod, fx, threw };
}
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await fn()) return true; } catch { /* ignore */ } await sleep(120); }
  return false;
}
function captureAgent() {
  const raw = [];
  const agent = {
    session: { id: "session-migrate-" + Math.random().toString(16).slice(2, 10), header: { origin: "user", cwd: "E:/work/demo" } },
    inject(msg) { raw.push(msg); },
  };
  const texts = () => raw.map((m) => {
    if (typeof m === "string") return m;
    try {
      const o = typeof m === "object" ? m : JSON.parse(String(m));
      const cs = Array.isArray(o && o.content) ? o.content : [];
      return cs.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
    } catch { return String(m); }
  });
  return { agent, raw, texts };
}
function pendingPath(mem) { return path.join(mem, ".memtopic", "migrate-pending.json"); }
function writePending(mem, over) {
  const dir = path.join(mem, ".memtopic");
  fs.mkdirSync(dir, { recursive: true });
  const p = Object.assign({
    schemaVersion: 1, at: new Date().toISOString(), requestedBy: "installer",
    mdRoot: portable(mem), dbFile: portable(path.join(mem, ".memtopic", "mem.db")), pluginVersion: "3.4.8",
  }, over || {});
  fs.writeFileSync(pendingPath(mem), JSON.stringify(p, null, 2), "utf8");
  return p;
}
async function dbStatsOf(dbFile) {
  const backend = await import(pathToFileURL(MEMTOPIC + "/src/backend-sqlite.mjs").href);
  const storeMod = await import(pathToFileURL(MEMTOPIC + "/src/memory-store.mjs").href);
  const be = new backend.SqliteBackend(dbFile);
  const store = new storeMod.MemoryStore(be);
  try {
    const topics = store.be.listTopics();
    let sentences = 0;
    for (const t of topics) for (const row of (store.be.listSentences(t.id) || [])) { void row; sentences++; }
    return { topics: topics.length, sentences, verifyOk: !!store.verify().ok };
  } finally { try { be.close(); } catch { /* noop */ } }
}
function runScript(name) {
  const file = path.join(ROOT, "dsh-memory-plugin", "_verify", name);
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 240000 });
  const out = String(r.stdout || "") + String(r.stderr || "");
  let passN = -1; let totalN = -1;
  const m1 = out.match(/全部通过\s*(\d+)\s*\/\s*(\d+)/);
  if (m1) { passN = Number(m1[1]); totalN = Number(m1[2]); }
  if (passN < 0) { const m2 = out.match(/(\d+)\s*\/\s*(\d+)\s*通过/); if (m2) { passN = Number(m2[1]); totalN = Number(m2[2]); } }
  if (passN < 0) { const m3 = out.match(/(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/); if (m3) { passN = Number(m3[1]); totalN = Number(m3[1]) + Number(m3[2]); } }
  return { code: r.status, pass: passN, total: totalN, tail: out.trim().split(/\r?\n/).slice(-2).join(" | ") };
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  // ── S1：N01/N02/N04/N05/N06/N09（flag 开 + 空库 + 遗留 md）────────────────
  console.log("\n=== S1 flag 开 + 空库 + 遗留 md：提醒/节流/版本/清状态/文案长度 ===");
  {
    const e = mkMem("s1");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话甲\n- 遗留句一\n- 遗留句二\n");
    writeMd(e.mem, "knowledge/知识甲.md", "# 知识甲\n- 知识句一\n");
    writeMd(e.mem, "projects/项目甲.md", "# 项目甲\n- 项目句一\n");
    writeMd(e.mem, "tools/工具甲.md", "# 工具甲\n- 工具句一\n");
    writeMd(e.mem, "global.md", "# 全局记忆\n- 画像句\n");
    writeMd(e.mem, "index.md", "# 记忆索引\n- 索引句\n");
    setCfg(e.mem, { memoryTopicDbEnabled: true });
    const { mod, fx, threw } = await boot(e, { memoryTopicDbEnabled: true }, "s1");
    ok(!threw, "N01-pre 插件加载不抛错", threw && threw.message);
    await waitFor(() => mod.__topicdb && mod.__topicdb.ready, 20000, "ready");
    const a1 = captureAgent();
    const injected1 = mod.__maybeInjectMigrateNotice(a1.agent, "n01");
    let texts1 = a1.texts();
    ok(injected1 === true && texts1.length === 1, "N01 flag 开 + 库空 + 有旧 md ⇒ 注入一次性迁移提醒",
      "injected=" + injected1 + " count=" + texts1.length);
    ok(texts1.length > 0 && /记忆库升级待办/.test(texts1[0]), "N01 文案含醒目抬头「记忆库升级待办」", texts1[0] && texts1[0].slice(0, 60));
    ok(/\/memory-migrate\s+--apply/.test(texts1[0] || ""), "N01 文案含登记命令 /memory-migrate --apply");
    ok(/migrate\.mjs"?\s+--apply\s+--yes/.test(texts1[0] || ""), "N01 文案含手工命令 migrate.mjs --apply --yes");
    ok(/重启\s*DSH/.test(texts1[0] || ""), "N01 文案含「重启 DSH 生效」");
    const bytes1 = Buffer.byteLength(texts1[0] || "", "utf8");
    ok(bytes1 <= 600, "N09 注入文案 ≤600 字符", "bytes=" + bytes1 + "（上限 600）");

    const a2 = captureAgent();
    const injected2 = mod.__maybeInjectMigrateNotice(a2.agent, "n04");
    ok(injected2 === false && a2.texts().length === 0, "N04 同插件版本第二次 ⇒ 节流不注入（每版本一次）", "injected=" + injected2);

    const obFile = path.join(e.mem, ".onboard.json");
    const ob = readJson(obFile) || {};
    ob.migrateNotice = { version: "0.0.0-older", at: 0, pendingAt: 0, state: "notice" };
    fs.writeFileSync(obFile, JSON.stringify(ob, null, 2), "utf8");
    const a3 = captureAgent();
    const injected3 = mod.__maybeInjectMigrateNotice(a3.agent, "n05");
    ok(injected3 === true && a3.texts().length === 1, "N05 版本升级后再生成（节流按 version 判定）", "injected=" + injected3);

    // 真实迁移（小样本）→ 库非空 ⇒ 清状态 + 不再提醒
    const mig = spawnSync(process.execPath, [MIGRATE, "--apply", "--yes", "--assume-host-stopped", "--dsh-home", e.home, "--md-root", e.mem, "--db", path.join(e.mem, ".memtopic", "mem.db"), "--no-process-scan"], { cwd: ROOT, encoding: "utf8", timeout: 180000 });
    const dbAfter = exists(path.join(e.mem, ".memtopic", "mem.db")) ? await dbStatsOf(path.join(e.mem, ".memtopic", "mem.db")) : { topics: 0, sentences: 0 };
    ok(mig.status === 0 && dbAfter.topics > 0, "N06-pre 真实迁移成功（样本库有主题）", "exit=" + mig.status + " topics=" + dbAfter.topics + " sentences=" + dbAfter.sentences);
    try { mod.__topicdbSync(false); mod.__topicdbSync(true); } catch { /* noop */ }
    await waitFor(() => mod.__topicdb && mod.__topicdb.ready, 20000, "reopen");
    const ob2 = readJson(obFile) || {};
    ob2.migrateNotice = { version: "3.4.8", at: 1, pendingAt: 0, state: "notice" };
    fs.writeFileSync(obFile, JSON.stringify(ob2, null, 2), "utf8");
    const a4 = captureAgent();
    const injected4 = mod.__maybeInjectMigrateNotice(a4.agent, "n06");
    const ob3 = readJson(obFile) || {};
    ok(injected4 === false && a4.texts().length === 0, "N06 库非空 ⇒ 不再提醒（不生成）", "injected=" + injected4);
    ok(!ob3.migrateNotice || !ob3.migrateNotice.version || ob3.migrateNotice.version === "" || ob3.migrateNotice.state === "",
      "N06 库非空 ⇒ 清理 migrateNotice 状态", JSON.stringify(ob3.migrateNotice));
    ok((fx.captured.errors || []).length === 0, "N01 无 ctx.error", JSON.stringify(fx.captured.errors));
  }

  // ── S2：N03 flag 关零注入（与改动前基线逐字节等价）─────────────────────────
  console.log("\n=== S2 flag 关：与 task-52 改动前注入正文逐字节等价（N03） ===");
  {
    const e = mkMem("s2");
    writeMd(e.mem, "global.md", "# 全局\n- 画像句\n");
    writeMd(e.mem, "index.md", "# 索引\n- 索引句\n");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话\n- 遗留句一\n- 遗留句二\n");
    const { mod, fx, threw } = await boot(e, { memoryTopicDbEnabled: false }, "s2");
    ok(!threw, "N03-pre 插件加载不抛错", threw && threw.message);
    const h = (fx.captured.handlers || []).find((x) => x.event === "agent/created");
    ok(!!h, "N03-pre agent/created 已注册");
    const a = captureAgent();
    h.fn({ agent: a.agent, source: "startup" });
    await sleep(2500);
    // [Lead 2026-10-31] 追加日期归一化：注入正文含"今日"日期，跨天跑会漂（实测 10-30 基线在 10-31 少 7 字节）
 const norm = (t) => String(t).split(portable(e.mem)).join("<MEM>").split(portable(e.home)).join("<HOME>").split(portable(e.tmp)).join("<TMP>").replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
    const texts = a.texts().map(norm);
    const joined = texts.join("\n\u0000\n");
    const got = { count: texts.length, bytes: Buffer.byteLength(joined, "utf8"), sha256: sha(joined) };
    ok(got.count === BASELINE.count && got.bytes === BASELINE.bytes && got.sha256 === BASELINE.sha256,
      "N03 flag 关：注入正文与改动前基线**逐字节等价**",
      "got=" + JSON.stringify(got) + " baseline=" + JSON.stringify(BASELINE));
    ok(!texts.some((t) => /记忆库升级待办|memory-migrate/.test(t)), "N03 flag 关：不含任何迁移提醒字样");
  }

  // ── S3：N07（无参只读）/ N11（--apply 只写标记+置 flag）/ N08（memtopic 缺失）──
  console.log("\n=== S3 /memory-migrate：无参只读、--apply 只登记、memtopic 缺失降级 ===");
  {
    const e = mkMem("s3");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话乙\n- 句一\n- 句二\n");
    writeMd(e.mem, "knowledge/知识乙.md", "# 知识乙\n- 知识句\n");
    const { mod, fx, threw } = await boot(e, {}, "s3");
    ok(!threw, "N07-pre 插件加载（flag 关）不抛错", threw && threw.message);
    const cmd = (fx.captured.commands || []).find((c) => c && c.name === "memory-migrate");
    ok(!!cmd, "N07-pre /memory-migrate 命令已注册", JSON.stringify((fx.captured.commands || []).map((c) => c.name)));
    const dbFile = path.join(e.mem, ".memtopic", "mem.db");
    let r1 = null; let e1 = null;
    try { r1 = await cmd.handler({ rawInput: "", agent: { session: { id: "cmd-detect" } } }); } catch (x) { e1 = x; }
    ok(!e1, "N07 无参调用不抛错", e1 && e1.message);
    ok(r1 && /记忆库迁移检测|旧版 md/.test(String(r1.text)), "N07 无参返回只读检测报告（转述 migrate.mjs --detect）", r1 && r1.text.slice(0, 120));
    ok(!exists(pendingPath(e.mem)), "N07 无参**不写** pending 标记");
    ok(!exists(dbFile), "N07 无参**不建库**（只读）", "db exists=" + exists(dbFile));

    let r2 = null; let e2 = null;
    try { r2 = await cmd.handler({ rawInput: "--apply", agent: { session: { id: "cmd-apply" } } }); } catch (x) { e2 = x; }
    ok(!e2, "N11 --apply 调用不抛错", e2 && e2.message);
    ok(r2 && /已登记/.test(String(r2.text)) && /下次启动/.test(String(r2.text)), "N11 --apply 回执「已登记：下次启动 DSH 自动迁移」", r2 && r2.text.slice(0, 120));
    const pend = readJson(pendingPath(e.mem));
    ok(!!pend, "N11 --apply 写出 migrate-pending.json", pendingPath(e.mem));
    ok(!!pend && pend.schemaVersion === 1 && pend.requestedBy === "command" && typeof pend.at === "string" &&
      !Number.isNaN(Date.parse(pend.at)) && portable(pend.mdRoot) === portable(e.mem) && path.isAbsolute(String(pend.dbFile)) && typeof pend.pluginVersion === "string",
      "N11 pending 契约字段完整（schemaVersion/at/requestedBy/mdRoot/dbFile/pluginVersion）", JSON.stringify(pend));
    const cfg = readJson(path.join(e.mem, ".config.json")) || {};
    ok(cfg.memoryTopicDbEnabled === true, "N11 --apply 同时把 memoryTopicDbEnabled 置 true（否则下次 boot 不消费）", JSON.stringify(cfg));
    ok(!exists(dbFile), "N11 --apply **不执行迁移**（不建库）", "db exists=" + exists(dbFile));

    // N08：模拟 memtopic 缺失 ⇒ 只回退文本，不抛
    mod.__migrateTestHooks.findScript = () => null;
    let r3 = null; let e3 = null;
    try { r3 = await cmd.handler({ rawInput: "", agent: { session: { id: "cmd-missing" } } }); } catch (x) { e3 = x; }
    ok(!e3, "N08 memtopic 缺失：命令不抛错", e3 && e3.message);
    ok(r3 && String(r3.kind) === "error" && /未找到|migrate\.mjs/.test(String(r3.text)), "N08 命令退回「手工命令」文案", r3 && r3.text.slice(0, 140));
    mod.__topicdb.enabled = true;
    const consumer = await mod.__migrateConsumePending();
    ok(consumer && consumer.ran === false && consumer.reason === "no-script" && exists(pendingPath(e.mem)),
      "N08 boot 消费者遇 memtopic 缺失：返回 no-script、标记保留、不抛", JSON.stringify(consumer));
    mod.__migrateTestHooks.findScript = null;
  }

  // ── S4：N12 boot 见标记 ⇒ 子进程迁移成功 ⇒ 删标记 + clog 摘要 + 库有数据 ─────────
  console.log("\n=== S4 boot 期消费 pending（成功路径，N12）===");
  {
    const e = mkMem("s4");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话丙\n- 句一\n- 句二\n");
    writeMd(e.mem, "knowledge/知识丙.md", "# 知识丙\n- 知识句\n");
    writeMd(e.mem, "projects/项目丙.md", "# 项目丙\n- 项目句\n");
    setCfg(e.mem, { memoryTopicDbEnabled: true });
    writePending(e.mem, { requestedBy: "installer", note: "installer -Migrate" });
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.map(String).join(" ")); origLog(...a); };
    let bootRes = null;
    try {
      bootRes = await boot(e, { memoryTopicDbEnabled: true }, "s4");
      ok(!bootRes.threw, "N12-pre 插件加载不抛错", bootRes.threw && bootRes.threw.message);
    } finally { /* 日志捕获延长到 wait 之后 */ }
    const done = await waitFor(() => !exists(pendingPath(e.mem)), 60000, "pending consumed");
    await sleep(600);
    console.log = origLog;
    ok(done, "N12 boot 检测到 pending ⇒ 自动消费后删除标记", "pending exists=" + exists(pendingPath(e.mem)));
    const ready = await waitFor(() => bootRes.mod.__topicdb && bootRes.mod.__topicdb.ready, 30000, "ready");
    ok(ready, "N12 迁移后主题库就绪（打开的是迁移后的库）");
    const dbFile = path.join(e.mem, ".memtopic", "mem.db");
    const db = exists(dbFile) ? await dbStatsOf(dbFile) : { topics: 0, sentences: 0 };
    ok(db.topics > 0 && db.sentences > 0 && db.verifyOk, "N12 库已有数据（主题/句 >0，verify OK）", "topics=" + db.topics + " sentences=" + db.sentences);
    const ob = readJson(path.join(e.mem, ".onboard.json")) || {};
    ok(ob.migrateNotice && ob.migrateNotice.state === "done", "N12 成功后 onboard.migrateNotice.state=done", JSON.stringify(ob.migrateNotice));
    const logHit = logs.find((l) => /\[migrate\]\s*pending 迁移完成/.test(l));
    ok(!!logHit && /主题 \d+/.test(logHit) && /句 \d+/.test(logHit) && /耗时 \d+ms/.test(logHit),
      "N12 clog 一行摘要含 主题/句/耗时", logHit || logs.filter((l) => /migrate/.test(l)).slice(-2).join(" | "));
    const cfg = readJson(path.join(e.mem, ".config.json")) || {};
    ok(cfg.memoryTopicDbEnabled === true, "N12 成功后确保 memoryTopicDbEnabled=true", JSON.stringify(cfg));
  }

  // ── S5：N13 迁移失败 ⇒ 标记保留 + 不抛 + 仍可服务 ─────────────────────────
  console.log("\n=== S5 boot 期消费 pending（失败路径，N13）===");
  {
    const e = mkMem("s5");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话丁\n- 句一\n");
    setCfg(e.mem, { memoryTopicDbEnabled: true });
    writePending(e.mem, { dbFile: portable(e.mem), requestedBy: "installer" });   // dbFile 指向目录 ⇒ migrate 阶段真失败
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.map(String).join(" ")); origLog(...a); };
    let br = null;
    try { br = await boot(e, { memoryTopicDbEnabled: true }, "s5"); } finally { /* 捕获延长 */ }
    ok(!br.threw, "N13 迁移失败不向插件加载抛错", br.threw && br.threw.message);
    await waitFor(() => /pending 迁移失败/.test(logs.join("\n")), 60000, "fail log");
    await sleep(600);
    console.log = origLog;
    ok(exists(pendingPath(e.mem)), "N13 失败 ⇒ pending 标记**保留**（下次再试）", "exists=" + exists(pendingPath(e.mem)));
    ok(logs.some((l) => /pending 迁移失败/.test(l)) && logs.some((l) => /标记保留/.test(l)),
      "N13 失败 ⇒ clog 原因并说明保留标记/继续 md", logs.filter((l) => /migrate/.test(l)).slice(-2).join(" | "));
    ok(br.mod.__topicdb && br.mod.__topicdb.ready === true, "N13 失败后仍回退 md 模式并继续服务（topicdb 就绪/或 md 路径可用）", "ready=" + (br.mod.__topicdb && br.mod.__topicdb.ready));
    ok((br.fx.captured.tools || []).length >= 4 || (br.fx.captured.errors || []).length === 0, "N13 失败后工具/服务仍可用（无 ctx.error）", JSON.stringify(br.fx.captured.errors));
  }

  // ── S6：N14 无标记零额外开销 + 不在 boot 窗口不消费 ────────────────────────
  console.log("\n=== S6 无标记零开销 / 非 boot 窗口不消费（N14）===");
  {
    const e = mkMem("s6");
    writeMd(e.mem, "sessions/2026-10-30.md", "# 会话戊\n- 句一\n");
    const { mod } = await boot(e, {}, "s6");
    mod.__topicdb.enabled = true;
    const t0 = Date.now();
    const r1 = await mod.__migrateConsumePending();
    const ms = Date.now() - t0;
    ok(r1 && r1.ran === false && r1.reason === "absent", "N14 无标记 ⇒ 直接返回 absent（不执行任何迁移）", JSON.stringify(r1));
    ok(ms < 300, "N14 无标记路径零额外开销（<300ms）", "ms=" + ms);
    writePending(e.mem, { requestedBy: "command" });
    const r2 = await mod.__migrateConsumePending({ nowMs: Date.now() + 3600000 });
    ok(r2 && r2.ran === false && r2.reason === "outside-boot-window" && exists(pendingPath(e.mem)),
      "N14 标记存在但不在 boot 窗口（启动 1h 后）⇒ 不消费、标记保留", JSON.stringify(r2));
  }

  // ── N10：既有断言基线（panel 143 / graph 77 / sink 28 / dreampatch 28 / p6 38）──
  //     [Lead 2026-10-30] panel 141→143：修正"隐藏过头"（只隐藏 .tdb-mdonly，A/B/C/D 与日志恢复），
  //     并新增 P18b（不得再出现 #app/#logwrap display:none）与 P18d（md 卡必须带 .tdb-mdonly）两条断言。
  console.log("\n=== N10 既有断言基线（只跑不改）===");
  {
    const specs = [
      ["N10 panel 143", "topicdb-panel-check.mjs", 143],
      ["N10 graph 77", "topicdb-graph-check.mjs", 77],
      ["N10 sink 42", "topicdb-sink-check.mjs", 42],
      ["N10 dreampatch 28", "topicdb-dreampatch-check.mjs", 28],
      ["N10 p6 38", "topicdb-p6-check.mjs", 38],
    ];
    for (const [name, file, expect] of specs) {
      const r = runScript(file);
      ok(r.code === 0 && r.pass === expect && r.total === expect, name, "exit=" + r.code + " " + r.pass + "/" + r.total + " | " + r.tail);
    }
  }

  console.log("\n结果: PASS=" + pass + " FAIL=" + fails.length);
  if (fails.length) console.log("失败项: " + fails.join(" | "));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("检查器崩溃：", (e && e.stack) || e); process.exit(2); });
