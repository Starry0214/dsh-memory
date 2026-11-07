# 452 · CRA 独立审计：v4.5.2「笔记收敛（整主题覆盖 + 指针）」

> 审计对象：`docs/方案-4.5.2-笔记收敛.md`（B 版，未实现）
> 前置依据（已读，不重复推导）：`docs/audit/46-mimo-lifecycle-survey.md`（305 行）、`docs/audit/46-our-lifecycle-survey.md`（132 行）
> 审计方式：**只读**静态代码审计 + 只读 SQL（真机库 `~/.dsh/memory/.memtopic/mem.db`，`readOnly` 打开）+ 宿主 asar 交叉核对；未运行/未修改任何插件代码与方案
> 审计时间：2026-11-06 15:00–15:25
> 证据口径：`index.js#N` 为当前工作副本行号（read 工具 20609 行，2026-11-06 08:40）；`memory-store.mjs#N` / `backend-sqlite.mjs#N` / `governance.mjs#N` / `lifecycle.mjs#N` 同；SQL = 真机库只读实测；**推断** = 静态比对得出、未运行验证

---

## 1. 结论摘要（≤300 字）

**判断：修了再开工。**

方向（整主题收敛成一行指针）成立，但现稿有 3 个 critical 阻塞：①收敛边界取「插件收敛前读到的全部旧句」，而 dream 是后台子代理、跑数分钟，期间主 agent 新写的 note 会被当成旧句删除（真机 T-0560 有 43 句在上次 marker 之后）；②P1-1 的 `{topic,pointer,done}` 传输通道未定义（B 版又明确不改 `memory_dream_patch` schema），且 `done` 全靠模型自报、无代码级验证，幻觉即触发不可逆删除；③§8 迁移对「部分提炼」主题会把指针重排到末尾，剩余内容被 A 口径判为已提炼而永不再提炼（真机 3 个此类主题）。

另有 5 个 high（P0-1 漏改提炼块与判据、无事务/pending、校验条件自相矛盾、P2-1 僵尸笔记、审计误标）与 7 个 medium。修掉 C1–C3、H1–H3 后可开工；**P2-1 建议直接推迟**。

---

## 2. 逐条问题（按严重度排序）

### 2.0 八问速答（对应任务书的 8 个必答点）

| # | 问题 | 结论 | 对应条目 |
|---|---|---|---|
| Q1 | 原子性/中断安全：并存期会不会 (a) 重复提炼 (b) 计数污染 (c) endsWith 误判 | (a) 只要 P0-1 正确过滤则**不会重复提炼**；但方案漏改提炼块、且 dream 窗口新 note 会被误删；(b) A 口径不污染，B 口径污染，且缺「收敛未完成」指标；(c) 低频误判，`total` 字段会错 | C1/H1/H3/M3/M5 |
| Q2 | id 捕获时序 / SQLite 单写者假设 | **进程内成立**（DatabaseSync 同步 + 单线程 + 单 store 实例）；**跨进程不成立**（WAL 开但无 busy_timeout、无实例锁；迁移脚本本身就是独立进程） | M1/M2/C1 |
| Q3 | P0-1 过滤会不会误杀部分提炼主题 | 会（若按「含 marker」实现）；正确判据 =「**最后一句是 marker/pointer**」；且必须同时过滤候选池与提炼块两处 | H1 |
| Q4 | 权限与合规 / 审计缺口 | 合规（deleteSentence 只查 `write`，runtime 有 write/delete；dream `delete:false` 只限主题级）。审计有留痕（`sentence.delete` + `deleted.index` 含全文），但 detail 硬编码 `dreamPatchDelete:true`、无批次 id | H5 |
| Q5 | 「不可删三闸」会不会拦到本方案 | **不会**——三闸已在 v2.7.0 删除（代码注释自认），现仅剩 md `replace` 收缩熔断；topic 路径显式跳过 md 校验。`deleteSentence` 不受任何删/收缩闸约束 ⇒ 需要本方案自带的补偿校验 | H5/§4 |
| Q6 | P2-1 归档出口 | 归档后 `memory_search` 明确 skip；`memory_read` 仍可读；但**resume 会话的 memory_note 仍会写进 archived 主题**（无 state 检查）⇒ 僵尸笔记；且重灌第④段不过滤 state，口径分裂 | H4 |
| Q7 | 统计口径 A/B | **A 稳定**（并存期=0、迁移后=0、正常期=新增）；B 在并存期/未收敛期膨胀，不可用。需另加 `pendingCompact` | M3 |
| Q8 | 迁移脚本风险与回滚 | 最大风险 = **C3 指针重排**（部分提炼主题）；其次 WAL 备份不完整、宿主运行中并发、无 dry-run/事务/回滚 API | C3/M6/M7 |

---

### 2.1 CRITICAL

#### C1 [Q1] 收敛边界取错：dream 运行期间主 agent 新写的 note 会被误删（数据丢失）

**现象**
方案 §5 步骤 1 在收敛前读取「旧句 id 全集」，步骤 4 把这些 id **全部删除**；并声称「步骤 3 之后主 agent 再 append 的句子 id 不在 ids 里 ⇒ 必然幸存」。但 dream 是**后台子代理**：`runDreamPipeline` 异步发起（`index.js#19841-19890`），`spawnIntegrate` 以 background 子代理运行（`index.js#19167`），主会话在 dream 跑完前继续工作、继续 `memory_note`（工具随时可调，`index.js#17977-18038`）。dream 单轮通常数分钟；在这段时间内写入的 note，在插件执行收敛时**已经存在于主题里**，因此会进入 `ids` 并被删除——而它们**没有被 dream 提炼过**（dream 读的是更早的快照）。删除后内容只剩 `deleted.index`/audit 里的软删文本（`memory-store.mjs#1429-1440`），检索/注入面全部消失。

真机形态支持该窗口真实存在：`T-0560` 共 67 句，最后一条 marker 在第 24 句（ord=24），**其后的 43 句都是「marker 之后新写入」的 note**（SQL 实测，`lastMarkerIdx=23`）——主 agent 的 note 写入是持续性的，不是 dream 结束才写。

**证据**
- 方案 `§5`（步骤 1/4）、`§5` 末尾「为什么不需要 CAS」（只覆盖「步骤 1 之后」的 append，不覆盖 dream 运行期）
- `index.js#19841`（runDreamPipeline 异步后台化）、`#19167`（spawnIntegrate）、`#19390`（settleDream 在子代理结束后才跑）
- `index.js#17977-18038`（memory_note 随时可写）
- 真机 SQL：`T-0560 live=67 markers=1 lastMarkerIdx=23 afterMarker=43`

**建议**
收敛边界必须由**插件在 dream 启动前快照**，而不是「收敛前一刻」读全集：
1. `spawnIntegrate` 前，对每个将被投喂的笔记主题记录 `snapshot = { topicId, ids:[...], maxSentenceId }`（或 ord 列表）；
2. dream 任务书告知「本主题快照 N 句，只处理前 N 句」；
3. 收敛只删 `snapshot.ids`（或其子集），快照之后新增的句子天然幸存；
4. 校验也按快照口径（见 H3）。
这一改动同时把 Q2 的「id 捕获时序」从「收敛瞬间」提前到「dream 启动瞬间」，窗口从数分钟缩到 0。

---

#### C2 [Q2] P1-1 的 `{topic,pointer,done}` 传输通道未定义；`done` 是模型自报、无代码级验证

**现象**
方案 B 版明确「**不改 `memory_dream_patch` schema**」（方案 `#7`），但 P1-1 又要求 dream「产出 `{topic, pointer, done:true}`」（方案 §4 P1-1）。现有 dream→插件通道只有：
- 子代理最终文本 `outText`（`index.js#19393`，仅用于截断转播/日志 `#19456-19458`，**无结构化解析**）；
- `memory_dream_patch` 工具调用结果（无 `{topic,pointer,done}` 字段，schema `#18052-18075`）；
- 插件侧事实 `DREAM_WRITTEN_TOPICS` / `DREAM_ROUND_WROTE`（`index.js#5635`、`#12505`、`#19487`）——**方案没有使用它**。

因此「dream 已提炼完」目前只能是**模型的一句自述**。若模型幻觉/漏写/提前宣称 done，插件就按它删掉笔记正文 → 内容丢失。MiMo 审计已给出同一教训（`46-mimo-lifecycle-survey.md#L226` N1：不能把数据完整性交给模型心情；`#L293` 官方 spec 自认 prompt+白名单不足）。

**证据**
- 方案 `#7`（不改 schema）、§4 P1-1、§5 步骤 1/5
- `index.js#19393`（outText 仅文本）、`#19456-19458`（只截 200 字转播）、`#18052-18075`（patch schema 无 note 字段）
- `index.js#5635`（DREAM_WRITTEN_TOPICS 现成）、`#12505`（写库成功才记）、`#19487`（settle 可用）
- `index.js#12448-12508`（applyDreamPatchesToDb 逐 patch 应用、逐 patch undo，**非整批事务**；partial success 存在）

