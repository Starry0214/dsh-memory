#!/usr/bin/env node
/**
 * dsh-memory · P2.5 会话记忆迁移脚本（**默认 dry-run**，`--apply` 才写库）
 * ============================================================================
 * 做什么：
 *   把历史「日期主题」（D8 线「会话检查点」下的 `YYYY-MM-DD`）里正文带
 *   `压缩 <cid8> · sid <sid8>` marker 的检查点句，**只新增**地落到 P2.5 新结构：
 *     线 `<会话检查点·<wsKey>>`（每个工作区一条 project 级线，按需新建）
 *       └─ detail 主题 `<wsKey>/<sid8>`（每个会话一条，覆盖更新、恒 1 句）
 *
 * 绝对不做（可回滚的硬保证）：
 *   · 不删除、不改写任何**原有句子**（旧日期主题逐字保留）；
 *   · 不移动/合并/改状态已有主题（除新建的线/会话主题外）；
 *   · 不用 `createTopic`（治理门控会拦结构性命名）——用 `seedTopic`（导入通道），与
 *     index.js `topicDbWriteIntentCheckpoint` 建日期主题的口径一致；
 *   · 全部写入在**一个事务**里（失败整体回滚），并在写入前自动 `VACUUM INTO` 备份。
 *
 * 用法：
 *   node _verify/p25-migrate.mjs                     # dry-run（默认）：只打印计划，不写库
 *   node _verify/p25-migrate.mjs --json              # dry-run + 打印完整 JSON 计划
 *   node _verify/p25-migrate.mjs --apply             # 真正写库（单事务 + 自动备份）
 *   node _verify/p25-migrate.mjs --no-hints          # 不读 workspace.json（wsKey 只靠正文启发式）
 *   node _verify/p25-migrate.mjs --db <mem.db>       # 指定库（测试/演练用副本）
 *   node _verify/p25-migrate.mjs --workspace-json <file>
 *   node _verify/p25-migrate.mjs --verbose --limit 40
 *
 * wsKey 从哪来（优先级从高到低）：
 *   ① `~/.dsh/storages/workspace.json` 的 `workspaces[].sessionIds`（sid → 工作区 path，最准；
 *      `--no-hints` 关掉）→ `p25-topics.normalizeWorkspace(path)`；
 *   ② 句子里显式 `cwd:` / `工作目录:` 标记；
 *   ③ 正文里**≥2 条**盘符路径的公共前缀恰好是「盘符 + 2 级目录」（保守启发式）；
 *   ④ 都拿不到 → `unknown`（在 `会话检查点·unknown` 线下建 `unknown/<sid8>`，报告里单列）。
 *
 * 依赖：`node:sqlite`（Node ≥ 22.5，本机 24.x）；--apply 额外 import 插件同目录的
 * `memtopic/src/memory-store.mjs`（零第三方依赖，与插件运行时同一份实现）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as P25 from "../p25-topics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, ".dsh", "memory", ".memtopic", "mem.db");
const DEFAULT_WS_JSON = path.join(HOME, ".dsh", "storages", "workspace.json");

// ───────────────────────────── CLI ─────────────────────────────

function usage() {
  return [
    "P2.5 会话记忆迁移（默认 dry-run；--apply 才写库）",
    "",
    "  node _verify/p25-migrate.mjs [选项]",
    "",
    "选项：",
    "  --apply                 写库（单事务 + 写前 VACUUM INTO 备份）",
    "  --json                  dry-run 时打印完整 JSON 计划",
    "  --no-hints              不读 workspace.json（wsKey 只靠正文启发式）",
    "  --db <path>             指定 mem.db（默认 ~/.dsh/memory/.memtopic/mem.db）",
    "  --workspace-json <p>    指定 workspace.json（默认 ~/.dsh/storages/workspace.json）",
    "  --limit <n>             明细最多打印 n 条（默认 20）",
    "  --verbose               打印每条 skipped",
    "  --help                  本帮助",
  ].join("\n");
}

function parseArgs(argv) {
  const o = { apply: false, json: false, hints: true, db: DEFAULT_DB, wsJson: DEFAULT_WS_JSON, limit: 20, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--json") o.json = true;
    else if (a === "--no-hints") o.hints = false;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--db") { o.db = String(argv[++i] || ""); if (!o.db) throw new Error("--db 需要参数"); }
    else if (a === "--workspace-json") { o.wsJson = String(argv[++i] || ""); if (!o.wsJson) throw new Error("--workspace-json 需要参数"); }
    else if (a === "--limit") { o.limit = Math.max(1, parseInt(argv[++i], 10) || 20); }
    else if (/^--db=/.test(a)) o.db = a.slice(5);
    else if (/^--workspace-json=/.test(a)) o.wsJson = a.slice(17);
    else if (/^--limit=/.test(a)) o.limit = Math.max(1, parseInt(a.slice(8), 10) || 20);
    else throw new Error("未知参数：" + a + "\n\n" + usage());
  }
  return o;
}

// ───────────────────────────── 通用小工具 ─────────────────────────────

function fmtTime(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return "-";
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 与内存库一致的归一化（governance.normalizeName 的本地副本：dry-run 不依赖 memtopic 目录） */
function normName(s) {
  return String(s == null ? "" : s).normalize("NFKC").toLowerCase()
    .replace(/[\s_\-·・,，.。:：/\\()（）\[\]【】]/g, "");
}

