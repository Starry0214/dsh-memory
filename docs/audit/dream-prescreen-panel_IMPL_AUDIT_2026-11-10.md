# 4.5.13 Part A 实现 · CRA 第三轮独立复核（只读审计）

> 审计员：独立只读审计（CRA③：审**实现**，不审方案）
> 被审对象：`index.js`（4.5.13 Part A 叠加在 4.5.12 上，工作区未提交/未部署/未 bump）+ `test/_dream-cand-selftest.mjs`（扩展）+ 根目录新门 `_test-dream-prescreen.mjs`
> 依据：`docs/方案-4.5.12-dream预筛与记忆面板v2.md` §2 + **§7（v3，冲突以此为准）**；`docs/audit/dream-prescreen-panel_v2_AUDIT_2026-11-10.md`（M'-1~M'-11 / V-1~V-10）；`docs/audit/dream-prescreen-panel_AUDIT_2026-11-10.md`（F-1~F-12）
> 基线：仓库 `E:\工具\插件开发调整\dsh-memory-plugin`，HEAD `e0a9be5`；运行版 **4.5.12**（部署件 `index.js` 1,592,470 B / sha256 `5C6D2E1D…` = `index.js.bak-pre-p3-20261110-122103`，**= 4.5.13 之前的干净基线**）
> 方法：**观测优先**。① 用部署件 4.5.12 与工作区 4.5.13 做 `git diff --no-index`（509 行，即 Part A 全量改动集，见 §1）；② 真库（607 主题）**复制**到 `os.tmpdir()` 跑 4.5.12/4.5.13 双版本对照（库模式 flag 开/关、md 模式）；③ 4 个隔离探针（`audit4513/probe-4513.mjs` / `probe-p04.mjs` / `probe-guard.mjs` / `probe-real2.mjs`）验证空轮短路、A2 只读面、检查点父线完整性；④ 复跑 8 个门。
>
> 证据边界（诚实声明）：
> - 只读：**未**改仓库任何文件（唯一写操作 = 本文件 + `os.tmpdir` 下探针/临时 home）；**未**部署、**未** bump、**未**刷冻结、**未**提交；**未**跑 `_run-suite.mjs`（实现者已跑，结果引用）。
> - 真库副本为「复制 mem.db + -wal + -shm」快照（13:16 后状态：607 主题 / 22 笔记 / 4 未提炼 / 47 检查点），与实现者自报时的库状态**不同**（他自报 flag 关 4,947 / 开 8,176；我实测 5,013 / 9,224，差因是 13:16 的 dream 轮把 8 个笔记收敛了）——**数字不同不是缺陷**，但「自报数字不可复现」这一点本身要在验收时注意（见 §5）。
> - 「top-1 工作区线一致率」我按「note 名 `笔记·<wsKey>/<sid8>` 的 wsKey 是否出现在 top-1 主题名中」判定（实现者未留判定脚本，口径可能不同）；原始数据在 §5.3，可自行改判。

---

## 0. 结论

**有条件通过。**

Part A 的**代码本身**没有发现正确性/数据丢失级缺陷：预筛零 `markTopicHit` 副作用（G1 实测 + 真库 sha 对照）、P25 检查点护栏四处落点齐全且整批拒、`md` 模式**逐字不变**（真库 md 任务书 sha16 与 4.5.12 完全相同）、`flag` 关时库模式任务书**与 4.5.12 字节相同**（真库实测，比自报的「golden 自证」强）。M'-1/M'-3/M'-4/M'-5/M'-10/M'-11 判定「已解决」。

但有 **1 条已跟踪回归门变红**、**1 条核心机制在真库上实际不生效**、**1 条质量门缺失且实测不达标**、**新门未入库**：

| 级别 | 数量 | 摘要 |
|---|---|---|
| **必须修改（不修则不能收尾）** | 6 | ①已跟踪门 `test/_dream-review-tool-selftest.mjs` 因 `listReviewQueueFromDb` 签名变更而**红**（4.5.12 时 39/39，4.5.13 时 38/1），且该门不在套件允许清单里 ⇒ 实现者的「套件 10 红」看不到它；②P0-4 空轮短路的廉价必要条件在真库**永不触发**（136 个 `chars>9000` 主题、真实超限 0）⇒ 省时目标落空，现有门用空库测试**空转通过**；③M'-6 的质量门（top-1 一致率 ≥ 基线、单 note 命中主题数 ≤100）**没有落地**，真库实测 3/4 个 note 命中 112–160 个主题（超 100）、top-1 仅 2/4 一致；④lessons 非空时两块会被整体丢弃且无告警（实测 6,019 字 lesson ⇒ 预筛/检查点均 0，总长 11,032 > 10,500）；⑤新门 `_test-dream-prescreen.mjs` 在根目录，被 `.gitignore /_*.mjs` 忽略，**不 `-f` 就进不了库**；⑥摘录 400 上限被「两句 join 空格」突破（实测 401）。 |
| **建议项** | 7 | 见 §7（A1 未排除 `会话检查点·*` 线主题、A2 取数口径与护栏口径不一致、预算截断分支无门、死代码、文档口径修正等） |

