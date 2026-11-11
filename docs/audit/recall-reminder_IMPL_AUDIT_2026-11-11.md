# 4.5.15 实现审计（CRA 审计④ · 审实现）

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（HEAD `cea409d` + **未提交**工作区改动；未部署/未 bump）。
- 被审：`index.js`（+446/−52）、`test/_accept-p4.mjs`（+16/−?) 、新增 `test/_test-recall-reminder.mjs`（369 行）、`test/_test-rehydrate-learnings.mjs`（270 行）。
- 依据：`docs/方案-4.5.15-记忆检索提醒与升级协议.md` **§9 + §10**（冲突以此为准）；审计③ `docs/audit/recall-reminder_v3_AUDIT_2026-11-11.md`；§9.8 K-8 门清单。
- 方式：**只读**。未改代码/未部署/未提交；未跑 `_run-suite.mjs`；隔离测试全部在 `os.tmpdir()`；行号口径 `文件:行`（**工作区实测**）。
- 实现者自报**不采信**，全部关键项回代码/复跑验证；自报数字见 §4 逐项对照。

## 0. 结论

**裁决：有条件通过（实现与 §9/§10 实质对齐，可进入发布流程；先修 N-1~N-4，均为低风险可验收项）。**

- §9/§10 的**行为项全部落地**：handler 注册位/三闸/只 append/不重跑 next、R3 归并（先 recall、delta 8 轮、append 成功后才置位、旧 `agent.inject` 注入点已删且无双注入）、recall 文本 176/176 字、flag 四处落点 + 热更新、触发判据（checkpointAt + P1 per-session todo + 共用 rows/30s TTL，热路径 `store.topics()` ≤1 次）、去重键/claim 批语义、RT 不传 ev、工具描述三段式 + 0 结果文案 mode-aware、R2 一次取数/wsKey 收窄/排除本会话/learnings≤900/`R2_TOTAL 6900`/砍序 learnings 第一/`parseRehydrate` 兼容。
- **门**：两新门复跑 **53/0、29/0**（与自报一致）；R2 flag 关 sha16 基线**用 HEAD 旧字节独立复算一致**（非自证）；K-8 9 门 + t5/m9m11/threshold 的 **FAIL 行集合与 HEAD 基线逐行一致（新增 0）**。
- 缺口集中在**发布配套**（面板标签/CHANGELOG/套件登记）与**两个方案明文要求的门未实现**（§9.2 动态抛错、§6-4 只进尾部不改历史），以及 learnings 饱和门的口径偏离（用 `opts.budget=4600` 代真 6900）。详见 §5。

## 1. 逐项核对（实现 vs §9/§10）

### 1.1 handler 注册位与纪律（§9.2 / §8.4）

| 项 | 判定 | 证据 |
|---|---|---|
| 注册位：A 之后、回归之前；A 仍是第 1 个 | ✅ 已实现 | `index.js:18302`（A）、`18586`（recall）、`18676`（回归）；`_rehydrate-gate-selftest` 取首个 handler 的 B8-B10 仍绿（26/26） |
| 函数内三闸（step===1 / 顶层 / decision.kind==="enter"） | ✅ 已实现 | `18596-18601`（另有 `!agent`、`sid` 兜底） |
| 整体 try/catch，catch 返回 decision，**不重跑 next** | ✅ 已实现 | `18588-18593`：`await next()` 只出现 1 次；next 抛错 ⇒ 返回 `{kind:"enter", messages: stepMsgs.slice()}` 兜底（**不**再调 next）；`18665-18669` 整体 catch 返回 `decision`（非 undefined）。规避了审计③ L-2 点名的「A 的 catch 再调 next ⇒ 回归/maint/命令回传双发」 |
| 只 append、不替换/清空 messages | ✅ 已实现 | `18630`、`18649` 均 `{...decision, messages:[..._msgs, makeMessage(...)]}`；入参 `stepMsgs` 只读不写 |
| 消息序（waterfall 内层先）：两条独立 reminder 不合并 | ✅ 已实现 | recall 在 A 内层 ⇒ 尾部顺序 `[…, recall, A]`，与 §8.4/D-3 一致 |

