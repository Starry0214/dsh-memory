// 阶段 7.5 第二步：归类**应用编排**（task-13）。
//
// 职责：读 task-12/task-17 的 dry-run 提案 → `--list` 让人逐簇决策 → `--apply --cluster=...` 点到点执行
// （每簇一个事务，调用 store.mergeCluster / undoMergeCluster）→ 落 `apply-report.json`。
//
// 安全默认（用户决策 2026-10-29）：
//   · **默认 dry-run**：不带 `--apply` 只打印，不写库；
//   · 不做自动批量：`--apply` 必须显式 `--cluster=C-001[,C-002]`；
//   · `--apply-all-confident` 只有**显式传 `--min-confidence=<数值>`** 才生效，否则拒绝执行；
//   · 拒绝把 `~/.dsh/**` 当目标库（正式库只由 Lead 决定时机；测试/演练只用仓库内副本）；
//   · 提案来源默认 `.run/curation/curation-proposals.json`，可 `--proposals=` 指定（task-17 新产物同 schema 或数组均可）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MemoryStore, MemError } from './memory-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const DEFAULT_APPLY_CFG = Object.freeze({
  proposalsFile: path.join(ROOT, '.run', 'curation', 'curation-proposals.json'),
  outDir: path.join(ROOT, '.run', 'curation-apply'),
  maxKeep: 120,
  minConfidence: null,     // 批量模式必须显式传；默认禁用
  actor: 'lead',
});

const REPO_DB_CANDIDATES = [
  path.join(ROOT, '.run', 'retrigger', 'legacy', 'mem.db'),
  path.join(ROOT, '.run', 'rehearse', 'dbA', 'mem.db'),
  path.join(ROOT, '.run', 'rehearse', 'dbB', 'mem.db'),
];

// ---------------------------------------------------------------------------
// 提案归一化（容忍 task-12 与 task-17 两种形状）
// ---------------------------------------------------------------------------
/** 把任意提案容器归一化为 {clusters:[{clusterId,title,members,confidence,riskFlags,keepRefs,keepShas}], scale} */
export function normProposals(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (src && Array.isArray(src.clusters)) list = src.clusters;
  else if (src && src.proposals && Array.isArray(src.proposals.clusters)) list = src.proposals.clusters;
  else if (src && src.proposals && Array.isArray(src.proposals)) list = src.proposals;
  const clusters = list.map((c, i) => {
    const id = String((c && (c.clusterId || c.id || c.key)) || 'C-' + String(i + 1).padStart(3, '0'));
    const members = (Array.isArray(c && c.members) ? c.members : []).map((m) => (typeof m === 'string' ? m : (m && (m.id || m.topicId)) || '')).filter(Boolean);
    let keepRefs = [];
    let keepShas = [];
    if (Array.isArray(c && c.keepRefs)) keepRefs = c.keepRefs.map((r) => ({ topicId: r.topicId || r.topic, ord: Number(r.ord) }));
    else if (c && c.keepSuggestions && Array.isArray(c.keepSuggestions.sentences)) {
      keepRefs = c.keepSuggestions.sentences.map((s) => ({ topicId: s.topicId || s.topic, ord: Number(s.ord) }));
    }
    if (Array.isArray(c && c.keepSentenceShas)) keepShas = c.keepSentenceShas.slice();
    else if (Array.isArray(c && c.keepShas)) keepShas = c.keepShas.slice();
    return {
      clusterId: id,
      title: String((c && (c.suggestedTitle || c.title || c.name)) || ('合并簇 ' + id)).trim(),
      members,
      confidence: Number.isFinite(Number(c && c.confidence)) ? Number(c.confidence) : null,
      riskFlags: Array.isArray(c && c.riskFlags) ? c.riskFlags.slice() : [],
      keepRefs, keepShas,
      raw: c,
    };
  });
  return { clusters, scale: (src && src.scale) || null, source: raw };
}

