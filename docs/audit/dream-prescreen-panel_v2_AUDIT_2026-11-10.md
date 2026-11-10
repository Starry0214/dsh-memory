# v2 修订方案 · CRA 审计②（2026-11-10）

> 审计员：独立只读审计（CRA 第二轮 · **复核修订版方案**，不审实现）
> 被审对象：`docs/方案-4.5.12-dream预筛与记忆面板v2.md`（170 行）
> 上一轮：`docs/audit/dream-prescreen-panel_AUDIT_2026-11-10.md`（439 行，驳回）
> 仓库：`E:\工具\插件开发调整\dsh-memory-plugin` · HEAD `e0a9be5` · 工作区 4.5.10/4.5.11 未提交 · **运行版 4.5.11 已重启**（部署件 `profiles/web/plugins/memory/index.js` = 1,591,966 B / 22,227 行，与工作区同构建指纹 `1591966B/F41B21FC`）
> 方法：**观测优先**。方案里的每个数字/行号/可行性声明都不采信；在 `os.tmpdir()` 里复制真库（`mem.db`+`-wal`+`-shm`，`readOnly:true`）跑隔离探针，并把 `index.js` 复制到 tmpdir 打桩测量（**仓库文件零改动**）。
>
> 证据边界（诚实声明）：
> - 只读探针 7 个（`audit4512b/` 下 `probe-dream.mjs` / `probe2.mjs` / `probe3.mjs` / `probe5.mjs` / `probe6.mjs` / `walbusy.mjs` / `g6.mjs`），另有一份 tmpdir 内的 `index.js` 插桩副本（`audit4512b/repo-copy/`，**不是仓库文件**）。
> - 活库只读交叉：`GET /dsh-memory/stats.json`（11:58，516,108 B/610ms）、`GET /dsh-memory-panel/snapshot.json`（80,932 B/87ms）。
> - **未**跑 `_run-suite.mjs`、**未**改代码/created-plugin、**未**构建/部署/提交。唯一写操作 = 本文件 + `os.tmpdir`。
> - 任务书给的「骨架 ≈3,919 字」是审计①的**字面量估算**；本轮已用真库跑出实测值（见 §预算核算），两者不一致，以实测为准。

---

## 结论

**有条件通过。**

v2 把审计①的 D-1~D-6 与 M-1~M-12 **实质性吸收**了（不是文字承诺）：A1 确实改内存打分、M-1 的 markHit 污染被设计性消除、M-3 护栏落在 `applyPatches` 整批预扫（topic+file 一条解析路径全覆盖）、M-4 的取数过滤实测正确、M-8 的回环 GET 有现成代码先例且技术可行。方向与结构都可以进入实现。

但**按现文本实现，至少 4 项验收必然红**，且其中 2 项是方案自己的核心裁决点（预算、空轮短路）：

| 级别 | 数量 | 摘要 |
|---|---|---|
| **阻塞性缺陷（不修则验收必红）** | 4 | ①双预算自相矛盾且实测不可达（块 4,500 + 总 8,500 vs 实测任务书 4,110/5,844）；②P0-4 空轮短路按方案写法**净亏**（预信号 1.42s ≈ buildPrompt 1.6s）且会把 md 模式短路死；③G6 正则必误报 URL（面板「复制 URL」功能自伤）；④G7 在 WAL 下**恒真**（读者从不被 `BEGIN IMMEDIATE` 阻塞，已实测） |
| **必须补的 P0（方案未识别）** | 1 | `buildDreamPromptLibrary` 的 `_noteDistilled` **作用域 ReferenceError**（自 v4.5.2 起）⇒「会话笔记提炼」块**从未进入运行中任务书**，v2 的 A1 落点（「笔记提炼块之后」）锚在死块上，sha16 基线还会把这个 bug 冻死 |
| **M 项残留（部分解决）** | 6 | M-3 漏 `review_topic` 的 `into` 目标；M-5 缺中文切词/质量门；M-6 门不可满足 + 落点与空轮判定不一致；M-7 flag 漏 `SETTINGS_SCHEMA`/`normalizeCfg`；M-8 检查点口径自相矛盾 + `physicalSentences` 名不副实；M-9 cost 双源/字段未枚举 |
| **必须修改项合计** | **M'-1…M'-11（11 条）** | 4 条阻塞 + 1 条既有 P0 + 6 条 M 残留，逐条可验收（见文末） |
| **建议项** | 6 | 见文末 |

**一句话**：v2 的设计判断（内存打分、代码级护栏、stats.json 同源）全部成立；错的是**算术、门定义、以及一个方案不知道的既有 P0**。这三类都是局部可修的，不需要推翻重写——所以是「有条件通过」而不是再次驳回。若 M'-1/M'-2/M'-3 不落实，则回到驳回。

---

## M-1~M-12 复核表（逐条：判定 + 证据）

判定口径：**已解决** = 方案文字与代码/实测一致且可实现；**部分** = 方向对但缺关键定义或与实测冲突；**未解决** = 按方案写会错。