### 1.2 R3 归并（§9.1）

| 项 | 判定 | 证据 |
|---|---|---|
| `turn/start` 只维护 `st.turn`，不再判定/注入 R3 | ✅ 已实现 | `p3OnSessionEvent` `6416-6424`；`shouldNudge` 调用已删 |
| 先判 recall，命中则本轮 R3 让位 | ✅ 已实现 | `18619-18639`（recall 分支）→ `18642-18643`（`R3-won` 留痕） |
| 未命中按 `turn - lastNudgeTurn >= 8`（delta 口径，非取模） | ✅ 已实现 | `18641`；`recallR3Text()` 以 `turn=everyN` 绕过 `buildRecallNudge` 的 `turn%everyN` 硬闸（`18581-18583`，审计③ L-1 注②） |
| **append 成功后才置位** `lastNudgeTurn` | ✅ 已实现 | 先 `decision = {...}`（`18649`），后 `st2.lastNudgeTurn = turn; scheduleMonitorSave()`（`18652-18654`）；异常不置位 ⇒ 下轮重试 |
| 旧 `agent.inject` R3 注入点删除干净、无双注入 | ✅ 已实现 | `session/event` 旧 `_p3res.kind==="nudge"` 块已删（`19245-19250` 注释说明）；全文件 grep 无 `kind === "nudge"`；`buildRecallNudge` 仅剩 recall handler 一处调用（`18582`） |
| 账本字段 | ✅ 已实现 | `st.turn` / `st.lastNudgeTurn` 均在 `p3.sessions[sid]`（`p3SessionState` 6313 结构透传）；`recallNudgedAt` 未写（§9.1 仅观测，见 S-9） |

### 1.3 recall 文本 / flag / 观测（§9.7 / §10.2 / §10.3）

| 项 | 判定 | 证据 |
|---|---|---|
| db/md 两份定稿文本，各 ≤180（含标签） | ✅ 已实现 | `18492`（db）/`18493`（md）；实测 `[...text].length = 176 / 176`（门 H8b/H8c 复跑一致）；与 §10.2 逐字一致 |
| mode-aware（md 不含 `memory_read`/`memory_topics`；db 含 `memory_read`） | ✅ 已实现 | `recallTextOf()` `18495` 以 `TOPICDB.enabled` 分流；H8d/H8e/H8i/H8j 绿 |
| flag 名 `recallPerTurn` / `rebuildLearnings`，四处落点 | ✅ 已实现 | `DEFAULT_CFG 7817/7820`、`SETTINGS_SCHEMA 7888/7890`、`normalizeCfg 7975-7976`、`WRITABLE 13824` |
| 热更新 | ✅ 已实现 | 配置写回后 `PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config))`（`13844`）；两个 flag 在 handler/build 内**每次现读** `PLUGIN_CFG`（`18616`、`16648`） |
| 关闭零字节 / R3 不受影响 | ✅ 已实现 | `18619-18620` flag-off ⇒ 不 append recall；R3 分支照走（门 H6b/H6k 绿） |
| 观测：`monitorEvent("recall","inject/skip …")` + skip reason 分列 | ✅ 已实现 | `18497-18521`（recall/R3 两套 lastSkip）；reason 含 `step>1/subagent/not-enter/no-sid/empty/synthetic/flag-off/dedup/no-target/error` 与 `R3-won/R3-not-due/R3-empty`（M-1） |

### 1.4 触发判据与热路径预算（§9.5）

