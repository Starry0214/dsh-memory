# dsh-memory 变更日志与技术参考

> 面向开发者/维护者。普通用户看 [README.md](../README.md) 即可。
> 架构与设计决策另见 [设计文档.md](设计文档.md)。
> （注：v2.4.1~v2.5.4 的逐版变更史记录于记忆库 knowledge/MEMORY-dsh-memory-v2.5.x-合并维护与dream修复.md 及 tools/记忆插件.md，本文件自 v2.5.5 起恢复同步。）

## v4.5.15（2026-11-11）：**记忆检索提醒（每轮）+ 升级协议 + 重建注入 learnings**

> 对齐 MiMo-Code 三处做法：per-turn active recall reminder、memory→history 升级协议、rebuild 注入累积学习。
> 设计：`docs/方案-4.5.15-记忆检索提醒与升级协议.md`（§9/§10，经 CRA 审计①~④）。

### 新增

- **每轮 recall reminder**：`agent/pre-step` 尾部注入 `<system-reminder>【记忆检索】…</system-reminder>`（db/md 两版各 ≤180 字）；触发 = 本会话有检查点（`p3.sessions[sid].checkpointAt`）/ 本会话未提炼笔记（共用 rows+30s TTL）/ 本会话有 todo 记录（P1 per-session）；flag **`recallPerTurn`**（默认 true，四落点+热更新）；同轮只 append 一次（去重键 `sid+(msg.id||p4cMsgKey)`），不写会话历史/inbox、长前缀不变。
- **R3 每 8 轮轻提醒并入同一通道**：`turn/start` 只维护轮次；先 recall，未命中且 `turn-lastNudgeTurn≥8` 则同一 handler 注入 R3 文本，**append 成功后才置位**；删除旧 `agent.inject` 注入点（无双注入）。
- **升级协议写进工具描述**：`memory_search`（命中即信 / 部分命中→`session_search` 取逐字 / 0 命中逐级升级：换稀有词→直读→`session_search`→放宽范围）；`session_search`（仅在 memory_search 无有用结果或需逐字原文时用）；`memory_search` 0 结果文案统一指向 `session_search`。
- **R2 重建注入增强**：新增「累积学习」段（同 wsKey 收窄、排除本会话、≤2 检查点×2 节×2 条×≤100 字、段 ≤900）+ Verify-before-act 提醒；`R2_TOTAL 6100→6900`、砍序 learnings 第一、`dropped` 记 `learnings`；flag **`rebuildLearnings`**（默认 true）。
- **门**：新增 `test/_test-recall-reminder.mjs`、`test/_test-rehydrate-learnings.mjs` 并登记 `TEST_DIR_GATES`；`_accept-p4` 适配 6900/新段头；13 门 FAIL 行集合与基线逐行一致（新增 0）。

### 已知行为（非缺陷）

- R3 兜底仅对「含真实 user 消息的 step1」生效（定时任务/goal 续轮等合成消息会话由 RT 覆盖）。
- 升级后**首轮一次性 cache miss**（工具描述 + R2 文本变更），属预期。
- 成本 kind `recallReminder` 语义改为 **R3+RT 合计**（面板标签同步为「记忆提醒（R3/RT 合计）」）。

## v4.5.14（2026-11-10）：**3D 图谱 vendor 自包含（安装版可用）**

> 修复一个从 3D 图谱上线起就存在的安装缺口：`/dsh-memory/vendor/*` 路由只读 `~/.dsh/memory/vendor/`，
> 而 payload/install.ps1 从不分发这三个第三方库 ⇒ 全新安装的机器上 3D 图谱页签必 404（仅本机因手工放置可用）。

### 变更

- `topicDbVendorHttpHandler`：vendor 文件**优先插件目录 `vendor/`**（payload 随插件分发），回退 `~/.dsh/memory/vendor/`（历史手工放置）；两处都缺 ⇒ 404（面板退化列表视图）。
- `tools/sync-payload.mjs`：打包 `vendor/*.js`（3 个文件：3d-force-graph.min.js / three.module.js / three.core.js）。
- 删除 `vendor/3d-force-graph.min.js.cdn`（重复副本，无引用）。
- `.gitignore` 增加 `_verify/suite-*.txt`（套件运行证据为生成物；汇总见 `docs/门套件结果.md`）。
- `vendor/` 三个文件入库（仓库自包含、可复现 payload）。

## v4.5.13（2026-11-10）：**dream 预筛 + 检查点证据 + 日记忆只读**

> 审计①~④（CRA）驱动：原「note→关联主题」方案被驳回两次后重写为「内存打分预筛」；
> 实现复核又抓出 3 个实质问题（P0-4 空轮短路真库不生效、关联质量不达标、已跟踪门被签名漂移打红）并修复。

### 新增

- **A1 预筛**：`dreamPrescreenNoteLinks` 纯内存打分（词典=主题名+effectiveTriggers、df 上限、同工作区线加权、token ≤48 按权重、命中硬上限 100），每 note ≤3 关联、摘要 ≤80、摘录单句 200×≤2/≤400；任务书新块「Note → 关联主题（线索不是结论）」；`dreamPrescreen` flag（默认 true，可热更新）。
- **A2 检查点证据**：真检查点（名字+父线双条件）≤4、两节各 ≤90 字、缺节降级、总 ≤1,200、只读标注；任务书新块「检查点证据（只读）」。
- **日记忆只读（用户 2026-11-10 追加）**：D8 域/线/日期主题/P2.5 会话主题对 dream 只读——候选池/A1/A2 排除；`applyPatches`（topic+file）、`applyDreamPatchesToDb`、`split 源`、`review merge into`、`rename` 五处护栏统一 `DAILY_MEMORY_READONLY` **整批拒绝**。
- **P0-4 空轮短路**：仅库模式、按本档上限的廉价必要条件（main>9000/detail>40000/index>200000，取档失败保守），复用统一空轮收尾；真库「无活」实测 89ms（改前 ~2.0s）。
- **P0-2**：`overTopics` 源头排除笔记（渲染/空轮/健康记账三处同口径）。

### 修复

- I'-1：`test/_dream-review-tool-selftest.mjs` 适配 `listReviewQueueFromDb(store,maxN,rowsOpt)` 签名（39/39）；review/split/empty-note/prescreen/daily 五门登记进 `TEST_DIR_GATES`。
- I'-3 质量门（命中 ≤100 / top-1 基线）、I'-4 预算耗尽语义（MIN_VIABLE=1100 + `budget=exhausted/droppedBudget`）、I'-6 摘录严格 ≤400、I'-5 新门入库。

### 门

`test/_test-dream-prescreen.mjs` 110/0、`test/_test-daily-readonly.mjs` 35/0、review 39/39、dream-cand 22/22、m9m11 61/0、t5 46/0、p25 47/0/2、accept-p4 98/0；md 任务书逐字不变；flag 关基线重定为 `06b8b17649c29e6a`（因候选池排除 D8，属安全修复、不在 flag 后）。

## v4.5.12（2026-11-10）：**P0-0 修复 —— 会话笔记提炼块恢复**

> 审计②（CRA，2026-11-10）发现的既有 P0：`buildDreamPromptLibrary` 里 `_noteDistilled` 声明在候选
> `try` 块内、笔记块在块外使用 ⇒ 每次抛 `ReferenceError` 被 `catch` 静默吞掉，**「会话笔记提炼」块自
> v4.5.2 起从未进入运行中任务书**（笔记收敛哨兵 `DSH_MEMORY_COMPACT_JSON` 的指令实际从未下发）。

### 变更

- `_noteDistilled` 判据提升到 `buildDreamPromptLibrary` 函数作用域（删除 try 内重复声明）；
- 任务书恢复「会话笔记提炼」块（含七类映射 + 哨兵收敛 JSON 说明）；真库副本实测任务书 4,110 → **5,844 字**（笔记块 ≈1,734）；
- 无其他行为改动；md 模式逐字不变。

### 验证

- 最小夹具：`buildPrompt()` 含「会话笔记提炼」+ `DSH_MEMORY_COMPACT_JSON`；
- 真库副本（审计②）：`prompt_has_note_block=true`，未提炼笔记 12 主题/116 句重新可见。

## v4.5.2（2026-11-06）：**会话笔记收敛（清空 + 指针）** + 未提炼统计

> 4.5.1 之后的核心改造：笔记主题此前 append-only、dream 提炼后只追加一句「已提炼 → T-xxxx」，
> 正文永不删 ⇒ 无限增长（真机最大 67 句），且代码不按 marker 过滤候选 ⇒ 已提炼主题每轮重复进 dream。
> 本版让 dream 提炼完后把主题**收敛成一行指针**，新增内容不受影响。

### 变更：笔记主题收敛

- dream 对「已提炼完」的笔记主题产出 `{topic, pointer, targets}`，由**插件**执行 `noteTopicCompact()`：
  **追加指针行 → 删除收敛前快照内的旧句**（只删 `id <= snapshot.maxId` 且 sha 匹配的），
  快照之后主 agent 新写的句子 **id 更大 ⇒ 必然幸存**
- **三项硬断言**（不满足即留痕）：① 无 live 句满足 `id <= maxId 且 sha 匹配` ② 存在且仅存在 1 条指针行 ③ 快照外句子未被删
- **C2' 校验**（全过才动手）：targets 非空 / 与 pointer 的 T-id 双向一致 / `doneOk` / **每个** target 本轮 `writeCount` 增长且非 archived 且非笔记主题；不通过 ⇒ **不收敛、不写 marker**、留 pending 重试
- **幂等**：主题只剩 1 句且就是指针 ⇒ `skip(already-distilled)` 并清残留 pending（不误删既有指针）
- **pending 重放**：`meta: noteCompact:pending:<topicId>`（先写后动手，TTL 30 分钟，崩溃后重放并**重过 C2' 校验**）
- **指针格式**：`<日期> 已提炼 <N> 句 → <T-id 列表>（原文 session_search sid8=<sid8> 可回溯）`
- 判据统一为 `isNotePointer()`（**双格式**：兼容 legacy「已提炼 → T-xxxx」与新指针行），候选过滤 / 提炼块 / 统计 / 幂等四处复用

### 变更：dream 禁止写/删笔记主题

- `memory_dream_patch` 守卫：**解析后 topic**（`store.resolveTopic`）名以 `笔记·` 开头 ⇒ 拒绝 append/edit/replace/delete，返回 `NOTE_TOPIC_DREAM_FORBIDDEN`
- 同批堵住三条旁路：file→topic 映射、`memory_review_topic` 的 `into`、`memory_split_topic` 的**源**主题
- dream 任务书删除「提炼完追加 marker」的旧要求，改走上面的收敛通道

### 新增：未提炼统计

- 口径：**最后一条指针之后的句子数**（`isNotePointer` 复用）
- 三落点：`stats.json` / 面板 / dream 任务书开头一行 / `memory_topics` 尾部

### 新增：迁移脚本

- `tools/migrate-note-compact.mjs`：只处理「最后一句是 legacy marker」的主题（**部分提炼主题原样不动**）；
  同一事务内删 marker 之前的句 + marker 就地改写为新指针；过滤墓碑句（`meta.deleted.index`）
- 安全：`--dry-run` 对账表（只读）· `assertNoHost`（宿主在跑 exit 2 拒绝，`--force` 跳过）·
  checkpoint 在**可写连接**上执行并校验 `busy=0`（失败分型 `CHECKPOINT_BUSY/IO/FAIL`）· `VACUUM INTO` 备份

### 性能

- `store.topics()` 单轮复用（真机实测 684ms/次）：任务书 4→1 次（≈2s/轮）、spawn 快照 244→132ms、validate 142→0.3ms、stats 138→0.1ms

### 验证

- 自测 `test/_note-compact-selftest.mjs` 81/81（含 K1-K11）；回归 434 项全绿
- 审计：方案三轮 CRA + 实现审计 + 第 4 轮定点复核（D1/D2/D7/D8/D10 全过）
- 真机迁移 dry-run：12 主题 → 待迁 7 / 跳过 5 / 删旧句 11 / 改写 marker 7

## v4.5.1（2026-11-06）：**写入通道收紧（`memory_write` 仅 dream）** + 熔断补漏 + 续期接线

> 4.5 发布后的三条收口：长期库写入只给 dream（主代理唯一写入口 = `memory_note`）、
> 短行重复退化不再漏判、检索命中真正续期（`markHit` 此前 0 调用方）。

### 变更：写入通道收紧（破坏性行为变更）

- `memory_write` 对**主代理 / 普通子代理 / teammate** 关闭：调用返回 `ok:false, code=WRITE_DREAM_ONLY`；
  主代理唯一合法写入口是 `memory_note`（append-only 会话笔记，dream 整合时提炼进长期库）；长期库（主题正文）只由 dream 维护
- 为什么：主代理直写长期库会各写各的（实测 T-0069 涨到 154 句 / 33K 字、T-0436 141 句 / 140K 字），
  dream 事后无法判重；对齐 MiMo-Code「会话级 notes 是唯一合法暂存区」
- 子代理两条通道都关（`memory_write` 拒 + `memory_note` 返回 `SUBAGENT_SKIP`）⇒ 只能把发现写进最终报告，由主会话决定记不记
- 回滚：删掉 `memory_write.execute` 里的 `actor !== "dream"` 判断块即可（其它语义不变）

### 修复：熔断补漏（短行重复退化）

- 既有 `detectTextDegeneration` / `textStreamTailRepeat` 都有 `if (s.length < 6) continue`（为排除「- 是」「| 否 |」这类噪声）
  ⇒ 「做。」×数百行这类 2 字符行被整批丢弃 ⇒ rows 恒空 ⇒ 行数闸永不通过 ⇒ **熔断代码在跑但永不命中**（monitor 无 text-degeneration 事件）
- 新增 `shortLineRepeat()` 短行判定路径：短行 ≥30 行 + 单行重复 ≥25 次 + 该行占短行 ≥85% 才判退化（刻意从严，正常文本不会同时满足）；
  长行路径不再按长行数量短路短行分支（CRA 2026-11-06：真机退化常是「若干长句 + 大量短行」混排）
- 单测：300 行「做。」必命中（改前恒 null）；纯符号短行 / 仅 25 行 / 占比 83% 均不误报

### 修复：续期接线（`markHit` 0 调用方）

- 缺口实证：`markHit` 早在 `memory-store.mjs` 实现，但**全仓 0 调用方** ⇒ `last_hit_at` 573/573 为 NULL
  ⇒ `lifecycle.isRenewed()` 恒 false ⇒ 老化只能按 `stateSince`/`createdAt` 走 ⇒ 90 天后按**创建日期**批量归档（实测 2027-01-27 一天归档 338 条）
- 现接线：检索命中（`memory_search` / 压缩后事实包内部检索）与显式读取（`memory_read`）即续期；同主题 **1 小时节流**（跨重启也认 `lastHitAt`）
- 边界：注入切片（每会话固定 12 条候选）与 `memory_topics` 列表浏览**不算**使用（那是候选集不是使用）；记录命中失败绝不影响检索结果

### 升级（4.5.0 → 4.5.1）

- 重跑安装命令 + 重启 DSH；**无需迁移数据**（主题库原样保留）
- `AGENTS.md`：原始 v4 模板（`45463dd5…`）与 4.5.0 模板（`2de634f5…`）都在安装器白名单里 ⇒ 先备份、自动替换为 4.5.1 版
  （写入通道改为「主代理只写 `memory_note`」）；你改过的保留并提示
- 工具列表：`memory_write` 仍在但仅 dream 可用；主代理调用会收到 `WRITE_DREAM_ONLY` + `nextAction: use-memory_note`

### 验证

- `node --check index.js` 0；新增/更新门：`test/_hit-renew-selftest.mjs`（F1–F3 接线静态断言）、
  `test/_text-degeneration-selftest.mjs`（E12–E18 短行/混排）、`test/_p25-write-guard-selftest.mjs`（B6/B7 主代理 `WRITE_DREAM_ONLY`）
- payload 20 文件（无新增运行时模块）

## v4.5（2026-11-05）：**会话笔记 + 压缩失忆窗口根治** + 漏网归档链删除（-2860 行）

> 这一版回答三个真机问题：
> ① 主 agent 想「先记着、回头再整理」却没有合法暂存区（只有自动检查点）；
> ② 压缩后**模型比记忆重灌先醒**——实测压缩 02:05:51 → 模型 02:06:53(+62s) 继续跑 → 重灌块 02:07:48(+117s) 才注入，前 55 秒在失忆状态下思考；
> ③ 漏网归档链 2860 行 / 5 个入口常年零产出，子代理摘要通道把 12.5 万字堆进单主题 T-0436。
> 对应做法：`memory_note` + 15% 档位提醒、拦截式重灌（pre-step await writer）、整链删除。

### 新增

**`memory_note` 会话笔记（默认动作）**
- append-only 暂存区，落点主题 `笔记·<wsKey>/<sid8>`（独立前缀，不会被 `isSessionTopicName` 误判成 P2.5 会话检查点）；单条 ≤2000 字，同内容重复追加自动跳过（`duplicate:true`）
- 工具描述按「默认动作」写：**必记五类**（用户原话/口径逐字、未解问题、跨项目观察、给未来自己的上下文、精确字面量）+「宁可多记，去重是工具的活」+ 不记任务内普通进展
- 子代理调用 ⇒ `SUBAGENT_SKIP`（对齐 MiMo：子代理用 return format 的 findings 字段回传，由主会话决定记不记；teammate 是独立会话，不受此闸）
- dream 整合时提炼进长期库，提炼后在笔记主题追加「已提炼 → T-xxxx」便于下轮跳过

