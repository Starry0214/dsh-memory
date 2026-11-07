# 452 · 实现审计：v4.5.2「笔记收敛」实现 vs 方案 §12/§13/§14

- 审计对象：`index.js`（sha256 `71A0D829B01D14ED558E6111D719E101A70C082AD172CEFBB70F8243FD495E64`，1,505,376B，21,145 行，mtime 2026-11-06 16:12:53）+ `memtopic/src/memory-store.mjs` + `test/_note-compact-selftest.mjs` + `tools/migrate-note-compact.mjs`
- 对照设计：`docs/方案-4.5.2-笔记收敛.md` **§12/§13/§14（v4 收口版）**
- 审计方式：只读静态核对 + 只读 SQL + 在**临时副本**上跑迁移 `--apply` + 跑新 selftest；未修改代码/方案。
- 本报告为独立实现审计，不改变前序 CRA 结论。

---

## 1. 结论

**修了再 apply（4 处小修；核心实现符合 §14）**

- **符合**：C2' 全部 target 校验、C4' 四条旁路、H3' 三硬断言、失败不写 marker/不收敛、任务书改造、pending 主体、迁移主流程、审计 reason。
- **必改（4）**：
  1. **D1**：`§5` 明写的「主题只剩 1 行且就是指针 ⇒ 直接 skip」**未实现**为前置判断；正常流程靠候选过滤兜底，但 dream 误报已收敛主题时会先删既有指针、靠 pending 重放恢复（TTL 过期则指针丢）。`index.js#3993-4086`、`#4053-4075`。
  2. **D2**：**pointer 文本完全信任 dream**（`#4004`、`#4030` 原样 append），`noteFormatPointer` 生产未用、validate 不校验格式；模型格式偏差 ⇒ 断言②失败 → 回滚 → 该主题**每轮重试永不收敛**（无数据丢失但功能失效）。`#3961-3985`、`#4050-4065`。
  3. **D7**：迁移 `readSnapshot` 直接 `SELECT sentences`，**未过滤 `deleted.index` 墓碑**（`tools/migrate-note-compact.mjs#110-114`）；真机 T-0558 有 1 条中间墓碑（raw 18 / live 17，非末句），当前 7 个待迁主题无墓碑 ⇒ 现状安全，但脚本不健壮（末句被 soft-delete 会误判/事务回滚）。
  4. **D8**：迁移**不检查宿主是否运行**（仅 `busy_timeout=8000`，`#209`），M1 要求未落地；`PRAGMA wal_checkpoint(TRUNCATE)` 结果未检查（`#255` 的 `exec` 丢弃返回，busy 静默）。
- **建议（不阻塞）**：D10 性能（见 §4-Q8）；D3/D4/D5/D6/D9/D11/D12 低风险项。

> 若不想等：**dream 收敛核心路径（C2'/C4'/H3'/H2'/失败路径）可先部署**；`tools/migrate-note-compact.mjs` 的 D7/D8 必须在**跑真库迁移前**修好。

---

## 2. 八条重点核验（逐条）

