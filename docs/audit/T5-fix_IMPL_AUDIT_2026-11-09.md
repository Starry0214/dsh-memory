# T5 修复实现 · 第二轮 CRA 复核（2026-11-09）

- 审计对象：**已完成的实现**（工作区未提交改动）。仓库 `E:\工具\插件开发调整\dsh-memory-plugin` · main · HEAD `e0a9be5`。
- 待审：`index.js`（`git diff` +141/−21）、`p3-triggers.js`（**git 未跟踪**，直接读全文 235 行）、新增 `_test-t5-fix.mjs`、`test/_p3-triggers-selftest.mjs`（+18 行）。
- 对照物：方案 `docs/方案-4.5.10-T5三缺陷修复.md`（含 §9 修订 v2）、第一轮审计 `docs/audit/T5-fix_AUDIT_2026-11-09.md`（M1–M8）、实现自述 `docs/audit/T5-fix_IMPL_2026-11-09.md`。
- 方式：**只读**。未改代码、未构建、未部署、未提交、未跑 `_run-suite.mjs`（避免改写 `docs/门套件结果.md`）。除本文件外未写任何文件。
- 行号口径：`文件:行`，均为**当前工作区实测**行号。凡「实测」均来自本轮独立执行（不采信实现自述）。

---

## 结论（通过 / 有条件通过 / 驳回）

**有条件通过。**

三缺陷的修复**实质成立**（不是"看起来做了"）：归档过滤真的前移且用循环内 `sid`、cid 真的每会话唯一、记账真的三态可分。门禁无新增红（35→36 门、10 处不达标逐条一致），三个测试脚本实测与自述**完全吻合**（28/55/98），G-9 的"修复后"首行我独立算出来是 `p3e-bca1`（长度 89 不变，与第一轮预测一致）。

但实现**没有把第一轮审计的两条单通道承诺真正闭合**，且产出物清单有遗漏。共 **6 条必须修改项**（MF1–MF6），其中 MF1/MF2 是同一条**未被覆盖的 queued 路径**（第一轮审计 F5/M11 的跨工作区写错，自述声称已用 `intentRetryClear(cid)` 关闭，实际只关了「直接失败」那一半）：

| # | 级别 | 一句话 |
|---|---|---|
| **MF1** | **中（必须）** | queued → 队列排空失败 ⇒ 仍入 `.integrate.json` 重试队列 ⇒ `fireIntentRetry` 用触发者 agent 当父 ⇒ **跨工作区线污染**（自述「G12 单通道」未覆盖此路径） |
| **MF2** | **中（必须）** | queued → 队列排空成功 ⇒ `checkpointAt` 永不置位 ⇒ M5 的 2h 自愈把已交付的会话**再写一遍**（重复子代理/tokens/覆盖同主题句） |
| **MF3** | 中低（必须） | `readArchivedSessionIds` 读失败时**不刷新 `cache.at`** ⇒ 持久损坏期间**每会话重读 56KB + 每会话一条 `archived-read-fail`**（M7 想挡的事件洪泛换了个门进来） |
| **MF4** | 中（必须） | `p3-triggers.js` **git 未跟踪** ⇒ 本批 A 改动（`isArchived`/`maxIdleMs`）**无法用 git 回滚、无法用 diff 审** |
| **MF5** | 中低（必须） | 新门 `_test-t5-fix.mjs` 28 条断言里 **10 条是 grep 级静态断言**，M4/M6/M7/G9/G10/G12 的行为验收**一条没测**；门在 sweep 完全没接线时也会全绿 |
| **MF6** | 低（必须声明） | G-9 产出物清单遗漏：`.monitor.json` 新增 `endFiredAt`、新 note 词表、`.integrate.json` 重试条目被删、payload/manifest 重生成；且 payload 缺 4 个 P3 模块（pre-existing）会把缺陷带进 4.5.10 发布物 |

**不驳回的理由**：MF1/MF2 所在路径在修复前**同样会重复写**（甚至更频繁：每小时重试），本批是**改善而非回归**；MF3/MF5 是"护栏没落到行为层"；MF4/MF6 是交付物/仓库卫生。核心目标（三缺陷）已达成且有独立证据。

---

## M1–M8 逐条核对（实现位置 + 是否达标 + 证据）

### M1 · 归档判定用循环内 `sid`、在 `p3SessionState` 之前、每 tick force 一次 —— **达标**

| 要求 | 实现位置 | 判定 |
|---|---|---|
| 用循环内 `sid`，不用 `isArchivedAgent(ag)` | `index.js:21302` `readArchivedSessionIds().has(sessionIdKey(sid))` | ✅ 全仓 `isArchivedAgent` 唯一调用点仍是 `pickSpawnParent`（`13290`），sweep 内不再出现 |
| 在 `p3SessionState` 之前（R10） | `index.js:21302-21304`（archived 判定在 `p3SessionState(sid)` 之前，`continue` 早退） | ✅ 归档会话不再建/刷 `p3.sessions` 条目 |
| 每 tick force 一次（D-5） | `index.js:21296` `readArchivedSessionIds({ force: true })`，在循环外、`for` 之前 | ✅ 每 tick 恰好 1 次；随后每会话的 `readArchivedSessionIds()`（`21302`）因 `at=now` 命中 30s TTL，**不会** N 次读盘 |

**键格式一致性（第一轮未能静态证明的点，本轮实测证明）**：`walk()` 用 `sessionIdKey(id)` 存**去前缀**键（`index.js:7017`）；`sessionIdKey` 只剥 `^session-`（`6962`）。实测 `~/.dsh/memory/.monitor.json` 的 `p3.sessions` 键**两种形式并存**（48/293 带 `session-`、245/293 是裸 uuid），而 `sessionIdKey()` 对两种形式都归一到同一键 ⇒ **M1 对两种键形式都成立**，不存在"看起来过滤了其实永不命中"的静默失效。实测归档清单 508 条与 `p3.sessions` 交集 = **23**，与第一轮审计估计一致。

**证据（本轮实测）**：`p3.sessions` 键样例 `session-0ff4d999-…` 与 `e4436494-…`；`archivedSessionIds` 样例 `session-b4647512-…`；`sessionIdKey` 匹配命中 23。

### M2 · 读失败不得用空集覆盖缓存 + 留痕 —— **达标，但有衍生缺陷（见 MF3）**

