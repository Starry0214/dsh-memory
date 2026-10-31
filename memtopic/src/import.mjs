// 阶段6 · 迁移器：把现有 md 记忆库（742/743 个文件）幂等导入主题账本
//
// 硬约束（用户/对齐文档 + Lead 2026-10-29 裁决）：
//   1) **只读**源目录：本模块只读文件，从不写/删/移动源 md；CLI 导入前后各打一次源指纹比对。
//   2) 逐字保真：句子 = 源文件的行原文（只剥结构性标记，不改内部空白、不重排、不转义）。
//   3) 幂等：重复导入新增 0 句 0 主题；用 historicShas 挡住"已被改掉的旧句复活"（决策 12）。
//   4) 不静默分叉：导入只认「归一化精确 + 别名精确」复用主题，**不做模糊合并**（避免串主题）；
//      相似主题作为 mergeCandidates / seedConflicts 报出来供人审，不替人做决定。
//   5) 建主题**只能**走 `store.seedTopic(...)`（Lead 规则 1）：一律 draft、近重复/灰区进 needs_review、
//      导入写入不推动自动转正（noAutoPromote 由 seedTopic 负责）。本模块**不**碰 createTopic/_insertTopic。
//   6) 排除策略：隐藏目录/文件（含 .trash-*）、*.bak/备份、非扫描层、glob、符号链接一律不进库，
//      且逐类计数进报告（Lead 2026-10-29 复核：回收站旧内容不得变成记忆）。
//
// ---------------------------------------------------------------------------
// 解析规则（写清，便于核对 —— verification.md F 组 + A 组"正文逐字保真"）
// ---------------------------------------------------------------------------
// 1) front matter：文件首个非空行是 `---` 时，剥到下一个 `---`（找不到闭合则视为普通分隔线）。
// 2) 主题名：按顺序 ① 第一个 H1（行首 `# ` 或 `#\t`）的文字（去掉行首标记、只 trim 两端） ② 无 H1
//    ⇒ 由文件名派生：去 `MEMORY-` 前缀、去尾部 8 位日期（YYYYMMDD）或 YYYY-MM-DD 日期，
//    剥完若长度仍 ≥2 才采用，否则保留原文件名（避免 sessions/2026-10-04.md 变成空名）。
// 3) 句子：其余**非空行**逐字入正文（含行首缩进、行尾空格、引用块 `>` 前缀、表格行、代码块内容）。
//    - 标题：默认**所有 heading 行都不入正文**（任务约定"标题不入正文"；第一个 H1 同时作主题名）；
//      可传 keepHeadings=true 改为保留 `##`+ 行（H1 仍只作主题名）。
//    - 跳过（结构性、不是正文）：空行/纯空白行、代码围栏标记行（``` 或 ~~~，围栏内内容保留）、
//      HTML 注释行（含多行注释区间）、独立分隔线行（--- / *** / ___，≥3 个）。
//      **特例（P6 硬约束）**：`<!-- dsh-memory: ... -->` 是插件写入的"本文件由主题库维护"只读标记行，
//      **恒定丢弃**（不论出现在文件首部还是正文中间）—— 否则标记会被当成正文句进库，污染正文/句数。
//      只匹配这一个前缀；其它 HTML 注释维持原行为（照旧整段丢弃）。
//    - 换行：CRLF/CR/LF 统一切行，句子本身不含换行 ⇒ 行尾换行符信息不保留（已知有损，见报告 limitation）。
//    - 同一主题内**重复文本只收一次**（否则单句 CAS 会永久 TEXT_NOT_UNIQUE）；重复行数在报告里单列。
// 4) 别名派生（决策 11）：标题按 `·：（）—、, / | 【】「」《》` 等切片段，各取长度 ≥3 的片段；
//    + 文件名去 MEMORY- 前缀/日期后缀后的短名；各主题上限 24 条，只增不删。
// 5) triggers 派生（决策 10）：标题片段（优先）+ 正文高频专有词（频次 ≥2，取前若干）：
//    反引号片段、`「」『』【】《》` 内短语、技术型拉丁 token（含大写/数字/._-/ 或长度 ≥5）、
//    CJK 词块（按非中英数切分，长度 2–8，出现 ≥2 次，过滤停用字）。每主题上限 24 条、每文件最多 8 条。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore, MemError, sha16, normalizeName } from './memory-store.mjs';
import { DEFAULT_GOVERNANCE } from './governance.mjs';

export const REPORT_VERSION = 2;
export const DEFAULT_DIRS = ['knowledge', 'projects', 'tools', 'sessions'];
export const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), '.dsh', 'memory');
// [P6][task-47] 主题库只读标记行前缀：插件在「已被主题库接管」的 md 首行写入 `<!-- dsh-memory: ... -->`；
//   导入器必须恒定丢弃该行（数据安全硬约束：标记行绝不能变成主题正文/影响句数）。
export const TOPICDB_MD_MARKER_PREFIX = '<!-- dsh-memory:';

// 别名/标题片段里应丢弃的"通用词"（避免把 MEMORY、明细、汇编 之类当别名）
const GENERIC_SEGMENTS = new Set([
  'memory', 'dsh', 'md', 'memo', 'mimocode',
  '记忆', '记忆库', '备注', '备忘', '记录', '明细', '细节', '补档', '汇编', '冷节', '冷节汇编',
  '原文', '逐字', '未改', '未删', '未动', '原文逐字未改', '原文逐字', '一字未删',
  '摘要', '索引', '目录', '说明', '注意', '问题', '方案', '实现', '验证', '测试', '结论', '总结',
  '要点', '列表', '清单', '更新', '版本', '临时', '待定', '草稿', '历史', '归档',
]);

const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'then', 'than', 'when', 'where', 'which', 'while',
  'will', 'have', 'has', 'had', 'not', 'but', 'you', 'are', 'was', 'were', 'can', 'could', 'should',
  'would', 'about', 'into', 'over', 'under', 'again', 'also', 'just', 'only', 'very', 'true', 'false',
  'null', 'undefined', 'none', 'function', 'return', 'const', 'let', 'var', 'import', 'export', 'class',
  'async', 'await', 'new', 'typeof', 'instanceof', 'string', 'number', 'boolean', 'object', 'array',
  'error', 'node', 'http', 'https', 'www', 'com', 'org', 'type',
]);