| # | 判定 | 复核证据（文件:行 / 实测） |
|---|---|---|
| **M-1** 禁止 markHit | **已解决** | A1 设计只用 `store.topics()`（`memory-store.mjs:386-454`，纯读、无写）+ `store.readTopic()`（`memory-store.mjs:1510-1548`，**无 markHit 副作用**；`markHit` 是独立方法 `1833-1844`）。`topicDbSearchTopics` 内部的 `markTopicHits` 在 `index.js:8224`，A1 不调用该函数 ⇒ 结构上零污染。**实测佐证**：真库副本上 `buildPrompt()` 前后 607 个主题 `lastHitAt` **0 条变化**（`hit_changed_by_buildPrompt=0`；`lastHitAt` 字段确实在 rows 里，239/607 非空 ⇒ 断言不是空转）。残留：G1 的窗口必须限定在 `buildPrompt()`（dream 轮内模型自己 `memory_read` 仍会 `markTopicHits("read")`，`index.js:12609`，那是既有语义不是 A1 引入）。 |
| **M-2** 摘录算法 | **已解决** | 「单句先截断 ≤200、最多 2 句、累计 ≤400」数学自洽（2×200=400）。真库实测 6 个未提炼笔记的摘录长度 = `[400,299,327,391,313,400]`（合计 2,130，均值 355，**0 个空**）；note 单句 max 1,881 / P95 1,713 / >600 字 42 句（n=132）⇒ 旧算法「累计超 600 就停」必空，新算法可行。`no-snippet`/`no-hit` 分列 ✓（方案 A1-2/A1-5）。 |
| **M-3** P25 护栏 | **部分** | ✅ `applyPatches` 整批预扫（`index.js:13740-13767`）用 `dbPatchGuardTopic`（`13528-13545`）一次解析，**topic 寻址与 file 寻址都覆盖**（file→`dbPatchTopicFor` 名字归一映射，`13534-13543`）；`applyDreamJson` 也走同一 `applyPatches`（`14099`）⇒ 工具与最终 JSON 两条落盘通道全覆盖。`memory_split_topic` 源（`19045` 只挡笔记）确需补，但**实测真检查点单句 ≤2,055 字 < 9,000**，会先被 `NOT_OVERSIZED`（`19058`）拒 ⇒ 该处是防御性补强，不是活漏洞。`memory_rename_topic` **已拦**：`isRenameProtectedTopicName` 含 `p25Topics.isSessionTopicName`（`2825-2836`）→ `SYSTEM_TOPIC_READONLY`（`12778-12780`）。`memory_review_topic` 源也拦（`19136-19137` 要求 `needs_review`，检查点恒 active）。 ❌ **漏项（实锤）**：`memory_review_topic` 的 **merge `into` 目标只挡笔记**（`19161` 仅 `isNoteTopicName(dst.name)`）⇒ 源可以是任意 needs_review 主题、目标是**检查点**时，`19185` 会 `appendSentence` 到检查点，直接把「恒 1 句」写成 2 句。D-2' 问「rename/review 要不要一并评估」→ 答：rename 已拦、**review 的 into 必须补**。 |
| **M-4** 检查点取数过滤 | **已解决** | 真库副本按方案判据 `isSessionTopicName(name) && !isNoteTopicName(name) && state!=='archived'` 实测：**47 个真检查点 / 22 个笔记误命中被排除 / 2 个 archived 被排除**；`updatedAt` top-5 = `T-0604 / T-0493 / T-0498 / T-0600 / T-0607`，**5/5 全是真检查点**（对比审计①：不加 `!isNoteTopicName` 时 top-5 是 3 笔记+1 归档+1 真检查点）。检查点正文确有「## 关键结论」「## 错误与修复」两节（T-0604/T-0493 实测），首行为 `## 检查点（目标与下一步，压缩 <cid> · sid <sid8> · cwd <cwd>）`（比方案写的多一个前缀，摘取时要按 `压缩 … · sid … · cwd …` 正则而非整行）。 |
| **M-5** 内存打分 | **部分** | ✅ 字段依赖成立：`store.topics()` 每行**确实带** `activeTriggers`（`memory-store.mjs:434`）、`genericTriggers`（436）、`effectiveTriggers`（437）、`parentId`（439）、`sentences/chars`（430-431，**有效口径**：视图优先/合并源=0）、`lastHitAt`（backend `250`）。✅ 成本成立：`store.topics()` 实测 **43.7–70ms**（注：审计①的 6.3ms 是裸 `SELECT * FROM topics`，不是 `store.topics()`）；`readTopic` **2.9ms/次**，10 次 23.7ms；`noteUnrefinedStats(store, rows)` 44–62ms。⚠ 方案写「第二层仅 10 次读」不准确：是**每 note 取 top10**，6 note 最多 **60 次 readTopic ≈ 174ms**（仍可接受，但要写对账）。⚠ **归一化公式可执行**（`Σ权重/(1+log(1+chars))`、`×log(1+N/df)` 都是纯算术）。❌ **缺关键定义：中文 token 怎么生成**。方案第 3 步只说「剔除结构标签/日期/纯数字/单字/长度<2」，没说从什么切出 token。实测两种最可能口径差异巨大：**(a) 复用 `topicDbTokens`（`index.js:8114-8120`，空白/标点切分、中文整段）** ⇒ 每条 note 都是 64 token 上限打满（原始 token 数远超 64，**截断偏置**），64 个里有 **3–23 个**能命中主题名/effectiveTriggers；**(b) 2–4 字滑窗** ⇒ 单 note 产生 269–10,501 个 token，命中主题数 **189–502 / 575**（33%–87% 全库命中）——不靠 IDF 几乎必然重演「大主题霸榜」。⇒ M-5 只完成了「打分公式」，**没完成「token 生成 + 质量基线」**，而审计①的验收判据正是「top-1 与 note 所属工作区线一致率 ≥ 基线」。 |
| **M-6** 去重渲染 | **部分** | ✅ 方向对：真库 `overTopics` 实测**只有 1 条且是笔记主题**（`T-0560`，41,529 字/detail 档）⇒ P0-2 排除后「超限块」确实不再给 dream 出**不可执行建议**（`dream_patch`/`split` 对笔记都被 `NOTE_TOPIC_FORBIDDEN` 拒：`13576`/`19045`）。❌ 但 P0-2 的验收门「任务书里同一 topicId 完整渲染 ≤1 次」**不可满足**：实测候选行 784 字含 **20 个主题其中 10 个是笔记主题**（`candTopics = _notePick.concat(_otherPick)`，`index.js:4651`/`4711`），笔记块再列 10 个（`4679`），超限块再列 1 个（T-0560），v2 预筛块再列 6 个（N1..N6）⇒ 同一条笔记（如 T-0560）在任务书里最多出现 **4 次**，P0-2 只拿掉其中 1 次（超限块），仍有 3 次。❌ 且 P0-2 落在**渲染层**：`overTopics` 仍含笔记 ⇒ 空轮判定（`20804` 的 `overTopics.length===0`）与 `overLimitStuck` 账本**继续把笔记当「有活」** ⇒ dream 仍会为修不了的笔记空转，方案声称修掉的死胡同只修了一半。 |
| **M-7** flag 落点 + sha16 | **部分** | ✅ 三处已确认可落：`DEFAULT_CFG`（`index.js:7315-7332`）、`/dsh-memory/config` 的 `WRITABLE`（`13239-13241`）、热更新（POST → `writeUserCfg` → `PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config))`，`13256-13272`；三层合并 `7372-7374`）。❌ **漏 `SETTINGS_SCHEMA`**（`7378-7415`，宿主设置页渲染/校验的唯一来源）与 `normalizeCfg` 的布尔归一（`7459-7481`，新键不加一行就**不校验非法值**）⇒ 只改 WRITABLE 的话宿主设置页看不到该开关。❌ **sha16 基线的定义不成立**：P0-2 会改任务书（实测真库唯一超限项是笔记 ⇒ 排除后「超限主题」行消失、`-59` 字），P0-4 改空轮语义，而 G4 要求「`dreamPrescreen=false` 时 sha16 == 基线」。基线若取**改前**字节 ⇒ 必红；若取**改后**字节 ⇒ 该门只防未来回归、不证明「flag 关=现状」。方案必须二选一并写明。 |
| **M-8** 面板口径/回环 | **部分（技术可行）** | ✅ **回环 GET 可行且有同进程先例**：主插件自己就用 `http.get({host:"127.0.0.1", port:PANEL_WSRV.port||PANEL_PORT})` 探活 `stats.json`（`index.js:19702-19730`）；`webServer.port` 可取（`13006` `PANEL_PORT = wsrv.port`、`13173`）；`/dsh-memory/stats.json` 路由**无鉴权/无 Origin 校验**（`13009-13050`，只读 `.monitor.json` + 拼 `topicdb`/`cost`/`documents`）。面板 Host 半区同为 `ctx.inject(['webServer'])`（created-plugin `index.js:257-265`）⇒ 能拿到同一个 server 句柄。✅ 子集选择正确：`topicdb` + `cost` 都在 stats.json 根级（实测）。⚠ 成本：stats.json **516,108 B / 610ms**（比审计①的 384–683ms 同量级）⇒ 10s TTL 必要，方案没写**超时值**（建议 1,500ms）。❌ **口径自相矛盾（新发现）**：`stats.json.topicdb.checkpointTopics = 0`（实测），而面板「检查点」页签按 DB 直读得 **49**（created-plugin `index.js:153-187` 的 join 查询）⇒ G5「一致」在 UI 上是「概览卡显示 0 / 页签列 49」。且 **`checkpointSentences` 在 stats.json 里根本不存在**（实测 keys：`checkpointTopics` 有、`checkpointSentences` 无）⇒ S-6 的拆字段从 stats.json 拿不到。❌ `physicalSentences` **名不副实**：stats.json 的 `physicalSentences=33,638` 与 `sentences=33,638` 相等，因为 `topics()` 里 `physicalSentences` 取自 `_liveSentenceStatsByTopic()`（**已扣墓碑**，`memory-store.mjs:403-407`、`509-541`）；真实物理行数是 33,916（面板 raw SQL 实测）。⇒ 方案的降级标注「直读 DB 给物理口径/未扣墓碑」没错，但不能指望 stats.json 的 `physicalSentences` 做交叉核对。 |
| **M-9** 隐私白名单 | **部分** | ✅ 关键结论复核成立：`.monitor.json` `events` **2,000 条里 0 处盘符路径**（逐条正则实测），`detail` 形态短（tool=`{name}`、note/intent/sink=`string`、compat=`{version,…,selfFp}`，maxLen 557）⇒「events 尾部 20 条」可安全下发。整包其它字段危险：全文件 **112 处盘符路径**、`recentQueries` 20 条、`spiralEvents` 100 条。✅ `dbPath` 用相对路径有现成：stats.json 直接给 `.memtopic/mem.db`（实测）。❌ **白名单未枚举到可执行**：方案写「`cost` 指定 kind 指定字段（白名单）」但没列字段。实测 stats.json `cost.today.kinds` 15 类字段异构（`checkpointWrite` 有 `fail/retry/timeout/avgDurMs`、`rebuildInject` 只有 `injectedChars/estTokens`、`hostMain` 的 `totalTokens=0` 而 `realMain.totalTokens=7,888,388`）⇒ 不逐 kind 指定就会显示一片 0。❌ **cost 双源**：B1 同时写「stats.json 取 `cost` 子对象」和「`.monitor.json` 取 cost 指定字段」——两处 shape 不同（`.monitor.json.cost` 只有 `version/since/totals/daily/events/limits`，无 `kindList/byKind/trend7d`）⇒ 必须二选一（建议只 stats.json）。 |
| **M-10** busy_timeout/降级 code | **部分** | ✅ 可执行：只读连接上 `PRAGMA busy_timeout=2000` 实测可设；`SQLITE_BUSY` 与 `database-unreadable` 分码、重试 1 次，都是局部改动（面板现 `index.js:137-147` 四态可扩）。❌ **前提被实测推翻**：WAL 下**读者不会被写事务阻塞**——写者 `BEGIN IMMEDIATE` 与 `BEGIN EXCLUSIVE` 期间，已开的只读连接、新开的只读连接查询全部成功（`walbusy.mjs` 实测 3/3 ok，无 `SQLITE_BUSY`）。⇒ 该风险实际形态是「**打开时**的 WAL 恢复/`-shm` 权限/文件损坏」，不是「主进程持写锁」。`busy_timeout` 可保留（防御性、零成本），但方案的理由与 G7 断言都建立在不成立的模型上。 |
| **M-11** dangling/TTL | **已解决** | `.integrate.json.progress.dangling` **确有现成字符串**（实测 383,796 B 文件里 `progress.dangling` 有值，含「存量悬空指针 272 处…」）；`.integrate.json` 已原子写（`20172` `writeFileAtomic(..., {tag:"ledger", verify:true})`）⇒ 不会读到半截 JSON；10s TTL 覆盖 384KB 解析（~3-5ms）足够。面板不 import `scanDanglingPointers`（`772-798`）是硬要求，方案已写死 ✓。 |
| **M-12** URL 修正 | **已解决** | v2 全文**已无** `/dsh-memory/panel`（grep 0 命中），改用 `/dsh-memory/stats`（B2/B3）与 `/dsh-memory/graph.json`（B2）；`/memory-panel` 命令确实存在（`index.js:21696-21753`），B2 写「复制 URL 或命令」与面板只读定位一致；验收步骤「备份 3 文件 → 就地改（不走重装/升级）→ 重启 DSH → 硬刷新 → curl snapshot」可照抄（面板 `package.json` 仍是 `version:1.0.0`，回滚口径对得上）。 |

