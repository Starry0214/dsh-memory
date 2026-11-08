# MiMo-Code notes / checkpoint / dream 三者全生命周期梳理（只读调研）

- **调研对象**：`E:\工具\插件开发调整\mimo-src\MiMo-Code-main`（整棵树只读；下称 `src/` = `packages/opencode/src/`）
- **调研目的**：为 dsh-memory「会话笔记（notes）无限增长」改造取证——MiMo 用「checkpoint writer 在每个 checkpoint 事件后把 notes.md 截断回模板」治增长，需判断能否借鉴、坑在哪
- **方式**：纯静态阅读，未运行任何代码、未改任何文件（除本报告）
- **证据格式**：`文件#L行号`（多行写 `#L起-L止`）；**推断** = 代码静态比对得出、未运行验证；**未找到** = 全仓 grep 无实现
- **调研时间**：2026-11-06

---

## 1. 结论摘要（≤300 字）

**MiMo 的 notes 清空是 100% 提示词约定，零代码强制**：唯一指令在 `agent/prompt/checkpoint-writer.txt#L60` 与 `#L114`（"Use Write tool to overwrite notes.md with the NOTES_TEMPLATE byte-for-byte"）；代码里 `NOTES_TEMPLATE` 只有「文件不存在时创建」一处用途（`session/checkpoint.ts#L133-L138`），全仓没有 reset/truncate 函数，校验器也从不读 `notesPath`（`session/checkpoint-retry.ts#L44-L94`）。因此：writer 忘了清 → notes 原样留着，没有任何兜底、校验、重试，也没有「待提炼量」观测面（`tool/memory.ts#L9-L82` 只有 search）。

机制上真正能借鉴的是**职责分离 + 单一归属**：notes 是主 agent 唯一合法暂存区，结构化提取由 checkpoint writer 独占；writer 按 7 类映射把每条 notes 路由到 checkpoint 的 §3/§6/§7/§8/§10/§11 或 MEMORY.md（`checkpoint-writer.txt#L41-L58`），**路由完才清空**（`#L60`）——清空是「去重的执行手段」，不是「丢弃」。但它的并发与失败保护是空的：读-改-写整文件覆写、无锁无 CAS（主 agent 在 writer 读完之后 append 的笔记会被覆盖丢失，**推断**）、多 Edit 非原子、`quarantineCheckpoint` 全仓 0 调用方（`session/checkpoint-retry.ts#L124-L131`）。

**判断**：值得借鉴「清空即去重 + 单一归属 + 路由表」，**不值得照抄「靠提示词清空」**；dsh-memory 应把它做成代码级、带 CAS/事务、可观测的裁剪。

> 本节之外，dsh-memory 侧**已有的审计结论**（digest 退役、note 提醒、生命周期归档、设计文档闸门）与 MiMo 自身 spec 的复用/排除清单见 **§6**——那些点本报告不重复推导。

---

## 2. 三者生命周期图

### 2.1 一图流（谁写 / 谁读 / 谁清 / 何时）

```
                    ┌──────────────────────────────────────────────────────┐
   用户/主 agent ──▶ │ notes.md（sessions/<sid>/notes.md，唯一合法暂存区）  │
   （append-only）   │ 格式：## [turn N · ISO-Z] + 自由正文                 │
                    └───────┬───────────────────────────┬──────────────────┘
                            │ ① Turn1 读全文             │ ② 注入 rebuild（cap 6000）
                            ▼                           ▼
              ┌──────────────────────────┐    ┌─────────────────────────────┐
              │ checkpoint-writer 子代理  │    │ 主 agent 的 rebuild 上下文   │
              │ (child session, 后台)     │    │ "## Session notes" 段落      │
              └───────┬──────────────────┘    └─────────────────────────────┘
                      │ Turn2a 按 7 类映射路由
                      │ Turn2  ① Edit checkpoint.md §1..§11
                      │        ② Edit MEMORY.md（按需）
                      │        ③ Write notes.md = NOTES_TEMPLATE（清空）
                      ▼
        ┌──────────────────────────┬──────────────────────────┐
        │ checkpoint.md（11 节）    │ MEMORY.md（项目 4 节）     │
        └───────┬──────────────────┘    └──────────┬────────────┘
                │ 注入 rebuild（cap 11K）           │ 注入 rebuild（cap 10K）
                ▼                                  ▼
        ┌──────────────────────────────────────────────────────┐
        │ dream 子代理（手动 /dream 或 auto，默认关）            │
        │ 读：MEMORY.md + notes.md + Glob 所有 checkpoint.md     │
        │     + 原始轨迹 SQLite（只读）                          │
        │ 写：MEMORY.md（合并去重）；notes 仅"完全整合后"清（提示词）│
        └──────────────────────────────────────────────────────┘
```

### 2.2 四象限表

| 对象 | 谁写 | 谁读 | 谁清 | 何时 |
|---|---|---|---|---|
| `notes.md` | 主 agent（write/edit，append） | ① writer Turn1；② rebuild 注入（cap 6000）；③ dream；④ FTS 索引（type=free） | **checkpoint-writer**（Write 回模板） | 每次 checkpoint 成功后（提示词约定，无代码强制） |
| `checkpoint.md` | checkpoint-writer（独占，主 agent 禁改） | rebuild 注入（cap 11K）、dream、FTS、TUI（coveredUpTo） | **无人清**（原地覆写，不删除；会话删除也不删文件） | 阈值跨过 / 溢出 / 手动 `/rebuild` |
| `MEMORY.md`（项目） | checkpoint-writer（提升）+ 主 agent（例外）+ dream | rebuild 注入（cap 10K）、dream、FTS | dream 合并去重（<200 行/10KB） | checkpoint 事件 / dream |
| `global/MEMORY.md` | 主 agent / dream（提升） | rebuild 注入（cap 6000）、dream | dream（推断） | 同上 |

