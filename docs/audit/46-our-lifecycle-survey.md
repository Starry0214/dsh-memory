# 46 · dsh-memory「笔记 → dream → 长期库」全链路现状梳理（只读调研）

- **对象**：`dsh-memory-plugin/index.js`（read 工具计 **20609 行**，2026-11-06 08:40）+ `memtopic/src/*` + 真机库 `C:\Users\Starry\.dsh\memory\.memtopic\mem.db`（只读 SQL）
- **证据格式**：`index.js#行号` / `memory-store.mjs#行号` / `lifecycle.mjs#行号` / `governance.mjs#行号` / `SQL 结果`；**推断**=静态比对得出未运行验证
- **纪律**：未改任何代码；仅只读 SQL 与 `node --check` 级静态阅读

## 1. 结论摘要（≤300 字）

`memory_note` 是**主 agent 唯一写入口**（工具面只有 append，同文本 `endsWith` 去重，单条 ≤2000 字），落点 `笔记·<wsKey>/<sid8>`：**孤儿主题（无 parent）、state=active、不进归档阶梯**（`ARCHIVABLE_STATES` 不含 active）。但它**会**进注册表切片注入、会进 `memory_search`、会在压缩后重灌第 4 段被尾部注入 ≤1900 字。dream 任务书把笔记列为主职责（最多 10 个，七类映射），提炼后只追加「已提炼 → T-xxxx」**不删正文**——代码里**没有任何「按 marker 过滤」或「按 id 删」**：dream 只能按**整句文本**删（`delete` selector=`content`），且实际已发生 1 次 marker 删除。真机 12 个笔记主题 / 113 句 / 11 条 marker / **未提炼 102 句**（最大主题 67 句、66 句未提炼），且 T-0558 有 2 条重复 marker。改造可行：`deleteSentence` 支持 `sentenceId`（store 层已实现，权限只要 `write`），但 `memory_read` **不返回 id**、`memory_dream_patch` **无 sentenceId 字段**，需同时扩这两处。

## 2. 全链路图

```
主 agent ──memory_note(append-only, ≤2000字)──▶ 主题「笔记·<wsKey>/<sid8>」
   │  （tools 只在 TOPICDB.enabled 时注册 #18313-18319；子代理被 SUBAGENT_SKIP #17993）
   │  主题：seedTopic(actor=plugin) #18019 → setState(active,runtime) #18024
   │  无 parent（不 linkParent）⇒ 面板/记忆树「未归类」；triggers=[sid8,wsKey]
   │
   ├─① 会话启动注入：topicDbRegistrySlice（active/draft/needs_review/dormant，updatedAt 前 12）#7435-7450 / #11498-11527
   ├─② 压缩后重灌第④段：本会话笔记主题，尾部优先 ≤1900 字 #14761-14793
   ├─③ memory_search：主题检索不排除笔记（只排除 archived）#7379-7381；命中记 markHit #7404-7405
   ├─④ 15% 档位提醒 + 压缩后提醒（催记 note）#1861-1923 / #4996-5005 / #17175-17182
   │
   └─⑤ /dream（手动 #20127-20139）或 checkIntegrate（启动+每小时 #20084-20117）
         └─ buildDreamPromptLibrary：笔记优先候选（≤10）+ 其他活跃补足 20 #3771-3788
            └─「会话笔记提炼」块 #3806-3832（七类映射；提炼完 append「已提炼 → T-xxxx」#3829；**未要求删**）
               └─ memory_dream_patch（仅 dream 子代理可调 #16967-16976）
                  └─ applyPatches 校验 #12598-12708 → applyDreamPatchesToDb #12448-12594
                     └─ 目标长期主题 appendSentence（actor=runtime）；delete 仅按整句文本 #12493-12496

检查点支线（与笔记是两套主题，不互读）：
  压缩 T4 #17194 / T1-T3 阈值 #19926 / T5 收尾 #19969 → spawnIntentCheckpoint #14122
    → 8 节 ≤3000 字（INTENT_SECTIONS_8 #2951-2960 / INTENT_TOTAL_BUDGET=3000 #2962）
    → P2.5 会话主题 <wsKey>/<sid8>（挂 D8「会话检查点」线）#7917-8061（恒 1 句覆盖）
    → 注入：latestSessionSummary（D8 日期主题）#15145-15174 / 重灌第①段 #14662-14730
```