- `parsed` 标志：`index.js:7008` 声明、`7022` 仅解析成功后置 `true`、`7029` 仅在 `parsed` 时写缓存 ⇒ **解析异常不会覆盖缓存**。✅
- 非首轮（`ARCHIVED_IDS_CACHE.at > 0`）：`index.js:7027` `return ARCHIVED_IDS_CACHE.set`（返回旧集合，不清空）。✅
- 首轮（`at === 0`）：不 return，走到 `7030` 返回空 `set`，且**不写缓存** ⇒ fail-open 可见。✅ 与第一轮 G2 要求一致。
- 留痕：`index.js:7026` `monitorEvent("p3","archived-read-fail …")`，外层再包 `try/catch`。✅
- `monitorEvent` 是否会破坏读取路径：`monitorEvent` 是**函数声明**（`index.js:5736`，hoisted，早于 `7001` 定义位置生效），内部整体 `try/catch`（`5807`），且此处再包一层 `try/catch`（`7026`）⇒ **不会因未定义/抛错破坏读取路径**。✅ 实测 `_test-t5-fix.mjs` 的 G2 三例全绿亦佐证。
- ❌ **衍生缺陷**：失败分支 `7027` **提前 return，不刷新 `ARCHIVED_IDS_CACHE.at`** ⇒ 负缓存失效，`workspace.json` 持续损坏时每次调用都会重读 56KB 并再发一条事件；sweep 里 `21302` 是**每会话**调用 ⇒ O(N) 读盘 + O(N) 事件/小时。详见 MF3。

### M3 · `p3SessionEndCid` 纯函数 + `__p3Hooks` 模块作用域可 import + export 位置合法 —— **达标（格式判据有偏差）**

- 纯函数：`index.js:6978-6981`，零 I/O、零时钟（`now` 由入参传）。✅
- 测试钩子：`index.js:6994-7000` `const P3_TEST_HOOKS = {...}; export { P3_TEST_HOOKS as __p3Hooks };` —— 两条都是**模块顶层**（列 0），`export {…}` 声明在 ESM 模块体任意顶层位置合法。✅
- **不经 apply 可 import**：实测 `_test-t5-fix.mjs` 只 `import` 就拿到 `mod.__p3Hooks`（`_test-t5-fix.mjs:35-39`），从未调用 `apply` ⇒ 成立。✅
- sweep 已改用纯函数：`index.js:21327` `p3SessionEndCid(sid, now)`；旧拼接 `"p3e-" + sid.slice(0, 8)` 已从 T5 路径消失（`_test-t5-fix.mjs:90` 静态断言 + 我 grep 确认仅 T1 的 `21259` 还留着 `sid8`）。✅
- ⚠️ **与第一轮 G3 的字面判据有偏差**：G3 要求输出匹配 `/^p3e-[0-9a-z]{8}-[0-9a-z]+$/`。`sid8Of`（`6968-6971`）只做 `replace(/^session-/,"").slice(0,8)`，**不校验 hex**：`sid=""` ⇒ `p3e-anon-<b36>`（第二段 4 字符）；`sid="session-x"` ⇒ `p3e-x-<b36>`。真实 sid 是 UUID，第二段恒 8 位，**生产路径成立**；但门自己用的是放宽版正则（`_test-t5-fix.mjs:47,51`），并未按 G3 原判据断言。

### M4 · 三态记账（ok/dup/queued/fail）自洽 + note 不被 p3-cost 误计 —— **达标**

| 分支 | 代码 | `n` | `ok` | `fail` | `note` | 自洽性 |
|---|---|---|---|---|---|---|
| 写成功 | `21338-21340` | `(ok&&!dup)?1:0` = 1 | 1 | 0 | `session-end` | ✅ |
| 幂等命中（dup） | 同上 | 0 | 1 | 0 | `session-end-dup` | ✅ 符合 D-1「不算失败也不算一次写」 |
| 忙入队（queued） | 同上 | 0 | 0 | 0 | `session-end-queued` | ✅ 符合 G6「queued 不记 fail」 |
| 失败 | 同上 | 0 | 0 | 1 | `session-end` | ⚠️ 与"写成功"共用 `note`，仅靠 `ok=0` 区分；G13 要求"至少覆盖三种"已满足，但**失败与成功 note 同名**，面板按 note 聚合时无法直接分离（可接受，`ok` 可分） |

- db 分支 dup：`index.js:15209-15222` —— `trigger: _dup ? "I-dup" : "I-ok"`、`ok:1`、`n:0`、`note:"intent-dup-skip"`（带 `-retry` 后缀变体）。✅ 与 D-1/G5 完全一致。
- **`p3CostBump` 的 note 不会被 `p3-cost.js` 误计**：`matchTrigger` 只认 `^(T[1-6])\b`（`p3-cost.js:282-286`）。`session-end*` / `intent-dup-skip` / `intent-ok-db` 均不以 `T1..T6` 开头 ⇒ 不会误入触发档位。T5 外层事件带 `trigger:"T5"`（在 `TRIGGER_LEVELS` 内，`p3-cost.js:44/301`）⇒ 正确归 T5；`I-dup` 不在表内 ⇒ 落 `other`（与修复前 `I-ok` 同待遇，**不破坏档位统计**）。✅
- 观察（非缺陷）：dup 时把 `outChars`/`estTokens` 置 0（`15219-15220`）——dup 时子代理**确实生成了正文**（`durMs` 仍记 23s 量级），此处选择"不记产出"是口径判断，会让"生成量"账本低估。建议在文档里写明口径。

### M5 · `endFiredAt` 写入时机 + 自愈条件（含旧格式） + `.monitor.json` 影响 —— **部分达标（自愈盲区见 MF2）**

| 要求 | 实现 | 判定 |
|---|---|---|
| `endFiredAt` 字段 | `index.js:5822` 默认对象加 `endFiredAt: 0`；`21325` 在 `endFired=true`（`21324`）**之后、spawn 之前**写入 `now` | ✅ 时机正确：崩溃发生在 spawn 期间时 `endFiredAt` 已随 500ms 防抖落盘 |
| 复位时清 `endFiredAt` | `21330`（input 过短）、`21347`（失败）、`21354`（reject）、`21308`（自愈）、`15131`（队列淘汰） | ✅ 五处全覆盖 |
| 自愈条件 | `6986-6991`：`endFired===true && !(checkpointAt>0) && (now-endFiredAt>2h)`；旧格式无 `endFiredAt` ⇒ `true` | ✅ 与 M5 规格逐字一致 |
| 自愈接入 | `21306-21309`，在 archived 判定**之后**（归档条目不参与自愈） | ✅ 顺序正确 |
| 自愈可观测 | 计入 `healed`，并入 `21357-21360` 汇总日志 | ✅ 符合 M7 |
| `.monitor.json` 影响 | 新增 `p3.sessions[*].endFiredAt`（持久字段） | ⚠️ **未列入 G-9 产出物清单**（见 MF6）；旧代码忽略该字段 ⇒ 回滚安全 |