**15% 档位 note 提醒**
- 判据 `totalTokens ÷ 838860`，每跨 15% 提醒一次（15/30/45/60/75/90%）；单调递增 + 同会话 60s 冷却，压缩后清零重来
- 为什么不用轮次/定时（实测否决）：40 个真实会话中位数 **2.3 轮/时**、压缩间隔 10.86 小时 ⇒「每 30 轮」≈13.2 小时一次（等于没有）；按时间又太贵（每 30 分钟 ≈ 每轮摊 35 token）。上下文占用是「会话进展」的自然度量
- 成本：每压缩周期 6 次 × ~70 字 ≈ 420 token，摊到 10.86h ≈ 39 token/时（可忽略）
- 投递走 `REGRESSION_QUEUE`（下一 pre-step 注入、不进会话历史、不破坏前缀缓存）；**投递成功才消费档位**（见修复 CRA M3）

**压缩后检查点注入四段**
- 预算：checkpoint 2400 + note 1900 + 项目 1150 + 画像 350 = **5800 body** + 300 装配头 = **6100 字上限**（≈4000 token，压缩后一次性注入，之后靠前缀缓存复用）
- 砍序（低→高价值）：画像 → 项目 → 笔记 → 检查点（检查点承载最新意图，最后才动）

**检查点 vs 宿主摘要的优先级标注**
- 实测两者**语义相反**：宿主摘要 Next Step = 修 FATAL→build→装机测试；检查点下一步 = 用户已禁止上机、要回退。不标注 ⇒ 模型可能照摘要继续干
- 检查点段头加约 60 字：「本段是压缩**之后**的状态；与上方压缩摘要冲突时**以本段为准**（尤其「下一步行动」「未决问题」——那是用户最新的意思）」

**截断恢复指针**
- 检查点被注入预算截断时追加约 80 字：`[完整检查点 N 字，此处按注入预算截到 M 字；读全用 memory_read T-xxxx]`；只在真截断时加（对齐 MiMo budgeted-read）

**结论时效索引**
- 主题 `结论时效表·自动索引`：扫全库「作废/已失效/不再成立/被推翻/证伪/改判/更正/订正/旧结论/已过时/废弃/不再适用/老结论/先前判断有误/原判断/误判已纠正/已被取代」标记句，输出「主题 ID + 标记数 + 最近一条」索引（最多 20 主题 / 2500 字）
- 恒 1 句、覆盖式写入，内容没变不写；排除自身产出（防每轮自我复读、越滚越大）；dream 每轮刷新。明细仍用 `memory_search` 现查（T-0463/T-0464 已 39727/39990 字，贴着明细上限 40000，全量汇总必然自爆）
- 修的是迁库后的断链：md 时代 `audit-conflict-2.mjs` 扫全库 md 出 `MEMORY-结论时效表.md`，10-31 迁库后脚本仍扫导出视图 ⇒ 新增标记再也进不了表

**流式文本退化熔断**
- 新钩子 `agent/assistant-stream`：每 chunk 累积 delta 文本、每 600 字符检一次、只扫尾部 3000 字符；**重复 ≥20 次**即 `agent.cancel({kind:'hook'})`（宿主流循环每 chunk 都查 signal ⇒ 下一个 chunk 即中断，是真熔断不是事后止损）
- 动机：消息级熔断要等整条消息落地，单次长输出照样烧完（真机 25634 字一次烧掉，尾部 "Let me call." 重复 1300+ 次；该 step 无任何 tool-call ⇒ 滑窗 D/E/W 三类全部失明，调阈值救不了）
- 与消息级阈值分工：消息级 `TEXT_DEG_CANCEL_REPEAT=50`（重复 20~49 次仍只提醒）；流式 20 次直接 cancel

**知识图谱节点 `kind`**
- `/dsh-memory/graph.json` 每个节点新增 `kind`：`note`（`笔记·` 前缀）/ `checkpoint`（会话检查点主题）/ `topic`（其余）；只增字段，老前端忽略仍能工作；判断整体包 try/catch，异常一律回落 `topic`，图本体照常返回
- 面板按 kind 三色区分（笔记 / 检查点 / 普通主题）

### 变更

**拦截式重灌（压缩后不再有失忆窗口）**
- 原实现：压缩后在 `session/event` 里 `setTimeout(0)` 后台等 writer，宿主压缩完立刻放行会话，两者赛跑必输
- 新做法：压缩时登记 pending promise；下一个 step 的 `agent/pre-step` 在 `next()` **之前** await 它（宿主 `agent/pre-step` 是 await 的 waterfall，异步 handler 会真的让宿主停下等），上限 `POST_COMPACT_WAIT_MS = 120000`（= 实测 writer 75.6s + 44s 余量），signal abort 即退；注入完成或超时降级才放行。拦截失败一律放行，**绝不卡会话**

**dream 职责收窄：笔记提炼为主职责**
- 候选主题：**笔记优先**（最多 10 个笔记主题）+ 其他活跃主题补足到 20（无笔记时就是原来的 20 个，零回归）；P2.5 会话检查点主题不进候选
- 任务书新增「会话笔记提炼」块（笔记主题单列，不只给 id+名字），含**七类映射**：工作风格/硬规则 → 项目主题或 global 硬纪律；跨任务可迁移事实（踩坑/方法论）→ 项目主题或 global 踩坑；Bug + 修复 → 项目主题；设计决策/讨论结论 → 项目主题；精确字面量 → **逐字复制绝不改写**；有长期价值的引文 → 对应主题；不确定是否 durable → **保留原处不要删**
- 提炼完在该笔记主题追加「已提炼 → <目标 topicId>」（`memory_dream_patch` 的 `action:"append"`）

**子代理不写会话笔记**
- 对齐 MiMo：notes 是主 agent 唯一合法暂存区；子代理用 return format 的 findings 字段回传，由 spawning agent 决定。原实现无身份限制 ⇒ 每个子代理各建一个 `笔记·<wsKey>/<子sid8>` 主题：主会话看不到、dream 候选膨胀、内容也无人校正

### 移除

**漏网归档（stale archive）链整体删除（-2860 行）**
- 5 个入口：每小时 tick 的归档调用 / 会话启动维护的 silent 分支 / `/dream` 管线归档阶段 / 自动定期 dream 的归档阶段 / `stale_archive` 工具
- 核心函数 `runStaleArchive` / `runStaleSilentTick` / `startOneBatch` / `joinOneBatch` / settle 链；候选与水位账本 `findStaleSessions` / `shouldReArchive` / `ARCHIVE_WATERMARK` / `STALE_NOTIFIED` / `archiveLastRunAt`；提取/单元链；落库工具 `memory_archive_checkpoint` / `applyArchiveBlocks(+ToDb)`；健康信号、测试钩子与模块导出
- 诚实记录：`.integrate.json` 的历史归档键保留在盘上**不读不删**；统计里的 `archRuns`/`staleCount` 恒 0（面板不再显示控件）

**子代理摘要通道退役**
- `/subagents-archive` 降级为**下线 stub**（保留注册位与 COMPAT 登记，执行体只给说明 + 替代方案：`session_search` 检索原文）
- 理由：原文本来就在会话日志里，`session_search` 覆盖 **585/585** 子代理会话（摘要只覆盖 127/585）；摘要全堆进 T-0436 会无界增长（128 句 / 12.5 万字，pending 407 ⇒ 回填还会再涨约 40 万字）
- T-0436 停止增长，观察 3 天后归档

**面板漏网控件**
- `staleAction` / `staleCount` 删除（后端无分支、恒 0，真死控件）
- `staleSessionDays` 保留但改名「**子代理摘要回溯天数**」（被子代理摘要通道复用，仍生效）

### 修复

- **CRA M1**：note 引导不塞进重灌 head（+109 字会让四段饱和时超出总收口 102 字，而第一刀必砍画像段）⇒ 压缩后单独入队一条 note 提醒，不占重灌预算
- **CRA M2**：压缩后清掉队列里未投递的旧 note 提醒（防注入过期百分比、与重灌形成双提醒）
- **CRA M3**：note 提醒拆「判定(peek) → 投递成功才消费(commit)」两步（原实现入队前就写死档位 ⇒ 会话已结束 / 提醒关闭时静默丢一档，该档从此不再提醒）
- **审计 F5**：四段 body 合计 6100 → **5800**，给装配头留 300（原四段全满 6400 超出 6100 收口 ⇒ 饱和时画像段被整段砍，验收「含四段」不成立）
- **审计 F1**：`memory_note` 取 cwd 改走 `agent.session.header.cwd`（宿主 Agent 只有 `session.header.cwd`，`agent.header`/`agent.cwd` 实测 0 处，原写法恒空 ⇒ 真机必回 `NO_CWD`，笔记通道等于不存在）
- **审计 F7**：dream 候选排除 P2.5 会话检查点主题（原候选池只排索引与笔记 ⇒ 检查点可能被当普通主题改写，破坏「恒 1 句覆盖」约束）

### 升级（4.0.1 → 4.5）

- 重跑安装命令 + 重启 DSH 即可，**无需手动迁移数据**（主题库数据原样保留）
- `AGENTS.md`：仍是原始 v4 模板（sha256 `45463dd54b87c890bd7fd8e11a96a80ebeab96ffb597c77a93d8247d1d662e58`）⇒ 安装器自动替换为新版；用户改过的保留并提示
- 新增 `memory_note` 无需迁移：笔记主题按需自动创建
- `memory_archive_checkpoint` / `stale_archive` 工具消失：`AGENTS.md` 旧文案里的引用会被新模板替换；查子代理会话改用 `session_search`
- 行为变化与逐步验证见 [迁移指南「从 4.0.1 升级到 4.5」](迁移指南.md)

### 验证

- `node --check index.js` 0；新增门 `test/_memory-note-selftest.mjs` / `_note-remind-selftest.mjs` / `_text-degeneration-selftest.mjs` / `_rehydrate-gate-selftest.mjs` 等覆盖新路径（门套件全量结果见发版记录）
- payload 仍为 **20 文件**（无新增运行时模块；`AGENTS.template.md` 内容更新）

## v4.0.1（2026-10-31）：修「新用户没有设置界面」+ 客户端代码回灌

### BUG-6：安装器把 client/** 装到了没人引用的地方（新用户看不到「通用设置 → 记忆」）
- 现象：`install.ps1 -CheckOnly` 在**健康安装**上报 `ERR 17/20 匹配；缺失 3（client/lib/client.js, client/lib/index.js, client/package.json）`
- 根因：payload 的 `client/**` 被原样写进 `<pluginDir>/client/`，但宿主按 `./plugins/dsh-memory-client/lib/index.js` 加载设置界面
  ⇒ 那些文件是**死文件**；全新安装后 `plugins/` 下只有 `memory/`，**没有 `dsh-memory-client/`、patch 也没注册 client**
  ⇒ 新用户装完只有引擎，**设置界面整个缺失**
- 修复：安装器把 `client/**` 落到 `<plugins>/dsh-memory-client/`，并**单独注册** `- id: dsh-memory-client`（幂等）；
  `-CheckOnly` 的完整性校验改为按真实路径比对；`install.sh` 同步镜像
- 验证：PS 自测 81 → **85**（新增 A11–A14：client 已装/已注册/不再写死文件）；sh 自测 33 → **37**（同四项）

### 客户端代码回灌（仓库那份落后约 1.5 个月）
- 现网 `dsh-memory-client/lib/client.js` = 20,216B（10-06），仓库 `client/lib/client.js` 只有 11,139B（09-27）
  ⇒ 以**现网为准**回灌仓库 `client/**`（无个人路径/无敏感信息），payload 随之更新
- payload 20 文件 / **691,381B** / sha256 `dd0f99a0fea82a58c4bf9b4949bc91b23490eff9444c22f5a91628348a11c4a7`
## v4.0.0（2026-10-31）：**主题库为唯一真源（破坏性变更）**

> 为什么是主版本号：三处**行为**变了，老用户升级后能直接感觉到——
> ① 库模式下**读不到** `projects/` `knowledge/` 下的 md（要按主题读）；
> ② `memory_dream_patch` 传裸 md 路径会被**整批拒绝**（要改用 `topic:`）；
> ③ 容量超限判据从"md 文件字节"变成"主题字符"，三档口径（9000/40000/200000）。
> 数据不丢：md 文件原样保留（只是不再被读），主题库内容不变；回退办法见文末。

### 破坏性变更（仅 `memoryTopicDbEnabled=on` 时生效；off 时行为与 v3.5 完全一致）
- **读**：`read` / `grep` / `glob` 命中 `~/.dsh/memory/{projects,knowledge}/**.md` ⇒ 拒绝执行，提示改用 `memory_read` / `memory_search` 按主题读
  - 放行：`global.md` / `index.md`（人工稳定层）、`_export/**`（导出快照）、`sessions/**` 与 `tools/**`（漏网归档链路）
- **写**：`memory_dream_patch` 收到裸导出视图路径（`projects|knowledge|sessions|tools/*.md` 且未给 `topic`）⇒ `EXPORT_VIEW_READONLY`，整批不写；给了 `topic` 则以 topic 为准
- **容量**：主主题 9,000 / 明细主题 40,000 / 索引类 200,000；明细与索引**不再**用"连续 N 轮未处理"催办

### 回退到 v3.5 行为
`~/.dsh/memory/.config.json` 里把 `memoryTopicDbEnabled` 设为 `false` 并重启：md 恢复为可读可写的主路径，
主题库数据仍在（不会删），随时可再开。

### 随包工具
- `memtopic/src/split-oversized.mjs`：超大主题自救（默认 dry-run，`--apply` 才写，内置守恒校验）
- `tools/sync-payload.mjs` / `tools/selftest-installer.ps1`（81 断言）/ `tools/selftest-installer.sh`（33 断言）

### 验证
插件侧 11 门 481 断言 + `test/split-oversized.check.mjs` 23 + `test/plugin.smoke.test.mjs` 全绿；安装器 PS 81/81、sh 33/33；
payload 20 文件 / zip 687,824B / sha256 `214632d981e189959e2cda9b14e35326ff712c41c77b3a6cff49751be6b4fefd`。
## v3.5.7（2026-10-31）：随包发布 `split-oversized.mjs`（超大主题自救工具）

- 新增 `memtopic/src/split-oversized.mjs`：把超大主题按字符上限从尾部切段（默认 dry-run，`--apply` 才写），子主题自动继承源主题父节点、内置守恒校验（句数/字符数前后必须相等）
- 改为**相对导入**（`new URL("./", import.meta.url)`），随 payload 安装后可直接运行，不依赖开发机路径
- payload 19 → **20 文件**（zip 687,828B / sha256 `b319dae149c457b512aba10ff6090a9dcdbcf45a2455093a0ab8c2d76bbf90e1`）
- 设计文档补「主题库容量三档口径」「去 md 化硬闸」两节
## v3.5.6（2026-10-31）：**主题库去 md 化收尾 + 安装器 v4 可分发**

> 这一版把「md → 主题库」迁移真正收干净：md 只剩人工稳定层与导出视图，dream 不再读导出视图；
> 容量治理从"md 文件字节"切到"主题字符"三档口径；安装器补齐老用户升级路径。

### 容量三档口径（`overLimitTopicLimit` / `detailTopicLimit` / `indexTopicLimit`）
- 主主题/注入层 **9,000**（原口径，保留"连续 N 轮未处理"升级）
- 明细主题（`level=detail`）**40,000**：不进注入层、靠 `memory_read` 按需读，超限只提示 splitTopic，不再催轮次
- 索引类（名字含「字面量索引/记忆索引」）**200,000**：§9.12③ 要求逐字保存、天生无限增长，只提示"按季度分片"
- 真机落地：T-0182(158,966)→4 段、T-0324(96,247)→3 段、另 11 个明细主题各切 1 段、索引 T-0263(408,198)→200K×2 分片；**新口径下告警 12 → 0**，句数守恒（+指针句）

### dream 去 md 化
- 任务书只列"超限主题（ID+名字+字符数+建议 splitTopic）"，明写「md 是导出视图，不要读写」
- 库模式不再调用 `reconcileProjectIndex()`（原读 `projects/*.md`）；实测生成任务书期间对导出视图 md 的读取 **0 次**
- **硬闸**：`memory_dream_patch` 收到裸导出视图路径 ⇒ 整批拒绝 `EXPORT_VIEW_READONLY`（绝不半批落盘）；`tools/pre-execute` 拦截 `projects|knowledge` 下 md 的 read/grep/glob（`sessions|tools`、`_export/**`、`global.md/index.md` 放行）

### 修复
- **3.5.1** 斜杠命令全部消失：顶层 `inject` 恢复 `commands`/`skills`（延迟注入在真机不生效）
- **3.5.2** compat 自检整条组装失败：cordis 中未 `inject` 的服务读属性会抛 ⇒ 逐属性 `safeGet` + 结果常驻 `.monitor.json`（`d.compat`）
- **3.5.3** 「日摘要过期归档」候选发现仍在扫 md ⇒ 库模式永远 `no-candidate`：改为库内发现（先库、后 md）
- **3.5.6** 自动路径 `no-candidate` 不再打 warn（正常空轮）