| # | 核验点 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 1 | **C2' 全部 target 通过** + targets 非空 + 与 pointer 一致 + doneOk 前置 | **符合**（一致性口径有低风险偏差） | `noteCompactValidate#3961-3985`：`doneOk!==true` 拒（`#3964`）；`targets` 空拒（`#3967`）；`targets` 与 pointer T-id 比较（`#3968`，**顺序敏感**，同集合不同序会误拒→D3）；对**每个** target 逐个累积错误（`#3973-3984`）⇒ 全部通过才 `ok`；`state=archived`/笔记主题/不存在均拒（`#3975-3977`）；已存在 target 要求 `writeCount` 增长（`#3979-3980`），新 target 要求 `createdAt > spawnAt`（`#3982`）。settle 传入真实 `doneOk`（`#19899`）。selftest D1-D10 覆盖七类失败。 |
| 2 | **C1'/C3' 双格式判据**：一处定义、四处复用、有无漏用 | **部分符合（偏离 2 处）** | 定义：`NOTE_POINTER_RE#3776` + `isNotePointerText#3785`（双格式）；`noteTopicDistilled#3809-3812`（末句判据）。复用：候选过滤 `#4146`、提炼块 `#4184`、统计 `#3820/#3825`、`memory_note` dedup `#18482`。**漏用**：①**幂等** `#4025-4032` 只用「文本全等」找已有指针，没有「末句是指针 ⇒ skip」的判据前置（D1）；②`memory_read` 渲染 `#12084-12089` 未用判据（仅展示，低）。迁移脚本**另抄一份**判据（`tools/migrate-note-compact.mjs#45-51`，D9 漂移风险）。全仓无「仅 legacy 正则」的残留（grep `已提炼` 只剩注释/RE）。 |
| 3 | **C4' 四条旁路**是否堵住 + 是否用解析后 topic | **符合** | `dbPatchGuardTopic#12848-12868`：topic 寻址走 `resolveTopicRefByStore`（`#3752`，解析后 topic 对象），file 寻址走 `assertMemoryWrite + dbPatchTopicFor`（`#12859-12866`），global/index 例外。整批预扫：`applyPatches#13058-13077` 命中即整批 `NOTE_TOPIC_DREAM_FORBIDDEN`（`#13069-13074`，不半批落盘）；apply 循环另有兜底 `#12898`（topic）/`#12938`（file）。review `into` 守卫 `#18348-18349`；split **源**守卫 `#18231-18233`。任务书旧 marker 要求已删：`#4204-4211` 改为哨兵+JSON；grep「追加一句「已提炼」」= 0，selftest I4 断言。`memory_note` 文案 `#18418` 已改。**旁路残余（低）**：`memory_split_topic` 的 `newName` 未禁止 `笔记·` 前缀（新主题可被命名成笔记前缀，无数据损失，仅语义脏）；`resolveTopicRefByStore` 不解析 aliases（笔记主题 aliases 为空，推断无绕过）。 |
| 4 | **H3' 三硬断言**（id 口径、无 1+newCount） | **符合** | `#4050-4065`：①`after` 中不存在 `id<=maxId && sha 匹配快照` 的 live 句（`#4053-4059`）；②`isNotePointerText` 恰好 1 条（`#4060-4061`）；③快照外句（`id>maxId` 的起始基线）逐条存在且 sha 未变（`#4034-4035`、`#4062-4065`）。全仓 `1 + newCount`/`newCount` = 0 命中。**偏差（低）**：断言失败回滚用 `appendSentence` 补回旧句（新 id、顺序移到末尾，`#4069-4073`），best-effort 可接受。 |
| 5 | **H2' pending**：先写 pending、重放重过 C2'、TTL、sha 序列化 | **基本符合（2 低风险偏差）** | 字段：`#4016-4024` 含 `{topicId,snapshot{maxId,count,sha,createdAt},pointer,targets,baseline,spawnAt,createdAt,ttlMs}`；**先写 pending 再动手**（`#4024` 在 append `#4030` 之前）；成功删（`#4077`）；启动重放 `#20993-21006`（+10s/+120s），`noteCompactReplayPending#4088-4110` **重走 `noteTopicCompact`**（baseline 取自 pending、target 校验用当前状态，`#4103-4106`）；TTL 30 分钟（`#3778`、`#4097-4100`）；`sha` 是普通对象非 Map（`#3858`、`#4018`）。**偏差**：①重放强制 `doneOk:true`（`#4105`），未真正重验 doneOk（pending 仅在 doneOk 通过后写，风险低→D5）；②pending 存**全量 baseline**（577 主题，实测 JSON 78,059B/条，`#3866-3879`+`#4020`），单轮≤10 条 ⇒ meta 写放大 ~0.76MB（D6）。 |
| 6 | **失败路径**：不写 marker、不收敛 | **符合** | C2' 校验失败在写 pending/指针**之前**返回（`#4006-4009`），selftest D9「失败不写指针」、D10「失败不写 pending」；断言失败回滚（删指针 + 补回已删句，不写 marker，`#4066-4075`）；解析失败/无哨兵 ⇒ 不收敛（`#19891-19893`）；dream patch 守卫从机制上禁止 dream 写 marker（#3）。 |
| 7 | **迁移脚本** | **基本符合（2 中风险偏差）** | 只迁「最后一句是 **legacy** marker」：`#117-119`（`already-pointer`/`last-not-marker` 跳过）；单事务：`#211` `store.runInTransaction` 包住全部主题；写前 `PRAGMA wal_checkpoint(TRUNCATE)`（`#255`）+ `VACUUM INTO` 备份（`#170-184`，失败回退 db+wal+shm 复制）；`--dry-run` 默认且只读（`readSnapshot` 用 `readOnly:true`，`#106`）；`--apply` 后复核 0 待迁（`#263-268`）；删除带独立 reason `note-migrate`（`#222-225`），replace 就地改写（`#227`）。**实测**（见 §3）：dry-run 12 主题 → 待迁 7 / 跳过 5 / 删 11 句，与自报一致；在 `VACUUM INTO` 副本上 `--apply` 成功：迁移 7、复核 0、备份 mode=`vacuum-into`（24.80MB）。**偏差**：D7 墓碑未过滤；D8 未检查宿主运行/checkpoint 结果未检查。 |
| 8 | **新风险**：新读路径拖慢任务书？统计四落点重复计算？ | **有（性能，中）** | 见 §4-Q8：`store.topics()` 实测 **684ms/次**（577 主题）；新增 `noteUnrefinedStats` 3 个调用点（`#4224` 任务书、`#9197` stats 快照、`#12042` memory_topics，其中 `#9197` 调用方已有 `topics` 数组仍重算）、spawn 快照 2 次（`#3849/#3870`）、每个 topic 寻址 patch 的守卫 2 次（`#13065` 预扫 + `#12895` 兜底，均经 `resolveTopicRefByStore#3756` 内部 `topics()`）、每个收敛项 2 次（settle `#19895` + validate `#3970`）。**量级**：dream 任务书 +~0.7s、spawn +~1.4s、每个 patch +~1.4s、每个收敛项 +~1.4s（10 项≈14s）；stats.json / memory_topics 各 +~0.7s。**无重复计数**：统计四落点中面板 `#9379-9380` 只读缓存字段；但 stats 快照与 memory_topics 各自重算整库（可优化）。 |