**旧格式批量自愈（burst）风险 —— 实测本机为 0**：`~/.dsh/memory/.monitor.json` 实测 `p3.sessions` 293 条，其中 `endFired=true` **29 条，且 29 条全部 `checkpointAt > 0`** ⇒ `endFired && !checkpointAt` 的条目 **0 条**（旧格式命中的也是 0 条）。首 tick 不会 burst。即使其他安装存在 N 条，`T5_MAX_PER_SWEEP=3` 会把单 tick 上限压到 3，最多 `ceil(N/3)` 个小时排空（本机为 0，无影响）。

❌ **自愈盲区（MF2）**：`p3T5ShouldHealEndFired` 只看 `checkpointAt`，但 **queued 路径成功交付后从不写 `checkpointAt`**（`21345` 显式留空；队列排空在 `15257-15263`，`spawnIntentCheckpoint` 内部也不碰 `p3SessionState`）⇒ 一个**已经写成功**的检查点会在 2h 后被判为"丢失"并**重写一遍**。

### M6 · cap=3 `break` 位置 + `INTENT_PENDING` 去重/淘汰留痕 + 淘汰复位 `endFired` 作用域 —— **达标（有一处计数瑕疵）**

| 要求 | 实现 | 判定 |
|---|---|---|
| cap=3 | `index.js:6983` `const T5_MAX_PER_SWEEP = 3`；`21300` `if (fired >= T5_MAX_PER_SWEEP) break;` | ✅ 位置在**循环体首行**，`break` 在 `try` 内合法地中断 `for…of`；`fired` 仅在 `21331`（输入长度校验通过后）自增 ⇒ 不会被"输入过短"的会话白吃额度 |
| 去重留痕 | `15136-15139` `pending-dedupe <cid8>`（`else` 分支） | ✅ 修复前是静默 `return` |
| 淘汰留痕 | `15123-15133` `pending-evict <cid8>` | ✅ |
| 淘汰复位 `endFired` | `15130-15131` `p3SessionState(_evVal.sessionId)` → `endFired=false; endFiredAt=0` | ✅ **作用域可达**：`p3SessionState` 是**模块级**函数（`5817`，列 0），淘汰代码在 apply 闭包内（缩进 4），闭包可访问模块作用域；`intentRetryClear`（`13231`）与 `p3SessionEndSweep`（`21289`）同为 apply 函数体内缩进 4 的**函数声明**，同一作用域（`agentsBySession` 在 `13270` 缩进 4 被 sweep 的 `21297` 使用即为同域证明） |
| 淘汰复位是否有副作用 | 对 T1/T4/dream 的队列条目也会复位其 `sessionId` 的 `endFired` | 可接受：复位只会让 T5 更可能重试，且 `checkpointAt>0` 时 `decideSessionEnd` 仍会 `has-checkpoint` 拦掉 |

- ⚠️ 计数瑕疵：`break`（`21300`）在归档/过期计数（`21303`/`21321`）**之前** ⇒ 一旦 `fired` 达 3，后面的归档/too-old 不再计入 `archivedSkipped`/`tooOldSkipped`，`21359` 的 `t5-skip archived=…` 会**偏小**。只影响观测，不影响行为。

### M7 · 归档跳过日志每 tick 汇总一条 —— **达标（但事件洪泛另开了一道门，见 MF3）**

`index.js:21357-21360`：`if (archivedSkipped>0||tooOldSkipped>0||healed>0) monitorEvent("p3","t5-skip archived=<k> too-old=<m> healed=<h>")` —— **循环外、一条**，字段与 M7 规格逐字一致。✅ 循环内**没有**任何按会话的跳过日志。

### M8 · 基线文件与 G-9 判据成立 —— **达标（G-9 清单不完整，见 MF6）**

**基线真实性（本轮独立核验）**：`_run-suite.mjs:67` 用 `fs.existsSync` **动态发现** `test/*.mjs`，门清单由目录扫描构建（`_test-t5-fix.mjs` 在 final 才出现）。因此 `_verify/suite-baseline-pre-t5fix-20261109.txt` 显示 **35 门**即证明它产生于 `_test-t5-fix.mjs` 创建之前 ⇒ **基线确为修复前**。`清单锁 index.js C404B8760BB3C59B` 两文件相同不矛盾：该值读自静态文档 `docs/冻结清单-20260919.md`（`_run-suite.mjs:75-86`），**不是**从 `install-manifest.json` 现算的。

**基线 vs 最终逐行比对（`Compare-Object`，仅 3 行差异）**：

```
< 门套件：共 35 个文件 …            > 门套件：共 36 个文件 …
< ❌ _gate-plugin-load  FAIL 1 / PASS 109   > ❌ _gate-plugin-load  FAIL 1 / PASS 110
                                > ✅ _test-t5-fix  RESULT: 28 PASS / 0 FAIL
```

⇒ **无新增红**；`_gate-plugin-load` 的 FAIL 1 是既有 `v2.6.7` 具名导出项（`_gate-plugin-load.mjs:128-145`），两轮一致。

**G-9 baseline（实测 `mem.db`，只读）**：`T-0603` 588 字 `压缩 p3e-sess · sid bca1141e`、`T-0601` 1470 字 `sid 948b968e`、`T-0599/598/595/592/589/586` 均 `p3e-sess`；`meta` 表 `intent:p3e-session-%` = **30**、`intent:p3e-%` = **30**（尚无新格式键，因为运行中的 DSH 仍是 4.5.9）。与第一轮 baseline 逐字吻合。✅

**G-9 "修复后"侧（本轮独立算出，不依赖部署）**：用 `__p3Hooks.sessionEndCid` + `p25-topics.js:buildCheckpointHeader` 在临时 `DSH_HOME` 里实算：

```
new cid  = p3e-bca1141e-mw99guez      old cid = p3e-session--mw99guez
OLD 首行 = ## 检查点（目标与下一步，压缩 p3e-sess · sid bca1141e · cwd C:\…\agent周事项）  len=89
NEW 首行 = ## 检查点（目标与下一步，压缩 p3e-bca1 · sid bca1141e · cwd C:\…\agent周事项）  len=89
MARK 正则匹配新 md marker: true
```

⇒ **判据成立**：首行 cid8 段 `p3e-sess` → `p3e-bca1`，**长度 89 不变**，`MARK`（`index.js:15023`）仍匹配新 cid。md 模式兼容性成立。

**G-9 遗漏（MF6）**：见下节「产出物变化」。

---

## G1–G15 护栏核对（可测部分 + 未覆盖部分）

