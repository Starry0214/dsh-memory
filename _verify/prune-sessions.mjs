#!/usr/bin/env node
/**
 * prune-sessions.mjs —— DSH 会话目录堆积盘点 + 默认 dry-run 清理工具（task-22）
 *
 * 目标目录：`~/.dsh/sessions/<工作区目录>/<会话目录>/`（会话目录里是 zstd 压缩的 JSONL 事件流）。
 *
 * 三种模式：
 *   1) 默认 `--report`（只读）：盘点总量 / 主会话 vs 子代理 / 最近 30 天按天新增 / A·B·C 三档候选清单。
 *   2) `--apply`：真删，但**只删 A 档（已结算子代理）与 B 档（空壳）**，C 档（陈旧主会话）硬编码永不删。
 *   3) `--selftest`：在 os.tmpdir() 下造 6 个假会话目录，按验收口径跑 `--apply` 断言（A/B 删、C/正常主会话留、
 *      越界拒绝、台账正确、--max 生效），不会碰真实 sessions 根。
 *
 * 安全设计（删除路径三重校验）：
 *   ① 目标路径必须严格位于 sessions 根之下（先 path.resolve 判相对路径，再 realpath.native 判真实路径，
 *      双重防符号链接/junction 穿越）；
 *   ② 目录名必须是 `<uuid>` 或 `session-<uuid>`（UUID v4 形态），否则一律不删；
 *   ③ 删除前把该目录的日志证据（日志名/字节/sha256/首末事件时间/最后事件类型/最后修改时间）追加进台账
 *      `<sessions 根>/.prune-ledger.jsonl`（一行 intent、删完再一行 result），台账本身永不参与清理。
 *
 * 判定口径（与任务书一致；括号内是本实现更保守之处）：
 *   - 分类证据 = 目录名前缀 ∩ 日志首事件 `session` header：「主会话」= `session-` 前缀 且 header 无
 *     `origin:'subagent'`/`parentSession`；「子代理」= 无前缀 且 header 有其一。两者矛盾 → `mismatch`，
 *     只报告、永不删（实测真实环境有 17 个这种历史遗留）。
 *   - A 档 已结算子代理：分类=子代理 且 日志里出现过 `turn/end`/`subagent/end` 且 最后事件时间 >
 *     keepDays（默认 14；硬下限 7 天，即使传更小的 --keep-days 也不会低于 7）。
 *   - B 档 空壳：目录内**没有任何日志文件**、也没有 `.bak` 备份、总字节 < 1KB，且目录 mtime 已超过 24h
 *     （防删掉刚创建、日志还没落盘的活会话）。比任务书「无日志或日志<1KB」更保守：带 `.bak` 的救援目录不删。
 *   - C 档 陈旧主会话：分类=主会话 且 最后事件 > 90 天（硬编码）→ **只报告，任何参数下都不删**。
 *   - 其余保留：子代理但无 turn/end / 太新 / 主会话太新 / mismatch / 名字不匹配 → 只计数不删。
 *   - 大日志（>8MB）：只解压首帧与末帧（避免整文件几十 MB 解压爆内存）；首末帧都没有 turn/end 时按
 *     「未证实已结算」处理（不进 A 档，宁可少删）。
 *
 * 用法：
 *   node _verify/prune-sessions.mjs                        # dry-run 报告（默认，只读）
 *   node _verify/prune-sessions.mjs --flow report --json   # 机器可读报告
 *   node _verify/prune-sessions.mjs --apply                # 真删 A+B（会写台账）
 *   node _verify/prune-sessions.mjs --apply --only=A --keep-days=30 --max=50
 *   node _verify/prune-sessions.mjs --selftest             # 造数自测（tmpdir）
 *   公共参数：--sessions-root=<路径>（仅自测/排障用，默认 ~/.dsh/sessions）
 *            --keep-days=N（默认 14，硬下限 7）  --max=N（默认 100，硬上限 200）
 *            --only=A,B（默认 A,B；C 永远忽略）  --top=N（报告候选清单条数，默认 20）
 *
 * 只读保证：不加 --apply 时不写任何文件（不写台账）。--apply 只写台账 + 删候选目录。
 * 运行期只处理「工作区/<会话目录>」两层，绝不遍历/删除工作区目录本身与 sessions 根。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const LEDGER_NAME = ".prune-ledger.jsonl";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_RE = /^session.*\.jsonl\.zstd$/i;
const BAK_RE = /\.bak/i;
const DAY = 86400000;
const HOUR = 3600000;
const HARD_KEEP_FLOOR_DAYS = 7;      // A 档硬下限（任务书：最后事件 > 7 天）
const C_TIER_DAYS = 90;              // C 档硬编码：主会话 >90 天，只报告
const MAX_DELETE_HARD = 200;         // --max 硬上限
const WHOLE_DECODE_LIMIT = 8 * 1024 * 1024;   // <=8MB 整文件解压；更大只解首末帧
const B_MIN_AGE_HOURS = 24;          // B 档空壳最小年龄（防删刚建的空会话）
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ────────────────────────────── CLI ──────────────────────────────
function parseArgs(argv) {
  const opt = {
    mode: "report", root: DEFAULT_ROOT, apply: false, json: false, help: false,
    keepDays: 14, max: 100, only: ["A", "B"], top: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opt.apply = true;
    else if (a === "--selftest") opt.mode = "selftest";
    else if (a === "--report" || a === "--dry-run") opt.mode = "report";
    else if (a === "--json") opt.json = true;
    else if (a === "--help" || a === "-h") opt.help = true;
    else if (a === "--flow") { const v = String(argv[++i] || ""); if (v === "report" || v === "apply") { if (v === "apply") opt.apply = true; } else if (v === "selftest") opt.mode = "selftest"; }
    else if (a.startsWith("--sessions-root=")) opt.root = a.slice("--sessions-root=".length);
    else if (a === "--sessions-root") opt.root = String(argv[++i] || DEFAULT_ROOT);
    else if (a.startsWith("--keep-days=")) opt.keepDays = parseInt(a.slice("--keep-days=".length), 10);
    else if (a === "--keep-days") opt.keepDays = parseInt(argv[++i], 10);
    else if (a.startsWith("--max=")) opt.max = parseInt(a.slice("--max=".length), 10);
    else if (a === "--max") opt.max = parseInt(argv[++i], 10);
    else if (a.startsWith("--only=")) opt.only = a.slice("--only=".length).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === "--only") opt.only = String(argv[++i] || "A,B").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a.startsWith("--top=")) opt.top = parseInt(a.slice("--top=".length), 10);
    else if (a === "--top") opt.top = parseInt(argv[++i], 10);
    else throw new Error(`未知参数：${a}（--help 看用法）`);
  }
  if (!Number.isFinite(opt.keepDays) || opt.keepDays < 0) throw new Error("--keep-days 非法");
  opt.keepDays = Math.max(HARD_KEEP_FLOOR_DAYS, opt.keepDays);
  if (!Number.isFinite(opt.max) || opt.max < 1) throw new Error("--max 非法");
  opt.max = Math.min(opt.max, MAX_DELETE_HARD);
  if (!Number.isFinite(opt.top) || opt.top < 1) opt.top = 20;
  opt.only = opt.only.filter((x) => x === "A" || x === "B" || x === "C");
  if (opt.only.includes("C")) {
    opt.only = opt.only.filter((x) => x !== "C");
    opt.cIgnored = true;
  }
  if (!opt.only.length) opt.only = ["A", "B"];
  opt.root = path.resolve(opt.root);
  return opt;
}

function printHelp() {
  console.log(`prune-sessions.mjs —— DSH 会话目录盘点 + 默认 dry-run 清理

默认（不加 --apply）只读报告；--apply 才删，且只删 A/B 档，C 档永删不了。

用法:
  node _verify/prune-sessions.mjs [--report] [--json] [--top=20]
  node _verify/prune-sessions.mjs --apply [--only=A,B] [--keep-days=14] [--max=100]
  node _verify/prune-sessions.mjs --selftest
公共参数:
  --sessions-root=<path>  会话根（默认 ~/.dsh/sessions；仅自测/排障建议显式指定）
  --keep-days=N           A 档最后事件阈值天数（默认 14，硬下限 7）
  --max=N                 单次最多删（默认 100，硬上限 200）
  --only=A,B              只处理指定档（默认 A,B；C 永远被忽略）
  --json                  机器可读输出
档位:
  A 已结算子代理: 无 session- 前缀 + header subagent + 有 turn/end + 最后事件 > keepDays  (可删)
  B 空壳:        无日志 + 无 .bak + 总字节<1KB + mtime>24h                             (可删)
  C 陈旧主会话:  session- 前缀 + header 主会话 + 最后事件 > 90 天                       (只报告，永不删)
台账: <sessions-root>/${LEDGER_NAME}（append-only；删前写 intent、删后写 result）`);
}

// ────────────────────────────── 工具函数 ──────────────────────────────
const fmtInt = (n) => (Number(n) || 0).toLocaleString("en-US");
const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
};
const pad2 = (x) => String(x).padStart(2, "0");
function fmtTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDay(ms) {
  if (!ms || !Number.isFinite(ms)) return "(unknown)";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function hashFile(p) {
  try { return sha256(fs.readFileSync(p)); } catch { return null; }
}

// ── zstd 解压：小文件整解；大文件按帧扫描只解首帧/末帧（防几十 MB 日志整解爆内存）──
function zstdFrameOffsets(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, pos);
    if (at < 0) break;
    out.push(at);
    pos = at + 4;
  }
  return out;
}
function decodeWhole(buf) {
  try { return zlib.zstdDecompressSync(buf).toString("utf8"); } catch { return ""; }
}
/** 返回 { text, whole, frames }；text 为大文件时是「首帧 + "\n" + 末帧」的拼接。 */
function decodeLogText(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return { text: "", whole: false, frames: 0 }; }
  const frames = zstdFrameOffsets(buf);
  if (buf.length <= WHOLE_DECODE_LIMIT) {
    const text = decodeWhole(buf);
    return { text, whole: true, frames: frames.length };
  }
  const parts = [];
  if (frames.length) {
    const firstEnd = frames.length > 1 ? frames[1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(0, firstEnd)).toString("utf8")); } catch { /* 帧坏：跳过 */ }
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(frames[frames.length - 1])).toString("utf8")); } catch { /* 末帧坏：跳过 */ }
  }
  return { text: parts.join("\n"), whole: false, frames: frames.length };
}
function firstHeader(text) {
  const lines = text.split("\n", 8);
  for (const ln of lines) {
    if (!ln) continue;
    try { const j = JSON.parse(ln); if (j && j.type === "session") return j; } catch { /* 非 JSON 行 */ }
  }
  return null;
}
function lastValidEvent(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try { const j = JSON.parse(ln); if (j && typeof j.type === "string") return j; } catch { /* 半截行/垃圾尾 */ }
  }
  return null;
}

