/**
 * dsh-memory · P2.5 会话记忆「存储层纯函数」
 * ============================================================================
 * 设计依据：`.task/1101-dsh-mimo-survey/12-p25-design.md`（B 物理族，用户 2026-11-02 拍板）
 *
 * 目标结构（主题库）：
 *   D8 域「日记忆（按天流水）」
 *   ├── 线「会话检查点」（历史日期流水的落点，保持不变）
 *   └── 线「会话检查点·<wsKey>」（**每个工作区一条 project 级线**，运行期新增）
 *       └── detail 主题「<wsKey>/<sid8>」（**每个会话一条，覆盖更新、恒 1 句**）
 *
 * 本文件硬约束（任务契约）：
 *   · 纯 ESM，**零第三方依赖**；不 import 任何模块（连 `node:` 内置也不 import）；
 *   · **不读盘、不连库、不读环境变量、不用 Date.now()**（时间一律由入参给）；
 *   · 所有函数确定性，可在 index.js 热路径与 `_verify/` 脚本里共用同一份口径。
 *
 * 接线提示（Lead 在 index.js 调用）：
 *   写侧（压缩检查点落库）：
 *     1) `wsKey = normalizeWorkspace(cwd)`；`sid8 = sid8Of(sessionId)`；
 *     2) 正文首行用 `buildCheckpointHeader({ compactionId, sessionId, cwd })` 生成
 *        （与历史 `## 检查点（目标与下一步，压缩 <cid8> · sid <sid8>）` 兼容，新增 `· cwd <cwd>`）；
 *     3) `lineName(wsKey)` 找/建工作区线；`sessionTopicName(wsKey, sid8)` 找/建会话 detail 主题；
 *        已存在 → `replaceSentence`（覆盖，恒 1 句），不存在 → `appendSentence`。
 *     4) 生命周期：`decideLifecycle({ archivedAt, createdAt, now, indexInLine, policy })`
 *        === "archived" 时调用 `store.archiveTopic`（正文留库 + 注入面移除 + 指针句）。
 *   读侧（注入）：
 *     1) `wsKey = normalizeWorkspace(cwd)`；在该 **线** 下按 `updatedAt` 找**另一个**会话的
 *        `parseSessionTopicName(name)` 命中的 detail 主题（上一个会话的检查点）；
 *     2) 本工作区没有 → 回退全库最近 1 条会话主题 → 再回退历史日期主题。
 *   迁移：`_verify/p25-migrate.mjs` 用 `extractCheckpointMeta` + `planMigration` 出计划。
 *
 * 命名与归一化约定（**唯一口径，读/写/迁移/面板都以此为准**）：
 *   · wsKey = `normalizeWorkspace(cwd)` = 盘符 + cwd 末两级目录，非法字符转 `-`；
 *     `E:\工具\插件开发调整` → `E-工具-插件开发调整`；空值/拿不到 → `unknown`。
 *   · 线名 = `会话检查点·<wsKey>`（历史线名「会话检查点」不带 `·`，两者不冲突）。
 *   · 会话主题名 = `<wsKey>/<sid8>`（sid8 = 会话 id 前 8 位小写十六进制）。
 *     允许尾部追加 ` · <标题>`（面板可读性用），`parseSessionTopicName` 会把它放进 `title`，
 *     但**唯一键一律是 (wsKey, sid8)**，标题不参与查找。
 */

export const P25_VERSION = 1;

/** 拿不到工作区时的 wsKey 兜底值（不是一个真实盘符路径） */
export const UNKNOWN_WS = "unknown";

/** 工作区线名前缀（注意：中间是中文间隔号 `·`，与历史线名「会话检查点」区分） */
export const LINE_PREFIX = "会话检查点·";

/** 历史 D8 线名（迁移来源；P2.5 之后只做兼容读取） */
export const LEGACY_LINE_NAME = "会话检查点";

/** D8 域名字面量（迁移脚本用它定位容器，只读用途） */
export const D8_DOMAIN_NAME = "日记忆（按天流水）";

/** 一天的毫秒数（30 天保留窗口按毫秒精确比较，不用「日粒度」近似） */
export const DAY_MS = 86400000;

/** 生命周期默认策略：归档后保留 30 天 / 每条线最多 100 个会话（先到者为准） */
export const DEFAULT_LIFECYCLE_POLICY = Object.freeze({ keepDays: 30, maxSessions: 100 });

/** planMigration 的 wsKey 来源（用于迁移报告与人工复核） */
export const WSKEY_SOURCE = Object.freeze({
  HINT: "hint",   // 调用方显式给 row.wsKey（迁移脚本据 workspace.json 解析，最高置信）
  CWD: "cwd",     // row.cwd 或正文 cwd 标记
  BODY: "body",   // 正文里多条盘符路径的公共前缀（保守启发式）
  NONE: "none",   // 拿不到 → unknown
});

