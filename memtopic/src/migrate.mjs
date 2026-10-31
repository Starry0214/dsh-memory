// 老用户一键迁移编排器（migrate）——**薄编排层**，只包 upgrade.mjs，不重写其逻辑。
//
// 定位：安装器 / 插件命令 / 手工命令的统一入口。
//   · --detect  只读：旧版 md 有多少文件/句子、主题库是否存在/已有多少数据、宿主是否在运行、
//               是否需要迁移、预计导入量、建议动作（人话 + --json 机器可读）。
//   · --apply   编排 detect → plan → apply → 摘要 → "重启 DSH 后生效"；默认拒绝宿主运行中执行；
//               库已有数据时必须 --merge 显式确认（我们自己的 checkpoint 续跑除外）；幂等（二次 apply +0）。
//   · --rollback 转 upgrade.mjs 的 --rollback（默认 all）。
//   · --snapshot 透传 upgrade.mjs 的快照（方便迁移前手工备份）。
//
// 硬约束：
//   · 只读探测阶段绝不写库、不建 state dir；任何写动作只在 --apply/--rollback/--snapshot。
//   · 宿主运行判定必须把"依据"写进报告（锁/端口文件、进程扫描、环境变量），并支持
//     --assume-host-stopped（安装器在用户已退出 DSH 但探测误报时使用）。
//   · 退出码与 upgrade.mjs 完全对齐：0 成功/按设计跳过 ｜ 1 参数错误 ｜ 2 拒绝执行 ｜ 3 阶段失败 ｜ 4 回滚失败。
//   · 不删除、不改写任何 md；迁移后 md 仍是"导出视图/人工稳定层"，可继续读取。
//
// CLI：
//   node memtopic/src/migrate.mjs --detect [--json] [--db <file>] [--md-root <dir>] [--dsh-home <dir>]
//   node memtopic/src/migrate.mjs --apply [--yes] [--merge] [--assume-host-stopped] [--json] [同上路径参数]
//   node memtopic/src/migrate.mjs --rollback[=<stage|all>] [--yes] [--json]
//   node memtopic/src/migrate.mjs --snapshot [--json]
//   node memtopic/src/migrate.mjs --version | --help
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_MEMORY_ROOT, DEFAULT_DIRS, DEFAULT_SCAN, scanCorpus, parseMarkdown,
} from './import.mjs';
import {
  EXIT, SCHEMA_VERSION, UpgradeError,
  detectUpgrade, planUpgrade, applyUpgrade, rollbackUpgrade, snapshotDb,
  resolveTargets, readCheckpoint, inspectSchema, formatPlan, formatApplySummary, formatRollback, formatSnapshot,
} from './upgrade.mjs';

export const MIGRATION_VERSION = 1;

// ---------------------------------------------------------------------------
// 0. 路径 / 参数
// ---------------------------------------------------------------------------
function expandHome(p) {
  const s = String(p == null ? '' : p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}
function resolveMigrateTargets(opts = {}) {
  const mdRoot = path.resolve(expandHome(opts.mdRoot || process.env.MEMTOPIC_MD_ROOT || DEFAULT_MEMORY_ROOT));
  const dbFile = path.resolve(expandHome(opts.dbFile || process.env.MEMTOPIC_DB || path.join(mdRoot, '.memtopic', 'mem.db')));
  const dshHome = path.resolve(expandHome(opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
  const base = resolveTargets({ mdRoot, dbFile, backend: opts.backend, stateDir: opts.stateDir, dirs: opts.dirs, excludeGlobs: opts.excludeGlobs });
  return { ...base, dshHome, memoryRoot: mdRoot };
}

// ---------------------------------------------------------------------------
// 1. 宿主运行判定（依据必须进报告）
// ---------------------------------------------------------------------------
const LOCK_CANDIDATES = ['dsh.lock', '.dsh.lock', '.lock', 'session.lock', 'migrate.lock', 'dsh.pid', '.dsh.pid', 'run/dsh.pid', 'run/dsh.lock', 'tmp/dsh.lock'];

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM' ? true : false; }
}

function scanProcesses() {
  const matches = [];
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status !== 0) return { ok: false, tool: 'tasklist', reason: (r.stderr || '').trim().slice(0, 120) || 'tasklist failed', matches };
      for (const line of String(r.stdout).split(/\r?\n/)) {
        const cols = line.trim().split('","').map((s) => s.replace(/^"|"$/g, ''));
        if (!cols.length || !cols[0]) continue;
        const name = cols[0];
        const pid = Number(cols[1]) || null;
        if (/dsh|deepseek[\s-]*harness|memtopic/i.test(name)) matches.push({ pid, name });
      }
      return { ok: true, tool: 'tasklist', matches };
    }
    const r = spawnSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0) return { ok: false, tool: 'ps', reason: (r.stderr || '').trim().slice(0, 120) || 'ps failed', matches };
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      if (/dsh|deepseek[\s-]*harness|memtopic/i.test(m[2])) matches.push({ pid: Number(m[1]), name: m[2] });
    }
    return { ok: true, tool: 'ps', matches };
  } catch (e) {
    return { ok: false, tool: process.platform === 'win32' ? 'tasklist' : 'ps', reason: (e && e.message) || String(e), matches };
  }
}

/**
 * 探测宿主是否在运行。返回 {running, status, evidence[], processScan}
 * 依据（全部写进报告）：
 *   a) 锁/pid 文件：$DSH_HOME 下已知候选；pid 文件解析存活；普通锁文件存在即视为"疑似运行"
 *   b) 进程扫描：tasklist(Win) / ps(POSIX) 里出现 dsh/DeepSeek Harness（可用 --no-process-scan 关闭）
 *   c) 环境变量：DSH_HOST_RUNNING=1/0（安装器或测试可显式指定）
 * 任何一项判定运行 ⇒ running=true；--assume-host-stopped 时不探测、直接假定停止。
 */
