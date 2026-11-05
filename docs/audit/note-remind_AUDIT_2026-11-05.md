# CRA 审计：`memory_note` 按上下文占用每 15% 提醒 + 压缩后重注入

- **审计对象**：`E:\工具\插件开发调整\dsh-memory-plugin\index.js`
- **审计时 sha256**：`BC1A6C9F255C490E354C96002664C4C0B477D331D42A92B9C7FF24FB1D76C3BE`（前 8 位 `BC1A6C9F`，与任务书一致）
- **行数**：20437（`[System.IO.File]::ReadLines` 计数）
- **改动点**：L1861-1903（常量/Map/check/reset/text）、L4962-4970（`p3OnSessionEvent` 调用点）、L17005-17007（压缩点重置）、L14633-14638（重灌块 head 新增一行）、L5692-5693（测试导出）
- **审计方式**：只读。重跑了 `test/_note-remind-selftest.mjs`（22/22）与 `_verify/_q-turn-density.mjs`；另用只读脚本（临时目录，不落仓库）扫描了 33 个真实会话日志（121,401 条 `assistant/message` usage 样本、466 条 `compaction/summary`）做语义核验。
- **审计时间**：2026-11-05 13:15–13:35（Asia/Shanghai）

---

## 结论先行

**PASS-with-findings**（可上，但有 3 条中severity finding 建议在重启前处理；无高严重度缺陷落在主路径上）。

一句话：**机制本身（跨档单调 + 冷却 + 压缩重置 + 复用回归队列尾部注入）在正常路径上是正确的**；风险不在「算错档」，而在**产出物预算**（重灌块 +109 字把「四段齐全」从「刚好放得下」推到「必然丢画像段」）、**队列生命周期**（压缩后残留的旧档位文案会带过期百分比注入）、以及**档位消费与投递解耦**（入队即记账，投递失败则静默丢一档）。

- 核心功能（记忆读写 / 检查点写入 / 压缩重灌主链）：**未破坏**（唯一实际影响 = 重灌块 head 变长 109 字，见 M1）
- 相关子系统（T1 阈值 / 回归提醒队列 / 前缀缓存 / 消耗记账）：**有交互**（队列争用、记账漏计，见 M2/M6）
- 性能 / 启动：**无实质影响**
- 数据一致性：**双状态所有者**（易失 Map + 持久化 p3 状态）会在重启后分叉（见 M5）

---

## 表 1 调用链与语义（含可疑点）

| # | 链路 | 证据（`index.js#行号`） | 语义 / 结论 | 可疑点 |
|---|---|---|---|---|
| 1.1 | `session/event` handler → `p3OnSessionEvent` | L16911（handler 注册）、L16921（调用，`try/catch` 包住） | 同步回调；放在压缩事件早退（L16981）**之前**，所以能收到全部 `assistant/message` | 无 |
| 1.2 | `p3OnSessionEvent` → `noteRemindCheck` | L4948（`assistant/message` 分支）→ L4954（`total` 计算）→ L4964-4970 | 仅在 `event.data.usage` 存在时判定；`total = Number(u.totalTokens) || (in+out+cache)` | `totalTokens` 含 output，会让 15% 提前不到 1 个百分点（可忽略） |
| 1.3 | `noteRemindCheck` 实现 | L1873-1893 | 纯内存、try/catch 永不抛；`ratio = t/838860`；`lvl = floor(ratio/0.15)`；`lvl<=st.level → null`（单调）；60s 冷却；返回 `{level, ratio%}` | 见 1.7 / 表3-⑤ |
| 1.4 | 命中 → `enqueueRegressionReminder(sid,"note-remind",text)` | L4967；入队实现 L2326-2332 | 同步 push 到 `REGRESSION_QUEUE`（L1860），**无长度上限**、异常吞掉 | **无 TTL、无去重、无 generation**（M2） |
| 1.5 | 消费方（哪个 pre-step handler） | L16355-16382（`compatOn(ctx,"agent/pre-step", async …)`）；`peek` L16365 → 闸门 L16362/L16366/L16373 → `dequeue` L16374 → 追加 messages L16377-16378 | 决策直入当轮请求尾部（不进会话历史 ⇒ 前缀缓存安全）；**每 step 只消费队头 1 条** | 与 E/D/W/PL 信号**共用同一 FIFO**；note 排在前面会把 E/D 提醒推迟一步（M2） |
| 1.6 | `noteRemindText` 还有别的调用方吗 | 全仓 grep：定义 L1897；**唯一调用 L4967**；导出 L5693 | 重灌块 head 的 note 引导是**另写的字符串字面量**（L14637-14638），不调用 `noteRemindText` | 文案两处独立维护，改一处会漂移（低） |
| 1.7 | 两套状态会不会互相干扰 | `REGRESSION_QUEUE` L1860 / `noteRemindState` L1871 | 两者键都是 sid，语义不同（队列=待投递，Map=档位）；note 不用 `REGRESSION_AT`（L1857）退避桶 ⇒ **不共享退避状态**，无互相污染 | 队列侧：note 与 E/D 争用（M2）；Map 侧：与 `p3SessionState` 双所有者（M5） |
| 1.8 | `p3OnSessionEvent` 谁调 | 唯一调用点 L16921（grep 确认） | 返回 `{kind:"nudge"}` / `{kind:"threshold"}` 由 handler L16922-16943 消费；note 分支**不 return**，与 T1 并列（L4962 注释 vs L4971 实际代码一致） | 若同一事件既命中 note 又命中 T1：note 已先入队（L4967 在 L4971 之前），T1 `return`（L4988）不会吞掉它 ✓ |
| 1.9 | 压缩点重置 | L17002-17009；`noteRemindReset` L17007 | 与 `p3st.fired = resetAfterCompact()`（L17004）同一 try 块；`noteRemindReset` 自身 try/catch | **只在 `compaction/summary` 且通过 L16987-16994 全部早退闸后才重置**；`compaction/prune`（实测 1428 次）不重置 —— 这是对的（prune 非整轮压缩），但队列不重置（M2） |
| 1.10 | 子代理判定 | L4938 `isSub = session.header && session.header.origin === "subagent"`；L4961 `if (!isSub)` | 主/子分流与 T1 同款 | `isTopLevelSession`（L12221-12230）有 `rootSessionId` 兜底，这里**没有** ⇒ header 缺失的未标记子代理会走主会话分支（与 T1 同款既有缺口，M8） |

