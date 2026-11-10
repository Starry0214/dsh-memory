// p3-cost.js — dsh-memory · P3-3「消耗记账」数据层（纯函数 / 零依赖 / 无 IO）
// 结构依据：.task/1101-dsh-mimo-survey/13-p3-design.md §5.1 精度边界 / §5.2 记账结构 / §5.3 记账点 / §5.4 面板消费
// 纪律：①只吃参数（不读盘/不发网/不取当前时间；dateKey 与 ev.t 由调用方传入）②就地累加并返回传入对象
//   （供「内存累加 → 30s 或 20 条 flush 一次」写盘节流）③daily 按需建 kind 记录（缺省视为 0），不预铺 13×N 空字段
//   ④容错优先：cost 缺失/字段损坏由 ensureCost 就地修补，绝不抛错（记账不能拖垮检查点/注入主流程）。
// 口径：estTokens ≈ chars/4（对齐 estimate.js ~4 chars/token）；real tokens 只来自 hostUsage（宿主 usage 真实值）。
// 接线：读回 .monitor.json 的 cost 段 → bumpKind/addDaily/pushEvent 记账 → pruneDaily(30, todayKey) →
//   stats.json 下发 cost 原结构（§5.2）；宿主面板可直接用 summarize(COST,{todayKey}) 渲染（today/byKind/trend7d/topSessions）。

export const COST_VERSION = 1;

/** 全部记账环节（顺序即面板展示顺序；新增环节须同步 KIND_FIELDS） */
export const KIND_LIST = Object.freeze([
  "checkpointWrite", "rebuildInject", "startupInject", "recallReminder", "hintA", "hintB", "hintC",
  "memorySearch", "dream", "maint", "archive", "export",
  // [2026-11-02 口径拆分] 原 hostUsage 是「主会话 + 子代理」混在一起的桶，被当成"记忆插件消耗"展示会严重误导
  //   （主会话 tokens 是用户与 Agent 对话本身的开销，不是插件成本）。现拆成：
  //     hostMain = 主会话 usage（**非插件开销**，仅作对照基线）
  //     hostSub  = 子代理 usage（writer/dream/archive，**这才是插件的真实成本**）
  //   hostUsage 保留 = 拆分前的历史混合数据（只读兼容，新数据不再写入）。
  "hostUsage", "hostMain", "hostSub"
]);

// 每个环节的字段集（§5.2）：bumpKind 只累加这里列出的字段，delta 里其它键一律忽略。
// checkpointWrite.estTokens 是 §5.3「估算 tokens」+ §5.4 表格列所必需（§5.2 示例漏写）；
// hostUsage 比 §5.2 示例多一个 totalTokens（宿主 usage 自带真实值；缺省时 summarize 按 in+out+cacheRead+cacheWrite 兜底）。
const KIND_FIELDS = Object.freeze({
  checkpointWrite: ["n", "inTokens", "outTokens", "cacheReadTokens", "totalTokens", "inChars", "outChars", "estTokens", "durMs", "fail", "retry", "timeout"],
  rebuildInject: ["n", "injectedChars", "estTokens"],
  startupInject: ["n", "injectedChars", "estTokens"],
  recallReminder: ["n", "injectedChars"],
  hintA: ["n", "injectedChars"], hintB: ["n", "injectedChars"], hintC: ["n", "injectedChars"],
  memorySearch: ["n", "resultChars", "durMs", "miss"],
  dream: ["n", "inTokens", "outTokens", "cacheReadTokens", "totalTokens", "durMs", "ok"],
  maint: ["n", "inTokens", "outTokens", "totalTokens", "beforeChars", "afterChars"],
  archive: ["n", "inTokens", "outTokens", "totalTokens", "written", "inChars"],
  export: ["n", "bytes", "durMs"],
  hostUsage: ["inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite", "turns"],
  hostMain: ["n", "inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite"],
  hostSub: ["n", "inTokens", "outTokens", "totalTokens", "cacheRead", "cacheWrite"]
});

const DAY_MS = 86400000;
const TRIGGER_LEVELS = ["T1", "T2", "T3", "T4", "T5", "T6"];

// ── 基础工具（全部纯函数） ────────────────────────────────────────────────

