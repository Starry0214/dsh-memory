#!/usr/bin/env node
/**
 * p4-reuse-probe.mjs —— P4-B「writer 子代理会话复用」离线可行性探针（只读，不 spawn、不联网）
 *
 * 背景（Lead 已实测）：
 *   dsh-memory 每次压缩 spawn 一个检查点 writer 子代理（label `dsh-memory-压缩-intent-<id8>`），
 *   每个请求带 325 个工具定义 ≈ 100K tokens；用户观察缓存命中率 0~93% 波动，问「同一会话的检查子代理
 *   上下文能不能复用」。
 *
 * 本探针不重启宿主、不调 subagents，只读 ~/.dsh/sessions 下已落盘的会话日志（zstd jsonl 多帧），
 * 回答三个问题（全部用真实历史数据）：
 *   1) 每个 writer 的请求前缀有多大：tools 数量 / tools JSON 字符数 / system 字符数 / 注入消息字符数 /
 *      实测 usage（注意：宿主把 cacheReadTokens **另计**，totalTokens = input + cacheRead + output）；
 *   2) 「0% 命中」到底发生在什么时候：按 tools JSON 指纹分组，看每组第一个 writer vs 后续 writer；
 *   3) 若复用同一 writer 子会话，第二次请求的理论前缀构成与计费对比（新 spawn vs 复用第 N 轮）。
 *   + 附：从真实「被复用过的子会话」日志里取每轮首请求的缓存命中，作为跨空闲间隔复用的经验证据。
 *
 * 用法：
 *   node _verify/p4-reuse-probe.mjs                    # 当前工作目录对应 workspace，最近 12 个 writer
 *   node _verify/p4-reuse-probe.mjs --all              # 全部 workspace 的 writer（慢）
 *   node _verify/p4-reuse-probe.mjs --limit 20         # 最多看 20 个 writer
 *   node _verify/p4-reuse-probe.mjs --label 压缩       # 自定义 label 过滤（默认 dsh-memory-压缩-intent）
 *   node _verify/p4-reuse-probe.mjs --workspace <目录名># 指定 ~/.dsh/sessions/<目录名>
 *   node _verify/p4-reuse-probe.mjs --json             # 机器可读（stdout 只输出 JSON）
 *   node _verify/p4-reuse-probe.mjs --help
 *
 * 数据口径（重要，来自实测日志，勿想当然）：
 *   - assistant/message.data.usage = { inputTokens, outputTokens, totalTokens, cacheReadTokens }
 *     其中 **inputTokens 是"未命中缓存"的输入**，cacheReadTokens 单独计；
 *     totalTokens = inputTokens + cacheReadTokens + outputTokens（本探针会断言此关系，不符则标记 peculiar）。
 *   - 缓存单价比（用户/AGENTS.md 口径）：命中 0.1 元/M，未命中 1 元/M
 *     ⇒ 本探针用「token-units = 未命中 tokens×1 + 命中 tokens×0.1」做成本对比。
 *   - request/header 事件记录**该会话首次请求**的完整 header：{ config, adapterDefaults, tools:[...] }；
 *     同会话后续请求只在变化时再记（reason = initial / resume / series）。
 *   - system/message 事件是 system prompt 快照；user/message 事件按 data.source.kind 区分
 *     用户正文 vs 注入上下文（agent-instructions / runtime-context / skill-catalog / time-context / ...）。
 *
 * 只读保证：本脚本只读 ~/.dsh/sessions（以及 import 插件 index.js 的纯函数），不写任何文件。
 *   导入插件是为了复用**唯一的**多帧 zstd 解码器（index.js: decodeSessionLog）——
 *   实测整文件 zstdDecompressSync 只解出第一帧且不报错，会静默丢 99.99% 内容。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const HOMEDIR = os.homedir();
const SESS_ROOT = path.join(HOMEDIR, ".dsh", "sessions");
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const CACHE_PRICE_RATIO = 0.1;          // 缓存命中 0.1x 未命中价
const DEFAULT_LABEL = "dsh-memory-压缩-intent";
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// ────────────────────────── CLI ──────────────────────────
const argv = process.argv.slice(2);
const opt = {
  all: argv.includes("--all"),
  json: argv.includes("--json"),
  help: argv.includes("--help") || argv.includes("-h"),
  limit: 12,
  label: DEFAULT_LABEL,
  workspace: null,
  reusedSamples: 6,
  before: 0,
  maxDirs: 300,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--limit") opt.limit = Math.max(1, parseInt(argv[++i], 10) || 12);
  else if (a === "--label") opt.label = String(argv[++i] || DEFAULT_LABEL);
  else if (a === "--workspace") opt.workspace = String(argv[++i] || "");
  else if (a === "--reused") opt.reusedSamples = Math.max(0, parseInt(argv[++i], 10) || 6);
  else if (a === "--max-dirs") opt.maxDirs = Math.max(20, parseInt(argv[++i], 10) || 300);
  else if (a === "--before") opt.before = Math.max(0, parseInt(argv[++i], 10) || 0);   // 只算「此刻之前 N 小时」的 writer，避开正在跑的
}
if (opt.help) {
  console.log(`p4-reuse-probe.mjs —— writer 子代理会话复用离线探针（只读）
用法: node _verify/p4-reuse-probe.mjs [--all] [--limit N] [--label 子串] [--workspace 子串] [--reused N] [--before N] [--max-dirs N] [--json]
  --all           扫描 ~/.dsh/sessions 下全部 session 目录（默认按 mtime 只扫最新 ${300} 个，够用且快）
  --limit N       最多分析 N 个 writer（默认 12，按创建时间倒序）
  --label 子串    writer label 过滤子串（默认 "${DEFAULT_LABEL}"）
  --workspace S   只扫 workspace 目录名包含 S 的（如 "--E-~5DE5~"；默认不限制）
  --reused N      额外分析 N 个「多轮复用子会话」的每轮首请求缓存（默认 6，0=关闭）
  --before N      只看创建时间早于 N 小时前的 writer（避开正在运行/刚落盘的）
  --max-dirs N    默认扫描的最新 session 目录数（默认 300；--all 时忽略）
  --json          只输出 JSON`);
  process.exit(0);
}

// ────────────────────── 解码器（真实现优先） ──────────────────────
/** 多帧 zstd 解码：优先用插件 index.js 导出的唯一实现；导入失败时用本文件内的等价兜底。 */
let decodeFn = null;
let decoderSource = "";
try {
  const mod = await import(pathToFileURL(PLUGIN).href);
  if (typeof mod.decodeSessionLog === "function") {
    decodeFn = (filePath) => {
      const r = mod.decodeSessionLog(filePath);
      return { text: r && r.text ? r.text : "", frames: (r && r.frames) || 0, okFrames: (r && r.okFrames) || 0 };
    };
    decoderSource = "plugin:index.js decodeSessionLog（真实现）";
  }
} catch (e) {
  decoderSource = "fallback（插件导入失败：" + String((e && e.message) || e).slice(0, 80) + "）";
}
if (!decodeFn) {
  const scanFrames = (buf) => {
    const out = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) out.push(i);
    }
    return out;
  };
  decodeFn = (filePath) => {
    let buf;
    try { buf = fs.readFileSync(filePath); } catch { return { text: "", frames: 0, okFrames: 0 }; }
    const offs = scanFrames(buf);
    const chunks = [];
    let ok = 0;
    for (const off of offs) {
      try { chunks.push(zlib.zstdDecompressSync(buf.subarray(off))); ok++; } catch { /* 坏帧只丢该帧 */ }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), frames: offs.length, okFrames: ok };
  };
}

