# CRA · 升级后让用户 Agent 自检记忆插件（设计评审）

- 需求原话（逐字）：「发之前，添加一个小功能或者md吧，就是每次其他用户触发升级流程的时候，能让用户的 Agent 进行记忆插件的功能检查」
- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（工作副本 v4.5.3，`PLUGIN_VERSION` 见 `index.js#635`；已安装副本 `~/.dsh/profiles/web/plugins/memory/index.js` 同为 4.5.3）。
- 审计性质：**只读设计评审**，未改代码、未构建、未部署、未写数据库/`.onboard.json`。本报告按 CRA 模板：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最小 diff + 注入文案）。

---

## 0. 结论（先给判断）

**推荐：一次性会话注入（`agent/created`，与迁移提醒同一通道）+ 隐藏的 `memory_onboard action=selfcheck` 工具动作 + `/memory-check` 用户命令 + md 清单；不新增工具、不改工具 schema、不改 AGENTS.md。**

- 纯 md / 安装器 `-CheckOnly` 都**不能自动让用户的 Agent 去查**：md 要用户主动问，安装器只做静态体检（且已是现有功能，见 `install.ps1#9-11/#52-54`）；`onboardSummary` 只显示在统计面板，Agent 看不到。唯一能让 Agent 在升级后自动看到指令的，是会话注入。
- **最省前缀缓存的注入方式**：`agent/created` 里用 `agent.inject` 在**会话历史尾部**追加一次（`index.js#16619-16620` 的既有纪律：只追加、不改已有前缀），一次性、约 75 字；**不新增工具、不改 `memory_onboard` 的 schema/description**（`memory_onboard` 的 `action` 本来就是无 enum 的 string，`index.js#19004`，加隐藏分支不需要改 schema）⇒ 不触发工具定义层的前缀失效；命令和 md 不进模型上下文。
- **不要复用 `update.notifiedAt`**：它是「远端有新版本」提醒的每日节流位（`index.js#984/#1005/#1394/#1424`），语义不同；升级自检用新字段 `upgradeCheck`。
- **`.onboard.json` 加字段必须同时加 `mergeOnboardState` 白名单**（`index.js#975-993`），否则写入后读取会被默认值吞掉；这是本次设计最容易漏的一处。
- **老用户首次升级（有 `.onboard.json`、无 `lastVersion`）建议按「一次性升级」处理**（from 记「旧版本」），否则所有老用户都会漏掉第一次提醒；全新用户（无文件）才静默建立基线。详见 §4/§5。
- **`/memory-check` 的 Agent 可达性需要修正**：斜杠命令是用户入口，Agent 不能直接执行（推断：DSH commands 为用户侧入口，仓库无命令→工具桥；见 §5/§6.1）；必须把同一实现挂到 Agent 可调用的 `memory_onboard` 隐藏 action（或新工具，但新工具会改工具 schema）。这是 lead 设计 B 的关键缺口。
- **自检项 5（`/dsh-memory/note-stat.json`）已经存在**（`index.js#12508-12529`，本机实测 200/67B/121ms），不是待建依赖；自检项 4 的 `stats.json` 实测 **1.2s / 462KB**，建议改为轻量探活 + 可选 `full`，不要默认跑全量。
- **自检项 6「AGENTS.template.md 归一化 sha 是否在安装器白名单」在运行期不可行**：`install-manifest.json` 不在插件安装目录（本机确认缺失），白名单只在安装器侧；运行期改为「版本三处一致 + 模板 marker」，sha 交给 `install.ps1 -CheckOnly`。本机安装副本当前 `version.txt`/`package.json` 还是 **4.0.1**（index.js 已是 4.5.3）⇒ 自检项 6 现在就会 FAIL，这正好证明该检查有用（修复=重跑安装器）。

**注入文案（≤80 字，一次性）**：

```text
<system-reminder>
【dsh-memory 升级自检】{from}→{to}：请调用 memory_onboard（action=selfcheck）跑只读自检并报 PASS/FAIL。
</system-reminder>
```

（`{from}`=旧版本号或「旧版本」，`{to}`=当前版本；不含时间戳/路径，落历史即冻结。）

