// _session-list-selftest.mjs —— session_search `list` 模式（digest 通道退役前的能力补位）自测
//
// 跑法：node test/_session-list-selftest.mjs
//
// 依据：docs/audit/digest-vs-session-search_COVERAGE_2026-11-07.md
// 覆盖：
//   A CLI `--list`：① 按**活动 mtime** 归日（跨日会话不漏）② 首/尾消息提取 ③ 默认排除插件子代理 ④ includePlugin 生效
//     ⑤ 无 list 时检索/replay 行为不变 ⑥ 性能（30 会话 < 1s 量级）
//   B 插件工具 `session_search({list:true})`：同源调用 CLI、文本含首/尾、默认排除、include_plugin、非 list 零回归
//   C 静态接线：CLI cmdList/--list 分发、工具 description 增补、参数 list/label/include_plugin
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const INDEX = path.join(PLUGIN, "index.js");
const CLI_SRC = path.join(os.homedir(), ".dsh", "tools", "session-search", "session-search.mjs");
const SRC = fs.readFileSync(INDEX, "utf8");
const CLI_TXT = fs.readFileSync(CLI_SRC, "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(100); } return false; }

// ── 造一个可控 DSH_HOME：sessions（活动 mtime）+ session-text（首事件日缓存）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-list-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const SESS = path.join(HOME, "sessions");
const CACHE = path.join(HOME, "session-text");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
// 工具会用 DSH_HOME/tools/session-search/session-search.mjs 作为单一实现 ⇒ 拷一份真 CLI 到临时 home
fs.mkdirSync(path.join(HOME, "tools", "session-search"), { recursive: true });
fs.copyFileSync(CLI_SRC, path.join(HOME, "tools", "session-search", "session-search.mjs"));

const WS = path.join(SESS, "ws-proj");
function mkSid(o) {
  const dirName = o.topLevel ? ("session-" + o.sid8 + "-1111-2222-3333-444455556666") : (o.sid8 + "-1111-2222-3333-444455556666");
  const sdir = path.join(WS, dirName);
  fs.mkdirSync(sdir, { recursive: true });
  const log = path.join(sdir, "session.v4.jsonl.zstd");
  fs.writeFileSync(log, "dummy-zstd");
  const dt = new Date(o.mtime).getTime() / 1000;
  fs.utimesSync(log, dt, dt);
  fs.utimesSync(sdir, dt, dt);
  if (o.cacheDay) {
    const cdir = path.join(CACHE, o.cacheDay, o.sid8);
    fs.mkdirSync(cdir, { recursive: true });
    const lines = [];
    if (o.firstKind === "system") lines.push(JSON.stringify({ k: "system/message", fr: 1, x: o.firstText }));
    else lines.push(JSON.stringify({ k: "user/message", fr: 1, x: o.firstText }));
    lines.push(JSON.stringify({ k: "tool/call", fr: 2, x: "tool {}" }));
    if (o.lastText) lines.push(JSON.stringify({ k: "assistant/message", fr: 3, x: o.lastText }));
    fs.writeFileSync(path.join(cdir, "seg-0001.jsonl"), lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cdir, "manifest.json"), JSON.stringify({
      ver: 1, sid: o.sid8, day: o.cacheDay,
      files: { "session.v4.jsonl.zstd": { size: (o.kb || 10) * 1024, frames: o.frames || 5 } },
      segs: ["seg-0001.jsonl"], chars: 100,
    }), "utf8");
  }
}
const D06 = "2026-11-06T12:00:00+08:00", D05 = "2026-11-05T12:00:00+08:00";
// ① 跨日会话：活动日 11-06，但缓存首事件日 11-05（replay 会漏；list 必须按 mtime 列出）
mkSid({ sid8: "aaaaaaaa", topLevel: true, mtime: D06, cacheDay: "2026-11-05", firstKind: "user", firstText: "首条任务 AAAA " + "x".repeat(260), lastText: "尾条结论 AAAA " + "y".repeat(400), kb: 20, frames: 7 });
// ② 子代理（非插件）：应保留
mkSid({ sid8: "cccccccc", topLevel: false, mtime: D06, cacheDay: "2026-11-06", firstKind: "user", firstText: "子代理任务 CCCC", lastText: "子代理结论 CCCC", kb: 30, frames: 9 });
// ③ 插件子代理：默认排除
mkSid({ sid8: "dddddddd", topLevel: false, mtime: D06, cacheDay: "2026-11-06", firstKind: "system", firstText: "你是 dsh-memory 插件的记忆写入器。只输出一份结构化 Markdown 检查点。", lastText: "插件结论 DDDD", kb: 40, frames: 11 });
// ④ 11-05 的会话（since 11-06 时必须排除）
mkSid({ sid8: "bbbbbbbb", topLevel: true, mtime: D05, cacheDay: "2026-11-05", firstKind: "user", firstText: "旧任务 BBBB", lastText: "旧结论 BBBB", kb: 5, frames: 3 });
// ⑤ 27 个 filler（凑 11-06 共 30 个：aaaa+cccc+dddd+27）
for (let i = 0; i < 27; i++) mkSid({ sid8: String(10000000 + i), topLevel: true, mtime: D06, cacheDay: "2026-11-06", firstKind: "user", firstText: "filler " + i, lastText: "done " + i, kb: 2, frames: 2 });