**建议**
1. **明确传输通道**（二选一写进方案）：
   - ① 新增 dream-only 小工具（如 `note_compact_mark`），返回 `{topic, pointer}` 结构化值——虽「新增工具」但比解析自由文本可靠；
   - ② 在 dream 最终输出约定严格单行格式（如 `NOTE_COMPACT topic=T-0558 pointer=已提炼 → T-0271（…）`），插件用正则硬解析，解析失败则整主题 skip + monitor。
2. **删前代码级验证**（必须写进 §5）：
   - `doneOk === true`（本轮确有落盘，`LAST_DREAM_WROTE_AT >= startedAt`，`index.js#19414`）；
   - `DREAM_WRITTEN_TOPICS` 非空，且 pointer 中解析出的所有 `T-\d+` 目标 ∈ 本轮已写主题（或目标存在且 `updatedAt >= roundStart`）；
   - 目标主题 state ≠ archived；
   - 任一不满足 ⇒ 不收敛，记 `monitorEvent("intent","note-compact-skip …")`。
3. 顺带把 dream 对笔记主题的**删句权限**收紧（见 H5 建议）。

---

#### C3 [Q3/Q8] 迁移对「部分提炼」主题会把指针重排到末尾 → 剩余未提炼内容永不再提炼

**现象**
方案 §8 步骤 2：「定位最后一条 marker → 删 marker 之前的句 → **把 marker 换成新指针行**」。但 `appendSentence` **只能追加**（`memory-store.mjs#1321-1346`，无插入位置 API；ord 由 `MAX(ord)+1` 分配 `backend-sqlite.mjs#143-150`）。对「最后一条 marker 不在末尾」的主题：先删 marker 及之前句，再 append 新指针 → **新指针落在剩余未提炼句之后**。此时 P0-1 的「最后一条 marker 之后」口径会把整主题判为已提炼（A=0）→ 剩余内容**永远不再被 dream 处理**。

真机恰有 3 个这种主题（SQL 实测）：

| 主题 | live | marker 数 | 最后 marker 位置 | marker 之后未提炼句 |
|---|---|---|---|---|
| T-0558 | 18 | 2 | idx 6（0-based） | **11** |
| T-0560 | 67 | 1 | idx 23 | **43** |
| T-0562 | 3 | 1 | idx 1 | **1** |

**证据**
- 方案 §8 步骤 2（`#112`）
- `memory-store.mjs#1321-1346`（append 只追加）、`backend-sqlite.mjs#143-150`（nextOrd=MAX+1）
- 真机 SQL（上表）

**建议（可把 §8 大幅简化）**
1. 迁移**只处理「最后一句就是 marker」的主题**（真机 7 个 / 17 句），删除 marker 之前的全部句子；
2. **直接保留 legacy marker 作为指针**，不要「换成新指针行」——legacy 文本（`已提炼 → T-xxxx（…）`）本身就是合法指针，替换只会引入排序/格式问题；
3. 「部分提炼」主题（3 个）**不动**，留给运行时收敛：dream 提炼剩余句 → 插件整主题收敛（删全部旧句、append 新指针）→ 顺序自然正确；
4. 无 marker 主题（T-0575/T-0576）不动。
这样 §8 不需要「替换 marker」步骤，C3 与格式问题一并消失。

---

### 2.2 HIGH

#### H1 [Q1/Q3] P0-1 只改候选池不够；过滤判据若宽松会误杀「部分提炼」主题

**现象**
dream 任务书有**两处独立的笔记清单**：
- 候选池 `_notePool` → `candTopics`（`index.js#3773`、`#3786`、`#3788`）；
- 「会话笔记提炼」块 `_noteRows`（`index.js#3811-3820`，独立遍历全部非归档笔记主题）。

方案 P0-1 落点只写 `#3785-3788`（候选池）⇒ 提炼块仍会列出已提炼主题，dream 仍会 `memory_read` 并**重复提炼/重复写长期库**。另外，若「按最后一条 marker 过滤」实现成「主题里含 marker 就过滤」，则部分提炼主题（上表 3 个）会被整主题跳过 → 剩余内容永不再提炼。

**证据**
- 方案 §4 P0-1（`#55`）
- `index.js#3773`（`_notePool`）、`#3786-3788`（候选拼接）、`#3811-3820`（提炼块独立列表）、`#3821-3829`（提炼规则）
- 真机 3 个部分提炼主题（C3 表）

**建议**：两处都过滤；判据用「最后一句是 marker/pointer」（严格）。伪代码见 §2.4 Q3。

#### H2 [Q1/Q2] 无事务、无 pending 清单：中途失败留下永久残留，且失败不可重放

**现象**
方案步骤 3（append 指针）与步骤 4（逐条 delete）是多个独立同步调用，均**非事务**：
- `appendSentence`（`memory-store.mjs#1321-1346`）无 `runInTransaction`；
- `deleteSentence`（`#1405-1440`）也无事务；
- 插件全文件 `runInTransaction` 出现次数 = **0**（grep 实测）。

步骤 4 中途失败（某 id 已被删/被 replace/被合并）会抛错中断；方案 §6 只「留痕，不回滚」，**没有重试机制** → 残留旧句永久留在主题里，而 P0-1 已把主题判为已提炼 ⇒ 不会再被清理。步骤 5 校验失败同样没有重放路径。

**证据**
- `memory-store.mjs#116-165`（`runInTransaction` 已实现、同步、可嵌套）、`#1321-1346`、`#1405-1440`
- `index.js` grep `runInTransaction` = 0
- 方案 §5 步骤 3–5、§6 表（`#100`）

**建议（两阶段 + 幂等重放）**
1. 一次事务内：`append 指针` + 写 meta `notecompact.pending:<topicId> = { ids, pointer, at, batchId }` → 提交（中断则整体回滚，主题保持原样，下次重来）；
2. 逐条删除（每条 `try/catch`：`SENTENCE_NOT_FOUND` 视为已删，继续；其他错误记录后继续）；
3. 每轮 dream settle / 每次插件启动时**重放** pending 清单（幂等），直到清空；
4. 全部删除成功后清 pending meta + monitor `note-compact ok`。
这样既有「指针先落地」的防重复提炼效果，又能自愈中途失败。

#### H3 [Q1] 校验条件 `sentences.length===1` 与「新增句必然幸存」自相矛盾

**现象**
方案 §5 步骤 5 要求「校验：`readTopic(topicId).sentences.length === 1` 且首行 == pointer」。但同一方案承诺「主 agent 在收敛过程中 append 的句子 id 不在 ids 里 ⇒ **必然幸存**」→ 只要 dream 运行期或收敛窗口内有新 note，长度必然 >1 → **校验必然失败**（假告警）。实现者为「通过校验」可能再删一次 → 误删新内容。

**证据**
- 方案 §5 步骤 5（`#81`）vs §5「为什么不需要 CAS」（`#88-89`）、§6 表第一行（`#98`）
- 真机 T-0560 的 43 句后置 note 证明主 agent 持续写入

**建议**：校验改为快照口径——①快照内 id 全部不在 live sentences（`readTopic().sentences`，已过滤 tombstone `#437-443`）；②指针句存在；③快照外句子（新增）数量 ≥0 且文本完整保留；不再要求总数为 1。

#### H4 [Q6] P2-1 归档出口会制造「僵尸笔记」，且与检索/注入口径冲突

**现象**
1. 归档后 `memory_search` 明确 skip archived（`index.js#7379-7381`）；导出视图也排除 archived（`memory-store.mjs#629/#710/#715`）。
2. 但 `memory_note` 找主题用 `store.topics()`（**包含 archived**，`memory-store.mjs#351-361`）+ 名称精确匹配（`index.js#18015`），找到后直接 `appendSentence`——而 `appendSentence` **不检查 state**（`memory-store.mjs#1321-1346`）⇒ 会话 resume 后新 note 写进 archived 主题，成功但：dream 候选排除 archived（`#3770/#3811`）、search 排除、registry 排除（`#7436`）⇒ **永不提炼、不可检索**，成为僵尸主题。
3. `TRANSITIONS.archived = []`（`lifecycle.mjs#24-31`）⇒ 不能自动复活。
4. 压缩后重灌第④段查主题**不过滤 state**（`index.js#14771`）⇒ 同一 archived 主题仍会被注入；与 search/registry 口径分裂。
5. 归档权限上 runtime 可做（`archiveTopic` 查 `setState`，`memory-store.mjs#1478-1510`；runtime `setState:true`，`governance.mjs#247`）。

**证据**：上列行号；方案 §4 P2-1（`#69`）。

