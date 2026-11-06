# CRA 审计：dormant 曝光提醒（含 stateSince / 续期 / 批量归档根因复核）

- **审计对象（方案，未实现）**：`EXPOSURE_STATES` 增加 `'dormant'` + dormant 提醒文案区分状态 + 标注剩余归档天数
- **仓库**：`E:\工具\插件开发调整\dsh-memory-plugin`（git HEAD `a5a59f7`，`version.txt` = 4.5.0）
- **审计文件与 sha256（前 16 位）**：
  - `index.js` = `724FA1B226CBC6AA`（20485 行；与已部署副本 `~/.dsh/profiles/web/plugins/memory/index.js` 在本审计涉及的 5 个区段**逐字节一致**）
  - `memtopic/src/lifecycle.mjs` = `0D9FCA98FDAFA748`（182 行；部署副本同 hash）
  - `memtopic/src/memory-store.mjs` = `FEF98406092C63FD`（2389 行；部署副本同 hash）
  - `memtopic/src/upgrade.mjs` = `D01521F15BE5D014`；`memtopic/src/backend-sqlite.mjs` = `99887F992BC9D9B6`；`memtopic/src/curation.mjs` = `C9CC17F97C251166`
- **审计方式**：只读。未改代码、未构建、未部署、未写库（SQLite 全部以 `readOnly: true` 打开）。用 8 个临时只读探针（位于 `%TEMP%`，不落仓库）在**真实库快照**（`~/.dsh/memory/.memtopic/mem.db`，573 主题 / 37,008 条审计）上复算纯函数；另扫描 570 个真实会话日志（zstd）取注入形态证据。
- **生效配置（实测）**：`~/.dsh/memory/.config.json` = `{ memoryTopicDbEnabled: true, integrateEnabled: true, … }` ⇒ 主题库模式**已生效**；后端 = sqlite（`detect.pickBackendKind`，`memory-store.mjs` 加载日志同口径）。
- **审计时间**：2026-11-05 19:48–20:10（Asia/Shanghai）

---

## 结论先行

### 判定：**FAIL（不批准按原方案实施）**

一句话：**方案的前提（「主题长期未被检索 → 降级 dormant → 沉默期 → 被静默归档」）与真实数据不符**——308 个 dormant **全部**是 `parent=active` 的**明细子主题（决策 21 的设计态）**，全库**没有任何「长期未用 → 降级 dormant」的代码路径**；真正会导致「静默批量归档」的不是 dormant 不在提醒名单，而是 **① 检索命中续期链路从未接线（`markHit` 全仓 0 调用方，573/573 主题 `last_hit_at` 为 NULL）** 和 **② 导入期 `stateSince` 让 354 个主题集中在 2027-01-27 ~ 02-02 到期（其中 352 个在 01-27/28 两天内）**。原方案对这两条**零改善**，却会把「3 条可见槽位」永久占满（286 条只显示 3 条、283 条永不出现），并挤掉现有 draft 曝光（3 条 → 1 条）。

### 是否批准

| 方案 | 判定 | 说明 |
|---|---|---|
| **原方案（dormant 进 EXPOSURE_STATES + 文案区分 + 剩余天数）** | ❌ **不批准** | G-0 未通过（观测支撑的是另一条根因）；G-9.2 列出 **6 条**可复现失效路径；对批量归档无防护作用 |
| **替代方案 B（先修续期 + 归档护栏，曝光层不动或只做「即将到期」子集）** | ✅ **有条件批准**（PASS-with-findings） | 见 §5；P0（续期 / 归档护栏 / 只读分离）必须在 2026-11-28（30 天 escalate 日）/ 2027-01-27（90 天批量归档日）之前落地 |

### 对 Lead 追加根因的复核（详见 §4）

| Lead 的论断 | 复核结果 | 证据 |
|---|---|---|
| `topics` 表无 `state_since` 列、`row2topic` 不返回 `stateSince` | ✅ **成立** | `backend-sqlite.mjs#17-28`、`#188-197`；`PRAGMA table_info` 实测 10 列 |
| 「`stateSinceOf` **永远**回落到 `createdAt`」 | ❌ **不成立**（关键更正） | 真源是 **meta `state.since:<id>`**：`memory-store.mjs#216-221` 读、`#254`/`#1459` 写；`#1688`/`#1704` 在调 lifecycle 前把 `stateSince` 注入快照。实测 **573/573** 主题都有该 meta，0 缺失 |
| 「生命周期认为 308 dormant 都 7 天前进入 dormant」 | ✅ **成立（但机制不是 createdAt 回落）** | 308 个 `state.since` 全在 `2026-10-29T08:00Z ~ 2026-10-30T02:00Z`（= 导入/落树时刻），与 `created_at` **308/308 不相等**；`daysInState` 实测 6~7 |
| 「11/28 全部 escalate、2027-01-27 全部自动归档」 | ✅ **成立且已量化** | 纯函数复算：`planArchivable(now+83d)=286`（242 dormant+44 draft）、`+84d=352`、`+90d=354`；按日：**2027-01-27 = 338 条**、01-28 = 14、02-01 = 1、02-02 = 1 |
| 「`isRenewed` 只看 `lastHitAt` ⇒ 从不续期」 | ✅ **成立且更严重** | `markHit()` 定义于 `memory-store.mjs#1596`，**全仓（排除备份/临时）0 个调用方**；`last_hit_at` 573/573 NULL；`hits:` meta 573 个键、**非零 0 个** |
| （新增发现）「写多读少」的高价值主题会被归档 | ✅ **成立** | `appendSentence` 只 bump `writeCount/updatedAt`（`memory-store.mjs#1336`），`_autoPromoteIfDue` 只对 `draft` 生效（`#1537-1540`）⇒ **写入不续期**；504/573 主题「有写入但从未命中」 |

> 结论：Lead 的**现象**（批量归档悬崖）成立，但**归因**（字段不存在→回落 createdAt）不成立。真实根因是 **meta 里的 `state.since` 本身取的是「导入/落树时刻」+ 续期链路是死代码**。因此 §4 的 Q1（如何补字段）应改写为「如何收紧 API + 修续期」，而不是「加列/回填」。

---

## 表 1 调用链与语义（含可疑点）

### 1.1 常量与函数的全部消费方

| # | 符号 | 定义 | 全部消费方（文件:行） | 语义 / 结论 |
|---|---|---|---|---|
| 1.1 | `EXPOSURE_STATES` | `lifecycle.mjs#21` | **仅** `exposureLevel()` `lifecycle.mjs#77` | 改它只影响 `exposureLevel → planExposure → pendingReminder` 这一条链；**不**影响归档（归档走 `ARCHIVABLE_STATES`） |
| 1.2 | `ARCHIVABLE_STATES` | `lifecycle.mjs#22` | **仅** `planArchivable()` `lifecycle.mjs#146` | 决定 90 天自动归档；本次方案**不改**它 ⇒ 批量归档行为完全不变 |
| 1.3 | `buildReminder()` | `lifecycle.mjs#98-114` | **仅** `planExposure()` `lifecycle.mjs#138` | 排序 `days desc, id asc`（`#101`）；最多列 `reminderMaxList=3`（`#41`、`#105`）；`hidden=count-3`（`#106-108`）；**items 只含 `{id,name,days,level}`，没有 `state`/`remainingDays`** |
| 1.4 | `planExposure()` | `lifecycle.mjs#122-139` | **仅** `MemoryStore._reminderPlan()` `memory-store.mjs#1703-1706` | 返回 `{pending, archivable, reminder}`；调用方只取 `.reminder`，`archivable` 是死输出 |
| 1.5 | `planArchivable()` | `lifecycle.mjs#142-152` | **仅** `MemoryStore._archiveDue()` `memory-store.mjs#1689` | 真正会写库的入口（见 1.8） |
| 1.6 | `pickOverflowVictim()` / `needsReviewCap` | `lifecycle.mjs#158-169`；`memory-store.mjs#1634-1648` | `_enterNeedsReviewInternal` | 与曝光名单**无交集**：只看 `needs_review` 队列长度、`stateSince`、`hitCount`；改 `EXPOSURE_STATES` 不影响封顶/降级 |
| 1.7 | `curation.mjs` 的 `includeStates` | `curation.mjs#49` | `curation.mjs#96-98`、`#313` | 独立常量，**已包含 `dormant`**；与曝光名单无关，不受影响 |
| 1.8 | `pendingReminder()` / `lifecycleTick()` | `memory-store.mjs#1709-1717` | ① `index.js#11418`（注入）；② `upgrade.mjs#218`（`dbStats`）；③ `_verify` 脚本 | ⚠️ **名为读、实为写**：`lifecycleTick()` 先 `_archiveDue()` 归档再产出提醒（`#1711-1712`）。**但 CLI 路径当前环境安全**：sqlite 下 `probeStore` 先把库复制到临时目录再打开（`upgrade.mjs#156-167`）⇒ 源库零写入；**ledger 降级后端例外**：`probeStore` 直接打开真实文件（`#152-154`），而 `LedgerBackend._emit` 非事务路径**立即 append 落盘**（`backend-ledger.mjs#89-94`）⇒ ledger 环境下 `--detect/--plan` 会真写库 |
| 1.9 | `scanLifecycle()` | `memory-store.mjs#1719` | 全仓无调用方（grep） | 死代码 |

