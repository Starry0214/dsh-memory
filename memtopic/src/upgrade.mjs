// 阶段6 · 老用户升级编排（upgrade）：detect / plan / apply / rollback / snapshot
//
// 用户硬规则（2026-10-29 追加）：
//   **升级不许静默自动跑** —— 插件只负责"提醒"，由 Agent 手动执行三段式：
//     ① --detect  只读探测 + 人话影响评估 + 建议下一步
//     ② --plan    只读、零写入、可审阅迁移计划
//     ③ --apply --stage=import|curate|apply-merge|all  只有显式调用才执行
//   每段都可被 Agent 单独调用、都有明确退出码；失败时 stderr 必打一行"下一步该做什么"。
//
// 其它硬约束：
//   · 原 md 永不删除/不修改（全程只读 md 侧；报告里给前后 sha 对照）。
//   · schema_version 写入 meta.schema_version（本版 1）；未知高版本 ⇒ 拒绝执行（退出码 2）。
//   · 旧库结构差异容忍：无 H1 / front matter 破损 / CRLF / 混杂非 md，都由 import 解析层吸收。
//   · node:sqlite 不可用 ⇒ 自动降级 ledger（侧车文件 <db>.ledger.jsonl），报告显著标注"降级模式"，
//     且**不碰**原 .db（无法读的 sqlite 库只提示，不做任何写）。
//   · 幂等：重复 --apply ⇒ +0 主题/+0 句；--detect/--plan 纯只读（U09 用库文件 sha 前后一致证明）。
//   · 可回滚：每写阶段前落快照；--rollback=import|curate|apply-merge|all。
//   · 断点续跑：checkpoint.json 记录每阶段状态；已完成阶段跳过，running/failed 重跑该阶段。
//
// 目录约定（state dir，默认 <db 目录>/upgrade）：
//   checkpoint.json                   阶段状态（可续跑）
//   snapshots/<stage>-<ts>.db         写阶段前快照（可 --rollback）
//   upgrade-report-<stage>.json/.txt  每阶段报告（人话 + 机器可读）
//   curation-proposals.json           curate 阶段产出（只读提案）
//
// CLI 用法（Agent/面板提醒文案必须与这里逐字一致）：
//   node <repo>/memtopic/src/upgrade.mjs --detect [--db <file>] [--md-root <dir>] [--backend=auto|sqlite|ledger] [--json]
//   node <repo>/memtopic/src/upgrade.mjs --plan   [--db <file>] [--md-root <dir>] [--json]
//   node <repo>/memtopic/src/upgrade.mjs --apply --stage=import|curate|apply-merge|all [--db <file>] [--md-root <dir>] [--json] [--force]
//   node <repo>/memtopic/src/upgrade.mjs --rollback=<stage|all> [--db <file>] [--state-dir <dir>] [--json]
//   node <repo>/memtopic/src/upgrade.mjs --snapshot [--db <file>] [--state-dir <dir>] [--json]
//   退出码：0 成功/按设计跳过 ｜ 1 参数错误 ｜ 2 拒绝执行（版本过高/前置不满足）｜ 3 阶段失败 ｜ 4 回滚失败
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore, MemError, normalizeName } from './memory-store.mjs';
import {
  DEFAULT_MEMORY_ROOT, DEFAULT_DIRS, DEFAULT_SCAN, scanCorpus, importDir, parseMarkdown,
} from './import.mjs';
import { pickBackendKind } from './detect.mjs';

export const SCHEMA_VERSION = 1;
export const UPGRADE_VERSION = 1;
export const STAGES = ['import', 'curate', 'apply-merge'];
// schema 迁移路径表（本版唯一目标版本 = 1）
export const SCHEMA_PATH_TABLE = Object.freeze({
  0: ['旧库（无 schema_version）：apply import 时补写 schema_version=1（不重写已有主题/句子）'],
  1: ['schema 已是最新（=1），无需迁移步骤；--apply 只做幂等校验'],
});
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3, ROLLBACK_FAILED: 4 });
const SCHEMA_KEY = 'schema_version';
const LAST_IMPORT_KEY = 'last_import_at';
const STATE_SUBDIR = 'upgrade';

// 估算常数（实测区间：465 文件 / 31,093 句 / 384 主题 ⇒ 58.7s–111.5s，取偏保守值给区间上沿）
const EST_MS_PER_SENTENCE = 2.6;
const EST_MS_PER_NEW_TOPIC = 25;
const EST_MS_PER_CLUSTER_MERGE = 30;
const PROPOSALS_FILE = 'curation-proposals.json';

// ---------------------------------------------------------------------------
// 0. 错误 / 工具
// ---------------------------------------------------------------------------
export class UpgradeError extends Error {
  constructor(code, message, { exitCode = EXIT.FAILED, hint = null, detail = null } = {}) {
    super(message);
    this.name = 'UpgradeError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
    this.detail = detail;
  }
}
const sha256File = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sha256Dir = (root, files) => {
  const h = createHash('sha256');
  for (const f of files) h.update(f.rel + '\0' + sha256File(f.abs) + '\n');
  return h.digest('hex');
};
const nowIso = () => new Date().toISOString();
const ms = (t0) => Date.now() - t0;
const fmtMs = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 1. 目标解析（md 根 / 库文件 / 后端 / 降级 / state dir）
// ---------------------------------------------------------------------------
/**
 * 解析升级目标。参数都可选：
 *   opts.mdRoot / opts.dbFile / opts.backend('auto'|'sqlite'|'ledger') / opts.stateDir
 * 默认：mdRoot=~/.dsh/memory，dbFile=<mdRoot>/.memtopic/mem.db，stateDir=<db 目录>/upgrade
 */
export function resolveTargets(opts = {}) {
  const mdRoot = path.resolve(opts.mdRoot || DEFAULT_MEMORY_ROOT);
  const dbFile = path.resolve(opts.dbFile || path.join(mdRoot, '.memtopic', 'mem.db'));
  const backendWant = String(opts.backend || 'auto');
  let kind;
  let pickReason;
  let degraded = false;
  if (/\.jsonl$/i.test(dbFile)) {
    kind = 'ledger'; pickReason = '库文件后缀 .jsonl ⇒ 强制 ledger';
  } else if (backendWant === 'sqlite' || backendWant === 'ledger') {
    kind = backendWant; pickReason = '显式指定 --backend=' + backendWant;
  } else {
    const picked = pickBackendKind();
    kind = picked.kind; pickReason = picked.reason;
    degraded = kind !== 'sqlite';
  }
  const ledgerFile = /\.jsonl$/i.test(dbFile) ? dbFile : dbFile.replace(/\.db$/i, '') + '.ledger.jsonl';
  const activeFile = kind === 'sqlite' ? dbFile : ledgerFile;
  const stateDir = path.resolve(opts.stateDir || path.join(path.dirname(dbFile), STATE_SUBDIR));
  return {
    mdRoot, dbFile, ledgerFile, activeFile, kind, pickReason, degraded, stateDir,
    dirs: Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs.slice() : DEFAULT_DIRS.slice(),
    scan: { ...DEFAULT_SCAN, ...(opts.scan || {}) },
    excludeGlobs: (opts.excludeGlobs || []).slice(),
    dirsForScan: Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs.slice() : DEFAULT_DIRS.slice(),
  };
}

async function openBackend(kind, file) {
  if (kind === 'sqlite') {
    const { SqliteBackend } = await import('./backend-sqlite.mjs');
    return new SqliteBackend(file);
  }
  const { LedgerBackend } = await import('./backend-ledger.mjs');
  return new LedgerBackend(file);
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/**
 * 只读探测库：sqlite 复制到临时目录再开（保证源库零写入，连 -wal 都不碰）；
 * ledger 直接重放（构造器只读）。不存在 ⇒ {store:null}。
 */
async function probeStore(targets) {
  const file = targets.activeFile;
  const exists = fs.existsSync(file);
  if (!exists) return { store: null, exists: false, close: () => {}, probeMode: 'none' };
  if (targets.kind === 'ledger') {
    const be = await openBackend('ledger', file);
    return { store: new MemoryStore(be), exists: true, close: () => { try { be.close(); } catch { /* noop */ } }, probeMode: 'ledger-replay' };
  }
  // sqlite：复制（含 -wal/-shm）到临时目录再打开 ⇒ 源文件字节不变
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memtopic-upgrade-probe-'));
  const dst = path.join(tmp, 'mem.db');
  fs.copyFileSync(file, dst);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, dst + ext);
  try {
    const be = await openBackend('sqlite', dst);
    const store = new MemoryStore(be);
    return {
      store, exists: true, probeMode: 'sqlite-copy',
      close: () => { try { be.close(); } catch { /* noop */ } fs.rmSync(tmp, { recursive: true, force: true }); },
    };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { store: null, exists: true, probeMode: 'sqlite-unreadable', error: (e && e.message) || String(e), close: () => {} };
  }
}

// ---------------------------------------------------------------------------
// 2. 元数据 / schema 版本
// ---------------------------------------------------------------------------
function readMeta(store, key) {
  try { return store.be.getMeta ? store.be.getMeta(key) : null; } catch { return null; }
}
function writeMeta(store, key, val) {
  try { store.be.setMeta(key, String(val)); return true; } catch { return false; }
}

/** 版本探测：null/'' = 旧库或空库；>SCHEMA_VERSION ⇒ 拒绝；0 = 旧库（无 schema_version） */
export function inspectSchema(store) {
  const hasStore = !!store;
  const topicCount = hasStore ? store.be.listTopics().length : 0;
  const raw = hasStore ? readMeta(store, SCHEMA_KEY) : null;
  let version = null;
  if (raw != null && raw !== '' && Number.isFinite(Number(raw))) version = Number(raw);
  else if (topicCount > 0) version = 0;      // 有数据但没版本 ⇒ 旧库
  const tooNew = version != null && version > SCHEMA_VERSION;
  return {
    raw, version, topicCount,
    empty: topicCount === 0,
    legacy: version === 0,
    fresh: raw == null && topicCount === 0,
    tooNew,
    expected: SCHEMA_VERSION,
  };
}

function dbStats(store) {
  const topics = store.be.listTopics();
  const byState = {};
  let sentences = 0;
  let triggerMounts = 0;
  for (const t of topics) {
    byState[t.state] = (byState[t.state] || 0) + 1;
    const rows = store.be.listSentences(t.id) || [];
    sentences += rows.length;
    const active = typeof store.activeTriggersOf === 'function' ? store.activeTriggersOf(t) : (t.triggers || []);
    triggerMounts += active.length;
  }
  let generic = [];
  try { generic = typeof store.genericTriggers === 'function' ? (store.genericTriggers().generic || []) : []; } catch { generic = []; }
  let reminder = null;
  try { reminder = typeof store.pendingReminder === 'function' ? store.pendingReminder() : null; } catch { reminder = null; }
  let verify = null;
  try { verify = store.verify(); } catch (e) { verify = { ok: false, bad: [{ why: (e && e.message) || String(e) }] }; }
  const active = byState.active || 0;
  return {
    topics: topics.length,
    sentences,
    byState,
    triggerMounts,
    genericTriggerCount: generic.length,
    genericTop: generic.slice(0, 5).map((g) => ({ trigger: g.trigger, coverage: g.coverage })),
    needsReview: byState.needs_review || 0,
    draft: byState.draft || 0,
    active,
    reminder: reminder ? { count: reminder.count, oldestDays: reminder.oldestDays } : null,
    verifyOk: !!(verify && verify.ok),
    verifyBad: verify && verify.ok ? 0 : (verify && verify.bad ? verify.bad.length : null),
    lastImportAt: readMeta(store, LAST_IMPORT_KEY),
  };
}