**建议**：**本轮不做 P2-1**（它本来就是「可选」）。若坚持要做，至少同时改：①`memory_note` 先判 state，archived ⇒ 新建替代主题（需解决 norm 唯一/命名）或显式 revive（需改 `TRANSITIONS`）；②重灌第④段与 registry/search 统一 archived 口径；③给 P2-1 加「会话不可 resume」前提或改为 dormant 标记。

#### H5 [Q4] 审计有留痕，但 detail 硬编码误标为 `dreamPatchDelete`、缺批次标识

**现象**
`deleteSentence` 的审计 `detail` 是**硬编码** `dreamPatchDelete:true`（`memory-store.mjs#1438`），不区分调用方。笔记收敛（插件内部、非 dream patch）的删除会被审计记成「dream patch 删除」，事后无法与真正的 dream 文本删除区分；也没有批次 id / 收敛原因 / 快照 id 列表，回滚只能靠 `deleted.index` 全文（`#1431`）+ audit 时间猜。

**合规判定**：本身**合规**——`deleteSentence` 只查 `can(actor,'write')`（`#1407`），runtime 有 `write:true/delete:true`（`governance.mjs#247`）；dream 的 `delete:false` 只限制**主题级** `deleteTopic`（`memory-store.mjs#1882` 查 `delete`）；插件用 runtime 代删与既有 dream patch 路径一致（`index.js#12491/#12496/#12501` 等）。**审计缺口**是「无法归因」，不是「越权」。

**证据**：`memory-store.mjs#1429-1440`（尤其 `#1438`）、`#1407`、`#1882`、`governance.mjs#247-248`；方案 §5/§6 无审计要求。

**建议**：①`deleteSentence` 增加可选 `detail`/`reason` 参数（向后兼容），收敛传 `{ by:"note-compact", batchId, topicId, pointerTargets, snapshotIds }`；或 ②收敛时另写一条批次审计 `_audit('note.compact', {topicId, detail:{removed, kept, pointer, batchId}})`（`be.appendAudit` 可直接用，不改 store 语义）；③迁移脚本同样写批次 meta 作为回滚账本。

---

### 2.3 MEDIUM

#### M1 [Q2] 「SQLite 单写者」只在本进程成立，方案把它当全局保证

**现象**
- **进程内成立**：`DatabaseSync` 同步（`backend-sqlite.mjs#63`）+ Node 单线程 + 全插件共用一个 store 实例（`index.js#7263-7264`：`new mod.MemoryStore(be)`）⇒ 只要 `noteTopicCompact` 写成同步函数、read→append 之间无 `await`，本进程内无其他写者插入。
- **跨进程不成立**：WAL 开启（`backend-sqlite.mjs#9`）允许多连接，但**没有 `busy_timeout`**（backend 全文无），也**没有实例锁**；DSH 桌面有单实例锁（宿主 asar `claimDesktopSingleInstance`，外部证据），但 headless/web profile、迁移/升级 CLI 可并发打开同一 `mem.db`——项目自己的迁移器就在扫 `dsh.lock/.dsh.pid` 等候选判断「DSH 是否在跑」（`migrate.mjs#61-168`）。
- 方案 §8 的迁移脚本**本身就是独立进程**：若宿主同时运行，迁移的删除与宿主的 `memory_note` append / dedup 读竞争，且无 busy_timeout 时写冲突直接 SQLITE_BUSY。

**证据**：`backend-sqlite.mjs#9/#63`（无 busy_timeout）；`index.js#7263-7264`；`migrate.mjs#61-168`；方案 §6（`#99`）只提「内存 per-topic 锁」。

**建议**：①收敛包 `store.runInTransaction`（`BEGIN IMMEDIATE` 序列化写，`memory-store.mjs#116-165`）；②backend 增加 `PRAGMA busy_timeout=5000`；③方案 §6 明确「单实例前提」，per-topic 锁注明仅进程内；④迁移必须在宿主停止时运行（或复用 migrate.mjs 的锁检测），不能边跑边迁。

#### M2 [Q2] 按 id 删除未校验 sha：跨进程 replace 会误删新内容；已删会中断循环

**现象**
方案只捕获 `id`；若其他写者（另一实例/迁移）在快照后对同一 id 执行 `replaceSentence`（原地改 text，`memory-store.mjs#1351-1391`），插件仍按 id 删除 → 删掉未提炼的新文本；若对方已删，`deleteSentence` 抛 `SENTENCE_NOT_FOUND`（`#1416`）→ 循环中断（H2）。

**证据**：`memory-store.mjs#1414-1416`（id 选择无 sha 校验）、`#1351-1391`（replace 改同 id）；方案 §5 步骤 4。

**建议**：快照存 `{id, sha}`；删除前比对当前 sha（`liveSentences` 里查），不一致则 skip+monitor；逐条 `try/catch`。

#### M3 [Q7] 统计口径：A 稳定、B 不稳定；缺「收敛未完成」指标

**现象**：见 §2.4 Q7 的计算与推导。方案 §7 只给「A=60 / B=102」两个数字，没有定义计算式，也没定义 marker 判据；现库已漂移为 A=62 / B=102（T-0558 11 + T-0560 43 + T-0562 1 + T-0575 1 + T-0576 6 = 62）。

**证据**：方案 §7（`#103-106`）；真机 SQL；marker 真机样例 `已提炼 → T-0271（2026-11-05 dream：…）`。

**建议**：采用 A 口径 + 单独 `pendingCompact`（见 Q7）。

#### M4 [Q1/整体] 指针/标记格式未定义，导致过滤/幂等/迁移/统计四处口径漂移

**现象**：方案通篇叫「指针文本」，无 canonical 格式。真机 legacy marker 形如 `已提炼 → T-0271（2026-11-05 dream：…）`，且 T-0558 有 2 条（1 条已删）。若引入新格式，P0-1 过滤、幂等 skip（§5「只剩 1 行且就是指针」）、迁移识别（§8）、统计 marker 判据要各写一套正则，必然漂移。

**证据**：方案 §4/§5/§7/§8；真机 marker 样例（SQL）。

**建议**：**沿用 legacy 格式** `^已提炼\s*→\s*T-\d+`（允许尾部 `（…）`），在 `p25-topics.js` 或 store 层提供唯一纯函数 `isNotePointer(text)`，四处共用；新指针也用该格式，不引入新语法。

#### M5 [Q1(c)] `endsWith` 去重与指针/收敛的交互

**现象**
- 去重是「已有句 `endsWith(新文本)`」（`index.js#18030`）。并存期：新 note 等于旧句 → 跳过（正确）；收敛后旧句删除 → 同内容可再 append（产生一条新未提炼句，dream 可能重复写长期库，低频）。
- 若新指针格式在末尾带摘要文本，恰好是其后缀的新 note 会被误判 duplicate（真机 marker 以 `）` 结尾，当前风险低，但格式未定）。
- `total: cur.length + 1`（`index.js#18037`）在收敛后显示错误（1 指针 → 返回 total=2）。

**证据**：`index.js#18030-18037`；方案未提去重交互。

**建议**：去重改为「剥掉 `[HH:MM](kind) ` 前缀后精确相等」；`total` 改为 `cur.length + (dup ? 0 : 1)` 或不展示。

#### M6 [Q8] 迁移备份/WAL/回滚风险

**现象**：方案 §8 只写「备份 `mem.db`」。真机 `mem.db` 26.1MB + **`mem.db-wal` 2.1MB** + `-shm`（fs 实测）；宿主运行中只拷 `.db` 会丢 WAL 里未 checkpoint 的提交。且**没有 undelete API**（`memory-store.mjs` grep `undelete|restoreSentence|reviveSentence` = 0）；回滚只能：DB 文件恢复（丢备份后新写 + 需重启宿主）或按 `deleted.index`（含全文，但**无 ord 字段**，`#1431`）+ audit 文本人工重建（顺序只能按 sentenceId 近似）。

**证据**：真机文件大小；`memory-store.mjs#1429-1440`；grep 无 undelete。

**建议**：备份用 SQLite 在线备份（`VACUUM INTO` / `.backup`）或停宿主后拷 `db+wal`；迁移写批次 meta（`notecompact.migrate:<ts>`：每主题删除 id/文本/原 ord/指针目标）作为回滚账本；提供回滚脚本；每主题一个事务。

#### M7 [Q8] 迁移脚本幂等/dry-run/并发约束未定义

**现象**：§8 只有 3 步，无 dry-run、无「每主题事务」、无「重复执行安全」、无「宿主停止」前提。真实数据含重复 marker（T-0558）、3 个部分提炼主题、2 个无 marker 主题——直接跑风险高。

**建议**：dry-run 输出对账表（每主题 live/将删/保留/迁移后），确认后每主题 `runInTransaction`；幂等（已只剩 1 句则 skip）；停宿主或加锁；执行后守恒校验（删+留=原 live、指针=1）。

---

