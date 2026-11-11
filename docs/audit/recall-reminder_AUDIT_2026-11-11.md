# 4.5.15 记忆检索提醒 + 升级协议 + 重建注入 — CRA 审计①（只审方案）

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（HEAD `cea409d`，`index.js` 22875 行；工作区仅 3 个未跟踪项：本方案 md、`index.js.v3.0.1.frozen`、`mem-writer-tools/`）。
- 待审方案：`docs\方案-4.5.15-记忆检索提醒与升级协议.md`（133 行，全文已读）。
- 审计方式：**只读**。未改仓库代码、未部署、未提交、未写记忆库；除本文件外未写任何文件。隔离探针脚本落在 `%TEMP%`，home 指向 `os.tmpdir()` 临时目录（探针跑完已删）。
- 证据来源：① 逐行读 `index.js` / `p3-readside.js` / `p3-cost.js` / `_fixture-ctx.mjs` / 相关门与自测；② **独立跑 3 个隔离门**（`test/_alignment-discipline-selftest.mjs` 28/28 绿、`_gate-plugin-load.mjs index.js` FAIL 1/PASS 111、`_test-search-commands.mjs index.js` FAIL 3/PASS 10）；③ 1 个隔离探针（md 模式原语 null-safety / pre-step handler 注册顺序与注入行为 / p3-cost 未知 kind 行为）；④ MiMo 原文逐条核对（`session/prompt.ts`、`session/checkpoint.ts`、`tool/memory.txt`、`tool/history.txt`）。
- 行号口径：`文件:行`，均为**本次实测的当前工作区**行号（HEAD `cea409d`，无未提交代码改动）。

---

## 0. 结论摘要（先给判断）

**有条件通过。** 方向正确、MiMo 三处借鉴（per-turn recall reminder / 升级协议 / rebuild learnings）原文全部核对成立，方案对「pre-step 尾部注入不落历史」的机制判断也**正确**。
但方案有 **4 类硬问题**，其中 3 类属于「照方案实现会看起来做了、实际不生效或直接顶红」：

1. **关键行号引用错**：方案 §1 把 pre-step handler 标为 `index.js:2614` / `index.js:6402`，实际是 `2615`（回归队列 helper 注释）与 `6402`（`COMPAT.events` 能力自检清单，不是挂载点）。真实 handler 有 **5 处**：`18134`（A 类）/`18298`（回归）/`18327`（合并维护判定）/`18827`（D3 停轮）/`22649`（命令回传）。其中「maint 提醒也用 pre-step」**不成立**——维护提醒走 `agent/created` + `agent.inject`（`18111-18124`），`18327` 的 handler 只做「要不要跑合并」的判定、不注入任何字节。
2. **同类能力已存在但方案没纳入**：仓内**已有**每 8 轮 recall nudge（`p3-readside.js:294-313` + `index.js:6370-6383`），且它**已占用**成本 kind `recallReminder`（`6378`）；Part C 想做的「最近 N 个检查点 + 关键结论/错误与修复摘录」**已有现成实现** `dreamCheckpointEvidence`（`index.js:4938-4976`，含 wsKey 父线过滤与块预算）。不先对齐这两处，Part A 会变成「第二套提醒」、Part C 会重复造轮子。
3. **与现有门直接冲突**（4 处，全部实测确认）：`_rehydrate-gate-selftest.mjs:124-134`（取**第一个** pre-step handler 并断言只 append 1 条）⇒ 新 handler 注册位置决定该门红绿；`_accept-p4.mjs:204-226` 的 `parseRehydrate` 只认 3 个段头 ⇒ 新段头位置错了会把 learnings 正文算进 checkpoint 段体，撞 `:364` 的 ≤2400 断言；`_accept-p4.mjs:380` 断言 `dropped` 不含 profile/project/checkpoint ⇒ learnings 必须排在砍序**最前**；`test/_alignment-discipline-selftest.mjs:45-48` 对 memory_search 描述做**逐字短语**断言（现 28/28 绿）。
4. **三处承诺实测不成立**：① 方案 A2 自称「≤180 字」，样例文本实测 **288 字符**（含标签）；② §4 自称 learnings「≤800 字」，但同段给的配额（2–3 检查点 × 2 节 × ≤2 条 × ≤120 字）上限是 **1440 字**，自相矛盾；③ §5 承诺「md 模式（flag 关）逐字不变」，但 **Part B 没有任何 flag**，工具描述是全局改动 ⇒ md 模式模型可见面必然变化。

必须修改项 **K-1 ~ K-10**（每条可验收），建议项 S-1 ~ S-6。

---

## 1. 假设核对（方案断言 vs 代码事实）