/** planMigration → skipped[].reason 取值（迁移报告按此分类计数，勿随意改名） */
export const SKIP_REASON = Object.freeze({
  NO_CHECKPOINT: "no-checkpoint-marker",     // 不是检查点句（历史日期主题里的日摘要/导入正文等）
  NO_SID: "no-sid-marker",                   // 是检查点句但抓不到 sid（老格式/被截断）
  OLDER_DUPLICATE: "older-duplicate",        // 同一 sid 有更新的一句，旧句不迁
  UNCHANGED: "unchanged",                    // 目标会话主题已存在且正文一致（幂等）
  EXISTING_ONLY: "existing-only",            // 已是 P2.5 会话主题，但没有待迁移的新内容
  UNKNOWN_EXCLUDED: "unknown-excluded",      // wsKey 未知，且调用方要求排除 unknown
  INVALID_EXISTING: "invalid-existing-name", // existing 里的名字不是合法会话主题名
  DUPLICATE_TARGET: "duplicate-target",      // existing 里同一 sid 出现多个主题（异常库）
});

// ───────────────────────────── 内部工具（不导出） ─────────────────────────────

/** 路径分隔符统一为 `\`（Windows 口径；POSIX 路径也按段处理） */
const RE_SEP_RUN = /[\\/]+/g;
/** 主题名非法字符：路径分隔符、Windows 保留字符、空白（含全角空格 U+3000）、控制字符 */
const RE_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f\s\u3000]+/g;
const RE_DRIVE_HEAD = /^([A-Za-z]):(?=[\\/]|$)/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_SID8 = /^[0-9a-f]{8}$/;

/**
 * 单段消毒：非法字符 → `-`，折叠连续 `-`，去首尾 `-`。
 * `_` `.` 与中文（含中文标点 `、`「」（）等）保留 —— 主题名/线名可读性优先，
 * 只有会破坏「`<wsKey>/<sid8>`」解析或文件名安全的字符才替换。
 */