| 项 | 判定 | 证据 |
|---|---|---|
| ① `p3.sessions[sid].checkpointAt > 0`（不碰库） | ✅ 已实现 | `18537-18540` |
| ③ 本会话 todo/goal：`p1SessionHasTasks`，用 `P1_EVENT_CACHE.get`，**不用** `readRecentSessionFacts` | ✅ 已实现 | `18542` + `16173-16181`（`get` 不建条目、不触发 LRU）；`readRecentSessionFacts` 无调用 |
| ② 本会话笔记主题存在且未提炼句 > 0；只 readTopic 本会话主题 | ✅ 已实现 | `18543-18557`（`笔记·<wsKey>/<sid8>` 精确名 + `noteUnrefinedCount`） |
| 判据 ②/① 共用同一份 rows + 30s TTL；热路径库调用 ≤1 | ✅ 已实现 | `recallTopicRows` `18523-18533`（`RECALL_ROWS_TTL_MS=30000` `18480`）；门 H2f/H5g 绿（rowsFetches=1） |
| md 模式 / 空库 null-safe | ✅ 已实现 | `18527-18530`（无 store ⇒ []）；`18545-18546` 早退；H3 组 md 空库场景 0 注入 0 抛 |

### 1.5 去重与 claim 批语义（§9.4）

| 项 | 判定 | 证据 |
|---|---|---|
| 键 = `sid + (msg.id || p4cMsgKey(msg))` | ✅ 已实现 | `recallDedupKeyOf` `18560-18566`（`p4cMsgKey` 16920 同 apply 作用域） |
| 内存上限 FIFO 256 防泄漏 | ✅ 已实现 | `RECALL_DEDUP_CAP=256` `18481`；`18568-18577` |
| user 消息在末尾、合成消息不注入、空批不抛 | ✅ 已实现 | `18603-18612`（倒序找 `role==="user" && source.kind==="user"`；空批 skip=empty，无 source ⇒ synthetic） |
| abort/retry 天然不重复 + id/指纹兜底 | ✅ 已实现 | 同上；门 H3a/H3b/H3c/H4a/H4b/H4c 绿 |

### 1.6 成本埋点（§9.3）

| 项 | 判定 | 证据 |
|---|---|---|
| RT 只 `p3CostBump("recallReminder", {...})` **不传 ev** | ✅ 已实现 | `18636`（两参）；`p3CostBump` 的 `if (ev)` 才 pushEvent（`6285-6298`） |
| R3 保留 `ev { trigger:"R3" }` | ✅ 已实现 | `18656` |
| 成本 kind 不新增（KIND_LIST 冻结） | ✅ 已实现 | 仍 `recallReminder`；`_p3-cost-selftest` 复跑 54/0 |
| 门：30 轮 RT 后环内 R3 条数=…/checkpointWrite 未被挤出 | ⚠️ 部分 | 新门 H7c 只验证「RT 后环内 recallReminder=0、totals 记 n」；**未做 30 轮 + checkpointWrite 不挤出**（§9.3 门原文）→ S-4 |

### 1.7 工具描述与 0 结果文案（§B1/B2/B3、K-7）

| 项 | 判定 | 证据 |
|---|---|---|
| `memory_search` 描述三段式（命中即信 / 逐字原文走 session_search / 0 命中逐级升级） | ✅ 已实现 | `20382-20385`；`_alignment-discipline-selftest` 28/28（四短语逐字保留） |
| 直读档 mode-aware（db=`memory_read`(+`memory_topics`)，md=`read 直读 ~/.dsh/memory/`） | ✅ 已实现 | `_msDbMode/_msDirectStep` `20378-20381`；H9a 绿 |
| `session_search` 描述「仅在 memory_search 无有用结果…」 | ✅ 已实现 | `19686` |
| 0 结果文案统一指向 `session_search`、mode-aware、旧「memory_search 查 会话」已删 | ✅ 已实现 | `20486-20497`（`_zStep2` 20490；step3 指向 session_search）；H9c 绿 |

### 1.8 R2 learnings（§9.6 / §10.1）

