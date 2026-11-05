# 退役「子代理摘要」通道 · 变更风险审计（CRA）

> 审计对象：**方案（尚未实现）**——退役子代理会话机械摘要通道（对齐 MiMo-Code，starry 2026-11-05 14:19 拍板方案 2，决策记录见库内 `T-0558` 第 5 句）
> 仓库/基线：`E:\工具\插件开发调整\dsh-memory-plugin\index.js` —— **20481 行**，v4.0.1，SHA256 前缀 `2BAE1065`；
> 已部署副本 `C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js` 与仓库**逐字节相同**（同 sha、同 mtime 2026-11-05 13:32:46）⇒ 下列行号对"仓库=现网"同时有效。
> 审计方式：**只读**（不改代码、不构建、不部署、不改库状态）。所有结论带 `文件#行号`；库内数据用 `node:sqlite` **readOnly** 查询；检索能力用真机 CLI 实测。凡推断均显式标注。
> 审计时间：2026-11-05 14:20–14:40（Asia/Shanghai）。

---

## 0. 结论先行

**结论：PASS-with-findings —— 批准退役，但必须按 §6 的「方案 B」执行，并先修 4 条必修 finding。**

| 项 | 判定 |
|---|---|
| 退役方向 | ✅ **批准**。G-0 证据充分且**比方案书写的更严重**：T-0436 现 128 句 / 126,411 字；今日 10:00/12:00/14:00 三个 tick 又写入 25 句 / 24,625 字；pending 实测 **407**；单块均值 988 字 ⇒ 消化存量将再涨 **≈40.2 万字**，终态 ≈52.8 万字 = 明细上限(4 万)的 **13.2 倍**（方案书写的「~22 万字」低估约 1.8×，方向不变）。 |
| G-3 能力可达性 | ✅ **通过（能力面不缩小、反而扩大）**。摘要覆盖 127/585 个子代理会话（21.7%）；`session_search` 覆盖 585/585（索引缓存 85 天、最早会话 08-31 全在覆盖内），并**真机实测**取回已摘要会话的「任务 + 结论」原句（§5）。 |
| 是否可"直接删" | ❌ **不可以**。原方案删命令会陷入两难：**保留 `COMPAT` 登记** ⇒ `_verify/topicdb-compat-check.mjs#86`（`registered===expected`，6≠7）红；**连登记一起删** ⇒ `#147`（`expected===7` 硬编码）红；另 `test/plugin.smoke.test.mjs#105` 也需同批改。且删掉命令就没有任何位置能给出「已下线」提示。 |
| 高危发现 | **① T-0436 里混着 1 条非摘要的真实记忆**（sentence id=33363，Android 剪贴板分享上传 v3 审核结论），归档会把它一起埋掉；**② 归档后若还有残留调用 `digestBlocksToDb`，会因为 finder 过滤 archived 而「复活」出一个全新的同名主题**；**③ 归档不可逆**（`TRANSITIONS.archived=[]`，无公开 restore）。 |
| 推荐方案 | **B：停写（删 2 个调用点）+ 命令降级为下线提示 stub + 保留纯函数/常量/导出 + 归档 T-0436（归档前先迁出那条真实记忆）**。diff ≈20–30 行，全部既有门可保持绿，代码可回滚。 |

---

## 1. 表 1 · 调用链与语义（含可疑点）

### 1.1 生产调用链（全仓；排除 `*.bak*`/`_tmp-prev.js` 后仅下列位置）

| 函数/命令 | 定义 | 全部调用方（文件#行号） | 语义 |
|---|---|---|---|
| `runSubagentDigestTick()` | `index.js#6112-6125` | ① `#15810`（`injectMaintenanceReminder` 内，`await`）② `#19971`（每小时 `ctx.interval`，fire-and-forget `.catch`） | 1h 内存节流（`#6115`）+ 账本加载（`#6114`）+ 跑一批（`#6117`，`staleSessionDays`） |
| `runSubagentDigestBatch(limit,opts)` | `#6057-6106` | ① tick `#6117` ② backfill `#6134` ③ 命令 `#20337`（默认/dry）④ **具名导出 `#6198`** ⑤ 门 `_test-subagent-digest.mjs#125/#137` | 扫描 → 抽摘要 → 写库（flag 开）/写 md（回落）→ 记账本；返回 `{added,pending,...}` |
| `runSubagentDigestBackfill(perRound)` | `#6127-6147` | 仅 `#20333`（`/subagents-archive backfill`） | 单飞（`SUBAGENT_BACKFILL_RUNNING`）循环 ≤2000 轮 |
| `subagentDigestOf(dir)` | `#5941-5983` | ① batch `#6073` ② 导出 `#6198` ③ 门 `_test-subagent-digest.mjs#109/#120/#126/#163` | 只解头 12 帧 + 尾 5 帧，取「任务 + 结论 + 状态 + label」 |
| `subagentDigestBlock(d)` | `#5995-6002` | ① `digestBlocksToDb#6043` ② md 写 `#6098` ③ 导出 `#6198` ④ 门 `#121` | 渲染一条 Markdown 块 |
| `subagentListDirs()` | `#6003-6027` | ① batch `#6063` ② 导出 `#6198` ③ 门 `#103` | 只收**裸 GUID** 目录（跳过 `session-` 前缀） |
| `digestBlocksToDb(list,key)` | `#6029-6055` | ① batch `#6089` ② **测试钩子 `__p5Hooks.digest` `#13433`** ③ `_verify/topicdb-p5-check.mjs#127/#135/#141/#146` | **真正的 T-0436 写入口**：`store.topics().find(/子代理对话摘要/ && state!=="archived")`（`#6035`）→ 无则 `seedTopic`（`#6037`）→ 逐条 `appendSentence`，`meta digest:<sid12>` 幂等（`#6046-6048`） |
| `/subagents-archive` 命令 | `#20320-20344` | 用户界面；启动横幅 `#20364`；`COMPAT_COMMAND_NAMES#5078`；README `README.md#189`；CHANGELOG `docs/CHANGELOG.md#298/#315/#319`；门 `test/plugin.smoke.test.mjs#105` | `off/on` 写 `.integrate.json.subagentArchive`；`backfill` 起后台；默认/dry 跑一批并回执 |
| `subagentArchiveEnabled()` | `#6109-6111` | 仅 tick `#6113` | 读 `.integrate.json.subagentArchive`，**缺省 true**（现网文件无此键 ⇒ 当前自动通道为开） |
| `subagentDigestRel/Header` | `#5989/#5990` | 仅 md 回落写 `#6095/#6098` | 产出 `knowledge/MEMORY-子代理对话-<date>.md` |

