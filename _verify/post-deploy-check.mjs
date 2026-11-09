#!/usr/bin/env node
/**
 * post-deploy-check.mjs —— dsh-memory 插件「P0+P0.1+P1 部署后真机验证」一键检查
 *
 * 用法：
 *   node _verify/post-deploy-check.mjs            # 最近 3 个会话
 *   node _verify/post-deploy-check.mjs --all      # 全部会话（慢）
 *   node _verify/post-deploy-check.mjs --json     # 机器可读
 *
 * 判定口径（重要）：
 *   - 部署态：运行副本 sha256 == E2B3D10A…（否则 FAIL：未部署/被覆盖）
 *   - 重启态：存在「会话创建时间 > 部署时间」的会话（否则 WAIT：DSH 还没重启）
 *   - G2    ：部署后会话的注入面含检查点正文（文案含「检查点（目标与下一步」或「会话检查点（主题库」）
 *   - G2反证：旧代码特征「（非当日，仅通知」出现在**新会话** → FAIL（说明跑的仍是旧代码）
 *   - P1    ：部署后会话含「【外部事实包（dsh-memory · compaction」
 *   - 队列  ：.integrate.json 有 intentRetry 字段属 INFO（成功路径不写该字段，缺失不代表坏）
 *   - 熔断  ：.monitor.json 最近 intent 事件出现 retry-breaker → FAIL（系统性失败信号）
 *
 * 只读：解压到内存、状态文件只读，不写任何东西。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const EXPECTED_SHA = "C87FC6780AD248FFAAD74E16C08D3623401A1EAE33B2D2EFF1942D6E13D5639D";
const DEPLOY_AT = Date.parse("2026-11-02T16:10:00+08:00");   // P3-1 三阈值写入 + T5/T6（前序：12:27 P4 / 14:47 P3 / 15:06 P2.5 / 15:23 P2.5.1）
const RUN_COPY = path.join(os.homedir(), ".dsh", "profiles", "web", "plugins", "memory", "index.js");
const SESS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const MEM_DIR = path.join(os.homedir(), ".dsh", "memory");

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has("--json");
const ALL = args.has("--all");

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!JSON_OUT) {
    const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "WAIT";
    console.log(`  [${mark}] ${id}${detail ? " — " + detail : ""}`);
  }
}
const sha256File = (p) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();
  } catch {
    return null;
  }
};

// ---------- 1) 部署态 ----------
if (!JSON_OUT) console.log("\n=== 1) 部署态 ===");
const runSha = sha256File(RUN_COPY);
const deployed = runSha === EXPECTED_SHA;
record("run-copy-sha", deployed, runSha ? runSha.slice(0, 16) + "…" : "读取失败：" + RUN_COPY);

// ---------- 1b) 模块可加载（离线冒烟：不 apply，只验证依赖解析/ESM 语法/导出接线）----------
let importOk = false;
let importDetail = "";
try {
  const m = await import(pathToFileURL(RUN_COPY).href);
  const keys = Object.keys(m);
  importOk = true;
  importDetail =
    `exports=${keys.length}` +
    ` p0Hooks=${keys.includes("__p0Hooks") ? "有" : "无"}` +
    ` p1Hooks=${keys.includes("__p1Hooks") ? "有" : "无"}` +
    ` buildExternalFacts=${keys.includes("__buildExternalFacts") ? "有" : "无"}`;
} catch (e) {
  importDetail = "加载失败：" + String((e && e.message) || e).split("\n")[0];
}
record("plugin-import-smoke", importOk ? true : false, importDetail);

// ---------- 1c) P3 模块同目录就位（index.js 静态 import；缺一个 = 插件加载失败）----------
const MEM_PLUGIN_DIR = path.dirname(RUN_COPY);
const P3_MODULES = ["p3-cost.js", "p3-triggers.js", "p3-readside.js", "p25-topics.js"];
const missingMods = P3_MODULES.filter((f) => !fs.existsSync(path.join(MEM_PLUGIN_DIR, f)));
record(
  "p3-modules-present",
  missingMods.length === 0 ? true : false,
  missingMods.length ? "缺：" + missingMods.join(",") : P3_MODULES.length + " 个齐全"
);

// ---------- 2) 会话日志清单 ----------
function listSessionLogs() {
  const out = [];
  if (!fs.existsSync(SESS_ROOT)) return out;
  for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(SESS_ROOT, ws.name);
    let sids = [];
    try {
      sids = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sid of sids) {
      if (!sid.isDirectory()) continue;
      const dir = path.join(wsDir, sid.name);
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/^session.*\.jsonl\.zstd$/.test(f)) continue;
        const p = path.join(dir, f);
        try {
          out.push({ ws: ws.name, sid: sid.name, path: p, mtime: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function decompress(l) {
  try {
    return zlib.zstdDecompressSync(fs.readFileSync(l.path)).toString("utf8");
  } catch {
    return null;
  }
}

function sessionCreatedAt(txt) {
  if (!txt) return null;
  const first = txt.split("\n", 1)[0];
  try {
    const j = JSON.parse(first);
    if (j && j.type === "session" && typeof j.createdAt === "number") return { at: j.createdAt, depth: Number(j.delegationDepth || 0) };
  } catch {}
  return null;
}

const logs = listSessionLogs();
// 部署后创建的会话（重启后才有）
const fresh = [];
for (const l of logs) {
  const t = sessionCreatedAt(decompress(l));
  if (t && t > DEPLOY_AT) fresh.push({ ...l, createdAt: t });
}
const picked = ALL ? logs : (fresh.length ? fresh.slice(0, 3) : logs.slice(0, 3));

if (!JSON_OUT) {
  console.log(`\n=== 2) 会话日志（共 ${logs.length}，部署后新建 ${fresh.length}，本次检查 ${picked.length}）===`);
  if (fresh.length === 0) console.log("  （尚无部署后新建会话 → 大概率还没重启 DSH）");
}
record(
  "post-deploy-session",
  fresh.length > 0 ? true : null,
  fresh.length ? `${fresh.length} 个新会话，最新 ${fresh[0].sid.slice(0, 8)}（${new Date(fresh[0].createdAt).toLocaleString("zh-CN")}）` : "无部署后新会话 —— 请重启 DSH 后开新会话",
);

// ---------- 3) 扫描注入面 ----------
function scanLog(txt) {
  const res = { compactions: 0, userMsgs: 0, g2Checkpoint: false, g2StopNotice: false, p1Facts: false, p2Sections: false, p4Rehydrate: false, samples: [] };
  for (const ln of txt.split("\n")) {
    if (!ln) continue;
    let j;
    try {
      j = JSON.parse(ln);
    } catch {
      continue;
    }
    if (j.type === "compaction/summary") res.compactions++;
    if (j.type !== "user/message") continue;
    const msg = j.data || {};
    if (!Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (!text) continue;
    res.userMsgs++;
    if (text.includes("检查点（目标与下一步") || text.includes("会话检查点（主题库")) res.g2Checkpoint = true;
    if (text.includes("（非当日，仅通知")) res.g2StopNotice = true;
    const isCompactSummary = text.startsWith("This is an automatically generated checkpoint") || text.includes("<compacted-summary>") || text.includes("## Primary Request and Intent");
    if (!isCompactSummary && text.includes("【外部事实包（dsh-memory · compaction")) res.p1Facts = true;
    // P2：8 节检查点特征（本次目标 + 当前状态 + 未决问题 同块出现）
    if (!isCompactSummary && text.includes("## 本次目标") && text.includes("## 当前状态") && text.includes("## 未决问题")) res.p2Sections = true;
    // P4-R2：压缩后记忆重灌段（检查点续接/项目/画像三选一即算）
    if (!isCompactSummary && text.includes("【压缩后记忆重灌（dsh-memory）】")) res.p4Rehydrate = true;
    if (res.samples.length < 3 && (text.includes("最近一次会话压缩点") || text.includes("【外部事实包"))) {
      res.samples.push(text.slice(0, 200).replace(/\n/g, " "));
    }
  }
  return res;
}

let anyG2 = false;
let anyP1 = false;
let newSessionStopNotice = false;
if (!JSON_OUT) console.log("\n=== 3) 注入面扫描 ===");
for (const l of picked) {
  const txt = decompress(l);
  if (!txt) {
    if (!JSON_OUT) console.log(`  ${l.sid.slice(0, 8)}: 解压失败`);
    continue;
  }
  const s = scanLog(txt);
  const tag = `${l.sid.slice(0, 8)}${fresh.includes(l) ? "(新)" : "(旧)"}`;
  if (s.g2Checkpoint) anyG2 = true;
  if (s.p1Facts) anyP1 = true;
  if (fresh.includes(l) && s.g2StopNotice && !s.g2Checkpoint) newSessionStopNotice = true;
  if (!JSON_OUT) {
    console.log(
      `  ${tag}: compactions=${s.compactions} 注入消息=${s.userMsgs} ` +
        `G2正文=${s.g2Checkpoint ? "有" : "无"} P1事实包=${s.p1Facts ? "有" : "无"} 旧「停在」文案=${s.g2StopNotice ? "有" : "无"}`,
    );
    for (const x of s.samples) console.log(`      · ${x}`);
  }
}

record(
  "G2-checkpoint-in-injection",
  anyG2 ? true : fresh.length ? false : null,
  anyG2 ? "注入面已含检查点正文（G2 打通）" : fresh.length ? "新会话仍未出现检查点正文" : "需重启后开新会话（且该会话触发过一次压缩/或有历史库检查点）",
);
record(
  "G2-no-stale-notice",
  newSessionStopNotice ? false : fresh.length ? true : null,
  newSessionStopNotice ? "新会话仍出现旧代码「停在 YYYY-MM-DD（非当日，仅通知）」→ 可能没重启或加载了旧代码" : "无旧代码特征",
);
record(
  "P1-external-facts",
  anyP1 ? true : fresh.length ? false : null,
  anyP1 ? "注入面已含【外部事实包】" : fresh.length ? "新会话未出现外部事实包（需在该会话触发一次压缩）" : "需重启后压缩一次",
);

// ---------- 3b) P4-R2 记忆重灌 + P4-A writer 成本 ----------
let anyRehydrate = false;
for (const l of picked) {
  const txt = decompress(l);
  if (!txt) continue;
  if (scanLog(txt).p4Rehydrate) anyRehydrate = true;
}
record(
  "P4-r2-rehydrate",
  anyRehydrate ? true : fresh.length ? false : null,
  anyRehydrate ? "注入面已含【压缩后记忆重灌】（旧会话压缩后补回检查点/项目/画像）" : "需在部署后压缩一次（重启后 /compact 或自然压缩）",
);

// writer 子代理工具数：325 → 目标 ≤3（登记在 preset 生效后）；读 request/header.tools.length
function scanWriterCost() {
  const found = [];
  // 只扫最近 120 个会话（mtime 倒序）：部署后新建的 writer 必然在最前；全量扫 2600+ 会话会卡 1 分钟以上。
  const logsByMtime = logs.slice(0, 120);
  for (const l of logsByMtime) {
    if (found.length >= 3) break;
    const txt = decompress(l);
    if (!txt) continue;
    // 只看部署后新建的 writer（重启前的老 writer 必然是 325，会误报 FAIL）
    const created = sessionCreatedAt(txt);
    if (!created || !(created > DEPLOY_AT)) continue;
    let label = "";
    let tools = null;
    let at = 0;
    for (const ln of txt.split("\n")) {
      if (!label && ln.includes('"subagent/descriptor"')) {
        try { const j = JSON.parse(ln); label = String((j.data && j.data.label) || ""); at = Number(j.time || 0); } catch {}
      }
      if (ln.includes('"request/header"')) {
        try { const j = JSON.parse(ln); const h = j.data && j.data.header; tools = Array.isArray(h && h.tools) ? h.tools.length : null; } catch {}
        break;
      }
    }
    if (label && /dsh-memory-压缩/.test(label) && tools !== null) found.push({ sid: l.sid.slice(0, 8), label, tools, at });
  }
  return found;
}
try {
  const writers = scanWriterCost();
  if (!JSON_OUT) {
    console.log("\n=== 3b) P4 writer 子代理成本 ===");
    if (!writers.length) console.log("  未找到 writer 子代理日志（需先触发一次压缩）");
    for (const w of writers) console.log(`  ${w.sid} ${w.label.slice(0, 46)} tools=${w.tools}`);
  }
  if (writers.length) {
    const best = writers.reduce((a, b) => (a.tools <= b.tools ? a : b));
    record("P4-writer-tools", best.tools <= 3 ? true : (deployed ? false : null),
      `最新 writer tools=${best.tools}（目标 ≤3；>3 说明 preset 未生效，基线 325）`);
  } else {
    record("P4-writer-tools", null, "无 writer 日志（需压缩一次）");
  }
} catch (eP4) {
  record("P4-writer-tools", null, "扫描失败：" + (eP4 && eP4.message));
}

// ---------- 4) 状态文件 ----------
if (!JSON_OUT) console.log("\n=== 4) 状态文件 ===");
try {
  const integ = JSON.parse(fs.readFileSync(path.join(MEM_DIR, ".integrate.json"), "utf8"));
  const hasQueue = Object.prototype.hasOwnProperty.call(integ, "intentRetry");
  const q = Array.isArray(integ.intentRetry) ? integ.intentRetry : [];
  if (!JSON_OUT) console.log(`  intentRetry 字段：${hasQueue ? "有（entries=" + q.length + "）" : "无（成功路径不写该字段，缺失正常）"}`);
  const facts = integ.recentSessionFacts;
  record(
    "recentSessionFacts",
    facts ? true : fresh.length ? false : null,
    facts ? `at=${new Date(facts.at || 0).toLocaleString("zh-CN")} projKey=${facts.projKey || "(空)"}` : "尚无快照（需重启后压缩一次）",
  );
} catch (e) {
  if (!JSON_OUT) console.log("  .integrate.json 读取失败：" + (e && e.message));
}

try {
  const mon = JSON.parse(fs.readFileSync(path.join(MEM_DIR, ".monitor.json"), "utf8"));
  const ev = (mon.events || []).filter((e) => e && e.domain === "intent").slice(-10);
  const breaker = ev.filter((e) => String(e.detail || "").includes("retry-breaker"));
  record("monitor-retry-breaker", breaker.length === 0, breaker.length ? `${breaker.length} 条熔断` : "无熔断记录");
  if (!JSON_OUT) for (const e of ev.slice(-5)) console.log(`      intent: ${e.detail}`);
} catch {}

// ---------- 汇总 ----------
const fails = results.filter((r) => r.ok === false);
const waits = results.filter((r) => r.ok === null);
const passes = results.filter((r) => r.ok === true);
if (JSON_OUT) {
  console.log(JSON.stringify({ expectedSha: EXPECTED_SHA, runSha, results, fails: fails.length, waits: waits.length }, null, 2));
} else {
  console.log("\n=== 汇总 ===");
  console.log(`  PASS=${passes.length}  WAIT=${waits.length}  FAIL=${fails.length}`);
  if (!deployed) console.log("  ⚠️ 运行副本不是期望版本：部署未完成或被覆盖");
  if (fails.some((f) => f.id === "G2-checkpoint-in-injection" && fresh.length))
    console.log("  ❌ 已重启但 G2 未生效：检查是否复制到了正确 profile / 是否真的重启");
  if (fails.length) console.log("  ❌ 有 FAIL 项 → 按 .task/1101-dsh-mimo-survey/09-deploy-executed.md §6 回滚或排查");
  else if (waits.length) console.log("  ⏳ 正常等待态：重启 DSH + 开新会话 + 触发一次压缩后再跑本脚本");
  else console.log("  ✅ 全部通过：P0/P0.1/P1 真机验证完成");
}
process.exit(fails.length ? 1 : 0);