| 项 | 判定 | 证据 |
|---|---|---|
| 入口取一份 `rows = store.topics()`，三处（own-cp/notes/learnings）+ latestSessionSummary 共用 | ✅ 已实现 | `r2Rows()` 闭包 `16501-16510`；`p4cLastCheckpoint(..., r2Rows())` `16531`；`latestSessionSummary(r2Rows())` `16567`；note `16633`；learnings `16655`；门 L5 `store.topics()` 恰好 1 次 |
| 父线 `会话检查点·<wsKey>` + 名字前缀 `<wsKey>/` 收窄；排除本会话 | ✅ 已实现 | `16659-16673`（`parseSessionTopicName` + `nzCpKey(parent.name)` + `_selfName`）；门 L1a/L1b/L1c 绿 |
| 复用边界（取数+父线校验+去重）；`nzCp` 重写 | ✅ 已实现 | `nzCpKey` `5000`（与 `dreamCheckpointEvidence:4948` 的 nzCp 同正则）；`r2LearnSectionItems` `5006` |
| ≤2 检查点 × 2 节 × ≤2 条 × ≤100 字；段 ≤900（含段头） | ✅ 已实现 | 常量 `4993-4998`；抽取 `5006-5025`；预算 `16700-16706`（整条裁尾，不切半条） |
| 段头在【检查点续接】之前（unshift） | ✅ 已实现 | `16707`；门 L2e 绿 |
| 时间正序（最新在后） | ✅ 已实现 | sort desc + `reverse()` `16672-16675` |
| `R2_TOTAL 6100 → 6900`（clamp + 默认两处） | ✅ 已实现 | `16727-16731` |
| 砍序 learnings 第一（在 profile 前），dropped 记 "learnings" | ✅ 已实现 | `16735-16740` |
| `learn=<条数>` 观测 + 返回值 learnings | ✅ 已实现 | `16780`、`16783`、`REHYDRATE_STATS.learn(last)` `19517` |
| `parseRehydrate` 兼容 learnings 段头 | ✅ 已实现 | `test/_accept-p4.mjs:221`；B6/M3/B10 同步 6900（`:55/:379/:384/:431`）；`_accept-p4` 复跑 98/0 |
| flag 关逐字回基线 | ✅ 已实现 | 门 H10 sha16 与 HEAD 旧字节**独立复算一致**（见 §4.1） |
| 排除本会话的判据强度 | ⚠️ 部分 | 用**名字全等**（`16668`）；若本会话主题带 ` · 标题` 尾缀（`isSessionTopicName` 显式允许）则排除失效 ⇒ S-2 |
| 饱和砍序门口径 | ⚠️ 部分 | 门用 `opts.budget=4600` 收缩同一收口循环（`_test-rehydrate-learnings.mjs:204-214`），**不是** §10.1 要求的「生产 6900 下四段打满」⇒ N-4 |

## 2. 门质量

### 2.1 `test/_test-recall-reminder.mjs`（复跑 53/0，与自报一致）

- **在测行为**：动态直调第 2 个 handler（`callRecall`）覆盖三闸/空批/合成/去重/触发/R3 四种夹具/flag 关；成本环、monitor skip、db 模式 todo/笔记/行数预算均为真夹具行为断言。**不是空转门**。
- **负例充分**：step>1、子代理、reject、空批、合成消息、无 source、同消息去重、flag 关、无目标、别的会话 todo、md 模式无 memory_read、R3-won/R3-not-due。
- **旧字节鉴别（真）**：H10 用固定 md 夹具 + `rebuildLearnings=false` 断言 R2 文本 `sha16 == 31fb4a9f50217a4e`。我用 `git show HEAD:index.js` 在临时目录重跑**同一夹具**，得到**同一 sha16** ⇒ 基线确为改前字节，不是自证。
- 缺口：①§9.2 要求的**动态**「recall 抛错 ⇒ 回归 dequeue=1 / drainCmdEcho=1 / maint spawn≤1」未实现（只有 H2b 静态数 `await next()` 次数）；②§6-4「只进 `enter.messages` 尾部、不改 session 历史/inbox、前后前缀字节不变」无断言；③§9.3「30 轮 RT 后 checkpointWrite 未被挤出」无；④H8h「flag 四处落点」只数源码出现次数（≥5），注释也计数 ⇒ 弱断言（我另经人工核对 WRITABLE 确含两项）；⑤未覆盖「无 agent」闸。

