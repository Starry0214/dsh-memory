/**
 * p3-triggers.js — dsh-memory P3-1 写侧触发：**纯决策函数**（ESM，零依赖，无 I/O）
 *
 * 设计依据：.task/1101-dsh-mimo-survey/13-p3-design.md
 *   §2   写侧四个触发点（T1–T3 token 三档 / T4 压缩 / T5 会话收尾 / T6 漏网扫描）
 *   §2.1 三档相对 **thresholdTokens** 取 50% / 75% / 90%（**不是**窗口的 80%——80% 与压缩阈值重合会永不先触发）
 *   §2.2 每档每压缩周期各触发一次；压缩/重建后阶梯清零（resetAfterCompact）
 *   §2.3 压缩事件（无论 auto/manual）一律先写检查点，再重置阶梯
 *
 * 本模块只做「该不该触发 / 触发哪一档」的判定：
 *   - 不读系统时钟（时间一律由调用方以 now / lastActivityAt 传入）
 *   - 不读盘、不写盘、不发网络、不 spawn、不打日志、不抛业务异常（非法输入一律返回 fire:false）
 *   - 不做去重/重试/并发控制（那些属于 index.js 接线层）
 *
 * 状态约定（由 index.js 持有，建议持久化到 ~/.dsh/memory/.monitor.json 的 p3 段）：
 *   每会话 { fired: number[], lastFireAt: number, lastActivityAt: number, checkpointAt: number }
 *   - fired      已触发档位（本压缩周期），用 markFired 追加、resetAfterCompact 清零
 *   - lastFireAt 上次「发起」检查点写的时刻（冷却判据；建议发起即记，失败也别回退，防重试风暴）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 公共契约（Lead 接线用）：
 *
 *   THRESHOLD_LEVELS            [0.5, 0.75, 0.9]（冻结）
 *   DEFAULT_MIN_INTERVAL_MS     300000（5 分钟冷却）
 *   DEFAULT_IDLE_MS             1800000（30 分钟收尾空闲）
 *   DEFAULT_MAX_AGE_DAYS        7（漏网扫描窗口）
 *   DEFAULT_MAX_COUNT           3（漏网单轮最多补写条数）
 *
 *   computeLevels(thresholdTokens) -> {t1,t2,t3} | null
 *   decideThresholdTrigger({totalTokens, thresholdTokens, firedLevels, now, lastFireAt, minIntervalMs})
 *                                 -> {fire, level: 1|2|3|null, reason}
 *   markFired(firedLevels, level) -> number[]           （新数组，幂等，不改入参）
 *   resetAfterCompact()           -> []                 （压缩/重建后清零阶梯）
 *   decideSessionEnd({lastActivityAt, now, idleMs, isSubagent, hasCheckpoint})
 *                                 -> {fire, reason}
 *   decideMissed({sessions, now, maxAgeDays, maxCount})
 *                                 -> [{sid, ageDays, reason}]
 *
 * decideThresholdTrigger 的 reason 取值（稳定字符串，可进 cost/日志）：
 *   "invalid-threshold" thresholdTokens 非法（非有限正数）
 *   "invalid-usage"      totalTokens 非法（非有限数或为负）
 *   "below-t1"           未跨过第一档
 *   "already-fired"      当前最高跨越档已被覆盖（同档不重复 / 跨档跳跃后低档视为被覆盖）
 *   "cooldown"           有新档可触发，但距 lastFireAt 不足 minIntervalMs
 *   "threshold"          触发（level 为最高未覆盖跨越档）
 *
 * 跨档合并语义：若 tokens 一次跳过两档（如 40% → 92%），只返回最高档（level=3），
 *   低档视为被高档检查点覆盖（避免同一周期连写 3 次）。因此判定用「已覆盖档 = max(firedLevels)」，
 *   而不是逐档判 in 集合；markFired 仍按字面只记录 level 一个值。
 *
 * 冷却语义：now 或 lastFireAt 任一不可用时**不做冷却拦截**（宁多写一次，不静默失效）；
 *   时钟回拨（now < lastFireAt）按冷却期内处理。
 *
 * decideSessionEnd 的 reason： "subagent" / "archived" / "has-checkpoint" / "no-activity" / "invalid-now" / "not-idle" / "too-old" / "idle"
 * decideMissed  的 reason： "no-checkpoint"
 */
const DAY_MS = 86400000;
const LEVEL_COUNT = 3;

