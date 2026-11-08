// _selfcheck-health-selftest.mjs —— 升级自检「健康环境零 WARN」+ 证据值 + WARN 能力保留 自测
//
// 跑法：node test/_selfcheck-health-selftest.mjs
//
// 背景（2026-11-07 真机假阳性）：
//   · #5 原「首 64KB 找 topicdb」永远 WARN —— 实测 stats.json 461,154B，topicdb 在第 414,257B；
//   · #6 原只查 MEMORY_ROOT/AGENTS.md（真机缺）—— DSH 实际注入的是 ~/.dsh/AGENTS.md（9018B）。
// 判据（Lead 硬要求）：
//   ① 健康环境（当前真机形态）7 项必须全 PASS、零 WARN、零 FAIL；
//   ② 每项输出必须带证据值（如 #5 `200 / 461154B`、#6 `AGENTS 命中 <path> 9018B`）；
//   ③ 真出问题时仍能 WARN/FAIL（flag 关 / 端点坏 / 库不可用），不得为消 WARN 削弱检查。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
const REAL_HOME = path.join(os.homedir(), ".dsh");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(100); } return false; }

// ── A. 静态：两处假阳性修复 + WARN 能力保留 ─────────────────────────────
ok(/stats\.json 探活/.test(SRC) && /JSON 可解析/.test(SRC) && !/首 64KB 未发现 topicdb/.test(SRC), "A1 #5 已改纯探活（旧「首 64KB 找 topicdb」口径已删）");
ok(/const bytes = String\(r\.body \|\| ""\)\.length;/.test(SRC) && /200 \/ " \+ bytes \+ "B \/ JSON 可解析/.test(SRC), "A2 #5 证据含字节数 + JSON 可解析");
ok(/AGENTS 命中/.test(SRC) && /agentsCandidates/.test(SRC) && /path\.join\(path\.dirname\(MEMORY_ROOT\), "AGENTS\.md"\)/.test(SRC), "A3 #6 三候选按序查（~/.dsh/AGENTS.md → MEMORY_ROOT/AGENTS.md → 模板）");
ok(/AGENTS\.md 三处候选均缺失/.test(SRC), "A4 #6 三处都缺时仍 WARN（能力未削弱）");
ok(/stats\.json 路由", "WARN"/.test(SRC) && /note-stat 端点", "FAIL"/.test(SRC), "A5 #5/#4 失败分支仍保留 WARN/FAIL");
ok(/UPGRADE_SELFCHECK_HOOKS\.runSelfCheck = runSelfCheck;/.test(SRC) && /setHttpProbe/.test(SRC), "A6 自检测试钩子已接线（runSelfCheck + 探活替换）");

// ── B. 健康环境：7 项全 PASS、零 WARN/FAIL、证据值齐全 ──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-selfcheck-health-"));
const HOME = path.join(TMP, "dsh-home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
// 真机形态：~/.dsh/AGENTS.md 存在（DSH 实际注入源）；memory 下只有 global/index 与主题库，没有 AGENTS.md
const realAgents = path.join(REAL_HOME, "AGENTS.md");
if (fs.existsSync(realAgents)) fs.copyFileSync(realAgents, path.join(HOME, "AGENTS.md"));
else fs.writeFileSync(path.join(HOME, "AGENTS.md"), "# agents\n<!-- dsh-memory-agents-template: v4 -->\n");
const agentsSize = fs.statSync(path.join(HOME, "AGENTS.md")).size;
for (const f of ["global.md", "index.md"]) {
  const src = path.join(REAL_HOME, "memory", f);
  fs.writeFileSync(path.join(MEM, f), fs.existsSync(src) ? fs.readFileSync(src) : ("# " + f + "\n"));
}
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const { createFixtureCtx } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
const fx = createFixtureCtx({});
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000);
ok(ready, "B0 前置：主题库就绪");
const H = mod.__upgradeSelfcheckHooks || {};
ok(typeof H.runSelfCheck === "function" && typeof H.setHttpProbe === "function", "B0b 前置：自检测试钩子可取到");

