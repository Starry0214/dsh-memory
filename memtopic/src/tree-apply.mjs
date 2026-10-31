// 树落库入口（task-20）：把 curator 的三级树（curation-tree.json）**挂**到库里。
//
// 语义（与 curation-apply 的"合并"完全不同，别混）：
//   · **不搬任何句子、不建合并视图**：源主题物理句子原地不动；
//   · L1 域 = createDomain（active 容器）；
//   · L2 项目线 = 新建 active 容器（名字=族名清洗 + "（项目线）"），setLevel(project) + linkParent(project, domain)；
//   · L3 明细 = 多成员/系列族的成员 setLevel(detail) + linkParent(member, project) + setState(dormant)；
//     单主题族 = 成员 setLevel(detail) + linkParent(member, domain)（不建项目线）；
//   · "未归类待判定"D6 的成员**不挂父**（保持顶层独立），报告里列出；
//   · 幂等：同树重复 apply 命中 meta 记录 ⇒ 0 变更；`--undo` 解绑 + 恢复状态/层级 + 归档本次新建容器（不删）。
//
// CLI：
//   node src/tree-apply.mjs --db <copy.db> --tree .run/curation-v3/curation-tree.json [--apply|--undo] [--out <dir>]
//   默认 dry-run（只读打印计划）；安全闸拒绝 ~/.dsh/**（沿用 curation-apply.assertSafeDb）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryStore, MemError, normalizeName } from './memory-store.mjs';
import { assertSafeDb } from './curation-apply.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const DEFAULT_TREE_APPLY = Object.freeze({
  treeFile: path.join(ROOT, '.run', 'curation-v3', 'curation-tree.json'),
  outDir: path.join(ROOT, '.run', 'tree-apply'),
  actor: 'lead',
  unmappedDomainIds: ['D6'],              // D6 = 未归类待判定：域容器照建，成员不挂父
  unmappedDomainNames: ['未归类待判定'],
  maxFamilyMembers: 400,
});

const DB_CANDIDATES = [
  path.join(ROOT, '.run', 'retrigger', 'legacy', 'mem.db'),
  path.join(ROOT, '.run', 'rehearse', 'dbA', 'mem.db'),
  path.join(ROOT, '.run', 'rehearse', 'dbB', 'mem.db'),
];

// ---------------------------------------------------------------------------
// 树读取 / 归一化 / 校验（全部只读）
// ---------------------------------------------------------------------------
export function cleanFamilyName(key) {
  let s = String(key == null ? '' : key).trim();
  s = s.replace(/^[（(]\s*[\d一二三四五六七八九十]+\s*[）)]\s*/, '');      // "（七）发改委项目" → "发改委项目"
  s = s.replace(/^[\s\d一二三四五六七八九十]+[、.．)）:：\-—]+\s*/, '');     // "3、标书检查工具" → "标书检查工具"
  s = s.replace(/\s+/g, ' ').trim();
  return s || String(key == null ? '' : key).trim();
}

export function loadTree(file) {
  const f = file || DEFAULT_TREE_APPLY.treeFile;
  if (!fs.existsSync(f)) throw new MemError('TREE_NOT_FOUND', '树文件不存在：' + f, { file: f });
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new MemError('TREE_BAD_JSON', '树文件不是合法 JSON：' + f, { file: f, cause: String(e && e.message) }); }
  return { file: f, tree: normTree(raw) };
}

/** 合法 tier 集合（task-25：新增 line；未知 tier 必须 fail closed，不许静默当 single） */
export const KNOWN_TIERS = Object.freeze(['multi', 'series', 'single', 'line']);

/** 归一化树结构（容忍字段名差异：domainId/id、familyKey/key、tier 缺省 single） */
export function normTree(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawDomains = Array.isArray(src.domains) ? src.domains : [];
  const domains = rawDomains.map((d, i) => {
    const domainId = String((d && (d.domainId || d.id || d.key)) || 'D' + (i + 1));
    const name = String((d && (d.name || d.title)) || domainId).trim();
    const families = (Array.isArray(d && d.families) ? d.families : []).map((f, j) => {
      const familyKey = String((f && (f.familyKey || f.key || f.name || f.lineId)) || 'family-' + (j + 1));
      // 保留原始 tier：未知值原样留下，交给 validateTree 报 UNKNOWN_TIER（绝不静默降级）
      const rawTier = f && f.tier != null ? String(f.tier) : 'single';
      const membersFrom = Array.isArray(f && f.members) ? f.members : [];
      const membersFromDetails = Array.isArray(f && f.details) ? f.details : [];
      const members = [...membersFrom, ...membersFromDetails]
        .map((m) => String(typeof m === 'string' ? m : (m && (m.id || m.topicId)) || ''))
        .filter(Boolean);
      const dedup = [...new Set(members)];
      const displayName = cleanFamilyName(String((f && (f.name || f.familyKey || f.lineId)) || familyKey));
      return { familyKey, cleanName: displayName || cleanFamilyName(familyKey), displayName: displayName || familyKey, tier: rawTier, members: dedup, mode: (f && f.mode) || null, lineId: (f && f.lineId) || null };
    }).filter((f) => f.tier === 'line' || !KNOWN_TIERS.includes(f.tier) || f.members.length > 0);
    return { domainId, name, families };
  }).filter((d) => d.name);
  const sourceIds = [];
  for (const d of domains) for (const f of d.families) sourceIds.push(...f.members);
  return {
    generatedAt: src.generatedAt || null,
    counts: src.counts || null,
    domains,
    sourceIds,
    sourceIdSet: [...new Set(sourceIds)],
  };
}

/** 判断某域是否"未归类桶"（成员不挂父） */
export function isUnmappedDomain(domain, cfg = DEFAULT_TREE_APPLY) {
  return cfg.unmappedDomainIds.includes(String(domain.domainId))
    || cfg.unmappedDomainNames.some((n) => domain.name.includes(n));
}

/**
 * 校验树与库的一致性（只读，不写）：
 *   · 成员必须都在库里（缺失默认 fail closed：TREE_MISMATCH；显式 allowMissing 才放行）；
 *   · 同一成员不得同时挂在两个不同域（CROSS_DOMAIN_MEMBER）；
 *   · 同一域内重复成员去重。
 */
