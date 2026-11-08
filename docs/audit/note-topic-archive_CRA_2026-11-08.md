# CRA · 笔记主题归档出口（task-25 / 4.5.5）设计评审

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`；方案背景见 `docs/方案-4.5.4-检查点质量.md#145-157`（task-25 拆出）。
- 只读：未改代码、未构建、未部署、未写数据库。按 CRA：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最终判据 + 最小 diff + 现有 15 个处理方式）。

---

## 0. 结论（先给判断）

**方向对，但必须按“先修禁写 → 再开归档”的顺序，且不要用 dormant 替代 archived。**

1. **A/B 选择：B（自动复活）**，不是 A。
   - `memory_note` 是“默认动作”，用户正在会话里写笔记时被拒绝会直接打断工作流；且当前**没有公开的 archived→active 恢复工具**（`TRANSITIONS.archived=[]`，见 `memtopic/src/lifecycle.mjs#25-30`），A 会把用户卡死在只读。
   - B 只在**实际写入**（新 note）时复活；`memory_read`/`memory_search` 不会复活。归档对“长期不写的会话”仍然生效，不会“每次读都复活”。
   - B 需要新增显式 `reviveTopic`（不能改 `TRANSITIONS` 全局表，否则 archived 不再是终点，影响所有主题）；`memory_note` 先复活再 append，复活失败则按 A 返回可操作错误，**绝不 append 到 archived**。
2. **归档 vs dormant vs 排除候选：选 archived**。
   - `archived` 保留原文/审计（`memory_read` 仍可读），但从注入注册表、dream 候选、笔记提炼块、`memory_search` 默认检索中移除；能真正减少“活跃区”数量。
   - `dormant` 仍会进 `topicDbRegistrySlice`（`index.js#8171` 包含 dormant）和默认 search，只是状态变了；不解决“数量/注入面”，且 dormant 的语义是衰减候选，不是“会话结束”。
   - “只排除 dream 候选/注入”只是视图过滤，主题仍 active，数量与注册表条目不变；可作为补充，不能替代归档。
3. **最终判据**：
   - `state === "active"`（或 dormant，若历史遗留；建议先只 active）；
   - `store.readTopic(id).sentences.length === 1` 且 `isNotePointerText(sentences[0].text)`（**live 口径**，不是 raw 物理行数）；
   - `now - topic.updatedAt >= 30*86400000`（`updatedAt` 是最后一次内容 append/replace/状态变化；`markHit` 不改 updatedAt，搜索/读取不会续期）；
   - 无 `noteCompact` pending；
   - 单次最多 20 条，每日低频，失败不中断，幂等（archived 直接跳过）。
4. **现有 15 个 active 笔记主题：不做一次性归档**。实测 9 个已 pointer-only，但年龄仅 **0.4~1.7 天**，全部 <30 天；现在归档会违反判据、误伤新笔记。让每日 sweep 在满 30 天后自然处理；可先做 dry-run 预览。
5. **重要口径缺口**：`memory_search` 的**主题检索和内容检索都跳过 archived**（`index.js#8116`、`#10482`），所以归档后默认搜不到，只有 `memory_read <id>` / `memory_topics state=archived` 可定位。若产品要求“归档仍可被 memory_search（只排注入）”，需要另加 `includeArchived` 选项；本任务最小改动不建议改默认搜索语义。
6. **最小 diff**：`memory-store` 加 `reviveTopic`（~20 行）；`memory_note` 处理 archived（~15 行）；`noteTopicCompact` 加 archived 拒绝（~5 行）；`index.js` 加 `archiveStaleNoteTopics` 日扫（~40 行）并挂到现有 `p25LifecycleTick`；`memory_write` 加 archived 拒绝（~5 行，可选但建议）；**不动 schema、不动 `ARCHIVABLE_STATES`、不动 client**。

---

## 1. 表 1 · 调用链

