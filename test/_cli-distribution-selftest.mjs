// _cli-distribution-selftest.mjs —— session-search CLI 随插件分发（发布阻塞修复）自测
//
// 跑法：node test/_cli-distribution-selftest.mjs
//
// 覆盖（Lead 四件事 + 必测四项）：
//   A ① payload 清单含 CLI（21 文件 / manifest version / sha 与 repo 一致 / --check 通过）
//   B ④ 查找顺序内置优先（纯函数 resolveSessionSearchCli：内置 > 用户本地 > 记忆库；探测失败跳过；全缺 missing）
//   C ③ 安装器不覆盖更新版本（目标 v9.9.9 保留 + 提示）；② 新装把 CLI 落到 DSH_HOME/tools/session-search/
//   D rg 缺失降级不崩（--list 可用；检索 exit=3 明确报错；插件工具 list 正常、query 优雅报错）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const REPO_CLI = path.join(PLUGIN, "tools", "session-search.mjs");
const MANIFEST = path.join(PLUGIN, "install-manifest.json");
const ZIP = path.join(PLUGIN, "payload", "dsh-memory-4.5.3.zip");
const INSTALL_PS1 = path.join(PLUGIN, "install.ps1");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-clidist-"));
// 插件模块级 DSH_HOME/MEMORY_ROOT 在 import 时求值 ⇒ 必须先造好测试 home 再 import（D 段用）
const HOME_D = path.join(TMP, "home-d");
{
  const mem = path.join(HOME_D, "memory");
  fs.mkdirSync(path.join(mem, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mem, "global.md"), "# g\n");
  fs.writeFileSync(path.join(mem, "index.md"), "# i\n");
  fs.writeFileSync(path.join(mem, ".monitor.json"), "{}");
  const sdir = path.join(HOME_D, "sessions", "ws", "session-aaaaaaaa-1111");
  fs.mkdirSync(sdir, { recursive: true });
  const log = path.join(sdir, "session.v4.jsonl.zstd");
  fs.writeFileSync(log, "x");
  const t1106 = new Date("2026-11-06T12:00:00+08:00").getTime() / 1000;
  fs.utimesSync(log, t1106, t1106);
  fs.utimesSync(sdir, t1106, t1106);
  const cdir = path.join(HOME_D, "session-text", "2026-11-06", "aaaaaaaa");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, "seg-0001.jsonl"), JSON.stringify({ k: "user/message", fr: 1, x: "任务" }) + "\n" + JSON.stringify({ k: "assistant/message", fr: 2, x: "结论" }) + "\n");
  fs.writeFileSync(path.join(cdir, "manifest.json"), JSON.stringify({ ver: 1, sid: "aaaaaaaa", files: { "session.v4.jsonl.zstd": { size: 100, frames: 2 } }, segs: ["seg-0001.jsonl"], chars: 10 }));
  process.env.DSH_HOME = HOME_D;
  process.env.DSH_MEMORY_ROOT = mem;
  process.env.MEMTOPIC_DB = path.join(mem, ".memtopic", "mem.db");
  delete process.env.MEMTOPIC_DIR;
}
const cliVersionOf = (p) => { try { const m = /const CLI_VERSION = "([^"]+)"/.exec(fs.readFileSync(p, "utf8")); return m ? m[1] : ""; } catch (e) { return ""; } };
const writeCli = (p, ver, valid) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = valid === false
    ? "const CLI_VERSION = \"" + ver + "\";\nfunction broken( { // 故意语法错\n"
    : "#!/usr/bin/env node\nconst CLI_VERSION = \"" + ver + "\";\nconsole.log(\"session-search \" + CLI_VERSION);\n";
  fs.writeFileSync(p, body, "utf8");
  return p;
};

// ── A. payload 清单含 CLI ─────────────────────────────────────────────
try {
  ok(fs.existsSync(REPO_CLI), "A1 repo 内置副本存在：tools/session-search.mjs", (fs.statSync(REPO_CLI).size) + "B");
  ok(cliVersionOf(REPO_CLI) === "5.0.0", "A2 内置副本带 CLI_VERSION=5.0.0（安装器/插件据此比较）", cliVersionOf(REPO_CLI));
  execFileSync(process.execPath, ["--check", REPO_CLI], { stdio: "ignore" });
  ok(true, "A3 内置副本 node --check 通过");
  const listOut = execFileSync(process.execPath, [path.join(PLUGIN, "tools", "sync-payload.mjs"), "--list"], { encoding: "utf8" });
  ok(/tools\/session-search\.mjs/.test(listOut) && /---- 21 files/.test(listOut), "A4 payload 清单含 CLI 且 20 → 21 文件", (listOut.match(/---- .* files/) || [""])[0]);
  const man = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const cliEntry = (man.files || []).find((f) => f.path === "tools/session-search.mjs");
  ok(!!cliEntry && cliEntry.bytes === fs.statSync(REPO_CLI).size && cliEntry.version === "5.0.0", "A5 manifest 含 CLI 条目（bytes/version 正确）", JSON.stringify(cliEntry));
  const crypto = await import("node:crypto");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(REPO_CLI)).digest("hex");
  ok(cliEntry && cliEntry.sha256 === sha, "A6 manifest CLI sha256 与 repo 副本一致");
  const chk = spawnSync(process.execPath, [path.join(PLUGIN, "tools", "sync-payload.mjs"), "--check"], { encoding: "utf8" });
  ok(chk.status === 0 && /CHECK OK/.test(chk.stdout), "A7 sync-payload --check 通过", (chk.stdout.match(/CHECK OK[^\n]*/) || [""])[0]);
} catch (e) { ok(false, "A payload 场景异常", (e && e.message) || String(e)); }

