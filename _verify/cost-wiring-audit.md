# P3-3c 记账补全接线点调研（只读）

> 任务：task-19 / 执行者：mem-cost-audit / 结论文件，**未改任何代码**。
> 读者：Lead（index.js 唯一写者）。每条都给出可直接粘贴的代码与精确行号。

## 0. 快照与漂移警告（先读）

| 项 | 值 |
|---|---|
| 文件 | `E:\工具\插件开发调整\dsh-memory-plugin\index.js` |
| 大小 | 1,537,154 B |
| sha256 | `48A296C37152F0826DB9B54E601E30C590F5930FDB83F8368C00F04DD23EC661`（前缀 `48A296C3`） |
| 总行数 | 20,936 |
| mtime | `2026-11-02T15:55:13+08:00` |

⚠️ **本文行号只对上面这个 sha 有效。** 审计期间 Lead 的 task-12（P4 实现）在并发编辑 index.js，文件 sha 在 6 分钟内变了 4 次（5 个版本：`95CE99D4` → `453DB55E` → `93F60338` → `D83E0FC9` → `48A296C3`），每次整体平移 +6 行左右。
**改代码前先跑 §9 的锚点重定位脚本**（只读，10 秒），行号对不上时按锚点串定位——每条给出的「锚点」都是文件里唯一出现的原文片段。

### 0.1 硬约束：delta 字段白名单（p3-cost.js:21-33）

`p3CostBump(kind, delta, ev)` 里 `delta` 只有 `KIND_FIELDS[kind]` 列出的字段会被累加，**其它键静默忽略**（`p3-cost.js:134-150`，不报错、不告警）。逐 kind 白名单：

```
checkpointWrite: n,inTokens,outTokens,cacheReadTokens,totalTokens,inChars,outChars,estTokens,durMs,fail,retry,timeout
rebuildInject:   n,injectedChars,estTokens
startupInject:   n,injectedChars,estTokens
recallReminder:  n,injectedChars
hintA/hintB/hintC: n,injectedChars
memorySearch:    n,resultChars,durMs,miss
dream:           n,inTokens,outTokens,cacheReadTokens,totalTokens,durMs,ok      ← 13 个 kind 里唯一有 ok 字段的
maint:           n,inTokens,outTokens,totalTokens,beforeChars,afterChars
archive:         n,inTokens,outTokens,totalTokens,written                        ← 没有 cacheReadTokens/durMs/ok
export:          n,bytes,durMs
hostUsage:       inTokens,outTokens,totalTokens,cacheRead,cacheWrite,turns
```

**推论（直接决定下面写法）**：
- 除 `dream` 外，别在 `delta` 里写 `ok` —— 要表达成功/失败请写进 `ev.ok`（events 白名单含 ok）。
- `rebuildInject`/`hintA`/`hintB`/`hintC` **没有 durMs 字段**，别量时长。
- `estTokens` 只有 `checkpointWrite/rebuildInject/startupInject` 有字段；且注入型 kind 的 estTokens 由 `deriveEstTokens` 从 `injectedChars` **自动派生**（`p3-cost.js:127-131`），显式传与不传等价。
- `hintA/B/C`、`recallReminder` 的 `injectedChars` **不会进面板 est.total**（字段表里没有 estTokens）—— 接这三类只能得到"注入字数"，得不到估算 token 增量。

### 0.2 硬约束：ev 白名单（p3-cost.js:180-201）

`ev` 只收：`t,kind,sid,trigger,note,d` + `n,inTokens,outTokens,cacheReadTokens,totalTokens,inChars,outChars,injectedChars,estTokens,resultChars,bytes,durMs,ok,fail,retry,timeout`；
字符串截断：`sid≤64, trigger≤8, note≤200, d≤10`；events 是 **500 条环形**（超了从头 splice）。

**⚠️ `ev.trigger` 不要写成 `T1`~`T6`**：`p3-cost.js:268-291` 的 `triggersOf()` 会把所有 `kind==="checkpointWrite"` 且 trigger 为 T1-T6（或 note 以 `T[1-6]\b` 开头）的事件计入「触发档位」，给 checkpointWrite 补记成功/失败时若 trigger 仍写 `T4`，**T4 触发数会翻倍**。补记事件统一用非 T 前缀（下文各条给了具体值）。

### 0.3 全局口径：子代理 usage 已经被 hostUsage 记过了

