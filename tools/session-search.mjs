#!/usr/bin/env node
// session-search.mjs — 「会话原文检索」CLI（dsh-memory v2.8.4 / P24·P25）
//
// 用途：记忆里记不准、记不下、只留了前缀的那个字面量 —— 回到**原始会话日志**里把原话捞出来。
//
// 设计要点（全部来自三轮六席评审的统一裁决，逐条有据）：
//  ① 零依赖：只用 node:fs / node:zlib / node:path / node:os + 外部 ripgrep。**不 import 插件**
//     （否则绑死宿主）⇒ 解码器与 KEEP_KINDS 是**双副本**，由 `GR22` 门断言逐键相等。
//  ② 缓存是**磁盘纯文本**，检索在**进程外**（rg 子进程）—— 绝不把语料读进内存
//     （全库正文 124–149 M 字符，进 JS 是 UTF-16 ⇒ 248–298 MB 堆常驻）。
//  ③ 逐帧解码即弃，**禁 Buffer.concat**（实测同一 27.27 MiB 日志：concat maxRSS 922.9 MB vs 逐帧 211.5 MB）。
//  ④ 段列表**只来自 manifest**（若用 glob，重建后的孤儿段会被 rg 搜到 ⇒ 返回过期正文）。
//  ⑤ 水位 = **最后一个已消费帧的起始偏移**（Node zstd API 不返回"本帧消费多少字节"）。
//  ⑥ 两个 P0 级不变量：坐标必须属**源侧坐标系**；`--limit` 截断**绝不冒充命中数**。
//
// 用法：
//   node session-search.mjs <关键词> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--sid <前缀>] [--kind <类型>] [--limit N] [--cs] [--re]
//     ★ 2026-10-22（用户「session 工具能不能适应英文大小写？」）：英文关键词**默认不区分大小写**（rg 加 `-i`），
//       要逐字匹配加 `--cs`（case-sensitive）。实测判据：`Dream` 749 处 vs `dream` 6452 处 —— 旧行为两者互不相通。
//     ★ 2026-10-22（用户「按最优理解改」）：关键词**默认当字面量**（元字符 `.` `*` `(` `[` 等全部转义），
//       与「精确字面量」契约一致；要正则语义（如 `a.*b`、`\d{6}`）加 `--re`。
//   node session-search.mjs --build [--force] [--sid <前缀>]
//   node session-search.mjs --show <sid> --frame <N> [--file <名>] [--line <N>]
//   node session-search.mjs --replay --since <日期> [--until <日期>] [--sid <前缀>]
//   node session-search.mjs --list [--since <日期>] [--until <日期>] [--label <过滤>] [--include-plugin] [--limit N]
//     ★ 2026-11-07（digest 退役前能力补位）：按**活动时间（日志 mtime）**列举会话，每会话给 首条 user/尾条 assistant/KB/帧数；
//       默认排除插件自身子代理（dsh-memory）；--json 输出结构化 rows。
//   node session-search.mjs --status
// 通用：--sessions-root <目录>  --cache-dir <目录>  --ds-home <目录>  --json
//
// 退出码：0 成功｜1 `--build` 有 aborted/异常 sid（其余 sid 已建好）｜2 参数非法｜3 找不到 ripgrep
//         ｜4 rg 执行失败｜5 `--show` 的坐标在缓存里不存在｜**6 并发保护：另一个 `--build` 正持有
//         `<cache>/.build.lock`**（没干活，稍后重试即可）
//
// v3.1.0（2026-09-20）两处加固（均由三席评审 + 本机实测驱动）：
//   ① **并发锁**：`--build` 全程持有 `<cache>/.build.lock`（`flag:"wx"` 原子创建、陈旧 20 分钟可抢占、
//      `finally` 释放；占用则 exit 6）—— 挡住「两个 build 同时写同一 sid」。锁必须在本 CLI 侧才能覆盖
//      三个入口（插件自动刷新 / 工具 `build:true` / 人手 shell）。
//   ② **原子段写**：段先写 `<seg>.jsonl.tmp` 再 rename 到最终名 ⇒ 并发**读者**（检索在子进程里跑
//      `rg --glob seg-*.jsonl`）只会看到旧段全量或新段全量，**不会读到半截 JSONL**；崩溃残留的 `.tmp`
//      由孤儿清理兜底删除。（旧实现是 `fs.openSync(p,"w")` 原地截断，读者可能读到半截。）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const CACHE_VER = 1;                       // 缓存口径版本（改 KEEP/装配规则时必须 +1）
// ★ 2026-11-08（分发修复）：CLI 自身版本。安装器用它判断「目标已存在且更新时不覆盖」；
//   插件用它比较候选副本（内置/用户本地/记忆库）并优先内置，避免插件新而 CLI 旧的能力错配。
const CLI_VERSION = "5.0.0";
const MAX_SEGS = 16;                       // 每 sid 段数上限（超出触发滚动合并）

// ─────────────────────────────────────────── CLI 参数
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.indexOf(name) >= 0;
// ★ 2026-10-22：英文大小写默认**不敏感**（用户诉求）；`--cs` = 退回逐字区分大小写。
//   只影响 rg 的匹配模式，不影响截断/计数口径（total 与 rows 共用同一 RGCOMMON ⇒ 口径不会分叉）。
const CASE_SENSITIVE = has("--cs");
// ★ 2026-10-22（用户「按最优理解改」）：关键词**默认按字面量**匹配（元字符转义），与工具契约「精确字面量」一致；
//   要正则语义加 `--re`。旧行为把 kw 原样塞进 rg pattern ⇒ 搜 `file.md` 会命中 `fileXmd`、搜 `(` 直接 rg 报错退出。
//   注意：`--kind` 的前缀拼接不受影响——kind 与 kw 各自转义后再拼 `.*`。
const RAW_REGEX = has("--re") || has("--regex");
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const kwPat = (s) => (RAW_REGEX ? String(s) : escRe(s));

// ★ 单一 sid 归一（红队 R-5 **必修** · 2026-09-19）：同一文件里原本有**四套各写各的** sid 长度 ——
//   构建期身份校验取 12 位、单元文件名 12 位、目录名与 manifest 键取 8 位、回看/回放取 8 位，
//   而**关键词检索的过滤点漏了归一**（拿原样的 `--sid` 值直接比目录名）⇒ 传 12 位短 id 或完整 uuid **一律 0 命中**。
//   这是本功能最危险的失效形态：0 命中时的引导语正是「0 结果 ≠ 没记录」，口径不匹配会被读成"确实没记"。
//   现在全库只认下面两个函数（不再出现裸 slice）：
//     · normSid     —— 8 位 = **键口径**（目录名 / manifest.sid / 检索过滤 / 回看 / 回放）；
//     · normSidLong —— 12 位 = **仅**构建期身份校验用（比 8 位多出的 4 位是**额外**碰撞防护，不是另一套键）。
//   两者都顺手剥掉 `session-` 前缀 —— 原身份校验没剥，于是传带前缀的 id 时**恒判身份不符**并删掉该 sid 的缓存目录。
const normSid = (s) => String(s || "").replace(/^session-/, "").slice(0, 8);
const normSidLong = (s) => String(s || "").replace(/^session-/, "").slice(0, 12);