---

## 3. 验证记录（可复现）

| 项 | 命令/方式 | 结果 |
|---|---|---|
| 指纹 | `Get-FileHash index.js -Algorithm SHA256` | `71A0D829…95E64`，1,505,376B ✓ 与自报一致 |
| 语法 | `node --check index.js` | exit 0 |
| 新门 | `node test/_note-compact-selftest.mjs` | **69/69 全过**（含 A 判据/口径、B 成功、C sha 跳过、D 七类失败、E 幂等、F pending/TTL、G 守卫、H 统计、I 接线、J mock dream 端到端） |
| 迁移 dry-run（真库只读） | `node tools/migrate-note-compact.mjs` | 12 主题 → 待迁 7 / 跳过 5（last-not-marker=5）/ 删 11 句；未写库 |
| 迁移 apply（临时副本） | `VACUUM INTO` 副本 + `--apply` | 迁移 7；备份 `vacuum-into` 24.80MB；复核「剩余待迁移 0（幂等 OK）」；副本内容复核 raw 行数不变（soft delete 语义） |
| 墓碑检查（真库只读） | 解析 `meta.deleted.index` 对比 raw/live | 全库墓碑 94；笔记主题 12 个，仅 T-0558 有 1 条**中间**墓碑（raw 18/live 17）；无「末句是墓碑」主题 ⇒ 当前迁移安全（D7 为潜在风险） |
| 性能（副本） | `store.topics()` / note 统计等价 / baseline 体积 | `topics()`=**683.73ms/次**（577 主题）；`readTopic×12`=9.83ms；note 统计等价=570ms；baseline JSON=**78,059B**（577 主题） |
| 差异范围 | `git status --short` / `git diff --stat` | 仅 `index.js`（+554/−11）、`memtopic/src/memory-store.mjs`（+9/−4）；新测试与迁移脚本为 untracked 新文件 ✓ 无越界改动 |

---

## 4. 八问详细回答

### Q1 · C2' 是否真按「全部 target 通过」
**是。** `noteCompactValidate` 对 `targets` 逐个检查并累积 `errors`（`#3973-3984`），`ok = errors.length===0`（`#3985`）；targets 空拒（`#3967`）；与 pointer 的 T-id 比较（`#3968`）；`doneOk!==true` 拒（`#3964`）。**唯一口径偏差**：`targets.join(",") !== ptrTargets.join(",")` 是**顺序敏感**比较（集合相同但顺序不同 ⇒ 误拒，安全方向但会浪费一轮）；建议改 set 比较（D3）。`parseNoteCompactPayload` 已对 targets 去重并校验 `^T-\d+$`（`#3911-3914`）。

### Q2 · C1'/C3' 双格式判据是否一处定义、四处复用
**一处定义 ✓，四处复用 3/4，另 2 处漏用：**
- 定义：`NOTE_POINTER_RE#3776`（legacy `已提炼\s*→\s*T-\d+` + 新日期格式）+ `isNotePointerText#3785`。
- 复用：候选过滤 `#4145-4146`、提炼块 `#4184`、统计 `#3814-3841`（含 `noteUnrefinedCount#3820`）、`memory_note` dedup `#18482`。
- **漏用 1（D1）**：`noteTopicCompact` 的幂等分支（`#4025-4032`）用「文本全等」找已有指针，**没有** `noteTopicDistilled` 前置 skip（§5 明写）；正常流程靠 `_notePool`/`_noteRows` 过滤兜底，但 dream 误报已收敛主题时会进入危险路径（见 D1）。
- **漏用 2（低）**：`memory_read` 渲染（`#12084-12089`）未用判据（计划 §13-C1' 原话要求复用；仅展示层，无功能影响）。
- 迁移脚本另抄一份判据（`#45-51`），与 index.js 未共享（D9）。

### Q3 · C4' 四条旁路
**全部堵住，且判定的是解析后 topic：**
1. `memory_dream_patch`：`dbPatchGuardTopic`（`#12848-12868`）——topic 寻址 `resolveTopicRefByStore`、file 寻址 `dbPatchTopicFor`（含 `assertMemoryWrite` 归一）；整批预扫命中即整批拒绝（`#13058-13077`）；apply 循环兜底 `#12898`（topic）/`#12938`（file）。
2. **file→topic**：预扫/兜底都用 `hit.topic.name`（`#12865-12866`、`#12938`），非入参字符串 ✓。
3. review `into`：`#18348-18349`（`dst` 来自 `resolveTopicRefByStore`）。
4. split 源：`#18231-18233`（`rt.name` 来自 `store.readTopic`）。
- 任务书旧 marker 已删（`#4204-4211`，selftest I4）；`memory_note` 文案 `#18418` 已改；dream patch 被拒返回 `NOTE_TOPIC_DREAM_FORBIDDEN`（`#13069-13074`）。
- 残余低风险：`memory_split_topic` 的 `newName` 未禁止 `笔记·` 前缀；`resolveTopicRefByStore` 不解析 aliases（笔记主题 aliases 为空）。