// ---------------------------------------------------------------------------
// 3. md 侧探测（只读；复用 import 的排除策略与解析规则）
// ---------------------------------------------------------------------------
export function scanMd(mdRoot, opts = {}) {
  const dirs = opts.dirs || DEFAULT_DIRS;
  const scan = { ...DEFAULT_SCAN, excludeGlobs: opts.excludeGlobs || [] };
  const corpus = scanCorpus(mdRoot, { dirs, scan });
  const layer = {};
  let noH1 = 0;
  let frontMatter = 0;
  let crlf = 0;
  let broken = 0;
  let bytes = 0;
  const names = new Map();      // norm -> { name, files, texts:Set, sentences:0 }
  const totalLines = { blank: 0, frontMatter: 0, title: 0, headings: 0, fence: 0, comment: 0, rule: 0, lines: 0 };
  for (const f of corpus.files) {
    const buf = fs.readFileSync(f.abs);
    const text = buf.toString('utf8');
    bytes += buf.length;
    if (text.includes('\r')) crlf++;
    const parsed = parseMarkdown(text, f.abs);
    const top = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : '.';
    layer[top] = (layer[top] || 0) + 1;
    if (parsed.nameFrom !== 'h1') noH1++;
    if (parsed.counts.frontMatter > 0) frontMatter++;
    if (parsed.counts.sentences === 0) broken++;     // 有内容但解析不出正文（纯标题/注释等）
    for (const k of Object.keys(totalLines)) totalLines[k] += parsed.counts[k] || 0;
    if (parsed.sentences.length === 0) continue;      // 空文件不建主题（与 import 口径一致）
    const key = normalizeName(parsed.name);
    const rec = names.get(key) || { name: parsed.name, files: 0, texts: new Set() };
    rec.files++;
    for (const s of parsed.sentences) rec.texts.add(s);
    names.set(key, rec);
  }
  let expectedSentences = 0;
  let filesWithContent = 0;
  const expectedTopics = [];
  for (const rec of names.values()) {
    expectedSentences += rec.texts.size;
    filesWithContent += rec.files;
    expectedTopics.push({ name: rec.name, files: rec.files, sentences: rec.texts.size });
  }
  const layerArr = Object.entries(layer).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    root: mdRoot,
    dirs,
    mdTotal: corpus.mdTotal,
    importable: corpus.files.length,
    excluded: corpus.excluded,
    nonMdIgnored: corpus.nonMdIgnored,
    bytes,
    distinctTopicNames: names.size,
    filesWithContent,
    expectedSentences,
    expectedTopics,
    expectedTopicNames: [...names.values()].map((r) => r.name),
    noH1,
    frontMatterFiles: frontMatter,
    crlfFiles: crlf,
    noSentenceFiles: broken,
    layer: Object.fromEntries(layerArr),
    totalLines,
    sha256: sha256Dir(mdRoot, corpus.files),
    corpus,
  };
}

/** md 侧文件指纹（用于"md 未被改动"证明；只算可导入文件） */
export function fingerprintMd(mdRoot, opts = {}) {
  const scan = scanMd(mdRoot, opts);
  return { sha256: scan.sha256, count: scan.importable, mdTotal: scan.mdTotal, bytes: scan.bytes };
}

/** 只读归类投影（proposeClusters + reportScale），给 detect --deep / plan / curate 用 */
export async function curationProjection(store, opts = {}) {
  const t0 = Date.now();
  const { proposeClusters, reportScale } = await import('./curation.mjs');
  const p = proposeClusters(store, opts.curationConfig || {});
  const s = reportScale(store, opts.curationConfig || {}, p);
  const projected = (s && s.projected) || {};
  const nhr = projected.needsHumanReview || {};
  return {
    clusters: p.clusters.length,
    rejectedClusters: Array.isArray(p.rejectedClusters) ? p.rejectedClusters.length : null,
    families: Array.isArray(p.families) ? p.families.length : null,
    singletons: p.scan && Array.isArray(p.scan.singletons) ? p.scan.singletons.length : null,
    clusteredTopics: p.stats && p.stats.acceptedTopics != null ? p.stats.acceptedTopics : p.clusters.reduce((a, c) => a + c.memberCount, 0),
    rejectedTopics: p.stats && p.stats.rejectedTopics != null ? p.stats.rejectedTopics : null,
    membersSum: p.clusters.reduce((a, c) => a + c.memberCount, 0),
    // 主主题口径：familyPlanMainTopics（族明细下沉为 dormant 子主题，不占 active 名额）
    mainTopicsProjected: projected.familyPlanMainTopics != null ? projected.familyPlanMainTopics : null,
    strictMainTopics: projected.strictMainTopics != null ? projected.strictMainTopics : null,
    detailTopics: projected.familyPlanDetailTopics != null ? projected.familyPlanDetailTopics : null,
    avgSentencesPerMain: projected.avgSentencesPerMain != null ? projected.avgSentencesPerMain : null,
    needsHumanReview: {
      rejectedClusters: nhr.rejectedClusters != null ? nhr.rejectedClusters : null,
      rejectedTopics: nhr.rejectedTopics != null ? nhr.rejectedTopics : null,
      singleTopicFamilies: nhr.singleTopicFamilies != null ? nhr.singleTopicFamilies : null,
    },
    lowConfidence: p.clusters.filter((c) => c.confidence === 'low').length,
    ok: s.ok || null,
    targets: s.targets || null,
    elapsedMs: ms(t0),
  };
}

// ---------------------------------------------------------------------------
// 4. 影响评估（detect / plan 共用）
// ---------------------------------------------------------------------------
async function analyze(opts = {}, { deep = false } = {}) {
  const t0 = Date.now();
  const targets = resolveTargets(opts);
  const md = scanMd(targets.mdRoot, { dirs: targets.dirs, excludeGlobs: targets.excludeGlobs });
  const probe = await probeStore(targets);
  let schema = { raw: null, version: null, tooNew: false, legacy: false, fresh: true, empty: true, topicCount: 0, expected: SCHEMA_VERSION };
  let db = null;
  const existingNorms = new Set();
  let curation = null;
  try {
    if (probe.store) {
      schema = inspectSchema(probe.store);
      db = dbStats(probe.store);
      for (const t of probe.store.be.listTopics()) {
        existingNorms.add(t.norm);
        for (const a of (t.aliases || [])) existingNorms.add(normalizeName(a));
      }
      if (deep && db.topics >= 2 && !schema.tooNew) {
        try {
          curation = await curationProjection(probe.store, opts);
        } catch (e) {
          curation = { error: (e && e.message) || String(e) };
        }
      }
    }
  } finally {
    probe.close();
  }

  // 预计导入（按 import 同一口径："有正文文件 → 归一化主题名 → 同名合并"）：
  //   · 新建主题 = 主题名归一化后不在现有库（精确名/别名）的主题数
  //   · 命中已有 = 该主题名已在库里的文件数（导入会复用主题，不新建）
  //   · 同名合并 = 同一主题名对应多个文件时，除第一个之外的文件数
  let expectedNewTopics = 0;
  let filesExistingMatched = 0;
  let filesMergedSameTopic = 0;
  let filesNew = 0;
  for (const t of md.expectedTopics) {
    if (existingNorms.has(normalizeName(t.name))) filesExistingMatched += t.files;
    else { expectedNewTopics++; filesNew += t.files; }
    filesMergedSameTopic += Math.max(0, t.files - 1);
  }
  const estImportMs = Math.round(md.expectedSentences * EST_MS_PER_SENTENCE + expectedNewTopics * EST_MS_PER_NEW_TOPIC);
  const estTotalMs = estImportMs;

  const risks = [];
  if (schema.tooNew) risks.push({ code: 'schema-too-new', level: 'high', text: `库 schema_version=${schema.version} 高于本版 ${SCHEMA_VERSION}：拒绝执行（需升级升级器/插件）` });
  if (targets.degraded) risks.push({ code: 'degraded-ledger', level: 'high', text: `node:sqlite 不可用 ⇒ 降级 ledger 侧车：${targets.ledgerFile}（原 .db 不会被动；详见报告"降级模式"）` });
  if (probe.probeMode === 'sqlite-unreadable') risks.push({ code: 'db-unreadable', level: 'high', text: `现有库存在但当前环境读不了（${probe.error || '未知原因'}）` });
  if (md.excluded.count > 0) risks.push({ code: 'md-excluded', level: 'info', text: `策略排除 ${md.excluded.count} 个 md（trash ${md.excluded.byReason.trash || 0} / 隐藏 ${md.excluded.byReason.hidden || 0} / bak ${md.excluded.byReason.bak || 0} / 非扫描层 ${md.excluded.byReason['outside-dirs'] || 0}）——不会导入` });
  if (!targets.degraded && !fs.existsSync(targets.dbFile) && fs.existsSync(targets.ledgerFile)) {
    risks.push({ code: 'ledger-orphan', level: 'warn', text: `检测到降级 ledger 侧车 ${targets.ledgerFile}，但当前 sqlite 可用且 .db 不存在：本次会新建 .db，侧车不会被读取（如需保留历史请先在降级环境里导出/迁移）` });
  }
  if (targets.kind === 'ledger' && fs.existsSync(targets.dbFile)) {
    risks.push({ code: 'sqlite-not-read-in-degraded', level: 'high', text: `存在 sqlite 库 ${targets.dbFile}，但当前降级 ledger：不会读取也不会改写该 .db` });
  }
  if (md.noH1 > 0) risks.push({ code: 'no-h1', level: 'info', text: `${md.noH1} 个文件无 H1 标题：按文件名派生主题名（旧库结构容忍）` });
  if (md.crlfFiles > 0) risks.push({ code: 'crlf', level: 'info', text: `${md.crlfFiles} 个文件是 CRLF：统一按行切分（行尾换行语义不保留）` });
  if (md.noSentenceFiles > 0) risks.push({ code: 'no-sentence', level: 'info', text: `${md.noSentenceFiles} 个文件解析不出正文（纯标题/注释/空文件）：跳过且不建主题` });
  if (db && db.needsReview > 0) risks.push({ code: 'needs-review', level: 'warn', text: `库内已有 ${db.needsReview} 条 needs_review（导入期不封顶，会全部保留）` });
  if (db && db.active > 0) risks.push({ code: 'active-topics', level: 'warn', text: `库内已有 ${db.active} 个 active 主题（升级不会自动改状态；归类动作需显式 apply-merge）` });
  if (db && db.genericTriggerCount > 0) risks.push({ code: 'generic-triggers', level: 'info', text: `库内检出 ${db.genericTriggerCount} 个泛化 trigger（覆盖>5 主题，不参与判定；可用 --retrigger 清理）` });
  if (curation && !curation.error) {
    if (curation.mainTopicsProjected != null && curation.targets && curation.mainTopicsProjected > curation.targets.maxActiveMainTopics) {
      risks.push({ code: 'curation-scale', level: 'warn', text: `归类后主主题预计 ${curation.mainTopicsProjected} 个 > 目标 ${curation.targets.maxActiveMainTopics}：需要人工裁决更多簇/下沉族明细` });
    }
    if (curation.needsHumanReview && curation.needsHumanReview.rejectedClusters > 0) {
      risks.push({ code: 'curation-rejected', level: 'info', text: `${curation.needsHumanReview.rejectedClusters} 个候选簇被置信度/风险规则拦下，需人工逐簇复核（curate 报告会列出）` });
    }
  }
  const cp = readJsonSafe(checkpointPath(targets));   // 只读：不可用 readCheckpoint（它会改名坏文件）
  if (cp && cp.stages) {
    const running = Object.entries(cp.stages).filter(([, v]) => v && (v.status === 'running' || v.status === 'failed'));
    if (running.length) risks.push({ code: 'interrupted', level: 'warn', text: `上次升级中断/失败于 ${running.map(([k]) => k).join('、')}：再跑 --apply 会从该阶段续跑` });
  }

  const nextSteps = [];
  if (schema.tooNew) {
    nextSteps.push('停止：库版本高于本版升级器，请升级插件/升级器后再试（不要手动改 schema_version）');
  } else {
    nextSteps.push('审阅影响评估后，运行：node src/upgrade.mjs --plan' + targetArgsHint(opts, targets));
    nextSteps.push('计划确认后，运行：node src/upgrade.mjs --apply --stage=all' + targetArgsHint(opts, targets));
    nextSteps.push('随时可用 --snapshot 备份 / --rollback=<stage> 回退');
  }

  return {
    kind: 'detect',
    at: nowIso(),
    elapsedMs: ms(t0),
    upgradeVersion: UPGRADE_VERSION,
    schemaVersionExpected: SCHEMA_VERSION,
    targets: publicTargets(targets),
    md: {
      root: md.root, dirs: md.dirs, mdTotal: md.mdTotal, importable: md.importable,
      excludedCount: md.excluded.count, excludedByReason: md.excluded.byReason,
      excludedTopDirs: topEntries(md.excluded.byTopDir, 8),
      nonMdIgnored: md.nonMdIgnored, layer: md.layer, distinctTopicNames: md.distinctTopicNames,
      expectedSentences: md.expectedSentences, noH1: md.noH1, frontMatterFiles: md.frontMatterFiles,
      crlfFiles: md.crlfFiles, noSentenceFiles: md.noSentenceFiles, bytes: md.bytes, sha256: md.sha256,
    },
    db: db ? { path: publicTargets(targets).activeFile, exists: true, ...db } : { path: publicTargets(targets).activeFile, exists: false },
    schema: { ...schema, path: schemaPathOf(schema) },
    checkpoint: cp ? summarizeCheckpoint(cp) : null,
    estimate: {
      importFiles: md.importable, filesWithContent: md.filesWithContent,
      distinctTopicNames: md.distinctTopicNames,
      expectedNewTopics, filesNew, filesExistingMatched, filesMergedSameTopic,
      expectedSentences: md.expectedSentences, estImportMs, estTotalMs,
      curation: curation || null,
      note: '耗时按实测 2.6ms/句 + 25ms/新主题粗估（实测区间 1.7–3.6ms/句，±60%），实际受磁盘/库大小影响',
    },
    curation,
    risks,
    nextSteps,
    _internal: { targets, md, probeMode: probe.probeMode },
  };
}

