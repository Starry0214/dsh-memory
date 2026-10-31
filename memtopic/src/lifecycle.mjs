// 生命周期状态机（阶段 3）：draft / active / dormant / archived / needs_review + 7/30/90 曝光阶梯
//
// 设计原则：
//   1) 本模块同样零副作用：只做"给定主题快照 + 当前时钟 ⇒ 应该发生什么"的纯计算。
//      真正落库/写审计/抛错在 memory-store.mjs。
//   2) 时间只用于决定"曝光还是归档"，**不用于悄悄埋掉内容**（用户强调 / 决策 13）：
//      - 7 天：每会话一行提醒，**不降级**
//      - 30 天：提醒文案升级为"建议归档 / 或转正"，**仍不自动动手**
//      - 90 天：才自动归档（此前约 12 次曝光机会），归档后原文仍可按主题读到
//      - 被检索命中过（renewDays 内）⇒ 续期：不进提醒、不降级
//   3) 阈值全部集中在 DEFAULT_LIFECYCLE_CONFIG，可被 store.configureLifecycle() 覆盖且立即生效。
//
// 契约来源：alignment.md 决策 13（含曝光阶梯）/ task.md 技术决策 8 / verification.md C 组。

export const DAY_MS = 24 * 60 * 60 * 1000;

export const STATES = Object.freeze(['draft', 'active', 'dormant', 'archived', 'needs_review']);

// 走"曝光阶梯"的状态（会进待归类提醒）。dormant 不进提醒（它本来就不进注入正文），
// 但 dormant 仍然会在到期后归档（决策 13：archived 由 dormant 或 90 天曝光终点进入）。
export const EXPOSURE_STATES = Object.freeze(['draft', 'needs_review']);
export const ARCHIVABLE_STATES = Object.freeze(['draft', 'needs_review', 'dormant']);

// 合法状态迁移表。archived 是终点：归档不删原文，但顶层不允许"自动复活"。
export const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['active', 'dormant', 'archived', 'needs_review']),
  active: Object.freeze(['draft', 'dormant', 'archived', 'needs_review']),
  dormant: Object.freeze(['active', 'archived', 'needs_review']),
  needs_review: Object.freeze(['draft', 'active', 'dormant', 'archived']),
  archived: Object.freeze([]),
});

export const DEFAULT_LIFECYCLE_CONFIG = Object.freeze({
  remindAfterDays: 7,        // 第 1 级曝光：每会话一行提醒（不降级）
  escalateAfterDays: 30,     // 第 2 级曝光：文案升级为"建议归档 / 或转正"
  archiveAfterDays: 90,      // 第 3 级：才自动归档
  renewDays: 7,              // 最近 N 天内有检索命中 ⇒ 续期（不提醒、不降级）
  needsReviewCap: 20,        // needs_review 队列封顶；第 21 条进来把最旧最低频转 dormant
  needsReviewSeedExempt: true, // Lead 裁决A：封顶只对**非 seed 来源**生效；导入来的冲突不因封顶被埋
  promoteAfterWrites: 2,     // draft 被写入 ≥N 次且无冲突 ⇒ 自动转正
  reminderMaxList: 3,        // 提醒里最多列几条最旧（其余概括为"等 N 条"）
  reminderMaxLines: 1,       // 硬约束：每会话恰好 1 行
});

export function daysBetween(fromMs, toMs) {
  return Math.floor((Number(toMs) - Number(fromMs)) / DAY_MS);
}

export function isState(s) { return STATES.includes(s); }
export function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  if (from === to) return true;      // 幂等（同状态重设允许，落库时会被 store 短路）
  return TRANSITIONS[from].includes(to);
}

/** 主题"入场时间"：优先 state_since，老数据退回 createdAt */
export function stateSinceOf(topic) {
  return Number(topic && (topic.stateSince != null ? topic.stateSince : topic.createdAt) || 0);
}

/** 续期判定：最近 renewDays 天内有命中 ⇒ 视为"活着的"，不提醒不降级 */
export function isRenewed(topic, nowMs, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const last = topic && topic.lastHitAt != null ? Number(topic.lastHitAt) : null;
  if (last == null) return false;
  const diff = Number(nowMs) - last;
  return diff >= 0 && diff < cfg.renewDays * DAY_MS;
}

/**
 * 单个主题的曝光级别。
 * @returns {{level:'none'|'remind'|'escalate'|'archive', days:number, renewed:boolean}}
 */
export function exposureLevel(topic, nowMs, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  const days = daysBetween(stateSinceOf(topic), nowMs);
  const renewed = isRenewed(topic, nowMs, c);
  if (!EXPOSURE_STATES.includes(topic.state)) return { level: 'none', days, renewed };
  if (renewed) return { level: 'none', days, renewed };
  if (days >= c.archiveAfterDays) return { level: 'archive', days, renewed };
  if (days >= c.escalateAfterDays) return { level: 'escalate', days, renewed };
  if (days >= c.remindAfterDays) return { level: 'remind', days, renewed };
  return { level: 'none', days, renewed };
}

