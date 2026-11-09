// 主题治理层（阶段 2）：归一化 / 名字相似度分档 / 权限矩阵 / trigger 冲突
//
// 设计原则（为什么把治理做成"纯函数层"）：
//   1) 本模块零副作用、零后端依赖、不写审计、不抛 MemError —— 它只回答"该不该建 / 谁有权限"。
//      写审计与抛错留在 memory-store.mjs（那里才知道 topicId 与事务边界）。
//   2) 依赖方向单向：governance.mjs ← lifecycle.mjs ← memory-store.mjs，无循环 import。
//   3) 阈值全部来自 DEFAULT_GOVERNANCE（可被 store.configureGovernance() 覆盖），改配置立即生效。
//
// 契约来源：alignment.md 决策 10（显式 triggers）/13（生命周期）/14（阈值分档）/17（权限按身份判定）
//          task.md 技术决策 4/5/7/9；verification.md B 组 + D 组。

// ---------------------------------------------------------------------------
// 1. 归一化 / 相似度
// ---------------------------------------------------------------------------

// 与阶段 1 完全一致（NFKC + 小写 + 去分隔符与空白）—— 不能改，否则已有别名/精确解析会漂移。
export function normalizeName(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/[\s_\-·・,，.。:：/\\()（）\[\]【】]/g, '');
}

// trigger 与 theme 名共用同一套归一化（决策 10：重合按归一化后比较）
export function normalizeTrigger(s) { return normalizeName(s); }

