# CRA · v4.5.4 意图检查点质量修复（删序 / 整节指针 / prune）方案评审

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（工作副本 `index.js`；方案 `docs\方案-4.5.4-检查点质量.md`）。
- 只读：未改代码、未构建、未部署、未写数据库。按 CRA：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最终删序 + 最小 diff + 产出物判据）。

---

## 0. 结论（先给判断）

**修了再开工**：A 的方向正确但需明确最终删序；B 不能按“边删边加指针”实现；C 的前提不成立，应取消；另有一个注入端缺口必须一起修。

1. **P1 真实**：`INTENT_DELETE_ORDER`（`index.js#3132`）把「未决问题」排第一；超 3000 时先整节删它。真机 `03:37:35` / `03:38:17` 两次 `normalize ... dropped=未决问题`（monitor 实测）⇒ 最新检查点确实没有该节。A 必须修。
2. **P2 真实**：整节删除只留 `clog/monitor`，正文无残留；B 的方向对，但**实现顺序**决定会不会反而多删内容（见 §4）。
3. **P3 是测量口径错误，不是 prune 失效**：T-0493 **物理行 3 句，live/readTopic 只有 1 句**；前两句已在 `deleted.index` 墓碑中（sentenceId 32486/32581，`deleteSentence` 成功记录），当前 live 句是 32584（1,472 字）。注入走 `readTopic` live（`#15480/#15483`），不会混合三份；所谓“3,681 字”是物理行之和。**C 的“强制恒 1 句 / 历史收敛”应取消**；把展示/审计口径改成 live 即可。
4. **最终删序（推荐）**：`["文件与代码", "错误与修复", "任务与待办", "未决问题"]`（方案 A 的顺序）。理由见 §4.1：文件/代码最易从工作树/git 重新获得；错误/修复次之（日志/commit/测试）；任务/待办是用户意图，`todo_write` 只是部分兜底且 `下一步行动` 核心节通常只覆盖眼前一步；未决问题无任何兜底，最后删。
5. **B 的推荐实现**：先按删序删、再按 cap 裁，**最后**追加指针（推荐一条汇总指针；若逐节，最多 1-2 条），指针不计入分节 cap、不再触发删节；若 `out.length + pointer > 3000` 则缩指针/退化为汇总行，绝不为指针再删一节。
6. **注入端必须同步修**：`POST_COMPACT_REHYDRATE_BUDGET.checkpoint=2400`（`#15362`），而 `sectionAwareSlice` 的 priority 只有核心四节（`#15444/#15483`），「未决问题」是非优先；写端保住后，注入端仍可能在 2400 处把它切掉。建议把 `未决问题` 加进 priority（至少 `#15444/#15483`；启动摘要 `#17023` 同样加），并补一条“归一后仍含未决”的注入断言。

---

## 1. 表 1 · 调用链

| 环节 | 位置 | 说明 |
|---|---|---|
| 预算/删序常量 | `index.js#3131-3132` | `INTENT_TOTAL_BUDGET=3000`；`INTENT_DELETE_ORDER=["未决问题","任务与待办","错误与修复","文件与代码"]` |
| 8 节定义 | `#3120-3129` | 核心 4 节：本次目标 200 / 当前状态 400 / 下一步行动 200 / 关键结论 400；非核心：文件 300 / 错误 300 / 任务 200 / 未决 200（body cap；合计 2200） |
| 归一函数 | `#3164-3213` | 先按删序整节丢（`#3194-3205`），再按 cap 裁行（`#3206-3210`），最后 `residual` 标记（`#3212`） |
| **唯一生产调用点** | `#14932` | `spawnIntentCheckpoint` 内：`normalizeCheckpoint(sum, {sections, totalBudget, deleteOrder})`；`sum = norm.text`（`#14941`），随后写主题库/落盘 |
| 结构校验（前置） | `#14922` | `validateMdStructure` 在归一前要求 8 节；B 的指针节不会改变写前结构（指针是归一后产物） |
| 测试钩子 | `#3216-3219`, `#21669` | `__normalizeCheckpoint` / `__intentDeleteOrder` / `__intentTotalBudget`；仅测试/门使用 |
| 注入端 | `#2316-2372` `sectionAwareSlice`；`#15444`（本会话基线）、`#15483`（库内最新）、`#17023`（启动摘要） | 与写端独立；priority 目前 `["本次目标","当前状态","下一步行动","关键结论"]`，**不含未决问题** |
| 写主题库/prune | `#8549-8693`（当前行号；方案里的 `#7917/#7978-8039` 已漂移） | `p25WriteSessionTopic`：读 `readTopic` live → `extraIds=ss.slice(0,-1)` → replace/append → 删除 extraIds（`#8657-8672`） |
| live 读 | `memtopic/src/memory-store.mjs#1278-1315` | `readTopic` 走 `_liveSentences`，过滤 `deleted.index` 墓碑 |
| 删除实现 | `memtopic/src/memory-store.mjs#1405-1445` | `deleteSentence` 成功返回 `{ok:true,...}`；找不到/多命中抛错；**不物理删行**（task-41 墓碑设计） |
| 其他写入方 | `buildSummaryInjection` `#2835` / `SUMMARY_SLOT_BUDGET` `#2818`；合并维护/归档 | 用各自的 `sectionAwareSlice`/预算，**不调用** `normalizeCheckpoint`，改删序只影响意图检查点写端 |

