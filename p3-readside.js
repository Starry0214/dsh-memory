/**
 * p3-readside.js —— P3-2 读侧文本装配（R1 启动纪律头 / 上会话桥接 / R3 每 N 轮轻提醒）
 *
 * 设计依据：`.task/1101-dsh-mimo-survey/13-p3-design.md` §3（读侧三层）与 §3.1（R1 必须带「已加载纪律」）
 *
 * 本文件只做**纯文本装配**，接线（读库/选上一会话/注入走 agent.inject）由 index.js 负责：
 *   - R1 会话启动：①读取纪律 ②当前会话检查点续接 ③上一个会话桥接 ④项目记忆 ⑤用户画像
 *   - R3 每 everyN(=8) 轮：≤200 字轻提醒（「如需历史细节可 memory_search：<topicHint>」）
 *
 * 硬纪律：
 *   - **纯函数**：不读盘、不发网络、不依赖系统时钟（会话年龄由调用方以 ageHours 传入）。无任何 import。
 *   - **纪律头永不丢**：超预算只按「画像 → 项目记忆 → 上会话桥接」倒序整段丢；都丢完仍超才按行边界截检查点。
 *   - **每段带小标题 + 段间空行**：模型要能区分来源（纪律/检查点/上会话/项目/画像）。
 *   - **只在行边界截断**：绝不切半行（半句/半个精确字面量是记忆注入的硬伤）；仅首行自身超限才硬切兜底。
 *
 * 接线提示（index.js，Lead 负责）：
 *   - R1：`agent/created` 的 injectMode==="full" 分支（现有稳定层/项目记忆注入处），把返回的 `text`
 *     包进 `<system-reminder>` 注入；建议先 `buildPreviousSessionBridge({prevCheckpoint, wsKey, ageHours})`
 *     再把其 `.text` 作为 `previousBridge`（别名 sessionTopic/bridge）传给 buildStartupHeader。
 *   - R3：`session/event` 的 `turn/start` 累计 turn 后（与 Lead 约定：统一在事件分发器判，不开 pre-step）：
 *     `if (shouldNudge({turn, everyN: 8, lastNudgeTurn})) agent.inject(makeMessage(...buildRecallNudge({turn, topicHint})))`
 *     成功注入后把 lastNudgeTurn = turn（同一轮不重复）。
 */

/** 读侧三段注入的默认字符预算 */
export const READ_BUDGETS = Object.freeze({ startup: 6000, bridge: 1500, nudge: 200 });

/** R1 固定段序（title 用于装配小标题；key 用于 dropped 留痕/面板） */
const STARTUP_SECTIONS = Object.freeze([
  Object.freeze({ key: "discipline", title: "读取纪律" }),
  Object.freeze({ key: "checkpoint", title: "当前会话检查点" }),
  Object.freeze({ key: "bridge", title: "上一个会话桥接" }),
  Object.freeze({ key: "project", title: "项目记忆" }),
  Object.freeze({ key: "profile", title: "用户画像" }),
]);

/** 超预算倒序丢段（纪律头不在其中 ⇒ 永不丢） */
const DROP_ORDER = Object.freeze(["profile", "project", "bridge"]);

/** 段间分隔：空行 */
const SECTION_SEP = "\n\n";
/** 截断后低于此长度就不再保留正文（信息量太低，整段丢更干净） */
const MIN_BODY_CHARS = 60;
/** 默认轮询间隔 */
const DEFAULT_EVERY_N = 8;

/** R1 ①读取纪律（§3.1：先告诉模型「记忆已在上下文」，否则它会重复 read 整个记忆文件） */
const DISCIPLINE_TEXT = [
  "本块记忆由 dsh-memory 插件自动注入，已经在你上下文中——不要重复 read 整个记忆文件。",
  "1) 先看记忆再动手；有疑问先 memory_search（按主题名/关键词/精确字面量检索）再动手。",
  "2) 记忆是「当时的主张」，不是当前事实：引用前用现状核验（文件/命令/配置可能已变）。",
  "3) 与用户最新消息冲突时，一律以用户最新消息为准。",
  "4) 细节按需检索，不整文件重读（省 token 且保前缀缓存）。",
].join("\n");

/** R3 轻提醒固定文案（头/尾各一段，中间是检索指引） */
const NUDGE_HEAD = "【记忆轻提醒】记忆已在上下文（勿重复 read 整个记忆文件）；记忆是当时主张，用前验证。";
const NUDGE_TAIL = "与用户最新消息冲突时以其为准。";
const NUDGE_HINT_FALLBACK = "如需历史细节可 memory_search（用当前任务关键词/路径/文号精确检索）。";
const NUDGE_HINT_PREFIX = "如需历史细节可 memory_search：";
const NUDGE_HINT_MAX = 80;

