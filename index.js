// dsh-memory: 全局自动记忆插件 v11（写操作全部移出插件，改提醒制；路径可移植化，开源版）
// v11 新增：路径可移植化
//  - 移除硬编码 C:/Users/Starry 绝对路径，改用 homedir() + 环境变量推导：
//    DSH_HOME 默认 <homedir>/.dsh，可用环境变量 DSH_HOME / DSH_MEMORY_ROOT / DSH_MEMORY_BACKUP_ROOT 覆盖。
//  - 便于开源分发：任何用户克隆后按 README 安装即可，无需改代码。
// v10.5 修复：session/event 处理器内同步 agent.inject 导致 "session append cannot reenter" 重入异常
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

export default {
  inject: ["fs"],
  apply(ctx) {
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

    async function readText(path) {
      try {
        const target = await ctx.fs.resolve(path);
        return await ctx.fs.readText(target);
      } catch (e) {
        return null;
      }
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
        console.error("[dsh-memory] 轮转检查失败:", e && e.message ? e.message : String(e));
        return [];
      }
    }

    // v8：从 index.md 动态解析知识文件索引（行格式：- 主题 → MEMORY-xxx.md（描述））
    async function loadKnowledgeTargets() {
      const indexText = await readText(MEMORY_ROOT + "/index.md");
      if (!indexText) return [];
      const targets = [];
      for (const line of indexText.split("\n")) {
        const m = /^-\s*(.+?)\s*→\s*(MEMORY-[^\s（(]+\.md)(?:（(.+?)）)?/.exec(line);
        if (m) {
          targets.push({ label: m[1].trim(), file: m[2], desc: (m[3] || "").trim() });
        }
      }
      return targets;
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
        console.error("[dsh-memory] 备份检查失败:", e && e.message ? e.message : String(e));
        return { due: false, last: null };
      }
    }

    // v9：组装维护提醒（备份到期 + 轮转到期），有需要时注入
    async function injectMaintenanceReminder(agent) {
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

      if (parts.length === 0) return;
      agent.inject(makeMessage(
        "<system-reminder>\n以下为 dsh-memory 维护提醒（写入 ~/.dsh 需要一次审批，频率很低）：\n" + parts.join("\n\n") + "\n</system-reminder>"
      ));
      console.log("[dsh-memory] 已注入维护提醒（" + parts.length + " 项）");
    }

    ctx.on("agent/session-start", (payload) => {
      const agent = payload.agent;
      if (!agent || typeof agent.inject !== "function") {
        console.error("[dsh-memory] session-start: agent.inject 不可用");
        return;
      }
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
            console.warn("[dsh-memory] global.md 超限 " + utf8Bytes(globalRaw) + "B（阈值 " + SIZE_WARN["global.md"] + "B），建议整理提升");
          }
          if (indexRaw && utf8Bytes(indexRaw) > SIZE_WARN["index.md"]) {
            console.warn("[dsh-memory] index.md 超限 " + utf8Bytes(indexRaw) + "B（阈值 " + SIZE_WARN["index.md"] + "B），建议精简");
          }
          const stableParts = [];
          if (globalMd) {
            const g = globalMd.slice(0, CHAR_LIMIT["global.md"]);
            stableParts.push("【全局记忆·用户画像】\n" + g + (globalMd.length > CHAR_LIMIT["global.md"] ? "\n[注：原文 " + globalMd.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 global]" : ""));
          }
          if (indexMd) {
            const i = indexMd.slice(0, CHAR_LIMIT["index.md"]);
            stableParts.push("【记忆索引】\n" + i + (indexMd.length > CHAR_LIMIT["index.md"] ? "\n[注：原文 " + indexMd.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 index]" : ""));
          }
          if (stableParts.length > 0) {
            agent.inject(makeMessage(
              "<system-reminder>\n以下为跨会话持久记忆（dsh-memory 稳定层，自动注入）。按需引用；更具体细节请调用 memory_search 工具。\n" + stableParts.join("\n\n") + "\n</system-reminder>"
            ));
            console.log("[dsh-memory] 已注入稳定层 (" + stableParts.length + " 段)");
          } else {
            console.warn("[dsh-memory] 稳定层为空（global/index 读取失败）");
          }

          // 消息B：动态层（最近摘要）
          const latest = await latestSessionSummary();
          if (latest && latest.text) {
            // v7：摘要超限预警
            if (utf8Bytes(latest.text) > SIZE_WARN.summary) {
              console.warn("[dsh-memory] 摘要 " + latest.file + " 超限 " + utf8Bytes(latest.text) + "B（阈值 " + SIZE_WARN.summary + "B），建议精简");
            }
            const sumText = latest.text.slice(0, CHAR_LIMIT.summary);
            const sumNote = latest.text.length > CHAR_LIMIT.summary
              ? "\n[注：摘要原文 " + latest.text.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 " + latest.file + "]"
              : "";
            agent.inject(makeMessage(
              "<system-reminder>\n【上次会话摘要】（" + latest.file + "，衔接上次的下一步行动）\n" + sumText + sumNote + "\n</system-reminder>"
            ));
            console.log("[dsh-memory] 已注入摘要: " + latest.file);
          } else {
            console.warn("[dsh-memory] 未找到会话摘要");
          }

          // 消息C：v9 维护提醒（备份到期 / 轮转到期 / 超限整理，只读检查后注入）
          // v10.3：同实例只对第一个顶层会话注入——避免多个主会话/子代理并发收到整理指令
          if (isTopLevelSession(agent) && !maintenanceInjected) {
            maintenanceInjected = true;
            await injectMaintenanceReminder(agent);
          }
        } catch (e) {
          console.error("[dsh-memory] 注入异常:", e && e.message ? e.message : String(e));
        }
      })();
    });

        // v6+v9：压缩检查点 —— 捕获 compaction/summary，改为注入提醒由模型落盘（插件零写入）
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
        // v9：找到该会话的 agent，注入落盘提醒（写 ~/.dsh 若被拒需升级审批）
        const agent = agentsBySession.get(session.id);
        if (!agent || typeof agent.inject !== "function") {
          console.warn("[dsh-memory] 压缩检查点：未找到会话 agent，跳过提醒（摘要未落盘）");
          return;
        }
        const fname = dateStr(new Date()) + ".md";
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
            targetAgent.inject(makeMessage(reminder));
            console.log("[dsh-memory] 已注入压缩检查点提醒（" + text.length + " 字符，目标 sessions/" + fname + "）");
            targetAgent.inject(makeMessage(refreshNote));
            console.log("[dsh-memory] 已注入记忆刷新提示（compact 后）");
          } catch (e) {
            console.error("[dsh-memory] 压缩提醒延迟注入失败:", e && e.message ? e.message : String(e));
          }
        }, 0);
      } catch (e) {
        console.error("[dsh-memory] session/event 处理异常:", e && e.message ? e.message : String(e));
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
            // v8：动态知识文件目标（来自 index.md 的 21 个主题文件）
            const knowledgeTargets = await loadKnowledgeTargets();
            const targets = [
              ...fixedTargets.map(([label, rel]) => ({ label, file: rel, rel })),
              ...knowledgeTargets.map((k) => ({ label: k.label, file: k.file, rel: KNOWLEDGE_ROOT + "/" + k.file, desc: k.desc }))
            ];
            // 1) 精确匹配：query 命中 label / 文件名 / 路径片段 → 返回文件内容
            const exact = targets.filter((t) => q === t.file || q === t.label || t.file.includes(q) || t.label.includes(q));
            if (exact.length === 1) {
              const t = exact[0];
              const text = await readText(t.rel);
              if (text) return "【" + t.label + "】" + t.file + "\n" + text.slice(0, 4000);
            }
            if (exact.length > 1) {
              return "匹配多个条目：\n" + exact.map((t) => t.label + " → " + t.file).join("\n") + "\n用完整文件名再查一次读取内容。";
            }
            // 2) v8 全文关键词搜索：跨所有目标文件扫命中行（每文件最多 3 行）
            const out = [];
            let scanned = 0;
            for (const t of targets) {
              if (out.length >= 8) break;
              const text = await readText(t.rel);
              if (!text) continue;
              scanned++;
              if (t.label.includes(q) || t.file.includes(q)) { out.push("【" + t.label + "】" + t.file + "（主题名命中）"); continue; }
              const hitLines = [];
              for (const line of text.split("\n")) {
                if (line.includes(q)) {
                  hitLines.push(line.trim().slice(0, 80));
                  if (hitLines.length >= 3) break;
                }
              }
              if (hitLines.length > 0) {
                out.push("【" + t.label + "】" + t.file + "\n  " + hitLines.join("\n  "));
              }
            }
            if (out.length > 0) {
              return "全文搜索「" + q + "」（扫描 " + scanned + " 个文件）：\n" + out.join("\n\n");
            }
            return "未找到匹配。可查主题：\n" + targets.map((t) => t.label + " → " + t.file).join("\n") + "\n或换关键词再试。";
          }
        });
        console.log("[dsh-memory] memory_search 工具已注册（ctx.tools）");
      } catch (e) {
        console.error("[dsh-memory] 工具注册异常:", e && e.message ? e.message : String(e));
      }
    } else {
      console.error("[dsh-memory] tools 服务不可用，memory_search 工具注册跳过（不影响记忆注入）");
    }
  }
};