### 安装器 v4
- payload zip（19 文件：`index.js` + `client/**` + `memtopic/src/*.mjs`）逐文件 sha256 校验
- 多 profile 自动发现；junction + 包名注册；新用户开箱（主题库默认开 + AGENTS v4）
- 老用户识别遗留 md ⇒ 写 `.memtopic/migrate-pending.json` ⇒ 下次启动自动迁移（失败保留标记回落 md）
- 无 node 环境用 DSH 桌面版 Electron-as-node（实测含 `node:sqlite`）
- **BUG-5**：按注册表**绝对 `file://` 路径**解析真实插件目录（真机：desktop 的 patch 指向 `profiles/web/plugins/memory`，原实现会假报"关键文件缺失"并把迁移命令指向不存在的路径）
- `tools/sync-payload.mjs`（确定性打包）+ `tools/selftest-installer.ps1`（**81** 条断言）+ `tools/selftest-installer.sh`（**33** 条断言，覆盖全新装/幂等/老用户迁移/宿主运行中安全降级/consumer profile）

### 验收
插件侧 11 门 **481** 条断言全绿（overlimit-tier 16 / dream-nomd 43 / sink 42 / compat 39 / migrate-notice 52 / panel 143 / dream-patch 28 / p6 38 / p5 30 / intent 21 / archive 29）+ 安装器自测 81 + 新用户/老用户迁移 e2e 25。

## v3.4.5（2026-10-22）：**过期日摘要自动瘦身** —— 补「隔天起没人管」的层设计缺口

> 用户：「这些日摘要超限是不是也是 bug？」→「要不看看 mimocode 怎么做的？」→「可以（做进代码）」。

### 先查上游（MiMo-Code）

- `packages/opencode/src/memory/paths.ts` + `fts.sql.ts`：记忆 = `global/projects/sessions` 三 scope 的 md + **FTS5 索引**，用于检索；
- `packages/opencode/src/session/summary.ts`：`summary` 是**文件改动统计**（additions/deletions/files），**不是**每日摘要；
- `packages/opencode/src/session/auto-dream.ts`：dream 间隔 **7 天**（distill 30 天），任务书原文 *"Use the memory files as the
  working index and the raw mimocode trajectory database as the source of truth"*；
- `docs/compose/spec/context-budget-control.md`：预算治理只到**上下文窗口**层，没有"记忆文件字符预算"。
- ⇒ **「每日 sessions/YYYY-MM-DD.md + 1500 上限 + 注入」是自研层，上游没有对应物可抄**；可借的只有一条原则：
  **真源 = 轨迹，记忆文件 = 索引/派生缓存**。据此判定：过期日摘要不该继续占大文件，应瘦成指针。

### 缺口（为什么会长到 68951 字符）

1. 维护只盯「最近摘要」（当天那份），**隔天起不再复查**；
2. 深超限（>约 2308 字符）直接判 `infeasible` **跳过 slim**（刻意防烧 token），一次没压下来就永久放弃；
3. 机械下沉只搬**冷节**（标题匹配归档/补档族），日摘要正文标题不符合 ⇒ 永远跳过。
⇒ 实测全库 13 份超限：10-13 **68951**、10-12 39720、10-21 20631、10-20 16426、10-18 6779、10-17 5323、10-10 2830
（另加 10-14/15/16/19/08/09）。

### 改动

- 模块作用域新增 `listExpiredDailyOverflow()` / `dailyMainLineOf()` / `sinkExpiredDailySummary()`（具名导出供门直测）：
  只挑 `date < today && chars > 1500`；**先写下沉档并回读校验逐字包含原文**，再留 `.bak-sink-<stamp>`，最后把主档改成
  「标题 + 主线一句话 + 指针」（≤600 字符，仍 ≤1500）；任一步失败 ⇒ 主档原样不动。
- 接线：挂在 `runStaleSilentTick`（**每小时必跑**的唯一钩子）最前段，每 tick 最多 1 份，留痕
  `过期日摘要已瘦身：<rel> N→M 字符` + `monitorEvent("maint","daily-sink …")`。

### 验证

- `_test-daily-sink.mjs` **10/0**：只挑过期且超限、当日/合规不动、下沉档逐字含原文、留备份、幂等（第二次 `no-candidate`）、
  主线提取；对旧字节（无导出）必红。
- 现场已用同一策略治完 13 份：`sessions/*.md` 全部 ≤1500（最大 1158），下沉档 13 份 / 426 KB，逐字校验全 PASS。

### 附二：`session_search` 对 `session.v4.jsonl.zstd` **整类不可见**（2026-10-23 事故修复）

> 用户：「为什么都是 0 命中？」—— 4 个关键词（ensureGainmap / applyCreate / 1.65526 / payload0）带 `since:2026-10-23`
> 全部返回「命中 0 处（缓存为空或口径不符（先跑 --build））」。

- **根因**：CLI `session-search.mjs` 的 `LOG_RE = /^session(\.v3)?\.jsonl\.zstd$/` 只认 legacy/v3；DSH 0.2.x 起日志名是
  `session.v4.jsonl.zstd` ⇒ 全库 **1082 个 v4 日志**（≈09-23 之后所有会话，含当日）对 `--build` / 检索**完全不可见**。
- **为什么一直"看起来在跑"**：`--build` 只枚举到 1263 个旧日志（=732 legacy + 531 v3，与账本 `日志 1263 个` 完全吻合），
  这些文件 size 早已不变 ⇒ 每轮「建 0 / 跳过 1256」；缓存日目录永远停在 **2026-09-23**；`--since 今天` 无目录 ⇒
  静默 0，而 0 命中提示里那句「先跑 --build」把人引向一条永远建不出东西的路。
- **修复**：`LOG_RE` 纳入 v4（v4 事件类型与 v3 同构，`KEEP_KINDS` 无需改）。重修后 `--build`：**日志 2345 / sid 2280 ⇒
  建 1082，跳过 1198，错 0，83.7s**；`2026-10-23` 日目录出现 33 个会话；四个关键词立即分别命中
  9 / 4 / 11 / 43 处。CLI 属独立子进程 ⇒ **立即生效、无需重启**。
- **防复发门**：`_gate-freeze-sync.mjs` 新增 **GR24** —— CLI 的 `LOG_RE` 必须覆盖 index.js `SESSION_LOG_CANDIDATES`
  的**每一个**文件名（用真实文件名逐个 `re.test`，不看源码写法）。已做鉴别：把 LOG_RE 改回旧值 ⇒ 门红
  「未覆盖：session.v4.jsonl.zstd ⇒ 这类日志对 session_search 整类不可见」。门现为 **17/0 全绿**。


## v3.4.4（2026-10-22）：容量账本**反向清理** —— 修「文件回到限内了，`overLimitStuck`/`overLimitHint` 还挂着」

> 用户拿 dream 结算日志来问「这个是不是有点问题？」：19:59 那轮报 `projects/湖南省发改委…` 13477、`EpointMsg插件.md` 9068
> **仍超限**，而人工下沉后实测已是 5113 / 6828。日志本身是治理前的（时间戳 19:59），但账本确实没跟着更新 —— 查下去是真 bug。

### 真 bug（不是日志时序问题）

- `if (overList.length) { … }` 把整段账本更新包住了，而 `overList` 只装**当前仍超限**的文件 ⇒
  一个文件一旦回到限内（dream 写小 / 人工下沉 / 删除），它既不进 overList、历史键也**永远不会被清**：
  - `overLimitStuck[rel]` 残留 `rounds`/`lastChars`/`lastAction`（现场：发改委 `rounds=12`、EpointMsg `rounds=2`、
    徕卡 `lastChars=14551`，而三档实测 5113 / 6828 / 8612）；
  - `overLimitHint[rel]` 残留旧差数与分节表 —— 它的 `cleared` 墓碑只在「在 overList 里且本轮已写」时才会写，
    已合规文件**永远拿不到墓碑** ⇒ 容量行与 dream prompt 继续显示不存在的超限。
- **次生伤害（更隐蔽）**：`rounds` 是跨事件累积的。残留 12 的文件将来再超限时，第一轮就变 13 ⇒ 直接越过
  「连续 2 轮」滞回、立刻机械下沉（把历史轮数当新轮数用）。

### 修法

把外层改成**无条件块**，在更新循环后做反向清理：不在 `overList` 里的历史键 ⇒ `stuck` 删除、
`hint` 走 `applyOverLimitHintEntry(hintObj, rel, null)` 写**墓碑**（不用 `delete`，否则会被磁盘并账复活）；
仅在有变化（`overList.length || _swept`）时落盘，并打一行 `容量账本清理：清掉 N 条已不符实况的 overLimit 记录`
+ `monitorEvent("sink","ledger-sweep N")` 留痕。

### 验证

- `node --check` PASS；`_test-sink-overlimit` **27/0**（新增 2 条源码锚点，旧写法必须红）。
- 现场账本已手工校正为实况（rounds 归 0 / hint 墓碑），下次 dream 的容量行不会再点这两个文件。

## v3.4.3（2026-10-22）：`session_search` 关键词**默认按字面量**匹配（元字符转义），`--re` 保留正则

> 用户「按你的最优理解改」——v3.4.2 修了大小写后，同族隐患是：关键词仍被当 **正则** 送进 rg。

### 改动