### 1.2 提醒的构建 → 注入全链（谁调用、注入到哪）

```
lifecycle.buildReminder()                      lifecycle.mjs#98
  └─ planExposure().reminder                   lifecycle.mjs#138
      └─ MemoryStore._reminderPlan()           memory-store.mjs#1703-1706
          └─ MemoryStore.pendingReminder()     memory-store.mjs#1717
              └─ index.js topicDbInjectionParts()   index.js#11418
                  └─ index.js injectMaintenanceReminder()  index.js#15823-15827
                      └─ agent/created 回调（会话创建）    index.js#16234-16236
```

| # | 事实 | 证据 | 结论 / 可疑点 |
|---|---|---|---|
| 1.10 | 注入点**只有** `agent/created`（会话创建）；`agent/pre-step`、压缩后路径**都不调** `injectMaintenanceReminder` | 全仓 grep：`injectMaintenanceReminder` 仅定义 `#15707`、赋值 `#15837`、唯一调用 `#16236` | 设计文档写的「每会话一行」在**会话内/压缩后**没有第二条通道 |
| 1.11 | 维护提醒受 **`maintenanceInjected` 进程级闸**：同一插件实例只对**第一个顶层会话**注入一次 | `index.js#12259`（`let maintenanceInjected = false`）、`#16234-16236`、注释 `#255` | ⚠️ **实际频率 = 每宿主进程 1 次，不是每会话 1 次**。这与任务书「每会话最多 1 行」的前提不符，直接决定「308 dormant 需要 103 个会话过一遍」不成立 |
| 1.12 | 段内去重 `topicNotifiedOnce(agent,kind,line)`：key = `sessionId|kind`，内容相同才去重 | `index.js#7138-7158` | 因 1.11，会话级去重实际很少被用到 |
| 1.13 | 硬约束 `TOPICDB_REMINDER_MAX_LINES=1` 只做**投递前闸**，不约束行内容 | `index.js#7134`、`#11420` | 改文案长度不会被此常量拦截 |
| 1.14 | 同一 `<system-reminder>` 里并列：备份/轮转/超限整理/过期复核/**待归类主题**/主题注册表/升级待办 | `index.js#15712-15831` | 待归类行不是独占消息；实测真实样本见 §8 G-3 |
| 1.15 | 真实注入形态（唯一一次可核实的生产样本，2026-11-02，会话 `session-e6827f9b`，长沙工作区） | 会话日志原文 | `【dsh-memory · 待归类主题】47 条待归类主题，最早 7 天：T-0003「…」；T-0006「…」；T-0007「…」 等 44 条`（与「超限整理提醒」「主题注册表」同处一个 `system-reminder`） |
| 1.16 | 面板/统计有**第二份口径实现**（硬编码 `draft|needs_review`） | `index.js#8707-8721`（`#8715` 硬编码过滤、`#8718` 用 `daysInState`） | 改 `EXPOSURE_STATES` 后：提醒显示 286 条、面板「待归类」仍按旧口径（且 `pendingNote` 用的是 `needs_review` 计数，实测 2 条）⇒ **三处数字互不一致** |
| 1.17 | `memory_search` 主题块排除 archived，且**不记录命中** | `index.js#7290-7321`（`#7296` 排除 archived；全函数无 `markHit`） | 「被检索命中 ⇒ 续期」的写侧从未实现 |
| 1.18 | 主题注册表切片**已包含 dormant** | `index.js#7349-7350`（`active|draft|needs_review|dormant`） | 「dormant 完全不曝光」的前提不成立：dormant 已通过注册表切片（按 `updatedAt` 取前 12）进过注入 |

**调用链结论**：`EXPOSURE_STATES` 只有一个消费方，改动面很窄——但**提醒的注入频率被进程级闸压成「每进程 1 次」**，且存在三份「待归类」口径（lifecycle / 面板 / 注册表），原方案会让三份口径进一步分叉。`pendingReminder()` 的**写副作用**还被 `upgrade.mjs` 的只读命令复用（sqlite 走临时副本 ⇒ 源库零写入；ledger 降级环境会写真实账本，见 1.8、表 3-⑧）。

---

## 表 2 状态交互（含抖动分析）