**一句话**：实现是「照 §7 做的」，但 §7 的空轮短路必要条件本身不成立（审计②给的算式在真库上被 136 个大明细/索引主题废掉），而新门又恰好用空库把这个失效掩盖了；外加一条已跟踪门被签名漂移打红。这些是**局部可修**的，不需要推翻实现，所以是「有条件通过」。

---

## 1. 改动集边界（先证明「审的是 Part A」）

`git diff --no-index`（部署件 4.5.12 → 工作区 4.5.13）= **509 行 / +478 −31**，全部落在：

| 区域 | 行（工作区） | 内容 |
|---|---|---|
| `listOverLimitTopicsFromDb` | 4003-4022 | `excludeNotes` 选项（P0-2/M'-4） |
| `listReviewQueueFromDb` | 4039-4044 | 新增 `rowsOpt` 复用（P0-4） |
| A1/A2 纯函数 | 4618-4918 | token/词典/df/打分/摘录/检查点证据（新代码） |
| `buildDreamPromptLibrary` | 4920-5109 | rows/noteStats 复用、`_PS_PH` 占位与双预算插入、`_noteRowsAll` 提升、返回值加 `prescreen`/`checkpointEvidence` |
| `buildOverLimitHealthLibrary` | 5122-5129 | `excludeNotes:true`（S'-1） |
| flag 四处 | 7688 / 7754 / 7837 / 13612（+ 热更新 13632） | `dreamPrescreen` |
| `p25SessionTopicWriteGuard` | 9553-9560 | 新增 `rowsOpt`（不传=旧行为） |
| `applyPatches` 整批预扫 | 14115-14159 | P25 检查点整批拒 |
| `applyDreamPatchesToDb` | 13949 / 13991 | topic 寻址 / file 寻址兜底逐条拒 |
| split 源 / review merge into | 19448-19451 / 19571-19574 | P25 护栏 |
| `spawnIntegrate` 空轮 | 21196-21235 / 21267-21269 | `_dreamEmptyRound` 统一收尾 + 库模式短路 |
| 测试钩子 | 14461-14477 / 20861-20867 | `setCfg` / `promptBuildCount` / rows 透传 |

**md 路径**：Part A 只在 `buildDreamPrompt` 里加了一个计数（20862）与 rows 透传（library 分支），md 分支代码零改动；`buildDreamPromptLibrary`/`buildOverLimitHealthLibrary` 都是库模式专属。**静态可证 md 逐字不变**，且 §5.4 有实测 sha 对照。

---

## 2. M'-1~M'-11 逐条复核

判定口径：**已解决** = 代码落地且实测符合；**部分** = 落地了但验收判据不成立/门缺失；**未解决** = 会错。