function sqlQuote(p) {
  return "'" + String(p).replace(/'/g, "''") + "'";
}

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ensureDirFor(p) {
  const d = path.dirname(p);
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* noop */ }
}

// ───────────────────────────── 读库（只读） ─────────────────────────────

/**
 * 快照：topics + meta（level:/parent:）+ 目标句子 + 已有会话主题句子。
 * 全程只读（readOnly:true），dry-run 绝不写任何字节。
 */
function readSnapshot(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error("mem.db 不存在：" + dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const topics = db.prepare("SELECT id,name,state,created_at,updated_at FROM topics ORDER BY id").all()
      .map((r) => ({ id: r.id, name: r.name, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at }));
    const meta = new Map();
    for (const r of db.prepare("SELECT key,value FROM meta").all()) meta.set(String(r.key), String(r.value));
    const level = new Map();
    const parent = new Map();
    for (const [k, v] of meta) {
      if (k.startsWith("level:")) level.set(k.slice(6), v);
      else if (k.startsWith("parent:")) parent.set(k.slice(7), v);
    }
    const byId = new Map(topics.map((t) => [t.id, t]));
    const kidsOf = new Map();
    for (const [child, par] of parent) {
      if (!kidsOf.has(par)) kidsOf.set(par, []);
      kidsOf.get(par).push(child);
    }
    // D8 域 + 线（按名字解析，容错历史改名）
    const domain = topics.find((t) => level.get(t.id) === "domain" && normName(t.name) === normName(P25.D8_DOMAIN_NAME))
      || topics.find((t) => level.get(t.id) === "domain" && normName(t.name).includes("日记忆"))
      || null;
    let line = null;
    if (domain) {
      line = (kidsOf.get(domain.id) || []).map((id) => byId.get(id)).filter(Boolean)
        .find((t) => level.get(t.id) === "project" && normName(t.name) === normName(P25.LEGACY_LINE_NAME)) || null;
    }
    if (!line) {
      line = topics.find((t) => level.get(t.id) === "project" && normName(t.name) === normName(P25.LEGACY_LINE_NAME))
        || topics.find((t) => normName(t.name) === normName(P25.LEGACY_LINE_NAME)) || null;
    }
    // 源日期主题：线下的 `YYYY-MM-DD`（line 缺失时退化为全库日期名主题）
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const sourceTopics = (line ? (kidsOf.get(line.id) || []).map((id) => byId.get(id)).filter(Boolean) : topics)
      .filter((t) => dateRe.test(String(t.name || "")))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const sourceTopicIds = sourceTopics.map((t) => t.id);
    const sourceSentences = [];
    for (const ids of chunk(sourceTopicIds, 400)) {
      const rows = db.prepare("SELECT id,topic_id,ord,body,chars,created_at,updated_at,src FROM sentences WHERE topic_id IN (" + placeholders(ids.length) + ") ORDER BY topic_id, ord").all(...ids);
      for (const r of rows) sourceSentences.push({ id: r.id, topicId: r.topic_id, ord: r.ord, body: r.body, chars: r.chars, createdAt: r.created_at, updatedAt: r.updated_at, src: r.src });
    }
    // 已有 P2.5 会话主题（重跑幂等用）
    const existingTopics = topics.filter((t) => P25.isSessionTopicName(t.name));
    const existingSentences = [];
    if (existingTopics.length) {
      const ids = existingTopics.map((t) => t.id);
      for (const part of chunk(ids, 400)) {
        const rows = db.prepare("SELECT id,topic_id,ord,body,chars,created_at,updated_at,src FROM sentences WHERE topic_id IN (" + placeholders(part.length) + ") ORDER BY topic_id, ord").all(...part);
        for (const r of rows) existingSentences.push({ id: r.id, topicId: r.topic_id, ord: r.ord, body: r.body, chars: r.chars, createdAt: r.created_at, updatedAt: r.updated_at, src: r.src });
      }
    }
    const topicCount = topics.length;
    const sentenceCount = db.prepare("SELECT COUNT(*) AS n FROM sentences").get().n;
    return { db, dbPath, topics, byId, level, parent, domain, line, sourceTopics, sourceSentences, existingTopics, existingSentences, topicCount, sentenceCount };
  } catch (e) {
    try { db.close(); } catch { /* noop */ }
    throw e;
  }
}