/** 宽松取数：非有限数/空 → 0；true → 1（便于 delta.ok/fail 直接传布尔） */
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === true) return 1;
  if (v === false || v === null || v === undefined) return 0;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/** 估算 tokens：≈4 字符/token；chars<=0 → 0 */
export function estTokens(chars) {
  const n = toNum(chars);
  return n <= 0 ? 0 : Math.ceil(n / 4);
}

function hasKind(kind) { return typeof kind === "string" && Object.prototype.hasOwnProperty.call(KIND_FIELDS, kind); }

function zeroRecord(kind) {
  const rec = {};
  for (const f of KIND_FIELDS[kind]) rec[f] = 0;
  return rec;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

/** "YYYY-MM-DD" → UTC 日起点 ms；非法（含 2026-02-30）→ null（只用 Date.UTC，不依赖当前时间/本地时区） */
function parseDateKey(key) {
  const m = typeof key === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return null;
  const daysInMonth = Math.round((Date.UTC(y, mo, 0) - Date.UTC(y, mo - 1, 1)) / DAY_MS) + 1;
  if (d > daysInMonth) return null;
  return Date.UTC(y, mo - 1, d);
}

function isDateKey(key) { return parseDateKey(key) !== null; }

/** UTC 日起点 ms → "YYYY-MM-DD"（只格式化入参，不读当前时间） */
function fmtDateKey(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function clampInt(v, dflt, lo, hi) {
  if (v === undefined || v === null) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(toNum(v))));
}

// ── 账本骨架 ──────────────────────────────────────────────────────────────

/** 空账本（§5.2 结构） */
export function emptyCost() {
  const totals = {};
  for (const k of KIND_LIST) totals[k] = zeroRecord(k);
  return {
    version: COST_VERSION,
    since: 0,                                   // 记账起点 epoch ms（宿主首笔记账时写入；本模块不取时间）
    totals: totals,
    daily: {},                                  // { "YYYY-MM-DD": { <kind>: record } }，按需建
    events: [],                                 // 环形明细（pushEvent 维护，默认 cap=500）
    limits: { dailyEstTokens: 0, perKind: {} }  // §5.5 预算护栏落盘位（默认不设限）
  };
}

function ensureRecord(map, kind) {
  const fields = KIND_FIELDS[kind];
  if (!fields) return null;
  let rec = map[kind];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) rec = map[kind] = {};
  for (const f of fields) if (typeof rec[f] !== "number" || !Number.isFinite(rec[f])) rec[f] = 0;
  return rec;
}

/** 就地修补账本：缺段补段、坏类型归零、未知字段保留（向前兼容）；返回同一个对象 */
function ensureCost(cost) {
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return emptyCost();
  if (typeof cost.version !== "number" || !Number.isFinite(cost.version)) cost.version = COST_VERSION;
  if (typeof cost.since !== "number" || !Number.isFinite(cost.since)) cost.since = 0;
  if (!cost.totals || typeof cost.totals !== "object" || Array.isArray(cost.totals)) cost.totals = {};
  for (const k of KIND_LIST) ensureRecord(cost.totals, k);
  if (!cost.daily || typeof cost.daily !== "object" || Array.isArray(cost.daily)) cost.daily = {};
  if (!Array.isArray(cost.events)) cost.events = [];
  if (!cost.limits || typeof cost.limits !== "object" || Array.isArray(cost.limits)) cost.limits = { dailyEstTokens: 0, perKind: {} };
  return cost;
}

/** estTokens 自动派生：注入型环节看 injectedChars；token 型环节看 inChars+outChars */
function deriveEstTokens(kind, d) {
  if (KIND_FIELDS[kind].indexOf("injectedChars") >= 0) return estTokens(toNum(d.injectedChars));
  return estTokens(toNum(d.inChars)) + estTokens(toNum(d.outChars));
}

/** 把 delta 累加进 map[kind]；兼容别名：cacheReadTokens↔cacheRead、hostUsage.turns←n */
function applyDelta(map, kind, delta) {
  const rec = ensureRecord(map, kind);
  if (!rec) return null;
  const d = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
  const explicitEst = d.estTokens !== undefined && d.estTokens !== null;
  for (const f of KIND_FIELDS[kind]) {
    let v;
    if (f === "cacheReadTokens") v = d.cacheReadTokens !== undefined ? d.cacheReadTokens : d.cacheRead;
    else if (f === "cacheRead") v = d.cacheRead !== undefined ? d.cacheRead : d.cacheReadTokens;
    else if (f === "turns") v = d.turns !== undefined ? d.turns : d.n;
    else if (f === "estTokens" && !explicitEst) v = deriveEstTokens(kind, d);
    else v = d[f];
    const x = toNum(v);
    if (x !== 0) rec[f] += x;
  }
  return rec;
}