---

## 1. 表 1 · 调用链：现有注入通道与升级提醒该挂哪

| 通道 | 代码位置 | 语义 | 适合升级提醒？ |
|---|---|---|---|
| **`agent/created`（会话开始）** | 注册 `index.js#16554`；payload `{agent,source,signal}`、source∈startup/resume/clear/compact（`#16547-16554`）；只对顶层会话 `#16571`；现有调用点 `#16935-16942` | 异步串行事件；回调同步返回、异步 IIFE fire-and-forget；现有初始化引导/迁移提醒/新版提醒都走这里；`agent.inject` 在历史尾部追加（`#16619-16620` 明确前缀纪律） | **推荐**。与迁移提醒同一位置/同一生命周期；一次性状态天然可落 `.onboard.json`；不影响 pre-step 决策链 |
| `agent/pre-step`（每轮请求前） | `#16952`、`#17100-17124`；A 类提醒直入 `#17045/#17089`；note 15% 提醒 `#1876-1937`、入队/消费 `#5479/#17100-17124` | waterfall；返回 `{...decision, messages:[...]}` 只进**当轮请求**，不进历史（`#1883`、`#17119-17120`） | 可作为「零历史污染」备选，但提醒只在某一轮出现，Agent 漏看就丢；且需额外 gate step/session。不如 `agent/created` 稳 |
| `session/event`（压缩/摘要） | `#17795-17837`；`agent.inject` 延迟到 setTimeout 避重入 `#17812-17827`；重灌 `#17937` | 压缩后注入刷新提示/重灌块；时序在压缩之后 | **不适合**：升级提醒与会话压缩无关；且此通道已有重入/时序复杂度 |
| `loader/volatile-update`（配置热更） | `#12404-12440` | 只处理配置 flag 热更新（topicdb 开/关等），不注入用户消息 | **不适合** |
| `system-reminder` | 文本包装 `#885-930`、`#1933-1937` | 只是注入文本格式，不是独立通道 | 用于提醒文案包装即可 |
| `agent.inject` | `#1346/#1451/#1426` 等 | 把 `makeMessage` 追加进会话历史（尾部）；`#16619-16620` 前缀纪律 | 升级提醒用它，一次性 |

**冲突检查**：
- note 15% 提醒走 `REGRESSION_QUEUE` + pre-step **当轮临时消息**（`#1883`、`#17119-17120`），不进历史、不占注入预算；升级提醒在会话开始一次性追加历史尾部，二者通道/时序不同，**不打架**。
- 重灌（post-compact rehydrate）在压缩后注入（`#17812-17837`），升级提醒在 `agent/created`；不同时机，**不打架**。
- 初始化引导/迁移提醒/维护提醒都在 `agent/created` 尾部（`#16930-16941`）；升级提醒加在 `#16941` 之后即可，注意同一会话可能同时出现多条一次性提醒（init/migrate/upgrade），文案要短、可共存；若担心堆叠，可在「刚注入初始化引导」时跳过升级提醒（新用户本来不会触发，见 §4）。

---

## 2. 表 2 · 状态交互：`.onboard.json` 谁读谁写、加字段会怎样

### 2.1 结构/读写入口

- 路径：`ONBOARD_FILE = MEMORY_ROOT + "/.onboard.json"`（`index.js#1016`）；`MEMORY_ROOT` 默认 `~/.dsh/memory`（`#593-594`），**desktop/web profile 共用同一文件**。
- 默认值：`defaultOnboardState`（`#963-972`）现有字段 `initPromptedAt/snoozeUntil/ready/update/migrateNotice`；**没有 `lastVersion`**。
- 读取：`readOnboardState`（`#1019-1023`）→ `mergeOnboardState`（`#975-993`）**逐字段白名单**；老文件缺字段/类型漂移回默认；**未列入白名单的新字段会被丢弃**。
- 写入：`writeOnboardState`（`#1025-1034`）→ `writeFileAtomic`（`#557-572`，tmp+rename 原子替换，**无跨进程锁**）。
- 当前真实文件（只读查看）：`~/.dsh/memory/.onboard.json` 无 `lastVersion`；`update.latest=4.5.1`、`notifiedAt=0`；`migrateNotice` 空。⇒ 本机就是「老用户首次升级」形态。