---

## v2 新漏洞（≥3，均带实测）

### V-1【阻塞】双预算自相矛盾，且用实测数字两倍超支
方案 A1-7 写：`每 note ≈ 摘录 400 + 3×(元信息 45 + 摘要 80) ≈ 775`；`6 note ≈ 4,650 → 块 ≤4,500`；`总 ≤8,500（骨架 3,919 + 4,500）`。逐项对不上：

1. **它自己的算式就超**：6×775 = **4,650 > 4,500**（+3.3%），注释里「6 note ≈4,650 → 块 ≤4,500」是自打脸；按「超出截断到 note 级」实际只能放 5 个 note（5×775+块头 ≈ 4,060），那「note ≤6」就是空话。
2. **「摘要 80」与输出规格冲突**：A1-5 写「摘要：前 2 句各 ≤80 字」= 最多 **160** 字/关联主题，不是 80。按 160 算：每 note = 400 + 3×(45+160) = **1,015**；6 note = **6,090**（+35%）。
3. **元信息 45 字不够**：真库主题名 p50=27 / p90=52 / p99=76 / max=91 字；`T-xxxx「名」N 句 · ` 实测样本 32–34 字（短名）但 p90 名会到 66 字。按均值 33 尚可，按 p90 就破 45。
4. **每 note 固定开销未计**：`### N1. …（未提炼 N 句）` + `摘录：` + `兜底：…` 实测 **≈93 字/note**，块头 4 行 **183 字**。
5. **骨架 3,919 是估算，实测不是这个数**：真库副本跑 `__dreamHooks.buildPrompt()` 得 **4,110 字**（且见 V-4：这 4,110 是**缺了笔记块**的残缺任务书）；把笔记块修好后 = **5,844 字**（笔记块 ≈1,734）。