### 2.3 关键时序约束

- **清空发生在路由之后**：Turn 2a 判定目的地（`checkpoint-writer.txt#L41-L60`）→ Turn 2 才 Write 模板（`#L114`）；且「未迁移内容仍留在会话尾部，下次 writer 触发可再路由」（`#L58-L60`）。
- **checkpoint 与 notes 的写入在同一批并行工具调用里**（`#L83-L114`），跨文件**非原子**：checkpoint 写成功而 notes 写失败 → notes 保留旧内容（**推断**）。
- **checkpoint.md 与 `last_checkpoint_message_id` 是事务性的**：水位只在 writer success 时前进（`session/checkpoint.ts#L976-L1021`），失败则下次阈值重覆盖同一 delta。
- **dream 与 writer 无顺序保证**：dream 在新顶层会话 step===1 时 detached 启动（`session/prompt.ts#L3456-L3478`），与同会话的 writer 可能并发。

---

## 3. 逐条回答（10 问，每条带证据）

### Q1 notes.md 的清空：提示词 vs 代码强制？

**答：纯提示词，零代码强制。**

- 唯一清空指令（两处，互为补充）：
  - `agent/prompt/checkpoint-writer.txt#L60`：「notes.md will be truncated to NOTES_TEMPLATE in the Turn 2 Edit pass; un-migrated content stays accessible via the conversation tail and can be re-routed at the next writer fire if it resurfaces.」
  - `agent/prompt/checkpoint-writer.txt#L114`：「Use Write tool to overwrite notes.md with the NOTES_TEMPLATE byte-for-byte (you Read it in Turn 1 — write the same header back)… Do NOT use Edit — use Write with the full template body.」
- 代码侧只有「创建」没有「重置」：`NOTES_TEMPLATE` 全仓仅两处用途——import（`session/checkpoint.ts#L40`）与 `ensureNotesTemplate` 在**文件不存在时**写入（`session/checkpoint.ts#L133-L138`，调用点 `#L712-L714`）。全仓 grep `resetNotes|truncateNotes|clearNotes` **未找到**。
- **没有校验兜底**：preStop 校验器只读 `checkpointPath` / `memoryPath`（`session/checkpoint-retry.ts#L44-L94`），`notesPath` 全仓只被 `session/checkpoint.ts` 与 `session/checkpoint-paths.ts` 引用，**校验器/重试逻辑从不检查 notes**。
- **没有重试兜底**：校验失败重试由 `plugin/checkpoint-splitover.ts#L20-L56` 的 preStop hook 驱动，其 violations 来源只有 checkpoint/MEMORY/progress（`session/checkpoint-retry.ts#L58-L118`）；notes 不在任何 violation 规则里（`session/checkpoint-validator.ts#L3-L16` 的 rule 枚举无 notes 项）。
- **writer 忘了清会怎样**（推断，基于上述代码）：
  1. notes.md 原样保留 → 下一个 writer Turn1 再读一次（`checkpoint-writer.txt#L33-L37`），可能把同一批内容重复 reconcile（唯一防线是模板里的判重句，见 Q4）；
  2. 增长只能等「下一次成功的 writer」清空；若 writer 持续失败，notes 无上限增长；
  3. 注入侧会在 6000 token 处**按比例截断**（`session/budgeted-read.ts#L9-L27`），超出部分整段丢失且只给一个 `Read(..., offset=L)` 提示（`#L22-L26`）。
- 唯一「软兜底」是模板里的自我判重：`session/checkpoint-templates.ts#L113`「Before appending: scan existing entries — if you've already noted substantially similar content, add a short `(see entry above)` reference instead of duplicating.」

### Q2 checkpoint writer 是谁：子代理？spawn 参数？路径？失败/超时？

**答：独立子代理（child session + actor.spawn），非主 agent；无 step/token 预算；4 个绝对路径；失败不动水位、不原地重试。**

- 身份与定义：`agent/agent.ts#L344-L373` —— `mode:"subagent"`、`native:true`、`hidden:true`、**无 `prompt` 字段**（fork agent 契约）、无 `toolAllowlist`（靠运行时白名单）；`SYSTEM_SPAWNED_AGENT_TYPES = ["checkpoint-writer","dream","distill"]`（`agent/config.ts#L7`）。
- spawn 全参数（`session/checkpoint.ts#L908-L947`）：
  - 先建 child session：`session.create({ parentID: input.sessionID, title: "checkpoint-writer: <rangeDesc>" })`（`#L908-L911`）；
  - `actor.spawn({ mode:"subagent", sessionID: child.id, parentSessionID: 父sid, agentType:"checkpoint-writer", task: promptText, context:"full", tools:["read","write","edit","apply_patch","glob","grep","task"], model:{providerID, modelID}, background:true, forkContext })`（`#L925-L947`）；
  - 模型 = **前景这一轮的模型**（`session/prompt.ts#L3507` → `session/prune.ts#L321-L327` → `session/checkpoint.ts#L941-L944`），不是 agent 自有模型；
  - `background:true` → 与主 loop 并发，主 loop 不等待（`#L945`；收尾靠 `drainWriters`，`cli/bootstrap.ts#L17-L28`）。