export function detectHost(opts = {}) {
  const dshHome = path.resolve(expandHome(opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
  const evidence = [];
  if (opts.assumeHostStopped) {
    return { running: false, status: 'assumed-stopped', assumedStopped: true, dshHome, evidence: [{ kind: 'override', detail: '--assume-host-stopped：跳过宿主运行探测（安装器在用户已退出 DSH 时使用）' }] };
  }
  // 显式环境变量优先（安装器/自动化/测试）：DSH_HOST_RUNNING=1|0 直接定论，不再扫描
  const envFlag = process.env.DSH_HOST_RUNNING;
  if (envFlag === '1' || envFlag === '0') {
    const running = envFlag === '1';
    return {
      running, status: running ? 'running' : 'stopped', assumedStopped: false, dshHome,
      evidence: [{ kind: 'env', detail: 'DSH_HOST_RUNNING=' + envFlag + '（显式指定，跳过锁/进程探测）', running }],
    };
  }

  // ① 进程扫描（主判据）：tasklist/ps 里是否有 dsh / DeepSeek Harness
  let processScan = { ok: false, tool: null, skipped: false, matches: [] };
  if (opts.noProcessScan) {
    processScan = { ok: false, tool: null, skipped: true, matches: [], reason: '--no-process-scan' };
    evidence.push({ kind: 'process', tool: null, skipped: true, running: null, detail: '进程扫描已关闭（--no-process-scan）：无法确认 DSH 是否运行 ⇒ 按"未知"处理（--apply 将被拒绝，除非 --assume-host-stopped）' });
  } else {
    processScan = { ...scanProcesses(), skipped: false };
    if (processScan.matches.length) {
      evidence.push({ kind: 'process', tool: processScan.tool, running: true, primary: true, detail: `发现 ${processScan.matches.length} 个宿主进程：` + processScan.matches.slice(0, 3).map((m) => `${m.name}(${m.pid})`).join(', '), matches: processScan.matches.slice(0, 5) });
    } else if (processScan.ok) {
      evidence.push({ kind: 'process', tool: processScan.tool, running: false, primary: true, detail: '进程扫描未发现 dsh / DeepSeek Harness' });
    } else {
      evidence.push({ kind: 'process', tool: processScan.tool, running: null, primary: true, detail: `进程扫描不可用（${processScan.reason || '未知原因'}）⇒ 无法确认宿主状态` });
    }
  }
  let running = processScan.matches.length > 0;

  // ② 锁 / pid 文件（补充判据）：找到就算"疑似运行"；没有也**显式说明不存在**
  const lockFound = [];
  for (const rel of LOCK_CANDIDATES) {
    const file = path.join(dshHome, rel);
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) continue;
    let detail = '锁文件存在';
    let alive = null;
    if (/\.pid$|pid$/i.test(rel)) {
      let pid = null;
      try { pid = Number(String(fs.readFileSync(file, 'utf8')).trim().split(/\s+/)[0]); } catch { pid = null; }
      alive = pidAlive(pid);
      detail = `pid 文件：pid=${pid == null ? '?' : pid}，存活=${alive == null ? '未知' : alive}`;
      if (alive !== true) { lockFound.push({ rel, file, kind: 'pid-file', pid, alive, running: false, detail: detail + '（陈旧锁，不视为运行）' }); continue; }
      lockFound.push({ rel, file, kind: 'pid-file', pid, alive, running: true, detail });
      running = true;
      continue;
    }
    lockFound.push({ rel, file, kind: 'lock-file', running: true, detail });
    running = true;
  }
  for (const x of lockFound) evidence.push({ kind: x.kind, path: x.file, running: x.running, detail: x.detail + (x.running ? '（若 DSH 已退出，可删掉陈旧锁或加 --assume-host-stopped）' : '') });
  if (!lockFound.length) {
    evidence.push({ kind: 'lock-scan', found: 0, running: false, detail: `锁文件不存在（已检查 ${dshHome} 下 ${LOCK_CANDIDATES.length} 个候选：dsh.lock / dsh.pid / run/dsh.pid 等均未找到）——DSH 不依赖锁文件，以进程扫描为准` });
  } else {
    evidence.push({ kind: 'lock-scan', found: lockFound.length, running: running, detail: `发现 ${lockFound.length} 个锁/pid 文件（见上）` });
  }

  // ③ 结论：进程扫描不可用且无锁证据 ⇒ unknown（不能当 stopped，否则会误放行写真实库）
  const canDecide = processScan.ok || lockFound.length > 0;
  const status = running ? 'running' : (canDecide ? 'stopped' : 'unknown');
  return { running, status, assumedStopped: false, dshHome, evidence, processScan };
}

// ---------------------------------------------------------------------------
// 2. 旧版 md 统计（只读；标记行不计数——import 层同样跳过）
// ---------------------------------------------------------------------------
const HUMAN_LAYER_FILES = ['global.md', 'index.md', 'fixed.md'];

export function scanLegacyMd(mdRoot, opts = {}) {
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs : DEFAULT_DIRS;
  const corpus = scanCorpus(mdRoot, { dirs, scan: { ...DEFAULT_SCAN, ...(opts.scan || {}) } });
  const byLayer = {};
  for (const d of dirs) byLayer[d] = { files: 0, sentences: 0 };
  let files = 0;
  let sentences = 0;
  const samples = [];
  for (const f of corpus.files) {
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const parsed = parseMarkdown(text, f.abs);
    const top = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : '.';
    if (!byLayer[top]) byLayer[top] = { files: 0, sentences: 0 };
    byLayer[top].files++;
    byLayer[top].sentences += parsed.sentences.length;
    files++;
    sentences += parsed.sentences.length;
    if (samples.length < 5) samples.push({ rel: f.rel, sentences: parsed.sentences.length });
  }
  const humanLayer = [];
  for (const name of HUMAN_LAYER_FILES) {
    const file = path.join(mdRoot, name);
    if (!fs.existsSync(file)) { humanLayer.push({ name, exists: false, sentences: 0 }); continue; }
    let parsed = null;
    try { parsed = parseMarkdown(fs.readFileSync(file, 'utf8'), file); } catch { parsed = null; }
    humanLayer.push({ name, exists: true, sentences: parsed ? parsed.sentences.length : 0, note: '人工稳定层：不参与导入（可直接编辑）' });
  }
  return {
    root: mdRoot,
    dirs,
    byLayer,
    importableFiles: files,
    importableSentences: sentences,
    humanLayer,
    humanLayerSentences: humanLayer.reduce((a, x) => a + (x.sentences || 0), 0),
    mdTotalRecursive: corpus.mdTotal,
    excluded: { count: corpus.excluded.count, byReason: corpus.excluded.byReason, byTopDir: corpus.excluded.byTopDir },
    nonMdIgnored: corpus.nonMdIgnored,
    samples,
  };
}

// ---------------------------------------------------------------------------
// 3. detect：只读报告（人类 + JSON）
// ---------------------------------------------------------------------------
export async function detectMigration(opts = {}) {
  const t0 = Date.now();
  const targets = resolveMigrateTargets(opts);
  const legacy = scanLegacyMd(targets.memoryRoot, { dirs: targets.dirsForScan, scan: targets.scan });
  const host = detectHost({ dshHome: targets.dshHome, assumeHostStopped: !!opts.assumeHostStopped, noProcessScan: !!opts.noProcessScan });
  let up = null;
  let upErr = null;
  try {
    up = await detectUpgrade({
      mdRoot: targets.mdRoot, dbFile: targets.dbFile, backend: targets.kind, stateDir: targets.stateDir,
      dirs: targets.dirs, excludeGlobs: targets.excludeGlobs,
    });
  } catch (e) {
    upErr = { code: (e && e.code) || 'DETECT_FAILED', message: (e && e.message) || String(e), hint: (e && e.hint) || null, exitCode: (e && e.exitCode) || EXIT.FAILED };
  }
  const db = up && up.db ? up.db : { path: targets.activeFile, exists: fs.existsSync(targets.activeFile) };
  const schema = up && up.schema ? up.schema : null;
  const dbHasData = !!(db.exists && (db.topics || 0) > 0);
  const legacyHasData = legacy.importableSentences > 0;
  const needsMigration = legacyHasData && !dbHasData;
  const alreadyMigrated = dbHasData;
  const empty = !legacyHasData && !dbHasData;
  const schemaTooNew = !!(schema && schema.tooNew);
  const mergeRequired = dbHasData && legacyHasData;    // 事实：库已有数据 + 还有旧 md；合并需 --merge（不是阻塞）

  const cp = readCheckpoint(targets);
  const resumeReady = !!(cp && !cp.corrupt && cp.db === targets.activeFile && cp.stages && cp.stages.import && ['done', 'skipped', 'running', 'failed'].includes(cp.stages.import.status));

  // 只读 detect 的 blockers 只保留"绝对不可执行"的（版本过高）；host 状态归入 advisories，
  // 只有"确实要写库"时才算阻塞（--apply 会自己再拦一次并给指引）。
  const blockers = [];
  if (schemaTooNew) blockers.push({ code: 'SCHEMA_TOO_NEW', text: `库 schema_version=${schema.version} 高于本版 ${SCHEMA_VERSION}：拒绝迁移（需升级插件/安装器）` });

  const advisories = [];
  if (alreadyMigrated) {
    if (legacyHasData) advisories.push({ code: 'LEGACY_MD_RETAINED', blocking: false, text: `旧 md 保留 ${legacy.importableFiles} 文件 / ${legacy.importableSentences} 句（历史 md 与导出视图，属正常；可选清理，不影响使用）` });
    advisories.push({ code: 'NO_ACTION_NEEDED', blocking: false, text: '主题库已有数据：无需迁移，也不会写库' });
    if (host.running) advisories.push({ code: 'HOST_RUNNING', blocking: false, text: 'DSH 正在运行（只读提示；当前无需写库，所以不影响）' });
    if (host.status === 'unknown') advisories.push({ code: 'HOST_UNKNOWN', blocking: false, text: '宿主运行状态无法确认（只读提示；当前无需写库）' });
  } else if (needsMigration) {
    if (host.running) advisories.push({ code: 'HOST_RUNNING', blocking: true, text: `DSH 正在运行（依据见 host.evidence）：迁移写库前必须先退出 DSH；确认已退出可加 --assume-host-stopped` });
    if (host.status === 'unknown') advisories.push({ code: 'HOST_UNKNOWN', blocking: true, text: '无法确认 DSH 是否运行（进程扫描不可用且无锁文件）：--apply 会被拒绝；确认已退出可加 --assume-host-stopped' });
  }

  const recommended = schemaTooNew ? 'stop'
    : alreadyMigrated ? 'none'
      : empty ? 'nothing-to-do'
        : host.running ? 'stop-host'
          : 'migrate';
  const nextCommand = (recommended === 'migrate' || recommended === 'stop-host')
    ? buildNextCommand(targets, { mergeRequired: false })
    : null;

  const est = up && up.estimate ? up.estimate : null;
  const report = {
    kind: 'migrate-detect',
    migrationVersion: MIGRATION_VERSION,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    mdRoot: targets.memoryRoot,
    db: {
      path: targets.activeFile, requestedPath: targets.dbFile, backend: targets.kind,
      degraded: targets.degraded, exists: !!db.exists, topics: db.topics == null ? 0 : db.topics,
      sentences: db.sentences == null ? 0 : db.sentences, byState: db.byState || null,
      schemaVersion: schema ? schema.raw : null, hasData: dbHasData,
    },
    legacy: {
      importableFiles: legacy.importableFiles,
      importableSentences: legacy.importableSentences,
      byLayer: legacy.byLayer, humanLayer: legacy.humanLayer, humanLayerSentences: legacy.humanLayerSentences,
      mdTotalRecursive: legacy.mdTotalRecursive, excluded: legacy.excluded, nonMdIgnored: legacy.nonMdIgnored,
      samples: legacy.samples,
    },
    estimate: est ? { files: est.importFiles, newTopics: est.expectedNewTopics, matchedFiles: est.filesExistingMatched, sentences: est.expectedSentences, estMs: est.estImportMs } : null,
    host,
    checkpoint: cp && !cp.corrupt ? { exists: true, db: cp.db, stages: Object.fromEntries(Object.entries(cp.stages || {}).map(([k, v]) => [k, v.status])), updatedAt: cp.updatedAt } : { exists: false, resumeReady },
    resumeReady,
    needsMigration,
    alreadyMigrated,
    empty,
    mergeRequired,
    schemaTooNew,
    blockers,
    advisories,
    recommended,
    nextCommand,
    notes: [
      'md 是导出视图/人工稳定层：迁移只读取，不删除、不改写；迁移后仍可直接打开阅读',
      '迁移完成后需要重启 DSH，插件才会以主题库为真源；重启前旧插件仍读 md',
      '已迁移用户保留旧 md 属正常（历史归档 + 导出视图），不影响使用',
    ],
  };
  return report;
}

function q(s) { return /\s/.test(String(s)) ? '"' + s + '"' : String(s); }
function buildNextCommand(t, { mergeRequired = false } = {}) {
  const script = fileURLToPath(import.meta.url);
  const args = [];
  if (t.memoryRoot !== DEFAULT_MEMORY_ROOT) args.push('--md-root', q(t.memoryRoot));
  if (process.env.MEMTOPIC_DB || t.dbFile !== path.join(t.memoryRoot, '.memtopic', 'mem.db')) args.push('--db', q(t.activeFile));
  if (mergeRequired) args.push('--merge');
  return `node ${q(script)} --apply --yes` + (args.length ? ' ' + args.join(' ') : '');
}

// ---------------------------------------------------------------------------
// 4. 人类可读报告
// ---------------------------------------------------------------------------
function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'; }

export function formatMigrateDetect(r) {
  const L = [];
  const p = (s) => L.push(s);
  const stop = r.recommended === 'stop';
  const migrated = r.alreadyMigrated;
  const mark = stop ? '✗ 停止（环境不满足）'
    : migrated ? '✓ 已迁移（主题库已有数据，无需操作）'
      : r.empty ? '○ 空库（没有可迁移的 md）'
        : r.host.running ? '⚠ 检测到旧版 md 记忆，需要迁移（但 DSH 正在运行，先退出）'
          : '⚠ 检测到旧版 md 记忆，需要迁移';
  p('=== 记忆库迁移检测（只读，未做任何修改） ===');
  p(`状态：${mark}`);
  p(`时间：${r.at} ｜ 迁移器 v${r.migrationVersion} ｜ 耗时 ${fmtMs(r.elapsedMs)}`);
  p(`旧版 md：${r.mdRoot}`);
  p(`主题库：${r.db.path}（${r.db.exists ? '存在' : '不存在'}; schema_version=${r.db.schemaVersion == null ? '（无）' : r.db.schemaVersion}）`);
  p('');
  if (migrated) {
    // D3：已迁移用户——不列"预计导入 xx 主题"这类吓人数字，只说明旧 md 属正常保留
    p('一、主题库（真源）');
    p(`  · 已有主题 ${fmtN(r.db.topics)} 个 / 句子 ${fmtN(r.db.sentences)} 句${r.db.byState ? '（' + Object.entries(r.db.byState).map(([k, v]) => k + '=' + v).join(' · ') + '）' : ''} ｜ schema_version=${r.db.schemaVersion == null ? '（无）' : r.db.schemaVersion}`);
    if (r.legacy.importableFiles) {
      p('二、旧 md（正常保留，不是待办）');
      p(`  · 旧 md 保留 ${fmtN(r.legacy.importableFiles)} 文件 / ${fmtN(r.legacy.importableSentences)} 句（历史 md 与导出视图；可选清理，不影响使用）`);
      const human = (r.legacy.humanLayer || []).filter((x) => x.exists);
      if (human.length) p(`  · 人工稳定层（可直接编辑）：${human.map((x) => `${x.name}=${fmtN(x.sentences)}句`).join(' / ')}`);
    }
    p('');
    p('三、宿主状态（只读提示，不影响）');
    p(`  · 判定：${r.host.status === 'running' ? '运行中' : r.host.status === 'assumed-stopped' ? '假定已停止' : r.host.status === 'unknown' ? '无法确认' : '未运行'}`);
    for (const e of r.host.evidence) p(`    - ${e.kind}: ${e.detail}${e.path ? '（' + e.path + '）' : ''}`);
    p('');
    p('四、建议动作');
    p('  → 无需操作：主题库已接管；旧 md 如确认不再需要可自行归档（插件不会删）');
    p('  → 如确有新增 md 想合并进库：node memtopic/src/migrate.mjs --apply --merge --yes（会先快照，可回滚）');
  } else {
    p('一、旧版 md（迁移时读取，不删除）');
    for (const [k, v] of Object.entries(r.legacy.byLayer)) p(`  · ${k.padEnd(10)} ${fmtN(v.files).padStart(5)} 文件 / ${fmtN(v.sentences).padStart(7)} 句`);
    p(`  · ${'合计'.padEnd(8)} ${fmtN(r.legacy.importableFiles).padStart(6)} 文件 / ${fmtN(r.legacy.importableSentences).padStart(7)} 句（这种 md 会导入）`);
    const human = (r.legacy.humanLayer || []).filter((x) => x.exists);
    if (human.length) p(`  · 人工稳定层（不导入，可直接编辑）：${human.map((x) => `${x.name}=${fmtN(x.sentences)}句`).join(' / ')}`);
    const ex = r.legacy.excluded || { count: 0, byReason: {} };
    p(`  · 排除：共 ${fmtN(ex.count)}（trash ${fmtN(ex.byReason.trash || 0)} / 隐藏 ${fmtN(ex.byReason.hidden || 0)} / bak ${fmtN(ex.byReason.bak || 0)} / 非扫描层 ${fmtN(ex.byReason['outside-dirs'] || 0)} / glob ${fmtN(ex.byReason['exclude-glob'] || 0)}）；非 md 忽略 ${fmtN((r.legacy.nonMdIgnored || {}).total || 0)}`);
    p('');
    p('二、主题库');
    if (r.db.hasData) {
      p(`  · 已有主题 ${fmtN(r.db.topics)} 个 / 句子 ${fmtN(r.db.sentences)} 句`);
    } else {
      p('  · 库为空（不存在或无主题）：迁移会新建主题库');
    }
    if (r.estimate) p(`  · 预计导入：${fmtN(r.estimate.files)} 文件 → 新增约 ${fmtN(r.estimate.newTopics)} 主题 / ${fmtN(r.estimate.sentences)} 句（预计 ${fmtMs(r.estimate.estMs)}，按实测粗估）`);
    if (r.checkpoint.exists) p(`  · 上次迁移记录：${Object.entries(r.checkpoint.stages).map(([k, v]) => k + '=' + v).join(' / ')}${r.resumeReady ? '（可续跑）' : ''}`);
    p('');
    p('三、宿主状态（DSH 是否在运行）');
    p(`  · 判定：${r.host.status === 'running' ? '运行中 ⚠（迁移前需先退出 DSH）' : r.host.status === 'assumed-stopped' ? '假定已停止（--assume-host-stopped）' : r.host.status === 'unknown' ? '无法确认（写库会被拒绝，需 --assume-host-stopped）' : '未运行 ✓'}`);
    for (const e of r.host.evidence) p(`    - ${e.kind}: ${e.detail}${e.path ? '（' + e.path + '）' : ''}`);
    p('');
    if (r.blockers.length) {
      p('四、阻塞项');
      for (const b of r.blockers) p(`  · [${b.code}] ${b.text}`);
      p('');
    }
    p('五、建议动作');
    if (r.recommended === 'stop') p('  → 停止：库版本高于本版，先升级插件/安装器，不要手工改 schema_version');
    else if (r.recommended === 'stop-host') p(`  → 先完全退出 DSH（含托盘/后台进程），再执行：${r.nextCommand}`);
    else if (r.recommended === 'migrate') p(`  → 执行迁移：${r.nextCommand}`);
    else p('  → 没有可迁移的数据：先正常使用即可（插件会写 md 导出视图）');
  }
  if (r.advisories && r.advisories.length) {
    p('');
    p('提示：');
    for (const a of r.advisories) p(`  · [${a.code}]${a.blocking ? '（阻塞写库）' : ''} ${a.text}`);
  }
  p('');
  p('其它入口：重跑安装器加 -Migrate ｜ 会话内 /memory-migrate ｜ 手工 node（见 docs/迁移指南.md）');
  p('注意：迁移只读取 md（不删不改）；完成后需重启 DSH 才生效。');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 5. apply：detect → 校验 → plan → apply → 摘要
// ---------------------------------------------------------------------------
function isTTY() { return !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY); }

async function confirmInteractive(question) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => { rl.question(question, resolve); });
    return /^y(es)?$/i.test(String(answer).trim());
  } finally { rl.close(); }
}

