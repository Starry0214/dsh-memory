# 4.5.15 记忆检索提醒 + 升级协议 + 重建注入（v2 修订）— CRA 审计②（复核 K-1~K-10）

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（HEAD `cea409d`，`index.js` 22875 行）。
- 待复核方案：`docs\方案-4.5.15-记忆检索提醒与升级协议.md` **§8（v2 修订，137-199 行，以此为准）**；§0-§7 为 v1 原文，冲突处以 §8 为准。
- 前置审计：`docs\audit\recall-reminder_AUDIT_2026-11-11.md`（审计①，有条件通过，K-1~K-10 + S-1~S-6）。
- 审计方式：**只读**。未改仓库代码、未部署、未提交、未写记忆库。除本文件外未写任何仓库文件；探针脚本与产物全部落在 `%TEMP%`（跑完已删）；测试均在 `os.tmpdir()` 隔离 home 内跑。
- **新增证据源（审计①未用）**：直接只读扫描本机 DSH 安装版 `C:\Users\Starry\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（213,250,080 B）原始文本，取到 `agent/pre-step` 的**真实派发与 payload 语义**（见 §2 N-2）。这推翻了审计①与方案对「pre-step messages」的两处假设，是本轮最重要的新发现。
- 行号口径：`文件:行`，均为 HEAD `cea409d` 实测行号。

---

## 0. 结论摘要

**裁决：有条件通过。**

§8 对审计① K-1~K-10 的响应整体是**实质性的**，不是文字承诺：K-1（行号）、K-4（注册位）、K-7（文案影响面）、K-8（门清单）**已实质解决**；K-3/K-5/K-6/K-9/K-10 **部分解决**；**K-2 未解决**——§8.2 选的「recall 注入成功 ⇒ 跳过 R3」在宿主时序上**方向不可实现**（R3 在 `turn/start` 决策并注入，早于同轮 step1 的 pre-step），且两套账本（轮次 vs 时间戳）不同构、R3 账本会在未投递时假置位。这是唯一的**阻断级**问题。

§8 引入的**新漏洞 8 条（N-1~N-8）**，其中 4 条会直接导致「看起来做了、实际不生效/退化」：

1. **N-2（最重要，新证据）**：宿主 `agent/pre-step` 的 `messages` 不是会话历史，而是 **`inbox.claim()` 一次性认领的待入队消息批**（认领即从 inbox 删除）。这同时意味着：① K-5 的「abort/retry 同 step 重放因 message id 相同 ⇒ 去重」**机理判断错误**（重放时 claimed 已空，根本拿不到消息）；② R3 的轻提醒（`agent.inject` → next-step）**可能就在同轮 step1 的 `messages` 里**——这是「同轮 ≤1 条」唯一可靠的判定点，方案却去做了跨通道账本。
2. **N-3**：`ev.trigger="RT"` 进了 `pushEvent` 也**没有消费者**——`summarize().today.triggers` / 面板 `costTriggers` 只认 `kind==="checkpointWrite"` 且 `/^T[1-6]$/`；而若每轮 RT 都 pushEvent，会违反 `p3CostBump` 自己的「高频记账不要传 ev」纪律，500 条环形被 RT 挤满、挤掉 checkpointWrite 的触发档位/Top 会话数据（面板退化）。§8.3 的验收门「cost.events 能区分 R3/RT」与「不挤占环形」二选一，方案没选。
3. **N-5**：K-6 的判据 ①（P2.5 会话主题存在）与 ②（本会话未提炼笔记）都要 `store.topics()` 全库扫描，却被放在**每个真实用户消息的 pre-step 热路径**上；仓内对同一调用的实测口径本身就冲突（`4153`/`4234`/`4988` 注「684ms/次」vs `9642` 注「43–70ms」）。方案对性能零字。
4. **N-4**：R2 learnings 复用 `dreamCheckpointEvidence` 时，该函数的「wsKey 父线过滤」是**每个主题校验自己的父线**，**不是**「只取当前会话 wsKey」⇒ 直接复用会跨项目注入，与 R2 现有「防跨项目污染」纪律（`16497-16498`）冲突；且 R2 现有代码已在 `16459`/`16537` 各扫一次 `store.topics()`，加 learnings 是第 3 次。

必须修改项 **L-1 ~ L-8**（逐条可验收），建议项 M-1 ~ M-6。

---

## 1. K-1 ~ K-10 逐条复核

判定口径：**已解决** = §8 的写法可直接实现且验收门能真验；**部分** = 方向对但缺关键实现口径/验收不可执行；**未解决** = 照 §8 实现会不生效或做反。

| # | §8 位置 | 判定 | 代码/实测证据 |
|---|---|---|---|
| **K-1** 行号/机制订正 | §8.1 | ✅ **已解决** | 5 个 pre-step handler 全部核实：A `18134`、回归 `18298`、合并判定 `18327`（只 `setTimeout` spawn，不 append，`18339-18346`）、D3 `18827`、命令回传 `22649`。`2615` = `dequeueRegressionReminder` 函数体（注释在 `2614`）；`6402` = `COMPAT.events` 的 `"agent/pre-step": 0` 计数项，确非挂载点。maint 提醒走 `agent/created`+`agent.inject`（`18111-18124`）✓。**唯一瑕疵**：§8.1 说「2615 是回归队列 helper 注释」，实为 2614 注释 / 2615 函数——不影响验收（M-6）。 |
| **K-2** 与 R3 关系 | §8.2 | ❌ **未解决（阻断）** | 宿主实证（app.asar）：`turn()` 先 `this.session.append("turn/start", { turn })`，之后才 `await this.preStep(target, {turn, step})`；插件 `p3OnSessionEvent` 在 `session/event` 里同步判 R3（`6370-6383`）并置 `st.lastNudgeTurn`，注入在 `setTimeout(0)`（`18867-18876`）⇒ **R3 的决策必然早于同轮 step1 的 pre-step**。§8.2 的「本轮 recall 注入成功 ⇒ 跳过 R3」在时序上不可实现；「共用账本 `recallNudgedAt`」也救不了：R3 判时 recall 尚未跑。另：`recallNudgedAt` 是时间戳、`lastNudgeTurn` 是轮次号，两者不同构，无法判「同一 turn」；且 R3 的 `lastNudgeTurn` 在 `agentsBySession` 无 agent / setTimeout 抛错时**仍已置位**（`6377` 先写、`18868` 才判能否注入）⇒ 若 recall 据该账本让位，会出现「账本说提醒过、模型一个字没看到」的双失。**可行解见 L-1**（把 R3 的到点判定从 `turn/start` 挪进 pre-step，或 recall 让位并改 R3 账本为「投递后置位」）。 |
| **K-3** 成本埋点 | §8.3 | ⚠️ **部分** | 复用 `recallReminder` kind ✓（`p3-cost.js:14`，`KIND_FIELDS` 有 `n,injectedChars`）；`_p3-cost-selftest` 实测 **54 PASS / 0 FAIL**、15 环节冻结断言未动 ✓；`pushEvent` 的 `EVENT_STR.trigger`（`p3-cost.js:188`）确实收 `trigger`（≤8 字符）✓。**但**：`summarize()` 的 `triggers` 只统计 `kind==="checkpointWrite"` 且 `T1-T6`（`p3-cost.js:292-305`），面板 `costTriggers` 同（`client/lib/client.js:293-307`）⇒ `trigger:"RT"` **不进任何聚合视图**，只能读原始 `.monitor.json` 尾部 events；`summarize().events` 默认只回 20 条（`p3-cost.js:354/385`）。且 RT 是**每用户消息一次**的高频事件，`p3CostBump` 注释明写「高频记账（hostUsage 每轮一次）**不要**传 ev，否则环形秒满」（`6235-6237`）⇒ 见 N-3。 |
| **K-4** handler 注册位 | §8.4 | ✅ **已解决** | 注册在 A 之后（`18293` 之后、`18298` 之前）⇒ `test/_rehydrate-gate-selftest.mjs:124` 的 `.find(h => h.event==="agent/pre-step")` 仍取到 A，实测该门 **26/26 全绿**（含 B9 `arr1.length===1`）。消息序推导正确：A 先 `await next()`（`18140`）再 append（`18285-18288`），内层先 append ⇒ 最终 `[…, recall, A]`，A 恒在末尾 ✓。**遗留实现陷阱**（L-2）：注册在 A 之后 = 它是**内层**，A 的 `step!==1`/非顶层早退（`18163-18164`）**拦不住它**，recall 必须自查；且必须「永不 throw」——A 的 catch 是 `return next ? await next() : undefined`（`18290-18292`），recall 一旦抛错会被 A 的 catch **再调一次 next()**，内层链（回归 `dequeueRegressionReminder` / maint 的 `setTimeout` spawn / 命令回传的 `drainCmdEcho`）**整体跑第二遍**。 |
| **K-5** 去重与节流 | §8.5 | ⚠️ **部分** | 消息 id 确实存在：宿主 `createUserMessage({content, source:{kind:"user"}})` 返回带 `.id` 的消息（app.asar，ACP 桥 `inflight.messageId = message.id`），插件 `makeMessage` 同形（`1669-1675`）⇒ 键可用。**但机理判断错**：`messages` 是 `inbox.claim()` 的一次性认领批（claim 即 `mutate(...[])` 从 inbox 删除），同一 step 重放时 `messages` 为空，**不存在「同 id 再现」**；请求级 retry 复用 `decision` 不会重跑 pre-step。另：仓内已有反例注释「DSH deriveMessages **不见得暴露稳定 id**，用内容指纹当水位锚点」（`16752-16753`，`p4cMsgKey`）⇒ 需要指纹兜底。见 N-2 / L-4。 |
| **K-6** 触发条件 | §8.6 | ⚠️ **部分** | 条件 3 删除 ✓；store-null 安全 ✓（审计①已实测 md 模式 `topicdb.ready=false`、`__noteUnrefinedCount(null/[])`→0）；`memoryTopicDbEnabled` 默认 false（`7768`）。**但**：①判据 ①「P2.5 会话主题存在」要 `store.topics()` 全库扫描（仓内无按名索引 API，`memtopic/src/memory-store.mjs:386` 起）；②判据 ② 需 `topics()`+`readTopic()`（`noteUnrefinedStats:4235-4256`）；两者都落在**每用户消息的 pre-step 热路径**（N-5）。③todo/goal 支指向 `readRecentSessionFacts`（`16889-16908`，钩子 `22793`）——那是**启动期的全局单份快照**（`st.recentSessionFacts`，带 `sid`、7 天窗），**不是**「本会话 todo/goal」；真正的 per-session 源是 P1 的 `p1CacheOf(sid)`/`P1_EVENT_CACHE`（`16080-16110`，目前**无对外访问器**）。见 L-5。 |
| **K-7** mode-aware + 0 结果文案 | §8.7 | ✅ **已解决（就影响面而言）** | 0 结果文案**全仓只此一处**：`20102-20106`；db 模式 `topicDbRenderSearch` 0 命中返回 null ⇒ 回落该文案（`index.js:8680-8682`、`20150-20157`）。门影响实测为零：`_test-search-commands` 不碰该文案（3 条基线 FAIL 全在 CLI argv：`argv=null`，实测 FAIL 3 / PASS 10）；`_alignment-discipline-selftest` 只断言描述四短语（`45-48`），实测 **28/28 绿**；`_gate-plugin-load:203-204` 的 `再试 source:` 在 **session_search** 的 0 命中文案 `19543`，不在改动范围。**约束**：改描述时四短语（`命中即信`/`要精确字面量`+`session_search 回原始会话捞逐字原文`/`不要从摘要反推或猜`/`命中行尾的 ⟪…⟫`）必须逐字保留。 |
| **K-8** 回归门清单 | §8.8 | ✅ **已解决** | 9 门齐、验收方式（FAIL 行集合逐行比对、不看 exit code）明确。本轮实测基线：`_rehydrate-gate-selftest` **26/26**、`_p3-cost-selftest` **54/0**、`_test-size-warn-parity` **33/0 全绿**、`_alignment-discipline` **28/28**、`_accept-p4` **PASS 98 / FAIL 0 / SKIP 0**；`_gate-plugin-load` **FAIL 1 / PASS 111**、`_test-search-commands` **FAIL 3 / PASS 10**（这 2 门基线本就 exit=1，与 K-8 描述一致）。**补**：K-2 会写 `p3.sessions[sid]` 新字段，建议把 `_test-t5-fix` / `_test-m9m11-fix` / `_p3-threshold-spawn-selftest` 纳入比对清单（L-8）。 |
| **K-9** R2 learnings | §8.9 | ⚠️ **部分** | 预算公式自洽（`2×2×2×100=800` + 头 60 ≤ 900）✓；砍序首位 ✓；段头位置（`【检查点续接】` 之前）✓；排除本会话 ✓（但需调用侧按 `会话检查点·<wsKey>/<sid8>` 过滤，函数本身无此参数）。**三处不成立**：①`dreamCheckpointEvidence`（`4924-4976`）的 wsKey 过滤是「每个主题的父线 == 它自己的 wsKey 线」（`4946-4950`），**不按当前会话 wsKey 收窄** ⇒ 直接复用会跨工作区注入；②其输出是**整节**（每节 ≤90 字 `4650`、≤4 项 `4648`、块上限 1200 `4649`），与「2 节 × ≤2 条 × ≤100 字」不同构；③R2 已在 `16459`/`16537` 各调一次 `store.topics()`，加 learnings 成第 3 次，「一次取数」应升格为函数入口取一份 rows 传三处。另：`R2_TOTAL` 仍 6100（`16569-16573`），四段 body 上限合计已 5800+装配头≈6100（`16354-16361`）⇒ **真饱和时 learnings 是第一刀**，功能在最需要它的长会话里必然消失；`monitorEvent("rehydrate", …)`（`16613-16615`）也没有 learn 段观测。见 N-4 / L-6。 |
| **K-10** 承诺订正 | §8.10 | ⚠️ **部分** | 拆句 ✓、「工具描述变更对所有模式生效」✓、「A2 ≤180 加断言」作为要求 ✓。**但**：①「flag 关 ⇒ 注入零字节 + R2 sha16 == 基线」把**两个 flag 混成一句**——`recallReminder` 关不影响 R2，R2 基线由 `rebuildLearnings` 决定；②A2 只给了目标、**没给修订后文本**（v1 样例实测 288 字符，含标签 6 行），审计阶段无法验「≤180」；③R2 sha16 冻结需先冻结 fixture（`_test-dream-prescreen.mjs:41-45` 的 `GOLDEN_SHA16` 只是**模式**可照抄，R2 文本依赖检查点/项目/画像内容，需固定造数）。见 L-7。 |

**小结**：K-1/K-4/K-7/K-8 = 已解决（4）；K-3/K-5/K-6/K-9/K-10 = 部分（5）；K-2 = 未解决（1）。

---

## 2. §8 新漏洞（N-1 ~ N-8，全部可复现/可定位）

**N-1（阻断·时序）§8.2 的「recall 成功 ⇒ 跳过 R3」方向不可实现。** 见 K-2。宿主 `turn()` 先发 `turn/start` 再进 `preStep`；R3 在 `session/event(turn/start)` 同步判定（`6370-6383`）。方案的两个候选机制都不成立：(a) 让 R3 查 recall 账本——R3 判时 recall 还没跑；(b) 共用 `recallNudgedAt`——单位不同构（时间戳 vs 轮次）且 R3 的轮次账本先写。

**N-2（新证据·语义）`agent/pre-step` 的 `messages` = 一次性 claimed 批，不是历史。** 宿主（app.asar，只读扫描，字节偏移≈19434557 的 `preStep`）：
```
const claimed = this.inbox.claim(target, position.turn);
const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal, modelSelection }, () => ({ kind:"enter", messages: [...claimed, context] }));
```
`claim()`（偏移≈19414894）= `mutate("next-step",0,len,[],false)` + `mutate("next-turn",0,1,[],false)`，**认领即删除**；`inject()`（偏移≈19430934）= `send(input,"next-step",false)`；`followup` = `send(input,"next-turn",true)`。推论：
1. step1 的 `messages` = `[next-step 里的注入消息…, 本 turn 的 user 消息]`，**user 消息在末尾**；`next-step` 里可能有 R3 轻提醒（`agent.inject`）、D3 停轮说明、init guide 等插件消息；
2. **同一 step 不会被重跑**（claim 已消费）；请求级 retry 复用 `decision` 不重跑 pre-step ⇒ K-5 的「abort/retry 同 id 去重」前提不存在；
3. 「同轮 ≤1 条」的可靠判定点是**本批 `messages` 里是否已有 R3 文本**（或把 R3 判定挪进 pre-step），不是跨通道账本；
4. 实现上还有一个硬约束：`turn()` 里 `if (phase.step === 0 && decision.messages.length === 0) { turnEnds = {kind:"completed"}; return false; }` ⇒ **首步 messages 为空即整轮结束**，任何 handler 只能 append、绝不能替换/清空。

**N-3（成本·环形账本）`ev.trigger="RT"` 没有消费者，且高频 push 会挤掉高价值事件。** `p3-cost.js:292-305`/`client.js:293-307` 只统计 `checkpointWrite` + `T1-T6`；`summarize().events` 只回尾部 20 条（`354`/`385`）。RT 每用户消息一条 ev ⇒ 500 条环形（`196-209`）被 RT 占满，`checkpointWrite` 的 `trigger`/`topSessions` 明细被挤出，面板「触发档位/Top 会话」退化（`triggersOf:292`、`buildTopSessions:319`、`client.js:293-324`）。面板分环节标签还叫「定期轻提醒」（`client.js:224`），RT 计入后名实不符。**二选一必须写死**（L-3）。

**N-4（R2·跨项目与预算）** 见 K-9 ①②③ + 6100 饱和第一刀。补充实测：`_accept-p4` 基线重灌块 3865 / MAX 4008，门上限 6100（余量 2235 / 2092）⇒ 加 900 字**不会顶红 B6**；**但该门是 `CFG_OFF={}`（md 模式，`_accept-p4.mjs:45`）且只造 `sessions/*.md`** ⇒ learnings 段在现有门里**根本不出现**，「兼容」是空的，必须新建 db 模式造数门（≥2 同 wsKey 检查点 + 1 异 wsKey + 1 本会话）。

**N-5（性能·热路径）** K-6 判据 ①② 的 `store.topics()` 全库扫描落在每用户消息的 pre-step 上。仓内对同一调用两套实测口径冲突（`4153`/`4234`/`4988`「684ms/次」vs `9642`「43–70ms」）；无论取哪个，都不该在同步 pre-step 里无条件做。**廉价替代已存在**：`p3.sessions[sid].checkpointAt`（`p3MarkCheckpointDone:7445-7451`，T1/T4/T5 任一 cid 写成功都置位、已持久化）。

**N-6（异常/重入）新 handler 是内层，必须「永不 throw」。** A 的 catch（`18290-18292`）与回归的 catch（`18319-18321`）都是 `return next ? await next() : undefined` ⇒ recall 抛错会被外层 catch **再调一次 next()**，内层链跑第二遍：`dequeueRegressionReminder`（`18314`，破坏性消费）、maint 的 `setTimeout(runMaintenanceMerge)`（`18341-18345`，双 spawn）、`drainCmdEcho`（`22655`，破坏性）。方案未写这条纪律。

**N-7（数据源错位）** todo/goal 支指向 `readRecentSessionFacts`（全局启动快照、7 天窗、带 `sid` 字段，`16889-16908`），不是「本会话」；真源是 `P1_EVENT_CACHE`/`p1CacheOf(sid)`（`16080-16110`），当前无对外访问器。若照 §8.6 实现，「本会话有 todo/goal」会被上一会话/别的会话的快照命中（假阳）或 7 天后失效（假阴）。

**N-8（承诺混句/不可验收）** K-10 把两个 flag 的验收混成一句；A2 无定稿文本；R2 sha16 基线无 fixture 冻结口径。见 K-10 / L-7。

---

## 3. 裁决与必须修改项（L-1 ~ L-8）

### 裁决：**有条件通过**

方向、机制判断（除 N-2 一处）与门影响面分析成立，K-1/K-4/K-7/K-8 可放行；**K-2 必须重写**（阻断），K-3/K-5/K-6/K-9/K-10 按下列 L 项补齐口径后即可进入实现。以下 L 项全部落实前不建议动代码。

| # | 必须修改 | 验收标准（可执行） |
|---|---|---|
| **L-1** | **重写 §8.2 的 R3 关系（K-2/N-1）**：把 R3 的「到点判定」从 `session/event(turn/start)` 挪进**同一个 pre-step 链**（`turn/start` 只保留 `st.turn` 计数），在同一 handler 内先判 recall、再判 R3 兜底（或 recall 让位 + R3 改为「注入成功后才置 `lastNudgeTurn`」）；删除「recall 成功 ⇒ 跳过 R3」的不可实现表述；账本统一为**轮次**（`st.turn` + `lastNudgeTurn`），若保留 `recallNudgedAt` 必须写明其只作观测、不参与判定 | 夹具 A：`turn=8` + 有检查点会话 + 两个通道都可触发 ⇒ 模型可见同类提示 **1 条**；夹具 B：`turn=7` ⇒ 1 条（仅 recall）；夹具 C：`agentsBySession` 无 agent（R3 投递失败）⇒ 该轮仍**有 1 条**（不因账本假置位双失）；夹具 D：`recallReminder=false` ⇒ R3 按原 8 轮兜底仍 1 条 |
| **L-2** | **写死 handler 纪律（K-4/N-6）**：注册点 = `18293` 之后、`18298` 之前；函数内自查 `step===1 && isTopLevelSession(agent) && decision.kind==="enter"`（注册在内层，A 的早退拦不住它）；整体 try/catch 且 **catch 返回 `decision`，绝不 `await next()`**；只 append、绝不替换/清空 `messages`（首步 messages 空即整轮结束，宿主 `turn()` 实证） | 静态：pre-step handler 序号断言（A=1、recall=2）且 recall 内含 `step !== 1`/`isTopLevelSession`/`kind === "enter"` 三闸；动态：注入「recall 抛错」的 mock ⇒ 回归队列 `dequeue` 计数 = 1、`drainCmdEcho` 计数 = 1、maint spawn 计数 ≤ 1 |
| **L-3** | **成本埋点二选一写死（K-3/N-3）**：**推荐** RT 只 `bumpKind+addDaily`（**不传 ev**），R3 保留 `ev{trigger:"R3"}`；「能区分 R3/RT」改为读 `totals/daily` 的 `recallReminder.n` + 原始 events 里的 R3 条数，或另开 `.monitor.json recall` 段（不动 `KIND_LIST`）；若坚持 RT 也进 events，必须同时把环形 cap 提高并说明挤占代价 | `_p3-cost-selftest` 保持 54/0；连续 30 轮 RT 后：events 环内 `kind==="recallReminder"` 条数 = R3 次数（RT=0 条），`checkpointWrite` 事件不被挤出；面板「定期轻提醒」口径说明写入 CHANGELOG（混计/不混计二选一） |
| **L-4** | **重写 K-5 去重口径（K-5/N-2）**：键 = `sid + (msg.id || p4cMsgKey(msg))`；写明 `messages` 是 claim 批（可为空、可含 next-step 注入消息、user 消息在末尾）；abort/retry 说明改为「重放时 claimed 已空 ⇒ 天然不重复；id/指纹去重只作防御」；空批/无 id 兜底 | 夹具：同一 `messages` 两次 pre-step ⇒ 1 次；两条不同 user 消息 ⇒ 各 1 次；`messages=[]` ⇒ 0 次且不抛；无 `id` 的消息（只有 role+content）⇒ 指纹去重仍只 1 次；`source.kind!=="user"` 合成消息 ⇒ 0 次 |
| **L-5** | **K-6 触发条件落定（N-5/N-7）**：判据 ① 只用 `p3.sessions[sid].checkpointAt > 0`（P2.5 主题存在若保留，须 per-sid 缓存 + TTL，且与判据 ② 共用同一份 `store.topics()` rows）；判据 ② 同上；todo/goal 支改用 P1 的 per-session 源（新增 `p1SessionHasTasks(sid)` 访问器），**不得**用 `readRecentSessionFacts`；写明热路径预算（单次 pre-step 库调用 ≤1 次且带 TTL） | 静态：pre-step 路径内 `store.topics()` 调用次数 ≤1 且被 TTL 包住；动态：md 模式 + 空库 + 新会话 ⇒ 0 注入 0 抛；db 模式只有 todo 无检查点 ⇒ 注入；db 模式只有**别的会话**的 todo ⇒ 不注入 |
| **L-6** | **R2 learnings 重写（K-9/N-4）**：①`buildPostCompactRehydrate` 入口取一份 `rows = store.topics()`，传给 `16459`/`16537`/learnings 三处（顺手消除现有两次重复扫描）；②rows 先按 `会话检查点·<wsKey>` 父线 + `<wsKey>/` 前缀筛本工作区，再排除本会话 `会话检查点·<wsKey>/<sid8>`；③明确复用边界=「取数+父线校验+`nzCp` 去重」，节抽取按 ≤2 条/≤100 字另写（或把预算公式改成与 90 字/整节一致）；④预算二选一：`R2_TOTAL 6100→7000`（同步 `_accept-p4` 的 `R2_BLOCK_TOTAL`/B6/B10）**或**明确「饱和即降级」并在 `monitorEvent("rehydrate", …)` 增 `learn=` 观测；⑤`_accept-p4` 是 md 模式，learnings 需**新建 db 模式造数门** | 新门：db 模式造 2 个同 wsKey + 1 个异 wsKey + 1 个本会话检查点 ⇒ learnings 只含同 wsKey 的 2 个、不含本会话/异 wsKey 字面量；饱和夹具 `dropped` 含 `learnings`、不含 profile/project/checkpoint；`cpBody ≤ 2400`；块总长 ≤6100（或 7000，按选定口径）；`_accept-p4` 现有 98 项保持全绿；`store.topics()` 每次重灌只调 1 次（静态或计数探针） |
| **L-7** | **K-10 验收可执行化**：按 flag 拆成两句——`recallReminder=false ⇒ pre-step 注入 0 字节`（与 R2 无关）；`rebuildLearnings=false ⇒ R2 text sha16 == 冻结基线`；给出 A2 **定稿文本**（含 `<system-reminder>` 标签，`[...].length ≤ 180`）并写明断言位置；R2 sha16 门写明固定 fixture（造数内容 + 时间戳归一化口径） | 两个独立夹具分别断言；A2 文本长度断言（含标签）≤180 且含 S-2 原句；R2 sha16 门在 flag 关下与基线逐字相等（照 `_test-dream-prescreen.mjs:41-45` 归一化） |
| **L-8** | **K-8 门清单补 3 门 + 写清 out 期望（N-3/N-4）**：把 `_test-t5-fix`、`_test-m9m11-fix`、`_p3-threshold-spawn-selftest` 加入 FAIL 行集合比对（K-2 会写 `p3.sessions` 新字段）；`_test-size-warn-parity` 的期望写清：E1-E6 是**子串式**断言（`接近硬限`/`已超硬限`），新 recall 消息不会顶红，但 `out` 字符串会变（其 `callPreStep` 夹具 `messages=[{role:"user",content:string}]` **无 `source`/`id`** ⇒ 按 L-4 口径 recall 不注入、out 不变；若实现放宽为「无 source 也算 user」则 out 变但断言仍绿） | 改动前后 9+3 门 FAIL 行文本集合一致（新增 0）；`_test-size-warn-parity` E1-E6 全 PASS 且 `out` 变化与实现口径一致（门内注明）；`_test-t5-fix`/`_test-m9m11-fix` 绿 |

### 建议项（M-1 ~ M-6）

- **M-1**（S-4 落实）`monitorEvent("recall","skip reason=no-target|flag-off|subagent|synthetic|step>1|R3-won")` 逐条落字符串，别只记 inject；「做了但没生效」类事故（见 `T5-fix_AUDIT` §0）全靠这条区分。
- **M-2** 新门补一条「recall 注入文本按 `memoryTopicDbEnabled` 分支」的静态断言：db 模式含 `memory_read`/`memory_topics`，md 模式**不含**（K-7 的验收目前只写在 §8.7 文字里）。
- **M-3** `recallReminder` 同时是 **flag 名**与**成本 kind 名**，容易在代码里混读（`PLUGIN_CFG.recallReminder` vs `p3CostBump("recallReminder")`）；建议 flag 改名 `recallPerTurn` 或注释显式区分。
- **M-4**（S-5 落实）真机验收写明「升级后首轮一次性 cache miss」（工具描述 + R2 文本都变），并给出预期观测（首轮 cacheRead 低、次轮恢复），避免误判回归。
- **M-5** `_test-size-warn-parity.mjs` 与 `_test-search-commands.mjs` 等门在**仓库根目录**（不在 `test/`）；方案/门清单写路径时统一到根目录，避免实现方去 `test/` 找不到（本任务派单也写成了 `test/_test-size-warn-parity.mjs`）。
- **M-6** §8.1 的「2615 是回归队列 helper 注释」订正为「2614 注释 / 2615 `dequeueRegressionReminder` 函数」（K-1 验收抽查会踩到）。

---

## 4. 审计动作与局限（诚实记录）

**已读**：方案全文 199 行（§8 逐字）；审计①全文 155 行；`index.js` 相关 25+ 段（6200-6420、7440-7455、13755-13775、16075-16145、16340-16620、16748-16790、16885-16910、18075-18295、18298-18355、18820-18890、19285-19340、19960-20190、20150-20260、22640-22690）；`p3-cost.js` 全文；`p3-readside.js` 240-333 与常量 40-62；`p25-topics.js` 205-275；`client/lib/client.js` 215-330；`memtopic/src/memory-store.mjs` 386 起（`topics()`）与 `backend-sqlite.mjs` 108/147/161/185；门：`test/_rehydrate-gate-selftest.mjs` 全文、`test/_accept-p4.mjs` 1-60/180-430、`test/_accept-p0-lib.mjs` 60-210、`test/_alignment-discipline-selftest.mjs` 20-80、`_gate-plugin-load.mjs` 75-135/180-229、`_test-search-commands.mjs` 全文、`test/_p3-cost-selftest.mjs` 50-120、`_test-size-warn-parity.mjs` 全文、`test/_note-remind-selftest.mjs`、`test/_p3-readside-selftest.mjs` C/D 组、`test/_test-dream-prescreen.mjs` 30-60。

**已跑（只读/隔离，全部 `os.tmpdir()` 假 home，未触碰真库）**：
- `node test/_rehydrate-gate-selftest.mjs` → **全部通过 26/26**
- `node test/_p3-cost-selftest.mjs` → **PASS 54 / FAIL 0**
- `node _test-size-warn-parity.mjs` → **全绿 PASS 33/0**
- `node test/_alignment-discipline-selftest.mjs` → **全部通过 28/28**
- `node test/_accept-p4.mjs` → **PASS 98 / FAIL 0 / SKIP 0**（B6 重灌块 3865 / MAX 4008，门上限 6100）
- `node _gate-plugin-load.mjs index.js` → **FAIL 1 / PASS 111**（基线）
- `node _test-search-commands.mjs index.js` → **FAIL 3 / PASS 10**（基线，红行全在 CLI argv）
- **只读探针（app.asar 原始文本，8 轮）**：定位 `preStep`/`inbox.claim`/`send`/`inject`/`followup`/`turn` 的真实实现，取得 N-2 的全部宿主证据；探针脚本与产物均在 `%TEMP%`，已删。

**未做/局限**：
1. 未跑 `_run-suite.mjs`（任务明令禁止）；未跑 `_accept-p1`/`_accept-p2`/`_test-m9m11-fix`/`_test-t5-fix`（时间与判据无关性：本轮不涉及它们的被测面，但 K-2 落地后必须跑，见 L-8）。
2. 未在真机实测 `store.topics()` 耗时（真库 29.7 MB 未打开）；N-5 的性能结论基于仓内**互相冲突**的两处注释（684ms vs 43–70ms），因此 L-5 只要求「≤1 次 + TTL」而不钉具体毫秒。
3. app.asar 证据来自**安装版 213 MB 原始文本只读扫描**（按函数片段与字节偏移定位），不是运行中的宿主探针；`messages` 是否恒含 `source.kind==="user"` 由 `createUserMessage` 构造点与插件既有用法（`18836`）双向印证，但未在真机 seq 上抓一次 pre-step payload。
4. v2 尚未实现，所有「门/夹具」判定都是**方案级**（照 §8 实现会怎样），不是实测红绿；L-1~L-8 的验收标准即为此设计。
5. 未评估 client 面板是否需要为 RT/R3 区分新增展示（只读到 `client.js:215-330` 的 cost 消费段，判断为「当前不会显示 trigger」，未逐行读完 862 行）。
6. 未读 MiMo 原文（审计①已逐条核对过 `prompt.ts`/`checkpoint.ts`/`memory.txt`/`history.txt`，本轮以审计①结论为准，未复核）。