// ── 记账 API ──────────────────────────────────────────────────────────────

/**
 * 累计态累加（totals）。delta 字段可选、缺省 0：n,inTokens,outTokens,cacheReadTokens,totalTokens,
 * inChars,outChars,injectedChars,estTokens,resultChars,bytes,durMs,fail,retry,timeout,ok；
 * 专有字段：miss(memorySearch)/written(archive)/beforeChars,afterChars(maint)/cacheRead,cacheWrite,turns(hostUsage)。
 * 未知 kind / 未知字段 → 静默忽略（记账绝不能抛错）。返回传入的 cost（支持 cost = bumpKind(cost,...)）。
 */
export function bumpKind(cost, kind, delta) {
  const c = ensureCost(cost);
  if (hasKind(kind)) applyDelta(c.totals, kind, delta);
  return c;
}

/**
 * 按日累加（daily[dateKey]）；dateKey 非法或 kind 未知 → 原样返回。daily 记录按需创建（缺省视为 0）。
 * 返回传入的 cost。
 */
export function addDaily(cost, dateKey, kind, delta) {
  const c = ensureCost(cost);
  if (!isDateKey(dateKey) || !hasKind(kind)) return c;
  let day = c.daily[dateKey];
  if (!day || typeof day !== "object" || Array.isArray(day)) day = c.daily[dateKey] = {};
  applyDelta(day, kind, delta);
  return c;
}

// events 字段白名单（控制 .monitor.json 体积；note 用作触发档位/失败原因等自由文本）
const EVENT_STR = { kind: 40, sid: 64, trigger: 8, note: 200, d: 10 };
const EVENT_NUM = ["n", "inTokens", "outTokens", "cacheReadTokens", "totalTokens", "inChars", "outChars", "injectedChars", "estTokens", "resultChars", "bytes", "durMs", "ok", "fail", "retry", "timeout"];

/**
 * 追加一条明细事件并按 cap 环形裁剪（默认 500 条，§5.2）。约定：
 * { t, kind, sid, trigger?, d?, inChars?, outChars?, estTokens?, durMs?, ok?, note? }
 * t 由调用方传入（epoch ms）；d 可选（"YYYY-MM-DD"），带 d 时面板才能精确按日归集。返回传入的 cost。
 */
export function pushEvent(cost, ev, cap = 500) {
  const c = ensureCost(cost);
  const limit = Math.max(1, Math.floor(toNum(cap) || 500));
  const src = ev && typeof ev === "object" && !Array.isArray(ev) ? ev : {};
  const out = { t: toNum(src.t) };
  for (const k of Object.keys(EVENT_STR)) {
    if (typeof src[k] !== "string" || src[k] === "") continue;
    out[k] = src[k].slice(0, EVENT_STR[k]);
  }
  for (const k of EVENT_NUM) if (src[k] !== undefined) out[k] = toNum(src[k]);
  c.events.push(out);
  if (c.events.length > limit) c.events.splice(0, c.events.length - limit);
  return c;
}

/**
 * daily 滚动清理：保留最近 keepDays 天（含 todayKey 当天）。例：todayKey=2026-11-02、keepDays=30 →
 * 保留 2026-10-04 ~ 2026-11-02，更早的日期键删除。todayKey 缺失/非法 → 不动账本（时间绝不猜）；
 * 不认识的历史键保留（不毁灭未知数据）。返回传入的 cost。
 */
export function pruneDaily(cost, keepDays = 30, todayKey) {
  const c = ensureCost(cost);
  const keep = Math.max(1, Math.floor(toNum(keepDays) || 30));
  const todayMs = parseDateKey(todayKey);
  if (todayMs === null) return c;
  const cutoff = todayMs - (keep - 1) * DAY_MS;
  for (const key of Object.keys(c.daily)) {
    const ms = parseDateKey(key);
    if (ms === null) continue;
    if (ms < cutoff) delete c.daily[key];
  }
  return c;
}