| # | 判定 | 复核证据（文件:行 / 实测） |
|---|---|---|
| **M'-1** 预算（A 案） | **已解决** | 常量与 §7.2 一致：note ≤5（`index.js:4635`）、每 note ≤3 关联（4636）、块 ≤4600（4637）、总 ≤10500（4638）、摘要 ≤80（4643）、单句 200 / 累计 400（4641-4642）。**双上限门真在门里**：`_test-dream-prescreen.mjs:166`（块 ≤4600，且 `psChars>0` 防空转）、`:168`（总 ≤10500）、`:167`（检查点证据 ≤1200）。实测真库：块 3,263 / 总 9,224 / 检查点 945，均达标（§5.1）。⚠ 预算**截断分支**（`dreamPrescreenNoteLinks:4835` 的 `break`）无门覆盖，见 §4.3。 |
| **M'-2** P0-4 空轮短路 | **部分** | ✅ 仅库模式（`index.js:21222` `if (TOPICDB.enabled && TOPICDB.ready && TOPICDB.store)`）；✅ md 不短路（实测 md 空夹具 `buildPrompt` 仍被调用 1 次，§5.5）；✅ 复用**同一**空轮收尾（`_dreamEmptyRound` 21200-21214，旧内联块已被替换，diff 逐字段一致：`lastIntegrateAt` / `delete lastFailAt` / `DREAM_TRACK=null` / `DREAM_PATCH skipped` / `DREAM_LISTENER=null` / `return "skipped"`）；✅ `rows`/`noteStats` 复用（`buildDreamPromptLibrary:4925-4930`、`:5039`），门 P0-4a/b 实测「传 rows 自取 0 次 / 不传恰 1 次」。❌ **目标落空**：廉价必要条件 `_preRows.some(t => t.chars > 9000)`（21228）在真库**恒为真**——实测 136 个非归档主题 `chars>9000`（main 0 / detail 133 / index 3），而按本档上限的真实超限 = **0** ⇒ 短路**永不触发**，空轮仍付 `buildPrompt` ~2.0s。隔离实测：空库 ⇒ 短路生效（buildPrompt 0 次）；detail 档 12,005 字主题（未超 40,000）⇒ **不短路**（buildPrompt 1 次）；7,004 字 ⇒ 短路（0 次）——证明差别只来自 9,000 这个过粗阈值。现有门用**空库**当 fixture（`_test-dream-prescreen.mjs:384-412`），恰好绕开该形态 ⇒ 门空转（§4.2）。 |
| **M'-3** P0-0 + 基线定义 | **已解决** | P0-0 作用域修复在 `index.js:4931-4934`（`_noteDistilled` 提到函数作用域）；**未回退**：真库 flag 关任务书含「会话笔记提炼」块（`hasNoteBlock=true`，5,013 字），门 `test/_dream-cand-selftest.mjs:179-193` 断言含块 + 哨兵。基线定义已按要求写明「同提交、P0-0/P0-2/P0-4 落地后、flag 关的 golden，只防未来回归，不证明 flag 关=旧字节」（`_test-dream-prescreen.mjs:39-43`）。✅ 我另做了**跨版本实证**：真库上 4.5.13 flag 关的库模式任务书 sha16 = 4.5.12 = `486b1075af736bdb`（均 5,013 字）⇒ 当前库状态下 flag 关确实等于旧字节（P0-2 因「真库当前无超限主题」而未改变任何字节）。 |
| **M'-4** overTopics 排除笔记（源头一处） | **已解决** | 源头一处：`listOverLimitTopicsFromDb:4009/4022`；三处同口径：渲染 `buildDreamPromptLibrary:4937`、空轮判定用**同一份返回值** `overTopics`（`_dp.overTopics` → 21241/21267）、记账 `buildOverLimitHealthLibrary:5128`。行为门：`_test-dream-prescreen.mjs:260-274` 造 9,500 字笔记 ⇒ 任务书 `overTopics` 与 `stuck` 均不含它（实测 PASS，`[]`）。「同一 topicId 完整明细块 ≤1 次」按 §7.5 删除，未补替代断言（低价值，见 §4.3）。⚠ **overLimitStuck 历史键**：`buildOverLimitHealthLibrary` 每轮从零重建 `stuck` 并整包覆盖（`index.js:21515-21519`）⇒ 笔记的历史 stuck 键会被清掉——这正是 S'-1 的**意图**；其他主题键的行为与 4.5.12 一致（真库当前 `overTopics=[]`，两版都写 `{}`），**未发现误清非笔记键**。 |
| **M'-5** P25 护栏覆盖 | **已解决** | 四处全落：①`applyPatches` 整批预扫（14115-14159，`dbPatchGuardTopic` 一次解析 **topic 与 file 双寻址**都覆盖，命中即 `P25_SESSION_TOPIC` + `rejected:true` + `wrote:0`，**整批不落盘**）；②`applyDreamPatchesToDb` 兜底逐条拒（topic 13949 / file 13991）；③`split_topic` 源（19448-19451，放在 `NOT_OVERSIZED` **之前**，实测真检查点 1 句也会被拦）；④`review_topic` merge 的 `into`（19571-19574，在 append/归档**任何副作用之前**返回）。门 G2-1~G2-12 全 PASS：整批拒、句数不变、同批普通主题不落盘、merge 被拒后源主题仍 `needs_review`、rename 仍 `SYSTEM_TOPIC_READONLY`、**普通主题 append 零误伤**。真库：47 个检查点 **47/47 父线完整**（`cpNoParent=[]`、`cpParentMismatch=[]`）⇒ 双条件护栏对现网检查点全覆盖。 |
| **M'-6** token 生成与质量门 | **部分** | ✅ 词典 = 主题名 + `effectiveTriggers`（`index.js:4784-4792`，rows 已带、零额外读库）；✅ note 端 2–4 字滑窗/英文 token **必须命中词典**才计入（4711-4718）；✅ df 权重 `log(1+N/df)`（4717，N=非归档 575）；✅ ≤64 **按权重取**（4720-4722，非前缀截断）；✅ 每 note ≤3 关联（4758）、摘要 ≤80（4753）、命中 token ≤3（4760）。❌ **质量门完全缺失**：方案/审计要求「同一批 6 个真笔记 top-1 与工作区线一致率 ≥ 先测基线」+「单 note 命中主题数 ≤100」，新门里**一条都没有**（`_test-dream-prescreen.mjs` 只有 `A1-9 至少一个 note 命中`）。真库实测（§5.3）：单 note 命中候选主题 **77 / 112 / 116 / 160**（3/4 超 100），top-1 与工作区线一致 **2/4**，其中 T-0596（长沙交易场地）与 T-0593（Desktop-agent 周事项）**3 个关联全错**（跨工作区误召回实锤）。 |
| **M'-7**（v2 审计原文 = G6 面板正则） | **不涉及** | 本轮只审 Part A（dream 预筛/检查点证据/护栏/空轮），面板 B1/B2 不在工作区改动集内（§1 diff 无面板代码）。任务书把「flag 四处落点」记在 M'-7/M'-11 名下 ⇒ 见 M'-11 行。 |
| **M'-8** 面板取数 | **不涉及** | 同上（Part B 未实现）。 |
| **M'-9** 面板 cost 单一来源 | **不涉及** | 同上。 |
| **M'-10** G1 窗口 + A1 静态断言 | **已解决** | G1 窗口严格限定 `buildPrompt()` 前后（`_test-dream-prescreen.mjs:122-138`：`hitSnap()` 在 buildPrompt 前/后各一次，并先 `store.markHit` 造非空 lastHitAt ⇒ **非空转**）；静态断言剥注释后断言 A1 源码段不含 `markTopicHits` / `topicDbSearchTopics` / `searchSentencesByTokens`（143-145，`segOf` 段长 12,398 字 ⇒ 定位有效）。真库副本 `buildPrompt` 前后 lastHitAt 0 变化（我的探针亦未观测到写入）。 |
| **M'-11** flag 落点 + 热更新 + sha16 基线 | **已解决** | 四处全落：`DEFAULT_CFG.dreamPrescreen=true`（7688）、`SETTINGS_SCHEMA` 布尔字段（7754）、`normalizeCfg` 布尔归一（7837）、`/dsh-memory/config` 的 `WRITABLE`（13612）；热更新走 POST → `writeUserCfg` → `PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config))`（13632），非法值被归一（7837）。门 S-1~S-4 静态断言 + G4h 热更新行为（关→块消失、开→块回来）实测 PASS。**sha16 基线**：硬编码 `GOLDEN_SHA16="007e7591457ec432"`（`_test-dream-prescreen.mjs:43`）确实是「自己生成自己比对」（测试注释已如实写明只防回归）；我用 4.5.12 部署件做了**独立**对照（§5.4），结论一致 ⇒ 这一条不算自证问题，但门里没有「跨版本」证据，只有 golden。 |