### 2.2 读点（12 处）

| 函数 | 行 | 用途 |
|---|---|---|
| `migrateConsumePendingBeforeOpen` | `#1307` | 迁移完成后写 `migrateNotice=done` |
| `maybeInjectMigrateNotice` | `#1332` | 会话开始迁移提醒判定 |
| `checkForUpdate` | `#1379` | 每日升级检查 |
| `notifyUpdateNow` | `#1414` | 新版可用提醒 |
| `maybeInjectInitGuide` | `#1440` | 初始化引导 |
| `forceInitGuide` | `#1470` | `/memory-init` 强制引导 |
| `snoozeInitGuide` | `#1488` | 用户说回头再说 |
| `onboardStatusLine` | `#1511` | 设置/统计面板一行状态 |
| `memory_onboard` 工具 | `#19024/#19034` | 状态/查新版 |
| `/memory-init` | `#20866` | 命令回显 |
| `/memory-update` | `#20890` | 绕过节流查新版 |

### 2.3 写点（12 处）

`#1309`（迁移完成）、`#1343/#1348`（迁移提醒清/写）、`#1385/#1395`（升级检查）、`#1425`（新版提醒）、`#1443/#1449`（初始化引导）、`#1473`（强制引导）、`#1491`（snooze）、`#19026`（memory_onboard check-update）、`#20892`（/memory-update）。

**结论**：全部写点都是「`readOnboardState()` → 改字段 → `writeOnboardState(st)`」全对象覆盖；只要新字段进白名单，正常读写会保留；但**并发/跨进程写仍可能丢更新**（无锁；`writeFileAtomic` 只保证单次替换原子）。升级检测在 apply 启动期同步执行、且发生在这些写点之前，同进程内不会丢；desktop+web 两个 Host 同时启动时有窗口（见 §3）。

### 2.4 字段语义别混用

- `update.notifiedAt`：**远端有新版本**提醒的节流位，注入新版提醒时置 `Date.now()`（`#1424`），已是最新时清零（`#1394`），每日节流（`#1005`）。**不要拿它当升级自检的一次性标记**。
- `migrateNotice`：每插件版本最多一次（`#970` 注释、`#1129-1141` 判定、`#1328-1355` 注入+写状态），是升级提醒可借鉴的**同款一次性状态机**；但它的 `version/pendingAt/state` 语义是迁移专用，不要复用。
- 建议新字段：
  ```js
  lastVersion: "",                     // 上次成功启动的插件版本（基线）
  upgradeCheck: { from: "", to: "", at: 0, promptedAt: 0, attempts: 0 }
  ```
  加进 `defaultOnboardState`（`#963-972`）和 `mergeOnboardState` 白名单（`#975-993`，约 6 行）。

---

## 3. 表 3 · 边界场景（含线程/锁/时序）

