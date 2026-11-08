# CRA · 压缩后第一个 step 抢跑（pre-step 闸门失效）只读审计

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`，工作副本 `index.js` sha8 **5FF5931A**（1,539,173B / 21,552 行）。
- 真机样本：`~/.dsh/sessions/--E-~5DE5~5177-~5F95~5361~4E00~77AC--/session-1b736c53-7fc7-4be1-a22c-0fa4043c963e/session.v4.jsonl.zstd`（已只读解压核对事件 seq）。
- 只读：未改代码、未构建、未部署、未写数据库。按 CRA 模板：表1 调用链 / 表2 时序竞态 / 表3 边界 / 结论（推荐方案 + 最小 diff + 验证判据）。

---

## 0. 结论（先给判断）

**lead 的「`PENDING_REHYDRATE.set` 登记晚于第一个 pre-step、差约 20ms，且 setTimeout 导致」不是根因。**

- 代码上 `PENDING_REHYDRATE.set` 位于 `session/event` 压缩分支的**同步段**（`index.js#17922`），在 `setTimeout(async...)`（`#17928`）**之前**；它没有 await、没有 setTimeout。
- 真正的根因是 **`agent/pre-step` 瀑布的 handler 顺序**：插件 gate 在 **compaction 触发器之前**执行。gate 检查时 `PENDING_REHYDRATE` 还是空的 → 立即放行 → `next()` 里才跑 compaction（44s）→ compaction/summary 同步派发 `session/event` 才 set pending → 返回后 step 14 直接开始。等下一个 step（15）的 gate 才看到 pending，所以只拦到 step 15。
- 真机事件 seq 直接证明（同一次压缩）：
  - `step/end step=13` seq **66480** 19:09:18.301
  - `compaction/start` seq **66481** 19:09:18.329
  - `compaction/summary` seq **66482** 19:10:02.451
  - `compaction/end` seq **66484** 19:10:02.453
  - `step/start step=14` seq **66485** 19:10:04.981
  - `agent/inbox/spliced`（重灌）seq **66498** 19:10:51.790
  - `step/start step=15` seq **66499** 19:10:51.810
  ⇒ step 14 的 gate 必然在 `compaction/start`(66481) 之前执行；否则它会看到 66482 的 pending。**不是 20ms 竞态，是 44 秒前的顺序问题。**
- **推荐修法 E（顺序无关）**：把 `p4AwaitPendingRehydrate` 从 `next()` **之前**移到 `next()` **之后**，让它返回重灌正文，并把它追加到本次 `decision.messages`（当前请求尾部）；同时给 rehydrate 加 waiter/文本登记，避免与 `agent.inject` 的 next-step 消息重复。A/B/C/D 都只改「标记/登记时点」，不改变 handler 顺序，因此都不能保证 gate 在 compaction 之后执行。
- **附加必须修的点**：`agent-loop` 在 pre-step **开头**就 `claim` 了消息（asar `dsh-agent-loop/lib/index.js#670`），而 rehydrate 走 `agent.inject` → **next-step** inbox（asar `#576-578`）。即使 gate 等到重灌完成，本次 step 的 `claimed` 也可能不含重灌正文；所以「等」不够，必须把正文追加到当前 `decision.messages`（或证明宿主会把 next-step 注入并入当前请求）。本次日志 step 14 的 user/message 序列 66486-66489 里确实没有重灌，重灌直到 66498/66500 才出现，支持该风险。

---

## 1. 表 1 · 调用链与执行顺序

### 1.1 `session/event` 压缩分支（`index.js#17758` 起）