**调用链结论**：链完整、可达（`session/event` → `p3OnSessionEvent` → 入队 → `agent/pre-step` 消费），无「写了没人读」；`noteRemindText` 单一调用方已核实。唯一反直觉点是 **note 提醒没有自己的投递通道**，完全寄生在「回归提醒队列」上，因而继承了它的三个特性：**共用配置开关**（`regressionEnabled`，L16362）、**共用插件子代理闸**（L16366）、**共用队头单条消费节奏**。

---

## 表 2 状态 / 线程竞态（风险等级 + 护栏）

| # | 竞态/状态交互 | 证据 | 风险 | 护栏（现状是否落实） |
|---|---|---|---|---|
| 2.1 | `session/event` 同步派发 vs `enqueue` 同步入队 vs `pre-step` 异步消费 | L16911/L2326/L16358 | **低** | JS 单线程：`peek`→闸门→`dequeue`（L16365-16374）之间**无 await**，不会出现「peek 后被人插队」。✅ 已由语言模型保证 |
| 2.2 | 入队后会话立即结束 / 切换 / abort | `clearRegressionQueue` 只被 `guardClear`（L12947）调用，`guardClear` 只服务**插件子代理看护** | **中** | ❌ **主会话队列没有任何清理点**（turn end / abort / 会话销毁都不清）。note 文案里带 `上下文已用约 N%` ⇒ 隔很久/压缩后才注入 = **过期百分比误导**（M2） |
| 2.3 | 压缩与提醒同时发生 | 压缩重置 L17007；队列无重置 | **中** | ❌ 压缩前入队的 note-remind 在压缩后仍会注入，文案仍是压缩前的高百分比；且重灌 head 已带 note 引导（L14637）⇒ 同轮/邻轮**双提醒**（M2/M10） |
| 2.4 | `noteRemindState` vs `p3SessionState`（既有 sessions 状态） | L1871 vs L4895-4903 | **中低** | 压缩时**两处都重置**（L17004 + L17007）✅；但两者**持久性不同**：`p3` 段经 `scheduleMonitorSave`（L4837-4849）落 `.monitor.json`，`noteRemindState` 是纯内存 ⇒ 重启后分叉（M5） |
| 2.5 | **还有没有第三个状态需要同步重置？** | 逐项核：`st.fired`✅(L17004)、`noteRemindState`✅(L17007)、`st.turn`/`st.lastNudgeTurn`（R3 每 8 轮，L5000-5012）**不重置**、`st.lastFireAt`（L17001 注释明确**刻意保留**）、`REGRESSION_QUEUE`**不重置**、`REGRESSION_AT`（note 不用）、`PENDING_REHYDRATE`（finally 必清 L17190-17195）、`POST_COMPACT_REHYDRATE_IDS`（per compactionId） | **中** | 结论：**需要同步的只有 `REGRESSION_QUEUE` 里的 note 条目**（当前没做）；`turn/lastNudgeTurn` 属轮次语义，不需重置；`lastFireAt` 保留是设计意图 |
| 2.6 | 多会话并发串号 | 键一律 `String(sid)`（L1875/L1881/L1895），Map 按 sid 隔离 | **低** | ✅ 无跨会话共享；`String(sid||"")` 归一化一致。唯一风险是 sid 复用（DSH 不复用 session id） |
| 2.7 | 500 上限淘汰顺序 | L1887-1890 `keys().next().value` | **低** | 淘汰 = **最早插入**（`Map.set` 对已存在键不改插入序 ⇒ 不是 LRU）。活跃长会话若被淘汰 → 档位归零 → 重复提醒（M5） |
| 2.8 | 死代码/未使用 | `noteRemindState` 只在 L1881/L1886/L1888-1889/L1895 使用 | **低** | ✅ 无泄漏路径；`export` 只给测试 |