| # | 护栏 | 实现 | 实测/未覆盖 |
|---|---|---|---|
| G1 | 归档判定用循环内 sid、`reason:"archived"` 可观测 | ✅ `21302-21303` | **静态可验**；`decideSessionEnd` 的 `archived` 用例已在 `test/_p3-triggers-selftest.mjs:217-222` 行为断言 |
| G2 | 读失败不覆盖缓存 + 留痕 | ✅ `7023-7029` | **行为已测**（`_test-t5-fix.mjs:73-87` 三例）；❌ 未测「TTL 不刷新」（MF3） |
| G3 | cid 纯函数 + `__p3Hooks` | ✅ `6978-7000` | **行为已测**（7 条）；⚠️ 正则放宽，未按 G3 原判据 |
| G4 | 同 tick 多会话 cid 互不相同 | ✅ `21327` | **行为已测**（2 sid 断言不同）；⚠️ 唯一性依赖 `sid8`（前 8 字符）——两个不同 sid 若前 8 字符相同且同 tick，仍会撞（UUID 概率 ~1e-5，实际可忽略，但 G4「必不同」并非数学保证） |
| G5 | dup 记账可区分且不污染失败率 | ✅ `15209-15222` | ❌ **只有静态 grep**（`_test-t5-fix.mjs:93`），无 fake-store 行为用例 |
| G6 | queued 记账可区分 | ✅ `21335-21340` | ❌ **只有静态 grep**（`:92`），无 `res={ok:false,queued:true}` 行为用例 |
| G7 | `endFired` 崩溃窗口自愈 | ✅ `6986-6991` + `21306-21309` | **行为已测**（`_test-t5-fix.mjs:60-69` 六例） |
| G8 | 单轮 spawn 上限可测 | ✅ 常量 `6983` + 钩子 `6996` | ⚠️ 只测**常量 == 3**（`:57`）；G8 原验收「构造 10 个候选 ⇒ 本轮 `fired<=3`」**未实现**（sweep 未导出，无法直调） |
| G9 | 队列去重/淘汰留痕 + 淘汰复位 endFired | ✅ `15123-15139` | ❌ **只有静态 grep**（`:94`），无"撑到 5 再入队"行为用例 |
| G10 | 归档跳过日志每 tick 一条 | ✅ `21357-21360` | ❌ **只有静态 grep**（`:95`），无计数断言 |
| G11 | T1/T4 cid 未被改动 | ✅ T1 仍 `sid.slice(0,8)`（`21256/21259`）、T4 仍传宿主 `compactionId`（`15207` 上游） | 静态可验，**成立**（M10 同根缺陷按计划保留） |
| G12 | 失败单通道（避免双写） | ⚠️ 直接失败路径 ✅（`21346-21351` 复位 + `intentRetryClear`）；**queued→排空失败路径未覆盖**（MF1） | ❌ 无行为用例 |
| G13 | 日志带值（cid/sid8/reason/dup/queued） | ✅ 三种 note + `pending-dedupe/evict` + `archived-read-fail` + `t5-skip` | 静态可验 |
| G14 | 不新增门红 | ✅ 35→36 门、10 处不达标逐条一致 | **实测已比对** |
| G15 | `p3-triggers.js` 纯度保持 | ✅ 无 `Date.now`/`new Date(`/`node:`/`import`；`decideSessionEnd` 时钟仍由入参传 | **实测** `node test/_p3-triggers-selftest.mjs` = 55 PASS / 0 FAIL（含纯度用例） |

**覆盖度小结**：15 条里 **7 条有行为断言**（G1/G2/G3/G4/G7/G15 + G14 的门禁比对），**6 条只有 grep 级静态断言**（G5/G6/G9/G10/G12 + G8 的行为侧）。这正是 MF5。

---

## 新发现的风险/缺陷（按等级，指到文件:行）

### 🔴 中（必须处理）

**N1 · queued 路径的"单通道"只闭了一半 ⇒ 跨工作区线污染仍可达（= MF1）**
链路：sweep 派发 → `INTENT_RUNNING||MAINT_RUNNING` ⇒ 入 `INTENT_PENDING` 并 `return {ok:false,queued:true}`（`index.js:15120-15140`）→ sweep `.then` 的 `queued` 分支**什么都不做**（`21345`，既不置 `checkpointAt` 也不 `intentRetryClear`）→ 队列在**别的** spawn 的 `finally` 里排空（`15257-15263`，用 `setTimeout(0)` + 原 `parentAgent`，**不带 `opts`**）→ 若排空这次失败，`spawnIntentCheckpoint` 内部 `intentRetryFail` 把该 cid 写进 `.integrate.json intentRetry`（`15256` → `15098-15113` → `13206-13229`）→ `scheduleIntentRetryDue` 的 pre-step（`13260-13268`）→ `fireIntentRetry(agent)` **用当前触发会话当 `parentAgent`**（`13250`）→ `spawnIntentCheckpoint` 用 `parentAgent` 的 cwd 决定 P2.5 会话线（`15201-15207`）⇒ **A 工作区会话 X 的检查点写进 B 工作区线**，随后 `p25ReadPreviousSession` 会把它注入 B 的下一个会话。
→ 自述 §5 声称「失败时 `intentRetryClear(cid)` 清掉重试队列（避免 M11/F5）」——**该清理只发生在直接失败分支（`21350`），queued→排空失败这条链永远走不到它**。

**N2 · queued → 排空成功 ⇒ `checkpointAt` 永不置位 ⇒ M5 自愈把已交付会话再写一遍（= MF2）**
`21345` 显式不置 `checkpointAt`（D-4 要求），但队列排空成功后**没有任何代码回填 `checkpointAt`**（`15257-15263` 与 `spawnIntentCheckpoint` 全程不碰 `p3SessionState`）。⇒ `endFired=true && checkpointAt=0` 持续存在 ⇒ 2h 后 `p3T5ShouldHealEndFired`（`6986-6991`）判 true ⇒ 复位重发 ⇒ **新 cid ⇒ 新 meta 键 ⇒ 不会被 dup 拦**（`index.js:8778-8779` 幂等键是 `intent:<cid>`）⇒ 同一会话被写第二份检查点（多一次 20s 级子代理 + tokens，并覆盖同主题最后一句，`p25WriteSessionTopic` 的 `replaceSentence` 在 `8695-8720`）。
同类小窗口：DB 写成功 → `.then` 置 `checkpointAt` → 500ms 防抖落盘（`5759-5771`）之间崩溃，重启后同样会被自愈重写（概率低）。

**N3 · `readArchivedSessionIds` 读失败不刷新 TTL ⇒ 每会话重读 + 每会话一条事件（= MF3）**
`index.js:7023-7028`：失败分支在 `7027` 直接 `return`，**没有** `ARCHIVED_IDS_CACHE.at = now`。而 `21302` 是**循环内每会话**调用 ⇒ `workspace.json` 持续损坏时：① 每小时 O(N) 次 56KB 读盘 + `JSON.parse` 失败；② 每小时 O(N) 条 `archived-read-fail` 进 `events`（环 2000，`5742`）⇒ 约 `2000/N` 小时被冲满，挤掉 `retry-breaker`/`subagent-abort`/`spiral` 等诊断事件。**这正是 M7 想挡的那类洪泛，换了个入口回来**。
（另：M2 只挡 `JSON.parse` 异常；若宿主写出**合法 JSON 但缺 `archivedSessionIds` 键**，`parsed=true` ⇒ 空集覆盖缓存 ⇒ 静默 fail-open。属低概率，记录备查。）