function schemaPathOf(schema) {
  if (!schema) return [];
  if (schema.tooNew) return ['✗ 目标库版本高于本版：拒绝执行（升级插件/升级器后重试；不要手动改 schema_version）'];
  if (schema.version === 0) return SCHEMA_PATH_TABLE[0].slice();
  if (schema.version === 1) return SCHEMA_PATH_TABLE[1].slice();
  if (schema.version == null) return ['空库/新用户：apply import 建库时写入 schema_version=1'];
  return ['✗ 未知 schema_version=' + schema.version + '：不在本版路径表（支持 0/1），拒绝执行'];
}
function topEntries(obj, n) {
  return Object.entries(obj || {}).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, n)
    .map(([k, v]) => ({ name: k, count: v }));
}
function publicTargets(t) {
  return {
    mdRoot: t.mdRoot, dbFile: t.dbFile, activeFile: t.activeFile, ledgerFile: t.ledgerFile,
    backend: t.kind, degraded: t.degraded, degradedReason: t.degraded ? t.pickReason : null,
    stateDir: t.stateDir,
  };
}
function targetArgsHint(opts, targets) {
  const a = [];
  if (!opts.detectMdRoot && !opts.mdRoot) a.push(''); else a.push(' --md-root ' + quote(targets.mdRoot));
  if (!opts.dbFile) a.push(' --db ' + quote(targets.dbFile)); else a.push(' --db ' + quote(targets.dbFile));
  if (opts.stateDir) a.push(' --state-dir ' + quote(targets.stateDir));
  return a.join('');
}
function quote(s) { return /\s/.test(String(s)) ? '"' + s + '"' : String(s); }
function summarizeCheckpoint(cp) {
  const stages = {};
  for (const [k, v] of Object.entries(cp.stages || {})) {
    stages[k] = { status: v.status, finishedAt: v.finishedAt || null, ms: v.ms || null, error: v.error ? { code: v.error.code } : null };
  }
  return { db: cp.db, mdRoot: cp.mdRoot, backend: cp.backend, createdAt: cp.createdAt, updatedAt: cp.updatedAt, stages };
}

// ---------------------------------------------------------------------------
// 5. checkpoint
// ---------------------------------------------------------------------------
export function checkpointPath(targets) { return path.join(targets.stateDir, 'checkpoint.json'); }
export function readCheckpoint(targets) {
  const file = checkpointPath(targets);
  const cp = readJsonSafe(file);
  if (!cp) {
    // 坏 checkpoint：可能是并发/手改；不静默覆盖，改名保留后当新任务（报告里会警示）
    if (fs.existsSync(file)) {
      const bak = file + '.corrupt-' + Date.now();
      try { fs.renameSync(file, bak); } catch { /* noop */ }
      return { corrupt: true, corruptFile: bak };
    }
    return null;
  }
  return cp;
}
function newCheckpoint(targets, opts = {}) {
  const at = nowIso();
  return {
    upgradeVersion: UPGRADE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    db: targets.activeFile,
    dbFile: targets.dbFile,
    mdRoot: targets.mdRoot,
    backend: targets.kind,
    degraded: targets.degraded,
    stateDir: targets.stateDir,
    createdAt: at,
    updatedAt: at,
    dbExistedBefore: fs.existsSync(targets.activeFile),
    mdSha256Before: fs.existsSync(targets.mdRoot) ? fingerprintMd(targets.mdRoot, { dirs: targets.dirs, excludeGlobs: targets.excludeGlobs }).sha256 : null,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'pending', attempts: 0 }])),
    history: [],
    actor: opts.actor || 'lead',
  };
}
function writeCheckpoint(targets, cp) {
  cp.updatedAt = nowIso();
  ensureDir(targets.stateDir);
  writeJsonAtomic(checkpointPath(targets), cp);
}
function cpSetStage(cp, stage, patch) {
  cp.stages[stage] = { ...(cp.stages[stage] || { attempts: 0 }), ...patch };
  cp.history.push({ at: nowIso(), stage, status: cp.stages[stage].status });
}

// ---------------------------------------------------------------------------
// 6. 快照 / 回滚辅助
// ---------------------------------------------------------------------------
function snapshotDir(targets) { return path.join(targets.stateDir, 'snapshots'); }

/** 备份当前库文件（含 -wal/-shm）。返回快照信息；库不存在 ⇒ null */
export function snapshotDb(opts = {}) {
  const targets = resolveTargets(opts);
  const src = targets.activeFile;
  if (!fs.existsSync(src)) return { ok: false, code: 'NO_DB', message: '库文件不存在，无法快照', path: null };
  const label = opts.label || 'manual';
  ensureDir(snapshotDir(targets));
  const ts = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  const dst = path.join(snapshotDir(targets), `${label}-${ts}.db`);
  fs.copyFileSync(src, dst);
  const sidecars = [];
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(src + ext)) { fs.copyFileSync(src + ext, dst + ext); sidecars.push(dst + ext); }
  }
  const info = { ok: true, path: dst, sidecars, sha256: sha256File(dst), bytes: fs.statSync(dst).size, src, label, at: nowIso() };
  return info;
}

function stageSnapshotBefore(targets, cp, stage) {
  const info = fs.existsSync(targets.activeFile) ? snapshotDb({ ...targetsToOpts(targets), label: 'pre-' + stage }) : null;
  if (info) cp.snapshots = { ...(cp.snapshots || {}), [stage]: info.path };
  return info;
}
function targetsToOpts(targets) {
  return { mdRoot: targets.mdRoot, dbFile: targets.dbFile, backend: targets.kind, stateDir: targets.stateDir };
}