**线程/并发结论**：不存在真正的数据竞争（同步回调 + 单线程 + 无 await 窗口）。真正的问题是**生命周期**：note 条目进了队列之后**没有任何失效机制**（无 TTL、无 generation、无压缩清理），会跨压缩/跨 turn/跨会话空闲存活。`REGRESSION_QUEUE` 本身也没有长度上限（既有问题，note 是新增生产者）。

---

## 表 3 边界场景（会发生什么 + 兜底）

| # | 边界 | 证据/实测 | 会发生什么 | 兜底（现状） |
|---|---|---|---|---|
| ① | 非法 `totalTokens`（NaN/负数/0/超大） | L1877 `!Number.isFinite(t) || t<=0 → null`；selftest B7-B10 | NaN/负/0 → 静默不提醒 ✅。**超大**（如 1e12）→ `lvl≈7947`，文案会写「第 7947 档」 | 只影响文案，不影响功能；无上限钳制（低） |
| ② | 子代理会话 | L4938/L4961 | `origin==='subagent'` → 不提醒 ✅（与 A 类闸一致）。**header 缺失**的未标记子代理 → 会当主会话（M8） | 与 T1 同款既有缺口；插件自己 spawn 的子代理还有 L16366 的 PL 闸兜底 |
| ③ | 同一轮多次 `assistant/message`（重试/多 attempt） | L4964 每事件都判 | 同一 `totalTokens` → 同一档 → 单调闸挡掉 ✅；重试 usage 更大 → 可能提前一档（无害）；60s 冷却再兜一层 | ✅ 已落实 |
| ④ | 压缩与提醒同时发生 | 表2-2.3 | 旧档位提醒残留 + 重灌 head 双提醒（M2/M10） | ❌ 无 |
| ⑤ | 进程重启（Map 丢失） | L1871 纯内存 | 档位归零 → 下一条 `assistant/message` 若上下文已 ≥15% **立刻补一次当前档**（e.g. 80% → 「第 5 档」）。属「重复一次」而非「丢档」 | 可接受；但 `p3` 状态是持久的 ⇒ 两状态不一致（M5） |
| ⑥ | `noteRemindState` 500 淘汰 | L1887-1890 | 淘汰最早插入的 sid（非 LRU）→ 该会话档位归零 → 重复提醒一次 | 500 会话内基本不触发（低） |
| ⑦ | 时钟回拨 | L1883-1884 `now - st.lastAt < 60000` | 回拨期间差值负 ⇒ 一直判「冷却中」，**该档静默丢失**（`st.level` 已在 L1885 写入） | 与 `p3-triggers.js` L52 既有口径一致（「时钟回拨按冷却期内处理」），非新增缺陷；但 note 侧无补偿（M3） |
| ⑧ | 边界整点（ratio 恰 15%/30%/…/90%） | 实测（node 计算）：`t=125829→lvl=1`、`251658→2`、`377487→3`、`503316→4`、`629145→5`、`754974→6`；`t-1` 各低一档 | **无 off-by-one** ✅（`838860*0.15=125829` 整，且 `ratio/0.15` 双精度恰为整数） | 依赖「阈值是 838860 且步进 0.15」的浮点巧合；改常量时需重测（低） |
| ⑨ | ratio > 100% | 实测 121,401 条样本 `max totalTokens=839834`（100.12%） | `lvl=6`，不会到 7（需 ≥880,803 ≈105% 才会到 7）；宿主在 838860 附近就压缩，实际到不了 | ✅ 经验上「每周期 6 档」成立 |
| ⑩ | 压缩后 totalTokens 骤降 | 实测：550,701→244,651；799,260→37,284；770,679→105,644 | 重置后下一轮 ratio 可能直接 ≥15% ⇒ **压缩后第一条消息就补一次第 1 档**（设计如此）；**不会**把「降档」误判为跨档（`lvl<=st.level → null` 只认严格上升）✅ | ✅ 单调闸正确 |
| ⑪ | 压缩事件被早退闸挡掉（无 summary/空 blocks/重复 id） | L16987-16994 | `noteRemindReset` 不执行 → 档位停留在压缩前最大值 → 直到上下文重新涨过旧档才恢复提醒 | 实测 466/466 条 summary 非空、无缺 compactionId ⇒ 风险很低；但 `compaction/start`(494) vs `summary`(466) 有 28 条差（多为日志尾部未结算），值得记录 |
| ⑫ | `compaction/prune`（非整轮压缩，实测 1428 次） | 事件类型实测存在 | 不重置档位（正确）；但会掉 totalTokens（实测 551,285→510,871）⇒ 单调闸使下一档要多涨 5% | 可接受；建议在注释里写明「prune 不掉档」 |

