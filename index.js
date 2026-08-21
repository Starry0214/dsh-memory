// dsh-memory: 全局自动记忆插件 v1.12.0（v1.12.0: 自动提醒查记忆/查 skill——A/B/C 判据插件化；v1.11.0: /dream 命令 + active 开关 + 整合升级；v1.4.0: 设置界面）
// v1.1.0 新增（原 v12）：memory_search 检索质量升级（参考 mimocode MiMo-Code 记忆模块移植）
//  - Unicode 分词 + OR 匹配：修复"OA日志" vs "日志填写"、"智检API" vs "REST API/推送"不命中
//  - loadKnowledgeTargets 正则放宽：收录 tools/*.md（修复 记忆插件.md/dsh.md 永远搜不到）
//  - 多命中合并 top N：不再"命中1个就 return 丢关联"，TF 加权评分 + 相对分数下限（top*0.15）过滤泛词噪音
//  - 0 结果引导文案：换罕见词 → read 直查 → 查 sessions 原文，避免模型误判"没记录过"
//  - 过期复核提醒：解析 knowledge 文件头"最后更新"日期，>180 天未更新注入提醒人工复核（内容级过期，替代不可用的 mtime）
// v11 新增：路径可移植化
//  - 移除硬编码 C:/Users/Starry 绝对路径，改用 homedir() + 环境变量推导：
//    DSH_HOME 默认 <homedir>/.dsh，可用环境变量 DSH_HOME / DSH_MEMORY_ROOT / DSH_MEMORY_BACKUP_ROOT 覆盖。
//  - 便于开源分发：任何用户克隆后按 README 安装即可，无需改代码。
// v10.5 修复：session/event 处理器内同步 agent.inject 导致 "session append cannot reenter" 重入异常
//  - 根因：compaction/summary 的 session.append 在发布窗口（appending=true）内同步派发 session/event；
//    而 agent.inject 会经 Inbox.mutate 同步 append 'agent/inbox/spliced'（dsh-agent/types/inbox.js:149）→ 重入冲突抛异常。
//  - 后果：压缩检查点提醒 + 记忆刷新提示注入失败（archivedCompactionIds 已标记，摘要不重试 → 永久丢失）。
//  - 修复：处理器同步段只做只读校验/组装，所有 agent.inject 推迟到 setTimeout(0)（发布窗口之外）执行。
// v10.4 新增：compact 后轻量记忆刷新提示
//  - compact 是上下文重置点，但记忆注入仍是会话开始快照（agent/session-start 只触发一次，compact 不重发）。
//  - compact 时追加一条轻提示：记忆可能已更新 → 用 memory_search 实时读盘；写入前先读全量避免覆盖他会话改动。
//  - 不做全量重注入：文件多数时候没变，全量重注入浪费 token 且破坏前缀缓存；轻提示成本≈0。
// v10.3 新增：多主会话去重 + 子代理精确判定
//  - 维护提醒（备份/轮转/超限整理）同实例只注入第一个顶层会话（maintenanceInjected 标志）：
//    避免多个主会话并发收到整理指令、并发 edit 同一文件。
//  - 顶层会话判定改查 SessionHeader.origin === 'subagent'（持久化可靠标记），
//    替代 v6 的 rootSessionId（"记第一个"在多主会话/主会话先销毁场景会误判）。
//  - 压缩检查点同样改 origin 判定：多个主会话的压缩摘要都归档（旧逻辑只认第一个）。
// v10.2 新增：超限治理提醒注入会话（软字节阈值 + 硬字符预算 双轨报告）
//  - CHAR_LIMIT 硬预算（global 3000 字符 / index 2000 / 摘要 1500）与 SIZE_WARN 软阈值（4608/4608/4096B）区分：
//    软阈值=该整理了（仅告警不截断），硬预算=超了注入会被 slice 截断（丢内容）。
//  - 超限提醒从 console.warn（模型不可见）改为 agent.inject（末尾，与备份/轮转同机制，不影响稳定层缓存前缀）。
//  - 注入截断处加显式注记 [注：原文 X 字符已截断，完整内容用 memory_search]，避免模型误以为"记忆就这么多"。
// v10.1 新增：index.md 超限阈值 3072B → 4608B（与 global 一致，对齐注入预算，降告警噪音）
// v10 新增：知识库自包含 —— 21 个 MEMORY-*.md 从 mimocode 目录复制到 ~/.dsh/memory/knowledge/，
//   KNOWLEDGE_ROOT 改指向 knowledge/；备份命令 Copy-Item ~/.dsh/memory/* -Recurse 即含知识库，与 mimocode 解耦。
// v9 新增：插件零写入
//  - 原因：插件 ctx.fs 走部署默认沙箱（workspace-write），写 ~/.dsh 被拒且无审批通道；审批只存在于会话工具层（write/edit/pwsh 升级重试）。
//  - 改造：备份到期 / sessions 轮转 / 压缩归档 都不再直接写文件，改为注入可执行提醒（system-reminder），
//    由会话模型执行写入——沙箱拒绝时带 sandbox_permissions 升级重试，用户点一次审批即可完成（备份=一条 Copy-Item 一次审批）。
// v8 新增：检索增强 + 备份（v9 起备份改为提醒制）
//  - memory_search 动态解析 index.md → 覆盖 21 个知识文件（mimocode/memory/projects/global/），修复索引→检索断链
//  - memory_search 未命中时执行全文关键词搜索（跨文件扫命中行，每文件最多 3 行）
//  - 记忆库自动备份：启动时距上次备份 >7 天则复制 ~/.dsh/memory/ → ~/.dsh/memory_backup/YYYYMMDD_HHMM/（.last 记录时间戳）
// 保留：v5 注入 / v6 压缩即归档 / v7 轮转+超限预警
// v5 修复：
//  - harness 是沙箱全局符号（HOST_BUILTIN_INSPECTION），不是 ctx 服务——直接用全局 harness（官方 skill 姿势）
//  - 摘要读取不依赖 fs.list（返回结构不确定），改为日期文件名直接探测（今天→回溯 7 天）
//  - 注入失败/工具注册失败都打 console.error 日志（沙箱 console 可用）
// v6 新增：压缩即归档（防丢失兜底）
//  - 监听 session/event，捕获 compaction/summary 事件（/compact 或自动压缩都会产生）
//  - 直接取事件自带的摘要文本（LLM 已生成，零额外调用成本），追加写入 sessions/今日.md 的"自动检查点"小节
//  - 只处理主会话（session-start 时记录 session.id，排除子代理压缩噪音）
//  - 同一 compactionId 只归档一次；手动摘要优先（只追加、不覆盖）
// v7 新增：记忆文件治理
//  - sessions/ 轮转：插件启动时把超过 30 天的日期摘要复制到 sessions/archive/（写文件自动建目录）并清空原文件
//  - 超限预警：注入时按 UTF-8 字节数检查（TextEncoder，沙箱无 Buffer），超阈值打 console.warn 提醒整理
// 能力：会话开始注入记忆（稳定层+动态层）、注册 memory_search 工具、压缩即归档、文件治理

// v11：可移植路径推导（开源分发友好）
//  - 优先级：环境变量 > <homedir>/.dsh 默认值
//  - Windows/Unix 通用：homedir() 跨平台；路径统一正斜杠（ctx.fs 可解析）
import { homedir } from "node:os";
import path from "node:path";
// v1.2.0：node:fs 直写压缩检查点（宿主插件真实 Node 环境，绕过 ctx.fs 沙箱，无需审批）
import fs from "node:fs";
// v1.8.0：node:zlib 原生 zstd 解压（Node 22.17+/23.3+）——漏网归档改为「提取会话 compaction 摘要」，子代理不读原始大日志
import zlib from "node:zlib";
// v1.4.0：官方设置机制（settings.yaml 命名空间，设置 UI 可改；cordis.patch.yml config 作 base 默认层）
//  - installSettingsSection: 把插件配置注册为 settings 命名空间（用户文档覆盖 base）
//  - schemastery z: DSH 配置 schema 标准（与 dsh-web-app 同源）
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

function portable(p) { return String(p).replace(/\\/g, "/"); }