/** 读一个会话目录的日志证据。选择 newest 版本日志（v4 > v3 > v1，同版本按 mtime）。 */
function readDirEvidence(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const files = [];
  let totalBytes = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    let st = null;
    try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    totalBytes += st.size;
    files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  const logFiles = files.filter((f) => LOG_RE.test(f.name) && !BAK_RE.test(f.name));
  const versionRank = (name) => (name.includes(".v4.") ? 4 : name.includes(".v3.") ? 3 : name.includes(".v4") ? 4 : 1);
  logFiles.sort((a, b) => (versionRank(b.name) - versionRank(a.name)) || (b.mtime - a.mtime));
  const dirStat = (() => { try { return fs.statSync(dir); } catch { return null; } })();
  const ev = {
    dir, files, totalBytes,
    logFiles,
    logCount: logFiles.length,
    logBytes: logFiles.reduce((s, f) => s + f.size, 0),
    bakCount: files.filter((f) => BAK_RE.test(f.name)).length,
    dirMtime: dirStat ? dirStat.mtimeMs : 0,
    primaryLog: null, header: null, headerOrigin: null, headerParent: null,
    firstEventTime: null, lastEvent: null, lastType: null, lastEventTime: null,
    hasEnd: false, scannedWhole: false, frames: 0, readError: null,
  };
  const primary = logFiles[0];
  if (!primary) return ev;
  ev.primaryLog = primary.name;
  const p = path.join(dir, primary.name);
  const { text, whole, frames } = decodeLogText(p);
  ev.scannedWhole = whole;
  ev.frames = frames;
  if (!text) { ev.readError = "日志解压为空（坏帧/正在写）"; return ev; }
  const h = firstHeader(text);
  if (h) {
    ev.header = h;
    ev.headerOrigin = typeof h.origin === "string" ? h.origin : null;
    ev.headerParent = typeof h.parentSession === "string" ? h.parentSession : null;
    ev.firstEventTime = typeof h.createdAt === "number" ? h.createdAt : null;
  }
  const le = lastValidEvent(text);
  if (le) {
    ev.lastEvent = le;
    ev.lastType = le.type;
    ev.lastEventTime = typeof le.time === "number" ? le.time : null;
  }
  ev.hasEnd = text.includes('"type":"turn/end"') || text.includes('"type":"subagent/end"');
  return ev;
}