| 顺序 | 位置 | 内容 | 同步/异步 |
|---|---|---|---|
| 1 | `#17758` | `compatOn(ctx,"session/event",(session,event)=>{...})` 同步回调 | 同步 |
| 2 | `#17763` | `p1RecordSessionEvent` 外部事实旁路 | 同步 |
| 3 | `#17768` | `p3OnSessionEvent` 记账/阈值判定 | 同步 |
| 4 | `#17769-17790` | P3 nudge / 阈值检查点 `setTimeout(0)` | 异步 |
| 5 | `#17795-17827` | 文本退化检测（E） | 同步 |
| 6 | `#17828` | `event.type !== "compaction/summary"` 早退 | 同步 |
| 7 | `#17830` | 子代理 session 早退 | 同步 |
| 8 | `#17832-17841` | compactionId 去重、summary 文本提取 | 同步 |
| 9 | `#17849-17863` | P3 阶梯重置、note 提醒清队、cost | 同步 |
| 10 | `#17868` | `parentAttempt = agentsBySession.get(session.id)` | 同步 |
| 11 | `#17869-17882` | `setTimeout(0)`：spawnIntentCheckpoint；内部 `#17878` set `P4C_INTENT_WAIT` | 异步 |
| 12 | `#17884-17888` | `setTimeout(30)`：检查点补火 | 异步 |
| 13 | `#17890-17893` | `setTimeout(0)`：外部事实快照 | 异步 |
| 14 | `#17898-17901` | `setTimeout(10)`：合并维护检查 | 异步 |
| 15 | `#17905-17906` | `agent = agentsBySession.get(session.id)`；无 agent ⇒ else `#18051` 跳过（不登记、不重灌） | 同步 |
| 16 | `#17917` | `targetAgent = agent` | 同步 |
| 17 | **`#17922`** | **`PENDING_REHYDRATE.set(session.id, {compactionId,promise,at})`** | **同步** |
| 18 | `#17928` | `setTimeout(async () => {...})`：事实包/重灌/注入 | 异步 |
| 19 | `#17967-17999` | 该 setTimeout 内**第一个 await**：`Promise.race` 等 `P4C_INTENT_WAIT`（检查点 writer） | 异步 |
| 20 | `#18000` | `await buildPostCompactRehydrate(targetAgent)` | 异步 |
| 21 | `#18038` | `targetAgent.inject(makeMessage(finalNote))` | 同步（在 setTimeout 内） |
| 22 | `#18044-18049` | `finally`：`PENDING_REHYDRATE.delete` + `_p4ResolvePending()` | 同步 |

**关键**：`PENDING_REHYDRATE.set` 是同步段第 17 步，早于 setTimeout；lead 把它归因于 setTimeout 是误判。`P4C_INTENT_WAIT` 的 set 在第 11 步 setTimeout 内（`#17878`），所以重灌要等它，但 gate 的 pending 登记不依赖它。

### 1.2 `agent/pre-step` 侧（插件）

- `index.js#17053`：`compatOn(ctx,"agent/pre-step", async ({agent,messages,step,signal}, next) => { ... })`
- `index.js#17058`：**`await p4AwaitPendingRehydrate(agent, signal);` 在 `next()` 之前**
- `index.js#17059`：`const decision = await next();`
- `p4AwaitPendingRehydrate`（`#15304-15321`）：取 `sid` → `PENDING_REHYDRATE.get(sid)`；**没有记录就 `return`**（`#15308-15309`）；有记录才 `Promise.race(promise, 120s timeout, signal)`（`#15311-15318`）；日志 `rehydrate pre-step-gate ... waited=...`（`#15319`）。

### 1.3 宿主 `agent/pre-step` 瀑布顺序（asar）

- `@deepseek-ai/dsh-agent-loop/lib/index.js#666-713`：
  - `#670` `const claimed = this.inbox.claim(target, position.turn);`（**先 claim**）
  - `#685` `await this.dispatch.waterfall("agent/pre-step", {messages: claimed, ...}, () => {...})`
  - `#757` `this.session.append("step/start", {turn, step});`（**pre-step 返回后才 step/start**）
- `@deepseek-ai/dsh-compaction-basic/lib/index.js#839-852`：
  - 注册 `ctx.on("agent/pre-step", async ({agent,signal}, next) => { ... await this.compactIfNeeded(agent,"pressure",signal); ... return next(); })`
  - 即 compaction 在 **自己的 handler 内、`next()` 之前**执行。
- `@deepseek-ai/cordis/lib/types/events.js#124-147`：waterfall 按注册顺序 **outermost-first**；`#149-155` `register` 默认 `push`。**谁先注册，谁先跑**。
- `@deepseek-ai/dsh-compaction-basic/lib/index.js#450-486`：`compactSurfaceRegion` 在 `#469` append `compaction/start`，`#482` `commitCompactionBody`（内部 `#628-661`：`#634` append `compaction/summary`，`#650` append checkpoint user/message），`#484` append `compaction/end`。
- `@deepseek-ai/dsh-session/lib/index.js#1589-1601`：`session.append` 在 `commit` 内**同步**调用 `session/event` observers（`#1601`）。

