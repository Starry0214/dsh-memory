# 45x 写入闸 + 熔断补漏 · 独立风险审计（CRA）

- 审计员：只读独立审计（不改代码、不构建、不部署；仅写本文件）
- 日期：2026-11-06
- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin\index.js`（改动 A：`memory_write` 对非 dream 拒写；改动 B：短行退化熔断补漏）
- 宿主只读参照：`@deepseek-ai/dsh-agent-loop` 0.2.1-rc.5、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-client-ui-chat`（均在 `C:\Users\Starry\.dsh\profiles\node_modules\@deepseek-ai\` 或 `E:\工具\插件开发调整\_tmp_teammate_probe\extract4\`）
- **审计快照**：`index.js` sha256 = `69CF267EEC0C8D0DD10CF45CCDF9C3BAB86AD0C88310FBBCEC2734CC7FC5AEBD`，1464890 B，**20580 行**，mtime `2026-11-06 08:17:16`
- ⚠️ **审计期间该文件被改动过至少 3 次**（08:14 前 20543 行 → 08:16:04 版 → 08:17:16 版）。**下文所有行号以 69CF267E 快照为准**；若文件再变，请用每条的「锚点文本」重定位（我在证据里都附了锚点）。

---

## 结论摘要

**判断：修了再发（fix-then-ship）。** 不建议按当前状态发布。

改动 A 的**语义是对的**：全仓没有任何"非模型"路径调用 `memory_write` 工具（命令 / 安装器 / dream 流程 / 自愈逻辑都走 store 或 `memory_dream_patch`），所以"拒写"不会误伤内部调用方。但**两个既有验收门会当场变红**（`_verify/topicdb-panel-check.mjs` 141 PASS / **2 FAIL** exit=1；`_verify/install-newuser-smoke.mjs s3` 6 PASS / **1 FAIL** exit=1），且拒写文案对**子代理**给的是"请用 memory_note"——而 memory_note 对子代理返回 `SUBAGENT_SKIP`，两条写通道同时关闭且文案误导。

改动 B 解决了"纯短行退化"这个真机根因（`做。`×300 现在两条路径都命中，实测），但：① **长短行混排时仍然完全不命中**（长行数 ≥20/≥15 就整段跳过短行分支），"熔断从不触发"只修好了一半；② 生效的取消阈值取决于消息字节数（<600 字符根本不做流式检查 ⇒ 只提醒不取消），25 / 50 / 20 三档互相打脸；③ 新增的测试**没有进 `_run-suite.mjs`**（它只扫根目录 `_test-*`/`_gate-*`），回归挡不住。

必修 4 条（见下）：修两个红门、改拒写文案、补混排覆盖、把测试接进套件。

---

## 逐条问题

### critical

（无）

### high

#### H1 改动 A 让两个既有验收门变红（实测，非推断）

**现象**：`_verify/topicdb-panel-check.mjs` 与 `_verify/install-newuser-smoke.mjs` 都用"主代理 exec"调 `memory_write`，现在一律返回 `WRITE_DREAM_ONLY`，断言当场红。历史上这两类脚本属于发布门清单（见 `docs/audit/digest-retire_AUDIT_2026-11-05.md#225` 的 G10：`_run-suite.mjs` + `test/plugin.smoke.test.mjs` + `_verify/topicdb-compat-check.mjs` + …）。

**证据（实测）**：
```
$ node _verify/topicdb-panel-check.mjs
FAIL  flag 开：memory_write 成功 ⇒ health.ok 计数增加  —  ok=0
FAIL  flag 开：memory_write 失败 ⇒ health.failed 计数 + 最近错误留痕  —  WRITE_DREAM_ONLY / null
141 PASS / 2 FAIL        exit=1

$ node _verify/install-newuser-smoke.mjs s3
FAIL  S3-6 空库上 memory_write 优雅拒绝（NOT_FOUND，不抛）  —  {"ok":false,"code":"WRITE_DREAM_ONLY",...}
结果: PASS=6 FAIL=1      exit=1
```
代码侧：`_verify/topicdb-panel-check.mjs#495`（`good.ok === true && health.ok>=1`）、`#498`（`bad.ok===false && health.failed>=1`）用的是 `execOf()` = `{agent:{session:{id:"panelcheck-N"}}}`（`#121`，无 header ⇒ 判 top ⇒ lead）；`_verify/install-newuser-smoke.mjs#145-148` 传的是 `{}`。
附带**覆盖损失**：拒写分支在 `topicDbHealthTick` **之前**返回（`index.js#11709-11716` vs 原 `#11710` 之后才 `topicDbHealthTick`），于是"写入健康计数"这个功能现在**零覆盖**（原先只有这个脚本测它）。

**建议**：① 两个脚本改用"dream 身份"exec（同 `test/_p25-write-guard-selftest.mjs#76-78` 的 `execDream` 手法：`__markPluginSubagent(sid)` + `header.origin:"subagent"`）；② 另加一条**负例**断言"lead 身份 ⇒ WRITE_DREAM_ONLY 且 health 计数不变"，把这次的行为固定下来；③ 若确认 `topicDbHealthTick` 只服务写入路径，考虑在拒写分支也计一次（否则面板"写入健康"永远只有 dream 轮才会动）。

#### H2 拒写文案把子代理推向另一条同样关闭的通道（实测双通道全关）