- **预算：没有**。`SpawnInput` 无 steps/token/timeout 字段（`actor/spawn.ts#L206-L267`）；agent 无 `steps` → `agent.steps ?? Infinity`（`session/prompt.ts#L3725`）。所谓「预算」只有三个：
  1. 写入内容的**节 token 预算**（11 节合计 ~11K，`session/checkpoint-templates.ts#L88-L100`，经 `{{SECTION_BUDGETS}}` 注入 prompt `session/checkpoint.ts#L297-L312,L354`）；
  2. **校验重试上限 3 次**（`actor/spawn.ts#L39` `MAX_PRE_REACT = 3`，触发 `#L504-L517`）；
  3. **等待上限 5 分钟**（`session/checkpoint.ts#L1090-L1103`）——超时**不取消** writer，只是调用方不再等（注释明确 `#L1080-L1089`）。
- 拿到的路径（prompt 前缀里钉死，禁止推断）：`CHECKPOINT_PATH` / `MEMORY_PATH` / `TASK_MEM_DIR` / `NOTES_PATH`（`session/checkpoint.ts#L338-L341`），并配硬写边界（`tool/memory-path-guard.ts#L37-L44` 只能写 memory 树；`#L79-L104` 精确 allowlist：`projects/<pid>/MEMORY.md|memory-*.md`、`sessions/<sid>/checkpoint.md|checkpoint-*.md|notes.md`、`sessions/<sid>/tasks/<TID>/*.md`；`#L208-L219`）。
- 失败/超时：
  - 水位只在 success 前进（`session/checkpoint.ts#L976-L1021`），失败**不原地重试**，靠下一个阈值重覆盖同一 delta（`session/prune.ts#L329-L348`）；
  - 末档（最高阈值）有一次性「恢复门」，仅当失败分类为 `retryable`，门 = `firedAt + 阶梯步长`（`session/prune.ts#L378-L415`）；
  - 进程退出前 `drainWriters()` 最多等 120s（`cli/bootstrap.ts#L17-L28`）。

### Q3 触发点：checkpoint 事件到底什么时候触发？

**答：4 条触发路径 + 1 条退出收尾；没有定时器、没有「每 N 轮」、没有 idle、没有会话结束触发。**

| # | 路径 | 证据 |
|---|---|---|
| 1 | **阈值阶梯**：runLoop 每轮开头，用最近完成 assistant 的 tokens 判断新跨过的阈值 → `fireCheckpoints` → `tryStartCheckpointWriter` | `session/prompt.ts#L3596-L3611`；`session/prune.ts#L241-L423`；阶梯 `session/prune.ts#L44-L51`；预留 13K `#L27,L80-L82`；单飞锁 `#L272-L277` |
| 2 | **自动溢出**（上下文将满）：`overflowCheck` 命中 → `rebuildEnsuringCheckpoint`（先试磁盘 checkpoint，无则现起 writer 并等） | `session/prompt.ts#L3613-L3665`；helper `#L464-L566` |
| 3 | **手动 `/rebuild`**：同样走 `rebuildEnsuringCheckpoint`，等待 5min | `command/index.ts#L71,L182-L184`；`session/prompt.ts#L4514-L4555`；`MANUAL_WRITER_WAIT_MS=300_000` `#L420` |
| 4 | 子代理溢出 → **不走 checkpoint**，走 per-actor compaction | `session/prompt.ts#L3621-L3644` |
| 收尾 | CLI 退出前 `drainWriters()`（flush，不是触发） | `cli/bootstrap.ts#L17-L28` |

- 阈值密度：`<25K → 禁用`；`25K~200K → 20/40/60/80%`；`200K~500K → 每 10% 共 9 档`；`>500K → 每 5% 共 18 档`（`session/prune.ts#L44-L51`）。
- 每次 rebuild 成功后阶梯重置（`session/prompt.ts#L400` → `session/prune.ts#L517-L523`），所以 rebuild 后从 0 重新累积。
- **未找到**：`setInterval`/cron/idle 触发；全仓 `fireCheckpoints` 仅 `session/prompt.ts#L3603` 一处调用。

### Q4 notes 与 checkpoint 的内容重叠如何避免？

**答：靠「单一归属 + 清空即去重」+ 三层判重规则；没有代码级去重。**

1. **单一归属（路由表）**：writer Turn 2a 把 notes 每条按 7 类映射到唯一目的地（`agent/prompt/checkpoint-writer.txt#L41-L58`）：工作风格→§3 或 MEMORY Rules；跨任务事实→§7 或 MEMORY Discovered；Bug+修复→§8；设计决策→§10；代码/文件操作→§6；引文/未解问题/侧观察→§11；**精确字面量（DSN/端口/路径/命令/ID/seed）→§3 或 MEMORY Rules，逐字复制**（`#L54-L57`）。
2. **清空即去重**：路由完 notes 被整文件覆写回模板（`#L60,#L114`）→ 同一事实此后只在 checkpoint/MEMORY 存一份，不会被下一个 writer 重复提取。
3. **§11 的定位是「宁空勿滥」**：模板说明 §11 是 catch-all、「May be empty for many checkpoints」（`session/checkpoint-templates.ts#L54-L57`）；writer prompt 重申「prefer empty when in doubt — most checkpoints have nothing here」（`checkpoint-writer.txt#L23`）。
4. **notes 侧判重**：追加前先扫已有条目，实质重复只写 `(see entry above)`（`session/checkpoint-templates.ts#L113`）。
5. **Discovered 标题跨 checkpoint 判重**：`loadPriorDiscoveredTitles` 从当前 checkpoint 抽标题（`session/checkpoint-retry.ts#L29-L35`），validator 报 `discovered-duplicate-title`（`session/checkpoint-validator.ts#L143-L151`）。⚠️ 但该规则只解析 v4 的 `### Discovered`（`#L105-L123`），**v5 的 §7 不在覆盖范围**（推断/缺口，与上一轮发现的 v4/v5 漂移同源）。