| 场景 | 预期行为 | 依据/风险 |
|---|---|---|
| **① 全新用户（无 `.onboard.json`）** | 启动时只写基线 `lastVersion=当前`，**不提醒**；首个会话照常初始化引导 | 文件不存在可区分新装；`#1019-1023`；新装用户本来就不该收到「升级」提醒 |
| **② 老用户首次升级（有文件、无 `lastVersion`）** | 视为一次升级：`upgradeCheck={from:"旧版本",to:当前,...}`；首个顶层会话注入一次；之后写 `lastVersion` | 老用户文件只可能由**旧版本**创建；当前版本才含本功能 ⇒ 不提醒会漏掉目标人群。唯一误报面：同版本手工重部署/恢复旧文件（可接受的一次性提醒）；建议发布时 bump 版本，让 from/to 有意义 |
| **③ 同版本重启** | `lastVersion===当前` ⇒ 不提醒；若上次 pending 尚未注入，**保留 pending** 等首个会话 | 检测在 apply 启动期同步跑（建议放 `#21158` 附近）；pending 落盘，重启不丢 |
| **④ 回滚到旧版** | 旧版代码没有本检测 ⇒ 不提醒；若功能版代码遇到 `compareVersions(当前, lastVersion)<0`（降级）⇒ 静默更新基线、清 pending，不提醒；再次升级到不同版本时提醒一次；同版本重装不再提醒（已检查过） | `compareVersions`（`#860-871`）按数字段比较；注意它把 `4.5.3-rc.1` 解析成 `[4,5,3,0,1]`，rc 与 stable 方向会失真（插件发 stable 版本时无影响；若发 rc 需 semver-aware） |
| **⑤ 多会话并发启动** | 同一进程内：`maybeInjectUpgradeCheckNotice` 同步读/注入/写，JS 单线程 ⇒ 第一个会话写 `promptedAt`，第二个读到后跳过，**不重复**；跨进程（desktop+web 两个 Host）同时首会话：可能都读到 pending ⇒ **可能各注入一次**（重复，低频） | `#16554` 的 agent/created 是异步串行事件，但回调内部同步；无文件锁（`writeFileAtomic#557-572` 只原子替换，不做 read-modify-write 互斥）。可加 `.onboard.lock` 或接受；现有 migrate/update 也是同款无锁语义 |
| **⑥ 插件加载失败** | 检测未执行/状态未写 ⇒ 不提醒；下次成功加载再检测；期间用户看不到 `/memory-check`/工具 | 检测放 apply 启动期并 try/catch；加载失败本身要靠安装器 `-CheckOnly`/日志，不是本功能能救的 |
| 额外：`.onboard.json` 损坏 | 按「无有效基线」处理：**不提醒**、重写默认+基线，避免每次启动都误报 | `readOnboardState` 解析失败回默认（`#1019-1023`）；检测侧 raw parse 失败也要走静默基线 |
| 额外：`agent.inject` 不可用/抛错 | 不写 `promptedAt`，下个会话重试；`attempts` 累计，≥3 次清 pending（防无限重试） | 参考 `maybeInjectMigrateNotice` 先 inject 后写状态（`#1346-1348`）；外层 try/catch |
| 额外：首个顶层会话是 teammate/子代理 | 子代理被 `isTopLevelSession` 排除（`#12901-12907`）；teammate 是独立会话（header origin 非 subagent ⇒ 视为顶层），**可能先消费掉提醒**，用户主会话看不到 | 推断（未逐行核 DSH teammate 的 header origin 取值）；可 gate「仅 source=startup/resume 且非 teammate」或接受；这是「全局一次」设计的残余风险 |

**启动时序**：`apply` 同步体（`#12357`）→ 建议在启动体检/更新检查附近（`#21158`）调 `maybeDetectUpgradeAtBoot()`（同步、try/catch、只读写小 JSON，约 1-2ms）；首个会话 `agent/created`（`#16554`）→ `maybeInjectUpgradeCheckNotice(agent,label)` 在 `#16941` 之后。**检测不 await、不阻塞启动**；注入在会话创建阶段一次性发生。

---

## 4. 八项逐条回答

1. **调用链**：见 §1。现有通道有 `agent/created`（会话开始，推荐）、`agent/pre-step`（每轮临时注入）、`session/event`（压缩后）、`loader/volatile-update`（配置热更）；`system-reminder` 只是文案包装。升级提醒应挂 `agent/created` 的顶层会话分支（`#16935-16942`），与 `maybeInjectMigrateNotice` 并列（`#1328-1355` 是现成的一次性注入模板）。与 note 15% 提醒（pre-step 临时消息，`#1883/#17119-17120`）和重灌（压缩后 `#17812-17837`）**不打架**；同一会话可能叠加 init/migrate/upgrade 多条一次性提醒，文案短即可。
2. **状态交互**：`.onboard.json` 有 12 个读点/12 个写点（§2），全对象覆盖；新字段必须进 `mergeOnboardState` 白名单（`#975-993`），否则读回丢字段。`update.notifiedAt` 是「远端有新版本」的每日节流（`#984/#1005/#1394/#1424`），**不能复用**；升级自检用 `upgradeCheck.promptedAt`。并发写无锁，跨进程可能丢更新（低风险，建议接受或加锁）。
3. **线程/锁**：检测在 apply 启动期同步执行（建议 `#21158` 附近），先落 pending 再等会话；首个会话 `agent/created` 同步读/注入/写，同进程多会话不会重复；跨进程（desktop+web）有重复注入窗口（§3⑤）。无现成 `withFileLock`（本仓未引入），`writeFileAtomic` 只保证原子替换（`#557-572`）。
4. **正确性（lastVersion 首次写入）**：
   - 无 `.onboard.json`（新装）→ 只写基线，不提醒（不误报）。
   - 有文件、无 `lastVersion`（老用户）→ 一次性提醒，`from="旧版本"`（不漏报）；理由：老文件只可能来自旧版，本功能只在新版存在。
   - 有 `lastVersion` 且 `compareVersions(当前,prev)>0` → 升级提醒；`<0` → 降级：静默更新基线、清 pending；`==0` → 同版本，保留未完成的 pending。
   - 检测与基线写入**一次原子写**（`lastVersion` + pending 同一次 `writeOnboardState`），避免中间崩溃丢 pending。
   - 降级不会反复触发：旧版无检测代码；功能版遇到降级只静默；再次升级到不同版本才提醒一次。`compareVersions` 对 rc 的解析有偏差（`#860-871`），发 stable 版本无影响，发 rc 需注意。