| # | 方案断言（§1/§2/§4/§5） | 代码事实（file:line，本次实测） | 结论 |
|---|---|---|---|
| A1 | 「pre-step 尾部注入已有：改写 `PreStepDecision.enter.messages` 追加 hint，同轮到达、长前缀不变、前缀缓存零影响」 | `index.js:18134-18293`（A 类：`const decision = await next()` → `return { ...decision, messages: [...(decision.messages||[]), hintMsg] }`，`18285-18288`）；机制注释 `194-197`（v2.4.1）。隔离探针：step1 顶层会话注入 1 条，`agent.inject` 调用数 = **0** | ✅ **一致** |
| A2 | 证据行号「`index.js:2614`（pre-step handler）」 | `2615` 是 `dequeueRegressionReminder` 的注释；A 类 handler 在 `18134` | ❌ **行号错**（K-1） |
| A3 | 证据行号「`index.js:6402`（`agent/pre-step` 挂载）」 | `6402` 是 `COMPAT.events` 的计数表项 `"agent/pre-step": 0`，不是挂载点；`compatOn` 包装器在 `6414-6424` | ❌ **行号错**（K-1） |
| A4 | 「A 类提醒 / 回归提醒队列 / **maint 提醒**都用它（pre-step）」 | A 类 `18134`；回归队列 `18298`；**maint 提醒不走 pre-step**：维护提醒（备份/轮转/超限整理）在 `agent/created` 内 `18111-18124` 经 `agent.inject` 注入；`18327` 的 pre-step handler 只做 `needMaintenanceMerge` 判定后 `setTimeout` spawn（`18339-18346`），不 append 任何消息 | ⚠️ **部分错** |
| A5 | 「不能写会话历史/inbox，否则前缀缓存失效+触发重入」 | 隔离探针：A 类注入后 `agent.inject` 0 次；`decision.kind==="reject"` 时 `messages` 为 null（`18313`/`18284` 注释） | ✅ **一致** |
| A6 | 「前缀缓存零影响」 | 机制成立（只在 `decision.messages` 尾部、不落历史）。但**现网另有 3 条 `agent.inject` 类提醒会进历史**：R3 nudge `18867-18876`、压缩合并注入 `19162`、维护提醒 `18111-18124` | ✅ 机制对；⚠️ 方案「现有提醒都是 pre-step」的隐含前提不准 |
| A7 | 「仅顶层会话（子代理注入曾致 ghost 回合，F1 守卫）」 | `18164`：`if (!isTopLevelSession(agent)) return decision;`；`isTopLevelSession` = `session.header.origin === 'subagent'` 判定（`13987-13993`）；回归队列对 plugin 子代理有 `PL:` 例外（`18306`） | ✅ **一致** |
| A8 | A 类/回归队列的「消费顺序」 | 注册序（实测探针：pre-step 共 5 个 handler，序 0..4）= A 类 `18134` → 回归 `18298` → 合并判定 `18327` → D3 `18827` → 命令回传 `22649`。waterfall 语义：**同一插件内先注册=外层**（每个 handler 都 `await next()` 后 append，`18285-18288`/`18317-18318`/`22661`）⇒ **最终 messages 数组顺序 = 内层先、外层后** = `[命令回传, (D3/maint 无), 回归, 重灌, A 类]`，**A 类提示恒在数组末尾**（重灌在其前，`18148-18158` 先 append、`18286` 后 append）。⚠️ 跨插件顺序由激活时序决定（`16371` 注释），故「我们的第 1 个 handler」只能按**插件内注册序**认定，不能假定先于/晚于 `compaction-basic` | ✅ 可核对；⇒ 方案「先 A 类后 recall」需注册在 A **之前**（K-4） |
| A9 | R2 现状「等 writer 结算 → 取最新检查点 + 项目/画像」 | 段结构 **4 段**：checkpoint / project / profile / note（`16421-16618`）；段预算 `POST_COMPACT_REHYDRATE_BUDGET = {checkpoint:2400, project:1150, profile:350, note:1900}`（`16361`）；总收口 `R2_TOTAL=6100`（`16569-16573`）；砍序 **profile → project → note → checkpoint**（`16577-16608`）；监控行 `16613-16615` | ✅ 一致；但方案 §4「总注入预算在原 R2 上限内」未写出这个 6100 与砍序（K-9） |
| A10 | `memory_search` 描述现状（Part B1 要追加三段式） | `index.js:19998` 描述**已含**：`命中即信`、`0 结果时按返回文案的升级路径处理（换词 → read 直读 → 查最近会话摘要）`、`要精确字面量…用 session_search 回原始会话捞逐字原文——不要从摘要反推或猜` | ⚠️ B1 三点中 **2 点已存在**，增量只剩「memory_topics 直查」与措辞统一（S-3） |
| A11 | `session_search` 描述现状（Part B2 要追加「仅在 memory_search 无有用结果时使用」） | `index.js:19311-19314` **已写**：「当记忆库（memory_search）里**没有、或记不准**某个字面量时，回原始会话原文把它捞出来」「分工：memory_search 查已沉淀的**结论**；session_search 查**原始对话**」 | ⚠️ B2 增量价值低；且 `_gate-plugin-load.mjs:201-202` 断言「归档时**抽取好的会话正文**」必须逐字保留 |
| A12 | flag 落点「四件套」 | `DEFAULT_CFG` `7759`；`SETTINGS_SCHEMA` `7826`；`normalizeCfg` `7909`；`WRITABLE` 白名单 `13764-13767`（热更新走 `13787` `PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config))`）；client 面板是 schema 驱动、**不枚举 flag**（`client/lib/client.js` 无 flag 名） | ✅ 四件套齐；⚠️ 若做成本埋点则是**第 5/6 处**（K-3） |
| A13 | 「md 模式（flag 关）逐字不变」 | `memoryTopicDbEnabled` 默认 **false**（`7768`）；隔离探针实测 md 模式 `__topicdb.ready=false, store=false`；`memory_topics` 描述自述「flag 关时本工具不注册」（`12999`），`memory_read` 同（`13122`）。**现网真配置是 db 模式**（`~/.dsh/memory/.config.json`：`memoryTopicDbEnabled: true`，mem.db 29.7 MB） | ❌ 承诺不成立（K-10）：Part B 无 flag，描述全局变 |
| A14 | 「现有提醒…缺每轮保温」 | **已有 R3 每 8 轮轻提醒**：`p3Readside.shouldNudge/buildRecallNudge`（`p3-readside.js:294-333`）在 `index.js:6370-6383` 消费，文本 `【记忆轻提醒】…如需历史细节可 memory_search…`（≤200 字），注入走 `agent.inject`（`18867-18876`），成本 kind **`recallReminder`**（`6378`） | ❌ 判断不准：缺的是「每轮/条件化」，不是「保温」（K-2） |
| A15 | Part C「累积学习 + 验证再行动」是新增能力 | **已有 `dreamCheckpointEvidence`**（`4938-4976`）：取最近 N 个会话检查点主题（按 `p25Topics.parseSessionTopicName` + 父线 `会话检查点·<wsKey>` 双条件过滤，`4943-4950`），逐条抽「关键结论」「错误与修复」两节（`4962-4967`），带块预算 `cap` 与 `maxItems`。性能注记：`store.topics()` 单次约 **684 ms**（`4988` 注释「原 4 次 ×684ms」） | ⚠️ 可复用；且必须防「每次压缩 +~700ms」（K-9⑤） |
| A16 | 「P2.5 会话主题存在 ⇒ 本会话已有检查点」 | P2.5 会话主题**每会话恒 1 句、覆盖写**（`index.js:4954`「每会话恒 1 句，写入由插件负责」；写入侧先 `deleteSentence` 再 `appendSentence`，`9288`/`9304`、`9316`/`9337`） | ✅ 判据可用；⇒「最近 2–3 个检查点」只能是 **2–3 个不同会话**，不是同一会话的历史检查点（K-9④） |