### 1.2 可疑点 / 反直觉用法

| # | 可疑点 | 证据 | 影响 |
|---|---|---|---|
| S1 | **"两个调用点"实际是「每进程 1 次 + 每小时 1 次」**：`#15810` 在 `injectMaintenanceReminder` 内，而该函数只在 `agent/created` 处理链里被调用且被 `maintenanceInjected` 闸住（`#16225-16227`，标志 `#12254`）⇒ 每个插件实例**最多执行一次** | `#15849`（`compatOn(ctx,"agent/created")`）→ `#16227` → `#15810` | 停写必须删两处，只删 tick 仍会"每进程补一批" |
| S2 | **同一函数既是"写入器"又是"统计器"**：命令 `dry` 分支与真写分支共用 `runSubagentDigestBatch`（`#20337`），`dry` 只是 `opts.dry` | `#6057/#6060/#6075/#6081` | 删除时若只删命令、保留 batch，batch 仍可被"统计"名义误触（→ 见 F3 复活风险） |
| S3 | **`digestBlocksToDb` 的主题查找过滤 archived**：`t.state !== "archived"` | `#6035` | **归档 T-0436 后，任何残留调用都会 `seedTopic` 出一个全新的「子代理对话摘要」**（审计最重的实现陷阱，F3） |
| S4 | **`ARCHIVED_SESSIONS` 的注释是错的**：注释说"子代理摘要 / 择父 `isArchivedAgent` 共用"（`#1650`、`#6203`），但 `isArchivedAgent` 实际读的是 **`workspace.json` 的 `archivedSessionIds`**（`readArchivedSessionIds#6277-6300` → `#12230`），**从不读**该 Set | `#6277-6300`、`#12227-12231` | 退役后该账本**只写不读**（严格说"不再写也不再读"）；见 表2 |
| S5 | **`staleSessionDays` 的最后功能读者就是这个通道**：`#6061/#6117/#20337` | 同左；`client/lib/client.js#21/#69/#84/#123` 的面板控件 | 退役后该设置项变**死旋钮**（今天刚按上一份 CRA `M1` 加回，见 `docs/audit/panel-followup_AUDIT_2026-11-05.md#249-251`）→ R2 |
| S6 | **1h 节流是进程内存态**：`SUBAGENT_DIGEST_LAST_AT#6107`，无跨进程/持久化；实测今日写入间隔出现 **36 分钟**（02:16→02:52 UTC）< 1h | DB `created_at`；`#6107/#6115` | 要么进程重启、要么多实例各持一份节流 ⇒ 退役前在途批次/重复写入的边界见 表2 |
| S7 | **P5 测试钩子把"库内写入口"暴露给 verify 门**：`__p5Hooks.digest = (list,key)=>digestBlocksToDb(...)` | `#13430-13434`；`_verify/topicdb-p5-check.mjs#127` | 若保留 `digestBlocksToDb`，此门继续绿；若删，必须同步改门（多文件、扩大 diff） |
| S8 | **`/subagents-archive off` 不会让手动命令失效**（回执文案自认），也不会停掉已注册的 backfill | `#20327-20330` | 用户可能误以为"off=全关" |

---

## 2. 表 2 · 状态 / 线程竞态（风险等级 + 护栏）

| # | 状态/竞态 | 现状机制（行号） | 退役后 | 风险 | 护栏 |
|---|---|---|---|---|---|
| T1 | `SUBAGENT_DIGEST_LAST_AT`（1h 节流） | 进程内存 `#6107`，仅 tick 读写 | **无人读、无人写**（随 tick 删除） | 低（删除即消失） | 无需处理；**不要**改成持久化（会留死状态） |
| T2 | `SUBAGENT_BACKFILL_RUNNING`（单飞） | 进程内存 `#6108`，仅 backfill/命令 | 命令改 stub 后无人置位 | 低 | stub **不得**调用 `runSubagentDigestBackfill` |
| T3 | `ARCHIVED_SESSIONS` + `.integrate.json.archivedSessions` | `Set#1650`；加载 `ensureArchivedSessionsLoaded#1676-1684`（仅 tick `#6114`）；落盘 `saveStaleNotified#1657-1671`（仅 batch `#6103`）；过滤 `#6065/#6075/#6076/#6081` | 变成**惰性数据**：现网 1241 条历史 id 仍留在盘上，插件不再读也不再写 | 低（无功能依赖；注释误导见 S4） | 保留历史键不删（与 2026-11-04 归档链删除的处置一致，`#1652-1654`）；CHANGELOG 注明"archivedSessions 已成惰性账本" |
| T4 | **在途批次（fire-and-forget）** | `#19971` 不 await，仅 `.catch` 记 monitor（`#19972`）；batch 内每 8 个 `await setTimeout(0)`（`#6082`）；写盘在循环之后（`#6085-6103`） | 部署=宿主重启：旧进程被杀时可能停在"账本已 add、正文未写" | 低 | ①DB 通道按块 `appendSentence`+`setMeta`（`#6049-6050`）是逐条提交，**不会写出半句**；②md 通道 `writeFileAtomic`（`#6099`）原子；③"账本已记但未写"的窗口只在 `#6103` 之前，进程崩溃则盘上账本未更新 ⇒ 下轮重扫，幂等；④**已知旧洞（非本次引入）**：DB 路径若在 append 与 setMeta 之间崩溃，重试会重复 append 一条（`#6049-6050` 无事务） |
| T5 | **多实例/重启** | 节流是内存态（S6），跨进程只靠 `digest:<sid12>` meta 去重（DB 通道）与 md 追加（无去重） | 停写后彻底消失 | 低（正向） | 停写即根治；部署说明里注明"重启后生效，无需清理" |
| T6 | **`.integrate.json` 全量读改写** | `saveStaleNotified#1663-1669` 读-合并-`writeFileAtomic`，无锁；与 `p25LifeLastRun` 等写者并发 | 少一个写者（正向） | 低 | 不新增写者；stub 不落盘（`off/on` 分支随命令删除） |
| T7 | **全库导出被摘要写入触发** | 摘要写库/写 md 后触发 `topicDbAutoExport`（`reason:"write"`，30min 节流 `#7453`），一次导出 = 全库 7.5MB（`#7538/#7551`） | 少一个高频触发源 | 低（正向） | 无 |
| T8 | **主流程阻塞** | `#15810` 是 `await`，且在 `agent/created` 注入链内；`subagentDigestOf` 用 `fs.readFileSync` 整文件同步读（`#5949`，实测单个会话最大 **9.6MB**，注释称可达 28.6MB `#5904`） | 删除后少一次同步大 IO | 低（正向） | 无 |