const LEVEL_RANK = { none: 0, remind: 1, escalate: 2, archive: 3 };

function oneLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 待归类提醒（硬约束：恰好 1 行、最多列出 maxList 条最旧、其余概括为"等 N 条"）。
 * 返回 null 表示本次会话无需提醒。
 *
 * @param {Array<{id,name,days,level}>} items 已按"最旧优先"排好序
 * @returns {{line:string, count:number, oldestDays:number, level:string, items:Array, hidden:number}|null}
 */
export function buildReminder(items, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  if (!items || !items.length) return null;
  const sorted = items.slice().sort((a, b) => b.days - a.days || (a.id < b.id ? -1 : 1));
  const level = sorted.reduce((acc, x) => (LEVEL_RANK[x.level] > LEVEL_RANK[acc] ? x.level : acc), 'none');
  const count = sorted.length;
  const oldestDays = sorted[0].days;
  const shown = sorted.slice(0, Math.max(1, c.reminderMaxList));
  const hidden = count - shown.length;
  const list = shown.map((x) => `${x.id}「${oneLine(x.name)}」`).join('；');
  const tail = hidden > 0 ? ` 等 ${hidden} 条` : '';
  const escalate = level === 'escalate' || level === 'archive';
  const core = `${count} 条待归类主题，最早 ${oldestDays} 天${escalate ? '，建议归档 / 或转正' : ''}：${list}${tail}`;
  // 【dsh-memory · 待归类主题】是复用既有注入通道 injectMaintenanceReminder() 的新增段名（决策 13）
  const line = oneLine(`【dsh-memory · 待归类主题】${core}`);
  return { line, count, oldestDays, level, items: shown, hidden };
}

/**
 * 计算曝光计划：
 *   archivable —— 到 90 天该归档的（store 负责真的改状态）
 *   reminder   —— 归档之后仍然"待处置"的（这里先给出提醒内容）
 * 注意：本函数不修改任何输入。
 */
export function planExposure(topics, nowMs, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  const pending = [];
  const archivable = [];
  for (const t of topics) {
    const { level, days, renewed } = exposureLevel(t, nowMs, c);
    if (renewed) continue;
    if (level === 'archive') {
      archivable.push({ id: t.id, name: t.name, days, from: t.state, level });
      continue;   // 已安排归档的，不再进提醒
    }
    if (level === 'none') continue;
    pending.push({ id: t.id, name: t.name, days, level });
  }
  pending.sort((a, b) => b.days - a.days || (a.id < b.id ? -1 : 1));
  archivable.sort((a, b) => b.days - a.days || (a.id < b.id ? -1 : 1));
  return { pending, archivable, reminder: buildReminder(pending, c) };
}

/** 只是"该归档谁"的判定（store 在 tick 里用） */
export function planArchivable(topics, nowMs, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  const out = [];
  for (const t of topics) {
    if (!ARCHIVABLE_STATES.includes(t.state)) continue;
    if (isRenewed(t, nowMs, c)) continue;
    const days = daysBetween(stateSinceOf(t), nowMs);
    if (days >= c.archiveAfterDays) out.push({ id: t.id, name: t.name, days, from: t.state });
  }
  return out.sort((a, b) => b.days - a.days || (a.id < b.id ? -1 : 1));
}

/**
 * needs_review 队列封顶：第 cap+1 条进来时挑"最旧 + 命中次数最少"的一条转 dormant。
 * @param {Array<{id,stateSince,hitCount}>} queue 当前 needs_review 队列（不含刚入场的那条也兼容）
 */
export function pickOverflowVictim(queue, cfg = DEFAULT_LIFECYCLE_CONFIG) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  if (!queue || queue.length <= c.needsReviewCap) return null;
  const sorted = queue.slice().sort((a, b) => {
    const sa = stateSinceOf(a), sb = stateSinceOf(b);
    if (sa !== sb) return sa - sb;                                  // 最旧优先
    const ha = a.hitCount || 0, hb = b.hitCount || 0;
    if (ha !== hb) return ha - hb;                                  // 再按命中次数最少
    return a.id < b.id ? -1 : 1;                                    // 最后按 ID 稳定排序
  });
  return { victim: sorted[0], overflowBy: queue.length - c.needsReviewCap };
}

/**
 * 自动转正判定：draft + 写入 ≥N 次 + 无冲突（冲突由调用方判定后传入）。
 * writes: 可选，覆盖计数来源 —— 阶段3 起，自动转正看的是"推动转正的写入次数"：
 *         导入(seed)主题的写入不计入（Lead 2026-10-29 裁决规则 4），只有 lead/user 的写入才计数。
 */
export function shouldAutoPromote(topic, cfg = DEFAULT_LIFECYCLE_CONFIG, { hasConflict = false, writes = null } = {}) {
  const c = { ...DEFAULT_LIFECYCLE_CONFIG, ...(cfg || {}) };
  if (!topic || topic.state !== 'draft') return false;
  if (hasConflict) return false;
  const n = writes == null ? Number(topic.writeCount || 0) : Number(writes);
  return n >= c.promoteAfterWrites;
}