---

## 观测门

### G-0：实现前是否观测过？——**部分支撑，不足以单独支撑「15%」这个数**

- 证据存在且可复现：`_verify/_q-turn-density.mjs`（L27-38）我重跑，输出与任务书一致：**中位数 2.3 轮/时、压缩间隔 10.86h、30 轮 ≈ 13.2h**。
- 这个观测**能支撑**的结论：①「每 30 轮」= 13.2 小时，作为提醒频率等于没有（否决旧方案成立）；②轮次密度低 ⇒ 按轮次/按时间的提醒都不合适；③上下文占用是更自然的度量（与 token 消耗挂钩、长短会话自适应、压缩后归零）。
- 这个观测**不能支撑**的结论：
  1. **为什么是 15% 而不是 10%/20%**——没有任何「note 该多密」的实测（缺一个「每个 15% 区间里实际发生了多少值得记的事」的样本统计）。
  2. **「每压缩周期 6 次 × ~70 字 ≈ 420 token」的成本口径**：实测 `noteRemindText` 长度 **188 字**（内文 151 字），6 次 ≈ **1128 字**，是注释声称的 **2.7 倍**（量级仍可忽略，但注释失真，M6）。
  3. **「每周期 6 次」是上界不是典型值**：只有上下文真的涨到 90% 才有第 6 档；不少会话在 50-70% 就结束/压缩（实测样本里也有 `max totalTokens` 远低于 838860 的会话）。
  4. **10.86h 中位数含跨天 idle**（样本会话跨度最长 728h）⇒ 真实「活跃压缩间隔」更短；方向不变，但「摊到 10.86h」的成本分母偏乐观。
- 我补的只读观测（支撑实现假设，非实现者原证据）：
  - `totalTokens = inputTokens + outputTokens + cacheReadTokens`（实测 1600+1747+537856 = 541203，逐位相等）⇒ **确实是「每轮上下文快照」**，不是累计。
  - 宿主压缩阈值 ≈ 838860 成立：121,401 条样本 `max totalTokens = 839834`（恰好贴着 838860 上方一点点）。
  - 压缩后上下文确实骤降（550k→244k / 799k→37k），所以「压缩后重置」这个设计点是对的。

### G-9：产出物判据——**会改字节，且有一个既有不变式被压破**

| 产出物 | 是否变化 | 证据 | 判据/验证命令 | 期望 vs 实测 |
|---|---|---|---|---|
| 压缩后重灌块 `head` | **是（+109 字）** | L14633-14638；实测 head 97→206 字 | 见下方 one-liner | 4 段饱和：**6093（旧，余 7 字）→ 6202（新，超 102 字）** ⇒ `profile` 段被整段砍掉 |
| 重灌块 `R2_TOTAL` 收口 | 语义未改（仍是 6100），但**余量被吃掉** | L14641-14680；L14446 预算 `{2400,1150,350,1900}`=5800 + 装配容差 300 | 同上 | 新装配开销 = head 206 + 段头 184 + 分隔符 12 = **402 > 300** ⇒ 注释 L14443-14445「四段全满也放得下」**已失真** |
| 既有注入（记忆刷新提示 / 外部事实包） | 否 | L17053-17057 / 事实包链路未动 | — | 无变化 |
| `REGRESSION_QUEUE` 既有回归提醒 | **有交互** | 共用 L1860 队列 + L16358 队头单条消费 | — | note 条目排在前面时，E/D 提醒**推迟一步**；队列无上限 ⇒ note 不挤掉，但会插队（M2） |
| `accept-p4` 门是否失真 | **门没失真，但有覆盖洞** | `test/_accept-p4.mjs` L52-55（`R2_BLOCK_TOTAL = 5800+300 = 6100`）、L374-375（B6 `blockLen ≤ 6100`）、L380-381（B10 `dropped` 不含 profile/project/checkpoint） | `node test/_accept-p4.mjs` | **该门只造 3 段（checkpoint/project/profile），从不造 note 段** ⇒ 4 段饱和场景**永远测不到**，B6/B10 会继续绿；`M7` 对 6000 硬线也只是 WARN |

**可执行验证命令（只读，不写仓库）**：