const cliPath = path.join(HOME, "tools", "session-search", "session-search.mjs");
function runCli(args) {
  const t0 = Date.now();
  const out = execFileSync(process.execPath, [cliPath, "--ds-home", HOME].concat(args), { encoding: "utf8", timeout: 60000 });
  return { out: out, ms: Date.now() - t0 };
}
function runCliJson(args) { const r = runCli(args.concat(["--json"])); return { j: JSON.parse(r.out), ms: r.ms, out: r.out }; }

// ── A. CLI --list ─────────────────────────────────────────────────────
try {
  const a = runCliJson(["--list", "--since", "2026-11-06", "--until", "2026-11-06"]);
  ok(a.j.ok === true && a.j.total === 30, "A1 活动日 11-06 ⇒ 候选 30 个（11 顶层/19 子代理形态）", "total=" + a.j.total);
  const sids = a.j.rows.map((r) => r.sid8);
  ok(sids.indexOf("aaaaaaaa") >= 0, "A2 跨日会话不漏：活动日 11-06、缓存首事件日 11-05 的 aaaaaaaa 被列出");
  ok(sids.indexOf("bbbbbbbb") < 0, "A3 活动日过滤正确：11-05 的 bbbbbbbb 不在 11-06 结果里");
  const aa = a.j.rows.find((r) => r.sid8 === "aaaaaaaa");
  ok(aa && aa.firstUser.indexOf("首条任务 AAAA") === 0 && aa.lastAssistant.indexOf("尾条结论 AAAA") === 0, "A4 首条 user / 尾条 assistant 均提取到");
  ok(aa && aa.firstUser.length <= 201 && aa.lastAssistant.length <= 301, "A5 首条截断 200 / 尾条截断 300", "firstLen=" + (aa && aa.firstUser.length) + " lastLen=" + (aa && aa.lastAssistant.length));
  ok(aa && aa.kb === 20 && aa.frames === 7, "A6 元信息 KB/帧数来自缓存 manifest", JSON.stringify(aa && { kb: aa.kb, frames: aa.frames }));
  ok(sids.indexOf("dddddddd") < 0 && a.j.skippedPlugin >= 1, "A7 默认排除插件子代理（dddddddd 不在列表）", "skipped=" + a.j.skippedPlugin);
  ok(sids.indexOf("cccccccc") >= 0, "A8 非插件子代理保留（cccccccc）");
  ok(a.ms < 2000, "A9 性能：CLI 30 会话列举 < 2s（含 node 启动）", a.ms + "ms");

  const inc = runCliJson(["--list", "--since", "2026-11-06", "--until", "2026-11-06", "--include-plugin"]);
  const incSids = inc.j.rows.map((r) => r.sid8);
  const dd = inc.j.rows.find((r) => r.sid8 === "dddddddd");
  ok(inc.j.listed === 30 && incSids.indexOf("dddddddd") >= 0 && dd && dd.plugin === true, "A10 includePlugin 生效：30 个全列且 dddddddd 标记 plugin", "listed=" + inc.j.listed);

  const d05 = runCliJson(["--list", "--since", "2026-11-05", "--until", "2026-11-05"]);
  ok(d05.j.total === 1 && d05.j.rows[0].sid8 === "bbbbbbbb", "A11 11-05 活动日 ⇒ 只有 bbbbbbbb（活动 mtime 分桶）", JSON.stringify(d05.j.rows.map((r) => r.sid8)));

  // 无 list：检索/回放路径不变（关键词 0 命中给引导、--replay 仍按缓存日）
  let searchOut = "", searchCode = 0;
  try { searchOut = runCli(["ZZZZ_NO_SUCH_TOKEN"]).out; } catch (e) { searchCode = e.status; searchOut = String(e.stdout || ""); }
  ok(searchCode === 1 && /0 结果 ≠ 没记录/.test(searchOut), "A12 无 --list 时检索路径不变（关键词 0 命中仍给升级引导，exit=1）");
  const rp = runCli(["--replay", "--since", "2026-11-05", "--until", "2026-11-05"]);
  ok(/用户消息 \d+ 条/.test(rp.out) && rp.out.indexOf("aaaa") >= 0, "A13 --replay 行为不变（仍按缓存日=首事件日，能列出 aaaa 的缓存日 11-05）");
} catch (e) { ok(false, "A CLI 场景异常", (e && e.message) || String(e)); }