function restoreSnapshot(targets, snapPath) {
  if (!snapPath || !fs.existsSync(snapPath)) throw new UpgradeError('SNAPSHOT_MISSING', '快照不存在: ' + String(snapPath), { exitCode: EXIT.ROLLBACK_FAILED });
  ensureDir(path.dirname(targets.activeFile));
  fs.copyFileSync(snapPath, targets.activeFile);
  for (const ext of ['-wal', '-shm']) {
    const sf = snapPath + ext;
    if (fs.existsSync(sf)) fs.copyFileSync(sf, targets.activeFile + ext);
    else if (fs.existsSync(targets.activeFile + ext)) fs.rmSync(targets.activeFile + ext, { force: true });
  }
  return { restoredFrom: snapPath, sha256: sha256File(targets.activeFile) };
}
function deleteDbFiles(targets) {
  const removed = [];
  for (const f of [targets.activeFile, targets.activeFile + '-wal', targets.activeFile + '-shm']) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 7. detect / plan
// ---------------------------------------------------------------------------
export async function detectUpgrade(opts = {}) {
  const a = await analyze(opts, { deep: !!opts.deep });
  delete a._internal;
  return a;
}

export async function planUpgrade(opts = {}) {
  const a = await analyze(opts, { deep: true });
  const targets = resolveTargets(opts);
  const md = a.md;
  const db = a.db;
  const curation = a.curation;
  const existingTopics = db.exists && db.topics != null ? db.topics : 0;
  const expectedAfterImportTopics = existingTopics + a.estimate.expectedNewTopics;
  const expectedAfterImportSentences = (db.exists ? db.sentences || 0 : 0) + md.expectedSentences;
  const projected = curation && curation.mainTopicsProjected != null
    ? curation.mainTopicsProjected
    : (expectedAfterImportTopics <= 60 ? expectedAfterImportTopics : null);

  const stages = [
    {
      stage: 'import', name: '导入（md → 主题库）', writes: true, reversible: true,
      does: [
        `扫描 ${md.root}（${md.dirs.join('/')}）：全库 md ${md.mdTotal}，可导入 ${md.importable}，策略排除 ${md.excludedCount}`,
        `把每个文件的正文逐字导入主题（同主题重复行只收一次），自动派生别名/triggers（弱词与覆盖率>5 的词不派生）`,
        '所有新主题一律 draft；近重复/灰区进 needs_review（不静默合并、不丢内容）',
      ],
      writesTo: [publicTargets(targets).activeFile, 'checkpoint.json / upgrade-report-import.json（state dir）', 'snapshots/（阶段前快照）'],
      estimate: {
        files: md.importable, filesWithContent: a.estimate.filesWithContent,
        expectedNewTopics: a.estimate.expectedNewTopics, filesExistingMatched: a.estimate.filesExistingMatched,
        filesMergedSameTopic: a.estimate.filesMergedSameTopic, expectedSentences: md.expectedSentences,
        estMs: a.estimate.estImportMs,
      },
      expectedAfter: {
        topics: expectedAfterImportTopics,
        sentencesUpperBound: expectedAfterImportSentences,
        active: db.exists ? db.active : 0,
        note: '句子是上界（已迁移库里重复行会被跳过，实际新增通常为 0）',
      },
    },
    {
      stage: 'curate', name: '归类提案（只读）', writes: false, reversible: false,
      does: [
        '只读聚类：名字相似 / 稀有 trigger 重合 / 句子 Jaccard / 前缀族',
        '输出可人工裁决的提案（簇成员、建议标题、保留句建议、置信度），并做规模体检（主主题目标 ≤60）',
        '不写库；仅写 upgrade-report-curate.json 与 curation-proposals.json（state dir）',
      ],
      writesTo: ['state dir（提案/报告，不动库）'],
      estimate: {
        basisTopics: expectedAfterImportTopics,
        clusters: curation ? curation.clusters : null,
        rejectedClusters: curation ? curation.rejectedClusters : null,
        clusteredTopics: curation ? curation.clusteredTopics : null,
        singletons: curation ? curation.singletons : null,
        mainTopicsProjected: curation ? curation.mainTopicsProjected : null,
        lowConfidence: curation ? curation.lowConfidence : null,
        estMs: curation && curation.elapsedMs != null ? curation.elapsedMs : Math.round(30 + expectedAfterImportTopics * 3.3),
      },
      expectedAfter: { topics: expectedAfterImportTopics, sentencesUpperBound: expectedAfterImportSentences, note: 'curate 不改库；数字与 import 后一致' },
    },
    {
      stage: 'apply-merge', name: '应用归类（显式、单簇/逐簇）', writes: true, reversible: true,
      does: [
        '调用 curation-apply 接口把人工确认的簇落库：mergeCluster（主主题 + dormant 明细子主题 + 源主题 archived）',
        '合并前后句子总数必须相等（不删原文）；每簇可 undoMergeCluster 逆操作',
        '依赖 task-13 的 apply 接口；未就绪时本阶段按设计跳过（不写库，退出码仍为 0）',
      ],
      writesTo: ['主题状态/parent/archived/视图标记', 'state dir 报告 + 阶段前快照'],
      requires: 'curation-apply（task-13）',
      estimate: {
        clusters: curation ? curation.clusters : null,
        estMs: curation && curation.clusters ? Math.round(curation.clusters * EST_MS_PER_CLUSTER_MERGE) : null,
      },
      expectedAfter: {
        topicsProjected: curation && curation.mainTopicsProjected != null ? curation.mainTopicsProjected : null,
        sentencesUpperBound: expectedAfterImportSentences,
        activeMainTopicsTarget: 60,
        note: '句子总数必须不变（合并只做视图映射）；主主题数取决于人工裁决，不自动批量合并',
      },
    },
  ];

  const reviewSteps = [
    `run: node src/upgrade.mjs --detect${targetArgsHint(opts, resolveTargets(opts))}   # 先看影响评估`,
    `run: node src/upgrade.mjs --plan${targetArgsHint(opts, resolveTargets(opts))}     # 本文件`,
    `run: node src/upgrade.mjs --apply --stage=import${targetArgsHint(opts, resolveTargets(opts))}   # 显式执行（每阶段先快照）`,
    '审阅 curate 产出的 curation-proposals.json，人工裁决簇（不做自动批量合并）',
    'run: node src/upgrade.mjs --apply --stage=apply-merge   # 单簇/逐簇应用（依赖 task-13 接口）',
    '回退：node src/upgrade.mjs --rollback=<stage|all>',
  ];

  return {
    kind: 'plan',
    at: nowIso(),
    upgradeVersion: UPGRADE_VERSION,
    schemaVersionExpected: SCHEMA_VERSION,
    targets: publicTargets(targets),
    md: {
      root: md.root, mdTotal: md.mdTotal, importable: md.importable, excludedCount: md.excludedCount,
      excludedByReason: md.excludedByReason, expectedSentences: md.expectedSentences,
      distinctTopicNames: md.distinctTopicNames, noH1: md.noH1, crlfFiles: md.crlfFiles,
      frontMatterFiles: md.frontMatterFiles, noSentenceFiles: md.noSentenceFiles, sha256: md.sha256,
    },
    dbBefore: db,
    schema: { ...a.schema, path: schemaPathOf(a.schema) },
    schemaPath: { from: a.schema.version, to: SCHEMA_VERSION, steps: schemaPathOf(a.schema) },
    stages,
    reviewSteps,
    rollbackPlan: [
      'import：恢复阶段前快照（库此前不存在则删除库文件）—— 主题/句子回到升级前',
      'curate：无库写入，无需回滚（仅 state dir 报告/提案，可保留供审阅）',
      'apply-merge：逐簇 undoMergeCluster（checkpoint 记录 mergeId）；不可用时回退到阶段前快照',
      '全部：按 apply-merge → curate → import 逆序回滚',
    ],
    risks: a.risks,
    estimated: {
      importMs: a.estimate.estImportMs,
      curateMs: curation && curation.elapsedMs != null ? curation.elapsedMs : null,
      applyMergeMs: curation && curation.clusters ? Math.round(curation.clusters * EST_MS_PER_CLUSTER_MERGE) : null,
      totalMs: a.estimate.estTotalMs + ((curation && curation.elapsedMs) || 0),
    },
    zeroWrite: true,
    note: '--plan 纯只读：不创建 state dir、不写 checkpoint、不碰库文件（可用库文件 sha 前后一致验证）',
    _curationRaw: curation,
  };
}

// ---------------------------------------------------------------------------
// 8. 阶段实现
// ---------------------------------------------------------------------------
async function stageImport(targets, opts, cp) {
  const t0 = Date.now();
  const dbExistedBefore = fs.existsSync(targets.activeFile);
  const snapshot = stageSnapshotBefore(targets, cp, 'import');
  ensureDir(path.dirname(targets.activeFile));
  const be = await openBackend(targets.kind, targets.activeFile);
  const store = new MemoryStore(be);
  try {
    const diag = inspectSchema(store);
    if (diag.tooNew) {
      throw new UpgradeError('SCHEMA_TOO_NEW', `库 schema_version=${diag.version} 高于本版 ${SCHEMA_VERSION}，拒绝写入`, {
        exitCode: EXIT.REFUSED,
        hint: '升级插件/升级器后再试；不要手动改 schema_version，也不要删库（先用 --snapshot 备份）',
        detail: diag,
      });
    }
    const before = dbStats(store);
    const importOpts = {
      root: targets.mdRoot,
      dirs: targets.dirs,
      scan: targets.scan,
      actor: opts.actor || 'plugin',
      collectCandidates: true,
      keepHeadings: !!opts.keepHeadings,
      genericTriggerMaxTopics: opts.genericTriggerMaxTopics,
    };
    const report = importDir(store, importOpts);
    // schema_version / last_import_at 落在同一库（两后端都有 meta）
    writeMeta(store, SCHEMA_KEY, SCHEMA_VERSION);
    writeMeta(store, LAST_IMPORT_KEY, nowIso());
    const after = dbStats(store);
    const verify = store.verify();
    if (!verify.ok) throw new UpgradeError('VERIFY_FAILED', `导入后完整性校验失败（${verify.bad.length} 处）`, { exitCode: EXIT.FAILED, hint: '先 --snapshot 备份，再把 verify.bad 报给开发；不要继续 apply-merge' });
    const stats = {
      stage: 'import',
      mdRoot: targets.mdRoot,
      backend: targets.kind,
      degraded: targets.degraded,
      dbFile: targets.activeFile,
      dbExistedBefore,
      snapshot: snapshot ? { path: snapshot.path, sha256: snapshot.sha256, bytes: snapshot.bytes } : null,
      before: { topics: before.topics, sentences: before.sentences, byState: before.byState },
      after: { topics: after.topics, sentences: after.sentences, byState: after.byState, active: after.active },
      import: {
        files: report.files, filesEmpty: report.filesEmpty, filesNoSentences: report.filesNoSentences, filesErrored: report.filesErrored,
        topicsCreated: report.topicsCreated, topicsMatched: report.topicsMatched, topicsInStore: report.topicsInStore,
        sentencesAdded: report.sentencesAdded, sentencesSkipped: report.sentencesSkipped,
        aliasesAdded: report.aliasesAdded, triggersAdded: report.triggersAdded,
        zones: report.zones, needsReview: report.needsReview, demotedToDormant: report.demotedToDormant,
        charsAdded: report.charsAdded, bytes: report.bytes, elapsedMs: report.elapsedMs,
        triggerStats: report.triggerStats, genericTriggerMaxTopics: report.genericTriggerMaxTopics,
        excluded: report.excludedByPolicy ? report.excludedByPolicy.count : 0,
        excludedByReason: report.excludedByPolicy ? report.excludedByPolicy.byReason : {},
        nonMdIgnored: report.corpus ? report.corpus.nonMdIgnored : null,
        corpus: report.corpus,
        dropped: report.dropped, linesTotal: report.linesTotal,
        errors: (report.errors || []).slice(0, 20),
        txEnabled: report.txEnabled, txFiles: report.txFiles, txFallbackFiles: report.txFallbackFiles,
      },
      schemaVersion: { before: diag.version, after: SCHEMA_VERSION, raw: readMeta(store, SCHEMA_KEY) },
      verify: { ok: true, bad: 0 },
      mdSha256: cp.mdSha256Before,
      mdSha256After: scriptSafeMdSha(targets),
      ms: ms(t0),
    };
    return { stage: 'import', status: stats.import.topicsCreated === 0 && stats.import.sentencesAdded === 0 ? 'done' : 'done', stats };
  } finally {
    try { be.close(); } catch { /* noop */ }
  }
}

function scriptSafeMdSha(targets) {
  try { return fingerprintMd(targets.mdRoot, { dirs: targets.dirs, excludeGlobs: targets.excludeGlobs }).sha256; } catch { return null; }
}

async function stageCurate(targets, opts, cp) {
  const t0 = Date.now();
  const dbExists = fs.existsSync(targets.activeFile);
  // 只读打开（sqlite 用临时副本）——curate 不写库
  const probe = await probeStore(targets);
  let stats;
  try {
    if (!probe.store) {
      stats = { stage: 'curate', status: 'skipped', reason: '库不存在（先跑 --apply --stage=import）', dbFile: targets.activeFile, ms: ms(t0) };
      return { stage: 'curate', status: 'skipped', stats };
    }
    const diag = inspectSchema(probe.store);
    if (diag.tooNew) throw new UpgradeError('SCHEMA_TOO_NEW', `库 schema_version=${diag.version} 高于本版 ${SCHEMA_VERSION}，拒绝`, { exitCode: EXIT.REFUSED, hint: '升级插件后再试' });
    let curationMod = null;
    try { curationMod = await import('./curation.mjs'); } catch { curationMod = null; }
    if (!curationMod || typeof curationMod.proposeClusters !== 'function') {
      stats = { stage: 'curate', status: 'skipped', reason: 'curation.mjs 未就绪（proposeClusters 缺失）', dbFile: targets.activeFile, ms: ms(t0) };
      return { stage: 'curate', status: 'skipped', stats };
    }
    const before = dbStats(probe.store);
    const proposals = curationMod.proposeClusters(probe.store, opts.curationConfig || {});
    const scale = typeof curationMod.reportScale === 'function' ? curationMod.reportScale(probe.store, opts.curationConfig || {}, proposals) : null;
    ensureDir(targets.stateDir);
    const proposalsFile = path.join(targets.stateDir, PROPOSALS_FILE);
    writeJsonAtomic(proposalsFile, { at: nowIso(), db: targets.activeFile, upgradeVersion: UPGRADE_VERSION, scale, proposals });
    const clusters = (proposals.clusters || []).map((c) => ({
      clusterId: c.clusterId, memberCount: c.memberCount, suggestedTitle: c.suggestedTitle,
      confidence: c.confidence, riskFlags: c.riskFlags || [], reasons: c.reasons || [],
      sharedRareTriggers: c.sharedRareTriggers || [],
      keep: c.keep ? { keepCount: c.keep.keepCount, archiveCount: c.keep.archiveCount } : null,
      members: (c.members || []).slice(0, 30).map((m) => (typeof m === 'string' ? { id: m } : { id: m.id, name: m.name })),
    }));
    const projected = (scale && scale.projected) || {};
    const rejected = Array.isArray(proposals.rejectedClusters) ? proposals.rejectedClusters : [];
    stats = {
      stage: 'curate',
      status: 'done',
      dbFile: targets.activeFile,
      readOnly: true,
      proposalsFile,
      before: { topics: before.topics, sentences: before.sentences },
      scale: scale ? {
        total: scale.total, projected, ok: scale.ok, targets: scale.targets,
        clustering: scale.clustering,
        lowConfidenceCount: Array.isArray(scale.lowConfidence) ? scale.lowConfidence.length : null,
        families: Array.isArray(scale.families) ? scale.families.length : null,
        mainTopicsProjected: projected.familyPlanMainTopics != null ? projected.familyPlanMainTopics : null,
        strictMainTopics: projected.strictMainTopics != null ? projected.strictMainTopics : null,
        detailTopics: projected.familyPlanDetailTopics != null ? projected.familyPlanDetailTopics : null,
        avgSentencesPerMain: projected.avgSentencesPerMain != null ? projected.avgSentencesPerMain : null,
        needsHumanReview: projected.needsHumanReview ? {
          rejectedClusters: projected.needsHumanReview.rejectedClusters,
          rejectedTopics: projected.needsHumanReview.rejectedTopics,
          singleTopicFamilies: projected.needsHumanReview.singleTopicFamilies,
        } : null,
      } : null,
      clusters: clusters.length,
      clusteredTopics: clusters.reduce((a, c) => a + c.memberCount, 0),
      rejectedClusters: rejected.length,
      rejectedTopics: rejected.reduce((a, c) => a + (c.memberCount || 0), 0),
      families: Array.isArray(proposals.families) ? proposals.families.length : null,
      lowConfidence: clusters.filter((c) => c.confidence === 'low').length,
      clusterSamples: clusters.slice(0, 10),
      rejectedSamples: rejected.slice(0, 10).map((c) => ({ clusterId: c.clusterId, memberCount: c.memberCount, suggestedTitle: c.suggestedTitle, riskFlags: c.riskFlags || [], confidence: c.confidence })),
      curationAvailable: true,
      ms: ms(t0),
    };
    return { stage: 'curate', status: 'done', stats };
  } finally {
    probe.close();
  }
}

/** 尝试加载 curation-apply 接口（task-13 交付后自动接上） */
async function loadCurationApply() {
  const candidates = [
    { file: './curation-apply.mjs', names: ['applyCuration', 'applyProposals', 'applyMerges', 'default'] },
    { file: './curation.mjs', names: ['applyCuration', 'applyProposals', 'applyMerges'] },
  ];
  for (const c of candidates) {
    let mod = null;
    try { mod = await import(c.file); } catch { continue; }
    for (const name of c.names) {
      if (mod && typeof mod[name] === 'function') return { mod, file: c.file, name, fn: mod[name] };
    }
  }
  return null;
}

async function stageApplyMerge(targets, opts, cp) {
  const t0 = Date.now();
  if (!fs.existsSync(targets.activeFile)) {
    return { stage: 'apply-merge', status: 'skipped', stats: { stage: 'apply-merge', status: 'skipped', reason: '库不存在（先跑 --apply --stage=import）', ms: ms(t0) } };
  }
  // 用户决策（2026-10-29）：**不做自动批量合并** —— 必须显式给 --merge-cluster=<id> 或 --apply-all-confident=<阈值>。
  const clusterIds = Array.isArray(opts.mergeClusterIds) ? opts.mergeClusterIds.filter(Boolean) : [];
  const allConf = opts.applyAllConfident === undefined ? null : opts.applyAllConfident;   // true | number(阈值)
  let executor = null;
  if (typeof opts.mergeExecutor === 'function') {
    executor = { fn: opts.mergeExecutor, file: '(injected)', name: 'mergeExecutor' };
  } else if (clusterIds.length || allConf) {
    let mod = null;
    try { mod = await import('./curation-apply.mjs'); } catch { mod = null; }
    if (!mod || typeof mod.applyProposals !== 'function') {
      return {
        stage: 'apply-merge', status: 'skipped',
        stats: { stage: 'apply-merge', status: 'skipped', reason: 'curation-apply.mjs#applyProposals 不可用（未交付或导出变更）', requires: 'curation-apply（task-13）', dbFile: targets.activeFile, ms: ms(t0) },
      };
    }
    executor = {
      file: './curation-apply.mjs', name: 'applyProposals',
      fn: (ctx) => mod.applyProposals({
        store: ctx.store, proposals: ctx.proposals, clusterIds,
        applyAllConfident: !!allConf,
        minConfidence: typeof allConf === 'number' ? allConf : null,
        actor: opts.actor || 'lead',
        maxKeep: opts.maxKeep || 120,
        reason: 'upgrade:apply-merge',
      }),
    };
  }
  if (!executor) {
    return {
      stage: 'apply-merge', status: 'skipped',
      stats: {
        stage: 'apply-merge', status: 'skipped',
        reason: '待人工裁决：未指定要应用的簇（本工具不做自动批量合并）',
        requires: '--merge-cluster=<id[,id]> 或 --apply-all-confident=<minConfidence>',
        proposalsHint: '先 --apply --stage=curate 看 curation-proposals.json，人工逐簇裁决后再显式指定',
        dbFile: targets.activeFile, ms: ms(t0),
      },
    };
  }
  // 只读算提案（写库前先拿到簇清单）
  const probe = await probeStore(targets);
  let proposals;
  let scale = null;
  try {
    const curationMod = await import('./curation.mjs');
    proposals = curationMod.proposeClusters(probe.store, opts.curationConfig || {});
    scale = typeof curationMod.reportScale === 'function' ? curationMod.reportScale(probe.store, opts.curationConfig || {}, proposals) : null;
  } finally {
    probe.close();
  }
  const snapshot = stageSnapshotBefore(targets, cp, 'apply-merge');
  const be = await openBackend(targets.kind, targets.activeFile);
  const store = new MemoryStore(be);
  try {
    const diag = inspectSchema(store);
    if (diag.tooNew) throw new UpgradeError('SCHEMA_TOO_NEW', `库 schema_version=${diag.version} 高于本版 ${SCHEMA_VERSION}，拒绝`, { exitCode: EXIT.REFUSED, hint: '升级插件后再试' });
    const before = dbStats(store);
    let result;
    try {
      result = await executor.fn({
        store, proposals, clusters: proposals.clusters || [], cfg: opts.curationConfig || {},
        actor: opts.actor || 'lead', dbFile: targets.activeFile, stateDir: targets.stateDir,
        outputDir: targets.stateDir, upgradeContext: { targets, checkpoint: cp },
        clusterIds, applyAllConfident: allConf,
      });
    } catch (e) {
      if (e && e.code === 'NOT_IMPLEMENTED') {
        return {
          stage: 'apply-merge', status: 'skipped',
          stats: { stage: 'apply-merge', status: 'skipped', reason: 'curation-apply 未就绪（apply 接口抛 NOT_IMPLEMENTED）', requires: 'curation-apply（task-13）', dbFile: targets.activeFile, ms: ms(t0) },
        };
      }
      throw e;
    }
    const after = dbStats(store);
    const verify = store.verify();
    const rows = Array.isArray(result && result.results) ? result.results : [];
    const mergeIds = rows.filter((r) => r && r.ok && r.mergeId).map((r) => r.mergeId);
    const errors = rows.filter((r) => r && !r.ok).map((r) => ({ clusterId: r.clusterId, code: r.code, message: r.message }));
    const totals = (result && result.totals) || {};
    const stats = {
      stage: 'apply-merge',
      status: 'done',
      dbFile: targets.activeFile,
      appliedVia: { file: executor.file, name: executor.name },
      requested: { clusterIds, applyAllConfident: allConf },
      snapshot: snapshot ? { path: snapshot.path, sha256: snapshot.sha256 } : null,
      before: { topics: before.topics, sentences: before.sentences, active: before.active },
      after: { topics: after.topics, sentences: after.sentences, active: after.active },
      sentencesConserved: totals.sentencesConserved != null ? !!totals.sentencesConserved : before.sentences === after.sentences,
      appliedClusters: totals.applied != null ? totals.applied : mergeIds.length,
      reusedClusters: totals.reused != null ? totals.reused : 0,
      failedClusters: totals.failed != null ? totals.failed : errors.length,
      mergeIds,
      applied: rows.slice(0, 50),
      errors,
      verify: { ok: !!(verify && verify.ok) },
      ms: ms(t0),
    };
    if (!stats.sentencesConserved) {
      throw new UpgradeError('SENTENCES_NOT_CONSERVED', `apply-merge 前后句子数不一致（${before.sentences} → ${after.sentences}）`, {
        exitCode: EXIT.FAILED, hint: '立即 --rollback=apply-merge（优先 undoMergeCluster，再用阶段前快照）；把报告给开发', detail: stats,
      });
    }
    return { stage: 'apply-merge', status: 'done', stats };
  } finally {
    try { be.close(); } catch { /* noop */ }
  }
}

async function runStage(stage, targets, opts, cp) {
  if (stage === 'import') return stageImport(targets, opts, cp);
  if (stage === 'curate') return stageCurate(targets, opts, cp);
  if (stage === 'apply-merge') return stageApplyMerge(targets, opts, cp);
  throw new UpgradeError('BAD_STAGE', `未知阶段：${stage}（合法：${STAGES.join('|')}|all）`, { exitCode: EXIT.USAGE, hint: '用 --stage=import|curate|apply-merge|all' });
}

// ---------------------------------------------------------------------------
// 9. apply（显式调用才执行；checkpoint + 续跑 + 每阶段报告）
// ---------------------------------------------------------------------------
export async function applyUpgrade(opts = {}) {
  const t0 = Date.now();
  const targets = resolveTargets(opts);
  const stageArg = String(opts.stage || 'all');
  if (stageArg !== 'all' && STAGES.indexOf(stageArg) < 0) {
    throw new UpgradeError('BAD_STAGE', `未知阶段：${stageArg}（合法：${STAGES.join('|')}|all）`, {
      exitCode: EXIT.USAGE, hint: '用 --stage=import|curate|apply-merge|all 之一',
    });
  }
  if (!fs.existsSync(targets.mdRoot)) {
    throw new UpgradeError('MD_ROOT_MISSING', `md 目录不存在：${targets.mdRoot}`, {
      exitCode: EXIT.REFUSED, hint: `确认记忆目录路径（默认 ~/.dsh/memory），或用 --md-root <dir> 指定；不要手工建空目录试跑`,
    });
  }
  // 前置：现有库版本过高 ⇒ 直接拒绝（连 checkpoint 都不写）
  const pre = await probeStore(targets);
  let preDiag = null;
  try { if (pre.store) preDiag = inspectSchema(pre.store); } finally { pre.close(); }
  if (preDiag && preDiag.tooNew) {
    throw new UpgradeError('SCHEMA_TOO_NEW', `库 schema_version=${preDiag.version} 高于本版 ${SCHEMA_VERSION}，拒绝执行`, {
      exitCode: EXIT.REFUSED,
      hint: '升级插件/升级器后再试；不要手动改 schema_version；先 --snapshot 备份',
      detail: preDiag,
    });
  }

  const existingCp = readCheckpoint(targets);
  const wasCorrupt = !!(existingCp && existingCp.corrupt);
  let cp = existingCp;
  let resumedFrom = null;
  if (!cp || cp.corrupt) {
    cp = newCheckpoint(targets, opts);
    if (wasCorrupt) cp.corruptCheckpoint = true;
  } else {
    // 兼容旧 checkpoint
    cp.stages = cp.stages || {};
    for (const s of STAGES) cp.stages[s] = cp.stages[s] || { status: 'pending', attempts: 0 };
    if (cp.dbExistedBefore === undefined) cp.dbExistedBefore = fs.existsSync(targets.activeFile);   // 注意 false 也是合法值（升级前无库）
  }
  cp.upgradeVersion = UPGRADE_VERSION;
  cp.db = targets.activeFile;
  cp.mdRoot = targets.mdRoot;
  cp.backend = targets.kind;
  cp.degraded = targets.degraded;

  const order = stageArg === 'all' ? STAGES.slice() : [stageArg];
  const results = [];
  const runReports = [];
  for (const stage of order) {
    const cur = cp.stages[stage] || { status: 'pending', attempts: 0 };
    if (!opts.force && (cur.status === 'done' || cur.status === 'skipped')) {
      results.push({ stage, status: 'skipped', reason: '已完成（断点续跑：跳过）', previous: { status: cur.status, finishedAt: cur.finishedAt || null } });
      runReports.push({ stage, status: 'skipped', reason: '断点续跑跳过（已完成）', stats: { status: 'skipped', reason: '已完成（断点续跑跳过）', ms: 0 } });
      continue;
    }
    if (cur.status === 'running') resumedFrom = resumedFrom || stage;
    cpSetStage(cp, stage, { status: 'running', attempts: (cur.attempts || 0) + 1, startedAt: nowIso(), finishedAt: null, error: null });
    writeCheckpoint(targets, cp);
    const st = Date.now();
    let res;
    try {
      res = await runStage(stage, targets, opts, cp);
    } catch (e) {
      const err = e instanceof UpgradeError ? e : new UpgradeError('STAGE_FAILED', (e && e.message) || String(e), {
        exitCode: EXIT.FAILED,
        hint: `阶段 ${stage} 失败：先 --snapshot 备份，再查看 upgrade-report-${stage}.json 的 error；修复后重跑 --apply --stage=${stage}`,
        detail: { stack: (e && e.stack) || null },
      });
      cpSetStage(cp, stage, { status: 'failed', finishedAt: nowIso(), ms: ms(st), error: { code: err.code, message: err.message, hint: err.hint || null } });
      writeCheckpoint(targets, cp);
      ensureDir(targets.stateDir);
      const failReport = {
        kind: 'apply', stage, status: 'failed', at: nowIso(), ms: ms(t0),
        db: targets.activeFile, mdRoot: targets.mdRoot, backend: targets.kind,
        error: { code: err.code, message: err.message, hint: err.hint || null, detail: err.detail || null },
        nextSteps: [err.hint || `修复后重跑 --apply --stage=${stage}`],
      };
      writeJsonAtomic(path.join(targets.stateDir, `upgrade-report-${stage}.json`), failReport);
      return { ok: false, kind: 'apply', exitCode: err.exitCode || EXIT.FAILED, stage, results, runReports, error: failReport.error, targets: publicTargets(targets), checkpointSummary: summarizeCheckpoint(cp), ms: ms(t0) };
    }
    const status = res.status || 'done';
    cpSetStage(cp, stage, {
      status, finishedAt: nowIso(), ms: res.stats ? res.stats.ms : ms(st),
      stats: res.stats || null, reportFile: path.join(targets.stateDir, `upgrade-report-${stage}.json`),
    });
    writeCheckpoint(targets, cp);
    ensureDir(targets.stateDir);
    const report = { kind: 'apply', at: nowIso(), upgradeVersion: UPGRADE_VERSION, schemaVersion: SCHEMA_VERSION, targets: publicTargets(targets), stage, status, stats: res.stats || null, checkpointStage: summarizeCheckpoint(cp).stages[stage] };
    writeJsonAtomic(path.join(targets.stateDir, `upgrade-report-${stage}.json`), report);
    fs.writeFileSync(path.join(targets.stateDir, `upgrade-report-${stage}.txt`), formatStageReport(report), 'utf8');
    results.push({ stage, status, stats: res.stats || null });
    runReports.push({ stage, status, stats: res.stats || null });
  }

  // 汇总报告：升级前/后对照 + md 未改动 + 下一步
  const afterProbe = await probeStore(targets);
  let after = null;
  try { if (afterProbe.store) after = dbStats(afterProbe.store); } finally { afterProbe.close(); }
  const mdAfter = fs.existsSync(targets.mdRoot) ? fingerprintMd(targets.mdRoot, { dirs: targets.dirs, excludeGlobs: targets.excludeGlobs }) : null;
  const summary = {
    kind: 'apply-summary',
    at: nowIso(),
    upgradeVersion: UPGRADE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    stageArg,
    targets: publicTargets(targets),
    resumedFrom,
    degraded: targets.degraded,
    degradedReason: targets.degraded ? targets.pickReason : null,
    dbBefore: cp.dbExistedBefore ? { existed: true, snapshot: cp.snapshots ? cp.snapshots.import || null : null } : { existed: false },
    dbAfter: after,
    schemaVersionAfter: cp.stages && cp.stages.import && cp.stages.import.status === 'done' ? SCHEMA_VERSION : null,
    md: {
      root: targets.mdRoot,
      sha256Before: cp.mdSha256Before,
      sha256After: mdAfter ? mdAfter.sha256 : null,
      unchanged: !!(mdAfter && cp.mdSha256Before && mdAfter.sha256 === cp.mdSha256Before),
      files: mdAfter ? mdAfter.count : null,
    },
    stages: runReports.map((r) => ({ stage: r.stage, status: r.status, stats: summarizeStageStats(r.stage, r.stats) })),
    conservation: (() => {
      const importRes = runReports.find((r) => r.stage === 'import');
      const mergeRes = runReports.find((r) => r.stage === 'apply-merge');
      const added = importRes && importRes.stats && importRes.stats.import ? importRes.stats.import.sentencesAdded : 0;
      const beforeS = importRes && importRes.stats && importRes.stats.before ? importRes.stats.before.sentences : (after ? after.sentences - added : null);
      return {
        sentencesBefore: beforeS,
        sentencesAfter: after ? after.sentences : null,
        importAdded: added,
        sentencesConserved: after && beforeS != null ? (beforeS + added === after.sentences) : null,
        activeMainTopics: after ? after.active : null,
        mergeSentencesConserved: mergeRes && mergeRes.stats && mergeRes.stats.sentencesConserved != null ? mergeRes.stats.sentencesConserved : (mergeRes && mergeRes.status === 'skipped' ? 'skipped' : null),
        lowConfidenceClusters: (() => { const c = runReports.find((r) => r.stage === 'curate'); return c && c.stats && c.stats.lowConfidence != null ? c.stats.lowConfidence : null; })(),
      };
    })(),
    checkpoint: summarizeCheckpoint(cp),
    nextSteps: buildNextSteps(runReports, targets, opts),
    warnings: [],
    ms: ms(t0),
  };
  if (targets.degraded) summary.warnings.push('降级模式：node:sqlite 不可用，使用 ledger 侧车 ' + targets.ledgerFile + '（原 .db 未被动）');
  if (after && after.topics > 0 && after.active === 0) summary.warnings.push('库内 active=0：导入主题一律 draft，需人工转正/归类（apply-merge 或 memory_topics 处置）');
  ensureDir(targets.stateDir);
  writeJsonAtomic(path.join(targets.stateDir, 'upgrade-report-summary.json'), summary);
  fs.writeFileSync(path.join(targets.stateDir, 'upgrade-report-summary.txt'), formatApplySummary(summary), 'utf8');
  return { ok: true, kind: 'apply', exitCode: EXIT.OK, results, runReports, summary, targets: publicTargets(targets), ms: ms(t0) };
}

function summarizeStageStats(stage, stats) {
  if (!stats) return null;
  // 断点续跑/跳过分支的 stats 是 {status,reason,ms}，不是阶段统计形状 ⇒ 原样透出，不要按 import/curate/apply-merge 取字段
  if (stats.status === 'skipped' && !stats.import && !stats.clusters && !stats.scale && stats.appliedClusters === undefined) {
    return { status: 'skipped', reason: stats.reason || null, ms: stats.ms || 0 };
  }
  if (stage === 'import') {
    if (!stats.import) return { status: stats.status || 'done', reason: stats.reason || null, ms: stats.ms || 0, before: stats.before || null, after: stats.after || null };
    return {
      files: stats.import.files, topicsCreated: stats.import.topicsCreated, topicsMatched: stats.import.topicsMatched,
      sentencesAdded: stats.import.sentencesAdded, sentencesSkipped: stats.import.sentencesSkipped,
      before: stats.before, after: stats.after, ms: stats.ms, snapshot: stats.snapshot ? stats.snapshot.path : null,
      verifyOk: stats.verify.ok, schemaVersion: stats.schemaVersion,
    };
  }
  if (stage === 'curate') return { clusters: stats.clusters, clusteredTopics: stats.clusteredTopics, rejectedClusters: stats.rejectedClusters, rejectedTopics: stats.rejectedTopics, lowConfidence: stats.lowConfidence, families: stats.families, proposalsFile: stats.proposalsFile, scale: stats.scale, ms: stats.ms, status: stats.status, reason: stats.reason };
  if (stage === 'apply-merge') return { status: stats.status, reason: stats.reason, appliedClusters: stats.appliedClusters, reusedClusters: stats.reusedClusters, failedClusters: stats.failedClusters, mergeIds: stats.mergeIds, sentencesConserved: stats.sentencesConserved, before: stats.before, after: stats.after, ms: stats.ms, requires: stats.requires };
  return stats;
}

function buildNextSteps(runReports, targets, opts) {
  const arg = targetArgsHint(opts, targets);
  const steps = [];
  const byStage = Object.fromEntries(runReports.map((r) => [r.stage, r]));
  const importRes = byStage.import;
  if (importRes && importRes.status === 'done' && importRes.stats) {
    const added = importRes.stats.import.sentencesAdded;
    steps.push(added > 0 ? `导入完成：新增 ${added} 句；下一步审阅归类提案：node src/upgrade.mjs --apply --stage=curate${arg}` : '导入无新增（已是最新）；可继续 curate / apply-merge');
  }
  const curateRes = byStage.curate;
  if (curateRes && curateRes.status === 'done' && curateRes.stats) {
    steps.push(`归类提案已生成（${curateRes.stats.clusters} 簇）：人工裁决后执行 --apply --stage=apply-merge（或单簇）`);
  }
  const mergeRes = byStage['apply-merge'];
  if (mergeRes && mergeRes.status === 'skipped') {
    const why = (mergeRes.stats && mergeRes.stats.reason) || mergeRes.reason || '';
    if (/待人工裁决/.test(why)) steps.push('apply-merge 未执行（本工具不做自动批量合并）：先用 --merge-cluster=<id> 或 --apply-all-confident=<阈值> 显式指定要应用的簇');
    else if (/未就绪/.test(why)) steps.push('apply-merge 按设计跳过（curation-apply 未就绪）：等 task-13 交付后重跑 --apply --stage=apply-merge；期间可用 --rollback=import 回退');
    else steps.push('apply-merge 已在上次完成（断点续跑跳过）；如需重跑加 --force');
  }
  steps.push(`回退：node src/upgrade.mjs --rollback=<stage|all>${arg}`);
  steps.push(`备份：node src/upgrade.mjs --snapshot${arg}`);
  return steps;
}

// ---------------------------------------------------------------------------
// 10. rollback
// ---------------------------------------------------------------------------
export async function rollbackUpgrade(opts = {}) {
  const t0 = Date.now();
  const targets = resolveTargets(opts);
  const which = String(opts.rollback || '').trim();
  if (!which) throw new UpgradeError('BAD_ROLLBACK', '缺少回滚目标（--rollback=<stage|all>）', { exitCode: EXIT.USAGE, hint: '用 --rollback=import|curate|apply-merge|all' });
  if (which !== 'all' && STAGES.indexOf(which) < 0) {
    throw new UpgradeError('BAD_ROLLBACK', `未知回滚目标：${which}`, { exitCode: EXIT.USAGE, hint: '用 --rollback=import|curate|apply-merge|all' });
  }
  const cp = readCheckpoint(targets);
  if (!cp || cp.corrupt) {
    throw new UpgradeError('NO_CHECKPOINT', '没有可用的升级 checkpoint（无法判断回滚点）', {
      exitCode: EXIT.REFUSED, hint: '先 --detect 看 checkpoint 状态；若库是手工建的，直接删除库文件或从备份恢复（先 --snapshot 再动手）',
    });
  }
  cp.stages = cp.stages || {};
  const order = which === 'all' ? STAGES.slice().reverse() : [which];
  const results = [];
  for (const stage of order) {
    const cur = cp.stages[stage] || { status: 'pending' };
    const st = Date.now();
    if (!['done', 'skipped', 'failed'].includes(cur.status)) {
      results.push({ stage, status: 'skipped', reason: `该阶段未执行（status=${cur.status}），无需回滚` });
      continue;
    }
    try {
      let detail = null;
      if (stage === 'import') {
        const snap = cp.snapshots && cp.snapshots.import ? cp.snapshots.import : null;
        if (snap && fs.existsSync(snap)) {
          detail = { mode: 'restore-snapshot', ...restoreSnapshot(targets, snap) };
        } else if (cp.dbExistedBefore === false) {
          detail = { mode: 'delete-db', removed: deleteDbFiles(targets) };
        } else {
          throw new UpgradeError('NO_SNAPSHOT', '找不到 import 阶段快照，且库在升级前已存在：无法安全回滚', {
            exitCode: EXIT.ROLLBACK_FAILED, hint: '用你自己的备份恢复；或 --snapshot 备份后手工删库重建（会丢已有数据）',
          });
        }
      } else if (stage === 'curate') {
        detail = { mode: 'noop', reason: 'curate 不写库（只写 state dir 报告/提案），无需回滚' };
      } else if (stage === 'apply-merge') {
        const mergeIds = (cur.stats && cur.stats.mergeIds) || [];
        const snap = cp.snapshots && cp.snapshots['apply-merge'] ? cp.snapshots['apply-merge'] : null;
        const undone = [];
        const errors = [];
        if (mergeIds.length) {
          const be = await openBackend(targets.kind, targets.activeFile);
          const store = new MemoryStore(be);
          try {
            for (const id of mergeIds) {
              try { store.undoMergeCluster(id, { actor: opts.actor || 'lead' }); undone.push(id); }
              catch (e) { errors.push({ mergeId: id, code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) }); }
            }
          } finally { try { be.close(); } catch { /* noop */ } }
        }
        if (errors.length && snap && fs.existsSync(snap)) {
          detail = { mode: 'restore-snapshot-fallback', undone, errors, ...restoreSnapshot(targets, snap) };
        } else if (!mergeIds.length && snap && fs.existsSync(snap)) {
          detail = { mode: 'restore-snapshot', reason: '无可撤销 mergeId（或阶段未真正合并）', ...restoreSnapshot(targets, snap) };
        } else {
          detail = { mode: 'undo-merge-cluster', undone, errors };
          if (errors.length) throw new UpgradeError('ROLLBACK_PARTIAL', `apply-merge 回滚失败（${errors.length}/${mergeIds.length}）`, { exitCode: EXIT.ROLLBACK_FAILED, hint: '检查 undoMergeCluster 错误；必要时从快照恢复', detail });
        }
      }
      cpSetStage(cp, stage, { status: 'rolled_back', rolledBackAt: nowIso(), rollbackMs: ms(st) });
      writeCheckpoint(targets, cp);
      results.push({ stage, status: 'rolled_back', detail, ms: ms(st) });
    } catch (e) {
      const err = e instanceof UpgradeError ? e : new UpgradeError('ROLLBACK_FAILED', (e && e.message) || String(e), { exitCode: EXIT.ROLLBACK_FAILED, hint: '回滚未完成：保留现场，先 --snapshot 备份，再把错误报给开发' });
      results.push({ stage, status: 'failed', error: { code: err.code, message: err.message, hint: err.hint || null } });
      ensureDir(targets.stateDir);
      writeJsonAtomic(path.join(targets.stateDir, `upgrade-report-rollback-${stage}.json`), {
        kind: 'rollback', stage, status: 'failed', at: nowIso(), ms: ms(t0), targets: publicTargets(targets),
        error: { code: err.code, message: err.message, hint: err.hint || null, detail: err.detail || null }, results,
      });
      return { ok: false, kind: 'rollback', exitCode: err.exitCode || EXIT.ROLLBACK_FAILED, results, targets: publicTargets(targets), ms: ms(t0) };
    }
  }
  const report = { kind: 'rollback', at: nowIso(), upgradeVersion: UPGRADE_VERSION, which, targets: publicTargets(targets), results, checkpoint: summarizeCheckpoint(cp), ms: ms(t0) };
  ensureDir(targets.stateDir);
  writeJsonAtomic(path.join(targets.stateDir, `upgrade-report-rollback-${which.replace(/[^\w-]/g, '_')}.json`), report);
  fs.writeFileSync(path.join(targets.stateDir, `upgrade-report-rollback-${which.replace(/[^\w-]/g, '_')}.txt`), formatRollback(report), 'utf8');
  return { ...report, ok: true, exitCode: EXIT.OK, results, targets: publicTargets(targets), checkpoint: summarizeCheckpoint(cp) };
}