### 2.4 LOW

- **L1**：方案 §7「A=60 / B=102」与现库实测 A=62 / B=102 有漂移（数据实时变化）；验收时须重新取数并写入口径时间。
- **L2**：方案 §2 引用 `planArchivable#146`，实际 `lifecycle.mjs#142`；`#17993` 实际 SUBAGENT_SKIP 代码在 `#17993-17997`（可接受）。
- **L3**：提炼块句数展示 `t.sentences`（`index.js#3818`）在收敛后显示「1 条」（含指针），语义易混；建议显示「1 指针 + N 未提炼」。
- **L4**：P0-1 过滤需对每个笔记主题 `readTopic`（N+1 查询，`#3811` 目前只拿计数）；当前 12 个主题可接受（dream 每小时一次），可加 store 辅助方法 `lastSentenceOf(topicId)` 减少开销。
- **L5**：方案 §6 的「内存 per-topic 锁」未定义 TTL/泄漏处理，且跨进程无效（M1）。

---

### 2.5 附：Q3 正确过滤伪代码 / Q7 计算式（供方案直接采用）

**Q3 过滤判据（唯一纯函数，四处共用）**

```js
// 唯一 marker/pointer 判据（沿用 legacy 格式，不引入新语法）
const isNotePointer = (text) => /^已提炼\s*→\s*T-\d+/.test(String(text == null ? "" : text).trim());

// 主题是否「已提炼完」：只看 live 句子（readTopic 已过滤 tombstone）
function noteRefined(store, topicId) {
  const rows = (store.readTopic(topicId).sentences || []);
  if (!rows.length) return true;                      // 空主题无需提炼（但新 note 出现后自然变 false）
  const lastMarkerIdx = rows.reduce((acc, s, i) => (isNotePointer(s.text) ? i : acc), -1);
  if (lastMarkerIdx < 0) return false;                // 无 marker ⇒ 未提炼
  return lastMarkerIdx === rows.length - 1;           // 严格：marker 必须是最后一句
}

// P0-1：两处都要过滤（候选池 + 提炼块）
// _notePool  = _live.filter(isNoteName).filter(t => !noteRefined(store, t.id));
// _noteRows  = (store.topics()||[]).filter(nonArchived && isNoteName)
//                 .filter(t => !noteRefined(store, t.id));
```

> 注意：用「严格最后一句」而不是「marker 之后无非 marker 句」——二者在「marker 在中间 + 后面还有未提炼」时都返回 false（正确），但前者还能兜住「尾部有多个 marker 重复」的情况；实现成本相同。

**Q7 计算式（推荐 A + 独立 pendingCompact）**

```js
function noteStats(store, topicId) {
  const rows = store.readTopic(topicId).sentences || [];
  const lastMarkerIdx = rows.reduce((acc, s, i) => (isNotePointer(s.text) ? i : acc), -1);
  const unrefined = rows.length === 0 ? 0
    : lastMarkerIdx < 0 ? rows.filter(s => !isNotePointer(s.text)).length
    : rows.slice(lastMarkerIdx + 1).filter(s => !isNotePointer(s.text)).length;
  // 并存期（pointer + 旧句）A=0：语义正确（旧句已提炼待清理）；
  // 另用 pendingCompact 观测「收敛未完成」：
  // pendingCompact = meta `notecompact.pending:<topicId>` 是否存在（H2 方案）或 verify-fail 计数
  return { unrefined, pendingCompact: hasPendingCompact(store, topicId) ? 1 : 0 };
}
```

**为什么不用 B**：并存期 `B = 总句数 − marker 数` 会把「已提炼但尚未删的旧句」算成未提炼（膨胀）；正常期未收敛时同样膨胀；只有「每次 dream 都成功收敛」时 B 才等于 A。A 在并存期/迁移后/正常期都稳定（并存期 0、迁移后 0、正常期=新增），代价是需要 marker 判据唯一且 marker 语义可信（迁移只对「最后一句是 marker」的主题动手可保这一点）。

---

## 3. 方案需修订的具体条目（直接指出 §几）

| 方案位置 | 修订要求 | 关联问题 |
|---|---|---|
| **§4 P0-1** | ①落点从 `#3785-3788` 扩到「候选池 + 提炼块」两处（`#3773/#3786` 与 `#3811`）；②判据改为「最后一句是 marker/pointer」；③引入唯一 `isNotePointer()`，四处共用 | H1/M4 |
| **§4 P1-1** | ①明确 `{topic,pointer,done}` 的传输通道（新工具或严格输出行格式）；②写明删前代码级验证（`doneOk` + `DREAM_WRITTEN_TOPICS` + pointer 目标存在/非 archived）；③写明「只处理最后 marker 之后的句子」，避免部分提炼主题重复提炼 | C2/H1 |
| **§4 P1-2 / §5** | ①收敛边界改为「dream 启动前插件快照（per-topic ids/maxSentenceId）」，只删快照内 id；②指针 + pending meta 同事务提交；③逐条删除 `try/catch` + sha 校验；④校验改为「快照内 id 全部消失 + 指针存在 + 快照外句子保留」；⑤幂等判据用 `isNotePointer` | C1/H2/H3/M2 |
| **§4 P2-1** | **删除或推迟**；若保留，必须同时修 `memory_note` 对 archived 的处理（复活/新建）并统一 search/registry/rehydrate 口径 | H4 |
| **§6 并发与失败** | ①注明「单实例前提 + per-topic 锁仅进程内」；②收敛包 `runInTransaction`；③backend 加 `PRAGMA busy_timeout`；④pending 清单重放；⑤迁移须停宿主或加锁 | M1/H2 |
| **§7 未提炼口径** | 采用 A 公式（见 §2.5）+ 独立 `pendingCompact`；给出 marker 判据；更新实测数字与取数时间 | M3/L1 |
| **§8 迁移** | ①只迁「最后一句是 marker」的主题（真机 7 个/17 句）；②保留 legacy marker 作为指针，**删除「换成新指针行」步骤**；③部分提炼/无 marker 主题不动；④备份用 SQLite backup/停宿主（含 WAL）；⑤dry-run + 每主题事务 + 批次 meta（回滚账本）+ 幂等 + 守恒校验 | C3/M6/M7 |
| **§9 验收标准** | 补：①dream 运行期主 agent 并发 append 的句子必须幸存；②中断/重放（pending）；③部分提炼主题不误过滤；④迁移 dry-run/回滚；⑤P2-1（若保留）resume 写归档主题的负例；⑥`endsWith` 去重与指针交互 | C1/C2/C3/H2/M5 |
| **§10 CRA 必审点** | 把本报告 C1–C3/H1–H5 的结论补进去；Q2 的「单写者」限定为「进程内」 | 全部 |
| **文档** | `docs/设计文档.md#L56-57`「不可删三闸」已过期（v2.7.0 删除，见 `index.js#12798-12802`），需更新；`46-our` 已指出同一漂移 | Q5 |

---

## 4. 诚实缺口（读了什么 / 没读什么 / 哪些是推断）

**已读**
- 方案全文 134 行；`46-mimo` 全文 305 行；`46-our` 全文 161 行。
- `memtopic/src/memory-store.mjs`：readTopic/appendSentence/replaceSentence/deleteSentence/runInTransaction/topics/_liveSentences/_deletedEntries/_audit/_metaSet/archiveTopic/setState/deleteTopic 相关段（约 #116-165、#180-460、#1278-1510、#1880-1885）。
- `memtopic/src/backend-sqlite.mjs` 全文 204 行（WAL/事务/schema/nextOrd/insertSentence/audit/meta）。
- `memtopic/src/governance.mjs#221-264`（权限矩阵）；`memtopic/src/lifecycle.mjs#15-70/#142-152`（状态/归档阶梯）。
- `index.js`：memory_note（#17957-18042）、dream 候选/提炼块（#3753-3863）、dream 管线/结算（#19167、#19390-19440、#19841-19890）、search skip archived（#7374-7407）、registry slice（#7435-7450）、重灌第④段（#14609、#14761-14794）、applyPatches topic 分支（#12632-12714）、收缩熔断（#12790-12812）、applyDreamPatchesToDb（#12448-12508）、deleteSentence 调用点（#3731、#8002、#8030、#12491-12570）、graph kind（#9684-9704）、topic store 初始化（#7220-7284）。
- 真机库只读 SQL：12 个笔记主题的 live 句/marker 位置/状态、5 个 marker 目标主题状态、`sentence.delete` 审计最近 20 条、`deleted.index` 94 条、WAL 文件大小、全库计数（577 topics / 33564 sentences / 37167 audit）。
- 宿主 asar 单实例锁（`claimDesktopSingleInstance`，外部证据）。