| 环节 | 位置 | 说明 |
|---|---|---|
| `memory_note` 工具注册 | `index.js#18934-19015` | 定位 `store`、会话/`cwd`、`sid8`/`wsKey`、主题名 `笔记·<wsKey>/<sid8>`（`#18987`） |
| 查主题 | `index.js#18989` | `store.topics().find(name===...)`；**不区分 state**；archived 也会命中 |
| 新建主题 | `index.js#18991-18999` | 只在 `!t` 时 `seedTopic` + `setState(active)`（`#18998`）；已有 archived 走不到这里 |
| 去重/append | `index.js#19003-19010` | `readTopic` live 去重；`appendSentence({topic:t.id})` `#19010`；**没有 state 检查** |
| `appendSentence` | `memtopic/src/memory-store.mjs#1321-1346` | 只做权限/空文本检查，**没有 `t.state` 检查**；archived 可写（僵尸根因） |
| `setState` | `memory-store.mjs#1518-1539` | 走 `_transition`；active→archived 合法，archived→active 被 `TRANSITIONS.archived=[]` 拒（`lifecycle.mjs#25-30`、`#1451-1469`） |
| `archiveTopic` | `memory-store.mjs#1483-1515` | 先查未归档子节点；`setState('archived')`；`pointer:true` 给父主题追加指针；笔记主题无父节点，指针只写 archive 元数据 |
| `reviveTopic` | 目前**不存在** | 只有 `_restoreState`（`#1993-2002`，绕过 TRANSITIONS，给 undo/merge 用）；B 需要新增公开方法（权限 + 审计 + 只允许 archived→active） |
| note 收敛写入 | `index.js#4300-4318`、`#4370` | `noteTopicCompact` 读 `noteTopicState`，不检查 state；会 append 指针/删旧句到 archived 主题 |
| note 收敛重放 | `noteCompactReplayPending` | 读 pending 后调 `noteTopicCompact`；同样需要 archived 守卫 |
| dream 候选 | `index.js#4490`（`_live` 排除 archived）、`#4496`（notePool）、`#4504`（`_pool` 排除笔记）、`#4534`（note 提炼块排除 archived） | archived 笔记不会进候选/提炼块 |
| 注册表切片 | `index.js#8171` | 只收 active/draft/needs_review/dormant；archived 排除 |
| 统计/面板 | `noteUnrefinedStats` `#4093/#4101` 排除 archived；`selfcheck` `#19540` 用 raw `be.listTopics()` 计数（归档后仍会把 archived 算进“笔记主题 N 个”） | 面板 backlog 会降；自检计数需要改 live/active 口径 |
| `memory_search` | `topicDbSearchTopics` `#8110/#8116` 显式跳过 archived；`topicDbContentSearch` `#10495/#10482` 同样跳过 | **archived 默认搜不到**；`memory_read` `#12418` 仍可按 id/名字读 |
| `memory_write` | `index.js#12491-12556` | dream 专用；只做 `p25SessionTopicWriteGuard`（会话主题），**没有 archived 检查**；可向 archived 主题 append/replace（非 note 也受影响） |
| 生命周期 | `lifecycle.mjs#22` `ARCHIVABLE_STATES=['draft','needs_review','dormant']`；`#142-151 planArchivable` 只看 stateSince；`#158-168 pickOverflowVictim` 只处理 needs_review 队列 | active 笔记永不进 `planArchivable`；需独立 note sweep，不能直接给 `ARCHIVABLE_STATES` 加 active（会误伤普通 active 主题） |
| 现有 15 个 | 真库副本（2026-11-08 12:xx） | 15 个全部 active/archived=0；9 个 pointer-only（live=1 且末句指针），6 个仍有未提炼；年龄 0.4~1.7 天，无 >30 天 |

**结论**：写笔记主题的主要路径是 `memory_note` 和 `noteTopicCompact`；`memory_dream_patch` 明确禁止 note（`#13310/#13350`），但 `memory_write`（dream）没有 note/archived 守卫，属于同漏洞的次级入口。

---

## 2. 表 2 · 状态与现有 15 个

| 项 | 实测/规则 |
|---|---|
| 笔记主题总数 | 15 |
| state | active=15 / archived=0 |
| pointer-only（live=1 且末句指针） | 9：T-0559/T-0561/T-0562/T-0564/T-0569/T-0570/T-0571/T-0575/T-0576 |
| 仍有未提炼 | 6：T-0558 live=6；T-0560 live=33；T-0566 live=2；T-0583 live=2；T-0584 live=7；T-0585 live=4 |
| 年龄 | 0.4~1.7 天（`updatedAt`），全部 <30 天 |
| `ARCHIVABLE_STATES` | `['draft','needs_review','dormant']`，不含 active ⇒ 现有 `planArchivable` 永不会选中笔记 |
| `setState` 合法边 | active→archived 允许；archived→active **不允许**（`TRANSITIONS.archived=[]`） |
| `pickOverflowVictim` | 只对 `needs_review` 队列（`lifecycle.mjs#158-168`）；active 笔记不会因队列封顶被踢 dormant |
| 归档后 updatedAt | `archiveTopic` → `setState` → `_transition` 会更新 `updatedAt` 为归档时刻；因此判据必须在 state=active 时先算，归档后不要再用 updatedAt 判定 |
| 复活后 updatedAt | `reviveTopic` 应走 `_restoreState`/等价路径，重置 `updatedAt/stateSince`，30 天计时重新开始 |
| 归档后注入 | 注册表 `#8171` 排除 archived；dream `#4490/#4534` 排除；note 统计 `#4101` 排除 |
| 归档后 search | topic/content search 都跳过 archived（`#8116/#10482`）；`memory_read` 仍可读 |
| 面板/自检 | `noteUnrefinedStats` 排除 archived；自检 `#19540` raw list 会把 archived 仍算入“笔记主题 N 个”（建议改 active/live 口径） |

