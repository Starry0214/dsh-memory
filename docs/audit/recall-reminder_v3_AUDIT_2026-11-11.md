# 4.5.15 方案 v3（§9）— CRA 审计③ 快速复核（L-1~L-8）

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（HEAD `cea409d`）。
- 待复核：`docs\方案-4.5.15-记忆检索提醒与升级协议.md` **§9（203-273 行，以此为准）**；前置 = 审计② `docs\audit\recall-reminder_v2_AUDIT_2026-11-11.md`（有条件通过，L-1~L-8 阻断项）。
- 方式：**只读**。未改代码/未部署/未提交；未跑 `_run-suite.mjs`；只读探针仅扫描 app.asar 原文（脚本与产物在 `%TEMP%`，已删）；行号口径 `文件:行`（HEAD 实测）。

## 0. 结论

**裁决：有条件通过（可进入实现，先修 3 条文档级阻断）。**

L-1~L-6、L-8 在 §9 中**实质可执行**，不是文字承诺。三个被点名的疑点实测均有解：①R3 挪进 pre-step 后 `st.turn` **拿得到**——宿主 `turn()` 先 `session.append("turn/start")` 再 `await preStep`，且 `session.commit()` **同步**派发 `session/event`，故 pre-step 时 `st.turn` 已自增；②`_accept-p4` 的 7000 预算**不破门**（该门 md 模式且不驱动 pre-step，learnings 不出现）；③`p1SessionHasTasks` **已有可用源**（`P1_EVENT_CACHE` + 宿主真实 `todo/write` 事件）。剩余阻断全部集中在 **L-6 砍序门** 与 **L-7 A2 文案/门**，只需修订方案文本，不需新证据。

## 1. L-1 ~ L-8 逐条判定

| # | 判定 | 证据与结论 |
|---|---|---|
| **L-1** R3 挪进 pre-step | ✅ **已解决** | 自增点 `index.js:6370-6373`（`turn/start` 且 `!isSub` 时 `st.turn=turn`）；`p3SessionState` 导出 `6261`/`7551`，与 pre-step handler 同处 `apply` 作用域（`13398` 起）⇒ 账本可直接读。宿主时序：app.asar `async turn()`（偏移≈19397940）先 `append("turn/start")` 后 `preStep`，`commit()`（≈117623171）同步 `invokeContainedSessionObservers` ⇒ pre-step 读到已自增的 turn ✓。注意：①旧注入点 `18867-18876` 必须删，否则 R3 双发；②`buildRecallNudge` 内部仍有 `turn % everyN === 0` 硬闸（`p3-readside.js:299`），与 §9.1 的 delta 判定不同口径，实现须以 build 返回非 null 为准。 |
| **L-2** handler 纪律 | ✅ **已解决** | 注册位可落：A 结束 `18293` / 回归开始 `18298`，A 仍第 1 个 ⇒ `test/_rehydrate-gate-selftest.mjs:124-134`（find 首个 + `arr1.length===1`）不变；三闸/只 append/不 await next 均可写。注意：`next()` 自身抛错时 `decision` 为 undefined，catch 直接 `return decision` 会把 undefined 交给宿主（`18290-18292` 先例说明内层链会重跑）；须兜底且**绝不重跑 next**（回归 `dequeueRegressionReminder:18314`、maint spawn `18341-18345`、`drainCmdEcho:22655` 均破坏性）。 |
| **L-3** 成本埋点 RT 不传 ev | ✅ **已解决** | `p3CostBump(kind, delta, ev)` 的 ev 可省（`index.js:6230-6252`，`if (ev)` 才 `pushEvent`）；`KIND_LIST` 冻结 `p3-cost.js:13-20`；`_p3-cost-selftest` 不涉及 recallReminder 的 pushEvent 语义（`test/_p3-cost-selftest.mjs:91/157/201-204`）⇒ 54/0 不受影响。面板标签 + CHANGELOG 为文档动作。 |
| **L-4** 去重口径 | ✅ **已解决** | claim 批语义审计② N-2 已证；`p4cMsgKey` `16754` 在 apply 作用域内可直用；`makeMessage` 自带随机 id + `source.kind="plugin:dsh-memory"`（`1669-1676`）⇒ 合成消息闸可靠；abort/retry 重放时 claimed 已空 ⇒ 天然不重复。 |
| **L-5** 触发条件 | ✅ **已解决** | ①`checkpointAt` 由 `p3MarkCheckpointDone`（`7445-7451`）置位，T1 `22106` / T4 `15899`·`15979` / T5 `15946`·`22178` 全覆盖；②todo 源可用：`P1_EVENT_CACHE`/`p1CacheOf`（`16076-16110`）+ 宿主真实事件 `'todo/write': { todos: TodoItem[] }`（app.asar 事件表，全文 74 处），`p1TodosFromData` 认 `d.todos`（`16150-16154`）。注意：缓存**纯内存**（重启即丢，todo 支降级）；访问器须用 `P1_EVENT_CACHE.get(sid)` 而非 `p1CacheOf`（后者建条目并触发 200 上限 LRU）；判据②若照 `noteUnrefinedStats`（`4235-4256`）实现会对**全部**笔记主题逐个 readTopic，而 §9.5 门只数 `store.topics()` ⇒ 应只按本会话 `笔记·<wsKey>/<sid8>` 读 1 次。 |
| **L-6** R2 learnings | ⚠️ **部分** | 一次取数可行：`dreamCheckpointEvidence(rows, opts)` 已收 rows（`4924`），入口取一份传入即可；但 `nzCp` 是函数内局部（`4937`）**不可复用**（§9.6「复用 nzCp」当前不成立，须上提或重写）。`R2_TOTAL` 是 `16571`/`16572` 两处字面量（clamp+默认）。`_accept-p4` 的 `R2_BLOCK_TOTAL` 由 `R2_BUDGET` 派生（`test/_accept-p4.mjs:52-54`）、H1 只比 checkpoint/project/profile（`:292-294`）⇒ 加 learnings 键不破；该门 `CFG_OFF={}`（`:45`）且不驱动 pre-step ⇒ learnings 不出现，98 项不受影响。**阻断见 B1**。 |
| **L-7** 验收可执行化 | ⚠️ **部分** | 两 flag 拆开 + R2 sha16 固定夹具可执行（照 `test/_test-dream-prescreen.mjs:41-45`）；A2 文本见 **B2/B3**。 |
| **L-8** 门清单补 3 门 | ✅ **已解决** | `_test-size-warn-parity` E1-E6 确为子串断言（`:190-232`），夹具 `messages=[{role:"user",content}]` 无 source/id（`:82-90`）⇒ 按 L-4 不注入、out 不变；追加的 `_test-t5-fix`/`_test-m9m11-fix`/`test/_p3-threshold-spawn-selftest` 均不驱动 `agent/pre-step`（grep 无调用），只受 `p3.sessions` 新字段影响，FAIL 行集合比对可覆盖。基线实测：`_test-size-warn-parity` **33/0**、`_p3-readside-selftest` **84/84**。 |