// ────────────────────── 会话日志发现 ──────────────────────
const LOG_ORDER = ["session.jsonl.zstd", "session.v3.jsonl.zstd", "session.v4.jsonl.zstd"];

/** 列出全部 session 目录（ws/sid），带 mtime；按 mtime 倒序。
 *  默认只看最新的 opt.maxDirs 个（避免遍历全部历史）；--all 时不设上限。
 *  metadata-only：不解码，先按目录/file 名筛，解码留给调用方（readSessionText）。 */
function listSessionDirs() {
  const out = [];
  let wss = [];
  try { wss = fs.readdirSync(SESS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const ws of wss) {
    if (!ws.isDirectory()) continue;
    if (opt.workspace && !ws.name.includes(opt.workspace)) continue;
    let sids = [];
    try { sids = fs.readdirSync(path.join(SESS_ROOT, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const sid of sids) {
      if (!sid.isDirectory()) continue;
      const dir = path.join(SESS_ROOT, ws.name, sid.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      const logs = LOG_ORDER.filter((f) => files.includes(f));
      if (!logs.length) continue;
      const newest = logs[logs.length - 1];
      let st = null;
      try { st = fs.statSync(path.join(dir, newest)); } catch { continue; }
      out.push({ ws: ws.name, sid: sid.name, dir, logs, mtime: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return opt.all ? out : out.slice(0, opt.maxDirs);
}

/** 读一个 session 目录的完整事件文本。
 *  快路径：整文件 zstdDecompressSync（Node 24 可解多帧，速度接近原生解压）；
 *  慢/兜底路径：仅在快路径拿不到 session 头时，才用插件的逐帧扫描解码器（字节级扫描，大文件很慢）。
 *  安全阀：单个文件 > 8MB 或预计解压 > 192MB 时跳过该文件（并联笔记 skipped），绝不 toString 出 512MB+ 字符串。 */
function readSessionText(dir, logs) {
  const parts = [];
  let frames = 0, okFrames = 0, bytes = 0, skipped = 0;
  const MAX_FILE = 8 * 1024 * 1024;
  const MAX_DECODED = 192 * 1024 * 1024;
  for (const f of logs) {
    const p = path.join(dir, f);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    bytes += st.size;
    if (st.size > MAX_FILE) { skipped++; continue; }
    let buf = null;
    try { buf = fs.readFileSync(p); } catch { skipped++; continue; }
    // 帧数：原生 indexOf 扫 magic（NaN 级成本，比逐字节 JS 循环快 ~100x）
    const magic = Buffer.from(ZSTD_MAGIC);
    for (let pos = 0; ; ) {
      const at = buf.indexOf(magic, pos);
      if (at < 0) break;
      frames++; pos = at + 4;
    }
    let text = "";
    try {
      const out = zlib.zstdDecompressSync(buf);
      if (out.length <= MAX_DECODED) { text = out.toString("utf8"); okFrames = frames; }
    } catch { /* 快路径失败 ⇒ 走兜底 */ }
    if (!text || (!text.includes('"type":"session"') && !text.includes('"type":"turn/start"'))) {
      const r = decodeFn(p);                                // 插件真实现（慢但正确）
      if (r && r.text) { text = r.text; okFrames = r.okFrames || okFrames; frames = r.frames || frames; }
    }
    if (text) parts.push(text);
  }
  return { text: parts.join("\n"), frames, okFrames, bytes, skipped };
}

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const fmtInt = (n) => (Number(n) || 0).toLocaleString("en-US");
const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "-");
const hoursAgo = (ms) => (ms ? ((Date.now() - ms) / 3600e3).toFixed(1) + "h前" : "-");
const textOfBlocks = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");

// ────────────────────── 单个 writer 的解析 ──────────────────────
/**
 * 解析一个会话：返回
 *   { header, descriptor, events, turns, reqHeaders[], usages[], userMsgs[], sysText, endKind, endTime }
 */
function parseSession(text) {
  const events = text.split("\n").filter(Boolean);
  const parsed = [];
  let header = null;
  const reqHeaders = [];
  const usages = [];
  const userMsgs = [];
  const turns = new Map();          // turn → { firstUsage, count }
  let sysText = "";
  let descriptor = null;
  let endKind = null, endTime = 0, lastTime = 0, firstTime = 0;
  let badLines = 0;
  for (const line of events) {
    let j;
    try { j = JSON.parse(line); } catch { badLines++; continue; }
    const d = j.data || {};
    if (!firstTime && typeof j.time === "number") firstTime = j.time;
    if (typeof j.time === "number") lastTime = j.time;
    switch (j.type) {
      case "session": header = j; break;
      case "subagent/descriptor": descriptor = d; break;
      case "system/message": {
        const t = textOfBlocks((d.message && d.message.content) || d.content);
        if (t.length > sysText.length) sysText = t;
        break;
      }
      case "request/header": {
        const h = (d && d.header) || null;
        const tools = (h && Array.isArray(h.tools)) ? h.tools : [];
        reqHeaders.push({
          reason: d && d.reason,
          time: j.time,
          tools: tools.length,
          toolsChars: JSON.stringify(tools).length,
          toolsHash: tools.length ? sha16(JSON.stringify(tools)) : null,
          config: (h && h.config) || null,
        });
        break;
      }
      case "user/message": {
        const t = textOfBlocks(d.content);
        userMsgs.push({ kind: (d.source && d.source.kind) || "?", chars: t.length });
        break;
      }
      case "assistant/message": {
        const u = d.usage || {};
        const t = Number(d.turn) || 0;
        const rec = {
          turn: t, step: d.step,
          input: Number(u.inputTokens) || 0,
          cache: Number(u.cacheReadTokens) || 0,
          output: Number(u.outputTokens) || 0,
          total: Number(u.totalTokens) || 0,
        };
        usages.push(rec);
        if (!turns.has(t)) turns.set(t, { firstUsage: rec, count: 0 });
        turns.get(t).count++;
        break;
      }
      case "turn/end":
        endKind = (d.reason && d.reason.kind) || null;
        endTime = j.time || lastTime;
        break;
      default: break;
    }
  }
  // 排序（多日志文件拼接后 time 可能交错，按 time 稳定排序）
  usages.sort((a, b) => (a.turn - b.turn) || ((a.step || 0) - (b.step || 0)));
  return { header, descriptor, events, reqHeaders, usages, userMsgs, turns, sysText, endKind, endTime, firstTime, lastTime, badLines };
}

/** 从 parsed 里汇总 writer 记录。 */
function summarizeWriter(dirInfo, parsed, textInfo) {
  const h = parsed.header || {};
  const desc = parsed.descriptor || {};
  const req = parsed.reqHeaders[0] || null;
  const firstU = parsed.usages[0] || null;
  const sum = parsed.usages.reduce(
    (a, u) => ({ input: a.input + u.input, cache: a.cache + u.cache, output: a.output + u.output }),
    { input: 0, cache: 0, output: 0 },
  );
  const promptTokens = sum.input + sum.cache;             // 该会话全部请求的 prompt tokens（含缓存命中）
  const hitPct = promptTokens ? (sum.cache / promptTokens) * 100 : 0;
  const promptUserChars = parsed.userMsgs.filter((m) => m.kind === "user").reduce((a, m) => a + m.chars, 0);
  const injectChars = parsed.userMsgs.filter((m) => m.kind !== "user").reduce((a, m) => a + m.chars, 0);
  const timeToTok = promptUserChars > 0 && firstU && firstU.input > 0 ? firstU.input / Math.max(1, promptUserChars) : null;
  const usageOk = parsed.usages.every((u) => Math.abs(u.total - (u.input + u.cache + u.output)) <= 2);
  const cfg = (req && req.config) || {};
  const provider = cfg.provider || null;
  const model = cfg.model || null;
  return {
    childId: dirInfo.sid,
    workspace: dirInfo.ws,
    createdAt: h.createdAt || parsed.firstTime || null,
    label: desc.label || "",
    origin: h.origin || "",
    parentSession: h.parentSession || "",
    agentPreset: h.agentPreset || null,
    provider,
    model,
    modelKey: (provider || "?") + "/" + (model || "?"),
    endKind: parsed.endKind,
    endTime: parsed.endTime,
    turns: parsed.turns.size,
    steps: parsed.usages.length,
    events: parsed.events.length,
    badLines: parsed.badLines,
    frames: textInfo.frames,
    okFrames: textInfo.okFrames,
    req: req,
    firstUsage: firstU,
    sum,
    promptTokens,
    hitPct,
    promptUserChars,
    injectChars,
    sysChars: parsed.sysText.length,
    timeToTok,
    usageOk,
    perTurn: [...parsed.turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([turn, v]) => ({
        turn,
        steps: v.count,
        firstIn: v.firstUsage.input,
        firstCache: v.firstUsage.cache,
        hitPct: (v.firstUsage.input + v.firstUsage.cache) ? (v.firstUsage.cache / (v.firstUsage.input + v.firstUsage.cache)) * 100 : 0,
      })),
  };
}

// ────────────────────── 理论复用成本模型 ──────────────────────
/**
 * 「新 spawn（当前做法）」 vs 「复用同一子会话第 2/3/4/5 轮」的计费对比。
 *
 * 口径（关键，决定结论）：
 *   - 单价：未命中 1.0x、命中（cacheRead）0.1x（DeepSeek 口径；token-units = 未命中 + 0.1×命中）；
 *   - 静态前缀 S = tools + system + 固定注入消息 + 固定注入上下文。实测同规格 writer 的 cacheRead
 *     稳定在 94K~96K；冷启动 writer（cacheRead≈0）用 tools JSON 字符数 / 3.7 反推 S（实测 348,842/3.7≈94,282）；
 *   - 每轮材料 M = 宿主压缩摘要 + 最近对话原文 + todo/goal（writer 的 input 未命中量；冷启动时 input 里
 *     混着 S，用 user 正文 + 注入消息字符数 / 1.15 反推）；
 *   - 每轮输出 O ≈ outputTokens（会进入下一轮历史）。
 *
 * 两个场景分开算，避免「冷启动那一次」误导结论：
 *   (暖) 静态前缀已在 provider 缓存：新 spawn 每轮 = M + 0.1·S；
 *        复用第 n 轮 = M + 0.1·(S + (n-1)(M+O)) ⇒ 只多付 0.1×历史，恒贵且随轮次线性增长。
 *   (冷) 后缀/前缀刚变（重启、MCP 增删、模型路由变更）：新 spawn 每轮 = M + S；
 *        复用同样冷（前缀头不同，历史也不命中）⇒ 更贵，且不会因为复用而"必然命中"。
 *   ⇒ 复用在两种场景下都不省；真正的省法是缩小 S（P4-A preset）。
 */
function reuseCostModel(w, extraTurns = [2, 3, 4, 5]) {
  const u = w.firstUsage || {};
  const observedS = Number(u.cache) || 0;
  const observedM = Number(u.input) || 0;
  const O = Number(u.output) || 0;
  const toolsChars = (w.req && w.req.toolsChars) || 0;
  // 静态前缀估算：tools JSON 实测 ~3.7 字符/token；observedS 明显小于该估计 ⇒ 该次是「部分命中/冷启动」，
  // 仍按估算的完整前缀算账（这样两种场景都可比）。
  const expectedS = Math.round(toolsChars / 3.7);
  const Sest = Math.max(observedS, expectedS);
  const totalPrompt = observedS + observedM;
  const materialEst = Math.round(((w.promptUserChars || 0) + (w.injectChars || 0) * 0.35) / 1.3);
  const M = totalPrompt > Sest ? Math.max(1, totalPrompt - Sest) : Math.max(1, materialEst);
  const hitState = observedS > 0.5 * Sest ? "warm" : "cold";
  const warmFresh = M + CACHE_PRICE_RATIO * Sest;
  const coldFresh = M + Sest;
  const rows = [];
  let hist = Sest + M;                                            // 第 1 轮 prompt tokens（下一轮前缀）
  for (const n of extraTurns) {
    const unitsWarm = M + CACHE_PRICE_RATIO * hist;               // 本节材料未命中 + 历史全命中
    rows.push({
      turn: n,
      prefixTokens: Math.round(hist),
      newTokens: M,
      units: Math.round(unitsWarm),
      deltaVsFresh: Math.round(unitsWarm - warmFresh),
      deltaPct: warmFresh ? ((unitsWarm - warmFresh) / warmFresh) * 100 : 0,
    });
    hist += M + O;
  }
  const reuseTotal2 = rows[0] ? (coldFresh + rows[0].units) : null;   // 首次冷 spawn + 第二次复用
  const freshTotal2 = coldFresh + warmFresh;                          // 两次新 spawn（第一次冷、第二次暖）
  return {
    S: Math.round(Sest),
    M: Math.round(M),
    O: Math.round(O),
    hitState,
    warmFreshUnits: Math.round(warmFresh),
    coldFreshUnits: Math.round(coldFresh),
    reuseTotal2Units: reuseTotal2 === null ? null : Math.round(reuseTotal2),
    freshTotal2Units: Math.round(freshTotal2),
    rows,
  };
}

// ────────────────────── 输出 ──────────────────────
const out = { generatedAt: new Date().toISOString(), decoder: decoderSource, opt, writers: [], writerGroups: [], reusedSessions: [], notes: [] };
const R = opt.json ? null : "\n";

function log(...args) {
  if (opt.json) return;
  console.log(...args);
}

// ── 1) 收集 writer ──
//  两段式：先用「整文件 zstdDecompressSync」做廉价预筛（Node 24 可一次解开整个多帧日志，
//  但不保证所有帧形态；仅用于判断 label 是否命中），命中后再用插件权威多帧解码器复解一遍。
const cheapDecode = (filePath) => {
  try { return zlib.zstdDecompressSync(fs.readFileSync(filePath)).toString("utf8"); } catch { return ""; }
};
const cutoff = opt.before > 0 ? Date.now() - opt.before * 3600e3 : 0;
const dirs = listSessionDirs();
let scanned = 0;
let prefilterHit = 0;
for (const d of dirs) {
  if (out.writers.length >= opt.limit) break;
  scanned++;
  if (d.size < 40 * 1024 || d.size > 4 * 1024 * 1024) continue;   // writer 单轮日志 ~100-400KB；超大/空壳直接跳过
  const headFile = path.join(d.dir, d.logs[0]);
  const newestFile = path.join(d.dir, d.logs[d.logs.length - 1]);
  let header = null;
  try { header = JSON.parse(cheapDecode(headFile).split("\n", 1)[0]); } catch { header = null; }
  if (!header || header.origin !== "subagent") continue;            // 先按 session 头排除主会话（便宜且稳）
  if (cutoff && header.createdAt && header.createdAt > cutoff) continue;
  const bodyText = headFile === newestFile ? cheapDecode(headFile) : cheapDecode(newestFile);
  if (!bodyText || !bodyText.includes(opt.label)) continue;         // 廉价预筛（可能被"任务描述里提到 label"的普通子代理误命中）
  prefilterHit++;
  const info = readSessionText(d.dir, d.logs);                      // 权威多帧解码（插件真实现）
  if (!info.text) continue;
  const parsed = parseSession(info.text);
  const label = (parsed.descriptor && parsed.descriptor.label) || "";
  if (!label || !label.includes(opt.label)) continue;               // 以 descriptor.label 为准（真正的 writer 才算）
  out.writers.push(summarizeWriter(d, parsed, info));
}

// ── 2) 按「模型路由 + tools JSON 指纹」分组（验证「0% 命中 = 前缀池刚换」） ──
//   前缀池 = provider/model（system prompt 里含模型显示名 + 缓存按 provider 分池）× tools 定义；
//   任一变化都会让下一批 writer 冷启动，直到有一次请求把新前缀暖起来。
const groups = new Map();
for (const w of out.writers) {
  const k = (w.modelKey || "?") + " | " + (w.req && w.req.toolsHash ? w.req.toolsHash : "(no-header)");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(w);
}
for (const [k, arr] of groups) {
  arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  out.writerGroups.push({
    modelKey: arr[0].modelKey,
    toolsHash: arr[0].req ? arr[0].req.toolsHash : null,
    tools: arr[0].req ? arr[0].req.tools : null,
    toolsChars: arr[0].req ? arr[0].req.toolsChars : null,
    count: arr.length,
    firstHitPct: arr[0].hitPct,
    restAvgHitPct: arr.length > 1 ? arr.slice(1).reduce((a, w) => a + w.hitPct, 0) / (arr.length - 1) : null,
    first: arr[0].childId.slice(0, 8),
  });
}
out.writerGroups.sort((a, b) => b.count - a.count);

// ── 3) 附：被复用过的子会话（turn ≥ 2），看「跨空闲间隔的复用」真实命中 ──
if (opt.reusedSamples > 0) {
  let n = 0;
  for (const d of dirs) {
    if (n >= opt.reusedSamples) break;
    if (d.size < 200 * 1024) continue;                     // 太小的多半只有一轮
    if (d.size > 8 * 1024 * 1024) continue;                // 超大会话解码成本高
    const head = cheapDecode(path.join(d.dir, d.logs[0]));
    let header = null;
    try { header = JSON.parse(head.split("\n", 1)[0]); } catch { header = null; }
    if (!header || header.origin !== "subagent") continue;
    if (!head.includes("turn/start")) continue;
    const info = readSessionText(d.dir, d.logs);
    if (!info.text) continue;
    const parsed = parseSession(info.text);
    if (parsed.turns.size < 2) continue;
    const perTurn = [...parsed.turns.entries()].sort((a, b) => a[0] - b[0]).map(([turn, v]) => {
      const tot = v.firstUsage.input + v.firstUsage.cache;
      return {
        turn,
        steps: v.count,
        firstIn: v.firstUsage.input,
        firstCache: v.firstUsage.cache,
        hitPct: tot ? (v.firstUsage.cache / tot) * 100 : 0,
      };
    });
    // 轮间空闲间隔：用 turn/end 到下一 turn/start 的时间差（事件 time）
    const gaps = [];
    let lastEnd = null;
    for (const line of info.text.split("\n")) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "turn/end") lastEnd = j.time;
      else if (j.type === "turn/start" && lastEnd) { gaps.push(Math.round((j.time - lastEnd) / 1000)); lastEnd = null; }
    }
    out.reusedSessions.push({
      childId: d.sid,
      label: (parsed.descriptor && parsed.descriptor.label) || "",
      turns: parsed.turns.size,
      perTurn,
      idleGapSec: gaps,
    });
    n++;
  }
}

// ── 4) 控制台报告 ──
if (!opt.json) {
  log("═".repeat(96));
  log("P4-B writer 子代理会话复用 —— 离线探针（只读）");
  log("═".repeat(96));
  log(`解码器：${decoderSource}`);
  log(`扫描：${scanned} 个 session 目录 → 命中 writer ${out.writers.length} 个（label 含 "${opt.label}"，limit=${opt.limit}）`);
  log(`成本口径：token-units = 未命中×1 + 命中×0.1；注意宿主 usage 的 inputTokens 是「未命中输入」，cacheReadTokens 另计`);
  log("");

  for (const w of out.writers) {
    const u = w.firstUsage || {};
    const tot = (u.input || 0) + (u.cache || 0);
    const cm = reuseCostModel(w);
    const cold = cm.hitState !== "warm";
    log("─".repeat(96));
    log(`writer ${w.childId.slice(0, 8)}  ${fmtTime(w.createdAt)} (${hoursAgo(w.createdAt)})  label=${w.label}`);
    log(`  模型路由：${w.modelKey}   父会话=${String(w.parentSession).slice(0, 20)}  preset=${w.agentPreset || "-"}  turns=${w.turns} steps=${w.steps} 事件=${w.events} 帧=${w.okFrames}/${w.frames}${w.badLines ? " 坏行=" + w.badLines : ""}`);
    log(`  请求前缀：tools=${w.req ? w.req.tools : "?"} 个 / tools JSON ${fmtInt(w.req ? w.req.toolsChars : 0)} 字符 / system ${fmtInt(w.sysChars)} 字符 / 注入消息 ${fmtInt(w.injectChars)} 字符 / 用户正文 ${fmtInt(w.promptUserChars)} 字符`);
    log(`  首请求 usage：input=${fmtInt(u.input)}  cacheRead=${fmtInt(u.cache)}  output=${fmtInt(u.output)}  total=${fmtInt(u.total)}  → 命中率 ${tot ? (u.cache / tot * 100).toFixed(1) : "-"}%${w.usageOk ? "" : "  ⚠ usage 不自洽"}`);
    if (w.steps > 1) {
      log(`  全会话累计：未命中 ${fmtInt(w.sum.input)} + 命中 ${fmtInt(w.sum.cache)} = prompt ${fmtInt(w.promptTokens)} tokens，整体命中 ${w.hitPct.toFixed(1)}%`);
    }
    log(`  turn/end=${w.endKind || "-"}  ${cold ? "【冷启动/部分命中：静态前缀未暖 → 该次按 1.0x 计费】" : "【静态前缀已暖】"}`);

    log(`  复用成本模型（S=静态前缀≈${fmtInt(cm.S)} tokens, M=每轮材料≈${fmtInt(cm.M)}, O=每轮输出≈${fmtInt(cm.O)}）：`);
    log(`    新 spawn 单轮：暖 ${fmtInt(cm.warmFreshUnits)} units ／ 冷 ${fmtInt(cm.coldFreshUnits)} units`);
    log(`    「首次冷 + 第二次复用」 vs 「两次新 spawn（首冷次暖）」：${fmtInt(cm.reuseTotal2Units)} vs ${fmtInt(cm.freshTotal2Units)} units（复用 ${cm.reuseTotal2Units > cm.freshTotal2Units ? "更贵 +" + fmtInt(cm.reuseTotal2Units - cm.freshTotal2Units) : "省 " + fmtInt(cm.freshTotal2Units - cm.reuseTotal2Units)}）`);
    for (const r of cm.rows) {
      log(`    复用第${r.turn}轮：前缀 ${fmtInt(r.prefixTokens)} tokens 全命中（0.1x）+ 本轮材料 ${fmtInt(r.newTokens)} 未命中 → ${fmtInt(r.units)} units（相对新 spawn(暖) ${r.deltaVsFresh >= 0 ? "+" : ""}${fmtInt(r.deltaVsFresh)}，${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%）`);
    }
    log(`    ⇒ ${cm.rows[0] && cm.rows[0].deltaVsFresh <= 0 ? "复用理论上略省" : "复用理论上**不省**：历史每轮都按 0.1x 计费，新 spawn 只付静态前缀一次 0.1x"}：静态前缀暖时复用从第 2 轮起只会更贵；静态前缀冷时两者都全量，复用还要多背历史。`);
  }

  log("");
  log("═".repeat(96));
  log("按「模型路由 + tools JSON 指纹」分组（验证 0% 命中 = 前缀池刚换，而不是「没复用」）");
  log("═".repeat(96));
  for (const g of out.writerGroups) {
    log(`  ${g.modelKey}  tools=${String(g.tools).padStart(3)} 个  JSON=${fmtInt(g.toolsChars)} 字符  hash=${g.toolsHash}  writer ${g.count} 个`);
    log(`     首个（${g.first}）命中 ${g.firstHitPct.toFixed(1)}%  |  同组后续平均命中 ${g.restAvgHitPct === null ? "-" : g.restAvgHitPct.toFixed(1) + "%"}`);
  }

  if (out.reusedSessions.length) {
    log("");
    log("═".repeat(96));
    log("经验证据：被复用过的子会话（turn≥2）每轮首请求的缓存命中（含轮间空闲间隔）");
    log("═".repeat(96));
    for (const s of out.reusedSessions) {
      log(`  子会话 ${s.childId.slice(0, 8)}  turns=${s.turns}  label=${String(s.label).slice(0, 40)}`);
      for (const t of s.perTurn) {
        const note = t.firstIn > 50000 ? "  ← 该轮前子会话被压缩/重建（前缀整体变了，不是『复用没命中』）" : "";
        log(`     turn ${t.turn}: steps=${String(t.steps).padStart(3)} 首请求 input=${fmtInt(t.firstIn)} cacheRead=${fmtInt(t.firstCache)} 命中=${t.hitPct.toFixed(1)}%${note}`);
      }
      if (s.idleGapSec.length) log(`     轮间空闲间隔(秒)：${s.idleGapSec.slice(0, 8).join(", ")}（用于对照 provider 缓存 TTL：实测 ≤43min 仍全命中，≥9h 失效）`);
    }
  }

  log("");
  log("═".repeat(96));
  log("结论提示（详见 .task/1101-dsh-mimo-survey/14b-reuse-report.md）");
  log("═".repeat(96));
  log("  · 复用机制在宿主侧存在（subagents.sendMessage → coldResume），但复用的**成本** = 每轮把全部历史按 0.1x 计费；");
  log("  · 静态前缀只要暖着，新 spawn 每轮只付一次 0.1x×静态前缀；复用把「每轮材料」也变成永久历史 ⇒ 第2轮起通常更贵；");
  log("  · 真实 0% 命中发生在 tools 指纹变化（MCP 增删/重启）后的首个 writer，复用无法避免（前缀头同样失效）；");
  log("  · 治本是 P4-A（preset 砍工具前缀 105K→~10K），不是复用。");
}

if (opt.json) {
  // JSON 输出：writers 里去掉大字段（保留数值），并附成本模型
  const payload = {
    generatedAt: out.generatedAt,
    decoder: out.decoder,
    writers: out.writers.map((w) => ({ ...w, costModel: reuseCostModel(w) })),
    writerGroups: out.writerGroups,
    reusedSessions: out.reusedSessions,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
} else {
  process.stdout.write("");
}