**没读 / 没验证**
1. **未运行任何插件代码/测试**：所有行为结论为静态阅读 + 只读 SQL；未复现 dream、未跑 `noteTopicCompact`（尚未实现）。
2. **未验证 P1-1 的真实可行性**：方案未实现，无法验证「模型是否配合产出 {topic,pointer,done}」「done 自报准确率」「从 outText 解析的成功率」——C2 是设计缺口判断，不是实测失败。
3. **未实测 `runInTransaction` 包住 append+delete 的兼容性**（推断可行：二者均同步、内部 meta/audit 用同一 `be`；但未跑）。
4. **未验证跨进程并发**：无法在用户宿主上安全复现第二实例；「跨进程可并发」是静态推断（WAL + 无 busy_timeout + CLI 存在 + 项目自己的迁移器扫锁）。
5. **未真机复现 P2-1 僵尸路径**：按代码推断（topics 含 archived、appendSentence 无 state 检查、TRANSITIONS 不可复活），未实际归档一个笔记主题再 resume 写。
6. **未读**：`settleDream` 后半段、`spawnIntegrate` 全文、`memory_topics` 层级实现、client 面板代码、`migrate/upgrade` 实现细节（只读锁扫描片段）、`applyPatches` 其余 md 校验链。
7. **真机库是 2026-11-06 15:0x 只读快照**，数字随会话变化（A=62 与方案 A=60 的差异即数据漂移，非矛盾）。
8. **未检查历史版本**：无法判断「部分提炼主题」的 marker 是历史模型漏删/部分提炼所致，还是 marker 语义本身不可信——迁移按「最后一句是 marker」动手可规避，但 marker 作为「已提炼」证据的可靠性仍未验证（推断：当前 append-only 语义下 marker-at-end 通常可信，但无法证明）。

---

*本报告只读审计，未修改方案与任何代码；如需按 §3 修订，建议先落地 C1–C3 + H1–H3，再走实现与验收。*

---

# 5. 二次复核（v2 §12，2026-11-06 15:12–15:30）

> 复核对象：`docs/方案-4.5.2-笔记收敛.md` **§12 CRA 修订（v2）**（`#138-227`，覆盖原 §5/§6/§8）。
> 只审「上次 CRA 的问题是否真被修掉」，不重审整个方案。方式：只读静态核对 + 只读 SQL + 代码行号复验；未运行、未修改方案与代码。

## 5.0 复核判断

**还不能开工。** v2 修掉了 C1 主体、H1、H2 部分、H4、M3/M4/M6/M7，但**仍有 4 处 critical + 3 处 high 未修净**（见 5.3），且 §12 内部有两处自相矛盾（指针格式 vs 过滤判据、pending 重放 vs 快照消费即删）。修完 5.3 的 C1'–C4' 与 H1'–H3' 后可开工。

## 5.1 六问逐条回答

### Q1 · C1 是否真修掉：`sentences.id` 单调递增依赖是否成立

**结论：依赖成立（当前代码 + 正常运维），但需补一条「快照完整性」校验，防 DB 重建。**

证据：
- schema 是 `id INTEGER PRIMARY KEY AUTOINCREMENT`（`backend-sqlite.mjs#31`）⇒ SQLite 保证单调递增、**删除后不复用**（`sqlite_sequence` 机制）。
- 唯一插入路径 `insertSentence` 不指定 id（`backend-sqlite.mjs#147-151`：`INSERT INTO sentences (topic_id,ord,...)`，取 `lastInsertRowid`）。
- 全仓 `memtopic/src` grep：**无** `UPDATE sentences SET id` / `DELETE FROM sentences` / `VACUUM` / `sqlite_sequence` 操作（唯一命中是 `#148` 的 INSERT）。
- `moveSentence` 只改 `topic_id/ord`、**保留 id**（`backend-sqlite.mjs#160-164`；唯一调用方 `memory-store.mjs#1862` = `splitTopic`）。
- VACUUM：SQLite 官方语义对「显式 INTEGER PRIMARY KEY」的表**保留 rowid**（推断/文档知识，非本仓实测）；即使执行也不破坏 `id<=max`。

**残余风险（低/中，需 V4' 兜底）**：
1. **DB 重建/替换**：`upgrade.mjs`/`migrate.mjs` 若在 dream 轮次内重建 `mem.db`（用 store API 导入新库），新库 sentence id 从 1 重新分配 ⇒ 旧快照 `maxSentenceId` 失去意义，`id <= max` 可能误删新库里的新句。缓解：快照记录 `{dbFile, maxSentenceId}`，收敛前校验「快照 max 句仍存在于该主题」或「该主题当前 max id ≥ snapshot.max」，否则 skip+留痕。
2. **split 移入**：`memory_split_topic`（dream 可用）把别的主题句子 move 进笔记主题时 id 保留；若其 id ≤ 快照 max，会被误删。当前 split 是「源→新主题」，笔记主题只可能当源（移出，安全）；作为目标概率极低，建议禁止对 `笔记·` 主题 split/merge（见 Q5-C4'）。
3. 跨进程插入：AUTOINCREMENT 跨连接也单调（sqlite_sequence 表级），无影响。

### Q2 · C2 四项验证够不够防幻觉

**结论：不够。V1 明显过松，幻觉 done 仍可通过；V2 只查存在；V3 与 H2 冲突；V4 太弱。**

证据：
- V1（`§12 C2` 表 `#170`）：「`DREAM_WRITTEN_TOPICS` 非空，或本轮成功次数≥1」。
  - `DREAM_WRITTEN_TOPICS` 在 `index.js#5635` 定义、`#19365` 每轮 `new Set()`、`#19772` 清空；**任何 applied 变更都会加入**（`#12505`/`#12578`：`applied.length` 增长即加，包含 delete；`#17886`/`#17936`：split/review 也加）⇒ **dream 只要在任意主题做过一次删除/拆分/裁决，V1 就通过**。
  - 「本轮成功次数≥1」也没有现成计数器：只有 `LAST_DREAM_WROTE_AT`（`#5594`，任何成功 patch 都刷新，`#18090`），语义是「有过写」不是「写过目标主题」。
  - 因此：模型幻觉 `done` + 指向已存在目标 + 在别处随手写/删一次 ⇒ V1/V2/V4 全过 ⇒ **删笔记正文 = 不可逆丢内容**（上次 C2 的核心风险仍在）。
- V2（`#171`）只查 `store.topics()` 存在；未查 state（archived 也可）、未查「本轮更新」、未拒绝「目标本身是笔记主题」（自指/循环）。
- V3（`#172`）「snapshot 仍存在且未被消费（消费即删）」与 H2（`#198`）「pending 启动重放」**冲突**：快照是内存（`§12.3 P0-2 #214` 写「内存」），进程崩溃后快照丢失；若成功即删快照，pending 重放时又无快照可验 → 重放无法完成。且 pending 记录字段未定义（见 H1'）。
- V4（`#173`）`snapshot.count>0` 只防空主题，不防「快照内容已被并发改动」。

**建议更硬判据（可直接替换 V1/V2）**：
1. **spawn 前基线**：`store.topics()` 一次（577 主题成本可忽略），存 `baseline[id] = {writeCount, updatedAt, state}`（`topics()` 已含这些字段，`memory-store.mjs#385-407` + `row2topic#188-196`）。
2. **V1'**：`targets` 非空；每个 target：存在、`state !== "archived"`、`writeCount > baseline.writeCount` **或** `updatedAt > baseline.updatedAt`（append 会 bump：`memory-store.mjs#1336`；replace 会 bump：`#1388`；**delete 不 bump**：`#1429-1440` 不更新 topic）⇒ 天然排除 delete-only、排除别处写入、排除幻觉。
3. **V2'**：target 不得是 `笔记·` 主题（防自指）；可选要求 target ∈ `DREAM_WRITTEN_TOPICS`（交叉校验）；若 target 是 draft ⇒ 记录 notice（draft 仍可检索：`index.js#7380` 只排除 archived；registry 含 draft `#7436`）。
4. **V4'**：快照完整性（见 Q1 缓解 1）。
5. **V5（新增）**：`doneOk === true`（`index.js#19414`）且本轮未 aborted（`#19417`）。

### Q3 · C2 通道是否可行：从子代理最终文本解析 JSON

**结论：通道本身可行（outText 全文可取），但「与现有 dream 产出解析同源」不成立——现有解析器是 legacy/死代码，需自建严格解析；解析失败降级安全的前提是「不写 marker」。**

