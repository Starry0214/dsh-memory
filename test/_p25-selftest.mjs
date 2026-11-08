/**
 * P2.5 存储层纯函数自测（零依赖，node 直接跑）
 *   node test/_p25-selftest.mjs
 *
 * 覆盖（任务书硬要求）：
 *   · wsKey 归一（Windows 路径 / 中文 / 末两级 / 盘符 / 非法字符 / UNC / POSIX / 空值）
 *   · topic 名往返 parse（lineName / sessionTopicName / isSessionTopicName / parseSessionTopicName）
 *   · sid8Of 归一（完整 uuid / session- 前缀 / 大写 / anon 拒绝）
 *   · 检查点头解析/生成（历史格式 / cwd 尾段 / 行内 marker / HTML 注释）
 *   · planMigration 去重与 unknown 归类（最新句胜出 / older-duplicate / existing update / unchanged /
 *     冲突 wsKey / includeUnknown / 确定性排序）
 *   · decideLifecycle 边界（30 天整 / 第 100 个 / 第 101 个 / 两者同时 / createdAt 不顶替 / 自定义策略）
 *   · coverageOf（全有 / 全无 / 部分 / 空 / 对象形态）
 *   · 静态纯度（模块不 import、不碰 node:fs|node:sqlite|process.env|require）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P25 from "../p25-topics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_FILE = path.join(HERE, "..", "p25-topics.js");
const DAY = 86400000;

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return true; }
  fails.push({ name, extra });
  console.log("FAIL  " + name + (extra === undefined ? "" : "\n      " + safe(extra)));
  return false;
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  return ok(name, g === w, { got, want });
}
function safe(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}
function throws(name, fn) {
  try { fn(); return ok(name, false, "未抛错"); } catch { return ok(name, true); }
}

const H = (sid8, cid8) => "## 检查点（目标与下一步，压缩 " + cid8 + " · sid " + sid8 + "）";
const BODY = (sid8, extra) => H(sid8, "c0ffee00") + "\n\n## 本次目标\n" + (extra || "目标 X") + "\n\n## 下一步行动\n继续";

// ═══════════════════ 1. normalizeWorkspace ═══════════════════
{
  eq("ws: 标准 Windows + 中文", P25.normalizeWorkspace("E:\\工具\\插件开发调整"), "E-工具-插件开发调整");
  eq("ws: 正斜杠 + 尾斜杠 + 小写盘符", P25.normalizeWorkspace("e:/工具/插件开发调整/"), "E-工具-插件开发调整");
  eq("ws: 末两级（更深 cwd）", P25.normalizeWorkspace("E:\\工具\\插件开发调整\\dsh-memory-plugin"), "E-插件开发调整-dsh-memory-plugin");
  eq("ws: 只有一级", P25.normalizeWorkspace("D:\\项目"), "D-项目");
  eq("ws: 盘符根", P25.normalizeWorkspace("E:\\"), "E");
  eq("ws: 空串", P25.normalizeWorkspace(""), "");
  eq("ws: null", P25.normalizeWorkspace(null), "");
  eq("ws: undefined", P25.normalizeWorkspace(undefined), "");
  eq("ws: 非法字符（空格/冒号）", P25.normalizeWorkspace("E:\\My App\\a:b"), "E-My-App-a-b");
  eq("ws: 连续分隔符/点段", P25.normalizeWorkspace("E:\\\\工具\\\\.\\插件开发调整\\\\"), "E-工具-插件开发调整");
  eq("ws: UNC", P25.normalizeWorkspace("\\\\server\\share\\a\\b"), "server-a-b");
  eq("ws: POSIX", P25.normalizeWorkspace("/home/user/proj"), "user-proj");
  eq("ws: 中文全角空格", P25.normalizeWorkspace("E:\\工具\u3000插件\\开发"), "E-工具-插件-开发");
  eq("ws: 幂等（对已归一值再归一）", P25.normalizeWorkspace(P25.normalizeWorkspace("E:\\工具\\插件开发调整")), "E-工具-插件开发调整");
}

// ═══════════════════ 2. lineName / sessionTopicName / parse ═══════════════════
{
  eq("line: 正常", P25.lineName("E-工具-插件开发调整"), "会话检查点·E-工具-插件开发调整");
  eq("line: 空前缀 → unknown", P25.lineName(""), "会话检查点·unknown");
  eq("line: null → unknown", P25.lineName(null), "会话检查点·unknown");
  eq("line: 误传 cwd 自动归一", P25.lineName("E:\\工具\\插件开发调整"), "会话检查点·E-工具-插件开发调整");
  ok("line: 不等于历史线名", P25.lineName("x") !== P25.LEGACY_LINE_NAME);

  eq("topic: 正常", P25.sessionTopicName("E-工具-插件开发调整", "1b736c53"), "E-工具-插件开发调整/1b736c53");
  eq("topic: 空 wsKey → unknown", P25.sessionTopicName("", "1b736c53"), "unknown/1b736c53");
  eq("topic: 完整 uuid 归一 sid8", P25.sessionTopicName("ws", "session-1b736c53-aaaa-bbbb-cccc-dddddddddddd"), "ws/1b736c53");
  eq("topic: 大写 sid8 归一", P25.sessionTopicName("ws", "1B736C53"), "ws/1b736c53");
  eq("topic: 非法 sid8 → 空串", P25.sessionTopicName("ws", "anon"), "");
  eq("topic: 空 sid8 → 空串", P25.sessionTopicName("ws", ""), "");
  eq("topic: wsKey 非法字符消毒", P25.sessionTopicName("E: 工具", "1b736c53"), "E-工具/1b736c53");

  const n = P25.sessionTopicName("E-工具-插件开发调整", "1b736c53");
  eq("parse: 往返", P25.parseSessionTopicName(n), { wsKey: "E-工具-插件开发调整", sid8: "1b736c53", title: null });
  eq("parse: 允许标题装饰", P25.parseSessionTopicName(n + " · 修 RAW 首张"), { wsKey: "E-工具-插件开发调整", sid8: "1b736c53", title: "修 RAW 首张" });
  eq("parse: unknown 前缀合法", P25.parseSessionTopicName("unknown/1b736c53"), { wsKey: "unknown", sid8: "1b736c53", title: null });
  eq("parse: 日期主题不是会话主题", P25.parseSessionTopicName("2026-11-01"), null);
  eq("parse: 历史线名不是会话主题", P25.parseSessionTopicName("会话检查点"), null);
  eq("parse: 工作区线不是会话主题", P25.parseSessionTopicName("会话检查点·E-工具-插件开发调整"), null);
  eq("parse: sid8 非十六进制拒绝", P25.parseSessionTopicName("ws/zzzzzzzz"), null);
  eq("parse: sid8 长度不足拒绝", P25.parseSessionTopicName("ws/1b736c5"), null);
  eq("parse: 多级路径拒绝", P25.parseSessionTopicName("a/b/c/1b736c53"), null);
  eq("parse: 空名", P25.parseSessionTopicName(""), null);
  eq("is: 会话主题 true", P25.isSessionTopicName(n), true);
  eq("is: 日期主题 false", P25.isSessionTopicName("2026-11-01"), false);
}

// ═══════════════════ 3. sid8Of ═══════════════════
{
  eq("sid: session- 前缀", P25.sid8Of("session-1b736c53-aaaa-bbbb-cccc-dddddddddddd"), "1b736c53");
  eq("sid: 裸 uuid", P25.sid8Of("1b736c53-aaaa-bbbb-cccc-dddddddddddd"), "1b736c53");
  eq("sid: 大写", P25.sid8Of("SESSION-1B736C53-AAAA-BBBB-CCCC-DDDDDDDDDDDD"), "1b736c53");
  eq("sid: 12 位前缀取前 8", P25.sid8Of("session-0191da82-50ef-42fb-956d-9c9cf4a43df5"), "0191da82");
  eq("sid: 已是 sid8", P25.sid8Of("1b736c53"), "1b736c53");
  eq("sid: anon 拒绝", P25.sid8Of("anon"), "");
  eq("sid: 空", P25.sid8Of(""), "");
  eq("sid: null", P25.sid8Of(null), "");
}

// ═══════════════════ 4. 检查点头解析/生成 ═══════════════════
{
  const legacy = P25.extractCheckpointMeta(H("1b736c53", "0dbc5756"));
  eq("meta: 历史头 sid/cid", { sid8: legacy.sid8, cid8: legacy.cid8, cwd: legacy.cwd, how: legacy.how },
    { sid8: "1b736c53", cid8: "0dbc5756", cwd: "", how: "header" });

  const built = P25.buildCheckpointHeader({ compactionId: "0dbc5756ff00", sessionId: "session-1b736c53-1111-2222-3333-444444444444", cwd: "E:\\工具\\插件开发调整" });
  eq("header: 生成格式", built, "## 检查点（目标与下一步，压缩 0dbc5756 · sid 1b736c53 · cwd E:\\工具\\插件开发调整）");
  const rt = P25.extractCheckpointMeta(built);
  eq("header: 生成→解析 往返", { sid8: rt.sid8, cid8: rt.cid8, cwd: rt.cwd, wsKey: rt.wsKey },
    { sid8: "1b736c53", cid8: "0dbc5756", cwd: "E:\\工具\\插件开发调整", wsKey: "E-工具-插件开发调整" });
  ok("header: 生成头被 isCheckpointText 认", P25.isCheckpointText(built));

  const c1 = P25.extractCheckpointMeta("## 检查点（目标与下一步，压缩 aa11bb22 · sid：1B736C53）");
  eq("meta: 全角冒号 + 大写", { sid8: c1.sid8, cid8: c1.cid8 }, { sid8: "1b736c53", cid8: "aa11bb22" });
  const c2 = P25.extractCheckpointMeta("<!-- intent: 3dead48e sid:02d20bfe -->\n## 检查点（目标与下一步）");
  eq("meta: HTML 注释 marker", { sid8: c2.sid8, cid8: c2.cid8, how: c2.how }, { sid8: "02d20bfe", cid8: "", how: "marker" });
  const c3 = P25.extractCheckpointMeta("### 备注\ncwd: E:\\工具\\插件开发调整\nsid: 1b736c53");
  eq("meta: cwd 行 + sid 行", { sid8: c3.sid8, wsKey: c3.wsKey }, { sid8: "1b736c53", wsKey: "E-工具-插件开发调整" });
  eq("meta: 无 sid → null", P25.extractCheckpointMeta("## 检查点（目标与下一步）\n正文"), null);
  eq("meta: 普通句 → null", P25.extractCheckpointMeta("- 实测成本：单 sid 增量 375 ms"), null);
  eq("meta: 空 → null", P25.extractCheckpointMeta(""), null);
  eq("isCheckpoint: 普通句 false", P25.isCheckpointText("- 实测成本"), false);
  eq("isCheckpoint: 检查点 true", P25.isCheckpointText("  ## 检查点（目标与下一步）"), true);
}

// ═══════════════════ 5. inferWorkspaceFromText ═══════════════════
{
  eq("infer: cwd 标记优先", P25.inferWorkspaceFromText("cwd: E:\\工具\\插件开发调整\n文件 A:\\x\\y"), "E-工具-插件开发调整");
  const two = "- `E:\\工具\\插件开发调整\\a\\x.js`\n- `E:\\工具\\插件开发调整\\b\\y.js`";
  eq("infer: 两条同前缀路径", P25.inferWorkspaceFromText(two), "E-工具-插件开发调整");
  eq("infer: 单条路径不猜", P25.inferWorkspaceFromText("- `E:\\工具\\插件开发调整\\a\\x.js`"), "");
  eq("infer: 公共前缀过深不猜", P25.inferWorkspaceFromText("`E:\\a\\b\\c\\x.js` `E:\\a\\b\\c\\y.js`"), "");
  eq("infer: 空", P25.inferWorkspaceFromText(""), "");
}

// ═══════════════════ 6. planMigration ═══════════════════
{
  // ① 基本 create
  const p1 = P25.planMigration({ rows: [{ topicName: "2026-11-01", body: BODY("1b736c53"), updatedAt: 1000, wsKey: "E-工具-插件开发调整" }] });
  eq("plan: 基本 create 数量", [p1.create.length, p1.update.length, p1.unknownWs.length], [1, 0, 0]);
  eq("plan: create 目标名/线名", { t: p1.create[0].topicName, l: p1.create[0].lineName, s: p1.create[0].sid8, w: p1.create[0].wsKey },
    { t: "E-工具-插件开发调整/1b736c53", l: "会话检查点·E-工具-插件开发调整", s: "1b736c53", w: "E-工具-插件开发调整" });
  eq("plan: create 正文去首尾空白", p1.create[0].text, BODY("1b736c53").trim());
  eq("plan: lines 聚合", p1.lines, [{ wsKey: "E-工具-插件开发调整", lineName: "会话检查点·E-工具-插件开发调整", sessions: 1, create: 1, update: 0 }]);
  eq("plan: wsKey 来源 hint", p1.create[0].wsKeySource, P25.WSKEY_SOURCE.HINT);

  // ② 同 sid 多句：最新胜出 + older-duplicate；旧句不删（只是不进计划）
  const p2 = P25.planMigration({
    rows: [
      { topicName: "2026-11-01", body: BODY("1b736c53", "旧"), updatedAt: 1000, wsKey: "W" },
      { topicName: "2026-11-02", body: BODY("1b736c53", "新"), updatedAt: 2000, wsKey: "W" },
      { topicName: "2026-11-02", body: BODY("1b736c53", "更新但时间早"), updatedAt: 500, wsKey: "W" },
    ],
  });
  eq("plan: 去重后只有 1 个 create", [p2.create.length, p2.update.length], [1, 0]);
  eq("plan: 取 updatedAt 最大的一句", p2.create[0].text.includes("新"), true);
  eq("plan: older-duplicate 计数", p2.stats.skippedByReason[P25.SKIP_REASON.OLDER_DUPLICATE], 2);
  eq("plan: 源句只读——计划里保留来源", p2.create[0].source.topicName, "2026-11-02");

  // ③ unknown 归类（无 wsKey/cwd/路径）
  const p3 = P25.planMigration({ rows: [{ topicName: "2026-11-01", body: BODY("02d20bfe"), updatedAt: 1000 }] });
  eq("plan: unknown → create 仍在 create", [p3.create.length, p3.unknownWs.length], [1, 1]);
  eq("plan: unknown 命名", p3.create[0].topicName, "unknown/02d20bfe");
  eq("plan: unknown 线名", p3.create[0].lineName, "会话检查点·unknown");
  eq("plan: unknown 来源", p3.create[0].wsKeySource, P25.WSKEY_SOURCE.NONE);
  const p3b = P25.planMigration({ rows: [{ topicName: "2026-11-01", body: BODY("02d20bfe"), updatedAt: 1000 }], includeUnknown: false });
  eq("plan: includeUnknown=false ⇒ 不建，skipped", [p3b.create.length, p3b.unknownWs.length, p3b.stats.skippedByReason[P25.SKIP_REASON.UNKNOWN_EXCLUDED]], [0, 0, 1]);

  // ④ 非检查点句 / 检查点无 sid
  const p4 = P25.planMigration({ rows: [
    { topicName: "2026-11-01", body: "## 当日要点\n普通内容", updatedAt: 1 },
    { topicName: "2026-11-01", body: "## 检查点（目标与下一步）\n没 sid", updatedAt: 2 },
  ] });
  eq("plan: no-checkpoint-marker", p4.stats.skippedByReason[P25.SKIP_REASON.NO_CHECKPOINT], 1);
  eq("plan: no-sid-marker", p4.stats.skippedByReason[P25.SKIP_REASON.NO_SID], 1);

  // ⑤ existing：正文一致 → unchanged；正文不同 → update（覆盖）
  const existSame = { topicName: "W/1b736c53", body: BODY("1b736c53"), updatedAt: 3000 };
  const p5 = P25.planMigration({ rows: [{ topicName: "2026-11-01", body: BODY("1b736c53"), updatedAt: 1000, wsKey: "W" }], existing: [existSame] });
  eq("plan: 已存在且一致 → unchanged", [p5.create.length, p5.update.length, p5.stats.skippedByReason[P25.SKIP_REASON.UNCHANGED]], [0, 0, 1]);
  const p6 = P25.planMigration({ rows: [{ topicName: "2026-11-01", body: BODY("1b736c53", "新目标"), updatedAt: 1000, wsKey: "W" }], existing: [existSame] });
  eq("plan: 已存在但不同 → update", [p6.create.length, p6.update.length], [0, 1]);
  eq("plan: update 带 previousText", p6.update[0].previousText, BODY("1b736c53"));
  eq("plan: update 目标名保持已有名", p6.update[0].topicName, "W/1b736c53");

  // ⑥ 已有主题名与计划 wsKey 冲突：以已有名为准 + conflicts 报告
  const p7 = P25.planMigration({
    rows: [{ topicName: "2026-11-01", body: BODY("1b736c53", "新"), updatedAt: 1000, wsKey: "已知工作区" }],
    existing: [{ topicName: "旧工作区/1b736c53", body: BODY("1b736c53"), updatedAt: 500 }],
  });
  eq("plan: 冲突 → update 且保留旧名", [p7.update.length, p7.update[0].topicName, p7.update[0].wsKeyChanged], [1, "旧工作区/1b736c53", true]);
  eq("plan: 冲突报告", p7.conflicts, [{ sid8: "1b736c53", existingWsKey: "旧工作区", plannedWsKey: "已知工作区", topicName: "旧工作区/1b736c53" }]);

  // ⑦ wsKey 优先级：hint > cwd > 正文
  const bodyWithCwd = BODY("1b736c53") + "\ncwd: E:\\正文\\路径";
  const p8 = P25.planMigration({ rows: [{ topicName: "d", body: bodyWithCwd, updatedAt: 1, cwd: "E:\\提示\\cwd" }] });
  eq("plan: cwd 次优先", [p8.create[0].wsKey, p8.create[0].wsKeySource], ["E-提示-cwd", P25.WSKEY_SOURCE.CWD]);
  const p9 = P25.planMigration({ rows: [{ topicName: "d", body: BODY("1b736c53") + "\n- `E:\\工具\\插件开发调整\\a\\x.cs`\n- `E:\\工具\\插件开发调整\\b\\y.cs`", updatedAt: 1 }] });
  eq("plan: 正文启发式兜底", [p9.create[0].wsKey, p9.create[0].wsKeySource], ["E-工具-插件开发调整", P25.WSKEY_SOURCE.BODY]);

  // ⑧ 确定性排序（wsKey → sid8）
  const p10 = P25.planMigration({ rows: [
    { topicName: "d", body: BODY("bbbbbbbb"), updatedAt: 1, wsKey: "Z" },
    { topicName: "d", body: BODY("aaaaaaaa"), updatedAt: 1, wsKey: "A" },
    { topicName: "d", body: BODY("dddddddd"), updatedAt: 1, wsKey: "A" },
  ] });
  eq("plan: 排序确定性", p10.create.map((x) => x.wsKey + "/" + x.sid8), ["A/aaaaaaaa", "A/dddddddd", "Z/bbbbbbbb"]);
  eq("plan: lines 按 wsKey 排序", p10.lines.map((l) => l.wsKey), ["A", "Z"]);

  // ⑨ 已有主题但无历史句 → existing-only；非法 existing 名 → invalid-existing-name
  const p11 = P25.planMigration({ rows: [], existing: [
    { topicName: "W/1b736c53", body: BODY("1b736c53") },
    { topicName: "不是会话主题", body: "x" },
    { topicName: "W/1b736c53", body: BODY("1b736c53") }, // 同 sid 重复出现
  ] });
  eq("plan: existing-only", p11.stats.skippedByReason[P25.SKIP_REASON.EXISTING_ONLY], 1);
  eq("plan: invalid-existing-name", p11.stats.skippedByReason[P25.SKIP_REASON.INVALID_EXISTING], 1);
  eq("plan: 同 sid 重复 existing 不产生动作", [p11.create.length, p11.update.length], [0, 0]);

  // ⑩ 纯函数：不修改入参
  const rowsIn = [{ topicName: "d", body: BODY("1b736c53"), updatedAt: 1, wsKey: "W" }];
  const snapshot = JSON.stringify(rowsIn);
  P25.planMigration({ rows: rowsIn });
  eq("plan: 不改入参", JSON.stringify(rowsIn), snapshot);

  // ⑪ updatedAt 形态兼容（ISO / Date / 数字字符串 / 秒）
  const pIso = P25.planMigration({ rows: [
    { topicName: "d", body: BODY("1b736c53", "ISO"), updatedAt: "2026-11-02T10:00:00Z" },
    { topicName: "d", body: BODY("1b736c53", "秒"), updatedAt: 1793000000 },
  ] });
  eq("plan: ISO 高于秒级时间戳", pIso.create[0].text.includes("ISO"), true);

  // ⑫ 空输入
  const pE = P25.planMigration({});
  eq("plan: 空输入", [pE.create.length, pE.update.length, pE.skipped.length, pE.lines.length], [0, 0, 0, 0]);
  eq("plan: rows 非数组不炸", P25.planMigration({ rows: null }).create.length, 0);

  // ⑬ isExisting 行可以混在 rows 里（迁移脚本读取路径的第二种形态）
  const p12 = P25.planMigration({ rows: [
    { topicName: "W/1b736c53", body: BODY("1b736c53", "库里已有"), updatedAt: 5000, isExisting: true },
    { topicName: "2026-11-01", body: BODY("1b736c53", "历史句"), updatedAt: 1000, wsKey: "W" },
  ] });
  eq("plan: rows 内 isExisting 行参与去重", [p12.create.length, p12.update.length], [0, 1]);
  eq("plan: isExisting 行的 previousText", p12.update[0].previousText, BODY("1b736c53", "库里已有"));
  eq("plan: stats 行数含 existing", [p12.stats.rows, p12.stats.legacyRows, p12.stats.sessionRows], [2, 1, 1]);
}

// ═══════════════════ 7. decideLifecycle ═══════════════════
{
  const NOW = 1800000000000; // 固定 now
  const mk = (archivedAt, extra) => Object.assign({ archivedAt, createdAt: NOW - 3650 * DAY, now: NOW, indexInLine: 1 }, extra || {});

  eq("life: 30 天整 → archived", P25.decideLifecycle(mk(NOW - 30 * DAY)), "archived");
  eq("life: 30 天差 1ms → active", P25.decideLifecycle(mk(NOW - 30 * DAY + 1)), "active");
  eq("life: 29 天 → active", P25.decideLifecycle(mk(NOW - 29 * DAY)), "active");
  eq("life: 31 天 → archived", P25.decideLifecycle(mk(NOW - 31 * DAY)), "archived");

  eq("life: 未归档（archivedAt=null）→ active（createdAt 很老也不顶替）", P25.decideLifecycle(mk(null)), "active");
  eq("life: createdAt=10 年前 + 无 archivedAt → active", P25.decideLifecycle({ createdAt: NOW - 3650 * DAY, now: NOW, indexInLine: 1 }), "active");
  eq("life: anchor=created 逃生口", P25.decideLifecycle({ createdAt: NOW - 31 * DAY, now: NOW, indexInLine: 1, policy: { anchor: "created" } }), "archived");

  eq("life: 第 100 个 → active", P25.decideLifecycle({ now: NOW, indexInLine: 100 }), "active");
  eq("life: 第 101 个 → archived", P25.decideLifecycle({ now: NOW, indexInLine: 101 }), "archived");
  eq("life: 第 1 个 → active", P25.decideLifecycle({ now: NOW, indexInLine: 1 }), "active");
  eq("life: indexInLine 缺失 → active", P25.decideLifecycle({ now: NOW }), "active");

  eq("life: 两者同时（30 天整 + 第 100 个）→ archived（先到者命中时间）",
    P25.decideLifecycle({ archivedAt: NOW - 30 * DAY, now: NOW, indexInLine: 100 }), "archived");
  eq("life: 两者同时（29 天 + 第 101 个）→ archived（命中计数）",
    P25.decideLifecycle({ archivedAt: NOW - 29 * DAY, now: NOW, indexInLine: 101 }), "archived");
  eq("life: 两者都不命中 → active", P25.decideLifecycle(mk(NOW - 29 * DAY, { indexInLine: 100 })), "active");

  eq("life: 自定义 keepDays=7（7 天整）", P25.decideLifecycle({ archivedAt: NOW - 7 * DAY, now: NOW, policy: { keepDays: 7 } }), "archived");
  eq("life: 自定义 keepDays=7（6 天 23h）", P25.decideLifecycle({ archivedAt: NOW - 7 * DAY + 3600000, now: NOW, policy: { keepDays: 7 } }), "active");
  eq("life: 自定义 maxSessions=3（第 4 个）", P25.decideLifecycle({ now: NOW, indexInLine: 4, policy: { maxSessions: 3 } }), "archived");
  eq("life: keepDays=0 → 立即 archived", P25.decideLifecycle({ archivedAt: NOW, now: NOW, policy: { keepDays: 0 } }), "archived");
  eq("life: 非法时间忽略", P25.decideLifecycle({ archivedAt: "not-a-time", now: NOW, indexInLine: 1 }), "active");
  eq("life: 未传 now 时按当前时间（10 年前归档 ⇒ archived）", P25.decideLifecycle({ archivedAt: Date.now() - 3650 * DAY }), "archived");
  eq("life: policy 缺省用默认 30/100", P25.decideLifecycle({ archivedAt: NOW - 30 * DAY, now: NOW }), "archived");
  ok("life: 返回值只在枚举内", ["active", "archived"].includes(P25.decideLifecycle({ now: NOW })));
}

// ═══════════════════ 8. coverageOf ═══════════════════
{
  const c1 = P25.coverageOf({ sessions: ["1b736c53", "02d20bfe"], topics: ["E-工具/1b736c53"] });
  eq("cov: 部分", { total: c1.total, covered: c1.covered, ratio: c1.ratio, missing: c1.missing }, { total: 2, covered: 1, ratio: 0.5, missing: ["02d20bfe"] });
  const c2 = P25.coverageOf({ sessions: ["1b736c53"], topics: ["E-工具/1b736c53", "W/另外", "2026-11-01"] });
  eq("cov: 全有（忽略非会话主题名）", [c2.total, c2.covered, c2.ratio], [1, 1, 1]);
  const c3 = P25.coverageOf({ sessions: ["1b736c53"], topics: [] });
  eq("cov: 全无", [c3.total, c3.covered, c3.ratio, c3.missing], [1, 0, 0, ["1b736c53"]]);
  const c4 = P25.coverageOf({ sessions: [], topics: [] });
  eq("cov: 空", [c4.total, c4.covered, c4.ratio], [0, 0, 0]);
  eq("cov: 空输入不炸", P25.coverageOf({}), { total: 0, covered: 0, ratio: 0, missing: [], byWs: {}, coveredTopics: 0, topicsWithWs: {} });
  const c5 = P25.coverageOf({
    sessions: [{ sessionId: "session-1b736c53-aaaa", wsKey: "W" }, { sid: "02d20bfe" }],
    topics: [{ name: "W/1b736c53" }],
  });
  eq("cov: 对象形态", [c5.total, c5.covered, c5.ratio, c5.byWs.W], [2, 1, 0.5, { total: 1, covered: 1 }]);
  const c6 = P25.coverageOf({ sessions: ["anon"], topics: ["W/1b736c53"] });
  eq("cov: 无法归一 sid 的会话不计 covered", [c6.total, c6.covered], [1, 0]);
}

// ═══════════════════ 9. 常量/契约 ═══════════════════
{
  eq("const: P25_VERSION", P25.P25_VERSION, 1);
  eq("const: UNKNOWN_WS", P25.UNKNOWN_WS, "unknown");
  eq("const: DEFAULT_LIFECYCLE_POLICY", P25.DEFAULT_LIFECYCLE_POLICY, { keepDays: 30, maxSessions: 100 });
  ok("const: policy frozen", Object.isFrozen(P25.DEFAULT_LIFECYCLE_POLICY));
  eq("const: DAY_MS", P25.DAY_MS, 86400000);
  const required = ["normalizeWorkspace", "lineName", "sessionTopicName", "isSessionTopicName", "parseSessionTopicName", "planMigration", "decideLifecycle", "coverageOf"];
  eq("const: 8 个契约函数都已导出", required.filter((f) => typeof P25[f] !== "function"), []);
}

// ═══════════════════ 10. 静态纯度（不读盘/不连库/零依赖） ═══════════════════
{
  const src = fs.readFileSync(MOD_FILE, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  const bad = [];
  if (/(^|\n)\s*import\s+[\w{*"'`]/.test(code)) bad.push("import");
  if (/\brequire\s*\(/.test(code)) bad.push("require");
  if (/(?:from|import)\s*\(\s*["']node:/.test(code)) bad.push("dynamic import node:");
  if (/node:(?:fs|sqlite|crypto|os|path|url|child_process)/.test(code)) bad.push("node: 内置模块");
  if (/\b(?:readFileSync|writeFileSync|DatabaseSync|createRequire|process\.env)\b/.test(code)) bad.push("读盘/连库/env 符号");
  eq("pure: 模块无 import/require/磁盘/DB/env", bad, []);
  ok("pure: 文件是 ESM（有 export）", /export\s+function/.test(src));
  ok("pure: 无顶层副作用语句", !/(^|\n)\s*(?:await|console\.|fs\.|process\.)/.test(code));
}

// ═══════════════════ 汇总 ═══════════════════
const total = pass + fails.length;
console.log("\n──────────────────────────────────────────────");
console.log("P2.5 selftest: " + pass + " PASS / " + fails.length + " FAIL  （共 " + total + " 项）");
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  ✗ " + f.name);
  process.exitCode = 1;
} else {
  console.log("全部通过 ✅");
}