**N4 · `p3-triggers.js` 未被 git 跟踪 ⇒ 本批 A 改动无法回滚/无法审 diff（= MF4）**
`git ls-files p3-triggers.js` 为空；`git check-ignore` 也未忽略（`.gitignore` 无相关规则）⇒ 纯"忘记 `git add`"。后果：① `git diff` **看不到**本批 `decideSessionEnd` 新增的 `isArchived`/`maxIdleMs`（`p3-triggers.js:185-195`），第一轮审计与本次复核都只能读全文；② `git checkout`/`git stash` **回滚不了**该文件（参数向后兼容，行为回滚侥幸仍成立，但完整回滚要手工编辑）；③ 打包链 `tools/sync-payload.mjs:105-115` 的白名单 `['index.js','package.json','version.txt','AGENTS.template.md','tools/session-search.mjs'] + client + memtopic/src` **不含根目录 P3 模块**，而 `index.js:324-327` 静态 `import` 它们 ⇒ **payload zip 只有 21 个条目、4 个 P3 模块全部缺失**（实测 4.5.10 与 4.5.9 **同为 21 条、同样缺失** ⇒ 缺陷 pre-existing，但本轮重新打包把它带进了 4.5.10 发布物）。`install-manifest.json` 同样无 P3 条目。

### 🟡 低

**N5 · 新门 `_test-t5-fix.mjs` 的断言层级不匹配护栏（= MF5）**
28 条中 `:90-98` 的 **10 条是 `src.includes(...)` 静态断言**（S1–S6），覆盖的恰是 M4/M6/M7/G9/G10/G12 这些**行为类**护栏。后果：即使 `p3SessionEndSweep` 从未被 `ctx.interval` 接线、或 `.then` 里三态分支被删、或 `pending-evict` 复位逻辑写错，该门**依然全绿**。G8 也只断言常量 == 3，未按 G8 原验收"构造 10 候选 ⇒ fired≤3"。

**N6 · `intentRetryClear` 在失败路径打印"补火成功"误导日志**
`index.js:13237` `clog("…意图检查点补火成功，重试队列已清理 <cid8>")`。sweep 在**失败**分支调它（`21350`）⇒ 日志会写"补火成功"。诊断时会误导（现场排查 T5 失败时看到"成功"）。

**N7 · `.catch` 分支不清重试队列 ⇒ 双通道对"抛异常"仍存在**
`index.js:21354` 的 `.catch` 只复位 `endFired/endFiredAt`，不调 `intentRetryClear`。若 `spawnIntentCheckpoint` 以 **reject** 结束（而非返回 `{ok:false}`），且其内部已 `intentRetryFail` 入队（`15256` catch 分支是 return 不是 throw，故概率低；但任何 `finally`/排空链抛错会走这里）⇒ 下 tick 新 cid 重试 + 重试队列旧 cid 补火 ⇒ 双写。属低概率，建议 `.catch` 也调 `intentRetryClear(cid)`。

**N8 · `cap` 的 `break` 早于归档/过期计数 ⇒ 汇总日志偏小**
`21300` vs `21303/21321`、汇总在 `21359`。只影响 `t5-skip archived=` 的可观测性（`fired` 到 3 后不再统计）。

**N9 · `p3-triggers.js` 公共契约注释未同步新参数**
`p3-triggers.js:34` 仍写 `decideSessionEnd({lastActivityAt, now, idleMs, isSubagent, hasCheckpoint})`，实际签名已含 `isArchived`/`maxIdleMs`（`:185`）；`:16` 的状态约定也未提 `endFired/endFiredAt`。`:54` 的 reason 列表**已**更新（`archived`/`too-old`）。属文档漂移。

**N10 · 自愈延迟（设计接受，需记录）**
崩溃后 `endFiredAt=T`，重启后首个 tick 在启动 +1h，`now-T` 需 >2h ⇒ 实际要 **第 2–3 个 tick（T+2~3h）** 才自愈。符合 M5 规格，但"2h"在小时级 tick 下等于"最多 3 小时"，建议在方案/文档写清。

**N11 · T1/T4/dream 未误伤（结论：安全）**
- `decideSessionEnd` 全仓**唯一生产调用点** `index.js:21312`（grep 确认，其余仅单测）⇒ `p3-triggers.js` 的签名扩展不波及 T1/T4/T6/dream。
- `p3-triggers.js` 其余导出（`computeLevels`/`decideThresholdTrigger`/`markFired`/`resetAfterCompact`/`decideMissed`）逐行比对**未见改动痕迹**（纯函数、无 I/O、无时钟）。
- T1 路径 `21252-21266` 与 T4 路径均未改；label 改动属 4.5.10 上一轮（`14201`、`20657`、`21998-21999`），本轮未动。
- `INTENT_PENDING` 淘汰复位对 T1/T4 条目的副作用见 M6 表，可接受。

### 关于任务点名的几个具体问题（逐条回答）