---

## 3. 新失效路径（≥3，全部带实测）

### N-1【中·M'-2 目标失效】空轮短路的必要条件在真库恒真 ⇒ P0-4 白做
- 事实：`index.js:21228` `_overPossible = _preRows.some(t => Number(t && t.chars) > PROJECT_CHAR_HARD)`；真库 575 非归档主题中 **136 个 `chars>9000`**（detail 133 / index 3 / main 0），而按本档上限（main 9000 / detail 40000 / index 200000）的真实超限 = **0**（`probe-real2.mjs`）。
- 后果：任何「无活」轮（无待提炼笔记、无 lesson）都会因 `_overPossible=true` 跳过短路，白付 `buildPrompt` 实测 **2,019–2,154ms**（其中 `listOverLimitTopicsFromDb` 是 4.5.12 审计实测的 1.33s 主体）；而预筛本身只 103ms。
- 证据（隔离 fixture，`probe-p04.mjs`）：空库 → 短路（`buildPrompt` 0 次）；detail 档 12,005 字主题（**未超** detail 40,000 上限、无笔记/lesson）→ **未短路**（`buildPrompt` 1 次，仍返回 skipped）；7,004 字 → 短路（0 次）。
- 根因是 §7.3 给的算式太粗（`chars>9000` 只对 main 档是充分必要条件），实现忠实照做 ⇒ 这是**方案继承缺陷**，但验收门用空库把形态绕开了，必须补。

### N-2【中·M'-6 未达标】词典命中仍严重泛化 + 跨工作区误召回
- 真库 4 个未提炼笔记（`probe-4513.mjs`，与实现同口径：词典命中 + 按权重取前 64 token）：单 note 命中候选主题 **77 / 112 / 116 / 160**（候选池 503）⇒ 3/4 超 M'-6 的 ≤100 上限。
- top-1 质量：`T-0575 徕卡一瞬 → T-0119 徕卡一瞬 · …`✅、`T-0590 dsh远程访问 → T-0405 dsh远程访问（项目线）`✅、`T-0596 长沙交易场地智能化 → T-0179 MEMORY-徕卡一瞬 …`❌、`T-0593 Desktop-agent周事项 → T-0274 月度报销日志合同对账`❌（2/4）。T-0596 的 3 个关联全是徕卡/省本级周报（跨工作区）；T-0593 的 3 个全是报销/长沙调研。
- 缓解：任务书写了「预筛关联是线索不是结论 / 不得仅凭预筛关联做 merge」，所以**不会直接导致误 merge**；但噪声会消耗 dream 的读预算，且「关联主题」看起来很像结论。审计① F-2 的担忧没有真正消除。

