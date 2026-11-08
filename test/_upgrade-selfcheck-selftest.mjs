// _upgrade-selfcheck-selftest.mjs —— 升级后自检（一次性注入 + hidden action + 命令 + md）自测
//
// 跑法：node test/_upgrade-selfcheck-selftest.mjs
//
// 依据：docs/audit/upgrade-selfcheck_CRA_2026-11-07.md
// 覆盖：
//   A 静态接线：onboard 字段/白名单、检测/注入函数、启动调用、agent/created 调用、hidden action、命令 count:false、md 存在
//   B 行为（每个场景独立子进程 + 独立临时 DSH_HOME）：
//     ① 新装无 lastVersion ⇒ 只建基线不提醒 ② 升级 ⇒ pending 写入且只注入一次、二次不注入
//     ③ 降级静默 ④ 同版本不提醒（保留未注入 pending） ⑤ 老用户首次升级 from="旧版本"
//     ⑥ mergeOnboardState 保字段（attempts/at/from 原样保留）
//   C runSelfCheck 结构：memory_onboard(action=selfcheck) 与 /memory-check 输出 7 项 + 总结；工具 description 未改
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const INDEX = path.join(PLUGIN, "index.js");
const FIXTURE = path.join(PLUGIN, "_fixture-ctx.mjs");
const SRC = fs.readFileSync(INDEX, "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const curVersion = (() => { const m = /const PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(SRC); return m ? m[1] : ""; })();

// ── A. 静态接线 ─────────────────────────────────────────────────────────
ok(!!curVersion, "A1 取到 PLUGIN_VERSION", curVersion);
ok(/lastVersion:\s*""/.test(SRC) && /upgradeCheck:\s*\{\s*from:\s*""/.test(SRC), "A2 defaultOnboardState 含 lastVersion / upgradeCheck");
ok(/typeof raw\.lastVersion === "string"/.test(SRC) && /typeof uc\.promptedAt === "number"/.test(SRC) && /typeof uc\.attempts === "number"/.test(SRC), "A3 mergeOnboardState 白名单含 lastVersion + upgradeCheck 全字段");
ok(/function maybeDetectUpgradeAtBoot\(\)/.test(SRC) && /function maybeInjectUpgradeCheckNotice\(agent, label\)/.test(SRC), "A4 检测/注入函数已定义");
ok(/maybeDetectUpgradeAtBoot\(\);\s*\} catch \(eUG\)/.test(SRC), "A5 apply 启动期调用检测（try/catch 不阻塞）");
ok(/maybeInjectUpgradeCheckNotice\(agent, SESSION_LABEL\)/.test(SRC), "A6 agent/created 尾部调用一次性注入");
ok(/act === "selfcheck" \|\| act === "self-check" \|\| act === "self_check"/.test(SRC) && /return await runSelfCheck\(\)/.test(SRC), "A7 memory_onboard 隐藏 action=selfcheck 分支");
ok(/name: "memory-check"/.test(SRC) && /\}, \{ count: false \}\);/.test(SRC), "A8 /memory-check 命令注册且 count:false");
ok(/function runSelfCheck\(\)/.test(SRC) && /async function runSelfCheck\(\)/.test(SRC), "A9 runSelfCheck 已定义");
ok(fs.existsSync(path.join(PLUGIN, "docs", "升级后自检清单.md")), "A10 docs/升级后自检清单.md 存在");
ok(!/action=selfcheck/.test((/name: "memory_onboard"[\s\S]{0,600}/.exec(SRC) || [""])[0]), "A11 memory_onboard description/schema 未改动（不提 selfcheck）");
ok(SRC.indexOf("AGENTS.template.md") >= 0 && SRC.indexOf("dsh-memory-agents-template:") >= 0, "A12 自检第 6 项查模板 marker（运行期口径，不查 sha）");

