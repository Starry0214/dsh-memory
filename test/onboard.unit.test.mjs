// v2.3.0 单元测试：记忆初始化引导 + 升级检查的纯逻辑区（index.js 里 ONBOARD marker 包着的那段）。
// 跑法：node test/onboard.unit.test.mjs（零依赖，只用 node:assert / node:fs）。
// 与 test/patch-merge.tests.ps1 同一套路：按 marker 抽出发货代码，测的就是真代码，不是副本。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");
const a = src.indexOf("// >>> ONBOARD BEGIN");
const b = src.indexOf("// <<< ONBOARD END");
assert.ok(a > 0 && b > a, "index.js 里必须成对存在 ONBOARD marker");
const region = src.slice(a, b);
const api = new Function(region +
  "\nreturn { ONBOARD_MIN_CONTENT_BYTES, ONBOARD_DAY_MS, UPDATE_TIMEOUT_MS, detectMemoryState, ensureMemorySkeleton," +
  " compareVersions, shouldRemind, buildInitGuideText, buildUpdateNoticeText, fetchRemoteVersion," +
  " defaultOnboardState, mergeOnboardState, decideOnboardActions };")();

let passed = 0;
let failed = 0;
function report(name, err) {
  if (err) { failed++; console.log("  FAIL  " + name + "   " + (err.message || err)); }
  else { passed++; console.log("  PASS  " + name); }
}
function ts(name, fn) { try { fn(); report(name); } catch (e) { report(name, e); } }
async function ta(name, fn) { try { await fn(); report(name); } catch (e) { report(name, e); } }

// 假文件系统：只实现被测函数用到的三个方法
function makeFs(files, dirs) {
  const F = new Map(Object.entries(files || {}));
  const D = new Set(dirs || []);
  return {
    F,
    D,
    existsSync: (p) => F.has(p) || D.has(p),
    statSync: (p) => ({ isFile: () => F.has(p), size: F.has(p) ? F.get(p).length : 0 }),
    mkdirSync: (p) => { D.add(p); },
  };
}
const ROOT = "/home/u/.dsh/memory";
const AGENTS = "/home/u/.dsh/AGENTS.md";
const BIG = "# 全局记忆" + "x".repeat(400);
const IDX = "# 记忆索引" + "- 主题 → 文件.md（描述）".repeat(3);
const ALL_DIRS = [ROOT, ROOT + "/sessions", ROOT + "/projects", ROOT + "/tools", ROOT + "/knowledge"];

console.log("detectMemoryState：新装/半套/就绪三态");
ts("全新用户（空目录）→ uninitialized", () => {
  const s = api.detectMemoryState(makeFs({}, [ROOT]), ROOT);
  assert.equal(s.status, "uninitialized");
  assert.equal(s.missingDirs.length, 4);
  assert.equal(s.hasAgents, false);
  assert.equal(s.agentsPath, AGENTS);
});
ts("只有空 global/index 文件 → 仍算 uninitialized", () => {
  const f = makeFs({ [ROOT + "/global.md"]: "", [ROOT + "/index.md"]: "" }, ALL_DIRS);
  assert.equal(api.detectMemoryState(f, ROOT).status, "uninitialized");
});
ts("内容齐、缺目录/缺 AGENTS.md → partial", () => {
  const f = makeFs({ [ROOT + "/global.md"]: BIG, [ROOT + "/index.md"]: IDX, [AGENTS]: "# 协议" }, [ROOT]);
  const s = api.detectMemoryState(f, ROOT);
  assert.equal(s.status, "partial");
  assert.ok(s.missingDirs.includes("sessions"));
});
ts("内容齐、有 AGENTS.md、缺协议 → partial（提示补协议）", () => {
  const f = makeFs({ [ROOT + "/global.md"]: BIG, [ROOT + "/index.md"]: IDX }, ALL_DIRS);
  const s = api.detectMemoryState(f, ROOT);
  assert.equal(s.status, "partial");
  assert.equal(s.hasAgents, false);
});
ts("齐活 → ready", () => {
  const f = makeFs({ [ROOT + "/global.md"]: BIG, [ROOT + "/index.md"]: IDX, [AGENTS]: "# 协议" }, ALL_DIRS);
  const s = api.detectMemoryState(f, ROOT);
  assert.equal(s.status, "ready");
  assert.equal(s.missingDirs.length, 0);
});
ts("fs 抛异常也不炸（按缺失处理）", () => {
  const boom = { existsSync() { throw new Error("EACCES"); }, statSync() { throw new Error("EACCES"); }, mkdirSync() { throw new Error("EACCES"); } };
  const s = api.detectMemoryState(boom, ROOT);
  assert.ok(s.status === "uninitialized" || s.status === "partial");
});