| # | 交互 | 证据 | 风险 | 分析 / 护栏 |
|---|---|---|---|---|
| 2.1 | dormant 进曝光 × `_autoPromoteIfDue`（draft 自动转正） | `memory-store.mjs#1537-1540`（`if (t.state !== 'draft') return null`） | **无直接冲突** | 曝光只读计算，不触发转正；但提醒文案在 30 天后会写「建议归档 / 或转正」——对 308 个**明细子主题**，「转正」是错误建议（会把明细塞进注入正文，违反决策 21） |
| 2.2 | dormant 进曝光 × `needsReviewQueue` 溢出降级 | `memory-store.mjs#1634-1648`（第 21 条把最旧最低频转 dormant，`_transition` 重置 `state.since`） | **低（行为变化）** | 溢出降级后 7 天内不会进提醒（`daysInState` 归零），7 天后会进——比现在「永久沉默」更符合曝光阶梯；实测该路径**从未发生**（`audit op=topic.needs_review.overflow` 计数 = **0**） |
| 2.3 | dormant 进曝光 × `renewDays` 续期 | `lifecycle.mjs#62-67`、`#77-78` | **无效果** | `isRenewed` 对 dormant 本来就生效，但 `lastHitAt` 永远 NULL（`markHit` 0 调用方）⇒ 续期恒为 false。加 dormant 只是把「不续期的主题」从 44 个扩到 286 个 |
| 2.4 | **抖动：刚提醒要归档 → 下一秒被 dream 写入** | `appendSentence` `memory-store.mjs#1321-1346`；`_autoPromoteIfDue` 只认 draft | **真实存在（当前即存在）** | dream/lead 写入 dormant **不改变状态、不续期**（只 bump `writeCount/updatedAt`）。实测 504/573 主题「有写入但从未命中」，5 个核心主题 write_count 59~275 却长期 dormant（今天 11:24 才被 lead 手工转 active）。⇒ 抖动方向是「**写入不会救它，归档照旧**」，不是「提醒后被写入打断」 |
| 2.5 | 归档与提醒的时序 | `memory-store.mjs#1709-1714`（先 `_archiveDue` 再 `_reminderPlan`） | **低（有兜底）** | 到期主题先归档、再算提醒 ⇒ 提醒里不会出现「剩余天数为负」；**但** `_archiveDue` 无事务/无限量（表 3-⑦），若中途抛错，下一行提醒可能出现已到期主题（需 `max(0, …)` 兜底） |
| 2.6 | 多会话并发（同进程） | `index.js#12259`、`#16234` | **低** | JS 单线程 + SQLite `DatabaseSync` 同步调用；`maintenanceInjected` 保证同进程只算一次；不同会话不会重复提醒，但也**不会各自提醒** |
| 2.7 | 多进程并发（宿主 + `upgrade.mjs` CLI + 测试） | `backend-sqlite.mjs#58-65`（`new DatabaseSync(file)`，SCHEMA 仅 `journal_mode=WAL`/`foreign_keys`，**未设 busy_timeout**） | **中** | 两个进程同时写（批量归档时）可能直接 `SQLITE_BUSY` 抛错；`_archiveDue` 无事务包裹 ⇒ 部分已归档、无回滚、无重试（下次 tick 继续，幂等可续） |
| 2.8 | A→B→A 过期对象 | `lifecycleTick()` 每次重新 `listTopics()` 建快照（`#1688`/`#1704`） | **低** | 无缓存对象；但同一 tick 内 `_archiveDue` 与 `_reminderPlan` 各读一次全库（两次快照），理论上中间可被其他进程改库 ⇒ 提醒与归档基于不同快照（可接受，但日志应带 count 便于对账） |
| 2.9 | 归档 × 写入（僵尸写） | `appendSentence` **无状态前置检查**（`#1321-1346` 全程不校验 `t.state`） | **中** | 主题被归档后，dream/lead 仍可 `memory_write` 写入成功（`resolveTopic` 不排除 archived，`#842-874`）⇒ 产生「已归档但还在长内容」的僵尸主题，永不再进注入/检索。批量归档 338 条后该风险放大 |
| 2.10 | 归档 × 树结构 | `_archiveDue` 直接 `_transition(..., 'archived')`（`#1692`），**绕过** `archiveTopic()` 的 `TOPIC_HAS_CHILDREN` 守卫（`#1490-1495`） | **中（潜在）** | 当前 308 个 dormant **无子节点**（实测 0），父节点全是 active；但未来若出现「dormant 父 + 子」，自动归档会产生「子挂已归档父」的孤儿结构 |

---

## 表 3 边界场景（**308 dormant 的实际处理策略**必须回答）

> 数据基线（2026-11-05 20:00 快照）：dormant 308 / active 195 / draft 44 / archived 24 / needs_review 2 = 573；`last_hit_at` 全 NULL；dormant 中 **308/308 有 `parent`**（36 个 active 主主题）、0 个有子节点、最大树深 3。

| # | 边界 | 实测/复算 | 会发生什么 | 兜底/结论 |
|---|---|---|---|---|
| ① | **308 个 dormant 同时进曝光** | 纯函数复算（真实快照 + `buildReminder`） | 提醒从「44 条 / 3 条可见 / 等 41 条」变成「**286 条 / 3 条可见 / 等 283 条**」（242 dormant 已满 7 天 + 44 draft；66 个 dormant 尚未满 7 天，会在未来几天陆续加入） | **这不是「给足曝光」**：283/286（98.9%）永远不会出现在行里 |
| ② | **会不会变成永久噪音** | 排序 `days desc → id asc`（`lifecycle.mjs#101`、`#136`）；308 个 dormant 的 `daysInState` **完全相同（7）** | 并列时按 ID 升序 ⇒ 永远显示 **T-0001、T-0002、T-0003**（实测：T-0001/T-0002 是 `MEMORY-107服务器-*` 种子主题，T-0003 是 draft） | **是**：同一行内容稳定复现（还会命中 `topicNotifiedOnce` 的同内容去重），**283 条永不轮换** |
| ③ | **按什么排序** | 现逻辑：`b.days - a.days \|\| (a.id < b.id ? -1 : 1)` | 「最旧优先」对 dormant 失效（全同天）；若按剩余归档天数升序（`archiveAfterDays - daysInState`），当前 286 条也全部并列（同为 83 天后到期） | 需要**显式二级键**（如 `remainingDays asc, id asc` + 轮转游标），否则排序无意义 |
| ④ | **超过 3 条怎么概括** | `buildReminder` 只输出「等 N 条」 | 输出「等 283 条」——**概括里没有分布、没有下一批、没有可执行入口** | 需改为可操作概括（如「等 283 条（明细子主题 283）；用 `memory_topics state=dormant` 批量处置」） |
| ⑤ | **用户/agent 从不响应，90 天照常归档——补曝光是否只是心理安慰** | `_archiveDue` 与曝光名单解耦；无「响应」机制（提醒里没有可执行指令；处置只能靠 agent 自己想到调工具） | **是，纯心理安慰**：提醒不改变归档条件；而且**注入频率是每进程 1 次**（表 1-1.11）⇒ 连「12 次曝光机会」都不存在（实测 14 天 570 个会话只找到 **1 次**真实注入） | 补曝光**不能**替代「修续期 + 归档护栏」 |
| ⑥ | **308 里 66 个未满 7 天** | `daysInState` 6~7 天；`state.since` 分布：242 个 @10-29T08Z、52 个 @10-29T16Z、14 个 @10-30T02Z | 未来 1~3 天提醒条数从 286 涨到 352（+66） | 提醒数字会在几天内继续膨胀；文案里的「最早 X 天」恒为 7，无信息量 |
| ⑦ | **2027-01-27/28 批量归档** | `planArchivable` 复算：`+83d = 286`、`+84d = 352`、`+90d = 354`；按日 01-27=338、01-28=14、02-01=1、02-02=1 | 单次 `lifecycleTick()` 里 `_archiveDue` **无单次上限**（对比 p25 sweep 有 `P25_LIFE_SWEEP_LIMIT=20`，`index.js#8332`/`#8385-8387`）、无事务、逐条 5 次写（state/meta/audit/pointer/audit） | **必须加**：单次上限 + 事务 + 先 plan 后执行 + 日志带值；否则 338 条一次性状态迁移，中途崩溃留半状态 |
| ⑧ | **只读命令触发写库（仅 ledger 降级环境）** | `upgrade.mjs#203-237` `dbStats()` → `#218 pendingReminder()` → `lifecycleTick()` → `_archiveDue()`；`analyze()`（detect/plan 共用）`#348-360` 调 `dbStats`；sqlite 走临时副本（`#156-167`，源库零写入），ledger 直接开真实文件（`#152-154`）且 `_emit` 立即落盘（`backend-ledger.mjs#89-94`） | sqlite 环境（本机实测）：`--detect/--plan` **不改源库**；ledger 环境：90 天到期后会**真归档真实账本** | 违反 `alignment.md#66`「`--detect`/`--plan`（均零写入）」契约**仅限 ledger 降级环境**；本机用 sqlite，故不触发，但降级用户会踩 |
| ⑨ | **注入预算** | 实测：现提醒行 178 字符；加 dormant 后 **186 字符**（+8） | 字节几乎不变（因为 `hidden` 概括），不挤占 global/index 预算（parts 独立追加，`index.js#15829-15832`） | **G-9 结论：产出物字节风险极低；真正的风险是信噪比（283/286 隐藏）与槽位挤占（见 G-3）** |
| ⑩ | **挤掉既有提醒** | 现 3 条可见 = T-0003/T-0006/T-0007（draft）；加 dormant 后 = T-0001/T-0002（dormant）+ T-0003（draft） | 3 个槽位被 2 个 dormant 占掉，**draft 可见数 3 → 1**；T-0006/T-0007 被挤出 | 既有 draft 曝光被削弱 2/3（G-3 必答项） |
| ⑪ | **30 天 escalate 文案** | `buildReminder#109-110`；复算 `+30d`：现口径 46 条、加 dormant 后 **354 条**（level=escalate，行 198 字符） | 会输出「354 条待归类主题，最早 30 天，建议归档 / 或转正：3 条…等 351 条」 | 对 308 个设计态明细发「建议归档/转正」是**错误动作诱导**（转正 = 把明细塞进注入正文） |
| ⑫ | **归档后树结构塌陷** | `topicCounts()` 明细口径 = 非 archived 且有父（`memory-store.mjs#764-790`）；308 dormant 全是明细 | 2027-01-27 后 **L3 明细 308 → 0**，`memory_topics` 层级视图不再有明细层 | 可观测的结构回归（虽内容可 `memory_read` 读回） |