/** workspace.json → sid/sid8 → 工作区 path（用于给迁移行注入 wsKey hint） */
function loadWorkspaceHints(wsJsonPath) {
  const out = { ok: false, path: wsJsonPath, bySid8: new Map(), stats: { workspaces: 0, sessions: 0, conflicts: 0, reason: "" } };
  if (!wsJsonPath || !fs.existsSync(wsJsonPath)) { out.stats.reason = "文件不存在"; return out; }
  let j = null;
  try { j = JSON.parse(fs.readFileSync(wsJsonPath, "utf8")); } catch (e) { out.stats.reason = "JSON 解析失败：" + ((e && e.message) || e); return out; }
  const rawTable = j && j.tables ? j.tables.workspaces : null;
  const workspaces = Array.isArray(rawTable) ? rawTable : (rawTable && typeof rawTable === "object" ? Object.values(rawTable) : []);
  const full = new Map(); // 完整 sid（去 session- 前缀、小写） → { path, title }
  for (const w of workspaces) {
    const p = w && w.path ? String(w.path) : "";
    for (const sid of (Array.isArray(w && w.sessionIds) ? w.sessionIds : [])) {
      const key = String(sid).replace(/^session-/, "").toLowerCase();
      if (!key) continue;
      const prev = full.get(key);
      if (!prev) full.set(key, { path: p, title: w.title || "" });
      else if (prev.path !== p) { full.set(key, { path: null, title: "", conflict: true }); out.stats.conflicts += 1; }
    }
  }
  const bySid8 = new Map();
  for (const [sid, info] of full) {
    const s8 = sid.slice(0, 8);
    const prev = bySid8.get(s8);
    if (!prev) bySid8.set(s8, info);
    else if (prev.path !== info.path) bySid8.set(s8, { path: null, conflict: true });
  }
  out.ok = true;
  out.bySid8 = bySid8;
  out.stats.workspaces = workspaces.length;
  out.stats.sessions = full.size;
  out.stats.reason = "ok";
  return out;
}

// ───────────────────────────── 计划构建 ─────────────────────────────