export async function applyMigration(opts = {}) {
  const t0 = Date.now();
  const targets = resolveMigrateTargets(opts);
  const log = [];
  const say = (s) => { log.push(s); if (!opts.json) console.log(s); };

  // ---- 1) detect（只读） ----
  say('=== 记忆库迁移 ===');
  say('[1/4] 检测旧版 md 与主题库…');
  const det = await detectMigration({ ...opts, dshHome: targets.dshHome });
  say(`  · 旧版 md：${fmtN(det.legacy.importableFiles)} 文件 / ${fmtN(det.legacy.importableSentences)} 句`);
  say(`  · 主题库：${det.db.exists ? `已有 ${fmtN(det.db.topics)} 主题 / ${fmtN(det.db.sentences)} 句` : '不存在（将新建）'}`);

  // ---- 2) 安全校验 ----
  if (det.blockers.some((b) => b.code === 'SCHEMA_TOO_NEW')) {
    const err = new UpgradeError('SCHEMA_TOO_NEW', det.blockers.find((b) => b.code === 'SCHEMA_TOO_NEW').text, {
      exitCode: EXIT.REFUSED, hint: '升级插件/安装器后再迁移；不要手工改 schema_version（先 --snapshot 备份）',
    });
    return finish({ opts, det, phase: 'guard', error: err, t0 });
  }
  if ((det.host.running || det.host.status === 'unknown') && !opts.assumeHostStopped) {
    const unknown = det.host.status === 'unknown';
    const err = new UpgradeError(unknown ? 'HOST_UNKNOWN' : 'HOST_RUNNING', unknown ? '无法确认 DSH 是否已停止：为安全起见拒绝写库' : 'DSH 正在运行，迁移必须在其停止时进行', {
      exitCode: EXIT.REFUSED,
      hint: '先完全退出 DSH（含托盘/后台进程），再执行本命令；若确认已退出，可加 --assume-host-stopped。依据见 --detect 报告的 host.evidence（进程扫描/' + '锁文件）',
    });
    return finish({ opts, det, phase: 'guard', error: err, t0 });
  }
  const needsMigration = det.needsMigration || (det.db.hasData && opts.merge);
  if (!needsMigration) {
    say('  · 无需迁移：' + (det.alreadyMigrated ? '主题库已有数据（旧 md 如需合并请加 --merge）' : '没有可迁移的 md'));
    const summary = { ok: true, kind: 'migrate-apply', skipped: true, reason: det.alreadyMigrated ? 'already-migrated' : 'nothing-to-migrate', detect: det, elapsedMs: Date.now() - t0, nextSteps: ['无需操作；如需合并旧 md 用 --apply --merge', '回滚：node memtopic/src/migrate.mjs --rollback'] };
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else { console.log(''); console.log('结论：无需迁移。'); console.log('下一步：无（如需合并旧 md：node memtopic/src/migrate.mjs --apply --merge --yes）'); }
    return { exitCode: EXIT.OK, summary };
  }

  // ---- 3) 确认 ----
  if (!opts.yes) {
    if (!isTTY()) {
      const err = new UpgradeError('CONFIRM_REQUIRED', '非交互环境必须显式 --yes', {
        exitCode: EXIT.USAGE, hint: '加 --yes 后重跑（安装器/Agent 场景必须带 --yes）',
      });
      return finish({ opts, det, phase: 'confirm', error: err, t0 });
    }
    const ok = await confirmInteractive(`将把 ${fmtN(det.legacy.importableFiles)} 个 md（${fmtN(det.legacy.importableSentences)} 句）导入主题库，md 不会被删除。确认执行？[y/N] `);
    if (!ok) {
      const err = new UpgradeError('CANCELLED', '用户取消', { exitCode: EXIT.USAGE, hint: '未做任何改动；需要时重新运行并输入 y（或加 --yes）' });
      return finish({ opts, det, phase: 'confirm', error: err, t0 });
    }
  }
  say('[2/4] 生成迁移计划（只读）…');
  let plan = null;
  try {
    plan = await planUpgrade({ mdRoot: targets.mdRoot, dbFile: targets.dbFile, backend: targets.kind, stateDir: targets.stateDir, dirs: targets.dirs, excludeGlobs: targets.excludeGlobs, curationConfig: opts.curationConfig });
  } catch (e) {
    // 计划失败不阻断（apply 会自己再校验），但报告里记一笔
    plan = null;
  }
  if (plan && !opts.json) {
    const imp = plan.stages.find((s) => s.stage === 'import');
    say(`  · 计划：导入 ${fmtN(imp.estimate.files)} 文件 → 预计新增 ${fmtN(imp.estimate.expectedNewTopics)} 主题 / 上界 ${fmtN(imp.estimate.expectedSentences)} 句；预计 ${fmtMs(imp.estimate.estMs)}`);
    say('  · 每阶段会先落快照 + checkpoint（失败可续跑/可回滚）');
  }

  say('[3/4] 执行迁移（导入 → 归类提案 → 应用归类）…');
  let res;
  try {
    res = await applyUpgrade({
      stage: 'all', mdRoot: targets.mdRoot, dbFile: targets.dbFile, backend: targets.kind,
      stateDir: targets.stateDir, dirs: targets.dirs, excludeGlobs: targets.excludeGlobs,
      force: !!opts.force, curationConfig: opts.curationConfig,   // actor 不传：import 阶段必须用 plugin 身份走 seed 通道
    });
  } catch (e) {
    return finish({ opts, det, phase: 'apply', plan, error: e instanceof UpgradeError ? e : new UpgradeError('MIGRATE_FAILED', (e && e.message) || String(e), { exitCode: EXIT.FAILED, hint: '先 --snapshot 备份；查看 .memtopic/upgrade/upgrade-report-*.json；修复后重跑 --apply 可续跑' }), t0 });
  }
  if (res && res.ok === true) {
    const afterDb = res.summary && res.summary.dbAfter;
    const importStage = ((res.summary && res.summary.stages) || []).find((x) => x.stage === 'import');
    const importErrors = ((importStage && importStage.stats && importStage.stats.errors) || []);
    if (det.legacy.importableSentences > 0 && (!afterDb || (afterDb.topics || 0) === 0)) {
      const err = new UpgradeError('MIGRATE_NO_DATA', '迁移执行完但主题库仍为 0 主题：导入阶段全部文件失败', {
        exitCode: EXIT.FAILED,
        hint: '查看 .memtopic/upgrade/upgrade-report-import.json 的 errors（常见：身份/权限、库损坏、md 不可读）；修复后重跑 --apply --yes',
        detail: { importErrors: importErrors.slice(0, 5) },
      });
      return finish({ opts, det, phase: 'apply', plan, applyResult: res, error: err, t0 });
    }
  }
  if (!res || res.ok !== true) {
    const err = new UpgradeError('MIGRATE_FAILED', (res && res.error && res.error.message) || '升级编排返回失败', {
      exitCode: (res && res.exitCode) || EXIT.FAILED,
      hint: (res && res.error && res.error.hint) || '查看 .memtopic/upgrade/upgrade-report-*.json；修复后重跑 --apply 可续跑',
    });
    return finish({ opts, det, phase: 'apply', plan, applyResult: res, error: err, t0 });
  }

  // ---- 4) 摘要 + 下一步 ----
  const sum = res.summary || {};
  const importStage = (sum.stages || []).find((s) => s.stage === 'import');
  const curateStage = (sum.stages || []).find((s) => s.stage === 'curate');
  const mergeStage = (sum.stages || []).find((s) => s.stage === 'apply-merge');
  const importedSkipped = !!(importStage && importStage.status === 'skipped');
  const imported = {
    files: importStage && importStage.stats ? importStage.stats.files : null,
    topicsCreated: importedSkipped ? 0 : (importStage && importStage.stats ? importStage.stats.topicsCreated : null),
    topicsMatched: importStage && importStage.stats ? importStage.stats.topicsMatched : null,
    sentencesAdded: importedSkipped ? 0 : (importStage && importStage.stats ? importStage.stats.sentencesAdded : null),
    sentencesSkipped: importStage && importStage.stats ? importStage.stats.sentencesSkipped : null,
    status: importStage ? importStage.status : null,
    note: importedSkipped ? '断点续跑：导入阶段已完成，本次未重复导入（+0 主题/+0 句）' : null,
  };
  const dbAfter = sum.dbAfter || null;
  say(`[4/4] 完成。主题库：${dbAfter ? `${fmtN(dbAfter.topics)} 主题 / ${fmtN(dbAfter.sentences)} 句` : '（统计不可用）'} ｜ 本次导入 ${fmtN(imported.sentencesAdded || 0)} 句${imported.topicsCreated != null ? ' / 新建 ' + fmtN(imported.topicsCreated) + ' 主题' : ''}`);
  if (curateStage && curateStage.stats) say(`  · 归类提案：${fmtN(curateStage.stats.clusters || 0)} 簇（拦下 ${fmtN(curateStage.stats.rejectedClusters || 0)}）→ 已写入 .memtopic/upgrade/curation-proposals.json`);
  say('  · 归类分组留待 DSH 内的 dream 整理，不影响检索（句子已全部入库，只是暂未分组；不丢任何内容）');
  if (mergeStage && mergeStage.status === 'skipped') say('  · 应用归类：按设计跳过（不做自动批量合并；迁移安全默认=只导入，绝不因未分组而丢句）');
  say(`  · 总耗时 ${fmtMs(Date.now() - t0)} ｜ 详细报告：${path.join(path.dirname(targets.activeFile), 'upgrade')}`);
  say('');
  say('★ 下一步：重启 DSH 后生效（重启前旧插件仍按 md 模式工作）。');
  say('  · 重启后可在设置页/state 卡确认：「主题库已启用，主题 N / 句 N」');
  say('  · 回滚：node memtopic/src/migrate.mjs --rollback   （或 --rollback=import 只回滚导入）');
  say('  · md 未被删除/修改：迁移只是读取；需要时仍可直接打开阅读');

  const summary = {
    ok: true,
    kind: 'migrate-apply',
    at: new Date().toISOString(),
    migrationVersion: MIGRATION_VERSION,
    targets: { mdRoot: targets.memoryRoot, db: targets.activeFile, backend: targets.kind, degraded: targets.degraded, stateDir: targets.stateDir },
    host: { status: det.host.status, assumedStopped: det.host.assumedStopped, evidence: det.host.evidence },
    imported,
    curate: curateStage && curateStage.stats ? { clusters: curateStage.stats.clusters, rejectedClusters: curateStage.stats.rejectedClusters, proposalsFile: curateStage.stats.proposalsFile } : null,
    applyMerge: mergeStage ? { status: mergeStage.status, reason: mergeStage.stats ? mergeStage.stats.reason : null } : null,
    dbAfter,
    conservation: sum.conservation || null,
    mdUnchanged: sum.md ? sum.md.unchanged : null,
    elapsedMs: Date.now() - t0,
    nextSteps: [
      '重启 DSH 后生效（重启前旧插件仍按 md 模式工作）',
      '归类分组留待 DSH 内的 dream 整理，不影响检索（句子已全部入库）',
      '回滚：node memtopic/src/migrate.mjs --rollback',
      'md 不会被删除/修改；迁移后可继续阅读，插件会以主题库为真源导出 md 视图',
    ],
  };
  if (opts.json) console.log(JSON.stringify({ ...summary, plan, apply: { exitCode: res.exitCode, summary: sum } }, null, 2));
  return { exitCode: EXIT.OK, summary };
}