`p3OnSessionEvent` 的 `hostUsage` 分支对**主会话与子代理会话都记账**（`index.js:4766`；`isSub` 只用于挡三阈值，不挡 usage，见 `:4769`）。
⇒ `dream` / `maint` / `archive` 里再记 `inTokens/outTokens/totalTokens` 是**归因副本，不是新增消耗**：
- 面板「真实 tokens」只用 `hostUsage`（`p3-cost.js:243-250 realOf`），不会翻倍；
- 但任何人若把 `kinds.*.inTokens` 横向求和会翻倍 —— 面板/文档必须写清"dream/maint/archive 的 token 是 hostUsage 的子集拆分"。

### 0.4 p3CostBump 的代价（决定"要不要接/要不要传 ev"）

`p3CostBump` 每次调用会：`readMonitorData()`（读整个 .monitor.json）→ `bumpKind` → `addDaily` → `pruneDaily` → `pushEvent`（若传 ev）→ `scheduleMonitorSave()`（500ms 防抖落盘）。见 `index.js:4683-4697`。
⇒ 低频点随便接；**高频点（memory_search 每次工具调用）必须限制 ev**，否则 events 环被检索事件挤占（500 条里压缩/检查点事件是最有价值的）。

---

## 1. `rebuildInject` —— 压缩后记忆重灌

- **落点**：`buildPostCompactRehydrate` 定义 `index.js:15457`；调用处 `index.js:17824`（`rehydrate = await buildPostCompactRehydrate(targetAgent);`）。
  **记账插入点：`index.js:17826` 之后**（`p4NoteRehydrateId(compactionId);` 的下一行，`REHYDRATE_STATS.count += 1;`（:17827）之前）。
- **现有变量**：
  - `rehydrate.text`（string，已装配好的整段，含 `【压缩后记忆重灌…】` 段头）、`rehydrate.chars`（= `text.length`，返回处 :15554）、`rehydrate.dropped`（string[]）、`rehydrate.checkpointFile`
  - `compactionId`、`session.id`、`targetAgent`
  - 注入侧：`injectParts.push(rehydrate.text)`（:17844 附近）、合并后 `finalNote`（:17845）—— `rehydrate.text` 非空就一定会被注入，所以"构造成功=注入成功"成立。
  - 幂等闸：`POST_COMPACT_REHYDRATE_IDS`（:15444）+ `p4NoteRehydrateId`（:15448）保证同 compactionId 只走一次。
- **建议 delta**（rebuildInject 只有 n/injectedChars/estTokens，estTokens 自动派生，**不要传**）：
```js
p3CostBump("rebuildInject", { n: 1, injectedChars: rehydrate.chars || rehydrate.text.length },
  { sid: session.id, trigger: "R2", ok: 1,
    note: "cid:" + String(compactionId || "").slice(0, 8) + " dropped:" + ((rehydrate.dropped || []).join("/") || "-") });
```
- **建议 ev**：见上（`trigger:"R2"`，8 字符内；sid 主会话 id）。
- **风险**：①幂等 Set 保证不重复；②每会话压缩次数个位数，绝不刷爆 500 环；③若注入被外层 catch 吞掉（:17846+ 的 inject try/catch）最多多记 1 条，可忽略。
- **备注**：**不需要额外埋点**（chars 现成）。若想更精确"整条注入长度"（事实包+重灌合并后），可改用 `finalNote.length` 在 :17845 之后记，但那会把 P1 事实包也算进 rebuildInject，口径反而混，不推荐。

---

## 2. `dream` —— dream 整合子代理

- **落点**：`runDreamPipeline` 定义 `index.js:20172`，其内部 `settleDream`；**记账插入点：`index.js:19777` 与 `:19778` 之间**（`guardClear(...)` 那一行之后、`if (DREAM_PATCH) {` 之前）——此处 `u`/`doneOk`/`startedAt`/`_fail` 全部就绪。
  ❌ 不要接在空轮分支（`if (DREAM_PATCH) {` @19714 那一处）——空轮没有子代理、没有消耗。
- **现有变量**：
  - `u` @19770 = `await summarizeSubagentUsageRetry(sdir)` → `{ input, output, cache, totalIn, reasoning, durMin, usageRetry, usageReadAt, usageEmpty }`（定义 :19047，字段来自 :18974 段；`totalIn` 已含 cache，见 :19003 注释）
  - `startedAt` @19720（`const startedAt = Date.now();`，本轮发起时刻）
  - `doneOk` @19773（`LAST_DREAM_WROTE_AT >= startedAt`；:19776 guard aborted 会强制 false）
  - `_fail` @19755（失败原因对象，可为 null）、`reason`（"手动"/"定期"）、`outText`、`run.id`
  - 父会话 sid：`parent` @19543（`let parent = pickSpawnParent(agentForParent, null);`）或外层参数 `agentForParent`