**方案 §1 三句核心假设的结论**：「pre-step 尾部注入」✅、「不写历史/inbox」✅、「前缀缓存零影响」✅、「仅顶层会话」✅；但「maint 提醒也用 pre-step」❌，且「现有提醒都走 pre-step」的隐含前提 ❌（R3/压缩/维护三条走 `agent.inject`）。

---

## 2. D-1 ~ D-6 裁决

### D-1 触发条件是否够/过宽？
**裁决：过宽 + 漏判，需改（K-6）。**
- 条件 1（本会话有检查点：P2.5 主题 或 `p3.sessions[sid].checkpointAt`）方向正确。`checkpointAt` 是通用回填（`p3MarkCheckpointDone`，`7445-7451`），T1/T4/T5 任何 cid 写成功都置位 ⇒ 覆盖「md 模式也有检查点」。
- 条件 2（未提炼笔记 > 0）正确，且实测 `__noteUnrefinedCount(null/[])` 均返回 0（null-safe）。
- **条件 3（本会话当前注入面包含记忆切片）近乎恒真**：`INJECT_SNAPSHOT` 只在 `injectedParts.length > 0` 时记账（`18084`），而任何有 `global.md`/`index.md`/项目记忆/最近摘要的库都会命中 ⇒ 等于「只要记忆库非空就每轮提醒」。MiMo 的 `hasMemoryOrTasks` 是「**本会话** memory 目录非空 **或** 本会话有 task 记录」（`session/checkpoint.ts:1155-1164`），语义是「本会话有产物」，比我们窄。
- **漏判**：MiMo 的第二支「本会话有 task 记录」我们没有对应条件。本仓有 todo/goal 事件快照（`p1RecordSessionEvent` 调用点 `18861`、`readRecentSessionFacts` 测试钩子 `22793`），纯任务型会话（无检查点、无笔记）会拿不到提醒。
- 新会话首轮无记忆 ⇒ 不提醒：**可接受**（MiMo 同款，`hasMemoryOrTasks` 为 false 时不注入）。