function sanitizeSegment(seg) {
  return String(seg == null ? "" : seg)
    .replace(RE_ILLEGAL, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 把任意输入收敛成合法 wsKey（容错：误传 cwd 时自动归一；空 → unknown） */
function coerceWsKey(wsKey) {
  const s = String(wsKey == null ? "" : wsKey).trim();
  if (!s) return UNKNOWN_WS;
  // 误传完整 cwd / 带分隔符的路径 → 按工作区口径归一（例如 "E:\\工具\\插件开发调整"）
  if (RE_DRIVE_HEAD.test(s) || /[\\/]/.test(s)) {
    const k = normalizeWorkspace(s);
    return k || UNKNOWN_WS;
  }
  const clean = sanitizeSegment(s);
  return clean || UNKNOWN_WS;
}

/** 时间戳统一成毫秒：number（<1e11 视为秒）| Date | ISO 字符串 | 数字字符串；非法 → null */
function toMs(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** 正文比较口径：去首尾空白 + 统一换行（覆盖更新时判「是否真的变了」） */
function normBody(text) {
  return String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** 从一行文本里剥掉包裹引号/反引号与行尾噪声，得到路径 token */
function cleanPathToken(v) {
  let s = String(v == null ? "" : v).trim();
  s = s.replace(/^[`"'“”‘’（(【\[]+/, "");
  s = s.replace(/[`"'“”‘’】\]]+$/, "");
  s = s.replace(/[。，,；;、]+$/, "");
  return s.trim();
}

/** sid 原始 token 归一：uuid → 完整小写；其它 → 去 `session-` 前缀的小写 token */
function normalizeSidToken(token) {
  let s = String(token == null ? "" : token).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^session[-_]/, "");
  return s;
}

// ───────────────────────────── 1. 工作区归一化 ─────────────────────────────

/**
 * cwd → 工作区短标识 wsKey（**盘符 + 末两级目录**，非法字符转 `-`）。
 *
 * 例：
 *   `E:\工具\插件开发调整`                → `E-工具-插件开发调整`
 *   `e:/工具/插件开发调整/`               → `E-工具-插件开发调整`
 *   `E:\工具\插件开发调整\dsh-memory-plugin` → `E-插件开发调整-dsh-memory-plugin`（字面「末两级」）
 *   `E:\工具`                            → `E-工具`
 *   `E:\`                                → `E`
 *   `""` / null / undefined              → `""`（**空串**，调用方用 `UNKNOWN_WS` 兜底）
 *   `\\server\share\a\b`（UNC）           → `server-a-b`
 *
 * 说明：
 *   · 盘符统一大写（`e:` 与 `E:` 归一到同一个 wsKey，避免大小写分族）；
 *   · 目录名大小写**保留**（Windows 路径不区分大小写，但主题库归一化会统一小写，
 *     这里保留原样只为面板可读性）；
 *   · `%USERPROFILE%`/`~` 等**不展开**（纯函数不读环境）。
 *
 * @param {string|null|undefined} cwd 会话工作目录（绝对路径最稳）
 * @returns {string} wsKey；输入不可用时返回 `""`
 */
export function normalizeWorkspace(cwd) {
  const raw0 = String(cwd == null ? "" : cwd).trim();
  if (!raw0) return "";
  let raw = raw0.replace(RE_SEP_RUN, "\\").replace(/\\+$/g, "");
  if (!raw) return "";
  let prefix = "";
  let rest = raw;
  const dm = RE_DRIVE_HEAD.exec(raw);
  if (dm) {
    prefix = dm[1].toUpperCase();
    rest = raw.slice(dm[0].length).replace(/^\\+/, "");
  } else if (/^[\\/]{2}/.test(raw0)) {
    // UNC：\\server\share\... —— host 当盘符位，丢弃 share 本身（保留末两级目录语义）
    const segs = raw0.split(RE_SEP_RUN).filter(Boolean);
    prefix = sanitizeSegment(segs[0] || "");
    rest = segs.slice(2).join("\\");
  } else {
    rest = raw.replace(/^\\+/, "");
  }
  const segs = rest
    .split("\\")
    .map((x) => x.trim())
    .filter((x) => x && x !== "." && x !== "..");
  const tail = segs.slice(-2);
  const parts = [];
  if (prefix) parts.push(sanitizeSegment(prefix));
  for (const t of tail) parts.push(sanitizeSegment(t));
  const key = parts.filter(Boolean).join("-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return key;
}

// ───────────────────────────── 2. 主题命名 ─────────────────────────────

/**
 * 工作区线名：`会话检查点·<wsKey>`（B 物理族：每个工作区一条 project 级线）。
 * wsKey 为空 → `会话检查点·unknown`（**绝不**退化成历史线名「会话检查点」，避免历史流水与新族混写）。
 */
export function lineName(wsKey) {
  return LINE_PREFIX + coerceWsKey(wsKey);
}

/**
 * 会话主题名：`<wsKey>/<sid8>`（每会话一条 detail 主题，覆盖更新、恒 1 句）。
 * 非法输入：sid8 归一后不是 8 位合法十六进制 → 返回 `""`（调用方据此跳过，不要瞎造名字）。
 */
export function sessionTopicName(wsKey, sid8) {
  const s = sid8Of(sid8);
  if (!s) return "";
  return coerceWsKey(wsKey) + "/" + s;
}

/**
 * 是否 P2.5 会话主题名（`<wsKey>/<sid8>`，允许尾部 ` · 标题`）。
 * 反例：`2026-11-01`（历史日期主题）、`会话检查点`（线）、`会话检查点·E-工具-X`（线）都为 false。
 */
export function isSessionTopicName(name) {
  return parseSessionTopicName(name) != null;
}

/**
 * 解析 P2.5 会话主题名 → `{ wsKey, sid8, title }`；不匹配 → `null`。
 *
 * 说明：唯一键是 `(wsKey, sid8)`；` · <标题>` 只是展示装饰（面板/可读性），
 * 查找时永远用 wsKey + sid8，不要用整名做唯一性判断。
 */
export function parseSessionTopicName(name) {
  const raw = String(name == null ? "" : name).trim();
  if (!raw) return null;
  const m = /^([^\s/\\]{1,200})\/([0-9a-f]{8})(?:\s*[·・]\s*([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const title = m[3] == null ? null : String(m[3]).trim() || null;
  return { wsKey: m[1], sid8: m[2], title: title };
}

/**
 * 会话 id（完整 uuid / `session-<uuid>` / 已是 sid8 / 12 位前缀）→ sid8（8 位小写十六进制）。
 * 无法识别（如 `anon`、空值）→ `""`。
 *
 * 与 index.js 现有口径对齐：`String(sessionId || "anon").replace(/^session-/, "").slice(0, 8)`，
 * 但额外要求结果必须是合法十六进制 —— 否则宁可不建会话主题（回退历史日期主题）。
 */
export function sid8Of(sessionId) {
  const s = normalizeSidToken(sessionId);
  if (!s) return "";
  if (RE_UUID.test(s)) return s.slice(0, 8);
  if (RE_SID8.test(s)) return s;
  // 12 位 sid 前缀 / 更长 token：取前 8 位（与 index.js 现行 slice(0,8) 口径一致）
  const m = /^([0-9a-f]{8})/.exec(s);
  if (m) return m[1];
  return "";
}

// ───────────────────────────── 3. 检查点标记解析/生成 ─────────────────────────────

/**
 * 生成检查点正文首行（写侧用；与历史格式兼容，新增可选 `· cwd <cwd>`）。
 *
 * 历史格式（必须兼容，库里 47 句存量）：
 *   `## 检查点（目标与下一步，压缩 <cid8> · sid <sid8>）`
 * P2.5：
 *   `## 检查点（目标与下一步，压缩 <cid8> · sid <sid8> · cwd <cwd>）`
 *
 * @returns {string} 首行；compactionId/sessionId 都拿不到 → `""`
 */
export function buildCheckpointHeader(opts) {
  const o = opts || {};
  const cid = String(o.compactionId == null ? "" : o.compactionId).trim();
  const cid8 = cid ? cid.slice(0, 8).toLowerCase() : "";
  const sid8 = sid8Of(o.sessionId != null ? o.sessionId : (o.sid8 != null ? o.sid8 : o.sid));
  const cwd = String(o.cwd == null ? "" : o.cwd).trim();
  const inner = [];
  if (cid8) inner.push("压缩 " + cid8);
  if (sid8) inner.push("sid " + sid8);
  if (cwd) inner.push("cwd " + cwd);
  if (!inner.length) return "";
  return "## 检查点（目标与下一步，" + inner.join(" · ") + "）";
}

/** 是否检查点正文（只认 `## 检查点` 开头/首行；用于迁移时区分日摘要等普通句） */
export function isCheckpointText(text) {
  return /^##\s*检查点/.test(String(text == null ? "" : text).trim());
}

/**
 * 从检查点正文里抽 `{ cid8, sid8, sid, cwd, wsKey, how }`；抓不到 sid → `null`。
 *
 * 兼容三种存量/新写法（见真实库取证）：
 *   ① 标准头：`## 检查点（目标与下一步，压缩 0dbc5756 · sid 1b736c53）`
 *   ② 全角/冒号变体：`… 压缩 xxxx · sid：xxxx`、`· cwd <path>` 追加
 *   ③ 行内/HTML 注释 marker：`sid:1b736c53`（`<!-- intent: <cid> sid:<sid8> -->` 被剥注释后的残留 === ①）
 *
 * `wsKey` 仅在正文里带得到 cwd 时给出（`normalizeWorkspace(cwd)`），否则为 `""`。
 * 注意：**不读盘、不查会话存储** —— 迁移脚本的工作区提示由调用方另行注入。
 */
export function extractCheckpointMeta(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return null;
  let cid = "";
  let sidRaw = "";
  let cwd = "";
  let how = "";
  // ① 标准头（可选 cwd 尾段；cwd 到右括号/换行为止）
  const mh = /压缩\s*[:：]?\s*([0-9A-Za-z_-]{4,64})\s*[·・]\s*sid\s*[:：]?\s*([0-9A-Za-z_-]{4,64})(?:\s*[·・]\s*cwd\s*[:：]?\s*([^）)\n\r]+))?/.exec(s);
  if (mh) {
    cid = mh[1];
    sidRaw = mh[2];
    cwd = mh[3] ? mh[3].trim() : "";
    how = "header";
  }
  // ② HTML 注释/行内 marker（`sid:<sid8>`；也兼容 `sid=<sid8>`）
  if (!sidRaw) {
    const mm = /(?:^|\n)\s*(?:<!--\s*)?(?:intent\s*:\s*)?[^\n]*?\bsid\s*[:=]\s*([0-9A-Za-z_-]{4,64})/.exec(s);
    if (mm) {
      sidRaw = mm[1];
      how = "marker";
    }
  }
  // ③ cwd 行（`cwd:` / `工作目录:` / `工作树:`）
  if (!cwd) {
    const mc = /(?:^|\n)\s*(?:>\s*)?(?:cwd|工作目录|工作树|项目根|仓库根)\s*[:：=]\s*([^\n\r]+)/i.exec(s);
    if (mc) cwd = cleanPathToken(mc[1]);
  }
  if (!cid) {
    const mc2 = /压缩\s*[:：]?\s*([0-9A-Za-z_-]{4,64})/.exec(s);
    if (mc2) cid = mc2[1];
  }
  if (!sidRaw) return null;
  const sid8 = sid8Of(sidRaw);
  if (!sid8) return null;
  const sidToken = normalizeSidToken(sidRaw);
  const sid = RE_UUID.test(sidToken) ? sidToken : sid8;
  const cid8 = cid ? cid.slice(0, 8).toLowerCase() : "";
  const wsKey = cwd ? normalizeWorkspace(cwd) : "";
  return { cid8, sid8, sid, cwd, wsKey, how };
}

/**
 * 从正文启发式推断工作区（**保守**：拿不到就返回 `""`，绝不猜）。
 *
 * 依据（只做两件事）：
 *   ① 显式标记（`cwd:` / `工作目录:` / `工作树:` / `项目根:` / `工作区:`）——最高置信；
 *   ② **≥2 条** Windows 盘符路径、且公共前缀恰好是「盘符 + 2 级目录」时，取公共前缀
 *      （对应 `E:\工具\插件开发调整` 这种工作区根）。
 * 其它情况（单条路径、公共前缀过浅/过深）一律返回 `""` → 迁移归 `unknown`。
 */
export function inferWorkspaceFromText(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  // ① 显式标记
  const mc = /(?:^|\n)\s*(?:>\s*)?(?:cwd|工作目录|工作树|项目根|仓库根|工作区)\s*[:：=]\s*([^\n\r]+)/i.exec(s);
  if (mc) {
    const k = normalizeWorkspace(cleanPathToken(mc[1]));
    if (k) return k;
  }
  // ② 多条盘符路径的公共前缀（只接受「盘符 + 2 级目录」== 3 段）
  const found = [];
  const re = /([A-Za-z]):[\\/][^\s"'`<>|*?，。；：、（）()\[\]【】\n\r]*/g;
  let m;
  while ((m = re.exec(s))) {
    const p = m[0].replace(/[.。;；,，:：)\]】]+$/, "");
    if (p.length > 3) found.push(p);
    if (found.length >= 48) break;
  }
  const uniq = [...new Set(found)];
  if (uniq.length < 2) return "";
  const lists = uniq.map((p) => p.replace(RE_SEP_RUN, "\\").replace(/\\+$/, "").split("\\").filter(Boolean));
  const first = lists[0] || [];
  const common = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (lists.every((l) => String(l[i] || "").toLowerCase() === seg.toLowerCase())) common.push(seg);
    else break;
  }
  if (common.length !== 3) return "";
  if (!/^[A-Za-z]:$/.test(common[0])) return "";
  // 尾段看起来像文件（带扩展名）说明公共前缀并没有落到目录上 ⇒ 不猜
  if (/\.[A-Za-z0-9]{1,8}$/.test(common[common.length - 1])) return "";
  return normalizeWorkspace(common.join("\\"));
}

// ───────────────────────────── 4. 生命周期 ─────────────────────────────

/**
 * 单个会话主题的生命周期判定。
 *
 * 规则（用户 2026-11-02 拍板）：
 *   · **会话被归档后 30 天** → archived（**从「归档时点」起算**，不是创建/最后写入时点）；
 *   · **该线第 100 个会话**（硬上限 100，先到者为准）→ archived；
 *   · 两条命中任一即 archived；都不到 → active。
 *
 * `indexInLine` 语义（**重要，接线别传反**）：
 *   = 该会话在这条线里的**名次（1 = 最新）**。上限 100 ⇒ `indexInLine <= 100` 保留，
 *   **第 101 名起**归档（对应设计验收「造 101 个会话后，最旧的被 archiveTopic」，稳态留 100 条）。
 *   若调用方只有「从最旧数起」的序号，请先换算：`indexInLine = total - ordinalFromOldest + 1`。
 *
 * 边界口径（自测已固化）：
 *   · `now - archivedAt === 30*86400000` → **archived**（`>=`，30 天整算到期）；
 *   · `indexInLine === 100` → active；`101` → archived；
 *   · `archivedAt` 缺失/非法 → **不按时间归档**（即便 createdAt 很老；不允许拿创建时间顶替）；
 *   · `policy.anchor === "created"` 是显式逃生口（仅调试/演练用），默认不启用。
 *
 * @param {{archivedAt?: number|string|Date|null, createdAt?: number|string|Date|null,
 *          now?: number|string|Date, indexInLine?: number|null,
 *          policy?: {keepDays?: number, maxSessions?: number, anchor?: "archived"|"created"}}} input
 * @returns {"active"|"archived"}
 */
export function decideLifecycle(input) {
  const o = input || {};
  const pol = Object.assign({}, DEFAULT_LIFECYCLE_POLICY, o.policy || {});
  const keepDaysRaw = pol.keepDays == null ? NaN : Number(pol.keepDays);
  const maxSessionsRaw = pol.maxSessions == null ? NaN : Number(pol.maxSessions);
  const keepDays = Number.isFinite(keepDaysRaw) ? Math.max(0, keepDaysRaw) : DEFAULT_LIFECYCLE_POLICY.keepDays;
  const maxSessions = Number.isFinite(maxSessionsRaw) ? Math.max(1, Math.floor(maxSessionsRaw)) : DEFAULT_LIFECYCLE_POLICY.maxSessions;
  const anchorMode = pol.anchor === "created" ? "created" : "archived";
  const nowParsed = toMs(o.now);
  // 未传 now ⇒ 取当前时间（本函数仍不读盘/不连库；测试请显式传 now 保证确定性）
  const nowMs = nowParsed == null ? Date.now() : nowParsed;
  const anchorVal = anchorMode === "created" ? o.createdAt : o.archivedAt;
  const anchor = toMs(anchorVal);
  if (anchor != null) {
    const age = nowMs - anchor;
    if (age >= keepDays * DAY_MS) return "archived";
  }
  const idx = o.indexInLine == null ? null : Number(o.indexInLine);
  if (idx != null && Number.isFinite(idx) && idx > maxSessions) return "archived";
  return "active";
}

// ───────────────────────────── 5. 覆盖率 ─────────────────────────────

/**
 * 会话→主题覆盖率（验收/面板用）：`{ total, covered, ratio, missing, byWs }`。
 *
 * @param {{sessions?: Array<string|{sid8?:string,sessionId?:string,sid?:string,id?:string,wsKey?:string}>,
 *          topics?: Array<string|{name?:string,sid8?:string,wsKey?:string}>}} input
 *   · sessions = 应当有会话主题的会话清单（字符串视为 sessionId/uid；对象取 sid8/sessionId/sid/id）
 *   · topics   = 现有主题清单（字符串视为主题名；对象取 name / sid8+wsKey）
 * 口径：只有能解析出合法 sid8 的 topic 才算「覆盖」；ratio 保留原始小数（total=0 → 0）。
 */
export function coverageOf(input) {
  const o = input || {};
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  const topics = Array.isArray(o.topics) ? o.topics : [];
  const coveredSet = new Set();
  const coveredByWs = new Map();
  for (const t of topics) {
    let sid8 = "";
    let wsKey = "";
    if (t && typeof t === "object") {
      sid8 = t.sid8 != null ? sid8Of(t.sid8) : "";
      wsKey = t.wsKey != null ? String(t.wsKey) : "";
      if (!sid8 && t.name != null) {
        const p = parseSessionTopicName(t.name);
        if (p) { sid8 = p.sid8; wsKey = p.wsKey; }
      }
    } else {
      const p = parseSessionTopicName(t);
      if (p) { sid8 = p.sid8; wsKey = p.wsKey; }
    }
    if (!sid8) continue;
    coveredSet.add(sid8);
    if (wsKey) coveredByWs.set(wsKey, (coveredByWs.get(wsKey) || 0) + 1);
  }
  const missing = [];
  const byWs = {};
  let covered = 0;
  for (const s of sessions) {
    let sid8 = "";
    let wsKey = "";
    if (s && typeof s === "object") {
      sid8 = s.sid8 != null ? sid8Of(s.sid8) : "";
      if (!sid8) sid8 = sid8Of(s.sessionId != null ? s.sessionId : (s.sid != null ? s.sid : s.id));
      wsKey = s.wsKey != null ? String(s.wsKey) : "";
    } else {
      sid8 = sid8Of(s);
    }
    const key = wsKey || "_";
    byWs[key] = byWs[key] || { total: 0, covered: 0 };
    byWs[key].total += 1;
    if (sid8 && coveredSet.has(sid8)) {
      covered += 1;
      byWs[key].covered += 1;
    } else {
      missing.push(sid8 || `?_${missing.length}`);
    }
  }
  const total = sessions.length;
  const ratio = total ? covered / total : 0;
  return {
    total,
    covered,
    ratio,
    missing,
    byWs,
    coveredTopics: coveredSet.size,
    topicsWithWs: coveredByWs,
  };
}

// ───────────────────────────── 6. 迁移计划（纯函数） ─────────────────────────────

/**
 * 生成**只新增、不删除原文**的迁移计划（不写库；dry-run 与 --apply 共用同一份计划）。
 *
 * 输入：
 *   rows      = 待迁移句子，`[{ topicName, body, updatedAt, [wsKey], [cwd], [topicId], [sentenceId] }]`
 *               —— 一条句子一个元素（历史：日期主题下的检查点句；本函数只读不写）。
 *   existing  = （可选）库里**已有**的 P2.5 会话主题，
 *               `[{ topicName, body, updatedAt }]`（也支持 `row.isExisting === true` 混在 rows 里）；
 *               用于把重复迁移判成 `update`（覆盖）或 `unchanged`（跳过），保证幂等。
 *   includeUnknown = （可选，默认 true）wsKey 拿不到时是否仍然建 `unknown/<sid8>`。
 *
 * 规则：
 *   1) 每个句子用 `extractCheckpointMeta` 抓 sid8；抓不到 ⇒ skipped（no-checkpoint-marker / no-sid-marker）。
 *   2) 同一 sid8 多句 ⇒ 只取**最新**（updatedAt 大者；相等时优先「wsKey 更确定」的一条，再按行序后者），
 *      其余 skipped（older-duplicate）——**不删除**旧句，旧句留在原日期主题。
 *   3) wsKey 取值优先级：row.wsKey（hint） > row.cwd / 正文 cwd > 正文启发式 > `unknown`。
 *   4) 目标主题名 = `sessionTopicName(wsKey, sid8)`；已有同 sid 主题时**以已有名为准**（防重名双写），
 *      正文一致 ⇒ skipped（unchanged），不一致 ⇒ update（覆盖）。
 *   5) 输出按 wsKey、sid8 排序（确定性，便于 diff 与报告）。
 *
 * 返回：
 *   {
 *     create: [{ wsKey, sid8, topicName, lineName, text, chars, wsKeySource, updatedAt,
 *                source: { topicName, topicId|null, sentenceId|null, cid8, updatedAtMs } }],
 *     update: [ 同上 + { previousText, previousSentenceId|null, previousUpdatedAtMs, wsKeyChanged } ],
 *     skipped: [{ reason, topicName, sid8?, sentenceId?, detail? }],
 *     unknownWs: [{ wsKey:"unknown", sid8, topicName, lineName, text, chars, updatedAt, source }],
 *     lines: [{ wsKey, lineName, sessions, create, update }],
 *     conflicts: [{ sid8, existingWsKey, plannedWsKey, topicName }],
 *     stats: { rows, legacyRows, sessionRows, markerRows, distinctSids, created, updated,
 *              skipped, skippedByReason, unknownSids, wsKeySources }
 *   }
 */
export function planMigration(input) {
  const o = input || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const existingIn = Array.isArray(o.existing) ? o.existing : [];
  const includeUnknown = o.includeUnknown !== false;

  const skipped = [];
  const skipCount = Object.create(null);
  const pushSkip = (reason, extra) => {
    skipped.push(Object.assign({ reason }, extra || {}));
    skipCount[reason] = (skipCount[reason] || 0) + 1;
  };

  /** 归一化输入行（不抛错；缺字段按空处理） */
  const normRow = (row, idx, sourceKind) => {
    const r = row && typeof row === "object" ? row : {};
    return {
      idx: idx,
      sourceKind: sourceKind, // "rows" | "existing"
      topicName: String(r.topicName != null ? r.topicName : (r.name != null ? r.name : "")).trim(),
      body: String(r.body != null ? r.body : (r.text != null ? r.text : "")),
      updatedAtMs: toMs(r.updatedAt != null ? r.updatedAt : (r.updated_at != null ? r.updated_at : r.updated_at_ms)),
      wsKeyHint: r.wsKey != null ? String(r.wsKey).trim() : "",
      cwdHint: r.cwd != null ? String(r.cwd).trim() : "",
      topicId: r.topicId != null ? r.topicId : null,
      sentenceId: r.sentenceId != null ? r.sentenceId : null,
      isExisting: sourceKind === "existing" || r.isExisting === true || r.kind === "session",
    };
  };

  const allRows = [];
  rows.forEach((r, i) => allRows.push(normRow(r, i, "rows")));
  existingIn.forEach((r, i) => allRows.push(normRow(r, rows.length + i, "existing")));

  // ── 已有会话主题（按 sid8 索引；同名多句取最新一句）──────────────────────
  const existingBySid = new Map();
  const existingNameOf = new Map();
  let sessionRows = 0;
  for (const r of allRows) {
    if (!r.isExisting) continue;
    sessionRows += 1;
    const parsed = parseSessionTopicName(r.topicName);
    if (!parsed) {
      pushSkip(SKIP_REASON.INVALID_EXISTING, { topicName: r.topicName, sentenceId: r.sentenceId });
      continue;
    }
    const prev = existingBySid.get(parsed.sid8);
    if (prev) {
      // 同一 sid 出现多个主题：保留首个（按出现顺序），其余报 duplicate-target
      if (prev.topicName !== r.topicName) {
        pushSkip(SKIP_REASON.DUPLICATE_TARGET, { topicName: r.topicName, sid8: parsed.sid8, sentenceId: r.sentenceId });
      } else if ((r.updatedAtMs || 0) > (prev.updatedAtMs || 0)) {
        prev.text = r.body;
        prev.updatedAtMs = r.updatedAtMs;
        prev.sentenceId = r.sentenceId;
      }
      continue;
    }
    existingBySid.set(parsed.sid8, {
      sid8: parsed.sid8,
      wsKey: parsed.wsKey,
      topicName: r.topicName,
      text: r.body,
      updatedAtMs: r.updatedAtMs,
      sentenceId: r.sentenceId,
      used: false,
    });
    existingNameOf.set(parsed.sid8, r.topicName);
  }

  // ── 历史句：按 sid8 取最新 ──────────────────────────────────────────────
  const legacy = new Map(); // sid8 -> entry
  const wsSourceCount = Object.create(null);
  let legacyRows = 0;
  let markerRows = 0;
  for (const r of allRows) {
    if (r.isExisting) continue;
    legacyRows += 1;
    const meta = extractCheckpointMeta(r.body);
    if (!meta) {
      pushSkip(isCheckpointText(r.body) ? SKIP_REASON.NO_SID : SKIP_REASON.NO_CHECKPOINT, {
        topicName: r.topicName, sentenceId: r.sentenceId,
      });
      continue;
    }
    markerRows += 1;
    let wsKey = "";
    let wsKeySource = WSKEY_SOURCE.NONE;
    if (r.wsKeyHint) {
      wsKey = coerceWsKey(r.wsKeyHint);
      wsKeySource = WSKEY_SOURCE.HINT;
    }
    if (!wsKey || wsKey === UNKNOWN_WS) {
      const c1 = r.cwdHint ? normalizeWorkspace(r.cwdHint) : "";
      const c2 = meta.wsKey || "";
      const c3 = c1 || c2;
      if (c3) { wsKey = c3; wsKeySource = WSKEY_SOURCE.CWD; }
    }
    if (!wsKey || wsKey === UNKNOWN_WS) {
      const c4 = inferWorkspaceFromText(r.body);
      if (c4) { wsKey = c4; wsKeySource = WSKEY_SOURCE.BODY; }
    }
    if (!wsKey) { wsKey = UNKNOWN_WS; wsKeySource = WSKEY_SOURCE.NONE; }
    const entry = {
      sid8: meta.sid8,
      wsKey: wsKey,
      wsKeySource: wsKeySource,
      cid8: meta.cid8,
      text: r.body,
      updatedAtMs: r.updatedAtMs,
      source: {
        topicName: r.topicName,
        topicId: r.topicId,
        sentenceId: r.sentenceId,
        cid8: meta.cid8,
        updatedAtMs: r.updatedAtMs,
      },
      idx: r.idx,
    };
    const prev = legacy.get(meta.sid8);
    if (!prev) { legacy.set(meta.sid8, entry); continue; }
    const prevKnown = prev.wsKey !== UNKNOWN_WS;
    const curKnown = entry.wsKey !== UNKNOWN_WS;
    const newer = (entry.updatedAtMs || 0) > (prev.updatedAtMs || 0);
    const sameTime = (entry.updatedAtMs || 0) === (prev.updatedAtMs || 0);
    const replace = newer || (sameTime && !prevKnown && curKnown) || (sameTime && prevKnown === curKnown && entry.idx > prev.idx);
    if (replace) {
      pushSkip(SKIP_REASON.OLDER_DUPLICATE, {
        topicName: prev.source.topicName, sid8: prev.sid8, sentenceId: prev.source.sentenceId, detail: "同一 sid 取更新的一句",
      });
      legacy.set(meta.sid8, entry);
    } else {
      pushSkip(SKIP_REASON.OLDER_DUPLICATE, {
        topicName: entry.source.topicName, sid8: entry.sid8, sentenceId: entry.source.sentenceId, detail: "同一 sid 取更新的一句",
      });
    }
  }

  // ── 逐 sid 出 create/update ────────────────────────────────────────────
  const create = [];
  const update = [];
  const unknownWs = [];
  const conflicts = [];
  const sids = [...legacy.keys()].sort();
  for (const sid8 of sids) {
    const e = legacy.get(sid8);
    const ex = existingBySid.get(sid8) || null;
    let wsKey = e.wsKey;
    let topicName = sessionTopicName(wsKey, sid8);
    let wsKeyChanged = false;
    if (ex) {
      ex.used = true;
      // 已存在的会话主题以「已有名」为准（防同一会话被双写）；若工作区变了，报冲突但不另建
      if (ex.wsKey && ex.wsKey !== wsKey) {
        wsKeyChanged = true;
        topicName = ex.topicName;
        if (ex.wsKey !== UNKNOWN_WS && wsKey !== UNKNOWN_WS) {
          conflicts.push({ sid8, existingWsKey: ex.wsKey, plannedWsKey: wsKey, topicName: ex.topicName });
        }
        wsKey = ex.wsKey;
      }
    }
    if (!topicName) {
      pushSkip(SKIP_REASON.NO_SID, { topicName: e.source.topicName, sid8, sentenceId: e.source.sentenceId });
      continue;
    }
    const base = {
      wsKey: wsKey,
      sid8: sid8,
      topicName: topicName,
      lineName: lineName(wsKey),
      text: normBody(e.text),
      chars: normBody(e.text).length,
      wsKeySource: e.wsKeySource,
      updatedAt: e.updatedAtMs,
      source: e.source,
    };
    wsSourceCount[e.wsKeySource] = (wsSourceCount[e.wsKeySource] || 0) + 1;
    if (ex) {
      if (normBody(ex.text) === normBody(e.text)) {
        pushSkip(SKIP_REASON.UNCHANGED, { topicName: ex.topicName, sid8, sentenceId: e.source.sentenceId });
        continue;
      }
      update.push(Object.assign({}, base, {
        previousText: normBody(ex.text),
        previousSentenceId: ex.sentenceId,
        previousUpdatedAtMs: ex.updatedAtMs,
        wsKeyChanged: wsKeyChanged,
      }));
    } else {
      if (wsKey === UNKNOWN_WS) {
        if (!includeUnknown) {
          pushSkip(SKIP_REASON.UNKNOWN_EXCLUDED, { topicName: e.source.topicName, sid8, sentenceId: e.source.sentenceId });
          continue;
        }
        unknownWs.push(Object.assign({}, base));
      }
      create.push(base);
    }
  }
  // 已有会话主题但没有对应历史句 ⇒ 无需动作（报告用）
  for (const [sid8, ex] of existingBySid) {
    if (!ex.used) pushSkip(SKIP_REASON.EXISTING_ONLY, { topicName: ex.topicName, sid8, sentenceId: ex.sentenceId });
  }

  // ── 线聚合 + 统计 ──────────────────────────────────────────────────────
  // 确定性排序：先按工作区线（wsKey），再按会话（sid8）——报告/diff 友好，且同计划每次一致
  const byWsSid = (a, b) => (a.wsKey < b.wsKey ? -1 : a.wsKey > b.wsKey ? 1 : a.sid8 < b.sid8 ? -1 : a.sid8 > b.sid8 ? 1 : 0);
  create.sort(byWsSid);
  update.sort(byWsSid);
  const lineMap = new Map();
  const bumpLine = (wsKey, kind) => {
    const k = wsKey || UNKNOWN_WS;
    if (!lineMap.has(k)) lineMap.set(k, { wsKey: k, lineName: lineName(k), sessions: 0, create: 0, update: 0 });
    const l = lineMap.get(k);
    l.sessions += 1;
    l[kind] += 1;
    return l;
  };
  for (const c of create) bumpLine(c.wsKey, "create");
  for (const u of update) bumpLine(u.wsKey, "update");
  const lines = [...lineMap.values()].sort((a, b) => (a.wsKey < b.wsKey ? -1 : a.wsKey > b.wsKey ? 1 : 0));

  const stats = {
    rows: allRows.length,
    legacyRows: legacyRows,
    sessionRows: sessionRows,
    markerRows: markerRows,
    distinctSids: sids.length,
    created: create.length,
    updated: update.length,
    skipped: skipped.length,
    skippedByReason: Object.assign({}, skipCount),
    unknownSids: unknownWs.length,
    lines: lines.length,
    wsKeySources: Object.assign({}, wsSourceCount),
  };
  return { create, update, skipped, unknownWs, lines, conflicts, stats };
}