| 问题 | 回答 |
|---|---|
| `intentRetryClear(cid)` 在 sweep `.then` 里**作用域是否可达** | **可达**。`intentRetryClear` 在 `13231`（apply 函数体内缩进 4），`p3SessionEndSweep` 在 `21289`（同函数体内缩进 4）；同域证据：`agentsBySession`（`13270`，缩进 4）被 sweep 的 `21297` 使用。注意：该调用被 `try/catch(eRc){}` 包着（`21350`），所以"不报错"**不能**反证可达，须靠静态作用域判断（已判断为可达） |
| 会不会**误清别的 cid** 的队列/持久化 | **不会**。`intentRetryClear` 按 `String(e.id) === id` 精确过滤（`13234-13236`），只删该 cid；`intentRetrySave` 是"读盘→并集→整表写回"（`13189-13199`），无跨条目副作用 |
| 与 `intentRetryFail` 的入队时序是否构成竞态 | **不构成**。`spawnIntentCheckpoint` 是 async，但失败早退分支（`15156/15165/15170/15179`）与 catch（`15256`）都在**同一个同步段**内完成 `intentRetryFail`→`intentRetryEnqueue`（同步写盘）后才 resolve；sweep 的 `.then` 在微任务里执行 ⇒ **入队一定先于清理**。且新入队条目 `nextAt = now+60s`（`9383`），`intentRetryDue` 不会立刻捞走 |
| 旧格式（无 `endFiredAt`）直接 `true`：首个 tick 会不会对历史 `endFired=true && checkpointAt=0` 批量自愈并 burst？上限 3 够不够？ | **本机 0 条**（29 条 `endFired=true` 全部 `checkpointAt>0`，实测）⇒ 不 burst。其他安装若有 N 条，首 tick 起按 cap=3 排空，`ceil(N/3)` 小时；每条自愈后立即 `endFiredAt=now`，不会重复自愈。**上限 3 足够**（它同时受 `INTENT_PENDING` 容量 5 保护） |
| 归档过滤后 `p3.sessions` 里归档条目是否还会被刷新/清理（R10） | **不再刷新**（`21302-21304` 在建状态条目前 `continue`）；**仍会被清理**：`p3PruneSessions`（`5829-5848`）按 `lastActivityAt < 30 天` 或 >500 条淘汰，归档条目因不再刷新活跃时间会**加速**被清——符合预期，无泄漏 |
| `readArchivedSessionIds({force:true})` 每 tick 读 56KB 的异常路径 | 正常路径 OK（1 次/小时/56KB）。异常路径有缺陷：见 **N3/MF3**（失败不刷 TTL ⇒ 退化成每会话重读） |
| `ARCHIVED_IDS_CACHE` 被其他调用方共享时 `force` 的副作用 | **正向副作用**：force 只刷新缓存内容（`7029`），`isArchivedAgent`（`13290`，供 `pickSpawnParent` 择父）因此拿到更新鲜的集合 ⇒ 归档会话更不容易被选为父。无负面副作用 |
| cid 变更对 md 路径 marker / `stripOldIntentBlocks` / `archivedCompactionIds` / `intentRetry*` 键 / `p25WriteSessionTopic` 的兼容性 | **全部兼容**：① `MARK` 正则 `^<!-- intent: [0-9a-zA-Z-]{8,}(?: sid:(\S+?))? -->`（`15023`）匹配新 cid（实测 true）；② `stripOldIntentBlocks` 按 `sid:` 后缀管理旧块（`15022` 函数、`15049` `keepSid` 判据），与 cid 格式无关；③ `archivedCompactionIds`/`intentRetry*` 都是 **cid 原样字符串**，不解析前缀（`13160`、`13206`）；④ `p25WriteSessionTopic` 的主题名取 **sessionId**（`8623` 起，覆盖同一会话最后一句在 `8695-8720` 的 `replaceSentence`；`buildCheckpointHeader` 的 `sid8` 来自 `sessionId`，`p25-topics.js:257-265`），与 cid 无关 ⇒ 主题名不变；⑤ 旧 marker（`p3e-session--…`）不会被新 cid 命中 ⇒ 不误判 dup（`15162`）。⚠️ 唯一理论边角：若 `sid8` 极短且 `now` 的 base36 为 1 字符（如 `p3e-x-0`，7 字符 < 8），`MARK` 的 `{8,}` 会不匹配——真实 UUID sid 不会出现 |
| T1/T4/dream 是否被误伤 | **未误伤**，见 N11 |

---

## 失效路径（≥3 条）

> 反面问题：**实现可能怎样让现有功能失效？**

**F1 · queued → 队列排空失败 ⇒ 检查点写进错误工作区线（跨工作区上下文污染）**
`index.js:15120-15140`（入队，`queued` 返回）→ `21345`（sweep 对 queued 不清理重试队列）→ `15257-15263`（排空不带 opts）→ 排空失败 `15256`→`15098-15113`→`13206-13229`（写 `.integrate.json intentRetry`）→ `13260-13268`/`13244-13257`（pre-step 补火，`parentAgent` = 触发者）→ `15201-15207`（cwd 取 parentAgent）⇒ 会话 X 的检查点落进工作区 B 的会话线，并被 `p25ReadPreviousSession` 注入 B 的下一个会话。**自述声称已关闭（G12 单通道），实际未覆盖。**

**F2 · queued → 排空成功 ⇒ 2h 后被自愈重写（重复成本 + 覆盖同主题句）**
`21345`（不置 checkpointAt）→ `15257-15263`（排空成功不回填）→ 2h 后 `6986-6991` 判"丢失" → `21308` 复位 → 下 tick `21312` 重新 fire → `21327` **新 cid** → `8746` 幂等键不命中 ⇒ 第二份检查点写库。单次约 20s 子代理 + tokens；`p25WriteSessionTopic` 覆盖同会话最后一句（`8652-8698`）。

**F3 · `workspace.json` 持续损坏 ⇒ 归档过滤退化为 O(N) 读盘 + 事件环被 `archived-read-fail` 冲满**
`7001-7030`（失败不刷 `at`）→ `21302` 每会话调用 → 每小时 N 次 56KB 读 + N 条事件 → `events` 环 2000（`5742`）在 `2000/N` 小时后只剩噪声，`retry-breaker`/`subagent-abort`/`spiral` 等诊断事件被挤掉（M7 的原始诉求被绕过）。

**F4 · 回滚/全新安装失效（仓库与产物层）**
`p3-triggers.js` 未跟踪（`git ls-files` 空）⇒ `git checkout -- .` 后它仍是新版（参数向后兼容，行为回滚侥幸成立，但**无法通过 git 恢复到改动前**）；`tools/sync-payload.mjs:105-115` 白名单漏 4 个根目录 P3 模块 ⇒ `payload/dsh-memory-4.5.10.zip`（21 条目）在全新安装时 `index.js:324-327` 的静态 `import` 找不到模块 ⇒ **插件整体加载失败**（本机因走 `_verify/deploy-p3.mjs` 复制而未暴露；4.5.9 同样缺失 ⇒ pre-existing，但 4.5.10 产物继承了它）。

**F5 · 观测失真：`t5-skip` 计数偏小**
`21300` 的 `break` 在 `21303`/`21321` 计数之前 ⇒ `fired` 达 3 后归档/过期不再计入，`21359` 汇总日志的 `archived=`/`too-old=` 会低估，运维据日志判断"归档过滤是否生效"时可能误判。

**F6 · 归档清单"合法 JSON 但结构变化" ⇒ 静默 fail-open（低概率）**
`7022` `parsed = true` 只要 `JSON.parse` 成功，即使 `archivedSessionIds` 键缺失/被改名也照样用**空集覆盖缓存**（`7029`）⇒ 该 tick 归档过滤全失效（M2 只覆盖了 parse 异常这一种失败形态）。

---

## 测试与门禁复核（命令 + 实测结果 vs 自述）