export function loadProposals(file, fsImpl = fs) {
  const f = file || DEFAULT_APPLY_CFG.proposalsFile;
  if (!fsImpl.existsSync(f)) throw new MemError('PROPOSALS_NOT_FOUND', '提案文件不存在：' + f, { file: f });
  let raw;
  try { raw = JSON.parse(fsImpl.readFileSync(f, 'utf8')); } catch (e) { throw new MemError('PROPOSALS_BAD_JSON', '提案文件不是合法 JSON：' + f, { file: f, cause: String(e && e.message) }); }
  return { file: f, ...normProposals(raw) };
}

/** 可应用簇清单（按置信度降序；低置信/风险标记原样带出，供人看） */
export function listApplicable(proposals, { minConfidence = null } = {}) {
  const p = proposals && proposals.clusters ? proposals : normProposals(proposals);
  const rows = p.clusters
    .filter((c) => c.members.length >= 2)
    .filter((c) => minConfidence == null || (c.confidence != null && c.confidence >= minConfidence))
    .map((c) => ({
      clusterId: c.clusterId, title: c.title, size: c.members.length, members: c.members.slice(),
      confidence: c.confidence, riskFlags: c.riskFlags.slice(),
    }));
  rows.sort((a, b) => (b.confidence == null ? -1 : b.confidence) - (a.confidence == null ? -1 : a.confidence) || (a.clusterId < b.clusterId ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// 安全闸
// ---------------------------------------------------------------------------
/** 是否位于 ~/.dsh/**（正式库/插件 profile） */
export function isLiveDbPath(dbPath) {
  const abs = path.resolve(String(dbPath || ''));
  const dsh = path.resolve(path.join(os.homedir(), '.dsh'));
  return abs === dsh || abs.startsWith(dsh + path.sep);
}

/** 放行开关是否开启（env MEMTOPIC_ALLOW_LIVE=1/true，或 CLI --allow-live） */
export function allowLiveEnabled({ env = (typeof process !== 'undefined' ? process.env : {}), flag = false } = {}) {
  if (flag === true) return true;
  const v = env ? env.MEMTOPIC_ALLOW_LIVE : null;
  return v === '1' || String(v == null ? '' : v).trim().toLowerCase() === 'true';
}

/**
 * 拒绝 ~/.dsh/** 作为目标（正式库/插件 profile 归 Lead；本模块只允许仓库内副本）。
 * task-34：增加**显式放行通道**（不拆闸）：
 *   · MEMTOPIC_ALLOW_LIVE=1 或 --allow-live（调用方传 allowLive）⇒ 放行；
 *   · 但只对**显式指定的 --db** 生效：explicitDb=false（回落默认库）⇒ 仍然拒绝；
 *   · 未设置开关 ⇒ 行为与原来完全一致（LIVE_DB_FORBIDDEN）。
 */
export function assertSafeDb(dbPath, { allowLive, explicitDb = true, env } = {}) {
  const abs = path.resolve(String(dbPath || ''));
  const dsh = path.resolve(path.join(os.homedir(), '.dsh'));
  if (abs === dsh || abs.startsWith(dsh + path.sep)) {
    const live = allowLive === undefined ? allowLiveEnabled({ env }) : allowLive === true;
    if (!live) throw new MemError('LIVE_DB_FORBIDDEN', '拒绝操作 ~/.dsh 下的库（正式库只由 Lead 决定时机；如需落正式库请显式 MEMTOPIC_ALLOW_LIVE=1 + --db <正式库路径>）', { db: abs });
    if (!explicitDb) throw new MemError('LIVE_DB_FORBIDDEN', '回落默认库时禁止写 ~/.dsh 正式库：请显式 --db <路径>（防止忘了写参数误写正式库）', { db: abs, reason: 'default-db' });
    return abs;
  }
  return abs;
}

/**
 * CLI/批量参数闸（纯函数，spec 直接断言）：
 *   · --apply-all-confident 未显式传 min-confidence ⇒ EXPLICIT_THRESHOLD_REQUIRED
 *   · --apply 未点名 cluster ⇒ CLUSTER_REQUIRED
 *   · --apply 与 --apply-all-confident 互斥语义：两者都传时以 cluster 点名优先，但仍要求阈值合法
 */
export function guardApplyArgs({ apply = false, clusterIds = [], applyAllConfident = false, minConfidence = null } = {}) {
  const ids = (clusterIds || []).map(String).filter(Boolean);
  const thr = minConfidence == null || minConfidence === '' ? null : Number(minConfidence);
  if (applyAllConfident) {
    if (thr == null || !Number.isFinite(thr)) {
      throw new MemError('EXPLICIT_THRESHOLD_REQUIRED',
        '--apply-all-confident 必须显式传 --min-confidence=<数值>（默认禁用批量合并，避免误伤）',
        { flag: '--apply-all-confident', got: minConfidence });
    }
    if (thr < 0 || thr > 1) throw new MemError('BAD_THRESHOLD', '--min-confidence 需在 0..1 之间', { got: thr });
  }
  if (apply && !ids.length && !applyAllConfident) {
    throw new MemError('CLUSTER_REQUIRED', '--apply 必须点名 `--cluster=C-001[,C-002]`（或显式 --apply-all-confident --min-confidence=…）', { got: clusterIds });
  }
  return { apply, clusterIds: ids, applyAllConfident, minConfidence: thr };
}

/** 选出本次要执行的簇 */
export function selectClusters(proposals, { clusterIds = [], applyAllConfident = false, minConfidence = null } = {}) {
  const p = proposals && proposals.clusters ? proposals : normProposals(proposals);
  let chosen;
  if (applyAllConfident) chosen = p.clusters.filter((c) => c.members.length >= 2 && c.confidence != null && c.confidence >= minConfidence);
  else {
    const ids = new Set((clusterIds || []).map(String));
    chosen = p.clusters.filter((c) => ids.has(c.clusterId));
    const missing = [...ids].filter((id) => !chosen.some((c) => c.clusterId === id));
    if (missing.length) throw new MemError('CLUSTER_NOT_FOUND', '提案里找不到簇：' + missing.join(','), { missing });
  }
  for (const c of chosen) {
    if (c.members.length < 2) throw new MemError('BAD_CLUSTER', `簇 ${c.clusterId} 成员不足 2 个`, { clusterId: c.clusterId, members: c.members });
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// dry-run 计划（不写库）
// ---------------------------------------------------------------------------
export function planApply({ store, proposals, clusterIds, applyAllConfident, minConfidence, maxKeep = DEFAULT_APPLY_CFG.maxKeep }) {
  const chosen = selectClusters(proposals, { clusterIds, applyAllConfident, minConfidence });
  const rows = chosen.map((c) => {
    const members = c.members.map((ref) => {
      try {
        const t = store.readTopic(ref);
        return { ref, id: t.id, name: t.name, state: t.state, sentences: t.sentences.length, chars: t.chars };
      } catch (e) {
        return { ref, error: e instanceof MemError ? e.code : String(e && e.message) };
      }
    });
    const totalSentences = members.reduce((a, m) => a + (m.sentences || 0), 0);
    const totalChars = members.reduce((a, m) => a + (m.chars || 0), 0);
    const keepCount = c.keepRefs.length ? c.keepRefs.length : c.keepShas.length ? c.keepShas.length : Math.min(maxKeep, totalSentences);
    const warnings = [];
    if (totalSentences > maxKeep) warnings.push(`成员共 ${totalSentences} 句 > 保留上限 ${maxKeep}（其余转明细子主题）`);
    if (members.some((m) => m.error)) warnings.push('存在无法解析的成员：' + members.filter((m) => m.error).map((m) => m.ref).join(','));
    if (keepCount > maxKeep) warnings.push(`显式保留 ${keepCount} 句 > 上限 ${maxKeep}`);
    return { clusterId: c.clusterId, title: c.title, confidence: c.confidence, riskFlags: c.riskFlags.slice(), members, totalSentences, totalChars, keepCount, warnings };
  });
  return { clusters: rows, summary: { clusters: rows.length, members: rows.reduce((a, r) => a + r.members.length, 0), totalSentences: rows.reduce((a, r) => a + r.totalSentences, 0) } };
}

// ---------------------------------------------------------------------------
// 执行（每簇一个事务；单簇失败不影响其它簇，失败整簇回滚由 store 保证）
// ---------------------------------------------------------------------------
function statsOf(store) {
  const c = typeof store.topicCounts === 'function' ? store.topicCounts() : null;
  const tps = c ? null : store.topics();
  const counts = c || {
    total: tps.length,
    effective: tps.filter((t) => t.state !== 'archived' && !t.parentId).length,
    nonArchived: tps.filter((t) => t.state !== 'archived').length,
    archived: tps.filter((t) => t.state === 'archived').length,
    merged: tps.filter((t) => !!t.mergedInto).length,
    // task-18：主主题 = 域 + 项目线；明细单列（无显式/推导层级时退回 0，仅影响展示）
    main: { domains: 0, projects: 0, total: 0 },
    details: 0,
    mergeViews: tps.filter((t) => t.mergeRole === 'main').length,
    detailViews: tps.filter((t) => t.mergeRole === 'child').length,
    active: tps.filter((t) => t.state === 'active').length,
    draft: tps.filter((t) => t.state === 'draft').length,
    needsReview: tps.filter((t) => t.state === 'needs_review').length,
    dormant: tps.filter((t) => t.state === 'dormant').length,
    sentences: tps.reduce((a, t) => a + (t.sentences || 0), 0),          // 有效句数（视图优先）
    physicalSentences: tps.reduce((a, t) => a + (t.physicalSentences || 0), 0),
  };
  const rows = store.be.listTopics();
  const distinctShas = new Set(rows.flatMap((t) => (store.be.listSentences(t.id) || []).map((s) => s.sha))).size;
  return {
    // 「主题数」对外一律用**有效主题数**；三级结构再给 main（域+项目线）/ details 拆分
    topics: counts.effective,
    effective: counts.effective,
    total: counts.total,
    nonArchived: counts.nonArchived,
    archived: counts.archived,
    merged: counts.merged,
    main: counts.main,                 // {domains, projects, total}
    mainTopics: counts.main.total,      // 主主题数（目标 ≤60 的口径）
    domains: counts.main.domains,
    projects: counts.main.projects,
    details: counts.details,
    mergeViews: counts.mergeViews,
    detailViews: counts.detailViews,
    sentences: counts.sentences,
    physicalSentences: counts.physicalSentences,
    active: counts.active,
    draft: counts.draft,
    needsReview: counts.needsReview,
    dormant: counts.dormant,
    distinctShas,
  };
}

export function applyProposals({ store, proposals, clusterIds, applyAllConfident = false, minConfidence = null, actor = DEFAULT_APPLY_CFG.actor, maxKeep = DEFAULT_APPLY_CFG.maxKeep, reason = null } = {}) {
  const chosen = selectClusters(proposals, { clusterIds, applyAllConfident, minConfidence });
  const before = statsOf(store);
  const results = [];
  for (const c of chosen) {
    const startedAt = Date.now();
    try {
      const args = {
        members: c.members, title: c.title, actor, maxKeep, reason: reason || ('curation-apply:' + c.clusterId),
      };
      if (c.keepRefs.length) args.keepRefs = c.keepRefs;
      else if (c.keepShas.length) args.keepSentenceShas = c.keepShas;
      const r = store.mergeCluster(args);
      results.push({ clusterId: c.clusterId, ok: true, changed: r.changed, reused: !!r.reused, mergeId: r.mergeId, mainTopicId: r.mainTopicId, childTopicId: r.childTopicId, mainId: r.mainId, childId: r.childId, keepCount: r.keepCount, childCount: r.childCount, sentencesConserved: r.sentencesConserved, ms: Date.now() - startedAt });
    } catch (e) {
      results.push({ clusterId: c.clusterId, ok: false, code: e instanceof MemError ? e.code : 'ERROR', message: String(e && e.message), ms: Date.now() - startedAt });
    }
  }
  const after = statsOf(store);
  let verify = null;
  try { verify = store.verify(); } catch (e) { verify = { ok: false, bad: [{ why: String(e && e.message) }] }; }
  const totals = {
    clusters: chosen.length,
    applied: results.filter((r) => r.ok && r.changed > 0).length,
    reused: results.filter((r) => r.reused).length,
    failed: results.filter((r) => !r.ok).length,
    // 对外口径：有效主题数变化（负数=变少=进步）；archived/merged 单独记
    changedEffectiveTopics: after.effective - before.effective,
    changedPhysicalTopics: after.total - before.total,
    archivedDelta: after.archived - before.archived,
    mergedSourcesDelta: after.merged - before.merged,
    sentencesConserved: before.sentences === after.sentences,
  };
  return { ok: results.every((r) => r.ok), results, totals, before, after, verify };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/**
 * 参数解析（P0 同类修复，与 tree-apply.parseArgs 保持一致）：
 *   同时支持 `--k=v` 与 `--k v`；`--k` 后跟 `--` 开头视为缺值；布尔开关不受影响。
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const has = (k) => args.includes('--' + k);
  const get = (k, d = '') => {
    const eqPrefix = '--' + k + '=';
    const withEq = args.find((x) => x.startsWith(eqPrefix));
    if (withEq) return withEq.slice(eqPrefix.length);
    const idx = args.indexOf('--' + k);
    if (idx >= 0) {
      const next = args[idx + 1];
      if (next != null && !next.startsWith('--')) return next;
    }
    return d;
  };
  return {
    db: get('db'),
    proposals: get('proposals'),
    out: get('out'),
    cluster: get('cluster'),
    minConfidence: get('min-confidence', null),
    apply: has('apply'),
    list: has('list'),
    applyAllConfident: has('apply-all-confident'),
    allowLive: has('allow-live'),
    json: has('json'),
    help: has('help'),
  };
}

function defaultDb() {
  for (const f of REPO_DB_CANDIDATES) if (fs.existsSync(f)) return f;
  return '';
}

async function openStore(dbFile) {
  const isSqlite = /\.(db|sqlite|db3)$/i.test(dbFile);
  if (isSqlite) {
    const m = await import('./backend-sqlite.mjs');
    const be = new m.SqliteBackend(dbFile);
    return { store: new MemoryStore(be), be };
  }
  const m = await import('./backend-ledger.mjs');
  const be = new m.LedgerBackend(dbFile);
  return { store: new MemoryStore(be), be };
}

function printList(rows) {
  console.log('可应用簇（按置信度降序；低置信/风险标记原样带出）：');
  if (!rows.length) { console.log('  （没有成员 ≥2 的簇）'); return; }
  for (const r of rows) {
    console.log(`  ${r.clusterId}  ${String(r.size).padStart(2)} 成员  置信 ${r.confidence == null ? '?' : r.confidence}  「${r.title}」` + (r.riskFlags.length ? '  ⚠ ' + r.riskFlags.join('；') : ''));
    console.log('        成员：' + r.members.slice(0, 8).join(',') + (r.members.length > 8 ? ' …' : ''));
  }
}

function printPlan(plan) {
  console.log('=== dry-run 计划（不写库）===');
  for (const c of plan.clusters) {
    console.log(`\n[${c.clusterId}] 「${c.title}」 置信 ${c.confidence == null ? '?' : c.confidence} ｜ 成员 ${c.members.length} ｜ 共 ${c.totalSentences} 句/${c.totalChars} 字 ｜ 预计保留 ${c.keepCount} 句`);
    for (const m of c.members) console.log('   - ' + (m.error ? `${m.ref} ❌ ${m.error}` : `${m.id} ${m.state}「${m.name}」 ${m.sentences} 句`));
    for (const w of c.warnings) console.log('   ⚠ ' + w);
    if (c.riskFlags.length) console.log('   ⚠ ' + c.riskFlags.join('；'));
  }
  console.log(`\n小计：${plan.summary.clusters} 簇 / ${plan.summary.members} 成员 / ${plan.summary.totalSentences} 句`);
}

function printResult(r) {
  console.log(`\n=== 执行结果（${r.totals.clusters} 簇）===`);
  for (const x of r.results) {
    if (x.ok) console.log(`  ✅ ${x.clusterId}  changed=${x.changed}${x.reused ? '（幂等复用）' : ''} mergeId=${x.mergeId} 主=${x.mainTopicId} 明细=${x.childTopicId || '（无）'} 保留 ${x.keepCount} 句 / 明细 ${x.childCount} 句 / 守恒=${x.sentencesConserved}`);
    else console.log(`  ❌ ${x.clusterId}  ${x.code}  ${x.message}`);
  }
  // 对外主题数一律用"有效主题数"（非 archived 且非明细）；archived/merged 单独显示
  const fmt = (s) => `有效主题 ${s.effective}（主主题 ${s.mainTopics}=域 ${s.domains} + 项目线 ${s.projects} / 明细 ${s.details} / 物理行 ${s.total} / archived ${s.archived} / 已合并 ${s.merged}）句 ${s.sentences}`;
  console.log(`  before: ${fmt(r.before)}`);
  console.log(`  after : ${fmt(r.after)}`);
  console.log(`  变化：有效主题 ${r.totals.changedEffectiveTopics >= 0 ? '+' : ''}${r.totals.changedEffectiveTopics} ｜ archived +${r.totals.archivedDelta} ｜ 物理行 ${r.totals.changedPhysicalTopics >= 0 ? '+' : ''}${r.totals.changedPhysicalTopics}`);
  console.log(`  守恒：句子总数（有效口径）${r.before.sentences} → ${r.after.sentences} ${r.totals.sentencesConserved ? '✅ 相等' : '❌ 不等'} ｜ 去重 sha ${r.before.distinctShas} → ${r.after.distinctShas} ${r.before.distinctShas === r.after.distinctShas ? '✅' : '❌'} ｜ verify=${r.verify && r.verify.ok ? 'OK' : 'FAIL'}`);
}

export async function runCli(argv, { openStoreImpl = openStore, fsImpl = fs } = {}) {
  const a = parseArgs(argv);
  const mode = a.apply ? 'apply' : 'dry-run';
  const fallback = !a.db;
  const rawDb = a.db || defaultDb();
  const proposalsFile = a.proposals || DEFAULT_APPLY_CFG.proposalsFile;
  const clusterIds = a.cluster ? a.cluster.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // task-34：正式库放行只对显式 --db 生效（回落默认库仍拒）
  const envAllow = allowLiveEnabled({ env: process.env, flag: a.allowLive });
  const liveAllowed = envAllow && !!a.db;
  // 启动第一行起打印解析结果（P0：空格形式 --db/--cluster 曾被吞 ⇒ 写错库/变成未指定簇）
  console.log('目标库：' + (rawDb ? path.resolve(rawDb) : '(无：未指定 --db 且未找到默认副本)'));
  console.log('提案文件：' + path.resolve(proposalsFile));
  console.log('模式：' + mode);
  console.log('簇：' + (clusterIds.length ? clusterIds.join(',') : (a.applyAllConfident ? '全部（min-confidence=' + (a.minConfidence == null ? '未指定' : a.minConfidence) + '）' : '未指定')));
  if (fallback) console.log('⚠️ 未指定 --db，使用默认库 ' + (rawDb || '(无)'));
  if (liveAllowed) console.log('⚠️ 已放行正式库写入（' + (a.allowLive ? '--allow-live' : 'MEMTOPIC_ALLOW_LIVE=1') + '）：' + path.resolve(rawDb));
  if (a.help) {
    console.log('用法：node src/curation-apply.mjs --db <副本.db> [--proposals=<json>] [--list] [--apply --cluster=C-001[,C-002]] [--apply-all-confident --min-confidence=0.7] [--out=<dir>] [--json] [--allow-live]（--k=v 与 --k v 两种写法都支持）');
    console.log('默认 dry-run（只读）；--apply 才能落库；默认拒绝 ~/.dsh/** 目标（正式库需显式 MEMTOPIC_ALLOW_LIVE=1 或 --allow-live + 显式 --db）。');
    return { ok: true, mode: 'help' };
  }
  if (!rawDb) throw new MemError('DB_REQUIRED', '未指定 --db 且没有可用默认副本（不再静默回落）');
  const db = assertSafeDb(rawDb, { allowLive: liveAllowed, explicitDb: !!a.db });
  const liveInUse = liveAllowed && isLiveDbPath(db);
  const guard = guardApplyArgs({ apply: a.apply, clusterIds, applyAllConfident: a.applyAllConfident, minConfidence: a.minConfidence });
  const proposals = loadProposals(proposalsFile, fsImpl);
  const rows = listApplicable(proposals, { minConfidence: guard.minConfidence });

  const outDir = a.out || DEFAULT_APPLY_CFG.outDir;
  if (!a.apply) {
    printList(rows);
    if (db) {
      const safe = assertSafeDb(db, { allowLive: liveAllowed, explicitDb: !!a.db });
      const { store, be } = await openStoreImpl(safe);
      try {
        // dry-run 未点名时：把 --list 里全部可应用簇都纳入计划（只读，不写库）
        const planIds = guard.clusterIds.length ? guard.clusterIds : rows.map((r) => r.clusterId);
        const plan = planApply({ store, proposals, clusterIds: planIds, applyAllConfident: guard.applyAllConfident, minConfidence: guard.minConfidence });
        printPlan(plan);
        console.log('\n当前库：' + safe + ' ｜ 主题 ' + statsOf(store).topics + ' / 句 ' + statsOf(store).sentences);
        if (a.json) console.log(JSON.stringify({ mode: 'dry-run', list: rows, plan, db: safe, allowLive: liveInUse }, null, 2));
      } finally { try { be.close(); } catch (e) { /* noop */ } }
    }
    return { ok: true, mode: 'dry-run', list: rows };
  }
  // apply
  if (!db) throw new MemError('DB_REQUIRED', '--apply 需要 --db=<仓库内副本>（未找到默认副本）');
  const safe = assertSafeDb(db, { allowLive: liveAllowed, explicitDb: !!a.db });
  const { store, be } = await openStoreImpl(safe);
  let result;
  try {
    result = applyProposals({ store, proposals, clusterIds: guard.clusterIds, applyAllConfident: guard.applyAllConfident, minConfidence: guard.minConfidence });
  } finally { try { be.close(); } catch (e) { /* noop */ } }
  fsImpl.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'apply-report.json');
  const report = { at: Date.now(), db: safe, dbPath: safe, allowLive: liveInUse, proposalsFile, mode: 'apply', clusters: guard.clusterIds, minConfidence: guard.minConfidence, ...result };
  fsImpl.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  if (a.json) console.log(JSON.stringify(report, null, 2)); else { printResult(result); console.log('\n报告：' + reportFile); }
  return { ...result, reportFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error('FAIL  ' + (e instanceof MemError ? e.code : 'ERROR') + '  ' + (e && e.message));
    process.exitCode = 2;
  });
}