// ---------------------------------------------------------------------------
// 11. 人话报告
// ---------------------------------------------------------------------------
export function formatDetect(r) {
  const L = [];
  const p = (s) => L.push(s);
  p('=== 记忆库升级探测（只读，未做任何修改） ===');
  p(`时间：${r.at} ｜ 升级器 v${r.upgradeVersion} ｜ 目标 schema_version=${r.schemaVersionExpected}`);
  const t = r.targets;
  p(`后端：${t.backend}${t.degraded ? '（⚠ 降级模式：' + t.degradedReason + '）' : ''}`);
  p(`库文件：${t.activeFile}${r.db.exists ? '' : '（不存在：新用户/尚未迁移）'}`);
  p(`md 目录：${t.mdRoot}（${r.md.dirs.join('/')}）`);
  p('');
  p('一、记忆文件（md）');
  p(`  · 全库 md ${r.md.mdTotal} 个；可导入 ${r.md.importable} 个；策略排除 ${r.md.excludedCount} 个` +
    `（trash ${r.md.excludedByReason.trash || 0} / 隐藏 ${r.md.excludedByReason.hidden || 0} / bak ${r.md.excludedByReason.bak || 0} / 非扫描层 ${r.md.excludedByReason['outside-dirs'] || 0}）`);
  if (r.md.excludedTopDirs.length) p('    排除分布：' + r.md.excludedTopDirs.map((x) => x.name + '=' + x.count).join(' · '));
  p(`  · 非 md 忽略 ${r.md.nonMdIgnored.total} 个；分层：${Object.entries(r.md.layer).map(([k, v]) => k + '=' + v).join(' / ')}`);
  p(`  · 预计可导入句子 ${r.md.expectedSentences} 句；不同主题名 ${r.md.distinctTopicNames} 个；无 H1 ${r.md.noH1} 个 / CRLF ${r.md.crlfFiles} 个 / 无正文 ${r.md.noSentenceFiles} 个`);
  p('');
  p('二、主题库');
  if (r.db.exists) {
    p(`  · 主题 ${r.db.topics}（${Object.entries(r.db.byState).map(([k, v]) => k + '=' + v).join(' · ') || '空'}）；句子 ${r.db.sentences} 句`);
    p(`  · schema_version=${r.schema.raw == null ? '（无）' : r.schema.raw}${r.schema.legacy ? ' ⇒ 旧库，apply 时补写 1' : ''}${r.schema.tooNew ? ' ⇒ ⚠ 高于本版，拒绝执行' : ''}`);
    p(`  · trigger 挂载 ${r.db.triggerMounts}；泛化 trigger ${r.db.genericTriggerCount} 个${r.db.genericTop.length ? '（' + r.db.genericTop.map((x) => x.trigger + '×' + x.coverage).join(', ') + '）' : ''}`);
    p(`  · needs_review ${r.db.needsReview} 条；active ${r.db.active} 个；最后导入 ${r.db.lastImportAt || '（无记录）'}`);
    p(`  · 完整性校验：${r.db.verifyOk ? 'OK' : '⚠ 失败 ' + r.db.verifyBad + ' 处'}`);
  } else {
    p('  · 库不存在（首次迁移）；apply import 会新建库并写入 schema_version=1');
  }
  if (r.checkpoint) {
    p('  · 上次升级记录：' + Object.entries(r.checkpoint.stages).map(([k, v]) => k + '=' + (v.status || '?')).join(' / '));
  }
  p('');
  p('三、影响评估（预计）');
  p(`  · 预计导入文件 ${r.estimate.importFiles} 个（有正文 ${r.estimate.filesWithContent} 个 / 无正文跳过 ${r.md.noSentenceFiles} 个）`);
  p(`  · 主题名 ${r.estimate.distinctTopicNames} 个：预计新建 ${r.estimate.expectedNewTopics} 个（涉及 ${r.estimate.filesNew} 文件）；同名合并 ${r.estimate.filesMergedSameTopic} 文件；命中库内已有 ${r.estimate.filesExistingMatched} 文件`);
  p(`  · 预计新增句子上界 ${r.estimate.expectedSentences} 句；预计耗时 ${fmtMs(r.estimate.estImportMs)}（±60%，按实测 2.6ms/句）`);
  if (r.estimate.curation) {
    const c = r.estimate.curation;
    if (c.error) p(`  · 归类规模：计算失败（${c.error}），可稍后 --plan 重试`);
    else p(`  · 归类规模（proposeClusters）：提案 ${c.clusters} 簇（${c.clusteredTopics} 主题）/ 被拦下 ${c.rejectedClusters} 簇 / 单例 ${c.singletons}；预计主主题 ${c.mainTopicsProjected != null ? c.mainTopicsProjected : '—'}（目标 ≤${c.targets ? c.targets.maxActiveMainTopics : 60}；avg 句 ${c.avgSentencesPerMain != null ? c.avgSentencesPerMain : '—'}）`);
  } else {
    p('  · 归类规模：--detect 快速模式未计算；--plan 会给出（约 1–2s）');
  }
  p('');
  p('四、风险项');
  if (!r.risks.length) p('  · 无');
  else for (const x of r.risks) p(`  · [${x.level}] ${x.text}`);
  p('');
  p('五、建议下一步');
  for (const s of r.nextSteps) p('  → ' + s);
  p('');
  p('提示：--detect 只读；确认无误再跑 --plan（同样只读），最后才 --apply（会先快照，可回滚）。');
  return L.join('\n');
}

