// v2.8.4（2026-09-18「遥测与账本」修复批次 T1–T5，用户裁决「都搞，搞完发组验收」）：
//   动因（用户重启后读日志的实测）：新构建**确实加载了**（20:44:11 打出本版独有字符串），但日志里两行"看起来像证据"的东西
//   都在说谎 ——「就绪 v2.5.6」的版本号是**硬编码旧值**（代码里早已是 v2.8.4），且该行配置值是 **cordis base 默认层**
//   （5 / remind / integrate=关），而 settings.yaml 真值是 **2 / silent / true**；行为侧硬证据：20:44:13 的自动归档 tick
//   在账本里留下 `archiveAutoLast.why = "未发起：上次归档发起失败未满 15 分…"` —— 而 `archiveAutoLast` 的**唯一写入者**是
//   `archiveAutoNote`（调用点全部在 `runStaleSilentTick` 内），且该 why 的前缀「**未发起：**」只在**silent 闸之后**那一行
//   生成（此前已过"候选非空"与"指纹闸"，并真的调用了 `runStaleArchive`）⇒ 生效值 = silent（若为 not-silent，why 会写成
//   「非 silent 档或无 zstd」，与此不符）。
//   ★ 论证链更正（根因席 2026-09-18 复核）：我原先写的是"走到 `runStaleArchive` 内部的 15 分闸 ⇒ 必先过 silent 检查" ——
//     **顺序说反了**：15 分闸在 `runStaleArchive`（更靠前的行）里，silent 检查在调用方 `runStaleSilentTick`（更靠后的行），
//     而 `runStaleArchive` 有 ≥4 个调用方 ⇒ **非 silent 档同样能撞上那条 15 分闸**，单凭它推不出 silent。上面按"写入者 + 前缀
//     生成点"的链条才是唯一路径（且对"该键后来又被写过一次"免疫）。
//   即：横幅把"自动归档 + 自动消号 = 开着"报成了"只提醒"（方向最危险的那种错，用户据此会以为没有任何自动写入）。
//   ① T1 构建指纹：加载时自读本文件（fileURLToPath + sha256 前 8 位 + 字节数）打进就绪行 ⇒「哪份字节生效」可当场核验；
//      `PLUGIN_VERSION` 2.5.6→2.8.4，与 package.json / version.txt 三处对齐（旧注释自称"四处对齐"，实际长期未 bump）。
//   ② T2 生效配置行：`cfgEffectiveLine()` 在 settings 层真身就位处再报一行并标"以本行为准"；横幅标注"本行 = 默认层"。
//   ③ T3 跳过理由落盘：`summarizeArchiveWitness` 增 `skipReasons`（旧实现只记字数 ⇒「有内容却声明跳过」事后无法审计），
//      读者行（心跳 / 启动自检）显示前 2 条理由；旧账本无该字段时**如实说"未记"**，不伪造。
//   ④ T4 外部补账不被洗：`writeIntegrateState` 的磁盘并集补 `overLimitStuck` / `overLimitHint`（该键"未被 state 携带"时取磁盘值）
//      —— 实测 2026-09-18 16:46:24 一次性下沉脚本写入的账本在其后的插件写之后消失；若 B 的"连续 N 轮"计数被洗，
//      自动下沉就永远攒不够 2 轮 ⇒ 形同虚设。
//   ⑤ T5 白轮退避按**指纹作用域**：退避判定从"纯时间闸"改为"针对同一份候选集"（`untilFp`），且 whiteRun **也**记指纹
//      —— 修掉两处「注释与代码不符」：设计注释自称"整轮无消息流 ⇒ 候选集不变 ⇒ 不再重复起火"，但旧代码只在 `r.ok` 时记指纹；
//      并修掉实测危害：两个**每轮都判"整轮无消息流"的僵尸候选**（红队复核更正：它们**不是**"1 字节日志" —— 全库 `*.zstd`
//      最小 5322 B；我早先把 `sessions/<项目>/session-<id>` 这类**目录项**在 PowerShell 里的空长度误读成"1 字节文件"。
//      实况 = `session-574b8af7…` 目录下 `session.jsonl.zstd` 8263 B、水位 frames=3747（来自 v3 半段），属"劈开会话"残留）
//      每轮触发全局 24h 退避，把**新会话**的自动归档一起压住。
//      「不消号 / 宁重试不静默丢」（P0-1）语义不变 —— 新候选到达即放行，僵尸候选仍每轮重试。
//   验证：node --check 0；新增门 _test-t1t2-telemetry.mjs / _test-t3-skip-reason.mjs / _test-t4-ledger-keep.mjs /
//      _test-t5-white-scope.mjs；每门含 [鉴别] 条目且在旧字节上必须全红（`--baseline` 自断言）。
// v2.6.6（2026-09-16 归档并发真闸门 + 手动 dream 撞车兜底，用户拍板）：
//   ① 并发真闸门：ARCHIVE_MAX_CONCURRENT 2→5，语义从「发起协程数」修正为「**在跑子代理数**」。
//      旧实现只在发起循环里限制协程数，而 startOneBatch 秒级返回（不等在跑）→ 协程瞬间把全部批发起
//      （实测 2026-09-16 17:06:19：7 批在**同一秒**全部创建，"并发上限"形同虚设、token 一次性放大）。
//      新实现两段式不变：首批只发起 N 批（保住 r.ok 与节流戳立即落盘）→ 其余进等待队列 →
//      settle 内每完成一批补发起下一批（runner 链），在跑数恒 ≤ N；发起失败只记 startErrs、不卡队列。
//   ② 手动 /dream 撞车兜底：会话启动时的 silent 自动归档与手动 /dream 常同刻相撞，旧行为被防重入拒后
//      直接 spawnIntegrate → 归档与整合并行、「先归档后整合」静默失效（实证 17:06:17→19）。
//      新增 STALE_ACTIVE_DONE 句柄（发起成功即暴露、settle finally 复位）；撞车时等其结算 → 重扫剩余 → 补一轮。
//   ③ 等待放宽：新增 DREAM_ARCHIVE_WAIT_MS = 45 分钟（原两处硬编码 25 分钟）——并发闸生效后队列清空更慢。
//   验证：node --check 0；加载门 _gate-plugin-load.mjs 25/0（新增 7 条 v2.6.6 断言；对 v2.6.5 运行处副本 FAIL 7，
//     鉴别仪式成立）；回归门 _test-sessionlog-path 19 / _test-fmt-selftest 11 / _test-project-boot 23 /
//     _test-docstatus 8 / _test-pointer-closure 31 / smoke 30 / onboard 31 / patch-merge 11 全绿。
//     注：并发峰值需下轮 /dream 真机日志实证（「归档并发闸：首批 5/N 批」+ 子代理创建时间错开）。
//   未 bump（沿用 2.4.24 发布惯例）。
// v2.6.5（2026-09-16 会话日志改名致漏网检测静默失效根治 + 格式漂移自检 + 手动 dream 口径，用户拍板）：
//   事故：DSH 自 2026-09-10 20:10 起把会话日志改名 session.jsonl.zstd → session.v3.jsonl.zstd（zstd 多帧格式不变）。
//     插件 6 处读日志点硬编码旧名 → statSync 失败即 continue：漏网检测 / 水位帧数 / used 判定 / 归档提取 /
//     消耗统计对该类会话全链静默失效且零报错。实测 283 个 v3 会话从未进入候选、归档账本停在 09-10、
//     积压 63 个未落档会话（09-10~09-16，含 09-16 当天 19 个）——与 v2.6.3 的 agent/session-start→agent/created 事故同型。
//   ① 自适配：新增 `resolveSessionLogPaths(dir)`（v2.8.4/P21 起为**复数**：返回同目录**全部**日志，
//     按**时间顺序** `[legacy, v3]`），5 处调用点统一走它（findStaleSessions 扫描 / archivePendingEntry 水位 /
//     resolveInjectUsedOnce 的 used / 归档提取 / summarizeSubagentUsage 消耗统计）；归档提取遇空数组明确记「无流跳过」不白提一轮。
//     （v2.6.5 的单数版只返回**优先级最高的一个文件**，双名目录里整类看不见另一个 —— 见 P21 段注释。）
//   ② 自检（防再次静默）：扫描时顺带 probeUnknownLogNames 采集未识别的 *.jsonl.zstd 名 → 维护提醒 parts 注入
//     对话一次（按名去重，持久化 .integrate.json fmtNotified）——DSH 再改名时当场可见，不再 6 天后才发现。
//   ③ 手动 dream 口径（用户拍板）：手动 /dream 不吃 settings.staleSessionDays，改固定活跃下限
//     MANUAL_STALE_MIN_IDLE_MS = 30 分钟（诉求：阈值 1 天但会话 12 小时就结束时，手动触发就该收走它；
//     保留下限是为不把仍在写入的半截会话当完整会话归档）。自动定时整合与 stale_archive 工具仍按 settings；note 带口径。
//   验证：node --check 0；新增 _test-sessionlog-path.mjs（v3 优先 / legacy 回退 / 未知名 null+采集 / 提示去重账本 /
//     手动口径常量与调用点）；回归门 _gate-plugin-load.mjs / _test-project-boot.mjs / _test-docstatus.mjs /
//     _test-pointer-closure.mjs / test/*.mjs + patch-merge.tests.ps1 全绿。未 bump（沿用 2.4.24 发布惯例）。
// v2.6.4（2026-09-15 dream 悬空指针根治，用户拍板「按修正版实施」）：诊断见桌面《dsh-memory-dream悬空指针-根因诊断与约束方案.md》。
//   ① L1 写时闭合校验（applyPatches）：本批新增库内指针必须同批建目标或指向已存在文件，否则整批拒写（+ allowDangling 逃生 + 描述性豁免）；
//   ② L3 settle 反向核对（scanDanglingPointers）：本轮写入的悬空指针进 health（阻塞），存量只进 progress.dangling 非阻塞提示；
//   ③ L0 任务书去矛盾：删掉「先写指针行续期」诱导，补「放弃不得留悬空指针」；
//   ④ 顺带修既有缺陷：health 转播此前因 DREAM_LISTENER 提前置 null 而从未送达 → 改用 settleListener 落 notice。
//   共用判据（MEM_PTR_RE / memPointerHits / scanDanglingPointers）在模块层，正则对现库 120 个 md 实测选型。
//   测试 _test-pointer-closure.mjs 31 断言（含真 settle 驱动 J/K）+ 既有门全绿；未 bump（沿用 2.4.24 发布惯例）。
// v2.6.2（2026-09-14 工作空间自动建档，用户拍板）：顶层会话 cwd 未命中任何项目记忆 → 自动补建——
//   ① projects/<目录名>.md 缺失写最小骨架（标题+五标准节，dream/归档/「## 归档」锚点直接兼容）；
//   ② _index.json 登记 cwd/root（同名条目已存在只补登记不覆盖文件；改名条目 file≠目录名时登记进原条目防双条目打架）；
//   ③ 种 ~dsh/project.json 标记 → 下轮起 matchProjectByCwd 正常命中注入；本轮摘要分格/项目切片即刻按新项目生效。
//   护栏：isDeepEnoughRoot（≥4 段）+ ONE_DRIVE_CONFLICT_RE + `_` 前缀目录名跳过；已命中或标记已存在不动作；
//   注入一行建档提示（用户选「注入提示条」）。子代理跳过（TOPSESSION 闸）。
//   挂点在 injectMode 三档分支**之前**（首部署 2026-09-15 实证缺陷：old 位置在 full 分支内，续会话 notice/silent 档永不建档，
//   已移正 + 先建档再算 hP 防快照下发假「项目有更新」）；测试 _test-project-boot.mjs 23 断言（S7 覆盖该缺陷回归点）。
//   未 bump（沿用 2.4.24 发布惯例，发布动作留给用户）。
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
//  - compact 是上下文重置点，但记忆注入仍是会话开始快照（会话开始事件一次性注入，compact 不重发）。
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
// v2.8.4（T1）：构建指纹要自读本文件 ⇒ 必须用 `fileURLToPath` 把 `import.meta.url` 转成本地路径。
//   本机插件路径含 CJK（`E:\工具\插件开发调整\…`），`new URL(import.meta.url).pathname` 是**百分号编码**的
//   ⇒ readFileSync 直接 ERR_MODULE_NOT_FOUND（同类坑本会话已实测一次）。
import { fileURLToPath } from "node:url";
// v1.2.0：node:fs 直写压缩检查点（宿主插件真实 Node 环境，绕过 ctx.fs 沙箱，无需审批）
import fs from "node:fs";
// v2.3.4：内容 hash 账本（dream 整合候选判定）——sha256 比对替代 mtime/全量轮
import { createHash } from "node:crypto";
// v1.8.0：node:zlib 原生 zstd 解压（Node 22.17+/23.3+）——漏网归档改为「提取会话 compaction 摘要」，子代理不读原始大日志
import zlib from "node:zlib";
// v2.8.4（P26）：会话原文检索工具要**复用** `~/.dsh/tools/session-search/session-search.mjs` 这一份实现
//   （不复制逻辑）⇒ 以子进程方式调用它。
// v3.1.0（索引自动刷新）：自动路径**必须**用异步 `execFile` —— `execFileSync` 会同步冻结整个宿主
//   event loop（Web GUI / 其他会话 / 定时器一起停）；本机实测全库增量 3~9s、冷建最坏 115.2s，
//   哪怕 3s 也不该压在宿主上。既有工具路径继续用 execFileSync（超时/语义逐字不变）。
import { execFileSync, execFile } from "node:child_process";
// v3.1.1：/memory-panel 探活用——拉起浏览器前先 HTTP GET 面板路由，避免"浏览器打开了但页面 404/连不上"的假成功。
import http from "node:http";
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

// ═══ §9.12④（用户「都搞」）：**有界重试读取器**（模块级 ⇒ 门可直测重试策略本身，不必造真子代理）═══
//   `readFn` 返回 null/假值 或 `isDone(v)===false` 时按 `gapMs` 间隔重试，至多 `attempts` 次；
//   返回 `{ value, tries }`（`tries` 是真实尝试次数 ⇒ 调用方把它记进账本，供"到底读了几次"事后核对）。
async function retryReadUsage(readFn, opts) {
  const o = opts || {};
  const attempts = Math.max(1, Number(o.attempts) || 4);
  const gapMs = Math.max(0, Number(o.gapMs) || 0);
  const isDone = typeof o.isDone === "function" ? o.isDone : ((v) => !!(v && ((v.totalIn || 0) > 0 || (v.output || 0) > 0 || (v.reasoning || 0) > 0)));
  const sleep = typeof o.sleep === "function" ? o.sleep : ((ms) => new Promise((r) => setTimeout(r, ms)));
  let value = null, tries = 0;
  for (let i = 0; i < attempts; i++) {
    tries = i + 1;
    try { value = await readFn(tries); } catch (e) { value = null; }
    if (isDone(value)) break;
    if (i < attempts - 1) await sleep(gapMs);
  }
  return { value: value, tries: tries, ok: isDone(value) };   // ★ B2：把"最终值是否合格"的结论带出去（旧实现只用于 break，调用方只能靠 !value 区分）
}
export { retryReadUsage };

// ═══ §9.12③（用户「都搞」）：**`literals[]` 独立通道** ═══
// 为什么：用户诉求的核心是"精确字面量能查到来源"（GUID/URL/路径/文号/命令/参数），而实测**GUID 召回最差**（5.5%）——
//   因为要点（`points`）是**概括句**，字面量在概括里会被自然丢掉。通道设计（三条约束，评审时先看）：
//   ① **非注入层**：写到 `knowledge/字面量.md`（**首版我落在记忆库根目录** —— 评审指出根目录**不在 `memory_search` 的候选扫描面**里，
//      "天然可检索"那句话当时是错的；改到 `knowledge/` 后由目录扫描自动进候选集）。它**不进** global/index/摘要那三层 ⇒ 不占注入预算（用户口径：现有 md 文档基本不动）；
//   ② **幂等**：按"字面量 + 会话"去重追加，同一轮/跨轮重复提交不会写两遍；
//   ③ **可检索**：它是 `knowledge/` 下的 `.md` ⇒ `memory_search` 的目录扫描覆盖它（不需要新工具、也**不靠**加白名单特例）。
// §9.12③ 的字面量通道实现在下方（`LITERALS_FILE` 依赖 `MEMORY_ROOT`，必须放在它之后 —— 模块级 TDZ 会当场炸）
function sanitizeLiterals(arr) {
  const out = [];
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    const s = String(raw === null || raw === undefined ? "" : raw).replace(/[\r\n]+/g, " ").trim();
    if (!s) continue;
    if (s.length > LITERALS_MAX_CHARS) continue;              // 过长 ⇒ 静默丢（不是字面量，多半是被塞了一整段正文）
    if (s.indexOf("|") >= 0) continue;                        // 结构字符（表格/管道）会破坏 md 行结构
    // 评审整改（红队 R-4）：① ` ← ` 是**来源段的分隔符** ⇒ 字面量里出现它就能**伪造一条来源**（`X ← fake（2026-01-01）`）；
    //   ② ` 反引号/尖括号 ` 会在 md 里改变渲染（代码段/HTML）。
    if (s.indexOf("←") >= 0) continue;
    if (/[`<>]/.test(s)) continue;
    if (out.indexOf(s) >= 0) continue;                        // 同一块里去重
    out.push(s);
    if (out.length >= LITERALS_MAX_PER_SESSION) break;
  }
  return out;
}
function writeLiteralsIdempotent(root, entries, opts) {
  const o = opts || {};
  const fsz = o.fs || fs;
  const file = portable(String(root || MEMORY_ROOT)) + "/knowledge/字面量.md";
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { ok: true, wrote: 0, existed: 0 };
  let old = ""; try { old = fsz.readFileSync(file, "utf8"); } catch (e) { old = ""; }
  const lines = [];
  for (const e of list) {
    const lit = sanitizeLiterals([e && e.literal])[0];
    if (!lit) continue;
    const sid = unitSid(e && e.sid);
    const day = String((e && e.date) || "").slice(0, 10);
    if (old.indexOf("← " + sid + "（") >= 0 && old.indexOf("- " + lit + " ← " + sid) >= 0) continue;   // 幂等：同字面量+同会话已存在
    lines.push("- " + lit + " ← " + sid + (day ? "（" + day + "）" : ""));
  }
  if (!lines.length) return { ok: true, wrote: 0, existed: list.length };
  const header = old ? "" : "# 精确字面量索引（dsh-memory §9.12③）\n\n"
    + "> 一行一条：`- <字面量> ← <会话短id>（日期）`。**不进注入层**（不占前缀缓存），供 `memory_search` 检索精确串。\n\n";
  const next = (old ? old.replace(/\s+$/, "") + "\n" : header) + lines.join("\n") + "\n";
  try {
    fsz.mkdirSync(portable(String(root || MEMORY_ROOT)) + "/knowledge", { recursive: true });
    // ★ 评审整改（工程席 / 红队）：原来是裸 `writeFileSync` —— 而 `literals.md` 是这些字面量的**唯一副本**
    //   （见证里只留 points，不留字面量）⇒ 崩在中途即截断且无处重建。改用仓内既有的 tmp+rename 原子写。
    writeFileAtomic(file, next, { tag: "literals" });
    // ★★ §9.11.4-13：**全局上限 / 轮转**（在写盘之后做，且**失败不影响已落盘的写入**）。
    //   顺序刻意如此：**先保证"新字面量已落盘"**，再做轮转 —— 轮转只是"搬家"，
    //   绝不能因为它出错而丢掉刚刚写进去的内容（本批反复的纪律：宁可少做一步，不可丢数据）。
    let rotated = null;
    try { rotated = rotateLiteralsIfNeeded(fsz, portable(String(root || MEMORY_ROOT))); } catch (e) { rotated = null; }
    return { ok: true, wrote: lines.length, existed: list.length - lines.length, rotated: rotated };
  } catch (e) { return { ok: false, why: "write-failed:" + (e && e.message), wrote: 0, existed: 0 }; }
}
// ★★ §9.11.4-13：字面量**分片轮转**（纯函数式判定 + 文件级搬迁；**不删任何条目**）。
//   触发：`knowledge/字面量.md` 的条目数 ≥ `LITERALS_ROTATE_AT`。
//   动作：把**整个当前分片**改名为 `知识库/字面量-<YYYYMMDD-HHmmss>.md`，并让主文件从空开始。
//   安全性要点（逐条）：
//     ① **用重命名而非"复制+清空"** ⇒ 不存在"复制成功、清空失败 ⇒ 两份都缺"的中间态（原子性来自 fs.rename）。
//     ② 目标名带时间戳 + **存在即不覆盖**（`while (exists) n++`）⇒ 绝不覆盖既有分片。
//     ③ 归档分片**留在 `knowledge/`** ⇒ 目录扫描自动把它收进 `memory_search` 候选（**仍可检索**，见常量处注释）。
//     ④ **不删任何条目**（`LITERALS_ARCHIVE_KEEP = 0`）：这些字面量是唯一副本（见证只留 points）。
//     ⑤ 轮转失败 ⇒ 返回 null 并**保持原样**（调用方已把新内容写进主文件 ⇒ 最坏是"这次没搬"）。
function rotateLiteralsIfNeeded(fsz, rootAbs) {
  const dir = rootAbs + "/knowledge";
  const main = dir + "/字面量.md";
  let cur = "";
  try { cur = fsz.readFileSync(main, "utf8"); } catch (e) { return null; }
  const n = (cur.match(/^- /gm) || []).length;
  if (n < LITERALS_ROTATE_AT) return null;
  // 目标分片名（时间戳；冲突则加序号 —— 绝不覆盖）
  const d = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  let arc = dir + "/字面量-" + stamp + ".md", k = 0;
  while (fsz.existsSync(arc)) { k++; arc = dir + "/字面量-" + stamp + "-" + k + ".md"; }
  try {
    fsz.renameSync(main, arc);                    // ① 原子搬迁（原文件消失了 = 已归档）
  } catch (e) { return null; }                    // ⑤ 失败 ⇒ 原样保留
  // ② 主文件重建为新分片（带头部说明），**不写任何旧条目**（它们已在归档分片里）
  const head = "# 精确字面量索引（dsh-memory §9.12③）\n\n"
    + "> 一行一条：`- <字面量> ← <会话短id>（日期）`。**不进注入层**（不占前缀缓存），供 `memory_search` 检索精确串。\n"
    + "> 本文件是**当前分片**；旧分片见同目录 `字面量-<时间戳>.md`（同样可被 `memory_search` 检索）。\n\n";
  try { writeFileAtomic(main, head, { tag: "literals-rotate" }); } catch (e) { return { arc: arc.split("/").pop(), entries: n, recreated: false }; }
  return { arc: arc.split("/").pop(), entries: n, recreated: true };
}
export { sanitizeLiterals, writeLiteralsIdempotent, rotateLiteralsIfNeeded, LITERALS_FILE };

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
  const rootFiles = Array.isArray(o.rootFiles) ? o.rootFiles : ROOT_FILES;   // v2.6.8：默认根文件走单源常量（v2.7.0 起不再含耐久层）
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
// ★ §9.12③：`LITERALS_FILE` 必须定义在这里（`MEMORY_ROOT` 之后）—— 放在文件更靠前的位置会命中模块级 TDZ，加载即炸。
// ★ §9.12③（评审整改 · 提案人席）：字面量落点从**记忆库根目录**改到 **`knowledge/字面量.md`**。三条理由：
//   ① `loadKnowledgeTargets()` 对 `knowledge/` 是**目录扫描**（`listMdNames("knowledge")`）⇒ 新文件**自动**进
//      `memory_search` 候选集，不需要再往白名单里加特例；而根目录文件必须**逐个显式登记**（L7565 那个
//      `fixed.md` 就是先例：v2.7.0 从候选集里删掉后，它既不被注入、也搜不到 ⇒ 静默失效）。
//   ② 目录扫描顺带给 label（搜索结果里可读）；③ 将来要按月/按主题轮转，新文件同样自动入候选集。
//   ★ 另：**不要**给它加 `MEMORY-` 前缀 —— `knowledge/MEMORY-<x>-<y>.md` 会被"提取一致性"健康检查
//     按 `projects/<x>.md` 反查指针，从而误报「无指针」。
const LITERALS_FILE = MEMORY_ROOT + "/knowledge/字面量.md";
const LITERALS_MAX_PER_SESSION = 20, LITERALS_MAX_CHARS = 200;
// ★★ §9.11.4-13（**队列末项：字面量通道的全局上限 / 轮转**）。
//   【为什么需要】该文件**只增不减**（幂等追加，无删除路径）：现场实测 281 条 / 19327 B，
//     按当前增速约数月后到 MB 级 ⇒ `memory_search` 每次要读它、注入候选也变重，而**旧条目价值随时间衰减**。
//   【为什么按"会话数"而不是"字节数"轮转】口径要**可预测、可测试**：字节数受字面量长度影响（1~200 字不等），
//     同一条数在不同数据下触发时机差异大；而"每个会话贡献 ≤ 20 条"是既有硬约束 ⇒ 按条目数最稳。
//   【轮转去向 —— 这是关键设计点】**必须留在 `knowledge/` 里**（不是删、不是移出扫描面）：
//     该目录是**目录扫描**进候选集（`listMdNames("knowledge")`）⇒ 轮转出的文件**自动仍可检索**
//     （同 L450 早已写下的设计："将来要按月/按主题轮转，新文件同样自动入候选集"）。
//     ⇒ 轮转 = **分片**，不是丢弃：老字面量照样能被 `memory_search` 搜到，只是不再占"当前分片"。
//   【不引入 `MEMORY-` 前缀】同 L451 的理由：`knowledge/MEMORY-<x>-<y>.md` 会被"提取一致性"健康检查
//     按 `projects/<x>.md` 反查指针 ⇒ 误报「无指针」。
const LITERALS_ROTATE_AT = 500;            // 当前分片超过这个条目数 ⇒ 轮转（现场 281，留约 1 倍余量）
const LITERALS_ARCHIVE_KEEP = 0;           // 归档分片不清理（**它们是唯一副本**；要清理须人工判定）
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
// v3.0.0（2026-09-20 用户拍板「定版收尾，定为 3.0」）：本批（§9.11.4 系列）整改后**定版**。
//   为什么是 3.0 而不是 2.9：本批改的是**语义与契约**（错误可见性、水位/候选口径、账本保护、单元写失败可归因），
//   不是叠加特性；且事后证明最关键的修复（`archivePendingEntry`）**覆盖面比设计时以为的更宽**。
//   历史：v2.8.4（T1）时版本号曾停在 2.5.6，导致"重启后无法据版本判断加载了哪份字节" ⇒ 三处版本落点必须同步。
const PLUGIN_VERSION = "3.2.0";
// v2.8.4（T1·**构建指纹**）：版本号是人写的常量，**不能**回答用户重启后最关心的那个问题——"这次重启到底加载了哪份字节？"
//   事故背景（2026-09-18）：同步了新构建、重启后横幅仍打 `就绪 v2.5.6`，用户据此无法确认加载是否成功。
//   ⇒ 加载时自读本文件，把 **字节数 + sha256 前 8 位** 打进就绪行；与磁盘副本一比即知新旧（只读自身，零副作用）。
const SELF_FP = (() => {
  try {
    const self = fs.readFileSync(fileURLToPath(import.meta.url));
    return self.length + "B/" + createHash("sha256").update(self).digest("hex").slice(0, 8).toUpperCase();
  } catch (e) { return "?(自读失败)"; }
  // v2.8.4（T1·评审整改 工程席④/红队 R-6）：不要只写 "?"（用户会读成占位符/加载失败）。
  //   注意此处**不能** clog/cwarn —— SELF_FP 在模块加载期求值，而 clog/cwarn 是更靠后的模块级 const ⇒ TDZ 会让它变成加载期 ReferenceError。
  //   另注：指纹只回答"**被 import 的是哪份字节**"，**不等于**"三 profile 一致"（历史结论：三者经 junction 指向同一目录）。
})();
// ═══════════ v2.8.4（评审整改 · 根因席 A/B）：**单元 sid 宽度的唯一所有者** ═══════════
// 为什么必须有它：R-5 的根因就是"宽度**没有所有者**、各处各写自己那一份" —— CLI 侧 4 处（12/8/8/8）、
//   插件写方 6+ 处（12）、读方 2 处（8）⇒ 于是"检索那处漏改归一"这种事**必然**会发生（红队实测：12 位短 id 全 0 命中）。
// ⇒ 现在：**产物由谁创建，宽度就由谁持有**。单元文件名与全部 sid 派生键都走下面这两个函数；
//   CLI 侧的 `normSidLong`（12）是**镜像值** ⇒ 由 `_gate-freeze-sync.mjs` 的 GR23 断言两边相等（不再靠注释自律）。
//   ★ 附带禁令（同一道门会查）：index.js 里**不得**再出现裸的 `slice(0, 12)` 作用于 sid（只许数组/无关字符串，见门里的允许清单）。
const UNIT_SID_LEN = 12;
const unitSid = (id) => String(id || "").replace(/^session-/, "").slice(0, UNIT_SID_LEN);
// 仅用于**打印**：日志行显示 `session-xxxxxxxx` 那种带前缀短形（与 unitSid 的键口径不同，故单独一个函数、单独的名字）
const sidLabel = (id) => String(id || "").slice(0, UNIT_SID_LEN);
// v2.8.4（T4·**外部补账并账**）：`~/.dsh/memory/.integrate.json` 是**多写者**文件 —— 插件进程写它，外部工具也写它
//   （如一次性下沉脚本 `_apply-sink-stuck.mjs` 记 `overLimitStuck`）。插件的内存态可能是在外部写**之前**读的
//   ⇒ 整对象写回就会把外部刚写的键抹掉。既有 v2.0.9(M1) 已为 `archivedSessions`/`archiveWatermarks`/`staleNotified`
//   建了同样的并集保障；本函数把**同类保障**抽成**可门直测的纯函数**（不抽出来就只能靠源码正则，那是假绿温床）。
//   语义 = **「state 是否携带该键」**：携带（含空对象 = 有意清空）以 state 为准；未携带则取磁盘值。
//   ★ 诚实标注（重要）：2026-09-18 16:46:24 那 3 条 `overLimitStuck` 记录**不是**被插件写洗掉的 —— 真因是那个一次性
//     脚本自身（计划调用漏了 `dryRun: true` ⇒ **首调即真写**；第二个调用因文件已达标返回 `not-over` ⇒ `results` 为空
//     ⇒ 记账分支被整个跳过，账本**从未写入**）。本函数防的是**这一类多写者覆盖**（外部工具写入不再被插件写回洗掉），
//     **不是**那次事故的根因修复；根因修复是那个脚本（同批已改）。
const LEDGER_EXTERNAL_KEYS = ["overLimitStuck", "overLimitHint"];
// ★★ 工程席 rev8k A1 整改：`WM_SKIP_MAX_ROUNDS` 原先只是**函数内局部**（L7274），
//   而判定它的三处（`shouldReArchive` / `hasWmSkipCand` / 健康行计数）**跨函数**引用不了它 ⇒ 各自写**裸 `3`**
//   ⇒ 常量"名存实亡"（这与我本批反对的"字段表两处各写一遍"是同一类缺陷）。现**上提为模块级单点所有者**。
const WM_SKIP_MAX_ROUNDS = 3;
// ★★ §9.11.4-8：单元缓存**淘汰顺序决策**（纯函数，模块级 ⇒ 门可直调、断言由产品字节决定）。
//   规则（**现场取证驱动**：186 个单元里 51 个是"唯一副本"、合计 345673 字，且恰好最旧）：
//     ① **优先淘汰"已落库"的**（`onlyCopy !== true`：正文在记忆库还有一份，删了仍搜得到），组内按 `at` 升序（旧先删）；
//     ② **唯一副本**（正文只此一份）排在最后，**只在超出硬上限 `hard`** 时才动它们；
//     ③ 读不出来的单元视同"唯一副本"（**不得当成可删** —— 它可能正是唯一副本、只是文件损坏）。
//   返回 `{ evict: [meta…], fromOnlyCount }`。
function evictUnitCachePlan(metas, keep, hard) {
  const list = Array.isArray(metas) ? metas : [];
  const need = list.length - (Number(keep) || 0);
  if (!(need > 0)) return { evict: [], fromOnlyCount: 0 };
  const evictable = list.filter((m) => m && m.onlyCopy !== true).sort((a, b) => (a.at || 0) - (b.at || 0));
  const onlyCopies = list.filter((m) => m && m.onlyCopy === true).sort((a, b) => (a.at || 0) - (b.at || 0));
  const pick = evictable.slice(0, need);
  let fromOnly = [];
  if (pick.length < need && list.length > (Number(hard) || 0)) {
    fromOnly = onlyCopies.slice(0, Math.min(need - pick.length, list.length - (Number(hard) || 0)));
  }
  const evict = pick.concat(fromOnly);
  return { evict: evict, fromOnlyCount: fromOnly.length };
}
export { evictUnitCachePlan };
// ★★ §9.11.4-3 修正十（**工程席 rev8f B**：`archiveWatermarks` 的字段表在**加载端**与**保存端**各写一遍
//   —— 本批正是在这两处同时加 `empty`/`skipped` 才暴露该耦合，漏改一处就会静默丢字段）：
//   把字段表收成**单点所有者**。两处语义差异（加载端要容错归一化 / 保存端要落盘投影）用 `mode` 参数表达，
//   避免"抽了函数反而改变行为"。
//   `mode="load"`  ：`frames` 非数字 ⇒ null；`round`/`at` 补默认；`byFile`/`witness` 非对象 ⇒ null；布尔取 `=== true`
//   ★ 修法要点（**我实测踩到的坑，症状=「消号了但水位不存在」**）：内存里的 watermark 对象**不含 `id`**
//   （存法是 `ARCHIVE_WATERMARK.set(sid, {…})`），所以 `save` 分支**不能**从 `src.id` 取 id ——
//   那会落盘成 `id: undefined`，加载端 `if (w && w.id)` 直接丢弃 ⇒ 表现为 T8a/T8b/T8j 全红。
//   ⇒ `save` 分支的 `id` 由**调用方**传入（`idForSave`）。
function normalizeWatermark(w, mode, idForSave) {
  const src = (w && typeof w === "object") ? w : {};
  const b = (v) => v === true;                                  // 布尔一律"严格是 true 才算"，与旧写法逐字一致
  const obj = (v) => (v && typeof v === "object") ? v : null;
  if (mode === "save") {
    return { id: idForSave, frames: src.frames, round: src.round, at: src.at, incomplete: b(src.incomplete),
      byFile: src.byFile || null, witness: src.witness || null, empty: b(src.empty), skipped: b(src.skipped),
      wmSkip: b(src.wmSkip), wmSkipRounds: Number(src.wmSkipRounds) || 0, wmSkippedFiles: Number(src.wmSkippedFiles) || 0,
      wmSkippedFrames: Number(src.wmSkippedFrames) || 0, wmSkipAt: Number(src.wmSkipAt) || 0 };
  }
  return { frames: typeof src.frames === "number" ? src.frames : null, round: src.round || 1, at: src.at || 0,
    incomplete: b(src.incomplete), byFile: obj(src.byFile), witness: obj(src.witness), empty: b(src.empty), skipped: b(src.skipped),
    wmSkip: b(src.wmSkip), wmSkipRounds: Number(src.wmSkipRounds) || 0, wmSkippedFiles: Number(src.wmSkippedFiles) || 0,
    wmSkippedFrames: Number(src.wmSkippedFrames) || 0, wmSkipAt: Number(src.wmSkipAt) || 0 };
}
export { normalizeWatermark };
// ★★ §9.11.4-7 修正二（**红队 rev8c B① 实测抓出的门力缺口**）：把"记/清超限提示"这条**写侧**语义抽成**纯函数**。
//   动因：墓碑替代 `delete` 之后，写侧唯一的看门人是一条**源码正则** ⇒ 对"语义等价改写"完全假绿
//   （红队实测：把调用改成 `if (false) hintObj[rel] = {…cleared:true}` —— 字面量还在、墓碑永不写 ⇒
//    sink 门 25/25 全绿、T4 门 21/0 全绿、矩阵变体也"正常判红"）。抽成纯函数后，门可以**按输出**断言：
//   "该文件本轮已写好 ⇒ 必须得到 `{cleared:true}`" —— 无论写侧怎么改写，只要语义不对就红。
//   参数：`hint` = 现有提示表；`rel` = 文件相对路径；`entry` = `null` 表示"清掉提示"，否则为活条目对象。
function applyOverLimitHintEntry(hint, rel, entry) {
  const out = Object.assign({}, hint || {});
  if (entry === null) {
    // ✓ 墓碑（**不是** `delete`）：`writeIntegrateState` 的逐路径并账无法区分"state 从不知道"与"state 有意删除"
    //   ⇒ `delete` 会被磁盘上那条尚未删除的旧条目**复活**（陈旧差数/分节表永久留在 dream prompt 里）。
    //   墓碑带 `at` ⇒ 时间戳规则让 state 胜出；读者按 `cleared` 跳过（`renderOverLimitHint` 首行过滤）。
    out[rel] = { at: Date.now(), cleared: true };
  } else {
    out[rel] = entry;   // 文件仍超限 ⇒ 记下新的差数/分节表（新 `at` 会自然压过旧值/旧墓碑）
  }
  return out;
}
export { applyOverLimitHintEntry };
// ★★ B5：活动预算的**唯一判据**（纯函数 ⇒ 门可直测，不必造真子代理/真定时器）
//   返回 "none"（未达标）| "remind"（首触：提醒，不杀）| "grace"（再攒满一个预算窗 ⇒ 进 3 分钟宽限）
function guardBudgetVerdict(actN, budget, extra) {
  const n = Number(actN) || 0, b = Number(budget) || 0, e = Number(extra) || 0;
  if (b <= 0 || n < b) return "none";
  return n < b + e ? "remind" : "grace";
}
export { guardBudgetVerdict };
// v2.8.4（评审整改 · 回归门席）：**可观测调用计数** —— 唯一用途是让"接线"能被**行为**验证，而不是只能靠源码 grep。
//   门里那条 grep 断言在变异 `merge-not-wired` 下确实会红，但"抽了函数忘了接线"这类缺陷本该由行为兜住；
//   计数在模块级（每次进程 +0 起），门跑一次真 tick 后断言 ≥1 即为行为证据。
let MERGE_LEDGER_CALLS = 0;
function ledgerMergeCallCount() { return MERGE_LEDGER_CALLS; }
function mergeLedgerExternalKeys(state, disk) {
  MERGE_LEDGER_CALLS++;
  if (!state || typeof state !== "object" || !disk || typeof disk !== "object") return state;
  // ═══ §9.11.4-7（用户 2026-09-19 拍板「按你推荐的来」）：**携带旧值的 state 不得覆盖外部较新的值** ═══
  // 旧实现只做一件事：`if (!(kEx in state)) state[kEx] = disk[kEx]` —— 只防"**键被整体抹掉**"，
  //   防不住"state 带着**旧条目**把外部刚写进去的新条目压回去"（工程席①指出的过度声明）。
  // 两个外部键的**数据形状都是「路径 → 条目」的对象**（实证：`overLimitStuck[path] = {rounds,lastAction}`、
  //   `overLimitHint[path] = {chars,…}`）⇒ 逐条按时间戳（`lastAt`/`at`/`ts`）取较新者：
  //   · state 缺该条 ⇒ 收下外部的；
  //   · 时间戳可比 ⇒ 较新者胜（**外部更新时以外部为准** —— 这正是要修的方向）；
  //   · 时间戳不可比（两边都没有/等同且为 0）⇒ **保留 state**（= 旧行为，绝不因此把插件自己刚写的内容弄丢；
  //     而插件此后写这两类条目时会带 `lastAt`，使后续比较都可比）。
  const stampOf = (x) => Number((x && (x.lastAt !== undefined ? x.lastAt : (x.at !== undefined ? x.at : x.ts))) || 0);
  const isPathMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  for (const kEx of LEDGER_EXTERNAL_KEYS) {
    const dv = disk[kEx];
    if (dv === undefined) continue;
    if (!(kEx in state)) { state[kEx] = dv; continue; }
    const sv = state[kEx];
    if (isPathMap(sv) && isPathMap(dv)) {
      const merged = Object.assign({}, sv);
      for (const p of Object.keys(dv)) {
        if (!(p in sv)) { merged[p] = dv[p]; continue; }
        const se = sv[p], de = dv[p];
        const ts = stampOf(se), td = stampOf(de);
        if (ts && td && td > ts) merged[p] = de;          // 外部条目更新 ⇒ 采纳外部
      }
      state[kEx] = merged;
    }
  }
  return state;
}
export { mergeLedgerExternalKeys, ledgerMergeCallCount };
// 历史（v2.5.6 口径，保留备查）：面板会话层口径修复——旧按 mtime 取「最近 3 份」时，轮转清空原文件会刷新 mtime，
//   0 字节的已轮转文件（实证 sessions/2026-08-14.md）挤占名额把真日文件顶掉，叠加当日文件尚未生成，
//   表现为「日记忆文件只剩这两天」；改为排除空文件 + 按文件名日期倒序 + 会话层总量提示（共 N 个日文件 / 已轮转为空数）。
// 远端发布基址（安装/升级命令同源）；DSH_MEMORY_RAW 可指向内网镜像
const RAW_BASE_DEFAULT = "https://raw.githubusercontent.com/Starry0214/dsh-memory/main";

// ═══════════ v2.6.4：记忆库指针「指向 → 目标存在」判据（L1 写时闭合校验 / L3 settle 反向核对 / 体检 三处共用）═══════════
// 背景（2026-09-15 悬空指针事故，诊断见桌面《dsh-memory-dream悬空指针-根因诊断与约束方案.md》）：
//   dream 在主文件写了 `See knowledge/…` 指针，但目标分册从未落盘——校验方向只有「内容→指针」，缺「指针→目标」。
// 写法覆盖（对现库 120 个 md 全量回归选型，选型证据见 _test-pointer-closure.mjs 的 G 场景）：
//   `- See knowledge/…`、`详见 knowledge/…`、`详见：knowledge/…`、`→ knowledge/…`、
//   `→ 分册 knowledge/…`（关键词与路径间夹中文词——旧「关键词紧跟路径」写法必漏，实证 sessions/2026-09-15.md L24）。
//   [^\n]{0,10}? 桥接上限 10 字符且不跨行；目标限记忆库四类前缀 → 天然豁免库外路径（~/.dsh/skills/…、08_工具资源\…）。
// 两个 g 正则**只用 matchAll**（matchAll 不消费 lastIndex；日后若写 MEM_PTR_RE.test() 会因 g 的 lastIndex 状态随机失灵）。
// 路径字符类排除 < 《 * | { 等占位符字符 → 命名约定示例（knowledge/MEMORY-<项目>-<topic>.md、tools/*.md）不误判为指针。
const MEM_PTR_RE = /(?:See|see|参见|详见|参考|见|→)[^\n]{0,10}?((?:knowledge|projects|tools|sessions)\/[^\s)）(（,，;；、"'`<>《》*|{}]+?\.md)/g;
// 描述性提及豁免：事故记录/待办标注会**逐字复述**一个未落盘文件名（如「…分册 knowledge/X.md 未落盘」）——
// 那是有意为之的诚实标注，不是指针意图；若不豁免，此类条目会永久挂在 health 上（现库实测 2 处，永远修不掉）。
const MEM_PTR_DESC_RE = /未落盘|未成功|待补|尚未|未建立|未生成|暂缺|不存在|缺失|已移入|已轮转|已归档|已删除/;
function memPointerTargetExists(rel) {
  try { return fs.existsSync(portable(MEMORY_ROOT + "/" + rel)); } catch (e) { return false; }
}
// 已轮转判定：sessions/<日>.md 缺失但 sessions/archive/<同名> 在 → 内容没丢只是搬家（v2.5.6 轮转策略），不算悬空
function memPointerArchived(rel) {
  const m = /^sessions\/([^/]+\.md)$/.exec(rel);
  if (!m) return false;
  try { return fs.existsSync(portable(MEMORY_ROOT + "/sessions/archive/" + m[1])); } catch (e) { return false; }
}
// 文本 → 指针命中清单 [{rel, desc}]；desc = 命中所在行含描述性豁免词（视为复述/标注，不作指针判据）
function memPointerHits(text) {
  const out = [];
  const s = String(text || "");
  if (!s) return out;
  for (const m of s.matchAll(MEM_PTR_RE)) {
    const ls = s.lastIndexOf("\n", m.index) + 1;
    let le = s.indexOf("\n", m.index); if (le < 0) le = s.length;
    out.push({ rel: m[1], desc: MEM_PTR_DESC_RE.test(s.slice(ls, le)) });
  }
  return out;
}
// 全库只读扫描 → 悬空指针 [{src, rel}]（排除：描述性豁免、目标存在、sessions 已轮转进 archive）
function scanDanglingPointers() {
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".md")) continue;
      let t = "";
      try { t = fs.readFileSync(p, "utf8"); } catch (e2) { continue; }
      const src = p.slice(MEMORY_ROOT.length + 1);
      for (const h of memPointerHits(t)) {
        if (h.desc) continue;
        if (memPointerTargetExists(h.rel)) continue;
        if (memPointerArchived(h.rel)) continue;
        const key = src + "|" + h.rel;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ src: src, rel: h.rel });
      }
    }
  };
  walk(MEMORY_ROOT);
  return out;
}

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
    const line = onboardStatusLine();
    if (line === ONBOARD_LAST_SUMMARY_LINE) return;
    ONBOARD_LAST_SUMMARY_LINE = line;
    LIVE_STATS.onboardSummary = line;   // [2026-09-23] scope 通道退役，随 stats.json 下发
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
    source: { kind: "plugin:dsh-memory" }
  };
}

// v2.5.1(转播可见性): 可立即落会话流的 notice 消息——source.form="notice" + summary 让 GUI 渲染成
// 「上下文行」（折叠态直接显示 summary 一行），无需唤醒驱动即可见（对照宿主 dsh-tool-jobs/dsh-subagent 的 notice 形态）。
function makeNoticeMessage(text, summary) {
  return {
    id: makeId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin:dsh-memory", form: "notice", summary: summary || String(text).slice(0, 120) }
  };
}

// ═══════════ [400guard 20260927] **400 事故根治**：surface 落表安全闸 ═══════════
//   同一处 `session.append("user/message", …, { surfaceOp: "append" })` 有**两种**致命形态，本闸同时挡：
//
//   形态①「步骤中途落表 ⇒ 请求 400」：
//     落点插进 assistant(tool_calls) 与其 tool 结果之间 ⇒ 下一次请求被网关拒：
//       400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
//     实证：`session-40d57ebb` seq 625（2026-09-27 04:24:30）一条 dream 进度转播正好插在 step29 的
//     assistant(3 tool-call) 与两个 tool/result 之间 ⇒ turn3 step30、turn4 step1 连报两次 400
//     （request_id 167cd2ea-…／f32cad98-…）。
//     宿主纪律（app.asar:839128）：注入的 user/message 必须落在**本步工具结果之后**；core 自身也只在
//     step 起点 append `decision.messages`（app.asar:289113）。
//
//   形态②「新会话抢在 system 头之前落表 ⇒ 整个日志读不出来」（比 400 更狠：不是某一轮失败，是会话永久损坏）：
//     宿主读取期不变量 = surface **首个节点必须是 system/message**（受保护头）。若在**新会话第一次请求之前**
//     落一条 user/message，之后第一轮的 system 头就再也落不进去，读取期直接抛
//     `SessionFormatError: system/message requires a protected first surface head` ⇒ GUI 报
//     「历史加载失败：stored session … is corrupt」。
//     实证：`session-40d57ebb` 04:06:00 建会话 → 04:06:22 收到 dream 进度转播（seq=11，append）
//     → 04:06:53 第一轮 system 头（seq=19）⇒ 日志自 04:06:53 起不可读。
//     修前备份可复现：`session.v4.jsonl.zstd.bak-corrupt-20260927-112639`（seq=11 user/message 早于 seq=19 system/message）。
//   同源扫库（sweep-session-logs.mjs，近 7 天 149 个 v4 日志）：形态②命中 2 例、形态①命中 1 例 ⇒ ②更常见。
//
//   兜底规则（两条都满足才允许直接落表，否则一律退回 `inject`）：
//     a) 确定空闲：`status === "idle"`（= 没有 open step，不会打断 tool_calls/tool 配对）；
//     b) 已有 surface 头：会话里已经落下过 `system/message`（新会话/判定失败一律不落表）。
//   `inject`（= send(msg, "next-step", wake=false)，app.asar:288879）由宿主在 **step 边界**投递，
//   天然既不会打断配对、也不会抢在 system 头前面。空闲且已有头时才落表，v2.5.1 的「空闲也可见」初衷不变。
function sessionHasSurfaceHead(listener) {
  try {
    const s = listener && listener.session;
    const nodes = s && s.surface && s.surface.nodes;
    if (!nodes || typeof s.eventAt !== "function") return false;   // 拿不到 ⇒ 保守：不冒写坏日志的险
    for (const seq of nodes) {
      const ev = s.eventAt(seq);
      if (ev && ev.type === "system/message") return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}
// 返回 "" = 允许落表；否则返回阻断原因（"midstep" = 回合进行中；"nohead" = 尚无 system 头）
function surfaceAppendBlock(listener) {
  if (!listener || listener.status !== "idle") return "midstep";
  if (!sessionHasSurfaceHead(listener)) return "nohead";
  return "";
}
function canSurfaceAppend(listener) {
  return surfaceAppendBlock(listener) === "";
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
// [logpane 20260930] 本次启动以来的插件日志环形缓冲：桌面端（dsh.exe）看不到宿主控制台、也不便翻日志文件，
//   故每条 clog/cwarn/cerr 同时进内存环，由 GET /dsh-memory/logs.json 增量下发，面板「实时日志」卡每 2 秒轮询。
//   上限 2000 行、重启即清空——正是「本次启动 dsh 以后」的语义。写环失败绝不反噬调用方。
const LOG_BOOT_AT = Date.now();
const LOG_RING_CAP = 2000;
const LOG_RING = [];
function _logPush(level, args) {
  try {
    let text = "";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let s;
      if (typeof a === "string") s = a;
      else if (a instanceof Error) s = (a && a.stack) || String(a);
      else { try { s = JSON.stringify(a); } catch (e) { s = String(a); } }
      text += (i ? " " : "") + (s === undefined ? "undefined" : s);
    }
    LOG_RING.push({ t: Date.now(), level: level, text: text.length > 4000 ? text.slice(0, 4000) + "…" : text });
    if (LOG_RING.length > LOG_RING_CAP) LOG_RING.splice(0, LOG_RING.length - LOG_RING_CAP);
  } catch (e) { /* 记日志失败不影响主流程 */ }
}
const clog = (...a) => { _logPush("info", a); console.log(ts(), ...a); };
const cwarn = (...a) => { _logPush("warn", a); console.warn(ts(), ...a); };
const cerr = (...a) => { _logPush("error", a); console.error(ts(), ...a); };
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
const ARCHIVE_WATERMARK = new Map();   // id → { frames: **已消费帧数**(P14；非文件总帧数), round: 已归档轮次, at: 时间戳, incomplete: 是否被墙钟掐断 }，持久化 .integrate.json archiveWatermarks
let ARCHIVE_WM_DIRTY = false;          // 懒置基线产生的脏标记（下次 saveStaleNotified 顺带落盘）
// ★ B1′ 回归门可观测面：把账本句柄与回填入口导出，让门能**行为**直测「盘面强证据 ⇒ 回填」（而非只靠源码 grep）。
//   函数声明提升 ⇒ 从本行导出后面定义的函数合法；这些导出只增不减，不影响 unwrapExports（本模块 default 仍胜出）。
export { archiveBlockOnDisk, backfillArchivedFromDisk };
// ★★ B1″：见证 → "是否已被处置"（纯函数 ⇒ 门可直测；**只收紧不放松**：无法判定一律 false）
//   written / declared-skip / dropped(已在库、本轮已记) = 已处置 ⇒ 可记账
//   dropped(写盘异常) / 无见证 = 未处置 ⇒ **不记账**（留待下轮，绝不静默消号）
function archiveWitnessDisposed(w) {
  if (!w || typeof w !== "object") return false;
  if (w.mode === "written") return true;
  if (w.mode === "declared-skip") return true;
  if (w.mode === "dropped") return w.reason !== "写盘异常";
  return false;
}
export { archiveWitnessDisposed };
let staleNotifiedLoaded = false;
// ★ §9.11.4-3 修正六/七/十五（红队 rev8c B② → rev8d P1 → **工程席 rev8k A2**）：账本**存在但读不出来**时，
//   归档轮每轮**现问**（`ledgerUnreadableNow()`）⇒ **不需要**"粘滞状态"变量。
//   ★★ 工程席 rev8k 抓出我**同一形态第三次复发**：我给他加了"警告每次都打"之后，`LEDGER_UNREADABLE_TOLD`
//   本身退化成**只被赋值、再无读取点**的死变量（两处 `if (!TOLD) { TOLD = true; }` 是恒真空操作）——
//   而**就在这段注释里**我原先还写着"上一版 `LEDGER_UNREADABLE` 只被赋值、无读取点 ⇒ 已删"。**原样复发**。
//   ⇒ 现**整条删除**（变量+两处 guard），并改用**账本计数器**（`ledgerUnreadableRefuses`/`ledgerUnreadableAt`）做
//     "守卫确实走过"的证据 —— 比抓 stdout 日志串稳健（不跟措辞耦合）、且跨轮跨进程可查（同 `archiveWmEmpty` 范式）。
const SESSIONS_ROOT = portable(path.join(DSH_HOME, "sessions"));
// ★ 工程席 rev8k A2：**"账本不可读 ⇒ 拒绝写盘"的可观测证据**（供门 `T9h` 与健康行读）。
//   放在**内存**里而不落损坏账本（后者是要保护的对象 —— 我第一版写进账本 ⇒ 把损坏账本覆盖了，被门当场抓住）。
let REFUSE_WRITE_SEEN = 0;
// ★★ §9.11.4-11（B4）**单元写失败**的计数（同 REFUSE_WRITE_SEEN 范式：**内存 + 旁路账本**，
//   **绝不写进 `.integrate.json`** —— 那是 fail-closed 要保护的对象，本批已因写进去栽过一次）。
//   用途：让"盘上没单元"这一现象**能区分成因**（写失败 / 被淘汰 / 从未写 —— 下游读侧三者同貌）。
//   ★ 与 `REFUSE_WRITE_SEEN` 的区别：那个是"**账本**被拒写"，这个是"**单元**写不成"，两者不同对象、不同处置。
let UNIT_WRITE_FAIL_SEEN = 0;

// ══════════ v2.6.5（2026-09-16 会话日志文件名自适配 + 格式漂移自检，用户报障）═══════════
// 事故：DSH 于 2026-09-10 20:10 起把会话日志由 session.jsonl.zstd 改名为 session.v3.jsonl.zstd
//   （zstd 多帧格式不变、magic 仍 28b52ffd，只是文件名变）。插件 6 处读日志点全部硬编码旧名 →
//   statSync 失败即 continue，漏网检测/水位帧数/used 判定/归档提取全链对该类会话**静默失效**：
//   实测 283 个 v3 会话（09-10~09-16，含当天 19 个）从未进入候选，归档账本最后一批停在 09-10，
//   积压 63 个未落档会话；控制台零报错——与 v2.6.3 的 agent/session-start→agent/created 改名事故同型。
// 修法①（自适配）：`resolveSessionLogPaths(dir)` 按**时间顺序**返回同目录全部日志（v2.8.4/P21 起为复数），
//   5 处调用点统一走它。⚠ 单数版（只取优先级最高的一个）已在 P21 删除 —— 双名目录会整类漏读。
// 修法②（自检）：扫描时顺带采集未识别的 *.jsonl.zstd 名 → 维护提醒注入对话一次（按名去重，
//   持久化 .integrate.json fmtNotified）——DSH 若再改名，用户当轮就能看见，而不是 6 天后才发现。
const SESSION_LOG_CANDIDATES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"];   // 顺序=优先级（新→旧）
const KNOWN_LOG_NAMES = new Set(SESSION_LOG_CANDIDATES);
const UNKNOWN_LOG_NAMES = new Map();   // 未识别名 → { count, sample, at }（进程内累积，扫描时采集）
const UNKNOWN_LOG_DIRS = new Set();    // 已采样目录（防同一目录重复计数）
let FMT_NOTIFIED = new Set();          // 已提示过的未识别名（持久化，防刷屏）
let fmtNotifiedLoaded = false;

// v2.8.4（P21）：单数版 `resolveSessionLogPath` 已**删除** —— 它"首个命中即返回"，
//   在双名目录（实测 7 个）里整类看不见第二个文件。全部调用点改走 `resolveSessionLogPaths`（见下）。
// ═══════════ v2.8.4（P21）：**同目录多日志** —— 旧实现"首个命中即返回"会整类看不见第二个文件 ═══════════
// 实测（2026-09-18，`_probe-21-order.mjs`）：
//   ① **7 个目录两个名都在**（`session.jsonl.zstd` 与 `session.v3.jsonl.zstd` 并存）；
//   ② **7/7 满足 `mtime(legacy) < mtime(v3)`** ⇒ 正确的**时间顺序**是 `[legacy, v3]`
//      （DSH 在 09-10 20:10 前后改名，改名当天正在进行的会话**两侧都留了内容**）。
//   ③ 危害：`resolveSessionLogPath` 按**优先级**返回 v3，而账本水位是**改名之前**用 legacy 记下的
//      ⇒ 6/7 个会话出现 `cur(216) > wm(9838)` 为**假** ⇒ **永不重入**；两文件共 66262 帧中
//      **53734 帧（81.1%）**对插件整类不可见（≈41.0 M 字符，与「7 个劈开 sid」的实测吻合）。
// 量纲（P22）：帧水位一律用 **sum(frames)**；`readUnitCache` 的 `curFrames` 必须传同一个 sum，
//   否则出现"存 sum 读单文件 ⇒ 恒判陈旧（每轮全量重提取）"或"存单文件读 sum ⇒ 前半段永不进单元"。
const SESSION_LOG_CHRONO = ["session.jsonl.zstd", "session.v3.jsonl.zstd", "session.v4.jsonl.zstd"];   // **时间顺序**（旧的在前）—— 由 mtime 实测 7/7 判定
function resolveSessionLogPaths(dir) {
  const out = [];
  for (const n of SESSION_LOG_CHRONO) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).isFile()) out.push(p); } catch (e) { /* 试下一个 */ }
  }
  return out;
}
// 会话总帧数（sum）——**唯一量纲**；任一文件读不到 ⇒ null（调用方按「读不到日志」保守处理）
function sessionFramesTotal(paths) {
  let n = 0;
  for (const p of paths) { const c = countZstdFrames(p); if (c === null) return null; n += c; }
  return n;
}
// 把**聚合水位**分摊成逐文件偏移（P21 的核心，纯函数 ⇒ 可被门直接行为断言）：
//   ① 有账本 `byFile` 记录 ⇒ **精确**用记录；
//   ② 否则若水位**恰好等于某一个文件**的帧数 ⇒ 全部归给它。实测校准（`_probe-merge-overflow.mjs`）：
//      7 个双名会话里 `574b8af7` 的水位 3747 恰等于 **v3** 的帧数（旧码按优先级只读 v3）⇒ 前缀和会误判成
//      "legacy 已消费"，把 legacy 的 2 帧永久当成已读；本规则 6/7 与前缀和同解、第 7 个被修正。
//   ③ 其余（水位不对应任何单文件）⇒ 按**时间顺序前缀和**分摊（实测 6/7 的形态正是"legacy 全归档、v3 全新"
//      ⇒ 得到 `[9838, 0]`，正确地**从 v3 头开始**）。
function distributeOffsets(names, perFile, wm) {
  const total = perFile.reduce((a, b) => a + (Number(b) || 0), 0);
  let S = (wm && typeof wm.frames === "number" && wm.frames > 0) ? wm.frames : 0;
  if (S > total) S = total;                    // 日志被外部重写/缩水 ⇒ 夹到当前总量，**绝不越界**
  const byFile = (wm && wm.byFile && typeof wm.byFile === "object") ? wm.byFile : null;
  if (byFile) {
    // ★★ 修正十四（**红队 rev8h C-2**）：byFile 分支原先**完全忽略 `S`（wm.frames）** ⇒ 账本自相矛盾时
    //   没有任何交叉校验：若各项之和 > `S`，就会把某文件"整文件跳过"（→ 靠修正十一兜底 = 静默挂起）。
    //   现改为**在 `S` 的约束内**取用：逐项累加，一旦用满 `S` 就停（其余记 0）—— byFile 与 frames 互为校验。
    const acc = []; let used = 0;
    for (let i = 0; i < names.length; i++) {
      const want = Math.max(0, Math.min(Number(byFile[names[i]]) || 0, perFile[i]));
      const take = Math.max(0, Math.min(want, S - used));
      acc.push(take); used += take;
    }
    return acc;
  }
  if (S > 0) {
    const exact = [];
    for (let i = 0; i < perFile.length; i++) if (perFile[i] === S) exact.push(i);
    if (exact.length === 1) {                  // ② 唯一精确匹配 ⇒ 全部归给它，其余为 0
      const one = perFile.map(() => 0);
      one[exact[0]] = S;
      return one;
    }
  }
  const out = [];                              // ③ 前缀和
  let left = S;
  for (let i = 0; i < perFile.length; i++) { const take = Math.min(left, perFile[i]); out.push(take); left -= take; }
  return out;
}
// 目录内是否藏着未识别的日志名（*.jsonl.zstd 且不在已知表）——仅供自检提示，不参与任何判定
function probeUnknownLogNames(dir) {
  if (UNKNOWN_LOG_DIRS.has(dir)) return null;
  UNKNOWN_LOG_DIRS.add(dir);
  try {
    for (const fn of fs.readdirSync(dir)) {
      if (!/\.jsonl\.zstd$/.test(fn) || KNOWN_LOG_NAMES.has(fn)) continue;
      const cur = UNKNOWN_LOG_NAMES.get(fn);
      if (cur) cur.count++; else UNKNOWN_LOG_NAMES.set(fn, { count: 1, sample: dir, at: Date.now() });
      return fn;
    }
  } catch (e) { /* 目录读不到：不报 */ }
  return null;
}

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
// v3.2.0（2026-10-02 Wave 1）：**E 类独立冷却桶**——旧实现 D/E 共用 SPIRAL_REMIND_AT（L9863/L9887），
//   一次 E 投递会把 D 的冷却窗一起吃掉、反之亦然（口径污染 + 互相当刹车）。语义与 D 桶完全对称。
const SPIRAL_REMIND_E_AT = new Map();    // v3.2.0: sessionId -> { ts, streak }（E 类专用冷却桶）
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

// v2.8.5（2026-09-27）：指针「何时读」触发语通道。
//   动因：index.md 是注入层**唯一路由表**，但全部条目都是 Blind References（只给目标、不说何时该读）——
//   学术侧《Configuration Smells in AGENTS.md》(arXiv 2606.15828, 100 个热门仓库抽样 **91% 含此异味**) 单列此项。
//   设计（约定+代码双保险，防 dream 覆盖）：括号内用 **`何时:`** 前缀切出触发语部分，触发语**不进 kws**
//   （否则「当用户问…时」这类自然语言会被 bigram 匹配污染 A 类提醒——v2.0.4「空关键词无条件命中」同类事故），
//   只随命中结果一并回传作**模型可读的路由依据**；其后的部分仍按原语义作关键词。
//   语法：`- 主题（关键词1/关键词2 何时:触发场景）→ 文件.md`；无 `何时:` 时行为与旧版**逐字一致**。
const TRIGGER_MARK_RE = /何时[:：]/;

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
      //   v2.8.5：name 组收紧为 `[^｜→]+?`——必须**禁 ｜ 与 →**（争用时会把整个后续条目吞进 name）；
      //     **不可**写成 `[^（(]+?`：本库绝大多数行的括号在 `→` **之前**（如 `发改委项目归档（…）→文件`），
      //     禁括号会让这些行整条失配（gate 实测 4 条 fixture 全灭、真库 42→1）。
      //   括号剥离：本库括号位于 name 尾部，故 desc 组（`→` 之后）实际吃不到 ⇒ 从 name 尾部剥括号。
      const m = seg.match(/^(?:-\s*)?([^｜→]+?)\s*→\s*(MEMORY-[^\s（）()|]+|[^\s（）()|]+\.md)(?:\s*[（(]([^）)]*)[)）])?/);
      if (!m) continue;
      const file = m[2].trim();
      let name = m[1].trim();
      let rawParen = (m[3] || "").trim();
      // v2.8.5：只从 name 尾部剥括号——但**仅当括号能给出触发语**时才剥，否则原样留回 name，
      //   保证「无 何时: 标记」的行与旧版**逐字等价**（旧版把括号留在 name，括号内容照旧参与关键词）。
      //   真库实测：6 条括号含自然语言（如徕卡行「工作目录与原始包/交付物/逆向工作区见该档」），
      //   无条件剥离会让「见该档」这类叙述词变成 A 类提醒关键词——故按标记收紧。
      const tail = name.match(/[（(]([^（()）]*)[)）]\s*$/);
      let parenFromName = "";
      if (tail && !rawParen) parenFromName = tail[1].trim();
      const parenText = rawParen || parenFromName;
      const trigMark = parenText.match(TRIGGER_MARK_RE);
      let desc = "", trigger = "";
      if (trigMark) {
        // 带 `何时:` 的行才启用新语义：左＝关键词（旧语义），右＝触发语（不进 kws）
        desc = parenText.slice(0, trigMark.index).trim();
        trigger = parenText.slice(trigMark.index + trigMark[0].length).trim();
        if (parenFromName) name = name.slice(0, tail.index).trim();
      } else if (rawParen) {
        desc = rawParen;   // → 之后的括号（旧版 desc 语义，保持原样）
      } else {
        name = m[1].trim();   // 无标记：name 原样（含括号），与旧版逐字等价
      }
      const kws = [];
      // name 除整串外，按斜杠切子领域（如 "REST API/推送" → 追加 "推送"）——混合词的中文主体可独立命中
      const nameParts = [name, ...name.split(/[/／]+/).map((s) => s.trim()).filter((s) => s.length >= 2)];
      for (const part of [...nameParts, ...desc.split(/[/、,，;；\s]+/).filter(Boolean)]) {
        // v2.0.4: 丢弃空关键词——2字符纯英文/数字词（Qt/CA/OA/26/38）通过长度准入但 splitKw 的 lats 正则要求≥3字符，
        // 产出 {han:[],lats:[]} 对任何文本无条件命中（08-24 实测 7 个领域行中招，A 类提醒与任务无关的根因）
        const k = splitKw(part);
        if (k.hanGrams.length || k.lats.length) kws.push({ part: String(part), hanGrams: k.hanGrams, lats: k.lats });   // v2.2.1: 保留原文，命中时展示触发词
      }
      rows.push({ kws, file, name, trigger });
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
      hits.push({ file: row.file, name: row.name, parts: hitParts.slice(0, 3), trigger: row.trigger || "" });   // v2.2.1: 触发词随行返回（最多 3 个）；v2.8.5: 携「何时读」触发语
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
    // v3.2.0（2026-10-02 Wave 0 埋点）：**闸门决策留痕** [{t,n,cls,reason,rep,neg,winLen,streak,cdMs}]
    //   动因（2026-10-01 事故）：D 类 7 次命中全被 batchLike 静默，而"命中却无投递"**没有任何证据**，
    //   只能靠"排除冷却 ⇒ 只剩 batch"反推（红队复核 03 §1.3）。可观测性缺口必须由埋点闭合。
    //   独立数组（不写 events：events 尾部 cap 2000 且 tool 事件占 97.7%，塞进去会被挤掉/挤掉别人）；
    //   段合并见 recordGate()——同一 (sid,cls,reason) 10 分钟内就地累加 n，不追加条目。
    gateEvents: [],
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

// v3.2.0（2026-10-02 Wave 2 候选 C）：D 闸门决策抽成**纯函数**（便于单测；调用点只剩副作用）。
//   为什么必须抽出来：候选 C 改变了"batchLike 与冷却"的相对顺序——旧实现 `backoffAllowed(..., batchLike)`
//   在**冷却检查之前**短路返回 not-allowed ⇒ batchLike 一旦变成"可投递"，若照抄旧顺序就会**每次命中都投**（刷屏）。
//   新语义：**冷却永远先判**；批量样态命中在冷却通过时"降级投递"（soft），并把冷却**加倍**（streak 多跳一档）；
//   冷却没过则记 `batch-cooldown`（与普通 `cooldown` 分开，便于事后区分"被冷却拦的批量样态"）。
//   返回：{ mode: "ok" | "soft" | "blocked", reason, streakNext, gate }
function decideDGate(batchLike, bucket, cooldownBaseMs, nowMs, softEnabled) {
  const gate = backoffAllowed(bucket, cooldownBaseMs, nowMs, false);   // 不传 batchLike：冷却照常生效（顺序修正点）
  if (!gate.allowed) {
    return { mode: "blocked", reason: batchLike ? "batch-cooldown" : "cooldown", streakNext: gate.streak, gate: gate };
  }
  if (batchLike) {
    if (softEnabled === false) return { mode: "blocked", reason: "batch", streakNext: gate.streak, gate: gate };   // 回退旧口径（硬静默）
    return { mode: "soft", reason: "batch-soft", streakNext: gate.streak + 2, gate: gate };   // 降级投递 + 冷却加倍（多跳一档）
  }
  return { mode: "ok", reason: "ok", streakNext: gate.streak + 1, gate: gate };
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
// v2.6.7：UTF-8 字节数（沙箱无 Buffer，用 TextEncoder）——**提级到模块级**（原在 apply 闭包内，W1 阶段：
//   软硬阈值同源需在模块级判定；纯函数无闭包依赖。注：模块级调用闭包内函数会 ReferenceError，
//   而注入链在 try 内会把异常吞成一行 cerr → 记忆注入整链静默失效，故此处必须模块级）。
function utf8Bytes(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch (e) {
    return text.length;
  }
}

// v2.4.28：硬性注入预算提级到模块级（原 apply 闭包内 L4787，D0 计量纯函数需在模块级引用）。
//   语义不变：CHAR_LIMIT 是"超过注入会被 slice 截断"的硬上限（global 3000 字≈9KB、index 2000 字≈6KB、摘要 1500 字≈4.5KB）；
//   SIZE_WARN 是**字节**软阈值，原注释「中文 4608B≈1500字」隐含 3 B/字符、只对纯中文成立 —— 对 ASCII 密集文件
//   （index.md 实测 1.857 B/字符）该阈值**位于硬预算之后**，软告警整条通道不可达。v2.6.7 起软告警改为**字符口径**
//   （硬预算 × WARN_CHAR_RATIO，见下 SIZESTATE 区），SIZE_WARN 退为**字节兜底**（OR 关系）。三态口径见 sizeStateOf。
//   仅此一处真源；闭包内原引用点（sectionAwareSlice/checkSizeOverflow/buildMemoryDocStatus）自动读模块级。
// v2.6.8（P5.1-1）：根文件**单源**——任何"根文件全量"的循环/默认值都引用本常量，禁止再写内联数组字面量
//   （工程席实测：加一个根文件曾牵连 ≥19 处，其中 6 处属"改判定"；稀释点就是散落各处的内联 `["global.md","index.md"]`）。
//   ⚠ L8894 附近的「纯删未下沉」检查**故意不用**它（该约束原为 fixed.md 写保护所需；fixed 层已于 v2.7.0 拆除）。
const ROOT_FILES = ["global.md", "index.md"];
const CHAR_LIMIT = { "global.md": 3000, "index.md": 2000, summary: 1500 };
const SIZE_WARN = { "global.md": 4608, "index.md": 4608, summary: 4096 }; // v9.1: global 4096→4608B、摘要 2048→4096B（与注入截断对齐降噪音）；v10.1: index 3072→4608B；v2.6.7: 退为字节兜底（判定改用字符口径 sizeStateOf）
// ═══ v2.6.7（W1）：软硬阈值同源 —— 修「软告警对 ASCII 密集文件不可达」═══
// 实证（2026-09-17）：index.md 以 ASCII 路径/ID 为主，实测 **1.857 B/字符**（1963 字/3645 B）。而软阈值 SIZE_WARN
//   是**字节**、硬预算 CHAR_LIMIT 是**字符** → 「旧软告警先于硬限可响」的充要条件 b > W/L（b=字节/字符）对 index
//   要求 b > 2.304，实际 1.857 → **软告警通道整条不可达**：文件已 2102 字符（越 2000 硬限）仍零告警。
// 处置：软告警与硬预算**同源** —— 以 CHAR_LIMIT 为基准算字符线（WARN_CHAR_RATIO），SIZE_WARN 退为字节兜底（OR）。
// 三态（面板/cwarn/提醒共用）：overHard（注入已被 sectionAwareSlice 截断）/ nearHard（接近硬限）/ overSoft（字节兜底）。
// ⚠ 零退化的诚实边界：对 b ≥ W/warnChars 的文件（如 global 1.707、纯中文）逐字不变；对 b 更小的文件本改动是
//   **按设计提前告警**，额外告警区间 = [warnChars, floor(W/b)]（现库 index 提前 682 字符、summary 提前 927 字符；
//   纯 CJK b=3.0 时 summary 仍有 [1350,1365] 差异带）→ 详见 docs/CHANGELOG.md v2.6.7「影响面」段。
// >>> SIZESTATE BEGIN   （供门测试按 marker 抽取求值；本区**禁止**出现 export/import —— test/onboard.unit.test.mjs 同法求值 ONBOARD 区）
const WARN_CHAR_RATIO = 0.9;          // 软告警线 = 硬预算 × 0.9（index 2000→1800）
const WARN_CHAR_CLEAR_RATIO = 0.85;   // 滞回清除线（降到线下才复位，防 1800 附近来回 flap）
function limitOf(key, table) {
  // v2.6.8（P5.1-3）：改用 hasOwnProperty —— 未登记 key 仍回落 table.summary（**契约**：_gate-plugin-load.mjs
  //   与 _test-size-warn-parity.mjs 都断言 warnCharsOf(undefined) === 1350），但不再可能取到原型键（toString 等）。
  //   刻意**不加** cwarn：本函数是导出纯函数，加副作用会与门的捕获口径耦合。
  const v = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : table.summary;
  return typeof v === "number" && Number.isFinite(v) ? v : table.summary;
}
function warnCharsOf(key) { return Math.floor(limitOf(key, CHAR_LIMIT) * WARN_CHAR_RATIO); }
function clearCharsOf(key) { return Math.floor(limitOf(key, CHAR_LIMIT) * WARN_CHAR_CLEAR_RATIO); }
// 单一判定源：三处 cwarn + checkSizeOverflow + buildMemoryDocStatus + /dream 健康共用（防口径再次漂移）
function sizeStateOf(key, text) {
  const s = String(text == null ? "" : text);
  const bytes = utf8Bytes(s);
  const chars = s.length;
  const byteWarn = limitOf(key, SIZE_WARN);
  const charLimit = limitOf(key, CHAR_LIMIT);
  const warnChars = warnCharsOf(key);
  const clearChars = clearCharsOf(key);
  const overHard = chars > charLimit;                        // 与 sectionAwareSlice（<= lim 不截断）同口径：== lim 不算超
  const nearHard = !overHard && chars >= warnChars;
  return { bytes, chars, byteWarn, charLimit, warnChars, clearChars, overHard, nearHard, overSoft: bytes > byteWarn };
}
// >>> SIZESTATE END
export { sizeStateOf, warnCharsOf, clearCharsOf };

// ══════════════════════════════════════════════════════════════════════════════
// v2.6.8（P4 / 提案③）未沉淀清单 —— 只读、非阻塞、不自动动作
//   动机（证据席实测）：条目级未沉淀率 35.8%~56.4%（5 个日档 250 条精确字面量里，出现在 projects/ 的 = 0）；
//     插件现有判据只有「整会话级」sessionMentionedInMemory（L3243），**条目级完全不可观测**。
//   纪律：只读；只出报告；不自动下沉；不注入（默认随 /dream 结算报告出 → 注入增量 0）。
//   必扫 archive：轮转后旧档不可检索，只扫活跃日档会把"30 天前没沉淀"全判成假阳性（假阳性爆炸）。
//   抗漂移：账本记 firstSeen，报告"新增条数 / 滞龄 >21 天条数"，避免每轮复述同一批。
//   ⚠ 模块级函数：只许引用模块级符号（MEMORY_ROOT / portable / fs）——v2.6.7 的 utf8Bytes 教训。
const DEPOSIT_WATCH_FILE = MEMORY_ROOT + "/.deposit-watch.json";

function scanUndeposited(opts) {
  const days = (opts && opts.days) || 14;
  const cap = (opts && opts.cap) || 300;   // 真库实测：14 天窗口 >200 条 → 上限过低会把"≥200"谎报成"40"（口径诚实性）
  try {
    const cutoff = Date.now() - days * 86400000;
    const files = [];
    try {
      for (const n of fs.readdirSync(portable(MEMORY_ROOT + "/sessions"))) {
        const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(n);
        if (!m) continue;
        if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() < cutoff) continue;
        files.push("sessions/" + n);
      }
    } catch (e1) {}
    try {
      for (const n of fs.readdirSync(portable(MEMORY_ROOT + "/sessions/archive"))) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) files.push("sessions/archive/" + n);
      }
    } catch (e2) {}
    let deposited = "";
    const pushDir = (rel) => {
      try {
        for (const n of fs.readdirSync(portable(MEMORY_ROOT + "/" + rel))) {
          if (!n.endsWith(".md")) continue;
          try { deposited += fs.readFileSync(portable(MEMORY_ROOT + "/" + rel + "/" + n), "utf8"); } catch (e0) {}
        }
      } catch (e0) {}
    };
    pushDir("knowledge"); pushDir("projects"); pushDir("tools");
    for (const rf of ROOT_FILES) {   // v2.6.9（P0）：改用单源常量（原为内联三元组，是"加一个根文件牵连多处"的稀释点）
      try { deposited += fs.readFileSync(portable(MEMORY_ROOT + "/" + rf), "utf8"); } catch (e0) {}
    }
    const RES = [
      /`([^`\n]{6,120})`/g,
      /[A-Za-z]:\\[^\s`"'（）()|,，。；;、]{4,120}/g,
      /〔[^〕\n]{1,20}〕\d{1,4}号/g,
      /https?:\/\/[^\s`"'（）()|]{6,120}/g,
      /\b[\w.-]{2,40}\.(ps1|py|mjs|cjs|exe|json|xlsx|docx|md)\b/g,
    ];
    // ── 「值得沉淀」判据（v2.6.8 收紧）──
    // 初版只按长度收，实测真库首屏大半是代码碎片（`$out=& cmd`、`if (floatProc !== null) return true`、
    //   `注释下方出现`）——报告变噪音等于功能没用。判据：必须像"可复用的精确字面量"，且排除代码/通配形态。
    const CMD_START = /^(npm|npx|pip|pip3|uv|git|node|python|pwsh|powershell|winget|choco|scoop|curl|ssh|scp|certutil|netsh|reg)\s/;
    const PS_CMD = /^(Set|Get|New|Remove|Copy|Move|Start|Stop|Enable|Disable|Add|Clear|Test|Invoke|Out|Select|Where|Sort|Group|Measure|ConvertTo|ConvertFrom)-[A-Za-z]+/;
    const isWorthyLiteral = (lit) => {
      if (!lit || lit.length < 6 || lit.length > 120) return false;
      const isUrl = /^https?:\/\//.test(lit);
      if (!isUrl && /[*?#<>{}|]/.test(lit)) return false;                       // 通配符/占位/管道/花括号 = 形态不是字面量
      const isPath = /^[A-Za-z]:[\\/]/.test(lit) || /^%[A-Za-z]+%/.test(lit) || /^\\\\/.test(lit);
      const hasExt = /\.(ps1|py|mjs|cjs|exe|json|xlsx|docx|md|yaml|yml|txt|zip|pdf|wps|ofd|log|bak)\b/i.test(lit);
      const hasDocNo = /〔[^〕]+〕/.test(lit);
      const hasScope = /@[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+/.test(lit);
      const hasNum = /\d{4,}/.test(lit);
      if (!(isPath || isUrl || hasExt || hasDocNo || hasScope || hasNum)) return false;
      // 带空格的必须"像命令/像路径/像文号"，否则多半是散文或代码
      if (/\s/.test(lit) && !isPath && !isUrl && !CMD_START.test(lit) && !PS_CMD.test(lit) && !hasDocNo) return false;
      return true;
    };
    const seen = new Set(), out = [];
    for (const rel of files) {
      let txt = "";
      try { txt = fs.readFileSync(portable(MEMORY_ROOT + "/" + rel), "utf8"); } catch (e3) { continue; }
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        for (const re of RES) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line))) {
            const lit = String(m[1] || m[0] || "").trim();
            if (!isWorthyLiteral(lit)) continue;
            if (seen.has(lit)) continue;
            seen.add(lit);
            if (deposited.includes(lit)) continue;
            out.push({ lit: lit, src: rel });
            if (out.length >= cap) return { ok: true, days: days, scanned: files.length, items: out, truncated: true };
          }
        }
      }
    }
    return { ok: true, days: days, scanned: files.length, items: out, truncated: false };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e), days: days, items: [] };
  }
}

// 水位账本：只记 firstSeen（新增判定 + 滞龄统计），独立点文件，不与 dream 结算共用 .integrate.json。
function updateDepositWatch(items) {
  const now = Date.now();
  let prev = {};
  try { prev = (JSON.parse(fs.readFileSync(portable(DEPOSIT_WATCH_FILE), "utf8")) || {}).items || {}; } catch (e0) {}
  const next = Object.assign({}, prev);
  for (const it of (items || [])) if (it && it.lit && !next[it.lit]) next[it.lit] = now;
  // 软上限：账本只用于「新增/滞龄」，超量时按 firstSeen 保最新 2000 条（防无限增长）
  let nextKeys = Object.keys(next);
  if (nextKeys.length > 2000) {
    const keptKeys = nextKeys.sort((a, b) => (next[b] || 0) - (next[a] || 0)).slice(0, 2000);
    const trimmed = {};
    for (const k of keptKeys) trimmed[k] = next[k];
    nextKeys = keptKeys;
    try { fs.writeFileSync(portable(DEPOSIT_WATCH_FILE), JSON.stringify({ at: now, items: trimmed }, null, 2), "utf8"); } catch (e2) {}
    return { fresh: (items || []).filter((it) => it && it.lit && !prev[it.lit]).length, aged: 0, total: (items || []).length, ledger: nextKeys.length };
  }
  const fresh = (items || []).filter((it) => it && it.lit && !prev[it.lit]).length;
  const aged = Object.keys(prev).filter((k) => now - (prev[k] || 0) > 21 * 86400000).length;
  try { fs.writeFileSync(portable(DEPOSIT_WATCH_FILE), JSON.stringify({ at: now, items: next }, null, 2), "utf8"); } catch (e1) {}
  return { fresh: fresh, aged: aged, total: (items || []).length, ledger: Object.keys(next).length };
}
export { scanUndeposited, updateDepositWatch };
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
// ═══════════ v2.8.4（容量治理·**硬保证**）：超限文件机械下沉 ═══════════
// 它破的是什么死循环（2026-09-18 实测，非推演）：
//   验收每轮报「<文件> 仍超限…**下次整合优先提取**」，而**没有任何环节会让文件变小** ——
//   ① 那句"下次优先"是**字符串拼接**（验收体检处），没有优先级字段、没有计数器、没有动作；
//   ② 模型那条"整节下沉"引导挂在「memory_dream_patch **被拒写**」事件上，可实况是"**本轮未写**"
//      ⇒ 不产生该事件 ⇒ 引导**永不触发**（没有差数、没有分节表，模型也不知道该沉多少、从哪节沉）；
//   ③ 唯一的压缩器（合并维护）两次无进展即按设计停手（`stuck=infeasible`）；
//   ④ 注入端有 `hard-cut` 硬切兜着 ⇒ 表面还能用 ⇒ 没人去真正缩小文件。
//   ⇒ 状态永不改变（实测：projects 两文件连续 2 轮"本轮未写"、当日摘要 20321 字符 ≥ 硬预算 1500）。
// 本函数是**不依赖模型判断的执行者**：把**整节**逐字搬到 knowledge/ 明细件，主文件留一行指针。
// 安全不变量：① 搬走的每一节都必须**逐字**出现在 sink 里（**先校验再落盘**）② 主文件写前留备份
//   ③ 任一步失败 ⇒ 主文件原样不动（返回 ok:false，绝不半途改文件）④ 只减不增（净减不成立即放弃）。
function sinkOverLimitFile(rel, opts) {
  const o = opts || {};
  try {
    const fsz = o.fs || fs;
    const root = String(o.root || MEMORY_ROOT).replace(/\\/g, "/");
    const main = portable(root + "/" + rel);
    let text = ""; try { text = fsz.readFileSync(main, "utf8"); } catch (e) { return { ok: false, why: "read-failed" }; }
    const target = Number.isFinite(Number(o.target)) ? Number(o.target) : PROJECT_CHAR_SOFT;
    if (text.length <= target) return { ok: false, why: "not-over:" + text.length };
    // ① 切节：头块 = 第一个 `## ` 之前（**永不搬** —— 它承载结论/画像/索引行）；其后每节到下一个 `## ` 行
    const lines = text.split("\n");
    const secs = []; let cur = null, offset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { if (cur) { cur.end = offset; secs.push(cur); } cur = { title: lines[i].trim(), start: offset, end: 0 }; }
      offset += lines[i].length + 1;
    }
    if (cur) { cur.end = offset; secs.push(cur); }
    if (!secs.length) return { ok: false, why: "no-sections" };
    const head = text.slice(0, secs[0].start);
    secs.forEach((s) => { s.text = text.slice(s.start, s.end); s.chars = s.text.length; });
    // ② 牺牲序 + **可搬范围**：
    //   · `projects/` 文件：**只允许搬"冷节"**（`SINK_PREFER_RE` = 归档/漏网会话补档族）。
    //     ★ 由 dry-run 拦下的一次破坏性动作：初版对项目文件"按位置从前往后搬"，实测会把
    //     `## 周报与联系人口径`/`## 数据资产`/`## 当前状态与下一步` 这些**活内容**搬走 ——
    //     "哪一节还活着"是**判断**，不该由机械下沉替人做。冷节不够 ⇒ 不搬（`insufficient-cold`），
    //     交由整合下沉（有判断）或人工处理，并如实报出来。
    //   · 其它文件（当日摘要等注入面）：全部节都可搬，冷节优先，其次越靠前越旧。
    //   ★ 二次修正（实测再拦一次）：**全局统一为"只搬冷节"**。初版对非 projects 文件（当日摘要）放行"全部节"，
    //   dry-run 实测会搬走 `## 项目块：…`/`## 检查点（目标与下一步）`/`## 本次目标` —— 那是**当日摘要自己的正文**，
    //   不是冷数据。搬它等于把"今天的总结"搬空。冷节判定是**唯一无需判断**的边界 ⇒ 全局只搬它。
    const ranked = secs.filter((s) => !/已下沉/.test(s.title) && SINK_PREFER_RE.test(s.title)).slice().sort((a, b) => {
      const pa = SINK_PREFER_RE.test(a.title) ? 0 : 1;
      const pb = SINK_PREFER_RE.test(b.title) ? 0 : 1;
      return (pa - pb) || (a.start - b.start);
    });
    const ptrEst = 150;                                   // 指针行长度上界（决定"还要再搬一节吗"）
    const moved = []; let movedChars = 0;
    for (const s of ranked) {
      if (text.length - movedChars + ptrEst <= target) break;
      moved.push(s); movedChars += s.chars;
    }
    if (!moved.length) return { ok: false, why: "insufficient-cold" };
    if (text.length - movedChars + ptrEst > target) return { ok: false, why: "insufficient-cold:" + (text.length - movedChars) };
    // ★ 实测抓到的坑：`dateStr` 是 apply 内的闭包函数，**模块级用不了**（下沉首次运行就报 throw: dateStr is not defined）。
    //   故本函数自带日期格式化（用模块级的 `pad`）。
    const _d0 = new Date();
    const stamp = _d0.getFullYear() + "-" + pad(_d0.getMonth() + 1) + "-" + pad(_d0.getDate());
    const sinkRel = o.sinkRel || ("knowledge/MEMORY-" + path.basename(rel, ".md") + "-明细.md");
    let sinkOld = ""; try { sinkOld = fsz.readFileSync(portable(root + "/" + sinkRel), "utf8"); } catch (e) { sinkOld = ""; }
    const add = moved.map((s) => "<!-- 下沉自 " + rel + " " + stamp + " -->\n" + s.text.replace(/\s+$/, "")).join("\n\n");
    const newSink = (sinkOld ? sinkOld.replace(/\s+$/, "") + "\n\n" : "") + add + "\n";
    const ptr = "## 明细已下沉 → " + sinkRel + "（" + stamp + "，" + movedChars + " 字符 / " + moved.length + " 节；memory_search 可检索该文件）\n";
    const kept = secs.filter((s) => moved.indexOf(s) < 0);
    const newMain = head + kept.map((s) => s.text).join("") + "\n" + ptr;
    // ③ 先校验后落盘
    for (const s of moved) if (newSink.indexOf(s.text.replace(/\s+$/, "")) < 0) return { ok: false, why: "verify-failed:" + s.title };
    if (newMain.length >= text.length) return { ok: false, why: "no-shrink" };
    const meta = { ok: true, rel: rel, sinkRel: sinkRel, before: text.length, after: newMain.length, movedCount: moved.length, movedChars: movedChars, movedTitles: moved.map((s) => s.title), movedAll: kept.length === 0 };
    if (o.dryRun) return Object.assign(meta, { dryRun: true });
    const ts = Date.now();
    try { fsz.writeFileSync(main + ".pre-sink-" + ts + ".bak", text); } catch (e) { return { ok: false, why: "backup-failed" }; }
    try { if (sinkOld) fsz.writeFileSync(portable(root + "/" + sinkRel) + ".pre-sink-" + ts + ".bak", sinkOld); } catch (e) {}
    writeFileAtomic(portable(root + "/" + sinkRel), newSink, { tag: "sink" });
    writeFileAtomic(main, newMain, { tag: "sink" });
    return meta;
  } catch (e) { return { ok: false, why: "throw:" + (e && e.message ? e.message : String(e)) }; }
}
// v2.8.4（容量治理·A）：把「差数 + 分节表」**主动喂给下一轮整合**。
//   为什么需要：模型的"整节下沉"引导本来挂在「memory_dream_patch **被拒写**」事件上（见 sinkOverLimitFile 头注释
//   的 ①–④），而实况多是「**本轮未写**」⇒ 该事件永不发生 ⇒ 没有差数、没有分节表 ⇒ 模型只能继续报"下次优先"。
//   本函数把**同样的机器事实**渲染成一个提示块，由 `spawnIntegrate` 拼进 `capacityText` ⇒ 不必先写再被拒。
function renderOverLimitHint(hint) {
  if (!hint || typeof hint !== "object") return "";
  const keys = Object.keys(hint).filter((k) => hint[k] && hint[k].cleared !== true && Number(hint[k].chars) > 0);   // 墓碑（已下沉干净的路径）不进 prompt
  if (!keys.length) return "";
  const L = ["\n【插件预置·超限文件的下沉依据（**无需先提交一个会被拒的 patch**）】"];
  for (const k of keys.slice(0, 6)) {
    const h = hint[k];
    L.push("- " + k + "：当前 " + h.chars + " 字符 / 硬限 " + h.limit + " / **需减 ≥ " + h.overBy + " 字符**（目标 ≤" + h.target + "，保留净空防 append 即重超）");
    const secs = Array.isArray(h.sections) ? h.sections : [];
    // ★★ v3.0.1：渲染侧上限 12 → **30**（并**如实报出被省略的节数**）。
    //   原先 12 与生成侧的 12 **两处各写一遍同一口径**（本批反复批判的形态），且现场已有 21 节的真实文件
    //   ⇒ 两处都会漏。现：生成侧不截断（信息入库不丢）、渲染侧 30（有界且够用），
    //   若真超过 30 则**明说"另有 N 节未列出"**，绝不静默截断（与全仓"不许静默丢"一致）。
    const SEC_CAP = 30;
    if (secs.length) {
      const shown = secs.slice(0, SEC_CAP);
      const more = secs.length - shown.length;
      L.push("  分节表（优先把 ★ 整节搬到 knowledge/）：" + shown.map((s) => (s.preferExtract ? "★" : "") + String(s.title || "?") + " " + (Number(s.chars) || 0) + "字").join(" ｜ ")
        + (more > 0 ? " ｜ …**另有 " + more + " 节未列出**（超出渲染上限 " + SEC_CAP + "；如需全部请直接读该文件）" : ""));
    }
    L.push("  下沉目标：knowledge/MEMORY-" + String(k.replace(/^projects\//, "").replace(/\.md$/, "")) + "-<主题>.md；主文件留一行指针（## 明细已下沉 → <该路径>）；**指针与目标文件必须同一次 memory_dream_patch 提交**");
  }
  L.push("（本块口径由插件机器计算：照它下沉即可，**不要自行估算字符数**）\n");
  return L.join("\n");
}
export { renderOverLimitHint };
// v2.8.4（A 配套）：**模块级**分节表（`## ` 切节 → 字符数）。为什么不用现成的 `charSectionBreakdown`：
//   踩过的坑 —— 它是 apply 内的闭包函数，模块级调用会 `is not defined`（本批已因 `dateStr` 栽过一次）。
function sectionTableOf(text, maxRows) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (/^##\s/.test(line)) out.push({ title: line.trim(), chars: 0 });
    else if (out.length) out[out.length - 1].chars += line.length + 1;
  }
  return out.slice(0, Number(maxRows) > 0 ? Number(maxRows) : 15);
}
export { sectionTableOf };
export { sinkOverLimitFile };
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
// v2.8.4（机械下沉）：**优先搬走**的节族 —— 与 `memory_size_preview` 的 `preferExtract` 判定式**同源**
//   （那里是 `/^##\s*(归档|漏网会话补档)/`）⇒ 两处口径一致，避免"预览说要沉这节、下沉却搬了别的节"。
const SINK_PREFER_RE = /^##\s*(归档|漏网会话补档)/;

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

// v2.6.2（工作空间自动建档，用户 2026-09-14 拍板）：顶层会话 cwd 未命中任何项目 → 自动补建项目记忆。
//   ① projects/<目录名>.md 缺失 → 写最小骨架（标题+五标准节，dream 整合/漏网归档/「## 归档」锚点直接兼容）
//   ② _index.json：同名条目已存在 → 只补 workdirs/root（stale 复位；改名条目 file≠目录名时登记进原条目、不新建文件防双条目打架）；
//      不存在 → 新条目 {key/display/file, workdirs:[cwd], root, aliases:[]}
//   ③ 种 ~dsh/project.json 标记（seedProjectMarker 幂等）→ 下轮起 matchProjectByCwd 正常命中注入
//   护栏：isDeepEnoughRoot（≥4 段）+ ONE_DRIVE_CONFLICT_RE + `_` 前缀目录名（索引扫描排除段）跳过；
//   已命中（hits/staleHits 非空）或标记已存在（markerKey/markerStale/markerBad）→ 不动作（防与 reconcile 改名线索打架，失效交巡检报告）。
//   返回 { acted, created, registered, seeded, key, file, reason }；全程 try/catch 不抛（失败不阻塞注入主链路）。
function ensureProjectForCwd(cwd) {
  const res = { acted: false, created: false, registered: false, seeded: false, key: "", file: "", reason: "" };
  try {
    const root = portable(String(cwd || "")).replace(/\/+$/, "");
    if (!root) { res.reason = "no-cwd"; return res; }
    if (!isDeepEnoughRoot(root)) { res.reason = "shallow-root"; return res; }
    if (ONE_DRIVE_CONFLICT_RE.test(root)) { res.reason = "conflict-dir"; return res; }
    const name = root.split("/").filter(Boolean).pop() || "";
    if (!name || /^_/.test(name) || ONE_DRIVE_CONFLICT_RE.test(name)) { res.reason = "bad-name"; return res; }
    const mp = matchProjectByCwd(root);
    if (mp.hits.length > 0 || (mp.staleHits && mp.staleHits.length > 0)) { res.reason = "already-hit"; return res; }
    if (mp.marker && (mp.marker.markerKey || mp.marker.markerStale || mp.marker.markerBad)) { res.reason = "marker-present"; return res; }
    const file = name + ".md";
    const idx = readProjectIndex();
    const pr = (idx.projects || []).find((p) => p.key === name);
    if (pr && pr.file !== file) {
      // 同名条目但文件已改名：登记 cwd 进原条目 + 按原 file 种标记，不新建文件（防双条目打架）
      registerCwdIntoEntry(pr, root);
      writeProjectIndex(idx);
      const sm = seedProjectMarker(root, pr.key, pr.file);
      res.registered = true; res.seeded = !!(sm && sm.ok);
      res.key = pr.key; res.file = pr.file; res.reason = "renamed-entry"; res.acted = true;
      return res;
    }
    const full = portable(MEMORY_ROOT + "/projects/" + file);
    if (!fs.existsSync(full)) {
      const sk = "# " + name + "\n\n> " + dayStrLocal(new Date()) + " 自动建档（dsh-memory：工作空间首次会话创建；dream 整合/漏网归档按节写入）\n\n## Rules\n\n## Architecture decisions\n\n## Patterns\n\n## Gotchas\n\n## Discovered durable knowledge\n";
      const wr = writeFileAtomic(full, sk, { tag: "projboot", verify: true });
      if (!wr || !wr.ok || wr.readbackOk === false) { res.reason = "write-fail"; return res; }
      res.created = true;
    }
    if (pr) registerCwdIntoEntry(pr, root);
    else idx.projects.push({ key: name, display: name, file: file, workdirs: [root], updatedAt: Date.now(), root: root, aliases: [] });
    writeProjectIndex(idx);
    res.registered = true;
    const sm2 = seedProjectMarker(root, name, file);
    res.seeded = !!(sm2 && sm2.ok);
    res.key = name; res.file = file;
    res.acted = res.created || res.registered || res.seeded;
    return res;
  } catch (e) { res.reason = "error:" + (e && e.message ? e.message : String(e)); return res; }
}
function registerCwdIntoEntry(pr, root) {   // v2.6.2：cwd 补登记（normCwd 口径去重；root 缺才补；stale 复位）
  const wds = Array.isArray(pr.workdirs) ? pr.workdirs : [];
  const nr = normCwd(root);
  if (!wds.some((w) => normCwd(w) === nr)) wds.push(root);
  pr.workdirs = wds;
  if (!pr.root) pr.root = root;
  if (pr.stale) delete pr.stale;
  pr.updatedAt = Date.now();
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
// v2.6.7（W2）：近限「按变化报」的内存冷却表（每 rel 10 分钟；水位账本持久化在 .integrate.json）
const NEAR_HARD_TOLD = new Map();
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
    // v2.8.4（P18/自动归档包⑤）：自动归档一行 —— 「跑没跑 + 为什么 + 上轮内容见证」放到运行状况里。
    //   为什么必须有读者：账本里写了证据但没人读 = 等于没写（红队口径：**不可观测的自动化不许上线**）。
    try { if (typeof __archiveSignalLine === "function") sumLines.push(__archiveSignalLine()); } catch (e) {}
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
    // [2026-09-23 dsh 0.1.7 适配] scope 通道退役：统计改走 LIVE_STATS，随 /dsh-memory/stats.json 下发（设置页 fetch 显示）
    {
      // v2.3.1：日志只输出变动行（sLog）；无任何量变动 → 静默不打印
      let didLog = false;  // v1.12.9：本次是否打了内容日志（成功回执与之同条件）
      const logSig = sLog !== null ? sLog.split("\n").filter((l) => l.indexOf("累计") !== 0).join(" ⏎ ") : "";
      if (sLog !== null && logSig !== MONITOR_LAST_LOG_SIG) {
        MONITOR_LAST_LOG_SIG = logSig;
        didLog = true;
        clog("[dsh-memory] 推送监控汇总:\n" + sLog);
      }
      LIVE_STATS.monitorSummary = s;
      if (didLog) clog("[dsh-memory] 监控汇总已更新（随 stats.json 下发）");  // v1.12.9：静默推送完全无声
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

// ═══ v3.2.0（2026-10-02 Wave 0）：闸门决策留痕 recordGate ═══
//   每次"命中后过闸"都留一条：reason=ok（放行）/batch（批量进展豁免）/cooldown（冷却）/off（spiralRemind 关闭）。
//   ★ 为什么必须落盘：2026-10-01 事故里 D 类 7 次命中全部无投递，而插件**不记录闸门结果** ⇒
//     只能靠"排除冷却 ⇒ 只剩 batchLike"反推（红队 03 §1.3）。没有这个字段，同类问题下次仍不可归因。
//   ★ 体积纪律：W 的闸门每个工具步都会评估，逐条落盘会把 300 条上限顶穿 ⇒ **段合并**：
//     同一 (sid,cls,reason) 10 分钟内重复决策就地累加 n（不追加条目）。实测拦截 ~7 次/58h，合并后日均 <20 条。
const GATE_SEG_MS = 10 * 60000;
const GATE_SEG = new Map();              // "sid|cls|reason" -> gateEvents 条目引用（内存态，重启即空）
function recordGate(cls, reason, sid, extra) {
  try {
    if (PLUGIN_CFG.monitorEnabled === false) return;
    const d = readMonitorData();
    if (!Array.isArray(d.gateEvents)) d.gateEvents = [];
    const now = Date.now();
    const key = String(sid || "?") + "|" + cls + "|" + reason;
    const prev = GATE_SEG.get(key);
    if (prev && (now - prev.t) < GATE_SEG_MS && d.gateEvents.indexOf(prev) >= 0) {
      prev.n = (prev.n || 1) + 1;        // 段合并：同段内只累加计数
      prev.t = now;
      if (extra) for (const k of Object.keys(extra)) prev[k] = extra[k];
      d.updatedAt = now;
      scheduleMonitorSave();
      return;
    }
    const e = Object.assign({ t: now, n: 1, cls: cls, reason: reason }, extra || {});
    d.gateEvents.push(e);
    if (d.gateEvents.length > 300) d.gateEvents = d.gateEvents.slice(-300);   // 滚动 300（旧引用失效由 indexOf 兜住）
    GATE_SEG.set(key, e);
    d.updatedAt = now;
    scheduleMonitorSave();
  } catch (e) { /* 埋点失败绝不影响主功能 */ }
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
        const se = SPIRAL_REMIND_E_AT.get(sid);   // v3.2.0: E 桶独立，同样「奏效即复位」
        if (se) { se.streak = 0; SPIRAL_REMIND_E_AT.set(sid, se); }
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
// v3.2.0（2026-10-02 Wave 1）：**阈值世代快照 threshEpoch()** —— 写进每条阈值变更日志，
//   供日后"只看同世代样本"做校准（红队 03 阶段2 靶5：旧日志只有 from→to，无法判断样本是否跨世代；
//   且 E 相关字段 sameMinSecs/sameHomo 必须一起进快照，否则动 E 会立刻污染校准面）。
function threshEpoch() {
  const e = effectiveSpiralThresh();
  return { rep: e.rep, neg: e.neg, sim: e.sim, w: e.w, cooldownMin: e.cooldownMin,
    sameNeg: e.sameNeg, sameSteps: e.sameSteps, sameMinSecs: e.sameMinSecs, sameHomo: e.sameHomo,
    watchSteps: e.watchSteps, watchSecs: e.watchSecs, watchCooldownMin: e.watchCooldownMin,
    brkSameN: e.brkSameN, brkMaxDeny: e.brkMaxDeny, brkMinSteps: e.brkMinSteps };
}

// ═══ v3.2.0（2026-10-02 Wave 1）：阈值**一次性事故回调** ═══
//   事故：D 类阈值被 /dream 自校准单向上棘轮推到硬上限 rep=0.80（`spiralThreshLog` 17 条里 6 条同一理由），
//     此后 D 自 2026-09-29 13:33 起再无投递（红队 03 阶段1 实证）。
//   依据（Lead 独立复算，97 条 D 样本按 k=round(repRate·winLen) 还原后）：rep 0.80 保留 63/97，
//     而 **0.75 = 0.70 = 0.65 = 94/97**（同属 k≥6 格点）⇒ 只需一步 0.80→0.75 就拿回全部灵敏度，
//     且这一步正好**跨格点**（k≥7→k≥6），满足"单轮 ≤0.05 且必须跨格点"的防抖约束。
//   一次性：由 `md.threshMigr.rep075` 记账（-1 = 判定过且无需迁移）；用户日后手动改回 0.80 不会被再次覆盖。
function applyThresholdMigrations() {
  try {
    const md = readMonitorData();
    if (!md.threshMigr || typeof md.threshMigr !== "object") md.threshMigr = {};
    if (md.threshMigr.rep075) return;
    const cur = effectiveSpiralThresh();
    if (!(cur.rep > 0.75)) { md.threshMigr.rep075 = -1; return; }   // 已是 ≤0.75（或用户自带配置）→ 不动
    md.spiralThresh = Object.assign({}, (md.spiralThresh || {}), { rep: 0.75 });
    if (!Array.isArray(md.spiralThreshLog)) md.spiralThreshLog = [];
    md.spiralThreshLog.push({ t: Date.now(), from: { rep: cur.rep }, to: { rep: 0.75 }, dir: "sens",
      reason: "事故回调（v3.2.0 一次性迁移，人工）：rep 被自校准棘轮到上限 0.80 后 D 类自 09-29 13:33 静默；复算 97 条样本 0.75=94/97 而 0.80=63/97，且 0.75/0.70/0.65 保留数相同",
      ep: threshEpoch() });
    if (md.spiralThreshLog.length > 20) md.spiralThreshLog = md.spiralThreshLog.slice(-20);
    md.threshMigr.rep075 = Date.now();
    scheduleMonitorSave();
    clog("[dsh-memory] 阈值一次性迁移：rep " + cur.rep + "→0.75（事故回调；仅执行一次，记账 threshMigr.rep075）");
  } catch (e) { /* 迁移失败绝不阻塞启动 */ }
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
// [dream-visible 20260930] 本轮手动 dream 是否已用「唤醒」投递过发起行——同步段即时回执先占位（见 runDreamPipeline），
//   之后 spawnIntegrate 发出的 running patch 就不再重复唤醒（避免开两个回合），只按原样落表。
//   自动/定期整合传的 agentForParent 是 null ⇒ DREAM_LISTENER 为空，本标记恒 false，不受影响。
let DREAM_WOKE = false;
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
      brk: { suspectKeys: new Set(), denyN: 0, fullStop: false, seq: 0, seqKey: "", lastRFp: "" } };
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
function spiralObserve(toolName, args, result, isError, sid, callId) {
  // v2.4.30（E 类）：返回布尔 → { d, e }——D/E 并列计算再统一返回（架构评审 P0：旧实现 D 命中提前 return 会吞掉 E 判定）
  try {
    if (PLUGIN_CFG.monitorEnabled === false || SPIRAL_SKIP.has(toolName)) return { d: false, e: false, rep: 0, neg: 0, win: 0, eN: 0 };
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
    // ═══ v3.2.0（2026-10-02 Wave 1）候选0：折叠「一次逻辑调用被观测两次」═══
    //   实证（红队 03 §1.3.1，两窗逐字复现）：一次 run_code 会先产生**内层** ptc 调用观测、再产生**外壳** run_code 观测
    //   ⇒ 同一次失败被双计 neg；两侧结果文本略有差异又让 uniq 虚增 ⇒ batchLike 把"打转"读成"批量进展"并静默。
    //   折叠规则（宿主约定 subCallId = `${rootCallId}:ptc:${n}`）：含 ":ptc:" 的是内层，正常入窗并记 rootId；
    //   外壳（其 callId 恰为窗内某内层条目的 rootId）**整条跳过**——不入窗、不计 calls/neg，避免同一逻辑步计两次。
    //   关闭方式：PLUGIN_CFG.spiralFoldPtc=false（回退旧口径做对照）。
    const cid = String(callId || "");
    const pIdx = cid.indexOf(":ptc:");
    const isInner = pIdx > 0;
    const rootId = isInner ? cid.slice(0, pIdx) : cid;
    if (PLUGIN_CFG.spiralFoldPtc !== false && cid && !isInner) {
      const folded = B.win.some((w) => w && w.rootId === cid && w.sub === true);
      if (folded) return { d: false, e: false, rep: 0, neg: 0, win: B.win.length, eN: 0, folded: true };
    }
    B.win.push({ argsTxt: aTxt, resKey: rTxt.slice(0, 80), resKeyFp: resultFingerprint(rTxt), neg: neg ? 1 : 0, rep, tool: toolName, sim: Math.round(stepSim * 100) / 100, ts: Date.now(), rootId: rootId || "", sub: isInner });
    if (B.win.length > ET.w) B.win.shift();
    if (!B.cur) B.cur = { t0: Date.now(), calls: 0, negN: 0, errN: 0, spiralN: 0, spiralE: 0, tools: {}, sims: [] };   // v2.2.8: sims 累积步间相似度；v2.4.30 加 spiralE
    B.cur.calls += 1;
    B.cur.tools[toolName] = (B.cur.tools[toolName] || 0) + 1;   // v1.12.16.1 周期工具分布
    B.cur.sims.push(stepSim);   // v2.2.8: 相似度序列供周期结算分位
    if (neg) B.cur.negN += 1;
    if (isError) B.cur.errN += 1;
    let dHit = false, eHit = false;
    // v3.2.0（Wave 0）：把命中判据原样带回调用点——recordGate 需要真值，禁止调用点重算（重算=另一种口径漂移）。
    let retRep = 0, retNeg = 0, retEN = 0;
    if (B.win.length >= 5) {
      const n = B.win.length;
      const repRate = B.win.reduce((s2, w2) => s2 + w2.rep, 0) / n;
      const negRate = B.win.reduce((s2, w2) => s2 + w2.neg, 0) / n;
      retRep = Math.round(repRate * 100) / 100;
      retNeg = Math.round(negRate * 100) / 100;
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
        retEN = cluster.length;   // v3.2.0：E 提醒文案要用**簇长**（旧实现误用窗长，见调用点修复）
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
    return { d: dHit, e: eHit, rep: retRep, neg: retNeg, win: B.win.length, eN: retEN };
  } catch (e) { /* 探针失败不影响会话 */ }
  return { d: false, e: false, rep: 0, neg: 0, win: 0, eN: 0 };
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
    // 无用户穿插检查（[2026-09-23 修根因]）
    //   原实现把本闸放在 seq 计数**之前** → 单回合内前 brkMinSteps 步完全不观测，seq 恒停在 1，
    //   永远解不开 brkSameN=3 ⇒ suspectKeys 恒空、D2/D3 长期不触发（监控"熔断动作 0"的真因）。
    //   现改为**只 gate 最后的 add**：seq 照常累计（纯内存计数，无副作用），
    //   只在「连续重复已达标 且 确无用户穿插」时才武装 suspect —— 语义与设计注释一致，不降低误伤门槛。
    const noUserInterleave = (B.stepsSinceUser || 0) >= brkMinSteps;
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
    // 达阈值 且 无用户穿插 → 进 suspect（门槛只在武装这一步生效，见上）
    if (B.brk.seq >= brkSameN && noUserInterleave) {
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
          const sdir = path.join(SESSIONS_ROOT, ws.name, s.name);
          // v2.8.4（P21）：取**全部**同目录日志（双名目录旧实现整类看不见后者，实测 7 个目录命中）
          const zs = resolveSessionLogPaths(sdir);
          if (!zs.length) { probeUnknownLogNames(sdir); continue; }   // v2.6.5: 未识别名顺带采集（供自检提示）
          let st;
          try {
            // P21：`mtime` 取**最大**（= 最后交互，启用界限判定必须用它），`size` 取**和**（= 会话真实体量）。
            //   旧实现只看 v3 一个文件 ⇒ 双名会话的 mtime 可能取到更早的那个、size 少算一半以上。
            let mtimeMs = 0, size = 0;
            for (const zp of zs) { const s1 = fs.statSync(zp); if (s1.mtimeMs > mtimeMs) mtimeMs = s1.mtimeMs; size += s1.size; }
            st = { mtimeMs: mtimeMs, size: size };
          } catch (e) { continue; }
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
// 解压会话日志（session.jsonl.zstd 或新版 session.v3.jsonl.zstd，node:zlib zstd），找 compaction/summary 事件，返回摘要文本（截断防超长）。
// 子代理只读这个摘要（几千 token），不再读原始大日志（几十 MB → 数百万 token）。
// 批0（P0-4）账本上限**单源**——保存路径（saveStaleNotified）与"写盘前合并路径"（writeIntegrateState）
//   曾各自硬编码同一个上限 300；两处一起把最旧会话挤掉（盘上 1065 会话、账本实测 280/300 即将顶格），
//   顶格后最旧 id 静默丢失 ⇒ 重复归档或漏档。裁剪必要（防状态文件无限增长），但必须**同源 + 留痕**。
const LEDGER_CAP = 5000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// v2.8.4（P12）：**提取口径版本号**。改 KEEP 集合／装配规则／截断策略时必须 +1。
//   动机：单元缓存原只按「帧数单调」判陈旧（L3354 `d.frames > curFrames`），**改口径后旧单元会被
//   当成有效产物复用** ⇒ 新口径永不生效、且 `mergeUnitCache` 会把旧内容并进新单元。
//   加了它之后 `readUnitCache` 直接拒旧 ⇒ 口径变更自动全量重算。
const EXTRACT_COUNTER_VER = 2;   // v2.8.4 = 2（v1 = 1：无 counterVer 时代）
// ═══════ v2.8.4（P14/P15）：提取的**时间预算** + **已消费帧数** ═══════
//   为什么必须有（P14 的因果）：旧码把水位写成 `countZstdFrames`（**文件总帧数**）。只要提取被任何原因截断
//     （墙钟超时 / 异常 / 未来加的任何上限），水位就等于"已全部消费" ⇒ `archivePendingEntry` 恒 false
//     ⇒ 剩余帧**永远不再被提取**，而且**完全不可观测**（账本看起来是正常的）。
//   现状（P15）：单会话预算 = `max(8000, 400×sizeMiB)` ms —— 实测全库原始解码 ≈0.168 s/MiB（120.8 s / 718 MiB）
//     即约 2.4× 余量；整轮预算 ≈90 s，**跨会话共享**（`L6809` 注释记过旧路径顶住会话启动 6 分 14 秒的事故）。
const ROUND_EXTRACT_BUDGET_MS = 90000;
function sessionExtractBudgetMs(sizeBytes) {
  const sizeMiB = (Number(sizeBytes) || 0) / 1048576;
  return Math.max(8000, 400 * sizeMiB);
}
// ═══════ v2.8.4（P4 第三保险）：装配期**运行时断言** ═══════
//   为什么必须有（BUG-2 的实测教训）：装配链曾写成 `arr.map(p => p.s).join("\n")`，而元素是 `{si,frame,kind,body}`
//   ⇒ `p.s` 全是 `undefined` ⇒ `Array.prototype.join` 把 `undefined` **静默渲染成空串** ⇒ 产物**只剩分隔符**
//   （实测 `60e0713f` 9.06 MiB 会话的单元 `chars = 17` = 17 个换行）。这类错误**不抛、不 warn、看起来成功**，
//   只有"产物里除分隔符外什么都没有"这一个表征 ⇒ 必须在**装配那一刻**把它钉死。
//   本函数是 P4 的第三道保险（① `markers` 与件分装 ② 守卫按**内容**判空 ③ **本断言**）：
//   任何元素不是**非空字符串**、或传进来的不是数组，一律**抛错**（宁可让调用方炸，也不产出半句话都没有的单元）。
function joinPartsStrict(parts, tag) {
  const t = tag || "(assembly)";
  if (!Array.isArray(parts)) throw new Error("[dsh-memory] joinPartsStrict: " + t + " 收到非数组（" + typeof parts + "）");
  if (parts.length === 0) throw new Error("[dsh-memory] joinPartsStrict: " + t + " 收到空数组");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p !== "string") throw new Error("[dsh-memory] joinPartsStrict: " + t + " 第 " + i + " 件不是字符串（" + (p === null ? "null" : typeof p) + "）");
    if (!p.trim()) throw new Error("[dsh-memory] joinPartsStrict: " + t + " 第 " + i + " 件为空白串（装配链出现空件 ⇒ 疑似 map 取错字段）");
  }
  return parts.join("\n");
}
// v2.8.4（P13）：**候选旁路**。原候选过滤 = `archivePendingEntry(s) && !sessionMentionedInMemory(s.id)`，
//   两道闸串行：①水位（`cur > wm.frames`）②**已提及**（归档会把 `### <sid12>` 写进 sessions/*.md）。
//   ⚠ **注释更正（§9.11.4-8，2026-09-19 取证）**：原文此处写"**凡内容落过盘的会话永远进不了候选**"，**与事实相反**。
//     现场实测：`sessionMentionedInMemory` 原口径（完整 id / 去前缀完整 id）**匹配不到 `### <sid12>` 块头**
//     ⇒ 289 个已归档会话里**只有 4 个命中（1.4%）** ⇒ 第二道闸**基本不生效**，真正把关的一直是第①道。
//     同轮取证还确认：首次归档**0 重复**、`·补N` 多块之间**内容 0 重叠**（是正常增量补档，不是重复归档）。
//   ⇒ 本文件已做两件事：①**补上 12 位短 id 判据**（命中率 → 145/289）；②把它的用途**限定为"首次归档"去重**
//     （补档路径不参与 —— 否则 `·补N` 会被它挡死）。旁路（counterVer）仍保留原用途：修提取口径后重算存量单元。
function unitCounterVerMismatch(sid, opts) {
  try {
    const fsz = (opts && opts.fs) || fs;
    const root = (opts && opts.root) || MEMORY_ROOT;
    const p = String(root).replace(/\\/g, "/") + "/.archive-units/" + sid + ".json";
    const d = JSON.parse(fsz.readFileSync(p, "utf8"));
    return Number(d && d.counterVer) !== EXTRACT_COUNTER_VER;   // 缓存缺失（抛错）⇒ 下面的 catch 也返回 true
  } catch (e) { return true; }                                  // 缺失 ⇒ 视为不匹配（要求重算）
}
function shouldReArchive(s, opts) {
  const o = opts || {};
  // ★ 旁路**默认关闭**。行为验证（2026-09-18）发现：存量单元全无 counterVer ⇒ 若默认开启，
  //   首跑会把全部 280 个会话判为需重档，每个都会拉起归档子代理 ⇒ **token 大爆炸**
  //   （插件设 ARCHIVE_MAX_CONCURRENT=5 正是防这个）。故改为**显式开启**（/dream 或 --rearchive）。
  if (o.rearchiveOnMismatch && unitCounterVerMismatch(s.id, o)) return true;
  // v2.8.4（P15）**未完成续跑**：本轮提取被墙钟掐断 ⇒ 账本留 `incomplete` 标记 ⇒ 无条件重入。
  //   为什么必须放在**这里**（而不是靠 P13 的 counterVer 旁路）：`incomplete` 是 P15「超时不丢，下轮从该帧
  //   续跑」这一保证的**唯一实现路径** —— 被掐断的会话已经落过盘 ⇒ `sessionMentionedInMemory` 恒 true
  //   ⇒ 第二道闸恒拦；若不在此放行，"续跑"永远只是注释。
  //   为什么它**不**带来 token 爆炸风险（与 counterVer 旁路的关键区别）：`incomplete` 是**自清除**的
  //   （本轮完整归档即写回 false）且**只会因本轮真被掐断而置位** ⇒ 存量 280 个会话一个都不会被它命中，
  //   且单轮重入数天然受 `MAX_ARCHIVE_SESSIONS=32` 与整轮 90 s 预算夹紧。
  const wmv = ARCHIVE_WATERMARK.get(s.id);
  if (wmv && wmv.incomplete === true) return true;
  // ★★ 修正十三（**红队 rev8h B 实测**）：**"按水位跳过"必须真重试** —— 否则修正十一只是把
  //   "消号后永久漏档"换成了"不消号但**永久静默挂起**"：红队实测 `archivePendingEntry` 因水位虚高
  //   （`cur == wm.frames`）恒假 ⇒ 永不重选，而 `incomplete` 未置、counterVer 旁路默认关 ⇒ 三条路全 false。
  //   凭据由落盘段写（`wmSkip` + `wmSkipRounds`）；**有限次**：到上限即不再重选（改由落盘段的 `cwarn`
  //   升级为**人工告警**）⇒ 既不无限烧轮、也不静默。
  if (wmv && wmv.wmSkip === true && (Number(wmv.wmSkipRounds) || 0) < WM_SKIP_MAX_ROUNDS) return true;
  // ★★ §9.11.4-8（**现场取证驱动**）：最后这道闸的**用途限定**与**注释更正**。
  //   【注释更正】原文写"凡内容落过盘的会话永远进不了候选"—— **与事实相反**（现场取证：原口径命中率仅
  //     1.4%，即 285/289 的已归档会话**照样**会被它放行；首次归档 0 重复、`·补N` 内容 0 重叠也印证了
  //     "真正把关的是第一道闸 `archivePendingEntry`（水位比较）"）。
  //   【用途限定】`sessionMentionedInMemory` **不得当补档闸**：`·补N` 是正常特性（续聊增量重档，内容不重叠），
  //     若对补档也生效 ⇒ **续聊永不补档**。⇒ 它只在"**首次归档**"时参与去重：
  //       首次 = 水位 `round <= 1`（或没有水位条目）。补档（`round >= 2`）时**跳过该判断**，只看水位。
  const round0 = wmv ? (Number(wmv.round) || 1) : 1;
  const isFirstArchive = round0 <= 1;
  if (!isFirstArchive) return archivePendingEntry(s);          // 补档路径：只认水位（不认"提及"）
  return archivePendingEntry(s) && !sessionMentionedInMemory(s.id);
}
// 旁路开关的**唯一读点**（三个候选调用点共用，避免三处各写一份开关判定）：
//   ① 环境变量 `DSH_MEMORY_REARCHIVE=1`（重启前设置即可，不需要改配置模式）
//   ② 配置键 `rearchiveOnMismatch: true`（若 normalizeCfg 保留该键）
function reArchiveOpts() {
  return {
    rearchiveOnMismatch: (typeof process !== "undefined" && process.env && process.env.DSH_MEMORY_REARCHIVE === "1") ||
      !!(PLUGIN_CFG && PLUGIN_CFG.rearchiveOnMismatch),
  };
}
const MAX_REARCHIVE_PER_ROUND = 40;   // 单轮重档上限（与 MAX_ARCHIVE_SESSIONS 同量级；分多轮排空）
// 候选选取（推荐调用点用这个而不是裸 filter）：默认行为与旧版**逐字一致**；开启旁路时
//   ①先收"正常重入"的 ②再把口径不符的按**受损程度**（单元字符最少者优先）**截断到上限**。
// ═══ §9.12②（用户「都搞」）：**跳过判定的两把机器尺** ═══
//   动机：`skip=true` 的含义是"这个会话的内容**不进记忆库**"，而此前的唯一约束是"给个理由"——理由是自由文本，
//   机器判不了真假（实测 2026-09-18 那轮 5 个会话共约 5.4 万字符被声明跳过）。用户最怕的正是"内容没计入"，
//   所以真正的保证不该是"请写理由"，而应当是**"跳过 ⇒ 正文仍可恢复"**（§9.12① 那条单元检索通道就是这条路）。
//   ① `readArchiveUnitForSkip`：**可恢复 = 单元存在且 `chars>0`**；★ 但**它不再决定放行/拒**（见下）——它只回答
//      "这次跳过之后，正文还有没有副本可捞"，答案连同原因（`unitWhy`）一起进见证；
//   ② `unitIndexedInSearchCache`：**软记录**（不是硬闸）—— 只如实记下"写这批时它是否已在检索缓存里"，
//      因为检索路径本身会按需增量重建单元索引（§9.12①）⇒"此刻没索引"≠"搜不到"。
const ARCHIVE_UNITS_DIR = MEMORY_ROOT + "/.archive-units";
const SEARCH_CACHE_UNITS_DIR = DSH_HOME + "/session-text/_units";
function readArchiveUnitForSkip(sid) {
  const s = String(sid || "").trim();
  if (!s) return { ok: false, why: "sid-empty" };
  // ★ 根因席 C（2026-09-19）：**写方用 12 位、读方却按 8 位**——同一处口径分裂。现在两边同走 `unitSid`（唯一所有者），
  //   精确匹配在前；前缀兜底仅用于**命名口径不同的存量单元**，且命中多个时**先按 `d.sid` 精确挑一个**，
  //   不再直接判"前缀命中多个 ⇒ 无法确定依据"（那是一条**硬拒死路**：legacy 与 v3 单元并存时必然触发）。
  const key = unitSid(s);
  const dir = portable(ARCHIVE_UNITS_DIR);
  let file = null, viaPrefix = false;
  try {
    const exact = key + ".json";
    if (fs.existsSync(dir + "/" + exact)) file = exact;
    else {
      const pref = key.slice(0, 8);
      const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f.startsWith(pref) && f !== exact);
      if (hits.length === 1) { file = hits[0]; viaPrefix = true; }
      else if (hits.length > 1) {
        const same = hits.filter((f) => {
          try { const d = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); return unitSid(d && d.sid) === key; } catch (e) { return false; }
        });
        if (same.length === 1) { file = same[0]; viaPrefix = true; }
        else return { ok: false, why: "unit-multi-hit: 前缀 " + pref + " 命中 " + hits.length + " 个候选，且 d.sid 无法唯一定位请求的 " + key };
      }
    }
  } catch (e) { return { ok: false, why: "unit-dir-unreadable: " + ARCHIVE_UNITS_DIR }; }
  if (!file) return { ok: false, why: "no-unit-file: .archive-units/" + key + ".json 不存在" };
  try {
    const d = JSON.parse(fs.readFileSync(dir + "/" + file, "utf8"));
    const ch = Number(d && d.chars) || String((d && d.text) || "").length;
    if (!(ch > 0)) return { ok: false, why: "unit-empty: " + file + " 为空（chars=0）" };
    // 评审整改（红队 R-3 + 根因席 C）：**"有单元"必须真是这个会话的单元**，且比较口径与文件名一致（**精确**，不再只比 8 位）。
    const declared = unitSid(d && d.sid);
    if (declared && declared !== key) {
      return { ok: false, why: "unit-sid-mismatch: " + file + " 的 sid 字段（" + declared + "）≠ 请求（" + key + "）" };
    }
    return { ok: true, file: file, chars: ch, counterVer: Number(d && d.counterVer) || 0, truncated: d && d.truncated === true, sampled: d && d.sampled === true, viaPrefix: viaPrefix };
  } catch (e) { return { ok: false, why: "unit-unreadable: " + file }; }
}
function unitIndexedInSearchCache(sid) {
  const pref = unitSid(sid).slice(0, 8);   // 检索缓存是**另一套**命名（CLI 侧按 8 位分目录，见 CLI 的 `normSid`）⇒ 这里显式取 8 位
  if (!pref) return false;
  try {
    const root = portable(SEARCH_CACHE_UNITS_DIR);
    for (const day of fs.readdirSync(root)) {
      const p = root + "/" + day + "/" + pref;
      if (fs.existsSync(p + "/manifest.json")) {
        const m = JSON.parse(fs.readFileSync(p + "/manifest.json", "utf8"));
        if (m && Array.isArray(m.segs) && m.segs.length) return true;
      }
    }
  } catch (e) { return false; }
  return false;
}
export { readArchiveUnitForSkip, unitIndexedInSearchCache };

function unitCharsOf(sid, opts) {  try {
    const fsz = (opts && opts.fs) || fs;
    const root = (opts && opts.root) || MEMORY_ROOT;
    const d = JSON.parse(fsz.readFileSync(String(root).replace(/\\/g, "/") + "/.archive-units/" + sid + ".json", "utf8"));
    return Number(d && d.chars) || 0;
  } catch (e) { return -1; }        // 缺失 ⇒ 最优先（-1 排最前）
}
// v2.8.4（损伤代理替换）：单元**实际被丢内容量** —— `dropped`（机制层丢弃，含 `(merge-overflow)`）各 kind 的
//   `chars` 之和 + `truncs`（截断，`raw−kept`）之和。为什么不用 `chars`：所有单元都被 `UNIT_MAX_CHARS` 封顶 ⇒
//   `chars` 升序在受损单元之间**失去分辨力**（见 `pickReArchiveCandidates` 内注释）。
//   返回 `missing:true, damage:-1` 表示缓存缺失/不可读（无元数据 ⇒ 排最前，最需要重算）。
function unitDamageOf(sid, opts) {
  try {
    const fsz = (opts && opts.fs) || fs;
    const root = (opts && opts.root) || MEMORY_ROOT;
    const d = JSON.parse(fsz.readFileSync(String(root).replace(/\\/g, "/") + "/.archive-units/" + sid + ".json", "utf8"));
    let droppedChars = 0;
    if (d && d.dropped && typeof d.dropped === "object") {
      for (const k of Object.keys(d.dropped)) droppedChars += Number((d.dropped[k] || {}).chars) || 0;
    }
    let truncChars = 0;
    if (d && Array.isArray(d.truncs)) {
      for (const t of d.truncs) {
        const raw = Number(t && t.raw), kept = Number(t && t.kept);
        // 缺任一字段 ⇒ **跳过该条**（不凭残缺数据编造丢失量；生产端三处 `truncs.push` 都同时写 raw/kept）
        if (!Number.isFinite(raw) || !Number.isFinite(kept)) continue;
        truncChars += Math.max(0, raw - kept);
      }
    }
    return { chars: Number(d && d.chars) || 0, droppedChars: droppedChars, truncChars: truncChars, damage: droppedChars + truncChars, missing: false };
  } catch (e) { return { chars: 0, droppedChars: 0, truncChars: 0, damage: -1, missing: true }; }
}
function pickReArchiveCandidates(list, opts) {
  const o = opts || {};
  // 「正常重入」= 两道闸（水位 + 未提及）**外加** P15 的 `incomplete` 续跑（它有界、自清除，与 counterVer 旁路不同类）。
  const normal = list.filter((s) => {
    const wmv = ARCHIVE_WATERMARK.get(s.id);
    if (wmv && wmv.incomplete === true) return true;
    return archivePendingEntry(s) && !sessionMentionedInMemory(s.id);
  });
  if (!o.rearchiveOnMismatch) return normal;
  const cap = Number.isFinite(o.cap) ? o.cap : MAX_REARCHIVE_PER_ROUND;
  const stale = list
    .filter((s) => normal.indexOf(s) < 0 && unitCounterVerMismatch(s.id, o))
    // v2.8.4（损伤代理替换，用户 2026-09-18「全部做完」项）：旧排序键 = `unitCharsOf`（单元字符数**升序**，
    //   假设"单元越小越受损"）。该假设在 P16/§8.6 之后**已经不成立**：所有单元的 `chars` 都被
    //   `UNIT_MAX_CHARS` 封顶 ⇒ 大量受损单元 chars 全等于 20000，**排序退化成无意义**（实测：cap=40 时
    //   真正被吃掉的会话可能排在 40 名之外，等于旁路开了也救不回来）。
    //   新键 = **实际被丢内容量**（`dropped` 各 kind 的 chars 之和 + `truncs` 的 raw−kept 之和）降序 ——
    //   直接量"丢了多少"，与 P18 的见证口径同源（`dropped`/`truncs` 正是 P16/P17 落进单元元数据的那两个字段）。
    //   平手时回到旧键（chars 升序）保持确定性；**缓存缺失者（damage=-1）排最前**（无元数据 ⇒ 最需要重算）。
    //   注：本排序**只在旁路分支内生效**，而旁路默认关闭（`reArchiveOpts()`）⇒ 对现网行为零影响。
    .sort((a, b) => {
      const da = unitDamageOf(a.id, o), db = unitDamageOf(b.id, o);
      if (da.missing !== db.missing) return da.missing ? -1 : 1;
      if (da.damage !== db.damage) return db.damage - da.damage;
      return da.chars - db.chars;
    });
  return normal.concat(stale.slice(0, cap));
}
// ═══ 批0（P0-2）单源解码器：帧扫描 + 逐帧解压**只此一份** ═══
//   根因（2026-09-17 实测 7/7 复现）：把**整文件**交给 zlib.zstdDecompressSync 只会解出**第一帧**——
//   5 KB 与 28.6 MB 文件**同样**只返回 224–379 B（首帧头），且**不抛错** ⇒ 任何"整文件解码"写法
//   都是**静默近空**（看起来成功、实则丢 99.99%）。唯一正确读法：先扫 magic 得帧起点 → 逐帧 subarray 解压。
//   本区为模块级单源：`extractMessageFlowAsync` 与 `countZstdFrames` 均复用，禁止在别处再写一份扫描。
function scanZstdFrames(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) out.push(i);
  }
  return out;
}
// 逐帧解压：失败**只丢该帧**（返回 null）——绝不因单帧损坏丢掉整个文件
function decompressFrameAt(buf, off) {
  try { return zlib.zstdDecompressSync(buf.subarray(off)); } catch (e) { return null; }
}
// 逐帧解码全文件（宽容模式）：返回 {text, frames, okFrames, err}
//   批0（P1-1）：原实现 catch 在 while **外** ⇒ 任一帧抛错 = 整文件 null（该会话内容全丢）；
//   且 `out = Buffer.concat([out, frame])` 在循环内 = O(n²) 拷贝（30 MB/千帧累计十余 GB）。
//   现改为：坏帧跳过 + 数组收集（末尾一次 join）。
function decodeSessionLog(filePath) {
  let buf = null;
  try { buf = fs.readFileSync(filePath); } catch (e) { return { text: "", frames: 0, okFrames: 0, err: "read" }; }
  const offs = scanZstdFrames(buf);
  const chunks = [];
  let okFrames = 0;
  for (const off of offs) {
    const b = decompressFrameAt(buf, off);
    if (b) { chunks.push(b); okFrames++; }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), frames: offs.length, okFrames: okFrames, err: "" };
}
// ★ 2026-09-25（wm-skip 空壳证人）：水位跳过分支的**有界**对话探测。
//   背景（现场实证 session-28a52c6a-…）：账本水位说"已消费"、本轮按水位整文件跳过（压根没调提取器）时，
//   插件保守记为"有帧却没读"并拒绝消号 → 重试到上限后留下永久告警。但有一类会话**根本没有对话事件**
//   （日志只有 agent/inbox/spliced 通知帧 + 会话元数据，实测 13 帧 / 0 字正文），它们永远无法通过
//   "重读"变成有内容，只会白占重试配额并持续误报。
//   判据（**正面证据式**，2026-09-25 第二版）：对 [0, uptoFrame) 等距采样最多 WM_PROBE_MAX_FRAMES 帧、
//   累计解压 ≤ WM_PROBE_MAX_BYTES；从采样文本里提取**事件类型**（`"type":"<a>/<b>"` 形态，避免命中
//   内容块的 `"type":"text"`）——
//     · 任一类型属对话/摘要族 → true（有内容，仍需重读）；
//     · 任一类型**不在空壳白名单**里 → null（未知形态 ⇒ **不确定**，调用方保持旧行为）；
//     · 有类型且全属白名单 → false（正面证据：纯通知/元数据，无对话）；
//     · 一个类型都没提取到 → null（解析不出 ⇒ 不确定）。
//   为什么不写"没搜到对话关键词就算空壳"：合成夹具/截断日志同样搜不到关键词，那样会把
//   「有帧却没读」的防线整条削掉（第一版实测：`_test-t8-empty-admission` 由 35/0 退化为 22/13）。
const WM_PROBE_MAX_FRAMES = 12;
const WM_PROBE_MAX_BYTES = 2 * 1024 * 1024;
// 本轮"空壳证人"计数（模块级：批次级日志在另一个块作用域里读它，用 let 会 TDZ/未定义）
let WM_PROBE_EMPTY_ROUND = 0;
// 对话/摘要族：出现即"有内容"
const WM_PROBE_DIALOGUE_TYPES = new Set([
  "user/message", "assistant/message", "assistant/attempt", "tool/call", "tool/result", "compaction/summary",
]);
// 空壳白名单：纯通知 / 会话元数据 / 策略与沙箱声明（现场实证 session-28a52c6a 的全部事件类型）
const WM_PROBE_SHELL_TYPES = new Set([
  "agent/inbox/spliced", "session", "approval/policy", "permission/preset", "sandbox/mode",
  "agent/status", "agent/disposed", "session/end-seed", "subagent/model-selection-policy",
]);
function probeDialogueEvents(filePath, uptoFrame) {
  let buf = null;
  try { buf = fs.readFileSync(filePath); } catch (e) { return null; }
  const offs = scanZstdFrames(buf);
  if (offs.length === 0) return null;
  const cap = Math.min(offs.length, Number(uptoFrame) > 0 ? Number(uptoFrame) : offs.length);
  if (cap <= 0) return null;
  const n = Math.min(WM_PROBE_MAX_FRAMES, cap);
  const re = /"type"\s*:\s*"([a-z]+\/[a-z0-9-]+)"/g;
  let bytes = 0;
  let sawType = false;
  let sawUnknown = false;
  for (let k = 0; k < n; k++) {
    const b = decompressFrameAt(buf, offs[Math.floor((k * cap) / n)]);
    if (!b) continue;                              // 坏帧/幻影帧：跳过，不改变结论
    bytes += b.length;
    if (bytes > WM_PROBE_MAX_BYTES) return null;   // 成本超预算 → 不确定
    const t = b.toString("utf8");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const ty = m[1];
      if (WM_PROBE_DIALOGUE_TYPES.has(ty)) return true;
      if (WM_PROBE_SHELL_TYPES.has(ty)) { sawType = true; continue; }
      sawUnknown = true;
    }
  }
  if (sawUnknown) return null;                     // 未知形态 ⇒ 不确定，绝不放行
  return sawType ? false : null;                   // 纯白名单类型 ⇒ 空壳正面证据；否则不确定
}
function decompressSessionLog(filePath) {
  // 兼容既有调用口径（L3490 的 used 判定、L8379 的子代理 token 统计）：全失败仍返回 null
  try {
    const r = decodeSessionLog(filePath);
    if (r.frames === 0 || r.okFrames === 0) return null;
    return r.text;
  } catch (e) { return null; }
}
// 批0：具名导出（门用；先例 L1533 `export { sizeStateOf, … }`、L1652 `export { scanUndeposited, … }`）
//   —— 让 _test-raw-decode.mjs 能**直接行为断言**单源解码器，而不是只做源码正则。
export { scanZstdFrames, decompressFrameAt, decodeSessionLog };
// v2.8.4（P19）：归档链核心函数的具名导出 —— **让门与探针直接调用真实现**。
//   动机：`_probe-cliff.mjs` 原先**复刻**了选帧+抽取逻辑（违反本仓铁律「测实际实现，不要把逻辑
//   复制进测试」）⇒ 改 index.js 不会自动改探针 ⇒ 门**可假绿也可恒红**。导出后探针只负责造场景与断言。
//   实测判定（2026-09-18）：`extractMessageFlowAsync` 等函数的 4/6 空格缩进是**历史编辑遗留**，
//   并非闭包作用域 —— `export { … }` 直接可用、import 后 `typeof === "function"`（十者全通过）。
//   ⇒ **不需要 thunk / 不需要先 apply(fakeCtx)**；门可直接 `import` 后调用。
export {
  extractMessageFlowAsync, compressUnit, bucketUnits,
  readUnitCache, writeUnitCache, mergeUnitCache,
  countZstdFrames, extractExistingArchiveBlock,
  archivePendingEntry, sessionMentionedInMemory, refreshMemorySessionsIndex,   // ★ §9.11.4-8：导出以便门在"写夹具后强制刷新索引"（只读函数，导出无害）
  unitCounterVerMismatch, shouldReArchive, pickReArchiveCandidates, unitCharsOf,
  // v2.8.4（损伤代理替换）：单元实际被丢量 —— 门在**合成单元缓存**上直测（不必造整轮归档）。
  unitDamageOf,
  // v2.8.4（P9/P10/P12）：预算链条常量 + 不变量判定器 —— 让 GA12/GA13 **行为断言真值**（而非源码正则）。
  EXTRACT_COUNTER_VER, EXTRACT_BUDGET_CHARS, UNIT_MAX_CHARS, BUCKET_BUDGET_CHARS, BUCKET_MAX_UNITS,
  checkBudgetInvariant,
  // v2.8.4（P4 第三保险）：装配期断言 —— 门可对「合规件」与「undefined/空件」**双向行为断言**（旧字节必红）。
  joinPartsStrict,
  // v2.8.4（P14/P15）：时间预算 + 账本单例 —— 门上要能**真调用** `shouldReArchive` 而不必跑整条归档流水线。
  ROUND_EXTRACT_BUDGET_MS, sessionExtractBudgetMs, reArchiveOpts,
  ARCHIVE_WATERMARK, ARCHIVED_SESSIONS,
  // v2.8.4（P21/P22）：多日志解析 + 水位分摊 —— 纯函数 ⇒ GA24 直接行为断言（不必造 7 个真目录）。
  SESSION_LOG_CHRONO, resolveSessionLogPaths, sessionFramesTotal, distributeOffsets, combineExtracts,
};
// v2.8.4（P18）：归档**内容见证聚合器** —— 纯函数（门直测；账本写入与两处「指定读者」共用同一口径，防口径漂移）。
//   输入 = `[[sid, {mode, points, chars, reason}], …]`（`LAST_ARCHIVE_WITNESS` 的 entries）+ A5 标志。
//   分类：written（真写入）/ declared-skip（子代理自己声明跳过）/ dropped（**机制层**丢弃：已在库、本轮已记、写盘异常）。
//   `lost` 只数 **dropped 且 chars>0** 的 —— 那才是"取到了内容却没进库"的真丢失；declared-skip 是子代理的判断，不算丢失。
function summarizeArchiveWitness(entries, a5ok) {
  const out = { written: 0, declaredSkip: 0, dropped: 0, lost: 0, charsWritten: 0, charsLost: 0, lostDetail: [], a5: a5ok === true, skipWithContent: 0, skipDetail: [], skipReasons: [], noUnitSkip: 0, skipUnitTruncated: 0, unitLost: 0, noUnitWhy: [] };
  const lost = [];
  const skipC = [];
  const skipR = [];                                            // v2.8.4（T3）：跳过**理由**（旧实现只留字数 ⇒ 事后不可审计）
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 2) continue;            // 形状可疑条目直接跳过（账本容错优先于计数精确）
    const sid = e[0], v = e[1];
    if (typeof sid !== "string" || !sid) continue;
    if (!v || typeof v !== "object") continue;
    const ch = Number(v.chars) || 0;
    if (v.mode === "written") { out.written++; out.charsWritten += ch; }
    else if (v.mode === "declared-skip") {
      out.declaredSkip++;
      // ★ 方案 P18 原文要求的那半条：**本轮单元非空却声明跳过** = 可疑丢弃（(D) 方向下，旧正文不再随轮提供，
      //   子代理看到的"仅新增帧"若判为无价值，则该 sid 的新增内容就地消失）。单列出来给读者看，不等同于 lost。
      const uc = Number(v.unitChars) || 0;
      if (uc > 0) {
        out.skipWithContent++; skipC.push(sid + "(" + uc + "字)");
        // v2.8.4（T3）：连**理由**一起带上（见证里本来就有 reason，≤60 字）—— 否则「有内容却跳过」只看得见"跳掉多少字"，
        //   看不见"为什么判它无价值"，事后无法复核子代理这次判断（实测 09-18 那轮 5 个会话共跳掉约 5.4 万字符，理由全无留存）。
        // v2.8.4（T3·消毒）：理由必须**单行且封顶** —— 它会经 `formatArchiveSignal` 拼进心跳行/启动自检行，
  //   而那一行是要进模型上下文的。子代理写的理由可能带换行（破行/注入面）⇒ 换行折成空格后再截断。
        skipR.push(sid + "：" + ((String(v.reason || "").replace(/[\r\n]+/g, " ").trim() || "未给理由").slice(0, 40)));
      }
      // §9.12② 评审整改（逃生口 + 打折的副本）单独计数 —— **绝不静默**：这两类都是"跳过之后拿不回原文"的形态
      if (v.noUnitSkip === true) {
        out.noUnitSkip++;
        // ★ 根因席（rev3 复核）：`noUnitSkip` 若只是**一个数字**，上涨时无法归因（至少混着四类：抽取未产出 /
        //   写失败 / LRU 淘汰 / 读方拒因）⇒ 把 `unitWhy` 一起收进见证（**已在手上**，零成本），并按 `unitLost`
        //   把"系统故障"与"确实没内容"当场分开。
        const wy = String(v.unitWhy || "").replace(/[\r\n]+/g, " ").trim();
        out.noUnitWhy.push(sid + "：" + (wy || "未记 why") + (v.unitLost === true ? "〔★系统故障〕" : ""));
      }
      if (v.unitLost === true) out.unitLost++;
      if (v.unitTruncated === true) out.skipUnitTruncated++;
    }
    else if (v.mode === "dropped") {
      out.dropped++;
      if (ch > 0) { out.lost++; out.charsLost += ch; lost.push(sid + "(" + ((String(v.reason || "").replace(/[\r\n]+/g, " ").trim() || "?").slice(0, 40)) + "," + ch + "字)"); }
    }
  }
  out.lostDetail = lost.slice(0, 8);                            // 明细封顶 8 条（账本/心跳行都不该被长清单撑爆）
  out.skipDetail = skipC.slice(0, 8);
  out.skipReasons = skipR.slice(0, 5);                          // v2.8.4（T3）：理由前 5 条（读者行只显示前 2 条，长清单不进上下文）
  out.noUnitWhy = (out.noUnitWhy || []).slice(0, 5);            // ★ 同上：无单元的原因前 5 条（读者行只显示前 2 条）
  return out;
}
export { summarizeArchiveWitness };
// v2.8.4（P18）：账本 → **一行人类可读信号**（纯函数 ⇒ 门用合成账本直测每个分支，不碰真文件）。
//   读这条信号的两个位置（「指定读者」）：① 运行状况心跳行 ② 每次启动的自检。二者共用本格式源。
function formatArchiveSignal(st, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const s0 = (st && typeof st === "object") ? st : {};
  const seg = [];
  const al = s0.archiveAutoLast;
  if (al && al.at) {
    const d0 = new Date(al.at);
    seg.push("自动归档 最近判定 " + pad(d0.getMonth() + 1) + "-" + pad(d0.getDate()) + " " + pad(d0.getHours()) + ":" + pad(d0.getMinutes())
      + " " + (al.ran ? "已发起（" + String(al.why || "") + "）" : "未发起（" + String(al.why || "") + "）"));
    if (!al.ran && al.until > now) {                       // 只有"还没到期"的退避才值得显示（过期退避是噪声）
      const u = new Date(al.until);
      seg.push(" · 白轮退避至 " + pad(u.getMonth() + 1) + "-" + pad(u.getDate()) + " " + pad(u.getHours()) + ":" + pad(u.getMinutes()));
    }
  } else {
    seg.push("自动归档 尚无判定记录（silent 档下：首个顶层会话或每小时 tick 时写入）");
  }
  const w = s0.archiveWitnessLast;
  if (w && w.at) {
    seg.push(" · 上轮留证 写入 " + (Number(w.written) || 0) + " · 声明跳过 " + (Number(w.declaredSkip) || 0) + " · 丢弃 " + (Number(w.dropped) || 0));
    if ((Number(w.lost) || 0) > 0) seg.push("（⚠️ 丢弃正文 " + (Number(w.charsLost) || 0) + " 字：" + ((w.lostDetail || []).slice(0, 3).join(" ") || "明细见账本") + "）");
    if ((Number(w.skipWithContent) || 0) > 0) seg.push("（⚠️ " + (Number(w.skipWithContent) || 0) + " 个会话**本轮有内容却声明跳过**：" + ((w.skipDetail || []).slice(0, 3).join(" ") || "明细见账本") + "）");
    // §9.12② ：**恢复通道要写在读者眼前** —— 被跳过的正文没有进记忆库，只落在归档单元里；
    //   而"要用 source:\"units\" 才搜得到"这件事此前没有任何地方告诉读者（用户按默认 source=logs 搜不到就会以为真丢了）。
    if ((Number(w.skipWithContent) || 0) > 0) seg.push("（正文只在归档单元：检索请用 `source:\"units\"`）");
    // §9.12② 评审整改：两种"打折的跳过"必须能被读者看见 —— 无单元（连副本都没有）与单元被上限截断（副本不全）
    if ((Number(w.noUnitSkip) || 0) > 0) seg.push("（其中 " + Number(w.noUnitSkip) + " 个**无任何副本**（无单元：抽取未产出，已留痕放行））");
    if ((Number(w.unitLost) || 0) > 0) seg.push("（⚠️ 其中 " + Number(w.unitLost) + " 个是**系统故障**：本轮曾抽取但盘上无单元文件（写失败/被淘汰）⇒ 与「确实没内容」不同，详见下一批的重试项）");
    // ★★ §9.11.4-3 修正九（**工程席 rev8f A2 实测：`empty`/`skipped` 写进账本却全仓无活读点**，
    //   而原先的注释声称它是 `unitLost` 的排除项 —— 那是"注释描述了一个不存在的实现"）：
    //   现在把这两个标记**真正接上健康信号**（本条即唯一活读点）⇒ ①"为什么判它已归档"在**用户可见的健康行**上自答；
    //   ②它同时是 `unitLost` 的**排除项说明**：`empty`/`skipped` 的会话**本来就没有单元**，不该被误读成"丢了单元"。
    if ((Number(s0.archiveWmEmpty) || 0) > 0 || (Number(s0.archiveWmSkipped) || 0) > 0) {
      seg.push("（账本自答：**确无内容**消号 " + (Number(s0.archiveWmEmpty) || 0) + " 个"
        + ((Number(s0.archiveWmSkipped) || 0) > 0 ? " · 其中**本轮未读**（水位已判消费完）" + Number(s0.archiveWmSkipped) + " 个" : "")
        + " —— 这些会话**本来就没有单元**，不算「丢了单元」）");
    }
    // ★★ 修正十二（根因席 rev8f B）：**"已归档但盘上查不到单元、且不是空会话"** = 内容可能真丢了。
    //   与上面那条互为对照：`empty`/`skipped` 是"本来就没有单元"（不算丢），本条是"**该有单元却没有**"。
    //   带 `unitLostChecked` 一起报，读者才知道这信号覆盖了多少（**不把"没查"误读成"没丢"**）。
    // ★★ 修正十三（红队 rev8h B/C-3）：**"按水位跳过"必须可见** —— 未到上限=自动重试中；到上限=需人工。
    if ((Number(s0.archiveWmSkip) || 0) > 0) {
      // ★ 工程席 rev8k A3：把"合计被跳过帧数"报出来（`wmSkippedFrames`/`archiveWmSkipFrames` 原先只写不读）；
      //   A1：上限文案也改引用常量（原先这里硬编码"3 轮"）。
      seg.push("（⚠ 按水位跳过（有帧却没读）" + Number(s0.archiveWmSkip) + " 个"
        + ((Number(s0.archiveWmSkipFrames) || 0) > 0 ? "、合计 " + Number(s0.archiveWmSkipFrames) + " 帧" : "")
        + "：自动重试中（上限 " + WM_SKIP_MAX_ROUNDS + " 轮，写好/耗尽的会在这里报）"
        + ((Number(s0.archiveWmSkipExhausted) || 0) > 0 ? "；**已耗尽 " + Number(s0.archiveWmSkipExhausted) + " 个 ⇒ 停止重试，内容可能未入档，请人工核查**" : "") + "）");
    }
    // ★★ §9.11.4-9（**现场取证驱动**）：`unitLostArchived` 原先**只在 >0 时报** ⇒ "0"被读者天然读成
    //   "没有丢失"；而现场实测 `unitLostChecked=39 / 已归档 289` ⇒ **覆盖率仅 13.5%**，那个 0 的真实含义是
    //   "**在抽查到的那 39 个里没发现**"，**不是**"全库没有"。这正是我在修正十二 注释里承诺过的
    //   "不把『没查』误读成『没丢』"，却没在信号里兑现。⇒ 现在**0 也报**，并给出"已查 / 待查"与覆盖状态。
    {
      const checked = Number(s0.unitLostChecked) || 0;
      const total = Number(s0.archiveWmTotal) || 0;
      const lost = Number(s0.unitLostArchived) || 0;
      const todo = total > 0 ? Math.max(0, total - checked) : 0;
      if (lost > 0) {
        seg.push("（⚠️ **已归档却查不到单元** " + lost + " 个（非空会话；本轮抽查 " + checked + " 个"
          + (todo > 0 ? "，**另有 " + todo + " 个待查**" : "") + "）—— 内容可能未入档，建议用 `source:\"units\"` 或 `session_search` 核对来源）");
      } else if (checked > 0) {
        seg.push("（单元抽查：本轮查 " + checked + " 个**未发现**「已归档却查不到单元」"
          + (todo > 0 ? "；**另有 " + todo + " 个待查**（跨轮轮转覆盖 —— 勿把本项 0 读成「全库无丢失」）" : "（已覆盖全量）") + "）");
      }
    }
    if ((Number(w.noUnitSkip) || 0) > 0) {
      const why = Array.isArray(w.noUnitWhy) ? w.noUnitWhy.slice(0, 2) : [];
      seg.push("（无单元原因：" + (why.length ? why.join(" ｜ ") : "旧账本未记 why（v2.8.4 前的轮次只有计数）") + "）");
    }
    if ((Number(w.skipUnitTruncated) || 0) > 0) seg.push("（其中 " + Number(w.skipUnitTruncated) + " 个单元被上限**截断**，副本可能不完整）");
    // v2.8.4（T3）：**理由**也报出来 —— 只看"跳掉多少字"无法判断该不该复核；旧账本没有该字段就**如实说"未记"**，不伪造。
    if ((Number(w.skipWithContent) || 0) > 0) {
      const rs = Array.isArray(w.skipReasons) ? w.skipReasons.slice(0, 2) : [];
      seg.push("（跳过理由：" + (rs.length ? rs.join(" ｜ ") : "旧账本未记理由（v2.8.4 前的轮次只记字数）") + "）");
    }
    // ★★ §9.11.4-11（B4）**单元写失败**的**活读点**。
    //   为什么必须在这里读（而不是只 `monitorEvent`）：本仓已因"加了字段没人读"栽过**四次**
    //   （`LEDGER_UNREADABLE_TOLD`、`archiveWmEmpty`/`archiveWmSkipped`、`wmSkippedFrames`、以及工程席 rev8k 点名的第 4 例）。
    //   而且这一项**正是**"已归档却查不到单元"的**上溯成因之一**：健康行现在报"丢了 N 个单元"，
    //   却答不出"是**写失败**还是**被淘汰**" —— 本行补上那个答案。
    //   ★★ 位置修正（**我在本项实测抓到自己的错**）：第一版把这个 `if` 写在上面 `if (w && w.at)` **块内** ⇒
    //     没有 `archiveWitnessLast` 的首轮/新进程里**根本读不到**（实测：健康行只 42 字、计数器不显示）。
    if (w.doneOk === false) seg.push("（上轮未消号：" + (w.a5 ? "A5 缺声明" : "未落盘/批失败") + "）");
  }
  // ★★ §9.11.4-11（B4）**单元写失败**的**活读点**（进程级计数 ⇒ 必须在 `if (w && w.at)` 块**之外**）。
  //   为什么必须在这里读（而不是只 `monitorEvent`）：本仓已因"加了字段没人读"栽过**四次**
  //   （`LEDGER_UNREADABLE_TOLD`、`archiveWmEmpty`/`archiveWmSkipped`、`wmSkippedFrames`、工程席 rev8k 点名的第 4 例）。
  //   而且它**正是**"已归档却查不到单元"的**上溯成因之一**：健康行报"丢了 N 个单元"，却答不出
  //   "是**写失败**还是**被淘汰**" —— 本行补上那个答案。
  //   ★★ 位置修正（**我在本项实测抓到自己的错**）：前两版把它写在 `if (w && w.at)` **块内** ⇒
  //     没有 `archiveWitnessLast` 的新进程/首轮里**根本读不到**（实测：健康行只 42 字、计数不显示）。
  if (UNIT_WRITE_FAIL_SEEN > 0) {
    seg.push("（⚠️ **单元写盘失败 " + UNIT_WRITE_FAIL_SEEN + " 次**（本次进程内）—— 这些会话本轮产物**未落盘**，"
      + "下游只会看到 `no-unit-file`（**读侧区分不出「写失败」与「被淘汰」**）。连续出现多为缓存目录不可写或磁盘已满；"
      + "详见 `.monitor.json` 的 `write-fail`/`write-readback-mismatch`）");
  }
  const tk = s0.archiveTokenLast;                                          // v2.8.4（自动归档包⑤）：每轮花费可见
  if (tk && tk.at) {
    const wan = (n9) => Math.round((Number(n9) || 0) / 10000);
    const hit = (Number(tk.inT) > 0) ? Math.round(((Number(tk.cacheT) || 0) / Number(tk.inT)) * 100) : null;
    // §9.12④：**"读不到"不许显示成"0 消耗"** —— 那会让读者以为这轮免费（既有缺陷的表现形式之一）。
    if (tk.usageEmpty === true) {
      seg.push(" · 上轮消耗 **读取失败**（子代理日志未落盘，已重试 " + (Number(tk.usageRetry) || 0) + " 次）—— 不是 0 消耗");
    } else {
      seg.push(" · 上轮消耗 输入 " + wan(tk.inT) + " 万" + (hit !== null ? "（缓存 " + hit + "%）" : "") + " / 输出 " + wan(tk.outT) + " 万"
        + (Number(tk.usageRetry) > 1 ? "（读取重试 " + Number(tk.usageRetry) + " 次）" : ""));
    }
  }
  // v2.8.4（容量治理·硬保证）：**超限卡住**可见 —— 否则"卡了几轮、做过什么"只存在于账本深处
  const ol = s0.overLimitStuck;
  if (ol && typeof ol === "object") {
    const rels = Object.keys(ol).filter((k) => (Number((ol[k] || {}).rounds) || 0) > 0);
    if (rels.length > 0) {
      const sunk = rels.filter((k) => String((ol[k] || {}).lastAction || "").indexOf("sink:") === 0);
      seg.push(" · 超限卡住 " + rels.length + " 个文件" + (sunk.length > 0 ? "（已机械下沉 " + sunk.length + "）" : "") + "：" +
        rels.slice(0, 3).map((k) => k.replace(/^projects\//, "").replace(/\.md$/, "") + "×" + (Number((ol[k] || {}).rounds) || 0) + "轮").join("、"));
    }
  }
  // v2.8.4（T3·消毒）：**整行不变量** —— 本函数的产物是要塞进"一行"的两个读者（心跳行 / 启动自检行），
  //   而其中的字段来自账本（子代理可写）。把任何 CR/LF 折成空格，保证读者拿到的**永远是一行**
  //   （否则一条带 `\n` 的理由就能在上下文里伪造出一行"看着像系统消息"的文本）。
  return seg.join("").replace(/[\r\n]+/g, " ");
}
export { formatArchiveSignal };
// v2.8.4（自动归档包）：`runStaleSilentTick` 定义在 `apply()` 内（要用 PLUGIN_CFG / 账本 / STALE_RUNNING 等闭包态）
//   ⇒ 门无法直接 import。按本仓 P19 先例用**模块级 thunk**：apply 内赋值，门先 `apply(fakeCtx)` 再取用。
//   回归门席要求"可注入时钟" ⇒ 暴露的是**带 `now` 形参**的原函数，门可注入任意时刻，**绝不真等 1 小时**。
export let __staleSilentTick = null;
// v2.8.4（P18/自动归档包⑤）：**指定读者**的单一格式源 —— apply 内赋值（要读账本闭包态）。
//   `updateMonitorSummary`（运行状况心跳行）与启动自检都只调它 ⇒ 两处永不各解释一遍账本字段。
export let __archiveSignalLine = null;
// v2.8.4（§9.6）：维护提醒函数本体（apply 内赋值）—— 门据此**行为断言**「remind/approval 档会注入漏网提醒」
//   （该缺陷原先只能靠读源码发现，而 `} else {` 藏在行注释里 ⇒ 读也容易看漏）。
export let __maintenanceInjectReminder = null;
// v2.8.4（§9.11.4-6）：账本**写入口** `saveStaleNotified`（apply 内赋值）——门据此**行为断言**
//   「坏账本 ⇒ 写入口自己拒写」。为什么必须暴露而**不能**靠"跑一轮 tick 再看痕迹"：
//   实测（本项）：8 个调用点里 7 个以 `ARCHIVE_WM_DIRTY` 为闸，而损坏夹具下没有任何东西会置该标志
//   ⇒ `saveStaleNotified` **根本不被调用** ⇒ 靠 tick 观察到的只能是**下游** `writeIntegrateState` 的抢救痕迹
//   ⇒ 断言会**测不到写入口本身**（我第一版就这么写的，实测 `save-refuse=false`、门红得不明所以）。
//   直调本体才能把"写入口的判据"与"下游兜底的判据"分开断言。
export let __saveStaleNotified = null;
// v3.1.0（索引自动刷新）：apply 内赋值的**刷新入口**（门据此行为断言：主挂点已接线 / 自动路径零 execFileSync /
//   单飞 / 冷却 / 锁被占按跳过）。用法同上面先例：先 apply(fakeCtx) 再取用，签名 refreshSearchIndex({ reason, listener })。
export let __indexRefreshTick = null;
// v1.12.18.4: 旧版 extractMessageFlow（8000 截断）已删除——改为 extractMessageFlowAsync（compaction 优先 + 分段 map-reduce）
    // v1.12.18+: 分层提取——先官方 compaction/summary 摘要链（完整上下文浓缩含工具脉络），
    // 无压缩史的会话走帧级采样+行级快筛+工具轨迹+动态预算；大会话分段交 map-reduce 仿真压缩。
    // 逐帧间 setImmediate 让出，主线程不冻结；zstd 多帧可独立解压（实测单帧语义）。
    async function extractMessageFlowAsync(filePath, skipFrames, opts) {
      try {
        const o = opts || {};
        const st = fs.statSync(filePath);
        const sizeMB = st.size / 1048576;
        // v2.8.4（P15）：两级墙钟预算 —— 取「整轮共享截止」与「本会话预算」的**较早者**。
        const sessionDeadline = Date.now() +
          (Number.isFinite(Number(o.sessionBudgetMs)) ? Number(o.sessionBudgetMs) : sessionExtractBudgetMs(st.size));
        const deadlineTs = Math.min(Number.isFinite(Number(o.deadlineTs)) ? Number(o.deadlineTs) : Infinity, sessionDeadline);
        const buf = fs.readFileSync(filePath);
        const frames = scanZstdFrames(buf);   // 批0（P0-2）：单源帧扫描（原内联逐字节扫描已收敛到 scanZstdFrames）
        if (frames.length === 0) return null;
        // v2.4.3：增量重档——丢掉水位前的已归档帧，只喂尾部新增；总帧数不高于水位（日志被外部重写）→ 回退全量，绝不静默丢尾
        if (skipFrames > 0) { if (frames.length > skipFrames) frames.splice(0, skipFrames); else skipFrames = 0; }
        // ══════ v2.8.4（P6）**删除帧采样** ══════
        // 原 `FULL = sizeMiB < 8 || frames <= 12`，之上走「首2 + 中K + 末2」；而 K 按**文件大小**
        // 缩放（`round(sizeMiB*1.5)` 帧/MiB），实际帧密度 ≈2700 帧/MiB ⇒ 采样率随体积崩塌：
        // 9 MiB 会话只取 18/24860 = **0.072%**（实测 `60e0713f` 24860 帧 → 单位元 **17 个换行**）。
        // 现改**全帧遍历**；FULL 仅作 ≤12 帧的 sanity 短路（不再有采样语义）。
        const FULL = frames.length <= 12;
        const maxChars = EXTRACT_BUDGET_CHARS;   // P9：删 `sizeMiB < 5 ? 8000 : 200000` 中间档，并轨为唯一上限（定义见下方预算链）。
                                   //   真正绑定的是下游 `UNIT_MAX_CHARS`（20000，本批不改）⇒ 净收益上限 8000→20000（2.5×）。

        // ══════ v2.8.4（P1–P3/P5）按类配额的装配（替换原 FIFO `total > maxChars → break`）══════
        // ① 删件内固定上限 800/1000/80 —— 用户案例的**唯一**根因：6521 字符的消息被切在第 6 个
        //    URL 的 `rowguid=` 之后（实测 `b078d968` 单元里前 5 个 URL 完整、后 4 个全无）。
        // ② `<system-reminder>` 开头**整条跳** → 改为剥离注入块后**剩余非空即保留**
        //    （注入块正是"记忆内容回灌"的载体；但 P5 是独立缺陷，不在用户案例因果链上）。
        // ③ 纳入 `tool/result`（**仅错误**，判据 `content[].isError === true`；正文在 `content[].content`）
        //    与 `system/message`。
        // ④ 预算按**类配额 + 优先级**分配；同类内**新近优先**。
        // 内存有界：每类收集量上限 = 该类配额 × 3，超出即计 dropped（不撑爆内存，也不撞"先全收"）。
        const KIND_ORDER = ["compaction/summary", "user/message", "assistant/message", "tool/call", "tool/result", "system/message"];
        const KIND_SHARE = { "compaction/summary": 0.35, "user/message": 0.45, "assistant/message": 0.15, "tool/call": 0.04, "tool/result": 0.01, "system/message": 0.0 };
        const PIECE_MAX = { "compaction/summary": 4000, "user/message": 2000, "assistant/message": 2000, "tool/call": 400, "tool/result": 400, "system/message": 2000 };
        const HEAD_KEEP = 200, MIN_KEEP = 600, SLACK = 800;   // 二态制：n = 0 或 n ≥ 800（禁止 0<n<800，修 slice(-0) 缺陷）
        const LABEL = { "user/message": "[用户] ", "assistant/message": "[助手] ", "system/message": "[系统] ", "tool/call": "[工具] ", "tool/result": "[工具结果] ", "compaction/summary": "【压缩点摘要】\n" };
        const collectCap = (kd) => Math.max(4000, Math.floor(maxChars * (KIND_SHARE[kd] || 0.02)) * 3);

        const pieces = [];                       // {frame,line,kind,text} —— 有界收集
        const collected = Object.create(null);
        const dropped = Object.create(null);     // kind → {n, chars}（不变量 Ⅱ：丢弃必须带 chars 留痕）
        const bump = (kd, chars) => { const d = dropped[kd] || (dropped[kd] = { n: 0, chars: 0 }); d.n++; d.chars += (chars || 0); };
        let lastCompFrame = -1;
        let stoppedAt = -1;                    // P14/P15：被墙钟掐断的**局部帧下标**（-1 = 跑完）
        for (let k = 0; k < frames.length; k++) {
          if (k > 0 && (k & 63) === 0) {
            // v2.8.4（P15）：超时不抛异常、不留半成品——只**截在帧边界**并把截断位置如实上报。
            //   `Date.now()` 每 64 帧一次 ⇒ 2.5 万帧会话只多 388 次调用，可忽略。
            if (Date.now() > deadlineTs) { stoppedAt = k; break; }
            await new Promise((r2) => setImmediate(r2));   // P7：每 64 帧让出
          }
          const fb = decompressFrameAt(buf, frames[k]);
          if (!fb) { bump("(badframe)", 0); continue; }                                // P11：坏帧也要留痕
          const lines = fb.toString("utf8").split("\n");
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            if (!line.trim()) continue;
            let kd = null;
            if (line.indexOf('"type":"user/message"') >= 0 || line.indexOf('"type": "user/message"') >= 0) kd = "user/message";
            else if (line.indexOf('"type":"assistant/message"') >= 0 || line.indexOf('"type": "assistant/message"') >= 0) kd = "assistant/message";
            else if (line.indexOf('"type":"system/message"') >= 0 || line.indexOf('"type": "system/message"') >= 0) kd = "system/message";
            else if (line.indexOf('"type":"tool/call"') >= 0 || line.indexOf('"type": "tool/call"') >= 0) kd = "tool/call";
            else if (line.indexOf('"type":"tool/result"') >= 0 || line.indexOf('"type": "tool/result"') >= 0) kd = "tool/result";
            else if (line.indexOf('"type":"compaction/summary"') >= 0 || line.indexOf('"type": "compaction/summary"') >= 0) kd = "compaction/summary";
            if (!kd) continue;                        // 非 KEEP 类（chunk 流等）体量最大，不逐个计数
            let j; try { j = JSON.parse(line); } catch (e) { continue; }
            const txts = extractTextsFor(j, kd);
            if (!txts.length) { bump(kd, 0); continue; }
            for (const t of txts) {
              if (!t) continue;
              const cur = collected[kd] || 0;
              if (cur >= collectCap(kd)) { bump(kd, t.length); continue; }   // 有界收集：超出即计数丢弃
              collected[kd] = cur + t.length;
              pieces.push({ frame: skipFrames + k, line: li, kind: kd, text: t });   // P8：**全局帧号**
              if (kd === "compaction/summary") lastCompFrame = skipFrames + k;      //   （`k` 是 splice 后的局部下标）
            }
          }
        }

        // ── v2.8.4（P14）：**已消费帧数** —— 提取真正走到的全局帧位置（水位与单元缓存一律用它，不用文件总帧数）
        //   跑满时 = `skipFrames + frames.length` = 文件总帧数（与旧口径数值相同，故无行为回归）；
        //   被掐断时 = `skipFrames + stoppedAt` **小于**总帧数 ⇒ 水位不推进到尾部 ⇒ 余下帧下轮可续（P15）。
        const consumedFrames = skipFrames + (stoppedAt >= 0 ? stoppedAt : frames.length);
        const incomplete = stoppedAt >= 0;

        // ── 分配：按 KIND_ORDER 依次扣类配额；同类内**新近优先**（frame 降序）
        const budget = Object.create(null);
        for (const kd of KIND_ORDER) budget[kd] = Math.floor(maxChars * (KIND_SHARE[kd] || 0));
        const usedK = Object.create(null);
        const chosen = [];
        const truncs = [];                      // 截断标注**只进元数据**，绝不进 text（D-11）
        let totalAll = 0;
        for (const kd of KIND_ORDER) {
          const group = pieces.filter((p) => p.kind === kd).sort((a, b) => b.frame - a.frame);
          for (const p of group) {
            const globalLeft = maxChars - totalAll;
            let n = Math.min(PIECE_MAX[kd], Math.max(budget[kd] - (usedK[kd] || 0), 0) + SLACK, globalLeft);
            // ★ v2.8.4（二态制修正 —— 由新行为门 `_test-extract-kinds.mjs` 实测抓出，非推演）：
            //   原判据 `if (n < HEAD_KEEP + MIN_KEEP) n = 0;` 是把**额度**拿去比 800，于是**短件**也被判死：
            //   `PIECE_MAX["tool/call"] = PIECE_MAX["tool/result"] = 400 < 800` ⇒ 这两类的 `n` **恒为 0**
            //   ⇒ **工具调用与错误工具结果永远进不了单元**（实测：25 字的两件 100% 被丢，GA10c/GA10d 其实从未满足）。
            //   二态制的**本意**是"要截断时不做无意义碎片"（修 `slice(-0)` 缺陷），不是"拒绝短件" ——
            //   故只在**真要截断**（`n < p.text.length`）时适用：能整件放下就必须整件放下。
            if (n < p.text.length && n < HEAD_KEEP + MIN_KEEP) n = 0;
            if (n <= 0) { bump(kd, p.text.length); continue; }
            const take = Math.min(p.text.length, n);
            if (take < p.text.length) truncs.push({ frame: p.frame, line: p.line, kind: kd, raw: p.text.length, kept: take });
            chosen.push({ frame: p.frame, line: p.line, kind: kd, body: p.text.length > take
              ? (LABEL[kd] || "") + p.text.slice(0, HEAD_KEEP) + "\n…[中间 " + (p.text.length - take) + " 字符已截断]…\n" + p.text.slice(-(take - HEAD_KEEP))
              : (LABEL[kd] || "") + p.text });
            usedK[kd] = (usedK[kd] || 0) + take; totalAll += take;
          }
        }
        chosen.sort((a, b) => a.frame - b.frame || a.line - b.line);   // 输出回原始顺序
        const truncated = truncs.length > 0 || Object.keys(dropped).length > 0;

        // ── 组装：markers **进 text**（子代理需要知道这不是全量）；截断明细走元数据
        const markers = [];
        if (!FULL || truncated) {
          markers.push("[说明] 本轮按**类配额 + 新近优先**择优提取：原文共 " + frames.length + " 帧 / " +
            (skipFrames > 0 ? "（本轮为增量，" : "（") + "选中 " + chosen.length + " 件" +
            (truncated ? "，存在截断/丢弃（明细见单元元数据 dropped/truncs）" : "") + "]");
        }
        // v2.8.4（P15）：掐断必须**进 text**（`markers` 会进单元正文）——子代理要能知道这一段是不完整的，
        //   否则它会照着半个会话写"已归档"（P18 的账本见证也依赖这个可观测性）。
        if (incomplete) {
          markers.push("[说明] 本轮提取被**墙钟预算**掐断：已消费 " + consumedFrames + " / " + (skipFrames + frames.length) +
            " 帧（截断位置帧边界）；**余下帧将在下一轮从该帧续跑**，本单元内容不完整。");
        }

        if (lastCompFrame >= 0 && chosen.some((c) => c.kind === "compaction/summary")) {
          // v2.8.4（P4 第三保险）：三处装配**全部走 `joinPartsStrict`** —— 任何 `undefined`/空串件一律抛错，
          //   而不是被 `Array.join` 静默渲染成空串（BUG-2 的形态：单元只剩 17 个换行）。
          const compParts = chosen.filter((c) => c.kind === "compaction/summary").map((c) => c.body);
          const comp = compParts.join("\n\n=====\n\n");
          const postParts = chosen.filter((c) => c.kind !== "compaction/summary" && c.frame > lastCompFrame).map((c) => c.body);
          const post = postParts.length ? joinPartsStrict(postParts, "compaction/post") : "";
          let flowOut = joinPartsStrict(markers.concat([comp]), "compaction/flow");   // markers 为空时也至少 [comp]
          if (post) flowOut += "\n\n【末次压缩后的新增交互】\n" + post;
          const cut = flowOut.length > maxChars;
          const kept = cut ? flowOut.slice(-maxChars) : flowOut;
          return { flow: kept, sampled: false, source: "compaction", compCount: chosen.filter((c) => c.kind === "compaction/summary").length,
                   truncated: cut || truncated, dropped: dropped, truncs: truncs, markers: markers,
                   consumedFrames: consumedFrames, incomplete: incomplete };
        }
        // ★★ §9.11.4-3（用户 2026-09-19 拍板「按你推荐的来」）：**"确实无内容"不能与"抽取失败"共用 `null`**。
        //   旧写法这里 `return null`，而归档循环对 `null` 的处理是"保守：该文件不推进"（P0-1 意图：怕静默丢内容）
        //   ⇒ 两条后果实测（2026-09-19，真机两个候选）：
        //     ① 循环里那条「**真·无内容 ⇒ 帧已全部检查 ⇒ 视为已消费**」的分支（`!hasBody && !r.incomplete`）
        //        **永远不可达** —— 空内容在源头就变成 null 了。作者（我）当初把下游写好了，源头却把它短路。
        //     ② 于是"只含控制事件"的会话（实测 `574b8af7` 的 legacy 2 帧、`28a52c6a` 的 v3 6 帧，
        //        内容全是 `session`/`permission/preset`/`sandbox/mode`/`session/end-seed` —— **一个字正文都没有**）
        //        每轮都被判"有新增"（水位量纲还停在旧码的 v3-only：`cur=3749 > wm=3747` 恒真）⇒
        //        **僵尸候选**：每轮重选、每轮无流，还会触发一次白轮 + 24h 退避（把新会话的自动归档一起压住）。
        //   ★★★ 2026-09-20 **撤销前一次"更正"**（B6 取证定案，详见 `docs/现场取证-三-最终版-推翻chunk结论-20260919.md` 第三·补节）：
        //     我曾在 2026-09-19 深夜在此加过一段"更正"，声称把 `28a52c6a` 当"零正文"是错的、它其实有 52592 字。
        //     **那次更正本身是错的，现撤销。** 两个口径在同一会话上的实测：
        //       口径 A（**本代码的口径**：六类装配事件 ∧ `content[].type === "text"`）= **0 字**
        //       口径 B（全部事件文本，含 `text-chunks`/`reasoning-chunks`/`texts[]`）= **0 字**
        //     该会话 19 帧全是控制事件（`session`/`permission/preset`/`sandbox/mode`/`approval/policy`/
        //     `subagent/model-selection-policy`/`agent/inbox/spliced`/`session/end-seed`）——**没有任何对话事件**。
        //     ⇒ **上面 ② 的原措辞是对的**，本节设计的现实依据成立。
        //     ⇒ 我的错在"口径"：那份手工拼接把**控制事件里的配置字段**当成了正文。
        //       **"某事件里有可打印文本" ≠ "该文本是会话正文"。**
        //     独立佐证：全部 302 个已归档会话里，满足"KEEP=0 ∧ type=text=0 ∧ 有帧 ∧ 无坏帧"的共 **22 个**
        //       （`docs/B6-真空会话样本.csv`，`28a52c6a` 在列）⇒ "真·只含控制事件"是**真实存在的一类**。
        //   ⇒ 空内容返回**结构化空结果**（`empty:true` + `consumedFrames`）：让下游那条分支**真的执行**，
        //     把这些帧消费掉（**没有内容可丢**）；而 `null` 继续**专表失败**（异常 / frames=0）⇒ 失败路径行为不变。
        if (chosen.length === 0) {
          // ★ 坏帧（`decompressFrameAt` 返回 null：截断写 / 压缩载荷内出现 4 字节 magic 的"幻影帧" / 存储损坏）
          //   **必须与"没有内容"一起上报**，不能因为走了"结构化空"就再也看不见它。
          //   ★ 已权衡并**否掉**的替代方案：`badFrames > 0 ⇒ return null`（不推进、下轮重试）。否掉的理由：
          //     ① 同一帧字节的解压结果是**确定性**的（重试恒失败）⇒ 那只是把"有限且已留痕的损失"
          //        换成"该会话永久僵尸候选"（每轮重选 + 白轮 24h 退避，正是本批要修的形态）；
          //     ② `scanZstdFrames` 按 magic 计帧 ⇒ 压缩载荷里偶然出现那 4 字节也会产生"幻影帧"
          //        （**没有任何真实损坏**）⇒ 拿它当"读不出来"会误判正常日志、把正常会话卡死。
          //   故这里把"帧已尽数尝试"与"坏帧计数"**同时**交出去：水位照常推进（帧确实都试过了），
          //   坏帧数进单元元数据/留痕 ⇒ 事后能回答"这批帧读出来了吗"，不是静默丢。
          const badFrames = (dropped["(badframe)"] && dropped["(badframe)"].n) || 0;
          return { flow: "", empty: true, sampled: false, source: "empty", compCount: 0, badFrames: badFrames,
            truncated: truncated, dropped: dropped, truncs: truncs, markers: markers,
            consumedFrames: consumedFrames, incomplete: incomplete };
        }
        const allText = joinPartsStrict(markers.concat(chosen.map((c) => c.body)), "messageflow/allText");   // P4 第三保险
        // ★★ §9.11.4-12（**B5 后队列项：`badFrames` 对"有正文"会话的可见性**）。
        //   实测缺口（`_bf-probe.mjs`，不是读码推测）：**有正文 + 3 坏帧**的日志，
        //   返回对象的键里**没有 `badFrames`**（`undefined`），而 `dropped["(badframe)"]` 里其实**有数据**（n=2）
        //   ⇒ 该数据**从不被上报**：本文件的正常路径 return 没有这个字段，下游也无人读 `dropped`。
        //   对照：**无正文 + 坏帧**走 `empty:true` 那条 return（含 `badFrames`）⇒ 只有那条可见。
        //   ⇒ 后果：会话"有正文但部分帧读不出"时，**读者完全看不到**"这批帧读出来了吗"——
        //     而这正是 `extractMessageFlowAsync` 注释里承诺过的事（L4228「事后能回答『这批帧读出来了吗』」），
        //     **却只在空会话上兑现**。⇒ 现在把同一口径**接到全部三条 return**（含下面的分段路径）。
        //   ★ 口径与空路径**完全一致**：`dropped["(badframe)"].n`（`scanZstdFrames` 按 magic 计帧，
        //     压缩载荷内偶现 4 字节 magic 会产生"幻影帧"⇒ 该数**可能高估**，如实上报、不修饰）。
        const badFrameCount = (dropped["(badframe)"] && dropped["(badframe)"].n) || 0;
        const SEG = 40000, MAX_SEG = 5;
        const segments = [];
        for (let i = 0; i < allText.length && segments.length < MAX_SEG; i += SEG) segments.push(allText.slice(i, i + SEG));
        if (allText.length > SEG * MAX_SEG) {
          const dense = [allText.slice(0, SEG)];
          const spanMid = allText.length - SEG * 2;
          for (let k = 1; k < MAX_SEG - 1; k++) { const p = SEG + Math.floor(spanMid * k / (MAX_SEG - 1)); dense.push(allText.slice(p, p + SEG)); }
          dense.push(allText.slice(allText.length - SEG));
          return { segments: dense, sampled: !FULL, source: "messageflow", truncated: truncated, dropped: dropped, truncs: truncs, markers: markers,
                   badFrames: badFrameCount,
                   consumedFrames: consumedFrames, incomplete: incomplete };
        }
        return { segments: segments, sampled: !FULL, source: "messageflow", truncated: truncated, dropped: dropped, truncs: truncs, markers: markers,
                 badFrames: badFrameCount,
                 consumedFrames: consumedFrames, incomplete: incomplete };
      } catch (e) { return null; }
    }
    // v2.8.4（P2）：逐类型正文抽取（**与 session-search.mjs 的 KEEP_KINDS 同源**，由 GR22 门断相等）
    //   实测裁决：`user/message` → `data.content[]`；`assistant|system/message` → `data.message.content[]`
    //   （**两条路径不同**）；两者都必须 `filter(c => c.type === "text")` —— `reasoning` 块**也带 text 字段**。
    //   `tool/result`：正文在 `content[].content`（**不是 `.text`**）；**仅错误**（`isError===true` 为超集判据）。
    function extractTextsFor(j, kd) {
      const d = (j && j.data) || {};
      if (kd === "user/message") {
        const arr = d.content;
        if (!Array.isArray(arr)) return [];
        const t = arr.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
        if (!t) return [];
        // P5：原为「`<system-reminder>` 开头 ⇒ **整条丢弃**」。注入块是记忆回灌载体，剥离后剩余非空应保留。
        const stripped = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
        return stripped ? [stripped] : [];
      }
      if (kd === "assistant/message" || kd === "system/message") {
        const arr = d.message && d.message.content;
        if (!Array.isArray(arr)) return [];
        const t = arr.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ").trim();
        return t ? [t] : [];
      }
      if (kd === "tool/call") {
        const nm = d.name || "?";
        return ["[" + nm + "] " + String(d.arguments || "")];
      }
      if (kd === "tool/result") {
        const arr = (d.message && d.message.content) || [];
        const isErr = Array.isArray(arr) && arr.some((c) => c && c.isError === true);
        if (!(d.error != null || isErr)) return [];            // 非错误 ⇒ 不收（对标 mimocode 不收 tool_output）
        const out = [];
        for (const c of arr) {
          let got = false;
          if (c && Array.isArray(c.content)) for (const q of c.content) if (q && typeof q.text === "string") { out.push(q.text); got = true; }
          if (!got && c && typeof c.text === "string" && c.text) out.push(c.text);   // [2026-09-23 V4] 提升后的 tool-role 消息 text 直挂块上
        }
        if (!out.length) out.push(JSON.stringify(d).slice(0, 4000));
        return out;
      }
      if (kd === "compaction/summary") {
        const s = d.summary;
        if (typeof s === "string") return [s];
        if (Array.isArray(s)) { const t = s.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n").trim(); return t ? [t] : []; }
        return [];
      }
      return [];
    }

    // ═══════════ v2.4.7（方案C·L2 确定性预压缩）：插件内规则压缩——替代 v1.12.18.3 的逐段 spawn 子代理仿真压缩
    // 痛点（真机 2026-08-30 实证）：16 个 ≥5MB 大会话 × 每会话 3-10 段 × 每段子代理调用 = 几十次 spawn 烧 token；
    //   且全批 flow 再拼一个巨型子代理 prompt（最坏 404 万字符≈120 万 token）必爆上下文。
    // 方案：零子代理规则压缩——提取结果按来源分流：
    //   source=compaction（有官方摘要链）→ 摘要链本身是模型看全量后的浓缩，最多额外补末次压缩后交互；
    //   source=messageflow（帧采样）→ 多段拼接后按"工具轨迹优先 + 用户消息 + 尾保真"规则取 ≤UNIT_MAX_CHARS。
    // 输出：单元 text（≤UNIT_MAX_CHARS），供 L3 分桶（桶预算 BUCKET_BUDGET_CHARS）确定性切批。
    // ═══ v2.8.4（P9/P10）：预算链条**一处定义** + 写死不变量 ═══
    //   P9：原 `maxChars = sizeMiB < 5 ? 8000 : 200000` **就地写在提取函数内部**（且带体积分支）⇒
    //     并轨为模块级唯一的 `EXTRACT_BUDGET_CHARS`（提取函数内 `maxChars` 只是它的别名）。
    //   P10：`UNIT_MAX_CHARS × 2 ≤ BUCKET_BUDGET_CHARS` 由**注释**升级为**加载期硬断言**（注释不是约束）。
    //     为什么恰好 ×2：分桶至少要能**并装两个满额单元**，否则桶内恒定只剩 1 个单元 ⇒ 会话间聚合失效、
    //     批数翻倍、token 放大。本批**不改常量值**（红队已裁决：上调 UNIT_MAX_CHARS 会饿死其他会话）。
    const EXTRACT_BUDGET_CHARS = 200000;   // 提取端唯一上限（原 maxChars；<5MiB 的 8000 分支已删）
    const UNIT_MAX_CHARS       = 20000;    // 单会话单元上限（≈5-6K token，加指令后单批上下文安全）
    const BUCKET_BUDGET_CHARS  = 60000;    // 单批字符预算（≈3-4 个单元，约 15-20K token）
    const BUCKET_MAX_UNITS     = 5;        // 单批单元数上限（防小单元堆积过长 prompt）
    // 断言体抽成**具名函数**：门可对「合规值」与「违规值」**双向行为断言**，无需改源码（否则只能做源码正则）。
    function checkBudgetInvariant(unitMax, bucketBudget) {
      if (!(Number.isFinite(unitMax) && Number.isFinite(bucketBudget) && unitMax > 0 && bucketBudget > 0)) {
        return { ok: false, msg: "非有限正数：unitMax=" + unitMax + " bucketBudget=" + bucketBudget };
      }
      if (!(unitMax * 2 <= bucketBudget)) {
        return { ok: false, msg: "UNIT_MAX_CHARS(" + unitMax + ") × 2 > BUCKET_BUDGET_CHARS(" + bucketBudget + ")" };
      }
      return { ok: true, msg: "ok" };
    }
    const BUDGET_INVARIANT_OK = checkBudgetInvariant(UNIT_MAX_CHARS, BUCKET_BUDGET_CHARS);
    if (!BUDGET_INVARIANT_OK.ok) throw new Error("[dsh-memory] 预算不变量被破坏（P10）：" + BUDGET_INVARIANT_OK.msg);
    // v2.6.6（2026-09-16 用户拍板）：2 → 5，且语义修正为「**在跑子代理**上限」。
    //   旧实现只在发起循环里限制协程数，而 startOneBatch 秒级返回（不等在跑）→ 协程瞬间把全部批发起
    //   （实证 09-16 17:06:19：7 批在**同一秒**全部创建），"并发上限"形同虚设、token 一次性放大。
    //   新实现：首批只发起 N 批 → 其余进等待队列 → settle 内每完成一批才补发起下一批（真闸门）。
    const ARCHIVE_MAX_CONCURRENT = 5;   // 在跑归档子代理并发上限（用户拍板 5；防 token 放大）
    const UNIT_CACHE_DIR = MEMORY_ROOT + "/.archive-units";   // 单元缓存（增量重档复用）
    const UNIT_CACHE_KEEP = 500;         // 单元 LRU 保留数
    // ★ §9.11.4-8：**唯一副本**（会话正文只存在于单元里、未落库）的**硬上限** —— 只有单元总数也超过它时，
    //   才会去动唯一副本。给"唯一副本无限膨胀"设一个天花板（防磁盘无界增长），同时保证正常规模下
    //   （现场 186/51）**一个唯一副本都不会被删**。取 2×KEEP：留足余量，又不至于让目录失控。
    const UNIT_CACHE_ONLY_COPY_HARD = UNIT_CACHE_KEEP * 2;
    // ═══════════ v3.1.0：检索索引自动刷新（session-search）常量 ═══════════
    //   本机实测（2026-09-20，真缓存）：全库增量稳态 2.98s / 吸收积压首轮 8.92s / 冷建最坏 115.2s
    //   ⇒ 300s 对最坏仍有 2.6× 余量（初版设计拟 20 分钟，是照抄插件自述的旧口径「约 6 分钟」）。
    const IDX_REFRESH_MIN_GAP_MS = 6 * 3600000;    // 成功后续冷却 6h（失败不续冷却）
    const IDX_REFRESH_BACKOFF_MS = 24 * 3600000;   // 连续失败 ≥3 次 ⇒ 转 24h 退避
    //   环境变量是**测试缝**（门用 800ms 验证 kill 路径），生产不设它。
    //   ★ 必须**调用时读**：宿主对重复 apply 会早退（同进程二次 apply 只更新配置、不重建闭包）
    //     ⇒ 若按 apply 期常量，门的短超时会被首次 apply 的值钉死（本仓自审实测踩到）。
    const IDX_REFRESH_TIMEOUT_DEFAULT_MS = 300000;
    const idxRefreshTimeoutMs = () => { const v = Number(process.env.DSH_MEMORY_IDX_TIMEOUT_MS); return v > 0 ? v : IDX_REFRESH_TIMEOUT_DEFAULT_MS; };
    const IDX_REFRESH_LEDGER = MEMORY_ROOT + "/.index-refresh.json";   // 自有独立点文件（不碰 .integrate.json）
    const IDX_TOOL_BUILD_QUIET_MS = 10 * 60000;    // 刚发生过手工/工具 build ⇒ 本轮不贴脸刷新
    // ═══════════ v2.8.4（P16）：`compressUnit` **降级为「透传 + 标注」** ═══════════
    // 旧实现在**此处做了第二套分配**：`text > UNIT_MAX_CHARS` 时按**行前缀**（`/^\[工具\]/`、`/^\[用户\]/`）
    //   取「60 行工具 + 40 行用户 + 末 40 行」，**优先级与 P3 相反**（工具先占、用户次之）。两个后果：
    //   ① **多行件的续行被整片丢掉**——件内 `\n` 会被 `split("\n")` 拆开，只有**首行**带 `[用户] `/`[工具] ` 前缀，
    //      其余物理行三个 filter 全部落空（实测形态：6521 字符的消息只剩首行）。这是 L-A 类丢失在**下游**的翻版，
    //      且发生在**件已选完之后** ⇒ P1–P3 的增益会被它二次吃掉。
    //   ② **[助手]/[工具结果]/[系统]/【压缩点摘要】** 在中段**整类消失**（只有 `tail` 的末 40 行能带出来）。
    // 现改为：**分配只由 P3 负责**（单一预算 ⇒ 单一丢失点）；此处只做 `slice(0, UNIT_MAX_CHARS)` 兜底，
    //   并把这次兜底**记进元数据**（GA8：不静默丢；GA17：截断必有元数据条目**且 `text` 内不含旧标注串**）。
    // 附注（方案 §1.4-3 的取舍）：§1.4-3「多行件压成单行（`\n`→字面 `\\n`）」的**唯一理由是让行前缀过滤 ≡ kind 过滤**；
    //   行前缀过滤此处已被**整体删除** ⇒ 该转义失去动机，且会给归档子代理的阅读面引入字面 `\n` ⇒ **不实施**。
    //   其真正要求（"续行不被丢"）由**删除过滤**本身满足，并由 GA8 的续行断言把住。
    function compressUnit(extract, fallbackText) {
      try {
        const src = (!extract) ? "none" : (extract.source || "messageflow");
        let text = "";
        if (!extract) text = String(fallbackText || "");
        else if (Array.isArray(extract.segments) && extract.segments.length > 0) text = extract.segments.join("\n\n");
        else if (typeof extract.flow === "string") text = extract.flow;
        else text = String(fallbackText || "");
        const rawLen = text.length;
        const cut = rawLen > UNIT_MAX_CHARS;      // 兜底截断：只有 P3 分配之后仍超上限才会发生
        const truncs = Array.isArray(extract && extract.truncs) ? extract.truncs.slice() : [];
        if (cut) truncs.push({ stage: "unit", kind: "(unit)", raw: rawLen, kept: UNIT_MAX_CHARS });
        const out = {
          text: cut ? text.slice(0, UNIT_MAX_CHARS) : text,
          source: src,
          chars: Math.min(rawLen, UNIT_MAX_CHARS),
          truncated: !!((extract && extract.truncated) || cut),
          truncs: truncs,
        };
        if (extract && extract.dropped) out.dropped = extract.dropped;            // 元数据透传（不重复分配）
        if (extract && Array.isArray(extract.markers)) out.markers = extract.markers;
        if (extract && extract.sampled !== undefined) out.sampled = !!extract.sampled;
        if (extract && Array.isArray(extract.segments)) out.segments = extract.segments;
        return out;
      } catch (e) {
        return { text: String(fallbackText || "").slice(0, UNIT_MAX_CHARS), source: "error", chars: 0, truncated: false, truncs: [] };
      }
    }
    // ═══ v2.8.4（P21）：把**多个文件的提取产物**并成一个单元原料 ═══
    //   为什么需要：双名目录（实测 7 个）里 legacy 与 v3 各是一段真实会话，必须**同时**进单元。
    //   为什么在这里**不做分配**：每个文件已各自受 `EXTRACT_BUDGET` 约束；合并后若超过 `UNIT_MAX_CHARS`，
    //   一律交给 `compressUnit` 的 P16 兜底并记 `truncs` —— 单一预算、单一丢失点（否则又是两套丢失点）。
    function combineExtracts(rs, consumedTotal, incomplete) {
      if (!Array.isArray(rs) || rs.length === 0) return null;
      const segments = [];
      let flow = "";
      let truncated = false, incAny = !!incomplete;
      const dropped = Object.create(null);
      const truncs = [];
      const markers = [];
      for (const r of rs) {
        if (Array.isArray(r.segments)) for (const sg of r.segments) segments.push(sg);
        if (typeof r.flow === "string" && r.flow) flow += (flow ? "\n\n" : "") + r.flow;
        if (r.truncated) truncated = true;
        if (r.incomplete) incAny = true;
        if (r.dropped) for (const k of Object.keys(r.dropped)) {
          const d = dropped[k] || (dropped[k] = { n: 0, chars: 0 });
          d.n += r.dropped[k].n || 0; d.chars += r.dropped[k].chars || 0;
        }
        if (Array.isArray(r.truncs)) for (const t of r.truncs) truncs.push(t);
        if (Array.isArray(r.markers)) for (const m of r.markers) if (markers.indexOf(m) < 0) markers.push(m);
      }
      const out = {};
      if (segments.length) out.segments = segments;
      if (flow) out.flow = flow;
      out.source = (flow && !segments.length) ? "compaction" : "messageflow";
      out.sampled = rs.some((r) => r.sampled === true);
      out.truncated = truncated; out.dropped = dropped; out.truncs = truncs; out.markers = markers;
      out.consumedFrames = consumedTotal; out.incomplete = incAny;
      return out;
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
    function readUnitCache(sid, curFrames) {
      // 批0（P0-5）加身份校验：原实现只校验 `typeof d.text === "string"` —— 缓存陈旧/被换时会被当作有效单元，
      //   而 L5778-5780 更把它当成**本轮成功**结果 ⇒ 子代理拿到旧内容却报成功、新帧从此不见。
      //   校验：① sid 与文件名一致；② frames 为有限非负数；③ 若调用方给出当前帧数且缓存帧数**大于**它
      //   （= 文件被截断/重写）→ 判为陈旧；④ **口径版本 `counterVer` 必须等于 `EXTRACT_COUNTER_VER`（P12）**。
      const p = unitCachePath(sid);
      try {
        const d = JSON.parse(fs.readFileSync(portable(p), "utf8"));
        if (!d || typeof d.text !== "string") return null;
        if (d.sid !== undefined && String(d.sid) !== String(sid)) return null;
        if (!Number.isFinite(Number(d.frames)) || Number(d.frames) < 0) return null;
        if (Number.isFinite(Number(curFrames)) && Number(d.frames) > Number(curFrames)) return null;
        // v2.8.4（P12）：**口径版本**校验（④）。提取集合/装配规则/截断策略任一变更都会 +EXTRACT_COUNTER_VER，
        //   旧口径单元必须**直接拒收**——既不得 merge 进新单元，也不得在 L5919 被当成 `staleFallback` 成功。
        //   否则"改了口径却永远复用旧产物"：P1–P18 的修复对**全部存量单元**失效且不可观测。
        if (Number(d.counterVer) !== EXTRACT_COUNTER_VER) return null;
        return d;
      } catch (e) {}
      return null;
    }
    function writeUnitCache(unit) {
      try {
        if (!unit || !unit.sid) return;
        fs.mkdirSync(portable(UNIT_CACHE_DIR), { recursive: true });
        // ★★ §9.11.4-11（B4：**写失败留痕**）—— 原实现把 `writeFileAtomic` 的返回值**丢弃**，
        //   且函数尾部是 `catch (e) { /* 忽略 */ }` ⇒ **写失败完全不可见**。
        //   为什么必须留痕（工程席 rev8k A2 的原始诉求，本项补上）：
        //     下游 `readArchiveUnitForSkip` 对"盘上无单元"只报 `no-unit-file`，**无法区分**三种成因 ——
        //       ①**写失败**（本次新写的没落盘）②**被 LRU 淘汰**（写成功过、后来被删）③**从未写**
        //     ⇒ 三种在健康行里长成一个样子，而它们的处置**完全不同**（①要重试 ②要调保留数 ③才是正常）。
        //   留痕落在**旁路账本**（`monitorEvent` → `.monitor.json`）+ 内存计数，
        //     **绝不写进受保护对象**（本批已因"把可观测量写进 fail-closed 要保护的账本"栽过一次，见 T9a-2）。
        const wRes = writeFileAtomic(portable(unitCachePath(unit.sid)), JSON.stringify(unit), { tag: "units" });   // v0.5（step1 账本闸）：统一原子写
        // `writeFileAtomic` 返回 `{ ok, readbackOk? }`；`readbackOk === false` 表示"盘上内容与预期不符"。
        if (wRes && wRes.readbackOk === false) {
          UNIT_WRITE_FAIL_SEEN++;
          cwarn("[dsh-memory] ⚠ 单元写盘**回读校验不一致**（盘上内容 ≠ 预期）：" + unitSid(unit.sid)
            + "（" + (Number(unit.chars) || 0) + " 字）⇒ 该会话本轮产物可能不可用；"
            + "下次 `readArchiveUnitForSkip` 会报 `no-unit-file`/内容不符 —— **读侧无法区分「写失败」与「被淘汰」**，故必须在此留痕。");
          try { monitorEvent("units", "write-readback-mismatch sid=" + unitSid(unit.sid) + " chars=" + (Number(unit.chars) || 0) + " fails=" + UNIT_WRITE_FAIL_SEEN); } catch (e) {}
        }
        // ★★ §9.11.4-8（**根因席 B 组 · 现场取证驱动**）：LRU 淘汰**不许静默**、**不许先删"唯一副本"**。
        //   现场实测（2026-09-19）：186 个单元里 **51 个是"唯一副本"**（对应会话未落库 `sessions/*.md`），
        //   合计 **345673 字**，且它们**恰好是最旧的一批**（08-31 起）—— 而原实现按 `at` 升序删最旧
        //   ⇒ **淘汰顺序与"谁最不可替代"完全相反**：一旦到 500（当时约 10/天 ⇒ 约 31 天后），
        //   最先被删的正是这 51 个唯一副本 ⇒ 那 34.6 万字 **logs 搜不到、units 也搜不到**（彻底消失）。
        //   修法三条：①**优先淘汰"已落库"的**（还有别处副本，删了仍搜得到）；
        //             ②唯一副本**只在极端情况**才动（超出硬上限 `UNIT_CACHE_ONLY_COPY_HARD` 时，且留痕）；
        //             ③删除**一律留痕**（`monitorEvent` + `cwarn`），并写明"删了几个、其中几个是唯一副本"。
        try {
          const files = fs.readdirSync(portable(UNIT_CACHE_DIR)).filter((f) => f.endsWith(".json"));
          if (files.length > UNIT_CACHE_KEEP) {
            const metas = files.map((f) => {
              let d = null; try { d = JSON.parse(fs.readFileSync(portable(UNIT_CACHE_DIR + "/" + f), "utf8")); } catch (e) {
                // ★ 读不出来的单元**不得当成"可删"**（它可能正是唯一副本，只是文件损坏）⇒ 归入"保留"侧并留痕
                return { f: f, at: 0, sid: "", onlyCopy: true, unreadable: true };
              }
              const sid = String((d && d.sid) || "");
              // ★★ 口径修正（**我在设计时就该查实**）：单元里的 `sid` 是**完整 id 且无 `session-` 前缀**
              //   （现场：`199d8584-d66…`），而 `sessions/*.md` 的块头写的是 **12 位短 id**（`### 199d8584`）。
              //   而 `sessionMentionedInMemory(sid)` 用的是"完整 id / 去前缀完整 id" ⇒ **匹配不到 `### <sid12>`**
              //   ⇒ 直接拿它判"是否已落库"会把**所有已落库单元也当成唯一副本**（保护过度、永不淘汰）。
              //   ⇒ 必须用 **`unitSid(sid)`（= 去前缀取 12 位）**去查。两条判据取"或"（任一命中即算有副本）。
              const landed = sessionMentionedInMemory(sid) || sessionMentionedInMemory(unitSid(sid));
              return { f: f, at: (d && d.at) || 0, sid: sid, onlyCopy: !landed, unreadable: false };
            });
            // ★★ §9.11.4-8（**为可测而抽纯函数**，同本批 `applyOverLimitHintEntry`/`distributeOffsets` 的范式）：
            //   淘汰**顺序决策**抽成模块级纯函数 `evictUnitCachePlan` 并导出 —— 否则门只能"自写复算"，
            //   那等于**门在测自己**（我第一版就是这么写的：`T10a/T10b` 在新旧字节上都 PASS = vacuous）。
            //   现在门直调它 ⇒ 断言红绿**由产品字节决定**。
            const plan = evictUnitCachePlan(metas, UNIT_CACHE_KEEP, UNIT_CACHE_ONLY_COPY_HARD);
            const all = plan.evict;
            const fromOnly = all.filter((x) => x.onlyCopy === true);
            for (const x of all) { try { fs.unlinkSync(portable(UNIT_CACHE_DIR + "/" + x.f)); } catch (e) {} }
            if (all.length > 0) {
              const sids = all.slice(0, 6).map((x) => (x.sid ? x.sid.replace(/^session-/, "").slice(0, 8) : x.f.replace(/\.json$/, "")));
              clog("[dsh-memory] 单元缓存淘汰 " + all.length + " 个（保留 " + UNIT_CACHE_KEEP + "；其中**唯一副本** " + fromOnly.length + " 个"
                + (fromOnly.length > 0 ? "——已超硬上限 " + UNIT_CACHE_ONLY_COPY_HARD + "，请人工核查这些会话的正文是否已落库" : "（优先淘汰的是已落库会话，正文仍可在记忆库检索）")
                + "）: " + sids.join(", "));
              try { monitorEvent("units", "lru-evict n=" + all.length + " keep=" + UNIT_CACHE_KEEP + " onlyCopyEvicted=" + fromOnly.length + " items=" + sids.join("|")); } catch (e) {}
              if (fromOnly.length > 0) cwarn("[dsh-memory] ⚠ 单元缓存淘汰了 " + fromOnly.length + " 个**唯一副本**（该会话正文只存在于单元里、未落库）⇒ 这些内容此后 logs/units 都搜不到。请核对：" + sids.join(", "));
            }
          }
        } catch (e) {}   // LRU 段自身失败不连带写失败留痕（见下）
      } catch (e) {
        // ★★ §9.11.4-11（B4）：**写路径的异常必须留痕**。原为 `catch (e) { /* 忽略 */ }` ⇒
        //   `mkdirSync` 失败（权限/路径）、`writeFileAtomic` 抛错（磁盘满 / EACCES / rename 失败）
        //   全部**静默**，而下游只看得到"盘上没单元"。落在旁路账本 + 内存计数，不写受保护对象。
        UNIT_WRITE_FAIL_SEEN++;
        cwarn("[dsh-memory] ⚠ **单元写盘失败**（" + unitSid(unit && unit.sid) + "）：" + (e && e.message ? e.message : String(e))
          + " —— 该会话本轮产物**未落盘**；下游只会看到 `no-unit-file`（**读侧区分不出「写失败」与「被淘汰」**）。"
          + "连续出现通常意味着缓存目录不可写或磁盘已满。");
        try { monitorEvent("units", "write-fail sid=" + unitSid(unit && unit.sid) + " err=" + String((e && e.message) || e).slice(0, 80) + " fails=" + UNIT_WRITE_FAIL_SEEN); } catch (e2) {}
      }
    }
    // 合并：补档轮次的单元重组织
    // ═══ v2.8.4（P17 → 评审组裁决后**重写方向**）═══
    // 【原缺陷】原实现 `full = 【已归档部分】+旧 + 【新增部分】+新` 再 `full.slice(0, UNIT_MAX_CHARS)`
    //   ⇒ 旧在前、头截断 ⇒ **整段吃掉「新增部分」**；而本轮 `consumedFrames` 已推进到文件尾 ⇒ 该轮新增
    //   **永不重试**。根因席判定与原案**同型**（切点在模型视野之前 + 内容对模型不可见 + 水位照常推进），
    //   且因产物**写回缓存成为下一轮 `old`** 而**更硬**：一旦 `len(old)` 触顶，此后每轮新增 100% 被吃。
    //   实测（`_probe-merge-overflow.mjs`，真机 7 个双名会话）：**3/7 命中溢出**，旧方向下丢 **8905 字符**新增。
    // 【裁决】三席一致否决旧方向。旧段去留的分歧由**仓内既有契约**裁定：
    //   归档块头对 `isRe` **已经**自称 `【补档第N轮·**仅含新增帧**】`（`L6290`），提示词第 1b 条亦写
    //   「本次消息流**只含上次归档之后的新增内容**」（`L6307`）⇒ **拼入旧段是本函数违反自身下游契约**，
    //   不是特性。故本函数取 **(D) 不自增**：`unit.text` = **仅新增**，与块头声明一致、零溢出、无标签嵌套。
    // 【被否决的两案及其复活条件】（留档，避免以后重复争论）
    //   · (B)「保新 + 旧段按余额补」/ (E)「旧段按字面量筛行」：只有在**同时改提示词**（允许"补齐旧轮遗漏的
    //     字面量"）时才有收益 —— 现行 1b 明令"只写新增部分的新事实"，旧段进了 prompt 也只能当噪声；
    //     且填满旧段**不是免费的**：`bucketUnits` 用 `text.length` 计 `BUCKET_BUDGET_CHARS=60000`
    //     ⇒ 单元越满、每批装得越少、子代理批数与 token 越多。
    //   · (A)「保旧丢新 + 只记账」：记账 ≠ 可见（`dropped` 迄今无任何消费者 ⇒ 由 P18 补读者），
    //     且水位照常推进 ⇒ 不可重试 ⇒ 构成静默丢失。
    // 【配套依赖】选 (D) 之后，旧正文不再随本轮提供，其结论只由提示词另给的
    //   `extractExistingArchiveBlock(sid)`（旧要点）承载 ⇒ **必须**与 P18（账本内容见证 + 指定读者）
    //   同批上线，否则"上轮要点因写盘失败却照样消号"时旧段即成最后一份材料（工程席 falsifier）。
    // 历史标签剥离（只为**兼容存量缓存**）：2026-09-18 之前写入的单元可能带着
    //   `【已归档部分（上次提取）】`/`【新增部分（本次提取）】` 头（旧方向留下的），新方向不再产生它们。
    const MERGE_OLD_LABEL = "【已归档部分（上次提取）】";
    const MERGE_NEW_LABEL = "【新增部分（本次提取）】";
    function stripMergeLabels(t) {
      return String(t || "").split(MERGE_OLD_LABEL).join("").split(MERGE_NEW_LABEL).join("").replace(/^\s+/, "");
    }
    function mergeUnitCache(oldUnit, newUnit, curFrames, round) {
      if (!oldUnit && !newUnit) return null;
      const sid = (newUnit && newUnit.sid) || (oldUnit && oldUnit.sid) || "?";
      const newText = (newUnit && typeof newUnit.text === "string") ? newUnit.text : "";
      const oldText = stripMergeLabels(oldUnit && oldUnit.text);
      // 历史账（逐 kind 累计）——但 `(merge-overflow)` 是**本轮量**，下面单独写，绝不被历史值覆盖：
      //   原实现"先写本轮、再用 `oldUnit.dropped` 整体覆盖" ⇒ 账里存的是**上一轮**的字符数，
      //   而 `truncs` 是本轮正确值 ⇒ GA19 的独立复算必然对不平（工程席复核）。
      const dropped = {};
      for (const src of [oldUnit, newUnit]) {
        if (!src || !src.dropped) continue;
        for (const k of Object.keys(src.dropped)) {
          if (k === "(merge-overflow)") continue;
          const a = dropped[k] || (dropped[k] = { n: 0, chars: 0 });
          a.n += src.dropped[k].n || 0; a.chars += src.dropped[k].chars || 0;
        }
      }
      // 新增为空 ⇒ **绝不写空单元覆盖旧缓存**（否则 `readUnitCache` 下一轮读到空文本、该会话链路断掉）
      if (!newText.trim()) {
        if (!oldText.trim()) return null;
        return Object.assign({}, oldUnit, {
          sid: sid, frames: curFrames, round: round, at: Date.now(), source: "merged", staleFallback: true,
          text: oldText, chars: oldText.length, counterVer: EXTRACT_COUNTER_VER, dropped: dropped,
        });
      }
      const text = newText.slice(0, UNIT_MAX_CHARS);          // ★ 新增全额优先（唯一不可让的部分）
      const cut = newText.length - text.length;
      const truncs = Array.isArray(newUnit.truncs) ? newUnit.truncs.slice() : [];   // 只留本轮（原来逐轮 concat ⇒ 单调膨胀）
      if (cut > 0) {
        truncs.push({ stage: "merge", kind: "(merge-new-truncated)", raw: newText.length, kept: text.length });
        dropped["(merge-overflow)"] = { n: 1, chars: cut };
      }
      return {
        sid: sid, frames: curFrames, round: round, at: Date.now(), text: text,
        source: "merged-newonly",                            // 门可据此分辨"合并出问题"（工程席主张①）
        chars: text.length, counterVer: EXTRACT_COUNTER_VER,
        truncated: !!(cut > 0 || (newUnit && newUnit.truncated)),
        truncs: truncs, dropped: dropped,
        newTruncated: cut > 0,                               // 守卫标记：新增**自身**被截（供 P18 读者）
        prevArchivedChars: oldText.length,                   // 旧正文去向**显式化**（避免"消失得无声"）
        prevArchivedIn: "ledger-points",                     // 由提示词的「已归档要点」块承载
      };
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

// 会话 id 是否已出现在记忆库 sessions/ 文件中（出现过 = 曾被总结/落档）。
// ★★ §9.11.4-8（**现场取证驱动**，2026-09-19）：**口径修正 + 用途澄清**（原实现有一处 3 年未察觉的错配）
//   【错配】原判据只有两种形态：**完整 id**（`session-<uuid>`）与**去前缀完整 id**（`<uuid>`）。
//     而 `sessions/*.md` 的归档块头写的是 **`### <sid12>`**（= 去 `session-` 前缀取 **12 位**，现场形态
//     如 `### 7fbd82f9-ff9`）⇒ **两种形态都匹配不到**。
//     现场实测（289 个已归档会话）：**原口径只命中 4 个（1.4%）**，加上 12 位短 id 后命中 **145 个**。
//     ⇒ 那条"出现过就不再视为漏网"的防线**实际上几乎不存在**（注释里"凡内容落过盘的会话永远进不了候选"
//       与事实**相反** —— 已在下方 `shouldReArchive` 注释处一并更正）。
//   【修正】补第三种形态：**12 位短 id**（`unitSid()` = 去前缀取 12 位）⇒ 与块头口径对齐。
//   【用途澄清（关键）】修好之后它**仍然不能当"禁止再归档"的硬闸**：
//     `·补N` 是**正常特性**（续聊增量重档，现场取证：同一会话多块之间**内容 0 重叠**，非重复归档；
//     `a79f71f7-25c` 正当补了 3 轮）⇒ 若拿它挡补档，**续聊将永不补档**。
//     ⇒ 它只应参与"**首次归档**"的去重（见 `shouldReArchive` 里 `首次` 分支的用法与门 `T11` 的反空洞断言）。
function sessionMentionedInMemory(sessionId) {
  if (MEMORY_SESSIONS_INDEX === null || Date.now() - MEMORY_SESSIONS_INDEX_AT > 300000) refreshMemorySessionsIndex();   // v2.0.9(L4): 5 分钟 TTL
  const idx = MEMORY_SESSIONS_INDEX || "";
  const idShort = sessionId.replace(/^session-/, "");
  const id12 = unitSid(sessionId);   // ★ 走 `unitSid()` 单点所有者（**GR23b 宽度守则**：非注释行不许裸 `slice(0,12)` 作用于 sid —— 一致性门当场抓住了我第一版的写法）
  return idx.includes(sessionId) || idx.includes(idShort) || idx.includes(id12);
}
// ★★ B1′（2026-10-07 现场）：盘面**强证据**判据 —— sessions/*.md 里是否已有该会话的**归档块头**。
//   与落盘段 `existing.includes("### " + it.sid)` **同一口径**（不新造第二条判据）；
//   只认 `### ` 前缀 ⇒ 压缩检查点（`<!-- intent: … sid:<sid8> -->`）与正文提及都不会命中。
function archiveBlockOnDisk(sessionId) {
  if (MEMORY_SESSIONS_INDEX === null || Date.now() - MEMORY_SESSIONS_INDEX_AT > 300000) refreshMemorySessionsIndex();
  return (MEMORY_SESSIONS_INDEX || "").includes("### " + unitSid(sessionId));
}
// ★★ B1′：把"盘上已归档"补记进账本（幂等）。水位基准优先取该会话单元的 frames（= 块覆盖到的那一帧）；
//   取不到则 0（⇒ 下轮整段重提取为补档，宁可多跑一轮，不静默跳帧）。
//   round 固定 **2**：块已在盘上 ⇒ 该会话的下一轮**按定义是补档**（兑现"提及闸不得挡补档"）。
function backfillArchivedFromDisk(s) {
  try {
    if (ARCHIVED_SESSIONS.has(s.id)) return false;
    let base = 0;
    try {
      const u = readArchiveUnitForSkip(s.id);
      if (u && u.ok && u.file) {
        const d = JSON.parse(fs.readFileSync(portable(ARCHIVE_UNITS_DIR + "/" + u.file), "utf8"));
        if (typeof d.frames === "number" && d.frames > 0) base = d.frames;
      }
    } catch (e) {}
    ARCHIVED_SESSIONS.add(s.id);
    ARCHIVE_WATERMARK.set(s.id, { frames: base, round: 2, at: Date.now(), incomplete: false, byFile: null,
      witness: { mode: "backfill-from-disk", points: 0, chars: 0, reason: "sessions/ 已有归档块但账本无收据（部分失败轮）" } });
    ARCHIVE_WM_DIRTY = true;   // 与懒置基线**同一落盘通道**（saveStaleNotified 在闭包内，本函数在模块级 ⇒ 不许直接调）
    clog("[dsh-memory] 账本回填：sessions/ 已有归档块但账本无收据 ⇒ 记 archivedSessions + 水位（round=2, frames=" + base + "）：" + unitSid(s.id));
    monitorEvent("archive", "ledger-backfill-from-disk " + unitSid(s.id) + " base=" + base);
    return true;
  } catch (e) { return false; }
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
  if (!ARCHIVED_SESSIONS.has(s.id)) {
    // ★★ B1′（2026-10-07 现场取证）：**块已在盘上、账本没有收据** —— doneOk=false 的部分失败轮
    //   （整轮与门）把已落盘的会话留在"首次归档"档 ⇒ 提及闸永久挡死它、连补档都进不去
    //   （补档要 round>=2 的水位）。修法 = **按盘面强证据回填账本**（不是放宽提及闸）。
    //   ★ 判据只用 `### <sid12>`（归档块头，与落盘段「已在库」判据同一口径）；
    //     **绝不**把 `sid:<sid8>`（压缩检查点）或正文提及当证据 —— 检查点 ≠ 归档。
    if (archiveBlockOnDisk(s.id)) { backfillArchivedFromDisk(s); return false; }
    return true;
  }
  // v2.6.5: 水位帧数也必须走新名解析——旧硬编码对 v3-only 会话恒返回 null，
  //   而本函数把 null 当作「读不到日志 = 保守不打扰」→ 归档过的会话续聊永不重档（设计退化）
        // v2.8.4（P21/P22）：`cur` 用**同目录全部日志的 sum(frames)** —— 量纲必须与账本 `wm.frames` 一致，
        //   否则双名会话因「按优先级只读到 v3」而 `cur` 恒小于 legacy 时代的水位 ⇒ 永不重入（实测 6/7 命中）。
        const wmPaths = resolveSessionLogPaths(SESSIONS_ROOT + "/" + s.ws + "/" + s.id);
        const cur = wmPaths.length ? sessionFramesTotal(wmPaths) : null;
  if (cur === null) return false;
  const wm = ARCHIVE_WATERMARK.get(s.id);
  if (!wm) {
    // ★★ §9.11.4-10（**现场取证驱动：103 个"已归档但从未提取"的会话**）。
    //   【原行为】无条件懒置基线 `{frames: cur, round: 1, at: now}` 并 `return false`（判"不待归档"）。
    //   【实测缺陷】取证 2026-09-19：289 个已归档会话里 **103 个无单元**，且**全部**呈现同一签名 ——
    //     `round=1` ∧ **无 `byFile`**（`byFile` 只在真提取时写）∧ `frames>0` ∧ 无单元文件 ∧
    //     `empty`/`skipped`/`incomplete` 全为假（账本自己**不声称**它们"确无内容"）。
    //     时间分簇：08-30 两簇 n=69+28 **有单元 0**；08-31 起各簇有单元数 ≈ 簇大小 ⇒
    //     **是这条路径在批量为"从未提取"的会话盖"已消费"章**。且**34 个发生在 09-16 之后**（至今仍在发生）。
    //   【后果】水位被基线化到当前帧数 ⇒ 重入条件 `cur > wm.frames` 需**新增**帧才成立 ⇒
    //     该会话既有正文**永不提取**；若它此后再无新增 ⇒ **永久漏档**（只剩原始日志可 grep）。
    //     用户诉求原话：「有些内容在记忆中可能不准确或者没计入」——这就是那个形态。
    //   【修法】懒置基线**不再是无条件**：先问"这本账有没有**证据**表明它已被消费"。
    //     允许懒置（保持原语义）的条件 —— 满足**任一**：
    //       ① 盘上有单元文件（`readArchiveUnitForSkip(s.id).ok === true`）⇒ 确实提取过；
    //       ② 水位表里有该 id 的**任一形态**条目（下面 `wm` 已为假，故此处查"确无内容"的**旁证**：
    //          `archiveWmEmpty`/`archiveWmSkipped` 是**计数**不是逐 id 记录 ⇒ 不适用；改用最可靠的盘面事实）。
    //     否则 ⇒ **不懒置**，直接 `return true`（判"待归档"）⇒ 它会进候选、被真提取、落库。
    //   【为什么不是"一律 return true"】那会让**真正无内容**的历史会话每轮重选（僵尸候选每轮白轮、
    //     并把真新会话压进退避）—— 正是本批 T5/修正十一反复处理的老问题。
    //     `readArchiveUnitForSkip` 正是"该会话有没有可复用内容"的**既有单一判据** ⇒ 复用它，不自造第二条。
    //   【代价与边界，如实】①每会话多一次单元读盘（仅"在已归档集但无水位"这一小群，非热路径）；
    //     ②"确无内容"且**从未提取过**的会话会被真提取一次：提取器对无正文日志返回 `empty`，
    //       落盘段随即写 `empty:true` 水位并消号 ⇒ **一次性收敛**，不会长期烧轮；
    //     ③它**不**改变"有水位"会话的任何行为（下面那条 `cur > wm.frames` 原样）。
    let hasUnit = false;
    try { hasUnit = readArchiveUnitForSkip(s.id).ok === true; } catch (e) { hasUnit = false; }
    if (!hasUnit) {
      // 不盖"已消费"章 ⇒ 交回候选判定（`shouldReArchive` 的 mention 闸仍会照常拦已落库会话）。
      try { monitorEvent("archive", "no-baseline pending（已归档但无水位且盘上无单元 ⇒ 不再懒置基线，转真提取）: " + unitSid(s.id)); } catch (e) {}
      return true;
    }
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
        INJECT_SNAPSHOT.set(k, { g: v.g, i: v.i, s: v.s, t: v.t || 0, used: v.used === undefined ? undefined : v.used, p: typeof v.p === "string" ? v.p : undefined });   // v2.7.0（拆 fixed）：原还带 f=耐久层 hash（读端白名单同型 bug 史见 L3314）；层已拆故字段删除
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
  INJECT_SNAPSHOT.set(sessionId, { g: entry.g, i: entry.i, s: entry.s, t: Date.now(), used: prev && typeof prev.used === "boolean" ? prev.used : (prev ? (prev.used === undefined ? undefined : prev.used) : false), p: entry.p !== undefined ? entry.p : "", f: entry.f !== undefined ? entry.f : (prev && typeof prev.f === "string" ? prev.f : "") });   // v2.4.24（审查 P0-1）：p 字段透传；v2.6.8：f 字段同规（未传则保留 prev）
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
        // v2.8.4（P21）：**任一文件命中即 true**。旧实现只看优先级最高的一个文件 ⇒ 双名会话里
        //   若 v3 只有插件注入的回合、真实用户回合在 legacy，会被判为「未使用」而错误地纳入漏网。
        const zs = resolveSessionLogPaths(path.join(SESSIONS_ROOT, ws.name, s.name));
        if (!zs.length) return true;   // 找不到日志 → 视为已用（保守方向安全）
        let anyReadable = false;
        for (const zp of zs) {
          const txt = decompressSessionLog(zp);
          if (txt === null) continue;                      // 该文件读不到 ⇒ 看下一个（而不是立刻保守 true）
          anyReadable = true;
          // 真实用户回合判定：日志含 turn/start，或含 user/message 且 source.kind=user（排除插件/系统 source）
          if (txt.includes('"type":"turn/start"')) return true;
          // [2026-09-23 V4] 旧正则尾部 "user"/ 在 V3 时代即从未命中（实为死代码，全靠 turn/start）；
          //   且 user/message 的 content 可长达数万字符排在 source 前，400 窗口必漏。日志一行一事件 ⇒ 同行判真。
          {
            const tls = txt.split("\n");
            for (const ln of tls) {
              if ((ln.includes('"type":"user/message"') || ln.includes('"type": "user/message"'))
                && (ln.includes('"kind":"user"') || ln.includes('"kind": "user"'))) return true;
            }
          }
        }
        return anyReadable ? false : true;   // 全部读不到 → 仍走保守方向（视为已用）
      }
    }
    return true;   // 全局找不到该会话目录 → 视为已用（保守方向安全）
  } catch (e) { return true; }
}

// v1.3.0：可配置项（cordis.patch.yml 的 config 字段覆盖；未配置时用默认值）
//  - staleSessionDays: 漏网会话检测阈值（天），默认 5
//  - staleAction:      漏网处理动作（v1.12.18 起同时决定 /dream 是否带归档）：remind=仅提醒，/dream 不含归档 | silent=后台自动归档，/dream 先归档再整合 | approval=确认后才归档，/dream 不含归档
// v1.7.1：默认 staleAction=remind（仅提醒，不自动 spawn 子代理——实测漏网归档子代理单会话可烧数百万 token）
const DEFAULT_CFG = { staleSessionDays: 5, staleAction: "remind", integrateEnabled: false, integrateDays: 7, active: true, monitorEnabled: true, spiralRemind: true, initGuideEnabled: true, updateCheckEnabled: true, regressionEnabled: true, maintTriggerChars: 1100, spiralBreak: true, brkLevel: 3, brkHardAbort: false, brkSameN: 3, brkMaxDeny: 3, brkMinSteps: 4,
  // v3.2.0（2026-10-02 Wave 1）：折叠「一次逻辑调用被观测两次」——ptc 嵌套调用与其外壳 run_code 各产生一次观测
  //   （2026-10-02 红队实证：同一次 pwsh 失败被双计 neg、两侧 resKey 略异又虚增 uniq ⇒ 被 batchLike 误判成"批量进展"）。
  //   默认开；置 false 即回退旧口径（诊断对照用，不暴露到设置页以免动 client 半区）。
  spiralFoldPtc: true,
  // v3.2.0（2026-10-02 Wave 2 候选 C，用户拍板「直接上候选 C」）：batchLike（批量样态）命中**不再硬静默**，
  //   改为「降级投递 + 冷却加倍」。动因：实测该判据把 67% 的 D 命中段整段判成"不需要提醒"
  //   （09-29~10-01 连续 7 次命中全静默）；2026-10-02 18:49:48 真实埋点显示该类窗口 uniq=5/len=5/okN=3，
  //   候选 A 也救不了。置 false = 回退旧口径（硬静默，只记 reason="batch"）。
  batchSoftDeliver: true };

// v2.6.5（2026-09-16 用户拍板）：手动 /dream 的漏网口径不吃 settings.staleSessionDays。
//   用户实证诉求：阈值设 1 天，但会话实际 12 小时就结束了 → 手动触发时就该收走它。
//   手动改固定「活跃下限」30 分钟——只挡仍在写入的活跃会话（含发起会话本身），否则会把
//   进行中的半截内容当成完整会话归档。其余条件（启用界限/未落档/账本水位）不变；
//   自动定时整合与 stale_archive 工具仍按 settings。数值调整只需改这一个常量。
const MANUAL_STALE_MIN_IDLE_MS = 30 * 60000;

// v2.6.6（用户拍板「dream 的等待时间也可以适当放长一点」）：手动 /dream 归档阶段等待上限 25 → 45 分钟。
//   理由：并发闸生效后（在跑 ≤5、其余排队）队列清空更慢——31 会话/7 批约 2 轮、59 会话约 3 轮，
//   旧 25 分钟容易把「等归档结算」判成 timeout 而提前整合。两处等待（等已有归档 / 等自己发起的归档）共用本值。
const DREAM_ARCHIVE_WAIT_MS = 45 * 60000;
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

// ═══════════ [2026-09-23] 用户配置层（插件自持久化）═══════════
// 背景：dsh 0.1.7 的 config-editor 写回校验走 composeEntries(55 层)，本地插件条目
//   （profile 顶层 insert 注册）写入恒被拒（"overridden by a home patch"，已实测取证：
//   docAfter 已改成 12 而 composed 仍为 {}）。故本插件改用**自持久化**：
//   设置页 → POST /dsh-memory/config → 写本文件 → 热更新 PLUGIN_CFG + 回读校验。
// 优先级（高→低）：.config.json(本层) > cordis.patch.yml 的 config(loader 层) > DEFAULT_CFG
//   启动时打印实际来源，消除"两个真源"的歧义。
const USER_CFG_FILE = portable(path.join(MEMORY_ROOT, ".config.json"));
function readUserCfg() {
  try {
    if (!fs.existsSync(USER_CFG_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(USER_CFG_FILE, "utf8"));
    return (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  } catch (e) { return {}; }
}
function writeUserCfg(obj) {
  const tmp = USER_CFG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, USER_CFG_FILE);          // 原子替换，防半截文件
  const back = readUserCfg();                  // 回读校验（防 OneDrive 占位/静默截断）
  return JSON.stringify(back) === JSON.stringify(obj);
}
// 合并三层：默认 → loader config → 用户文件（用户文件最后覆盖）
function mergeCfgLayers(loaderCfg) {
  return { ...DEFAULT_CFG, ...(unwrapVolatile(loaderCfg) || {}), ...readUserCfg() };
}

// v1.4.0：settings 命名空间 schema（设置 UI 渲染 + 校验；用户文档覆盖 base）
// schemastery 语法：无 .int()/z.enum —— 整数用 number().min().max()，枚举用 union([const...])
const SETTINGS_SCHEMA = z.object({
  staleSessionDays: z.number().min(1).max(90).default(DEFAULT_CFG.staleSessionDays).volatile(),
  staleAction: z.union([z.const("remind"), z.const("silent"), z.const("approval")]).default(DEFAULT_CFG.staleAction).volatile(),
  // v1.5.0：定期自动整合（对标 mimocode AutoDream）
  integrateEnabled: z.boolean().default(false).volatile(),          // 开关：每 integrateDays 天自动整合记忆（默认关闭，避免自动耗 token）
  integrateDays: z.number().min(1).max(90).default(7).volatile(),   // 整合间隔（天）
  // v1.11.0：记忆活跃开关（独立于 DSH 进程启停）——用户显式控制；DSH 重启不改变它
  active: z.boolean().default(true).volatile(),
  // v1.12.0：使用监控开关（默认开）——记录提醒/查询/错误事件到 .monitor.json，设置界面显示汇总
  monitorEnabled: z.boolean().default(true).volatile(),
  // v2.0.2：LLM循环试错提醒（D类）——打转探针双条件命中时注入提醒；关闭则回退纯影子记录
  spiralRemind: z.boolean().default(DEFAULT_CFG.spiralRemind).volatile(),
  // v0.5：回归闭环开关（默认开）——B/C 触发后自动捕捉错误上下文落 pending-lessons + 被动监测闭环；关闭则完全回现状
  regressionEnabled: z.boolean().default(DEFAULT_CFG.regressionEnabled).volatile(),
  // v2.3.0：新装用户初始化引导开关（关＝不再自动提，/memory-init 仍可用）
  initGuideEnabled: z.boolean().default(DEFAULT_CFG.initGuideEnabled).volatile(),
  // v2.3.0：升级检查开关（每天最多一次远端 version.txt 比对；离线/内网失败静默）
  updateCheckEnabled: z.boolean().default(DEFAULT_CFG.updateCheckEnabled).volatile(),
  // v2.6.0：LLM 打转熔断（D 级分级执法）——spiralBreak=D2 拒调总开关；brkLevel=D3 停轮深度（2=D1+D2 / 3=+D3）；brkHardAbort=D4 硬中断独立开关（默认关，最激进）；brkSameN/brkMaxDeny/brkMinSteps=判定阈值（True effectiveSpiralThresh 侧进覆盖层，此处进 schema 供设置 UI）
  spiralBreak: z.boolean().default(DEFAULT_CFG.spiralBreak).volatile(),
  brkLevel: z.number().min(1).max(3).default(DEFAULT_CFG.brkLevel).volatile(),
  brkHardAbort: z.boolean().default(DEFAULT_CFG.brkHardAbort).volatile(),
  brkSameN: z.number().min(2).max(6).default(DEFAULT_CFG.brkSameN).volatile(),
  brkMaxDeny: z.number().min(1).max(6).default(DEFAULT_CFG.brkMaxDeny).volatile(),
  brkMinSteps: z.number().min(1).max(5).default(DEFAULT_CFG.brkMinSteps).volatile(),
  // v0.5（step5-1 档）：合并维护触发阈值（真实要点面字符数；[600,1500]，默认 1100 目标水位≈预算×73%）
  maintTriggerChars: z.number().min(600).max(1500).default(DEFAULT_CFG.maintTriggerChars).volatile(),
  // 只读：监控汇总（客户端展示），宿主写入
  monitorSummary: z.string().required(false),
  // v2.3.0 只读：版本与初始化状态一行（客户端展示），宿主写入
  onboardSummary: z.string().required(false),
  // 只读统计：漏网（未整合记忆）会话数量，由宿主在检测后写入；非用户编辑项
  // schemastery 对象字段默认可选；required(false) 显式标注
  staleCount: z.number().min(0).required(false)
});
// v1.4.0：宿主侧 settings scope（register 返回），用于写只读统计 staleCount
// [2026-09-23 dsh 0.1.7 适配] 旧 settings.register/get/watch/update 全套 API 已删除，HOST_SETTINGS_SCOPE 恒为 null（保留变量防旧引用 ReferenceError）。
//   新模型：本文件导出 Config（用户字段 volatile，免 remount 热更新）；只读统计改走 LIVE_STATS，随 /dsh-memory/stats.json 下发。
let HOST_SETTINGS_SCOPE = null;
let LIVE_STATS = { staleCount: 0, monitorSummary: "", onboardSummary: "" };
// loader 原子语义：本模块的 Config 即 fiber.runtime.Config；volatile-only 变更提交进运行引用 + 触发 loader/volatile-update（监听见 apply）。
export const Config = SETTINGS_SCHEMA;

// v2.8.4（T2·**生效配置可见**）：启动横幅那行读的是 `config`（cordis base 默认层），**不是**生效值 ——
//   实测（2026-09-18 20:43:55 重启）：横幅打 `staleSessionDays=5 staleAction=remind integrate=关`，
//   而 `~/.dsh/settings.yaml` 的 `dsh-memory:` 段写的是 `2 / silent / true`；行为侧硬证据：20:44:13 的自动归档 tick
//   在账本留下 `archiveAutoLast.why = "未发起：…"` —— 该键**唯一写入者**是 `archiveAutoNote`（调用点全在 `runStaleSilentTick`），
//   且「未发起：」这个前缀只在 **silent 闸之后**那一行生成 ⇒ **生效值 = silent**（若 not-silent，why 会是「非 silent 档或无 zstd」）。
//   ★ 论证链更正（根因席复核 2026-09-18）：原写"必先过 `staleAction !== "silent"` 检查"是**顺序说反**——15 分闸在
//     `runStaleArchive` 内、silent 闸在其调用方里，而 `runStaleArchive` 有 ≥4 个调用方 ⇒ 非 silent 档也能撞上 15 分闸；
//     唯一点：**why 的写入点**。即横幅把"自动归档 + 自动消号 = 开着"报成了"只提醒"（方向最危险的那种错）。
//   本函数在 settings 层真身就位处再报一行，并明写"以本行为准"。
function cfgEffectiveLine() {
  return "[dsh-memory] 生效配置（settings 层；★此行才是真值，上方「就绪」行是默认层）：staleSessionDays=" + PLUGIN_CFG.staleSessionDays
    + " staleAction=" + PLUGIN_CFG.staleAction + (ZSTD_OK ? "" : "(降级remind:无zstd)")
    + " active=" + PLUGIN_CFG.active
    + " integrateEnabled=" + (PLUGIN_CFG.integrateEnabled ? "true(" + PLUGIN_CFG.integrateDays + "天/次)" : "false")
    + " monitorEnabled=" + PLUGIN_CFG.monitorEnabled;
}

// 归一化配置：settings 值或 cordis config → 合法 PLUGIN_CFG
// [2026-09-23] 新模型下 volatile 字段在 fiber.config 里是引用（须 .get() 解包，对标 cosmokit createVolatile / settings plainConfig）
function unwrapVolatile(v) {
  if (Array.isArray(v)) return v.map(unwrapVolatile);
  if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;   // Map/Set/Date 等实例原样（volatile 引用恒为普通对象）
    if (typeof v.get === "function") { try { return unwrapVolatile(v.get()); } catch (e) { return undefined; } }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = unwrapVolatile(val);
    return out;
  }
  return v;
}
function normalizeCfg(raw) {
  const cfg = { ...DEFAULT_CFG, ...(unwrapVolatile(raw) || {}) };
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
'      var injLayer = sec.layer === "稳定层" || sec.layer === "会话层（今日）";   // v2.7.0（拆 fixed）：原白名单第三项「耐久层」已删\n' +
'      h += \'<div class="docsec"><div class="dsl">\' + esc(sec.layer) + (injLayer ? "" : " <span class=\'tag\'>按需</span>") + "</div>";\n' +
'      if (sec.note) h += \'<div class="muted" style="font-size:12px;line-height:1.6;margin:-2px 0 6px">\' + esc(sec.note) + "</div>";   // v2.5.6：会话层总量提示（防误判日文件丢失）\n' +
'      for (var di2 = 0; di2 < sec.docs.length; di2++) {\n' +
'        var dc = sec.docs[di2];\n' +
'        var over = injLayer && (dc.overSoft || dc.overHard || dc.nearHard) ? " <span class=\'tag warn\'>" + (dc.overHard ? "硬超" : (dc.nearHard ? "近限" : "软超")) + "</span>" : "";\n' +
'        var staleTag = dc.stale ? " <span class=\'tag stale\'>过期复核</span>" : "";\n' +
'        var bigTag = !injLayer && dc.bytes > 65536 ? " <span class=\'tag\'>大文件</span>" : "";\n' +
'        var capTag = (dc.rel || "").indexOf("projects/") === 0 ? (dc.chars > 9000 ? " <span class=\'tag\' style=\'color:#c0392b\'>超限</span>" : (dc.chars > 6000 ? " <span class=\'tag\' style=\'color:#b7950b\'>偏大</span>" : "")) : "";\n' +
'        var wp = injLayer ? Math.min(100, Math.round(dc.chars * 100 / Math.max(1, dc.charLimit))) : 0;\n' +
'        var rectCol = injLayer ? (dc.overHard ? "linear-gradient(90deg,#ff4d6d,#ff6e8a)" : (dc.nearHard ? "linear-gradient(90deg,#ffc94d,#ffd97a)" : (dc.overSoft ? "linear-gradient(90deg,#ff9d3d,#ffb45b)" : "linear-gradient(90deg,#12b886,#39d9b0)"))) : "linear-gradient(90deg,#5ba7ff,#7db8ff)";\n' +
'        h += \'<div class="drow"\' + tip(dc.rel + "\\n字符 " + num(dc.chars) + (injLayer ? " / 硬限 " + dc.charLimit + "（告警线 " + dc.warnChars + "）\\n字节 " + num(dc.bytes) + "B / 兜底线 " + dc.byteWarn + "B" : "\\n字节 " + num(dc.bytes) + "B（按需读取层，无注入预算，大文件属正常）") + "\\n更新 " + fmtT(dc.mtime) + (dc.stale ? "\\n⚠ 文件头最后更新 >180 天" : "")) + \'><span class="dfn ell">\' + esc(dc.rel) + "</span>" + over + capTag + bigTag + staleTag + \'<span class="dmeta muted">\' + num(dc.chars) + "字 / " + num(dc.bytes) + "B</span>" + (injLayer ? \'<div class="dbar-track"><div class="dbar" style="width:\' + wp + "%;--ac:" + rectCol + \'"></div></div>\' : "") + \'<span class="dmuted">\' + rel(dc.mtime) + "</span></div>";\n' +
'      }\n' +
'    }\n' +
'    h += \'<div class="thr"><span class="thr-l muted">参考阈值</span><span class="thr-i">告警线(字符×0.9) global 2700 · index 1800 · 摘要 1350</span><span class="thr-i">硬限(字符) global 3000 · index 2000 · 摘要 1500</span><span class="thr-i">兜底线(字节) global/index 4608B · 摘要 4096B</span><span class="thr-i">按需层（工具/项目/知识/历史会话）无注入预算，仅展示大小</span></div>\';\n' +
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
// [2026-09-23 关键修复] loader 的 unwrapExports() 语义是 `exports.default ?? exports`：
//   本模块同时有 default 与具名导出时 **default 胜出** ⇒ 只挂具名的 Config 会被丢弃，
//   导致 entry.fiber.runtime.Config === undefined → settings.describe 跳过本条目 →
//   设置页整片不可寻址（字段只读、写入无处落地）。官方 volatile 插件（如 dsh-llm-pi-ai）
//   之所以正常，是因为它们**没有 default export**。此处把 Config 一并挂到 default 上，两种形状都安全。
export default {
  Config: SETTINGS_SCHEMA,
  inject: ["fs", "timer", "commands", "skills"],
  apply(ctx, config) {
    // v2.3.4(dream-hash)：候选函数绑定模块级 hash 版本（纯函数，见 export default 前的 >>> INT_HASH BEGIN 区）
    const listIntegrateCandidates = hashListIntegrateCandidates;
    // v1.4.0：设置机制 —— cordis.patch.yml config 作 base 默认层，settings.yaml 用户文档覆盖。
    // 手动 register 拿到宿主 scope（写只读统计 staleCount）；无 settings 服务时回退 cordis config。
    // [2026-09-23] 三层合并：DEFAULT_CFG → loader config → 用户文件（.config.json 优先）
    PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config));
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
    // [2026-09-23 dsh 0.1.7 适配] 新 settings 模型：Config 已导出（volatile 字段免 remount 热更新），旧 register/get/watch 全套 API 已删除。
    //   生效值直接读运行引用（volatile 字段须 unwrapVolatile 解包）；settings.yaml 用户文档仍经 loader 合并进 config。
    PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config));
    try {
      const uk = Object.keys(readUserCfg());
      clog("[dsh-memory] 配置来源：默认层 + loader config" + (uk.length ? " + 用户文件(" + uk.join(",") + ")" : "（无用户覆盖）"));
    } catch (e) { /* 来源打印失败不影响功能 */ }
    clog(cfgEffectiveLine());   // v2.8.4（T2）：配置真身（settings 层）就位处再报一次——见 cfgEffectiveLine 头注释
    applyThresholdMigrations();   // v3.2.0（Wave 1）：一次性事故回调 rep→0.75（记账 threshMigr.rep075，只跑一次）
    // volatile-only 变更：loader 已提交进运行引用 + 向本 fiber 触发 loader/volatile-update（不 remount）；effect 绑 fiber 生命周期
    try {
      ctx.effect(() => ctx.on("loader/volatile-update", () => {
        try {
          const live = (ctx && ctx.config) || config;
          const next = normalizeCfg(mergeCfgLayers(live));   // [2026-09-23] 用户文件优先级最高
          const prev = { ...PLUGIN_CFG };
          PLUGIN_CFG = next;
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
            // v1.12.6：仅业务配置真变化才打日志（monitorSummary 改走 LIVE_STATS，不再进本回调刷屏）
            if (prev.staleSessionDays !== PLUGIN_CFG.staleSessionDays || prev.staleAction !== PLUGIN_CFG.staleAction || prev.active !== PLUGIN_CFG.active
              || prev.integrateEnabled !== PLUGIN_CFG.integrateEnabled || prev.integrateDays !== PLUGIN_CFG.integrateDays || prev.monitorEnabled !== PLUGIN_CFG.monitorEnabled) {
              // v2.8.4（T2·评审整改 工程席②/红队 R-7）：生效行**运行期也要刷新** —— 否则用户在设置界面改了
              //   `integrateEnabled`/`monitorEnabled` 之后，那一行仍停在启动快照却自称"★此行才是真值"。
              clog(cfgEffectiveLine());
              clog("[dsh-memory] 设置已更新: staleSessionDays=" + PLUGIN_CFG.staleSessionDays + ", staleAction=" + PLUGIN_CFG.staleAction + ", active=" + PLUGIN_CFG.active);
            }
          } catch (e2) { cwarn("[dsh-memory] 热配置刷新失败:", e2 && e2.message ? e2.message : String(e2)); }
        }
      ));
    } catch (e) { /* 无 loader/volatile-update 事件的极老宿主：改配置走 remount，apply 重跑即生效 */ }
    // 自带设置页的插件隐藏自动生成页（官方 README 指定写法；settings 缺失如 CLI 则回调不执行）
    try {
      ctx.inject(["settings"], (sctx) => {
        try { ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber)); }
        catch (e2) { /* 忽略 */ }
      });
    } catch (e) { /* 无 settings 服务不影响功能 */ }
    // v1.12.1：启动时主动推送一次监控汇总（读磁盘历史数据），否则重启后界面一直显示"暂无统计"
    updateMonitorSummary();
    // ═══════════ v2.4.2 统计面板：webServer 路由（设置页超链接 → 同源 /dsh-memory/stats）═══════════
    // 页面同源 fetch /dsh-memory/stats.json 拿最新监控数据，打开即最新、手动刷新按钮 re-fetch。
    // 官方扩展点先例：webhook-github（ctx.effect+register exact 路由）、gateway（ctx.inject 动态可选注入）。
    // 不声明顶层 inject 依赖 webServer——CLI/headless 无此服务，声明会让整个插件加载失败；回调式注入=有则挂、无则静默。
    // 三重降级：①服务缺失回调不执行 ②回调体内 try/catch（register 抛错不逃逸 cordis）③ctx.effect 绑 fiber 生命周期（dispose 注销路由，防重启/切换后 duplicate path）。
    let PANEL_PORT = 0;   // [logpane 20260930] 插件 webServer 端口（/memory-panel 命令与 /dsh-memory/open 用；CLI/headless 无此服务时保持 0）
    let PANEL_WSRV = null;   // v3.1.1：持服务句柄——命令 handler 触发时**实时**读 port，不再只信注册期快照
    try {
      ctx.inject(["webServer"], (wctx) => {
        try {
          const wsrv = wctx && wctx.webServer;
          PANEL_WSRV = wsrv || null;
          PANEL_PORT = (wsrv && Number(wsrv.port)) || 0;   // [logpane 20260930] 记下端口，供 /memory-panel 命令构造面板地址
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
                  base.live = { staleCount: LIVE_STATS.staleCount, monitorSummary: LIVE_STATS.monitorSummary, onboardSummary: LIVE_STATS.onboardSummary };   // [2026-09-23] 只读统计新通道（scope 通道退役）
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
          // ═══ [logpane 20260930] 实时日志端点：本次启动以来 clog/cwarn/cerr 的环形缓冲 ═══
          //   GET /dsh-memory/logs.json?since=<ms>&level=warn|error&limit=N
          //   增量语义：只回 t > since 的行（面板每 2 秒轮询，首屏 since=0 取全量）。
          //   为什么要它：桌面端 dsh.exe 里没有宿主控制台，出问题只能翻文件或猜；此端点把「本次启动」的日志端到面板。
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/logs.json",
            handler: (req, res) => {
              try {
                res.setHeader("content-type", "application/json; charset=utf-8");
                res.setHeader("cache-control", "no-store");
                let since = 0, level = "", limit = 0;
                try {
                  const u = new URL(String((req && req.url) || ""), "http://127.0.0.1");
                  since = Number(u.searchParams.get("since")) || 0;
                  level = String(u.searchParams.get("level") || "");
                  limit = Number(u.searchParams.get("limit")) || 0;
                } catch (e0) { /* 无查询串=全量 */ }
                let lines = LOG_RING.filter((l) => l.t > since && (!level || l.level === level));
                if (limit > 0 && lines.length > limit) lines = lines.slice(lines.length - limit);
                res.end(JSON.stringify({ ok: true, bootAt: LOG_BOOT_AT, now: Date.now(), pid: process.pid, total: LOG_RING.length, lines: lines }));
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
            }
          }), "dsh-memory: /dsh-memory/logs.json");
          // ═══ [logpane 20260930] 在系统默认浏览器里打开统计面板 ═══
          //   桌面端（dsh-app:// 源）里 `<a target="_blank">` 被 Electron 的 setWindowOpenHandler 拦掉 ⇒ 点不开面板；
          //   改由宿主进程自己拉起浏览器（客户端同源 fetch 触发），应用窗口不受影响。
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/open",
            handler: (_req, res) => {
              const url = "http://127.0.0.1:" + (wsrv.port || 0) + "/dsh-memory/stats";
              let ok = false, err = "";
              try {
                execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, (e) => { if (e) cwarn("[dsh-memory] 拉起浏览器失败:", e.message); });
                ok = true;
              } catch (e) { err = String((e && e.message) || e); cwarn("[dsh-memory] 拉起浏览器失败:", err); }
              try {
                res.setHeader("content-type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: ok, url: url, error: err }));
              } catch (e2) { /* 客户端已断开 */ }
            }
          }), "dsh-memory: /dsh-memory/open");
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
          // ═══ [2026-09-23] 用户配置读写端点（设置页专用；绕开 config-editor 的 55 层写回校验）═══
          //   GET  → 返回 { ok, cfg, source }（cfg=三层合并后的生效值）
          //   POST → body 为字段补丁，白名单校验后落盘 .config.json，热更新 PLUGIN_CFG，回读确认
          //   安全性：仅允许白名单字段；仅接受同源（Origin 校验，非浏览器来源即拒绝跨站写）
          ctx.effect(() => wsrv.register({
            kind: "exact", path: "/dsh-memory/config",
            handler: (req, res) => {
              res.setHeader("content-type", "application/json; charset=utf-8");
              const reply = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
              const method = (req.method || "GET").toUpperCase();
              if (method === "GET") {
                const u = readUserCfg();
                return reply(200, { ok: true, cfg: { ...PLUGIN_CFG }, panelUrl: "http://127.0.0.1:" + (wsrv.port || 0) + "/dsh-memory/stats", userKeys: Object.keys(u), file: USER_CFG_FILE });
              }
              if (method !== "POST") return reply(405, { ok: false, error: "method not allowed" });
              // 同源校验：带 Origin 头时必须与本机同源（无 Origin 的非浏览器调用放行，仅本机监听）
              const org = req.headers && (req.headers.origin || req.headers.Origin);
              try {
                if (org && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(org))) return reply(403, { ok: false, error: "cross-origin denied" });
              } catch (e) { return reply(403, { ok: false, error: "bad origin" }); }
              let body = "";
              const finish = () => {
                let patch;
                try { patch = JSON.parse(body || "{}"); } catch (e) { return reply(400, { ok: false, error: "invalid json" }); }
                if (!patch || typeof patch !== "object" || Array.isArray(patch)) return reply(400, { ok: false, error: "patch must be an object" });
                // 白名单：仅可写字段（只读统计与内部态一律拒绝）
                const WRITABLE = new Set(["staleSessionDays", "staleAction", "integrateEnabled", "integrateDays", "active",
                  "monitorEnabled", "spiralRemind", "regressionEnabled", "initGuideEnabled", "updateCheckEnabled",
                  "spiralBreak", "brkLevel", "brkHardAbort", "brkSameN", "brkMaxDeny", "brkMinSteps", "maintTriggerChars"]);
                const clean = {};
                for (const [k, v] of Object.entries(patch)) {
                  if (!WRITABLE.has(k)) return reply(400, { ok: false, error: "field not writable: " + k });
                  clean[k] = v;
                }
                if (!Object.keys(clean).length) return reply(400, { ok: false, error: "empty patch" });
                // 与 DEFAULT_CFG 合并后用 normalizeCfg 强校验（非法值会被归一化回默认，不会落盘垃圾）
                const merged = { ...readUserCfg(), ...clean };
                const checked = normalizeCfg({ ...DEFAULT_CFG, ...merged });
                // 只把校验后的白名单字段写回（避免把 DEFAULT_CFG 全量灌进用户文件）
                const persist = {};
                for (const k of Object.keys(merged)) if (WRITABLE.has(k)) persist[k] = checked[k];
                // 若用户改回默认值，则从用户文件移除该键（保持"用户文件只存显式覆盖"语义）
                for (const k of Object.keys(persist)) if (persist[k] === DEFAULT_CFG[k]) delete persist[k];
                try {
                  if (!writeUserCfg(persist)) return reply(500, { ok: false, error: "readback mismatch (未落盘)" });
                } catch (e) { return reply(500, { ok: false, error: "write failed: " + (e && e.message ? e.message : String(e)) }); }
                // 热更新生效值 + 复核
                const prev = { ...PLUGIN_CFG };
                PLUGIN_CFG = normalizeCfg(mergeCfgLayers(config));
                try {
                  const st = readIntegrateState() || {};
                  const prevActive = (typeof prev.active === "boolean") ? prev.active : DEFAULT_CFG.active;
                  if (prevActive !== PLUGIN_CFG.active) {
                    if (PLUGIN_CFG.active === false) st.enabledAt = null;
                    else st.enabledAt = Date.now();
                    writeIntegrateState(st);
                  }
                } catch (e) { /* 开关联动失败不影响配置持久化 */ }
                clog("[dsh-memory] 用户配置已更新（来源 " + USER_CFG_FILE + "）：" + JSON.stringify(persist));
                return reply(200, { ok: true, cfg: { ...PLUGIN_CFG }, saved: persist });
              };
              try {
                req.on("data", (c) => { body += c; if (body.length > 65536) { req.destroy(); } });
                req.on("end", finish);
                req.on("error", () => reply(400, { ok: false, error: "request error" }));
              } catch (e) { return reply(400, { ok: false, error: "cannot read body" }); }
            }
          }), "dsh-memory: /dsh-memory/config");
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
    // [2026-09-23 dsh 0.1.7 适配] **parent 必填守卫**：宿主 spawn 驱动 startInProcessRun 无条件走
    //   resolveChildDepth(request.parent) → delegationDepthOf(agent) → 读 agent.options.subagentDepth；
    //   request.parent 缺省即抛 TypeError: Cannot read properties of undefined (reading 'options')
    //   （已运行时复现：直接调宿主驱动得同一句；真机留痕 15:37:20 压缩子代理失败(intent-dc075f59)）。
    //   旧宿主容忍缺 parent，故历史写法 "if (parent) opts.parent = parent" 兜底；0.1.7 起必须显式给。
    //   择父顺序：调用方 preferred → 同会话 live agent → 最近顶层 agent → 任一 live agent；全无则如实跳过，绝不裸调。
    function pickSpawnParent(preferred, sessionId) {
      const live = (a) => !!(a && typeof a === "object" && a.options && a.session);
      try { if (live(preferred)) return preferred; } catch (eP) {}
      try {
        if (sessionId) { const a = agentsBySession.get(sessionId); if (live(a)) return a; }
        if (live(LAST_TOP_AGENT)) return LAST_TOP_AGENT;
        for (const a of agentsBySession.values()) { if (live(a)) return a; }
      } catch (eS) {}
      return null;
    }
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
    function applyArchiveBlocks(blocks, batchIds) {
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
        if (b.skip === true) {
          // ═══ §9.12②：**防静默丢弃闸**（改名见方案 §9.12.2）—— 跳过必须**可归因**，不是"必须被拒" ═══
          // 动机：`skip=true` 意味着这个会话的内容**不进记忆库**；此前唯一的约束是"给个理由"，而理由是**自由文本**，
          //   机器无法判真假（实测 09-18 那轮 5 个会话共约 5.4 万字符被声明跳过）。用户最怕的正是"内容没计入"。
          // ★ 机器判据（经两轮评审收敛，**只有这一条**）：
          //   **理由必须实质存在**（≥8 字，去空白）—— 空话/空白不算。
          // ★ 明确**不再**参与控制流的（两轮评审各否掉一次，记下来防回退）：
          //   ① 上一版 `!unitInfo.ok && !noUnitDeclared ⇒ 拒`：把 8 字闸变成**魔法词闸**（理由没写中那四个短语就恒被拒，
          //      而"确实无内容"的会话又无 points 可写 ⇒ P0 死循环按措辞复现）；
          //   ② 更早的"无单元 ⇒ 无条件拒"：直接死循环。
          //   ⇒ 现在：**无单元一律放行**（`!unitInfo.ok` 已是完整机器谓词），但必须**留痕**：
          //      `cwarn` + `monitorEvent` + 见证 `{unitWhy, unitChars, indexed}` + 无单元计数 `noUnitSkip`（进读者行）。
          const sid0 = b.sessionId.trim();
          const reason0 = String(b.reason || "").replace(/[\r\n]+/g, " ").trim();
          if (reason0.length < 8) {
            errors.push(tag + ".skip 需要给出**实质理由**（≥8 字；当前「" + reason0.slice(0, 20) + "」）—— 空话不算，机器无法据此复核");
            continue;
          }
          const unitInfo = readArchiveUnitForSkip(sid0);
          // ★★ 评审整改（根因席 P0 ① + rev3 复核）：**不再用理由里的措辞当控制流判据**。
          //   上一版是 `if (!unitInfo.ok && !noUnitDeclared) 拒`：它把"8 字闸"升级成了**魔法词闸** ——
          //   子代理只要没写中那四个短语（反例：「该会话抽取产物为空，无正文可依」）就恒被拒，而它对"确实无内容"
          //   的会话又**无 points 可写** ⇒ P0 那条**死循环按措辞复现**（收敛只靠报错文案教它写魔法词）。
          //   根因席裁定：`!unitInfo.ok` **本身就是完整的机器谓词** ⇒ **无单元一律放行**；拒的门只剩"理由 <8 字"。
          //   ⇒ ② 的机器不变量随之改写为：**每一次 skip 都必须可归因**（不是"必须被拒"）——
          //      见证必带三元组 `{unitWhy, unitChars, indexed}`；无单元者计入 `noUnitSkip`；并在读者行可见。
          const wasExtracted = (LAST_ARCHIVE_FLOW.sessionIds || []).indexOf(unitSid(sid0)) >= 0;
          // ★ 根因席补的分流：**本轮抽取过、盘上却没有文件** = `writeUnitCache` 写失败 / LRU 淘汰（**系统故障**，
          //   不是"没有内容"）⇒ 不能与"抽取未产出"混在一个计数里（否则 `noUnitSkip` 上涨无法归因）。
          //   ★★ 2026-09-20 **注释更正（B5 取证）**：下面那句"自动重试未实现"**已过时** ——
          //     它写于 §9.11.4-10 之前。实测（`_b5-retry-check.mjs`）："已归档 ∧ 无单元 ∧ 非空"共 31 个，
          //     其中 **22 个 `shouldReArchive=true`** ⇒ 会被自动重试。
          //     §9.11.4-10 的"无单元 ⇒ 不盖章、判待归档"**事实上已把自动重试带上**。
          //     剩下 9 个 `shouldReArchive=false` 的**不是漏档**：它们在 `sessions/*.md` 里**已有完整块**，
          //     被"首次档提及闸"正确挡住（防重复归档）⇒ 该闸**无缺陷**。
          const unitLost = (!unitInfo.ok) && wasExtracted;
          if (!unitInfo.ok) {
            cwarn("[dsh-memory] 无单元跳过" + (unitLost ? "（★ 系统故障：本轮曾抽取但盘上无文件）" : "（抽取未产出）")
              + "：" + sid0 + " —— why=" + String(unitInfo.why || "") + " ｜ 理由：" + reason0.slice(0, 40));
            try { monitorEvent("archive", "no-unit-skip " + sid0 + " why=" + String(unitInfo.why || "").slice(0, 48) + (unitLost ? " lost=1" : "")); } catch (e0) {}
          }
          const ix = unitIndexedInSearchCache(sid0);
          norm.push({ rel: rel, sid: sid0, skip: true, reason: reason0, unitChars: unitInfo.chars || 0, indexed: ix, unitFile: unitInfo.file || null, noUnitSkip: !unitInfo.ok, unitWhy: unitInfo.ok ? null : String(unitInfo.why || ""), unitLost: unitLost, unitViaPrefix: unitInfo.viaPrefix === true, unitTruncated: unitInfo.truncated === true, unitSampled: unitInfo.sampled === true });
          continue;
        }
        if (!Array.isArray(b.points)) { errors.push(tag + " 非 skip 时必须提供 points 数组（3-6 条要点）"); continue; }
        // v2.4.28（D3）：points 条数机器校验 3-6 条下限（先滤空串再计数；原只拦空数组，1 条也放行）
        const _ptsF = b.points.map((p) => String(p)).filter((p) => p.trim());
        if (_ptsF.length < 3 || _ptsF.length > 6) { errors.push(tag + " 归档要点须 3-6 条（当前 " + _ptsF.length + " 条）——过少=信息不足、过多=需精简合并"); continue; }
        norm.push({ rel: rel, sid: b.sessionId.trim(), title: String(b.title || ""), points: _ptsF, literals: sanitizeLiterals(b.literals) });
      }
      // ★ 2026-09-25（A5 跨批口径修复）：`ids` 是**整轮全量**，而子代理只拿到**本批**清单 ⇒ 按本批校验，
      //   否则会逼出"为别的批的 id 提交假 skip"。`batchIds` 缺失（拿不到子代理身份）时退回全量口径。
      const a5Scope = (batchIds && batchIds.size > 0) ? Array.from(batchIds) : ids;
      const missing = a5Scope.filter((id) => !declared.has(id));
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
      // ═══ §9.12③：**精确字面量入独立通道**（`literals.md`：非注入层、幂等、memory_search 可检索）═══
      //   放在"整批校验通过"之后 —— 被拒的批次**不写任何文件**（含字面量），与既有"整批拒写"语义一致。
      let litRes = { ok: true, wrote: 0, existed: 0 };
      try {
        const litEntries = [];
        for (const it of norm) {
          if (it.skip) continue;
          for (const L of (it.literals || [])) litEntries.push({ literal: L, sid: it.sid, date: todayStr2 });
        }
        if (litEntries.length) {
          litRes = writeLiteralsIdempotent(MEMORY_ROOT, litEntries);
          if (litRes.wrote > 0) clog("[dsh-memory] 字面量通道：写入 " + litRes.wrote + " 条（去重跳过 " + litRes.existed + " 条）→ knowledge/字面量.md");
          if (!litRes.ok) cwarn("[dsh-memory] 字面量写入失败（不影响归档落盘）：" + litRes.why);
        }
      } catch (eL) { cwarn("[dsh-memory] 字面量通道异常（不影响归档落盘）：", eL && eL.message ? eL.message : String(eL)); }
      const applied = []; const skipped = [];
      // v2.8.4（P18）：见证的 `chars` 口径 = **要点正文**（`- `+p 逐行拼接）字符数。
      //   与"被丢内容量"同量纲 ⇒ written/dropped 可直接相加比较；不用 block.length（含块头/轮次标注噪声 ~60 字）。
      const _wChars = (pts) => (pts || []).map((p) => "- " + p).join("\n").length;
      for (const it of norm) {
        if (it.skip) { skipped.push(it.sid + "(跳过:" + it.reason + ")"); LAST_ARCHIVE_WITNESS.set(it.sid, { mode: "declared-skip", points: 0, chars: 0, reason: String(it.reason || "无价值跳过").slice(0, 60), unitChars: Number(it.unitChars) || 0, unitFile: it.unitFile || null, indexed: it.indexed === true, noUnitSkip: it.noUnitSkip === true, unitWhy: it.unitWhy ? String(it.unitWhy).slice(0, 80) : null, unitLost: it.unitLost === true, unitViaPrefix: it.unitViaPrefix === true, unitTruncated: it.unitTruncated === true }); continue; }
        const fullPath = portable(MEMORY_ROOT + "/" + it.rel);
        let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
        // v2.4.3：轮次落盘——首轮沿用 v2.0.8 幂等；≥2 轮头「### sid ·补N」，幂等只拦同轮 ghost 重发，不拦下一轮
        const roundN = (LAST_ARCHIVE_FLOW.rounds && LAST_ARCHIVE_FLOW.rounds[it.sid]) || 1;
        if (roundN === 1) { if (existing.includes("### " + it.sid)) { skipped.push(it.sid + "(已在库)"); LAST_ARCHIVE_WITNESS.set(it.sid, { mode: "dropped", points: it.points.length, chars: _wChars(it.points), reason: "已在库" }); continue; } }
        else if (existing.includes("### " + it.sid + " ·补" + roundN + "（") || existing.includes("### " + it.sid + " ·补" + roundN + "\n")) { skipped.push(it.sid + "(本轮已记)"); LAST_ARCHIVE_WITNESS.set(it.sid, { mode: "dropped", points: it.points.length, chars: _wChars(it.points), reason: "本轮已记" }); continue; }
        const header = "### " + it.sid + (roundN > 1 ? " ·补" + roundN : "") + (it.title ? "（" + it.title + "）" : "");
        const block = "## 漏网会话补档（" + todayStr2 + " 归档）\n" + header + "\n" + it.points.map((p) => "- " + p).join("\n") + "\n";
        const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
        try {
          fs.mkdirSync(dir, { recursive: true });
          const newText = existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + block.trim() + "\n";
          writeFileAtomic(fullPath, newText, { tag: "archive", verify: true });   // v0.5（step2 内容闸 + N7 补回读）
          applied.push(it.sid + "→" + it.rel);
          LAST_ARCHIVE_WITNESS.set(it.sid, { mode: "written", points: it.points.length, chars: _wChars(it.points), reason: "" });
        } catch (e) {
          cwarn("[dsh-memory] 归档块写盘失败（跳过）: " + it.sid + " - " + (e && e.message ? e.message : String(e)));
          skipped.push(it.sid + "(写盘异常)");
          LAST_ARCHIVE_WITNESS.set(it.sid, { mode: "dropped", points: it.points.length, chars: _wChars(it.points), reason: "写盘异常" });
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
    // v2.6.4：opts.allowDangling=true 显式放行「指向未落盘目标」的引用（仅用于复述/描述既有指针，非正常写入路径）
    const applyPatches = (patches, opts) => {
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
            // ═══ v2.7.0（拆 fixed）：耐久层写保护已随 fixed.md 层一并删除 ═══
            //   原为 v2.6.8（P5.1-11/12/20）的「delete 一律拒 + 净删 ≥200 拒」＋ v2.6.9（P1）的 full_rewrite 显式声明通道。
            //   拆除依据：①该层独特价值就是这套保护，而它自身有洞（任意 patch 带 full_rewrite 即整组解锁）；
            //   ②实测下沉留指针不丢（global 2 / index 1 / projects 60 / tools 6 处引用，目标均在位）；
            //   ③最硬一类（编号）召回 100%（295/295）⇒ "防丢"收益不成立。详见 docs/评估-会话原文检索三档.md §5。
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
                // v2.7.0（拆 fixed）：原按 rel 分「固定要点已满（禁下沉）」与「整节下沉」两支；fixed 层已拆，
                //   分支与其内层命名表（`rel === "fixed.md" ? "fixed" : …`）一并删除——不再需要 MEMORY-fixed-* 命名。
                const oversizeHint = "按差数做整节下沉：按任务书 EXTRACTION 提取要求的选择标准挑低价值节（有 ## 归档 族则优先），整节提取到 knowledge/MEMORY-" + (rel === "index.md" ? "index" : "global") + "-<topic>.md，主文件删该节 + 尾部插 '- See knowledge/<文件>（N 项）— 一句话摘要'，一次成型提交；禁止逐条微调压缩字面量；delete 未命中会显示在 skipped 而非 errors；分节字符: " + secTab;
                errors.push("patches " + rel + " 写入后仍 " + F + " 字符，超预算 " + b.chars + "（当前超 " + (F - b.chars) + "）——" + oversizeHint);
              }
            }
          }
        } catch (eB) { cwarn("[dsh-memory] D1b 预算校验异常（跳过预算闸，落盘继续）: " + (eB && eB.message ? eB.message : String(eB))); }
      }
      // v2.6.4（L1）：同批指针闭合校验——本批**新增**的记忆库内指针，其目标必须「也在本批 rel 集合里」或「磁盘已存在」，
      //   否则整批拒写（复用上方 errors/拒写机制，零新机制）。治本 2026-09-15 悬空指针事故：
      //   旧行为下「调用#1 只提交指针行续期 + 调用#2 提交目标内容」若 #2 被拒/被打断/未发生 → 主文件留悬空指针而工具报成功；
      //   批内原子（errors 非空整批不写）只覆盖单次调用，跨调用无事务 → 必须在写时把「指针与目标」的闭合要求表达出来。
      // 判据面（只查新增、不查终文全部）：
      //   addTxt = 本批引入的文本（edit=new_string，replace/append=content，delete=空——删除不会引入指针）；
      //   preTxt = 该 rel 磁盘现文（现文里已有的历史悬空指针不追责，否则会永久卡死该文件的所有后续写入）；
      //   新增指针若命中描述性豁免行（如「…未落盘」）或指向已轮转 archive 的 sessions 文件 → 放行。
      if (errors.length === 0 && !(opts && opts.allowDangling === true)) {
        try {
          const batchRels = new Set(valid.map((v) => v.rel));
          const newly = new Map();   // 悬空目标 rel -> 首个引入它的批内 rel
          for (const v of valid) {
            const addTxt = v.action === "delete" ? "" : (v.action === "edit" ? v.new_string : v.content);
            if (!addTxt) continue;
            let preTxt = "";
            try { preTxt = fs.readFileSync(portable(MEMORY_ROOT + "/" + v.rel), "utf8"); } catch (eR) { preTxt = ""; }
            const pre = new Set(memPointerHits(preTxt).map((h) => h.rel));
            for (const h of memPointerHits(addTxt)) {
              if (h.desc) continue;                        // 描述性提及（「…未落盘」等诚实标注）不视为指针
              if (pre.has(h.rel)) continue;                // 现文里已有 → 非本批新增（历史存量不追责）
              if (batchRels.has(h.rel)) continue;          // 同批创建/改写 → 闭合
              if (memPointerTargetExists(h.rel)) continue; // 磁盘已存在 → 闭合
              if (memPointerArchived(h.rel)) continue;     // sessions 已轮转进 archive → 内容未丢
              if (!newly.has(h.rel)) newly.set(h.rel, v.rel);
            }
          }
          for (const [rel, srcRel] of newly) {
            errors.push("patches 指针指向未落盘文件 " + rel + "（" + srcRel + "）：请把该文件内容与指针放进**同一次** memory_dream_patch 调用（任务书 5. 同批原子），或把指针改指已存在文件（已轮转会话用 sessions/archive/…）；确系复述/描述既有指针、非指针意图，可在同批带 allowDangling:true 显式放行");
          }
        } catch (eL1) { cwarn("[dsh-memory] L1 指针闭合校验异常（跳过该闸）: " + (eL1 && eL1.message ? eL1.message : eL1)); }
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
    // ★★ B5：活动预算的**第二级**（与 guardHardFire 的"首触提醒 → 3 分钟宽限 → 真杀"同构）。
    //   24 次是"防换壳空转"的**计数**判据，而归档子代理的合法工作就是读 N 个单元；
    //   现场（2026-10-07 21:17:34）它是**慢速真读**（3.5 次/分、且已落盘 2 个块）却被判空转 ⇒
    //   首触只提醒、不杀；再攒满同样多**且期间一次落盘都没有**才进宽限。
    //   置 0 = 逐字恢复旧行为（一键回滚旋钮）。
    const GUARD_ACTIVITY_HARD_EXTRA = GUARD_ACTIVITY_BUDGET;
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
        const g = { sid: spSid, ctrl: ctrl, hardMs: hardMs || SUBAGENT_HARD_MS, softMs: softMs || SUBAGENT_SOFT_MS, hardT: null, softT: null, graceT: null, aborted: false, kind: kind, graced: false, actN: 0, actBudget: null, budgetTold: false };
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
          g.graced = false; g.actN = 0; g.budgetTold = false;   // ★ B5：落盘即清"已提醒"标记（下一窗可再提醒一次）
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
        // ★★ B5：两段式——首触只提醒（**不杀**），再攒满一个预算窗才进宽限（落盘随时清零 actN ⇒ 真在干活的不被杀）
        const _v = guardBudgetVerdict(g.actN, g.actBudget || GUARD_ACTIVITY_BUDGET, GUARD_ACTIVITY_HARD_EXTRA);
        if (_v !== "none" && !g.budgetTold) {
          g.budgetTold = true;
          try { enqueueRegressionReminder(spSid, "PL:guard-budget", "<system-reminder>\n【dsh-memory 提示·无落盘活动超限】无落盘窗口内工具活动 " + g.actN + " 次（上限 " + GUARD_ACTIVITY_BUDGET + "）已到，**这不是硬停**：继续读/写都行，但请尽快提交任何可落盘的最小 patch 续期；再攒满 " + GUARD_ACTIVITY_HARD_EXTRA + " 次且期间零落盘才会进 3 分钟宽限。\n</system-reminder>"); } catch (eQ) {}
        }
        if (_v === "grace") guardGrace(spSid, "budget");
      } catch (e) {}
    }
    function guardClear(spSid) {
      try { const g = SUBAGENT_GUARDS.get(spSid); if (g) { try { if (g.hardT) clearTimeout(g.hardT); if (g.softT) clearTimeout(g.softT); if (g.graceT) clearTimeout(g.graceT); } catch (eC) {} SUBAGENT_GUARDS.delete(spSid); } } catch (e) {}
      try { clearRegressionQueue(spSid); } catch (eQ) {}   // v2.6.1（V0.2 P2）：清提醒队列（原 clearRegressionQueue 死代码未调用；abort/失败轮入队提醒滞留死 sid）
    }
    // ═══════════ v3.2.1（宿主 0.2.x 子代理 API 适配）════════════════════════════════════════════
    // 实证（2026-10-18）：桌面端 10-17 17:20:50 升到 dsh 0.2.1-rc.2 后，@deepseek-ai/dsh-subagent 的
    //   服务方法表变成 startActivation / waitForChildren / sendMessage / interrupt / drainDescendants /
    //   drainChildren / listChildren / listDescendants / prompt / interruptByParent / registerProvider /
    //   getProvider / list / prepareContinuable / expectProvider / requireManager / observeActivation，
    //   **`start()` 已被移除**；旧宿主 0.1.7-rc.2 仍是 `start(name, request)`。
    //   于是旧判据 `typeof subagents.start !== "function"` 成了假阴性：服务本来在（agent-team 的
    //   static inject 含 subagents ⇒ 属主 root，ctx.get 拿得到），却被判「不可用」静默跳过 —— 意图检查点 /
    //   合并维护 / 漏网归档 / /dream 整合 四条链路在升级后全停（对账：.integrate.json lastSuccessAt=
    //   10-17 15:55:28、archiveLastFailAt=10-17 23:12:45，夹着 app.asar 安装时间 10-17 17:20:50）。
    // 修法：双协议守卫 + 就地适配层。旧宿主照旧走 start()；新宿主走
    //   startActivation({ provider, label, request, signal, delivery:'caller' })，
    //   再映射回调用方本来就假设的 { id, result, dispose } 三件套（三处 spawn 点语义不分叉）。
    //   delivery:'caller' = 结果只回调用方、不往父会话塞完成通知（0.2.x README：「caller delivery lets
    //   workflows await the result without a parent notice」）。
    function subagentsHasStart(s) {
      return !!s && (typeof s.start === "function" || typeof s.startActivation === "function");
    }
    async function startSubagentCompat(s, opts) {
      if (typeof s.start === "function") return s.start("spawn", opts);   // 0.1.x 原路，一字不改
      const req = Object.assign({}, opts || {});
      const label = req.label; delete req.label;
      const signal = req.signal; delete req.signal;   // signal 归 spec 层，不进 request（免语义重复）
      const h = await s.startActivation({
        provider: "spawn",
        ...(label === undefined ? {} : { label: label }),
        request: req,
        ...(signal === undefined ? {} : { signal: signal }),
        delivery: "caller"
      });
      return {
        id: (h && h.childId) || "",
        result: h && h.result,
        dispose: (h && typeof h.dispose === "function") ? (() => h.dispose()) : undefined
      };
    }
    // v2.4.31：compactOnce 支持 per-call 超时覆盖（timingOverride={softMs,hardMs}，仅 slim 轮用更短预算；缺省=全局常量）
    async function compactOnce(subagents, parent, promptText, tag, timingOverride, sessionId) {
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
        const _spawnParent = pickSpawnParent(parent, sessionId);
        if (!_spawnParent) {
          // 0.1.7 parent 必填：无 live agent 时宁可不发起，也不能裸调（旧写法在此抛 options TypeError，白烧一轮）
          clog("[dsh-memory] 压缩子代理(" + tag + ")：无可用父 agent，跳过（dsh 0.1.7 起 subagents.start 的 parent 必填）");
          try { monitorEvent(String(tag || "").startsWith("intent") ? "intent" : "maint", "no-parent " + tag); } catch (eMP) {}
          return null;
        }
        opts.parent = _spawnParent;
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
        const run = await startSubagentCompat(subagents, opts);   // v3.2.1：兼容 0.1.x/0.2.x
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
      "补全通道：摘要通常已全文直喂（≤20000 字原样入上下文）；仅超长时出现「本节截断/本节中省略」标记——见标记且需精确字面量时，先 memory_search 查当日要点区（sessions/日期.md 头部）；原始摘要逐字在会话日志 compaction/summary 事件（~/.dsh/sessions/<工作目录>/<会话id>/session.jsonl.zstd 或新版 session.v3.jsonl.zstd）可查。再定稿。\n\n===== 宿主压缩摘要 =====\n";
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
        if (!subagentsHasStart(subagents)) {   // v3.2.1：双协议判据（0.1.x start / 0.2.x startActivation）
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
        let sum = await compactOnce(subagents, parentAgent, prompt, "maint-" + fname.replace(/\..+$/, ""), null, sid8);
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
        let overBudgetInject = false;   // ★ B4：本轮是否"超预算直接注入"（唯一判据：L7412 置位、L7482 读）
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
                "maint-slim-" + fname.replace(/\..+$/, ""), MAINT_SLIM_TIMING, sid8);   // v2.4.31：slim 轮短超时（hard 8 分）
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
            overBudgetInject = true;   // ★ B4：置位（L7482 据此不再宣称"已收敛"）
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
        clog("[dsh-memory] 合并维护完成 sessions/" + fname + "（" + merged.length + " 字符要点，" + (overBudgetInject ? "⚠️ 超预算直接注入（允许带 " + MAINT_LIMIT_ALLOW + "）—— 注入面**未收敛**，已按用户口径保留全文" : "注入面已收敛") + "）");
        maintRetryClear();   // v2.4.5：成功落盘清零重试状态
        maintRecordSuccessBase(fname, finalText);   // v2.4.31-2（审核 P1-1）：记录合并后注入面基准（防乒乓增长闸；含 over-budget-inject 直接注入）
        recordMaintSample(Object.assign({ fname, beforeChars, afterChars: merged.length, result: "ok", overBudget: overBudgetInject }, slimStats ? { slimCalls: slimStats.calls, slimLens: slimStats.lens, stuckReason: slimStats.reason } : {}));   // v0.5（P0-2）；v2.5.2（P2）：slim 统计随样入账
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
        if (!subagentsHasStart(subagents)) {   // v3.2.1：双协议判据（0.1.x start / 0.2.x startActivation）
          clog("[dsh-memory] 意图检查点：subagents 不可用，跳过");
          return;
        }
        const targetPath = MEMORY_ROOT + "/sessions/" + fname;
        const targetFull = portable(targetPath);
        let existing = "";
        try { existing = fs.readFileSync(targetFull, "utf8"); } catch (e) { existing = ""; }
        if (existing.includes("<!-- intent: " + compactionId)) return;   // 幂等：前缀匹配（marker 已带 sid 后缀）
        const sid8 = String(sessionId || "anon").replace(/^session-/, "").slice(0, 8);
        let sum = await compactOnce(subagents, parentAgent, INTENT_INSTRUCTION + smartTrim(summaryText, 20000, "sessions/" + fname + "（memory_search 可查）"), "intent-" + String(compactionId).slice(0, 8), null, sessionId);
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
    // v2.6.6（2026-09-16 用户拍板）：当前在跑的归档结算链句柄——供手动 /dream 在撞车（防重入拒绝）
    //   时等待其结算，保住「先归档再整合」语义（旧行为：被拒后直接 spawnIntegrate，归档与整合并行）。
    let STALE_ACTIVE_DONE = null;
    // v2.3.2(archive-tool): memory_archive_checkpoint 交付状态——批初始化+累计声明集+落盘/完整性标志
    let LAST_ARCHIVE_FLOW = null;            // { sessionIds: [], todayStr, declared: Set }
    // ★★ 2026-09-25（A5 跨批口径修复）：批 → 本批短 id 清单（按子代理 child session id 归位）。
    //   背景（现场实证 2026-09-25 那轮）：`LAST_ARCHIVE_FLOW.sessionIds` 是**整轮全量**，而每批任务书只带
    //   **本批**的短 id 清单 ⇒ 旧的"缺声明会话"判据会要求子代理为**别的批**的会话也提交声明，逼出这类假 skip：
    //   「插件校验要求声明该 id，但本批任务说明（第 4/6 批）的短 id 清单与消息流均未包含它…故无要点可写」
    //   —— 该轮 7 个内容丰富的会话被这样"声明跳过"（要点实际由各自批次写入，故内容未丢，但造成误导性留痕、
    //   白烧 token，并可能污染「有内容却声明跳过」计数）。
    //   修法：本批完整性只按**本批清单**校验（`batchIds`），`declared` 仍按轮累计供结算期 A5 使用；
    //   拿不到子代理身份时退回旧的全量口径（行为不劣化）。LRU 上限 64 防长驻泄漏。
    const ARCHIVE_BATCH_IDS = new Map();
    function rememberArchiveBatch(childSid, sidList) {
      try {
        const key = String(childSid || "");
        if (!key) return;
        if (ARCHIVE_BATCH_IDS.size >= 64) { const k0 = ARCHIVE_BATCH_IDS.keys().next().value; ARCHIVE_BATCH_IDS.delete(k0); }
        ARCHIVE_BATCH_IDS.set(key, new Set((Array.isArray(sidList) ? sidList : []).map((s) => unitSid(s))));
      } catch (e) { /* 登记失败只影响校验口径，绝不阻断发起 */ }
    }
    function archiveBatchIdsFor(exec) {
      try {
        const aid = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : "";
        return aid ? ARCHIVE_BATCH_IDS.get(aid) : void 0;
      } catch (e) { return void 0; }
    }
    let LAST_ARCHIVE_WROTE_AT = 0;
    let LAST_ARCHIVE_A5_OK = false;
    // v2.8.4（P18）：**内容见证** —— sid → {mode, points, chars, reason}。
    //   缺口：旧判据只有 `LAST_ARCHIVE_WROTE_AT`（"本轮有人写过"）+ A5（"声明全覆盖"）两个**整体标量**，
    //   不区分"某 sid 真写入"与"子代理自己声明 skip"。§8.6 选了 (D) 方向后，旧正文不再随本轮提供，
    //   所有旧结论只由 `extractExistingArchiveBlock`（旧要点）承载 ⇒ 一旦**机制层**丢弃（已在库/本轮已记/
    //   写盘异常）或子代理声明 skip，水位照常推进 ⇒ **内容静默消失且事后不可区分**。
    //   本见证把每一轮、每个 sid 的**实际去向**写进账本（含被丢内容量），并交给下面两处「指定读者」报出来。
    let LAST_ARCHIVE_WITNESS = new Map();
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
    // ═══════ v2.8.4（自动归档包，用户裁决 2026-09-18）：静默归档不再依赖"每进程一次" ═══════
    // 缺口：`maintenanceInjected`（L4688，**进程内变量**）使自动归档**每插件实例只跑一次**；`/dream` 要人主动；
    //   定期整合要满 `integrateDays`（默认 7 天）⇒ 长跑不重启时该归档的会话最长被拖 7 天。用户配置是
    //   `staleAction: silent`（要它自动）⇒ 必须补这条通道。
    // 设计（组评审 5 席收敛 + 用户裁决 A/B1–B4）：
    //   ① **指纹闸（主闸）**：候选集（sid + 各自水位）未变 ⇒ **不发起**。实测候选集绝大部分时刻是不变的
    //      ⇒ 把"每小时盲发起"变成"候选真变了才跑"，实际轮数贴**到达率**（实测 1.8 轮/天）而非贴上上限。
    //      它**原本声称**能天然掐死红队指出的"僵尸会话永动机"（整轮全无流 ⇒ 候选集不变 ⇒ 不再重复起火），
    //      ★ 2026-09-18 组评审更正：这句话**不成立** —— ① 旧代码只在 `r.ok` 记指纹，白轮不记；
    //      ② 更关键的是指纹本身对内容变化**不敏感**：`fp` 取的是 `ARCHIVE_WATERMARK` 的 `frames`，而水位只在
    //      "成功归档"时才推进，**从未归档过**的候选更是永远没有水位条目（懒置基线只在 `has(id)` 分支里写）
    //      ⇒ `fp` 恒为 `id@undefined`。所以「候选集未变」只说明"集合 id 没变"，**不能**说明"内容没变化"。
    //      本批**没有**动这条闸的语义（改它要重做取值口径），只把白轮路径的退避改为**作用域**退避（见下 ②），
    //      并明确记下这个既存局限（红队 R-1，列入待办）。
    //      ★ 另一条自伤与回退：我一度在白轮分支里补记 `ARCHIVE_AUTO_FP = fp` 想"兑现"上面那句话 ⇒ 会造成**永久静默**
    //      （同一集合在 24h 后仍被指纹闸挡死）。该行已回退，见 `runStaleSilentTick` 的 whiteRun 分支注释。
    //   ② **退避（第二层）**：整轮 `whiteRun`（候选全无可归档消息流）⇒ **24h 内不再自动发起**。
    //   ③ **不新增节流参数**（用户裁决 A）：频率上限就用既有的 `ARCHIVE_THROTTLE_MS`（60 min，在 `runStaleArchive` 内）。
    //   ④ **只挂归档层**：本 tick **绝不**调 `runDreamPipeline` ⇒ 整合（改写 global/index/projects）仍守 `integrateDays`。
    //   ⑤ **可读信号**：每次 tick 结论（跑没跑 + 原因）写账本 `archiveAutoLast`，供 `/dream` 体检行与自检读取。
    //   ⑥ 节流戳**每次调用前读盘**（修多实例：另一实例刚跑过时，本实例内存旧戳会误判"可跑"）。
    //   ⑦ 形状可测（回归门席）：**具名函数 + 可注入时钟**（`now` 形参）—— 门直调它，不碰定时器。
    let ARCHIVE_AUTO_FP = null;       // 上次**发起**时的候选集指纹
    let ARCHIVE_AUTO_UNTIL = 0;       // whiteRun 退避截止
    let ARCHIVE_AUTO_UNTIL_FP = null; // v2.8.4（T5）：该退避只针对**这一份候选集**（新候选到达 ⇒ 立即放行；旧实现是全局 24h 硬压）
    function archiveAutoNote(t, ran, why) {
      try {
        const st = readIntegrateState() || {};
        st.archiveAutoLast = { at: t, ran: !!ran, why: String(why || "").slice(0, 160), fp: ARCHIVE_AUTO_FP || null, until: ARCHIVE_AUTO_UNTIL || 0, untilFp: ARCHIVE_AUTO_UNTIL_FP || null };
        writeIntegrateState(st);
      } catch (e) {}
    }
    // v2.8.4（P18）：账本 → 一行人类可读信号（心跳行与启动自检的唯一格式源；格式逻辑本身在模块级，门可直测）
    function archiveSignalLine() {
      try { return formatArchiveSignal(readIntegrateState() || {}, Date.now()); }
      catch (e) { return "自动归档 账本读取失败：" + (e && e.message ? e.message : String(e)); }
    }
    __archiveSignalLine = archiveSignalLine;
    async function runStaleSilentTick(now) {
      const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      // ★ 2026-09-19（重写 T5 门时**实测**抓到的一处真实缺口，不是推演）：本 tick **自己不加载账本**。
      //   `ensureStaleNotified()` 此前只被三个"人在场"的入口调用（维护提醒注入 / `stale_archive` 工具 / `/dream`）
      //   ⇒ 若本 tick 抢在它们之前跑（重启后定时器首跳而该进程还没注入过维护提醒），内存里的
      //   `ARCHIVED_SESSIONS` / `ARCHIVE_WATERMARK` **是空的**，两个后果都很重：
      //     ① `archivePendingEntry` 对**每个**存量会话都返回 true（= 全当新候选）⇒ 单轮最多 32 个会话被重复归档；
      //     ② 紧接着的 `saveStaleNotified()` 会把 `st.archivedSessions = <空集合>` **写进磁盘**
      //        （它读盘后覆盖三个键再整对象写回）⇒ 账本被清空 ⇒ 此后每次重启全量重档（token 爆炸，正是 09-18 评审
      //        反复划线的风险）。
      //   实测证据：`_test-t5-white-scope.mjs` 预置了 `archiveWatermarks`，而 tick 算出的指纹却恒为
      //   `session-zom1@undefined|…`（= 内存无水位）且被消号的会话仍走了完整提取路径 ⇒ 账本确实没被加载。
      //   修法：本 tick 自己保证账本已加载（幂等，一次读盘）—— 候选判定与指纹不再依赖**调用顺序**。
      ensureStaleNotified();
      // ★ §9.11.4-3 修正六（红队 rev8c B② 实测形态：账本半截 JSON ⇒ 本 tick 静默变成「无待归档候选」并把账本写空）：
      //   账本读不出来 ⇒ **整轮不动**：不做候选枚举、不做提取、**不写任何盘**（连 `archiveAutoNote` 都不调 —— 它本身就是写盘）。
      //   为什么必须在这里拦：`getEnabledAt()` 读账本失败时会退化成 `Date.now()` ⇒ `findStaleSessions` 把**所有**会话挡掉
      //   ⇒ 表面"没有候选"，实际是"读不到账本"；那正是最容易被误读成"一切正常"的静默降级。
      // ★ 修正七（红队 rev8d P1，实测）：**不得用粘滞标志**。作者上一版把"账本不可读"记成模块级 `LEDGER_UNREADABLE`
      //   且**永不清零** ⇒ 一次瞬时读失败（EISDIR / 权限 / 半截写被别的进程修好）就把归档轮**永久压住到重启**，
      //   而一次性 cwarn 之后**再无任何痕迹**（这条路径刻意不调 `archiveAutoNote`，心跳行也读不到）⇒「静默停摆数天」。
      //   现在改成**每次现问**：这一轮能不能读出账本来？读得出就照常跑（瞬时失败**自愈**，无需重启）；
      //   读不出则本轮不动，并且**每轮都发一条 monitorEvent**（不再只发一次）—— 留痕可查、可计数。
      if (ledgerUnreadableNow()) {
        try { monitorEvent("archive", "ledger-unreadable paused（本轮不动：不归档、不写盘；修复账本后自动恢复）"); } catch (e) {}
        return { ok: false, ran: false, why: "ledger-unreadable" };
      }
      if (PLUGIN_CFG.staleAction !== "silent" || !ZSTD_OK) { archiveAutoNote(t, false, "非 silent 档或无 zstd"); return { ok: false, ran: false, why: "not-silent" }; }
      // v2.8.4（T5）：退避判定**移到候选集算出之后**（见下方 fp 段）—— 退避是"对某一份候选集"的，不是对时间的全封锁。
      //   实测后果：两份**每轮都判"整轮无消息流"**的僵尸候选（更正：不是"1 字节日志"，见文件头 T5 段说明）⇒ 全局 24h 退避把
      //   **真正的新会话**的自动归档一起压住了（旧实现里那 24h 是纯时间闸，与候选是谁无关）。
      if (STALE_RUNNING) { archiveAutoNote(t, false, "上一轮归档仍在跑"); return { ok: false, ran: false, why: "busy" }; }
      if (MAINT_RUNNING || INTENT_RUNNING || DREAM_TRACK) { archiveAutoNote(t, false, "记忆链忙（维护/整合进行中）"); return { ok: false, ran: false, why: "chain-busy" }; }
      // ⑥ 每次读盘刷新节流戳（多实例）
      try {
        const st0 = readIntegrateState() || {};
        if (st0.archiveLastRunAt) ARCHIVE_LAST_RUN_AT = st0.archiveLastRunAt;
        if (st0.archiveLastFailAt) ARCHIVE_LAST_FAIL_AT = st0.archiveLastFailAt;
        // v2.8.4（T5）：指纹/退避**跨重启保持**（旧实现是内存变量 ⇒ 重启即失效，白轮退避形同虚设：
        //   实测 2026-09-18 20:42:58 记了"退避 24h"，20:43:55 重启后 20:44:13 立刻又跑了一轮）。
        //   ★ 但**只恢复能归属到候选集的退避**（带 `untilFp`）—— 见下方修订注释（09-19 生产观测事故）。
        const al0 = st0.archiveAutoLast || {};
        if (al0.fp && !ARCHIVE_AUTO_FP) ARCHIVE_AUTO_FP = al0.fp;
        // v2.8.4（T5 修订 · 2026-09-19 生产观测）：`until` 有值但**没有 `untilFp`**（= v2.8.4 之前写下的旧式退避，
        //   无法归属到某份候选集）⇒ 一律视为**已失效、不恢复**。
        //   事故：旧式退避会落进"保守分支"（`UNTIL_FP === null` ⇒ 对**任何**候选集生效），再叠加本批新增的
        //   "退避跨重启恢复" ⇒ **重启后自动归档被全局封锁到该 until 到期**（本机实测：09-19 00:16 重启后封锁到
        //   09-19 21:43 = 21.4 小时；而旧实现在重启时会把内存里的退避丢掉，不会封这么久）。
        //   代价至多多跑一次白轮（有 15 分失败窗兜着），收益是"真来了的新会话不被压" —— 与 P0-1「宁重试不静默丢」同向。
        if (Number(al0.until) > t && al0.untilFp) { ARCHIVE_AUTO_UNTIL = Number(al0.until); ARCHIVE_AUTO_UNTIL_FP = al0.untilFp; }
        // v2.8.4（T5 修订二 · 同一事故的对称面）：**磁盘无有效退避 ⇒ 清掉内存态**。
        //   为什么必须对称：只"设"不"清"会让外部/人工解封**失效** —— 本机实测：我在 00:2x 把账本的 `until` 置 0，
        //   但运行中的进程内存里仍是 00:16 恢复的那份 21:43 ⇒ 每个 tick 只做"若磁盘值在未来则赋值"⇒ 依旧封锁到 21:43。
        //   ⇒ 让**账本成为 tick 的唯一真值源**：磁盘说没有有效退避，内存态就跟着清空（人工解封下一次 tick 即生效，
        //     也顺带消灭"幽灵退避"）。多实例下不会误伤：真正在跑的退避其 `until/untilFp` 本来就写在账本里。
        else if (!(Number(al0.until) > t)) { ARCHIVE_AUTO_UNTIL = 0; ARCHIVE_AUTO_UNTIL_FP = null; }
      } catch (e) {}
      const cands = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
        .filter((s) => shouldReArchive(s, reArchiveOpts()));
      if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }   // 复用既有懒置基线
      if (!cands.length) { archiveAutoNote(t, false, "无待归档候选"); return { ok: false, ran: false, why: "empty" }; }
      const fp = cands.map((s) => s.id + "@" + ((ARCHIVE_WATERMARK.get(s.id) || {}).frames)).join("|") + "#" + cands.length;
      // ★★ 修正十三·补（**红队 rev8h B 实测："incomplete 旁路 + 24h 退避 + 15 分窗不足以收敛"**）：
      //   `wmSkip` 候选是**有活干**的（去读那些"账本说读过、其实没读"的帧）⇒ 不该被"白轮退避"当白轮压住，
      //   否则 3 轮重试要花 3 天（每轮吃一次 24h 退避）⇒ 重试等于没有。候选集含 wmSkip 候选即放行。
      const hasWmSkipCand = cands.some((s) => { const w = ARCHIVE_WATERMARK.get(s.id); return !!(w && w.wmSkip === true && (Number(w.wmSkipRounds) || 0) < WM_SKIP_MAX_ROUNDS); });
      // v2.8.4（T5）：退避只作用于**同一份候选集**；候选集变了（= 真来了新会话）⇒ 立即放行。
      //   `untilFp` 为空 = v2.8.4 之前的旧账本 ⇒ 保守按"同一份"处理（旧账本行为不变）。
      if (!hasWmSkipCand && t < ARCHIVE_AUTO_UNTIL && (ARCHIVE_AUTO_UNTIL_FP === null || ARCHIVE_AUTO_UNTIL_FP === fp)) {
        archiveAutoNote(t, false, "whiteRun 退避中（同一候选集，" + cands.length + " 个；新候选到达即放行）");
        return { ok: false, ran: false, why: "backoff" };
      }
      if (!hasWmSkipCand && fp === ARCHIVE_AUTO_FP) { archiveAutoNote(t, false, "候选集未变（" + cands.length + " 个）"); return { ok: false, ran: false, why: "unchanged" }; }
      const r = await runStaleArchive(cands);      // 60min/15min 冷却 + STALE_RUNNING 三道守卫都在它内部
      if (r && r.ok) {
        ARCHIVE_AUTO_FP = fp;
        archiveAutoNote(t, true, "已发起 " + r.count + " 个会话 / " + r.started + " 批" + (r.overflow > 0 ? "，余 " + r.overflow + " 留待下次" : ""));
      } else if (r && r.whiteRun) {
        // v2.8.4（T5）：白轮**只**记"这份候选集退避到何时"（`until` + `untilFp`），**不记指纹**。
        //   ★ 一次自伤与回退（红队 R-1 + 工程席③，2026-09-18 评审）：我最初在这里也写了 `ARCHIVE_AUTO_FP = fp`，
        //     想兑现上方设计注释那句"指纹闸天然掐死僵尸永动机" —— 但那一行会造成**永久静默**：
        //     `fp` 由 `id + "@" + (ARCHIVE_WATERMARK.get(id)||{}).frames` 组成，而**从未归档过**的候选
        //     **永远没有水位条目**（懒置基线只在 `has(id)` 分支里写）⇒ `fp` 恒为 `id@undefined`、**对内容变化完全盲**；
        //     于是 24h 之后 `fp === ARCHIVE_AUTO_FP` 依旧成立 ⇒ 这份集合**再也不会被归档**（真·永久）。
        //     旧行为的 24h 退避到期是会重试的 ⇒ 那一行等于把"内容没计入"（用户最怕的）从"延迟 1 天"变成"永不"。
        //     ⇒ 回退该行。**承重的是 `untilFp` 作用域退避**：同一份集合 24h 内不重复起火、**到期自然重试**，
        //       候选集一变（真来了新会话）立刻放行。上方设计注释里"指纹闸掐死永动机"随之改为"靠作用域退避 24h 收敛"。
        //   ② 「不消号 / 宁重试不静默丢」（P0-1）语义**不变**。
        ARCHIVE_AUTO_UNTIL = t + 24 * 3600000;
        ARCHIVE_AUTO_UNTIL_FP = fp;
        archiveAutoNote(t, false, "整轮无消息流 ⇒ 同一候选集退避 24h（到期重试；候选集变化即放行）");
      } else {
        archiveAutoNote(t, false, "未发起：" + ((r && r.reason) || "?"));
      }
      return r || { ok: false, ran: false, why: "no-result" };
    }
    __staleSilentTick = runStaleSilentTick;        // 供门直调（带可注入时钟）

    async function runStaleArchiveInner(staleSessions) {
      const subagents = ctx.get("subagents");
      if (!subagentsHasStart(subagents)) {   // v3.2.1：双协议判据（0.1.x start / 0.2.x startActivation）
        cwarn("[dsh-memory] subagents 服务不可用，漏网归档降级为提醒");
        monitorEvent("archive", "failed reason=subagents-unavailable");
        return { ok: false, reason: "subagents 服务不可用" };
      }
      // 提取全部消息流（跳过无流的）；超上限的留待下次
      const batch = staleSessions.slice(0, MAX_ARCHIVE_SESSIONS);
      const overflow = staleSessions.length - batch.length;
      const flowSessions = [];
      const skippedNoFlow = [];
      const batchFrames = new Map(); // v2.4.3/P14：发起时记 {frames, round, incomplete}（settle 消号即写入水位账本）
      // v2.8.4（P15）：**整轮**墙钟预算 —— 所有会话共享同一截止点；只限单会话是不够的（旧路径曾顶住会话启动 6 分 14 秒）。
      const roundDeadline = Date.now() + ROUND_EXTRACT_BUDGET_MS;
      for (const s of batch) {
        await new Promise((r2) => setImmediate(r2));
        // v2.8.4（P21）：取**同目录全部日志**（时间顺序 `[legacy, v3]`）—— 双名目录旧实现只看优先级最高的一个。
        const logPaths = resolveSessionLogPaths(SESSIONS_ROOT + "/" + s.ws + "/" + s.id);
        if (!logPaths.length) {
          clog("[dsh-memory] 归档跳过（日志文件不可识别）: " + sidLabel(s.id) + "...");
          skippedNoFlow.push(sidLabel(s.id));
          batchFrames.set(s.id, { frames: null, round: 1, incomplete: false });
          continue;
        }
        clog("[dsh-memory] 提取消息流 " + (flowSessions.length + skippedNoFlow.length + 1) + "/" + batch.length + ": " + sidLabel(s.id) + (logPaths.length > 1 ? "（" + logPaths.length + " 个日志）" : "") + "...");
        // v2.4.3：增量重档——账本有水位且有新帧 → 只提取水位后帧；轮次 = 已归档轮 + 1
        const wm = ARCHIVE_WATERMARK.get(s.id);
        // ★★ 2026-10-14 水位信任闸（wmTrusted）：P14 起写水位时**必带 `byFile` 逐文件向量**
        //   （真实消费帧数），而 P14 之前的 legacy 条目是 `byFile: null` 的乐观水位 —— 正是红队
        //   rev8h A/B 防的"水位虚高 ⇒ 整文件跳过 ⇒ 真内容永不进候选"形态。二者必须区别对待：
        //     · 可信（有 byFile）：`skip > 0` = **这些帧前几轮真读过**，本轮从该处续读**不是漏读**
        //       ⇒ 旧码把它记成 `wmSkippedFiles > 0`，令 `emptyOnly` 恒假、**永不消号**，重试到上限后
        //         留下永久误报（2026-10-14 现场实测：7 个会话全部卡死，其中 2 个是有正文的本日会话）。
        //     · 不可信（legacy / 无 byFile）：**保持旧行为不变** —— 保守认定"账本说的不算读过"。
        const wmTrusted = !!(wm && wm.byFile && typeof wm.byFile === "object");
        const logNames = logPaths.map((p) => path.basename(p));
        const perFile = logPaths.map((p) => { const c = countZstdFrames(p); return c === null ? -1 : c; });
        // ★★ §9.11.4-3 修正三（**红队 rev8b B-1 实测抓出，本批自己的洞**）：
        //   旧写法 `c === null ? 0` 把「**文件读不出来**」塌成 `perFile=0`，于是下方 `skip(0) >= perFile[i](0)`
        //   成立 ⇒ 该文件被记为「已消费 0 帧」、**根本不调用提取器** ⇒ `failed` 仍是 false ⇒ 走 `emptyOnly`
        //   并落盘「确无内容消号…无正文可丢」 —— 正是"读失败伪装成没有内容"的最危险形态，而 `!failed` 挡不住它
        //   （`failed` 只在提取器**返回 null** 时置位，而这条路压根不调提取器）。
        //   ⇒ `-1` 专表「计数失败/读不出来」，且**本会话整轮按失败处理**：不推进、不消号、下轮重试（P0-1）。
        //   （与 `perFile=0`（真·空文件）严格区分：后者是"读出 0 帧"，语义上确实没有内容可丢。）
        if (perFile.some((c) => c < 0)) {
          clog("[dsh-memory] 归档跳过（日志帧计数失败=读不出来，**不消号、下轮重试**）: " + sidLabel(s.id) + "...");
          try { monitorEvent("archive", "extract-skip frames-count-failed sid=" + sidLabel(s.id)); } catch (e) {}
          skippedNoFlow.push(sidLabel(s.id));
          batchFrames.set(s.id, { frames: null, round: 1, incomplete: false, empty: false });
          continue;
        }
        // v2.8.4（P22）：**sum** 量纲 —— `curF` / `wm.frames` / `unit.frames` / `readUnitCache` 的 `curFrames`
        //   四者必须同维；混用「sum」与「单文件」会出现"恒判陈旧（每轮全量重提取）"或"前半段永不进单元"。
        const curF = perFile.reduce((a, b) => a + b, 0);
        const isRe = !!(wm && typeof wm.frames === "number" && curF > wm.frames);
        const nextRound = wm ? (isRe ? (wm.round || 1) + 1 : (wm.round || 1)) : 1;
        const offsets = distributeOffsets(logNames, perFile, wm);   // P21：聚合水位 → 逐文件偏移
        // v2.8.4（P14）：**先占位为 null**（= 不推进水位），提取完成后才写入**真实已消费帧数**。
        //   旧码在此处就写 `curF`（文件总帧数）—— 那是"乐观假设提取一定跑完"；一旦被掐断/抛错，
        //   水位就被推到文件尾 ⇒ 余下帧**永不提取且完全不可观测**。占位 null 让"没跑完"退化为"下轮重试"。
        batchFrames.set(s.id, { frames: null, round: isRe ? nextRound : (wm ? (wm.round || 1) : 1), incomplete: false, empty: false });
        // v2.8.4（P14/P15/P21）：本会话实际消费量 —— 聚合标量 + **逐文件向量**（向量让下一轮精确续跑）。
        let consumed = null;
        let incomplete = false;
        // §9.11.4-3（用户 2026-09-19 拍板「按你推荐的来」）：与 `incomplete` **正交的第三态 = 提取失败**。
        //   失败（`null`：抛错 / frames=0）⇒ 该文件**不推进**、水位留在原处、下轮重试（P0-1「宁重试不静默丢」不变）；
        //   "真·无内容"（结构化空）⇒ 帧已全部检查 ⇒ **可消号**。旧码把这二者共用 `null`（源头 L4034 就短路成 null），
        //   于是下游那条「真·无内容 ⇒ 视为已消费」的分支永远不可达 ⇒ 空候选**永不消号**（僵尸）。
        //   本变量 + `emptyOnly` 就是"把那两条路重新分开"的最小代价：任何一处失败都不得被当成"没有内容"。
        let failed = false;
        // §9.11.4-3 配套可观测：这些"确无内容"的文件里**有多少帧压根解不开**（`badFrames`）——
        //   汇总进 batchFrames ⇒ 消号留痕能如实写出"其中 x 帧坏帧"，而不是只报"无内容"。
        let emptyBadFrames = 0;
        // ★★ §9.11.4-12：**有正文**文件里的坏帧累计（与 `emptyBadFrames` 同口径、分开计 —— 两者语义不同：
        //   前者是"这批帧有内容、但其中若干帧读不出"（内容进单元了，副本可能不全）；
        //   后者是"整批无内容、且其中若干帧读不出"（消号留痕用）。混在一处会让读者分不清是哪一种。
        let bodyBadFrames = 0;
        // v2.4.7（方案C·L2b 单元缓存）：增量重档时先读缓存，只提取新增帧合并——避免重新提取/压缩全量
        const sidShort = unitSid(s.id);
        let unit = null;
        let isMerge = false;
        const rs = [];                       // 各文件的提取产物（P21：双名目录会有两个）
        const consumedVector = [];
        // ★ §9.11.4-3 修正四（红队 rev8b B-2）：**"帧被跳过（水位已覆盖）" ≠ "我读过这些帧"**。
        //   本变量只回答一个问题：本轮**有没有真的把某个文件喂给提取器**（`r` 非 null，含"结构化空结果"）。
        //   它决定账本里那句 `empty:true` 能不能写 —— 那是"我读过、里面没有正文"的断言，一个字都没读时不得写。
        let readAny = false;
        // ★★ §9.11.4-3 修正十一（**上线后现场实测抓出的真漏档，2026-09-19**）：与 `readAny` **正交**的第二个事实 ——
        //   "有没有文件是**按水位**跳过（压根没调提取器）"。见下方该分支上方的详细说明。
        let wmSkippedFiles = 0;    // 按水位跳过的**文件数**（帧数 > 0 才算，空文件不算）
        let wmSkippedFrames = 0;   // 这些文件合计帧数（留痕用）
        WM_PROBE_EMPTY_ROUND = 0;  // ★ 2026-09-25：本轮"空壳证人"计数（模块级：批次级日志要在块外读它）
        for (let i = 0; i < logPaths.length; i++) {
          const skip = offsets[i];
          if (skip >= perFile[i]) {
            // ★★ §9.11.4-3 修正十一（同上）：这条分支**根本不调用提取器**，只凭**账本水位**断定"该文件已消费完"。
            //   而水位可能是**虚高**的 —— 现场 `574b8af7`：v3 日志 **3747 帧 / 12183 字正文**（source=compaction，
            //   含压缩点摘要），水位恰好 `frames=3747`（旧码 P14 之前"乐观把水位写到底"留下的伤 / 量纲误写）
            //   ⇒ 这里把 v3 **整文件跳过** ⇒ 只读了 legacy 那 2 帧（无内容）⇒ `emptyOnly` 成立 ⇒ **消号**
            //   ⇒ 那 12183 字正文**永久不再进候选**（正是用户最怕的「内容没计入」）。
            //   判据：**"账本说读过" ≠ "真读过"** ⇒ 只要有文件是"按水位跳过且有帧"，本轮**不许消号**。
            consumedVector.push(perFile[i]);
            // ★★ 2026-10-14 水位信任闸：可信水位（有 byFile）下"整文件跳过" = 这些帧**前几轮已真读过**，
            //   不是漏读 ⇒ 不计 wmSkip（否则完整归档过的会话每轮都被计入、永不消号）。legacy 水位
            //   （无 byFile）**保持旧行为**（照旧做有界对话探测 + 计 wmSkip），红队防线一字不动。
            if (Number(perFile[i]) > 0 && !wmTrusted) {
              // ★★ 2026-09-25（现场实证 session-28a52c6a）：水位跳过分支里混着**永远无法通过重读变成
              //   有内容**的空壳会话（日志只有 agent/inbox/spliced 通知帧 + 会话元数据，零对话事件）。
              //   它们每轮都进"有帧却没读"，把重试配额耗到上限后留下永久告警「内容可能未入档，请人工核查」。
              //   处置：先做**有界**对话探测（等距采样 ≤12 帧 / 累计 ≤2MB）——
              //     · 命中任一对话/摘要事件 → 维持旧行为（计 wmSkip，不许消号）；
              //     · 全程无命中 → 空壳证人，计 wmProbeEmpty，**不计 wmSkip**（可正常消号，止住误报）；
              //     · 读不了 / 超预算 → null（不确定）⇒ 同样维持旧行为，绝不因探测而放松防线。
              if (probeDialogueEvents(logPaths[i], skip) === false) {
                WM_PROBE_EMPTY_ROUND += 1;
              } else {
                wmSkippedFiles += 1; wmSkippedFrames += Number(perFile[i]) || 0;
              }
            }
            continue;
          }
          const r = await extractMessageFlowAsync(logPaths[i], skip, { deadlineTs: roundDeadline });
          const hasBody = !!(r && (r.flow || (Array.isArray(r.segments) && r.segments.length > 0)));
          if (!r) {                                   // 提取抛错/返回 null ⇒ 保守：该文件**不推进**
            failed = true;                            // §9.11.4-3：**失败**必须与"无内容"分开 —— 失败不得消号
            consumedVector.push(skip);
            break;
          }
          readAny = true;                             // 提取器确实被调用且给出了答复（无论空不空）
          // ★★ 修正十一·补（**红队 rev8h A：形态X 逃逸**）：**"读过一部分"也不算读过全部**。
          //   红队实测的边界形态：单文件、水位**恰比帧数小**（`perFile=[100], wm=99`）⇒ `skip=99 < 100`
          //   **不进**上面那条"整文件跳过"分支 ⇒ 只读**最后 1 帧**；若那帧是控制帧 ⇒ `rs=[] ∧ !failed ∧ !incomplete ∧ wmSkipped=0`
          //   ⇒ `emptyOnly` 仍为真 ⇒ **照旧消号**，而 0..98 共 99 帧从未被读（比"整文件跳过"更隐蔽）。
          //   ⇒ 判据从"整文件跳过"放宽为「**本文件本轮实读帧数 < 它剩余应读帧数**」。
          //   `consumedFrames` 是**全局帧位置** ⇒ 本文件实读 = consumedFrames − skip；应读 = perFile[i] − skip。
          if (!r.incomplete) {
          //   ★ 修法（第二版。**我第一版判据错了**：提取器"读到文件尾"时 `consumedFrames == perFile[i]`，
          //     从"读了多少帧"根本看不出"前 99 帧从未被本轮验证"）⇒ 正确判据：该文件有 `skip > 0` 帧是
          //     **"账本说已消费"**的，而本轮**没有任何产出证明过它们** ⇒ 它们属于"未被本轮验证"。
          //     一句话：**只要存在 skip > 0 的文件，本轮就不许按"确无内容"消号**（账本说的不算读过）。
          //     ★ 2026-10-14 水位信任闸：该判据只对**不可信水位（legacy / 无 byFile）**成立 ——
          //       可信水位下 `skip > 0` 表示这些帧**前几轮已真读过**（P14 起写的是真实消费量），
          //       再据它拒绝消号 ⇒ 任何增量归档的会话都会在 3 轮后变成永久误报。
          if (!r.incomplete && skip > 0 && !wmTrusted) { wmSkippedFiles += 1; wmSkippedFrames += skip; }
          }
          if (!hasBody) {
            if (r.incomplete) {                       // 掐断且无产出 ⇒ 按已消费帧推进并停
              consumedVector.push(Number.isFinite(r.consumedFrames) ? r.consumedFrames : skip);
              incomplete = true;
              break;
            }
            consumedVector.push(perFile[i]);           // 真·无内容 ⇒ 帧**已全部检查** ⇒ 视为已消费
            if (r.empty) emptyBadFrames += (Number(r.badFrames) || 0);   // §9.11.4-3：坏帧数照实上报（消号留痕用）
            continue;
          }
          rs.push(r);
          // ★★ §9.11.4-12：**有正文的文件也要累计坏帧**（原先只有 `!hasBody` 那条累计 ⇒
          //   "有正文但部分帧读不出"在本模块内**完全没有读数**）。口径与空路径一致：`r.badFrames`。
          bodyBadFrames += (Number(r.badFrames) || 0);
          consumedVector.push(Number.isFinite(r.consumedFrames) ? r.consumedFrames : perFile[i]);
          if (r.incomplete) { incomplete = true; break; }   // 掐断 ⇒ 停止后续文件（它们是更晚的时间段）
        }
        // 聚合消费量：消费严格按时间顺序推进 ⇒ 向量是**前缀**，求和即为有效聚合水位
        let sumConsumed = consumedVector.reduce((a, b) => a + b, 0);
        // 不变量（P14）：水位**永不后退**（日志被外部重写/缩水 / 本轮一无所获 都不得把水位改小）
        if (wm && typeof wm.frames === "number" && sumConsumed < wm.frames) sumConsumed = wm.frames;
        consumed = sumConsumed;
        const byFile = {};
        logNames.forEach((n, i) => { byFile[n] = consumedVector[i] === undefined ? 0 : consumedVector[i]; });
        // ★★ §9.11.4-3（用户 2026-09-19 拍板）：**"确实无内容" ⇒ 帧已全部检查 ⇒ 可消号**。
        //   四个条件**同时**成立才算"确无内容"，任一不成立即回退到"不消号、下轮重试"：
        //     ① 有日志文件（`logPaths.length === 0` 是"日志不可识别"，在上方已按 `frames:null` 跳出）；
        //     ② 没有任何文件产出正文（`rs` 为空 —— 结构化空结果不进 `rs`，见 `hasBody` 分支）；
        //     ③ 没被墙钟掐断（掐断 ⇒ 尾帧还没看 ⇒ 必须下轮续跑）；
        //     ④ **没有任何提取失败**（`null`）。④ 的**精确覆盖面**（红队 rev8b F-① 指出我原先说法夸大，已更正）：
        //        它覆盖"提取器被调用了并返回 null"这条；而"压根不调提取器"的两种形态已被**上游**分别挡住 ——
        //        `perFile < 0`（帧计数失败）在本会话开头就 `continue`（修正三），`logPaths.length === 0` 由 ① 挡住。
        //        ⇒ 四条件合起来才是"读失败不得被当成没有内容"的**完整**保障，单靠 `!failed` 不是。
        //     ⑤ ★★ 修正十一（**现场实测，2026-09-19**）：**没有任何文件是"按水位跳过且有帧"**。
        //        这是五条件里唯一防"**水位虚高导致真内容被整文件跳过**"的一条 —— 现场 `574b8af7` 的 v3
        //        有 3747 帧/12183 字正文，水位恰好等于帧数 ⇒ 被整文件跳过 ⇒ 前四条**全部为真** ⇒ 会消号 ⇒ 永久漏档。
        //        ⇒ 加 `wmSkippedFiles === 0`：只要有一个文件是"按水位跳过且有帧"，本轮**不消号**（保住候选、下轮重试）。
        const emptyOnly = (logPaths.length > 0 && rs.length === 0 && !incomplete && !failed && wmSkippedFiles === 0);
        const cached = isRe ? readUnitCache(sidShort, curF) : null;   // 批0（P0-5）：传当前帧数（sum 量纲）判陈旧
        const combined = combineExtracts(rs, consumed, incomplete);   // P21：多文件产物并成一个单元原料
        if (combined) {
          if (cached) {
            const newUnit = compressUnit(combined, "");
            unit = mergeUnitCache(cached, newUnit, consumed, nextRound);
            isMerge = true;
          } else {
            unit = compressUnit(combined, "");
            unit.sampled = !!combined.sampled; unit.truncated = !!combined.truncated;   // 批0（P0-6）：透传真实覆盖信号
          }
        } else if (cached) {
          // 批0（P0-5）：**显式标注**"新增帧提取失败/为空 → 回退旧缓存"。原实现静默把旧缓存当本轮成功单元。
          unit = Object.assign({}, cached);
          unit.staleFallback = true;
          isMerge = true;
        }
        // v2.8.4（P14/P21）：把**已消费帧数**（聚合 sum）+ **逐文件向量**交回 settle 写入水位账本。
        // ★★ §9.11.4-12：新增 `bodyBadFrames`（**有正文**文件里的坏帧），与既有 `badFrames`
        //   （仅在 `emptyOnly` 时非零）**并列**，不改后者语义 —— 后者已被健康行/消号留痕读取，改它等于改既有口径。
        batchFrames.set(s.id, { frames: consumed, byFile: byFile, round: isRe ? nextRound : (wm ? (wm.round || 1) : 1), incomplete: incomplete, empty: emptyOnly, badFrames: emptyOnly ? emptyBadFrames : 0, bodyBadFrames: bodyBadFrames, readAny: readAny, wmSkippedFiles: wmSkippedFiles, wmSkippedFrames: wmSkippedFrames });
        if (unit && unit.text) {
          // v2.8.4（P12）：**口径版本**随单元落盘 —— 缺它则下一轮 `readUnitCache` 直接拒收（每轮全量重提取），
          //   且 `unitCounterVerMismatch` 恒 true ⇒ 候选旁路永不收敛。
          unit.sid = sidShort; unit.frames = (consumed === null ? curF : consumed); unit.round = nextRound; unit.at = Date.now();
          unit.counterVer = EXTRACT_COUNTER_VER;
          writeUnitCache(unit);
          flowSessions.push({ session: s, unit: unit, sampled: (unit.sampled === undefined ? unit.source === "messageflow" : !!unit.sampled), truncated: !!unit.truncated, staleFallback: !!unit.staleFallback, isRe: isRe, round: nextRound, incomplete: incomplete, consumedFrames: consumed });
        } else {
          skippedNoFlow.push(sidLabel(s.id));
        }
      }
      // v2.4.7（方案C）：删除 v1.12.18.3 逐段 spawn 子代理的 map-reduce 仿真压缩循环——
      // 该循环 16 个大会话×每会话多段≈几十次子代理调用烧巨量 token，且产出仍要进单巨型 prompt。
      // 现在 compressUnit 已在提取时完成确定性压缩（零子代理）。

      const handledIds = []; // 本轮实际处置名单 —— **只有真提取到内容的会话**才进（供调用方登记 ARCHIVED_SESSIONS + 写水位）
      // 批0（P0-1）：**提取失败/为空的会话不得进 handledIds**。
      //   原实现把 skippedNoFlow 也 push 进 handledIds ⇒ settle 时 ARCHIVED_SESSIONS.add + 水位写成 curF
      //   ⇒ archivePendingEntry 只在 cur > wm.frames 时重入 ⇒ **该会话的帧永远不会再被提取**，且不可观测。
      //   现改为：只保留"已提醒"去重（STALE_NOTIFIED），不消号、不写水位 ⇒ 下一轮会重试（宁重试，不静默丢）。
      skippedNoFlow.forEach((id) => {
        const s = batch.find((x) => x.id.startsWith(id));
        if (s) STALE_NOTIFIED.add(s.id);
      });
      flowSessions.forEach((f) => handledIds.push(f.session.id));
      // 批0（P0-1）：把"提取异常"变成**可观测**（原来只有"整批全无流"才单列，混在成功批次里只剩一个聚合数）
      const nInc = flowSessions.filter((f) => f.incomplete).length;
      if (skippedNoFlow.length > 0 || flowSessions.some((f) => f.staleFallback || f.truncated) || nInc > 0) {
        const nFb = flowSessions.filter((f) => f.staleFallback).length;
        const nTr = flowSessions.filter((f) => f.truncated).length;
        const nWmSkip = batchFrames ? Array.from(batchFrames.values()).filter((m) => m && m.wmSkippedFiles > 0).length : 0;
        cwarn("[dsh-memory] 归档提取异常：无内容跳过 " + skippedNoFlow.length + " 个（**不消号，下轮重试**）" + (nWmSkip > 0 ? "、**按水位跳过（账本说已消费但本轮没读）** " + nWmSkip + " 个（不消号，防真内容被漏档）" : "") + "、旧缓存回退 " + nFb + " 个、预算截断 " + nTr + " 个" +
          (WM_PROBE_EMPTY_ROUND > 0 ? "、**空壳证人（探测确认无对话事件）** " + WM_PROBE_EMPTY_ROUND + " 个（按确无内容处置、正常消号）" : "") +
          (nInc > 0 ? "、**墙钟掐断 " + nInc + " 个（水位只推进到已消费帧，下轮由 shouldReArchive 从该帧续跑）**" : ""));
        try { monitorEvent("archive", "extract-anomaly skippedNoFlow=" + skippedNoFlow.length + " staleFallback=" + nFb + " truncated=" + nTr + " incomplete=" + nInc + " wmSkip=" + nWmSkip + " wmProbeEmpty=" + WM_PROBE_EMPTY_ROUND); } catch (e) {}
      }
      // ★★ §9.11.4-3 落盘段（**没有它，上面的修复等于不存活**）：
      //   把"确无内容"的候选本轮**已消费帧**写进水位账本并消号。
      //   为什么必须在**这里**做、而不能复用 settle 路径：settle 只遍历 `handledIds`（= 真提取到内容的会话，
      //   L7033 注释），空候选**永远进不去** ⇒ 水位永不推进 ⇒ 下一轮 `shouldReArchive` 照样判"有新增"
      //   ⇒ 僵尸候选每轮重选、每轮白轮，并把**真正的新会话**的自动归档一起压进 24h 退避。
      //   安全性：`emptyOnly` 已排除"失败/掐断"（见其定义）⇒ 这里推进帧的都是**没有内容可丢**的；
      //   消号也**不封死**未来 —— 该会话一旦追加新帧，`cur > wm.frames` ⇒ 立刻重新成候选（与 P21 量纲一致）。
      const emptyConsumed = [];
      // ★ 变量改名（回归门席 rev8 复核抓出的**可读性缺陷**）：循环体内另有一个同名 `emptyBadFrames`（逐会话），
      //   复核者据缩进判成"外层不可达的死代码"——实测两份都在用（L7018/L7057 用循环体那份，本处用这份轮汇总），
      //   不是死代码，但同名确实会让人读错归属 ⇒ 本轮汇总改名 `roundBadFrames` 以示区别。
      let roundBadFrames = 0;
      let notReadCount = 0;
      // ★★ 修正十三（**红队 rev8h B：修正十一的收敛语义与实际相反**）：`wmSkip` 的**真重试 + 有限次终局**。
      //   红队实测：修正十一之后 wm-skip 会话**既不全消号、也不会重试**（`shouldReArchive` 三条路全 false：
      //   `incomplete` 未置 / 旁路默认关 / `archivePendingEntry` 要 `cur > wm.frames` 而水位已虚高 ⇒ 恒假）
      //   ⇒ "不消号但永久静默挂起" 与 "消号后永久漏档" **结果等价**（同一份 12183 字都不再进候选）。
      //   ⇒ 这里给它们一个**显式凭据**（`wmSkip` + `wmSkipRounds`），由 `shouldReArchive` 据此**真重入**，
      //     并在重试到上限后**升级为可见告警**（不再无限重试、也不再静默）。
      // （常量已上提为模块级单点所有者 —— 工程席 rev8k A1）
      let wmSkipMarked = 0, wmSkipExhausted = 0;
      // ★★ 修（**上线后现场实测抓出的真缺陷**）：`wmSkipItems` 原先是 **`try` 块内的 `const`** ⇒ 块外不可见
      //   ⇒ 打印语句里 `typeof wmSkipItems !== "undefined"` 恒为 `"undefined"` ⇒ **留痕行的 sid 标签永远为空**
      //   （线上 18:11 实测：`…上限 3 次）: ` 后面空白）。**必须声明在 try 块外**（与 `wmSkipMarked` 同级）。
      let wmSkipItems = [];
      try {
        for (const s of batch) {
          const m = batchFrames.get(s.id);
          if (!m || m.empty !== true || typeof m.frames !== "number") continue;
          // §9.11.4-3 修正四（红队 rev8b B-2）：**`empty:true` 是"我读过、里面没有正文"的断言** ——
          //   只有本轮**真的把某个文件喂给过提取器**（`readAny`）时才配写它。若全部文件都被水位判为"已消费"
          //   （一次提取都没发生），照写 `empty:true` 就是**无证据的断言**；那种情形改记 `skipped:true`
          //   （如实说"本轮没读、这些帧按账本已消费"）—— 水位照常推进、`incomplete` 照常清零，收敛不受影响。
          const claimEmpty = m.readAny === true;
          if (!claimEmpty) notReadCount++;
          // ★★ 修正八（**根因席 rev8f C-3，本批自己引入的风险**）：**不得把 round 推进**。
          //   `m.round` 取自 `nextRound = isRe ? (wm.round||1)+1 : …` —— 那是"本轮**准备**归档第几轮"的语义。
          //   但空候选**从未真正归档**（没有单元、没有落库）⇒ 把 round 写进水位等于把轮次记高；
          //   而补档去重是按 header `### <sid> ·补<N>（` 判"已在库"的 ⇒ **后续真归档会被误判"已在库"而静默丢弃**
          //   （`LAST_ARCHIVE_FLOW.rounds` 与水位 round 是两处来源，一旦水位被推高就不再同源）。
          //   ⇒ 这里只推进**帧位**（水位），轮次沿用账本原值；"为什么判它已归档"由 `empty/skipped` 自答。
          const keepRound = (ARCHIVE_WATERMARK.get(s.id) && ARCHIVE_WATERMARK.get(s.id).round) || 1;
          // 见证不继承：空候选从不进 `flowSessions`，`LAST_ARCHIVE_WITNESS` 里可能**是别人的结论**
          //   （根因席 B：子代理对未送候选发 skip 时会写 witness）⇒ 写 null，避免 `{empty:true, witness:{declared-skip}}` 自相矛盾。
          ARCHIVE_WATERMARK.set(s.id, { frames: m.frames, round: keepRound, at: Date.now(), incomplete: false, byFile: m.byFile || null, witness: null, empty: claimEmpty, skipped: !claimEmpty });
          ARCHIVED_SESSIONS.add(s.id);
          roundBadFrames += (Number(m.badFrames) || 0);
          emptyConsumed.push(sidLabel(s.id) + "@" + m.frames);
        }
        if (emptyConsumed.length > 0) { ARCHIVE_WM_DIRTY = false; saveStaleNotified(); }
        // ★★ 修正十三：给**因按水位跳过而没消号**的会话写显式凭据（真重试的依据 + 有限次终局）。
        // （`wmSkipItems` 已提到 try 块外声明 —— 否则块外看不到它、留痕标签恒空；见上方注释）
        for (const s of batch) {
          const m = batchFrames.get(s.id);
          if (!m || m.empty === true) continue;                       // 消号的那些已在上面的分支处理
          if (!(Number(m.wmSkippedFiles) > 0)) continue;              // 只处理"有帧却被按水位整文件跳过"的
          const prev = ARCHIVE_WATERMARK.get(s.id) || {};
          const rounds = (Number(prev.wmSkipRounds) || 0) + 1;
          ARCHIVE_WATERMARK.set(s.id, Object.assign({}, prev, {
            wmSkip: true, wmSkipRounds: rounds, wmSkippedFiles: Number(m.wmSkippedFiles) || 0,
            wmSkippedFrames: Number(m.wmSkippedFrames) || 0, wmSkipAt: Date.now(),
          }));
          wmSkipMarked++;
          if (rounds >= WM_SKIP_MAX_ROUNDS) { wmSkipExhausted++; wmSkipItems.push(sidLabel(s.id) + "×" + rounds); }
          else wmSkipItems.push(sidLabel(s.id) + "×" + rounds + "（下轮重试）");
        }
        if (wmSkipMarked > 0) { ARCHIVE_WM_DIRTY = false; saveStaleNotified(); }
      } catch (e) {}
      // ★★ 修正十三（红队 rev8h B／P1）：**wm-skip 的留痕分两级** —— 未到上限=可自愈（clog + monitor::每轮）；
      //   到上限=**升级为用户可见告警**（不再重试，但也不再静默）。
      if (typeof wmSkipMarked !== "undefined" && wmSkipMarked > 0) {
        clog("[dsh-memory] 按水位跳过（有帧却没读）" + wmSkipMarked + " 个 ⇒ **不消号**、下轮重试（上限 " + WM_SKIP_MAX_ROUNDS + " 次）: " + (typeof wmSkipItems !== "undefined" ? wmSkipItems.join(", ") : ""));
        try { monitorEvent("archive", "wm-skip count=" + wmSkipMarked + " exhausted=" + (typeof wmSkipExhausted !== "undefined" ? wmSkipExhausted : 0) + " items=" + (typeof wmSkipItems !== "undefined" ? wmSkipItems.join("|") : "")); } catch (e) {}
        if (typeof wmSkipExhausted !== "undefined" && wmSkipExhausted > 0) {
          cwarn("[dsh-memory] ⚠ **按水位跳过已达重试上限** " + wmSkipExhausted + " 个：这些会话的日志里**有帧却从未被读取**"
            + "（水位虚高 → 整文件跳过），重试 " + WM_SKIP_MAX_ROUNDS + " 轮仍未成功 ⇒ **停止自动重试**。"
            + "内容可能未入档 —— 请人工核查，或把该会话的水位手工降为真实已读帧数后重跑。");
        }
      }
      if (emptyConsumed.length > 0) {
        clog("[dsh-memory] 无正文类内容可丢 ⇒ 消号 " + emptyConsumed.length + " 个（水位推进到已消费帧"
          + (roundBadFrames > 0 ? "；⚠其中 " + roundBadFrames + " 帧解压失败（坏帧 / 幻影 magic / 截断写），已随本行留痕；对同一份字节重试不会改变结果" : "")
          + (notReadCount > 0 ? "；另有 " + notReadCount + " 个本轮**一个文件都没读**（水位已判其帧消费完）⇒ 只推进水位、**不写 `empty` 断言**，账本记 `skipped:true`" : "")
          + "）: " + emptyConsumed.join(", "));
        try { monitorEvent("archive", "empty-consumed count=" + emptyConsumed.length + " badFrames=" + roundBadFrames + " notRead=" + notReadCount + " items=" + emptyConsumed.join("|")); } catch (e) {}
      }
      // ★★ §9.11.4-12（**有正文会话的坏帧可见性**）：原先**只有空会话**的坏帧会被上报（上面那一行）。
      //   ⇒ 若某会话"有正文但部分帧解不开"，单元照样产出、日志**一句都不提** ⇒ 读者无从知道"副本可能不全"。
      //   这正是 L4232 注释承诺过的事（「事后能回答『这批帧读出来了吗』」）**只在空会话上兑现**。
      //   ⇒ 本轮**有正文**文件的坏帧合计，单列一行；并且只在 >0 时打印（不制造噪音）。
      {
        let roundBodyBad = 0, badItems = [];
        for (const s of batch) {
          const m = batchFrames.get(s.id);
          const n = Number(m && m.bodyBadFrames) || 0;
          if (n > 0) { roundBodyBad += n; badItems.push(sidLabel(s.id) + "×" + n); }
        }
        if (roundBodyBad > 0) {
          cwarn("[dsh-memory] ⚠ 有正文会话里**共 " + roundBodyBad + " 帧解压失败**（坏帧 / 幻影 magic / 截断写）："
            + badItems.slice(0, 6).join(", ") + (badItems.length > 6 ? " …共 " + badItems.length + " 个会话" : "")
            + " —— 这些会话的单元**已产出**，但**副本可能不全**（缺的正是那些帧）；对同一份字节重试不会改变结果。");
          try { monitorEvent("archive", "body-badframes total=" + roundBodyBad + " items=" + badItems.slice(0, 8).join("|")); } catch (e) {}
        }
      }
      if (flowSessions.length === 0) {
        clog("[dsh-memory] 无可归档会话（全部无消息流，跳过 " + skippedNoFlow.length + " 个" + (emptyConsumed.length > 0 ? "，其中无正文类内容已消号 " + emptyConsumed.length + " 个" : "") + "）");
        monitorEvent("archive", "settled mode=no-flow wrote=0 skipped=" + skippedNoFlow.length + " flow=0 emptyConsumed=" + emptyConsumed.length);
        // v2.4.7.1: 本路径已把整批消息流白提一遍且无流会话不消号 → 吃 15 分短窗（不改消号语义：日志稍后出现仍能重入）
        //   §9.11.4-3 补注：上面的"不消号"只对**失败/掐断**成立；"确无内容"已在进入本分支前消号并写水位。
        //   退避仍按候选集指纹作用（`untilFp`）⇒ 消号后候选集即变小，下一 tick 的 `fp` 不同 ⇒ 立即放行，
        //   不会被这 24h 压住（这也是"僵尸候选不再反复起火"的收敛点）。
        return { ok: false, whiteRun: true, reason: "全部会话无消息流", overflow: overflow };
      }
      const todayStr = dateStr(new Date());   // v2.4.25（审查 P2-6）：本地日期——原 toISOString 是 UTC，本地 00:00-08:00 归档时「补档日期」错一天
      // v2.4.7（方案C·L3 分桶）：单元 → 确定性分桶（预算 60K 字符/5 单元/批）
      const allSidShort = flowSessions.map((f) => unitSid(f.session.id));
      const buckets = bucketUnits(flowSessions.map((f) => ({ sid: unitSid(f.session.id), text: f.unit.text, chars: f.unit.chars || f.unit.text.length, sampled: !!f.sampled, isRe: !!f.isRe, round: f.round, session: f.session })));
      // v2.3.2(archive-tool): 批次状态初始化——sessionIds 为全量（所有批），declared 跨批累计，A5 全量校验
      LAST_ARCHIVE_FLOW = { sessionIds: allSidShort, todayStr: todayStr, declared: new Set(), rounds: {} };
      flowSessions.forEach((f) => { if (f.isRe && f.round > 1) LAST_ARCHIVE_FLOW.rounds[unitSid(f.session.id)] = f.round; });
      LAST_ARCHIVE_WROTE_AT = 0; LAST_ARCHIVE_A5_OK = false;
      LAST_ARCHIVE_WITNESS = new Map();   // v2.8.4（P18）：见证按**轮**重置——混轮会让"谁被丢"指向错的轮
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
          "（清单**只含本批会话**；插件的完整性校验按本批结算 —— **不需要**为不在清单内的 id 提交任何声明。）\n" +
          "\n===== 你的职权（完全自主决策）=====\n" +
          "1. 逐会话判断归档价值：无实质内容（寒暄/空会话/记忆库已覆盖）→ 跳过并在报告说明理由。\n" +
          "1b. **补档轮次会话**（块头标有【补档第N轮】并附「已归档要点」）：该会话此前已归档过，本次消息流**只含上次归档之后的新增内容**——points 只写新增部分的新事实，与旧要点重叠的一律不复述、禁止改写旧条目；确无增量价值则该会话 skip=true + 理由。sessionId 照用同一短 id，轮次落盘标记由插件生成，你不用管。\n" +
          "2. 内容少 → 你直接总结全部。\n" +
          "3. 全部提交完成后，最终输出一行处置报告（[短id] 档案已产/跳过+理由）；插件以工具提交为准。**不要输出 [ARCHIVE_BEGIN] 等检查点格式文本**。\n" +
          "4. **交付（唯一方式）**：对每个会话调用 memory_archive_checkpoint 工具提交检查点，参数 { blocks: [ { file, sessionId, title, points[], skip?, reason? } ] }：\n" +
          "   - file 只能是 sessions/|projects/ 前缀相对路径（归属日期从消息流推断，推断不出用最后交互日）；sessionId 必须从短 id 清单逐字取用；\n" +
          "   - 有价值 → 填 title + points（3-6 条要点，精确字面量（文号/路径/命令/参数/报错串/数值）逐字保留绝不概括改写；与已有归档重叠只记增量并标注）；\n" +
          // §9.12③：字面量**单独一条通道**（进 literals.md，不进注入层）—— 要点是概括句，字面量在概括里会被自然丢掉
          "   - **另填 `literals[]`**（可选但强烈建议）：把本轮出现的**精确字面量**逐条列进去（GUID/URL/文件路径/命令/参数/文号/报错串/数值），\n" +
          "     每条一行、原样复制不概括；插件会去重后追加到记忆库 `knowledge/字面量.md`（**不进注入层**、不占前缀缓存，供 memory_search 检索）。\n" +
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
          const _arcParent = pickSpawnParent(LAST_TOP_AGENT, null);
          if (!_arcParent) throw new Error("无可用父 agent（dsh 0.1.7 起 subagents.start 的 parent 必填）");
          spawnOpts.parent = _arcParent;
          // v2.4.7.1（回归修复②）：本函数只做「发起」——subagents.start 秒级返回，供上层判定
          //   r.ok=已发起 并当场落节流戳；run.result 的长等待移进 settle 链后台跑。发起失败抛出交调用方收集。
          const run = await startSubagentCompat(subagents, spawnOpts);   // v3.2.1：兼容 0.1.x/0.2.x
          markPluginSubagent(run.id);   // v2.4.27：登记插件子代理 sid（A/B/C/D 提醒隔离全关，只计 monitor）
          rememberArchiveBatch(run.id, sidList);   // ★ 2026-09-25：登记本批短 id 清单（A5 按本批校验）
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
          if (notCompleted) return { ok: false, label: h.label, batchIdx: h.batchIdx, err: "stopReason=" + result.stopReason };
          return { ok: true, label: h.label, batchIdx: h.batchIdx };   // ★ B1″：批标识随结果带出（逐批记账要用）
        } catch (e) {
          cwarn("[dsh-memory] 归档批失败: " + h.label + " - " + (e && e.message ? e.message : String(e)));
          if (h.sid) guardClear(h.sid);   // v2.4.28（D4）：异常路径也注销
          return { ok: false, label: h.label, batchIdx: h.batchIdx, err: e && e.message ? e.message : String(e) };
        }
      };
      // v2.4.7.1（回归修复②）：两段式——第一段在并发上限内把所有批「发起」（秒级返回），第二段 settle 链后台「结算」。
      //   旧写法把 await Promise.all(workers)（含 await run.result）留在本函数内 → 上层 r.ok 要等子代理全部跑完，
      //   节流戳与水位也随之推迟落盘：归档中途重启 = 两者皆空 = 新实例立刻重提整批并重送子代理（真重复烧 token）。
      const handles = [];
      const startErrs = [];
      const firstWave = Math.min(ARCHIVE_MAX_CONCURRENT, buckets.length);
      for (let i = 0; i < firstWave; i++) {
        try { handles.push(await startOneBatch(buckets[i], i)); }
        catch (e) { startErrs.push(e && e.message ? e.message : String(e)); }
      }
      if (buckets.length > firstWave) {
        clog("[dsh-memory] 归档并发闸：首批 " + firstWave + "/" + buckets.length + " 批已发起，其余 " + (buckets.length - firstWave) + " 批排队（在跑上限 " + ARCHIVE_MAX_CONCURRENT + "）");
      }
      if (handles.length === 0) {
        monitorEvent("archive", "failed reason=spawn err=" + (startErrs[0] || "?"));
        cwarn("[dsh-memory] 漏网归档子代理全部发起失败（" + startErrs.length + " 批）：" + (startErrs[0] || ""));
        return { ok: false, whiteRun: true, reason: "子代理发起失败", overflow: overflow };   // whiteRun=本轮已白提 → 吃 15 分短窗；不消号，下轮重来
      }
      if (startErrs.length > 0) cwarn("[dsh-memory] " + startErrs.length + " 批子代理发起失败（其会话本轮不消号，留待下轮）: " + startErrs[0]);
      // v2.4.7.1: settle 链（后台）——等已发起的批全部跑完 → A5 全量判定 → 消号；session-start 调用方不 await 本链
      const settle = (async () => {
        try {
          // v2.6.6：队列补批——每个槽位结算完一批后，从等待队列取下一批发起，使
          //   「在跑子代理数 ≤ ARCHIVE_MAX_CONCURRENT」真实成立（旧版把全部批一次发起、闸门失效）。
          //   发起失败只记 startErrs 并继续取下一批（不卡队列）；失败批的会话本轮不消号。
          const batchResults = [];
          let nextIdx = firstWave;
          const runner = async (h) => {
            let cur = h;
            while (cur) {
              batchResults.push(await joinOneBatch(cur));
              cur = null;
              while (nextIdx < buckets.length) {
                const idx = nextIdx++;
                try { cur = await startOneBatch(buckets[idx], idx); handles.push(cur); break; }
                catch (e) { startErrs.push(e && e.message ? e.message : String(e)); }
              }
            }
          };
          await Promise.all(handles.map((h) => runner(h)));
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
          // v2.8.4（P18）：本轮**内容见证**入账 —— 每次结算都写（含失败轮：失败轮的见证正是"内容去哪了"的唯一线索）。
          //   口径由 `summarizeArchiveWitness` 单一给出（纯函数，门直测），读者不再各自解释账本字段。
          try {
            // v2.8.4（P18）：把**本轮该 sid 的单元字符数**附给每条见证 ⇒ 读者能回答方案原文要求的那个问题：
            //   「有没有哪个会话**明明提取到了内容（单元非空）却被声明跳过**」= (D) 方向下最危险的静默丢弃形态。
            const unitCharsBySid = new Map();
            for (const f of flowSessions) { try { unitCharsBySid.set(unitSid(f.session.id), (f.unit && (f.unit.chars || (f.unit.text || "").length)) || 0); } catch (e) {} }
            const entries = Array.from(LAST_ARCHIVE_WITNESS.entries()).map((kv) => [kv[0], Object.assign({}, kv[1], { unitChars: unitCharsBySid.get(kv[0]) || 0 })]);
            const wsum = summarizeArchiveWitness(entries, LAST_ARCHIVE_A5_OK);
            const stW = readIntegrateState() || {};
            stW.archiveWitnessLast = Object.assign({ at: Date.now(), startCount: flowSessions.length, doneOk: doneOk }, wsum);
            writeIntegrateState(stW);
          } catch (e) {}
          if (!doneOk) cwarn("[dsh-memory] " + archNote);
          // ★★ B1″（2026-10-07 现场取证）：**逐批记账** —— 旧实现把账本写入挂在整轮 `doneOk` 与门上，
          //   任一批失败 ⇒ **已成功落盘的会话也不记账** ⇒ 账本丢收据，而盘上的块已经写成"已归档"强证据
          //   ⇒ 该会话被提及闸永久挡死（连补档都进不去；现场 35a85221 / b41ae2f2）。
          //   判据**只收紧不放松**：①该会话所属批正常完成（别批失败不再连坐）
          //   ②且该会话确实被处置（written / declared-skip / dropped-非写盘异常）。
          //   本块**纯追加**：doneOk 路径一字未动。
          if (!doneOk) {
            try {
              const sidBatchIdx = new Map();
              buckets.forEach((bu, i) => bu.forEach((u) => sidBatchIdx.set(u.sid, i)));
              const okBatchIdx = new Set(batchResults.filter((r) => r.ok).map((r) => r.batchIdx));
              const recordIds = handledIds.filter((id) => {
                const s = unitSid(id);
                return okBatchIdx.has(sidBatchIdx.get(s)) && archiveWitnessDisposed(LAST_ARCHIVE_WITNESS.get(s));
              });
              if (recordIds.length > 0) {
                recordIds.forEach((id) => {
                  ARCHIVED_SESSIONS.add(id);
                  const m = batchFrames.get(id);
                  if (m && typeof m.frames === "number") ARCHIVE_WATERMARK.set(id, { frames: m.frames, round: m.round, at: Date.now(), incomplete: !!m.incomplete, byFile: m.byFile || null, witness: LAST_ARCHIVE_WITNESS.get(unitSid(id)) || null });
                });
                ARCHIVE_WM_DIRTY = false; saveStaleNotified();
                clog("[dsh-memory] 逐批记账（整轮 doneOk=false）：已正常完成的批记账 " + recordIds.length + "/" + handledIds.length + " 个会话（别批失败不再连坐）");
                monitorEvent("archive", "per-batch-record n=" + recordIds.length + "/" + handledIds.length + " okBatches=" + okBatchIdx.size + "/" + buckets.length);
              }
            } catch (ePB) { cwarn("[dsh-memory] 逐批记账失败:", ePB && ePB.message ? ePB.message : String(ePB)); }
          }
          if (doneOk) {
            try {
              handledIds.forEach((id) => {
                ARCHIVED_SESSIONS.add(id);
                const m = batchFrames.get(id);
                // v2.8.4（P14/P15）：水位记 **`consumedFrames`（已消费帧数）**，不再是文件总帧数；
                //   `incomplete` 随账本落盘 ⇒ 下一轮 `shouldReArchive` 会放行该会话**从该帧续跑**。
                // v2.8.4（P18）：水位条目**随身携带内容见证** —— 事后查"这个 sid 为什么被判已归档"时，
                //   账本自己就能回答（written N 字 / declared-skip / dropped 原因+被丢字数），不靠推断。
                if (m && typeof m.frames === "number") ARCHIVE_WATERMARK.set(id, { frames: m.frames, round: m.round, at: Date.now(), incomplete: !!m.incomplete, byFile: m.byFile || null, witness: LAST_ARCHIVE_WITNESS.get(id) || null });
              });
              ARCHIVE_WM_DIRTY = false; saveStaleNotified();
            } catch (e) {}
            try {
              const remain = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt()).filter((s) => !sessionMentionedInMemory(s.id) && archivePendingEntry(s)).length;
              LIVE_STATS.staleCount = remain;   // [2026-09-23] scope 通道退役，随 stats.json 下发
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
            const u2 = await summarizeSubagentUsageRetry(sdir2);   // §9.12④：读不到 usage 时有界重试（≤4 次 × 1.5s）
            if (u2) { clog("[dsh-memory] 归档消耗: 总输入 " + (u2.totalIn || u2.input) + " tokens（其中缓存命中 " + u2.cache + "）| 输出 " + u2.output + (u2.reasoning > 0 ? " | 推理 " + u2.reasoning : "") + " tokens | 总时长 " + u2.durMin + " 分钟" + (u2.usageEmpty ? "（⚠️ usage 读取失败：重试 " + u2.usageRetry + " 次仍无 usage，账本记 usageEmpty=true，**别当成 0 消耗**）" : (u2.usageRetry > 1 ? "（读取重试 " + u2.usageRetry + " 次）" : ""))); trackMaintain("arch", u2); 
              // v2.8.4（自动归档包⑤）：每轮 token 消耗**入账**（原来只有 clog —— 控制台一滚就再也查不到"这轮花了多少"）
              try {
                const stT = readIntegrateState() || {};
                stT.archiveTokenLast = { at: Date.now(), inT: u2.totalIn || u2.input || 0, cacheT: u2.cache || 0, outT: u2.output || 0, durMin: u2.durMin || 0, usageRetry: u2.usageRetry || 1, usageReadAt: u2.usageReadAt || Date.now(), usageEmpty: u2.usageEmpty === true };
                writeIntegrateState(stT);
              } catch (e) {}
            } else {
              // §9.12④：**读不到也要留痕**（旧实现这里静默——账本连"这轮没读到"都不知道，于是 0 消耗与"没读"不可区分）
              try {
                const stT0 = readIntegrateState() || {};
                stT0.archiveTokenLast = { at: Date.now(), inT: 0, cacheT: 0, outT: 0, durMin: 0, usageEmpty: true, usageRetry: USAGE_RETRY_N };
                writeIntegrateState(stT0);
              } catch (e) {}
              cwarn("[dsh-memory] 归档消耗读取失败：子代理会话日志在重试 " + USAGE_RETRY_N + " 次后仍无 usage（账本记 usageEmpty=true，别当成 0 消耗）");
            }
          }
          // v2.4.7.1: done 的 resolve 值给 runDreamPipeline 的 Promise.race([r.done, 25min]) 直接可读
          // ★ B3（2026-10-07 现场：备注「已归档 4 个」而 written=3）：结算串必须自带本轮**真实去向**
          //   （written/skip/dropped），否则调用方只能拿"派发数"当"已归档数"。
          const _wz = summarizeArchiveWitness(Array.from(LAST_ARCHIVE_WITNESS.entries()), LAST_ARCHIVE_A5_OK);
          const _cnt = "（落盘 " + _wz.written + "/" + flowSessions.length + " 个"
            + (_wz.declaredSkip ? "、声明跳过 " + _wz.declaredSkip : "") + (_wz.dropped ? "、机制丢弃 " + _wz.dropped : "") + "）";
          return (doneOk ? "已落盘+A5通过" : (!allOk ? "批失败未消号（留待下轮）" : (LAST_ARCHIVE_WROTE_AT >= startedAt ? "已落盘但A5未全覆盖" : "未落盘"))) + _cnt;
        } catch (e) {
          monitorEvent("archive", "settled mode=exception err=" + (e && e.message ? e.message : String(e)));
          cwarn("[dsh-memory] 漏网归档结算异常:", e && e.message ? e.message : String(e));
          return "结算异常";
        } finally {
          STALE_RUNNING = false;   // v2.4.7.1: 互斥随结算链复位（发起段返回后仍有子代理在途，期间禁止二次发起）
          STALE_ACTIVE_DONE = null;   // v2.6.6: 结算链结束 → 摘句柄（等待者此刻已被唤醒并已可读账本）
        }
      })();
      STALE_ACTIVE_DONE = settle;   // v2.6.6: 暴露结算链句柄（手动 /dream 撞车时等它结算完再补一轮归档）
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

    // v2.6.7：utf8Bytes 已提级到模块级（见文件头 CHAR_LIMIT 之前）——闭包内副本删除，防两处实现漂移

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
          // v2.6.8（P5.1-5）：按 CHAR_LIMIT 表查 key（hasOwnProperty 保原型键防护）——一处同时修正面板与本函数下游的口径
          const key = Object.prototype.hasOwnProperty.call(CHAR_LIMIT, rel) ? rel : "summary";
          // v2.6.7（W1）：阈值统一走 limitOf（同一真源）；新增 warnChars/clearChars/nearHard 供面板显示「近限」。
          //   ⚠ 本函数对会话层用「剥 dump 后」的 layerChars/layerBytes（v2.4.22 用户拍板口径）——**不可**改用
          //   sizeStateOf(raw)，否则会复活当时修掉的 dump 误报。
          const byteWarn = limitOf(key, SIZE_WARN);
          const charLimit = limitOf(key, CHAR_LIMIT);
          const warnChars = warnCharsOf(key);
          const clearChars = clearCharsOf(key);
          // 过期复核：解析文件头「最后更新」日期行（>180 天）
          let stale = false;
          try {
            const stampLine = (text.split("\n").slice(0, 8).find((l) => /最后更新|更新日期|[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(l)) || "");
            const dm = stampLine.match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
            if (dm) { const dt = new Date(dm[1], dm[2] - 1, dm[3]).getTime(); if (dt < cutoff && dt > 0) stale = true; }
          } catch (e0) {}
          collected.push({ rel, layer, bytes, chars: layerChars, byteWarn, charLimit, warnChars, clearChars, overSoft: layerBytes > byteWarn, overHard: layerChars > charLimit, nearHard: layerChars <= charLimit && layerChars >= warnChars, mtime: stt.mtimeMs, stale });
        } catch (e) {}
      };
      // 稳定层 + 工具层 + 项目层 + 知识层
      addFile("global.md", "稳定层"); addFile("index.md", "稳定层");
      // v2.7.0（拆 fixed）：面板原 addFile("fixed.md", "耐久层") 已删除（层不存在 → 不再出现在文档状态里）
      for (const tool of safeLs("tools")) addFile("tools/" + tool, "工具层");
      for (const proj of safeLs("projects")) addFile("projects/" + proj, "项目层");
      for (const kn of safeLs("knowledge")) addFile("knowledge/" + kn, "知识层");
      // 会话层：今日 + 最近 3 个「非空」日文件（按文件名日期倒序）
      // v2.5.6 修复「面板看起来只有两天的日文件」：旧口径按 mtime 取最近 3 份——30 天轮转把过期文件复制进
      //   sessions/archive/ 后清空原文件会刷新其 mtime，0 字节的已轮转文件（实证 sessions/2026-08-14.md）
      //   于是挤占名额，把 09-11/09-10 等真文件顶掉；合并维护重写历史文件同样会刷 mtime。
      //   现改为：排除空文件 + 按文件名日期排序（mtime 不再参与）+ 输出总量提示（防「只列几条=文件丢了」误判）。
      const layerNotes = {};
      try {
        const todayName = dateStr(new Date()) + ".md";
        const allDays = safeLs("sessions").filter((f) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/.test(f)).sort();
        const nonEmpty = allDays.filter((f) => { try { return fs.statSync(portable(MEMORY_ROOT + "/sessions/" + f)).size > 0; } catch (e) { return false; } });
        const picks = nonEmpty.filter((f) => f !== todayName).slice(-3).reverse();
        addFile("sessions/" + todayName, "会话层（今日）");
        for (const f of picks) addFile("sessions/" + f, "会话层");
        if (allDays.length) {
          const emptyN = allDays.length - nonEmpty.length;
          layerNotes["会话层"] = "sessions/ 共 " + allDays.length + " 个日文件（" + allDays[0].slice(0, 10) + " ~ " + allDays[allDays.length - 1].slice(0, 10) + "）"
            + "；本卡只列今日 + 最近 3 份" + (emptyN ? "，另有 " + emptyN + " 个已轮转为空（原文在 sessions/archive/）" : "");
        }
      } catch (e) {}
      // 按层归组
      const byLayer = {};
      for (const d of collected) { (byLayer[d.layer] = byLayer[d.layer] || []).push(d); }
      for (const layer of Object.keys(byLayer)) docSections.push({ layer, docs: byLayer[layer], note: layerNotes[layer] || "" });
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
        const st = sizeStateOf(key, raw);
        // v2.6.7（W1）：三态 —— 硬超（字符 > 硬预算，注入已按节截断）/ 近限（字符 ≥ 硬预算×0.9）/ 字节兜底。
        //   ⚠ⓐ `truncated` 字段名与语义**必须保持不变**：下游 L8288（超限摘要强制入 dream 候选）与 L8576
        //      （整合健康）依赖它；把 nearHard 混入 truncated 会导致**每轮强制 spawn 整合子代理**。
        //   ⚠ⓑ 旧版 OR 含 `chars > charLimit`，故「已超硬预算」本就是可达的；本改动补的是 **近限带**与
        //      ASCII 密集文件的字节不可达，不是新增「超限」这一态。
        if (!(st.overHard || st.nearHard || st.overSoft)) return null;
        return {
          label, key,
          bytes: st.bytes, byteWarn: st.byteWarn,
          chars: st.chars, charLimit: st.charLimit,
          warnChars: st.warnChars, clearChars: st.clearChars,
          near: st.nearHard,
          truncated: st.overHard,   // 语义锚点：仅「字符 > 硬预算」
        };
      };
      const globalRaw = await readText(MEMORY_ROOT + "/global.md");
      const indexRaw = await readText(MEMORY_ROOT + "/index.md");
      const g = await check("global.md", "global.md", globalRaw);
      if (g) issues.push(g);
      const i = await check("index.md", "index.md", indexRaw);
      if (i) issues.push(i);
      // v2.7.0（拆 fixed）：原「耐久层纳入 /dream 健康体检」三行（readText fixed.md → check → issues.push）已删除。
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
          // ═══ v2.6.8（P1/④）轮转副本完整性校验 ═══
          // 旧实现只校验"源已清空"（下一行的 back !== ""），**从不校验副本**——这正是 2026-08-31 原文变 867B 空壳
          //   （事故①）的机制缺口：复制若失败/半截，源照样被清空，库里就只剩坏副本。
          // 并发注意：arcFull 是固定名，归档子代理可能正在覆写它 → 取"复制前源 hash"与"复制后副本 hash"比对；
          //   ⚠ hash 必须在清空**之前**取（写在清空之后 → 全库恒判不一致 → sessions 永不轮转、静默堆积）。
          // 不一致先重试一次（覆盖并发瞬时态）；仍不一致则**不清空源**并留 monitor 事件（源在 → 下轮会重选，非永久卡死）。
          const shaOf = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
          let copyOk = false, copyErr = "";
          for (let attempt = 0; attempt < 2 && !copyOk; attempt++) {
            try {
              const srcHash = shaOf(srcFull);
              fs.copyFileSync(srcFull, arcFull);
              if (shaOf(arcFull) === srcHash) copyOk = true;
              else copyErr = "副本 sha 不一致";
            } catch (eA) { copyErr = (eA && eA.message ? String(eA.message) : "复制异常").slice(0, 40); }
          }
          if (!copyOk) {
            failed.push(name + "(" + copyErr + "，源未清空)");
            try { monitorEvent("archive", "rotate-copy-mismatch file=" + name); } catch (eM) {}
            cwarn("[dsh-memory] 轮转副本校验失败，已跳过清空: " + name + " - " + copyErr);
            continue;
          }
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
      // §9.12③（2026-09-19 **自捕 + 评审整改**）：字面量落点**定在 `knowledge/字面量.md`**，因此**不需要**在这里
      //   登记特例 —— `listMdNames("knowledge")` 会把它自动收进候选集。★ 我第一版落在**根目录** `literals.md`，
      //   并在文档/工具描述/任务书里写"记忆库里的 .md ⇒ memory_search 天然覆盖"，**那是错的**：候选集是
      //   **白名单式枚举**（knowledge/ tools/ projects/ sessions/ + 根目录 global/index）⇒ 根目录新增的 .md
      //   一律看不见（写了却搜不到＝等于白写）。提案人席独立复核也指出了同一点，并建议改落点（本条即采纳）。
      //   保留这句注释是为了**防止有人"顺手"把它挪回根目录**。见 `LITERALS_FILE` 定义处的三条理由。
      // v2.7.0（拆 fixed）：原 put("fixed.md", "耐久事实") 已删除——检索候选集不再含该文件
      // 底座 4：sessions/ 近 7 天——0 结果引导文案承诺"查会话/sessions"，此前候选集里根本没有（断链三）
      const sessCutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const name of await listMdNames("sessions")) {
        const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
        if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() >= sessCutoff) put("sessions/" + name, "会话摘要 " + name.slice(0, 10));
      }
      // 底座 5（v2.6.8 / 提案①）：sessions/archive/ 全量纳入候选集
      //   根因：轮转过去的旧摘要**从不在候选集**（本函数此前只扫 sessions/ 直下），而指针闭合闸（L8751）
      //   却叫模型去指 sessions/archive/… ⇒「指针指得到、检索够不着」。实测盲区 252,902 字符
      //   ＝ sessions 总量 373,727 的 67.7%（顶层失联 26 文件 127,135 + archive 10 文件 125,767）。
      //   纪律：只加"可搜"、**不动任何排序权重**；label 加「归档 」前缀（与顶层日档同名时靠 label 区分）；
      //   size > 200 才收（过滤 0 B 已轮转空档与纯说明页这类噪声）。
      try {
        for (const name of await listMdNames("sessions/archive")) {
          if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
          let szA = 0;
          try { szA = fs.statSync(portable(MEMORY_ROOT + "/sessions/archive/" + name)).size; } catch (eS) { continue; }
          if (szA <= 200) continue;
          put("sessions/archive/" + name, "归档 " + name.slice(0, 10));
        }
      } catch (eArc) {}
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

    // v2.8.6（2026-09-27）：记忆**时间衰减 + 重要度 + 时间窗**（B 档）。
    //   动因：检索此前是**纯词频**，三年前的条目与昨天的同权——学术侧实测「时间感知查询扩展 +6.8~11.3%」、
    //   多键索引 recall@k +9.4%（LongMemEval）；Generative Agents 的 `0.995^Δt(小时)` + LLM 重要度打分
    //   是主流三件套（另一支 MemoryBank 用 `R=e^(−t/S)`，复习增大 S 减缓衰减）。
    //   设计原则：**只做重排、不改打分量级**——衰减乘子落在 [DECAY_FLOOR, 1]，不制造「新条目碾压相关条目」。
    //   frontmatter 可选（缺省 = 中性 1.0，与旧行为等价）；解析失败一律中性，绝不因元数据坏而丢结果。
    const DECAY_PER_HOUR = 0.995;   // Generative Agents 同源：每小时保留 99.5%
    const DECAY_FLOOR = 0.70;       // 衰减下限——再旧的条目也不会被压到 0.7 以下（防「老但关键」被埋）
    const IMPORTANCE_MIN = 1, IMPORTANCE_MAX = 10;

    // 解析可选 YAML frontmatter（只认平铺 key: value；**不引 yaml 依赖**，坏格式返回空对象）
    function parseFrontmatter(text) {
      const out = {};
      if (!text || !text.startsWith("---")) return out;
      const end = text.indexOf("\n---", 3);
      if (end < 0) return out;
      for (const line of text.slice(3, end).split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
        if (!m) continue;
        out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return out;
    }

    // 衰减乘子：以 last_used（缺省 created，再缺省文件 mtime）为基准
    function decayFactor(fm, mtimeMs) {
      let baseMs = NaN;
      for (const k of ["last_used", "updated", "created"]) {
        if (fm[k]) { const t = Date.parse(fm[k]); if (!isNaN(t)) { baseMs = t; break; } }
      }
      if (isNaN(baseMs)) {
        if (!mtimeMs || !isFinite(mtimeMs)) return 1;   // 无任何时间信号 ⇒ 中性（旧行为）
        baseMs = mtimeMs;
      }
      const hours = Math.max(0, (Date.now() - baseMs) / 3600000);
      return Math.max(DECAY_FLOOR, Math.pow(DECAY_PER_HOUR, hours));
    }

    // 重要度乘子：importance 1~10 ⇒ 0.9~1.1（**温和**，避免元数据主导排序）
    function importanceFactor(fm) {
      const n = Number(fm.importance);
      if (!isFinite(n) || n < IMPORTANCE_MIN || n > IMPORTANCE_MAX) return 1;
      return 0.9 + (n - IMPORTANCE_MIN) / (IMPORTANCE_MAX - IMPORTANCE_MIN) * 0.2;
    }

    // 时间窗：query 含「最近/上次/刚才/近期/昨天/上次说」等 ⇒ 收集近 N 天条目的文件名集合供加权
    const RECENCY_QUERY_RE = /(最近|上次|近期|刚才|最新|昨天|前天|这几天|上次说)/;
    const RECENCY_WINDOW_DAYS = 30;
    function isRecencyQuery(q) { return RECENCY_QUERY_RE.test(String(q || "")); }
    function recentnessFactor(fm, mtimeMs, recencyQuery) {
      if (!recencyQuery) return 1;
      let baseMs = NaN;
      for (const k of ["last_used", "updated", "created"]) {
        if (fm[k]) { const t = Date.parse(fm[k]); if (!isNaN(t)) { baseMs = t; break; } }
      }
      if (isNaN(baseMs)) baseMs = mtimeMs;
      if (!baseMs || !isFinite(baseMs)) return 1;
      const days = (Date.now() - baseMs) / 86400000;
      if (days > RECENCY_WINDOW_DAYS) return 1;
      return 1 + 0.15 * (1 - days / RECENCY_WINDOW_DAYS);   // 近 30 天内线性加成，最多 +15%
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
              // v2.8.5：正则与 buildMemoryHintTable 同源收紧（name 组禁 ｜/→），否则新格式行（含 `何时:`）
              //   会被 m[1] 整段吃成搜索词 ⇒ 自检 P3 抽样失真。
              const m = seg.trim().match(/^(?:-\s*)?([^｜→]+?)\s*→\s*([^\s（）()|]+)$/);
              if (!m) continue;
              // 触发语段不参与对账（它是路由提示，不是关键词）
              const word = m[1].includes("何时:") ? m[1].slice(0, m[1].indexOf("何时:")).replace(/[（(]\s*$/, "").trim() : m[1].trim();
              if (word && !m[2].includes("/")) pairs.push({ word, base: m[2].replace(/\.md$/i, "").toLowerCase() });
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
              // v2.8.5：与主检索同源——scoreTarget 只接受 (t, text, tokens)，此前多传 2 个参数被静默忽略
              const r = scoreTarget(t, text, tokens);
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
        let removed = 0, chilled = 0;
        // ═══ v2.6.8（P1/④）最旧快照转冷档，不再直接删 ═══
        // 动机：BACKUP_KEEP=4 × 7 天 ≈ 只覆盖一个月，超期即无快照（事故③的暴露面）。
        //   cold/ 不匹配 ^\d{8}_\d{4}$ → 不计入保留份数、不会被二次清理。
        // 顺序纪律：复制 → 校验目标完整 → **才**删原档（"先删源后校验"正是本轮 P1 要修的同类缺陷）。
        const coldDir = BACKUP_ROOT + "/cold";
        for (const s of snaps.slice(0, Math.max(0, snaps.length - BACKUP_KEEP))) {
          try {
            fs.mkdirSync(coldDir, { recursive: true });
            const srcC = BACKUP_ROOT + "/" + s, dstC = coldDir + "/" + s;
            copyRec(srcC, dstC);
            if (!fs.existsSync(dstC + "/global.md")) throw new Error("冷档缺 global.md");
            fs.rmSync(srcC, { recursive: true, force: true });
            chilled++; removed++;
          } catch (eC) {
            cwarn("[dsh-memory] 冷档转移失败（原档保留）: " + s + " - " + (eC && eC.message ? eC.message : String(eC)));
          }
        }
        clog("[dsh-memory] 记忆库自动备份完成 → memory_backup/" + dir.split("/").pop() + "（" + copied + " 个文件；共 " + (snaps.length - removed) + " 份快照" + (removed ? "，清理最旧 " + removed + " 份（已转冷档 cold/）" : "") + "）");
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
              : (i.near
                ? "⚠️ 接近硬限，再增内容即触发按节截断（告警线 " + i.warnChars + "，剩 " + Math.max(0, i.charLimit - i.chars) + " 字符）"
                : "⚠️ 字节超兜底线（未截断，但建议整理）");
            const fusedNote = (i.key === "summary" && i.isToday && todayFused)
              ? "（当日：合并维护已熔断——" + String((MAINT_RETRY && MAINT_RETRY.lastReason) || "?").slice(0, 20) + "×" + ((MAINT_RETRY && MAINT_RETRY.attempts) || "?") + "，未自动收敛）"
              : "";
            return "- " + i.label + "：字节 " + i.bytes + "B（兜底线 " + i.byteWarn + "B）/ 字符 " + i.chars + "（告警线 " + i.warnChars + " · 硬预算 " + i.charLimit + "）→ " + status + fusedNote;
          });
          const manualSuggest = sizeIssues.some((i) => i.key === "summary" && !i.isToday)
            ? "非当日摘要：把可下沉细节提升到 knowledge/ 或 projects/ 对应文件（合并维护只自动覆盖当日文件）"
            : "global/index 精简：把可下沉的踩坑/配置/清单提升到 knowledge/，稳定层只留高频通用要点";
          const text =
            "【dsh-memory 超限整理提醒】以下记忆文件超限（阈值=软信号，预算=硬截断）：\n" +
            lines.join("\n") + "\n" +
            (todayFused ? "当日摘要：合并维护今日已熔断（" + String((MAINT_RETRY && MAINT_RETRY.lastReason) || "?").slice(0, 20) + "×" + ((MAINT_RETRY && MAINT_RETRY.attempts) || "?") + "），未自动收敛；可手动精简（写入走 memory_dream_patch），或等日切后自动恢复。\n" : "") +
            "处理建议：1. " + manualSuggest + "；\n2. 精简写入统一走交付工具 memory_dream_patch（replace 全文件/delete 删条目，插件校验+原子写+回读；注意 write/edit 直写会**绕过**插件校验——指针闭合闸/预算闸/回读核对都不生效，后果自负）；\n3. 目标 = 字符 < 告警线（global 2700 / index 1800 / 摘要 1350 = 硬预算×0.9）；只压到硬预算以内不算收敛（近限态仍常亮）。";
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
          "处理：仍有效 → 用 memory_dream_patch 更新文件头日期；已过时 → 用 memory_dream_patch 精简归档或 delete 删除（文件删除后索引自动失效，无需其他操作；注意 write/edit 直写会绕过插件校验，后果自负）。"
        );
      }

      // v1.3.0：漏网会话处理（久未交互且未落档的会话）——v1.4.0 按 staleAction 分派
      //  silent: 插件直接 spawn 子代理总结（后台，完成后控制台输出）
      //  remind / approval: 注入提醒（approval 文案带确认引导）
      try {
        // v1.6.0：installAt 界限 —— 插件启用前创建的会话不触发整合
        const staleSessions = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
          .filter((s) => shouldReArchive(s, reArchiveOpts()));   // v2.8.4（P13/P15）：单一谓词（含 incomplete 续跑 + 可选 counterVer 旁路）；旁路默认关
        if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }   // v2.4.3: 懒置基线顺带落盘
        if (staleSessions.length > 0) {
          if (PLUGIN_CFG.staleAction === "silent" && ZSTD_OK) {   // v2.0.9(M3): 无 zstd 能力禁止 silent 自动消号，落入 remind 分支
            // v1.12.8：单主子代理编排（无感）：插件提取消息流 → 一个主子代理自主判断/总结/落盘
            // v2.4.7.1（回归修复③）：此处 await 只到「提取+发起完成」（秒级），子代理结算在 settle 链后台跑，
            //   维护提醒注入不再被拖到子代理结束（实证旧路径一晚上把会话启动顶住 6 分 14 秒）。
            const r = await runStaleSilentTick(Date.now());
            if (r && r.ok) {
              clog("[dsh-memory] 漏网归档已发起：" + r.count + " 会话 / " + r.started + " 批（后台结算，完成后另出一条报告）" + (r.startFailed ? "，另有 " + r.startFailed + " 批发起失败留待下轮" : ""));
              if (r.overflow > 0) clog("[dsh-memory] 剩余 " + r.overflow + " 个漏网会话将在下次检查时处理");
            } else if (r) {
              // v2.8.4（可读信号）：不再静默 —— 没发起必须说清为什么（冷却中/候选未变/白轮退避/记忆链忙/无候选）
              clog("[dsh-memory] 自动归档未发起（" + (r.why || r.reason || "?") + "）");
            }   // 消号 v1.12.19.1 起在子代理完成回调内执行（处置完成才消号）
            // 未发起成功不标记 → 下次再处理
          } else {
            // ⚠️ v2.8.4（§9.6 修正，**上游遗留缺陷**）：原实现把 `} else {` 写进了上一行的**行注释**里
            //   ⇒ 这个 else 从未存在，整块提醒代码落在 `if (silent)` 的**内部分支**里。后果（实测两种档位都反）：
            //     ① silent 档：除自动归档外**还会多注入一段漏网提醒**（重复、白占 token）
            //     ② remind/approval 档：**永不注入**（死代码）—— 与该 if 上方注释声明的分派完全相反
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
                "（原始日志：~/.dsh/sessions/<工作目录>/<会话id>/session.jsonl.zstd 或 session.v3.jsonl.zstd；同实例内只提示一次）"
              );
            }
          }
          // v1.4.0：更新只读统计（设置界面显示"未整合记忆会话数"）
          try {
            // [2026-09-23] scope 通道退役：staleCount 改走 LIVE_STATS，随 stats.json 下发
            {
              // v2.6.5: 面板「未整合记忆会话数」改用与手动 /dream 同口径（30 分钟活跃下限）——旧口径按
              //   settings 天数，v3 隐形期该值显示 0，与真实积压 63 个严重不符（误导）。仅影响显示值，
              //   自动归档与自动提醒仍按 PLUGIN_CFG.staleSessionDays（不扩大自动动作范围）。
              const total = findStaleSessions(MANUAL_STALE_MIN_IDLE_MS / 86400000, getEnabledAt()).filter((s) => !sessionMentionedInMemory(s.id) && archivePendingEntry(s)).length;   // v2.4.3 增量重档：新帧未档的计入 staleCount
              LIVE_STATS.staleCount = total;
            }
          } catch (e) { /* 统计更新失败不影响主流程 */ }
        }
      } catch (e) {
        cwarn("[dsh-memory] 漏网会话检测失败:", e && e.message ? e.message : String(e));
      }

      // v2.6.5（自检·防再次静默失效）：会话日志文件名漂移 → 漏网检测/归档提取对该类会话整链隐形，
      //   且不报错。DSH 曾于 2026-09-10 改名 session.jsonl.zstd → session.v3.jsonl.zstd，造成 6 天
      //   静默失效（积压 63 个未落档会话）。此处把「未识别日志名」主动反馈到对话，按文件名去重。
      try {
        if (!fmtNotifiedLoaded) {
          fmtNotifiedLoaded = true;
          try { const s0 = readIntegrateState() || {}; (s0.fmtNotified || []).forEach((n) => FMT_NOTIFIED.add(n)); } catch (e2) { /* 忽略 */ }
        }
        // 确保采集跑过一遍（findStaleSessions 内 TTL 缓存命中则零额外成本）
        try { findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt()); } catch (e2) { /* 忽略 */ }
        const freshFmt = Array.from(UNKNOWN_LOG_NAMES.entries()).filter((en) => !FMT_NOTIFIED.has(en[0]));
        if (freshFmt.length > 0) {
          const fmtLines = freshFmt.map((en) => "- " + en[0] + "（" + en[1].count + " 个会话目录，如 " + String(en[1].sample).split(/[\\/]/).slice(-1)[0] + "）");
          parts.push(
            "【dsh-memory 自检·会话日志格式漂移】检测到未识别的会话日志文件名（既非 " + SESSION_LOG_CANDIDATES.join(" 也非 ") + "）：\n" +
            fmtLines.join("\n") + "\n" +
            "影响：这些会话不会被漏网检测/归档提取看到（DSH 曾把 session.jsonl.zstd 改名 session.v3.jsonl.zstd，导致 6 天静默失效、积压 63 个未落档会话，且无任何报错）。\n" +
            "处理：把新文件名加入 index.js 顶部 SESSION_LOG_CANDIDATES（数组首位=最高优先级）后重新部署即可恢复。（同类提示按文件名只出现一次）"
          );
          freshFmt.forEach((en) => FMT_NOTIFIED.add(en[0]));
          clog("[dsh-memory] 自检：发现未识别会话日志名 " + freshFmt.map((en) => en[0]).join(", ") + "（已提示一次）");
        }
      } catch (e) { /* 自检失败不影响主流程 */ }

      if (parts.length === 0) return;
      agent.inject(makeMessage(
        "<system-reminder>\n以下为 dsh-memory 维护提醒（写入 ~/.dsh 需要一次审批，频率很低）：\n" + parts.join("\n\n") + "\n</system-reminder>"
      ));
      clog("[dsh-memory] 已注入维护提醒（" + parts.length + " 项）[会话: " + SESSION_LABEL + "]");
      saveStaleNotified();
    }
    // v2.8.4（§9.6）：把该函数暴露给门 —— 否则"remind 档到底会不会注入漏网提醒"只能靠读源码，
    //   而这次的缺陷恰恰是**读源码也容易看漏**（`} else {` 藏在行注释里）。行为断言才是真护栏。
    __maintenanceInjectReminder = injectMaintenanceReminder;

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

    // v2.6.3（DSH 0.1.6 适配，2026-09-15）：会话开始事件由 agent/session-start 改名为**异步串行**的 agent/created。
    //   - 0.1.6-alpha.1 安装树全量搜索已无 "agent/session-start" 字符串（只有 agent/created）→ 挂旧名回调永不触发，
    //     表现为「记忆自动注入整链静默失效」（稳定层/项目记忆/压缩点/维护提醒/初始化引导全部不注入），且无任何报错。
    //   - payload 仍为 { agent, source, signal }，source ∈ startup|resume|clear|compact；本回调只用 agent，语义不变：
    //     非顶层会话继续由 isTopLevelSession 过滤；恢复会话仍走 injectSnapshot 三档（文件未变=静默，不破坏前缀缓存）。
    //   - agent/created 是**串行 await** 的初始化事件（创建事务会等监听器返回）：本回调同步返回、异步链 fire-and-forget
    //     且内部全 try/catch（见下方 IIFE），绝不向创建事务抛错（监听器抛错会导致 agent 创建回滚）。
    ctx.on("agent/created", (payload) => {
      const agent = payload.agent;
      if (!agent || typeof agent.inject !== "function") {
        cerr("[dsh-memory] agent/created: agent.inject 不可用");
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
          // v2.6.7（W1）：改**字符口径三态**（接近硬限 / 已超硬预算 / 字节兜底）——旧版纯字节条件对 ASCII 密集
          //   文件整条不可达（index 实测 1.857 B/字符，需 >2.304 才可能先响）；文案亦修正旧模板「超限 3645B（阈值 4608B）」的自相矛盾。
          const sizeWarnMsg = (rel, st) => {
            const state = st.overHard
              ? "已超硬预算（注入已被截断）"
              : (st.nearHard ? "接近硬限（剩 " + Math.max(0, st.charLimit - st.chars) + " 字符）" : "字节超兜底线");
            return rel + " " + state + "：字符 " + st.chars + "/" + st.charLimit + "（告警线 " + st.warnChars + "）· 字节 " +
              st.bytes + "B（兜底线 " + st.byteWarn + "B），" + (rel === "global.md" ? "建议整理提升" : "建议精简") +
              "[会话: " + SESSION_LABEL + "]";
          };
          if (globalRaw) {
            const stG = sizeStateOf("global.md", globalRaw);
            if (stG.overHard || stG.nearHard || stG.overSoft) sizeWarnThrottled("global.md", sizeWarnMsg("global.md", stG));
          }
          if (indexRaw) {
            const stI = sizeStateOf("index.md", indexRaw);
            if (stI.overHard || stI.nearHard || stI.overSoft) sizeWarnThrottled("index.md", sizeWarnMsg("index.md", stI));
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
          // v2.7.0（拆 fixed）：原「耐久层 = 独立注入块（【固定要点】，记忆索引之后）」已删除。
          //   fixed.md 层不再存在 → 稳定层注入只剩 global.md（画像）与 index.md（索引）两块。
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
          // v2.7.0（拆 fixed）：原 `hF`（耐久层 hash，供注入块 + mF 判定 + 快照共用）已随该层删除。
          //   ⚠ 历史教训保留：v2.6.8 曾漏声明该 const → `注入异常: hF is not defined` 被注入链 catch 吞掉，
          //   结构门 35/0 全绿也没抓到，只有行为门复现——凡动这一段务必跑 _test-fmt-selftest.mjs。
          // v2.4.17（项目记忆 P1-3）：项目块 hash（命中项目才计算；未命中 = ""，不参与判定）
          let hP = ""; let hPname = "";
          // v2.6.2（工作空间自动建档，用户 2026-09-14 拍板）：放在 injectMode 分支**之前**——三档（full/notice/silent/global）
          //   速率全都要建档（v2.6.2 首部署实证：续会话 injectMode=notice 时 old 位置整分支跳过致建档不触发）；
          //   且先建档再算 hP → 首建会话 hP 即非空，快照 p 直接存骨架 hash，下轮不发假的「项目有更新」通知。
          //   （骨架文档 + _index.json 登记 cwd + 种标记），随后本轮摘要分格/项目切片注入即按新项目生效。
          if (TOPSESSION) {
            try {
              const _cwdB = (agent.session && ((agent.session.header && agent.session.header.cwd) || agent.session.cwd)) || "";
              const boot = ensureProjectForCwd(_cwdB);
              if (boot && boot.acted) {
                const _bits = [];
                if (boot.created) _bits.push("新建 projects/" + boot.file);
                if (boot.registered) _bits.push("登记工作目录到项目索引");
                if (boot.seeded) _bits.push("种 ~dsh/project.json 标记");
                agent.inject(makeMessage("<system-reminder>\n【dsh-memory】本工作空间此前未命中项目记忆，已自动建档：" + _bits.join("；") + "。本会话起项目记忆照常注入；若目录名不适合作项目名，重命名 projects/" + boot.file + " 后同步 _index.json（file/workdirs）即可。\n</system-reminder>"));
                injectedParts.push("项目建档(" + boot.file + ")");
              }
            } catch (eBoot) { cwarn("[dsh-memory] 工作空间自动建档失败:", eBoot && eBoot.message ? eBoot.message : String(eBoot)); }
          }
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
              // v2.6.7（W1）：摘要只报**字节**（被测量沿用「全文剥 dump」）——不在此打印字符，避免与
              //   checkSizeOverflow 的「剥 intent 面」字符数形成「同一文件两个字符数」的新漂移；
              //   近限/超限的字符口径判定改由 checkSizeOverflow 单一出口负责；计数口径本版不动（跨子系统，见 CHANGELOG）。
              const stSum = sizeStateOf("summary", latest.text);
              if (stSum.overSoft || stSum.overHard || stSum.nearHard) {
                sizeWarnThrottled(latest.file, "摘要 " + latest.file + " 超字节兜底线 " + stSum.bytes + "B（兜底线 " +
                  stSum.byteWarn + "B）" + (stSum.nearHard ? "，且已进入近限带" : "") + "，建议精简[会话: " + SESSION_LABEL + "]");
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
                    const psliced = sectionAwareSlice(ptxt, 2000, "projects/" + pr.file, { priority: ["Rules", "Architecture decisions", "Gotchas", "当前状态与下一步", "Discovered durable knowledge"] });   // v2.6.8（P3）：耐久节进 priority，**追加末位**（红队实测：插 Rules 之后会把长沙「当前状态与下一步」612→207 字、发改委 Gotchas 557→73 字；末位为纯增益零回退。切片仍 2000 不上调）
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
          if (WB.brk) { WB.brk.suspectKeys = new Set(); WB.brk.denyN = 0; WB.brk.fullStop = false; WB.brk.seq = 0; WB.brk.seqKey = ""; WB.brk.lastRFp = ""; }
        } catch (e) {}
        // v1.12.10：检查/提醒解耦 —— 每条输入都跑关键词检查（免费）；提醒受两道闸：
        //   ① 冷却：距上次提醒至少隔 1 条用户输入（用户定：第 1 条提醒了，最早第 3 条再提醒）
        //   ② 领域去重：同会话同记忆文件只提醒 1 次；冷却期内的新领域保留不标已见，冷却后补提醒
        const seq = (MEMORY_HINT_THROTTLE.get(sid) || 0) + 1;
        MEMORY_HINT_THROTTLE.set(sid, seq);
        const lastSeq = MEMORY_HINT_LAST_SEQ.get(sid) || -999;
        const inCooldown = (seq - lastSeq) < 2;
        // ═══ v2.6.7（W2）：近限「按变化报」——补 W1 治不了的洞 ═══
        // 为什么必须补：注入面超限提醒受 maintenanceInjected 闸（见 L6850）→ **每插件实例仅 1 次、且只在首个
        //   顶层会话**；而实证事故是**会话中途**把 index.md 写到 2102 字符，那时闸早已消费完 → 只把告警线降到
        //   1800 依然零信号（这正是 R1 方案的原错）。故此处改按「**变化**」报：
        //   · 与上次水位比**长了 ≥30 字符**且已 ≥ 告警线 → 报一次（含"剩多少字符"）
        //   · **不增长则静默**（不按状态常亮，避免 index 常年 1900+ 时变成墙上噪音）
        //   · 已超硬限（注入正被按节截断）→ 首次越限即报，之后仅在水位继续增长时报
        //   · 降到清除线下 → 复位水位（下次再长可再报）
        //   水位持久化在 .integrate.json 的 nearHard 字段（跨重启/跨会话累计），内存另有 10 分钟/文件冷却。
        let nearHardNote = "";
        try {
          const NH_GROWTH_MIN = 30;
          const st0 = readIntegrateState() || {};
          const ledger = (st0.nearHard && typeof st0.nearHard === "object") ? st0.nearHard : {};
          const told = [];
          let dirty = false;
          // v2.6.9（P0·v2.6.8 缺陷修复，历史保留）：本处曾漏收敛（当年 `fixed.md` 收在两个内联数组里 → 不进水位数账本）。
          //   v2.7.0 起 ROOT_FILES 只剩 global/index，统一由该常量驱动；顺序变化只影响提醒文案顺序，语义无关。
          for (const rel of ROOT_FILES) {
            let st = null;
            try { st = sizeStateOf(rel, fs.readFileSync(portable(MEMORY_ROOT + "/" + rel), "utf8")); } catch (eR) { continue; }
            const prev = (ledger[rel] && Number.isFinite(Number(ledger[rel].chars)))
              ? { chars: Number(ledger[rel].chars), over: !!ledger[rel].over } : null;
            if (st.chars < st.clearChars) {                 // 已精简到清除线下 → 复位，允许下次再长时再报
              if (prev) { delete ledger[rel]; dirty = true; }
              continue;
            }
            const grew = !!prev && (st.chars - prev.chars) >= NH_GROWTH_MIN;
            const firstOver = st.overHard && !(prev && prev.over);
            if ((firstOver || grew) && Date.now() - (NEAR_HARD_TOLD.get(rel) || 0) >= 600000) {
              NEAR_HARD_TOLD.set(rel, Date.now());
              told.push(st.overHard
                ? "- " + rel + " **已超硬限**：" + st.chars + "/" + st.charLimit + " 字符，注入**已被按节截断**（每节均分切掉一部分）→ 建议立刻精简到 " + st.warnChars + " 字符以下"
                : "- " + rel + " 接近硬限：" + st.chars + "/" + st.charLimit + "（告警线 " + st.warnChars + "，仅剩 " + (st.charLimit - st.chars) + " 字符）——较上次水位增加 " + (st.chars - (prev ? prev.chars : st.chars)) + " 字符");
            }
            const rec = { chars: st.chars, over: st.overHard };
            if (!prev || prev.chars !== rec.chars || prev.over !== rec.over) { ledger[rel] = rec; dirty = true; }
          }
          if (dirty) { st0.nearHard = ledger; st0.updatedAt = Date.now(); writeIntegrateState(st0); }
          if (told.length) {
            nearHardNote = "<system-reminder>\n【dsh-memory 稳定层容量】\n" + told.join("\n") +
              "\n（global/index 是每会话固定注入开销：超硬限不是丢尾行，而是每节被均分截断。精简流程：memory_size_preview 量准 → memory_dream_patch 落盘。）\n</system-reminder>";
          }
        } catch (eNH) { /* 容量检查失败不影响本轮提醒逻辑 */ }
        if (nearHardNote && decision.kind === "enter") {
          return { ...decision, messages: [...(decision.messages || []), makeMessage(nearHardNote)] };
        }
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
        // v2.8.5：条目携「何时读」触发语时直接展示（模型据此判断该不该真去读，替代盲指针）。
        const memLines = memHits.map(h => "- 记忆: memory_search " + JSON.stringify(h.name) + "（" + h.file + "，踩坑/现成脚本/约定" + (h.parts && h.parts.length ? "；触发词: " + h.parts.join("、") : "") + (h.trigger ? "；何时读: " + h.trigger : "") + "）").join("\n");
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
        if (isPluginSubagent(sid) && !(pending && String(pending.sig).startsWith("PL:"))) {
          // v3.2.0（Wave 0）：被 kind 闸拦下的提醒也要留痕——否则"放行但未注入"与"被 batch/cooldown 拦"永久分不开
          //   （红队 03 阶段2 明列的残余类别）。cls 取 sig 前缀（D:loop / E:loop / W:noop / PL:…）。
          if (pending) recordGate(String(pending.sig || "?").split(":")[0] || "?", "kind", sid);
          return decision;
        }
        if (!pending) return decision;
        if (decision.kind !== "enter") return decision;    // reject 决策无 messages，透传不注入
        dequeueRegressionReminder(sid);
        // v3.2.0（Wave 0）：消费留痕——ok 只代表"闸门放行"，consumed 才代表"真注入当轮请求"。
        recordGate(String(pending.sig || "?").split(":")[0] || "?", "consumed", sid);
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
        const toolName = exec.name || exec.tool || "other";   // [2026-09-23] ToolExecution 无 tool 字段（宿主 dsh-tools/types 实证）→ 原表达式恒落 "other"，key 退化为纯 args 指纹
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
          // v3.2.0（Wave 0/1）：返回值扩为 {d,e,rep,neg,win,eN}（闸门埋点记**真值**，不重算）；第 6 参 exec.callId
          //   用于折叠「一次 run_code = 内层 ptc + 外壳」的双计（宿主约定：subCallId = `${rootCallId}:ptc:${n}`）。
          const hit = spiralObserve(toolName, exec.arguments, result, !!result.isError, spSid, exec && exec.callId);
          // W 看门狗（v2.4.30）：无用户介入计数递增（pre-step step1 复位）
          const Bw = spiralBucket(spSid);
          Bw.stepsSinceUser = (Bw.stepsSinceUser || 0) + 1;
          const wET = effectiveSpiralThresh();
          // v2.0.6: D 类提醒智能闸门——周期首次命中 × 开关 × 指数退避冷却（跟进复位/2h归零）× 批量进展豁免
          // v3.2.0（Wave 0）：改为「无论放行与否都留一条 gateEvents」——命中 ⇒ 必产出 ok 或 batch/cooldown/off 之一，
          //   这是 V4 守恒式（spiralEvents(D) == hints.D 增量 + Σ gateEvents(D).n）成立的前提。
          if (hit && hit.d) {
            const gx = { rep: hit.rep, neg: hit.neg, winLen: hit.win };
            if (!PLUGIN_CFG.spiralRemind) {
              recordGate("D", "off", spSid, gx);
            } else {
              const nowMs = Date.now();
              const stR = SPIRAL_REMIND_AT.get(spSid) || { ts: 0, streak: 0 };
              const B2 = spiralBucket(spSid);
              const uniq = new Set(B2.win.map((w) => w.resKey)).size;
              // v3.2.0（Wave 2）：**归一化指纹去重数**一并落盘——候选 A/B 的效果判定依赖它（原文 uniq 会被
              //   时间戳/随机数等虚高；18:49:48 那条真实埋点 uniq=5 即可能因此虚高）。
              const uniqFp = new Set(B2.win.map((w) => w.resKeyFp || "")).size;
              const okN = B2.win.filter((w) => !w.neg).length;
              // 批量样态判据（旧注释名"批量进展豁免"）：窗内结果多样且成功过半 → 疑似批量推进而非空转
              const batchLike = B2.win.length > 0 && uniq >= Math.ceil(B2.win.length / 2) && okN * 2 >= B2.win.length;
              // v3.2.0（Wave 2 候选 C）：决策抽为纯函数 decideDGate —— **冷却先判**；批量样态改「降级投递 + 冷却加倍」。
              const dec = decideDGate(batchLike, stR, wET.cooldownMin * 60000, nowMs, PLUGIN_CFG.batchSoftDeliver);
              recordGate("D", dec.reason, spSid, Object.assign({ uniq: uniq, uniqFp: uniqFp, okN: okN, mode: dec.mode, streak: dec.gate.streak, cdMs: dec.gate.cdMs }, gx));
              if (dec.mode !== "blocked") {
                SPIRAL_REMIND_AT.set(spSid, { ts: nowMs, streak: dec.streakNext });
                monitorHintD();
                // v2.4.27（子代理提醒放开）：D 类改 pre-step messages 直入不留痕（同 B/C/A 机制——不进 inbox/会话历史、
                //   不破坏前缀缓存、无 ghost 轮），并从顶层闸放开到普通子代理（normal）——实证 04ee9d05 普通任务子代理
                //   打转 47 分钟无止损；插件子代理（plugin）仍只计 monitor 不注入（隔离，D 会误报其设计内合法重试）。
                const kind2 = hintKindOf(exec.agent, spSid);
                if (kind2 !== 'plugin') {
                  // v3.2.0（Wave 2 候选 C）：批量样态走**降级文案**——明说"可能只是批量推进、可忽略"，降低打扰；
                  //   正常样态沿用原文案。文案分流只改文字，不改通道（同 REGRESSION_QUEUE + 不留痕注入）。
                  const hintD = dec.mode === "soft"
                    ? "<system-reminder>\n【dsh-memory 提示·批量推进复核】检测到同类调用反复，但窗内产出多样、成功过半——更像批量推进而非原地打转。若确在批量处理，可忽略本条；若其实在空转，建议暂停并 memory_search 当前任务关键词。\n</system-reminder>"
                    : "<system-reminder>\n【dsh-memory 提示·LLM循环试错】检测到同类调用反复且负面结果占比高——大概率方向不对。建议暂停硬试：memory_search 搜当前任务关键词 + 查技能目录有无对应 skill，或换个思路/向用户确认。\n</system-reminder>";
                  enqueueRegressionReminder(spSid, 'D:loop', hintD);
                } else {
                  recordGate("D", "kind", spSid);   // v3.2.0：插件子代理按设计不注入 ⇒ 单独记一类，勿与被拦混淆
                }
              }
            }
          } else if (hit && hit.e) {
            // v2.4.30（E 类）：成功同质循环——无 batchLike 豁免（E 簇内同质判定天然是反向批量防线，见设计文档 §2.2）
            // v3.2.0（Wave 1）：**独立冷却桶**（旧实现与 D 共用 SPIRAL_REMIND_AT ⇒ 互相吃掉冷却窗）；并补闸门埋点。
            const gx = { rep: hit.rep, neg: hit.neg, winLen: hit.win, eN: hit.eN };
            if (!PLUGIN_CFG.spiralRemind) {
              recordGate("E", "off", spSid, gx);
            } else {
              const nowMs = Date.now();
              const stR = SPIRAL_REMIND_E_AT.get(spSid) || { ts: 0, streak: 0 };
              const gate = backoffAllowed(stR, wET.cooldownMin * 60000, nowMs, false);
              recordGate("E", gate.allowed ? "ok" : gate.reason, spSid, Object.assign({ streak: gate.streak, cdMs: gate.cdMs }, gx));
              if (gate.allowed) {
                SPIRAL_REMIND_E_AT.set(spSid, { ts: nowMs, streak: gate.streak + 1 });
                monitorHintE();
                const kind2 = hintKindOf(exec.agent, spSid);
                if (kind2 !== 'plugin') {
                  // v3.2.0 修 bug：N 必须是**簇长**（clusterN），旧实现取窗长 ⇒ 文案数字偏大（09-29 12:36 那次写 8、实为 4）。
                  const eN = hit.eN || 0;
                  const hintE = "<system-reminder>\n【dsh-memory 提示·成功同质循环】同一命令/调用已成功重复 " + eN + " 次、输出几乎没变——成功重复 ≠ 有进展。若任务已完成或卡在重复执行，建议暂停：确认产物是否到位，或换个思路/向用户核对。\n</system-reminder>";
                  enqueueRegressionReminder(spSid, 'E:loop', hintE);
                } else {
                  recordGate("E", "kind", spSid);   // v3.2.0：插件子代理不注入 ⇒ 单独记类
                }
              }
            }
          }
          // v2.4.30（W 类看门狗）：无用户介入长空转——不依赖同质/重复，只看用户回合后步数+墙钟。
          // 触发优先级最低（D/E 命中当轮不叠加）；plugin 子代理隔离（其长任务是设计内行为，另有 guard 看护）。
          if (!(hit && hit.d) && !(hit && hit.e)) {
            const nowMs = Date.now();
            const lastUser = Bw.lastUserAt || 0;
            const sinceUserSteps = Bw.stepsSinceUser || 0;
            const sinceUserMs = lastUser > 0 ? nowMs - lastUser : 0;
            // v3.2.0（Wave 0）：先判「步数+墙钟」是否达标，再分三态留痕（ok / cooldown / off）。
            //   只在达标时才记 ⇒ 不会每步都写（W 的闸门每步都评估，逐条落盘会把 gateEvents 顶穿）。
            const wQualified = sinceUserSteps >= wET.watchSteps && sinceUserMs >= wET.watchSecs * 1000;
            const wExtra = { steps: sinceUserSteps, wallSecs: Math.round(sinceUserMs / 1000) };
            if (wQualified && !PLUGIN_CFG.spiralRemind) {
              recordGate("W", "off", spSid, wExtra);
            } else if (PLUGIN_CFG.spiralRemind) {
              const stW = WATCH_REMIND_AT.get(spSid) || { ts: 0 };
              const coolMs = wET.watchCooldownMin * 60000;
              if (wQualified && (nowMs - (stW.ts || 0)) >= coolMs) {
                WATCH_REMIND_AT.set(spSid, { ts: nowMs });
                monitorHintW();   // 计数+开窗（plugin 与非 plugin 都计，语义同 D 的 monitorHintD 先行）
                recordGate("W", "ok", spSid, wExtra);
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
                } else {
                  recordGate("W", "kind", spSid);   // v3.2.0：插件子代理不注入 ⇒ 单独记类
                }
              } else if (wQualified) {
                recordGate("W", "cooldown", spSid, Object.assign({ cdMs: coolMs }, wExtra));
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

// ═══ v2.7.0：memory_dream_patch **调用方闸**（反转 v2.6.9 的 fixed 白名单，不是删除）═══
//   ①历史：v2.6.9（P3）原闸＝"主代理只允许写 fixed.md"（名单即 fixed.md）。fixed 层拆除后，主代理对该工具
//     **已无任何正当用途**（它的记忆写入路径是 edit/write，AGENTS.md §2 明写），故把判据**反转**为"主代理一律拒"。
//     ⚠ 我第一版拆除时把它整条删了——那是**判断错误**：名单拆空后闸的行为＝"主代理一律拒绝"，是**有意义的行为**
//     而非死代码；删掉等于退回"描述即权限"，而那正是 v2.6.9 加这道闸要解决的问题（其注释原文）。
//   ②动机不变：全文件无调用方权限检查；描述层约束已被证明不生效。
//   ③为什么不能开给主代理：本工具 execute 内有 `if (r.ok && r.wrote > 0) LAST_DREAM_WROTE_AT = Date.now();`
//     —— 该时间戳参与 dream settle 的 `doneOk` 判定；主代理随手写入会**伪造"本轮已落盘"**，`dreamed` 账本同理。
//   ④必须独立注册：D2 熔断处理器首行 `brkLevel < 2` 早退会短路，塞进去=静默失效（v2.6.8 工程席必改②）。
//   ⑤签名 (exec, next)：首参**就是** exec（`ToolExecution{name, arguments, agent, signal}`）；写成 `{agent, exec}` 会双 undefined。
ctx.on("tools/pre-execute", async (exec, next) => {
  try {
    const toolName = String((exec && exec.name) || "");
    if (toolName !== "memory_dream_patch") return next();
    const ag = exec && exec.agent;
    const sid = (ag && ag.session && ag.session.id) || "?";
    if (typeof hintKindOf === "function" && hintKindOf(ag, sid) === "plugin") return next();   // dream / 归档子代理放行
    try { if (typeof monitorEvent === "function") monitorEvent("memory", "main-agent-dream-patch-denied"); } catch (eM) {}
    return { kind: "deny", reason: "memory_dream_patch 仅供 dream 整合子代理与归档通道使用；主代理请用记忆库既有的编辑方式（edit/write）或走 /dream 流程。" };
  } catch (e) { return next(); }
});

// ═══ v2.7.0（拆 fixed）：另一条 fixed 专用直写闸（v2.6.8 P5.1-14，判据 `/(^|\/)fixed\.md$/i`）确实随层删除 ═══
//   它是**按文件路径**判据，层不存在即永不命中 → 这条才是真正的死代码；与上面的调用方闸不同，勿混为一谈。
//   ⚠ 保留下面 D2/D3 熔断处理器（与本层无关）。

// v2.6.0（D 级打转熔断）：D2 拒调 —— tools/pre-execute 拦截重复 suspect 调用，直接 deny（短路 veto）
// ⚠ v2.6.9 实测修正：本钩子签名是 **(exec, next)** —— 首参**就是** exec（`ToolExecution{name, arguments, agent, signal}`，
//   见 `dsh-tools/lib/types/index.d.ts` L39/L198-224）；`{agent, exec}` 是 `agent/pre-step` 的形状，套到本钩子上会让
//   两个变量都 undefined → 处理器**永远静默放行**。⇒ **v2.6.0 起 D2 一直是装饰品**（同一 bug 也吃了 v2.6.8 的直写闸）。
ctx.on("tools/pre-execute", async (exec, next) => {
  try {
    if (!PLUGIN_CFG.spiralBreak || PLUGIN_CFG.brkLevel < 2) return next();
    const ag2 = exec && exec.agent;
    const spSid = (ag2 && ag2.session && ag2.session.id) || "?";
    // 终检③：plugin 子代理先放行，绝不执法
    if (hintKindOf(ag2, spSid) === "plugin") return next();
    const brk = breakState(spSid);
    if (!brk || !brk.suspectKeys) return next();
    // 计算当前调用的指纹键
    let aTxt = "";
    try { aTxt = String(typeof exec.arguments === "string" ? exec.arguments : JSON.stringify(exec.arguments) || ""); } catch (e) {}
    aTxt = aTxt.replace(/\s+/g, " ").slice(0, 600);
    const toolName = exec.name || exec.tool || "other";   // [2026-09-23] 与 armBreakSuspect 侧**成对**修正（ToolExecution 无 tool 字段）——只改一侧会造成真口径不一致，反而让熔断彻底失效
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
    brk.seq = 0;
    brk.seqKey = "";
    brk.lastRFp = "";
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
          description: "提交漏网会话记忆归档检查点（仅 dsh-memory 归档子代理使用）：参数 { blocks: [ { file, sessionId, title, points[], literals[], skip?, reason? } ] }。file=记忆库相对路径（sessions/|projects/ 前缀）；sessionId=短 id 清单中的 id 逐字取用；有价值会话填 title+points（3-6 条要点，精确字面量逐字保留）；**literals[]=精确字面量单独一条通道**（GUID/URL/路径/命令/文号/报错串，逐条原样，去重后进 `knowledge/字面量.md`，不进注入层、可被 memory_search 检索）；无价值会话填 skip=true+reason（**要求**：reason 必须是**实质理由 ≥8 字**——空话/空白会被整批拒写。★ 注意：插件**不再**按理由措辞决定放行，也不会因为「该会话没有抽取单元」而拒你；它会记录这次跳过有没有可恢复的副本。**有内容可写就请写 points**，跳过是最后手段）。插件现场校验完整性与落盘：缺声明会话、越界路径、缺 points、理由不足 8 字会返回错误清单，请修正后再次调用（可多次调用累计覆盖全部会话）。",
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
                    literals: { type: "array", items: { type: "string" }, description: "§9.12③ 精确字面量（GUID/URL/路径/命令/文号/报错串/数值）逐条原样；去重后进记忆库 `knowledge/字面量.md`（非注入层、memory_search 可检索）" },
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
          async execute(args, exec) {
            let blocks = null;
            try {
              if (Array.isArray(args)) blocks = args;
              else if (args && typeof args === "object" && Array.isArray(args.blocks)) blocks = args.blocks;
              else if (args && typeof args === "object") { const v = Object.values(args).find((x) => Array.isArray(x)); if (v) blocks = v; }
            } catch (e) {}
            if (!Array.isArray(blocks)) return JSON.stringify({ ok: false, mode: "bad-schema", wrote: 0, errors: ["参数必须是 { blocks: [...] } 数组"] });
            // ★ 2026-09-25：按**发起该批的子代理**取本批短 id 清单（A5 只校验本批，见 applyArchiveBlocks 注释）
            return JSON.stringify(applyArchiveBlocks(blocks, archiveBatchIdsFor(exec)));
          }
        });
        clog("[dsh-memory] memory_archive_checkpoint 交付工具已注册（漏网归档专用）");
      } catch (e) { cwarn("[dsh-memory] memory_archive_checkpoint 注册失败:", e && e.message ? e.message : String(e)); }
    }
    // ═══════════ v2.8.4（P26）：`session_search` —— 会话**原文**检索（用户诉求的落地点）═══════════
    // 用户原话：「其实我要的功能需求很简单，就是有些内容在记忆中可能不准确或者没计入，那么就可以通过
    //   这个功能直接就检索到来源之类的」；并给了真实失败案例：「要找知识库的在线地址，记忆中就没有，
    //   还是 llm 在其他地方找到的」。
    // 分工（本仓的最终形状）：
    //   · `memory_search`  = 查**记忆库**（已沉淀的结论）
    //   · `session_search` = 查**原始会话日志**（记忆里没有/不准时，回原文捞精确字面量与出处）
    // 实现方式（**不重复实现**，工程上刻意的）：本工具是 `~/.dsh/tools/session-search/session-search.mjs`
    //   的**第二个前端** —— 那份 CLI 是零依赖（node:fs/zlib + 外部 rg）、缓存为磁盘纯文本、检索在进程外
    //   （绝不把 124–149 M 字符语料读进 JS 堆），是这条能力的**单一实现**。此处在子进程里调它，只做
    //   参数整形与输出裁剪；任何检索语义的改动都只改一处。
    // 为什么不在插件内 import 它：它的配置（CACHE_DIR/SESSIONS_ROOT）在**模块加载期**由 `process.argv`
    //   求值 ⇒ 被 import 时会读到**宿主 DSH 的 argv**，静默指错目录。子进程边界正是隔离这层语义的正当手段。
    const SESSION_SEARCH_CLI = (() => {
      const cands = [
        portable(DSH_HOME) + "/tools/session-search/session-search.mjs",
        portable(MEMORY_ROOT) + "/tools/session-search/session-search.mjs",
      ];
      for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (e) {} }
      return cands[0];                     // 都不在 ⇒ 返回首选路径，报错时能让用户看见"该放哪"
    })();
    function runSessionSearchCli(args, timeoutMs) {
      try {
        const out = execFileSync(process.execPath, [SESSION_SEARCH_CLI].concat(args),
          { encoding: "utf8", timeout: timeoutMs || 60000, maxBuffer: 64 * 1024 * 1024 });
        return { ok: true, code: 0, out: String(out || ""), err: "" };
      } catch (e) {
        return {
          ok: false,
          code: (e && typeof e.status === "number") ? e.status : -1,
          out: (e && e.stdout) ? String(e.stdout) : "",
          err: (e && e.stderr) ? String(e.stderr) : String((e && e.message) || e),
        };
      }
    }
    // ═══════════ v3.1.0：索引自动刷新（主挂点 = 每小时 tick；次挂点 = dream 结算后） ═══════════
    // 为什么要有：本仓宿主侧原先**零自动建索引钩子**（三席评审 2026-09-20 复核确认）⇒ 检索面只在人手跑
    //   `--build` 时前进，用户不知道要补，新会话就搜不到。
    // 硬约束（评审结论）：① 只用异步 execFile（同步 execFileSync 会冻住宿主）；② 调用方**不 await**；
    //   ③ 进程内单飞 + 跨进程由 CLI 自抢 `.build.lock`（CLI 侧 exit 6 ⇒ 这里按「跳过」记，不是失败）；
    //   ④ 冷却落**磁盘账本**（内存标志重启即失效、多会话各算一份 ⇒ 闸门形同不存在）；
    //   ⑤ 只写 session-text 缓存与自有账本，**不碰记忆库正文**（.integrate.json 一字不动）。
    let IDX_REFRESH_RUNNING = false;
    function readIndexLedger() {
      try { const o = JSON.parse(fs.readFileSync(IDX_REFRESH_LEDGER, "utf8")); return (o && typeof o === "object") ? o : {}; }
      catch (e) { return {}; }
    }
    function writeIndexLedger(o) { try { writeFileAtomic(IDX_REFRESH_LEDGER, JSON.stringify(o)); } catch (e) {} }
    function runSearchCliAsync(args, timeoutMs) {
      return new Promise((resolve) => {
        try {
          execFile(process.execPath, [SESSION_SEARCH_CLI].concat(args),
            { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" },
            (err, stdout, stderr) => resolve({
              ok: !err,
              code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
              killed: !!(err && (err.killed || err.signal)),
              out: String(stdout || ""),
              err: String(stderr || (err && err.message) || ""),
            }));
        } catch (e) { resolve({ ok: false, code: -1, killed: false, out: "", err: String((e && e.message) || e) }); }
      });
    }
    // 刷新入口（幂等、绝不 reject）：ran=false 时 why ∈ inactive / busy / cooling / throw
    function refreshSearchIndex(opts) {
      const o = opts || {};
      return new Promise((resolve) => {
        try {
          if (PLUGIN_CFG.active === false) return resolve({ ran: false, why: "inactive" });
          if (IDX_REFRESH_RUNNING) return resolve({ ran: false, why: "busy" });
          const led = readIndexLedger();
          const now = Date.now();
          // 冷却分两档（本仓自审修掉的两处缺陷）：
          //   ① 未连败：基准 = **上次成功**（或人手/工具刚 build 过）—— 失败**不**续冷却，
          //      否则连续失败永远攒不到 3 次、24h 退避形同不存在；
          //   ② 已连败 ≥3：基准另取**上次尝试时刻**（否则「从未成功过」时基准恒 0 ⇒ 退避永不生效）。
          const failN = Number(led.failStreak) || 0;
          const touchOk = Math.max(Number(led.lastOkAt) || 0, Number(led.lastToolBuildAt) || 0);
          const basis = failN >= 3 ? Math.max(touchOk, Number(led.lastAt) || 0) : touchOk;
          const gap = failN >= 3 ? IDX_REFRESH_BACKOFF_MS : IDX_REFRESH_MIN_GAP_MS;
          if (basis && now - basis < gap) return resolve({ ran: false, why: "cooling", leftMs: gap - (now - basis) });
          IDX_REFRESH_RUNNING = true;
          writeIndexLedger(Object.assign({}, led, { lastTryAt: now, lastReason: String(o.reason || "tick") }));
          runSearchCliAsync(["--build"], idxRefreshTimeoutMs()).then((r) => {
            IDX_REFRESH_RUNNING = false;
            const m = /建 (\d+)，跳过 (\d+)，错 (\d+)/.exec(r.out || "");
            const built = m ? Number(m[1]) : null, skipped = m ? Number(m[2]) : null, errors = m ? Number(m[3]) : null;
            const locked = r.code === 6;                        // CLI 侧并发保护：不是错误，下轮自然重试
            const hard = !locked && (!r.ok || built === null);   // 无 stats 行 ⇒ 硬失败（超时/kill/CLI 缺失）
            const led2 = readIndexLedger();
            const next = Object.assign({}, led2, { lastAt: Date.now(), lastCode: r.code, lastOut: String(r.out || "").slice(0, 200) });
            if (locked) { delete next.lastTryAt; next.lastKind = "locked"; }
            else if (hard) { next.lastKind = "hard-fail"; next.failStreak = (Number(led2.failStreak) || 0) + 1; next.lastErr = String(r.err || "").slice(0, 300); }
            else { next.lastKind = "ok"; next.lastOkAt = Date.now(); next.failStreak = 0; next.built = built; next.skipped = skipped; next.errors = errors; delete next.lastErr; }
            writeIndexLedger(next);
            try { monitorEvent("search-index", [next.lastKind, "reason=" + String(o.reason || "tick"), "code=" + r.code, "built=" + built, "skipped=" + skipped, "ms=" + (Date.now() - now)].join(" ")); } catch (e) {}
            // 可见性：自动/定期轮恒静默；只有点名带 listener（dream 结算）且「真建了」或「硬失败」才落一行
            if (o.listener && !locked && (hard || (built !== null && built > 0))) {
              const body = hard
                ? ("自动补建失败（code " + r.code + "）：" + String(r.err || "").slice(0, 120))
                : ("增量补建完成：建 " + built + " / 跳过 " + skipped);
              try {
                const raw = "<system-reminder>\n【dsh-memory · 索引】" + body + "\n</system-reminder>";
                const smsg = makeNoticeMessage(raw, ("索引：" + body).slice(0, 140));
                setTimeout(() => {
                  try {
                    if (canSurfaceAppend(o.listener) && o.listener.session && typeof o.listener.session.append === "function") o.listener.session.append("user/message", smsg, { surfaceOp: "append" });
                    else if (typeof o.listener.inject === "function") o.listener.inject(makeMessage(raw));   // [400guard 20260927]：中途落表会打断 tool_calls/tool 配对 ⇒ 降级 inject 排队
                  } catch (e) {}
                }, 0);
              } catch (e) {}
            }
            resolve({ ran: true, code: r.code, built: built, skipped: skipped, hard: hard, locked: locked });
          });
        } catch (e) { IDX_REFRESH_RUNNING = false; resolve({ ran: false, why: "throw" }); }
      });
    }
    __indexRefreshTick = refreshSearchIndex;
    if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "session_search",
          description: "在**原始会话日志**里检索精确字面量并给出出处（dsh-memory v2.8.4）。"
            + "用途：当记忆库（memory_search）里**没有、或记不准**某个字面量时，回原始会话原文把它捞出来 —— "
            + "适用于 ID/GUID、URL、文件路径、命令、参数、文号、报错串、数值这类**精确串**。"
            + "分工：memory_search 查已沉淀的**结论**；session_search 查**原始对话**。"
            + "参数：query=精确字面量（**优先用最稀有的一段**，如完整 GUID；不要用描述性长句，分词会把长句拆散）；"
            + "since/until=YYYY-MM-DD 限定日期（闭区间）；sid=会话 id 前缀；limit=列出条数（默认 20）；"
            + "show={sid,frame,file?,line?}=按命中坐标**回看原文**；status=true 只看索引状态；"
            + "source=logs（默认，原始会话日志）/ units（归档时**抽取好的会话正文**，日志被轮转或缺失时用它）/ all（两者并查）；"
            + "build=true 仅在确需重建索引时使用（**慢，全库实测约 6 分钟**，默认禁止）。"
            + "返回：命中总数 + 每条 {会话短id, 事件类型, 源文件#帧号, 缓存段:行, 片段}；0 命中时返回升级路径（换更稀有的词 → 放宽范围 → build）。"
            + "多词空格精确 0 命中时会自动分词回退（交集优先并注明），但仍建议单给最稀有的一段。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "要检索的**精确字面量**（完整 GUID/URL/路径/命令/报错串；别用长句）" },
              since: { type: "string", description: "起始日期 YYYY-MM-DD（含当天）" },
              until: { type: "string", description: "结束日期 YYYY-MM-DD（含当天）" },
              sid: { type: "string", description: "会话 id 前缀（如 62c8532e）" },
              source: { type: "string", description: "检索源：logs（默认）=原始会话日志；units=归档时**抽取好的会话正文**（`~/.dsh/memory/.archive-units/`，日志被轮转/劈开时只剩它）；all=两者并查" },
              limit: { type: "number", description: "最多列出多少条（默认 20；总数另计，截断不冒充命中数）" },
              show: {
                type: "object",
                description: "按命中坐标回看原文（与 query 二选一）",
                properties: {
                  sid: { type: "string", description: "会话 id 前缀" },
                  frame: { type: "number", description: "帧号（命中行给出的 #fN）" },
                  file: { type: "string", description: "源文件名（可选，用于同名双日志消歧）" },
                  line: { type: "string", description: "缓存段内行号（可选）" },
                },
                required: ["sid", "frame"],
              },
              status: { type: "boolean", description: "只看索引状态（天数/会话数/字节数）" },
              build: { type: "boolean", description: "**慢**（全库约 6 分钟）：重建/增量更新索引。默认禁止" },
            },
          },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args) {
            const a = (args && typeof args === "object") ? args : {};
            const cli = ["--ds-home", portable(DSH_HOME)];
            try { if (!fs.statSync(SESSION_SEARCH_CLI).isFile()) {
              return "❌ 未找到检索 CLI：" + SESSION_SEARCH_CLI + "\n   请把 `session-search.mjs` 放到该路径（它是本能力的单一实现）。";
            } } catch (e) {
              return "❌ 未找到检索 CLI：" + SESSION_SEARCH_CLI + "\n   请把 `session-search.mjs` 放到该路径（它是本能力的单一实现）。";
            }
            // ── 模式 1：索引状态 ──
            if (a.status === true) {
              const r = runSessionSearchCli(cli.concat(["--status"]), 30000);
              return r.ok ? ("索引状态：\n" + r.out) : ("状态查询失败（exit=" + r.code + "）：\n" + (r.err || r.out));
            }
            // ── 模式 2：按坐标回看原文 ──
            if (a.show && typeof a.show === "object" && a.show.sid) {
              const sv = a.show;
              const sArgs = cli.concat(["--show", String(sv.sid), "--frame", String(sv.frame), "--json"]);
              if (sv.file) sArgs.push("--file", String(sv.file));
              if (sv.line) sArgs.push("--line", String(sv.line));
              const r = runSessionSearchCli(sArgs, 60000);
              if (!r.ok) {
                if (r.code === 5) return "该坐标在缓存中不存在 —— 缓存可能已按新口径重建（坐标会整体漂移）。请改用 query 关键词重搜。";
                return "回看失败（exit=" + r.code + "）：" + (r.err || r.out).slice(0, 400);
              }
              let j = null; try { j = JSON.parse(r.out); } catch (e) {}
              if (!j || !Array.isArray(j.hits) || !j.hits.length) return "无可返回的命中（解析失败或空结果）。";
              return j.hits.map((h) => {
                const full = String(h.text || "").replace(/\s+/g, " ");
                return "【原文】" + full + "\n  出处：" + (h.file || "?") + "#f" + h.frame + "  会话 " + h.sid + "  事件 " + (h.kind || "?") + "  缓存 " + h.seg + ":" + h.ln;
              }).join("\n\n");
            }
            // ── 模式 3：可选重建（默认禁止）──
            if (a.build === true) {
              const bArgs = cli.concat(["--build"]);
              if (a.sid) bArgs.push("--sid", String(a.sid));
              const r = runSessionSearchCli(bArgs, 900000);      // v3.1.0 实测：稳态 2.98s / 吸收积压 8.92s / 冷建最坏 115.2s ⇒ 15 分钟上限仍留大余量
              // v3.1.0：人手/工具刚 build 过 ⇒ 记进账本（自动刷新据此 IDX_TOOL_BUILD_QUIET_MS 内不贴脸重跑）
              try { writeIndexLedger(Object.assign({}, readIndexLedger(), { lastToolBuildAt: Date.now(), lastToolCode: r.code })); } catch (e) {}
              return "[build] " + (r.ok ? "完成" : ("失败 exit=" + r.code)) + "：\n" + (r.out || r.err).slice(0, 2000);
            }
            // ── 模式 4：检索（默认）──
            const kw = (a.query === undefined || a.query === null) ? "" : String(a.query);
            if (!kw.trim()) return "请提供 query（要检索的精确字面量）；或用 show={sid,frame} 回看原文；或用 status=true 看索引状态。";
            const sArgs = cli.concat([kw, "--json"]);
            if (a.since) sArgs.push("--since", String(a.since));
            if (a.until) sArgs.push("--until", String(a.until));
            if (a.sid) sArgs.push("--sid", String(a.sid));
            // §9.12①：检索源（logs 默认｜units 归档单元｜all）—— CLI 侧对 units 会**按需增量重建**单元缓存
            if (a.source === "units" || a.source === "logs" || a.source === "all") sArgs.push("--source", String(a.source));
            sArgs.push("--limit", String(Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.min(Number(a.limit), 200) : 20));
            const r = runSessionSearchCli(sArgs, 120000);
            let j = null; try { j = JSON.parse(r.out); } catch (e) {}
            if (!j) {
              // JSON 都没拿到 ⇒ 缓存可能不存在（CLI 在缓存为空时返回 note）或 rg 缺失
              return "检索未返回结果（exit=" + r.code + "）。可能原因：① 缓存未建（首次需 `build:true`，全库约 6 分钟）"
                + " ② 未找到 ripgrep。\nCLI 输出：" + (r.err || r.out).slice(0, 400);
            }
            if (!j.total) {
              // v3.1.0（A2）：logs 0 命中 ⇒ **自动回退 units 源**再查一次（归档抽取正文；CLI 侧对 units 会按需
              //   增量重建，实测 ≈0.4s）。只治「日志被轮转/劈开、正文只剩在单元里」这一形态——它**不治**
              //   「最近会话未入 logs 索引」（那靠主挂点的自动刷新）。用户显式指定 source 时不越权改源。
              const explicitSrc = (a.source === "units" || a.source === "all");
              if (!explicitSrc) {
                const sArgs2 = sArgs.slice();
                const si = sArgs2.indexOf("--source");
                if (si >= 0 && si + 1 < sArgs2.length) sArgs2[si + 1] = "units";
                else sArgs2.splice(Math.max(0, sArgs2.length - 2), 0, "--source", "units");
                const r2 = runSessionSearchCli(sArgs2, 120000);
                let j2 = null; try { j2 = JSON.parse(r2.out); } catch (e) {}
                if (j2 && j2.total) {
                  const head2 = "命中 " + j2.total + " 处（logs 源 0 命中；以下来自**归档单元源**）" + (j2.total > j2.listed ? ("（列出前 " + j2.listed + " 条，可调大 limit）") : "");
                  const body2 = (j2.rows || []).map((x) => {
                    const full = String(x.x || "").replace(/\s+/g, " ");
                    const at = full.indexOf(kw);
                    const from = at < 0 ? 0 : Math.max(0, at - 90);
                    const snip = (from > 0 ? "…" : "") + full.slice(from, from + 260) + (full.length > from + 260 ? "…" : "");
                    return "[" + x.sid + "] " + (x.k || "?") + "  src:" + (x.src || "?") + "#f" + (x.fr === undefined ? "?" : x.fr) + "  cache:" + x.seg + ":" + x.line + "\n    " + snip;
                  }).join("\n");
                  const first2 = (j2.rows || [])[0];
                  const tail2 = first2 ? ("\n\n回看原文：session_search({ show: { sid: \"" + first2.sid + "\", frame: " + first2.fr + " } })") : "";
                  return head2 + "\n\n" + body2 + tail2;
                }
              }
              // 多词回退（2026-09-22）：精确连写 0 命中且 query 含空格 ⇒ 按空白分词逐个重查，帧分组交集优先。
              // 为什么放插件侧而不改 CLI：CLI 是单一实现（单 pattern，空格逐字命中；R-5~R-10 钉死
              // “给了东西必须照做”，静默改写空格语义会重蹈“带空格路径被拆散”的覆辙）。此处是显式编排
              // （与上面的 units 自动回退同构）：精确优先，0 命中才回退，且回退结果如实注明、各词总数照实报。
              const toks = kw.split(/\s+/).map((t) => t.trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 5);
              if (toks.length > 1) {
                const reqLim = (Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.min(Number(a.limit), 200) : 20);
                const perSrc = (a.source === "units" || a.source === "logs" || a.source === "all") ? String(a.source) : null;
                const tokRes = [];
                for (const t of toks) {
                  const tArgs = cli.concat([t, "--json"]);
                  if (a.since) tArgs.push("--since", String(a.since));
                  if (a.until) tArgs.push("--until", String(a.until));
                  if (a.sid) tArgs.push("--sid", String(a.sid));
                  if (perSrc) tArgs.push("--source", perSrc);
                  tArgs.push("--limit", String(Math.min(reqLim, 20)));
                  let tj = null;
                  try {
                    const tr = runSessionSearchCli(tArgs, 120000);
                    try { tj = JSON.parse(tr.out); } catch (e) { tj = null; }
                  } catch (e) { tj = null; }
                  tokRes.push({ tok: t, total: (tj && typeof tj.total === "number") ? tj.total : 0, rows: (tj && Array.isArray(tj.rows)) ? tj.rows : [] });
                }
                const hitRes = tokRes.filter((z) => z.total > 0);
                if (hitRes.length) {
                  // 帧分组：同（会话，帧，源文件）归一组，命中词数多的优先
                  const groups = new Map();
                  for (const z of hitRes) {
                    for (const x of z.rows) {
                      const gk = String(x.sid) + "|" + String(x.fr) + "|" + String(x.src || "");
                      let g = groups.get(gk);
                      if (!g) { g = { keys: new Set(), rows: [], best: null, score: 0 }; groups.set(gk, g); }
                      g.keys.add(z.tok); g.rows.push({ row: x, tok: z.tok });
                      if (!g.best) g.best = x;
                    }
                  }
                  // 同组内优先用“命中词全包含”的行做代表（否则取首行）
                  for (const g of groups.values()) {
                    const need = Array.from(g.keys);
                    const both = g.rows.find((e) => need.every((t) => String((e.row && e.row.x) || "").indexOf(t) >= 0));
                    if (both) g.best = both.row;
                    g.score = g.keys.size;
                  }
                  const ordered = Array.from(groups.values()).sort((p, q) => (q.score - p.score) || (q.rows.length - p.rows.length)).slice(0, reqLim);
                  if (ordered.length) {
                    const totals = tokRes.map((z) => z.tok + "=" + z.total).join("、");
                    const rareFirst = hitRes.slice().sort((p, q) => p.total - q.total)[0].tok;
                    const headF = "精确 0 命中，已按空格分词回退（" + toks.length + " 词 OR、命中词多优先；各词命中 " + totals + "，共 " + groups.size + " 组，列出前 " + ordered.length + " 组）";
                    const bodyF = ordered.map((g) => {
                      const x = g.best || {};
                      const full = String(x.x || "").replace(/\s+/g, " ");
                      let at = -1;
                      for (const t of toks) { const p = full.indexOf(t); if (p >= 0 && (at < 0 || p < at)) at = p; }
                      const from = at < 0 ? 0 : Math.max(0, at - 90);
                      const snip = (from > 0 ? "…" : "") + full.slice(from, from + 260) + (full.length > from + 260 ? "…" : "");
                      const tag = g.score > 1 ? ("（同帧命中 " + g.score + "/" + toks.length + " 词：" + Array.from(g.keys).join("、") + "）") : "";
                      return "[" + x.sid + "] " + (x.k || "?") + "  src:" + (x.src || "?") + "#f" + (x.fr === undefined ? "?" : x.fr) + "  cache:" + x.seg + ":" + x.line + tag + "\n    " + snip;
                    }).join("\n");
                    const f0 = ordered[0] && ordered[0].best;
                    const tailF = f0 ? ("\n\n回看原文：session_search({ show: { sid: \"" + f0.sid + "\", frame: " + f0.fr + " } })"
                      + "\n提示：下次直接查最稀有的一个词（如 \"" + rareFirst + "\"），不用拼长句。") : "";
                    return headF + "\n\n" + bodyF + tailF;
                  }
                }
              }
              const ledI = readIndexLedger();
              const fresh = ledI.lastOkAt ? ("最近一次自动补建成功 " + new Date(ledI.lastOkAt).toLocaleString()) : "尚无成功记录";
              return "命中 0 处" + (j.note ? ("（" + j.note + "）") : "") + "。\n"
                + "⚠ 0 结果 ≠ 没记录。按顺序升级：\n"
                + "  1. 换**更稀有**的词 —— 完整 GUID/URL/路径/报错串 远优于描述性长句（分词会把长句拆散）\n"
                + "  2. 放宽范围 —— 去掉 since/until，或去掉 sid\n"
                + "  3. 缓存可能滞后 —— 用 build:true 增量重建（活跃会话最后几秒可能不在）\n"
                + (a.source === "units" || a.source === "all" ? "" : "  4. 若该内容**曾被归档过**，再试 source:\"units\"（归档时抽取的会话正文；日志被轮转/劈开时只剩它）\n")
                + "  · 索引自动刷新（v3.1.0）：" + fresh + "（每小时 tick 与 dream 结算后各刷一次，通常无需手动 build）\n";
            }
            const head = "命中 " + j.total + " 处" + (j.total > j.listed ? ("（列出前 " + j.listed + " 条，可调大 limit）") : "") + "";
            const body = (j.rows || []).map((x) => {
              const full = String(x.x || "").replace(/\s+/g, " ");
              const at = full.indexOf(kw);
              const from = at < 0 ? 0 : Math.max(0, at - 90);
              const snip = (from > 0 ? "…" : "") + full.slice(from, from + 260) + (full.length > from + 260 ? "…" : "");
              return "[" + x.sid + "] " + (x.k || "?") + "  src:" + (x.src || "?") + "#f" + (x.fr === undefined ? "?" : x.fr)
                + "  cache:" + x.seg + ":" + x.line + "\n    " + snip;
            }).join("\n");
            const first = (j.rows || [])[0];
            const tail = first ? ("\n\n回看原文：session_search({ show: { sid: \"" + first.sid + "\", frame: " + first.fr + " } })") : "";
            return head + "\n\n" + body + tail;
          }
        });
        clog("[dsh-memory] session_search 会话原文检索工具已注册（记忆缺失时回原文捞精确字面量）");
      } catch (e) { cwarn("[dsh-memory] session_search 注册失败:", e && e.message ? e.message : String(e)); }
    }
   // v2.3.2(dream-tool)：声明提前（TDZ），memory_dream_patch 与 memory_search 共用
    // 注册 memory_dream_patch（dream 整合交付工具）
if (toolSvc !== undefined && typeof toolSvc.register === "function") {
      try {
        toolSvc.register({
          name: "memory_dream_patch",
          description: "提交记忆库写入检查点（dream 整合子代理与主代理均可调用）：把要写入记忆库的补丁装进 patches 参数。插件当场校验并落盘：成功返回 wrote 清单；失败返回错误清单（哪一条/哪个字段/为什么），请按清单修正后再次调用（可多次调用，直到全部通过）。file 必须是 ~/.dsh/memory/ 下相对路径（sessions|projects|knowledge|tools/ 或 global.md|index.md）；action ∈ edit|replace|append|delete；edit=局部精确替换（首选），content ≤128KB（edit 免 content、用 old_string/new_string）。本工具供 **dream 整合子代理与归档通道**使用；主代理请用记忆库既有的编辑方式（edit/write）或走 /dream 流程。",
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
              },
              allowDangling: { type: "boolean", description: "（v2.6.4）显式放行「指向未落盘文件」的库内指针：仅用于复述/描述既有指针（如事故记录里逐字引用一个未落盘文件名），正常写入路径不要用。缺省时本批新增的悬空指针会被拒写。" }
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
            const r = applyPatches(patches, { allowDangling: !!(args && typeof args === "object" && !Array.isArray(args) && args.allowDangling === true) });   // v2.6.4：指针闭合校验的显式逃生口
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
          description: "搜索全局记忆库（~/.dsh/memory/）以召回此前沉淀的持久知识。应当先于「凭记忆猜/直接问用户」使用——跨会话踩坑、项目事实、精确配置（路径/ID/命令/数字）、用户偏好大概率已记录。参数 query：主题关键词（1-3 个最具体词，如 OA日志、智检API、前缀缓存）或记忆文件相对路径（global、index、fixed、长沙交易场地…）。检索语义：OR 分词 + 相关度排序——任一单词命中即返回候选，稀有词比泛词更准（避免「配置 参数 数据库」堆泛词）。命中即信：一次查询未中不代表未记录，换更稀有词重试；0 结果时按返回文案的升级路径处理（换词 → read 直读 ~/.dsh/memory/ 下文件 → 查最近会话摘要）。可直接作为工具调用；run_code 程序内亦可经 await tools.memory_search({ query }) 调用。",
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
            // v2.8.6（B 档）：评分后叠加 衰减 × 重要度 × 时间窗 乘子（仅重排，不改 scoreTarget 本体）。
            const recencyQ = isRecencyQuery(q);
            const results = [];
            for (const t of targets) {
              const text = await readText(t.rel);
              if (!text) continue;
              const { score, hitLines } = scoreTarget(t, text, tokens);
              if (score <= 0) continue;
              let mt = NaN;
              try { mt = fs.statSync(portable(t.rel)).mtimeMs; } catch (eM) {}
              const fm = parseFrontmatter(text);
              const dy = decayFactor(fm, mt);
              const im = importanceFactor(fm);
              const rc = recentnessFactor(fm, mt, recencyQ);
              results.push({ t, score, hitLines, rawScore: score, decay: dy, importance: im, recency: rc, score2: score * dy * im * rc });
            }
            // v12：分数降序（同分按 label）；v2.8.6：按复合分排序
            results.sort((a, b) => b.score2 - a.score2 || a.t.label.localeCompare(b.t.label));
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
            const topScore = results[0].score2;
            const cutoff = topScore * 0.15;
            const kept = results
              .filter((r, i) => i === 0 || (r.score2 >= cutoff && (r.score2 >= ABS_MIN_SCORE || results.length === 1)))
              .slice(0, 8);
            const exactSingle = kept.length === 1 && kept[0].t.file === q;
            const body = kept.map((r) => {
              const lines = r.hitLines.length > 0
                ? "\n  " + r.hitLines.slice(0, 3).join("\n  ")
                : "\n  （主题/文件名命中，无正文行摘录）";
              // v2.8.6：相关度仍报原始词频分；衰减/重要度只在有偏离时附注（无 frontmatter 的旧条目完全静默）
              const meta = [];
              if (r.decay < 0.999) meta.push("衰减 " + r.decay.toFixed(2));
              if (Math.abs(r.importance - 1) > 0.001) meta.push("重要度 " + r.importance.toFixed(2));
              if (r.recency > 1.001) meta.push("近期 +" + Math.round((r.recency - 1) * 100) + "%");
              const note = meta.length ? "；" + meta.join("，") : "";
              return "【" + r.t.label + "】" + r.t.file + "（相关度 " + r.rawScore.toFixed(1) + note + "）" + lines;
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
          description: "提交前 dry-run 预览（dream 整合子代理与主代理均可调用）：传 { file, action, content } 或 { file, action:edit, old_string, new_string } 计算「将落盘后的字符数与预算」——返回 { ok, rel, action, wouldChars, budget, overBy, fits, sections }；sections 为 ## 分节字符表（## 归档/漏网会话补档 族标 preferExtract，首选提取），所有文件均返回。写 global/index/projects 这类 budget 敏感文件前先 dry-run 一次量准再真调 memory_dream_patch；sessions/|knowledge/|tools/ 无预算——无需预览，直接 memory_dream_patch 写入即可；**每文件 10 分钟滑动窗内最多 4 次、每会话 8 次，超出工具直接拒绝并回传差数**；不落盘、纯只读。file 越界/action 非法返回错误清单。",
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
              .filter((s) => shouldReArchive(s, reArchiveOpts()));   // v2.8.4（P13/P15）：单一谓词（原两道闸串行 ⇒ 已落盘会话永不可重档）
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
          description: "dsh-memory 初始化与升级状态工具。action=status 体检记忆库并回显版本/状态；action=init 立刻重发一次初始化引导；action=snooze 用户说回头再弄，暂停提醒 hours 小时（默认 24）；action=check-update 立即检查新版本。可直接作为工具调用；run_code 程序内亦可经 await tools.memory_onboard({ action: \"status\" }) 调用。",
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
              // v2.6.4（L3 体检出口）：悬空指针 = 记忆库内指针指向不存在的文件（「能召回的必已落盘」不变量破口）。
              //   写时 L1 拦新增，此处对**全库存量**兜底（含 maint/archive/命令等其他写入入口与历史遗留）。
              let danglingTxt = "";
              try {
                const dg = scanDanglingPointers();
                if (dg.length) {
                  danglingTxt = "\n悬空指针 " + dg.length + " 处（指向不存在的记忆库文件；建议补写目标、或改指实存文件——已轮转会话指 sessions/archive/…）："
                    + dg.slice(0, 5).map((d) => d.src + " → " + d.rel).join("；") + (dg.length > 5 ? " 等" : "");
                }
              } catch (eD) { danglingTxt = ""; }
              return "记忆库：" + m.status + " · global " + m.bytesGlobal + "B / index " + m.bytesIndex + "B"
                + (m.missingDirs.length ? " · 缺目录 " + m.missingDirs.join(",") : "")
                + (m.hasAgents ? " · 有 AGENTS.md" : " · 缺 AGENTS.md（安装脚本会自动补）")
                + "\n" + onboardStatusLine()
                + danglingTxt
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
            // ═══ v3.2.0（2026-10-02 Wave 1）：自校准**方向性硬闸**（R3/R5/R6/R7 + 活跃字段锁）═══
            //   动因：`spiralThreshLog` 17 条里 6 条同一理由（"中位数 ≤ rep+0.05 ⇒ 上调"）把 rep 抬到硬上限 0.80，
            //   上限封死后又**改别的旋钮**（09-25 原文"rep 0.85 越界被拒，改调冷却"）⇒ 只锁单字段不够，必须按方向闸。
            //   原则：**提敏 / 回滚一律放行**（不受任何限制），**降敏必须带证据且受限**。
            const DESENS = { rep: 1, neg: 1, sim: 1, w: 1, cooldownMin: 1, sameNeg: -1, sameSteps: 1, sameMinSecs: 1,
              sameHomo: -1, watchSteps: 1, watchSecs: 1, watchCooldownMin: 1, brkSameN: 1, brkMinSteps: 1, brkMaxDeny: -1 };
            const STEP_MAX = { rep: 0.05, neg: 0.05, sim: 0.05, sameNeg: 0.05, sameHomo: 0.05 };   // 其余整数字段 ≤4 步
            const desens = [];
            for (const k of Object.keys(next)) {
              const dl = next[k] - cur[k];
              if (dl && Math.sign(dl) === DESENS[k]) desens.push({ k: k, delta: dl });
            }
            // R3（v3.2.0）：**单轮步长上限对两个方向都生效**——既防"一次到位"的激进变更，也防一次调用把 rep
            //   拉到 0.30 造成提醒风暴（提敏同样危险，只是方向不同）。事故级回调走代码内一次性迁移，不经此工具。
            {
              const over = [];
              for (const k of Object.keys(next)) {
                const dl = next[k] - cur[k];
                if (!dl) continue;
                const cap = STEP_MAX[k] != null ? STEP_MAX[k] : 4;
                if (Math.abs(dl) > cap + 1e-9) over.push("R3 " + k + " 单轮幅度 " + Math.abs(dl) + " 超过上限 " + cap);
              }
              if (over.length) return "⛔ 变更被拒（v3.2.0 步长闸）：" + over.join("；") + "。请分多次小步调整（整数字段单轮 ≤4、比例字段 ≤0.05）。";
            }
            if (desens.length) {
              const now0 = Date.now();
              const log = Array.isArray(md.spiralThreshLog) ? md.spiralThreshLog : [];
              const bad = [];
              const rs = String(a.reason || "");
              if (rs.trim().length < 12 || !/\d/.test(rs)) bad.push("R5 降敏变更必须带 ≥12 字且含数字的 reason");
              for (const c of desens) {
                for (let i = log.length - 1; i >= 0; i--) {          // R6：同字段 24h 内已降敏过 ⇒ 拒
                  const L0 = log[i]; if (!L0 || !L0.to || (now0 - (L0.t || 0)) >= 24 * 3600e3) break;
                  const pf = (L0.from && L0.from[c.k] !== undefined) ? L0.from[c.k] : null;
                  if (pf === null || L0.to[c.k] === undefined) continue;
                  if (Math.sign(L0.to[c.k] - pf) === DESENS[c.k]) { bad.push("R6 " + c.k + " 24h 内已降敏过（" + Math.round((now0 - L0.t) / 3600e3) + "h 前）"); break; }
                }
                for (let i = log.length - 1; i >= 0; i--) {          // 活跃字段锁：24h 内已降敏过**别的**字段 ⇒ 拒
                  const L1 = log[i]; if (!L1 || !L1.to || (now0 - (L1.t || 0)) >= 24 * 3600e3) break;
                  for (const k2 of Object.keys(L1.to)) {
                    if (k2 === c.k) continue;
                    const pf2 = (L1.from && L1.from[k2] !== undefined) ? L1.from[k2] : null;
                    if (pf2 === null) continue;
                    if (Math.sign(L1.to[k2] - pf2) === DESENS[k2]) { bad.push("Lock 24h 内已对 " + k2 + " 降敏，禁止再动 " + c.k + "（防棘轮换旋钮）"); break; }
                  }
                  if (bad.length) break;
                }
              }
              try {   // R7：反向证据硬闸——近 24h D 有被拦 ≥3 次且 0 投递 ⇒ 禁止降敏
                // v3.2.0（Wave 2 候选 C）：被拦 reason 集合扩为 {batch(旧口径), batch-cooldown, cooldown, off}；
                //   `batch-soft` 属**已投递**（降级文案），不计入拦截。
                const BLOCKED = ["batch", "batch-cooldown", "cooldown", "off"];
                const ge = Array.isArray(md.gateEvents) ? md.gateEvents : [];
                const dBlocked = ge.filter((x) => x && x.cls === "D" && BLOCKED.indexOf(x.reason) >= 0 && (now0 - (x.t || 0)) < 24 * 3600e3)
                  .reduce((s2, x) => s2 + (x.n || 1), 0);
                const evs = Array.isArray(md.events) ? md.events : [];
                const dDelivered = evs.filter((x) => x && x.type === "hintD" && (now0 - (x.t || 0)) < 24 * 3600e3).length;
                if (dBlocked >= 3 && dDelivered === 0) bad.push("R7 反向证据：近 24h D 被拦 " + dBlocked + " 次且 0 投递 ⇒ 禁止降敏");
              } catch (e) { /* 证据读取失败不阻断；降敏另有 R5/R6 兜底 */ }
              if (bad.length) return "⛔ 降敏变更被拒（v3.2.0 方向性硬闸）：" + bad.join("；") + "。提敏/回滚不受限；确需降敏请补证据或人工改默认。";
            }
            md.spiralThresh = Object.assign({}, (MONITOR_DATA.spiralThresh || {}), next);
            // v2.0.4: 变更日志（滚动20条）——阈值是被 AI 自动改的政策参数，必须留痕供审计/回滚
            // v3.2.0（Wave 1）：补 `dir`（sens/desens 方向）与 `ep`（**世代快照**：全部生效阈值）——
            //   旧日志只有 from→to，无法判断某条样本是否跨世代；E 相关字段（sameMinSecs/sameHomo）也必须进快照。
            if (!Array.isArray(md.spiralThreshLog)) md.spiralThreshLog = [];
            md.spiralThreshLog.push({ t: Date.now(), from: from, to: Object.assign({}, next), reason: String(a.reason || "").slice(0, 80),
              dir: desens.length ? "desens" : "sens", ep: threshEpoch() });
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
        // ★★ §9.11.4-3 修正六（**红队 rev8c B② 实测**：账本半截 JSON ⇒ 该 tick 静默降级成「无待归档候选」，
        //   并在同一次 tick 里把账本覆盖成只剩 `archiveAutoLast` 的空账本 ⇒ `archivedSessions`/`archiveWatermarks` 全清）：
        //   **账本文件存在但解析不出来 ⇒ 拒绝本次写盘**（fail-closed）。宁可不落盘，也不能用"内存里那三份很可能是空的
        //   账本"覆盖它 —— 那等于把"哪些会话已归档"这条唯一账本洗掉 ⇒ 下次重启全部会话重新成候选（本批要防的形态）。
        //   修复要靠人：从备份/快照恢复，或手工重建 id 列表；**不要直接删除该文件**（删了同样让全部会话重新成候选）。
        let diskRaw = null;
        try { diskRaw = fs.readFileSync(portable(INTEGRATE_STATE_FILE), "utf8"); } catch (e0) { diskRaw = null; }   // 读不到 = 文件不存在（首次运行）⇒ 正常写
        if (diskRaw !== null) {
          let disk = null;
          try { disk = JSON.parse(diskRaw); } catch (e1) { disk = null; }
          if (!disk) {
            // ★★ §9.11.4-5（**根因修复：从"拒写"升级为"抢救"**）。原实现只做 fail-closed（拒写）——
            //   它是治标：归档从此暂停，**要人手工修**；而且"读到损坏就拒写"这条路径正是**非原子写**
            //   制造出来的（现已改成 `writeFileAtomic`，见下方写盘处）。
            //   现在改为**三步抢救**（宁可抢救出 id 列表，也不用空账本覆盖，也不干等人工）：
            //     ① 把**损坏原文**另存为 `.corrupt-<时间戳>.bak`（**绝不删、绝不原地覆盖** —— 它是唯一的现场证据）；
            //     ② 从损坏文本里**正则捞出**全部 `session-<uuid>` 形态的 id（半截 JSON 里已写下的部分仍在）；
            //     ③ 用"抢救出的 id"作 `archivedSessions` 的**下限**（与内存态并集）⇒ 保住"哪些已归档"，
            //        使"下次重启全部会话重新成候选"（token 爆炸）**不会发生**；水位信息无法抢救的部分**如实留痕**。
            let rescued = [];
            try {
              // ★ 正则**不能只认 uuid 形态**（我第一版只写 uuid ⇒ 门夹具里的 `session-stale9`、以及任何
              //   自定义 id 都捞不到 ⇒ 抢救形同虚设）。放宽为 `session-<非空 token>`，并**去重**。
              const ids = String(diskRaw).match(/session-[A-Za-z0-9_-]+/g) || [];
              rescued = Array.from(new Set(ids.map((x) => x.replace(/["',\s].*$/, "").trim()).filter((x) => x.length > 8)));
            } catch (e5) {}
            // ① 备份损坏原文（失败也不阻断，但会留痕）
            let bakOk = false, bakPath = "";
            try {
              bakPath = portable(INTEGRATE_STATE_FILE) + ".corrupt-" + Date.now() + ".bak";
              fs.writeFileSync(bakPath, diskRaw, "utf8");
              bakOk = true;
            } catch (e6) {}
            if (rescued.length > 0) {
              const merged = new Set([...(state.archivedSessions || []), ...rescued]);
              state.archivedSessions = Array.from(merged).slice(-LEDGER_CAP);
              state._rescuedFromCorrupt = { at: Date.now(), ids: rescued.length, bak: bakOk ? true : false };
              // ★ 关键（**我第一版在这里栽了**）：抢救成功后必须把 `disk` 补成**最小可用对象** ——
              //   否则紧随其后的 `if (Array.isArray(disk.archivedSessions))` 会对 `null` 取属性 ⇒ TypeError ⇒
              //   被外层 catch 吞掉 ⇒ **写盘根本没发生**（实测：备份有了、账本仍是 99 B 半截）。
              //   `archiveWatermarks` 置空数组：水位无法从半截 JSON 抢救（**如实**：它会退化成"懒置基线"，
              //   比"全部会话重新成候选"轻得多）。
              disk = { archivedSessions: rescued, archiveWatermarks: [] };
              cwarn("[dsh-memory] ⚠ 账本文件存在但**读不出来**（解析失败 / 半截写 / 损坏）⇒ 已**抢救**出 " + rescued.length
                + " 个已归档 id（原文备份" + (bakOk ? "已保存" : "**保存失败**") + "）⇒ **改为写盘**（用抢救后的账本，"
                + "避免下次重启全部会话重新成候选）。**水位信息可能不完整**（仅能恢复 id 列表）。"
                + "建议：从备份核对 `archiveWatermarks`，或手工补齐；**不要直接删除损坏文件**（已自动留档）。");
              try { monitorEvent("ledger", "corrupt-rescued ids=" + rescued.length + " bak=" + (bakOk ? 1 : 0) + " refusals=" + (REFUSE_WRITE_SEEN = REFUSE_WRITE_SEEN + 1)); } catch (e2) {}
              // 不 return ⇒ 继续走下面的并集合并与写盘（这次写的是"抢救后的账本"）
            } else {
              // 连 id 都捞不出来 ⇒ 退回 fail-closed（拒写），但**原文已备份**
              let refusals = 0;
              try { const st2 = readIntegrateState(); refusals = (Number(st2 && st2._refuseSeen) || 0) + 1; } catch (e4) {}
              REFUSE_WRITE_SEEN = refusals;
              cwarn("[dsh-memory] ⚠ 账本文件存在但**读不出来**（解析失败 / 半截写 / 损坏），且**抢救不出任何 id** ⇒ **本次拒绝写盘**"
                + "（避免用空账本覆盖它；原文已备份为 `.corrupt-*.bak`）。修复：从备份/快照恢复，或手工重建 "
                + "`archivedSessions` / `archiveWatermarks`；**不要直接删除它**。在此之前归档轮暂停（不归档、不写盘）。");
              try { monitorEvent("ledger", "unreadable refuse-write refusals=" + REFUSE_WRITE_SEEN + " bak=" + (bakOk ? 1 : 0)); } catch (e2) {}
              return;   // ← 关键：不写
            }
          }
          if (Array.isArray(disk.archivedSessions)) state.archivedSessions = Array.from(new Set([...disk.archivedSessions, ...(state.archivedSessions || [])])).slice(-LEDGER_CAP);
          // v2.4.3: 水位账本按 id 合并（同 id 取 at 较新者），防多实例/外部补账互相覆盖水位
          if (Array.isArray(disk.archiveWatermarks)) {
            const byId = {};
            for (const w of disk.archiveWatermarks) if (w && w.id) byId[w.id] = w;
            for (const w of (state.archiveWatermarks || [])) if (w && w.id && (!byId[w.id] || (w.at || 0) >= (byId[w.id].at || 0))) byId[w.id] = w;
            state.archiveWatermarks = Object.values(byId).slice(-LEDGER_CAP);   // 批0（P0-4）：300→LEDGER_CAP（原为第二处硬编码）
          }
          if (Array.isArray(disk.staleNotified)) state.staleNotified = Array.from(new Set([...disk.staleNotified, ...(state.staleNotified || [])])).slice(-LEDGER_CAP);
          // v2.8.4（T4·**外部补账不得被插件写洗掉**）：超限账本可由**外部工具**写入（如一次性下沉脚本
          //   `_apply-sink-stuck.mjs` 记 `overLimitStuck`），而本进程的内存态可能是它**之前**读的 ⇒ 整对象写回会抹掉它。
          //   语义与实现见模块级 `mergeLedgerExternalKeys`（纯函数，门直测）。
          mergeLedgerExternalKeys(state, disk);
        }
        // ★★ §9.11.4-5（**根因修复**）：账本原先用 `fs.writeFileSync` **直接写** ⇒ **非原子**：
        //   155 KB 的账本写到一半崩溃/断电/被杀 ⇒ 盘上留**半截 JSON** ⇒ 下次启动"读不出来"⇒
        //   本批的 fail-closed 只能**拒写**（治标：归档从此暂停），而且那条"读到损坏就拒写"的路径
        //   本身也是被这个非原子写**制造**出来的。
        //   ⇒ 改用仓内既有 `writeFileAtomic`（临时文件 + rename + 回读校验）—— **复用现成的**，
        //     不再自造第二套原子写（本批已因"两处各写一遍"栽过多次）。
        const wRes = writeFileAtomic(INTEGRATE_STATE_FILE, JSON.stringify(state, null, 2), { tag: "ledger", verify: true });
        if (wRes && wRes.readbackOk === false) cwarn("[dsh-memory] ⚠ 账本原子写回读校验不一致（盘上内容与预期不符）—— 请留意该文件");
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
        const zpaths = resolveSessionLogPaths(sessionDir);   // v2.8.4（P21）：**全部**（双名目录旧实现只看其一 ⇒ 消耗少算）
        if (!zpaths.length) return null;
        // v1.12.18.4: 复用共享解压实现（消除两套 zstd 多帧循环）
        const text = zpaths.map((zp) => decompressSessionLog(zp)).filter(Boolean).join("\n");
        if (!text) return null;
        let inT = 0, outT = 0, cacheT = 0, reasonT = 0, t0 = 0, t1 = 0;
        let inT2 = 0, outT2 = 0, cacheT2 = 0;   // [2026-09-23 V4] 内联用量（assistant/chunk 行已取消，改收 message 内联）
        for (const line of text.split("\n")) {
          if (line.indexOf("\"usage\"") < 0 && line.indexOf("turn/") < 0) continue;
          let j; try { j = JSON.parse(line); } catch (e) { continue; }
          // [2026-09-23 V4] 用量改内联进 assistant/message.data.usage；chunk 与内联互斥出现，收完按"有 chunk 用 chunk"取舍（防 v3+v4 双文件重叠 double count）
          if (j.type === "assistant/message" && j.data && j.data.usage && typeof j.data.usage === "object") {
            const u2 = j.data.usage;
            inT2 += u2.inputTokens || 0; outT2 += u2.outputTokens || 0; cacheT2 += u2.cacheReadTokens || 0;
          }
          if (j.type === "assistant/chunk" && j.data && j.data.chunk && j.data.chunk.type === "usage") {
            const u = j.data.chunk.usage || {};
            inT += u.inputTokens || 0; outT += u.outputTokens || 0;
            cacheT += u.cacheReadTokens || 0; reasonT += u.reasoningTokens || 0;
          }
          if (j.type === "turn/start") t0 = j.time;
          if (j.type === "turn/end") t1 = j.time;
        }
        // [2026-09-23 V4] chunk 行缺席时用内联用量（v3 文件仍优先 chunk 行，防双文件重叠 double count）
        if (inT + outT + cacheT === 0 && (inT2 + outT2 + cacheT2) > 0) { inT = inT2; outT = outT2; cacheT = cacheT2; }
        // v1.12.17.1: turn/end 可能尚未落盘（完成回调与日志写盘竞态）→ t0 兜底到当前时间
        const durMin = t1 > t0 ? Math.round((t1 - t0) / 60000 * 10) / 10 : (t0 > 0 ? Math.round((Date.now() - t0) / 60000 * 10) / 10 : 0);
        // v1.12.17.1: 口径修正——inputTokens 仅是未命中部分，总输入 = inputTokens + cacheReadTokens
        return { input: inT, output: outT, cache: cacheT, totalIn: inT + cacheT, reasoning: reasonT, durMin: durMin };
      } catch (e) { return null; }
    }

    // v3.2.2（2026-10-18）：子代理"死于什么"必须一眼看见——
    //   宿主 `SubagentResult` 只有 `{ output, stopReason, structured }`，**不带失败原因**
    //   （0.2.1-rc.2 `dsh-subagent/lib/index.js` 的 `captureLocalResult` 实证：stopReason 只会是 "error"）。
    //   于是从子会话日志尾部捞最后一次 `turn/end` 的 `reason.error{message,code}`：
    //   现场（2026-10-18 12:00 dream 连发两次全空、输出 0 字符、usage 0）真因是
    //   `429 GoUsageLimitError`，而插件只打得出 `stopReason=error` —— 不看子会话原始帧无法归因，
    //   人只能误以为是写守卫/超限文件。此函数只读、失败即返回 null，绝不影响结算。
    function readSubagentFailure(sessionDir) {
      try {
        const zpaths = resolveSessionLogPaths(sessionDir);
        if (!zpaths.length) return null;
        const text = zpaths.map((zp) => decompressSessionLog(zp)).filter(Boolean).join("\n");
        if (!text) return null;
        let last = null;
        for (const line of text.split("\n")) {
          if (line.indexOf("turn/end") < 0) continue;
          let j; try { j = JSON.parse(line); } catch (e) { continue; }
          if (j.type !== "turn/end") continue;
          const r = (j.data && j.data.reason) || {};
          const err = r.error || r.failure;
          if (r.kind === "error" || err) {
            last = {
              message: (err && (err.message || err.text)) || (r.kind === "error" ? String(r.kind) : ""),
              code: (err && err.code) || ""
            };
          }
        }
        return last;
      } catch (e) { return null; }
    }

    // ═══ §9.12④（用户「都搞」）：**消耗统计的读取竞态** ═══
    // 症状（既有缺陷，2026-09-18 本会话实测）：子代理 settle 时立刻读它的会话日志，尾部 `assistant/chunk(usage)`
    //   往往**还没落盘** ⇒ `summarizeSubagentUsage` 返回 0 消耗（心跳行里"输入 0 万 / 输出 0 万"躺了很久）。
    //   当时的旁证：`durMin` 走的是"turn/end 缺失 ⇒ 用当前时间兜底"那条分支，而约 2 秒后再读就能读到 usage。
    // 修法：**有界重试**（不做无限轮询）—— 判据 = 读不到任何 usage；最多 USAGE_RETRY_N 次、间隔 USAGE_RETRY_MS；
    //   并把重试次数与最终读取时刻记进账本（`usageRetry`/`usageReadAt`，读不到时另记 `usageEmpty`）
    //   ⇒ 下次看到"0 消耗"能一眼分辨"真的没花"还是"读早了/日志没落盘"。
    const USAGE_RETRY_N = 4, USAGE_RETRY_MS = 1500;
    async function summarizeSubagentUsageRetry(sessionDir) {
      const r = await retryReadUsage(() => summarizeSubagentUsage(sessionDir), { attempts: USAGE_RETRY_N, gapMs: USAGE_RETRY_MS });
      if (!r.value) return null;                     // 保留旧语义：读不到 ⇒ null（调用方跳过）
      // ★ B2（2026-10-07 现场：总输入 0 tokens 却 written=3）：**重试耗尽但读到一个"全 0 的不合格值"**
      //   （现场形态 durMin 有值、inT/outT 全 0）⇒ 必须与"真的没花"分开：带 usageEmpty 出去，
      //   读者行与账本都不会把它读成 0 消耗。判据 = retryReadUsage 带回的 ok（isDone 结论）。
      return Object.assign({}, r.value, { usageRetry: r.tries, usageReadAt: Date.now(), usageEmpty: r.ok !== true });
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
      try {
        const st0 = readIntegrateState();
        // ★ §9.11.4-3 修正五（红队 rev8b F-②）：**读不出来就不要置位**。
        //   旧写法把 `staleNotifiedLoaded = true` 放在读盘**之前** ⇒ 一次读失败（半截 JSON / 瞬时不可读）
        //   就把"内存账本为空"锁死到该进程生命周期，而本批新增的落盘段会无条件 `saveStaleNotified()`
        //   ⇒ 把空账本写回磁盘（= 我本批要修的形态的窄触发版）。现在失败留给下一次调用重试。
        //   注：账本文件**不存在**（首次运行）也走这条 —— 代价是每次调用重试一次读盘，
        //   一旦任何写路径建出该文件，下一次调用即正常加载；相比之下"锁死空账本"的代价大得多。
        if (!st0 || typeof st0 !== "object") {
          // ★ §9.11.4-3 修正六（红队 rev8c B②）：**文件存在却读不出来**（半截 JSON / 损坏）⇒ 记标记并一次性警告。
          //   不置 `staleNotifiedLoaded`（下次调用还会重试读盘 ⇒ 人工修好后**无需重启**即可恢复加载）。
          let fileThere = false;
          try { fileThere = fs.existsSync(portable(INTEGRATE_STATE_FILE)); } catch (e9) {}
          if (fileThere) {
            // ★★ 工程席 rev8k A2：同写入口 —— 警告每次都打（读入口只在人工在场路径与每 tick 调，非热路径），
            //   证据记**内存 + `.monitor.json`**（`monitorEvent`），**不写损坏账本**（那会毁掉 fail-closed 本身）。
            REFUSE_WRITE_SEEN++;
            cwarn("[dsh-memory] ⚠ 账本文件存在但**读不出来**（读盘失败 / 损坏）⇒ 归档轮暂停：不归档、**不写盘**"
              + "（否则会用空账本覆盖它，下次重启全部会话重新成候选）。修复：从备份恢复该文件，或手工重建；"
              + "**不要直接删除它**。");
            try { monitorEvent("ledger", "unreadable abort refusals=" + REFUSE_WRITE_SEEN); } catch (e8) {}
          }
          return;
        }
        staleNotifiedLoaded = true;
        (st0.staleNotified || []).forEach((id) => STALE_NOTIFIED.add(id));
        // v2.4.3: 载入增量重档水位账本
        // §9.11.4-3：`empty` = 该 sid 是**"确无内容"**消号的（不是"提取失败"）；`skipped` = 本轮**一个文件都没读**
        //   （水位已判其帧消费完）。二者都是"账本自答为什么判它已归档"的载体。
        //   ★ 口径更正（**工程席 rev8f A2 实测**）：原文写它们"是 `unitLost` 的排除项" —— **那是描述一个不存在的实现**
        //   （`unitLost` 读的是 `LAST_ARCHIVE_FLOW`/单元文件，从不读水位字段），且这两个字段当时**只有写点**。
        //   现已把计数落盘（`archiveWmEmpty`/`archiveWmSkipped`）并接进 `formatArchiveSignal` ⇒ **有活读点**：
        //   健康行会写"确无内容消号 N 个 … 这些会话本来就没有单元、不算丢了单元"。
        (st0.archiveWatermarks || []).forEach((w) => { if (w && w.id) ARCHIVE_WATERMARK.set(w.id, normalizeWatermark(w, "load")); });
        (st0.archivedSessions || []).forEach((id) => ARCHIVED_SESSIONS.add(id));   // v1.12.19: 双账本加载
        if (st0.archiveLastRunAt) ARCHIVE_LAST_RUN_AT = st0.archiveLastRunAt;   // v2.0.9: 归档节流时间戳跨重启生效
        if (st0.archiveLastFailAt) ARCHIVE_LAST_FAIL_AT = st0.archiveLastFailAt;   // v2.4.7.1: 发起失败短冷却同样跨重启生效
      } catch (e) { /* 忽略 */ }
    }
    // ★ 修正七（红队 rev8d P1）：**现问**"这一轮能否读出账本"——不缓存、不粘滞。
    //   判据只有一条：**文件存在但解析不出**（`readIntegrateState() === null` ∧ 文件在盘上）。
    //   文件不存在 = 首次运行（正常，照常跑）；读得出来 = 正常。⇒ 瞬时失败可自愈。
    function ledgerUnreadableNow() {
      try {
        if (readIntegrateState() !== null) return false;
        return fs.existsSync(portable(INTEGRATE_STATE_FILE));
      } catch (e) { return false; }
    }
    function saveStaleNotified() {
      try {
        // ★★ §9.11.4-6（**本项：读写契约不对称** —— 用**逐行实测**定性，不是推演）。
        //   对象：`readIntegrateState()` 对**两种**情况都返回 `null` —— ①文件不存在（首次运行，正常）
        //   ②**文件存在但解析不出**（半截 JSON / 损坏）。调用方无法从返回值区分，这本身没错；
        //   错在**两个入口对同一个 `null` 给出了不同契约**：
        //     · 读入口 `ensureStaleNotified`（L10317）：坏账本 ⇒ **fail-closed**（L10327 判 `!st0` ⇒
        //       `cwarn` + `monitorEvent` + `return`，**不置** `staleNotifiedLoaded`、**不写盘**）。
        //     · 写入口 `saveStaleNotified`（本函数）：坏账本 ⇒ `readIntegrateState() || {}` 起手 ⇒
        //       **继续往下走、照样写盘**，只靠 `writeIntegrateState` 内部的"抢救"兜底。
        //   实测证据（探针 `_probe-946-asym.mjs`，逐行判定、已删）：
        //     读入口 fail-closed = **true**；写入口取值行 = `const st = readIntegrateState() || {};`
        //     （`|| {}` 骨架 = **true**）；写入口自带坏账本闸（`ledgerUnreadableNow` / `JSON.parse(diskRaw)`）= **false** ×2。
        //   ⇒ "该不该写"由**两个不同判据**决定，且写入口的判据是**走后门**的（靠下游兜底，不靠自己）。
        //     后果不是"立刻丢数据"（rev8q 的抢救在写路径上确实拦住了），而是**契约不可推理**：
        //     任何改动 `writeIntegrateState` 兜底策略的人（含未来的我）都会**无声地**改变写入口的语义 ——
        //     这正是本批反复出现的"两处各写一遍、各自成真理"形态的**读侧同构体**。
        //   修法：**写入口自己拿同样的闸**。判据复用 `ledgerUnreadableNow()`（单一来源，L10361），
        //     语义与读入口**完全对齐**：文件不存在 ⇒ 正常写（新装用户必须能建档）；读得出 ⇒ 正常写；
        //     **存在但读不出 ⇒ 本轮不写**（`REFUSE_WRITE_SEEN++` + 每轮留痕，与 `ensureStaleNotified` 同口径）。
        //   ★ 为什么**不删** `|| {}`：文件不存在的首次运行需要它建出骨架，这是正常路径。
        //   ★ 为什么**保留**下游抢救：这是纵深防御（第二道），不是替代品 —— 兜底仍在，只是不再是**唯一**防线。
        if (ledgerUnreadableNow()) {
          REFUSE_WRITE_SEEN++;
          cwarn("[dsh-memory] ⚠ 账本存在但**读不出来** ⇒ `saveStaleNotified` **本轮不写盘**"
            + "（与读入口 `ensureStaleNotified` 同口径；否则要用内存空账本覆盖它）。"
            + "修复：从备份/`.corrupt-*.bak` 恢复，或手工重建；**不要直接删除它**。");
          try { monitorEvent("ledger", "unreadable save-refuse refusals=" + REFUSE_WRITE_SEEN); } catch (e9) {}
          return;
        }
        const st = readIntegrateState() || {};
        // 批0（P0-4）：上限 300 → 5000，且**裁剪必须留痕**。
        //   根因：三份账本原先各自硬编码同一上限 300（保存路径与写盘合并路径各一处），而盘上会话已 1065 个（实测 archivedSessions 280/300，即将顶格）。
        //   顶格后最旧 id 被**静默**丢弃 ⇒ 重启后不在 ARCHIVED_SESSIONS ⇒ 该会话被判"待归档"重复归档，
        //   或走懒置基线把期间的尾帧**静默吞掉**（永不再提取）。裁剪本身必要（防状态文件无限增长），
        //   但必须可见；若将来 5000 也顶格，正确解法是**按 id 分片**，不是继续加大。
        const _trimLedger = (arr, label) => {
          const a = Array.from(arr);
          if (a.length > LEDGER_CAP) {
            cwarn("[dsh-memory] " + label + " 账本超 " + LEDGER_CAP + " 条（" + a.length + "）——裁剪最旧，最旧会话可能被重复归档或漏档；建议改为按 id 分片");
            try { monitorEvent("ledger", "trim " + label + " " + a.length + "→" + LEDGER_CAP); } catch (e) {}
          }
          return a.slice(-LEDGER_CAP);
        };
        st.staleNotified = _trimLedger(STALE_NOTIFIED, "staleNotified");
        st.archivedSessions = _trimLedger(ARCHIVED_SESSIONS, "archivedSessions");   // v1.12.19；批0（P0-4）：300 → 5000
        st.archiveWatermarks = _trimLedger(ARCHIVED_SESSIONS, "archiveWatermarks").map((id) => { const w = ARCHIVE_WATERMARK.get(id); return w ? normalizeWatermark(w, "save", id) : null; }).filter(Boolean);
        // ★★ §9.11.4-3 修正九（工程席 rev8f A2）：把 `empty`/`skipped` 的**计数**落盘 ⇒ `formatArchiveSignal`
        //   有活读点（"为什么判它已归档"与"为什么它没有单元"都在**用户可见的健康行**上自答；
        //   原先这两个字段只有写点、注释却声称是 `unitLost` 的排除项 = 描述了一个不存在的实现）。
        try {
          let nEmpty = 0, nSkipped = 0;
          for (const id of ARCHIVED_SESSIONS) { const w = ARCHIVE_WATERMARK.get(id); if (w && w.empty === true) nEmpty++; if (w && w.skipped === true) nSkipped++; }
          st.archiveWmEmpty = nEmpty; st.archiveWmSkipped = nSkipped;
          // ★ 修正十三：把"按水位跳过"的两个计数也落盘 ⇒ 健康行能报（**红队 rev8h C-3：跨轮不可查**的整改）
          let nWs = 0, nWsEx = 0;
          for (const [id, w] of ARCHIVE_WATERMARK) { if (w && w.wmSkip === true) { nWs++; if ((Number(w.wmSkipRounds) || 0) >= WM_SKIP_MAX_ROUNDS) nWsEx++; } }   // ★ 工程席 rev8k A4：改遍历**水位全表**（原遍历 `ARCHIVED_SESSIONS`，而 wm-skip 标记路径**不往里加 id** ⇒ 耗尽的会话可能整个漏报，而那正是该告警存在的唯一目的）
          st.archiveWmSkip = nWs; st.archiveWmSkipExhausted = nWsEx;
          // ★ 工程席 rev8k A3 整改：`wmSkippedFrames` 原先**只写不读**（"加了没人读"第 4 例）⇒ 现把**合计被跳过帧数**也落盘，并在健康行报出（让它成为活字段；删掉会丢掉"跳过了多少帧"这个现场线索）。
          let nWsFrames = 0; for (const [id, w] of ARCHIVE_WATERMARK) { if (w && w.wmSkip === true) nWsFrames += Number(w.wmSkippedFrames) || 0; }
          st.archiveWmSkipFrames = nWsFrames;
        } catch (e0) {}
        // ★★ §9.11.4-3 修正十二（**根因席 rev8f B / 工程席 rev8f P0**）：`unitLost` 的**历史**盲区。
        //   现有 `unitLost`（L5426）= `(!unitInfo.ok) && wasExtracted`，而 `wasExtracted` 读的是**本轮内存**
        //   `LAST_ARCHIVE_FLOW.sessionIds` ⇒ 对"**已归档**但盘上查不到单元"的**历史**会话**永远是 false**
        //   ⇒ 那条健康信号**从不响**（根因席：给一个从不执行的信号加守卫 = 死代码延续）。
        //   这里补一个**独立、可复算**的计数：`已归档 ∧ 无单元 ∧ 非空会话（w.empty !== true）` ——
        //   这才是"内容可能真丢了"的可靠信号。
        //   ★ 成本控制：289 个已归档会话逐个读盘太重 ⇒ **限量扫描**（每次最多 50 个，游标轮转，跨轮覆盖全量），
        //     并把"本轮查了多少"一并落盘（`unitLostChecked`）⇒ 读者能判断信号的可信度，不会把"没查"误读成"没丢"。
        try {
          const all = Array.from(ARCHIVED_SESSIONS);
          const CAP = 50;
          let cursor = Number(st.unitLostCursor) || 0;
          if (cursor >= all.length) cursor = 0;
          const slice = all.slice(cursor, cursor + CAP);
          let lostA = 0;
          for (const id of slice) {
            const w = ARCHIVE_WATERMARK.get(id);
            if (w && w.empty === true) continue;                 // 空会话本来就没有单元，不是丢失
            try { const u = readArchiveUnitForSkip(id); if (!u || u.ok !== true) lostA++; } catch (e1) { /* 读失败不计数，避免把环境故障算成丢失 */ }
          }
          st.unitLostArchived = lostA;
          st.unitLostChecked = slice.length;
          st.unitLostCursor = cursor + slice.length;
          st.archiveWmTotal = all.length;   // ★ §9.11.4-9：健康行据此算"待查 N 个"（原先只报"查了 N 个" ⇒ 读者无从判断覆盖度）
        } catch (e2) { try { st.unitLostErr = String((e2 && e2.message) || e2); } catch (e3) {} }
        st.fmtNotified = Array.from(FMT_NOTIFIED).slice(-50);   // v2.6.5: 未识别日志名提示去重账本（跨重启不重复提示）
        writeIntegrateState(st);
      } catch (e) { /* 忽略 */ }
    }
    __saveStaleNotified = saveStaleNotified;   // ★ §9.11.4-6：供门直调（见模块级 thunk 处说明）
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
      // v2.6.4（L3）：存量悬空指针非阻塞提示——与 health 分离，不参与「验收通过/未过」判定（健康体检可见性问题）
      else if (patch && patch.dangling) { line = "dream 整合提示（非阻塞）：" + patch.dangling; }
      else { return; }
      // v2.5.1(转播可见性): 进展行节流——子代理每次工具调用都会喂一条（L6482），不节流一个 dream 会灌 20~60 行；
      // 每 60 秒最多落一行（首条「已发起」/终态/health 不受限）。
      const _isStepProgress = !!(patch && patch.steps && !terminal);   // v2.5.4(B): running（tStat 非终态、无 steps）不进节流判定，直落 notice 通道
      const _now = Date.now();
      if (_isStepProgress && DREAM_BROADCAST_LAST_AT && _now - DREAM_BROADCAST_LAST_AT < DREAM_BROADCAST_MIN_MS) return;
      DREAM_BROADCAST_LAST_AT = terminal ? 0 : _now;
      // v2.5.1(P2-1/P2-2): 终态文案按 status 差异化——done 才「完成·请核验」；failed/stopped 用「dream 结果·请核验」；
      //   空轮无落盘内容可核验 → 只简报；仅 followup 唤醒路径用核验长文案，inject 回退用短总结（不诱导忙碌回合内自主调工具）。
      let followupMsg = null, injectMsg = null, noticeMsg = null, wakeMsg = null;   // [dream-visible] wakeMsg=手动「已发起」的唤醒投递文案
      if (tStat === "running") {
        // v2.5.4(B): 「已发起」即时回执——纯展示行，零唤醒（followup 会平白开一个核验回合，禁止）；
        //   走 append notice（与进度行同通道），无 append 的旧宿主回退 inject 排队。
        injectMsg = makeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>");
        noticeMsg = makeNoticeMessage("<system-reminder>\n【dsh-memory · dream 进度转播】" + line + "\n</system-reminder>", "dream 进度转播：" + line);
        // [dream-visible 20260930] 手动 dream 的「已发起」改走唤醒投递（见下方 setTimeout 内 wake 分支）：
        //   非唤醒的 append/inject 行在宿主 GUI 里没有实时渲染位（实测：连 `/dream` 命令回执都要等用户
        //   下次发言才被顶进回合）⇒ 用户发了 /dream 看不到任何反馈。唤醒代价 = 一个极短回合，
        //   故提示词硬约束「只回一行、禁止调工具」，并在完成后由既有终态 followup 交付结果摘要。
        wakeMsg = makeMessage("<system-reminder>\n【dsh-memory · dream 已发起】" + line
          + "\n\n这是一条系统通知，不是任务：请**只回一行**确认（例如「已发起 dream 整合（后台跑），完成我再汇报」），"
          + "不要调用任何工具、不要读记忆库或 ~/.dsh/memory/.integrate.json、不要自己再发一次整合。\n</system-reminder>");
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
              noteDreamSurface("wake:followup:terminal");
            } else {
              target.inject(injectMsg);
              noteDreamSurface("inject:terminal");   // [dream-visible] 诊断：正在跑 ⇒ 只能排队，GUI 要等下次发言才可见
            }
            return;
          }
          // [dream-visible 20260930] 手动 dream 的「已发起」走唤醒投递——只此一处（reason 仅由 L11904 那条
          //   running patch 携带，故每次手动 dream 只会唤醒一次，不会随进度行重复开回合）。
          //   正在跑（用户回合进行中）用 steer 落进当前回合；空闲用 followup 开一个极短回合。
          //   两条都不可用（旧宿主）则原样回退下面的 append/inject。
          if (tStat === "running" && wakeMsg && !DREAM_WOKE) {   // [dream-visible] 同步段已唤醒过就不再重复开回合
            if (wakeDreamNotice(target, wakeMsg, "wake")) return;
            // 两条唤醒路都不可用 ⇒ 不改变既有行为，落到下面的 append/inject（诊断字段会记 wake-unavailable）
            noteDreamSurface("wake-unavailable");
          }
          // v2.5.1(转播可见性): 进展行直接落会话表面（surfaceOp:"append"）——宿主 inject 明确「不唤醒」，
          // 空闲会话的排队项在 GUI 里 placement 判为 "context"、无任何渲染位（只渲染 steering/queued），
          // 故进度会一直不可见，直到用户再发一条消息把它顶进回合——这正是「发了 dream 却没有任何广播」的根因。
          // 落表即渲染为 notice 上下文行（折叠态显示 summary），零唤醒、零 LLM 回合；旧宿主无 append 才回退 inject。
          const _block = surfaceAppendBlock(target);   // [400guard 20260927]："" = 可落表；否则 midstep（回合进行中）/ nohead（尚无 system 头）
          if (!_block && target.session && typeof target.session.append === "function") {
            try {
              target.session.append("user/message", noticeMsg, { surfaceOp: "append" });
              noteDreamSurface(_isStepProgress ? "append:step" : "append");   // [dream-visible] 诊断：append 是否真的被接受
            } catch (eA) {
              noteDreamSurface("append-failed", (eA && eA.message) || eA);   // [dream-visible] 原先静默吞掉 ⇒ 无从诊断
              throw eA;
            }
          } else {
            target.inject(injectMsg);
            // [400guard 20260927]：闸子拦下时降级 inject 排队——诊断里带上阻断原因，便于复核闸子有没有生效
            noteDreamSurface(_block ? (_isStepProgress ? "inject:step-" + _block : "inject-" + _block) : (_isStepProgress ? "inject:step" : "inject"));
          }
        } catch (e) {
          noteDreamSurface("inject-after-error", (e && e.message) || e);
          try { if (typeof target.inject === "function") target.inject(injectMsg); } catch (e2) { /* 转播失败不影响主流程 */ }
        }
      }, 0);
    }
    // [dream-visible 20260930 · A] 手动 dream 的唤醒投递：正在跑（用户回合进行中）用 steer 落进当前回合；
    //   空闲用 followup 开一个极短回合；两条都不可用（旧宿主）返回 false，调用方原样回退 append/inject。
    //   实际走的通道一并落进 .integrate.json（tag 前缀区分 ack:* / wake:*），一次 /dream 即可确诊。
    function wakeDreamNotice(agent, msg, tag) {
      let _woke = false;
      try {
        if (agent && agent.status === "running" && typeof agent.steer === "function") {
          try { agent.steer(msg); noteDreamSurface(tag + ":steer"); _woke = true; }
          catch (eS) { noteDreamSurface(tag + ":steer-failed", (eS && eS.message) || eS); }
        }
        if (!_woke && agent && typeof agent.followup === "function") {
          try { agent.followup(msg); noteDreamSurface(tag + ":followup"); _woke = true; }
          catch (eF) { noteDreamSurface(tag + ":followup-failed", (eF && eF.message) || eF); }
        }
      } catch (e) { noteDreamSurface(tag + ":wake-error", (e && e.message) || e); }
      if (_woke) DREAM_WOKE = true;
      return _woke;
    }
    // [dream-visible 20260930 · B] 转播通道落盘：把「这条广播实际走了哪条路」写进
    //   ~/.dsh/memory/.integrate.json 的 progress.surface / surfaceErr，一次手动 /dream 后读一眼即可确诊。
    //   取值：ack:* / wake:* / wake:followup:terminal / inject:terminal / append / append:step /
    //        append-failed / inject / inject:step / inject-after-error / wake-unavailable。
    function noteDreamSurface(channel, err) {
      try {
        const st = readIntegrateState() || {};
        const p = Object.assign({}, st.progress || {}, { surface: channel, surfaceAt: Date.now() });
        if (err) p.surfaceErr = String(err).slice(0, 200);
        else delete p.surfaceErr;
        st.progress = p;
        writeIntegrateState(st);
      } catch (e) { /* 诊断落盘失败不影响转播主流程 */ }
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
      if (!subagentsHasStart(subagents)) {   // v3.2.1：双协议判据（0.1.x start / 0.2.x startActivation）
        cwarn("[dsh-memory] 自动整合：subagents 服务不可用，跳过");
        DREAM_TRACK = null;   // v2.2.4: 清占位防误锁
        DREAM_LISTENER = null;   // v2.4.13(dream-live): 发起失败摘监听
        return false;
      }
      let parent = agentForParent || (agentsBySession.size > 0 ? agentsBySession.values().next().value : null);
      if (!parent || typeof parent !== "object") {
        // 启动时序：agent/created（0.1.6 前叫 agent/session-start）可能还没触发，agentsBySession 未填充 → 延迟 30 秒重试一次
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
        for (const df of ROOT_FILES) {
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
      capacityText += renderOverLimitHint(stI.overLimitHint);   // v2.8.4（A）：**主动预置**差数+分节表（替代"先写再被拒"）
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
"4. **index.md 指针格式（2026-09-27 约定，勿破坏）**：`- 主题（关键词 何时:触发场景）→ 文件`——括号内 `何时:` 右为**触发语**（供模型判断该不该读，插件解析时**不进关键词**），左仍为关键词。新增/改写指针行时**必须保留已有 `何时:` 段**；给新指针补一句触发语更好。压缩 index.md 时**不得删除** `何时:` 段。\n" +
"5. **knowledge 文件可选 frontmatter（2026-09-27，检索会据此重排）**：新建或大改 knowledge/projects 档时，可在文件首行加 YAML frontmatter：`created`（YYYY-MM-DD）、`last_used`（YYYY-MM-DD，每次被检索命中后可更新）、`importance`（1-10，越高越不易被时间衰减埋掉）。**不强制**——缺省时检索按中性处理，行为与旧版一致；已存在的文件**不必回头补**。\n" +
"\n" +
"## Supersede (C 档：冲突/取代一等公民，2026-09-27 新增)\n" +
"发现**同一事实的新旧两个说法**时，禁止静默覆盖或静默删除旧条目（LongMemEval 实测主流系统最常栽的失败模式就是「覆盖旧信息」）：\n" +
"1. 保留旧条目原文，在其**末尾**追加 `（已被 <新位置或新结论> 取代 @YYYY-MM-DD）`；新条目正常写入并保留自己的来源。\n" +
"2. 若旧条目确无价值，也应先标取代再下沉/删除，不要直接抹掉——审计链不能断。\n" +
"3. 同一批内不要「既标取代又删旧条」——二选一。\n" +
"\n" +
"## Verify (D3)\n" +
"写提到的文件路径前用 glob、函数/类名前用 grep 核实存在；无法证实但合理的标 [unverified]；被新决定/新代码推翻的条目标记删除或移除.\n" +
"\n" +
"## Prune (D4: 容量上限 + 修剪过期)\n" +
"1. global/index 若超预算，memory_dream_patch 会现场拒写并回传本次将写成的字符数、差数与分节表——按差数做**整节下沉**一次成型即可，禁止自行估算或对齐任何字符数（选择标准：已稳定决策 > 死胡同 > 历史/完成步骤（## 归档/## 归档：* 命名节内条目优先）> 与当前焦点无关；任何含 knowledge/MEMORY- 引用的指针行（`- See knowledge/…`、`详见 knowledge/…`、`→ knowledge/…` 等措辞均可）不得作为提取对象、提取时保留在主文件）；下沉目标 knowledge/MEMORY-global-<topic>.md（index 用 MEMORY-index-<topic>.md）；主文件删节后尾部插 `- See knowledge/<文件>（N 项）— 一句话摘要`（措辞可同左，验收按存在 knowledge/MEMORY- 引用判定）；同批原子提交；主文件删节变短属合法，replace 须带 full_rewrite:true 或改用「edit 删该节正文 + append 尾部指针」组合）。**禁止以 delete 逐条删内容替代下沉**（delete 仅用于删已标 [unverified] 的过期条目）；章节用 ## 明确分类（便于分区感知注入保留骨架）. 达标由 memory_dream_patch 写时校验判定（v2.4.28），无需自测.\n" +
"2. sessions/当日文件保持精炼要点+指向（当日注入面以不超限为准，超限会被机器测量并强制拉回整合），细节归档 knowledge/ 或对应 project 文件.\n" +
"2c. **index.md 下沉判据（2026-09-27 约定；只定「挑谁」，不新增触发条件）**：本节**仅在**你已因 index.md 超预算被拒写、要按差数下沉时适用。挑节优先级改为「**低频优先**」，按下述机械判据从上往下挑、够差数即停（不要挑整节之外的内容）：\n" +
"   ① 行内**同时**满足「无 `何时:` 触发语」且「`/` 分隔的子主题罗列 ≥3 个」的指针段（信息密度最低、最可折叠）；\n" +
"   ② 长尾工具类（`tools/` 下单一用途脚本，如录屏/打卡/剪贴板类）；\n" +
"   ③ 其余低频主题。\n" +
"   **禁止下沉**：带 `何时:` 触发语的行（那是路由核心）、`knowledge/MEMORY-dsh-memory-*`（自指）、`projects/dsh-memory记忆插件.md`。\n" +
"   落点固定为 `knowledge/MEMORY-index-低频索引.md`（**不要**新建 `MEMORY-index-<topic>.md` 碎片档），在其内按日期分节追加原样指针；index.md 被下沉的节位置插一行汇总指针 `- <主题列表> → 见 低频索引`。\n" +
"   ⚠ **不要**因为「接近 1800 软告警线」就主动下沉——近限带不进候选判定，主动动会变成每轮空转；近限只由插件告警提示，处理时机以**硬超限被拒写**为准。\n" +
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
"- **指针闭合硬校验（v2.6.4）**：本批**新增**的任何库内指针（`See|详见|参见|参考|见|→ knowledge/…|projects/…|tools/…|sessions/….md` 等措辞）都必须**同批写入目标**或**指向已存在文件**，否则整批拒写并回传「指针指向未落盘文件 X」。这正是「指针先行、落盘未成功」的事故形态，故不再允许；确系复述描述（如事故记录里逐字引用一个未落盘文件名）时该行须含「未落盘/待补/不存在」等描述词自动豁免，或整批带 `allowDangling:true` 显式放行。\n" +
"- 不要输出 JSON 文本/代码块；一切写入只走 memory_dream_patch 工具.\n" +
"- **看护续期纪律（v2.6.1 根因修复，v2.6.4 收紧）**：本子代理受 15 分钟软警告/25 分钟硬停看护（计时自最近落盘或任意工具活动；无落盘工具活动累计 24 次同样进入 3 分钟宽限）。**组装大 patch 前先落一条最小成功 patch 续期**——但续期的必须是**内容类** patch（如 append/edit 一个 knowledge 小文件的**正文**、或 edit 一个已存在文件的局部），成功落盘即重置计时；**严禁把「指针行」单独落盘续期**（v2.6.4 起 memory_dream_patch 会直接拒写指向未落盘文件的指针：指针必须与其目标同批，见 5.；若确需先落指针，该指针只能指向**已存在**的文件）。巨型 replace 优先「edit 删节 + append 指针」组合（见 Prune）而非整文件全文回传。禁止「只读/只预览、长时间不落盘」的组装方式——会被看护硬停（本次事件教训：停在组装大 patch 的冒号前被 15 分钟硬杀）。\n" +
"\n" +
"\n" +
"## Efficiency\n" + "- 文件长度一律由插件机器测量并写时校验（v2.4.28）；**禁止手工数/估字符数**；输出长度机器裁决：超限重试时按差数做整节下沉，一次成型，不必对齐任何数字.\n" + "- **局部修改优先 action:\"edit\"**（old_string/new_string），避免整文件 replace 造成误覆盖；不确定改动范围时先 read 该文件全量再定位精确 old_string（v2.5.0）.\n" +
"- dry-run 预算：每个文件 memory_size_preview 最多 3 次；第 4 次起（10 分钟滑动窗内）工具直接拒绝并回传本次将写成的字符/差数/分节表——按该差数做整节下沉一次成型提交，不要再用 preview 试探.\n" +
"- 同一文件预算类拒写 ≥2 次：放弃该文件，先落盘其他内容（可最后回头一次，不允许无限迭代）。放弃时**不得留下指向未落盘目标的指针**——要么把目标文件与指针同批写入，要么不写指针（v2.6.4 起工具层会拒写新增悬空指针）。\n" +
"- 不要花步骤试探运行时能力——本节已给出全部事实.\n" +
"\n" +
"- 每个文件 edit 前先 read 全量（禁止局部读+整体覆写）；不更新 global/index 的时间戳行（保前缀缓存）;\n" +
"- 只动 ~/.dsh/memory/ 目录；不读/不依赖原始大日志;\n" +
"- 保留 source session 引用便于追溯.\n" +
"\n" +
"## D-threshold Self-Calibration（D类「LLM循环试错提醒」阈值自校准）\n" +
"- 实测统计（插件已算好，直接引用，勿自行读取文件或计算数字）：" + calibStats + "\n" +
"- ⛔ **本节的旧判据已废止（v3.2.0）**：禁止再用「repRate 中位数 ≤ 当前 rep+0.05 → rep 上调」——`spiralEvents` **只在命中时落盘**（截断偏差）、且存的是四舍五入值 ⇒ 该判据**恒真**；实测它把 rep 单向推到硬上限 0.80 并造成 D 类自 2026-09-29 静默 2 天+（17 条变更日志里 6 条同一理由）。\n" +
"- 现行口径（证据分级，缺证据就别动）：① **先看 `gateEvents`**——若 `cls=\"D\"` 且 `reason` 属 {`cooldown`,`batch-cooldown`,`off`}（或旧口径 `batch`）的计数高、而 `ok`/`batch-soft` 极少，那是**闸门**问题而非阈值问题，**不要调阈值**（`batch-soft` = 已降级投递，是正常产出）；② 仅当「连续多轮 0 次 D 命中」且 `gateEvents` 连被拦记录都没有（=压根没触发判定）时，才允许**提敏**（rep 下调，步长 ≤0.05 且必须跨 k/winLen 格点）；③ 样本必须**同世代**（只统计 `ep` 与当前生效值全等的那些，见 `spiralThreshLog[].ep`），跨世代样本一律不计；④ **降敏一律要求 ≥12 字且含数字的 reason**，并受插件方向性硬闸限制（同字段 24h≤1 次、24h 内不得跨字段换旋钮、近 24h 有拦截且 0 投递时直接拒绝）。各字段合法范围见 dsh_spiral_thresh 工具描述。\n" +
"- 应用变更只准调用 dsh_spiral_thresh 工具并带 reason 参数（一句话理由，插件侧钳制校验+落盘+记变更日志；禁止直写 .monitor.json——会被插件内存态覆盖）.\n" +
"- 无需调整就不调用工具。最终 Output 加一行 Thresholds: kept/changed + 一句理由.\n" +
"## E-loop Self-Calibration（E类「成功同质循环」阈值自校准，v2.4.30）\n" +
"- 实测统计（插件已算好，直接引用）：" + eCalibStats + "\n" +
"- ⛔ **「E 触发周期占比」判据已废止（v3.2.0）**：`turnProfiles` 的分母**系统性缺失**（`settleTurnProfile` 只在顶层会话 step1 的 A 类 handler 里结算 ⇒ 子代理周期永不结算、未续话的顶层周期也不结算；实测近 200 条画像里 D 命中样本 ≥6 条却只有 2 个周期）⇒ 任何「占比高/低」的推断都不成立。\n" +
"- 现行口径：只在**样本充分**（同世代 E 样本 ≥5 条）时，按瓶颈动刀——实测 E 的两个瓶颈是 `sameMinSecs`（簇墙钟）与**借用 D 的 rep 闸**，`sameHomo`/`sameSteps`/`sameNeg` **都不是瓶颈**（再收紧只会更死）；提敏（`sameMinSecs` 下调等）不受硬闸限制，降敏受 §D 同款 R5/R6/活跃字段锁约束。\n" +
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
        const run = await startSubagentCompat(subagents, {   // v3.2.1：兼容 0.1.x/0.2.x
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
            // v3.2.2（2026-10-18）：把"死于什么"打进同一行——stopReason 只是 error/aborted 这类枚举，
            //   真实原因（如 429 额度、鉴权、上下文超限）只在子会话的 turn/end.reason.error 里。
            let _fail = null;
            if (result.stopReason && result.stopReason !== "completed") {
              const _fdir = findNewestSpawnedSession(startedAt);
              _fail = _fdir ? readSubagentFailure(_fdir) : null;
            }
            const _failTxt = (_fail && _fail.message)
              ? "，失败原因=" + String(_fail.message).slice(0, 300) + (_fail.code ? "（code=" + _fail.code + "）" : "")
              : "";
            clog("[dsh-memory] 自动整合完成（" + reason + "，stopReason=" + result.stopReason + ", 输出 " + outText.length + " 字符" + _failTxt + "）");
            if (_fail && /QUOTA|429|usage limit|额度|余额/i.test((_fail.code || "") + " " + (_fail.message || ""))) {
              cwarn("[dsh-memory] 整合子代理被**模型额度**拦住（" + String(_fail.message).slice(0, 200) + "）——这不是记忆库或插件故障：换一个有额度的模型，或等额度恢复后再 /dream；本轮未落盘，2 小时自动重试大概率同样失败。");
            }
            let u = null;
            const sdir = findNewestSpawnedSession(startedAt);
            if (sdir) {
              u = await summarizeSubagentUsageRetry(sdir);   // §9.12④：同上（读不到 usage 时有界重试）
              if (u) clog("[dsh-memory] 整合消耗: 总输入 " + (u.totalIn || u.input) + " tokens（其中缓存命中 " + u.cache + "）| 输出 " + u.output + (u.reasoning > 0 ? " | 推理 " + u.reasoning : "") + " tokens | 总时长 " + u.durMin + " 分钟" + (u.usageEmpty ? "（⚠️ usage 读取失败：重试 " + u.usageRetry + " 次仍无 usage，**别当成 0 消耗**）" : ""));
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
                tokens: (u && u.usageEmpty !== true) ? ("totalIn " + (u.totalIn || u.input) + " (cache " + u.cache + ") / out " + u.output) : null,
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
                        if (canSurfaceAppend(settleListener) && settleListener.session && typeof settleListener.session.append === "function") settleListener.session.append("user/message", smsg, { surfaceOp: "append" });
                        else if (typeof settleListener.inject === "function") settleListener.inject(makeMessage(_sbody));   // [400guard 20260927]：中途落表会打断 tool_calls/tool 配对 ⇒ 降级 inject 排队
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
              for (const df of ROOT_FILES) {
                try {
                  const dt = fs.readFileSync(portable(MEMORY_ROOT + "/" + df), "utf8");
                  // v2.6.7（W1）：原为硬编码第二真源（global 3000 / index 2000）且比较符 `>=`——把「恰好 == 硬预算」
                  //   这一**合规态**（sectionAwareSlice 在 <= 时不截断、checkSizeOverflow 亦用 `>`）误判为未达标；
                  //   统一走 limitOf（同一真源）+ `>` 比较符。
                  const lim = limitOf(df, CHAR_LIMIT);
                  if (dt.length > lim) health.push(df + " " + dt.length + "字符未达精简目标(≤" + lim + ")");
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
                // ═══ v2.8.4（容量治理·硬保证）：**机械下沉**触发 ═══
                // 破的死循环（实测 2026-09-18）：验收每轮报"仍超限…**下次整合优先提取**"，而那句"下次优先"只是
                //   **字符串拼接**；模型那条"整节下沉"引导挂在「patch **被拒写**」事件上，实况却是"**本轮未写**"
                //   ⇒ 引导永不触发；维护两次无进展即停手（stuck=infeasible）；注入端 hard-cut 兜着 ⇒ 没人真正缩小文件。
                // ⇒ 这里给"**连续 2 轮超限 ∧ 本轮未写**"的文件一个**不依赖模型判断**的执行者，并把轮数与动作记账（读者见心跳行）。
                try {
                  const wrSet0 = DREAM_WRITTEN_RELS || new Set();
                  const overList = [];
                  for (const pcc of listProjectChars()) if (pcc.chars > PROJECT_CHAR_HARD) overList.push({ rel: pcc.rel, chars: pcc.chars, limit: PROJECT_CHAR_HARD, target: PROJECT_CHAR_SOFT });
                  try {
                    const so2 = await checkSizeOverflow();
                    for (const i9 of (so2 || [])) {
                      if (!i9.truncated) continue;
                      const relS = (String(i9.label || "").match(/(\d{4}-\d{2}-\d{2}\.md)/) || [])[1];   // 摘要的 label 形如「最近摘要 2026-09-18.md」
                      if (relS) overList.push({ rel: "sessions/" + relS, chars: i9.chars, limit: i9.charLimit, target: Math.round(Number(i9.charLimit) * 0.8), key: i9.key });
                    }
                  } catch (eS) {}
                  if (overList.length) {
                    const stO = readIntegrateState() || {};
                    let hintObj = Object.assign({}, stO.overLimitHint || {});   // v2.8.4（A）：喂下一轮的差数/分节表
                    const stuck = Object.assign({}, stO.overLimitStuck || {});
                    for (const e of overList) {
                      const prev = stuck[e.rel] || {};
                      const notWritten = !wrSet0.has(e.rel);
                      const rounds = notWritten ? (Number(prev.rounds) || 0) + 1 : 0;   // 本轮写了 ⇒ 清零（滞回，防抖动）
                      stuck[e.rel] = { rounds: rounds, lastAt: Date.now(), lastChars: e.chars, limit: e.limit, lastAction: String(prev.lastAction || "") };
                      // v2.8.4（A）：本轮写了 ⇒ **清掉**该文件的提示；仍超限 ⇒ 记下**差数 + 分节表**供下一轮直接下沉。
                      //   ★ §9.11.4-7 修正（红队 rev8b E-2：`delete` 会被逐路径并账复活；红队 rev8c B①：写侧不能只有源码正则看门）
                      //   ⇒ 语义收敛到模块级**纯函数** `applyOverLimitHintEntry`（门按输出直测），这里只负责接线。
                      // ★ 修正七（红队 rev8d A）：由 `if/else` 收敛为**单次无条件调用**，把"清还是记"压成一个表达式
                      //   （接线面越小越不容易被等价改写绕过；**注意**：接线层仍只有源码 lint —— 端到端需要一个真 dream 轮，
                      //    本轮**如实豁免**，见 `_test-matrix.mjs` 里 `hint-callsite-if-false` 的豁免记录）。
                      {
                        let secs = [];
                        if (rounds !== 0) {
                          // ★★ v3.0.1（**定版后核验实测发现的真缺口**）：原先写死 `sectionTableOf(…, 12)`
                          //   ⇒ **只入库前 12 节**，第 13 节起**永久不进 hint**。
                          //   实测：`projects/徕卡一瞬.md` 有 **21 节** ⇒ dream **看不到后 9 节 / 20098 字符（17%）**；
                          //   而被截掉的恰是**最新的一批**（10:46–13:40 的 v12/v13/v14 交付记录）= **当前最相关的内容**。
                          //   ⇒ 改法：**生成侧不截断**（传 0 ⇒ `sectionTableOf` 按其语义取默认上限 15 仍会截，
                          //     故这里显式传一个足够大的值），把"要不要少给"这件事**只留给渲染侧**做
                          //     （渲染侧仍保 `slice(0, 30)` 防 prompt 爆）—— 信息**入库不丢**、**渲染有界**。
                          //   ★ 为什么不信"默认 15 够用"：`sectionTableOf` 的默认是 15，而现场已有 21 节的真实文件。
                          try { secs = sectionTableOf(fs.readFileSync(portable(MEMORY_ROOT + "/" + e.rel), "utf8"), 200).map((s) => ({ title: s.title, chars: s.chars, preferExtract: SINK_PREFER_RE.test(String(s.title || "")) })); } catch (e0) {}
                        }
                        hintObj = applyOverLimitHintEntry(hintObj, e.rel, rounds === 0 ? null : { chars: e.chars, limit: e.limit, target: e.target, overBy: Math.max(0, e.chars - e.target), sections: secs, at: Date.now() });
                      }
                      if (rounds >= 2) {
                        const rr = sinkOverLimitFile(e.rel, { target: e.target });
                        stuck[e.rel].lastAction = rr.ok ? ("sink:" + rr.movedCount + "节/" + rr.movedChars + "字→" + rr.sinkRel) : ("sink-skip:" + rr.why);
                        if (rr.ok) {
                          health.push(e.rel + " **已机械下沉**：" + rr.before + "→" + rr.after + " 字符（搬走 " + rr.movedCount + " 节 → " + rr.sinkRel + "）");
                          cwarn("[dsh-memory] 机械下沉 " + e.rel + "：" + rr.before + "→" + rr.after + " 字符，搬 " + rr.movedCount + " 节 → " + rr.sinkRel);
                          try { monitorEvent("sink", e.rel + " moved=" + rr.movedCount + " chars=" + rr.movedChars); } catch (e4) {}
                        } else {
                          cwarn("[dsh-memory] 机械下沉未执行 " + e.rel + "（" + rr.why + "）");
                        }
                      } else if (rounds === 1) {
                        health.push(e.rel + " 连续 " + rounds + " 轮超限未写（再 1 轮将自动机械下沉，不再只报「下次优先」）");
                      }
                    }
                    stO.overLimitStuck = stuck;
                    stO.overLimitHint = hintObj;
                    writeIntegrateState(stO);
                  }
                } catch (eS1) { try { cwarn("[dsh-memory] 机械下沉环节异常: " + (eS1 && eS1.message)); } catch (e5) {} }
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
              // v2.7.0（拆 fixed）：原「耐久层 fixed.md 被删减 → health 留痕」整段（含 `dreamSnap["fixed.md"]` 判空、
              //   `wrSet9.has("fixed.md")` 守卫、净减 ≥40 判定与 TypeError 防线）已随该层删除——层不存在则判据无对象。
              // v2.6.4（L3）：悬空指针反向核对（指针 → 目标存在）——补 L1 只覆盖 memory_dream_patch 的缺口
              //   （maint/archive/命令等旁路写入入口，以及历史存量）。分级（2026-09-15 诊断第三节）：
              //   「本轮写入」= 源文件在本轮落盘清单内，**或**其 mtime 晚于本轮起始（后者覆盖旁路入口/直接写盘）；
              //     → 计入 health（阻塞验收，本轮该修）；
              //   其余（历史存量，本轮没碰它）→ 只作**非阻塞**提示（dangling 字段），否则存量悬空会永久卡死
              //     「验收通过 → health 清空」分支，每轮转播挂同一条告警（v2.4.35 记录过的过期告警形态）。
              //   注：L1 生效后 dream 侧新增悬空已被写时拒，本闸主要价值在旁路入口 + 存量可见性（防复发）。
              let danglingLegacyTxt = "";
              try {
                const wrD = DREAM_WRITTEN_RELS || new Set();
                const allD = scanDanglingPointers();
                const mtimeOf = (rel) => { try { return fs.statSync(portable(MEMORY_ROOT + "/" + rel)).mtimeMs; } catch (e) { return 0; } };
                const isThisRound = (d) => wrD.has(d.src) || mtimeOf(d.src) >= startedAt;
                const mineD = allD.filter(isThisRound);
                const legacyD = allD.filter((d) => !isThisRound(d));
                for (const d of mineD) {
                  health.push("悬空指针：" + d.src + " → " + d.rel + "（目标不存在；本轮写入）——把目标内容与指针放同一批写入，或改指实存文件（已轮转会话指 sessions/archive/…）");
                }
                if (legacyD.length) {
                  danglingLegacyTxt = "存量悬空指针 " + legacyD.length + " 处（非本轮写入，不阻塞验收）：" + legacyD.slice(0, 3).map((d) => d.src + " → " + d.rel).join("；") + (legacyD.length > 3 ? " 等" : "");
                }
              } catch (eL3) { cwarn("[dsh-memory] L3 悬空指针核对异常（跳过该闸）: " + (eL3 && eL3.message ? eL3.message : eL3)); }
              // ═══ v2.6.8（P4 / 提案③）未沉淀清单：只读、非阻塞、不自动动作 ═══
              //   不进 health（不阻塞验收）；沿用 danglingLegacyTxt 这条「非阻塞可见性」通道一并转播。
              //   水位账本落**独立点文件** .deposit-watch.json——不碰 .integrate.json，避免与 dream 结算双写互相覆盖
              //   （工程席审核：L7018 与 L8774 都写 .integrate.json，新字段必须走同一 read-modify-write，独立文件更稳）。
              try {
                const dw = scanUndeposited({ days: 14 });
                if (dw && dw.ok && dw.items.length) {
                  const st2 = updateDepositWatch(dw.items);
                  const txt2 = "重要但未沉淀 " + dw.items.length + (dw.truncated ? "+（已达扫描上限）" : "") + " 条（新增 " + st2.fresh + "，滞龄 >21 天 " + st2.aged + "）"
                    + (st2.fresh ? "；例：" + dw.items.slice(0, 2).map((x) => x.lit.slice(0, 36) + "（" + x.src + "）").join("；") : "")
                    + "——只读报告，不自动下沉；可用 memory_search 检索或手工提升";
                  danglingLegacyTxt = danglingLegacyTxt ? (danglingLegacyTxt + "；" + txt2) : txt2;
                }
              } catch (eDW) { cwarn("[dsh-memory] 未沉淀清单扫描异常（跳过）: " + (eDW && eDW.message ? eDW.message : eDW)); }
              // v2.6.4（L3 可见性修复）：health 转播此前**从未送达**——done 转播后 L8346 已把 DREAM_LISTENER 置 null，
              //   rebroadcastDream 的 patch.health 分支因此永远短路（验收结论只落在 .integrate.json，会话里看不见）。
              //   仿 v2.4.16 回归结算通道，用 settle 前捕获的 settleListener 落一条 notice（无监听=定期/自动整合轮，不打扰）。
              const noticeSettle = (text) => {
                if (!text || !settleListener) return;
                const body = "<system-reminder>\n【dsh-memory · dream 整合提示】" + text + "\n</system-reminder>";
                const msg = makeNoticeMessage(body, ("dream 整合提示：" + text).slice(0, 140));
                setTimeout(() => {
                  try {
                    if (canSurfaceAppend(settleListener) && settleListener.session && typeof settleListener.session.append === "function") settleListener.session.append("user/message", msg, { surfaceOp: "append" });
                    else if (typeof settleListener.inject === "function") settleListener.inject(makeMessage(body));   // [400guard 20260927]：中途落表会打断 tool_calls/tool 配对 ⇒ 降级 inject 排队
                  } catch (e) {}
                }, 0);
              };
              if (health.length) {
                cwarn("[dsh-memory] 整合验收未过: " + health.join("; ") + "——下次整合优先处理");
                // v2.6.4：health 串会被截到 200 字符转播，存量悬空清单另存 dangling 字段保完整（不参与验收判定）
                if (DREAM_PATCH) DREAM_PATCH({ health: (health.join("; ") + (danglingLegacyTxt ? "；另有" + danglingLegacyTxt : "")).slice(0, 200), dangling: danglingLegacyTxt });
                noticeSettle("整合验收未过：" + (health.join("；") + (danglingLegacyTxt ? "；另有" + danglingLegacyTxt : "")).slice(0, 260));
              } else if (dreamSnap["global.md"]) {
                clog("[dsh-memory] 整合验收通过: global/index 容量与时间戳行合规" + (danglingLegacyTxt ? "（另有" + danglingLegacyTxt + "）" : ""));
                // v2.4.35（评审 S3）：验收通过必须清 progress.health 旧值——否则上一轮的过期告警永久挂在
                //   .integrate.json/转播里误导用户（实证 2026-09-07：本轮全部达标，health 仍显示上轮「2119≥1500」）。
                //   Object.assign merge 语义下空串覆盖即清除；rebroadcastDream 对 falsy health 短路不转播空话。
                // v2.6.4：dangling 同批刷新（空串=清除），存量悬空只走非阻塞转播，绝不进 health。
                if (DREAM_PATCH) DREAM_PATCH({ health: "", dangling: danglingLegacyTxt });
                noticeSettle(danglingLegacyTxt ? "整合验收通过；" + danglingLegacyTxt : "");   // v2.6.4：存量悬空非阻塞可见性
              } else if (danglingLegacyTxt && DREAM_PATCH) {
                DREAM_PATCH({ dangling: danglingLegacyTxt });   // 无快照档的非正常轮：也把存量悬空提示落出去
                noticeSettle(danglingLegacyTxt);
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
            // v3.1.0（A 次挂点）：dream 结算后顺带刷新检索索引（异步、不 await、异常不外泄）；
            //   此刻 settleListener 仍在作用域 ⇒ 真建了才播报一行（自动/定期轮恒静默）。
            try { void refreshSearchIndex({ reason: "dream-settle", listener: settleListener }); } catch (e) {}
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
        }).finally(() => { try { void refreshSearchIndex({ reason: "dream-settle-fallback" }); } catch (e) {} });        // v2.2.4: DREAM_TRACK 占位已上移至 runDreamPipeline 入口（同步段），此处不再重设（避免刷新心跳基准）
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
      // v2.6.5（用户拍板）：手动 /dream 不吃 settings.staleSessionDays——改固定活跃下限 30 分钟
      //   （只挡仍在写入的活跃会话，含发起会话本身）；自动定时整合仍按 settings 天数。
      const isManual = reason === "手动";
      const busyMsg = dreamBusyCheck();   // v2.2.4: 在途互斥检查（仍在同步段，双发窗口封死）
      if (busyMsg) {
        cwarn("[dsh-memory] dream 管线拒绝发起（" + reason + "）：" + busyMsg + "——已有整合在跑，等完成后再试");
        monitorEvent("integrate", "busy-rejected reason=" + reason + " (" + busyMsg + ")");
        return { ok: false, busy: true, msg: busyMsg };
      }
      DREAM_TRACK = { since: Date.now(), sessionId: null, steps: 0 };   // v2.2.4: 占位提前到同步段（原赋值在 await subagents.start 之后，快速连发存在双发窗口）
      const _gen = DREAM_TRACK;   // v2.5.4(B): 代际引用——后台清理只在仍属本轮时执行，防误清下一轮占位
      DREAM_BROADCAST_LAST_AT = 0;   // v2.5.1(转播可见性): 每轮重置节流水位——新 dream 的首条进度必落表
      DREAM_WOKE = false;            // [dream-visible 20260930] 每轮重置唤醒水位（本轮是否已用唤醒投递过发起行）
      // v2.4.13(dream-live): 手动 /dream 才设监听会话（后台子代理照旧），进度实时转播回去；定期自动整合不打扰任何会话。
      // v2.5.1(转播可见性): 可用条件放宽——inject（旧注入路径）或 session.append（新落表路径）任一即可。
      DREAM_LISTENER = (agentForParent && (typeof agentForParent.inject === "function" || (agentForParent.session && typeof agentForParent.session.append === "function"))) ? agentForParent : null;
      // [dream-visible 20260930] 同步段即时回执（关键时序）：归档阶段位于 spawnIntegrate 之前、可能耗时数分钟，
      //   原先「已发起」要等 spawnIntegrate 里那条 running patch 才发出 ⇒ 用户 /dream 后长时间毫无反馈。
      //   这里在命令受理的那一刻就唤醒一行（steer/followup），并置 DREAM_WOKE ⇒ 后续 running patch 不再重复开回合。
      //   只手动走这里：自动/定期整合传的是 agentForParent=null（见 checkIntegrate → runDreamPipeline("定期", null)），
      //   那时 DREAM_LISTENER 为空，条件不成立，不打扰任何会话。
      try {
        if (isManual && DREAM_LISTENER && !DREAM_WOKE) {
          wakeDreamNotice(DREAM_LISTENER, makeMessage("<system-reminder>\n【dsh-memory · dream 已发起】已发起 dream 管线（后台执行中，" + reason + "）：漏网会话先归档（silent 自动，其他模式待你确认）→ 接续整合全部摘要。进度随时转播，完成给结果摘要。\n\n这是一条系统通知，不是任务：请**只回一行**确认，不要调用任何工具、不要读记忆库、不要自己再发一次整合。\n</system-reminder>"), "ack");
        }
      } catch (eAck) { /* 即时回执失败不影响管线 */ }
      void (async () => {   // v2.5.4(B): 归档→整合整段后台化
        try {
          ensureStaleNotified();
          let note = "";
          try {
            // v2.6.5: 手动 = 活跃下限 30 分钟（忽略 settings 天数）；自动 = settings 天数
            const scanDays = isManual ? (MANUAL_STALE_MIN_IDLE_MS / 86400000) : PLUGIN_CFG.staleSessionDays;
            const scanPending = () => findStaleSessions(scanDays, getEnabledAt(), true)   // v2.5.4(C): force 绕 TTL 缓存，归档清单必须现扫
              .filter((s) => shouldReArchive(s, reArchiveOpts()));   // v2.8.4（P13/P15）：单一谓词（水位重入 + 掐断续跑 + 可选旁路）
            let pending = scanPending();
            if (ARCHIVE_WM_DIRTY) { saveStaleNotified(); ARCHIVE_WM_DIRTY = false; }
            if (PLUGIN_CFG.staleAction === "silent" && pending.length > 0) {
              clog("[dsh-memory] dream 管线: 先归档 " + pending.length + " 个漏网会话，完成后自动接续整合");
              let r = await runStaleArchive(pending);   // v2.4.7.1: r.ok=已发起，r.done=结算链（resolve 处置字符串）
              // v2.6.6（撞车兜底，用户拍板）：会话启动时的 silent 自动归档与手动 /dream 常同刻相撞，此时本函数被
              //   STALE_RUNNING 防重入拒（r.ok=false）。旧行为直接跳到 spawnIntegrate → 归档与整合并行、
              //   「先归档后整合」静默失效（实证 2026-09-16 17:06:17→19）。改为：等在跑的归档结算完 → 重扫剩余 → 补一轮。
              if (!r.ok && STALE_ACTIVE_DONE) {
                clog("[dsh-memory] dream 管线: 已有归档在跑（" + r.reason + "），等其结算后再补一轮归档");
                await Promise.race([STALE_ACTIVE_DONE, new Promise((res) => setTimeout(() => res("timeout"), DREAM_ARCHIVE_WAIT_MS))]);
                pending = scanPending();   // 结算已写账本 → 此处拿到的是「剩余未归档」
                if (pending.length > 0) r = await runStaleArchive(pending);
                else note = "已有归档已收走全部候选 → ";
              }
              if (r.ok && r.done) {   // 消号 v1.12.19.1 起在子代理完成回调内执行
                const flag = await Promise.race([r.done, new Promise((res) => setTimeout(() => res("timeout"), DREAM_ARCHIVE_WAIT_MS))]);
                note = "本轮归档 " + r.count + " 个候选漏网会话（口径 " + (isManual ? "手动·30 分钟活跃下限" : "自动·" + PLUGIN_CFG.staleSessionDays + " 天") + "，" + flag + "）→ " + note;
              } else if (!r.ok) {
                note = "归档未发起（" + r.reason + "）→ ";
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
        // v2.8.4（自动归档包）：静默自动归档 —— 与 checkIntegrate **各自 try/catch**，任一抛不连坐；
        //   本行**只调归档 tick**，不调 runDreamPipeline ⇒ 整合层仍守 integrateDays（用户裁决 + 根因席划线）。
        try {
          const p = runStaleSilentTick(Date.now());
          if (p && typeof p.catch === "function") p.catch((e) => { try { monitorEvent("archive", "auto-tick-throw " + (e && e.message ? e.message : String(e))); } catch (e2) {} });
        } catch (e) { try { monitorEvent("archive", "auto-tick-sync-throw " + (e && e.message ? e.message : String(e))); } catch (e2) {} }
        // v3.1.0：索引自动刷新（主挂点）—— 异步 fire-and-forget，**不 await**（await 会把本 tick 串行化）；
        //   与上面几段各自 try/catch，任一抛不连坐。
        try {
          const pr = refreshSearchIndex({ reason: "hourly-tick" });
          if (pr && typeof pr.catch === "function") pr.catch((e) => { try { monitorEvent("search-index", "refresh-throw"); } catch (e2) {} });
        } catch (e) { try { monitorEvent("search-index", "refresh-sync-throw"); } catch (e2) {} }
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

    // [logpane 20260930] /memory-panel —— 在系统默认浏览器打开记忆统计面板（含「本次启动以来」的实时日志）。
    //   为什么不走设置页链接：桌面窗口源是 dsh-app://app，页面里对 /dsh-memory/* 的 fetch 到不了插件路由
    //   （协议处理器只服务 app 文档/资源，其余落 400），`<a target="_blank">` 又被 Electron 的
    //   setWindowOpenHandler 拦掉 ⇒ 只能由宿主进程自己拉起浏览器（宿主知道 PANEL_PORT）。
    //   命令由宿主执行、不经页面 origin，故 web 端与桌面端同样可靠；回执里带 URL 便于手动复制。
    try {
      if (ctx.commands && typeof ctx.commands.register === "function") {
        ctx.commands.register({
          name: "memory-panel",
          description: "在系统默认浏览器打开 dsh-memory 记忆统计面板（统计 + 本次启动以来的插件实时日志）。无需参数。",
          handler: async () => {
            // v3.1.1 修复：旧实现直接用注册期快照 PANEL_PORT，桌面端实测拿到 0 ⇒ URL 变
            //   http://127.0.0.1:0/dsh-memory/stats ，浏览器打开了但必然 400/连不上。
            //   现在①触发时实时向服务句柄要 port（快照仅兜底）②先探活面板路由，探不到就如实报错并给排查指引。
            const livePort = (() => {
              try { const p = PANEL_WSRV && Number(PANEL_WSRV.port); if (p) return p; } catch (e) { /* 句柄失效走快照 */ }
              return Number(PANEL_PORT) || 0;
            })();
            if (!livePort) {
              return { kind: "error", text: "面板端口不可用（webServer 服务未就绪或本进程无 Web 服务）。\n"
                + "• 桌面端/Web 端：确认 DSH 已完整启动（设置页--插件--dsh-memory 应显示「统计面板已挂载」）。\n"
                + "• CLI/headless：本模式没有 Web 服务，面板不可用属预期。\n"
                + "排查：看本次启动日志里 [dsh-memory] 统计面板已挂载 / webServer 注入失败 两行。" };
            }
            const url = "http://127.0.0.1:" + livePort + "/dsh-memory/stats";
            // 探活：确认插件路由真在监听（服务在但路由没挂上时，浏览器会开出 404 页面——旧实现照样报"已打开"）
            let reachable = false;
            try {
              reachable = await new Promise((resolve) => {
                let done = false;
                const fin = (v) => { if (!done) { done = true; resolve(v); } };
                try {
                  const req = http.get(url, { timeout: 2500 }, (res) => { res.resume(); fin(res.statusCode >= 200 && res.statusCode < 400); });
                  req.on("error", () => fin(false));
                  req.on("timeout", () => { try { req.destroy(); } catch (e0) {} fin(false); });
                } catch (e0) { fin(false); }
              });
            } catch (e0) { reachable = false; }
            let ok = false, err = "";
            if (reachable) {
              try {
                execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, (e) => { if (e) cwarn("[dsh-memory] 拉起浏览器失败:", e.message); });
                ok = true;
              } catch (e) { err = String((e && e.message) || e); cwarn("[dsh-memory] 拉起浏览器失败:", err); }
            } else {
              err = "面板路由探活失败（HTTP 无响应/非 2xx-3xx）";
              cwarn("[dsh-memory] /memory-panel 探活失败：" + url);
            }
            return ok
              ? { kind: "success", text: "已在系统默认浏览器打开记忆统计面板： " + url + "\n（面板含「本次启动以来」的插件实时日志；打不开就手动复制这个地址）" }
              : { kind: "error", text: "打开面板失败：" + err + "\n面板地址： " + url + "\n（可手动复制该地址到浏览器；若仍打不开，看日志里 [dsh-memory] 统计面板路由注册失败/统计面板已挂载 两行定位）" };
          }
        });
      } else {
        cwarn("[dsh-memory] commands 服务不可用，/memory-panel 命令未注册");
      }
    } catch (e) {
      cwarn("[dsh-memory] /memory-panel 命令注册失败:", e && e.message ? e.message : String(e));
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
    clog("[dsh-memory] 就绪 v" + PLUGIN_VERSION + "（构建 " + SELF_FP + "）· ★本行配置值 = **默认层**（cordis base）；用户配置/用户文件覆盖后的真值见「生效配置」行（启动时它在上一条；运行期改动会再报一次）—— 两者不一致时以那行为准：staleSessionDays=" + PLUGIN_CFG.staleSessionDays
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

    // v2.8.4（P18/自动归档包⑤）：自动归档**启动自检** —— 上一进程的 tick 结论 + 内容见证在每次启动露一次面。
    //   与心跳行的分工：心跳行只在字段变化时推送（重启后可能半天不出现）；本行保证"一重启就看得见上次干了什么"。
    //   成本：**只进插件控制台（clog），不进模型上下文** ⇒ 零 token。
    setTimeout(() => { try { clog("[dsh-memory] 自动归档自检：" + archiveSignalLine()); } catch (e) {} }, 3200);

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