### D-2 每轮 ~150 token 成本 vs 收益？
**裁决：成本可接受，节流口径有害，需改（K-5）。**
- 实测中位 2.3 轮/时（`test/_note-remind-selftest.mjs:4` 引实测）⇒ 每用户消息 ~200 token 属噪声级；且只在 `step===1` 注入，天然「每轮一次」。
- **但「同一会话 2 分钟内最多一次」与「注入不落历史」直接矛盾**：注入只存在于当轮请求（`18282-18283`），**下一轮上下文里没有它**；被 2 分钟节流掉的轮次，模型**完全没有**这条提示（不是「已经看过」）。快速连续追问（实测很常见）会成片丢失。
- 方案 A2 自称「≤180 字」：样例文本实测 **288 字符**（含 `<system-reminder>` 标签，6 行）⇒ 实际约 180–220 token，超自己预算 60%（同类前科：v2.3.7 注释 `index.js:206`「废笼统『总长≤800』（模型数不清字符，实测 1132 超纲）」）。

### D-3 与 A 类/回归提醒合并成一条的复杂度？
**裁决：改为独立第二条（不合并）。**
- 实测 5 个 handler 的 waterfall 顺序与 append 顺序（见 A8）：**A 类恒为数组最后一条**，回归在其前，命令回传最前。要做到「先 A 类后 recall」只有两条路：①新 handler 注册在 A **之前**（外层）——但这会让 `_rehydrate-gate-selftest.mjs:124` 的 `.find(h => h.event === "agent/pre-step")` 取到新 handler，B9 的 `arr1.length === 1` 直接红（K-4）；②改 A handler 内部文案装配（`18270-18273`）——会动 A 的冷却序号（`MEMORY_HINT_LAST_SEQ`）、领域去重（`MEMORY_HINT_SEEN`）与 `monitorHintA` 记账语义，风险远大于收益。
- 而且「只允许一条 `<system-reminder>`」**不是**宿主/门的硬约束：`_accept-p1.mjs:180`、`_accept-p4.mjs:280` 的「单条包裹」断言测的是**压缩合并注入**（`agent.inject` 通道），与 pre-step 无关；pre-step 侧本来就可以多条（重灌 + A 类已并存）。
- 结论：**独立 handler 追加第二条**；若产品上坚持只一条，则改为「A 类命中时在 A 的 hint 文本内追加 3 行」并在方案里写清「回归队列那条仍是独立第二条」（否则承诺落不了地）。

### D-4 R2 learnings 的预算与去重口径？
**裁决：必须重写（K-9）。**
- 预算不自洽：`≤800 字` vs「2–3 检查点 × 2 节 × ≤2 条 × ≤120 字」= **最多 1440 字**。
- 砍序未定义：现有砍序是 `profile → project → note → checkpoint`（`16577-16608`）。新段若不排在 **profile 之前**先砍，饱和态会先砍掉画像 ⇒ `_accept-p4.mjs:380`（`dropped` 不含 profile/project/checkpoint）直接红。
- 段头位置未定义：`_accept-p4.mjs:204-226` 的 `parseRehydrate` 只认 `检查点续接/项目记忆/用户画像/压缩后记忆重灌` 四个头；新段头若插在 `【检查点续接】` **之后**，其正文会被计入 `segs.checkpoint` ⇒ `:364` 的 `cpBody.length ≤ 2400` 可能红。
- 去重口径未定义：①**必须排除本会话检查点**（P2.5 每会话恒 1 句，`4954`），否则「关键结论/错误与修复」与段①「Current snapshot 全文」重复注入；②跨检查点重复结论的归一化口径（去空白/去标点/NFKC？`nzCp` 在 `4937` 已有现成实现）；③跨会话取数必须限定**同 wsKey**（`dreamCheckpointEvidence:4943-4950` 已按父线过滤，直接复用即可，别新写一套）。