**现象**：`WRITE_DREAM_ONLY` 的 message 无条件写"请用 `memory_note` 记会话笔记"。但普通子代理调 `memory_note` 会拿到 `SUBAGENT_SKIP`（`index.js#17964` 的 `!isTopLevelSession(ag)` 闸）。于是子代理**没有任何写通道**，而文案却让它去试一条注定失败的通道——模型很可能来回试 `memory_write` / `memory_note`，正好会喂给插件自己的 D/E 打转检测。

**证据（实测，7 组 exec 形状）**：
```
1 empty exec                  actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"NO_SESSION"}
2 normal subagent             actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"SUBAGENT_SKIP"}
3 marked plugin (dream)       actor=dream code=OK              | note={"ok":false,"code":"SUBAGENT_SKIP"}
4 header origin=top(teammate) actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"NO_CWD"}
5 no header, root unset       actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"NO_CWD"}
6 no header AFTER sub-first   actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"SUBAGENT_SKIP"}
7 main header origin=top      actor=lead code=WRITE_DREAM_ONLY | note={"ok":false,"code":"NO_CWD"}
```
（`NO_CWD` 是我的探针 agent 没带 cwd，真实 teammate 会带；关键行是第 2 行。）
代码侧：文案 `index.js#11713`；子代理闸 `index.js#17964`；`actorOf` `index.js#11515-11520`。

**建议**：拒写 message 按 actor 分叉——`lead` 且非顶层会话时说"你是子代理：把结论写进最终报告（Findings worth promoting），由主会话决定是否记"；只有顶层会话才说 memory_note。这也和 `AGENTS.template.md#51`、`#17958-17962` 的既有口径一致。

#### H3 改动 B 对"长短行混排"仍然完全不命中（目标只达成一半）

**现象**：`shortLineRepeat` **只在长行数不足时**才被调用：消息级 `if (rows.length < TEXT_DEG_MIN_ROWS=20)`（`index.js#5720-5725`）、流式 `if (rows.length < 15) return shortLineRepeat(text)`（`index.js#5756`）。也就是说：**只要文本里还有 ≥20（或 ≥15）条 ≥6 字符的普通行，短行退化块就被整段忽略**。真机失控输出前面常有一句"好的，我继续。"这类长行——只要长行够多，这次补漏依旧不触发。

**证据（实测）**：
```
c 20长行+30行「是」   msg=null  tail=null     ← 长行 20 条把短行分支挤掉
d 14长行+30行「是」   msg={"kind":"short",...} tail={...}   ← 只差 6 条长行，行为翻转
e 30行OK+20长行       msg=null  tail=null
```
（`d` 的 chars=455 也顺带说明：消息级还有 `txt.length >= 400` 地板，`index.js#5710`，而流式没有。）

**建议**：两条路径都改成"**先跑短行判定，再跑长行判定**"（短行判定本身已经足够严：≥30 行 + ≥25 重复 + ≥85% 占比，且只看短行集合），或至少把条件从"长行不足"改成"短行集合达标即判定，长行判定独立跑"。改完必须补 H3 的混排负例/正例（见 Q6）。

### medium

#### M1 短行退化的"生效取消阈值"取决于消息字节数（25 vs 50 互相打脸）

**现象**：流式钩子要累积满 `TEXT_STREAM_CHECK_EVERY=600` 字符才检一次（`index.js#16559`、`#16578`）。因此：
- 消息 **> 600 字符**：流式在 maxN=25 时直接 `cancel`（`#16582-16596`，短行命中**没有**单独的提醒档）；
- 消息 **≤ 600 字符**：流式一次都不检，只剩消息级——而消息级要 `maxN >= TEXT_DEG_CANCEL_REPEAT=50` 才 cancel（`index.js#17110`），25~49 次**只提醒**。

即：同样"30 行短行退化"，写短一点只提醒、写长一点直接掐断。三档数字（短行 25 / 流式长行 20 / 消息级 50）不是同一条尺子。

**证据**：实测 `30 行「是」`（59 字符）= 只可能走消息级（`tail()` 虽返回 hit，但钩子根本不会调用它）；`300 行「做。」`（899 字符）> 600 ⇒ 流式在 ~200 行时即命中（maxN=200）。
**建议**：把"是否取消"和"是否提醒"统一成一个函数（入参 kind/maxN/chars），流式与消息级共用；或给短行也设"提醒档（25）/取消档（50）"，流式只做"提醒 + 到 50 才 cancel"。至少要写清"短行 25 次即取消"是有意的。

#### M2 短行路径的真实误报面（可构造，实测命中）