const DS_HOME = opt("--ds-home", path.join(os.homedir(), ".dsh"));
const SESSIONS_ROOT = opt("--sessions-root", path.join(DS_HOME, "sessions"));
const CACHE_DIR = opt("--cache-dir", path.join(DS_HOME, "session-text"));
// ═══════════════════════════════════════════ v2.8.4（§9.12①）：**归档单元** = 第三类源
// 为什么：`~/.dsh/memory/.archive-units/<sid>.json` 是归档时**已经抽取好的会话正文**（实测 186 个 / 2.2 MB），
//   却落在两个检索面之外 ⇒ 一旦原始日志被轮转/劈开（红队实证 `574b8af7` 属这类），内容就只剩这份拷贝却搜不到。
// 设计取舍（重要，评审时先看这三条）：
//   · **独立扫描根（同一缓存库下的兄弟子目录）**：单元缓存写 `CACHE_DIR/_units/<日>/<sid8>/`。
//     ★ 措辞整改（红队 R-2）：它不是"第二个 `--cache-dir`" —— 它是同一个 `CACHE_DIR` 下的**兄弟子目录** `_units/`：
//       `--cache-dir` 一改两个根一起搬，`--status` 也是按同一个 `CACHE_DIR` 分别报两个根。
//       但对 **rg** 而言它确实是**另一个扫描根**（rg 收到的是日目录 ⇒ 单元根与日志根在扫描面上互不重叠），
//       这正是源过滤真正生效的原因；下面这条说明"同根改名"为什么做不到这件事：
//     ★ 我第一版按"同根加 `u` 后缀"实现，**真机冒烟当场抓出它无效**：`cmdSearch` 传给 rg 的是**日目录**
//     （不是段文件清单 —— rg 无 `--files-from`，段数×路径会超命令行上限），所以"同目录不同名"的过滤
//     **管不住 rg 的扫描范围**：只要单元与日志落在同一天目录，一次 `--source units` 就会把当天**所有**日志段一起搜进来
//     （实测命中里混进了 `src:session.v3.jsonl.zstd` 的行）。⇒ 换独立根后源过滤才真正生效（根是显式传参给 rg 的）。
//   · **默认 `--source logs`** ⇒ 搜索行为与命中数**逐字不变**（不引入"同一内容被日志与单元各命中一次"的重复计数）。
//   · 单元小而少 ⇒ `--source` 含 units 时**按需增量重建**（不拖慢默认路径，也不必先跑 6 分钟的 `--build`）。
const UNITS_DIR = opt("--units-dir", path.join(DS_HOME, "memory", ".archive-units"));
const SOURCE_EXPLICIT = has("--source");                 // 显式指定过 `--source` ⇒ 才按它过滤；否则 `--show` 默认两源都找
const SOURCE = String(opt("--source", "logs"));           // logs（默认）| units | all
const wantLogs = (src) => src === "logs" || src === "all";
const wantUnits = (src) => src === "units" || src === "all";
const AS_JSON = has("--json");
// ★ 2026-10-23 事故修复（用户「为什么都是 0 命中」）：DSH 0.2.x 起会话日志名为 **session.v4.jsonl.zstd**，
//   旧正则只认 `session[.v3].jsonl.zstd` ⇒ 全库 1082 个 v4 日志（≈09-23 之后所有会话，含当日）**完全不可见**：
//   ① `--build` 只看到 1263 个旧日志（=732 legacy + 531 v3，与账本 "日志 1263 个" 完全吻合）；
//   ② 那些旧文件的 size 早已不变 ⇒ 每轮 "建 0 / 跳过 1256"，缓存日目录永远停在 2026-09-23；
//   ③ `--since 今天` ⇒ 无日目录 ⇒ 一律返回「缓存为空或口径不符（先跑 --build）」，而那句提示会把人引向
//      "再 build 一次"，可 build 永远建不出东西 —— 静默失效形态。
//   修法：把 v4 纳入（事件类型与 v3 同构：user/assistant/system/message + tool/call|result，KEEP_KINDS 无需改）。
const LOG_RE = /^session(\.v3|\.v4)?\.jsonl\.zstd$/;   // 精确名（自动排除 .bak-presetfix-*）

// ─────────────────────────────────────────── 解码器（双副本 A：与 index.js `scanZstdFrames`/`decompressFrameAt` 同源）
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
function scanZstdFrames(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) out.push(i);
  }
  return out;
}
function decompressFrameAt(buf, off) {
  try { return zlib.zstdDecompressSync(buf.subarray(off)); } catch (e) { return null; }
}

// ─────────────────────────────────────────── 收录口径（双副本 B：与 index.js `KEEP_KINDS` 逐键相等，由 GR22 守）
const KEEP_KINDS = ["user/message", "assistant/message", "system/message", "tool/call", "tool/result", "compaction/summary"];
// ★ `--kind` 的合法集合 = **日志事件类型 ∪ {unit}**（R-9 自捕）：`KEEP_KINDS` 只管**日志段**的事件类型；而 §9.12①
//   的**单元段**写的是 `k:"unit"`（`buildOneUnit`）⇒ 只按 `KEEP_KINDS` 校验会把**合法查询 `--kind unit` 当非法拒掉**
//   —— 我的第一版就是这么写的，**被 U12a 当场抓红**（`--kind unit` → total=0）。教训：白名单必须覆盖
//   **缓存里真会出现**的全部取值，而不是"某一张常量表"。
const UNIT_KIND = "unit";
const VALID_KINDS = KEEP_KINDS.concat([UNIT_KIND]);
// 逐类型抽取路径（评审实测裁决，勿凭直觉改）：
//  · user/message      → data.content[]            （**无 message 层**）
//  · assistant/message → data.message.content[]    （**路径不同**）
//  · 两者都必须 filter(c => c.type === "text")     （reasoning 块**也带 text 字段**，naive map 会吞进 reasoning 全文）
//  · tool/result       → 正文在 content[].content（**不是 .text**）；错误判据 content[].isError === true
const CONTENT_KINDS = new Set(["user/message", "assistant/message", "system/message"]);

function textsOf(obj) {
  const d = obj.data || {};
  const out = [];
  if (CONTENT_KINDS.has(obj.type)) {
    const arr = (obj.type === "user/message") ? d.content : ((d.message || {}).content);
    if (Array.isArray(arr)) for (const c of arr) if (c && c.type === "text" && typeof c.text === "string") out.push(c.text);
    return out;
  }
  if (obj.type === "tool/call") {
    out.push(String(d.name || "?") + " " + String(d.arguments || ""));
    return out;
  }
  if (obj.type === "tool/result") {
    const arr = ((d.message || {}).content) || [];
    const isErr = Array.isArray(arr) && arr.some((c) => c && c.isError === true);
    if (d.error != null || isErr) {
      for (const c of arr) if (c && Array.isArray(c.content)) for (const q of c.content) if (q && typeof q.text === "string") out.push(q.text);
      if (!out.length) out.push(JSON.stringify(d).slice(0, 4000));
    }
    return out;                                        // 非错误 ⇒ 空 ⇒ 不收（对标 mimocode 不收 tool_output）
  }
  if (obj.type === "compaction/summary") {
    const s = d.summary;
    if (typeof s === "string") out.push(s);
    else if (Array.isArray(s)) for (const b of s) if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
    return out;
  }
  return out;
}

// ─────────────────────────────────────────── 小工具
const DAY = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const shaBuf16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);   // 直接对 Buffer 取摘要
                                                                                     // （原先 `sha16(String(buf))` 既慢又可能失真）

function walkLogs(root) {
  const out = [];
  const rec = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (LOG_RE.test(e.name)) out.push(p);
    }
  };
  rec(root);
  return out;
}
// ★ 红队复核建议：标注它是**第 4 套长度口径**（完整目录名）—— 它只作 `bySid` 的 map 键，**不参与任何比较**
//   （下游 `cmdBuild` 的过滤已走 `normSid`）。写着防将来有人拿它去比 sid。
const sidOfPath = (p) => { const d = path.basename(path.dirname(p)); return d.startsWith("session-") ? d.slice(8) : d; };