### 2.2 `test/_test-rehydrate-learnings.mjs`（复跑 29/0，与自报一致）

- **在测行为**：真 sqlite 造 P2.5 结构主题（D8 域→线→检查点+笔记），覆盖跨 wsKey/本会话排除/条数与长度预算/段头位置/总长/cpBody/一次取数/monitor/flag 关/单检查点降级/静态常量与砍序。**不是空转门**。
- **负例**：异工作区字面量、本会话字面量、flag 关、单检查点降级、饱和 dropped 白名单。
- 缺口：①饱和用 `opts.budget=4600` 而非生产 6900（同一 while 收口循环，逻辑等价；但 §10.1 门文字要求真饱和）⇒ N-4；②`parseRehydrate` 的 learnings 分支在 md 模式 `_accept-p4` 中**永不执行** ⇒ 该新分支无门覆盖（S-5）；③未断言「learnings 段头与【检查点续接】之间无段重叠」的字节级切分（L2e 只比 index 位置，够用）。

### 2.3 `test/_accept-p4.mjs` 改动自洽性

- `R2_BLOCK_TOTAL = 6900`（`:55`）与实现 `R2_TOTAL` 同口径；B6/M3 文案与断言同步（`:379/:431`）；B10 追加 `learnings` 到「不得整段砍」白名单（`:384-385`，md 模式恒不出现）；`parseRehydrate` 新增 `累积学习` 段头识别（`:221`）避免正文并入 checkpoint 撞 ≤2400。
- 复跑 **98/0**，B6 实测 3865、M3 实测 4008、M6 dropped=[] 均绿 ⇒ 改动自洽，未为过断言整段砍段。

### 2.4 新门未登记 `TEST_DIR_GATES` 的影响

- `_run-suite.mjs:58-75` 白名单未含 `_test-recall-reminder` / `_test-rehydrate-learnings` ⇒ 全量套件**跑不到**这两门，4.5.15 的核心新行为不在自动回归内（与 4.5.13 I'-1 同类制度盲区）。发布前必须登记（任务已注明由 Lead 补，仍列为 N-2）。

## 3. 新失效路径（≥3，按影响排序）

**F-1（中·行为收窄）R3 兜底只对「含真实 user 消息的 step1」生效。**
旧 R3 由 `session/event(turn/start)` 驱动，与 claim 批内容无关；新 handler 在 `18612`（`if (!userMsg) return decision`）就早退，**R3 分支在其后** ⇒ 长串合成消息会话（定时任务交付、goal 自动续轮、abort 重放空批）中 R3 永不触发。若该会话同时 recall 因无记忆目标不注入（`no-target`），则「每 8 轮兜底提醒」通道整体静默。
影响：低-中（RT 为默认通道，R3 仅兜底）；但 §9.1 文字未限定「真实 user 消息」。建议在方案/CHANGELOG 写明，或把 R3 判定移到 userMsg 闸之前（注入仍走同通道）。

**F-2（低·降级非错误）`_r2Store`/`_r2Rows` 在入口一次性快照。**
`16501-16502` 在 build 入口捕获 store；`latestSessionSummary` 内部才 `await topicDbEnsure()`（`17089` 附近）。若 db 模式 build 入口 store 尚未就绪（启动竞态/首次加载慢），则后续 own-cp 库回落（`16531`）、笔记段（`16633`）、learnings（`16654`）全部按 `store=null` 处理 ⇒ 相比 HEAD（每个使用点重新读 `TOPICDB.store`）可能**丢本会话检查点库基线与笔记段**。压缩发生在会话运行期，通常库已就绪 ⇒ 触发窗口极窄、后果是降级不是错误注入。修法：`_r2Store` 改惰性函数（S-1）。