// 造真实数据：一个普通主题（#3 可读）+ 一个笔记主题（#7 最近写入）
try {
  const store = mod.__topicdb.store;
  const t = store.seedTopic({ name: "健康自检样例", triggers: ["健康自检", "SELFCHECK-OK"], src: "knowledge/selfcheck.md" });
  store.appendSentence({ topic: t.id, text: "健康环境自检句 SELFCHECK-OK-1。", src: "knowledge/selfcheck.md", actor: "runtime" });
  const nt = store.seedTopic({ name: "笔记·health/sid1234", triggers: ["笔记"], src: "sessions/health.md" });
  store.appendSentence({ topic: nt.id, text: "笔记句 health-note-1", src: "sessions/health.md", actor: "runtime" });
  ok(true, "B0c 造数：普通主题 + 笔记主题已写入");
} catch (eSeed) { ok(false, "B0c 造数失败", (eSeed && eSeed.message) || String(eSeed)); }

// 真实形态 stats.json：461,154B，topicdb 在第 414,257B（首 64KB 根本看不到）
function bigStatsBody() {
  const head = JSON.stringify({ ok: true, generatedAt: Date.now(), documents: [], pad: "" });
  const targetLen = 461154;
  const padLen = Math.max(0, targetLen - head.length - 200);
  const body = JSON.stringify({ ok: true, generatedAt: Date.now(), documents: [], pad: "x".repeat(padLen), topicdb: { enabled: true, ready: true, topics: 2, sentences: 2 } });
  return body;
}
const statsBody = bigStatsBody();
const topicdbAt = statsBody.indexOf('"topicdb"');
ok(topicdbAt > 65536 && statsBody.length > 400000, "B1 模拟真机 stats.json：>400KB 且 topicdb 在首 64KB 之后", "len=" + statsBody.length + " topicdb@" + topicdbAt);
const noteStatBody = JSON.stringify({ ok: true, disabled: false, ready: true, topics: 2, sentences: 2 });
H.setHttpProbe((pathname) => {
  if (pathname === "/dsh-memory/note-stat.json") return { ok: true, status: 200, body: noteStatBody, ms: 3, truncated: false };
  if (pathname === "/dsh-memory/stats.json") return { ok: true, status: 200, body: statsBody, ms: 12, truncated: false };
  return { ok: false, status: 404, body: "", error: "not-found", ms: 0 };
});
const out = await H.runSelfCheck();
console.log("---- 健康环境实跑输出 ----\n" + out + "\n--------------------------");
const lines = out.split("\n");
const itemLines = lines.filter((l) => /^\d\. /.test(l));
ok(itemLines.length === 7, "B2 输出 7 项", "lines=" + itemLines.length);
ok(itemLines.every((l) => l.indexOf("：PASS") >= 0), "B3 健康环境 7 项全 PASS（零 WARN/零 FAIL）", itemLines.map((l) => l.split("：")[0]).join(" / "));
ok(/总结：7 PASS \/ 0 WARN \/ 0 FAIL —— 无需处理/.test(out), "B4 总结 = 7 PASS / 0 WARN / 0 FAIL");
ok(!/修复：/.test(out), "B5 全 PASS 时不出现修复建议");
// 证据值（Lead 硬要求 ②）
ok(/#1[^\n]*PASS[^\n]*\d+ 主题/.test(out) || /1\. 主题库可用：PASS[^\n]*\d+ 主题/.test(out), "B6 #1 带证据（主题数/库大小）");
ok(/2\. memory_search 可检索：PASS[^\n]*查询「global」有结果/.test(out), "B7 #2 带证据（查询词 + 结果字数）");
ok(/3\. memory_read 可读：PASS[^\n]*\d+ 句/.test(out), "B8 #3 带证据（主题 ID + 句数）");
ok(/4\. note-stat 端点：PASS[^\n]*200 \/ topics=\d+ sentences=\d+/.test(out), "B9 #4 带证据（200 / topics / sentences / ms）");
ok(/5\. stats\.json 路由：PASS[^\n]*200 \/ \d+B \/ JSON 可解析/.test(out), "B10 #5 带证据（200 / 字节数 / JSON 可解析）");
const m5 = /5\. stats\.json 路由：PASS[^\n]*200 \/ (\d+)B/.exec(out);
ok(!!m5 && Number(m5[1]) > 400000, "B11 #5 证据字节数 >400KB（真机 461154B 形态）", m5 ? m5[1] + "B" : "missing");
ok(/6\. 版本\/模板一致：PASS[^\n]*AGENTS 命中 [^\n]*AGENTS\.md \d+B/.test(out), "B12 #6 带证据（命中路径 + 字节数）");
ok(out.indexOf(path.join(HOME, "AGENTS.md")) >= 0 && new RegExp(agentsSize + "B").test(out), "B13 #6 命中 ~/.dsh/AGENTS.md 且字节数一致", path.join(HOME, "AGENTS.md") + " " + agentsSize + "B");
ok(/7\. memory_note 可用：PASS[^\n]*工具已注册/.test(out) && /笔记主题 \d+ 个/.test(out), "B14 #7 带证据（工具已注册 + 笔记主题数）");

// ── C. WARN/FAIL 能力保留（真出问题仍要报）─────────────────────────────
// C1 #5：stats 端点 404 ⇒ 必须 WARN（不能恒 PASS）
H.setHttpProbe((pathname) => (pathname === "/dsh-memory/stats.json")
  ? { ok: true, status: 404, body: "not found", ms: 1, truncated: false }
  : { ok: true, status: 200, body: noteStatBody, ms: 3, truncated: false });
const out404 = await H.runSelfCheck();
ok(/5\. stats\.json 路由：WARN/.test(out404) && /HTTP 404/.test(out404), "C1 #5 端点 404 时仍 WARN（能力保留）", (out404.match(/5\. [^\n]*/) || [""])[0]);
// C2 #5：JSON 坏 ⇒ WARN
H.setHttpProbe((pathname) => (pathname === "/dsh-memory/stats.json")
  ? { ok: true, status: 200, body: "<html>oops</html>", ms: 1, truncated: false }
  : { ok: true, status: 200, body: noteStatBody, ms: 3, truncated: false });
const outBad = await H.runSelfCheck();
ok(/5\. stats\.json 路由：WARN[^\n]*JSON 不可解析/.test(outBad), "C2 #5 JSON 坏时仍 WARN（能力保留）", (outBad.match(/5\. [^\n]*/) || [""])[0]);
// C3 #4：note-stat 结构坏 ⇒ FAIL
H.setHttpProbe((pathname) => (pathname === "/dsh-memory/note-stat.json")
  ? { ok: true, status: 200, body: JSON.stringify({ ok: false }), ms: 1, truncated: false }
  : { ok: true, status: 200, body: statsBody, ms: 12, truncated: false });
const outNs = await H.runSelfCheck();
ok(/4\. note-stat 端点：FAIL/.test(outNs), "C3 #4 结构异常时仍 FAIL（能力保留）", (outNs.match(/4\. [^\n]*/) || [""])[0]);
// C4 无 webServer（clear probe）⇒ #4/#5 WARN
H.clearHttpProbe();
const outNoWs = await H.runSelfCheck();
ok(/4\. note-stat 端点：WARN[^\n]*无 webServer/.test(outNoWs) && /5\. stats\.json 路由：WARN[^\n]*无 webServer/.test(outNoWs), "C4 无 webServer 时 #4/#5 WARN（CLI/headless 预期）");
// C5 flag 关 ⇒ #1 WARN（md 模式），不误报 FAIL
{
  const fx2 = createFixtureCtx({});
  mod.default.apply(fx2.ctx, { memoryTopicDbEnabled: false });
  const H2 = mod.__upgradeSelfcheckHooks;
  H2.setHttpProbe(() => ({ ok: true, status: 200, body: noteStatBody, ms: 1, truncated: false }));
  const outFlag = await H2.runSelfCheck();
  ok(/1\. 主题库可用：WARN[^\n]*flag 关/.test(outFlag), "C5 flag 关时 #1 WARN（真问题仍报，不恒 PASS）", (outFlag.match(/1\. [^\n]*/) || [""])[0]);
  H2.clearHttpProbe();
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