### D-5 工具描述变更是否同步 README/AGENTS 模板？
**裁决：不改 AGENTS 模板（D-5 结论：否）。**
- `AGENTS.template.md` 是**每次会话自动注入的前缀内容**（模板头第 3 行自述），且安装器对旧模板做 SHA 白名单归一化（`install.ps1:249-251`）。改它 = 所有会话前缀缓存一次性全失效 + 安装器白名单/版本号同步（`<!-- dsh-memory-agents-template: v4 -->`），成本与 4.5.15 的收益不匹配。
- README 可加（不进前缀，零缓存成本）。工具描述本身已在前缀里，改它同样是一次性 cache miss——方案应写明「升级后首轮全量 cache miss」（S-5）。

### D-6 `recallReminder` 默认 true？
**裁决：可以默认 true，但必须满足 4 个前提（K-6/K-10）。**
- 前提：①md 模式行为显式定义（默认安装就是 md 模式，`7768`）；②与 R3 协调（否则 turn 8 会有两条相似提醒）；③teammate/子代理不注入（F1 已保证）；④设置页可关（`WRITABLE` 已含）。
- **不建议**按模型分档：仓内无「按模型调行为」的先例与数据，加维度只会增加不可验证面。

---

## 3. 方案漏洞（H-1 ~ H-11，全部可复现）

**H-1（误判）触发条件 3 近恒真** — 见 D-1。`18084` 只在「有非空注入」时记账 ⇒ 条件 3 ≈「记忆库非空」。后果：与任务无关的每轮 200 token 噪声；且「有可召回记忆」的文案在纯新任务会话里是**误导**（模型会去搜不存在的东西）。

**H-2（重复）与 R3 每 8 轮提醒撞车，且成本 kind 撞名** — R3 已存在（`6370-6383`，文本 `p3-readside.js:57-61`，≤200 字，`agent.inject` 注入历史）。turn 8 且 step1 时会同时出现「【记忆轻提醒】…」与新的「【记忆检索】…」。更硬的问题：R3 已占用 `p3CostBump("recallReminder", …)`（`6378`），方案 A3 想记的 `recall-inject` 是**未知 kind**——实测 `p3-cost.bumpKind` 对未知 kind 经 `ensureRecord` 返回 null 后**静默丢弃**（`p3-cost.js:113-120`、`143-145`；探针：`bumpKind(c,"recall-inject",…)` 后账本无该桶）。⇒ 埋点写了等于没写。

**H-3（顺序/注册）handler 注册位置会打红现有门** — 见 D-3。`_rehydrate-gate-selftest.mjs:124-134` 取第一个 pre-step handler 并断言 `arr1.length === 1`；注册在 A 之前即红。

**H-4（节流）2 分钟跨轮节流与「注入不落历史」互斥** — 见 D-2。被节流的轮次模型**零提示**；且 abort/retry 同一 step 重放时方案未给去重键（`messages` 里 `makeMessage` 自带 `id`，`1669-1675`；真实用户消息有 `source.kind==="user"`，`18836` 已有用法 ⇒ 去重键可用 `sid + 该 user 消息 id`，方案没写）。

**H-5（R2 预算/解析）** — 见 D-4。预算 800 vs 1440 不自洽；砍序位置未写；新段头会被 `parseRehydrate` 误并入 checkpoint 段；`_accept-p4` B1/B4/B6/B10 四条断言未纳入回归清单。

**H-6（flag 落点不全）** — 四件套（`7759/7826/7909/13764`）齐，但**做成本埋点还有第 5、第 6 处**：`p3-cost.js:13-31`（`KIND_LIST` 15 环节 + `KIND_FIELDS`，且 `KIND_LIST` 已冻结）+ `test/_p3-cost-selftest.mjs:63-71`（`assert.deepEqual(KIND_LIST.slice(), [...15 项])`、`assert.equal(KIND_LIST.length, 15)`、`Object.isFrozen`）与 `:85-101`（逐 kind 字段集）。加 kind 必然打红该自测；不加则埋点静默失效。**这是二选一，方案必须选。**

**H-7（md 模式）「md 模式逐字不变」不成立** — Part B 无 flag；工具描述全局生效。且 md 模式下 `memory_read`/`memory_topics` **不注册**（`12999`/`13122`）⇒ A2 的「→ memory_read <主题ID>」与 B1 的「memory_topics 直查」在默认安装里是**死指针**（现网是真 db 模式，故本次用户看不到这个坑；新装用户会）。另外 `memory_search` 的 0 结果文案（`20102-20106`）仍在教模型「要逐字原文查最近会话摘要：memory_search 查 会话 / sessions」，**与 B2 的「用 session_search」直接矛盾**——只改描述不改 0 结果文案，会得到「描述说 A、返回文案说 B」的分裂指引。