### Q5 并发/竞态：dream 与 writer 会同时动 notes 吗？主 agent 运行期 append 会丢吗？

**答：没有任何锁/CAS/版本号；会并发；append 会丢（推断）。**

- **无锁证据**：全仓 Flock/Semaphore 只用于 cron-lock（`cron/cron-lock.ts#L18`）、plugin meta（`plugin/meta.ts#L147`）、models 缓存（`provider/models.ts#L148`）、workspace-trust（`project/workspace-trust.ts#L49`）、snapshot（`snapshot/index.ts#L70`）与 edit 工具内部——**memory 树没有任何文件锁或事务**（grep 未找到 memory 相关 lock）。
- **writer 与主 agent 并发**：`background:true`（`session/checkpoint.ts#L945`），主 loop 不等。writer Turn1 Read notes（`checkpoint-writer.txt#L33-L37`）→ Turn2 Write 整文件（`#L114`）。**主 agent 在这两步之间 append 的内容会被整体覆盖丢失**（**推断**：读-改-写整文件、无版本校验）。
- **dream 与 writer 并发**：dream 由 `session/prompt.ts#L3456-L3478` 在新顶层会话 `step===1` 时 detached 启动（新 session，title `Auto Dream`，agent `dream`，模型=当轮模型）；它也被允许写 notes（`agent/agent.ts#L400-L411` 工具白名单含 write/edit；`tool/memory-path-guard.ts#L9,L46-L56` 允许写 memory 树 + `.mimocode/`）。两者对 notes.md 是「最后写者胜」（**推断**）。
- **唯一顺序约定是提示词**：`agent/prompt/dream.txt#L141`「Clear current `notes.md` entries only when fully integrated」——靠模型自觉，无代码保证。
- **跨进程**：两个 mimo 进程可同时操作同一 memory 树，无文件锁（**推断**）。
- 反面：checkpoint.md 的水位推进是事务性的（`session/checkpoint.ts#L976-L1021`），这一点比 notes 严谨。

### Q6 失败回退：writer 中途失败/被 kill 时文件是什么状态？

| 对象 | 状态 | 证据 |
|---|---|---|
| `checkpoint.md` | **可能半更新**：writer 用多次 Edit 原地改（`checkpoint-writer.txt#L83-L88`），非原子；无备份/无事务/无回滚 | **推断**（基于多次 Edit 调用） |
| `notes.md` | 若失败在 Turn2 Write 之前 → **完全不变**；若 Write 执行中被 kill → 可能截断/半写 | **推断**（`Bun.write` 非原子） |
| `last_checkpoint_message_id` | **不动**（只在 success 前进）→ 下次阈值重覆盖同一 delta | `session/checkpoint.ts#L976-L1021` |
| 校验失败 | preStop 返回 `continue + reflection`，最多 3 次后带病停止 | `plugin/checkpoint-splitover.ts#L20-L56`；`actor/spawn.ts#L39,L504-L517` |
| 隔离/隔离区 | **没有**：`quarantineCheckpoint`（把 `checkpoint.md` 改名 `checkpoint.invalid.md`）定义了但**全仓 0 调用方** | `session/checkpoint-retry.ts#L124-L131`；grep 仅定义处命中 → 死代码 |

补充：writer 超时（>5min）**不取消**，只是调用方放弃等待，writer 仍可能稍后成功并推进水位（`session/checkpoint.ts#L1080-L1103`）。

### Q7 dream 的输入输出

- **输入**：
  1. memory 树文件：当前项目 `MEMORY.md`、当前会话 `notes.md`、`Glob memory/sessions/*/checkpoint.md`、`tasks/*/progress.md`（`agent/prompt/dream.txt#L41-L53`）；
  2. **原始轨迹 SQLite** `<DATA>/mimocode.db`（只读，`#L15`；用 bash + SQLite 查询 `#L59`）；
  3. 表：`session` / `message` / `part` / `task` / `task_event` / `actor_registry`（`#L61-L65`）；schema 提示 `message(id, session_id, agent_id, time_created, data JSON $.role)`、`part(id, message_id, session_id, time_created, data JSON)`（`#L67-L76`）；查询模板 `#L78-L90`（message JOIN part，`json_extract` 取 type/tool/preview）。
- **默认时间窗**：最近 **7 天**（`#L8`）。
- **输出**：
  - 项目 `MEMORY.md` 的 5 个节：`## Rules` / `## Architecture decisions` / `## Discovered durable knowledge` / `## Patterns` / `## Gotchas`（`#L119-L125`）；
  - 跨项目偏好可提升到 `global/MEMORY.md`（`#L27`）；
  - 原则：合并而非追加、相对日期转绝对、删过时、每条 1-3 行、带来源 `[ses_xxx]`（`#L129-L133`）；体积目标 <200 行 / 10KB（`#L137`）；
  - 返回摘要格式：Consolidated / Updated / Deleted / Skipped / Workflow candidates / **Health（行数/200、size/10KB）**（`#L146-L155`）。
- **是否也清 notes**：**是，但仅提示词**：Phase 5「Clear current `notes.md` entries only when fully integrated」（`#L141`）；代码无实现、无校验（同 Q1）。
- **触发**：手动 `/dream`（`command/index.ts#L130-L148`）；自动需 `cfg.dream.auto=true`（**默认 false**）+ `interval_days`（默认 7）+ 记忆写开关，且在新顶层会话 step===1 时触发（`session/prompt.ts#L3456-L3478`；`session/auto-dream.ts#L45-L121`；`config/config.ts#L362-L371`）。
- **漂移**：`dream.txt#L10` 自称「This command is manual」，但存在 auto-dream（同上）→ 文档与实现不一致。
- **写权限**：memory 树 + `<worktree>/.mimocode/`（`tool/memory-path-guard.ts#L9,L46-L56`）；工具白名单 read/write/edit/apply_patch/view_image/glob/grep/memory/bash/exec（`agent/agent.ts#L400-L411`）。