### 308 dormant 的处理策略（直接回答）

1. **不要**把 308 个整体加进曝光提醒（无信息量、永久固定 3 条、挤掉 draft）。
2. 若一定要让 dormant 有曝光，**只覆盖「非明细子主题（`parentId == null`）且剩余归档 ≤7 天」**——实测该集合**今天 = 0、未来 83 天内 = 0**（因为 308/308 都是明细），所以这个子集**当前根本不需要提醒**；它只对未来的「扁平 dormant」有意义。
3. **真正该做的**是把 308 个明细子主题**排除在 90 天归档阶梯之外**（或至少用 `updatedAt` 续期），否则 2027-01-27 会一次性塌掉整个 L3 明细层。明细的退役应由 `p25LifecycleSweep` 式的「按线内排名/更新时间」策略管，而不是 90 天一刀切。
4. 若要给用户「处置入口」，用**工具/面板**（`memory_topics state=dormant` 已有；面板已有待审队列前 5），不要靠每进程一行的提醒。

---

## 4. 根因复核（Lead 追加）：stateSince / isRenewed / 批量归档

### 4.1 事实核查（全部在真实库上复算）

| 核查项 | 实测 | 证据 |
|---|---|---|
| `topics` 表列 | `id,name,norm,aliases,triggers,state,created_at,updated_at,last_hit_at,write_count`（10 列，无 `state_since`） | `backend-sqlite.mjs#17-28`；`PRAGMA table_info` 实测 |
| `row2topic()` 返回字段 | 无 `stateSince` | `backend-sqlite.mjs#188-197` |
| meta `state.since:*` | **573/573 存在，0 缺失** | `SELECT COUNT(*) FROM meta WHERE key LIKE 'state.since:%'` = 573 |
| dormant 的 `state.since` | 242 @ `2026-10-29T08Z`、52 @ `10-29T16Z`、14 @ `10-30T02Z`；与 `created_at` **308/308 不等**；`daysInState` 6~7 | 只读 SQL |
| `state.since` vs audit 最近 `topic.state.at` | **462 一致 / 0 冲突 / 111 无迁移记录（初始态）** | 只读 SQL |
| `last_hit_at` | **573/573 NULL**；`hits:` meta 非零 **0 个** | 只读 SQL |
| `markHit` 调用方 | **0**（全仓 grep，排除 `node_modules/.bak/.frozen/_tmp-prev`） | `memory-store.mjs#1596` 仅定义 |
| dormant 结构 | 308/308 有 `parent`（36 个 active 主主题）；0 个有子节点；树深 3 | 只读 SQL |
| `needs_review.overflow` 审计 | **0 次**（从未发生封顶降级） | `audit` 表 |
| 未来归档时间线 | `+83d=286`、`+84d=352`、`+90d=354`；按日 2027-01-27=338、01-28=14、02-01=1、02-02=1 | 纯函数 `planArchivable` 复算 |
| 5 个核心主题 | 今天 11:24 被 lead 手工 `dormant/draft → active`（`topic.state` 审计 + `topic.seed.exemption.cleared`）；`write_count` 59/81/86/90/275，`last_hit_at` NULL，均有 parent | `audit` 表；`_verify/_q-activate-topics.mjs` |

### 4.2 Q1：`state_since` 该怎么补？——**不需要补；真源已经是 meta**

| 方案 | 迁移成本 | 一致性 | 回滚风险 | 结论 |
|---|---|---|---|---|
| **A. 加 DB 列 `state_since`** | 高：改 `topics` schema（`backend-sqlite.mjs#17-28`）+ `row2topic` + `updateTopic/insertTopic` + `backend-ledger` 序列化 + 迁移脚本 + 双后端测试 | 中（与 meta 双写，需保证同步） | 中（`ALTER TABLE` + 旧库回填；ledger 后端是 JSONL 格式，回滚需兼容旧行） | ❌ 不推荐：为一个**已经工作**的字段付 schema 迁移代价 |
| **B. 继续用 meta `state.since:<id>`（现状）** | **零** | **高**：573/573 存在、462/462 与审计一致、0 冲突 | 零（无 schema 变更） | ✅ **推荐**：保持现状；只做「API 收紧 + 测试」 |
| **C. 运行时从 `audit` 推导最近 `topic.state.at`** | 零 schema，但每次计算要扫审计表（37,008 行且持续增长） | 高（462 条可推导）但 **111 条无迁移记录**必须回落 createdAt | 低 | ❌ 不建议做运行时真源；**适合做一次性核对/回填验证**（本次已用它证明 B 一致） |

**推荐**：**保持 meta（B）**，并做三件小事（防未来踩坑）：
1. `lifecycle.stateSinceOf()` 的 `createdAt` 回落**保留但显式标注**（`lifecycle.mjs#56-59`），并在 `lifecycle.mjs` 头注释写明「调用方必须先注入 `stateSince`」；
2. `MemoryStore` 增加唯一入口 `pendingExposureSnapshot()`（内部完成 `_stateSince` 注入），**禁止**外部把 `be.listTopics()` 裸行直接喂 `planExposure/planArchivable`；
3. 补单元测试：`stateSince` 缺失时回落 `createdAt` 的行为被固定（当前全仓**无任何** `buildReminder/planExposure/planArchivable` 断言，见 §9-F12）。

### 4.3 Q2：存量 308 个 dormant 的 `stateSince` 怎么回填？——**无需回填；要决策的是「导入期基准」**

**可执行判据（只读，先跑）**：
```sql
-- ① 缺失检查：必须 = 0
SELECT COUNT(*) FROM topics t
LEFT JOIN meta m ON m.key = 'state.since:' || t.id
WHERE m.key IS NULL;

-- ② 与审计一致性检查：mismatch 必须 = 0（当前实测 0）
SELECT t.id, m.value AS since_meta, MAX(a.at) AS since_audit
FROM topics t
JOIN meta m ON m.key = 'state.since:' || t.id
LEFT JOIN audit a ON a.topic_id = t.id AND a.op = 'topic.state'
GROUP BY t.id HAVING since_audit IS NOT NULL AND CAST(m.value AS INTEGER) <> since_audit;

-- ③ 未来 90 天到期清单（回填前先看清"谁会被归档"）
SELECT t.id, t.name, t.state, m.value AS state_since,
       date((CAST(m.value AS INTEGER) + 90*86400000)/1000, 'unixepoch') AS due_date
FROM topics t JOIN meta m ON m.key = 'state.since:' || t.id
WHERE t.state IN ('draft','needs_review','dormant')
ORDER BY due_date, t.id;
```
**判据**：① = 0 且 ② = 0 ⇒ **不需要任何回填**。实测两项均通过。

**「导入期基准」才是要决策的点**：308 个 dormant 的 `stateSince` 是**落树/导入时刻**（2026-10-29/30），语义上没错（它们确实那时进入 dormant），但导致 338 个主题**同一天到期**。三个选项：