### N-3【中·新】lessons 非空时两块被整体丢弃且无告警（预算被吃光）
- 实测（`probe-edge.mjs`，真库副本 + 6,019 字 `lessonFeedText`）：`_cap1 = min(4600, max(0, 10500−base−2))` 被压到 0 附近 ⇒ **预筛块 0 字、检查点证据块 0 字**（`prescreen.chars=0`、`checkpointEvidence.chars=0`），总长 **11,032 > 10,500**；除一条 `prescreen notes=0 … chars=0` 的 monitor 事件外**没有任何告警**。
- 即：真实轮次只要待沉淀 lesson 较多（10 条 lesson ≈ 2–3K 字），A1/A2 的指引就会**静默消失**；而门 G4c「总 ≤10,500」只在空 lesson fixture 上成立（6234 字，离上限很远）⇒ 门测不到。总长上限的语义其实是「**新块 + 基线 ≤ 10,500（当基线本身 ≤10,500）**」，方案文字「任务书总 ≤10,500」过强。

### N-4【低·新】A2「只读证据」取数口径 ≠ 写入护栏口径 ⇒ 可展示又可写
- A2 取数判据只有名字形态（`dreamCheckpointEvidence:4881-4886`：`isSessionTopicName && !isNoteTopicName && !archived`），而 P25 写入护栏是**名字 + 父线双条件**（`p25SessionTopicWriteGuard:9593-9599`）。
- 隔离实测（`probe-guard.mjs`）：造一条名字像检查点、**无父线**的主题 `E-工具-伪造项目/deadbeef` ⇒ ① 它被 A2 当「只读证据」渲染进任务书（`items=1`，`includesFake=true`）；② `hooks.apply([{topic:它, append}])` **成功**，句数 1→2（护栏因父线缺失放行）。对照真检查点：`P25_SESSION_TOPIC` 拒、句数不变。
- 触发面：模型可用 `memory_split_topic` 的**目标名**造出这种形态（目标名自由），下一轮它就成了 A2 证据；现网 47/47 检查点父线完整，所以当前不可利用，但口径不一致是结构性的。建议 A2 取数改用与 guard 同一判据（名字+父线）。

### N-5【低·新】摘录 400 上限被 join 空格突破
- `dreamPrescreenSnippet` 累计只算 `piece.length`（`index.js:4697`），最后 `parts.join(" ")`（4699）⇒ 两句各 200 时 `excerptLen=401`。真库实测 T-0575/T-0590 的 `excerptLen` 均为 **401**（§5.1）。预算影响可忽略（5 note × 1 字），但「累计 ≤400」这条不变量在代码与门（G3a 只测单句 1,881 → 200）里都没有被真正守住。

---

## 4. 门质量

### 4.1 新门实测（我复跑，非采信自报）
| 门 | 实测 |
|---|---|
| `_test-dream-prescreen.mjs`（新，85 条） | **PASS 85 / FAIL 0 / SKIP 0**（与自报一致） |
| `test/_dream-cand-selftest.mjs`（扩展 P0-0 + G1/G4） | **全部通过 22/22** |
| `test/_p25-write-guard-selftest.mjs` | **PASS 47 / FAIL 0 / SKIP 2** |
| `test/_dream-split-tool-selftest.mjs` | 25/25 |
| `test/_dream-empty-note-selftest.mjs` | 16/16 |
| `test/_p25-selftest.mjs` | ✅ 全通过 |
| `test/_accept-p4.mjs` | **PASS 98 / FAIL 0 / SKIP 0** |
| **`test/_dream-review-tool-selftest.mjs`** | **4.5.13：38 PASS / 1 FAIL；4.5.12 部署件：39/39 全通过 ⇒ 本轮引入的回归** |

### 4.2 空转/弱断言（逐条）
1. **P0-4 门空转（最重要）**：`_test-dream-prescreen.mjs:384-412` 用**全新空库**（0 主题）当「空轮 fixture」⇒ 短路当然生效。真库形态（大量 `chars>9000` 但未超本档上限）下短路不触发（N-1）。**该门目前不能证明 P0-4 在真实库上有效**。
2. **G4a/G4c 弱**：fixture 块 1,112 字（上限 4,600）、总 6,234（上限 10,500），离上限都很远 ⇒ 断言虽真但**预算截断分支**（`dreamPrescreenNoteLinks:4835` 的 `break` + `dropped`）**没有任何门覆盖**；`dropped=1` 来自 `maxNotes=5` 的截断，不是预算截断。检查点证据块的 `break`（`:4903`）同样无门。
3. **M'-6 质量门缺失**（见 M'-6 行）：top-1 一致率、单 note 命中 ≤100 都没有断言；`A1-9` 只要求「≥1 个 note 有命中」，在真库数据上必过 ⇒ 无鉴别力。
4. **md 模式无行为 fixture**：M'-2 要求「md fixture 断言不受影响（仍会发起）」，新门只有静态断言 S-6（源码含 `if (TOPICDB.enabled…`）；md 行为是我用探针补测的（md 空夹具 `buildPrompt` 仍被调用 1 次）。
5. **M'-4 的替代门**（「完整明细块 ≤1 次」）未实现（价值低，但方案 §7.5 明确要求过）。
6. **负例鉴别力总体尚可**：G2-1/3/5/8/11 都是行为负例（真临时库 + 真工具 execute，拒绝码逐条断言），G4g 用 golden 防字节漂移，G1d-f 用静态负例（旧字节必红）。这部分是合格的门。