function buildPlan(snapshot, hints) {
  const topicNameById = new Map(snapshot.topics.map((t) => [t.id, t.name]));
  const rows = [];
  const hintStats = { hit: 0, miss: 0, ambiguous: 0, disabled: !hints || !hints.ok };
  for (const s of snapshot.sourceSentences) {
    const row = {
      topicName: topicNameById.get(s.topicId) || s.topicId,
      topicId: s.topicId,
      sentenceId: s.id,
      body: s.body,
      updatedAt: s.updatedAt,
    };
    if (hints && hints.ok) {
      const meta = P25.extractCheckpointMeta(s.body);
      if (meta) {
        const h = hints.bySid8.get(meta.sid8);
        if (h && h.path) { row.wsKey = P25.normalizeWorkspace(h.path); hintStats.hit += 1; }
        else if (h && h.conflict) hintStats.ambiguous += 1;
        else hintStats.miss += 1;
      }
    }
    rows.push(row);
  }
  const existingRows = snapshot.existingSentences.map((s) => ({
    topicName: topicNameById.get(s.topicId) || s.topicId,
    topicId: s.topicId,
    sentenceId: s.id,
    body: s.body,
    updatedAt: s.updatedAt,
    isExisting: true,
  }));
  const plan = P25.planMigration({ rows, existing: existingRows });

  // ── 安全护栏（2026-11-03 实测加入）：**绝不把库内更新的会话主题降级成历史句** ──────────
  // 背景：P2.5 写侧已在运行期落库（库里已有 8 个会话主题，正文是「压缩 p3xx · sid · cwd」新格式），
  // 其中 4 个 sid 与历史 marker 句重叠。planMigration 只比正文，不看时间 ⇒ 会把**更新的库内正文**
  // replaceSentence 成**更旧的历史正文**（内容回退）。这里按「现有句 updatedAt > 历史句 updatedAt」
  // 拦截，归入 skipped（reason=existing-newer），并在报告里单列。历史句仍原样留在日期主题，不丢。
  const downgrades = [];
  const filteredUpdates = [];
  for (const u of plan.update) {
    const exTs = Number(u.previousUpdatedAtMs);
    const newTs = Number(u.updatedAt);
    if (Number.isFinite(exTs) && Number.isFinite(newTs) && exTs > newTs) { downgrades.push(u); continue; }
    filteredUpdates.push(u);
  }
  if (downgrades.length) {
    plan.update = filteredUpdates;
    for (const u of downgrades) {
      plan.skipped.push({
        reason: "existing-newer",
        topicName: u.topicName,
        sid8: u.sid8,
        detail: "库内会话主题更新（" + fmtTime(u.previousUpdatedAtMs) + " > 历史句 " + fmtTime(u.updatedAt) + "）⇒ 保留运行期版本，不降级",
      });
    }
    const lmap = new Map();
    const bump = (wsKey, kind) => {
      const k = wsKey || "unknown";
      if (!lmap.has(k)) lmap.set(k, { wsKey: k, lineName: P25.lineName(k), sessions: 0, create: 0, update: 0 });
      const l = lmap.get(k); l.sessions += 1; l[kind] += 1;
    };
    for (const c of plan.create) bump(c.wsKey, "create");
    for (const u of plan.update) bump(u.wsKey, "update");
    plan.lines = [...lmap.values()].sort((a, b) => (a.wsKey < b.wsKey ? -1 : a.wsKey > b.wsKey ? 1 : 0));
    plan.stats.updated = plan.update.length;
    plan.stats.skipped = plan.skipped.length;
    plan.stats.skippedByReason["existing-newer"] = downgrades.length;
    plan.stats.lines = plan.lines.length;
  }
  plan.downgrades = downgrades;

  return { plan, rows, existingRows, hintStats, topicNameById, downgrades };
}

// ───────────────────────────── 报告打印 ─────────────────────────────