function finish({ opts, det, phase, plan, applyResult, error, t0 }) {
  const exitCode = (error && error.exitCode) || EXIT.FAILED;
  const payload = {
    ok: false,
    kind: 'migrate-apply',
    at: new Date().toISOString(),
    migrationVersion: MIGRATION_VERSION,
    phase,
    exitCode,
    error: { code: error.code, message: error.message, hint: error.hint || null },
    detect: det,
    plan: plan || null,
    apply: applyResult ? { exitCode: applyResult.exitCode, results: applyResult.results } : null,
    elapsedMs: Date.now() - t0,
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.error('迁移未完成：' + error.message);
    if (error.hint) console.error('下一步：' + error.hint);
  }
  return { exitCode, summary: payload };
}

// ---------------------------------------------------------------------------
// 6. rollback / snapshot
// ---------------------------------------------------------------------------
export async function rollbackMigration(opts = {}) {
  const targets = resolveMigrateTargets(opts);
  const which = opts.stage || 'all';
  const log = (s) => { if (!opts.json) console.log(s); };
  log('=== 迁移回滚 ===');
  log(`目标：${which} ｜ 主题库：${targets.activeFile}`);
  let res;
  try {
    res = await rollbackUpgrade({ rollback: which, mdRoot: targets.mdRoot, dbFile: targets.dbFile, backend: targets.kind, stateDir: targets.stateDir, actor: 'lead' });
  } catch (e) {
    const err = e instanceof UpgradeError ? e : new UpgradeError('ROLLBACK_FAILED', (e && e.message) || String(e), { exitCode: EXIT.ROLLBACK_FAILED, hint: '先 --snapshot 备份；检查 .memtopic/upgrade/checkpoint.json 与 upgrade-report-rollback-*.json' });
    if (opts.json) console.log(JSON.stringify({ ok: false, kind: 'migrate-rollback', error: { code: err.code, message: err.message, hint: err.hint || null } }, null, 2));
    else { console.error('回滚失败：' + err.message); console.error('下一步：' + (err.hint || '检查 checkpoint 与报告')); }
    return { exitCode: err.exitCode || EXIT.ROLLBACK_FAILED };
  }
  const summary = { ok: !!res.ok, kind: 'migrate-rollback', which, results: (res.results || []).map((r) => ({ stage: r.stage, status: r.status, detail: r.detail || null })), elapsedMs: res.ms, nextSteps: ['如要重新迁移：node memtopic/src/migrate.mjs --apply --yes', 'md 始终未被删除；回滚只影响主题库'] };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    for (const r of summary.results) log(`  · ${r.stage}: ${r.status}${r.detail ? '（' + (r.detail.mode || '') + '）' : ''}`);
    log('');
    log('回滚完成。md 未被改动；如需重新迁移：node memtopic/src/migrate.mjs --apply --yes');
  }
  return { exitCode: res.exitCode != null ? res.exitCode : EXIT.OK, summary };
}