## 3. 逐条回答

### Q1 memory_note 写入链

| 环节 | 证据 |
|---|---|
| 工具入口/注册条件 | `index.js#17957-18042`；仅在 `TOPICDB.enabled` 时由 `topicDbRegisterTools` 注册（`#18313-18319`；函数 `#11529`） |
| 命名规则 | `#18013`：`name = "笔记·" + wsKey + "/" + sid8`；`wsKey=p25Topics.normalizeWorkspace(cwd)` `#18011`、`sid8=p25Topics.sid8Of(sid)` `#18010`；cwd 必须取 `agent.session.header.cwd`（审计 F1，`#18000-18008`） |
| 建主题 | `seedTopic({name,triggers:[sid8,wsKey],src:"note:"+sid8,actor:"plugin"})` `#18019` → 立即 `setState(id,"active",{actor:"runtime"})` `#18024`（seedTopic 初态 draft，且实测留 `review.reason=seed-near-duplicate` meta） |
| append-only 保证 | **工具面保证**：execute 只调 `store.appendSentence`（`#18035`），无 replace/delete/update 分支。**非机制保证**：主题本身未挂任何写保护；`memory_write` 的 P2.5 守卫只拦会话检查点主题（`#11746-11754`），`memory_dream_patch` 对笔记主题无守卫 ⇒ dream 可删/改（见 Q7 与真机 1 次 marker 删除） |
| 去重/相似度 | 仅**精确尾部去重**：`cur.find(s => String(s.text).trim().endsWith(text))` `#18030`，命中返回 `{duplicate:true}` `#18031`；**无相似度闸**（`SIMILAR_EXISTS` 只属 `memory_write` `#11755-11775`） |
| 内容/上限 | 单条 ≤2000 字 `#17984`；正文=`[HH:MM](kind) text` `#18032-18034`；空 text 拒 `#17983` |
| 子代理为何被拒 | `isTopLevelSession(agent)` 为假 ⇒ `SUBAGENT_SKIP` `#17993-17998`（判定函数 `#12384-12390`：`header.origin==="subagent"` 即子代理）；teammate 是独立会话（origin 非 subagent）仍可写（`#17992` 注释）；设计依据=MiMo「notes 是主 agent 唯一合法暂存区」`#17986-17992` |

### Q2 笔记主题的生命周期

| 问题 | 结论 | 证据 |
|---|---|---|
| state | **active**（12/12 真机） | 创建即 `setState active` `#18024`；SQL：`state=active c=12` |
| 会被自动归档吗 | **不会**。`ARCHIVABLE_STATES = ['draft','needs_review','dormant']`，不含 active；`planArchivable` 只遍历这三态 | `lifecycle.mjs#22`、`#142-152`；`EXPOSURE_STATES=['draft','needs_review']` `lifecycle.mjs#21`；生命周期 tick 由 `pendingReminder()→lifecycleTick()→_archiveDue` 触发（`memory-store.mjs#1709-1717`，插件会话启动注入调 `pendingReminder` `index.js#11506`） |
| 会被 markHit 续期吗 | **会记 last_hit_at，但对笔记无生命周期效果**：markHit 只更新 `lastHitAt`（不 bump updatedAt）`memory-store.mjs#1596-1607`；`isRenewed` 只看 `lastHitAt`（`lifecycle.mjs#62-67`），而 active 不在曝光/归档名单 ⇒ 续期只可观测。真机 12 个笔记主题仅 1 个 `last_hit_at` 非空（T-0560，hits meta=3） | SQL；插件接线：`markTopicHits` `#7340-7372`，search `#7404-7405`、read `#11668-11669` |
| 进注入吗 | **会**：①注册表切片候选=active/draft/needs_review/dormant 按 updatedAt 取前 12（`#7435-7450`），真机 top-12 活跃主题含 5 个笔记（SQL `recentActive`）⇒ 会占注入槽；②压缩后重灌第④段读**本会话**笔记主题（Q5）；③15% 提醒/压缩提醒催记。**不进**「最近摘要」注入（`latestSessionSummary` 只读 D8 会话检查点日期主题 `#15145-15174`） | 见左 |
| 进 memory_search 吗 | **会**：`topicDbSearchTopics` 仅跳过 archived（`#7379-7381`），笔记按名字/triggers/正文命中并返回 `⟪src⟫`（`#7408-7432`）；命中即 `markHit` `#7404-7405` | 见左 |
| 结构位置 | **孤儿主题**（`memory_note` 从不 `linkParent`）：SQL 12 个笔记 id 在 `meta.parent:*` 中 **0 命中** ⇒ 面板归「未归类」（`t.unmapped`/`unmappedItems` `#8972/#9044-9046`；`memory_topics` 层级视图同口径为**推断**，未逐行读其分组实现） | SQL `parents=[]` |