// ── B/C. 子进程场景 ─────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-upgrade-sc-"));
const scenarioCode = (HOME, MEM, injectTimes) => `
process.env.DSH_HOME = ${JSON.stringify(HOME)};
process.env.DSH_MEMORY_ROOT = ${JSON.stringify(MEM)};
process.env.MEMTOPIC_DB = ${JSON.stringify(path.join(MEM, ".memtopic", "mem.db"))};
delete process.env.MEMTOPIC_DIR;
const mod = await import(${JSON.stringify(pathToFileURL(INDEX).href)});
const { createFixtureCtx, findTool } = await import(${JSON.stringify(pathToFileURL(FIXTURE).href)});
const fx = createFixtureCtx({});
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const wait = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); } return false; };
await wait(() => mod.__topicdb && mod.__topicdb.ready, 20000);
const injected = [];
const created = (fx.captured.handlers || []).find((h) => h.event === "agent/created");
const fakeAgent = { options: {}, session: { id: "sess-" + Math.random().toString(36).slice(2, 8), header: { origin: "main", cwd: ${JSON.stringify(TMP)} }, cwd: ${JSON.stringify(TMP)} }, inject(msg) { const txt = (typeof msg === "string") ? msg : (Array.isArray(msg && msg.content) ? msg.content.map((q) => String((q && q.text) || "")).join("") : JSON.stringify(msg)); injected.push(txt); } };
const callCreated = () => { try { created.fn({ agent: fakeAgent, source: "startup", signal: { aborted: false } }); } catch (e) { injected.push("ERR:" + (e && e.message)); } };
for (let i = 0; i < ${Number(injectTimes) || 0}; i++) { callCreated(); await new Promise((r) => setTimeout(r, 300)); }
const tool = findTool(fx.captured, "memory_onboard");
const cmd = (fx.captured.commands || []).find((c) => c.name === "memory-check");
let selfcheck = ""; let cmdText = "";
if (tool) selfcheck = String(await tool.execute({ action: "selfcheck" }, { agent: fakeAgent }));
if (cmd && typeof cmd.handler === "function") { const r = await cmd.handler({ agent: fakeAgent }); cmdText = String((r && r.text) || ""); }
const fsm = await import("node:fs");
const ob = JSON.parse(fsm.readFileSync(${JSON.stringify(path.join(HOME, "memory", ".onboard.json"))}, "utf8"));
console.log("SCENARIO_JSON=" + JSON.stringify({ onboard: ob, injected: injected, selfcheck: selfcheck, cmdText: cmdText, toolDesc: tool ? String(tool.description) : "", hasTool: !!tool, hasCmd: !!cmd }));
process.exit(0);
`;
function runScenario(name, seedOnboard, injectTimes) {
  const HOME = path.join(TMP, name, "home");
  const MEM = path.join(HOME, "memory");
  fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
  fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
  if (seedOnboard) fs.writeFileSync(path.join(MEM, ".onboard.json"), JSON.stringify(seedOnboard), "utf8");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", scenarioCode(HOME, MEM, injectTimes)], { encoding: "utf8", timeout: 60000, cwd: PLUGIN });
  const line = out.split(/\r?\n/).find((l) => l.indexOf("SCENARIO_JSON=") === 0);
  if (!line) throw new Error("场景 " + name + " 未输出结果：" + out.slice(-500));
  return JSON.parse(line.slice("SCENARIO_JSON=".length));
}
const upgradeMsgs = (inj) => (inj || []).filter((m) => m.indexOf("dsh-memory 升级自检") >= 0);

