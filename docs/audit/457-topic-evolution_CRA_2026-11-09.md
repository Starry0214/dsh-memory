# CRA · v4.5.7 主题演进能力（rename / 卫生节奏 / 体检指标）设计评审

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`；方案 `docs\方案-4.5.7-主题演进.md`（状态：方案稿）。
- 只读：未改代码、未构建、未部署、未写数据库。按 CRA：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最终 diff + 三个未决的答案）。

---

## 0. 结论（先给判断）

**修了再开工**。rename 本身可做，但方案里有 4 个必须先修的硬点；指标/卫生节可一并做，但要限成本。

1. **rename 必须独立工具 `memory_rename_topic`，不要塞进 `memory_dream_patch`**：
   - 结构操作需要独立授权/限次/审计；塞进 patch 会让 patch 的“内容写入 + 回滚”语义和结构操作混在一起。
   - 工具必须加入 dream 专用 `tools/pre-execute` 闸（当前只放行 `memory_split_topic`/`memory_review_topic`，见 `index.js#17993-18004`），否则主会话也能调。
   - 建议 store 权限位只给 runtime/lead/user；dream **不直接调 store**，由工具用 runtime 执行，避免 `PERMISSIONS.dream.rename=true` 打开一条直调路径。
2. **`norm` 必须真正更新**：`backend-sqlite.mjs#129-136` 的 `updateTopic` SQL **不写 norm**；直接 `updateTopic({name})` 会留下旧 norm。必须走 `tree-apply.mjs#252-265` 同款直接 SQL（或修 backend），否则新名 exact 不中、旧名 exact 仍中、冲突检测失效。**这是 P0**。
3. **`createTopic` 不查 aliases**：`resolveTopic` 查 alias（`memory-store.mjs#858-860`）、`seedTopic` 查 alias（`#1066`）、导入查 alias（`import.mjs#731-735`），但 `createTopic` 的“已存在”只查 norm（`#928` 附近）。rename 把旧名放进 aliases 后，**旧名仍可能被 createTopic 重新建一个新主题** ⇒ 重复。必须补 alias 命中。**这是 P0**。
4. **系统主题禁止 rename**：笔记 `笔记·*`、P2.5 会话检查点 `<wsKey>/<sid8>`、`会话检查点·*` 线、`日记忆（按天流水）`、索引类主题（`INDEX_TOPIC_NAME_RE`）都不能改；否则 `memory_note`/`p25WriteSessionTopic`/笔记归档/结构注入按名字精确查找会断。方案没写，必须补。
5. **aliases 上限 10，FIFO 淘汰最旧**（不是最短）：当前无上限（实测 592 主题 / 1306 个别名 / 单主题最大 15，`T-0263`）；alias 参与 `resolveTopic`、`topicDbSearchTopics` 的 head、`memory_topics like`、导入 key；无上限会污染检索并造成 alias 歧义。当前最大 15，不必全库批量裁剪；在新 rename/addAlias/merge 写入时收敛到 10，淘汰记审计，历史旧名仍在 `topic.rename` 审计里。
6. **导出不是“逐主题 projects|knowledge|sessions|tools 重建”**：当前自动导出是 `store.exportMd()` **全量快照**写 `_export/<日期>/memory-export-*.md`（`index.js#8349-8389`、`memory-store.mjs#2404-2416`）；实测 587 主题 / 4.85MB / **2.3-3.3s**，没有单主题重建入口，也不写 `projects/...` 等旧视图。rename 成功后**异步调度一次导出**（`topicDbScheduleAutoExport("rename")`，30min 节流），不要同步阻塞 dream；若要求立即可见，最多 force 一次异步，别在 rename 调用栈里 await。
7. **体检指标**：`stats.json` 当前已 7.2s / 458KB（实测 `:58757`），不能再给每次请求加 O(N²)。五个指标里 4 个可从 `store.topics()` 同一份 rows 一次算完（`topicDbStatsSnapshot()` 已取 rows，`index.js#9545`）；`nearDupPairs` 用 trigger 倒排候选 + 名字包含/少量 Levenshtein，缓存 5 分钟，不扫全量 N²。`oversized` 必须排除索引类（`INDEX_TOPIC_NAME_RE`，`#2821/#3890`；T-0474/0475 上限 200K）。
8. **现有 592 主题不做批量 rename/批量 alias 裁剪**：只让 dream 卫生节按候选逐个处理，每轮最多 3 个；指标先只读观测。当前 592（active 214 / dormant 308 / draft 44 / archived 26）作为基线。