现有 15 个中 pointer-only 的 9 个（按真库副本）：T-0559、T-0561、T-0562、T-0564、T-0569、T-0570、T-0571、T-0575、T-0576。**年龄全部 <2 天，今天不该归档。**

---

## 3. 表 3 · 边界

| 边界 | 行为/风险 | 处置 |
|---|---|---|
| ① 归档瞬间主 agent 正在 memory_note 写 | `memory_note` 查主题→append 之间若被 sweep 归档，可能 append 到 archived | B：写前检查 state；`appendSentence` 层建议加显式 `allowArchived:false` 守卫/写后复核；sweep 与 note 写用同一 per-topic 锁或单进程同步段 |
| ② 归档后同会话又写 | A 拒绝（且无公开恢复）；B 复活后写 | **B**：`memory_note` 检测 archived → `reviveTopic` → append；失败返回 `NOTE_TOPIC_ARCHIVED`，不写 |
| ③ 归档后 dream 候选 | `_live` 排除 archived（`#4490`）、note 块排除（`#4534`） | 不会进候选/提炼；可观察 `dream` log 候选数下降 |
| ④ 归档后被 memory_search | topic/content search 都跳过 archived（`#8116/#10482`） | 与“原文永不丢”不冲突（memory_read 可读），但与“归档仍可检索”冲突；若需可检索，另加 `includeArchived` |
| ⑤ 恢复路径 | archived→active 被 TRANSITIONS 禁；无公开工具；仅内部 `_restoreState` | B 提供 `reviveTopic`；A 需要新增恢复工具，故 A 不完整 |
| ⑥ 新会话/无笔记 | 没有笔记主题 | 不显示、不归档；sweep 只扫描 `笔记·` |
| ⑦ 子代理 | `memory_note` 已 `SUBAGENT_SKIP`（`#18942` 附近） | 不会新建子代理笔记；sweep 不受影响 |
| ⑧ 并发/重试 | 两个 session 各自笔记，互不影响；同 topic 的 note compact 有 `NOTE_COMPACT_LOCK`（`#4305`） | note 写与 archive sweep 需 state 复核；archive sweep 单条失败 cwarn 不中断 |
| ⑨ flag 关/库未就绪 | `memory_note` 返回 `topicDbUnavailable`；sweep 由 tick 的 `TOPICDB.enabled/ready` 守卫（`#21261-21274`） | 不归档、不写，静默 |
| ⑩ 归档后 memory_note 重复文本 | 若现有 archived 里已有同文本，去重命中可直接返回 duplicate，不复活 | 不产生写入；是否复活可另定（建议只在实际 append 时复活） |

---

## 4. 必审 8 项

### 4.1 调用链：appendSentence 全仓调用方

当前 `appendSentence` 调用点（`index.js` 当前行号）：
- `#444` 字面量主题：目标筛选 `state !== archived`（`#430`），安全；
- `#4004` conflict-index：按名字找，**没有 state 检查**；archived 时可能写（非 note，但同类漏洞）；
- `#4370` / `#4412` note compact 指针/回滚：**没有 state 检查**（必须补 archived 守卫）；
- `#6839` 子代理摘要：目标筛选 `state !== archived`（`#6820`），安全；
- `#8767` / `#8800` p25 会话主题：可能命中 archived；`setActive` 在写后/建后，但没有前置 archived 拒绝（非 note，但同类）；
- `#8899` 日期主题回落：日期主题可能 archived；没有 state 检查；
- `#12552` `memory_write`（dream）：**没有 archived 检查**，且没有 note 守卫（p25 guard 只拦会话主题）；
- `#13328/#13404/#13416/#13428` `memory_dream_patch`：目标主题由 dream 选；note 已被 `#13310/#13350` 禁止，但 archived 非 note 未统一拦；
- `#14442` p5 写回、`#18896` dream review merge：目标通常是 active，但没有统一 state 检查；
- `#19010` `memory_note`：**没有 state 检查**（主漏洞）；
- `memtopic/src/import.mjs#885` 导入、`memory-store.mjs#1510` archive 指针（父主题）：各有语义，不属于 note 写入口。