**顺序结论**：
- 如果 compaction-basic 的 pre-step handler 先注册（在插件 gate 之前），compaction 先跑，summary 同步 set pending，再 `next()` 进插件 gate → gate 会等 → 正常。
- 如果插件 gate 先注册，gate 先检查（pending 为空）→ `next()` 才跑 compaction → summary set pending → 返回 → step 开始 → **抢跑**。
- 本机样本属于后者：step 14 的 gate 必然在 compaction/start(seq 66481) 之前；否则会看到 66482 的 pending。
- 该顺序由**服务激活时序**决定，不由 bundle 行序保证（`dsh-base/cordis.patch.yml` 头部明确「Row order carries no load semantics (activation is service-availability driven)」）；所以这是**顺序依赖**问题，不是 20ms 随机竞态。

---

## 2. 表 2 · 时序竞态（真机日志 → 代码）

| 时间/seq | 事件 | 代码对应 | 说明 |
|---|---|---|---|
| 19:09:18.301 / 66480 | `step/end step=13` | `agent-loop#781` | 上一 step 结束 |
| 19:09:18.329 / 66481 | `compaction/start` | `compaction-basic#469` | step 14 pre-step 内、插件 gate 之后（若插件先注册） |
| 19:10:02.451 / 66482 | `compaction/summary` | `compaction-basic#634` | `session/event` **同步**派发；插件在 `#17922` set PENDING |
| 19:10:02.453 / 66484 | `compaction/end` | `compaction-basic#484` | compaction 完成 |
| 19:10:04.981 / 66485 | `step/start step=14` | `agent-loop#757` | gate 早已在 19:09:18 之前检查过（pending 空），未等待 |
| 19:10:04.993 / 66489 | `user/message` plugin | — | step 14 的请求消息；**没有重灌正文** |
| 19:10:28.349 / 66492 | `assistant/message step=14` | — | 在旧记忆上跑完（用户观察） |
| 19:10:29.332 / 66497 | `step/end step=14` | — | — |
| 19:10:51.790 / 66498 | `agent/inbox/spliced`（重灌） | `index.js#18038` | 此时才注入 |
| 19:10:51.810 / 66499 | `step/start step=15` | — | step 15 的 gate 在 19:10:29→51 等待了 22.4s（monitor） |
| 19:10:58.374 / 66501 | `assistant/message step=15` | — | 第一次吃到重灌 |

**因果链**：gate（step 14 pre-step）→ 空 pending → 放行 → `next()` 内 compaction → summary 同步 set pending → 返回 → step 14 start（不等待）→ 重灌 setTimeout 等 writer 46s 后注入 → step 15 gate 才等到。

---

## 3. 表 3 · 边界与异常

| 场景 | 行为 | 风险/结论 |
|---|---|---|
| ① 压缩后 0ms 就来 step | 与本次相同：gate 先于 compaction，必抢跑（当前顺序） | 结构性失败，不是偶发 |
| ② 压缩与 step 同毫秒 | `session/event` 同步派发；若 compaction handler 在 gate 之后，仍抢跑；若在前，gate 等 | 取决于 handler 顺序，不取决于毫秒差 |
| ③ 多会话同时压缩 | `PENDING_REHYDRATE` 按 sid 隔离；各会话独立 gate | 无串扰；子代理在 `#17830` 被排除 |
| ④ 闸门登记失败（catch `#17927`） | 无 pending；rehydrate 仍会在 setTimeout 中尝试（若 agent 可用）；step 不等待 | 退化为旧行为；应 cwarn/monitor 留痕 |
| ⑤ 重灌超时（`#17967-17999` 120s） | finally `#18044-18049` 必 delete+resolve；gate 的 120s race 也会放行 | 若 setTimeout 回调未跑到 finally（进程/异常），pending 可能长期存在；后续每个 step 都可能再等 120s（见 §7 护栏） |
| ⑥ 无 agent（`#18051`） | 不登记 pending、不重灌；无 gate | 不会抢跑（没有重灌可等）；但也不会有重灌 |
| ⑦ 手动 compaction（`compactNow` #1002-1024，runMaintenance idle） | pending 在 compaction 内 set；下一次 pre-step 在 compaction 之后才跑 → gate 能看到 | 一般正常；若手动压缩与 turn 边界重叠需另测 |
| ⑧ context-overflow / model-switch（`compaction-basic#856-890`，`agent/request` 内） | 在 pre-step 之后才压缩；第一个请求可能已发出/失败，pending 对下一次 pre-step 生效 | 另一条可能窗口；本 bug 只解决 pre-step pressure 路径 |