---

## 1. 表 1 · 调用链

| 环节 | 位置 | 说明 |
|---|---|---|
| `resolveTopic` | `memory-store.mjs#842-891` | id → norm exact (`getTopicByNorm`) → aliases 全表扫描 (`#858-860`) → Levenshtein/contains fuzzy (`#865-875`)；rename 后旧名靠 aliases 仍可解析 |
| `createTopic` | `memory-store.mjs#896-...` | 只查 `getTopicByNorm(norm)`（`#928` 附近）；**不查 aliases** ⇒ P0 |
| `seedTopic` | `memory-store.mjs#1030-1136` | exact norm (`#1058`) + alias (`#1066`)；导入/笔记建主题走这条路，安全 |
| 导入期 key | `import.mjs#731-736` | exact norm + aliases 都查；rename 后导入不会把旧名当全新 |
| `topicDbSearchTopics` | `index.js#8119` 起 | head = name + aliases + triggers（`#8127` 附近），每次实时读；无 norm 缓存；旧名 alias 仍命中 |
| `addAlias` | `memory-store.mjs#1141-1149` | 只按 norm 去重；**无上限** |
| `mergeTopics` | `memory-store.mjs#1729-1789` | 源 name + aliases 并入目标 aliases（`#1758-1763`），按 norm 去重；源 archived + `merge_into:<dst>`；**目标 aliases 无上限** |
| `splitTopic` | `memory-store.mjs#1816-1882` | 新主题名可指定；`_freeTopicName` 只查 norm（`#1793-1806`），不查 alias ⇒ 可能与别人的 alias 撞名 |
| `renameTopicRaw`（现有私有） | `tree-apply.mjs#252-265` | 已是“直接 SQL 改 name+norm；ledger 走 updateTopic”的底层实现；有 `topic.rename` 审计和 `renamed.from` meta；**没有 aliases/冲突/export** |
| backend norm 写入 | `backend-sqlite.mjs#129-136` | `updateTopic` SQL **不含 norm**；`backend-ledger.mjs#51` 会在 patch.norm 时同步 normIndex |
| 导出 | `index.js#8349-8389` | `store.exportMd()` 全量快照 → `_export/日期/memory-export-*.md`；无单主题入口；`exportMd` 在 `memory-store.mjs#2404-2416` |
| stats | `index.js#9473-9583` | `topicDbStatsSnapshot()` 已取 `store.topics()`（`#9545`）；现有 7.2s/458KB；指标应复用这份 rows |
| 系统主题 | `index.js#8614-8618` | `isSystemTopic` = `isNoteTopicName` 或 `p25Topics.isSessionTopicName`；P2.5 线前缀 `p25-topics.js#47`、D8 域 `#53`、`isSessionTopicName` `#234` |
| 索引主题 | `index.js#2821` | `INDEX_TOPIC_NAME_RE = /(?:精确)?字面量索引|记忆索引/`；过限判定 `#3871/#3890` 已排除索引 |
| dream 结构闸 | `index.js#17993-18004` | 只放 `memory_split_topic`/`memory_review_topic`；rename 必须加入 |
| dream 提示 | `index.js#4586-4607` | Write Path 工具面 `#4601`；卫生节应加在这里 |
| 权限 | `governance.mjs#244-249` | dream `merge/split/delete/setState:false`；新 rename 位需设计 |
| 合并/拆分与 rename 交互 | `mergeTopics#1758`、`splitTopic#1854-1856` | 名字/aliases 已处理；split 新名不查 aliases（需补） |

---

## 2. 表 2 · 状态与数据