**结论**：改 `INTENT_DELETE_ORDER`/`normalizeCheckpoint` 的影响面仅在 `spawnIntentCheckpoint` 的写端；不会改合并维护、归档、启动注入的删序（它们有各自 priority）。但归一后的正文会进入主题库并影响后续注入，故注入端要同步看。

---

## 2. 表 2 · 状态与预算

| 预算/状态 | 位置 | 关系 |
|---|---|---|
| `INTENT_TOTAL_BUDGET=3000` | `#3131` | 写端归一上限；**存储/写库**口径 |
| `INTENT_SECTIONS_8` caps | `#3120-3129` | body cap 合计 2200；加标题/前言约 2300，仍低于 3000 |
| `POST_COMPACT_REHYDRATE_BUDGET.checkpoint=2400` | `#15362` | **压缩后重灌注入**的检查点预算；写端 3000 的检查点到这里可能被截断 |
| `SUMMARY_SLOT_BUDGET.checkpoint=3000` | `#2818` | 另一条“摘要注入”槽（启动/摘要通道），与 2400 不同；勿混用 |
| 注入 priority | `#15444/#15483/#17023` | 只保护核心四节；`未决问题` 非优先，2400 截断时可能先被切 |
| `topicDbReadIntentSummary` | `#9165-9204` | `maxSentences:3`，但取 `readTopic` live；T-0493 live=1，实际只读最新 1 句 |
| `p25-prune` 状态 | `#8617-8672` | `extraIds` 来自**写前** live 句；只删这些旧 id；`pruned` 计数；`monitorEvent("intent","p25-prune ... left=...")` |
| T-0493 实测 | 真库副本 | raw `be.listSentences`=3；`store.readTopic`=1；`deleted.index` 2 条墓碑；`store.topics()` `sentences=1/physicalSentences=1` |

**结论**：A/B 改的是写端 3000 内内容；注入端 2400 + 非优先「未决问题」是独立的第二个丢信息点，必须一起修，否则“写端保住了、注入端又丢了”。

---

## 3. 表 3 · 边界

| 边界 | 行为/风险 |
|---|---|
| 输入恰好 3000 | 删序不触发；指针不产生；cap 后可能更短 |
| 输入 3001-3100，仅删一节就 ≤3000 | 指针若在删节循环内加入，可能把 `out` 推回 >3000，触发**额外删一节**（见 §4.2） |
| 核心四节自身超纲 | `residual=true`，保留残量；指针不应再挤压核心 |
| 未知子标题/前言很大 | 前言不参与 cap；指针/汇总行要计入最终 chars，防止超 3000 |
| 被删节正文很小/为空 | 指针成本可能大于被删正文；汇总指针更划算 |
| 指针放进节 body 再 cap | 指针可能被 `p2TrimSectionLines` 当尾部行删掉；必须最后追加 |
| 注入端 2400 | 归一后 >2400 时 `sectionAwareSlice` 按 priority 分配；未决非优先，可能被截断 |
| flag 关/库不可用 | `normalizeCheckpoint` 仍纯函数；写端落 md/库失败降级，不影响 A/B 逻辑 |
| 重试补火/并发 | 同一会话两次写入可能交错；prune 只删写前 `extraIds`，不删新句；强制“恒 1”若改成写后重读全删会误删新检查点 |
| T-0493 物理 3 / live 1 | 不是 prune 失败；不要用 raw SQL 句数做验收 |