export function formatPlan(pl) {
  const L = [];
  const p = (s) => L.push(s);
  p('=== 记忆库升级计划（只读，零写入） ===');
  p(`时间：${pl.at} ｜ 目标库：${pl.targets.activeFile} ｜ 后端：${pl.targets.backend}${pl.targets.degraded ? '（⚠ 降级 ledger）' : ''}`);
  p(`md：${pl.md.root} ｜ 全库 ${pl.md.mdTotal} / 可导入 ${pl.md.importable} / 排除 ${pl.md.excludedCount}`);
  p(`库现状：${pl.dbBefore.exists ? `主题 ${pl.dbBefore.topics} / 句 ${pl.dbBefore.sentences}` : '不存在（首次迁移）'} ｜ schema_version=${pl.schema.raw == null ? '（无）' : pl.schema.raw}`);
  p('');
  p('迁移分三阶段（只有 --apply 会真正执行；下面每段都可单独跑）：');
  for (const st of pl.stages) {
    p('');
    p(`【${st.stage}】${st.name}  ${st.writes ? '★ 会写库' : '（只读）'}${st.reversible ? ' · 可回滚' : ''}${st.requires ? ' · 依赖 ' + st.requires : ''}`);
    for (const d of st.does) p('  · ' + d);
    if (st.estimate) p('  预计：' + Object.entries(st.estimate).map(([k, v]) => k + '=' + (v == null ? '—' : v)).join(' · '));
    if (st.expectedAfter) p('  之后：' + Object.entries(st.expectedAfter).map(([k, v]) => k + '=' + (v == null ? '—' : v)).join(' · '));
    p('  写入位置：' + (st.writesTo || []).join('；'));
  }
  p('');
  p('汇总预计：' + Object.entries(pl.estimated).map(([k, v]) => k + '=' + (v == null ? '—' : fmtMs(v))).join(' · '));
  p('');
  p('风险项：');
  if (!pl.risks.length) p('  · 无');
  else for (const x of pl.risks) p(`  · [${x.level}] ${x.text}`);
  p('');
  p('回滚方案：');
  for (const r of pl.rollbackPlan) p('  · ' + r);
  p('');
  p('审阅通过后的手动执行步骤：');
  for (const s of pl.reviewSteps) p('  → ' + s);
  p('');
  p('本计划零写入：不创建 state dir、不写 checkpoint、不碰库文件（可用库文件 sha 前后一致验证）。');
  return L.join('\n');
}