5. **边界**：见 §3 六种 + 损坏/注入失败/teammate 三个额外场景；结论是「全新不提醒、老用户一次性、同版本静默、回滚静默、并发低频重复、加载失败不提醒」。
6. **方案对比**（详见 §6）：纯 md（零成本但 Agent 不会自动查）、安装器 `-CheckOnly`（已有，静态检查，无 Agent）、`onboardSummary` 改文案（只显示在统计面板，Agent 看不到）、复用 `/memory-init`（语义是初始化引导，不是检查）、新工具（能让 Agent 查，但改工具 schema ⇒ 前缀失效一次）、**注入 + 隐藏 `memory_onboard` action + 命令 + md（推荐）**。
7. **护栏**：一次性（`promptedAt`）；文案 ≤80 字且无时间戳/路径（冻结）；`agent.inject` 放 `agent/created` 尾部、不阻塞；全程 try/catch 静默；不写记忆库；自检不调用 `topicDbEnsure`（会消费 pending 迁移/打开库，`#7711-7720`），只用已就绪的 `TOPICDB.store`；`memory_search` 只读但会记一条 cost 事件（`#18886-18890`），可接受；输出截断；`attempts` 上限 3 防循环。
8. **影响面**：
   - **前缀缓存**：注入走 `agent.inject` 历史尾部（`#16619-16620`），一次性约 75 字（≈80-100 tokens），只影响首个顶层会话的尾部；旧前缀继续命中；后续请求把该条当历史缓存；**不改** AGENTS.md/稳定层/工具 schema（隐藏 action 不改 `memory_onboard` 描述/schema，`#19004`），命令和 md 不进模型上下文。若改成 pre-step 临时注入则连历史都不进，但可靠性下降；不推荐为省这点 token 牺牲「Agent 真能看到」。
   - **启动耗时**：检测只读写小 JSON（~1-2ms）；自检只在用户/Agent 触发时跑，不自动跑；`stats.json` 全量 1.2s/462KB 只在可选 `full` 时跑。
   - **多会话**：全局一次；其他会话零注入、零前缀影响。
   - **命令表**：新增 `/memory-check` 用 `{count:false}`（`compatCommand` 的既有约定，`#5585-5589`；`/memory-migrate` 同款 `#20956-20971`），不把 `COMPAT_COMMAND_NAMES` 从 7 改大（`#5556-5557`），不破 topicdb compat C03。
   - **工具表**：不新增工具、不改 schema/description（隐藏 action），`COMPAT.counts.tools` 不变。
   - **安装器**：本功能随 index.js 发布，需 bump 版本并重生成 payload/manifest（`node tools/sync-payload.mjs`）；`-CheckOnly` 已是现成静态检查（`install.ps1#9-11/#52-54/#1916-1994`），md 里让用户升级后跑一次。

---

## 5. `/memory-check` 自检项评审（逐项可行性）