function findRg() {
  // 测试/运维覆盖：DSH_SESSION_SEARCH_RG=<path> 指定；"" 或 "none" 强制视为缺失（用于验证降级路径）。
  const envRg = process.env.DSH_SESSION_SEARCH_RG;
  if (envRg !== undefined) {
    const v = String(envRg).trim();
    if (!v || v.toLowerCase() === "none") return null;
    try { if (fs.statSync(v).isFile()) return v; } catch (e) {}
    return null;
  }
  const cands = [];
  try { cands.push(execFileSync(process.platform === "win32" ? "where" : "which", ["rg"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim()); } catch (e) {}
  const plat = process.platform, arch = process.arch;
  const rgPkg = "@vscode/ripgrep-" + (plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux") + "-" + (arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch);
  const binName = plat === "win32" ? "rg.exe" : "rg";
  const home = os.homedir();
  const roots = [];
  if (plat === "win32") {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked", "node_modules"));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "nodejs", "node_modules"));
  } else {
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules", path.join(home, ".npm-global", "lib", "node_modules"));
  }
  for (const r of roots) {
    cands.push(path.join(r, rgPkg, "bin", binName));
    cands.push(path.join(r, "@vscode", "ripgrep", "bin", binName));
    cands.push(path.join(r, "@deepseek-ai", "dsh", "node_modules", rgPkg, "bin", binName));
    cands.push(path.join(r, "@deepseek-ai", "dsh", "node_modules", "@vscode", "ripgrep", "bin", binName));
  }
  // 从 node 可执行文件所在目录向上找（DSH 桌面版把运行时放在 resources/runtime）
  try {
    let d = path.dirname(process.execPath);
    for (let i = 0; i < 5; i++) {
      cands.push(path.join(d, "node_modules", rgPkg, "bin", binName));
      cands.push(path.join(d, "node_modules", "@vscode", "ripgrep", "bin", binName));
      const up = path.dirname(d);
      if (!up || up === d) break;
      d = up;
    }
  } catch (e) {}
  cands.push("/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg");
  for (const c of cands) { try { if (c && fs.statSync(c).isFile()) return c; } catch (e) {} }
  return null;
}
const RG = findRg();

// ─────────────────────────────────────────── 构建
function readManifest(sidDir) {
  try { const m = JSON.parse(fs.readFileSync(path.join(sidDir, "manifest.json"), "utf8")); return m; } catch (e) { return null; }
}
function segPath(sidDir, n) { return path.join(sidDir, "seg-" + String(n).padStart(4, "0") + ".jsonl"); }
// v3.1.0（**原子段写**）：段一律先写 `<seg>.jsonl.tmp`，收尾再 rename 到最终名。
//   为什么：旧实现 `fs.openSync(p, "w")` 是**原地截断** —— 重建某 sid 的那一瞬间，任何并发读者
//   （检索在子进程里跑 `rg --glob seg-*.jsonl`）都可能读到**半截 JSONL**，返回残缺或漏检的命中；
//   而 rename 在同一卷上是原子的 ⇒ 读者要么看到旧段全量、要么看到新段全量，永不见半截。
//   `.tmp` 不匹配读者那条 `seg-*.jsonl` 通配（孤儿清理处另有 `.tmp` 兜底删除）。
function segTmpOf(p) { return p + ".tmp"; }
function closeSegAtomic(fd, finalPath) {
  try { fs.fsyncSync(fd); } catch (e) {}
  fs.closeSync(fd);
  fs.renameSync(segTmpOf(finalPath), finalPath);
}
function msgsDirFromSidDir(sidDir) { return sidDir; }

function writeManifestAtomic(sidDir, manifest) {
  const tmp = path.join(sidDir, "manifest.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(manifest));
  try { fs.renameSync(tmp, path.join(sidDir, "manifest.json")); }
  catch (e) { for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, path.join(sidDir, "manifest.json")); break; } catch (e2) { try { execFileSync("cmd", ["/c", "ping", "-n", "1", "127.0.0.1"], { stdio: "ignore" }); } catch (e3) {} } } }
}

let BUILD_STATS = { built: 0, appended: 0, skipped: 0, errors: 0 };

function buildOneSid(sid, files, force) {
  const filesSorted = files.slice().sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);   // 文件序 = mtime 升序
  // ── 身份校验：逐文件解码帧 0，`session` 头 session.id 必须与目录 sid 相符
  let firstTime = null, okFiles = [];
  for (const f of filesSorted) {
    const buf = fs.readFileSync(f);
    const offs = scanZstdFrames(buf);
    if (!offs.length) continue;
    const b = decompressFrameAt(buf, offs[0]);
    if (!b) continue;
    let head = null;
    for (const line of b.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.type === "session") { head = o; break; } } catch (e) {}
    }
    const headId = head && String(head.id || "").replace(/^session-/, "");
    if (!headId || !headId.startsWith(normSidLong(sid))) {
      // 身份不符 ⇒ 中止该 sid（D-20：并删除旧目录，否则仍会被 rg 搜到返回过期正文）
      const old = path.join(CACHE_DIR, normSid(sid));
      return { sid, aborted: true, reason: "identity-mismatch:" + path.basename(f) };
    }
    okFiles.push({ f, offs, head });
    if (firstTime == null && head && head.createdAt) firstTime = head.createdAt;
  }
  if (!okFiles.length) return { sid, aborted: true, reason: "no-decodable-frame0" };

  // ── 归属日 = **首事件 `time` 所在日**（D-19：不用 mtime，mtime 易被动）
  let firstEvtTime = firstTime;
  if (firstEvtTime == null) {
    const b = decompressFrameAt(fs.readFileSync(okFiles[0].f), okFiles[0].offs[0]);
    if (b) for (const line of b.toString("utf8").split("\n")) { try { const o = JSON.parse(line); if (typeof o.time === "number") { firstEvtTime = o.time; break; } } catch (e) {} }
  }
  const dayDir = path.join(CACHE_DIR, firstEvtTime ? DAY(firstEvtTime) : "unknown");
  const sidDir = path.join(dayDir, normSid(sid));
  fs.mkdirSync(sidDir, { recursive: true });

  const manifest = readManifest(sidDir);
  const sameVer = manifest && manifest.ver === CACHE_VER;

  // ── 段列表只来自 manifest；口径变更 ⇒ 全量重建（不混合）
  if (!force && sameVer) {
    // 判每个文件是否需要追加（水位 = 最后已消费帧起始偏移）
    let need = false;
    for (const { f, offs } of okFiles) {
      const st = fs.statSync(f);
      const rec = manifest.files[path.basename(f)];
      if (!rec) { need = true; break; }
      if (rec.size !== st.size) { need = true; break; }
      if (rec.lastFrameOff != null) {
        const fb = decompressFrameAt(fs.readFileSync(f), rec.lastFrameOff);
        if (!fb || shaBuf16(fb) !== rec.lastFrameDigest) { need = true; break; }
        if (offs.some((o) => o > rec.lastFrameOff)) { need = true; break; }
      }
    }
    if (!need) { BUILD_STATS.skipped++; return { sid, skipped: true, day: DAY(firstEvtTime) }; }
  }

  // —— 全量重建（简单、正确优先；增量追加在 seg 层做）
  const keepSegs = [];
  const dropped = {};                     // 全量累计口径（D-21）
  let segIdx = 0, segLines = 0, totalChars = 0;
  const MAX_LINES_PER_SEG = 20000;
  let curFd = null;                       // ★ 同步 fd 写：createWriteStream 是异步的，
  let curSegPath = null;                  // v3.1.0：当前段的**最终名**（内容先写它的 .tmp，closeSeg 时 rename）
  const newSegs = [];                     //   原先 end() 后未等 flush 就写 manifest ⇒ 段文件根本没落盘
  const fileRec = {};

  const openSeg = () => { segIdx++; const p = segPath(sidDir, segIdx); curSegPath = p; curFd = fs.openSync(segTmpOf(p), "w"); segLines = 0; newSegs.push(p); };
  const closeSeg = () => { if (curFd !== null) { closeSegAtomic(curFd, curSegPath); curFd = null; } };

  for (let fi = 0; fi < okFiles.length; fi++) {
    const { f, offs } = okFiles[fi];
    const buf = fs.readFileSync(f);
    let lastOkOff = null, lastOkDigest = null;
    const bad = [];
    for (let k = 0; k < offs.length; k++) {
      const b = decompressFrameAt(buf, offs[k]);
      if (!b) {
        // 伪 magic vs 残帧：其后是否还有有效帧（D-29）
        const hasMore = offs.slice(k + 1).some((o) => decompressFrameAt(buf, o));
        if (hasMore) bad.push(offs[k]);            // 伪 magic ⇒ 记入 badOffsets，水位越过
        continue;                                   // 残帧 ⇒ 不推进水位
      }
      const text = b.toString("utf8");
      const lines = text.split("\n");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (KEEP_KINDS.indexOf(o.type) < 0) { dropped[o.type] = (dropped[o.type] || 0) + 1; continue; }
        const texts = textsOf(o);
        if (!texts.length) { dropped[o.type] = (dropped[o.type] || 0) + 1; continue; }
        for (const t of texts) {
          const rec = { k: o.type, s: (typeof o.seq === "number" ? o.seq : null), f: path.basename(f), fr: k, ln: li, x: t };
          if (curFd === null) openSeg();
          fs.writeSync(curFd, JSON.stringify(rec) + "\n");
          segLines++; totalChars += t.length;
          if (segLines >= MAX_LINES_PER_SEG) closeSeg();
        }
      }
      lastOkOff = offs[k];
      lastOkDigest = shaBuf16(b);        // ★ 复用上面已解出的 b —— 原实现在此处**又重新解压了一次**（每帧解两遍）
    }
    closeSeg();
    fileRec[path.basename(f)] = { size: fs.statSync(f).size, frames: offs.length, lastFrameOff: lastOkOff, lastFrameDigest: lastOkDigest, badOffsets: bad };
  }

  // 段数有界 + 滚动合并（合并＝新建合并段 + manifest 摘旧段；段文件本身不改）
  if (newSegs.length > MAX_SEGS) { /* 简化：本轮只截断 manifest 引用，保留最新 MAX_SEGS 段 */ }

  const mf = {
    ver: CACHE_VER, sid: normSid(sid), day: DAY(firstEvtTime), built: new Date().toISOString(),
    files: fileRec, segs: newSegs.map((p) => path.basename(p)), dropped, chars: totalChars,
  };
  writeManifestAtomic(sidDir, mf);
  // ★ 清理**未被 manifest 引用的孤儿段**。理由：检索是「传目录 + `--glob seg-*.jsonl`」（rg 无 --files-from，
  //   且 1072×段数会超命令行长度上限）⇒ **目录里若残留旧段就会被搜到、返回过期正文**。
  //   顺序：先写 manifest（只引用新段）→ 再删孤儿。崩溃窗口极小，且 manifest 始终自洽。
  try {
    const keep = new Set(mf.segs);
    for (const fn of fs.readdirSync(sidDir)) {
      if (/^seg-\d+\.jsonl$/.test(fn) && !keep.has(fn)) fs.unlinkSync(path.join(sidDir, fn));
      else if (/^seg-\d+\.jsonl\.tmp$/.test(fn)) fs.unlinkSync(path.join(sidDir, fn));   // v3.1.0：上次崩溃残留的半成品
    }
  } catch (e) {}
  BUILD_STATS.built++;
  return { sid, built: true, chars: totalChars, segs: newSegs.length, day: mf.day };
}