```bash
# 1) 4 段饱和预算判据（当前应 FAIL：6202 > 6100）
node -e "const fs=require('fs');const s=fs.readFileSync('index.js','utf8');const i0=s.indexOf('const head = \"【压缩后记忆重灌');const head=eval(s.slice(i0+13,s.indexOf(';\n',i0)));const H={cp:'【检查点续接（本次压缩 · 本会话）】\n※ 本段是压缩**之后**的状态；与上方压缩摘要冲突时**以本段为准**（尤其「下一步行动」「未决问题」——那是用户最新的意思）',pj:'【项目记忆（某项目显示名xxxxxxxxxxxxxxxxxxxxxx）】',pf:'【用户画像（global.md）】',nt:'【会话笔记（本会话 · 主 agent 自己记的，共 12 条，此处只注最近 10 条）】'};const B=[2400,1150,350,1900];const segs=[['cp',H.cp],['pj',H.pj],['pf',H.pf],['nt',H.nt]];const t=head+'\n\n'+segs.map((x,i)=>x[1]+'\n'+'x'.repeat(B[i])).join('\n\n');console.log('total='+t.length+' cap=6100 '+(t.length<=6100?'FIT':'OVER by '+(t.length-6100)))"
# 期望：FIT（修好后）。当前实测：total=6202 OVER by 102

# 2) note 提醒门（应 22/22）
node test/_note-remind-selftest.mjs

# 3) 既有 P4 门（应 95 绿；但它覆盖不到 4 段饱和）
node test/_accept-p4.mjs
```

### G-9.2 反面问题：这项改动**可能怎样让现有功能失效**？（≥3 条，实测/推理分级）

1. **重灌块丢画像段（已量化，中）**：head +109 字把 4 段饱和从「余 7 字」推到「超 102 字」⇒ 收口第一刀砍 `profile`（L14649-14653），`dropped=["profile"]`、用户画像（global.md 口径）不再补回。**且 `_ptr` 截断指针（L14531，约 80 字）追加在 checkpoint body 之后、不受 2400 预算约束** ⇒ 只要检查点被截断（>2600 字），旧版其实就已经超（6173），新版超得更多（6282）。即：**旧版是「条件性丢画像」，新版是「4 段饱和时无条件丢画像」**。
2. **回归提醒被 note 插队/延迟（推理，中低）**：`REGRESSION_QUEUE` 队头单条消费（L16374），note 条目与 E/D/W/PL 同队列。E 类文本退化/循环提醒若排在 note 之后，会晚一步到模型手里——而 E/D 提醒的价值恰恰在「立刻停」。
3. **过期档位文案误导模型（推理，中）**：队列无 TTL/无 generation，压缩前入队的「上下文已用约 95%」会在压缩后（上下文只剩 3-45%，实测）注入，模型可能误判「快满了，赶紧收尾」。
4. **配置耦合导致功能静默消失（已确认，中低）**：`regressionEnabled === false` 时 pre-step 在 L16362 直接返回，note 提醒**全部**不投递；但 L4968 仍照常打 `monitorEvent("note","remind lvl=…")` ⇒ 遥测说「提醒了」，实际一条没到。
5. **档位被消费但没投递（已确认，中低）**：`st.level/st.lastAt` 在 L1885 **入队前**就写死。任何「入队后没被消费」的路径（会话结束、`decision.kind!=='enter'`、插件子代理闸、配置关闭）都会**静默吃掉该 15% 区间**，本压缩周期内不再补。
6. **重启后重复一次 + 双状态分叉（推理，低）**：Map 易失、`p3` 状态持久 ⇒ 重启后 `fired` 还在、note 档位归零，长会话会立刻补一条「第 N 档」；两状态不再同步（若未来有人给 `p3` 加逻辑会踩坑）。
7. **噪音化（推理，低-中）**：压缩后 1-2 步内，模型会先看到重灌 head 的 note 引导（L14637），再收到第 1 档 `noteRemindText`（188 字）；加上 R3 每 8 轮的「记忆轻提醒」（L5000-5012，另一个通道）⇒ 同一会话存在**三条不同的周期性提醒**，note 被当噪音忽略的概率上升。

---

## 结论：推荐方案（最小风险优先）+ 最小护栏清单

### 方案对比（≥2 个更小/更稳的替代）

| 方案 | 改动量 | 风险 | 评价 |
|---|---|---|---|
| **A. 只保留「压缩后重注入」**（只留 L14633-14638 一行 head，删掉 15% 档位/Map/队列生产者） | 最小（1 行） | 最低 | 满足 starry 需求里「压缩后重新注入」的一半；不引入任何新状态/新队列生产者/预算问题（若把这一行压在 109 字内并把余量补回来）。**若「每 15%」不是硬需求，推荐这个** |
| **B. 复用 `p3SessionState` 存档位**（`st.noteLvl`），删掉 `noteRemindState` | 与现实现相当，但**少一个状态所有者** | 低 | 推荐。`p3` 段本来就：①持久化（`.monitor.json`，L2277-2286 + L4837-4849）②压缩时同一行重置（L17004）③30 天/500 上限清理（L4907-4926）。改成 `st.noteLvl` 后：**重启不重复**、**压缩自动同步**、**不用手写 500 FIFO**。唯一代价：档位写入会随 `scheduleMonitorSave` 落盘（已有防抖，无额外 IO 负担） |
| **C. 复用 T1 的 3 档（50/75/90%）加一句 note 引导** | 小（1 行文案） | 低 | 每周期 3 次（vs 6 次），完全复用 `st.fired`（已有重置/持久化/失败回滚 L19760）。缺点：粒度粗、且 note 提醒会绑死「检查点 spawn 成功」语义 |
| **D. 参数化 `p3Triggers.decideThresholdTrigger` 支持 6 档** | 大（要改纯函数模块 + 13KB 单测） | 中 | 不推荐：违反最小 diff；纯函数模块的档位数组是 `LEVEL_COUNT=3` 冻结契约（`p3-triggers.js` L58/L60） |