console.log("");
console.log("ensureMemorySkeleton：只建目录，绝不写内容");
ts("补齐 4 个子目录", () => {
  const f = makeFs({}, [ROOT]);
  const made = api.ensureMemorySkeleton(f, ROOT).sort();
  assert.deepEqual(made, ["knowledge", "projects", "sessions", "tools"]);
  assert.equal(f.F.size, 0);
});
ts("第二次运行零副作用（幂等）", () => {
  const f = makeFs({}, [ROOT]);
  api.ensureMemorySkeleton(f, ROOT);
  assert.deepEqual(api.ensureMemorySkeleton(f, ROOT), []);
});

console.log("");
console.log("compareVersions / shouldRemind");
ts("版本比较：进位、v 前缀、短版本、空值", () => {
  assert.equal(api.compareVersions("2.3.0", "2.10.0"), -1);
  assert.equal(api.compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(api.compareVersions("v2.3.0", "2.3.0"), 0);
  assert.equal(api.compareVersions("2.3", "2.3.0"), 0);
  assert.equal(api.compareVersions("", "0.0.1"), -1);
});
ts("节流：首次必提、一天一次、snooze 优先", () => {
  const now = 1000000000000;
  const day = api.ONBOARD_DAY_MS;
  assert.equal(api.shouldRemind(now, 0, day, 0), true);
  assert.equal(api.shouldRemind(now, now - 3600000, day, 0), false);
  assert.equal(api.shouldRemind(now, now - day - 1, day, 0), true);
  assert.equal(api.shouldRemind(now, 0, day, now + 1000), false);
});

console.log("");
console.log("引导/升级文案");
ts("初始化引导含采集清单与落盘规范", () => {
  const s = { status: "uninitialized", bytesGlobal: 0, bytesIndex: 0, missingDirs: ["sessions"], hasAgents: false, agentsPath: AGENTS };
  const txt = api.buildInitGuideText(s, { root: ROOT });
  for (const need of ["ask_user_question", "/global.md", "/index.md", ROOT, "AGENTS.md", "sandbox_permissions", "下一个新会话", "sessions/YYYY-MM-DD.md"]) {
    assert.ok(txt.includes(need), "缺关键指引：" + need);
  }
  assert.ok(txt.startsWith("<system-reminder>"));
  assert.ok(txt.endsWith("</system-reminder>"));
});
ts("AGENTS.md 已存在时不再提示补协议", () => {
  const s = { status: "partial", bytesGlobal: 400, bytesIndex: 60, missingDirs: [], hasAgents: true, agentsPath: AGENTS };
  assert.ok(!api.buildInitGuideText(s, { root: ROOT }).includes("没有读写协议"));
});
ts("升级提醒含命令、重启与关闭出口", () => {
  const txt = api.buildUpdateNoticeText("2.3.0", "2.4.1", {});
  assert.ok(txt.includes("v2.4.1") && txt.includes("v2.3.0"));
  assert.ok(txt.includes("install.ps1"));
  assert.ok(txt.includes("重启"));
  assert.ok(txt.includes("检查新版"));
});

console.log("");
console.log("fetchRemoteVersion：离线/内网/坏数据一律静默");
await ta("正常返回版本号", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: async () => ({ ok: true, status: 200, text: async () => "2.4.1" }), url: "x", timeoutMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.remote, "2.4.1");
});
await ta("正文混排也能抓到版本", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: async () => ({ ok: true, status: 200, text: async () => "dsh-memory 2.9.10 beta" }), url: "x", timeoutMs: 500 });
  assert.equal(r.remote, "2.9.10");
});
await ta("HTTP 404 → http-404", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: async () => ({ ok: false, status: 404, text: async () => "" }), url: "x", timeoutMs: 500 });
  assert.equal(r.error, "http-404");
});
await ta("无 fetch（老运行时）→ no-fetch", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: null, url: "x", timeoutMs: 500 });
  assert.equal(r.error, "no-fetch");
});
await ta("正文无版本 → bad-body", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: async () => ({ ok: true, status: 200, text: async () => "hello" }), url: "x", timeoutMs: 500 });
  assert.equal(r.error, "bad-body");
});
await ta("请求卡死也必须超时返回", async () => {
  const t0 = Date.now();
  const r = await api.fetchRemoteVersion({
    fetchish: (url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); });
    }),
    url: "x", timeoutMs: 120,
  });
  assert.equal(r.error, "timeout");
  assert.ok(Date.now() - t0 < 2000, "超时不该拖死：" + (Date.now() - t0) + "ms");
});
await ta("fetch 抛异常（DNS 失败等）也返回结构体", async () => {
  const r = await api.fetchRemoteVersion({ fetchish: async () => { throw new Error("ENOTFOUND"); }, url: "x", timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);
});

console.log("");
console.log("decideOnboardActions：该不该提");
const now = 1700000000000;
const DAY = api.ONBOARD_DAY_MS;
const ob = () => api.mergeOnboardState(null);
const withUp = (latest, notifiedAt) => { const s = ob(); s.update.latest = latest; s.update.notifiedAt = notifiedAt; return s; };
const memNew = { status: "uninitialized", bytesGlobal: 0, bytesIndex: 0, missingDirs: [], hasAgents: false, agentsPath: "" };
const memReady = { status: "ready", bytesGlobal: 900, bytesIndex: 300, missingDirs: [], hasAgents: true, agentsPath: "" };
ts("新装首次会话 → 只提初始化引导", () => {
  const x = api.decideOnboardActions(memNew, ob(), now, "2.3.0");
  assert.equal(x.needGuide, true);
  assert.equal(x.needUpdateNotice, false);
});
ts("一小时内又开一个会话 → 不再提", () => {
  const s = ob(); s.initPromptedAt = now - 3600000;
  assert.equal(api.decideOnboardActions(memNew, s, now, "2.3.0").needGuide, false);
});
ts("用户说回头再说 → snooze 期内不提", () => {
  const s = ob(); s.snoozeUntil = now + 60000;
  assert.equal(api.decideOnboardActions(memNew, s, now, "2.3.0").needGuide, false);
});
ts("昨天提过、今天仍未初始化 → 再提一次", () => {
  const s = ob(); s.initPromptedAt = now - DAY - 1000;
  assert.equal(api.decideOnboardActions(memNew, s, now, "2.3.0").needGuide, true);
});
ts("就绪 + 有新版 → 提升级", () => {
  const x = api.decideOnboardActions(memReady, withUp("9.9.9", 0), now, "2.3.0");
  assert.equal(x.needGuide, false);
  assert.equal(x.needUpdateNotice, true);
  assert.equal(x.latest, "9.9.9");
});
ts("就绪 + 版本一致 → 啥也不提", () => {
  const x = api.decideOnboardActions(memReady, withUp("2.3.0", 0), now, "2.3.0");
  assert.equal(x.needGuide, false);
  assert.equal(x.needUpdateNotice, false);
});
ts("新版今天已提过 → 不再重复", () => {
  assert.equal(api.decideOnboardActions(memReady, withUp("9.9.9", now - 60000), now, "2.3.0").needUpdateNotice, false);
});
ts("仍未初始化 + 有新版 → 两条一起提", () => {
  const x = api.decideOnboardActions(memNew, withUp("9.9.9", 0), now, "2.3.0");
  assert.equal(x.needGuide, true);
  assert.equal(x.needUpdateNotice, true);
});

console.log("");
console.log("状态文件容错（老文件/坏 JSON/字段漂移）");
ts("各种脏输入一律回退默认结构", () => {
  for (const junk of [null, undefined, {}, "x", 42, [], { initPromptedAt: "昨天" }, { update: null }, { update: { latest: 7 } }]) {
    const s = api.mergeOnboardState(junk);
    assert.equal(typeof s.initPromptedAt, "number");
    assert.equal(typeof s.snoozeUntil, "number");
    assert.equal(typeof s.ready, "boolean");
    assert.equal(typeof s.update.checkedAt, "number");
    assert.equal(typeof s.update.latest, "string");
  }
});
ts("完整状态原样读回", () => {
  const src2 = { initPromptedAt: 5, snoozeUntil: 9, ready: true, update: { checkedAt: 7, latest: "2.4.0", notifiedAt: 8, error: "timeout" } };
  assert.deepEqual(api.mergeOnboardState(src2), src2);
});
ts("默认状态自带 update 子结构", () => {
  const d = api.defaultOnboardState();
  assert.deepEqual(d.update, { checkedAt: 0, latest: "", notifiedAt: 0, error: "" });
});

console.log("");
console.log(failed ? "onboard 单元测试：" + failed + " 项失败 / " + passed + " 项通过" : "onboard 单元测试全部通过（" + passed + " 项）");
process.exitCode = failed ? 1 : 0;