---

## 4. 八项逐条

### 4.1 删除序：任务 vs 错误，推荐哪个？

**推荐最终删序：`文件与代码 → 错误与修复 → 任务与待办 → 未决问题`（方案 A）。**

按“信息重新获得的成本”：

1. **文件与代码**：工作树/git 可直接重查，路径和改动可从 `git status/diff` 恢复；最便宜，先删。
2. **错误与修复**：错误串/失败尝试/修复理由通常可从日志、commit、测试记录重查；但失败尝试未必全在 commit，成本中等；排在文件之后。
3. **任务与待办**：用户意图/backlog；`todo_write` 是部分兜底，但工具列表可能已被更新/清空；`下一步行动` 核心节通常只覆盖眼前一步，不能替代全部 backlog；比错误更该保，故在错误之后删。
4. **未决问题**：没有工具兜底，丢了就是永久丢失；且是接续时最需要的“未知/待确认”；最后删。

**关于“任务与待办会先被删”**：在新序里它确实排在未决之前，但排在错误之后；这是有意的取舍——错误可从历史重建，任务/未决更偏“未来意图”。若预算只够保一个非核心节，保未决；若还够，保任务；错误和文件先让位。另建议：若 `下一步行动` 为空，模型输出本身已不合质量预期，可在提示词/校验层单独要求，不应靠删序兜底。

### 4.2 B 指针：加指针会不会导致更多内容被删？

- **定量**：8 节 cap 合计 2200；标题约 68；前言（`## 检查点...`）约 60；即使 4 节都加 40 字指针，理论上限约 2200+68+60+160=**2488 < 3000**。因此**若指针在删节/裁行全部结束后追加**，不会挤掉已保留内容（最终仍 <3000）。
- **但若按“边删边加指针”实现**：删节循环的停止条件变成 `out.length <= 3000`，而 `out` 已含指针；存在 40-160 字“带”：
  - 例：删完第一节后正文 2980（本可停止），加指针 40 ⇒ 3020 > 3000 ⇒ 循环继续删下一节（如任务与待办）。**净效果更差**。
  - 4 节累计指针 160，触发带更宽；这正是方案 B 的核心风险。
- **推荐实现**：
  1. 先按删序删（不含指针）→ 再按 cap 裁 → 得到 `out`；
  2. 最后追加指针：
     - 优先**一条汇总指针**：`（因预算压缩：文件与代码/错误与修复/任务与待办；原文用 session_search sid8=<sid8> 回溯）`，约 60-80 字；
     - 若坚持逐节：仅在 dropped 数 ≤2 时逐节，否则汇总；指针放在所有节之后（footer），不放进节 body，避免被 cap 裁掉；
  3. 若 `out.length + pointer > totalBudget`：缩短指针/只保留 `session_search sid8=` 短句，**绝不再删一节**；
  4. `normalizeCheckpoint` 返回 `chars` 应包含指针，验收按 `<=3000`（不是 3000+指针）。
- **替代方案**：只给“未决问题”留一行指针（若它被删），其他节不 pointer；信息价值最高、成本最低。若 A 已把未决保到最后，通常只有文件/错误/任务被删，汇总一行足够。

### 4.3 prune 为何“失效”？（实际未失效）

- 方案说 T-0493 “3 句 / 3,681 字”，实测：
  - 物理后端 `be.listSentences("T-0493")` = **3**（ids 32486/32581/32584）；
  - `store.readTopic("T-0493").sentences` = **1**（32584，1,472 字）；
  - `deleted.index` 有 2 条 T-0493 墓碑（32486/32581，`deleteSentence` 审计成功）；
  - `store.topics()` T-0493 `sentences=1/physicalSentences=1`。