const DSH_HOME = portable(process.env.DSH_HOME || path.join(homedir(), ".dsh"));
const MEMORY_ROOT = portable(process.env.DSH_MEMORY_ROOT || path.join(DSH_HOME, "memory"));
const PLUGIN_NAME = "dsh-memory";
// v8：知识库根目录（index.md 索引指向的 21 个主题文件）
// v10：知识库迁入 MEMORY_ROOT/knowledge/（自包含，备份完整；与 mimocode 解耦）
const KNOWLEDGE_ROOT = MEMORY_ROOT + "/knowledge";
// v8：备份目录与间隔（7 天）
const BACKUP_ROOT = portable(process.env.DSH_MEMORY_BACKUP_ROOT || path.join(DSH_HOME, "memory_backup"));
const BACKUP_INTERVAL_MS = 7 * 24 * 3600 * 1000;
// v11：维护提醒中的 PowerShell 命令需要 Windows 反斜杠路径（由正斜杠常量转换）
const PS_MEMORY = MEMORY_ROOT.replace(/\//g, "\\");
const PS_BACKUP = BACKUP_ROOT.replace(/\//g, "\\");

function makeId() {
  const t = Date.now().toString(16);
  const r1 = Math.floor(Math.random() * 0xffffffff).toString(16);
  const r2 = Math.floor(Math.random() * 0xffffffff).toString(16);
  const h = (t + r1 + r2).replace(/[^0-9a-f]/g, "").slice(0, 32).padEnd(32, "0");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}

function makeMessage(text) {
  return {
    id: makeId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_NAME }
  };
}

// v1.10.1：控制台输出统一时间戳（HH:MM:SS）。本文件内 console 调用已批量替换为 clog/cwarn/cerr。
// v1.12.4：pad 提升为模块级（原来只在 ts() 内部，updateMonitorSummary 引用时报 pad is not defined，监控统计推送从未生效）
const pad = (n) => String(n).padStart(2, "0");
const clog = (...a) => console.log(ts(), ...a);
const cwarn = (...a) => console.warn(ts(), ...a);
const cerr = (...a) => console.error(ts(), ...a);
function ts() {
  const d = new Date();
  return "[" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "]";
}

// v1.3.0：漏网会话检测 —— 扫描 ~/.dsh/sessions/ 下久未交互（mtime≥阈值 天）的会话
// v1.6.0：加 afterTime 界限 —— 插件启用前创建的会话不触发整合（用户要求）；
//         插件关闭期间产生的会话（创建时间在启用之后）仍会被检测 → 重新启用后"未整合范围扩大"。
// 判定"漏网"：会话创建于启用之后 + 最后一次写入距今超过阈值 + 未在记忆库落档
const STALE_NOTIFIED = new Set();  // 本实例内已提醒过的会话 id（防多会话重复提醒）
const SESSIONS_ROOT = portable(path.join(DSH_HOME, "sessions"));

// v1.12.0：自动提醒查记忆/查 skill（判断 A/B/C 插件化）——
// 不靠模型自觉，插件在 pre-step/request-error 事件里量化判断触发条件，命中才注入提醒。
// 关键词表从 index.md 自动提取（零维护）：解析 "名称 → 文件.md（描述）" 行 → 名称+描述词 = 匹配关键词。
let MEMORY_HINT_TABLE = null;            // 懒加载：[{keywords:[...], file:"MEMORY-*.md", domain:"领域名"}]
let MEMORY_HINT_TABLE_MTIME = 0;         // 缓存 index.md 的 mtime，变化才重建
const MEMORY_HINT_THROTTLE = new Map();  // sessionId -> 上次 A 类提醒时间（30 分钟节流）
const MEMORY_HINT_ERRORS = new Map();    // sessionId -> Map<签名, 次数>（B/C 判断）

// 从 index.md 自动提取"领域→记忆文件→关键词"匹配表
function buildMemoryHintTable() {
  try {
    const p = portable(MEMORY_ROOT + "/index.md");
    const st = fs.statSync(p);
    if (MEMORY_HINT_TABLE && st.mtimeMs === MEMORY_HINT_TABLE_MTIME) return MEMORY_HINT_TABLE;
    const text = fs.readFileSync(p, "utf8");
    const rows = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^-\s*(.+?)\s*→\s*(MEMORY-[^\s（(]+|[^\s（(]+\.md)\s*（([^）]*)）?/);
      if (!m) continue;
      const name = m[1].trim();
      const file = m[2].trim();
      const desc = (m[3] || "").trim();
      const keywords = new Set();
      for (const part of [name, ...desc.split(/[/、,，;；\s]+/).filter(Boolean)]) {
        if (part.length >= 2) keywords.add(part);
      }
      rows.push({ keywords, file, name });
    }
    MEMORY_HINT_TABLE = rows;
    MEMORY_HINT_TABLE_MTIME = st.mtimeMs;
    if (rows.length > 0) clog("[dsh-memory] 记忆提醒关键词表已加载（" + rows.length + " 个记忆文件映射，来源 index.md）");
    return rows;
  } catch (e) {
    return MEMORY_HINT_TABLE || [];
  }
}

// 从用户消息文本提取纯文本（ContentBlock[] → string）
function hintTextOf(messages) {
  const parts = [];
  for (const msg of messages || []) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n").slice(0, 2000);  // 只取前 2000 字符匹配（足够判断领域）
}

// 匹配：返回命中的记忆映射列表（限 top 3）
function matchMemoryHints(userText) {
  if (!userText) return [];
  const table = buildMemoryHintTable();
  const hits = [];
  for (const row of table) {
    for (const kw of row.keywords) {
      if (userText.includes(kw)) {
        hits.push(row);
        break;
      }
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

// v1.12.0：分区感知注入 —— 对标 mimocode readBudgetedSectionAware（budgeted-read.ts）
// 解析 Markdown ## 章节：预算内保所有章节标题（结构骨架），正文按章节预算均分截断，
// 换行处断（不切字）、末尾提示"完整内容用 memory_search 查"。文件再大：骨架可见，信息不黑盒。
function sectionAwareSlice(text, budgetChars, fileLabel) {
  if (!text) return { text: "", truncated: false, total: 0 };
  if (text.length <= budgetChars) return { text, truncated: false, total: text.length };
  const lines = text.split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  // 骨架：文件头 + 所有章节标题
  const skeletonParts = [...preamble];
  for (const s of sections) skeletonParts.push(s.header);
  const skeleton = skeletonParts.join("\n");
  const remaining = budgetChars - skeleton.length;
  if (remaining <= 0) {
    // 骨架都放不下 → 保开头若干行 + 提示
    return { text: skeleton.slice(0, budgetChars) + "\n[注：全文 " + text.length + " 字符，骨架已超预算；完整内容用 memory_search 查 " + fileLabel + "]", truncated: true, total: text.length };
  }
  const perSection = sections.length > 0 ? Math.floor(remaining / sections.length) : 0;
  const out = [...preamble];
  for (const s of sections) {
    out.push(s.header);
    const bodyText = s.body.join("\n");
    if (perSection > 0 && bodyText.length > perSection) {
      let cut = bodyText.slice(0, perSection);
      const nl = cut.lastIndexOf("\n");
      if (nl > 0) cut = cut.slice(0, nl);
      out.push(cut + "\n…(章节截断)");
    } else {
      out.push(bodyText);
    }
  }
  out.push("\n[注：原文 " + text.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 " + fileLabel + "]");
  return { text: out.join("\n"), truncated: true, total: text.length };
}

// v1.12.0：使用监控 —— 记录提醒/查询/错误事件，供设置界面展示 + 使用一段时间后优化。
// 数据存 .monitor.json（全量保留，无窗口限制）；设置界面显示精简汇总（monitorSummary 只读字段）。
const MONITOR_FILE = MEMORY_ROOT + "/.monitor.json";
const MONITOR_FOLLOW_WINDOW = 3;   // 提醒后 N 个工具调用内调用 memory_search/skill 视为"跟随"
let MONITOR_DATA = null;           // 懒加载
let MONITOR_DOLLAR = false;        // 写入防抖标记（避免高频工具调用频繁写盘）
let MONITOR_HINT_OPEN = null;      // 当前"待判定"的提醒：{ seq, type, domain, name }，跟随判定用
let MONITOR_HINT_OPEN_COUNT = 0;   // 提醒后的工具调用计数

function defaultMonitorData() {
  return { version: 1, installedAt: Date.now(), updatedAt: Date.now(),
    hints: { A: 0, B: 0, C: 0 },     // 提醒次数（按类型）
    byDomain: {},                     // A 类提醒按领域统计 { 领域名: 次数 }
    queries: 0,                       // memory_search 总调用数
    recentQueries: [],                // 最近查询（最多 20 条 {t, query}）
    followed: 0, ignored: 0,          // 提醒后是否被跟随（有效/忽略）
    events: [] };                     // 全量事件 {t, type, detail}（全量保留）
}

function readMonitorData() {
  if (MONITOR_DATA) return MONITOR_DATA;
  try {
    const raw = fs.readFileSync(portable(MONITOR_FILE), "utf8");
    MONITOR_DATA = Object.assign(defaultMonitorData(), JSON.parse(raw));
  } catch (e) {
    MONITOR_DATA = defaultMonitorData();
  }
  return MONITOR_DATA;
}

// 记录一个监控事件（原子更新 + 防抖写盘）
function monitorEvent(type, detail) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    d.updatedAt = Date.now();
    d.events.push({ t: d.updatedAt, type, detail });
    if (d.events.length > 2000) d.events = d.events.slice(-2000);  // 全量但上限防无限膨胀
    // 防抖写盘：最后一次调用后 500ms 落盘
    scheduleMonitorSave();
  } catch (e) { /* 监控失败不影响主功能 */ }
}

function scheduleMonitorSave() {
  if (MONITOR_DOLLAR) return;
  MONITOR_DOLLAR = true;
  setTimeout(() => {
    MONITOR_DOLLAR = false;
    try {
      const d = readMonitorData();
      fs.mkdirSync(MEMORY_ROOT.split("\\").join("/"), { recursive: true });
      fs.writeFileSync(portable(MONITOR_FILE), JSON.stringify(d));
      updateMonitorSummary();
    } catch (e) { /* 写盘失败忽略 */ }
  }, 500);
}

// 更新设置界面的只读汇总字段
function updateMonitorSummary() {
  try {
    const d = readMonitorData();
    const followRate = (d.followed + d.ignored) > 0 ? Math.round((d.followed / (d.followed + d.ignored)) * 100) : null;
    const topDomains = Object.entries(d.byDomain || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(",");
    const eventN = Array.isArray(d.events) ? d.events.length : 0;
    const updD = (d.updatedAt > 0) ? new Date(d.updatedAt) : null;
    const updTxt = updD ? pad(updD.getHours()) + ":" + pad(updD.getMinutes()) : "-";
    // 各类型提醒最近一次触发时间（从事件尾倒扫，取最后一条 hintX）
    const lastHintT = {};
    const evs = Array.isArray(d.events) ? d.events : [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const ty = evs[i] && evs[i].type;
      if (ty === "hintA" || ty === "hintB" || ty === "hintC") {
        if (lastHintT[ty] === void 0 && evs[i].t > 0) lastHintT[ty] = evs[i].t;
        if (lastHintT.hintA !== void 0 && lastHintT.hintB !== void 0 && lastHintT.hintC !== void 0) break;
      }
    }
    const hhmm = (t) => { const dt = new Date(t); return pad(dt.getHours()) + ":" + pad(dt.getMinutes()); };
    const hintTxt = "A:" + d.hints.A + (lastHintT.hintA !== void 0 ? "(" + hhmm(lastHintT.hintA) + ")" : "") +
      "/B:" + d.hints.B + (lastHintT.hintB !== void 0 ? "(" + hhmm(lastHintT.hintB) + ")" : "") +
      "/C:" + d.hints.C + (lastHintT.hintC !== void 0 ? "(" + hhmm(lastHintT.hintC) + ")" : "");
    const s = "提醒 " + hintTxt +
      " 记忆查询:" + d.queries +
      (followRate !== null ? " 跟进率:" + followRate + "%" : "") +
      (topDomains ? " 高频领域:" + topDomains : "") +
      "（累计事件 " + eventN + " · 更新 " + updTxt + "）\n" +
      "A=命中领域关键词，先查记忆再动手 · B=同一错误第2次，提醒立即查 · C=连续失败3次，强制查记忆+skill";
    // v1.12.2: register scope 无 set —— 只有 get/watch/update/replace；update 是异步 merge 写路径
    if (HOST_SETTINGS_SCOPE && typeof HOST_SETTINGS_SCOPE.update === "function") {
      clog("[dsh-memory] 推送监控汇总: " + s.slice(0, 48) + "…");
      Promise.resolve().then(() => HOST_SETTINGS_SCOPE.update({ monitorSummary: s }))
        .then(() => clog("[dsh-memory] 监控汇总推送成功"))
        .catch((err) => cwarn("[dsh-memory] 监控汇总推送失败:", err && err.message ? err.message : String(err)));
    } else {
      clog("[dsh-memory] 监控汇总未推送: scope=" + (HOST_SETTINGS_SCOPE ? String(typeof HOST_SETTINGS_SCOPE.update) : "null"));
    }
  } catch (e) { cwarn("[dsh-memory] updateMonitorSummary 异常:", e && e.message ? e.message : String(e)); }
}

// A 类提醒：记录 + 打开跟随判定窗口
function monitorHintA(domainName) {
  const d = readMonitorData();
  d.hints.A += 1;
  if (domainName) d.byDomain[domainName] = (d.byDomain[domainName] || 0) + 1;
  MONITOR_HINT_OPEN = { type: "A", domain: domainName || "?" };
  MONITOR_HINT_OPEN_COUNT = 0;
  monitorEvent("hintA", { domain: domainName || "?", time: Date.now() });
}

// B/C 类提醒：记录
function monitorHintBC(type) {
  const d = readMonitorData();
  d.hints[type] = (d.hints[type] || 0) + 1;
  monitorEvent("hint" + type, { time: Date.now() });
}

// 工具调用：记录 memory_search/skill 行为 + 跟随判定
function monitorToolCall(toolName, ...rest) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    if (toolName === "memory_search") {
      d.queries += 1;
      const q = (rest[0] && rest[0].query) || "";
      d.recentQueries.push({ t: Date.now(), query: String(q).slice(0, 60) });
      if (d.recentQueries.length > 20) d.recentQueries = d.recentQueries.slice(-20);
    }
    if (toolName === "memory_search" || toolName === "skill") {
      // 跟随判定：若有待判定提醒且在窗口内
      if (MONITOR_HINT_OPEN && MONITOR_HINT_OPEN_COUNT <= MONITOR_FOLLOW_WINDOW) {
        d.followed += 1;
        MONITOR_HINT_OPEN = null;
      }
    }
    // 每次工具调用推进窗口计数；窗口超限且仍有待判定 → 记为忽略
    if (MONITOR_HINT_OPEN) {
      MONITOR_HINT_OPEN_COUNT += 1;
      if (MONITOR_HINT_OPEN_COUNT > MONITOR_FOLLOW_WINDOW) {
        d.ignored += 1;
        MONITOR_HINT_OPEN = null;
      }
    }
    monitorEvent("tool", { name: toolName });
  } catch (e) { /* 忽略 */ }
}

function findStaleSessions(maxAgeDays, afterTime) {
  const stale = [];
  // v1.11.0：记忆暂停（active=false，afterTime 为 null）→ 不纳入任何漏网
  if (afterTime === null) return stale;
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch (e) { return stale; }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    let sdirs = [];
    try { sdirs = fs.readdirSync(path.join(SESSIONS_ROOT, ws.name), { withFileTypes: true }); } catch (e) { continue; }
    for (const s of sdirs) {
      if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
      const z = path.join(SESSIONS_ROOT, ws.name, s.name, "session.jsonl.zstd");
      let st;
      try { st = fs.statSync(z); } catch (e) { continue; }
      // v1.6.1 修正：启用界限用「会话最后交互时间」（mtime）而非创建时间——
      // 最后交互在插件最近一次启用之前的会话（含插件关闭期间结束的）不触发整合；
      // 只有最后交互在启用之后的会话才纳入漏网检测。
      if (afterTime && st.mtimeMs < afterTime) continue;
      if (st.mtimeMs < cutoff) {
        stale.push({ ws: ws.name, id: s.name, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  return stale;
}

// v1.8.0：提取会话日志的 compaction 摘要（根治 token 爆炸）——
// 解压 session.jsonl.zstd（node:zlib zstd），找 compaction/summary 事件，返回摘要文本（截断防超长）。
// 子代理只读这个摘要（几千 token），不再读原始大日志（几十 MB → 数百万 token）。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompressSessionLog(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let out = Buffer.alloc(0);
    let off = 0;
    while (off < buf.length) {
      const frame = zlib.zstdDecompressSync(buf.subarray(off));
      out = Buffer.concat([out, frame]);
      let next = -1;
      for (let i = off + 4; i < buf.length - 3; i++) {
        if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) { next = i; break; }
      }
      if (next < 0) break;
      off = next;
    }
    return out.toString("utf8");
  } catch (e) { return null; }
}
// v1.8.0：提取会话「对话消息流」（根治 token 爆炸的正式方案）——
// 解压日志后提取 user/assistant 消息的文本内容（过滤 system-reminder 注入、工具结果、chunk 噪音），
// 得到最新、紧凑、不遗漏的对话流（实测 6.37M token 原始日志 → ~12K token 消息流，缩小 ~500 倍）。
// 子代理只读消息流总结归档，不碰原始日志。每消息截断防单条超长。
function extractMessageFlow(filePath, maxChars) {
  const limit = maxChars || 8000;
  try {
    const text = decompressSessionLog(filePath);
    if (!text) return null;
    const lines = text.split("\n").filter((l) => l.trim());
    const parts = [];
    let total = 0;
    for (const l of lines) {
      let j;
      try { j = JSON.parse(l); } catch (e) { continue; }
      if (j.type === "user/message") {
        const content = j.data && j.data.content;
        if (!Array.isArray(content)) continue;
        const txt = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
        if (!txt) continue;
        // 过滤 dsh-memory 注入的 system-reminder（非用户真实交互）
        if (txt.startsWith("<system-reminder>")) continue;
        const piece = "[用户] " + txt.slice(0, 800);
        parts.push(piece); total += piece.length;
      } else if (j.type === "assistant/message") {
        const content = j.data && j.data.message && j.data.message.content;
        if (!Array.isArray(content)) continue;
        const txt = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
        if (!txt) continue;
        const piece = "[助手] " + txt.slice(0, 1000);
        parts.push(piece); total += piece.length;
      }
      if (total > limit) break; // 防超长，截断
    }
    if (parts.length === 0) return null;
    return parts.join("\n").slice(0, limit);
  } catch (e) { return null; }
}

// v1.11.0：记忆活跃界限（漏网检测过滤用）——
// enabledAt 由记忆活跃开关 active 驱动，与 DSH 进程启停解耦：
//   - active=true → enabledAt=上次启用周期时间（或安装时间），只整合此后交互的会话
//   - active=false（用户显式暂停）→ enabledAt=null，不纳入任何漏网
// 判定：会话最后交互 mtime >= enabledAt → 纳入漏网；< enabledAt → 跳过。
function getEnabledAt() {
  try {
    const raw = fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8");
    const st = JSON.parse(raw);
    if (st) {
      // enabledAt 为数字（记忆活跃中）→ 用之
      if (typeof st.enabledAt === "number" && st.enabledAt > 0) return st.enabledAt;
      // enabledAt 为 null（记忆暂停，active=false）→ 返回 null：不纳入任何漏网
      if (st.enabledAt === null) return null;
      // 老状态文件无 enabledAt 字段 → 兼容：读 lastEnabledAt/installAt
      if (typeof st.lastEnabledAt === "number" && st.lastEnabledAt > 0) return st.lastEnabledAt;
      if (st.installAt) return st.installAt;
    }
  } catch (e) { /* 无状态文件 */ }
  return Date.now();
}

// v1.10.0 性能优化：sessions/*.md 内容缓存（启动时读一次 + 写入后刷新），
// 把 sessionMentionedInMemory 从「每会话 × 每文件读盘」O(N×M) 降为「缓存 includes」O(N)。
let MEMORY_SESSIONS_INDEX = null;

function refreshMemorySessionsIndex() {
  try {
    const dir = MEMORY_ROOT + "/sessions";
    const files = fs.readdirSync(portable(dir));
    let acc = "";
    for (const fn of files) {
      if (!fn.endsWith(".md")) continue;
      try { acc += fs.readFileSync(portable(dir + "/" + fn), "utf8"); } catch (e) { /* 单文件读失败跳过 */ }
    }
    MEMORY_SESSIONS_INDEX = acc;
    return acc;
  } catch (e) { MEMORY_SESSIONS_INDEX = ""; return ""; }
}

// 会话 id 是否已出现在记忆库 sessions/ 文件中（出现过 = 曾被总结/落档，不再视为漏网）
function sessionMentionedInMemory(sessionId) {
  if (MEMORY_SESSIONS_INDEX === null) refreshMemorySessionsIndex();
  const idx = MEMORY_SESSIONS_INDEX || "";
  const idShort = sessionId.replace(/^session-/, "");
  return idx.includes(sessionId) || idx.includes(idShort);
}

// v1.3.0：可配置项（cordis.patch.yml 的 config 字段覆盖；未配置时用默认值）
//  - staleSessionDays: 漏网会话检测阈值（天），默认 5
//  - staleAction:      漏网处理动作，remind=仅注入提醒（默认）| silent=后台静默子代理总结 | approval=经用户审批后子代理总结
// v1.7.1：默认 staleAction=remind（仅提醒，不自动 spawn 子代理——实测漏网归档子代理单会话可烧数百万 token）
const DEFAULT_CFG = { staleSessionDays: 5, staleAction: "remind", integrateEnabled: false, integrateDays: 7, active: true, monitorEnabled: true };
// v1.11.0：active = 记忆活跃开关（独立于 DSH 进程启停）——
// 用户显式关掉=记忆整合暂停（enabledAt 置空）；打开=重新启用（enabledAt 刷新为当前时间）。
// DSH 重启/退出不再影响 enabledAt——「插件启停」与「DSH 进程启停」彻底解耦。
// v1.6.0：整合/漏网状态文件（模块级，供 getInstallAt 等跨作用域使用）
const INTEGRATE_STATE_FILE = MEMORY_ROOT + "/.integrate.json";
let PLUGIN_CFG = { ...DEFAULT_CFG };

// v1.4.0：settings 命名空间 schema（设置 UI 渲染 + 校验；用户文档覆盖 base）
// schemastery 语法：无 .int()/z.enum —— 整数用 number().min().max()，枚举用 union([const...])
const SETTINGS_SCHEMA = z.object({
  staleSessionDays: z.number().min(1).max(90).default(DEFAULT_CFG.staleSessionDays),
  staleAction: z.union([z.const("remind"), z.const("silent"), z.const("approval")]).default(DEFAULT_CFG.staleAction),
  // v1.5.0：定期自动整合（对标 mimocode AutoDream）
  integrateEnabled: z.boolean().default(false),          // 开关：每 integrateDays 天自动整合记忆（默认关闭，避免自动耗 token）
  integrateDays: z.number().min(1).max(90).default(7),   // 整合间隔（天）
  // v1.11.0：记忆活跃开关（独立于 DSH 进程启停）——用户显式控制；DSH 重启不改变它
  active: z.boolean().default(true),
  // v1.12.0：使用监控开关（默认开）——记录提醒/查询/错误事件到 .monitor.json，设置界面显示汇总
  monitorEnabled: z.boolean().default(true),
  // 只读：监控汇总（客户端展示），宿主写入
  monitorSummary: z.string().required(false),
  // 只读统计：漏网（未整合记忆）会话数量，由宿主在检测后写入；非用户编辑项
  // schemastery 对象字段默认可选；required(false) 显式标注
  staleCount: z.number().min(0).required(false)
});
// v1.4.0：宿主侧 settings scope（register 返回），用于写只读统计 staleCount
let HOST_SETTINGS_SCOPE = null;

// 归一化配置：settings 值或 cordis config → 合法 PLUGIN_CFG
function normalizeCfg(raw) {
  const cfg = { ...DEFAULT_CFG, ...(raw || {}) };
  if (cfg.staleAction !== "remind" && cfg.staleAction !== "silent" && cfg.staleAction !== "approval") {
    cwarn("[dsh-memory] staleAction 非法值 " + cfg.staleAction + "，回退 remind");
    cfg.staleAction = "remind";
  }
  if (!(cfg.staleSessionDays >= 1 && cfg.staleSessionDays <= 90)) cfg.staleSessionDays = DEFAULT_CFG.staleSessionDays;
  if (typeof cfg.active !== "boolean") cfg.active = DEFAULT_CFG.active;
  if (typeof cfg.monitorEnabled !== "boolean") cfg.monitorEnabled = DEFAULT_CFG.monitorEnabled;
  return cfg;
}

export default {
  inject: ["fs", "timer", "commands", "skills"],
  apply(ctx, config) {
    // v1.4.0：设置机制 —— cordis.patch.yml config 作 base 默认层，settings.yaml 用户文档覆盖。
    // 手动 register 拿到宿主 scope（写只读统计 staleCount）；无 settings 服务时回退 cordis config。
    PLUGIN_CFG = normalizeCfg(config);
    // v1.11.0：enabledAt 与 DSH 进程启停彻底解耦——
    // DSH 重启/退出不再影响 enabledAt（dispose 不再置 null）。
    // enabledAt 只由「记忆活跃开关 active」驱动：
    //   - active=true 且已有 enabledAt → 保持（DSH 重启多少次都不动）
    //   - active=true 且无 enabledAt（首次安装/历史残留）→ 设为 installAt
    //   - active=false（用户显式暂停记忆）→ enabledAt 置空（不纳入漏网）
    try {
      const now = Date.now();
      const st = readIntegrateState() || { installAt: now, lastIntegrateAt: 0 };
      if (!st.installAt) st.installAt = now;
      // 用户显式暂停记忆：enabledAt 置空，漏网不纳入
      if (PLUGIN_CFG.active === false) {
        st.enabledAt = null;
        clog("[dsh-memory] 记忆活跃开关已关，enabledAt 置空（记忆整合暂停）");
      } else if (!(typeof st.enabledAt === "number" && st.enabledAt > 0)) {
        // active=true 且无有效 enabledAt → 设 installAt（首次安装/历史残留），与进程启停无关
        st.enabledAt = st.installAt;
        clog("[dsh-memory] 记忆整合启用，enabledAt=安装时间 " + new Date(st.enabledAt).toISOString().slice(0, 19) + "（覆盖安装以来所有会话）");
      } else {
        // active=true 且已有 enabledAt → 保持，不随 DSH 启动刷新
        clog("[dsh-memory] 记忆整合持续启用中，enabledAt 保持 " + new Date(st.enabledAt).toISOString().slice(0, 19) + "（不随 DSH 启动刷新）");
      }
      delete st.lastEnabledAt;  // 旧字段清理
      writeIntegrateState(st);
    } catch (e) { /* 状态记录失败不影响功能 */ }
    // v1.10.0：启动时加载 sessions/*.md 缓存（漏网检测高性能）
    refreshMemorySessionsIndex();
    clog("[dsh-memory] sessions 索引已加载（" + (MEMORY_SESSIONS_INDEX || "").length + " 字符）");
    try {
      ctx.inject(["settings"], (sctx) => {
        try {
          HOST_SETTINGS_SCOPE = sctx.settings.register(settingsNamespace("dsh-memory"), SETTINGS_SCHEMA, {
            base: config || DEFAULT_CFG
          });
          PLUGIN_CFG = normalizeCfg(HOST_SETTINGS_SCOPE.get());
          HOST_SETTINGS_SCOPE.watch(() => {
            const next = HOST_SETTINGS_SCOPE.get();
            const prev = { ...PLUGIN_CFG };
            PLUGIN_CFG = normalizeCfg(next);
            // v1.11.0：active 开关变化驱动 enabledAt（用户显式，独立于 DSH 启停）
            try {
              const st = readIntegrateState() || {};
              const prevActive = (typeof prev.active === "boolean") ? prev.active : DEFAULT_CFG.active;
              if (prevActive !== PLUGIN_CFG.active) {
                if (PLUGIN_CFG.active === false) {
                  st.enabledAt = null;  // 用户显式暂停记忆
                  clog("[dsh-memory] 记忆活跃开关已关，enabledAt 置空（记忆整合暂停）");
                } else {
                  st.enabledAt = Date.now();  // 用户显式重新启用：刷新界限
                  clog("[dsh-memory] 记忆活跃开关已开，enabledAt 刷新=" + new Date(st.enabledAt).toISOString().slice(0, 19) + "（此后交互会话纳入漏网）");
                }
                writeIntegrateState(st);
              }
            } catch (e) { /* 开关切换失败不影响配置 */ }
            clog("[dsh-memory] 设置已更新: staleSessionDays=" + PLUGIN_CFG.staleSessionDays + ", staleAction=" + PLUGIN_CFG.staleAction + ", active=" + PLUGIN_CFG.active);
          });
          clog("[dsh-memory] 设置命名空间已注册（settings.yaml 可配置，设置界面可改）");
          // v1.12.1：启动时主动推送一次监控汇总（读磁盘历史数据），否则重启后界面一直显示"暂无统计"
          updateMonitorSummary();
        } catch (e) {
          cwarn("[dsh-memory] settings register 失败，回退 cordis config:", e && e.message ? e.message : String(e));
        }
      });
    } catch (e) {
      cwarn("[dsh-memory] settings 注入失败，回退 cordis config:", e && e.message ? e.message : String(e));
    }
    clog("[dsh-memory] 配置: staleSessionDays=" + PLUGIN_CFG.staleSessionDays + ", staleAction=" + PLUGIN_CFG.staleAction);

    // v6：主会话 id（session-start 时记录第一个，用于过滤子代理压缩事件）
    // v10.3：不再用 rootSessionId 判定"主会话"（多主会话场景会误判），改查 session.header.origin；
    // 保留 rootSessionId 仅作兼容兜底，判定主逻辑见 isTopLevelSession()
    let rootSessionId = null;
    const archivedCompactionIds = new Set();
    // v9：sessionId → agent（compaction 事件时按会话查 agent 注入提醒）
    const agentsBySession = new Map();
    // v10.3：同实例维护提醒去重——一个 DSH 实例内只注入一次（第一个顶层会话），
    // 避免多个主会话并发收到整理指令、并发 edit 同一文件
    let maintenanceInjected = false;

    // v10.3：判断是否顶层会话（主会话），排除子代理
    // 依据 SessionHeader.origin === 'subagent'（持久化标记，可靠）；header 可能缺失时退回
    // rootSessionId 兼容（老会话无 header）：第一个 session-start 视为顶层
    function isTopLevelSession(agent) {
      const s = agent && agent.session;
      if (s && s.header && s.header.origin === 'subagent') return false;
      if (s && s.header && s.header.origin !== 'subagent') return true;
      // header 缺失或 origin 未标记：用 rootSessionId 兜底（第一个启动者视为顶层）
      return rootSessionId === null || (s && s.id === rootSessionId);
    }

    // v1.10.1：#6 readText 双通道 —— 优先 ctx.fs（沙箱），失败时 node:fs 直读兜底（防沙箱限制 ~/.dsh 读导致 memory_search/注入静默失效）
    async function readText(path) {
      try {
        const target = await ctx.fs.resolve(path);
        return await ctx.fs.readText(target);
      } catch (e) {
        try {
          return fs.readFileSync(portable(path), "utf8");
        } catch (e2) {
          return null;
        }
      }
    }

    // v1.2.0：node:fs 直写 —— 宿主插件运行在真实 Node 环境（cordis 原生 import 加载），
    // 可直接写 ~/.dsh（绕过 ctx.fs 的 workspace-write 沙箱，无需模型执行/审批）。
    // 用途：压缩检查点摘要直接落盘，不再依赖"下一次模型回合"；提醒制降级为 fallback。
    // 注意：node:fs 无沙箱拦截，只用于受控路径（MEMORY_ROOT 内），且保持追加语义（先读全量）。
    function nodeFsWriteAppend(filePath, heading, body) {
      const fullPath = portable(filePath);
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      fs.mkdirSync(dir, { recursive: true });
      let existing = "";
      try {
        existing = fs.readFileSync(fullPath, "utf8");
      } catch (e) {
        existing = ""; // 文件不存在 → 新建
      }
      const block = "\n## " + heading + "\n\n" + body.trim() + "\n";
      fs.writeFileSync(fullPath, existing + block, "utf8");
      return existing.length;
    }

    function stabilize(text) {
      if (!text) return null;
      return text
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          if (/^>\s*最后更新/.test(t)) return false;
          if (/^>\s*Last updated/.test(t)) return false;
          if (/^<!--/.test(t) || /^-->$/.test(t)) return false;
          return true;
        })
        .join("\n");
    }

    // 日期格式 YYYY-MM-DD（本地时区）
    function dateStr(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }

    // 探测最近会话摘要：今天→回溯 7 天，第一个存在的文件
    async function latestSessionSummary() {
      const now = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const fname = dateStr(d) + ".md";
        const text = await readText(MEMORY_ROOT + "/sessions/" + fname);
        if (text) return { file: fname, text };
      }
      return null;
    }

    // v7：UTF-8 字节数（沙箱无 Buffer，用 TextEncoder）
    function utf8Bytes(text) {
      try {
        return new TextEncoder().encode(text).length;
      } catch (e) {
        return text.length;
      }
    }

    // v7：软性维护阈值（字节，超过=该整理了，仅告警不截断）
    const SIZE_WARN = { "global.md": 4608, "index.md": 4608, summary: 4096 }; // v9.1: global 4096→4608B、摘要 2048→4096B（与注入截断对齐降噪音）；v10.1: index 3072→4608B（中文索引 3393B≈1130 字符，远低于注入预算 2000 字符，3072 为 v7 旧值）
    // v10.2：硬性注入预算（字符数，slice 截断点）——与 SIZE_WARN（软字节）区分：
    //   SIZE_WARN 是"该整理了"的维护信号（中文 4608B≈1500字，远低于硬预算）；
    //   CHAR_LIMIT 是"超过注入会被 slice 截断"的硬上限（global 3000 字≈9KB、index 2000 字≈6KB、摘要 1500 字≈4.5KB）。
    //   软信号 + 硬预算双轨并存：软阈值提醒整理，硬预算保证不丢内容。
    const CHAR_LIMIT = { "global.md": 3000, "index.md": 2000, summary: 1500 };
    // v7：轮转阈值（30 天）
    const ROTATE_DAYS = 30;

    // v10.2：超限检查（只读）——返回软/硬双轨完整报告，供注入提醒使用
    async function checkSizeOverflow() {
      const issues = [];
      const check = async (label, key, raw) => {
        if (!raw) return;
        const bytes = utf8Bytes(raw);
        const chars = raw.length;
        const byteWarn = SIZE_WARN[key] !== undefined ? SIZE_WARN[key] : SIZE_WARN.summary;
        const charLimit = CHAR_LIMIT[key] !== undefined ? CHAR_LIMIT[key] : CHAR_LIMIT.summary;
        // 软超（字节>软阈值）或硬超（字符>硬预算）都提示；标注是否已截断
        if (bytes > byteWarn || chars > charLimit) {
          issues.push({ label, key, bytes, byteWarn, chars, charLimit, truncated: chars > charLimit });
        }
      };
      const globalRaw = await readText(MEMORY_ROOT + "/global.md");
      const indexRaw = await readText(MEMORY_ROOT + "/index.md");
      await check("global.md", "global.md", globalRaw);
      await check("index.md", "index.md", indexRaw);
      const latest = await latestSessionSummary();
      if (latest && latest.text) {
        await check("最近摘要 " + latest.file, "summary", latest.text);
      }
      return issues;
    }

    // v7：sessions/ 轮转——超过 30 天的日期摘要复制到 archive/ 并清空原文件
        // v9：sessions/ 轮转检查（只读）——返回超过 ROTATE_DAYS 天的日期摘要文件列表
    async function findOldSessions() {
      try {
        const target = await ctx.fs.resolve(MEMORY_ROOT + "/sessions");
        const entries = await ctx.fs.listDir(target);
        const now = Date.now();
        const cutoff = ROTATE_DAYS * 24 * 3600 * 1000;
        const old = [];
        for (const entry of entries) {
          const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(entry.name);
          if (!m || entry.type !== "file") continue;
          const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          if (now - d.getTime() <= cutoff) continue;
          const content = await readText(MEMORY_ROOT + "/sessions/" + entry.name);
          if (content) old.push({ name: entry.name, bytes: utf8Bytes(content) });
        }
        return old;
      } catch (e) {
        cerr("[dsh-memory] 轮转检查失败:", e && e.message ? e.message : String(e));
        return [];
      }
    }

    // v8：从 index.md 动态解析知识文件索引（行格式：- 主题 → 文件.md（描述））
    // v12：正则放宽——同时收录 MEMORY-*.md（knowledge/）与 tools/*.md（工具记忆），
    //   修复 tools/记忆插件.md、tools/dsh.md 等文件永远搜不到的漏收录 bug。
    async function loadKnowledgeTargets() {
      const indexText = await readText(MEMORY_ROOT + "/index.md");
      if (!indexText) return [];
      const targets = [];
      for (const line of indexText.split("\n")) {
        const m = /^-\s*(.+?)\s*→\s*(?:(tools|knowledge)\/)?([^\s（(]+?\.md)(?:（(.+?)）)?/.exec(line);
        if (m) {
          const dir = m[2] || "";
          const file = (dir ? dir + "/" : "") + m[3];
          targets.push({ label: m[1].trim(), file, desc: (m[4] || "").trim() });
        }
      }
      return targets;
    }

    // v12：Unicode 分词（\p{L} 支持中文，\p{N} 数字，_ 下划线；其余为分隔符）
    // 参考 mimocode fts-query.ts：查询和正文按同一规则分词。
    // 增强（v12.1）：CJK 与 ASCII 混合串拆词——"OA日志"→["OA","日志"]、"ssl证书"→["ssl","证书"]，
    //   否则混合串作为整体 token 无法命中正文里的"日志填写"/"SSL"。
    //   v12.3：中文连续段拆分策略（防常见 bigram 噪音）：
    //   - 1 字：保留（召回补充，正文权重 0.1）
    //   - 2 字：保留原样（高权重）+ 补 2 个单字（"签到"→["签到","签","到"]，召回"签字单"）
    //   - 3+ 字：保留完整段 + 首 2 字 + 尾 2 字（"长沙项目"→["长沙项目","长沙","项目"]）。
    //     不做中间滑动 bigram——"存在""系统""情况"等常见 2 字对在正文高频出现会污染所有文件
    function tokenize(text) {
      const raw = text.match(/[\p{L}\p{N}_]+/gu) || [];
      const out = [];
      for (const block of raw) {
        const parts = block.split(/(?<=[\u4e00-\u9fff\u3400-\u4dbf])(?=[^\u4e00-\u9fff\u3400-\u4dbf])|(?<=[^\u4e00-\u9fff\u3400-\u4dbf])(?=[\u4e00-\u9fff\u3400-\u4dbf])/);
        for (const p of parts) {
          if (!p) continue;
          if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(p)) {
            if (p.length === 1) {
              out.push(p);
            } else if (p.length === 2) {
              out.push(p);
              out.push(p[0]);
              out.push(p[1]);
            } else {
              out.push(p);
              out.push(p.slice(0, 2));
              out.push(p.slice(-2));
            }
          } else {
            out.push(p);
          }
        }
      }
      return out.filter((t) => t.length > 0);
    }

    // v12：简易 TF 加权评分（不引入 SQLite，纯扫描打分）——参考 mimocode BM25 + 相对分数下限思路：
    //   - label/文件名命中 token：权重高（+2.0/+1.5），主题名命中几乎必相关
    //   - 正文每命中一行 +0.5（snippet 用），最多计 8 行防长文件刷分
    //   - 单字符 token 过滤（"的""了"等噪音）
    function scoreTarget(t, text, tokens) {
      const labelLower = (t.label || "").toLowerCase();
      const fileLower = (t.file || "").toLowerCase();
      const textLower = text.toLowerCase();
      let score = 0;
      const hitLines = [];
      const lines = text.split("\n");
      for (const tk of tokens) {
        const tok = tk.toLowerCase();
        // 单字符过滤：ASCII 单字符（a/b/c）是噪音；中文单字（2字词补充的召回 token）保留但正文权重降为 0.2
        const isCjkChar = /^[\u4e00-\u9fff\u3400-\u4dbf]$/.test(tok);
        if (tok.length < 2 && !isCjkChar) continue;
        let tokenScore = 0;
        if (labelLower.includes(tok)) tokenScore += isCjkChar ? 1.0 : 2.0;
        if (fileLower.includes(tok)) tokenScore += isCjkChar ? 0.8 : 1.5;
        if (textLower.includes(tok)) tokenScore += isCjkChar ? 0.1 : 0.5;
        if (tokenScore === 0) continue;
        score += tokenScore;
        for (const line of lines) {
          if (hitLines.length >= 8) break;
          const lt = line.trim();
          if (lt && line.toLowerCase().includes(tok) && !hitLines.includes(lt)) {
            hitLines.push(lt.slice(0, 80));
          }
        }
      }
      return { score, hitLines };
    }

    // v12：知识文件过期复核（只读）——解析文件头"最后更新: YYYY-MM-DD"，
    //   超过 STALE_DAYS 天未更新的文件列入提醒清单（内容级过期信号，替代不可用的 mtime）。
    //   无日期标记的文件不提醒（不强制标注）；最多返回 5 个最旧的。
    const STALE_DAYS = 180;
    async function checkStaleKnowledge() {
      const targets = await loadKnowledgeTargets();
      const stale = [];
      for (const t of targets) {
        const text = await readText(KNOWLEDGE_ROOT + "/" + t.file);
        if (!text) continue;
        const m = text.match(/最后更新[:：]\s*(\d{4})-(\d{2})-(\d{2})/);
        if (!m) continue;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const ageDays = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
        if (ageDays > STALE_DAYS) {
          stale.push({ file: t.file, label: t.label, ageDays });
        }
      }
      return stale.sort((a, b) => b.ageDays - a.ageDays).slice(0, 5);
    }

    // v8：记忆库自动备份（距上次备份 >7 天则整库复制到 memory_backup/）
        // v9：备份到期检查（只读）——返回 {due, last}；due=true 说明需要提醒执行备份
    async function checkBackupDue() {
      try {
        const last = await readText(BACKUP_ROOT + "/.last");
        if (last) {
          const t = Number(last.trim());
          if (!isNaN(t) && Date.now() - t < BACKUP_INTERVAL_MS) {
            return { due: false, last: new Date(t) };
          }
        }
        return { due: true, last: last ? new Date(Number(last.trim())) : null };
      } catch (e) {
        cerr("[dsh-memory] 备份检查失败:", e && e.message ? e.message : String(e));
        return { due: false, last: null };
      }
    }

    // v9：组装维护提醒（备份到期 + 轮转到期），有需要时注入
    async function injectMaintenanceReminder(agent, sessionLabel) {
      const SESSION_LABEL = sessionLabel || "?";

      // v1.4.0：漏网处理子代理 —— silent 模式插件直接 spawn，完成后控制台输出结果
      // v1.7.0：① 子代理为 fresh 会话（spawn 不继承父上下文，inheritsParentContext=false，无 seed）——
      //           无需先 compact，prompt 即全部输入，紧凑省 token；
      //         ② 按工作空间合并：同 ws 的多个会话交给一个子代理处理（减少子代理数）
      async function spawnStaleSummary(group) {
        const subagents = ctx.get("subagents");
        if (!subagents || typeof subagents.start !== "function") {
          cwarn("[dsh-memory] subagents 服务不可用，silent 漏网处理降级为提醒");
          return false;
        }
        // group = { ws, sessions: [{id, mtime, size}...] }
        // v1.8.0 根治方案：插件提取每个会话的「对话消息流」（user/assistant 文本，过滤注入和工具噪音），
        // 直接内嵌进 prompt —— 子代理不读原始日志（几十 MB → 消息流几 K-tens K token，最新不遗漏）
        const ws = group.ws;
        // 提取消息流；提取失败或无内容的会话跳过
        const flowSessions = [];
        const skippedNoFlow = [];
        for (const s of group.sessions) {
          const logPath = SESSIONS_ROOT + "/" + s.ws + "/" + s.id + "/session.jsonl.zstd";
          const flow = extractMessageFlow(logPath, 8000);
          if (flow) {
            flowSessions.push({ session: s, flow: flow });
          } else {
            skippedNoFlow.push(s.id.slice(0, 12));
          }
        }
        if (skippedNoFlow.length > 0) {
          clog("[dsh-memory] 跳过无消息流会话 " + skippedNoFlow.length + " 个（解压失败或无可提取文本）: " + skippedNoFlow.join(", "));
          skippedNoFlow.forEach((id) => {
            const s = group.sessions.find((x) => x.id.startsWith(id));
            if (s) STALE_NOTIFIED.add(s.id);
          });
        }
        if (flowSessions.length === 0) {
          clog("[dsh-memory] 工作空间 " + ws + " 无可归档会话（全部无消息流）");
          return false;
        }
        // 组装：每会话的 id + 消息流
        const flowBlocks = flowSessions.map((f) =>
          "===== 会话 " + f.session.id + "（最后交互约 " + Math.max(1, Math.round((Date.now() - f.session.mtime) / 86400000)) + " 天前）=====\n" + f.flow
        ).join("\n\n");
        // v1.9.0 仿真 compact：消息流 = 对话前缀，压缩指令与 DSH 官方 compact（dsh-compaction-basic）同款
        const promptText =
          "你是 dsh-memory 记忆归档子代理，执行「仿真压缩检查点」。你的上下文只含任务清单和已提取的对话消息流（fresh 会话）。\n" +
          "**不要读取任何原始日志文件**——消息流已足够，读取原始日志会消耗巨额 token（禁止）。\n" +
          "\n===== 待归档会话的对话消息流（作为对话前缀） =====\n" +
          flowBlocks + "\n" +
          "\n===== 压缩指令（与 DSH compact 同款） =====\n" +
          "你现在充当压缩引擎。将上方对话浓缩为结构化检查点，让后续能无损恢复工作上下文。\n" +
          "输出 EXACTLY 以下 Markdown 结构（保留每节顺序；空节写 (none)，绝不丢节）：\n" +
          "## Primary Request and Intent\n- [用户原始及演变目标；逐字引用关键表述]\n" +
          "## Key Technical Concepts\n- [技术/框架/模式/约定]\n" +
          "## Files and Code\n- [精确路径：为什么重要、关键改动或片段]\n" +
          "## Errors and Fixes\n- [错误：如何解决，相关用户反馈]\n" +
          "## Pending Jobs\n- [明确要求但未完成的工作]\n" +
          "## Current Work\n- [本检查点时进行中的工作]\n" +
          "## Next Step\n- [紧接最近请求的下一步动作，或 (none)]\n" +
          "## Critical Context\n- [决策及理由、约束、用户偏好、开放问题、继续所需数据]\n" +
          "规则：\n" +
          "- 简洁工程化；逐字保留精确路径/命令/错误串/标识符/数值/函数签名。\n" +
          "- 忠实捕获用户反馈和纠正。\n" +
          "- 不要提及压缩/归档本身。\n" +
          "- 若对话已有 prior 检查点，不逐字复制：保留仍真的事实，丢弃过时的，合并为单一摘要。\n" +
          "\n===== 写入目标 =====\n" +
          "把检查点追加到 " + MEMORY_ROOT + "/sessions/ 下当日文件（如 2026-08-19.md），或按内容归属写入 projects/ 对应文件；小节标题如「归档：<会话主题>」。\n" +
          "纪律：先读目标文件全量再追加，禁止局部读+整体覆写；无归档价值的会话明确说明。\n" +
          "完成后逐会话报告：写入的文件、小节、大致字符数；未写入则说明原因。\n" +
          "只输出检查点文本并执行上述写入，不要调用其他工具或做其他操作。";
        const label = "dsh-memory-漏网归档-" + (flowSessions.length > 1 ? ws.slice(0, 24) + "-" + flowSessions.length + "会话" : flowSessions[0].session.id);
        try {
          const run = await subagents.start("spawn", {
            label: label,
            prompt: [{ type: "text", text: promptText }],
            parent: agent,
            signal: new AbortController().signal,
            // v1.10.1：#5 移除 pwsh —— 消息流已由插件提取内嵌，子代理无需执行命令；pwsh 可绕过"禁读原始日志"
            toolFilter: { allow: ["read", "write", "edit", "grep", "glob"] }
          });
          // 完成回调：控制台输出子代理结果（用户要求：漏网处理完成后可见）
          run.result.then((result) => {
            const outText = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
            clog("[dsh-memory] 漏网归档完成: " + label + "（" + flowSessions.length + " 个会话, stopReason=" + result.stopReason + ", 输出 " + outText.length + " 字符）");
            if (outText.length > 0 && outText.length <= 800) {
              clog("[dsh-memory] 归档报告: " + outText.replace(/\n/g, " | "));
            }
          }).catch((e) => {
            cwarn("[dsh-memory] 漏网归档子代理失败: " + label + " - " + (e && e.message ? e.message : String(e)));
          });
          clog("[dsh-memory] 已发起漏网归档子代理: " + label + "（" + flowSessions.length + " 个会话, 后台执行中）");
          return true;
        } catch (e) {
          cwarn("[dsh-memory] 漏网子代理启动失败: " + label + " - " + (e && e.message ? e.message : String(e)));
          return false;
        }
      }
      const parts = [];

      const backup = await checkBackupDue();
      if (backup.due) {
        const lastTxt = backup.last
          ? backup.last.getFullYear() + "-" + String(backup.last.getMonth() + 1).padStart(2, "0") + "-" + String(backup.last.getDate()).padStart(2, "0") + " " + String(backup.last.getHours()).padStart(2, "0") + ":" + String(backup.last.getMinutes()).padStart(2, "0")
          : "从未备份";
        parts.push(
          "【dsh-memory 备份提醒】记忆库上次备份：" + lastTxt + "（超过 7 天）。请在本次会话执行备份：\n" +
          "写 ~/.dsh 若被沙箱拒绝，用 pwsh 工具带 sandbox_permissions danger-full-access + justification 升级重试（会弹审批，点允许即可）。\n" +
          "执行命令（pwsh）：\n" +
          "$stamp = Get-Date -Format 'yyyyMMdd_HHmm'; $dst = '" + PS_BACKUP + "\\' + $stamp; New-Item -ItemType Directory -Force -Path $dst | Out-Null; Copy-Item '" + PS_MEMORY + "\\*' -Destination ($dst + '\\') -Recurse -Force; Set-Content -Path '" + PS_BACKUP + "\\.last' -Value ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())\n" +
          "完成后确认日志出现备份成功输出。"
        );
      }

      const oldSessions = await findOldSessions();
      if (oldSessions.length > 0) {
        const names = oldSessions.map((s) => s.name).join("', '");
        parts.push(
          "【dsh-memory 轮转提醒】以下会话摘要超过 " + ROTATE_DAYS + " 天，请归档到 sessions/archive/ 并清空原文件（写 ~/.dsh 若被拒，同上升级审批）：\n" +
          "执行命令（pwsh）：\n" +
          "foreach ($f in @('" + names + "')) { $s = '" + PS_MEMORY + "\\sessions\\' + $f; Copy-Item $s '" + PS_MEMORY + "\\sessions\\archive\\' -Force; Set-Content -Path $s -Value '' }\n" +
          "（共 " + oldSessions.length + " 个，合计 " + oldSessions.reduce((a, s) => a + s.bytes, 0) + "B）"
        );
      }

      // v10.2：超限治理提醒（软字节阈值 + 硬字符预算 双轨报告）
      const sizeIssues = await checkSizeOverflow();
      if (sizeIssues.length > 0) {
        const lines = sizeIssues.map((i) => {
          const status = i.truncated
            ? "⚠️ 字符超硬预算，注入已截断（完整内容可用 memory_search 读取）"
            : "⚠️ 字节超软阈值（未截断，但建议整理）";
          return "- " + i.label + "：字节 " + i.bytes + "B（软阈值 " + i.byteWarn + "B）/ 字符 " + i.chars + "（硬预算 " + i.charLimit + "）→ " + status;
        });
        const suggest = sizeIssues.some((i) => i.key === "summary")
          ? "摘要精简：细节提升到 knowledge/ 或 projects/ 对应文件，sessions/ 当日文件只留 200-400 字要点+指向"
          : "global/index 精简：把可下沉的踩坑/配置/清单提升到 knowledge/，稳定层只留高频通用要点";
        parts.push(
          "【dsh-memory 超限整理提醒】以下记忆文件超限（阈值=软信号，预算=硬截断）：\n" +
          lines.join("\n") + "\n" +
          "处理建议：\n1. " + suggest + "；\n2. 用 edit 原位精简（先读全量，禁止局部读+整体覆写）；\n3. 目标 = 字节 < 软阈值 且 字符 < 硬预算。写 ~/.dsh 被拒时带 sandbox_permissions 升级重试。"
        );
      }

      // v12：知识文件过期复核提醒（解析文件头"最后更新"日期，>180 天未更新列入）
      const stale = await checkStaleKnowledge();
      if (stale.length > 0) {
        const staleLines = stale.map((s) => "- " + s.label + " → " + s.file + "（" + s.ageDays + " 天未更新）");
        parts.push(
          "【dsh-memory 过期复核提醒】以下知识文件超过 " + STALE_DAYS + " 天未更新（依据文件头「最后更新」日期），请人工复核内容是否仍有效：\n" +
          staleLines.join("\n") + "\n" +
          "处理：仍有效 → 更新文件头日期；已过时 → 精简归档或删除（文件删除后索引自动失效，无需其他操作）。写 ~/.dsh 被拒时同上升级审批。"
        );
      }

      // v1.3.0：漏网会话处理（久未交互且未落档的会话）——v1.4.0 按 staleAction 分派
      //  silent: 插件直接 spawn 子代理总结（后台，完成后控制台输出）
      //  remind / approval: 注入提醒（approval 文案带确认引导）
      try {
        // v1.6.0：installAt 界限 —— 插件启用前创建的会话不触发整合
        const staleSessions = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
          .filter((s) => !STALE_NOTIFIED.has(s.id) && !sessionMentionedInMemory(s.id));
        if (staleSessions.length > 0) {
          if (PLUGIN_CFG.staleAction === "silent") {
            // 静默模式：直接发起子代理（不注入提醒），完成后控制台输出归档结果。
            // v1.7.0：按工作空间分组（同 ws 会话合并到一个子代理）+ 每批最多 MAX_STALE_GROUPS 组，
            //         剩余组留待下次（避免一次性 spawn 过多子代理刷爆 token）
            const MAX_STALE_GROUPS = 3;
            // 按 ws 分组
            const groups = new Map();
            for (const s of staleSessions) {
              if (!groups.has(s.ws)) groups.set(s.ws, []);
              groups.get(s.ws).push(s);
            }
            const groupList = Array.from(groups.entries()).map(([ws, sess]) => ({ ws, sessions: sess }));
            const batchGroups = groupList.slice(0, MAX_STALE_GROUPS);
            const restGroups = groupList.slice(MAX_STALE_GROUPS);
            const batchSessions = batchGroups.reduce((a, g) => a + g.sessions.length, 0);
            clog("[dsh-memory] 漏网会话 " + staleSessions.length + " 个（" + groupList.length + " 个工作空间），本批发起 " + batchGroups.length + " 个子代理归档 " + batchSessions + " 个会话" + (restGroups.length > 0 ? "（剩余 " + restGroups.reduce((a, g) => a + g.sessions.length, 0) + " 个留待下次）" : ""));
            for (const g of batchGroups) {
              try { await spawnStaleSummary(g); } catch (e) { cwarn("[dsh-memory] 归档发起异常:", e && e.message ? e.message : String(e)); }
            }
            batchGroups.forEach((g) => g.sessions.forEach((s) => STALE_NOTIFIED.add(s.id)));
            // 剩余组不标记 → 下次 session-start/整合检查时再处理
            if (restGroups.length > 0) {
              clog("[dsh-memory] 剩余 " + restGroups.reduce((a, g) => a + g.sessions.length, 0) + " 个漏网会话将在下次检查时处理");
            }
          } else {
            const lines = staleSessions.map((s) => {
              const days = Math.max(1, Math.round((Date.now() - s.mtime) / 86400000));
              return "- " + s.id + "（工作目录 " + s.ws.slice(0, 40) + "…，最后活动约 " + days + " 天前，日志 " + s.size + "B）";
            });
            const actionTxt =
              PLUGIN_CFG.staleAction === "approval"
                ? "审批模式：请确认是否对以下会话发起子代理总结并写入 memory/（回复确认后执行）。"
                : "处理（可选，由你决定）：若其中某个会话有值得归档的内容，可让我 review 其原始日志并总结进 memory/；若无需归档可忽略。";
            parts.push(
              "【dsh-memory 漏网会话提醒】检测到 " + staleSessions.length + " 个会话超过 " + PLUGIN_CFG.staleSessionDays + " 天无交互、且其内容未在记忆库 sessions/ 中落档（可能从未被总结）：\n" +
              lines.join("\n") + "\n" +
              actionTxt + "\n" +
              "（原始日志：~/.dsh/sessions/<工作目录>/<会话id>/session.jsonl.zstd；同实例内只提示一次）"
            );
            staleSessions.forEach((s) => STALE_NOTIFIED.add(s.id));
          }
          // v1.4.0：更新只读统计（设置界面显示"未整合记忆会话数"）
          try {
            if (HOST_SETTINGS_SCOPE && typeof HOST_SETTINGS_SCOPE.update === "function") {
              const total = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt()).filter((s) => !sessionMentionedInMemory(s.id)).length;
              HOST_SETTINGS_SCOPE.update({ staleCount: total }).catch(() => {});
            }
          } catch (e) { /* 统计更新失败不影响主流程 */ }
        }
      } catch (e) {
        cwarn("[dsh-memory] 漏网会话检测失败:", e && e.message ? e.message : String(e));
      }

      if (parts.length === 0) return;
      agent.inject(makeMessage(
        "<system-reminder>\n以下为 dsh-memory 维护提醒（写入 ~/.dsh 需要一次审批，频率很低）：\n" + parts.join("\n\n") + "\n</system-reminder>"
      ));
      clog("[dsh-memory] 已注入维护提醒（" + parts.length + " 项）[会话: " + SESSION_LABEL + "]");
    }

    // v1.4.0：会话标识（日志关联用）—— 工作目录最后一段 + session id 前 8 位
    function sessionLabelOf(agent) {
      try {
        const s = agent && agent.session;
        const id = (s && s.id) || agent.sessionId || "";
        const short = String(id).replace(/^session-/, "").slice(0, 8);
        const cwd = (s && s.header && s.header.cwd) || (s && s.cwd) || "";
        const dir = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : "";
        return (dir ? dir + "·" : "") + short;
      } catch (e) { return "?"; }
    }

    ctx.on("agent/session-start", (payload) => {
      const agent = payload.agent;
      if (!agent || typeof agent.inject !== "function") {
        cerr("[dsh-memory] session-start: agent.inject 不可用");
        return;
      }
      // v1.4.0：本会话标识（所有注入日志关联显示）
      const SESSION_LABEL = sessionLabelOf(agent);
      // v6：记录主会话 id；v9：记录 sessionId → agent 映射（压缩检查点注入用）
      // v10.3：agentsBySession 只记顶层会话（子代理压缩不归档）；rootSessionId 仅兜底记录第一个
      if (agent.session && agent.session.id) {
        if (rootSessionId === null) rootSessionId = agent.session.id;
        if (isTopLevelSession(agent)) {
          agentsBySession.set(agent.session.id, agent);
        }
      }
      (async () => {
        try {
          // 消息A：稳定层
          const globalRaw = await readText(MEMORY_ROOT + "/global.md");
          const indexRaw = await readText(MEMORY_ROOT + "/index.md");
          const globalMd = stabilize(globalRaw);
          const indexMd = stabilize(indexRaw);
          // v7：超限预警（提醒该整理了）
          if (globalRaw && utf8Bytes(globalRaw) > SIZE_WARN["global.md"]) {
            cwarn("[dsh-memory] global.md 超限 " + utf8Bytes(globalRaw) + "B（阈值 " + SIZE_WARN["global.md"] + "B），建议整理提升[会话: " + SESSION_LABEL + "]");
          }
          if (indexRaw && utf8Bytes(indexRaw) > SIZE_WARN["index.md"]) {
            cwarn("[dsh-memory] index.md 超限 " + utf8Bytes(indexRaw) + "B（阈值 " + SIZE_WARN["index.md"] + "B），建议精简[会话: " + SESSION_LABEL + "]");
          }
          const stableParts = [];
          if (globalMd) {
            // v1.12.0：分区感知注入（保章节骨架+按章截断），不丢结构
            const g = sectionAwareSlice(globalMd, CHAR_LIMIT["global.md"], "global");
            stableParts.push("【全局记忆·用户画像】\n" + g.text);
          }
          if (indexMd) {
            // v1.12.0：分区感知注入
            const i = sectionAwareSlice(indexMd, CHAR_LIMIT["index.md"], "index");
            stableParts.push("【记忆索引】\n" + i.text);
          }
          if (stableParts.length > 0) {
            agent.inject(makeMessage(
              "<system-reminder>\n以下为跨会话持久记忆（dsh-memory 稳定层，自动注入）。按需引用；更具体细节请调用 memory_search 工具。\n" + stableParts.join("\n\n") + "\n</system-reminder>"
            ));
            clog("[dsh-memory] 已注入稳定层 (" + stableParts.length + " 段)[会话: " + SESSION_LABEL + "]");
          } else {
            cwarn("[dsh-memory] 稳定层为空（global/index 读取失败）");
          }

          // 消息B：动态层（最近摘要）
          const latest = await latestSessionSummary();
          if (latest && latest.text) {
            // v7：摘要超限预警
            if (utf8Bytes(latest.text) > SIZE_WARN.summary) {
              cwarn("[dsh-memory] 摘要 " + latest.file + " 超限 " + utf8Bytes(latest.text) + "B（阈值 " + SIZE_WARN.summary + "B），建议精简[会话: " + SESSION_LABEL + "]");
            }
            const sumText = latest.text.slice(0, CHAR_LIMIT.summary);
            const sumNote = latest.text.length > CHAR_LIMIT.summary
              ? "\n[注：摘要原文 " + latest.text.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 " + latest.file + "]"
              : "";
            agent.inject(makeMessage(
              "<system-reminder>\n【上次会话摘要】（" + latest.file + "，衔接上次的下一步行动）\n" + sumText + sumNote + "\n</system-reminder>"
            ));
            clog("[dsh-memory] 已注入摘要: " + latest.file + "[会话: " + SESSION_LABEL + "]");
          } else {
            cwarn("[dsh-memory] 未找到会话摘要");
          }

          // 消息C：v9 维护提醒（备份到期 / 轮转到期 / 超限整理，只读检查后注入）
          // v10.3：同实例只对第一个顶层会话注入——避免多个主会话/子代理并发收到整理指令
          if (isTopLevelSession(agent) && !maintenanceInjected) {
            maintenanceInjected = true;
            await injectMaintenanceReminder(agent, SESSION_LABEL);
          }
        } catch (e) {
          cerr("[dsh-memory] 注入异常:", e && e.message ? e.message : String(e));
        }
      })();
    });

    // v1.12.0：自动提醒查记忆/查 skill（判断 A）——
    // agent/pre-step 每轮模型请求前触发，payload 含 messages（用户消息）。命中已知领域 → 注入提醒。
    // waterfall 语义：必须 await next() 保持链路；判断极轻（内存 Set includes）；节流防刷屏。
    ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
      try {
        const decision = await next();
        // 判断 A：只在每轮第一条用户消息（step 1）做，命中已知领域才提醒
        if (step !== 1 || !agent || typeof agent.inject !== "function") return decision;
        const sid = (agent.session && agent.session.id) || "?";
        // 节流：每会话每 3 次用户输入提醒 1 次（计数器，非时间）
        const c3 = (MEMORY_HINT_THROTTLE.get(sid) || 0) + 1;
        MEMORY_HINT_THROTTLE.set(sid, c3);
        if (c3 % 3 !== 0) return decision;
        const userText = hintTextOf(messages);
        if (!userText) return decision;
        // 记忆命中才继续（不命中不提示、不查 skill）
        const memHits = matchMemoryHints(userText);
        if (memHits.length === 0) return decision;
        // 记忆命中 → 顺便查相关 skill（只在命中记忆时提示，避免误提醒）
        const skillHits = [];
        try {
          const skills = await ctx.skills.list();
          const words = userText.match(/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
          for (const s of skills || []) {
            const hay = ((s.name || "") + " " + (s.description || "") + " " + (s.whenToUse || "")).toLowerCase();
            for (const w of words.slice(0, 12)) {
              if (w.length >= 2 && hay.includes(w.toLowerCase())) { skillHits.push(s.name); break; }
            }
            if (skillHits.length >= 3) break;
          }
        } catch (e) { /* skills 服务不可用则只给记忆提示 */ }

        // 组装提醒：记忆命中为必须，skill 命中为附带
        const memLines = memHits.map(h => "- 记忆: memory_search " + JSON.stringify(h.name) + "（" + h.file + "，踩坑/现成脚本/约定）").join("\n");
        const skillLines = skillHits.length > 0 ? "\n" + skillHits.map(s => "- skill: 技能目录加载 " + s + "（SKILL.md）").join("\n") : "";
        const hintText = "<system-reminder>\n【dsh-memory 提示】此任务可能涉及已知领域，建议先查再动手：\n" + memLines + skillLines + "\n（纯读零成本；若无关可忽略本条）\n</system-reminder>";
        // 监控：记录 A 类提醒（打开跟随判定窗口）
        monitorHintA(memHits[0] && memHits[0].name ? memHits[0].name : "?");
        // setTimeout(0) 推迟注入，避免 pre-step 窗口内重入
        setTimeout(() => { try { agent.inject(makeMessage(hintText)); } catch (e) {} }, 0);
        return decision;
      } catch (e) {
        return next ? await next() : undefined;
      }
    });