证据：
- dream 最终文本：`settleDream` 里 `outText = (result.output||[]).filter(type==="text").join("\n")`（`index.js#19393`），全文在作用域内；广播只截 200 字（`#19449`），不影响解析。
- 现有解析器 `extractDreamJson`（`#12420-12429`）：取**第一个** ```json``` 块 / `[MEMORY_JSON]` / 文本以 `{`/`[` 开头；`applyDreamJson`（`#12956-12964`）是它的唯一包装。**grep 全文件：`applyDreamJson` 没有任何生产调用方**（只有定义 + `#12596` 注释）⇒ 库模式下 dream 今天**不输出也不解析 JSON**；「同源」只是形式上的复用，实际是新通道。
- 容错风险：①模型可能在 JSON 前后加解释、输出多个 ```json``` 块、或 JSON 被 max-tokens 截断；`extractDreamJson` 取第一个块，可能拿错块/拿半截；②`settleDream` 的 lesson 结算也解析 outText（`#19487` 起），两套格式需共存；③宿主是否截断子代理最终输出未验证（**推断**：`result.output` 为宿主返回的完整文本块，未见截断代码）。
- **降级安全性**：§12 `#177` 说「解析失败 ⇒ 不收敛」是安全的（不删）；但 C2 表头 `#166` 又说验证不过「退化为**只追加 marker**（=现状）」——**这是危险回退**：假 marker 会让 P0-1 把主题判为已提炼并永久跳过，若 dream 实际没写长期库，未提炼内容永不再处理（数据从流水线消失）。必须改为「不写任何 marker、不收敛、留痕、下轮重试」。
- **建议解析协议**：在任务书约定哨兵行 + 末尾单个 JSON，如 `NOTE_COMPACT_JSON: {"compact":[...]}`；解析时从哨兵行后取**最后一个平衡 `{}`**（或最后代码块）→ `JSON.parse` → schema 校验：`compact` 数组、每项 `topic` 必须是**本轮候选笔记主题 id**、`pointer` 非空且匹配 `isNotePointer`、`targets` 非空且全为 `T-\d+`、去重、数量上限（如 ≤10）；任一失败 ⇒ 整轮不收敛 + `monitorEvent`。上线前用真实 dream 跑 3~5 轮统计解析成功率（**推断/待验证**）。

### Q4 · H3 断言式是否正确：`剩余 === 1 + newCount`，`newCount = 当前总句数 − snapshot.count`

**结论：不完全正确。依赖「测量时点」与「期间无删句/无跨进程写入」，两个前提都没写明，会误报；建议改 id 口径。**

证据与反例：
1. **测量时点未定义**（`§12 H3 #199`）：若「当前总句数」在**收敛后**测量：收敛后 = 1 + 新增，则 `newCount = 1 + 新增 − snapshot.count`，断言变成 `1+新增 === 1 + 1+新增−snapshot.count` ⇒ 仅当 `snapshot.count===1` 成立 ⇒ 必误报。必须在**收敛前**测量（但方案没写）。
2. **期间有删句 ⇒ 误报**：`deleteSentence` 只 soft-delete，不 bump topic（`memory-store.mjs#1429-1440`）。若 dream 本轮通过 `memory_dream_patch` 删过该笔记主题的句子（**当前允许**：`applyDreamPatchesToDb` 对笔记主题无守卫，delete 分支 `#12493-12496`），或另一实例删除：收敛前总句数 = `snapshot.count − d + a`，`newCount = a − d`；收敛后实际剩余 = `1 + a`，期望 `1 + a − d` ⇒ 差 d ⇒ 假告警。
3. **跨进程在测量后 append**：剩余 = `1 + a + late`，`newCount` 只含 a ⇒ 差 late ⇒ 假告警（进程内同步收敛无此问题；M1 的跨进程前提仍在）。
4. `endsWith` 去重跳过 append：不新增行，`newCount` 不含它 ⇒ 无影响（这点没问题）。

**建议断言（不依赖 count 算术）**：收敛前记录 `preLive = readTopic().sentences`；收敛后：
```
live = readTopic(topicId).sentences
断言 ①：live.every(s => s.id > snapshot.maxSentenceId)          // 快照内旧句全部消失
断言 ②：live.some(s => s.text === pointer)                       // 指针在位
断言 ③：live.filter(s => s.id > snapshot.maxSentenceId).length
        === preLive.filter(s => s.id > snapshot.maxSentenceId).length   // 快照外句子零丢失
```
（①②③ 全部由 id/文本判定，无 count 依赖；跨进程新 append 只会让③的左侧变大 → 应允许 `>=`，并在 monitor 里记录 late 数量。）

### Q5 · 修订后还有没有 critical

**结论：有，4 处（C1'–C4'）。**

| ID | 问题 | 证据 |
|---|---|---|
| **C1'** | **指针格式与过滤判据不一致**：M4（`#205`）把新指针固定为「`<ISO日期> 已提炼 <N> 句 → <T-id列表>…`」（**日期开头**），而 H1（`#197`）/M3（`#204`）/§12.1 的判据是「最后一句是 **marker**」——方案未定义 `isNotePointer` 是否覆盖新格式。若沿用 legacy `/^已提炼/`，首轮收敛后的主题（最后一句=日期开头指针）**不再被 P0-1 过滤** ⇒ 下轮 dream 把指针当未提炼 note 再提炼 ⇒ 重复写长期库/指针自指循环。 | `#197` vs `#205`；legacy marker 真机形如 `已提炼 → T-0271（…）`；P0-1 落点 `index.js#3773/#3786-3788/#3811` |
| **C2'** | **V1 过松，幻觉防护未成立**（详见 Q2）：任意主题写/删一次即通过，无 per-target 校验。 | `#170`；`index.js#5635/#12505/#12578/#17886/#17936`；`LAST_DREAM_WROTE_AT` `#5594/#18090` |
| **C3'** | **迁移只改 marker、不删旧句**：§12.1 C3 片段（`#183-191`）只有「把 marker 就地改写成新指针格式（replace 单句，**不增不减**）」——没有「删 marker 之前的句」。⇒ 迁移后 7 个主题仍是多句（如 T-0559 仍 3 句），且最后一句是新指针 ⇒ P0-1 过滤 ⇒ **旧句永远不会被清理**，迁移目标（收敛成 1 行）未达成。原 §8 的删除步骤被修订时误删了。 | `#183-191`；真机 7 个全提炼主题（T-0559 3 句 / T-0561 2 句 / T-0564 3 句 / T-0566 3 句 / T-0569 2 句 / T-0570 3 句 / T-0571 2 句，SQL 实测） |
| **C4'** | **验证失败回退「只追加 marker」危险**（详见 Q3）：假 marker 让 P0-1 永久跳过未提炼内容；且当前 dream 仍可对笔记主题 patch 写/删（`applyDreamPatchesToDb#12448-12508` 无 `笔记·` 守卫，delete 分支 `#12493-12496`）⇒ append-only 仍无机制保证，V1 也可被 delete 刷过。 | `#166`；`index.js#12448-12508/#12493-12496`；`memory-store.mjs#1405-1440` |

### Q6 · 能否开工

**不能开工。** 还需改 **4 处 critical（C1'–C4'）+ 3 处 high（H1'–H3'，见 5.3）**；改完且补单测后可开工。M 级问题可在实现时顺带修（不阻塞开工）。

## 5.2 上次 CRA 问题：已修 / 未修净

| 上次条目 | v2 修订 | 复核 |
|---|---|---|
| C1 收敛边界 | §12.1 快照 `{maxSentenceId,count}`，只删 `id<=max` | **主体已修**（id 单调成立）；需补 V4' 快照完整性 + 快照存 sha（见 H2'） |
| C2 通道/幻觉 | §12.1 固定 JSON + V1~V4 | **部分修**：通道方向可行但「同源」不成立；V1 过松、V3 与 H2 冲突 → C2'/C4' |
| C3 迁移误伤 | §12.1 只迁「最后一句是 marker」的 7 个 | **过度修正**：不删旧句 → C3' |
| H1 两处过滤 | §12.2 H1 两处 + 严格判据 | **部分修**：两处已覆盖；但判据与 M4 新指针格式冲突 → C1' |
| H2 pending | §12.2 H2 pending meta + 启动重放 | **未修净**：字段未定义、与 V3「消费即删」冲突 → H1' |
| H3 断言 | §12.2 H3 `剩余===1+newCount` | **未修净**：测量时点未定义、删句/跨进程误报 → H3' |
| H4 P2-1 | 推迟 4.5.3 | ✅ 已修 |
| H5 审计 reason | §12.2 H5「传独立 reason」 | **未落地**：`deleteSentence` 签名无 reason 参数（`memory-store.mjs#1405`），审计仍硬编码 `dreamPatchDelete`（`#1438`）；需 store API 改动但未列入改动清单 → M-H5' |
| M1 单写者 | busy_timeout + 检查第二实例 | 部分：未写落点（`backend-sqlite.mjs`）、「检查实例」无方法 |
| M2 sha 校验 | §12.3 P1-2「id<=max 且 sha 匹配」 | **不可实现**：快照只有 `{max,count}`，无 sha 基线 → H2' |
| M3 口径 | 定 A | 判据未覆盖新指针格式（C1'） |
| M4 指针格式 | 固定格式（日期开头） | 与 P0-1 判据冲突（C1'） |
| M5 endsWith | 补单测 | 可接受（未改逻辑，低频） |
| M6 WAL 备份 | checkpoint TRUNCATE + 备份 | 部分：未写「停宿主/检查 checkpoint 返回 busy」 |
| M7 dry-run/事务 | dry-run + 一个事务 | ✅ 基本可接受（需注意嵌套事务已支持，`memory-store.mjs#116-165`） |

