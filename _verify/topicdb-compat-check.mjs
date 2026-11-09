// topicdb-compat-check.mjs —— task-49（compat 能力自检 + 容错改造）
// C01 正常环境 compat 行写入/字段完整；C02 schemastery 解析失败降级 stub；
// C03 commands 缺失可加载；C04 skills 缺失可加载 + skills.list 守卫；
// C05 compat 只写一次（重复 apply/热更新不刷）；C06 既有断言（由外层复跑）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "E:/工具/插件开发调整";
const PLUGIN = ROOT + "/dsh-memory-plugin/index.js";
const FIXTURE = ROOT + "/dsh-memory-plugin/_fixture-ctx.mjs";
let pass = 0; const fails = [];
function ok(c, n, d) { if (c) { pass++; console.log("PASS  " + n + (d ? "  —  " + d : "")); } else { fails.push(n); console.log("FAIL  " + n + (d ? "  —  " + d : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
function mkScenario(tag, opts) {
  const o = opts || {};
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "compat-" + tag + "-"));
  const HOME = path.join(TMP, "dsh-home");
  const MEM = path.join(HOME, "memory");
  fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n", "utf8");
  fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n", "utf8");
  fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ version: 1, hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
  const PROF = path.join(TMP, "profile");
  fs.mkdirSync(PROF, { recursive: true });
  fs.writeFileSync(path.join(PROF, "package.json"), JSON.stringify({
    name: "dsh-profile-compat-test",
    dependencies: { "@deepseek-ai/dsh-base": "9.9.9-compat-test" },
  }), "utf8");
  process.env.DSH_HOME = HOME;
  process.env.DSH_MEMORY_ROOT = MEM;
  process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
  process.env.DSH_PROFILE_DIR = PROF;
  delete process.env.MEMTOPIC_DIR;
  delete process.env.DSH_MEMORY_MARK_MD;
  delete process.env.MEMORY_MARK_MD;
  if (o.forceStub) process.env.DSH_MEMORY_SCHEMASTERY_FORCE_STUB = "1";
  else delete process.env.DSH_MEMORY_SCHEMASTERY_FORCE_STUB;
  cleanups.push(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
  return { TMP, HOME, MEM, PROF, tag };
}
async function loadPlugin(sc, extraQuery) {
  return await import(pathToFileURL(PLUGIN).href + "?compat=" + sc.tag + "=" + Date.now() + (extraQuery || ""));
}
function readCompat(MEM) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(MEM, ".monitor.json"), "utf8"));
    const evs = (j.events || []).filter((e) => e && e.type === "compat");
    return { count: evs.length, detail: evs.length ? evs[evs.length - 1].detail : null };
  } catch (e) { return { count: 0, detail: null, error: String((e && e.message) || e) }; }
}
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

// ══════════════ C01 正常环境：compat 行真实写入 .monitor.json，字段完整 ══════════════
const sc1 = mkScenario("c01");
const mod1 = await loadPlugin(sc1);
ok(typeof mod1.default === "object" && typeof mod1.default.apply === "function", "C01 前置：插件模块加载成功（动态 schemastery import 生效）");
// [Lead 2026-10-30] 3.5.0 实测回归：把 commands/skills 移出顶层 inject 后，真实宿主里斜杠命令全部消失
//   （ctx.inject 回调没落到注册时机）⇒ 已恢复为"顶层 inject 全量 4 项 + 直接注册"。
//   本断言改为**必须**包含这 4 项；同时保留"可选注入兜底代码存在"的旁证（见 C03/C04）。
ok(Array.isArray(mod1.default.inject) && ["fs", "timer", "commands", "skills"].every((n) => mod1.default.inject.includes(n)),
  "C01 顶层 inject 恢复为 [fs,timer,commands,skills]（3.5.0 命令消失回归的修复点）", JSON.stringify(mod1.default.inject));
const fx1 = createFixtureCtx({});
let applyThrew1 = null;
try { mod1.default.apply(fx1.ctx, {}); } catch (e) { applyThrew1 = e; }
await sleep(80);
ok(!applyThrew1, "C01 apply 正常完成", applyThrew1 ? ("throw: " + applyThrew1.message) : "");
const c1 = readCompat(sc1.MEM);
const d1 = c1.detail;
ok(c1.count === 1 && !!d1, "C01 compat 行已真实写入 .monitor.json（events 里 type=compat 恰好 1 条）", JSON.stringify({ count: c1.count }));
ok(!!d1 && d1.dshPkg && d1.dshPkg.name === "dsh" && d1.dshPkg.version === "9.9.9-compat-test",
  "C01 dshPkg 版本读取（$DSH_PROFILE_DIR/package.json 的 dsh-base 版本）", JSON.stringify(d1 && d1.dshPkg));