**H-8（工具描述门）回归清单漏 5 个门 + 「只看 exit code」会掩盖新红** — 实测：`_gate-plugin-load.mjs` 整体 FAIL 1/PASS 111，但那 1 条红是**旧文案残留**（「超限 NN B（阈值 NN B）」），描述断言 `:95/:96/:98`（`可直接作为工具调用` / 无 `仅可在 run_code 程序内调用` / 含 `tools.memory_search`）**当前是绿的**；`_test-search-commands.mjs` FAIL 3 全在 CLI argv，与描述无关；`_alignment-discipline-selftest.mjs` **28/28 绿**（`:45-48` 逐字断言 `命中即信`、`要精确字面量`+`session_search 回原始会话捞逐字原文`、`不要从摘要反推或猜`、`命中行尾的 ⟪…⟫ 是该句来源`）。⇒ 三处文案改动只要动到这些短语就新增红行，而**门整体本来就 exit=1**，只看退出码会误判「无回归」。方案 §6 回归清单只列了 7 个门，漏了 `_alignment-discipline-selftest`、`_gate-plugin-load`、`_test-search-commands`、`_p3-cost-selftest`，以及**唯一真实驱动全部 pre-step handler 的门** `_test-size-warn-parity.mjs:82-90`（它 `for (const h of handlers["agent/pre-step"])` 逐个 `step:1` 调用并把 `decision.messages` 序列化成 `out`；E2/E3/E6 是「不该报」的**子串式否定**断言 ⇒ 新增 recall 消息不会顶红，但 `out` 快照必然变化，必须在改动后重跑确认）。