| 命令 | 自述 | 本轮实测 | 判定 |
|---|---|---|---|
| `node _test-t5-fix.mjs` | 28 PASS / 0 FAIL | **RESULT: 28 PASS / 0 FAIL** | ✅ 吻合 |
| `node test/_p3-triggers-selftest.mjs` | 55 PASS / 0 FAIL | **RESULT: 55 PASS / 0 FAIL** | ✅ 吻合 |
| `node test/_accept-p4.mjs` | 98 PASS / 0 FAIL | **PASS 98 / FAIL 0 / SKIP 0**（含 P-L1~L3、P12 label 带 sid） | ✅ 吻合 |
| `_run-suite.mjs`（**未跑**，按指令） | 基线 35 门 10 红；最终 36 门同样 10 红 | `Compare-Object` 两份 `_verify/suite-*.txt`：**仅 3 行差异**（35→36、`+_test-t5-fix` 绿、`_gate-plugin-load` PASS 109→110），**10 处不达标逐条一致** | ✅ 无新增红 |
| G-9 修复后首行 | `p3e-bca1`，长度不变 | 独立实算：`p3e-bca1`，`len=89`（与 old 相同），`MARK` 匹配 true | ✅ 判据成立 |
| `mem.db` baseline | T-0603 588 字 `p3e-sess` 等；旧 meta 键 30 条 | 实测 T-0603 588 / T-0601 1470 / T-0599 907 / T-0598 1292 / T-0595 1364…；`intent:p3e-session-%`=30、`intent:p3e-%`=30 | ✅ 吻合 |
| `node _gate-plugin-load.mjs` | FAIL 1（既有 v2.6.7 旧文案）/ PASS 110 | 未单独跑；套件内两轮均 `FAIL 1`（PASS 109→110），与 `_gate-plugin-load.mjs:128-145` 的 v2.6.7 项对应 | ✅ pre-existing，非本批引入 |

**测试卫生**：`_test-t5-fix.mjs:29-33` 在 `import index.js` **之前**设置 `DSH_HOME`/`DSH_MEMORY_ROOT`（`index.js:593-594` 读取）⇒ 只写 `os.tmpdir`，**不碰真 `~/.dsh`**。✅ 我复核时另用独立临时 `DSH_HOME` 跑 G-9 实算，同样未写仓库/真库。

**未覆盖（= MF5）**：G5/G6/G8(行为)/G9/G10/G12 无行为断言；sweep 未导出，无法做"10 候选 ⇒ fired≤3"、"archived 真被跳过"、"汇总日志一条"的集成断言。

---

## 回滚与不可逆性

**可独立回退**：`index.js`（tracked，`git checkout -- index.js` 即可）、`_test-t5-fix.mjs`（未跟踪新文件，删除即可）、`test/_p3-triggers-selftest.mjs`（tracked）、版本三处 + `install-manifest.json` + `payload/*.zip`（重生成）。

**不能靠 git 回退**：
- `p3-triggers.js`（**未跟踪**）⇒ 本批 `isArchived`/`maxIdleMs` 改动只能手工回退。**行为上**即使不回退也安全（多出的参数被旧调用方忽略、`decideSessionEnd` 只有 T5 一个调用点），但"完整回到改动前字节"做不到。
- **已部署的 3 个 profile**（自述 §6：`profiles/web`、`web-test`、`web-cc-test` 的 `index.js` sha256 已与 repo 一致）——**运行中的 DSH 仍是 4.5.9，下次重启就会加载新代码**。回滚必须同步回退这 3 份部署副本，否则"改了 repo 但重启照样是新版"。

**持久状态变化（是否有不可逆）**：

| 产出物/状态 | 变化 | 回滚后影响 | 可逆性 |
|---|---|---|---|
| `.monitor.json` `p3.sessions[*].endFiredAt` | 新增字段（持久） | 旧代码**忽略**未知字段（`p3PruneSessions`/sweep 只读已知键） | ✅ 无害，无需清理 |
| `.monitor.json` `events` / `cost.events` | 新词表：`session-end-dup`/`-queued`、`pending-dedupe`/`pending-evict`、`archived-read-fail`、`t5-skip archived=…`、`I-dup`/`intent-dup-skip` | 旧代码照常读环（纯文本），不影响解析 | ✅ 无害（但**未列入 G-9**，见 MF6） |
| `mem.db` `meta` 新键 `intent:p3e-<sid8>-<b36>` | 新增；旧键 `intent:p3e-session-*` 停在 30 条 | 旧代码用旧 cid ⇒ **不命中**新键，只是幂等集合"不连续"（不会误判 dup，也不会误判成功） | ✅ 无害（残留键不可清，但无行为影响） |
| `.integrate.json` `intentRetry` 条目 | T5 **失败**时被 `intentRetryClear(cid)` **删除** | 对应会话 `endFired=false` 已落盘 ⇒ 旧代码下 tick 会重新 fire | ⚠️ **条目本身不可恢复**，但能力可自愈 ⇒ 不算不可逆数据丢失 |
| `p3.sessions[*].endFired/endFiredAt` | 自愈/淘汰时被复位 | 旧代码只看 `endFired` ⇒ 可能多触发一次 | ✅ 瞬态 |
| 已写入的新格式检查点 | 正文首行 `p3e-bca1`、md marker 新格式 | 内容/结构不变，旧代码读正文不解析 cid 格式 | ✅ 无需迁移 |
| `docs/门套件结果.md` | 被 `_run-suite.mjs` **重写**（工作区已 M；头部时间戳 11-06→11-09、`_test-index-refresh` 20/7→13/14 等） | 属产物文件，重跑即变 | ⚠️ 交付前应决定是否纳入本次提交（建议**不纳入**，或按既有惯例单独提交） |

**结论**：无 schema 迁移、无库结构改写、无需数据修复；**唯一"不可逆"是 `.integrate.json` 重试条目的删除**，但能力可自愈。回滚风险总体低，**前提是同时回退 3 份已部署副本 + 手工处理 `p3-triggers.js`**。

---

## 必须修改项（如有，逐条可验收）

> 全部为**只读可复核**的验收判据；MF1/MF2 建议同批改（同一段代码），MF3 独立，MF4 一行 git，MF5 补测，MF6 补文档。

### MF1 · 关闭 queued 路径的错父通道（对应 N1 / G12）
**改法**：把 `opts` 一并存进 `INTENT_PENDING` 值（`index.js:15122`），在 `finally` 排空时透传（`15262`）；排空失败时若 `opts && opts.trigger === "T5"` 则**不入重试队列**（给 `spawnIntentCheckpoint` 加 `opts.noRetry`，或排空回调里 `intentRetryClear`）。
**验收**：① 静态：`INTENT_PENDING.set(...)` 的值含 `opts`，`15262` 的排空调用带 `opts`；② 行为（新增门用例）：fake subagents 返回空输出 ⇒ 构造 `INTENT_RUNNING=true` 先让 T5 入队、再放行排空失败 ⇒ 断言 `.integrate.json` 的 `intentRetry` **不含**该 cid；③ 反向对照：T4 的 queued 失败**仍**入队（不得误伤）。