代入真值：
| 口径 | 每 note | 6 note 块 | 任务书总（修好笔记块） | 对 8,500 的余量 |
|---|---|---|---|---|
| 方案算式（400+3×125=775，**不计**固定开销） | 775 | 4,650+183 = **4,833** | 5,844+4,833 = **10,677** | **−2,177** |
| 实测摘录均值 355 + 3×125 + 固定 93 | 823 | 4,938+183 = **5,121** | **10,965** | **−2,465** |
| 按输出规格摘要 160（400+3×205+93） | 1,108 | 6,648+183 = **6,831** | **12,675** | **−4,175** |

⇒ **块 4,500 与总 8,500 不能同时成立**（即使按残缺任务书 4,110 算：4,110+4,500 = **8,610 > 8,500**）。必须重定（算式见 M'-1）。

### V-2【阻塞】P0-4 空轮短路按方案写法是**净亏**，还会把 md 模式短路死
- 方案前提「预筛 1.5–2.3s 白付」是**审计①对旧 A1（10 次 SQL 检索）的估计**，v2 已改内存打分：实测 A1 全部取数 ≈ `topics() 44–70ms + noteUnrefinedStats 44ms + 6×readTopic 18ms + ≤60 readTopic 174ms` ≈ **0.1–0.3s**，不是 1.5–2.3s。前提对 v2 自身不成立。
- 方案要「先算 `_preSignals`（noteUnrefinedStats / overTopics / lessonPickN）」。实测 `buildPrompt()` 总耗时 **1,574–1,644ms**，其中 `listOverLimitTopicsFromDb`（`index.js:4000-4027`，对 575 个非归档主题逐个 `readTopic`）占 **1,325–1,379ms（84%）**。要判 `overTopics.length===0` 就得付这 1.33s ⇒ 空轮省 1.6s−1.42s ≈ **0.2s**；而**非空轮**会先付 1.33s 再让 `buildDreamPromptLibrary` 重算一遍 1.33s ⇒ **每轮 +1.33s**。
- 可行修法（写进 M'-2）：用**廉价必要条件**替代精确计算——`rows.some(t => t.chars > PROJECT_CHAR_HARD)`（`rows` 已取、43ms；任何超限主题必然 `chars > 9000`，故为假的必要条件成立即可安全跳过），且把 `rows` 传给后续 `buildDreamPromptLibrary` 复用。
- **md 模式回归风险（严重）**：`spawnIntegrate` 的空轮闸在 `20804` 对 md/库双模式共用，md 分支的真实候选来自 `listIntegrateCandidates`（`20452`）与 `overChar`（`20473`）。若 P0-4 把「`_preSignals` 全空就 skipped」无条件提前，md 模式（`overTopics` 恒空、`noteUnrefinedStats` 无 store 恒 0）会在 lessonPickN=0 时**永远 skipped** ⇒ md 路径整条死。P0-4 必须 `if (TOPICDB.enabled)` 门控。
- **账本语义**：现空轮块（`20804-20818`）不是「返回 skipped」这么简单，它同时写 `lastIntegrateAt`、`delete lastFailAt`（`20807-20810`，防 2h 死循环重试）、`DREAM_TRACK=null`、`DREAM_PATCH({status:"skipped",…})`、`DREAM_LISTENER=null`、`return "skipped"`。P0-4 必须**复用这一整块**（把预信号计算塞进闸条件），另写一份「early return」就会漏账本 ⇒ 失败重试环。方案只写「直接走 skipped」，未约束这一点。

### V-3【阻塞】G6 隐私正则必误报 URL（面板自己的「复制 URL」功能自伤）
`G6: snapshot 序列化正则不含 [A-Za-z]:[\\/]`。实测该正则对 `"http://127.0.0.1:62623/dsh-memory/stats"` **返回 true**（`p:/` 命中），而 v2 B2「工具」页签要求「打开浏览器面板（`/dsh-memory/stats`，复制 URL 或命令）」⇒ 只要面板展示/复制 URL，G6 必红。修法：`(^|[^A-Za-z0-9])[A-Za-z]:[\\/]`，或先剥离 `https?://` 再扫（M'-7）。