### 4.3 新门被 `.gitignore /_*.mjs` 忽略的影响
- `git check-ignore -v _test-dream-prescreen.mjs` ⇒ `.gitignore:30:/_*.mjs`；`git ls-files` 里**没有**它 ⇒ 若正常 `git add -A` 提交，**85 条门全部丢失**；`_run-suite.mjs:51` 扫根目录 `_test-*.mjs`，所以在干净 checkout 里套件会少 85 条（而实现者本机的「85/0」不可复现）。
- 缓解：`test/_dream-cand-selftest.mjs`（**已跟踪**）只覆盖 P0-0 + G1/G4 的一个子集；G2（P25 护栏）、P0-2、P0-4 的行为门**只存在于这个被忽略的根文件里**。
- 另一个连带问题：`_run-suite.mjs` 的 `TEST_DIR_GATES` 是**硬编码允许清单**（`_run-suite.mjs:58-67`，8 个 test/ 门），`_dream-review-tool-selftest` / `_dream-split-tool-selftest` / `_dream-empty-note-selftest` **都不在**里面 ⇒ 这几个已跟踪门从未进套件，正是本次 `review-tool` 变红没被发现的制度原因。

---

## 5. 实测复核（预算 / 耗时 / top-1 质量 / md / flag）

> 全部在 `os.tmpdir()` 的真库**副本**上跑；4.5.12 = 部署件，4.5.13 = 工作区。

### 5.1 预算（真库副本，flag 开）
| 量 | 实测 | 上限 | 判定 |
|---|---|---|---|
| 任务书总 | **9,224 字** | 10,500 | ✅ |
| 预筛块 | **3,263 字**（4 note / 12 关联 / fallback 0 / dropped 0） | 4,600 | ✅ |
| 检查点证据块 | **945 字**（3 项；第 4 项正文空被跳过） | 1,200 | ✅ |
| 摘录长度 | 200 / 200 / 401 / 401（两句 join 后超 1 字，见 N-5） | 400 | ⚠ 401 |
| flag 关（库模式） | **5,013 字**，含「会话笔记提炼」 | — | ✅ |
| md 模式 | **8,589 字** | — | ✅ |

### 5.2 耗时（真库副本）
| 量 | 实测 |
|---|---|
| `buildPrompt()` 总 | **2,019–2,154 ms**（4.5.12 同库 2,154 ms ⇒ Part A 未使构建变慢） |
| 预筛（纯函数直调） | **103 ms**（`__dreamPrescreenNoteLinks`，含 5 次 readTopic + 5 note 的 token 化） |
| 检查点证据（纯函数直调） | **10 ms** |
| `store.topics()` | **48 ms**（607 主题） |
| 结论 | 预筛只占构建 ~5%；P0-4 想省的仍是 `listOverLimitTopicsFromDb`（审计②实测 1.33s / 84%），**方向对但 N-1 使省时落空** |

### 5.3 top-1 质量（真库 4 个未提炼笔记，口径见文首）
| note | 未提炼 | 命中候选主题数 | top-1 | 与工作区线一致 |
|---|---|---|---|---|
| T-0575 `笔记·E-工具-徕卡一瞬/02d20bfe` | 2 句 | **77** | T-0119「徕卡一瞬 · 2026-10-25/26 …」 | ✅ |
| T-0590 `笔记·E-工具-dsh远程访问/ccc872ea` | 2 句 | **160** | T-0405「dsh远程访问（项目线）」 | ✅ |
| T-0596 `笔记·C-1_长沙-1、交易场地智能化系统升级改造（大模型应用）项目/a19090bb` | 1 句 | **112** | T-0179「MEMORY-徕卡一瞬 · 融合主包导入通道」 | ❌（3 个关联全错） |
| T-0593 `笔记·C-Desktop-agent周事项/bca1141e` | 1 句 | **116** | T-0274「月度报销日志合同对账」 | ❌（3 个关联全错） |
| **合计** | 6 句 | 3/4 超 100 | **2/4 一致** | 实现者自报 1/3，同量级 |