### Q8 预算/截断：notes 6000、§11 800 怎么生效，超了怎样？

**notes（注入侧，6000）：**
- 配置 `checkpoint.push_caps.notes` 默认 6000（`config/config.ts#L312-L314`）→ `readBudgeted(notesPath, caps.notes ?? 6000)`（`session/checkpoint.ts#L1298-L1300`）→ 超限按**比例切 95%**、回退到最后一个换行，追加提示：`⚠️ Truncated at ~6000 tokens. <path> is ~N tokens total. Read("<path>", offset=L) for the rest.`（`session/budgeted-read.ts#L9-L27`，文案 `#L22-L26`）。
- 特性：**非节感知**（notes 没有 `## ` 结构可依），无优先级，尾部整段丢失。

**§11 Open notes（写入侧，800）：**
- 预算表 `session/checkpoint-templates.ts#L99`（§11: 800）→ writer 侧 `validateBudgetSections`（`session/checkpoint-validator.ts#L227-L259`，调用点 `session/checkpoint-retry.ts#L85-L91`）→ 超限 severity=`extract-required`（`#L249-L256`）→ `buildExtractionReflection` 要求把「较不重要的主题簇」抽到 `checkpoint-<topic>.md` 并留索引行 `- See <spillover>.md (N entries) — short summary`（`session/checkpoint-retry.ts#L171-L192`）→ 单次抽取后再校验（`#L191`），但 preStop 可反复至 3 次。
- 注意：§11 预算**只在 writer 写入时校验**；rebuild 注入用的是整档 11K 预算（`session/checkpoint.ts#L1287-L1290`），不按节切。

**其余相关 cap**（同一 push_caps 结构）：checkpoint 11000 / memory 10000 / global 6000 / recent_user 16000（单条 2000）/ tasks_ledger 2000 / actor_ledger 500 / memory_titles 500（`config/config.ts#L287-L327`；`session/checkpoint.ts#L1270,L1313-L1345,L1394,L1408,L1489`）。

### Q9 有没有「未提炼/待处理」的统计或展示？

**答：未找到。MiMo 完全没有 notes 的积压/待处理观测面。**

- `memory` 工具只有 `search` 一种 operation（`tool/memory.ts#L9-L10,L24-L82`），无 status / candidates / pending。
- TUI 唯一与 checkpoint 相关的状态是**上下文用量占位符** `pending`：基于 checkpoint 的 `coveredUpTo` 判断「最后一次测量是否被 rebuild 折叠」（`cli/cmd/tui/util/model.ts#L110-L144`）——讲的是上下文数字过期，**与 notes 无关**。
- 会话列表只是把 writer 的 child session 过滤掉（`cli/cmd/tui/component/dialog-session-list.tsx#L137-L140`），不是 notes 统计。
- dream 输出里的 `Health:` 统计的是 **MEMORY.md** 行数/体积（`dream.txt#L155`），不是 notes。
- 结论：notes 是否被清空**不可观测**，只能直接读文件；也没有「有多少条尚未提炼」的计数（**未找到**）。

### Q10 `src/memory/write-gate.ts`：memory 写入闸门规则

- 单一读取点：`isMemoryWriteEnabled(cfg)`，字段 `memory.disable_write`（负向语义），默认 **ENABLED**；用 `!== true` 而非 `?? false`，只有字面 `true` 才禁用（畸形值降级为「可写」）（`memory/write-gate.ts#L14-L33`）。
- 影响面（4 处）：
  1. checkpoint 写全链路在入口短路：模板 bootstrap、writer spawn、校验重命名全被挡（`session/checkpoint.ts#L598-L617`，注释说明「读不受影响」`#L606-L610`）；
  2. auto-dream / auto-distill 不跑（`session/auto-dream.ts#L113,L126`）；
  3. memory 树内任何写入被 `memory-path-guard` 一律拒绝，且文案明确「不要换路径重试」（`tool/memory-path-guard.ts#L186-L195`）；
  4. 读取路径不受影响（rebuild 仍注入既有文件，`session/checkpoint.ts#L606-L610`）。

---

## 4. 可借鉴点 / 不该借鉴点

### 4.1 值得借鉴（4 条）

| # | 借鉴点 | 为什么 |
|---|---|---|
| B1 | **「清空 notes」= 去重的执行手段，而非丢弃**：路由完成后再清，且明确「未迁移内容仍留在会话尾部可再路由」（`checkpoint-writer.txt#L58-L60`） | 我们的笔记主题是 append-only，dream 提炼后只追加「已提炼 → T-xxxx」而不删正文 ⇒ 无限增长。MiMo 的语义是「内容已搬到结构化处，暂存区即可清空」——这正是我们需要的语义，但**前提是源可再取**（我们的源是笔记本身，清空即永久丢失，必须先把内容落进主题库再标记） |
| B2 | **职责分离 + 单一归属**：主 agent 只 append，结构化提取由 writer 独占（`llm.ts#L176-L178`；`checkpoint-writer.txt#L41-L58`） | 我们的 `memory_note` 已经是单写通道（AGENTS.md 4.5.1），方向一致；可再进一步把「提炼/裁剪」也收敛到 dream 一个角色 |
| B3 | **7 类路由表 + 精确字面量逐字复制**（`checkpoint-writer.txt#L41-L58`，字面量规则 `#L54-L57`） | 可直接映射到 dsh-memory 的主题分类与「精确字面量索引」主题；避免「已提炼」标记只写一句而不迁移正文 |
| B4 | **清空前的判重句 + §11 宁空勿滥**（`checkpoint-templates.ts#L113`；`checkpoint-writer.txt#L23`） | 我们的笔记去重目前是工具层「同内容跳过」，可再加一条「实质重复写 (see above)」的模型侧约定，减少 dream 的判重负担 |