### Q4 · H3' 三硬断言是否 id 口径
**是。** `#4050-4065`：① `after` 中不存在 `id<=snapshot.maxId && sha 匹配快照` 的句（`#4053-4059`）；② `isNotePointerText` 恰好 1 条（`#4060-4061`）；③ 快照外句（起始 `id>maxId` 的 live 基线，`#4034-4035`）逐条存在且 sha 未变（`#4062-4065`）。全仓无 `1+newCount`（grep 0）。回滚补回用 append（新 id/顺序变），best-effort（D11）。

### Q5 · H2' pending
- 字段：`#4016-4024`（含 `snapshot/pointer/targets/baseline/spawnAt/createdAt/ttlMs`）；**先写 pending 再动手**（`#4024` → `#4030`）；成功后删（`#4077`）。
- 重放：启动 +10s/+120s（`#20993-21006`）→ `noteCompactReplayPending#4088-4110` → 重新调用 `noteTopicCompact`，**target 校验用当前状态重算**（`#4103-4106`，baseline 取自 pending）✓。
- TTL 30 分钟（`#3778`、`#4097-4100`，超时删+留痕）✓；sha 已序列化为普通对象（`#3858`、`#4018`）✓。
- 偏差：**重放强制 `doneOk:true`**（`#4105`，D5，低）；pending 存全量 baseline（D6）；`notePendingPut` 先写 rec 再写索引（`#3940-3944`），crash 间隙产生孤儿 rec（D12，低）。

### Q6 · 失败路径
- C2' 失败：在写 pending/指针之前返回（`#4006-4009`），不写 marker、不收敛；selftest D9/D10 验证正文零改动。
- 断言失败：删指针 + append 补回已删句（`#4066-4075`），不写 marker；pending 保留待重放。
- 解析失败/无哨兵：整段跳过（`#19891-19893`），笔记原样。
- dream 侧：任务书不再要求写 marker（`#4204-4211`），且 patch 守卫物理拒绝（#3）⇒ 无法造假 marker。

### Q7 · 迁移脚本
**主流程符合，2 处偏差：**
- ✓ 只迁「最后一句是 legacy marker」（`#117-119`）；`already-pointer`/`last-not-marker` 跳过；同一事务（`#211`）；删除带 `reason=note-migrate`（`#223`）；marker 就地 `replaceSentence`（`#227`，marker 在末尾无重排）；`--dry-run` 默认只读（`readOnly:true`，`#106`）；写前 checkpoint + `VACUUM INTO` 备份（`#255/#170-184`）；apply 后复核幂等（`#263-268`）。
- ✓ 实测：dry-run 与自报一致（12→7/5，删 11）；副本 `--apply` 成功（7 迁移、备份 `vacuum-into`、复核 0）。
- ✗ **D7**：`readSnapshot` 的 `sentsStmt`（`#110-114`）直接查 `sentences` 表，**未过滤 `deleted.index` 墓碑**；真机 T-0558 有 1 条中间墓碑（raw 18/live 17），当前 7 个待迁主题无墓碑（现状安全）；若末句被 soft-delete，会把墓碑当 marker（`replaceSentence` 抛 TEXT_NOT_FOUND → 整事务回滚）或把已删句计入删除清单（`deleteSentence` SENTENCE_NOT_FOUND 被吞，`#224`）。建议改用 `store.readTopic` 或解析 `deleted.index`。
- ✗ **D8**：未检查宿主是否运行（仅 `busy_timeout`，`#209`），M1「停宿主/检测实例」未落地；`wal_checkpoint(TRUNCATE)` 的结果被 `exec` 丢弃（`#255`，busy 时静默继续）；备份 `VACUUM INTO` 在 readOnly 连接实测可用（本机 Node 24.22），但若失败回退「db+wal+shm 复制」在宿主运行时可能不一致。
- 低：D9 判据两份；apply 内 `errors` 只用于「跳过」，事务内跳过不影响整体提交（可接受）。

### Q8 · 新风险
**性能（中）**：`store.topics()` 在真库副本上实测 **683.73ms/次**（577 主题，5 次平均）；本次新增调用：
- `noteUnrefinedStats`（内部 `store.topics()` + 每笔记主题 `readTopic`）3 处：任务书 `#4224`、stats 快照 `#9197`（**调用方已有 `topics` 数组仍重算**）、memory_topics `#12042`；
- spawn 前快照 2 处：`noteTakeSnapshot#3849`、`noteTakeTargetBaseline#3870`（各一次 `topics()`）；
- dream patch 守卫：预扫 `#13065` + apply 兜底 `#12895`，每个 topic 寻址 patch 各一次 `resolveTopicRefByStore`（内部 `topics()`，`#3756`）⇒ **2×/patch**；
- 收敛：settle `#19895` 解析 + `noteCompactValidate#3970` 各一次 ⇒ **2×/item**。
- 量级：任务书构建 +~0.7s；spawn +~1.4s；每个 topic patch +~1.4s；每个收敛项 +~1.4s（10 项≈14s）；stats.json/memory_topics 各 +~0.7s。
- **无重复计数**：统计四落点中面板 `#9379-9380` 只读缓存字段；stats 快照与 memory_topics 各自重算整库（可优化）。
- 建议：`noteUnrefinedStats(store, rows?)` 接受已取行；`noteCompactValidate` 接受 `rows/byId`；`resolveTopicRefByStore` 加 rows 参数或复用 `applyDreamPatchesToDb` 已取的 `rows`；stats 快照直接传 `topics`。
- 其他新风险：split `newName` 可带 `笔记·` 前缀（低）；pending 全量 baseline 写放大（D6）；rollback append 补回改变顺序（D11）。