| 项 | 实测/规则 |
|---|---|
| 主题总数 | 592（active 214 / dormant 308 / draft 44 / archived 26） |
| aliases | 1306 个总计；单主题最大 15（T-0263）；当前无上限 |
| 已知重复 trigger | `memory_dream_patch` 同时挂 T-0029/T-0031/T-0057/T-0347 |
| rename 状态 | 无 public API；`tree-apply.renameTopicRaw` 是现成底层；无 aliases/冲突/export |
| norm 缓存 | sqlite 每次查询；ledger `normIndex` 仅 `updateTopic` patch norm 时同步；无别的进程内 norm 缓存 |
| 权限 | dream 无 merge/split/delete/setState；rename 需要新位/工具闸 |
| 导出 | 全量 4.85MB 快照，2.3-3.3s；`_export`；无单主题重建 |
| stats | 7.2s / 458KB；指标不适合每次全算，尤其 nearDup |
| 系统主题 | 笔记/P2.5 会话检查点/线/域/索引；rename 必须拒绝 |
| 现有 592 | 不做批量改名；指标只读 |

---

## 3. 表 3 · 边界

| 边界 | 行为/风险 | 处置 |
|---|---|---|
| 改名为当前名 | 无操作/幂等 | 返回 unchanged，不写审计/alias |
| 新名 norm 与别的主题相同 | 拒绝 `NAME_CONFLICT`，提示 merge | `getTopicByNorm` + 对方 aliases 检查 |
| 新名是别的主题的 alias | 当前方案只查 norm ⇒ 会放行，造成 alias shadow/歧义 | 必须把“别人的 alias norm”也当冲突（或明确拒绝并提示 merge） |
| 旧名是其他主题的 alias | 把旧名加入 aliases 会产生双重 alias ⇒ `resolveTopic` 抛 AMBIGUOUS | 加 alias 前查重；冲突则只审计不写 alias |
| 新名是系统名 | 笔记/P2.5/线/域/索引会被破坏 | `SYSTEM_TOPIC_READONLY` 拒绝；store + tool 双保险 |
| archived 主题 rename | archived 是终点/只读；改名会破坏归档语义 | 拒绝 `ARCHIVED_READONLY`（lead/user 也先恢复再改） |
| rename→merge | `mergeTopics` 把源当前名+aliases 并入目标 aliases，已正确 | 加 alias cap，不改变语义 |
| merge→rename | 目标改名后源名仍在 aliases，旧检索命中 | 同 alias cap |
| split→rename | 新主题可独立改名；split 指针记 id，不受影响 | 无需改 |
| rename 撞名 | 同名本质应 merge；拒绝并提示 | `NAME_CONFLICT` + candidate |
| 导出 | 全量快照旧名；同步重建会阻塞 2-3s | 异步调度，不 await；不写旧逐目录 md |
| 并发/回滚 | rename 与 merge/split/写同时发生 | 单事务；`runInTransaction`；失败不改 name/aliases/norm |
| trigger | rename 不动 trigger（保留召回） | 计划正确；改 trigger 走 add/retireTrigger |
| 状态 | rename 不改 state/id/parent/trigger | 只改 name/norm/aliases/updatedAt |

---

## 4. 必审 8 项

### 4.1 norm 与去重

- 正确链路：`resolveTopic` 先 exact norm（`#855-856`），再 aliases（`#858-860`），再 fuzzy；`seedTopic`/import 也查 alias。**没有 norm 的进程内缓存**；sqlite `getTopicByNorm` 每次查（`backend-sqlite.mjs#115`），ledger 只维护 `normIndex`（`backend-ledger.mjs#51`）。
- 错误链路：`backend-sqlite.updateTopic` 不写 norm（`#129-136`）；如果 rename 用 `updateTopic({name, norm})`，sqlite 行会保留旧 norm，导致：
  - 新名 exact 不中（仍走 alias/fuzzy）；
  - 旧名 exact 仍命中（norm 未变）；
  - 冲突检测基于 norm，可能漏/误判；
  - ledger 与 sqlite 行为分叉。
- 必须：`renameTopic` 走 `renameTopicRaw` 同款直接 SQL（`tree-apply.mjs#252-265`），或修 backend `updateTopic` 持久化 norm；并在同一事务里更新 aliases。
- `createTopic` 只查 exact norm，不查 aliases ⇒ 旧名可被重新建主题（P0，见 §0.3）；`gradeCreate` 的 `existing` 列表也只看 `norm/triggers`（`memory-store.mjs#932-935`），不包含 alias；建议把 alias 也加入 existing 或至少在 createTopic 入口做 alias 命中。
- `topicDbSearchTopics` 用 `name+aliases+triggers` 实时拼 head（`index.js#8127` 附近），不缓存 norm；rename 后旧名仍在 aliases 即保留召回，新名实时生效。
- `splitTopic._freeTopicName` 只查 norm（`#1793-1806`），不查 alias；建议同修，避免新主题名等于已有 alias。