### V-4【阻塞·方案未识别】「会话笔记提炼」块自 v4.5.2 起从未进入运行中任务书（`_noteDistilled` 作用域 ReferenceError）
- 代码事实：`_noteDistilled` 声明在候选 try 块内（`index.js:4618` `try {` → `4635` `const _noteDistilled = …`），而笔记块在 try **外面**用它（`4674`）⇒ 每次 `buildDreamPromptLibrary()` 必抛 `ReferenceError: _noteDistilled is not defined`，被 `4704` 的 `catch (eNB) { noteBlock = ""; }` **静默吞掉**。
- 实测（部署件同字节的 `index.js` + 真库副本）：任务书 **无**「会话笔记提炼」段，`prompt_has_note_block=false`；插桩确认 `__NB_ERR="…is not defined"`；把该引用改成 `noteTopicDistilled(store, t.id)` 后 → `noteRows=12, sorted=12`，任务书从 **4,110 → 5,844 字**。
- `git blame`：`4635`/`4674` 两行同属 `12954fb`（release v4.5.2，2026-11-07）⇒ **v4.5.2 起所有版本**（含当前运行 4.5.11）都缺这个块。
- 影响（对 v2 是致命的）：①笔记块的**哨兵收敛说明**（`NOTE_COMPACT_SENTINEL` + compact JSON 格式，`index.js:4694-4701`）只存在于该块 ⇒ 笔记收敛流程在真机上**没有指令可执行**（真库现存 12 个未提炼笔记/116 句；最近一次指针写入是 11-08 12:57 的**同秒批量**（迁移/apply 特征），11-09 之后无新指针）；②v2 A1 的落点写「`scope` 内、笔记提炼块之后」——锚在一个**永不渲染**的块上；③v2 的 sha16 基线若取当前字节，等于把这个 bug 永久冻死（G4 反而保护错误行为）。
- 结论：v2 必须把「修 `_noteDistilled` 作用域 + 门断言笔记块存在」列为 **P0-0**（先于 A1），并把基线定义改成「修好后的同提交、flag 关」。

### V-5【新】面板「检查点」数字在 v2 自己内部就对不上
stats.json `topicdb.checkpointTopics = 0`（实测；根因审计①已定位：`topicDbHierarchy` 只从无父 `detailNoParent` 筛系统主题，49 个检查点全有父线）。v2 概览卡「检查点主题」取 stats.json ⇒ 显示 **0**；同一面板的「检查点」页签按 DB 直读 ⇒ 列 **49** 条。S-6 要的 `checkpointSentences` 在 stats.json **不存在**。⇒ 要么概览卡改口径（「会话检查点（DB 直读）49 主题」+ `source` 标注），要么删卡；G5 的「一致」必须改成「同一数据源内一致」而不是跨源一致。

### V-6【新】G7 在 WAL 下恒真（空门）
实测（`walbusy.mjs`，node:sqlite，WAL）：写者 `BEGIN IMMEDIATE` 期间读者查询 ok、新开只读连接 ok；写者 `BEGIN EXCLUSIVE` 期间读者仍 ok。⇒「主进程持 `BEGIN IMMEDIATE` 时 snapshot 仍 200」**永远通过**，测不到任何东西；`code==='database-busy'` 分支也永远不会被触发。真实故障形态是打开时的 WAL 恢复/`-shm` 不可写/文件损坏 ⇒ G7 应改为「DB 打开失败 → `database-unreadable`；权限/恢复中 → `database-busy`」的**构造用例**（如打开前 chmod/删 `-shm`/喂坏文件），而不是并发写锁。

### V-7【新】P0-2 改的是「任务书字节」，与 G4 基线互斥（已量化）
真库唯一超限主题是笔记 `T-0560`（41,529 字）⇒ P0-2 排除后任务书少一行 `- T-0560「…」41529 字符（本档上限 40000，超 1529）`（**−59 字**）且「超限主题」段从有到无。该改动**不在 flag 后** ⇒ `dreamPrescreen=false` 时任务书 ≠ 改前字节，G4 必红。P0-2 要么进 flag，要么基线定义改写（M'-3/M'-4）。

### V-8【新】M-3 残留：`review_topic` 的 merge `into` 可以是检查点（见 M-3 表）——D-2' 问「够不够」，答案是**不够**，方案自己的裁决点必须给出结论并补护栏。

### V-9【新】A2 的预算也不自洽
A2 写「5 项 ×（首行 + 两节各 ≤120 字），**总 ≤1,200 字**」。实测首行 `## 检查点（目标与下一步，压缩 6de64a35 · sid 079b9bf7 · cwd E:\工具\插件开发调整）` ≈ 60 字 ⇒ 每项 ≥ 60+240+标签 20 = 320，**5 项 = 1,600 > 1,200**。且部分检查点「关键结论」或「错误与修复」为空（T-0493 第二份无「错误与修复」节）⇒ 摘录算法要有缺节降级，方案未写。

### V-10【新】预筛块与笔记块对同一条笔记给出**两种排序**
笔记块按 `updatedAt` 降序取 top10（`4675`），A1 按「未提炼句数」降序取 ≤6（方案 A1-1）。实测两序不同（updatedAt 序：T-0602/T-0566/T-0560/T-0596/T-0575…；未提炼句数序：T-0560/T-0602/T-0597/T-0562/T-0594/T-0575）⇒ 同一任务书里 N1..N6 与上方列表顺序错位，dream 易误以为两处是不同集合。

---

## G1~G7 可执行性