ctx.on("tools/result", (exec, result) => {
      // v1.12.0：监控记录 + 判断 B/C
      try {
        if (!exec || !result) return;
        const toolName = exec.tool || exec.name || "other";
        // 1) 监控：记录工具调用；memory_search/skill 触发查询统计与跟随判定
        if (toolName === "memory_search") {
          const q = (exec.input && (exec.input.query || exec.input.name)) ? String(exec.input.query || exec.input.name) : "";
          monitorToolCall("memory_search", { query: q });
        } else if (toolName === "skill") {
          monitorToolCall("skill");
        } else {
          monitorToolCall(toolName);
        }
        // 2) 判断 B/C：仅工具执行失败时
        if (!result.isError) return;
        const agent = exec.agent;
        if (!agent || typeof agent.inject !== "function") return;
        const sid = (agent.session && agent.session.id) || "?";
        let raw = "";
        if (Array.isArray(result.content)) {
          raw = result.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join(" ");
        }
        if (!raw) { try { raw = JSON.stringify(result.value || result).slice(0, 300); } catch (e) { raw = "tool-error"; } }
        raw = raw.slice(0, 150);
        if (!raw.trim()) return;
        const sig = raw.replace(/\d+/g, "N").replace(/\s+/g, " ").trim();
        if (!sig) return;
        let counts = MEMORY_HINT_ERRORS.get(sid);
        if (!counts) { counts = new Map(); MEMORY_HINT_ERRORS.set(sid, counts); }
        const c = (counts.get(sig) || 0) + 1;
        counts.set(sig, c);
        if (counts.size > 50) { for (const k of counts.keys()) { if (counts.get(k) < c) counts.delete(k); } }
        if (c === 2) {
          monitorHintBC("B");
          const hint = "<system-reminder>\n【dsh-memory 提示】工具报错重复出现（" + raw.slice(0, 80) + "）——大概率是以前踩过的坑。建议先 memory_search 搜该错误串 + 技能目录查相关 skill，再继续。\n</system-reminder>";
          setTimeout(() => { try { agent.inject(makeMessage(hint)); } catch (e) {} }, 0);
        } else if (c === 3) {
          monitorHintBC("C");
          const hint = "<system-reminder>\n【dsh-memory 提示】同一工具错误已连续出现 3 次且未见根因——暂停硬试，强制建议：memory_search 搜该错误串 + 加载相关 skill（记忆里有踩坑记录大概率直接给出解法）。\n</system-reminder>";
          setTimeout(() => { try { agent.inject(makeMessage(hint)); } catch (e) {} }, 0);
        }
      } catch (e) { /* 监控/统计失败不影响会话 */ }
    });