| 选项 | 做法 | 风险 |
|---|---|---|
| (a) **保持**（推荐） | 承认「导入即 dormant」；用「归档护栏 + 续期」把悬崖摊平 | 需要在 2027-01-27 前落地护栏；否则一次性 338 条 |
| (b) 重置为「发现时刻」 | 一次性把所有 dormant 的 `state.since` 改为 rollout 日 | 语义造假；只是把悬崖推迟 90 天；需写 `topic.state` 审计 + meta 双写（否则 462/0 一致性被破坏） |
| (c) 按 `updated_at`/最近写入重定基 | 让「近期被写过」的主题更晚到期 | 与 (a) 的「写入续期」重复；若做续期就不需要改 `stateSince` |

**推荐 (a)**：不改 `stateSince`；在 `isRenewed` 里加「最近 `renewDays` 内有写入 ⇒ 续期」（见 §5 P0-1）。若一定要 (b)，必须写成一次性、带审计、可回滚的脚本，并保留 meta/audit 一致（当前 462/0 的一致性不能被打破）。

### 4.4 Q3：修复顺序（stateSince → isRenewed → 曝光？）

**正确顺序：续期输入 → 归档护栏 → stateSince API 收紧 → 曝光层**（与 Lead 提的顺序不同：`stateSince` 本身是对的，先修它没有收益）。

| 顺序 | 层 | 为什么必须在这个位置 | 只修这一层的残留 |
|---|---|---|---|
| **1** | **续期（`isRenewed` 的真实输入）** | 当前 `lastHitAt` 永远 NULL、写入不续期 ⇒ **任何**曝光/归档阶梯都只是倒计时。先让「活着的主题」能续期 | 只修续期：被写过的主题不再归档；但 242+ 从未被写的明细仍会到期 ⇒ 仍需第 2 层 |
| **2** | **归档护栏** | `_archiveDue` 无上限/无事务/绕过子节点守卫；ledger 降级环境下还会被 `upgrade.mjs` 只读命令复用（sqlite 有临时副本保护） | 只修护栏：悬崖被摊薄（如 20 条/天，338 条要 17 天），但「写多读少」主题仍会归档；提醒口径不变 |
| **3** | **`stateSince` API 收紧 + 单测** | 防止未来调用方把裸 backend row 喂进 lifecycle（fallback 静默用 `createdAt`） | 只修它：无行为变化（当前调用方都正确注入） |
| **4** | **曝光层（若还要做）** | 必须在前三层之后，且只做「非明细 + 即将到期 + 轮转 + 每会话」子集 | 只修曝光（原方案）：**纯噪音 + 无保护**（本审计 FAIL 结论） |

### 4.5 Q4：影响面（数据一致性 + 状态机双重问题）

| 维度 | 结论 | 证据 |
|---|---|---|
| **① 归档不可逆** | **工具面不可逆**：`TRANSITIONS.archived = []`（`lifecycle.mjs#30`），`setState(archived→active)` 会抛 `STATE_TRANSITION`；**内部**仅 `_restoreState()`（`memory-store.mjs#1988`）可复活，且只被 `tree-apply` revive（`tree-apply.mjs#181/196/313`）和 `merge-undo`（`memory-store.mjs#2273/2282`）调用 ⇒ 普通主题归档后**没有用户可用的解归档入口**。内容不丢：`resolveTopic` 不排除 archived（`memory-store.mjs#842-874`）⇒ `memory_read T-xxxx` 可读；`archive.pointer` meta + 导出 md 保留指针。**但** L3 明细层（308 条）会整体塌陷（表 3-⑫） | 同左 |
| **② dream 候选** | 默认层级视图不再显示归档（`topicCounts` 明细口径排除 archived，`memory-store.mjs#764-790`）；`memory_topics` 的 `state=archived` 过滤仍可列出（`index.js#11494`）⇒ **可访问但默认不可见**，「一屏看全」（决策 16）能力下降 | 同左 |
| **③ 检索** | `memory_search` 主题块**排除 archived**（`index.js#7296`）；`findByTrigger` 同样排除（`memory-store.mjs#1268`）⇒ 338 个主题从主题检索消失，只能 `memory_read` 按 ID/名 或原文/导出回查 | 同左 |
| **④ 注入** | dormant 本就不进正文（只进注册表切片 `index.js#7350`）；归档后注册表切片候选减少 308 条（注册表按 `updatedAt` 取前 12，实际影响小）；若按原方案改曝光，提醒行 178→186 字符、条数 44→286 | 同左 |
| **⑤ 数据一致性** | 当前 `state.since` 与审计一致（462/0/111）；批量归档**无事务**（`_archiveDue` 逐条 5 写）⇒ 中断会留「state 已改、pointer 未写」等半状态；**写入 archived 不拒绝**（`appendSentence` 无状态守卫）⇒ 僵尸写入；`_restoreState` 不清理旧 `archive.pointer` ⇒ 复活后残留陈旧指针 | 同左 |

---

## 5. 方案对比（≥2 个替代）与推荐

| 方案 | 做法 | 收益 | 风险/代价 | 结论 |
|---|---|---|---|---|
| **A. 原方案**（dormant 全量进曝光 + 文案区分 + 剩余天数） | `EXPOSURE_STATES += dormant`；`buildReminder` 增加 state/剩余天数 | 名义上「不静默」 | 286 条只显示 3 条、283 条永不轮换；draft 可见 3→1；对批量归档零防护；对设计态明细发错误动作建议；需改 `pending` items schema + 行格式 | ❌ **不批准** |
| **B. 先修续期 + 归档护栏（推荐）** | ① `isRenewed` 增加「`updatedAt` 在 `renewDays` 内」；② `markHit` 接到 `memory_read`/`memory_search`（节流）；③ `_archiveDue` 加单次上限 20 + 事务 + 日志 + 先 plan；④ `pendingReminder()` 拆只读 `peekReminder()`，`upgrade.mjs` 改用 peek；⑤ 明细子主题（`parentId != null`）**不进** 90 天归档阶梯（或改用 `updatedAt` 基准） | 直接消除 2027-01-27 悬崖；让 OA/徕卡这类 write 59-275 的主题不再被归档；恢复「被命中即续期」契约；让 `--detect` 在 ledger 降级环境也真正只读 | 改动 2~3 个文件（`memory-store.mjs`、`lifecycle.mjs`、`upgrade.mjs`），需要单测；`markHit` 接线有写放大风险（需节流） | ✅ **批准（P0）** |
| **C. 只做「即将到期」曝光子集**（若仍想动提醒） | `EXPOSURE_STATES` 不动；新增 `dormantNearDue = parentId==null && 83<=daysInState<90` 单独一行/单独段，排序按剩余天数，带「用 memory_topics state=dormant 处置」指令 | 信息量高、不挤 draft 槽位（独立段）、只对真正要归档的主题提醒 | 当前命中 0 条（308 全是明细）；未来需轮转游标；仍是「每进程 1 次」通道，需先修 1.11 | ⚠️ **P1 可选**，必须在 B 之后 |
| **D. 批量处置入口（工具/面板）** | `memory_topics state=dormant`（已有）+ 面板加「明细归档预览」+ dream 提案批量转正/归档（人来定音） | 零注入噪音；可一次处理 308 条；符合决策 15/21 | 需要 UI/工具改动，非「最小 diff」 | ⚠️ P2，与 B 并行可做 |
| **E. 什么都不做** | 接受现状 | 零风险 | 2027-01-27 一次性归档 338 条 + L3 明细塌陷；「不静默埋掉」承诺失效 | ❌ 不可接受 |

**推荐 = B（P0）**；若产品坚持要「dormant 有曝光」，再做 C（且必须先修 1.11 的进程级闸，否则曝光频率仍是每进程 1 次）。**原方案 A 不批准。**

---

## 6. 护栏清单（若实施 B / C，逐条必须落实）