**现象**：`shortLineRepeat` 的短行集合是"1~5 字符且含字母/数字"的行，**不区分语义**。以下**非退化**输出会命中并被流式直接 cancel：
1. 单列/窄列判定表：`| 是 |` × 30（`chars=192`）；
2. 竖排逐项结论：`是` × 30（含缩进 `    是` 同样命中）；
3. 紧凑清单：`- 是` × 30；
4. CLI/状态粘贴：`OK` × 30、`はい` × 30；
5. 代码粘贴里的重复短语句：`i++` × 30（`rows=31`，含 ` ```js ` 这行）。
真实边界（实测）：`29 行` ⇒ null；`26/30 = 86.7%` ⇒ 命中；`25/30 = 83.3%` ⇒ null；五言诗 8 行 ⇒ null；交替 `是/否` ⇒ null。
**严重度**：medium。理由是阈值确实很紧（必须整段几乎全是短行），但**一旦命中就是不可撤销的 cancel**，且短行没有"先提醒"档（见 M1）。最可能误伤的真实形态是 **"逐项结论一行一个短判定词"**（模型对 30 项验收逐行只写 `是/通过`）和 **"CLI 输出按行粘贴的 OK"**。
**建议**：短行命中先走"提醒档"（第 1 次只提醒），同一会话第 2 次命中才 cancel；或对 `^[|]\s*\S{1,3}\s*[|]$`（窄表格行）与 `^[-*+]\s`（列表项）单独降权/排除。

#### M3 流式熔断对子代理**永不生效**（agentsBySession 只登记顶层）

**现象**：流式钩子靠 `agentsBySession.get(sid)` 拿 agent（`index.js#16587`），而这张表**只登记顶层会话**（`index.js#15961-15964`，注释原文"agentsBySession 只记顶层会话"）。子代理（含 dream/压缩子代理）的 sid 不在表里 ⇒ `ag` 为 undefined ⇒ 只记 `stream-hit ... hasAgent=false`，**不 cancel**。改动 B 第 4 条把 monitor 提到 `if (ag…)` 之前，正是为了让这种"检测到但没执行"可见——这点做得对，但能力缺口本身没补。
**证据**：`index.js#15961-15964`、`#16587`、`#16591`；消息级同理（`#17112`）。
**建议**：流式路径改为"先用 `agentsBySession`，miss 时用 subagent 管理器按 childId 查"；或在文档/面板上明写"熔断只覆盖顶层会话，子代理靠 GUARD 15 分钟硬停兜底"。

#### M4 新增测试没有进任何自动门

**现象**：`_run-suite.mjs` 只扫**根目录** `_test-*.mjs` / `_gate-*.mjs` / `_check-batch0-live.mjs`（`_run-suite.mjs#50-53`），`test/*.mjs` 与 `_verify/*.mjs` 都不在套件里（`#161` 明写 `test/*.ps1`、`onboard.unit.test.mjs` 不在验证面）。`test/_text-degeneration-selftest.mjs` 与 `test/_p25-write-guard-selftest.mjs` 头部只写了"跑法：node test/…"，没有任何 runner 引用它们（全仓 grep 无引用）。所以"测试能挡回归"**只在人记得手跑时成立**。
**证据**：`_run-suite.mjs#50-53`、`#161`；`test/_text-degeneration-selftest.mjs#3`；`test/_p25-write-guard-selftest.mjs#1`。
**建议**：把两个 selftest 接进 `_run-suite.mjs`（加 `ARG_IDX` 无关的直接跑），或至少加一条"发布检查清单里必须包含这两条命令 + 期望 PASS 数"。

#### M5 三处面向模型/用户的文案仍在指向 `memory_write`（改动 A 后全部是错的）

**现象**：改完之后这些字符串仍在教模型/用户"用 memory_write 改主题"，而该工具现在一律拒写：
- `index.js#7527`（写进每个导出 md 的 `<!-- dsh-memory: … -->` 标记行）；
- `index.js#9048`（面板 HTML 只读提示："改主题请用 memory_write 工具"）；
- `index.js#18338`（`memory_size_preview` 返回的 note："请用 memory_read 查看主题、memory_write 改单句"）；
- `README.md#96`、`#192`、`#211`（"关键内容用 memory_write（长期）"、工具表）。
另有耦合点：`_verify/topicdb-p6-check.mjs#61` 把标记行**逐字复制**成常量做断言，改 `#7527` 会连带红。
**建议**：三处改为 `memory_dream_patch` / `memory_note` 口径；README 同步；p6-check 的常量改成从源码读或用正则。

#### M6 安装清单/载荷与工作树不一致（按当前清单发版会**不带这两处改动**）

**现象**：`version.txt` = `4.5.1`，但 `install-manifest.json` 仍是 `"version": "4.5.0"`、`index.js` 记的是 `1457431 B / 724fa1b2…`（当前 1464890 B / 69CF267E…），`AGENTS.template.md` 记的是 `7723 B / 2de634f5…`（当前 7723? → 实测 `ef2516ef…`）；`payload/` 下只有 `4.0.1` 与 `4.5.0` 两个 zip。
**证据**：`install-manifest.json#2`、`#18-20`；`(Get-FileHash AGENTS.template.md)` = `ef2516ef0263c698…`；`payload/` 目录清单。
**建议**：发版前重跑 `_freeze-manifest` / `sync-payload`，确认 manifest 的 index.js sha 等于真身；否则"已实现未发布"会变成"发布了旧字节"。

### low

#### L1 `isTopLevelSession` 的 rootSessionId 兜底可把主会话误判成子代理（已实测复现）

**现象**：`rootSessionId` 由**第一个** `agent/created` 写入，**不区分是不是子代理**（`index.js#15960` 在 `if (isTopLevelSession(agent))` 之前）。若插件生命周期内第一个创建的是子代理（HMR 重载、恢复期、夹具顺序），之后所有 **header 缺失**的会话都会走兜底 `s.id === rootSessionId` ⇒ false ⇒ 被判"非顶层"。
**证据（实测）**：探针第 6 行——先 `callCreated(插件子代理)`，再拿一个 header 缺失的会话调 `memory_note`，返回 `SUBAGENT_SKIP`（说明 `isTopLevelSession` 已为 false）。
**影响面**：对改动 A 只是"理由错、结论对"（actor 仍是 lead ⇒ 拒写）；但同一判据还决定**记忆注入**（`#15961`/`#16334`）、A 类提醒、`agentsBySession` 登记（⇒ 流式熔断失效，见 M3）、维护检查。
**建议**：`rootSessionId` 只在 `isTopLevelSession(agent)` 为真时写入；或兜底判据换成"header 缺失 ⇒ 视为顶层"（更保守：宁可多注入，不可让主会话静默失能）。