---

## 3. 表 3 · 边界场景（会发生什么 + 兜底）

| # | 场景 | 会发生什么 | 兜底/建议 |
|---|---|---|---|
| B1 | **存量 pending=407**（方案写 449） | 实测 407 个 >1 天的裸 GUID 会话未被摘要（合格候选 546 − 账本内 139）。若一次性回填：407×988 字 ≈ **40.2 万字**，13.2× 明细上限；且**归档后回填会复活新主题**（F3） | **丢弃不回填**（原文可检索，§5）。决策需记录：`pending=407 丢弃`；`.integrate.json` 不需清理 |
| B2 | **用户已习惯 `/subagents-archive`** | 若直接删注册：宿主报"未知命令"，且无任何位置能提示替代路径；同时打红 `COMPAT` 计数门与 smoke 测试 | **命令降级为 stub**：保留注册与 `COMPAT_COMMAND_NAMES`，handler 直接返回 success + 下线说明（含 `session_search` 用法与 `memory_read T-0436`） |
| B3 | **T-0436 归档后 `memory_search` 还能查到吗** | 主题检索显式跳过 archived（`#7291`「归档仅原文检索可见（决策 13）」）⇒ **主题不再出现在 memory_search 结果**；但 `archiveTopic(pointer:true)` 会往父主题 **T-0424「会话摘要」**（active/project，`meta parent:T-0436=T-0424`）追加一条指针句（`memory-store.mjs#1498-1508`）⇒ 搜「子代理对话摘要」仍能命中该指针；`memory_read T-0436` 可读全文（`readTopic` 无状态过滤，`memory-store.mjs#1278-1316`）；`_export` 快照仍导出全文（`exportMd#2375-2387` 无状态过滤） | 指针 + `memory_read` + 导出三路保底；**T-0436 的 id 必须写进 README/CHANGELOG/退役记录**，否则用户不知道去 read 哪个 id |
| B4 | **`sessions/` 导出视图是否要清理** | 实测 `~/.dsh/memory/sessions/`：78 个 md（53 个 0 字节=已轮转）+ `archive/` 61 个；**0 处**命中「子代理对话」⇒ **无依赖、无需清理** | 不动 |
| B5 | **`knowledge/` 10 个 `MEMORY-子代理对话-*.md`** | 这些是 md 通道的遗留产物（211KB，最后写于 2026-10-29 23:29，topicdb 上线后已停增）；且 **T-0103(58 句)/T-0468(155 句) 的 `src` 正指向这些文件**（DB 实测） | **不要删**：删了会在 `memory_read` 的 `⟪src⟫` 与指针闭合闸里留下 213 处悬空指针。清理需先清 `src`，属独立改动 |
| B6 | **归档动作本身会不会失败** | 已核：T-0436 **无子主题**（`parent:T-* = T-0436` 计数 0）⇒ 不会 `TOPIC_HAS_CHILDREN`；`needs_review → archived` 合法（`lifecycle.mjs#29`）；父 T-0424 存在 ⇒ 指针句会写入；重复归档幂等（`alreadyArchived`，`memory-store.mjs#1487-1489`） | 直接执行；但**归档不可逆**（见 F5），建议分两步 |
| B7 | **部署窗口有 backfill 在跑** | 旧进程的 backfill 循环（≤2000 轮）随宿主重启终止；已写部分保留，账本进度不落盘 ⇒ 重启后重扫，幂等 | 部署前确认无 `回填进度` 日志在滚；或在低峰执行 |
| B8 | **zstd 不可用** | 启动横幅明确写"子代理摘要通道将跳过（其解析依赖 zstd 解码）"（`#20356`） | 退役后**该横幅文案必须改**，否则误导用户以为还有个通道在跑 |
| B9 | **启动横幅命令清单** | `#20364` 列出 `/subagents-archive 已挂载` | stub 保留则文案可改可不改；建议改为「`/subagents-archive`（已下线，仅提示）」 |

---

## 4. 观测门（skill 强制项）

### 4.1 G-0 先观测后实现 —— **通过（含 2 处校正）**

| 方案书断言 | 审计实测 | 判定 |
|---|---|---|
| T-0436 128 句 / 12.5 万字 | DB readOnly：`count=128, sum(chars)=126411`（首句 2026-10-30T02:27:59Z，末句 2026-11-05T06:06:42Z） | ✅ 完全吻合 |
| 日增 8~47 句 | 按写入日：10-30 **24**、11-01 **8**、11-02 **47**、11-03 **9**、11-04 **15**、11-05 **25**（至 14:06） | ✅ 完全吻合（8~47 是真实包络） |
| pending=449 | 实测 **407**（裸 GUID 585 − 账本内 139 − 未满 1 天 39） | ⚠️ 校正：现测 407；449 无法在现有目录数下复现（585 总数上限排除 449+139=588） |
| 再涨 ~22 万字 | 单块均值 **988 字** ⇒ 407×988 = **401,947 字 ≈40.2 万字**（449 则 44.3 万） | ⚠️ 校正：**低估约 1.8×**；终态 ≈52.8 万字 = 4 万上限的 **13.2 倍** |
| 通道仍在跑 | 今日 10:00 n7/7308 字、12:00 n9/8364 字、14:00 n9/8953 字（= 每小时 tick 实测落库）；审计期间 DB mtime 14:04→14:06 仍在变 | ✅ 活的 |
| MiMo 无对应机制 | 本机无 MiMo 源码/文档，**未能独立验证**（仅依据用户拍板与库内决策记录 `T-0558` 第 5 句） | ⚠️ 外部事实，如实记录 |