| # | 护栏 | 理由 | 验收判据 |
|---|---|---|---|
| G1 | `isRenewed` 增加「写入续期」：`lastHitAt` 或 `updatedAt` 在 `renewDays` 内 ⇒ renewed | 修复「写多读少 ⇒ 被归档」 | 单测：write 于 1 天前的 dormant 不进提醒/不归档；30 天前写入的照常 |
| G2 | `markHit` 接线（`memory_read` 必接；`memory_search` 按会话+主题节流，如每会话每主题 1 次） | 恢复「被检索命中 ⇒ 续期」契约 | 集成：`memory_read` 后 `last_hit_at` 非空；同一会话重复读只记 1 次 |
| G3 | `_archiveDue` 单次上限（建议 20，复用 `P25_LIFE_SWEEP_LIMIT` 模式）+ 单条事务（`runInTransaction`）+ 审计带 `count/limit` | 批量归档可控可停 | 造 100 条到期夹具：一次 tick 只归档 20，剩余下次继续；审计含 limit |
| G4 | `pendingReminder()` 拆为只读 `peekReminder()` + 写库 `lifecycleTick()`；`upgrade.mjs#218` 改用 peek | 满足决策 23「detect/plan 零写入」（**ledger 降级环境**；sqlite 已有临时副本保护） | 跑 `--detect` 前后真实账本 `audit` 行数不变（ledger 夹具；只读断言） |
| G5 | 明细子主题（`parentId != null`）**不进** 90 天归档阶梯（或按 `updatedAt` 基准） | 决策 21：明细子主题是设计态，不是「过期内容」 | 308 条明细在 `planArchivable` 中返回 0；主主题口径不变 |
| G6 | 提醒排序：剩余天数升序 + 稳定二级键；若并列，用轮转游标（meta `exposure.cursor`）或按 `updatedAt desc` | 防止「永远显示同 3 条」 | 两次 tick 显示不同 3 条（游标推进） |
| G7 | 剩余天数兜底：`Math.max(0, archiveAfterDays - daysInState)`；`NaN/负值` 不显示为负 | `_archiveDue` 失败时可能出现已到期项 | 夹具：daysInState=95 的项不出现「-5 天后归档」 |
| G8 | 单行硬上限：行字符 ≤ 240（或沿用 178~198 实测区间），名称截断到 14 字 | 防文案膨胀 | 单测断言 `line.length <= 240` |
| G9 | 失败隔离：提醒/归档异常只 `cwarn`，不影响主流程（现状已满足，保留） | 既有纪律 | 注入失败时其余 parts 仍投递 |
| G10 | 日志带值：`count / hidden / oldestDays / archived / limit / sample ids` | 事后对账 | 日志格式固定、可 grep |
| G11 | 口径唯一：`index.js#8715` 的重复过滤改为调用 store 的同一函数；`pendingNote` 与提醒同源 | 防「提醒 286 / 面板 2」漂移 | 面板数字 == `peekReminder().count` |
| G12 | 单测覆盖 `lifecycle.mjs`（当前 0 覆盖）：`exposureLevel`（含 dormant/续期/边界 7/30/90）、`buildReminder`（0/3/4 条、并列排序、hidden）、`planArchivable`（limit/明细排除） | 现有 `verification.md` C 组仍是空框 | 新增 `test/_lifecycle-exposure-selftest.mjs`，全绿 |
| G13 | 写入 archived 主题拒绝（`appendSentence`/`replaceSentence` 前置 `state !== 'archived'`，或明确允许但审计告警） | 防僵尸写入 | 单测：写 archived 抛 `STATE_TRANSITION` |

---

## 7. 影响面结论（逐项回答）

| # | 维度 | 结论 |
|---|---|---|
| ① | **核心功能**（记忆读写 / 检查点 / 压缩重灌） | **原方案不波及**（只改提醒计算）。**B 的 G1/G2/G3 会触及写入与生命周期**：`markHit` 接线会增加写路径（需节流，否则与 checkpoint/dream 写争 SQLite 锁）；`_archiveDue` 加事务/上限改变归档节奏。读写主链本身不改 |
| ② | **相关子系统** | 波及：**面板/统计口径**（三份实现需统一）、**dream 候选**（归档后默认视图丢明细）、**检索**（归档后主题块不可见）、**注入预算**（提醒行 +8 字符，可忽略；但若做 C 需新增段）、**升级探测**（ledger 降级环境需只读化） |
| ③ | **性能** | 原方案：每次 `pendingReminder()` 全量扫 573 主题（`listTopics` + `_stateSince` 逐条 meta 读 = 573 次 `getMeta`）；`index.js#11476` 注释实测 418 行 <10ms，573 行同量级，可接受；且**注入频率是每进程 1 次**，实际开销可忽略。B 的 `_archiveDue` 加事务/上限会略增单次成本，但把 338 条拆成多次，避免一次长事务 |
| ④ | **启动** | 不波及启动路径（`agent/created` 首会话才触发；无 boot 期扫描）。`upgrade.mjs --detect` 的写副作用仅存在于 ledger 降级环境；且当前 index.js 的 `detectUpgradeState` 不调 upgrade.mjs，故启动期不触发 |
| ⑤ | **数据一致性** | **原方案不改数据**。真正的数据一致性风险来自批量归档：无事务/无上限/绕过子节点守卫/僵尸写入（§2.9、§2.10、表 3-⑦）；ledger 降级环境另有「只读命令写真实账本」（表 3-⑧）——这些**在方案落地前就存在**，但 2027-01-27 会集中爆发，必须在 B 里修 |

---

## 8. 观测门（skill 强制）

### G-0 先观测，后实现 —— **不通过**

| 观测项 | 实测 | 是否支撑原方案 |
|---|---|---|
| 308 dormant 分布 | ✅ 属实（dormant 308 / 573 = 53.8%） | 数据属实，但**构成被误读**：308/308 有 `parent`，是决策 21 的**明细子主题**，不是「长期未检索降级」的产物 |
| 5 个核心主题 `last_hit` 从未 | ✅ 属实（573/573 `last_hit_at` NULL） | 属实，但**更强**：`markHit` 0 调用方 ⇒ 这是**续期链路死**，不是「读得少」 |
| 「设计契约原文」 | ⚠️ 引用的 `lifecycle.mjs#6-10` 是**模块头注释**；权威决策文档 `alignment.md#43-48` 的曝光阶梯表头明确写「时间（**draft/needs_review 未处置**）」 | ❌ 契约**没有**承诺 dormant 曝光；`dormant` 的契约定义是「不进注入正文、检索命中时低置信列尾部」（`alignment.md#40`） |
| 「dormant 能被归档却不在曝光名单」 | ✅ 代码事实成立（`ARCHIVABLE_STATES` 含 dormant、`EXPOSURE_STATES` 不含） | 事实成立，但**推论不成立**：曝光名单不是归档的前置条件，两者解耦；补曝光不改变归档 |
| 「长期未被检索 → 降级 dormant」 | ❌ **无此路径**：全仓只有 3 条进入 dormant 的路（needs_review 溢出 / 落树明细 / 显式 setState）；`needs_review.overflow` 审计 **0 次** | ❌ 前提错误 |

**G-0 结论**：数据**支撑「有问题」**，但**不支撑「补曝光」**——支撑的是「修续期 + 修归档语义」。方案应重写为 B。

### G-3（删除型/绕过型）—— 改变「什么会出现在提醒里」的能力可达性证明