### Q3 检查点主题

| 项 | 结论/证据 |
|---|---|
| 何时写 | T4 压缩：`session/event compaction/summary` → `buildIntentInput` + `spawnIntentCheckpoint` `#17194-17205`；T1–T3 token 跨 50/75/90%：`p3SpawnThresholdCheckpoint` `#19926-19950`（spawn `#19940`）；T5 空闲 ≥30min 收尾：`p3SessionEndSweep` `#19969-19990`（spawn `#19984`）。统一写入口 `spawnIntentCheckpoint` `#14122-14254` |
| 写什么 | 8 节：本次目标 200 / 当前状态 400 / 下一步行动 200 / 关键结论 400 / 文件与代码 300 / 错误与修复 300 / 任务与待办 200 / 未决问题 200（`#2951-2960`）；`normalizeCheckpoint` 分节裁剪+删序 `#2965-3000` 区段 |
| 预算 | **总预算 3000 字**（`INTENT_TOTAL_BUDGET` `#2962`，调用 `#14179`）。⚠ 代码注释 `#14682` 写「存储端已放宽到 8000」是**失真注释**：`#2946-2950` 明确写「曾试过放大到 8000 —— 回退」，实测 p50=1316/max=2055 |
| 是否吸收笔记 | **不吸收**。`buildIntentInput(session, summaryText)` `#15042-15087` 只有四段：最近对话原文（≤6000，`#14857-14859` 注释）/任务与待办/上次检查点/宿主压缩摘要——**无笔记段** |
| 与笔记主题关系 | 两套独立主题族：检查点=P2.5 会话主题 `<wsKey>/<sid8>` 挂在 D8「会话检查点」线下（`p25WriteSessionTopic` `#7917-8061`，linkParent `#8047`），恒 1 句覆盖（`#7979-8024`，多余句删除 `#8025-8040`）；笔记=`笔记·<wsKey>/<sid8>` 孤儿。**命名冲突点**：`笔记·` 名也满足 `isSessionTopicName` 正则（见 panel-followup 文档 S1），当前靠 graph kind 判定顺序 note 优先兜住（`#9694-9698`） |

### Q4 dream 链路