| # | 设计项 | 评审结论 |
|---|---|---|
| 1 | 主题库可用：store/topics/库大小/backend | **可行**。读 `TOPICDB.enabled/ready/store/err`（`#7645-7656`）；主题数用 `store.be.listTopics()`（sqlite `backend-sqlite.mjs#108-110`；本机 585 主题实测 ~2.8ms），**不要**用 `store.topics()`（会做 live 句数/合并视图，实测 ~1.2s）；库大小 `fs.statSync(TOPICDB.dbFile)`；backend `store.be.kind`。flag 关 ⇒ WARN（md 模式），不算 FAIL |
| 2 | `memory_search` 可检索 | **可行但有两个副作用**：`MEMORY_SEARCH_EXEC`（`#18080/#18849`）存在才可用；flag 开时包装会调 `topicDbEnsure()`（`#18857`），若库未就绪会触发加载/消费 pending 迁移（`#7716-7720`）⇒ 自检只在 `TOPICDB.ready && store` 时跑，否则 SKIP/WARN；另外包装会 `p3CostBump("memorySearch",...)`（`#18886-18890`）写一条监控事件（不是记忆库垃圾，可接受；若要求绝对零写，可只检查工具注册+索引文件，不真跑）。查询用 `"global"` 走精确文件名分支（`#18774-18776`），非空 PASS，0 结果 WARN 不 FAIL |
| 3 | `memory_read` 可读 | **可行**。用 `be.listTopics()` 找第一个非 archived 主题，`store.readTopic(id)`（`memory-store.mjs#1278-1295`，推断只读）句数>0 PASS；无主题 WARN；不调用写路径 |
| 4 | 面板路由 `/dsh-memory/stats.json` 200 且含 topicdb | **建议改轻量**：`stats.json` 本机实测 **200/462KB/1199ms**（全量 snapshot，`#12451-12507`），为自检默认跑太重；用 `COMPAT.flux.webServer`（`#5545/#12705`）+ `PANEL_PORT/PANEL_WSRV`（`#12456-12463`）+ `GET /dsh-memory/note-stat.json`（本机 200/67B/121ms）做路由探活；`stats.json` 的 `topicdb` 检查放到可选 `full`（或只在用户显式要求时跑）。若坚持默认查 stats，需 5s 超时并接受 1.2s 延迟 |
| 5 | 新端点 `/dsh-memory/note-stat.json` 200 且结构正确 | **已实现，可直接查**（`#12508-12529`）；响应 `{ok,disabled,ready,topics,sentences}`；`disabled:true` 表示 flag 关/库未就绪（WARN）；404 说明升级未完成/未重启（FAIL）；200 且 `ok:true` 且数字有限 PASS |
| 6 | 版本/模板一致性：`PLUGIN_VERSION`、`AGENTS.template.md` 归一化 sha 是否在安装器白名单 | **需要拆分**：运行期插件**看不到** `install-manifest.json`（本机 `~/.dsh/profiles/web/plugins/memory/` 无该文件；安装器清单只用于安装器校验，`install.ps1#1965-1990`）⇒「sha 白名单」只能在安装器 `-CheckOnly` 做。运行期改查：`PLUGIN_VERSION`（`#635`）== `version.txt` == `package.json` 的 version；`AGENTS.template.md` 存在且含 `dsh-memory-agents-template: v4`（模板 #8）；`MEMORY_ROOT/AGENTS.md` 存在则查同 marker（本机缺，WARN 不 FAIL）。**本机现状**：`~/.dsh/profiles/web/plugins/memory/version.txt`/`package.json` 仍是 **4.0.1**，index.js 是 4.5.3；模板 6038B vs 仓库 9018B ⇒ 自检项 6 会 FAIL，修复=重跑安装器（`-CheckOnly` 会列 sha 不一致） |
| 7 | `memory_note` 可写：不真写，检查工具注册+上次写入 | **可行**。在 `memory_note` 注册处（`#18538-18623`）加 `NOTE_TOOL_READY = !!compatTool(...)` 标志；上次写入用 `be.listTopics()` 过滤 `^笔记·`（命名约定 `#18535/#18594`）取最大 `updatedAt`（row2topic `backend-sqlite.mjs#188-194`）；无 note 记录 WARN（正常），不写任何东西。flag 关/工具未注册 ⇒ FAIL/WARN |