export function validateTree(store, tree, cfg = DEFAULT_TREE_APPLY, { allowMissing = false } = {}) {
  const missing = [];
  const memberDomains = new Map();
  const crossDomain = [];
  const unknownTiers = [];
  for (const d of tree.domains) {
    const seen = new Set();
    for (const f of d.families) {
      if (!KNOWN_TIERS.includes(f.tier)) {
        // task-25：未知 tier 立即 fail closed（在写入之前），绝不静默当 single
        unknownTiers.push({ domainId: d.domainId, familyKey: f.familyKey, tier: f.tier });
        continue;
      }
      if (f.members.length > cfg.maxFamilyMembers) throw new MemError('FAMILY_TOO_LARGE', `族 ${f.familyKey} 成员 ${f.members.length} 超过上限`, { familyKey: f.familyKey, size: f.members.length });
      for (const id of f.members) {
        if (seen.has(id)) continue;
        seen.add(id);
        const row = store.be.getTopicById(id);
        if (!row) { missing.push(id); continue; }
        if (memberDomains.has(id) && memberDomains.get(id) !== d.domainId) {
          crossDomain.push({ id, domainA: memberDomains.get(id), domainB: d.domainId, domainBName: d.name });
        } else memberDomains.set(id, d.domainId);
      }
    }
  }
  if (unknownTiers.length) {
    throw new MemError('UNKNOWN_TIER',
      `树里有 ${unknownTiers.length} 个未知 tier（只支持 ${KNOWN_TIERS.join('/')}）：${unknownTiers.slice(0, 5).map((x) => x.tier + '@' + x.domainId + '/' + x.familyKey).join(',')}`,
      { unknownTiers, allowed: KNOWN_TIERS.slice() });
  }
  if (missing.length && !allowMissing) {
    // task-26：树与库不匹配必须 fail closed（禁止静默少挂 → main 数变小的假成功）
    throw new MemError('TREE_MISMATCH',
      `树与目标库不匹配：${missing.length} 个成员不存在（前 10：${missing.slice(0, 10).join(',')}${missing.length > 10 ? ' …' : ''}）`,
      { missing: missing.slice(0, 10), total: missing.length, allMissing: missing.slice() });
  }
  if (crossDomain.length) {
    throw new MemError('CROSS_DOMAIN_MEMBER', `同一成员出现在多个域（禁止）：${crossDomain.slice(0, 5).map((x) => x.id + ':' + x.domainA + '/' + x.domainB).join(',')}`, { crossDomain });
  }
  return { ok: true, memberCount: memberDomains.size, domains: tree.domains.length, missingMembers: missing, allowMissing: !!allowMissing };
}

/** allowMissing 放行时：把缺失成员从树里剔除（空线保留），返回过滤后的树 */
export function filterTreeMissing(tree, missingIds) {
  const miss = missingIds instanceof Set ? missingIds : new Set(missingIds || []);
  if (!miss.size) return tree;
  const domains = tree.domains.map((d) => ({
    ...d,
    families: d.families
      .map((f) => ({ ...f, members: f.members.filter((id) => !miss.has(id)) }))
      .filter((f) => f.tier === 'line' || f.members.length > 0),
  }));
  const sourceIds = domains.flatMap((d) => d.families.flatMap((f) => f.members));
  return { ...tree, domains, sourceIds, sourceIdSet: [...new Set(sourceIds)] };
}

/** 未映射主题：树上"未归类桶"里的成员 + 库里完全不在树上的主题（只读） */
export function unmappedTopics(store, tree, cfg = DEFAULT_TREE_APPLY) {
  const bucket = [];
  for (const d of tree.domains) if (isUnmappedDomain(d, cfg)) for (const f of d.families) bucket.push(...f.members);
  const inTree = new Set(tree.sourceIdSet);
  const notInTree = store.be.listTopics().filter((t) => !inTree.has(t.id)).map((t) => t.id);
  return { bucket: [...new Set(bucket)], notInTree, total: new Set([...bucket, ...notInTree]).size };
}

// ---------------------------------------------------------------------------
// 内部：容器创建（域用公开 createDomain；项目线用内部插入，避免禁建区把"族名容器"当近重复拦掉）
// ---------------------------------------------------------------------------
function ensureDomain(store, name, { actor, at }) {
  // task-26：undo 会删掉容器的 level/parent meta（归档 husk）；再次 apply 时按同名 husk 复原，
  // 避免每次 undo→apply 都新建一个"（域）"后缀容器。
  const existing = store.be.getTopicByNorm(normalizeName(name));
  if (existing && existing.state === 'archived' && !store._levelMetaOf(existing.id) && !store._mergeParentOf(existing.id)) {
    store._restoreState(existing.id, 'active', { actor, at, why: 'tree-apply-revive' });
    store.setLevel(existing.id, 'domain', { actor });
    return { ok: true, id: existing.id, name: existing.name, level: 'domain', reused: true, revived: true };
  }
  let dom;
  try {
    dom = store.createDomain(name, { actor });
  } catch (e) {
    if (e instanceof MemError && e.code === 'NAME_TAKEN') dom = store.createDomain(name + '（域）', { actor });
    else throw e;
  }
  // undo 会把本次新建的域归档（不删）；再次 apply 要能恢复成 active，否则结构"建不起来"
  if (dom && dom.id) {
    const row = store.be.getTopicById(dom.id);
    if (row && row.state === 'archived') {
      store._restoreState(dom.id, 'active', { actor, at, why: 'tree-apply-revive' });
      return { ...dom, revived: true };
    }
  }
  return dom;
}

/** 项目线容器候选名：line 优先用节点 name（裸名），普通族用「族名（项目线）」 */
export function projectNameCandidates({ cleanName, familyKey, exactName = false }) {
  const bases = exactName
    ? [cleanName, cleanName + '（项目线）', cleanName + ' · 线', familyKey]
    : [cleanName + '（项目线）', familyKey + '（项目线）'];
  const cands = [];
  for (const base of bases) {
    if (!base) continue;
    cands.push(base);
    for (let n = 2; n <= 20; n += 1) cands.push(base + ' ' + n);
  }
  return [...new Set(cands)];
}