- **建议 delta**（dream 是唯一有 `ok` 字段的 kind）：
```js
try {
  p3CostBump("dream", {
    n: 1,
    inTokens: u ? (u.totalIn || u.input || 0) : 0,
    outTokens: u ? (u.output || 0) : 0,
    cacheReadTokens: u ? (u.cache || 0) : 0,
    totalTokens: u ? ((u.totalIn || u.input || 0) + (u.output || 0)) : 0,
    durMs: Math.max(0, Date.now() - startedAt),
    ok: doneOk ? 1 : 0
  }, {
    sid: String((parent && parent.session && parent.session.id) || (agentForParent && agentForParent.session && agentForParent.session.id) || ""),
    trigger: "dream", ok: doneOk ? 1 : 0, durMs: Math.max(0, Date.now() - startedAt),
    note: reason
      + (u && u.usageEmpty ? " usageEmpty" : "")
      + (_fail && _fail.message ? " fail:" + String(_fail.message).slice(0, 80) : "")
  });
} catch (eP3d) { /* 记账失败不影响结算 */ }
```
- **建议 ev**：见上（`trigger:"dream"`，note 带 reason/usageEmpty/失败原因）。
- **风险**：①一轮一条，频率低；②token 与 hostUsage 重复归因（§0.3），面板不得相加；③`u.usageEmpty===true` 时 tokens=0 但确有其事——note 已标 `usageEmpty`，**别当成 0 消耗**；④`durMs` 用墙钟（含归档等待），比 `u.durMin`（子代理 turn 时长）更贴近"这一轮 dream 占用了多久"，两者含义不同，别混。
- **备注**：**不需要额外埋点**（`u` + `startedAt` 现成）。

---

## 3. `maint` —— 合并维护

- **落点**：`runMaintenanceMerge` 定义 `index.js:13768`；**成功路径记账插入点：`index.js:13988` 之后**（`recordMaintSample(... result:"ok" ...)` 那一行的下一行，`return true;` 之前）。
  （失败路径可选：`:13994` `recordMaintSample(... result:"error" ...)` 之后，记 `afterChars: 0` —— 建议**不接**，见"风险"。）
- **现有变量**：
  - `beforeChars` @13796（触发前要点面字数，`String(existingStripped||"").trim().length`）
  - `afterChars` 口径 = **`merged.length`**（与同函数 `recordMaintSample` 的 afterChars 完全同口径，:13988；不要用 `finalText.length`——那含 dump 资产与块标题，口径不同）
  - `overBudgetInject`（是否超预算直接注入）、`slimStats`（`{calls,lens,reason}`）、`fname`、`sid8`
- **建议 delta**（maint 只有 n/inTokens/outTokens/totalTokens/beforeChars/afterChars；durMs/ok/estTokens 传了被忽略）：
```js
p3CostBump("maint", { n: 1, beforeChars: beforeChars, afterChars: merged.length },
  { sid: String(sid8 || ""), trigger: "maint", ok: 1,
    note: fname + (overBudgetInject ? " over-budget" : "") + (slimStats && slimStats.calls ? " slim" + slimStats.calls : "") });
```
- **建议 ev**：见上（`trigger:"maint"` 6 字符；sid 母会话）。
- **风险**：①触发受 `maintRetryAllow`（退避）+ `needMaintenanceMerge`（阈值）双闸，每日个位数轮，ev 安全；②**失败路径不要记**：`beforeChars` 早退路径（no-subagents/空文件/dump-fence-open）都是"没干活"，记 `afterChars:0` 会污染 before→after 的压缩比统计。
- **备注**：**beforeChars/afterChars 不需要额外埋点**。
  token 字段**需要额外埋点，且不建议做**：`compactOnce` @13200 只返回文本（`return txt`，:13263），不返回 usage/时长；且一轮 maint 可能 spawn 1 次主合并 + ≤2 次 slim（:13870/:13890），用 `findNewestSpawnedSession(startedAt)` 只能读到最后一个子会话 ⇒ 漏计。子代理 token 已由 hostUsage 全量覆盖（§0.3），这里只补"维护有效性"两个字符数就够。

---

## 4. `archive` —— 自动归档（漏网会话）

- **落点**：`runStaleArchiveInner` 里的结算 IIFE 尾部，**记账插入点：`index.js:15085` 之后**（`const _wz = summarizeArchiveWitness(...)` 的下一行，`const _cnt = ...`（:15086）之前；`return` 在 :15088）。
- **现有变量**：
  - `u2` @15064 = `await summarizeSubagentUsageRetry(sdir2)` → 同 dream 的 usage 结构；**但它在 `if (sdir2) {`（:15062）与 `if (u2) {`（:15065）作用域内**，需要在 :15062 之前 hoist 一个变量带出来。
  - `_wz` @15085 = `summarizeArchiveWitness(...)` → `{ written, declaredSkip, dropped, lost, charsWritten, charsLost, ... }`（`written` 就是要的"落盘条数"）
  - `flowSessions.length`（本轮候选会话数）、`doneOk`（整轮是否成功）、`startedAt`