#### L2 fork 出来的子代理 header **没有 origin**，会被判成 top（宿主注释自证）

**现象**：`dsh-subagent/lib/types/archive-admission.js#90-91` 注释原文："header names its parent and carries the subagent origin this package records, at any depth. **A fork shares the lineage field without the origin**"。⇒ fork 子代理 `header.origin === undefined` ⇒ `isTopLevelSession` 走第二分支 `origin !== 'subagent'` ⇒ **true**。改动 A 下这类会话仍被拒写（结论安全），但它们会被登记进 `agentsBySession`、吃记忆注入（ghost 轮）。
**证据**：`dsh-subagent/.../archive-admission.js#90-99`；`index.js#12355-12361`。
**建议**：判据补一条 `if (s.header.parentSession !== undefined) return false;`（有 parent 就是子代理），比只看 origin 稳。

#### L3 `markPluginSubagent` 的 LRU 上限 200 + "spawn 后才登记"存在理论误拒

**现象**：`PLUGIN_SUBAGENT_SIDS` 是 LRU，超过 `MAX_PLUGIN_SIDS=200` 会挤掉最老的 sid（`index.js#1927-1934`）；登记发生在 `await startSubagentCompat(...)` **之后**（`#13227`、`#19355`）。若一个长驻 dream 子代理被后续 200 次 spawn 挤掉，或子代理在登记前就跑完第一步并调用 `memory_write`，actor 会退化成 `lead` ⇒ 误拒。
**现实性**：低（dream 一轮通常 < 200 次 spawn，且第一步就写库不常见），但"误拒=数据不落库且模型看到 ok:false"是不可忽略的失败模式。
**建议**：dream 的 sid 单独用一个不参与 LRU 的集合；或把登记提前到 `start` 返回 handle 的同一 tick（无法更早）；至少给 `WRITE_DREAM_ONLY` 的 `actor` 加一个 `kind` 字段（top/plugin/normal）方便事后定位。

#### L4 dream 的工具白名单里没有 `memory_write`（allow 分支实际不可达，除非宿主丢 toolFilter）

**现象**：dream spawn 的 `toolFilter.allow` 列表（`index.js#19353`）只有 `read/grep/glob/memory_search/memory_size_preview/dsh_*_thresh/memory_dream_patch/memory_split_topic/memory_review_topic`，**没有 memory_write**；dream 的任务书也一律要求走 `memory_dream_patch`（`#3856-3857`、`#17886`）。所以"dream 可以写"这条放行分支在正常路径上**用不到**（只有 `__markPluginSubagent` 测试钩子能走到；或 0.2.x 宿主丢弃 toolFilter 时才有理论可能，见 `#16951` 的实测注释）。
**含义**：改动 A 事实上是"**对所有人关闭** memory_write"，工具仍注册、仍占 prompt 预算、仍可能被模型调用一次（浪费一步）。
**建议**：明确取舍——要么保留工具但把 description 改成"已停用，请用 memory_note"，要么干脆不注册（flag 关时本来就不注册，可复用同一开关）；否则每会话多一次无效工具定义开销 + 偶发无效调用。

#### L5 测试里的空断言/过期注释

- `test/_text-degeneration-selftest.mjs#116`：`ok(/for await \(const chunk of stream\) \{ signal\.throwIfAborted\(\);/.test(src) === false || true, "E3 …")` —— **`|| true` 恒真**，E3 是空断言（它想证明"宿主流循环每 chunk 查 abort"，实际什么都没证明）。
- `test/_text-degeneration-selftest.mjs#101`：C4 的文案写"<800 字"，代码地板已是 **400**（`index.js#5710`），且用例只有 4 行，测不到边界。
- `test/_text-degeneration-selftest.mjs#148-149`（E14/E15）只测"刚好不够"，没测"刚好够"（rows=30 & maxN=25 & 占比 0.833 是 null；26/30=0.867 才是命中，实测）。
**建议**：删掉 `|| true`；把 400/30/25/0.85 四个边界都写成双向断言（`rows=29 null` / `rows=30 hit`、`maxN=24 null` / `25 hit`、`25/30 null` / `26/30 hit`）。

---

## 反例清单（改动 B 的误报构造，可直接复现）

下面每一条都是我**实际跑过**的（快照 69CF267E）。把 `$PLUGIN` 换成本机路径即可复现。