---

## 5. 偏离清单（按严重度）

| ID | 严重度 | 偏离 | 证据 | 建议 |
|---|---|---|---|---|
| D1 | 中 | §5「只剩 1 行且就是指针 ⇒ skip」未实现为前置判据 | `#3993-4086`、`#4025-4032`；误报已收敛主题时断言①失败→回滚删既有指针（`#4068`），靠 pending 重放恢复；TTL 过期则指针丢 | `noteTopicCompact` 开头加 `if (noteTopicDistilled(store,tid)) return {ok:true, skipped:"already-distilled"}` |
| D2 | 中 | pointer 完全信任 dream，未校验/重生成；`noteFormatPointer` 生产未用 | `#4004`、`#4030`；validate `#3961-3985` 无格式检查；断言② `#4060` 才暴露 ⇒ 模型格式偏差时每轮回滚、永不收敛 | validate 加 `isNotePointerText(pointer)`；或插件按 targets/count 用 `noteFormatPointer` 重生成（模型 pointer 仅参考） |
| D7 | 中 | 迁移 `readSnapshot` 未过滤墓碑 | `tools/migrate-note-compact.mjs#110-114`；真机 T-0558 中间墓碑 1 条（当前 7 个待迁主题无墓碑） | 用 `store.readTopic` 或解析 `meta.deleted.index` 过滤 |
| D8 | 中 | 迁移未检查宿主运行；checkpoint 结果未检查 | `#209`、`#255`；M1 未落地 | 复用 `migrate.mjs` 的锁扫描或文档强制停宿主；检查 checkpoint 返回 |
| D10 | 中 | 性能：重复 `store.topics()`（684ms/次） | 见 Q8 | 复用 rows/加参数，stats 快照传 `topics` |
| D3 | 低 | targets 与 pointer 比较顺序敏感 | `#3968` | 改 set 比较 |
| D4 | 低 | 空主题不 skip（§5 step 2） | `#3993-4086` 无 `count>0` 校验 | 加 `snap.count===0 ⇒ skip` |
| D5 | 低 | 重放强制 `doneOk:true` | `#4105` | 记录说明（pending 仅在 doneOk 通过后写） |
| D6 | 低/中 | pending 全量 baseline（78KB/条） | `#3866-3879`、`#4020` | 只存 targets 子集 |
| D9 | 低 | 判据在 index.js 与迁移脚本各一份 | `#3776` vs `tools/...#45-51` | 抽共享常量或注释同步 |
| D11 | 低 | 断言失败回滚 append 补回旧句（新 id/顺序变） | `#4069-4073` | 可接受，监控留痕 |
| D12 | 低 | pending rec/index 两次独立写 | `#3940-3944` | 可接受（孤儿 rec 不重放） |
| D13 | 低 | split `newName` 未禁 `笔记·` 前缀 | `#18216`、`#18231-18233` 仅守源 | 加 `isNoteTopicName(newName) ⇒ 拒` |

---

## 6. 诚实缺口

1. **未在真实宿主进程内跑 dream 端到端**：selftest J1-J3 是 mock 子代理 + 真实 dream 工具，未验证真实模型输出哨兵/JSON 的合规率（模型可能不输出或格式漂移，D2 风险量化不了）。
2. **未跑完整既有门套件**：只跑 `node --check` + `test/_note-compact-selftest.mjs`（69/69）；未跑 `_dream-*`/`_memory-note-*`/`_p25-*` 等回归门，其他门可能对任务书文本/统计字段有断言（可能被 `#4204-4211` 文案变更影响，未验证）。
3. **性能数字来自 `VACUUM INTO` 副本 + 5 次平均**：宿主进程内真实 `store.topics()` 可能因缓存不同而偏快/偏慢；量级结论（+0.7~1.4s/调用）为推断。
4. **迁移 `--apply` 只在副本上验证**（未碰真库）：真库需停宿主后执行；D7 的「末句墓碑」场景在真库未出现（当前 7 个安全），属推断风险。
5. **pending 重放未做进程级 kill 测试**：selftest F 覆盖 TTL/重放逻辑，未验证真实崩溃时序。
6. **alias 旁路未实测**：`resolveTopicRefByStore` 不解析 aliases；笔记主题 aliases 为空（推断无绕过）。
7. **`_q-*` 探针脚本未同步**：`_q-dream-verify.mjs`、`_q-note-pending.mjs` 仍用 legacy 正则（非门、不阻塞）。
8. 未审 `docs/方案` 与实现注释的逐字一致性（只按 §12/§13/§14 行为要求核对）。