// ── B. 插件工具 session_search({list:true}) ───────────────────────────
try {
  process.env.DSH_HOME = HOME;
  process.env.DSH_MEMORY_ROOT = MEM;
  process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
  delete process.env.MEMTOPIC_DIR;
  const mod = await import(pathToFileURL(INDEX).href);
  const { createFixtureCtx, findTool } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
  const fx = createFixtureCtx({});
  mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
  await waitFor(() => mod.__topicdb && mod.__topicdb.ready, 20000);
  const tool = findTool(fx.captured, "session_search");
  ok(!!(tool && typeof tool.execute === "function"), "B0 前置：session_search 工具可取到");
  const t0 = Date.now();
  const txt = String(await tool.execute({ list: true, since: "2026-11-06", until: "2026-11-06" }, {}));
  const ms = Date.now() - t0;
  ok(/会话列表（按活动时间倒序）/.test(txt) && /列出 29 \/ 候选 30 个/.test(txt), "B1 工具 list 文本：列出 29 / 候选 30（默认排除插件子代理）", txt.split("\n")[0]);
  ok(txt.indexOf("aaaaaaaa") >= 0 && txt.indexOf("首条：首条任务 AAAA") >= 0 && txt.indexOf("尾条：尾条结论 AAAA") >= 0, "B2 工具输出含跨日会话与首/尾结论");
  ok(txt.indexOf("dddddddd") < 0, "B3 工具默认不含插件子代理 dddddddd");
  ok(/不落库、不可被 memory_search 检索/.test(txt), "B4 工具输出如实交代缺口 5（不落库/不可检索）");
  ok(ms < 2500, "B5 性能：工具 list 调用 < 2.5s（含 CLI 子进程）", ms + "ms");
  const inc = String(await tool.execute({ list: true, since: "2026-11-06", until: "2026-11-06", include_plugin: true }, {}));
  ok(inc.indexOf("dddddddd") >= 0 && /\[插件\]/.test(inc) && /列出 30 \/ 候选 30/.test(inc), "B6 include_plugin:true ⇒ 出现插件子代理且标记 [插件]");
  const lab = String(await tool.execute({ list: true, since: "2026-11-06", until: "2026-11-06", label: "首条任务 AAAA" }, {}));
  ok(/列出 1 \/ 候选 30/.test(lab) && lab.indexOf("aaaaaaaa") >= 0, "B7 label 过滤生效（按首条任务文本）");
  const st = String(await tool.execute({ status: true }, {}));
  ok(/索引状态/.test(st), "B8 无 list 参数零回归：status 模式仍走原分支");
  const q = String(await tool.execute({ query: "ZZZZ_NO_SUCH_TOKEN" }, {}));
  ok(!/会话列表（按活动时间倒序）/.test(q) && /(命中 0|检索未返回|0 结果)/.test(q), "B9 无 list 参数零回归：query 模式仍走检索（不返回列表格式）");
} catch (e) { ok(false, "B 工具场景异常", (e && e.message) || String(e)); }

// ── C. 静态接线 ───────────────────────────────────────────────────────
ok(/function cmdList\(o\)/.test(CLI_TXT) && /CMD_LIST = has\("--list"\)/.test(CLI_TXT) && /--include-plugin/.test(CLI_TXT), "C1 CLI 已实现 cmdList / --list 分发 / --include-plugin");
ok(/按\*\*活动时间（日志 mtime）\*\*归日与排序/.test(CLI_TXT), "C2 CLI list 语义=活动 mtime（非首事件日）");
ok(/list:true 可按\*\*活动时间\*\*列举会话/.test(SRC) && /不落库、不可被 memory_search 检索/.test(SRC), "C3 工具 description 已增补 list 能力与缺口 5 说明");
ok(/list: \{ type: "boolean"/.test(SRC) && /label: \{ type: "string"/.test(SRC) && /include_plugin: \{ type: "boolean"/.test(SRC), "C4 工具参数含 list / label / include_plugin");
ok(/if \(a\.list === true\)/.test(SRC) && /const lArgs = cli\.concat\(\["--list", "--json"\]\)/.test(SRC), "C5 工具 list 分支调用同一 CLI（单一实现，不写两套）");
ok(!/function cmdList[\s\S]{0,200}?readFileSync\([^)]*session\.v4/.test(CLI_TXT), "C6 list 不扫原始 zstd（只读 session-text 缓存段）");

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