// CJK 词块里的停用字（用于过滤"通用拼接"，如「是在和了」这类高频虚词组合）
const CJK_STOP_CHARS = /[的了是在和与或有个这那我你他它就都也要会可能没把被给让从对到为以于而并但所以如果因为已经还再很更最不吗呢吧啊么着过们自己上下前后中内外时天年月日记忆]/;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^(```|~~~)/;
const BAK_RE = /\.bak|\.pre-|~$/i;

// ---------------------------------------------------------------------------
// 泛化 trigger 过滤（task-9）：① 弱词表 ② 语料级区分度（主判据）
// ---------------------------------------------------------------------------
// 阈值必须与治理侧一致：某 trigger 覆盖的**主题数** > genericTriggerMaxTopics ⇒ 视为泛化。
// 治理侧同名字段：governance.DEFAULT_GOVERNANCE.genericTriggerMaxTopics / store.govCfg（task-8 落地后自动跟随）。
export const GENERIC_TRIGGER_MAX_TOPICS_FALLBACK = 5;

// 弱词表（归一化后精确命中即视为泛化）：模板话术 + 文档套话 + 前缀残片
const WEAK_TRIGGER_WORDS = new Set([
  '原文一字未删', '原文一字未改', '原文逐字未改', '原文逐字未删', '原文逐字', '一字未删', '未删未改',
  '原文未删', '原文未改', '原文保留', '原文要点', '原文全文', '原文', '容量治理下沉', '容量治理',
  '下沉原文', '原始归档', '独立原文', '原文原文',
  '备注', '说明', '结论', '要点', '清单', '列表', '方案', '实现', '验证', '测试', '问题', '原因', '根因',
  '修复', '待办', '遗留', '更新', '版本', '变更', '规则', '口径', '注意', '风险', '影响', '背景', '目标',
  '现状', '结果', '配置', '日志', '报错', '命令', '路径', '文件', '目录', '记录', '明细', '摘要', '索引',
  '归档', '历史', '详情', '详见', '见上', '同上', '如下', '以下', '上述', '前述', '相关', '其他', '部分',
  'memory', 'dsh', 'md', 'mimocode',
]);
const WEAK_TRIGGER_RES = [
  /^(原文)?(一字未删|一字未改|逐字未改|逐字未删|未删未改)$/,
  /^原文(一字|逐字|要点|全文|保留|未)/,
  /^(详见|见上|同上|如下|以下|上述|前述|相关)$/,
];

/**
 * 是否弱 trigger（纯年份/纯数字、日期样式、单双字英文、模板话术、文档套话）：
 *   · 2026 / 20261018 / 1003 ⇒ weak（纯数字）
 *   · 2026-10-08 / 2026/10/8 / 2026年10月 ⇒ weak（日期）
 *   · MB / OA / md ⇒ weak（1–2 个英文字母）
 *   · 172.24.16.184 / N12 / BSGL20260824015 / dsh-memory/index.js ⇒ **保留**（含分隔符/字母数字混合）
 */
export function isWeakTrigger(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return true;
  const norm = normalizeName(raw);
  if (!norm) return true;
  if (WEAK_TRIGGER_WORDS.has(norm)) return true;
  if (WEAK_TRIGGER_RES.some((re) => re.test(raw) || re.test(norm))) return true;
  if (/^\d+$/.test(raw)) return true;                                   // 纯数字/年份/编号
  if (/^\d{4}\s*[-/年.]\s*\d{1,2}(\s*[-/月.]\s*\d{1,2}\s*日?)?$/.test(raw)) return true;  // 日期样式
  if (/^[A-Za-z]{1,2}$/.test(raw)) return true;                          // MB / OA / md
  return false;
}

/** 泛化 trigger 阈值：显式参数 > 治理侧配置 > 治理侧默认 > 兜底 5（单一真源，不另立一套） */
export function genericTriggerMaxTopics(store, opts = {}) {
  const pick = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const fromOpts = pick(opts.genericTriggerMaxTopics);
  if (fromOpts != null) return fromOpts;
  try {
    const fromStore = pick(store && store.govCfg && store.govCfg.genericTriggerMaxTopics);
    if (fromStore != null) return fromStore;
  } catch { /* noop */ }
  const fromGov = pick(DEFAULT_GOVERNANCE && DEFAULT_GOVERNANCE.genericTriggerMaxTopics);
  if (fromGov != null) return fromGov;
  return GENERIC_TRIGGER_MAX_TOPICS_FALLBACK;
}

// ---------------------------------------------------------------------------
// 0. 通用小工具
// ---------------------------------------------------------------------------
export function posix(p) { return String(p).split(path.sep).join('/'); }

// ---------------------------------------------------------------------------
// 1. 语料扫描 + 排除策略（可配；逐类计数进报告）
// ---------------------------------------------------------------------------
export const DEFAULT_SCAN = Object.freeze({
  excludeHidden: true,      // 任何以 '.' 开头的目录/文件（.trash-*、.archive-units、.config.json…）
  trashPrefix: '.trash',    // 隐藏目录/文件里以此开头的单独归类为 trash
  excludeBak: true,         // *.bak* / *.pre-* / *~（备份与历史副本）
  excludeGlobs: [],         // 额外排除 glob（可配），如 ['**/MEMORY-日摘要-*']
  excludeSymlinks: true,    // 符号链接不跟（防止把库外内容导进来）
});

/** 极简 glob → RegExp（只支持 ** 与 * 与 ?，够用且无依赖） */
export function globToRegExp(glob) {
  const src = String(glob)
    .replace(/[.+^$()\[\]{}|\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + src + '$');
}

/**
 * 扫描语料根目录。
 * @returns {{root,dirs:Array,mdTotal:number,files:Array<{abs,rel,dir}>,
 *            excluded:{count:number,byReason:Object,samples:Array},
 *            nonMdIgnored:{total:number,bak:number}}}
 * 说明：mdTotal = 全库递归 md 数（含被排除的）；excluded.count = mdTotal - files.length；
 *      非 md 文件单独计数（不进 742 口径），便于说明"742 里真正该导入的是多少"。
 */
export function scanCorpus(root, opts = {}) {
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs : DEFAULT_DIRS;
  const allow = new Set(dirs);
  const cfg = { ...DEFAULT_SCAN, ...(opts.scan || {}) };
  const globs = (cfg.excludeGlobs || []).map(globToRegExp);
  const files = [];
  const excluded = { count: 0, byReason: {}, byTopDir: {}, samples: [] };
  const nonMd = { total: 0, bak: 0 };
  let mdTotal = 0;
  const bump = (reason, rel) => {
    excluded.byReason[reason] = (excluded.byReason[reason] || 0) + 1;
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
    excluded.byTopDir[top] = (excluded.byTopDir[top] || 0) + 1;
    if (excluded.samples.length < 60) excluded.samples.push({ path: rel, reason });
  };
  const isTrashName = (name) => name.startsWith(cfg.trashPrefix);
  const countNonMd = (name) => { nonMd.total++; if (BAK_RE.test(name)) nonMd.bak++; };

  // 隐藏目录整棵子树：只数 md 并归入 trash/hidden（不进入导入候选）
  const countHiddenMd = (absDir, relDir, reason) => {
    let items = [];
    try { items = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const abs = path.join(absDir, e.name);
      const rel = relDir + '/' + e.name;
      if (e.isDirectory()) { countHiddenMd(abs, rel, reason); continue; }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.md')) { countNonMd(e.name); continue; }
      mdTotal++;
      bump(reason, rel);
    }
  };

  const walk = (absDir, relDir) => {
    let items = [];
    try { items = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of items) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isSymbolicLink()) {
        if (cfg.excludeSymlinks) {
          if (e.name.toLowerCase().endsWith('.md')) { mdTotal++; bump('symlink', rel); }
          continue;
        }
      }
      if (e.isDirectory()) {
        if (cfg.excludeHidden && e.name.startsWith('.')) { countHiddenMd(abs, rel, isTrashName(e.name) ? 'trash' : 'hidden'); continue; }
        walk(abs, rel);
        continue;
      }
      if (!e.isFile()) continue;
      const isMd = e.name.toLowerCase().endsWith('.md');
      if (!isMd) { countNonMd(e.name); continue; }
      mdTotal++;
      if (cfg.excludeHidden && e.name.startsWith('.')) { bump(isTrashName(e.name) ? 'trash' : 'hidden', rel); continue; }
      if (cfg.excludeBak && BAK_RE.test(e.name)) { bump('bak', rel); continue; }
      if (globs.some((re) => re.test(rel))) { bump('exclude-glob', rel); continue; }
      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
      if (allow.size && !allow.has(top)) { bump('outside-dirs', rel); continue; }
      files.push({ abs, rel, dir: relDir || '.' });
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  excluded.count = mdTotal - files.length;
  excluded.byReason = Object.fromEntries(Object.entries(excluded.byReason).sort(([a], [b]) => (a < b ? -1 : 1)));
  excluded.byTopDir = Object.fromEntries(Object.entries(excluded.byTopDir).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { root, dirs, mdTotal, files, excluded, nonMdIgnored: nonMd };
}

/** 递归列出目录下的 *.md（仅按层、不做排除统计；供指纹等轻量用途） */
export function listMarkdownFiles(root, dirs = DEFAULT_DIRS) {
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    const abs = path.resolve(root, d);
    if (!fs.existsSync(abs)) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    walk(abs);
  }
  function walk(dir) {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of items) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      if (BAK_RE.test(e.name)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ abs, rel: posix(path.relative(root, abs)), dir: posix(path.relative(root, dir)) || '.' });
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// 2. 解析单个 md → { name, nameFrom, sentences, counts }
// ---------------------------------------------------------------------------
export function parseMarkdown(text, filePath, opts = {}) {
  const keepHeadings = !!opts.keepHeadings;
  const clean = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const rawLines = clean.split(/\r\n|\n|\r/);
  const base = path.basename(filePath).replace(/\.md$/i, '');
  const counts = {
    lines: rawLines.length, blank: 0, frontMatter: 0, title: 0, headings: 0,
    keptHeadings: 0, fence: 0, comment: 0, rule: 0, sentences: 0,
  };
  const sentences = [];
  // [P6] 文件首部的主题库只读标记行（可能 ≥1 行）：先剥掉再判 front matter，
  //   否则"标记行在 `---` 之前"会让 front matter 识别失败、把 `---`/元数据当正文导入。
  const lines = rawLines.slice();
  while (lines.length && lines[0].trim().startsWith(TOPICDB_MD_MARKER_PREFIX)) {
    lines.shift();
    counts.comment++;
  }

  // 1) front matter
  let start = 0;
  if (lines.length && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { start = i + 1; counts.frontMatter = i + 1; break; }
    }
  }

  let inFence = false;
  let inComment = false;
  let name = null;
  let nameAt = -1;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // 代码围栏标记（围栏内内容照收）
    if (t && FENCE_RE.test(t)) { inFence = !inFence; counts.fence++; continue; }
    if (t === '') { counts.blank++; continue; }

    // HTML 注释（可跨行）：整段丢弃
    if (!inFence) {
      // [P6] 主题库只读标记行：恒丢弃（只匹配 `<!-- dsh-memory:` 这一个前缀；其它 HTML 注释行为不变）
      if (t.startsWith(TOPICDB_MD_MARKER_PREFIX)) { counts.comment++; continue; }
      if (inComment) {
        counts.comment++;
        if (t.includes('-->')) inComment = false;
        continue;
      }
      if (t.startsWith('<!--')) {
        counts.comment++;
        if (!t.includes('-->')) inComment = true;
        continue;
      }
    }

    // 标题：第一个 H1 作主题名（不入正文）；其余标题默认也不入正文（keepHeadings 可打开）
    if (!inFence) {
      const h = HEADING_RE.exec(t);
      if (h) {
        if (h[1] === '#' && name == null) {
          name = h[2].trim();
          nameAt = i;
          counts.title++;
          continue;
        }
        if (!keepHeadings) { counts.headings++; continue; }
        counts.keptHeadings++;
      } else if (RULE_RE.test(t)) { counts.rule++; continue; }
    }

    // 正文：逐字保留整行（含行首缩进、行尾空白、引用块 `>` 前缀）
    sentences.push(line);
  }

  let nameFrom = 'h1';
  if (name == null) {
    nameFrom = 'filename';
    name = deriveNameFromFile(base);
  }
  counts.sentences = sentences.length;
  return { name, nameFrom, base, sentences, counts, titleAt: nameAt };
}

/** 无 H1 时由文件名派生主题名：去 MEMORY- 前缀 + 去尾部日期后缀 */
export function deriveNameFromFile(base) {
  const raw = String(base || '').replace(/\.md$/i, '').trim();
  if (!raw) return '未命名';
  let s = raw.replace(/^MEMORY[-_]?/i, '').trim();
  const stripped = s
    .replace(/[-_ ]?\d{8}$/, '')                       // 20261018
    .replace(/[-_ ]?\d{4}[-_]\d{2}[-_]\d{2}$/, '')     // 2026-10-18
    .trim();
  if (stripped.length >= 2) s = stripped;
  return s || raw;
}

/** 标题按分隔符切片段（长度 ≥3，去掉通用词） */
export function titleSegments(title) {
  return String(title || '')
    .split(/[·・：:（）()［］\[\]【】《》「」『』<>—–\-、,，;；\/\\|｜]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !GENERIC_SEGMENTS.has(normalizeName(s)));
}

/** 别名派生：标题片段 + 文件名短名（去 MEMORY-/日期后缀） */
export function deriveAliases(parsed, filePath, opts = {}) {
  const max = opts.maxAliasesPerFile || 10;
  const nameNorm = normalizeName(parsed.name);
  const seen = new Set([nameNorm]);
  const out = [];
  const push = (a) => {
    const s = String(a == null ? '' : a).trim();
    if (s.length < 3) return;
    const n = normalizeName(s);
    if (!n || seen.has(n)) return;
    if (GENERIC_SEGMENTS.has(n)) return;
    seen.add(n);
    if (out.length < max) out.push(s);
  };
  const base = path.basename(filePath).replace(/\.md$/i, '');
  const shortName = base.replace(/^MEMORY[-_]?/i, '')
    .replace(/[-_ ]?\d{8}$/, '').replace(/[-_ ]?\d{4}[-_]\d{2}[-_]\d{2}$/, '').trim();
  push(shortName);
  for (const seg of titleSegments(parsed.name)) push(seg);
  // 标题里若只有括号内的片段（例如「x（原文逐字未改）」），整段标题的"去括号"版本也登记
  const noParen = String(parsed.name).replace(/[（(][^）)]{0,20}[）)]/g, '').trim();
  if (noParen && noParen !== parsed.name) for (const seg of titleSegments(noParen)) push(seg);
  return out;
}

function isTechnicalToken(tok) {
  if (!/[A-Za-z]/.test(tok)) return false;
  if (EN_STOP.has(tok.toLowerCase())) return false;
  if (/[A-Z]/.test(tok)) return true;
  if (/[0-9_.\-\/\\]/.test(tok)) return true;
  return tok.length >= 5;
}

/** triggers 派生：标题片段 + 正文高频专有词（规则见文件头注释） */
export function deriveTriggers(parsed, opts = {}) {
  const maxPerFile = opts.maxTriggersPerFile || 8;
  const maxLen = opts.maxTriggerLength || 24;
  const seen = new Set();
  const out = [];
  const stats = opts.triggerStats || null;
  const pushText = (text) => {
    const s = String(text == null ? '' : text).trim().replace(/[.。,，;；:：]+$/, '');
    if (s.length < 2 || s.length > maxLen) return false;
    const n = normalizeName(s);
    if (!n || seen.has(n)) return false;
    if (GENERIC_SEGMENTS.has(n)) return false;
    if (isWeakTrigger(s)) { if (stats) stats.weak++; return false; }   // 弱词表：不派生（task-9）
    seen.add(n);
    out.push(s);
    return true;
  };

  // ① 标题片段优先（最稳定、最具区分度）
  for (const seg of titleSegments(parsed.name)) {
    if (out.length >= maxPerFile) break;
    pushText(seg);
  }

  // ② 正文高频专有词
  const cand = new Map();   // norm -> { text, count, score, first }
  let seq = 0;
  const add = (text, weight) => {
    const s = String(text == null ? '' : text).trim();
    if (!s) return;
    if (s.length < 2 || s.length > maxLen) return;
    const n = normalizeName(s);
    if (!n || GENERIC_SEGMENTS.has(n)) return;
    const cur = cand.get(n);
    if (cur) { cur.count++; cur.score += weight; }
    else cand.set(n, { text: s, count: 1, score: weight, first: seq++ });
  };

  for (const line of parsed.sentences) {
    // 反引号片段（路径/命令/API 名）
    for (const m of line.matchAll(/`([^`\n]{2,80})`/g)) add(m[1], 1.4);
    // 书名号/引号/方括号内短语
    for (const m of line.matchAll(/[「『【《]([^」』】》\n]{2,40})[」』】》]/g)) add(m[1], 1.3);
    // 技术型拉丁 token
    for (const m of line.matchAll(/[A-Za-z][A-Za-z0-9_.\-\/\\]{1,39}/g)) {
      const tok = m[0].replace(/[.\-]+$/, '');
      if (isTechnicalToken(tok)) add(tok, 1.0);
    }
    // CJK 词块（按非中英数切分；只统计出现 ≥2 次的）
    for (const chunk of line.split(/[^\u4e00-\u9fffA-Za-z0-9]+/)) {
      if (!/^[\u4e00-\u9fff]+$/.test(chunk)) continue;
      if (chunk.length < 2 || chunk.length > 8) continue;
      if (CJK_STOP_CHARS.test(chunk)) continue;
      add(chunk, 0.6);
    }
  }

  const ranked = [...cand.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => (b.score - a.score) || (a.first - b.first) || (a.text < b.text ? -1 : 1));
  for (const c of ranked) {
    if (out.length >= maxPerFile) break;
    pushText(c.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 建主题：一律走 store.seedTopic（Lead 裁决 规则 1/2/3/4/5）
// ---------------------------------------------------------------------------
//   规则1 迁移器只能走 seed 通道（不碰 createTopic / _insertTopic 旁路）
//   规则2 导入建出的主题一律 draft
//   规则3 禁建区仍落库 + needs_review('seed-near-duplicate')；灰区 draft + needs_review('seed-gray')
//   规则4 导入写入不推动自动转正（seedTopic 打 noAutoPromote）
//   规则5 报告需给出 topicsDraft / needsReview，并能断言"导入后 active 数 = 0"
function requireSeedTopic(store) {
  if (typeof store.seedTopic !== 'function') {
    throw new MemError('SEED_TOPIC_UNAVAILABLE',
      'store.seedTopic 未就绪：按 Lead 裁决迁移器只能走 seed 通道，不得改走 createTopic/_insertTopic 绕过治理',
      { required: "MemoryStore.seedTopic({ name, aliases, triggers, src, actor: 'plugin' })" });
  }
}

function seedTopicFor(store, { name, aliases, triggers, src, actor }) {
  requireSeedTopic(store);
  const r = store.seedTopic({ name, aliases, triggers, src, actor });
  if (!r || !r.id) throw new MemError('SEED_FAILED', 'seedTopic 未返回主题 id：' + JSON.stringify(r), { name });
  const created = !!r.created;
  return {
    id: r.id, name: r.name, how: r.how, created,
    zone: r.zone || (created ? 'safe' : 'existing'),
    state: r.state || null,
    needsReview: !!r.needsReview,
    reviewReason: r.reason || null,
    candidates: r.candidates || [],
    demoted: r.demoted || null,
    noAutoPromote: !!r.noAutoPromote,
  };
}

function addAliasesCapped(store, topicId, aliases, cap, actor) {
  const cur = store.be.getTopicById(topicId);
  const have = new Set((cur.aliases || []).map(normalizeName));
  let added = 0;
  for (const a of aliases) {
    if ((cur.aliases || []).length + added >= cap) break;
    if (have.has(normalizeName(a))) continue;
    const r = store.addAlias(topicId, a, { actor });
    if (r && r.added) { added++; have.add(normalizeName(a)); }
  }
  return added;
}

function addTriggersCapped(store, topicId, triggers, cap, actor) {
  const cur = store.be.getTopicById(topicId);
  const have = new Set((cur.triggers || []).map(normalizeName));
  const room = Math.max(0, cap - (cur.triggers || []).length);
  const add = [];
  for (const t of triggers) {
    if (add.length >= room) break;
    const n = normalizeName(t);
    if (!n || have.has(n)) continue;
    have.add(n);
    add.push(t);
  }
  if (!add.length) return 0;
  const r = store.addTriggers(topicId, add, { actor });
  return r.added || 0;
}

// ---------------------------------------------------------------------------
// 3b. 文件级原子写（Lead 裁决 B：每个文件一个事务；失败整文件回滚，不拖垮全量）
// ---------------------------------------------------------------------------
// 事务 API 由 gov-builder 提供：store.runInTransaction(fn)。
//   · 已就绪 ⇒ 该文件的 seedTopic + addAlias/addTriggers + appendSentence 全包在一个事务里；
//   · 未就绪 ⇒ 先按原样逐句写，并在报告 limitations 里如实标注"本环境未启用批量事务"，
//     **不自己造事务**（避免嵌套事务 / 双后端语义不一致 / 破坏 replaceSentence 的自带事务）。
function runFileAtomically(store, fn) {
  if (typeof store.runInTransaction === 'function') return store.runInTransaction(fn);
  return fn();
}
const TX_KEYS = ['topicsCreated', 'topicsMatched', 'needsReview', 'demotedToDormant', 'aliasesAdded', 'triggersAdded',
  'sentencesAdded', 'sentencesSkipped', 'skippedDuplicate', 'skippedHistoricSha', 'chars', 'charsAdded'];
function snapshotWriteCounters(report) {
  const snap = { zones: { ...report.zones }, seedConflictsLen: report.seedConflicts.length };
  for (const k of TX_KEYS) snap[k] = report[k];
  return snap;
}
function restoreWriteCounters(report, snap) {
  for (const k of TX_KEYS) report[k] = snap[k];
  report.zones = { ...snap.zones };
  report.seedConflicts.length = snap.seedConflictsLen;
}

// ---------------------------------------------------------------------------
// 4. 相似候选 / trigger 冲突（只报，不自动合并 —— 决策 5「宁可报错，不要静默分叉」）
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function activeTriggersOf(store, t) {
  if (typeof store.activeTriggersOf === 'function') return store.activeTriggersOf(t);
  return t.triggers || [];
}

function collectMergeCandidates(store, limit = 30) {
  const topics = store.be.listTopics();
  const out = [];
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = topics[i].norm, b = topics[j].norm;
      if (!a || !b) continue;
      const d = levenshtein(a, b);
      const contains = a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
      if (d <= 2 || contains) {
        out.push({
          a: { id: topics[i].id, name: topics[i].name, state: topics[i].state },
          b: { id: topics[j].id, name: topics[j].name, state: topics[j].state },
          dist: d,
          sim: Number(similarity(a, b).toFixed(3)),
          why: contains && d > 2 ? 'contains' : 'dist<=2',
        });
      }
    }
  }
  out.sort((x, y) => (y.sim - x.sim) || (x.a.id < y.a.id ? -1 : 1) || (x.b.id < y.b.id ? -1 : 1));
  return out.slice(0, limit);
}