**H-9（成本）工具描述是常驻前缀，不是一次性** — B1 追加约 200 字 ≈ +100 token/**每次请求**（所有会话、所有轮次）；B2 同理。方案只写「纯文案，零行为风险」，未计常驻成本，也未计「描述变更导致升级后首轮全量 cache miss」。

**H-10（合并语义）「与 A 类合并时只加尾部一段」会改 A 的记账语义** — A 类的「注入成功」同时消费三样东西：冷却序号（`MEMORY_HINT_LAST_SEQ.set`，`18275`）、领域已见（`MEMORY_HINT_SEEN`，`18276-18277`）、监控（`monitorHintA`，`18279`）。recall 若搭 A 的车，A 未命中/冷却中时 recall 也发不出去；若让 recall 独立发，则「合并」承诺不成立。两者不能同时成立（K-2）。

**H-11（性能）R2 learnings 取数会拖慢压缩后重灌** — `dreamCheckpointEvidence` 依赖 `store.topics()`，仓内实测约 **684 ms/次**（`4988` 注释，4.5.12 已因「4 次 ×684ms」做过一次取数合并）。R2 在压缩路径上（`16421`，等待 writer 上限 120 s，`16367`），再叠 ~0.7 s 不致命但应显式复用/缓存，否则每次压缩都白付一次全库扫描。

---

## 4. 裁决与必须修改项

### 裁决：**有条件通过**

方向与 MiMo 对齐成立（三处原文核对无误），注入机制判断正确，flag 落点基本齐。但方案含 2 处行号错误、1 处「已有能力未纳入」、4 处与现有门/预算的硬冲突、3 处自相矛盾的量化承诺。以下 K 项全部落实后可进入实现；K-1~K-4、K-8 属于「不落实就会看起来做了实际不生效」级别。

### 必须修改项（K-1 ~ K-10，逐条可验收）

| # | 必须修改 | 验收标准 |
|---|---|---|
| **K-1** | 订正方案内全部代码引用：pre-step handler 实为 `index.js:18134`（A 类）/`18298`（回归）/`18327`（合并判定）/`18827`（D3）/`22649`（命令回传）；删除 `2614`/`6402` 的「挂载点」说法；把「maint 提醒也用 pre-step」改为「maint 提醒走 `agent/created`+`agent.inject`（`18111-18124`）」 | 方案里每条 `文件:行` 都能在 HEAD `cea409d` 上 grep 到语义对应内容；抽查 5 条全对 |
| **K-2** | 明确与 R3 的关系并写死判据（三选一并写明理由）：①新 recall 提醒**替代** R3（把 `everyN:8` 通道关掉或降为兜底）；②R3 保留、新提醒只在「本轮 R3 未投递」时注入；③两者文案合并为同一段文本。并规定同一 turn 内「记忆轻提醒/记忆检索」类提示 ≤1 条 | 夹具：`turn=8` + `step=1` + 有检查点会话 ⇒ 模型可见的同类提示条数 = 1；`turn=7` ⇒ 1 条（仅 recall） |
| **K-3** | 成本埋点二选一并写清落点：**（A）复用** 已有 kind `recallReminder`（`p3-cost.js:14`），用 `ev.trigger` 区分 `R3`/`RT`（`pushEvent` 已支持 ev）；**（B）新增** kind 则必须同时改 `p3-cost.js:13-31` 的 `KIND_LIST`+`KIND_FIELDS`、`test/_p3-cost-selftest.mjs:63-71`（15 环节冻结断言）与 `:85-101` 字段集 | 选 A：`_p3-cost-selftest` 保持绿且 `.monitor.json` 的 `cost.events` 能区分 R3/RT。选 B：`_p3-cost-selftest` 同步改到 16 环节并绿；两种都必须给出「未知 kind 静默丢弃」的反例断言 |
| **K-4** | 写死新 handler 的注册位置与理由，并说明对 `test/_rehydrate-gate-selftest.mjs:124-134`（取第一个 pre-step handler + `arr1.length===1`）的影响；若注册在 A 之前必须同步修改该门（改成按行为定位 A handler） | 该门改后绿；且新增断言「pre-step handler 数量/顺序」与代码一致 |
| **K-5** | 删除「同一会话 2 分钟内最多一次」；改为「每个真实用户消息一次」，去重键 = `sid + 最后一条真实 user 消息的 id`（`makeMessage` 自带 id，`1669-1675`；真实用户消息判据 `source.kind==="user"`，用法见 `18836`）。写明 abort/retry 同 step 重放时的行为 | 夹具：同一 user 消息连续两次 pre-step ⇒ 只注入 1 次；30 s 内两条不同 user 消息 ⇒ 各注入 1 次；合成消息（`source.kind!=="user"`）⇒ 不注入 |
| **K-6** | 触发条件收窄 + 补漏：条件 3 不得单独成立（须与 1/2 之一同时成立，或改用「本会话注入面含 P2.5 会话主题/上会话桥接/项目记忆命中」）；补「本会话有 todo/goal 记录」支（对齐 `checkpoint.ts:1162-1163`）；三判据全部 store-null 安全（md 模式 `topicdb.ready=false`，已实测原语 null-safe） | 夹具：md 模式（`memoryTopicDbEnabled:false`）+ 空库 + 新会话 ⇒ 不注入、不抛；db 模式 + 只有 todo 无检查点 ⇒ 注入 |
| **K-7** | 文案 mode-aware：A2/B1 里的 `memory_read`/`memory_topics` 必须按 `memoryTopicDbEnabled` 生成（md 模式替换为「read 直读 ~/.dsh/memory/ 下文件」）；同时修改 `memory_search` 的 **0 结果文案**（`index.js:20102-20106`）与描述口径统一（不再教「用 memory_search 查 会话/sessions」） | 夹具：md 模式注入文本不含 `memory_read`/`memory_topics`；db 模式含；0 结果文案与描述都指向 `session_search` |
| **K-8** | 回归门清单补齐（9 个）：`_alignment-discipline-selftest`（`:45-48` 逐字断言）、`_gate-plugin-load`（`:95/:96/:98` + `:201-202`）、`_test-search-commands`、`_p3-cost-selftest`、`_test-size-warn-parity`（`:82-90`，唯一真实驱动全部 pre-step handler 的门）、`_accept-p1`/`_accept-p4` 单条包裹断言、`_rehydrate-gate-selftest`、`_note-remind-selftest`、`_p3-readside-selftest`（若采纳 S-1 动 R3）。并规定验收方式 = **FAIL 行集合与基线逐行比对**，不是看 exit code（其中 2 门基线本就 exit=1） | 改动前后：上述门的 FAIL 行文本集合完全一致（新增行 = 0）；`_alignment-discipline` 保持 28/28；`_test-size-warn-parity` E1-E6 全绿 |
| **K-9** | R2 learnings 重写口径：①预算自洽（给出「条数 × 单条上限 ≤ 总预算」的可算公式，或明确「按预算先到先得裁条」）；②砍序首位 = learnings（在 profile 之前），`dropped` 记 `learnings`；③段头位置必须在 `【检查点续接】` 之前，**或**同步扩 `_accept-p4.mjs:204-226` 的 `parseRehydrate`；④排除本会话检查点（`4954` 恒 1 句）；⑤复用 `dreamCheckpointEvidence`（`4938-4976`，wsKey 父线过滤）+ 一次取数（防 `store.topics()` 684 ms ×N） | 饱和夹具：`dropped` 含 `learnings`、不含 profile/project/checkpoint；`cpBody ≤ 2400`；learnings 不含本会话检查点字面量；块总长 ≤ 6100 |
| **K-10** | 承诺订正：把「md 模式（flag 关）逐字不变」拆成两句——「**flag 关 ⇒ 注入零字节 + R2 文本 sha16 == 冻结基线**」与「**工具描述变更对所有模式生效（升级后首轮一次性前缀失效）**」；并把 A2 文本压到 ≤180 字（实测样例 288 字） | flag 关夹具：注入字节数 = 0、R2 sha16 == 基线（照 `_test-dream-prescreen.mjs:41-45` 的 `GOLDEN_SHA16` 模式冻结）；A2 文本 `length ≤ 180`（含标签）有断言 |

### 建议项（S-1 ~ S-6）

- **S-1** 把「每 8 轮 R3」降级为新 recall 提醒的兜底档（同一文案模板、两个触发源），彻底消除双提醒与双计数器漂移。
- **S-2** 保留 MiMo 原文的「Don't ask the user about something memory may already record」语义（方案 A2 已意译，建议保留「不要问用户记忆里已记过的事」原句，便于日后对齐）。
- **S-3** B1 的升级阶梯对齐 MiMo 原文顺序：`换稀有词 → Grep/read 直读 → session_search → 放宽范围（session→project→global→history）`（`tool/memory.txt:37-43`），比方案现有措辞更可执行；B2 增量价值低，可只补「last resort」一句，避免描述继续膨胀（H-9）。
- **S-4** 观测补 skip 原因：`monitorEvent("recall","skip reason=no-target|throttle|subagent|flag-off|synthetic")`。4.5.10 CRA 的教训是「做了但没生效」最难查（`docs/audit/T5-fix_AUDIT_2026-11-09.md` §0）；只记 inject 不记 skip，等于放弃可观测性。
- **S-5** 真机验收补一条「升级后首轮 cache miss」的预期说明（工具描述 + R2 文本都变），否则用户会把它误判成回归。
- **S-6** 若采纳 S-1，建议 recall 与 R3 共用一个「本会话已提醒轮次」账本（`p3.sessions[sid]` 已持久化，`6266`），避免两套内存 Map 各自漂移。

---

## 5. 审计动作与局限（诚实记录）

**已读**：方案全文 133 行；`index.js` 相关 30+ 段（160-280、1660-1680、2100-2130、2225-2295、2540-2740、4600-5000、6200-6440、7755-7940、9185-9330、12990-13130、13740-13800、13980-14010、16350-16620、16779-16800、17720-17800、18120-18420、18790-18910、19150-19330、19300-19390、19990-20110、22640-22690、22790-22875）；`p3-readside.js` 全文；`p3-cost.js` 100-160 与 `KIND_LIST/KIND_FIELDS`；`_fixture-ctx.mjs` 全文；`test/_rehydrate-gate-selftest.mjs` 全文；`test/_accept-p4.mjs` 185-395；`test/_accept-p0-lib.mjs` 100-219；`test/_alignment-discipline-selftest.mjs` 全文；`test/_note-remind-selftest.mjs` 全文；`test/_p3-cost-selftest.mjs` 55-101；`_gate-plugin-load.mjs` 相关断言；`_test-search-commands.mjs` 相关断言；`docs/门套件结果.md`（基线 9 红，与方案一致）；MiMo `session/prompt.ts:125-142/3340-3395`、`session/checkpoint.ts:470-500/1155-1164/1173-1181/1205-1330`、`tool/memory.txt`、`tool/history.txt`；真机 `~/.dsh/memory/.config.json`（db 模式）。

**已跑（只读/隔离）**：`test/_alignment-discipline-selftest.mjs`（28/28 绿）；`_gate-plugin-load.mjs index.js`（FAIL 1/PASS 111，红行=旧超限文案，描述断言绿）；`_test-search-commands.mjs index.js`（FAIL 3/PASS 10，红行全在 CLI argv）；`%TEMP%` 探针（md 模式原语 null-safety、pre-step handler 注册序 5 个、A 类 step1 注入 1 条且 `agent.inject`=0、subagent/step5 不注入、reject 不注入、`bumpKind` 未知 kind 静默丢弃）。

**未做/局限**：① 未跑 `_run-suite.mjs`（任务明令禁止）；② 未在真机跑 4.5.15 实现（方案未实现，无对象）；③ 「step===1 每用户消息恰好一次」由 A 类现有行为与宿主契约推定，**未**在真机 seq 上验证「请求失败重试是否会重放 pre-step」——故 K-5 要求实现方补去重键而非依赖「天然一次」；④ 运行版 4.5.14 未完全重启生效，探针全部在隔离 tmp home 中执行，未触碰真库（真库只读了 `.config.json` 与 mem.db 文件大小）；⑤ 未评估 UI 面板是否需要新增展示（client 为 schema 驱动，未发现 flag 枚举，判断为不需要，但未逐行读完 `client/lib/client.js` 51 KB）。