**输出格式**：逐项 `PASS/WARN/FAIL` + 原因 + 修复建议，最后一行 `总结：X PASS / Y WARN / Z FAIL`；全 PASS 提示「无需处理」，有 FAIL 给可执行修复（重跑安装器/重启 DSH/检查 flag/换查询词等）。文本截断（如 4000 字），不把整库/敏感内容回显。

---

## 6. 推荐方案、最小 diff 与备选对比

### 6.1 推荐方案（注入 + 隐藏 action + 命令 + md）

- **注入**：`agent/created` 顶层会话分支（`#16935-16942`），在 `maybeInjectMigrateNotice` 之后调用 `maybeInjectUpgradeCheckNotice(agent,label)`；一次性、尾部追加、约 75 字。
- **Agent 可达**：`memory_onboard` 工具（`#18995-19057`）的 `action` 是无 enum 的 string（`#19004`），在 `execute` 里加 `if (act==="selfcheck") return await runSelfCheck();`（`#19010-19012` 附近）；**不改 description/schema** ⇒ 不产生工具定义前缀失效。提醒文案明确告诉 Agent 用这个隐藏 action。
- **用户可达**：新增 `/memory-check` 命令（`compatCommand(...,{count:false})`，`#5585-5589`；位置可放 `/memory-update` 之后 `#20901`），调用同一 `runSelfCheck()`。
- **md**：新增 `docs/升级后自检清单.md`（人读+Agent 读）；说明升级后重启、收到提醒后让 Agent 调 `memory_onboard action=selfcheck`、用户可 `/memory-check`、可选 `install.ps1 -CheckOnly`、各 FAIL 的修复。
- **状态**：`.onboard.json` 加 `lastVersion` + `upgradeCheck`（含白名单）；启动检测；`promptedAt` 一次性；`attempts` 上限 3。
- **不改**：不新增工具、不改工具 schema/AGENTS.md/客户端；不自动跑自检；不写记忆库。

### 6.2 最小 diff（按文件/位置）

1. `index.js#963-972`：`defaultOnboardState` 加 `lastVersion:""`、`upgradeCheck:{from:"",to:"",at:0,promptedAt:0,attempts:0}`。
2. `index.js#975-993`：`mergeOnboardState` 加白名单（`lastVersion` string；`upgradeCheck` 各字段类型守卫）——**不加就会被读丢**。
3. `index.js` onboard 区（`#1328-1517` 附近）：新增 `maybeDetectUpgradeAtBoot()`、`maybeInjectUpgradeCheckNotice(agent,label)`（参考 `maybeInjectMigrateNotice#1328-1355` 的「读状态→inject→写状态」结构）。
4. `index.js#21158` 附近（apply 启动期）：`try { maybeDetectUpgradeAtBoot(); } catch(e){ cwarn(...) }`；同步、不 await。
5. `index.js#16941` 之后：`maybeInjectUpgradeCheckNotice(agent, SESSION_LABEL);`（仅顶层会话分支内）。
6. `index.js` `const toolSvc = ctx.get("tools")`（`#17959`）附近加 `let NOTE_TOOL_READY=false;`；在 `memory_note` 注册块（`#18538-18623`）设置该标志。
7. `index.js` apply 内（`#18894` 之后、`memory_onboard` 之前）新增 `async function runSelfCheck()`（约 100-150 行，按 §5 七项实现；只读；超时/截断/不调 `topicDbEnsure`）。
8. `index.js#19010-19012`：`memory_onboard` execute 加 `selfcheck` 分支（不改 schema/description）。
9. `index.js#20901` 之后：`/memory-check` 命令注册（`compatCommand(...,{count:false})`）。
10. `version.txt`、`package.json`、`index.js#635` 三处 bump 到发布版本（当前 4.5.3）；发布走 `node tools/sync-payload.mjs` 重生成 `install-manifest.json`/payload。
11. 新增 `docs/升级后自检清单.md`。