function printReport(ctx) {
  const { options, snapshot, plan, hintStats, t0 } = ctx;
  const st = plan.stats;
  console.log("=== P2.5 会话记忆迁移计划（" + (options.apply ? "APPLY 前置检查" : "dry-run，不写库") + "）===");
  console.log("库          ：" + snapshot.dbPath);
  console.log("D8 域       ：" + (snapshot.domain ? snapshot.domain.id + "「" + snapshot.domain.name + "」" : "（未找到！）"));
  console.log("历史线      ：" + (snapshot.line ? snapshot.line.id + "「" + snapshot.line.name + "」" : "（未找到，将用全库日期名主题兜底）"));
  console.log("库总量      ：topics=" + snapshot.topicCount + " sentences=" + snapshot.sentenceCount);
  console.log("");
  console.log("源日期主题数：" + snapshot.sourceTopics.length);
  console.log("  扫描句子数：" + st.legacyRows + "（其中带检查点 marker：" + st.markerRows + "）");
  console.log("  非检查点句：" + (snapshot.sourceSentences.length - st.markerRows) + "（日摘要/导入正文等，原样保留，不迁移）");
  console.log("提取到的 sid 数：" + st.distinctSids + (st.markerRows ? "（marker 句 " + st.markerRows + " ⇒ 去重率 " + (100 * (1 - st.distinctSids / st.markerRows)).toFixed(1) + "%）" : ""));
  console.log("已有会话主题数：" + snapshot.existingTopics.length);
  console.log("将新建线数  ：" + plan.lines.length + "（每条线 = 一个工作区）");
  console.log("将新建主题数：" + st.created);
  console.log("将更新主题数：" + st.updated + "（已存在同 sid 主题且**库内更旧**才覆盖；库内更新的会被挡在 existing-newer）");
  console.log("不降级跳过  ：" + ((plan.downgrades && plan.downgrades.length) || 0) + "（库内已有更新的会话主题，保留运行期版本）");
  for (const d of (plan.downgrades || []).slice(0, options.limit)) {
    console.log("    - 保留运行期版本 " + d.topicName + "（库内 " + fmtTime(d.previousUpdatedAtMs) + " > 历史句 " + fmtTime(d.updatedAt) + "）");
  }
  console.log("跳过计数    ：" + st.skipped);
  for (const [reason, n] of Object.entries(st.skippedByReason).sort((a, b) => b[1] - a[1])) {
    console.log("    - " + reason + "：" + n);
  }
  console.log("unknown 计数：" + st.unknownSids + "（wsKey 拿不到，落 `会话检查点·unknown` 线）");
  if (!hintStats.disabled) {
    console.log("wsKey 提示 ：workspace.json 命中 " + hintStats.hit + " 句 / 未命中 " + hintStats.miss + " / 歧义 " + hintStats.ambiguous);
  } else {
    console.log("wsKey 提示 ：已禁用（--no-hints），仅用正文启发式");
  }
  console.log("wsKey 来源 ：" + JSON.stringify(st.wsKeySources));
  const gateN = st.created + st.updated;
  const gateOk = gateN <= 30 && st.unknownSids <= 3;
  console.log("安全闸      ：create+update=" + gateN + "（阈值 ≤30）；wsKey=unknown=" + st.unknownSids + "（阈值 ≤3）⇒ " + (gateOk ? "PASS" : "STOP（需回报 lead）"));
  if (plan.conflicts.length) {
    console.log("⚠ 冲突      ：" + plan.conflicts.length + "（已有主题工作区与计划不一致；已按「保留已有名」处理，需人工决定是否改名）");
    for (const c of plan.conflicts.slice(0, Math.max(5, options.limit))) {
      console.log("    - sid " + c.sid8 + "：" + c.existingWsKey + " → 计划 " + c.plannedWsKey + "（" + c.topicName + "）");
    }
  }
  console.log("");
  console.log("按工作区线（" + plan.lines.length + " 条）：");
  for (const l of plan.lines) {
    console.log("  · " + l.lineName + "  会话 " + l.sessions + "（新建 " + l.create + " / 更新 " + l.update + "）");
  }
  const detail = (label, items) => {
    if (!items.length) return;
    console.log("");
    console.log(label + "（" + items.length + "）：");
    for (const it of items.slice(0, options.limit)) {
      const extra = it.source ? " ← " + it.source.topicName + (it.source.cid8 ? " cid " + it.source.cid8 : "") : "";
      console.log("  - [" + it.wsKey + "] " + it.topicName + "  (" + it.chars + " 字, " + fmtTime(it.updatedAt) + ", " + it.wsKeySource + ")" + extra);
    }
    if (items.length > options.limit) console.log("  … 其余 " + (items.length - options.limit) + " 条省略（--limit 调整）");
  };
  detail("将新建（首 " + options.limit + " 条）", plan.create);
  detail("将更新（首 " + options.limit + " 条）", plan.update);
  if (plan.unknownWs.length) {
    console.log("");
    console.log("unknown 明细（" + plan.unknownWs.length + "）：");
    for (const it of plan.unknownWs.slice(0, options.limit)) console.log("  - unknown/" + it.sid8 + " ← " + (it.source && it.source.topicName) + "（" + fmtTime(it.updatedAt) + "）");
    if (plan.unknownWs.length > options.limit) console.log("  … 其余 " + (plan.unknownWs.length - options.limit) + " 条省略");
  }
  if (options.verbose) {
    console.log("");
    console.log("skipped 明细：");
    for (const s of plan.skipped) {
      console.log("  - " + s.reason + "  " + (s.topicName || "") + (s.sid8 ? "  sid " + s.sid8 : "") + (s.sentenceId ? "  #" + s.sentenceId : ""));
    }
  }
  const unconditional = [];
  if (!snapshot.domain) unconditional.push("未找到 D8 域「" + P25.D8_DOMAIN_NAME + "」");
  if (!snapshot.line) unconditional.push("未找到历史线「" + P25.LEGACY_LINE_NAME + "」");
  if (!st.markerRows) unconditional.push("没有可迁移的检查点句（sid marker=0）");
  if (unconditional.length) {
    console.log("");
    console.log("⚠ 注意：" + unconditional.join("；"));
  }
  console.log("");
  console.log("耗时 " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
  return { st };
}

// ───────────────────────────── --apply ─────────────────────────────

function resolveMemtopicDir() {
  const cands = [];
  if (process.env.MEMTOPIC_DIR) cands.push(String(process.env.MEMTOPIC_DIR));
  cands.push(path.join(PLUGIN_DIR, "memtopic"));
  cands.push(path.join(HERE, "..", "memtopic"));
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, "src", "memory-store.mjs")) && fs.existsSync(path.join(d, "src", "backend-sqlite.mjs"))) return d;
    } catch { /* noop */ }
  }
  return null;
}

