// v2.4.31（2026-09-07 合并维护「字数打转」根治，用户拍板）：真机 2026-09-07 16:51 maint-slim 精简轮 15 分钟
// 硬停 abort（LLM 数不清混合中文字符，被逼「精确 ≤1100/1320」→ 来回数 → 空转烧 token）。根因=三处提示词把
// 「精确字数达标」责任推给模型且无「禁止数数」安抚（对照意图检查点 L4044 早已有 v2.4.28 同款口径）；且输入
// 字面量密集时（当日 beforeChars 3690~4449）压缩进 1320 内数学上不可能——「保留全部字面量」硬约束赢过
// 1100 软预算，任务无解模型才会打转。修复（用户拍板 09-07）：
//   ① 主轮/slim 轮提示词卸责式改写——**绝对禁止手工数数字符**，长度由插件机器测量并自动判定处理
//     （超限走精简或直接注入，无需模型对齐任何数字）；结构锚（三节约 25~35 行 / 关键结论每条一句话）替代字符阈；
//     字面量优先：「因必保字面量导致超限是预期」，输出最干练版本即可；
//   ② slim 轮改相对删减——目测删约 1/3（每 3 行删 1 行），一次成型、禁自测/禁反复重写；
//   ③ 允许带 1320→1500（实测输出集中在 1448~1500，压缩不了 ≠ 可裁剪，放水多数直接过，slim 触发大减）；
//   ④ slim 重试 ≤2 轮 + **无进展即停**——机器量相邻轮字符数，缩短 <8% 或变长即判「已尽力/压缩不了」
//     → 立即停止重试走直接注入+埋点（stuck 标记），到达终点最坏 45 分→~8 分（终点=直接注入，用户裁定不变）；
//   ⑤ slim 轮短超时 hard 15→8 分钟 / soft 10→4 分钟（compactOnce 支持 per-call timingOverride，仅 slim 用）。
// 单测/门断言无触碰（文案与常量非断言关键词）。未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）。
// v2.4.31-2（2026-09-07 独立子代理审核补丁，用户拍板）：审核结论 CONDITIONAL——两个 P1 落地：
//   P1-1 防乒乓增长闸（用户选「增长判据」）：成功合并后记录「合并后注入面」基准（maintSuccessBase 落
//     .monitor.json），needMaintenanceMerge 三判据统一前置增长闸——需再增长 ≥15% 才允许再触发同一文件。
//     根治结构性乒乓（实证 09-04 25 分钟 8 次合并、09-07 16:19→16:22→16:29 每 3 分钟连发；/dream 自校准
//     1100→950→750→700→750→800 只调阈值治标不治本——校准上限 1500 与允许带同值配置空间内无法消除）。
//     基准随每次成功收敛更新（maint 成功含 over-budget-inject 直接注入 + 机械收敛）；无基准=放行零退化。
//   P1-2 slim abort 回落（直补）：slim 轮 watchdog 硬停（8 分钟）不再回滚整次合并——按 stuck 语义回落
//     「直接注入上一版」+埋点 stuck=abort，不登记失败不退避不熔断（原路径=整次失败→3 次熔断→机械收敛
//     1050 行界截断丢结论，违背用户「压缩不了→直接注入不裁剪」裁定；09-07 16:51 事故即此路径复现）。
//   P2-2：主轮/slim 提示词删光数字锚（「≤1100 字符」「对齐 1100/1500」字样全删），数字彻底交机器。
//   验证：门 + _test-maint-slim.cjs 增 S10（abort 回落）+新 _test-maint-gate.cjs（增长闸/基准）。
// v2.4.30（2026-09-04 E 类「成功同质循环」+ W 类「无介入长空转」看门狗，用户拍板 + 双评审吸收）：
//   触发背景=用户打包命令循环重跑 100+ 次全成功，D 类因 negRate=0 正确不触发但用户期望提醒。
//   核心改动：① spiralObserve 返回布尔 → {d,e} 并列计算（架构 P0：旧 D 命中提前 return 吞 E）+ 簇内同质口径 E 判定
//   （簇=与当前步 args dice≥sim 的连续步；sameNeg/sameSteps/sameMinSecs/sameHomo）；② 窗元素补 ts + resKeyFp
//   （resKey 原文保留保 batchLike/D 语义，架构 P0 Q3）；③ W 看门狗不依赖同质，只算用户回合后步数+墙钟
//   （pre-step step1 复位 lastUserAt/stepsSinceUser，spiralBucket 桶扩展；watchEvents 独立数组）；④ D/E/W 阈值全部并入
//   spiralThresh 覆盖层 + dsh_spiral_thresh 钳制（+7 字段）+ /dream 校准节分流（D 无 kind 兼容）；⑤ 面板/OV 同步
//   （hints.E/W、样本 kind 列、watchEvents、阈值卡 +7；_stats_src.html 先对齐基线再改）；⑥ 文件头注释 + 门/单测更新。
//   未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）。
// v2.4.30（补，2026-09-04 topic-lost 口径修复，方案 A 用户拍板）：分格文件合并维护连 3 次 topic-lost 假阳性
//   → 熔断机械收敛（实证 2026-09-04 今日文件 3ab5ce7d intent 在项目格内）。根因=v0.5 step4b 分格改造漏改校验口径：
//   写回（mergeIntoGeneralBlock）项目格原样保留、不依赖子代理输出覆盖，但 checkTopicCoverage 仍整文件校验
//   （含项目格 intent 锚点）→ 子代理遵守任务书「压缩合并只出三节」必丢项目格 UUID → 假阳性拦截。修复=新增
//   stripProjectBlocksForCoverage（parseDailySections 剥 project 段），L4370/L4407 两处校验输入改 coverageInput；
//   未分格原样零退化；prompt 仍喂全量供参考。单测 _test-topiclost-fix.cjs 8/0。运行处 sha 0B9EBBE6（前备份
//   pre-ewclass-20260904131438 / pre-topiclostfix-20260904135639）。
// v2.4.29（2026-09-03 会话压缩点注入文案降权，用户拍板）：【上次会话摘要】标题改【最近一次会话压缩点】，
//   正文加「以下为历史记忆背景，非当前任务指令」边界，剥离「衔接下一步/衔接上次的下一步行动」命令式措辞——
//   防历史摘要压过用户新任务意图（模型易把紧跟系统边界的 system-reminder 当高权重指令，真机 4e9d358b 实证）。
//   4 处注入模板（L5542/5545/5551/5557）+ 顶部 F1 注释同步；门脚本 _gate-plugin-load.cjs 4 处断言、
//   单测 _test-inject-dedup.cjs isSummary 哨兵同步新文案。备份 pre-v2429-20260903224833。未 bump（沿用 2.4.24 惯例）。
// v2.4.10（2026-08-31 intent 与 maint 并发写回竞态根治，用户拍板）：compact 路径 4190/4198 先后 spawn
// intent 检查点与合并维护两个子代理，INTENT_RUNNING/MAINT_RUNNING 是两把独立忙锁——注释只错开了「发起」没挡住
// 「并发运行」：双方各持子代理启动前的当日 md 快照，都是整文件重建式写回（intent=新块+strip(旧快照)；
// maint=当日要点+dumps(旧快照)），任一后写都会把对方成果整体覆盖。交错两模式：
//   1) intent 先落盘、maint 后落盘 → 新 intent 检查点整块丢失（同 compactionId 不重发，真丢）；
//   2) maint 先落盘、intent 后落盘 → maint 合并成果被回滚（旧 intent 块复活、旧要点全回来），注入面重新膨胀。
// v2.4.9 的 topic-lost/readbackVerify 都拦不住——两者是单写者视角，只验「我要写的是否写对」，不感知对方并发写入。
// 修复=双向互斥（用户拍板）：intent 启动时 MAINT_RUNNING → 入 INTENT_PENDING 排队（intent 不可丢，必须排队）；
// maint 启动时 INTENT_RUNNING → return false 跳过本轮（maint 不依赖宿主摘要，晚收敛无害，下轮自然再触发）；
// maint finally 补火被挡的 INTENT_PENDING（复用既有 1-slot 队列+setTimeout(0) 机制）。另修机械收敛自锁：
// mechanicalConverge 旧守卫 `MAINT_FUSED || MAINT_RUNNING` 中 MAINT_RUNNING 在唯一调用点（熔断分支，恒在
// runMaintenanceMerge try/finally 内）必为 true → v2.4.5 的熔断机械收敛兜底自引入起从未生效；去掉该条件
// （互斥后调用点 INTENT_RUNNING 恒 false，全同步写盘安全）。版本保持 2.4.0（未发布修复，定版并号）。
// v2.4.9（2026-08-31 合并维护「主题覆盖校验」+「落盘回读校验」，实证驱动）：真机 b76ddcb5（压缩-maint-2026-08-31 22:49）
// 合并子代理只复述 intent 检查点（87a8bb3f 输出）、整块丢弃「当日要点」里的记忆插件 v2.4.8/对账主题——格式头+长度
// 均合规，旧护栏静默接受 → 覆盖式写回把 sessions/2026-08-31.md 顶部实时块换成单一原型主题，记忆插件待办
// （重启验证 v2.4.8/登记 v2.4.4/对账）从注入面消失（仅残存 compaction dump）。修复：
//   - checkTopicCoverage：输入按主题块切分（intent 块/当日要点块/自动检查点块），每块提取强锚点
//     （hex+数字混合 token/完整 UUID/16+位 hex/版本号/路径/反引号命令/$变量/日期/长数字），输出须命中每块 ≥1 锚点，
//     否则 topic-lost → malformed → v2.4.5 退避重试（≤3 次）→ 熔断机械收敛兜底；弱块（无锚点）不硬校验；
//   - readbackVerify：maint 与 intent 两处 writeFileSync 后立即读回全文比对（尾部空白容忍），
//     防 OneDrive 占位/静默截断（2026-08-31 踩坑清单），不一致仅告警不阻塞（dump 资产仍在下次重合并）。
// 版本保持 2.4.0（未发布修复，定版并号）。
// v2.4.8（2026-08-31 修复「全新会话收到变更通知」，方案 B used 闸，用户拍板）：真机 5a5d53fc（行政监督平台·评标办法任务）
//  实证——会话 14:14 startup 全量注入已记账 → 6 小时无真实回合 → 20:09:53 恢复时插件按「历史快照 t=14:14」判定摘要 16:45 归档变过
//  → notice 档发「记忆库更新通知」，而用户视角这是全新会话（从未发言），违反「变更通知只针对历史会话」设计语义。
//  root cause=账本只有【注入过】没有【真实使用过】：startup 注入即记账，恢复判定把「注入过快照」当「历史会话」。
//  方案 B：记账条目加 used 标志（=该会话是否出现过真实用户回合，pre-step step===1 顶层会话置位）；
//  判定处 snap.used===false（startup 注入过但从未发言）→ 强制 silent（不重注、不发变更通知）；存量旧条目 used 缺失
//  → resolveInjectUsedOnce 惰性按日志补算（turn/start 或 user/message source.kind=user），一次性升级账本。
//  效果：新会话在首个真实回合前任何恢复都静默；首个回合后 used=true 恢复正常三档。版本保持 2.4.0（未发布修复，定版并号）。
// v2.4.5（2026-08-31 合并维护失败重试机制，用户拍板）：真机 maint-2026-08-31 子代理被中断（Error: agent.aborted），
//  fire-and-forget 该次触发作废——compact 路径尤其致命（同会话短期不再 compact，当日文件过夜无人收敛）。
//  新增 MAINT_RETRY 状态机：失败登记（no-subagents/no-output/malformed/aborted/error/max-tokens/refusal 等
//  reason 全埋点 monitorEvent）+ 退避阶梯 2m→10m→30m + 当日 3 次熔断；pre-step 与 compact 两调用点前置
//  maintRetryAllow 闸门消费，零新增定时器；成功落盘清零；跨日作废归人工提醒轨道。compactOnce 对维护标签
//  透传 stopReason（__maintFail），使 aborted/error 可区分记档。版本保持 2.4.0（未发布修复，定版并号）。
// v2.4.4（2026-08-31 超限提醒口径对齐 + intent 常驻根因，A+B 档，用户拍板）：用户指出「超阈值已自动发起子代理，
//  提醒内容该调整」。真机核对 2026-08-31.md：真实要点面 646 字符（strip dumps+剥 intent），但 3 个 intent 检查点块
//  （~2680 字符，v2.3.8 常驻上限）把旧口径计数撑到 3526 → 超限提醒误报「硬超 1500、注入截断」且永远不触发合并。
//  A=checkSizeOverflow 的 summary 计数改剥 intent 块（与合并触发同源）+ isToday 标记，文案按「当日自动收敛（无需手动）
//  /非当日与 global/index 人工精简」分流；B=needMaintenanceMerge 加 intent 撑爆兜底——有 intent 块且（含 intent 注入面
//  ≥1500 且剥 intent 面 <1500）即触发合并吸收，治「真实要点面很小、3 块 intent 撑爆注入且永不合并」的病理
//  （intent 块很小只共存不触发，F3 语义保全）；合并后 intent 清零，与旧条件互斥、无乒乓。版本保持 2.4.0（未发布修复）。
// v2.4.3（2026-08-30 合并维护触发口径修复，方案 B，用户拍板）：真机 maint-2026-08-30 反复复触发（19:20→19:46）根因=
//  intent 检查点块（每次 compact 必写 ~1000 字，strip 不剥、全入触发计数）与合并上限 1100 叠加恒超阈值 1200 →
//  「合并→compact 写 intent→又超→又合并」ping-pong。修复：injectedCharsOf 计数改「strip dumps 后再剥 intent 块」
//  （新增 stripIntentBlocksForCount，边界比 stripOldIntentBlocks 严格——后者块定义会把「## 当日要点」吞进 intent 块，不可复用）；
//  阈值 1200→1500 与注入端硬预算 CHAR_LIMIT.summary 同源对齐（要点面装满注入窗口才压缩）。余量 1500−1100≈400 字
//  ≈1-2 条会话收尾摘要合并一次；合并输出上限 1100 不动。版本保持 2.4.0（未发布修复，定版并号）。
// v2.4.2（2026-08-30 当日 md 注入面自动合并维护）：痛点=日常会话 md 检查点只增不减、超限无合适时机压缩（旧维护提醒挂
//  session-start 单例+恢复不重发，基本不触发）。方案=合并进 compact 子代理（对标 mimocode）：MAINT_MERGE_INSTRUCTION 压缩合并
//  旧要点（三节 ≤1100 字、保字面量）+ runMaintenanceMerge 覆盖式写回（保留 compaction dump 资产）；阈值 1200 字符=天然节流
//  （合并后 ~100 自然停，无时间冷却——用户拍板）；触发源双兜底=compact 事件 + pre-step step1 用户消息（治"从不 compact"）；
//  摘要预算 16000→20000。备份 index.js.pre-maintmerge-*.bak.js。
// v2.4.1（2026-08-30 注入时机修复）：A 类提醒从「agent.inject → next-step 队列（下一 step/回合才送达）」改「pre-step 决策直入当轮请求」——
//  单步回合（纯文本答）旧实现提示必滞后一轮（用户实证：品牌推荐性问答的提示在回答之后才出现，还诱发多余"这条提示无关"回合）；
//  新实现改写 PreStepDecision.enter.messages 追加 hint，提示与用户消息同轮到达；无 inbox/session 变更 → 不触发重入（v10.5 setTimeout 约束不适用）；
//  长前缀不变、仅当轮尾部 +~150 token，前缀缓存零影响；reject 决策透传不注入。版本号保持 2.4.0（未发布修复，下次定版并号）。
// v2.4.0 定版对外（2026-08-30）：合并 v2.3.3~v2.3.8 六个内部增量——整合候选纯 hash 账本 / smartTrim 分节水填+归档全文+召回把手 /
//  记录器输入 16000 全文直喂 / 检查点预算治理 L1-L3 / 多主会话竞态根治 F1-F4；版本号四处（index.js/version.txt/package.json/client 注释）对齐。
// v2.3.8 多主会话竞态根治（真机 intent-756123d9 事故复盘：正确剪贴板检查点 898 字被丢弃、落盘 marker×内容错位配对）：
//  - F1 注入守卫：稳定层/摘要注入与 A 类提醒改仅顶层会话——子代理收到【最近一次会话压缩点】触发 ghost 第二轮，run.result 拿到跑题输出覆盖正解（55005cd4 转写实证）
//  - F2 忙不吞事件：INTENT_RUNNING 时由「跳过」改 1-slot-per-id 队列，settle 后按序补火（29692b0d 重放事件被吞的根治）
//  - F3 intent 块按母会话分位：marker 加 sid:<8字>，strip 只替换同 sid 旧块、全局保最近 3 块——跨会话互相挤占+幂等标记被删致重炒双根治
//  - F4 格式护栏：sum 不以「## 本次目标」开头则拒写并埋点 malformed（防再吃跑题输出）
// v2.3.7 预算治理三层（用户追问「改措辞+硬截是不是偷懒」后重设计，对标 mimocode renderSectionBudgets/readBudgetedSectionAware/checkpoint-retry 观察项）：
//  - L1 任务书：废笼统「总长≤800」（模型数不清字符，实测 1132 超纲），改分节具体预算：本次目标≤120/下一步≤200/关键结论≤4条×≤140，超限删关键结论尾部整条（宁缺毋断）
//  - L2 写侧硬护栏：sum>1000 时只从「## 关键结论」尾部整行删除至 ≤1000，绝不断句、前两节永不删，monitorEvent("intent","overshoot")埋点攒超纲率数据（够高再上重试轮）
//  - L3 注入端解耦：摘要注入裸 slice(0,1500) → 既有 sectionAwareSlice（v1.12.0 造好未上膛的枪）——检查点超纲的代价不再转嫁为挤爆当日摘要；离线白盒实证：同预算下当日节 100% 幸存
// v2.3.6 修正：意图记录器输入 3500→16000（与归档上限对齐）——真实宿主摘要 5681~14087 字全在预算内=全文直喂；
//  - v2.3.5 分节水位仍只喂 21%（2996/14087），长节中段条目（Files 中部路径、KeyTech 后段结论）仍不可见；
//  - 全文直喂每次压缩 +~4K token（<20% 压缩事件自身成本），换来「能召回的必已喂入」不变量；>16000 极端件才走水位+归档把手。
// v2.3.5 升级：smartTrim 改「分节水位分配」（对标 mimocode readBudgetedSectionAware）——真实 14087 字宿主摘要实测：头尾字符截仍丢
//  - Current Work/Optional Next Step 全部（尾部被末节 Critical Context 占满）；分节水位后三关键节 100%，长节头62%+尾38%节内取文，实喂 2996 字
//  - 直写归档升为全文（预算 16000，超限才截）——归档即 memory_search 召回把手（mimocode「full body at file」同款）；截断标记内嵌归档指针
//  - stripCompactionDumps 边界规则升级：dump 块内英文 H2 一律吞为正文（旧规则只认两节名，全文归档后会把 ## Files/## Errors 漏进注入）
// v2.3.4 修复：宿主压缩摘要喂给「意图检查点/直写归档」时从头截断（slice(0,N)）把最可续接的尾部段整段丢弃
//  - 实证：意图记录器输入在 2000 字符处断在 `sourceEventSeq 半 token，本次会话根因发现/修复状态全部未达记录器，检查点退化为上轮检查点复读
//  - 新增 smartTrim 头+尾拼接截断：意图输入 2000→3000、直写归档 1500→2400、回退提醒 1500；中段省略标字符数、按行界对齐
//  - 意图输出纪律 600→800 字符（注入头部预算 1500 不变，块头+800 仍可存活头部截断）
// v2.2.11 新增：memory_search 工具描述补充调用契约（2026-08-27，会话日志实证：25 次相关调用中 5 次直接调用 100% 失败、白费一轮才改 run_code 包裹）
// dsh-memory: 全局自动记忆插件 v1.12.0（v1.12.0: 自动提醒查记忆/查 skill——A/B/C 判据插件化；v1.11.0: /dream 命令 + active 开关 + 整合升级；v1.4.0: 设置界面）
// v2.2.5 修复：memory_search 零命中根因——索引→检索断链三处
//  - ①loadKnowledgeTargets 重写：目录扫描为底座（knowledge/tools/projects/global/index/sessions 近7天），index.md 解析仅作 label 增强；
//    旧实现依赖「- 主题 → 文件.md」单条目行格式，index.md 改紧凑「｜」多段格式+省略 .md 后缀后全线失配，
//    knowledge/ 全部文件退出候选集 → 按索引词搜索必然 0 命中（08-26 实测三个查询全灭）
//  - ②buildMemoryHintTable 同源修复：按｜拆段逐条解析，此前每行只吃到第一个条目且 file 吞脏字符（A 类提醒覆盖面缩水根因）
//  - ③sessions/ 纳入候选集：0 结果引导文案承诺"查会话/sessions"但候选集里根本没有；精确匹配放宽为 basename 带/不带 .md、大小写不敏感
// v2.2.6 新增：检索层启动自检（runRetrievalSelfCheck）——启动 3s 后跑三探针（A表非空无脏/候选集覆盖磁盘实数/索引词抽样搜索对账），
// v2.2.7 新增：记忆库备份自动化（runBackupNow）——node:fs.cpSync 直写替代 v9 提醒制（实测提醒制连续 5 天无人执行）；
// v2.2.8 新增：D 类探针 sim/w 校准观测埋点（档一）——步间最大相似度随窗留存、周期结算 simP50/simP90、
//   spiralEvents 增加 maxSim/winLen/firstRepPos；dream 校准节喂分位数。首日实测已现信号：run_code 同会话调用天然 p50≈0.91，sim=0.7 形同虚设
//   （档二待办：积累 1~2 周分布后，dream 任务书加双条件保守判据 sim/w 自动调整——见 tools/记忆插件.md v2.2.8 小节）
//   到期先自动备份+保留最近 4 份快照，失败才降级为原人工提醒文案——最后一块「可插件化而靠人肉」的拼图收掉
//   结果进监控统计行与 memory_search 零结果提示；「数据源格式漂移→解析方静默失配」从此开机必暴露，不再依赖人记得跑测试或恰好查记忆
// v1.1.0 新增（原 v12）：memory_search 检索质量升级（参考 mimocode MiMo-Code 记忆模块移植）
//  - Unicode 分词 + OR 匹配：修复"OA日志" vs "日志填写"、"智检API" vs "REST API/推送"不命中
//  - loadKnowledgeTargets 正则放宽：收录 tools/*.md（修复 记忆插件.md/dsh.md 永远搜不到）
//  - 多命中合并 top N：不再"命中1个就 return 丢关联"，TF 加权评分 + 相对分数下限（top*0.15）过滤泛词噪音
//  - 0 结果引导文案：换罕见词 → read 直查 → 查 sessions 原文，避免模型误判"没记录过"
//  - 过期复核提醒：解析 knowledge 文件头"最后更新"日期，>180 天未更新注入提醒人工复核（内容级过期，替代不可用的 mtime）
// v11 新增：路径可移植化
//  - 移除硬编码 C:/Users/Starry 绝对路径，改用 homedir() + 环境变量推导：
//    DSH_HOME 默认 <homedir>/.dsh，可用环境变量 DSH_HOME / DSH_MEMORY_ROOT / DSH_MEMORY_BACKUP_ROOT 覆盖。
//  - 便于开源分发：任何用户克隆后按 README 安装即可，无需改代码。
// v10.5 修复：session/event 处理器内同步 agent.inject 导致 "session append cannot reenter" 重入异常
//  - 根因：compaction/summary 的 session.append 在发布窗口（appending=true）内同步派发 session/event；
//    而 agent.inject 会经 Inbox.mutate 同步 append 'agent/inbox/spliced'（dsh-agent/types/inbox.js:149）→ 重入冲突抛异常。
//  - 后果：压缩检查点提醒 + 记忆刷新提示注入失败（archivedCompactionIds 已标记，摘要不重试 → 永久丢失）。
//  - 修复：处理器同步段只做只读校验/组装，所有 agent.inject 推迟到 setTimeout(0)（发布窗口之外）执行。
// v10.4 新增：compact 后轻量记忆刷新提示
//  - compact 是上下文重置点，但记忆注入仍是会话开始快照（agent/session-start 只触发一次，compact 不重发）。
//  - compact 时追加一条轻提示：记忆可能已更新 → 用 memory_search 实时读盘；写入前先读全量避免覆盖他会话改动。
//  - 不做全量重注入：文件多数时候没变，全量重注入浪费 token 且破坏前缀缓存；轻提示成本≈0。
// v10.3 新增：多主会话去重 + 子代理精确判定
//  - 维护提醒（备份/轮转/超限整理）同实例只注入第一个顶层会话（maintenanceInjected 标志）：
//    避免多个主会话并发收到整理指令、并发 edit 同一文件。
//  - 顶层会话判定改查 SessionHeader.origin === 'subagent'（持久化可靠标记），
//    替代 v6 的 rootSessionId（"记第一个"在多主会话/主会话先销毁场景会误判）。
//  - 压缩检查点同样改 origin 判定：多个主会话的压缩摘要都归档（旧逻辑只认第一个）。
// v10.2 新增：超限治理提醒注入会话（软字节阈值 + 硬字符预算 双轨报告）
//  - CHAR_LIMIT 硬预算（global 3000 字符 / index 2000 / 摘要 1500）与 SIZE_WARN 软阈值（4608/4608/4096B）区分：
//    软阈值=该整理了（仅告警不截断），硬预算=超了注入会被 slice 截断（丢内容）。
//  - 超限提醒从 console.warn（模型不可见）改为 agent.inject（末尾，与备份/轮转同机制，不影响稳定层缓存前缀）。
//  - 注入截断处加显式注记 [注：原文 X 字符已截断，完整内容用 memory_search]，避免模型误以为"记忆就这么多"。
// v10.1 新增：index.md 超限阈值 3072B → 4608B（与 global 一致，对齐注入预算，降告警噪音）
// v10 新增：知识库自包含 —— 21 个 MEMORY-*.md 从 mimocode 目录复制到 ~/.dsh/memory/knowledge/，
//   KNOWLEDGE_ROOT 改指向 knowledge/；备份命令 Copy-Item ~/.dsh/memory/* -Recurse 即含知识库，与 mimocode 解耦。
// v9 新增：插件零写入
//  - 原因：插件 ctx.fs 走部署默认沙箱（workspace-write），写 ~/.dsh 被拒且无审批通道；审批只存在于会话工具层（write/edit/pwsh 升级重试）。
//  - 改造：备份到期 / sessions 轮转 / 压缩归档 都不再直接写文件，改为注入可执行提醒（system-reminder），
//    由会话模型执行写入——沙箱拒绝时带 sandbox_permissions 升级重试，用户点一次审批即可完成（备份=一条 Copy-Item 一次审批）。
// v8 新增：检索增强 + 备份（v9 起备份改为提醒制）
//  - memory_search 动态解析 index.md → 覆盖 21 个知识文件（mimocode/memory/projects/global/），修复索引→检索断链
//  - memory_search 未命中时执行全文关键词搜索（跨文件扫命中行，每文件最多 3 行）
//  - 记忆库自动备份：启动时距上次备份 >7 天则复制 ~/.dsh/memory/ → ~/.dsh/memory_backup/YYYYMMDD_HHMM/（.last 记录时间戳）
// 保留：v5 注入 / v6 压缩即归档 / v7 轮转+超限预警
// v5 修复：
//  - harness 是沙箱全局符号（HOST_BUILTIN_INSPECTION），不是 ctx 服务——直接用全局 harness（官方 skill 姿势）
//  - 摘要读取不依赖 fs.list（返回结构不确定），改为日期文件名直接探测（今天→回溯 7 天）
//  - 注入失败/工具注册失败都打 console.error 日志（沙箱 console 可用）
// v6 新增：压缩即归档（防丢失兜底）
//  - 监听 session/event，捕获 compaction/summary 事件（/compact 或自动压缩都会产生）
//  - 直接取事件自带的摘要文本（LLM 已生成，零额外调用成本），追加写入 sessions/今日.md 的"自动检查点"小节
//  - 只处理主会话（session-start 时记录 session.id，排除子代理压缩噪音）
//  - 同一 compactionId 只归档一次；手动摘要优先（只追加、不覆盖）
// v7 新增：记忆文件治理
//  - sessions/ 轮转：插件启动时把超过 30 天的日期摘要复制到 sessions/archive/（写文件自动建目录）并清空原文件
//  - 超限预警：注入时按 UTF-8 字节数检查（TextEncoder，沙箱无 Buffer），超阈值打 console.warn 提醒整理
// 能力：会话开始注入记忆（稳定层+动态层）、注册 memory_search 工具、压缩即归档、文件治理
// v2.2.9 新增：B/C 类提醒事件携带错误签名（sig，60 字符截断）——补齐「哪类错误最常重复触发提醒」的离线分析数据

// v11：可移植路径推导（开源分发友好）
//  - 优先级：环境变量 > <homedir>/.dsh 默认值
//  - Windows/Unix 通用：homedir() 跨平台；路径统一正斜杠（ctx.fs 可解析）
import { homedir } from "node:os";
import path from "node:path";
// v1.2.0：node:fs 直写压缩检查点（宿主插件真实 Node 环境，绕过 ctx.fs 沙箱，无需审批）
import fs from "node:fs";
// v2.3.4：内容 hash 账本（dream 整合候选判定）——sha256 比对替代 mtime/全量轮
import { createHash } from "node:crypto";
// v1.8.0：node:zlib 原生 zstd 解压（Node 22.17+/23.3+）——漏网归档改为「提取会话 compaction 摘要」，子代理不读原始大日志
import zlib from "node:zlib";
// v2.0.9(M3): zstd 能力守卫——Node<22.17 无 zlib.zstdDecompressSync，消息流提取必失败，
// silent 模式会走 skippedNoFlow 照常消号=批量静默丢失；探测失败则 silent 强制降级 remind（只提醒不消号）。
const ZSTD_OK = typeof zlib.zstdDecompressSync === "function";
// v1.4.0：官方设置机制（settings.yaml 命名空间，设置 UI 可改；cordis.patch.yml config 作 base 默认层）
//  - installSettingsSection: 把插件配置注册为 settings 命名空间（用户文档覆盖 base）
//  - schemastery z: DSH 配置 schema 标准（与 dsh-web-app 同源）
// v2.4.4（热修回同步）：npm-build dsh-settings 只导出 SettingsConflictError/SettingsProvider/redactSecrets——
//   settingsNamespace/installSettingsSection 均为源码包符号，npm-build 无此命名导出 → 工作副本 127 行原 import 加载即崩
//   （门 2026-08-31 实证：工作副本 9 FAIL / 运行处 62 PASS）。register 的 namespace 本就是字符串，直传 "dsh-memory"。
import z from "@deepseek-ai/schemastery";

function portable(p) { return String(p).replace(/\\/g, "/"); }

// ═══════════ step0（2026-09-03 按项目分格方案 §5 步0）：写闸基础纯函数 ═══════════
// 本项目仅新增、不接线（接入是步1/2 内容闸/账本闸改造），保持零行为变化；单测 _test-writegate.cjs。
// resolveMemoryPath：记忆库相对路径唯一白名单解析——归一化 + 禁 .. + 禁占位符 + 前缀分集。
//   返回 { ok:true, abs } 或 { ok:false, errors[] }；纯函数（不碰 fs），root 由调用方语义决定（默认 MEMORY_ROOT）。
//   参数 opts.scopes：允许的顶层目录数组（默认全量内容树）；opts.rootFiles：允许的根文件（默认 global.md/index.md）。
function resolveMemoryPath(rel, opts) {
  const errors = [];
  const o = opts || {};
  const scopes = Array.isArray(o.scopes) ? o.scopes : ["sessions", "projects", "knowledge", "tools"];
  const rootFiles = Array.isArray(o.rootFiles) ? o.rootFiles : ["global.md", "index.md"];
  let r = String(rel || "").replace(/\\/g, "/").trim();
  r = r.replace(/^~\/(\.dsh\/)?memory\//, "").replace(/^\.\//, "").trim();
  if (!r) { errors.push("file 为空"); return { ok: false, errors }; }
  if (/[<>《》]/.test(r)) { errors.push("file 含占位符: " + r); return { ok: false, errors }; }
  if (r.split("/").includes("..") || r.includes("..")) { errors.push("file 越界（含 ..）: " + r); return { ok: false, errors }; }
  const top = r.split("/")[0];
  const isRootFile = rootFiles.includes(r);
  if (!isRootFile && !scopes.some((s) => r === s || r.startsWith(s + "/"))) {
    errors.push("file 越界（只允许 " + scopes.join("|") + "/ 或 " + rootFiles.join("|") + "）: " + r);
    return { ok: false, errors };
  }
  return { ok: true, abs: portable((o.root || MEMORY_ROOT) + "/" + r), rel: r };
}
// writeFileAtomic：tmp+rename 原子写（附 mkdir）——多账本/内容写盘统一入口（步1/2 接入替换手工 tmp+rename）。
//   纯函数化：fs 依赖注入默认 node:fs；返回 { ok, readbackOk? }；写入失败抛由调用方处理（保持与现调用点语义一致）。
function writeFileAtomic(targetFull, content, opts) {
  const o = opts || {};
  const fsx = o.fs || fs;
  const abs = portable(String(targetFull));
  const dir = abs.slice(0, Math.max(abs.lastIndexOf("/"), 0));
  if (dir) fsx.mkdirSync(dir, { recursive: true });
  const tmp = abs + ".tmp" + (o.tag ? "-" + o.tag : "") + Date.now();
  fsx.writeFileSync(tmp, content, "utf8");
  try { fsx.renameSync(tmp, abs); } catch (e) { try { fsx.unlinkSync(tmp); } catch (e2) {} throw e; }
  if (!o.verify) return { ok: true };
  let back = "";
  try { back = fsx.readFileSync(abs, "utf8"); } catch (e) { return { ok: true, readbackOk: false }; }
  return { ok: true, readbackOk: back && back.trimEnd() === String(content).trimEnd() };
}
// assertMemoryWrite（step2 内容闸，2026-09-03）：5 个内容写入口统一公共校验——路径白名单(resolveMemoryPath)
//   + 归档日期窗口 + 写入结构校验（须在 register 前定义且只依赖 step0 纯函数/validateMdStructure 注册后调用，
//   故本函数为「外挂组合式」：接收已解析 rel/abs，返回错误清单；各入口的独占校验（A5/幂等/action/topic-coverage）保留）。
// 用 resolveMemoryPath 保路径白名单；opts.dateWindow 启用组装 sessions/YYYY-MM-DD.md 日期窗口（对齐 L3165 口径 [今-7,今+1]）
function assertMemoryWrite(rel, content, opts) {
  const o = opts || {};
  const errors = [];
  const px = resolveMemoryPath(rel, o.pathOpts || {});
  if (!px.ok) { for (const e of px.errors) errors.push(e); return { ok: false, errors }; }
  if (o.dateWindow && /^sessions\/(\d{4}-\d{2}-\d{2})\.md$/.test(px.rel)) {
    const _m = px.rel.match(/^sessions\/(\d{4}-\d{2}-\d{2})\.md$/);
    const _dt = new Date(_m[1] + "T00:00:00");
    const _lo = new Date(); _lo.setDate(_lo.getDate() - 7);
    const _hi = new Date(); _hi.setDate(_hi.getDate() + 1);
    if (_dt < _lo || _dt > _hi) errors.push("file 日期越出窗口 [今天-7天, 今天+1天]: " + px.rel);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, abs: px.abs, rel: px.rel };
}

const DSH_HOME = portable(process.env.DSH_HOME || path.join(homedir(), ".dsh"));
const MEMORY_ROOT = portable(process.env.DSH_MEMORY_ROOT || path.join(DSH_HOME, "memory"));
const PLUGIN_NAME = "dsh-memory";
// v8：知识库根目录（index.md 索引指向的 21 个主题文件）
// v10：知识库迁入 MEMORY_ROOT/knowledge/（自包含，备份完整；与 mimocode 解耦）
const KNOWLEDGE_ROOT = MEMORY_ROOT + "/knowledge";
// v8：备份目录与间隔（7 天）
const BACKUP_ROOT = portable(process.env.DSH_MEMORY_BACKUP_ROOT || path.join(DSH_HOME, "memory_backup"));
const BACKUP_INTERVAL_MS = 7 * 24 * 3600 * 1000;
const BACKUP_KEEP = 4;   // v2.2.7: 快照保留份数（7 天间隔 × 4 ≈ 覆盖一个月，防 memory_backup 无限膨胀）
// v11：维护提醒中的 PowerShell 命令需要 Windows 反斜杠路径（由正斜杠常量转换）
const PS_MEMORY = MEMORY_ROOT.replace(/\//g, "\\");
const PS_BACKUP = BACKUP_ROOT.replace(/\//g, "\\");

// v2.3.0：插件版本号——与仓库 package.json / version.txt 同步；升级检查以此比对远端版本
const PLUGIN_VERSION = "2.5.4";   // v2.5.4：/dream 卡顿+「无参数」残留修复——(A) 去 input.hint 走 bare 即时清空；(B) runDreamPipeline 后台化（同步段仅互斥+占位，归档→整合 fire-and-forget，「已发起」经 notice 落表）；(C) findStaleSessions 60s TTL 缓存+dream force 重扫（cutoff 入键）（四处对齐 index.js/package.json/version.txt/docs/CHANGELOG.md）；发版时与线上 version.txt 同步防 compareVersions 误报可升级
// 远端发布基址（安装/升级命令同源）；DSH_MEMORY_RAW 可指向内网镜像
const RAW_BASE_DEFAULT = "https://raw.githubusercontent.com/Starry0214/dsh-memory/main";

// ===========================================================================
// v2.3.0 新增：新装用户「记忆初始化」引导 + 插件「升级检查」
// 本区函数一律纯函数化：不读模块全局、不碰宿主 API，fs / now / fetch 全部由参数
// 注入——因此 test/onboard.unit.test.mjs 可以按下面的 marker 把整区切出来 eval 验证
// （与 test/patch-merge.tests.ps1 抽取安装脚本合并逻辑同一套路）。
// >>> ONBOARD BEGIN

const ONBOARD_MIN_CONTENT_BYTES = 120;   // global.md+index.md 合计低于此 = 还没真正落过内容
const ONBOARD_DAY_MS = 86400000;         // 提醒节流粒度：一天一次
const UPDATE_URL_DEFAULT = "https://raw.githubusercontent.com/Starry0214/dsh-memory/main/version.txt";
const UPDATE_PS_CMD_DEFAULT = "irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex";
const UPDATE_TIMEOUT_MS = 4000;          // 远端版本检查超时：内网/离线用户 4 秒内放弃，静默不影响启动
const UPDATE_VERSION_RE = /([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;

// 记忆库状态判定（只读）。status：
//   uninitialized = 基本是空的（新用户，需要引导初始化）
//   partial       = 有内容但缺骨架/缺一半（老用户手工搬来的库，也提示一次）
//   ready         = 就绪，不再打扰
function detectMemoryState(fsish, root) {
  const out = { status: "ready", bytesGlobal: 0, bytesIndex: 0, missingDirs: [], hasAgents: false, agentsPath: "" };
  const sizeOf = (rel) => {
    try {
      const p = root + "/" + rel;
      if (!fsish.existsSync(p)) return 0;
      const st = fsish.statSync(p);
      return (st && st.isFile && st.isFile()) ? Number(st.size) || 0 : 0;
    } catch (e) { return 0; }
  };
  const exists = (p) => { try { return !!fsish.existsSync(p); } catch (e) { return false; } };
  for (const d of ["sessions", "projects", "tools", "knowledge"]) {
    if (!exists(root + "/" + d)) out.missingDirs.push(d);
  }
  out.bytesGlobal = sizeOf("global.md");
  out.bytesIndex = sizeOf("index.md");
  // AGENTS.md 是读写协议的载体（在 memory 根的同级，即 ~/.dsh/AGENTS.md）
  const home = /[\\/]memory$/.test(root) ? root.replace(/[\\/]memory$/, "") : root;
  out.agentsPath = home + "/AGENTS.md";
  out.hasAgents = exists(out.agentsPath);
  const total = out.bytesGlobal + out.bytesIndex;
  if (total < ONBOARD_MIN_CONTENT_BYTES) out.status = "uninitialized";
  else if (out.bytesGlobal < ONBOARD_MIN_CONTENT_BYTES || out.bytesIndex < 20 || out.missingDirs.length > 0 || !out.hasAgents) out.status = "partial";
  return out;
}

// 建目录骨架：只建目录，绝不写内容（内容归模型/用户，且写入要走会话层审批）
function ensureMemorySkeleton(fsish, root) {
  const made = [];
  for (const d of ["", "sessions", "projects", "tools", "knowledge"]) {
    const p = d ? root + "/" + d : root;
    try {
      if (!fsish.existsSync(p)) { fsish.mkdirSync(p, { recursive: true }); made.push(d || "."); }
    } catch (e) { /* 建目录失败不影响主功能，下次启动再试 */ }
  }
  return made;
}

// 版本号逐段数字比较："2.3.0" < "2.10.1"；预发布/构建后缀按分隔符切开只取数字段
function versionParts(v) {
  return String(v === null || v === undefined ? "" : v)
    .trim().replace(/^v/i, "")
    .split(/[.\-_+]/)
    .map((seg) => { const n = parseInt(seg, 10); return Number.isFinite(n) && n >= 0 ? n : 0; });
}
function compareVersions(a, b) {
  const pa = versionParts(a), pb = versionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// 通用节流：snooze 未到期不提；从未提过则提；否则按 intervalMs 一天一次
function shouldRemind(nowMs, lastAtMs, intervalMs, snoozeUntilMs) {
  if (snoozeUntilMs && nowMs < snoozeUntilMs) return false;
  if (!lastAtMs) return true;
  return (nowMs - lastAtMs) >= (intervalMs || ONBOARD_DAY_MS);
}

// 首次初始化引导（注入给模型执行：模型有 ask_user_question 与带审批的写入通道，
// 宿主插件没有——v9「插件零写入」的结论在写内容这件事上依然成立）
function buildInitGuideText(state, info) {
  const root = info.root;
  const L = [];
  L.push("<system-reminder>");
  L.push("【dsh-memory 首次初始化引导】记忆库" + (state.status === "uninitialized" ? "尚未初始化" : "不完整") + "：" + root);
  L.push("（global.md " + state.bytesGlobal + "B · index.md " + state.bytesIndex + "B"
    + (state.missingDirs.length ? " · 缺目录 " + state.missingDirs.join("/") : "")
    + (state.hasAgents ? "" : " · 缺读写协议 AGENTS.md") + "）");
  L.push("");
  L.push("请在**本次会话内**带用户完成初始化（全程约 1 分钟），按下面三步做：");
  L.push("");
  L.push("第 1 步 · 先跟用户说明并征求同意，开场白照这个语气即可：");
  L.push('「检测到你刚装好 dsh-memory，记忆库还是空的。花 1 分钟告诉我几件事，之后每个新我都会自动带着这些信息干活。」');
  L.push("然后用 ask_user_question **一次性**问完（一次调用多个问题，别挤牙膏）：");
  L.push("  1) 称呼 + 单位/岗位（例：张三 / 某某公司 长沙分公司 项目经理）");
  L.push("  2) 主要在做的項目：项目名称 + 编号 + 合同号（**逐字要编号，别只问名字**）");
  L.push("  3) 日常工作（可多选：写文档/汇报材料、故障排查运维、需求推进、自动化脚本、数据分析…）");
  L.push("  4) 关键协作人（姓名 + 职责，2~5 位即可）");
  L.push("  5) 沟通偏好（语言、详略、要不要表格、能不能直接动手）");
  L.push("  6) 环境要点（系统用户名、常用目录、路径是否含中文/空格这类坑）");
  L.push("用户答不上来的项就**留空别编**，并在文末标「待补充」。");
  L.push("");
  L.push("第 2 步 · 落盘（写工具目标在 ~/.dsh 下，被沙箱拒时带 sandbox_permissions + justification 重试一次，用户点审批即可）：");
  L.push("  · " + root + "/global.md   —— 首行 「# 全局记忆」，分节 「## 用户画像」 / 「## 通用偏好」 / 「## 跨项目经验」 / 「## 常用工具与环境」；精确字面量（编号、合同号、路径、接口）逐字保存，绝不概括。");
  L.push("  · " + root + "/index.md    —— 首行 「# 记忆索引」，每条一行 「- 主题 → 文件.md（描述）」；以后新增知识文件都来这里登记一行。");
  L.push("  · 目录 sessions/ projects/ tools/ knowledge/ 插件已自动建好；当日会话摘要写 sessions/YYYY-MM-DD.md。");
  L.push(state.hasAgents
    ? "  · 读写协议已在 " + state.agentsPath + "，按它执行（稳定层只在实质变化时改，避免前缀缓存失效）。"
    : "  · 注意：没有发现读写协议 " + state.agentsPath + "。请复制插件仓库的 AGENTS.template.md 过去（安装脚本会自动做，也可让用户重跑一次安装命令）；没有它，「先查后写、会话结束归档」这些纪律不会注入到新会话。");
  L.push("");
  L.push("第 3 步 · 收尾：告诉用户「已初始化，稳定层从**下一个新会话**开始自动注入（当前会话不会重注入）」，并提示随时可以说「重新初始化记忆」来补充。");
  L.push("");
  L.push("若用户明确说不想现在弄：只写一个最小 global.md（首行 「# 全局记忆」 + 一个 「## 用户画像」 写「（待补充）」），别纠缠；插件 24 小时内不会再提。");
  L.push("</system-reminder>");
  return L.join("\n");
}

// 升级提醒（同样注入给模型转述；升级动作是一行命令，重跑安装脚本即覆盖升级）
function buildUpdateNoticeText(local, remote, info) {
  const L = [];
  L.push("<system-reminder>");
  L.push("【dsh-memory 升级提醒】发现新版本 v" + remote + "（当前已装 v" + local + "）。");
  L.push("请在回复里告诉用户这条升级方式，并强调两点：");
  L.push("  · 升级命令：" + (info.cmd || UPDATE_PS_CMD_DEFAULT));
  L.push("    （安装脚本已可重复执行：会覆盖 index.js 并按形态合并 cordis.patch.yml，不会写坏配置，改前有 .bak 备份）");
  L.push("  · 升级后**必须重启 DSH** 才生效（宿主插件无热加载）。");
  L.push("用户若不想再被打扰：设置 → 通用设置 → 记忆 → 关闭「检查新版」（或把 DSH_MEMORY_RAW 指向内网镜像）。");
  L.push("版本详情：" + (info.url || UPDATE_URL_DEFAULT) + "；更新说明见仓库 README「版本历史」。");
  L.push("</system-reminder>");
  return L.join("\n");
}

// 远端版本拉取（fetch 注入，超时静默失败：离线/内网/被墙一律不影响插件功能）
async function fetchRemoteVersion(deps) {
  const f = deps && deps.fetchish;
  if (typeof f !== "function") return { ok: false, error: "no-fetch" };
  const timeoutMs = (deps.timeoutMs || UPDATE_TIMEOUT_MS);
  let ctrl = null, timer = null;
  try {
    const init = { cache: "no-store" };
    if (typeof AbortController === "function") {
      ctrl = new AbortController();
      init.signal = ctrl.signal;
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* 已结束的 abort 忽略 */ } }, timeoutMs);
    }
    const res = await f(deps.url, init);
    if (!res || !res.ok) return { ok: false, error: "http-" + ((res && res.status) || "?") };
    const body = String(typeof res.text === "function" ? await res.text() : "");
    const m = body.match(UPDATE_VERSION_RE);
    if (!m) return { ok: false, error: "bad-body" };
    return { ok: true, remote: m[1] };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || e)));
    return { ok: false, error: aborted ? "timeout" : String((e && e.message) || e).slice(0, 80) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}


// 首次引导 / 升级提醒的持久状态（默认值；落盘在 memory/.onboard.json）
function defaultOnboardState() {
  return {
    initPromptedAt: 0,        // 上次注入初始化引导的时间（一天节流）
    snoozeUntil: 0,           // 用户说"回头再说" → 这个点之前不再提
    ready: false,             // 曾经达到过 ready（用于"记忆库被清空了"这种异常回退）
    update: { checkedAt: 0, latest: "", notifiedAt: 0, error: "" },
  };
}

// 合并磁盘状态与默认值（老文件缺字段、字段类型漂移都不炸）
function mergeOnboardState(raw) {
  const d = defaultOnboardState();
  if (!raw || typeof raw !== "object") return d;
  if (typeof raw.initPromptedAt === "number") d.initPromptedAt = raw.initPromptedAt;
  if (typeof raw.snoozeUntil === "number") d.snoozeUntil = raw.snoozeUntil;
  if (typeof raw.ready === "boolean") d.ready = raw.ready;
  const u = raw.update && typeof raw.update === "object" ? raw.update : {};
  if (typeof u.checkedAt === "number") d.update.checkedAt = u.checkedAt;
  if (typeof u.latest === "string") d.update.latest = u.latest;
  if (typeof u.notifiedAt === "number") d.update.notifiedAt = u.notifiedAt;
  if (typeof u.error === "string") d.update.error = u.error;
  return d;
}

// 本次会话该提醒什么：初始化引导 / 升级提醒（纯判定，宿主只负责注入与回写）
function decideOnboardActions(memory, ob, nowMs, local) {
  const out = { needGuide: false, guideReason: "", needUpdateNotice: false, updateReason: "", latest: "" };
  if (memory && memory.status && memory.status !== "ready"
      && shouldRemind(nowMs, ob.initPromptedAt, ONBOARD_DAY_MS, ob.snoozeUntil)) {
    out.needGuide = true;
    out.guideReason = memory.status;
  }
  const latest = ob.update && ob.update.latest ? ob.update.latest : "";
  if (latest && compareVersions(local, latest) < 0
      && shouldRemind(nowMs, ob.update.notifiedAt, ONBOARD_DAY_MS, 0)) {
    out.needUpdateNotice = true;
    out.updateReason = local + "->" + latest;
    out.latest = latest;
  }
  return out;
}
// <<< ONBOARD END
// ===========================================================================

// v2.3.0 宿主侧装配：上面是纯逻辑，这里负责读盘状态、定时检查、注入提醒。
const ONBOARD_FILE = MEMORY_ROOT + "/.onboard.json";
let ONBOARD_LAST_MEMORY = null;   // 最近一次记忆库状态（横幅/汇总/工具回显复用，避免每次都扫盘）

function readOnboardState() {
  try {
    return mergeOnboardState(JSON.parse(fs.readFileSync(portable(ONBOARD_FILE), "utf8")));
  } catch (e) { return defaultOnboardState(); }
}

function writeOnboardState(st) {
  try {
    fs.mkdirSync(portable(MEMORY_ROOT), { recursive: true });
    writeFileAtomic(portable(ONBOARD_FILE), JSON.stringify(st, null, 2), { tag: "onboard" });   // v0.5（step1 账本闸）：统一原子写
    return true;
  } catch (e) {
    cwarn("[dsh-memory] 初始化/升级状态写入失败:", e && e.message ? e.message : String(e));
    return false;
  }
}

// 记忆库体检（顺带补齐目录骨架）：结果缓存在 ONBOARD_LAST_MEMORY
function inspectMemory() {
  ensureMemorySkeleton(fs, MEMORY_ROOT);   // 只建目录，不写内容
  ONBOARD_LAST_MEMORY = detectMemoryState(fs, MEMORY_ROOT);
  return ONBOARD_LAST_MEMORY;
}

function updateUrl() {
  const base = (process.env.DSH_MEMORY_RAW || RAW_BASE_DEFAULT).replace(/[\/]+$/, "");
  return base + "/version.txt";
}
function updateCmd() {
  const base = (process.env.DSH_MEMORY_RAW || RAW_BASE_DEFAULT).replace(/[\/]+$/, "");
  return "irm " + base + "/install.ps1 | iex";
}

// 升级检查：每天最多一次；网络失败/超时/被墙一律静默（离线与内网用户不受影响）
async function checkForUpdate(reason) {
  const tag = reason || "启动";
  try {
    if (PLUGIN_CFG.updateCheckEnabled === false) return null;
    const now = Date.now();
    const st = readOnboardState();
    if (!shouldRemind(now, st.update.checkedAt, ONBOARD_DAY_MS, 0)) return null;
    st.update.checkedAt = now;
    const r = await fetchRemoteVersion({ fetchish: typeof fetch === "function" ? fetch : null, url: updateUrl(), timeoutMs: UPDATE_TIMEOUT_MS });
    if (!r.ok) {
      st.update.error = r.error;
      writeOnboardState(st);
      clog("[dsh-memory] 升级检查未完成（" + tag + "：" + r.error + "）——不影响使用，可稍后 /memory-update");
      pushOnboardSummary();
      return null;
    }
    st.update.error = "";
    const had = st.update.latest;
    st.update.latest = r.remote;
    const newer = compareVersions(PLUGIN_VERSION, r.remote) < 0;
    if (!newer) { st.update.notifiedAt = 0; }   // 已是最新：清空提醒位，下次真有新版本能立刻提一次
    writeOnboardState(st);
    if (newer) {
      cwarn("[dsh-memory] 发现新版本 v" + r.remote + "（当前 v" + PLUGIN_VERSION + "）→ 升级：" + updateCmd() + "（之后重启 DSH 生效）");
      monitorEvent("update", "available " + PLUGIN_VERSION + "->" + r.remote);
      if (had !== r.remote) notifyUpdateNow("升级检查");
    } else {
      clog("[dsh-memory] 升级检查（" + tag + "）：已是最新 v" + PLUGIN_VERSION);
    }
    pushOnboardSummary();
    return { latest: r.remote, newer };
  } catch (e) {
    cwarn("[dsh-memory] 升级检查异常:", e && e.message ? e.message : String(e));
    return null;
  }
}

// 有新版就借最近一个顶层会话说一次（宿主无 UI 通道，会话注入是唯一可靠出口）
function notifyUpdateNow(why) {
  try {
    const st = readOnboardState();
    const memory = ONBOARD_LAST_MEMORY || inspectMemory();
    const act = decideOnboardActions({ status: "ready" }, st, Date.now(), PLUGIN_VERSION);
    if (!act.needUpdateNotice) return false;
    const agent = LAST_TOP_AGENT;
    if (!agent || typeof agent.inject !== "function") {
      clog("[dsh-memory] 新版提醒待发送（" + (why || "") + "）：暂无可用会话，下次新会话或 /memory-update 时提示");
      return false;
    }
    const text = buildUpdateNoticeText(PLUGIN_VERSION, act.latest, { cmd: updateCmd(), url: updateUrl() });
    st.update.notifiedAt = Date.now();
    writeOnboardState(st);
    setTimeout(() => { try { agent.inject(makeMessage(text)); } catch (e) { cwarn("[dsh-memory] 新版提醒注入失败:", e && e.message); } }, 0);
    clog("[dsh-memory] 已注入新版提醒 v" + act.latest + "（" + (why || "") + "）");
    return true;
  } catch (e) {
    cwarn("[dsh-memory] notifyUpdateNow 异常:", e && e.message ? e.message : String(e));
    return false;
  }
}

// 新装用户初始化引导：状态非 ready 且未被 snooze → 往本会话注入一段可执行引导
function maybeInjectInitGuide(agent, label) {
  try {
    if (PLUGIN_CFG.initGuideEnabled === false) return null;
    const memory = inspectMemory();
    const st = readOnboardState();
    const act = decideOnboardActions(memory, st, Date.now(), PLUGIN_VERSION);
    if (memory.status === "ready") {
      if (!st.ready) { st.ready = true; writeOnboardState(st); }
      if (!act.needUpdateNotice) return memory;
    }
    if (act.needGuide) {
      const text = buildInitGuideText(memory, { root: MEMORY_ROOT });
      st.initPromptedAt = Date.now();
      writeOnboardState(st);
      setTimeout(() => {
        try { agent.inject(makeMessage(text)); clog("[dsh-memory] 已注入记忆初始化引导（" + act.guideReason + "）[会话: " + label + "]"); }
        catch (e) { cwarn("[dsh-memory] 初始化引导注入失败:", e && e.message ? e.message : String(e)); }
      }, 0);
      monitorEvent("onboard", "guide " + act.guideReason);
    } else if (memory.status !== "ready") {
      clog("[dsh-memory] 记忆库" + (memory.status === "uninitialized" ? "未初始化" : "不完整") + "，但引导在节流/暂缓期内（说「初始化记忆」可立刻重来）");
    }
    if (act.needUpdateNotice) notifyUpdateNow("会话开始");
    pushOnboardSummary();
    return memory;
  } catch (e) {
    cwarn("[dsh-memory] maybeInjectInitGuide 异常:", e && e.message ? e.message : String(e));
    return null;
  }
}

// 强制执行一次初始化引导（/memory-init 与 memory_onboard 工具用）：绕过节流与 snooze
function forceInitGuide(agent, label) {
  const memory = inspectMemory();
  const st = readOnboardState();
  st.initPromptedAt = Date.now();
  st.snoozeUntil = 0;
  writeOnboardState(st);
  const text = buildInitGuideText(memory, { root: MEMORY_ROOT });
  if (agent && typeof agent.inject === "function") {
    setTimeout(() => {
      try { agent.inject(makeMessage(text)); clog("[dsh-memory] 已注入记忆初始化引导（手动：" + memory.status + "）[会话: " + (label || "?") + "]"); }
      catch (e) { cwarn("[dsh-memory] 手动初始化引导注入失败:", e && e.message ? e.message : String(e)); }
    }, 0);
  }
  monitorEvent("onboard", "manual " + memory.status);
  pushOnboardSummary();
  return memory;
}

// 用户说"回头再说"：暂停 N 小时（默认 24）
function snoozeInitGuide(hours) {
  const st = readOnboardState();
  const h = (typeof hours === "number" && isFinite(hours)) ? Math.max(1, Math.min(168, hours)) : 24;
  st.snoozeUntil = Date.now() + h * 3600000;
  writeOnboardState(st);
  monitorEvent("onboard", "snooze " + h + "h");
  pushOnboardSummary();
  return h;
}

// 把版本/初始化状态推到设置界面（只读字段，跟 monitorSummary 同一通道）
function pushOnboardSummary() {
  try {
    if (!HOST_SETTINGS_SCOPE || typeof HOST_SETTINGS_SCOPE.update !== "function") return;
    const line = onboardStatusLine();
    if (line === ONBOARD_LAST_SUMMARY_LINE) return;
    ONBOARD_LAST_SUMMARY_LINE = line;
    Promise.resolve().then(() => HOST_SETTINGS_SCOPE.update({ onboardSummary: line }))
      .catch((e) => cwarn("[dsh-memory] onboardSummary 推送失败:", e && e.message ? e.message : String(e)));
  } catch (e) { /* 界面回显失败不影响功能 */ }
}
let ONBOARD_LAST_SUMMARY_LINE = "";

// 供 /memory-init、/memory-update 与设置页回显用的状态摘要（一行文本）
function onboardStatusLine() {
  const memory = ONBOARD_LAST_MEMORY || inspectMemory();
  const st = readOnboardState();
  const u = st.update;
  const newer = u.latest && compareVersions(PLUGIN_VERSION, u.latest) < 0;
  const memTxt = memory.status === "ready" ? "就绪"
    : memory.status === "uninitialized" ? "未初始化（global " + memory.bytesGlobal + "B/index " + memory.bytesIndex + "B）"
    : "不完整（缺 " + [memory.missingDirs.length ? "目录" : "", memory.hasAgents ? "" : "AGENTS.md"].filter(Boolean).join("+") + "）";
  return "v" + PLUGIN_VERSION + " · 记忆库" + memTxt + " · 版本检查 " + (u.latest ? (newer ? "最新 v" + u.latest + "（可升级）" : "已最新") : (u.error ? "未完成（" + u.error + "）" : "待首次检查"));
}

// ===========================================================================

function makeId() {
  const t = Date.now().toString(16);
  const r1 = Math.floor(Math.random() * 0xffffffff).toString(16);
  const r2 = Math.floor(Math.random() * 0xffffffff).toString(16);
  const h = (t + r1 + r2).replace(/[^0-9a-f]/g, "").slice(0, 32).padEnd(32, "0");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}

function makeMessage(text) {
  return {
    id: makeId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_NAME }
  };
}

// v2.5.1(转播可见性): 可立即落会话流的 notice 消息——source.form="notice" + summary 让 GUI 渲染成
// 「上下文行」（折叠态直接显示 summary 一行），无需唤醒驱动即可见（对照宿主 dsh-tool-jobs/dsh-subagent 的 notice 形态）。
function makeNoticeMessage(text, summary) {
  return {
    id: makeId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_NAME, form: "notice", summary: summary || String(text).slice(0, 120) }
  };
}

// v2.5.1(P3-1): 终态 summary 取 outText.slice(0,200)。模型输出末尾若残留未闭合的 markdown 标记，会被原样
//   透传到 GUI 显示字面 `**`——实证 2026-09-08 真机 summary 以 `**Written file` 结尾（196 字符，未触发截断，
//   是输出本身标记未闭合）。收尾修补：先剔除末尾悬空的标记字符（`*`/`_`/`` ` ``），再补齐未配对的 `**` 与行内代码 `` ` ``。
//   已配对标记经「删尾→补尾」净效果不变（`...**bold**` → 删 `**` → 计数为奇 → 补 `**` → 复原），对正常文本无副作用。
function tidyTruncatedMarkdown(s) {
  let t = String(s == null ? "" : s);
  if (!t) return t;
  t = t.replace(/[\s*_`]+$/, "");
  if (!t) return t;
  if (((t.match(/\*\*/g) || []).length % 2) === 1) t += "**";
  if (((t.match(/`/g) || []).length % 2) === 1) t += "`";
  return t;
}

// v1.10.1：控制台输出统一时间戳（HH:MM:SS）。本文件内 console 调用已批量替换为 clog/cwarn/cerr。
// v1.12.4：pad 提升为模块级（原来只在 ts() 内部，updateMonitorSummary 引用时报 pad is not defined，监控统计推送从未生效）
const pad = (n) => String(n).padStart(2, "0");
const clog = (...a) => console.log(ts(), ...a);
const cwarn = (...a) => console.warn(ts(), ...a);
const cerr = (...a) => console.error(ts(), ...a);
function ts() {
  const d = new Date();
  return "[" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "]";
}

// v1.3.0：漏网会话检测 —— 扫描 ~/.dsh/sessions/ 下久未交互（mtime≥阈值 天）的会话
// v1.6.0：加 afterTime 界限 —— 插件启用前创建的会话不触发整合（用户要求）；
//         插件关闭期间产生的会话（创建时间在启用之后）仍会被检测 → 重新启用后"未整合范围扩大"。
// 判定"漏网"：会话创建于启用之后 + 最后一次写入距今超过阈值 + 未在记忆库落档
const STALE_NOTIFIED = new Set();  // 本实例内已提醒过的会话 id（v1.12.19 起仅防重复注入提醒文案）
const ARCHIVED_SESSIONS = new Set(); // v1.12.19: 归档流程已处置的会话 id（含"验证已覆盖跳过"与无流跳过），持久化 .integrate.json archivedSessions；pending 过滤与 staleCount 收敛以此为准
// v2.4.3（续聊增量重档）：消号从「id 一次性」升级为「轮次水位」——归档后又有新帧的会话重入候选，提取只喂水位后增量
const ARCHIVE_WATERMARK = new Map();   // id → { frames: 消号时总帧数, round: 已归档轮次, at: 时间戳 }，持久化 .integrate.json archiveWatermarks
let ARCHIVE_WM_DIRTY = false;          // 懒置基线产生的脏标记（下次 saveStaleNotified 顺带落盘）
let staleNotifiedLoaded = false;
const SESSIONS_ROOT = portable(path.join(DSH_HOME, "sessions"));

// v1.12.0：自动提醒查记忆/查 skill（判断 A/B/C 插件化）——
// 不靠模型自觉，插件在 pre-step/request-error 事件里量化判断触发条件，命中才注入提醒。
// 关键词表从 index.md 自动提取（零维护）：解析 "名称 → 文件.md（描述）" 行 → 名称+描述词 = 匹配关键词。
let MEMORY_HINT_TABLE = null;            // 懒加载：[{keywords:[...], file:"MEMORY-*.md", domain:"领域名"}]
let MEMORY_HINT_TABLE_MTIME = 0;         // 缓存 index.md 的 mtime，变化才重建
const MEMORY_HINT_THROTTLE = new Map();  // sessionId -> 用户输入序号（每条 +1，v1.12.10 起）
const MEMORY_HINT_LAST_SEQ = new Map();  // v1.12.10: sessionId -> 上次 A 类提醒时的输入序号（冷却闸：距上次 <2 条跳过）
const MEMORY_HINT_SEEN = new Map();      // v1.12.10: sessionId -> Set<file> 已提醒过的记忆文件（领域去重闸）
const MEMORY_HINT_ERRORS = new Map();    // sessionId -> Map<签名, 次数>（B/C 判断）
const MEMORY_HINT_ECHO = new Map();      // v2.2.10: sessionId -> {sig,t} 上次计数回声——同签名 1s 内双结果（内层裸错误+外层包装）只计一次
const MEMORY_HINT_BC_LAST = new Map();   // v2.2.10: sessionId -> {t,sig} 上次 B/C 注入时刻——异签名字段 10 分钟冷却
const HINT_BC_COOLDOWN_MS = 10 * 60000;  // v2.2.10: B/C 冷却窗（同签名升级 B→C 不受限）
const SPIRAL_REMIND_AT = new Map();      // v2.0.6: sessionId -> { ts: 上次注入时刻, streak: 连续未奏效次数 }——指数退避+跟进复位+2h 自然归零
// v2.4.30（W 类）：看门狗独立冷却桶——与 D/E 分开（语义不同：W 不依赖同质，避免被 D/E 触发挤占、也避免 W 稀释 D/E 的 streak 复位语义）
const WATCH_REMIND_AT = new Map();       // sessionId -> { ts: 上次 W 注入时刻 }（冷却 = watchCooldownMin，无 streak 指数——W 弱提醒一次即可）
// ── v0.5 回归闭环（P0a 数据层）：被动监测账本 ─────────────────────────────
// 设计：方案文档 docs/方案-记忆回归闭环机制.md v0.5。B/C 触发后插件自动捕捉错误上下文落
// pending-lessons，后续仅靠 tools/result 观测 sig 是否再现闭环——零宿主依赖、不新增工具。
const REGRESSION_ENABLED_DEFAULT = true;   // regressionEnabled 默认开（对标 spiralRemind）
const LESSON_PENDING_FILE = MEMORY_ROOT + "/.pending-lessons.json";
const LESSON_CLEAN_N = 5;                  // sig 连续 N 步（同会话工具轮）未再现 → resolved
const LESSON_DROP_MS = 48 * 3600000;       // lastSeenAt+48h 未 resolved → dropped
const LESSON_ARCHIVE_MS = 30 * 86400000;   // resolved 30 天未沉淀 → archived
const LESSON_CAP_ACTIVE = 50;              // active（open+resolved）容量上限，archived 不计
const LESSON_CTX_MAX = 400;                // context 总长上限（字符）
const LESSON_SOLUTION_MAX = 300;           // solution.summary 上限（字符）
const LESSON_ARG_MAX = 200;                // context.args 上限
const LESSON_ERR_MAX = 200;                // context.error 上限
const LESSON_KICK_THRESHOLD = 2;           // kicked：窗口内 ask_user_question 累计阈值
const LESSON_SAVE_DEBOUNCE_MS = 500;       // 落盘防抖（对标 MONITOR_DOLLAR）
const REGRESSION_AT = new Map();           // v0.5: (sid+"\u0001"+sig) -> { ts, streak }——回归提醒独立退避桶（不复用 SPIRAL_REMIND_AT 状态）
// v0.5（P0c）：回归提醒待注入队列（方案 A：独立 pre-step handler 消费，不受 step 限制）
//   sid -> [ { sig, text, enqueueAt } ]——一次 reminder 触发入队；pre-step 到点取队头注入
let REGRESSION_QUEUE = new Map();          // per-sid 队列（先进先出；同一 sid 内保持顺序，注入后移除）
// v2.4.27（子代理提醒放开+插件隔离）：插件自己 spawn 的子代理 sid 登记（隔离——A/B/C/D 提醒全关，只计 monitor）。
// 判定「插件子代理」用 spawn 点注册的 sid（subagents.start 返回 run.id=childSessionId，宿主 dsh-subagent lifecycle 实证），
// 不依赖 label 字符串匹配（label 在 tools/result 的 exec.agent 上取不到）。普通子代理（非插件）B/C/D 提醒放开。
const PLUGIN_SUBAGENT_SIDS = new Set();    // 插件 spawn 子代理 sid（长驻上限 LRU，同 SPIRAL_BUCKETS 手法）
const MAX_PLUGIN_SIDS = 200;
function markPluginSubagent(sid) {
  if (!sid) return;
  if (PLUGIN_SUBAGENT_SIDS.size >= MAX_PLUGIN_SIDS) { const k0 = PLUGIN_SUBAGENT_SIDS.keys().next().value; PLUGIN_SUBAGENT_SIDS.delete(k0); }
  PLUGIN_SUBAGENT_SIDS.add(sid);
}
function isPluginSubagent(sid) { return sid ? PLUGIN_SUBAGENT_SIDS.has(sid) : false; }
let LESSON_PENDING = null;                 // 懒加载：{ entries: [ {sig,sessionId,context,state,...} ] }
let LESSON_PENDING_DIRTY = false;          // 变更防抖标记
let LESSON_PENDING_DIRTY_SINCE = 0;        // 状态迁移即时落盘用的最后迁移时间戳（无需单独字段，见 scheduleLessonSave）
let RETRIEVAL_SELF = null;               // v2.2.6: 检索层启动自检状态——null=未跑；{ok,msg,detail,at}（模块级：activate 闭包内自检写入、监控汇总读取）

// 从 index.md 自动提取"领域→记忆文件→关键词"匹配表
function buildMemoryHintTable() {
  try {
    const p = portable(MEMORY_ROOT + "/index.md");
    const st = fs.statSync(p);
    if (MEMORY_HINT_TABLE && st.mtimeMs === MEMORY_HINT_TABLE_MTIME) return MEMORY_HINT_TABLE;
    const text = fs.readFileSync(p, "utf8");
    const rows = [];
    for (const line of text.split("\n")) {
      // v2.2.5：index.md 为「一行多条目｜分隔」紧凑格式——先按｜拆段逐条解析；
      //   旧正则一次匹配整行，每行只吃到第一个条目且 file 吞进后续脏字符（A 类提醒覆盖面缩水根因）。
      for (const seg of line.split("｜")) {
      //   v2.2.5b：描述组整体可选 (?:...)?——旧形态 \s*（([^）]*)）? 中全角开括号是必需项，
      //     无「（描述）」的行全部失配（当前 index.md 恰好全部无描述 → A 类表恒空，08-26 调试实证）。
      const m = seg.match(/^(?:-\s*)?(.+?)\s*→\s*(MEMORY-[^\s（）()|]+|[^\s（）()|]+\.md)(?:\s*[（(]([^）)]*)[)）])?/);
      if (!m) continue;
      const name = m[1].trim();
      const file = m[2].trim();
      const desc = (m[3] || "").trim();
      const kws = [];
      // name 除整串外，按斜杠切子领域（如 "REST API/推送" → 追加 "推送"）——混合词的中文主体可独立命中
      const nameParts = [name, ...name.split(/[/／]+/).map((s) => s.trim()).filter((s) => s.length >= 2)];
      for (const part of [...nameParts, ...desc.split(/[/、,，;；\s]+/).filter(Boolean)]) {
        // v2.0.4: 丢弃空关键词——2字符纯英文/数字词（Qt/CA/OA/26/38）通过长度准入但 splitKw 的 lats 正则要求≥3字符，
        // 产出 {han:[],lats:[]} 对任何文本无条件命中（08-24 实测 7 个领域行中招，A 类提醒与任务无关的根因）
        const k = splitKw(part);
        if (k.hanGrams.length || k.lats.length) kws.push({ part: String(part), hanGrams: k.hanGrams, lats: k.lats });   // v2.2.1: 保留原文，命中时展示触发词
      }
      rows.push({ kws, file, name });
      } // v2.2.5: 闭合 seg 循环
    }
    MEMORY_HINT_TABLE = rows;
    MEMORY_HINT_TABLE_MTIME = st.mtimeMs;
    if (rows.length > 0) clog("[dsh-memory] 记忆提醒关键词表已加载（" + rows.length + " 个记忆文件映射，来源 index.md）");
    return rows;
  } catch (e) {
    return MEMORY_HINT_TABLE || [];
  }
}

// 从用户消息文本提取纯文本（ContentBlock[] → string）
// v1.12.19.3: 只取用户真实输入——剔除 <system-reminder> 注入块（维护提醒/本插件提示文本含关键词，
// 混入匹配源会自我强化：提示里的「日志填写」等词被当成用户输入再次命中，BitDock 会话实测循环注入）。
function hintTextOf(messages) {
  // v2.0.4: 只取最后一条 role=user 消息——A 类判断的是「当前任务是否涉及已知领域」，
  // 全史拼接会让早期粘贴的控制台输出/runtime context 永久参与每轮匹配（08-24 实测跨天长会话注入与任务无关的提示）。
  let lastUser = null;
  for (const msg of messages || []) {
    if (!msg || !Array.isArray(msg.content)) continue;
    if (msg.role && msg.role !== "user") continue;
    lastUser = msg;   // 同一条消息的多 text 块仍合并（长消息分块场景）
  }
  if (!lastUser) return "";
  const parts = [];
  for (const b of lastUser.content) {
    if (b && b.type === "text" && typeof b.text === "string") {
      const t = b.text;
      if (t.indexOf("<system-reminder>") >= 0 || t.indexOf("【dsh-memory") >= 0) continue;  // 剔除插件注入块
      parts.push(t);
    }
  }
  return parts.join("\n").slice(0, 2000);
}

// v1.12.11：关键词预处理（对标 MiMo-Code skill/search.ts tokenize）——
// 汉字段切相邻两字滑窗 bigram（语序无关），英文/数字段小写整词（≥3 字符）。
function splitKw(kw) {
  const lower = kw.toLowerCase();
  const hanGrams = [];
  for (const m of lower.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...m[0]];
    if (chars.length === 1) { hanGrams.push(m[0]); continue; }
    for (let i = 0; i < chars.length - 1; i++) hanGrams.push(chars[i] + chars[i + 1]);
  }
  const lats = [];
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]{2,}/gu)) lats.push(m[0]);
  return { hanGrams: hanGrams, lats: lats };
}

// 匹配：返回命中的记忆映射列表（限 top 3）。
// v1.12.11：大小写归一化 + 中文 bigram 交集 ≥ 半数判命中（治语序盲区："压缩一下这个录屏"命中"录屏压缩"）；
// 性能：hintTextOf 已截 2000 字符 → 文本 bigram Set ≤~2000 条，每关键词几次 Set.has，微秒级。
function matchMemoryHints(userText) {
  if (!userText) return [];
  const table = buildMemoryHintTable();
  const textLower = userText.toLowerCase();
  const textGrams = new Set();
  for (const m of textLower.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...m[0]];
    for (let i = 0; i < chars.length - 1; i++) {
      if (textGrams.size >= 5000) break;
      textGrams.add(chars[i] + chars[i + 1]);
    }
  }
  const hits = [];
  for (const row of table) {
    let hit = false;
    let hitParts = [];
    for (const kw of row.kws) {
      if (kw.hanGrams.length === 0 && (!kw.lats || kw.lats.length === 0)) continue;  // v2.0.4: 空关键词无条件命中的防御
      // 中文部分：bigram 交集 ≥ 半数（至少 1）
      let hanHit = kw.hanGrams.length === 0;
      if (!hanHit) {
        let c = 0;
        for (const g of kw.hanGrams) { if (textGrams.has(g)) c++; }
        hanHit = c >= Math.max(1, Math.ceil(kw.hanGrams.length * 0.5));
      }
      if (!hanHit) continue;
      // 英文/数字部分：逐 token 子串（全部满足）
      let latHit = true;
      for (const t of kw.lats) { if (!textLower.includes(t)) { latHit = false; break; } }
      if (latHit) { hit = true; if (kw.part) hitParts.push(kw.part); break; }
    }
    if (hit) {
      hits.push({ file: row.file, name: row.name, parts: hitParts.slice(0, 3) });   // v2.2.1: 触发词随行返回（最多 3 个）
      if (hits.length >= 3) break;
    }
  }
  return hits;
}

// v1.12.0：分区感知注入 —— 对标 mimocode readBudgetedSectionAware（budgeted-read.ts）
// 解析 Markdown ## 章节：预算内保所有章节标题（结构骨架），正文按章节预算均分截断，
// 换行处断（不切字）、末尾提示"完整内容用 memory_search 查"。文件再大：骨架可见，信息不黑盒。
// v1.12.0：分区感知注入 —— 对标 mimocode readBudgetedSectionAware（budgeted-read.ts）
// 解析 Markdown ## 章节：预算内保所有章节标题（结构骨架），正文按章节预算均分截断，
// 换行处断（不切字）、末尾提示"完整内容用 memory_search 查"。文件再大：骨架可见，信息不黑盒。
// v2.4.17：opts.priority = ["本次目标","下一步行动","关键结论"] 时优先级节先占预算（完整优先），余量再均分非优先级节；缺省行为不变（全均分）。
function sectionAwareSlice(text, budgetChars, fileLabel, opts) {
  if (!text) return { text: "", truncated: false, total: 0 };
  if (text.length <= budgetChars) return { text, truncated: false, total: text.length };
  const prio = new Set(Array.isArray(opts && opts.priority) ? opts.priority.map((h) => String(h).replace(/^#+\s*/, "").trim()) : []);
  const lines = text.split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  const skeletonParts = [...preamble];
  for (const sec of sections) skeletonParts.push(sec.header);
  const skeleton = skeletonParts.join("\n");
  const remaining = budgetChars - skeleton.length;
  if (remaining <= 0) {
    return { text: skeleton.slice(0, budgetChars) + "\n[注：全文 " + text.length + " 字符，骨架已超预算；完整内容用 memory_search 查 " + fileLabel + "]", truncated: true, total: text.length };
  }
  // v2.4.17：优先级节先占预算（完整优先），余量再均分非优先级节
  let remaining2 = remaining;
  const prioAlloc = new Map();
  const nonPrio = [];
  for (const sec of sections) {
    const nm = sec.header.replace(/^#+\s*/, "").trim();
    const bodyLen = sec.body.join("\n").length;
    if (prio.has(nm)) {
      const alloc = bodyLen <= remaining2 ? bodyLen : remaining2;
      prioAlloc.set(sec, alloc); remaining2 -= alloc;
    } else {
      nonPrio.push(sec);
    }
  }
  const perSection = nonPrio.length > 0 ? Math.floor(remaining2 / nonPrio.length) : 0;
  const out = [...preamble];
  for (const sec of sections) {
    out.push(sec.header);
    const bodyText = sec.body.join("\n");
    const alloc = prioAlloc.has(sec) ? prioAlloc.get(sec) : perSection;
    if (alloc > 0 && bodyText.length > alloc) {
      let cut = bodyText.slice(0, alloc);
      const nl = cut.lastIndexOf("\n");
      if (nl > 0) cut = cut.slice(0, nl);
      out.push(cut + "\n…(章节截断)");
    } else {
      out.push(bodyText);
    }
  }
  out.push("\n[注：原文 " + text.length + " 字符，已按注入预算截断；完整内容用 memory_search 查 " + fileLabel + "]");
  return { text: out.join("\n"), truncated: true, total: text.length };
}

// v1.12.0：使用监控 —— 记录提醒/查询/错误事件，供设置界面展示 + 使用一段时间后优化。
// 数据存 .monitor.json（全量保留，无窗口限制）；设置界面显示精简汇总（monitorSummary 只读字段）。
const MONITOR_FILE = MEMORY_ROOT + "/.monitor.json";
// v1.12.15: 跟进窗口上限——A 类按任务周期（下一条用户输入结算，此处仅防失控上限）；B/C 类按修错场景固定步数
const FOLLOW_CAP_A = 20;
const FOLLOW_CAP_BC = 8;
let MONITOR_DATA = null;           // 懒加载
let MONITOR_DOLLAR = false;        // 写入防抖标记（避免高频工具调用频繁写盘）
// v1.12.14: 未决跟随窗口改为持久化——唯一真源是 .monitor.json 的 hintOpen 字段（{ type, count }），跨重启续判
let MONITOR_LAST_SUMMARY = "";     // v1.12.6: 上次推送的汇总串（内容不变不重复推送）
let MONITOR_LAST_PUSH_AT = 0;      // v1.12.6: 上次推送时间戳（60s 节流，防高频工具调用刷屏）
let MONITOR_PUSH_TIMER = null;     // v1.12.6: 节流到期补推定时器
let MONITOR_LAST_LOG_SIG = "";     // v1.12.7: 上次打日志的"有意义变化"签名（不含纯事件数增长）
let MONITOR_LAST_LINES = null;       // v2.3.1: 上次推送的逐行快照 {行首key: 行文本}——增量输出基线（null=首推全量）
let LAST_TOP_AGENT = null;         // v1.12.8: 最近顶层会话 agent 句柄（stale_archive 工具 spawn parent 用）

function defaultMonitorData() {
  return { version: 1, installedAt: Date.now(), updatedAt: Date.now(),
    hints: { A: 0, B: 0, C: 0, D: 0, E: 0, W: 0, BRK: 0 },     // 提醒次数（按类型；D=v2.0.2 LLM循环试错；E/W=v2.4.30 成功同质循环/无介入看门狗；BRK=v2.6.0 打转熔断动作计数）
    byDomain: {},                     // A 类提醒按领域统计 { 领域名: 次数 }
    queries: 0,                       // memory_search 总调用数
    recentQueries: [],                // 最近查询（最多 20 条 {t, query}）
    followed: 0, ignored: 0, capped: 0,          // 提醒后是否被跟随（有效/忽略）；capped=v1.12.16 窗口超限截断（长任务），不计跟进率分母
    events: [],                       // 全量事件 {t, type, detail}（全量保留）
    hintOpen: null,
    maintain: { integRuns: 0, archRuns: 0, inT: 0, cacheT: 0, outT: 0 },  // v1.12.18.1: 维护 token 累计
    turnProfiles: [],                   // v1.12.16: 任务周期画像 [{t,durMin,calls,negN,errN,spiralN}]（滚动200条，调优基线）
    spiralEvents: [],                   // v1.12.16: 打转触发样本 [{t,tool,repRate,negRate,sample}]（v2.0.2 起可注入D类提醒；v2.4.30 加 kind:"D"/"E" 分流，样本仍全量保留供调优）
    watchEvents: [],                    // v2.4.30: W 类看门狗触发样本 [{t,ws,steps,wallSecs,topTool}]（独立数组——无同质/重复语义，不混入 spiralEvents 防污染 D/E 校准）
    breakerEvents: [],                  // v2.6.0: D 级熔断动作样本 [{t,level,tool,reason,action}]（滚动100，独立于 spiralEvents 防污染校准；供面板/调优）
    spiralThresh: null,                 // v2.0.3: D 类阈值覆盖层 {rep,neg,sim,w,cooldownMin}——null=用内置默认；/dream 自校准写入；v2.4.30 增 E/W 字段
    spiralThreshLog: [],
    // v0.5：回归闭环统计（P0a，B5：lessons 计数不经 monitorEvent、独立落盘；lessonEvents 经 monitorEvent 受 monitorEnabled）
    lessons: { open: 0, closed: 0, dropped: 0, kicked: 0, fed: 0, skippedByDream: 0 },
    lessonEvents: [] };                 // 滚动 100：{t, sig, ev} ev=open|closed|dropped|kicked|fed|skipped
    // v0.5（P0-2 埋点，2026-09-03 step0）：合并维护样本——触发前/后字数字点数（滚动 200），
    // 供 §3.1 水位/回落统计与 /dream 自校准（step5 后格级样本；步0-3 为全文件口径校判据B）
    // maintSamples: []  // {t, fname, beforeChars, afterChars, result, readback}（字段延迟到 recordMaintSample 惰性建）
}

// v0.5：回归 lessons 计数 + 事件（与 monitorEvent 分离：计数不受 monitorEnabled gate，随回归账本）
let SUMMARY_STRUCT_NOTIFIED_DAY = "";   // v2.4.17：当日摘要结构异常通知「当日一次」闸（降噪 N1-2）

// v2.4.17（降噪 N0-1/N1-1）：当日文件三节结构检查——仅对含协议标记的文件查「至少一组有序三节」。
// 手写式摘要（## 会话：…）、机械收敛要点等无协议标记 = 合法，不查（不误报、不误触发 maint）。
function summaryStructureBroken(text) {
  const t = String(text || "");
  if (!/## 当日要点|<!-- intent:/.test(t)) return false;
  const heads = [];
  const SECT = /^##\s*本次目标\s*$|^##\s*下一步行动\s*$|^##\s*关键结论\s*$/;
  for (const ln of t.split("\n")) if (SECT.test(ln)) heads.push(ln.replace(/^##\s*/, "").trim());
  if (heads.length < 3) return true;
  for (let i = 0; i + 2 < heads.length; i++) {
    if (heads[i] === "本次目标" && heads[i + 1] === "下一步行动" && heads[i + 2] === "关键结论") return false;
  }
  return true;
}

// v2.4.17：项目文件块级 hash 多集（位置无关，每 ## 节一个 hash，排序拼接）——hP 记账（块变更通知）
function projectBlockHash(text) {
  const seg = [];
  let cur = [];
  for (const ln of String(text || "").split("\n")) {
    if (/^##\s/.test(ln)) { if (cur.length) seg.push(cur.join("\n")); cur = [ln]; }
    else cur.push(ln);
  }
  if (cur.length) seg.push(cur.join("\n"));
  return seg.map((b) => createHash("sha256").update(b).digest("hex").slice(0, 16)).sort().join(",");
}

function lessonCounters() {
  const d = readMonitorData();
  if (!d.lessons) d.lessons = { open: 0, closed: 0, dropped: 0, kicked: 0, fed: 0, skippedByDream: 0 };
  return d.lessons;
}
function lessonEvent(sig, ev) {
  try {
    const d = readMonitorData();
    if (!Array.isArray(d.lessonEvents)) d.lessonEvents = [];
    d.lessonEvents.push({ t: Date.now(), sig: String(sig || "").slice(0, 60), ev });
    if (d.lessonEvents.length > 100) d.lessonEvents = d.lessonEvents.slice(-100);
    scheduleMonitorSave();   // B5：事件经 monitorEvent 语义（受 monitorEnabled gate 的只有 monitorEvent 本身；此处直接 schedule 落盘）
  } catch (e) { /* 忽略 */ }
}

function readMonitorData() {
  if (MONITOR_DATA) return MONITOR_DATA;
  try {
    const raw = fs.readFileSync(portable(MONITOR_FILE), "utf8");
    MONITOR_DATA = Object.assign(defaultMonitorData(), JSON.parse(raw));
  } catch (e) {
    MONITOR_DATA = defaultMonitorData();
  }
  return MONITOR_DATA;
}

// ── v0.5 回归闭环 · pending-lessons 数据层（P0a）─────────────────────────
// 唯一正式规格：docs/方案-记忆回归闭环机制.md v0.5 4.2。唯一键 (sig, sessionId)；
// 状态机 open→resolved/dropped、resolved→(移除|archived)、dropped/archived→open 复活（复用键）。
// >>> LESSON_P0A BEGIN

function lessonKey(sig, sid) { return String(sig || "") + "\u0001" + String(sid || ""); }

// v0.5（P0a-5）：退避算法抽取——D 类（spiral）与回归共用同一节奏算法，各自独立桶。
// 原逻辑 L4326-4337：2h 无新触发 → streak 归零；指数退避 cooldown * 2^streak 封顶 60 分。
// batchLike（批量进展豁免）参数可空——回归实例无 args 滑窗，传 undefined 即不豁免。
function backoffAllowed(bucket, cooldownBaseMs, nowMs, batchLike) {
  const b = bucket || { ts: 0, streak: 0 };
  const streak = (nowMs - b.ts >= 120 * 60000) ? 0 : (b.streak || 0);   // 2h 无新触发=新周期，退避归零
  const cdMs = Math.min((cooldownBaseMs || 600000) * Math.pow(2, streak), 60 * 60000);   // 指数退避 封顶60分
  if (batchLike === true) return { allowed: false, streak, cdMs, reason: "batch" };
  if (nowMs - b.ts < cdMs) return { allowed: false, streak, cdMs, reason: "cooldown" };
  return { allowed: true, streak, cdMs, reason: "ok" };
}

// v0.5（P0c）：回归提醒入队（方案 A——替代 B/C 触发的直接 agent.inject；pre-step handler 消费）
function enqueueRegressionReminder(sid, sig, text) {
  try {
    let q = REGRESSION_QUEUE.get(sid);
    if (!q) { q = []; REGRESSION_QUEUE.set(sid, q); }
    q.push({ sig, text, enqueueAt: Date.now() });
  } catch (e) { /* 入队失败忽略（下次触发重试） */ }
}
// 取队头（不可用于满足「只发一次」语义的消费——消费权在 pre-step handler，这里只读）
function peekRegressionReminder(sid) {
  const q = REGRESSION_QUEUE.get(sid);
  return q && q.length > 0 ? q[0] : null;
}
// pre-step handler：把队头提醒追加进当轮请求（决策直入，当轮可见），并从队列移除
function dequeueRegressionReminder(sid) {
  const q = REGRESSION_QUEUE.get(sid);
  if (q && q.length > 0) { q.shift(); if (q.length === 0) REGRESSION_QUEUE.delete(sid); return true; }
  return false;
}
function clearRegressionQueue(sid) { REGRESSION_QUEUE.delete(sid); }

// 懒加载 + 容错：JSON.parse 失败 → 改名 .corrupt 保留现场 + 内存空态（参考 readMonitorData 捕获纪律、增强为改名保留）
function readLessonPending() {
  if (LESSON_PENDING) return LESSON_PENDING;
  LESSON_PENDING = { entries: [] };
  try {
    const raw = fs.readFileSync(portable(LESSON_PENDING_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      LESSON_PENDING = { entries: parsed.entries.filter((e) => e && e.sig && e.sessionId) };
    }
  } catch (e) {
    try { fs.renameSync(portable(LESSON_PENDING_FILE), portable(LESSON_PENDING_FILE + ".corrupt")); } catch (e2) { /* 改名失败保持空态 */ }
    LESSON_PENDING = { entries: [] };
  }
  return LESSON_PENDING;
}

// 写盘前与磁盘做 (sig,sessionId) 幂等 upsert 并集合并（对标 writeIntegrateState L4662-4683 的字段特判合并）
function writeLessonPending(force) {
  try {
    fs.mkdirSync(MEMORY_ROOT.split("\\").join("/"), { recursive: true });
    const mem = readLessonPending();
    let merged = mem.entries;
    try {
      const disk = JSON.parse(fs.readFileSync(portable(LESSON_PENDING_FILE), "utf8"));
      if (disk && Array.isArray(disk.entries)) {
        const byKey = {};
        for (const e of mem.entries) byKey[lessonKey(e.sig, e.sessionId)] = e;
        for (const de of disk.entries) {
          if (!de || !de.sig || !de.sessionId) continue;
          const k = lessonKey(de.sig, de.sessionId);
          if (!byKey[k]) byKey[k] = de;
        }
        merged = Object.values(byKey);
      }
    } catch (e) { /* 磁盘不可读则按内存态原样写 */ }
    merged = enforceLessonCapacity(merged);
    LESSON_PENDING = { entries: merged };
    fs.writeFileSync(portable(LESSON_PENDING_FILE), JSON.stringify({ entries: merged }, null, 2), "utf8");
  } catch (e) {
    cwarn("[dsh-memory] pending-lessons 写入失败:", e && e.message ? e.message : String(e));
  }
}

// 容量护栏：active（open+resolved）≤ LESSON_CAP_ACTIVE；archived 不计。
// 满时先归档最旧已投喂 resolved（feedAt 升序），再丢最旧 dropped（droppedAt 升序），仍满丢最旧 open（capturedAt 升序）并记 monitor lessonDropped。
function enforceLessonCapacity(entries) {
  const active = entries.filter((e) => e.state === "open" || e.state === "resolved");
  if (active.length <= LESSON_CAP_ACTIVE) return entries;
  const keep = entries.slice();
  const overflow = active.length - LESSON_CAP_ACTIVE;
  let dropped = 0;
  // ① 归档最旧已投喂 resolved（feedAt>0 且有 archivedAt 空缺）
  const fedResolved = keep.filter((e) => e.state === "resolved" && e.feedAt > 0 && !e.archivedAt).sort((a, b) => (a.feedAt || 0) - (b.feedAt || 0));
  for (const e of fedResolved) {
    if (dropped >= overflow) break;
    const idx = keep.indexOf(e);
    if (idx >= 0) { keep[idx] = Object.assign({}, e, { state: "archived", archivedAt: Date.now() }); dropped++; }
  }
  // ② 丢最旧 dropped（droppedAt 升序）
  if (dropped < overflow) {
    const oldDropped = keep.filter((e) => e.state === "dropped").sort((a, b) => (a.droppedAt || 0) - (b.droppedAt || 0));
    for (const e of oldDropped) {
      if (dropped >= overflow) break;
      keep.splice(keep.indexOf(e), 1);
      dropped++;
    }
  }
  // ③ 丢最旧 open（capturedAt 升序）
  if (dropped < overflow) {
    const oldOpen = keep.filter((e) => e.state === "open").sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
    for (const e of oldOpen) {
      if (dropped >= overflow) break;
      keep.splice(keep.indexOf(e), 1);
      dropped++;
    }
  }
  if (dropped > 0) {
    try {
      const d = readMonitorData();
      d.lessons = d.lessons || { open: 0, closed: 0, dropped: 0, kicked: 0 };
      d.lessons.dropped = (d.lessons.dropped || 0) + dropped;
      scheduleMonitorSave();
    } catch (e) {}
  }
  return keep;
}

// 防抖落盘（对标 scheduleMonitorSave L883-895）；状态迁移即时落盘由调用点传 force=true
function scheduleLessonSave(force) {
  if (force) { LESSON_PENDING_DIRTY = false; writeLessonPending(true); return; }
  if (LESSON_PENDING_DIRTY) return;
  LESSON_PENDING_DIRTY = true;
  setTimeout(() => {
    LESSON_PENDING_DIRTY = false;
    writeLessonPending(false);
  }, LESSON_SAVE_DEBOUNCE_MS);
}

// 建立/更新一个 open 条目（B/C 触发捕捉用）。同 (sig,sid) 幂等 upsert；
// state 为 dropped/archived 时按状态机复活（resurfacedAt 复用键），不新建键不双写。
function lessonUpsertOpen(sig, sid, context, now) {
  const P = readLessonPending();
  let e = P.entries.find((x) => x.sig === sig && x.sessionId === sid);
  const t = now || Date.now();
  if (!e) {
    e = { sig, sessionId: sid, capturedAt: t, context, state: "open", solution: null, lastSeenAt: t, cleanSteps: 0, askCount: 0, kickedNotified: false, feedAt: 0, feedState: null, resurfacedAt: 0, resolvedAt: 0, droppedAt: 0, archivedAt: 0 };
    P.entries.push(e);
  } else {
    const wasTerminal = e.state === "dropped" || e.state === "archived";
    e.context = context;
    if (wasTerminal) {
      e.state = "open";
      e.resurfacedAt = t;
      e.cleanSteps = 0;
      e.lastSeenAt = t;
      e.droppedAt = 0;
      e.archivedAt = 0;
      e.askCount = 0;
      e.kickedNotified = false;
    } else {
      e.state = "open";
      e.lastSeenAt = t;
      e.cleanSteps = 0;   // 再现即归零（C12 语义）
    }
  }
  scheduleLessonSave(false);
  return e;
}

// 监测更新（P0b 接入）：仅当轮次属于条目 sessionId 对应会话时推进 cleanSteps/lastSeenAt（P0-1 防跨会话污染）。
// sigSet = 本轮出现的错误签名集合；返回 { closed: [entry...], resurrected: [entry...] } 供调用点记 monitor。
function lessonObserve(sid, sigSet, now) {
  if (PLUGIN_CFG.regressionEnabled === false) return { closed: [], resurrected: [] };
  const P = readLessonPending();
  const t = now || Date.now();
  const closed = [];
  const resurrected = [];
  for (const e of P.entries) {
    if (e.sessionId !== sid) continue;                       // 仅本会话轮次（P0-1）
    if (e.state !== "open" && e.state !== "resolved") {      // dropped/archived 不推进（复活由 upsert 处理）
      continue;
    }
    if (e.state === "resolved") continue;                    // resolved 不再计数（等待 /dream）
    const appears = sigSet.has(e.sig);
    if (appears) {
      e.lastSeenAt = t;
      e.cleanSteps = 0;
    } else {
      e.cleanSteps += 1;
      e.lastSeenAt = Math.max(e.lastSeenAt || 0, t);
    }
    if (e.cleanSteps >= LESSON_CLEAN_N && e.state === "open") {
      e.state = "resolved";
      e.resolvedAt = t;
      closed.push(e);
    }
  }
  if (closed.length > 0) scheduleLessonSave(true);
  else scheduleLessonSave(false);
  return { closed, resurrected };
}

// 超时判定：lastSeenAt+48h 未 resolved → dropped；resolved 30 天未沉淀 → archived。now 注入可测。
function lessonApplyTimeout(now) {
  if (PLUGIN_CFG.regressionEnabled === false) return [];
  const P = readLessonPending();
  const t = now || Date.now();
  const changes = [];
  for (const e of P.entries) {
    if (e.state === "open" && t - (e.lastSeenAt || e.capturedAt || 0) >= LESSON_DROP_MS) {
      e.state = "dropped";
      e.droppedAt = t;
      changes.push({ sig: e.sig, sessionId: e.sessionId, to: "dropped" });
    } else if (e.state === "resolved" && t - (e.resolvedAt || e.lastSeenAt || e.capturedAt || 0) >= LESSON_ARCHIVE_MS) {
      e.state = "archived";
      e.archivedAt = t;
      changes.push({ sig: e.sig, sessionId: e.sessionId, to: "archived" });
    }
  }
  if (changes.length > 0) scheduleLessonSave(true);
  return changes;
}

// ── v0.5 回归闭环 · P0b 监测接入辅助（模块级纯函数，闭包调用）────────────
// 错误签名归一化（与 B/C 计数共用同一口径，L4389-4396 提取为函数）：
// run_code 嵌套错误上抛两条形态，剥壳后归一（去数字/压缩空白/截 150）
// v2.4.17（项目记忆子系统）：
// v2.4.18（workdirs 体检与改名保护，评审 P0x3/P1xN 吸收版）：
const WORKDIRS_STALE_DAYS = 30;              // 长期未命中判定阈值（天）
const PROJECT_CHAR_HARD = 9000;              // v2.4.20：项目文件容量硬限（字符=JS String.length）；>9000 触发提取（滞回带 8000-9000 不触发，防边界抖动）
const PROJECT_CHAR_SOFT = 6000;              // v2.4.20：提取目标上限（净空 3000，防 append 即重超震荡）与软提示线（6000-9000 且本轮已写才提示）
// v2.4.28：硬性注入预算提级到模块级（原 apply 闭包内 L4787，D0 计量纯函数需在模块级引用）。
//   语义不变：CHAR_LIMIT 是"超过注入会被 slice 截断"的硬上限（global 3000 字≈9KB、index 2000 字≈6KB、摘要 1500 字≈4.5KB）；
//   SIZE_WARN 是软字节维护信号（中文 4608B≈1500字，远低于硬预算）。软信号+硬预算双轨并存。
//   仅此一处真源；闭包内原引用点（sectionAwareSlice/checkSizeOverflow/buildMemoryDocStatus）自动读模块级。
const CHAR_LIMIT = { "global.md": 3000, "index.md": 2000, summary: 1500 };
const SIZE_WARN = { "global.md": 4608, "index.md": 4608, summary: 4096 }; // v9.1: global 4096→4608B、摘要 2048→4096B（与注入截断对齐降噪音）；v10.1: index 3072→4608B（中文索引 3393B≈1130 字符，远低于注入预算 2000 字符，3072 为 v7 旧值）
// v2.4.28（D0）：按 rel 预算表（写时校验/预览用）——global/index 与 CHAR_LIMIT 同源（上表），projects 用 PROJECT_CHAR_HARD/SOFT；sessions/|knowledge/|tools/ 无预算（null）。
function budgetOf(rel) {
  const r = String(rel || "");
  if (r === "global.md") return { chars: CHAR_LIMIT["global.md"] };
  if (r === "index.md") return { chars: CHAR_LIMIT["index.md"] };
  if (/^projects\//.test(r)) return { chars: PROJECT_CHAR_HARD, soft: PROJECT_CHAR_SOFT, extract: true };
  return null;
}
// v2.4.32（P0-4）：preview 调用计数闸——防「连环 preview 空转」（实证 09-07：244 次 preview/0 落盘被 D4 硬停）。
// 按会话+文件滑动窗计数（execute 第二参 exec 含 agent.session.id）；同 (sid,file) 第 4 次 / 同 sid 总数 8 次 → 拒绝并现算差数。
// "?" 桶兜底无 exec 的一参调用（门脚本直调）。previewGateCheck 返回 { allowed, fileN, sidN }；纯函数（模块级，闭包内 execute 引用）。
const PREVIEW_GATE_WINDOW_MS = 10 * 60e3;
const PREVIEW_GATE_PER_FILE = 4;
const PREVIEW_GATE_PER_SID = 8;
const PREVIEW_GATE_MAX = 200;   // 会话条目上限（LRU 淘汰，防长期实例积累）
const PREVIEW_GATE = new Map();   // sid -> { byFile: Map<file,{t,n}>, total: {t,n} }
function previewGateCheck(sid, file) {
  try {
    const now = Date.now();
    let e = PREVIEW_GATE.get(sid);
    if (!e) { e = { byFile: new Map(), total: { t: 0, n: 0 } }; PREVIEW_GATE.set(sid, e); }
    for (const [f, r] of e.byFile) { if (now - r.t > PREVIEW_GATE_WINDOW_MS) e.byFile.delete(f); }
    if (now - e.total.t > PREVIEW_GATE_WINDOW_MS) e.total.n = 0;
    e.total.t = now;
    const r = e.byFile.get(file) || { t: 0, n: 0 };
    if (now - r.t > PREVIEW_GATE_WINDOW_MS) r.n = 0;
    r.t = now; r.n += 1;
    e.byFile.set(file, r);
    e.total.n += 1;
    if (PREVIEW_GATE.size > PREVIEW_GATE_MAX) {   // LRU：淘汰最早使用的会话条目
      let oldSid = null, oldT = Infinity;
      for (const [s, en] of PREVIEW_GATE) {
        let mt = en.total.t; for (const x of en.byFile.values()) { if (x.t > mt) mt = x.t; }
        if (mt < oldT) { oldT = mt; oldSid = s; }
      }
      if (oldSid !== null) PREVIEW_GATE.delete(oldSid);
    }
    return { allowed: r.n < PREVIEW_GATE_PER_FILE && e.total.n < PREVIEW_GATE_PER_SID, fileN: r.n, sidN: e.total.n };
  } catch (e2) { return { allowed: true, fileN: 0, sidN: 0 }; }
}
// v2.4.32（P0-5）：预算循环检测桶（tools/result 侧维护）——同 (spSid,file) 连续 preview / patch 预算拒写打转。
// 重置信号=该 (sid,file) 成功落盘 wrote>0（patch 尝试不重置）；MILD 第 3 次 preview / 第 2 次拒写，
// STRONG 第 4 次 preview（P0-4 拒写同刻）起持续（60s 冷却重发）/ 第 4 次拒写。
const BUDGET_LOOP_STRONG_CD = 60e3;
const BUDGET_LOOP_MAX = 200;
const BUDGET_LOOP = new Map();   // spSid -> { byFile: Map<file, {previewN, patchFailN, lastStrongAt}> }
const RENAME_SIM_THRESHOLD = 2;              // 疑似改名编辑距离阈值（levDist 剪枝上限）
// v2.4.28（D0）：统一代码围栏状态机提级到模块级（原 apply 闭包内，strip/validateMdStructure/charSectionBreakdown 共用）。
// 语义：``` / ~~~ 开头（≥3 个）即翻转围栏；类型不匹配（``` 开 ~~~ 关）同样翻转；返回 [newFence, isFenceLine]。
function fenceStep(line, fence) {
  const m = /^\s*(```+|~~~+)/.exec(String(line || ""));
  if (!m) return [fence, false];
  return [fence ? null : m[1][0], true];
}
// v2.4.28（D0）：按 `## ` 拆节的字符表（fence 感知——代码块内 `## x` 不拆节；与 validateMdStructure 解析同源）。
// 返回 [{ title, chars, lines }]，按文档顺序；opts.maxRows 截断（超出合并进末尾「…其余 N 节」行）。
function charSectionBreakdown(text, opts) {
  const o = opts || {};
  const lines = String(text || "").split("\n");
  const out = [];
  let cur = null; let fence = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const ln of lines) {
    const fs3 = fenceStep(ln, fence);
    fence = fs3[0];
    const wasFenceLine = fs3[1];
    if (wasFenceLine) continue;               // 围栏开/关行不计入任何节
    const isH2 = !fence && /^##\s+/.test(ln); // fence 内不判 H2
    if (isH2) {
      flush();
      cur = { title: ln.replace(/^##\s+/, "").trim(), chars: ln.length + 1, lines: 1 };
    } else if (cur) {
      cur.chars += ln.length + 1;             // +1 = 换行
      cur.lines += 1;
    }
  }
  flush();
  const withHead = out.length ? out : [{ title: "(无 ## 节)", chars: String(text || "").length, lines: lines.length }];
  if (o.maxRows && withHead.length > o.maxRows) {
    const kept = withHead.slice(0, o.maxRows);
    const rest = withHead.slice(o.maxRows);
    kept.push({ title: "…其余 " + rest.length + " 节", chars: rest.reduce((a, b) => a + b.chars, 0), lines: rest.reduce((a, b) => a + b.lines, 0) });
    return kept;
  }
  return withHead;
}
// v2.4.28（D0）：容量提取收敛目标。projects：max(PROJECT_CHAR_HARD, prevChars×0.8)（v2.4.20 口径）；global/index 无提取场景 → null。
function extractTargetFor(rel, prevChars) {
  const b = budgetOf(rel);
  if (!b || !b.extract) return null;
  return Math.max(PROJECT_CHAR_HARD, Math.round((Number(prevChars) || 0) * 0.8));
}
// v2.4.28（D0）+ v2.5.0（edit）：同 rel 补丁序列确定性合并模拟——复刻 applyPatches 落盘语义（replace 覆盖 / append trim+"\n\n" 连接 /
// projects 无节头 payload 「## 归档」锚点插入 / delete 精确原文删除 / edit 唯一命中替换 / append 幂等跳过）。
// v2.5.0（三审 B1）：折叠与落盘逐条读盘重演变换等价（同起点同序 ⇒ 终文逐字节相等），前提=edit 命中≠1 整批拒 + 折叠覆盖全部含 patch 的 rel。
// 纯函数：existing 由调用方传入（落盘循环从磁盘读，preview/写时校验从同一现文读），fsx 注入（默认模块 fs，测试可换内存桩）。
// 返回 { text, skipped:[rel(幂等)], error? }。edit 命中≠1 → 返回 { error }（整批拒，不 skipped——否则落盘按首命中写入与折叠终文不等）。中间某条幂等跳过 = 该条不改最终文本（继续折叠后续）。
function simulateFinalText(rel, existing, patchList, fsx) {
  const f = fsx || fs;
  let cur = String(existing == null ? "" : existing);
  const skipped = [];
  for (const it of patchList || []) {
    const rel2 = it.rel || rel;
    const act = it.action;
    const content = String(it.content == null ? "" : it.content);
    if (act === "replace") { cur = content; }
    else if (act === "append") {
      const payload = content.trim();
      if (cur.includes(payload)) { skipped.push(rel2 + "(append内容已存在)"); continue; }
      let outAppend;
      if (/^projects\//.test(rel2) && !/^##\s/.test(payload)) {
        const _ai = cur.lastIndexOf("## 归档");
        if (_ai >= 0) {
          const _nh = cur.indexOf("\n## ", _ai + 1);
          const _cut = _nh > 0 ? _nh : cur.length;
          outAppend = cur.slice(0, _cut).replace(/\s+$/, "") + "\n" + payload + "\n" + cur.slice(_cut);
        } else {
          outAppend = cur.replace(/\s+$/, "") + (cur.trim() ? "\n\n## 归档\n\n" : "## 归档\n\n") + payload + "\n";
        }
      } else {
        outAppend = cur.replace(/\s+$/, "") + (cur ? "\n\n" : "") + payload + "\n";
      }
      cur = outAppend;
    }
    else if (act === "delete") {
      const idx = cur.indexOf(content);
      if (idx < 0) { skipped.push(rel2 + "(delete未找到)"); continue; }
      cur = cur.slice(0, idx) + cur.slice(idx + content.length).replace(/^\n+/, "");
    }
    else if (act === "edit") {
      const o = String(it.old_string == null ? "" : it.old_string);
      const n = String(it.new_string == null ? "" : it.new_string);
      const c = cur.split(o).length - 1;
      if (c !== 1) { return { error: "edit 命中 " + c + " 处非唯一（须唯一，未命中请先 read 全量逐字复制原文）: " + rel2 }; }   // v2.5.0：整批拒，不 skipped
      cur = cur.replace(o, () => n);   // 函数 replacer 防 $&/$' 转义陷阱
    }
  }
  return { text: cur, skipped: skipped };
}
const ONE_DRIVE_CONFLICT_RE = /( - 副本\b|冲突副本|\(\d+\)\s*$)/;   // 冲突副本不入索引/不参与改名配对（P2-15）
let LAST_PROJECT_AUDIT = null;               // dream 发起处体检 → 结算广播拼接（一次性，广播后清）
function dayStrLocal(d) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0"); const dd = String(d.getDate()).padStart(2, "0"); return y + "-" + m + "-" + dd; }
// v2.4.19（标记文件快速匹配 ~dsh/project.json，评审 P0x5 吸收版）：
let MARKER_NOTIFY_DAILY = new Map();   // "path|key" -> 日期（session-start 失效提示每日一次节流）
function readProjectMarker(markerPath) {   // 正常 {key,file,dir} | 用户文件 {skip:dir} | 损坏 {bad:dir} | 不存在 null（复审 P1-new-2 解析分级）
  let raw = null;
  try { raw = fs.readFileSync(portable(markerPath), "utf8"); } catch (e) { return null; }
  const dirOf = () => portable(markerPath).replace(/\/~dsh\/project\.json$/, "");
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return { bad: dirOf() };
    if (o.version !== 1) return { skip: dirOf() };   // 无 version 字段=用户文件：静默跳过不报告、继续上溯
    if (typeof o.key === "string" && o.key && typeof o.file === "string" && o.file) {
      return { key: o.key, file: o.file, dir: dirOf() };
    }
    return { bad: dirOf() };
  } catch (e) {}
  return { bad: dirOf() };
}
function findProjectMarker(cwd) {   // 自适应上溯至盘根，最近胜、命中即停（评审裁决①：≤2 层魔法数不成立；盲区由 workdirs 回退兜底）
  try {
    let dir = portable(String(cwd || "")).replace(/\/+$/, "");
    while (dir && dir.length >= 4) {
      const m = readProjectMarker(dir + "/~dsh/project.json");
      if (m && !m.skip) return m;   // skip=用户文件：继续上溯（P1-new-2）
      const par = dir.replace(/\/[^/]*$/, "");
      if (par === dir) break;
      dir = par;
    }
  } catch (e) {}
  return null;
}
function listProjectChars() {   // v2.4.20：扫描 projects/*.md 返回 [{rel, chars}]（字符=JS String.length，与面板 dc.chars 同口径）
  const out = [];
  try {
    for (const f of fs.readdirSync(portable(MEMORY_ROOT + "/projects"))) {
      if (!/\.md$/.test(f) || /^_/.test(f) || ONE_DRIVE_CONFLICT_RE.test(f)) continue;
      try { const t = fs.readFileSync(portable(MEMORY_ROOT + "/projects/" + f), "utf8"); out.push({ rel: "projects/" + f, chars: t.length }); } catch (e) {}
    }
  } catch (e) {}
  return out.sort((a, b) => b.chars - a.chars);
}
// v2.4.26（项目摘要注入隔离）：命中项目 X → 行级剥离「X 相关节」（匹配 key/aliases 词，大小写不敏感）；
//   0 命中返回 {text:"",hit:0}（调用方降级通知）；超预算按整行头优先截断（保行完整性）
function projectSummarySlice(text, key, aliases, budgetChars) {
  const words = [String(key || ""), ...(Array.isArray(aliases) ? aliases : [])]
    .map((w) => String(w || "").toLowerCase()).filter((w) => w && w.length >= 2);
  const lines = String(text || "").split("\n");
  const keep = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (words.some((w) => t.toLowerCase().includes(w))) keep.push(t);
  }
  if (keep.length === 0) return { text: "", hit: 0 };
  let out = "";
  for (const ln of keep) { if (out.length + ln.length + 1 <= budgetChars) out += (out ? "\n" : "") + ln; else break; }
  return { text: out, hit: keep.length };
}

// ═══════════ step4+5（2026-09-03 按项目分格，P1-1 节感知切片）═══════════
// 当日文件分格结构：
//   ## 项目块：<key>        ← 项目格（intent 检查点 + 项目当日要点）
//   ## 通用块               ← 未命中任何项目的会话内容
//   <!-- compaction: ... --> ← dump 资产（尾区，非任何格）
// 本区纯函数：解析/切片/迁移确定性逻辑，零 fs 零宿主依赖（单测直接抓取）。
const PROJECT_BLOCK_RE = /^##\s*项目块[：:]\s*(.+?)\s*$/;
const GENERAL_BLOCK_RE = /^##\s*通用块\s*$/;
const DUMP_MARK_RE = /^\s*<!--\s*compaction:/;
const ARCHIVE_BLOCK_RE = /^##\s*漏网会话补档/;   // v2.5.2（F5a）：归档节可寻址（staleArchive EOF 追加，同日多轮=多个归档段）

// 把当日文件文本切成有序段：{ kind: "project"|"general"|"dump"|"other", key?, lines[] }
function parseDailySections(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const ln of String(text || "").split("\n")) {
    const pm = ln.match(PROJECT_BLOCK_RE);
    const gm = GENERAL_BLOCK_RE.test(ln);
    const dm = DUMP_MARK_RE.test(ln);
    const am = ARCHIVE_BLOCK_RE.test(ln);   // v2.5.2（F5a）：漏网会话补档独立成段
    if (pm) { flush(); cur = { kind: "project", key: pm[1].trim(), lines: [ln] }; continue; }
    if (gm) { flush(); cur = { kind: "general", key: "", lines: [ln] }; continue; }
    if (dm) { flush(); cur = { kind: "dump", key: "", lines: [ln] }; continue; }
    if (am) { flush(); cur = { kind: "archive", key: "", lines: [ln] }; continue; }
    if (cur) cur.lines.push(ln);
    else { flush(); cur = { kind: "other", key: "", lines: [ln] }; }   // 文件头无块内容归 other（常见于旧格式/迁移前）
  }
  flush();
  return out;
}
    // v2.5.2（评审 P0-1/P2 修订）：intent 三节白名单提为模块级共享常量（stripIntentBlocksForCount /
    //   stripOldIntentBlocks / mergeIntoGeneralBlock 三处同源，杜绝口径漂移）+ 正文提取（剥前言）
    const OWN_SECTIONS = /^##\s*(检查点（|本次目标|下一步行动|关键结论)/;
    // v2.5.2（F1′）：剥子代理输出前言（「已核对记忆库…」类开场白）至正文起点；找不到 marker 或 i===0 原样返回
    //   ——维持「判 malformed/break」的现状语义，不改变无前言路径行为（零退化）
    function extractBodyFromMarker(text) {
      const s = String(text || "");
      const i = s.indexOf("## 本次目标");
      return i > 0 ? s.slice(i) : s;
    }
    function isDailySectioned(text) {
  // 按行扫描判断（$ 无 m 标志只匹配串尾，多行文本需逐行判）——内联正则不依赖跨函数常量
  const t = String(text || "");
  for (const ln of t.split("\n")) {
    if (/^##\s*项目块[：:]/.test(ln) || /^##\s*通用块\s*$/.test(ln.trim())) return true;
  }
  return false;
}

// v2.5.3（评审 B4）：整文件覆盖闸是否需要的判别——分格写回=mergeIntoGeneralBlock，不消费任何保留内容
//   （删除权威=F4 collectRemovableDayHeaders 逐节校验 + I1 宁残留不误删）；整文件覆盖闸只服务未分格
//   破坏性写回（finalText = block + dumps，b76ddcb5 防线）。调用点必须传 existing（与写回分支同判别器，
//   评审 B1：闸判别与写回判别必须同源同输入）。
function maintWholeFileCoverageRequired(text) { return !isDailySectioned(text); }

// v2.4.30（maint topic-lost 口径修复，用户拍板方案 A）：剥离项目格后返回剩余文本。
// 用途：合并维护的主题覆盖校验输入——分格文件的项目格由写回 mergeIntoGeneralBlock 原样保留
// （不依赖子代理输出覆盖），校验若含项目格会假阳性 topic-lost（实证 2026-09-04 今日文件
// 3ab5ce7d intent 在项目格内连 3 次拦截 → 熔断机械收敛）。故校验输入须只含「将被替换的通用块」。
// 未分格文件 parseDailySections 无 project 段 → 原样返回（零退化）。
function stripProjectBlocksForCoverage(text) {
  const t = String(text || "");
  if (!isDailySectioned(t)) return t;   // 未分格零退化
  const secs = parseDailySections(t);
  return secs.filter((s) => s.kind !== "project").map((s) => s.lines.join("\n")).join("\n").trim();
}

// 节感知项目切片：分格文件只取命中项目的格（行级剥离同旧逻辑）；未命中 → 通用块（若无通用块 → 空+hit0）。
// 非分格文件（旧格式/新装未迁移）→ 回退 projectSummarySlice 原逻辑（有块用新、无块用旧，零退化）。
function projectSummarySliceSectioned(text, key, aliases, budgetChars) {
  if (!isDailySectioned(text)) return projectSummarySlice(text, key, aliases, budgetChars);
  const words = [String(key || ""), ...(Array.isArray(aliases) ? aliases : [])]
    .map((w) => String(w || "").toLowerCase()).filter((w) => w && w.length >= 2);
  const secs = parseDailySections(text);
  const pick = secs.filter((s) => s.kind === "project" && words.some((w) => s.key.toLowerCase().includes(w)));
  const src = pick.length > 0
    ? pick.map((s) => s.lines.join("\n")).join("\n")
    : secs.filter((s) => s.kind === "general" || s.kind === "archive").map((s) => s.lines.join("\n")).join("\n");   // v2.5.2（F5a 涟漪②续）
  if (!src.trim()) return { text: "", hit: 0 };
  const keep = [];
  for (const ln of src.split("\n")) {
    const t = ln.trim();
    if (!t || /^##\s*项目块|^##\s*通用块/.test(t)) continue;
    if (words.some((w) => t.toLowerCase().includes(w))) keep.push(t);
  }
  if (keep.length === 0) return { text: "", hit: 0 };
  let out = "";
  for (const ln of keep) { if (out.length + ln.length + 1 <= budgetChars) out += (out ? "\n" : "") + ln; else break; }
  return { text: out, hit: keep.length };
}

// step4+5（2026-09-03）：旧格式（intent 块+要点+dump 平铺）→ 分格结构迁移。纯代码幂等：
//   - 已有分格结构（含 ## 项目块/通用块）→ 原样返回（幂等）
//   - 旧格式 → intent 块与「当日要点/手工内容」归通用块；compaction dump 尾区原样保留
// 归属判定确定性边界（审查 P1-2）：intent 只带 sid、无 cwd，历史块一律进通用块；新会话由 spawnIntentCheckpoint 按 cwd 归格。
function partitionDailyFile(text) {
  const t = String(text || "");
  if (!t.trim()) return { text: "", migrated: false };
  if (isDailySectioned(t)) return { text: t, migrated: false };   // 幂等：已分格不动
  const secs = parseDailySections(t);
  const genLines = [];
  const dumpLines = [];
  for (const s of secs) {
    if (s.kind === "dump") dumpLines.push(...s.lines);
    else genLines.push(...s.lines);
  }
  const body = genLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const out = ["## 通用块", ""];
  if (body) out.push(body);
  if (dumpLines.length) { out.push("", ...dumpLines); }
  return { text: out.join("\n") + "\n", migrated: true };
}

// step4+5（2026-09-03）：intent 检查点按格插入（4b 写入侧）。分格文件把新 block 插到目标格头部
//   （sectionKey 非空 → 项目块；空 → 通用块；目标格不存在则建）；未分格文件先迁移再按通用格处理。
//   旧 intent 剥离语义不变（全局至多 3 块，strip 由调用方 stripOldIntentBlocks 处理——本函数只管落格位置）。
//   纯函数，返回 { text }。
function insertIntentToSection(text, block, sectionKey) {
  let t = String(text || "");
  if (!isDailySectioned(t)) { const m = partitionDailyFile(t); t = m.text; }
  const key = String(sectionKey || "").trim();
  const header = key ? "## 项目块：" + key : "## 通用块";
  const secs = parseDailySections(t);
  const out = [];
  let inserted = false;
  for (const s of secs) {
    if (!inserted && (s.kind === "project" && key && s.key === key) || (s.kind === "general" && !key)) {
      // 该格头插入新 block（格头 = 块标题行之后第一行）
      const head = s.lines[0];
      out.push(head, "", block.trim(), "");
      out.push(...s.lines.slice(1));
      inserted = true;
    } else {
      out.push(...s.lines);
    }
  }
  if (!inserted) {
    // 目标格不存在 → 追加新块（项目块在通用块前；通用块在末尾、dump 之前）
    if (key) {
      const hasGeneral = secs.some((s) => s.kind === "general");
      if (hasGeneral) {
        const genIdx = secs.findIndex((s) => s.kind === "general");
        const prefix = secs.slice(0, genIdx).map((s) => s.lines.join("\n")).join("\n");
        const suffix = secs.slice(genIdx).map((s) => s.lines.join("\n")).join("\n");
        return { text: (prefix ? prefix + "\n\n" : "") + header + "\n\n" + block.trim() + "\n\n" + suffix.replace(/\n{3,}/g, "\n\n") + "\n" };
      }
    }
    out.push(header, "", block.trim());
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n" };
}

// step4+5（2026-09-03，4b maint 单格写回）：分格文件的合并维护结果并入通用块（不拍平项目格/dump）。
//   通用块 = 原 intent 子块 + merged 当日要点（去重：同标题当日要点替换）；项目块、dump 段原样保留。
//   未含通用块 → 追加一个通用块承接。纯函数，返回新文本。
function mergeIntoGeneralBlock(text, mergedBlock, dumps, opts) {
  const t = String(text || "");
  const secs = parseDailySections(t);
  const out = [];
  let mergedInto = false;
  const removable = (opts && opts.removableHeaders) || null;   // v2.5.2（F4）：Set<节头trim>——调用点已验证被 merged 覆盖才可删
  for (const s of secs) {
    if (s.kind === "general") {
      // 通用块：保留 intent 子块，替换「当日要点」为 mergedBlock 正文；rest 按 removableHeaders 删/留（显式策略）
      const sLines = s.lines;
      const keepIntent = [];
      const restLines = [];
      let cur = null;
      let _fence = null;   // v2.5.2（F4）：H2 终止带围栏跟踪（intent 三节内 fenced 代码块里的 ## 行不得判边界）
      const MARK = /^<!-- intent: [0-9a-zA-Z-]{8,}(?: sid:(\S+?))? -->/;
      for (const ln of sLines.slice(1)) {
        const mm = ln.match(MARK);
        if (mm) { cur = { lines: [ln] }; keepIntent.push(cur); continue; }
        if (cur && /^\s*<!-- /.test(ln)) { cur = null; restLines.push(ln); continue; }
        const _f1 = fenceStep(ln, _fence); _fence = _f1[0];
        // v2.5.2（F4 核心）：H2 感知终止（白名单=三节/检查点标题）——旧实现只有 <!-- 终止，最后 intent 粘住 EOF 前全部
        //   内容（旧要点节+归档节随 keepIntent 永久保留、文件单调增长；真码仿真 7001 复现 2026-09-09）
        if (cur && !_fence && /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln) && !OWN_SECTIONS.test(ln)) { cur = null; restLines.push(ln); continue; }
        if (cur) cur.lines.push(ln); else restLines.push(ln);
      }
      // v2.5.2（F4）：restLines 显式分流——removableHeaders 命中的整节删除，其余（归档/未覆盖旧节/手工内容）保留（I1 零丢失）
      let keptRest = restLines;
      if (removable && restLines.length > 0 && removable.size > 0) {
        const kept = [];
        let seg = null;
        const flushSeg = () => { if (seg) { if (!seg.drop) kept.push(seg.lines.join("\n")); seg = null; } };
        let _fence2 = null;
        for (const ln of restLines) {
          const _fr = fenceStep(ln, _fence2); _fence2 = _fr[0];   // v2.5.2（T3）：围栏内不判节边界
          // 仅「非白名单中文 H2」开新段（三节/检查点标题属当前段内容，否则删节时正文泄漏成保留碎片）
          const isSecStart = /^##\s/.test(ln) && !_fence2 && !/^##\s*[A-Za-z]/.test(ln) && !OWN_SECTIONS.test(ln);
          if (isSecStart) { flushSeg(); seg = { lines: [ln], drop: removable.has(ln.trim()) }; }
          else if (seg) seg.lines.push(ln);
          else kept.push(ln);
        }
        flushSeg();
        keptRest = kept;
      }
      const intentTxt = keepIntent.map((b) => b.lines.join("\n")).join("\n\n");
      const bodyLines = [s.lines[0]];
      if (intentTxt) bodyLines.push("", intentTxt);
      // mergedBlock 已是「## 当日要点（…维护合并）\n\n正文」——直接作为通用块要点追加
      bodyLines.push("", mergedBlock);
      // v2.5.2（F4）：显式排序——要点节在前、保留 rest（归档等）在后（不靠 out.join 文件顺序巧合）
      if (keptRest.length) bodyLines.push("", keptRest.join("\n"));
      out.push(bodyLines.join("\n"));
      mergedInto = true;
    } else if (s.kind === "dump") {
      out.push(s.lines.join("\n"));
    } else {
      out.push(s.lines.join("\n"));
    }
  }
  if (!mergedInto) {
    out.push("## 通用块", "", mergedBlock);
  }
  const dumpsTxt = dumps ? (dumps.trim() ? "\n\n" + dumps.trim() : "") : "";
  // v2.5.2（T6/I4）：尾部空行归一化为单个 \n——原实现每次合并尾部 +1 空行（归档节尾随空行每轮累积，幂等被破坏）
  return (out.join("\n\n").replace(/\n{3,}/g, "\n\n") + dumpsTxt).replace(/\n+$/, "") + "\n";
}

function seedProjectMarker(rootDir, key, file) {   // 同内容不重写（P0-5）；key 漂移不覆盖
  try {
    const d = portable(String(rootDir || "")).replace(/\/+$/, "");
    if (!d) return { ok: false };
    const mf = d + "/~dsh/project.json";
    let co = null;
    try { co = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (eR) {}
    if (co && typeof co === "object") {
      if (co.key === key && co.file === file) return { ok: false, wrote: false };
      if (typeof co.key === "string" && co.key && co.key !== key) return { conflict: mf };
    }
    fs.mkdirSync(d + "/~dsh", { recursive: true });
    const next = JSON.stringify({ version: 1, key: key, file: file, createdAt: (co && co.createdAt) || Date.now(), updatedAt: Date.now() }, null, 2);
    const tmp = mf + ".tmp" + Date.now();
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, mf);
    return { ok: true, wrote: true };
  } catch (e) { return { ok: false }; }
}
function isDeepEnoughRoot(rootDir) {   // P1 高根护栏：至少 C:/Users/Starry/x（4 段）才自动补种
  return portable(String(rootDir || "")).split("/").filter(Boolean).length >= 4;
}
function normCwd(c) { return String(c || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, ""); }
function readProjectIndex() {
  const pj = portable(MEMORY_ROOT + "/projects/_index.json");
  try {
    const raw = fs.readFileSync(pj, "utf8");
    let j = null; let parseOk = true;
    try { j = JSON.parse(raw); } catch (eP) { parseOk = false; }
    if (parseOk && j && Array.isArray(j.projects)) return j;
    if (raw && raw.trim()) { try { fs.copyFileSync(pj, pj + ".corrupt-" + Date.now()); } catch (e2) {} }   // v2.4.18（P2-13）：损坏先备份再重建，登记数据不静默丢（parse 失败也备份）
  } catch (e) {}
  const j2 = { version: 1, projects: [] };
  try {
    for (const f of fs.readdirSync(portable(MEMORY_ROOT + "/projects"))) {
      if (!/\.md$/.test(f) || /^_/.test(f) || ONE_DRIVE_CONFLICT_RE.test(f)) continue;
      j2.projects.push({ key: f.replace(/\.md$/, ""), display: f.replace(/\.md$/, ""), file: f, workdirs: [], updatedAt: 0 });
    }
  } catch (e2) {}
  try { writeProjectIndex(j2); } catch (e3) {}
  return j2;
}
// v2.4.18（P0-2）：唯一写盘帮助函数——内容实质变化才落盘（防 mtime churn）+ 临时文件原子 rename（防 OneDrive 冲突副本）
function writeProjectIndex(idx) {
  const pj = portable(MEMORY_ROOT + "/projects/_index.json");
  const next = JSON.stringify(idx, null, 2);
  try {
    const cur = fs.readFileSync(pj, "utf8");
    if (cur === next || cur === next + "\n" || cur === next + "\r\n") return false;
  } catch (e) {}
  const tmp = pj + ".tmp" + Date.now() + ".json";
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, pj);
  return true;
}
// v2.4.18（D1/P1-5）：命中账本——同日不写盘；仅健康条目（stale 不记命中）
function touchProjectHit(idx, prKey, todayS) {
  try {
    const pr = (idx.projects || []).find((p) => p.key === prKey);
    if (!pr || pr.stale) return false;
    if (pr.lastHitAt === todayS) return false;
    pr.lastHitAt = todayS;
    return writeProjectIndex(idx);
  } catch (e) { return false; }
}
// v2.4.18（P1-6）：短编辑距离（中文按字符；长度差剪枝——超阈值直接返回阈值+1）
function levDist(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  if (Math.abs(m - n) > RENAME_SIM_THRESHOLD) return RENAME_SIM_THRESHOLD + 1;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1); cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
// v2.4.18（P2-x workdirs 体检与改名保护，dream 发起时巡检；P0-2 有变化才写）：
// 返回 { removed, added, staleOrphans, deadWorkdirs, renameHints, longIdle, unregistered, changed, broadcastText, needBroadcast }
// 只报不修：失效目录/孤儿/改名均提示，不自动删不自动迁（防误伤；修复由用户按报告确认）
function reconcileProjectIndex() {
  const report = { removed: [], added: [], staleOrphans: [], deadWorkdirs: [], renameHints: [], longIdle: [], unregistered: [], markerStale: [], markerBad: [], markerConflict: [], changed: false, broadcastText: "", needBroadcast: false };
  try {
    const idx = readProjectIndex();
    const files = fs.readdirSync(portable(MEMORY_ROOT + "/projects"))
      .filter((f) => /\.md$/.test(f) && !/^_/.test(f) && !ONE_DRIVE_CONFLICT_RE.test(f));
    const known = new Set(idx.projects.map((pr) => pr.file));
    // ① 新增 .md 补条目（排除冲突副本）
    for (const f of files) {
      if (known.has(f)) continue;
      idx.projects.push({ key: f.replace(/\.md$/, ""), display: f.replace(/\.md$/, ""), file: f, workdirs: [], updatedAt: 0 });
      report.added.push(f); report.changed = true;
    }
    // ② 逐条目：孤儿分类保护 / stale 复位 / workdirs 体检 / longIdle / unregistered
    const kept = [];
    for (const pr of idx.projects) {
      const wds = Array.isArray(pr.workdirs) ? pr.workdirs : [];
      const fileExists = files.indexOf(pr.file) >= 0;
      if (!fileExists) {
        if (wds.length > 0) {
          // 人工登记过 → 保护保留 + stale（P1-9/P2 场景）；不静默剔（修复=用户确认报告后更新 file 或删条目）
          pr.stale = true;
          report.staleOrphans.push({ key: pr.key, display: pr.display, file: pr.file });
          report.changed = true; kept.push(pr);
        } else {
          report.removed.push(pr.file); report.changed = true;   // 空孤儿（自动补条产物）按现状剔
        }
        continue;
      }
      if (pr.stale) { delete pr.stale; report.changed = true; }   // P1-9：文件回归 → 复位，恢复命中
      if (wds.length === 0) {
        report.unregistered.push({ key: pr.key, display: pr.display });   // P1-11：文件在盘但从未登记目录
      } else {
        for (const w of wds) {
          try {
            if (!fs.existsSync(portable(w))) report.deadWorkdirs.push({ key: pr.key, display: pr.display, workdir: w });   // P1-8 逐条目隔离：异常=unknown 不中断不误报
          } catch (eD) {}
        }
        // P0-3：lastHitAt undefined = 未知不判 longIdle（防升级首轮批量误报）；P1-10：stale 已排除
        if (typeof pr.lastHitAt === "string" && pr.lastHitAt.length) {
          const days = Math.floor((Date.now() - new Date(pr.lastHitAt + "T00:00:00").getTime()) / 86400000);
          if (days > WORKDIRS_STALE_DAYS) report.longIdle.push({ key: pr.key, display: pr.display, lastHitAt: pr.lastHitAt, days });
        }
      }
      kept.push(pr);
    }
    idx.projects = kept;
    // ③ 改名线索（P1-6：与磁盘现存全部文件名相似度配对——存量跨轮也生效，不依赖"本轮新增"）
    if (report.staleOrphans.length > 0) {
      for (const so of report.staleOrphans) {
        const ok = String(so.key);
        let best = null, bestD = RENAME_SIM_THRESHOLD + 1;
        for (const f of files) {
          const nk = f.replace(/\.md$/, "");
          if (nk === ok) continue;
          const d = nk.includes(ok) || ok.includes(nk) ? 0 : levDist(ok, nk);
          if (d < bestD) { bestD = d; best = f; }
        }
        if (best && bestD <= RENAME_SIM_THRESHOLD) report.renameHints.push({ oldFile: so.file, newFile: best });
      }
    }
    // ④ v2.4.19 标记补种（评审 P0-2/4/5 + P1 护栏）：索引外副作用，独立于 changed；root=条目 root 字段 || workdirs[0] 绝对化；
    //    锚定规则：绝对路径 + 在盘 + 层级够（≥4 段） + 非冲突副本目录才种；相对路径（如 "agent周事项/插件开发调整"）跳过（P0-2 锚点崩塌修复）。
    //    已在且同内容 → 不重写；file 漂移 → 更新（key 保留）；key 漂移（用户善意编辑）→ 不覆盖记 markerConflict；损坏 → .corrupt 备份后重种。
    for (const pr of kept) {
      const wds0 = Array.isArray(pr.workdirs) && pr.workdirs.length ? pr.workdirs[0] : "";
      const root = String(pr.root || wds0 || "").replace(/\\/g, "/").replace(/\/+$/, "");
      if (!/^[A-Za-z]:\//.test(root)) continue;            // 相对路径跳过
      if (!isDeepEnoughRoot(root)) continue;                // 高根护栏（P1）
      if (ONE_DRIVE_CONFLICT_RE.test(root)) continue;       // 冲突副本目录（P1）
      let realRoot = root;
      try { if (!fs.existsSync(realRoot)) continue; } catch (eE) { continue; }
      const mk = readProjectMarker(realRoot + "/~dsh/project.json");
      if (mk && mk.key) {
        if (mk.key !== pr.key) { report.markerConflict.push({ path: realRoot, key: mk.key, expect: pr.key }); }
        else if (mk.file !== pr.file) {   // file 漂移 → 更新标记（P0-5）
          try {
            const o = JSON.parse(fs.readFileSync(realRoot + "/~dsh/project.json", "utf8"));
            o.file = pr.file; o.updatedAt = Date.now();
            const tmp = realRoot + "/~dsh/project.json.tmp" + Date.now();
            fs.writeFileSync(tmp, JSON.stringify(o, null, 2), "utf8");
            fs.renameSync(tmp, realRoot + "/~dsh/project.json");
          } catch (eF) {}
        }
      } else if (mk && mk.bad) {
        report.markerBad.push({ path: realRoot });          // 损坏：报告 + 备份后重种（防覆盖用户手工编辑）
        try { fs.copyFileSync(realRoot + "/~dsh/project.json", realRoot + "/~dsh/project.json.corrupt-" + Date.now()); } catch (eB) {}
        seedProjectMarker(realRoot, pr.key, pr.file);
      } else {
        seedProjectMarker(realRoot, pr.key, pr.file);       // 缺失 → 补种（内容 diff 幂等）
      }
    }
    // ⑤ 报告去重 + 广播文案（P1-4/P1-7）：audit 内容 hash 存 lastAuditHash，仅变化才 needBroadcast
    const hasAudit = report.staleOrphans.length > 0 || report.deadWorkdirs.length > 0 || report.renameHints.length > 0 || report.longIdle.length > 0 || report.unregistered.length > 0 || report.markerStale.length > 0 || report.markerBad.length > 0 || report.markerConflict.length > 0;
    if (hasAudit) {
      const aKey = JSON.stringify({ s: report.staleOrphans.map((x) => x.key), d: report.deadWorkdirs.map((x) => x.key + "|" + x.workdir), r: report.renameHints.map((x) => x.oldFile + "->" + x.newFile), l: report.longIdle.map((x) => x.key), u: report.unregistered.map((x) => x.key), ms: report.markerStale.map((x) => x.key), mb: report.markerBad.map((x) => normCwd(x.path)), mc: report.markerConflict.map((x) => normCwd(x.path) + "|" + x.key + "->" + x.expect) });
      const aHash = createHash("sha256").update(aKey).digest("hex").slice(0, 16);
      if (idx.lastAuditHash !== aHash) {
        idx.lastAuditHash = aHash; report.changed = true;
        const parts = [];
        if (report.staleOrphans.length) parts.push("孤儿保留 " + report.staleOrphans.length);
        if (report.deadWorkdirs.length) parts.push("失效目录 " + report.deadWorkdirs.length + "（" + report.deadWorkdirs.slice(0, 2).map((d) => d.workdir).join("、") + (report.deadWorkdirs.length > 2 ? "…" : "") + "）");
        if (report.renameHints.length) parts.push("疑似改名 " + report.renameHints.length + "（" + report.renameHints.slice(0, 2).map((h) => h.oldFile + "→" + h.newFile).join("、") + (report.renameHints.length > 2 ? "…" : "") + "）");
        if (report.longIdle.length) parts.push("长期未命中 " + report.longIdle.length);
        if (report.unregistered.length) parts.push("未登记目录 " + report.unregistered.length);
        if (report.markerStale.length) parts.push("标记失效 " + report.markerStale.length);
        if (report.markerBad.length) parts.push("标记损坏 " + report.markerBad.length);
        if (report.markerConflict.length) parts.push("标记冲突 " + report.markerConflict.length);
        report.broadcastText = "【项目索引体检】" + parts.join("；");
        report.needBroadcast = true;
      }
    }
    // ⑥ 落盘（P0-2：有实质变化才写；标记补种为索引外副作用不触发）
    if (report.changed) writeProjectIndex(idx);
  } catch (e) {
    clog("[dsh-memory] 项目索引巡检异常: " + (e && e.message ? e.message : String(e)));
  }
  return report;
}

function matchProjectByCwd(cwd) {
  const nc = normCwd(cwd);
  const idx = readProjectIndex();
  const hits = []; const staleHits = [];   // v2.4.18（P0-1）：健康与 stale 分桶——stale 仅作注入回退（文件复原即恢复），不参与正常命中/通知
  if (nc) {
    for (const pr of idx.projects) {
      if (!Array.isArray(pr.workdirs)) continue;
      let m2 = false;
      for (const w of pr.workdirs) {
        const nw = normCwd(w);
        // v2.4.23b（高层误命中修复）：仅 cwd 在项目目录内（nc 包含 nw）才命中；反向 nw.includes(nc) 会让
        //    Desktop/盘根等高层 cwd 命中全部项目（实测 C:\ 命中 5 个）——该项目目录之上开会话不应注入项目切片
        if (nw && nc.includes(nw)) { m2 = true; break; }
      }
      if (!m2) continue;
      if (pr.stale) staleHits.push(pr); else hits.push(pr);
    }
  }
  // v2.4.19（标记优先合成，评审 P0-1/3）：注入候选 = workdirs 语义 ∪ 标记语义；标记命中置顶，账本零改动复用
  const marker = findProjectMarker(cwd);
  const meta = { markerKey: "", markerStale: false, markerBad: false, markerConflict: false };
  if (marker && marker.key) {
    meta.markerKey = String(marker.key);
    const mpr = (idx.projects || []).find((p) => p.key === marker.key);
    if (mpr) {
      const bucket = mpr.stale ? staleHits : hits;
      const inWd = bucket.indexOf(mpr) >= 0;
      if (inWd) { bucket.splice(bucket.indexOf(mpr), 1); bucket.unshift(mpr); }   // 与 workdirs 一致 → 置顶
      else if (hits.length > 0 || staleHits.length > 0) { meta.markerConflict = true; }   // 冲突（P0-1 裁决）：保守注入 workdirs + 报告
      else { bucket.unshift(mpr); }   // 仅标记命中 → 注入标记条目
    } else {
      meta.markerStale = true;   // 失效：仅报告（节流）+ workdirs 回退注入（P0-1，禁止静默功能回归）
    }
  } else if (marker && marker.bad) {
    meta.markerBad = true;   // 损坏：视为无标记，注入回退；reconcile 备份后重种
  }
  return { hits: hits, staleHits: staleHits, index: idx, marker: meta };
}

function normalizeErrorSigFromRaw(raw) {
  const unwrapped = String(raw || "").slice(0, 300)
    .replace(/^Error:\s*code run failed \(exception\):\s*/i, "")
    .replace(/^ToolCallError:\s*/i, "")
    .replace(/^Error:\s*/i, "");
  if (!unwrapped.trim()) return null;
  return {
    disp: unwrapped.slice(0, 80),
    sig: unwrapped.replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 150)
  };
}

// v2.4.16(lesson 强制表态)：解析子代理 Output 的 lesson-dealt:L1(沉淀),L2(拒绝) 表态清单。
// 返回 Map<idx, "沉淀"|"拒绝">（idx 大写 L#）；无 lesson-dealt 段/格式不符 → 空 Map（由结算按「未表态」计数）。
function parseLessonDealtMarkup(outText) {
  const dealt = new Map();
  const dm = String(outText || "").match(/lesson-dealt\s*:\s*[^\n]*/gi) || [];
  for (const m of dm) {
    const body = m.replace(/lesson-dealt\s*:\s*/i, "");
    for (const pair of body.matchAll(/L\d+\((?:沉淀|拒绝)\)/g)) {
      const mm = /(L\d+)\((沉淀|拒绝)\)/.exec(pair[0]);
      if (mm) dealt.set(mm[1].toUpperCase(), mm[2]);
    }
  }
  return dealt;
}

// v2.4.16(lesson 强制表态)：一轮投喂候选的结算纯计算（验收 P1-1 集成可测化——副作用归调用方）。
// 输入 feed（本轮候选 idx/sig/sessionId）、wrote（本轮真实写入缓冲）、outText（子代理 Output）、entries（台账）：
//   - lesson-skip 点名 或 lesson-dealt 标 拒绝 → skipped；
//   - 其余候选：未表态（无 dealt 行）计 unstated；写入证据归一化前缀命中 → fed（未表态但写入命中仍算沉淀，防重复沉淀）；
//     未命中 → refeed（回滚重喂；短 sig <40 拒验直接 refeed）。
// 返回 { fed, skipped, refeed, unstated, actions:[{idx,sig,action,entry}] }；副作用（lessonEvent/落盘/转播）由 settleDream 按 actions 执行。
function settleLessonRound(input) {
  const feed = Array.isArray(input.feed) ? input.feed : [];
  const outText = String(input.outText || "");
  const wrote = Array.isArray(input.wrote) ? input.wrote : [];
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const result = { fed: 0, skipped: 0, refeed: 0, unstated: 0, actions: [] };
  if (!feed.length) return result;
  const skipSet = new Set();
  const sm = outText.match(/lesson-skip\s*:\s*([A-Za-z0-9,\s]+)/gi) || [];
  for (const m of sm) {
    const ids = m.replace(/lesson-skip\s*:\s*/i, "");
    for (const id of ids.split(/[,\s]+/)) {
      const t = String(id || "").trim().toUpperCase();
      if (/^L\d+$/.test(t)) skipSet.add(t);
    }
  }
  const dealtSet = parseLessonDealtMarkup(outText);
  for (const [idx, act] of dealtSet) { if (act === "拒绝") skipSet.add(idx); }
  const normBuf = [];
  for (const w of wrote) {
    const n = normalizeErrorSigFromRaw(w && w.content);
    if (n && n.sig) normBuf.push(n.sig);
  }
  for (const f of feed) {
    const idx = "L" + f.idx;
    const entry = entries.find((e) => e.sig === f.sig && e.sessionId === f.sessionId);
    if (skipSet.has(idx)) { result.skipped += 1; result.actions.push({ idx, sig: f.sig, action: "skip" }); continue; }
    if (!dealtSet.has(idx)) result.unstated += 1;   // 未表态（无任何处置痕迹）
    const sigN = String(f.sig || "");
    let hit = false;
    if (sigN.length >= 40) {                          // 短 sig 拒验→重喂
      const anchor = sigN.slice(0, 60);
      for (const nb of normBuf) { if (nb.indexOf(anchor) >= 0) { hit = true; break; } }
    }
    if (hit) { result.fed += 1; result.actions.push({ idx, sig: f.sig, action: entry ? "archive" : "fed", entry }); }
    else { result.refeed += 1; result.actions.push({ idx, sig: f.sig, action: "refeed", entry }); }
  }
  return result;
}

// 受限上下文捕捉（P0b：B/C 触发时落盘）。字段对齐 4.2 条目 context{ tool,args,error }；
// context 总长 ≤ LESSON_CTX_MAX；args/error 各 ≤200 字符。ECHO 去重由调用点（B/C 分支）负责。
function captureLessonContext(sig, sid, toolName, args, errTxt, now) {
  let aTxt = "";
  try { aTxt = String(typeof args === "string" ? args : JSON.stringify(args) || ""); } catch (e) { aTxt = ""; }
  aTxt = aTxt.replace(/\s+/g, " ").slice(0, LESSON_ARG_MAX);
  let eTxt = String(errTxt || "").replace(/\s+/g, " ").slice(0, LESSON_ERR_MAX);
  const ctx = { tool: String(toolName || "other").slice(0, 40), args: aTxt, error: eTxt };
  // 总长硬钳（防 400+200+200 组合超限）
  while (ctx.args.length + ctx.error.length + 40 > LESSON_CTX_MAX && (ctx.args.length > 0 || ctx.error.length > 0)) {
    if (ctx.args.length > ctx.error.length) ctx.args = ctx.args.slice(0, Math.max(0, ctx.args.length - 40));
    else ctx.error = ctx.error.slice(0, Math.max(0, ctx.error.length - 40));
  }
  const e = lessonUpsertOpen(sig, sid, ctx, now || Date.now());
  return e;
}

// 被动监测（P0b：每轮 tools/result 调用）。成功轮 sigSet 恒空 → 推进 cleanSteps + 捕捉 solution；
// 失败轮 sigSet=[该轮 sig] → 再现归零。仅顶层会话轮次推进（sid 精确匹配条目）。
// 返回 { closed:[entry], resurrected:[entry] }，供调用点记 monitor 事件。
function lessonObserveStep(sid, toolName, isError, sig, resultOkTxt, now) {
  try {
    if (PLUGIN_CFG.regressionEnabled === false) return { closed: [], resurrected: [] };
    const t = now || Date.now();
    const P = readLessonPending();
    const mine = P.entries.filter((e) => e.sessionId === sid && (e.state === "open" || e.state === "resolved"));
    let sigSet;
    if (!isError) {
      sigSet = new Set();
      // 成功轮：记录最后一次成功调用的参数/结果摘要为 solution（仅对 open 条目，同 tool 优先更新）
      const okTxt = String(resultOkTxt || "").replace(/\s+/g, " ").slice(0, LESSON_SOLUTION_MAX);
      for (const e of mine) {
        if (e.state !== "open") continue;
        const sameTool = e.context && e.context.tool === toolName;
        if (!e.solution || sameTool) {
          e.solution = { at: t, summary: okTxt, tool: toolName };
        }
      }
    } else {
      sigSet = new Set(sig ? [sig] : []);
    }
    return lessonObserve(sid, sigSet, t);
  } catch (e) { return { closed: [], resurrected: [] }; }
}
// >>> LESSON_P0A END

// v0.5（P0-2 埋点，2026-09-03 step0）：合并维护样本记录——触发前/后字数 + 结果，落 .monitor.json maintSamples
// （惰性建字段兼容旧数据；与 monitorEvent 同走 scheduleMonitorSave 防抖，不新增定时器；样本滚动 200）
function recordMaintSample(sample) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    if (!Array.isArray(d.maintSamples)) d.maintSamples = [];
    d.maintSamples.push(Object.assign({ t: Date.now() }, sample));
    if (d.maintSamples.length > 200) d.maintSamples = d.maintSamples.slice(-200);
    scheduleMonitorSave();
  } catch (e) { /* 监控失败不影响主功能 */ }
}

// v0.5（2026-09-03 step1 账本闸）：JSON 账本统一读容错——读失败/JSON 损坏时备份 .corrupt 并返回 null
//   （调用方按各自语义回退默认态）；对齐 projects/_index.json 既有损坏先备份惯例（L1272），补齐 .monitor/.inject-state 等
function readLedger(absPath, opts) {
  const o = opts || {};
  try {
    const raw = fs.readFileSync(portable(String(absPath)), "utf8");
    const j = JSON.parse(raw);
    return j;
  } catch (e) {
    try {
      if (o.backupCorrupt) {
        const src = portable(String(absPath));
        fs.copyFileSync(src, src + ".corrupt-" + Date.now());
        cwarn("[dsh-memory] 账本损坏已备份: " + (o.tag || src));
      }
    } catch (e2) { /* 备份失败忽略 */ }
    return null;
  }
}

function monitorEvent(type, detail) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    d.updatedAt = Date.now();
    d.events.push({ t: d.updatedAt, type, detail });
    if (d.events.length > 2000) d.events = d.events.slice(-2000);  // 全量但上限防无限膨胀
    // 防抖写盘：最后一次调用后 500ms 落盘
    scheduleMonitorSave();
  } catch (e) { /* 监控失败不影响主功能 */ }
}

// v2.1.3: 超限告警按文件 60 分钟冷却——多会话并发注入时同一超限重复 cwarn 刷屏（实测 4 秒 22 行）
const SIZE_WARN_LAST_AT = {};
function sizeWarnThrottled(key, msg) {
  const now = Date.now();
  if (now - (SIZE_WARN_LAST_AT[key] || 0) < 3600000) return;
  SIZE_WARN_LAST_AT[key] = now;
  cwarn("[dsh-memory] " + msg);
}

function scheduleMonitorSave() {
  if (MONITOR_DOLLAR) return;
  MONITOR_DOLLAR = true;
  setTimeout(() => {
    MONITOR_DOLLAR = false;
    try {
      const d = readMonitorData();
      fs.mkdirSync(MEMORY_ROOT.split("\\").join("/"), { recursive: true });
      writeFileAtomic(portable(MONITOR_FILE), JSON.stringify(d));   // v0.5（step1 账本闸）：统一原子写
      updateMonitorSummary();
    } catch (e) { /* 写盘失败忽略 */ }
  }, 500);
}

// 更新设置界面的只读汇总字段
function updateMonitorSummary() {
  try {
    const d = readMonitorData();
    const followRate = (d.followed + d.ignored) > 0 ? Math.round((d.followed / (d.followed + d.ignored)) * 100) : null;
    // v2.2.3: 高频领域改近 24h 窗口——byDomain 累计计数会霸榜（老领域永不退位），从 hintA 事件流按时间统计才有近期热点
    const cut24h = Date.now() - 86400000;
    const domain24 = {};
    for (const ev of d.events || []) {
      if (ev.type !== "hintA" || ev.t < cut24h) continue;
      const dm = ev.detail && ev.detail.domain;
      if (dm) domain24[dm] = (domain24[dm] || 0) + 1;
    }
    const topDomains = Object.entries(domain24).sort((a, b) => b[1] - a[1]).slice(0, 7).map(x => x[0]).join(",");
    const eventN = Array.isArray(d.events) ? d.events.length : 0;
    const updD = (d.updatedAt > 0) ? new Date(d.updatedAt) : null;
    const updTxt = updD ? pad(updD.getHours()) + ":" + pad(updD.getMinutes()) : "-";
    // v2.2.0: 统计行通俗化重构——面向使用者：术语改平实书面语、图例并入行内自释、内部参数明细移出（可查 .monitor.json）
    const sumLines = [
      "【记忆运行状况】更新 " + updTxt,
      "提醒统计  关键词命中 " + (d.hints.A || 0) + " · 重复错误 " + (d.hints.B || 0) + " · 连续失败 " + (d.hints.C || 0) + " · 循环空转 " + (d.hints.D || 0) + " · 成功同质 " + (d.hints.E || 0) + " · 无介入 " + (d.hints.W || 0) + " · 熔断动作 " + (d.hints.BRK || 0),
      "使用效果  提醒后回查记忆 " + d.queries + " 次，回查率 " + (followRate !== null ? followRate + "%" : "暂无") + ((d.capped || 0) > 0 ? "（另有 " + d.capped + " 次长任务超出统计窗口，未计入）" : ""),
    ];
    if (topDomains) sumLines.push("高频领域  " + topDomains.split(",").join("、"));
    const mt = d.maintain || {};
    {
      const cut24 = Date.now() - 86400000;
      let aStart = 0, aSettle = 0, aThrottle = 0, aFail = 0;
      for (const ev of d.events || []) {
        if (ev.type !== "archive" || ev.t < cut24) continue;
        const dt = String(ev.detail || "");
        if (dt.indexOf("started") === 0) aStart++;
        else if (dt.indexOf("settled") === 0) aSettle++;
        else if (dt.indexOf("throttled") === 0) aThrottle++;
        else if (dt.indexOf("failed") === 0) aFail++;
      }
      const wanW = (n9) => Math.round((n9 || 0) / 10000);
      let mLine = "维护动作  记忆整合 " + (mt.integRuns || 0) + " 次 · 漏网归档 " + (mt.archRuns || 0) + " 次";
      if (aStart + aThrottle + aFail > 0) mLine += "（近24小时发起 " + aStart + " · 完成 " + aSettle + (aThrottle > 0 ? " · 节流 " + aThrottle : "") + (aFail > 0 ? " · 失败 " + aFail : "") + "）";
      const hitRate = (mt.inT > 0 && typeof mt.cacheT === "number") ? Math.round((mt.cacheT / mt.inT) * 100) : null;   // v2.2.1: cacheT/inT=缓存命中率（totalIn 已含缓存部分）
      mLine += " · token 消耗 输入约 " + wanW(mt.inT) + " 万" + (hitRate !== null ? "（缓存命中 " + hitRate + "%）" : "") + " / 输出约 " + wanW(mt.outT) + " 万";
      sumLines.push(mLine);
    }
    const spirN = Array.isArray(d.spiralEvents) ? d.spiralEvents.length : 0;
    // v2.2.1: 阈值变化情况展示——当前生效值+最近一次调整（替代静态文案）
    const et = effectiveSpiralThresh();
    const calib = Array.isArray(d.spiralThreshLog) && d.spiralThreshLog.length > 0 ? d.spiralThreshLog[d.spiralThreshLog.length - 1] : null;
    let hLine = "运行健康  疑似循环空转告警 " + spirN + " 次 · 空转判定标准 重复占比≥" + Number(et.rep).toFixed(2) + "/负面占比≥" + Number(et.neg).toFixed(2);
    if (calib) {
      const cd2 = new Date(calib.t);
      const chgs = Object.keys(calib.to || {}).map(k => k + " " + ((calib.from || {})[k] !== undefined ? calib.from[k] : "?") + "→" + calib.to[k]).join("、");
      hLine += "（最近调整 " + pad(cd2.getMonth() + 1) + "-" + pad(cd2.getDate()) + " " + chgs + "）";
    } else {
      hLine += "（内置默认值，尚未调整过）";
    }
    sumLines.push(hLine);
    // v2.2.6: 检索健康段——启动自检结果上屏（通过显示对账数字；失败直接给出症状与排查指引）
    if (!RETRIEVAL_SELF) sumLines.push("检索健康  自检尚未完成（启动 3 秒后运行）");
    else if (RETRIEVAL_SELF.ok) sumLines.push("检索健康  通过 · 候选 " + RETRIEVAL_SELF.detail.targets + " 个 · 关键词表 " + RETRIEVAL_SELF.detail.table + " 条 · 索引对账 " + RETRIEVAL_SELF.detail.hit + "/" + RETRIEVAL_SELF.detail.checked);
    else sumLines.push("检索健康  ⚠️ 未通过：" + RETRIEVAL_SELF.msg + "（临时用 read 直查 ~/.dsh/memory/；跑 node _test-retrieval.cjs 排查）");
    // v2.3.0：版本与记忆库状态一行（新装用户未初始化、有新版本都在这看得见）
    try { sumLines.push("版本状态  " + onboardStatusLine() + " · 说「初始化记忆」可手动开始引导，/memory-update 立即查新版"); } catch (e) { sumLines.push("版本状态  v" + PLUGIN_VERSION + "（状态读取失败）"); }
    const s = sumLines.join("\n");
    // v2.3.1：增量视图——只输出标题 + 相对上次有变动的统计行（用户不需要每次看全量）
    const titleLine = sumLines[0];
    const bodyLines = sumLines.slice(1);
    const keyOf = (line) => { const m = /^\S+/.exec(line); return m ? m[0] : line; };
    const nextLines = {};
    for (const l of bodyLines) nextLines[keyOf(l)] = l;
    let sLog = null;
    if (MONITOR_LAST_LINES) {
      const changed = bodyLines.filter((l) => MONITOR_LAST_LINES[keyOf(l)] !== l);
      if (changed.length > 0) sLog = [titleLine, ...changed].join("\n");   // 无任何量变动→静默（仅设置字段更新全量）
    } else {
      sLog = s;
    }
    MONITOR_LAST_LINES = nextLines;
    // v1.12.6：变化守卫 + 60s 节流 —— 内容没变不推；变了但距上次推送 <60s 先不推（每个工具调用都会产生 tool 事件并刷新 updatedAt/eventN），到期自动补推
    if (s === MONITOR_LAST_SUMMARY) return;
    const nowMs = Date.now();
    if (nowMs - MONITOR_LAST_PUSH_AT < 60000) {
      if (!MONITOR_PUSH_TIMER) {
        MONITOR_PUSH_TIMER = setTimeout(() => { MONITOR_PUSH_TIMER = null; updateMonitorSummary(); }, 60000 - (nowMs - MONITOR_LAST_PUSH_AT) + 50);
      }
      return;
    }
    MONITOR_LAST_SUMMARY = s;
    MONITOR_LAST_PUSH_AT = nowMs;
    // v1.12.2: register scope 无 set —— 只有 get/watch/update/replace；update 是异步 merge 写路径
    if (HOST_SETTINGS_SCOPE && typeof HOST_SETTINGS_SCOPE.update === "function") {
      // v2.3.1：日志只输出变动行（sLog）；设置界面 monitorSummary 仍全量 s；无任何量变动 → 静默不打印
      let didLog = false;  // v1.12.9：本次是否打了内容日志（成功回执与之同条件）
      const logSig = sLog !== null ? sLog.split("\n").filter((l) => l.indexOf("累计") !== 0).join(" ⏎ ") : "";
      if (sLog !== null && logSig !== MONITOR_LAST_LOG_SIG) {
        MONITOR_LAST_LOG_SIG = logSig;
        didLog = true;
        clog("[dsh-memory] 推送监控汇总:\n" + sLog);
      }
      Promise.resolve().then(() => HOST_SETTINGS_SCOPE.update({ monitorSummary: s }))
        .then(() => { if (didLog) clog("[dsh-memory] 监控汇总推送成功"); })  // v1.12.9：静默推送完全无声
        .catch((err) => cwarn("[dsh-memory] 监控汇总推送失败:", err && err.message ? err.message : String(err)));
    } else {
      clog("[dsh-memory] 监控汇总未推送: scope=" + (HOST_SETTINGS_SCOPE ? String(typeof HOST_SETTINGS_SCOPE.update) : "null"));
    }
  } catch (e) { cwarn("[dsh-memory] updateMonitorSummary 异常:", e && e.message ? e.message : String(e)); }
}

// A 类提醒：记录 + 打开跟随判定窗口
function monitorHintA(domainName) {
  const d = readMonitorData();
  d.hints.A += 1;
  if (domainName) d.byDomain[domainName] = (d.byDomain[domainName] || 0) + 1;
  d.hintOpen = { kind: "A", type: "A", count: 0 };  // v1.12.15: 窗口至下一条用户输入（上限 20 调用）
  monitorEvent("hintA", { domain: domainName || "?", time: Date.now() });
}

// B/C 类提醒：记录 + 打开跟随判定窗口（v1.12.7：此前只对 A 开窗，跟进率只反映 A 类失真）
function monitorHintBC(type, sig) {
  const d = readMonitorData();
  d.hints[type] = (d.hints[type] || 0) + 1;
  d.hintOpen = { kind: "BC", type: type, count: 0 };  // v1.12.15: 上限 8 调用
  // v2.2.9: 事件携带错误签名（数字已归一化）——否则签名只存活在会话内存 Map，无法离线分析「哪类错误最常重复」
  monitorEvent("hint" + type, { time: Date.now(), sig: String(sig || "").slice(0, 60) });
}

// D 类提醒（LLM循环试错）：记录 + 打开跟随判定窗口（v2.0.2 影子转正；跟随窗口 cap 与 BC 同为 8）
function monitorHintD() {
  const d = readMonitorData();
  d.hints.D = (d.hints.D || 0) + 1;
  d.hintOpen = { kind: "D", type: "D", count: 0 };
  monitorEvent("hintD", { time: Date.now() });
}

// v2.4.30（E 类）：成功同质循环提醒——记录 + 打开跟随判定窗口（与 D 对称；跟随 cap 归 BC 档）
function monitorHintE() {
  const d = readMonitorData();
  d.hints.E = (d.hints.E || 0) + 1;
  d.hintOpen = { kind: "E", type: "E", count: 0 };
  monitorEvent("hintE", { time: Date.now() });
}

// v2.4.30（W 类）：无用户介入长空转看门狗提醒——记录 + 打开跟随判定窗口（同 BC 档 cap）
function monitorHintW() {
  const d = readMonitorData();
  d.hints.W = (d.hints.W || 0) + 1;
  d.hintOpen = { kind: "W", type: "W", count: 0 };
  monitorEvent("hintW", { time: Date.now() });
}

// v2.6.0（D 级打转熔断）：熔断动作计数 + breakerEvents 样本落盘（独立于 D/E/W，防污染 spiralEvents 校准与 hints 口径）
function monitorHintBrk(level, tool, reason, action) {
  try {
    const d = readMonitorData();
    d.hints.BRK = (d.hints.BRK || 0) + 1;
    if (!Array.isArray(d.breakerEvents)) d.breakerEvents = [];
    d.breakerEvents.push({ t: Date.now(), level: level || 2, tool: String(tool || "").slice(0, 40), reason: String(reason || "").slice(0, 60), action: String(action || "deny") });
    if (d.breakerEvents.length > 100) d.breakerEvents = d.breakerEvents.slice(-100);
    monitorEvent("brk", String(action || "deny") + " lv" + (level || 2));
    scheduleMonitorSave();
  } catch (e) {}
}

// 工具调用：记录 memory_search/skill 行为 + 跟随判定
function monitorToolCall(toolName, meta, args, sid) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    if (toolName === "memory_search") {
      d.queries += 1;
      const q = (meta && meta.query) || "";
      d.recentQueries.push({ t: Date.now(), query: String(q).slice(0, 60) });
      if (d.recentQueries.length > 20) d.recentQueries = d.recentQueries.slice(-20);
    }
    // v1.12.15：跟随信号集——①memory_search/skill ②read/grep/glob 目标路径含 .dsh/memory（直读记忆文件是最常见跟随形态）
    const isQuerySignal = toolName === "memory_search" || toolName === "skill";
    let memReadSignal = false;
    if (!isQuerySignal && d.hintOpen && (toolName === "read" || toolName === "grep" || toolName === "glob")) {
      const p = String((args && (args.file_path || args.path)) || "").toLowerCase().replace(/\\/g, "/");
      memReadSignal = p.includes(".dsh/memory");
    }
    // 三态判定：信号命中 → followed；窗口超限 → ignored；未超限 → 保持 open（不计入分母，跨重启续判）
    if (d.hintOpen) {
      if (isQuerySignal || memReadSignal) {
        d.followed += 1;
        d.hintOpen = null;
        const sr = SPIRAL_REMIND_AT.get(sid);
        if (sr) { sr.streak = 0; SPIRAL_REMIND_AT.set(sid, sr); }   // v2.0.6: 提醒奏效立即恢复灵敏度
      } else {
        d.hintOpen.count += 1;
        const cap = d.hintOpen.kind === "A" ? FOLLOW_CAP_A : FOLLOW_CAP_BC;
        if (d.hintOpen.count > cap) {
          d.capped += 1;  // v1.12.16: 超限=窗口被截断（如83调用长轮），非主动忽略
          d.hintOpen = null;
        }
      }
    }
    // v1.12.14: hintOpen 随尾部 monitorEvent 防抖写盘持久化，跨重启续判
    monitorEvent("tool", { name: toolName });
  } catch (e) { /* 忽略 */ }
}

// ── v1.12.16: 过程信号探针（影子模式）─────────────────────────
// v2.0.3: D 类阈值生效值——新安装用户无 spiralThresh 字段 → 全部内置默认（标定值），开箱即用；
// /dream 自校准经 dsh_spiral_thresh 工具写覆盖层，逐字段钳制校验，越界/非法回退默认。
function effectiveSpiralThresh() {
  const t = (MONITOR_DATA && MONITOR_DATA.spiralThresh) || {};
  const num = (v, lo, hi, dft) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi) ? v : dft;
  return {
    rep: num(t.rep, 0.30, 0.80, SPIRAL_REP_TH),
    neg: num(t.neg, 0.20, 0.80, SPIRAL_NEG_TH),
    sim: num(t.sim, 0.50, 0.90, SPIRAL_SIM_TH),
    w: Math.round(num(t.w, 5, 16, SPIRAL_W)),
    cooldownMin: num(t.cooldownMin, 5, 60, 10),
    // v2.4.30（E 类）：sameNeg/sameSteps/sameMinSecs/sameHomo——覆盖层增量合并，缺省回退内置默认
    sameNeg: num(t.sameNeg, 0.10, 0.45, SAME_NEG_TH),
    sameSteps: Math.round(num(t.sameSteps, 3, 10, SAME_STEPS_TH)),
    sameMinSecs: Math.round(num(t.sameMinSecs, 10, 600, SAME_MIN_SECS)),
    sameHomo: num(t.sameHomo, 0.50, 1.00, SAME_HOMO_TH),
    // v2.4.30（W 类看门狗）
    watchSteps: Math.round(num(t.watchSteps, 5, 40, WATCH_STEPS_TH)),
    watchSecs: Math.round(num(t.watchSecs, 30, 1800, WATCH_SECS_TH)),
    watchCooldownMin: Math.round(num(t.watchCooldownMin, 5, 60, WATCH_COOLDOWN_MIN)),
    // v2.6.0（D 级打转熔断）
    brkSameN: Math.round(num(t.brkSameN, 2, 6, BRK_SAME_N)),
    brkMaxDeny: Math.round(num(t.brkMaxDeny, 1, 6, BRK_MAX_DENY)),
    brkMinSteps: Math.round(num(t.brkMinSteps, 1, 5, BRK_MIN_STEPS))
  };
}
// v2.4.30（E 类）：结果归一化指纹——折叠空白 + 时间戳/数字/uuid 占位 + 前后 64 拼接 hash。
// 根治 resKey 前 80 字原文截断的「固定头动态尾虚高 / 时间戳前置虚低 / 模板化两头皆错」三类缺陷（评审 P0-2）。
function resultFingerprint(rTxt) {
  try {
    let s = String(rTxt || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    s = s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#uuid")
      .replace(/\b\d{10,17}\b/g, "#ts")
      .replace(/\b\d{4,}\b/g, "#n")
      .replace(/0x[0-9a-f]+/gi, "#hex");
    const head = s.slice(0, 64), tail = s.slice(-64);
    const body = head + "|" + tail;
    // 简易稳定 hash（djb2）——纯内存用途，无需密码学强度
    let h = 5381;
    for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) >>> 0;
    return h.toString(36);
  } catch (e) { return ""; }
}
// v2.4.30（E 类）：提取 args 重复簇——从窗末（当前步已入窗）逆向往回取与末步 args dice≥sim 的连续步（含末步），遇不相似即停。
function extractArgsCluster(win, aTxt, simTh) {
  const cl = [];
  for (let i = win.length - 1; i >= 0; i--) {
    const w = win[i];
    const sim = diceBigram(aTxt, w.argsTxt);
    if (sim >= simTh) { cl.unshift({ w: w, sim: sim }); continue; }
    break;   // 遇不相似步即停——簇=连续同参数段
  }
  return cl;
}
// 「参数打转 × 无进展」双条件识别原地空转（回测标定：试错链命中、正常翻页不误报）。
// v2.0.2: 样本落盘 spiralEvents/turnProfiles 供阈值调优；周期内首次命中返回 true，
// 由调用点结合 spiralRemind 开关与冷却注入 D 类「LLM循环试错提醒」（关闭=纯影子模式）。
const SPIRAL_W = 8;            // 滑窗大小
const SPIRAL_SIM_TH = 0.7;     // args bigram Dice 相似度阈值（S1）
const SPIRAL_REP_TH = 0.45;    // 窗口内打转占比阈值
const SPIRAL_NEG_TH = 0.4;     // 窗口内负面结果占比阈值（S2）
const SPIRAL_NEG_RE = /error|fail|exception|traceback|eperm|eacces|denied|not found|no such|不存在|失败|无法|超时|timeout|invalid|cannot|could not|refused|abort|证书|cert/i;
const SPIRAL_SKIP = new Set(["job_output", "job_list", "job_kill", "memory_search", "skill", "todo_write", "memory_size_preview"]);  // 轮询/元工具豁免；v2.4.32：preview 是预算测量元工具（P0-5 已接管其打转检测），进 D/E 滑窗会污染全局阈值自校准样本
// v2.4.30（E 类「成功同质循环」内置默认）：簇=与当前步 args dice≥sim 的连续步集（参数不同天然不成簇——用户拍板只读豁免落法）
const SAME_NEG_TH = 0.30;      // E: 簇内负面率上限（成功为主）
const SAME_STEPS_TH = 4;       // E: 簇内重复绝对步数下限（防短暂重试误报）
const SAME_MIN_SECS = 60;      // E: 簇墙钟下限秒数（防快速抖动误报）
const SAME_HOMO_TH = 0.80;     // E: 簇内同质占比（distinct 指纹 ≤ 簇长×此值 判同质；评审 P0-1 簇内口径）
// v2.4.30（W 类看门狗「无用户介入长空转」内置默认）：不依赖同质/重复信号，只依赖用户回合后步数与墙钟
const WATCH_STEPS_TH = 10;     // W: 用户回合后无介入工具步数下限
const WATCH_SECS_TH = 180;     // W: 用户回合后无介入墙钟下限（秒）
const WATCH_COOLDOWN_MIN = 10; // W: 同会话提醒冷却（分）
// v2.6.0（D 级打转熔断内置默认）：D2=拒调，D3=停轮；阈值进 effectiveSpiralThresh 覆盖层（可 /dream 自校准 + dsh_spiral_thresh 钳制）
const BRK_SAME_N = 3;          // 同 (tool,args指纹) 连续重复 ≥N（且产出静止、无用户穿插）进 suspect
const BRK_MAX_DENY = 3;        // 每周期 deny 次数上限，达上限升级 D3 或停手 overflow
const BRK_MIN_STEPS = 4;       // 执法需 stepsSinceUser ≥ 此值（防无用户穿插误伤长任务）
// 读型工具默认豁免：合法重复轮询 ≠ 真打转；并入执法白名单（deny/reject 一律不碰，进 D/E/W 滑窗照旧）
const BREAK_READ_SKIP = new Set(["read", "glob", "grep", "list"]);
let DREAM_TRACK = null;   // v2.5.4: 发起代际令牌——每次 runDreamPipeline 同步段换新对象，后台段凭引用判轮次归属
let LAST_DREAM_WROTE_AT = 0;   // v2.3.2(dream-tool): memory_dream_patch 成功落盘时间戳（settleDream 判成败用）   // v1.12.17: dream 运行跟踪 { since, sessionId, steps }（跨层共享）
let DREAM_PATCH = null;   // v1.12.17: 进度落盘函数桥（闭包内注入，顶层监听调用）
// v2.4.13(dream-live): 手动 /dream 的发起会话监听 agent——后台子代理照旧（物理写守卫保留），
// 但进度/结果实时转播回该会话，免开 .integrate.json 轮询；仅手动发起时设置，定期/超时自动整合不打扰任何会话。
let DREAM_LISTENER = null;
// v2.5.1(转播可见性): 进展行节流水位——子代理每次工具调用都会喂一条进度（L6482），
// 不节流一个 dream 会往会话流灌 20~60 行；每 60 秒最多落一行（首条/终态/health 不受限）。
let DREAM_BROADCAST_LAST_AT = 0;
const DREAM_BROADCAST_MIN_MS = 60000;
// v2.4.14(lesson-settle): 本轮 dream 投喂的回归条目序号→(sig,sessionId) 清单。
// 投喂时写入（pick 顺序，序号 L1..Ln），settleDream 按子代理 Output 的 lesson-skip:L1,L3 结算 fed/skippedByDream；跑完即清。
let DREAM_FEED_ROUND = null;
// v2.4.24（审查 P0-2）：投喂标记 feedAt 事务性回滚——spawn 抛错/run.result reject 路径回滚当轮投喂标记，
//    防「失败轮后条目 wasFed 永久排除重喂、台账 8 条全卡死、沉淀率恒 0%」
function rollbackLessonFeedRound() {
  try {
    if (DREAM_FEED_ROUND && DREAM_FEED_ROUND.length) {
      const P = readLessonPending();
      let dirty = false;
      for (const f of DREAM_FEED_ROUND) {
        const e = (P.entries || []).find((x) => x.sessionId === f.sessionId && x.sig === f.sig);
        if (e && (e.feedAt || e.feedState)) { e.feedAt = 0; e.feedState = null; dirty = true; }
      }
      if (dirty) writeLessonPending(true);
    }
  } catch (e) { /* 回滚失败容忍：下轮重喂仍可能（feedAt 遗留会被 needsFeed 判定处理） */ }
}
// v2.4.15(lesson-settle-hard): 本轮 dream 子代理经 memory_dream_patch **真实成功落盘**的内容缓冲（数组，仅 replace/append 成功项）。
// settleDream 对「未点名=未 skip」候选在本缓冲里做归一化子串匹配判定是否真沉淀——不靠模型自觉、不信文件系统 mtime（防 .pending-lessons/.monitor 自证）；spawn 时清空、结算后清空。
let DREAM_ROUND_WROTE = null;
let DREAM_WRITTEN_RELS = null;   // v2.4.20：本轮 memory_dream_patch 成功落盘 rel 集合（settle 清）——「本轮已写」文件级判定 + 提取一致性核对
// v2.0.1: 按会话 id 分桶——原全局单例 TURN_CUR/SPIRAL_WIN 在多主会话并发时互相腰斩周期/清空滑窗（08-24 阈值标定实证）
const SPIRAL_BUCKETS = new Map();  // sid -> { cur: 任务周期画像|null, win: 滑窗[], ws: 工作空间尾段, lastUserAt, stepsSinceUser }
function spiralBucket(sid) {
  const key = String(sid || "?");
  let b = SPIRAL_BUCKETS.get(key);
  if (!b) {
    if (SPIRAL_BUCKETS.size >= 200) { const k0 = SPIRAL_BUCKETS.keys().next().value; SPIRAL_BUCKETS.delete(k0); }  // 长驻实例防御：淘汰最早桶
    // v2.4.30（E/W 类）：桶扩 lastUserAt/stepsSinceUser——W 看门狗无用户介入计数（pre-step step1 复位）
    b = { cur: null, win: [], ws: "?", lastUserAt: 0, stepsSinceUser: 0,
      // v2.6.0（D 级熔断态）：suspectKeys=同指纹 suspect 键集；denyN=本周期累计 deny 次数；fullStop=拒调达上限准备停轮；seq=同指纹连续计数
      brk: { suspectKeys: new Set(), denyN: 0, fullStop: false, seq: 0, seqKey: "" } };
    SPIRAL_BUCKETS.set(key, b);
  }
  return b;
}
function diceBigram(a, b) {
  const grams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
  if (!a || !b) return 0;
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function spiralObserve(toolName, args, result, isError, sid) {
  // v2.4.30（E 类）：返回布尔 → { d, e }——D/E 并列计算再统一返回（架构评审 P0：旧实现 D 命中提前 return 会吞掉 E 判定）
  try {
    if (PLUGIN_CFG.monitorEnabled === false || SPIRAL_SKIP.has(toolName)) return { d: false, e: false };
    const B = spiralBucket(sid);   // v2.0.1: 会话桶 { cur, win, ws } 替代全局单例
    const ET = effectiveSpiralThresh();   // v2.0.3: 生效阈值（内置默认 + spiralThresh 覆盖层）
    let aTxt = "";
    try { aTxt = String(typeof args === "string" ? args : JSON.stringify(args) || ""); } catch (e) { aTxt = ""; }
    aTxt = aTxt.replace(/\s+/g, " ").slice(0, 600);
    let rTxt = "";
    try {
      if (result && Array.isArray(result.content)) rTxt = result.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
      else if (typeof result === "string") rTxt = result;
      else rTxt = JSON.stringify(result) || "";
    } catch (e) { rTxt = ""; }
    rTxt = rTxt.replace(/\s+/g, " ");
    const neg = !rTxt.trim() || isError || SPIRAL_NEG_RE.test(rTxt.slice(0, 200));
    let rep = 0;
    // v2.2.8: 顺带记录本步与窗内历史的最大 args 相似度——sim 阈值校准的观测地基（原实现算完即弃且短路，分布数据不存在）
    let stepSim = 0;
    for (const w of B.win) { const s2 = diceBigram(aTxt, w.argsTxt); if (s2 > stepSim) stepSim = s2; if (s2 >= ET.sim) rep = 1; }
    // v2.4.30（E 类，架构 P0 Q3）：窗元素双字段——resKey 原文前 80 字保留（保 batchLike/D 语义 L5983）+ resKeyFp 归一化指纹（E 专用）；补 ts 供簇墙钟
    B.win.push({ argsTxt: aTxt, resKey: rTxt.slice(0, 80), resKeyFp: resultFingerprint(rTxt), neg: neg ? 1 : 0, rep, tool: toolName, sim: Math.round(stepSim * 100) / 100, ts: Date.now() });
    if (B.win.length > ET.w) B.win.shift();
    if (!B.cur) B.cur = { t0: Date.now(), calls: 0, negN: 0, errN: 0, spiralN: 0, spiralE: 0, tools: {}, sims: [] };   // v2.2.8: sims 累积步间相似度；v2.4.30 加 spiralE
    B.cur.calls += 1;
    B.cur.tools[toolName] = (B.cur.tools[toolName] || 0) + 1;   // v1.12.16.1 周期工具分布
    B.cur.sims.push(stepSim);   // v2.2.8: 相似度序列供周期结算分位
    if (neg) B.cur.negN += 1;
    if (isError) B.cur.errN += 1;
    let dHit = false, eHit = false;
    if (B.win.length >= 5) {
      const n = B.win.length;
      const repRate = B.win.reduce((s2, w2) => s2 + w2.rep, 0) / n;
      const negRate = B.win.reduce((s2, w2) => s2 + w2.neg, 0) / n;
      // ── D 判定（语义与 v2.4.29 逐字节等价；只把提前 return 改 flag）──
      if (repRate >= ET.rep && negRate >= ET.neg && B.cur) {
        const firstHit = B.cur.spiralN === 0;   // 本周期首次命中
        B.cur.spiralN += 1;
        if (firstHit) {   // 每周期只记首次样本，防膨胀
          const d = readMonitorData();
          if (!Array.isArray(d.spiralEvents)) d.spiralEvents = [];
          const tCnt = {};
          for (const w2 of B.win) tCnt[w2.tool] = (tCnt[w2.tool] || 0) + 1;
          const wTop = Object.entries(tCnt).sort((a2, b2) => b2[1] - a2[1]).slice(0, 2).map((x2) => x2[0]).join(",");
          const firstRepPos = B.win.findIndex((w2) => w2.rep === 1);
          const winMaxSim = B.win.reduce((m2, w2) => Math.max(m2, w2.sim || 0), 0);
          // v2.4.30：kind:"D" 显式标记（存量无 kind 兼容读取为 D）
          d.spiralEvents.push({ t: Date.now(), kind: "D", tool: toolName, repRate: Math.round(repRate * 100) / 100, negRate: Math.round(negRate * 100) / 100, sample: aTxt.slice(0, 60), ws: B.ws, topTools: wTop, maxSim: winMaxSim, winLen: B.win.length, firstRepPos });
          if (d.spiralEvents.length > 100) d.spiralEvents = d.spiralEvents.slice(-100);
          scheduleMonitorSave();
        }
        dHit = firstHit;   // 调用点 gate 依据周期首命（v2.0.2 语义不变）
      }
      // ── E 判定（v2.4.30 成功同质循环；簇内口径，评审 P0-1）──
      // 与 D 判定并列计算（架构 P0：D 命中不吞 E、d/e 独立可测）；同轮 d/e 同真由调用点单 gate 裁决（D>E 优先级）
      if (repRate >= ET.rep && B.cur) {
        const cluster = extractArgsCluster(B.win, aTxt, ET.sim);
        if (cluster.length >= ET.sameSteps) {
          const clNegN = cluster.reduce((s2, c) => s2 + c.w.neg, 0);
          const clNegRate = clNegN / cluster.length;
          const clFps = new Set(cluster.map((c) => c.w.resKeyFp || ""));
          const clHomo = clFps.size / cluster.length;
          const clWall = (cluster[cluster.length - 1].w.ts || 0) - (cluster[0].w.ts || 0);
          if (clNegRate < ET.sameNeg && clHomo <= ET.sameHomo && clWall >= ET.sameMinSecs * 1000) {
            const firstE = B.cur.spiralE === 0;   // 本周期 E 首次命中
            B.cur.spiralE += 1;
            if (firstE) {
              const d2 = readMonitorData();
              if (!Array.isArray(d2.spiralEvents)) d2.spiralEvents = [];
              d2.spiralEvents.push({ t: Date.now(), kind: "E", tool: toolName, repRate: Math.round(repRate * 100) / 100, negRate: Math.round(clNegRate * 100) / 100, sample: aTxt.slice(0, 60), ws: B.ws, clusterN: cluster.length, clusterWallSecs: Math.round(clWall / 1000), homoRate: Math.round(clHomo * 100) / 100, topTools: toolName });
              if (d2.spiralEvents.length > 100) d2.spiralEvents = d2.spiralEvents.slice(-100);
              scheduleMonitorSave();
            }
            eHit = firstE;
          }
        }
      }
    }
    return { d: dHit, e: eHit };
  } catch (e) { /* 探针失败不影响会话 */ }
  return { d: false, e: false };
}
// v1.12.16: 任务周期画像结算（pre-step 新用户输入时调用）——后续动态阈值的基线数据
function settleTurnProfile(sid) {
  try {
    const B = spiralBucket(sid);   // v2.0.1: 只结算当前会话的桶，其他会话进行中的周期不受影响
    if (!B.cur || !B.cur.calls) { B.cur = null; B.win.length = 0; return; }
    const d = readMonitorData();
    if (!Array.isArray(d.turnProfiles)) d.turnProfiles = [];
    const pTop = Object.entries(B.cur.tools || {}).sort((a2, b2) => b2[1] - a2[1]).slice(0, 2).map((x2) => x2[0]).join(",");
    // v2.2.8: 相似度分布分位（sim 阈值校准观测）——p50/p90 描述当前切分点落在分布何处
    const simsAsc = (B.cur.sims || []).slice().sort((a2, b2) => a2 - b2);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
    d.turnProfiles.push({ t: Date.now(), durMin: Math.round(((Date.now() - B.cur.t0) / 6000)) / 100, calls: B.cur.calls, negN: B.cur.negN, errN: B.cur.errN, spiralN: B.cur.spiralN, spiralE: B.cur.spiralE || 0, ws: B.ws, topTools: pTop, simP50: Math.round(pct(simsAsc, 0.5) * 100) / 100, simP90: Math.round(pct(simsAsc, 0.9) * 100) / 100 });
    if (d.turnProfiles.length > 200) d.turnProfiles = d.turnProfiles.slice(-200);
    B.cur = null;
    B.win.length = 0;
    scheduleMonitorSave();
  } catch (e) { /* 忽略 */ }
}

// v2.6.0（D 级打转熔断）：breaker 状态查询 + suspect 武装 + 连续计数判定
// 判定口径：同 (tool,argsFp) 连续重复 ≥ brkSameN ∧ 产出静止（resultFingerprint 不变）∧ 无用户穿插（stepsSinceUser≥brkMinSteps）
function breakState(spSid) {
  const B = spiralBucket(spSid);
  return B && B.brk ? B.brk : null;
}
function armBreakSuspect(toolName, args, result, isError, spSid) {
  try {
    if (!PLUGIN_CFG.spiralBreak) return;
    const ET = effectiveSpiralThresh();
    const brkSameN = Math.round(ET.brkSameN || BRK_SAME_N);
    const brkMinSteps = Math.round(ET.brkMinSteps || BRK_MIN_STEPS);
    const B = spiralBucket(spSid);
    if (!B || !B.brk) return;
    // 读型工具默认豁免：合法轮询 ≠ 真打转
    if (BREAK_READ_SKIP.has(toolName)) return;
    // 元工具豁免（沿用 SPIRAL_SKIP）
    if (SPIRAL_SKIP.has(toolName)) return;
    // 无用户穿插检查
    if ((B.stepsSinceUser || 0) < brkMinSteps) return;
    // 计算指纹
    let aTxt = "";
    try { aTxt = String(typeof args === "string" ? args : JSON.stringify(args) || ""); } catch (e) {}
    aTxt = aTxt.replace(/\s+/g, " ").slice(0, 600);
    const argsFp = createHash("sha256").update(aTxt).digest("hex").slice(0, 16);
    const key = toolName + ":" + argsFp;
    const rFp = resultFingerprint(Array.isArray(result.content) ? result.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ") : String(result || ""));
    // 连续计数：同 key 且产出静止（rFp 不变）→ seq++；不同 key → 重置
    if (B.brk.seqKey === key && B.brk.lastRFp === rFp) {
      B.brk.seq += 1;
    } else {
      B.brk.seq = 1;
      B.brk.seqKey = key;
      B.brk.lastRFp = rFp;
    }
    // 达阈值 → 进 suspect
    if (B.brk.seq >= brkSameN) {
      B.brk.suspectKeys.add(key);
    }
  } catch (e) {}
}
    // v2.5.4(C)：findStaleSessions 进程内 TTL 缓存——该函数同步扫全部会话目录+逐文件 statSync，
    //   每次 compact 注入/面板统计/dream 管线都在调用（实证 /dream 提交卡顿毛刺源之一）。
    //   默认 60s 命中直接返回上次数组；force=true 绕缓存并刷新（dream 后台归档段专用，保证清单准确）。
    //   注意：返回数组与缓存共享引用——所有消费方均为只读 filter/map，禁止原地改动。
    let STALE_SCAN_CACHE = null;   // { key, at, cutoffNow, list }
    const STALE_SCAN_TTL_MS = 60000;
    function findStaleSessions(maxAgeDays, afterTime, force) {
      const stale = [];
      // v1.11.0：记忆暂停（active=false，afterTime 为 null）→ 不纳入任何漏网
      if (afterTime === null) return stale;
      const _now = Date.now();
      // v2.5.4(C): cutoff 必须入缓存键——否则 TTL 内新到期的会话被旧结果吞掉最长 60s
      const _ckey = maxAgeDays + "|" + afterTime + "|" + (_now - maxAgeDays * 86400000);
      if (!force && STALE_SCAN_CACHE && STALE_SCAN_CACHE.key === _ckey && _now - STALE_SCAN_CACHE.at < STALE_SCAN_TTL_MS) {
        return STALE_SCAN_CACHE.list;
      }
      let wsDirs = [];
      try { wsDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch (e) { return stale; }
      const cutoff = _now - maxAgeDays * 86400000;
      for (const ws of wsDirs) {
        if (!ws.isDirectory()) continue;
        let sdirs = [];
        try { sdirs = fs.readdirSync(path.join(SESSIONS_ROOT, ws.name), { withFileTypes: true }); } catch (e) { continue; }
        for (const s of sdirs) {
          if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
          const z = path.join(SESSIONS_ROOT, ws.name, s.name, "session.jsonl.zstd");
          let st;
          try { st = fs.statSync(z); } catch (e) { continue; }
          // v1.6.1 修正：启用界限用「会话最后交互时间」（mtime）而非创建时间——
          // 最后交互在插件最近一次启用之前的会话（含插件关闭期间结束的）不触发整合；
          // 只有最后交互在启用之后的会话才纳入漏网检测。
          if (afterTime && st.mtimeMs < afterTime) continue;
          if (st.mtimeMs < cutoff) {
            stale.push({ ws: ws.name, id: s.name, mtime: st.mtimeMs, size: st.size });
          }
        }
      }
      STALE_SCAN_CACHE = { key: _ckey, at: _now, list: stale };
      return stale;
    }

// v1.8.0：提取会话日志的 compaction 摘要（根治 token 爆炸）——
// 解压 session.jsonl.zstd（node:zlib zstd），找 compaction/summary 事件，返回摘要文本（截断防超长）。
// 子代理只读这个摘要（几千 token），不再读原始大日志（几十 MB → 数百万 token）。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompressSessionLog(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let out = Buffer.alloc(0);
    let off = 0;
    while (off < buf.length) {
      const frame = zlib.zstdDecompressSync(buf.subarray(off));
      out = Buffer.concat([out, frame]);
      let next = -1;
      for (let i = off + 4; i < buf.length - 3; i++) {
        if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) { next = i; break; }
      }
      if (next < 0) break;
      off = next;
    }
    return out.toString("utf8");
  } catch (e) { return null; }
}
// v1.12.18.4: 旧版 extractMessageFlow（8000 截断）已删除——改为 extractMessageFlowAsync（compaction 优先 + 分段 map-reduce）
    // v1.12.18+: 分层提取——先官方 compaction/summary 摘要链（完整上下文浓缩含工具脉络），
    // 无压缩史的会话走帧级采样+行级快筛+工具轨迹+动态预算；大会话分段交 map-reduce 仿真压缩。
    // 逐帧间 setImmediate 让出，主线程不冻结；zstd 多帧可独立解压（实测单帧语义）。
    async function extractMessageFlowAsync(filePath, skipFrames) {
      try {
        const st = fs.statSync(filePath);
        const sizeMB = st.size / 1048576;
        const buf = fs.readFileSync(filePath);
        const frames = [];
        for (let i = 0; i < buf.length - 3; i++) {
          if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames.push(i);
        }
        if (frames.length === 0) return null;
        // v2.4.3：增量重档——丢掉水位前的已归档帧，只喂尾部新增；总帧数不高于水位（日志被外部重写）→ 回退全量，绝不静默丢尾
        if (skipFrames > 0) { if (frames.length > skipFrames) frames.splice(0, skipFrames); else skipFrames = 0; }
        const FULL = sizeMB < 8 || frames.length <= 12;
        let selected;
        if (FULL) selected = frames.slice();
        else {
          selected = frames.slice(0, 2);
          const midA = 2, midB = frames.length - 2, span = Math.max(1, midB - midA);
          const K = Math.min(Math.max(6, Math.round(sizeMB * 1.5)), span);
          for (let k = 0; k < K; k++) selected.push(frames[midA + Math.floor(span * k / K)]);
          if (frames.length >= 4) selected.push(frames[frames.length - 2], frames[frames.length - 1]);
          selected = Array.from(new Set(selected)).sort((a, b) => a - b);
        }
        // v1.12.18.3: 大会话预算放宽至 200K——不再截断丢弃，提取后按 40K 分段走 map-reduce 仿真压缩
        const maxChars = sizeMB < 5 ? 8000 : 200000;
        // v1.12.18.2: 同一趟遍历双收获——官方 compaction 摘要（模型看过完整上下文含工具调用，
        // 大会话必有）优先于任何采样消息流；compParts 非空则最终以它为准。
        const compParts = [];
        let compTotal = 0;
        let lastCompSi = -1;
        const parts = [];
        let total = 0;
        let stop = false;
        const nSel = selected.length;
        for (let si = 0; si < nSel && !stop; si++) {
          if (si > 0) await new Promise((r2) => setImmediate(r2));
          let text = "";
          try { text = zlib.zstdDecompressSync(buf.subarray(selected[si])).toString("utf8"); } catch (e) { continue; }
          if (!FULL) parts.push(si === 0 ? "[采样视图 " + nSel + "/" + frames.length + " 帧·首尾保真中段均匀]" : "[段 " + (si + 1) + "/" + nSel + "]");
          const segLines = text.split("\n");
          for (const line of segLines) {
            let kind = 0;
            if (line.indexOf('"type":"user/message"') >= 0 || line.indexOf('"type": "user/message"') >= 0) kind = 1;
            else if (line.indexOf('"type":"assistant/message"') >= 0 || line.indexOf('"type": "assistant/message"') >= 0) kind = 2;
            else if (line.indexOf('"type":"tool/call"') >= 0 || line.indexOf('"type": "tool/call"') >= 0) kind = 3;
            else if (line.indexOf('"type":"compaction/summary"') >= 0 || line.indexOf('"type": "compaction/summary"') >= 0) kind = 4;
            if (kind === 0) continue;
            let j; try { j = JSON.parse(line); } catch (e) { continue; }
            if (kind === 1) {
              const content = j.data && j.data.content;
              if (!Array.isArray(content)) continue;
              const txt = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
              if (!txt || txt.indexOf("<system-reminder>") === 0) continue;
              const piece = "[用户] " + txt.slice(0, 800);
              parts.push({ si: si, s: piece }); total += piece.length;
            } else if (kind === 2) {
              const content = j.data && j.data.message && j.data.message.content;
              if (!Array.isArray(content)) continue;
              const txt = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
              if (!txt) continue;
              const piece = "[助手] " + txt.slice(0, 1000);
              parts.push({ si: si, s: piece }); total += piece.length;
            } else {
              const nm = (j.data && j.data.name) || "?";
              const args = String((j.data && j.data.arguments) || "").replace(/\s+/g, " ").slice(0, 80);
              const piece = "[工具] " + nm + "(" + args + ")";
              parts.push({ si: si, s: piece }); total += piece.length;
            }
            if (kind === 4) {
              // 官方压缩摘要：模型看全量上下文（含工具调用）后的浓缩——最高价值来源
              const segs = (j.data && j.data.summary) || [];
              const txt = segs.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n").trim();
              if (txt) { compParts.push("【压缩点摘要】\n" + txt); compTotal += txt.length; lastCompSi = si; }
            }
            if (total > maxChars) { stop = true; break; }
          }
        }
        // v1.12.18.2: 三态组装——
        // ① 有压缩史：压缩摘要链（完整演进史）+ 末次压缩点之后的新增交互（摘要覆盖不到的最新内容）
        // ② 无压缩史：消息流（小会话无损 / 大会话首尾保真中段采样）
        const joinParts = (arr) => arr.map((p) => p.s).join("\n");
        if (compParts.length > 0 && lastCompSi >= 0) {
          const post = joinParts(parts.filter((p) => p.si > lastCompSi));
          let flowOut = compParts.join("\n\n=====\n\n");
          if (post) flowOut += '\n\n【末次压缩后的新增交互】\n' + post;
          return { flow: flowOut.slice(-maxChars), sampled: false, source: "compaction", compCount: compParts.length };
        }
        if (parts.length === 0) return null;
        // v1.12.18.3: 无压缩史 → 按 40K 分段输出（≤5 段；超出保首尾均匀取中），供 map-reduce 仿真压缩
        const allText = joinParts(parts);
        const SEG = 40000, MAX_SEG = 5;
        const segments = [];
        for (let i = 0; i < allText.length && segments.length < MAX_SEG; i += SEG) segments.push(allText.slice(i, i + SEG));
        if (allText.length > SEG * MAX_SEG) {
          const tail = allText.slice(allText.length - SEG);
          const midA = SEG, span = allText.length - SEG * 2;
          const dense = [allText.slice(0, SEG)];
          for (let k = 1; k < MAX_SEG - 1; k++) { const p = midA + Math.floor(span * k / (MAX_SEG - 1)); dense.push(allText.slice(p, p + SEG)); }
          dense.push(tail);
          return { segments: dense, sampled: true, source: "messageflow" };
        }
        return { segments: segments, sampled: !FULL, source: "messageflow" };
      } catch (e) { return null; }
    }

    // ═══════════ v2.4.7（方案C·L2 确定性预压缩）：插件内规则压缩——替代 v1.12.18.3 的逐段 spawn 子代理仿真压缩
    // 痛点（真机 2026-08-30 实证）：16 个 ≥5MB 大会话 × 每会话 3-10 段 × 每段子代理调用 = 几十次 spawn 烧 token；
    //   且全批 flow 再拼一个巨型子代理 prompt（最坏 404 万字符≈120 万 token）必爆上下文。
    // 方案：零子代理规则压缩——提取结果按来源分流：
    //   source=compaction（有官方摘要链）→ 摘要链本身是模型看全量后的浓缩，最多额外补末次压缩后交互；
    //   source=messageflow（帧采样）→ 多段拼接后按"工具轨迹优先 + 用户消息 + 尾保真"规则取 ≤UNIT_MAX_CHARS。
    // 输出：单元 text（≤UNIT_MAX_CHARS），供 L3 分桶（桶预算 BUCKET_BUDGET_CHARS）确定性切批。
    const UNIT_MAX_CHARS = 20000;       // 单会话单元上限（≈5-6K token，加指令后单批上下文安全）
    const BUCKET_BUDGET_CHARS = 60000;  // 单批字符预算（≈3-4 个单元，约 15-20K token）
    const BUCKET_MAX_UNITS = 5;         // 单批单元数上限（防小单元堆积过长 prompt）
    const ARCHIVE_MAX_CONCURRENT = 2;   // 批并发上限（防 token 放大）
    const UNIT_CACHE_DIR = MEMORY_ROOT + "/.archive-units";   // 单元缓存（增量重档复用）
    const UNIT_CACHE_KEEP = 500;         // 单元 LRU 保留数
    function compressUnit(extract, fallbackText) {
      try {
        if (!extract) return { text: String(fallbackText || "").slice(0, UNIT_MAX_CHARS), source: "none", chars: 0 };
        if (extract.source === "compaction" && extract.flow) {
          return { text: extract.flow.slice(0, UNIT_MAX_CHARS), source: "compaction", chars: Math.min(extract.flow.length, UNIT_MAX_CHARS) };
        }
        let text = "";
        if (Array.isArray(extract.segments) && extract.segments.length > 0) text = extract.segments.join("\n\n");
        else if (extract.flow) text = extract.flow;
        else text = String(fallbackText || "");
        if (text.length > UNIT_MAX_CHARS) {
          const lines = text.split("\n");
          const toolLines = lines.filter((l) => /^\[工具\]/.test(l.trim()));
          const userLines = lines.filter((l) => /^\[用户\]/.test(l.trim()));
          let head = "";
          let budgetLeft = UNIT_MAX_CHARS;
          for (const l of toolLines.slice(0, 60)) {
            if (l.length + head.length > budgetLeft) break;
            head += (head ? "\n" : "") + l;
          }
          budgetLeft = UNIT_MAX_CHARS - head.length;
          let userPart = "";
          for (const l of userLines.slice(0, 40)) {
            if (l.length + userPart.length > budgetLeft) break;
            userPart += (userPart ? "\n" : "") + l;
          }
          const tail = lines.slice(-40).filter((l) => /^\[用户\]|^\[助手\]|^\[工具\]/.test(l.trim())).join("\n").slice(0, 4000);
          text = [head, userPart, "…[规则压缩省略]", tail].filter(Boolean).join("\n\n").slice(0, UNIT_MAX_CHARS);
        }
        return { text: text.slice(0, UNIT_MAX_CHARS), source: "messageflow", chars: Math.min(text.length, UNIT_MAX_CHARS) };
      } catch (e) {
        return { text: String(fallbackText || "").slice(0, UNIT_MAX_CHARS), source: "error", chars: 0 };
      }
    }
    // ===== 分桶：按字符预算 + 单元数上限，把单元列表切成子代理批 =====
    function bucketUnits(units) {
      const buckets = [];
      let cur = [];
      let curChars = 0;
      for (const u of units) {
        const uc = u.chars || u.text.length;
        if (cur.length > 0 && (curChars + uc > BUCKET_BUDGET_CHARS || cur.length >= BUCKET_MAX_UNITS)) {
          buckets.push(cur);
          cur = [];
          curChars = 0;
        }
        cur.push(u);
        curChars += uc;
      }
      if (cur.length > 0) buckets.push(cur);
      return buckets;
    }
    // ===== v2.4.7（方案C·L2b 单元缓存）：增量重档复用——避免续聊会话重新提取/压缩全量 =====
    // 文件名 <sid12>.json：{sid, frames, round, at, text, source, chars}；LRU 保留 UNIT_CACHE_KEEP 个
    function unitCachePath(sid) { return UNIT_CACHE_DIR.replace(/\\/g, "/") + "/" + sid + ".json"; }
    function readUnitCache(sid) {
      const p = unitCachePath(sid);
      try { const d = JSON.parse(fs.readFileSync(portable(p), "utf8")); if (d && typeof d.text === "string") return d; } catch (e) {}
      return null;
    }
    function writeUnitCache(unit) {
      try {
        if (!unit || !unit.sid) return;
        fs.mkdirSync(portable(UNIT_CACHE_DIR), { recursive: true });
        writeFileAtomic(portable(unitCachePath(unit.sid)), JSON.stringify(unit), { tag: "units" });   // v0.5（step1 账本闸）：统一原子写
        // LRU 保留：超 UNIT_CACHE_KEEP 时删最旧（按 at 排序）——仅单元目录规模大时触发
        try {
          const files = fs.readdirSync(portable(UNIT_CACHE_DIR)).filter((f) => f.endsWith(".json"));
          if (files.length > UNIT_CACHE_KEEP) {
            const sorted = files.map((f) => { try { const d = JSON.parse(fs.readFileSync(portable(UNIT_CACHE_DIR + "/" + f), "utf8")); return { f: f, at: d.at || 0 }; } catch (e) { return { f: f, at: 0 }; } }).sort((a, b) => a.at - b.at);
            for (const x of sorted.slice(0, files.length - UNIT_CACHE_KEEP)) { try { fs.unlinkSync(portable(UNIT_CACHE_DIR + "/" + x.f)); } catch (e) {} }
          }
        } catch (e) {}
      } catch (e) {}
    }
    // 合并：旧单元（已归档部分）+ 新增帧单元（增量）——续聊会话的单元重组
    function mergeUnitCache(oldUnit, newUnit, curFrames, round) {
      if (!oldUnit && !newUnit) return null;
      const nl='\n';
      const text = [oldUnit && oldUnit.text ? "【已归档部分（上次提取）】"+nl+oldUnit.text : "", newUnit && newUnit.text ? "【新增部分（本次提取）】"+nl+newUnit.text : ""].filter(Boolean).join(nl+nl).slice(0, UNIT_MAX_CHARS);
      const sid = (newUnit && newUnit.sid) || (oldUnit && oldUnit.sid) || "?";
      return { sid: sid, frames: curFrames, round: round, at: Date.now(), text: text, source: "merged", chars: text.length };
    }

// v1.11.0：记忆活跃界限（漏网检测过滤用）——
// enabledAt 由记忆活跃开关 active 驱动，与 DSH 进程启停解耦：
//   - active=true → enabledAt=上次启用周期时间（或安装时间），只整合此后交互的会话
//   - active=false（用户显式暂停）→ enabledAt=null，不纳入任何漏网
// 判定：会话最后交互 mtime >= enabledAt → 纳入漏网；< enabledAt → 跳过。
function getEnabledAt() {
  try {
    const raw = fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8");
    const st = JSON.parse(raw);
    if (st) {
      // enabledAt 为数字（记忆活跃中）→ 用之
      if (typeof st.enabledAt === "number" && st.enabledAt > 0) return st.enabledAt;
      // enabledAt 为 null（记忆暂停，active=false）→ 返回 null：不纳入任何漏网
      if (st.enabledAt === null) return null;
      // 老状态文件无 enabledAt 字段 → 兼容：读 lastEnabledAt/installAt
      if (typeof st.lastEnabledAt === "number" && st.lastEnabledAt > 0) return st.lastEnabledAt;
      if (st.installAt) return st.installAt;
    }
  } catch (e) { /* 无状态文件 */ }
  return Date.now();
}

// v1.10.0 性能优化：sessions/*.md 内容缓存（启动时读一次 + 写入后刷新），
// 把 sessionMentionedInMemory 从「每会话 × 每文件读盘」O(N×M) 降为「缓存 includes」O(N)。
let MEMORY_SESSIONS_INDEX = null;
let MEMORY_SESSIONS_INDEX_AT = 0;   // v2.0.9(L4): 缓存时间戳——外部/子代理落盘后旧索引会导致提及误判，5 分钟 TTL 自动重载

function refreshMemorySessionsIndex() {
  try {
    MEMORY_SESSIONS_INDEX_AT = Date.now();
    const dir = MEMORY_ROOT + "/sessions";
    const files = fs.readdirSync(portable(dir));
    let acc = "";
    for (const fn of files) {
      if (!fn.endsWith(".md")) continue;
      try { acc += fs.readFileSync(portable(dir + "/" + fn), "utf8"); } catch (e) { /* 单文件读失败跳过 */ }
    }
    MEMORY_SESSIONS_INDEX = acc;
    return acc;
  } catch (e) { MEMORY_SESSIONS_INDEX = ""; return ""; }
}

// 会话 id 是否已出现在记忆库 sessions/ 文件中（出现过 = 曾被总结/落档，不再视为漏网）
function sessionMentionedInMemory(sessionId) {
  if (MEMORY_SESSIONS_INDEX === null || Date.now() - MEMORY_SESSIONS_INDEX_AT > 300000) refreshMemorySessionsIndex();   // v2.0.9(L4): 5 分钟 TTL
  const idx = MEMORY_SESSIONS_INDEX || "";
  const idShort = sessionId.replace(/^session-/, "");
  return idx.includes(sessionId) || idx.includes(idShort);
}

// ═══════════ v2.4.3（续聊增量重档）：帧计数 + 重入判定 + 旧要点上下文提取 ═══════════
// magic 字节扫帧数（不解压，毫秒级）——与 extractMessageFlowAsync 的帧口径一致
function countZstdFrames(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let n = 0;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) n++;
    }
    return n;
  } catch (e) { return null; }
}
// 该会话当前是否「待归档」：不在账本=true（首次档）；在账本无水位（历史条目）=懒置基线返回 false（不追溯旧尾巴）；
// 有水位且当前帧数>水位=true（续聊新增，增量重入）；读不到日志=false（保守不打扰）
function archivePendingEntry(s) {
  if (!ARCHIVED_SESSIONS.has(s.id)) return true;
  const cur = countZstdFrames(SESSIONS_ROOT + "/" + s.ws + "/" + s.id + "/session.jsonl.zstd");
  if (cur === null) return false;
  const wm = ARCHIVE_WATERMARK.get(s.id);
  if (!wm) {
    ARCHIVE_WATERMARK.set(s.id, { frames: cur, round: 1, at: Date.now() });
    ARCHIVE_WM_DIRTY = true;
    return false;
  }
  return typeof wm.frames === "number" && cur > wm.frames;
}
// 从 sessions/*.md 缓存中提取某短 id 已归档条目块（### sid 起、至下一个 ##/### 前），重档时作上下文锚喂子代理
function extractExistingArchiveBlock(sid) {
  if (MEMORY_SESSIONS_INDEX === null || Date.now() - MEMORY_SESSIONS_INDEX_AT > 300000) refreshMemorySessionsIndex();
  const lines = (MEMORY_SESSIONS_INDEX || "").split("\n");
  const out = []; let hit = false;
  for (const ln of lines) {
    if (hit) { if (/^#{2,3}\s/.test(ln)) break; out.push(ln); continue; }
    if (ln.startsWith("### " + sid)) { hit = true; out.push(ln); }
  }
  return hit ? out.join("\n").trim().slice(0, 4000) : "";
}

// ═══════════ v2.4.5（恢复会话免重注入）：按会话记录已注入内容的字节哈希 ═══════════
// ═══════════ v2.4.8（B：used 闸）：记账条目加 used 标志——「该会话是否出现过真实用户回合」═══════════
// 背景：全新会话（startup 注入后、首条用户消息前）被恢复时，三档判定把 startup 的记账当「历史快照」，
//       摘要一变就走 notice 发变更通知——用户设计语义是「变更通知只针对用过（有真实回合）的历史会话」。
// v2.4.8：used=true ⟺ 该 sid 曾有过真实用户回合（pre-step step=1 置位）；used=false 的会话恢复 → 强制 silent，
//       既不重注也不发通知，等首个真实回合（pre-step 置 used=true）后恢复，行为回归正常三档。
//       状态持久 MEMORY_ROOT/.inject-state.json {sid:{g,i,s,t,used}}，LRU 500。
const INJECT_SNAPSHOT = new Map();
let INJECT_STATE_LOADED = false;
let INJECT_STATE_SAVE_TID = null;
function loadInjectSnapshot() {
  if (INJECT_STATE_LOADED) return;
  INJECT_STATE_LOADED = true;
  try {
    const st = JSON.parse(fs.readFileSync(portable(MEMORY_ROOT + "/.inject-state.json"), "utf8"));
    for (const k of Object.keys(st || {})) {
      const v = st[k];
      if (!v || typeof v !== "object") continue;
      // v2.4.7.1 修复（真机实证）：写入端 recordInjectSnapshot 只落 {g,i,s,t}，而旧过滤条件
      // typeof v.h === "string" 恒不命中 → 账本每次重启整表读不进内存 → v2.4.5/2.4.6「恢复会话免重注入」
      // 形同虚设（重启后每个被恢复会话都走 injectMode=full，稳定层+摘要全量重发，且旧记录被新记录整表覆写）。
      if (typeof v.g === "string" && typeof v.i === "string" && typeof v.s === "string") {
        // v2.4.8：增量条目 used 缺失即存量旧格式 → 惰性判定 used（resolveInjectUsedOnce 首次消费时按日志补算）
        // v2.4.24（审查 P0-1）：补 p 字段——record 端 v2.4.17 起落 {p:hP} 但 load 端丢弃 → snap.p 恒 undefined →
        // 命中项目会话每次恢复进 notice 误报「项目 X 有更新」；旧条目 p 缺失=undefined → 首次恢复 mP=true 发一次通知即升级
        INJECT_SNAPSHOT.set(k, { g: v.g, i: v.i, s: v.s, t: v.t || 0, used: v.used === undefined ? undefined : v.used, p: typeof v.p === "string" ? v.p : undefined });
      } else if (typeof v.h === "string") {
        INJECT_SNAPSHOT.set(k, { g: "__legacy__", i: v.i || "", s: v.s || "", t: v.t || 0, used: v.used === undefined ? undefined : v.used });   // 更早版本只记整体哈希 → 三档无法判定，按「画像已变」处理一次并升级账本为新格式
      }
    }
  } catch (e) {
    INJECT_STATE_LOADED = false;   // v2.4.7.1: 读失败不锁死——下次 session-start 重试（宁可多注入一次，不可整表丢失后全量重发）
  }
}
function scheduleInjectStateSave() {
  if (INJECT_STATE_SAVE_TID) return;
  INJECT_STATE_SAVE_TID = setTimeout(() => {
    INJECT_STATE_SAVE_TID = null;
    try {
      if (INJECT_SNAPSHOT.size > 500) {
        const drop = Array.from(INJECT_SNAPSHOT.entries()).sort((a, b) => a[1].t - b[1].t).slice(0, INJECT_SNAPSHOT.size - 500);
        for (const ent of drop) INJECT_SNAPSHOT.delete(ent[0]);
      }
      const obj = {}; for (const ent of INJECT_SNAPSHOT.entries()) obj[ent[0]] = ent[1];
      const fp = portable(MEMORY_ROOT + "/.inject-state.json");
      writeFileAtomic(fp, JSON.stringify(obj), { tag: "inject" });   // v0.5（step1 账本闸）：统一原子写
    } catch (e) { /* 写失败不重试——下次恢复宁可多注入不可漏（重复方向安全） */ }
  }, 5000);
}
function injectSnapshotGet(sessionId) { return INJECT_SNAPSHOT.get(sessionId) || null; }
function recordInjectSnapshot(sessionId, entry) {
  const prev = INJECT_SNAPSHOT.get(sessionId);
  // v2.4.8：used 保底——新会话（无 prev）首次记账 used=false（尚无真实回合）；有 prev 则保留其 used（不因恢复/重注翻转为 false）
  INJECT_SNAPSHOT.set(sessionId, { g: entry.g, i: entry.i, s: entry.s, t: Date.now(), used: prev && typeof prev.used === "boolean" ? prev.used : (prev ? (prev.used === undefined ? undefined : prev.used) : false), p: entry.p !== undefined ? entry.p : "" });   // v2.4.24（审查 P0-1）：p 字段透传
  scheduleInjectStateSave();
}
// v2.4.8：用量日志判定 used——该会话是否出现过真实用户回合（turn/start 或 user/message 且 source.kind=user）。
// 只做一次（首次消费时惰性补算存量条目），结果写回内存账本并由 scheduleInjectStateSave 落盘。
function resolveInjectUsedOnce(sessionId) {
  try {
    if (typeof sessionId !== "string" || !sessionId.startsWith("session-")) return true;   // 非规范 id 一律视为已用（宁可不静默，不可漏通知）
    const wsDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    for (const ws of wsDirs) {
      if (!ws.isDirectory()) continue;
      let sdirs = [];
      try { sdirs = fs.readdirSync(path.join(SESSIONS_ROOT, ws.name), { withFileTypes: true }); } catch (e) { continue; }
      for (const s of sdirs) {
        if (!s.isDirectory() || s.name !== sessionId) continue;
        const z = path.join(SESSIONS_ROOT, ws.name, s.name, "session.jsonl.zstd");
        if (!fs.existsSync(z)) return true;   // 找不到日志 → 视为已用（保守方向安全）
        const txt = decompressSessionLog(z);
        if (txt === null) return true;
        // 真实用户回合判定：日志含 turn/start，或含 user/message 且 source.kind=user（排除插件/系统 source）
        const used =
          txt.includes('"type":"turn/start"') ||
          /"type":"user\/message"[\s\S]{0,400}"source":\{"kind":"user"/.test(txt);
        return used;
      }
    }
    return true;   // 全局找不到该会话目录 → 视为已用（保守方向安全）
  } catch (e) { return true; }
}

// v1.3.0：可配置项（cordis.patch.yml 的 config 字段覆盖；未配置时用默认值）
//  - staleSessionDays: 漏网会话检测阈值（天），默认 5
//  - staleAction:      漏网处理动作（v1.12.18 起同时决定 /dream 是否带归档）：remind=仅提醒，/dream 不含归档 | silent=后台自动归档，/dream 先归档再整合 | approval=确认后才归档，/dream 不含归档
// v1.7.1：默认 staleAction=remind（仅提醒，不自动 spawn 子代理——实测漏网归档子代理单会话可烧数百万 token）
const DEFAULT_CFG = { staleSessionDays: 5, staleAction: "remind", integrateEnabled: false, integrateDays: 7, active: true, monitorEnabled: true, spiralRemind: true, initGuideEnabled: true, updateCheckEnabled: true, regressionEnabled: true, maintTriggerChars: 1100, spiralBreak: true, brkLevel: 3, brkHardAbort: false, brkSameN: 3, brkMaxDeny: 3, brkMinSteps: 4 };
// v1.11.0：active = 记忆活跃开关（独立于 DSH 进程启停）——
// 用户显式关掉=记忆整合暂停（enabledAt 置空）；打开=重新启用（enabledAt 刷新为当前时间）。
// DSH 重启/退出不再影响 enabledAt——「插件启停」与「DSH 进程启停」彻底解耦。
// v1.6.0：整合/漏网状态文件（模块级，供 getInstallAt 等跨作用域使用）
const INTEGRATE_STATE_FILE = MEMORY_ROOT + "/.integrate.json";
// v0.5.2（2026-09-03 审核后诊断补丁）：崩溃观察者落盘文件——宿主 installFailLoud 只挂 unhandledRejection
//   （stderr 一行 + exit(1)）且全树零 uncaughtException 处理器；Node 默认对同步 throw 打 stderr + exit(1)，
//   两者都无 Windows crash 痕迹 → 闪退无堆栈可复盘。此观察者把死前最后一刻的 rejection/异常同步
//   appendFileSync 落盘 ~/.dsh/memory/.crash.log（web 宿主带 release，同事件后续监听器仍会执行，同步写可行）。
//   语义：unhandledRejection 只留痕不拦截（宿主 fail-loud 仍 exit，插件 handler 后装抢不过先装的宿主 handler）；
//   uncaughtException 留痕后 process.exit(1) 保持致命（宿主无此处理器，Node 默认退出前先落痕）。
const CRASH_LOG_FILE = MEMORY_ROOT + "/.crash.log";
let PLUGIN_CFG = { ...DEFAULT_CFG };

// v1.4.0：settings 命名空间 schema（设置 UI 渲染 + 校验；用户文档覆盖 base）
// schemastery 语法：无 .int()/z.enum —— 整数用 number().min().max()，枚举用 union([const...])
const SETTINGS_SCHEMA = z.object({
  staleSessionDays: z.number().min(1).max(90).default(DEFAULT_CFG.staleSessionDays),
  staleAction: z.union([z.const("remind"), z.const("silent"), z.const("approval")]).default(DEFAULT_CFG.staleAction),
  // v1.5.0：定期自动整合（对标 mimocode AutoDream）
  integrateEnabled: z.boolean().default(false),          // 开关：每 integrateDays 天自动整合记忆（默认关闭，避免自动耗 token）
  integrateDays: z.number().min(1).max(90).default(7),   // 整合间隔（天）
  // v1.11.0：记忆活跃开关（独立于 DSH 进程启停）——用户显式控制；DSH 重启不改变它
  active: z.boolean().default(true),
  // v1.12.0：使用监控开关（默认开）——记录提醒/查询/错误事件到 .monitor.json，设置界面显示汇总
  monitorEnabled: z.boolean().default(true),
  // v2.0.2：LLM循环试错提醒（D类）——打转探针双条件命中时注入提醒；关闭则回退纯影子记录
  spiralRemind: z.boolean().default(DEFAULT_CFG.spiralRemind),
  // v0.5：回归闭环开关（默认开）——B/C 触发后自动捕捉错误上下文落 pending-lessons + 被动监测闭环；关闭则完全回现状
  regressionEnabled: z.boolean().default(DEFAULT_CFG.regressionEnabled),
  // v2.3.0：新装用户初始化引导开关（关＝不再自动提，/memory-init 仍可用）
  initGuideEnabled: z.boolean().default(DEFAULT_CFG.initGuideEnabled),
  // v2.3.0：升级检查开关（每天最多一次远端 version.txt 比对；离线/内网失败静默）
  updateCheckEnabled: z.boolean().default(DEFAULT_CFG.updateCheckEnabled),
  // v2.6.0：LLM 打转熔断（D 级分级执法）——spiralBreak=D2 拒调总开关；brkLevel=D3 停轮深度（2=D1+D2 / 3=+D3）；brkHardAbort=D4 硬中断独立开关（默认关，最激进）；brkSameN/brkMaxDeny/brkMinSteps=判定阈值（True effectiveSpiralThresh 侧进覆盖层，此处进 schema 供设置 UI）
  spiralBreak: z.boolean().default(DEFAULT_CFG.spiralBreak),
  brkLevel: z.number().min(1).max(3).default(DEFAULT_CFG.brkLevel),
  brkHardAbort: z.boolean().default(DEFAULT_CFG.brkHardAbort),
  brkSameN: z.number().min(2).max(6).default(DEFAULT_CFG.brkSameN),
  brkMaxDeny: z.number().min(1).max(6).default(DEFAULT_CFG.brkMaxDeny),
  brkMinSteps: z.number().min(1).max(5).default(DEFAULT_CFG.brkMinSteps),
  // v0.5（step5-1 档）：合并维护触发阈值（真实要点面字符数；[600,1500]，默认 1100 目标水位≈预算×73%）
  maintTriggerChars: z.number().min(600).max(1500).default(DEFAULT_CFG.maintTriggerChars),
  // 只读：监控汇总（客户端展示），宿主写入
  monitorSummary: z.string().required(false),
  // v2.3.0 只读：版本与初始化状态一行（客户端展示），宿主写入
  onboardSummary: z.string().required(false),
  // 只读统计：漏网（未整合记忆）会话数量，由宿主在检测后写入；非用户编辑项
  // schemastery 对象字段默认可选；required(false) 显式标注
  staleCount: z.number().min(0).required(false)
});
// v1.4.0：宿主侧 settings scope（register 返回），用于写只读统计 staleCount
let HOST_SETTINGS_SCOPE = null;

// 归一化配置：settings 值或 cordis config → 合法 PLUGIN_CFG
function normalizeCfg(raw) {
  const cfg = { ...DEFAULT_CFG, ...(raw || {}) };
  if (cfg.staleAction !== "remind" && cfg.staleAction !== "silent" && cfg.staleAction !== "approval") {
    cwarn("[dsh-memory] staleAction 非法值 " + cfg.staleAction + "，回退 remind");
    cfg.staleAction = "remind";
  }
  if (!(cfg.staleSessionDays >= 1 && cfg.staleSessionDays <= 90)) cfg.staleSessionDays = DEFAULT_CFG.staleSessionDays;
  if (typeof cfg.active !== "boolean") cfg.active = DEFAULT_CFG.active;
  if (typeof cfg.monitorEnabled !== "boolean") cfg.monitorEnabled = DEFAULT_CFG.monitorEnabled;
  if (typeof cfg.spiralRemind !== "boolean") cfg.spiralRemind = DEFAULT_CFG.spiralRemind;
  if (typeof cfg.spiralBreak !== "boolean") cfg.spiralBreak = DEFAULT_CFG.spiralBreak;
  if (!(cfg.brkLevel >= 1 && cfg.brkLevel <= 3)) cfg.brkLevel = DEFAULT_CFG.brkLevel;
  if (typeof cfg.brkHardAbort !== "boolean") cfg.brkHardAbort = DEFAULT_CFG.brkHardAbort;
  if (!(cfg.brkSameN >= 2 && cfg.brkSameN <= 6)) cfg.brkSameN = DEFAULT_CFG.brkSameN;
  if (!(cfg.brkMaxDeny >= 1 && cfg.brkMaxDeny <= 6)) cfg.brkMaxDeny = DEFAULT_CFG.brkMaxDeny;
  if (!(cfg.brkMinSteps >= 1 && cfg.brkMinSteps <= 5)) cfg.brkMinSteps = DEFAULT_CFG.brkMinSteps;
  if (typeof cfg.regressionEnabled !== "boolean") cfg.regressionEnabled = DEFAULT_CFG.regressionEnabled;
  if (typeof cfg.initGuideEnabled !== "boolean") cfg.initGuideEnabled = DEFAULT_CFG.initGuideEnabled;
  if (typeof cfg.updateCheckEnabled !== "boolean") cfg.updateCheckEnabled = DEFAULT_CFG.updateCheckEnabled;
  if (!(cfg.maintTriggerChars >= 600 && cfg.maintTriggerChars <= 1500)) cfg.maintTriggerChars = DEFAULT_CFG.maintTriggerChars;
  return cfg;
}

// ═══════════ v2.3.4(dream-hash)：整合候选改为「内容 sha256 账本比对」——替代 v2.3.2 的 mtime/最近3天/全量轮三套逻辑 ═══════════
// 设计（用户拍板 2026-08-29）：值得提升的跨会话知识必然在新日志中反复出现 → 增量即可覆盖（总结错→新日志冲突/漏记→多次出现）；
// 全量轮翻陈年旧账找的是"不该提升的一次性知识"。故候选判定 = 账本无记录 或 当前 hash ≠ 账本 hash：
//   - 已 dream 且内容未变的文件：永不重读（读取成本与历史长度无关）
//   - 任何内容变化的文件（无论谁改/何时改）：自动重读（兜底语义保留，mtime/touch 污染免疫）
// 纯函数、零 ctx 依赖（fs/portable/MEMORY_ROOT 都是模块级）——单测用 marker 切区 eval（ONBOARD 同套路）。
// >>> INT_HASH BEGIN
function sha256FileText(p) {
  try { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
  catch (e) { return null; }
}

// 返回 { sessionCands, otherCands }：候选 = 账本无记录 || 当前 hash ≠ 账本 hash
function hashListIntegrateCandidates(st0) {
  const dreamed = (st0 && st0.dreamed) || {};
  const sessionCands = []; const otherCands = [];
  const scan = (relDir, isSession) => {
    const d = portable(MEMORY_ROOT + "/" + relDir);
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isFile || !e.isFile()) continue;
      if (isSession && !/^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) continue;
      if (!isSession && !e.name.endsWith(".md")) continue;
      const rel = relDir + "/" + e.name;
      const h = sha256FileText(d + "/" + e.name);
      if (h === null) continue;
      if (dreamed[rel] !== h) (isSession ? sessionCands : otherCands).push(rel);
    }
  };
  scan("sessions", true);
  scan("projects", false);
  scan("knowledge", false);
  sessionCands.sort(); otherCands.sort();
  return { sessionCands: sessionCands, otherCands: otherCands };
}

// 整合成功后记账：全部相关文件当前 hash（已 dream 即记；未变的下次 hash 相同自动跳过）
function recordDreamedHashes(st0) {
  const dreamed = {};
  const scan = (relDir, isSession) => {
    const d = portable(MEMORY_ROOT + "/" + relDir);
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isFile || !e.isFile()) continue;
      if (isSession && !/^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) continue;
      if (!isSession && !e.name.endsWith(".md")) continue;
      const h = sha256FileText(d + "/" + e.name);
      if (h !== null) dreamed[relDir + "/" + e.name] = h;
    }
  };
  scan("sessions", true);
  scan("projects", false);
  scan("knowledge", false);
  st0.dreamed = dreamed;
  return dreamed;
}
// >>> INT_HASH END

// v2.4.2：统计面板静态页——HTML 壳 + 内联 JS（同源 fetch /dsh-memory/stats.json 渲染，零外部依赖）
function renderStatsPage() {
  return '<!DOCTYPE html>\n' +
'<html lang="zh">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>dsh-memory · 记忆统计面板</title>\n' +
'<style>\n' +
'* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'body {\n' +
'  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;\n' +
'  min-height: 100vh; color: #eaf0ff; background: #060a16; overflow-x: hidden;\n' +
'}\n' +
'.bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; }\n' +
'.blob { position: absolute; border-radius: 50%; filter: blur(90px); }\n' +
'.b1 { width: 54vw; height: 54vw; left: -14vw; top: -16vw; background: radial-gradient(circle at 30% 30%, #4f7cff, transparent 70%); opacity: .55; animation: f1 26s ease-in-out infinite alternate; }\n' +
'.b2 { width: 46vw; height: 46vw; right: -10vw; top: 2vw; background: radial-gradient(circle at 60% 40%, #9a4fff, transparent 70%); opacity: .45; animation: f2 32s ease-in-out infinite alternate; }\n' +
'.b3 { width: 42vw; height: 42vw; left: 22vw; bottom: -20vw; background: radial-gradient(circle, #00c2a8, transparent 70%); opacity: .34; animation: f1 38s ease-in-out infinite alternate-reverse; }\n' +
'.b4 { width: 26vw; height: 26vw; right: 20vw; bottom: 10vw; background: radial-gradient(circle, #ff5f8a, transparent 70%); opacity: .26; animation: f2 24s ease-in-out infinite alternate-reverse; }\n' +
'@keyframes f1 { from { transform: translate(0,0) scale(1); } to { transform: translate(9vw,7vh) scale(1.18); } }\n' +
'@keyframes f2 { from { transform: translate(0,0) scale(1.1); } to { transform: translate(-8vw,9vh) scale(.9); } }\n' +
'.wrap { max-width: 1280px; margin: 0 auto; padding: 22px 22px 64px; }\n' +
'header {\n' +
'  position: sticky; top: 12px; z-index: 10; display: flex; align-items: center;\n' +
'  justify-content: space-between; gap: 14px; flex-wrap: wrap;\n' +
'  padding: 14px 22px; margin-bottom: 20px;\n' +
'  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14);\n' +
'  border-radius: 22px; backdrop-filter: blur(24px) saturate(180%);\n' +
'  -webkit-backdrop-filter: blur(24px) saturate(180%);\n' +
'  box-shadow: 0 10px 40px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.18);\n' +
'}\n' +
'h1 { font-size: 19px; font-weight: 650; letter-spacing: .3px; display: flex; align-items: center; gap: 10px; }\n' +
'.logo { width: 30px; height: 30px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; background: linear-gradient(135deg, #4f7cff, #9a4fff); box-shadow: 0 4px 14px rgba(99,102,241,.5); }\n' +
'.sub { font-size: 12px; opacity: .62; margin-top: 3px; }\n' +
'.hbtn { display: flex; align-items: center; gap: 10px; }\n' +
'button {\n' +
'  display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; font-size: 13.5px;\n' +
'  color: #eaf0ff; background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.18);\n' +
'  border-radius: 999px; cursor: pointer; backdrop-filter: blur(12px);\n' +
'  transition: background .2s, box-shadow .2s, transform .1s;\n' +
'  box-shadow: inset 0 1px 0 rgba(255,255,255,.15);\n' +
'  font-family: inherit;\n' +
'}\n' +
'button:hover { background: rgba(255,255,255,.16); box-shadow: 0 0 22px rgba(122,140,255,.35), inset 0 1px 0 rgba(255,255,255,.2); }\n' +
'button:active { transform: scale(.96); }\n' +
'#spin { display: inline-block; transition: transform .5s; }\n' +
'.busy #spin { animation: rot 1s linear infinite; }\n' +
'@keyframes rot { to { transform: rotate(360deg); } }\n' +
'#status { font-size: 12px; opacity: .6; min-width: 90px; text-align: right; }\n' +
'.glass {\n' +
'  background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.12);\n' +
'  border-radius: 20px; backdrop-filter: blur(18px) saturate(160%);\n' +
'  -webkit-backdrop-filter: blur(18px) saturate(160%);\n' +
'  box-shadow: 0 8px 30px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.13);\n' +
'}\n' +
'.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(255px, 1fr)); gap: 14px; margin-bottom: 22px; }\n' +
'.kpi { padding: 16px 18px; position: relative; overflow: hidden; transition: transform .18s, box-shadow .18s; }\n' +
'.kpi:hover { transform: translateY(-3px); box-shadow: 0 14px 40px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.2); }\n' +
'.kpi::after { content: ""; position: absolute; left: 16px; right: 16px; top: 0; height: 2px; border-radius: 2px; background: var(--ac, linear-gradient(90deg,#4f7cff,#9a4fff)); opacity: .9; }\n' +
'.kv { font-size: 27px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.25; }\n' +
'.kl { font-size: 12px; opacity: .68; margin-top: 2px; line-height: 1.5; }\n' +
'.kdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; background: var(--dot, #7d8cff); box-shadow: 0 0 10px var(--dot, #7d8cff); }\n' +
'.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }\n' +
'@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); } }\n' +
'.card { padding: 18px 20px 20px; min-width: 0; }\n' +
'.span2 { grid-column: 1 / -1; }\n' +
'h2 { font-size: 14px; font-weight: 620; letter-spacing: .4px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }\n' +
'h2::before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: linear-gradient(180deg, #6d9dff, #a86bff); box-shadow: 0 0 12px rgba(130,120,255,.8); }\n' +
'.h2n { font-size: 11px; font-weight: 400; opacity: .5; margin-left: auto; white-space: nowrap; }\n' +
'.bar-track { background: rgba(255,255,255,.07); border-radius: 999px; height: 10px; flex: 1; overflow: hidden; }\n' +
'.bar { height: 10px; border-radius: 999px; background: linear-gradient(90deg, #4f7cff, #a86bff); width: 0; transition: width .8s cubic-bezier(.22,1,.36,1); box-shadow: 0 0 12px rgba(110,120,255,.5); }\n' +
'.brow { display: flex; align-items: center; gap: 12px; margin: 9px 0; font-size: 13px; }\n' +
'.blab { width: 150px; flex: none; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
'.bval { width: 40px; flex: none; text-align: right; font-variant-numeric: tabular-nums; opacity: .8; }\n' +
'.cols { display: flex; align-items: flex-end; gap: 4px; height: 130px; padding-top: 8px; border-bottom: 1px solid rgba(255,255,255,.09); }\n' +
'.col { flex: 1; max-width: 30px; min-width: 5px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; cursor: default; }\n' +
'.cbar { width: 100%; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, #7ea2ff, #5b46d9); height: 0; transition: height .8s cubic-bezier(.22,1,.36,1), opacity .15s; opacity: .9; }\n' +
'.col:hover .cbar { opacity: 1; box-shadow: 0 0 16px rgba(120,140,255,.8); }\n' +
'.cxl { display: flex; gap: 4px; margin-top: 7px; font-size: 10px; opacity: .45; }\n' +
'.cxl span { flex: 1; max-width: 30px; min-width: 5px; text-align: center; white-space: nowrap; overflow: hidden; }\n' +
'table { width: 100%; border-collapse: collapse; font-size: 12.5px; table-layout: fixed; }\n' +
'th { text-align: left; font-weight: 550; opacity: .55; padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.12); white-space: nowrap; }\n' +
'td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: top; }\n' +
'tr:last-child td { border-bottom: none; }\n' +
'tbody tr { transition: background .15s; }\n' +
'tbody tr:hover { background: rgba(255,255,255,.045); }\n' +
'.qtext { color: #cfe0ff; word-break: break-all; }\n' +
'.mono { font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .75; font-size: 12px; }\n' +
'.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
'.muted { opacity: .5; font-size: 13px; padding: 8px 0; }\n' +
'.tag { display: inline-block; max-width: 100%; padding: 1px 9px; border-radius: 999px; font-size: 11px; background: rgba(126,162,255,.14); border: 1px solid rgba(126,162,255,.3); color: #bcd0ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }\n' +
'.warn { color: #ffb0c0; }\n' +
'#tip {\n' +
'  position: fixed; z-index: 99; padding: 7px 12px; border-radius: 12px; max-width: 340px;\n' +
'  background: rgba(16,22,44,.94); border: 1px solid rgba(255,255,255,.2); color: #eaf0ff;\n' +
'  font-size: 12px; line-height: 1.6; pointer-events: none; opacity: 0; transition: opacity .12s;\n' +
'  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);\n' +
'  box-shadow: 0 8px 24px rgba(0,0,0,.55); white-space: pre-line; font-variant-numeric: tabular-nums;\n' +
'}\n' +
'footer { margin-top: 26px; text-align: center; font-size: 11.5px; opacity: .42; line-height: 1.8; }\n' +
'::-webkit-scrollbar { width: 9px; height: 9px; }\n' +
'::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 9px; }\n' +
'::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.24); }\n' +
'::-webkit-scrollbar-track { background: transparent; }\n' +
'.err { padding: 16px 20px; border-radius: 16px; background: rgba(255,80,110,.12); border: 1px solid rgba(255,110,140,.35); color: #ffc4d0; font-size: 13.5px; margin-bottom: 16px; }\n' +
'/* v2.5（P2）：记忆文档状态 + 回归台账样式 */\n' +
'.docsec { margin: 10px 0; }\n' +
'.dsl { font-size: 11px; font-weight: 600; letter-spacing: .5px; opacity: .55; margin: 12px 0 4px; }\n' +
'.drow { display: flex; align-items: center; gap: 10px; padding: 5px 2px; font-size: 12.5px; border-bottom: 1px dashed rgba(255,255,255,.06); }\n' +
'.dfn { flex: 0 0 200px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
'.dmeta { flex: none; font-variant-numeric: tabular-nums; opacity: .75; font-size: 11.5px; }\n' +
'.dmuted { flex: none; font-size: 11px; opacity: .45; min-width: 52px; text-align: right; }\n' +
'.dbar-track { flex: 1; background: rgba(255,255,255,.07); border-radius: 999px; height: 7px; overflow: hidden; min-width: 60px; }\n' +
'.dbar { height: 7px; border-radius: 999px; background: var(--ac, linear-gradient(90deg,#12b886,#39d9b0)); box-shadow: 0 0 8px var(--ac, #39d9b0); transition: width .8s cubic-bezier(.22,1,.36,1); }\n' +
'.thr { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 10px; font-size: 11.5px; }\n' +
'.thr-l { opacity: .55; }\n' +
'.thr-i { opacity: .6; font-variant-numeric: tabular-nums; }\n' +
'.hbtn2 { margin-left: auto; padding: 5px 14px; font-size: 12px; }\n' +
'.tag.ok { background: rgba(18,184,134,.16); border-color: rgba(18,184,134,.4); color: #7fe6c9; }\n' +
'.tag.stale { background: rgba(255,141,66,.14); border-color: rgba(255,141,66,.4); color: #ffc49a; }\n' +
'@media (max-width: 700px) { .dfn { flex-basis: 110px; } }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div></div>\n' +
'<div class="wrap">\n' +
'<header>\n' +
'  <div>\n' +
'    <h1><span class="logo">◈</span>dsh-memory 记忆统计面板</h1>\n' +
'    <div class="sub" id="sub">加载中…</div>\n' +
'  </div>\n' +
'  <div class="hbtn">\n' +
'    <span id="status"></span>\n' +
'    <button id="btn" onclick="load()"><span id="spin">⟳</span>刷新</button>\n' +
'  </div>\n' +
'</header>\n' +
'<div id="app"><div class="muted">正在读取监控数据…</div></div>\n' +
'<footer>数据源 ~/.dsh/memory/.monitor.json · 插件实时维护 · 同源读取，点刷新即最新<br>dsh-memory · 记忆不遗忘</footer>\n' +
'</div>\n' +
'<script>\n' +
'var tipEl = null;\n' +
'function initTip() {\n' +
'  if (tipEl) return;\n' +
'  tipEl = document.createElement("div"); tipEl.id = "tip"; document.body.appendChild(tipEl);\n' +
'  document.addEventListener("mousemove", function (e) {\n' +
'    var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;\n' +
'    if (t) {\n' +
'      tipEl.textContent = t.getAttribute("data-tip");\n' +
'      tipEl.style.opacity = "1";\n' +
'      var r = tipEl.getBoundingClientRect();\n' +
'      var x = e.clientX + 14, y = e.clientY + 18;\n' +
'      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;\n' +
'      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;\n' +
'      tipEl.style.left = x + "px"; tipEl.style.top = y + "px";\n' +
'    } else tipEl.style.opacity = "0";\n' +
'  });\n' +
'}\n' +
'function esc(s) { return String(s == null ? "" : s).replace(/[<>&"]/g, function (c) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", \'"\': "&quot;" }[c]; }); }\n' +
'function tip(s) { return \' data-tip="\' + esc(s) + \'"\'; }\n' +
'function fmtT(t) { return t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "-"; }\n' +
'function rel(t) {\n' +
'  if (!t) return "";\n' +
'  var d = Date.now() - t;\n' +
'  if (d < 60000) return "刚刚";\n' +
'  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";\n' +
'  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";\n' +
'  return Math.floor(d / 86400000) + " 天前";\n' +
'}\n' +
'function wan(n) { return Math.round((n || 0) / 10000); }\n' +
'function num(n) { return String(n == null ? 0 : n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ","); }\n' +
'function anim() {\n' +
'  requestAnimationFrame(function () {\n' +
'    var bs = document.querySelectorAll(".bar");\n' +
'    for (var i = 0; i < bs.length; i++) bs[i].style.width = bs[i].getAttribute("data-w") + "%";\n' +
'    var cs = document.querySelectorAll(".cbar");\n' +
'    for (var j = 0; j < cs.length; j++) cs[j].style.height = cs[j].getAttribute("data-h") + "%";\n' +
'  });\n' +
'}\n' +
'async function load() {\n' +
'  var btn = document.getElementById("btn"), st = document.getElementById("status");\n' +
'  btn.classList.add("busy"); st.textContent = "读取中…";\n' +
'  try {\n' +
'    var r = await fetch("/dsh-memory/stats.json", { cache: "no-store" });\n' +
'    if (!r.ok) throw new Error("HTTP " + r.status);\n' +
'    var d = await r.json();\n' +
'    render(d);\n' +
'    st.textContent = "";\n' +
'  } catch (e) {\n' +
'    document.getElementById("sub").textContent = "⚠️ 加载失败";\n' +
'    document.getElementById("app").innerHTML = \'<div class="err">读取 stats.json 失败：\' + esc(e.message) + \'。请确认 DSH 已启动且插件已加载 webServer 路由。</div>\';\n' +
'    st.textContent = "失败";\n' +
'  } finally { btn.classList.remove("busy"); }\n' +
'}\n' +
'function render(d) {\n' +
'  initTip();\n' +
'  var hints = d.hints || {}, mt = d.maintain || {};\n' +
'  var fr = (d.followed + d.ignored) > 0 ? Math.round(d.followed * 100 / (d.followed + d.ignored)) : null;\n' +
'  var cut24 = Date.now() - 86400000, arch = { start: 0, settle: 0, throttle: 0, fail: 0 };\n' +
'  var toolCount = {}, dayCount = {};\n' +
'  var evs = d.events || [];\n' +
'  for (var i = 0; i < evs.length; i++) {\n' +
'    var ev = evs[i];\n' +
'    if (ev.type === "tool" && ev.detail && ev.detail.name) toolCount[ev.detail.name] = (toolCount[ev.detail.name] || 0) + 1;\n' +
'    if (ev.t) { var k = new Date(ev.t).toISOString().slice(0, 10); dayCount[k] = (dayCount[k] || 0) + 1; }\n' +
'    if (ev.type === "archive" && ev.t >= cut24) {\n' +
'      var dt = String(ev.detail || "");\n' +
'      if (dt.indexOf("started") === 0) arch.start++;\n' +
'      else if (dt.indexOf("settled") === 0) arch.settle++;\n' +
'      else if (dt.indexOf("throttled") === 0) arch.throttle++;\n' +
'      else if (dt.indexOf("failed") === 0) arch.fail++;\n' +
'    }\n' +
'  }\n' +
'  var totalTool = 0; for (var tn in toolCount) totalTool += toolCount[tn];\n' +
'  var topTools = Object.entries(toolCount).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);\n' +
'  var maxTool = topTools.length ? topTools[0][1] : 1;\n' +
'  var days = [];\n' +
'  for (var g = 29; g >= 0; g--) { var dk = new Date(Date.now() - g * 86400000).toISOString().slice(0, 10); days.push([dk, dayCount[dk] || 0]); }\n' +
'  var maxDay = 1, sum30 = 0;\n' +
'  for (var g2 = 0; g2 < days.length; g2++) { if (days[g2][1] > maxDay) maxDay = days[g2][1]; sum30 += days[g2][1]; }\n' +
'  var domains = Object.entries(d.byDomain || {}).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 7);\n' +
'  var domTotal = 0; for (var g3 = 0; g3 < domains.length; g3++) domTotal += domains[g3][1];\n' +
'  var maxDom = domains.length ? domains[0][1] : 1;\n' +
'  document.getElementById("sub").textContent = "更新时间 " + fmtT(d.updatedAt) + " · 监控 " + (d.monitorEnabled === false ? "已暂停" : "开启") + (d.installedAt ? " · 自 " + new Date(d.installedAt).toLocaleDateString("zh-CN") : "");\n' +
'  var h = "";\n' +
'  function kpi(v, label, dot, ac, tipTxt) {\n' +
'    return \'<div class="kpi glass" style="--dot:\' + dot + ";--ac:" + ac + \'"\' + tip(tipTxt) + \'><div class="kv">\' + v + \'</div><div class="kl"><span class="kdot"></span>\' + label + "</div></div>";\n' +
'  }\n' +
'  h += \'<div class="kpis">\';\n' +
'  h += kpi(hints.A || 0, "关键词提醒 A", "#5ba7ff", "linear-gradient(90deg,#3d7bfd,#5ba7ff)", "累计触发 " + (hints.A || 0) + " 次（回答前注入「先查记忆」）");\n' +
'  h += kpi(hints.B || 0, "重复错误提醒 B", "#ffb45b", "linear-gradient(90deg,#ff9d3d,#ffb45b)", "同类报错第 2 次起提醒查记忆");\n' +
'  h += kpi(hints.C || 0, "连续失败提醒 C", "#ff6e8a", "linear-gradient(90deg,#ff4d6d,#ff6e8a)", "同一工具连续失败 3 次提醒");\n' +
'  h += kpi(hints.D || 0, "循环空转提醒 D", "#c05bff", "linear-gradient(90deg,#9a3dff,#c05bff)", "滑窗打转 + 负面占比超阈提醒");\n' +
'  h += kpi(hints.E || 0, "成功同质提醒 E", "#22d3ee", "linear-gradient(90deg,#0891b2,#22d3ee)", "同一命令成功重复且输出几乎没变提醒（簇内同质口径）");\n' +
'  h += kpi(hints.W || 0, "无介入看门狗 W", "#a3e635", "linear-gradient(90deg,#65a30d,#a3e635)", "距上次输入 ≥3 分钟且无介入持续 N 步提醒");\n' +
'  h += kpi(hints.BRK || 0, "打转熔断动作", "#ef4444", "linear-gradient(90deg,#dc2626,#ef4444)", "D2 拒调 + D3 停轮累计触发 " + (hints.BRK || 0) + " 次（同指纹连续重复≥brkSameN ∧ 产出静止）");\n' +
'  h += kpi(d.queries || 0, "记忆查询 · 回查率 " + (fr === null ? "暂无" : fr + "%"), "#39d9b0", "linear-gradient(90deg,#12b886,#39d9b0)", "查询 " + (d.queries || 0) + " 次\\n提醒后回查 " + (d.followed || 0) + " / 忽略 " + (d.ignored || 0) + (d.capped ? "\\n截断 " + d.capped + " 次" : ""));\n' +
'  h += kpi(mt.integRuns || 0, "记忆整合 · in " + wan(mt.inT) + "万 / out " + wan(mt.outT) + "万 tok", "#7d8cff", "linear-gradient(90deg,#5b5bd9,#7d8cff)", "整合 " + (mt.integRuns || 0) + " 轮\\ntoken：输入 " + num(mt.inT) + " · 缓存 " + num(mt.cacheT) + " · 输出 " + num(mt.outT));\n' +
'  h += kpi(mt.archRuns || 0, "漏网归档 · 24h 发起 " + arch.start + " / 完成 " + arch.settle + (arch.fail ? " / <span class=\'warn\'>失败 " + arch.fail + "</span>" : ""), "#f472b6", "linear-gradient(90deg,#ec4899,#f472b6)", "累计归档 " + (mt.archRuns || 0) + " 次\\n近 24h：发起 " + arch.start + " · 完成 " + arch.settle + " · 节流 " + arch.throttle + " · 失败 " + arch.fail);\n' +
'  h += "</div>";\n' +
'  h += \'<div class="grid">\';\n' +
'  h += \'<div class="card glass span2"><h2>近 30 天事件量<span class="h2n">30 天合计 \' + num(sum30) + " · 滚动窗口共 " + num(evs.length) + \' 条</span></h2><div class="cols">\';\n' +
'  for (var a = 0; a < days.length; a++) {\n' +
'    var pct = days[a][1] ? Math.max(3, Math.round(days[a][1] * 100 / maxDay)) : 0;\n' +
'    h += \'<div class="col"\' + tip(days[a][0] + "\\n" + num(days[a][1]) + " 事件") + \'><div class="cbar" data-h="\' + pct + \'"></div></div>\';\n' +
'  }\n' +
'  h += \'</div><div class="cxl">\';\n' +
'  for (var b2 = 0; b2 < days.length; b2++) h += "<span>" + (b2 % 5 === 0 ? days[b2][0].slice(5) : "") + "</span>";\n' +
'  h += "</div></div>";\n' +
'  function barList(arr, max, total) {\n' +
'    var s = "";\n' +
'    for (var i2 = 0; i2 < arr.length; i2++) {\n' +
'      var w = Math.max(1, Math.round(arr[i2][1] * 100 / max));\n' +
'      var share = total ? Math.round(arr[i2][1] * 1000 / total) / 10 : null;\n' +
'      s += \'<div class="brow"\' + tip(arr[i2][0] + "\\n" + num(arr[i2][1]) + " 次" + (share !== null ? " · 占 " + share + "%" : "")) + \'><span class="blab">\' + esc(arr[i2][0]) + \'</span><div class="bar-track"><div class="bar" data-w="\' + w + \'"></div></div><span class="bval">\' + arr[i2][1] + "</span></div>";\n' +
'    }\n' +
'    return s;\n' +
'  }\n' +
'  h += \'<div class="card glass"><h2>高频领域 TOP7<span class="h2n">累计 · 前 7 合计 \' + num(domTotal) + "</span></h2>";\n' +
'  h += domains.length ? barList(domains, maxDom, d.queries) : \'<div class="muted">暂无</div>\';\n' +
'  h += "</div>";\n' +
'  h += \'<div class="card glass"><h2>工具调用 TOP10<span class="h2n">窗口合计 \' + num(totalTool) + "</span></h2>";\n' +
'  h += topTools.length ? barList(topTools, maxTool, totalTool) : \'<div class="muted">暂无</div>\';\n' +
'  h += "</div>";\n' +
'  var sp = d.spiralEvents || [];\n' +
'  h += \'<div class="card glass"><h2>循环空转样本<span class="h2n">100 窗口 · 最近 \' + Math.min(sp.length, 12) + " 条</span></h2>";\n' +
'  if (sp.length) {\n' +
'    h += \'<table><thead><tr><th style="width:8%">类</th><th style="width:26%">时间</th><th style="width:15%">工具</th><th style="width:10%">重复</th><th style="width:10%">负面</th><th style="width:11%">相似/同质</th><th>工作区</th></tr></thead><tbody>\';\n' +
'    var spa = sp.slice(-12).reverse();\n' +
'    for (var s2 = 0; s2 < spa.length; s2++) {\n' +
'      var sv = spa[s2];\n' +
'      var kindTag = (sv.kind || "D") === "E" ? \'<span class="tag" style="color:#0891b2">E</span>\' : \'<span class="tag">D</span>\';\n' +
'      var simTxt = sv.kind === "E" ? (sv.homoRate == null ? "-" : Math.round(sv.homoRate * 100) + "%") : (sv.maxSim == null ? "-" : sv.maxSim);\n' +
'      var extraTip = sv.kind === "E" ? (sv.clusterN ? "\\n簇大小：" + sv.clusterN + " 步" : "") + (sv.clusterWallSecs ? "\\n簇墙钟：" + sv.clusterWallSecs + "s" : "") : "";\n' +
'      h += \'<tr><td>\' + kindTag + \'</td><td class="mono">\' + fmtT(sv.t) + \'</td><td><span class="tag"\' + tip("工具：" + sv.tool) + ">" + esc(sv.tool) + "</span></td><td class=\\"mono\\">" + Math.round((sv.repRate || 0) * 100) + "%</td><td class=\\"mono\\">" + Math.round((sv.negRate || 0) * 100) + \'%</td><td class="mono">\' + simTxt + \'</td><td class="mono ell"\' + tip("工作区：" + (sv.ws || "-") + (sv.topTools ? "\\n窗口内工具：" + sv.topTools : "") + extraTip + (sv.sample ? "\\n样本：" + String(sv.sample).slice(0, 120) : "")) + ">" + esc(sv.ws) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无（未检测到空转迹象）</div>\';\n' +
'  h += "</div>";\n' +
'  var we2 = d.watchEvents || [];\n' +
'  h += \'<div class="card glass"><h2>看门狗事件<span class="h2n">100 窗口 · 最近 \' + Math.min(we2.length, 8) + " 条</span></h2>";\n' +
'  if (we2.length) {\n' +
'    h += \'<table><thead><tr><th style="width:26%">时间</th><th style="width:14%">无介入步数</th><th style="width:14%">墙钟</th><th style="width:18%">工具</th><th>工作区</th></tr></thead><tbody>\';\n' +
'    var wea = we2.slice(-8).reverse();\n' +
'    for (var w2 = 0; w2 < wea.length; w2++) {\n' +
'      var wv = wea[w2];\n' +
'      h += \'<tr><td class="mono">\' + fmtT(wv.t) + \'</td><td class="mono">\' + wv.steps + \'</td><td class="mono">\' + (wv.wallSecs == null ? "-" : Math.round(wv.wallSecs / 60) + " 分") + \'</td><td class="mono">\' + esc(wv.topTool || "-") + \'</td><td class="mono ell"\' + tip("工作区：" + (wv.ws || "-")) + ">" + esc(wv.ws) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无（未检测到无介入长空转）</div>\';\n' +
'  h += "</div>";\n' +
'  var be = d.breakerEvents || [];\n' +
'  h += \'<div class="card glass"><h2>熔断动作样本<span class="h2n">100 窗口 · 最近 \' + Math.min(be.length, 8) + " 条</span></h2>";\n' +
'  if (be.length) {\n' +
'    h += \'<table><thead><tr><th style="width:26%">时间</th><th style="width:12%">档位</th><th style="width:15%">工具</th><th style="width:14%">动作</th><th>理由</th></tr></thead><tbody>\';\n' +
'    var bea = be.slice(-8).reverse();\n' +
'    for (var i3 = 0; i3 < bea.length; i3++) {\n' +
'      var bv = bea[i3];\n' +
'      var lvTag = bv.level === 2 ? \'<span class="tag" style="color:#f59e0b">D2拒调</span>\' : \'<span class="tag" style="color:#ef4444">D3停轮</span>\';\n' +
'      h += \'<tr><td class="mono">\' + fmtT(bv.t) + \'</td><td>\' + lvTag + \'</td><td class="mono">\' + esc(bv.tool || "-") + \'</td><td class="mono">\' + esc(bv.action || "-") + \'</td><td class="ell"\' + tip("理由：" + (bv.reason || "-")) + ">" + esc((bv.reason || "-").slice(0, 40)) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无（尚未触发熔断）</div>\';\n' +
'  h += "</div>";\n' +
'  var tp = d.turnProfiles || [];\n' +
'  h += \'<div class="card glass"><h2>任务周期画像<span class="h2n">200 窗口 · 最近 \' + Math.min(tp.length, 12) + " 条</span></h2>";\n' +
'  if (tp.length) {\n' +
'    h += \'<table><thead><tr><th style="width:26%">开始</th><th style="width:11%">时长</th><th style="width:9%">调用</th><th style="width:12%">负/错</th><th style="width:10%">D/E 空转</th><th style="width:13%">p50/p90</th><th>工作区</th></tr></thead><tbody>\';\n' +
'    var tpa = tp.slice(-12).reverse();\n' +
'    for (var t2 = 0; t2 < tpa.length; t2++) {\n' +
'      var pv = tpa[t2];\n' +
'      h += \'<tr><td class="mono">\' + fmtT(pv.t) + \'</td><td class="mono">\' + (pv.durMin == null ? "-" : pv.durMin) + \' min</td><td class="mono">\' + pv.calls + \'</td><td class="mono">\' + pv.negN + " / " + pv.errN + \'</td><td class="mono">\' + (pv.spiralN || 0) + " / " + (pv.spiralE || 0) + \'</td><td class="mono">\' + (pv.simP50 == null ? "-" : pv.simP50) + " / " + (pv.simP90 == null ? "-" : pv.simP90) + \'</td><td class="mono ell"\' + tip("工作区：" + (pv.ws || "-") + (pv.topTools ? "\\n高频工具：" + pv.topTools : "")) + ">" + esc(pv.ws) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无</div>\';\n' +
'  h += "</div>";\n' +
'  var rq = d.recentQueries || [];\n' +
'  h += \'<div class="card glass span2"><h2>最近查询<span class="h2n">\' + rq.length + " / 20 条</span></h2>";\n' +
'  if (rq.length) {\n' +
'    h += \'<table><thead><tr><th style="width:62%">查询词</th><th style="width:23%">时间</th><th>距今</th></tr></thead><tbody>\';\n' +
'    for (var q2 = rq.length - 1; q2 >= 0; q2--) {\n' +
'      var q = rq[q2];\n' +
'      h += \'<tr><td class="qtext">\' + esc(q.query) + \'</td><td class="mono">\' + fmtT(q.t) + \'</td><td class="mono">\' + rel(q.t) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无查询记录</div>\';\n' +
'  h += "</div>";\n' +
'  var et = d.spiralThresh || {}, tlog = d.spiralThreshLog || [], last = tlog.length ? tlog[tlog.length - 1] : null;\n' +
'  function tv(v, def) { return v == null ? \'<span class="muted">默认 \' + def + "</span>" : "<b>" + v + "</b>"; }\n' +
'  function mk(v, def, label, tipTxt) {\n' +
'    return \'<div class="kpi" style="--dot:#7d8cff;--ac:linear-gradient(90deg,#5b5bd9,#7d8cff);padding:12px 14px"\' + tip(tipTxt) + \'><div class="kv" style="font-size:20px">\' + tv(v, def) + \'</div><div class="kl"><span class="kdot"></span>\' + label + "</div></div>";\n' +
'  }\n' +
'  h += \'<div class="card glass span2"><h2>空转判定阈值<span class="h2n">/dream 自校准 · dsh_spiral_thresh 可调</span></h2>\';\n' +
'  h += \'<div class="kpis" style="margin:0;grid-template-columns:repeat(auto-fit,minmax(125px,1fr))">\';\n' +
'  h += mk(et.rep, 0.45, "重复占比", "args 重复调用占比达此值判为打转（生效 " + (et.rep == null ? 0.45 : et.rep) + "）");\n' +
'  h += mk(et.neg, 0.4, "负面占比", "工具报错/负结果占比达此值才提醒（生效 " + (et.neg == null ? 0.4 : et.neg) + "）");\n' +
'  h += mk(et.sim, 0.7, "args 相似度", "两次调用参数相似度阈值（生效 " + (et.sim == null ? 0.7 : et.sim) + "）");\n' +
'  h += mk(et.w, 8, "滑窗大小", "循环检测滑动窗口步数（生效 " + (et.w == null ? 8 : et.w) + "）");\n' +
'  h += mk(et.cooldownMin, 10, "冷却(分)", "同会话提醒最小间隔（生效 " + (et.cooldownMin == null ? 10 : et.cooldownMin) + " 分钟）");\n' +
'  h += mk(et.sameNeg, 0.3, "E 成功上限", "E 类：簇内负面率低于此值才判成功同质（生效 " + (et.sameNeg == null ? 0.3 : et.sameNeg) + "）");\n' +
'  h += mk(et.sameSteps, 4, "E 簇步数", "E 类：簇内重复绝对步数下限（生效 " + (et.sameSteps == null ? 4 : et.sameSteps) + "）");\n' +
'  h += mk(et.sameMinSecs, 60, "E 簇墙钟(s)", "E 类：簇墙钟下限秒数防快速抖动（生效 " + (et.sameMinSecs == null ? 60 : et.sameMinSecs) + "）");\n' +
'  h += mk(et.sameHomo, 0.8, "E 同质占比", "E 类：簇内 distinct 指纹/簇长低于此值判同质（生效 " + (et.sameHomo == null ? 0.8 : et.sameHomo) + "）");\n' +
'  h += mk(et.watchSteps, 10, "W 步数", "W 类：距上次输入无介入步数下限（生效 " + (et.watchSteps == null ? 10 : et.watchSteps) + "）");\n' +
'  h += mk(et.watchSecs, 180, "W 墙钟(s)", "W 类：距上次输入无介入秒数下限（生效 " + (et.watchSecs == null ? 180 : et.watchSecs) + "）");\n' +
'  h += mk(et.watchCooldownMin, 10, "W 冷却(分)", "W 类：同会话看门狗冷却（生效 " + (et.watchCooldownMin == null ? 10 : et.watchCooldownMin) + " 分钟）");\n' +
'  h += \'<div class="kpi" style="--dot:#f472b6;--ac:linear-gradient(90deg,#ec4899,#f472b6);padding:12px 14px"\' + tip(last ? fmtT(last.t) + "\\n" + (last.reason || "无备注") + (last.from ? "\\n" + JSON.stringify(last.from) + " → " + JSON.stringify(last.to) : "") : "从未调整（全部内置默认）") + \'><div class="kv ell" style="font-size:14px;line-height:1.7;max-width:100%">\' + (last ? new Date(last.t).toLocaleDateString("zh-CN") + " · " + esc(last.reason || "无备注") : "从未调整") + \'</div><div class="kl"><span class="kdot"></span>最近调整</div></div>\';\n' +
'  h += "</div></div>";\n' +
'  h += "</div>";\n' +
'  // ── v2.5（P2）：记忆文档状态 + 超限阈值 ──\n' +
'  // v2.6（P1 修误报）：注入预算只约束注入层（global/index/今日摘要）；工具/项目/知识/历史会话为按需读取层，\n' +
'  //   大文件属正常，不标超限、不画阈值条，仅展示大小 + 中性「大文件」提示（>64KB）。\n' +
'  var docs = d.documents || [];\n' +
'  h += \'<div class="card glass span2"><h2>记忆文档状态<span class="h2n">注入层软硬阈值 · 按需层仅展示大小 · 最后更新 · 过期复核（>180 天）</span></h2>\';\n' +
'  if (docs.length) {\n' +
'    for (var di = 0; di < docs.length; di++) {\n' +
'      var sec = docs[di];\n' +
'      var injLayer = sec.layer === "稳定层" || sec.layer === "会话层（今日）";   // 注入层=global/index + 今日摘要；其余按需\n' +
'      h += \'<div class="docsec"><div class="dsl">\' + esc(sec.layer) + (injLayer ? "" : " <span class=\'tag\'>按需</span>") + "</div>";\n' +
'      for (var di2 = 0; di2 < sec.docs.length; di2++) {\n' +
'        var dc = sec.docs[di2];\n' +
'        var over = injLayer && (dc.overSoft || dc.overHard) ? " <span class=\'tag warn\'>" + (dc.overHard ? "硬超" : "软超") + "</span>" : "";\n' +
'        var staleTag = dc.stale ? " <span class=\'tag stale\'>过期复核</span>" : "";\n' +
'        var bigTag = !injLayer && dc.bytes > 65536 ? " <span class=\'tag\'>大文件</span>" : "";\n' +
'        var capTag = (dc.rel || "").indexOf("projects/") === 0 ? (dc.chars > 9000 ? " <span class=\'tag\' style=\'color:#c0392b\'>超限</span>" : (dc.chars > 6000 ? " <span class=\'tag\' style=\'color:#b7950b\'>偏大</span>" : "")) : "";\n' +
'        var wp = injLayer ? Math.min(100, Math.round(dc.chars * 100 / Math.max(1, dc.charLimit))) : 0;\n' +
'        var rectCol = injLayer ? (dc.overHard ? "linear-gradient(90deg,#ff4d6d,#ff6e8a)" : (dc.overSoft ? "linear-gradient(90deg,#ff9d3d,#ffb45b)" : "linear-gradient(90deg,#12b886,#39d9b0)")) : "linear-gradient(90deg,#5ba7ff,#7db8ff)";\n' +
'        h += \'<div class="drow"\' + tip(dc.rel + "\\n字符 " + num(dc.chars) + (injLayer ? " / 硬限 " + dc.charLimit + "\\n字节 " + num(dc.bytes) + "B / 软限 " + dc.byteWarn + "B" : "\\n字节 " + num(dc.bytes) + "B（按需读取层，无注入预算，大文件属正常）") + "\\n更新 " + fmtT(dc.mtime) + (dc.stale ? "\\n⚠ 文件头最后更新 >180 天" : "")) + \'><span class="dfn ell">\' + esc(dc.rel) + "</span>" + over + capTag + bigTag + staleTag + \'<span class="dmeta muted">\' + num(dc.chars) + "字 / " + num(dc.bytes) + "B</span>" + (injLayer ? \'<div class="dbar-track"><div class="dbar" style="width:\' + wp + "%;--ac:" + rectCol + \'"></div></div>\' : "") + \'<span class="dmuted">\' + rel(dc.mtime) + "</span></div>";\n' +
'      }\n' +
'    }\n' +
'    h += \'<div class="thr"><span class="thr-l muted">参考阈值</span><span class="thr-i">软(字节) global/index 4608B · 摘要 4096B</span><span class="thr-i">硬(字符) global 3000 · index 2000 · 摘要 1500</span><span class="thr-i">按需层（工具/项目/知识/历史会话）无注入预算，仅展示大小</span></div>\';\n' +
'    h += "</div>";   // 记忆文档状态卡闭合\n' +
'  } else {\n' +
'    h += \'<div class="muted">暂无文档状态数据（服务端未附加字段）</div></div>\';\n' +
'  }\n' +
'  // ── v2.5（P2）：回归闭环 KPI + pending 台账 ──\n' +
'  var ls = d.lessons || {};\n' +
'  var rateTxt = "暂无";\n' +
'  if ((ls.fed || 0) + (ls.skippedByDream || 0) > 0) rateTxt = Math.round((ls.fed || 0) * 100 / ((ls.fed || 0) + (ls.skippedByDream || 0))) + "%";\n' +
'  h += \'<div class="kpis" style="margin-bottom:16px">\';\n' +
'  h += kpi(ls.open || 0, "回归记录 · open", "#39d9b0", "linear-gradient(90deg,#12b886,#39d9b0)", "累计 open 事件次数（台账当前 open 待沉淀条数见下方台账）");\n' +
'  h += kpi(ls.closed || 0, "已闭环 · closed", "#5ba7ff", "linear-gradient(90deg,#3d7bfd,#5ba7ff)", "累计闭环次数（sig 连续 5 步未再现）");\n' +
'  h += kpi((ls.dropped || 0) + " / " + (ls.kicked || 0), "dropped / kicked", "#ff6e8a", "linear-gradient(90deg,#ff4d6d,#ff6e8a)", "dropped=48h 超时放弃 / kicked=反复踢回用户软提醒");\n' +
'  h += kpi(rateTxt, "沉淀率 fed/" + ((ls.fed || 0) + (ls.skippedByDream || 0)), "#f472b6", "linear-gradient(90deg,#ec4899,#f472b6)", "/dream 沉淀成功 " + (ls.fed || 0) + " · 拒绝 " + (ls.skippedByDream || 0));\n' +
'  h += "</div>";\n' +
'  var pl = d.pendingLessons || { enabled: true, entries: [] };\n' +
'  h += \'<div class="card glass span2"><h2>回归待沉淀台账<span class="h2n">\' + pl.entries.length + " / 50 条" + (pl.enabled ? "" : " · 回归已禁用") + \'</span>\';\n' +
'  h += \'<button class="hbtn2" id="pendClear">清空台账</button></h2>\';\n' +
'  if (pl.entries.length) {\n' +
'    h += \'<table><thead><tr><th style="width:28%">错误签名</th><th style="width:8%">状态</th><th style="width:9%">cleanSteps</th><th style="width:14%">新增</th><th>error 摘要</th><th style="width:16%">solution / 更新</th></tr></thead><tbody>\';\n' +
'    var pla = pl.entries.slice().reverse();\n' +
'    for (var pi = 0; pi < pla.length; pi++) {\n' +
'      var pe = pla[pi];\n' +
'      var stCls = pe.state === "resolved" ? "tag ok" : (pe.state === "dropped" ? "tag stale" : "tag");\n' +
'      var solTxt = pe.solution ? pe.solution : (pe.lastSeenAt ? rel(pe.lastSeenAt) : "-");\n' +
'      var solTip = (pe.solution ? pe.solution + (pe.lastSeenAt ? "\\n更新 " + fmtT(pe.lastSeenAt) : "") : (pe.lastSeenAt ? "最后出现 " + fmtT(pe.lastSeenAt) : ""));\n' +
'      h += \'<tr><td class="mono ell"\' + tip(pe.sig) + ">" + esc(pe.sig) + \'</td><td><span class="\' + stCls + \'">\' + pe.state + \'</span></td><td class="mono">\' + (pe.cleanSteps == null ? "-" : pe.cleanSteps) + \'</td><td class="mono ell"\' + (pe.capturedAt ? tip("新增 " + fmtT(pe.capturedAt) + (pe.lastSeenAt ? "\\n更新 " + fmtT(pe.lastSeenAt) : "")) : "") + ">" + (pe.capturedAt ? fmtT(pe.capturedAt).slice(5) : "-") + \'</td><td class="ell"\' + tip(pe.error || "-") + ">" + esc(pe.error || "-") + \'</td><td class="mono ell"\' + tip(solTip) + ">" + esc(solTxt) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'    h += \'<div class="muted" style="margin-top:8px">清空台账后条目将从 .pending-lessons.json 移除（已闭环/已沉淀的不受影响）。</div>\';\n' +
'    h += "</div>";\n' +
'  } else h += \'<div class="muted">暂无待沉淀条目</div></div>\';\n' +
'  setTimeout(function () {\n' +
'    var btn = document.getElementById("pendClear");\n' +
'    if (btn) btn.addEventListener("click", function () {\n' +
'      if (!confirm("清空全部回归待沉淀条目？")) return;\n' +
'      fetch("/dsh-memory/pending-clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function (r) { return r.json(); }).then(function () { location.reload(); }).catch(function (e) { alert("清空失败：" + e.message); });\n' +
'    });\n' +
'  }, 50);\n' +
'  var app = document.getElementById("app");\n' +
'  app.innerHTML = h;\n' +
'  anim();\n' +
'}\n' +
'load();\n' +
'</script>\n' +
'</body>\n' +
'</html>\n';
}
export default {
  inject: ["fs", "timer", "commands", "skills"],
  apply(ctx, config) {
    // v2.3.4(dream-hash)：候选函数绑定模块级 hash 版本（纯函数，见 export default 前的 >>> INT_HASH BEGIN 区）
    const listIntegrateCandidates = hashListIntegrateCandidates;
    // v1.4.0：设置机制 —— cordis.patch.yml config 作 base 默认层，settings.yaml 用户文档覆盖。
    // 手动 register 拿到宿主 scope（写只读统计 staleCount）；无 settings 服务时回退 cordis config。
    PLUGIN_CFG = normalizeCfg(config);
    // v1.11.0：enabledAt 与 DSH 进程启停彻底解耦——
    // DSH 重启/退出不再影响 enabledAt（dispose 不再置 null）。
    // enabledAt 只由「记忆活跃开关 active」驱动：
    //   - active=true 且已有 enabledAt → 保持（DSH 重启多少次都不动）
    //   - active=true 且无 enabledAt（首次安装/历史残留）→ 设为 installAt
    //   - active=false（用户显式暂停记忆）→ enabledAt 置空（不纳入漏网）
    try {
      const now = Date.now();
      const st = readIntegrateState() || { installAt: now, lastIntegrateAt: 0 };
      if (!st.installAt) st.installAt = now;
      // 用户显式暂停记忆：enabledAt 置空，漏网不纳入
      // v1.12.19.2: 启动期状态日志静默化（用户切换开关的实时反馈仍保留在 settings watch 处）
      if (PLUGIN_CFG.active === false) {
        st.enabledAt = null;   // 用户显式暂停记忆
      } else if (!(typeof st.enabledAt === "number" && st.enabledAt > 0)) {
        st.enabledAt = st.installAt;   // 首次安装/历史残留，与进程启停无关
      }
      // active=true 且已有 enabledAt → 保持，不随 DSH 启动刷新
      delete st.lastEnabledAt;  // 旧字段清理
      writeIntegrateState(st);
    } catch (e) { /* 状态记录失败不影响功能 */ }
    // v1.10.0：启动时加载 sessions/*.md 缓存（漏网检测高性能）
    refreshMemorySessionsIndex();
    try {
      ctx.inject(["settings"], (sctx) => {
        try {
          HOST_SETTINGS_SCOPE = sctx.settings.register("dsh-memory", SETTINGS_SCHEMA, {
            base: config || DEFAULT_CFG
          });
          PLUGIN_CFG = normalizeCfg(HOST_SETTINGS_SCOPE.get());
          HOST_SETTINGS_SCOPE.watch(() => {
            const next = HOST_SETTINGS_SCOPE.get();
            const prev = { ...PLUGIN_CFG };
            PLUGIN_CFG = normalizeCfg(next);
            // v1.11.0：active 开关变化驱动 enabledAt（用户显式，独立于 DSH 启停）
            try {
              const st = readIntegrateState() || {};
              const prevActive = (typeof prev.active === "boolean") ? prev.active : DEFAULT_CFG.active;
              if (prevActive !== PLUGIN_CFG.active) {
                if (PLUGIN_CFG.active === false) {
                  st.enabledAt = null;  // 用户显式暂停记忆
                  clog("[dsh-memory] 记忆活跃开关已关，enabledAt 置空（记忆整合暂停）");
                } else {
                  st.enabledAt = Date.now();  // 用户显式重新启用：刷新界限
                  clog("[dsh-memory] 记忆活跃开关已开，enabledAt 刷新=" + new Date(st.enabledAt).toISOString().slice(0, 19) + "（此后交互会话纳入漏网）");
                }
                writeIntegrateState(st);
              }
            } catch (e) { /* 开关切换失败不影响配置 */ }
            // v1.12.6：仅业务配置真变化才打日志（宿主自身 update({monitorSummary}) 触发的 watch 不再刷屏）
            if (prev.staleSessionDays !== PLUGIN_CFG.staleSessionDays || prev.staleAction !== PLUGIN_CFG.staleAction || prev.active !== PLUGIN_CFG.active) {
              clog("[dsh-memory] 设置已更新: staleSessionDays=" + PLUGIN_CFG.staleSessionDays + ", staleAction=" + PLUGIN_CFG.staleAction + ", active=" + PLUGIN_CFG.active);
            }
          });
          // v1.12.1：启动时主动推送一次监控汇总（读磁盘历史数据），否则重启后界面一直显示"暂无统计"
          updateMonitorSummary();
        } catch (e) {
          cwarn("[dsh-memory] settings register 失败，回退 cordis config:", e && e.message ? e.message : String(e));
        }
      });
    } catch (e) {
      cwarn("[dsh-memory] settings 注入失败，回退 cordis config:", e && e.message ? e.message : String(e));
    }
    // ═══════════ v2.4.2 统计面板：webServer 路由（设置页超链接 → 同源 /dsh-memory/stats）═══════════
    // 页面同源 fetch /dsh-memory/stats.json 拿最新监控数据，打开即最新、手动刷新按钮 re-fetch。
    // 官方扩展点先例：webhook-github（ctx.effect+register exact 路由）、gateway（ctx.inject 动态可选注入）。
    // 不声明顶层 inject 依赖 webServer——CLI/headless 无此服务，声明会让整个插件加载失败；回调式注入=有则挂、无则静默。
    // 三重降级：①服务缺失回调不执行 ②回调体内 try/catch（register 抛错不逃逸 cordis）③ctx.effect 绑 fiber 生命周期（dispose 注销路由，防重启/切换后 duplicate path）。
    try {
      ctx.inject(["webServer"], (wctx) => {
        try {
          const wsrv = wctx && wctx.webServer;
          if (!wsrv || typeof wsrv.register !== "function") return;
          // JSON 数据端点：实时读 .monitor.json（每次请求都读最新）
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/stats.json",
            handler: (_req, res) => {
              try {
                const raw = fs.readFileSync(portable(MEMORY_ROOT + "/.monitor.json"), "utf8");
                res.setHeader("content-type", "application/json; charset=utf-8");
                // v2.5（P2）：记忆文档状态 + 阈值 + 回归闭环附加数据——前端直接渲染（服务端算好，对标 calibStats 预计算）
                try {
                  const base = JSON.parse(raw);
                  // v2.4.30：存量 .monitor.json hints 缺 E/W 键（defaultMonitorData 只在新文件生效，此处直接读文件）——
                  // 补 0 防面板 KPI 显示空；E/W 首次触发后键自然出现，本行保证之前展示完整
                  if (base.hints && typeof base.hints === "object") {
                    if (base.hints.E === undefined) base.hints.E = 0;
                    if (base.hints.W === undefined) base.hints.W = 0;
                  }
                  base.documents = buildMemoryDocStatus();
                  base.pendingLessons = buildPendingLessonsSummary();
                  res.end(JSON.stringify(base));
                } catch (e) {
                  res.end(raw);   // 附加字段失败则原样返回（不阻塞面板主功能）
                }
              } catch (e) {
                res.statusCode = 404; res.setHeader("content-type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ error: "监控数据不存在（尚未产生使用记录）" }));
              }
            }
          }), "dsh-memory: /dsh-memory/stats.json");
          // HTML 页面端点：返回静态壳（数据由前端 fetch stats.json 加载）
          // v2.4.2.1：优先读 ~/.dsh/memory/.stats-panel.html 覆盖文件（每请求实时读，改面板不再需要重启 DSH）；无覆盖时回退内嵌 renderStatsPage
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/stats",
            handler: (_req, res) => {
              try {
                res.setHeader("content-type", "text/html; charset=utf-8");
                let body = null;
                try {
                  const ov = portable(MEMORY_ROOT + "/.stats-panel.html");
                  if (fs.existsSync(ov)) body = fs.readFileSync(ov, "utf8");
                } catch (e0) { body = null; }
                res.end(body && body.length > 500 ? body : renderStatsPage());
              } catch (e) { res.statusCode = 500; res.end("stats render error"); }
            }
          }), "dsh-memory: /dsh-memory/stats");
          // v2.5（P2）：pending-lessons 清空入口（POST body { sig?, sessionId? }——按键删除；缺省清全部）
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/pending-clear",
            handler: (req, res) => {
              try {
                res.setHeader("content-type", "application/json; charset=utf-8");
                let body = "";
                try { req.on && req.on("data", (c) => { body += c; }); } catch (e0) {}
                const doClear = () => {
                  try {
                    const want = (() => { try { return JSON.parse(body || "{}"); } catch (e) { return {}; } })();
                    const sig = want && want.sig, sid2 = want && want.sessionId;
                    const P = readLessonPending();
                    const before = P.entries.length;
                    if (sig || sid2) {
                      P.entries = P.entries.filter((e) => !(sig && e.sig === sig) && !(sid2 && e.sessionId === sid2));
                    } else {
                      P.entries = [];
                    }
                    scheduleLessonSave(true);
                    res.end(JSON.stringify({ ok: true, removed: before - P.entries.length, total: P.entries.length }));
                  } catch (e2) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e2 && e2.message || e2) })); }
                };
                try { req.on && req.on("end", doClear); } catch (e3) { doClear(); }
                if (!req.on) doClear();
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: "clear failed" })); }
            }
          }), "dsh-memory: /dsh-memory/pending-clear");
          clog("[dsh-memory] 统计面板已挂载：http://127.0.0.1:" + (wsrv.port || "?") + "/dsh-memory/stats");
        } catch (e) { cwarn("[dsh-memory] 统计面板路由注册失败（降级，其余功能不受影响）：", e && e.message ? e.message : String(e)); }
      });
    } catch (e) { cwarn("[dsh-memory] webServer 注入失败（统计面板不可用）：", e && e.message ? e.message : String(e)); }
    // v6：主会话 id（session-start 时记录第一个，用于过滤子代理压缩事件）
    // v10.3：不再用 rootSessionId 判定"主会话"（多主会话场景会误判），改查 session.header.origin；
    // 保留 rootSessionId 仅作兼容兜底，判定主逻辑见 isTopLevelSession()
    let rootSessionId = null;
    const archivedCompactionIds = new Set();
    // v9：sessionId → agent（compaction 事件时按会话查 agent 注入提醒）
    const agentsBySession = new Map();
    // v10.3：同实例维护提醒去重——一个 DSH 实例内只注入一次（第一个顶层会话），
    // 避免多个主会话并发收到整理指令、并发 edit 同一文件
    let maintenanceInjected = false;

    // v10.3：判断是否顶层会话（主会话），排除子代理
    // 依据 SessionHeader.origin === 'subagent'（持久化标记，可靠）；header 可能缺失时退回
    // rootSessionId 兼容（老会话无 header）：第一个 session-start 视为顶层
    function isTopLevelSession(agent) {
      const s = agent && agent.session;
      if (s && s.header && s.header.origin === 'subagent') return false;
      if (s && s.header && s.header.origin !== 'subagent') return true;
      // header 缺失或 origin 未标记：用 rootSessionId 兜底（第一个启动者视为顶层）
      return rootSessionId === null || (s && s.id === rootSessionId);
    }

    // v2.4.27（子代理提醒放开+插件隔离）：会话提醒注入的三种类别——
    //   top    = 顶层主会话：A/B/C/D 全部维持现状
    //   plugin = 插件 spawn 子代理（压缩/归档/dream）：A/B/C/D 全关，只记 monitor（已有 watchdog/toolFilter/检查点护栏；
    //            且 D 会把其设计内合法重试——反复调 memory_dream_patch/archive_checkpoint 至校验通过——误报成打转）
    //   normal = 普通子代理（用户/宿主 spawn，如 task-implement）：B/C/D 开（pre-step 直入不留痕），A 关（防诱导/防 ghost 轮）
    function hintKindOf(agent, sid) {
      if (isTopLevelSession(agent)) return 'top';
      return isPluginSubagent(sid) ? 'plugin' : 'normal';
    }

    // v1.10.1：#6 readText 双通道 —— 优先 ctx.fs（沙箱），失败时 node:fs 直读兜底（防沙箱限制 ~/.dsh 读导致 memory_search/注入静默失效）
    async function readText(path) {
      try {
        const target = await ctx.fs.resolve(path);
        return await ctx.fs.readText(target);
      } catch (e) {
        try {
          return fs.readFileSync(portable(path), "utf8");
        } catch (e2) {
          return null;
        }
      }
    }

    // v2.3.2(archive-tool)：结构化检查点交付（子代理通过 memory_archive_checkpoint 工具提交）——A5 完整性 + 条目级幂等 + 落盘
    function applyArchiveBlocks(blocks) {
      if (!LAST_ARCHIVE_FLOW) return { ok: false, mode: "no-batch", wrote: 0, errors: ["归档批次未初始化（插件侧问题）"] };
      if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, mode: "bad-schema", wrote: 0, errors: ["blocks 必须是数组且非空"] };
      const ids = LAST_ARCHIVE_FLOW.sessionIds;
      const todayStr2 = LAST_ARCHIVE_FLOW.todayStr;
      const declared = LAST_ARCHIVE_FLOW.declared;
      const errors = []; const norm = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]; const tag = "blocks[" + i + "]";
        if (!b || typeof b !== "object") { errors.push(tag + " 必须是对象"); continue; }
        if (typeof b.sessionId !== "string" || !b.sessionId.trim()) { errors.push(tag + ".sessionId 缺失（从短 id 清单逐字取用）"); continue; }
        declared.add(b.sessionId.trim());
        if (typeof b.file !== "string" || !b.file.trim()) { errors.push(tag + ".file 缺失"); continue; }
        // v0.5（step2 内容闸）：路径白名单 + 归档日期窗口统一（原 L3161-3173 手工实现被 assertMemoryWrite 取代，语义不变）
        const aw = assertMemoryWrite(b.file, "", { dateWindow: true, pathOpts: { scopes: ["sessions", "projects"], rootFiles: [] } });
        if (!aw.ok) { for (const ae of aw.errors) errors.push(tag + ".file " + ae); continue; }
        const rel = aw.rel;
        if (b.skip === true) { norm.push({ rel: rel, sid: b.sessionId.trim(), skip: true, reason: String(b.reason || "无价值跳过") }); continue; }
        if (!Array.isArray(b.points)) { errors.push(tag + " 非 skip 时必须提供 points 数组（3-6 条要点）"); continue; }
        // v2.4.28（D3）：points 条数机器校验 3-6 条下限（先滤空串再计数；原只拦空数组，1 条也放行）
        const _ptsF = b.points.map((p) => String(p)).filter((p) => p.trim());
        if (_ptsF.length < 3 || _ptsF.length > 6) { errors.push(tag + " 归档要点须 3-6 条（当前 " + _ptsF.length + " 条）——过少=信息不足、过多=需精简合并"); continue; }
        norm.push({ rel: rel, sid: b.sessionId.trim(), title: String(b.title || ""), points: _ptsF });
      }
      const missing = ids.filter((id) => !declared.has(id));
      if (missing.length) errors.push("未声明处置的会话（每个要么 skip=true 要么提交归档块）: " + missing.join(", "));
      // v2.4.12（P1）：points/title 结构校验——points 拼进 `- `+p 与 `### sid（title）` 块头，换行/结构行
      // 会破坏归档块结构（评审 P1-④）；违规整批拒写、错误清单回给归档子代理修正
      for (let ni = 0; ni < norm.length; ni++) {
        const nit = norm[ni];
        if (nit.skip) continue;
        const vs2 = validateMdStructure("", { pointsOnly: true, points: nit.points, title: nit.title });
        if (!vs2.ok) {
          for (const e of vs2.errors) errors.push("归档[" + nit.sid + "] " + e);
        }
      }
      if (errors.length) return { ok: false, mode: "bad-schema", wrote: 0, errors: errors };
      const applied = []; const skipped = [];
      for (const it of norm) {
        if (it.skip) { skipped.push(it.sid + "(跳过:" + it.reason + ")"); continue; }
        const fullPath = portable(MEMORY_ROOT + "/" + it.rel);
        let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
        // v2.4.3：轮次落盘——首轮沿用 v2.0.8 幂等；≥2 轮头「### sid ·补N」，幂等只拦同轮 ghost 重发，不拦下一轮
        const roundN = (LAST_ARCHIVE_FLOW.rounds && LAST_ARCHIVE_FLOW.rounds[it.sid]) || 1;
        if (roundN === 1) { if (existing.includes("### " + it.sid)) { skipped.push(it.sid + "(已在库)"); continue; } }
        else if (existing.includes("### " + it.sid + " ·补" + roundN + "（") || existing.includes("### " + it.sid + " ·补" + roundN + "\n")) { skipped.push(it.sid + "(本轮已记)"); continue; }
        const header = "### " + it.sid + (roundN > 1 ? " ·补" + roundN : "") + (it.title ? "（" + it.title + "）" : "");
        const block = "## 漏网会话补档（" + todayStr2 + " 归档）\n" + header + "\n" + it.points.map((p) => "- " + p).join("\n") + "\n";
        const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
        try {
          fs.mkdirSync(dir, { recursive: true });
          const newText = existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + block.trim() + "\n";
          writeFileAtomic(fullPath, newText, { tag: "archive", verify: true });   // v0.5（step2 内容闸 + N7 补回读）
          applied.push(it.sid + "→" + it.rel);
        } catch (e) {
          cwarn("[dsh-memory] 归档块写盘失败（跳过）: " + it.sid + " - " + (e && e.message ? e.message : String(e)));
          skipped.push(it.sid + "(写盘异常)");
        }
      }
      LAST_ARCHIVE_A5_OK = missing.length === 0;
      if (applied.length > 0) LAST_ARCHIVE_WROTE_AT = Date.now();
      return { ok: true, mode: "written", wrote: applied.length, applied: applied, skipped: skipped };
    }

    // ═══════════ v2.3.2(dream-patch)：dream 整合检查点落盘（子代理只产文本，插件写盘） ═══════════
    // 写入者永远是插件代码（node:fs、受控路径、单块容错）；子代理工具面 allow 白名单无任何写工具。
    // v2.3.2(dream-json): 检查点 JSON 化——子代理产出 {"patches":[...]} JSON，插件提取+校验+落盘
    // 校验失败返回精确错误清单（供反馈闭环让子代理修复）；JSON.parse 失败=明确失败，杜绝「半截当完整」
    function extractDreamJson(outText) {
      const s = String(outText || "");
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) return m[1];
      const m2 = s.match(/\[MEMORY_JSON\]([\s\S]*?)\[\/MEMORY_JSON\]/);
      if (m2) return m2[1];
      const t = s.trim();
      if (t.startsWith("{") || t.startsWith("[")) return t;
      return null;
    }

    // v2.3.2(dream-tool)：核心校验+落盘（输入已结构化的 patches 数组）——memory_dream_patch 工具与 applyDreamJson 共用
    const applyPatches = (patches) => {
      if (!Array.isArray(patches)) return { ok: false, mode: "bad-schema", wrote: 0, errors: ["patches 必须是数组"] };
      if (patches.length === 0) return { ok: true, mode: "empty", wrote: 0 };
      const errors = []; const seen = new Set(); const valid = [];
      for (let i = 0; i < patches.length; i++) {
        const p = patches[i];
        const tag = "patches[" + i + "]";
        if (!p || typeof p !== "object") { errors.push(tag + " 必须是对象"); continue; }
        if (typeof p.file !== "string" || !p.file.trim()) { errors.push(tag + ".file 缺失或非字符串"); continue; }
        // v0.5（step2 内容闸）：路径白名单统一（原 L3253-3256 手工实现被 assertMemoryWrite 取代，语义不变：sessions|projects|knowledge|tools/ 或 global.md|index.md）
        // v2.5.0：edit 无 content，传 new_string 作内容闸输入（空串=合法删除意图，不触发 resolveMemoryPath「file 为空」误判）
        const awp = assertMemoryWrite(p.file, p.action === "edit" ? (typeof p.new_string === "string" ? p.new_string : "") : (p.content || ""));
        if (!awp.ok) { for (const ae of awp.errors) errors.push(tag + ".file " + ae); continue; }
        const rel = awp.rel;
        // v2.4.20（P1-8）：knowledge/ 提取文件名 sanitize——非法字符/空白拒写（防落非法文件名），错误清单驱动子代理改名
        if (/^knowledge\//.test(rel)) {
          const _bn0 = rel.slice(rel.lastIndexOf("/") + 1);
          if (/[:*?"|<>]/.test(_bn0) || _bn0.includes(" ") || /^_/.test(_bn0)) { errors.push(tag + " knowledge 文件名含非法字符/空白/下划线前缀: " + _bn0); continue; }
        }
        // v2.5.0：action 扩四值 edit
        if (!["replace", "append", "delete", "edit"].includes(p.action)) { errors.push(tag + ".action 非法（replace|append|delete|edit）: " + String(p.action)); continue; }
        // v2.5.0：content 条件必填——edit 免 content，改校验 old_string/new_string；其余动作仍要求 content
        if (p.action === "edit") {
          if (typeof p.old_string !== "string" || !p.old_string.trim()) { errors.push(tag + " edit 缺 old_string（须从 read 全量逐字复制精确原文）"); continue; }
          if (typeof p.new_string !== "string") { errors.push(tag + " edit 缺 new_string（空串=删除该片段）"); continue; }
        } else if (typeof p.content !== "string" || !p.content.trim()) { errors.push(tag + ".content 缺失或空"); continue; }
        const _contentLen = p.action === "edit" ? (p.old_string.length + (p.new_string || "").length) : p.content.length;
        if (_contentLen > 128 * 1024) { errors.push(tag + " 内容超 128KB"); continue; }
        // v2.4.4（近3日 dump 保护，用户拍板）：今日/昨/前日的 sessions 日文件里 compaction dump 块不得删减——
        // 丢块当日的逐字抢救全靠原文还在文件里（08-30 上午 zip 抢救实证）；清理仅限 >3 天旧文件且须给去向指针。
        // 工具层当场拒绝→整批拒写→错误清单回给整合代理，它自然改成只修要点块（v2.3.2 反馈重试模式）
        const dmm = rel.match(/^sessions\/(\d{4}-\d{2}-\d{2})\.md$/);
        if (dmm && (p.action === "replace" || p.action === "delete")) {
          const _nw = Date.now();
          const _pd = [dateStr(new Date(_nw)), dateStr(new Date(_nw - 86400000)), dateStr(new Date(_nw - 2 * 86400000))];
          if (_pd.indexOf(dmm[1]) >= 0) {
            const _cnt = (s) => ((s || "").match(/<!--\s*compaction:/g) || []).length;
            let _old = ""; try { _old = fs.readFileSync(portable(MEMORY_ROOT + "/" + rel), "utf8"); } catch (e) { _old = ""; }
            if (p.action === "replace" && _cnt(_old) > _cnt(p.content)) {
              errors.push(tag + " 近3日dump保护：sessions/" + dmm[1] + ".md 的 compaction dump 块 " + _cnt(_old) + " → " + _cnt(p.content) + " 减少——原文不可删减，只可修剪要点块（dump 清理仅限超 3 天的文件）");
              continue;
            }
            if (p.action === "delete" && _cnt(p.content) > 0) {
              errors.push(tag + " 近3日dump保护：delete 内容含 " + _cnt(p.content) + " 个 compaction dump 块（sessions/" + dmm[1] + ".md 在保护窗口内）——请改为只删要点条目");
              continue;
            }
          }
        }
        // v2.4.12（P1，评审 P1-⑥）：dream content 结构扫描——append 是新内容（裸 marker/fence 全部拦截）；
        // replace 是全文件覆盖（可能含解析端回写的 compaction dump 原文，marker 行豁免、但 fence 必须闭合，
        // 未闭合围栏会让 strip 把围栏内 `# ──` 当 H1 → 重演 09-01 形态）。
        if (p.action === "append") {
          const vs3 = validateMdStructure(p.content, {});
          if (!vs3.ok) { for (const e of vs3.errors) errors.push(tag + " append 结构违规: " + e); continue; }
        } else if (p.action === "replace") {
          const vf = (() => { let f = null; for (const _l of String(p.content || "").split("\n")) f = fenceStep(_l, f)[0]; return f; })();
          if (vf !== null) { errors.push(tag + " replace 内容代码围栏未闭合（F=" + vf + "）——重写后会让解析端误判边界，需补全围栏"); continue; }
          if (/^projects\//.test(rel)) {
            const vsp = validateMdStructure(p.content, { projectMode: true });
            if (!vsp.ok) { for (const e of vsp.errors) errors.push(tag + " replace 项目结构违规: " + e); continue; }
          }
        }
        const key = rel + "|" + p.action;
        // v2.5.0（三审 B1）：seen 同批互斥对 edit 豁免（多 edit 共存是核心用例），replace/append/delete 维持原语义
        if (p.action !== "edit" && seen.has(key)) { errors.push(tag + " 与更早条目重复（同一文件同动作只允许一条）: " + rel + " " + p.action); continue; }
        if (p.action !== "edit") seen.add(key);
        valid.push({ rel: rel, action: p.action, content: p.action === "edit" ? undefined : p.content, old_string: p.action === "edit" ? p.old_string : undefined, new_string: p.action === "edit" ? p.new_string : undefined, full_rewrite: p.full_rewrite === true });   // v2.3.2-hotfix: 不污染入参（宿主冻结工具参数对象，挂 _rel 会抛 not extensible）
      }
      // v2.4.28（D1b）：写时预算校验——global/index/projects 超预算当场拒写并回传精确差数（对标 mimocode re-validate，
      // 治本：模型不再自量字符、不再等 settle 下轮才知道超限）。按「同 rel 全部 patch 依序合并模拟后的最终字符」判定
      // （同批 replace+append 合法，append 读 replace 后现文；用 simulateFinalText 与落盘同源，防朴素拼接口径差）。
      // 校验放落盘前，失败即整批拒（与近3日 dump 保护同模式），模型按错误清单差数当轮收敛；delete 不受预算限制。
      // D1c 取舍：拒写「连续 N 次放弃」上限未实现——v2.4.32 起由 P0-5 在 tools/result 侧按 spSid+file 计数预算类拒写，
      //   有界重试（≥2 次 MILD / ≥4 次 STRONG）接管此位（宿主 execute 第二参 exec 含 agent.session.id，v2.4.28 旧注释「execute 无 sid」作废）；
      //   改由 D1b 精确差数引导模型当轮收敛 + D4 15 分 watchdog 兜底防同轮无限裁切（方案 P1-1 已隐含此兜底）。
      if (errors.length === 0) {
        try {
          // v2.5.0（三审 B1）：单一折叠贯穿——byRel 覆盖**全部**含 patch 的 rel（含 sessions/ 与 edit/delete，不再只挑预算 rel），
          //   每个 rel 从原盘文起按 valid 数组序折叠一次，产物 sim.text 同时供：edit 唯一命中校验(error 上抛)、
          //   D1b 预算（带预算 rel）、dump(b) marker 守恒（sessions 保护窗）。校验折叠=预算折叠=dump(b)终文=同一产物。
          const byRel = new Map();   // rel -> { patches:[], budget, prevChars, prevText, sim }
          for (const v of valid) {
            const b = budgetOf(v.rel);
            if (!byRel.has(v.rel)) {
              let prev = ""; try { prev = fs.readFileSync(portable(MEMORY_ROOT + "/" + v.rel), "utf8"); } catch (e) { prev = ""; }
              byRel.set(v.rel, { patches: [], budget: b, prevChars: prev.length, prevText: prev, sim: null });
            }
            byRel.get(v.rel).patches.push(v);
          }
          for (const [rel, grp] of byRel) {
            // edit 唯一命中 + 全动作依序折叠（与落盘逐条读盘重演变换等价）
            const sim = simulateFinalText(rel, grp.prevText, grp.patches);
            if (sim.error) { errors.push(sim.error); continue; }
            grp.sim = sim;
            const F = sim.text.length;
            const b = grp.budget;
            // v2.5.0（§4A-b）：dump 双条件 (b)——保护窗口 sessions 日文件折叠终文 marker 数量守恒（拦 edit/replace 净删；delete 单条含 marker 已在 per-patch (a) 拒）
            const dmm2 = rel.match(/^sessions\/(\d{4}-\d{2}-\d{2})\.md$/);
            if (dmm2) {
              const _nw = Date.now();
              const _pd = [dateStr(new Date(_nw)), dateStr(new Date(_nw - 86400000)), dateStr(new Date(_nw - 2 * 86400000))];
              if (_pd.indexOf(dmm2[1]) >= 0) {
                const _cnt2 = (s) => ((s || "").match(/<!--\s*compaction:/g) || []).length;
                if (_cnt2(grp.prevText) > _cnt2(sim.text)) {
                  errors.push("patches 折叠终文违背近3日dump保护：sessions/" + dmm2[1] + ".md compaction 块 " + _cnt2(grp.prevText) + " → " + _cnt2(sim.text) + " 净减少（原文不可删减；edit/delete 仅可修剪要点块）");
                  continue;
                }
              }
            }
            // v2.5.0（§4）：replace 收缩熔断（双门槛：比例<0.6 且 绝对差≥300，相对原盘现文度量，预校验读原始 p.full_rewrite）
            //   检查时机：折叠后对每个 "replace" patch 依次判（对自身 content 相对该 rel 原盘文）——先 edit 缩水再 replace 的绕过在此拆解：
            //   熔断基准=原盘 prevText，任何净收缩必须落在某条 replace 的 content 上、相对原盘必被拦（三审 Q3 确认不可绕过）。
            const SHRINK_FLOOR = 0.6, SHRINK_ABS = 300;
            for (const v2 of grp.patches) {
              if (v2.action !== "replace") continue;
              if (grp.prevText.length > 0 && v2.content.length < grp.prevText.length * SHRINK_FLOOR && (grp.prevText.length - v2.content.length) >= SHRINK_ABS) {
                if (v2.full_rewrite !== true) {
                  errors.push("patches " + rel + " replace 将把文件从 " + grp.prevText.length + " 字符覆盖为 " + v2.content.length + "（−" + Math.round((1 - v2.content.length / grp.prevText.length) * 100) + "%、" + (grp.prevText.length - v2.content.length) + " 字），疑似漏内容。确系重写请带 full_rewrite:true；只想改局部请改用 action:\"edit\"");
                  break;
                }
              }
            }
            if (errors.length) continue;   // 收缩熔断已 fail → 不再算预算（错误优先展示）
            // D1b 预算（仅带预算 rel；knowledge/tools/sessions 无预算跳过）
            if (b) {
              if (b.extract) {
                const T = extractTargetFor(rel, grp.prevChars);
                if (F > T) {
                  const secTab = charSectionBreakdown(sim.text, { maxRows: 8 }).map((s) => s.title + " " + s.chars + " 字符").join("、");
                  errors.push("patches 该文件合并模拟后仍 " + F + " 字符，超目标 " + T + "（提取前 " + grp.prevChars + "×0.8）——建议再提取 ≥ " + (F - T) + " 字符；提取后主文件删节并插 '- See knowledge/<文件>（N 项）' 指针行；分节字符: " + secTab);
                }
              } else if (F > b.chars) {
                const secTab = charSectionBreakdown(sim.text, { maxRows: 8 }).map((s) => s.title + " " + s.chars + " 字符").join("、");
                errors.push("patches " + rel + " 写入后仍 " + F + " 字符，超预算 " + b.chars + "（当前超 " + (F - b.chars) + "）——按差数做整节下沉：按任务书 EXTRACTION 提取要求的选择标准挑低价值节（有 ## 归档 族则优先），整节提取到 knowledge/MEMORY-" + (rel === "index.md" ? "index" : "global") + "-<topic>.md，主文件删该节 + 尾部插 '- See knowledge/<文件>（N 项）— 一句话摘要'，一次成型提交；禁止逐条微调压缩字面量；delete 未命中会显示在 skipped 而非 errors；分节字符: " + secTab);
              }
            }
          }
        } catch (eB) { cwarn("[dsh-memory] D1b 预算校验异常（跳过预算闸，落盘继续）: " + (eB && eB.message ? eB.message : String(eB))); }
      }
      if (errors.length) return { ok: false, mode: "bad-schema", wrote: 0, errors: errors };
      const applied = []; const skipped = [];
      for (const it of valid) {
        const fullPath = portable(MEMORY_ROOT + "/" + it.rel);
        try {
          if (it.action === "replace") {
            const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
            fs.mkdirSync(dir, { recursive: true });
            const wr = writeFileAtomic(fullPath, it.content, { tag: "dream", verify: true });   // v0.5（step2 内容闸）：统一原子写+回读
            if (wr && wr.readbackOk === false) { skipped.push(it.rel + "(回读不一致)"); continue; }
            applied.push(it.rel + "(replace " + it.content.length + ")");
            // v2.4.15(lesson-settle-hard): 真实落盘成功→累积证据缓冲（replace=全文）
            try { if (DREAM_ROUND_WROTE) DREAM_ROUND_WROTE.push({ rel: it.rel, content: it.content }); } catch (e) {}
            try { if (DREAM_WRITTEN_RELS) DREAM_WRITTEN_RELS.add(it.rel); } catch (e) {}   // v2.4.20：文件级 writtenRels
          } else if (it.action === "append") {
            let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
            const payload = it.content.trim();
            if (existing.includes(payload)) { skipped.push(it.rel + "(append内容已存在)"); continue; }
            let outAppend;
            if (/^projects\//.test(it.rel) && !/^##\s/.test(payload)) {
              // v2.4.17（P0-2）：projects/ append 无节头 → 锚点插入「## 归档」节（缺则补建置文件尾），防 ### 挂进自定义节
              const _ai = existing.lastIndexOf("## 归档");
              if (_ai >= 0) {
                const _nh = existing.indexOf("\n## ", _ai + 1);
                const _cut = _nh > 0 ? _nh : existing.length;
                outAppend = existing.slice(0, _cut).replace(/\s+$/, "") + "\n" + payload + "\n" + existing.slice(_cut);
              } else {
                outAppend = existing.replace(/\s+$/, "") + (existing.trim() ? "\n\n## 归档\n\n" : "## 归档\n\n") + payload + "\n";
              }
            } else {
              outAppend = existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + payload + "\n";
            }
            writeFileAtomic(fullPath, outAppend, { tag: "dream", verify: true });   // v0.5（step2 内容闸）：统一原子写+回读
            applied.push(it.rel + "(append)");
            // v2.4.15(lesson-settle-hard): 真实落盘成功→累积证据缓冲（append=payload）
            try { if (DREAM_ROUND_WROTE) DREAM_ROUND_WROTE.push({ rel: it.rel, content: payload }); } catch (e) {}
            try { if (DREAM_WRITTEN_RELS) DREAM_WRITTEN_RELS.add(it.rel); } catch (e) {}   // v2.4.20：文件级 writtenRels
          } else if (it.action === "edit") {
            // v2.5.0：局部编辑落盘——唯一命中已在折叠阶段保证；此处 TOCTOU/围栏/证据缓冲兜底
            let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { skipped.push(it.rel + "(edit文件不存在)"); continue; }
            const idx = existing.indexOf(it.old_string);
            if (idx < 0) { skipped.push(it.rel + "(edit落盘时未命中·TOCTOU兜底)"); continue; }
            const out = existing.slice(0, idx) + it.new_string + existing.slice(idx + it.old_string.length);
            let _f = null; for (const _l of out.split("\n")) _f = fenceStep(_l, _f)[0];
            if (_f !== null) { skipped.push(it.rel + "(edit结果围栏未闭合)"); continue; }
            writeFileAtomic(fullPath, out, { tag: "dream", verify: true });   // v0.5（step2 内容闸）：统一原子写+回读
            applied.push(it.rel + "(edit " + it.old_string.length + "→" + it.new_string.length + ")");
            // v2.5.0：证据缓冲存 new_string（对齐 append payload 语义；存全量会让 lesson 归一化匹配只看文件头，改动区 lesson 永 refeed）
            try { if (DREAM_ROUND_WROTE) DREAM_ROUND_WROTE.push({ rel: it.rel, content: it.new_string }); } catch (e) {}
            try { if (DREAM_WRITTEN_RELS) DREAM_WRITTEN_RELS.add(it.rel); } catch (e) {}   // v2.4.20：文件级 writtenRels
          } else if (it.action === "delete") {
            let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
            const idx = existing.indexOf(it.content);
            if (idx < 0) { skipped.push(it.rel + "(delete未找到)"); continue; }
            writeFileAtomic(fullPath, existing.slice(0, idx) + existing.slice(idx + it.content.length).replace(/^\n+/, ""), { tag: "dream", verify: true });   // v0.5（step2 内容闸）：统一原子写+回读
            applied.push(it.rel + "(delete)");
            try { if (DREAM_WRITTEN_RELS) DREAM_WRITTEN_RELS.add(it.rel); } catch (e) {}   // v2.4.20：文件级 writtenRels
          }
        } catch (e) {
          cwarn("[dsh-memory] DREAM patch 落盘失败（跳过）: " + (e && e.message ? e.message : String(e)));
          skipped.push(it.rel + "(异常)");
        }
      }
      try { refreshMemorySessionsIndex(); } catch (eR) {}   // v0.5（step2 内容闸）：dream 落盘后补刷新索引（N7 遗漏修复，其余 4 入口均有）
      return { ok: true, mode: "written", wrote: applied.length, applied: applied, skipped: skipped };
    };

    // 文本形态包装（兼容单测/非工具路径）：从会话文本提取 JSON 后走 applyPatches
    function applyDreamJson(outText) {
      const raw = extractDreamJson(outText);
      if (raw === null) return { ok: false, mode: "no-json", wrote: 0, errors: ["未找到 JSON 检查点"] };
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return { ok: false, mode: "bad-json", wrote: 0, errors: ["JSON 解析失败: " + (e && e.message ? e.message : String(e))] }; }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, mode: "bad-schema", wrote: 0, errors: ["顶层必须是对象 { patches: [...] }"] };
      if (!Array.isArray(obj.patches)) return { ok: false, mode: "bad-schema", wrote: 0, errors: ["缺少 patches 数组字段"] };
      return applyPatches(obj.patches);
    }

    // v2.3.4(dream-hash): 候选由模块级 hashListIntegrateCandidates 提供（见 export default 前定义）。
    // 读什么由代码决定，不靠模型自觉；读取成本与 sessions/ 历史长度完全无关（已 dream 且未变更的文件永不重读）。


    // ═══════════ v2.0.7+ 漏网归档：检查点落盘语义（runStaleArchive 重植，2026-08-27 修复丢失的整函数块） ═══════════
    // 骨架源自 v2.0.6（git dbc571e）；按 v2.0.7/v2.0.8/v2.1.0/v2.1.1/v2.1.4 适配：
    //  - 子代理只产出 [ARCHIVE_BEGIN]…[ARCHIVE_END] 检查点（FILE: 行 + 正文），插件 applyArchiveCheckpoints 解析落盘（v2.0.7）
    //  - toolFilter 去掉 write/edit（v2.1.0 E1 物理收紧——检查点模式下无需，防子代理写 ~/.dsh 被沙箱拒）
    //  - 落盘 ok 才消号，失配/越界不消号留待下轮（v2.0.7 防静默丢失）
    //  - A5 短 id 清单注入（v2.1.1）——任务书逐字取用，禁止子代理自行截取完整 uuid 致判重失配死循环
    //  - 节流无条件 60 分（v2.1.4）——发起即重置、窗内一律拒绝；spawn 失败不重置可立即重试
    const MAX_ARCHIVE_SESSIONS = 32;   // v1.12.19.1: 10→32——v1.12.18 起提取器已逐帧让出+行级快筛+段压缩，冻结风险消除；漏网量一次轮完
    const COMPACT_INSTRUCTION =
      "你是会话压缩器。对以下会话片段执行一次仿真压缩，输出高密度 Markdown 摘要，固定结构：\n" +
      "## 任务与意图\n## 关键决策\n## 错误与修复（报错串/参数逐字保留）\n## 工具与产物（文件/命令/接口）\n## 未决事项\n## 其他长期有价值的事实\n" +
      "纪律：要点化；精确字面量（文号/路径/数字/命令/报错串/数值）逐字保留绝不概括改写；总长不超过 1500 字符；不要复述原文、不要任何额外解释或开场白。";

    // v1.12.18.3: 单次压缩调用（spawn 压缩子代理，返回其摘要文本）
    // v2.4.5：失败时不再只回 null——把宿主 result.stopReason（aborted/error/max-tokens/refusal）
    //   挂到返回值的 __maintFail 上，供维护合并重试机制分类退避（catch 路径无 stopReason，记 "throw"）。
    // v0.5.1（2026-09-03 用户拍板）：压缩子代理 watchdog——所有记忆压缩子代理统一硬超时，
    // 防 LLM 空转/试错循环无限烧 token（实证：2026-09-03 14:52 maint 子代理 code-run 空转 ~15 分钟烧 2M token）。
    //   SOFT_MS = 10 分钟：到点仍未完成 → clog 提醒 + monitorEvent（观察信号，不中断）
    //   HARD_MS = 15 分钟：到点仍未完成 → ctrl.abort() 硬停 → stopReason=aborted → 抛 __maintFail
    //            → runMaintenanceMerge catch 自动 maintRetryRecordFail("aborted") 进退避/熔断（方便下次重试，零新增状态）
    // 正常 settle 清定时器；「是否调落盘工具」在压缩子代理语义下恒为否（toolFilter 仅 memory_search，
    // 落盘由插件做），故「有产出」= 在硬超时前返回文本——watchdog 即等价于你的 15 分钟未落盘即停。
    const SUBAGENT_SOFT_MS = 10 * 60e3;
    const SUBAGENT_HARD_MS = 15 * 60e3;
    // v2.6.1（V0.2 P1-1）：dream 看护专用时限——与 compactOnce 共享的 SUBAGENT_* 隔离：
    // 改全局会同步拉长 maint/intent 压缩轮（10/15→15/25），削弱 09-03「压缩子代理空转 15 分钟烧 2M token」防烧。
    // dream 放宽（soft15/hard25，对齐 ARCHIVE_HARD_MS）：长推理单轮生成期间无 tools/result 可续期，15 分钟会误杀
    // 「读→想→一次性大 patch」合法模式（实证 2026-09-11：子代理停在 in one call: 冒号前被杀）。archive 保持 10/25。
    const GUARD_SOFT_MS = 15 * 60e3;
    const GUARD_HARD_MS = 25 * 60e3;
    // v2.6.1（V0.2 P0-1）：硬停前宽限 3 分钟（仿预算打转 STRONG 契约）——宽限期内仅真实落盘可解除，活动续期不得触碰。
    const GUARD_GRACE_MS = 3 * 60e3;
    // v2.6.1（V0.2 P0-2）：无落盘窗口内「所有非落盘工具活动」上限——防换壳空转（read/grep/glob/memory_search 循环等效
    // 09-07 的 244 次 preview 空转，活动也计预算）；preview 另由 PREVIEW_GATE 每会话 8 次/10min 闸独立兜底。
    const GUARD_ACTIVITY_BUDGET = 24;
    // v2.4.31：slim 精简轮独立短超时——任务仅「精简上一版」（输入是上一版输出，工作量≈主轮一半），
    // hard 15→8 分 / soft 10→4 分；配合无进展即停，单轮 slim 烧 token 上限腰斩（实证 09-07 16:51 打转 15 分才 abort）
    const MAINT_SLIM_TIMING = { softMs: 4 * 60e3, hardMs: 8 * 60e3 };
    const ARCHIVE_HARD_MS = 25 * 60e3;   // v2.4.28（D4 方案 B）：archive 硬停放宽到 25 分（对齐既有 Promise.race([r.done,25min])，正常批 15-25 分历史形态不误杀）
    // v2.4.28（D4）：归档/dream 子代理看护注册表（键=spSid，与 tools/result 钩子 exec.agent.session.id 同空间）。
    // 压缩子代理（intent/maint/slim）不走此表——compactOnce 已有 soft/hard watchdog 且无落盘工具（产出即完成）。
    // v2.6.1（V0.2）语义升级（审核 P0-1/P0-2）：
    //   - 计时口径「自最近一次成功落盘 / 任意工具活动」双轨：活动续期（guardTouch wrote=0）重设全额时限；
    //     真实落盘（wrote>0）除重设外还重置活动预算 actN 并解除宽限。
    //   - 宽限态（graced）：guardGrace 置 graced=true + graceT=3min；宽限期内活动续期不得触碰 hardT/graceT，
    //     仅真实落盘可解除（否则 STRONG「3 分钟内无 patch 将硬停」被一次 read 顶掉，看护整体失效）。
    //   - 硬停两段式：首触（正常态 hardT 到点或活动预算达标）→ 注入提醒 + 3min 宽限；graceT 到点才真正 abort。
    //   - 活动预算：无落盘窗口内所有非落盘工具活动 ≥GUARD_ACTIVITY_BUDGET → 宽限（防换壳空转）。
    //   - 后代 sid 边角：maxDepth:2 下子代理 result 的 sid 是子会话 id 而非 run.id，续不到父级 guard（现有设计，
    //     写入全走 memory_dream_patch 均发生在主 run，边角可接受；此处留痕）。
    // 非插件 sid 无 guard 命中 → guardTouch/guardRenew 为 no-op，无越权面。
    const SUBAGENT_GUARDS = new Map();   // spSid -> { ctrl, sid, hardMs, softMs, hardT, softT, graceT, aborted, kind, graced, actN }
    function guardRegister(spSid, kind, ctrl, hardMs, softMs) {
      try {
        if (!spSid || !ctrl) return null;
        const g = { sid: spSid, ctrl: ctrl, hardMs: hardMs || SUBAGENT_HARD_MS, softMs: softMs || SUBAGENT_SOFT_MS, hardT: null, softT: null, graceT: null, aborted: false, kind: kind, graced: false, actN: 0 };
        const arm = () => {
          try { if (g.hardT) clearTimeout(g.hardT); if (g.softT) clearTimeout(g.softT); } catch (eC) {}
          g.softT = setTimeout(() => {
            try {
              clog("[dsh-memory] " + kind + " 子代理自最近落盘/活动超 " + Math.round(g.softMs / 60e3) + " 分钟无产出，继续观察至硬停");
              monitorEvent("guard", "soft " + kind + " " + String(spSid).slice(0, 8));
              // v2.6.1（V0.2 P2）：软警告主动注入（pre-step PL: 通道）——子代理须知道自己在被计数
              //（本次事件正因软警告只进日志：子代理停在 in one call: 冒号前，浑然不知 15 分钟大限）。
              try { enqueueRegressionReminder(spSid, "PL:guard-soft", "<system-reminder>\n【dsh-memory 提示·看护软警告】距上次成功落盘/活动已超 " + Math.round(g.softMs / 60e3) + " 分钟。看护将在 " + Math.round(g.hardMs / 60e3) + " 分钟硬停（先 3 分钟宽限）。若下一步就是 memory_dream_patch 请立即提交；可先落一条最小 patch 续期。\n</system-reminder>"); } catch (eQ) {}
            } catch (eS) {}
          }, g.softMs);
          g.hardT = setTimeout(() => { guardHardFire(g); }, g.hardMs);
        };
        g.arm = arm;
        arm();
        SUBAGENT_GUARDS.set(spSid, g);
        return g;
      } catch (e) { return null; }
    }
    // v2.6.1（V0.2）：硬停两段式——hardT 首触先注入提醒 + 3 分钟宽限，graceT 到点才真正 abort。
    function guardHardFire(g) {
      try {
        if (!g || g.aborted) return;
        if (!g.graced) {
          guardGrace(g.sid, "hardT");
          try { enqueueRegressionReminder(g.sid, "PL:guard-hard", "<system-reminder>\n【dsh-memory 提示·看护硬停宽限】距上次成功落盘/活动已超 " + Math.round(g.hardMs / 60e3) + " 分钟。3 分钟内无 memory_dream_patch 成功落盘将硬停。立即提交任何可落盘的最小 patch 续期。\n</system-reminder>"); } catch (eQ) {}
          return;
        }
        guardHardAbort(g);
      } catch (eH) {}
    }
    // v2.6.1（V0.2）：进入宽限态——置 graced + graceT（3 分钟）；清 hardT/softT（宽限计时唯一由 graceT 承担，
    // 活动续期走 guardRenew(write=false) 在 graced 下 no-op，不会顶掉宽限——P0-1 核心）。
    function guardGrace(spSid, logKind) {
      try {
        const g = SUBAGENT_GUARDS.get(spSid);
        if (!g || g.aborted || g.graced) return;
        g.graced = true;
        try { if (g.hardT) clearTimeout(g.hardT); if (g.softT) clearTimeout(g.softT); if (g.graceT) clearTimeout(g.graceT); } catch (eC) {}
        g.graceT = setTimeout(() => { guardHardAbort(g); }, GUARD_GRACE_MS);
        try { clog("[dsh-memory] " + g.kind + " 子代理进入 3 分钟宽限（" + logKind + "）——落盘可解除"); monitorEvent("guard", "grace-" + logKind + " " + g.kind + " " + String(g._runId || spSid).slice(0, 8)); } catch (eG2) {}
      } catch (e) {}
    }
    function guardHardAbort(g) {
      try {
        if (!g || g.aborted) return;
        g.aborted = true;
        try { if (g.hardT) clearTimeout(g.hardT); if (g.softT) clearTimeout(g.softT); if (g.graceT) clearTimeout(g.graceT); } catch (eC) {}
        clog("[dsh-memory] " + g.kind + " 子代理硬停（abort）");
        monitorEvent("guard", "abort " + g.kind + " " + String(g._runId || g.sid).slice(0, 8));
      } catch (eH) {}
      try { g.ctrl.abort(); } catch (eA) {}
    }
    // v2.6.1（V0.2）：双语义续期——write=true（真实落盘 wrote>0）：解除宽限 + 重置活动预算 + 重设全额时限；
    // write=false（任意工具活动）：仅正常态重设全额时限，宽限态 no-op（不触碰 graceT——P0-1）。
    function guardRenew(spSid, write) {
      try {
        const g = SUBAGENT_GUARDS.get(spSid);
        if (!g || g.aborted || typeof g.arm !== "function") return !!g;
        if (write) {
          g.graced = false; g.actN = 0;
          try { if (g.graceT) clearTimeout(g.graceT); } catch (eC) {}
          g.graceT = null;
          g.arm();
        } else if (!g.graced) {
          g.arm();
        }
        return true;
      } catch (e) { return false; }
    }
    // v2.6.1（V0.2 P0-2）：看护唯一触达入口——所有工具 result 经此计数活动并续期；交付工具 wrote>0 走落盘续期。
    // 活动预算（actN）只在真实落盘时清零；到点注入 PL:guard-budget 提醒并进宽限（防换壳空转）。
    function guardTouch(spSid, wroteN) {
      try {
        const g = SUBAGENT_GUARDS.get(spSid);
        if (!g || g.aborted) return;
        if (wroteN > 0) { guardRenew(spSid, true); return; }
        if (g.graced) return;   // 宽限期内活动不续期不计数（只有落盘能解除，见 guardRenew）
        g.actN = (g.actN || 0) + 1;
        guardRenew(spSid, false);
        if (g.actN >= GUARD_ACTIVITY_BUDGET) {
          guardGrace(spSid, "budget");
          try { enqueueRegressionReminder(spSid, "PL:guard-budget", "<system-reminder>\n【dsh-memory 提示·无落盘活动超限】无落盘窗口内工具活动 " + g.actN + " 次（上限 " + GUARD_ACTIVITY_BUDGET + "）——纯读/预览循环等同空转。3 分钟内无 memory_dream_patch 成功落盘将硬停；立即提交最小 patch 或终止。\n</system-reminder>"); } catch (eQ) {}
        }
      } catch (e) {}
    }
    function guardClear(spSid) {
      try { const g = SUBAGENT_GUARDS.get(spSid); if (g) { try { if (g.hardT) clearTimeout(g.hardT); if (g.softT) clearTimeout(g.softT); if (g.graceT) clearTimeout(g.graceT); } catch (eC) {} SUBAGENT_GUARDS.delete(spSid); } } catch (e) {}
      try { clearRegressionQueue(spSid); } catch (eQ) {}   // v2.6.1（V0.2 P2）：清提醒队列（原 clearRegressionQueue 死代码未调用；abort/失败轮入队提醒滞留死 sid）
    }
    // v2.4.31：compactOnce 支持 per-call 超时覆盖（timingOverride={softMs,hardMs}，仅 slim 轮用更短预算；缺省=全局常量）
    async function compactOnce(subagents, parent, promptText, tag, timingOverride) {
      let _ctrl = null, _softT = null, _hardT = null;
      const _clearT = () => { try { if (_softT) clearTimeout(_softT); if (_hardT) clearTimeout(_hardT); } catch (eC) {} };
      try {
        _ctrl = new AbortController();
        const opts = {
          label: "dsh-memory-压缩-" + tag,
          prompt: [{ type: "text", text: promptText }],
          signal: _ctrl.signal,
          toolFilter: { allow: ["memory_search"] }
        };
        if (parent) opts.parent = parent;
        const _softMs = (timingOverride && timingOverride.softMs) || SUBAGENT_SOFT_MS;   // v2.4.31：per-call 超时覆盖
        const _hardMs = (timingOverride && timingOverride.hardMs) || SUBAGENT_HARD_MS;
        _softT = setTimeout(() => {
          try {
            clog("[dsh-memory] 压缩子代理(" + tag + ") 运行超 " + Math.round(_softMs / 60e3) + " 分钟未完成，继续观察至 " + Math.round(_hardMs / 60e3) + " 分钟硬停");
            monitorEvent("maint", "subagent-slow " + tag);
          } catch (eS) {}
        }, _softMs);
        _hardT = setTimeout(() => {
          try {
            clog("[dsh-memory] 压缩子代理(" + tag + ") 运行超 " + Math.round(_hardMs / 60e3) + " 分钟硬停（abort）——防空转烧 token");
            monitorEvent("maint", "subagent-abort " + tag + " soft=" + Math.round(_softMs / 60e3) + "m");
          } catch (eH) {}
          try { _ctrl.abort(); } catch (eA) {}
        }, _hardMs);
        const run = await subagents.start("spawn", opts);
        markPluginSubagent(run.id);   // v2.4.27：登记插件子代理 sid（A/B/C/D 提醒隔离全关，只计 monitor）
        const result = await run.result;
        _clearT();
        const _outTxtFull = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n").trim();   // v2.5.2（P2-1）：先整体再截断，deep-overlimit 腰斩不再静默
        if (_outTxtFull.length > 4000) { try { monitorEvent("maint", "hard-cut-4000 " + tag + " full=" + _outTxtFull.length); } catch (eHc) {} }
        const txt = _outTxtFull.slice(0, 4000) || null;
        if (!txt && result && result.stopReason && result.stopReason !== "completed") {
          const e2 = new Error("subagent stopped: " + result.stopReason);
          e2.__maintFail = result.stopReason;
          throw e2;
        }
        return txt;
      } catch (e) {
        _clearT();
        cwarn("[dsh-memory] 压缩子代理失败(" + tag + "):", e && e.message ? e.message : String(e));
        if (e && e.__maintFail) throw e;   // v2.4.5：维护合并专用标记错误透传给 runMaintenanceMerge 登记退避（intent 路径不受影响）
        return null;
      }
    }

    // v2.3.5: 分节水位截断（对标 mimocode readBudgetedSectionAware + truncateVerbatimUserMsg）——宿主摘要按 ## 分节，
    // 纯字符窗口（哪怕头+尾）在 14k 真实样本上仍整节丢 Current Work/Next Step。改为：每节按优先级权重水位分配预算
    // （next/current/error/pending=3，intent/context/decision=2，其余=1），节内头 62%+尾 38% 取文、超长单行切断；
    // 截断标记内嵌归档指针（pointer 传入），记录器可用 memory_search 自补全。预算=上限语义，行界对齐允许留白。
    function smartTrim(txt, budget, pointer) {
      const s = String(txt || "").trim();
      if (s.length <= budget) return s;
      const mTail = pointer ? "；全文归档 " + pointer : "";
      const lines = s.split("\n");
      const bounds = [0];
      lines.forEach((ln, i) => { if (i > 0 && /^##\s/.test(ln)) bounds.push(i); });
      bounds.push(lines.length);
      const secs = [];
      for (let bi = 0; bi + 1 < bounds.length; bi++) {
        const body = lines.slice(bounds[bi], bounds[bi + 1]);
        secs.push({ name: body[0] || "", body, len: body.join("\n").length });
      }
      const n = secs.length;
      const prio0 = /^##\s.*(next|current|work|error|fix|pending|block)/i;
      const prio1 = /^##\s.*(intent|request|goal|context|decision|resource)/i;
      const wgt = secs.map((sc) => prio0.test(sc.name) ? 3 : prio1.test(sc.name) ? 2 : 1);
      const work = Math.max(budget - (n * 90 + 40), n * 80);
      const take = new Array(n).fill(0);
      let rem = work;
      let active = secs.map((_, i) => i);
      for (let pass = 0; pass < 8 && active.length && rem > 0; pass++) {
        const W = active.reduce((a, i) => a + wgt[i], 0);
        const share = rem / W;
        const next = [];
        for (const i of active) {
          const want = Math.floor(Math.min(share * wgt[i], secs[i].len - take[i]));
          if (want > 0) { take[i] += want; rem -= want; }
          if (take[i] < secs[i].len) next.push(i);
        }
        active = next;
      }
      for (const i of active) { if (rem <= 0) break; if (take[i] < secs[i].len) { take[i]++; rem--; } }
      function gather(bodyArr, cap, fromEnd) {
        const kept = []; let acc = 0;
        const arr = fromEnd ? bodyArr.slice().reverse() : bodyArr;
        for (const ln of arr) {
          const room = cap - acc;
          if (room <= 0) break;
          if (ln.length + 1 <= room) { kept.push(ln); acc += ln.length + 1; continue; }
          if (!kept.length || room > 60) { kept.push(ln.slice(0, Math.max(40, room))); acc = cap; break; }
          break;
        }
        return fromEnd ? kept.reverse() : kept;
      }
      const out = [];
      for (let i = 0; i < n; i++) {
        const sc = secs[i];
        if (take[i] >= sc.len) { out.push(sc.body.join("\n")); continue; }
        if (take[i] >= 180) {
          const hCap = Math.floor(take[i] * 0.62);
          const h = gather(sc.body, hCap, false);
          const t = gather(sc.body, take[i] - hCap, true);
          out.push(h.join("\n") + "\n…[本节中省略 " + (sc.len - take[i]) + " 字" + mTail + "]…\n" + t.join("\n"));
        } else {
          out.push(gather(sc.body, take[i], false).join("\n") + "\n（本节截断" + mTail + "）");
        }
      }
      let res = out.join("\n").replace(/\n{3,}/g, "\n\n");
      if (res.length > budget) res = res.slice(0, budget - 12) + "…[预算截断]";
      return res;
    }

    // ═══════════ v2.3.3(意图检查点)：压缩时提炼「本次目标/下一步行动」两节，prepend 到 sessions/今日.md 头部 ═══════════
    // 对标 mimocode checkpoint-writer §1 Active intent / §2 Next action：
    //   - 触发：宿主 compaction/summary 事件（上下文压缩时刻，与 mimocode token 阈值同语义）
    //   - 写入：spawn 轻量子代理（工具仅 memory_search），输入=宿主压缩摘要，输出固定三节结构
    //   - 位置：prepend 到文件头部的独立小节（注入端 latest.text.slice(0,1500) 从头截断，保证下会话可见）
    //   - 幂等：marker `<!-- intent: <compactionId> -->`；防重入：INTENT_RUNNING 同步占位
    const INTENT_INSTRUCTION =
      "你是会话检查点记录器。基于以下「宿主压缩摘要」，提炼本次会话的续接状态，输出固定结构 Markdown（只输出下列三节，不要任何额外解释或开场白）：\n" +
      "## 本次目标\n（用户最近一次明确请求或会话主线目标；尽量原文引用 verbatim，无则写「未明确」）\n" +
      "## 下一步行动\n（续接时应该做的下一件具体事；含未决事项或衔接点；无则写「无明确下一步」）\n" +
      "## 关键结论\n（3-6 条本次最有长期价值的要点：决策/踩坑/产物路径/命令/报错串/数值，精确字面量逐字保留绝不概括改写）\n" +
      "纪律（分节预算，严格）：本次目标≤120字；下一步行动≤200字；关键结论≤4条、每条≤140字。输出长度由插件机器测量并现场裁剪/重试（v2.4.28），无需自行数数字符。\n" +
      "超限处置：从「关键结论」尾部删整条——宁缺毋断，字面量禁止截半句，前两节永不删。不确定就写「未明确」，不编造。\n" +
      "结构纪律（v2.4.12）：正文禁止输出任何 `<!--` 注释行/HTML 注释（含 `<!-- compaction:`、`<!-- intent:` 字样）；如需示例代码请用成对 ``` 围栏包住且必须闭合。\n" +
      "补全通道：摘要通常已全文直喂（≤20000 字原样入上下文）；仅超长时出现「本节截断/本节中省略」标记——见标记且需精确字面量时，先 memory_search 查当日要点区（sessions/日期.md 头部）；原始摘要逐字在会话日志 compaction/summary 事件（~/.dsh/sessions/<工作目录>/<会话id>/session.jsonl.zstd）可查。再定稿。\n\n===== 宿主压缩摘要 =====\n";
    let INTENT_RUNNING = false;
    // v2.4.3：当日 md 合并维护阈值——口径=stripCompactionDumps + 剥 intent 块后 ≥1500 触发（B 方案，用户 08-30 拍板）。
    // 1500 与注入端硬预算 CHAR_LIMIT.summary 同源：真实要点面装满注入窗口才压缩；阈值即节流不变（无时间冷却），
    // 余量 1500−合并上限1100≈400 字 ≈1-2 条收尾摘要才触发一次；compact 必写的 intent 块已剥出计数，不再乒乓复触发。
    // v0.5（step5）：维护触发阈值——settings 默认(maintTriggerChars) + monitor.maintThresh 覆盖层（/dream 经 dsh_maint_thresh 写）
    function maintTriggerChars() {
      try {
        const md = readMonitorData();
        const ov = md && md.maintThresh && md.maintThresh.triggerChars;
        if (typeof ov === "number" && ov >= 600 && ov <= 1500) return ov;
      } catch (e) {}
      return PLUGIN_CFG.maintTriggerChars || 1100;
    }
    let MAINT_RUNNING = false;   // 合并维护忙锁（对标 INTENT_RUNNING，防并发双跑）
    // v2.4.2：计算当日 md 的注入面字符数（stripCompactionDumps 后）
    // v2.4.3（B 方案）：再剥 intent 块——intent 是 compact 中转产物（必被下次合并吸收），不得作为触发燃料
    function injectedCharsOf(text) {
      const stripped = stripIntentBlocksForCount(stripCompactionDumps(text || ""));
      return stripped.trim().length;   // 真实注入面=strip 后全文字符（v2.4.2.1 修复：原实现误算前导空白数恒≈0，合并维护从未触发）
    }
    // v2.4.3：计数专用 intent 块剥离——边界比 stripOldIntentBlocks 严格（后者块定义吞并「## 当日要点」等正文标题，不可复用）：
    // 自 <!-- intent: 行起，遇 任意注释 marker / H1 / 白名单外中文 H2 结束（白名单=intent 自身节标题 检查点（/本次目标/下一步行动/关键结论）
    function stripIntentBlocksForCount(text) {
      const HEAD = /^<!-- intent: /;
      const lines = String(text || "").split("\n");
      const out = [];
      let inIntent = false;
      for (const ln of lines) {
        if (HEAD.test(ln)) { inIntent = true; continue; }
        if (inIntent) {
          const isCnH2 = /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln);
          if (/^\s*<!-- /.test(ln) || /^#\s/.test(ln) || (isCnH2 && !OWN_SECTIONS.test(ln))) {
            inIntent = false;
            out.push(ln);
          }
          continue;
        }
        out.push(ln);
      }
      return out.join("\n");
    }
    // v2.4.2：检查当日文件是否达到维护阈值；existed 为 false=文件不存在（不触发）
    // v2.4.4（B）：intent 撑爆注入预算时的兜底触发——intent 检查点是 compact 中转产物（v2.3.8 至多保 3 块共存，
    //   是特性不是病），但若剥 intent 后真实要点面 <1500（旧条件永不触发）而含 intent 的注入面 ≥1500
    //   （注入确实被 intent 撑到截断，实证 2026-08-31：真实 646 / 含 intent 3526），就触发一次合并把 3 块吸收
    //   进「当日要点」。合并后 intent 清零、注入面回落 <1500 → 需再攒满预算才再触发，与旧条件互斥、无乒乓。
    //   精确判据 = 有 intent 块 且（含 intent 面≥1500 且剥 intent 面<1500）——纯共存（各块很小）不触发，F3 语义保全。
    function countIntentBlocks(text) {
      return String(text || "").split("\n").filter((l) => /^<!-- intent: /.test(l)).length;
    }
    // v0.5（step4b 格级判据 A）：分格文件返回「每格真实要点面」数组（剥 intent 剥 dump 后按格计数，
    // 计数语义同 injectedCharsOf：intent 是 compact 中转产物不作为触发燃料）；未分格返回 []（走全文件判据）。
    // 依赖顶层 parseDailySections（纯函数）+ 本区 stripIntentBlocksForCount。
    function sectionCharsOf(text) {
      if (!isDailySectioned(text)) return [];
      const out = [];
      for (const s of parseDailySections(text)) {
        if (s.kind !== "project" && s.kind !== "general") continue;   // v2.5.2（F5a 涟漪①）：archive 独立成段后不再计格级燃料（本日 general 面 −933）；
      //   injectedCharsOf 全文件口径仍计入——两套判据从此不对称，属可接受（归档低频增量）
        const body = stripIntentBlocksForCount(s.lines.slice(1).join("\n"));
        out.push({ kind: s.kind, key: s.key || "", chars: body.trim().length });
      }
      return out;
    }
    // v2.4.31-2（审核 P1-1）：防乒乓增长闸——成功合并后记录「合并后注入面」基准，需再增长 ≥15% 才允许再触发同一文件。
    // 根治「合并输出 > 触发阈值 → 每条用户消息再触发」的结构性乒乓（.monitor.json 实证：09-04 阈值 750 时 25 分钟 8 次
    // 合并、09-07 16:19→16:22→16:29 每 3 分钟连发；/dream 自校准 1100→950→750→700→750→800 只调阈值治标不治本——
    // 校准上限 1500 与允许带同值，配置空间内结构性乒乓无法靠校准消除）。统一作用于三个触发判据（全文件/分格格级/
    // intent 撑爆兜底）；无基准（首合并/手动文件/旧数据）= 放行零退化；基准随每次成功合并（含 over-budget-inject
    // 直接注入与熔断机械收敛）更新。
    function maintGrowthGate(successBaseChars, curChars) {
      if (!successBaseChars || !(successBaseChars > 0)) return true;
      return curChars >= Math.ceil(successBaseChars * 1.15);
    }
    function maintSuccessBaseOf(fname) {
      try { const md = readMonitorData(); return (md.maintSuccessBase && md.maintSuccessBase[fname]) || 0; } catch (e) { return 0; }
    }
    function maintRecordSuccessBase(fname, finalText) {
      try {
        const md = readMonitorData();
        if (!md.maintSuccessBase) md.maintSuccessBase = {};
        md.maintSuccessBase[fname] = injectedCharsOf(finalText);   // 合并后真实注入面（含块标题等结构开销，与触发判定同口径）
        scheduleMonitorSave();
      } catch (e) {}
    }
    function needMaintenanceMerge(fname) {
      const target = MEMORY_ROOT + "/sessions/" + fname;
      try {
        const raw = fs.readFileSync(portable(target), "utf8");
        const mChars = injectedCharsOf(raw);
        // v2.4.31-2（审核 P1-1）：增长闸统一先行——任一判据命中但增长不足 15% 即不触发（防乒乓，零 spawn 成本）
        const gated = !maintGrowthGate(maintSuccessBaseOf(fname), mChars);
        if (mChars >= maintTriggerChars()) return !gated;   // 旧条件：全文件真实要点面超预算
        // v0.5（step4b 判据 A）：分格文件任一格要点面 ≥ 阈值即触发（格爆满早于全文件响应）
        const secChars = sectionCharsOf(raw);
        if (secChars.some((g) => g.chars >= maintTriggerChars())) return !gated;
        // v2.4.4（B）：intent 撑爆注入面兜底
        if (countIntentBlocks(raw) >= 1) {
          const withIntent = stripCompactionDumps(raw).trim().length;
          if (withIntent >= maintTriggerChars() && mChars < maintTriggerChars()) return !gated;
        }
        return false;
      } catch (e) { return false; }
    }
    // ═══════ v2.4.5：合并维护失败重试状态机 ═══════
    // 背景：compact/pre-step 触发 runMaintenanceMerge 均为 fire-and-forget，子代理被中断/报错时
    // 该次触发作废；compact 路径尤其致命——同一会话短期内不会再 compact。本机制补上「失败登记 +
    // 退避窗口 + 尝试上限」，由 pre-step step1 / compact 检查这两个既有调用点自然消费，零新增定时器。
    // 口径：仅当日有效（过午夜作废归人工提醒轨道）；成功落盘即清零；连续失败 ≥3 次熔断到次日。
    const MAINT_RETRY_MAX = 3;                    // 当日累计尝试上限（含首次），达上限熔断
    const MAINT_BACKOFF_MS = [2 * 60e3, 10 * 60e3, 30 * 60e3];   // 第1/2/3次失败后的退避阶梯
    let MAINT_RETRY = null;                       // { day, attempts, nextAt, lastReason }
    // v0.5（2026-09-03 治标）：MAINT_RETRY 跨重启持久化到 .integrate.json——病态文件（注定 topic-lost 的高密度
    // 字面量）每次重启后内存计数清零会重头再试 3 次，永不熔断；持久化后重启延续失败计数，真正熔断到日切。
    function persistMaintRetry() {
      try { const st = readIntegrateState() || {}; st.maintRetry = MAINT_RETRY; writeIntegrateState(st); } catch (e) {}
    }
    function loadMaintRetryIfAbsent() {
      if (MAINT_RETRY) return;
      try {
        const st = readIntegrateState();
        const r = st && st.maintRetry;
        if (r && typeof r === "object" && r.day === dateStr(new Date()) + ".md" && typeof r.attempts === "number") {
          MAINT_RETRY = { day: r.day, attempts: r.attempts, nextAt: Number(r.nextAt) || 0, lastReason: String(r.lastReason || "") };
        } else { MAINT_RETRY = null; }
      } catch (e) { MAINT_RETRY = null; }
    }
    function maintRetryResetIfStale() {
      loadMaintRetryIfAbsent();
      const today = dateStr(new Date()) + ".md";
      if (MAINT_RETRY && MAINT_RETRY.day !== today) { MAINT_RETRY = null; MAINT_FUSED = false; persistMaintRetry(); }   // 跨日作废（机械收敛旗标同步复位）
    }
    // 返回 true = 允许发起本次尝试（含首次）；false = 冷却中或已熔断
    function maintRetryAllow(fname) {
      maintRetryResetIfStale();
      if (!MAINT_RETRY) return true;
      if (MAINT_RETRY.day !== fname) return true;               // 不同文件不互相阻塞（理论少见）
      if (MAINT_RETRY.attempts >= MAINT_RETRY_MAX) return false; // 熔断至日切
      return Date.now() >= MAINT_RETRY.nextAt;                  // 退避窗口未到 → 跳过
    }
    function maintRetryRecordFail(fname, reason) {
      maintRetryResetIfStale();
      if (!MAINT_RETRY || MAINT_RETRY.day !== fname) {
        MAINT_RETRY = { day: fname, attempts: 0, nextAt: 0, lastReason: "" };
      }
      MAINT_RETRY.attempts += 1;
      MAINT_RETRY.lastReason = String(reason || "");
      const backoff = MAINT_BACKOFF_MS[Math.min(MAINT_RETRY.attempts - 1, MAINT_BACKOFF_MS.length - 1)];
      MAINT_RETRY.nextAt = Date.now() + backoff;
      persistMaintRetry();
      monitorEvent("maint-retry", "fail#" + MAINT_RETRY.attempts + " " + fname +
        " reason=" + MAINT_RETRY.lastReason + " backoff=" + Math.round(backoff / 60e3) + "m");
      // v2.4.5 第4层：达熔断上限 → 立即机械收敛（纯代码，零 LLM 依赖；compact 原文已在 dump 资产中逐字保留）
      if (MAINT_RETRY.attempts >= MAINT_RETRY_MAX) mechanicalConverge(fname);
    }
    function maintRetryClear() { MAINT_RETRY = null; persistMaintRetry(); }   // 成功落盘即清零
    // v2.4.5 第4层：熔断路径机械收敛兜底（用户拍板方向：compact 原文已在 dump 里，无需新增内容；
    // LLM 合并连续 3 次失败时，纯代码把「剥 dump、剥 intent 后的现存要点面」原样搬入当日要点块头，
    // dump 资产逐字保留——零信息丢失、零 LLM 依赖，保证注入面回到预算内）。每文件每日至多一次。
    let MAINT_FUSED = false;
    function mechanicalConverge(fname) {
      // v2.4.10：去掉 MAINT_RUNNING 自锁——本函数唯一调用点（maintRetryRecordFail 熔断分支）恒在
      // runMaintenanceMerge try/finally 内执行，MAINT_RUNNING 必为 true，旧守卫使 v2.4.5 熔断机械收敛
      // 自引入起从未生效（MAINT_FUSED 恒 false）。双向互斥后此调用点 INTENT_RUNNING 恒为 false
      // （maint 运行期间 intent 被挡在 INTENT_PENDING 队列），本函数全同步无 async 间隙，写盘安全。
      if (MAINT_FUSED) return false;
      try {
        const target = MEMORY_ROOT + "/sessions/" + fname;
        const existing = fs.readFileSync(portable(target), "utf8");
        // v0.5.1（2026-09-03 修）：分格感知要点提取——机械收敛只收通用块真实要点（剥格标题/intent/dump），
        // 项目块原样保留不进 mergedBlock；旧格式维持整文件 strip（零退化）。防分格标题/当日要点标题被当正文再嵌入
        // 造成重复结构（实证：15:10 熔断后文件出现双项目块/双通用块 + 空「机械收敛」壳标题，points 混入格标题行）。
        let points;
        if (isDailySectioned(existing)) {
          const _secs = parseDailySections(existing);
          const _gen = _secs.filter((s) => s.kind === "general").map((s) => s.lines.slice(1).join("\n")).join("\n");
          const _body = stripIntentBlocksForCount(_gen).split("\n").filter((l) => !/^##\s*当日要点（/.test(l.trim()) && !/^##\s*通用块/.test(l.trim())).join("\n");
          points = stripCompactionDumps(_body).trim();
        } else {
          points = stripIntentBlocksForCount(stripCompactionDumps(existing)).trim();
        }
        if (!points) return false;                       // 无要点可收（全在 dump 里），无需动作
        let kept = points;
        if (kept.length > 1050) {                        // 行界截断，绝不断句
          const cut = kept.lastIndexOf("\n", 1050);
          kept = (cut > 700 ? kept.slice(0, cut) : kept.slice(0, 1050)).trim();
        }
        // v2.4.2：机械收敛——提取 compaction dump 资产（与 runMaintenanceMerge 同边界规则：marker 开块、任意注释/H1/中文H2 止块）
        // v2.4.12（评审 P0-2）：纳入共享 fenceStep——旧实现无围栏感知，yaml 代码块内 `# ──` 会被判 H1 边界
        //   提前止块（拦腰截断 dump = 丢内容 + 再泄漏）；熔断兜底路径不能带旧病。
        const lines = String(existing).split("\n");
        const dumps = [];
        let capturing = false;
        let fence = null;
        for (const ln of lines) {
          if (/^\s*<!-- compaction: /.test(ln)) { capturing = true; dumps.push(ln); continue; }
          if (!capturing) continue;
          const fs3 = fenceStep(ln, fence);
          const wasFenceLine = fs3[1];
          fence = fs3[0];
          if (wasFenceLine) { dumps.push(ln); continue; }   // 围栏行（开/关）保真保留
          if (fence) { dumps.push(ln); continue; }           // 围栏内不判边界
          if (/^\s*<!-- /.test(ln) || /^#\s/.test(ln) || (/^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln))) { capturing = false; continue; }
          dumps.push(ln);
        }
        const block = "## 当日要点（" + dateStr(new Date()) + " 机械收敛）\n\n" + kept + "\n";
        // v0.5（step4b）：分格文件机械收敛不拍平——项目格保留，收敛要点并入通用块，dump 尾区保留
        // v2.5.2（F4）：mech 同样预算可删旧节（guard=kept≤1050)；覆盖不足→保留零退化（I1）
        let _rmH = null;
        try { _rmH = collectRemovableDayHeaders(existing, dateStr(new Date()), kept, fname); } catch (eR) { _rmH = null; }
        let _mechFinal;
        if (isDailySectioned(existing)) {
          _mechFinal = mergeIntoGeneralBlock(existing, block.trim(), dumps.join("\n"), { removableHeaders: _rmH || new Set() });
        } else {
          _mechFinal = block + (dumps.length ? "\n\n" + dumps.join("\n") : "") + "\n";
        }
        const mk = writeFileAtomic(portable(target), _mechFinal, { tag: "mech", verify: true });   // v0.5（step2 内容闸）：统一原子写 + N7 补回读
        if (mk && mk.readbackOk === false) cwarn("[dsh-memory] 机械收敛写回回读不一致 sessions/" + fname);
        MAINT_FUSED = true;                              // 本文件本日至多机械收敛一次
        monitorEvent("maint-fallback", "mechanical " + fname + " kept=" + kept.length);
        clog("[dsh-memory] 合并维护熔断 → 机械收敛 sessions/" + fname + "（" + kept.length + " 字符，dump 资产完整保留）");
        maintRecordSuccessBase(fname, _mechFinal);   // v2.4.31-2（审核 P1-1）：机械收敛同为成功收敛，更新注入面基准（防反复熔断后连环触发）
        try { refreshMemorySessionsIndex(); } catch (e2) {}
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 机械收敛失败:", e && e.message ? e.message : String(e));
        return false;
      }
    }
    // v2.4.2：合并维护任务书——不依赖宿主摘要（触发源是用户消息/compact，旧要点本身就是主体）：
    // 把当日 md 已积累的检查点/要点压缩去重，保持注入面不再膨胀
    // v2.4.31：卸责式改写——长度责任彻底卸给插件（禁止数数，LLM 数不清混合中文字符，实证 09-07 字数打转 15 分 abort）；
    // 结构锚（行数/条数）替代字符阈；字面量优先：「因必保字面量导致超限是预期」——输出干练版即可，超限与否全由插件判定
    const MAINT_MERGE_INSTRUCTION =
      "你是记忆维护压缩器。对以下「当日检查点现状」（当日会话摘要里已积累的旧检查点与要点）执行压缩合并，输出固定结构 Markdown（只输出下列三节）：\n" +
      "## 本次目标\n（保留仍有效的用户请求/主线目标原文，无则写「已完结」）\n" +
      "## 下一步行动\n（保留未决事项/衔接点，无则写「无明确下一步」）\n" +
      "## 关键结论\n（把旧要点合并去重：同主题取新、删重复客套、保留全部精确字面量——路径/ID/命令/数字/报错串逐字保留绝不概括）\n" +
      "纪律（v2.4.31 口径）：三节合计目测约 25~35 行、宁短勿长（篇幅目标是插件侧预算，**绝对禁止手工数数字符**——输出长度由插件机器测量并自动判定处理：超限会走精简或直接注入，你无需对齐任何数字、不必自测、禁止反复重写）；「关键结论」逐条一行、每条一句话（目测 ≤2 行版幅）；字面量优先：路径/ID/命令/数字/报错串逐字保留绝不概括，**若因必保字面量导致篇幅超限是预期**，输出你最干练的版本即可、不必为此焦虑；宁删次要旧要点，绝不断句；不编造新内容；只输出三节无任何额外说明。\n" +
      "结构纪律（v2.4.12）：正文禁止输出任何 `<!--` 注释行/HTML 注释（含 `<!-- compaction:`、`<!-- intent:` 字样）；如需示例代码请用成对 ``` 围栏包住且必须闭合。\n\n===== 当日检查点现状 =====\n";
    // ═══════════ v2.4.9：maint 合并结果「主题覆盖校验」+「落盘回读校验」═══════════
    // 实证（2026-08-31 22:49 真机）：b76ddcb5 合并子代理只复述了 intent 检查点、整块丢弃「当日要点」
    // （记忆插件 v2.4.8/对账主题），输出格式头+长度都合规 → 旧护栏静默接受 → 覆盖式写回把顶部实时块
    // 换成单一主题，记忆插件待办从注入面消失（仅残存 compaction dump）。根因=落盘护栏只验格式和长度，
    // 不验「输出是否覆盖输入全部主题」。本校验纯正则+子串比对，零 LLM 依赖：
    //   1) 输入按主题块切分（intent 检查点块 / 当日要点块 / 自动检查点块）；
    //   2) 每块提取强锚点（UUID/hex id/版本号/路径/反引号命令/变量/长数字）；
    //   3) 输出必须命中每块 ≥1 个锚点，否则判 topic-lost → malformed → v2.4.5 退避重试 → 熔断机械收敛。
    // 弱块（无锚点的纯描述文本）不硬校验，避免误杀。
    // 主题块边界 = `<!-- intent: ` 标记行 或 `## ` 中文标题行（三节名 本次目标/下一步行动/关键结论 不算新块）。
    function splitTopicBlocks(text) {
      const SECTION_HEAD = /^##\s*(本次目标|下一步行动|关键结论)\s*$/;
      const lines = String(text || "").split("\n");
      const blocks = [];
      let cur = null;
      for (const ln of lines) {
        if (/^<!-- intent: /.test(ln)) {
          if (cur) blocks.push(cur);
          cur = { intent: true, lines: [ln] };
          continue;
        }
        if (!SECTION_HEAD.test(ln) && /^##\s/.test(ln)) {
          // 紧跟 intent marker 的标题（「## 检查点（目标与下一步…」）并入 marker 块，不另开新块；并入后复位 intent 标志
          if (cur && cur.intent) { cur.lines.push(ln); cur.intent = false; continue; }
          if (cur) blocks.push(cur);
          cur = { intent: false, lines: [ln] };
          continue;
        }
        if (cur) cur.lines.push(ln);
      }
      if (cur) blocks.push(cur);
      return blocks.map((b) => b.lines.join("\n").trim()).filter((b) => b.length > 0);
    }
    // 强锚点提取：要求「同时含 a-f 与 0-9」的 hex token（排除 deadbeef 类纯字母词与纯数字串），
    // + 完整 UUID / 16+ 位 hex（MD5 等）/ 版本号 / Windows 路径 / 反引号命令或文件名 / $变量 / 6+ 位数字
    function extractAnchors(text) {
      const s = String(text || "");
      const out = new Set();
      const add = (m) => { if (m && m.trim().length >= 3) out.add(m.trim()); };
      for (const m of s.matchAll(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi)) add(m[0]);
      for (const m of s.matchAll(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{6,12}\b/g)) add(m[0]);
      for (const m of s.matchAll(/\b[0-9a-f]{16,40}\b/g)) add(m[0]);
      for (const m of s.matchAll(/\bv\d+(?:\.\d+)*[a-z]?\b/gi)) add(m[0]);
      for (const m of s.matchAll(/[A-Za-z]:\\[^\s"']+/g)) add(m[0]);
      for (const m of s.matchAll(/`([^`\n]{3,})`/g)) {
        const t = m[1].trim();
        // 过滤泛化短文件名锚点（index.html 等——正文同词可伪命中，实证 2026-08-31 v2.4.9.1）；含路径/下划线/符号/中文的特异长串保留
        if (/^[A-Za-z0-9._\-]+$/.test(t) && t.length < 14) continue;
        add(t);
      }
      for (const m of s.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) add(m[0]);
      for (const m of s.matchAll(/20\d{6}[a-z]?\b/g)) add(m[0]);
      for (const m of s.matchAll(/\b\d{6,}\b/g)) add(m[0]);
      return [...out];
    }
    // 主题覆盖校验：返回缺失主题清单 [{head, anchors}]，空数组=通过
    // v2.4.9.1 差分锚点：仅命中「该块专属锚点」（输入中只在本块出现的锚点）才算覆盖——防共享锚点伪命中
    // （实证：检查点块「关键结论」也有 20260818o，当日要点块锚点 20260818o 被坏输出伪命中而漏拦）
    function checkTopicCoverage(inputText, outputText) {
      const outL = String(outputText || "").toLowerCase();
      const blocks = splitTopicBlocks(inputText)
        .map((blk) => ({ blk, anchors: extractAnchors(blk) }))
        .filter((b) => b.anchors.length > 0);
      if (!blocks.length) return [];
      const missing = [];
      for (const { blk, anchors } of blocks) {
        // 专属锚点=输入其余块锚点集中不存在的锚点；全部共享时回退整组
        const exclusive = anchors.filter((a) => {
          const al = a.toLowerCase();
          return !blocks.some((b) => b.blk !== blk && b.anchors.some((x) => x.toLowerCase() === al));
        });
        const must = exclusive.length ? exclusive : anchors;
        const hit = must.some((a) => outL.includes(a.toLowerCase()));
        if (!hit) missing.push({ head: blk.split("\n")[0].slice(0, 30), anchors: must.slice(0, 5) });
      }
      return missing;
    }
    // v2.4.9：落盘回读校验——writeFileSync 后立即读回比对（尾部空白差异容忍），
    // 防 OneDrive 占位/编码静默失败（2026-08-31 序号踩坑清单：写占位静默失败、GBK 截断）
    function readbackVerify(targetFull, expected) {
      try {
        const back = fs.readFileSync(targetFull, "utf8");
        return back && back.trimEnd() === String(expected).trimEnd();
      } catch (e) { return false; }
    }
    // v2.4.2：合并维护执行体——spawn 子代理压缩合并当日 md 旧要点（无宿主摘要依赖）
    // v2.5.2（F4，评审 B13-c）：调用点预算「可删同日旧节」——与 mergeIntoGeneralBlock 的 restLines 分流同源捕获逻辑
    //   （H2 感知+围栏跟踪）切出每个同日「当日要点（维护合并/机械收敛）」节，用 checkTopicCoverage 验 merged 覆盖其锚点；
    //   覆盖→加入可删 Set；未覆盖→monitorEvent dedup-skipped-uncovered + 保留（宁残留不误删，I1）；模块级函数保持纯切分。
    function collectRemovableDayHeaders(existing, dayText, guardText, fname) {
      const out = new Set();
      try {
        if (!isDailySectioned(existing)) return out;
        const secs = parseDailySections(existing);
        const HDR = new RegExp("^##\\s*当日要点（" + dayText + " (维护合并|机械收敛)）$");
        for (const s of secs) {
          if (s.kind !== "general") continue;
          const rest = [];
          let cur = null, _fence = null;
          const MARK = /^<!-- intent: [0-9a-zA-Z-]{8,}(?: sid:(\S+?))? -->/;
          for (const ln of s.lines.slice(1)) {
            if (ln.match(MARK)) { cur = { lines: [ln] }; continue; }
            if (cur && /^\s*<!-- /.test(ln)) { cur = null; rest.push(ln); continue; }
            const f1 = fenceStep(ln, _fence); _fence = f1[0];
            if (cur && !_fence && /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln) && !OWN_SECTIONS.test(ln)) { cur = null; rest.push(ln); continue; }
            if (cur) cur.lines.push(ln); else rest.push(ln);
          }
          for (let i = 0; i < rest.length; i++) {
            const h = rest[i].trim();
            if (!h.match(HDR)) continue;
            const seg = [h];
            let j = i + 1;
            for (; j < rest.length; j++) {
              if (/^##\s/.test(rest[j]) && !/^##\s*[A-Za-z]/.test(rest[j]) && !OWN_SECTIONS.test(rest[j])) break;
              seg.push(rest[j]);
            }
            const body = seg.slice(1).join("\n").trim();   // 剥节头（防日期锚点伪命中，评审 P2-3）
            const lost = body ? checkTopicCoverage(body, String(guardText || "")) : [];
            if (lost.length === 0) out.add(h);
            else { try { monitorEvent("maint", "dedup-skipped-uncovered " + fname); } catch (eD) {} }
            i = j - 1;
          }
        }
      } catch (e) {}
      return out;
    }
    async function runMaintenanceMerge(fname, summaryText, parentAgent, sid8) {
      if (MAINT_RUNNING) return false;
      // v2.4.10：意图检查点运行中 → 跳过本轮（不登记失败）。maint 不依赖本轮宿主摘要（无摘要也照常合并旧要点），
      // 晚收敛无害——pre-step/下次 compact 自然再触发；同时杜绝两路「整文件重建写回」并发覆盖（陈旧快照竞态，
      // 实证：intent 先落盘则新检查点整块丢失、intent 后落盘则 maint 成果被回滚）。
      if (INTENT_RUNNING) return false;
      // v2.4.5：重试闸门——冷却窗口未到或当日已熔断则静默跳过（不占忙锁，不打日志刷屏）
      if (!maintRetryAllow(fname)) return false;
      MAINT_RUNNING = true;
      // v0.5（P0-2）：beforeChars 必须在 try 外声明——no-subagents 早退（L3748）与 catch 块（L3881）都引用它，
      // try 内 const 会造成 TDZ ReferenceError（真机实证：subagent max-tokens → catch 引用 beforeChars 崩宿主）。
      let beforeChars = 0;
      try {
        const subagents = ctx.get("subagents");
        if (!subagents || typeof subagents.start !== "function") {
          clog("[dsh-memory] 合并维护：subagents 不可用，跳过（下次触发再试）");
          maintRetryRecordFail(fname, "no-subagents");   // v2.4.5：登记退避，避免每条消息都撞一次空通道
          recordMaintSample({ fname, beforeChars, afterChars: null, result: "no-subagents" });   // v0.5（P0-2）
          return false;
        }
        const target = MEMORY_ROOT + "/sessions/" + fname;
        let existing = "";
        try { existing = fs.readFileSync(portable(target), "utf8"); } catch (e) { existing = ""; }
        const existingStripped = stripCompactionDumps(existing);   // 旧要点（不喂 compaction dump 资产）
        // v2.4.30（maint topic-lost 口径修复，方案 A）：主题覆盖校验输入 = 剥项目格后的文本——分格文件的
        //   项目格由写回 mergeIntoGeneralBlock 原样保留（不依赖子代理输出覆盖），校验含项目格会假阳性拦截
        //   （实证 2026-09-04 3ab5ce7d intent 连 3 次 topic-lost → 熔断机械收敛）；prompt 仍喂全量供参考。
        const coverageInput = stripProjectBlocksForCoverage(existingStripped);
        beforeChars = String(existingStripped || "").trim().length;   // v0.5（P0-2）：触发前真实要点面字数；格级语义 step5 后，当前全文件口径校判据 B
        if (existingStripped.trim().length < 60) return false;     // 无要点可合并（空或仅剩 dump）
        const prompt = MAINT_MERGE_INSTRUCTION + existingStripped +
          (summaryText ? "\n\n（另：本次压缩事件宿主摘要，可参考补充最新进展）\n" + smartTrim(summaryText, 20000, "sessions/" + fname + "（memory_search 可查）") : "");
        let sum = await compactOnce(subagents, parentAgent, prompt, "maint-" + fname.replace(/\..+$/, ""));
        if (sum) sum = extractBodyFromMarker(sum);   // v2.5.2（F1′）：剥前言——省得 head-test 假失败把整轮成果作废
        let malformed = false;
        let failReason = "malformed";
        if (!sum) {
          clog("[dsh-memory] 合并维护：子代理无输出，跳过落盘");
        } else if (!/^##\s*本次目标/.test(sum.trim())) {
          clog("[dsh-memory] 合并维护：子代理输出格式不符，跳过落盘");
          malformed = true;
        } else {
          // v2.4.9：主题覆盖校验——输出必须保留输入每个主题块的强锚点（防「只复述 intent、吞当日要点」静默丢主题，
          // 实证 2026-08-31 b76ddcb5：格式头+长度均合规但整块主题被弃，旧护栏拦不住、覆盖写回毁顶部块）
          // v2.4.30（方案 A）：校验输入用 coverageInput（剥项目格）——项目格写回原样保留不需输出覆盖
          // v2.5.3（评审 B1/B2/D1）：整文件覆盖闸只服务未分格破坏性写回——分格写回 mergeIntoGeneralBlock 不消费
          //   intent 子块/归档/手工节（保留原样），删除权威=collectRemovableDayHeaders 逐节校验+I1；分格下本闸对
          //   marker-元数据专属锚点块结构性必败（2026-09-09 1d441ddf 三次 topic-lost 死锁），故按判别器短路。
          //   判别输入=existing——与写回分支 isDailySectioned(existing) 同源同输入（评审 B1）。
          const missing = maintWholeFileCoverageRequired(existing) ? checkTopicCoverage(coverageInput || existingStripped, sum) : [];
          if (missing.length) {
            malformed = true;
            failReason = "topic-lost";
            const detail = missing.map((m) => m.head + " anchors=[" + m.anchors.join(",") + "]").join(" | ");
            clog("[dsh-memory] 合并维护：子代理输出丢主题，跳过落盘：" + detail);
            monitorEvent("maint", "topic-lost " + missing.length + "块 " + fname + " " + detail.slice(0, 160));
          }
          // v2.4.12（P1）：写入端结构校验（三节/围栏/marker）——与主题覆盖互补：前者防丢主题、后者防污染结构
          const vs = validateMdStructure(sum, { requireSections: true });
          if (!vs.ok) {
            malformed = true;
            failReason = "bad-structure";
            clog("[dsh-memory] 合并维护：子代理输出结构违规，跳过落盘：" + vs.errors.join(" | "));
            monitorEvent("maint", "bad-structure " + vs.errors.length + "项 " + vs.errors.slice(0, 2).join("/").slice(0, 120));
          }
        }
        if (!sum || malformed) {
          maintRetryRecordFail(fname, !sum ? "no-output" : failReason);   // v2.4.5 + v2.4.9 topic-lost + v2.4.12 bad-structure
          recordMaintSample({ fname, beforeChars, afterChars: null, result: !sum ? "no-output" : failReason });   // v0.5（P0-2）
          return false;
        }
        let merged = sum.trim();
        // v2.4.21（用户拍板 2026-09-02）：阈值 120% 允许带——≤1320 直接通过（不再 pop 裁尾静默丢结论）；
        // >1320 → 返回模型重试（新 start 精简轮，保持三节/逐条分行/保字面量）至多 3 次；3 次后仍超 → 直接注入（不裁剪）。
        // v2.4.31（用户拍板 2026-09-07）：允许带 1320→1500（实测输出集中在 1448~1500——字面量硬约束下
        // 压缩不了是常态，放水多数直接过，slim 触发大减）；重试 ≤2 轮 + **无进展即停**：机器量相邻轮字符数，
        // 缩短 <8% 或变长即判「已尽力/压缩不了」→ 立即停重试走直接注入+埋点（stuck）——用机器信号替代
        // 「逼模型表态」（LLM 数不清字符，实证 09-07 16:51 maint-slim 打转 15 分 abort）；终点=直接注入不变。
        const MAINT_LIMIT_ALLOW = 1500;   // v2.4.31：1320→1500（用户拍板）
        let slimStats = null;   // v2.5.2（P2）：slim 轮统计捕获（calls/lens/reason），供 recordMaintSample 记录供 SLIM_FEASIBLE_MAX 校准
        if (merged.length > MAINT_LIMIT_ALLOW) {
          let cur = merged;
          let attempt = 0;
          let stuck = false;   // v2.4.31：无进展即停信号（缩短 <8% 或变长 → 已尽力）
          let stuckReason = "";   // v2.4.31-2（审核 P1-2）：no-progress | abort（slim 硬停=已尽力，非失败）
          let slimLenLog = [];   // v2.5.2（P2/F1′）：slim 各轮 body 长度日志，供 recordMaintSample 校准 SLIM_FEASIBLE_MAX
          const SLIM_FEASIBLE_MAX = (function () {   // v2.5.2（F2）准入预判——结构论证值（09-09 实证 -1.1%；81 样本 afterChars 中间带 1501~2307=0）
            try { const t = readMonitorData().maintThresh && readMonitorData().maintThresh.slimFeasibleMax; if (typeof t === "number" && t >= 0.15 && t <= 0.80) return t; } catch (e) {}
            return 0.35;
          })();
          while (attempt < 2 && cur.length > MAINT_LIMIT_ALLOW && !stuck) {
            attempt++;
            const prev = cur;
            if (1 - MAINT_LIMIT_ALLOW / prev.length > SLIM_FEASIBLE_MAX) {   // v2.5.2（F2）：深超限（如 2633）>0.35 相对缺口时 slim 无胜算（字面量密集内容压缩率实测 <1.5%），直接注入免白烧一轮
              stuck = true; stuckReason = "infeasible"; attempt--; break;
            }
            // v2.4.31-2（审核 P1-2）：slim 轮 watchdog abort 不再回滚整次合并——按 stuck 语义回落「直接注入上一版」，
            // 兑现用户裁定终点（abort=已尽力：不登记失败、不退避、不熔断，避免 3 次失败→机械收敛行界截断丢结论）
            let slim = null;
            let slimAborted = false;
            try {
              slim = await compactOnce(subagents, parentAgent,
                "上一版维护合并输出 " + prev.length + " 字符（插件实测），超出允许带 " + MAINT_LIMIT_ALLOW + "。请**目测删减约三分之一篇幅**（平均约每 3 行删 1 行：删次要旧要点、合并重复表述、压缩客套），**绝对禁止手工数数字符**——输出长度由插件机器测量并自动判定处理，你无需对齐任何数字，不要自测、不要反复重写、一次成型输出即可；保留全部精确字面量（路径/ID/命令/数字/报错串逐字）、保持三节结构与「关键结论」逐条分行（每条一句话）。只输出三节，不要任何额外说明（包括核对说明、开场白）。工具面：仅 run_code（内部可调 memory_search）。上一版原文如下：\n\n" + prev,
                "maint-slim-" + fname.replace(/\..+$/, ""), MAINT_SLIM_TIMING);   // v2.4.31：slim 轮短超时（hard 8 分）
            } catch (e) {
              if (e && e.__maintFail === "aborted") { slimAborted = true; } else { throw e; }
            }
            if (slimAborted) { stuck = true; stuckReason = "abort"; break; }   // 硬停=已尽力 → 直接注入上一版（不裁剪）
            if (slim) slim = extractBodyFromMarker(slim);   // v2.5.2（F1′）：slim 输出带前言（核对说明/开场白）致 head-test false→break，择优分支永不达（09-09 真机事故回归）
            if (slim && /^##\s*本次目标/.test(slim.trim())) {
              const slimT = slim.trim();
              // v2.4.24（审查 P1-3）：精简轮同样复跑主题覆盖 + 结构校验——否则 topic-lost/bad-structure 在重试路径复活（v2.4.9 事故形态）
              // v2.4.30（方案 A）：校验输入同主路径用 coverageInput（剥项目格）
              // v2.5.3（评审 B3）：与主闸同源短路（判别输入=existing，评审 B1）——分格下 slim 采纳判定只余
              //   validateMdStructure+长度/进展判据；覆盖由逐节删除门兜底，无需 slim 复验
              const slimLost = maintWholeFileCoverageRequired(existing) ? checkTopicCoverage(coverageInput || existingStripped, slimT) : [];
              const slimVS = validateMdStructure(slimT, { requireSections: true });
              slimLenLog.push(slimT.length);   // v2.5.2（P2）：slim 轮 body 长度入账
              if (slimLost.length === 0 && slimVS.ok) {
                // v2.4.31：无进展判定——本轮较上轮缩短 <8% 或变长 → 判「已尽力/压缩不了」，停止重试
                // （顺序：先校验再量，坏输出不参与进度计算；无进展/变长时择优取更短版，只停后续轮）
                if (slimT.length >= Math.round(prev.length * 0.92)) {
                  stuck = true;
                  stuckReason = "no-progress";
                  // v2.5.2（F3，评审裁决）：本分支语义=择优采纳更短合格版；F1′(extractBodyFromMarker) 已修达可达性，实测生效
                  cur = slimT.length < prev.length ? slimT : prev;
                } else {
                  cur = slimT;
                }
              } else { try { monitorEvent("maint", "slim-break-" + (slimLost.length > 0 ? "cov" : "struct") + " " + fname); } catch (eMs) {}   // v2.5.2（P2-5）：break 细分（原四类不可区分）；v2.5.3（评审 B3）：分格下 slimLost 恒 []，cov 分支仅未分格可达
                break;
              }
            } else { try { monitorEvent("maint", "slim-break-" + (slim ? "head" : "null") + " " + fname); } catch (eMs2) {}   // v2.5.2（P2-5）
              break;
            }
          }
          merged = cur;
          slimStats = { calls: attempt, lens: slimLenLog.slice(), reason: stuckReason };   // v2.5.2（P2）
          if (merged.length > MAINT_LIMIT_ALLOW) {   // 重试耗尽/无进展/abort 后仍超 → 直接注入（用户口径，不裁剪）
            clog("[dsh-memory] 合并维护：重试 " + attempt + " 轮" + (stuck ? "（" + (stuckReason === "abort" ? "slim 硬停判死" : stuckReason === "infeasible" ? "深超限跳过" : "无进展判死") + "）" : "") + "后仍 " + merged.length + " 字符（>允许带 " + MAINT_LIMIT_ALLOW + "），按用户口径直接注入");
            try { monitorEvent("maint", "over-budget-inject " + merged.length + "字符" + (stuck ? " stuck=" + stuckReason : "") + " " + fname); } catch (eM) {}
          }
        }
        // v2.4.2：提取 compaction dump 资产（原文保留，与 stripCompactionDumps 同边界规则）
        // v2.4.11：fence 感知——与 stripCompactionDumps 同源修复（`# ──` YAML 注释被误判 H1 边界→丢资产）
        // v2.4.12（评审 P0-1）：修复「围栏开启行被丢弃」——旧实现 `if (fence) continue;` 会在首次
        //   遇到 ```yaml 时把开启行吞掉（fence 状态已在 fm 检查里翻转、但行本身被 continue），
        //   导致重写 dump 的围栏残缺 → 下次 strip 时 `# ──` 变裸 H1 → 重新制造 09-01 泄漏形态。
        //   现在：fence 行（含开启行）先 push/处理，再进 fence 分支。
        function extractCompactionDumps(text) {
          const lines = String(text || "").split("\n");
          const out = [];
          let capturing = false;
          let fence = null;
          for (const ln of lines) {
            // v2.4.2.2：相邻 dump 块（marker 直接跟 marker/正文）——compaction marker 一律开启新捕获并保留自身，
            // 绝不能在捕获中被当成终止边界（19:20 真机事故：一半 dump 被写回丢弃）
            if (/^\s*<!-- compaction: /.test(ln)) { capturing = true; out.push(ln); continue; }
            if (!capturing) continue;
            // v2.4.12：共享 fenceStep——先翻转状态、处理围栏开启行本身，再进 fence 分支
            const fs3 = fenceStep(ln, fence);
            const wasFenceLine = fs3[1];
            fence = fs3[0];
            if (wasFenceLine) { out.push(ln); continue; }   // 开启/关闭行都保真保留（P0-1）
            // v2.4.11：围栏内不判边界（`# ──` 等注释行/中文 H2 是代码块正文，不是 dump 终点）
            if (fence) { out.push(ln); continue; }
            const isH1 = /^#\s/.test(ln);
            const isOtherH2 = /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln);
            const isOtherMarker = /^\s*<!-- /.test(ln);
            if (isOtherMarker || isH1 || isOtherH2) { capturing = false; continue; }
            out.push(ln);
          }
          return out.join("\n");
        }
        // 覆盖式写回：新要点块（merged，已并入旧要点）+ 完整 compaction dump 资产；旧 intent 块/旧要点/旧手工内容由 merged 吸收
        // v0.5（step4b）：分格文件 → 不整文件拍平——项目格原样保留，合并结果并入通用块，dump 尾区保留；
        //   未分格 → 维持原「当日要点块在文件头」形态（旧格式兼容零退化）。
        const block = "## 当日要点（" + dateStr(new Date()) + " 维护合并）\n\n" + merged + "\n";
        const dumps = extractCompactionDumps(existing);
        // v2.5.2（F4）：预算可删同日旧节（被 merged 覆盖的）——checkTopicCoverage 闭包在调用点执行
        let removableHeaders = null;
        try { removableHeaders = collectRemovableDayHeaders(existing, dateStr(new Date()), merged, fname); } catch (eH) { removableHeaders = null; }
        let finalText;
        if (isDailySectioned(existing)) {
          finalText = mergeIntoGeneralBlock(existing, block.trim(), dumps, { removableHeaders: removableHeaders || new Set() });
        } else {
          finalText = block + (dumps ? "\n\n" + dumps : "") + "\n";
        }
        // v2.4.12（评审 P0-3）：composed finalText 围栏平衡断言——校验器只作用于 merged/sum，
        //   拼接产物（block+dumps）无人校验；dumps 若缺开启行/未闭合（P0-1 类残缺），下次 strip
        //   会把围栏内 `# ──` 当裸 H1 → 重新泄漏。纯代码断言：dump 资产内每对围栏须闭合。
        if (dumps) {
          let _f = null;
          for (const _l of dumps.split("\n")) { const _s = fenceStep(_l, _f); _f = _s[0]; }
          if (_f !== null) {
            clog("[dsh-memory] 合并维护：dump 围栏未闭合（F=" + _f + "），终止写回（P0-3 护栏）");
            monitorEvent("maint", "dump-fence-open " + fname + " F=" + _f);
            maintRetryRecordFail(fname, "dump-fence-open");
            recordMaintSample({ fname, beforeChars, afterChars: null, result: "dump-fence-open" });   // v0.5（P0-2）
            return false;
          }
        }
        writeFileAtomic(portable(target), finalText, { tag: "maint", verify: true });   // v0.5（step2 内容闸）：统一原子写（readback 状态在下面 readbackVerify 复用）
        // v2.4.9：落盘回读校验——读回与期望全文比对（OneDrive 占位/静默截断兜底）；失败不抛（dump 资产仍在下次重合并）
        if (!readbackVerify(portable(target), finalText)) {
          cwarn("[dsh-memory] 合并维护：写回回读不一致 sessions/" + fname + "，内容可能未持久化");
          monitorEvent("maint", "readback-mismatch " + fname);
        }
        clog("[dsh-memory] 合并维护完成 sessions/" + fname + "（" + merged.length + " 字符要点，注入面已收敛）");
        maintRetryClear();   // v2.4.5：成功落盘清零重试状态
        maintRecordSuccessBase(fname, finalText);   // v2.4.31-2（审核 P1-1）：记录合并后注入面基准（防乒乓增长闸；含 over-budget-inject 直接注入）
        recordMaintSample(Object.assign({ fname, beforeChars, afterChars: merged.length, result: "ok" }, slimStats ? { slimCalls: slimStats.calls, slimLens: slimStats.lens, stuckReason: slimStats.reason } : {}));   // v0.5（P0-2）；v2.5.2（P2）：slim 统计随样入账
        try { refreshMemorySessionsIndex(); } catch (e2) {}
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 合并维护失败:", e && e.message ? e.message : String(e));
        maintRetryRecordFail(fname, (e && (e.__maintFail || e.message)) ? String(e.__maintFail || e.message).slice(0, 60) : "throw");   // v2.4.5
        recordMaintSample({ fname, beforeChars, afterChars: null, result: "error" });   // v0.5（P0-2）
        return false;
      } finally {
        MAINT_RUNNING = false;
        // v2.4.10：合并维护结束 → 补火被挡排队的意图检查点（复用 spawnIntentCheckpoint finally 同款机制；
        // 若队列里是「因本 maint 而排」的槽，此刻两锁皆空可正常启动；若是别的 intent 挡下的槽，重入后幂等再排队）
        if (INTENT_PENDING.size > 0) {
          const nxt = INTENT_PENDING.entries().next().value;
          INTENT_PENDING.delete(nxt[0]);
          setTimeout(() => { try { spawnIntentCheckpoint(nxt[0], nxt[1].summaryText, nxt[1].fname, nxt[1].parentAgent, nxt[1].sessionId); } catch (e) {} }, 0);
        }
      }
    }
    // v2.3.3：移除文件头部堆积的旧意图块（只保留最新，对标 mimocode checkpoint.md 原位更新语义）。
    // 意图块 = 从 `<!-- intent: ... -->` 行开始，到下一个 `<!-- `（compaction marker）行之前。
    // v2.3.8 F3: intent 块按母会话分位（对标 mimocode per-session checkpoint.md）——marker 携带 sid:<8字>；
    // 写新块只删同 sid 旧块（原位更新），他会话块不动；全局至多保最近 3 块，超出从最老处淘汰并埋点。
    // 兼容：v2.3.7 及更早的无 sid 旧块视作 legacy，不占同会话替换，仅受 3 块上限挤退。
    function stripOldIntentBlocks(txt, keepSid) {
      const MARK = /^<!-- intent: [0-9a-zA-Z-]{8,}(?: sid:(\S+?))? -->/;   // 字符集放宽到字母数字-（真实为 uuid hex，测试夹具与非 hex id 兼容）
      const lines = String(txt || "").split("\n");
      // v0.5（step4b）：分格文件 → 格级剥离（每格至多 3 块，格间不互挤）——区别于旧「全局至多 3」。
      // 用 parseDailySections 切段，仅对 project/general 格内 intent 做「保 2 旧 + 删 keepSid」，dump/other 原样保留。
      if (isDailySectioned(txt)) {
        const secs = parseDailySections(txt);
        const outSecs = [];
        for (const s of secs) {
          if (s.kind !== "project" && s.kind !== "general") { outSecs.push(s.lines.join("\n")); continue; }
          const sLines = s.lines.slice(1);   // 跳过格标题行
          const blocks = [];
          const rest = [];
          let cur = null;
          let _fence = null;   // v2.5.2（F4b 补）：H2 终止带围栏跟踪——intent 三节内代码围栏里的 ## 行不得判边界
          for (const ln of sLines) {
            const m = ln.match(MARK);
            if (m) { cur = { sid: m[1] || "legacy", lines: [ln] }; blocks.push(cur); continue; }
            if (cur && /^\s*<!-- /.test(ln)) { cur = null; rest.push(ln); continue; }
            const _fsv = fenceStep(ln, _fence); _fence = _fsv[0];
            // v2.5.2（F4b，评审 P0）：intent 块捕获加 H2 感知终止（白名单=三节/检查点标题）——否则最后 intent 粘住 EOF 前全部内容，
            //   格内第 3 个 intent 到达时整块（含粘尾旧要点/归档）被淘汰销毁（真码仿真 7109→1141 毁灭路径）
            if (cur && !_fence && /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln) && !OWN_SECTIONS.test(ln)) { cur = null; rest.push(ln); continue; }
            if (cur) cur.lines.push(ln); else rest.push(ln);
          }
          const kept = [];
          for (const b of blocks) {
            if (keepSid && b.sid === keepSid) continue;
            if (kept.length >= 2) { try { monitorEvent("intent", "cap-evict-sid:" + b.sid); } catch (eM) {} continue; }   // 格内保2+新1=每格至多3
            kept.push(b);
          }
          const head = kept.map((b) => b.lines.join("\n")).join("\n\n");
          const segBody = [(head ? head + "\n" : ""), ...(rest.length ? rest : [])].filter((x) => x !== "").join("\n").replace(/\n{3,}/g, "\n\n").trim();
          outSecs.push(s.lines[0] + (segBody ? "\n" + segBody : ""));
        }
        return outSecs.join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
      }
      // 旧格式（未分格）：原「全局至多 3」逻辑
      const blocks = [];
      const rest = [];
      let cur = null;
      let _fence = null;   // v2.5.2（F4b 补）：旧格式分支围栏跟踪
      for (const ln of lines) {
        const m = ln.match(MARK);
        if (m) { cur = { sid: m[1] || "legacy", lines: [ln] }; blocks.push(cur); continue; }
        if (cur && /^\s*<!-- /.test(ln)) { cur = null; rest.push(ln); continue; }
        const _fsv2 = fenceStep(ln, _fence); _fence = _fsv2[0];   // v2.5.2（F4b 补）：围栏跟踪
        // v2.5.2（F4b，评审 P0）：同分格分支——H2 感知终止，防最旧 intent 粘尾被整块淘汰（旧格式同样遭殃）
        if (cur && !_fence && /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln) && !OWN_SECTIONS.test(ln)) { cur = null; rest.push(ln); continue; }
        if (cur) cur.lines.push(ln); else rest.push(ln);
      }
      const kept = [];
      for (const b of blocks) {
        if (keepSid && b.sid === keepSid) continue;
        if (kept.length >= 2) { monitorEvent("intent", "cap-evict sid:" + b.sid); continue; }   // 保2+新块1=全局至多3
        kept.push(b);
      }
      const head = kept.map((b) => b.lines.join("\n")).join("\n\n");
      return (head ? head + "\n\n" : "") + rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    }

    const INTENT_PENDING = new Map();   // v2.3.8 F2: 忙时不吞事件——每 compactionId 一槽，settle 后按序补火（size>4 逐旧）
    async function spawnIntentCheckpoint(compactionId, summaryText, fname, parentAgent, sessionId) {
      // v2.4.10：合并维护运行中同样排队（与 INTENT_RUNNING 共用 INTENT_PENDING 队列）——intent 检查点是
      // compact 中转产物、同 compactionId 不重发，被 maint 挡着时绝不能跳过只能排队；maint 结束时由
      // runMaintenanceMerge finally 补火（与自身 finally 同款 setTimeout(0) 机制）。
      if (INTENT_RUNNING || MAINT_RUNNING) {
        if (!INTENT_PENDING.has(compactionId)) {
          INTENT_PENDING.set(compactionId, { summaryText, fname, parentAgent, sessionId });
          if (INTENT_PENDING.size > 4) INTENT_PENDING.delete(INTENT_PENDING.keys().next().value);
          monitorEvent("intent", "queued " + String(compactionId).slice(0, 8) + (MAINT_RUNNING ? " while-maint" : ""));
          clog("[dsh-memory] 意图检查点：忙→入队 " + String(compactionId).slice(0, 8) + (MAINT_RUNNING ? "（合并维护进行中）" : ""));
        }
        return;
      }
      const rawSum = String(summaryText || "").trim();
      if (rawSum.length < 40) {
        clog("[dsh-memory] 意图检查点：宿主压缩摘要为空或过短（" + rawSum.length + " 字符），跳过不落盘");
        return;
      }
      INTENT_RUNNING = true;
      try {
        const subagents = ctx.get("subagents");
        if (!subagents || typeof subagents.start !== "function") {
          clog("[dsh-memory] 意图检查点：subagents 不可用，跳过");
          return;
        }
        const targetPath = MEMORY_ROOT + "/sessions/" + fname;
        const targetFull = portable(targetPath);
        let existing = "";
        try { existing = fs.readFileSync(targetFull, "utf8"); } catch (e) { existing = ""; }
        if (existing.includes("<!-- intent: " + compactionId)) return;   // 幂等：前缀匹配（marker 已带 sid 后缀）
        const sid8 = String(sessionId || "anon").replace(/^session-/, "").slice(0, 8);
        let sum = await compactOnce(subagents, parentAgent, INTENT_INSTRUCTION + smartTrim(summaryText, 20000, "sessions/" + fname + "（memory_search 可查）"), "intent-" + String(compactionId).slice(0, 8));
        if (!sum) { clog("[dsh-memory] 意图检查点：子代理无输出，跳过"); return; }
        sum = extractBodyFromMarker(sum);   // v2.5.2（F1′）：intent 同上剥前言，防 ghost 轮检查点整块丢弃（compact 不重发，后果更重）
        if (!/^##\s*本次目标/.test(sum.trim())) {   // v2.3.8 F4: 格式护栏——拒绝非检查点文本入正文（ghost 轮跑题回复曾顶替正解落盘）
          monitorEvent("intent", "malformed " + String(compactionId).slice(0, 8) + " head=[" + sum.slice(0, 30).replace(/\n/g, " ") + "]");
          cwarn("[dsh-memory] 意图检查点：输出非检查点格式，跳过落盘 " + String(compactionId).slice(0, 8));
          return;
        }
        // v2.4.12（P1）：写入端结构校验（三节/围栏/marker）——格式头已过，再验节完整与结构纯净
        {
          const vs = validateMdStructure(sum, { requireSections: true });
          if (!vs.ok) {
            monitorEvent("intent", "bad-structure " + String(compactionId).slice(0, 8) + " " + vs.errors.join("/").slice(0, 120));
            cwarn("[dsh-memory] 意图检查点：输出结构违规，跳过落盘 " + String(compactionId).slice(0, 8) + "：" + vs.errors.join(" | "));
            return;
          }
        }
        // v2.3.7 L2: 硬护栏——超 1000 只从「关键结论」尾部删整条（绝不断句、前两节不碰），埋点攒超纲率数据再定是否上重试轮
        if (sum.length > 1000) {
          const kIdx = sum.indexOf("## 关键结论");
          if (kIdx >= 0) {
            const head2 = sum.slice(0, kIdx);
            const kLines = sum.slice(kIdx).split("\n").filter((l) => l.trim() !== "");
            while (kLines.length > 2 && head2.length + kLines.join("\n").length > 1000) kLines.pop();
            const kept = (head2 + kLines.join("\n")).trim();
            monitorEvent("intent", "overshoot " + sum.length + "→" + kept.length + (kept.length > 1000 ? " residual（前两节自身超纲，交注入端 sectionAwareSlice 兜底）" : "（关键结论尾部整条删）"));
            clog("[dsh-memory] 意图检查点超纲护栏：" + sum.length + " → " + kept.length + " 字");
            sum = kept;
          }
        }
        const block = "<!-- intent: " + compactionId + " sid:" + sid8 + " -->\n\n## 检查点（目标与下一步，压缩 " + String(compactionId).slice(0, 8) + "）\n\n" + sum.trim() + "\n";
        // v0.5（step4b）：intent 归格写入——先格级 strip（stripOldIntentBlocks 已支持分格：格内保2+原位删 keepSid），
        // 再把新 block 插到目标格头（命中项目 → 项目块；未命中 → 通用块）；未分格文件 insert 内部惰性迁移建通用块。
        // 格级语义：目标格 strip 后保 2 旧 + 新 block = 每格至多 3；其他格（含 dump）不动。
        let _secKey = "";
        try {
          const _ag = parentAgent && (parentAgent.session || parentAgent);
          const _cw = _ag && ((_ag.header && _ag.header.cwd) || _ag.cwd);
          if (_cw) { const _mx = matchProjectByCwd(String(_cw)); if (_mx.hits.length > 0) _secKey = String(_mx.hits[0].key || ""); }
        } catch (eS) { _secKey = ""; }
        const _stripped = stripOldIntentBlocks(existing, sid8);
        const finalIntentText = insertIntentToSection(_stripped, block.trim(), _secKey).text;
        writeFileAtomic(targetFull, finalIntentText, { tag: "intent", verify: true });   // v0.5（step2 内容闸）：统一原子写（mkdir 随 writeFileAtomic 内部）
        // v2.4.9：落盘回读校验（与 maint 写回同款，防占位/静默失败）
        if (!readbackVerify(targetFull, finalIntentText)) {
          cwarn("[dsh-memory] 意图检查点：写回回读不一致 sessions/" + fname);
          monitorEvent("intent", "readback-mismatch " + String(compactionId).slice(0, 8));
        }
        clog("[dsh-memory] 已写入意图检查点 sessions/" + fname + "（intent " + String(compactionId).slice(0, 8) + " sid " + sid8 + "，prepend " + sum.length + " 字符）");
        try { refreshMemorySessionsIndex(); } catch (e2) {}
      } catch (e) {
        cwarn("[dsh-memory] 意图检查点失败:", e && e.message ? e.message : String(e));
      } finally {
        INTENT_RUNNING = false;
        if (INTENT_PENDING.size > 0) {
          const nxt = INTENT_PENDING.entries().next().value;
          INTENT_PENDING.delete(nxt[0]);
          setTimeout(() => { try { spawnIntentCheckpoint(nxt[0], nxt[1].summaryText, nxt[1].fname, nxt[1].parentAgent, nxt[1].sessionId); } catch (e) {} }, 0);
        }
      }
    }

    // v2.0.5: 防重入——模型反复调 stale_archive 会重复提取消息流+重复 spawn 烧 token，不信任模型自觉
    let STALE_RUNNING = false;
    // v2.3.2(archive-tool): memory_archive_checkpoint 交付状态——批初始化+累计声明集+落盘/完整性标志
    let LAST_ARCHIVE_FLOW = null;            // { sessionIds: [], todayStr, declared: Set }
    let LAST_ARCHIVE_WROTE_AT = 0;
    let LAST_ARCHIVE_A5_OK = false;
    // v2.0.9/v2.1.4: 归档节流时间戳（跨重启持久化 .integrate.json archiveLastRunAt；发起即重置、窗内一律拒绝）
    let ARCHIVE_LAST_RUN_AT = 0;
    const ARCHIVE_THROTTLE_MS = 60 * 60000;
    // v2.4.7.1（回归修复①）：发起失败短冷却——v2.4.7 把节流戳推到「全部子代理 settle」才写，
    //   于是「发起即失败」和「归档中途被重启」两种情形都完全不吃冷却窗，每次会话启动/维护检查
    //   都会把整批消息流重新提取一遍（实证：.monitor.json 一晚三次 started count=20 → failed reason=spawn）。
    //   失败不消号（下轮该重来）但仍吃 15 分短窗，避免同一环境性故障被连环白提；成功仍吃 60 分窗。
    let ARCHIVE_LAST_FAIL_AT = 0;
    const ARCHIVE_FAIL_THROTTLE_MS = 15 * 60000;
    function saveArchiveThrottle(key, val) {
      try { const st = readIntegrateState() || {}; st[key] = val; writeIntegrateState(st); } catch (e) {}
    }

    async function runStaleArchive(staleSessions) {
      // v2.1.4: 节流判断无条件（发起后 60 分内再次发起一律拒绝）
      const now = Date.now();
      if (now - ARCHIVE_LAST_RUN_AT < ARCHIVE_THROTTLE_MS) {
        monitorEvent("archive", "throttled pending=" + staleSessions.length + " lastMin=" + Math.round((now - ARCHIVE_LAST_RUN_AT) / 60000));
        return { ok: false, reason: "冷却期内（距上次归档 <60 分），本次忽略" };
      }
      // v2.4.7.1: 发起失败短冷却（跨重启生效，与成功窗互不相干）
      if (now - ARCHIVE_LAST_FAIL_AT < ARCHIVE_FAIL_THROTTLE_MS) {
        monitorEvent("archive", "throttled-fail pending=" + staleSessions.length + " lastFailMin=" + Math.round((now - ARCHIVE_LAST_FAIL_AT) / 60000));
        return { ok: false, reason: "上次归档发起失败未满 15 分，本次忽略（防环境性故障连环白提）" };
      }
      if (STALE_RUNNING) return { ok: false, reason: "上一轮漏网归档仍在进行中，本次忽略（防重复发起）" };
      STALE_RUNNING = true;
      let r;
      try {
        r = await runStaleArchiveInner(staleSessions);
      } catch (e) {
        STALE_RUNNING = false;
        ARCHIVE_LAST_FAIL_AT = Date.now(); saveArchiveThrottle("archiveLastFailAt", ARCHIVE_LAST_FAIL_AT);
        monitorEvent("archive", "failed reason=extract-throw err=" + (e && e.message ? e.message : String(e)));
        cwarn("[dsh-memory] 漏网归档发起异常:", e && e.message ? e.message : String(e));
        return { ok: false, reason: "发起异常 " + (e && e.message ? e.message : String(e)) };
      }
      // v2.4.7.1（回归修复①核心）：戳写在「子代理已发起」这一刻，不等 settle——
      //   否则「归档进行中被重启」= 戳未落盘 + 水位未消 → 新实例立即重提整批并重送子代理（真重复烧 token）。
      //   STALE_RUNNING 的复位也移到 settle 链内（见 runStaleArchiveInner 的 settle），发起前失败在此立即释放。
      if (r.ok) {
        ARCHIVE_LAST_RUN_AT = Date.now(); saveArchiveThrottle("archiveLastRunAt", ARCHIVE_LAST_RUN_AT);
      } else {
        STALE_RUNNING = false;
        if (r.whiteRun) { ARCHIVE_LAST_FAIL_AT = Date.now(); saveArchiveThrottle("archiveLastFailAt", ARCHIVE_LAST_FAIL_AT); }
      }
      return r;
    }

    async function runStaleArchiveInner(staleSessions) {
      const subagents = ctx.get("subagents");
      if (!subagents || typeof subagents.start !== "function") {
        cwarn("[dsh-memory] subagents 服务不可用，漏网归档降级为提醒");
        monitorEvent("archive", "failed reason=subagents-unavailable");
        return { ok: false, reason: "subagents 服务不可用" };
      }
      // 提取全部消息流（跳过无流的）；超上限的留待下次
      const batch = staleSessions.slice(0, MAX_ARCHIVE_SESSIONS);
      const overflow = staleSessions.length - batch.length;
      const flowSessions = [];
      const skippedNoFlow = [];
      const batchFrames = new Map(); // v2.4.3：发起时记 {frames, round}（settle 消号即写入水位账本，含无流/跳过项）
      for (const s of batch) {
        await new Promise((r2) => setImmediate(r2));
        const logPath = SESSIONS_ROOT + "/" + s.ws + "/" + s.id + "/session.jsonl.zstd";
        clog("[dsh-memory] 提取消息流 " + (flowSessions.length + skippedNoFlow.length + 1) + "/" + batch.length + ": " + s.id.slice(0, 12) + "...");
        // v2.4.3：增量重档——账本有水位且有新帧 → 只提取水位后帧；轮次 = 已归档轮 + 1
        const wm = ARCHIVE_WATERMARK.get(s.id);
        const curF = countZstdFrames(logPath);
        const isRe = !!(wm && typeof wm.frames === "number" && curF !== null && curF > wm.frames);
        const nextRound = wm ? (isRe ? (wm.round || 1) + 1 : (wm.round || 1)) : 1;
        batchFrames.set(s.id, { frames: curF, round: isRe ? nextRound : (wm ? (wm.round || 1) : 1) });
        // v2.4.7（方案C·L2b 单元缓存）：增量重档时先读缓存，只提取新增帧合并——避免重新提取/压缩全量
        const sidShort = s.id.replace(/^session-/, "").slice(0, 12);
        let unit = null;
        let isMerge = false;
        if (isRe) {
          const cached = readUnitCache(sidShort);
          const rNew = await extractMessageFlowAsync(logPath, wm.frames);
          if (cached && rNew && (rNew.flow || (rNew.segments && rNew.segments.length > 0))) {
            const newUnit = compressUnit(rNew, "");
            unit = mergeUnitCache(cached, newUnit, curF, nextRound);
            isMerge = true;
          } else if (cached) {
            unit = cached;
            isMerge = true;
          } else if (rNew && (rNew.flow || (rNew.segments && rNew.segments.length > 0))) {
            unit = compressUnit(rNew, "");
          }
        } else {
          const r3 = await extractMessageFlowAsync(logPath, 0);
          if (r3 && (r3.flow || (r3.segments && r3.segments.length > 0))) unit = compressUnit(r3, "");
        }
        if (unit && unit.text) {
          unit.sid = sidShort; unit.frames = curF; unit.round = nextRound; unit.at = Date.now();
          writeUnitCache(unit);
          flowSessions.push({ session: s, unit: unit, sampled: unit.source === "messageflow", isRe: isRe, round: nextRound });
        } else {
          skippedNoFlow.push(s.id.slice(0, 12));
        }
      }
      // v2.4.7（方案C）：删除 v1.12.18.3 逐段 spawn 子代理的 map-reduce 仿真压缩循环——
      // 该循环 16 个大会话×每会话多段≈几十次子代理调用烧巨量 token，且产出仍要进单巨型 prompt。
      // 现在 compressUnit 已在提取时完成确定性压缩（零子代理）。

      const handledIds = []; // v1.12.19: 本轮实际处置名单（送审会话 + 无流跳过），供调用方登记 ARCHIVED_SESSIONS；overflow 不在内
      skippedNoFlow.forEach((id) => {
        const s = batch.find((x) => x.id.startsWith(id));
        if (s) { STALE_NOTIFIED.add(s.id); handledIds.push(s.id); }
      });
      flowSessions.forEach((f) => handledIds.push(f.session.id));
      if (flowSessions.length === 0) {
        clog("[dsh-memory] 无可归档会话（全部无消息流，跳过 " + skippedNoFlow.length + " 个）");
        monitorEvent("archive", "settled mode=no-flow wrote=0 skipped=" + skippedNoFlow.length + " flow=0");
        // v2.4.7.1: 本路径已把整批消息流白提一遍且无流会话不消号 → 吃 15 分短窗（不改消号语义：日志稍后出现仍能重入）
        return { ok: false, whiteRun: true, reason: "全部会话无消息流", overflow: overflow };
      }
      const todayStr = dateStr(new Date());   // v2.4.25（审查 P2-6）：本地日期——原 toISOString 是 UTC，本地 00:00-08:00 归档时「补档日期」错一天
      // v2.4.7（方案C·L3 分桶）：单元 → 确定性分桶（预算 60K 字符/5 单元/批）
      const allSidShort = flowSessions.map((f) => f.session.id.replace(/^session-/, "").slice(0, 12));
      const buckets = bucketUnits(flowSessions.map((f) => ({ sid: f.session.id.replace(/^session-/, "").slice(0, 12), text: f.unit.text, chars: f.unit.chars || f.unit.text.length, sampled: !!f.sampled, isRe: !!f.isRe, round: f.round, session: f.session })));
      // v2.3.2(archive-tool): 批次状态初始化——sessionIds 为全量（所有批），declared 跨批累计，A5 全量校验
      LAST_ARCHIVE_FLOW = { sessionIds: allSidShort, todayStr: todayStr, declared: new Set(), rounds: {} };
      flowSessions.forEach((f) => { if (f.isRe && f.round > 1) LAST_ARCHIVE_FLOW.rounds[f.session.id.replace(/^session-/, "").slice(0, 12)] = f.round; });
      LAST_ARCHIVE_WROTE_AT = 0; LAST_ARCHIVE_A5_OK = false;
      const startedAt = Date.now();
      monitorEvent("archive", "started count=" + flowSessions.length + " buckets=" + buckets.length + " overflow=" + overflow);
      // v2.4.7（方案C·L4 并行结算）：每批一个子代理，并发 ARCHIVE_MAX_CONCURRENT=2；批间小并发
      // v2.4.7.1: 本函数只负责「发起」（返回 {run,label,batchIdx}），结算见 joinOneBatch / settle 链
      const startOneBatch = async (batchUnits, batchIdx) => {
        const sidList = batchUnits.map((u) => u.sid);
        const flowBlocks = batchUnits.map((f) => {
          const head = (f.sampled ? "【采样视图】" : "") + (f.isRe ? "【补档第" + f.round + "轮·仅含新增帧】" : "") + "===== 会话 " + f.session.id + "（工作目录 " + f.session.ws.slice(0, 60) + "，最后交互约 " + Math.max(1, Math.round((Date.now() - f.session.mtime) / 86400000)) + " 天前）=====\n";
          let prevAnchor = "";
          if (f.isRe) {
            const pb = extractExistingArchiveBlock(f.sid);
            if (pb) prevAnchor = "----- 已归档要点（旧结论，仅供对照去重，禁止复述或改写）-----\n" + pb + "\n\n";
          }
          return head + prevAnchor + f.text;
        }).join("\n\n");
        const shortIdList = sidList.join("\n");
        const promptText =
          "你是 dsh-memory 归档子代理（第 " + (batchIdx + 1) + "/" + buckets.length + " 批），独立完成本批 " + batchUnits.length + " 个漏网会话的记忆归档（fresh 会话，上下文只含本任务说明与本批已提取的对话消息流）。\n" +
          "**禁止读取任何原始日志文件**——消息流已足够，读原始日志会消耗巨额 token。\n" +
          "**禁止使用 write/edit 写任何文件**——落盘统一走 memory_archive_checkpoint 工具（插件现场校验+落盘；写 ~/.dsh 会被沙箱拒绝且你无审批通道）。\n" +
          "\n===== 本批待归档会话的对话消息流 =====\n" + flowBlocks + "\n" +
          "\n===== 本批会话短 id 清单（逐字取用，不得自行截取完整 uuid）=====\n" + shortIdList + "\n" +
          "\n===== 你的职权（完全自主决策）=====\n" +
          "1. 逐会话判断归档价值：无实质内容（寒暄/空会话/记忆库已覆盖）→ 跳过并在报告说明理由。\n" +
          "1b. **补档轮次会话**（块头标有【补档第N轮】并附「已归档要点」）：该会话此前已归档过，本次消息流**只含上次归档之后的新增内容**——points 只写新增部分的新事实，与旧要点重叠的一律不复述、禁止改写旧条目；确无增量价值则该会话 skip=true + 理由。sessionId 照用同一短 id，轮次落盘标记由插件生成，你不用管。\n" +
          "2. 内容少 → 你直接总结全部。\n" +
          "3. 全部提交完成后，最终输出一行处置报告（[短id] 档案已产/跳过+理由）；插件以工具提交为准。**不要输出 [ARCHIVE_BEGIN] 等检查点格式文本**。\n" +
          "4. **交付（唯一方式）**：对每个会话调用 memory_archive_checkpoint 工具提交检查点，参数 { blocks: [ { file, sessionId, title, points[], skip?, reason? } ] }：\n" +
          "   - file 只能是 sessions/|projects/ 前缀相对路径（归属日期从消息流推断，推断不出用最后交互日）；sessionId 必须从短 id 清单逐字取用；\n" +
          "   - 有价值 → 填 title + points（3-6 条要点，精确字面量（文号/路径/命令/参数/报错串/数值）逐字保留绝不概括改写；与已有归档重叠只记增量并标注）；\n" +
          "   - 无价值（寒暄/空会话/记忆库已覆盖）→ 填 skip=true + reason；\n" +
          "   - 工具会校验完整性（含缺声明会话检查）+ 落盘（追加到目标文件，条目幂等）；失败会在工具结果返回错误清单，按清单修正后再次调用，可多次调用直到全部通过。\n" +
          "5. **整批一次性交付**：全部会话处置于单次 memory_archive_checkpoint 调用（有价值全填 points / 无价值 skip）；插件按 25 分钟上限看护（v2.4.28），请勿中途长时间停顿。\n";
        const label = "dsh-memory-漏网归档-" + sidList.length + "会话-批" + (batchIdx + 1);
        try {
          const _ctrl = new AbortController();   // v2.4.28（D4）：持 controller 引用——注册到 SUBAGENT_GUARDS（原无人持有、从不 abort）
          const spawnOpts = {
            label: label,
            prompt: [{ type: "text", text: promptText }],
            signal: _ctrl.signal,
            // v2.4.7（方案C·L4）：批已按预算确定性切小 → 二级拆分不再需要；工具面 = 只读+交付（allow 白名单规避
            //   dsh-alpha 的 subagent 非 restrictable + run_code PTC 红线双坑；allow 内均为宿主确定存在的名字）
            toolFilter: { allow: ["read", "grep", "glob", "memory_search", "memory_archive_checkpoint"] }
          };
          if (LAST_TOP_AGENT) spawnOpts.parent = LAST_TOP_AGENT;
          // v2.4.7.1（回归修复②）：本函数只做「发起」——subagents.start 秒级返回，供上层判定
          //   r.ok=已发起 并当场落节流戳；run.result 的长等待移进 settle 链后台跑。发起失败抛出交调用方收集。
          const run = await subagents.start("spawn", spawnOpts);
          markPluginSubagent(run.id);   // v2.4.27：登记插件子代理 sid（A/B/C/D 提醒隔离全关，只计 monitor）
          // v2.4.28（D4 方案 B）：archive 硬停 25 分（对齐既有 race 上限）——spSid=run.id 注册，tools/result 续期
          const _g = guardRegister(String(run.id || ""), "archive", _ctrl, ARCHIVE_HARD_MS, SUBAGENT_SOFT_MS);   // v2.6.1（V0.2 P1-1）：archive 保持 10/25 现状（softMs 显式传 SUBAGENT_SOFT_MS）
          if (_g && run.id) _g._runId = run.id;
          return { run: run, label: label, batchIdx: batchIdx, ctrl: _ctrl, sid: String(run.id || "") };
        } catch (e) {
          throw new Error(label + " - " + (e && e.message ? e.message : String(e)));
        }
      };
      // v2.4.7.1: 结算段（长，后台）——等子代理跑完，成功/失败只影响 batchResults 与消号判定
      const joinOneBatch = async (h) => {
        try {
          const result = await h.run.result;
          const outText = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
          // v2.4.28（三审 P0-1）：宿主 run.result 从不 reject（abort 以 resolve-with-stopReason='aborted' 返回，
          // 同文件先例 compactOnce L3766 显式查 stopReason）——不查则 abort 批被判 ok:true + declared 跨批累计 → 复现静默消号。
          const notCompleted = result && result.stopReason && result.stopReason !== "completed";
          clog("[dsh-memory] 归档批完成（" + h.label + "，stopReason=" + (result && result.stopReason) + ", 输出 " + outText.length + " 字符" + (notCompleted ? "，非正常完成——不消号" : "") + "）");
          if (h.sid) guardClear(h.sid);   // v2.4.28（D4）：settle 注销看护
          if (notCompleted) return { ok: false, label: h.label, err: "stopReason=" + result.stopReason };
          return { ok: true, label: h.label };
        } catch (e) {
          cwarn("[dsh-memory] 归档批失败: " + h.label + " - " + (e && e.message ? e.message : String(e)));
          if (h.sid) guardClear(h.sid);   // v2.4.28（D4）：异常路径也注销
          return { ok: false, label: h.label, err: e && e.message ? e.message : String(e) };
        }
      };
      // v2.4.7.1（回归修复②）：两段式——第一段在并发上限内把所有批「发起」（秒级返回），第二段 settle 链后台「结算」。
      //   旧写法把 await Promise.all(workers)（含 await run.result）留在本函数内 → 上层 r.ok 要等子代理全部跑完，
      //   节流戳与水位也随之推迟落盘：归档中途重启 = 两者皆空 = 新实例立刻重提整批并重送子代理（真重复烧 token）。
      const handles = [];
      const startErrs = [];
      let bi = 0;
      const starters = [];
      for (let w = 0; w < Math.min(ARCHIVE_MAX_CONCURRENT, buckets.length); w++) {
        starters.push((async () => {
          while (bi < buckets.length) {
            const curIdx = bi++;
            try { handles.push(await startOneBatch(buckets[curIdx], curIdx)); }
            catch (e) { startErrs.push(e && e.message ? e.message : String(e)); }
          }
        })());
      }
      await Promise.all(starters);
      if (handles.length === 0) {
        monitorEvent("archive", "failed reason=spawn err=" + (startErrs[0] || "?"));
        cwarn("[dsh-memory] 漏网归档子代理全部发起失败（" + startErrs.length + " 批）：" + (startErrs[0] || ""));
        return { ok: false, whiteRun: true, reason: "子代理发起失败", overflow: overflow };   // whiteRun=本轮已白提 → 吃 15 分短窗；不消号，下轮重来
      }
      if (startErrs.length > 0) cwarn("[dsh-memory] " + startErrs.length + " 批子代理发起失败（其会话本轮不消号，留待下轮）: " + startErrs[0]);
      // v2.4.7.1: settle 链（后台）——等已发起的批全部跑完 → A5 全量判定 → 消号；session-start 调用方不 await 本链
      const settle = (async () => {
        try {
          const batchResults = await Promise.all(handles.map((h) => joinOneBatch(h)));
          // v2.4.7（方案C·L5 A5 聚合）：全部批 settle 后按全量判定（发起失败的批同样计不完整）
          const allOk = batchResults.every((r) => r.ok) && startErrs.length === 0;
          if (!allOk) monitorEvent("archive", "settled mode=batch-partial-fail ok=" + batchResults.filter((r) => r.ok).length + "/" + buckets.length);
          // v2.4.7.2（静默消号修复）：doneOk 必须满足 allOk——任一子代理被中断/失败（joinOneBatch ok:false）
          // 或任一发起失败（startErrs>0）时一律不消号。旧版只看 LAST_ARCHIVE_WROTE_AT/A5：
          // 只要有一批成功落盘（LAST_ARCHIVE_WROTE_AT 更新）且 A5 声明全覆盖，handledIds 全批消号，
          // 被打断子代理负责的会话（未落盘）也被记入账本+水位 → 永不再进漏网（静默丢失，实测 2026-09-01 12:44:54）。
          const doneOk = allOk && LAST_ARCHIVE_WROTE_AT >= startedAt && LAST_ARCHIVE_A5_OK;
          const archNote = doneOk
            ? "落盘+A5 完整性通过"
            : (!allOk
                ? (startErrs.length > 0 ? "有 " + startErrs.length + " 批发起失败——不消号留待下轮" : "有批子代理未正常完成（interrupted/failed）——不消号留待下轮")
                : (LAST_ARCHIVE_WROTE_AT >= startedAt ? "已落盘但 A5 未全覆盖（缺声明会话）——不消号留待下轮" : "未通过 memory_archive_checkpoint 落盘任何文件——留待下轮"));
          monitorEvent("archive", "settled mode=" + (doneOk ? "tool-ok" : !allOk ? "batch-fail" : "tool-incomplete") + " wrote=" + (LAST_ARCHIVE_WROTE_AT >= startedAt ? "Y" : "N") + " ok=" + doneOk + (allOk ? "" : " allOk=false"));
          if (!doneOk) cwarn("[dsh-memory] " + archNote);
          if (doneOk) {
            try { handledIds.forEach((id) => { ARCHIVED_SESSIONS.add(id); const m = batchFrames.get(id); if (m && typeof m.frames === "number") ARCHIVE_WATERMARK.set(id, { frames: m.frames, round: m.round, at: Date.now() }); }); ARCHIVE_WM_DIRTY = false; saveStaleNotified(); } catch (e) {}
            try {
              const remain = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt()).filter((s) => !sessionMentionedInMemory(s.id) && archivePendingEntry(s)).length;
              if (HOST_SETTINGS_SCOPE && typeof HOST_SETTINGS_SCOPE.update === "function") HOST_SETTINGS_SCOPE.update({ staleCount: remain }).catch(() => {});
              saveStaleNotified();
            } catch (e) {}
            try {
              const stI = readIntegrateState() || {};
              if (!stI.lastIntegrateAt || Date.now() - stI.lastIntegrateAt > 86400000) clog("[dsh-memory] 本轮新增摘要可用 /dream 整合进全局记忆。");
            } catch (e) {}
          }
          clog("[dsh-memory] 漏网归档完成: " + buckets.length + " 批/" + flowSessions.length + " 会话（" + archNote + "）");
          const sdir2 = findNewestSpawnedSession(startedAt);
          if (sdir2) {
            const u2 = summarizeSubagentUsage(sdir2);
            if (u2) { clog("[dsh-memory] 归档消耗: 总输入 " + (u2.totalIn || u2.input) + " tokens（其中缓存命中 " + u2.cache + "）| 输出 " + u2.output + (u2.reasoning > 0 ? " | 推理 " + u2.reasoning : "") + " tokens | 总时长 " + u2.durMin + " 分钟"); trackMaintain("arch", u2); }
          }
          // v2.4.7.1: done 的 resolve 值给 runDreamPipeline 的 Promise.race([r.done, 25min]) 直接可读
          return doneOk ? "已落盘+A5通过" : (!allOk ? "批失败未消号（留待下轮）" : (LAST_ARCHIVE_WROTE_AT >= startedAt ? "已落盘但A5未全覆盖" : "未落盘"));
        } catch (e) {
          monitorEvent("archive", "settled mode=exception err=" + (e && e.message ? e.message : String(e)));
          cwarn("[dsh-memory] 漏网归档结算异常:", e && e.message ? e.message : String(e));
          return "结算异常";
        } finally {
          STALE_RUNNING = false;   // v2.4.7.1: 互斥随结算链复位（发起段返回后仍有子代理在途，期间禁止二次发起）
        }
      })();
      return { ok: true, count: flowSessions.length, overflow: overflow, done: settle, handled: handledIds, started: handles.length, startFailed: startErrs.length };
    }

    function stabilize(text) {
      if (!text) return null;
      return text
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          if (/^>\s*最后更新/.test(t)) return false;
          if (/^>\s*Last updated/.test(t)) return false;
          if (/^<!--/.test(t) || /^-->$/.test(t)) return false;
          return true;
        })
        .join("\n");
    }

    // 日期格式 YYYY-MM-DD（本地时区）
    function dateStr(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }

    // 探测最近会话摘要：今天→回溯 7 天，第一个存在的文件
    async function latestSessionSummary() {
      const now = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const fname = dateStr(d) + ".md";
        const text = await readText(MEMORY_ROOT + "/sessions/" + fname);
        if (text) {
          // v2.3.3: 剥离 compaction 原始英文 dump（宿主压缩摘要直写块）——那是给压缩重建看的历史 log，
          // 与 intent 检查点同源重复、信息密度低，参与注入只会挤占预算挤掉当日真实工作摘要。
          return { file: fname, text: stripCompactionDumps(text), isToday: i === 0 };   // v2.4.17：当日标记（降噪分路用）
        }
      }
      return null;
    }

    // v2.4.12（评审 P0 共享）+ v2.4.28：统一代码围栏状态机已提级到模块级（见 budgetOf 后 fenceStep）——
    // stripCompactionDumps / extractCompactionDumps / mechanicalConverge / validateMdStructure 共用同一模块级实现，
    // 消灭内联拷贝（评审：任何一处独立改都会造成「两端口径漂移」；行是否保留由调用方自决，本函数只负责状态）。
    // 语义：``` / ~~~ 开头（≥3 个）即翻转围栏；类型不匹配（``` 开 ~~~ 关）同样翻转；返回 [newFence, isFenceLine]。
    // 闭包内不再声明（原 L4752 删除），自动读模块级 fenceStep。

    // v2.4.12（评审 P1）：写入端结构校验器——大模型内容落盘前把关，规则与解析端同源（复用 fenceStep）。
    // 返回 { ok:true } 或 { ok:false, errors:[...] }（精确错误清单，供反馈闭环让子代理修正）。
    // 注意：这是「通用加固」，防的是未来写入污染（marker/未闭合围栏/结构破坏）；09-01 topic-lost 事故
    // 本身是解析端启发式误判，已由 v2.4.11 fence 修复拦下，本校验器不背那口锅。
    function validateMdStructure(text, opts) {
      const o = opts || {};
      const errors = [];
      const lines = String(text || "").split("\n");
      // ① 围栏闭合：复用解析端同款 fenceStep——写入端/解析端口径一致
      let fence = null;
      for (const ln of lines) { fence = fenceStep(ln, fence)[0]; }
      if (fence !== null) errors.push("代码围栏未闭合（围栏字符 " + fence + "）");
      // ② 裸 marker：正文出现 <!-- compaction: / <!-- intent: 行（围栏外）会让解析端误判新块/新 dump
      fence = null;
      let inFenceLine = false;
      for (let i = 0; i < lines.length; i++) {
        const fs2 = fenceStep(lines[i], fence);
        inFenceLine = fs2[1];
        fence = fs2[0];
        if (fence || inFenceLine === false) {
          // 围栏外（且非围栏行本身）才查裸 marker
        }
        if (fence || inFenceLine) continue;   // 围栏内/围栏行豁免
        if (/^\s*<!-- compaction: /.test(lines[i])) errors.push("第 " + (i + 1) + " 行出现裸 <!-- compaction: marker");
        if (/^\s*<!-- intent: /.test(lines[i])) errors.push("第 " + (i + 1) + " 行出现裸 <!-- intent: marker");
      }
      // ③ 三节完整性（requireSections: true 时）：本次目标/下一步行动/关键结论 齐全 + 顺序 + 非空
      if (o.requireSections) {
        const heads = [];
        const SECT = /^##\s*本次目标\s*$|^##\s*下一步行动\s*$|^##\s*关键结论\s*$/;
        for (let i = 0; i < lines.length; i++) {
          if (SECT.test(lines[i])) heads.push({ i: i, name: lines[i].replace(/^##\s*/, "").trim() });
        }
        const order = ["本次目标", "下一步行动", "关键结论"];
        const got = heads.map((h) => h.name);
        if (got.join("|") !== order.join("|")) errors.push("三节缺失或乱序（实际: " + (got.length ? got.join(" → ") : "无") + "）");
        // 各节非空：节头到下一节头之间的内容须有非空行
        for (let k = 0; k < heads.length; k++) {
          const start = heads[k].i + 1;
          const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
          const body = lines.slice(start, end).join("\n").trim();
          if (!body) errors.push("「" + heads[k].name + "」节为空");
        }
      }
      // ④ points 行校验（pointsOnly: true 时）：每条非空单行、不以结构行开头、长度 ≤200
      if (o.pointsOnly) {
        for (const p of Array.isArray(o.points) ? o.points : []) {
          if (typeof p !== "string" || !p.trim()) { errors.push("要点为空或非字符串"); continue; }
          if (p.includes("\n")) errors.push("要点禁止换行: " + String(p).slice(0, 40) + "…");
          if (/^#|^<!--/.test(p.trim())) errors.push("要点以结构行开头: " + String(p).slice(0, 40) + "…");
          if (p.length > 200) errors.push("要点超长（>200 字符）: " + p.slice(0, 40) + "…");
        }
        // title 同规（归档块头 ### sid（title）拼接源）
        if (typeof o.title === "string" && o.title) {
          if (o.title.includes("\n")) errors.push("title 禁止换行");
          if (o.title.includes("<!--") || o.title.includes("###")) errors.push("title 含结构标记: " + o.title.slice(0, 40));
        }
      }
      // ⑤ 项目文件结构（projectMode: true 时）：6 保留节须存在（可空）；「## 归档/## 漏网会话补档」内允许 ###，其它节裸 ### 拦截；围栏内豁免
      if (o.projectMode) {
        const PROJ_SECTS = ["Rules", "Architecture decisions", "Gotchas", "Discovered durable knowledge", "当前状态与下一步", "归档"];
        const present = new Set();
        let curSection = "（文件头）";
        const h3Bad = [];
        let fence5 = null;
        for (const _l of String(text || "").split("\n")) {
          const fs5 = fenceStep(_l, fence5);
          fence5 = fs5[0];
          if (fence5 || fs5[1]) continue;
          const h2 = /^##\s+(\S.*)$/.exec(_l);
          if (h2) { curSection = h2[1].replace(/（.*$/, "").trim(); present.add(curSection); continue; }
          if (/^###\s/.test(_l) && !/^(归档|漏网会话补档)/.test(curSection)) h3Bad.push(_l.trim().slice(0, 40));
        }
        for (const req of PROJ_SECTS) { if (!present.has(req)) errors.push("projectMode: 缺保留节 ## " + req); }
        if (h3Bad.length) errors.push("projectMode: 非「归档/漏网会话补档」节内出现裸 ###: " + h3Bad[0] + (h3Bad.length > 1 ? " 等 " + h3Bad.length + " 处" : ""));
      }
      return errors.length ? { ok: false, errors: errors } : { ok: true };
    }

    // v2.3.3: 剥离 compaction 原始 dump 块（详见 latestSessionSummary）——纯文本变换，供注入/超限检查统一使用
    function stripCompactionDumps(text) {
      const lines = String(text || "").split("\n");
      const out = [];
      let skip = false;
      // v2.4.11：代码围栏感知——dump 资产常含 ```yaml/js 代码块，块内 `# ──` 等注释行/中文 H2 会被
      //   误判为「边界」提前终止剥离（实证 2026-09-01：cyberpunk 安装归档 74 行泄漏进注入面→topic-lost 3 连败）。
      //   进 ```/~~~ 围栏后不再判边界（fence 内所有行按 dump 内/外原逻辑走，不做标题解析）。
      let fence = null;
      for (const ln of lines) {
        const isMarker = /^\s*<!-- /.test(ln);
        const isH1 = /^#\s/.test(ln);
        // v2.3.5: dump 全文归档后节名不可枚举——块内英文 H2 一律视作 dump 正文，中文 H2/H1/marker 才是边界
        const isEnH2 = /^##\s*[A-Za-z]/.test(ln);
        const isOtherH2 = /^##\s/.test(ln) && !isEnH2;
        // v2.4.12：围栏翻转共用一个状态机
        const fs2 = fenceStep(ln, fence);
        fence = fs2[0];
        // v2.4.11：围栏内一律按 skip 状态走、绝不判边界/绝不被 marker 误入或误出 skip
        if (fence) {
          if (skip) continue;
          out.push(ln);
          continue;
        }
        if (!skip) {
          if (/^\s*<!-- compaction: /.test(ln)) { skip = true; continue; }
          out.push(ln);
          continue;
        }
        // 在 compaction dump 块内：吞普通行 + 英文 H2（v2.3.5 全文归档后节名不可枚举）；遇边界（marker / H1 / 中文 H2）停止吞
        // v2.4.2.2：合并写回后 dump 块相邻（中间无中文 H2 分隔）——skip 中再遇 compaction marker 必须继续吞，
        //   否则其 dump 正文全泄漏进注入面（实测 31269 字符→超阈提醒+合并维护被反复误触发）
        if (/^\s*<!-- compaction: /.test(ln)) continue;
        if (isMarker || isH1 || isOtherH2) { skip = false; out.push(ln); }
      }
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    }

    // v7：UTF-8 字节数（沙箱无 Buffer，用 TextEncoder）
    function utf8Bytes(text) {
      try {
        return new TextEncoder().encode(text).length;
      } catch (e) {
        return text.length;
      }
    }

    // v7：软性维护阈值（字节，超过=该整理了，仅告警不截断）——常量已提级到模块级（见 PROJECT_CHAR_SOFT 后，CHAR_LIMIT/SIZE_WARN 同源注释）
    const ROTATE_DAYS = 30;

    // v2.5（P2）：记忆文档状态汇总（只读）——逐文件 字符/字节/软硬阈值/超限标记/最后更新/过期复核（>180 天）。
    // 口径：排除点文件（.json 状态账本）；sessions 只列今日与最近 3 份；层名按目录归纳。
    function buildMemoryDocStatus() {
      const docSections = [];
      const cutoff = Date.now() - 180 * 86400000;
      const collected = [];
      const addFile = (rel, layer) => {
        try {
          const full = portable(MEMORY_ROOT + "/" + rel);
          const stt = fs.statSync(full);
          const text = fs.readFileSync(full, "utf8");
          const bytes = utf8Bytes(text);
          // v2.4.22（面板口径修正，用户拍板「按实际情况」）：会话层（今日/历史）字符按注入面同源——
          //     strip compaction dump 资产后再计数/判硬超；dump 不进注入面（latestSessionSummary 先 strip 再 slice 1500），
          //     全文计字符会把 09-02.md 的 5 组宿主 dump 误标「硬超」。字节(全文)仍保留作文件大小事实。
          const _stripTxt = layer.indexOf("会话层") === 0 ? stripCompactionDumps(text) : null;
          const layerChars = _stripTxt ? _stripTxt.length : text.length;
          const layerBytes = _stripTxt ? utf8Bytes(_stripTxt) : bytes;
          const key = rel === "global.md" ? "global.md" : rel === "index.md" ? "index.md" : "summary";
          const byteWarn = SIZE_WARN[key] !== undefined ? SIZE_WARN[key] : SIZE_WARN.summary;
          const charLimit = CHAR_LIMIT[key] !== undefined ? CHAR_LIMIT[key] : CHAR_LIMIT.summary;
          // 过期复核：解析文件头「最后更新」日期行（>180 天）
          let stale = false;
          try {
            const stampLine = (text.split("\n").slice(0, 8).find((l) => /最后更新|更新日期|[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(l)) || "");
            const dm = stampLine.match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
            if (dm) { const dt = new Date(dm[1], dm[2] - 1, dm[3]).getTime(); if (dt < cutoff && dt > 0) stale = true; }
          } catch (e0) {}
          collected.push({ rel, layer, bytes, chars: layerChars, byteWarn, charLimit, overSoft: layerBytes > byteWarn, overHard: layerChars > charLimit, mtime: stt.mtimeMs, stale });
        } catch (e) {}
      };
      // 稳定层 + 工具层 + 项目层 + 知识层
      addFile("global.md", "稳定层"); addFile("index.md", "稳定层");
      for (const tool of safeLs("tools")) addFile("tools/" + tool, "工具层");
      for (const proj of safeLs("projects")) addFile("projects/" + proj, "项目层");
      for (const kn of safeLs("knowledge")) addFile("knowledge/" + kn, "知识层");
      // 会话层：今日 + 最近 3 份（按 mtime）
      try {
        const todayName = dateStr(new Date()) + ".md";
        const sess = safeLs("sessions").filter((f) => f.endsWith(".md") && f !== todayName);
        sess.sort((a, b) => { const sa = fs.statSync(portable(MEMORY_ROOT + "/sessions/" + a)).mtimeMs, sb = fs.statSync(portable(MEMORY_ROOT + "/sessions/" + b)).mtimeMs; return sb - sa; });
        const picks = sess.slice(0, 3);
        addFile("sessions/" + todayName, "会话层（今日）");
        for (const f of picks) addFile("sessions/" + f, "会话层");
      } catch (e) {}
      // 按层归组
      const byLayer = {};
      for (const d of collected) { (byLayer[d.layer] = byLayer[d.layer] || []).push(d); }
      for (const layer of Object.keys(byLayer)) docSections.push({ layer, docs: byLayer[layer] });
      return docSections;
    }
    // 目录安全读取（点文件/状态账本排除）
    function safeLs(rel) {
      try {
        return fs.readdirSync(portable(MEMORY_ROOT + "/" + rel))
          .filter((f) => !f.startsWith(".") && f.endsWith(".md") && !f.endsWith(".bak.md") && !f.startsWith("archive"));
      } catch (e) { return []; }
    }
    // v2.5（P2）：pending-lessons 汇总（只读）——供面板只读展示 + 清空入口状态
    function buildPendingLessonsSummary() {
      try {
        if (PLUGIN_CFG.regressionEnabled === false) return { enabled: false, count: 0, entries: [] };
        const P = readLessonPending();
        // v2.4.14(panel)：台账只看 open/resolved（archived=已沉淀/已归档从列表消失）；error/solution 不再截断（原 80/120 致悬停残缺）
        const entries = (P.entries || [])
          .filter((e) => e.state === "open" || e.state === "resolved")
          .map((e) => ({
            sig: e.sig, sessionId: e.sessionId, state: e.state, capturedAt: e.capturedAt,
            lastSeenAt: e.lastSeenAt, cleanSteps: e.cleanSteps,
            error: String((e.context && e.context.error) || ""),
            solution: e.solution && e.solution.summary ? String(e.solution.summary) : null,
          })).slice(-50);
        return { enabled: true, count: entries.length, entries };
      } catch (e) { return { enabled: true, count: 0, entries: [] }; }
    }

    // v10.2：超限检查（只读）——返回软/硬双轨完整报告，供注入提醒使用
    // v2.4.4（A）：summary 计数与合并维护触发同口径——剥 intent 检查点块（那是 compact 中转产物、会被合并子代理吸收，
    //   不占真实要点面）；否则 3 块 intent（~2700 字符）会撑出虚高超限（实证 2026-08-31：真实 646 / 上报 3526）。
    //   并附加 isToday 标记，供提醒文案区分「当日摘要自动收敛 / 非当日需人工」。
    async function checkSizeOverflow() {
      const issues = [];
      const check = async (label, key, raw) => {
        if (!raw) return null;
        const bytes = utf8Bytes(raw);
        const chars = raw.length;
        const byteWarn = SIZE_WARN[key] !== undefined ? SIZE_WARN[key] : SIZE_WARN.summary;
        const charLimit = CHAR_LIMIT[key] !== undefined ? CHAR_LIMIT[key] : CHAR_LIMIT.summary;
        // 软超（字节>软阈值）或硬超（字符>硬预算）都提示；标注是否已截断
        if (bytes > byteWarn || chars > charLimit) {
          return { label, key, bytes, byteWarn, chars, charLimit, truncated: chars > charLimit };
        }
        return null;
      };
      const globalRaw = await readText(MEMORY_ROOT + "/global.md");
      const indexRaw = await readText(MEMORY_ROOT + "/index.md");
      const g = await check("global.md", "global.md", globalRaw);
      if (g) issues.push(g);
      const i = await check("index.md", "index.md", indexRaw);
      if (i) issues.push(i);
      const latest = await latestSessionSummary();
      if (latest && latest.text) {
        // v2.4.4（A）：剥 intent 块后计数（与 needMaintenanceMerge/注入面收敛口径一致）
        const surfaceTxt = stripIntentBlocksForCount(latest.text);
        const s = await check("最近摘要 " + latest.file, "summary", surfaceTxt);
        if (s) {
          s.isToday = latest.file === dateStr(new Date()) + ".md";
          s.file = latest.file;   // v0.5.2：供提醒逻辑按文件名匹配 maintRetry.day
          issues.push(s);
        }
      }
      return issues;
    }

    // v7：sessions/ 轮转——超过 30 天的日期摘要复制到 archive/ 并清空原文件
        // v9：sessions/ 轮转检查（只读）——返回超过 ROTATE_DAYS 天的日期摘要文件列表
    async function findOldSessions() {
      try {
        let entries = null;
        // v2.4.25（审查 P2-5）：ctx.fs 沙箱拒读时 node:fs 直读兜底（对齐 readText 双通道）——否则轮转提醒在沙箱环境永久静默
        try {
          const target = await ctx.fs.resolve(MEMORY_ROOT + "/sessions");
          entries = await ctx.fs.listDir(target);
        } catch (e1) {
          entries = fs.readdirSync(portable(MEMORY_ROOT + "/sessions"), { withFileTypes: true }).map((x) => ({ name: x.name, type: x.isFile() ? "file" : "dir" }));
        }
        const now = Date.now();
        const cutoff = ROTATE_DAYS * 24 * 3600 * 1000;
        const old = [];
        for (const entry of entries) {
          const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(entry.name);
          if (!m || entry.type !== "file") continue;
          const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          if (now - d.getTime() <= cutoff) continue;
          const content = await readText(MEMORY_ROOT + "/sessions/" + entry.name);
          if (content) old.push({ name: entry.name, bytes: utf8Bytes(content) });
        }
        return old;
      } catch (e) {
        cerr("[dsh-memory] 轮转检查失败:", e && e.message ? e.message : String(e));
        return [];
      }
    }

    // v0.5（step3 轮转自执行，2026-09-03 N1）：sessions/ 轮转插件自执行——替代 v9「提醒模型 cp/截断」。
    // 与通道闸（tools/pre-execute deny 直写）兼容：本函数纯 node:fs 不经 write 工具，不受闸影响。
    // 语义对齐 v9（L4897-4899）：复制到 sessions/archive/ + 原文件清空；附加：单文件失败不中断整批、回读校验清空生效。
    function rotateSessions(oldList) {
      const archived = []; const failed = [];
      for (const old of oldList || []) {
        const name = String(old.name || "");
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) { failed.push(name + "(非日期文件跳过)"); continue; }
        const srcFull = portable(MEMORY_ROOT + "/sessions/" + name);
        const arcDir = portable(MEMORY_ROOT + "/sessions/archive");
        try {
          fs.mkdirSync(arcDir, { recursive: true });
          const arcFull = arcDir + "/" + name;
          fs.copyFileSync(srcFull, arcFull);
          // 原文先读（复制后清空，防占位/并发读到空）
          fs.writeFileSync(srcFull, "", "utf8");
          const back = fs.readFileSync(srcFull, "utf8");
          if (back !== "") { failed.push(name + "(清空回读不一致)"); continue; }
          archived.push(name);
        } catch (e) {
          failed.push(name + "(" + (e && e.message ? e.message : String(e)).slice(0, 40) + ")");
        }
      }
      return { archived, failed };
    }

    // v2.2.5：检索候选集重构——「目录扫描为底座，index.md 解析仅作 label 增强」。
    // 根因（08-26 实测复现）：index.md 改为「一行多条目｜分隔」紧凑格式且 knowledge 文件名省略 .md 后缀后，
    //   旧正则 ^-\s*(.+?)\s*→\s*(?:(tools|knowledge)\/)?([^\s（(]+?\.md) 全线失配：26 行索引仅解析出 3 条且路径全错，
    //   → knowledge/ 下全部 MEMORY-*.md 不在候选集，按索引词搜索必然 0 命中（索引→检索断链）。
    // 原则（对齐"能代码约束的就不靠模型自觉"）：检索层自持——磁盘上有什么就搜什么，不依赖索引文件的书写格式；
    //   index.md 退化为导航文档，其「主题→文件名」仅在 basename 能对应上真实文件时用于覆盖 label（中文主题词提升排序）。
    async function listMdNames(relDir) {
      try {
        const resolved = await ctx.fs.resolve(MEMORY_ROOT + (relDir ? "/" + relDir : ""));
        const entries = await ctx.fs.listDir(resolved);
        return entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
      } catch (e) {
        // v2.2.5：node:fs 兜底（与 readText 双通道同理）
        try { return fs.readdirSync(portable(MEMORY_ROOT + (relDir ? "/" + relDir : ""))).filter((n) => n.endsWith(".md")); } catch (e2) { return []; }
      }
    }
    async function loadKnowledgeTargets() {
      const out = new Map();
      const put = (file, label) => { if (!out.has(file)) out.set(file, { label, file }); };
      // 底座 1：knowledge/ 全部知识文件（label 去 MEMORY- 前缀）
      for (const name of await listMdNames("knowledge")) put("knowledge/" + name, name.replace(/^MEMORY-(?=[\u4e00-\u9fffA-Za-z0-9])/, "").replace(/\.md$/, ""));   // v2.4.25（审查 P2-4）：仅去掉带内容前导 MEMORY-；MEMORY.md 显示名保留为 MEMORY
      // 底座 2：tools/ 与 projects/
      for (const name of await listMdNames("tools")) put("tools/" + name, name.replace(/\.md$/, ""));
      for (const name of await listMdNames("projects")) put("projects/" + name, name.replace(/\.md$/, ""));
      // 底座 3：根目录 global/index（与 fixedTargets 按 file 去重，fixed 优先）
      put("global.md", "全局画像");
      put("index.md", "记忆索引");
      // 底座 4：sessions/ 近 7 天——0 结果引导文案承诺"查会话/sessions"，此前候选集里根本没有（断链三）
      const sessCutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const name of await listMdNames("sessions")) {
        const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
        if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() >= sessCutoff) put("sessions/" + name, "会话摘要 " + name.slice(0, 10));
      }
      // 增强：index.md 解析出的中文主题词按 basename 对应覆盖 label；
      //   兼容「一行多条目｜分隔」与省略 .md 后缀两种书写；对应不上真实文件的条目直接丢弃（不再产生幽灵候选）。
      try {
        const indexText = await readText(MEMORY_ROOT + "/index.md");
        if (indexText) {
          for (const line of indexText.split("\n")) {
            for (const seg of line.split("｜")) {
              const m = /^(?:-\s*)?(.+?)\s*→\s*([^\s（）()|]+?)\s*$/.exec(seg.trim());
              if (!m) continue;
              const base = m[2].split("/").pop().toLowerCase().replace(/\.md$/, "");
              if (!base) continue;
              for (const t of out.values()) {
                if (t.file.split("/").pop().toLowerCase().replace(/\.md$/, "") === base) t.label = m[1].trim();
              }
            }
          }
        }
      } catch (e) {}
      return [...out.values()];
    }

    // v12：Unicode 分词（\p{L} 支持中文，\p{N} 数字，_ 下划线；其余为分隔符）
    // 参考 mimocode fts-query.ts：查询和正文按同一规则分词。
    // 增强（v12.1）：CJK 与 ASCII 混合串拆词——"OA日志"→["OA","日志"]、"ssl证书"→["ssl","证书"]，
    //   否则混合串作为整体 token 无法命中正文里的"日志填写"/"SSL"。
    //   v12.3：中文连续段拆分策略（防常见 bigram 噪音）：
    //   - 1 字：保留（召回补充，正文权重 0.1）
    //   - 2 字：保留原样（高权重）+ 补 2 个单字（"签到"→["签到","签","到"]，召回"签字单"）
    //   - 3+ 字：保留完整段 + 首 2 字 + 尾 2 字（"长沙项目"→["长沙项目","长沙","项目"]）。
    //     不做中间滑动 bigram——"存在""系统""情况"等常见 2 字对在正文高频出现会污染所有文件
    function tokenize(text) {
      const raw = text.match(/[\p{L}\p{N}_]+/gu) || [];
      const out = [];
      for (const block of raw) {
        const parts = block.split(/(?<=[\u4e00-\u9fff\u3400-\u4dbf])(?=[^\u4e00-\u9fff\u3400-\u4dbf])|(?<=[^\u4e00-\u9fff\u3400-\u4dbf])(?=[\u4e00-\u9fff\u3400-\u4dbf])/);
        for (const p of parts) {
          if (!p) continue;
          if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(p)) {
            if (p.length === 1) {
              out.push(p);
            } else if (p.length === 2) {
              out.push(p);
              out.push(p[0]);
              out.push(p[1]);
            } else {
              out.push(p);
              out.push(p.slice(0, 2));
              out.push(p.slice(-2));
            }
          } else {
            out.push(p);
          }
        }
      }
      return out.filter((t) => t.length > 0);
    }

    // v12：简易 TF 加权评分（不引入 SQLite，纯扫描打分）——参考 mimocode BM25 + 相对分数下限思路：
    //   - label/文件名命中 token：权重高（+2.0/+1.5），主题名命中几乎必相关
    //   - 正文每命中一行 +0.5（snippet 用），最多计 8 行防长文件刷分
    //   - 单字符 token 过滤（"的""了"等噪音）
    function scoreTarget(t, text, tokens) {
      const labelLower = (t.label || "").toLowerCase();
      const fileLower = (t.file || "").toLowerCase();
      const textLower = text.toLowerCase();
      let score = 0;
      const hitLines = [];
      const lines = text.split("\n");
      for (const tk of tokens) {
        const tok = tk.toLowerCase();
        // 单字符过滤：ASCII 单字符（a/b/c）是噪音；中文单字（2字词补充的召回 token）保留但正文权重降为 0.2
        const isCjkChar = /^[\u4e00-\u9fff\u3400-\u4dbf]$/.test(tok);
        if (tok.length < 2 && !isCjkChar) continue;
        let tokenScore = 0;
        if (labelLower.includes(tok)) tokenScore += isCjkChar ? 1.0 : 2.0;
        if (fileLower.includes(tok)) tokenScore += isCjkChar ? 0.8 : 1.5;
        if (textLower.includes(tok)) tokenScore += isCjkChar ? 0.1 : 0.5;
        if (tokenScore === 0) continue;
        score += tokenScore;
        for (const line of lines) {
          if (hitLines.length >= 8) break;
          const lt = line.trim();
          if (lt && line.toLowerCase().includes(tok) && !hitLines.includes(lt)) {
            hitLines.push(lt.slice(0, 80));
          }
        }
      }
      return { score, hitLines };
    }

    // v12：知识文件过期复核（只读）——解析文件头"最后更新: YYYY-MM-DD"，
    //   超过 STALE_DAYS 天未更新的文件列入提醒清单（内容级过期信号，替代不可用的 mtime）。
    //   无日期标记的文件不提醒（不强制标注）；最多返回 5 个最旧的。
    const STALE_DAYS = 180;
    async function checkStaleKnowledge() {
      const targets = await loadKnowledgeTargets();
      const stale = [];
      for (const t of targets) {
        // v2.2.5：t.file 已含相对 MEMORY_ROOT 的目录前缀，直接拼接
        const text = await readText(MEMORY_ROOT + "/" + t.file);
        if (!text) continue;
        const m = text.match(/最后更新[:：]\s*(\d{4})-(\d{2})-(\d{2})/);
        if (!m) continue;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const ageDays = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
        if (ageDays > STALE_DAYS) {
          stale.push({ file: t.file, label: t.label, ageDays });
        }
      }
      return stale.sort((a, b) => b.ageDays - a.ageDays).slice(0, 5);
    }

    // v2.2.6：检索层启动自检——「数据源格式漂移 → 解析方静默失配」的事故防线（08-26 v2.2.5 教训：
    //   index.md 改紧凑格式后两个解析方静默空转，靠用户恰好查记忆才暴露）。三探针与 _test-retrieval.cjs 同源：
    //   ①A 类关键词表非空无脏 ②候选集覆盖磁盘 .md 实数 ③索引词抽样搜索对账（预期文件须进前3）。
    // 结果写模块级 RETRIEVAL_SELF：cerr 即时告警；监控汇总与 memory_search 零结果文案自动携带诊断——无人值守，不依赖任何人记得跑测试。
    async function runRetrievalSelfCheck() {
      const problems = [];
      const detail = { targets: 0, table: 0, hit: 0, checked: 0 };
      try {
        // P1 A 类提醒关键词表
        const table = buildMemoryHintTable();
        detail.table = table.length;
        if (table.length === 0) problems.push("A类提醒关键词表为空（index.md 行解析全部失配？）");
        else {
          const dirty = table.filter((r) => /[｜→]/.test(r.file));
          if (dirty.length > 0) problems.push("A类表 file 含脏字符｜→（解析吃不下多段格式）：例 " + String(dirty[0].file).slice(0, 40));
        }
        // P2 检索候选集覆盖磁盘实数
        const targets = await loadKnowledgeTargets();
        detail.targets = targets.length;
        let diskCount = 0;
        for (const sub of ["knowledge", "tools", "projects"]) {
          try {
            const resolved = await ctx.fs.resolve(MEMORY_ROOT + "/" + sub);
            const entries = await ctx.fs.listDir(resolved);
            diskCount += entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).length;
          } catch (e) {}
        }
        if (targets.length < diskCount) problems.push("检索候选集 " + targets.length + " < 磁盘知识文件 " + diskCount + "（目录扫描漏收录）");
        // P3 索引词抽样搜索对账（前 8 对；文本一次性读缓存防重复 IO）
        const idxText = await readText(MEMORY_ROOT + "/index.md");
        if (idxText) {
          const pairs = [];
          for (const line of idxText.split("\n")) {
            for (const seg of line.split("｜")) {
              const m = seg.trim().match(/^(?:-\s*)?(.+?)\s*→\s*([^\s（）()|]+)$/);
              if (m && !m[2].includes("/")) pairs.push({ word: m[1].trim(), base: m[2].replace(/\.md$/i, "").toLowerCase() });
            }
          }
          const cache = new Map();
          detail.checked = Math.min(pairs.length, 8);
          for (const p of pairs.slice(0, detail.checked)) {
            const tokens = tokenize(p.word);
            const results = [];
            for (const t of targets) {
              if (!cache.has(t.file)) cache.set(t.file, await readText(MEMORY_ROOT + "/" + t.file) || "");
              const text = cache.get(t.file);
              if (!text) continue;
              const r = scoreTarget(t, text.toLowerCase(), tokens, (t.label || "").toLowerCase(), t.file.toLowerCase());
              if (r.score > 0) results.push({ f: t.file.toLowerCase(), s: r.score });
            }
            results.sort((a, b) => b.s - a.s);
            const rank = results.findIndex((r) => r.f.endsWith(p.base + ".md"));
            if (rank >= 0 && rank < 3) detail.hit++;
          }
          if (detail.checked > 0 && detail.hit < detail.checked) problems.push("索引词搜索对账仅 " + detail.hit + "/" + detail.checked + " 进预期文件前3（索引与检索脱节）");
        }
      } catch (e) {
        problems.push("自检异常: " + (e && e.message || e));
      }
      RETRIEVAL_SELF = { ok: problems.length === 0, msg: problems.join("；"), detail, at: Date.now() };
      if (problems.length === 0) clog("[dsh-memory] 检索层自检通过（候选 " + detail.targets + " · A类表 " + detail.table + " 条 · 索引对账 " + detail.hit + "/" + detail.checked + "）");
      else cerr("[dsh-memory] ⚠️ 检索层自检未通过: " + RETRIEVAL_SELF.msg + " —— 离线排查跑 node _test-retrieval.cjs");
    }

    // v8：记忆库自动备份（距上次备份 >7 天则整库复制到 memory_backup/）
        // v9：备份到期检查（只读）——返回 {due, last}；due=true 说明需要提醒执行备份
    async function checkBackupDue() {
      try {
        const last = await readText(BACKUP_ROOT + "/.last");
        if (last) {
          const t = Number(last.trim());
          if (!isNaN(t) && Date.now() - t < BACKUP_INTERVAL_MS) {
            return { due: false, last: new Date(t) };
          }
        }
        return { due: true, last: last ? new Date(Number(last.trim())) : null };
      } catch (e) {
        cerr("[dsh-memory] 备份检查失败:", e && e.message ? e.message : String(e));
        return { due: false, last: null };
      }
    }

    // v2.2.7：备份自动执行——node:fs 直写 ~/.dsh 已验证可行（无需审批），替代 v9 提醒制。
    // 动机：提醒制执行不可靠——实测 08-21 后连续 5 天大改动期间零备份（提醒注入了但没人跑）。
    // 实现：手写递归复制（copyFileSync 逐文件，实测可靠）而非 cpSync——后者在本机曾观测到静默无效果。
    // 三重防静默：①复制后校验快照含 global.md 且文件数>0，否则抛错 ②.last 仅在校验通过后写入 ③失败 cerr 并降级人工提醒。
    // 快照 = 整库复制到 memory_backup/YYYYMMDD_HHMM/；保留策略：只留最新 BACKUP_KEEP 份。
    async function runBackupNow() {
      try {
        const t = new Date();
        const dir = BACKUP_ROOT + "/" + t.getFullYear() + String(t.getMonth() + 1).padStart(2, "0") + String(t.getDate()).padStart(2, "0") + "_" + String(t.getHours()).padStart(2, "0") + String(t.getMinutes()).padStart(2, "0");
        let copied = 0;
        const copyRec = (sDir, dDir) => {
          fs.mkdirSync(dDir, { recursive: true });
          for (const e of fs.readdirSync(sDir, { withFileTypes: true })) {
            const s = sDir + "/" + e.name, dd = dDir + "/" + e.name;
            if (e.isDirectory()) copyRec(s, dd);
            else { fs.copyFileSync(s, dd); copied++; }
          }
        };
        copyRec(MEMORY_ROOT, dir);
        if (copied === 0) throw new Error("零文件复制（源为空或 IO 异常）");
        if (!fs.existsSync(dir + "/global.md")) throw new Error("快照缺 global.md（复制不完整）");
        fs.writeFileSync(BACKUP_ROOT + "/.last", String(Date.now()), "utf8");
        // 保留策略：目录名即时间序，超出 BACKUP_KEEP 的最旧快照直接删除
        const snaps = fs.readdirSync(BACKUP_ROOT).filter((n) => /^\d{8}_\d{4}$/.test(n)).sort();
        let removed = 0;
        for (const s of snaps.slice(0, Math.max(0, snaps.length - BACKUP_KEEP))) {
          try { fs.rmSync(BACKUP_ROOT + "/" + s, { recursive: true, force: true }); removed++; } catch (e) {}
        }
        clog("[dsh-memory] 记忆库自动备份完成 → memory_backup/" + dir.split("/").pop() + "（" + copied + " 个文件；共 " + (snaps.length - removed) + " 份快照" + (removed ? "，清理最旧 " + removed + " 份" : "") + "）");
        return { ok: true, dir, files: copied };
      } catch (e) {
        cerr("[dsh-memory] ⚠️ 自动备份失败:", e && e.message || e, "→ 本次降级为会话内人工提醒");
        return { ok: false, error: e && e.message || String(e) };
      }
    }

    // v9：组装维护提醒（备份到期 + 轮转到期），有需要时注入
    async function injectMaintenanceReminder(agent, sessionLabel) {
      ensureStaleNotified();
      LAST_TOP_AGENT = agent;  // v1.12.8: 记录最近顶层会话句柄
      const SESSION_LABEL = sessionLabel || "?";

      const parts = [];

      const backup = await checkBackupDue();
      if (backup.due) {
        // v2.2.7：先由插件直接自动备份（node:fs.cpSync 直写 ~/.dsh 已验证可行，无需审批）；仅失败时降级为原人工提醒文案
        const auto = await runBackupNow();
        if (!auto.ok) {
        const lastTxt = backup.last
          ? backup.last.getFullYear() + "-" + String(backup.last.getMonth() + 1).padStart(2, "0") + "-" + String(backup.last.getDate()).padStart(2, "0") + " " + String(backup.last.getHours()).padStart(2, "0") + ":" + String(backup.last.getMinutes()).padStart(2, "0")
          : "从未备份";
        parts.push(
          "【dsh-memory 备份提醒】自动备份失败（" + (auto.error || "?") + "）。记忆库上次备份：" + lastTxt + "（超过 7 天）。请在本次会话执行备份：\n" +
          "写 ~/.dsh 若被沙箱拒绝，用 pwsh 工具带 sandbox_permissions danger-full-access + justification 升级重试（会弹审批，点允许即可）。\n" +
          "执行命令（" + (process.platform === "win32" ? "pwsh" : "bash") + "）：\n" +
          (process.platform === "win32"
            ? "$stamp = Get-Date -Format 'yyyyMMdd_HHmm'; $dst = '" + PS_BACKUP + "\\' + $stamp; New-Item -ItemType Directory -Force -Path $dst | Out-Null; Copy-Item '" + PS_MEMORY + "\\*' -Destination ($dst + '\\') -Recurse -Force; Set-Content -Path '" + PS_BACKUP + "\\.last' -Value ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
            : "stamp=$(date +%Y%m%d_%H%M); mkdir -p '" + BACKUP_ROOT + "/$stamp' && cp -R '" + MEMORY_ROOT + "/.' '" + BACKUP_ROOT + "/$stamp/' && echo $(($(date +%s) * 1000)) > '" + BACKUP_ROOT + "/.last'") + "\n" +
          "完成后确认日志出现备份成功输出。"
        );
      }
        } // v2.2.7: 闭合 !auto.ok 降级分支

      const oldSessions = await findOldSessions();
      if (oldSessions.length > 0) {
        // v0.5（step3 N1）：插件自执行轮转（替代 v9 提醒模型 cp/截断）；失败项才降级提醒
        const rt = rotateSessions(oldSessions);
        if (rt.failed.length > 0) {
          parts.push(
            "【dsh-memory 轮转提醒】已自动归档 " + rt.archived.length + " 个，以下 " + rt.failed.length + " 个失败（写 ~/.dsh 被拒或 IO 异常），请手动处理：\n" +
            "- " + rt.failed.join("\n- ") + "\n" +
            "（成功项已复制到 sessions/archive/ 并清空原文件）"
          );
        } else if (rt.archived.length > 0) {
          clog("[dsh-memory] 轮转自动完成：sessions/ → archive/ " + rt.archived.length + " 个（" + rt.archived.join(", ") + "）");
          parts.push(
            "【dsh-memory 轮转完成】已自动归档 " + rt.archived.length + " 个超 " + ROTATE_DAYS + " 天会话摘要到 sessions/archive/ 并清空原文件（合计 " + oldSessions.reduce((a, s) => a + s.bytes, 0) + "B）。无需手动操作。"
          );
        }
      }

      // v10.2：超限治理提醒（软字节阈值 + 硬字符预算 双轨报告）
      // v2.4.4（A）：summary 计数已剥 intent（见 checkSizeOverflow）；文案按 isToday 分流——
      //   当日摘要由合并维护子代理自动收敛（要点面≥1500 或 intent 块≥3 自动触发），无需手动 edit；
      //   非当日摘要（昨日及更早，合并只覆盖当日）与 global/index 仍须人工精简。
      // v0.5.2（2026-09-03 提醒去噪，用户拍板）：当日摘要超限 → 若合并维护可用（未熔断）则完全不注入
      //   （A 轨道 pre-step step1 / compact 会自动收敛，提醒是多余的——实证：熔断/文案误导反复出现）；
      //   仅当合并维护当日已熔断（attempts≥3，持续失败/被 abort）才发简短真实提醒（否则用户看到
      //   「自动收敛中」却是假话，且永远不知道为何没收敛）。
      const sizeIssues = await checkSizeOverflow();
      if (sizeIssues.length > 0) {
        // v0.5.2 判定：当日摘要条目是否处于「合并维护熔断」（attempts>=3 记当日 .md）
        const todaySummary = sizeIssues.find((i) => i.key === "summary" && i.isToday);
        let todayFused = false;
        try {
          if (todaySummary) {
            maintRetryResetIfStale();   // 确保 MAINT_RETRY 已从 .integrate.json 加载
            todayFused = !!(MAINT_RETRY && MAINT_RETRY.day === todaySummary.file
              && MAINT_RETRY.attempts >= MAINT_RETRY_MAX);
          }
        } catch (e) { todayFused = false; }
        // 用户拍板（2026-09-03）：当日摘要超限且合并维护可用（未熔断）→ 完全不注入
        //   （pre-step step1 / compact 会自动收敛，提醒多余）；熔断才发真实提醒。
        const manualIssues = sizeIssues.filter((i) => i.key !== "summary" || !i.isToday || todayFused);
        if (manualIssues.length === 0) {
          clog("[dsh-memory] 超限：仅当日摘要超限且合并维护可用，静默（pre-step 自动收敛）");
        } else {
          const lines = manualIssues.map((i) => {
            const status = i.truncated
              ? "⚠️ 字符超硬预算，注入已截断（完整内容可用 memory_search 读取）"
              : "⚠️ 字节超软阈值（未截断，但建议整理）";
            const fusedNote = (i.key === "summary" && i.isToday && todayFused)
              ? "（当日：合并维护已熔断——" + String((MAINT_RETRY && MAINT_RETRY.lastReason) || "?").slice(0, 20) + "×" + ((MAINT_RETRY && MAINT_RETRY.attempts) || "?") + "，未自动收敛）"
              : "";
            return "- " + i.label + "：字节 " + i.bytes + "B（软阈值 " + i.byteWarn + "B）/ 字符 " + i.chars + "（硬预算 " + i.charLimit + "）→ " + status + fusedNote;
          });
          const manualSuggest = sizeIssues.some((i) => i.key === "summary" && !i.isToday)
            ? "非当日摘要：把可下沉细节提升到 knowledge/ 或 projects/ 对应文件（合并维护只自动覆盖当日文件）"
            : "global/index 精简：把可下沉的踩坑/配置/清单提升到 knowledge/，稳定层只留高频通用要点";
          const text =
            "【dsh-memory 超限整理提醒】以下记忆文件超限（阈值=软信号，预算=硬截断）：\n" +
            lines.join("\n") + "\n" +
            (todayFused ? "当日摘要：合并维护今日已熔断（" + String((MAINT_RETRY && MAINT_RETRY.lastReason) || "?").slice(0, 20) + "×" + ((MAINT_RETRY && MAINT_RETRY.attempts) || "?") + "），未自动收敛；可手动精简（写入走 memory_dream_patch），或等日切后自动恢复。\n" : "") +
            "处理建议：1. " + manualSuggest + "；\n2. 精简写入统一走交付工具 memory_dream_patch（replace 全文件/delete 删条目，插件校验+原子写+回读；禁止 write/edit 直写记忆库——直写会被通道闸拒绝）；\n3. 目标 = 字节 < 软阈值 且 字符 < 硬预算。";
          parts.push(text);
        }
      }

      // v12：知识文件过期复核提醒（解析文件头"最后更新"日期，>180 天未更新列入）
      const stale = await checkStaleKnowledge();
      if (stale.length > 0) {
        const staleLines = stale.map((s) => "- " + s.label + " → " + s.file + "（" + s.ageDays + " 天未更新）");
        parts.push(
          "【dsh-memory 过期复核提醒】以下知识文件超过 " + STALE_DAYS + " 天未更新（依据文件头「最后更新」日期），请人工复核内容是否仍有效：\n" +
          staleLines.join("\n") + "\n" +
          "处理：仍有效 → 用 memory_dream_patch 更新文件头日期；已过时 → 用 memory_dream_patch 精简归档或 delete 删除（文件删除后索引自动失效，无需其他操作；禁止 write/edit 直写——直写会被通道闸拒绝）。"
        );
      }

      // v1.3.0：漏网会话处理（久未交互且未落档的会话）——v1.4.0 按 staleAction 分派
      //  silent: 插件直接 spawn 子代理总结（后台，完成后控制台输出）
      //  remind / approval: 注入提醒（approval 文案带确认引导）
      try {
        // v1.6.0：installAt 界限 —— 插件启用前创建的会话不触发整合
        const staleSessions = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
          .filter((s) => archivePendingEntry(s) && !sessionMentionedInMemory(s.id));   // v1.12.19→v2.4.3：归档过的续聊出新帧会重入（水位判定），提醒去重仍归 STALE_NOTIFIED
        if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }   // v2.4.3: 懒置基线顺带落盘
        if (staleSessions.length > 0) {
          if (PLUGIN_CFG.staleAction === "silent" && ZSTD_OK) {   // v2.0.9(M3): 无 zstd 能力禁止 silent 自动消号，落入 remind 分支
            // v1.12.8：单主子代理编排（无感）：插件提取消息流 → 一个主子代理自主判断/总结/落盘
            // v2.4.7.1（回归修复③）：此处 await 只到「提取+发起完成」（秒级），子代理结算在 settle 链后台跑，
            //   维护提醒注入不再被拖到子代理结束（实证旧路径一晚上把会话启动顶住 6 分 14 秒）。
            const r = await runStaleArchive(staleSessions);
            if (r.ok) {
              clog("[dsh-memory] 漏网归档已发起：" + r.count + " 会话 / " + r.started + " 批（后台结算，完成后另出一条报告）" + (r.startFailed ? "，另有 " + r.startFailed + " 批发起失败留待下轮" : ""));
              if (r.overflow > 0) clog("[dsh-memory] 剩余 " + r.overflow + " 个漏网会话将在下次检查时处理");
            }   // 消号 v1.12.19.1 起在子代理完成回调内执行（处置完成才消号）
            // 未发起成功不标记 → 下次再处理          } else {
            const remindList = staleSessions.filter((s) => !STALE_NOTIFIED.has(s.id));   // v1.12.19: 提醒去重回归 NOTIFIED 账本（防同实例刷屏）
            staleSessions.forEach((s) => STALE_NOTIFIED.add(s.id));   // 本实例内不再重复进入提醒候选
            if (remindList.length > 0) {
              const lines = remindList.map((s) => {
                const days = Math.max(1, Math.round((Date.now() - s.mtime) / 86400000));
                return "- " + s.id + "（工作目录 " + s.ws.slice(0, 40) + "…，最后活动约 " + days + " 天前，日志 " + s.size + "B）";
              });
              const actionTxt =
                PLUGIN_CFG.staleAction === "approval"
                  ? "审批模式：确认后调用 stale_archive 工具即自动完成归档（插件提取消息流，单主子代理自主判断/总结/落盘，无需读原始日志）。"
                  : "处理（可选，由你决定）：若其中某个会话有值得归档的内容，可让我 review 其原始日志并总结进 memory/；若无需归档可忽略。";
              parts.push(
                "【dsh-memory 漏网会话提醒】检测到 " + remindList.length + " 个会话超过 " + PLUGIN_CFG.staleSessionDays + " 天无交互、且其内容未在记忆库 sessions/ 中落档（可能从未被总结）：\n" +
                lines.join("\n") + "\n" +
                actionTxt + "\n" +
                "（原始日志：~/.dsh/sessions/<工作目录>/<会话id>/session.jsonl.zstd；同实例内只提示一次）"
              );
            }
          }
          // v1.4.0：更新只读统计（设置界面显示"未整合记忆会话数"）
          try {
            if (HOST_SETTINGS_SCOPE && typeof HOST_SETTINGS_SCOPE.update === "function") {
              const total = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt()).filter((s) => !sessionMentionedInMemory(s.id) && archivePendingEntry(s)).length;   // v2.4.3 增量重档：新帧未档的计入 staleCount
              HOST_SETTINGS_SCOPE.update({ staleCount: total }).catch(() => {});
            }
          } catch (e) { /* 统计更新失败不影响主流程 */ }
        }
      } catch (e) {
        cwarn("[dsh-memory] 漏网会话检测失败:", e && e.message ? e.message : String(e));
      }

      if (parts.length === 0) return;
      agent.inject(makeMessage(
        "<system-reminder>\n以下为 dsh-memory 维护提醒（写入 ~/.dsh 需要一次审批，频率很低）：\n" + parts.join("\n\n") + "\n</system-reminder>"
      ));
      clog("[dsh-memory] 已注入维护提醒（" + parts.length + " 项）[会话: " + SESSION_LABEL + "]");
      saveStaleNotified();
    }

    // v1.4.0：会话标识（日志关联用）—— 工作目录最后一段 + session id 前 8 位
    function sessionLabelOf(agent) {
      try {
        const s = agent && agent.session;
        const id = (s && s.id) || agent.sessionId || "";
        const short = String(id).replace(/^session-/, "").slice(0, 8);
        const cwd = (s && s.header && s.header.cwd) || (s && s.cwd) || "";
        const dir = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : "";
        return (dir ? dir + "·" : "") + short;
      } catch (e) { return "?"; }
    }

    ctx.on("agent/session-start", (payload) => {
      const agent = payload.agent;
      if (!agent || typeof agent.inject !== "function") {
        cerr("[dsh-memory] session-start: agent.inject 不可用");
        return;
      }
      // v1.4.0：本会话标识（所有注入日志关联显示）
      const SESSION_LABEL = sessionLabelOf(agent);
      // v6：记录主会话 id；v9：记录 sessionId → agent 映射（压缩检查点注入用）
      // v10.3：agentsBySession 只记顶层会话（子代理压缩不归档）；rootSessionId 仅兜底记录第一个
      if (agent.session && agent.session.id) {
        if (rootSessionId === null) rootSessionId = agent.session.id;
        if (isTopLevelSession(agent)) {
          agentsBySession.set(agent.session.id, agent);
        }
      }
      const TOPSESSION = isTopLevelSession(agent);   // v2.3.8 F1: 子代理不吃记忆注入——防 ghost 轮+省 5K tok/次
      (async () => {
        try {
          const injectedParts = [];   // v1.12.19.2: 注入确认合并为单条日志
          // 消息B 数据源前移（v2.4.5 免重入判定要用摘要参与哈希；latestSessionSummary 纯读，无行为变化）
          const latest = await latestSessionSummary();
          // 消息A：稳定层
          const globalRaw = await readText(MEMORY_ROOT + "/global.md");
          const indexRaw = await readText(MEMORY_ROOT + "/index.md");
          const globalMd = stabilize(globalRaw);
          const indexMd = stabilize(indexRaw);
          // v7：超限预警（提醒该整理了）
          if (globalRaw && utf8Bytes(globalRaw) > SIZE_WARN["global.md"]) {
            sizeWarnThrottled("global.md", "global.md 超限 " + utf8Bytes(globalRaw) + "B（阈值 " + SIZE_WARN["global.md"] + "B），建议整理提升[会话: " + SESSION_LABEL + "]");
          }
          if (indexRaw && utf8Bytes(indexRaw) > SIZE_WARN["index.md"]) {
            sizeWarnThrottled("index.md", "index.md 超限 " + utf8Bytes(indexRaw) + "B（阈值 " + SIZE_WARN["index.md"] + "B），建议精简[会话: " + SESSION_LABEL + "]");
          }
          const stableParts = [];
          let gCut = "";   // v2.4.6：画像切片文本提升——画像重发必须与新会话逐字同款（前缀确定性）
          if (globalMd) {
            // v1.12.0：分区感知注入（保章节骨架+按章截断），不丢结构
            const g = sectionAwareSlice(globalMd, CHAR_LIMIT["global.md"], "global");
            gCut = g.text;
            stableParts.push("【全局记忆·用户画像】\n" + g.text);
          }
          if (indexMd) {
            // v1.12.0：分区感知注入
            const i = sectionAwareSlice(indexMd, CHAR_LIMIT["index.md"], "index");
            stableParts.push("【记忆索引】\n" + i.text);
          }
          // ═══ v2.4.6（用户批准）恢复会话三档处理——处置按文件焊死、与变化幅度无关：═══
          //   三文件均未变 → 静默（不 append 任何字）；仅 index/摘要变 → 轻量更新通知；
          //   global.md 变 → 重发【用户画像】一份（与新会话逐字同款组装）+ 其余只通知；新会话（无快照）→ 照常全量。
          // ★ 前缀缓存纪律（用户红线）：三档全部只经 agent.inject 在历史尾部一次性追加，绝不插入/改写已有前缀；
          //   通知文本在落历史那一刻冻结（含账本时间戳也一次性），此后每轮重发字节不变 → 旧前缀持续命中。
          let injectMode = "full"; let mG = false; let mI = false; let mS = false; let mP = false; let snapT = 0;
          const sidOfInject = agent && agent.session ? agent.session.id : null;
          const hG = createHash("sha256").update(globalMd || "").digest("hex");
          const hI = createHash("sha256").update(indexMd || "").digest("hex");
          const hS = createHash("sha256").update((latest && latest.text) || "").digest("hex");
          // v2.4.17（项目记忆 P1-3）：项目块 hash（命中项目才计算；未命中 = ""，不参与判定）
          let hP = ""; let hPname = "";
          try {
            const _cw2 = (agent.session && ((agent.session.header && agent.session.header.cwd) || agent.session.cwd)) || "";
            const _mp2 = matchProjectByCwd(_cw2);
            if (_mp2.hits.length > 0) {
              const _pr2 = _mp2.hits[0];
              hPname = String(_pr2.display || _pr2.file || "");
              hP = projectBlockHash(fs.readFileSync(portable(MEMORY_ROOT + "/projects/" + _pr2.file), "utf8"));
            } else if (_mp2.staleHits && _mp2.staleHits.length > 0) {   // v2.4.18（P0-1/P2-12）：stale=文件缺失哨兵——不进 hash 变更通知，避免「消失」误报「文件有改动」
              const _ps2 = _mp2.staleHits[0];
              hPname = String(_ps2.display || _ps2.file || "");
              hP = "MISSING";
            }
          } catch (e) {}
          if (TOPSESSION && sidOfInject) {
            loadInjectSnapshot();
            const snap = injectSnapshotGet(sidOfInject);
            if (snap) {
              // v2.4.8（B：used 闸）：存量旧格式条目 used 缺失 → 惰性按日志补算一次「是否出现过真实用户回合」
              if (snap.used === undefined) snap.used = resolveInjectUsedOnce(sidOfInject);
              if (snap.used === false) {
                // 从未有真实用户回合的会话（startup 注入过但用户从未发言）：强制静默——
                // 不重注、不发变更通知（变更通知只针对用过/恢复的历史会话）；等首个真实回合后 pre-step 置 used=true
                injectMode = "silent";
              } else {
                mG = snap.g !== hG; mI = snap.i !== hI; mS = snap.s !== hS; snapT = snap.t || 0;   // 旧版 {h,t} 条目 → mG=true，画像重发一次并升级账本为新格式
                mP = hP !== "" && hP !== "MISSING" && snap.p !== hP;   // v2.4.17：项目块变通知（未命中项目恒 false；旧条目无 p → 首次命中即通知一次）；v2.4.18：MISSING 哨兵排除（stale 缺失不误报）
                if (!mG && !mI && !mS && !mP) injectMode = "silent";
                else if (mG && gCut) injectMode = "global";
                else injectMode = "notice";
              }
            }
          }
          let ledgerNote = "";
          if (injectMode === "global" || injectMode === "notice") {
            try {
              const _f = (ms) => { const q = new Date(ms); return (q.getMonth() + 1) + "-" + q.getDate() + " " + String(q.getHours()).padStart(2, "0") + ":" + String(q.getMinutes()).padStart(2, "0"); };
              const sti = readIntegrateState() || {};
              const bits = [];
              if (snapT && sti.lastIntegrateAt && sti.lastIntegrateAt > snapT) bits.push("记忆整合（最近 " + _f(sti.lastIntegrateAt) + "）");
              if (snapT && sti.archiveLastRunAt && sti.archiveLastRunAt > snapT) bits.push("漏网归档（最近 " + _f(sti.archiveLastRunAt) + "）");
              if (bits.length) ledgerNote = " 期间动作：" + bits.join("、") + "；";
            } catch (e) { /* 账本读不到就少一行说明，通知主体不受影响 */ }
          }
          if (injectMode === "full") {
            if (stableParts.length > 0 && TOPSESSION) {   // v2.3.8 F1: 子代理不吃稳定层注入（防 ghost 轮+省 5K tok/次）
              agent.inject(makeMessage(
                "<system-reminder>\n以下为跨会话持久记忆（dsh-memory 稳定层，自动注入）。按需引用；更具体细节请调用 memory_search 工具。\n" + stableParts.join("\n\n") + "\n</system-reminder>"
              ));
              injectedParts.push("稳定层");
            } else if (stableParts.length === 0) {
              cwarn("[dsh-memory] 稳定层为空（global/index 读取失败）");
            }   // v2.4.3.1：稳定层非空但 TOPSESSION=false（子代理故意零注入）→ 不再误报「读取失败」
            if (latest && latest.text && TOPSESSION) {   // v2.3.8 F1: 【最近一次会话压缩点】进子代理曾直接诱发 ghost 轮重写（756123d9 事故）
              if (utf8Bytes(latest.text) > SIZE_WARN.summary) {
                sizeWarnThrottled(latest.file, "摘要 " + latest.file + " 超限 " + utf8Bytes(latest.text) + "B（阈值 " + SIZE_WARN.summary + "B），建议精简[会话: " + SESSION_LABEL + "]");
              }
              // v2.4.17（降噪 N1-3/三档一致）：当日文件才注入正文（三节优先）；非当日只发一行稳定通知（防跨天错配，不重发正文）
              if (latest.isToday) {
                // v2.4.17（降噪 N0-1/N1-1/N1-2）：当日报文结构检查——坏则当日一次通知 + 在三门内触发合并维护自愈
                try {
                  if (summaryStructureBroken(latest.text)) {
                    if (SUMMARY_STRUCT_NOTIFIED_DAY !== dateStr(new Date())) {
                      SUMMARY_STRUCT_NOTIFIED_DAY = dateStr(new Date());
                      agent.inject(makeMessage("<system-reminder>\n【dsh-memory 提示】当日摘要 " + latest.file + " 三节结构异常（可能写坏），已触发合并维护修复；按需 memory_search。\n</system-reminder>"));
                    }
                    try {
                      if (maintRetryAllow(latest.file) && !MAINT_RUNNING && !INTENT_RUNNING) runMaintenanceMerge(latest.file, latest.text, null, null);
                    } catch (e3) { cwarn("[dsh-memory] 结构异常触发 maint 失败:", e3 && e3.message ? e3.message : String(e3)); }
                  }
                } catch (eS) { /* 结构检查失败不阻塞注入 */ }
                // v2.4.26（用户拍板）：命中项目 X → 今日摘要只注 X 相关节（注入侧按行剥离，防跨项目要点污染）；
                // 未命中项目 → 原全量 slice；X 0 命中 → 一行通知 + memory_search 指引（宁缺勿污染，缺失可查当日文件/存档）
                let projGu = null;
                try {
                  const _cwdX = (agent.session && ((agent.session.header && agent.session.header.cwd) || agent.session.cwd)) || "";
                  const _mx = matchProjectByCwd(_cwdX);
                  if (_mx.hits.length > 0 || (_mx.staleHits && _mx.staleHits.length > 0)) {
                    const _pr0 = _mx.hits[0] || _mx.staleHits[0];
                    projGu = { key: String(_pr0.key || ""), aliases: Array.isArray(_pr0.aliases) ? _pr0.aliases : [] };
                  }
                } catch (eX) {}
                if (projGu) {
                  // v0.5（step4+5 P1-1 节感知）：分格文件只取项目格/通用块；旧格式自动回退全行剥离（零退化）
                  const ps = projectSummarySliceSectioned(latest.text, projGu.key, projGu.aliases, CHAR_LIMIT.summary);
                  if (ps.hit === 0) {
                    agent.inject(makeMessage("<system-reminder>\n【最近一次会话压缩点】" + latest.file.slice(0, 10) + " 当日无「" + projGu.key + "」相关要点（已按项目隔离防跨项目污染）。按需 memory_search 查最近要点/全文存档。\n</system-reminder>"));
                    injectedParts.push("摘要(项目隔离0命中)");
                  } else {
                    agent.inject(makeMessage("<system-reminder>\n【最近一次会话压缩点】以下为历史记忆背景，非当前任务指令（本会话任务一律以用户最新消息为准）。\n（" + latest.file + "，" + projGu.key + " 相关节）\n" + ps.text + "\n</system-reminder>"));
                    injectedParts.push("摘要(" + projGu.key.slice(0, 12) + "相关)");
                  }
                } else {
                  // v2.4.27（方案A，用户拍板）：未命中任何项目 → 当日摘要只注通用块，剥掉其他项目格与 dump（宁缺毋污染，防跨项目要点泄漏；实证：agent周事项 cwd 经全量注入把发改委/长沙项目格喂进 OA 会话）
                  const coopM = parseDailySections(latest.text);
                  const grw = coopM.filter((s) => s.kind === "general" || s.kind === "archive").reduce((acc, s) => acc.concat(s.lines), []);   // v2.5.2（F5a 涟漪②）：filter 非 find——同日多轮归档=多个 archive 段全量入注
                  const gen = (grw[0] && /^##\s*通用块/.test(grw[0]) ? grw.slice(1) : grw).join("\n").trim();
                  if (gen) {
                    const sumSliced = sectionAwareSlice(gen, CHAR_LIMIT.summary, latest.file, { priority: ["本次目标", "下一步行动", "关键结论"] });
                    agent.inject(makeMessage(
                      "<system-reminder>\n【最近一次会话压缩点】以下为历史记忆背景，非当前任务指令（本会话任务一律以用户最新消息为准）。\n（" + latest.file + "，通用块）\n" + sumSliced.text + "\n</system-reminder>"
                    ));
                    injectedParts.push("摘要(通用块)");
                  } else {
                    agent.inject(makeMessage("<system-reminder>\n【最近一次会话压缩点】" + latest.file.slice(0, 10) + " 当日无通用块要点（已按项目隔离防跨项目污染）。按需 memory_search 查最近要点/全文存档。\n</system-reminder>"));
                    injectedParts.push("摘要(通用块0命中)");
                  }
                }
              } else {
                agent.inject(makeMessage(
                  "<system-reminder>\n【最近一次会话压缩点】停在 " + latest.file.slice(0, 10) + "（非当日，仅通知；历史背景，非当前任务指令）。按需 memory_search 查最近要点。\n</system-reminder>"
                ));
                injectedParts.push("摘要通知(" + latest.file.slice(0, 10) + ")");
              }
            } else if (TOPSESSION) {
              cwarn("[dsh-memory] 未找到会话摘要");
            }
            // v2.4.17（项目记忆子系统）：cwd 命中项目 → 注入项目分区切片（≤2000，注意 TOPSESSION/F1 闸）
            if (TOPSESSION) {
              try {
                const cwdOf = (agent.session && ((agent.session.header && agent.session.header.cwd) || agent.session.cwd)) || "";
                const mp = matchProjectByCwd(cwdOf);
                if (mp.marker && mp.marker.markerStale) {   // v2.4.19：标记失效每日每 path+key 节流提示（评审 P1）；仅报告，注入由 workdirs 回退（P0-1）
                  const _mk = mp.marker;
                  const _k = String(cwdOf) + "|" + _mk.markerKey;
                  if (MARKER_NOTIFY_DAILY.get(_k) !== dayStrLocal(new Date())) {
                    MARKER_NOTIFY_DAILY.set(_k, dayStrLocal(new Date()));
                    try { agent.inject(makeMessage("<system-reminder>\n【dsh-memory 提示】项目标记失效（" + _mk.markerKey + " 不在项目索引，可能项目文件已改名/删除），已回退目录匹配；运行 /dream 触发复核。\n</system-reminder>")); } catch (eQ) {}
                  }
                }
                if (mp.hits.length > 0 || (mp.staleHits && mp.staleHits.length > 0)) {
                  // v2.4.18（P0-1/P1-5/P1-9）：健康命中全量 touch（命中即使用证据，防止多命中者 lastHitAt 冻结误报）；注入顺延取首个读取成功者（杜绝 hits[0] 短路径饿死其他项目）；stale 仅作回退（文件复原即恢复注入）
                  for (const pr of mp.hits) { try { touchProjectHit(mp.index, pr.key, dayStrLocal(new Date())); } catch (eT) {} }
                  const cands = mp.hits.concat(mp.staleHits || []);
                  for (const pr of cands) {
                    let ptxt = null;
                    try { ptxt = fs.readFileSync(portable(MEMORY_ROOT + "/projects/" + pr.file), "utf8"); } catch (eR) { continue; }
                    const psliced = sectionAwareSlice(ptxt, 2000, "projects/" + pr.file, { priority: ["Rules", "Architecture decisions", "Gotchas", "当前状态与下一步"] });
                    const extra = mp.hits.length > 1 ? "（另有 " + (mp.hits.length - 1) + " 个项目目录可能相关）" : "";
                    agent.inject(makeMessage("<system-reminder>\n【项目记忆】" + pr.display + extra + "\n" + psliced.text + "\n</system-reminder>"));
                    injectedParts.push("项目(" + String(pr.display).slice(0, 20) + ")");
                    break;
                  }
                }
              } catch (eP) { cwarn("[dsh-memory] 项目注入失败:", eP && eP.message ? eP.message : String(eP)); }
            }
            if (TOPSESSION && injectedParts.length > 0 && sidOfInject) recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS, p: hP });
          } else if (injectMode === "global") {
            // 三档之画像重发：只重发 gCut（与新会话逐字同款、确定性组装）；index/摘要只通知不重发——一次性 append，落历史即冻结
            agent.inject(makeMessage(
              "<system-reminder>\n以下为跨会话持久记忆更新（dsh-memory）：用户画像/偏好自本会话上次快照后有变化，重发最新画像：\n【全局记忆·用户画像】\n" + gCut +
              (mI || mS || mP ? "\n\n另有变化（快照不重发，防历史膨胀）：" + (mI ? " 记忆索引已更新；" : "") + (mS ? " 最近摘要有推进（" + String((latest && latest.file) || "?").slice(0, 40) + "）；" : "") + (mP ? " 项目 " + hPname + " 有更新；" : "") : "") +
              ledgerNote +
              "\n其余新内容按需 memory_search；需要完整快照请新开会话。</system-reminder>"
            ));
            injectedParts.push("画像重发");
            recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS, p: hP });
          } else if (injectMode === "notice") {
            // 三档之纯通知：不带任何快照正文（几百字）；画像读失败降级到此档并说明
            agent.inject(makeMessage(
              "<system-reminder>\n【dsh-memory·记忆库更新通知】自本会话上次快照：" + (mI ? " 记忆索引已更新；" : "") + (mS ? " 最近摘要有推进（" + String((latest && latest.file) || "?").slice(0, 40) + "）；" : "") + (mP ? " 项目 " + hPname + " 有更新；" : "") + (mG ? " 用户画像已更新但本轮读取失败，可 memory_search 查询；" : "") +
              ledgerNote +
              " 新内容按需 memory_search，无需通读全文。</system-reminder>"
            ));
            injectedParts.push("更新通知");
            recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS, p: hP });
          }
          // injectMode==="silent"：不 append 任何字——前缀缓存零扰动
          // v1.12.19.2 单条确认；v2.4.6 分档结果
          clog("[dsh-memory] 记忆注入:" + (injectMode === "silent" ? " 三文件均未变，静默" : (injectMode === "global" ? " 画像重发+变化通知" : (injectMode === "notice" ? " 更新通知（免重注入）" : (injectedParts.length > 0 ? " " + injectedParts.join("+") : (TOPSESSION ? " 失败" : "（子代理跳过）"))))) + "[会话: " + SESSION_LABEL + "]");

          // 消息C：v9 维护提醒（备份到期 / 轮转到期 / 超限整理，只读检查后注入）
          // v10.3：同实例只对第一个顶层会话注入——避免多个主会话/子代理并发收到整理指令
          if (isTopLevelSession(agent) && !maintenanceInjected) {
            maintenanceInjected = true;
            await injectMaintenanceReminder(agent, SESSION_LABEL);
          }

          // 消息D：v2.3.0 记忆初始化引导 + 新版提醒（只认顶层会话）
          //  新装用户 global/index 还不存在时，稳定层注入是空的（旧版只在控制台 cwarn，用户与模型都看不到）；
          //  这里改成往会话里注入一段可执行引导，由模型用 ask_user_question 采集画像并落盘。
          //  节流：一天最多一次，用户说"回头再说"则 snooze；两个开关都可在 设置→通用设置→记忆 关闭。
          if (isTopLevelSession(agent)) {
            maybeInjectInitGuide(agent, SESSION_LABEL);
          }
        } catch (e) {
          cerr("[dsh-memory] 注入异常:", e && e.message ? e.message : String(e));
        }
      })();
    });

    // v1.12.0：自动提醒查记忆/查 skill（判断 A）——
    // agent/pre-step 每轮模型请求前触发，payload 含 messages（用户消息）。命中已知领域 → 注入提醒。
    // waterfall 语义：必须 await next() 保持链路；判断极轻（内存 Set includes）；节流防刷屏。
    ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
      try {
        const decision = await next();
        // 判断 A：只在每轮第一条用户消息（step 1）做，命中已知领域才提醒
        // v2.4.1：不再依赖 agent.inject（已改 pre-step 决策直入），守卫只留 step/agent 存在性
        if (step !== 1 || !agent) return decision;
          if (!isTopLevelSession(agent)) return decision;   // v2.3.8 F1 + v2.4.27：A 类只发顶层会话——子代理（plugin+normal）都不开，
                                                             // 防诱导 memory_search/偏航/烧 token（F1 ghost 轮事故根源）；B/C/D 另按类别放开
        const sid = (agent.session && agent.session.id) || "?";
        // v2.4.8（B：used 闸）置位点——首个真实用户回合（step===1 顶层会话）到达即标记 used=true：
        // 置位后该会话恢复正常三档判定；此前（startup 注入过但从未发言）恢复时强制静默，不发变更通知。
        try {
          if (sid && sid !== "?") {
            const e = INJECT_SNAPSHOT.get(sid);
            if (e && e.used !== true) { e.used = true; scheduleInjectStateSave(); }
          }
        } catch (e) { /* 置位失败不影响本轮（下次回合再试） */ }
        // v1.12.15：新用户输入 = 上一任务周期结束——未决跟随窗口结算为 ignored（本周期无显式跟随信号）
        try {
          const dm = readMonitorData();
          if (dm.hintOpen) {
            dm.ignored += 1;
            dm.hintOpen = null;
            scheduleMonitorSave();
          }
          settleTurnProfile(sid);  // v1.12.16: 新用户输入=上一任务周期结束，落盘轮次画像；v2.0.1 按会话分桶结算
          // v2.4.30（W 类）：用户新回合到达 → 看门狗计数复位（用户在环时不触发；无用户介入计时从本回合起算）
          const WB = spiralBucket(sid);
          WB.lastUserAt = Date.now();
          WB.stepsSinceUser = 0;
          // v2.6.0（D 级熔断）：用户新消息到达 → 熔断态全量复位（suspect 键清空、deny 计数归零、fullStop/连续计数清）——用户穿插视为在环，终止打转判定
          if (WB.brk) { WB.brk.suspectKeys = new Set(); WB.brk.denyN = 0; WB.brk.fullStop = false; WB.brk.seq = 0; WB.brk.seqKey = ""; }
        } catch (e) {}
        // v1.12.10：检查/提醒解耦 —— 每条输入都跑关键词检查（免费）；提醒受两道闸：
        //   ① 冷却：距上次提醒至少隔 1 条用户输入（用户定：第 1 条提醒了，最早第 3 条再提醒）
        //   ② 领域去重：同会话同记忆文件只提醒 1 次；冷却期内的新领域保留不标已见，冷却后补提醒
        const seq = (MEMORY_HINT_THROTTLE.get(sid) || 0) + 1;
        MEMORY_HINT_THROTTLE.set(sid, seq);
        const lastSeq = MEMORY_HINT_LAST_SEQ.get(sid) || -999;
        const inCooldown = (seq - lastSeq) < 2;
        const userText = hintTextOf(messages);
        if (!userText) return decision;
        const hitsAll = matchMemoryHints(userText);
        const seenDom = MEMORY_HINT_SEEN.get(sid) || new Set();
        const memHits = hitsAll.filter((h) => !seenDom.has(h.file));
        if (memHits.length === 0) return decision;      // 无新领域
        if (inCooldown) return decision;                // 冷却中：保留待办，之后补提醒
        // 记忆命中 → 顺便查相关 skill（只在命中记忆时提示，避免误提醒）
        const skillHits = [];
        try {
          const skills = await ctx.skills.list();
          const words = userText.match(/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
          for (const s of skills || []) {
            const hay = ((s.name || "") + " " + (s.description || "") + " " + (s.whenToUse || "")).toLowerCase();
            for (const w of words.slice(0, 12)) {
              if (w.length >= 2 && hay.includes(w.toLowerCase())) { skillHits.push(s.name); break; }
            }
            if (skillHits.length >= 3) break;
          }
        } catch (e) { /* skills 服务不可用则只给记忆提示 */ }

        // v2.4.26（用户拍板）：skill 优先——命中技能时先加载技能按其流程；记忆仅背景参考。文案简要。
        const memLines = memHits.map(h => "- 记忆: memory_search " + JSON.stringify(h.name) + "（" + h.file + "，踩坑/现成脚本/约定" + (h.parts && h.parts.length ? "；触发词: " + h.parts.join("、") : "") + "）").join("\n");
        const skillLine = skillHits.length > 0 ? "技能命中：" + skillHits.slice(0, 2).map((s) => "「" + s + "」先加载 SKILL.md 按其流程").join("；") + "。" : "";
        const hintText = "<system-reminder>\n【dsh-memory 提示】" +
          (skillLine || ("此任务可能涉及已知领域，先查再动手：\n" + memLines)) +
          (skillLine && memHits.length > 0 ? "\n记忆仅作背景参考（memory_search " + JSON.stringify(memHits[0].name) + "）。" : "") +
          "\n（纯读零成本；若无关可忽略本条）\n</system-reminder>";
        // v1.12.10：记录本次提醒序号 + 标记领域已见
        MEMORY_HINT_LAST_SEQ.set(sid, seq);
        memHits.forEach((h) => seenDom.add(h.file));
        MEMORY_HINT_SEEN.set(sid, seenDom);
        // 监控：记录 A 类提醒（打开跟随判定窗口）
        monitorHintA(memHits[0] && memHits[0].name ? memHits[0].name : "?");
        // v2.4.1：注入改「pre-step 决策直入当轮请求」——不再 setTimeout(0)+agent.inject（agent.inject → next-step 队列，
        //   下一 step/下回合才被 claim 送达；单步回合（纯文本答）提示必滞后一轮，且提示 append 进会话历史诱发多余模型回合）。
        //   新方式：改写 PreStepDecision.enter.messages 追加 hint —— hint 只存在于当轮模型请求尾部，不进 inbox/会话历史：
        //   ①同轮可见（模型当轮即响应"先查记忆"）②动态提示不再留入历史前缀 → 不破坏前缀缓存 ③不碰 inbox/session → 无 v10.5 重入风险。
        //   reject 决策无 messages，透传不注入。
        if (decision.kind === "enter") {
          const hintMsg = makeMessage(hintText);
          return { ...decision, messages: [...(decision.messages || []), hintMsg] };
        }
        return decision;
      } catch (e) {
        return next ? await next() : undefined;
      }
    });

    // v0.5（P0c 方案 A）：回归提醒注入——独立 pre-step handler，消费 REGRESSION_QUEUE，
    // 不受 step 限制（B/C 触发与窗口再现都发生在 step>1 的工具轮）；顶层会话 + 普通子代理生效（v2.4.27 放开 normal）。
    // 决策直入当轮请求（与 A 类同机制）：提示不进 inbox/会话历史、不破坏前缀缓存、无重入风险。
    ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
      try {
        const decision = await next();
        if (!agent) return decision;
        if (PLUGIN_CFG.regressionEnabled === false) return decision;
        const sid = (agent.session && agent.session.id) || "?";
        if (!sid || sid === "?") return decision;
        const pending = peekRegressionReminder(sid);
        if (isPluginSubagent(sid) && !(pending && String(pending.sig).startsWith("PL:"))) return decision;    // v2.4.27：插件子代理默认不消费（隔离）；v2.4.32：PL: 前缀（预算打转 MILD/STRONG）放行——dream/归档子代理无用户回合，仅此通道可达
        if (!pending) return decision;
        if (decision.kind !== "enter") return decision;    // reject 决策无 messages，透传不注入
        dequeueRegressionReminder(sid);
        const hintMsg = makeMessage(pending.text);
        return { ...decision, messages: [...(decision.messages || []), hintMsg] };
      } catch (e) {
        return next ? await next() : undefined;
      }
    });

    // v2.4.2：当日 md 注入面维护检查——独立于 A 类提醒，挂在 user/message 落地时（不占用 pre-step 决策链）。
    // 触发源 = 用户新消息（pre-step step1 已在上方处理 A 类；此处挂 agent/pre-step 之外的 user 输入事件不可靠），
    // 故在 pre-step step1 尾部同步做一次纯读检查（毫秒级），命中阈值则延迟 spawn 合并维护——不阻塞当轮模型请求。
    ctx.on("agent/pre-step", async ({ agent, messages: stepMsgs, step }, next) => {
      try {
        const decision = await next();
        if (step !== 1 || !agent) return decision;
        if (!isTopLevelSession(agent)) return decision;
        if (MAINT_RUNNING) return decision;   // 合并维护进行中，跳过检查（防排队堆积）
        // 只检查今天日期文件（当天会话 md）；其他日期由维护提醒/手动整理覆盖
        const todayName = dateStr(new Date()) + ".md";
        let needMerge = false;
        try {
          needMerge = maintRetryAllow(todayName) && needMaintenanceMerge(todayName);   // v2.4.5：退避闸门前置，冷却中不做无谓读盘
        } catch (e) { needMerge = false; }
        if (needMerge) {
          // 延迟到 pre-step 窗口外 spawn，避免阻塞模型请求链
          setTimeout(() => {
            try {
              runMaintenanceMerge(todayName, "", agent, (agent.session && agent.session.id) || "");
            } catch (e) {}
          }, 0);
        }
        return decision;
      } catch (e) {
        return next ? await next() : undefined;
      }
    });
ctx.on("tools/result", (exec, result) => {
      // v1.12.0：监控记录 + 判断 B/C
      try {
        if (!exec || !result) return;
        const toolName = exec.tool || exec.name || "other";
        const agentSess = exec.agent && exec.agent.session;
        const spSid = (agentSess && agentSess.id) || "?";
        // 1) 监控：记录工具调用；memory_search/skill 触发查询统计与跟随判定
        if (toolName === "memory_search") {
          const minp = exec.arguments || exec.input || {};  // v1.12.13: 真实字段是 arguments（exec.input 不存在导致查询词恒空）
          const q = (minp.query || minp.name) ? String(minp.query || minp.name) : "";
          monitorToolCall("memory_search", { query: q }, null, spSid);   // v2.4.24（审查 P1-2）：签名 (toolName,meta,args,sid)——spSid 误传 args 位导致 D 类跟进复位查不到桶（SPIRAL_REMIND_AT.get(undefined)）
        } else if (toolName === "skill") {
          monitorToolCall("skill", null, null, spSid);
        } else {
          monitorToolCall(toolName, null, exec.arguments, spSid);
        }
        // v2.4.28（D4）→v2.6.1（V0.2 P0-2）：看护统一触达——所有工具 result 走 guardTouch：
        // 交付工具（dream_patch/archive_checkpoint）解析 wrote>0 判真实落盘 → 落盘续期+重置活动预算 actN；
        // 其余工具（read/grep/glob/memory_search/preview 等）计活动并续期（防换壳空转由 GUARD_ACTIVITY_BUDGET 兜底）。
        // 独立 try/catch + 早退前段，不干扰既有监控/D 类段；非插件 sid 无 guard 命中 → no-op、无副作用（越权面边界）。
        try {
          if (spSid && spSid !== "?") {
            let wroteN = 0;
            if (!result.isError && (toolName === "memory_dream_patch" || toolName === "memory_archive_checkpoint")) {
              const okTxt = Array.isArray(result.content) ? result.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ") : "";
              wroteN = (() => { try { const o = JSON.parse(okTxt || "{}"); return Number(o && (o.wrote || o.applied && o.applied.length)) || 0; } catch (e) { return 0; } })();
            }
            guardTouch(spSid, wroteN);
          }
        } catch (e) {}
        // v2.4.32（P0-5）：预算循环检测——preview/patch 双路径，MILD/STRONG 经 PL: 队列投递给 dream 子代理
        // （置于 L6359 B/C 早退之前：被拒调用 isError=false 也必派发 tools/result，宿主 notifyResult 每个结果均 emit）。
        // 独立桶不碰 spiral 状态；重置信号=该 (sid,file) 成功落盘 wrote>0（patch 尝试不重置）。
        try {
          if (toolName === "memory_size_preview" || toolName === "memory_dream_patch") {
            const args0 = exec.arguments || {};
            const file0 = String((args0 && (args0.file || (args0.patches && args0.patches[0] && args0.patches[0].file))) || "");
            if (file0) {
              let bl = BUDGET_LOOP.get(spSid);
              if (!bl) { bl = { byFile: new Map() }; BUDGET_LOOP.set(spSid, bl); }
              let fr = bl.byFile.get(file0);
              if (!fr) { fr = { previewN: 0, patchFailN: 0, lastStrongAt: 0 }; bl.byFile.set(file0, fr); }
              let kindHit = null;
              if (toolName === "memory_size_preview") {
                fr.previewN += 1;
                if (fr.previewN === 3) kindHit = "mild";
                else if (fr.previewN >= 4) kindHit = "strong";   // P0-4 拒写同刻起持续 STRONG（60s 冷却重发，防单发被无视）
              } else {
                const okT = Array.isArray(result.content) ? result.content.filter((x) => x && x.type === "text" && typeof x.text === "string").map((x) => x.text).join(" ") : "";
                let wroteN2 = 0, errTxt = "";
                try { const o = JSON.parse(okT || "{}"); wroteN2 = Number(o && (o.wrote || (o.applied && o.applied.length))) || 0; if (o && Array.isArray(o.errors)) errTxt = o.errors.join(" "); } catch (eJ) {}
                if (wroteN2 > 0) { bl.byFile.delete(file0); if (bl.byFile.size === 0) BUDGET_LOOP.delete(spSid); }
                // 预算类拒写谓词（v2.4.32 收紧，双保险）：errors 含 超预算|超目标 且不含 围栏|结构违规 且该文件有预算
                else if (errTxt && /超预算|超目标/.test(errTxt) && !/围栏|结构违规/.test(errTxt) && budgetOf(file0)) {
                  fr.patchFailN += 1;
                  if (fr.patchFailN === 2) kindHit = "mild";
                  else if (fr.patchFailN >= 4) kindHit = "strong";
                }
              }
              if (kindHit) {
                const nowMs = Date.now();
                if (kindHit === "strong" && nowMs - fr.lastStrongAt < BUDGET_LOOP_STRONG_CD) kindHit = null;
                if (kindHit === "strong" && kindHit !== null) fr.lastStrongAt = nowMs;
                if (kindHit) {
                  const isStrong = kindHit === "strong";
                  const hintTx = isStrong
                    ? "<system-reminder>\n【dsh-memory 提示·预算打转·硬】仍无落盘。放弃该文件，立即提交其他文件的补丁；3 分钟内无任何 patch 将被硬停。\n</system-reminder>"
                    : "<system-reminder>\n【dsh-memory 提示·预算打转】检测到对" + (toolName === "memory_size_preview" ? "同一文件连续 ≥3 次 preview" : "同一文件连续 ≥2 次预算拒写") + "未落盘——打转。立即停止" + (toolName === "memory_size_preview" ? "preview" : "逐条微调") + "：按最近一次返回的差数整节下沉一次成型提交 memory_dream_patch；或放弃该文件先落盘其他内容。\n</system-reminder>";
                  enqueueRegressionReminder(spSid, "PL:budget", hintTx);
                  if (isStrong) {
                    // v2.6.1（V0.2 P0-1）：STRONG 契约统一走 guardGrace——置 graced + graceT=3min 且活动续期不得触碰。
                    // 旧实现直接重设 hardT=+3min 会被 guardRenew 的 arm()（每次活动/write 都无条件 clearTimeout+重设全额）
                    // 静默取消——「3 分钟内无 patch 将硬停」被一次 read 顶掉、看护失效（审核 P0-1 根因）。
                    try { guardGrace(spSid, "strong"); } catch (eG) {}
                  }
                }
              }
              if (BUDGET_LOOP.size > BUDGET_LOOP_MAX) {   // 防长期实例积累（每轮 dream 新 spSid）
                let oldS = null, oldT = Infinity;
                for (const [s, en] of BUDGET_LOOP) { let mt = 0; for (const x of en.byFile.values()) { if (x.lastStrongAt > mt) mt = x.lastStrongAt; } if (mt < oldT) { oldT = mt; oldS = s; } }
                if (oldS !== null) BUDGET_LOOP.delete(oldS);
              }
            }
          }
        } catch (e) {}
        // v1.12.16: 过程信号探针（影子）——覆盖被 isError 漏掉的失败形态（catch 吞错/exit码）
        try {
          const cw = agentSess && ((agentSess.header && agentSess.header.cwd) || agentSess.cwd);
          if (cw) spiralBucket(spSid).ws = String(cw).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "?";   // v1.12.16.1 诊断属性；v2.0.1 写入会话桶
          // v2.4.30（E 类）：spiralObserve 返回 {d,e}——D/E 各自周期首命，调用点单 gate（D>E 优先级，架构 P0）
          const hit = spiralObserve(toolName, exec.arguments, result, !!result.isError, spSid);
          // W 看门狗（v2.4.30）：无用户介入计数递增（pre-step step1 复位）
          const Bw = spiralBucket(spSid);
          Bw.stepsSinceUser = (Bw.stepsSinceUser || 0) + 1;
          const wET = effectiveSpiralThresh();
          // v2.0.6: D 类提醒智能闸门——周期首次命中 × 开关 × 指数退避冷却（跟进复位/2h归零）× 批量进展豁免
          if (hit && hit.d && PLUGIN_CFG.spiralRemind) {
            const nowMs = Date.now();
            const stR = SPIRAL_REMIND_AT.get(spSid) || { ts: 0, streak: 0 };
            const B2 = spiralBucket(spSid);
            const uniq = new Set(B2.win.map((w) => w.resKey)).size;
            const okN = B2.win.filter((w) => !w.neg).length;
            // 批量进展豁免：窗内结果多样且成功过半 → 批量循环而非空转，只记录不扰
            const batchLike = B2.win.length > 0 && uniq >= Math.ceil(B2.win.length / 2) && okN * 2 >= B2.win.length;
            // v0.5（P0a-5）：退避判定抽为 backoffAllowed 共用（行为等价；streak 归零/指数封顶/批量豁免语义不变）
            const gate = backoffAllowed(stR, wET.cooldownMin * 60000, nowMs, batchLike);
            if (gate.allowed) {
              SPIRAL_REMIND_AT.set(spSid, { ts: nowMs, streak: gate.streak + 1 });
              monitorHintD();
              // v2.4.27（子代理提醒放开）：D 类改 pre-step messages 直入不留痕（同 B/C/A 机制——不进 inbox/会话历史、
              //   不破坏前缀缓存、无 ghost 轮），并从顶层闸放开到普通子代理（normal）——实证 04ee9d05 普通任务子代理
              //   打转 47 分钟无止损；插件子代理（plugin）仍只计 monitor 不注入（隔离，D 会误报其设计内合法重试）。
              const kind2 = hintKindOf(exec.agent, spSid);
              if (kind2 !== 'plugin') {
                const hintD = "<system-reminder>\n【dsh-memory 提示·LLM循环试错】检测到同类调用反复且负面结果占比高——大概率方向不对。建议暂停硬试：memory_search 搜当前任务关键词 + 查技能目录有无对应 skill，或换个思路/向用户确认。\n</system-reminder>";
                enqueueRegressionReminder(spSid, 'D:loop', hintD);
              }
            }
          } else if (hit && hit.e && PLUGIN_CFG.spiralRemind) {
            // v2.4.30（E 类）：成功同质循环——同一 SPIRAL_REMIND_AT 冷却桶（防 D/E 交替轰炸；无 batchLike 豁免——
            //   E 簇内同质判定天然是反向批量防线，见设计文档 §2.2）
            const nowMs = Date.now();
            const stR = SPIRAL_REMIND_AT.get(spSid) || { ts: 0, streak: 0 };
            const gate = backoffAllowed(stR, wET.cooldownMin * 60000, nowMs, false);
            if (gate.allowed) {
              SPIRAL_REMIND_AT.set(spSid, { ts: nowMs, streak: gate.streak + 1 });
              monitorHintE();
              const kind2 = hintKindOf(exec.agent, spSid);
              if (kind2 !== 'plugin') {
                // N=簇大小；从样本带出或近似为窗内计数（E 样本已落 clusterN）
                const Ewin = spiralBucket(spSid).win;
                const eN = Ewin.length ? Ewin.length : 0;
                const hintE = "<system-reminder>\n【dsh-memory 提示·成功同质循环】同一命令/调用已成功重复 " + eN + " 次、输出几乎没变——成功重复 ≠ 有进展。若任务已完成或卡在重复执行，建议暂停：确认产物是否到位，或换个思路/向用户核对。\n</system-reminder>";
                enqueueRegressionReminder(spSid, 'E:loop', hintE);
              }
            }
          }
          // v2.4.30（W 类看门狗）：无用户介入长空转——不依赖同质/重复，只看用户回合后步数+墙钟。
          // 触发优先级最低（D/E 命中当轮不叠加）；plugin 子代理隔离（其长任务是设计内行为，另有 guard 看护）。
          if (!(hit && hit.d) && !(hit && hit.e) && PLUGIN_CFG.spiralRemind) {
            const nowMs = Date.now();
            const lastUser = Bw.lastUserAt || 0;
            const stW = WATCH_REMIND_AT.get(spSid) || { ts: 0 };
            const sinceUserSteps = Bw.stepsSinceUser || 0;
            const sinceUserMs = lastUser > 0 ? nowMs - lastUser : 0;
            const coolMs = wET.watchCooldownMin * 60000;
            if (sinceUserSteps >= wET.watchSteps && sinceUserMs >= wET.watchSecs * 1000 && (nowMs - (stW.ts || 0)) >= coolMs) {
              WATCH_REMIND_AT.set(spSid, { ts: nowMs });
              monitorHintW();   // 计数+开窗（plugin 与非 plugin 都计，语义同 D 的 monitorHintD 先行）
              // 样本落盘（watchEvents 独立数组，不混入 spiralEvents——无同质/重复语义，防污染 D/E 校准）
              try {
                const wd = readMonitorData();
                if (!Array.isArray(wd.watchEvents)) wd.watchEvents = [];
                wd.watchEvents.push({ t: nowMs, ws: Bw.ws, steps: sinceUserSteps, wallSecs: Math.round(sinceUserMs / 1000), topTool: toolName });
                if (wd.watchEvents.length > 100) wd.watchEvents = wd.watchEvents.slice(-100);
                scheduleMonitorSave();
              } catch (e2) {}
              const kind2 = hintKindOf(exec.agent, spSid);
              if (kind2 !== 'plugin') {
                const hintW = "<system-reminder>\n【dsh-memory 提示·无介入长空转】距你上次输入已 " + Math.round(sinceUserMs / 60000) + " 分钟、无介入持续 " + sinceUserSteps + " 步——若任务需你决策请暂停确认；若在预期长任务中，忽略此条即可（本任务不再重复提醒）。\n</system-reminder>";
                enqueueRegressionReminder(spSid, 'W:noop', hintW);
              }
            }
          }
        } catch (e) {}
        // v2.6.0（D 级熔断）：结果侧武装 suspect（连续同指纹重复 + 产出静止 → 进 suspectKeys，供 pre-execute deny 读取）
        try { armBreakSuspect(toolName, exec.arguments, result, !!result.isError, spSid); } catch (e) {}
        // v1.12.17: dream 心跳——发起后第一个出现的裸 UUID 会话即整合子代理
        try {
          if (DREAM_TRACK && DREAM_PATCH) {
            const sid2 = exec.agent && exec.agent.session && exec.agent.session.id;
            if (sid2 && sid2.indexOf("session-") !== 0) {
              if (!DREAM_TRACK.sessionId) DREAM_TRACK.sessionId = sid2;
              if (sid2 === DREAM_TRACK.sessionId) {
                DREAM_TRACK.steps += 1;
                if (DREAM_TRACK.steps % 5 === 1) {
                  DREAM_PATCH({ steps: DREAM_TRACK.steps, lastTool: toolName, elapsedMin: Math.round(((Date.now() - DREAM_TRACK.since) / 6000)) / 100 });
                }
              }
            }
          }
        } catch (e) {}
        // v0.5（P0b-3）：回归被动监测——成功轮（推进 cleanSteps + 捕捉 solution）先于 isError 短路执行
        try {
          if (PLUGIN_CFG.regressionEnabled !== false) {
            const okTxt = (() => {
              if (Array.isArray(result.content)) return result.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join(" ");
              try { return JSON.stringify(result.value || result).slice(0, 300); } catch (e) { return "ok"; }
            })();
            const sr = lessonObserveStep(spSid, toolName, !!result.isError, null, okTxt, Date.now());
            if (sr.closed.length > 0) { for (const ce of sr.closed) { lessonEvent(ce.sig, "closed"); lessonCounters().closed += 1; } }
          }
        } catch (e) {}
        // v0.5（P1-3）：kicked 软监管——回归窗口内 ask_user_question 计数（不拦，仅轻提醒一次）。
        // 窗口=该 sid 有 open 条目；askCount 存条目（仅本会话轮累计）；≥阈值 且 sig 近 24h 仍再现 → 入队提醒一次 + lessonKicked。
        try {
          if (PLUGIN_CFG.regressionEnabled !== false && toolName === "ask_user_question" && !result.isError) {
            const P = readLessonPending();
            const mine = P.entries.filter((e) => e.sessionId === spSid && e.state === "open");
            const nowK = Date.now();
            for (const e of mine) {
              if (e.kickedNotified === true) continue;
              e.askCount = (e.askCount || 0) + 1;
              if (e.askCount >= LESSON_KICK_THRESHOLD && (nowK - (e.lastSeenAt || 0)) < 24 * 3600000) {
                e.kickedNotified = true;
                lessonEvent(e.sig, "kicked");
                lessonCounters().kicked += 1;
                const kickHint = "<system-reminder>\n【dsh-memory 提示】该错误（" + e.sig.slice(0, 60) + "）请优先依据工具结果自行判断；确需用户输入再问（回归记录持续跟踪中）。\n</system-reminder>";
                enqueueRegressionReminder(spSid, e.sig, kickHint);
              }
            }
            if (mine.length > 0) scheduleLessonSave(false);
          }
        } catch (e) {}
        // 2) 判断 B/C：仅工具执行失败时
        if (!result.isError) return;
        const agent = exec.agent;
        if (!agent || typeof agent.inject !== "function") return;
        const sid = (agent.session && agent.session.id) || "?";
        let raw = "";
        if (Array.isArray(result.content)) {
          raw = result.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join(" ");
        }
        if (!raw) { try { raw = JSON.stringify(result.value || result).slice(0, 300); } catch (e) { raw = "tool-error"; } }
        // v2.2.10 剥壳归一（v0.5 提取为 normalizeErrorSigFromRaw 共用）
        const norm = normalizeErrorSigFromRaw(raw);
        if (!norm) return;
        const disp = norm.disp;
        const sig = norm.sig;
        const nowCnt = Date.now();
        const echo = MEMORY_HINT_ECHO.get(sid);
        if (echo && echo.sig === sig && nowCnt - echo.t < 1000) return;   // 同一次失败的另一条形态，不重复计数
        MEMORY_HINT_ECHO.set(sid, { sig, t: nowCnt });
        // v0.5（P0b-3）：失败轮喂回归监测（sig 再现 → cleanSteps 归零）
        try {
          if (PLUGIN_CFG.regressionEnabled !== false) {
            const sr = lessonObserveStep(sid, toolName, true, sig, null, nowCnt);
            if (sr.closed.length > 0) { for (const ce of sr.closed) { lessonEvent(ce.sig, "closed"); lessonCounters().closed += 1; } }
          }
        } catch (e) {}
        let counts = MEMORY_HINT_ERRORS.get(sid);
        if (!counts) { counts = new Map(); MEMORY_HINT_ERRORS.set(sid, counts); }
        const c = (counts.get(sig) || 0) + 1;   // v2.4.24（审查 P0-3）：计数计算上移——原先声明在 P0c 块之后，块内引用 c 触发 TDZ 恒抛（catch 吞掉）→ c>3 升级提醒从未执行
        // v0.5（P0c）：窗口内再现退避提醒——回归窗口活跃（该 (sid,sig) 有 open 条目）且已过 B/C 两档（c>3），
        // 后续反复由回归提醒接管：按 REGRESSION_AT 指数退避（2h 归零/封顶 60 分）入队，pre-step 当轮直入
        try {
          if (PLUGIN_CFG.regressionEnabled !== false) {
            const rEntry = (() => { const P = readLessonPending(); return P.entries.find((e) => e.sessionId === sid && e.sig === sig && e.state === "open"); })();
            if (rEntry && (c || 0) > 3) {
              const rk = sid + "\u0001" + sig;
              const rBucket = REGRESSION_AT.get(rk) || { ts: 0, streak: 0 };
              const rGate = backoffAllowed(rBucket, 10 * 60000, nowCnt, undefined);   // 回归退避基数 10 分（指数封顶 60 分、2h 归零）
              if (rGate.allowed) {
                REGRESSION_AT.set(rk, { ts: nowCnt, streak: rGate.streak + 1 });
                const reHint = "<system-reminder>\n【dsh-memory 提示】该错误仍反复出现（" + disp + "）——回归记录中。请换思路：memory_search 搜错误串 + 查技能目录 + 检查是否已改用什么替代方案。\n</system-reminder>";
                enqueueRegressionReminder(sid, sig, reHint);
              }
            }
          }
        } catch (e) {}
        counts.set(sig, c);   // v2.4.24：c 已在 P0c 块前计算（TDZ 修复），此处仅写入
        if (counts.size > 50) { for (const k of counts.keys()) { if (counts.get(k) < c) counts.delete(k); } }
        // v2.2.10：异签名字段 10 分钟冷却——一个错误正在处置时，另一处旧账的错误不再插队轰炸；
        // 同签名升级（B→C）不受冷却限制，保持原有有界语义（每签名至多 B 一次 + C 一次）
        if (c === 2 || c === 3) {
          const prevBC = MEMORY_HINT_BC_LAST.get(sid);
          if (prevBC && prevBC.sig !== sig && Date.now() - prevBC.t < HINT_BC_COOLDOWN_MS) return;
          MEMORY_HINT_BC_LAST.set(sid, { t: Date.now(), sig });
          monitorHintBC(c === 2 ? "B" : "C", sig);
          // v2.4.27（子代理提醒放开）：会话类别三分——top=捕捉上下文落 pending；plugin=插件子代理不捕捉不注入只计 monitor；
          //   normal=普通子代理不落 pending lessons（回归沉淀只服务顶层，v0.5 P0b-4 语义不变）但注入 B/C 即时打断
          const kind = hintKindOf(agent, sid);
          if (PLUGIN_CFG.regressionEnabled !== false && kind === 'top') {
            try {
              const ctxEntry = captureLessonContext(sig, sid, toolName, exec.arguments, raw, nowCnt);
              if (ctxEntry) { lessonEvent(sig, "open"); lessonCounters().open += 1; }
            } catch (e) {}
          }
          if (kind === 'plugin') return;   // v2.4.27：插件子代理不注入 B/C（隔离——只计 monitor）
          const hint = c === 2
            ? "<system-reminder>\n【dsh-memory 提示】工具报错重复出现（" + disp + "）——大概率是以前踩过的坑。建议先 memory_search 搜该错误串 + 技能目录查相关 skill，再继续。\n</system-reminder>"
            : "<system-reminder>\n【dsh-memory 提示】同一工具错误已连续出现 3 次且未见根因——暂停硬试，强制建议：memory_search 搜该错误串 + 加载相关 skill（记忆里有踩坑记录大概率直接给出解法）。\n</system-reminder>";
          // v0.5（P0c 方案 A）：提醒入队（pre-step handler 当轮直入），不直接 inject——inject 晚一轮且进会话历史
          enqueueRegressionReminder(sid, sig, hint);
        }
      } catch (e) { /* 监控/统计失败不影响会话 */ }
    });

// v2.6.0（D 级打转熔断）：D2 拒调 —— tools/pre-execute 拦截重复 suspect 调用，直接 deny（短路 veto）
ctx.on("tools/pre-execute", async ({ agent, exec }, next) => {
  try {
    if (!PLUGIN_CFG.spiralBreak || PLUGIN_CFG.brkLevel < 2) return next();
    const spSid = (exec && exec.agent && exec.agent.session && exec.agent.session.id) || "?";
    // 终检③：plugin 子代理先放行，绝不执法
    if (hintKindOf(exec.agent, spSid) === "plugin") return next();
    const brk = breakState(spSid);
    if (!brk || !brk.suspectKeys) return next();
    // 计算当前调用的指纹键
    let aTxt = "";
    try { aTxt = String(typeof exec.arguments === "string" ? exec.arguments : JSON.stringify(exec.arguments) || ""); } catch (e) {}
    aTxt = aTxt.replace(/\s+/g, " ").slice(0, 600);
    const toolName = exec.tool || exec.name || "other";
    const argsFp = createHash("sha256").update(aTxt).digest("hex").slice(0, 16);
    const key = toolName + ":" + argsFp;
    if (!brk.suspectKeys.has(key)) return next();
    // 命中 suspect → deny（拒绝该次调用，模型收到模糊 reason）
    brk.denyN += 1;
    monitorHintBrk(2, toolName, "suspect repeat denied", "deny");
    // 达上限 → fullStop 标记（供 D3 pre-step reject 读取）
    const ET = effectiveSpiralThresh();
    const brkMaxDeny = Math.round(ET.brkMaxDeny || BRK_MAX_DENY);
    if (brk.denyN >= brkMaxDeny) brk.fullStop = true;
    return { kind: "deny", reason: "检测到同类调用反复且无实质进展——请换思路或向用户确认。" };
  } catch (e) { return next(); }
});

// v2.6.0（D 级打转熔断）：D3 停轮 —— agent/pre-step reject 终止本轮；说明走 agent.inject 下次唤醒注入
ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
  try {
    if (!PLUGIN_CFG.spiralBreak || PLUGIN_CFG.brkLevel < 3) return next();
    const spSid = (agent && agent.session && agent.session.id) || "?";
    // plugin 子代理放行
    if (hintKindOf(agent, spSid) === "plugin") return next();
    const brk = breakState(spSid);
    if (!brk || !brk.fullStop) return next();
    // 有直接用户消息一律放行
    const directUser = Array.isArray(messages) && messages.some((m) => m && m.source && m.source.kind === "user");
    if (directUser) return next();
    // 停轮：reject 本轮（blocked 收尾）
    monitorHintBrk(3, null, "full stop - turn rejected", "reject");
    // 说明注入：下次唤醒时 inject
    try {
      const hint = "<system-reminder>\n【dsh-memory 提示·熔断停轮】检测到持续循环且多次拒调无效——本轮已强制停止。请重新审视任务方向或向用户确认。\n</system-reminder>";
      agent.inject(makeMessage(hint));
    } catch (e) {}
    // 复位熔断态（避免下轮立即再停）
    brk.fullStop = false;
    brk.denyN = 0;
    brk.suspectKeys = new Set();
    return { kind: "reject" };
  } catch (e) { return next(); }
});

ctx.on("session/event", (session, event) => {
      try {
        if (!event || event.type !== "compaction/summary") return;
        // 只处理顶层主会话（排除子代理）——v10.3 改查 header.origin，多主会话都归档
        if (session.header && session.header.origin === 'subagent') return;
        const data = event.data || {};
        const compactionId = data.compactionId;
        if (!compactionId || archivedCompactionIds.has(compactionId)) return;
        const blocks = data.summary;
        if (!Array.isArray(blocks) || blocks.length === 0) return;
        const text = blocks
          .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
          .join("\n")
          .trim();
        if (!text) return;
        archivedCompactionIds.add(compactionId);
        const fname = dateStr(new Date()) + ".md";

        // v2.4.16(compaction-dump 退役)：不再把宿主压缩摘要抄进当日 md（dump 停写）——
        // 摘要与会话日志 compaction/summary 事件逐字相同（审批实证 a4d22652），当日 md 只保留要点区；
        // 原文防丢靠会话日志；这里只负责：intent 检查点（要点区）+ maint 注入面检查 + 记忆刷新提示。
        const parentAttempt = agentsBySession.get(session.id);
        setTimeout(() => {
          try { spawnIntentCheckpoint(compactionId, text, fname, parentAttempt, session.id); }
          catch (e) { cerr("[dsh-memory] 意图检查点调度失败:", e && e.message ? e.message : String(e)); }
        }, 0);

        // v2.4.2：compact 路径同样检查注入面，超阈则触发合并维护（与 pre-step 检查共用阈值，互为兜底：
        // 从不 compact 的会话靠 pre-step 用户消息触发；正常 compact 的会话在这里顺带收敛）。
        // 与意图检查点隔一个 setTimeout 微任务，避免同一 tick 双 spawn 争抢 subagents 通道。
        setTimeout(() => {
          try { if (maintRetryAllow(fname) && needMaintenanceMerge(fname)) runMaintenanceMerge(fname, text, parentAttempt, session.id); }   // v2.4.5：退避闸门
          catch (e) { cerr("[dsh-memory] 合并维护调度失败:", e && e.message ? e.message : String(e)); }
        }, 10);

        // v2.4.16(compaction-dump 退役)：不再注入「压缩检查点归档提醒」（已停写 dump，无归档动作；
        // intent 落盘失败由 spawnIntentCheckpoint 内部日志+幂等 marker 兜底），只注入记忆刷新提示。
        const agent = agentsBySession.get(session.id);
        if (agent && typeof agent.inject === "function") {
          const refreshNote =
            "<system-reminder>\n【dsh-memory 记忆刷新提示】会话开始后，记忆库文件（global.md / index.md / knowledge/ / projects/ / sessions/）可能已被其他会话或本会话更新。\n" +
            "当前上下文中注入的记忆是会话开始时的快照。如需最新内容，用 memory_search 工具实时查询（如 memory_search 查 global / index / 具体主题）；\n" +
            "也可用 read 工具直接读 ~/.dsh/memory/ 下文件。\n" +
            "若你正准备写入/追加记忆，先 memory_search 或 read 读全量确认现状，避免覆盖其他会话的最新改动。\n</system-reminder>";

          // v10.5：session/event 在 session.append 发布窗口（appending=true）内同步派发；
          // 此时任何二次 session.append（agent.inject 经 Inbox.mutate 会 append 'agent/inbox/spliced'）
          // 都会触发 "session append cannot reenter" 重入异常，导致提醒注入失败。
          // 故所有 inject 推迟到 setTimeout(0)（发布窗口之外的 macrotask）执行。
          const targetAgent = agent;
          setTimeout(() => {
            try {
              targetAgent.inject(makeMessage(refreshNote));
              clog("[dsh-memory] 已注入记忆刷新提示（compact 后）");
            } catch (e) {
              cerr("[dsh-memory] 压缩提醒延迟注入失败:", e && e.message ? e.message : String(e));
            }
          }, 0);
        } else {
          clog("[dsh-memory] 压缩事件已处理（intent/maint 已调度，会话 agent 不可用，跳过刷新提示）");
        }
      } catch (e) {
        cerr("[dsh-memory] session/event 处理异常:", e && e.message ? e.message : String(e));
      }
    });

    
    const toolSvc = ctx.get("tools");
    // v2.3.2(archive-tool)：归档交付工具——子代理提交结构化记忆检查点，插件现场校验（含 A5 完整性）+ 落盘，错误清单回显
    if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "memory_archive_checkpoint",
          description: "提交漏网会话记忆归档检查点（仅 dsh-memory 归档子代理使用）：参数 { blocks: [ { file, sessionId, title, points[], skip?, reason? } ] }。file=记忆库相对路径（sessions/|projects/ 前缀）；sessionId=短 id 清单中的 id 逐字取用；有价值会话填 title+points（3-6 条要点，精确字面量逐字保留）；无价值会话填 skip=true+reason。插件现场校验完整性与落盘：缺声明会话、越界路径、缺 points 会返回错误清单，请修正后再次调用（可多次调用累计覆盖全部会话）。",
          parameters: {
            type: "object",
            properties: {
              blocks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string", description: "sessions/|projects/ 前缀相对路径" },
                    sessionId: { type: "string", description: "短 id 清单中的 id（逐字取用）" },
                    title: { type: "string", description: "一句话主题" },
                    points: { type: "array", items: { type: "string" }, description: "3-6 条要点" },
                    skip: { type: "boolean", description: "true=该会话跳过归档，需提供 reason" },
                    reason: { type: "string", description: "跳过理由或归档理由" }
                  },
                  required: ["file", "sessionId"]
                }
              }
            },
            required: ["blocks"]
          },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args) {
            let blocks = null;
            try {
              if (Array.isArray(args)) blocks = args;
              else if (args && typeof args === "object" && Array.isArray(args.blocks)) blocks = args.blocks;
              else if (args && typeof args === "object") { const v = Object.values(args).find((x) => Array.isArray(x)); if (v) blocks = v; }
            } catch (e) {}
            if (!Array.isArray(blocks)) return JSON.stringify({ ok: false, mode: "bad-schema", wrote: 0, errors: ["参数必须是 { blocks: [...] } 数组"] });
            return JSON.stringify(applyArchiveBlocks(blocks));
          }
        });
        clog("[dsh-memory] memory_archive_checkpoint 交付工具已注册（漏网归档专用）");
      } catch (e) { cwarn("[dsh-memory] memory_archive_checkpoint 注册失败:", e && e.message ? e.message : String(e)); }
    }
   // v2.3.2(dream-tool)：声明提前（TDZ），memory_dream_patch 与 memory_search 共用
    // 注册 memory_dream_patch（dream 整合交付工具）
if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "memory_dream_patch",
          description: "提交记忆整合检查点（仅 dream 整合子代理使用）：把要写入记忆库的补丁装进 patches 参数。插件当场校验并落盘：成功返回 wrote 清单；失败返回错误清单（哪一条/哪个字段/为什么），请按清单修正后再次调用（可多次调用，直到全部通过）。file 必须是 ~/.dsh/memory/ 下相对路径（sessions|projects|knowledge|tools/ 或 global.md|index.md）；action ∈ edit|replace|append|delete；edit=局部精确替换（首选），content ≤128KB（edit 免 content、用 old_string/new_string）。",
          parameters: {
            type: "object",
            properties: {
              patches: {
                type: "array",
                description: "补丁数组，每个元素 { file, action, content?, old_string?, new_string?, full_rewrite?, reason? }",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string", description: "记忆库相对路径" },
                    action: { type: "string", enum: ["edit", "replace", "append", "delete"], description: "edit=局部精确替换（首选；old_string→new_string，须唯一命中）/ replace=整文件覆盖（改短须 full_rewrite:true）/ append=末尾追加 / delete=删除 content 精确原文" },
                    content: { type: "string", description: "replace=新全文；append=追加内容；delete=要删除的精确原文块（edit 免用）" },
                    old_string: { type: "string", description: "edit 的精确原文（从 read 全量逐字复制，须唯一命中）" },
                    new_string: { type: "string", description: "edit 的替换后文本（空串=删除该片段）" },
                    full_rewrite: { type: "boolean", description: "replace 显著改短时须显式声明 true（否则被收缩熔断拒写）" },
                    reason: { type: "string", description: "变更理由（留痕）" }
                  },
                  required: ["file", "action"]
                }
              }
            },
            required: ["patches"]
          },
          output: {
            schema: { type: "string" },
            render(_a, v) { return [{ type: "text", text: String(v) }] }
          },
          async execute(args) {
            let patches = null;
            try {
              if (Array.isArray(args)) patches = args;
              else if (args && typeof args === "object" && Array.isArray(args.patches)) patches = args.patches;
              else if (args && typeof args === "object") { const v = Object.values(args).find((x) => Array.isArray(x)); if (v) patches = v; }
            } catch (e) {}
            if (!Array.isArray(patches)) return JSON.stringify({ ok: false, mode: "bad-schema", wrote: 0, errors: ["参数必须是 { patches: [...] } 数组"] });
            const r = applyPatches(patches);
            if (r.ok && r.wrote > 0) LAST_DREAM_WROTE_AT = Date.now();
            return JSON.stringify(r);
          }
        });
        clog("[dsh-memory] memory_dream_patch 交付工具已注册（dream 整合专用）");
      } catch (e) {
        cwarn("[dsh-memory] memory_dream_patch 注册失败:", e && e.message ? e.message : String(e));
      }
    }
    // 注册 memory_search（原工具，toolSvc 声明已提前共用）
    if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "memory_search",
          description: "搜索全局记忆库（~/.dsh/memory/）以召回此前沉淀的持久知识。应当先于「凭记忆猜/直接问用户」使用——跨会话踩坑、项目事实、精确配置（路径/ID/命令/数字）、用户偏好大概率已记录。参数 query：主题关键词（1-3 个最具体词，如 OA日志、智检API、前缀缓存）或记忆文件相对路径（global、index、长沙交易场地…）。检索语义：OR 分词 + 相关度排序——任一单词命中即返回候选，稀有词比泛词更准（避免「配置 参数 数据库」堆泛词）。命中即信：一次查询未中不代表未记录，换更稀有词重试；0 结果时按返回文案的升级路径处理（换词 → read 直读 ~/.dsh/memory/ 下文件 → 查最近会话摘要）。注意：本工具仅可在 run_code 程序内调用（await tools.memory_search({ query })），不可直接发起工具调用。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "主题关键词或记忆文件相对路径" }
            },
            required: ["query"]
          },
          output: {
            schema: { type: "string" },
            render(_a, v) { return [{ type: "text", text: String(v) }] }
          },
          async execute(args) {
            // v1.12.18.5: 宽松归一化——异构调用方参数形态兼容（字符串/数组/嵌套对象/位置字段），
            // 未命中时打印形状日志（首次排障用），避免搜索静默降级为用法回显。
            let argsShape = "";
            try { argsShape = typeof args === "string" ? "string" : Array.isArray(args) ? "array" : Object.keys(args || {}).join(","); } catch (e) {}
            let q = "";
            try {
              if (typeof args === "string") q = args;
              else if (args && typeof args === "object") {
                let v = args.query;
                if (Array.isArray(v)) v = v.join(" ");
                else if (v && typeof v === "object") v = v.query || Object.values(v)[0];
                if (typeof v !== "string") {
                  for (const k of Object.keys(args)) {
                    const cand = args[k];
                    if (typeof cand === "string" && cand.trim()) { v = cand; break; }
                    if (Array.isArray(cand) && cand.every((x) => typeof x === "string")) { v = cand.join(" "); break; }
                  }
                }
                q = (typeof v === "string") ? v : String(v ?? "");
              }
            } catch (e) { q = ""; }
            q = q.trim();
            if (!q) {
              cwarn("[dsh-memory] memory_search 收到无法解析的参数形状: " + argsShape + " → 返回用法回显");
              return "用法：memory_search(query)。query = 主题关键词 / 文件名 / 记忆条目（如 OA日志、智检API、长沙项目、金额）。";
            }
            // 固定记忆库目标
            const fixedTargets = [
              ["全局画像", "global.md"],
              ["记忆索引", "index.md"],
              ["长沙项目", "projects/长沙交易场地智能化系统升级改造.md"],
              ["机器管项目", "projects/机器管招投标系统功能完善与性能提升项目.md"],
              ["发改委项目", "projects/湖南省发改委行政监督平台升级项目.md"],
              ["知识库管线工具", "tools/知识库处理管线.md"],
              ["AI问答助手原型", "tools/AI问答助手原型.md"],
              ["项目文档脚本", "tools/项目文档生成脚本组.md"]
            ];
            // v2.2.5：动态候选集来自目录扫描（loadKnowledgeTargets 已自持，不再依赖 index.md 书写格式）。
            //   file 统一为相对 MEMORY_ROOT 路径；rel 统一为绝对路径。fixedTargets 短 label 优先，按 file 去重。
            const knowledgeTargets = await loadKnowledgeTargets();
            const seenFile = new Set();
            const targets = [];
            for (const [label, rel] of fixedTargets) {
              if (seenFile.has(rel)) continue;
              seenFile.add(rel);
              targets.push({ label, file: rel, rel: MEMORY_ROOT + "/" + rel });
            }
            for (const k of knowledgeTargets) {
              if (seenFile.has(k.file)) continue;
              seenFile.add(k.file);
              targets.push({ label: k.label, file: k.file, rel: MEMORY_ROOT + "/" + k.file });
            }
            // v12：精确文件名/路径优先——query 直接等于某目标文件时返回全文（v8 原行为）
            // v2.2.5：放宽为 basename 带/不带 .md、大小写不敏感均可直取全文
            //   （如 MEMORY-oa-logfill / memory-oa-logfill.md / global）；中文主题词不进此分支，仍走评分排序。
            const qLow = q.toLowerCase();
            for (const t of targets) {
              const base = t.file.split("/").pop().toLowerCase();
              if (q === t.file || q === t.rel || q.endsWith("/" + t.file) || qLow === base || qLow === base.replace(/\.md$/, "")) {
                const fullText = await readText(t.rel);
                if (fullText) return "【" + t.label + "】" + t.file + "\n" + fullText.slice(0, 4000);
              }
            }
            // v12：Unicode 分词 → 每个 token 独立参与匹配（OR 语义），任一命中即候选
            const tokens = tokenize(q);
            if (tokens.length === 0) {
              return "未提取到有效关键词（query 需含至少一个字母/数字/中文）。";
            }
            // v12：逐文件 TF 加权评分，收集全部命中（不再"命中1个就 return"）
            const results = [];
            for (const t of targets) {
              const text = await readText(t.rel);
              if (!text) continue;
              const { score, hitLines } = scoreTarget(t, text, tokens);
              if (score > 0) results.push({ t, score, hitLines });
            }
            // v12：分数降序（同分按 label）
            results.sort((a, b) => b.score - a.score || a.t.label.localeCompare(b.t.label));
            if (results.length === 0) {
              // v12：0 结果引导——参考 mimocode memory.txt 升级策略，避免模型误判"没记录过"
              // v2.2.6：零结果是检索断链的高发症状——自检未通过时在此自动携带诊断（模型可见，不依赖人看控制台）
              const selfBad = (RETRIEVAL_SELF && !RETRIEVAL_SELF.ok) ? "⚠️【检索层自检未通过】" + RETRIEVAL_SELF.msg + " ——本次零结果可能与检索断链有关，必要时用 read 直查 ~/.dsh/memory/ 下文件。\n" : "";
              return selfBad + "未找到匹配「" + q + "」。0 结果不代表从未记录过，请按此升级：\n" +
                "1. 换更少更独特的词（1-3 个罕见词：ID、函数名、文号、精确术语），去掉泛词（如「项目」「系统」「配置」）。\n" +
                "2. 字面量（URL/端口/路径/命令）被分词器拆散，改用 read 工具直接读 ~/.dsh/memory/ 下文件。\n" +
                "3. 要逐字原文（精确命令、用户原话）查最近会话摘要：memory_search 查 会话 / sessions。\n" +
                "可查主题清单：\n" + targets.map((t) => "  " + t.label + " → " + t.file).join("\n") + "\n或换关键词再试。";
            }
            // v12：相对分数下限（参考 mimocode top_score*0.15）：砍掉只命中泛词的噪音，
            //   第 1 名永远保留。保留前 8 条。
            // v12.1：再加绝对下限 ABS_MIN_SCORE=1.0——中文单字虚词（"的""在""存"）命中分数极低
            //   （0.1~0.5），相对下限算出来太宽（top*0.15）导致完全无关的查询也返回一堆低分文件；
            //   低于绝对下限的结果视为"无意义命中"丢弃（除非它是唯一命中，保留作为弱相关提示）。
            const ABS_MIN_SCORE = 0.6;
            const topScore = results[0].score;
            const cutoff = topScore * 0.15;
            const kept = results
              .filter((r, i) => i === 0 || (r.score >= cutoff && (r.score >= ABS_MIN_SCORE || results.length === 1)))
              .slice(0, 8);
            const exactSingle = kept.length === 1 && kept[0].t.file === q;
            const body = kept.map((r) => {
              const lines = r.hitLines.length > 0
                ? "\n  " + r.hitLines.slice(0, 3).join("\n  ")
                : "\n  （主题/文件名命中，无正文行摘录）";
              return "【" + r.t.label + "】" + r.t.file + "（相关度 " + r.score.toFixed(1) + "）" + lines;
            }).join("\n\n");
            // 单一精确命中（query == 文件名）→ 返回全文（原有行为保留）
            if (exactSingle) {
              const t = kept[0].t;
              const text = await readText(t.rel);
              if (text) return "【" + t.label + "】" + t.file + "\n" + text.slice(0, 4000);
            }
            return "搜索「" + q + "」命中 " + kept.length + " 个文件（OR 分词 + 相关度排序，Top " + kept.length + "）：\n\n" + body + "\n\n需要全文请用 memory_search 查精确文件名。";
          }
        });
        // v2.4.28（D1a）：memory_size_preview——提交前 dry-run 落盘预览（dream 子代理主动量尺寸，纯只读零落盘）。
        // 与 memory_dream_patch 同构（{file,action,content}），插件按盘上现文用 simulateFinalText 算「将落盘后的全文」
        // 与预算/差数/分节表——append 场景子代理无法自数 existing、且真实落盘有 trim/锚点插入变换，必须插件拼算。
        // 零副作用：不落盘 → 不触发看护续期；只连环 preview 不真写会被 D4 watchdog 停，预览不能成空转避风港。
        toolSvc.register({
          name: "memory_size_preview",
          description: "提交前 dry-run 预览（仅 dream 整合子代理用）：传 { file, action, content } 或 { file, action:edit, old_string, new_string } 计算「将落盘后的字符数与预算」——返回 { ok, rel, action, wouldChars, budget, overBy, fits, sections }；sections 为 ## 分节字符表（## 归档/漏网会话补档 族标 preferExtract，首选提取），所有文件均返回。写 global/index/projects 这类 budget 敏感文件前先 dry-run 一次量准再真调 memory_dream_patch；sessions/|knowledge/|tools/ 无预算——无需预览，直接 memory_dream_patch 写入即可；**每文件 10 分钟滑动窗内最多 4 次、每会话 8 次，超出工具直接拒绝并回传差数**；不落盘、纯只读。file 越界/action 非法返回错误清单。",
          parameters: {
            type: "object",
            properties: {
              file: { type: "string", description: "记忆库相对路径（global.md|index.md|projects/…）" },
              action: { type: "string", enum: ["replace", "append", "edit"], description: "replace=整文件覆盖 / append=末尾追加 / edit=局部精确替换（old_string→new_string）" },
              content: { type: "string", description: "拟写入内容（replace/append 必填；edit 免用）" },
              old_string: { type: "string", description: "edit 的精确原文（须唯一命中）" },
              new_string: { type: "string", description: "edit 的替换后文本（空串=删除该片段）" }
            },
            required: ["file", "action"]
          },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args, exec) {
            try {
              const f = args && typeof args === "object" ? (args.file || (Array.isArray(args) ? "" : "")) : "";
              const act = args && typeof args === "object" ? args.action : "";
              const ct = args && typeof args === "object" ? args.content : "";
              // v2.5.0：edit 分流——old_string/new_string 取代 content；统一构造 patch 供 simulateFinalText
              const os = args && typeof args === "object" ? args.old_string : "";
              const ns = args && typeof args === "object" ? args.new_string : "";
              if (!["replace", "append", "edit"].includes(act)) return JSON.stringify({ ok: false, error: "action 仅支持 replace|append|edit：" + String(act) });
              if (act === "edit") {
                if (typeof os !== "string" || !os.trim()) return JSON.stringify({ ok: false, error: "edit 缺 old_string（须唯一命中的精确原文）" });
                if (typeof ns !== "string") return JSON.stringify({ ok: false, error: "edit 缺 new_string（空串=删除该片段）" });
              } else if (typeof ct !== "string" || !ct.trim()) return JSON.stringify({ ok: false, error: "content 缺失或空" });
              const mkPatch = () => act === "edit" ? { rel: "", action: act, old_string: os, new_string: ns } : { rel: "", action: act, content: ct };
              // v2.4.29：无预算分支移到路径白名单校验之后——先分清「越界路径」与「合法但无预算」：
              //   sessions/|knowledge/|tools/ 无字符预算、写时不卡，无需预览，直接 memory_dream_patch 写入即可（旧文案把两者混为一谈，误导子代理以为写不进去）。
              const aw = assertMemoryWrite(f, act === "edit" ? ns : ct);
              if (!aw.ok) return JSON.stringify({ ok: false, error: aw.errors.join("; ") });
              const rel = aw.rel;
              const b = budgetOf(rel);
              if (!b) return JSON.stringify({ ok: false, error: "file 无预算（sessions/|knowledge/|tools/ 不设字符上限）——此文件无需预览，直接用 memory_dream_patch 写入：" + String(f) });
              // v2.4.32（P0-4）：preview 计数闸——宿主恒传 (args,exec)，第二参 exec 含 agent.session.id（dsh-tools execute(args,exec) 实证，
              //   更正 v2.4.28 注释「execute 无 sid」的旧前提）；同 (sid,file) 10 分钟滑动窗第 4 次 / 同 sid 总数 8 次 → 拒绝并现算差数（防连环 preview 空转）。
              const sid9 = (exec && exec.agent && exec.agent.session && exec.agent.session.id) || "?";
              const g8 = previewGateCheck(sid9, rel);
              if (!g8.allowed) {
                let existing2 = ""; try { existing2 = fs.readFileSync(portable(MEMORY_ROOT + "/" + rel), "utf8"); } catch (eX) { existing2 = ""; }
                const sim2 = simulateFinalText(rel, existing2, [Object.assign(mkPatch(), { rel: rel })]);
                const F2 = sim2.text.length;
                const budget2 = b.extract ? extractTargetFor(rel, existing2.length) : b.chars;
                const sec2 = charSectionBreakdown(sim2.text, { maxRows: 8 }).map((s) => s.title + " " + s.chars + " 字符").join("、");
                return JSON.stringify({ ok: false, error: "preview 已达上限（" + PREVIEW_GATE_PER_FILE + " 次/文件 或 " + PREVIEW_GATE_PER_SID + " 次/会话，10 分钟滑动窗）——本次将写为 " + F2 + " 字符、超 " + Math.max(0, F2 - budget2) + " 预算。按差数做整节下沉一次成型提交 memory_dream_patch（目标与指针要求见任务书）；或放弃该文件先落盘其他内容。分节字符: " + sec2 });
              }
              let existing = ""; try { existing = fs.readFileSync(portable(MEMORY_ROOT + "/" + rel), "utf8"); } catch (e) { existing = ""; }
              const sim = simulateFinalText(rel, existing, [Object.assign(mkPatch(), { rel: rel })]);
              const F = sim.text.length;
              const budget = b.extract ? extractTargetFor(rel, existing.length) : b.chars;
              const overBy = F - budget;
              const out = { ok: true, rel: rel, action: act, wouldChars: F, budget: budget, overBy: overBy, fits: overBy <= 0, skipped: sim.skipped };
              // v2.4.32（P0-1）：分节表推广到所有文件（不只 projects）——global/index 超预算时模型需
              //   知道「哪一节多少字符」才能做整节下沉定位；preferExtract 标 ## 归档/漏网会话补档 族（有则优先）。
              out.sections = charSectionBreakdown(sim.text, { maxRows: 15 }).map((s) => {
                const hist = /^##\s*(归档|漏网会话补档)/.test(s.title);
                return { title: s.title, chars: s.chars, lines: s.lines, preferExtract: hist };
              });
              return JSON.stringify(out);
            } catch (e) {
              return JSON.stringify({ ok: false, error: "preview 异常: " + (e && e.message ? e.message : String(e)) });
            }
          }
        });
        clog("[dsh-memory] memory_size_preview 预览工具已注册（dream 专用）");
      } catch (e) {
        cerr("[dsh-memory] 工具注册异常:", e && e.message ? e.message : String(e));
      }
    } else {
      cerr("[dsh-memory] tools 服务不可用，memory_search 工具注册跳过（不影响记忆注入）");
    }

      // v1.12.8：stale_archive —— approval 模式确认闭环（此前只有"问"没有"答"通路，模型确认后无法接续自动执行）
      try {
        toolSvc.register({
          name: "stale_archive",
          description: "对检测到的漏网会话发起记忆归档（dsh-memory approval 确认后调用）。插件自动提取消息流，单个主子代理自主判断价值/总结/落盘。无参数。",
          parameters: { type: "object", properties: {}, required: [] },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute() {
            ensureStaleNotified();
            const stale = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
              .filter((s) => archivePendingEntry(s) && !sessionMentionedInMemory(s.id));   // v1.12.19→v2.4.3 水位重入判定
            if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }
            if (stale.length === 0) return "当前没有待归档的漏网会话（含已归档且无新增的会话）。";
            const r = await runStaleArchive(stale);   // v2.1.4 起成功/失败冷却窗对手动确认同样生效（拒绝理由会回显给模型）
            if (r.ok) {
              return "已发起漏网归档主子代理（" + r.count + " 个会话 / " + r.started + " 批" + (r.overflow > 0 ? "，另有 " + r.overflow + " 个留待下次" : "") + "）" + (r.startFailed > 0 ? "；" + r.startFailed + " 批发起失败，其会话留待下轮" : "") + "，完成后控制台输出归档报告。";
            }   // 消号 v1.12.19.1 起在子代理完成回调内执行
            return "归档未发起：" + r.reason;
          }
        });
      } catch (e) {
        cerr("[dsh-memory] stale_archive 注册异常:", e && e.message ? e.message : String(e));   // v2.4.25（审查 P2-2）：删粘贴残留重复行
      }

      // v2.3.0：memory_onboard —— 初始化引导的模型侧出口（体检/立刻引导/暂缓/查新版四合一）
      // 宿主插件与模型之间没有 UI 通道：snooze 只能由模型判断"用户不想现在弄"后调用本工具落状态。
      try {
        toolSvc.register({
          name: "memory_onboard",
          description: "dsh-memory 初始化与升级状态工具（仅可在 run_code 程序内调用：await tools.memory_onboard({ action: \"status\" })）。action=status 体检记忆库并回显版本/状态；action=init 立刻重发一次初始化引导；action=snooze 用户说回头再弄，暂停提醒 hours 小时（默认 24）；action=check-update 立即检查新版本。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", description: "status（默认，只读体检）| init（强制再引导一次）| snooze（暂停提醒）| check-update（查新版）" },
              hours: { type: "number", description: "snooze 暂停小时数 1~168，默认 24" },
            },
            required: [],
          },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }]; } },
          async execute(args) {
            const a = args || {};
            const act = String(a.action || "status").toLowerCase();
            try {
              if (act === "init") {
                const m = forceInitGuide(LAST_TOP_AGENT, "memory_onboard");
                return "已重新发出初始化引导（状态 " + m.status + "）。请在本会话里按引导问齐用户信息并落盘 global.md / index.md。";
              }
              if (act === "snooze") {
                const h = snoozeInitGuide(a.hours);
                return "已暂停初始化提醒 " + h + " 小时（到 " + new Date(Date.now() + h * 3600000).toLocaleString() + "）。用户随时可用「初始化记忆」或 /memory-init 立即恢复。";
              }
              if (act === "check-update" || act === "check_update" || act === "update") {
                if (PLUGIN_CFG.updateCheckEnabled === false) return "升级检查已在设置里关闭（设置 → 通用设置 → 记忆 → 检查新版）。";
                const st0 = readOnboardState();
                st0.update.checkedAt = 0;
                writeOnboardState(st0);
                const r = await checkForUpdate("工具");
                if (!r) return "版本检查未完成（网络/超时/镜像缺 version.txt），当前本地 v" + PLUGIN_VERSION;
                return r.newer
                  ? "发现新版本 v" + r.latest + "（当前 v" + PLUGIN_VERSION + "）。升级：" + updateCmd() + "，装完重启 DSH 生效。"
                  : "已是最新版本 v" + PLUGIN_VERSION + "。";
              }
              const m = inspectMemory();
              const st = readOnboardState();
              return "记忆库：" + m.status + " · global " + m.bytesGlobal + "B / index " + m.bytesIndex + "B"
                + (m.missingDirs.length ? " · 缺目录 " + m.missingDirs.join(",") : "")
                + (m.hasAgents ? " · 有 AGENTS.md" : " · 缺 AGENTS.md（安装脚本会自动补）")
                + "\n" + onboardStatusLine()
                + (st.snoozeUntil > Date.now() ? "\n初始化提醒处于暂缓中（至 " + new Date(st.snoozeUntil).toLocaleString() + "），需要时用 action=init 立即恢复。" : "");
            } catch (e) {
              return "memory_onboard 执行失败：" + (e && e.message ? e.message : String(e));
            }
          },
        });
      } catch (e) {
        cerr("[dsh-memory] memory_onboard 注册异常:", e && e.message ? e.message : String(e));
      }

      // v2.0.3：dsh_spiral_thresh —— D 类「LLM循环试错提醒」+ E 类「成功同质循环」+ W 类「无介入看门狗」阈值自校准
      // （/dream 整合代理分析监控数据后调用；v2.4.30 扩 E/W 字段）
      // 插件侧钳制校验后写内存态+防抖落盘，规避子代理直写 .monitor.json 被插件内存态覆盖的竞态
      try {
        toolSvc.register({
          name: "dsh_spiral_thresh",
          description: "更新循环提醒判定阈值（D 类失败试错 / E 类成功同质循环 / W 类无介入看门狗；dsh-memory /dream 自校准专用）。全部字段可选；越界字段被拒绝并回退内置默认。",
          parameters: { type: "object", properties: {
            rep: { type: "number", description: "打转占比阈值 0.30~0.80（内置默认 0.45）" },
            neg: { type: "number", description: "负面结果占比阈值 0.20~0.80（内置默认 0.40）" },
            sim: { type: "number", description: "args 相似度阈值 0.50~0.90（内置默认 0.70）" },
            w: { type: "number", description: "滑窗大小 5~16（内置默认 8）" },
            cooldownMin: { type: "number", description: "同会话提醒冷却分钟数 5~60（内置默认 10）" },
            sameNeg: { type: "number", description: "E 类簇内负面率上限 0.10~0.45（内置默认 0.30，成功为主判定）" },
            sameSteps: { type: "number", description: "E 类簇内重复绝对步数下限 3~10（内置默认 4，防短暂重试）" },
            sameMinSecs: { type: "number", description: "E 类簇墙钟下限秒数 10~600（内置默认 60，防快速抖动）" },
            sameHomo: { type: "number", description: "E 类簇内同质占比阈值 0.50~1.00（内置默认 0.80）" },
            watchSteps: { type: "number", description: "W 类无介入工具步数下限 5~40（内置默认 10）" },
            watchSecs: { type: "number", description: "W 类无介入墙钟下限秒数 30~1800（内置默认 180）" },
            watchCooldownMin: { type: "number", description: "W 类同会话冷却分钟数 5~60（内置默认 10）" },
            brkSameN: { type: "number", description: "D 级熔断：同指纹连续重复 ≥N 进 suspect 2~6（内置默认 3）" },
            brkMaxDeny: { type: "number", description: "D 级熔断：每周期 deny 次数上限后升级停轮/停手 1~6（内置默认 3）" },
            brkMinSteps: { type: "number", description: "D 级熔断：执法需 stepsSinceUser ≥ 此值（防用户穿插误伤）1~5（内置默认 4）" },
            reason: { type: "string", description: "本次调整的一句话理由（记入变更日志，供审计）" }
          }, required: [] },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args) {
            const a = args || {};
            const bounds = { rep: [0.30, 0.80], neg: [0.20, 0.80], sim: [0.50, 0.90], w: [5, 16], cooldownMin: [5, 60],
              sameNeg: [0.10, 0.45], sameSteps: [3, 10], sameMinSecs: [10, 600], sameHomo: [0.50, 1.00],
              watchSteps: [5, 40], watchSecs: [30, 1800], watchCooldownMin: [5, 60],
              brkSameN: [2, 6], brkMaxDeny: [1, 6], brkMinSteps: [1, 5] };
            const intKeys = new Set(["w", "sameSteps", "sameMinSecs", "watchSteps", "watchSecs", "watchCooldownMin", "brkSameN", "brkMaxDeny", "brkMinSteps"]);
            const cur = effectiveSpiralThresh();
            const next = {}; const rejected = [];
            for (const k of Object.keys(bounds)) {
              if (a[k] === undefined) continue;
              const v = intKeys.has(k) ? Math.round(a[k]) : a[k];
              if (typeof v !== "number" || !isFinite(v) || v < bounds[k][0] || v > bounds[k][1]) { rejected.push(k + "=" + a[k]); continue; }
              next[k] = v;
            }
            if (!Object.keys(next).length) return "未更新任何阈值。" + (rejected.length ? "越界被拒：" + rejected.join("、") + "。" : "") + "当前生效：rep≥" + cur.rep + " neg≥" + cur.neg + " sim≥" + cur.sim + " 窗=" + cur.w + " 冷却=" + cur.cooldownMin + "分 | E: 成功上限" + cur.sameNeg + " 步数≥" + cur.sameSteps + " 墙钟≥" + cur.sameMinSecs + "s 同质≤" + cur.sameHomo + " | W: 步数≥" + cur.watchSteps + " 墙钟≥" + cur.watchSecs + "s 冷却=" + cur.watchCooldownMin + "分 | BRK: 同指纹≥" + Math.round(cur.brkSameN) + " 上限deny " + Math.round(cur.brkMaxDeny) + " 无穿插≥" + Math.round(cur.brkMinSteps) + "步";
            const md = readMonitorData();
            const from = {}; for (const k of Object.keys(next)) from[k] = cur[k];
            md.spiralThresh = Object.assign({}, (MONITOR_DATA.spiralThresh || {}), next);
            // v2.0.4: 变更日志（滚动20条）——阈值是被 AI 自动改的政策参数，必须留痕供审计/回滚
            if (!Array.isArray(md.spiralThreshLog)) md.spiralThreshLog = [];
            md.spiralThreshLog.push({ t: Date.now(), from: from, to: Object.assign({}, next), reason: String(a.reason || "").slice(0, 80) });
            if (md.spiralThreshLog.length > 20) md.spiralThreshLog = md.spiralThreshLog.slice(-20);
            scheduleMonitorSave();
            const et = effectiveSpiralThresh();
            const chgDesc = Object.keys(next).map(k => k + " " + from[k] + "→" + et[k]).join(" ");
            clog("[dsh-memory] 循环提醒阈值变更: " + chgDesc + (a.reason ? "（" + String(a.reason).slice(0, 60) + "）" : ""));
            return "循环提醒阈值已更新并落盘（" + chgDesc + "）" + (rejected.length ? "，越界被拒：" + rejected.join("、") : "") + "。当前生效：rep≥" + et.rep + " neg≥" + et.neg + " sim≥" + et.sim + " 窗=" + et.w + " 冷却=" + et.cooldownMin + "分 | E: 成功上限" + et.sameNeg + " 步数≥" + et.sameSteps + " 墙钟≥" + et.sameMinSecs + "s 同质≤" + et.sameHomo + " | W: 步数≥" + et.watchSteps + " 墙钟≥" + et.watchSecs + "s 冷却=" + et.watchCooldownMin + "分 | BRK: 同指纹≥" + Math.round(et.brkSameN) + " 上限deny " + Math.round(et.brkMaxDeny) + " 无穿插≥" + Math.round(et.brkMinSteps) + "步";
          }
        });
      } catch (e) {
        cerr("[dsh-memory] dsh_spiral_thresh 注册异常:", e && e.message ? e.message : String(e));
      }

      // v0.5（step5-2 档）：dsh_maint_thresh —— 合并维护触发阈值自校准（/dream 整合代理分析 maintSamples 后调用）
      // 写 monitor.maintThresh 覆盖层（对齐 spiralThresh 模式：防子代理直写竞态 + 防抖落盘 + 变更留痕）
      try {
        toolSvc.register({
          name: "dsh_maint_thresh",
          description: "更新合并维护触发阈值（dsh-memory /dream 自校准专用）。triggerChars 合法范围 600~1500（越界回退默认 1100）。",
          parameters: { type: "object", properties: {
            triggerChars: { type: "number", description: "维护触发阈值（真实要点面字符）600~1500（默认 1100）" },
            reason: { type: "string", description: "本次调整的一句话理由（记入变更日志，供审计）" }
          }, required: [] },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args) {
            const a = args || {};
            const cur = maintTriggerChars();
            const rejected = [];
            let nextVal = null;
            if (a.triggerChars !== undefined) {
              const v = Math.round(a.triggerChars);
              if (typeof v !== "number" || !isFinite(v) || v < 600 || v > 1500) rejected.push("triggerChars=" + a.triggerChars);
              else nextVal = v;
            }
            if (nextVal === null) {
              return "未更新阈值。" + (rejected.length ? "越界被拒：" + rejected.join("、") + "。" : "") + "当前生效：maintTriggerChars=" + cur;
            }
            const md = readMonitorData();
            md.maintThresh = Object.assign({}, (md.maintThresh || {}), { triggerChars: nextVal });
            if (!Array.isArray(md.maintThreshLog)) md.maintThreshLog = [];
            md.maintThreshLog.push({ t: Date.now(), from: cur, to: nextVal, reason: String(a.reason || "").slice(0, 80) });
            if (md.maintThreshLog.length > 20) md.maintThreshLog = md.maintThreshLog.slice(-20);
            scheduleMonitorSave();
            clog("[dsh-memory] 维护阈值变更: " + cur + "→" + nextVal + (a.reason ? "（" + String(a.reason).slice(0, 60) + "）" : ""));
            return "维护阈值已更新并落盘（" + cur + "→" + nextVal + "）" + (rejected.length ? "，越界被拒：" + rejected.join("、") : "") + "。当前生效：maintTriggerChars=" + nextVal;
          }
        });
      } catch (e) {
        cerr("[dsh-memory] dsh_maint_thresh 注册异常:", e && e.message ? e.message : String(e));
      }

    // v1.5.0：定期自动整合记忆（对标 mimocode AutoDream 7d）
    // 宿主常驻进程 + ctx.interval 定时器；安装时记起始时间，每次整合完成刷新，下次再隔 integrateDays 天。
    // 状态文件：MEMORY_ROOT/.integrate.json（{ installAt, lastIntegrateAt }）——常量见模块级

    function readIntegrateState() {
      try {
        const raw = fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8");
        return JSON.parse(raw);
      } catch (e) { return null; }
    }
    function writeIntegrateState(state) {
      try {
        fs.mkdirSync(MEMORY_ROOT.replace(/\//g, "/"), { recursive: true });
        // v2.0.9(M1): 账本写盘前与磁盘做并集合并——外部/人工补账的 archivedSessions、staleNotified 不再被内存态整体覆写。
        // 注：账本是 append-only 消号语义；人工「摘牌」属维护操作，需在插件重启前完成或接受回写。
        try {
          const disk = JSON.parse(fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8"));
          if (Array.isArray(disk.archivedSessions)) state.archivedSessions = Array.from(new Set([...disk.archivedSessions, ...(state.archivedSessions || [])])).slice(-300);
          // v2.4.3: 水位账本按 id 合并（同 id 取 at 较新者），防多实例/外部补账互相覆盖水位
          if (Array.isArray(disk.archiveWatermarks)) {
            const byId = {};
            for (const w of disk.archiveWatermarks) if (w && w.id) byId[w.id] = w;
            for (const w of (state.archiveWatermarks || [])) if (w && w.id && (!byId[w.id] || (w.at || 0) >= (byId[w.id].at || 0))) byId[w.id] = w;
            state.archiveWatermarks = Object.values(byId).slice(-300);
          }
          if (Array.isArray(disk.staleNotified)) state.staleNotified = Array.from(new Set([...disk.staleNotified, ...(state.staleNotified || [])])).slice(-300);
        } catch (e) { /* 磁盘不可读则按内存态原样写 */ }
        fs.writeFileSync(portable(INTEGRATE_STATE_FILE), JSON.stringify(state, null, 2), "utf8");
      } catch (e) {
        cwarn("[dsh-memory] 整合状态写入失败:", e && e.message ? e.message : String(e));
      }
    }

    // 发起整合子代理（后台）：整合记忆 = 提升 sessions→projects/global、清理过时、去重、更新 index
    // v1.12.12：定位窗口期内新创建的子代理会话目录（裸 UUID = spawn 产物）
    function findNewestSpawnedSession(startedAt) {
      try {
        let best = null;
        for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
          const wsd = SESSIONS_ROOT + "/" + ws;
          let sts; try { sts = fs.readdirSync(wsd); } catch (e) { continue; }
          for (const sid of sts) {
            if (/^session-/.test(sid)) continue;
            const dir = wsd + "/" + sid;
            let st; try { st = fs.statSync(dir); } catch (e) { continue; }
            if (st.birthtimeMs >= startedAt - 3000 && (!best || st.birthtimeMs > best.bt)) best = { dir: dir, bt: st.birthtimeMs };
          }
        }
        return best ? best.dir : null;
      } catch (e) { return null; }
    }

    // v1.12.12：统计子代理会话消耗（多帧解压 jsonl.zstd，累计 usage chunks + turn 时长）
    function summarizeSubagentUsage(sessionDir) {
      try {
        const zpath = sessionDir + "/session.jsonl.zstd";
        if (!fs.existsSync(zpath)) return null;
        // v1.12.18.4: 复用共享解压实现（消除两套 zstd 多帧循环）
        const text = decompressSessionLog(zpath);
        if (!text) return null;
        let inT = 0, outT = 0, cacheT = 0, reasonT = 0, t0 = 0, t1 = 0;
        for (const line of text.split("\n")) {
          if (line.indexOf("\"usage\"") < 0 && line.indexOf("turn/") < 0) continue;
          let j; try { j = JSON.parse(line); } catch (e) { continue; }
          if (j.type === "assistant/chunk" && j.data && j.data.chunk && j.data.chunk.type === "usage") {
            const u = j.data.chunk.usage || {};
            inT += u.inputTokens || 0; outT += u.outputTokens || 0;
            cacheT += u.cacheReadTokens || 0; reasonT += u.reasoningTokens || 0;
          }
          if (j.type === "turn/start") t0 = j.time;
          if (j.type === "turn/end") t1 = j.time;
        }
        // v1.12.17.1: turn/end 可能尚未落盘（完成回调与日志写盘竞态）→ t0 兜底到当前时间
        const durMin = t1 > t0 ? Math.round((t1 - t0) / 60000 * 10) / 10 : (t0 > 0 ? Math.round((Date.now() - t0) / 60000 * 10) / 10 : 0);
        // v1.12.17.1: 口径修正——inputTokens 仅是未命中部分，总输入 = inputTokens + cacheReadTokens
        return { input: inT, output: outT, cache: cacheT, totalIn: inT + cacheT, reasoning: reasonT, durMin: durMin };
      } catch (e) { return null; }
    }

    // v1.12.17: dream 进度/结果落盘（GUI 不展示后台子代理会话——任何会话读 .integrate.json 可查）
    // v1.12.18.1: 维护消耗累计（整合 / 归档通用）
    function trackMaintain(kind, u) {
      try {
        if (!u) return;
        const d = readMonitorData();
        const m = d.maintain || (d.maintain = { integRuns: 0, archRuns: 0, inT: 0, cacheT: 0, outT: 0 });
        if (kind === "integ") m.integRuns += 1; else m.archRuns += 1;
        m.inT += (u.totalIn || u.input || 0); m.cacheT += (u.cache || 0); m.outT += (u.output || 0);
        scheduleMonitorSave();
      } catch (e) { /* 忽略 */ }
    }
    // v1.12.18.6: STALE_NOTIFIED 持久化——重启后不重复提醒/重复归档跳过项；staleCount 快照可正确收敛
    function ensureStaleNotified() {
      if (staleNotifiedLoaded) return;
      staleNotifiedLoaded = true;
      try {
        const st0 = readIntegrateState() || {};
        (st0.staleNotified || []).forEach((id) => STALE_NOTIFIED.add(id));
        // v2.4.3: 载入增量重档水位账本
        (st0.archiveWatermarks || []).forEach((w) => { if (w && w.id) ARCHIVE_WATERMARK.set(w.id, { frames: typeof w.frames === "number" ? w.frames : null, round: w.round || 1, at: w.at || 0 }); });
        (st0.archivedSessions || []).forEach((id) => ARCHIVED_SESSIONS.add(id));   // v1.12.19: 双账本加载
        if (st0.archiveLastRunAt) ARCHIVE_LAST_RUN_AT = st0.archiveLastRunAt;   // v2.0.9: 归档节流时间戳跨重启生效
        if (st0.archiveLastFailAt) ARCHIVE_LAST_FAIL_AT = st0.archiveLastFailAt;   // v2.4.7.1: 发起失败短冷却同样跨重启生效
      } catch (e) { /* 忽略 */ }
    }
    function saveStaleNotified() {
      try {
        const st = readIntegrateState() || {};
        st.staleNotified = Array.from(STALE_NOTIFIED).slice(-300);
        st.archivedSessions = Array.from(ARCHIVED_SESSIONS).slice(-300);   // v1.12.19
        // v2.4.3: 水位随账本对齐保存（与 archivedSessions 同 300 上限）
        st.archiveWatermarks = Array.from(ARCHIVED_SESSIONS).slice(-300).map((id) => { const w = ARCHIVE_WATERMARK.get(id); return w ? { id: id, frames: w.frames, round: w.round, at: w.at } : null; }).filter(Boolean);
        writeIntegrateState(st);
      } catch (e) { /* 忽略 */ }
    }
    // v2.4.13(dream-live): 手动 /dream 进度实时转播回发起会话（后台子代理照旧，写守卫保留）。
    // 复用 DREAM_TRACK 心跳/settle 已喂给 dreamProgressPatch 的同源 patch，格式化后 setTimeout(0) 注入监听会话。
    // 只在 DREAM_LISTENER（手动发起）设置时生效——定期/超时自动整合不注入任何会话，避免打扰。
    function rebroadcastDream(patch) {
      // v2.5.1(转播可见性): 新路径直接落会话流（需 session.append），旧路径才靠 inject——两者皆无则放弃。
      if (!DREAM_LISTENER) return;
      const _hasInject = typeof DREAM_LISTENER.inject === "function";
      const _hasAppend = !!(DREAM_LISTENER.session && typeof DREAM_LISTENER.session.append === "function");
      if (!_hasInject && !_hasAppend) return;
      let line = "";
      let terminal = false;
      let tStat = null;   // v2.5.1(P2-1): 终态 status 标记（done/skipped/stopped/failed）——标题按状态差异化
      // v2.5.1(P3-2): 插件侧事实优先于子代理自述——本轮 memory_dream_patch 真实落盘清单随 patch 下发。
      //   实证：summary 称「无落盘内容」而实际写了 index.md；终态行始终附事实清单，不再只信自述。
      const _rels = (patch && Array.isArray(patch.writtenRels)) ? patch.writtenRels : [];
      const _relsTxt = _rels.length ? "（本轮落盘：" + _rels.join("、") + "）" : "（本轮未落盘任何文件）";
      if (patch && (patch.status === "running" || patch.reason)) { line = "已发起 dream 整合（后台子代理，物理写守卫保留）：整合已启动，进度实时同步到本会话。"; tStat = "running"; }   // v2.5.4(B): running 纳入即时落表通道——管线后台化后「已发起」是用户唯一即时反馈；terminal 保持 false（禁止 followup 开核验回合），notice 通道本身零唤醒、不限流
      else if (patch && patch.status === "done") { line = "dream 整合完成：" + (patch.summary || "已落盘") + (patch.tokens ? "（消耗 " + patch.tokens + "）" : "") + _relsTxt; terminal = true; tStat = "done"; }
      else if (patch && patch.status === "skipped") { line = "dream 整合空轮跳过（无候选会话/无超限文件/无待沉淀条目——记忆库已稳定，无需整合）"; terminal = true; tStat = "skipped"; }
      else if (patch && patch.status === "stopped:incomplete") { line = "dream 整合未完全落盘（未通过 memory_dream_patch 写入任何文件）——2 小时后自动重试。" + (_rels.length ? _relsTxt : ""); terminal = true; tStat = "stopped"; }
      else if (patch && patch.status === "failed") { line = "dream 整合失败：" + (patch.error || "未知错误"); terminal = true; tStat = "failed"; }
      else if (patch && patch.steps) { line = "dream 整合进行中：第 " + patch.steps + " 步（上次工具 " + patch.lastTool + "，" + (patch.elapsedMin || 0) + " 分钟）"; }
      else if (patch && patch.health) { line = "dream 整合验收提示：" + patch.health; }
      else { return; }
      // v2.5.1(转播可见性): 进展行节流——子代理每次工具调用都会喂一条（L6482），不节流一个 dream 会灌 20~60 行；
      // 每 60 秒最多落一行（首条「已发起」/终态/health 不受限）。
      const _isStepProgress = !!(patch && patch.steps && !terminal);   // v2.5.4(B): running（tStat 非终态、无 steps）不进节流判定，直落 notice 通道
      const _now = Date.now();
      if (_isStepProgress && DREAM_BROADCAST_LAST_AT && _now - DREAM_BROADCAST_LAST_AT < DREAM_BROADCAST_MIN_MS) return;
      DREAM_BROADCAST_LAST_AT = terminal ? 0 : _now;
      // v2.5.1(P2-1/P2-2): 终态文案按 status 差异化——done 才「完成·请核验」；failed/stopped 用「dream 结果·请核验」；
      //   空轮无落盘内容可核验 → 只简报；仅 followup 唤醒路径用核验长文案，inject 回退用短总结（不诱导忙碌回合内自主调工具）。
      let followupMsg = null, injectMsg = null, noticeMsg = null;
      if (tStat === "running") {
        // v2.5.4(B): 「已发起」即时回执——纯展示行，零唤醒（followup 会平白开一个核验回合，禁止）；
        //   走 append notice（与进度行同通道），无 append 的旧宿主回退 inject 排队。
        injectMsg = makeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>");
        noticeMsg = makeNoticeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>", "dream 进度转播：" + line);
      } else if (terminal) {
        const head = tStat === "done" ? "dream 完成·请核验"
          : tStat === "skipped" ? "dream 空轮"
          : "dream 结果·请核验";
        followupMsg = makeMessage("<system-reminder>\n【dsh-memory · " + head + "】" + line + (tStat === "skipped"
          ? "\n\n记忆库已稳定，本轮无落盘内容可核验；向用户简报为空轮即可，无需调用任何工具。\n</system-reminder>"
          : "\n\n请核验本次 dream 整合结果：可用 memory_search / read 确认落盘内容与记忆库现状，然后向用户简要总结整合做了什么、有何发现、记忆库是否健康。无需执行额外整理操作。\n</system-reminder>"));
        injectMsg = makeMessage("<system-reminder>\n【dsh-memory · dream 结果】" + line + "\n</system-reminder>");
      } else {
        injectMsg = makeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>");
        noticeMsg = makeNoticeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>", "dream 进度转播：" + line);
      }
      const target = DREAM_LISTENER;   // v2.4.13: 闭包捕获监听 agent——settle 同步清 DREAM_LISTENER 后定时回调仍能注入（否则 done 转播丢失）
      setTimeout(() => {
        try {
          if (terminal) {
            // v2.5.1: 终态唤醒（宿主 agent.followup = send(next-turn, wake=true) 实证，dsh-agent runtime-types）——
            // 空闲时才开独立回合自动核验总结；agent 正在跑（用户回合进行中）降级 inject 排队不打断；旧宿主无 followup 同样回退 inject。
            // v2.5.1(P2-3): 显式排除 status===undefined（undefined!=="running" 会误放行 followup），守卫意图清晰。
            if (typeof target.followup === "function" && target.status !== undefined && target.status !== "running") {
              target.followup(followupMsg);
            } else {
              target.inject(injectMsg);
            }
            return;
          }
          // v2.5.1(转播可见性): 进展行直接落会话表面（surfaceOp:"append"）——宿主 inject 明确「不唤醒」，
          // 空闲会话的排队项在 GUI 里 placement 判为 "context"、无任何渲染位（只渲染 steering/queued），
          // 故进度会一直不可见，直到用户再发一条消息把它顶进回合——这正是「发了 dream 却没有任何广播」的根因。
          // 落表即渲染为 notice 上下文行（折叠态显示 summary），零唤醒、零 LLM 回合；旧宿主无 append 才回退 inject。
          if (target.session && typeof target.session.append === "function") {
            target.session.append("user/message", noticeMsg, { surfaceOp: "append" });
          } else {
            target.inject(injectMsg);
          }
        } catch (e) {
          try { if (typeof target.inject === "function") target.inject(injectMsg); } catch (e2) { /* 转播失败不影响主流程 */ }
        }
      }, 0);
    }
    function dreamProgressPatch(patch) {
      try {
        const st = readIntegrateState() || {};
        st.progress = Object.assign({}, st.progress || {}, patch, { updatedAt: Date.now() });
        writeIntegrateState(st);
      } catch (e) { /* 忽略 */ }
      try { rebroadcastDream(patch); } catch (e2) { /* 忽略 */ }
    }
    DREAM_PATCH = dreamProgressPatch;
    async function spawnIntegrate(agentForParent, reason) {
      try {   // v2.4.17：dream 发起时项目索引巡检；v2.4.18：体检报告暂存供结算广播拼接（P1-7）
        const _audit = reconcileProjectIndex();
        LAST_PROJECT_AUDIT = (_audit && _audit.needBroadcast && _audit.broadcastText) ? _audit.broadcastText : null;
      } catch (e) {}
      const subagents = ctx.get("subagents");
      if (!subagents || typeof subagents.start !== "function") {
        cwarn("[dsh-memory] 自动整合：subagents 服务不可用，跳过");
        DREAM_TRACK = null;   // v2.2.4: 清占位防误锁
        DREAM_LISTENER = null;   // v2.4.13(dream-live): 发起失败摘监听
        return false;
      }
      let parent = agentForParent || (agentsBySession.size > 0 ? agentsBySession.values().next().value : null);
      if (!parent || typeof parent !== "object") {
        // 启动时序：session-start 可能还没触发，agentsBySession 未填充 → 延迟 30 秒重试一次
        cwarn("[dsh-memory] 自动整合：无可用父 agent，30 秒后重试");
        setTimeout(() => {
          try {
            const p2 = agentForParent || (agentsBySession.size > 0 ? agentsBySession.values().next().value : null);
            if (p2 && typeof p2 === "object") {
              spawnIntegrate(p2, reason);
            } else {
              cwarn("[dsh-memory] 自动整合：重试后仍无父 agent，本周期跳过");
            DREAM_TRACK = null;   // v2.2.4: 重试耗尽清占位
            DREAM_LISTENER = null;   // v2.4.13(dream-live): 发起失败摘监听
            }
          } catch (e) {
            cwarn("[dsh-memory] 自动整合重试异常:", e && e.message ? e.message : String(e));
          }
        }, 30000);
        return false;
      }
      // v1.11.0：整合升级（对标 mimocode Dream）—— D3 归类分节+来源id、D4 容量上限+修剪、验证后写入
      // 只读最近信号（不穷举）+ 简报输出（省 token）
      // v2.0.5: 发起前快照 global/index 容量与时间戳行——完成后验收"模型是否真按任务书精简"，不信任口头汇报
      const dreamSnap = {};
      try {
        for (const df of ["global.md", "index.md"]) {
          const dt = fs.readFileSync(portable(MEMORY_ROOT + "/" + df), "utf8");
          dreamSnap[df] = { chars: dt.length, stampLine: (dt.split("\n").slice(0, 5).find((l) => l.includes("最后更新")) || "") };
        }
      } catch (e) { /* 快照失败不影响发起 */ }
      // v2.0.5: 自校准统计预计算——中位数/占比等数字由代码算好直接喂给整合代理（LLM 算数不可靠），
      // 子代理只做定性判断（要不要调、调哪个方向）并经 dsh_spiral_thresh 钳制应用。
      // v2.4.30：spiralEvents 按 kind 分流（无 kind=存量 D）——D/E 各自独立校准，互不污染
      let calibStats = "监控数据不足（D 类样本<5 或无周期画像），跳过 D-threshold Self-Calibration 节";
      let eCalibStats = "E 类样本不足（<5），跳过 E-loop Self-Calibration 节";
      let wCalibStats = "W 类样本不足（watchEvents<3），跳过 Watchdog Self-Calibration 节";
      try {
        const md = readMonitorData();
        const seAll = Array.isArray(md.spiralEvents) ? md.spiralEvents : [];
        const seD = seAll.filter((x) => !x.kind || x.kind === "D");
        const seE = seAll.filter((x) => x.kind === "E");
        const tps = Array.isArray(md.turnProfiles) ? md.turnProfiles : [];
        const curTh = effectiveSpiralThresh();
        if (seD.length >= 5 && tps.length > 0) {
          const reps = seD.map((x) => x.repRate || 0).sort((a2, b2) => a2 - b2);
          const medRep = reps[Math.floor(reps.length / 2)];
          const negs = seD.map((x) => x.negRate || 0).sort((a2, b2) => a2 - b2);
          const medNeg = negs[Math.floor(negs.length / 2)];
          const spiralCycles = tps.filter((x) => (x.spiralN || 0) > 0).length;
          const spiralPct = Math.round((spiralCycles / tps.length) * 100);
          calibStats = "D 类样本 " + seD.length + " 条；repRate 中位数=" + medRep + "，negRate 中位数=" + medNeg + "；近 " + tps.length + " 个周期中 D 打转周期占 " + spiralPct + "%；当前生效 rep≥" + curTh.rep + "/neg≥" + curTh.neg + "/sim≥" + curTh.sim + "/窗" + curTh.w + "/冷却" + curTh.cooldownMin + "分";
        }
        if (seE.length >= 5 && tps.length > 0) {
          const eCycles = tps.filter((x) => (x.spiralE || 0) > 0).length;
          const ePct = Math.round((eCycles / tps.length) * 100);
          const eHomoVals = seE.map((x) => x.homoRate || 0).sort((a2, b2) => a2 - b2);
          const medHomo = eHomoVals.length ? eHomoVals[Math.floor(eHomoVals.length / 2)] : 0;
          const eNvals = seE.map((x) => x.clusterN || 0).sort((a2, b2) => a2 - b2);
          const medN = eNvals.length ? eNvals[Math.floor(eNvals.length / 2)] : 0;
          eCalibStats = "E 类样本 " + seE.length + " 条；触发周期占 " + ePct + "%；簇大小中位=" + medN + "，同质率中位=" + medHomo + "；当前生效 成功上限" + curTh.sameNeg + "/步数≥" + curTh.sameSteps + "/墙钟≥" + curTh.sameMinSecs + "s/同质≤" + curTh.sameHomo;
        }
        const we = Array.isArray(md.watchEvents) ? md.watchEvents : [];
        if (we.length >= 3) {
          const stepsV = we.map((x) => x.steps || 0).sort((a2, b2) => a2 - b2);
          const medSteps = stepsV[Math.floor(stepsV.length / 2)];
          const wallV = we.map((x) => x.wallSecs || 0).sort((a2, b2) => a2 - b2);
          const medWall = wallV[Math.floor(wallV.length / 2)];
          wCalibStats = "W 类样本 " + we.length + " 条；无介入步数中位=" + medSteps + "，墙钟中位=" + Math.round(medWall / 60) + " 分；当前生效 步数≥" + curTh.watchSteps + "/墙钟≥" + curTh.watchSecs + "s/冷却=" + curTh.watchCooldownMin + "分";
        }
      } catch (e) { /* 统计失败按数据不足处理 */ }
      // v2.6.0（brk 熔断自校准）：读 breakerEvents（D2 deny + D3 reject 样本，独立数组）喂整合代理微调 brkSameN/brkMaxDeny/brkMinSteps
      let brkCalibStats = "熔断样本不足（breakerEvents<3），跳过 Break Self-Calibration 节";
      try {
        const md2 = readMonitorData();
        const be = Array.isArray(md2.breakerEvents) ? md2.breakerEvents : [];
        if (be.length >= 3) {
          const denyN = be.filter((x) => x.action === "deny").length;
          const rejectN = be.filter((x) => x.action === "reject").length;
          const curTh2 = effectiveSpiralThresh();
          brkCalibStats = "熔断样本 " + be.length + " 条（D2拒调 " + denyN + " / D3停轮 " + rejectN + "）；当前生效 同指纹≥" + Math.round(curTh2.brkSameN) + "/上限deny " + Math.round(curTh2.brkMaxDeny) + "/无穿插步≥" + Math.round(curTh2.brkMinSteps);
        }
      } catch (e) { /* 统计失败按数据不足 */ }
      // v0.5（step5-2 档）：维护阈值自校准统计预计算——代码算好喂整合代理（对齐 calibStats「LLM 算数不可靠」）。
      // 数据源 = step0 埋点 maintSamples {t,fname,beforeChars,afterChars,result}；样本 <3 提示数据不足。
      let maintStats = "维护样本不足（maintSamples<3），跳过 Maint-threshold Self-Calibration 节";
      try {
        const md = readMonitorData();
        const ms = Array.isArray(md.maintSamples) ? md.maintSamples : [];
        if (ms.length >= 3) {
          const okS = ms.filter((x) => x.result === "ok");
          const failN = ms.length - okS.length;
          const failRate = Math.round((failN / ms.length) * 100);
          const beforeArr = ms.map((x) => Number(x.beforeChars) || 0).sort((a2, b2) => a2 - b2);
          const medBefore = beforeArr[Math.floor(beforeArr.length / 2)];
          const okDrop = okS.filter((x) => Number(x.afterChars) > 0).map((x) => Math.round(((Number(x.beforeChars) || 0) - (Number(x.afterChars) || 0)) / (Number(x.beforeChars) || 1) * 100));
          const medDrop = okDrop.length ? okDrop.sort((a2, b2) => a2 - b2)[Math.floor(okDrop.length / 2)] : null;
          const curT = maintTriggerChars();
          const waterPct = Math.round((medBefore / curT) * 100);
          maintStats = "maintSamples 共 " + ms.length + " 条；触发前水位中位数=" + waterPct + "%（" + medBefore + "/阈值" + curT + "）；失败率=" + failRate + "%（" + failN + "/" + ms.length + "）" + (medDrop !== null ? "；成功轮回落中位数=" + medDrop + "%" : "");
        }
      } catch (e) { /* 统计失败按数据不足处理 */ }
      // v0.5（P1-2）：pending-lessons 沉淀预计算——插件按分配规则选条目拼摘要喂给整合代理（对标 calibStats「LLM 算数不可靠」先例）。
      // 分配：全部 resolved + 最旧未喂 open ≤10；feedAt/feedState 去重（已喂且状态未变不重喂）。
      let lessonFeedText = "## Pending Lessons（回归闭环沉淀候选，插件已按规则算好本轮投喂）\n- （无待沉淀条目）";
      let lessonPickN = 0;   // v2.4.33：空轮判定用——本轮待沉淀候选数（try 内赋值）
      try {
        if (PLUGIN_CFG.regressionEnabled !== false) {
          const P = readLessonPending();
          const cands = P.entries
            .filter((e) => e.state === "resolved" || e.state === "open")
            .map((e) => {
              const wasFed = e.feedAt > 0 && e.feedState === e.state;
              return { e, wasFed };
            })
            .filter((x) => !x.wasFed)                       // feedAt/feedState 去重：已喂且状态未变不重喂
            .sort((a, b) => (a.e.state === "resolved" ? 0 : 1) - (b.e.state === "resolved" ? 0 : 1) || (a.e.capturedAt || 0) - (b.e.capturedAt || 0));
          const pick = cands.slice(0, 10);                  // ≤10 条（resolved 优先，open 按最旧）
          lessonPickN = pick.length;   // v2.4.33：空轮判定用
          if (pick.length > 0) {
            const lines = pick.map((x, i) => {
              const e = x.e;
              const ctx = e.context || {};
              return "L" + (i + 1) + ". [" + e.state + "] " + e.sig + "（tool=" + (ctx.tool || "?") + "）" +
                "\n   error: " + String(ctx.error || "").slice(0, 120) +
                "\n   args: " + String(ctx.args || "").slice(0, 120) +
                (e.solution && e.solution.summary ? "\n   solution: " + String(e.solution.summary).slice(0, 200) : "");
            }).join("\n");
            // v2.4.14(lesson-settle)：skip 名单改用序号 L1..Ln（sig 含空格/引号/逗号，直接拼 sig 不可解析可靠）
            const skipIds = pick.map((x, i) => "L" + (i + 1)).join(",");
            lessonFeedText = "## Pending Lessons（回归闭环沉淀候选，插件已按规则算好本轮投喂：" + pick.length + " 条）\n" +
              lines + "\n\n### 处置规则（**每候选必须表态其一**，禁止无视）\n" +
              "- 可沉淀成正式踩坑记录：调用 memory_dream_patch 写入合适文件（tools/ 或 projects/ 或 global.md 踩坑小节），内容=错误现象+解法，保留 sig 引用；\n" +
              "- 无价值/重复：Output 标记 lesson-skip:" + skipIds + "（按上方 L 序号点名，如 L1,L3；可多轮 Output 汇总一次）；\n" +
              "- **Output 末尾必须输出 lesson-dealt 表态清单**：`lesson-dealt:L1(沉淀),L2(拒绝),…` 每候选一行，**清单写同一行**（逗号分隔；跨行只认行内，第二行视为未表态）——已写入 memory_dream_patch 的标 沉淀，明确无价值的标 拒绝；对标 lesson-skip 语法（lesson-dealt 与 lesson-skip 任一有效即算表态）；\n" +
              "- 硬约束（v2.4.16 插件硬验收）：既不写入也不点名拒绝也不输出 lesson-dealt 的候选 = **未表态**，插件按「未沉淀」回滚重喂并在结算中标示；lesson-skip 只用于**明确拒绝**，已写入的候选**不要**标拒绝；\n" +
              "- 沉淀完成条目将从 pending 移除（插件侧，按写入证据核验）；skip 条目标记已喂，同状态不再重喂。\n";
            // 记录本轮投喂（feedAt/feedState 落盘，供去重；序号清单供结算）
            try {
              // v2.4.15(lesson-settle-hard): 本轮证据缓冲初始化（spawn 入口即清，防上次残留混入本轮）
            DREAM_ROUND_WROTE = [];
            // v2.5.1(P3-2b): DREAM_WRITTEN_RELS 初始化已上移到 spawnIntegrate 无条件段（候选 0 条时也须记账）
            DREAM_FEED_ROUND = pick.map((x, i) => ({ idx: i + 1, sig: x.e.sig, sessionId: x.e.sessionId }));
              for (const x of pick) { const e = x.e; e.feedAt = Date.now(); e.feedState = e.state; }
              scheduleLessonSave(true);
            } catch (e) {}
          }
        }
      } catch (e) { /* 预计算失败按无候选处理 */ }
      // v2.3.4(dream-hash): 候选清单注入——内容 hash 比对（账本无记录或内容变更才读；已整合且未变的自跳过）
      const stI = readIntegrateState() || {};
      const candI = listIntegrateCandidates(stI);
      // v2.4.33（空轮根治 B）：超限最近摘要强制入候选——hash 已记账（内容未变）但字符超硬预算的文件
      //   不在 hash 差异候选里，子代理永远不会读它 → 超限永远不修（实证：09-07 2119>1500 health 挂着）。
      let overSessionRel = null;
      try {
        const _so = await checkSizeOverflow();
        const _trunc = (_so || []).filter((x) => x.truncated && x.file);
        if (_trunc.length > 0) {
          const f0 = _trunc[0].file;
          const rel0 = "sessions/" + f0;
          if (!candI.sessionCands.includes(rel0)) candI.sessionCands.push(rel0);
          overSessionRel = rel0;
        }
      } catch (eO) { /* 扫描失败不影响发起 */ }
      // v2.4.20（容量治理 spillover）：扫描超限项目文件 → EXTRACTION 段 + Input Scope 追加入口（P0-5）
      const _projChars = listProjectChars();
      const overChar = _projChars.filter((x) => x.chars > PROJECT_CHAR_HARD);
      const softChar = _projChars.filter((x) => x.chars > PROJECT_CHAR_SOFT && x.chars <= PROJECT_CHAR_HARD);
      let capacityText = "## Project Memory Capacity（v2.4.20，插件实测字符数=JS String.length）\n";
      if (overChar.length > 0) {
        const t0 = overChar[0];
        capacityText += "硬超限（>9000，本轮只处理字符最大的 1 个，其余下轮）:\n- " + t0.rel + "（" + t0.chars + " 字符，超 " + (t0.chars - PROJECT_CHAR_SOFT) + "）\n";
        if (overChar.length > 1) capacityText += "其余下轮: " + overChar.slice(1).map((x) => x.rel + "(" + x.chars + ")").join("、") + "\n";
        // v2.4.28（D2）：超限文件附 ## 分节字符表（机器算好喂给子代理，历史节标首选提取——不再需要模型手数"够不够 1897 字符"）
        try {
          const _txt = fs.readFileSync(portable(MEMORY_ROOT + "/" + t0.rel), "utf8");
          const _secs = charSectionBreakdown(_txt, { maxRows: 15 });
          capacityText += "分节字符（" + t0.rel + "，历史节 [归档/漏网会话补档] 标首选提取）:\n" +
            _secs.map((s) => "- " + s.title + ": " + s.chars + " 字符" + (/^##\s*(归档|漏网会话补档)/.test(s.title) ? "（首选提取）" : "")).join("\n") + "\n";
        } catch (eS) {}
        capacityText += "提取要求（对标 mimocode 已生产验证）:\n" +
          "1. \"较不重要\"优先: 已稳定决策 > 死胡同 > 历史/已完成步骤（## 归档/## 归档：* 命名节内条目优先）> 与当前焦点无关；受保护行=任何含 knowledge/MEMORY- 引用的指针行（`- See knowledge/…`、`详见 knowledge/…`、`→ knowledge/…` 等措辞均可）不得提取.\n" +
          "2. 目标: knowledge/MEMORY-<项目>-<topic>.md；同名已存在 → append 合并不覆盖；topic 简短中文/字母数字，禁空白与特殊字符.\n" +
          "3. 主文件删提取行后，在任一 ## 归档/## 归档：* 节（无则文件尾）插入索引行: `- See knowledge/MEMORY-<项目>-<topic>.md（N 项）— 一句话摘要`.\n" +
          "3b. 全局层（global/index 整节下沉，v2.4.32）：与 projects 同理，指针行固定插主文件尾部；目标文件命名 MEMORY-global-<topic>.md / MEMORY-index-<topic>.md；段落选择与保护规则同上（任何含 knowledge/MEMORY- 引用的指针行不得提取、提取时保留在主文件）.\n" +
          "4. 收敛（v2.4.28 起插件写时校验，无需自测）: 提取后 replace 若仍 >max(9000, 提取前×0.8) 会被 memory_dream_patch 现场拒写并回传差数与分节表，按差数再提取即可；达标=同轮闭环；全局目标 ≤6000（净空 3000，防 append 即重超）; 连续 3 轮仍 >9000 会升级 health（建议人工检视）.\n" +
          "5. 同批原子: 主文件 replace 与 knowledge 写入必须同一次 memory_dream_patch 调用（整批落盘）.\n" +
          "6. 禁嵌套 spill（不从 spillover 再提取）；严禁封面截断/删除未提取事实.\n" +
          "7. sunk 纪律: knowledge/MEMORY-<项目>-* 提取产物默认不回提 projects/（除非新证据: 后续会话明确确认为同一主题权威更新）.\n";
      } else {
        capacityText += "（无硬超限文件）\n";
      }
      if (overChar.length === 0 && softChar.length > 0) {
        capacityText += "软候选（6000-9000，仅当本轮写入该文件时适用）: " + softChar.map((x) => x.rel + "(" + x.chars + ")").join("、") + " —— 可顺手精简合并重复/过时条目.\n";
      }
      capacityText += "\n";
      const scopeText = "## Input Scope（插件已按内容 hash 比对算好，本轮只读下列文件）\n" +
        "- 必读稳定层: global.md, index.md\n" +
        (candI.sessionCands.length ? "- 候选会话: " + candI.sessionCands.join(", ") + "\n" : "- 候选会话: （无变化——已整合且内容未变的自动跳过）\n") +
        (candI.otherCands.length ? "- 其他变动: " + candI.otherCands.join(", ") + "\n" : "") +
        (overChar.length ? "- 容量治理必读（EXTRACTION 段列出，即使 hash 未变也必须读）: " + overChar.map((x) => x.rel).join(", ") + "\n" : "") +
        (overSessionRel ? "- 超限必读（最近摘要超硬预算，即使 hash 未变也必须读并精简回注入预算内）: " + overSessionRel + "\n" : "") +
        "- 本轮=hash 比对增量（只读「账本无记录或内容变更过」的文件；任何文件内容一变即自动回归候选）\n" +
        "- 硬约束: 只 read 上述列出的文件；严禁 glob/read sessions/、projects/、knowledge/ 下未列出的文件；严禁读原始会话日志.\n";

      const promptText =
"Run one automatic memory consolidation pass for the current DSH memory library (~/.dsh/memory/).\n" +
"Consolidate only durable, VERIFIED information. Memory files (sessions/ summaries) are the working index.\n" +
"\n" +
scopeText +
"\n" +
"## Sources\n" +
"- Primary: Input Scope 清单内的 sessions/*.md 摘要（尤其最近几天、跨会话反复出现的信号）.\n" +
"- 只读 Input Scope 清单内的文件，不要穷举、不要探索清单外的记忆库文件.\n" +
"\n" +
"## Consolidate (D3: 跨会话归类 + 保留来源)\n" +
"把跨会话成立、值得长期保留的条目提升为精确分节，逐条保留来源会话（追加 [ses YYYY-MM-DD] 或 [ses <id>]）：\n" +
"1. 跨项目通用（用户偏好/踩坑/方法论）→ global.md，按 必守/偏好/踩坑 小节归类.\n" +
"2. 项目专属事实/决策 → projects/<项目名>.md，分节：\n" +
"   - ## Rules（用户明示的项目级规则）\n" +
"   - ## Architecture decisions（决策 + 绝对日期 YYYY-MM-DD + 理由）\n" +
"   - ## Patterns（反复出现的问题与解决）\n" +
"   - ## Gotchas（易踩的坑 / 陷阱）\n" +
"   - ## Discovered durable knowledge（跨会话确证的事实）\n" +
"3. 每条 1-3 行；合并重复条目（精确字面量：文号/路径/数字/命令逐字保留，绝不改写）；相对日期转 YYYY-MM-DD.\n" +
"\n" +
"## Verify (D3)\n" +
"写提到的文件路径前用 glob、函数/类名前用 grep 核实存在；无法证实但合理的标 [unverified]；被新决定/新代码推翻的条目标记删除或移除.\n" +
"\n" +
"## Prune (D4: 容量上限 + 修剪过期)\n" +
"1. global/index 若超预算，memory_dream_patch 会现场拒写并回传本次将写成的字符数、差数与分节表——按差数做**整节下沉**一次成型即可，禁止自行估算或对齐任何字符数（选择标准：已稳定决策 > 死胡同 > 历史/完成步骤（## 归档/## 归档：* 命名节内条目优先）> 与当前焦点无关；任何含 knowledge/MEMORY- 引用的指针行（`- See knowledge/…`、`详见 knowledge/…`、`→ knowledge/…` 等措辞均可）不得作为提取对象、提取时保留在主文件；下沉目标 knowledge/MEMORY-global-<topic>.md（index 用 MEMORY-index-<topic>.md）；主文件删节后尾部插 `- See knowledge/<文件>（N 项）— 一句话摘要`（措辞可同左，验收按存在 knowledge/MEMORY- 引用判定）；同批原子提交；主文件删节变短属合法，replace 须带 full_rewrite:true 或改用「edit 删该节正文 + append 尾部指针」组合）。**禁止以 delete 逐条删内容替代下沉**（delete 仅用于删已标 [unverified] 的过期条目）；章节用 ## 明确分类（便于分区感知注入保留骨架）. 达标由 memory_dream_patch 写时校验判定（v2.4.28），无需自测.\n" +
"2. sessions/当日文件保持精炼要点+指向（当日注入面以不超限为准，超限会被机器测量并强制拉回整合），细节归档 knowledge/ 或对应 project 文件.\n" +
"2b. 近3日 dump 保护（硬纪律，工具层会直接拒绝违例补丁）：今日/昨日/前日的 sessions/YYYY-MM-DD.md 中 <!-- compaction: 标记的 dump 块不得删除或减少——只可修剪要点块；清理超过 3 天文件的 dump 时须逐块给出去向指针（durable 事实已提升到哪个文件）。（v2.4.16 起新文件不再产生 dump 块，本条仅约束存量）.\n" +
"3. 移除：被新决定取代的条目、仅与单个会话相关不再成立的细节、与更强记忆重复的低信号条目.\n" +
"4. 只精简/合并/修剪，不删除仍有价值的事实；删除前 [unverified] 或明确标注.\n" +
"\n" +
capacityText +
"## Write Path（交付工具——落盘走 memory_dream_patch，本子代理无写文件工具）\n" +
"- 工具面：read/grep/glob/memory_search/memory_size_preview/dsh_spiral_thresh/memory_dream_patch；write/edit/pwsh/run_code 均不可用，不要尝试写文件.\n" +
"- 凡需写入/修改记忆库文件：调用 memory_dream_patch 工具，参数 { patches: [ { file, action, content?, old_string?, new_string?, full_rewrite?, reason? } ] }——action ∈ edit|replace|append|delete；file 为 ~/.dsh/memory/ 下相对路径（sessions|projects|knowledge|tools/ 或 global.md|index.md）；content ≤128KB（edit 免 content，用 old_string/new_string）.\n" +
"- action 使用规则：**edit＝改局部的默认且首选方式**（old_string→new_string 精确替换，须唯一命中；old_string 从 read 该文件全量后逐字复制；new_string 空串＝删除该片段）；append＝末尾追加；delete＝删除 content 精确原文块；replace＝整文件覆盖，仅新建文件或整体重写时用——把已存在文件（尤其 global.md/index.md/projects/*.md）显著改短必须带 full_rewrite:true，否则被收缩熔断拒写。改已有文件的少数几行/某一节一律用 edit，禁止「read 全文→本地改→整份 replace 回传」（易漏抄、静默丢内容）。同一批内不要「大幅缩水 edit + 重写余量 replace」组合，拆两次调用或 replace 带 full_rewrite:true.\n" +
"- 工具会当场校验并落盘：成功返回 wrote 清单；失败返回错误清单（哪一条/哪个字段/为什么）——按清单修正后再次调用，可多次调用直到全部通过.\n" +
"- 不要输出 JSON 文本/代码块；一切写入只走 memory_dream_patch 工具.\n" +
"- **看护续期纪律（v2.6.1 根因修复）**：本子代理受 15 分钟软警告/25 分钟硬停看护（计时自最近落盘或任意工具活动；无落盘工具活动累计 24 次同样进入 3 分钟宽限）。**组装大 patch 前先落一条最小成功 patch 续期**（如先 edit/append 一条 knowledge 小文件或先写一个文件的指针行，成功落盘即重置计时），再逐步提交其余内容；巨型 replace 优先「edit 删节 + append 指针」组合（见 Prune）而非整文件全文回传。禁止「只读/只预览、长时间不落盘」的组装方式——会被看护硬停（本次事件教训：停在组装大 patch 的冒号前被 15 分钟硬杀）。\n" +
"\n" +
"\n" +
"## Efficiency\n" + "- 文件长度一律由插件机器测量并写时校验（v2.4.28）；**禁止手工数/估字符数**；输出长度机器裁决：超限重试时按差数做整节下沉，一次成型，不必对齐任何数字.\n" + "- **局部修改优先 action:\"edit\"**（old_string/new_string），避免整文件 replace 造成误覆盖；不确定改动范围时先 read 该文件全量再定位精确 old_string（v2.5.0）.\n" +
"- dry-run 预算：每个文件 memory_size_preview 最多 3 次；第 4 次起（10 分钟滑动窗内）工具直接拒绝并回传本次将写成的字符/差数/分节表——按该差数做整节下沉一次成型提交，不要再用 preview 试探.\n" +
"- 同一文件预算类拒写 ≥2 次：放弃该文件，先落盘其他内容（可最后回头一次，不允许无限迭代）.\n" +
"- 不要花步骤试探运行时能力——本节已给出全部事实.\n" +
"\n" +
"- 每个文件 edit 前先 read 全量（禁止局部读+整体覆写）；不更新 global/index 的时间戳行（保前缀缓存）;\n" +
"- 只动 ~/.dsh/memory/ 目录；不读/不依赖原始大日志;\n" +
"- 保留 source session 引用便于追溯.\n" +
"\n" +
"## D-threshold Self-Calibration（D类「LLM循环试错提醒」阈值自校准）\n" +
"- 实测统计（插件已算好，直接引用，勿自行读取文件或计算数字）：" + calibStats + "\n" +
"- 若统计提示数据不足则跳过本节。否则按此对照调整：repRate 中位数 ≤ 当前 rep+0.05 且伴随错误少 → rep 上调 0.05 降误报；打转周期占比 >50%（提醒过吵）→ neg 上调 0.05；占比 <10% 且有真实空转漏报迹象 → rep 下调 0.05 提高灵敏；提醒后很少跟进 → cooldownMin 上调。各字段合法范围见 dsh_spiral_thresh 工具描述（越界会被拒绝回退）。\n" +
"- 应用变更只准调用 dsh_spiral_thresh 工具并带 reason 参数（一句话理由，插件侧钳制校验+落盘+记变更日志；禁止直写 .monitor.json——会被插件内存态覆盖）.\n" +
"- 无需调整就不调用工具。最终 Output 加一行 Thresholds: kept/changed + 一句理由.\n" +
"## E-loop Self-Calibration（E类「成功同质循环」阈值自校准，v2.4.30）\n" +
"- 实测统计（插件已算好，直接引用）：" + eCalibStats + "\n" +
"- 若统计提示数据不足则跳过本节。否则按此对照调整：E 触发周期占比高（提醒过吵/用户常在成功循环中正常推进）→ sameSteps 上调或 sameNeg 下调降敏；E 样本稀疏但用户反馈「成功重复未被提醒」→ sameSteps 下调或 sameMinSecs 下调提敏；同质率中位远低于 sameHomo → sameHomo 下调收紧。合法范围见 dsh_spiral_thresh 工具描述（越界会被拒绝回退）。\n" +
"- 应用变更只准调用 dsh_spiral_thresh 工具并带 reason 参数；无需调整就不调用工具。\n" +
"## Watchdog Self-Calibration（W类「无介入长空转」阈值自校准，v2.4.30）\n" +
"- 实测统计（插件已算好，直接引用）：" + wCalibStats + "\n" +
"- 若统计提示数据不足则跳过本节。否则按此对照调整：W 触发且用户随后继续让其跑（误报迹象）→ watchSteps 或 watchSecs 上调降敏；用户多次手动打断长空转但 W 未报 → 下调提敏。合法范围见 dsh_spiral_thresh 工具描述；应用变更只准调 dsh_spiral_thresh 工具并带 reason 参数。\n" +
"## Break Self-Calibration（D级打转熔断阈值自校准，v2.6.0）\n" +
"- 实测统计（插件已算好，直接引用）：" + brkCalibStats + "\n" +
"- 若统计提示数据不足则跳过本节。否则按此对照调整：熔断过吵（误拒正常任务/用户手动放行）→ brkSameN 上调（更大连续次数才触发）或 brkMinSteps 上调（更严无穿插才执法）降敏；真实打转未被熔断（breakerEvents 少但用户抱怨循环烧 token）→ brkSameN 下调或 brkMaxDeny 下调提敏；deny 达上限仍打转（reject 少）→ brkMaxDeny 下调让更早升级 D3 停轮。合法范围见 dsh_spiral_thresh 工具描述（越界会被拒绝回退）。\n" +
"- 应用变更只准调用 dsh_spiral_thresh 工具并带 reason 参数；无需调整就不调用工具。\n" +
"## Maint-threshold Self-Calibration（合并维护触发阈值自校准）\n" +
"- 实测统计（插件已算好，直接引用，勿自行读取文件或计算数字）：" + maintStats + "\n" +
"- 若统计提示数据不足则跳过本节。否则按此对照调整：水位中位数 ≥90% 且失败率高（≥50%）→ triggerChars 下调（更早触发、输入更小更好压）；水位 ≤50% 且长期不触发 → 上调；失败率 ≥50% 而水位低 → 下调直至失败消失；成功回落中位数 <20%（压太狠）→ 上调。合法范围 600~1500（越界会被拒绝回退）。\n" +
"- 应用变更只准调用 dsh_maint_thresh 工具并带 reason 参数（一句话理由，插件侧钳制校验+落盘+记变更日志；禁止直写 .monitor.json——会被插件内存态覆盖）.\n" +
"- 无需调整就不调用工具。\n" +
lessonFeedText + "\n" +
"## Output — brief summary only\n" +
        "- Written files: 本次产出 DREAM_PATCH 检查点的目标文件相对路径列表（仅限 ~/.dsh/memory/ 内）\n" +
"- Consolidated: n entries added (按节列出)\n" +
"- Updated: n entries changed\n" +
"- Deleted: n entries removed\n" +
"- Skipped: reason if nothing changed\n" +
"- Health: 引用 memory_size_preview / 拒写回传的 wouldChars/budget 原样上报（未调用过工具就写「未测」），禁止自行估算字符数";
      // v2.4.33（空轮根治 A）：无候选会话、无其他变动、无超限项目、无超限摘要、无待沉淀 →
      //   本轮无事可做，**不 spawn 子代理**（省 token）：记 lastIntegrateAt + 清 lastFailAt 防 2h 死循环重试
      //   （实证 2026-09-07：空轮 0 落盘被 settle 判 doneOk=false → 置 lastFailAt → 转播「2 小时后自动重试」
      //   → 重试又空轮又置 → 永续空转）。空轮不是失败——是记忆库已稳定。
      if (candI.sessionCands.length === 0 && candI.otherCands.length === 0 && overChar.length === 0 && lessonPickN === 0) {
        clog("[dsh-memory] dream 空轮跳过（无候选会话/无超限文件/无待沉淀条目）——不发起子代理");
        try {
          const stE = readIntegrateState() || {};
          stE.lastIntegrateAt = Date.now();
          delete stE.lastFailAt;
          writeIntegrateState(stE);
        } catch (eW) {}
        DREAM_TRACK = null;
        if (DREAM_PATCH) {
          DREAM_PATCH({ status: "skipped", summary: "空轮：无候选会话/无超限文件/无待沉淀条目，记忆库已稳定，未发起子代理", finishedAt: Date.now(), durMin: 0, tokens: null, health: "" });   // v2.4.35.1：空轮不走 settle→S3 清不到旧告警（实证 09-07 双重过期 health 挂面板），此处同清
        }
        DREAM_LISTENER = null;   // v2.5.1: 先转播（skipped 终态含唤醒）再摘监听——原序在 DREAM_PATCH 前清空导致空轮转播从未送达（伪转播缺陷之一）
        return "skipped";   // v2.4.33：区分「空轮跳过」与「已发起」（/dream 命令据此回不同文案）
      }
      const startedAt = Date.now();
      // v2.5.1(P3-2b): writtenRels 无条件初始化——原初始化落在 lesson 投喂分支内，候选 0 条时保持 null，
      //   使「本轮落盘清单」在无候选轮（实证 09-08 真机）永远退化为「未落盘任何文件」，事实失真。
      DREAM_WRITTEN_RELS = new Set();
      let _drmCtrl = null;   // v2.4.28（D4）：dream controller 持引用（注册 SUBAGENT_GUARDS）
      try {
        _drmCtrl = new AbortController();
        const run = await subagents.start("spawn", {
          label: "dsh-memory-自动整合-" + reason,
          prompt: [{ type: "text", text: promptText }],
          parent: parent,
          signal: _drmCtrl.signal,
          maxDepth: 2,   // v2.1.0(E2): 允许一级二级拆分并发，禁更深嵌套
                    // v2.1.0(E1): 移除 write/edit——Write Path 本就要求 run_code node:fs 直写，物理杜绝沙箱写路径
          // v2.1.0(E1)+hotfix3 2026-08-28: 只物理移除 write/edit（写 ~/.dsh 必被沙箱拒）。
          //          宿主 tools.restrict(filter) 直收 toolFilter，filter 形态必须 { allow?, deny? } 对象；
          //          写 restrict: 数组会被解析成 {} → no-op 报错；写 allow: 会把 run_code 挤出工具集且不能点名补回。
          //          deny 只移除 write/edit，run_code 保留传输默认在工具集（宿主源码 dsh-tools/lib/index.js restrict() 实证）。
          // v2.3.2(dream-patch): 检查点模式后子代理零写需求 → 纯只读 allow 白名单（物理无 write/edit/pwsh），
          //          避免再出现 run_code/pwsh 绕行不确定性；run_code 为保留传输不可点名，此处亦无需它。
          toolFilter: { allow: ["read", "grep", "glob", "memory_search", "memory_size_preview", "dsh_spiral_thresh", "dsh_maint_thresh", "memory_dream_patch"] },
        });
        markPluginSubagent(run.id);   // v2.4.27：登记插件子代理 sid（A/B/C/D 提醒隔离全关，只计 monitor）
        // v2.4.28（D4）：dream 看护注册（spSid=run.id；15 分硬停，落盘经 tools/result 续期）——settle 读 guard 的 aborted 标志
        const _dg = guardRegister(String(run.id || ""), "dream", _drmCtrl, GUARD_HARD_MS, GUARD_SOFT_MS);   // v2.6.1（V0.2 P1-1）：dream 专用 15/25 时限（不动 SUBAGENT_* 全局）
        if (_dg && run.id) _dg._runId = run.id;
                // v2.3.2(dream-tool)：结算简化——写入全部走 memory_dream_patch 工具（现场校验+落盘），
        // 无需提取/重组/followup；成功与否由 applyPatches 落盘时更新的 LAST_DREAM_WROTE_AT 判定。
        const settleDream = async () => {
          try {
            const result = await run.result;
            const outText = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
            clog("[dsh-memory] 自动整合完成（" + reason + "，stopReason=" + result.stopReason + ", 输出 " + outText.length + " 字符）");
            let u = null;
            const sdir = findNewestSpawnedSession(startedAt);
            if (sdir) {
              u = summarizeSubagentUsage(sdir);
              if (u) clog("[dsh-memory] 整合消耗: 总输入 " + (u.totalIn || u.input) + " tokens（其中缓存命中 " + u.cache + "）| 输出 " + u.output + (u.reasoning > 0 ? " | 推理 " + u.reasoning : "") + " tokens | 总时长 " + u.durMin + " 分钟");
            }
            let doneOk = LAST_DREAM_WROTE_AT >= startedAt;
            // v2.4.28（三审 P1）：dream 被 guard 硬停（部分落盘后 abort）→ 强制 doneOk=false 走失败路径（lastFailAt → 2h 重试），
            // 不因 LAST_DREAM_WROTE_AT>=startedAt 误判 success；已落盘文件失败轮不记 hash → 漏写文件下轮仍在候选。
            try { const _g = SUBAGENT_GUARDS.get(String(run.id || "")); if (_g && _g.aborted) doneOk = false; } catch (eG) {}
            guardClear(String(run.id || ""));   // v2.6.1（V0.2 P2）：结算一律清看护+提醒队列——abort 以 resolve 返回（stopReason=aborted）非 catch，原「成功才清」会让 guard 条目与入队提醒随死 sid 永久滞留（含 guardClear 内部 clearRegressionQueue）
            if (DREAM_PATCH) {
              // v2.5.1(P3-1/P3-2): summary 截断后修补未闭合标记；writtenRels 为插件侧事实快照——
              //   子代理自述措辞可能与实况不符（实证：summary 称「无落盘内容」而实际写了 index.md）；
              //   且转播走 setTimeout(0)，届时 DREAM_WRITTEN_RELS 已被 settle 清空，故在此同步取快照随 patch 下发。
              const _wr = DREAM_WRITTEN_RELS ? Array.from(DREAM_WRITTEN_RELS) : [];
              DREAM_PATCH({
                status: doneOk ? "done" : "stopped:incomplete",
                finishedAt: Date.now(),
                durMin: u ? u.durMin : Math.round(((Date.now() - startedAt) / 60000) * 10) / 10,
                tokens: u ? ("totalIn " + (u.totalIn || u.input) + " (cache " + u.cache + ") / out " + u.output) : null,
                summary: tidyTruncatedMarkdown(outText.slice(0, 200) + (outText.length > 200 ? "…" : "")),
                writtenRels: _wr
              });
            }
            const settleListener = DREAM_LISTENER;   // v2.4.16: 结算转播用——done 已转播后主流程立即置 null，先捕获再结算
            DREAM_TRACK = null;
            DREAM_LISTENER = null;   // v2.4.13(dream-live): 结算完成（done 已转播）后摘监听
            if (outText.length > 0 && outText.length <= 600) {
              clog("[dsh-memory] 整合报告: " + outText.replace(/\n/g, " | "));
            }
            const st = readIntegrateState() || {};
            st.lastIntegrateAt = Date.now();
            if (doneOk) { st.lastSuccessAt = Date.now(); st.integrateCount = (st.integrateCount || 0) + 1; delete st.lastFailAt; recordDreamedHashes(st); } // v2.3.3: 成功轮必须清除 lastFailAt，否则残留触发 2h 无限重试（每次烧数万 tokens）；v2.3.4: 成功即记全量 hash——下次只读内容变更过的
            else { st.lastFailAt = Date.now(); cwarn("[dsh-memory] 本次整合未通过 memory_dream_patch 落盘任何文件——2 小时后自动重试，请关注 progress.health"); }
            writeIntegrateState(st);
            trackMaintain("integ", u);
            // v2.4.15(lesson-settle-hard)：结算本轮投喂的回归条目——双层硬校验，不靠模型自觉。
            // ① 解析子代理 Output 的 lesson-skip:L序号 → 明确拒绝：skippedByDream++，条目保留（feedState 已标=不再重喂）。
            // ② 未点名候选 → 在本轮 memory_dream_patch **真实成功落盘内容缓冲**（DREAM_ROUND_WROTE）里做归一化子串匹配：
            //    命中 → 真沉淀：fed++ 并从台账移除（archived）；
            //    未命中 → 未沉淀：**回滚 feedAt/feedState**（保留台账，下轮重喂）——含 doneOk=false（本轮缓冲为空→全部未命中→重喂），
            //            修掉 v2.4.14「未点名=已沉淀」的沉默误计 + wasFed 锁死 30 天超时静默丢课两个缺陷。
            // 短 sig（归一化后 <40 字符）拒验：防「ENOENT」式 4 字符前缀假阳性，直接走重喂。
            try {
              if (DREAM_FEED_ROUND && DREAM_FEED_ROUND.length > 0) {
                // v2.4.16(lesson 强制表态 + 验收 P1-1)：结算计算提为模块级纯函数 settleLessonRound
                //（含 lesson-skip/dealt 解析、未表态计数、证据归一化匹配）；副作用（lessonEvent/台账变更/落盘）按 actions 执行。
                const P = readLessonPending();
                const round = settleLessonRound({
                  feed: DREAM_FEED_ROUND,
                  wrote: DREAM_ROUND_WROTE && DREAM_ROUND_WROTE.length ? DREAM_ROUND_WROTE : [],
                  outText,
                  entries: P.entries
                });
                for (const a of round.actions) {
                  if (a.action === "skip") {
                    lessonEvent(a.sig, "skipped");
                  } else if (a.action === "archive" && a.entry) {
                    lessonEvent(a.sig, "fed");
                    a.entry.state = "archived"; a.entry.archivedAt = Date.now();   // 真沉淀：从台账移除
                  } else if (a.action === "refeed" && a.entry) {
                    // 回滚投喂标记→下轮重喂（含 doneOk=false 的沉默轮；entry 若已被容量/超时归档则不复活）
                    if (a.entry.state === "open" || a.entry.state === "resolved") { a.entry.feedAt = 0; a.entry.feedState = null; }
                  }
                }
                const fedN = round.fed, skipN = round.skipped, refeedN = round.refeed, unstatedN = round.unstated;
                const lc = lessonCounters();
                if (fedN > 0) { lc.fed = (lc.fed || 0) + fedN; }
                if (skipN > 0) { lc.skippedByDream = (lc.skippedByDream || 0) + skipN; }
                const lessonActive = fedN + skipN + refeedN > 0 || unstatedN > 0;
                const auditText = LAST_PROJECT_AUDIT;   // v2.4.18（P1-7）：体检并入结算广播恰一条
                if (lessonActive || auditText) {
                  if (lessonActive) { scheduleLessonSave(true); scheduleMonitorSave(); }
                  const settleNote = (lessonActive ? "沉淀 " + fedN + " · 拒绝 " + skipN + " · 未命中回滚重喂 " + refeedN + (unstatedN > 0 ? "（其中子代理未表态 " + unstatedN + "）" : "") : "") +
                    (auditText ? (lessonActive ? "；" : "") + auditText : "");
                  clog("[dsh-memory] 回归结算（" + reason + "）：" + settleNote);
                  // v2.4.16：结算转播进发起会话（done 已置 null → 用 settle 前捕获的监听）
                  // v2.5.1(转播可见性): 与进度转播同规——直接落会话表面即渲染为 notice 行（免唤醒可见）；旧宿主无 append 回退 inject。
                  if (settleListener) {
                    const _sbody = "<system-reminder>\n【dsh-memory · dream 回归结算】" + settleNote + "\n</system-reminder>";
                    const smsg = makeNoticeMessage(_sbody, ("dream 回归结算：" + settleNote).slice(0, 140));
                    setTimeout(() => {
                      try {
                        if (settleListener.session && typeof settleListener.session.append === "function") settleListener.session.append("user/message", smsg, { surfaceOp: "append" });
                        else if (typeof settleListener.inject === "function") settleListener.inject(makeMessage(_sbody));
                      } catch (e) {}
                    }, 0);
                  }
                  if (unstatedN > 0) { try { monitorEvent("lesson", "unstated " + unstatedN + " 条 " + reason); } catch (e) {} }
                }
                LAST_PROJECT_AUDIT = null;   // v2.4.18：广播后清（一次性）
              }
            } catch (e7) { cwarn("[dsh-memory] 回归结算异常:", e7 && e7.message ? e7.message : String(e7)); }
            try {
              const health = [];
              for (const df of ["global.md", "index.md"]) {
                try {
                  const dt = fs.readFileSync(portable(MEMORY_ROOT + "/" + df), "utf8");
                  const lim = df === "global.md" ? 3000 : 2000;
                  if (dt.length >= lim) health.push(df + " " + dt.length + "字符未达精简目标(<" + lim + ")");
                  if (dreamSnap[df] && dreamSnap[df].stampLine && !dt.includes(dreamSnap[df].stampLine)) health.push(df + " 时间戳行被改动(前缀缓存失效)");
                } catch (e2) {}
              }
              try {
                const so = await checkSizeOverflow();
                // v2.3.3: 只把「硬超字符预算（注入会被截断）」判为整合失败；软字节超是维护信号（中文 3000 字符≈5100B 恒 >4608B 软阈），当失败会永远验收不过
                for (const i9 of so || []) { if (!i9.truncated) continue; health.push((i9.label || i9.key || "?") + " 整合后仍超限（字符 " + i9.chars + " ≥ 硬预算 " + i9.charLimit + "，注入会截断）"); }
              } catch (e6) {}
              try {
                // v2.4.20（容量治理验收）：项目文件字符硬限 + 提取一致性核对（机器兜底"不删事实"）
                const wrSet = DREAM_WRITTEN_RELS || new Set();
                for (const pcc of listProjectChars()) {
                  if (pcc.chars > PROJECT_CHAR_HARD) {
                    health.push(pcc.rel + " 仍超限（字符 " + pcc.chars + " > 9000" + (wrSet.has(pcc.rel) ? "，本轮已写" : "，本轮未写") + "）——下次整合优先提取");
                  } else if (pcc.chars > PROJECT_CHAR_SOFT && wrSet.has(pcc.rel)) {
                    health.push(pcc.rel + " 偏大（字符 " + pcc.chars + "，6000-9000，本轮已写——可精简合并）");
                  }
                }
                for (const r2 of wrSet) {
                  if (!/^knowledge\//.test(r2)) continue;
                  const bn2 = r2.slice(r2.lastIndexOf("/") + 1);
                  const mm2 = /^MEMORY-(.+)-/.exec(bn2);
                  if (!mm2) continue;
                  const pfile2 = "projects/" + mm2[1] + ".md";
                  let ptxt2 = ""; try { ptxt2 = fs.readFileSync(portable(MEMORY_ROOT + "/" + pfile2), "utf8"); } catch (eR2) { continue; }
                  if (!ptxt2.includes("- See knowledge/" + bn2) && !ptxt2.includes(bn2)) {
                    health.push("提取一致性：" + r2 + " 在主文件 " + pfile2 + " 无指针（不删事实承诺缺索引）");
                  }
                }
              } catch (eP2) {}
              try {
                // v2.4.32（P0-7）：下沉完整性最小闸——global/index 本轮被 replace 且字符减少 ≥300 且无任何
                //   指向 knowledge/MEMORY-* 的内容引用 → 疑似纯删未下沉（整节下沉必须留指针；delete 大删不在此列，属 [unverified] 合法清理）。
                // v2.4.33（误报根治）：锚点从字面 `- See knowledge/` 放宽为 knowledge/MEMORY- 引用——历史指针
                //   有 `详见 knowledge/…`、`→ knowledge/…` 等措辞，整节下沉子代理实际落盘也用 `→` 风格，字面锚点误报「疑似纯删」。
                const wrSet7 = DREAM_WRITTEN_RELS || new Set();
                for (const df7 of ["global.md", "index.md"]) {
                  if (!wrSet7.has(df7)) continue;
                  const bs7 = dreamSnap[df7] && dreamSnap[df7].chars;
                  if (typeof bs7 !== "number") continue;
                  let cur7 = ""; try { cur7 = fs.readFileSync(portable(MEMORY_ROOT + "/" + df7), "utf8"); } catch (eR7) { continue; }
                  if (bs7 - cur7.length >= 300 && !cur7.includes("knowledge/MEMORY-")) {
                    health.push(df7 + " 疑似纯删未下沉（replace 后字符减少 ≥300 且无指向 knowledge/MEMORY-* 的指针）——整节下沉必须留指针");
                  }
                }
              } catch (eS7) {}
              if (health.length) {
                cwarn("[dsh-memory] 整合验收未过: " + health.join("; ") + "——下次整合优先处理");
                if (DREAM_PATCH) DREAM_PATCH({ health: health.join("; ").slice(0, 200) });
              } else if (dreamSnap["global.md"]) {
                clog("[dsh-memory] 整合验收通过: global/index 容量与时间戳行合规");
                // v2.4.35（评审 S3）：验收通过必须清 progress.health 旧值——否则上一轮的过期告警永久挂在
                //   .integrate.json/转播里误导用户（实证 2026-09-07：本轮全部达标，health 仍显示上轮「2119≥1500」）。
                //   Object.assign merge 语义下空串覆盖即清除；rebroadcastDream 对 falsy health 短路不转播空话。
                if (DREAM_PATCH) DREAM_PATCH({ health: "" });
              }
            } catch (e2) {}
            try {
              const touched = [];
              const scanMem = (d0) => { for (const e of fs.readdirSync(d0, { withFileTypes: true })) { const p1 = d0 + "/" + e.name; if (e.isDirectory()) scanMem(p1); else if (fs.statSync(p1).mtimeMs >= startedAt - 2000) touched.push(p1.replace(portable(MEMORY_ROOT) + "/", "")); } };
              scanMem(portable(MEMORY_ROOT));
              if (touched.length > 0) { clog("[dsh-memory] 记忆文件变更于本次整合 (" + touched.length + " 个):"); for (const t1 of touched) clog("  - " + t1); }
              else { cwarn("[dsh-memory] 本次整合未观测到任何记忆库文件写入"); }
            } catch (e5) {}
            clog("[dsh-memory] 下次自动整合：" + PLUGIN_CFG.integrateDays + " 天后");
            DREAM_FEED_ROUND = null;   // v2.4.14(lesson-settle): 结算完成清清单
DREAM_ROUND_WROTE = null;   // v2.4.15(lesson-settle-hard): 证据缓冲同步清
            DREAM_WRITTEN_RELS = null;   // v2.4.20: 同步清
          } catch (e) {
            cwarn("[dsh-memory] 整合结算异常:", e && e.message ? e.message : String(e));
            try { const st = readIntegrateState() || {}; st.lastIntegrateAt = Date.now(); st.lastFailAt = Date.now(); writeIntegrateState(st); } catch (e2) {}
            DREAM_TRACK = null;
            DREAM_LISTENER = null;   // v2.4.13(dream-live): 结算异常摘监听
            rollbackLessonFeedRound();   // v2.4.24（审查 P0-2）：异常路径回滚本次投喂标记
            DREAM_FEED_ROUND = null;   // v2.4.14(lesson-settle): 结算异常清清单
DREAM_ROUND_WROTE = null;   // v2.4.15(lesson-settle-hard): 证据缓冲同步清
            DREAM_WRITTEN_RELS = null;   // v2.4.20: 同步清
            try { guardClear(String(run.id || "")); } catch (eG) {}   // v2.4.28（D4）：结算异常清看护
          }
        };
        run.result.then(async () => { await settleDream(); }).catch((e) => {
          LAST_PROJECT_AUDIT = null;   // v2.4.18：失败路径清体检暂存（不留到下次误拼）
          cwarn("[dsh-memory] 自动整合子代理失败:", e && e.message ? e.message : String(e));
          if (DREAM_TRACK && DREAM_PATCH) { DREAM_PATCH({ status: "failed", error: String((e && e.message) || e).slice(0, 120) }); }
          DREAM_TRACK = null;
          DREAM_LISTENER = null;   // v2.4.13(dream-live): 失败摘监听（failed 已转播）
          rollbackLessonFeedRound();   // v2.4.24（审查 P0-2）：失败路径回滚本次投喂标记
          DREAM_FEED_ROUND = null;   // v2.4.14(lesson-settle): 失败清清单
DREAM_ROUND_WROTE = null;   // v2.4.15(lesson-settle-hard): 证据缓冲同步清
            DREAM_WRITTEN_RELS = null;   // v2.4.20: 同步清
            try { guardClear(String(run.id || "")); } catch (eG) {}   // v2.4.28（D4）：失败路径清看护
        });        // v2.2.4: DREAM_TRACK 占位已上移至 runDreamPipeline 入口（同步段），此处不再重设（避免刷新心跳基准）
        dreamProgressPatch({ status: "running", reason: reason, startedAt: Date.now(), steps: 0, lastTool: "-" });
        clog("[dsh-memory] 已发起自动整合子代理（" + reason + "，后台执行中；进度见 ~/.dsh/memory/.integrate.json progress 字段）");
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 自动整合启动失败:", e && e.message ? e.message : String(e));
        DREAM_TRACK = null;   // v2.2.4: 启动异常清占位
        DREAM_LISTENER = null;   // v2.4.13(dream-live): 启动异常摘监听
        return false;
      }
    }

    // v2.2.4: dream 在途互斥——同一时刻只允许一条整合管线。并发场景：连发两次 /dream、手动+定时到点、
    // 多会话同时触发。两个整合子代理并行会对 global.md 等记忆文件做 read-modify-write 整文件覆写，
    // 后写者吞掉先写者的提升条目/两边重复提升同一批事实——必须代码闸门，不靠模型自觉。
    // 双层闸门：① 进程内 DREAM_TRACK 同步占位（封死原「await subagents.start 之后才赋值」的双发窗口）；
    // ② 持久 progress.status=running（覆盖插件重启丢内存态的残留）。孤儿兜底：进程内超 90 分钟、
    // 持久层超 40 分钟视为残留放行（正常管线远小于此限：归档等待上限 25 分+整合通常 20 分内）。
    const DREAM_STALE_PROC_MS = 90 * 60000;
    const DREAM_STALE_PERSIST_MS = 40 * 60000;
    function dreamBusyCheck() {
      if (DREAM_TRACK) {
        if (Date.now() - DREAM_TRACK.since > DREAM_STALE_PROC_MS) DREAM_TRACK = null;
        else return "进程内在途，自 " + new Date(DREAM_TRACK.since).toLocaleTimeString();
      }
      try {
        const p = (readIntegrateState() || {}).progress;
        if (p && p.status === "running" && p.startedAt && Date.now() - p.startedAt < DREAM_STALE_PERSIST_MS)
          return "进度账本显示在途（startedAt " + new Date(p.startedAt).toLocaleTimeString() + "，或为重启前残留）";
      } catch (e) { /* 读不到按空闲处理 */ }
      return null;
    }

    // v1.12.18: dream 管线——silent 模式先归档漏网再整合（一条命令到终点）；
    // remind/approval 不绕审批闸：只提示漏网数，确认归档后下次 /dream 一并处理。
    // v2.5.4(B)：管线整体挪后台 fire-and-forget——原实现宿主把本函数整个 await 在提交事务里
    //   （claim.submit → remote.commands.execute → handler），silent 归档阶段动辄数分钟，
    //   期间前端 phase=submitting：输入框挂着 `/dream `+hint 灰字、锁编辑——即用户所见「卡顿+残留」。
    //   同步段只保留：互斥检查 + DREAM_TRACK 代际占位 + 监听挂接，立即返回「已发起」；
    //   进度/终态可见性由 v2.5.1 转播链承担（首条 running patch 的「已发起」行经 notice 落表）。
    async function runDreamPipeline(reason, agentForParent) {
      const busyMsg = dreamBusyCheck();   // v2.2.4: 在途互斥检查（仍在同步段，双发窗口封死）
      if (busyMsg) {
        cwarn("[dsh-memory] dream 管线拒绝发起（" + reason + "）：" + busyMsg + "——已有整合在跑，等完成后再试");
        monitorEvent("integrate", "busy-rejected reason=" + reason + " (" + busyMsg + ")");
        return { ok: false, busy: true, msg: busyMsg };
      }
      DREAM_TRACK = { since: Date.now(), sessionId: null, steps: 0 };   // v2.2.4: 占位提前到同步段（原赋值在 await subagents.start 之后，快速连发存在双发窗口）
      const _gen = DREAM_TRACK;   // v2.5.4(B): 代际引用——后台清理只在仍属本轮时执行，防误清下一轮占位
      DREAM_BROADCAST_LAST_AT = 0;   // v2.5.1(转播可见性): 每轮重置节流水位——新 dream 的首条进度必落表
      // v2.4.13(dream-live): 手动 /dream 才设监听会话（后台子代理照旧），进度实时转播回去；定期自动整合不打扰任何会话。
      // v2.5.1(转播可见性): 可用条件放宽——inject（旧注入路径）或 session.append（新落表路径）任一即可。
      DREAM_LISTENER = (agentForParent && (typeof agentForParent.inject === "function" || (agentForParent.session && typeof agentForParent.session.append === "function"))) ? agentForParent : null;
      void (async () => {   // v2.5.4(B): 归档→整合整段后台化
        try {
          ensureStaleNotified();
          let note = "";
          try {
            const pending = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt(), true)   // v2.5.4(C): force 绕 TTL 缓存，归档清单必须现扫
              .filter((s) => archivePendingEntry(s) && !sessionMentionedInMemory(s.id));   // v1.12.19→v2.4.3：只看水位重入判定
            if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }
            if (PLUGIN_CFG.staleAction === "silent" && pending.length > 0) {
              clog("[dsh-memory] dream 管线: 先归档 " + pending.length + " 个漏网会话，完成后自动接续整合");
              const r = await runStaleArchive(pending);   // v2.4.7.1: r.ok=已发起，r.done=结算链（resolve 处置字符串）
              if (r.ok && r.done) {   // 消号 v1.12.19.1 起在子代理完成回调内执行
                const flag = await Promise.race([r.done, new Promise((res) => setTimeout(() => res("timeout"), 25 * 60000))]);
                note = "已归档 " + r.count + " 个漏网会话（" + flag + "）→ ";
              }
            } else if (pending.length > 0) {
              note = "另有 " + pending.length + " 个漏网会话未归档（staleAction=" + PLUGIN_CFG.staleAction + " 待确认，确认后下次 /dream 将一并处理）；";
            }
          } catch (e) { cwarn("[dsh-memory] dream 管线归档阶段异常:", e && e.message ? e.message : String(e)); }
          const okStart = await spawnIntegrate(agentForParent, reason);
          if (note) clog("[dsh-memory] dream 管线备注（" + reason + "）: " + note);
          if (okStart !== true && okStart !== "skipped" && DREAM_LISTENER && DREAM_PATCH) {
            // v2.5.4(B): 启动失败原本静默（宿主 command/done 不再承载本结果）——补 error 转播；
            //   仅当监听仍属本轮时才动全局态（防误清下一轮）。
            try { DREAM_PATCH({ status: "failed", error: "整合启动失败（无可用父 agent 或 subagents 服务不可用）" }); } catch (eP) {}
            if (DREAM_TRACK === _gen) DREAM_TRACK = null;
            DREAM_LISTENER = null;
          }
        } catch (e) {
          cwarn("[dsh-memory] dream 管线后台异常（" + reason + "）:", e && e.message ? e.message : String(e));
          if (DREAM_LISTENER && DREAM_PATCH) {
            try { DREAM_PATCH({ status: "failed", error: "dream 管线异常: " + String((e && e.message) || e).slice(0, 120) }); } catch (eP) {}
          }
          if (DREAM_TRACK === _gen) DREAM_TRACK = null;   // 代际守卫：不误清新一轮占位
        }
      })();
      return { ok: true, started: true, busy: false };   // v2.5.4(B): 「已发起」即时返回（空轮/失败改由转播链上报）
    }

    // 整合检查：到点且未整合过 → 发起
    async function checkIntegrate() {
      try {
        const now = Date.now();
        let st = readIntegrateState();
        if (!st) {
          // 首次：记录安装起始时间，不立即整合（给用户适应期，到 integrateDays 天后再触发）
          st = { installAt: now, lastIntegrateAt: now };
          writeIntegrateState(st);
          return;   // v1.12.19.2: 首次初始化日志静默化
        }
        if (!PLUGIN_CFG.integrateEnabled) return;
        // v2.3.2(dream): 正常 7 天周期 + 上次失败后 2 小时重试窗（失败不丢内容，定期轮次补齐）
        const sinceTry = now - (st.lastIntegrateAt || st.installAt || 0);
        const sinceFail = now - (st.lastFailAt || 0);
        const due = sinceTry >= PLUGIN_CFG.integrateDays * 86400000 || (st.lastFailAt && sinceFail >= 120 * 60000 && sinceTry >= 120 * 60000);
        if (due) {
          clog("[dsh-memory] 触发整合检查：" + (sinceTry >= PLUGIN_CFG.integrateDays * 86400000 ? "距上次已满 " + PLUGIN_CFG.integrateDays + " 天" : "上次整合失败，2 小时重试窗到点") + "，触发自动整合");
          await runDreamPipeline("定期", null);
        }
      } catch (e) {
        cwarn("[dsh-memory] 整合检查异常:", e && e.message ? e.message : String(e));
      }
    }

    // 定时器：每小时检查一次（宿主常驻进程；fiber 清理时自动 dispose）
    try {
      checkIntegrate();
      ctx.interval(() => {
        checkIntegrate();
        // v0.5（P0b-5）：回归超时判定随周期跑——48h dropped / 30d archived（levelApplyTimeout 内部 only 在变更时落盘）
        try { lessonApplyTimeout(Date.now()); } catch (e) {}
      }, 3600000);
    } catch (e) {
      cwarn("[dsh-memory] 自动整合定时器启动失败:", e && e.message ? e.message : String(e));
    }

    // v1.11.0：/dream 手动整合命令 —— 触发一次整合（复用 spawnIntegrate 全部历史整合），
    // 与 7 天自动整合统一：手动跑完同样刷新 lastIntegrateAt，与自动周期协调不重复整合。
    let dreamDisposer = null;
    try {
      if (ctx.commands && typeof ctx.commands.register === "function") {
        dreamDisposer = ctx.commands.register({
          name: "dream",
          description: "手动触发一次记忆整合（对标 mimocode /dream）：扫描历史会话，把跨会话成立的决策/踩坑/规律归类提升到 global/projects 并精简超限文件。无需参数。",
          // v2.5.4(A)：删除 input.hint——宿主对带 input 的命令走 claim 路径：输入框改写为 `/dream `
          //   并等 execute 返回才清空，hint 以 CSS 伪元素渲染成「无参数」灰字后缀（用户所见残留）；
          //   且非 leading 位置的斜杠菜单会过滤一切带 hint 的命令（/dream 从菜单消失）。
          //   去掉后回车走 bare 路径：consume-token 即时清空 + detached execute，回执仍以 info notice 呈现。
          handler: async (inv) => {
            const r = await runDreamPipeline("手动", inv.agent);   // v2.2.4: 返回 {ok,busy,started}（v2.5.4(B): 管线已后台化，即时返回）
            if (r.busy) return { kind: "error", text: "已有一次整合在跑（" + r.msg + "），同一时刻只允许一条整合管线。进度见 ~/.dsh/memory/.integrate.json 的 progress 字段，等它完成后再执行 /dream。" };
            return { kind: "success", text: "已发起 dream 管线（后台执行中）：漏网会话先归档（silent 模式自动，其他模式待你确认后单独处理）→ 接续整合全部摘要。空轮跳过/启动失败也会以进度行告知；进度实时转播到本会话，完成后收到结果摘要；也可随时问「dream 跑到哪了」。" };
          }
        });
      } else {
        cwarn("[dsh-memory] commands 服务不可用，/dream 命令未注册");
      }
    } catch (e) {
      cwarn("[dsh-memory] /dream 命令注册失败:", e && e.message ? e.message : String(e));
    }

    // v2.3.0：/memory-init 与 /memory-update —— 新装用户的两个自助入口
    //  /memory-init   绕过节流立刻给一次初始化引导（体检 → 注入 → 回显状态）
    //  /memory-update 立刻查一次远端版本（忽略每日节流），结果直接回文本
    let onboardDisposer = null;
    let updateDisposer = null;
    try {
      if (ctx.commands && typeof ctx.commands.register === "function") {
        onboardDisposer = ctx.commands.register({
          name: "memory-init",
          description: "立即体检记忆库并给出初始化引导：补齐 sessions/projects/tools/knowledge 目录骨架，缺 global.md/index.md/AGENTS.md 时引导当前会话完成初始化（绕开每日节流）。",
          input: { hint: "/memory-init 无参数" },
          handler: async (inv) => {
            const m = forceInitGuide(inv && inv.agent, "memory-init");
            const st = readOnboardState();
            const home = MEMORY_ROOT.replace(/\//g, "/");
            return {
              kind: "success",
              text: "记忆库体检=" + m.status + "（global " + m.bytesGlobal + "B / index " + m.bytesIndex + "B"
                + (m.missingDirs.length ? " / 缺目录 " + m.missingDirs.join(",") : " / 目录齐")
                + (m.hasAgents ? " / 有 AGENTS.md" : " / 缺 AGENTS.md") + "）\n"
                + "骨架目录已补齐于 " + home + "\n"
                + (m.status === "ready"
                  ? "内容已齐，无需初始化；本次只把落盘规范又发了一遍，可直接让模型补充 knowledge/ 主题文件。"
                  : "已把初始化引导发给本会话的模型：它会一次问齐（称呼/项目与编号/日常事项/协作人/偏好/环境），你答完它就落盘。\n"
                    + "之后稳定层从下一个新会话开始自动注入。状态文件：" + home + "/.onboard.json"
                    + (st.snoozeUntil ? "（snooze 至 " + new Date(st.snoozeUntil).toLocaleString() + "）" : "")),
            };
          },
        });
        updateDisposer = ctx.commands.register({
          name: "memory-update",
          description: "立即检查 dsh-memory 是否有新版本（忽略每日节流），有则给出升级命令，并提醒重启 DSH 生效。",
          input: { hint: "/memory-update 无参数" },
          handler: async () => {
            if (PLUGIN_CFG.updateCheckEnabled === false) {
              return { kind: "error", text: "升级检查已被关掉（设置 → 通用设置 → 记忆 → 检查新版）。打开后再来，或直接重跑安装命令升级。" };
            }
            const st = readOnboardState();
            st.update.checkedAt = 0;   // 绕开每日一次节流，立刻真查
            writeOnboardState(st);
            const r = await checkForUpdate("手动");
            if (!r) return { kind: "error", text: "没查到版本（网络不通/超时/镜像无 version.txt 都会这样，不影响使用）。当前本地 v" + PLUGIN_VERSION + "。稍后再试或直接重跑安装命令。" };
            if (r.newer) {
              notifyUpdateNow("/memory-update");
              return { kind: "success", text: "有新版本 v" + r.latest + "（当前 v" + PLUGIN_VERSION + "）。升级命令：" + updateCmd() + "\n装完必须重启 DSH 才生效。" };
            }
            return { kind: "success", text: "已是最新版本 v" + PLUGIN_VERSION + "（远端 v" + r.latest + "）。" };
          },
        });
      } else {
        cwarn("[dsh-memory] commands 服务不可用，/memory-init 与 /memory-update 未注册");
      }
    } catch (e) {
      cwarn("[dsh-memory] 初始化/升级命令注册失败:", e && e.message ? e.message : String(e));
    }

    // v1.12.19.2: 启动横幅合并为单条就绪日志（各组件注册失败仍有独立 cwarn/cerr 报告）
    if (!ZSTD_OK) cerr("[dsh-memory] 当前 Node 缺少 zlib.zstdDecompressSync（需 ≥22.17），会话日志提取不可用 → 漏网归档强制降级 remind（防批量静默丢失）");
    clog("[dsh-memory] 就绪 v" + PLUGIN_VERSION + "：staleSessionDays=" + PLUGIN_CFG.staleSessionDays
      + " staleAction=" + PLUGIN_CFG.staleAction + (ZSTD_OK ? "" : "(已降级remind:无zstd)")
      + " active=" + PLUGIN_CFG.active
      + " integrate=" + (PLUGIN_CFG.integrateEnabled ? PLUGIN_CFG.integrateDays + "天/次" : "关")
      + " spiral=" + (PLUGIN_CFG.spiralRemind ? "remind(D类)" : "shadow(仅记录)")
      + " 归档节流=成功60分/发起失败15分"
      + " initGuide=" + (PLUGIN_CFG.initGuideEnabled ? "on" : "off")
      + " updateCheck=" + (PLUGIN_CFG.updateCheckEnabled ? "on(每日一次)" : "off")
      + "（memory_search / stale_archive / dsh_spiral_thresh / memory_onboard / /dream /memory-init /memory-update 已挂载，定时器运行中）");

    // v2.2.6：检索层启动自检——异步错峰执行不阻塞就绪；结果进监控汇总与零结果提示，失配必暴露
    setTimeout(() => { runRetrievalSelfCheck(); }, 3000);

    // v2.3.0：记忆库体检（顺手补齐骨架目录）+ 升级检查（每日一次，错峰 6 秒不拖启动）
    try {
      const mem0 = inspectMemory();
      clog("[dsh-memory] 记忆库体检：" + onboardStatusLine());
      if (mem0.status !== "ready") {
        clog("[dsh-memory] 记忆库尚未就绪：第一个顶层会话会自动给出初始化引导（也可随时输 /memory-init）");
      }
    } catch (e) {
      cwarn("[dsh-memory] 记忆库体检失败:", e && e.message ? e.message : String(e));
    }
    setTimeout(() => { checkForUpdate("启动"); }, 6000);
    try {
      ctx.interval(() => { checkForUpdate("定时"); }, 3600000);
    } catch (e) {
      cwarn("[dsh-memory] 升级检查定时器启动失败:", e && e.message ? e.message : String(e));
    }

    // v0.5.2（2026-09-03 审核后诊断补丁）：崩溃观察者——死前留痕。
    // 宿主 installFailLoud 先装（bin 装载期注册、常驻、先注册先执行）→ unhandledRejection 时宿主直接
    //   stderr+exit(1)，插件 handler 救不了进程，故本观察者**只同步落盘不拦截**（尽力在宿主退出前留一痕）；
    // uncaughtException 宿主全树零处理器 → Node 默认 stderr+exit(1)，本观察者先落盘再保持致命语义。
    // 同步 fs 写保证在进程退出前完成（web 宿主带 release，同事件后续监听器仍会执行）。
    const installCrashObservers = () => {
      let hRej = null, hExc = null;
      const crashAppend = (kind, err) => {
        try {
          fs.mkdirSync(MEMORY_ROOT, { recursive: true });
          const stack = (err && err.stack) ? String(err.stack) : (err ? String(err) : "(no detail)");
          const line = "\n===== " + kind + " " + new Date().toISOString() + " pid=" + process.pid + " =====\n" + stack + "\n";
          fs.appendFileSync(portable(CRASH_LOG_FILE), line, "utf8");
        } catch (e) { /* 落盘失败不能再抛（会二次触发） */ }
      };
      try {
        hRej = (reason) => { crashAppend("unhandledRejection", reason); };   // 只留痕；宿主 fail-loud 仍 exit(1)
        process.on("unhandledRejection", hRej);
      } catch (e) {}
      try {
        hExc = (err) => { crashAppend("uncaughtException", err); process.exit(1); };   // 保持致命语义（宿主无此处理器）
        process.on("uncaughtException", hExc);
      } catch (e) {}
      clog("[dsh-memory] 崩溃观察者已装（.crash.log 留痕，unhandledRejection 不拦/uncaughtException 落盘后退出）");
      return () => {
        try { if (hRej) process.off("unhandledRejection", hRej); } catch (e) {}
        try { if (hExc) process.off("uncaughtException", hExc); } catch (e) {}
      };
    };
    const uninstallCrashObservers = installCrashObservers();

    // v1.11.0：dispose 钩子 —— 不再置空 enabledAt！
    // DSH 退出/重启会触发 dispose，但「插件启停」已与「DSH 进程启停」解耦：
    // enabledAt 只由记忆活跃开关 active 驱动（settings watch 处理），DSH 退出不改变它。
    // dispose 只清理 /dream 命令注册，避免重复注册冲突。
    return () => {
      try { uninstallCrashObservers(); } catch (e) { /* 崩溃观察者卸载失败不影响 */ }
      try { if (dreamDisposer) dreamDisposer(); } catch (e) { /* 命令清理失败不影响 */ }
      try { if (onboardDisposer) onboardDisposer(); } catch (e) { /* 同上 */ }
      try { if (updateDisposer) updateDisposer(); } catch (e) { /* 同上 */ }
    };
  }
};