export function formatStageReport(report) {
  const L = [];
  const p = (s) => L.push(s);
  const st = report.stage;
  const s = report.stats || {};
  p(`=== 升级阶段报告：${st}（${report.status}） ===`);
  p(`时间：${report.at} ｜ 后端：${report.targets.backend}${report.targets.degraded ? '（⚠ 降级 ledger）' : ''} ｜ 库：${report.targets.activeFile}`);
  if (st === 'import') {
    p(`md：${s.mdRoot} ｜ 扫描 ${s.import.files} 文件（空 ${s.import.filesEmpty} / 无句 ${s.import.filesNoSentences} / 出错 ${s.import.filesErrored}）`);
    p(`主题：新建 ${s.import.topicsCreated} / 命中 ${s.import.topicsMatched} / 库内 ${s.import.topicsInStore}`);
    p(`句子：新增 ${s.import.sentencesAdded} / 跳过 ${s.import.sentencesSkipped}（同主题重复） ｜ 字符 +${s.import.charsAdded}`);
    p(`状态：draft ${s.after.byState.draft || 0} / needs_review ${s.after.byState.needs_review || 0} / active ${s.after.active} ｜ 进复核 ${s.import.needsReview}`);
    p(`库前后：主题 ${s.before.topics}→${s.after.topics}；句子 ${s.before.sentences}→${s.after.sentences}`);
    p(`triggers 过滤：候选 ${s.import.triggerStats ? s.import.triggerStats.derived : '—'} → 弱词 ${s.import.triggerStats ? s.import.triggerStats.weakFiltered : '—'} / 覆盖率>${s.import.genericTriggerMaxTopics} ${s.import.triggerStats ? s.import.triggerStats.genericFiltered : '—'}`);
    p(`schema_version：${s.schemaVersion.before == null ? '（无）' : s.schemaVersion.before} → ${s.schemaVersion.after} ｜ 完整性：${s.verify.ok ? 'OK' : 'FAIL'}`);
    p(`快照：${s.snapshot ? s.snapshot.path + '（' + Math.round(s.snapshot.bytes / 1024) + ' KB）' : '（库原本不存在，回滚=删库）'}`);
    p(`耗时：${fmtMs(s.ms)}`);
  } else if (st === 'curate') {
    if (s.status === 'skipped') p(`跳过：${s.reason}`);
    else {
      p(`聚类：提案 ${s.clusters} 簇（覆盖 ${s.clusteredTopics} 主题）｜ 被置信/风险规则拦下 ${s.rejectedClusters} 簇（${s.rejectedTopics} 主题）｜ 低置信 ${s.lowConfidence} 簇`);
      if (s.scale) p(`规模体检：预计主主题 ${s.scale.mainTopicsProjected != null ? s.scale.mainTopicsProjected : '—'}（目标 ${s.scale.targets ? s.scale.targets.maxActiveMainTopics : 60}）｜ 严格口径 ${s.scale.strictMainTopics != null ? s.scale.strictMainTopics : '—'} ｜ 平均句数 ${s.scale.avgSentencesPerMain != null ? s.scale.avgSentencesPerMain : '—'} ｜ 达标 ${s.scale.ok ? s.scale.ok.all : '—'}`);
      p(`提案文件：${s.proposalsFile}`);
      for (const c of s.clusterSamples) p(`  · ${c.clusterId} ${c.memberCount} 成员 ｜ 建议标题「${c.suggestedTitle}」｜ 置信 ${c.confidence}${c.keep ? ' ｜ 保留 ' + c.keep.keepCount + ' 句 / 下沉 ' + c.keep.archiveCount : ''}`);
      for (const c of (s.rejectedSamples || [])) p(`  · [拦下] ${c.clusterId} ${c.memberCount} 成员 ｜ 建议标题「${c.suggestedTitle}」｜ ${(c.riskFlags || []).join(',') || '低置信'}`);
    }
    p(`耗时：${fmtMs(s.ms)}`);
  } else if (st === 'apply-merge') {
    if (s.status === 'skipped') p(`跳过：${s.reason}${s.requires ? '（依赖 ' + s.requires + '）' : ''}`);
    else {
      p(`应用簇：${s.appliedClusters}；mergeId：${(s.mergeIds || []).join(', ') || '（无）'}`);
      p(`前后：主题 ${s.before.topics}→${s.after.topics}；句子 ${s.before.sentences}→${s.after.sentences}（守恒 ${s.sentencesConserved === true ? 'OK' : 'FAIL'}）`);
    }
    p(`耗时：${fmtMs(s.ms)}`);
  }
  return L.join('\n');
}

export function formatApplySummary(sum) {
  const L = [];
  const p = (s) => L.push(s);
  p('=== 升级执行汇总 ===');
  p(`时间：${sum.at} ｜ 阶段参数：${sum.stageArg} ｜ 后端：${sum.targets.backend}${sum.degraded ? '（⚠ 降级 ledger）' : ''}`);
  if (sum.resumedFrom) p(`续跑：检测到中断于 ${sum.resumedFrom}，本次从该阶段继续`);
  p(`库：${sum.targets.activeFile}`);
  p(`升级前库：${sum.dbBefore.existed ? '存在（有快照）' : '不存在（回滚=删库）'}`);
  if (sum.dbAfter) p(`升级后库：主题 ${sum.dbAfter.topics} / 句子 ${sum.dbAfter.sentences} / draft ${sum.dbAfter.draft} / needs_review ${sum.dbAfter.needsReview} / active ${sum.dbAfter.active} ｜ verify ${sum.dbAfter.verifyOk ? 'OK' : 'FAIL'}`);
  p(`md：${sum.md.root} ｜ 文件 ${sum.md.files == null ? '—' : sum.md.files} ｜ 前后 sha ${sum.md.unchanged ? '一致（未被改动）' : '⚠ 不一致'}`);
  p('');
  p('各阶段：');
  for (const st of sum.stages) {
    const s = st.stats || {};
    if (st.stage === 'import') p(s.files == null ? '  · import：已完成（断点续跑跳过，本次 +0 主题/+0 句）' : `  · import：${s.files} 文件 → 新建 ${s.topicsCreated} 主题 / 命中 ${s.topicsMatched} / 新增 ${s.sentencesAdded} 句（跳过 ${s.sentencesSkipped}）｜ ${fmtMs(s.ms)}`);
    else if (st.stage === 'curate') p(`  · curate：${s.proposalsFile ? '提案 ' + s.clusters + ' 簇（拦下 ' + s.rejectedClusters + '），主主题预计 ' + (s.scale && s.scale.mainTopicsProjected != null ? s.scale.mainTopicsProjected : '—') : '跳过（' + (s.reason || '—') + '）'} ｜ ${fmtMs(s.ms || 0)}`);
    else if (st.stage === 'apply-merge') p(s.appliedClusters != null ? `  · apply-merge：应用 ${s.appliedClusters} 簇（句子守恒 ${s.sentencesConserved}）｜ ${fmtMs(s.ms || 0)}` : `  · apply-merge：跳过（${s.reason || '已完成，断点续跑跳过'}）`);
  }
  if (sum.conservation) {
    const c = sum.conservation;
    p('');
    p(`守恒对照：句子 ${c.sentencesBefore == null ? '—' : c.sentencesBefore} → ${c.sentencesAfter == null ? '—' : c.sentencesAfter}（导入 +${c.importAdded}，总账 ${c.sentencesConserved === true ? '✓ 相等' : c.sentencesConserved === false ? '✗ 不等' : '—'}）｜ 主主题(active) ${c.activeMainTopics == null ? '—' : c.activeMainTopics} ｜ apply-merge 守恒 ${c.mergeSentencesConserved == null ? '—' : c.mergeSentencesConserved} ｜ 低置信簇 ${c.lowConfidenceClusters == null ? '—' : c.lowConfidenceClusters}`);
  }
  p('');
  if (sum.warnings && sum.warnings.length) { p('告警：'); for (const w of sum.warnings) p('  · ' + w); p(''); }
  p('下一步：');
  for (const s of sum.nextSteps) p('  → ' + s);
  p('');
  p(`本次耗时：${fmtMs(sum.ms)} ｜ 报告目录：${sum.targets.stateDir}`);
  return L.join('\n');
}