**F-3（低·防御缺口）learnings 排除本会话用「名字全等」。**
`16668` `nm === _selfName`；`p25Topics.parseSessionTopicName` 显式允许尾部 ` · 标题`（`p25-topics.js:247`），若本会话检查点主题带标题尾缀，排除失效 ⇒ **本会话检查点被当 learnings 注入**（跨项目过滤仍有效）。当前写入路径（`9270` `sessionTopicName`）不产标题 ⇒ 现实不可达；建议改按 `parsed.wsKey + parsed.sid8` 比较（S-2）。

**F-4（低）R3 记账与宿主投递非原子。**
`18649` append 进 decision 后即置 `lastNudgeTurn`；若宿主随后丢弃/失败该决策（如 400guard 拒表），提醒丢失 8 轮。旧实现（`agent.inject` + 先置位）更差，本实现已符合 §9.1「append 成功后才置位」的字面口径，不建议改。

**F-5（低）去重表全局 FIFO 256 + TTL 30s 的假阴/假阳。**
①去重键被淘汰后若宿主以非空 claim 批重放旧消息，可能重复注入 1 次（abort/retry 通常空批 ⇒ 现实极低）；②30s TTL 内新建的笔记主题对判据②不可见 ⇒ 首轮漏提醒（false negative）；③`topicDbReset` 后 30s 内旧 rows 残留，`readTopic` 失败 ⇒ 安全降级。均建议接受并在 CHANGELOG 注明。

**F-6（中·观测口径）成本 `recallReminder` 语义已变（R3+RT 混计）但面板标签未改。**
`client/lib/client.js:224` 仍是「定期轻提醒」；RT 每用户消息一条 totals ⇒ 面板该行数字语义从「每 8 轮」变「每轮+每 8 轮」。用户/后续审计会误读。⇒ N-1。

**F-7（预期内）升级后首轮一次性 cache miss。**
工具描述（`20382-20385`/`19686`）+ R2 文本变 ⇒ 前缀缓存失效一次；M-4 要求写进真机验收说明与 CHANGELOG ⇒ N-1 一并写。

**F-8（低）`st.turn` 落盘时机。**
`6416-6424` 自增后未 `scheduleMonitorSave`；与 HEAD 同口径（旧实现也只在 R3 命中时经 `p3CostBump` 落盘），**非本次回归**；但 §9.1 写「持久化」⇒ 建议补一次 debounce 保存，防重启后 R3 相位漂移（S-3）。

## 4. 回归复核

### 4.1 方法（可复现）

1. 建临时基线副本：`%TEMP%\r415-baseline`（robocopy 全仓，排除 `node_modules/payload/.git/_verify` 与 `*.bak*`；`node_modules` 用 junction 指向真实仓），再用 `git show HEAD:index.js` / `git show HEAD:test/_accept-p4.mjs` 覆盖 ⇒ **HEAD 字节基线**。
2. 同一组 13 门分别在**工作区**与**基线副本**跑（`node <gate>`；`_gate-plugin-load.mjs` 传 `index.js` 路径）。
3. 抽取 `^\s*FAIL\s` 行文本集合逐行比对（不看 exit code）。
4. 另用 `%TEMP%\r415-head-verify`（HEAD index.js + 同仓 4 个依赖模块 + `memtopic/`）复跑 `_test-recall-reminder` H10 夹具，独立复算 R2 sha16。

### 4.2 结果

| 门 | 工作区 | 基线（HEAD） |
|---|---|---|
| `_alignment-discipline-selftest` | 28/28 exit0 | 28/28 exit0 |
| `_gate-plugin-load` | FAIL 1 / PASS 111 exit1 | FAIL 1 / PASS 111 exit1（**同一条**） |
| `_test-search-commands` | FAIL 3 / PASS 10 exit1 | FAIL 3 / PASS 10 exit1（**同 3 条**） |
| `_p3-cost-selftest` | 54/0 | 54/0 |
| `_test-size-warn-parity` | 33/0 | 33/0 |
| `_accept-p1` | 49/0 | 49/0 |
| `_accept-p4` | **98/0** | 98/0 |
| `_rehydrate-gate-selftest` | 26/26 | 26/26 |
| `_note-remind-selftest` | 25/25 | 25/25 |
| `_p3-readside-selftest` | 84/84 | 84/84 |
| `_test-t5-fix` | 46/0 | 46/0 |
| `_test-m9m11-fix` | 61/0 | 61/0 |
| `_p3-threshold-spawn-selftest` | 10/0 | 10/0 |