export function levenshtein(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
  if (A === B) return 0;
  const m = A.length, n = B.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 名字相似度（输入必须是已归一化的串）。
 * sim = 1 - 编辑距离/较长者长度；contains = 任一方包含另一方（决策 14 把"包含关系"直接视为禁建）。
 */
export function nameSimilarity(aNorm, bNorm) {
  const a = String(aNorm == null ? '' : aNorm);
  const b = String(bNorm == null ? '' : bNorm);
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  const sim = 1 - dist / maxLen;
  const contains = a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
  return { dist, sim: Number(sim.toFixed(4)), contains, maxLen };
}

// ---------------------------------------------------------------------------
// 2. 阈值分档（决策 14）
// ---------------------------------------------------------------------------

export const DEFAULT_GOVERNANCE = Object.freeze({
  forbiddenSim: 0.90,          // ≥ 0.90 ⇒ 禁建区
  graySim: 0.70,               // 0.70–0.90 ⇒ 灰区（只可建 draft + 二次确认）
  forbiddenEditDistance: 2,    // 归一化后编辑距离 ≤2 ⇒ 禁建区
  forbiddenTriggerOverlap: 2,  // triggers 归一化后重合 ≥2 ⇒ 禁建区（即使名字不像）
  // [2026-10-29 P0 修复·泛化 trigger] 区分度阈值（数据驱动，不靠停用词表）：
  //   某 trigger 覆盖的**主题数 > 本阈值** ⇒ 判 generic：不参与"禁建区重合计数"、不参与检索加权/冲突并列，
  //   但**保留存储**（只增不删的既有契约不变），并可通过 store.genericTriggers() / topics() 看到。
  //   默认 5：正是本次缺陷的根因边界（2026→181、徕卡一瞬→98、MB→34、原文一字未删→30、OA→23、发改委项目→23）。
  //   ⚠️ 与迁移器(task-9)的"覆盖文件数"口径对齐，默认值同为 5（他按文件数、我按主题数，阈值一致）。
  genericTriggerMaxTopics: 5,
});

const FORBIDDEN_REASON_TEXT = {
  'edit-distance': '归一化后编辑距离 ≤2',
  'similarity': '名字相似度 ≥0.90',
  'contains': '名字存在包含关系',
  'trigger-overlap': 'triggers 重合 ≥2',
};

function bestOf(list) {
  let best = null;
  for (const x of list) if (!best || x.sim > best.sim) best = x;
  return best;
}

function triggersOf(topic) {
  const raw = topic && Array.isArray(topic.triggers) ? topic.triggers : [];
  return raw.map((x) => (typeof x === 'string' ? x : (x && x.trigger) || '')).filter(Boolean);
}

function normSet(list) {
  const s = new Set();
  for (const x of list) {
    const n = normalizeTrigger(x);
    if (n) s.add(n);
  }
  return s;
}

/** 候选主题的 triggers 与既有主题的 triggers 重合情况（按归一化，去重）
 *  opts.ignoreNorms：要忽略的归一化 trigger 集合（泛化 trigger —— 不参与重合计数，但保留在 rawShared 里） */
export function triggerOverlap(candidateTriggers, topicTriggers, opts = {}) {
  const ignore = opts.ignoreNorms instanceof Set ? opts.ignoreNorms : new Set(opts.ignoreNorms || []);
  const a = normSet(candidateTriggers);
  const b = normSet(topicTriggers);
  const rawSharedNorm = [...a].filter((x) => b.has(x));
  const sharedNorm = rawSharedNorm.filter((x) => !ignore.has(x));
  const ignoredNorm = rawSharedNorm.filter((x) => ignore.has(x));
  return { count: sharedNorm.length, sharedNorm, rawCount: rawSharedNorm.length, rawSharedNorm, ignoredNorm };
}

// ---------------------------------------------------------------------------
// 3b. 泛化 trigger（区分度口径）—— Lead 2026-10-29 P0 修复
// ---------------------------------------------------------------------------

/**
 * 计算每个 trigger 的**主题覆盖率**（多少主题挂了这个 trigger）。
 * @param {Array<{id,triggers}>} topics  只传生效中的 triggers（retired 已剔除）
 * @returns {Map<string, {trigger:string, coverage:number, topics:string[]}>}
 */
export function triggerCoverage(topics = []) {
  const map = new Map();
  for (const t of topics) {
    const seen = new Set();
    for (const raw of triggersOf(t)) {
      const n = normalizeTrigger(raw);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (!map.has(n)) map.set(n, { trigger: String(raw), norm: n, coverage: 0, topics: [] });
      const e = map.get(n);
      e.coverage += 1;
      e.topics.push(t.id);
    }
  }
  return map;
}

/**
 * 泛化 trigger 集合（覆盖率 > genericTriggerMaxTopics）。
 * 判据是**数据驱动的区分度**，不是停用词表；停用词表只能做锦上添花。
 * @returns {{maxTopics:number, norms:Set<string>, list:Array<{trigger,coverage,topics}>}}
 */
export function genericTriggersOf(topics = [], cfg = DEFAULT_GOVERNANCE) {
  const c = { ...DEFAULT_GOVERNANCE, ...(cfg || {}) };
  const maxTopics = Number.isFinite(Number(c.genericTriggerMaxTopics)) ? Number(c.genericTriggerMaxTopics) : DEFAULT_GOVERNANCE.genericTriggerMaxTopics;
  const cov = triggerCoverage(topics);
  const list = [...cov.values()].filter((e) => e.coverage > maxTopics)
    .sort((a, b) => b.coverage - a.coverage || (a.norm < b.norm ? -1 : 1));
  return { maxTopics, norms: new Set(list.map((e) => e.norm)), list, coverage: cov };
}

/**
 * 新建裁决（纯计算，不落库、不抛错）。
 * 泛化 trigger（覆盖率 > genericTriggerMaxTopics）**不参与** trigger 重合计数：仍保留存储，
 * 只是不再把"2026/MB/原文一字未删"这种全域词当成"两个主题相似"的证据；
 * 名字相似度路径（编辑距离/包含/相似度）完全不受影响。
 * @param {object} p
 * @param {string} p.norm        候选主题的归一化名
 * @param {string[]} p.triggers  候选主题的 triggers
 * @param {Array} p.existing     既有主题 [{id,name,norm,triggers}]（triggers 只传"生效中"的，已 retired 不要传）
 * @param {object} [p.cfg]       覆盖 DEFAULT_GOVERNANCE
 * @returns {{zone:'forbidden'|'gray'|'safe', reason?:string, candidates:Array, forbidden:Array, gray:Array, best:object|null, genericTriggers:Array}}
 */
export function gradeCreate({ norm, triggers = [], existing = [], cfg = DEFAULT_GOVERNANCE }) {
  const c = { ...DEFAULT_GOVERNANCE, ...(cfg || {}) };
  const gen = genericTriggersOf(existing, c);
  const candidates = [];
  for (const t of existing) {
    const s = nameSimilarity(norm, t.norm);
    const ov = triggerOverlap(triggers, triggersOf(t), { ignoreNorms: gen.norms });
    const reasons = [];
    if (s.dist <= c.forbiddenEditDistance) reasons.push('edit-distance');
    if (s.sim >= c.forbiddenSim) reasons.push('similarity');
    if (s.contains) reasons.push('contains');
    if (ov.count >= c.forbiddenTriggerOverlap) reasons.push('trigger-overlap');
    candidates.push({
      id: t.id, name: t.name,
      dist: s.dist, sim: s.sim, contains: s.contains,
      triggerOverlap: ov.count, sharedTriggers: ov.sharedNorm,
      rawTriggerOverlap: ov.rawCount, ignoredGenericTriggers: ov.ignoredNorm,
      forbiddenReasons: reasons,
    });
  }
  const forbidden = candidates.filter((x) => x.forbiddenReasons.length > 0);
  // 泛化 trigger 摘要（被忽略的证据，审计/面板用；保留存储、不参与判定）
  const genericSummary = gen.list.map((e) => ({ trigger: e.trigger, norm: e.norm, coverage: e.coverage }));
  const genericTriggerHits = gen.list
    .filter((e) => normSet(triggers).has(e.norm))
    .map((e) => ({ trigger: e.trigger, norm: e.norm, coverage: e.coverage }));
  if (forbidden.length) {
    const top = forbidden.slice().sort((a, b) => b.sim - a.sim || b.triggerOverlap - a.triggerOverlap)[0];
    return {
      zone: 'forbidden',
      reason: top.forbiddenReasons.join('+'),
      reasonText: top.forbiddenReasons.map((r) => FORBIDDEN_REASON_TEXT[r] || r).join('、'),
      forbidden,
      gray: [],
      candidates,
      best: top,
      genericTriggerMaxTopics: gen.maxTopics,
      genericTriggers: genericSummary,
      candidateGenericTriggers: genericTriggerHits,
    };
  }
  const gray = candidates.filter((x) => x.sim >= c.graySim && x.sim < c.forbiddenSim);
  if (gray.length) {
    return {
      zone: 'gray', forbidden: [], gray, candidates, best: bestOf(gray),
      genericTriggerMaxTopics: gen.maxTopics, genericTriggers: genericSummary, candidateGenericTriggers: genericTriggerHits,
    };
  }
  return {
    zone: 'safe', forbidden: [], gray: [], candidates, best: bestOf(candidates),
    genericTriggerMaxTopics: gen.maxTopics, genericTriggers: genericSummary, candidateGenericTriggers: genericTriggerHits,
  };
}

// ---------------------------------------------------------------------------
// 3. 权限矩阵（决策 17：写死在代码里；actor 由插件判定，不信任调用方自报）
// ---------------------------------------------------------------------------

export const ACTORS = Object.freeze(['user', 'lead', 'dream', 'plugin', 'runtime']);

/**
 * 权限矩阵 —— 这是"谁能做什么"的唯一真源。
 *   createStates  : 允许直接建出来的状态。dream 只能 draft；user/lead 可 active。
 *   merge/split/delete : 主题级结构变更。dream 一律不行（只能出提案）；plugin 也不行（只做导入/派生）。
 *   setState      : 显式改状态（转正/归档/入队）。dream 不行（不能定音）。
 *   retireTrigger : 删除 trigger 只能打 retired 标记，属"删除"类动作，dream/plugin 不行。
 *   write         : 写单句。dream 可以（它可往所有主题写单句，只是不能定音）。
 *   seed          : 迁移/播种通道（store.seedTopic）。**只有 plugin**（导入器身份）可用；
 *                   模型侧的身份（user/lead/dream/runtime）拿不到 seed，避免绕开禁建区检查。
 *
 * 为什么 plugin 只能建 draft（2026-10-29 Lead 裁决，规则 1）：
 *   导入口新建主题"一律 draft，不得直建 active" —— 迁移过来的东西必须有人（lead/user）看过才算升格，
 *   不许导入静默升格。这里选择**报错**而不是静默降级（"宁可报错，不要静默分叉"）：
 *   plugin 请求 active ⇒ PERM_DENIED，迁移器应改用 seedTopic()。
 * 为什么保留 runtime：
 *   阶段 1 的既有调用方（契约测试/内部脚本）不传 actor，默认落到 runtime；权限等价 lead。
 *   真正的身份判定在插件边界（spawn 记录/会话 id/是否子代理），store 只接受插件传入的结论。
 */
export const PERMISSIONS = Object.freeze({
  user:    Object.freeze({ createStates: ['draft', 'active'], merge: true,  split: true,  delete: true,  setState: true,  rename: true,  retireTrigger: true,  addTrigger: true, write: true, seed: false }),
  lead:    Object.freeze({ createStates: ['draft', 'active'], merge: true,  split: true,  delete: true,  setState: true,  rename: true,  retireTrigger: true,  addTrigger: true, write: true, seed: false }),
  runtime: Object.freeze({ createStates: ['draft', 'active'], merge: true,  split: true,  delete: true,  setState: true,  rename: true,  retireTrigger: true,  addTrigger: true, write: true, seed: false }),
  dream:   Object.freeze({ createStates: ['draft'],           merge: false, split: false, delete: false, setState: false, rename: true,  retireTrigger: false, addTrigger: true, write: true, seed: false }),
  plugin:  Object.freeze({ createStates: ['draft'],           merge: false, split: false, delete: false, setState: false, retireTrigger: false, addTrigger: true, write: true, seed: true }),
});

export function actorProfile(actor) { return PERMISSIONS[actor] || null; }
export function isKnownActor(actor) { return !!PERMISSIONS[actor]; }

/** 动作级的权限判定（action 是矩阵里的键，如 'merge'/'setState'/'createStates' 除外） */
export function can(actor, action) {
  const p = PERMISSIONS[actor];
  if (!p) return false;
  if (action === 'create') return p.createStates.length > 0;
  return p[action] === true;
}

/** 某 actor 允许直接建出来的状态列表；未知 actor 返回空数组（⇒ 一律 deny） */
export function createStatesFor(actor) {
  const p = PERMISSIONS[actor];
  return p ? p.createStates.slice() : [];
}

/**
 * 身份解析（冒充防护，决策 17）。
 * actual 是插件判定出来的真实身份；claimed 是调用方自称的身份。
 * 只有"插件给不出真实身份"时才退回 claimed；两者不一致 ⇒ impersonated=true（调用方要记审计）。
 */
export function resolveActor({ claimed, actual } = {}) {
  const claimedActor = claimed == null || claimed === '' ? null : String(claimed);
  const actualActor = actual == null || actual === '' ? null : String(actual);
  const actor = actualActor || claimedActor || 'runtime';
  return {
    actor,
    claimed: claimedActor,
    actual: actualActor,
    impersonated: !!(claimedActor && actualActor && claimedActor !== actualActor),
    known: isKnownActor(actor),
  };
}

// ---------------------------------------------------------------------------
// 4. trigger 冲突（决策 10：同一 trigger 归属多主题 ⇒ 记冲突，检索并列返回不自动择一）
// ---------------------------------------------------------------------------

/**
 * 扫描 trigger 冲突。
 * [2026-10-29 P0 修复] 默认**跳过泛化 trigger**（覆盖率 > genericTriggerMaxTopics）：
 *   "2026/MB/原文一字未删"这种全域词挂在几百个主题上，若计入冲突会把冲突面板彻底淹没，
 *   也会让检索并列返回失去区分度。需要老口径（全量）时传 { includeGeneric: true }。
 * @param {Array} topics [{id,name,triggers}]，triggers 只传生效中的（retired 的不参与冲突）
 * @param {object} [opts] { includeGeneric?: boolean, cfg?: object }
 * @returns {Array<{norm:string, trigger:string, count:number, topics:Array<{id,name}>}>}
 */
export function findTriggerConflicts(topics = [], opts = {}) {
  const includeGeneric = opts.includeGeneric === true;
  const gen = includeGeneric ? { norms: new Set() } : genericTriggersOf(topics, opts.cfg || DEFAULT_GOVERNANCE);
  const map = new Map();
  for (const t of topics) {
    const seen = new Set();
    for (const raw of triggersOf(t)) {
      const n = normalizeTrigger(raw);
      if (!n || seen.has(n)) continue;   // 同一主题内重复 trigger 不算冲突
      if (gen.norms.has(n)) continue;     // 泛化 trigger：保留存储，但不算冲突
      seen.add(n);
      if (!map.has(n)) map.set(n, { norm: n, trigger: String(raw), topics: [] });
      map.get(n).topics.push({ id: t.id, name: t.name });
    }
  }
  return [...map.values()]
    .filter((e) => e.topics.length >= 2)
    .map((e) => ({ ...e, count: e.topics.length }))
    .sort((a, b) => b.count - a.count || (a.norm < b.norm ? -1 : 1));
}