- `deleteSentence` 是 **task-41 墓碑语义**：不物理删行，只写 `deleted.index` + audit；`readTopic/topics/export` 全部按 live 过滤（`memory-store.mjs#411-443`、`#1278-1315`）。所以 raw SQL 看到 3 句是**历史物理行**，不是 live 检查点；注入端 `latestSessionSummary`/`dbCheckpointSlice` 取 `readTopic` live（`#9192`、`#15480`），不会混合三份。
- `p25WriteSessionTopic` 的 prune（`#8617-8672`）在 T-0493 上已生效过：`extraIds` 删除成功，`left=1`；`_dr.ok !== false` 不是问题（`deleteSentence` 只会返回 `{ok:true}` 或抛错，没有 `{ok:false}` 分支，`memory-store.mjs#1405-1445`）。
- 结论：**P3 不是 prune bug**；方案中的 `#7917/#7978-8039` 行号也已漂移到 `#8549/#8611-8672`。C 的“强制恒 1 / 历史收敛”取消；只需把验收口径改成 `readTopic().sentences.length`，并把 raw SQL 计数改名为 physical。
- 若未来出现 live>1，最可能的真实机制是：会话主题 `parentId` 不匹配导致 `topic` 查不到 → `seedTopic` 复用同名主题 + `appendSentence`（append 分支不做 prune），或 `readTopic` 抛错导致 `old=""`；不是 `deleteSentence` 的 `ok` 判据。应先查 `store.topics().find(...).parentId` 与 `readTopic`，不要先改 prune。

### 4.4 状态交互：3000 与 2400

- 写端归一 3000；压缩后重灌 `cp=2400`；两者不是同一预算。归一后 3000 字检查点在注入时会被 `sectionAwareSlice` 再裁一次；`未决问题` 不在 priority，可能被切。
- 实测/模拟：新删序 + 事后指针的 4,421 字样例，归一后 1,434 字 + 指针 159 = 1,593，远低于 2400；T-0493 live 1,472，也低于 2400。因此正常情况不会触发；但**不能依赖“通常很短”**，应加 priority 并做 3000 字上限回归。
- `SUMMARY_SLOT_BUDGET.checkpoint=3000` 是启动摘要槽，不是压缩重灌槽；不要用 3000 去解释 2400。

### 4.5 调用链/其他写入方

- `normalizeCheckpoint` 唯一生产调用是 `#14932`；`#3216/#21669` 是测试钩子；没有合并维护/归档调用。改删序不会影响 `buildSummaryInjection`、`sectionAwareSlice` 的合并维护/归档路径。
- 但归一结果会写入主题库/`sum`，后续注入端读它；所以注入端 priority 要同步改。
- 方案里 `#7917` 等行号已过时；当前 `p25WriteSessionTopic` 在 `#8549`，prune 在 `#8611-8672`。

### 4.6 prune 修复风险（若仍要动）

- 若“写后重读所有句，只留最后一句”会误删并发写入的新检查点：A/B 两个 writer 都可能 append/replace，后完成者把对方的新句当 extra 删除。
- 护栏：只删**写前 readTopic 读到的** `extraIds`（当前做法，`#8619`）；写入与 prune 放同一 `runInTransaction` 或用 per-sid promise 锁；写后只复核 `left`，不按“全部但最后”重新删；失败 `monitorEvent` 留痕并下次重试；绝不用 raw 物理句数判断。
- 由于 T-0493 live=1，C 不需要做；以上仅作为未来 live>1 的护栏。

### 4.7 历史收敛

- **不要删/不要归档**：T-0493 的两句已经是 tombstone（物理保留、read 过滤），删除物理行会破坏 `historicShas` 防复活/审计；再建“历史检查点”主题是重复存储。
- 当前 live 1；不需要迁移。若 UI/审计要显示，改用 `readTopic().sentences.length` 或 `store.topics().sentences`（live），把 raw SQL 计数标注为 physical。
- 若未来确实 live>1：优先“只注入最新 live + 保留物理 tombstone”，而不是删历史；归档主题只在需要人读历史时另建，且不能替代 audit。

### 4.8 影响面

- **写入字节**：会变（删序/指针）；只影响意图检查点主题，不改 schema/DB 迁移。
- **注入**：压缩后重灌是**动态尾部**（`buildPostCompactRehydrate` 的 checkpoint 段），不是稳定前缀；改内容不会动 `global.md/index.md` 前缀缓存。启动摘要也是动态注入；无稳定前缀影响。
- **门测试**：`test/_p2-selftest.mjs` 的 S6/N1/N4/N5 明确断言旧删序，必须更新；`test/_accept-p2.mjs` 的 B4/B5/B9/B12/B13 也要改；否则门必挂。`_accept-p4` 不直接调 normalize，但注入断言建议补“未决仍在”。
- **注释**：`#15449` 仍写“存储端已放宽到 8000 字（INTENT_TOTAL_BUDGET）”，与实际 3000 不符（`#3115` 已说明 8000 回退）；顺手修正，避免下一位误读。
- **UI/客户端**：无影响；不改 client bundle。