### 5.4 md 逐字不变 / flag 关 = 4.5.12（跨版本实证，非自证）
| 对照 | 4.5.12 部署件 | 4.5.13 工作区 | 结论 |
|---|---|---|---|
| 库模式 flag 关（真库） | 5,013 字 / sha16 `486b1075af736bdb` | 5,013 字 / sha16 `486b1075af736bdb` | **字节相同** ✅ |
| md 模式（真库 + 同夹具） | 8,589 字 / sha16 `30e3516816985dc2` | 8,589 字 / sha16 `30e3516816985dc2` | **字节相同** ✅ |
| 说明 | sha16 均对时间戳/日期归一化后取（`normPrompt`）；P0-2 在当前库状态（无超限主题）下不改字节，故 flag 关能对上 4.5.12 | | |

### 5.5 空轮短路行为（隔离 fixture，`probe-p04.mjs`）
| fixture | 返回 | `buildDreamPrompt` 调用 | 账本 | 判定 |
|---|---|---|---|---|
| 空库（=现有门） | skipped | **0** | lastIntegrateAt 写入 / lastFailAt 清 / status=skipped | ✅ 短路生效 |
| detail 档 12,005 字（未超 40,000）、无笔记/lesson | skipped | **1** | 同上 | ❌ 短路失效（N-1） |
| detail 档 7,004 字 | skipped | **0** | 同上 | ✅ 阈值边界确认 |
| **md 模式空夹具** | skipped | **1** | 同上 | ✅ md 未被短路（M'-2 要求） |

### 5.6 其它实测
- 真库 607 主题 / 575 非归档 / 22 笔记（4 未提炼 = 6 句）/ 47 检查点（**47/47 父线完整**）/ 真实超限主题 **0**。
- `applyPatches` 整批预扫不误伤：普通主题 append 成功（G2-12）；真检查点 append / split 源 / merge into / rename 全部按预期拒。
- 预筛零 `markTopicHit`：真库副本 `buildPrompt` 前后 lastHitAt 0 变化（G1 同口径）。

---

## 6. 必须修改项（逐条可验收）

| # | 必须修改 | 验收判据 |
|---|---|---|
| **I'-1** | **修已跟踪回归门 + 补进套件**：`test/_dream-review-tool-selftest.mjs:65` 的 `M` 断言写死旧签名 `/function listReviewQueueFromDb\(store, maxN\)/`，4.5.13 已改 `(store, maxN, rowsOpt)` ⇒ 该门红。改为接受可选第三参；并把 `_dream-review-tool-selftest` / `_dream-split-tool-selftest` / `_dream-empty-note-selftest` 加入 `_run-suite.mjs:58-67` 的 `TEST_DIR_GATES` | `node test/_dream-review-tool-selftest.mjs` ⇒ **39/39 且 exit 0**；`node _run-suite.mjs` 红集合回到基线 9（清单校验/freeze-sync 同因除外，如实注明） |
| **I'-2** | **让 P0-4 在真库形态下真生效**：把廉价必要条件从 `chars>9000` 改为「按本档上限」的必要条件（可用 `topicDbLevelMap` 一次性拿档位，O(主题) 廉价；`main>9000 / detail>40000 / index>200000`），或至少排除 detail/index 档；并保留「判定失败按可能有活」的保守分支 | 新增 fixture：detail 档 12,000 字主题 + 无笔记 + 无 lesson ⇒ `spawnIntegrate` 返回 skipped 且 `buildDreamPrompt` **未调用**（当前实测被调用 1 次）；真库「无活」状态下同样不调用 |
| **I'-3** | **补 M'-6 质量门**：新增断言（真库或固定夹具 6 个真笔记）①单 note 命中候选主题数 **≤100**；②top-1 与 note 所属工作区线一致率 **≥ 先测基线**（基线须写死并注明测法）。若实现不改，则须把 M'-6 判据在方案里降级并写明（不建议） | 门里两条断言存在且可复现；当前真库数据下 ①会红（112/116/160）⇒ 需同时给出实现侧的收敛手段（如提高词典命中门槛/按权重取更少 token/给 df 设上限）或明确接受「线索噪声」并在任务书里加更硬的「只作线索」提示 |
| **I'-4** | **lessons 非空时的预算语义**：①monitor 事件加「预算耗尽/块被丢弃」标记（如 `droppedBudget=1` 或 `ckpt=0` 已有则补 `budget=exhausted`）；②门补一条 `lessonFeedText` 非空的用例，断言「总 ≤10,500 **或** 至少保留 1 个 note 块 + 有告警」；③方案文字把「总 ≤10,500」改成「新块 + 基线 ≤10,500（基线 ≤10,500 时）」 | 门里新用例通过；实测 6,019 字 lesson 时不再**静默**丢两块（有告警或仍保留部分块） |
| **I'-5** | **新门入库**：把 `_test-dream-prescreen.mjs` 移到 `test/` 并登记进 `TEST_DIR_GATES`（推荐），或 `git add -f` 并在 `.gitignore` 写明例外 | `git ls-files` 含该门；`git check-ignore` 不再命中；干净 checkout 里 `node _run-suite.mjs` 能跑到这 85 条 |
| **I'-6** | **摘录 400 严格化**：`dreamPrescreenSnippet` 把 `join(" ")` 的分隔符计入累计（或断言改 ≤401 并同步预算算式）；门加「两句各 200 ⇒ ≤400」用例 | 真库 T-0575/T-0590 的 `excerptLen` ≤400；新用例存在 |