---

## 4. 八项逐条回答

1. **调用链**：见 §1。`session/event` 压缩分支**全同步到 `PENDING_REHYDRATE.set`**（`#17922`）；第一个 await 在 setTimeout 回调里的 `#17980`（等 `P4C_INTENT_WAIT`）；`PENDING_REHYDRATE.set` 在 `#17928` 之前。`p4AwaitPendingRehydrate` 挂在 `agent/pre-step` handler（`#17053-17059`），对**所有 agent** 调用（无顶层过滤），但 pending 只对顶层会话登记（`#17830` 排除子代理）；无记录立即返回（`#15308-15309`）。**真正顺序问题**：插件 gate 与 compaction-basic 的 pre-step handler 谁先注册；本机样本中 gate 在前。
2. **状态交互**：
   - `PENDING_REHYDRATE`（`#15302`）：sid → {compactionId, promise, at}；**闸门本身**；rehydrate finally 删除并 resolve（`#18044-18049`）。
   - `P4C_INTENT_WAIT`（`#15650`）：sid → 本次检查点写入 Promise；在 `setTimeout(0)` 内 set（`#17878`），被 rehydrate 的 setTimeout 等待（`#17967-17999`），finally delete（`#17992`）。**不是闸门**，是「等 writer」。
   - `R2_WAIT_STATE`（`#15654`）：`/dsh-memory/wait.json` 的 UI 状态（`#12645-12655`）；rehydrate 等待时打亮（`#17973-17989`）。**不是闸门**。
   - pre-step 时 `PENDING_REHYDRATE` 无记录 ⇒ `p4AwaitPendingRehydrate` 直接 return（`#15308-15309`），没有同步标记、没有轮询。
3. **线程/时序**：`session/event` 在 `session.append` 发布窗口内**同步**派发（asar `dsh-session#1589-1601`）；`step/start` 在 pre-step waterfall **之后**（asar `dsh-agent-loop#757`）。`setTimeout(0)` 只影响注入/检查点调度，不影响 `PENDING_REHYDRATE.set`；本次 20ms 是日志观感，不是登记延迟。真正的时序是：gate（step 14 pre-step 开始）→ compaction/start → summary set pending → step 14 start。
4. **正确性/其他窗口**：
   - 自动 pressure compaction：若 compaction handler 在 gate 之后，必抢跑（本机样本）。
   - 手动 `compactNow`（`compact-basic#1002-1024`）：在 idle maintenance 中执行，pending 在 compaction 内 set；下一次 pre-step 在 compaction 之后，gate 能看到，一般正常。
   - context-overflow / model-switch（`compact-basic#856-890`，`agent/request` 内）：压缩发生在 pre-step 之后；第一个请求可能已经发出/失败；pending 对下一次 pre-step 生效，属另一条窗口，建议单独回归。
   - 并发会话：sid 隔离；子代理排除；无重入（set 同步，inject 在 setTimeout）。
   - 无 agent：`#18051` 分支不登记；不会抢跑（没有重灌）。
   - `PENDING_REHYDRATE.set` catch：静默退化；应补日志。
5. **边界**：见 §3（①-⑧）。
6. **方案对比**：
   - **A 把 `PENDING_REHYDRATE.set` 提到压缩分支最外层同步段**：**它已经在同步段**（`#17922` 在 `#17928` 之前）；再提也不会改变 gate 与 compaction 的 handler 顺序；**无效**。
   - **B pre-step 查同步标记 + 轮询等登记**：标记最早只能在 `compaction/start`/summary 时写入，而 gate 在 compaction 之前就检查了；标记不存在，轮询只能等「未来事件」，无法弥补已经放行的 gate；还增加热路径开销。
   - **C 改挂 `compaction/start` 登记**：`compaction/start` 在 compaction 内部（`compact-basic#469`），若 compaction 在 gate 之后，它仍在 gate 之后；**无效**。
   - **D pre-step 判断「最近 N 秒压缩过」+ 短 promise**：gate 时压缩尚未发生，没有「最近压缩」标记；**无效**（除非用上一次压缩的陈旧标记，会误等/误判）。
   - **推荐 E（顺序无关）**：把 gate 移到 `next()` **之后**，并让 `p4AwaitPendingRehydrate` 返回重灌正文，把正文追加到本次 `decision.messages`（见 §5）。这样无论 compaction handler 在 gate 前/后，`next()` 返回时 compaction 已发生、pending 已登记；等待发生在请求发出前；正文进入当前请求。
   - 备选 E2：用 `ctx.inject(["compaction"], ...)` 把 gate 注册到 compaction 服务就绪之后（期望成为下游 handler）。依赖激活顺序，较脆弱，不如 E。