## 5.3 还需改的条目（按严重度）

### Critical（4）

- **C1'（指针判据统一）**：定义唯一 `isNotePointer(text)`，必须同时覆盖 ①legacy `^已提炼\s*→\s*T-\d+` ②新格式 `<ISO日期> 已提炼 <N> 句 → …`；P0-1 两处（`index.js#3773/#3786-3788` 与 `#3811`）、M3 统计、§5 幂等、§8 迁移识别**全部调用它**；并在任务书/文档里写死。
- **C2'（V1 硬校验）**：按 Q2 的 V1'/V2'/V4'/V5 替换现 V1/V2；spawn 前 `store.topics()` 基线（`writeCount/updatedAt/state`）；targets 非空、非笔记、非 archived、本轮 writeCount/updatedAt 增长；`doneOk` 为真。
- **C3'（迁移补删旧句）**：对「最后一句是 marker」的 7 个主题，在**同一事务**内：删 marker 之前的全部句（soft delete，`deleted.index` 留全文）+ 把 marker 就地 replace 成新指针（或直接保留 legacy marker，二选一）。因 marker 在末尾，删除不会造成指针重排，安全；备份/对账按 M6/M7。
- **C4'（失败回退 & dream 写权限）**：①验证/解析失败 ⇒ **不写 marker、不收敛**、monitor 留痕、下轮重试（删除「只追加 marker」回退）；②在 `applyDreamPatchesToDb` 加守卫：target 是 `笔记·` 主题 ⇒ dream 只能……（本版建议**一律拒绝 dream 对笔记主题的 patch 写/删**，指针由插件写），使 append-only 成为机制而非约定。

### High（3）

- **H1'（pending 记录定义）**：`noteCompact:pending:<topicId>` 必须持久化 `{snapshot:{maxSentenceId,count,ids?/shas?}, pointer, targets, startedAt, batchId}`；成功清 pending + 清内存快照；启动/每轮先重放 pending（重放前 V3 不再依赖「内存快照」）。否则 H2 未修（崩溃后无法重放）。
- **H2'（快照存 sha + DB 身份）**：快照从 `{max,count}` 扩为 `{maxSentenceId, count, shaById: Map<id,sha>, dbFile}`（M2 的「sha 匹配」才有基线）；收敛前校验 DB 身份/完整性（快照 max 句仍存在或当前 max ≥ snapshot.max），否则 skip。
- **H3'（断言改 id 口径）**：按 Q4 的 ①②③ 替换 `剩余===1+newCount`；明确「preLive 在收敛前测量」；`late`（跨进程新 append）允许 `>=` 并记录。

### Medium（实现时顺带修，不阻塞）

- **M-H5'**：`deleteSentence` 增加可选 `{reason, detail}`（`memory-store.mjs#1405`，向后兼容）或收敛时另写 `note.compact` 批次审计（`be.appendAudit`）；否则 H5 只停留在文档。
- **M-C2 通道**：不要复用 `extractDreamJson`（无生产调用，`index.js#12420/#12956`），按 Q3 的哨兵 + 末个平衡 JSON + schema 校验自建；上线前真机跑 3~5 轮统计解析成功率。
- **M-调用点**：快照必须在 `startSubagentCompat`（`index.js#19369`）之前建立（建议紧随 `DREAM_WRITTEN_TOPICS = new Set()` `#19365`）；收敛必须在 `settleDream` 内、`DREAM_WRITTEN_TOPICS` 清空（`#19772`）之前执行，否则 V1 恒 false。方案 §12.3 未写调用点。
- **M1'**：`PRAGMA busy_timeout` 落点写明（`backend-sqlite.mjs` SCHEMA/构造）；「检查第二个 DSH 实例」给方法（如复用 `migrate.mjs#61-168` 的锁扫描）或明确「本版只支持单实例」。
- **M6'**：`wal_checkpoint(TRUNCATE)` 需检查返回（busy 时不得继续备份）、明确「迁移前停宿主」。

## 5.4 诚实缺口（本次复核）

1. 未运行代码/未跑测试；所有结论为静态核对 + 只读 SQL（真机库 2026-11-06 15:0x 快照）。
2. `id` 单调性结论基于 schema + 全仓 grep（无 id 改写/VACUUM/显式 id 插入）；「VACUUM 对 INTEGER PRIMARY KEY 保留 rowid」为 SQLite 文档知识（**推断**，未实测）。
3. 未验证宿主是否截断子代理最终输出（`result.output`），JSON 解析成功率无实测（方案未实现）。
4. 未验证 `wal_checkpoint(TRUNCATE)` 在宿主运行时的实际返回（推断可能 busy）。
5. 未读 `upgrade.mjs`/`migrate.mjs` 全文（只确认无 `INSERT INTO sentences` 裸 SQL；「升级是否重建 id」为**推断**风险）。
6. 未验证 dream 实际是否会 split/delete 笔记主题（代码允许；概率未测）。
7. 真机 7 个「全提炼」主题的 marker 是否真代表「全部内容已提炼」仍无法证明（marker 自报）；迁移按 marker 删旧句依赖该语义（有备份 + soft delete 可回滚，风险可接受但需在迁移报告里写明）。

---

*二次复核只读，未修改方案与代码。*

---

# 6. 定点复核（v3 §13，2026-11-06 15:34–15:50）

> 复核对象：`docs/方案-4.5.2-笔记收敛.md` **§13**（`#230-331`）的 7 条修法（4 critical + 3 high）。
> 纪律：只审这 7 条修法本身，不重审方案、不找新问题；只读静态核对 + 只读 SQL；未运行、未修改方案与代码。

## 6.0 复核判断

**还要改 6 处**：7 条里仅 **H1' 过**；C1' / C2' / C3' / C4' / H2' / H3' 均不过（其中 C1' 与 C3' 是同一 legacy 判据问题，可一并修）。修掉后即可开工。

## 6.1 7 条修法逐条判定