**结论**：证据足以支撑「退役」而非「改造」。改造（按天分主题/自动 split）需要把 40 万字切成 **≥13 个分片主题**并长期治理生命周期，成本远高于收益，且 MiMo 侧无对应机制可对齐；而原文检索路径已实测可达（§5）。

### 4.2 G-3 删除型改动的能力可达性证明 → **见 §5（独立一节）**

### 4.3 G-9 产出物判据

| 产出物 | 现状（实测） | 退役后 | 可执行判据 & 期望 |
|---|---|---|---|
| `knowledge/MEMORY-子代理对话-*.md` | 10 个文件 / 211KB，最后写 **2026-10-29 23:29**（topicdb 上线后 md 通道已停写，只剩"库不可用回落"这一潜在写点） | **彻底停止增长**（回落写点随 batch 不可达而消失） | `(Get-ChildItem "$env:USERPROFILE\.dsh\memory\knowledge" -Filter "MEMORY-子代理对话-*.md").Count` → 期望 **10（不变）**；最新 LastWriteTime 不再前进 |
| 库内 T-0436 | 128 句 / 126,411 字，`state=needs_review` | 冻结（归档后不再 append） | `node -e` 查 `select count(*),sum(chars) from sentences where topic_id='T-0436'` → 期望 **128 / 126411 不变** |
| `_export/<date>/memory-export-*.md` | 每天 10~19 个文件、67~130MB（11-05 至 14:00 已 2 个 /14.3MB）；最新快照第 44218 行 `## 子代理对话摘要  T-0436 · needs_review` | **字节不减**（`exportMd` 不排除 archived ⇒ 全文继续导出，仅状态标签变 `archived` + 多一条指针句）；**但不再有摘要导致的增量与触发** | `Select-String -Path <最新 export> -Pattern "## 子代理对话摘要"` → 期望仍命中 1 行且状态为 `archived`；文件数/日不再因摘要增加 |
| `sessions/` 导出视图 | 78+61 个文件，**0 处**引用子代理对话 | 无变化 | `Select-String -Path "$env:USERPROFILE\.dsh\memory\sessions\*" -Pattern "子代理对话"` → 期望 0 |
| `.integrate.json` | `archivedSessions=1241`（含 139 个子代理 sid）；**无 `subagentArchive` 键** ⇒ 自动通道当前=开 | 键保留、不再增长 | 观察 7 天：`archivedSessions` 长度不再增加 |

### 4.4 G-9.2 反面问题：这项改动可能怎样让现有功能失效（≥3 条，实列 9 条）

1. **真实记忆被一起埋掉（高）**：T-0436 第 103 句（sentence id=**33363**，391 字，`src=topic:T-0436`）不是摘要块，而是一条真实结论：「剪贴板同步 Android 分享上传·诊断+修复设计独立审核 v3 通过……」。归档后它随主题一起退出 `memory_search` 视野。→ F1。
2. **残留调用"复活"新主题（高）**：`digestBlocksToDb#6035` 的 finder 排除 archived ⇒ 归档后任何一次 `runSubagentDigestBatch`/`__p5Hooks.digest` 真库调用都会 `seedTopic` 出**同名新主题**，噪音从零重新长起来。→ F3。
3. **用户依赖 `/subagents-archive`（中）**：直接删注册 ⇒ "未知命令"，用户无从得知替代路径；且 `COMPAT` 计数门与 smoke 测试变红。→ F2。
4. **原文检索的可用前提被高估（中）**：`session_search` 依赖 ①会话日志仍在 ②索引缓存已建。日志清理策略未文档化（`.dsh` 无 `config.json`；本机 1113 个会话目录**全部有日志**，无清理痕迹，但无法证明宿主永不清理）；索引最坏滞后 ~1h，硬失败还有 24h 退避（`#17326-17330`）。→ 记录。
5. **聚合视图能力消失（中，体验降级非能力丢失）**：T-0436 提供"一个主题浏览 128 条子代理结论"的跨会话聚合；退役后要逐条 `session_search`。MiMo 亦无此视图，且聚合正是噪音源 ⇒ 接受并记录。
6. **面板出现死旋钮（中）**：`staleSessionDays` 失去唯一生产读者，`client.js` 的"子代理摘要窗口"控件变摆设，且与今天刚做的 `M1` 修复理由直接冲突。→ R2。
7. **文档/横幅误导（低）**：`#20356`（"子代理摘要通道将跳过"）、`#20364`（命令清单）、`README.md#189`、`CHANGELOG` 均需同步。
8. **门/测试变红（低，若按原方案）**：`_verify/topicdb-compat-check.mjs#86/#147`、`test/plugin.smoke.test.mjs#105`、`_verify/topicdb-p5-check.mjs#127-146`、`_run-suite.mjs` 自动发现的 `_test-subagent-digest.mjs`。→ F2/F3。
9. **内容只在 tool_output 里的子代理（低，等价）**：CLI 明确不收 tool_output（`session-search.mjs#155` 注释），但摘要也只取 `user/message`+`assistant/message`（`#5961/#5974`）⇒ 口径等价，不算回归。

---

## 5. ★ G-3 能力可达性证明（本审计最重要的一节）

### 5.1 被删通道服务的能力是什么

**能力定义**：事后**回溯/检索子代理会话的「任务 + 结论」**，用于回答"某个子代理当时干了什么、结论是什么"。它服务三个具体用途：
① 用户/模型事后找回某次子代理分析的结论（如前端审计报告、批次质量判定）；
② 跨会话浏览近期子代理产出（聚合视图）；
③ 作为"子代理结论"进入记忆库的沉淀通道。

### 5.2 该能力的所有调用路径（现状）