**memory_note 之外写笔记主题的**：
1. `noteTopicCompact`（`index.js#4300-4370`）——仅收敛时写指针/删句；
2. `noteCompactReplayPending` ——重放 `noteTopicCompact`；
3. `memory_write`（dream，`#12552`）——没有 note 守卫，理论上可写笔记主题；
4. `memory_dream_patch` 对 note **已禁止**（`#13310/#13350`），不是写入口。
故“archived 禁写”至少覆盖 1/2/3，并建议在 `appendSentence` 层加统一 `allowArchived`（详见 §6）。

### 4.2 状态交互

- `TRANSITIONS`（`lifecycle.mjs#25-30`）：active→archived 合法；archived→active 不合法；`archived` 是终点。
- `setState`（`memory-store.mjs#1518`）拒绝 illegal transition；`archiveTopic`（`#1483`）通过 `setState` 归档并写 pointer 元数据。
- `_restoreState`（`#1993`）是绕过 TRANSITIONS 的特权路径，现有用于 undo/合并；B 的 `reviveTopic` 应基于它并加权限/审计，不能改全局表。
- `pickOverflowVictim` 只对 `needs_review` 队列（`lifecycle.mjs#158-168`）；active 笔记不会因队列封顶被踢 dormant。若 note 因其他路径进 needs_review，才可能被降 dormant；当前 note 建为 active，无此路径。

### 4.3 A vs B（正确性）

- **A 拒绝**：archived 真正只读，state machine 简洁；但 `memory_note` 是默认动作，用户回到旧会话写笔记会被拒；且没有公开恢复工具（只能内部 `_restoreState`/改库），体验/可恢复性差。
- **B 复活**：写即证明该会话仍活跃；`reviveTopic` 审计 + 重置 30 天计时；归档仍对不写的旧会话生效。不会“每次复活”：只在实际 append 时复活，读/搜不复活；若用户持续写，本就不该归档。
- **推荐 B + fail-closed**：复活失败返回 `NOTE_TOPIC_ARCHIVED`（A 式错误），不 append；绝不造僵尸。
- 注意：B 不是“archived 禁写”的例外，而是“先复活再写”；归档态本身仍不可直接 append。

### 4.4 边界

见 §3 ①-⑩。重点：
- 归档瞬间写：加 state 前置检查 + 写后/append 层守卫；单进程 note 写是同步段，仍建议防未来 await/并发。
- 同会话又写：B 复活。
- dream/search：archived 不进候选/注入；默认 search 跳过（如需可检索，另加 flag）。
- 恢复：B 提供；A 没有公开恢复。
- 现有 15：全部 <30 天，不批量处理。

### 4.5 判据正确性

- `正文仅剩 1 句指针`：用 `store.readTopic(id).sentences`（live，已过滤 `deleted.index`，`memory-store.mjs#1278-1315`）；判断 `sentences.length === 1 && isNotePointerText(sentences[0].text)`；**不要用 `be.listSentences()` raw 物理行**（T-0493 的教训：raw 3 / live 1）。
- `>30 天`：
  - 用 `topic.updatedAt`（append/replace/状态变更会更新；`markHit` 只改 `lastHitAt`，不改 updatedAt，见 `memory-store.mjs#1601-1612`）。
  - **不要**用 `stateSince`（active 的 stateSince 是创建/复活时间，不是最后内容更新；`planArchivable` 用 stateSince 是其自身语义，不适合 note 的“最后更新”）。
  - **不要**用 `createdAt`（会把刚建但长期未整理的误判）。
  - 归档后 `updatedAt` 会变成归档时刻，但 sweep 只取 active，不受影响；复活后应把 `updatedAt`/stateSince 重置为 now。
  - 可选：若希望“最近被 memory_read/搜索命中”也续期，可看 `lastHitAt`；但本任务口径是“最后更新”，建议以 updatedAt 为准，`lastHitAt` 只作为可选保护（需明示）。

### 4.6 方案对比（≥2 更小/更稳替代）