ctx.on("session/event", (session, event) => {
      try {
        if (!event || event.type !== "compaction/summary") return;
        // 只处理顶层主会话（排除子代理）——v10.3 改查 header.origin，多主会话都归档
        if (session.header && session.header.origin === 'subagent') return;
        const data = event.data || {};
        const compactionId = data.compactionId;
        if (!compactionId || archivedCompactionIds.has(compactionId)) return;
        const blocks = data.summary;
        if (!Array.isArray(blocks) || blocks.length === 0) return;
        const text = blocks
          .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
          .join("\n")
          .trim();
        if (!text) return;
        archivedCompactionIds.add(compactionId);
        const fname = dateStr(new Date()) + ".md";

        // v1.2.0：node:fs 直写优先——摘要直接落盘 sessions/今日.md（真实 Node 环境，无沙箱限制）。
        // 不依赖 agent：即使找不到会话 agent（会话已结束/归档），摘要也已落盘，不丢记忆。
        // 成功 → 跳过提醒注入（零上下文成本、零缓存影响）；失败 → 回退 v9 提醒制（模型执行）。
        let directWritten = false;
        try {
          const marker = "<!-- compaction: " + compactionId + " -->";
          const targetPath = MEMORY_ROOT + "/sessions/" + fname;
          const targetFull = portable(targetPath);
          // 幂等：文件已含该 marker（插件重启/多会话并发）→ 跳过直写，视为已落盘
          const existing = (() => {
            try { return fs.readFileSync(targetFull, "utf8"); } catch (e) { return ""; }
          })();
          if (existing.includes(marker)) {
            directWritten = true;
            clog("[dsh-memory] 整合完成（幂等跳过）sessions/" + fname + "，大小 " + fs.statSync(targetFull).size + "B (" + compactionId + ")");
          } else {
            const beforeLen = nodeFsWriteAppend(
              targetPath,
              "自动检查点（压缩归档）",
              marker + "\n\n" + text.slice(0, 1500)
            );
            directWritten = true;
            clog("[dsh-memory] 完成整合 sessions/" + fname + "，大小 " + fs.statSync(targetFull).size + "B（新增摘要 " + text.slice(0, 1500).length + " 字符，追加前 " + beforeLen + " 字符）");
            // v1.10.0：直写后刷新 sessions 索引缓存（新摘要立即可见，漏网检测不误判）
            refreshMemorySessionsIndex();
          }
        } catch (e) {
          cwarn("[dsh-memory] node:fs 直写失败，回退提醒制:", e && e.message ? e.message : String(e));
        }

        // v9：找到该会话的 agent，注入落盘提醒（仅直写失败时）或刷新提示（直写成功时）
        const agent = agentsBySession.get(session.id);
        if (!agent || typeof agent.inject !== "function") {
          if (directWritten) {
            clog("[dsh-memory] 压缩检查点已直写（会话 agent 不可用，无需注入提醒）");
          } else {
            cwarn("[dsh-memory] 压缩检查点：直写失败且未找到会话 agent，摘要未落盘");
          }
          return;
        }
        const reminder =
          "<system-reminder>\n【dsh-memory 压缩检查点】检测到压缩事件（" + compactionId + "），以下为自动生成的会话摘要，请将其追加到记忆库 " +
          "sessions/" + fname + " 的末尾（若文件不存在则创建；已有内容先读全量再追加，禁止局部读+整体覆写）。\n" +
          "写入 ~/.dsh 若被沙箱拒绝，用 write/edit 工具带 sandbox_permissions danger-full-access + justification 升级重试（弹审批，点允许即可）。\n" +
          "小节标题建议：## 自动检查点（压缩归档）\n\n" +
          text.slice(0, 1500) +
          "\n</system-reminder>";

        // v10.4：轻量记忆刷新提示——compact 是上下文重置点，记忆注入仍是会话开始快照；
        // 提示模型"记忆可能已更新"，需要最新内容时用 memory_search 实时读盘。
        // 不做全量重注入（成本高且多数时候文件没变）；只注入一行轻提示 + 可查清单。
        const refreshNote =
          "<system-reminder>\n【dsh-memory 记忆刷新提示】会话开始后，记忆库文件（global.md / index.md / knowledge/ / projects/ / sessions/）可能已被其他会话或本会话更新。\n" +
          "当前上下文中注入的记忆是会话开始时的快照。如需最新内容，用 memory_search 工具实时查询（如 memory_search 查 global / index / 具体主题）；\n" +
          "也可用 read 工具直接读 ~/.dsh/memory/ 下文件。\n" +
          "若你正准备写入/追加记忆（如本压缩检查点摘要），先 memory_search 或 read 读全量确认现状，避免覆盖其他会话的最新改动。\n</system-reminder>";

        // v10.5：session/event 在 session.append 发布窗口（appending=true）内同步派发；
        // 此时任何二次 session.append（agent.inject 经 Inbox.mutate 会 append 'agent/inbox/spliced'）
        // 都会触发 "session append cannot reenter" 重入异常，导致提醒注入失败、摘要永久丢失。
        // 故所有 inject 推迟到 setTimeout(0)（发布窗口之外的 macrotask）执行。
        const targetAgent = agent;
        setTimeout(() => {
          try {
            if (directWritten) {
              // v1.2.0：已直写，只注入轻量刷新提示（提醒制不再需要）
              targetAgent.inject(makeMessage(refreshNote));
              clog("[dsh-memory] 已注入记忆刷新提示（compact 后，检查点已直写）");
            } else {
              targetAgent.inject(makeMessage(reminder));
              clog("[dsh-memory] 已注入压缩检查点提醒（" + text.length + " 字符，目标 sessions/" + fname + "）");
              targetAgent.inject(makeMessage(refreshNote));
              clog("[dsh-memory] 已注入记忆刷新提示（compact 后）");
            }
          } catch (e) {
            cerr("[dsh-memory] 压缩提醒延迟注入失败:", e && e.message ? e.message : String(e));
          }
        }, 0);
      } catch (e) {
        cerr("[dsh-memory] session/event 处理异常:", e && e.message ? e.message : String(e));
      }
    });