| 路径 | 载体 | 覆盖 | 证据 |
|---|---|---|---|
| P1 **会话原文检索（工具）** | `session_search` 工具 `#17374-17597` → 子进程 CLI `~/.dsh/tools/session-search/session-search.mjs` | **全部**子代理会话（含未摘要的） | 工具注册 `#17597`；CLI 路径解析 `#17264-17271` |
| P2 **会话原文检索（命令）** | `/session-search` `#20262-20297` → 同一 CLI | 同上 | 复用 `SESSION_SEARCH_EXEC#17596` |
| P3 **摘要主题（本通道）** | `memory_search` / `memory_read` 命中 T-0436 | 仅 127/585（21.7%） | DB 实测 127 digest 块 + 127 条 `digest:*` meta |
| P4 **原始日志直读** | `~/.dsh/sessions/<工作目录>/<裸GUID>/session*.jsonl.zstd` | 全部（585/585 目录均有日志） | 文件系统实测 |
| P5 **导出快照** | `_export/<date>/memory-export-*.md` 含 T-0436 全文 | 已摘要的 127 条 | 最新快照第 44218 行 |
| P6 **归档单元** | `--source units`（`.archive-units`，724 sids / 61 天） | 历史归档过的会话 | `--status` 实测；CLI `#748` |

### 5.3 删除后，该能力在哪些输入形态下**仍然可达**（逐格）

| 输入形态 | 退役后可达？ | 依据（实测/代码） |
|---|---|---|
| 子代理会话**未被摘要**（pending 407 / 未来全部新会话） | ✅ 可达（本来就只有原文路径） | CLI `walkLogs` **递归遍历所有目录、不按前缀过滤**（`session-search.mjs#172-185`）；`sidOfPath` 显式支持裸 GUID（`#188`：`startsWith("session-") ? slice(8) : d`）；`cmdBuild` 全量遍历、无日期窗口（`#421-445`） |
| 子代理会话**已被摘要**（127 个） | ✅ 可达（实测） | 见 5.4 命令 ②③：`3c45c464`/`51ee51ff` 的 user+assistant 原句均可搜到 |
| **插件自身**子代理（`dsh-memory-*`） | ✅ 可达（从未进摘要，被排除 `#5965`） | 同上 |
| **结论很薄**的子代理（<200 字且 <60KB，摘要本来跳过 `#6076`） | ✅ 可达（摘要从未覆盖） | 同上 |
| 会话**日志被宿主清理/轮转** | ⚠️ 不可达（当前无清理证据：1113 目录全部有日志；但无保留策略承诺） | 文件系统实测；`.dsh` 无 `config.json` |
| **索引未建/被清**（新机器、缓存删除） | ⚠️ 暂时不可达，`--build` 后可达；最坏滞后 ~1h（`#19977` 每小时刷新），硬失败退避 24h（`#17326-17330`） | `--status` 实测：85 天 / 2783 sid / 909.5MB |
| 内容**只存在于 tool_output** | ⚠️ 不可搜（CLI 不收 tool output，`#155`）；但摘要同样不收 ⇒ 口径等价 | 代码 |
| 会话**早于索引覆盖期**（2026-08-13 之前） | ⚠️ 需 `--build`；本机现存最老子代理会话 **2026-08-31 16:46** ⇒ 当前**全覆盖** | 文件系统实测 |

### 5.4 可执行验证命令 + 期望结果（全部已在本机实测通过，14:2x）

```powershell
# ① 索引覆盖（证明子代理会话被纳入索引）
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" --status
# 期望：days=85、sids=2783、bytes≈9.3e8；units 724/61 天 —— 实测吻合

# ② 未摘要子代理（pending 之一 d3960a00）的任务原句
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "后台也要演示" --sid d3960a00 --json --limit 3
# 期望：total>=1、rows[].sid="d3960a00"、k="user/message"、src="session.v4.jsonl.zstd"
# 实测：total=2 ✅（该 sid 正是 pending 列表里的裸 GUID 目录）

# ③ 已摘要子代理（3c45c464，T-0436 里有它的摘要）—— 任务 + 结论双命中
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "结构性冗余" --sid 3c45c464 --json --limit 3
# 期望：≥2 行，且至少 1 行 k="assistant/message"
# 实测：total=2，user/message(line1 任务) + assistant/message(line48 结论「已完成全部只读核对。以下是结构性冗余/死代码审计报告…」) ✅
#       ↑ 这一行与 T-0436 该会话摘要的「结论：」逐字同源 ⇒ 摘要删掉不丢信息

# ④ 另一已摘要会话（51ee51ff）
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "脆弱写法" --sid 51ee51ff --json --limit 3
# 实测：total=1 ✅

# ⑤ 2026-09-03 两个老会话（T-0436 最早的 12 条之一）
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "前端代码审计员" --since 2026-09-03 --until 2026-09-03 --json --limit 5
# 实测：total=5，sid=3c45c464 / 51ee51ff / 7ecb2f62 / cfb4a6a4 … ✅（`--since/--until` 按"归属日"过滤，跨天会话有专门提示 `#487`）
```

### 5.5 覆盖率结论

- 摘要通道覆盖：**127 / 585 = 21.7%**（且只覆盖"尾帧结论 ≥200 字或日志 ≥60KB"的会话，薄会话被跳过）。
- 原文检索覆盖：**585 / 585 = 100%**（现存全部裸 GUID 会话都有日志；索引缓存 85 天覆盖最早会话 08-31）。
- ⇒ **退役不是"能力被删"，而是"唯一覆盖 21.7% 的冗余副本被删，100% 覆盖的原文路径保留"**。方案书要求的"能力可达性证明"**成立**。
- 唯一真实损失是**形态降级**：从"已提炼的任务+结论直接可读 + 跨会话聚合视图"退化为"原文片段检索（需人读/需多次检索）"。这与 MiMo 对齐、且聚合视图本身正是失控源（40 万字 pending 的成因）⇒ **可接受**。

---

## 6. 方案对比（≥2 个替代 + 推荐）

| 方案 | 内容 | diff 规模 | 门/测试 | 可回滚 | 风险 | 评价 |
|---|---|---|---|---|---|---|
| **A 原方案全删** | 删 2 调用点 + 删命令 + 删 `COMPAT_COMMAND_NAMES` 登记 + 删产出端 + 归档 T-0436 | 大（含 3+ 测试/门文件） | ❌ 两难必红其一轮：**删命令但保留登记** ⇒ `topicdb-compat-check#86`（registered==expected，6≠7）红；**连登记一起删** ⇒ `#147`（expected===7 硬编码）红。另 `plugin.smoke.test.mjs#105` 红（除非同批改测试） | 中（代码可回，归档不可逆） | **高** | 不推荐 |
| **B（推荐）停写 + 命令降级 stub + 保留纯函数** | ①删 `#15810` 与 `#19970-19973` 两个调用块 ②`/subagents-archive` handler 改为**下线提示 stub**（保留注册、`input.hint` 改为"已下线"、不再调用 batch/backfill）③保留 `subagentDigestOf/Block/ListDirs/Batch`、`digestBlocksToDb`、`SUBAGENT_DIGEST_*`、`__p5Hooks.digest` ④归档 T-0436（先迁出 F1 的真实记忆）⑤文档/横幅更新 | **≈20–30 行** | ✅ 全部既有门可保持绿（smoke 仍见命令；C01/C03 计数不变；`_test-subagent-digest` 仍绿） | 代码：恢复 2 个调用点即回滚 | **低** | ✅ **推荐**：最小风险、可回滚、用户有明确下线提示 |
| **C 只停 tick、保留手动命令** | 只删 2 调用点，命令仍可手动灌库 | ≈8 行 | ✅ | ✅ | 最低，但**不解决根因**：用户/旧习惯仍可手动把 40 万字 pending 灌进 T-0436；T-0436 仍会增长 | 作为 B 的**灰度第 1 步**可接受（B 已包含）；单独采用不推荐 |
| **D 按天分主题继续摘要（改造）** | 每天一个主题/或自动 split 到明细主题 | 大（新分片治理 + 生命周期） | 需新门 | 中 | 中高 | ❌ 不推荐：40 万字要切 ≥13 个分片主题并长期治理；G-0 证据显示成本 >> 收益；MiMo 无对应机制 |
| **E 彻底删纯函数 + 测试** | A + 删 4 个导出 + 删 `_test-subagent-digest.mjs` + 改 P5 门 | 大 | 需同步改 2 个 verify 门 + smoke | 低 | 中 | ❌ 本批不做；**留到下个版本**（先让"停写"稳定，再清死代码，符合"一次只装一个行为改动" G-5） |