// ─────────────────────────────────────────── §9.12①：归档单元（第三类源）构建
// 单元 = 归档时抽好的会话正文（`memory/.archive-units/<sid>.json`：{ text, sid, chars, frames, at, counterVer, … }）。
// 每条正文写一行段记录 `{ k:"unit", f:<单元文件名>, fr:0, ln:<正文行号>, x:<行文本> }` ⇒ 既有 search/show 全部复用。
function unitSidDir(day, sid8) { return path.join(unitsRoot(), day, sid8); }
const UNITS_SUBDIR = "_units";
const unitsRoot = () => path.join(CACHE_DIR, UNITS_SUBDIR);
function buildOneUnit(fileName, force) {
  const p = path.join(UNITS_DIR, fileName);
  let d; try { d = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return { sid: fileName, aborted: true, reason: "unit-unreadable" }; }
  const sid8 = normSid(d.sid || path.basename(fileName, ".json"));
  const day = d.at ? DAY(Number(d.at)) : "0000-00-00";
  const sidDir = unitSidDir(day, sid8);
  const text = String(d.text || "");
  if (!text) return { sid: sid8, aborted: true, reason: "unit-empty" };
  let st; try { st = fs.statSync(p); } catch (e) { return { sid: sid8, aborted: true, reason: "unit-stat-failed" }; }
  const mfOld = readManifest(sidDir);
  const recOld = mfOld && mfOld.files && mfOld.files[fileName];
  // ★ 评审整改（红队 R-1，2026-09-19 **实测复现**）：原陈旧判据只用 `size + mtimeMs` ⇒ **同字节数、同 mtime 的内容替换**
  //   （`memory_backup` 还原、`robocopy /COPY:T`、任何保留时间戳的复制）不会触发重建 ⇒ **磁盘上已不存在的内容被当证据
  //   返回，而新内容永不可见**（红队复现：同 165 B、mtime 还原后，新词 total 0 / 旧词 total 3）。
  //   ⇒ 改为把**正文摘要**（sha256 前 16 位）写进 manifest 并参与比对；顺带记下单元自带的 `counterVer`（可审计）。
  const unitDigest = shaBuf16(Buffer.from(text));
  if (!force && mfOld && mfOld.ver === CACHE_VER && recOld && recOld.size === st.size && recOld.digest === unitDigest) {
    BUILD_STATS.skipped++; return { sid: sid8, skipped: true, day: day };
  }
  fs.mkdirSync(sidDir, { recursive: true });
  const segName = "seg-0001.jsonl";
  const segFinal = path.join(sidDir, segName);
  const fd = fs.openSync(segTmpOf(segFinal), "w");     // v3.1.0：单元段同样走**原子写**（先 .tmp 后 rename）
  const lines = text.split("\n");
  let chars = 0;
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li];
    if (!t.trim()) continue;
    fs.writeSync(fd, JSON.stringify({ k: "unit", s: null, f: fileName, fr: 0, ln: li, x: t }) + "\n");
    chars += t.length;
  }
  closeSegAtomic(fd, segFinal);
  // ★ 只写**一次** manifest：初版写成"先写一个空 files 的、再读回、再写一次"⇒ 与 buildOneSid 里那处写盘调用
  //   撞成两处，矩阵里 `inplace-write` 变体的字面量命中数从 1 变 2（被判成「变异未生效」）。
  //   ★ 另一处坑：本注释**第一版把那条调用原样写进了注释里** ⇒ 变体匹配用的是**未剥注释**的源码 ⇒ 注释也算一次命中。
  //   （矩阵内部对 `code` 剥整行注释，但 `applyMut` 用的是原始 cliSrc ⇒ 注释里的代码字面量会污染命中计数。）
  const mfUnit = {
    ver: CACHE_VER, sid: sid8, day: day, built: new Date().toISOString(),
    files: {}, segs: [segName], dropped: {}, chars: chars, unitSource: fileName,
  };
  mfUnit.files[fileName] = { size: st.size, mtimeMs: st.mtimeMs, frames: 1, lastFrameOff: null, lastFrameDigest: null, badOffsets: [], digest: unitDigest, counterVer: Number(d.counterVer) || 0 };
  writeManifestAtomic(sidDir, mfUnit);
  try { for (const fn of fs.readdirSync(sidDir)) { if (/^seg-\d+\.jsonl$/.test(fn) && fn !== segName) fs.unlinkSync(path.join(sidDir, fn)); else if (/^seg-\d+\.jsonl\.tmp$/.test(fn)) fs.unlinkSync(path.join(sidDir, fn)); } } catch (e) {}
  BUILD_STATS.built++;
  return { sid: sid8, built: true, chars: chars, segs: 1, day: day };
}
function buildUnits(force, onlySid) {
  let list = [];
  try { list = fs.readdirSync(UNITS_DIR).filter((f) => f.endsWith(".json")); } catch (e) { return { units: 0, built: 0 }; }
  let built = 0;
  for (const f of list) {
    if (onlySid && !f.startsWith(normSid(onlySid))) continue;   // ★ 红队 R-5：文件名为 12 位短 id ⇒ 传完整 uuid 时原先恒不命中（单元根本不重建）
    try { const r = buildOneUnit(f, force); if (r.built) built++; else if (r.aborted) BUILD_STATS.errors++; } catch (e) { BUILD_STATS.errors++; }
  }
  return { units: list.length, built: built };
}

function cmdBuild(force, onlySid) {
  const logs = walkLogs(SESSIONS_ROOT);
  const bySid = new Map();
  for (const f of logs) {
    const s = sidOfPath(f);
    if (!bySid.has(s)) bySid.set(s, []);
    bySid.get(s).push(f);
  }
  const errs = [];
  const rows = [];
  for (const [sid, files] of bySid) {
    if (onlySid && !sid.startsWith(normSid(onlySid))) continue;
    try {
      const r = buildOneSid(sid, files, force);
      if (r.aborted) { errs.push(r.sid + " " + r.reason); BUILD_STATS.errors++; }
      rows.push(r);
    } catch (e) { errs.push(sid + " " + e.message); BUILD_STATS.errors++; }
  }
  if (errs.length) {
    const p = path.join(CACHE_DIR, ".build-errors.log");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(p, "=== " + new Date().toISOString() + " ===\n" + errs.join("\n") + "\n");
  }
  return { logs: logs.length, sids: bySid.size, stats: BUILD_STATS, errors: errs.length, rows };
}