| 项 | 结论/证据 |
|---|---|
| 触发 | ①手动 `/dream` 命令 `#20127-20139` → `runDreamPipeline("手动", agent)` `#19841-19890`；②自动：启动+每小时 `checkIntegrate()`（`#20084-20117` 的 `#20086/#20088`）→ 距上次满 `integrateDays` 或失败 2h 重试窗 → `runDreamPipeline("定期", null)` `#19893-19911`。默认 `integrateEnabled=false`/7 天（`#6512/#6576-6580`），但**真机 `.config.json` = integrateEnabled:true, integrateDays:1, memoryTopicDbEnabled:true** |
| 候选主题怎么选 | `buildDreamPromptLibrary` `#3753-3863`：`_live`=非 archived `#3770`；`_notePool`=名字 `^笔记·` `#3773`；`_pool`=排除索引主题+笔记+P2.5 检查点主题（`p25Topics.isSessionTopicName`）`#3777-3783`；**笔记优先**：按 updatedAt 取最多 10 个笔记 + 其他活跃补足到 20 `#3785-3788` |
| 「会话笔记提炼」块完整规则 | `#3806-3832`：列出最多 10 个笔记主题（id/名字/句数/更新时间 `#3816-3820`）；要求 `memory_read` 读 → 逐条判 durable → 七类映射 `#3821-3828`：工作风格/项目硬规则→项目主题或 global 硬纪律；跨任务可迁移事实→项目主题/global 踩坑；Bug+修复→项目主题；设计决策→项目主题；**精确字面量逐字复制**；长期引文→对应主题；不确定→**保留原处，不要删（笔记是 append-only）**；提炼完**追加**「已提炼 → <目标topicId>」（`action:"append"`）`#3829`。**注意**：代码不按 marker 过滤候选（`#3811-3819` 只按 state/name），已提炼主题仍每轮列出，靠模型自觉跳过 |
| 产出怎么落库 | 工具 `memory_dream_patch` `#18047-18115`（schema `#18052-18075`，`topic` 寻址优先 `#18062`，action=`edit|replace|append|delete` `#18063`）；校验 `applyPatches` `#12598-12708`（topic 分支 `#12637-12649`，content ≤128KB `#12646`；导出视图裸 file 整批拒 `EXPORT_VIEW_READONLY` `#12601-12631`）；写库 `applyDreamPatchesToDb` `#12448-12594`：append=appendSentence `#12478-12483`、edit=replaceSentence/append+delete `#12484-12492`、delete=**按整句 text** `#12493-12496`、replace=逐句 diff `#12497-12503`；CAS=replaceSentence/deleteSentence 的 TEXT_NOT_UNIQUE/STALE，单条 patch 冲突则**整条回滚**（undo 栈 `#12516-12584`）；整批幂等 meta `dreampatch:<sha16>` `#12457-12462`；未映射文件回落 md `#12510-12513` |
| 权限矩阵 | `governance.mjs#221-250`：`dream: {createStates:['draft'], merge:false, split:false, delete:false, setState:false, retireTrigger:false, addTrigger:true, write:true, seed:false}` `#248`；`runtime: {... delete:true, write:true}` `#247`；`plugin:{seed:true}` `#249`。插件侧闸：`memory_dream_patch` 仅 plugin 子代理（dream/归档）可调，主代理 deny `#16967-16976`；`memory_split_topic`/`memory_review_topic` 仅 dream 子代理 `#16983-16994`；actor 映射 plugin→dream `#11530-11535` |

### Q5 重灌四段

| 槽 | 预算 | 读什么/证据 |
|---|---|---|
| checkpoint | 2400 | 本会话检查点（内存 `p4cLastCheckpoint`→库 `p25ReadOwnSession`）优先，回落 `latestSessionSummary` `#14662-14730` |
| project | 1150 | cwd 命中项目的 `projects/<file>` 切片 `#14731-14748` |
| profile | 350 | `global.md` 切片 `#14749-14760` |
| **note** | **1900** | **仅本会话**笔记主题（按 `笔记·<wsKey>/<sid8>` 精确名查主题 `#14770-14771`）→ `readTopic().sentences` 取正文 → **尾部优先**累加直到 1900 `#14773-14784`；段头写明「共 N 条 / 此处只注最近 M 条」`#14786-14788`；超预算 dropped=`note:over-budget` `#14790` |
| 总预算/砍序 | body 合计 5800 + 装配头 ≈300 ⇒ 总收口 **6100** `#14602-14609`、`#14801-14808`；砍序（低→高）：**画像→项目→笔记→检查点** `#14810-14841`；每段实际字数记 monitor `#14843-14849` |

### Q6 现有统计/面板