const EV_KEYS = ["agent/created", "agent/pre-step", "session/event", "tools/pre-execute", "tools/result", "loader/volatile-update"];
ok(!!d1 && EV_KEYS.every((k) => d1.events && d1.events[k] === 1),
  "C01 6 个事件注册全部成功（events.* 全为 1）", JSON.stringify(d1 && d1.events));
{
  const capEvs = (fx1.captured.handlers || []).map((h) => h && h.event);
  ok(EV_KEYS.every((k) => capEvs.includes(k)) && capEvs.length >= 6,
    "C01 事件处理函数真实挂到 ctx.on（6 类事件均被注册，不是只打勾）", JSON.stringify(capEvs));
}
ok(!!d1 && d1.services && d1.services.tools === "ok" && d1.services.commands === "ok" && d1.services.skills === "ok",
  "C01 services：tools/commands/skills 均 ok（settings/webServer 在夹具里 absent 属预期）", JSON.stringify(d1 && d1.services));
ok(!!d1 && d1.tools && d1.tools.registered >= 4, "C01 tools.registered >= 4", JSON.stringify(d1 && d1.tools));
ok(!!d1 && d1.commands && d1.commands.registered === d1.commands.expected && d1.commands.expected >= 1,
  "C01 commands.registered == expected（全部命令注册成功）", JSON.stringify(d1 && d1.commands));
ok(!!d1 && d1.schemastery === "ok", "C01 schemastery:\"ok\"", JSON.stringify(d1 && d1.schemastery));
ok(!!d1 && Array.isArray(d1.injectHard) && ["fs", "timer", "commands", "skills"].every((n) => d1.injectHard.includes(n)),
  "C01 injectHard 实际生效 4 项（fs/timer/commands/skills）", JSON.stringify(d1 && d1.injectHard));
// [Lead 2026-10-30] 语义变更：injectSoft 现在表示"声明了但运行时没拿到 ⇒ 靠动态兜底"的项；
//   正常环境 4 项都拿到 ⇒ 必为 []。缺失场景见 C03/C04（此时 injectSoft 会出现对应项）。
ok(!!d1 && Array.isArray(d1.injectSoft) && d1.injectSoft.length === 0,
  "C01 injectSoft 正常环境为空（4 项硬依赖全部就位）", JSON.stringify(d1 && d1.injectSoft));
ok(!!d1 && typeof d1.at === "number" && d1.at > 0, "C01 compat.at 时间戳存在");

// ══════════════ C05 compat 只写一次（同进程重复 apply / 直调 finalize 不重复刷） ══════════════
{
  const before = readCompat(sc1.MEM).count;
  const fx2 = createFixtureCtx({});
  let threw2 = null;
  try { mod1.default.apply(fx2.ctx, {}); } catch (e) { threw2 = e; }
  await sleep(40);
  const afterApply = readCompat(sc1.MEM).count;
  const again = mod1.__compatFinalize(fx2.ctx, null);
  const afterFinalize = readCompat(sc1.MEM).count;
  ok(!threw2, "C05 同进程第二次 apply 不抛错（热更新场景可重入）", threw2 ? ("throw: " + threw2.message) : "");
  ok(before === 1 && afterApply === 1 && afterFinalize === 1,
    "C05 compat 只写一次：重复 apply / 直调 finalize 都不再追加 events", JSON.stringify({ before, afterApply, afterFinalize }));
  ok(!!again && again === mod1.__compat.report && mod1.__compat.wrote === true,
    "C05 finalize 幂等返回首份报告（COMPAT.wrote 闸）");
}