| 门 | 可执行性 | 结论/缺口 |
|---|---|---|
| **G1**（M-1） | ✅ 可执行 | 夹具（`test/_dream-cand-selftest.mjs` 模式：真临时库 + `__dreamHooks.buildPrompt()`）可快照 607 行 `lastHitAt` 前后比对（字段实测存在，239 非空）；「源码 A1 段不出现 `markTopicHits`」是文本断言，可写。**缺**：窗口必须明确限定在 `buildPrompt()`（否则 dream 轮内 `memory_read` 的合法续期会把门判红）；建议再加「A1 函数源码段不含 `topicDbSearchTopics`」负例。 |
| **G2**（M-3） | ✅ 可执行（需补用例） | 真临时库造检查点（`<wsKey>/<sid8>` + 父线 `会话检查点·<wsKey>`）后调 `memory_dream_patch{append}` ⇒ 断言整批 `P25_SESSION_TOPIC` 且句数不变；`split_topic` 源同理（注意会先撞 `NOT_OVERSIZED`，用例要给 >9,000 字的假检查点或直接断言 guard 分支）。**缺**：`review_topic{merge, into:<检查点>}` 的用例（M'-5）。 |
| **G3**（M-2） | ✅ 可执行 | 造 1 条 1,881 字单句的笔记主题 ⇒ 断言摘录非空且 ≤400。真库已有天然样本（T-0560 maxLen=1,881），夹具可照抄。 |
| **G4**（M-5/M-7） | ❌ **按现文本必红** | 双预算互斥（V-1）；`dreamPrescreen=false` 的 sha16 基线被 P0-2/P0-4/笔记块 bug 破坏（V-1/V-4/V-7）。另：`Expression tree is too large` 断言在 v2 设计下**恒真**（不调 `searchSentencesByTokens`），无鉴别力。**缺**：M-5 的**质量门**（top-1 与 note 工作区线一致率 ≥ 基线）根本不在 G1~G7 里。 |
| **G5**（M-8） | ⚠ 可执行但需新 harness | 面板 Host 是独立插件，`_fixture-ctx.mjs` 的 `inject()` **不回调**（`_fixture-ctx.mjs:9-10,44`）⇒ 现有夹具**测不到**任何 webServer 路由；G5/G6/G7 必须新写一个「fake webServer + fake req/res（或临时 http server）」harness，方案未提。断言本身可做：直接调用面板 handler 拿 payload 与 `GET /dsh-memory/stats.json` 子集比。**缺**：跨源差异白名单要写死（`checkpointTopics 0 vs 49`、`sentences 33,638 vs 33,916`），否则「或差异命中白名单」等于无门。 |
| **G6**（M-9） | ❌ **必误报** | 正则 `[A-Za-z]:[\\/]` 命中 `http://…`（实测）⇒ 与 B2「复制 URL」互斥（V-3）。且 `events` 白名单本身安全（实测 0 路径），门应聚焦「整包下发」而非「任何盘符」。 |
| **G7**（M-10） | ❌ **恒真空门** | WAL 读者从不被写锁阻塞（实测）⇒ 断言永真。须改为构造打开失败/损坏/`-shm` 不可用的用例（V-6）。 |
| （P0-4 门） | ⚠ 不可观测 | 「空轮 fixture 下预筛函数调用次数 = 0」需要**可注入计数器**（现有 `__dreamHooks` 只挂 `apply`/`buildPrompt` 等，无 prescreen 计数）⇒ 方案需同时要求暴露 `__dreamHooks.prescreenCount` 或等价观测点，否则该门无法实现。 |

---

## 预算核算（v2 算式 vs 4,500/8,500）

**实测基线（真库副本，部署件 index.js）**

| 量 | 实测 |
|---|---|
| 当前库模式任务书 `promptText` | **4,110 字**（**缺笔记块**，见 V-4） |
| 修好笔记块后 | **5,844 字**（笔记块 ≈1,734） |
| 分节 | Input Scope 1,145 / Consolidate 306 / 主题卫生 752 / 主题库容量 461 / 待审队列 72 / Self-Calibration 125 / Write Path 486 / Output 251（+ 前导 3 行 ≈200） |
| 候选行 | 784 字，20 主题，**其中 10 个笔记主题** |
| 超限块 | 1 条（笔记 T-0560 41,529 字）⇒ P0-2 后消失（−59 字） |
| `buildPrompt` 耗时 | 1,574–1,644 ms（`listOverLimitTopicsFromDb` 占 1,325–1,379 ms） |
| 6 个笔记摘录实测 | `[400,299,327,391,313,400]`，合计 2,130（均值 355） |
| 笔记单句长度 | n=132 / max 1,881 / P95 1,713 / 中位 389 / >200 字 103 句 / >600 字 42 句 |
| 主题名长度 | p50 27 / p90 52 / p99 76 / max 91 |

**结论**：v2 的「块 ≤4,500 + 总 ≤8,500」在**任何**基线下都不成立（8,610 / 10,677 / 10,965 / 12,675）。必须重定并写死算式（M'-1）。给三组可直接采纳的算式（每 note = 摘录 + 3×(元信息 45 + 摘要) + 固定开销 93；块 = 块头 183 + Σ每 note）：

- **A 案（保守，推荐）**：`note ≤5`；摘要 ≤80 ⇒ 每 note 最坏 **868**（400+375+93）；块 = 183+5×868 = **4,523** ⇒ 块上限取 **4,600**（若坚持 4,500 则只能 `note ≤4`：183+4×868 = 3,655 ✓）；总 = 5,844+4,600 = **10,444 ≤ 10,500** ✓。
- **B 案（保 6 个 note，摘要按输出规格 ≤160）**：每 note = 400+3×205+93 = **1,108**；块 = 183+6×1,108 = **6,831** ⇒ 块上限 ≥6,900、总上限 ≥**12,800**。
- **C 案（保 6 个 note，每 note 只给 2 个关联）**：每 note = 400+2×205+93 = **903**；块 = 183+6×903 = **5,601** ⇒ 块上限 ≥5,700、总上限 ≥**11,500**。
- 若坚持 4,500/8,500 两个数不动：只能 `note ≤4` 且摘录/摘要再砍，等于把 A1 对多数 note 关掉 ⇒ **4,500/8,500 这一对数字应整体废弃**。

---

## 面板数据层可行性（stats.json 回环/降级/隐私）

**结论：可行，但方案有三处要改。**