**推荐：B。** 理由：①停写用"删调用点"而非运行时开关 ⇒ 无状态可漂移、重启即生效；②命令保留为 stub ⇒ 用户有明确下线提示、`COMPAT` 计数与 smoke 门零改动；③保留纯函数/导出 ⇒ 现有 4 个门/测试零改动、回滚只需恢复 2 个调用点；④归档作为**独立最后一步**，且不可逆（F5）⇒ 先观察再归档。

---

## 7. 护栏清单（实现必须逐条落实）

| # | 护栏 | 落点 |
|---|---|---|
| G1 | **停写一次性、无开关**：直接删两个调用块（`#15807-15810` 与 `#19970-19973`），不引入 `if(retired)` 运行时开关 | `index.js#15807/#19970` |
| G2 | **归档前先迁出 F1 的真实记忆**：把 sentence id=33363 的正文 `memory_write append` 到 **T-0428「剪贴板与效率工具」（active）**（备选 T-0375）；**保留 T-0436 内原句**（归档不删正文，双份最安全） | 一次性操作 |
| G3 | **复活防护**：`digestBlocksToDb` 入口加哨兵——若 finder 未命中但存在 archived 的「子代理对话摘要」主题 ⇒ 直接 `return {ok:false, why:"retired"}`（≈3 行）；或至少 CHANGELOG 明示 `__p5Hooks.digest` 只许 fixture | `index.js#6029-6040` |
| G4 | **命令下线提示**：stub 返回 `kind:"success"`，文案含 ①退役日期与依据 ②`session_search <关键词> [--sid 前缀]` 用法 ③`memory_read T-0436` 读回 ④pending 数（407，只报不处理） | `index.js#20320-20344` |
| G5 | **日志带值**：停写后首启打一行 `subagent-digest RETIRED at=<iso> pending=407 archived_topic=T-0436`（只打一次，进 `.monitor.json` 亦可） | `#20356` 附近 |
| G6 | **失败不影响主流程**：stub handler 全程 try/catch 返回 success；删除的两处 try/catch 直接删除（不留空 catch） | `#20324` |
| G7 | **数据前置校验**：归档前 `assert 0 children`、`assert parent=T-0424 存在`、`assert state=needs_review`；归档后 `assert state=archived` + `assert pointerSentenceId != null` | 一次性操作 |
| G8 | **不可逆的处置**：T-0436 归档**放到观察期之后**（建议停写稳定 ≥3 天再归档）；归档 id/时间写入 `README.md`、`docs/CHANGELOG.md`、`.integrate.json` 不需改 | 流程 |
| G9 | **文档/横幅同步**：`README.md#189` 命令表、`docs/CHANGELOG.md`（新增 v4.0.2 条目）、`index.js#20356`（zstd 横幅）、`#20364`（就绪横幅） | 4 处 |
| G10 | **门禁全绿**：`node _run-suite.mjs`（含 `_test-subagent-digest.mjs`）+ `node test/plugin.smoke.test.mjs` + `node _verify/topicdb-compat-check.mjs` + `node _verify/topicdb-p5-check.mjs` 全 PASS；建议新增一条源码断言："生产路径不再出现 `runSubagentDigestTick(` 调用" | 门 |
| G11 | **stub 保留期**：命令 stub 至少保留 **2 周/1 个版本**，下个版本再连同纯函数一起删（届时同步改 2 个 verify 门 + smoke） | 流程 |
| G12 | **pending 处置记录**：在 CHANGELOG 明写"407 个存量候选**不回填**，理由：原文可检索 + 回填将复活新主题/超明细上限 13.2×" | 文档 |

---

## 8. 影响面结论（逐项回答）