**推荐**：**B（首选）+ 修 M1 预算**；如果 starry 更看重「别再动状态」，退到 **A**。当前实现（独立 Map + 独立 FIFO + 独立重置点）在功能上没错，但**多了一个状态所有者和一条没有生命周期的队列通道**，是这次改动里唯一「为 15% 档位付出的结构性代价」。

### 最小护栏清单（逐条核对实现是否落实）

| # | 护栏 | 现状 | 证据 |
|---|---|---|---|
| 1 | 幂等/单调（同档不重复） | ✅ 落实 | L1882 `lvl <= st.level → null` |
| 2 | 冷却（防一轮内连发） | ✅ 落实 | L1883-1884（60s） |
| 3 | 异常不抛（绝不炸 session/event） | ✅ 落实（双层 try/catch） | L1874/1892 + L4964-4970 + L16921 |
| 4 | 非法输入防护 | ✅ 落实（空 sid/NaN/负/0） | L1877；selftest B7-B10 |
| 5 | 压缩后重置 | ✅ 落实（但与 `p3` 分两处） | L17007 |
| 6 | 日志带值 | ✅ 落实（lvl + ratio + sid 短形） | L4968 `monitorEvent("note","remind lvl=… ratio=… sid=…")` |
| 7 | **档位消费 = 投递**（幂等但不可丢） | ❌ **未落实**：入队前就写档位 | L1885 vs L4967/L16374（M3） |
| 8 | **队列条目生命周期**（TTL/generation/压缩清理） | ❌ **未落实** | L2326-2332 无 TTL；L17007 只清 Map（M2） |
| 9 | **产出物预算不变式**（4 段饱和 ≤6100） | ❌ **被压破** | L14637 + 实测 6202 > 6100（M1） |
| 10 | **独立开关/可回滚** | ⚠️ 半落实：无独立 flag，靠 `regressionEnabled`；改回滚只能整文件回退 | L16362；`DEFAULT_CFG` L6418/L6497（M4） |
| 11 | 成本可观测（注入字符进消耗账） | ❌ 未落实：note 注入没有 `p3CostBump` | 对比 R3 nudge L5008 `p3CostBump("recallReminder",{injectedChars})`（M6） |
| 12 | 子代理不提醒 | ✅ 落实（与 T1 同款） | L4938/L4961（header 缺失兜底见 M8） |

### 影响面结论

| 面 | 是否波及 | 说明 |
|---|---|---|
| ① 核心功能：记忆读写 | **否** | `memory_note`/`memory_write`/主题库链路零改动 |
| ① 核心功能：压缩重灌 | **是（产出物字节变化）** | 仅 head +109 字；饱和时丢 profile 段（M1）。重灌主流程/等待门/幂等集合未动 |
| ① 核心功能：检查点写入 | **否（语义）** | 重置调用在 L17007，位于 `p3CostBump` 之前、同一 try 内；`noteRemindReset` 自身 try/catch 且异常被外层吞 ⇒ 不阻断 spawn（L17015-17028） |
| ② 相关子系统：T1 阈值 | **否** | note 不 return（L4962-4970 在 L4971 之前），两者可同事件并行；`fired` 未被 note 触碰 |
| ② 相关子系统：回归提醒队列 | **是** | 新增生产者；共用 FIFO 队头单条消费 ⇒ 可插队/延迟 E/D（M2） |
| ② 相关子系统：前缀缓存 | **否** | 队列注入走 `decision.messages` 追加（L16377-16378），不进会话历史；重灌是压缩后一次性注入。均不改变已缓存前缀 |
| ② 相关子系统：消耗记账 | **是（漏计）** | note 注入未记 `injectedChars`；只有 `monitorEvent` 一行日志（M6） |
| ③ 性能 | **否（可忽略）** | 每压缩周期 ≤6 次 × 188 字；Map O(1)；无新增 IO（`monitorEvent` 复用 500ms 防抖写） |
| ④ 启动 | **否** | 无新配置读取、无新初始化、无新文件依赖；模块级 Map 创建即可 |
| ⑤ 数据一致性 | **是（弱）** | 双状态所有者：`noteRemindState`（易失）vs `p3SessionState`（持久）⇒ 重启后档位/`fired` 分叉（M5）。不写记忆库、不污染业务数据 |

---

## 必须修的 findings（高 / 中）