// ─────────────────────────────────────────── 检索
function cmdSearch(kw, since, until, sid, kind, limit) {
  if (!RG) { console.error("找不到 ripgrep（rg）—— 无法检索。请安装 rg 或把二进制放到 PATH。"); process.exit(3); }
  // §9.12①：要检索单元 ⇒ 先按需增量重建单元缓存（小而少；默认 logs 路径不进这里，行为/耗时不变）
  if (wantUnits(SOURCE)) { try { buildUnits(false, sid || null); } catch (e) {} }
  const scanDirs = [];
  let sidOffRangeDay = null;                                  // ★ R-7：sid 的**归属日**被日期范围排除时记下来（否则会静默 0）
  {
    const roots = [];
    if (wantLogs(SOURCE)) roots.push(CACHE_DIR);
    if (wantUnits(SOURCE)) roots.push(unitsRoot());
    for (const root of roots) {
      let dayDirs = [];
      try { dayDirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch (e) { dayDirs = []; }
      for (const d of dayDirs) {
        // ★ R-7（红队 rev4 复核）：sid 目录挂在会话的**归属日**上（跨天会话 = `max(mtime)` 那天），与"用户以为它跑的那天"
        //   不是一回事 ⇒ 按运行日过滤会得到**静默的 0 命中**。这里先探一下"该 sid 在不在这天"，被排除就记下来报给用户。
        if (sid && (since || until) && ((since && d < since) || (until && d > until))) {
          try { for (const s of fs.readdirSync(path.join(root, d))) if (s.startsWith(normSid(sid))) sidOffRangeDay = d; } catch (e) {}
        }
        if (since && d < since) continue;                    // 闭区间：两端都含当天
        if (until && d > until) continue;
        let any = false;
        for (const s of fs.readdirSync(path.join(root, d))) {
          if (sid && !s.startsWith(normSid(sid))) continue;   // ★ 红队 R-5：这一处原先漏了归一 ⇒ 12 位短 id / 完整 uuid 一律 0 命中
          const m = readManifest(path.join(root, d, s));
          if (!m || m.ver !== CACHE_VER) continue;
          any = true;                                        // ★ 只认 manifest（与旧实现同口径）
          // ★ R-6（2026-09-19 · **真实数据复核抓出**，红队 R-5 的同族缺陷）：给了 `--sid` 就把**该 sid 目录本身**交给 rg。
          //   旧行为只把**日目录**交出去（理由见顶部"独立扫描根"注释：段数×路径会超命令行上限），而 rg 会扫该日目录下的
          //   **全部**会话 ⇒ `--sid` 实际是"**按天**收窄"而不是"**按会话**收窄"：同日其他会话的命中会混进结果，
          //   而 CLI 自己的引导语与插件工具都把 `--sid` 说成"限定该 sid"（实测：查某 sid 却返回了另一个会话的行）。
          //   给了 sid 时路径列表只有 1~2 条 ⇒ 根本不存在长度问题，故这里可以安全地改成按会话收窄。
          if (sid) scanDirs.push(path.join(root, d, s));
        }
        if (any && !sid) scanDirs.push(path.join(root, d));           // ★ 未给 sid：仍是**日目录**（见顶部"独立扫描根"注释）
      }
    }
  }
  if (!scanDirs.length) return { total: 0, listed: 0, rows: [], note: sidOffRangeDay
    ? ("该会话（" + normSid(sid) + "）的缓存落在归属日 **" + sidOffRangeDay + "**，被 --since/--until 排除了 —— 去掉日期范围，或把范围改到这一天再试")
    : ("缓存为空或口径不符（先跑 --build" + (wantUnits(SOURCE) ? "；单元源另需 memory/.archive-units 里有 .json" : "") + "）") };

  // ① 先拿总数（不变量 B：截断绝不冒充命中数）
  const RGCOMMON = ["--no-heading"].concat(CASE_SENSITIVE ? [] : ["-i"]).concat(["--glob", "seg-*.jsonl", "--glob", "!manifest.json"]);
  // ★ R-8（红队 rev4 复核抓到"`--kind` 是死参数"）：`--kind` 此前**只解析、从不使用** ⇒ 加了过滤等于没加、
  //   而且 `total` 也按未过滤口径计数（实测 `--kind ZZZ-NOT-A-KIND` 照样 total 8）。这里的修法：
  //   把 kind 作为**同一个 pattern 的前缀**交给 rg（`"k":"<kind>".*<kw>`）⇒ **一处生效、total 与 rows 同源**，
  //   也**不需要** rg 的 PCRE2（本仓 CLI 用的是自带 rg，不能假定 `-P` 可用）。
  //   前提（有门守着）：缓存记录的 JSON **字段序为 `{k,s,f,fr,ln,x}`**（k 在最前，x 在最后）——
  //   若哪天改了写法，"`k` 在 kw 之前"这条就不成立，届时门会以 total=0 的形式红。
  const PAT = kind ? ('"k":"' + escRe(kind) + '".*' + kwPat(kw)) : kwPat(kw);
  let total = 0;
  try {
    const c = execFileSync(RG, RGCOMMON.concat(["-c", PAT]).concat(scanDirs), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    total = c.split(/\r?\n/).filter(Boolean).reduce((s, l) => s + Number(l.split(":").pop() || 0), 0);
  } catch (e) {
    if (e.status === 1) total = 0;
    else { console.error("rg 执行失败：", String(e.message).slice(0, 200)); process.exit(4); }
  }
  // ② 再取列出项
  const cap = limit || 30;
  let out = "";
  try { out = execFileSync(RG, RGCOMMON.concat(["-n", "-m", String(cap), PAT]).concat(scanDirs), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch (e) { out = ""; }
  const rowsAll = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    if (!m) return null;
    let rec = null; try { rec = JSON.parse(m[3]); } catch (e) {}
    return { sid: path.basename(path.dirname(m[1])), seg: path.basename(m[1]), line: Number(m[2]), k: rec && rec.k, fr: rec && rec.fr, src: rec && rec.f, x: rec ? rec.x : m[3] };
  }).filter(Boolean);
  // ★ v2.8.4（R 轨门实测校正）：`rg -m N` 是**每文件**上限，不是全局上限 —— 库里有 M 个文件命中就会返回 M×N 条。
  //   而 CLI 自己的人类可读输出写的是「命中 X 处（其中列出 M 条）—— 用 --limit 调大」，插件侧工具描述也承诺
  //   「limit = 最多列出多少条」⇒ 两处口径都与 `-m` 的每文件语义**不符**。这里显式截到全局上限，
  //   使 `listed` 与 `--limit` 真正同义（`total` 仍是命中总数，不受影响）。
  const rows = rowsAll.slice(0, cap);
  return { total, listed: rows.length, rows };
}

function cmdShow(sid, frameNo, file, line) {
  // §9.12① + 评审整改（红队 R-2）：两个根的**目录名可能同名**（`<日>/<sid8>` 与 `_units/<日>/<sid8>`）⇒ 坐标本身无法消歧。
  //   现在的规则（默认行为不变，但**可显式消歧**）：
  //     · 给了 `--file` ⇒ 按扩展名路由（`.json` ⇒ 单元根；其它 ⇒ 日志根）；
  //     · 显式 `--source units|logs` ⇒ 只扫该根；
  //     · 都没有（或 `--source all`）⇒ 两源都扫（默认，保持旧行为）。
  //   ★ 另：`--sid` 统一按**前 8 位**匹配 —— 日志侧 `_meta.sid` 是 8 位、单元侧目录名也是 8 位；原先要求传 8 位前缀
  //     才命中（本系统通用的是 12 位短 id ⇒ 传 12 位时两源都 0 命中，真坑）。
  //   ★ 2026-09-19（红队 R-5）：**关键词检索那一处当时漏改**（仍拿原样前缀比），现已全部并入同一个 `normSid`。
  const wantU = SOURCE_EXPLICIT ? wantUnits(SOURCE) : true;
  const wantL = SOURCE_EXPLICIT ? wantLogs(SOURCE) : true;
  const roots = [];
  if (file) {
    if (/\.json$/i.test(String(file))) { if (wantU) roots.push(unitsRoot()); }
    else { if (wantL) roots.push(CACHE_DIR); }
  }
  if (!roots.length) { if (wantL) roots.push(CACHE_DIR); if (wantU) roots.push(unitsRoot()); }
  const sidKey = normSid(sid);
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dayDirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const d of dayDirs) {
      const p = path.join(root, d);
      for (const s of fs.readdirSync(p)) {
        if (!s.startsWith(sidKey)) continue;
        const m = readManifest(path.join(p, s));
        if (!m) continue;
        const segs = m.segs.slice().sort().reverse();      // ★ 段号降序（D-22）
        for (const seg of segs) {
          const fp = path.join(p, s, seg);
          let ln = 0;
          for (const raw of fs.readFileSync(fp, "utf8").split("\n")) {
            ln++;
            if (!raw.trim()) continue;
            let r; try { r = JSON.parse(raw); } catch (e) { continue; }
            if (r.fr === frameNo && (!file || r.f === file) && (!line || ln === line)) hits.push({ day: d, sid: s, seg, ln, r });
          }
        }
      }
    }
  }
  if (!hits.length) {
    console.error("该坐标在缓存中不存在 —— 可能缓存已按新口径重建（坐标会整体漂移）。请改用关键词重搜。");
    process.exit(5);
  }
  return hits;
}