// ────────────────────────────── 扫描 / 分档 ──────────────────────────────
function scanRoot(root) {
  const started = Date.now();
  const out = { root, workspaces: [], dirs: [], scanMs: 0, errors: [] };
  let wss = [];
  try { wss = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    throw new Error(`无法读取 sessions 根：${root}（${e.message}）`);
  }
  for (const w of wss) {
    if (!w.isDirectory()) continue;
    if (w.name.startsWith(".")) continue;                       // .prune-ledger.jsonl 等点文件/目录永不处理
    const wsDir = path.join(root, w.name);
    let sids = [];
    try { sids = fs.readdirSync(wsDir, { withFileTypes: true }); } catch (e) { out.errors.push(`${w.name}: ${e.message}`); continue; }
    out.workspaces.push(w.name);
    for (const d of sids) {
      // 只认目录；junction/symlink 也先当目录收进来，交给 validateTarget 用 realpath 否决
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (d.name.startsWith(".")) continue;
      const dir = path.join(wsDir, d.name);
      const ev = readDirEvidence(dir);      // 逐个处理：ev 返回后本层不持有解压文本，及时释放
      out.dirs.push(ev);
    }
  }
  out.scanMs = Date.now() - started;
  return out;
}

/** 目录名分类（仅供报告口径；删除另有 validateTarget 硬校验）。 */
function nameClassOf(name) {
  if (UUID_RE.test(name)) return "sub";
  if (SESSION_RE.test(name)) return "main";
  return "unknown";
}

/** 分档 + 分类。返回带 tier/verdict 的证据对象（就地扩展）。 */
function classifyDirs(dirs, opt) {
  const now = Date.now();
  const keepDays = Math.max(HARD_KEEP_FLOOR_DAYS, opt.keepDays);
  for (const ev of dirs) {
    const nameCls = nameClassOf(path.basename(ev.dir));
    ev.nameClass = nameCls;
    const headerSub = ev.headerOrigin === "subagent" || !!ev.headerParent;
    ev.headerSub = headerSub;
    // 分类（名字前缀 ∩ header）
    if (nameCls === "sub" && headerSub) ev.cls = "sub";
    else if (nameCls === "main" && !headerSub) ev.cls = "main";
    else if (nameCls === "sub" && !headerSub) ev.cls = "sub-header-missing";   // 名字像子代理但 header 无证据
    else if (nameCls === "main" && headerSub) ev.cls = "mismatch";             // 历史遗留：session- 前缀的子代理
    else ev.cls = "unknown";
    // 年龄：优先最后事件 time，其次目录 mtime
    ev.ageRef = ev.lastEventTime || ev.dirMtime || now;
    ev.ageDays = (now - ev.ageRef) / DAY;
    ev.ageHours = (now - ev.ageRef) / HOUR;
    // 档位
    if (ev.logCount === 0 && ev.bakCount === 0 && ev.totalBytes < 1024 && ev.ageHours >= B_MIN_AGE_HOURS) {
      ev.tier = "B"; ev.verdict = "空壳（无日志/无备份/总字节<1KB 且 >24h）";
    } else if (ev.cls === "sub" && ev.hasEnd && ev.ageDays > keepDays) {
      ev.tier = "A"; ev.verdict = `已结算子代理（有 turn/end，最后事件 ${ev.ageDays.toFixed(1)} 天前 > ${keepDays} 天）`;
    } else if (ev.cls === "main" && ev.ageDays > C_TIER_DAYS) {
      ev.tier = "C"; ev.verdict = `陈旧主会话（${ev.ageDays.toFixed(1)} 天前，仅报告）`;
    } else {
      ev.tier = null;
      ev.verdict = keepReason(ev, nameCls, headerSub, keepDays);
    }
  }
  return dirs;
}
function keepReason(ev, nameCls, headerSub, keepDays) {
  if (ev.readError) return "保留：日志读不出（不敢删）";
  if (ev.logCount === 0) return ev.bakCount > 0 ? "保留：无正式日志但有 .bak 备份" : "保留：空目录但未满 24h（可能是活会话）";
  if (ev.cls === "mismatch") return "保留：目录名(session-)与 header(子代理)矛盾（历史遗留，需人工确认）";
  if (ev.cls === "sub-header-missing") return "保留：名字像子代理但 header 无 subagent 证据";
  if (ev.cls === "sub") {
    if (!ev.hasEnd) return "保留：子代理但日志里没有 turn/end（可能未结算）";
    return `保留：子代理但最后事件仅 ${ev.ageDays.toFixed(1)} 天前（≤${keepDays} 天）`;
  }
  if (ev.cls === "main") return `保留：主会话且仅 ${ev.ageDays.toFixed(1)} 天前（C 档阈值 90 天）`;
  return "保留：目录名不是 UUID 形态";
}