- ① **不归档，只排除 dream 候选与注入**：改动最小，但主题仍 active，注册表/数量不变；用户“数量只增不减”未解决；不推荐作为最终方案。
- ② **转 dormant**：`active→dormant` 合法、可自动复活（dormant→active），无需 `reviveTopic`；但 dormant 仍进 `topicDbRegistrySlice`、默认 search，且“笔记已结案”语义不清；不解决注入面/总量，只降低 active 计数；不推荐替代 archived。
- ③ **定期物理删除**：违反“原文永不丢”、审计/历史 sha 全失；禁止。
- ④ **归档 + B 复活（推荐）**：语义正确，保留原文/可读，移出注入/候选/search 默认面；需要新增 `reviveTopic` 和 note sweep。
- ⑤ **只归档 pointer-only 且 >30d，不碰仍有未提炼的**：本推荐判据已内含；不要用“最后一句是指针”代替“live 只有 1 句”（可能有未提炼尾句 + 末尾指针）。
- **推荐 ④**；①可作为附加视图过滤，②只作为极简降级，③禁止。

### 4.7 护栏

- **一次性/幂等**：sweep 只选 active，archived 直接 skip；重复跑不重复归档；`archiveTopic` 自身幂等（`#1492-1494`）。
- **可观测**：`monitorEvent("note","archive ... id age live")`；统计 archived 数；sweep 返回 `{scanned,archived,skipped,details}`；失败 cwarn 不中断。
- **可恢复**：`reviveTopic` 审计（`topic.revive`，from archived to active）；`memory_note` 复活；`memory_read` 始终可读；建议在 `memory_topics state=archived` 可见。
- **不误伤活跃会话**：只归档 pointer-only 且 updatedAt >30d；跳过 pending；不碰有未提炼句；不在 `memory_note` 正在写时归档（state 复核/锁）。
- **不新增高频轮询**：挂在现有 `p25LifecycleTick`（每日一次，`#21261`）后执行；单次 limit 20。
- **不改全局 `ARCHIVABLE_STATES`**：加 active 会让普通 active 主题在 90 天后被归档（灾难）；只做 note 专用 sweep。
- **失败静默**：库关闭/flag off/异常返回 0，不影响 note 写入/主流程。
- **测试**：memory_note archived 复活、note compact archived 拒绝、sweep 判据（live 1 pointer / updatedAt 29 vs 30d / 有未提炼跳过）、幂等、并发 writer。

### 4.8 影响面

- **注入**：active 笔记目前可能进入 `topicDbRegistrySlice`（`#8171` 包含 active/draft/needs_review/dormant；笔记名未被排除）；归档后注册表排除。笔记正文本身不进上下文（`memory_note` 注释 `#18901`），但注册表名会占位；归档可降低注入面。
- **dream 候选**：`_live` 排除 archived（`#4490`）、note 提炼块排除 archived（`#4534`）；归档后不再出现。
- **面板计数**：`noteUnrefinedStats` 排除 archived（`#4101`），backlog 减少；`memory_topics` 的 `归档` 计数增加；`selfcheck` `#19540` raw list 需改为 active/live，否则仍报 15。
- **memory_search**：topic/content 默认跳过 archived（`#8116/#10482`）；`memory_read` 仍可读。若要求“归档可检索只排注入”，需另加 `includeArchived`（非本任务最小 diff）。
- **现有 15**：不批量；9 个 pointer-only 但 <30d；未来 daily sweep 自然处理。若用户强烈要求立刻降数，只能人工逐个确认后归档，不能按“活跃数”批量。
- **状态机/全局**：不改 `TRANSITIONS`；新增 `reviveTopic` 只影响显式调用；不动 schema。

---

## 5. 特别回答

### 5.1 归档 vs dormant vs 排除候选

**归档**最符合“原文永不丢、口径必须正确”：
- 原文/审计保留，`memory_read` 可读；
- 真正从注入注册表、dream 候选、默认 search 中退出，解决数量和注入面；
- dormant 只是“衰减候选”，仍留在注册表/search，语义也不等于“会话结束”；
- 排除候选只是视图过滤，主题仍 active，数量不变。
代价：默认 `memory_search` 不返回 archived（当前实现如此）；若产品要求“可检索”，另加显式 `includeArchived`，默认仍排注入。

### 5.2 现有 15 个要不要一次性处理