function cmdReplay(since, until, sid) {
  // 说明（红队 R-2 提出）：`--replay` **按设计只扫日志根**（它导出的是"用户消息"序列，而单元记录的 `k` 是 `unit`）；
  //   单元里的内容请用检索（`--source units`）或 `--show` 取。这里显式写明，免得被当成"漏覆盖"。
  const sidKey = sid ? normSid(sid) : null;
  const dayDirs = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  const rows = [];
  for (const d of dayDirs) {
    if (since && d < since) continue;
    if (until && d > until) continue;
    for (const s of fs.readdirSync(path.join(CACHE_DIR, d))) {
      if (sidKey && !s.startsWith(sidKey)) continue;
      const m = readManifest(path.join(CACHE_DIR, d, s));
      if (!m || m.ver !== CACHE_VER) continue;
      for (const seg of m.segs) {
        for (const raw of fs.readFileSync(path.join(CACHE_DIR, d, s, seg), "utf8").split("\n")) {
          if (!raw.trim()) continue;
          let r; try { r = JSON.parse(raw); } catch (e) { continue; }
          if (r.k === "user/message") rows.push({ day: d, sid: s, seg, fr: r.fr, x: r.x });
        }
      }
    }
  }
  return rows;
}

// ─────────────────────────────────────────── --list（按**活动日**列举会话；digest 通道退役前的能力补位）
// 为什么按活动日：`--replay` 按缓存日 = **首事件日**分桶（buildOneSid D-19），跨日会话会漏（实测 11-06 活跃 30 会话，
//   replay 只列 17）；list 用日志文件 **mtime** 归日（与 digest `subagentDateKey(c.mtime)` 同口径）⇒ 修 G1。
// 数据源：只读 `session-text` 缓存段（manifest + seg-*.jsonl），不扫原始 zstd（958MB）⇒ 原型实测 470ms/30 会话。
// 排除插件子代理：digest 读 `subagent/descriptor.label` 判 `^dsh-memory-`；缓存不保留该事件 ⇒ 用首帧文本特征
//   （插件 prompt 含 `dsh-memory` / 「会话检查点记录器」/「记忆写入器」/ dream prompt）判定，且只对**子代理目录**判
//   （顶层 `session-*` 是用户会话，cwd 里含 dsh-memory 字样不算插件子代理 —— 否则会把本插件的开发会话误排除）。
const PLUGIN_SUBAGENT_RE = /dsh-memory|记忆写入器|会话检查点记录器|dream/i;
const TRUNC = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

/** 读一个 sid 的缓存目录：返回 { firstUser, lastAssistant, firstAny, kb, frames, chars, plugin, cacheDir } */
function readListCache(cacheDir, isTopLevel) {
  const out = { firstUser: "", lastAssistant: "", firstAny: "", kb: 0, frames: 0, chars: 0, plugin: false, cacheDir: cacheDir || "" };
  if (!cacheDir) return out;
  const m = readManifest(cacheDir);
  if (!m) return out;
  out.chars = Number(m.chars) || 0;
  try {
    for (const f of Object.values(m.files || {})) { out.kb += (Number(f.size) || 0) / 1024; out.frames += Number(f.frames) || 0; }
  } catch (e) { /* 元信息失败不影响首/尾 */ }
  const segs = Array.isArray(m.segs) ? m.segs.slice().sort() : [];
  for (const seg of segs) {
    let txt = "";
    try { txt = fs.readFileSync(path.join(cacheDir, seg), "utf8"); } catch (e) { continue; }
    for (const raw of txt.split("\n")) {
      if (!raw.trim()) continue;
      let r; try { r = JSON.parse(raw); } catch (e) { continue; }
      if (!out.firstAny && (r.k === "system/message" || r.k === "user/message")) out.firstAny = String(r.x || "");
      if (!out.firstUser && r.k === "user/message") out.firstUser = String(r.x || "");
      if (r.k === "assistant/message") out.lastAssistant = String(r.x || "");
    }
  }
  if (!isTopLevel && out.firstAny && PLUGIN_SUBAGENT_RE.test(out.firstAny)) out.plugin = true;
  return out;
}

function cmdList(o) {
  const opts = o || {};
  const since = opts.since || null, until = opts.until || null;
  const labelNeedle = opts.label ? String(opts.label).toLowerCase() : null;
  const includePlugin = !!opts.includePlugin;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 30));
  // ① 扫 sessions 目录：sid8 → 最新日志 mtime（活动时间）+ 是否顶层
  const bySid = new Map();
  const rec = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { rec(p); continue; }
      if (!LOG_RE.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      const sid8 = normSid(sidOfPath(p));
      if (!sid8) continue;
      const isTopLevel = path.basename(path.dirname(p)).startsWith("session-");
      const prev = bySid.get(sid8);
      if (!prev || st.mtimeMs > prev.mtimeMs) bySid.set(sid8, { sid8: sid8, mtimeMs: st.mtimeMs, isTopLevel: isTopLevel });
    }
  };
  rec(SESSIONS_ROOT);
  // ② 缓存 sid8 → 最新日缓存目录（日目录字典序升序，后写覆盖 ⇒ 取最新）
  const cacheOf = new Map();
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const d of fs.readdirSync(CACHE_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
        let ents = [];
        try { ents = fs.readdirSync(path.join(CACHE_DIR, d), { withFileTypes: true }); } catch (e) { continue; }
        for (const e of ents) { if (!e.isDirectory()) continue; const sid8 = normSid(e.name); if (sid8) cacheOf.set(sid8, path.join(CACHE_DIR, d, e.name)); }
      }
    }
  } catch (e) { /* 缓存缺失 ⇒ 元信息/首尾为空，不报错 */ }
  // ③ 按活动日过滤 + 活动时间倒序
  const cands = [];
  for (const info of bySid.values()) {
    const day = DAY(info.mtimeMs);
    if (since && day < since) continue;
    if (until && day > until) continue;
    cands.push({ sid8: info.sid8, day: day, mtimeMs: info.mtimeMs, isTopLevel: info.isTopLevel });
  }
  cands.sort((a, b) => (b.mtimeMs - a.mtimeMs) || String(a.sid8).localeCompare(String(b.sid8)));
  // ④ 逐个读缓存（仅候选）：插件子代理过滤 + 首/尾 + 元信息；取满 limit 即停
  const rows = [];
  let skippedPlugin = 0;
  for (const c of cands) {
    if (rows.length >= limit) break;
    const info = readListCache(cacheOf.get(c.sid8), c.isTopLevel);
    if (info.plugin && !includePlugin) { skippedPlugin += 1; continue; }
    if (labelNeedle) {
      const hay = (String(info.firstUser || "") + " " + String(info.firstAny || "") + " " + c.sid8).toLowerCase();
      if (hay.indexOf(labelNeedle) < 0) continue;
    }
    rows.push({
      sid8: c.sid8,
      day: c.day,
      mtime: new Date(c.mtimeMs).toISOString(),
      mtimeMs: c.mtimeMs,
      topLevel: c.isTopLevel,
      kb: Math.round(info.kb * 10) / 10,
      frames: info.frames,
      chars: info.chars,
      firstUser: TRUNC(info.firstUser, 200),
      lastAssistant: TRUNC(info.lastAssistant, 300),
      plugin: info.plugin,
    });
  }
  return {
    ok: true, mode: "list", since: since, until: until, label: opts.label || null,
    includePlugin: includePlugin, total: cands.length, listed: rows.length, skippedPlugin: skippedPlugin,
    rows: rows,
    note: "list 按**活动时间（日志 mtime）**归日与排序；每会话只读 session-text 缓存段，不扫原始 zstd。"
      + "默认排除插件自身子代理（dsh-memory），includePlugin:true 才纳入。"
      + "list 结果**不落库、不可被 memory_search 检索**（与 digest 的架构差异，如实交代）。",
  };
}