// ────────────────────────────── 删除前置校验 / 台账 ──────────────────────────────
/** 三重校验：根内 + realpath 根内 + 名字形态。用于 --apply 每一步与自测。 */
function validateTarget(root, realRoot, absDir) {
  const resolved = path.resolve(absDir);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: `不在 sessions 根内: ${resolved}` };
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return { ok: false, reason: `层级不是 <工作区>/<会话目录>: ${rel}` };
  const name = parts[1];
  if (!UUID_RE.test(name) && !SESSION_RE.test(name)) return { ok: false, reason: `目录名不是 UUID/session-UUID: ${name}` };
  if (parts.some((p) => p.startsWith("."))) return { ok: false, reason: `路径含点前缀段: ${rel}` };
  let real = null;
  try { real = fs.realpathSync.native(resolved); } catch (e) { return { ok: false, reason: `realpath 失败: ${e.message}` }; }
  const realRel = path.relative(realRoot, real);
  if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) return { ok: false, reason: `realpath 逃出 sessions 根: ${real}` };
  // realpath 也必须是「工作区/会话目录」两层（允许工作区目录是指向别处的 junction，但会话目录必须真在根内两层）
  if (realRel.split(path.sep).length !== 2) return { ok: false, reason: `realpath 层级异常: ${realRel}` };
  let st = null;
  try { st = fs.statSync(real); } catch (e) { return { ok: false, reason: `目标不存在: ${e.message}` }; }
  if (!st.isDirectory()) return { ok: false, reason: "目标不是目录" };
  return { ok: true, real, sizeBytes: st.size };
}