| 面 | 是否波及 | 结论与证据 |
|---|---|---|
| ① **核心功能**（记忆读写 / 检查点 / 压缩重灌） | **否** | 三条主链均不读 T-0436 / digest 函数：记忆读写走 `memory_read/memory_write`（`#11554-11590`）；检查点走 `spawnIntentCheckpoint`/`latestSessionSummary`（`#1691-1704` 钩子容器）；压缩重灌走 `agent/pre-step` 拦截链（`#16247+`）。删的两处只是独立 `try/catch` 块 |
| ② **相关子系统** | **正向/无影响** | `dream` 候选：T-0436 归档后从「超限健康」候选里消失（`listOverLimitTopicsFromDb#3608` 排除 archived；health 行生成 `#3880-3901`）⇒ `progress.health` 里那条「T-0436 已达 101786 字符…建议 splitTopic」告警消失（正向）；同时从**待审队列**消失（`listReviewQueueFromDb#3632` 只取 `state==="needs_review"`）⇒ 每会话 1 行待审提醒与 dream 待审裁决条目不再出现（正向）；**精确字面量索引**：不读摘要（字面量主题 `#430`）⇒ 无影响；**会话日志扫描**：少一个每小时扫描者（正向），`session_search` 的每小时索引刷新仍在 `#19977`；**`session_search`**：无影响（能力面见 §5） |
| ③ **性能** | **正向（量级已测）** | 每小时少：①`readdir` 27 工作区 × 1113 目录 + 585 次 `statSync`（`#6003-6027`）；②最多 16 个会话的**同步整文件读+逐帧解压**（实测单个最大 9.6MB，注释称可达 28.6MB）；③T-0436 append + 触发一次全库导出（7.5MB/次，30min 节流）。实测 `_export` 每天 10~19 个文件 / 67~130MB，摘要只是触发源之一（**占比未单独归因**，见 §10） |
| ④ **启动** | **否** | 无启动期调用；唯一"近启动"挂点在首个顶层会话的 `agent/created` 注入链（`#16225-16227`），每实例最多一次，且删除后启动更快。启动横幅文案需改（G9） |
| ⑤ **数据一致性** | **是（可控）** | T-0436：`needs_review → archived`（合法）+ `topic.state` 审计 + `archive.pointer:T-0436` meta + 指针句写入 T-0424；**归档不可逆**（F5）。`_export` 快照仍含全文（字节不减，仅状态标签+指针）。`digest:*` 127 条 meta、`archivedSessions` 1241 条保留为惰性数据（无害）。`knowledge/` 10 个 md 保留（R3）。**T-0103/T-0468 两块摘要内容仍在**（18.5 万字，R4） |

---

## 9. 必须修的 findings（阻塞合入）

| ID | 级别 | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| **F1** | **高** | T-0436 里混着 1 条非摘要的真实记忆（Android 剪贴板分享上传 v3 审核结论），归档会把它一起退出 `memory_search` | DB `sentences.id=33363, topic=T-0436, ord=103, chars=391, src=topic:T-0436`；127 条 `digest:*` meta 只对应 127 个摘要块，第 128 句无 meta | 归档前 `memory_write append` 到 T-0428「剪贴板与效率工具」（备选 T-0375），保留原句 |
| **F2** | **高** | 按原方案删命令会陷入两难：**保留 `COMPAT_COMMAND_NAMES` 登记** ⇒ `#86` 的 `registered===expected` 红（6≠7）；**连登记一起删** ⇒ `#147` 的 `expected===7` 硬编码红。两种做法都会打红一个既有门，且删掉命令就失去唯一的"已下线"提示位（`test/plugin.smoke.test.mjs#105` 也需同批改） | `_verify/topicdb-compat-check.mjs#86-87`、`#147`；`test/plugin.smoke.test.mjs#105`；`index.js#5078-5079` | 改方案 B：命令降级为 stub、`COMPAT_COMMAND_NAMES` **不动** ⇒ 两门均绿、smoke 零改动 |
| **F3** | **高** | 归档后残留调用会"复活"一个全新的同名「子代理对话摘要」主题 | `index.js#6035`（finder 过滤 `state!=="archived"`）→ `#6037 seedTopic`；可达入口：`__p5Hooks.digest#13433`、导出的 `runSubagentDigestBatch#6198` | ①停写（G1）②stub 不调 batch ③`digestBlocksToDb` 加 archived 哨兵（G3） |
| **F5** | **中高** | **归档不可逆**：`TRANSITIONS.archived=[]`（`lifecycle.mjs#30`），无公开 restore；仅内部 `_restoreState#1988`（供 merge/tree undo 用） | `lifecycle.mjs#25-31`；`memory-store.mjs#1987-1997`（无工具暴露） | 分两步：先停写观察 ≥3 天，再归档；T-0436 id 写入文档（G8） |

## 10. 可接受但需记录（低 / 需决策）

| ID | 事项 | 记录 |
|---|---|---|
| R1 | **pending 407 丢弃不回填** | 依据：原文 100% 可检索（§5）+ 回填 40.2 万字 = 明细上限 13.2× + 归档后回填会复活新主题（F3）。CHANGELOG 写明（G12） |
| R2 | **`staleSessionDays` 变死旋钮** | 唯一生产读者 `#6061/#6117/#20337` 随退役消失；`client/lib/client.js#21/#69/#84/#123` 的"子代理摘要窗口"控件失去作用，与今天 `M1` 修复理由冲突（`panel-followup_AUDIT#249-251`）。本批**不改 client.js**（避免跨文件扩大 diff），但必须记录；下一版随面板清理一并删除或改标注 |
| R3 | **knowledge/ 10 个遗留 md 不删** | T-0103/T-0468 共 213 句的 `src` 指向它们（DB 实测），删除会造成悬空指针；文件已停增（最后写 2026-10-29 23:29） |
| R4 | **T-0103(58句/19,024字,draft) + T-0468(155句/39,453字,active) 仍是摘要内容** | 两块合计 18.5 万字；只归档 T-0436 只消掉 68% 摘要足迹，`memory_search` 仍可能命中这两块。建议**同批或紧随其后**归档（T-0468 是 split 产物、active；T-0103 draft 含拆指针句），否则"降噪"目标只达成一部分 |
| R5 | **`.integrate.json` 惰性键保留** | `archivedSessions=1241`、`digest:*` 127 条 meta、`archive.pointer:T-0436` meta 均保留（不读不删），与 2026-11-04 归档链删除的处置一致（`index.js#1652-1654`） |
| R6 | **`_export` 快照字节不减** | `exportMd#2375-2387` 不排除 archived ⇒ T-0436 全文（12.6 万字）继续出现在每天 10~19 个 7.5MB 快照里。这是"归档=从检索面移除、不是从磁盘移除"的既定语义，接受 |
| R7 | **保留的纯函数/常量是"不可达死代码"** | `subagentDigestOf/Block/ListDirs/Batch` + `digestBlocksToDb` + `SUBAGENT_DIGEST_*` + `__p5Hooks.digest` 保留（防回归/门用）。下版本再删（方案 E），届时同步改 2 个 verify 门 + smoke |
| R8 | **命令 stub 保留期 ≥2 周/1 版本** | 见 G11 |
| R9 | **多实例/36 分钟间隔** | 今日 `created_at` 出现 02:16→02:52 UTC（36min）< 1h 节流；推断为进程重启或多实例各持内存节流。停写后消失，仅记录 |