### 4.2 不该借鉴（5 条，附原因）

| # | 不该借鉴 | 为什么 |
|---|---|---|
| N1 | **靠提示词强制清空**（`checkpoint-writer.txt#L114`，零代码校验/重试/quarantine） | 模型会忘、会被中途打断、会在长 prompt 下忽略；MiMo 自己也承认「未迁移内容靠会话尾部兜底」，但那是**它的**兜底（源在会话里）。我们清空的是唯一副本，必须代码级：**提炼成功 + 事务提交后才裁剪**，否则等于把数据完整性交给模型心情 |
| N2 | **读-改-写整文件覆写**（Turn1 Read → Turn2 Write，`checkpoint-writer.txt#L33-L37,#L114`） | 中间窗口内主 agent 的 append 会丢（**推断**），且无 CAS/版本号。我们已有 `mem.db` 事务与句子 id，应做「按 id 区间裁剪」而非整文件覆盖 |
| N3 | **无锁并发**（dream 与 writer 可同时动 notes.md；`dream.txt#L141` 仅提示词约定） | 最后写者胜，可能丢掉另一方的整合结果。dsh-memory 应保持「单写者 + 事务」 |
| N4 | **失败半写无隔离**（多 Edit 非原子；`quarantineCheckpoint` 是死代码，`checkpoint-retry.ts#L124-L131` 0 调用方） | 失败后文件可能处于半更新态且无人清理。我们的裁剪必须单事务，失败整体回滚 |
| N5 | **无「待提炼量」观测**（Q9 未找到） | 无法验收「清空是否生效」「积压多少」。dsh-memory 改造必须带可查询计数（如：未提炼句子数 / 已提炼未裁剪数），否则改完无法证明有效 |

### 4.3 给 dsh-memory 的落地建议（基于以上证据）

1. **不要学「清空」，学「裁剪」**：把笔记主题的句子按 `integrated_into`（目标主题 id）标记，dream 成功整合后**在同一事务里**删除/归档已标记句子，保留未标记的；这等价于 MiMo 的「路由后清空」，但原子且可回滚。
2. **加一条硬校验**：裁剪前后 `count(未标记句子)` 必须守恒（裁剪数 == 已标记数），否则拒绝提交——补上 MiMo 缺的那层代码兜底。
3. **加观测**：`memory_note` 的返回/状态行里带「本会话未提炼 N 条」，让清空可验收。
4. **保留「再路由」窗口**：裁剪前把未归类内容留在会话笔记里，下一次 dream 再处理（对应 `checkpoint-writer.txt#L58-L60`），不要一次清空所有。
5. **判重下沉**：工具层已有「同内容跳过」，再加「实质重复 → 引用已有句子 id」而非新增句子。
6. **必须同时修「笔记主题续期/归档」**：笔记主题也是主题库主题，而当前续期链路是死代码、写入不续期（既有审计已验证，见 §6 第 7-8 条）⇒ 只做裁剪不修续期，笔记主题仍会在 90 天后被归档，归档后 `appendSentence` 无状态检查会产出「僵尸主题」（写成功但永不注入/检索）。

---

## 5. 诚实缺口

**读了什么**
- 全文精读：`session/checkpoint.ts`（1792 行）、`session/prune.ts`、`session/checkpoint-templates.ts`、`session/checkpoint-paths.ts`、`session/checkpoint-validator.ts`、`session/checkpoint-retry.ts`、`session/checkpoint-progress-reconcile.ts`、`session/budgeted-read.ts`、`session/compaction.ts`、`agent/prompt/checkpoint-writer.txt`（167 行）、`agent/prompt/dream.txt`（155 行）、`memory/write-gate.ts`、`memory/paths.ts`、`memory/reconcile.ts`、`tool/memory.ts`、`tool/memory-path-guard.ts`、`plugin/checkpoint-splitover.ts`、`session/auto-dream.ts`、`cli/bootstrap.ts`
- 定向阅读：`session/llm.ts`（L100-L374，记忆指令 + Active recall）、`session/prompt.ts`（checkpoint/overflow/rebuild/dream 相关区段）、`session/message-v2.ts`（filterCompacted / checkpoint part）、`agent/agent.ts`（writer/dream 定义）、`actor/spawn.ts`（SpawnInput/MAX_PRE_REACT）、`config/config.ts`（checkpoint/memory/dream 配置）、`cli/cmd/tui/util/model.ts`（pending 占位符）、`session/session.ts`（remove）
- **dsh-memory 既有材料（按 Lead 指定必读）**：`docs/设计文档.md`（174 行，全文）、`docs/audit/digest-retire_AUDIT_2026-11-05.md`（327 行，定向读结论/§5 能力可达性）、`docs/audit/note-remind_AUDIT_2026-11-05.md`（239 行，定向读结论/表1/表2/G-0/G-9.2）、`docs/audit/lifecycle-exposure_AUDIT_2026-11-05.md`（395 行，定向读结论/表1/表2/表3）
- **MiMo 自身 spec**：`docs/compose/spec/checkpoint-writer-safety.md`（111 行，全文）