// ══════════════ C02 schemastery 解析失败：动态 import 降级 stub，插件仍加载 ══════════════
const sc2 = mkScenario("c02", { forceStub: true });
let mod2 = null, loadErr2 = null;
try { mod2 = await loadPlugin(sc2); } catch (e) { loadErr2 = e; }
ok(!!mod2 && !loadErr2, "C02 schemastery 不可用时模块仍加载成功（不再静态 import 即崩）", loadErr2 ? ("throw: " + loadErr2.message) : "");
if (mod2) {
  ok(!!mod2.default && !!mod2.default.Config, "C02 Config 仍存在（透传 stub）");
  ok(mod2.__schemasteryMode === "stub", "C02 模块级记录 schemastery=\"stub\"", String(mod2.__schemasteryMode));
  let stubCallThrew = null;
  try { mod2.__compatSchemaStub(); mod2.default.Config && mod2.default.Config({ a: 1 }); } catch (e) { stubCallThrew = e; }
  ok(!stubCallThrew, "C02 stub Config 可调用不抛错");
  const fx2b = createFixtureCtx({});
  let threw2b = null;
  try { mod2.default.apply(fx2b.ctx, {}); } catch (e) { threw2b = e; }
  await sleep(80);
  const c2 = readCompat(sc2.MEM);
  ok(!threw2b && c2.count === 1, "C02 stub 模式下插件仍能正常 apply 并写 compat", threw2b ? ("throw: " + threw2b.message) : JSON.stringify({ count: c2.count }));
  ok(!!c2.detail && c2.detail.schemastery === "stub", "C02 compat 记录 schemastery:\"stub\"", JSON.stringify(c2.detail && c2.detail.schemastery));
  ok(!!c2.detail && c2.detail.tools && c2.detail.tools.registered >= 4, "C02 降级后工具仍注册（>=4）", JSON.stringify(c2.detail && c2.detail.tools));
}

// ══════════════ C03 commands 缺失：可选注入 → 正常加载，compat 记 absent ══════════════
const sc3 = mkScenario("c03");
const mod3 = await loadPlugin(sc3);
const fx3 = createFixtureCtx({});
delete fx3.ctx.commands;   // 模拟新宿主移走 commands 服务
let threw3 = null;
try { mod3.default.apply(fx3.ctx, {}); } catch (e) { threw3 = e; }
await sleep(80);
const c3 = readCompat(sc3.MEM);
ok(!threw3, "C03 commands 缺失时插件正常加载（不再整体 pending）", threw3 ? ("throw: " + threw3.message) : "");
ok(!!c3.detail && c3.detail.services && c3.detail.services.commands === "absent",
  "C03 compat 记录 commands:absent", JSON.stringify(c3.detail && c3.detail.services));
ok(!!c3.detail && c3.detail.commands && c3.detail.commands.registered === 0 && c3.detail.commands.expected === 7,
  "C03 命令注册计数如实为 0/7（expected 来自插件 intend 清单，不假报成功）", JSON.stringify(c3.detail && c3.detail.commands));
ok(!!c3.detail && c3.detail.tools && c3.detail.tools.registered >= 4,
  "C03 commands 缺失不影响其它能力（工具仍注册 >=4）", JSON.stringify(c3.detail && c3.detail.tools));
ok((fx3.captured.injected || []).some((x) => String(x) === "commands"), "C03 可选注入声明仍被调用（commands 进 inject 清单）", JSON.stringify(fx3.captured.injected));

// ══════════════ C04 skills 缺失：可选注入 → 正常加载，skills.list 守卫不抛错 ══════════════
const sc4 = mkScenario("c04");
const mod4 = await loadPlugin(sc4);
const fx4 = createFixtureCtx({});
delete fx4.ctx.skills;   // 模拟新宿主移走 skills 服务
let threw4 = null;
try { mod4.default.apply(fx4.ctx, {}); } catch (e) { threw4 = e; }
await sleep(80);
const c4 = readCompat(sc4.MEM);
ok(!threw4, "C04 skills 缺失时插件正常加载", threw4 ? ("throw: " + threw4.message) : "");
ok(!!c4.detail && c4.detail.services && c4.detail.services.skills === "absent",
  "C04 compat 记录 skills:absent", JSON.stringify(c4.detail && c4.detail.services));
let skillsCallThrew = null, skillsVal = null;
try { skillsVal = await mod4.__compatSkillsList(fx4.ctx); } catch (e) { skillsCallThrew = e; }
ok(!skillsCallThrew && Array.isArray(skillsVal) && skillsVal.length === 0,
  "C04 ctx.skills 缺失时 list() 守卫返回空数组、不抛错", JSON.stringify({ threw: skillsCallThrew ? String(skillsCallThrew.message) : null, val: skillsVal }));