// ── 汇总（面板消费） ──────────────────────────────────────────────────────

/** map（totals 或 daily[date]）→ 13 环节补零记录 + 派生 avgDurMs / 合计 */
function collectKinds(map) {
  const kinds = {};
  let totalEst = 0, totalN = 0;
  const src = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  for (const k of KIND_LIST) {
    const raw = src[k] && typeof src[k] === "object" ? src[k] : {};
    const rec = {};
    for (const f of KIND_FIELDS[k]) rec[f] = toNum(raw[f]);
    // host* 三个桶记的是「宿主轮次」，不是插件记账次数 ⇒ 不计入 totalN（面板「次数」列口径）
    const isHost = k === "hostUsage" || k === "hostMain" || k === "hostSub";
    const n = isHost ? (rec.turns || rec.n) : rec.n;
    rec.avgDurMs = n > 0 ? Math.round(rec.durMs / n) : 0;
    kinds[k] = rec;
    totalEst += toNum(rec.estTokens);   // 多数环节无 estTokens 字段（toNum 归零，防 NaN 传染）
    if (!isHost) totalN += n;
  }
  return { kinds: kinds, totalEst: totalEst, totalN: totalN };
}

/** 真实 usage 段（仅 hostUsage 有；来自宿主 assistant/message.usage，§5.1） */
function realOf(rec) {
  const r = rec && typeof rec === "object" ? rec : {};
  const inTokens = toNum(r.inTokens), outTokens = toNum(r.outTokens);
  const cacheRead = toNum(r.cacheRead), cacheWrite = toNum(r.cacheWrite);
  // [2026-11-02 口径修正] 宿主 usage.totalTokens 是**每轮上下文快照**（实测子代理 90 轮：10万→27.6万递增），
  //   累加 N 轮得到的是「上下文总量之和」而非消耗（90 轮累加 1870 万 vs 真实消耗 22.9 万，虚高约 80 倍）。
  //   统一改为**计费口径消耗** = 未命中缓存的输入 + 输出；cacheRead 单独返回（0.1x 单价，不并入消耗）。
  const totalTokens = inTokens + outTokens;
  // turns：历史 hostUsage 用 turns 字段；hostMain/hostSub 用 n 当轮次（KIND_FIELDS 里没 turns）
  const turns = toNum(r.turns) || toNum(r.n);
  return { inTokens: inTokens, outTokens: outTokens, cacheRead: cacheRead, cacheWrite: cacheWrite, totalTokens: totalTokens, turns: turns };
}

function estMapOf(kinds) {
  const out = {};
  for (const k of KIND_LIST) out[k] = toNum(kinds[k] && kinds[k].estTokens);
  return out;
}

function failOf(kinds) {
  const out = { total: 0, byKind: {} };
  for (const k of KIND_LIST) {
    const r = kinds[k] || {};
    const f = toNum(r.fail), rt = toNum(r.retry), to = toNum(r.timeout);
    if (f || rt || to) { out.byKind[k] = { fail: f, retry: rt, timeout: to }; out.total += f; }
  }
  return out;
}

function matchTrigger(note) {
  if (typeof note !== "string") return null;
  const m = /^(T[1-6])\b/.exec(note.trim());
  return m ? m[1] : null;
}

/**
 * 触发档位计数（T1/T2/T3=阈值，T4=压缩，T5=收尾，T6=漏网）。dateKey 给定时：事件带 d 的严格按 d
 * 过滤；全部事件都不带 d 时退化为「最近窗口全量」（计入 other）；strict=true（趋势图）时无 d 事件不计。
 */
function triggersOf(events, dateKey, strict) {
  const out = { total: 0, other: 0 };
  for (const lv of TRIGGER_LEVELS) out[lv] = 0;
  for (const ev of events) {
    if (!ev || ev.kind !== "checkpointWrite") continue;
    if (dateKey) {
      if (typeof ev.d === "string") { if (ev.d !== dateKey) continue; }
      else if (strict) continue;
    }
    const lv = TRIGGER_LEVELS.indexOf(ev.trigger) >= 0 ? ev.trigger : matchTrigger(ev.note);
    if (lv) { out[lv] += 1; out.total += 1; } else out.other += 1;
  }
  return out;
}