### 4.2 aliases 膨胀

- 当前无上限：`addAlias`（`#1141-1149`）直接 push；`mergeTopics`（`#1758-1763`）把源 name+aliases 全并入；实测单主题最大 15。
- aliases 参与：`resolveTopic`（`#858-860`）、`topicDbSearchTopics` 的 head（`#8127`）、`memory_topics like`（`index.js#12427` 附近）、导入 `topicKeyFor`（`import.mjs#731-735`）。过多会污染检索、增加 alias 歧义（`resolveTopic` 多命中抛 AMBIGUOUS）。
- **推荐上限 10**，淘汰**最旧（FIFO）**：新增/合并/rename 后按插入顺序保留最近 10 个；淘汰时写 `topic.alias.evicted` 审计（alias/evictedAt/reason），不删 `topic.rename` 历史；当前最大 15 的 T-0263 只在下次 alias 写入时收敛，不做全库批量裁剪。
- 不建议按“最短”淘汰：短 alias 往往是核心旧名（可能正是用户要召回的词），且短名更易被泛化匹配；FIFO 更可解释。若担心短泛词污染，可另加“长度 <2 的 alias 不参与 search head”的过滤，而不是按长度淘汰。

### 4.3 导出视图重建

- 现状不是按 `projects|knowledge|sessions|tools/*.md` 逐主题重建；`topicDbAutoExport` 调 `store.exportMd()` 全量快照写 `_export/<日期>/memory-export-*.md`（`index.js#8374-8389`），`exportMd` 在 `memory-store.mjs#2404-2416`。没有单主题重建入口。
- 实测最近导出：587 主题 / 33,490 句 / 4.85MB md / 2.3-3.3s（`_export/.manifest.json`）。在 rename 调用栈里同步重建会拖慢 dream。
- 推荐：rename 成功后 **异步调度** `topicDbScheduleAutoExport("rename")`（30min 节流，`#8450-8465`）；不 await、不阻塞；若产品要求“马上看到”，最多在 `setTimeout` 里 force 一次，仍不阻塞 rename 返回。旧 `projects/...` 视图若仍在用，不在本自动导出管线内，需另开任务；不要假设 rename 会重写它们。

### 4.4 权限放开给 dream

- `PERMISSIONS.dream` 当前 `merge/split/delete/setState:false`（`governance.mjs#248`）；rename 是可逆的，确实比 merge/delete 风险低，但**不建议给 dream 直调 store 的 rename 位**：工具由插件以 runtime 执行，dream 只拿工具入口；store 权限只给 runtime/lead/user，减少“dream 直接调用内部 API”的路径。
- 独立工具必须加入 `tools/pre-execute` 的 dream 闸（`index.js#17993-18004`），否则主会话/归档子代理能调；并更新 Write Path 提示（`#4601`）。
- 防“绕过 merge”：rename 只改 name/norm/aliases，不移动句子、不改 state/parent/trigger，无法完成 merge 的内容归并；真正的绕过风险是“改成相似名制造近重复”，由 exact/alias 冲突检测 + 每轮最多 3 次 + `nearDupPairs` 指标 + monitor 控制；不要自动 rename。
- 建议 **每轮 dream 最多 3 次 rename**（与卫生节“每次最多处理 3 个”一致）；可复用 dream 写入账本计数，超限返回 `RENAME_RATE_LIMITED`，避免刷名。

### 4.5 体检指标性能