- **stats.json**（`/dsh-memory/stats.json` `#11971-12012`）：`base=.monitor.json` + `documents` + `pendingLessons` + `live{staleCount,monitorSummary,onboardSummary,topicdb}` `#11988` + `topicdb`（`topicDbStatsSnapshot` `#8656-8700`：enabled/ready/backend/dbPath/dbSizeBytes/topics/topicsByState/main/details/unmapped/archived/effectiveTopics/nonArchivedTopics/mergedSources/mainTopics/detailTopics/sentences/physicalSentences/chars/needsReview/pendingNote/oldestPendingDays/genericTriggers/upgrade/reviewQueue/health）+ `cost` `#12002`。**无任何笔记专用字段**。
- **主面板区块**（`renderStatsPage`）：KPI A/B/C/D/E/W/BRK + 记忆查询回查率 + 记忆整合 token `#6962-6972`；看门狗事件 `#7014`；任务周期画像 `#7039`；最近查询 `#7051`；阈值卡 `#7067-7081`；记忆文档状态（md 导出视图，默认隐藏）`#7087-7106`；回归闭环 KPI `#7114-7118`。
- **主题库区块**（`topicDbPanelBlock` `#8858-9074`）：摘要条（主主题/明细/未归类/总行/句子/归档）`#8969-8976`、状态分布条 `#8983`、账本口径 `#8984-9014`、层级折叠树 `#9018-9048`、待审队列 `#9052-9062`、健康/升级状态 `#8999-9013`。
- **与笔记相关**：仅图谱/3D 节点 `kind`（note/checkpoint/topic，`#9684-9704`）与图例颜色 `#11033-11034`；**没有笔记计数、没有「未提炼」计数**（全仓 grep「未提炼」仅命中 `docs/audit/46-mimo-lifecycle-survey.md#190-198` 的「未找到」结论）。

### Q7 改造可行性（关键）

| 问题 | 结论 | 证据 |
|---|---|---|
| `memory_read` 返回 sentences 带 id 吗 | **不带**。工具输出只拼 `s.text + ⟪s.src⟫`（`#11683-11688`），`readTopic()` 内部行**有 id**（`memory-store.mjs#1278-1315`；backend 行映射 `backend-sqlite.mjs#139-141` 含 `id`）⇒ 需要改工具输出或另给通道 |
| `deleteSentence` 签名/权限 | `deleteSentence(topicRef, {sentenceId\|sha\|text}, {actor='runtime'})` `memory-store.mjs#1405-1441`；**权限只查 `can(actor,'write')`** `#1407`（不查 delete）；selector 三选一，text 需**整句唯一** `#1420-1425`；不物理擦除：写 `deleted.index`+meta+audit `#1429-1440`，返回 `{ok,id,removedSha,topicId}` |
| dream `delete:false` 含义 | 只限制**主题级** `deleteTopic`（`memory-store.mjs#1880-1882` 查 `can(actor,'delete')`）；**句子级删除属 write 权限**，dream 的 `write:true` 足够。插件 DB patch 实际统一用 `actor:"runtime"` 代删（`#12491/#12496/#12501/#12504/#12524/#12540/#12552/#12564`）——runtime 在矩阵里 `delete:true/write:true` `governance.mjs#247`，**合法** |
| `memory_dream_patch` 支持哪些 action / 能否按 id 删 | action 四值 `edit|replace|append|delete`（`#18063`；topic 分支校验 `#12637-12649`）。topic 寻址的 `delete` selector 只有 `content`（整句文本，`#12493-12496`）；**没有 sentenceId/sha 字段**。替代路：`replace` 逐句 diff（`#12497-12503`）能表达「删掉不在 next 里的句」，但需回传剩余全文（≤128KB）且整主题重写、粒度粗 |
| 改动面（若支持按 id 删） | ①工具 schema 加 `sentenceId`（`#18052-18075`）；②`applyPatches` topic 分支接受并透传（`#12637-12649`）；③`applyDreamPatchesToDb` topic 分支 delete 分支加 id 选择（`#12493-12496`，replace/edit 的删除路径 `#12491/#12501` 也可复用）；④`memory_read` 输出带 id（`#11683-11688`）或新增只读工具；⑤dream 任务书/AGENTS 文案（`#3806-3832`、AGENTS 4.5.1）。**md 路径不受影响**（无 sentence 概念） |
| 现成 store 层能力 | `deleteSentence` 的 `sentenceId` 分支已实现（`memory-store.mjs#1414-1416`），`replaceSentence` 也是 CAS（`#1360-1391`）⇒ 改造主要是**插件工具层透传 + 读侧暴露 id**，store 层零改动（推断，需回归测试） |