/** 只读：找可复用的项目线容器（同域、level=project、非源主题、同名）；husk（undo 归档且无 level/parent meta）也算可复用 */
export function findProjectLine(store, { familyKey, cleanName, domainId, exactName = false, sourceIdSet = new Set(), allowRename = false, renamed = null, actor = 'lead', at = 0 }) {
  for (const cand of projectNameCandidates({ cleanName, familyKey, exactName })) {
    const norm = normalizeName(cand);
    if (!norm) continue;
    const row = store.be.getTopicByNorm(norm);
    if (!row) return { cand, row: null };
    if (sourceIdSet.has(row.id)) continue;                 // 源主题不能当容器
    if (row.state === 'archived' && !store._levelMetaOf(row.id) && !store._mergeParentOf(row.id)) {
      return { cand, row, husk: true };                    // undo 清过 meta 的归档容器：可复原
    }
    if (store.levelOf(row.id) !== 'project') continue;      // 同名非项目线，跳过
    if (row.state === 'archived') {
      // 同域归档容器（undo 后的旧容器）优先复原；异域归档容器 ⇒ 让它"让位"改名，新容器用干净原名（task-37）
      if (store.parentOf(row.id) === domainId) return { cand, row };
      if (allowRename && renamed && !sourceIdSet.has(row.id)) {
        const mv = renameArchivedContainer(store, row, { actor, at });
        if (mv) { renamed.push(mv); return { cand, row: null }; }
      }
      continue;                                             // 不能改名 ⇒ 继续找下一个候选名
    }
    if (store.parentOf(row.id) !== domainId) continue;      // active 项目线必须挂在本域（真重名 ⇒ 加序号）
    return { cand, row };
  }
  return { cand: null, row: null };
}

/** 本地日期 YYYY-MM-DD（用于"已归档"改名后缀） */
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 底层改名（保留 id/内容）：sqlite 直接改 name+norm；ledger 走 updateTopic（_apply 会同步 normIndex） */
function renameTopicRaw(store, row, newName, { actor, at, reason }) {
  const from = String(row.name || row.id);
  const target = String(newName);
  if (target === from) return null;
  const norm = normalizeName(target);
  const be = store.be;
  if (be.db && typeof be.db.prepare === 'function') {
    be.db.prepare('UPDATE topics SET name=?, norm=?, updated_at=? WHERE id=?').run(target, norm, at, row.id);
  } else {
    be.updateTopic(row.id, { name: target, norm, updatedAt: at });
  }
  store._metaSet('renamed.from:' + row.id, from);
  store._audit('topic.rename', { at, topicId: row.id, actor, oldText: from, newText: target, detail: { reason } });
  return { id: row.id, from, to: target };
}

/** task-37：把已归档的同名容器改名成「原名（已归档 YYYY-MM-DD）」，把干净名字让给新容器 */
function renameArchivedContainer(store, row, { actor, at }) {
  const base = String(row.name || row.id);
  const stamp = localDateStr(at);
  let target = base + '（已归档 ' + stamp + '）';
  for (let n = 2; n <= 20 && store.be.getTopicByNorm(normalizeName(target)); n += 1) target = base + '（已归档 ' + stamp + '） ' + n;
  return renameTopicRaw(store, row, target, { actor, at, reason: 'archived-name-conflict' });
}

/**
 * task-38 后置命名收敛：归档 pass 之后再查一次——
 *   本次新建的 active 容器带序号（"X 2"），且存在 archived 同名容器 "X"
 *   ⇒ 归档方改名「X（已归档 YYYY-MM-DD）」、active 容器恢复干净名 "X"。
 * 只处理**本次 apply 新建**的 active 容器，避免误改历史命名。
 */
function convergeArchivedAfterApply(store, { actor, at, createdProjectIds, targetIds }) {
  const renamed = [];
  const baseOf = (name) => {
    const m = /^(.+) (\d+)$/.exec(String(name || ''));
    return m && Number(m[2]) >= 2 ? m[1] : null;
  };
  for (const pid of createdProjectIds) {
    const row = store.be.getTopicById(pid);
    if (!row || row.state !== 'active') continue;
    const base = baseOf(row.name);
    if (!base) continue;
    const arch = store.be.getTopicByNorm(normalizeName(base));
    if (!arch || arch.state !== 'archived' || arch.id === pid) continue;
    if (targetIds.has(arch.id)) continue;
    const lv = store.levelOf(arch.id);
    if (lv !== 'project' && lv !== 'domain') continue;      // 只让容器让位，不碰源主题
    const mvA = renameArchivedContainer(store, arch, { actor, at });
    if (!mvA) continue;
    const mvB = renameTopicRaw(store, row, base, { actor, at, reason: 'post-archive-converge' });
    renamed.push(mvA);
    if (mvB) renamed.push(mvB);
  }
  return renamed;
}

function ensureProjectLine(store, { familyKey, cleanName, domainId, actor, at, sourceIdSet, exactName = false, allowRename = false, renamed = null }) {
  const found = findProjectLine(store, { familyKey, cleanName, domainId, exactName, sourceIdSet, allowRename, renamed, actor, at });
  if (found.row) {
    const row = found.row;
    if (found.husk) {                                            // 归档 husk：复原 active + 补回 level/parent
      store._restoreState(row.id, 'active', { actor, at, why: 'tree-apply-revive' });
      store.setLevel(row.id, 'project', { actor });
      store.linkParent(row.id, domainId, { actor });
      return { id: row.id, name: row.name, created: false, revived: true };
    }
    if (row.state === 'archived') {                              // undo 归档过的容器：恢复 active 供再次 apply
      store._restoreState(row.id, 'active', { actor, at, why: 'tree-apply-revive' });
      return { id: row.id, name: row.name, created: false, revived: true };
    }
    return { id: row.id, name: row.name, created: false };
  }
  const cand = found.cand || (exactName ? cleanName : cleanName + '（项目线）');
  const norm = normalizeName(cand);
  const id = store.be.nextTopicId();
  store._insertTopic({ id, name: cand, norm, aliases: [], triggers: [], state: 'active', createdAt: at, updatedAt: at, stateSince: at });
  store._metaSet('level:' + id, 'project');
  store._audit('topic.tree.container', { at, topicId: id, actor, newText: cand, detail: { kind: 'project', domainId, familyKey, exactName } });
  store.linkParent(id, domainId, { actor });   // 项目线必须挂域（否则 verify 报 PROJECT_WITHOUT_PARENT）
  return { id, name: cand, created: true };
}