**不**。实测 15 个全 active，9 个 pointer-only，但年龄 0.4~1.7 天，全部未满 30 天；现在归档违反判据、误伤新笔记。只让**新 sweep** 在满 30 天后处理；可先 dry-run 出“预计何时可归档”清单。若用户坚持立即降数，必须逐条人工确认，不能按活跃数批量。

### 5.3 最小 diff

1. `memtopic/src/memory-store.mjs`（`_restoreState` 附近 `#1993`）新增 `reviveTopic(topicRef,{actor,reason})`：
   - 权限 `can(ident.actor,'setState')`；只允许 `archived→active`；`_restoreState` 改状态 + 审计 `topic.revive`；返回 `{ok,from,to}`。约 20 行。
2. `index.js` `memory_note`（`#18989` 找到主题后、`#19010` append 前）：
   ```js
   if (t.state === "archived") {
     const rv = store.reviveTopic(t.id, { actor: "runtime", reason: "session-note-write" });
     if (!rv || rv.ok === false) return JSON.stringify({ ok:false, code:"NOTE_TOPIC_ARCHIVED", ... });
     monitorEvent("note", "revive " + t.id + " " + (rv.from || "archived"));
   }
   ```
   约 10-15 行；复活失败即 A 式 fail-closed，不 append。
3. `index.js` `noteTopicCompact`（`#4300-4318`）：读到 `st0` 后若 `st0.state === "archived"` ⇒ `notePendingDel` + 返回 `{ok:false,code:"ARCHIVED"}`；防止收敛指针写 archived。约 5 行。
4. `index.js` 新增 `archiveStaleNoteTopics(store,{now,days=30,limit=20})`（放在 `p25LifecycleSweep` `#9172` 附近）：
   - `store.topics()` 过滤 `^笔记·` + `state==='active'`；
   - `live=readTopic(id).sentences`；`live.length===1 && isNotePointerText(live[0].text)`；
   - `age = now - updatedAt >= 30d`；`!notePendingGet(id)`；
   - `store.archiveTopic(id,{actor:"runtime",reason:"note-stale(>30d)",pointer:true})`；monitor；limit 20；逐条 try/catch。
   约 40 行；挂到现有 `p25LifecycleTick`（`#21261-21279`）p25 sweep 之后，每日一次；无需新定时器。
5. `index.js` `memory_write`（`#12531` append / `#12534` replace 前）：读取目标 state，archived 返回 `ARCHIVED_READONLY`（并建议 note 主题禁止 dream 写，补 `NOTE_TOPIC_DREAM_FORBIDDEN`）；约 5 行。
6. 可选：`selfcheck` `#19540` 的 raw `be.listTopics()` 改为 active/live 统计；`memory_topics` 已支持 `state=archived`。
7. **不动**：`ARCHIVABLE_STATES`、`TRANSITIONS`、schema、client、`appendSentence` 全局签名（若要做统一守卫另开任务/加 `allowArchived`）。

---

## 6. 验证与缺口

**验证**：
- 单测/假 store：`memory_note` 写 archived → `reviveTopic` 调用、状态 active、append 成功；`reviveTopic` 失败 → 返回 `NOTE_TOPIC_ARCHIVED`、无 append。
- `noteTopicCompact` on archived → 返回 `ARCHIVED`、无指针 append、pending 清理。
- sweep 假数据：live=1 pointer + updatedAt=31d → archived；updatedAt=29d → 不动；live=2 pointer-last → 不动；无 pointer → 不动；archived 幂等；limit 20。
- 真机 dry-run：现有 15 个应输出 0 归档（年龄 <30d）；9 个 pointer-only 记录“未来可归档”。
- 归档后：`memory_read <id>` 可读；`memory_search` 默认不返回（如产品要求则另加 includeArchived）；`memory_topics state=archived` 可见；注册表/dream 候选不含。
- 并发：note 写与 sweep 同时，最终无“archived 里新增 live 句”。

**缺口**：
- 未改代码/未跑真机；当前 15 个为真库副本快照，年龄/指针状态以脚本输出为准。
- 未验证 `reviveTopic` 的权限/审计与 `_restoreState` 组合；实现时需确保 `stateSince`/`updatedAt` 重置。
- `memory_search` 是否应默认包含 archived 是产品口径问题；当前代码明确跳过，报告已标注。
- A 的恢复路径、B 的复活 tool 文案、面板显示 archived 是否足够，需产品确认。
- `appendSentence` 全仓统一守卫会影响 p25 会话主题/导入等；本任务只做 note 路径，全局加固建议另开 CRA。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