- **CLI `session-search.mjs`**：`escRe()` + `kwPat()`；`PAT = kind ? '"k":"<esc kind>".*<kwPat>' : kwPat`。
  默认转义 `. * + ? ^ $ { } ( ) | [ ] \`；`--re`（或 `--regex`）退回正则语义。`--kind` 前缀各自转义后拼 `.*`，语义不变。
- **插件 `session_search`**：新增可选 `regex:true`（→ 传 `--re`）；描述与 0 命中引导语各加一行说明；
  多词回退的每个 token 同步带 `--re`/`--cs`，保证口径一致。

### 实测

| 命令 | 改前 | 改后 |
|---|---|---|
| `"("` | rg regex parse error → exit 4（白跑） | **命中 67792 处，exit 0**（按字面量） |
| `"("  --re` | — | 仍 exit 4 + `rg: regex parse error … unclosed group`（正则语义保留） |
| `"d.m"` | 命中 `dim`/`d-m`/`d.m` 全体 | 只命中字面量 `d.m`（2967 处） |

回归：`_test-search-commands` 13/0、`_test-session-search-tool` 23/0。CLI 属独立子进程 ⇒ **立即生效，不需重启**；
插件侧参数需重启。

### 附：门与测试的既有债清理（同日·用户要求「做完我来发起 dream」前清干净）

- 加载门 `_gate-plugin-load.mjs` 两条**恒红**断言按现况校正（去陈旧，不是放宽）：
  - 「候选表 v3 在前」钉的是 v3 时代二元素表；DSH 0.2.x 起写 `session.v4.jsonl.zstd`，代码已扩成三元素
    （v4→v3→legacy）⇒ 改成**顺序断言**（优先级 = 新→旧、时间序 = 旧→新、两者必须互逆）。
  - 「T2 生效配置行」钉死 `normalizeCfg(HOST_SETTINGS_SCOPE.get())`；0.1.7 起 API 换成 `normalizeCfg(mergeCfgLayers(config))`
    ⇒ 改为「任一 `PLUGIN_CFG = normalizeCfg(` 初始化点后 1200 字符窗口内出现 `clog(cfgEffectiveLine())`」（赋值点共 3 处）。
- `_test-sessionlog-path.mjs` A1/A2b 同步改顺序断言（v4 感知）；`_test-raw-decode.mjs` P0-4 原判据全文禁止
  `slice(-300)`，把 monitor 环形缓冲（`gateEvents` 截 300 条）误判成「归档账本上限残留」⇒ 只对
  `archivedSessions/archiveWatermarks/staleNotified` 查残留。
- `_test-subagent-digest.mjs` 的「真机抽样恒红 0/3」也是**测试自身的 bug**：`if (cands.length >= 60) break;`
  写在两个循环内部、而 readdir 不按时间序 ⇒ 只在**第一个 workspace**凑够 60 个老会话就收工，永远扫不到全库最新
  那几个（本次实测：3f4ccded/45189195/b4bbb21a 三个都有内容，测试却报 0/3）。改为全库收集后按 mtime 取前 3 ⇒ 3/3。
- 清理后：加载门 **137 / 0 全绿**；`_test-sessionlog-path` 24/0、`_test-raw-decode` 31/0、
  `_test-subagent-digest` 21/0、`_test-deadprobe` 18/0、`_test-search-commands` 13/0、`_test-session-search-tool` 23/0。
- 记忆库 `sessions/2026-10-22.md` 超预算（10483 字符 / 限 1500，维护反复 `stuck=infeasible`）→ 压到 **1076 字符**，
  细节下沉 `knowledge/MEMORY-dsh-memory-blocked与检索口径20261022.md`。


## v3.4.2（2026-10-22）：**blocked 的真因是「父会话已归档」** —— 择父改为最近活跃且未归档

> 用户看了设置截图（「允许 Agent 为子智能体选择模型」= 关）后质疑：「关闭状态应该是默认继承吧？dream 应该用
> 手动发起的那个会话、或最新的会话，API 必然有效」。**质疑成立** —— v3.4.1 里「子代理模型白名单」的归因是错的。

### 真因（宿主源码实证）

- `dsh-api-session-controller/lib/types/archived-session-gate.js`：
  「an archived Session, **or a subagent descendant of one**, must not run a model step until it is restored …
   a late waking delivery … proposes a step the gate rejects, **which the loop ends as `blocked` without a request**」。
- `agent-loop` 的 `turn()`：`preStep` 返回 `{kind:"reject"}` ⇒ `turnEnds={kind:"blocked"}`，**不进 LLM**。
- 现场：`session-ba9e8416-dd22-44da-a795-3fe95718c0c5`（agent周事项）就在
  `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 里；而 dream 的择父写的是
  `agentsBySession.values().next().value` = **最早注册**的那个会话 —— 恰好是它 ⇒ 每轮必 blocked。
- 反证：白名单不构成约束（`a99b9b92` 的 policy 是 opencode-go-v41，而它子代理跑的是 commandcode，全部 completed）。

### 改动

1. **`pickSpawnParent` 重写**：跳过一切已归档会话（`readArchivedSessionIds()` 读 workspace.json，30s 缓存、
   非法 JSON 降级空集、`session-` 前缀与裸 UUID 等价）；顺序 = 调用方 preferred（手动 /dream 的发起会话）→
   同会话 live → 最近活跃未归档 → 任一未归档 live；**全无则返回 null**（不再挑一个注定被拒的父）。
2. **记录活跃时间**：`touchAgent()` 在 `agent/created` 与每次记忆注入时打点，择父按「最近活跃」排序。
3. **dream 择父换血**：`agentForParent || agentsBySession.values().next().value` → `pickSpawnParent(agentForParent, null)`；
   重试路径同步。日志新增 `择父：跳过已归档会话 …（宿主的归档闸会拒掉它的子代理，必 blocked）`。
4. **秒死日志就地归因**：`raceSubagentDead` 的失败文案改为「头号原因 = 父会话已被归档（去侧栏取消归档）」，
   白名单降为次要排查项。
5. **`session_search` / CLI 英文大小写不敏感**（用户当场提问「session 工具能不能适应英文大小写？」）：
   实测旧行为 `Dream`=749 处、`dream`=6452 处（rg 无 `-i`，且关键词被当正则用）。
   - CLI `session-search.mjs`：`RGCOMMON` 默认加 `-i`；新增 `--cs` 退回逐字区分大小写（计数与列举共用同一
     RGCOMMON ⇒ `total` 与 `rows` 口径不会分叉）。改后实测 `Dream`=`dream`=6756 处，`--cs` 仍 749 处。
   - 插件 `session_search`：新增可选 `case_sensitive`（默认 false → 传 `--cs` 时 true）；片段高亮与多词回退的
     命中判据同步按同一口径折叠大小写（否则"命中却截不到关键词"）；0 命中引导语加一行说明"大小写默认已不敏感"。
   - **CLI 属独立子进程实现 ⇒ 该项改动立即生效、不需重启**；插件侧参数与文案需重启。

### 验证

- `node --check` PASS；`_gate-plugin-load.mjs` 134 PASS / 3 FAIL（与改前基线**完全相同的既有债**：候选表顺序、
  全角引号 6 处、T2 接线）。
- `_test-deadprobe.mjs` 扩到 **18 项全绿**：新增 E1 真机归档清单可解析（>50 条）、E2 **现场父会话 ba9e8416 确在
  归档清单里**（把真因钉成断言）、E3 深层嵌套可找到、E4 前缀等价、E5 坏 JSON 不抛。

### 用户可立刻做的（任一即可恢复）

把 `agent周事项` 那个会话在侧栏**取消归档**（最直接）；或重启后用本版（会自动避开归档会话挑父）。

## v3.4.1（2026-10-22）：**零工作子代理收尸** —— 修「秒死 blocked ⇒ 互斥永久挂死 ⇒ 归档/整合全停」

> 起因：用户看日志连问「为什么硬停了？还停了这么多次？是真的还是 bug？」
> 结论：**硬停是真故障的收尸，不是看护误杀；但"死了没人收尸把整条管线锁死"是真 bug。**

### 现场取证（两次解压 + projcache 对账）

- 三个 dream 子会话 `2e0a9df1`(11:17:59) / `18d39e4a`(13:17:57) / `bb668645`(15:17:57)：各 11 帧、~15KB，
  `turn/end {"kind":"blocked"}` 分别在 +115ms / +296ms / **+45ms**，`tokenUsage` 四项全 0 —— 一次模型请求都没发。
  projcache `subagentTiming={descriptorSeen:true, settledMs:45, lastTurnCompleted:false}`。
- 根因在该父会话（`session-ba9e8416`）的 per-session 白名单：`subagentModelSelectionPolicy=[{provider:"opencode-go",
  model:"muse-spark-1.3-contributor"}]`，而当前 desktop profile 的 `opencode-go` 只定义 `deepseek-v4.1-flash`
  （muse-spark 只写在 `profiles/web/cordis.patch.yml`），子代理实际创建路由 `deepseek-192/deepseek-flash` 也不在白名单
  ⇒ 宿主在选模型阶段直接 blocked。
- 对照组：`4e924cbb`（白名单 deepseek-192+commandcode）、`a99b9b92`（opencode-go-v41/deepseek-v4.1-flash）同时段
  子代理**全部 completed** ⇒ 排除插件/看护/网络/配额。
- 最早坏点 = **2026-10-21 19:35:30**（同一父会话的 `漏网归档-3会话-批1` + `压缩-intent` 也 blocked）。因 result 永不落定：
  `STALE_RUNNING` 自那一刻起再没复位（`archiveLastRunAt` 停在 19:35:30）；`DREAM_TRACK` 14:32:44 那条也清不掉。
  于是每小时触发一次 → 起一个 45ms 就死的会话 → 25 分钟后看护 abort，写下 11:45/13:45/15:45 三条「硬停」。

### 改动

1. **判定器（模块作用域，门可 import 真实现）**：`subagentDeadEvidence(sessionDir)` + `findSpawnedSessionDirById(runId)`。
   判据零误杀：日志里必须已有 `turn/end`，且该轮 (a) `kind==="blocked"`，或 (b) `kind!=="completed"` 且 usage 全 0 且无
   assistant 文本。健康三态（仍在跑=只见 turn/start、正常完成=completed、有产出=token>0）都不会命中；>1.5MB 日志直接跳过。
2. **探针 + 竞速包装**：`armDeadProbe`（发起后 8s 起探、每 5s、连续 2 次命中才判死、最多 2 分钟）与
   `raceSubagentDead(runId, run.result, tag)` —— result 落定则原样透传；宿主已结算但零工作则以失败 **reject**，
   让既有 catch/finally 去做清锁。接入三处 await：dream settle（`DREAM_TRACK`）、归档批 `joinOneBatch`
   （`STALE_RUNNING`）、`compactOnce`（maint/intent/slim 压缩轮）。
3. **`STALE_RUNNING` 残留兜底**：加 `STALE_RUNNING_SINCE` + `staleRunningActive()`，挂满 40 分钟
   （> `ARCHIVE_HARD_MS` 25 分 + 结算余量）自动放行并记 `monitorEvent("archive","stale-proc-release")`；
   两处判断（`runStaleArchive` / `runStaleSilentTick`）与三处复位点同步改造。

### 验证

- `node --check` PASS；`_gate-plugin-load.mjs` 全绿（同步前运行处旧字节须 FAIL，鉴别成立）。
- 新增 `_test-deadprobe.mjs`：真实 blocked 子会话（`bb668645`）判死、真实完成子会话判活、
  以及合成夹具 4 类（仅 turn/start / completed+0 token / error+0 token / 有 token 的 error）双向断言；对旧字节 import 必红。

### 未改（交给用户）

该会话的子代理模型白名单仍指向已不存在的模型 —— 那是**配置**问题，请在设置页改成本 profile 存在的路由
（`commandcode/deepseek/DeepSeek-V4.1-Flash` 或 `deepseek-192/deepseek-flash`）；本版只保证"再秒死也不会把管线锁死"。

## v3.4.0（2026-10-20）：**子代理会话纳入归档**（机械摘要，零 LLM）+ 命令 `/subagents-archive`

> 起因：用户「最近 session 归档效果如何？我想把子代理对话也纳入归档」。
> 体检结论：顶层会话已收敛（463 个里 457 个已归档 = **98.7%**），但**子代理会话整类没进归档**
> —— 子代理落盘为**裸 GUID 目录**（`~/.dsh/sessions/<工作目录>/<guid>/`），而 `findStaleSessions` 只认 `session-` 前缀。
> 实测规模：**1699 个 / 605.6 MB**，近 7 天日均新增 35.7 个。

### 为什么走"机械摘要"而不是 LLM 摘要

- 单个子代理可达 **2262 帧 / 2456 万字**（几乎全是工具往返），逐条 LLM 总结既贵，又会把中间失败路径写进记忆库（ghost 轮教训）。
- 实测 30/30 复现更省的形态：首条 `user/message` 稳定落在**第 3~4 帧**（前 12 帧内必能找到，平均 207 字）；
  尾帧 `assistant/message` 有最终答复的 75/80（平均 725~1153 字）⇒ **只解约 5 帧**就能拿到「任务 + 结论」，**零 LLM token**。

### 实现

- 新增 `subagentDigestOf(dir)`：头 12 帧找 `subagent/descriptor.label` + 首条 `user/message`；尾 5 帧倒序找最后一条 `assistant/message` 与 `turn/end.reason.kind`。
- 新增 `runSubagentDigestBatch(limit, {maxAgeDays, dry, root})`：扫描裸 GUID 目录 → 过滤（见下）→ 按天聚合写
  `knowledge/MEMORY-子代理对话-YYYY-MM-DD.md`（追写）→ 记 `ARCHIVED_SESSIONS`（`session-<guid>`，与顶层同一账本，天然去重）；
  **不写 `archiveWatermarks`**（水位是帧增量语义，子代理是一次性任务，无增量可续）。
- **门槛**：尾帧结论 ≥200 字 **或** 原始日志 ≥60KB（两条 OR 分支，实测覆盖"结论长的"与"工具多但话少"的两类）。
- **排除**：`descriptor.label` 以 `dsh-memory-` 开头的插件自身子代理（意图检查点/合并维护/漏网归档/dream）——产物已进 sessions/knowledge。
- **通道**：① 每小时 tick 自动跑一批（16 个，1 小时节流，失败不影响顶层归档）；② 命令 `/subagents-archive`：
  默认 1 批 / `backfill` 存量全量回填（后台分批、让出事件循环、单飞防重入）/ `dry` 只统计 / `off`·`on` 开关（记 `.integrate.json subagentArchive`）。
- **规模控制**：按天聚合（1699 个会话 ≈ 30 个日文件 ≈ 每文件 ~30KB），不炸出 1699 个文件稀释 `memory_search` 排序。

### 门

`_test-subagent-digest.mjs`（**21 项全绿**）：临时 DSH_HOME 里造**真 zstd 多帧**合成会话，验 抽取（任务/结论/状态/label/帧数）→ 排除（插件自身、过薄、太新）→ 两条门槛 OR 分支 → 落盘（front-matter + 条目正文）→ 幂等（二跑 added=0）；末尾对真实环境 3 个真实子代理做只读抽取（3/3）。

## v3.3.1（2026-10-20）：命令提示补上「多词条」能力（hint / description / 用法回显）

> 用户实测反馈：「两个工具**但是多词条搜索的，似乎没有在提示内容中**」——多词条本来就支持（`memory_search` 是 OR 分词；`session_search` 是整串精确、0 命中后自动分词回退），
> 但 `input.hint` 只写了单关键词，用户在输入框里看不出可以空格拆词。

- `/memory-search`：`input.hint` → 「关键词，可多词条（空格分隔，如 水位信任闸 机械闸）｜或文件名」；`description` 标注 **支持多词条（OR 分词 + 相关度排序）**；用法回显新增「多词条：空格分隔即按 OR 分词…任一单词命中即入选，写 2~4 个最具体的词最好」。
- `/session-search`：`input.hint` → 「字面量或多词条 [--limit N] [--since 日期] [--sid 前缀] [--source …] …」（原 hint 过长会被 UI 截断，收敛为「多词条 + 三个常用选项 + 省略号」）；`description` 标注 **先整串精确、0 命中自动分词回退**；用法回显补多词条语义与示例。
- **检索语义未变**：仍只读；`parseCmdArgs` 把非 `--` 开头的 token 用空格拼回 `query`，正好喂给工具侧原有的多词条路径，没有新增分支。
- 生效仍需重启（host 插件无热加载）：就绪行构建指纹会从 `1041506B/19E6F80B` 变为新字节，可据此确认加载了哪一份。

## v3.3.0（2026-10-19）：两个检索工具开放为**用户命令** `/memory-search`、`/session-search`

> 起因：用户「将两个工具开发到命令中给用户也能调用」——`memory_search` / `session_search` 此前只有模型侧能调，用户在输入框里按不到。

### 做法：复用同一实现，命令层只做参数解析与裁剪

- 把两个工具的注册对象提为具名常量（`sessionSearchToolDef` / `memorySearchToolDef`）并 `toolSvc.register(...)`，
  同时把 `execute` 挂到作用域变量 `SESSION_SEARCH_EXEC` / `MEMORY_SEARCH_EXEC` ⇒ 命令与工具**共用一份检索逻辑**，
  不复制 OR 分词、相关度排序、索引 CLI 参数映射、0 命中升级路径等语义（避免两份实现漂移）。
- 新增 `ctx.commands.register`：
  - `/memory-search <关键词或文件名>` —— 只读；query 等于文件名时返回该文件全文（截 4000 字）。
  - `/session-search <精确字面量> [--limit N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--sid 前缀] [--source logs|units|all] [--status] [--build]` —— 只读。
- 参数契约（宿主 `dsh-commands`）：handler 收到 `{commandId, agent, rawInput, attachments, signal}`，`rawInput` = 命令名之后的原始尾巴；
  命令侧 `parseCmdArgs()` 支持 `--k v` 与 `--k=v` 两种写法、无值开关（如 `--status`）；输出统一 `clipCmdText(…, 8000)` 防刷屏（截断时注明原长度并提示改用工具）。
- 就绪行的「已挂载」清单补上两个命令名。

### 纪律

- 命令**只读**：两个检索命令不写记忆库；`/session-search --build` 只重建检索索引（慢，约 6 分钟），不改记忆内容。
- 未就绪保护：工具注册失败时命令返回明确错误（指向启动日志里的注册失败行），不静默降级为用法回显。

## v3.2.0（2026-10-19，本次发布）：**宿主 0.2.1 子代理 API 断裂兼容** + dream 失败原因可见

> 本次推送同时**收编 v2.5.5 → v3.1.0 全部未提交迭代**（索引自动刷新 v3.1.0、归档/解码链批0、容量治理 spillover、水位信任闸等），
> 逐版细节见下文各节；本节点只记 2026-10-18/19 新增的两处。

### 一、宿主升级即断链：`subagents.start` 被移除（静默假阴性）

- **现象**：桌面端 2026-10-17 17:20:50 升到 `dsh 0.2.1-rc.2` 后，**意图检查点 / 合并维护 / 漏网归档 / `/dream` 整合四条链路全部静默停摆**——不报错，只打「subagents 不可用，跳过」。
- **根因**：`@deepseek-ai/dsh-subagent` 的服务方法表变成 `startActivation / waitForChildren / sendMessage / interrupt / drainDescendants / …`，**`start()` 被删除**；插件四处守卫写的是 `typeof subagents.start !== "function"` ⇒ 服务明明在（`ctx.get` 拿得到、agent-team 的 `static inject` 还拉着它），却被判"不可用"。
  对账：`.integrate.json` `lastSuccessAt=2026-10-17 15:55:28`、`archiveLastFailAt=2026-10-17 23:12:45`，正好夹着 app.asar 安装时间。
- **修复**：双协议守卫 `subagentsHasStart()` + 就地适配层 `startSubagentCompat()`：旧宿主原样走 `s.start("spawn", opts)`；新宿主走 `startActivation({provider:"spawn", label, request, signal, delivery:"caller"})`，再把 `{childId,result,dispose}` 映射回调用方假设的 `{id,result,dispose}`（三处 spawn 点语义不分叉）。
- **验证**：`node --check` + 适配层烟测（旧路径透传 ✓ / 新路径 `childId→id`、`result`、`dispose` 全通 ✓）；重启后活体 `stale_archive` 五段全通（spawn / 子会话 / 工具 / result / 结算）。
- 生效副本指纹：`1029490B/A50EA2B8` → `1032482B/F7622A9B`。
- **教训（写进纪律）**：宿主大版本升级后，凡「`typeof svc.method === "function"`」式守卫都要重验——**方法没了不会抛错，只会静默跳过**，比崩溃更难发现；探测式守卫应同时打印服务可用方法名。

### 二、子代理"死于什么"要一眼看见（`readSubagentFailure`）

- **背景**：宿主 `SubagentResult` 只有 `{output, stopReason, structured}`，**不带失败原因**（0.2.1 `dsh-subagent/lib/index.js` 的 `captureLocalResult` 实证），`stopReason` 只会是 `error`/`aborted` 这类枚举。
  现场（2026-10-18 12:00）：`/dream` 连发两次都是 `stopReason=error, 输出 0 字符, usage 0`，人只能误判成"写守卫拒了 / 文件超限"，真因是 **`429 GoUsageLimitError`（模型套餐额度用尽）**——得手工解子会话 zstd 帧才看得出来。
- **修复**：新增只读 `readSubagentFailure(sessionDir)`，从子会话日志尾部捞最后一次 `turn/end.reason.error{message,code}` 并打进结算行：
  `自动整合完成（手动，stopReason=error, 输出 0 字符，失败原因=429: {"type":"GoUsageLimitError",…}（code=QUOTA）)`
  命中 `QUOTA|429|usage limit|额度|余额` 时额外 `cwarn` 一条"这是模型额度、不是记忆库或插件故障"。

## v2.7.0（2026-09-17，未发布）：**拆除 fixed 耐久层** + 归档/解码链四条活缺陷修复（批0）

> 起因：用户问「**耐久层的意义是什么**」→ 六席三轮评审后结论是**该层不再成立**，用户拍板「拆」。
> 评估与证据见 [评估-会话原文检索三档.md](评估-会话原文检索三档.md)（含 §5 阻断项）。

### 一、批0：归档/解码链四条**当天就在生效**的静默缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | **提取失败 = 永久跳过**：`batchFrames` 先记账后提取，失败会话仍进 `handledIds` → settle 写 `ARCHIVED_SESSIONS` + 水位 ⇒ 其帧**永不再被提取** | skipped 只做已提醒去重（不消号、不写水位，宁重试不静默丢）+ `cwarn` / `monitorEvent("archive","extract-anomaly …")` 可观测 |
| 2 | **账本上限 300**：`saveStaleNotified` 与 `writeIntegrateState` **两处各自硬编码**；盘上实测 280/300 即将顶格 ⇒ 最旧 id 静默丢失 | 单源 `LEDGER_CAP = 5000`（两处同源）+ 裁剪留痕 |
| 3 | **缓存无身份校验 + 失败当成功**：只校验 `typeof text === "string"`，`else if (cached)` 把旧缓存当本轮成功单元 | 校验 sid/frames/**缓存帧数 > 现文件帧数即判陈旧**；回退显式标 `staleFallback` 并透传报告 |
| 4 | **双解码器容错相反**：`decompressSessionLog` catch 在 while 外 ⇒ 单帧坏 = 整文件 null；`Buffer.concat` 在循环内 = O(n²) | 新增模块级**单源** `scanZstdFrames`/`decompressFrameAt`/`decodeSessionLog`（具名导出）+ 逐帧容错 + 数组收集；两处解码器收敛 |
| — | **解码陷阱（实测 7/7）**：整文件交 `zstdDecompressSync` **只解首帧**（5 KB 与 28.6 MB 同样只返 224–379 B，且不抛错） | 真机验证：85,922 帧逐帧 = **54 MB** vs 朴素解码 **327 B**（17 万倍）；新工具必须复用逐帧读法 |

- `sampled` 原被 `source === "messageflow"` 覆盖（无损路径也标"采样视图"）→ 取提取端真实值；预算截断由**静默中断**改为产物内留痕。
- 门：`_test-raw-decode.mjs`（21 项，鉴别 14/14；旧字节鉴别 0/11）+ `_check-batch0-live.mjs`（活体自检含真机日志对比）。

### 二、拆除 fixed 耐久层（v2.6.8/v2.6.9 引入）

- **依据**：①保护自身有洞（任意 patch 带 `full_rewrite` 即解锁 delete 与净删闸）；②下沉实测**留指针且目标在位**（global 2 / index 1 / projects 60 / tools 6）；③全库召回实测**编号类 100%（295/295）** ⇒ "防丢"收益不成立。
- **范围**：`ROOT_FILES`/`CHAR_LIMIT`/`budgetOf` 分支；写保护块；溢出分流 fixed 支与命名表；注入链（`fixedRaw`/`fixedMd`/【固定要点】/`hF`/`mF`/快照 `f`/通知文案）；`/dream` 体检行；health 删减留痕；面板三处；检索候选 `put`；任务书两行；三处工具描述与 file schema；**两个 fixed 专用 `pre-execute` 处理器**（3 → 1）。
- **副作用**：①**调用方闸是「反转」而非删除**（见下），前缀缓存失效一次（AGENTS 四副本 + 3 个工具描述）。
- **门**：`_test-fixed-removed.mjs`（**45 项**；对 v2.6.9 字节 → **20 鉴别项全红**）；`_test-v268.mjs` / `_check-v268-live.mjs` 退役为 `.retired`；原门中与 fixed 无关的覆盖（archive 可检索 / 轮转 sha 校验 / 未沉淀与水位契约 / 阈值回落）**按名搬入新门**；原 D 组 **D1–D3（archive 端到端检索）已于 2026-09-18 搬运至新门文末 D 组并通过**。
- **文档**：AGENTS 活体/模板/`install.ps1`/`设计文档.md` 各 10 处 → 0（`install.sh` 本无）。
- 生效副本 sha16 链：`801A2E72FA330D45` → 批0 `4666265EB9D0B9C4` → **`028361D681DC03C5`**（705,399 B）。

### 三、教训

- **"改一处漏一处"是本仓高频失效形态**：`slice(-300)` 我只改了保存路径、漏了写盘合并路径三处，靠新门报红才发现。
- **拆除说明注释里逐字引用被删代码** → 源码断言必须先在"去整行注释"的文本上匹配，否则假失败（本门首跑踩中 3 条）。
- 门必须**双向跑**：对旧字节断言"鉴别项全红"才算仪式成立。

## v2.6.9（2026-09-17，未发布）：耐久层写入指引补全 + v2.6.8 已上线缺陷修复 + 死锁通道

> 起因：用户追问「**有提示词吗？往 fixed.md 写的**」→ 自查发现 v2.6.8 **只交付了代码能力、没交付"让人去用它的提示词"**。方案 + 三席对抗审核见 [方案-v2.6.9-耐久层写入指引与提示词补全.md](方案-v2.6.9-耐久层写入指引与提示词补全.md)。

- **【P0·v2.6.8 已上线缺陷，红队发现/组长复现】`ROOT_FILES` 收敛漏了一处**：`L7221` 仍是 `for (const rel of ["index.md", "global.md"])`（**`rel` + 倒序**两元素数组；v2.6.8 的批量替换只覆盖了 `for (const df of […])` 形态）→ 它是 **W2「近限按变化报」的水位账本**循环 ⇒ **`fixed.md` 近限告警永不触发**，一路写到被整批拒写才发现（＝把告警拆了、只留拒写）。处置：`L7221` 与 `L1574`（`scanUndeposited` 的内联三元组）改用 `ROOT_FILES`；`L8969`（纯删未下沉检查）**刻意保留**二元素。**门断言改为"根文件内联数组字面量计数 ===2（定义 + 刻意项，不计注释）"**——v2.6.8 我写的"默认值走 ROOT_FILES"照不出这个漏（鉴别基线上该断言报"命中 4"并逐条列出，含被漏的 `["index.md","global.md"]`）。
- **【P1·死锁，红队/工程席】修文案若不给通道 = 满额时插件内无合规路径**：`L4486` 只放行"带 `knowledge/` 指针的净删"、delete 一律拒，而 v2.6.8 的直写闸又堵死原生 `write/edit`（含用户指令下的主代理）⇒ **fixed.md 满且需整条移除时，用户主权只剩 bash 直写**。处置：`fixed.md` 守卫加 **显式声明通道** —— 本批任一 patch 带 `full_rewrite:true` 则放行（复用既有 opt-in 语义）＝默认禁 + 声明可放 + health 留痕可见。
- **【P2·文案自相矛盾，三席一致】** 三处报错文案**在教模型把耐久条目搬走**，其中 `L4512` 已被实测坐实（鉴别基线上逐字可见：`patches fixed.md 写入后仍 1213 字符，超预算 1200（当前超 13）——按差数做整节下沉：…整节提取到 knowledge/MEMORY-fixed-<topic>.md，主文件删该节 + 尾部插 '- See knowledge/…'`）。处置：`L4483`/`L4487`/`L4512` 对 `fixed.md` **统一分流**为「精简合并 / 请用户裁决 / 用户带 full_rewrite:true 显式声明」，并删掉"下沉成 `- See knowledge/…` 指针行"这句**自己教绕过**的话。⚠ 实现纪律：**不得顺手重构那个三元**（`_test-v268.mjs` A18 逐字断言它）。
- **【P3·权限，红队】放开描述＝撤掉当时唯一的闸门**（全文件无调用方权限检查，**描述即权限**）。处置：**独立注册**一个 `tools/pre-execute` —— 非插件子代理调用 `memory_dream_patch` 且 `file ∉ {fixed.md}` → deny（堵主代理顺手改 global/index/projects，绕过 dream 的整合纪律与账本）。
- **【P3.5·重启后实测抓到的重磅根因：钩子签名一直写错 → 三个 deny 全是装饰品】** 重启 v2.6.9 首版后实测：探针①`memory_dream_patch` 写 `global.md` → **未被拦**（返回 `skipped`）；探针②`write` → `fixed.md` → **直接落盘**；`.monitor.json` 两条 deny 留痕**均 0 条**。查 DSH 本体源码确认签名（`dsh-tools/lib/types/index.d.ts` L39）：`'tools/pre-execute'(exec: ToolExecution, next) => Promise<PreToolDecision>` —— **首参就是 `exec`**（`{callId, name, arguments, agent?, signal}`，同文件 L198-224）；`{agent, exec}` 是 `agent/pre-step` 的形状。插件**三个**处理器全写成 `({ agent, exec }, next)` → 双 `undefined` → **永远静默放行**：⇒ **v2.6.0 的 D2 打转熔断从上线起就是装饰品**，v2.6.8 的直写闸与 v2.6.9 的主代理闸同病（v2.6.8 那句"独立注册 deny"整条是空转）。已修三处签名。**⚠ 行为变更声明**：D2 由此从"装饰"变"**真拦**"（v2.6.0 的设计意图，但属行为变更——不希望它真拦就一句话回退）。新增门断言 **AA4** 守此 bug 类（v2.6.8 字节上逐字打出 `({ agent, exec }, next)` 两处）；**C6 的调用形状同步修正**——原 C6 是按**错签名**测的，属"假通过"。探针产物 `fixed.md`（165 B）已清理。
- **【P4·提示词补全 6 处】** ①`memory_dream_patch` 描述去掉"仅 dream 整合子代理使用"、枚举补 `fixed.md`、写明用途与**机器可核验判据**（该字面量在 knowledge/projects/tools/global/index **全库零出现**）②`memory_size_preview` 描述与**它的 `file` 参数 schema**（两处独立位置）都补 ③`memory_search` 描述补 `fixed` ④会话开始「记忆刷新提示」补 `fixed.md 耐久层` ⑤**变更通知正文补 `mF` 分支**（v2.6.8 时 `mF` 只参与 silent 判定、通知正文无它 ⇒ **仅 fixed 变化时模型收到一条无信息量通知**＝行为缺陷）⑥dream 任务书 **EXTRACTION 段**显式「`fixed.md` 禁提取、禁下沉、禁 delete」（原只有"必读稳定层"那行提到它）。
- **【P5·判据改机械核验，红队】** 原草案「半年后还需要吗」会退化成"现在显不显著"，且"编号"判据最危险（API 返回的每个 ID 都会被写，1200 字两三个任务即满）→ 换成**可机械核验的必要条件**（全库 `includes === false`）。
- **【P6·health 留痕，含判空】** dream 轮内 `fixed.md` 被删减 ≥40 字符 → `health` 留痕（代码层分不清 dream 与用户，闸不能改硬，只能让违规**可见**）。⚠ **必须判空**（工程席指出的最危险一步）：文件不存在时 `dreamSnap["fixed.md"]` 是 undefined，直接取 `.chars` 会抛 TypeError 被外层 catch 吞 → **「验收通过→清旧 health」永不执行 → 过期告警永久挂起（v2.4.35 复活形态）**；已写成 `const sn9 = dreamSnap["fixed.md"]` + `sn9 && Number.isFinite(...)`。
- **验证**：`node --check` 0；**当前副本与生效副本 `_test-v268.mjs` 均 74/0**（新增 AA1-AA3 + N1-N9b + G5/G5b/G5c/G5d）；**对 v2.6.8 字节 FAIL 17 / PASS 57** —— 那 17 条**正好是本批新增断言**（鉴别仪式成立且逐条可读）；结构门 35/0、`_test-size-warn-parity` 33/0、8 回归门全绿；生效副本同步后 sha16 **`197938C2492E2B41`**（707,074 B），对其跑门 35/0 · 33/0 · 74/0；备份：v2.6.8 字节 → `index.js.v268-pre-v269-20260917-1737.bak.js`。
- **影响面（诚实）**：工具描述是**每请求常驻**（新增约 250 字符 ≈ 150-200 tokens，**每轮都付**），比"一次缓存失效"更重；刷新提示/任务书/报错文案各一次性失效一次；**不同工具集是不同前缀**（子代理工具集受 filter 影响，各付一次 miss）。
- **本版不做（登记）**：`~/.dsh/AGENTS.md` 更新（前缀缓存红线，须用户单独批）——⚠ 它与 **`AGENTS.template.md` + `install.ps1`** 三份互为副本，将来必须**一起改**（工程席指出）；真往 `fixed.md` 播种内容（能力修好后再做，内容由用户过目）。
- 未 bump（沿用惯例）：PLUGIN_VERSION / package.json / version.txt 仍 2.5.6。

## v2.6.8（2026-09-17，未发布）：耐久层 fixed.md（②a）+ 检索可达性（①）+ 轮转副本校验（④）+ 未沉淀只读清单（③）

> 本版由**四人评审组**（提案人/红队/工程可行性/证据治理 + 组长裁定）两轮对抗评审后实施，方案见 [方案-v2.6.8-耐久层与检索可达性.md](方案-v2.6.8-耐久层与检索可达性.md)。

- **缘起（用户原话）**：「有些东西确实很重要，但可能在长期的任务中没整合了」——组内实测证实这不是错觉：
  - **检索盲区 252,902 字符 ＝ sessions 总量 373,727 的 67.7%**（顶层失联 26 文件 127,135 + archive 10 文件 125,767）；`loadKnowledgeTargets` 只覆盖近 7 天。
  - archive 抽 79 个精确字面量，**41 个（51.9%）在活跃库其余 983,098 字符中零出现**（口径＝**检索可达性缺口**，非数据丢失率——read 直读仍可达）。
  - **条目级未沉淀率 35.8%~56.4%**（5 个日档 250 条），其中出现在 `projects/` 的 ＝ **0**；现有判据只有「整会话级」`sessionMentionedInMemory`（条目级完全不可观测）。
  - 三条提案对 4 起既有事故的防护 ＝ **0/4**（它们治"整合不足"，不治"丢失"）→ 故另立 ④。
- **① archive 进检索候选集**：`loadKnowledgeTargets` 新增「底座 5」扫 `sessions/archive`（`size > 200` 滤空壳/说明页、label 加「归档 」前缀防与顶层日档同名），**不动任何排序权重**（收益在"可搜"不在"排前"）。已知限制照实记：`qLow === base` 是 basename 匹配，同名时取 `targets` 序首个命中 → 裸日期查询有歧义，写全 `sessions/archive/<日期>.md` 或看 label 可消歧。
- **④ 轮转先校验副本再清空 + 最旧快照转冷档**：
  - `rotateSessions`：`copyFileSync` **前后各取一次 sha256** 比对（hash 严格在清空**之前**取——写在清空之后会让全库恒判不一致 → sessions 永不轮转、静默堆积）；不一致**先重试一次**；仍不一致 → **不清空源** + `monitorEvent("archive","rotate-copy-mismatch")`。这是事故①（`archive/2026-08-31.md` 曾变 867 B 空壳）的机制缺口：旧实现只回读校验"源已清空"、**从不校验副本**。
  - `runBackupNow`：最旧快照不再 `rmSync`，改为**复制到 `cold/` → 校验含 `global.md` → 才删原档**（失败保留原档 + cwarn）。`cold/` 不匹配 `^\d{8}_\d{4}$` → 不计入 `BACKUP_KEEP`、不会被二次清理。
- **③ 未沉淀只读清单（模块级具名导出，可测）**：`scanUndeposited({days,cap})` 扫近 14 日 `sessions/*.md` **＋ archive 全量**（必扫 archive，否则 30 天前内容永远判未沉淀 → 假阳性爆炸）→ 抽经「值得沉淀」判据过滤的精确字面量 → 与 `knowledge/projects/tools/global/index/fixed` 全文比对。`updateDepositWatch()` 记 firstSeen 水位，落**独立点文件** `.deposit-watch.json`（**刻意不碰 `.integrate.json`**：该文件另有 `L7018`/`L8774` 两处写者，新字段并入会互相覆盖）。接线走 `danglingLegacyTxt` 那条**非阻塞**通道（不进 `health`、不阻塞验收），随 `/dream` 结算提示出 → **注入增量 0**。抗漂移口径：报「新增条数 / 滞龄 >21 天条数」；指标＝同批回流率（≥40%）+ 老化中位数（<21 天）。
  - 抽取器经真库探针两轮收紧（初版首屏大半是代码碎片，那样的报告用户会直接忽略）：必须像可复用精确字面量（Windows 路径/URL/文号/带扩展名文件/`@scope/pkg`/≥4 位数字），**排除**通配 `*?#<>{}|` 与带空格的散文和代码（除非像命令 `npm/pip/git/pwsh/Set-*`）；并修掉文号正则贪婪（`〔2025〕440号）.docx\`）去编号`）与路径漏排顿号（两条路径粘一条）两处。
- **②a 耐久层 `fixed.md`（完整档）**：
  - **独立根文件 + 独立预算 1200 字符**，与注入预算严格相等；**不写 `##` 标题** → 全文落 `sectionAwareSlice` 的 preamble、不参与"按节均分"。⚠ **保序 ≠ 保安全**：全文超预算时 `L1111` 会静默切尾 → 安全性**只来自写时拒写**。
  - **ROOT_FILES 单源收敛**：新增模块级 `const ROOT_FILES = ["global.md","index.md","fixed.md"]`，替换 `rootFiles` 默认值与 `checkSizeOverflow`/健康检查两处循环；`L6028` 因是**两条 `addFile(rel,"稳定层")` 硬编码调用（不是数组）**，改为显式加一行 `addFile("fixed.md","耐久层")`；`L4166`（归档闸）与「纯删未下沉」检查**故意不动**（后者纳入反而在人工清理时误报）。
  - **写入口采 M2**：复用 `memory_dream_patch`（**工具 schema 零变化**）→ 自动继承写时预算闸 + 指针闭合闸；另**独立注册**一个 `tools/pre-execute` 处理器 deny 原生 `write/edit/apply_patch` 直写 `fixed.md`（工程席必改：塞进 D 级熔断处理器会被其首行 `if (!spiralBreak || brkLevel < 2) return next()` 静默关掉）。
  - **溢出语义**：`budgetOf("fixed.md")` 返回 `{chars:1200}`（**不加 `extract`**）→ 复用既有预算闸＝整批拒写 + 精确差数 + 下沉指令文案（不发明第二条路径）。
  - **耐久保护三闸**：①`delete` 一律拒（`L4304` 逐字写着"delete 不受预算限制"，没本闸就是纸墙）；②净删 ≥200 字符且新文不含 `knowledge/` 指针一律拒（**既有收缩熔断只作用于 `replace` 的 content，一条 `edit` 就能清空整文件**）；③上述两闸同时是 dream 侧"禁提取"的**代码执行者**（提示词层无强制力：全库唯一的代码检查是整文件 substring 的 `L8730`）。
  - **注入块**：`sectionAwareSlice(fixedMd, 1200, "fixed")` → `stableParts` **第三块**（记忆索引之后、摘要之前，单块注入）；`hF` 进 `recordInjectSnapshot`，`mF` 判定带 **legacy 守卫** `typeof snap.f === "string"`（存量快照无 `f` → 恒不触发＝零迁移噪音）；**`loadInjectSnapshot` 读端白名单必须同步带 `f`**（工程席必改①：只在写端加 → 重启后 `mF` 恒 false，变更通知永久静默；本文件曾记过 `p` 字段同型 bug）。
  - **面板同源**：`charLimit/warnChars` 走 `limitOf` 自动生效；`injLayer` 白名单加「耐久层」（漏了会被标"按需层"→ 超限零告警，事故④同型）；参考阈值文案加「固定要点 1080 / 1200」；key 解析改按 `CHAR_LIMIT` 查表 + `hasOwnProperty`（保原型键防护，不加 cwarn 以免与门断言耦合）。
- **验证**：`node --check` 0；加载门 **35/0**；`_test-size-warn-parity.mjs` **33/0**；**新增** `_test-v268.mjs` **53/0**（A 静态接线 25 条 / B 行为断言 14 条：直调导出的 `sizeStateOf/warnCharsOf/scanUndeposited/updateDepositWatch` 真求值 / **C 端到端 10 条**：真 `apply()` → 真注册工具 → 真 `execute` / **D archive 检索可达性 4 条**：真 `memory_search` 命中只存在于 archive 的字面量），**对改动前副本 FAIL 38 / PASS 9**（通过的 9 项是本来就两边都该过的契约断言/对照项：B5/B6/B7、C0/C9、D0/D2/D3）→ **鉴别仪式成立**；回归门 sessionlog 19 / fmt-selftest 11 / project-boot 23 / docstatus 8 / pointer-closure 31 / smoke 30 / onboard 31 / patch-merge 11 **全绿**；**生效副本**（`profiles\web\plugins\memory\index.js`）同步后 sha16 **`8926865ACEC91267`**（700,324 B），对其跑门 35/0 · 33/0 · 39/0；改动前基线 `9363B4AE2CE34999` 已备份到唯一路径 `index.js.pre-v268-20260917-1630.bak.js`，v2.6.7 生效副本另备份为 `index.js.v267-pre-v268-20260917-1646.bak.js`。
- **实施中真发生的一次回归（本版最有价值的过程证据）**：批量编辑**漏声明 `const hF`** → `注入异常: hF is not defined` 被注入链 catch 吞掉，**结构门 35/0 全绿照旧**，只有**行为门**（`_test-fmt-selftest.mjs` 断言真注入内容）复现 → 与方案 §8.2 预言的失效形态一字不差（v2.6.7 的 `utf8Bytes` 同型）。**教训：动注入链必须跑行为门，结构门不是交付证据。**
- **影响面（诚实边界）**：常驻注入 ≈5,143 → **≈6,343 字符（+23.3%，上限口径）**，每会话永久；项目切片仍 ≤2000（P3 只把 `Discovered durable knowledge` **追加到 priority 末尾**——红队实测：插在 Rules 之后会把长沙项目「当前状态与下一步」612→207 字、发改委 Gotchas 557→73 字；末位则 0→239、零回退）；检索候选集 ≈95→105 文件但**注入增量 0**；**子代理仍不注入**（只给顶层会话）。前缀缓存：上线首请求一次性 miss；`fixed.md` 每次变更 → 该块及其后 miss 一次（非每会话）。
- **本版不做（登记防再漂移）**：`AGENTS.md` 的"更新记忆用 edit 工具"措辞未同步（前缀缓存红线，须单独批准）；层名映射未通用化（仅 `L6028` 手工加行）。
- **端到端验证缺口已于同日闭合（原记为"本版最大缺口"）**：初版门只覆盖 `budgetOf/sizeStateOf` 层 + 静态接线，未覆盖"经真实 `memory_dream_patch` 写 1201 字符被拒"。复核发现该工具的 `execute(args)` **没有任何 dream 流程门禁**（直接 `applyPatches(patches, {allowDangling})`）→ 可驱动，遂补 C 组 10 条端到端断言：C1 写 1201 整批拒 + 差数／C2 写 1199 通过且盘上 1199／C3 `delete` 拒／C4 净删拒／C5 拒写后原文未被改动／C6 独立 `pre-execute` deny 生效／C7 注入真含【固定要点】／C8 块顺序在记忆索引之后／C9 **注入链零异常**（C9 正是本版实施中 `hF is not defined` 的回归守门）。**教训固化：`execute` 无门禁 ⇒ 端到端可测，别再拿"不可测"当借口。** 同期再补 **D 组 4 条**：①archive 的可达性此前只有静态断言（A21"源码里有这行"），抓不到"`listMdNames` 对子目录不生效 / 候选集合并被去重吃掉 / 空壳过滤失效"这类真故障 → D1 断言"只存在于 archive 的字面量能被 `memory_search` 命中"（**真跑通**）、D2 对照（活跃日档未退化）、D3 空壳过滤（<200B 走 0 命中分支）。⚠ D3 第一版是**假失败**：搜不到时返回文案会**回显查询词**，用"不含该字面量"判定必然失败——已改为断言"走了 0 命中分支"。
- 未 bump（沿用惯例）：PLUGIN_VERSION / package.json / version.txt 仍 2.5.6（gate `_gate-plugin-load.mjs:104` 断言 `package.json === "2.5.6"`）。



## v2.6.7（2026-09-17，未发布）：软硬阈值同源（W1）+ 近限按变化报（W2）+ 假「通道闸」文案修正

- **现象（维护 index.md 时自查发现，非用户报）**：记忆索引 `index.md` 已 **2102 字符（越过 2000 字符硬限 102 字）**，而**全区间零告警**——既没有控制台 cwarn（3645~3988 B 区间从不触发），也没有「接近硬限」的注入提醒；超限后注入会被 `sectionAwareSlice` **按节均分截断**（不是丢尾行，是每节正文都被切），召回指针会碎在半句上。
- **根因①（量纲不同源，硬缺陷）**：软阈值 `SIZE_WARN` 是**字节**、硬预算 `CHAR_LIMIT` 是**字符**。软告警能先于硬限响的**充要条件是 `b > W/L`**（b=字节/字符）：index 要求 b > 4608/2000 = **2.304**，而它以 ASCII 路径/ID 为主、实测 **1.857 B/字符**（1963 字/3645 B）→ **软告警整条通道不可达**。源码注释「中文 4608B≈1500 字」隐含 3 B/字符，只对纯中文成立（global 实测 2.087、摘要 1.799，同属该类风险）。
- **根因②（信号投递粒度，更贴近事故）**：注入面提醒受 `maintenanceInjected` 闸（`4066` 置位 / `6850` 判 / **无复位**）→ **每插件实例仅 1 次、且只在首个顶层会话**；而本次是**会话中途**越限，那时闸早已消费完 → 即便把告警线降到 1800 也拿不到任何信号。
- **根因③（绕过写，非插件缺陷、但同因暴露）**：写时闸 `4316`（`F > b.chars`）会**硬拒**超预算写入 → 2102 字符这一状态不可能由 `memory_dream_patch` 通道产出，**必然来自一次 fs 直写**（本次实录：主代理为补两处索引指针用 `write` 直写）。
- **修复 W1（同源化，`>>> SIZESTATE BEGIN/END` 区）**：新增模块级 `WARN_CHAR_RATIO = 0.9` / `WARN_CHAR_CLEAR_RATIO = 0.85` + `limitOf/warnCharsOf/clearCharsOf` + 单一判定源 `sizeStateOf(key, text)`（三态 `overHard`/`nearHard`/`overSoft`；`chars == 硬预算` 判 near 属**合规态**，与 `sectionAwareSlice` 的 `<=` 同口径）。判定点**穷举 11 处**：三处 cwarn（global/index/摘要）、`checkSizeOverflow`、提醒文案三态、目标句、`buildMemoryDocStatus`（+`warnChars/clearChars/nearHard` 字段）、面板 tag/进度条配色/图例、`/dream` 健康第二真源（原硬编码 `3000/2000` 且比较符 `>=` 与截断口径相反）、上限注释。**`SIZE_WARN` 保留为字节兜底（OR），数值不动**。
- **修复 W1-前置（必须先做，否则整链静默失效）**：`utf8Bytes` 原唯一实现在 `apply()` **闭包内**（`5939`）→ 模块级 `sizeStateOf` 调它会 `ReferenceError`，而三处 cwarn 位于注入链 try 内 → 异常被吞成一行 `cerr`，**稳定层/项目块/当日摘要/维护提醒/初始化引导整链静默失效**（v2.6.3 同型）。已整块**提级到模块级**并删除闭包内副本；新增 `export { sizeStateOf, warnCharsOf, clearCharsOf }` 供门测试直调（勿放进 ONBOARD/INT_HASH marker 区——`test/onboard.unit.test.mjs` 对 ONBOARD 区做 `new Function` 求值）。
- **修复 W2（按变化报）**：`agent/pre-step`（step 1 顶层会话）新增水位检查——与 `.integrate.json` 的 `nearHard` 水位比**增长 ≥30 字符**且 ≥告警线才报一次；**不增长则静默**（防 index 常年 1900+ 时变墙上噪音）；首次越硬限立即报，之后仅在水位继续增长时报；降到清除线下复位水位。内存另有 10 分钟/文件冷却。
- **修复 F1（文案与事实不符）**：提醒文案原写「禁止 write/edit 直写记忆库——直写会被**通道闸**拒绝」。全文件**无此实现**（唯一 `tools/pre-execute` 是 `7300` 的 D 级打转熔断；`8456` 的 `toolFilter` 只约束 dream 整合子代理），实际约束是 DSH 沙箱+审批**且可提权越过**（本次三次直写均成功即证）→ 已改 2 处文案 + 1 处错注释（`6105`）为「直写会**绕过**插件校验（指针闭合闸/预算闸/回读核对），后果自负」；`AGENTS.md` 未动（前缀缓存红线，另议）。
- **验证**：`node --check` 0；加载门 `_gate-plugin-load.mjs` **35/0**（新增 11 条 v2.6.7 断言），对 **v2.6.6 运行处副本 FAIL 2**（鉴别仪式成立）；**新增** `_test-size-warn-parity.mjs` **33/0**（A 单元 / B 可达性规格 / C 行为级真 apply+真触发 `agent/created` / E 按变化报 6 例 / D 语义不扩散），对旧副本 **FAIL 14** 且失败原因为「**告警未出现**」而非「源码无字符串」（真鉴别）；回归门 `_test-sessionlog-path.mjs` 19、`_test-fmt-selftest.mjs` 11、`_test-project-boot.mjs` 23、`_test-docstatus.mjs` 8、`_test-pointer-closure.mjs` 31、`test/plugin.smoke.test.mjs` 30、`test/onboard.unit.test.mjs` 31、`test/patch-merge.tests.ps1` 11 **全绿**；既有断言**无一被打破**（两路独立评审逐文件实读确认：无整对象严格比较、无尺寸文案字面量断言、无 `console.warn` 捕获）。
- **影响面（诚实边界，勿当「零退化」）**：「不改数值 ≠ 不改既有告警时机」。新版额外告警字符区间 = `[warnChars, floor(W/b)]`，仅当 `b ≤ W/warnChars` 时非空：**global 空（真零退化，实测 b=2.087 ≥ 1.707）**；**index [1800,2481] 提前 682 字符**；**摘要 [1350,2276] 提前 927 字符**（纯 CJK 摘要仍有 [1350,1365] 差异带，即部分回退 v9.1「2048→4096B 降噪」决策——已向用户报备）。summary 的 cwarn **只打印字节**（避免与 `checkSizeOverflow` 的剥 intent 面形成「同一文件两个字符数」的新漂移），其计数口径**本版不动**（跨子系统：`8288` dream 强制候选 / `8576` 整合健康 / `needMaintenanceMerge`）。
- **语义锚点（防扩散）**：`checkSizeOverflow` 的 `truncated` **字段名与语义保持不变**（仅 `chars > 硬预算`）——`8288`（超限摘要强制入 dream 候选）与 `8576`（整合健康）依赖它，把 `nearHard` 混进去会**每轮强制 spawn 整合子代理**；已加门断言锁定。
- **部署校正（重要，推翻既有说法）**：三个 profile 的 `cordis.patch.yml` 均写 `name: dsh-memory`，包名解析走**唯一** junction `~/.dsh/profiles/node_modules/dsh-memory` → **Target = `profiles\web\plugins\memory`**，而 `profiles/{web,web-test,web-cc-test}/node_modules/dsh-memory` **三处都不存在** → 三个 profile 实际加载的是 **web 那一份**。「三处 sha16 一致」**不能**证明运行处已换新；正确校验 = ① junction Target 未变 ② **生效副本** sha16 ≠ 旧值 ③ 只重启 web 即生效。
- **本版不做（登记防再漂移）**：`maintTriggerChars`/`MAINT_LIMIT_ALLOW` 与 `CHAR_LIMIT` 未同源（仅登记）；summary 三条通道被测量差异（raw / 剥 dump / 剥 intent）未统一。
- 未 bump（沿用 2.4.24 发布惯例）：PLUGIN_VERSION / package.json / version.txt 仍 2.5.6（注意 gate `_gate-plugin-load.mjs:104` 断言 `package.json === "2.5.6"`，顺手 bump 会连坐门失败）。

## v2.6.6（2026-09-16，未发布）：归档并发真闸门（在跑 ≤5 + 等待队列）+ 手动 dream 撞车兜底

- **现象（用户报）**：09-16 17:06 手动 `/dream` 时控制台一次冒出 7 条「记忆注入:（子代理跳过）」，即 **7 批归档子代理在同一秒全部创建**；同时 `dream 管线: 先归档 59 个漏网会话，完成后自动接续整合` 之后 **0 秒**就出现 `已发起自动整合子代理（手动）`——归档与整合并行跑了。
- **根因①（并发闸失效）**：`ARCHIVE_MAX_CONCURRENT = 2` 只限制**发起循环的协程数**，而 `startOneBatch` 内部 `subagents.start` 是秒级返回（不等在跑）→ 两个协程瞬间把队列全部排空、7 批全发起；「并发上限」从未约束**在跑子代理数**（真实并发 = 批数）。
- **根因②（撞车静默跳过）**：会话启动时的 silent 自动归档（`agent/created` → 维护提醒链）与手动 `/dream` 的归档阶段常同刻触发；`runStaleArchive` 撞上 `STALE_RUNNING` 防重入后返回 `ok:false`，而 `runDreamPipeline` 只在 `r.ok && r.done` 时才等待结算 → 被拒即直接 `spawnIntegrate`，「先归档后整合」的语义保证静默失效。
- **修复①（真闸门 + 队列，用户拍板上限 5）**：两段式保持不变（首批发起即返回、节流戳立即落盘）。**首批只发起 `ARCHIVE_MAX_CONCURRENT`（2→5）批**，其余进等待队列；`settle` 内改为 runner 链——每个槽位结算完一批后从队列取下一批发起（`nextIdx` 游标），使**在跑子代理数恒 ≤ 5**；发起失败只记 `startErrs` 并继续取下一批（不卡队列，失败批会话本轮不消号）。新增日志 `归档并发闸：首批 5/N 批已发起，其余 M 批排队（在跑上限 5）`。
- **修复②（撞车兜底）**：新增模块级 `STALE_ACTIVE_DONE`（发起成功即暴露结算链句柄、`settle` 的 `finally` 复位；与 `STALE_RUNNING=false` 同时序，等待者被唤醒时账本已写入可读）。`runDreamPipeline` 撞车时：等该句柄结算（上限 45 分钟）→ 重扫剩余候选（`scanPending()`）→ 补一轮归档 → 再整合；若已有归档已收走全部候选则备注说明。
- **修复③（等待放宽，用户拍板）**：新增 `DREAM_ARCHIVE_WAIT_MS = 45 * 60000`，替换原先两处硬编码 `25 * 60000`（等已有归档 / 等自己发起的归档共用）。理由：并发闸生效后在跑 ≤5、其余排队，31 会话/7 批约 2 轮、59 会话约 3 轮，25 分钟容易把「等归档结算」判成 timeout 而提前整合。
- **验证**：`node --check` 0；加载门 `_gate-plugin-load.mjs` **25/0**（新增 7 条 v2.6.6 断言：上限=5 / 首批+排队 / runner 补批 / 旧发起循环已移除 / 句柄暴露与复位 / 撞车等待+重扫 / 45 分钟常量与两处使用），对 **v2.6.5 运行处副本 FAIL 7**（鉴别仪式成立）；回归门 `_test-sessionlog-path.mjs` 19、`_test-fmt-selftest.mjs` 11、`_test-project-boot.mjs` 23、`_test-docstatus.mjs` 8、`_test-pointer-closure.mjs` 31、`test/plugin.smoke.test.mjs` 30、`test/onboard.unit.test.mjs` 31、`test/patch-merge.tests.ps1` 11 全绿。**并发闸真机实证（2026-09-16 18:20 轮，已闭环）**：归档子代理创建时间序列 = **18:20:44 首批 5 个同秒** → 18:22:13 第 6 个 → 18:23:41 第 7 个（每批耗时 1.5~3 分钟后由 runner 链补位），共 7 批；对比旧行为（17:06:19 七批**同秒全部发起**）闸门确实生效。同轮归档账本 **243→273（+30，与预计一致）**，待归档剩余清零（另 3 个活跃会话按 30 分钟下限挡下）。
- 未 bump（沿用 2.4.24 发布惯例）：PLUGIN_VERSION / package.json / version.txt 仍为 2.5.6。

## v2.6.5（2026-09-16，未发布）：会话日志改名致漏网检测静默失效（6 处路径自适配 + 格式漂移自检 + 手动 dream 口径）

- **现象**：2026-09-16 用户报「今天开了好多会话，应该都没归档吧」——漏网检测对当天会话毫无反应，面板「未整合记忆会话数」恒 0。实扫 `~/.dsh/sessions` 确认：**09-10 20:10 之后的会话全部隐形**，归档账本最后一批停在 09-10，未落档积压 63 个（09-10~09-16，含 09-16 当天 19 个）。
- **根因**：DSH 自 2026-09-10 20:10 起把会话日志由 `session.jsonl.zstd` 改名为 `session.v3.jsonl.zstd`（zstd 多帧格式不变、magic 仍 `28 b5 2f fd`，只是文件名变）。插件 6 处读日志点**全部硬编码旧名**：`findStaleSessions` 扫描（`statSync` 失败即 `continue`）、`archivePendingEntry` 水位帧数、`resolveInjectUsedOnce` 的 used 判定、归档提取 `logPath`、`summarizeSubagentUsage` 消耗统计（+3 处文案）。后果不是崩溃而是**静默失效**：v3 会话从未进入候选、零报错——与 v2.6.3 的 `agent/session-start`→`agent/created` 改名事故同型。附带退化：7 个「两种文件都有」的会话水位按停在 09-10 的旧文件计算，新内容（如 `session-574b8af7`：旧 8 KB / v3 7.87 MB）永远进不了增量重档。
- **修复①（自适配，根治）**：新增 `resolveSessionLogPath(dir)` —— 按 `SESSION_LOG_CANDIDATES = ["session.v3.jsonl.zstd", "session.jsonl.zstd"]` 顺序探测（v3 优先、legacy 兜底），6 处调用点统一走它；归档提取遇 `null` 明确记「无流跳过」+ 落 `batchFrames`，不再对该类会话白提一轮。
- **修复②（自检，防再次静默）**：扫描时顺带 `probeUnknownLogNames(dir)` 采集未识别的 `*.jsonl.zstd` 名（白名单外）→ 维护提醒 `parts` 注入对话一次，文案给出「把新文件名加入 SESSION_LOG_CANDIDATES 后重新部署」的修法；按文件名去重，持久化 `.integrate.json fmtNotified`（跨重启不重复提示）。**用户诉求原文：「对于这种检测不到的，应该插件提示，并反馈到对话中的。以防以后 dsh 再改」**。
- **修复③（手动 dream 口径，用户拍板）**：手动 `/dream` 不再吃 `settings.staleSessionDays`，改固定活跃下限 `MANUAL_STALE_MIN_IDLE_MS = 30 * 60000`。用户实证诉求：阈值设 1 天、但会话实际 12 小时就结束 → 手动触发时就该收走它；保留下限是为不把**仍在写入**的半截会话当完整会话归档（否则会连发起会话本身一起归档）。自动定时整合与 `stale_archive` 工具仍按 settings（不扩大自动动作范围）；dream note 文案带口径。
- **顺带修复**：面板「未整合记忆会话数」（`staleCount`）改用与手动口径一致的 30 分钟下限——旧口径按 settings 天数，v3 隐形期显示 0，与真实积压 63 个严重不符（误导）；仅影响显示值。
- **影响面澄清（重要）**：修复不改变「已落档不再算漏网」的口径——63 个积压只含**确实未落档**的会话；已归档会话继续对话时靠水位重入（v2.4.3 设计），该机制对 v3 会话在本次修复后恢复生效（此前因水位读不到而退化为「永久静默」）。
- **验证**：`node --check` 0；新增 `_test-sessionlog-path.mjs` **19 断言全绿**（A1~A10 结构接线 + B1~B3 真机事实：v3-only 63 / 两种都有 7 / 仅旧名 207 / 09-11 后 v3 67，逐样本双验 v3-only 目录对旧名必判「读不到日志」）；加载门 `_gate-plugin-load.mjs` **18/0**（新增 5 条 v2.6.5 断言），对**运行处旧副本 FAIL 5**（鉴别仪式成立）；回归门 `_test-project-boot.mjs` 23/0、`_test-docstatus.mjs` 8/0、`_test-pointer-closure.mjs` 31/0、`test/plugin.smoke.test.mjs` 30/30、`test/onboard.unit.test.mjs` 31/31、`test/patch-merge.tests.ps1` 11/11。
- 未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）：PLUGIN_VERSION / package.json / version.txt 仍为 2.5.6。

## v2.6.4（2026-09-15，未发布）：dream 悬空指针根治（写时闭合校验 L1 + settle 反向核对 L3 + 任务书去矛盾 L0）

- **现象**：2026-09-15 那轮 dream 在 `projects/长沙交易场地智能化系统升级改造.md`（4 处）与 `sessions/2026-09-15.md`（2 处）写了 `See knowledge/MEMORY-长沙项目-云资源变更方案.md（30 项）` / `MEMORY-长沙项目-问答测试与前端部署.md（24 项）` 指针，但两个 knowledge 分册**从未落盘**——按指针召回必扑空，破坏「能召回的必已落盘」不变量（已人工改指实存落点 + 保留「未落盘」诚实标注）。
- **根因（三条机制叠加，非模型偶发疏忽）**：① 任务书自相矛盾——`5. 同批原子` 要求指针与目标同批，`看护续期纪律` 却示例「先写一个文件的**指针行**续期」；② 批内原子（errors 非空整批不写）只覆盖**单次**调用，跨调用无事务、无补写机制，而看护/预算两条压力都在**鼓励拆批**；③ 一致性体检是**单向**的——只查「内容→指针」（提取一致性、疑似纯删未下沉），从不查「指针→目标」。
- **修复 L1（写时闭合校验，根治）**：`applyPatches` 预算闸之后新增——本批**新增**的库内指针（`See|see|参见|详见|参考|见|→` + knowledge/projects/tools/sessions 路径）必须满足「目标也在本批 rel 集合内」或「磁盘已存在」或「sessions 已轮转进 archive」，否则整批拒写（复用现有 errors 机制，错误文案直接给出修法）。判据只用**新增面**（addTxt=edit 的 new_string / replace·append 的 content / delete 视为空；preTxt=该 rel 磁盘现文），故历史悬空指针不会卡死该文件后续写入；命中行含「未落盘/待补/不存在/已移入/已轮转」等描述词时自动豁免（事故记录里逐字复述未落盘文件名的诚实标注不算指针）；整批可带 `allowDangling:true` 显式放行。路径字符类排除 `< 《 * | {` → `knowledge/MEMORY-<项目>-<topic>.md`、`tools/*.md` 等命名约定示例不误判。
- **修复 L1 正则（对现库 120 个 md 实测选型）**：桥接放宽为 `[^\n]{0,10}?`——旧「关键词紧跟路径」写法漏掉 `→ 分册 knowledge/…` 形态（实证 `sessions/2026-09-15.md` L24 真悬空漏检）与 `详见：knowledge/…`（全角冒号）；实测新增命中 31 条全为合法指针，非豁免悬空数不变（无新误报）。
- **修复 L3（settle 反向核对 + 分级，兜底）**：settleDream 体检块新增「指针→目标存在」全库只读扫描（`scanDanglingPointers`）。**分级**：源文件在本轮落盘清单内**或** mtime 晚于本轮起始 → 计入 health（阻塞验收，覆盖旁路写入入口）；其余历史存量 → 只进 `progress.dangling` 非阻塞字段 + 非阻塞提示，**绝不进 health**——否则存量悬空会永久卡死「验收通过 → health 清空」分支，每轮转播挂同一条告警（v2.4.35 记录过的过期告警形态）。实测现库：157 处指针命中中，7 处描述性复述、1 处已轮转正确豁免，只报 1 处真悬空（`projects/湖南省发改委行政监督平台升级项目.md → knowledge/MEMORY-发改委项目-范本库比对.md`，存量、非阻塞）。
- **顺带修复（体检可见性、既有缺陷）**：`dream 整合验收提示` 此前**从未送达会话**——done 转播后 `DREAM_LISTENER` 已置 null，`rebroadcastDream` 的 `patch.health` 分支永远短路，验收结论只躺在 `.integrate.json`。改为仿 v2.4.16 回归结算通道，用 settle 前捕获的 `settleListener` 落 notice（无监听=定期/自动整合轮，不打扰）。
- **修复 L0（任务书去矛盾）**：看护续期纪律明确「续期必须是**内容类** patch，严禁单独落盘指针行；确需先落指针则只能指向已存在文件」；预算类拒写「放弃该文件时不得留下指向未落盘目标的指针」；Write Path 段新增「指针闭合硬校验」条与 `allowDangling` 用法。
- **验证**：`node --check` 0；新增 `_test-pointer-closure.mjs` **31 断言全绿**（A 分两次拒写/B 同批闭合/C·D·E·E2·E3·E4·H·I 误伤边界/F onboard 体检出口/G 桥接写法回归点/J 真 settle 阻塞分级/K 真 settle 非阻塞+health 清空），对 v2.6.3 运行处副本 **19 PASS/12 FAIL**（鉴别仪式成立）；回归门 `_gate-plugin-load.mjs` 13/0、`_test-project-boot.mjs` 23/0、`_test-docstatus.mjs` 8/0、`test/plugin.smoke.test.mjs` 30/30、`test/onboard.unit.test.mjs` 31/31、`test/patch-merge.tests.ps1` 11/11。
- 未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）。

## v2.6.3（2026-09-15，未发布）：DSH 0.1.6 事件改名适配（记忆注入静默失效修复）

- **现象**：升级 DSH 0.1.6-alpha.1 后，新会话不再出现「以下为跨会话持久记忆（dsh-memory 稳定层，自动注入）」注入块——稳定层 / 项目记忆 / 最近压缩点 / 维护提醒 / 初始化引导**全部静默失效**，控制台零报错（真机实证：同一 profile 下 09-12、09-13 会话记录有注入块，升级后会话无）。
- **根因**：0.1.6 把会话开始事件 `agent/session-start` 改名为**异步串行**的 `agent/created`（官方 release note 列为「其他变更」破坏项；0.1.6-alpha.1 安装树全量搜索已无 `agent/session-start` 字符串，只剩 `agent/created`）。插件仍挂旧名 → 回调永不触发；挂不存在的事件名不报错，故表现为「静默失效」而非崩溃。
- **修复**：`ctx.on("agent/session-start", …)` → `ctx.on("agent/created", …)`（payload 仍为 `{ agent, source, signal }`，本回调只用 `agent` → 零逻辑改动）；错误日志前缀同步改名。
- **兼容性**：`agent/created` 是创建事务**串行 await** 的事件（监听器抛错会导致 agent 创建回滚）——本回调同步返回、异步链 fire-and-forget 且内部全 try/catch，既不阻塞创建也不会反噬；触发时机覆盖 `source ∈ startup|resume`（未按 source 分支：恢复会话照旧走 injectSnapshot 三档，文件未变=静默，前缀缓存零扰动）。
- **验证**：`node --check` 0；加载门 `_gate-plugin-load.mjs` 新增两条断言（"已挂 agent/created" + "已不再挂 agent/session-start"），对**旧运行处副本须 FAIL**（鉴别仪式）、对新副本全绿；`_test-project-boot.mjs`（S1~S7：建档/幂等/幂等不覆盖/浅根跳过/`_` 前缀跳过/子代理跳过/续会话 silent 档建档）与 `test/plugin.smoke.test.mjs` 的驱动事件名同步改为 `agent/created`；`_test-docstatus.mjs` 回归。
- 未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）：PLUGIN_VERSION / package.json / version.txt 仍为 2.5.6。

## v2.6.2（2026-09-14，未发布）：工作空间自动建档（新工作空间零记忆问题根治）

- **背景**：项目记忆链路是「模型写文件 → 巡检登记 → 人工补 workdirs/aliases → cwd 命中注入」——新工作空间默认**不命中任何项目**：项目切片不注入、当日摘要全进通用块、dream 无处可挂，表现为「换个目录开会话就没有项目记忆」。
- **行为**：顶层会话 session-start 时（子代理跳过），cwd 未命中任何项目（workdirs 与 `~dsh/project.json` 标记双路皆空）→ 自动补建：
  ① `projects/<目录名>.md` 缺失 → 写最小骨架（标题 + Rules / Architecture decisions / Patterns / Gotchas / Discovered durable knowledge 五节，dream 整合、漏网归档、「## 归档」锚点直接兼容）；
  ② `_index.json` 登记：同名条目已存在 → 只补 workdirs/root（不覆盖文件内容；条目 file≠目录名的改名场景登记进原条目，防双条目打架）；不存在 → 新条目 `{key/display/file, workdirs:[cwd], root, aliases:[]}`；
  ③ 种 `~dsh/project.json` 标记（`seedProjectMarker` 幂等）→ 下轮起 `matchProjectByCwd` 正常命中注入，本轮摘要分格/项目切片即刻按新项目生效；
  ④ 注入一行建档提示（用户拍板「注入提示条」），含改名指引。
- **护栏**：`isDeepEnoughRoot`（<4 段浅根不建）+ OneDrive 冲突副本目录 + `_` 前缀目录名（索引扫描排除段）跳过；已命中或标记已存在（含 stale/bad）→ 零动作（失效交 `reconcileProjectIndex` 巡检报告，防与改名线索打架）；全程 try/catch，失败不阻塞注入主链路。
- **验证**：`node --check` 0；新增 `_test-project-boot.mjs` 23 断言全绿（S1 全新建档/S2 幂等零 churn/S3 同名条目只补登记不覆盖/S4 浅根跳过/S5 `_` 前缀跳过/S6 子代理跳过/S7 续会话 silent 档照样建档——首部署实证缺陷回归点：bootstrap 原在 `injectMode==="full"` 分支内，续会话（notice/silent 档）永不建档，已移至分支前并先建后算 hP，防下发假「项目有更新」通知）；回归门 `_gate-plugin-load.mjs` 11/0、`_test-docstatus.mjs` 8/0。
- 未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）。

## v2.5.6（2026-09-14）：统计面板会话层口径修复（「日记忆只剩两天」误判）

- **现象**：面板 `/dsh-memory/stats` → 记忆文档状态 → 会话层只列 3 条（09-13、08-14、09-12），其中 08-14 为 0 字节，用户据此判断日记忆文件丢了。
- **根因（两因叠加）**：①该区块设计只列「今日 + 最近 3 份」；②排序用 mtime——30 天轮转把过期文件复制进 `sessions/archive/` 后**清空原文件会刷新其 mtime**，0 字节的 `sessions/2026-08-14.md` 于是被当成「最新」，挤掉 09-11/09-10 等真文件；叠加当日（09-14）尚无摘要文件、`addFile` 抛错被 catch 静默吞，视觉上退化成两天。合并维护重写历史文件同样会刷 mtime，同源隐患。
- **修复**：会话层改为「排除 0 字节文件 + 按文件名日期倒序取最近 3 份（mtime 不参与）」，并给该区块加总量提示——`sessions/ 共 N 个日文件（最早 ~ 最新）；本卡只列今日 + 最近 3 份，另有 M 个已轮转为空（原文在 sessions/archive/）`；面板（内嵌 renderStatsPage 与 `~/.dsh/memory/.stats-panel.html` 覆盖文件）渲染 `sec.note`。
- **不改动**：30 天保留 / 更早轮转进 archive 的策略不变；仅改展示口径。
- 版本四处对齐（index.js PLUGIN_VERSION / package.json / version.txt / 本文件）。

## v2.5.5（2026-09-13）：工具描述去陈旧 run_code 限制句

- memory_search / memory_onboard 两工具描述原称「仅可在 run_code 程序内调用，不可直接发起工具调用」——宿主实测直调早已可用（v1.12.18.5 异构参数归一化即为直调方兼容），描述与实际矛盾且劝退直调，把模型检索推向 grep。改为「可直接作为工具调用；run_code 程序内亦可经 await tools.*() 调用」。
- 纯描述变更，零逻辑改动；版本四处对齐（index.js PLUGIN_VERSION / package.json / version.txt / 本文件）。

## v2.4.0（2026-08-30）：压缩检查点链路强化 + 多主会话竞态根治（合并对外 v2.3.3~v2.3.8 六个内部增量）

- **v2.3.3 整合候选纯 hash 账本**：候选判定=账本无记录或 sha256(文件)≠dreamed[rel]；退役 mtime/最近3天/integrateCount%4 全量轮；成功整合后全量记 hash。
- **v2.3.4/2.3.5 smartTrim 分节水填截断**：宿主压缩摘要按 `## ` 分节、按优先级（Next/Current/Errors>Intent/Goal/Context>其余）水位分配预算；节内头62%+尾38%；截断标记自带「全文归档 sessions/日期.md（memory_search 可查）」召回把手。归档端全文直写（≈16000 字）。
- **v2.3.6 记录器输入全文直喂**：意图检查点子代理输入上限 3500→**16000**，与归档上限对齐，真实宿主摘要（观测区间 5681~14087 字）全文原样入上下文；不变量：**能召回的必已喂入**。
- **v2.3.7 检查点预算治理三层**：L1 任务书分节硬预算（本次目标≤120/下一步≤200/关键结论≤4×140，超限从关键结论尾部删整条，宁缺毋断）；L2 写侧护栏（>1000 字整条 pop + overshoot 埋点）；L3 注入端 sectionAwareSlice 替代裸 slice，intent 块不再挤爆当日摘要。
- **v2.3.8 多主会话竞态根治 F1-F4**（真机事故 intent-756123d9 驱动）：F1 记忆注入仅限顶层会话（子代理零注入，杜绝记录器 ghost 轮，顺带省 ~5K tok/子会话）；F2 忙时事件入 INTENT_PENDING 队列按序补火不再丢；F3 intent 标记升 `<!-- intent: <cid> sid:<8字> -->`，按母会话原位替换、日文件全局保最近 3 块、淘汰不伤归档；F4 输出格式守卫（非「## 本次目标」开头拒写 + malformed 埋点）。
- **验证**：重启前门 98/98（F1 子代理零注入/F2 排队补火/F3 三块共存+原位替换+cap 全桩）；真机 v2.3.8 首战（intent-215bc046）零注入、单轮定稿 922 字、per-sid 三块并存、监控零事件。
- 版本号四处对齐（index.js PLUGIN_VERSION / version.txt / package.json / client 注释）。

## v2.3.1（2026-08-28）：监控汇总增量输出 + 归档检查点三防御 + 子代理续跑重试

- **监控汇总增量输出**：每次只推送「标题 + 相对上次有变动的统计行」（行首 key 比对），首次全量建基线，无任何量变动完全静默（设置字段仍全量）。
- **归档检查点三防御**：
  ① FILE 含尖括号/模板占位（如 `sessions/<会话归属日期>.md`）跳过——防子代理复述任务书模板致 ENOENT 崩整批；
  ② 单目标写盘失败仅 cwarn 跳过，不整批判失败；
  ③ 会话日志重组时跳过 user 消息（任务书原文），只采 assistant 与工具结果。
- **子代理续跑重试闭环**：结算重构为可重入 `settleArchive`——落盘失败且属子代理输出质量问题（unparsable/no-blocks/error）时，用 `run.localAgent.followup` 发修复指令续跑，最多 2 次；boundary 越界等插件自身问题不续跑留待下轮。
- 修复实际案例：4 会话归档曾因模板路径 ENOENT 整批失败不消号 → 设置界面 staleCount 卡 4；修复后自动闭环。

## 版本（最新 v2.4.0）

插件版本号在 `package.json` / `version.txt` / 插件 `PLUGIN_VERSION` 三处一致（测试会校验）。插件每天最多一次向发布源拉 `version.txt` 比对（4 秒超时，离线/内网失败静默），发现新版本时启动日志一行 + 会话注入升级提醒。升级动作=重跑安装命令（幂等、安全、改前有 .bak 备份）；升级后必须重启 DSH（宿主插件无热加载）。体检：`powershell -NoProfile -File install.ps1 -CheckOnly`。手动查新版：会话里输 `/memory-update`。镜像：`DSH_MEMORY_RAW` 指向内网镜像（index.js / version.txt / install 脚本同源）。

## 安装脚本 cordis.patch.yml 合并规则（v2，2026-08-28 起）

DSH 给每个新 profile 生成的补丁层是「注释 + 顶层 `[]`」。脚本按文件实际形态处理，不再盲目追加——

| 现状 | 行为 |
|---|---|
| 顶层 `[]`（DSH 默认空文档） | 用注册条目替换该 `[]` |
| 已有顶层 `- insert:` 条目 | 追加到列表末尾（列 0） |
| 只有注释 / 空文件 | 补齐后写入条目 |
| 已被旧版脚本写坏（`[]` 与 `- insert:` 并存） | 自动删掉多余的 `[]` 行修好（含已注册的情况） |
| 顶层是映射、非空流式数组、制表符缩进等无法判定的形态 | **一字不改**，另存 `cordis.patch.yml.dsh-memory-block.txt` 并给出人工合并指引 |

### 装完 dsh 起不来：failed to parse overlay cordis.patch.yml

2026-08-28 前的旧版安装脚本会留下这种文件：

```text
Error: dsh: failed to parse overlay C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml:
YAMLException: end of the stream or a document separator is expected (7:1)
```

一条命令修复（只删多余的 `[]` 行，改前自动备份）：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
```

参数：`-Profile web`（默认）/ `-Profile *`（所有 profile）/ `-DshHome <路径>` / `-DryRun`（只报告不写盘）。注意参数名是 `-DshHome` 而非 `-Home`——`$Home` 在 PowerShell 里是只读自动变量。

等价手工做法（PowerShell，一行）：

```powershell
$p="$HOME\.dsh\profiles\web\cordis.patch.yml"; Copy-Item $p "$p.bak" -Force; (Get-Content $p -Encoding UTF8) | Where-Object { $_ -notmatch '^[[]\s*[]]$' } | Set-Content $p -Encoding UTF8
```

即：把列 0 上那行 `[]` 删掉（一个 YAML 文档不能同时是流式数组和块式序列），保留下面的 `- insert:` 注册即可。

### 首次初始化（新装用户）

- **记忆库为空** → 第一个会话注入「初始化引导」：模型用 `ask_user_question` 一次性问齐（称呼/单位岗位、项目与编号合同号、日常事项、协作人、偏好、环境要点），按协议落盘 `memory/global.md` 与 `memory/index.md`。全程约 1 分钟。
- **引导节流**：一天最多提示一次；用户说「回头再说」则 24 小时内不再打扰（可调 `memory_onboard` 工具 snooze）。
- **随时手动开始**：会话里说「初始化记忆」，或输 `/memory-init`；状态在 设置 → 通用设置 → 记忆 查看。
- **读写协议**：安装脚本在 `~/.dsh/AGENTS.md` 不存在时写入（内嵌模板，绝不覆盖已有文件）。
- 开关：设置 → 通用设置 → 记忆 →「初始化引导」（`initGuideEnabled=false` 后 `/memory-init` 仍可用）。

### 测试（仓库自带）

| 测试 | 命令 | 覆盖 |
|---|---|---|
| 补丁合并回归 | `powershell -NoProfile -ExecutionPolicy Bypass -File test/patch-merge.tests.ps1` | cordis.patch.yml 合并 11 例（含旧版写坏的修复、幂等、中文/CRLF） |
| 初始化/升级纯逻辑 | `node test/onboard.unit.test.mjs` | 记忆库状态判定/版本比较/节流/文案 31 项 |
| 插件集成冒烟 | `node test/plugin.smoke.test.mjs` | 真 import 插件跑 apply()：新装引导注入、工具/命令注册、升级检查与节流 30 项 |

集成冒烟需要插件目录能解析 `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/schemastery`（本机：给插件目录建 node_modules junction 指向 DSH 的 node_modules 即可）。

## 插件可配置项（完整表）

配置优先走 **设置 → 通用设置 → 记忆**（存 `~/.dsh/settings.yaml` 的 `dsh-memory` 命名空间，需安装 client 半区）；也可在 `cordis.patch.yml` 的 `config:` 里配（作为默认层 base，settings.yaml 用户配置覆盖它）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 漏网会话检测阈值（天） |
| `staleAction` | `remind` | 漏网处理动作（**同时决定 /dream 是否带归档**）：`remind`=仅提醒，/dream 不含归档 | `silent`=后台自动归档，**/dream 先归档再整合** | `approval`=提醒后需确认（调用 stale_archive）才归档，/dream 不含归档 |
| `integrateEnabled` | `false` | 定期自动整合开关（每 integrateDays 天一次，对标 mimocode dream；也可随时 /dream 手动触发） |
| `integrateDays` | `7` | 自动整合周期（天） |
| `monitorEnabled` | `true` | 使用监控开关（提醒/查询/跟进判定/打转探针的数据采集） |

cordis.patch.yml 示例：

```yaml
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config:
        staleSessionDays: 7
        staleAction: approval
```

client 半区（设置界面入口）安装：复制 `client/` 到 `<profile>/plugins/dsh-memory-client/`，建 junction `<profile>/profiles/node_modules/dsh-memory-client` → 它，并在 cordis.patch.yml 追加 `- insert: { id: dsh-memory-client, name: 'dsh-memory-client' }`。

安装完成后重启 DSH，启动日志出现以下行即成功：

```
[dsh-memory] 已注入稳定层 (N 段)
[dsh-memory] 已注入摘要: YYYY-MM-DD.md
[dsh-memory] memory_search 工具已注册（ctx.tools）
```

## 特性（完整清单）

| 能力 | 说明 |
|---|---|
| 会话开始注入记忆 | 稳定层（global.md + index.md）+ 最近会话摘要，自动注入到每个新会话 |
| memory_search 工具 | Unicode 分词 + OR 匹配 + 相关度排序（TF 加权 + 双分数下限），实时读盘（不依赖注入快照） |
| 检索质量升级 | 中英文混合词拆词、tools/ 记忆文件收录、多命中合并 top N、精确文件名返回全文、0 结果引导 |
| 过期复核提醒 | 知识文件头"最后更新"日期 >180 天未更新时注入人工复核提醒 |
| 压缩检查点自动落盘 | 捕获 /compact 摘要事件，插件 node:fs 直接写入 sessions/今日.md（幂等，带 compactionId 标记），失败才回退提醒制 |
| 备份 / 轮转提醒 | 记忆库 7 天备份、会话摘要 30 天轮转，到期待办注入会话 |
| 超限双轨治理 | 软字节阈值（该整理了）+ 硬字符预算（注入截断点）双轨报告 |
| 多会话去重 | 维护提醒同实例只注入第一个顶层会话，避免并发整理同一文件 |
| 前缀缓存友好 | 稳定层剥离时间戳行，只读不写，DeepSeek 前缀缓存命中率高 |
| A/B/C 自动提醒 | 输入命中已知领域(A)/同一错误第 2 次(B)/连续失败 3 次(C) 时注入相关记忆 + skill 提示；冷却闸 + 领域去重 + 中文 bigram 匹配防漏防刷 |
| 提醒跟进判定（四态） | followed/ignored/open/capped——任务周期窗口、未决窗口跨重启续判、超限截断不计入分母；信号集含 memory_search/skill 与直读 .dsh/memory |
| 过程信号探针（影子模式） | 「参数打转 × 无产出」双条件识别 LLM 原地空转；只记录不干扰，积累轮次画像供阈值自校准 |
| dream 整合全程可观测 | 手动/自动整合后台执行时进度实时写入 .integrate.json，完成后落盘 tokens/时长/结果回执 |
| 整合消耗报告 | 总输入（区分缓存命中）/输出/总时长，口径明确、日志尾部竞态容错 |
| 使用监控面板 | 设置界面显示提醒/查询/跟进率/领域分布/最近触发时间/事件数 |
| 漏网归档审批闭环 | 漏网会话由单主子代理无感编排归档（消息流提取，根治 token 爆炸），支持 remind/silent/approval 三种动作 |

## 设计理念

### 压缩检查点自动落盘（v1.2.0）

宿主插件由 cordis 原生 `import()` 加载，运行在**真实 Node 环境**——`ctx.fs` 的沙箱限制只约束会话工具层，插件自身可用 `node:fs` 直接写入。因此：

- 压缩检查点摘要由插件**直写** `sessions/今日.md`（先读全量再追加，带 `compactionId` 标记幂等去重）；
- 不依赖模型回合：即使压缩后会话立即结束，摘要也已落盘，**记忆不丢失**；
- 直写失败（罕见）才回退**提醒制**：注入可执行 system-reminder，由会话模型执行（沙箱拒绝时升级审批一次）。

### 低频维护提醒制

备份（7 天）、sessions 轮转（30 天）、超限整理仍走提醒制——频率极低，审批成本可控；插件自身只读检查，不写这些文件。

### 前缀缓存友好（省钱）

DeepSeek 前缀缓存：命中 0.1 元 vs 未命中 1 元/百万 tokens。稳定层文件**只在实质变化时更新**，禁止为记录而更新时间戳；注入前剥离时间戳行。

### 超限双轨治理

| 指标 | global.md | index.md | 摘要 |
|---|---|---|---|
| 软字节阈值（该整理了，仅告警） | 4608B | 4608B | 4096B |
| 硬字符预算（注入 slice 截断点） | 3000 | 2000 | 1500 |

软阈值提醒整理，硬预算保证不丢内容；截断处加显式注记 `[注：原文 X 字符已截断]`。

### 多会话并发安全

- 维护提醒同实例只注入第一个顶层会话（查 `SessionHeader.origin`），避免多个主会话并发整理同一文件；
- 写入前全量读后追加，防止覆盖其他会话的最新改动。

### compact 记忆刷新

compact 是上下文重置点，但记忆注入仍是会话开始快照（session-start 只触发一次）。故 compact 时注入轻提示"记忆可能已更新，用 memory_search 实时读盘"——不做全量重注入（浪费 token 且破坏前缀缓存）。

### 健壮性

- 修复 `session/event` 处理器内同步 `agent.inject` 触发的重入异常，所有 inject 推迟到 `setTimeout(0)`（发布窗口之外）执行；
- 路径可移植：`homedir()` + 环境变量推导，无硬编码绝对路径，克隆即用。

## 版本历史

### v2.0.0（2026-08-24 · 记忆系统完整形态）

v1.4 → v1.12 共 26 个迭代合并发布，核心跃迁：

- **A/B/C 自动提醒**（v1.12.0-11）：输入命中已知领域(A)/同一错误第 2 次(B)/连续失败 3 次(C) 时主动注入相关记忆与 skill 提示；检查/提醒解耦 + 冷却闸 + 领域去重 + 中文 bigram 关键词匹配；
- **提醒跟进判定四态**（v1.12.7/13/14/15/16）：followed/ignored/open/capped——任务周期窗口、未决窗口持久化跨重启续判、超限截断不计入分母；信号集扩展至 read/grep/glob 直读 .dsh/memory；
- **过程信号探针（影子模式）**（v1.12.16）：「参数打转 × 无产出」双条件识别 LLM 原地空转——回测验证试错链命中、正常翻页零误报；
- **dream 全程可观测**（v1.12.17）：后台整合进度实时落盘 + 完成回执（tokens/时长/摘要）；消耗报告口径修正 + 日志读取竞态兜底（v1.12.17.1）；
- **使用监控体系**（v1.12.0-9）：提醒/查询/错误事件全量记录，设置界面多行汇总；推送防刷屏（变化守卫 + 60s 节流）；
- **stale_archive 审批闭环 + 单主子代理归档编排**（v1.12.8）：漏网归档无感化，授权二级拆分，消除并发写竞态；
- **分区感知注入 + 整合容量修剪**（v1.12.0）：注入预算内保留章节骨架；整合 prompt 加运行时环境/写入路径/效率纪律三段。

### v1.3.0（2026-08-20 · 合并发布：设置界面 + 漏网检测 + 自动整合 + 检索工具链完整版）

- **官方设置机制**：宿主插件 import `@deepseek-ai/dsh-settings` 的 `installSettingsSection`，注册 `dsh-memory` 设置命名空间；cordis.patch.yml `config:` 作 base，settings.yaml 覆盖，`setSource` 实时生效；
- **client 半区**（`client/` 目录，独立包 `dsh-memory-client`）：声明 `dsh.client` + `exports['./client']`，DSH 前端自动加载手写 bundle，通过 `ctx.slots.inject('settings.general.item')` 在设置 → 通用设置 → 记忆 注册配置行；无 client 半区时功能不受影响；
- **漏网会话检测**：扫描 `~/.dsh/sessions/` 下久未交互（> staleSessionDays 天）且未落档的会话注入提醒；内容导向去重，同实例只提醒一次；
- **定期自动整合**（integrateEnabled，默认关闭）：以插件安装时间为起始，每 7 天整合一次全部记忆，触发后刷新缓存；
- **漏网归档根治 token 爆炸**：插件先提取每个会话的对话消息流（过滤注入/工具噪音，8000 字符截断），再以仿真级 compact（DSH 官方同款 8 节指令）让子代理产出检查点落盘；
- **启用界限**：会话最后交互时间 < enabledAt 则跳过；enabledAt 由禁用→启用时刷新（与 DSH 启动解耦）；
- **性能与可观测**：sessions 索引启动缓存 + 写入后刷新；控制台输出统一时间戳（`[HH:MM:SS] [dsh-memory]`）。

### v1.2.0（2026-08-18 · 压缩检查点自动落盘）

- 宿主插件用 `node:fs` **直写**压缩检查点摘要到 `sessions/今日.md`（真实 Node 环境，绕过 ctx.fs 沙箱）；
- 不依赖模型回合：压缩后会话立即结束也不丢摘要；
- 幂等去重：带 `compactionId` 标记，重复触发/插件重启不重复追加；
- 提醒制降级为 fallback：直写失败才注入 system-reminder 由模型执行；
- 零上下文成本：直写成功时不注入摘要文本。

### v1.1.0（2026-08-18 · 检索质量升级）

- **memory_search 全面升级**（参考 MiMo-Code 记忆模块移植）：
  - Unicode 分词 + OR 匹配：中英文混合词拆词（"OA日志"→["OA","日志"]）；
  - 中文分段策略：1 字保留 / 2 字补单字 / 3+ 字完整段 + 首尾 2 字；
  - 索引正则放宽：收录 `tools/*.md` 记忆文件 + 中文文件名支持；
  - 多命中合并 top 8：TF 加权评分 + 相关度排序 + 相对下限（top×0.15）+ 绝对下限（0.6）；
  - 精确文件名查询返回全文（保留 v8 行为）；0 结果输出升级引导；
  - 过期复核提醒：解析知识文件头"最后更新"日期，>180 天未更新注入人工复核提醒。

### v1.0.0（2026-08-18 · 首个发布）

- 会话开始注入记忆（稳定层 + 最近摘要）；
- memory_search 检索工具（主题索引 + 全文关键词搜索）；
- 压缩检查点归档、备份 / 轮转提醒（当时为插件零写入，全部提醒制；v1.2.0 起压缩检查点改为 node:fs 直写）；
- 双轨超限治理（软字节阈值 + 硬字符预算）；
- 多会话去重、compact 记忆刷新、session/event 重入修复；
- 路径可移植：homedir() + 环境变量（DSH_HOME / DSH_MEMORY_ROOT / DSH_MEMORY_BACKUP_ROOT）。

## 许可证

MIT License