// ────────────────────────────────────────────────────────────────────────────
// 内部工具（纯函数）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 宽容取文本：字符串原样；数组逐项拼接；对象取首个非空 text/body/md/checkpoint/content 字段。
 * 目的：接线方把 R2/检查点读取结果对象（{text,...}）直接传进来也不炸。
 */
function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    for (const k of ["text", "body", "md", "checkpoint", "content"]) {
      const t = toText(v[k]);
      if (t) return t;
    }
  }
  return "";
}

/** 归一化正文：CRLF→LF、去行尾空白、去首尾空行（不改写任何正文内容） */
function normText(v) {
  return toText(v).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** 取首个「已提供」的字段值（用于别名；空串/空白不算提供） */
function pickFirst(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return v;
  }
  return "";
}

/** 预算归一：非法/非正 ⇒ 默认值；否则取整并夹到 [1, max] */
function clampBudget(v, dflt, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(1, Math.min(Number.isFinite(max) && max > 0 ? max : 100000, Math.floor(n)));
}

/** 轮次归一：非法 ⇒ null；否则非负整数 */
function normTurn(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** everyN 归一：缺省 ⇒ 8；非法 ⇒ 8；非正 ⇒ 原样返回（调用方据此判定"关闭"） */
function normEveryN(v) {
  if (v == null || v === "") return DEFAULT_EVERY_N;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_EVERY_N;
  return Math.floor(n);
}

/** 会话年龄文案：<1h ⇒「不到 1 小时前」；<24h ⇒「N 小时前」；否则「N 天前」；缺省/非法 ⇒ ""（不标注） */
export function formatAgeHours(ageHours) {
  if (ageHours == null || ageHours === "") return "";
  const h = Number(ageHours);
  if (!Number.isFinite(h) || h < 0) return "";
  if (h < 1) return "不到 1 小时前";
  if (h < 24) return Math.floor(h) + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

/**
 * 按行装填到 cap 字符（只装完整行）。首行自身就超 cap 时才硬切（唯一兜底，避免死循环）。
 * @returns {{text: string, cut: boolean}}
 */
function fitLines(text, cap) {
  const s = String(text == null ? "" : text);
  const c = Math.max(0, Math.floor(Number(cap) || 0));
  if (!s) return { text: "", cut: false };
  if (s.length <= c) return { text: s, cut: false };
  if (c <= 1) return { text: "", cut: true };
  let out = "";
  for (const ln of s.split("\n")) {
    const add = (out ? "\n" : "") + ln;
    if (out.length + add.length <= c) { out += add; continue; }
    if (!out) out = ln.slice(0, Math.max(1, c - 1)).replace(/[ \t]+$/g, "") + "…";
    break;
  }
  if (out.length > c) out = out.slice(0, c);
  return { text: out, cut: out.length < s.length };
}

/** 装配 R1：段间空行，每段 `【小标题】` + 换行 + 正文 */
function renderStartup(emit) {
  return emit.map((s) => "【" + s.title + "】\n" + s.body).join(SECTION_SEP);
}

// ────────────────────────────────────────────────────────────────────────────
// R1：启动纪律头
// ────────────────────────────────────────────────────────────────────────────

/**
 * R1 启动纪律头：固定段序 ①纪律 ②当前会话检查点续接 ③上一个会话桥接 ④项目记忆 ⑤用户画像。
 *
 * @param {object} [opts]
 * @param {string|object} [opts.checkpoint]      当前会话检查点正文（8 节 markdown；可传 {text} 对象）
 * @param {string|object} [opts.previousBridge]  上一个会话桥接正文（= buildPreviousSessionBridge().text）
 * @param {string|object} [opts.sessionTopic]    别名：上会话桥接（兼容用；P2.5 当前会话主题走 checkpoint）
 * @param {string|object} [opts.bridge]          别名：上会话桥接（兼容用）
 * @param {string|object} [opts.projectMemory]   项目记忆正文
 * @param {string|object} [opts.profileText]   用户画像正文（global.md 切片）
 * @param {number} [opts.budgetChars]          总预算，默认 READ_BUDGETS.startup(=6000)
 * @returns {{text: string, sections: Array<{name: string, key: string, chars: number, bodyChars: number}>,
 *            dropped: string[], chars: number, budget: number}}
 *
 * 超预算行为（严格按设计 §3/任务书）：倒序整段丢「profile → project → bridge」，纪律头永不丢；
 * 三段都丢完仍超预算 ⇒ 按行边界截「checkpoint」，截不下（预留 < MIN_BODY_CHARS）则整段丢。
 * dropped 取值：profile | project | bridge | checkpoint | checkpoint:truncated。
 * 极端预算（小于纪律头自身长度）时仍返回纪律头（此时 chars 可 > budget），保证"永不丢纪律"。
 */
export function buildStartupHeader(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const budget = clampBudget(o.budgetChars, READ_BUDGETS.startup, 100000);
  const bodies = {
    discipline: DISCIPLINE_TEXT,
    checkpoint: normText(pickFirst(o, ["checkpoint", "sessionCheckpoint", "currentCheckpoint"])),
    bridge: normText(pickFirst(o, ["previousBridge", "bridge", "sessionTopic", "bridgeText", "prevSession", "previousSession"])),
    project: normText(pickFirst(o, ["projectMemory", "project"])),
    profile: normText(pickFirst(o, ["profileText", "profile", "globalText", "profileMd"])),
  };
  // 纪律头恒在；其余段有正文才装配
  let emit = STARTUP_SECTIONS
    .map((s) => ({ key: s.key, title: s.title, body: bodies[s.key] || "" }))
    .filter((s) => s.key === "discipline" || s.body !== "");
  const dropped = [];
  let text = renderStartup(emit);

  // ① 超预算：倒序整段丢（画像 → 项目记忆 → 上会话桥接）；纪律头以下三段的顺序固定
  for (const key of DROP_ORDER) {
    if (text.length <= budget) break;
    const i = emit.findIndex((s) => s.key === key);
    if (i < 0) continue;
    emit.splice(i, 1);
    dropped.push(key);
    text = renderStartup(emit);
  }

  // ② 仍超：截「当前会话检查点」（行边界）；纪律头保持原样
  if (text.length > budget) {
    const cp = emit.find((s) => s.key === "checkpoint");
    if (cp) {
      const othersText = renderStartup(emit.filter((s) => s.key !== "checkpoint"));
      const sepLen = othersText ? SECTION_SEP.length : 0;
      const cap = budget - othersText.length - sepLen - ("【" + cp.title + "】\n").length;
      let kept = false;
      if (cap >= MIN_BODY_CHARS) {
        const fit = fitLines(cp.body, cap);
        if (fit.text) { cp.body = fit.text; kept = true; dropped.push("checkpoint:truncated"); }
      }
      if (!kept) {
        emit = emit.filter((s) => s.key !== "checkpoint");
        dropped.push("checkpoint");
      }
      text = renderStartup(emit);
    }
  }

  const sections = emit.map((s) => {
    const rendered = "【" + s.title + "】\n" + s.body;
    return { name: s.title, key: s.key, chars: rendered.length, bodyChars: s.body.length };
  });
  return { text: text, sections: sections, dropped: dropped, chars: text.length, budget: budget };
}

// ────────────────────────────────────────────────────────────────────────────
// R1-③：上一个会话桥接
// ────────────────────────────────────────────────────────────────────────────

/**
 * 上一个会话的桥接段（≤1500 字，首行「（上一个会话 · N 小时前）」）。
 * 选「同 wsKey 的最近一个别的会话」是调用方职责（wsKey 只做接口占位，不参与文本 —— 避免把工作区名注入）。
 *
 * @param {object} [opts]
 * @param {string|object} [opts.prevCheckpoint] 上一个会话的检查点正文（可传 {text} 对象）
 * @param {string} [opts.wsKey]                 工作区键（选择逻辑在调用方；文本不打印）
 * @param {number} [opts.ageHours]              距该会话最后活动的小时数（由调用方用当前时间算出）
 * @param {number} [opts.budgetChars]           预算，默认 READ_BUDGETS.bridge(=1500)
 * @returns {{text: string, dropped: string[], chars: number, budget: number, ageLabel: string}}
 *
 * 无上会话 / 正文为空 ⇒ {text:"", chars:0}；正文超预算 ⇒ 按行边界截断并留痕 bridge:truncated；
 * 预算小到连正文一行都放不下 ⇒ 返回空（dropped: bridge:empty），不输出「只有标题」的噪声段。
 */
export function buildPreviousSessionBridge(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const budget = clampBudget(o.budgetChars, READ_BUDGETS.bridge, 100000);
  const raw = normText(pickFirst(o, ["prevCheckpoint", "prevSessionTopic", "previousSession", "prevText"]));
  const ageLabel = formatAgeHours(o.ageHours);
  const head = ageLabel ? "（上一个会话 · " + ageLabel + "）" : "（上一个会话）";
  if (!raw) return { text: "", dropped: [], chars: 0, budget: budget, ageLabel: ageLabel };
  const cap = budget - head.length - 1;   // 1 = 首行后的换行
  if (cap < MIN_BODY_CHARS) return { text: "", dropped: ["bridge:empty"], chars: 0, budget: budget, ageLabel: ageLabel };
  const fit = fitLines(raw, cap);
  if (!fit.text) return { text: "", dropped: ["bridge:empty"], chars: 0, budget: budget, ageLabel: ageLabel };
  const text = head + "\n" + fit.text;
  const dropped = [];
  if (fit.cut) dropped.push("bridge:truncated");
  return { text: text, dropped: dropped, chars: text.length, budget: budget, ageLabel: ageLabel };
}

// ────────────────────────────────────────────────────────────────────────────
// R3：每 N 轮轻提醒
// ────────────────────────────────────────────────────────────────────────────

/** topicHint 归一：压空白、去尾部标点、≤80 字（超长加省略号） */
function normHint(v) {
  const s = normText(v).replace(/\s+/g, " ").replace(/[。；;，,、\s]+$/g, "").trim();
  if (!s) return "";
  return s.length > NUDGE_HINT_MAX ? s.slice(0, NUDGE_HINT_MAX - 1) + "…" : s;
}

/**
 * R3 轻提醒文本：每 everyN(=8) 轮一次的 ≤200 字提示。
 * 轮次口径：turn>0 且 turn % everyN === 0 才提醒（turn=0 发生在会话启动、R1 已注入，不提醒）。
 * 「同一轮不重复」由 shouldNudge 配合 lastNudgeTurn 负责（本函数不持有状态）。
 *
 * @param {object} [opts]
 * @param {number} [opts.turn]       当前轮次（从 1 起；调用方体系自定，只需与 everyN 语义一致）
 * @param {number} [opts.everyN]     提醒间隔，默认 8；非正数 ⇒ 关闭（返回 null）
 * @param {string} [opts.topicHint]  检索提示（项目名/任务关键词）；为空则用降级文案
 * @returns {string|null} 提醒文本（调用方包 <system-reminder> 后注入）；不该提醒时 null
 */
export function buildRecallNudge(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const everyN = normEveryN(o.everyN);
  const turn = normTurn(o.turn);
  if (!(everyN > 0) || turn === null || turn <= 0) return null;
  if (turn % everyN !== 0) return null;
  const hint = normHint(o.topicHint);
  const mid = hint ? (NUDGE_HINT_PREFIX + hint + "。") : NUDGE_HINT_FALLBACK;
  let text = NUDGE_HEAD + mid + NUDGE_TAIL;
  const cap = READ_BUDGETS.nudge;
  if (text.length > cap && hint) {
    // 仅 hint 参与收缩：固定文案不动，保证「记忆已在上下文 / 用前验证」这一句永远在
    const fixed = (NUDGE_HEAD + NUDGE_HINT_PREFIX + "。" + NUDGE_TAIL).length;
    const keep = cap - fixed - 1;   // 1 = 省略号
    const short = keep > 0 ? hint.slice(0, keep).trim() + "…" : "";
    text = NUDGE_HEAD + (short ? (NUDGE_HINT_PREFIX + short + "。") : NUDGE_HINT_FALLBACK) + NUDGE_TAIL;
  }
  if (text.length > cap) text = text.slice(0, cap);   // 极端兜底（仅固定文案本身超 200 才会发生）
  return text;
}

/**
 * R3 轮次判定：是否该在本轮注入轻提醒。
 * 条件：everyN>0、turn>0、turn 是 everyN 的整数倍、且 lastNudgeTurn !== turn（同一轮不重复）。
 *
 * @param {object} [opts]
 * @param {number} [opts.turn]          当前轮次
 * @param {number} [opts.everyN]        提醒间隔，默认 8；非正数 ⇒ 关闭（false）
 * @param {number} [opts.lastNudgeTurn] 上次成功注入的轮次（无则 null/undefined）
 * @returns {boolean}
 */
export function shouldNudge(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const everyN = normEveryN(o.everyN);
  const turn = normTurn(o.turn);
  if (!(everyN > 0) || turn === null || turn <= 0) return false;
  if (turn % everyN !== 0) return false;
  const last = normTurn(o.lastNudgeTurn);
  return last === null || last !== turn;
}