---

*实现审计只读，未修改代码与方案。*

---

# 6. 第 4 轮定点复核（5 处修法，2026-11-06 16:42–17:05）

> 对象：`index.js` sha8 `1AE39270`（sha256 `1AE3927059DCC70B8929F82F289D9FC5943101352921C88430EE4CB87B610D45`，1,512,718B，21,245 行）+ `tools/migrate-note-compact.mjs`（21,578B，379 行）。
> 纪律：只审 D1/D2/D7/D8/D10 五处修法是否真修掉；只读，未修改代码/方案；真库未写（迁移只在临时副本上演练）。

## 6.0 结论

**还要改 1 处（D8 checkpoint 落点）；D1/D7/D10 过，D2 过（留痕小缺口，建议补、不阻塞）。**

- 迁移可在「**正常退出 DSH（WAL 已清）**」后执行；若宿主曾崩溃遗留 WAL，D8 的 readOnly checkpoint 会抛 I/O error → exit 3（安全但被误挡），建议先修 D8 或重启一次宿主。
- 自测复核：`_note-compact-selftest` **81/81**、`_p0-impl-selftest` 71/71、`_dream-cand` 12/12、`_p25-write-guard` 47/0（2 skip）、`_memory-note` 34/34 —— 我实跑均通过。

## 6.1 五条修法逐条判定

| # | 判定 | 理由 / 证据 |
|---|---|---|
| **D1 幂等** | **过** | `index.js#4044-4053`：`st0.sentences.length === 1 && isNotePointerText(st0.sentences[0].text)` 才 skip（`#4049`）；skip 时 `notePendingDel`（`#4050`）、**不删既有指针**、正文零改动；K1/K2 覆盖。单句**非指针**笔记不会误 skip（条件要求指针判据）；唯一极端误伤：用户笔记文本恰好匹配指针正则（几乎不可能）。 |
| **D2 pointer** | **过（留痕小缺口）** | `#4062-4073`：T-id 与 targets 不一致**或** pointer 非合法指针行 ⇒ 按 targets 用 `noteFormatPointer` 重生成（`pointerRegenerated=true`）；随后 `noteCompactValidate` 以 `requirePointerFormat:true` **再过一次格式校验**（`#4002`、`#4077`）⇒ 不会再每轮回滚；K3-K5 覆盖。留痕：monitor `compact-pointer-regen <tid> model=<原 pointer 前80字>`（`#4073`）——有 topicId+原 pointer，**无 targets**；pending rec 含 `pointerRegenerated/targets/最终 pointer`（`#4089-4096`）但成功后删除；返回体含 pointerText/targets（`#4152`）。建议 monitor 补 targets（不阻塞）。 |
| **D7 墓碑** | **过** | 迁移 `readSnapshot` 读 `meta.deleted.index`（`migrate#114-133`），现代条目按 `sentenceId`、旧式按 `topicId+sha` 兜底过滤；真库实测 94 条**全部**有 sentenceId/topicId/sha（sentenceId 均存在于 sentences），`deleted.sha:*` 94 条与 index 1:1（迁移未读，冗余）。端到端造数：副本 T-0559 软删中间句后 dry-run 输出「句 2 → 1（删 1）（墓碑已过滤 1）」，合计删 10 = 11−1，**对账一致**（`before/deletes` 用 live 行 `#140/#149`；墓碑单独列 `#177`；合计只加 live 删除 `#190`）。残余（低）：legacy 条目若缺 topicId（键 `""`）会漏匹配；真机无此形态。 |
| **D8 宿主/checkpoint** | **不过（宿主检测过，checkpoint 落点错）** | 宿主检测 `migrate#263-306`：实测本机抓到 8×`DeepSeek Harness.exe` → `--apply` **exit 2 拒绝**（`#346-351`），且 assertNoHost 在 checkpoint/backup 前 ⇒ 未写库（输出无备份行、副本无 .bak）；`--force` 有显式 warning（`#302`）+ help 说明（`#78`），警示足够。**问题**：`walCheckpointTruncate` 在 **readOnly 快照连接**上执行（`#332` 的 `readSnapshot` 连接 → `#354`）——readOnly 连接无法真正 checkpoint/truncate WAL；实测有活动写连接时抛 `disk I/O error`（而非 busy=1）→ exit 3（**未写库已验证**：bak=0、副本 mtime 不变）；「宿主崩溃遗留 WAL」场景同样会被 exit 3 误挡。建议 checkpoint 改到 `applyPlan` 的**写连接**（事务前）或备份后跳过 checkpoint 仅留宿主检测。 |
| **D10 性能** | **过（无副作用）** | `noteUnrefinedStats(store, rowsOpt)#3828-3849`、`noteTakeSnapshot(store, topicIds, rowsOpt)#3852-3874`、`noteTakeDreamSnapshots#3890-3908`（整库 1 次 rows）、`resolveTopicRefByStore(store, ref, rowsOpt)#3754-3758`、`noteCompactValidate({rows})#4003-4014`；K9/K10/K11 断言 `topics()` 调用次数 0/1/0。传 rows 调用点见 §6.2-Q5，均无正确性副作用（内容一律 `readTopic`/`be.getTopicById` 重读，rows 只做枚举/兜底）。 |