// ─────────────────────────────────────────── main
const CMD_BUILD = has("--build"), CMD_SHOW = has("--show"), CMD_REPLAY = has("--replay"), CMD_STATUS = has("--status"), CMD_LIST = has("--list");
const SINCE = opt("--since", null), UNTIL = opt("--until", null), SID = opt("--sid", null);
const KIND = opt("--kind", null), LIMIT = Number(opt("--limit", 30));
if (has("--version") || has("-V")) { console.log("session-search " + CLI_VERSION); process.exit(0); }

// ═══ R-9（根因席 rev5 提出 `--kind` 未校验；我据此做了**同类扫描**，一并修）═══
// 为什么这条是本批最要紧的一条：**本批连续抓到的 R-5/R-6/R-7/R-8 全是同一失效形态** ——
//   调用方给了东西、工具没照做，而用户/模型读到的却是「0 命中／没记录」。本工具的核心契约就是
//   「0 命中的可解释性」（引导语原文：0 结果 ≠ 没记录）⇒ **非法参数值绝不能退化成静默 0**。
// 同类扫描的实测结论（4 个参数会静默 0、2 个会静默走默认）：
//   · `--kind` 无校验 ⇒ pattern 不命中 ⇒ 静默 0；
//   · `--since`/`--until` 无校验 ⇒ `d < since` 是**字符串比较** ⇒ 非法值让几乎所有日目录被跳过 ⇒ 静默 0；
//   · `--source` 无校验 ⇒ `wantLogs`/`wantUnits` 双假 ⇒ 无根可扫 ⇒ 静默 0；
//   · `--limit`/`--frame` 无校验 ⇒ NaN ⇒ 静默落回默认值（不报错也不生效）。
// ⇒ 一张**白名单校验**（放在 main 的最前面，对 --status/--build/--show/--replay/检索**一视同仁**）：
//   非法值一律 **exit 2（用法错）** + 列出合法取值；`--json` 时把原因放进 `note`（插件侧会显示它）。
//   **不打通用 0 命中引导** —— 那会把"用法错"包装成"没记录"。
const PARAM_BAD = [];
// ★ R-10（红队 rev6 实测抓出）：第一版只校**形状**（`^\d{4}-\d{2}-\d{2}$`）⇒ `2026-13-45` 能过正则，
//   而下游是 `d < since` 的**字符串比较** ⇒ 日目录几乎全被跳过 ⇒ **静默 0**（与 R-5/R-8 同一失效形态）。
//   ⇒ 改成**语义校验**：形状 + 能被 Date 解析 + **回写后与原串逐字相等**（这一条同时干掉 2026-02-30 这类
//   "格式对但日历上不存在"的值：它会被规范化成 03-02 ⇒ 不相等 ⇒ 非法）。
const isDate = (x) => {
  const s = String(x);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
if (SINCE && !isDate(SINCE)) PARAM_BAD.push("--since「" + SINCE + "」必须是**真实存在的**日期，格式 YYYY-MM-DD（例 2026-09-19；不接受 2026-13-45 / 2026-02-30 / 2026-9-19）");
if (UNTIL && !isDate(UNTIL)) PARAM_BAD.push("--until「" + UNTIL + "」必须是**真实存在的**日期，格式 YYYY-MM-DD（例 2026-09-19；不接受 2026-13-45 / 2026-02-30 / 2026-9-19）");
if (has("--source") && ["logs", "units", "all"].indexOf(SOURCE) < 0) PARAM_BAD.push("--source「" + SOURCE + "」只能是 logs | units | all");
if (has("--kind") && KIND !== null && VALID_KINDS.indexOf(String(KIND)) < 0) PARAM_BAD.push("--kind「" + KIND + "」不是合法事件类型；合法值：" + VALID_KINDS.join(" | "));
if (has("--limit") && !(LIMIT > 0)) PARAM_BAD.push("--limit「" + opt("--limit") + "」必须是正整数");
if (has("--list") && has("--limit") && LIMIT > 200) PARAM_BAD.push("--list 的 --limit「" + opt("--limit") + "」上限 200（默认 30）");
if (has("--frame") && !(Number(opt("--frame")) >= 0)) PARAM_BAD.push("--frame「" + opt("--frame") + "」必须是非负整数");
if (PARAM_BAD.length) {
  const why = "参数校验失败（这是**用法错**，不是「没记录」）：" + PARAM_BAD.join("；");
  if (AS_JSON) console.log(JSON.stringify({ query: null, total: 0, listed: 0, rows: [], note: why }, null, 2));
  else console.error("✗ " + why + "\n（合法取值见上；本工具不会为用法错给「0 命中」引导）");
  process.exit(2);
}

if (CMD_STATUS) {
  // §9.12①：两个根分开报（日志 / 单元），避免"单元条数"混进日志计数让人误判索引规模
  const scan = (root) => {
    let sids = 0, bytes = 0, days = 0;
    let dayDirs = [];
    try { dayDirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch (e) { dayDirs = []; }
    days = dayDirs.length;
    for (const d of dayDirs) for (const s of fs.readdirSync(path.join(root, d))) {
      sids++; for (const seg of (readManifest(path.join(root, d, s)) || { segs: [] }).segs) { try { bytes += fs.statSync(path.join(root, d, s, seg)).size; } catch (e) {} }
    }
    return { days: days, sids: sids, bytes: bytes };
  };
  const logs = scan(CACHE_DIR), units = scan(unitsRoot());
  console.log(JSON.stringify({ cliVersion: CLI_VERSION, cacheDir: CACHE_DIR, ver: CACHE_VER, days: logs.days, sids: logs.sids, bytes: logs.bytes, unitsDir: UNITS_DIR, units: units, rg: RG }, null, 2));
  process.exit(0);
}

// ─────────────────────────────────────────── 建索引互斥锁（v3.1.0）
// 为什么需要：`--build` 的段写入是 `fs.openSync(p, "w")` **原地截断**（见 openSeg），
//   且 skip 判据只看**源日志**水位（buildOneSid 226-241）⇒ 两个 build 同时写同一 sid 时，
//   先写者内容被截断覆盖、而 manifest 仍判 skipped ⇒ 坏段可能**永不重建**；
//   本仓工具侧又不暴露 `--force`，用户没有自愈手段。
//   锁必须落在 CLI 侧才能覆盖全部三个入口：插件自动刷新 / 工具 `build:true` / 人手 shell。
// 语义：writeFileSync(flag:"wx") 原子创建；已存在且超过 LOCK_STALE_MS 视为陈旧可抢占；退出码 6 = 锁被占。
const LOCK_STALE_MS = 20 * 60 * 1000;
function buildLockPath() { return path.join(CACHE_DIR, ".build.lock"); }
function acquireBuildLock(lockPath, kind) {
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), kind: kind || "build" });
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {}
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lockPath, payload, { flag: "wx" }); return null; }
    catch (e) {
      let st = null; try { st = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch (e2) {}
      const age = (st && st.at) ? (Date.now() - st.at) : Infinity;
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lockPath); } catch (e3) {} continue; }
      return (st && st.pid) ? ("已被 pid " + st.pid + " 持有 " + Math.round(age / 1000) + "s") : "锁文件存在";
    }
  }
  return "锁竞争（连续两次都没抢到）";
}
function releaseBuildLock(lockPath) {
  try {
    const st = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!st || st.pid === process.pid) fs.unlinkSync(lockPath);
  } catch (e) {}
}