export const THRESHOLD_LEVELS = Object.freeze([0.5, 0.75, 0.9]);
export const DEFAULT_MIN_INTERVAL_MS = 300000; // 5 分钟
export const DEFAULT_IDLE_MS = 1800000;        // 30 分钟
export const DEFAULT_MAX_AGE_DAYS = 7;         // 漏网扫描窗口（最近 N 天内有活动但无检查点）
export const DEFAULT_MAX_COUNT = 3;            // 漏网单轮批量上限

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidLevel(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= LEVEL_COUNT;
}

/** 把任意 firedLevels（number[] / Set / 其他可迭代）规范成「升序去重的合法档位数组」。 */
function normalizeFiredLevels(firedLevels) {
  const out = [];
  const take = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= LEVEL_COUNT && out.indexOf(n) === -1) out.push(n);
  };
  if (firedLevels && typeof firedLevels !== "string" && typeof firedLevels[Symbol.iterator] === "function") {
    for (const v of firedLevels) take(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 三档绝对阈值 = floor(thresholdTokens × 0.5 / 0.75 / 0.9)。
 * 公式随 §2.1 固定取 thresholdTokens 的相对比例（不是窗口百分比）。
 * @param {number} thresholdTokens 宿主的压缩阈值 token 数（DSH 默认 838,860）
 * @returns {{t1:number,t2:number,t3:number}|null} 非法输入返回 null（调用方据此不触发）
 */
export function computeLevels(thresholdTokens) {
  if (!isNum(thresholdTokens) || thresholdTokens <= 0) return null;
  return {
    t1: Math.floor(thresholdTokens * THRESHOLD_LEVELS[0]),
    t2: Math.floor(thresholdTokens * THRESHOLD_LEVELS[1]),
    t3: Math.floor(thresholdTokens * THRESHOLD_LEVELS[2]),
  };
}

/**
 * 判定是否该因 token 跨档而写检查点。
 * @param {object} p
 * @param {number} p.totalTokens     当前上下文 token（DSH: assistant/message.data.usage.totalTokens）
 * @param {number} p.thresholdTokens 压缩阈值 token（DSH: floor(min(W×0.8, W−O−headroom))）
 * @param {number[]|Set<number>} [p.firedLevels] 本周期已触发档位
 * @param {number} [p.now]           当前时刻（ms）
 * @param {number} [p.lastFireAt]    上次触发时刻（ms），未触发过传 0/null/undefined
 * @param {number} [p.minIntervalMs] 冷却毫秒，缺省 DEFAULT_MIN_INTERVAL_MS；0 = 关闭冷却
 * @returns {{fire:boolean, level:(1|2|3|null), reason:string}}
 */
export function decideThresholdTrigger({
  totalTokens,
  thresholdTokens,
  firedLevels,
  now,
  lastFireAt,
  minIntervalMs,
} = {}) {
  const levels = computeLevels(thresholdTokens);
  if (!levels) return { fire: false, level: null, reason: "invalid-threshold" };
  if (!isNum(totalTokens) || totalTokens < 0) return { fire: false, level: null, reason: "invalid-usage" };

  // 最高跨越档（>= 判定：整点即算跨越）
  const abs = [levels.t1, levels.t2, levels.t3];
  let crossed = 0;
  for (let i = 0; i < abs.length; i += 1) if (totalTokens >= abs[i]) crossed = i + 1;
  if (crossed === 0) return { fire: false, level: null, reason: "below-t1" };

  // 已覆盖档 = 已触发档位的最大值（高档已写 ⇒ 低档视为被覆盖）
  const fired = normalizeFiredLevels(firedLevels);
  const covered = fired.length > 0 ? fired[fired.length - 1] : 0;
  if (crossed <= covered) return { fire: false, level: null, reason: "already-fired" };

  // 冷却：只看「是否有新档待写」，先把 already-fired 判掉，冷却只拦真正要写的
  const interval = isNum(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
  if (isNum(lastFireAt) && isNum(now) && now - lastFireAt < interval) {
    return { fire: false, level: null, reason: "cooldown" };
  }

  return { fire: true, level: crossed, reason: "threshold" };
}

/**
 * 记录某档已触发。返回**新数组**（升序去重），不修改入参；重复标记幂等。
 * 非法 level 按 no-op 处理（返回规范化副本）。
 * @param {number[]|Set<number>} [firedLevels]
 * @param {number} level 1|2|3
 * @returns {number[]}
 */
export function markFired(firedLevels, level) {
  const out = normalizeFiredLevels(firedLevels);
  if (!isValidLevel(level)) return out;
  const n = Number(level);
  if (out.indexOf(n) === -1) {
    out.push(n);
    out.sort((a, b) => a - b);
  }
  return out;
}

/**
 * 压缩 / 重建后重置阶梯：新周期从第一档重新开始（§2.2）。
 * @returns {number[]} 新的空数组
 */
export function resetAfterCompact() {
  return [];
}

/**
 * 会话收尾判定（T5）：主会话空闲 ≥ idleMs、非子代理、未归档、尚未写过检查点、未超最大空闲窗 → fire。
 * @param {object} p
 * @param {number} p.lastActivityAt 会话最后活动时刻（ms）
 * @param {number} p.now            当前时刻（ms）
 * @param {number} [p.idleMs]       空闲门槛，缺省 DEFAULT_IDLE_MS（30 分钟）
 * @param {boolean} [p.isSubagent]  子代理会话 → 永不触发
 * @param {boolean} [p.hasCheckpoint] 本会话已写过检查点 → 不重复写
 * @param {boolean} [p.isArchived]  会话已归档 → 永不触发（4.5.10 T5-1：归档会话不再补写）
 * @param {number} [p.maxIdleMs]    最大空闲窗，缺省 DEFAULT_MAX_AGE_DAYS*DAY_MS（7 天）；超窗 → too-old（4.5.10 T5-F）
 * @returns {{fire:boolean, reason:string}}
 */
export function decideSessionEnd({ lastActivityAt, now, idleMs, isSubagent, hasCheckpoint, isArchived, maxIdleMs } = {}) {
  if (isSubagent === true) return { fire: false, reason: "subagent" };
  if (isArchived === true) return { fire: false, reason: "archived" };
  if (hasCheckpoint === true) return { fire: false, reason: "has-checkpoint" };
  if (!isNum(lastActivityAt) || lastActivityAt <= 0) return { fire: false, reason: "no-activity" };
  if (!isNum(now)) return { fire: false, reason: "invalid-now" };
  const idle = isNum(idleMs) && idleMs >= 0 ? idleMs : DEFAULT_IDLE_MS;
  if (now - lastActivityAt < idle) return { fire: false, reason: "not-idle" };
  const maxIdle = isNum(maxIdleMs) && maxIdleMs >= 0 ? maxIdleMs : DEFAULT_MAX_AGE_DAYS * DAY_MS;
  if (now - lastActivityAt > maxIdle) return { fire: false, reason: "too-old" };
  return { fire: true, reason: "idle" };
}

/**
 * 漏网扫描（T6）：最近 maxAgeDays 内有活动、但还没写过检查点的主会话 → 按最后活动时间倒序补写。
 * 过滤：hasCheckpoint===true / isSubagent===true / sid 为空 / lastActivityAt 非法或超窗 → 跳过。
 * @param {object} p
 * @param {Array<{sid:string,cwd?:string,lastActivityAt:number,hasCheckpoint?:boolean,isSubagent?:boolean}>} [p.sessions]
 * @param {number} p.now
 * @param {number} [p.maxAgeDays] 扫描窗口（天），缺省 DEFAULT_MAX_AGE_DAYS
 * @param {number} [p.maxCount]   单轮最多返回条数，缺省 DEFAULT_MAX_COUNT；0 = 本轮不补
 * @returns {Array<{sid:string, ageDays:number, reason:string}>}
 */
export function decideMissed({ sessions, now, maxAgeDays, maxCount } = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  if (!isNum(now)) return [];
  const windowDays = isNum(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const limit = isNum(maxCount) && maxCount >= 0 ? Math.floor(maxCount) : DEFAULT_MAX_COUNT;
  if (limit <= 0) return [];
  const windowMs = windowDays * DAY_MS;

  const cands = [];
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    const sid = typeof s.sid === "string" ? s.sid.trim() : "";
    if (!sid) continue;
    if (s.isSubagent === true) continue;
    if (s.hasCheckpoint === true) continue;
    if (!isNum(s.lastActivityAt) || s.lastActivityAt <= 0) continue;
    const ageMs = Math.max(0, now - s.lastActivityAt); // 时钟回拨按「刚刚活动」处理
    if (ageMs > windowMs) continue;                    // 超出扫描窗口（太旧，不回填）
    cands.push({ sid, ageMs, lastActivityAt: s.lastActivityAt });
  }

  cands.sort((a, b) => (b.lastActivityAt - a.lastActivityAt) || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  return cands.slice(0, limit).map((c) => ({
    sid: c.sid,
    ageDays: Math.round((c.ageMs / DAY_MS) * 100) / 100,
    reason: "no-checkpoint",
  }));
}