function collectTriggerConflicts(store, limit = 30) {
  const map = new Map();   // norm -> { trigger, topics: [] }
  for (const t of store.be.listTopics()) {
    for (const tr of activeTriggersOf(store, t)) {
      const n = normalizeName(tr);
      if (!n) continue;
      const cur = map.get(n) || { trigger: tr, topics: [] };
      if (!cur.topics.some((x) => x.id === t.id)) cur.topics.push({ id: t.id, name: t.name, state: t.state });
      map.set(n, cur);
    }
  }
  const out = [...map.values()].filter((x) => x.topics.length >= 2)
    .sort((a, b) => (b.topics.length - a.topics.length) || (a.trigger < b.trigger ? -1 : 1));
  return { count: out.length, sample: out.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// 5. 导入：单文件 / 整目录
// ---------------------------------------------------------------------------
function emptyReport(root, dirs) {
  return {
    version: REPORT_VERSION,
    root: root ? path.resolve(root) : null,
    dirs: (dirs || DEFAULT_DIRS).slice(),
    gate: 'seedTopic',
    files: 0, filesEmpty: 0, filesNoSentences: 0, filesErrored: 0,
    topicsCreated: 0, topicsMatched: 0, topicsTouched: 0, topicsInStore: 0,
    topicsDraft: 0, needsReview: 0, needsReviewByReason: {}, demotedToDormant: 0, topicsByState: {},
    txEnabled: false, txFiles: 0, txFallbackFiles: 0,
    zones: { existing: 0, safe: 0, gray: 0, forbidden: 0 },
    sentencesAdded: 0, sentencesSkipped: 0,
    skippedExisting: 0, skippedHistoricSha: 0, skippedDuplicate: 0,
    chars: 0, charsAdded: 0, bytes: 0,
    aliasesAdded: 0, triggersAdded: 0,
    triggerStats: { derived: 0, weakFiltered: 0, genericFiltered: 0, kept: 0 },
    genericTriggerMaxTopics: GENERIC_TRIGGER_MAX_TOPICS_FALLBACK,
    genericTriggers: [],
    dropped: { blank: 0, frontMatter: 0, title: 0, headings: 0, fence: 0, comment: 0, rule: 0 },
    linesTotal: 0,
    keepHeadings: false,
    actor: 'plugin',
    corpus: null,
    excludedByPolicy: { count: 0, byReason: {}, samples: [] },
    skipReasons: {},
    seedConflicts: [],
    limitations: [],
    elapsedMs: 0,
    perFile: [],
    errors: [],
    mergeCandidates: [],
    triggerConflicts: { count: 0, sample: [] },
  };
}

function bumpDropped(report, counts) {
  report.dropped.blank += counts.blank;
  report.dropped.frontMatter += counts.frontMatter;
  report.dropped.title += counts.title;
  report.dropped.headings += counts.headings;
  report.dropped.fence += counts.fence;
  report.dropped.comment += counts.comment;
  report.dropped.rule += counts.rule;
  report.linesTotal += counts.lines;
}

/**
 * 导入一组文件（绝对路径或 {abs,rel}）。
 * opts: { root, dirs, actor, keepHeadings, dryRun, corpusInfo, maxAliasesPerFile, maxTriggersPerFile,
 *         maxAliasesPerTopic, maxTriggersPerTopic, collectCandidates, onProgress }
 */
export function importFiles(store, files, opts = {}) {
  const t0 = Date.now();
  const root = opts.root || process.cwd();
  const actor = opts.actor || 'plugin';
  const report = emptyReport(root, opts.dirs);
  report.keepHeadings = !!opts.keepHeadings;
  report.actor = actor;
  report.txEnabled = typeof store.runInTransaction === 'function';
  const corpusInfo = opts.corpusInfo || null;
  if (corpusInfo) {
    report.corpus = {
      root,
      dirs: (opts.dirs || DEFAULT_DIRS).slice(),
      mdTotal: corpusInfo.mdTotal,
      importedFiles: corpusInfo.importedFiles,
      excluded: corpusInfo.excluded.count,
      nonMdIgnored: corpusInfo.nonMdIgnored,
    };
    report.excludedByPolicy = corpusInfo.excluded;
  }
  const perTopic = new Map();     // topicId -> { live:Set, hist:Set }
  const entries = (files || []).map((f) => (typeof f === 'string'
    ? { abs: path.resolve(f), rel: posix(path.relative(root, path.resolve(f))) }
    : { abs: path.resolve(f.abs), rel: f.rel || posix(path.relative(root, path.resolve(f.abs))) }));
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // ---- 预处理（task-9 主判据）：先解析全语料、统计每个候选 trigger 的"主题覆盖数" ----
  // 覆盖主题数 > genericTriggerMaxTopics ⇒ 泛化，不派生（与治理侧同阈值、同口径：数主题不数文件）。
  // 主题键：已有主题 → existing:<id>；将新建 → new:<归一化名>（同归一化名的文件合并成同一主题）。
  const maxGenericTopics = genericTriggerMaxTopics(store, opts);
  const triggerStats = { derived: 0, weakFiltered: 0, genericFiltered: 0, kept: 0 };
  const prepared = new Map();     // rel -> { bytes, text, parsed, aliases, candidates, triggers, topicKey }
  const topicKeyFor = (name) => {
    const norm = normalizeName(name);
    const exact = store.be.getTopicByNorm(norm);
    if (exact) return 'existing:' + exact.id;
    for (const t of store.be.listTopics()) {
      if ((t.aliases || []).some((a) => normalizeName(a) === norm)) return 'existing:' + t.id;
    }
    return 'new:' + norm;
  };
  for (const entry of entries) {
    if (!fs.existsSync(entry.abs)) continue;      // 缺文件在主循环里记 not-found
    const buf = fs.readFileSync(entry.abs);
    const text = buf.toString('utf8');
    const parsed = parseMarkdown(text, entry.abs, { keepHeadings: report.keepHeadings });
    const rec = { bytes: buf.length, text, parsed, aliases: [], candidates: [], triggers: [], topicKey: null };
    if (parsed.sentences.length) {
      rec.aliases = deriveAliases(parsed, entry.abs, opts);
      const wst = { weak: 0 };
      rec.candidates = deriveTriggers(parsed, { ...opts, triggerStats: wst });
      triggerStats.weakFiltered += wst.weak || 0;
      triggerStats.derived += rec.candidates.length;
      rec.topicKey = topicKeyFor(parsed.name);
    }
    prepared.set(entry.rel, rec);
  }
  const triggerCoverage = new Map();      // norm -> { trigger, topics:Set }
  for (const rec of prepared.values()) {
    for (const tr of rec.candidates) {
      const n = normalizeName(tr);
      if (!n) continue;
      const e = triggerCoverage.get(n) || { trigger: tr, topics: new Set() };
      e.topics.add(rec.topicKey);
      triggerCoverage.set(n, e);
    }
  }
  const genericTriggers = [];
  for (const e of triggerCoverage.values()) {
    if (e.topics.size > maxGenericTopics) genericTriggers.push({ trigger: e.trigger, topics: e.topics.size });
  }
  genericTriggers.sort((a, b) => (b.topics - a.topics) || (a.trigger < b.trigger ? -1 : 1));
  const genericNorm = new Set(genericTriggers.map((x) => normalizeName(x.trigger)));
  for (const rec of prepared.values()) {
    if (!rec.candidates.length) continue;
    rec.triggers = rec.candidates.filter((tr) => {
      if (genericNorm.has(normalizeName(tr))) { triggerStats.genericFiltered++; return false; }
      return true;
    });
    triggerStats.kept += rec.triggers.length;
  }
  report.triggerStats = triggerStats;
  report.genericTriggerMaxTopics = maxGenericTopics;
  report.genericTriggers = genericTriggers.slice(0, 20);

  for (const entry of entries) {
    report.files++;
    const pf = {
      file: entry.rel, bytes: 0, lines: 0, sentences: 0, added: 0,
      skippedExisting: 0, skippedHistoricSha: 0, skippedDuplicate: 0,
      topic: null, topicName: null, how: null, nameFrom: null,
      topicState: null, zone: null, seeded: false, needsReview: false, reviewReason: null,
      noAutoPromote: false, conflictWith: [],
      aliasesGenerated: 0, triggersGenerated: 0, aliasesAdded: 0, triggersAdded: 0,
      skipped: null,
    };
    try {
      const prep = prepared.get(entry.rel);
      if (!prep) {
        pf.skipped = 'not-found';
        report.filesErrored++;
        report.errors.push({ file: entry.rel, code: 'NOT_FOUND', message: '文件不存在' });
        report.perFile.push(pf);
        continue;
      }
      const text = prep.text;
      pf.bytes = prep.bytes;
      report.bytes += prep.bytes;

      const parsed = prep.parsed;
      pf.nameFrom = parsed.nameFrom;
      pf.lines = parsed.counts.lines;
      pf.sentences = parsed.sentences.length;
      bumpDropped(report, parsed.counts);

      if (!parsed.sentences.length) {
        pf.skipped = String(text).trim() === '' ? 'empty' : 'no-sentences';
        if (pf.skipped === 'empty') report.filesEmpty++; else report.filesNoSentences++;
        report.perFile.push(pf);
        continue;
      }

      const aliases = prep.aliases;
      const triggers = prep.triggers;
      pf.aliasesGenerated = aliases.length;
      pf.triggersGenerated = triggers.length;

      if (report.txEnabled) report.txFiles++; else report.txFallbackFiles++;
      const snap = snapshotWriteCounters(report);
      try {
      runFileAtomically(store, () => {
      const m = seedTopicFor(store, { name: parsed.name, aliases, triggers, src: entry.rel, actor });
      pf.topic = m.id;
      pf.topicName = m.name;
      pf.how = m.how;
      pf.zone = m.zone;
      pf.seeded = m.created;
      pf.topicState = m.state;
      pf.needsReview = m.needsReview;
      pf.reviewReason = m.reviewReason;
      pf.noAutoPromote = m.noAutoPromote;
      pf.conflictWith = (m.candidates || []).slice(0, 3).map((c) => ({ id: c.id, name: c.name, sim: c.sim, reasons: c.forbiddenReasons || null }));
      if (report.zones[m.zone] == null) report.zones[m.zone] = 0;
      report.zones[m.zone]++;
      if (m.created) report.topicsCreated++; else report.topicsMatched++;
      if (m.needsReview) {
        report.needsReview++;
        const reasonKey = m.reviewReason || 'unknown';
        report.needsReviewByReason[reasonKey] = (report.needsReviewByReason[reasonKey] || 0) + 1;
      }
      if (m.demoted) report.demotedToDormant++;
      if (m.created && (m.zone === 'gray' || m.zone === 'forbidden')) {
        if (report.seedConflicts.length < (opts.seedConflictLimit || 40)) {
          report.seedConflicts.push({
            file: entry.rel, topic: m.id, topicName: m.name, zone: m.zone, reason: m.reviewReason,
            candidates: (m.candidates || []).slice(0, 5).map((c) => ({ id: c.id, name: c.name, sim: c.sim, reasons: c.forbiddenReasons || null })),
          });
        }
      }

      if (m.created) {
        // 建主题时 aliases/triggers 随 seedTopic 一次落库，同样算"写入"
        pf.aliasesAdded = aliases.length;
        pf.triggersAdded = triggers.length;
        report.aliasesAdded += pf.aliasesAdded;
        report.triggersAdded += pf.triggersAdded;
      } else {
        pf.aliasesAdded = addAliasesCapped(store, m.id, aliases, opts.maxAliasesPerTopic || 24, actor);
        pf.triggersAdded = addTriggersCapped(store, m.id, triggers, opts.maxTriggersPerTopic || 24, actor);
        report.aliasesAdded += pf.aliasesAdded;
        report.triggersAdded += pf.triggersAdded;
      }

      let st = perTopic.get(m.id);
      if (!st) {
        st = {
          live: new Set(store.be.listSentences(m.id).map((s) => s.text)),
          hist: store.historicShas(m.id),
        };
        perTopic.set(m.id, st);
      }

      for (const s of parsed.sentences) {
        report.chars += s.length;
        if (st.live.has(s)) { pf.skippedDuplicate++; report.skippedDuplicate++; continue; }
        const sh = sha16(s);
        if (st.hist.has(sh)) { pf.skippedHistoricSha++; report.skippedHistoricSha++; continue; }
        if (opts.dryRun) { st.live.add(s); pf.added++; report.sentencesAdded++; report.charsAdded += s.length; continue; }
        store.appendSentence({ topic: m.id, text: s, src: entry.rel, actor });
        st.live.add(s);
        pf.added++;
        report.sentencesAdded++;
        report.charsAdded += s.length;
      }
      pf.skippedExisting = pf.skippedDuplicate + pf.skippedHistoricSha;
      report.sentencesSkipped += pf.skippedExisting;
      });   // runInTransaction 结束
      } catch (e) {
        // 事务已回滚（或未启用事务时也把"报告计数"回滚掉），该文件计 error 后继续下一个文件
        restoreWriteCounters(report, snap);
        perTopic.clear();
        pf.topic = null; pf.topicName = null; pf.how = null; pf.topicState = null; pf.zone = null;
        pf.seeded = false; pf.needsReview = false; pf.reviewReason = null; pf.noAutoPromote = false;
        pf.conflictWith = []; pf.added = 0; pf.skippedExisting = 0; pf.skippedDuplicate = 0;
        pf.skippedHistoricSha = 0; pf.aliasesAdded = 0; pf.triggersAdded = 0;
        throw e;
      }
    } catch (e) {
      const detail = e instanceof MemError ? e.detail : null;
      const cands = Array.isArray(detail) ? detail : (detail && Array.isArray(detail.candidates) ? detail.candidates : null);
      pf.error = {
        code: e instanceof MemError ? e.code : (e && e.code) || 'ERROR',
        message: (e && e.message) || String(e),
        candidates: cands,
      };
      if (detail && !Array.isArray(detail) && detail.zone) pf.zone = detail.zone;
      if (cands) pf.conflictWith = cands.slice(0, 3).map((c) => ({ id: c.id, name: c.name, sim: c.sim }));
      report.filesErrored++;
      report.errors.push({ file: entry.rel, ...pf.error });
    }
    report.perFile.push(pf);
    if (typeof opts.onProgress === 'function') opts.onProgress(report, pf);
  }

  // ---- 汇总 ----
  report.topicsTouched = perTopic.size;
  const allTopics = store.be.listTopics();
  report.topicsInStore = allTopics.length;
  const byState = {};
  for (const t of allTopics) byState[t.state] = (byState[t.state] || 0) + 1;
  report.topicsByState = Object.fromEntries(Object.entries(byState).sort(([a], [b]) => (a < b ? -1 : 1)));
  report.topicsDraft = byState.draft || 0;

  const sr = {};
  for (const pf of report.perFile) if (pf.skipped) sr[pf.skipped] = (sr[pf.skipped] || 0) + 1;
  report.skipReasons = Object.fromEntries(Object.entries(sr).sort(([a], [b]) => (a < b ? -1 : 1)));

  const ex = report.excludedByPolicy;
  const corpus = report.corpus;
  report.limitations = [
    `标题不入正文（默认）：丢弃 ${report.dropped.headings} 行节标题（keepHeadings=true 可保留 ##+；第一个 H1 恒为主题名）`,
    `同一主题内重复文本只收一次：本轮按重复跳过 ${report.skippedDuplicate} 行（否则单句 CAS 会永久 TEXT_NOT_UNIQUE）`,
    `换行语义：CRLF/CR/LF 统一切行，句子内不含换行符 —— 行尾是 LF 还是 CRLF 的信息不保留`,
    `front matter 整体丢弃（${report.dropped.frontMatter} 行），其中的 title/tags 元数据不建主题`,
    `HTML 注释 / 多行注释区间整体丢弃（${report.dropped.comment} 行）；代码围栏标记丢弃（${report.dropped.fence} 行，围栏内内容保留）`,
    `排除策略（可配 scan.excludeGlobs/excludeHidden/excludeBak）：隐藏目录/文件（含 .trash-*）` +
      `${(ex.byReason.trash || 0) + (ex.byReason.hidden || 0)} 个 · *.bak/备份 ${ex.byReason.bak || 0}` +
      ` · 非扫描层 ${ex.byReason['outside-dirs'] || 0} · glob ${ex.byReason['exclude-glob'] || 0}` +
      ` · 符号链接 ${ex.byReason.symlink || 0}` +
      (corpus ? ` ｜ 全库 md ${corpus.mdTotal} 个，实际导入 ${corpus.importedFiles} 个，排除 ${corpus.excluded} 个` : ''),
    corpus
      ? `非 md 文件忽略 ${corpus.nonMdIgnored.total} 个（其中 .bak/.pre 类 ${corpus.nonMdIgnored.bak} 个）`
      : '人工调用 importFiles 未做目录扫描（excludedByPolicy 为 0）',
    `导入只认归一化精确 + 别名精确复用主题，不做模糊合并（防串主题）；相似主题见 mergeCandidates，由人/主会话裁定`,
    `泛化 trigger 过滤（task-9）：弱词表（纯数字/年份/日期/单双字英文/模板话术）+ 语料级区分度（覆盖主题数 > ${report.genericTriggerMaxTopics} 不派生，阈值与治理侧 genericTriggerMaxTopics 同源）；triggers 允许为空，不硬凑`,
    `批量事务：${report.txEnabled ? '本环境已启用 store.runInTransaction（每文件一个事务，失败整文件回滚）' : '本环境未提供 store.runInTransaction（暂逐句写；接口就绪后自动启用）'}` +
      ` ｜ 事务路径命中 ${report.txFiles} 个文件 / 回退逐句 ${report.txFallbackFiles} 个（回退应为 0）`,
    `导入期 needs_review 不封顶（Lead 裁决 A）：灰区/近重复全部入队，不挤到 dormant（demotedToDormant 仅旧封顶策略才非 0）`,
    `建主题一律走 store.seedTopic（Lead 裁决）：导入主题恒 draft、近重复/灰区进 needs_review、写入不推动自动转正；` +
      `本轮 needsReview=${report.needsReview}，队列溢出降级 dormant ${report.demotedToDormant} 条；` +
      `库内状态 ${JSON.stringify(report.topicsByState)}（导入不得出现 active）`,
    `字节/字符口径：chars 是 UTF-16 码元数（JS String.length），不是 UTF-8 字节数 —— 中文 1 字=1，emoji 等增补平面 1 字=2`,
  ];

  if (opts.collectCandidates !== false) {
    report.mergeCandidates = collectMergeCandidates(store, opts.mergeCandidateLimit || 30);
    report.triggerConflicts = collectTriggerConflicts(store, opts.triggerConflictLimit || 30);
  }
  report.elapsedMs = Date.now() - t0;
  return report;
}

/** 扫描 root（按排除策略）并导入 */
export function importDir(store, opts = {}) {
  const root = opts.root || DEFAULT_MEMORY_ROOT;
  const dirs = opts.dirs || DEFAULT_DIRS;
  const corpus = scanCorpus(root, { dirs, scan: opts.scan });
  return importFiles(store, corpus.files, {
    ...opts,
    root,
    dirs,
    corpusInfo: {
      mdTotal: corpus.mdTotal,
      importedFiles: corpus.files.length,
      excluded: corpus.excluded,
      nonMdIgnored: corpus.nonMdIgnored,
    },
  });
}

// ---------------------------------------------------------------------------
// 6. 指纹（用于"源目录只读未改动"证据）
// ---------------------------------------------------------------------------
export function fingerprint(files, opts = {}) {
  const root = opts.root || null;
  const entries = files.map((f) => {
    const abs = typeof f === 'string' ? f : f.abs;
    const rel = typeof f === 'string' ? (root ? posix(path.relative(root, abs)) : abs) : (f.rel || abs);
    const buf = fs.readFileSync(abs);
    const st = fs.statSync(abs);
    return { rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), mtimeMs: Math.round(st.mtimeMs) };
  }).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const contentHash = createHash('sha256');
  const mtimeHash = createHash('sha256');
  let bytes = 0;
  for (const e of entries) {
    bytes += e.size;
    contentHash.update(e.rel + '\0' + e.size + '\0' + e.sha256 + '\n');
    mtimeHash.update(e.rel + '\0' + e.mtimeMs + '\n');
  }
  return {
    count: entries.length,
    bytes,
    contentSha256: contentHash.digest('hex'),
    mtimeSha256: mtimeHash.digest('hex'),
    entries,
  };
}

/** 比对两个指纹：内容/ mtime 是否一致 + 差异明细 */
export function compareFingerprints(before, after) {
  const a = new Map(before.entries.map((e) => [e.rel, e]));
  const b = new Map(after.entries.map((e) => [e.rel, e]));
  const added = [], removed = [], contentChanged = [], mtimeChanged = [];
  for (const rel of b.keys()) if (!a.has(rel)) added.push(rel);
  for (const [rel, e0] of a) {
    const e1 = b.get(rel);
    if (!e1) { removed.push(rel); continue; }
    if (e1.size !== e0.size || e1.sha256 !== e0.sha256) contentChanged.push(rel);
    else if (e1.mtimeMs !== e0.mtimeMs) mtimeChanged.push(rel);
  }
  return {
    sameContent: before.contentSha256 === after.contentSha256 && before.count === after.count,
    sameMtime: before.mtimeSha256 === after.mtimeSha256,
    countBefore: before.count, countAfter: after.count,
    bytesBefore: before.bytes, bytesAfter: after.bytes,
    contentSha256Before: before.contentSha256, contentSha256After: after.contentSha256,
    added: added.slice(0, 20), removed: removed.slice(0, 20),
    contentChanged: contentChanged.slice(0, 20), mtimeChanged: mtimeChanged.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// 7. 可读报告
// ---------------------------------------------------------------------------
export function formatReportText(report, opts = {}) {
  const L = [];
  const p = (s) => L.push(s);
  p(`=== 记忆导入报告（v${report.version}｜建主题通道=${report.gate || 'seedTopic'}）===`);
  if (report.root) p(`源根目录: ${report.root}`);
  if (report.dirs && report.dirs.length) p(`扫描层: ${report.dirs.join(', ')}`);
  if (report.corpus) {
    const c = report.corpus;
    const by = report.excludedByPolicy.byReason || {};
    p(`语料: 全库 md ${c.mdTotal} → 策略排除 ${c.excluded}（` +
      `trash ${by.trash || 0} · 隐藏 ${by.hidden || 0} · bak ${by.bak || 0} · 非扫描层 ${by['outside-dirs'] || 0} · glob ${by['exclude-glob'] || 0} · 符号链接 ${by.symlink || 0}）` +
      ` → 实际导入 ${c.importedFiles} 个文件；非 md 忽略 ${c.nonMdIgnored.total} 个（.bak/.pre 类 ${c.nonMdIgnored.bak}）`);
    const topDirs = Object.entries(report.excludedByPolicy.byTopDir || {})
      .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1)).slice(0, 8);
    if (topDirs.length) p('  排除分布(Top8): ' + topDirs.map(([k, v]) => `${k}=${v}`).join(' · '));
    const samples = (report.excludedByPolicy.samples || []).slice(0, 5);
    if (samples.length) p(`  排除样例: ${samples.map((s) => s.path + '(' + s.reason + ')').join(' · ')}`);
  }
  p(`文件: ${report.files}（空 ${report.filesEmpty} / 无句 ${report.filesNoSentences} / 出错 ${report.filesErrored}）` +
    (Object.keys(report.skipReasons || {}).length ? ` 跳过原因: ${Object.entries(report.skipReasons).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''));
  p(`主题: 新建 ${report.topicsCreated} / 命中 ${report.topicsMatched} / 本轮涉及 ${report.topicsTouched} / 库内共 ${report.topicsInStore}`);
  p(`治理判定: 既有 ${report.zones.existing} · 安全 ${report.zones.safe} · 灰区 ${report.zones.gray} · 禁建 ${report.zones.forbidden}` +
    ` ｜ 进 needs_review ${report.needsReview} 条（seed-near-duplicate ${report.needsReviewByReason['seed-near-duplicate'] || 0} / seed-gray ${report.needsReviewByReason['seed-gray'] || 0}）` +
    ` · 队列溢出降级 dormant ${report.demotedToDormant} 条`);
  p(`库内状态: ${Object.entries(report.topicsByState || {}).map(([k, v]) => `${k}=${v}`).join(' / ') || '（空）'}` +
    ` ｜ topicsDraft=${report.topicsDraft}（导入建出的主题一律 draft，active 应为 0）`);
  p(`句子: 新增 ${report.sentencesAdded} / 跳过 ${report.sentencesSkipped}` +
    `（同主题已存在 ${report.skippedDuplicate} / 历史 sha ${report.skippedHistoricSha}）`);
  p(`字符: 语料 ${report.chars} / 新增 ${report.charsAdded}（UTF-16 码元数，非字节；字节 ${report.bytes}）`);
  const ts = report.triggerStats || {};
  p(`别名/triggers: 别名 +${report.aliasesAdded} / triggers +${report.triggersAdded}` +
    (ts.derived != null
      ? ` ｜ trigger 过滤: 候选 ${ts.derived} → 弱词 ${ts.weakFiltered} · 覆盖率>${report.genericTriggerMaxTopics} ${ts.genericFiltered} → 保留 ${ts.kept}`
      : ''));
  if (report.genericTriggers && report.genericTriggers.length) {
    p('  泛化 trigger Top5（覆盖率超阈值，不派生/不参与判定）: ' +
      report.genericTriggers.slice(0, 5).map((g) => `「${g.trigger}」${g.topics}主题`).join(' · '));
  }
  p(`丢弃行: 空行 ${report.dropped.blank} · front matter ${report.dropped.frontMatter} · 主题名 ${report.dropped.title}` +
    ` · 节标题 ${report.dropped.headings} · 围栏标记 ${report.dropped.fence} · 注释 ${report.dropped.comment} · 分隔线 ${report.dropped.rule}` +
    `（总行 ${report.linesTotal}）`);
  p(`合并候选: ${report.mergeCandidates.length} 对；trigger 冲突: ${report.triggerConflicts.count} 条`);
  if (report.seedConflicts.length) {
    p(`近重复/灰区样例（未自动合并，留待 user/lead 裁定）；共 ${report.needsReview} 条，列前 ${Math.min(5, report.seedConflicts.length)} 条:`);
    for (const c of report.seedConflicts.slice(0, 5)) {
      p(`  · ${c.file} → ${c.topic} ${c.topicName}（${c.zone} / ${c.reason}）候选: ` +
        `${(c.candidates || []).map((x) => `${x.id} ${x.name} sim=${x.sim}`).join(' / ') || '无'}`);
    }
  }
  if (report.mergeCandidates.length) {
    for (const c of report.mergeCandidates.slice(0, 5)) p(`  · ${c.a.id} ${c.a.name}  ⟷  ${c.b.id} ${c.b.name}  (sim=${c.sim} ${c.why})`);
  }
  if (report.triggerConflicts.count) {
    for (const c of report.triggerConflicts.sample.slice(0, 5)) p(`  · trigger「${c.trigger}」→ ${c.topics.map((x) => x.id + ' ' + x.name).join(' / ')}`);
  }
  if (report.filesErrored) {
    p(`⚠ 出错文件 ${report.filesErrored} 个（见 report.errors，不静默吞）`);
    for (const e of report.errors.slice(0, 5)) p(`  · ${e.file}: ${e.code} ${e.message}`);
  }
  p(`耗时: ${report.elapsedMs} ms`);
  if (report.limitations && report.limitations.length) {
    p('');
    p('--- 已知限制（本报告如实列出，便于核对） ---');
    for (const s of report.limitations) p(`  · ${s}`);
  }
  if (opts.perFile) {
    p('');
    p('--- 逐文件 ---');
    for (const f of report.perFile) {
      const tag = f.skipped ? `SKIP(${f.skipped})` : `${f.how === 'seeded' ? 'SEED' : String(f.how).toUpperCase()} ${f.topic} ${f.topicName} [${f.topicState}]`;
      p(`${f.added > 0 ? '+' + f.added : ' 0'}  ${f.file}  [${tag}] 句=${f.sentences} 跳过=${f.skippedExisting}` +
        (f.error ? `  ERR=${f.error.code}` : ''));
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 7b. 已有库 trigger 重算（task-9 · --retrigger）
// ---------------------------------------------------------------------------
// 只动 triggers（退役泛化词 + 补挂高区分度词），不动主题/句子/别名/状态。
// 「删除」按决策10走 retire 标记（不物理删）：activeTriggersOf 立即不再返回，审计留 topic.retire。
function topicParsedView(store, topic) {
  return { name: topic.name, sentences: (store.be.listSentences(topic.id) || []).map((r) => r.text) };
}

/** 库内 trigger 现状统计（用于 retrigger 前后对比 / 验收"泛化挂载 389→0"） */
export function retriggerStats(store, opts = {}) {
  const maxTopics = genericTriggerMaxTopics(store, opts);
  const topics = store.be.listTopics();
  const activeOf = (t) => (typeof store.activeTriggersOf === 'function' ? store.activeTriggersOf(t) : (t.triggers || []));
  const cov = new Map();      // norm -> { trigger, topics:Set }
  let activeMounts = 0;
  let sentences = 0;
  for (const t of topics) {
    sentences += (store.be.listSentences(t.id) || []).length;
    for (const tr of activeOf(t)) {
      activeMounts++;
      const n = normalizeName(tr);
      if (!n) continue;
      const e = cov.get(n) || { trigger: tr, topics: new Set() };
      e.topics.add(t.id);
      cov.set(n, e);
    }
  }
  const generic = [];
  let genericMounts = 0;
  for (const e of cov.values()) {
    const reason = isWeakTrigger(e.trigger) ? 'weak-word' : (e.topics.size > maxTopics ? 'generic-coverage' : null);
    if (!reason) continue;
    genericMounts += e.topics.size;
    generic.push({ trigger: e.trigger, coverage: e.topics.size, reason });
  }
  generic.sort((a, b) => (b.coverage - a.coverage) || (a.trigger < b.trigger ? -1 : 1));
  // Lead 验收口径的 legacy 六词（2026/徕卡一瞬/MB/原文一字未删/OA/发改委项目）
  const legacy6 = ['2026', '徕卡一瞬', 'MB', '原文一字未删', 'OA', '发改委项目'];
  const legacySix = {};
  for (const w of legacy6) { const e = cov.get(normalizeName(w)); legacySix[w] = e ? e.topics.size : 0; }
  return {
    genericTriggerMaxTopics: maxTopics,
    topics: topics.length,
    sentences,
    activeMounts,
    distinctTriggers: cov.size,
    genericMounts,
    genericTriggerCount: generic.length,
    generic: generic.slice(0, 100),
    legacySix,
  };
}

/** 生成 retrigger 计划（dry-run 用；纯读，不写库） */
export function planRetrigger(store, opts = {}) {
  const maxTopics = genericTriggerMaxTopics(store, opts);
  const keep = new Set((opts.keepTriggers || []).map((x) => normalizeName(x)).filter(Boolean));
  const topics = store.be.listTopics();
  const activeOf = (t) => (typeof store.activeTriggersOf === 'function' ? store.activeTriggersOf(t) : (t.triggers || []));
  const activeCov = new Map();
  for (const t of topics) {
    for (const tr of activeOf(t)) {
      const n = normalizeName(tr);
      if (!n) continue;
      const e = activeCov.get(n) || { trigger: tr, topics: new Set() };
      e.topics.add(t.id);
      activeCov.set(n, e);
    }
  }
  // 候选（弱词已在 deriveTriggers 内过滤；已归档主题不补挂）
  const candByTopic = new Map();
  const candCov = new Map();
  for (const t of topics) {
    const cands = t.state === 'archived' ? [] : deriveTriggers(topicParsedView(store, t), opts);
    candByTopic.set(t.id, cands);
    for (const tr of cands) {
      const n = normalizeName(tr);
      if (!n) continue;
      const e = candCov.get(n) || { trigger: tr, topics: new Set() };
      e.topics.add(t.id);
      candCov.set(n, e);
    }
  }
  const coverageOf = new Map();
  const genericNorm = new Set();
  // 覆盖数按"并集"算：已经挂在 A 主题 + 候选会挂到 B 主题 ⇒ 覆盖 = {A,B} 两个主题。
  // （若用 max(active,cand) 会把"实际会新增到多个主题"的词漏判，实测漏了 V2/v2：active 1 + 候选 5 ⇒ 实际 6）
  for (const n of new Set([...activeCov.keys(), ...candCov.keys()])) {
    const aSet = (activeCov.get(n) || { topics: new Set() }).topics;
    const cSet = (candCov.get(n) || { topics: new Set() }).topics;
    const uni = new Set([...aSet, ...cSet]);
    coverageOf.set(n, uni.size);
    if (uni.size > maxTopics) genericNorm.add(n);
  }
  const retire = [];
  const add = [];
  const perTopic = [];
  for (const t of topics) {
    const existingAll = new Set((t.triggers || []).map(normalizeName));
    const tRetire = [];
    for (const tr of activeOf(t)) {
      const n = normalizeName(tr);
      if (!n || keep.has(n)) continue;
      let reason = null;
      if (isWeakTrigger(tr)) reason = 'weak-word';
      else if (genericNorm.has(n)) reason = 'generic-coverage';
      if (reason) tRetire.push({ trigger: tr, reason, coverage: coverageOf.get(n) || 0 });
    }
    const tAdd = [];
    if (t.state !== 'archived') {
      for (const tr of candByTopic.get(t.id) || []) {
        const n = normalizeName(tr);
        if (!n || keep.has(n)) continue;
        if (isWeakTrigger(tr) || genericNorm.has(n)) continue;
        if (existingAll.has(n)) continue;     // 已挂在 triggers 数组里（含 retired）⇒ 不重复加、不复活
        tAdd.push(tr);
      }
    }
    if (tRetire.length || tAdd.length) perTopic.push({ topic: t.id, name: t.name, state: t.state, retire: tRetire, add: tAdd });
    for (const r of tRetire) retire.push({ topicId: t.id, name: t.name, ...r });
    for (const a of tAdd) add.push({ topicId: t.id, name: t.name, trigger: a });
  }
  retire.sort((a, b) => (b.coverage - a.coverage) || (a.trigger < b.trigger ? -1 : 1) || (a.topicId < b.topicId ? -1 : 1));
  const genericTriggers = [...genericNorm].map((n) => ({
    trigger: (activeCov.get(n) || candCov.get(n)).trigger,
    coverage: coverageOf.get(n),
  })).sort((a, b) => (b.coverage - a.coverage) || (a.trigger < b.trigger ? -1 : 1));
  return {
    maxTopics,
    keepTriggers: [...keep],
    topics: topics.length,
    sentenceCount: topics.reduce((n, t) => n + (store.be.listSentences(t.id) || []).length, 0),
    retire,
    add,
    perTopic,
    topicsTouched: perTopic.length,
    retireByReason: {
      'weak-word': retire.filter((x) => x.reason === 'weak-word').length,
      'generic-coverage': retire.filter((x) => x.reason === 'generic-coverage').length,
    },
    genericTriggers: genericTriggers.slice(0, 100),
  };
}

/** 执行 retrigger 计划（写库）：退役泛化 trigger + 补挂高区分度 trigger，并返回前后统计 */
export function applyRetrigger(store, plan, opts = {}) {
  const actor = opts.actor || 'lead';
  const out = { retired: 0, added: 0, errors: [], before: retriggerStats(store, opts) };
  // 批量写用一个事务（单库一次 COMMIT；失败整批回滚，不会留下半套 trigger）。
  const runTx = (fn) => (typeof store.runInTransaction === 'function' ? store.runInTransaction(fn) : fn());
  runTx(() => {
    for (const r of plan.retire) {
      try {
        const res = store.retireTrigger(r.topicId, r.trigger, { actor, reason: 'retrigger:' + r.reason });
        if (res && res.retired && !res.alreadyRetired) out.retired++;
      } catch (e) {
        out.errors.push({ phase: 'retire', topicId: r.topicId, trigger: r.trigger, code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) });
      }
    }
    for (const a of plan.add) {
      try {
        const res = store.addTriggers(a.topicId, [a.trigger], { actor });
        out.added += (res && res.added) || 0;
      } catch (e) {
        out.errors.push({ phase: 'add', topicId: a.topicId, trigger: a.trigger, code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) });
      }
    }
  });
  out.after = retriggerStats(store, opts);
  out.countsUnchanged = out.after.topics === out.before.topics && out.after.sentences === out.before.sentences;
  return out;
}

/**
 * 多轮收敛 retrigger（--apply 用）：
 *   退役会降低 trigger 覆盖率，原本因"覆盖>阈值"被过滤的候选词可能在下一轮变成可挂（≤阈值），
 *   所以单轮 plan+apply 不一定是幂等不动点。这里按 plan→apply 循环到"计划为空"（最多 4 轮）。
 */
export function retriggerRoundTrip(store, opts = {}) {
  const rounds = [];
  let totalRetired = 0;
  let totalAdded = 0;
  const before = retriggerStats(store, opts);
  for (let i = 0; i < 4; i++) {
    const plan = planRetrigger(store, opts);
    if (plan.retire.length + plan.add.length === 0) {
      rounds.push({ round: i + 1, retire: 0, add: 0, converged: true });
      break;
    }
    const res = applyRetrigger(store, plan, opts);
    totalRetired += res.retired;
    totalAdded += res.added;
    rounds.push({ round: i + 1, retire: plan.retire.length, add: plan.add.length, retired: res.retired, added: res.added, errors: res.errors.length });
    if (res.errors.length) break;
  }
  const after = retriggerStats(store, opts);
  return {
    rounds, totalRetired, totalAdded, before, after,
    countsUnchanged: after.topics === before.topics && after.sentences === before.sentences,
  };
}

// ---------------------------------------------------------------------------
// 8. CLI：node src/import.mjs --root <dir> --db <file> [--backend=sqlite|ledger|auto]
//                 [--dirs=knowledge,projects,tools,sessions] [--keep-headings] [--per-file]
//                 [--dry-run] [--no-fingerprint] [--json] [--exclude-globs=a,b]
//                 [--retrigger] [--apply] [--keep-triggers=a,b] [--max-topic-coverage=N]
// 只读源目录；导入前后各算一次源指纹并比对打印（F 组「原文件未变」证据）。
// --retrigger：对**已建库**重算 triggers（默认 dry-run；--apply 才写库；只动 triggers，不动主题/句子）。
// ---------------------------------------------------------------------------
function legacyLine(obj) {
  return Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join(' · ');
}

function isMain() {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
}

async function mainCli() {
  const argv = process.argv.slice(2);
  // 支持 --key=value 与 --key value 两种写法（--flag 单独出现视为 true）
  const argOf = (k, d) => {
    const eq = argv.find((a) => a.startsWith('--' + k + '='));
    if (eq) return eq.slice(k.length + 3);
    const idx = argv.indexOf('--' + k);
    if (idx < 0) return d;
    const next = argv[idx + 1];
    if (next != null && !String(next).startsWith('--')) return next;
    return true;
  };
  const root = path.resolve(String(argOf('root', DEFAULT_MEMORY_ROOT)));
  const dbFile = path.resolve(String(argOf('db', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.run', 'import.db'))));
  const dirsRaw = String(argOf('dirs', DEFAULT_DIRS.join(',')));
  const dirs = dirsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const backendWant = String(argOf('backend', 'auto'));
  const keepHeadings = !!argOf('keep-headings', false);
  const dryRun = !!argOf('dry-run', false);
  const perFile = !!argOf('per-file', false);
  const json = !!argOf('json', false);
  const noFingerprint = !!argOf('no-fingerprint', false);
  const excludeGlobs = String(argOf('exclude-globs', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const retrigger = !!argOf('retrigger', false);
  const applyRetriggerFlag = !!argOf('apply', false);
  const keepTriggers = String(argOf('keep-triggers', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const maxCoverageArg = argOf('max-topic-coverage', null);

  if (retrigger && !fs.existsSync(dbFile)) {
    console.error('[retrigger] 库文件不存在：' + dbFile + '（retrigger 只对已建库操作，不会建新库）');
    return 2;
  }

  const { pickBackendKind } = await import('./detect.mjs');
  const pick = backendWant === 'auto' ? pickBackendKind() : { kind: backendWant, reason: 'CLI 指定 --backend' };
  let be;
  if (pick.kind === 'sqlite') {
    const { SqliteBackend } = await import('./backend-sqlite.mjs');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    be = new SqliteBackend(dbFile);
  } else {
    const { LedgerBackend } = await import('./backend-ledger.mjs');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    be = new LedgerBackend(dbFile);
  }
  const store = new MemoryStore(be);

  if (retrigger) {
    const rrOpts = { keepTriggers, actor: String(argOf('actor', 'lead')) };
    if (maxCoverageArg != null) rrOpts.genericTriggerMaxTopics = Number(maxCoverageArg);
    const before = retriggerStats(store, rrOpts);
    const plan = planRetrigger(store, rrOpts);
    const trip = applyRetriggerFlag ? retriggerRoundTrip(store, rrOpts) : null;
    const result = trip
      ? {
        retired: trip.totalRetired, added: trip.totalAdded, errors: [],
        rounds: trip.rounds,
        after: trip.after, countsUnchanged: trip.countsUnchanged,
      }
      : null;
    if (json) {
      console.log(JSON.stringify({
        mode: applyRetriggerFlag ? 'apply' : 'dry-run',
        db: dbFile, backend: pick.kind, before,
        plan: { ...plan, perTopic: plan.perTopic.slice(0, 100) },
        result, countsUnchanged: result ? result.countsUnchanged : null,
      }, null, 2));
    } else {
      console.log(`[retrigger] 库=${dbFile} 后端=${pick.kind} 模式=${applyRetriggerFlag ? 'APPLY（写库）' : 'dry-run（不写库；加 --apply 才落库）'} 阈值=覆盖>${before.genericTriggerMaxTopics} 个主题`);
      console.log(`[retrigger] 现状: 主题 ${before.topics} / 句 ${before.sentences} / active trigger 挂载 ${before.activeMounts} / 泛化挂载 ${before.genericMounts} / 去重 trigger ${before.distinctTriggers}`);
      console.log(`[retrigger] legacy 六词挂载: ${legacyLine(before.legacySix)}`);
      console.log(`[retrigger] 计划: 退役 ${plan.retire.length} 条（weak ${plan.retireByReason['weak-word']} / 覆盖>${plan.maxTopics} ${plan.retireByReason['generic-coverage']}）/ 补挂 ${plan.add.length} 条 / 涉及主题 ${plan.perTopic.length}`);
      console.log('[retrigger] 泛化 trigger Top10（覆盖主题数）:');
      for (const g of plan.genericTriggers.slice(0, 10)) console.log(`  · 「${g.trigger}」覆盖 ${g.coverage} 主题`);
      console.log('[retrigger] 退役样例 Top10:');
      for (const r of plan.retire.slice(0, 10)) console.log(`  · ${r.topicId} ${String(r.name).slice(0, 28)} 退役「${r.trigger}」(${r.reason}, 覆盖 ${r.coverage})`);
      if (result) {
        console.log(`[retrigger] 实跑: 退役 ${result.retired} / 补挂 ${result.added} / 错误 ${result.errors.length} ｜ 轮次 ${(result.rounds || []).map((x) => x.converged ? '第' + x.round + '轮已收敛' : '第' + x.round + '轮:退' + x.retired + '/补' + x.added).join(' → ')}`);
        console.log(`[retrigger] 后: 主题 ${result.after.topics} / 句 ${result.after.sentences} / active 挂载 ${result.after.activeMounts} / 泛化挂载 ${result.after.genericMounts}`);
        console.log(`[retrigger] legacy 六词挂载(后): ${legacyLine(result.after.legacySix)}`);
        console.log(`[retrigger] 主题/句子数未变: ${result.countsUnchanged} ｜ 库完整性: ${JSON.stringify(store.verify())}`);
      }
    }
    store._close && store._close();
    if (result) return result.countsUnchanged && result.errors.length === 0 ? 0 : 1;
    return 0;
  }

  const corpus = scanCorpus(root, { dirs, scan: { excludeGlobs } });
  const before = noFingerprint ? null : fingerprint(corpus.files.map((f) => f.abs), { root });
  if (!json) {
    console.log(`[导入] 后端=${pick.kind}（${pick.reason}） 库=${dbFile}`);
    console.log(`[导入] 源=${root} 扫描层=${dirs.join(',')} ｜ 全库 md=${corpus.mdTotal} 排除=${corpus.excluded.count} 实际导入=${corpus.files.length}${dryRun ? '（dry-run，不写库）' : ''}`);
    if (before) console.log(`[导入] 源指纹(前): files=${before.count} bytes=${before.bytes} content=${before.contentSha256.slice(0, 16)} mtime=${before.mtimeSha256.slice(0, 16)}`);
  }

  const report = importDir(store, {
    root, dirs, keepHeadings, dryRun,
    scan: { excludeGlobs },
    actor: String(argOf('actor', 'plugin')),
    collectCandidates: true,
  });

  let cmp = null;
  if (!noFingerprint) {
    const corpus2 = scanCorpus(root, { dirs, scan: { excludeGlobs } });
    const after = fingerprint(corpus2.files.map((f) => f.abs), { root });
    cmp = compareFingerprints(before, after);
    if (!json) {
      console.log(`[导入] 源指纹(后): files=${after.count} bytes=${after.bytes} content=${after.contentSha256.slice(0, 16)} mtime=${after.mtimeSha256.slice(0, 16)}`);
      console.log(`[导入] 源未被改动: content=${cmp.sameContent} mtime=${cmp.sameMtime}（count ${cmp.countBefore}->${cmp.countAfter}，bytes ${cmp.bytesBefore}->${cmp.bytesAfter}）`);
      console.log(`[导入] 库完整性: ${JSON.stringify(store.verify())}`);
    }
  }
  if (json) console.log(JSON.stringify({ report, fingerprint: cmp }, null, 2));
  else {
    console.log('');
    console.log(formatReportText(report, { perFile }));
  }
  store._close && store._close();
  if (noFingerprint) return 0;
  return cmp.sameContent && cmp.sameMtime && report.filesErrored === 0 ? 0 : 1;
}

if (isMain()) {
  mainCli().then((code) => process.exit(code)).catch((e) => {
    console.error('[导入] 失败:', (e && e.stack) || e);
    process.exit(2);
  });
}