### MF2 · queued 交付成功要落 `checkpointAt`（对应 N2 / M5）
**改法**（二选一）：① 排空成功后，若该条目来自 T5，回填 `p3SessionState(sessionId).checkpointAt = Date.now()`；或 ② sweep 的 queued 分支写 `s2.endQueuedAt = Date.now()`，`p3T5ShouldHealEndFired` 对"仍在队列中/已交办"的条目返回 false（需配合 `intentRetryHas`/队列探针）。
**验收**：① 行为（新增门用例）：构造 `res={ok:false,queued:true}` 后让排空成功 ⇒ 断言 `p3.sessions[sid].checkpointAt > 0` 且 `__p3Hooks.shouldHealEndFired(st, now+3h) === false`；② 反向：真崩溃（`endFiredAt=now-3h`、无 checkpointAt、无队列条目）仍必须自愈（现 G7 用例保持绿）。

### MF3 · 读失败也要刷 TTL，并给 read-fail 日志节流（对应 N3 / M2 衍生）
**改法**：`index.js:7027` 改为 `if (ARCHIVED_IDS_CACHE.at > 0) { ARCHIVED_IDS_CACHE = { at: now, set: ARCHIVED_IDS_CACHE.set }; return ARCHIVED_IDS_CACHE.set; }`（**保留旧集合、只更新时间**）；`archived-read-fail` 的 `monitorEvent` 加 30s 级节流（或改为"每 tick 汇总一条"）。
**验收**：① 行为：坏 `workspace.json` 连续 `force:true` 调 3 次 ⇒ 第 2/3 次**不再新增** `archived-read-fail` 事件，且返回值仍是上一份集合；② 行为：坏文件 + 10 次非 force 调用 ⇒ 文件读取次数为 **1**（可用桩 `fs.readFileSync` 计数或临时替换文件 mtime 观察）。

### MF4 · `p3-triggers.js` 纳入版本管理（对应 N4）
**改法**：`git add p3-triggers.js p25-topics.js p3-cost.js p3-readside.js`（后三个同样未跟踪，属仓库既有状态，建议一并纳入，否则 T5 修复永远无法用 diff 审）。
**验收**：`git ls-files p3-triggers.js` 非空；`git status --porcelain` 不再出现 `?? p3-triggers.js`；本批改动因此可产出可复核的 `git diff`。
（若坚持不纳入，则**必须**在交付物清单里显式标注「该文件未跟踪 ⇒ 不可 git 回滚、diff 不可审」，并接受该风险。）

### MF5 · 把 M4/M6/M7/G9/G10/G12 的验收从 grep 升到行为（对应 N5）
**改法**：`_test-t5-fix.mjs` 至少补 3 条行为用例（可复用 `_accept-p4.mjs` 的 fake ctx / fake subagents 造数手法）：
① queued ⇒ `cost.events` 里 `note==="session-end-queued" && fail===0 && n===0`（G6）；
② `INTENT_PENDING` 撑到 5 再入队 ⇒ 出现 `pending-evict`，且被淘汰 `sessionId` 的 `endFired===false`（G9）；
③ 一次 tick 内 `t5-skip` 汇总事件 **≤1 条**且形如 `archived=<k>`（G10）。
**验收**：`node _test-t5-fix.mjs` 条数增加且全绿；**并且**做一次"故意把三态分支改错 ⇒ 该门必须红"的负例对照（否则断言无效，参照第一轮 G1 的鉴别仪式要求）。

### MF6 · 补全 G-9 产出物清单 + 发布物声明（对应 M8 遗漏 / N4）
**改法**：在 `docs/audit/T5-fix_IMPL_2026-11-09.md` §4 补：① `.monitor.json` 新增 `p3.sessions[*].endFiredAt`（旧代码忽略）；② `events`/`cost.events` 新词表（`session-end-dup`/`-queued`/`pending-dedupe`/`pending-evict`/`archived-read-fail`/`t5-skip`/`I-dup`/`intent-dup-skip`）；③ `.integrate.json` `intentRetry` 条目会被 T5 失败路径删除；④ `install-manifest.json` + `payload/dsh-memory-4.5.10.zip` 已重生成（并**显式声明**：payload 缺 `p3-cost.js`/`p3-triggers.js`/`p3-readside.js`/`p25-topics.js` ⇒ 全新安装会加载失败；4.5.9 同样缺失 ⇒ pre-existing，需在发布前单独立项修 `tools/sync-payload.mjs` 白名单）。
**验收**：清单逐项可指到文件:行；`tools/sync-payload.mjs --check` 的"CHECK OK"不再被当作"安装可用"的证据。

### 建议（非阻断）
- **S-a**：失败分支的 `note` 与成功同用 `"session-end"`（`21337`），建议改为 `"session-end-fail"` 以便面板直接分离（G13 的"至少三种"已满足，故非必须）。
- **S-b**：`intentRetryClear` 的日志文案改为中性（如"重试队列已清理 <cid8>"），避免在失败路径打印"补火成功"（N6）。
- **S-c**：`.catch` 分支补 `intentRetryClear(cid)`（N7）。
- **S-d**：把 `cap` 的 `break` 移到归档/过期计数**之后**（或在 `break` 前先跑完计数逻辑），修 N8 的观测偏差。
- **S-e**：`p3-triggers.js:34`/`:16` 的契约注释同步新参数与 `endFired/endFiredAt`（N9）。
- **S-f**：在方案/README 记录自愈实际延迟为"最多 3 个 tick（≈3h）"（N10）。
- **S-g**：`docs/门套件结果.md` 的改动建议不纳入本批提交（产物文件，重跑即变）。

---

## 附：本轮独立执行清单（可复现）

```powershell
# 1) 三个只读/隔离测试
node _test-t5-fix.mjs                 # 28 PASS / 0 FAIL
node test/_p3-triggers-selftest.mjs   # 55 PASS / 0 FAIL
node test/_accept-p4.mjs              # 98 PASS / 0 FAIL / 0 SKIP

# 2) 门禁基线比对（不跑 _run-suite.mjs）
$a=Get-Content _verify/suite-baseline-pre-t5fix-20261109.txt
$b=Get-Content _verify/suite-final-t5fix-20261109.txt
Compare-Object $a $b                  # 仅 3 行差异；10 处不达标一致

# 3) 现场状态（只读）
#   .monitor.json: p3.sessions=293, endFired=true=29（全部 checkpointAt>0）⇒ 旧格式自愈 burst=0
#   workspace.json: archivedSessionIds=508；与 p3.sessions 交集=23（sessionIdKey 归一后）
#   mem.db: T-0603 588 字 p3e-sess / T-0601 1470 / meta intent:p3e-session-%=30

# 4) G-9 修复后首行（临时 DSH_HOME，不写仓库/真库）
#   buildCheckpointHeader + __p3Hooks.sessionEndCid ⇒ 压缩 p3e-bca1，len=89（与旧同长）
```