/** 把主题挂到容器下 + 改层级/状态；记录 before 供 undo。allowCrossDomain 时允许"结构重组"式跨域移动。 */
function attachTopic(store, { topicId, containerId, kind, setDormant, actor, at, allowCrossDomain = false, moved = null }) {
  const row = store.be.getTopicById(topicId);
  if (!row) throw new MemError('MEMBER_NOT_FOUND', '成员不存在：' + topicId, { topicId });
  const beforeParent = store._mergeParentOf(topicId) || null;
  const beforeLevel = store._levelMetaOf(topicId);
  const beforeState = row.state;
  const tgtRoot = store._rootOf(containerId);
  const curRoot = store._rootOf(topicId);
  const cross = !!(beforeParent && curRoot && tgtRoot && curRoot !== tgtRoot);
  if (cross && !allowCrossDomain) {
    // task-36：默认仍拒绝（该域事务回滚 ⇒ 零部分写入；CLI 非零退出由 applyTree.ok=false 驱动）
    throw new MemError('CROSS_DOMAIN_MEMBER', `成员 ${topicId} 已属于域根 ${curRoot}，不能再挂到 ${tgtRoot}（如需结构重组请加 --allow-cross-domain）`, { topicId, containerId, curRoot, tgtRoot });
  }
  let changed = 0;
  if (cross && allowCrossDomain) {
    // 跨域移动：绕过 linkParent 的跨域保护，直接改 parent meta（仍审计、仍可 undo）
    if (beforeLevel !== 'detail') { store.setLevel(topicId, 'detail', { actor }); changed += 1; }
    store._metaSet('parent:' + topicId, containerId);
    changed += 1;
    if (setDormant && row.state !== 'dormant') { store.setState(topicId, 'dormant', { actor, reason: 'tree-apply' }); changed += 1; }
    store._audit('topic.tree.move', {
      at, topicId, actor, oldText: beforeParent, newText: containerId,
      detail: { kind: 'cross-domain-move', fromRoot: curRoot, toRoot: tgtRoot, fromParent: beforeParent, toParent: containerId },
    });
    if (moved) moved.push({ id: topicId, from: curRoot, to: tgtRoot, fromParent: beforeParent, toParent: containerId, kind });
    return {
      id: topicId, kind, containerId,
      prevParent: beforeParent, prevLevel: beforeLevel, prevState: beforeState,
      changed, crossDomain: true, fromRoot: curRoot, toRoot: tgtRoot,
    };
  }
  if (beforeLevel !== 'detail') { store.setLevel(topicId, 'detail', { actor }); changed += 1; }
  if (beforeParent !== containerId) { store.linkParent(topicId, containerId, { actor }); changed += 1; }
  if (setDormant && row.state !== 'dormant') { store.setState(topicId, 'dormant', { actor, reason: 'tree-apply' }); changed += 1; }
  return {
    id: topicId, kind, containerId,
    prevParent: beforeParent, prevLevel: beforeLevel, prevState: beforeState,
    changed,
  };
}

/**
 * 跨域移动后：把已无子节点的旧容器归档（不删；打 abandonedContainer 标记）。
 * 从被搬空的旧 parent 开始，向上冒泡（父容器也空了就继续归档），但绝不归档本次树里的目标容器。
 */
function archiveEmptiedContainers(store, candidateParents, { actor, at, targetIds = new Set() }) {
  const archived = [];
  const seen = new Set();
  const queue = [...candidateParents];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = store.be.getTopicById(id);
    if (!row || row.state === 'archived') continue;
    if (targetIds.has(id)) continue;                       // 本次树的目标容器不动
    const lv = store.levelOf(id);
    if (lv !== 'project' && lv !== 'domain') continue;      // 只归档容器，不碰源主题
    const hasChild = store.be.listTopics().some((t) => t.state !== 'archived' && store._mergeParentOf(t.id) === id);
    if (hasChild) continue;
    store._metaSet('abandoned:' + id, 'true');             // 打标记（不删）
    store.setState(id, 'archived', { actor, reason: 'tree-apply-cross-domain-move' });
    store._audit('topic.tree.abandon', { at, topicId: id, actor, detail: { abandonedContainer: true, reason: 'cross-domain-move-emptied' } });
    archived.push(id);
    const p = store._mergeParentOf(id);
    if (p && !seen.has(p)) queue.push(p);
  }
  return archived;
}

// ---------------------------------------------------------------------------
// dry-run 计划（只读）
// ---------------------------------------------------------------------------
export function planTree(store, tree, cfg = DEFAULT_TREE_APPLY, { allowMissing = false, allowCrossDomain = false } = {}) {
  const v = validateTree(store, tree, cfg, { allowMissing });
  const work = (allowMissing && v.missingMembers.length) ? filterTreeMissing(tree, v.missingMembers) : tree;
  const unmapped = unmappedTopics(store, work, cfg);
  const rows = [];
  let domainsToCreate = 0; let projectsToCreate = 0; let membersToAttach = 0; let statesToChange = 0; let singlesToAttach = 0; let movesPlanned = 0;
  for (const d of work.domains) {
    const existingDomain = store.be.getTopicByNorm(normalizeName(d.name));
    const domainExists = !!(existingDomain && store.levelOf(existingDomain) === 'domain');
    if (!domainExists) domainsToCreate += 1;
    const domainPlan = { domainId: d.domainId, name: d.name, exists: domainExists, create: !domainExists, projects: [], unmappedBucket: isUnmappedDomain(d, cfg) };
    const targetRootId = domainExists ? existingDomain.id : null;
    const countMove = (mid) => {
      const p = store._mergeParentOf(mid);
      if (!p) return 0;
      const curRoot = store._rootOf(mid);
      if (!curRoot) return 0;
      if (targetRootId ? curRoot !== targetRootId : true) movesPlanned += 1;
      return 0;
    };
    for (const f of d.families) {
      if (domainPlan.unmappedBucket) { domainPlan.projects.push({ familyKey: f.familyKey, skipped: 'unmapped-bucket', members: f.members.length }); continue; }
      if (f.tier === 'single') {
        singlesToAttach += f.members.length;
        membersToAttach += f.members.length;
        for (const mid of f.members) countMove(mid);
        // 单主题族只挂域、不改状态（dormant 只用于多成员/系列族），故不计入 statesToChange
        domainPlan.projects.push({ familyKey: f.familyKey, tier: f.tier, single: true, members: f.members.length });
        continue;
      }
      // multi / series / line：项目线 + 成员 dormant（line 允许 0 成员：空队列也要建容器）
      const isLine = f.tier === 'line';
      const probeBase = isLine ? (f.displayName || f.cleanName || f.familyKey) : (f.cleanName || f.familyKey);
      const found = findProjectLine(store, { familyKey: f.familyKey, cleanName: probeBase, domainId: d.domainId, exactName: isLine, sourceIdSet: new Set(tree.sourceIdSet) });
      const reusable = !!found.row;
      if (!reusable) projectsToCreate += 1;
      membersToAttach += f.members.length;
      for (const mid of f.members) {
        countMove(mid);
        const row = store.be.getTopicById(mid);
        if (!row) continue;
        if (row.state !== 'dormant') statesToChange += 1;
      }
      domainPlan.projects.push({ familyKey: f.familyKey, tier: f.tier, line: isLine, projectName: found.cand || found.row && found.row.name, projectExists: reusable, members: f.members.length });
    }
    rows.push(domainPlan);
  }
  return {
    mode: 'dry-run',
    treeDomains: tree.domains.length,
    domainsToCreate, projectsToCreate,
    membersToAttach, singlesToAttach, statesToChange,
    missingMembers: v.missingMembers.slice(),
    allowMissing: !!allowMissing,
    allowCrossDomain: !!allowCrossDomain,
    movesPlanned,
    unmapped: unmapped,
    domains: rows,
    countsNow: store.topicCounts(),
  };
}