---

## 5. G-9.1 产出物判据（可执行）

### 5.1 归一单测（4000 字构造）

在 `test/_p2-selftest.mjs` 增加/更新断言，或临时跑：

```powershell
cd 'E:\工具\插件开发调整\dsh-memory-plugin'
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL('./index.js').href);
const T = ['本次目标','当前状态','下一步行动','关键结论','文件与代码','错误与修复','任务与待办','未决问题'];
const sizes = {本次目标:200,当前状态:400,下一步行动:200,关键结论:400,文件与代码:600,错误与修复:500,任务与待办:500,未决问题:1400};
const text = T.map(n=>'## '+n+'\n'+('内容'.repeat(Math.ceil(sizes[n]/2)))).join('\n\n');
const r = m.__normalizeCheckpoint(text, {sections:m.__intentSections8, totalBudget:m.__intentTotalBudget, deleteOrder:m.__intentDeleteOrder, sid8:'1b736c53'});
console.log(JSON.stringify({chars:r.chars, dropped:r.dropped, hasUnresolved:r.text.includes('## 未决问题'), hasPointer:/session_search sid8=/.test(r.text)}));
"
```

**期望**：
- `hasUnresolved: true`（「未决问题」节仍存在）；
- `hasPointer: true`（含 `session_search sid8=1b736c53` 的指针行）；
- `chars <= 3000`（若指针计入 3000；若按“3000+指针”口径也必须 ≤3160，推荐前者）；
- `dropped` 包含 `文件与代码/错误与修复/任务与待办`，**不包含 `未决问题`**；
- 再跑 `node test/_p2-selftest.mjs`，期望 `PASS`（更新 S6/N1/N4/N5 后）。

### 5.2 注入端判据

```powershell
# 构造 3000 字归一检查点（含未决），走 sectionAwareSlice/ buildSummaryInjection 钩子
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL('./index.js').href);
const text = '## 本次目标\nA\n## 当前状态\nB\n## 下一步行动\nC\n## 关键结论\nD\n## 未决问题\nE-' + 'X'.repeat(2800);
const s = m.__sectionAwareSlice ? m.__sectionAwareSlice(text, 2400, 'test', {priority:['本次目标','当前状态','下一步行动','关键结论','未决问题']}) : null;
console.log(s ? JSON.stringify({len:s.text.length, hasUnresolved:s.text.includes('## 未决问题')}) : 'no hook');
"
```

**期望**：`hasUnresolved: true`；若未加 priority，此断言应 **FAIL**，证明 §0.6 的注入缺口。

### 5.3 T-0493 live 口径（证明 P3 非问题）

```powershell
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const src=path.join(os.homedir(),'.dsh','memory','.memtopic','mem.db'); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cra-')); const cp=path.join(dir,'m.db');
const db=new DatabaseSync(src,{readOnly:true}); db.exec('VACUUM INTO \\''+cp.replace(/'/g,\"''\")+'\\''); db.close();
const {SqliteBackend}=await import('file:///E:/工具/插件开发调整/dsh-memory-plugin/memtopic/src/backend-sqlite.mjs');
const {MemoryStore}=await import('file:///E:/工具/插件开发调整/dsh-memory-plugin/memtopic/src/memory-store.mjs');
const be=new SqliteBackend(cp); const st=new MemoryStore(be);
console.log(JSON.stringify({raw:be.listSentences('T-0493').length, live:st.readTopic('T-0493').sentences.length, topSent:st.topics().find(t=>t.id==='T-0493').sentences}));
"
```

**期望**：`{"raw":3,"live":1,"topSent":1}`；若 raw 3 被当成 live 3，就是方案 P3 的误判。

---

## 6. G-9.2 反面问题（≥3）