**没读 / 没验证**
- **未运行任何代码**：所有「会不会丢」「会不会半写」均为静态推断（已在正文标 **推断**），没有真机复现。
- 未读：`actor/spawn.ts` 全文（只读 SpawnInput 与 preStop 循环段）、`session/retry.ts`、`session/overflow.ts`（只用其导出）、`plugin/subagent-progress-checker.ts`、TUI 渲染细节、`memory/fts.sql`、`memory/curation` 等。
- 未查 git 历史：无法判断 `quarantineCheckpoint` 是「遗留死代码」还是「待接线」，也无法判断 v4 validator / v5 模板的漂移是回归还是进行中迁移。
- 未统计真实磁盘数据：没有实例级证据（本机无 MiMo 运行目录），无法回答「实际 notes.md 多大」「writer 清空成功率」。
- `dream.txt` 的 `[unverified]` / Patterns / Gotchas 节与 `MEMORY_TEMPLATE`（4 节）不一致：dream 会写 5 节，模板只有 4 节（`session/checkpoint-templates.ts#L60-L82` vs `dream.txt#L119-L125`）——发现但未展开，属另一个漂移点。

---

## 6. 已复用的既有结论（本报告不重复推导）

> 说明：本节列出从 dsh-memory 既有审计、`设计文档.md`、以及 MiMo 自身 spec 中**直接引用**或**明确排除**的点，避免 Lead 重复判断。
> 状态标记：**已验证** = 对方审计/实测已证，本轮复核代码一致或未反驳；**文档说的但代码/协议已变** = 不能再当现状用；**本轮推断** = 我基于代码补的，未运行。

### 6.1 直接引用（不必再推导）

| # | 既有结论 | 出处 | 状态 | 本报告如何使用 |
|---|---|---|---|---|
| 1 | 子代理机械摘要通道**已退役**（PASS-with-findings）；能力由「会话原文检索」承接：`session_search` 覆盖 585/585 会话，真机实测能取回已摘要会话的「任务+结论」原句 ⇒ 摘要删掉不丢信息 | `digest-retire_AUDIT_2026-11-05.md#L13`、`#L18`、`#L129-L178` | **已验证**（真机实测） | 回答「没有 note 的会话怎么办」：**靠原文日志按需检索，不靠 notes 长存**。这是「清空 notes」可行的外部前提 |
| 2 | 但前提有风险：会话日志保留策略**未文档化**；索引最坏滞后 ~1h、硬失败 24h 退避 | 同上 `#L120`（第 4 条）、`#L157` | **已验证**（1113 目录全有日志，但无保留承诺） | ⇒ **不能**把「原文可检索」当唯一兜底；裁剪仍须事务 + 可回滚（本报告 N4/4.3 建议 1-2） |
| 3 | 存量 pending=407 **直接丢弃不回填**（407×988≈40.2 万字，13.2× 明细上限） | 同上 `#L76`（B1） | **已验证** | 支持「不做历史回填、只做向前裁剪」；对 dsh 笔记同理：不迁移存量长主题，改为「已提炼标记 + 向前裁剪」 |
| 4 | `memory_note` 15% 档位提醒机制**正确**，但「档位消费与投递解耦」：入队即记账，投递失败**静默丢一档** | `note-remind_AUDIT_2026-11-05.md#L16`、`#L126`（第 5 条） | **已验证**（代码审计） | 借鉴其教训：裁剪必须「**事务提交成功后才记账**」，否则静默丢区间（=本报告 N1/N5） |
| 5 | 15% 这个数值**没有实测支撑**（G-0 仅部分支撑）；提醒通道寄生在回归提醒 FIFO、压缩后残留旧档位文案、队列无 TTL/generation | 同上 `#L40`、`#L50`、`#L57`、`#L82-L87` | **已验证** | **排除**「照搬 15% 阈值」与「把裁剪挂在提醒队列上」；裁剪应是独立事务路径，提醒只负责「让模型去记」 |
| 6 | 维护提醒注入频率 = **每宿主进程 1 次**（`maintenanceInjected` 进程级），不是每会话 1 次 | `lifecycle-exposure_AUDIT_2026-11-05.md#L75`（1.11） | **已验证**（与任务书前提不符） | **排除**「靠提醒驱动裁剪」：频率不足以承载清空动作 |
| 7 | 续期链路是**死代码**：`markHit()` 全仓 0 调用方、`last_hit_at` 573/573 NULL；`appendSentence` 只 bump `writeCount/updatedAt` ⇒ **写入不续期** | 同上 `#L37`、`#L38`、`#L95` | **已验证**（真库复算） | **直接影响本次设计**：笔记主题（`笔记·<wsKey>/<sid8>`）同样「有写入但不续期」 |
| 8 | `ARCHIVABLE_STATES` 决定 90 天自动归档；批量归档悬崖 **2027-01-27 = 338 条** | 同上 `#L51`、`#L36`、`#L117` | **已验证**（纯函数复算） | ⇒ 只做裁剪不修续期 = 笔记主题 90 天后仍被归档（见 §4.3 建议 6） |
| 9 | 归档后 `memory_search` 不再返回该主题（决策 13），但 `memory_read` 可读全文、`_export` 快照仍导出 | 同上 `#L78`（B3） | **已验证** | 说明「清空 notes 后至少还能 read 到」不成立——归档后检索不可见，只有指针 + read 兜底 |
| 10 | 归档 × 写入 = **僵尸主题**：`appendSentence` 无状态前置检查，归档后仍可写入成功、但永不注入/检索 | 同上 `#L100`（2.9） | **已验证** | 与第 7-8 条合起来构成本次改造的**硬约束**（§4.3 建议 6） |
| 11 | 写入通道唯一：`memory_dream_patch`；原生 `write/edit/apply_patch` 直写由独立 `tools/pre-execute` deny | `docs/设计文档.md#L56` | **文档说的但协议已变**（见 6.3-①） | 裁剪只能走 dream 通道；但「唯一入口」的具体名字已过期，按 AGENTS v4.5.1 应为 `memory_note`（主代理）/`memory_dream_patch`（dream） |
| 12 | 「不可删三闸」：`delete` 一律拒；净删 ≥200 字符且新文不含 `knowledge/` 指针一律拒 | 同上 `#L57` | **已验证**（文档描述；本轮未读 index.js L4304 实现） | **直接约束**：裁剪笔记句子若用 `delete` 会被闸拒绝 ⇒ 必须用 replace/归档/新增专用通道（**本轮推断**：具体实现需核 `index.js`） |
| 13 | 主题库容量三档：主主题 9000 / 明细 40000 / 索引 200000；明细与索引「天生会一直长」⇒ 只提示不催 | 同上 `#L87-L101` | **已验证** | **部分排除**「用超限治理解决笔记增长」：超限只提示，不裁剪，治不了 append-only |
| 14 | 事故教训：**禁止局部读取 + 整体覆写**，写记忆文件前必须读全量或用 edit 锚定 | 同上 `#L148` | **已验证**（真事故，曾把日档截断为 16 行） | **直接支持本报告 N2**：MiMo 的「Turn1 读 → Turn2 整文件 Write」正是这条教训的违例形态 |
| 15 | `split-oversized.mjs` 内置**守恒校验**（受影响主题句数/字符数前后必须相等） | 同上 `#L103-L108` | **已验证** | **借鉴**：裁剪也必须守恒校验（=§4.3 建议 2） |