// ---------------------------------------------------------------------------
// apply（每域一个事务；失败整域回滚、其余域继续）
// ---------------------------------------------------------------------------
function shaDigestOf(store) {
  const lines = [];
  for (const t of store.be.listTopics()) for (const s of (store.be.listSentences(t.id) || [])) lines.push(t.id + ':' + s.sha);
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
export function treeSignature(tree) {
  const parts = tree.domains.map((d) => d.domainId + '|' + d.name + '|' + d.families.map((f) => f.familyKey + ':' + f.tier + ':' + f.members.join(',')).join(';'));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

export function applyTree(store, tree, cfg = DEFAULT_TREE_APPLY, { actor = cfg.actor, treeFile = null, allowMissing = false, allowCrossDomain = false } = {}) {
  const v = validateTree(store, tree, cfg, { allowMissing });
  const missingMembers = v.missingMembers.slice();
  const work = (allowMissing && missingMembers.length) ? filterTreeMissing(tree, missingMembers) : tree;
  const sig = treeSignature(work);
  const priorId = store._metaGet('tree.apply.bySig:' + sig);
  if (priorId) {
    const prior = store._jsonMeta('tree.apply.record:' + priorId, null);
    if (prior && !prior.undoneAt) {
      const nowCounts = store.topicCounts();
      return {
        ok: true, changed: 0, reused: true, applyId: priorId, sig,
        countsBefore: prior.countsBefore || nowCounts,
        countsAfter: prior.countsAfter || nowCounts,
        domains: prior.domains.length, projects: prior.projects.length,
        detailsAttached: prior.detailsAttached, singlesAttached: prior.singlesAttached, statesChanged: prior.statesChanged,
        unmapped: prior.unmapped,
        missingMembers: prior.missingMembers || missingMembers,
        movedAcrossDomains: [], archivedContainers: [], renamedArchived: [], renamedAfterArchive: [],   // 幂等复用：不重复移动/归档/改名
        sentencesConserved: prior.sentencesBefore === (prior.sentencesAfter == null ? nowCounts.sentences : prior.sentencesAfter),
        shaConserved: !prior.shaDigestBefore || prior.shaDigestBefore === prior.shaDigestAfter,
        verifyOk: store.verify().ok,
        perDomain: prior.perDomain || [],
      };
    }
  }
  const at = store.nowMs();
  const applyId = 'TA-' + at.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const unmapped = unmappedTopics(store, work, cfg);
  const sourceIdSet = new Set(work.sourceIdSet);
  const before = store.topicCounts();
  const shaBefore = shaDigestOf(store);
  const record = {
    applyId, at, actor, sig, treeFile: treeFile || null,
    missingMembers: missingMembers.slice(), allowMissing: !!allowMissing, allowCrossDomain: !!allowCrossDomain,
    domains: [], projects: [], changes: [], perDomain: [],
    movedAcrossDomains: [], archivedContainers: [], renamedArchived: [], renamedAfterArchive: [],
    unmapped: [...new Set([...unmapped.bucket, ...unmapped.notInTree])],
    sentencesBefore: before.sentences, shaDigestBefore: shaBefore,
    countsBefore: before,
  };
  let detailsAttached = 0; let singlesAttached = 0; let statesChanged = 0;
  for (const d of work.domains) {
    const domainChanges = []; const domainProjects = []; const domainDomains = []; const domainMoved = []; const domainArchived = []; const domainRenamed = [];
    let domainDetails = 0; let domainSingles = 0; let domainStates = 0;
    try {
      store.runInTransaction(() => {
        const dom = ensureDomain(store, d.name, { actor, at });
        domainDomains.push({ id: dom.id, name: d.name, created: !!dom.reused ? false : true, reused: !!dom.reused, applyId });
        if (isUnmappedDomain(d, cfg)) {
          domainChanges.push({ id: dom.id, kind: 'domain-only' });
          return;
        }
        for (const f of d.families) {
          if (f.tier === 'single') {
            for (const mid of f.members) {
              const ch = attachTopic(store, { topicId: mid, containerId: dom.id, kind: 'single', setDormant: false, actor, at, allowCrossDomain, moved: domainMoved });
              domainChanges.push(ch); if (ch.changed) domainSingles += 1;
            }
            continue;
          }
          const isLine = f.tier === 'line';
          const pl = ensureProjectLine(store, {
            familyKey: f.familyKey,
            cleanName: isLine ? (f.displayName || f.cleanName || f.familyKey) : (f.cleanName || f.familyKey),
            domainId: dom.id, actor, at, sourceIdSet, exactName: isLine,
            allowRename: true, renamed: domainRenamed,
          });
          domainProjects.push({ id: pl.id, name: pl.name, created: pl.created, familyKey: f.familyKey, tier: f.tier, domainId: dom.id });
          for (const mid of f.members) {
            const ch = attachTopic(store, { topicId: mid, containerId: pl.id, kind: 'project-member', setDormant: true, actor, at, allowCrossDomain, moved: domainMoved });
            domainChanges.push(ch); if (ch.changed) domainDetails += 1;
            if (ch.changed && ch.prevState !== 'dormant') domainStates += 1;
          }
        }
        // 跨域移动后：把被搬空（无子节点）的旧容器归档（不删、打标记），向上冒泡
        if (domainMoved.length) {
          const targetIds = new Set([...domainDomains.map((x) => x.id), ...domainProjects.map((x) => x.id)]);
          domainArchived.push(...archiveEmptiedContainers(store, domainMoved.map((m) => m.fromParent), { actor, at, targetIds }));
        }
      });
      detailsAttached += domainDetails; singlesAttached += domainSingles; statesChanged += domainStates;
      record.domains.push(...domainDomains);
      record.projects.push(...domainProjects);
      record.changes.push(...domainChanges);
      record.movedAcrossDomains.push(...domainMoved);
      record.archivedContainers.push(...domainArchived);
      record.renamedArchived.push(...domainRenamed);
      record.perDomain.push({ domainId: d.domainId, name: d.name, ok: true, details: domainDetails, singles: domainSingles, states: domainStates, projects: domainProjects, moved: domainMoved.length, archived: domainArchived.length, renamed: domainRenamed.length });
    } catch (e) {
      record.perDomain.push({ domainId: d.domainId, name: d.name, ok: false, code: e instanceof MemError ? e.code : 'ERROR', message: String(e && e.message) });
    }
  }
  // task-38 后置命名收敛：创建新线时旧容器还在 active ⇒ 新线带序号；旧容器归档后把干净名还给它
  if (record.projects.some((p) => p.created)) {
    try {
      const targetIds = new Set([...record.domains.map((x) => x.id), ...record.projects.map((x) => x.id)]);
      store.runInTransaction(() => {
        record.renamedAfterArchive = convergeArchivedAfterApply(store, {
          actor, at,
          createdProjectIds: record.projects.filter((p) => p.created).map((p) => p.id),
          targetIds,
        });
      });
    } catch (e) {
      record.convergeError = String(e && e.message);
      record.perDomain.push({ domainId: '__post__', name: 'post-archive-converge', ok: false, code: 'CONVERGE_ERROR', message: record.convergeError });
    }
  }
  const after = store.topicCounts();
  record.detailsAttached = detailsAttached;
  record.singlesAttached = singlesAttached;
  record.statesChanged = statesChanged;
  record.countsAfter = after;
  record.sentencesAfter = after.sentences;
  record.shaDigestAfter = shaDigestOf(store);
  record.verifyOk = store.verify().ok;
  const okAll = record.perDomain.every((x) => x.ok);
  record.ok = okAll;
  if (okAll) {
    store._setJsonMeta('tree.apply.record:' + applyId, record);
    store._metaSet('tree.apply.bySig:' + sig, applyId);
    const idx = store._jsonMeta('tree.apply.index', []); idx.push(applyId); store._setJsonMeta('tree.apply.index', idx);
    store._metaSet('tree.apply.last', applyId);
    store._audit('tree.apply', { at, actor, newText: applyId, detail: { applyId, sig, treeFile: treeFile || null, domains: record.domains.length, projects: record.projects.length, detailsAttached, singlesAttached, statesChanged, unmapped: record.unmapped.length, allowCrossDomain: record.allowCrossDomain, moved: record.movedAcrossDomains.length, archivedContainers: record.archivedContainers.length } });
  }
  return {
    ok: okAll, changed: detailsAttached + singlesAttached + statesChanged + record.domains.filter((x) => x.created).length + record.projects.filter((x) => x.created).length,
    reused: false, applyId, sig,
    domains: record.domains.length, projects: record.projects.length,
    detailsAttached, singlesAttached, statesChanged,
    missingMembers: record.missingMembers, allowMissing: record.allowMissing, allowCrossDomain: record.allowCrossDomain,
    movedAcrossDomains: record.movedAcrossDomains,
    archivedContainers: record.archivedContainers,
    renamedArchived: record.renamedArchived,
    renamedAfterArchive: record.renamedAfterArchive || [],
    unmapped: record.unmapped,
    countsBefore: before, countsAfter: after,
    sentencesConserved: before.sentences === after.sentences,
    shaConserved: shaBefore === record.shaDigestAfter,
    verifyOk: record.verifyOk,
    perDomain: record.perDomain,
  };
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------
export function undoTree(store, { applyId = null, actor = DEFAULT_TREE_APPLY.actor } = {}) {
  const ids = store._jsonMeta('tree.apply.index', []);
  const id = applyId || store._metaGet('tree.apply.last') || ids[ids.length - 1];
  if (!id) throw new MemError('NOT_FOUND', '没有可 undo 的树落库记录');
  const rec = store._jsonMeta('tree.apply.record:' + id, null);
  if (!rec) throw new MemError('NOT_FOUND', '树落库记录不存在：' + id, { applyId: id });
  if (rec.undoneAt) return { ok: true, changed: 0, alreadyUndone: true, applyId: id, undoneAt: rec.undoneAt };
  const at = store.nowMs();
  const restored = [];
  const archivedContainers = [];
  store.runInTransaction(() => {
    // 1) 反向恢复：父指针 / 层级 / 状态
    for (const c of [...rec.changes].reverse()) {
      const row = store.be.getTopicById(c.id);
      if (!row) continue;
      const curParent = store._mergeParentOf(c.id) || null;
      if (curParent === c.containerId) {
        if (c.prevParent) store._metaSet('parent:' + c.id, c.prevParent); else store._metaDelete('parent:' + c.id);
      }
      const curLevel = store._levelMetaOf(c.id);
      if (curLevel === 'detail') {
        if (c.prevLevel) store._metaSet('level:' + c.id, c.prevLevel); else store._metaDelete('level:' + c.id);
      }
      if (c.kind === 'project-member' && row.state === 'dormant' && c.prevState && c.prevState !== 'dormant') {
        try { store.setState(c.id, c.prevState, { actor, reason: 'tree-apply-undo' }); } catch (e) { store._restoreState(c.id, c.prevState, { actor, at, why: 'tree-apply-undo' }); }
        restored.push({ id: c.id, state: c.prevState });
      }
    }
    // 2) 归档本次新建容器（不删），并清掉本次写入的 level/parent meta（task-26：undo 后 meta 指纹回到 apply 前）
    for (const p of [...rec.projects].reverse()) {
      if (!p.created) continue;
      const row = store.be.getTopicById(p.id);
      if (row && row.state !== 'archived') { store.setState(p.id, 'archived', { actor, reason: 'tree-apply-undo' }); archivedContainers.push(p.id); }
      store._metaDelete('level:' + p.id);
      store._metaDelete('parent:' + p.id);
    }
    for (const d of [...rec.domains].reverse()) {
      if (!d.created) continue;
      const row = store.be.getTopicById(d.id);
      if (row && row.state !== 'archived') { store.setState(d.id, 'archived', { actor, reason: 'tree-apply-undo' }); archivedContainers.push(d.id); }
      store._metaDelete('level:' + d.id);
      store._metaDelete('parent:' + d.id);
    }
    // 3) 跨域移动时被搬空归档的旧容器：undo 恢复 active 并清 abandoned 标记
    for (const cid of (rec.archivedContainers || [])) {
      const row = store.be.getTopicById(cid);
      if (row && row.state === 'archived') store._restoreState(cid, 'active', { actor, at, why: 'tree-apply-undo-cross-domain' });
      store._metaDelete('abandoned:' + cid);
    }
    const rec2 = { ...rec, undoneAt: at, undoneBy: actor, shaDigestAtUndo: shaDigestOf(store) };
    store._setJsonMeta('tree.apply.record:' + id, rec2);
    store._audit('tree.apply.undo', { at, actor, newText: id, detail: { applyId: id, restored: restored.length, archivedContainers: archivedContainers.length } });
  });
  const counts = store.topicCounts();
  const rec2 = store._jsonMeta('tree.apply.record:' + id, null);
  return {
    ok: true, changed: restored.length + archivedContainers.length, applyId: id,
    restored, archivedContainers,
    shaDigestBefore: rec.shaDigestBefore, shaDigestAfter: rec2 ? rec2.shaDigestAtUndo : null,
    shaConserved: !!(rec2 && rec2.shaDigestAtUndo === rec.shaDigestBefore),
    sentencesNow: counts.sentences, sentencesBefore: rec.sentencesBefore,
    counts, verifyOk: store.verify().ok,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/**
 * 参数解析：同时支持 `--k=v` 与 `--k v` 两种写法（P0 修复：原实现只认 `=`，
 * 空格形式会让 db 静默回落默认库 → 写错库）。布尔开关（--apply/--undo/--json/--help）不受影响。
 * 规则：`--k v` 的 v 若以 `--` 开头视为缺失（返回默认值）。
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
    db: get('db'), tree: get('tree'), out: get('out'), applyId: get('apply-id'),
    apply: has('apply'), undo: has('undo'), json: has('json'),
    allowMissing: has('allow-missing'),
    allowCrossDomain: has('allow-cross-domain'),
    help: has('help') || args.includes('-h'),   // task-26：-h 等同 --help（且不落 dry-run/不回落默认库）
  };
}
function defaultDb() { for (const f of DB_CANDIDATES) if (fs.existsSync(f)) return f; return ''; }
async function openStore(dbFile) {
  const isSqlite = /\.(db|sqlite|db3)$/i.test(dbFile);
  if (isSqlite) { const m = await import('./backend-sqlite.mjs'); const be = new m.SqliteBackend(dbFile); return { store: new MemoryStore(be), be }; }
  const m = await import('./backend-ledger.mjs'); const be = new m.LedgerBackend(dbFile); return { store: new MemoryStore(be), be };
}

function printPlan(p) {
  console.log('=== tree dry-run（只读，不写库）===');
  console.log(`域 ${p.treeDomains} 个：将建 ${p.domainsToCreate} / 项目线将建 ${p.projectsToCreate}`);
  console.log(`明细挂载 ${p.membersToAttach}（单主题族 ${p.singlesToAttach}）/ 状态改 dormant ${p.statesToChange}`);
  for (const d of p.domains) {
    console.log(`  [${d.domainId}] ${d.name}${d.create ? '（新建域）' : '（复用域）'}${d.unmappedBucket ? '（未归类桶：成员不挂父）' : ''}`);
    for (const pr of d.projects) console.log('     - ' + (pr.skipped ? `${pr.familyKey}：跳过（${pr.skipped}，${pr.members} 成员）` : pr.single ? `${pr.familyKey}：单主题挂域（${pr.members}）` : `${pr.projectName}：项目线${pr.projectExists ? '（复用）' : '（新建）'} + 成员 ${pr.members}`));
  }
  console.log(`未映射主题 ${p.unmapped.total} 个（桶 ${p.unmapped.bucket.length} + 树外 ${p.unmapped.notInTree.length}），不挂父。`);
  if (p.movesPlanned) console.log(`跨域移动计划 ${p.movesPlanned} 个（默认会被拒绝；如需结构重组加 --allow-cross-domain）`);
  if (p.missingMembers && p.missingMembers.length) console.log(`⚠️ 树中有 ${p.missingMembers.length} 个成员在目标库不存在（allow-missing 放行）：${p.missingMembers.slice(0, 10).join(',')}${p.missingMembers.length > 10 ? ' …' : ''}`);
  console.log(`当前：主主题 ${p.countsNow.main.total}（域 ${p.countsNow.main.domains} + 项目线 ${p.countsNow.main.projects}）/ 明细 ${p.countsNow.details} / 句 ${p.countsNow.sentences}`);
}

function printApply(r) {
  console.log('=== tree apply 结果 ===');
  console.log(`applyId=${r.applyId}${r.reused ? '（幂等复用，0 变更）' : ''}｜域 ${r.domains} / 项目线 ${r.projects} / 明细挂载 ${r.detailsAttached} / 单主题挂域 ${r.singlesAttached} / 状态改 dormant ${r.statesChanged}`);
  console.log(`未映射（不挂父）${r.unmapped.length} 个：${r.unmapped.slice(0, 10).join(',')}${r.unmapped.length > 10 ? ' …' : ''}`);
  if (r.missingMembers && r.missingMembers.length) console.log(`⚠️ 缺员放行 ${r.missingMembers.length} 个（目标库不存在）：${r.missingMembers.slice(0, 10).join(',')}${r.missingMembers.length > 10 ? ' …' : ''}`);
  if (r.movedAcrossDomains && r.movedAcrossDomains.length) console.log(`跨域移动 ${r.movedAcrossDomains.length} 个（示例前 5）：${r.movedAcrossDomains.slice(0, 5).map((m) => m.id + ':' + m.from + '→' + m.to).join('，')}`);
  if (r.archivedContainers && r.archivedContainers.length) console.log(`旧容器自动归档 ${r.archivedContainers.length} 个（不删，abandonedContainer 标记）：${r.archivedContainers.slice(0, 10).join(',')}`);
  if (r.renamedArchived && r.renamedArchived.length) console.log(`已归档同名容器改名 ${r.renamedArchived.length} 个（让出干净名字）：${r.renamedArchived.slice(0, 5).map((x) => x.id + ':' + x.from + '→' + x.to).join('，')}`);
  if (r.renamedAfterArchive && r.renamedAfterArchive.length) console.log(`归档后同名收敛 ${r.renamedAfterArchive.length} 条（归档方加后缀 / 新容器去序号）：${r.renamedAfterArchive.slice(0, 5).map((x) => x.id + ':' + x.from + '→' + x.to).join('，')}`);
  console.log(`主主题 ${r.countsAfter.main.total}（域 ${r.countsAfter.main.domains} + 项目线 ${r.countsAfter.main.projects}）/ 明细 ${r.countsAfter.details} / 归档 ${r.countsAfter.archived}`);
  console.log(`守恒：句 ${r.countsBefore.sentences} → ${r.countsAfter.sentences} ${r.sentencesConserved ? '✅' : '❌'} ｜ sha 摘要 ${r.shaConserved ? '✅ 一致' : '❌ 变化'} ｜ verify ${r.verifyOk ? 'OK' : 'FAIL'}`);
  for (const d of r.perDomain) if (!d.ok) console.log(`  ❌ ${d.domainId} ${d.code} ${d.message}`);
}

export async function runCli(argv) {
  const a = parseArgs(argv);
  // task-26：--help/-h 优先识别——只打用法并 exit 0，不解析路径、不回落默认库、不开库
  if (a.help) {
    console.log('用法：node src/tree-apply.mjs --db <copy.db> --tree <tree.json> [--apply|--undo] [--allow-missing] [--allow-cross-domain] [--out <dir>] [--json]');
    console.log('  --db/--tree 支持 --k=v 与 --k v 两种写法；默认 dry-run（只读）；--apply 才落库；默认拒绝 ~/.dsh/** 目标。');
    console.log('  --allow-missing：树里有目标库不存在的成员时放行（默认 fail closed：TREE_MISMATCH）。');
    console.log('  --allow-cross-domain：允许结构重组式跨域移动（默认拒绝 CROSS_DOMAIN_MEMBER，退出码 2）。');
    return { ok: true, mode: 'help' };
  }
  const treeFile = a.tree || DEFAULT_TREE_APPLY.treeFile;
  const outDir = a.out || DEFAULT_TREE_APPLY.outDir;
  const mode = a.undo ? 'undo' : a.apply ? 'apply' : 'dry-run';
  const fallback = !a.db;
  const rawDb = a.db || defaultDb();
  // 启动第一行起必须打印解析结果（空跑也打）—— 2026-10-29 P0：空格形式 --db 被吞导致写错库，靠这行才能一眼发现
  console.log('目标库：' + (rawDb ? path.resolve(rawDb) : '(无：未指定 --db 且未找到默认副本)'));
  console.log('树文件：' + path.resolve(treeFile));
  console.log('模式：' + mode + (a.allowMissing ? '（allow-missing：缺员放行）' : '') + (a.allowCrossDomain ? '（allow-cross-domain：允许结构重组）' : ''));
  if (fallback) console.log('⚠️ 未指定 --db，使用默认库 ' + (rawDb || '(无)'));
  if (!rawDb) throw new MemError('DB_REQUIRED', '未指定 --db 且没有可用默认副本');
  const db = assertSafeDb(rawDb);
  const { tree } = loadTree(treeFile);
  const { store, be } = await openStore(db);
  try {
    if (a.undo) {
      const r = undoTree(store, { applyId: a.applyId || null });
      fs.mkdirSync(outDir, { recursive: true });
      const f = path.join(outDir, 'tree-undo-report.json');
      fs.writeFileSync(f, JSON.stringify({ at: Date.now(), db, treeFile, ...r }, null, 2), 'utf8');
      if (a.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log('=== tree undo 结果 ===');
        console.log(`applyId=${r.applyId} 恢复状态 ${r.restored.length} / 归档容器 ${r.archivedContainers.length}`);
        console.log(`句 ${r.sentencesBefore} → ${r.sentencesNow}｜sha 摘要 ${r.shaConserved ? '✅ 与 apply 前一致' : '❌ 不一致'}｜verify ${r.verifyOk ? 'OK' : 'FAIL'}`);
        console.log(`主主题 ${r.counts.main.total}（域 ${r.counts.main.domains} + 项目线 ${r.counts.main.projects}）/ 明细 ${r.counts.details}`);
        console.log('报告：' + f);
      }
      return r;
    }
    if (!a.apply) {
      const p = planTree(store, tree, DEFAULT_TREE_APPLY, { allowMissing: a.allowMissing, allowCrossDomain: a.allowCrossDomain });
      if (a.json) console.log(JSON.stringify(p, null, 2)); else printPlan(p);
      return p;
    }
    const r = applyTree(store, tree, DEFAULT_TREE_APPLY, { actor: DEFAULT_TREE_APPLY.actor, treeFile, allowMissing: a.allowMissing, allowCrossDomain: a.allowCrossDomain });
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, 'tree-apply-report.json');
    fs.writeFileSync(f, JSON.stringify({ at: Date.now(), db, treeFile, ...r }, null, 2), 'utf8');
    if (a.json) console.log(JSON.stringify(r, null, 2)); else { printApply(r); console.log('报告：' + f); }
    if (!r.ok) {
      // task-36：消除"整域零改动 + 退出码 0"的静默失败
      const failed = r.perDomain.filter((x) => !x.ok);
      console.log(`\nFAIL  ${failed.length} 个域失败（退出码 2）：${failed.map((x) => x.domainId + ':' + x.code).join(', ')}`);
      if (failed.some((x) => x.code === 'CROSS_DOMAIN_MEMBER')) console.log('提示：如需结构重组（把成员从旧域迁到新域）请加 --allow-cross-domain。');
      process.exitCode = 2;
    }
    return r;
  } finally { try { be.close(); } catch (e) { /* noop */ } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error('FAIL  ' + (e instanceof MemError ? e.code : 'ERROR') + '  ' + (e && e.message));
    process.exitCode = 2;
  });
}