/** 写前备份：VACUUM INTO（源库只读打开也能落快照；失败则回退复制 db+wal+shm） */
function backupDb(db, dbPath) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = dbPath + ".bak-p25-" + ts;
  if (fs.existsSync(target)) throw new Error("备份目标已存在：" + target);
  let mode = "vacuum-into";
  try {
    db.exec("VACUUM INTO " + sqlQuote(target));
  } catch (e) {
    mode = "file-copy";
    try { fs.copyFileSync(dbPath, target); } catch (e2) {
      throw new Error("备份失败（VACUUM INTO：" + ((e && e.message) || e) + "；复制：" + ((e2 && e2.message) || e2) + "）");
    }
    for (const ext of ["-wal", "-shm"]) {
      try { if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, target + ext); } catch { /* noop */ }
    }
  }
  const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
  return { path: target, size, mode };
}

async function applyPlan(ctx) {
  const { options, snapshot, plan } = ctx;
  const memtopicDir = resolveMemtopicDir();
  if (!memtopicDir) throw new Error("未找到 memtopic/src（先跑 dry-run 检查安装形态，或用 MEMTOPIC_DIR 指定）");
  const storeMod = await import(pathToFileURL(path.join(memtopicDir, "src", "memory-store.mjs")).href);
  const backendMod = await import(pathToFileURL(path.join(memtopicDir, "src", "backend-sqlite.mjs")).href);
  const be = new backendMod.SqliteBackend(options.db);
  const store = new storeMod.MemoryStore(be);
  const result = { createdLines: 0, reusedLines: 0, createdTopics: 0, updatedTopics: 0, appended: 0, stateActivated: 0, skippedNoop: 0, errors: [] };
  try {
    try { be.db.exec("PRAGMA busy_timeout = 8000"); } catch { /* noop */ }
    // D8 域定位（在 store 视图里按名字 + 层级解析）
    const allTopics = () => store.topics() || [];
    const findByName = (name) => allTopics().find((t) => String(t.name) === String(name)) || null;
    const rows = allTopics();
    const domain = rows.find((t) => store.levelOf(t) === "domain" && normName(t.name) === normName(P25.D8_DOMAIN_NAME))
      || rows.find((t) => store.levelOf(t) === "domain" && normName(t.name).includes("日记忆")) || null;
    if (!domain) throw new Error("库里没有 D8 域「" + P25.D8_DOMAIN_NAME + "」，拒绝写入");
    const lineIds = new Map(); // wsKey → topicId
    const nowLabel = "p25-migrate";

    /**
     * 结构节点状态修正（**关键**）：
     *   seedTopic 恒落 draft，且 `会话检查点·<wsKey>` / `<wsKey>/<sid8>` 这类结构性长名很容易被
     *   gradeCreate 判成 `seed-near-duplicate`/`seed-gray` ⇒ 进 needs_review 队列（实测 17 个新主题里
     *   6 条线全部 needs_review、2 个会话主题 seed-gray）。P2.5 的线与会话主题都是**运行期结构节点**，
     *   不是待复核的知识主题 ⇒ 显式置 active（只对本次新建节点做，幂等：已是 active 则跳过）。
     */
    const activate = (topic) => {
      if (!topic) return;
      if (topic.state === "active") return;
      try {
        store.setState(topic.id, "active", { actor: "runtime", reason: "p25-migrate-structural" });
        result.stateActivated += 1;
      } catch (e) {
        result.errors.push("setState 失败 " + topic.id + "：" + ((e && e.message) || e));
      }
    };

    let createdLines = 0;
    let reusedLines = 0;
    const ensureLine = (wsKey) => {
      if (lineIds.has(wsKey)) return lineIds.get(wsKey);
      const name = P25.lineName(wsKey);
      let t = findByName(name);
      const created = !t;
      if (!t) {
        const r = store.seedTopic({ name, src: nowLabel, actor: "plugin" });
        if (!r || !r.id) throw new Error("建线失败：" + name);
        t = store.topics().find((x) => x.id === r.id) || null;
        if (!t) throw new Error("建线后取不到行：" + name);
        createdLines += 1;
      } else {
        reusedLines += 1;
      }
      if (String(t.parentId || "") !== String(domain.id)) {
        store.linkParent(t.id, domain.id, { actor: "runtime" });
      }
      if (store.levelOf(t) !== "project") store.setLevel(t.id, "project", { actor: "runtime" });
      if (created) activate(store.topics().find((x) => x.id === t.id) || t);
      lineIds.set(wsKey, t.id);
      return t.id;
    };

    const ensureSessionTopic = (entry, lineId) => {
      const name = entry.topicName;
      const found = findByName(name);
      if (found) return { id: found.id, created: false };
      const r = store.seedTopic({ name, src: nowLabel, actor: "plugin" });
      if (!r || !r.id) throw new Error("建会话主题失败：" + name);
      const t = store.topics().find((x) => x.id === r.id) || null;
      if (!t) throw new Error("建会话主题后取不到行：" + name);
      if (String(t.parentId || "") !== String(lineId)) store.linkParent(t.id, lineId, { actor: "runtime" });
      if (store.levelOf(t) !== "detail") store.setLevel(t.id, "detail", { actor: "runtime" });
      activate(store.topics().find((x) => x.id === t.id) || t);
      return { id: t.id, created: true };
    };

    const liveTextsOf = (topicId) => {
      let list = [];
      try { list = (store.readTopic(topicId).sentences || []).map((s) => String(s && s.text != null ? s.text : s)); } catch { list = []; }
      return list;
    };
    const writeSentence = (entry, topicId) => {
      const live = liveTextsOf(topicId);
      if (!live.length) {
        store.appendSentence({ topic: topicId, text: entry.text, src: nowLabel, actor: "runtime" });
        result.appended += 1;
        return;
      }
      const oldText = (entry.previousText != null && live.includes(entry.previousText)) ? entry.previousText : (live.length === 1 ? live[0] : null);
      if (oldText == null) {
        // 多句且没有精确原文匹配：追加新句（读取侧按 updatedAt 取最新，语义仍正确；不删旧句）
        store.appendSentence({ topic: topicId, text: entry.text, src: nowLabel, actor: "runtime" });
        result.appended += 1;
        return;
      }
      if (String(oldText).trim() === String(entry.text).trim()) { result.skippedNoop += 1; return; }
      store.replaceSentence({ topic: topicId, oldText, newText: entry.text, actor: "runtime" });
    };

    // ── 单事务：要么整体成功，要么整体回滚 ──
    // 时钟：把 store 时钟钉到**源句子的历史时间**再落库 —— 否则所有迁移主题的
    // created_at/updated_at 都会是「本次运行时刻」，P2.5 读侧按 updatedAt 取「上一个会话」
    // 的排序会全部并列（等于丢了时间信息）。这里逐条 setClock(源 updatedAt)，线取组内最早。
    const tsOf = (e) => (Number.isFinite(Number(e.updatedAt)) && Number(e.updatedAt) > 0 ? Number(e.updatedAt) : Date.now());
    const items = plan.create.map((e) => ({ kind: "create", e })).concat(plan.update.map((e) => ({ kind: "update", e })))
      .sort((a, b) => (a.e.wsKey < b.e.wsKey ? -1 : a.e.wsKey > b.e.wsKey ? 1 : a.e.sid8 < b.e.sid8 ? -1 : a.e.sid8 > b.e.sid8 ? 1 : 0));
    const groupMinTs = new Map();
    for (const it of items) {
      const t = tsOf(it.e);
      const cur = groupMinTs.get(it.e.wsKey);
      if (cur == null || t < cur) groupMinTs.set(it.e.wsKey, t);
    }
    let curWs = null;
    store.runInTransaction(() => {
      for (const it of items) {
        const e = it.e;
        if (e.wsKey !== curWs) {
          store.setClock(groupMinTs.get(e.wsKey) || Date.now());
          ensureLine(e.wsKey);
          curWs = e.wsKey;
        }
        store.setClock(tsOf(e));
        const lineId = lineIds.get(e.wsKey);
        const r = ensureSessionTopic(e, lineId);
        writeSentence(e, r.id);
        if (r.created) result.createdTopics += 1;
        else result.updatedTopics += 1;
      }
      store.setClock(null);   // 恢复真实时钟（事务末尾，避免影响后续审计）
    });
    result.createdLines = createdLines;
    result.reusedLines = reusedLines;
    return result;
  } finally {
    try { be.close(); } catch { /* noop */ }
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  const t0 = Date.now();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  if (!options.db) throw new Error("--db 为空");

  const snapshot = readSnapshot(options.db);
  const hints = options.hints ? loadWorkspaceHints(options.wsJson) : { ok: false, stats: { reason: "disabled" } };
  const built = buildPlan(snapshot, hints);
  const ctx = { options, snapshot, plan: built.plan, hintStats: built.hintStats, t0 };

  if (options.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      db: snapshot.dbPath,
      domain: snapshot.domain ? { id: snapshot.domain.id, name: snapshot.domain.name } : null,
      line: snapshot.line ? { id: snapshot.line.id, name: snapshot.line.name } : null,
      hintStats: built.hintStats,
      hints: { ok: hints.ok, stats: hints.stats },
      downgrades: built.downgrades || [],
      plan: built.plan,
    }, null, 2));
    return 0;
  }

  printReport(ctx);

  if (!options.apply) {
    console.log("[dry-run] 未写库（只读打开）。确认无误后加 --apply 执行。");
    console.log("         回滚保障：--apply 会在写库前自动 VACUUM INTO 备份；只新增不删除原句。");
    return 0;
  }

  // ── APPLY ──
  console.log("");
  console.log("=== APPLY ===");
  if (built.plan.create.length === 0 && built.plan.update.length === 0) {
    console.log("没有需要写入的目标（全部已迁移/一致），不写库。");
    return 0;
  }
  const backup = backupDb(snapshot.db, snapshot.dbPath);
  console.log("已备份：" + backup.path + "（" + (backup.size / 1024 / 1024).toFixed(2) + " MB，" + backup.mode + "）");
  snapshot.db.close();
  let res = null;
  try {
    res = await applyPlan({ options, snapshot, plan: built.plan });
  } catch (e) {
    console.log("✗ 写入失败（事务应已回滚）：" + ((e && e.message) || e));
    console.log("  备份仍在：" + backup.path);
    return 2;
  }
  console.log("✅ 写入完成：新建线 " + res.createdLines + "（复用 " + res.reusedLines + "）；新建会话主题 " + res.createdTopics + "；更新 " + res.updatedTopics + "；新句追加 " + res.appended + "；状态置 active " + res.stateActivated + (res.errors.length ? "；⚠ 非致命错误 " + res.errors.length : ""));
  if (res.errors.length) for (const e of res.errors.slice(0, 10)) console.log("   ⚠ " + e);

  // 写后校验（重新只读打开）
  const after = readSnapshot(options.db);
  try {
    const afterPlanned = buildPlan(after, hints);
    const names = new Set(after.topics.map((t) => t.name));
    const missing = built.plan.create.filter((c) => !names.has(c.topicName));
    const lineMissing = built.plan.lines.filter((l) => !names.has(l.lineName));
    console.log("");
    console.log("=== 写后校验（重新读库）===");
    console.log("日期主题句子数：" + snapshot.sourceSentences.length + " → " + after.sourceSentences.length + (after.sourceSentences.length === snapshot.sourceSentences.length ? "（原句一字未动 ✅）" : "（⚠ 有变化！）"));
    console.log("会话主题数    ：" + after.existingTopics.length + "（预期 " + (snapshot.existingTopics.length + res.createdTopics) + "）");
    console.log("新线落地      ：" + (built.plan.lines.length - lineMissing.length) + "/" + built.plan.lines.length + (lineMissing.length ? "（缺：" + lineMissing.map((l) => l.lineName).join("、") + "）" : " ✅"));
    console.log("新主题落地    ：" + (built.plan.create.length - missing.length) + "/" + built.plan.create.length + (missing.length ? "（缺：" + missing.map((m) => m.topicName).join("、") + "）" : " ✅"));
    console.log("重跑计划      ：create=" + afterPlanned.plan.stats.created + " update=" + afterPlanned.plan.stats.updated + " skipped=" + afterPlanned.plan.stats.skipped + "（幂等：应为 0/0）");
    if (missing.length) {
      console.log("⚠ 有主题未落地，请检查错误日志；备份：" + backup.path);
      return 3;
    }
  } finally {
    after.db.close();
  }
  console.log("");
  console.log("回滚方式（任选）：");
  console.log("  1) 停 DSH → 用备份覆盖：" + backup.path + " → " + options.db);
  console.log("  2) 或只删本次新建的主题（本脚本未改/未删任何原有句子，旧日期主题可继续被历史读侧使用）");
  return 0;
}

main().then((code) => {
  process.exitCode = code || 0;
}).catch((e) => {
  console.error("✗ " + ((e && e.message) || e));
  if (process.env.P25_DEBUG) console.error(e && e.stack);
  process.exitCode = 1;
});