export async function snapshotMigration(opts = {}) {
  const targets = resolveMigrateTargets(opts);
  const info = snapshotDb({ dbFile: targets.dbFile, backend: targets.kind, stateDir: targets.stateDir, label: opts.label || 'manual' });
  if (opts.json) console.log(JSON.stringify(info, null, 2));
  else console.log(formatSnapshot(info));
  return { exitCode: info.ok ? EXIT.OK : EXIT.REFUSED, summary: info };
}

// ---------------------------------------------------------------------------
// 7. CLI
// ---------------------------------------------------------------------------
const USAGE = `老用户记忆库迁移（薄编排层；实际执行由 upgrade.mjs 完成）

用法：
  node memtopic/src/migrate.mjs --detect [选项]        只读检测（人话报告；--json 机器可读）
  node memtopic/src/migrate.mjs --apply [--yes] [选项]  迁移（detect→plan→apply→摘要→重启提示）
  node memtopic/src/migrate.mjs --rollback[=<stage|all>] [选项]  回滚（默认 all）
  node memtopic/src/migrate.mjs --snapshot [选项]       迁移前手工备份
  node memtopic/src/migrate.mjs --version | --help

选项：
  --yes                    非交互确认（安装器/Agent 必须带）
  --merge                  主题库已有数据时，显式确认"把旧 md 合并进来"
  --assume-host-stopped    跳过宿主运行检测（仅在你已确认 DSH 完全退出时）
  --no-process-scan        关闭进程扫描（只用锁文件判定；受限环境用）
  --db <file>              主题库路径（默认 <md-root>/.memtopic/mem.db；env MEMTOPIC_DB）
  --md-root <dir>          记忆目录（默认 ~/.dsh/memory；env MEMTOPIC_MD_ROOT）
  --dsh-home <dir>         宿主主目录（默认 ~/.dsh；env DSH_HOME）——只读探测锁/pid
  --backend <k>            auto|sqlite|ledger（默认 auto；sqlite 不可用自动降级 ledger）
  --state-dir <dir>        checkpoint/报告/快照目录（默认 <db 目录>/upgrade）
  --stage <stage>          --rollback 用：import|curate|apply-merge|all
  --json                   输出 JSON（供安装器/Agent 解析）

退出码（与 upgrade.mjs 一致）：0 成功/按设计跳过 ｜ 1 参数错误/未确认 ｜ 2 拒绝执行（宿主运行中/库不空/版本过高）｜ 3 阶段失败 ｜ 4 回滚失败`;

