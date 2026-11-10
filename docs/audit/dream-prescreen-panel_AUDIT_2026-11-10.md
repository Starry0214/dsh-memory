# dream 预筛 + 记忆面板 v2 · CRA 审计（2026-11-10）

> 审计员：独立只读审计（CRA 第一轮 · **审方案，不审实现**）
> 被审对象：`docs/方案-4.5.12-dream预筛与记忆面板v2.md`（197 行，未提交）
> 仓库：`E:\工具\插件开发调整\dsh-memory-plugin` · main · HEAD `e0a9be5` · 工作区含 4.5.10/4.5.11 未提交改动
> 方法：**观测优先**。方案里每个行号/结论都不采信，全部回代码复核；每个数字都在**临时库副本**上独立复算。
> 证据边界（诚实声明）：
> - 库数据 = `C:\Users\Starry\AppData\Local\Temp\audit-4512-111907\`（`mem.db` + `-wal` + `-shm` 全量复制，11:19 快照，`readOnly:true` 打开）。**真实库零写入**。
> - 活库口径交叉核对 = 只读 GET `/dsh-memory/stats.json`（11:33）与 `/dsh-memory-panel/snapshot.json`（11:36）。
> - **未**运行 `_run-suite.mjs`（任务书禁）、**未**改 created-plugin、**未**构建/部署/提交。唯一写操作 = 本文件 + `os.tmpdir` 下 4 个探针脚本。
> - 任务书静态字符数（≈3,919 字）是**字符串字面量统计的估算**，不是跑出来的任务书实测值；已在正文标注。

---

## 结论

**驳回（需修订后重新送审）。**

方案方向正确（Part A 的「规则化预筛」与 Part B 的「面板分区化」都是对的），但**三个核心假设与代码/真库事实不符**，且存在 **2 条会静默写坏真源/静默抑制生命周期**的实现级风险。按现方案实现，最可能的结果是：预筛块预算超 4 倍、30% 的 note 拿不到摘录、关联主题大面积误召回、每次 dream 静默把最多 80 个主题标记为「被使用」，以及面板口径与浏览器面板**永远对不上**却写进了验收判据。

| 级别 | 数量 | 摘要 |
|---|---|---|
| **驳回项（必须重写方案）** | 3 | ①A1 检索路径与算法自相矛盾且实测不可用（含 1255-token 直接抛错、无 IDF 大主题霸榜）；②预算 4000 字与实测 15,960 字差 4 倍、摘录算法实测产出 3/10 空摘录；③B2「口径与 `topicDbStatsSnapshot()` 一致」在**不改主插件**的前提下不可达（实测 `checkpointTopics` 0 vs 49、`sentences` 33,636 vs 33,915） |
| **必须修改（可实现但现状会出错）** | 12 | 见文末 M-1~M-12（每条带可验收判据） |
| **建议项** | 8 | S-1~S-8 |
| **结论性裁决** | D-1 不合理 / D-2 **不够** / D-3 不够但**不需要 embedding** / D-4 需明确为「附加不占位」/ D-5 方案选项描述不完整 / D-6 同意 | 见「D-1~D-6 裁决」 |

**最关键的一条**（优先级高于其它所有项）：`topicDbSearchTopics()` 内部**无条件调用 `markTopicHits()`**（`index.js:8224`），而 `markTopicHits` 写的是 `topics.last_hit_at`，`lifecycle.isRenewed()` 正是靠它决定「90 天到期是否归档」（`memtopic/src/lifecycle.mjs:62-67`）。A1 若照方案「复用 `topicDbSearchTopics`」做预筛，**每轮 dream 会把最多 10×8=80 个主题标记为「被检索使用」**——而被预筛命中的恰恰是最大/最老的主题（实测 top-3 恒为 T-0002 / T-0469 / T-0472）。后果：生命周期老化被系统性抑制、且**不可回滚**（时间戳已落库，无审计可反演）。这一条必须在方案里显式处理，不能留给实现者「顺手复用」。

---

## 现状核对（逐条，文件:行）

测量基线：副本快照 `topics=607`、非归档 `575`、`byState={draft:44, active:223, dormant:308, archived:32}`、物理句 `33,912`、`meta` 5,639 行、`merge.index` 0 条、`deleted.index` 278 条 sentenceId 墓碑。

### 1. 候选池「笔记优先 ≤10 + 活跃补足 20」——**成立，但「活跃」措辞失真**

`index.js:4644-4651`：

```js
const _pool = _live.filter((t) => !INDEX_TOPIC_NAME_RE.test(t.name) && !/^笔记·/.test(t.name) && !_isCpTopic(t));
const _notePick  = _sorted(_notePool).slice(0, 10);
const _otherPick = _sorted(_pool).slice(0, Math.max(10, 20 - _notePick.length));
candTopics = _notePick.concat(_otherPick);
```

- 实测：`notePool(未提炼)=11` → `notePick=10`；`pool=503` → `otherPick=10`；合计 **20** ✓。
- 排除项实测：索引类 3、笔记 22、检查点 47（非归档）→ `575-3-22-47 = 503` ✓ 与 `_pool` 自洽。
- **反证（措辞）**：`_pool` 只过滤 `state!=='archived'`，**dormant(308)/draft(44) 全部在内**。方案 §0 写「活跃主题补足到 20」不准确——补足池里 70% 是 dormant。这直接影响 D-4（「兜底池」的语义），也影响 A3 里「冷主题仍可能漏」的判断依据。
- 「冷主题永远排不进」**成立**：`_sorted()` 按 `updatedAt` 倒序（4647），每轮只取最新 10 个（`_otherPick`），**无任何游标**（全仓无 rotation cursor）⇒ 503 个 pool 主题里 **493 个永不进候选**。实测 pool 最冷主题 `updatedAt=2026-10-29`。

### 2. 空轮判定「candI 恒空」——**成立，且这是 A1 的隐性浪费点**

- `index.js:4750` 库模式返回值里写死 `candI: { sessionCands: [], otherCands: [] }`。
- `index.js:20804` 空轮闸：`candI.sessionCands.length===0 && candI.otherCands.length===0 && (_libMode ? overTopics.length===0 : ...) && lessonPickN===0 && !_noteHasWork`。
- ⇒ 库模式下**候选主题（20 个）完全不参与空轮判定**；只有「超限主题 / 待沉淀 lesson / 未提炼笔记」能阻止空轮。
- **对 A1 的直接影响**：`buildDreamPromptLibrary()` 在 `20779` 调用，空轮闸在 `20804`——预筛块会被**先算后丢**。实测 A1 单轮成本 ≈1.5–2.3s（见 A1 性能），空轮轮次白付。

### 3. `noteUnrefinedStats` / `noteTopicDistilled` / `noteUnrefinedCount` 口径——**成立，但「684ms」已过期约 100 倍**

- 口径 A：`noteUnrefinedCount`（`4213-4222`）= 最后一条指针之后的句数，无指针 ⇒ 全部句数。判据 `isNotePointerText`（`4182`，`NOTE_POINTER_RE` at `4170`）。
- `noteUnrefinedStats`（`4225-4246`）：`total` 在 `slice(0,20)` **之前**赋值（`4241-4243`）✓；items 按 count 降序 + id tie-break ✓。
- `rowsOpt` 复用（`4229-4233`）只省掉 `store.topics()`；**每个笔记主题仍走一次 `noteTopicState→readTopic`**（`4236`）。方案 §A1 写「复用已取的 `_allRows`/`_noteRows`，避免重复 684ms 扫描」——省的是 `topics()`，不是逐主题读。
- **反证（684ms）**：副本实测 `SELECT * FROM topics` = **6.3ms**；全量 33,912 句 = 199.5ms；meta 5,639 行 = 7.0ms。`index.js:4224` 与 `13527` 注释里的「684ms/次」是 4.5.9 前的历史值，**当前库规模下不成立**。方案据此论证「复用价值大」属于用过时证据支撑设计。
- 活库交叉：`stats.json` 的 `noteUnrefined` = **11 主题 / 114 句**；副本快照 = 11/112（分钟级漂移，非口径差）。

### 4. `topicDbSearchTopics` 能力边界——**成立但严重不足，是 A1 的致命依赖**

`index.js:8181-8226`。逐项核对：

| 方案假设 | 事实 | 证据 |
|---|---|---|
| 「已含 trigger 匹配」 | 名字/别名/effectiveTriggers 命中 **+3**；正文行命中按「命中 token 数」累加 | `8195-8213` |
| 中文关键词可匹配 | **不能**。`topicDbTokens`（`8114-8120`）只按空白/标点切分，**中文不切词**：一个逗号之间的整段中文 = 一个 token，要求整段逐字出现在主题名或正文里 | `8116` 的 split 正则 |
| 返回结构 | `{ hits: [{topic, score, hits:[≤3 行]}], conflicts }`，`hits` 已按 score 降序截断到 `maxTopics`（默认 6） | `8216-8225` |
| 有副作用吗 | **有**：`markTopicHits(store, hits, "search")`（`8224`）——见「结论」与 M-1 | `8224` |
| 无 IDF/无长度归一 | 成立：大主题靠「句数×命中 token」天然霸榜 | `8208-8213` |

**实测（真库，note 摘录原文直接当 query）**：

- token 数 33–117 个/note；其中大量是**结构标签与日期**：`quote` / `literal` / `observation` / `用户原话` / `2026-11-09` / `11` / `10` / `17`。
- 打分结果：**每一条 note 的 top-3 都是 T-0002「MEMORY-107服务器-dock」、T-0469/T-0472「徕卡一瞬…」**，分数 615–2,304。
- 反例（误召回）：`T-0602`（dsh-memory 插件开发笔记）的关联主题是 **徕卡一瞬相机主题** + MEMORY-107 服务器 —— 与笔记内容无关。
- **1255 个 token 的 query 直接抛错**：`Expression tree is too large (maximum depth 1000)`（`searchSentencesByTokens` 的 `OR LIKE` 子句，`backend-sqlite.mjs:171-184`）。
- 300 token = **4,277.8ms**；14 token = 151.5ms 且命中 **27,034 行（占全库 80%）**——「快路径预过滤」在泛化 token 下几乎不过滤。

### 5. P2.5 检查点主题排除——**成立，但 `isSessionTopicName` 有「也命中笔记」的陷阱**

- `_isCpTopic`（`4640-4643`）→ `p25Topics.isSessionTopicName`；`p25-topics.js:234-251` 正则 `^([^\s/\\]{1,200})\/([0-9a-f]{8})(?:\s*[·・]\s*...)?$`。
- 实测 `isSessionTopicName` 命中 **71** 个主题 = **49 个真检查点 + 22 个 `笔记·<wsKey>/<sid8>`**（笔记名同样以 `/8位hex` 结尾）。
  - 在 `buildDreamPromptLibrary` 里无害（笔记另有 `^笔记·` 过滤，`4645`）。
  - **在 A2 里致命**：方案 A4 明确要「复用 `p25Topics.isSessionTopicName`」取「最近 5 个检查点」⇒ 实测 top-5 = `T-0575(笔记)`、`T-0596(笔记)`、`T-0606(**archived**)`、`T-0604(真检查点)`、`T-0562(笔记)` —— **3 个笔记 + 1 个归档**。见 M-4。
  - `topicDbHierarchy` 自己也踩过这个坑并写了注释（`8690`：「先判：笔记主题名也以 /sid8 结尾，会被会话正则命中」）——方案没有继承这条经验。
- 真检查点 49 个：`active 47 / archived 2`，**49/49 都挂在 `会话检查点·<wsKey>` 线下**。

### 6. dream 能否读到检查点主题（读侧 archived 过滤）——**能读到，且读一次就续期一次**

- `topicDbSearchTopics`：`8194` `if (t.state === "archived") continue` ⇒ **归档检查点检索不到**，47 个 active 检查点**可以**被 `memory_search` 命中。
- `memory_read`（`12596-12632`）：**无 archived 过滤**（`12696` 注释明确「memory_read 仍可读回原文」），且读取会 `markTopicHits(store,[t],"read")`（`12609`）。
- ⇒ A2 让 dream 每轮读 5 个检查点 = 每轮给 5 个检查点续期。检查点本身由 `decideLifecycle`（纯函数，`p25-topics.js:425`）按 keepDays/maxSessions 归档，不看 hit ⇒ 影响有限；但**这是 A1 markHit 问题的同源症状**，说明方案对「读=使用=续期」这条既有语义没有建模。

### 7. note 收敛护栏——**成立，方案引用无误**

| 护栏 | 位置 | 核对 |
|---|---|---|
| 哨兵 JSON | `NOTE_COMPACT_SENTINEL = "<!--DSH_MEMORY_COMPACT_JSON-->"`（`4174`） | ✓；任务书说明在 `4694-4701` |
| `NOTE_TOPIC_DREAM_FORBIDDEN` | `memory_write` `12705`；`dream_patch` **整批拒绝** `13756-13765`；DB 应用兜底 `13576`/`13616`；`split` 源 `19045`；`review into` `19161` | ✓ 5 处覆盖 |
| C2' 判据 | `noteCompactValidate` `4406-4425`：target 必须真实存在 / 非笔记 / 非归档 / `writeCount` 增长（或本轮 `createdAt > spawnAt`） | ✓ 方案「C2'」表述与实现一致 |
| 快照校验 | `noteTakeSnapshot` `4249-4271`（maxId+count+逐句 sha） | ✓ |
| 指针不采信模型文本 | `4466-4481`：一律重生成 + 严格判据复校 | ✓（方案未提，实现已更强） |

**反证（对 A2 重要）**：`memory_dream_patch` 的 DB 应用路径（`applyDreamPatchesToDb` `13547-13619`）**只有 `isNoteTopicName` 一道守卫**——**没有** `p25SessionTopicWriteGuard`，**也没有** archived 校验。`index.js:4639` 那句注释「memory_dream_patch 没接 p25SessionTopicWriteGuard」**至今仍然准确**。见 M-3。

### 8. 方案 §0 面板现状——**成立**

- `created-plugin/index.js:153-187`：3 条 SQL（totals / checkpoints≤20 / notes≤30）→ `{ok, generatedAt, topicDbEnabled, stats:{topics,sentences,checkpoints}, checkpoints[20], notes[30]}`。
- `client.js:324-326`：**3 张 `StatCard`**；`223`/`251` 两个 `ItemSection`；无 Tab、无状态分布、无 dream/cost/health ✓。
- 活库实测：`/dsh-memory-panel/snapshot.json` → 47,852 B、85ms（热）/392ms（冷）、`stats={topics:607, sentences:33915, checkpoints:49}`。

### 9. 方案 §0「候选只给 id「名字」」/「检查点不被 dream 使用」——**均成立**

- `4711`：`candTopics.map(t => t.id + "「" + t.name + "」")` ✓ 无摘要。
- 库模式任务书（`4705-4749`）全文**无「检查点」引导**，且候选池排除之（`4644-4646`）✓。

---

## 方案逐条审计（A1/A2/A3/B）

### A1 note → 关联主题预筛：**7 个独立缺陷，其中 3 个是「按方案写就必然错」**

**A1-1（内部矛盾，必错）算法第 2 步抽的关键词，第 3 步根本没被使用。**
方案 L47-51 定义「关键词抽取（2~6 字连续片段 + trigger 反向匹配）」，L52 却写 `topicDbSearchTopics(store, **noteSnippet**, {maxTopics:8})`——传的是原文摘录，不是关键词。关键词抽取成为死代码。
**更糟**：若「照 L48 真的抽」——实测同一批 note 抽出 **233~1255 个关键词**（2~6 字滑窗对中文的产量），而 1255 个 token 会让 `searchSentencesByTokens` **直接抛 `Expression tree is too large`**（实测）。所以「按方案字面实现」= 抛错；「按方案 L52 实现」= 检索退化。

**A1-2（无 IDF，系统性误召回）预筛会把「最大的主题」当成「最相关的主题」。**
实测每条 note 的 top-3 恒为 T-0002 / T-0469 / T-0472，分数 615–2,304；`T-0602`（插件开发笔记）被关联到徕卡相机主题。根因：`8208-8213` 按「命中 token 数」累加、无 IDF/无长度归一，而 note 正文里的 `quote`/`literal`/`observation`/`用户原话`/`2026-11-09`/`11` 等**结构标签与数字**命中面极宽。
⇒ A1 的产出不是「归属线索」，而是「每次都指向同几个大主题」——**dream 会被稳定地引到错误主题**。这比「没有预筛」更危险（现状至少 dream 会自己 `memory_search`）。

**A1-3（名额被噪声吃掉）`maxTopics:8` 之后才过滤，实测 3~5 个名额被笔记/检查点/索引占用。**
方案 L52-54 是「先 `maxTopics:8` 检索，再过滤 archived/笔记/检查点/索引」。实测 `droppedByFilter = 3~5`，`afterFilter` 最好情况正好 5、最差 **3**（T-0597）。⇒「每 note ≤5 个关联」不是设计出来的，是 8 减噪声的余数。过滤必须在 `maxTopics` **之前**（或把 `maxTopics` 提到 20+，代价是 markHit 污染面同步扩大——见 M-1）。

**A1-4（预算不可行，4 倍超支）** 详见 A3。

**A1-5（摘录算法在真库上产出空摘录）「最多 3 句 / ≤600 字」+ note 长句 ⇒ 3/10 的 note 摘录为 0 字。**
实测 note 单句长度：n=117、**max 1,881**、P95 1,717、中位 401、**>600 字的句子 39/117**。按方案「累计超 600 就停」的写法，实测 10 个 note 的摘录长度 = `[278,563,480,450,378,0,541,0,0,466]`——**3 个为 0**（首句就 >600，一句都放不进）。这 3 个 note 的预筛直接退化成「无摘录 + fallback」。
⇒ 必须先「单句截断到 N 字（建议 200）」再累计，而不是「放不下就跳过」。

**A1-6（与候选池/超限块几乎不重叠，方案 A5 的缓解措施无效）**
实测 50 个关联主题中：**与 20 个候选池重叠 1 个、与超限块重叠 0 个**（净新增 49）。方案 A5「预筛块里的关联主题若已在候选池，合并标注、不重复渲染」实际是空转。
同时**真实重复发生在别处**：笔记主题本身会被渲染 **3 次**——「会话笔记提炼块」（`4677-4701`）+「超限主题块」（实测 7 条超限里 **3 条是笔记主题**：T-0558 15,784 / T-0560 140,574 / T-0602 9,204 字）+ 新增预筛块。且超限块对笔记主题给出的建议是「用 `memory_dream_patch` edit 收敛 / `memory_split_topic` 分片」——**这两条对笔记主题都会被 `NOTE_TOPIC_DREAM_FORBIDDEN` 拒**（`13576`、`19045`）。这是**既有**死胡同，A1/A3 的 token 预算必须把它算进去（不能指望 dream 处理掉它）。

**A1-7（渲染顺序写错，A4 的断言不可满足）**
方案 L59/L106 要求顺序「笔记提炼 → Note 预筛 → 检查点证据 → 候选/兜底」。实际任务书顺序（`4715-4749`）：
`header → scope（**候选主题在 scope 内**，`4711`/`4717`）→ Consolidate → 主题卫生 → Capacity → 待审队列 → 会话笔记提炼（`4739`）→ lessons → Self-Calibration → Write Path → Output`。
**候选主题在笔记块之前**。方案 A4 第 4 条「块顺序（笔记提炼 → Note 预筛 → 检查点证据 → 候选/兜底）」按现状**不可能通过**；要实现必须重构 `scope`/prompt 拼接，那是比方案描述大得多的改动（且会动 `_test-*` 里对候选行的解析——`test/_dream-cand-selftest.mjs:123` 靠 `split("\n").find(l => l.includes("候选主题"))` 抠候选行）。

**A1-8（性能未计入）** 实测 A1 单轮 ≈ **1.5–2.3s**（10 × [151ms 检索 + 34k 行×token 内存打分]），叠加在全量 sentences 读取（199ms）之后。dream 是后台任务，可接受，但方案把「复用既有实现」当零成本，没写这笔账；而**空轮轮次会白付**（见现状核对 #2）。

**A1-9（兜底池与现状同义反复）** 方案 L74「兜底池 = 保留现有候选池的非笔记部分 5~10 个」。现有 `otherPick` 就是「非笔记部分的最新 10 个」——所谓兜底 = 现状，对冷主题（493/503）零覆盖，方案 A3 自己也承认。可以接受，但**不能把「兜底池」当成 A1 误召回的安全网**（它只防「note 无命中」，不防「note 命中错主题」）。

### A2 检查点次级证据：**方向对（MiMo 对照成立），但「只读」在实现上不成立**

- **MiMo 对照准确** ✓：`mimo-src/.../prompt/dream.txt` Phase 1「Glob `memory/sessions/*/checkpoint.md` and identify recent checkpoints」、Phase 2 第 1 条「Recent checkpoint.md files, focusing on discovered knowledge, errors/fixes, and design decisions」、以及「Do not read every file exhaustively」。方案引述无误。
- **预算可行** ✓：实测检查点句 chars 均值 935、最大 2,055；「首行 ~40 + 两节各 ≤120 字」×5 ≈ 1,400 字 ≤ 1,500 ✓。
- **不进可写候选** ✓：检查点已被候选池排除（`4644-4646`），A2 只加只读证据块，不破坏该约束。
- **「只读」是方案 §1.3 声明「必须逐条满足」的设计约束，但现状只覆盖 1/5 写入面**：

| dream 可用的写/改工具 | 对检查点主题是否被拦 | 证据 |
|---|---|---|
| `memory_write` | **拦**（49/49 真检查点） | `12688` → `p25SessionTopicWriteGuard`（`9185-9243`，双条件：名字形态 + 父线匹配） |
| `memory_rename_topic` | **拦**（系统主题只读） | `12779` `SYSTEM_TOPIC_READONLY` |
| `memory_review_topic` | **拦**（源必须 `needs_review`，检查点恒 `active`） | `19136-19137` |
| `memory_split_topic` | **不拦**（只挡笔记 + archived） | `19042-19045`；split 会给源主题 append 指针句（`19043` 注释自述）⇒ 直接破坏「恒 1 句」 |
| `memory_dream_patch` | **不拦**（只挡笔记） | `13547-13619`、`13756-13765`；可 append/edit/replace/delete ⇒ 把 1 句变 2 句或清空 |

  ⇒ **D-2 的答案是「不够」**，而且不是「要不要给一个显式只读工具」的问题，是「现有唯一写入通道根本没接护栏」的问题。修法很轻（在 `applyPatches` 的整批预扫里加一个 `p25SessionTopicWriteGuard` 判断 + 给 `split_topic` 源加同样的判断），但必须进方案。
- **补充判断（建议项）**：MiMo 的 checkpoint 是**原始轨迹的派生**，Phase 3 还会用 SQLite 原始轨迹复核；dsh-memory 的 dream 工具面（`4744`）**没有 `session_search`**，检查点本身也是模型摘要 ⇒ A2 的用途③「交叉验证 note 里的事实」实际是「用摘要验证摘要」。建议把 A2 的定位收缩为「补全没有 note 的会话 + 提示未完成待办」，不要写成「交叉验证」。

### A3 漏读/多读边界：**4 行表格里 3 行数字不成立**

| 方案断言 | 实测 | 判定 |
|---|---|---|
| 预筛块总字符 ≤4000，超出只列 id | 完整块 **15,960 字**（10 note × 1,495–1,702 字）；任务书静态骨架 ≈**3,919 字**（字面量估算）⇒ 4,000 字 = **+102%**，完整块 = **+407%** | ✗ 4000 只够 ~2.5 个 note 的完整明细，其余 7–8 个退化成「只列 id」⇒ 预筛对多数 note 失效 |
| 关联主题摘要 ≤160 字 | 50 条摘要**平均 147 字、40/50 打满 160** | ✓ 上限能守住，但按「打满」算预算才对 |
| note 摘录 ≤3 句 / ≤600 字 | 10 个里 3 个为 **0 字**（见 A1-5） | ✗ |
| 关联 ≤5/note | 实测 5（最好）/3（最差），且是 `maxTopics:8 - 噪声` 的余数 | ⚠ 数字对但机制错（A1-3） |
| `monitorEvent("dream","prescreen ...")` | `monitorEvent` 可用，`4653` 有同款先例 | ✓ |

### B 面板 v2

**B1 现状** ✓（见现状核对 #8）。

**B2 数据层：三个不可达/需重定义的字段 + 两个成本炸弹**

口径漂移实测（活库，同一时刻）：

| 字段 | `stats.json`（`topicDbStatsSnapshot()`） | 面板现状（raw SQL） | 差 |
|---|---|---|---|
| `sentences` | **33,636**（有效口径：扣墓碑 + 合并视图） | **33,915**（`count(*) from sentences`，物理） | **279** |
| `checkpointTopics` | **0** | **49** | **49** |
| `noteUnrefined` | 11 主题 / 114 句 | 无此字段 | — |
| `topics` / `topicsByState` | 607 / `{draft 44, active 223, dormant 308, archived 32, needs_review 0}` | 可复算一致 | ✓ |

- **`sentences` 差 279 的根因**：`deleted.index` 的行级墓碑（实测 278 条 sentenceId）由 store 统一过滤（`memory-store.mjs:456-501`），面板 raw SQL 完全不知道它的存在。当前 `merge.index=0` 所以只差墓碑；**一旦将来发生合并，差距会放大到「被合并源主题的整段句数」**（`memory-store.mjs:404-427` 的有效口径）。
- **`checkpointTopics=0` 的根因**（这条是硬结论）：`topicDbHierarchy`（`8677-8731`）的 `systemAll` 只从 **`detailNoParent`**（`8693`）里筛系统主题，而 49 个真检查点**全部挂在 `会话检查点·<wsKey>` 线下**（有 `parentId`）⇒ 进的是 `detailsAll`，**永远不计入 `systemTopics/checkpointTopics`**。所以浏览器面板自己就自相矛盾（图谱 `kind=checkpoint` 有 49 个，stats 说 0）。方案 B2 把 `checkpointTopics` 写进「与 `topicDbStatsSnapshot()` 一致」的字段清单，同时 §B4 又写「**不改 dsh-memory 主插件**」⇒ **这两个要求互斥**。
- **`health.dangling` 是成本炸弹**：`scanDanglingPointers`（`772-798`）要 `readdirSync` + 逐 `.md` `readFileSync` 遍历整个 memory 树。放进每次刷新 = 几十~上百毫秒 I/O + 读全部导出视图。而 `.integrate.json.progress.dangling` 里**已有现成字符串**（实测有值）。⇒ 应读现成字段，不要重算。
- **`health.upgrade` 是第二套探测**：`topicDbUpgradeSummary()`（10 分钟缓存 + 升级脚本探测）复制到面板 = 逻辑分叉。
- **`cost` 形状未定义**：实测 `cost.totals` 有 **15 个 kind**，各 kind 字段不同——`checkpointWrite` 有 `fail/retry/durMs`、`rebuildInject` 只有 `injectedChars/estTokens`、`hostUsage` 有 `cacheRead/turns` 且 `totalTokens=0`。方案 `daily: [{day, tokens}]` 的「tokens」必须逐 kind 指定取哪个字段（`estTokens` 还是 `totalTokens`），否则面板会显示一片 0。
- **性能**：现状 snapshot 85ms(热)/392ms(冷)/47,852 B。v2 还要加：topics 全量(6.3ms) + 34k 句聚合 + `.integrate.json` 382,531 B 解析 + `.monitor.json` 409,210 B 解析 ⇒ 估 **150–250ms/次**。可接受，但方案没写缓存策略（建议 10s TTL + 手动刷新绕过）。
- **并发/一致性** ✓ 基本安全：`mem.db` 是 WAL（`backend-sqlite.mjs:9`）；`.monitor.json` 用 `writeFileAtomic`（`559`/`5767`）；`.integrate.json` 也已改原子写（`20172` `writeFileAtomic(INTEGRATE_STATE_FILE, ..., {tag:"ledger", verify:true})`）⇒ **不会读到半截 JSON**。**但**：面板 `new DatabaseSync(path,{readOnly:true})` 后**没有 `PRAGMA busy_timeout`**（`created-plugin/index.js:139`）——主进程 `BEGIN IMMEDIATE`（`backend-sqlite.mjs:77`）期间只读连接可能拿到 `SQLITE_BUSY`，面板直接报 `database-unreadable`（`142-147`）。WAL 只读还需要 `-shm` 可写（同用户下 OK，但这是「只读」的边界事实）。见 M-10。
- **隐私**：`.monitor.json` 实测 **111 处含绝对路径/完整命令**（`spiralEvents[].sample` 里有 `E:\工具\徕卡一瞬\...`、`C:\Python311\...`、完整 pwsh 命令行），另有 `recentQueries` **20 条用户检索原文**。好消息：`events` 环（2,000 条，类型 tool/intent/note/sink/hint*）实测**不含绝对路径** ⇒ 「最近事件尾部 20 条」可以给，但必须**白名单**（只 `events` + `cost` 子集），**严禁**整包下发或转发 `recentQueries`/`spiralEvents`。`dbPath` 脱敏有现成先例：`9618-9622` 输出 `.memtopic/mem.db`（相对路径）⇒ 面板照抄。

**B3 UI 层** ✓ 无阻塞。`client.js` 已在用 `var(--dsw-alias-label-caption)`（`99`/`108`）等 host 变量，说明方案「只用 host CSS 变量」可行；6 分区 + Tab 是纯前端新增。

**B4 实现与验收**

- 验收第 3 条「数据与浏览器面板交叉核对（topicsByState/needsReview/noteUnrefined 一致）」：`topicsByState`/`needsReview` 可一致；`noteUnrefined` 需要复刻指针正则（可行）；**`sentences`/`checkpointTopics` 必然不一致** ⇒ 该判据按现状无法通过（见 M-8）。
- 验收第 1 条「DB 不可用/flag 关/库损坏三态降级」：现状已覆盖 `database-missing`/`sqlite-unavailable`/`database-unreadable`/`query-failed` 四态（`121-147`/`201-207`）✓。
- 验收第 4 条「不写库（Host 只读；无 POST）」：现状 `handleSnapshot` 只收 GET/HEAD（`224-230`）✓，v2 必须保持并加门。
- **面板插件更新方式**（实测）：该插件是 profile `package.json` 里的 `"link:C:/Users/Starry/.dsh/profiles/desktop/created-plugins/f1f34574-…"` + `dsh.profile.bundles` 成员；`created-plugins/` 下**没有**独立注册表（`.plugin-manager/` 只有安装日志）⇒ 就地改文件不会被覆盖 ✓。但 **Host 半区在 DSH 启动时 `import`** ⇒ **必须重启 DSH** 才生效；Client 半区是否热重载需实测（方案已列为风险 ✓，但验收要写死操作步骤：重启 DSH → 硬刷新 → `curl /dsh-memory-panel/snapshot.json` 断言字段）。另：**不要走「插件重装/升级」流程**（会覆盖目录），方案应写明。

---

## D-1~D-6 裁决

### D-1：每 note 5 个 / 总 20 / 摘要 4000 字——**不合理（必须重定预算）**

三个数不能同时成立：实测 5 关联 × 平均 147 字摘要 = 735 字/note，加摘录（真库要求单句截断）后 10 个 note ≈ 9,000–16,000 字。
**可验收的替代算式**（建议写进方案）：
`每 note ≤ 摘录 200 字（单句截断到 200，最多 2 句）+ 关联 3 个 × (元信息 ~45 字 + 摘要 80 字)` ≈ **575 字/note**；`10 note ≈ 5,750 字`。
⇒ 要么「note 上限降到 6」+ 预算 4,000（6×575=3,450 ✓），要么「预算提到 6,000」+ note 10。**二选一，且必须给出「任务书总字符 ≤ N」的上界**（现状骨架 ≈3,919 字，+5,750 = +147%）。

### D-2：检查点「只读」是否足够——**不够（必须加护栏）**

不是「要不要给显式只读工具」的问题：`memory_write`/`rename`/`review` 三条已拦（`12688`/`12779`/`19136`），但 **dream 实际用的 `memory_dream_patch` 与 `memory_split_topic` 都没拦**（`13547-13619`/`19043-19045`）。
**修法（轻）**：在 `applyPatches` 的整批预扫（`13740-13767`）里对 `dbPatchGuardTopic` 解析出的主题追加一次 `p25SessionTopicWriteGuard` 判断 ⇒ 整批返回 `P25_SESSION_TOPIC`；`split_topic` 源同样追加一次（`19045` 旁边）。**不需要**新工具、不需要任务书约定兜底。

### D-3：用 `topicDbSearchTopics` 是否够 / 要不要 embedding——**不够；但本轮不需要 embedding**

「不够」的根因不是「没有语义能力」，而是**三个可修的工程问题**：
1. **输入污染**：note 的结构标签（`quote`/`literal`/`observation`/`用户原话`）与日期/纯数字必须清洗（黑名单 + 长度过滤）。
2. **无 IDF**：至少要做「按主题 chars 或句数归一」或「token 命中权重 × log(N/df)」，否则永远是大主题霸榜（实测已证明）。
3. **通道错配**：不该用 `searchSentencesByTokens` 的 SQL 快路径（1255 token 直接崩、300 token 4.3s）。预筛已有 `_allRows` + 只读 10 个 note 的句子，**在内存里用「已取 rows + 已取 sentence stats」算分**即可，避免 10 次全表 LIKE。
embedding 不建议本轮上：成本/依赖/不可解释，且上述 3 条修完后的实测质量提升需要先量化（否则等于用新组件掩盖旧问题）。

### D-4：兜底池几个 / 替换还是追加——**必须明确为「附加、不占候选名额」**

现状候选 = `notePick(≤10) + otherPick(10)` = 20。方案 L74「保留现有候选池的非笔记部分 5~10 个…总数仍 ≤20」如果理解成「替换」，候选池会从 20 缩到 10，**与现状相比是能力回退**（dream 可写面变小）。
**建议裁决**：`otherPick` **保持现状 10 个不变**；预筛块是**附加信息块**，不占候选名额；「兜底」= 在预筛块里显式写一行「若本条无强关联，允许在下方候选主题里找归属」，**不新增第三份主题列表**（避免 A1-6 的重复渲染）。数量：**0 个新增**（现状已够）。

### D-5：面板 Host 直读 vs 复用 `/dsh-memory/stats.json`——**方案的选项描述不完整；建议「Host 侧取 stats.json 子集 + 缓存」**

- 方案的前提「当前桌面 origin 不能直接 fetch，需 Host 代理」——**只对浏览器侧成立**。面板的 Host 与 dsh-memory 的 Host 是**同一个 DSH 进程**，`webServer` 句柄可拿到 `port`（主插件自己就在用：`13173` `wsrv.port`）⇒ **Host 完全可以服务端 GET `http://127.0.0.1:<port>/dsh-memory/stats.json`**，不存在跨域问题。
- 成本实测：stats.json **384–683ms / 479,779 B**——**整包下发**不可接受，但**服务端取子集 + 10s TTL 缓存**完全可行（面板只需 `topicdb` + `cost` 两个子对象 + 少量标量）。
- 收益：**彻底消灭口径漂移**（B2 的 `sentences`/`checkpointTopics` 问题一次性消失），且不需要在面板里复刻 `topicDbHierarchy`/`topicDbLevelMap`/三档超限/指针正则。
- `.integrate.json` 仍需直读（stats.json 不含 dream progress），但只取 `progress`/`lastSuccessAt`/`lastFailAt`/`integrateCount`/`overLimitStuck` 计数——注意它 382,531 B，解析 ~3-5ms，可接受。
- **若坚持直读 DB**：必须复刻「墓碑 + 合并视图」有效口径、并把 `checkpointTopics` 的**定义**写进方案（选「有父线的会话主题」而不是 `topicDbHierarchy` 的 0）。

### D-6：是否内嵌知识图谱——**同意不内嵌 3D，用按钮打开浏览器面板**

但方案 B3/B2 里两个 URL 写错了：
- `panelUrl: "http://127.0.0.1:<port>/dsh-memory/panel"` —— **该路由不存在**。实测注册路由只有：`/dsh-memory/stats`（HTML 页）、`/dsh-memory/stats.json`、`/dsh-memory/note-stat.json`、`/dsh-memory/wait.json`、`/dsh-memory/ops.json`、`/dsh-memory/logs.json`、`/dsh-memory/open`、`/dsh-memory/pending-clear`、`/dsh-memory/config`、`/dsh-memory/graph.json`（`10088-10102`）。
- 「打开知识图谱」= `/dsh-memory/stats` 页内的图谱区块 + 数据源 `/dsh-memory/graph.json`，不是独立 URL。

---

## 失效路径（12 条，按严重度排序）

### F-1【严重·不可逆】预筛污染生命周期（`markHit` 副作用）
**触发**：A1 按方案「复用 `topicDbSearchTopics`」。
**机制**：`8224` 无条件 `markTopicHits` → 写 `topics.last_hit_at` → `lifecycle.isRenewed()`（`lifecycle.mjs:62-67`）判定「活着」→ `decideLifecycle` 跳过 archive/escalate（`76-82`）。
**后果**：每轮最多 80 个主题被续期；被命中的正是**最大最老**的主题（实测 top-3 恒定）⇒ 该归档的永远不归档，库继续膨胀。**不可回滚**：`last_hit_at` 是覆盖写、无 audit 反演路径。
**必须**：`topicDbSearchTopics` 增加 `{ markHits:false }`（默认保持 true 不影响 `memory_search`），A1 显式传 false；加门断言「预筛后 lastHitAt 不变」。

### F-2【严重】note 无关键词命中 / 检索误召回 ⇒ 预筛质量崩塌
**触发**：note 摘录含大量结构标签与日期（实测每条 33–117 token）。
**后果**：实测每条 note 的 top-3 都是同 3 个大主题（T-0002/T-0469/T-0472），`T-0602`（插件笔记）被关联到徕卡相机主题。⇒ dream 被稳定地引向错误主题，**比不做预筛更差**（现状 dream 至少自己 `memory_search`）。
**缓解**（M-5）：清洗输入 + IDF/长度归一 + 内存打分；并在任务书里把预筛块明确标成「**线索，不是结论**，摘要与你判断冲突时以 `memory_read` 为准」。

### F-3【严重】1255 token ⇒ SQLite 硬抛错 ⇒ 整轮 dream 失败
**触发**：实现者照方案 L48「中文 2~6 字连续片段」抽关键词，再喂 `topicDbSearchTokens`。
**实测**：`Expression tree is too large (maximum depth 1000)`。
**后果**：若 A1 在 `buildDreamPromptLibrary` 内且未 try/catch，异常上抛 → `buildDreamPrompt` → `spawnIntegrate` 的 catch → 本轮 dream 失败并进 2h 重试（失败循环）。
**缓解**：预筛**不走** `searchSentencesByTokens`；token 数硬上限（如 ≤64）；整块 try/catch + fallback。

### F-4【严重】token 预算 4,000 字不可行 ⇒ 预筛对多数 note 失效
实测完整块 15,960 字 vs 预算 4,000（+407% 于骨架 3,919）。按「超出只列 id」，10 个 note 里 7–8 个只剩 id ⇒ 预筛退化。
**缓解**：见 D-1 的可验收算式；门禁必须**双断言**（预筛块 ≤ 上限 **且** 任务书总字符 ≤ 上限）。

### F-5【严重】检查点「只读」只是任务书约定 ⇒ dream 可写坏 P2.5 不变量
`memory_dream_patch` 无 `p25SessionTopicWriteGuard`（`13547-13619` 仅挡笔记）；`memory_split_topic` 源只挡笔记（`19045`）。⇒ append 一句 = 「恒 1 句」变 2 句；split = 源主题多一条指针句。
**后果**：P2.5 读侧（`p25Topics.planMigration`/`decideLifecycle` 假设恒 1 句）与面板「检查点全文」都会被污染，且**无法自愈**（下次压缩走 `replaceSentence` 覆盖第 1 句，第 2 句永久残留）。
**缓解**：M-3。

### F-6【中】预筛块与候选池/超限/待审重复渲染
实测关联主题与候选池重叠 **1/50**（方案 A5 的合并标注几乎空转），但**笔记主题被渲染 3 次**（笔记块 / 超限块 / 预筛块），且超限块对笔记主题给出 `dream_patch`/`split` 的**不可执行建议**（都被 `NOTE_TOPIC_DREAM_FORBIDDEN` 拒）。
**后果**：token 浪费 + dream 反复尝试被拒的操作（浪费回合，且会触发「预算打转」提示 `17897`）。
**缓解**：M-6。

### F-7【中】md 模式（flag 关）回归——**结构上安全，但 flag 落点缺失**
`buildDreamPrompt`（`20448-20450`）`if (TOPICDB.enabled) return buildDreamPromptLibrary(...)` ⇒ md 路径**天然不进**新代码 ✓ 方案「逐字不变」在结构上成立。
**但**方案只说「`PLUGIN_CFG.dreamPrescreen`（默认 true，可关）」，没写落点：`DEFAULT_CFG`（`7347` 的 `{...DEFAULT_CFG}` 展开处）+ `.config.json` 写入 + 设置页 + 热更新。且库模式的「字节级回归」仍需一份基线（建议把当前 `promptText` 的 sha16 存进门夹具）。

### F-8【中】面板 Host 直读 DB 的并发/边界
`mem.db` 是 WAL（`backend-sqlite.mjs:9`）；面板 `DatabaseSync(readOnly:true)`（`created-plugin/index.js:139`）**无 `busy_timeout`** ⇒ 主进程 `BEGIN IMMEDIATE`（`77`）期间可能 `SQLITE_BUSY` → 面板报 `database-unreadable`（`142-147`），用户看到「主题库无法打开，可能正被其他进程占用」。
**缓解**：`db.exec("PRAGMA busy_timeout=2000")` + 失败重试 1 次 + 把 busy 与真损坏分成两个 code（M-10）。

### F-9【中】面板口径漂移（已实测发生，不是风险是事实）
`sentences` 33,915 vs 33,636（差 279）；`checkpointTopics` 49 vs **0**；`merge.index` 一旦非 0，差距放大到整段句数。
**缓解**：M-8（改走 stats.json 子集，或把口径定义与允许差异写死进验收）。

### F-10【中】面板隐私泄漏
`.monitor.json` 111 处绝对路径/完整命令 + `recentQueries` 20 条用户检索原文。方案 B3「查看最近事件（`.monitor.json events` 尾部 20 条）」若实现成「读文件 → 取 events → 下发」是安全的（实测 events 无路径），但**很容易顺手把整个 monitor 对象透传**。
**缓解**：白名单字段 + 门断言「snapshot 序列化结果不含盘符路径 / 不含 recentQueries」。

### F-11【低】面板性能炸弹
`health.dangling` 走 `scanDanglingPointers`（`772-798`，全树读 .md）不可放进刷新路径；`.monitor.json` 409 KB + `.integrate.json` 382 KB 每次全解析。
**缓解**：`dangling` 读 `.integrate.json.progress.dangling`；两份 JSON 加 10s TTL 缓存。

### F-12【低】面板插件更新方式误判
`created-plugins/` 无独立注册表（只在 profile `package.json` 的 `link:` + `dsh.profile.bundles`），就地改文件安全 ✓；但 **Host 半区需重启 DSH**，且**不能走插件重装/升级**（会覆盖目录）。
**缓解**：验收写死操作步骤 + 备份 3 个文件（`index.js`/`client.js`/`package.json`）。

---

## 门禁/验收审计

### 基线修正
方案 A4 写「回归：`_run-suite.mjs` 37 门无新增红」。**门数 37 准确**（`_run-suite.mjs:51` 扫根 `_test-*`/`_gate-*` + `58-69` 的 8 个 `test/` 门 + `_check-batch0-live`；实测根目录 `_test-*` 23 个（排除 `_test-index-compact`）+ `_gate-*` 5 个 + `test/` 8 个 + 1 = 37）。
**但基线不是 0 红**：`_verify/suite-p3-final-20261110.txt`（今日 10:30）实测 **9 红**：
`_gate-freeze-sync`、`_gate-plugin-load`、`_test-cli-behavior`、`_test-fixed-removed`、`_test-fmt-selftest`、`_test-index-refresh`、`_test-pointer-closure`、`_test-raw-decode`、`_test-search-commands`。
⇒ 验收措辞必须改为「**红集合不变（9 红逐条同因）**」，不能写「无新增红」这种含糊表述。

### 方案 A4 的 5 条新门断言——3 条不可用
1. 「2 note + 6 主题：断言关联主题 ≤5、排除笔记/检查点/索引/归档、去重」——**可用但不足**：`≤5` 会掩盖 A1-3（噪声吃掉名额）。应断言「**过滤后**取满 3 个（或明确记录 fallback 原因）」。
2. 「无命中 ⇒ fallback=true 且兜底池非空」——**可用**。
3. 「检查点证据块：只列最近 5、只读标记存在、**静态断言不出现对检查点主题的 dream_patch 建议**」——**方向错**：只读靠静态字符串断言是「测文案」，测不到 F-5 的护栏缺口。应改为**行为断言**：对真检查点调 `memory_dream_patch` ⇒ 必须 `P25_SESSION_TOPIC` 拒。
4. 「块顺序（笔记提炼 → Note 预筛 → 检查点证据 → 候选/兜底）」——**不可满足**（A1-7，候选主题在 `scope` 内、位于笔记块之前）。
5. 「`dreamPrescreen=false` 时任务书与现状逐字一致」——**可用且必要**，但要给基线 sha。

### 「fake store」是退步，应复用既有夹具
仓库已有 `test/_dream-cand-selftest.mjs`：`_fixture-ctx.mjs` + **真临时库**（`DSH_HOME`/`DSH_MEMORY_ROOT`/`MEMTOPIC_DB` 全指 `os.tmpdir()`，`46-59`）+ `mod.__dreamHooks.buildPrompt()`（`116-120`）+ 从 `promptText` 抠候选行（`123`）。
**fake store 测不到**：墓碑过滤、合并视图、`readTopic` 的 sentences/chars 语义、`resolveTopic` 模糊解析——而口径 bug 恰好全在这三处。
⇒ 应**扩展 `test/_dream-cand-selftest.mjs`**（或新门复用同一 fixture），不要另起 fake store。

### 必须新增的门（6 条，对应 M 项）
| # | 断言 | 对应 |
|---|---|---|
| G1 | 预筛后所有主题 `lastHitAt` 与预筛前**逐条相等**（负例：旧字节必红） | M-1 |
| G2 | 对 49 个真检查点之一 `memory_dream_patch{action:"append"}` ⇒ `P25_SESSION_TOPIC` 整批拒；`split_topic` 源为检查点 ⇒ 同样拒 | M-3 |
| G3 | 用「单句 >1,000 字」的 fixture note ⇒ 预筛块必须含非空摘录（防 A1-5 回归） | M-2 |
| G4 | 双预算断言：预筛块字符 ≤ 上限 **且** 任务书总字符 ≤ 上限；`dreamPrescreen=false` 时 `promptText` sha16 == 基线 | M-5/M-7 |
| G5 | 面板 snapshot：`sentences`/`checkpointTopics` 与 `/dsh-memory/stats.json` 一致（或差异命中白名单） | M-8 |
| G6 | 面板 snapshot 序列化结果**不含**盘符绝对路径、不含 `recentQueries`；只接受 GET/HEAD | M-9 |

### 真机验收（方案 §4 第 4 条）要可核验
「dream 一轮任务书含预筛块」必须落成**可复核证据**：`monitorEvent("dream","prescreen notes=N related=M fallback=K chars=C")` + 该轮 `.integrate.json.progress` + 面板 snapshot 的 `dream.lastIntegrateAt`。只写「含预筛块」不可验收。

---

## 回滚与不可逆

| 改动 | 回滚方式 | 是否可逆 |
|---|---|---|
| A1/A2 任务书块 | `dreamPrescreen=false`（需先落 flag）+ git revert | **可逆** |
| A1 的 `markHit` 污染（F-1） | 无 | **不可逆**：`last_hit_at` 覆盖写、无 audit 反演；生命周期决策已被推迟，只能等自然到期重新老化（最长 90 天） |
| 检查点被 dream_patch 改写（F-5） | 需手工删多余句（`memory_read` 找到 → `deleteSentence`） | **半可逆**：内容可删，但「恒 1 句」期间的读侧行为已污染；若被 replace 覆盖，原检查点正文**永久丢失**（audit 有 old_text，可人工恢复） |
| 面板 v2 | 备份 3 文件 + 恢复 `version 1.0.0` + 重启 DSH | **可逆**（独立插件，不碰主插件/真源） |
| 面板若误写库 | —— | 方案已声明「Host 只读；无 POST」（`created-plugin/index.js:224-230`）✓，**v2 必须保持并加门** |

**额外不可逆风险**：A1 若把预筛的关联主题写进任务书，dream 会基于错误关联做 `merge`（`memory_review_topic`）⇒ **merge 会归档源主题**（`19191-19195`）。merge 的 undo 只有 `audit` 表（`archive.pointer`），**没有自动反演工具**。所以 F-2（误召回）的后果不止「读错」，还包括「按错误关联做不可逆合并」。这一条应在方案里显式承认，并在任务书里加一句「预筛关联只用于找归属，**不得仅凭预筛关联做 merge**（merge 必须先 `memory_read` 双方正文）」。

---

## 必须修改项 / 建议项

### 必须修改项（逐条可验收）

| # | 必须修改 | 验收判据 |
|---|---|---|
| **M-1** | 预筛**禁止**触发 `markHit`。给 `topicDbSearchTopics` 加 `{markHits=false}` 选项（默认 true，`memory_search` 行为不变），A1 显式传 false；或 A1 完全不调该函数（推荐，见 M-5） | 门 G1：预筛前后所有主题 `lastHitAt` 逐条相等；源码里 A1 路径不出现 `markTopicHits` |
| **M-2** | 摘录算法改为「**单句先截断到 ≤200 字**，最多 2 句，累计 ≤400 字」；空摘录必须记 `fallback` 原因（`no-snippet` vs `no-hit` 分开） | 门 G3：fixture 含 1,881 字单句 ⇒ 摘录非空且 ≤400 字；10 个 note 中 `no-snippet` 计数为 0 |
| **M-3** | 把 `p25SessionTopicWriteGuard` 接进 **`memory_dream_patch`**（`applyPatches` 整批预扫 `13740-13767`，topic 与 file 两条寻址都要覆盖）与 **`memory_split_topic` 源**（`19045` 旁）；拒绝码用 `P25_SESSION_TOPIC`，整批拒绝（不半批落盘） | 门 G2：对真检查点 append ⇒ 整批拒且库内句数不变；split 源为检查点 ⇒ 拒 |
| **M-4** | A2 取检查点必须 `isSessionTopicName(n) && !isNoteTopicName(n) && state!=='archived'`；并断言「取到的 5 个里 0 个笔记主题、0 个 archived」 | 门：fixture 造 3 笔记 + 1 archived + 2 真检查点 ⇒ 证据块只含 2 个真检查点，且顺序按 `updatedAt` |
| **M-5** | A1 检索**重写为内存打分**（用已取 `_allRows` + 已取句子），不复用 `searchSentencesByTokens`；输入清洗（黑名单：`quote/literal/observation/用户原话/★/日期/纯数字/单字`）+ 至少一种长度归一（按主题 chars 或 `log(N/df)`）；token 硬上限 ≤64 | 门：同一批 10 note，关联主题 top-1 的「与 note 所属工作区线一致率」≥ 基线（**先测基线再定阈值**）；不得出现 `Expression tree is too large` |
| **M-6** | 消除笔记主题三处重复渲染：`renderOverLimitTopicsForPrompt` 的输入**排除笔记主题**（它们不可能被 dream 修）；预筛块对「已在候选池」的主题做去重标注（虽然实测只 1/50，但契约要写） | 门：任务书里同一 `topicId` 的完整「id「name」」出现次数 ≤1（除候选行按现状允许） |
| **M-7** | 预算重定为**可验收算式**（D-1）+ 双上限门禁；`dreamPrescreen` flag 落点补齐（`DEFAULT_CFG` + `.config.json` + 设置页 + 热更新）；给库模式任务书一份 **sha16 基线**（flag 关时逐字一致） | 门 G4：预筛块 ≤ 上限、总字符 ≤ 上限、flag 关时 sha16 == 基线 |
| **M-8** | 面板口径二选一：**(a)** Host 侧 GET `/dsh-memory/stats.json` 取 `topicdb`+`cost` 子集（10s TTL）；**(b)** 直读 DB 但必须在方案里写死「`sentences` = 扣墓碑+合并视图的有效口径」与「`checkpointTopics` = 有父线的会话主题」的定义，并把已知差异列入验收白名单 | 门 G5：面板 `sentences`/`checkpointTopics` 与 stats.json 一致（或命中白名单）；文档里有口径定义段 |
| **M-9** | 面板字段白名单：只下发 `events` 尾部 20 条（不整包 monitor）、`cost` 指定 kind 指定字段、`dbPath` 用相对路径脱敏（照 `9618-9622`）；**严禁** `recentQueries`/`spiralEvents`/`queries` | 门 G6：snapshot JSON 正则不含 `[A-Za-z]:[\\/]`、不含 `recentQueries`；只接受 GET/HEAD |
| **M-10** | 面板 DB 连接加 `PRAGMA busy_timeout=2000` + 失败重试 1 次；`SQLITE_BUSY` 与真损坏分成两个 code（不要都报 `database-unreadable`） | 门：主进程持 `BEGIN IMMEDIATE` 时 snapshot 仍 200（或在 2s 内重试成功）；busy 时 `code==='database-busy'` |
| **M-11** | `health.dangling` 改为读 `.integrate.json.progress.dangling`（现成字符串），**不得**在面板里跑 `scanDanglingPointers`；`.monitor.json`/`.integrate.json` 加 TTL 缓存（建议 10s） | 门：面板代码不 import/复制全树扫盘逻辑；snapshot p95 ≤ 300ms（实测基线 85ms 热） |
| **M-12** | 修正方案里的 URL：`/dsh-memory/panel` → `/dsh-memory/stats`；图谱 = `/dsh-memory/graph.json` + 面板页内区块；验收写明「重启 DSH → 硬刷新 → curl snapshot 断言字段」且「不走插件重装/升级」 | 方案文本里不再出现 `/dsh-memory/panel`；验收步骤可照抄执行 |

### 建议项

| # | 建议 |
|---|---|
| **S-1** | A2 的定位从「交叉验证 note 里的事实」收缩为「补全没有 note 的会话 + 提示未完成待办」。理由：dream 工具面无 `session_search`（`4744`），检查点本身是模型摘要，用摘要验证摘要价值有限（MiMo 有 Phase 3 原始轨迹复核，我们没有）。 |
| **S-2** | 在任务书里给预筛块加一句「**预筛关联是线索不是结论**；与其判断冲突时以 `memory_read` 为准；**不得仅凭预筛关联做 merge**」。理由：误 merge 会归档源主题（`19191-19195`），无自动反演。 |
| **S-3** | 顺手修既有死胡同：`renderOverLimitTopicsForPrompt` 的输入排除笔记主题（M-6 已含），或对笔记主题单独给「等插件收敛」的说明——现状 dream 会对 3 个超限笔记反复尝试被拒的操作。 |
| **S-4** | 给 A1 加「命中来源」标注时，同时输出**为什么命中**（命中的 token 列表，≤3 个），让 dream 能判断「这关联靠不靠谱」。成本极低（方案 L54 已有「命中来源」字段）。 |
| **S-5** | 观测：`prescreen` 事件里带 `ms=`（本轮预筛耗时）。理由：A1 实测 1.5–2.3s，且空轮会白付（现状核对 #2），需要真机数据判断是否要给空轮闸加「预筛不参与」短路。 |
| **S-6** | 面板 v2 顺带修一个既有口径 bug：`stats.checkpoints` 实际是「检查点**句子**数（49 主题）」但字段名像主题数——v2 改名 `checkpointTopics`/`checkpointSentences` 分开给。 |
| **S-7** | 面板的「6 张指标卡」里 `sentences` 建议标注口径（有效/物理），否则用户看到 33,636 与 33,915 两个数会以为面板坏了。 |
| **S-8** | 给面板加一个「口径来源」脚注（照主插件 `7682` 的 `数据源 ~/.dsh/memory/.monitor.json` 风格），写清「主题库口径来自 stats.json（有效口径）」或「直读 DB（物理口径）」。 |

---

## 附：本轮实测数据速查（供修订方案直接引用）

| 指标 | 值 | 来源 |
|---|---|---|
| 主题 / 非归档 / 归档 | 607 / 575 / 32 | 副本快照 11:19 |
| byState | `{draft 44, active 223, dormant 308, archived 32}` | 副本 + 活库 stats.json 一致 |
| 物理句 / 有效句 | 33,912 / 33,634（副本）；33,915 / 33,636（活库） | 副本 + 活库 |
| 墓碑（sentenceId）/ merge.index | 278 / 0 | 副本 |
| `store.topics()` 成本 | 6.3ms（非 684ms） | 副本 |
| 全量 sentences 读取 | 199.5ms | 副本 |
| `searchSentencesByTokens` | 14 token=151.5ms（命中 27,034 行）/ 300 token=4,277.8ms / **1255 token=抛错** | 副本 |
| 预筛单轮估算 | 1.5–2.3s | 推算（10 × 检索+打分） |
| note 单句长度 | n=117 / max 1,881 / P95 1,717 / 中位 401 / >600 字 39 句 | 副本 |
| 摘录长度（≤3 句累计≤600） | `[278,563,480,450,378,0,541,0,0,466]` ⇒ **3/10 空** | 副本 |
| 关联主题摘要 | 50 条 / 均值 147 / 40 条打满 160 | 副本 |
| 完整预筛块字符 | 15,960（每 note 1,495–1,702） | 副本 |
| 任务书静态骨架 | ≈3,919（字面量统计估算） | 源码 |
| 关联主题 vs 候选池 / 超限块 | 1/50 / 0/50（净新增 49） | 副本 |
| 超限清单 | 7 条，其中 3 条是笔记主题（15,784 / 140,574 / 9,204 字） | 副本 |
| 检查点主题 | 49 真（47 active + 2 archived）+ 22 笔记误命中；49/49 有父线 | 副本 |
| 检查点按 updatedAt top-5 | 3 笔记 + 1 archived + 1 真检查点 | 副本 |
| 检查点句 chars | 均值 935 / 最大 2,055 | 副本 |
| 面板 snapshot（现状） | 47,852 B / 85ms 热 / 392ms 冷 | 活库 |
| stats.json | 479,779 B / 384–683ms | 活库 |
| 面板 vs stats 口径差 | `sentences` 33,915 vs 33,636（+279）；`checkpointTopics` 49 vs **0** | 活库同刻 |
| `.monitor.json` | 409,210 B / events 2,000（无路径）/ 111 处字段含绝对路径 / recentQueries 20 | 磁盘 |
| `.integrate.json` | 382,531 B / progress 847 B / overLimitStuck 124 条 | 磁盘 |
| cost | totals 15 kind / daily 9 天 / 单日 6 kind | 磁盘 |
| 门套件基线 | 37 门 / **9 红**（今日 10:30） | `_verify/suite-p3-final-20261110.txt` |
| 注册路由 | 10 个 `/dsh-memory/*`（**无 `/panel`**） | 源码 `13010-13218`+`10102` |
| created-plugin | profile `link:` + `dsh.profile.bundles`；无独立注册表；Host 需重启 | profile `package.json` |