1. **回环 GET 可行（有先例）**：主插件 `_scHttpGet` 就是同进程 `http.get(127.0.0.1:port)`（`index.js:19702-19730`）；端口来源 `wsrv.port`（`13006`/`13173`）；面板 Host 同样 `ctx.inject(['webServer'])`（created-plugin `index.js:257-265`）⇒ 拿 `webCtx.webServer.port` 即可。`/dsh-memory/stats.json` **无鉴权**（`13009-13050`）⇒ 无跨域/无 token 问题。**建议**：`timeout=1500ms`、`TTL=30s`（不是 10s：516KB/610ms 的服务端成本太高，10s 会带来 ~6% 的常驻负载）。
2. **降级路径**：stats.json 不可达 → 直读 DB。可执行，但必须写清：`sentences` 物理 33,916 vs 有效 33,638（差 278 = `deleted.index` 墓碑）；`checkpointTopics` 按「有父线的会话主题」= 49（≠ stats.json 的 0）；`physicalSentences` **不能**拿 stats.json 的字段做交叉核对（它已扣墓碑，见 M-8）。面板需给 `source:"stats"|"db-physical"` + 脚注（方案 S-8 已提 ✓）。
3. **隐私**：`events` 尾部 20 条安全（实测 2,000 条 0 盘符）；`recentQueries`(20)/`spiralEvents`(100)/整包 monitor（394,677 B，112 处盘符）必须排除。`dbPath` 走 stats.json 天然是相对路径 ✓。G6 正则必须修（V-3）。
4. **字段足够性**：`topicdb`（607/33,638/byState/needsReview/noteUnrefined.items/health/reviewQueue/upgrade/hierarchy）够概览+主题库+笔记页签的**计数与列表**；但「检查点全文」与「笔记全文」仍需 DB 直读（stats.json 不含正文）⇒ 面板必然是**混合数据源**，方案必须按分区写死来源，否则 G5 无法定义「一致」。
5. **dream progress 不在 stats.json** ✓（方案已正确改为直读 `.integrate.json`）：`progress.status/steps/summary/health/durMin/tokens/dangling` 实测齐全；`lastFailAt` **是瞬态键**（失败才写、成功/空轮删除，`20809`/`20971-20972`/`21288`）⇒ 当前盘上无此键，面板必须把缺失当 0 处理，不能报错。

---

## 必须修改项 / 建议项

### 必须修改项（逐条可验收）

| # | 必须修改 | 验收判据 |
|---|---|---|
| **M'-1** | **预算重定**：废弃 4,500/8,500 这对数字，改为一组自洽算式（建议 A 案：`note ≤5 / 块 ≤4,600 / 总 ≤10,500`），算式必须含「每 note 固定开销 ≈93 字」与「块头 183 字」，并把实测值（摘录均值 355、元信息均值 33、摘要 80）代入 | 门：用真库副本跑 `buildPrompt`，断言 `块 ≤ 上限` **且** `总 ≤ 上限`；且方案文本里能按算式手算出与实测一致（±5%） |
| **M'-2** | **P0-4 重设计**：①仅库模式（`if (TOPICDB.enabled)`）；②预信号用廉价必要条件 `rows.some(t=>t.chars>PROJECT_CHAR_HARD)`（不调 `listOverLimitTopicsFromDb`）；③复用同一 `rows`；④**复用现空轮块**（`20804-20818` 的账本/转播/返回），不得另写 early-return；⑤md 模式候选（`candI`/`overChar`）不进短路 | 门：空轮 fixture 断言「`buildDreamPrompt` 未调用」且 `lastIntegrateAt` 已写、`lastFailAt` 已清、`DREAM_PATCH.status==="skipped"`；md 模式 fixture 断言不受影响（仍会发起）；非空轮断言 `store.topics()` 调用次数 = 1（复用） |
| **M'-3** | **补 P0-0**：修 `_noteDistilled` 作用域（`index.js:4635` 声明提到函数作用域，或 `4674` 直接调 `noteTopicDistilled(store, t.id)`）；并**重新定义 sha16 基线**（=「修好 + P0-2 落地后的同提交、`dreamPrescreen=false`」的 golden，写明它只防未来回归） | 门：真库副本 `buildPrompt` 含「会话笔记提炼」且含 `NOTE_COMPACT_SENTINEL`；`promptText` 长度 ≥ 5,800；sha16 基线由同一提交生成并被记录 |
| **M'-4** | **P0-2 落点统一 + 删不可满足的门**：`overTopics` 是否含笔记必须在**一处**决定（建议源头 `listOverLimitTopicsFromDb` 加 `excludeNotes` 选项，同时供渲染/空轮/`overLimitStuck` 三处使用）；删除「同一 topicId 完整渲染 ≤1 次」，改为「同一 topicId 的**完整明细块** ≤1 次（候选行/笔记块的单行不计）」 | 门：真库断言 `overTopics` 无笔记主题；任务书里 `T-0560` 的「超限主题」行消失；空轮判定不再因笔记超限而发起 |
| **M'-5** | **M-3 补 `into` 目标护栏**：`memory_review_topic` merge 分支在 `19161` 旁加 `p25SessionTopicWriteGuard(store, dstId)`（或 `dst.name` 形态 + 父线双条件），拒绝码 `P25_SESSION_TOPIC`、整批不落盘；可选给 guard 增加 `rows` 形参（避免每 patch 一次 `topics()` 43–70ms） | 门 G2 增用例：`review_topic{merge, into:<真检查点>}` ⇒ 拒且检查点句数不变；`rename_topic` 检查点 ⇒ `SYSTEM_TOPIC_READONLY`（已有，补回归） |
| **M'-6** | **M-5 补 token 生成 + 质量门**：明确中文 token 方案（建议：以主题名/effectiveTriggers 为词典做反向匹配 + 2–4 字滑窗仅用于「候选 token 池」，且 df 权重必须落地），token 数上限保留 ≤64 但**禁止前缀截断**（按权重取）；新增质量门 | 门：同一批 6 个真笔记，top-1 与 note 所属工作区线一致率 ≥ 先测的基线；且不出现「单 note 命中主题数 > 100」（防滑窗泛化） |
| **M'-7** | **G6 正则修正**：改 `(^|[^A-Za-z0-9])[A-Za-z]:[\\/]` 或先剥离 `https?://`；同时把「只接受 GET/HEAD」「不含 `recentQueries`/`spiralEvents`/`queries`」「`events` 只取尾部 20」写进门 | 门：面板 snapshot 序列化后 0 命中新正则；面板工具页展示的 URL 不导致红 |
| **M'-8** | **G7 重定义**：改为「DB 打开失败/损坏/`-shm` 不可写」构造用例 + `code` 分流断言；`busy_timeout` 保留但注明防御性（WAL 读者不被写锁阻塞，实测） | 门：坏 DB 文件 ⇒ `database-unreadable`；模拟占用/恢复 ⇒ `database-busy`；正常并发写期间 ⇒ 200（保留，但注明它不证明任何风险） |
| **M'-9** | **面板 cost 单一来源 + 字段枚举**：只从 stats.json `cost` 取；`host` 类用 `today.realMain/realSub.totalTokens`（**不要** `kinds.hostMain.totalTokens`，实测恒 0）；逐 kind 列出取哪个字段；`.monitor.json` 只取 `events` 尾部 20 | 门：面板成本页 15 个 kind 的「tokens」非全 0（至少 hostMain/hostSub/checkpointWrite 三项有值）；snapshot 不含 `recentQueries`/`spiralEvents` |
| **M'-10** | **G1 窗口 + 静态断言 + 面板 harness**：G1 明确「`buildPrompt()` 前后」；补「A1 源码段不含 `markTopicHits`/`topicDbSearchTopics`」；G5~G7 需新写 fake-webServer harness（现有 `_fixture-ctx.mjs` 的 `inject` 不回调，测不到路由） | 门：三断言齐；面板 harness 能在 CI 里直接调 handler 拿 payload（不依赖真机 DSH） |
| **M'-11** | **M-7 flag 落点补全**：`DEFAULT_CFG` + `SETTINGS_SCHEMA`（`7378-7415`）+ `normalizeCfg` 布尔归一（`7459-7481`）+ `WRITABLE`（`13239`）+ 热更新（已有 `13261`） | 门：`/dsh-memory/config` POST `dreamPrescreen:false` ⇒ `PLUGIN_CFG.dreamPrescreen===false` 且落盘 `.config.json`；非法值 `"x"` 被归一为默认；宿主设置页 schema 含该字段 |