function parseArgs(argv) {
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
    if (a === '--apply') { out.mode = 'apply'; continue; }
    if (a === '--snapshot') { out.mode = 'snapshot'; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--merge') { out.merge = true; continue; }
    if (a === '--assume-host-stopped') { out.assumeHostStopped = true; continue; }
    if (a === '--no-process-scan') { out.noProcessScan = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--version' || a === '-v') { out.version = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--rollback')) {
      out.mode = 'rollback';
      if (a.includes('=')) out.stage = a.slice(a.indexOf('=') + 1);
      else if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) { out.stage = argv[i + 1]; i++; }
      continue;
    }
    if (a.startsWith('--stage')) {
      const r = take(i, 'stage'); out.stage = r.value; i = r.next; continue;
    }
    const eq = (name) => a === '--' + name || a.startsWith('--' + name + '=');
    if (eq('db')) { const r = take(i, 'db'); out.dbFile = r.value; i = r.next; continue; }
    if (eq('md-root')) { const r = take(i, 'md-root'); out.mdRoot = r.value; i = r.next; continue; }
    if (eq('dsh-home')) { const r = take(i, 'dsh-home'); out.dshHome = r.value; i = r.next; continue; }
    if (eq('backend')) { const r = take(i, 'backend'); out.backend = r.value; i = r.next; continue; }
    if (eq('state-dir')) { const r = take(i, 'state-dir'); out.stateDir = r.value; i = r.next; continue; }
    if (eq('dirs')) { const r = take(i, 'dirs'); out.dirs = String(r.value || '').split(',').map((s) => s.trim()).filter(Boolean); i = r.next; continue; }
    if (eq('curation-config')) {
      const r = take(i, 'curation-config'); i = r.next;
      try { out.curationConfig = JSON.parse(String(r.value)); } catch { throw new UpgradeError('BAD_ARG', '--curation-config 不是合法 JSON', { exitCode: EXIT.USAGE, hint: '传 JSON 字符串' }); }
      continue;
    }
    throw new UpgradeError('BAD_ARG', '未知参数：' + a, { exitCode: EXIT.USAGE, hint: '运行 node memtopic/src/migrate.mjs --help 查看用法' });
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  let cli;
  try { cli = parseArgs(argv); } catch (e) {
    console.error('错误：' + e.message);
    console.error('下一步：' + (e.hint || '运行 --help 查看用法'));
    return e.exitCode || EXIT.USAGE;
  }
  if (cli.help) { console.log(USAGE); return EXIT.OK; }
  if (cli.version) {
    console.log(JSON.stringify({ migrate_version: MIGRATION_VERSION, schema_version: SCHEMA_VERSION, exit_codes: EXIT, upgrade: 'memtopic/src/upgrade.mjs' }, null, 2));
    return EXIT.OK;
  }
  if (!cli.mode) {
    console.error('错误：必须指定 --detect / --apply / --rollback / --snapshot 之一');
    console.error(USAGE);
    return EXIT.USAGE;
  }
  const opts = { ...cli };
  try {
    if (cli.mode === 'detect') {
      const r = await detectMigration(opts);
      console.log(cli.json ? JSON.stringify(r, null, 2) : formatMigrateDetect(r));
      if (r.blockers.some((b) => b.code === 'SCHEMA_TOO_NEW')) {
        console.error('下一步：库 schema_version 高于本版，先升级插件/安装器；不要手工改 schema_version');
        return EXIT.REFUSED;
      }
      return EXIT.OK;
    }
    if (cli.mode === 'apply') {
      const r = await applyMigration(opts);
      return r.exitCode;
    }
    if (cli.mode === 'rollback') {
      const r = await rollbackMigration(opts);
      return r.exitCode;
    }
    if (cli.mode === 'snapshot') {
      const r = await snapshotMigration(opts);
      return r.exitCode;
    }
    console.error('错误：未知模式');
    return EXIT.USAGE;
  } catch (e) {
    const err = e instanceof UpgradeError ? e : new UpgradeError('UNEXPECTED', (e && e.message) || String(e), { exitCode: EXIT.FAILED, hint: '先 --snapshot 备份；把错误与 .memtopic/upgrade/ 报告报给开发' });
    if (cli.json) console.log(JSON.stringify({ ok: false, kind: 'migrate-' + cli.mode, error: { code: err.code, message: err.message, hint: err.hint || null }, exitCode: err.exitCode }, null, 2));
    else { console.error('错误：' + err.message); console.error('下一步：' + (err.hint || '检查参数后重试')); }
    return err.exitCode || EXIT.FAILED;
  }
}

function isMain() {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
}
if (isMain()) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('错误：' + ((e && e.message) || e));
    console.error('下一步：先 --snapshot 备份；把错误与 .memtopic/upgrade/ 报告报给开发');
    process.exit(EXIT.FAILED);
  });
}