**重建/部署**：index.js 是运行时源码，**无需构建**；复制到 `~/.dsh/profiles/web/plugins/memory/index.js`（desktop/web 共用；`profiles/node_modules/dsh-memory` 是指向它的 junction），重启 DSH 生效；分发时再跑 `sync-payload.mjs` + 安装器。无客户端改动、无 DB 迁移。

### 6.3 备选对比

| 方案 | 能让 Agent 自动查？ | 前缀缓存影响 | 改动量 | 评价 |
|---|---|---|---|---|
| 纯 md | ❌ 用户不问就不会查 | 0 | 最小 | 不满足「每次升级让 Agent 查」 |
| 安装器 `-CheckOnly` | ❌ 只静态检查，无 Agent | 0 | 已有功能 | 作为补充（sha/DB/版本/迁移），不能替代运行时自检 |
| `onboardSummary` 改文案 | ❌ 只在统计面板，Agent 看不到 | 0 | 很小 | 可作为人类可见的补充 |
| 复用 `/memory-init` | ❌ 语义是初始化引导 | 0 | 小 | 不推荐，容易误导 |
| 新工具 `memory_selfcheck` | ✅ | 工具 schema 变更 ⇒ 全量前缀失效一次 | 中 | 可行但不如隐藏 action 省 |
| **注入 + 隐藏 action + 命令 + md（推荐）** | ✅ | 一次性尾部 ~75 字；无 schema/稳定层变更 | 中 | 推荐 |
| pre-step 临时注入 | ✅（当轮可见，可能漏） | 0 历史、仅当轮尾部 | 中 | 可选替代；可靠性低于 `agent.inject` |

### 6.4 注入文案为什么不会破坏前缀缓存

- `agent.inject` 的既有纪律：**只在历史尾部一次性追加，绝不插入/改写已有前缀；通知文本落历史即冻结**（`#16619-16620`；迁移提醒/初始化引导同款 `#1346/#1451`）。
- 本提醒只在升级后**首个顶层会话**注入一次（全局 `promptedAt`），其他会话零注入；文本不含时间戳/路径/动态数据（只有版本号），冻结后后续请求作为历史缓存命中。
- **不改** AGENTS.md/稳定层（改一次会让所有会话前缀失效，且指令永久存在）；**不改** `memory_onboard` 的 schema/description（`action` 无 enum，`#19004`）；命令/md 不进模型上下文。
- 成本：约 75 字 ≈ 80-100 tokens，仅首个会话一次；相对「命中 0.1 元 vs 未命中 1 元/百万 token」可忽略。若改 pre-step 临时注入，历史零增长，但 Agent 可能漏看，不建议为省这点牺牲可靠性。

---

## 7. 诚实缺口

1. 未实际改代码/注入测试；注入时序、`.onboard.json` 并发、`agent.inject` 在 agent/created 的实测表现均基于现有代码与同类函数（`maybeInjectMigrateNotice`）推断，未跑真机升级。
2. 未逐行核 DSH `agent/created` 对 teammate 会话的 `header.origin` 取值（§3 的 teammate 风险是推断）；未验证跨 desktop+web 双 Host 并发注入的实际概率。
3. 未运行 `install.ps1 -CheckOnly`（只读但会下载小 manifest）；本机安装副本的版本/模板不一致来自文件大小与内容对比，属当前环境事实，不代表所有用户。
4. `memory_search` 自检会写一条 cost 监控事件（`#18886-18890`）；`store.readTopic` 只读性按代码推断（`memory-store.mjs#1278-1295`），未逐路径验证是否更新 lastHit 统计。
5. `stats.json` 全量检查耗时为本机实测（1.2s/462KB），不同库/机器会变；建议默认走 `note-stat` 轻量探活。
6. `compareVersions` 对 `-rc` 版本的方向问题（`#860-871`）未修；插件当前发 stable 版本，若将来发 rc 需另行处理。
7. 自检项 6 的「安装器 sha 白名单」在运行期不可行，方案改为「版本三处 + 模板 marker」+ 安装器 `-CheckOnly`；如果产品要求运行期也校验 sha，需要把 manifest 随插件安装（改变安装器 payload），不是本设计的最小改动。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写 `.onboard.json`/数据库。*