- `topicDbStatsSnapshot()` 已 `store.topics()` 一份 rows（`#9545`）；592 主题一次遍历；`dupTriggers`/`fragments`/`oversized` 可复用，`orphans` 复用 `topicDbHierarchy` 的 `unmapped`（`#8622`），都 cheap。
- `nearDupPairs` 不要 O(N²) 全量 Levenshtein；用 trigger 倒排 + 名字包含候选；592² 约 35 万对，Levenshtein 全算会明显；建议候选 <2000 对，缓存 5 分钟。
- `stats.json` 当前 7.2s/458KB（实测 `:58757`），不能再每次加全量 nearDup；建议指标对象缓存在 stats snapshot（TTL 5min）或仅 `memory_topics`/面板按需；写库/rename 后失效缓存。
- `oversized`：active 非索引，`t.chars > 40000`；排除 `INDEX_TOPIC_NAME_RE`（T-0474/0475 索引类 200K，`#2821`/`#3890`）；否则指标永远 2 个假阳性。
- `fragments`：active、非系统/索引、`t.sentences <3`（live/effective 口径，`store.topics()` 已是 effective）。
- `orphans`：直接用 `hier.unmapped`（parent=null 且非系统），不要重新定义。

### 4.6 nearDupPairs 算法

推荐（不用全量 Levenshtein）：
1. 取 active、非 archived/merged、非系统/索引；`norm = normalizeName(name)`；`trigs = activeTriggers`（排除 generic）。
2. trigger 倒排：`normTrigger -> Set(topicId)`；统计 shared≥2 的 topic 对（生成候选）；`shared>=2` 是主判据。
3. 对候选对做名字关系：`a.norm === b.norm`（理论上不应存在，冲突检测应拦）或 (`min(len)>=4 && (a.norm.includes(b.norm) || b.norm.includes(a.norm)))` 或 Levenshtein≤2（只对候选对，不扫全量）。
4. 入选：`shared>=2 && nameRelated`，或 `shared>=3`（名字完全不像但 3 个共同 trigger，仍值得看）；排除“项目”vs“项目管理”：`min norm length >=4` 使“项目”(2) 不因包含入选；若 trigger 共同 ≥2，仍可能入选，但配合 `shared>=2` 与 top 列表由 dream 判断，只计数量不自动动作。
5. 输出 top 20（id/name/sharedTriggers/score），`nearDupPairs` 为符合条件总数；缓存 5min；排除 alias? 可考虑 name 的 aliases 也参与 `nameRelated`（但会放大），先用主名 norm 控制误报。
- 不要用“归一化名包含”单独判：中文短名（项目/计划/系统）误报高；trigger overlap 是更强信号。

### 4.7 与 4.5.6 笔记归档的交互

- **禁止 rename**：
  - 笔记主题：`^笔记·`（`isNoteTopicName`，`index.js#8616`；当前 4.5.6 已落地 `archiveStaleNoteTopics`，按该前缀扫描，`#9270-9310`；改名会让归档扫不到/`memory_note` exact name 找不到）。
  - P2.5 会话检查点：`p25Topics.isSessionTopicName(name)`（`p25-topics.js#234`；`<wsKey>/<sid8>`），`p25WriteSessionTopic`/读侧按名字/线查找，改名会断。
  - 结构性名字：`p25Topics.LINE_PREFIX`（`会话检查点·`，`#47`）、`D8_DOMAIN_NAME`（`日记忆（按天流水）`，`#53`）、`会话检查点（已归档 ...）`；以及 `INDEX_TOPIC_NAME_RE`（`#2821`，索引 T-0474/0475）。
  - archived 状态：拒绝（归档是终点/只读）。
- 判据：rename 入口先做 `isProtectedTopicName(name)`：`isNoteTopicName`、`p25Topics.isSessionTopicName`、`startsWith(LINE_PREFIX)`、`=== D8_DOMAIN_NAME`、`INDEX_TOPIC_NAME_RE`、`/^会话检查点/`；命中返回 `SYSTEM_TOPIC_READONLY`，不改 name/aliases。
- store 层可加同样 regex 兜底（不依赖 index 的 helper），tool 层再按上面完整判据；双保险。

### 4.8 影响面

- **注入切片**：`topicDbRegistrySlice`（`index.js#8171`）按 `name` 输出 ID+名字+triggers；rename 后下轮注入显示新名，旧名只在 aliases/搜索；alias 不直接进 registry（仅 name/triggers）。
- **dream 候选**：候选按 `updatedAt` 排序、名字展示；rename 更新 `updatedAt` 会让目标升到候选前部（合理）；note/checkpoint 系统主题已排除（`#4490/#4506/#4534`）。
- **面板计数**：name/aliases 变化不影响主题数；metrics 新增五指标；`nearDupPairs` 帮助观察 rename 是否制造近重复。
- **memory_search**：`topicDbSearchTopics` head 含 aliases，旧名仍命中；新名 exact 命中（前提 norm 正确）；`topicDbContentSearch` 按正文，不受名影响。
- **现有 592**：不做批量；rename 只走 dream 卫生节候选/用户显式；alias cap 只在写入时收敛；当前最大 15 的 T-0263 等不改存量（除非下次 alias 写入）。
- **schema/governance**：仅 permissions 代码位；无 schema 变更；不改三层结构/lifecycle/ARCHIVABLE_STATES。

---

## 5. 特别回答

### 5.1 独立工具还是 `memory_dream_patch` action？

**独立 `memory_rename_topic`**。理由：
- rename 是结构操作（name/norm/aliases/export），与 patch 的“内容句子编辑”不同；独立工具可单独做 dream 闸、限次、冲突错误码、审计和导出调度。
- `memory_dream_patch` 已经有 patch 批量/回滚/内容语义，塞 action 会让“写入内容”和“改结构”共用一条事务/回滚路径，容易半成功。
- 仍然只增加**一个窄入口**（dream-only），不会回到 4.5.1 前的“多写入入口”；store 只给 runtime/lead/user `rename` 位，dream 通过工具（runtime 执行）。
- 必须把 `memory_rename_topic` 加入 `tools/pre-execute` dream 闸（`index.js#17993-18004`）和 Write Path 提示（`#4601`），否则全局注册会被主会话看到。

### 5.2 aliases 上限与淘汰

- **上限 10**；新增 alias/rename 把旧名 append 后若 >10，按**插入顺序淘汰最旧**（FIFO），每次淘汰写 `topic.alias.evicted` 审计（alias、evictedAt、reason）。
- 不按最短淘汰：短名往往是核心旧称；FIFO 可解释、可回溯。历史改名保留在 `topic.rename` 审计，不靠 aliases 永久保存。
- 现有 T-0263 有 15 个别名：不做全库批量裁剪；下次该主题 addAlias/merge/rename 时收敛到 10；若产品要求立即合规，可单独 dry-run 后人工确认，不要默认批量。

### 5.3 最小 diff

1. `memtopic/src/backend-sqlite.mjs#129-136`：`updateTopic` 若 patch 含 norm 则写入 norm（或至少提供 `updateTopicName`）；避免 sqlite/ledger 分叉。~3-6 行。
2. `memtopic/src/memory-store.mjs`：
   - 新增 `renameTopic(topicRef,newName,{actor,reason})`：权限 `can(rename)`；系统名/archived 拒绝；新名 norm/alias 冲突（含其他主题 aliases）；旧名进 aliases；直接 SQL 改 name+norm（复用 `tree-apply.renameTopicRaw` 逻辑）；`topic.rename` 审计 + `renamed.from`；`runInTransaction`；返回 from/to/aliases/evicted；不改 id/trigger/parent/state。~60-90 行。
   - `createTopic` 加 alias 命中（`#928` 附近）；`_freeTopicName`/split 名字查 alias；`addAlias`/`mergeTopics` 用 alias cap helper。~15-25 行。
3. `memtopic/src/governance.mjs#244-249`：新增 `rename` 位；runtime/lead/user true，dream false（工具走 runtime；若产品坚持 dream true，也不要让它直调 store）。~5 行。
4. `index.js`：
   - 新增 `memory_rename_topic` 工具（dream-only 入口、参数 topic/new_name/reason、限次 3/轮、返回冲突码/别名/导出调度）；注册到 tools；~60 行。
   - `tools/pre-execute` dream 闸加入 `memory_rename_topic`（`#17993-17997`）；~2 行。
   - dream Write Path 提示加入 `memory_rename_topic`（`#4601`）；卫生节（候选后）加入近重复/过时名/碎片/超限、每轮最多 3 个、必须报告；~15-25 行。
   - rename 成功后 `topicDbScheduleAutoExport("rename")`（异步，不 await）；~2 行。
   - `topicDbStatsSnapshot()` 加 `health` 对象（dupTriggers/fragments/orphans/nearDupPairs/oversized + top 列表，TTL 5min 缓存）；面板 HTML 加一行；`memory_topics` 尾部加一行。~60-100 行。
5. 测试：`_memory-note` 不需动；新增 `_topic-rename-selftest`（norm/alias/冲突/系统名/archived/alias cap/merge-split 交互）；metrics 纯函数测试；现有 592 不动。**不改 schema、不改 lifecycle、不改 client bundle**。

---

## 6. G-9.2 反面问题（≥3）

1. **norm 未更新**：用 `updateTopic({name})` 走 sqlite，旧 norm 保留 ⇒ 新名 exact 不中、旧名 exact 仍中、冲突检测失真；ledger/sqlite 行为分叉；后续 merge/rename 可能认错主题。修复：直接 SQL/修 backend。
2. **旧名可被重新创建**：`createTopic` 只查 norm，不查 aliases；rename 后旧名在 aliases，`createTopic(oldName)` 会新建第二个主题 ⇒ 重复/歧义。修复：createTopic alias 命中 + grade existing 包含 aliases。
3. **aliases 污染/歧义**：无上限；反复 rename/merge 后 aliases 膨胀，`resolveTopic` 多命中抛 AMBIGUOUS，`topicDbSearchTopics` head 污染，检索排序变差。修复：cap 10 + FIFO + 审计。
4. **系统主题被改坏**：rename 笔记主题 ⇒ 4.5.6 归档扫描按 `笔记·` 前缀找不到、`memory_note` exact 名失效；rename P2.5 会话题 ⇒ 写/读/归档按 `<wsKey>/<sid8>` 查找断。修复：系统名/archived 拒绝。
5. **导出不更新/阻塞**：rename 不调度导出 ⇒ `_export` 快照仍旧名；同步全量导出 2.3-3.3s 阻塞 dream。修复：异步调度；不要假设旧逐目录 md 会自动变。
6. **dream 绕过 merge/刷名**：rename 只改名字，不能合并内容，但可制造近重复；无工具闸/限次会让主会话也能调或一轮改太多。修复：独立 dream 工具 + 闸 + 3/轮 + monitor + nearDup 指标。
7. **metrics 拖慢 stats**：每请求对 592 主题做 N² nearDup，stats 已 7.2s；修复：复用 rows、倒排候选、TTL 缓存；oversized 排除索引。
8. **trigger 召回被误改**：rename 若顺手改 trigger 会丢召回；计划已明确不动 trigger；实现要禁止 trigger/parent/state 参数。

---

## 7. 验证与缺口

**验证**：
- rename：新名 exact 可解析；旧名 alias 仍可解析；`getTopicByNorm(new)` 正确、旧 norm 不存在；`createTopic(oldName)` 不再新建（返回原主题）；冲突/alias 冲突拒绝；系统名/archived 拒绝；审计 from/to/reason；别名 cap 10 + eviction 审计。
- merge/split 交互：rename→merge 源当前名+旧名进目标 aliases；merge→rename 旧检索仍命中；split→rename 指针 id 不变。
- 导出：rename 后 `_export` 下一快照名字更新；不阻塞调用；旧 `projects/...` 不假设。
- metrics：真机 592 主题产出非空；T-0474/0475 不计入 oversized；nearDup top 列表人工抽查；全 0 显示“良好”；stats 不因 metrics 显著变慢（缓存）。
- dream：构造近重复/过时名样本，卫生节提示 merge/rename；主会话调用 rename 被 `DREAM_ONLY` 拒；一轮 >3 次 rename 被限。

**缺口**：
- 未实现/未跑；`renameTopicRaw` 是现有私有逻辑，最小 diff 需确认是否抽到 memory-store 或复制，避免两套分叉。
- 当前导出只 `_export` 全量；方案中的 `projects|knowledge|sessions|tools` 逐步重建与现状不符，需产品确认是否仍需要旧视图。
- 现有 592/1306 aliases 为真库只读快照；alias cap 的存量处理未做；T-0263 15 个别名保留待下次写入收敛。
- `nearDupPairs` 阈值/误报需用真机 592 主题跑 dry-run 调参；本报告给算法，不给最终阈值。
- dream 每轮 3 次限次的计数落点（dream 会话账本）需与现有 settle 逻辑对齐，未实测。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