### Q8 真机数据（SQL，2026-11-06 14:5x 只读）

- 笔记主题 **12 个**（全部 `state=active`）；笔记句子 **113 条**；含「已提炼 →」标记句 **11 条**；有 ≥1 标记的主题 **10 个**；**未提炼句 = 113 − 11 = 102 条**。
- 最大笔记主题：`T-0560「笔记·E-工具-徕卡一瞬/1b736c53」` **67 句**，其中标记 1 条 ⇒ **66 句未提炼**（与 lead 所说「最大 66 句」吻合，现库已含 1 条 marker）。第二：`T-0558` 18 句（2 条 marker，且曾删过 1 条重复 marker）。
- 各主题未提炼：T-0560 66 / T-0558 16 / T-0576 6 / T-0559 2 / T-0562 2 / T-0564 2 / T-0566 2 / T-0570 2 / T-0561 1 / T-0569 1 / T-0571 1 / T-0575 1。
- 标记目标主题去重 **5 个**（T-0172 / T-0271 / T-0279 / T-0069 / T-0079）。
- 笔记主题审计操作：`sentence.append` 113、`sentence.delete` **1**（T-0558 sentence 33496，删的正是「已提炼 → T-0271（…）」重复 marker，actor=runtime）、`topic.hit` 3、`topic.needs_review` 7、`topic.seed` 12、`topic.state` 19 ⇒ **append-only 在实际数据上已被打破一次（marker 去重）**。
- 全库对照：topics 577 / sentences 33564；`last_hit_at` 非空的笔记主题仅 1 个（T-0560）。
- 结构：12 个笔记主题在 `meta.parent:*` 中 **0 命中** ⇒ 全部「未归类」。

## 4. 改造落点清单（要动哪些函数/工具/权限/面板）

| # | 落点 | 位置 | 影响面 / 注意 |
|---|---|---|---|
| L1 | dream 任务书「会话笔记提炼」块：改成「按 id 删已提炼 + 只留未提炼」 | `#3806-3832`（尤其 #3828-3829） | 仅提示词层；必须配代码闸，否则模型忘/被截断就退化 |
| L2 | `memory_read` 输出 sentence id | `#11683-11688` | 所有调用方（主 agent/dream/面板）输出变长；按 budget 截断逻辑 `#11689` 需同步；可用可选参数（`withIds:true`）降风险（推断） |
| L3 | `memory_dream_patch` schema 加 `sentenceId`（或 `sentenceIds[]`） | `#18052-18075` | 向后兼容（可选字段）；tool 描述/AGENTS 需同步 |
| L4 | `applyPatches` topic 分支透传 selector | `#12637-12649` | 校验「delete 必须 content 或 sentenceId 二选一」；128KB/整批原子语义不变 |
| L5 | `applyDreamPatchesToDb` topic 分支 delete/edit/replace 用 id | `#12476-12507`（`#12493-12496`、`#12491`、`#12501`） | CAS/undo 栈 `#12516-12584` 要覆盖新路径；冲突整条回滚语义保持 |
| L6 | dream 成功判据/幂等：从「append marker」改为「删句 + 写一行指针」 | 需新增落库动作；当前无「指针」概念（marker 是普通句子 `#3829`） | 建议保留 marker（可读）+ 删已提炼句，二者同批原子；幂等用 batch meta `dreampatch:<sha16>` `#12457-12462` 或新 meta |
| L7 | 「未提炼」计数：新口径（未标记句数/主题句数） | 现无任何字段：stats `#8656-8700`、面板 `#8858-9074` 均无；MiMo 侧也没有（46-mimo#190-198） | 最小实现：`topicDbStatsSnapshot` 增 `notes:{topics,sentences,markers,unrefined}`（SQL 可一条 JOIN 算出）+ 面板主题库摘要条/新 KPI；dream 任务书头也可带「本会话未提炼 N 条」 |
| L8 | 笔记主题写保护（防误删/防 dream 乱改） | 现无守卫（Q1） | 若引入「只许 dream 删已提炼句」，需在 `applyDreamPatchesToDb`/`applyPatches` 加「仅笔记主题且 sentenceId 已标记」校验；否则改造后误删面变大 |
| L9 | 生命周期（可选）：笔记主题是否需要归档/续期 | `lifecycle.mjs#22/#142-152`；当前 active 永不归档 | 若要让「长期无未提炼笔记」降噪，可加专用 sweep（类似 `p25LifecycleSweep` `#8408-8493`）；**不要**直接改 `ARCHIVABLE_STATES`（会连带动 308 个 dormant 明细，见 lifecycle-exposure 审计） |
| L10 | 面板展示「未提炼」 | 主题库区块 `#8965-9074`；graph kind 已有 note `#9684-9704` | 只读纪律：stats.json 算好、前端只渲染（同 #11991 注释） |
| L11 | 测试/门 | 现有 `_test-note-remind` 等 | 需补：按 id 删的 CAS/回滚门、未提炼计数守恒门（删 N == 标记 N） |