---

## 11. 诚实记录：本审计**未能验证**的部分

1. **MiMo-Code 是否真无对应机制**：本机无 MiMo 源码/文档，未联网核对；仅依据用户拍板与库内决策记录 `T-0558` 第 5 句。
2. **宿主对 `~/.dsh/sessions/` 是否有保留/清理策略**：`.dsh` 下无 `config.json`；实测 1113 个会话目录**全部有日志**（无"目录在、日志没了"的清理痕迹）。但 2026-10-20 代码注释称曾有 **1699 个裸 GUID 目录**（`index.js#5902`），今日实测仅 **585** —— 差异原因未查明（可能当时口径不同/跨 profile），**不能据此断言宿主会清理**，也不能断言永不清理。
3. **索引新鲜度**：`session_search` 索引为小时级刷新（`#19977`），实测状态为 14:2x；无法保证退役后每次检索即时可见（最坏滞后 ~1h；硬失败 24h 退避）。
4. **摘要对 `_export` 写入量的贡献占比**：只测到总量（10~19 文件/天、67~130MB/天），未做归因。
5. **未在真实库上执行归档**（只读约束）：指针句写入 T-0424、`memory_search` 不再返回 T-0436 —— 均依据代码路径判断（`#7291`、`memory-store.mjs#1498-1508`），未实测。
6. **未实测多实例并发**（36min 间隔仅推断）。
7. **未验证"归档后 `memory_search` 确实 0 命中 T-0436"**：受只读约束无法改状态；依据 `#7291` 代码。
8. **未测 `_verify/topicdb-p5-check.mjs` 在"停写+保留 digestBlocksToDb"下的完整回归**（该门写临时库，预期仍绿，但未执行）。

---

## 附录 A · 审计使用的证据命令（可复现）

```powershell
# 基线一致性（仓库 vs 部署副本）
Get-FileHash "E:\工具\插件开发调整\dsh-memory-plugin\index.js" -Algorithm SHA256   # 2BAE1065…；部署副本同值

# T-0436 现状（readOnly；node:sqlite）
#   select count(*),sum(chars) from sentences where topic_id='T-0436'      → 128 / 126411
#   select state,parent? from meta                                          → needs_review / parent:T-0436=T-0424
#   按写入日分布 → 10-30:24, 11-01:8, 11-02:47, 11-03:9, 11-04:15, 11-05:25
#   select id from sentences where topic_id='T-0436' and body not like '## %' → id=33363（真实记忆）

# 子代理会话规模 / pending
#   ~/.dsh/sessions：27 工作区、1113 目录（528 session- + 585 裸 GUID），全部有日志
#   pending = 546(>1天) − 139(账本内) = 407；账本 archivedSessions=1241

# 原文检索能力（§5.4 四条命令，均已实测通过）
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" --status
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "后台也要演示" --sid d3960a00 --json --limit 3
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "结构性冗余" --sid 3c45c464 --json --limit 3
node "$env:USERPROFILE\.dsh\tools\session-search\session-search.mjs" "前端代码审计员" --since 2026-09-03 --until 2026-09-03 --json --limit 5

# 导出视图
#   _export/<date>/memory-export-*.md：11-05 2 个/14.3MB、11-04 13 个/92.7MB、11-03 17 个/120.5MB
#   最新快照第 44218 行：`## 子代理对话摘要  T-0436 · needs_review`
#   sessions/：78 md（53 个 0 字节）+ archive/ 61 个；0 处命中「子代理对话」
#   knowledge/：297 文件/5.3MB；MEMORY-子代理对话-*.md 10 个/211KB，最后写 2026-10-29 23:29
```

## 附录 B · 关键行号索引（退役前基线，20481 行 / sha 2BAE1065）

| 主题 | 行号 |
|---|---|
| 摘要通道定义区 | `#5898-5920`（常量）、`#5941-5983`（digestOf）、`#5989-6002`（rel/header/block）、`#6003-6027`（listDirs） |
| 库内写入口 | `#6029-6055`（`digestBlocksToDb`；archived 过滤在 `#6035`，seed 在 `#6037`） |
| 批处理 | `#6057-6106`（`staleSessionDays` `#6061`；账本过滤 `#6065`；写库 `#6089`；落账本 `#6103`） |
| tick / backfill / 节流 | `#6107-6125`（`SUBAGENT_DIGEST_LAST_AT#6107`、`#6112-6125`）、`#6127-6147` |
| 导出 | `#6198`、`#6201-6205` |
| 账本 | `#1650`、`#1657-1671`、`#1676-1684` |
| 择父（真读 workspace.json） | `#6277-6300`、`#12227-12231` |
| 命令 | `#20320-20344`；`COMPAT_COMMAND_NAMES#5078`；横幅 `#20356`、`#20364` |
| 两个调用点 | `#15807-15810`（`injectMaintenanceReminder` 内）、`#19970-19973`（每小时 tick） |
| 调用者闸门 | `#16225-16227`（每实例一次）、`#19954-19980`（interval） |
| 检索工具/CLI | `#17374-17597`、`#17264-17271`；CLI `~/.dsh/tools/session-search/session-search.mjs#172-185/#188/#421-445` |
| 归档/读回/导出语义 | `#7291`（archived 不进检索）、`memory-store.mjs#1278-1316`（readTopic 无过滤）、`#1478-1510`（archiveTopic）、`#2375-2387`（exportMd） |
| 状态迁移表 | `lifecycle.mjs#25-31`（`archived: []`） |
| 门/测试 | `test/plugin.smoke.test.mjs#105`、`_test-subagent-digest.mjs#36/#103-167`、`_verify/topicdb-compat-check.mjs#86/#147`、`_verify/topicdb-p5-check.mjs#127-146`、`_run-suite.mjs#50-53` |