> 无「高」。以下按「建议重启前处理」排序。

### M1（中，接近高）重灌块 head +109 字压破「四段齐全」预算，饱和时无条件丢用户画像段
- **证据**：L14637-14638（新增行 108 字 + 换行）；head 实测 97→206 字；`R2_TOTAL` 仍 6100（L14645）；收口砍序 profile 优先（L14649-14653）；预算注释 L14443-14445 声称「四段全满也放得下」。
- **实测**：4 段 body 全饱和（2400+1150+350+1900=5800）时，旧 6093（余 7 字）→ 新 **6202（超 102）**；若走 `cpFile` 头（6140，超 40）。⇒ `dropped=["profile"]`，用户画像段消失。若检查点被截断追加 `_ptr`（L14531，≈80 字，不受预算约束），旧版也已超（6173）——所以准确说法是：**旧版条件性丢、新版 4 段饱和必丢**。
- **修法（三选一，按最小改动）**：①把新增行压到 ≤100 字（当前 108）；②`R2_TOTAL` 默认 6100→6210（同时改 `_accept-p4.mjs` L54 的 `R2_BLOCK_TOTAL` 并补 4 段饱和用例）；③note 段预算 1900→1790，把这 110 字还给装配头。
- **必须同时做**：更新 L14443-14445 的失真注释；给 `_accept-p4.mjs` 补一条「4 段饱和 ≤6100 且 dropped 不含 profile/project/checkpoint/note」的断言（当前门测不到）。

### M2（中）note 提醒寄生回归队列但无生命周期：压缩后残留旧档位文案 + 与重灌 head 双提醒 + 可插队 E/D
- **证据**：入队 L2326-2332（无 TTL/无 generation）；消费 L16355-16382（队头单条）；`clearRegressionQueue` 仅 `guardClear` 调用（L12947，只服务插件子代理）；压缩点只清 Map 不清队列（L17007）；重灌 head 已含 note 引导（L14637）。
- **后果**：①压缩前入队的「上下文已用约 95%」在压缩后（实测上下文只剩 3-45%）注入 ⇒ 误导；②压缩后 1-2 步内模型收到「重灌 head 引导 + 第 1 档提醒」两条 note 提示；③note 排在队头时 E/D 提醒推迟一步。
- **修法（最小）**：给 `enqueueRegressionReminder` 加可选 TTL（默认 20 分钟，参考 `CMD_ECHO_TTL_MS` L1922），pre-step `peek` 后先判 `enqueueAt` 过期则丢弃并 `recordGate("note-remind","expired")`；压缩点 `noteRemindReset` 时顺带 `clearRegressionQueue` 中 `sig==="note-remind"` 的条目（注意别清 E/D 条目）。

### M3（中）档位在入队前即消费：投递失败会静默吃掉一个 15% 区间
- **证据**：L1885 先写 `st.level/lastAt`，L4967 才入队；任何未消费路径（`regressionEnabled=false` L16362、`decision.kind!=="enter"` L16373、插件子代理闸 L16366、会话结束、时钟回拨 L1884）都会让该档永久跳过（直到下次压缩重置）。
- **修法（最小）**：把 `st.level` 更新移到「确认入队成功」之后（`enqueueRegressionReminder` 返回 boolean，当前返回 undefined）；或加 `pendingLevel` 字段，pre-step 消费成功后再提交 level（提交点 L16374 之后无法回调模块级函数——可用 `noteRemindConfirm(sid)` 暴露）。**若不改**，至少在注释里写明「档位为 at-most-once，允许丢一档」。

### M4（中低）无独立开关，且关闭回归提醒时遥测仍报「已提醒」
- **证据**：无 note 专用 flag（`DEFAULT_CFG` L6418、schema L6497 均无）；消费闸 L16362 只看 `regressionEnabled`；L4968 无条件打 `monitorEvent("note","remind …")`。
- **修法**：加 `noteRemindEnabled`（默认 true，`volatile()` 同款），L4962 前判；或在 L4968 的日志里带上 `injected=false` 之类的投递状态。

---

## 可接受但需记录（低）