7. **护栏**：
   - 一次性/必清/必 resolve：`PENDING_REHYDRATE` 的 finally 已有 delete+resolve（`#18044-18049`）；新增 gate 等待不能吞掉异常。
   - 防悬挂：gate 的 120s race 必须 `clearTimeout`；若 gate 超时，给 rec 打 `gateTimedOut`，后续 step 不再重复等 120s；rehydrate 最终仍要 resolve/delete。
   - 日志带 `waited` 与 sid：已有 `#15319`；建议再加「gate-after-next / gate-before-next」与 `compactionId`。
   - 去重：E 方案中 `agent.inject`（next-step）与 `decision.messages` 追加可能重复；用 `waiters` 计数或「已追加标记」避免下一 step 再吃一遍。
   - 不阻塞启动/不写记忆库/失败静默：保持现有 try/catch；gate 只在有 rec 时等待；无压缩会话零开销。
8. **影响面**：
   - 热路径：当前 `p4AwaitPendingRehydrate` 每个 step 都调用，无 rec 时仅 `String`+`Map.get`+立即 return；开销可忽略。B/D 的轮询会明显增加热路径，不推荐。
   - 从未压缩的会话：无 rec，零等待；无额外 Promise（除非有 pending）。
   - 前缀缓存：gate 等待不改上下文；重灌/追加是压缩后一次性尾部注入，不改稳定层；E 的 `decision.messages` 追加只影响当前请求尾部（与 A 类提醒同机制），不破坏已缓存前缀。
   - 多会话：按 sid 隔离；不影响其他会话。
   - 启动/命令表：无影响。

---

## 5. 推荐方案（E）与最小 diff

### 5.1 方案 E：post-`next()` gate + 当前请求追加

**为什么**：`agent-loop` 在 pre-step 开始就 claim（asar `#670`），rehydrate 走 `agent.inject` → **next-step**（asar `#576-578`）；只在 `next()` 前等，即使等到，本次 `decision.messages` 可能仍不含重灌（本次日志 step 14 的 66486-66489 没有重灌）。因此：

1. 把 `p4AwaitPendingRehydrate` 移到 `const decision = await next();` **之后**（或同时保留一个前置快速检查，但以后置为准）。
2. `p4AwaitPendingRehydrate` 返回 `{ waited, text }`：rehydrate 构建完成后把 `rehydrate.text` 存到 rec 并 `_p4ResolvePending(text)`；gate 返回该 text。
3. 若 `decision.kind === "enter"` 且 text 非空且当前 `decision.messages` 未包含该 text（防重复），返回：
   ```js
   return { ...decision, messages: [...(decision.messages || []), makeMessage(text)] };
   ```
4. 可选：给 `PENDING_REHYDRATE` rec 加 `waiters` 计数；rehydrate 回调若 `waiters>0` 则**跳过** `targetAgent.inject`（由 gate 追加到当前请求），否则保留现有 `agent.inject` 作为无 gate 时的兜底；避免下一 step 重复。
5. gate 超时/失败：记录 `gateTimedOut`，不重复等；`finally` 清理。

### 5.2 最小 diff（按位置）

- `index.js#15304-15321`：`p4AwaitPendingRehydrate` 改为返回 `{waited,text}`；`Promise.race` 结果取 promise resolve 的 text；`clearTimeout`；`rec.gateTimedOut` 后直接 return；保留 monitor 日志。
- `index.js#17058-17059`：把 `await p4AwaitPendingRehydrate(...)` 从 `next()` 前移到 `next()` 后；对 `decision.kind==="enter"` 追加 `makeMessage(text)`（检查重复）。
- `index.js#17918-17927`：rec 增加 `text`、`waiters`、`gateTimedOut` 字段。
- `index.js#18000-18038`：构建成功后写 `rec.text`；`_p4ResolvePending(rehydrate.text)`；若 `rec.waiters>0` 可跳过 `agent.inject`（或保留并去重）。
- `index.js#18044-18049`：finally 保持 delete+resolve；若已 resolve 也幂等。
- 不需要改 compaction-basic/DSH；无需改客户端；无 DB 迁移。
- 部署：`index.js` 复制到 `~/.dsh/profiles/web/plugins/memory/index.js`（desktop/web 共用），重启 DSH；发布走 `node tools/sync-payload.mjs` + 安装器。