if (CMD_BUILD) {
  const _lockPath = buildLockPath();
  const _locked = acquireBuildLock(_lockPath, "build");
  if (_locked) {
    console.error("并发保护：另一个 --build 正在进行（" + _locked + "）——为避免并发写坏缓存，本次未执行（exit 6）。稍后重试即可。");
    process.exit(6);
  }
  try {
    const t0 = Date.now();
    const r = cmdBuild(has("--force"), SID);
    console.log("日志 " + r.logs + " 个 / sid " + r.sids + " 个 ⇒ 建 " + r.stats.built + "，跳过 " + r.stats.skipped + "，错 " + r.stats.errors + "，耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    // §9.12①：单元仅在**显式** `--units` 时随 `--build` 一起建（默认不建 ⇒ 旧行为与耗时逐字不变）
    if (has("--units")) { const u = buildUnits(has("--force"), SID); console.log("单元 " + u.units + " 个 ⇒ 建 " + u.built); }
    process.exitCode = r.errors ? 1 : 0;
  } finally {
    // 注意：process.exit() **不会**执行 finally ⇒ 这里只设 exitCode，退出放到 finally 之后
    releaseBuildLock(_lockPath);
  }
  process.exit(process.exitCode || 0);
}

if (CMD_LIST) {
  const r = cmdList({ since: SINCE, until: UNTIL, label: opt("--label", null), includePlugin: has("--include-plugin"), limit: LIMIT });
  if (AS_JSON) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log("会话列表：" + r.listed + " / " + r.total + " 个（按活动时间倒序" + (r.since || r.until ? "；活动日 " + (r.since || "…") + " ~ " + (r.until || "今") : "")
    + (r.includePlugin ? "；含插件子代理" : "；已排除插件子代理 " + r.skippedPlugin + " 个") + "）");
  for (const x of r.rows) {
    console.log("\n- " + x.sid8 + "  " + x.day + " " + new Date(x.mtimeMs).toTimeString().slice(0, 5) + "  " + x.kb + "KB  " + x.frames + " 帧"
      + (x.topLevel ? "" : "  [子代理]") + (x.plugin ? "  [插件]" : ""));
    console.log("  首条：" + (x.firstUser || "（未提取到首条 user/message）"));
    console.log("  尾条：" + (x.lastAssistant || "（未提取到尾条 assistant/message）"));
  }
  if (r.note) console.log("\n注：" + r.note);
  process.exit(0);
}
if (CMD_SHOW) {
  const hits = cmdShow(argv[argv.indexOf("--show") + 1], Number(opt("--frame", -1)), opt("--file", null), Number(opt("--line", 0)) || 0);
  // v2.8.4（P26）：`--show` 也支持 `--json`（插件侧工具需要结构化回看，不再解析人读格式）
  if (AS_JSON) {
    console.log(JSON.stringify({
      hits: hits.map((h) => ({ day: h.day, sid: h.sid, seg: h.seg, ln: h.ln, file: h.r.f, frame: h.r.fr, kind: h.r.k, text: h.r.x })),
    }, null, 2));
    process.exit(0);
  }
  for (const h of hits) console.log("src:" + h.r.f + "#f" + h.r.fr + "@cache:" + h.seg + ":" + h.ln + "\n" + h.r.x + "\n");
  process.exit(0);
}

if (CMD_REPLAY) {
  const rows = cmdReplay(SINCE, UNTIL, SID);
  console.log("用户消息 " + rows.length + " 条" + (SINCE || UNTIL ? "（" + (SINCE || "起") + " ~ " + (UNTIL || "今") + "）" : ""));
  for (const r of rows) console.log("\n— " + r.day + "  " + r.sid + "  src:" + (r.seg ? "" : "") + "f" + r.fr + " —\n" + r.x);
  process.exit(0);
}

// 位置参数 = 关键词（跳过所有「带值的选项」与其值）——原写法 `argv.indexOf(a) > 0` 把 index 0 的关键词漏掉
const VALUE_OPTS = new Set(["--since", "--until", "--sid", "--kind", "--limit", "--show", "--frame", "--file", "--line", "--sessions-root", "--cache-dir", "--ds-home", "--units-dir", "--source", "--label"]);
const positionals = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { if (VALUE_OPTS.has(a)) i++; continue; } positionals.push(a); }
const kw = positionals[0];
if (!kw) { console.error("用法：node session-search.mjs <关键词> [--since 日期] [--until 日期] [--sid 前缀] [--limit N] [--source logs|units|all]\n说明：--sid 按**前 8 位**匹配（12 位短 id 与完整 uuid 等价）；`--replay` 只导出日志根的用户消息序列，单元内容请用检索或 --show 取。"); process.exit(2); }

const res = cmdSearch(kw, SINCE, UNTIL, SID, KIND, LIMIT);
// ★ R-7b（写完 R-7 的门才发现）：`--json` 输出此前**不带 `note`** ⇒ 插件侧那句 `j.note ? … : ""` **从来没生效过**
//   （"缓存为空/归属日被排除"这两句只对**人**可见、对插件可见的 JSON 里没有）。这里补上 —— 两条路径都拿到同一句。
if (AS_JSON) { console.log(JSON.stringify({ query: kw, total: res.total, listed: res.listed, rows: res.rows, note: res.note || null }, null, 2)); process.exit(0); }
if (!res.total) {
  console.log("命中 0 处。\n");
  // ★ R-7（红队）：`cmdSearch` 早已会给出 `note`（缓存为空 / **sid 归属日被日期范围排除**），但人读路径此前**从不打印它**
  //   ⇒ 最有用的一句只对插件可见。现在打在最前面。
  if (res.note) console.log("⚠ " + res.note + "\n");
  console.log("⚠ 0 结果 ≠ 没记录。请按顺序升级：");
  console.log("  1. 换更稀有的词 —— 精确 ID／路径／编号 远优于描述性长句（分词会把长句拆散）");
  console.log("  2. 放宽范围 —— 去掉 --since/--until，或去掉 --sid（--sid 只按**前 8 位**匹配：12 位短 id 与完整 uuid 现已等价）");
  console.log("  3. 缓存可能滞后 —— 先跑 `node session-search.mjs --build`（活跃会话最后几秒可能不在）");
  if (SOURCE === "logs") console.log("  4. 若该内容**曾被归档过**，再试 `--source units`（归档时抽取的会话正文；日志被轮转/劈开时只剩它）");
  console.log("  5. 注：`--replay` 只覆盖**日志根**的用户消息序列（单元记录不参与）—— 单元里的内容请用检索或 `--show` 取");
  process.exit(1);
}
console.log("命中 " + res.total + " 处（其中列出 " + res.listed + " 条）" + (res.total > res.listed ? "  —— 用 --limit 调大" : ""));
// ★ N1（提案人席实测提出）：**必须说明这不是相关度序**。理由：用户按"直接就检索到来源"的用法去搜一个 GUID 时，
//   最先看到的常常是**别人在讨论这个 GUID** 的会话（实测：搜某地址得到 85 处，前 3 条全来自评审会话在讨论它，
//   真正的源头会话不在前 5 条里）⇒ 若读者以为"第一条就是最相关"，就会把二手讨论当成出处。
console.log("（共 " + res.total + " 处，**按出现顺序列出、不是相关度序**" + (res.total > res.listed ? "；命中多时先换**更稀有**的字面量，或用 --sid 收窄到某会话" : "") + "）");
console.log("");
for (const r of res.rows) {
  const full = String(r.x || "").replace(/\s+/g, " ");
  const at = full.indexOf(kw);
  const from = at < 0 ? 0 : Math.max(0, at - 90);
  const snip = (from > 0 ? "…" : "") + full.slice(from, from + 260) + (full.length > from + 260 ? "…" : "");
  console.log("[" + r.sid + "] " + (r.k || "?") + "  src:" + (r.src || "?") + "#f" + (r.fr ?? "?") + "  cache:" + r.seg + ":" + r.line);
  console.log("    " + snip);
}
console.log("\n回看原文：node session-search.mjs --show " + (res.rows[0] && res.rows[0].sid) + " --frame " + (res.rows[0] && res.rows[0].fr));