function buildTrend(cost, todayKey, days) {
  const out = [];
  if (todayKey === null) return out;
  const end = parseDateKey(todayKey);
  for (let i = days - 1; i >= 0; i--) {
    const key = fmtDateKey(end - i * DAY_MS);
    const col = collectKinds(cost.daily[key] || {});
    out.push({ date: key, estTokens: col.totalEst, n: col.totalN, real: realOf(col.kinds.hostSub).totalTokens, triggers: triggersOf(cost.events, key, true).total });
  }
  return out;
}

function buildTopSessions(events, topN, dateKey) {
  const hasD = events.some((e) => e && typeof e.d === "string");
  const map = new Map();
  for (const ev of events) {
    if (!ev || ev.kind !== "checkpointWrite") continue;
    if (dateKey && hasD && ev.d !== dateKey) continue;
    const sid = typeof ev.sid === "string" && ev.sid ? ev.sid : "（未知会话）";
    let a = map.get(sid);
    if (!a) { a = { sid: sid, n: 0, inChars: 0, outChars: 0, estTokens: 0, durMs: 0, fail: 0 }; map.set(sid, a); }
    a.n += 1;
    a.inChars += toNum(ev.inChars);
    a.outChars += toNum(ev.outChars);
    a.estTokens += toNum(ev.estTokens);
    a.durMs += toNum(ev.durMs);
    a.fail += toNum(ev.fail);
  }
  const list = [];
  map.forEach((v) => list.push(v));
  list.sort((a, b) => (b.estTokens - a.estTokens) || (b.inChars - a.inChars) || (b.n - a.n));
  return list.slice(0, topN);
}

/**
 * 面板用汇总（§5.4）。opts：{ todayKey?, days=7, topN=5, events=20 }（todayKey 缺省 → today 空态、trend 空）。
 * 返回 { version, since, todayKey, today, cumulative, byKind, trend, trend7d, topSessions, events, limits, kindList }：
 *   today/cumulative = { n, real, est:{byKind,total}, kinds, triggers, fails }
 *   byKind（=today.kinds）= 今日 13 环节完整记录（含 avgDurMs），分环节表直接用；
 *   trend = 最近 days 天升序（缺日补零）；trend7d = 固定 7 天；topSessions = 按检查点写入估算 tokens 排序。
 */
export function summarize(cost, opts) {
  const c = ensureCost(cost);
  const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  const todayKey = isDateKey(o.todayKey) ? o.todayKey : null;
  const days = clampInt(o.days, 7, 1, 90);
  const topN = clampInt(o.topN, 5, 1, 50);
  const recentN = clampInt(o.events, 20, 0, 200);
  const cum = collectKinds(c.totals);
  const day = collectKinds(todayKey !== null ? (c.daily[todayKey] || {}) : {});
  return {
    version: c.version,
    since: c.since,
    todayKey: todayKey,
    today: {
      dateKey: todayKey,
      n: day.totalN,
      real: realOf(day.kinds.hostSub),            // 插件真实成本 = 子代理 usage
      realMain: realOf(day.kinds.hostMain),       // 对照：用户对话消耗（非插件开销）
      realLegacy: realOf(day.kinds.hostUsage),    // 历史混合桶（口径拆分前）
      est: { byKind: estMapOf(day.kinds), total: day.totalEst },
      kinds: day.kinds,
      triggers: triggersOf(c.events, todayKey, false),
      fails: failOf(day.kinds)
    },
    cumulative: {
      n: cum.totalN,
      real: realOf(cum.kinds.hostSub),
      realMain: realOf(cum.kinds.hostMain),
      realLegacy: realOf(cum.kinds.hostUsage),
      est: { byKind: estMapOf(cum.kinds), total: cum.totalEst },
      kinds: cum.kinds,
      fails: failOf(cum.kinds)
    },
    byKind: day.kinds,                              // 面板便捷别名（今日分环节完整记录）
    trend: buildTrend(c, todayKey, days),
    trend7d: buildTrend(c, todayKey, 7),            // 面板便捷别名（固定 7 天口径）
    topSessions: buildTopSessions(c.events, topN, todayKey),
    events: recentN > 0 ? c.events.slice(Math.max(0, c.events.length - recentN)) : [],
    limits: c.limits,
    kindList: KIND_LIST.slice()
  };
}