- **L1 双状态所有者**：`noteRemindState`（易失）与 `p3SessionState`（持久）重启后分叉；500 FIFO 淘汰是「最早插入」非 LRU（L1887-1890）。建议按方案 B 合并。
- **L2 成本口径失真**：注释 L1867 写「~70 字」，实测 `noteRemindText` = 188 字（selftest D5 也是 188）；6 次/周期 ≈1128 字，不是 420。且 note 注入未进 `p3Cost`（无 `injectedChars`），消耗面板低估。
- **L3 分母硬编码 838860**（L4860）：与 T1 同款既有假设。本机实证成立（max totalTokens=839834），但若宿主窗口/压缩阈值可配置，则「每 15%」整体偏移（窗口更小 ⇒ 永不提醒）。建议在注释/文档里写明「假设宿主默认 1M 窗口」。
- **L4 子代理判定 header 缺失兜底缺失**（L4938）：`isTopLevelSession`（L12221-12230）有 `rootSessionId` 兜底，`p3OnSessionEvent` 没有 ⇒ 未标记子代理理论上会收到 note 提醒（与 T1 同款既有缺口）。
- **L5 队列无上限**：`REGRESSION_QUEUE` 每 sid 数组无 cap（既有），note 是新增生产者；会话结束不清理（主会话）。内存量级很小，记录即可。
- **L6 `sig` 命名不一致**：其它信号用 `D:loop`/`E:loop`/`W:noop`/`PL:xxx`（冒号分类），note 用 `note-remind`；`recordGate` 会把它记成独立 cls（L16376 → `split(":")[0]`），不影响功能，但面板/门统计会多一个类目。
- **L7 档位边界测试未固化**：selftest 用 16%/32%/95%，未测精确整点；我补测 `t=125829/251658/…` 均正确，建议把整点断言写进 `_note-remind-selftest.mjs`。
- **L8 `compaction/start`(494) vs `compaction/summary`(466) 有 28 条差**：多为日志尾部未结算；若确有「压缩失败无 summary」的路径，则该次压缩不重置档位（提醒暂停到下次重跨旧档）。记录，不改。

---

## 我**没能验证**的部分（诚实记录）

1. **「已部署未重启」的字节一致性**：仓库内 `install-manifest.json` 是 2026-10-31 的旧清单（index.js `1404184` bytes / sha `007f0452…`），与当前 `1454689` / `BC1A6C9F…` 不符；我在 `~/.dsh/plugins` 下**没找到** dsh-memory 的已部署副本（只有 `@deepseek-ai/dsh-client-ui-aqua` 等），无法确认宿主下次加载的确实是这份文件。**本报告只对源码文件 `BC1A6C9F` 负责。**
2. **改前/改后精确 diff**：仓库里没有 2026-11-05 13:13 之前的当日备份（最近的是 `index.js.p4-backup-before-archive-removal`，2026-11-04 22:19，且期间还有其它改动），`git diff` 对 HEAD 是 7778 行的大跨度差异，**无法隔离出本改动的逐字节 diff**；所有结论基于「按任务书给的 5 个改动点读现码 + 行号证据」，不是 diff 审。
3. **未重跑回归门**：只重跑了 `_note-remind-selftest.mjs`（22/22 复现）。`_accept-p4`(95) / P0(71) / note(34) / gate(18) / dream-cand(12) / review(39) / alignment(28) / textdeg(35) / P2.5(39) 均**未复跑**（其中 `_accept-p4` 需要 spawn 子代理、耗时且会写临时 HOME），按任务书给的证据采信；但请注意 M1 指出的 `_accept-p4` **覆盖洞**是读码结论，不依赖复跑。
4. **无运行时验证**：没有把插件加载进宿主跑一次真实「压缩 → 重灌 → 下一轮 note 提醒」链路，因此「队列条目是否真的在压缩后残留并被注入」「重灌 head 与第 1 档提醒的实际先后」是**读码+事件序推断**，不是实测。
5. **4 段饱和是否在真实会话发生**：需要「笔记 ≥1900 字 + 检查点/项目/global 同时饱和」的会话，我没有在 33 个样本里逐会话构造验证；M1 是**可复现的静态判据**（one-liner 可跑），不是真机现象。
6. **宿主侧 `agent/pre-step` 的 handler 执行顺序**（A 类 handler L16210 vs 回归 handler L16358）未实测；只知道二者都通过 `next()` 串联，note 注入在重灌 `inject` 之后还是之前未验证。
7. **其它模型的窗口/压缩阈值**：只在当前机器当前模型上实证 838860（max totalTokens=839834）；换模型（更小窗口）时 15% 档位会整体偏移，未验证。

---

## 附：本次审计的关键证据快照

- sha256：`BC1A6C9F255C490E354C96002664C4C0B477D331D42A92B9C7FF24FB1D76C3BE`；20437 行；`node --check` 未复跑（任务书称绿）。
- `node test/_note-remind-selftest.mjs` → **全部通过 22/22**（含 D5 单条 188 字）。
- `node _verify/_q-turn-density.mjs` → 中位数 **轮/时=2.3、压缩间隔=10.86h、30 轮≈13.2h**（与任务书一致）。
- 真实会话日志只读扫描（33 个会话、121,401 条 usage 样本）：
  - `totalTokens = input + output + cacheRead`（逐位相等）；
  - `max totalTokens = 839834`（阈值 838860 成立）；
  - 压缩后上下文骤降：`550701→244651`、`799260→37284`、`770679→105644`；
  - 事件类型计数：`compaction/prune=1428`、`compaction/start=494`、`compaction/summary=466`、`compaction/end=487`；
  - 466 条 summary 全部 `blocks` 非空、全部带 `compactionId`（⇒ 重置路径的早退闸在真机基本不会误挡）。