ok(!!c4.detail && c4.detail.tools && c4.detail.tools.registered >= 4,
  "C04 skills 缺失不影响工具注册（>=4）", JSON.stringify(c4.detail && c4.detail.tools));

// ══════════════ C01 补充：正常环境 Config 不是 stub（真 schemastery 被动态加载） ══════════════
ok(mod1.__schemasteryMode === "ok" && !!mod1.default.Config, "C01 正常环境 schemastery=\"ok\" 且 Config 存在", String(mod1.__schemasteryMode));

// ══════════════ C07 真机回归：未 inject 的服务读属性会抛（cordis 行为）══════════════
// 真机报错原文（3.5.1 首启日志）：[warn] compat 自检组装失败：cannot get property "settings" without inject
//   ⇒ compat 整条没写进 .monitor.json，排查时完全看不到自检结果。
// 夹具必须复现 cordis 这条语义：**只有 settings 读取抛错**，其它照常，断言 compat 仍能组装并落盘。
{
  console.log("\n=== C07 未 inject 的服务读属性抛错时，compat 仍须组装成功 ===");
  const sc7 = mkScenario("c07");
  const mod7 = await loadPlugin(sc7);
  const fx7 = createFixtureCtx({});
  const throwingCtx = new Proxy(fx7.ctx, {
    get(t, prop, recv) {
      if (prop === "settings") throw new Error('cannot get property "settings" without inject');
      return Reflect.get(t, prop, recv);
    },
  });
  let threw7 = null;
  try { mod7.default.apply(throwingCtx, {}); } catch (e) { threw7 = e; }
  await sleep(120);
  ok(!threw7, "C07 settings 读取抛错时 apply 不抛（自检自身必须容错）", threw7 ? String(threw7.message) : "");
  const c7 = readCompat(sc7.MEM);
  ok(c7.count >= 1 && !!c7.detail, "C07 compat 仍写入 .monitor.json（不会再整条丢失）", JSON.stringify({ count: c7.count, error: c7.error }));
  ok(!!c7.detail && c7.detail.services && (c7.detail.services.settings === "absent" || c7.detail.services.settings === "ok"),
    "C07 services.settings 有确定值（absent/ok），不是异常", JSON.stringify(c7.detail && c7.detail.services));
  ok(!!c7.detail && Array.isArray(c7.detail.injectHard) && c7.detail.injectHard.length >= 2,
    "C07 injectHard 仍能派生（safeGet 兜住抛错的属性）", JSON.stringify(c7.detail && c7.detail.injectHard));
  // 常驻字段：events 环形裁剪后仍可读（Lead 2026-10-30）
  let topCompat = null;
  try { topCompat = JSON.parse(fs.readFileSync(path.join(sc7.MEM, ".monitor.json"), "utf8")).compat; } catch (e) {}
  ok(!!topCompat && topCompat.version === 1, "C07 .monitor.json 顶层 compat 常驻字段存在（不受 events 2000 条裁剪影响）", topCompat ? JSON.stringify({ version: topCompat.version, selfFp: topCompat.selfFp }) : "null");
  try { mod7.__topicdb && mod7.__topicdb.close && mod7.__topicdb.close(); } catch (e) {}
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
if (d1) console.log("C01 compat 一行原文：compat: " + JSON.stringify(d1));
console.log("C02 实测：" + (mod2 && mod2.__schemasteryMode === "stub" ? "schemastery 强制解析失败 ⇒ stub 降级、插件照常加载并写 compat" : "(未验证)"));
console.log("C03 实测：" + (c3.detail && c3.detail.services.commands === "absent" ? "commands 缺失 ⇒ absent、命令 0/" + c3.detail.commands.expected + "、工具 " + c3.detail.tools.registered : "(未验证)"));
console.log("C04 实测：" + (c4.detail && c4.detail.services.skills === "absent" ? "skills 缺失 ⇒ absent、skills.list 守卫 → []、工具 " + c4.detail.tools.registered : "(未验证)"));
for (const c of cleanups) c();
try { mod1.__topicdb && mod1.__topicdb.close && mod1.__topicdb.close(); } catch (e) {}
try { mod3.__topicdb && mod3.__topicdb.close && mod3.__topicdb.close(); } catch (e) {}
try { mod4.__topicdb && mod4.__topicdb.close && mod4.__topicdb.close(); } catch (e) {}
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