1. **指针边删边加 → 反而多删一节**：删到 2980 后加 40 字指针变 3020，循环继续删任务与待办；4 节指针累计 160，触发带更宽。必须“先删/裁、后加指针”。
2. **删序把任务与待办提前**：若 `下一步行动` 为空（T-0493 最新就是 0 字），任务节被删后，下一会话不知道未完成任务；`todo_write` 不一定覆盖旧 backlog。A 已让错误先于任务删，但仍需在提示词/校验层保证 `下一步行动` 非空。
3. **写端保住、注入端仍丢**：`POST_COMPACT_REHYDRATE_BUDGET.cp=2400` + `sectionAwareSlice` priority 不含未决；3000 字归一结果被 2400 截断时未决可能被切，验收若只看写库会漏。
4. **指针放进节 body 被 cap 裁掉**：`p2TrimSectionLines` 从尾部删行，指针作为节尾最容易被删；必须作为 footer 追加在 cap 之后。
5. **测试/门未更新**：`_p2-selftest` S6/N1/N4/N5、`_accept-p2` B4/B5/B9/B12/B13 仍断言旧删序，A 一改必挂；发布门会被误判为回归。
6. **强制 prune/历史收敛误删**：并发写时“写后重读只留最后一句”会把另一个 writer 刚写的新句删掉；删物理 tombstone 会破坏历史 sha 防复活与审计。T-0493 live 1，本就不需要 C。
7. **指针 sid8 错误/为空**：`session_search sid8=` 指向不存在会话，读者无法回溯；指针要带当前 `sessionId` 的 `sid8`，缺省用 compactionId 兜底。
8. **预算口径混用**：把 `SUMMARY_SLOT_BUDGET.checkpoint=3000` 当压缩重灌 2400，或把 `INTENT_TOTAL_BUDGET=3000` 当注入预算；会误判“已经够/已经被截”。

---

## 7. 最小 diff

1. `index.js#3132`：`INTENT_DELETE_ORDER` 改为 `["文件与代码","错误与修复","任务与待办","未决问题"]`。
2. `index.js#3164-3213`（`normalizeCheckpoint`）：
   - 删节/裁行完成后（`#3211` 之后）追加指针（推荐汇总一行；若逐节，最多 1-2 条），指针不计 cap；
   - 新增 `opts.sid8`；返回 `pointers`/`droppedChars`（可选）；`chars` 包含指针；
   - 若 `out.length + pointer > totalBudget`，缩短指针，不再删节；
   - 保持 `dropped` 仍只记节名，日志加 `droppedChars`。
3. `index.js#14932`：调用传 `sid8`（已有 `sid8` 变量 `#14910`）；`#14934-14940` 日志/monitor 加 `droppedChars`。
4. 注入端 `#15444`、`#15483`、`#17023`：`priority` 增加 `"未决问题"`；`POST_COMPACT_REHYDRATE_BUDGET.checkpoint` 保持 2400（先加 priority，再按验收决定是否升）。
5. 测试：`test/_p2-selftest.mjs` S6/N1/N4/N5；`test/_accept-p2.mjs` B4/B5/B9/B12/B13；新增“指针行 + 未决仍在 + chars<=3000”断言。
6. 可选：修正 `#15449` 的“8000 字”过期注释。
7. **不做**：C 的强制 prune/历史迁移；不改 `memory-store` 墓碑语义；不改 client/UI。

---

## 8. 验证与缺口

**验证**：
- `node test/_p2-selftest.mjs`、`node test/_accept-p2.mjs`：更新断言后 PASS；旧断言在 A 后应失败，证明测试确实覆盖删序。
- §5.1 4000 字构造：未决仍在 + 指针行 + ≤3000。
- §5.2 注入：2400 截断后未决仍在（加 priority 后）。
- §5.3 T-0493：raw=3/live=1；不要用 raw 做 prune 验收。
- 并发：两个 writer 同时写同 sid，最终 live=1 且最新内容不被误删；monitor `p25-prune left=1`。

**缺口**：
- 未改代码/未跑实现后真机；§5 命令为建议脚本，需实现后按实际 hook 调整。
- T-0493 数据来自真库副本快照；`deleted.index` 是历史墓碑，未逐条核对删除时刻的写入日志（但 live=1 与墓碑存在已足够证明 prune 成功）。
- 方案中的行号 `#7917/#7978-8039` 已漂移，报告用当前 `#8549/#8611-8672`。
- 注入端 2400 截断行为用 `sectionAwareSlice` 代码推断 + 模拟，未跑真实 3000 字重灌端到端。
- 删序对“任务 vs 错误”的取舍是信息成本判断，不是硬数据；建议用真实会话样本（含 `下一步行动` 为空/非空）各跑 10 例验证。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