**FAIL 行集合 diff：新增 0、减少 0**（4 条基线红：`_gate-plugin-load` 1 条 v2.6.7 旧文案、`_test-search-commands` 3 条 argv/`--status`）⇒ K-8「按 FAIL 行集合比对、新增=0」成立；自报的「K-8 9 门 + t5/m9m11/threshold 新增 0」**核实为真**。

### 4.3 两新门与自报数字对照

| 自报 | 实测 | 结论 |
|---|---|---|
| recall 门 53/0 | **53/0** | ✅ |
| learnings 门 29/0 | **29/0** | ✅ |
| `_accept-p4` 98 项 | **98/0** | ✅ |
| R2 flag 关 sha16 基线 | **独立用 HEAD 旧字节复算一致** | ✅（真鉴别） |
| K-8/3 门 FAIL 新增 0 | **集合一致** | ✅ |
| 全量套件红集合=基线 9 | **未跑**（约束：不跑 `_run-suite.mjs`） | ⚠️ 引用未验 |
| 真库副本 R2 chars 4880 / learnings 7 条 685 字 / cpBody 1763 / topics 1 次 / 78ms | **未复现**（不触碰真实库） | ⚠️ 引用未验（逻辑上被 29/0 门覆盖） |

## 5. 裁决与必须修改项

**裁决：有条件通过。**

### 必须修改项（N-1 ~ N-4，逐条可验收）

- **N-1（§9.3 / M-4，发布配套）面板标签 + CHANGELOG。**
  `client/lib/client.js:224` 的 `["recallReminder","定期轻提醒"]` 改为「记忆提醒（R3/RT 合计）」；`docs/CHANGELOG.md` 增加 v4.5.15 条目，含：RT 每轮提醒 + R3 迁 pre-step（delta 8 轮/append 后置位）、工具描述升级协议（mode-aware）、R2 累积学习 + `R2_TOTAL 6900`、两 flag（`recallPerTurn`/`rebuildLearnings`）、面板口径变化、**升级后首轮一次性 cache miss 属预期**。
  验收：面板「消耗」页签该行显示新标签；CHANGELOG 有 4.5.15 段且含上述 6 点。

- **N-2（发布阻塞）两新门登记进 `TEST_DIR_GATES`。**
  `_run-suite.mjs:58-75` 追加 `_test-recall-reminder`、`_test-rehydrate-learnings`。
  验收：干净工作区 `node _run-suite.mjs` 能跑到两门（53/29 条），红集合不新增（仍=基线 9）。

- **N-3（§9.2 / §6-4，方案明文门缺失）补两个门用例。**
  ①**动态**验证「不重跑 next」：构造 `next()` 抛错与 recall 内部抛错两种场景（如 agent.session 取 cwd 的 getter 抛），断言：`next` 调用次数=1、`dequeueRegressionReminder`/`drainCmdEcho`/maint spawn 各 ≤1、返回合法 decision（非 undefined）。
  ②**只进尾部**：断言调用前后入参 `messages` 数组长度与元素不变、无 `agent.inject`/`session.append` 调用、`decision.messages` 末尾是 recall 文本（A 类命中时两条尾部提示均在末尾）。
  验收：recall 门新增用例全绿（条数 53 → ≥57），且负例可判红（把 catch 改成 `return next()` 时应变红）。

- **N-4（§10.1，门口径）learnings 饱和门用生产 6900 真饱和夹具，或由 Lead 正式改方案文本。**
  现门用 `opts.budget=4600` 收缩同一 while 收口循环（`_test-rehydrate-learnings.mjs:204-214`，注释已说明），逻辑路径等价但**未验证 §10.1 的算术命题**（四段打满 6100 + learnings 900 > 6900 时 learnings 第一刀）。
  验收（二选一）：(a) 造「checkpoint 2400 + project 1150 + profile 350 + note 1900 + learnings 900」的真饱和夹具，在生产 budget 下 `dropped` 含 `learnings`、不含 profile/project/checkpoint；(b) Lead 在 §10.1 记录口径修订并同步门注释。