// 注册 memory_search：宿主插件必须用 ctx.tools 服务注册（harness 是动态插件沙箱专属，宿主插件拿不到）
    const toolSvc = ctx.get("tools");
    if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "memory_search",
          description: "搜索全局记忆库（~/.dsh/memory/）。参数 query：主题关键词或记忆文件相对路径（如 OA日志、长沙项目、global、index）。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "主题关键词或记忆文件相对路径" }
            },
            required: ["query"]
          },
          output: {
            schema: { type: "string" },
            render(_a, v) { return [{ type: "text", text: String(v) }] }
          },
          async execute(args) {
            const q = (args.query || "").trim();
            if (!q) return "用法：memory_search(query)。query = 主题关键词 / 文件名 / 记忆条目（如 OA日志、智检API、长沙项目、金额）。";
            // 固定记忆库目标
            const fixedTargets = [
              ["全局画像", "global.md"],
              ["记忆索引", "index.md"],
              ["长沙项目", "projects/长沙交易场地智能化系统升级改造.md"],
              ["机器管项目", "projects/机器管招投标系统功能完善与性能提升项目.md"],
              ["发改委项目", "projects/湖南省发改委行政监督平台升级项目.md"],
              ["知识库管线工具", "tools/知识库处理管线.md"],
              ["AI问答助手原型", "tools/AI问答助手原型.md"],
              ["项目文档脚本", "tools/项目文档生成脚本组.md"]
            ];
            // v8：动态知识文件目标（来自 index.md 的主题文件，v12 起含 tools/）
            const knowledgeTargets = await loadKnowledgeTargets();
            // v12：合并目标并去重（fixedTargets 与 knowledgeTargets 的 tools/ 文件可能重叠，
            //   如 项目文档生成脚本组 同时出现在两处 → 按 rel 去重，保留 label 更具体的）
            const seenRel = new Set();
            const targets = [];
            for (const [label, rel] of fixedTargets) {
              if (seenRel.has(rel)) continue;
              seenRel.add(rel);
              targets.push({ label, file: rel, rel });
            }
            for (const k of knowledgeTargets) {
              const rel = k.file.startsWith("tools/") ? MEMORY_ROOT + "/" + k.file : KNOWLEDGE_ROOT + "/" + k.file;
              if (seenRel.has(rel)) continue;
              seenRel.add(rel);
              targets.push({ label: k.label, file: k.file, rel, desc: k.desc });
            }
            // v12：精确文件名/路径优先——query 直接等于某目标文件时返回全文（保留 v8 原行为）
            for (const t of targets) {
              if (q === t.file || q === t.rel || q.endsWith("/" + t.file)) {
                const fullText = await readText(t.rel);
                if (fullText) return "【" + t.label + "】" + t.file + "\n" + fullText.slice(0, 4000);
              }
            }
            // v12：Unicode 分词 → 每个 token 独立参与匹配（OR 语义），任一命中即候选
            const tokens = tokenize(q);
            if (tokens.length === 0) {
              return "未提取到有效关键词（query 需含至少一个字母/数字/中文）。";
            }
            // v12：逐文件 TF 加权评分，收集全部命中（不再"命中1个就 return"）
            const results = [];
            for (const t of targets) {
              const text = await readText(t.rel);
              if (!text) continue;
              const { score, hitLines } = scoreTarget(t, text, tokens);
              if (score > 0) results.push({ t, score, hitLines });
            }
            // v12：分数降序（同分按 label）
            results.sort((a, b) => b.score - a.score || a.t.label.localeCompare(b.t.label));
            if (results.length === 0) {
              // v12：0 结果引导——参考 mimocode memory.txt 升级策略，避免模型误判"没记录过"
              return "未找到匹配「" + q + "」。0 结果不代表从未记录过，请按此升级：\n" +
                "1. 换更少更独特的词（1-3 个罕见词：ID、函数名、文号、精确术语），去掉泛词（如「项目」「系统」「配置」）。\n" +
                "2. 字面量（URL/端口/路径/命令）被分词器拆散，改用 read 工具直接读 ~/.dsh/memory/ 下文件。\n" +
                "3. 要逐字原文（精确命令、用户原话）查最近会话摘要：memory_search 查 会话 / sessions。\n" +
                "可查主题清单：\n" + targets.map((t) => "  " + t.label + " → " + t.file).join("\n") + "\n或换关键词再试。";
            }
            // v12：相对分数下限（参考 mimocode top_score*0.15）：砍掉只命中泛词的噪音，
            //   第 1 名永远保留。保留前 8 条。
            // v12.1：再加绝对下限 ABS_MIN_SCORE=1.0——中文单字虚词（"的""在""存"）命中分数极低
            //   （0.1~0.5），相对下限算出来太宽（top*0.15）导致完全无关的查询也返回一堆低分文件；
            //   低于绝对下限的结果视为"无意义命中"丢弃（除非它是唯一命中，保留作为弱相关提示）。
            const ABS_MIN_SCORE = 0.6;
            const topScore = results[0].score;
            const cutoff = topScore * 0.15;
            const kept = results
              .filter((r, i) => i === 0 || (r.score >= cutoff && (r.score >= ABS_MIN_SCORE || results.length === 1)))
              .slice(0, 8);
            const exactSingle = kept.length === 1 && kept[0].t.file === q;
            const body = kept.map((r) => {
              const lines = r.hitLines.length > 0
                ? "\n  " + r.hitLines.slice(0, 3).join("\n  ")
                : "\n  （主题/文件名命中，无正文行摘录）";
              return "【" + r.t.label + "】" + r.t.file + "（相关度 " + r.score.toFixed(1) + "）" + lines;
            }).join("\n\n");
            // 单一精确命中（query == 文件名）→ 返回全文（原有行为保留）
            if (exactSingle) {
              const t = kept[0].t;
              const text = await readText(t.rel);
              if (text) return "【" + t.label + "】" + t.file + "\n" + text.slice(0, 4000);
            }
            return "搜索「" + q + "」命中 " + kept.length + " 个文件（OR 分词 + 相关度排序，Top " + kept.length + "）：\n\n" + body + "\n\n需要全文请用 memory_search 查精确文件名。";
          }
        });
        clog("[dsh-memory] memory_search 工具已注册（ctx.tools）");
      } catch (e) {
        cerr("[dsh-memory] 工具注册异常:", e && e.message ? e.message : String(e));
      }
    } else {
      cerr("[dsh-memory] tools 服务不可用，memory_search 工具注册跳过（不影响记忆注入）");
    }

    // v1.5.0：定期自动整合记忆（对标 mimocode AutoDream 7d）
    // 宿主常驻进程 + ctx.interval 定时器；安装时记起始时间，每次整合完成刷新，下次再隔 integrateDays 天。
    // 状态文件：MEMORY_ROOT/.integrate.json（{ installAt, lastIntegrateAt }）——常量见模块级

    function readIntegrateState() {
      try {
        const raw = fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8");
        return JSON.parse(raw);
      } catch (e) { return null; }
    }
    function writeIntegrateState(state) {
      try {
        fs.mkdirSync(MEMORY_ROOT.replace(/\//g, "/"), { recursive: true });
        fs.writeFileSync(portable(INTEGRATE_STATE_FILE), JSON.stringify(state, null, 2), "utf8");
      } catch (e) {
        cwarn("[dsh-memory] 整合状态写入失败:", e && e.message ? e.message : String(e));
      }
    }

    // 发起整合子代理（后台）：整合记忆 = 提升 sessions→projects/global、清理过时、去重、更新 index
    async function spawnIntegrate(agentForParent, reason) {
      const subagents = ctx.get("subagents");
      if (!subagents || typeof subagents.start !== "function") {
        cwarn("[dsh-memory] 自动整合：subagents 服务不可用，跳过");
        return false;
      }
      let parent = agentForParent || (agentsBySession.size > 0 ? agentsBySession.values().next().value : null);
      if (!parent || typeof parent !== "object") {
        // 启动时序：session-start 可能还没触发，agentsBySession 未填充 → 延迟 30 秒重试一次
        cwarn("[dsh-memory] 自动整合：无可用父 agent，30 秒后重试");
        setTimeout(() => {
          try {
            const p2 = agentForParent || (agentsBySession.size > 0 ? agentsBySession.values().next().value : null);
            if (p2 && typeof p2 === "object") {
              spawnIntegrate(p2, reason);
            } else {
              cwarn("[dsh-memory] 自动整合：重试后仍无父 agent，本周期跳过");
            }
          } catch (e) {
            cwarn("[dsh-memory] 自动整合重试异常:", e && e.message ? e.message : String(e));
          }
        }, 30000);
        return false;
      }
      // v1.11.0：整合升级（对标 mimocode Dream）—— D3 归类分节+来源id、D4 容量上限+修剪、验证后写入
      // 只读最近信号（不穷举）+ 简报输出（省 token）
      const promptText =
"Run one automatic memory consolidation pass for the current DSH memory library (~/.dsh/memory/).\n" +
"Consolidate only durable, VERIFIED information. Memory files (sessions/ summaries) are the working index.\n" +
"\n" +
"## Sources\n" +
"- Primary: sessions/*.md 摘要（尤其最近几天、跨会话反复出现的信号）.\n" +
"- 只读最近/重复信号，不要穷举每个文件.\n" +
"\n" +
"## Consolidate (D3: 跨会话归类 + 保留来源)\n" +
"把跨会话成立、值得长期保留的条目提升为精确分节，逐条保留来源会话（追加 [ses YYYY-MM-DD] 或 [ses <id>]）：\n" +
"1. 跨项目通用（用户偏好/踩坑/方法论）→ global.md，按 必守/偏好/踩坑 小节归类.\n" +
"2. 项目专属事实/决策 → projects/<项目名>.md，分节：\n" +
"   - ## Rules（用户明示的项目级规则）\n" +
"   - ## Architecture decisions（决策 + 绝对日期 YYYY-MM-DD + 理由）\n" +
"   - ## Patterns（反复出现的问题与解决）\n" +
"   - ## Gotchas（易踩的坑 / 陷阱）\n" +
"   - ## Discovered durable knowledge（跨会话确证的事实）\n" +
"3. 每条 1-3 行；合并重复条目（精确字面量：文号/路径/数字/命令逐字保留，绝不改写）；相对日期转 YYYY-MM-DD.\n" +
"\n" +
"## Verify (D3)\n" +
"写提到的文件路径前用 glob、函数/类名前用 grep 核实存在；无法证实但合理的标 [unverified]；被新决定/新代码推翻的条目标记删除或移除.\n" +
"\n" +
"## Prune (D4: 容量上限 + 修剪过期)\n" +
"1. global.md 字符数 < 3000、index.md < 2000、每节保持精炼（对标 mimocode dream: MEMORY.md <200行/10KB）——超了就精简冗余文字、合并重复、下沉低频细节到 knowledge/，不丢事实；章节用 ## 明确分类（便于分区感知注入保留骨架）.\n" +
"2. sessions/当日文件保持 200-400 字要点+指向，细节归档 knowledge/ 或对应 project 文件.\n" +
"3. 移除：被新决定取代的条目、仅与单个会话相关不再成立的细节、与更强记忆重复的低信号条目.\n" +
"4. 只精简/合并/修剪，不删除仍有价值的事实；删除前 [unverified] 或明确标注.\n" +
"\n" +
"## Discipline\n" +
"- 每个文件 edit 前先 read 全量（禁止局部读+整体覆写）；不更新 global/index 的时间戳行（保前缀缓存）;\n" +
"- 只动 ~/.dsh/memory/ 目录；不读/不依赖原始大日志;\n" +
"- 保留 source session 引用便于追溯.\n" +
"\n" +
"## Output — brief summary only\n" +
"- Consolidated: n entries added (按节列出)\n" +
"- Updated: n entries changed\n" +
"- Deleted: n entries removed\n" +
"- Skipped: reason if nothing changed\n" +
"- Health: global.md 字符/3000、index.md 字符/2000、sessions 每日字数大致范围";
      try {
        const run = await subagents.start("spawn", {
          label: "dsh-memory-自动整合-" + reason,
          prompt: [{ type: "text", text: promptText }],
          parent: parent,
          signal: new AbortController().signal,
          toolFilter: { allow: ["read", "write", "edit", "grep", "glob", "memory_search"] }
        });
        run.result.then((result) => {
          const outText = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\\n");
          clog("[dsh-memory] 自动整合完成（" + reason + "，stopReason=" + result.stopReason + ", 输出 " + outText.length + " 字符）");
          if (outText.length > 0 && outText.length <= 600) {
            clog("[dsh-memory] 整合报告: " + outText.replace(/\\n/g, " | "));
          }
          // 刷新起始时间：无论结果如何都刷新（避免卡在同一周期反复触发）
          const st = readIntegrateState() || {};
          st.lastIntegrateAt = Date.now();
          writeIntegrateState(st);
          clog("[dsh-memory] 下次自动整合：" + PLUGIN_CFG.integrateDays + " 天后");
        }).catch((e) => {
          cwarn("[dsh-memory] 自动整合子代理失败:", e && e.message ? e.message : String(e));
        });
        clog("[dsh-memory] 已发起自动整合子代理（" + reason + "，后台执行中）");
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 自动整合启动失败:", e && e.message ? e.message : String(e));
        return false;
      }
    }

    // 整合检查：到点且未整合过 → 发起
    async function checkIntegrate() {
      try {
        const now = Date.now();
        let st = readIntegrateState();
        if (!st) {
          // 首次：记录安装起始时间，不立即整合（给用户适应期，到 integrateDays 天后再触发）
          st = { installAt: now, lastIntegrateAt: now };
          writeIntegrateState(st);
          clog("[dsh-memory] 自动整合已初始化（起始 " + new Date(now).toISOString().slice(0, 10) + "，每 " + PLUGIN_CFG.integrateDays + " 天一次）");
          return;
        }
        if (!PLUGIN_CFG.integrateEnabled) return;
        const due = now - (st.lastIntegrateAt || st.installAt || 0) >= PLUGIN_CFG.integrateDays * 86400000;
        if (due) {
          clog("[dsh-memory] 距上次整合已满 " + PLUGIN_CFG.integrateDays + " 天，触发自动整合");
          await spawnIntegrate(null, "定期");
        }
      } catch (e) {
        cwarn("[dsh-memory] 整合检查异常:", e && e.message ? e.message : String(e));
      }
    }

    // 定时器：每小时检查一次（宿主常驻进程；fiber 清理时自动 dispose）
    try {
      checkIntegrate();
      ctx.interval(() => { checkIntegrate(); }, 3600000);
      clog("[dsh-memory] 自动整合定时器已启动（每 " + PLUGIN_CFG.integrateDays + " 天整合一次，每小时检查）");
    } catch (e) {
      cwarn("[dsh-memory] 自动整合定时器启动失败:", e && e.message ? e.message : String(e));
    }

    // v1.11.0：/dream 手动整合命令 —— 触发一次整合（复用 spawnIntegrate 全部历史整合），
    // 与 7 天自动整合统一：手动跑完同样刷新 lastIntegrateAt，与自动周期协调不重复整合。
    let dreamDisposer = null;
    try {
      if (ctx.commands && typeof ctx.commands.register === "function") {
        dreamDisposer = ctx.commands.register({
          name: "dream",
          description: "手动触发一次记忆整合（对标 mimocode /dream）：扫描历史会话，把跨会话成立的决策/踩坑/规律归类提升到 global/projects 并精简超限文件。",
          input: { hint: "/dream 无参数" },
          handler: async (inv) => {
            const started = await spawnIntegrate(inv.agent, "手动");
            return started
              ? { kind: "success", text: "已发起记忆整合（后台执行，完成后自动刷新下次自动整合时间）。" }
              : { kind: "error", text: "整合启动失败（无可用父 agent 或 subagents 服务不可用），请稍后重试。" };
          }
        });
        clog("[dsh-memory] /dream 手动整合命令已注册");
      } else {
        cwarn("[dsh-memory] commands 服务不可用，/dream 命令未注册");
      }
    } catch (e) {
      cwarn("[dsh-memory] /dream 命令注册失败:", e && e.message ? e.message : String(e));
    }

    // v1.11.0：dispose 钩子 —— 不再置空 enabledAt！
    // DSH 退出/重启会触发 dispose，但「插件启停」已与「DSH 进程启停」解耦：
    // enabledAt 只由记忆活跃开关 active 驱动（settings watch 处理），DSH 退出不改变它。
    // dispose 只清理 /dream 命令注册，避免重复注册冲突。
    return () => {
      try { if (dreamDisposer) dreamDisposer(); } catch (e) { /* 命令清理失败不影响 */ }
    };
  }
};