## 5. 已复用的既有结论（直接引用，不重复推导）

| 来源 | 结论（已验证/引用） | 状态 |
|---|---|---|
| `lifecycle-exposure_AUDIT_2026-11-05.md#22/#51-52` | `ARCHIVABLE_STATES=['draft','needs_review','dormant']`，`planArchivable` 只遍历这三态；改它不影响 active | **已验证**（本次重读 `lifecycle.mjs#22/#142-152` 一致） |
| 同上 `#37/#81/#145` | 2026-11-05 时 `markHit` **全仓 0 调用方**、`last_hit_at` 573/573 NULL、memory_search 不记录命中 | **文档说的但代码已变**：2026-11-06 已接线 `markTopicHits`（`index.js#7340-7372`，search `#7404-7405`、read `#11668-11669`）；本次 SQL 实测 `last_hit_at` 已有 1 个笔记主题非空 |
| 同上 `#128/#239` | 建议「明细子主题不进 90 天归档阶梯」「必须同时修笔记主题续期/归档」 | **已验证但不适用于笔记**：笔记主题是 active 且无 parent，本来就不进归档阶梯；该风险针对 dormant 明细（308 个） |
| 同上 `#62-67`（lifecycle.mjs） | `isRenewed` 只看 `lastHitAt`；写入不续期（appendSentence 只 bump writeCount/updatedAt，`memory-store.mjs#1336`） | **已验证**（`lifecycle.mjs#62-67`、`memory-store.mjs#1596-1607`：markHit 不 bump updatedAt） |
| `panel-followup_AUDIT_2026-11-05.md#54-55/#95-96` | S1：`笔记·<wsKey>/<sid8>` **同时匹配** `isSessionTopicName` 正则；handler 必须先判 `笔记·` 再判 session，否则笔记会静默变灰（checkpoint）；S2：`index.js#17711` 旧注释「不会被误判」与事实相反 | **已验证**：当前 graph kind 判定顺序正确（`#9694-9698` note 优先）；`memory_note` 注释 `#17954` 仍写「不会被误判」——**注释仍失真**（低危，建议改） |
| 同上 `#151-154/#185/#227` | 图谱节点 kind 只增字段、note/checkpoint 分类正确（真机当时 note=2/checkpoint=26）；面板「未提炼」无口径 | **已验证**（kind 代码 `#9684-9704`）；「未提炼计数」在该文档中**没有定过口径**（grep 无命中）⇒ L7 需新定 |
| `note-remind_AUDIT_2026-11-05.md#16/#30-40/#104` | 15% 档位机制（跨档单调+60s 冷却+压缩重置+寄生回归队列）链路完整；`noteRemindText` 实测 188 字；`_accept-p4` 门只造 3 段、测不到 note 段 | **已验证**（代码 `#1861-1923/#4996-5005`）；预算问题当前代码已部分修：note 引导移出重灌 head `#14798-14800`，四段 body 5800+头≈6100 `#14602-14609` |
| 同上 `#186-196`（M1/M2/M3） | M1 四段饱和预算；M2 队列无 TTL/压缩后残留；M3 档位入队前消费 | **M1 已改**（当前 5800+300）；**M2/M3 未验证是否已修**（本次只读未逐行核 `enqueueRegressionReminder` 的 TTL）——标注为未复核 |
| `digest-retire_AUDIT_2026-11-05.md#17/#50-51/#83/#122` | 子代理机械摘要退役（原文走 session_search，覆盖 585/585）；`staleSessionDays` 变死旋钮；命令/横幅需下线 | **文档说的但代码部分已变**：tick 调用点已注释（`index.js#20103-20108`、`#15939`），命令变 stub（`#20461-20463`），但 `runSubagentDigestBatch/digestBlocksToDb` 函数仍在（`#5966-6254`，死代码），`staleSessionDays` 仍被其读取（`#6117/#6173`） |
| `docs/设计文档.md#56-57/#110-122` | 唯一写入通道 `memory_dream_patch`；不可删三闸（delete 一律拒 / 净删≥200 且无指针拒 / 禁提取）；去 md 化硬闸（导出视图裸 file 整批拒 + 读拦截） | **部分已验证**：EXPORT_VIEW_READONLY 代码在（`index.js#12601-12631`）；「delete 一律拒」是**旧 md 时代语义**，与现在 topic 寻址 delete（`#12493-12496`）不同——**文档已过期**（建议更新） |
| `docs/CHANGELOG.md#7-18/#49-73/#93-108` | 4.5：笔记引入（append-only、≤2000、同内容跳过、落点 `笔记·<wsKey>/<sid8>`、15% 提醒、dream 提炼块、SUBAGENT_SKIP、重灌四段、kind 三色）；4.5.1：`memory_write` 仅 dream、主代理唯一写入口 memory_note | **已验证**（代码逐条对应，见 Q1-Q5）；唯一偏差：CHANGELOG 说「append-only」，实际 dream 可按文本删（Q7、SQL 1 次删除） |
| `46-mimo-lifecycle-survey.md#13-17/#190-198/#213-239` | MiMo notes 清空=纯提示词零强制；无「未提炼」观测；建议 dsh-memory 做代码级裁剪+守恒校验+计数；「必须同时修笔记续期/归档」 | **已验证/引用**：MiMo 侧结论作为改造方向依据；其中「修续期/归档」对本项目**不构成阻塞**（笔记 active 不进归档），但「加未提炼计数」正是 L7 |