```powershell
# 用法：保存为 %TEMP%\cra-shortline.mjs 后 node 执行（只读插件导出函数，不写任何库）
$code = @'
const os = await import("node:os"); const path = await import("node:path"); const fs = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cra-"));
process.env.DSH_HOME = path.join(TMP, "home");
process.env.DSH_MEMORY_ROOT = path.join(TMP, "home", "memory");
process.env.MEMTOPIC_DB = path.join(TMP, "home", "memory", ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;
const mod = await import(pathToFileURL("E:/工具/插件开发调整/dsh-memory-plugin/index.js").href);
const tail = mod.__textStreamTailRepeat, det = mod.__detectTextDegeneration;
const J = (x) => x ? JSON.stringify(x) : "null";
const L = (n, s) => Array.from({length:n},()=>s).join("\n");
const longRow = (i) => "第" + i + "条：这是一行足够长的正常内容，用来把短行路径挤掉。";

// ── 误报构造（全部非退化，全部命中）──
console.log("N1 单列窄表格 | 是 | x30        tail=" + J(tail("| 结论 |\n|---|\n" + L(30,"| 是 |"))));
console.log("N2 竖排逐项结论 是 x30          tail=" + J(tail(L(30,"是"))));
console.log("N2b 带缩进 是 x30               tail=" + J(tail(L(30,"    是"))));
console.log("N3 紧凑清单 - 是 x30            tail=" + J(tail(L(30,"- 是"))));
console.log("N4 CLI 粘贴 OK x30              tail=" + J(tail("服务状态：\n" + L(30,"OK") + "\n以上全部正常。")));
console.log("N5 多语言 はい x30              tail=" + J(tail(L(30,"はい"))));
console.log("N6 代码粘贴 i++ x30             tail=" + J(tail("```js\nfor(;;){\n" + L(30,"i++") + "\n}\n```")));
console.log("N7 窄表 |是| x30 + 12 长行      msg=" + J(det([{type:"text",text:L(30,"|是|")+"\n"+Array.from({length:12},(_,i)=>longRow(i)).join("\n")}])));

// ── 漏报构造（真退化，全部 null）──
console.log("M1 20 长行 + 30 行「是」        msg=" + J(det([{type:"text",text:Array.from({length:20},(_,i)=>longRow(i)).join("\n")+"\n"+L(30,"是")}]))
            + "  tail=" + J(tail(Array.from({length:20},(_,i)=>longRow(i)).join("\n")+"\n"+L(30,"是"))));
console.log("M2 30 行 OK + 20 长行           tail=" + J(tail(L(30,"OK")+"\n"+Array.from({length:20},(_,i)=>longRow(i)).join("\n"))));
console.log("M3 14 长行 + 30 行「是」(对照，命中) msg=" + J(det([{type:"text",text:Array.from({length:14},(_,i)=>longRow(i)).join("\n")+"\n"+L(30,"是")}])));

// ── 边界 ──
console.log("B1 29 行「是」                  tail=" + J(tail(L(29,"是"))));
console.log("B2 26/30 = 86.7%                tail=" + J(tail(L(26,"是")+"\n"+L(4,"否"))));
console.log("B3 25/30 = 83.3%                tail=" + J(tail(L(25,"是")+"\n"+L(5,"好。"))));
console.log("B4 交替 是/否 x40               tail=" + J(tail(Array.from({length:40},(_,i)=>(i%2?"是":"否")).join("\n"))));
console.log("B5 五言诗 8 行                  tail=" + J(tail("床前明月光\n疑是地上霜\n举头望明月\n低头思故乡\n日照香炉生紫烟\n遥看瀑布挂前川\n飞流直下三千尺\n疑是银河落九天")));
console.log("B6 真退化 做。x300              tail=" + J(tail(L(300,"做。"))) + "  msg=" + J(det([{type:"text",text:L(300,"做。")}])));
try { fs.rmSync(TMP, {recursive:true, force:true}); } catch {}
'@
```

**实测输出（本机，快照 69CF267E）**：

| 用例 | 结果 | 判定 |
|---|---|---|
| N1 单列窄表格 `\| 是 \|`×30 | `{"kind":"short","rows":30,"maxN":30,"ratio":97}` | **误报（会 cancel）** |
| N2 / N2b 竖排 `是`×30（含缩进） | `{"kind":"short",...maxN":30}` | **误报（会 cancel）** |
| N3 `- 是`×30 | `{"kind":"short",...maxN":30}` | **误报（会 cancel）** |
| N4 `OK`×30 | `{"kind":"short","rows":31,"maxN":30}` | **误报（会 cancel）** |
| N5 `はい`×30 | `{"kind":"short",...maxN":30}` | **误报（会 cancel）** |
| N6 `i++`×30（代码块） | `{"kind":"short","rows":31,"maxN":30}` | **误报（会 cancel）** |
| N7 `\|是\|`×30 + 12 长行 | msg 命中（`chars=457`） | **误报（会 cancel）** |
| M1 20 长行 + 30 `是` | `msg=null tail=null` | **漏报（真退化不拦）** |
| M2 30 `OK` + 20 长行 | `tail=null` | **漏报** |
| M3 14 长行 + 30 `是` | 命中 | 对照：只差 6 条长行行为翻转 |
| B1 29 行 | null | 正确（行数闸） |
| B2 26/30 | 命中 | 边界=85% 生效 |
| B3 25/30 | null | 正确 |
| B4 交替是/否 | null | 正确（占比闸） |
| B5 五言诗 8 行 | null | 正确（行数闸） |
| B6 `做。`×300 | 两条路径都命中 | **改动目标达成** |

**最可能误伤的真实输出形态（按风险排序）**：
1. **"逐项结论一行一个短判定词"**（`是` / `通过` / `OK` / `はい` 各占一行，30 项以上）——真实且常见于验收/清单类回答；一旦命中就是**流式直接掐断**，没有提醒档。
2. **窄列 markdown 表格**（单列或两列且单元格极短，如 `| 是 |`、`|是|`）。
3. **CLI / 测试输出按行粘贴**（`OK`、`PASS`、`done` 每行一条）。
4. **代码粘贴中的重复短语句**（`i++`、`pass`、`continue` 单独成行 ≥25 次）——真实概率低。
5. 诗歌/多语言短句排版：**低**（需要 ≥25 行完全相同，真实诗作/歌词不会）。