---

## 7. 建议项（不阻塞）

| # | 建议 |
|---|---|
| **S'-1** | **A1 关联目标排除 `会话检查点·*` 线主题**：`dreamPrescreenExcluded` 只排 `<wsKey>/<sid8>` 形态，线主题（`会话检查点·E-工具-dsh远程访问`）会作为关联出现（真库实测 T-0591 与项目线 T-0405 同分 8.609 并列 top）。建议按 `n.indexOf("会话检查点")===0` 排除（与 rename 保护同口径）。注：线主题进入**候选池**是 4.5.12 既有行为，非本轮引入。 |
| **S'-2** | **A2 取数与护栏同口径**（N-4）：`dreamCheckpointEvidence` 的过滤改为「名字 + 父线」双条件（复用 `p25SessionTopicWriteGuard` 的判定），避免「展示为只读、实际可写」的口径错位。 |
| **S'-3** | 预算截断分支补门：直接调 `__dreamPrescreenNoteLinks(rows, notes, {blockCap: 500})` 断言 note 级截断 + `dropped` 计数（现有门只覆盖 `maxNotes` 截断）。 |
| **S'-4** | df 计算把笔记/检查点/索引主题也算进 `tokenTopics`（先建词典后排除候选）⇒ df 轻微高估、权重轻微低估；影响小，可留，但值得一行注释说明。 |
| **S'-5** | 死代码/小洁癖：`dreamPrescreenNoteLinks:4778` 的 `cands` 数组未被使用；`_test-dream-prescreen.mjs:178` 的 `isCp` 定义未使用。 |
| **S'-6** | 文档口径修正：M'-2 的「`store.topics()` 每轮只调 1 次」实际为 **2 次**（预信号 1 次 + `noteTakeDreamSnapshots:21284` 1 次，后者既有）；门 P0-4a/b 只覆盖 `buildDreamPromptLibrary` 内部计数，建议在方案/实现注释里写明口径。 |
| **S'-7** | 实现者自报的「真库副本 flag 关 4,947 / 开 8,176」在当前库状态不可复现（我实测 5,013 / 9,224）；不是缺陷，但**验收报告应引用可复现的命令 + 当时库快照**，否则无法复核。 |

---

## 8. 回滚

| 改动 | 回滚方式 | 可逆性 |
|---|---|---|
| A1 预筛块 + A2 检查点证据块 | `dreamPrescreen=false`（`/dsh-memory/config` POST 或 `.config.json`；热更新生效） | **可逆**。实测 flag 关任务书与 4.5.12 字节相同（§5.4），两块零残留字节 |
| **P0-1 P25 检查点护栏**（applyPatches 整批预扫 / applyDreamPatchesToDb / split 源 / review merge into） | **不在 flag 后**，只能回退 `index.js`（git） | 可逆（纯代码，无 DB schema/迁移）。这是安全修复，**不建议**单独关 |
| **P0-2 overTopics 排除笔记**（渲染/空轮/记账三处） | **不在 flag 后**，只能回退 `index.js` | 可逆；回退后「笔记超限」死胡同会回来（S'-1 白做） |
| **P0-4 空轮短路**（`_dreamEmptyRound` + 预信号） | **不在 flag 后**，只能回退 `index.js` | 可逆；回退后回到 4.5.12 的「先算后丢」语义（账本字段完全一致，无残留状态） |
| 门 | 新门/扩展门为纯测试文件，删除即可 | 可逆；但注意 `_test-dream-prescreen.mjs` 未入库（I'-5），回退代码后它会变成「测已不存在行为」的孤儿门 |
| 数据库 | Part A **无 schema/迁移/数据改写**（只读 + 内存打分 + 拒绝路径），真库无残留 | 无需回滚 |

---

## 附：本轮探针清单（`os.tmpdir()/audit4513/`，不在仓库内）

| 探针 | 用途 |
|---|---|
| `probe-4513.mjs <index> <out> lib|md` | 真库副本 → 任务书长度/块长/耗时/overTopics/笔记命中数/top-1/flag 关 sha16（4.5.12 与 4.5.13 各跑一遍） |
| `probe-p04.mjs` | P0-4 短路四形态（空库 / detail 12K / 7K / md） |
| `probe-guard.mjs` | A2 证据可否被「无父线检查点名」污染 + P25 护栏是否拦得住 |
| `probe-real2.mjs` | 真库检查点父线完整性 / `chars>9000` 分档 / 真实超限数 |
| `probe-edge.mjs` | lessons 非空时双预算的实际行为 |