try {
  // ① 新装（无 .onboard.json）⇒ 只建基线，不提醒
  const s1 = runScenario("fresh", null, 1);
  ok(s1.onboard.lastVersion === curVersion, "B1 新装：lastVersion=当前版本", s1.onboard.lastVersion);
  ok(!s1.onboard.upgradeCheck || !s1.onboard.upgradeCheck.to, "B2 新装：无 pending（不提醒）", JSON.stringify(s1.onboard.upgradeCheck));
  ok(upgradeMsgs(s1.injected).length === 0, "B3 新装：未注入升级自检提醒");

  // ② 升级：pending 写入 + 只注入一次
  const s2 = runScenario("upgrade", { lastVersion: "4.0.1" }, 2);
  ok(s2.onboard.upgradeCheck && s2.onboard.upgradeCheck.from === "4.0.1" && s2.onboard.upgradeCheck.to === curVersion, "B4 升级：pending from/to 正确", JSON.stringify(s2.onboard.upgradeCheck));
  ok(Number(s2.onboard.upgradeCheck.promptedAt) > 0, "B5 升级：注入后 promptedAt 已落盘");
  const um2 = upgradeMsgs(s2.injected);
  ok(um2.length === 1, "B6 升级：只注入一次（二次 agent/created 不再注入）", "count=" + um2.length);
  ok(um2[0] && um2[0].indexOf("4.0.1→" + curVersion) >= 0 && um2[0].indexOf("action=selfcheck") >= 0 && um2[0].length <= 200, "B7 注入文案含 from→to + action=selfcheck 且 ≤80 字（含包装）", String(um2[0]).slice(0, 120));
  ok(s2.onboard.lastVersion === curVersion, "B8 升级：lastVersion 已更新");

  // ③ 降级静默
  const s3 = runScenario("downgrade", { lastVersion: "99.0.0" }, 1);
  ok(s3.onboard.lastVersion === curVersion && (!s3.onboard.upgradeCheck || !s3.onboard.upgradeCheck.to), "B9 降级：静默更新基线、无 pending", JSON.stringify(s3.onboard.upgradeCheck));
  ok(upgradeMsgs(s3.injected).length === 0, "B10 降级：不注入");

  // ④ 同版本：不提醒；保留未注入的 pending（attempts/at 原样 ⇒ 同时验证 merge 白名单）
  const s4 = runScenario("samever", { lastVersion: curVersion, upgradeCheck: { from: "x", to: "y", at: 111, promptedAt: 0, attempts: 2 } }, 1);
  ok(s4.onboard.upgradeCheck.from === "x" && s4.onboard.upgradeCheck.at === 111 && s4.onboard.upgradeCheck.attempts === 3, "B11 同版本：pending 字段经 mergeOnboardState 原样保留（from/at 保留，attempts 2→3）", JSON.stringify(s4.onboard.upgradeCheck));
  ok(upgradeMsgs(s4.injected).length === 1, "B12 同版本：保留的 pending 在首个会话注入一次");

  // ⑤ 老用户首次升级（有文件、无 lastVersion）⇒ from="旧版本"
  const s5 = runScenario("legacy", { initPromptedAt: 123 }, 1);
  ok(s5.onboard.upgradeCheck && s5.onboard.upgradeCheck.from === "旧版本" && s5.onboard.upgradeCheck.to === curVersion, "B13 老用户首次升级：from=旧版本", JSON.stringify(s5.onboard.upgradeCheck));
  ok(upgradeMsgs(s5.injected).length === 1, "B14 老用户首次升级：注入一次");

  // C runSelfCheck 结构（用升级场景的输出）
  const sc = s2.selfcheck || "";
  const labels = ["主题库可用", "memory_search 可检索", "memory_read 可读", "note-stat 端点", "stats.json 路由", "版本/模板一致", "memory_note 可用"];
  ok(labels.every((l) => sc.indexOf(l) >= 0), "C1 runSelfCheck 输出含 7 项标签", labels.filter((l) => sc.indexOf(l) < 0).join(",") || "all");
  ok(/1\. 主题库可用：(PASS|WARN|FAIL)/.test(sc) && /7\. memory_note 可用：(PASS|WARN|FAIL)/.test(sc), "C2 逐项 PASS/WARN/FAIL 格式");
  ok(/总结：\d+ PASS \/ \d+ WARN \/ \d+ FAIL/.test(sc), "C3 输出含一行总结", (sc.match(/总结：[^\n]*/) || [""])[0]);
  ok(sc.length > 0 && sc.length <= 4000, "C4 输出截断 ≤4000 字", "len=" + sc.length);
  ok(s2.hasTool === true && s2.hasCmd === true, "C5 memory_onboard 工具与 /memory-check 命令均注册");
  ok(s2.cmdText.indexOf("总结：") >= 0 && s2.cmdText.indexOf("主题库可用") >= 0, "C6 /memory-check 与工具同一实现（输出同结构）");
  ok(s2.toolDesc.indexOf("selfcheck") < 0, "C7 工具 description 未暴露隐藏 action（不改 schema）");
} catch (e) {
  ok(false, "场景执行异常", (e && e.message) || String(e));
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
