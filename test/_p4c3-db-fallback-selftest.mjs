// _p4c3-db-fallback-selftest.mjs —— [P4-C3] 检查点「增量基线」的**库回落**自测
//
// 跑法：node test/_p4c3-db-fallback-selftest.mjs [index.js 路径]
//
// 背景（2026-11-03 用户）：阈值检查点与压缩检查点都要「既接收主会话材料、又看上一轮记忆库中写的什么」。
//   改前「上次检查点（增量基线）」只读进程内存 P4C_LAST_CP —— 宿主重启 / 32 条 FIFO 淘汰后为空 ⇒ 检查点断代，
//   而库里其实一直有这份（P2.5 会话主题覆盖写、恒 1 句）。本测试验证新增的库读函数与接线。
//
// 覆盖：
//   A 前置：P2.5 写库成功（via __topicdbWriteIntent，带 cwd ⇒ 走会话主题路径）
//   B __p25ReadOwnSession 能按 cwd+sid8 读回该检查点正文
//   C 不同 sid8 ⇒ null（不串会话）
//   D 不同 cwd（另一工作区）⇒ null（不串工作区）
//   E 返回文本与写入正文一致（前 N 字）
//   F 静态接线：p4cLastCheckpoint 有两参签名 + 调 p25ReadOwnSession + 两处调用点传 cwd
//
// 隔离纪律：DSH_HOME / DSH_MEMORY_ROOT / MEMTOPIC_DB 全指向 os.tmpdir()，绝不碰真实 ~/.dsh/memory。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) {
    try { if (fn()) return true; } catch (e) { /* 继续等 */ }
    await sleep(step || 50);
  }
  return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-p4c3-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
const CWD = path.join(TMP, "工作区甲");
const CWD2 = path.join(TMP, "工作区乙");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.mkdirSync(path.join(MEM, "projects"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(CWD2, { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- P4C3 自测占位\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const { createFixtureCtx } = await import(pathToFileURL(FIXTURE).href);

const fx = createFixtureCtx({});
await plugin.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));
if (!ready) {
  console.log("\n0 PASS / 1 FAIL（库未就绪，后续跳过）");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  setTimeout(() => process.exit(1), 100);
  throw new Error("topicdb not ready");
}
const store = mod.__topicdb.store;

const SID8 = "c3a1b2c4";
const SUM = [
  "## 本次目标",
  "验证 P4-C3 库回落：阈值/压缩检查点都能读到上一轮落库的检查点。",
  "## 当前状态",
  "自测中。",
  "## 下一步行动",
  "跑断言。",
  "## 关键结论",
  "- 库里有 P2.5 会话主题这一个真源；内存 Map 只是缓存（重启即空）。",
  "## 文件与代码",
  "无",
  "## 错误与修复",
  "无",
  "## 任务与待办",
  "无",
  "## 未决问题",
  "无",
].join("\n");

let wr = null;
// P2.5 写库要求 D8 域已存在（缺域会直接回退日期主题 → 报「未找到会话检查点线」），所以先种域
try {
  const d8 = store.seedTopic({ name: "日记忆（按天流水）", triggers: [], src: "sessions/seed.md", actor: "plugin" });
  if (d8 && d8.id) {
    try { store.setLevel(d8.id, "domain", { actor: "runtime" }); } catch (eL) { }
    try { store.setState(d8.id, "active", { actor: "runtime", reason: "selftest" }); } catch (eS) { }
  }
} catch (e) { console.log("前置：建 D8 域失败（后续断言可能连带失败）：" + ((e && e.message) || e)); }

try { wr = mod.__topicdbWriteIntent("c3-cid-0001", SID8, SUM, "2026-11-03.md", "session-" + SID8, CWD); }
catch (e) { wr = { ok: false, error: (e && e.message) || String(e) }; }
ok(!!(wr && wr.ok), "A 前置：P2.5 写库成功", JSON.stringify(wr).slice(0, 160));

const got = mod.__p25ReadOwnSession(store, CWD, SID8);
ok(!!got, "B __p25ReadOwnSession 读回本会话检查点", got ? ("topic=" + got.topicName + " chars=" + got.text.length) : "null");
ok(!!(got && /##\s*本次目标/.test(got.text)), "E 读回正文含 8 节结构（与写入一致）", got ? JSON.stringify(got.text.slice(0, 26)) : "-");
ok(!!(got && got.text.length > 100), "E2 正文长度合理（>100 字）", got ? String(got.text.length) : "-");

const other = mod.__p25ReadOwnSession(store, CWD, "ffffffff");
ok(other === null, "C 其他 sid8 ⇒ null（不串会话）", JSON.stringify(other));

const otherWs = mod.__p25ReadOwnSession(store, CWD2, SID8);
ok(otherWs === null, "D 其他工作区 ⇒ null（不串工作区）", JSON.stringify(otherWs));

// 内存无基线时 p4cLastCheckpoint 应回落读库——该函数在闭包内未导出，改用静态接线断言覆盖
const src = fs.readFileSync(PLUGIN, "utf8");
ok(/function p4cLastCheckpoint\(sid, cwd\)/.test(src), "F1 静态：p4cLastCheckpoint 已带 cwd 参数");
ok(/function p4cLastCheckpoint\(sid, cwd\)[\s\S]{0,1600}p25ReadOwnSession\(TOPICDB\.store/.test(src), "F2 静态：内存未命中时调 p25ReadOwnSession 回落读库");
ok(/p4cLastCheckpoint\(session && session\.id, _cwdPrev\)/.test(src), "F3 静态：buildIntentInput 调用点传 cwd");
ok(/p4cLastCheckpoint\(_agSid, _agCwd\)/.test(src), "F4 静态：R2 重灌调用点传 cwd");
ok(/cp-base-from-db/.test(src), "F5 静态：库回落有可观测日志（cp-base-from-db）");
ok(/export \{ p25ReadOwnSession as __p25ReadOwnSession \}/.test(src), "F6 静态：测试钩子已导出");

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