## 6.2 六问逐条回答

### Q1 · D1 会不会误伤（严格判据？单句非指针笔记？）
**不会。** 判据严格为「`st0.sentences.length === 1` **且** `isNotePointerText(st0.sentences[0].text)`」（`#4049`）；单句**普通笔记**不满足指针判据 ⇒ 不 skip，走正常收敛（需 snapshot/C2' 校验）。skip 分支只 `notePendingDel`+monitor，不删句、不 append（`#4050-4052`）。K1/K2 验证「skip 后正文逐字不变」。唯一理论误伤：用户笔记文本恰好匹配 `已提炼 → T-…` 或 `<日期> 已提炼 N 句 → T-…`（概率可忽略）。

### Q2 · D2 重生成 pointer 是否可信 / 留痕是否够
- **可信**：重生成后仍走 `noteCompactValidate` 且 `requirePointerFormat:true`（`#4002/#4077`）⇒ `isNotePointerText` 二次校验；K4 断言重生成指针可被同一判据识别、T-id 与 targets 一致；K5 断言正文只剩该指针。
- **留痕**：monitor 行含 **topicId + 原 pointer（截 80 字）**（`#4073`），但**不含 targets**；pending rec 有 `pointerRegenerated/targets/最终 pointer`（`#4092-4093`）但成功即删；返回值含 pointerText/targets（`#4152`）。⇒ 定位 topic 与原 pointer 足够，**targets 需从最终指针行/返回值看**。建议 monitor 补 targets（或 `NOTE_COMPACT_STATS.last` 记 regen 明细）——小缺口，不阻塞。
- 附：重生成用 `count: snap.count`（快照句数），若本次有 sha 跳过，指针里的 N 可能略大于实际删除数（仅语义信息，不影响正确性）。

### Q3 · D7 墓碑判据是否覆盖真机形态 / 对账是否一致
- **真实结构**（`memory-store.mjs#1431`）：`{sha, topicId, sentenceId, at, actor, text}`；真库 94 条全部含 sentenceId/topicId/sha，且 sentenceId 都能在 `sentences` 找到；`deleted.sha:*` 94 条 1:1（迁移未读，冗余但无碍）。
- **覆盖**：现代条目 `tombIds`（sentenceId）全覆盖；旧式 `tombLegacy`（topicId→sha）为历史兜底（真机未出现）；**残余低风险**：legacy 条目若缺 topicId（键 `""`）会漏匹配，若历史只写 `deleted.sha:*` 未写 index 会漏（真机无此形态）。
- **对账一致性**：`before/deletes` 均按 **live** 行算（`#140/#149`），墓碑数单独展示 `(墓碑已过滤 N)`（`#177`），`合计：删除旧句` 只累加 live 删除（`#190`）⇒ 不会把墓碑算进「删 N 句」。实测副本 T-0559（中间墓碑）：`句 2 → 1（删 1）（墓碑已过滤 1）`，合计删 10 = 原 11−1 ✓。

### Q4 · D8 宿主检测是否可靠 / --force 警示 / busy≠0 是否真没写库
- **宿主检测**：Windows `tasklist /FO CSV /NH` + 正则 `/deepseek\s*harness|^dsh(\.exe)?$/i`（`#270-275`）；本机实测抓到 8 个 `DeepSeek Harness.exe` → exit 2。误判面：凡名字含「deepseek harness」的进程都算（保守，DSH 相关进程都该算）；漏判面：宿主若以 `electron.exe` 等无关名字运行会漏（当前真机名字匹配）。
- **--force**：显式参数 + `console.warn`（`#302`）+ help 说明（`#78`）——警示足够；建议未来加「二次确认/环境变量」但非必须。
- **busy≠0 是否真没写库**：**是**。顺序为 assertNoHost → checkpoint → backup → apply（`#344-360`）；exit 2 时无备份、无迁移；实测 exit 3（有活动写连接）时 `bak=0`、副本 mtime 不变。**但**checkpoint 跑在 readOnly 快照连接上（`#332/#354`），readOnly 无法真正 checkpoint/truncate；有活动写连接时抛 `disk I/O error` 而非 `busy=1`（exit 3 结论仍安全）；「宿主崩溃遗留 WAL」会被误挡。建议改到写连接（applyPlan 事务前）或备份后跳过。

### Q5 · D10 是否有副作用（列出所有传 rows 调用点）
**无正确性副作用；唯一残余是「自定义 backend 无 getTopicById 时回落陈旧 rows」——方向安全（校验失败、不误删）。** 调用点清单：