---

## 对 6 个问题的直接回答

### Q1 改动 A 会不会误伤内部调用方

**不会误伤"内部代码"，但会误伤"内部验收脚本"。**

全仓 `memory_write` 出现点（排除 `node_modules` / `*.bak` / `docs/`）：

| 位置 | 性质 | actor 来源 | 改后行为 |
|---|---|---|---|
| `index.js#11708-11716`（`name:"memory_write"` 注册 + 闸） | 定义 | — | — |
| `index.js#7527` / `#9048` / `#18338` | **字符串**（标记行/面板/预览 note） | — | 文案变错（M5） |
| `index.js#11636-11643` 等 10 处注释 | 注释 | — | 无 |
| `AGENTS.template.md#7`、`#51` | 文档 | — | 已同步 4.5.1 ✔ |
| `README.md#96`、`#192`、`#211` | 文档 | — | **未同步**（M5） |
| `install.ps1#255`、`install.sh#621` | 注释（模板 hash 白名单说明） | — | 无功能依赖 ✔ |
| `_verify/topicdb-panel-check.mjs#495`、`#498` | **调用工具** | `execOf()`=无 header ⇒ top ⇒ **lead** | **成功 → WRITE_DREAM_ONLY**（红，H1） |
| `_verify/install-newuser-smoke.mjs#145-148` | **调用工具** | `{}` ⇒ lead | **NOT_FOUND → WRITE_DREAM_ONLY**（红，H1） |
| `test/_p25-write-guard-selftest.mjs#82-88`（B6~B9） | 调用工具（负例） | `{}` ⇒ lead | 已按新语义更新 ✔（45/45 PASS） |
| `test/_p25-sim-hint-selftest.mjs#118` | 静态正则 | — | 无 |

**关键结论**：命令（`memory-panel/-init/-update/-migrate/-search`，`index.js#20126/#20186/#20208/#20283/#20334`）、dream 流程（`#19340-19355` 走 `memory_dream_patch`）、P2.5 检查点/自愈（直接 `store.appendSentence` / `topicDbIntentRoute`）、安装器，**都不调用这个工具**。所以"非模型路径依赖它"的答案是：**没有**；从"成功"变成 `WRITE_DREAM_ONLY` 的只有上面两个 `_verify` 脚本（以及模型自己）。

### Q2 actor 判定是否可被绕过或误判

- **插件子代理被误判成 top**：正常不会。子代理 header 恒为 `origin:'subagent'`（`dsh-subagent/lib/types/child-agent.js#117`），`isTopLevelSession` 第一分支即返回 false。**例外**：① fork 子代理 header 无 origin（L2）；② header 完全缺失且 sid 恰好等于 `rootSessionId`（只有第一个 agent/created 是它时可能）。
- **主会话被误判成 plugin**：**不可能**。`plugin` 要求 sid ∈ `PLUGIN_SUBAGENT_SIDS`，而该集合只在插件 spawn 点登记（`#13227`、`#19355`）；主会话 sid 不会进入。
- **主会话被误判成 normal（非 top）**：**可能**，且已实测复现（L1）。触发条件是 header 缺失 + `rootSessionId` 被别的会话先占。对改动 A 结论安全（仍拒写），但会连带关掉记忆注入/熔断登记。
- **teammate（独立会话）**：`origin` 不是 `subagent` ⇒ `isTopLevelSession` = **true** ⇒ kind=`top` ⇒ actor=**lead** ⇒ **拒写**（实测第 4/7 行）。这与代码注释 `#11707`（"teammate（独立会话，kind='top'）→ lead 一律拒"）一致；`memory_note` 对 teammate 仍可用（注释 `#17963` 亦如此声明）。
- **绕过面**：`actorOf` 的 try/catch 在异常时返回 `"lead"`（`#11519`）——fail-closed，方向正确。`deps.kindOf` 缺失时默认 `"top"`（`#11517`）——也是 lead，正确。**唯一真正的绕过**是"任何能让 sid 进 `PLUGIN_SUBAGENT_SIDS` 的路径"，目前只有插件自己的 spawn 与测试钩子 `__markPluginSubagent`（`#8390` 导出）。测试钩子在生产模块里对外导出，理论上可被其他插件调用——但那是既有设计，非本次改动引入。

### Q3 改动 B 的误报风险

见「反例清单」与 M2。结论：**阈值本身很紧（必须整段几乎全是短行），误报面窄但非零**；最可能误伤"逐项结论一行一个短判定词"和"窄表格/CLI 粘贴"。严重度 **medium**，原因是**代价不对称**：误报 = 不可撤销的 cancel（用户看到半截回答），而短行命中没有"先提醒"档。

### Q4 熔断误杀的后果（宿主源码已核）

`ag.cancel({kind:"hook", reason}, {keepInbox:true})` 之后宿主怎么走（`dsh-agent-loop/lib/index.js`）：