function ledgerPath(root) { return path.join(root, LEDGER_NAME); }
function appendLedger(root, record) {
  try {
    fs.appendFileSync(ledgerPath(root), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────── 报告 ──────────────────────────────
function buildReport(scan, opt) {
  const dirs = scan.dirs;
  const now = Date.now();
  const counts = { total: dirs.length, workspaces: scan.workspaces.length, bytes: 0 };
  const cls = { main: 0, sub: 0, "sub-header-missing": 0, mismatch: 0, unknown: 0 };
  const clsBytes = { main: 0, sub: 0, "sub-header-missing": 0, mismatch: 0, unknown: 0 };
  const tiers = { A: [], B: [], C: [] };
  const retained = { "sub-no-end": 0, "sub-young": 0, "main-recent": 0, "mismatch": 0, shellYoung: 0, noName: 0, readError: 0 };
  const byDay = new Map();   // YYYY-MM-DD -> {count, bytes}
  for (const ev of dirs) {
    counts.bytes += ev.totalBytes;
    cls[ev.cls] = (cls[ev.cls] || 0) + 1;
    clsBytes[ev.cls] = (clsBytes[ev.cls] || 0) + ev.totalBytes;
    if (ev.tier) tiers[ev.tier].push(ev);
    else {
      if (ev.readError) retained.readError++;
      else if (ev.cls === "sub") { if (!ev.hasEnd) retained["sub-no-end"]++; else retained["sub-young"]++; }
      else if (ev.cls === "main") retained["main-recent"]++;
      else if (ev.cls === "mismatch") retained.mismatch++;
      else if (ev.cls === "unknown") retained.noName++;
      else retained.shellYoung++;
    }
    // 按天新增：优先 header.createdAt（=会话首事件时间）
    const born = ev.firstEventTime || ev.dirMtime || now;
    const key = fmtDay(born);
    const b = byDay.get(key) || { count: 0, bytes: 0 };
    b.count += 1; b.bytes += ev.totalBytes;
    byDay.set(key, b);
  }
  const daily30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const b = byDay.get(key) || { count: 0, bytes: 0 };
    daily30.push({ day: key, count: b.count, bytes: b.bytes });
  }
  const sumBytes = (arr) => arr.reduce((s, x) => s + x.totalBytes, 0);
  const sortBySize = (arr) => [...arr].sort((a, b) => b.totalBytes - a.totalBytes);
  const sortByAge = (arr) => [...arr].sort((a, b) => b.ageDays - a.ageDays || b.totalBytes - a.totalBytes);
  return {
    generatedAt: new Date().toISOString(),
    root: scan.root,
    scanMs: scan.scanMs,
    counts,
    cls,
    clsBytes,
    tiers: { A: tiers.A, B: tiers.B, C: tiers.C },
    tierStats: {
      A: { count: tiers.A.length, bytes: sumBytes(tiers.A) },
      B: { count: tiers.B.length, bytes: sumBytes(tiers.B) },
      C: { count: tiers.C.length, bytes: sumBytes(tiers.C) },
      reclaimable: { count: tiers.A.length + tiers.B.length, bytes: sumBytes(tiers.A) + sumBytes(tiers.B) },
    },
    retained,
    daily30,
    topA: sortBySize(tiers.A).slice(0, opt.top),
    topB: sortBySize(tiers.B).slice(0, opt.top),
    topC: sortByAge(tiers.C).slice(0, opt.top),
    orderByAge: sortByAge(tiers.A.concat(tiers.B)),
  };
}

function relOf(root, abs) { return path.relative(root, abs); }

function printReport(rep, opt) {
  const L = [];
  L.push("═".repeat(100));
  L.push(`DSH 会话目录盘点 ${opt.apply ? "（APPLY 前置报告）" : "（DRY-RUN，只读）"}  根=${rep.root}`);
  L.push("═".repeat(100));
  L.push(`工作区 ${rep.counts.workspaces} 个 ｜ 会话目录 ${fmtInt(rep.counts.total)} 个 ｜ 总占用 ${fmtBytes(rep.counts.bytes)}（${fmtInt(rep.counts.bytes)} B） ｜ 扫描耗时 ${(rep.scanMs / 1000).toFixed(1)}s`);
  L.push("");
  L.push("【分类】目录名前缀 ∩ 日志 header（origin/parentSession）");
  L.push(`  主会话(main) ${fmtInt(rep.cls.main)} 个 / ${fmtBytes(rep.clsBytes.main)}`);
  L.push(`  子代理(sub)  ${fmtInt(rep.cls.sub)} 个 / ${fmtBytes(rep.clsBytes.sub)}`);
  if (rep.cls["sub-header-missing"]) L.push(`  名字像子代理但 header 无证据 ${rep.cls["sub-header-missing"]} 个（保留）`);
  if (rep.cls.mismatch) L.push(`  名字(session-)与 header(子代理)矛盾 ${rep.cls.mismatch} 个（历史遗留，保留待人工确认）`);
  if (rep.cls.unknown) L.push(`  目录名非 UUID ${rep.cls.unknown} 个（保留）`);
  L.push("");
  L.push(`【最近 30 天按天新增】按会话首事件时间（createdAt）统计，共 ${fmtInt(rep.daily30.reduce((s, d) => s + d.count, 0))} 个 / ${fmtBytes(rep.daily30.reduce((s, d) => s + d.bytes, 0))}`);
  for (const d of rep.daily30) {
    if (!d.count) continue;
    L.push(`  ${d.day}  ${String(d.count).padStart(4)} 个  ${fmtBytes(d.bytes)}`);
  }
  L.push("");
  L.push(`【三档候选】（A/B 可删；C 只报告永不删）`);
  L.push(`  A 已结算子代理: ${fmtInt(rep.tierStats.A.count)} 个 / 可省 ${fmtBytes(rep.tierStats.A.bytes)}`);
  L.push(`  B 空壳:         ${fmtInt(rep.tierStats.B.count)} 个 / 可省 ${fmtBytes(rep.tierStats.B.bytes)}`);
  L.push(`  C 陈旧主会话:   ${fmtInt(rep.tierStats.C.count)} 个 / ${fmtBytes(rep.tierStats.C.bytes)}（不删）`);
  L.push(`  ⇒ A+B 合计可省 ${fmtBytes(rep.tierStats.reclaimable.bytes)}（${fmtInt(rep.tierStats.reclaimable.count)} 个目录）`);
  L.push("");
  L.push(`【保留原因分布】` + Object.entries(rep.retained).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("  "));
  L.push("");
  L.push(`【A 档 Top ${Math.min(opt.top, rep.topA.length)}（按占用降序）】`);
  for (const ev of rep.topA) L.push(`  ${fmtBytes(ev.totalBytes).padStart(9)}  ${ev.ageDays.toFixed(1).padStart(5)}天  ${relOf(rep.root, ev.dir)}`);
  if (!rep.topA.length) L.push("  （无）");
  L.push("");
  L.push(`【B 档 Top ${Math.min(opt.top, rep.topB.length)}】`);
  for (const ev of rep.topB) L.push(`  ${fmtBytes(ev.totalBytes).padStart(9)}  ${ev.ageDays.toFixed(1).padStart(5)}天  ${relOf(rep.root, ev.dir)}`);
  if (!rep.topB.length) L.push("  （无）");
  if (rep.tierStats.C.count) {
    L.push("");
    L.push(`【C 档 Top ${Math.min(opt.top, rep.topC.length)}（不删）】`);
    for (const ev of rep.topC) L.push(`  ${fmtBytes(ev.totalBytes).padStart(9)}  ${ev.ageDays.toFixed(1).padStart(5)}天  ${relOf(rep.root, ev.dir)}`);
  }
  console.log(L.join("\n"));
}

// ────────────────────────────── Apply ──────────────────────────────
function runApply(root, opt) {
  const realRoot = fs.realpathSync.native(root);
  const scan = scanRoot(root);
  const dirs = classifyDirs(scan.dirs, opt);
  const rep = buildReport({ ...scan, dirs }, opt);
  const wanted = opt.only;
  if (opt.cIgnored) console.log("[WARN] --only 里含 C 档：C 档（陈旧主会话）硬编码永不删除，已忽略。");
  const pool = rep.orderByAge.filter((ev) => ev.tier && wanted.includes(ev.tier));
  const batch = pool.slice(0, opt.max);
  console.log(`\n[APPLY] 根=${root}  候选池=${pool.length}  本次最多删 ${opt.max}  档=${wanted.join(",")}  keep-days=${opt.keepDays}\n`);
  const result = { attempted: 0, deleted: 0, failed: 0, refused: 0, freedBytes: 0, records: [] };
  const ledger = ledgerPath(root);
  for (const ev of batch) {
    result.attempted++;
    const rel = relOf(root, ev.dir);
    const ver = validateTarget(root, realRoot, ev.dir);
    if (!ver.ok) {
      result.refused++;
      console.log(`  [REFUSED] ${rel} —— ${ver.reason}`);
      appendLedger(root, { ts: new Date().toISOString(), phase: "refused", tier: ev.tier, relPath: rel, reason: ver.reason, result: "refused" });
      continue;
    }
    // 删前证据：日志大小 + sha256 + 首末事件时间
    const logFile = ev.logFiles.length ? path.join(ev.dir, ev.logFiles[0].name) : null;
    let logBytes = 0, logSha = null;
    if (logFile) {
      try { logBytes = fs.statSync(logFile).size; } catch { /* 忽略 */ }
      logSha = hashFile(logFile);
    }
    const base = {
      ts: new Date().toISOString(), action: "delete", tier: ev.tier,
      relPath: rel, absPath: ver.real,
      sizeBytes: ev.totalBytes, logName: ev.primaryLog || null, logBytes,
      sha256: logSha,
      firstEventTime: ev.firstEventTime ? new Date(ev.firstEventTime).toISOString() : null,
      lastEventTime: ev.lastEventTime ? new Date(ev.lastEventTime).toISOString() : null,
      lastType: ev.lastType || null,
      mtime: ev.dirMtime ? new Date(ev.dirMtime).toISOString() : null,
    };
    // ① 先写 intent（删前落账，作为可追溯凭据）
    if (!appendLedger(root, { ...base, phase: "intent", result: "intent" })) {
      result.failed++;
      console.log(`  [FAIL] ${rel} —— 台账写入失败，放弃删除（安全优先）`);
      continue;
    }
    // ② 真删
    let ok = false, errMsg = null;
    try {
      fs.rmSync(ver.real, { recursive: true, force: false });
      ok = true;
    } catch (e) { errMsg = String((e && e.message) || e); }
    // ③ 删后写 result
    appendLedger(root, { ...base, phase: "result", result: ok ? "ok" : "error", error: errMsg });
    if (ok) {
      result.deleted++;
      result.freedBytes += ev.totalBytes;
      result.records.push({ relPath: rel, tier: ev.tier, sizeBytes: ev.totalBytes, sha256: logSha });
      console.log(`  [DELETED] ${ev.tier} ${fmtBytes(ev.totalBytes).padStart(9)}  ${rel}`);
    } else {
      result.failed++;
      console.log(`  [FAIL] ${rel} —— ${errMsg}`);
    }
  }
  // 删除后剩余目录数
  let remain = 0;
  try {
    for (const w of fs.readdirSync(root, { withFileTypes: true })) {
      if (!w.isDirectory() || w.name.startsWith(".")) continue;
      try { remain += fs.readdirSync(path.join(root, w.name), { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).length; } catch { /* 忽略 */ }
    }
  } catch { remain = -1; }
  console.log("\n" + "─".repeat(100));
  console.log(`[APPLY 完成] 候选池=${pool.length}  本次选中=${result.attempted}  实删=${result.deleted}  失败=${result.failed}  拒绝=${result.refused}  释放=${fmtBytes(result.freedBytes)}  剩余会话目录≈${remain}`);
  console.log(`台账：${ledger}（intent/result 成对追加；C 档在任何参数下都不会被删）`);
  return { rep, result };
}

// ────────────────────────────── 自测（os.tmpdir 造数） ──────────────────────────────
function selftest() {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || "" }); };
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "prune-selftest-"));
  const root = path.join(tmpBase, "sessions");
  const ws = path.join(root, "--ws-fake--");
  fs.mkdirSync(ws, { recursive: true });
  const now = Date.now();

  const wlog = (dir, fileName, events) => {
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, fileName), zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  };
  const mk = (name, opts = {}) => {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.empty) {
      // 空壳：无文件
    } else {
      const header = { type: "session", version: 4, id: name, createdAt: now - (opts.ageDays || 0) * DAY, cwd: "E:\\fake" };
      if (opts.sub) { header.origin = "subagent"; header.parentSession = "session-00000000-0000-4000-8000-000000000000"; }
      const events = [header];
      if (opts.kind === "end") {
        events.push({ type: "turn/start", seq: 2, time: (opts.ageDays || 0) ? now - opts.ageDays * DAY : now, data: { turn: 1 } });
        events.push({ type: "turn/end", seq: 3, time: (opts.ageDays || 0) ? now - opts.ageDays * DAY : now, data: { turn: 1, reason: { kind: "completed" } } });
      } else if (opts.kind === "noend") {
        events.push({ type: "agent/inbox/spliced", seq: 2, time: now - (opts.ageDays || 0) * DAY, data: {} });
      }
      wlog(dir, opts.logName || "session.v4.jsonl.zstd", events);
    }
    const t = new Date(now - (opts.ageDays || 0) * DAY);
    try { fs.utimesSync(dir, t, t); } catch { /* 忽略 */ }
    for (const f of fs.readdirSync(dir)) {
      try { fs.utimesSync(path.join(dir, f), t, t); } catch { /* 忽略 */ }
    }
    return dir;
  };

  // 造数：A×2 / B×1 / C×1 / 正常主会话×1 / mismatch×1 / 越界×1
  const A1 = mk("11111111-1111-4111-8111-111111111111", { sub: true, kind: "end", ageDays: 30 });
  const A2 = mk("22222222-2222-4222-8222-222222222222", { sub: true, kind: "end", ageDays: 20, logName: "session.v3.jsonl.zstd" });
  const B1 = mk("33333333-3333-4333-8333-333333333333", { empty: true, ageDays: 3 });
  const C1 = mk("session-44444444-4444-4444-8444-444444444444", { kind: "end", ageDays: 100 });
  const M1 = mk("session-55555555-5555-4555-8555-555555555555", { kind: "end", ageDays: 1 });
  const M2 = mk("session-66666666-6666-4666-8666-666666666666", { sub: true, kind: "end", ageDays: 30 });
  const outside = path.join(tmpBase, "outside-77777777-7777-4777-8777-777777777777");
  fs.mkdirSync(outside, { recursive: true });
  wlog(outside, "session.v4.jsonl.zstd", [{ type: "session", version: 4, id: "outside", createdAt: now - 30 * DAY, origin: "subagent", parentSession: "session-0" }, { type: "turn/end", seq: 2, time: now - 30 * DAY, data: { reason: { kind: "completed" } } }]);

  // 记录 A1 日志 sha256（台账断言用）
  const a1log = path.join(A1, "session.v4.jsonl.zstd");
  const a1sha = crypto.createHash("sha256").update(fs.readFileSync(a1log)).digest("hex");
  const a1size = fs.statSync(a1log).size;

  // ① 越界拒绝（直接调校验器 + junction 穿越）
  try {
    const realRoot = fs.realpathSync.native(root);
    const v = validateTarget(root, realRoot, outside);
    check("越界目录被 validateTarget 拒绝", !v.ok, v.reason);
    let linkCreated = false;
    const linkPath = path.join(ws, "88888888-8888-4888-8888-888888888888");
    try {
      fs.symlinkSync(outside, linkPath, "junction");
      linkCreated = true;
    } catch (e1) {
      try {
        const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, outside], { encoding: "utf8" });
        linkCreated = r.status === 0 && fs.existsSync(linkPath);
      } catch { linkCreated = false; }
    }
    if (linkCreated) {
      const v2 = validateTarget(root, realRoot, linkPath);
      check("junction 穿越被 realpath 校验拒绝", !v2.ok, v2.reason);
      fs.rmSync(linkPath, { recursive: true, force: true });          // 只拆链接，不删目标
    } else {
      check("junction 穿越被 realpath 校验拒绝", true, "SKIP：无法创建 junction/symlink（环境限制），改用直接校验覆盖");
    }
  } catch (e) { check("越界目录被 validateTarget 拒绝", false, String((e && e.message) || e)); }

  const runCli = (args) => {
    const r = spawnSync(process.execPath, [SELF_PATH, "--sessions-root=" + root, ...args], { encoding: "utf8", timeout: 120000 });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

  // ② 第一轮 --apply --max=1：候选按年龄降序（A1 30d 最老）⇒ 只删 1 个
  const p1 = runCli(["--apply", "--max=1", "--keep-days=7"]);
  check("第一轮 --apply --max=1 退出码 0", p1.status === 0, "status=" + p1.status);
  check("A1（最老）被删", !exists(A1));
  check("A2 仍保留（--max=1 生效）", exists(A2));
  check("B1 仍保留（--max=1 生效）", exists(B1));
  const ledger1 = fs.existsSync(path.join(root, LEDGER_NAME)) ? fs.readFileSync(path.join(root, LEDGER_NAME), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const intent1 = ledger1.find((r) => r.phase === "intent" && r.relPath.endsWith(path.basename(A1)));
  const res1 = ledger1.find((r) => r.phase === "result" && r.relPath.endsWith(path.basename(A1)));
  check("台账有 intent+result 成对记录", !!intent1 && !!res1);
  check("台账 sha256 与删前日志一致", !!intent1 && intent1.sha256 === a1sha, intent1 ? "ledger=" + String(intent1.sha256).slice(0, 12) + " real=" + a1sha.slice(0, 12) : "missing");
  check("台账 logBytes 与删前日志大小一致", !!intent1 && intent1.logBytes === a1size, intent1 ? `ledger=${intent1.logBytes} real=${a1size}` : "missing");
  check("台账 result 标记 ok", !!res1 && res1.result === "ok");
  check("台账记录了首/末事件时间", !!intent1 && !!intent1.firstEventTime && !!intent1.lastEventTime);

  // ③ 第二轮 --only=B：只删 B1，A2 保留
  const p2 = runCli(["--apply", "--only=B", "--keep-days=7"]);
  check("第二轮 --only=B 退出码 0", p2.status === 0, "status=" + p2.status);
  check("B1 被删（空壳）", !exists(B1));
  check("A2 仍保留（--only=B 不删 A）", exists(A2));

  // ④ 第三轮 --only=A：删 A2；C1/M1/M2 永不删
  const p3 = runCli(["--apply", "--only=A", "--keep-days=7"]);
  check("第三轮 --only=A 退出码 0", p3.status === 0, "status=" + p3.status);
  check("A2 被删", !exists(A2));
  check("C1（陈旧主会话）保留", exists(C1));
  check("M1（正常主会话）保留", exists(M1));
  check("M2（名字=session- 但 header 子代理）保留（mismatch 不删）", exists(M2));
  check("越界目录未被删", exists(outside));

  // ⑤ --only=C 被硬编码忽略：不应删任何东西
  const p4 = runCli(["--apply", "--only=C"]);
  check("--only=C 退出码 0", p4.status === 0, "status=" + p4.status);
  check("--only=C 未删 C1（硬编码忽略 C）", exists(C1));
  check("--only=C 输出提示忽略 C", /忽略|C 永远|永不删/.test(p4.out), "");

  // ⑥ 台账统计：3 次成功删除 => 3 条 result=ok + 3 条 intent
  const ledgerAll = fs.readFileSync(path.join(root, LEDGER_NAME), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const okResults = ledgerAll.filter((r) => r.phase === "result" && r.result === "ok");
  const intents = ledgerAll.filter((r) => r.phase === "intent");
  check("台账 result=ok 条数 = 3", okResults.length === 3, "got " + okResults.length);
  check("台账 intent 条数 = 3", intents.length === 3, "got " + intents.length);

  // ⑦ dry-run 不写台账/不删
  const root2 = path.join(tmpBase, "sessions2");
  const ws2 = path.join(root2, "--ws2--");
  fs.mkdirSync(ws2, { recursive: true });
  const D = path.join(ws2, "99999999-9999-4999-8999-999999999999");
  fs.mkdirSync(D, { recursive: true });
  wlog(D, "session.v4.jsonl.zstd", [{ type: "session", version: 4, id: "d", createdAt: now - 30 * DAY, origin: "subagent", parentSession: "session-0" }, { type: "turn/end", seq: 2, time: now - 30 * DAY, data: { reason: { kind: "completed" } } }]);
  const t = new Date(now - 30 * DAY);
  try { fs.utimesSync(D, t, t); fs.utimesSync(path.join(D, "session.v4.jsonl.zstd"), t, t); } catch { /* 忽略 */ }
  const p5 = spawnSync(process.execPath, [SELF_PATH, "--sessions-root=" + root2], { encoding: "utf8", timeout: 120000 });
  check("dry-run（默认）退出码 0", p5.status === 0, "status=" + p5.status);
  check("dry-run 不删目录", exists(D));
  check("dry-run 不写台账", !fs.existsSync(path.join(root2, LEDGER_NAME)));

  // 清理 tmp
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log("═".repeat(96));
  console.log(`prune-sessions 自测：${pass}/${results.length} PASS，${fail} FAIL（造数根=${tmpBase}，已清理）`);
  console.log("═".repeat(96));
  for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? "  —— " + r.detail : ""}`);
  return fail === 0;
}

// ────────────────────────────── main ──────────────────────────────
function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error("参数错误：" + ((e && e.message) || e));
    process.exitCode = 2;
    return;
  }
  if (opt.help) { printHelp(); return; }
  if (opt.mode === "selftest") { process.exitCode = selftest() ? 0 : 1; return; }

  if (!fs.existsSync(opt.root) || !fs.statSync(opt.root).isDirectory()) {
    console.error(`sessions 根不存在或不是目录：${opt.root}`);
    process.exitCode = 2;
    return;
  }
  if (opt.apply) {
    const { rep } = runApply(opt.root, opt);
    if (opt.json) process.stdout.write(JSON.stringify({ mode: "apply", root: opt.root, report: { ...rep, tiers: undefined, orderByAge: undefined } }, null, 2) + "\n");
    return;
  }
  // report（只读）
  const scan = scanRoot(opt.root);
  const dirs = classifyDirs(scan.dirs, opt);
  const rep = buildReport({ ...scan, dirs }, opt);
  if (opt.json) {
    process.stdout.write(JSON.stringify({
      mode: "report", root: rep.root, generatedAt: rep.generatedAt, scanMs: rep.scanMs,
      counts: rep.counts, cls: rep.cls, clsBytes: rep.clsBytes,
      tierStats: rep.tierStats, retained: rep.retained, daily30: rep.daily30,
      tiers: {
        A: rep.tiers.A.map((e) => ({ relPath: relOf(rep.root, e.dir), bytes: e.totalBytes, ageDays: +e.ageDays.toFixed(2), lastType: e.lastType, lastEventTime: e.lastEventTime ? new Date(e.lastEventTime).toISOString() : null })),
        B: rep.tiers.B.map((e) => ({ relPath: relOf(rep.root, e.dir), bytes: e.totalBytes, ageDays: +e.ageDays.toFixed(2), lastType: e.lastType })),
        C: rep.tiers.C.map((e) => ({ relPath: relOf(rep.root, e.dir), bytes: e.totalBytes, ageDays: +e.ageDays.toFixed(2), lastType: e.lastType })),
      },
      applyHint: `--apply --only=A,B --keep-days=${opt.keepDays} --max=${opt.max}`,
    }, null, 2) + "\n");
    return;
  }
  printReport(rep, opt);
  console.log(`\n提示：以上为只读盘点。真删需 --apply（只删 A/B；C 永不删），建议先拿本清单向用户确认。`);
}

main();