// ── B. 查找顺序内置优先（纯函数）─────────────────────────────────────
try {
  const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
  const resolve = mod.__resolveSessionSearchCli;
  ok(typeof resolve === "function", "B0 前置：__resolveSessionSearchCli 可导入");
  const mk = (tag) => { const d = path.join(TMP, tag); fs.mkdirSync(d, { recursive: true }); return d; };
  const pluginA = mk("p-builtin"), dshA = mk("h-builtin"), memA = mk("m-builtin");
  writeCli(path.join(pluginA, "tools", "session-search.mjs"), "5.0.0");
  writeCli(path.join(dshA, "tools", "session-search", "session-search.mjs"), "9.9.9");
  const r1 = resolve({ pluginDir: pluginA, dshHome: dshA, memoryRoot: memA });
  ok(r1.where === "内置" && r1.version === "5.0.0", "B1 内置优先（即使用户本地版本更高 9.9.9 也优先内置）", JSON.stringify(r1));
  const pluginB = mk("p-nobuiltin"), dshB = mk("h-local"), memB = mk("m-local");
  writeCli(path.join(dshB, "tools", "session-search", "session-search.mjs"), "4.0.0");
  const r2 = resolve({ pluginDir: pluginB, dshHome: dshB, memoryRoot: memB });
  ok(r2.where === "用户本地" && r2.version === "4.0.0", "B2 内置缺失 ⇒ 回落用户本地（向后兼容）", JSON.stringify(r2));
  const pluginC = mk("p-none"), dshC = mk("h-none"), memC = mk("m-mem");
  writeCli(path.join(memC, "tools", "session-search", "session-search.mjs"), "3.0.0");
  const r3 = resolve({ pluginDir: pluginC, dshHome: dshC, memoryRoot: memC });
  ok(r3.where === "记忆库" && r3.version === "3.0.0", "B3 再回落记忆库 tools/", JSON.stringify(r3));
  const pluginD = mk("p-broken"), dshD = mk("h-broken");
  writeCli(path.join(pluginD, "tools", "session-search.mjs"), "5.0.0", false);   // 语法坏 ⇒ 探测失败应跳过
  writeCli(path.join(dshD, "tools", "session-search", "session-search.mjs"), "4.0.0");
  const r4 = resolve({ pluginDir: pluginD, dshHome: dshD, memoryRoot: mk("m-broken") });
  ok(r4.where === "用户本地", "B4 内置副本损坏（node --check 失败）⇒ 跳过并回落可用副本", JSON.stringify(r4));
  const r5 = resolve({ pluginDir: mk("p-empty"), dshHome: mk("h-empty"), memoryRoot: mk("m-empty") });
  ok(r5.where === "missing" && /tools[\/\\]session-search/.test(r5.path), "B5 三处全缺 ⇒ where=missing（path 指向期望位置供报错）", JSON.stringify(r5));
} catch (e) { ok(false, "B resolver 场景异常", (e && e.message) || String(e)); }

// ── C. 安装器：不覆盖更新版本 + 新装落地 ──────────────────────────────
function runInstaller(home, extra) {
  const r = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1, "-LocalPayload", ZIP, "-ProfileName", "web", "-SkipPrompt"].concat(extra || []), {
    encoding: "utf8", timeout: 180000, env: Object.assign({}, process.env, { DSH_HOME: home }),
  });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}