**① 现有提醒的完整内容形态**（2026-11-02 真实注入样本，`session-e6827f9b`）：
```
<system-reminder>
以下为 dsh-memory 维护提醒（写入 ~/.dsh 需要一次审批，频率很低）：

【dsh-memory 超限整理提醒】以下记忆文件超限（阈值=软信号，预算=硬截断）：
- global.md：字节 5052B（兜底线 4608B）/ 字符 2980（告警线 2700 · 硬预算 3000）→ ⚠️ 接近硬限…

【dsh-memory · 待归类主题】47 条待归类主题，最早 7 天：T-0003「DSH Agent Teams…」；T-0006「.HNSZF 标书文件格式…」；T-0007「OA 访问与 OpenVPN 分流…」 等 44 条

【dsh-memory · 主题注册表】（ID/状态/名字/triggers；正文用 memory_read，检索用 memory_search）
- T-0436 @ needs_review「子代理对话摘要」 trig:子代理摘要/subagent digest · 119 句
- T-0506 @ active「C-1_长沙-1、交易场地智」 · 1 句
- …（剩余主题用 memory_topics 查看）
</system-reminder>
```
**② 新增 dormant 后的形态**（真实快照 + `buildReminder` 复算，186 字符）：
```
【dsh-memory · 待归类主题】286 条待归类主题，最早 7 天：T-0001「MEMORY-107服务器-PHP升级与php2shell（2026-10-22）」；T-0002「MEMORY-107服务器-docker日志自旋.md」；T-0003「DSH Agent Teams：teammate 上限（maxMembers）与「不可删除」」 等 283 条
```
**③ 哪些既有提醒会被挤掉**：
- **槽位挤占（确定发生）**：3 个可见槽位从「3 条 draft」变成「2 条 dormant + 1 条 draft」——T-0006/T-0007 两条 draft 被挤出（G-3 必答）。
- **段落挤占（不会发生）**：字节只 +8，`parts` 是独立追加，`global/index` 预算不变；备份/轮转/超限/注册表/升级段**不被删改**。
- **能力可达性**：原提醒服务的「draft/needs_review 处置」能力仍然可达（工具面不变），但**可见性**下降；dormant 的「曝光」能力**新增但几乎不可达**（283/286 永不显示、每进程 1 次、无处置指令）。

### G-9 产出物判据（可执行）

| 判据 | 现状（baseline） | 改后（预期） | 命令/样本 |
|---|---|---|---|
| 提醒行字符数 | **178** 字符（44 条 / 隐藏 41 / oldest 7） | **186** 字符（286 条 / 隐藏 283 / oldest 7） | 只读探针：`import { planExposure } from '.../lifecycle.mjs'` + 真实 DB 快照（`meta state.since` + `topics`）→ `planExposure(rows, Date.now()).reminder.line` |
| 提醒条数 | 44（draft 44 + needs_review 0） | 286（draft 44 + dormant 242） | 同上 |
| 注入频率 | **每宿主进程 1 次**（`maintenanceInjected`）；实测 14 天 / 570 个会话日志中仅 **1 次**真实注入（2026-11-02，47 条） | 不变（仍每进程 1 次） | grep 会话日志正则 `【dsh-memory · 待归类主题】\d+ 条待归类主题` |
| 是否改变归档 | **否**（`ARCHIVABLE_STATES` 未动；`planArchivable` 复算：+83d=286、+84d=352、+90d=354） | 否 | 纯函数复算（不写库） |
| 是否挤占注入预算 | 否（parts 独立追加，`index.js#15829-15832`） | 否（+8 字符） | 对比 `parts` 其余段字节 |
| **判定** | — | **产出物字节几乎不变；信息价值崩塌（283/286 隐藏）** | — |

**baseline 样本**：`session-e6827f9b-8…`（2026-11-02，长沙工作区）真实注入的 `47 条…等 44 条`；本报告 §8-G-3 已逐字引用。改后预期串见 ②，可用只读探针复现。

### G-9.2 反面问题（必答）：这项改动可能怎样让现有功能失效？——**≥3 条失效路径（实际列出 7 条）**

| # | 失效路径 | 机制 | 可观测判据 |
|---|---|---|---|
| **F-1** | **噪音 → 模型忽略提醒** | 每进程一行「286 条…等 283 条」，连续多次后模型把该段当模板噪音；同时把 draft 曝光从 3 条压到 1 条 | 提醒行 `hidden/count` 比 98.9%；draft 在 `items` 中出现次数从 3 降到 1 |
| **F-2** | **永久固定 3 条，283 条永不出现（假曝光）** | `days` 全并列（7）→ 排序退化为 ID 升序 → 永远 T-0001/T-0002/T-0003；`topicNotifiedOnce` 同内容去重 | 两次进程启动的提醒行**逐字相同**；283 个 ID 从未出现在任何日志 |
| **F-3** | **错误动作诱导：对设计态明细「建议归档/转正」** | 30 天后 level=escalate，`buildReminder#109-110` 追加「建议归档 / 或转正」；308 个是 `parent=active` 的明细，转正=塞进注入正文（违反决策 21），归档=塌掉 L3 明细层 | `+30d` 复算：354 条 escalate、行 198 字符；agent 若照做 → `topicCounts().details` 308→0 |
| **F-4** | **给人/agent「已保护」的错觉，实际归档照旧** | 曝光与归档解耦；无处置指令；每进程 1 次 ⇒ 2027-01-27 仍一次性归档 338 条 | `planArchivable(+83d)=286` 不因曝光改动而变化；`audit op=topic.archive.auto` 从未出现（0 次） |
| **F-5** | **挤掉 needs_review/draft 的可见性** | 3 个槽位被 dormant 占 2 个；`needs_review` 2 条（实测 T-0534=2 天、T-0547=1 天）7 天后进入同一名单，但 ID 大、排序靠后 ⇒ 仍不可见 | 改后 `items` 中 draft 数 3→1；needs_review 7 天后 count 增加但 `items` 仍不含它 |
| **F-6** | **文案/口径漂移** | 加「N 天后归档」需要给 `pending` items 增加 `state/remainingDays`（`planExposure#134` 当前不传），`buildReminder` 行格式变化；同时 `index.js#8715` 面板口径未同步 ⇒ 三处数字不一致 | `buildReminder` 单测缺失（0 覆盖）；面板 `pendingNote` 仍按 needs_review=2 |
| **F-7** | **（实现层）`_archiveDue` 失败时提醒出现负天数** | `lifecycleTick` 先归档后提醒；归档中途抛错（SQLITE_BUSY/异常）⇒ 提醒可能含已到期项 | 夹具：daysInState=95 的项；需 `Math.max(0, …)` |

---

## 9. Findings

### 必须修（若实施 B；原方案则直接改方案）