- **建议改法（3 处）**：
```js
// ① 在 :15062 `const sdir2 = findNewestSpawnedSession(startedAt);` 之前加：
let _p3ArchU = null;
// ② 在 :15065 `if (u2) { ... }` 块内加一句（任意位置，建议紧跟 `if (u2) {`）：
_p3ArchU = u2;
// ③ 在 :15086 `const _cnt = ...` 之前加：
try {
  p3CostBump("archive", {
    n: 1,
    inTokens: _p3ArchU ? (_p3ArchU.totalIn || _p3ArchU.input || 0) : 0,
    outTokens: _p3ArchU ? (_p3ArchU.output || 0) : 0,
    totalTokens: _p3ArchU ? ((_p3ArchU.totalIn || _p3ArchU.input || 0) + (_p3ArchU.output || 0)) : 0,
    written: (_wz && _wz.written) || 0
  }, {
    sid: "", trigger: "archive", ok: doneOk ? 1 : 0,
    note: "written:" + ((_wz && _wz.written) || 0) + "/" + flowSessions.length
      + (_p3ArchU && _p3ArchU.usageEmpty ? " usageEmpty" : "") + (doneOk ? "" : " partial")
  });
} catch (eP3a) {}
```
- **建议 ev**：见上（`trigger:"archive"` 7 字符；归档是全局动作，sid 留空）。
- **风险**：①`archive` KIND_FIELDS **没有 cacheReadTokens**（缓存命中记不进去；要记须先扩 p3-cost.js 字段表）；②`usageEmpty=true` 时 tokens=0 但 written>0，note 已标；③归档发起受 60 分钟/24 小时节流（:14282-14284 区域），极低频，ev 安全；④**manual `stale_archive` 工具与自动 tick 都走同一条 `runStaleArchiveInner` 结算** ⇒ 只在这一处接就不会重复。
- **备注**：需要 hoist `_p3ArchU`（1 行）；**不需要新增开始时间**（`startedAt` 已有）。

---

## 5. `export` —— 导出 `_export/`

- **落点**：`topicDbAutoExport` 定义 `index.js:8469`；**记账插入点：`index.js:8549` 之后**（`res.export = entry;` 之后；`res.dir`/`res.file`/`res.export` 三行在 :8547-8549）。等价可选点：`const entry = {...}`（:8510-8515）之后直接用 entry 字段。
- **现有变量**：
  - `entry.bytes` @8512（`Buffer.byteLength(md, "utf8")`）、`entry.durationMs` @8514（`Date.now() - t0`，`t0` 在 :8492）、`entry.mdChars`、`entry.topics`、`entry.sentences`、`entry.chars`
  - `reason`（"session"/"manual"/…）；`TOPICDB_EXPORT.lastAt`
- **建议 delta**（export 只有 n/bytes/durMs）：
```js
p3CostBump("export", { n: 1, bytes: entry.bytes, durMs: entry.durationMs },
  { trigger: "exp", ok: 1, note: reason + " topics:" + entry.topics + " chars:" + entry.mdChars });
```
- **建议 ev**：见上（`trigger:"exp"` 3 字符；导出是全局动作，sid 留空）。
- **风险**：①30 分钟节流 + 6 小时 session-gap 双闸（常量 :8409-8410；判定 :8479 / :8485），极低频；②失败路径（`} catch (e) { res.ok = false;` @8558）没有 bytes/durMs 语义，**不要记**（要留痕就只 `pushEvent` 一条 ok:0，不动 n/bytes）；③exports 的 manifest 写盘发生在 entry 之后，`entry.durationMs` 不含 manifest IO（约 +1 次小文件写）——口径偏差可忽略，但要知道。
- **备注**：**不需要额外埋点**（bytes/durationMs 现成）。

---

## 6. `memorySearch` —— memory_search 工具

- **落点**：handler 主体 `async execute(args) {` @18346；**不改 handler 返回值**，在主题库包装之后、注册之前套一层计时 wrapper——**记账插入点：`index.js:18500` 之前**（`compatTool(toolSvc, memorySearchToolDef);` 的上一行）。
  为什么放这里：①此处是**最终返回串**（含 TOPICDB 主题块包装，:18484-18499），"模型实际看到多少字"口径正确；②`MEMORY_SEARCH_EXEC`（:18480，`/memory-search` 命令）是对 `memorySearchToolDef.execute` 的**属性闭包**（调用时取），所以命令层也会走这层 wrapper，天然同源。
- **现有变量**（wrapper 内自造/可取）：
  - `t0`（自造 `Date.now()`）、`r`（最终返回 string）、`args`/`a`、`exec`（宿主传第二参，`exec.agent.session.id` 与 `memory_size_preview` @18564 同款用法）
  - 命中/未命中判据：零结果文案以 `未找到匹配「` 开头（:18438 附近），query 无有效 token 文案以 `未提取到有效关键词` 开头（:18413）；用前 300 字窗口判断，避免命中文件正文里含同样字串造成误判。
- **建议代码**（整段可直接粘）：
```js
const _p3MsRaw = memorySearchToolDef.execute.bind(memorySearchToolDef);
memorySearchToolDef.execute = async (a, e) => {
  const _t0 = Date.now();
  const r = await _p3MsRaw(a, e);
  try {
    const txt = typeof r === "string" ? r : String(r == null ? "" : r);
    const _head = txt.slice(0, 300);
    const miss = (_head.indexOf("未找到匹配「") >= 0 || _head.indexOf("未提取到有效关键词") >= 0) ? 1 : 0;
    const _sid = (e && e.agent && e.agent.session && e.agent.session.id) || "";
    p3CostBump("memorySearch", { n: 1, resultChars: txt.length, durMs: Date.now() - _t0, miss: miss },
      miss ? { sid: _sid, trigger: "search", ok: 0, resultChars: txt.length, durMs: Date.now() - _t0 } : undefined);
  } catch (eC) { /* 记账失败不影响检索 */ }
  return r;
};
```
- **建议 ev**：**只在 miss 时传**（见上）。命中不传 ev —— 检索是高频操作，逐次写 ev 会把 500 条环挤满，而 miss 才是排查"检索断链"的信号。
- **风险**：①**高频**（每个工具步都可能调）——即使不传 ev，`p3CostBump` 每次也要读整个 .monitor.json；若实测 IO 明显，可降级为"只在 miss 时 bump"（连 totals 都省）；②`durMs` 含 wrapper 前的全部检索耗时（含 readText 磁盘读），是真实端到端耗时；③命令层 `/memory-search` 传 `(a)` 无 exec → `_sid` 为空，可接受；④`p3-cost.js` 无 `memorySearch.estTokens` 字段，`resultChars` 不进 est 总量（只进分项 chars）。
- **备注**：**不需要额外埋点**（t0 在 wrapper 内）。若不想新增 wrapper，可在每个 `return "..."` 前加 bump（handler 有 6 个 return 点：:18371/:18407/:18413/:18438/:18472/:18474 区域），但那样 topicdb 包装后的最终长度量不到，**不推荐**。

---

## 7. `hintA` / `hintB` / `hintC` —— 三类提醒注入

### 7.1 `hintA`（A 类·关键词命中记忆/技能，pre-step 当轮直入）

- **落点**：A 类 `agent/pre-step` handler 内：`hintText` 构造 `index.js:17165-17168`；`monitorHintA(...)` @17174；注入 **`if (decision.kind === "enter") {` @17180** 内、`const hintMsg = makeMessage(hintText);` @17181。
  **记账插入点：`index.js:17181` 之前**（即 enter 分支第一行）。
- **现有变量**：`hintText`（已含 `<system-reminder>` 包装，`hintText.length` 即注入字数）、`sid` @17061、`memHits`（命中项数组，`memHits[0].file`/`.name`）、`decision`
- **建议 delta**（hintA 只有 n/injectedChars；estTokens 字段不存在）：
```js
p3CostBump("hintA", { n: 1, injectedChars: hintText.length },
  { sid: sid, trigger: "A", ok: 1, note: (memHits[0] && memHits[0].file) || "" });
```
- **建议 ev**：见上（`trigger:"A"`；note 记命中文件，便于回查"哪类领域最常触发"）。
- **风险**：①A 类有"隔一条输入"冷却（:17089-17093）与领域去重（:17144-17145），低频；②**必须放 enter 分支内**：`monitorHintA` @17174 在 enter 判断之前执行（reject 决策也计 hints），但不能照它挂——reject 时 hintText 并未注入。
- **备注**：**不需要额外埋点**。

### 7.2 `hintB` / `hintC`（B 类重复错误 / C 类连续失败，tools/result 失败分支）

- **落点**：失败分支 handler 内：`monitorHintBC(c === 2 ? "B" : "C", sig);` @17555；`hint` 三元构造 @17566-17571；plugin 子代理直返闸 `if (kind === 'plugin') return;` @17565；入队 `enqueueRegressionReminder(sid, sig, hint);` @17570。
  **记账插入点：`index.js:17570` 之前**（`enqueueRegressionReminder(sid, sig, hint);` 上一行，已过 plugin 闸）。
- **现有变量**：`hint`（注入正文）、`sid` @17505、`sig`（归一化错误签名）、`disp`、`c`（2=B / 3=C）、`toolName`
- **建议 delta**（B/C 共用一行，kind 按 c 分流）：
```js
p3CostBump(c === 2 ? "hintB" : "hintC", { n: 1, injectedChars: hint.length },
  { sid: sid, trigger: c === 2 ? "B" : "C", ok: 1, note: String(sig || "").slice(0, 60) });
```
- **建议 ev**：见上（`trigger:"B"/"C"`；note 存错误签名，便于离线分析"哪类错误最常重复"——与 `monitorHintBC` 的 `monitorEvent("hint"+type, {sig})` 同源）。
- **风险**：①每个 `(sid,sig)` 至多 B 一次 + C 一次（`c===2||c===3` 才进，:17551），且异签名 10 分钟冷却（:17552-17553）⇒ 低频；②**语义是"入队"不是"已注入"**：真正注入在另一个 pre-step handler 消费（`const hintMsg = makeMessage(pending.text);` @17212），会话结束前未消费的条目会丢（影响 ≤1 条/会话，可接受）；③若你更想要"实际注入"口径，可在 :17212 处按 `pending.sig` 前缀分流记，但那里 D/E/W 提醒共用同一队列，**无法区分 B/C**（会被迫给 D/E/W 也记账），所以**建议仍在入队处记**。
- **备注**：**不需要额外埋点**。`c>3` 之后的回归退避提醒 `reHint`（@17542 `enqueueRegressionReminder(sid, sig, reHint)`）是另一类语义（回归接管），**不要混入 hintB/C**；要单独统计应新开 kind（不在本次范围）。

---

## 8. （附加）`checkpointWrite` 成功 / 失败 / 重试路径

- **现状**：压缩事件进来时已记一条"压缩发生"：`index.js:17738`
  `p3CostBump("checkpointWrite", { n:1, inChars: text.length, estTokens: p3Cost.estTokens?.(text.length)||0, trigger:"T4", ok:1 }, { sid: session.id, trigger:"T4", ok:1, inChars: text.length })`
  —— 但**不知道检查点子代理最后成功没有**（现在只有 clog/monitorEvent）。
- **落点**（4 处，全部现成变量）：
  1. **成功（DB 路由）**：`index.js:14179` 之后（`intentRetrySucceed(compactionId);` 的下一行）——此处 `sum` 是归一化后的最终检查点正文。
  2. **成功（md 写回）**：`index.js:14203` 之后（同样 `intentRetrySucceed(compactionId);` 的下一行）。
  3. **失败（唯一收口）**：`intentRetryFail` @14088 函数体内，**`let enq = null;` @14091 之后**（5 个失败分支 + throw 都经此函数）。
  4. **重试次数**：`spawnIntentCheckpoint` 内 `INTENT_RUNNING = true;` @14119 之后，用已有 `_retryCall`（定义 :14101 `const _retryCall = !!(opts && opts.retry);`）。
- **额外埋点（唯一需要的一处）**：在 `INTENT_RUNNING = true;` @14119 之后加一行 `const _p3t0 = Date.now();`（量 spawn→settle 真实耗时；不引入新状态）。
- **建议代码**：
```js
// ① :14119 之后新增
const _p3t0 = Date.now();
if (_retryCall) p3CostBump("checkpointWrite", { n: 0, retry: 1 },
  { sid: sessionId, trigger: "I-retry", note: "intent-retry" });

// ② 成功（:14179 与 :14203 两处 `intentRetrySucceed(compactionId);` 之后各加一次）
p3CostBump("checkpointWrite",
  { n: 0, outChars: sum.length, estTokens: p3Cost.estTokens(sum.length), durMs: Date.now() - _p3t0 },
  { sid: sessionId, trigger: "I-ok", ok: 1, outChars: sum.length, durMs: Date.now() - _p3t0,
    note: "intent-ok" + (_retryCall ? "-retry" : "") });

// ③ 失败（:14091 `let enq = null;` 之后）
p3CostBump("checkpointWrite",
  { n: 0, fail: 1, timeout: /abort|timeout|hard/i.test(String(reason || "")) ? 1 : 0 },
  { sid: sessionId, trigger: "I-fail", ok: 0, note: String(reason || "").slice(0, 80) });
```
- **为什么用 `n: 0`**：`applyDelta` 对 0 值直接跳过（`p3-cost.js:146-147`）⇒ 成功/失败/重试**不会**增加"压缩事件次数"，`n` 的唯一来源仍是 :17738 那条；`outChars/fail/retry/durMs` 正常累加。`daily` 同理会跳过 0。
- **建议 ev**：`trigger` 用 `I-ok`/`I-fail`/`I-retry`（**不要 T1-T6**，理由见 §0.2），`ok` 只在 ev 里表达成功失败（checkpointWrite 的 delta 没有 ok 字段）。
- **风险**：
  1. **不要重复记**：幂等早退分支 `:14130`（marker 已存在 → 直接 `intentRetrySucceed` 并 return）不经过 :14179/:14203，所以不会重复记 outChars——这是正确语义（本轮没跑子代理）。
  2. 补火失败每次都会各记 1 次 `fail`（`fireIntentRetry`→`spawnIntentCheckpoint`→`intentRetryFail`），这正是想要的"重试失败可见"；同一 compactionId 至多 3 次补火（1/5/15min）+ 熔断，不会无限涨。
  3. **`topSessions` 口径变化**：`p3-cost.js:305-325` 的 `n` 是**事件条数**（每 pushEvent 一条就 +1），给 checkpointWrite 补 3 类事件后，顶会话的 n 从"每次压缩 1"变成"1 + 成功/失败/重试条数"。若面板在意这个数，**成功/失败记账不传 ev**（totals 仍完整）；若更想要成功率明细，就传 ev，并在面板注释 n 的口径。
  4. `ev.trigger` 若误写成 `T4`，会污染 `triggersOf` 的 T4 统计（§0.2）。
- **备注**：需要加 `_p3t0` 一行；不想动 6 处的话可退化为"只记 fail + outChars，不记 durMs/retry"（去掉 ④ 与 `_p3t0`）。

---

## 9. 锚点重定位脚本（改代码前先跑，只读）

```powershell
$p='E:\工具\插件开发调整\dsh-memory-plugin\index.js'
"sha256=" + (Get-FileHash $p -Algorithm SHA256).Hash
"lines=" + (Get-Content $p).Count
$anchors = @(
 'async function buildPostCompactRehydrate(agent, opts) {',
 'rehydrate = await buildPostCompactRehydrate(targetAgent);',
 'let doneOk = LAST_DREAM_WROTE_AT >= startedAt;',
 'guardClear(String(run.id || ""));   // v2.6.1',
 'async function runDreamPipeline(reason, agentForParent) {',
 'recordMaintSample(Object.assign({ fname, beforeChars, afterChars: merged.length, result: "ok"',
 'const sdir2 = findNewestSpawnedSession(startedAt);',
 'const u2 = await summarizeSubagentUsageRetry(sdir2);',
 'const _wz = summarizeArchiveWitness(Array.from(LAST_ARCHIVE_WITNESS.entries()), LAST_ARCHIVE_A5_OK);',
 'const entry = {',
 'res.export = entry;',
 'async function topicDbAutoExport(opts) {',
 'compatTool(toolSvc, memorySearchToolDef);',
 'const hintText = "<system-reminder>\n【dsh-memory 提示】"',
 'if (decision.kind === "enter") {',
 'const hintMsg = makeMessage(hintText);',
 'monitorHintBC(c === 2 ? "B" : "C", sig);',
 'const hint = c === 2',
 'enqueueRegressionReminder(sid, sig, hint);',
 'p3CostBump("checkpointWrite", { n: 1, inChars: text.length',
 'function intentRetryFail(compactionId, summaryText, fname, sessionId, reason) {',
 'let enq = null;',
 'const _retryCall = !!(opts && opts.retry);',
 'INTENT_RUNNING = true;',
 'intentRetrySucceed(compactionId);   // P0-2：落库成功才进去重集 + 清重试队列',
 'intentRetrySucceed(compactionId);   // P0-2：md 写回成功才进去重集 + 清重试队列'
)
Select-String -Path $p -Pattern $anchors -SimpleMatch | % { "{0}`t{1}" -f $_.LineNumber, $_.Line.Trim() }
```

若输出 sha ≠ `48A296C3…`：行号按「本文行号 + (新行数 - 20936)」粗调不靠谱，**请直接用上面的输出替换本文行号**（每条都有对应锚点）。

---

## 10. 接线优先级排序

| 优先级 | kind | 理由 | 工作量 |
|---|---|---|---|
| **P0-1** | `dream` | 唯一"每次 dream 烧全工具集子代理"的环节（Lead 已实测 writer tools JSON ≈348KB）；现在完全没有面板数据 | 1 处插入，零额外埋点 |
| **P0-2** | `checkpointWrite` 成功/失败/重试 | 检查点是主链路，现在只记"压缩发生了"，成功率不可见；失败还会进重试队列，最需要观测 | 4 处 + 1 行 `_p3t0` |
| **P0-3** | `archive` | 每轮归档 spawn 多批子代理；usage（`u2`）与 written（`_wz`）都已读好，只差 hoist 1 行 | 3 处小改 |
| **P1-1** | `maint` | `beforeChars/afterChars` 直接回答"维护有没有把注入面收敛"（面板已有 maint sample，cost 段是补充）；tokens 交给 hostUsage | 1 处插入 |
| **P1-2** | `rebuildInject` | P4-R2 刚上线，需要验证"压缩后重灌真的注入了多少字"；chars 现成、每压缩一次一条 | 1 处插入 |
| **P2** | `memorySearch` | 能看出检索端到端耗时/结果体积/miss 率；但高频，必须"只在 miss 传 ev" | 1 个 wrapper |
| **P3（不建议）** | `export` | 无 token 语义（bytes/durMs 只是本地写盘），30 分钟才一次；面板多一行也没人看 | 1 处插入（可留空） |
| **P3（不建议）** | `hintA`/`hintB`/`hintC` | 每条 100~300 字 ≈ 25~75 estTokens，但字段表里**没有 estTokens** ⇒ 连估算 token 都进不了总量；且 `d.hints.A/B/C` 已有计数（.monitor.json）。接了的收益 ≈ 噪声 | 3 处插入 |

**建议先接 P0 三项（dream / checkpointWrite 结果 / archive）**：一小时内可完成，覆盖 80% 的"真实烧钱在哪"的问题。

---

## 11. 哪些点不建议接，以及为什么

1. **`export`**：`bytes/durMs` 度量的是本地 fs 写盘，不是模型消耗；频率被 30 分钟节流锁死，面板上多一行 `export` 只会稀释 13 个 kind 的信息密度。**除非**你要审"导出 IO 是否拖慢主流程"，否则不接。
2. **`hintA`/`hintB`/`hintC`**：三类提醒单条 100~300 字，estTokens 最多 ~75；而 `p3-cost.js` 的 KIND_FIELDS 里这三类**没有 estTokens 字段**（:26），连算进 est.total 的资格都没有；同时 `.monitor.json` 的 `hints.A/B/C`（:5116-5131）已经在计次。**重复记账、无 token 价值**。若一定要接，只接 `hintA`（频率最低、最可能影响行为）。
3. **不要给 `dream`/`maint`/`archive` 的 token 字段做"总量"**：它们与 `hostUsage` 重复归因（§0.3）。可以记（用于归因拆分），但面板/文档必须标明是 hostUsage 的子集，禁止相加。
4. **不要给 `memorySearch` 逐次传 ev**：检索是最频繁的工具之一，逐次进 500 条 events 环会把压缩/检查点这类"每会话个位数"的高价值事件挤掉。totals 记 + miss 才记明细。
5. **不要给 `maint` 失败路径记 `afterChars:0`**：会把 before→after 压缩比统计拖偏；失败信息在 `.monitor.json` 的 maint sample 里已有。
6. **不要给 `rerun/补火` 单独开 kind**：`checkpointWrite` 的 `retry/fail` 字段就是干这个的（`p3-cost.js:22`），别新增 kind 破坏 KIND_LIST 面板顺序。

---

## 12. 附：本文引用的关键定义位置

| 内容 | 位置 |
|---|---|
| `p3CostBump` 助手 | index.js:4683 |
| `hostUsage` 记账（含子代理会话） | index.js:4766（`assistant/message` 分支 :4759-4792） |
| R3 `recallReminder`（已接线样板） | index.js:4804 / :4807 |
| R1 `startupInject`（已接线样板 ×2） | index.js:16819 / :16832 |
| 压缩事件 `checkpointWrite`（已接线样板） | index.js:17738 |
| `buildPostCompactRehydrate` 返回 `{text,dropped,checkpointFile,chars}` | index.js:15457 / :15554 |
| `summarizeSubagentUsage` 返回字段 | index.js:18974-19004（`input/output/cache/totalIn/reasoning/durMin`） |
| `summarizeSubagentUsageRetry` 追加 `usageRetry/usageReadAt/usageEmpty` | index.js:19047 |
| `summarizeArchiveWitness` 的 `written` 等字段 | index.js:6351（定义）/ :15085（消费处） |
| `compactOnce`（只返回文本，不含 usage） | index.js:13200 / return :13263 |
| KIND_FIELDS / estTokens 派生 / events 白名单 | p3-cost.js:21-33 / :127-131 / :180-201 |
| `triggersOf`（ev.trigger T1-T6 口径） | p3-cost.js:268-291 |
| `topSessions`（n = 事件条数） | p3-cost.js:305-325 |