1. `cancel()`：`keepInbox` 为真 ⇒ **不清空 inbox**、不动 `wakeRequested`；然后 `this.phase.abort.abort(cause)`（`#815-821`）。
2. 流循环 `for await (const chunk of stream) { signal.throwIfAborted(); live.push(chunk); }`（`#1088-1091`）⇒ 下一个 chunk 立刻抛出，**真的中断生成**（不是事后止损）。
3. 抛出后宿主**先把已生成的部分落盘**：`if (signal.aborted) { const content = live.interruptedBlocks(); … session.append("assistant/message", {…, interrupted: true, …}) }`（`#1096-1112`）。⇒ **不是"什么都没有"，而是"半截内容 + interrupted 标记"**。
4. `turn()` 捕获 ⇒ `turnEnds = {kind:"aborted", reason:{kind:"hook", reason}}` ⇒ `session.append("turn/end", …)`（`#1010-1036`）。
5. `kick()` 的 `while (await this.turn())` 因 abort 抛出 ⇒ `catch (_error) {}` ⇒ `finally` 置 idle（`#887-901`）。**没有任何自动重试**（`agent/request-error` 的 retry 只走 LLM 失败路径，`#1136-1146`；abort 在到达那里之前就抛了）。

**用户看到什么**：
- 界面把该轮标成**"已停止"**（`dsh-client-ui-chat/lib/client.js#6659`：`reason === "aborted" || "interrupted"` ⇒ `message.stopped`；`#5868` 文案"已停止"），且该轮的"过程块"**强制保持展开**（`#4159` `alwaysOpen`）。
- **没有错误横幅**：`endFailure()` 只在 `reason.kind==="hook" && reason.reason==="deepseek-account/signed-out"` 时给失败提示（`#10511`），我们的 reason 串（`text-degeneration-stream maxN=…`）不匹配 ⇒ 无 banner、无原因说明。
- 半截回答留在记录里（`interrupted:true`），刷新后仍在，但没有"为什么停"的说明。
- 下一轮还会收到一条 `system-reminder【文本退化】…`（`index.js#17099`，因为中断后的 partial message 仍会触发消息级检测）——误杀时这条提醒同样会误导。

**`keepInbox:true` 的副作用**：inbox 保留。若用户在被掐断前已经 steer/followup 了一条消息（`send(..., wakeup=true)` 会置 `wakeRequested`），`kick()` 的 finally 会 `if (wakeRequested && this.inbox.hasPending) this.wakeDriver()`（`#898`）⇒ **立刻开新一轮**，带着"半截退化消息"的历史继续跑。对比：用户自己点停止是 `cancel({kind:'user'})` **不带** `keepInbox`（`dsh-agent/lib/index.js#18-20` 注释原文），会丢弃排队输入。⇒ 插件熔断**比用户停止更"温和"**，这是有意的，但也意味着"掐断后马上续跑"是可能的。

### Q5 两条检测路径的关系

| 维度 | 流式（`agent/assistant-stream`） | 消息级（`session/event`） |
|---|---|---|
| 输入 | 尾部 3000 字符窗口（`#5744`），每 600 字符检一次（`#16559`/`#16578`） | 整条消息的每个 text/reasoning 块（`#17093`），块需 ≥400 字（`#5710`） |
| 长行闸 | 长行 ≥15，重复 ≥20，唯一率 ≤30%（`#5747`/`#5762`） | 长行 ≥20，重复 ≥10，唯一率 ≤25%（`#5667-5669`/`#5731`） |
| 短行闸 | 走 `shortLineRepeat`：短行 ≥30、重复 ≥25、占比 ≥85%（`#5680-5702`），**命中即 cancel**（无独立档） | 同函数，但 cancel 仍需 `maxN ≥ 50`（`#17110`） |
| 动作 | 命中 ⇒ 立即 `cancel`（`#16593`） | 命中 ⇒ 先 `enqueueRegressionReminder`（`#17099`），`maxN≥50` 再 cancel（`#17114`） |

**会出现"消息级只提醒、流式已 cancel"的不一致吗**：会，而且是**常态**。
- 短行：>600 字符的文本，流式在 maxN=25 就掐断，消息级 50 档**永远到不了**（到不了就先被流式杀了）⇒ 50 这个数字对短行是死代码。
- 短行：≤600 字符的文本，流式一次都不检（`pending < 600` 直接 return），只剩消息级 ⇒ 25~49 次**只提醒不取消**。
- 长行：同样早就存在（流式 20 vs 消息级 50），改动 B 只是把这种不对称扩展到短行。
- 反向不一致也存在：**混排**（H3）两条路径都不命中。

**建议**：抽一个 `degenerationVerdict(hit, chars, path)` 统一决策，明确"提醒档 / 取消档"各是什么，并让两条路径读同一张表；顺手把 `TEXT_DEG_CANCEL_REPEAT=50` 从短行语义里删掉（或把短行取消档也定成 50，与提醒 25 配对）。

### Q6 测试是否真的能挡住回归

**`test/_text-degeneration-selftest.mjs`（40/40 PASS，实测）**：
- **真断言（改前会红）**：E12（300×`做。` 命中）、E16（消息级短行命中）、E13（纯符号短行不误报）、E14/E15（行数/占比闸）。
- **空断言**：`E3`（`… .test(src) === false || true`，恒真，`#116`）。
- **过期文案**：C4 写"<800 字"，代码是 400（`#101` vs `index.js#5710`）。
- **缺的负例**：① 混排（长行 ≥15/≥20 + 短行块）——现在会**漏报**，但没测；② 短行误报形态（窄表格 / `- 是` / `OK` / `はい` / 代码块）一条都没有；③ 边界只测了"不够"，没测"刚好够"（rows=30、maxN=25、26/30=86.7%）；④ 流式 600 字符节流（"<600 字符不检"）没有任何断言。