## 6. 诚实缺口

1. **未运行任何代码/测试**：所有行为结论为静态阅读 + 只读 SQL；`memory_note`/dream 的真实写入未复现。
2. 未逐行读：`spawnIntegrate`（`#19167+`）全文、`runDreamPipeline` 的进度转播细节、`enqueueRegressionReminder` 的 TTL 现状（note-remind 审计 M2/M3 是否已修未复核）、`memory_topics` 层级分组实现（`#11560+`）。
3. 未验证 `deleteSentence` 在「同文本多句」主题上的实际命中率；笔记正文带 `[HH:MM](kind)` 前缀，按整句文本删理论可行，但 dream 从 `memory_read` 拿到的行尾还带 `⟪src⟫` 后缀（`#11688`）——模型必须自行剥掉才能逐字匹配，**这是当前「按文本删」的隐性坑**（推断）。
4. 「未提炼」的准确定义需产品确认：是「无 marker 的句子数」还是「marker 之后新增的句子数」？SQL 现按前者算（102）；若 marker 被追加在末尾，二者在多数主题上同值，但 T-0558（2 条 marker、1 条被删）说明 marker 本身也会重复/被删，口径要定。
5. 真机库是 2026-11-06 14:5x 快照，之后仍会变化；SQL 数字不可复现时以当时库为准。
6. 面板 `client.js` 仅读了 grep 结果（无笔记 UI），未逐行读完整客户端代码；「未提炼」挂哪一块是建议，非既有设计。