| 调用点 | rows 来源 | 安全性 |
|---|---|---|
| `noteUnrefinedStats(store, rows)` `#4305`（任务书） | `_allRows`（同函数开头 `#4206` 取） | 安全：同调用内新鲜；内容仍 `readTopic` 重读 |
| `noteUnrefinedStats(store, topics)` `#9278`（stats 快照） | `topics`（同函数开头取） | 安全（同上） |
| `noteUnrefinedStats(store, rows)` `#12123`（memory_topics） | `rows`（同函数开头取） | 安全（同上） |
| `noteTakeSnapshot(store, null, rows)` `#3905` | `noteTakeDreamSnapshots` 内 `#3896` 刚取 | 安全：rows 仅枚举笔记主题，句内容 `readTopic` 重读 |
| `noteCompactValidate({rows})` `#4077`（来自 `noteTopicCompact`） | settle `#19999` 传 **spawn 时 `_noteRows`**（分钟级陈旧）；replay `#4182` 传当前 rows | **安全**：`freshRow#4008-4013` 优先 `be.getTopicById(tid)` 取**当前** writeCount/state/createdAt（sqlite/ledger 均实现）；rows 仅兜底。若自定义 backend 无该方法 ⇒ 回落陈旧 rows → writeCount 不增长 → 校验失败（安全方向，功能降级） |
| `listOverLimitTopicsFromDb(store,{rows})` `#4207` | `_allRows`（同函数） | 安全：rows 仅枚举，字符数走 `store.readTopic`（`#3626`） |
| `applyDreamPatchesToDb(valid,{rows:_dbRowsCache})` `#13284` | `#13151` 同一次 tool 调用取的缓存 | 安全：用于守卫预扫 `#13160` + file 映射；patch 不建/不改主题名 ⇒ 映射稳定 |
| `dbPatchGuardTopic(p, rows, srcMap, nz)` `#13160` | 同上 | 安全 |

**残留（非本轮回归）**：settle 的 `resolveTopicRefByStore(TOPICDB.store, _it.topic)` `#19994` **未传 rows**，每个收敛项仍一次 `store.topics()`（实测 684ms/项）；D10 未覆盖此点，建议后续补。

### Q6 · 结论
**还要改 1 处：D8 的 checkpoint 落点（readOnly → 写连接，或备份后跳过 checkpoint）**。其余 4 处通过；D2 的 targets 留痕建议补（不阻塞）。

## 6.3 验证记录（本轮可复现）

| 项 | 方式 | 结果 |
|---|---|---|
| 指纹 | `Get-FileHash index.js` | sha256 `1AE39270…0D45`，1,512,718B，21,245 行 ✓；`node --check` exit 0 |
| 自测 | 5 个门 | `_note-compact` **81/81**、`_p0-impl` 71/71、`_dream-cand` 12/12、`_p25-write-guard` 47/0（2 skip）、`_memory-note` 34/34 |
| 迁移 dry-run（真库只读） | `node tools/migrate-note-compact.mjs` | 12 主题 → 待迁 7 / 跳过 5 / 删 11 句（与上一轮一致） |
| D7 造数（临时副本） | 副本软删 T-0559 中间句 → dry-run | `句 2 → 1（删 1）（墓碑已过滤 1）`；合计删 10 = 11−1 |
| D8 宿主检测（临时副本） | 宿主运行中 `--apply` | **exit 2**，拒绝写库（无备份/无迁移） |
| D8 --force（临时副本） | `--apply --force` | checkpoint `busy=0,log=0,checkpointed=0` → 备份 vacuum-into → 迁移 7 → 复核 0（幂等） |
| D8 exit 3（临时副本 + 活动写连接） | `--apply --force` | **exit 3**（`WAL checkpoint 执行失败：disk I/O error`），`bak=0`、mtime 不变 ⇒ 未写库 |
| WAL 行为 | readOnly 连接 `PRAGMA wal_checkpoint(TRUNCATE)` | 无 WAL 帧时 `busy=0`；有活动写连接时抛 I/O error（readOnly 不能 checkpoint） |

## 6.4 诚实缺口（本轮）

1. 未在「真库 + 宿主已退出」场景实跑 `--apply`（真库未写；只在 VACUUM INTO 副本上演练；D8 的 readOnly checkpoint 在真库 WAL 场景未实测——推断与副本一致）。
2. 未验证 DSH 宿主**崩溃遗留 WAL** 的真实形态（推断 readOnly checkpoint 会失败 → exit 3）；未验证 DSH 正常退出后 WAL 是否必被清空（副本无 WAL；真实进程行为未测）。
3. 未验证 `--force` 在真库上并发写的实际后果（只在副本上测 exit 3；真库 `--force` 不建议）。
4. D2 的 targets 留痕缺口仅静态判断（未看 monitor 落盘实际内容）。
5. D10 性能数字沿用实现方自报；我仅复跑门与静态核对调用点，未复测 138→0.1ms 等具体值（真机 684ms/次是上一轮副本实测）。
6. 未跑全部历史回归门（只跑实现方列出的 5 个 + 本轮的迁移演练）。

---

*第 4 轮定点复核只读，未修改代码与方案。*