export function formatRollback(r) {
  const L = [];
  const p = (s) => L.push(s);
  p('=== 升级回滚 ===');
  p(`时间：${r.at} ｜ 目标：${r.which} ｜ 库：${r.targets.activeFile} ｜ 耗时 ${fmtMs(r.ms)}`);
  for (const x of r.results) {
    p(`  · ${x.stage}：${x.status}${x.reason ? '（' + x.reason + '）' : ''}`);
    if (x.detail) p('    细节：' + JSON.stringify(x.detail));
  }
  p('');
  p('下一步：');
  p('  → 重新执行：node src/upgrade.mjs --apply --stage=all');
  p('  → 若回滚后库为空且要继续迁移：--apply --stage=import 会重新导入（幂等）');
  return L.join('\n');
}

export function formatSnapshot(s) {
  if (!s.ok) return `快照失败：${s.message || s.code}`;
  return [
    '=== 库快照 ===',
    `源：${s.src}`,
    `快照：${s.path}（${Math.round(s.bytes / 1024)} KB，sha256 ${s.sha256.slice(0, 16)}…）`,
    s.sidecars.length ? `附带：${s.sidecars.join(', ')}` : '附带：无（无 WAL/SHM）',
    `时间：${s.at}`,
    '说明：快照是把整库复制到 state dir，可在 --rollback 缺失时手工恢复。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 12. CLI
// ---------------------------------------------------------------------------
const USAGE = `升级编排（默认只读；只有 --apply 才写库）

用法：
  node src/upgrade.mjs --detect [选项]                 只读探测 + 人话影响评估
  node src/upgrade.mjs --plan [选项]                   只读迁移计划（零写入）
  node src/upgrade.mjs --apply --stage=<stage> [选项]  显式执行（每阶段先快照、写 checkpoint/报告）
  node src/upgrade.mjs --rollback=<stage|all> [选项]   回滚
  node src/upgrade.mjs --snapshot [选项]               备份当前库

stage：import | curate | apply-merge | all
选项：
  --db <file>           库文件（默认 <md-root>/.memtopic/mem.db）
  --md-root <dir>       记忆 md 根目录（默认 ~/.dsh/memory）
  --backend <k>         auto|sqlite|ledger（默认 auto；sqlite 不可用自动降级 ledger 侧车）
  --state-dir <dir>     checkpoint/报告/快照目录（默认 <db 目录>/upgrade）
  --dirs <a,b>          参与导入的分层目录（默认 knowledge,projects,tools,sessions）
  --exclude-globs <a,b> 额外排除的 md glob
  --curation-config <json>  归类配置（JSON 字符串）
  --from-version <n>    显式声明旧库 schema_version（0|1；不传自动探测；不在路径表内拒绝）
  --merge-cluster <id[,id]> 显式指定要应用的归类簇（可多次；默认不自动批量合并）
  --apply-all-confident[=<minConfidence>] 显式批量应用置信足够的簇（必须显式传，默认禁用）
  --force               已完成阶段也重跑
  --deep                --detect 时也计算归类规模（默认省，--plan 总会算）
  --json                输出 JSON（供 Agent 解析）
  --version             打印版本

退出码：0 成功/按设计跳过 ｜ 1 参数错误 ｜ 2 拒绝执行（版本过高/前置不满足）｜ 3 阶段失败 ｜ 4 回滚失败`;

function parseCli(argv) {
  const out = { mode: null };
  const take = (i, name) => {
    const a = argv[i];
    if (a.startsWith('--' + name + '=')) return { value: a.slice(name.length + 3), next: i };
    const v = argv[i + 1];
    if (v == null || String(v).startsWith('--')) return { value: undefined, next: i };
    return { value: v, next: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detect') { out.mode = 'detect'; continue; }
    if (a === '--plan') { out.mode = 'plan'; continue; }
    if (a === '--apply') { out.mode = 'apply'; continue; }
    if (a === '--snapshot') { out.mode = 'snapshot'; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--deep') { out.deep = true; continue; }
    if (a === '--full-report') { out.fullReport = true; continue; }
    if (a === '--version') { out.version = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--rollback')) {
      out.mode = 'rollback';
      if (a.includes('=')) out.rollback = a.slice(a.indexOf('=') + 1);
      else if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) { out.rollback = argv[i + 1]; i++; }
      continue;
    }
    if (a.startsWith('--stage')) {
      if (a.includes('=')) out.stage = a.slice(a.indexOf('=') + 1);
      else if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) { out.stage = argv[i + 1]; i++; }
      continue;
    }
    const eq = (name) => a.startsWith('--' + name + '=') || a === '--' + name;
    if (eq('db')) { const r = take(i, 'db'); out.dbFile = r.value; i = r.next; continue; }
    if (eq('md-root')) { const r = take(i, 'md-root'); out.mdRoot = r.value; i = r.next; continue; }
    if (eq('backend')) { const r = take(i, 'backend'); out.backend = r.value; i = r.next; continue; }
    if (eq('state-dir')) { const r = take(i, 'state-dir'); out.stateDir = r.value; i = r.next; continue; }
    if (eq('actor')) { const r = take(i, 'actor'); out.actor = r.value; i = r.next; continue; }
    if (eq('dirs')) { const r = take(i, 'dirs'); out.dirs = String(r.value || '').split(',').map((s) => s.trim()).filter(Boolean); i = r.next; continue; }
    if (eq('exclude-globs')) { const r = take(i, 'exclude-globs'); out.excludeGlobs = String(r.value || '').split(',').map((s) => s.trim()).filter(Boolean); i = r.next; continue; }
    if (eq('merge-cluster')) {
      const r = take(i, 'merge-cluster'); i = r.next;
      out.mergeClusterIds = (out.mergeClusterIds || []).concat(String(r.value || '').split(',').map((x) => x.trim()).filter(Boolean));
      continue;
    }
    if (a === '--apply-all-confident') { out.applyAllConfident = true; continue; }
    if (a.startsWith('--apply-all-confident=')) {
      const v = a.slice(a.indexOf('=') + 1);
      const n = Number(v);
      out.applyAllConfident = Number.isFinite(n) ? n : true;
      continue;
    }
    if (eq('from-version')) {
      const r = take(i, 'from-version'); i = r.next;
      const n = Number(r.value);
      if (!Number.isFinite(n) || n < 0) throw new UpgradeError('BAD_ARG', '--from-version 需要非负整数：' + String(r.value), { exitCode: EXIT.USAGE, hint: '取值 0（旧库/无版本）或 1（当前版本）；不传则自动探测' });
      out.fromVersion = n;
      continue;
    }
    if (eq('curation-config')) {
      const r = take(i, 'curation-config'); i = r.next;
      try { out.curationConfig = JSON.parse(String(r.value)); } catch (e) { throw new UpgradeError('BAD_ARG', '--curation-config 不是合法 JSON: ' + ((e && e.message) || e), { exitCode: EXIT.USAGE, hint: '传 JSON 字符串，如 --curation-config=\'{"maxClusterSize":12}\'' }); }
      continue;
    }
    throw new UpgradeError('BAD_ARG', '未知参数：' + a, { exitCode: EXIT.USAGE, hint: '运行 node src/upgrade.mjs --help 查看用法' });
  }
  return out;
}

function optsFromCli(cli) {
  const o = {};
  for (const k of ['dbFile', 'mdRoot', 'backend', 'stateDir', 'dirs', 'excludeGlobs', 'curationConfig', 'actor', 'stage', 'rollback', 'force', 'json', 'deep', 'mergeClusterIds', 'applyAllConfident']) {
    if (cli[k] !== undefined) o[k] = cli[k];
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let cli;
  try { cli = parseCli(argv); } catch (e) {
    console.error('错误：' + e.message);
    if (e.hint) console.error('下一步：' + e.hint);
    console.error(USAGE);
    return e.exitCode || EXIT.USAGE;
  }
  if (cli.help) { console.log(USAGE); return EXIT.OK; }
  if (cli.version) {
    console.log(JSON.stringify({ schema_version: SCHEMA_VERSION, upgrade_version: UPGRADE_VERSION, stages: STAGES, exit_codes: EXIT }, null, 2));
    return EXIT.OK;
  }
  if (!cli.mode) {
    console.error('错误：必须指定 --detect / --plan / --apply / --rollback=<stage|all> / --snapshot 之一');
    console.error(USAGE);
    return EXIT.USAGE;
  }
  const opts = optsFromCli(cli);
  try {
    if (opts.fromVersion != null) {
      if (!(opts.fromVersion in SCHEMA_PATH_TABLE)) {
        console.error('错误：--from-version=' + opts.fromVersion + ' 不在本版路径表（支持 0/1）');
        console.error('下一步：确认旧库真实 schema_version（--detect 会自动探测）；不传 --from-version 让工具自动判断');
        return EXIT.REFUSED;
      }
      if (opts.fromVersion > SCHEMA_VERSION) {
        console.error('错误：--from-version=' + opts.fromVersion + ' 高于本版目标版本 ' + SCHEMA_VERSION);
        console.error('下一步：升级插件/升级器后再试；不要手动改 schema_version');
        return EXIT.REFUSED;
      }
    }
    if (cli.mode === 'detect') {
      const r = await detectUpgrade({ ...opts, deep: !!cli.deep });
      console.log(cli.json ? JSON.stringify(r, null, 2) : formatDetect(r));
      if (r.schema && r.schema.tooNew) {
        console.error('下一步：库 schema_version=' + r.schema.version + ' 高于本版 ' + SCHEMA_VERSION + '，拒绝执行；请升级插件/升级器后再试（不要手动改 schema_version，先 --snapshot 备份）');
        return EXIT.REFUSED;
      }
      return EXIT.OK;
    }
    if (cli.mode === 'plan') {
      const r = await planUpgrade(opts);
      console.log(cli.json ? JSON.stringify(r, null, 2) : formatPlan(r));
      if (r.schema && r.schema.tooNew) {
        console.error('下一步：库 schema_version=' + r.schema.version + ' 高于本版 ' + SCHEMA_VERSION + '，拒绝执行；请升级插件/升级器后再试（不要手动改 schema_version，先 --snapshot 备份）');
        return EXIT.REFUSED;
      }
      return EXIT.OK;
    }
    if (cli.mode === 'snapshot') {
      const r = snapshotDb({ ...opts, label: cli.label || 'manual' });
      console.log(cli.json ? JSON.stringify(r, null, 2) : formatSnapshot(r));
      return r.ok ? EXIT.OK : EXIT.REFUSED;
    }
    if (cli.mode === 'rollback') {
      const r = await rollbackUpgrade({ ...opts, rollback: cli.rollback });
      console.log(cli.json ? JSON.stringify(r, null, 2) : formatRollback(r));
      if (!r.ok) console.error('下一步：回滚未完成 —— 保留现场，先 --snapshot 备份，再把 upgrade-report-rollback-*.json 报给开发');
      return r.exitCode;
    }
    if (cli.mode === 'apply') {
      const r = await applyUpgrade(opts);
      if (cli.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(formatApplySummary(r.summary));
        for (const rep of r.results) {
          if (rep.stats && rep.stage === 'import') console.log('\n' + formatStageReport({ kind: 'apply', at: r.summary.at, stage: 'import', status: 'done', targets: r.summary.targets, stats: rep.stats }));
          if (rep.stats && rep.stage === 'curate' && rep.status === 'done') console.log('\n' + formatStageReport({ kind: 'apply', at: r.summary.at, stage: 'curate', status: 'done', targets: r.summary.targets, stats: rep.stats }));
        }
      }
      return r.exitCode;
    }
    console.error('错误：未知模式');
    return EXIT.USAGE;
  } catch (e) {
    const err = e instanceof UpgradeError ? e : new UpgradeError('UNEXPECTED', (e && e.message) || String(e), { exitCode: EXIT.FAILED, hint: '保留现场，先 --snapshot 备份，再把错误栈报给开发' });
    if (cli.json) console.log(JSON.stringify({ ok: false, kind: cli.mode, code: err.code, message: err.message, hint: err.hint, exitCode: err.exitCode }, null, 2));
    else console.error('错误：' + err.message);
    console.error('下一步：' + (err.hint || '检查参数后重试；详细用法 node src/upgrade.mjs --help'));
    return err.exitCode || EXIT.FAILED;
  }
}

function isMain() {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
}
if (isMain()) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('错误：' + ((e && e.message) || e));
    console.error('下一步：保留现场，先 --snapshot 备份，再把错误栈报给开发');
    process.exit(EXIT.FAILED);
  });
}