| # | 判定 | 理由（关键证据） |
|---|---|---|
| **C1'** | **不过** | 新正则 `^\d{4}-\d{2}-\d{2} 已提炼 \d+ 句 → T-\d+`（§13 `#245`）**不识别 legacy marker**（真机形如 `已提炼 → T-0271（2026-11-05 dream：…）`，无日期前缀）⇒ 迁移前/迁移失败的 7 个「全提炼」主题不会被 P0-1 过滤，会重新进 dream 被反复提炼。`isNotePointer` 应同时接受 **新格式 + legacy 格式**（或写死「迁移必须先于插件启用、失败即阻断启动」）。另「endsWith 去重复用」（`#252`）口径未写明（建议：去重时跳过 `isNotePointer` 行，不让指针文本参与后缀判等）。 |
| **C2'** | **不过** | ① **T4 过松**：`至少一个 target 通过`（`#268`）应改为**每个 target 都通过**（pointer 可能列多个 target，未验证的那个被一起背书）；② 缺 **targets 非空**、缺「`targets` 与 pointer 中 `T-\d+` 集合一致」；③ 缺 **`doneOk`**（本轮非 aborted，`index.js#19414`）前置；④ T2 未查新建 target 的 state（新建后被归档仍可过）；⑤ 与 H2' 冲突（见 H2'）。T1 的「writeCount 增长」本身成立（见 6.2-Q2），但建议再交叉校验 `DREAM_WRITTEN_TOPICS`（`#5635`）以压掉跨进程误判。 |
| **C3'** | **不过** | 判据 `isLastSentenceMarker(rows)`（`#282`）**在 §13 中未定义**：若实现成新正则 `isNotePointer`，则 legacy marker 一个都不匹配 ⇒ **迁移 0 命中**；必须显式定义 legacy 判据（`/^已提炼\s*→\s*T-\d+/`）或让 `isNotePointer` 双格式。其余（同事务删 marker 前旧句 + `replaceSentence` 就地改写、marker 在末尾无重排）**可行**：`runInTransaction` 支持嵌套（`memory-store.mjs#116-165`）、`replaceSentence` 在删空后 oldText 唯一（`#1351-1391`）。 |
| **C4'** | **不过** | 方向对，但**守卫范围不够**：① **漏了任务书连带改动**（详见 6.2-Q1）；② 若只在 `p.topic` 校验（`#294-295`），`file` 寻址可经 `dbPatchTopicFor`（`index.js#12438-12446`）+ `normalizeName`（`governance.mjs#17-20`，会删 `/`、`·`、`_` 等分隔符）把 basename 映射到笔记主题（例：文件 `sessions/0ff4d999.md` 的 nb=`0ff4d999` 命中 `笔记·…/0ff4d999`）⇒ 绕过；守卫必须加在**解析后的目标 topic** 上（`applyDreamPatchesToDb#12511` 之后，两条寻址分支都覆盖）；③ `memory_review_topic` 的 merge `into` 笔记主题（`#17894-17923`，`appendSentence` `#17922`）与 `memory_split_topic` 以笔记主题为源（`#17779-17815`；`splitTopic` 会给源主题 append 一句拆分指针，`memory-store.mjs#1866-1868`）是两条旁路，未被守卫覆盖。 |
| **H1'** | **过** | 快照 `{maxId,count,sha:Map<id,sha>}` 可实施：`readTopic().sentences` 含 `sha`（`backend-sqlite.mjs#139-141`），`deleteSentence` 支持 `sentenceId`（`memory-store.mjs#1414-1416`）。实现注意 2 点：① 句已不存在（`SENTENCE_NOT_FOUND`，`#1416`）也要跳过留痕；② `sha:Map` 进 pending 时需序列化为数组（JSON 不支持 Map）。 |
| **H2'** | **不过** | ① 与 C2' **冲突**：C2' 说「验证不过 ⇒ 留 pending 待重试」（`#269`），H2' 说「有 pending ⇒ 启动幂等重做」（`#302`）⇒ 重放会**绕过 C2' 校验**（pending 只存 `{snapshot,pointer,targets,createdAt}`，没有 C2' 的 baseline `writeCount/updatedAt/state` 证据，也没有 `doneOk`）；要么 pending 仅在**全部校验通过后**才写（失败只 monitor、不留 pending），要么把 baseline 一起持久化并在重放时重验。② 缺 TTL（崩溃很久后的 pending 是否还重做）。③「快照仍匹配」判据未定义（建议用 H1' 的 maxId+sha 校验）。④ Map 序列化问题同上。 |
| **H3'** | **不过** | ① 与 H1' **冲突**：H1' 允许 sha 不匹配时**跳过**该句，则收敛后仍存在 `id<=maxId` 的 live 句 ⇒ H3' ①「不存在 `id<=maxId` 的 live 句」（`#303`）必报假失败；应改为「除 skip 清单外不存在」。② 可接受（指针恰好 1 条；但若新 note 文本碰巧匹配指针正则会假失败，低概率）。③ 「快照外句子数量 ≥0 且无异常」是**不可判定式**（数量恒 ≥0），应写死：收敛后 `id>maxId` 的句子集合 ⊇ 收敛前 `id>maxId` 集合且文本逐字一致，允许收敛后新 append 作为超集。 |

## 6.2 两个特别问题的答案

### Q1 · C4' 守卫的连带改动漏了没有？还有别的调用方依赖「dream 能写笔记主题」吗？

**漏了。** 至少 5 处：

1. **任务书必须同批删改**：`index.js#3821-3829` 的「会话笔记提炼」块**最后一句仍要求** dream 给笔记主题追加 marker：
   `#3829`：`提炼完在该笔记主题追加一句「已提炼 → <目标topicId>」（memory_dream_patch 的 action:"append"）…`
   ⇒ 加 C4' 守卫后 dream 每轮都会撞墙/重试。必须删掉该句，改成 §13.3 的 JSON 输出要求（哨兵 + `{"compact":[...]}`）。
2. **`file` 寻址绕过**（见 6.1 C4' ②）：守卫若只看 `p.topic` 字符串，`file` 补丁可经名字归一化命中笔记主题；必须判**解析后的 topic**。
3. **`memory_review_topic` merge into 笔记主题**（`#17894-17923`）：`into` 只校验「存在/非 archived/容量」（`#17895/#17898/#17916`），未拒绝笔记主题；merge 用 `appendSentence`（`#17922`）真写入笔记主题（并 bump writeCount）。应加同款守卫（`into` 不得是笔记主题）。
4. **`memory_split_topic` 以笔记主题为源**（`#17779-17815`）：只拒 archived/domain（`#17784/#17791`）；`splitTopic` 会给源主题 append 拆分指针（`memory-store.mjs#1866-1868`）⇒ 笔记主题被塞入非笔记句、最后一句不再是 note pointer，P0-1 会把它当未提炼重新处理。应拒绝「源主题名以 `笔记·` 开头」。
5. **文案连带**：`memory_note` 工具描述 `index.js#17967` 仍写「提炼过的标「已提炼 → T-xxxx」」——与 C4' 后的实际格式不符，应改为指针新格式；另有 2 个探针脚本读旧 marker（`_q-dream-verify.mjs#27-32`、`_q-note-pending.mjs#10`，非门、不阻塞，但建议同步）。

**结论**：C4' 守卫本身不误伤主 agent（`memory_dream_patch` 对主代理早已 `WRITE_DREAM_ONLY` 拒绝，`index.js#11699/#11741`），也不误伤插件内部收敛（走 store 直调，不经工具）；真正会误伤的是**当前任务书**——必须同批改 `#3829`。

### Q2 · `deleteSentence` 是否真的不 bump `write_count` / `updated_at`？

**确认：不 bump，C2' 的 T1 判据成立。**

- `deleteSentence` 全文（`memory-store.mjs#1405-1441`）只做：查 selector → `deleted.index` push（`#1431`）→ `_setJsonMeta`（`#1432`）→ `deleted.sha` meta（`#1433`）→ `_audit('sentence.delete')`（`#1435-1439`）→ return（`#1440`）；**没有** `updateTopic`。
- 全仓 `updateTopic` 调用点只有：`#1147`（alias）、`#1182`（trigger）、`#1336`（appendSentence 的 `writeCount+1`）、`#1388`（replaceSentence 的 `writeCount+1`）、`#1458`（state 迁移）、`#1603`（markHit，且 `updatedAt: t.updatedAt` 不变）、`#1766`（merge 的 alias/trigger）、`#1993`（state 迁移）——均不在 `deleteSentence` 内。
- 因此：**append/replace 会 bump（可判为「写过」），delete 不会** ⇒ dream 只做 `delete` 时 C2' 的 T1 不通过，符合设计意图。
- 补充：`memory_review_topic` 的 merge 用 `appendSentence` 写 dst（`index.js#17922`）⇒ 会 bump dst writeCount；`splitTopic` 的新主题 writeCount=0 但 `createdAt` 为新（C2' T2 覆盖）。

## 6.3 最小修法清单（改完可开工）

1. **C1'/C3' 合并修**：`isNotePointer` 双格式（新 `^\d{4}-\d{2}-\d{2} 已提炼 \d+ 句 → T-\d+` **或** legacy `^已提炼\s*→\s*T-\d+`）；`isLastSentenceMarker` 显式定义为「最后一句匹配上述任一格式」；迁移仍只处理 legacy 结尾主题；写明「迁移先于插件启用」或双格式兜底。
2. **C2'**：T4 改「**全部** target 通过」；补 targets 非空、targets 与 pointer T-id 集合一致、`doneOk`；T2 加 state≠archived；建议 targets ⊆ `DREAM_WRITTEN_TOPICS`。
3. **C4'**：守卫加在**解析后的目标 topic**（覆盖 topic/file 两分支），并覆盖 `memory_review_topic` merge `into`、`memory_split_topic` 源；同批删改任务书 `#3829`（改 JSON 输出）+ `memory_note` 描述 `#17967`。
4. **H2'**：pending 仅在「C2' 全部通过」后写入（失败只 monitor、不写 pending）；pending 增 baseline（`writeCount/updatedAt/state`）或明确「重放不再校验」；加 TTL（如 24h）；「快照仍匹配」用 maxId+sha 判；Map 序列化数组。
5. **H3'**：① 改为「除 skip 清单外无 `id<=maxId` live 句」；③ 改为「收敛后 `id>maxId` 集合 ⊇ 收敛前集合且文本一致」。
6. **H1'**：补 missing-id 跳过 + skip 清单持久化（供 H3' ①）；Map 序列化。

## 6.4 诚实缺口（本轮）

1. 未运行代码/测试；结论为静态核对 + 只读 SQL（真机库 15:0x 快照）。
2. 未验证 `normalizeName` 文件名映射的真实触发路径（`dbPatchTopicFor` 只对 `file` 补丁生效；dream 是否会发这种 file 路径取决于模型行为——**推断可能**，非实测）。
3. 未验证 dream 实际会不会 split/merge 笔记主题（代码允许；概率未测）。
4. `_q-dream-verify.mjs` / `_q-note-pending.mjs` 只是探针脚本，未确认是否纳入任何门套件（未跑套件）。
5. 未验证 H2' 重放的实际实现方式（方案未实现，`meta` 写入顺序/事务边界只能按描述推断）。

---

*定点复核只读，未修改方案与代码。*