**`test/_p25-write-guard-selftest.mjs`（45/45 PASS，实测）**：
- **真断言**：B6/B7（lead ⇒ WRITE_DREAM_ONLY）、B9（拒写后句数不变）、B1~B5（dream 身份下 P2.5 守卫与正常写入）、E2（sid8 绕过）。
- **弱断言**：B8 只正则 `memory_note` 出现在 message 里（文案级）；B9 在"闸在写入之前"的结构下几乎是必然真（但它确实能抓住"先写后判"的错序，保留）。
- **缺的负例**（按重要性）：
  1. **普通子代理**（`header.origin:"subagent"` 且**未**登记）⇒ 必须 `WRITE_DREAM_ONLY` —— 这是 `plugin`/`normal` 的边界，一条都没有；
  2. **teammate / 独立顶层会话** ⇒ 必须 `WRITE_DREAM_ONLY`（顺带验 `memory_note` 仍可用）；
  3. **header 缺失 + rootSessionId 兜底**两个方向（L1）；
  4. **`monitorEvent("memory","main-agent-write-denied")` 真的被发出**（改动 A 唯一的可观测点，无断言）；
  5. **fork 子代理**（header 有 parentSession、无 origin，L2）⇒ 应拒写。

**最要紧的一条**：这两个文件**都不在 `_run-suite.mjs` 的扫描面内**（M4），所以"断言写得好不好"其实是次要问题——**它们根本不会在门里跑**。

---

## 诚实缺口

**读了什么**
- `index.js` 全文快照（69CF267E / 20580 行）中与本审计相关的段落：`actorOf`(#11515-11520)、拒写闸(#11708-11716)、`isTopLevelSession`(#12352-12361)、`hintKindOf`(#12368-12371)、`markPluginSubagent`(#1924-1934)、`agentsBySession` 登记(#15957-15965)、spawn 与登记(#13212-13245、#19338-19358)、dream toolFilter(#19353)、`shortLineRepeat`(#5660-5702)、`detectTextDegeneration`(#5704-5737)、`textStreamTailRepeat`(#5740-5765)、流式钩子(#16555-16598)、消息级检测(#17088-17121)、`memory_note` 子代理闸(#17948-17970)、三处 `memory_write` 文案(#7527/#9048/#18338)。
- 全仓 `memory_write` 出现点（`index.js` / `test/` / `_verify/` / `install.ps1` / `install.sh` / `README.md` / `AGENTS.template.md`）。
- `test/_text-degeneration-selftest.mjs`、`test/_p25-write-guard-selftest.mjs` 全文；`_run-suite.mjs` 全文；`_verify/topicdb-panel-check.mjs` 头部+相关段；`_verify/install-newuser-smoke.mjs` 相关段。
- 宿主：`dsh-agent-loop/lib/index.js`（cancel #815-821、cancel cause #731-745、kick #887-901、turn/end #1010-1036、流循环 #1088-1092、interrupted 落盘 #1096-1112、attemptId #383、settle/abandon #416-447）、`dsh-session/lib/index.js#58-59`、`dsh-subagent/lib/types/child-agent.js#117`、`dsh-subagent/lib/types/archive-admission.js#90-99`、`dsh-client-ui-chat/lib/client.js#4159/#6659/#10511`、`dsh-agent/lib/index.js#18-20`。
- 实测：两个 selftest（40/40、45/45）、`_verify/topicdb-panel-check.mjs`（141/2 FAIL exit=1）、`_verify/install-newuser-smoke.mjs s3`（6/1 FAIL exit=1）、两批短行构造探针（16 个用例）、7 组 actor 形状探针。

**没读什么 / 未验证**
- **`index.js` 是移动目标**：审计期间至少 3 个版本（20543 → 20572 → 20580 行）。本文所有行号只对 `69CF267E` 成立；我**没有**逐个版本 diff，无法保证没有第四次改动引入新问题。
  - 收尾复核（08:30）：线上 `index.js` 仍等于本审计快照（1464890 B / `69CF267E…` / mtime 08:17:16），即**审计结论对当前字节有效**；但审计开始阶段读到的 20543 行版本已不存在，若需要复现请以 69CF267E 为准。
- **UI 端到端未实测**：`已停止` 文案、无错误 banner、半截内容保留，全部来自宿主/客户端**源码阅读**，没有真的掐断一次会话去看界面。
- **`dsh-agent` 的公开 `Agent` 类型 `.d.ts` 未逐字核对 `cancel` 签名**（只在 `dsh-agent-loop` 实现里核了 `cancel(cause, {keepInbox})`，插件侧另有 `typeof ag.cancel === "function"` 能力探测）。
- **`__markPluginSubagent` 生产可达性**未核（它作为测试钩子导出，是否会被其它插件调用未评估）。
- **`payload/*.zip` 内容未解包比对**（只比了 `install-manifest.json` 的 sha 与真身）。
- **真机退化样本未重放**：只用了 selftest 里引用的真日志（B1/B4 由 selftest 跑通），没有自己再扫会话日志统计"短行退化 + 混排"的真实占比——所以 H3 的"漏报面"严重度是**代码推理 + 合成用例**，不是线上频次统计。
- **`_verify` 两个脚本的修复未验证**（我是只读审计，没有改它们，也没有试跑修复版）。