| # | 严重度 | Finding | 证据 |
|---|---|---|---|
| **F1** | **高** | **方案前提错误**：308 dormant **全部**是 `parent=active` 的明细子主题（决策 21 设计态）；全库无「长期未用 → 降级 dormant」路径（`needs_review.overflow` 审计 0 次） | 只读 SQL：308/308 有 parent、36 个 active 父；`audit op=topic.needs_review.overflow`=0；`alignment.md#62-64` |
| **F2** | **高** | **真正的批量归档悬崖**：`state.since`=导入/落树时刻 + 续期死链 ⇒ 2027-01-27 归档 338 条、01-28 再 14 条（L3 明细 308 全灭）；原方案对此零改善 | `planArchivable` 复算 +83d=286/+84d=352/+90d=354；§4.1 |
| **F3** | **高** | **续期链路是死的**：`markHit` 全仓 0 调用方；573/573 `last_hit_at` NULL；写入不续期（`_autoPromoteIfDue` 只认 draft）⇒ 「被检索命中 ⇒ 续期」契约从未生效 | `memory-store.mjs#1596`、`#1537-1540`、`#1336`；只读 SQL |
| **F4** | **高** | **提醒实际是「每进程 1 次」而非「每会话 1 次」**（`maintenanceInjected` 闸）⇒ 原方案「给足曝光」的前提不成立；实测 14 天/570 会话仅 1 次真实注入 | `index.js#12259`、`#16234-16236`；会话日志扫描 |
| **F5** | **中高** | **槽位挤占**：加 dormant 后 3 个可见槽位 = 2 dormant + 1 draft，draft 曝光 3→1（T-0006/T-0007 被挤掉）；`needs_review` 现有 2 条仅 1~2 天（T-0534/T-0547），7 天后进入同一名单但 ID 大 ⇒ 仍不可见 | `buildReminder` 复算（§8-G-3 ②）；只读 SQL |
| **F6** | **中高** | **永久固定 3 条**：308 dormant `days` 并列 ⇒ 排序退化为 ID 升序 ⇒ 永远 T-0001/T-0002/T-0003，283 条永不轮换 | `lifecycle.mjs#101`/`#136`；复算 items |
| **F7** | **中** | **三份「待归类」口径**：lifecycle / 面板硬编码（`index.js#8715`）/ `pendingNote`（needs_review 计数 2）——改常量后数字进一步分叉 | `index.js#8707-8721`、`#8656` |
| **F8** | **中** | **`_archiveDue` 无单次上限/无事务/绕过 `TOPIC_HAS_CHILDREN`**；批量归档中断留半状态 | `memory-store.mjs#1687-1701`、`#1490-1495`；对比 p25 sweep `index.js#8332`/`#8385-8387` |
| **F9** | **低（仅 ledger 降级环境）** | **只读命令在 ledger 后端会写真实账本**：`upgrade.mjs --detect/--plan` → `dbStats` → `pendingReminder()` → `_archiveDue()`；sqlite 有临时副本保护（源库零写入），ledger 直接开真实文件且 `_emit` 立即落盘 ⇒ 违反决策 23「零写入」 | `upgrade.mjs#218`、`#348-360`、`#152-167`；`backend-ledger.mjs#89-94`；`alignment.md#66` |
| **F10** | **中** | **`stateSinceOf` 静默回落 `createdAt` 是陷阱**：未来任何调用方把裸 backend row 喂 lifecycle 都会把「创建时间」当「状态年龄」；且 `lifecycle.mjs` **0 单测** | `lifecycle.mjs#56-59`；全仓 grep 无 `buildReminder/planExposure` 断言；`verification.md#33-40` 仍为空框 |
| **F11** | **中低** | **写入 archived 主题不被拒绝**（`appendSentence` 无状态守卫）⇒ 批量归档后 dream 继续写「僵尸主题」 | `memory-store.mjs#1321-1346` |
| **F12** | **低** | `planExposure().archivable` 是死输出（调用方只取 `.reminder`）；`scanLifecycle()` 无调用方 | `memory-store.mjs#1703-1706`、`#1719` |

### 可接受但需记录

| # | 事项 | 记录 |
|---|---|---|
| R1 | 提醒行 +8 字符（178→186） | 不挤占 global/index 预算（独立 parts 追加），字节风险可忽略；真正风险是信噪比 |
| R2 | dormant 已通过「主题注册表切片」进注入（`index.js#7350`） | 「dormant 完全不曝光」不成立；原方案不是「从 0 到 1」，而是「从注册表切片到提醒行」 |
| R3 | 308 个 dormant 的 `state.since` = 落树时刻（10-29/30） | 语义上没错（它们确实那时进入 dormant）；不建议「回填/重置」（只是把悬崖推迟 90 天） |
| R4 | 归档保留内容（`memory_read` 可读、pointer、导出） | 不是数据丢失；但工具面无解归档入口（`TRANSITIONS.archived=[]`），仅 `_restoreState` 内部可复活 |
| R5 | `p25LifecycleSweep`（会话检查点归档）与本次无关 | 它有单次上限 20、每天最多一次（`index.js#19926-19958`），不受 `EXPOSURE_STATES` 影响 |
| R6 | `curation.mjs#49 includeStates` 已含 dormant | 与曝光名单独立，不受影响 |
| R7 | 66 个 dormant 未满 7 天 | 未来 1~3 天提醒条数会从 286 涨到 352；文案「最早 7 天」无信息量 |
| R8 | 面板 `pendingNote` 用 needs_review 计数（2）与提醒 44 已不一致 | 既有口径问题，非本次改动引入；建议随 G11 一并修 |

---

## 10. 未能验证的部分（诚实记录）

1. **未在真机执行 `lifecycleTick()` / `pendingReminder()`**（会写库，违反只读约束）——所有归档/提醒结论均用**纯函数 + 真实库只读快照**复算（`planArchivable/planExposure/buildReminder`），未验证「宿主进程在 2027-01-27 当天是否在运行」；`lifecycleTick` 只在 `pendingReminder()` 被调用时触发（`index.js#11418`），若宿主长期不重启/不新开会话，批量归档会推迟到下一次调用。
2. **注入频率的长期统计有限**：只扫了最近 14 天 / 570 个会话目录的**最新版本**日志（zstd），压缩可能丢弃早期注入；观察到 1 次真实注入，与 `maintenanceInjected` 的「每进程 1 次」一致，但未跨 30 天统计。
3. **未运行项目自带测试套件**（只读、不构建；且 `lifecycle.mjs` 本就没有单测可跑）。`verification.md` C 组（曝光/续期/归档）复选框仍为空——即这些行为**从未被自动化验证过**。
4. **未在真实库上跑 `upgrade.mjs --detect`**（本机为 sqlite，`probeStore` 用临时副本 ⇒ 源库零写入，属只读；但未实际执行 CLI）。**ledger 降级路径**仅静态判定会写真实账本（`upgrade.mjs#152-154` + `backend-ledger.mjs#89-94`），本机无 ledger 库，未能实测。
5. **未复现多进程 `SQLITE_BUSY`**（需要写库/并发；`backend-sqlite.mjs` 未设 `busy_timeout`，仅静态判断风险）。
6. **未审计 client 设置页对 topicdb 的展示**（仅确认 client 侧无提醒消费方；grep 无 `待归类/pendingReminder/dormant` 命中）。
7. **Lead 的 `_verify/_q-lifecycle-why.mjs#7` 查询了不存在的列 `state_since`**（实测 `SELECT ... state_since FROM topics` 抛 `no such column: state_since`）——该脚本大概率未成功跑出结果，可能是「字段不存在」结论的来源之一；建议作废/改写为 `meta state.since` 版本。
8. 本审计**未验证部署态与仓库态的其余差异**：`index.js` 整体 hash 不同（部署 14:52 / 仓库 18:48），但本审计涉及的 5 个区段（7130-7160、8700-8725、11410-11440、15700-15840、16225-16245）逐字节一致，`memtopic/src/*.mjs` 部署=仓库同 hash；因此 memtopic 层结论可直接用于生产，index.js 层结论在「提醒注入链」范围内可直接用于生产。

---

## 附录：本次审计的只读探针（`%TEMP%`，不落仓库）

| 探针 | 用途 |
|---|---|
| `cra-probe-lifecycle.mjs` | 状态分布 / dormant 构成 / 当前 vs 加 dormant 的提醒条数 / 5 核心主题 / 当前可归档数 |
| `cra-probe-lc2.mjs` | `state.since` vs `created_at` / 归档到期日分布 / audit 状态迁移 / dormant 父节点 / 当前提醒 |
| `cra-probe-lc3.mjs`、`lc4.mjs` | 会话日志中「待归类主题」真实注入形态与频率（G-3/G-9 baseline） |
| `cra-probe-lc5.mjs` | 用 `lifecycle.mjs` 真实复算提醒行（178 vs 186 字符） |
| `cra-probe-lc6.mjs` | `state.since` 与 audit 一致性（462/0/111）、`needs_review.overflow`=0、写入/命中关系 |
| `cra-probe-lc7.mjs` | 归档前置风险：dormant 有子节点=0、最大树深=3、archived 有子节点=0 |
| `cra-probe-lc8.mjs` | 纯函数模拟未来 90 天归档时间线（+83d=286 / +84d=352 / +90d=354） |

所有探针均以 `new DatabaseSync(path, { readOnly: true })` 打开真实库，未产生任何写入；会话日志只读解压（zstd）。