### 建议项（S-1 ~ S-9，不阻塞）

- **S-1**：`_r2Store`/`r2Rows` 改惰性取用（防 F-2 入口快照竞态）。
- **S-2**：learnings 排除本会话改按 `parsed.wsKey + parsed.sid8` 比较（防 F-3 标题尾缀）。
- **S-3**：`turn/start` 自增后补 `scheduleMonitorSave()`（§9.1「持久化」；debounce 已存在，成本可忽略）。
- **S-4**：补 §9.3 成本环门（连续 30 轮 RT ⇒ events 环内 `recallReminder` 条数= R3 次数、`checkpointWrite` 明细未被挤出）；H8h 改为断言 `WRITABLE` 集合/SETTINGS_SCHEMA 键存在，而非源码计数。
- **S-5**：给 `parseRehydrate` 的 `累积学习` 分支补解析单测（当前 md 模式 `_accept-p4` 永不执行该分支）。
- **S-6**：learnings 节抽取过滤「无」「（无）」占位行（避免 `- 错误与修复：无` 噪音）。
- **S-7**：`p3-readside.shouldNudge` 已无生产调用点（R3 判定迁走后），标注 deprecated 或删除导出（注意 `_p3-readside-selftest` 引用）。
- **S-8**：真机验收清单补：首轮 cache miss 预期、`.monitor.json` 有 `recall inject kind=RT/R3` 与 skip 事件、压缩后重灌文本含 Verify 段/累积学习段（本轮未做真机）。
- **S-9**：`recallNudgedAt`（§8.2/S-6 观测）未落库；若保留观测语义则写，否则在 §9.1 注明「不写」。

## 6. 审计动作与局限（诚实记录）

**已读**：方案 §9/§10 全文（203-307）；审计③全文 50 行；`git diff index.js` 全文（11 个 hunk，993 行 diff）；`index.js` 相关段 30+（1669、4190-4250、4905-5060、6240-6430、7800-8000、8470-8600、9540-9620、10003-10020、13816-13860、14040-14060、16060-16190、16490-16800、16910-17100、18270-18730、19205-19260、19500-19530、19670-19700、20360-20510、23020-23060、23230-23260）；`p3-readside.js:270-333`；`p25-topics.js:175-269`；`test/_test-recall-reminder.mjs` 全文；`test/_test-rehydrate-learnings.mjs` 全文；`test/_accept-p0-lib.mjs` 全文；`test/_accept-p4.mjs` diff + parseRehydrate 段；`test/_rehydrate-gate-selftest.mjs:108-147`；`_test-size-warn-parity.mjs:70-92`；`_run-suite.mjs:40-90`；`client/lib/client.js:215-235`；`docs/CHANGELOG.md` 头部。

**已跑（只读/隔离）**：两新门（53/0、29/0）；13 门 × 工作区/HEAD 基线副本（FAIL 行集合逐行比对，新增 0）；H10 夹具对 HEAD 旧字节独立复算（sha16 一致）。临时目录 `%TEMP%\r415-baseline`、`r415-head-verify`、`gates-cur`、`gates-base` 用后已删。

**未做/局限**：①未跑 `_run-suite.mjs`（任务约束）⇒「全量红集合=基线 9」引用实现者结果，**未独立验证**；②未复现真库副本数字（不触碰真实 `~/.dsh/memory`）；③未做真机验收（重启后首轮注入、`.monitor.json` 实事件、面板渲染）——按 §6 真机项留待发布前；④未审 `client` 构建产物（只读源码）；⑤`R3` 的宿主 `turn/start` 时序沿用审计②/③ 的 app.asar 结论，本轮未重新取证。