### 6.2 MiMo 自身 spec（`docs/compose/spec/checkpoint-writer-safety.md`）

| # | 结论 | 出处 | 状态 | 用途 |
|---|---|---|---|---|
| 16 | writer 只能写 memory 树（S2.1），代码已实现 | spec`#L37-L48`；代码 `tool/memory-path-guard.ts#L37-L44` | **已验证（文档与代码一致）** | 支撑本报告 Q2「路径边界」 |
| 17 | 角色专属 invalid-output 策略 + `CHECKPOINT_COMPLETE` 标记（S2.3） | spec`#L62-L72`；代码 `session/prompt.ts#L3070-L3074` | **已验证** | 说明 writer 的「空输出」有专用恢复路径，不会误续父任务 |
| 18 | actor 终态错误 → actor 失败 → 水位不变（S2.4） | spec`#L74-L78`；代码 `session/checkpoint.ts#L976-L1021` | **已验证** | 支撑本报告 Q6「失败不动水位」 |
| 19 | **事务性多文件写入 / checkpoint hash / 写账本被明确列为 Out of Scope** | spec`#L94-L100`（S3 第 4 条） | **已验证（官方设计取舍）** | **本报告 N4 的最强证据**：非原子 + 无账本不是疏忽，是 MiMo 主动排除；借鉴清空必须自己补 |
| 20 | 事故：writer 被通用空输出提醒复活 + 沙箱缺失 ⇒ 改了项目源码（S1） | spec`#L29-L33` | **已验证** | **直接支持 N1**：MiMo 自己写明「prompt instructions and tool allowlists alone are insufficient」 |

### 6.3 文档说的但代码/协议已变（不要按文档当现状）

① **dsh 写通道**：`docs/设计文档.md#L56-L57` 描述「`memory_dream_patch` 是唯一写入通道、原生 write/edit 被 deny」。但 `~/.dsh/AGENTS.md`（内容修订 **4.5.1 / 2026-11-05**）已改为「**主代理只有 `memory_note`**；`memory_write` 对非 dream 一律 `WRITE_DREAM_ONLY`；`memory_archive_checkpoint` 已移除；子代理不写会话笔记」。⇒ 设计文档未同步，按它设计裁剪入口会踩空。
② **MiMo 内部漂移**（本报告正文已逐条标注，此处汇总）：`config/config.ts#L276-L279` 默认阈值描述（`["40%","60%","80%"]`）≠ 代码 `defaultThresholdsFor`（`session/prune.ts#L44-L51`）；`dream.txt#L10` 自称 manual ≠ 存在 auto-dream（`session/auto-dream.ts#L110-L121`）；`prompt/default.txt#L67` 称 writer 为 "fork agent" ≠ `cfg.checkpoint.fork` 默认 false（`session/checkpoint.ts#L758-L759`）；`checkpoint-validator.ts#L27-L36` 校验 v4 语汇 ≠ `checkpoint-templates.ts#L1-L58` 的 v5 模板；`dream.txt#L119-L125` 写 5 节 ≠ `MEMORY_TEMPLATE` 4 节（`checkpoint-templates.ts#L60-L82`）。
③ **「原文可检索」的前提**：`digest-retire` 的 §5 实测成立，但「日志保留」无承诺（`#L157`）——引用它时必须带这条前提。

### 6.4 对本次改造的净影响（3 条，已被上述结论锁定）

1. **「清空 notes」不能单独做**：必须先修续期/归档（§6.1 第 7-10 条），否则裁剪只是延缓，90 天后笔记主题照样被归档并变僵尸。
2. **不能靠「删句子」实现裁剪**：`delete` 被不可删三闸拒绝（§6.1 第 12 条），需走 replace/归档/专用通道，且必须守恒校验（第 15 条）。
3. **不能靠提醒或提示词驱动裁剪**：提醒频率是每进程 1 次（第 6 条）、MiMo 已证「提示词+白名单不足」（第 20 条）、其清空本身就是纯提示词且无兜底（本报告 Q1）⇒ 裁剪必须是代码级、事务性、可观测的。