**不推荐**只把 gate 移到 `next()` 后而不追加正文：那只会把 step 14 延迟到重灌完成，但当前请求仍可能是旧上下文；必须验证/追加。

---

## 6. 验证判据（可执行）

1. **事件 seq/时间**（用同一 session.v4.jsonl.zstd 解压后按 `seq`/`time` 排序）：
   - 找到 `compaction/end` 的 seq `E` 和其后第一个 `step/start` 的 seq `S`。
   - 找到重灌注入事件：`agent/inbox/spliced` 中 inserted 文本含 `【压缩后记忆重灌` 或 `【dsh-memory 记忆刷新提示】` 的那条，记 seq `R`。
   - **修复后必须** `E < R < S`（且 `time(R) ≤ time(S)`）；当前 bug 样本是 `E=66484 < S=66485 < R=66498`，即 `R > S` ⇒ FAIL。
   - 当前样本可用于回归：修复后重跑一次压缩，要求第一个 post-compaction step 的 `S` 出现在 `R` 之后。
2. **插件日志**：第一个 post-compaction step 出现 `rehydrate pre-step-gate ... waited=...`（不是第二个 step 才出现）；`压缩后记忆重灌已构建` 时间早于该 step 的 `step/start`。
3. **模型可见性**：该 step 的请求消息（session 日志 `user/message`/`request/context` 或模型输出）包含重灌块 head（`【压缩后记忆重灌` / `【外部事实包`）；若 E 方案用 `decision.messages` 追加，日志里可能没有 session event，需要加一条 debug 日志 `gate-append sid/compactionId/chars` 或检查 request 消息。
4. **不重复**：下一 step 不应再收到同一重灌块的第二份（检查 `agent/inbox/spliced` 次数与 user/message 内容；E 的 waiters 方案应只有当前 step 一份）。
5. **无压缩会话**：任意普通 step 的 gate 日志不应出现 waited；`PENDING_REHYDRATE` 不增长（可加 debug 计数）。
6. **超时路径**：人为让 writer 超 120s（或 mock），确认 gate 只等一次、finally 必 resolve/delete、会话不被永久卡住。

---

## 7. 必然复现还是竞态？

- **不是 20ms 随机竞态**。`PENDING_REHYDRATE.set` 是同步的（`#17922`）；样本中 step 14 的 gate 必然在 `compaction/start`(66481) 之前，否则会看到 66482 的 pending。即 **handler 顺序**导致：当前顺序下，**每次自动 pressure compaction 在同一个 pre-step 内触发时，第一个 step 都会抢跑**（结构性/必然）。
- 但 handler 顺序由服务激活时序决定，不由 bundle 行序保证（`dsh-base/cordis.patch.yml` 头部注释）；换 profile/版本/加载顺序可能翻转，因此**跨环境可能时好时坏**。修复应做成**顺序无关**（E），不要依赖「谁先注册」。
- 需要确认本机顺序的最终证据：可在 gate 与 compaction handler 各加一行 `clog`（临时分支）或用 cordis inspector 打印 `agent/pre-step` hooks 顺序；本次用事件 seq 已足以证明 gate 在 compaction 前。

---

## 8. 诚实缺口

1. 未改代码、未跑修复后真机；E 方案的具体 API 改动（返回 text、waiters、append messages）需实现后按 §6 验证。
2. handler 注册顺序未用 inspector 直接读取；结论由事件 seq（step14 start 在 compaction/summary 之后且 gate 未等待）+ cordis waterfall 顺序语义推断，属**高置信推断**。
3. `agent.inject` next-step 与当前 `claimed` 的包含关系存在代码/日志的表面矛盾：代码显示 claim 在 waterfall 前（`agent-loop#670`），日志显示 step15 在 gate 等待后拿到了重灌；本报告按「必须显式追加到 decision.messages」的保守方案处理，未逐行证明宿主是否会把 next-step 注入并入当前请求。
4. 未验证手动 compaction / context-overflow 路径；§3⑦⑧ 为代码推断。
5. 未跑 120s 超时/异常注入的故障注入；护栏建议为代码审查结论。
6. 真机样本只有一次压缩（seq 66480-66501）；「每次必然」是顺序推断，建议修前在临时分支加顺序日志再压一次确认。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