## 2. 阻断项（3 条，均为方案文本修订，不需新证据）

**B1（L-6）预算与砍序门不自洽 ⇒ §9.6 的 dropped 断言不可满足。**
四段 body 硬上限合计 5800 + 装配头 ≈300 = **6100**（`index.js:16358-16361` 注释明写「四段全满也放得下 6100」）；learnings 段 ≤900（§8.9 明确含段头）⇒ 总长上限 6100+900 = **7000** = 新的 `R2_TOTAL`；而砍序判据是**严格** `text.length > R2_TOTAL`（`index.js:16577-16608`）。⇒ 总长永不超过 7000，任何段都不会被砍，`dropped` 永不含 `learnings`；§9.6 门「饱和夹具 dropped 含 learnings、不含 profile/project/checkpoint」**不可满足**（也造不出能触发的饱和夹具）。
修法：`R2_TOTAL` 取 >7000（如 7200，给 learnings 之外的装配留余量），或把 learnings 原始渲染上限抬到 >900 再由总收口裁；同时同步 `_accept-p4` 的 `R2_BLOCK_TOTAL`（派生式加 learnings 900）与 §9.6 文案。

**B2（L-7）A2 定稿文本长度与 md 分支互斥。**
§9.7 定稿文本（db，含 5 行换行）实测 **177** 字符（余量仅 3）；md 变体把 `memory_read` 换成「read 直读 ~/.dsh/memory/ 文件」后 **187**；若按 §8.7 原句「read 直读 `~/.dsh/memory/` 下对应文件」则 **197** —— 均破「含标签 `[...].length ≤ 180`」断言（§9.7 未限定 db-only）。
修法：定稿文本再压 ≥17 字，或给 md 变体单独一份 ≤180 的等价文本 + 双断言。

**B3（L-7/M-2）门与定稿文本互斥 + flag 名三处不一。**
§9.9 M-2 要求 db 模式静态断言文本含 `memory_topics`，但 §9.7 定稿文本**无该词**；补词（+≈15 字）直接破 180 ⇒ 门与文本不可同时成立。另 M-3 定 flag 名 `recallPerTurn`，而 §9.1 门 D、§9.7 夹具仍写 `recallReminder=false` ⇒ 实现/夹具/门三处口径不一。
修法：M-2 去掉 `memory_topics`（或改断言「0 命中升级阶梯」文案），flag 统一 `recallPerTurn` 并同步 L-1/L-7 夹具文本。

## 3. 放行条件

1. B1/B2/B3 按上述修法改 §9 文本后，**可进入实现**（无需再补宿主证据）。
2. 实现必带：删旧 R3 注入点 `18867-18876`；recall handler catch 不得返回 undefined、不得重跑 next；`p1SessionHasTasks` 用 `Map.get`；判据②只读本会话笔记主题；L-5 的 TTL 与 L-4 的 LRU 同步落地。
3. 实现后按 L-8 清单（9+3 门）做 FAIL 行集合比对；新门（recall / db 造数）与 `_test-size-warn-parity` 的 out 口径须一致。

## 4. 审计动作与局限（诚实记录）

**已读**：§9 全文（203-273）；审计② 全文 127 行；`index.js` 相关 20+ 段（6260-6390、7430-7500、16055-16160、16340-16620、16735-16765、16855-16910、18080-18360、18790-18900、22085-22115）；`p3-readside.js:280-333`；`p3-cost.js:10-20`；`test/_accept-p4.mjs:45-56/200-230/276-316/354-390/426`；`test/_rehydrate-gate-selftest.mjs:114-140`；`_test-size-warn-parity.mjs:1-95/180-235`；`test/_p3-cost-selftest.mjs` 关键断言；`test/_p3-readside-selftest.mjs` C/D 组。
**已跑（只读/隔离）**：`node _test-size-warn-parity.mjs` → **33/0**；`node test/_p3-readside-selftest.mjs` → **84/84**。只读探针：app.asar 原文 3 轮（`turn()` 顺序、`session.commit()` 同步派发、`todo/write` 事件表），脚本在 `%TEMP%` 已删。
**未做/局限**：未跑 `_run-suite.mjs`/`_accept-p4`/其余门（本轮为方案级复核，未改实现，无红绿可测，基线沿用审计② 98/0）；未在真机抓 pre-step payload（沿用审计② app.asar 结论）；未评估 client 面板展示改动；A2 字符数为本地实测（含换行，按 `[...text].length` 口径）。