### 建议项

| # | 建议 |
|---|---|
| **S'-1** | 顺手把「笔记超限」这条既有死胡同彻底修掉：`overLimitStuck`/健康体检也别再催 dream 处理笔记主题（与 M'-4 同源）。 |
| **S'-2** | A2 预算：5 项 × (首行+2×120) ≈1,600 > 1,200，建议降为 `≤4 项` 或 `每节 ≤90 字`；并对「关键结论/错误与修复 缺节」给降级文案（实测有检查点缺节）。 |
| **S'-3** | 预筛块的 note 顺序与笔记块统一（都按 `updatedAt` 或都按未提炼句数），否则同一任务书两处顺序不同（V-10）。 |
| **S'-4** | `prescreen` 观测事件加 `dropped=<被预算截断的 note 数>` 与 `ms=`（方案已有 `ms`），便于真机判断预算是否够。 |
| **S'-5** | 面板 stats.json 拉取超时 1,500ms、TTL 30s；flag 关（`topicdb:null`）时面板走「主题库未启用」空态，不要落回 DB（否则 flag 关也会读库）。 |
| **S'-6** | 把「面板更新需重启 DSH」写进回滚步骤（Host 半区启动时 import；Client 半区热重载不确定），并保留 `version:1.0.0` 作为回滚锚点（实测当前 package.json 即 1.0.0 ✓）。 |

---

## 附：本轮新增实测速查（供实现/门直接引用）

| 指标 | 值 | 来源 |
|---|---|---|
| 运行版任务书（缺笔记块） | **4,110 字** | 真库副本 + 部署件 index.js |
| 修好笔记块后 | **5,844 字**（笔记块 ≈1,734） | 同上（插桩副本） |
| `buildPrompt` 耗时 | **1,574–1,644 ms**；`listOverLimitTopicsFromDb` **1,325–1,379 ms（84%）** | 同上 |
| `store.topics()` / `noteUnrefinedStats` / `readTopic`×10 | 43.7–70 ms / 44–62 ms / 23.7 ms（单次 2.9 ms） | 同上 |
| 未提炼笔记 | 12 主题 / 116 句（items 12） | stats.json + 副本 |
| 6 note 摘录长度 | `[400,299,327,391,313,400]`（合计 2,130，0 空） | 副本 |
| 笔记单句 | n=132 / max 1,881 / P95 1,713 / 中位 389 | 副本 |
| 主题名长度 | p50 27 / p90 52 / p99 76 / max 91 | 副本 |
| 候选行 | 784 字 / 20 主题 / **10 个笔记** | 副本 |
| 超限主题 | **1 条（笔记 T-0560 41,529 字）** ⇒ P0-2 后为 0 | 副本 |
| 检查点（方案判据） | 47 真 / 22 笔记误命中 / 2 archived；top5 = 5 真检查点 | 副本 |
| 检查点正文 | 首行含 `压缩 <cid> · sid <sid8> · cwd <绝对路径>`；有「## 关键结论/## 错误与修复」（部分缺节） | 副本 DB |
| token 口径 (a) `topicDbTokens` | 64 上限全打满；命中 3–23/64 | 副本 |
| token 口径 (b) 2–4 字滑窗 | 单 note 269–10,501 token；命中主题 **189–502/575** | 副本 |
| stats.json | 516,108 B / 610 ms；`checkpointTopics=0`；`sentences=physicalSentences=33,638`；无 `checkpointSentences` | 活库 11:58 |
| 面板 snapshot（现状） | 80,932 B / 87 ms；`{topics:607, sentences:33,916, checkpoints:49}` | 活库 |
| WAL 并发 | 写者 `BEGIN IMMEDIATE`/`EXCLUSIVE` 期间读者 3/3 全部成功（无 BUSY） | `walbusy.mjs` |
| G6 正则 | `[A-Za-z]:[\\/]` 命中 `http://…` ⇒ true | `g6.mjs` |
| `.monitor.json` | 394,677 B；events 2,000（**0 盘符**）；112 处盘符（其他字段）；recentQueries 20；spiralEvents 100 | 磁盘 |
| `.integrate.json` | 383,796 B；`progress.dangling` 有值；`lastFailAt` 当前不存在（瞬态） | 磁盘 |
| cost（stats.json） | 15 kind；`today.kinds` 字段异构；`hostMain.totalTokens=0` 而 `realMain.totalTokens=7,888,388` | 活库 |