try {
  if (!fs.existsSync(ZIP)) { ok(false, "C0 前置：payload zip 存在（先跑 sync-payload）", ZIP); }
  else {
    // C1 目标已有更新版本 ⇒ 保留
    const homeKeep = path.join(TMP, "home-keep");
    fs.mkdirSync(path.join(homeKeep, "profiles", "web"), { recursive: true });
    const keepTarget = path.join(homeKeep, "tools", "session-search", "session-search.mjs");
    writeCli(keepTarget, "9.9.9");
    fs.appendFileSync(keepTarget, "// KEEP-SENTINEL\n", "utf8");
    const keepBefore = fs.readFileSync(keepTarget, "utf8");
    const rk = runInstaller(homeKeep, []);
    ok(rk.code === 0, "C1a 已有更新版本时安装器 exit 0", "exit=" + rk.code);
    ok(fs.readFileSync(keepTarget, "utf8") === keepBefore && /9\.9\.9/.test(fs.readFileSync(keepTarget, "utf8")), "C1b 目标 v9.9.9 未被覆盖（保留更新版本）");
    ok(/保留更新版本/.test(rk.out), "C1c 安装器输出明确提示「保留更新版本」", (rk.out.match(/[^\n]*保留更新版本[^\n]*/) || [""])[0].slice(0, 120));
    // C2 全新 home ⇒ CLI 装到 DSH_HOME/tools/session-search/ 且 sha 与 manifest 一致
    const homeFresh = path.join(TMP, "home-fresh");
    fs.mkdirSync(path.join(homeFresh, "profiles", "web"), { recursive: true });
    const rf = runInstaller(homeFresh, []);
    ok(rf.code === 0, "C2a 新装 exit 0", "exit=" + rf.code);
    const freshCli = path.join(homeFresh, "tools", "session-search", "session-search.mjs");
    ok(fs.existsSync(freshCli), "C2b CLI 落到 DSH_HOME/tools/session-search/session-search.mjs");
    const man = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const entry = (man.files || []).find((f) => f.path === "tools/session-search.mjs");
    const crypto2 = await import("node:crypto");
    const freshSha = fs.existsSync(freshCli) ? crypto2.createHash("sha256").update(fs.readFileSync(freshCli)).digest("hex") : "";
    ok(!!entry && freshSha === entry.sha256 && cliVersionOf(freshCli) === "5.0.0", "C2c 新装 CLI sha256 与 manifest 一致且 v5.0.0", cliVersionOf(freshCli));
    ok(/session-search CLI/.test(rf.out), "C2d 安装器输出报 session-search CLI 就位行");
    // C3 CheckOnly 显式检查项
    const rc = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1, "-CheckOnly", "-LocalPayload", ZIP, "-ProfileName", "web"], { encoding: "utf8", timeout: 180000, env: Object.assign({}, process.env, { DSH_HOME: homeFresh }) });
    const cout = String(rc.stdout || "") + String(rc.stderr || "");
    ok(/\[2b\/11\] session-search CLI/.test(cout) && /sha256 与 manifest 一致/.test(cout), "C3 CheckOnly 含 CLI 存在性 + sha 校验项", (cout.match(/\[2b\/11\][^\n]*/) || [""])[0]);
  }
} catch (e) { ok(false, "C 安装器场景异常", (e && e.message) || String(e)); }

// ── D. rg 缺失降级不崩 ───────────────────────────────────────────────
try {
  // 复用顶部已造好的最小 DSH_HOME（1 个会话 + 缓存；mtime 归 2026-11-06）
  const H = HOME_D;
  // （fixture 已在顶部创建）
  const envNoRg = Object.assign({}, process.env, { DSH_SESSION_SEARCH_RG: "none" });
  const lr = spawnSync(process.execPath, [REPO_CLI, "--ds-home", H, "--list", "--since", "2026-11-06", "--until", "2026-11-06", "--json"], { encoding: "utf8", env: envNoRg });
  ok(lr.status === 0 && JSON.parse(lr.stdout).ok === true && JSON.parse(lr.stdout).total === 1, "D1 rg 缺失时 --list 仍可用（不依赖 rg）", "exit=" + lr.status);
  const sr = spawnSync(process.execPath, [REPO_CLI, "--ds-home", H, "NEEDLE_X"], { encoding: "utf8", env: envNoRg });
  ok(sr.status === 3 && /找不到 ripgrep/.test(String(sr.stderr)), "D2 rg 缺失时检索 exit=3 且明确提示（不崩）", "exit=" + sr.status + " " + String(sr.stderr).trim().slice(0, 60));
  // 插件工具：list 正常；query 优雅报错（不抛异常）
  const prevEnv = process.env.DSH_SESSION_SEARCH_RG;
  process.env.DSH_SESSION_SEARCH_RG = "none";
  try {
    const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
    const { createFixtureCtx, findTool } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
    // env 已在顶部设置（模块常量在 import 时求值）
    const fx = createFixtureCtx({});
    mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
    const tool = findTool(fx.captured, "session_search");
    const listTxt = String(await tool.execute({ list: true, since: "2026-11-06", until: "2026-11-06" }, {}));
    ok(/会话列表（按活动时间倒序）/.test(listTxt), "D3 rg 缺失时插件工具 list 正常返回", listTxt.split("\n")[0].slice(0, 60));
    const qTxt = String(await tool.execute({ query: "NEEDLE_X" }, {}));
    ok(/exit=3|找不到 ripgrep|检索未返回/.test(qTxt) && !/throw/.test(qTxt), "D4 rg 缺失时插件工具 query 优雅报错（不崩）", qTxt.slice(0, 90));
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_SESSION_SEARCH_RG; else process.env.DSH_SESSION_SEARCH_RG = prevEnv;
  }
} catch (e) { ok(false, "D rg 降级场景异常", (e && e.message) || String(e)); }

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
