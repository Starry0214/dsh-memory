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
//  - F1 注入守卫：稳定层/摘要注入与 A 类提醒改仅顶层会话——子代理收到【上次会话摘要】触发 ghost 第二轮，run.result 拿到跑题输出覆盖正解（55005cd4 转写实证）
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
const PLUGIN_VERSION = "2.4.0";
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
    const tmp = portable(ONBOARD_FILE) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, portable(ONBOARD_FILE));
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
function sectionAwareSlice(text, budgetChars, fileLabel) {
  if (!text) return { text: "", truncated: false, total: 0 };
  if (text.length <= budgetChars) return { text, truncated: false, total: text.length };
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
  // 骨架：文件头 + 所有章节标题
  const skeletonParts = [...preamble];
  for (const s of sections) skeletonParts.push(s.header);
  const skeleton = skeletonParts.join("\n");
  const remaining = budgetChars - skeleton.length;
  if (remaining <= 0) {
    // 骨架都放不下 → 保开头若干行 + 提示
    return { text: skeleton.slice(0, budgetChars) + "\n[注：全文 " + text.length + " 字符，骨架已超预算；完整内容用 memory_search 查 " + fileLabel + "]", truncated: true, total: text.length };
  }
  const perSection = sections.length > 0 ? Math.floor(remaining / sections.length) : 0;
  const out = [...preamble];
  for (const s of sections) {
    out.push(s.header);
    const bodyText = s.body.join("\n");
    if (perSection > 0 && bodyText.length > perSection) {
      let cut = bodyText.slice(0, perSection);
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
    hints: { A: 0, B: 0, C: 0, D: 0 },     // 提醒次数（按类型；D=v2.0.2 LLM循环试错）
    byDomain: {},                     // A 类提醒按领域统计 { 领域名: 次数 }
    queries: 0,                       // memory_search 总调用数
    recentQueries: [],                // 最近查询（最多 20 条 {t, query}）
    followed: 0, ignored: 0, capped: 0,          // 提醒后是否被跟随（有效/忽略）；capped=v1.12.16 窗口超限截断（长任务），不计跟进率分母
    events: [],                       // 全量事件 {t, type, detail}（全量保留）
    hintOpen: null,
    maintain: { integRuns: 0, archRuns: 0, inT: 0, cacheT: 0, outT: 0 },  // v1.12.18.1: 维护 token 累计
    turnProfiles: [],                   // v1.12.16: 任务周期画像 [{t,durMin,calls,negN,errN,spiralN}]（滚动200条，调优基线）
    spiralEvents: [],                   // v1.12.16: 打转触发样本 [{t,tool,repRate,negRate,sample}]（v2.0.2 起可注入D类提醒，样本仍全量保留供调优）
    spiralThresh: null,                 // v2.0.3: D 类阈值覆盖层 {rep,neg,sim,w,cooldownMin}——null=用内置默认；/dream 自校准写入
    spiralThreshLog: [] };              // v2.0.4: 阈值变更日志 [{t,from,to,reason}]（滚动20条，审计/回滚依据）
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

// 记录一个监控事件（原子更新 + 防抖写盘）
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
      fs.writeFileSync(portable(MONITOR_FILE), JSON.stringify(d));
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
      "提醒统计  关键词命中 " + (d.hints.A || 0) + " · 重复错误 " + (d.hints.B || 0) + " · 连续失败 " + (d.hints.C || 0) + " · 循环空转 " + (d.hints.D || 0),
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
    cooldownMin: num(t.cooldownMin, 5, 60, 10)
  };
}
// 「参数打转 × 无进展」双条件识别原地空转（回测标定：试错链命中、正常翻页不误报）。
// v2.0.2: 样本落盘 spiralEvents/turnProfiles 供阈值调优；周期内首次命中返回 true，
// 由调用点结合 spiralRemind 开关与冷却注入 D 类「LLM循环试错提醒」（关闭=纯影子模式）。
const SPIRAL_W = 8;            // 滑窗大小
const SPIRAL_SIM_TH = 0.7;     // args bigram Dice 相似度阈值（S1）
const SPIRAL_REP_TH = 0.45;    // 窗口内打转占比阈值
const SPIRAL_NEG_TH = 0.4;     // 窗口内负面结果占比阈值（S2）
const SPIRAL_NEG_RE = /error|fail|exception|traceback|eperm|eacces|denied|not found|no such|不存在|失败|无法|超时|timeout|invalid|cannot|could not|refused|abort|证书|cert/i;
const SPIRAL_SKIP = new Set(["job_output", "job_list", "job_kill", "memory_search", "skill", "todo_write"]);  // 轮询/元工具豁免
let DREAM_TRACK = null;
let LAST_DREAM_WROTE_AT = 0;   // v2.3.2(dream-tool): memory_dream_patch 成功落盘时间戳（settleDream 判成败用）   // v1.12.17: dream 运行跟踪 { since, sessionId, steps }（跨层共享）
let DREAM_PATCH = null;   // v1.12.17: 进度落盘函数桥（闭包内注入，顶层监听调用）
// v2.0.1: 按会话 id 分桶——原全局单例 TURN_CUR/SPIRAL_WIN 在多主会话并发时互相腰斩周期/清空滑窗（08-24 阈值标定实证）
const SPIRAL_BUCKETS = new Map();  // sid -> { cur: 任务周期画像|null, win: 滑窗[], ws: 工作空间尾段 }
function spiralBucket(sid) {
  const key = String(sid || "?");
  let b = SPIRAL_BUCKETS.get(key);
  if (!b) {
    if (SPIRAL_BUCKETS.size >= 200) { const k0 = SPIRAL_BUCKETS.keys().next().value; SPIRAL_BUCKETS.delete(k0); }  // 长驻实例防御：淘汰最早桶
    b = { cur: null, win: [], ws: "?" };
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
  try {
    if (PLUGIN_CFG.monitorEnabled === false || SPIRAL_SKIP.has(toolName)) return;
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
    B.win.push({ argsTxt: aTxt, resKey: rTxt.slice(0, 80), neg: neg ? 1 : 0, rep, tool: toolName, sim: Math.round(stepSim * 100) / 100 });
    if (B.win.length > ET.w) B.win.shift();
    if (!B.cur) B.cur = { t0: Date.now(), calls: 0, negN: 0, errN: 0, spiralN: 0, tools: {}, sims: [] };   // v2.2.8: sims 累积步间相似度
    B.cur.calls += 1;
    B.cur.tools[toolName] = (B.cur.tools[toolName] || 0) + 1;   // v1.12.16.1 周期工具分布
    B.cur.sims.push(stepSim);   // v2.2.8: 相似度序列供周期结算分位
    if (neg) B.cur.negN += 1;
    if (isError) B.cur.errN += 1;
    if (B.win.length >= 5) {
      const n = B.win.length;
      const repRate = B.win.reduce((s2, w2) => s2 + w2.rep, 0) / n;
      const negRate = B.win.reduce((s2, w2) => s2 + w2.neg, 0) / n;
      if (repRate >= ET.rep && negRate >= ET.neg && B.cur) {
        const firstHit = B.cur.spiralN === 0;   // 本周期首次命中
        B.cur.spiralN += 1;
        if (firstHit) {   // 每周期只记首次样本，防膨胀
          const d = readMonitorData();
          if (!Array.isArray(d.spiralEvents)) d.spiralEvents = [];
          const tCnt = {};
          for (const w2 of B.win) tCnt[w2.tool] = (tCnt[w2.tool] || 0) + 1;
          const wTop = Object.entries(tCnt).sort((a2, b2) => b2[1] - a2[1]).slice(0, 2).map((x2) => x2[0]).join(",");
          // v2.2.8: 触发现场观测——maxSim=触发时窗内最大相似度；winLen=触发时窗长（是否刚满下限即报）；firstRepPos=首个判重步序号（触发延迟近似）
          const firstRepPos = B.win.findIndex((w2) => w2.rep === 1);
          const winMaxSim = B.win.reduce((m2, w2) => Math.max(m2, w2.sim || 0), 0);
          d.spiralEvents.push({ t: Date.now(), tool: toolName, repRate: Math.round(repRate * 100) / 100, negRate: Math.round(negRate * 100) / 100, sample: aTxt.slice(0, 60), ws: B.ws, topTools: wTop, maxSim: winMaxSim, winLen: B.win.length, firstRepPos });
          if (d.spiralEvents.length > 100) d.spiralEvents = d.spiralEvents.slice(-100);
          scheduleMonitorSave();
        }
        return firstHit;   // v2.0.2: 是否周期首次打转（调用点决定是否注入 D 类提醒）
      }
    }
  } catch (e) { /* 探针失败不影响会话 */ }
  return false;
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
    d.turnProfiles.push({ t: Date.now(), durMin: Math.round(((Date.now() - B.cur.t0) / 6000)) / 100, calls: B.cur.calls, negN: B.cur.negN, errN: B.cur.errN, spiralN: B.cur.spiralN, ws: B.ws, topTools: pTop, simP50: Math.round(pct(simsAsc, 0.5) * 100) / 100, simP90: Math.round(pct(simsAsc, 0.9) * 100) / 100 });
    if (d.turnProfiles.length > 200) d.turnProfiles = d.turnProfiles.slice(-200);
    B.cur = null;
    B.win.length = 0;
    scheduleMonitorSave();
  } catch (e) { /* 忽略 */ }
}
function findStaleSessions(maxAgeDays, afterTime) {
  const stale = [];
  // v1.11.0：记忆暂停（active=false，afterTime 为 null）→ 不纳入任何漏网
  if (afterTime === null) return stale;
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch (e) { return stale; }
  const cutoff = Date.now() - maxAgeDays * 86400000;
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
        fs.writeFileSync(portable(unitCachePath(unit.sid)), JSON.stringify(unit), "utf8");
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
        INJECT_SNAPSHOT.set(k, { g: v.g, i: v.i, s: v.s, t: v.t || 0, used: v.used === undefined ? undefined : v.used });
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
      fs.writeFileSync(fp + ".tmp-inject", JSON.stringify(obj), "utf8");
      fs.renameSync(fp + ".tmp-inject", fp);
    } catch (e) { /* 写失败不重试——下次恢复宁可多注入不可漏（重复方向安全） */ }
  }, 5000);
}
function injectSnapshotGet(sessionId) { return INJECT_SNAPSHOT.get(sessionId) || null; }
function recordInjectSnapshot(sessionId, entry) {
  const prev = INJECT_SNAPSHOT.get(sessionId);
  // v2.4.8：used 保底——新会话（无 prev）首次记账 used=false（尚无真实回合）；有 prev 则保留其 used（不因恢复/重注翻转为 false）
  INJECT_SNAPSHOT.set(sessionId, { g: entry.g, i: entry.i, s: entry.s, t: Date.now(), used: prev && typeof prev.used === "boolean" ? prev.used : (prev ? (prev.used === undefined ? undefined : prev.used) : false) });
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
const DEFAULT_CFG = { staleSessionDays: 5, staleAction: "remind", integrateEnabled: false, integrateDays: 7, active: true, monitorEnabled: true, spiralRemind: true, initGuideEnabled: true, updateCheckEnabled: true };
// v1.11.0：active = 记忆活跃开关（独立于 DSH 进程启停）——
// 用户显式关掉=记忆整合暂停（enabledAt 置空）；打开=重新启用（enabledAt 刷新为当前时间）。
// DSH 重启/退出不再影响 enabledAt——「插件启停」与「DSH 进程启停」彻底解耦。
// v1.6.0：整合/漏网状态文件（模块级，供 getInstallAt 等跨作用域使用）
const INTEGRATE_STATE_FILE = MEMORY_ROOT + "/.integrate.json";
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
  // v2.3.0：新装用户初始化引导开关（关＝不再自动提，/memory-init 仍可用）
  initGuideEnabled: z.boolean().default(DEFAULT_CFG.initGuideEnabled),
  // v2.3.0：升级检查开关（每天最多一次远端 version.txt 比对；离线/内网失败静默）
  updateCheckEnabled: z.boolean().default(DEFAULT_CFG.updateCheckEnabled),
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
  if (typeof cfg.initGuideEnabled !== "boolean") cfg.initGuideEnabled = DEFAULT_CFG.initGuideEnabled;
  if (typeof cfg.updateCheckEnabled !== "boolean") cfg.updateCheckEnabled = DEFAULT_CFG.updateCheckEnabled;
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
'    h += \'<table><thead><tr><th style="width:30%">时间</th><th style="width:18%">工具</th><th style="width:11%">重复</th><th style="width:11%">负面</th><th style="width:14%">相似</th><th>工作区</th></tr></thead><tbody>\';\n' +
'    var spa = sp.slice(-12).reverse();\n' +
'    for (var s2 = 0; s2 < spa.length; s2++) {\n' +
'      var sv = spa[s2];\n' +
'      h += \'<tr><td class="mono">\' + fmtT(sv.t) + \'</td><td><span class="tag"\' + tip("工具：" + sv.tool) + ">" + esc(sv.tool) + "</span></td><td class=\\"mono\\">" + Math.round((sv.repRate || 0) * 100) + "%</td><td class=\\"mono\\">" + Math.round((sv.negRate || 0) * 100) + \'%</td><td class="mono">\' + (sv.maxSim == null ? "-" : sv.maxSim) + \'</td><td class="mono ell"\' + tip("工作区：" + (sv.ws || "-") + (sv.topTools ? "\\n窗口内工具：" + sv.topTools : "") + (sv.sample ? "\\n样本：" + String(sv.sample).slice(0, 120) : "")) + ">" + esc(sv.ws) + "</td></tr>";\n' +
'    }\n' +
'    h += "</tbody></table>";\n' +
'  } else h += \'<div class="muted">暂无（未检测到空转迹象）</div>\';\n' +
'  h += "</div>";\n' +
'  var tp = d.turnProfiles || [];\n' +
'  h += \'<div class="card glass"><h2>任务周期画像<span class="h2n">200 窗口 · 最近 \' + Math.min(tp.length, 12) + " 条</span></h2>";\n' +
'  if (tp.length) {\n' +
'    h += \'<table><thead><tr><th style="width:30%">开始</th><th style="width:13%">时长</th><th style="width:11%">调用</th><th style="width:16%">负/错/空</th><th style="width:15%">p50/p90</th><th>工作区</th></tr></thead><tbody>\';\n' +
'    var tpa = tp.slice(-12).reverse();\n' +
'    for (var t2 = 0; t2 < tpa.length; t2++) {\n' +
'      var pv = tpa[t2];\n' +
'      h += \'<tr><td class="mono">\' + fmtT(pv.t) + \'</td><td class="mono">\' + (pv.durMin == null ? "-" : pv.durMin) + \' min</td><td class="mono">\' + pv.calls + \'</td><td class="mono">\' + pv.negN + " / " + pv.errN + " / " + pv.spiralN + \'</td><td class="mono">\' + (pv.simP50 == null ? "-" : pv.simP50) + " / " + (pv.simP90 == null ? "-" : pv.simP90) + \'</td><td class="mono ell"\' + tip("工作区：" + (pv.ws || "-") + (pv.topTools ? "\\n高频工具：" + pv.topTools : "")) + ">" + esc(pv.ws) + "</td></tr>";\n' +
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
'  h += \'<div class="kpi" style="--dot:#f472b6;--ac:linear-gradient(90deg,#ec4899,#f472b6);padding:12px 14px"\' + tip(last ? fmtT(last.t) + "\\n" + (last.reason || "无备注") + (last.from ? "\\n" + JSON.stringify(last.from) + " → " + JSON.stringify(last.to) : "") : "从未调整（全部内置默认）") + \'><div class="kv ell" style="font-size:14px;line-height:1.7;max-width:100%">\' + (last ? new Date(last.t).toLocaleDateString("zh-CN") + " · " + esc(last.reason || "无备注") : "从未调整") + \'</div><div class="kl"><span class="kdot"></span>最近调整</div></div>\';\n' +
'  h += "</div></div>";\n' +
'  h += "</div>";\n' +
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
                res.end(raw);
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

    // v1.2.0：node:fs 直写 —— 宿主插件运行在真实 Node 环境（cordis 原生 import 加载），
    // 可直接写 ~/.dsh（绕过 ctx.fs 的 workspace-write 沙箱，无需模型执行/审批）。
    // 用途：压缩检查点摘要直接落盘，不再依赖"下一次模型回合"；提醒制降级为 fallback。
    // 注意：node:fs 无沙箱拦截，只用于受控路径（MEMORY_ROOT 内），且保持追加语义（先读全量）。
    function nodeFsWriteAppend(filePath, heading, body) {
      const fullPath = portable(filePath);
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      fs.mkdirSync(dir, { recursive: true });
      let existing = "";
      try {
        existing = fs.readFileSync(fullPath, "utf8");
      } catch (e) {
        existing = ""; // 文件不存在 → 新建
      }
      const block = "\n## " + heading + "\n\n" + body.trim() + "\n";
      fs.writeFileSync(fullPath, existing + block, "utf8");
      return existing.length;
    }

    // v2.0.7: 归档检查点统一落盘（A）——归档子代理只产出 [ARCHIVE_BEGIN]…[ARCHIVE_END] 文本检查点（FILE: 行 + 正文），
    // 由插件 node:fs 在这里解析并追加写盘，规避子代理 write/edit 写 ~/.dsh 被沙箱拒绝且无审批升级通道的必失败路径。
    // 语义：①有块且全部落盘/幂等跳过 → ok:true（落盘完成才消号）；②无块（子代理判断全部无价值跳过）→ ok:true 按完成处置（v1.12.19 消号语义）；
    // ③有块但 FILE 失配（unparsable）/目标越界（boundary）/异常 → ok:false，流会话不消号留待下轮重送，防静默丢失。
    function applyArchiveCheckpoints(outText, todayStr) {
      const re = /\[ARCHIVE_BEGIN\]([\s\S]*?)\[ARCHIVE_END\]/g;
      const groups = new Map(); // 目标相对路径（sessions/… | projects/…）→ 正文块数组
      let blockCount = 0;
      let m;
      while ((m = re.exec(String(outText || ""))) !== null) {
        blockCount++;
        const lines = m[1].trim().split("\n");
        let fileLine = null; let fi = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^FILE:\s*\S+/.test(lines[i].trim())) { fileLine = lines[i].trim(); fi = i; break; }
        }
        if (!fileLine) continue;
        const rel = fileLine.replace(/^FILE:\s*/i, "").replace(/^~\/\.dsh\/memory\//, "").replace(/^\.\//, "").replace(/\\/g, "/").trim();
        const body = lines.filter((_, i) => i !== fi).join("\n").replace(/\n{3,}/g, "\n\n").trim();
        if (!rel || !body) continue;
        // v2.3.1: 防御子代理把任务书里的模板示例复述进检查点（FILE: sessions/<会话归属日期>.md
        // 这类占位路径）——含尖括号/占位中文必为模板，直接跳过，否则 ENOENT 崩掉整批归档；
        // sessions/ 下只认「日期.md」真实格式，其余（如 <会话归属日期>.md、xx.md）视为模板/NULL 目标跳过
        if (/[<>《》]/.test(rel)) continue;
        if (/^sessions\//.test(rel) && !/^sessions\/\d{4}-\d{2}-\d{2}\.md$/.test(rel)) continue;
        if (!groups.has(rel)) groups.set(rel, []);
        groups.get(rel).push(body);
      }
      if (blockCount === 0) return { ok: true, mode: "no-blocks", wrote: 0 };
      if (groups.size === 0) return { ok: false, mode: "unparsable", wrote: 0 };
      const written = [];
      const skipped = [];
      for (const [rel, bodies] of groups) {
        if (!/^(sessions|projects)\//.test(rel)) {
          cwarn("[dsh-memory] 归档检查点目标越界，忽略: " + rel);
          return { ok: false, mode: "boundary", wrote: written.length };
        }
        const fullPath = portable(MEMORY_ROOT + "/" + rel);
        let existing = "";
        try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
        // v2.0.8: 幂等粒度从「日期小节级」降为「会话条目级」——旧版按日期 marker 整文件跳过，
        // 同日第二轮归档的新会话会被误杀静默丢失；现按 body 内 ### 短id 判重，仅剔除已在库条目。
        const pending = [];
        for (const b of bodies) {
          const ids = Array.from(b.matchAll(/^###\s+([^（\s]+)/gm)).map((x) => x[1]);   // v2.0.8: 只取 id token（短id 到 （ 或空白为止），主题措辞不参与判重
          const fresh = ids.filter((id) => !existing.includes(id));
          if (ids.length > 0 && fresh.length === 0) { skipped.push(rel + "#" + ids.join("/")); continue; } // 全部条目已在库（同批重复/子代理 B 兜底已写）
          pending.push(b); // 含新条目则整块写入（同块混合新旧条目的情况极少，宁重复不丢失）
        }
        if (!pending.length) continue;
        // v2.3.1: 单目标写盘失败只跳过该目标（cwarn 记录），不整批判失败——防个别坏路径
        // （如子代理复述的模板/NULL 路径漏网）拖垮全部真实检查点落盘
        try {
          const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
          fs.mkdirSync(dir, { recursive: true });
          const block = pending.join("\n\n").trim();
          fs.writeFileSync(fullPath, existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + block + "\n", "utf8");
          written.push(rel + "(+" + block.length + ")");
        } catch (writeErr) {
          cwarn("[dsh-memory] 归档检查点写盘失败，跳过该目标: " + rel + " - " + (writeErr && writeErr.message ? writeErr.message : String(writeErr)));
          continue;
        }
      }
      return { ok: true, mode: "written", wrote: written.length, written: written, skipped: skipped };
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
        let rel = b.file.replace(/^~\/\.dsh\/memory\//, "").replace(/^\.\//, "").replace(/\\/g, "/").trim();
        if (/[<>《》]/.test(rel)) { errors.push(tag + ".file 含占位符: " + rel); continue; }
        if (rel.includes("..")) { errors.push(tag + ".file 越界: " + rel); continue; }
        if (!/^(sessions|projects)\//.test(rel)) { errors.push(tag + ".file 越界（只允许 sessions/|projects/）: " + rel); continue; }
        if (b.skip === true) { norm.push({ rel: rel, sid: b.sessionId.trim(), skip: true, reason: String(b.reason || "无价值跳过") }); continue; }
        if (!Array.isArray(b.points) || b.points.length === 0) { errors.push(tag + " 非 skip 时必须提供 points（3-6 条要点数组）"); continue; }
        norm.push({ rel: rel, sid: b.sessionId.trim(), title: String(b.title || ""), points: b.points.map((p) => String(p)).filter((p) => p.trim()) });
      }
      const missing = ids.filter((id) => !declared.has(id));
      if (missing.length) errors.push("未声明处置的会话（每个要么 skip=true 要么提交归档块）: " + missing.join(", "));
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
          fs.writeFileSync(fullPath, existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + block.trim() + "\n", "utf8");
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
        let rel = p.file.replace(/^~\/\.dsh\/memory\//, "").replace(/^\.\//, "").replace(/\\/g, "/").trim();
        if (/[<>《》]/.test(rel)) { errors.push(tag + ".file 含占位符: " + rel); continue; }
        if (rel.includes("..")) { errors.push(tag + ".file 越界: " + rel); continue; }
        if (!/^(sessions|projects|knowledge|tools)\//.test(rel) && !/^(global|index)\.md$/.test(rel)) { errors.push(tag + ".file 越界（只允许 sessions|projects|knowledge|tools/ 或 global.md|index.md）: " + rel); continue; }
        if (!["replace", "append", "delete"].includes(p.action)) { errors.push(tag + ".action 非法（replace|append|delete）: " + String(p.action)); continue; }
        if (typeof p.content !== "string" || !p.content.trim()) { errors.push(tag + ".content 缺失或空"); continue; }
        if (p.content.length > 128 * 1024) { errors.push(tag + ".content 超 128KB"); continue; }
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
        const key = rel + "|" + p.action;
        if (seen.has(key)) { errors.push(tag + " 与更早条目重复（同一文件同动作只允许一条）: " + rel + " " + p.action); continue; }
        seen.add(key);
        valid.push({ rel: rel, action: p.action, content: p.content });   // v2.3.2-hotfix: 不污染入参（宿主冻结工具参数对象，挂 _rel 会抛 not extensible）
      }
      if (errors.length) return { ok: false, mode: "bad-schema", wrote: 0, errors: errors };
      const applied = []; const skipped = [];
      for (const it of valid) {
        const fullPath = portable(MEMORY_ROOT + "/" + it.rel);
        try {
          if (it.action === "replace") {
            const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
            fs.mkdirSync(dir, { recursive: true });
            const tmp = fullPath + ".tmp-dream";
            fs.writeFileSync(tmp, it.content, "utf8");
            fs.renameSync(tmp, fullPath);
            const back = fs.readFileSync(fullPath, "utf8");
            if (back !== it.content) { skipped.push(it.rel + "(回读不一致)"); continue; }
            applied.push(it.rel + "(replace " + it.content.length + ")");
          } else if (it.action === "append") {
            let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
            const payload = it.content.trim();
            if (existing.includes(payload)) { skipped.push(it.rel + "(append内容已存在)"); continue; }
            fs.writeFileSync(fullPath, existing.replace(/\s+$/, "") + (existing ? "\n\n" : "") + payload + "\n", "utf8");
            applied.push(it.rel + "(append)");
          } else if (it.action === "delete") {
            let existing = ""; try { existing = fs.readFileSync(fullPath, "utf8"); } catch (e) { existing = ""; }
            const idx = existing.indexOf(it.content);
            if (idx < 0) { skipped.push(it.rel + "(delete未找到)"); continue; }
            fs.writeFileSync(fullPath, existing.slice(0, idx) + existing.slice(idx + it.content.length).replace(/^\n+/, ""), "utf8");
            applied.push(it.rel + "(delete)");
          }
        } catch (e) {
          cwarn("[dsh-memory] DREAM patch 落盘失败（跳过）: " + (e && e.message ? e.message : String(e)));
          skipped.push(it.rel + "(异常)");
        }
      }
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
    async function compactOnce(subagents, parent, promptText, tag) {
      try {
        const opts = {
          label: "dsh-memory-压缩-" + tag,
          prompt: [{ type: "text", text: promptText }],
          signal: new AbortController().signal,
          toolFilter: { allow: ["memory_search"] }
        };
        if (parent) opts.parent = parent;
        const run = await subagents.start("spawn", opts);
        const result = await run.result;
        const txt = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n").trim().slice(0, 4000) || null;
        if (!txt && result && result.stopReason && result.stopReason !== "completed") {
          const e2 = new Error("subagent stopped: " + result.stopReason);
          e2.__maintFail = result.stopReason;
          throw e2;
        }
        return txt;
      } catch (e) {
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
      "纪律（分节预算，严格）：本次目标≤120字；下一步行动≤200字；关键结论≤4条、每条≤140字。\n" +
      "超限处置：从「关键结论」尾部删整条——宁缺毋断，字面量禁止截半句，前两节永不删。不确定就写「未明确」，不编造。\n" +
      "补全通道：摘要通常已全文直喂（≤20000 字原样入上下文）；仅超长时出现「本节截断/本节中省略」标记——见标记且需精确字面量时，先 memory_search 查今日归档（sessions/日期.md 自动检查点块）再定稿。\n\n===== 宿主压缩摘要 =====\n";
    let INTENT_RUNNING = false;
    // v2.4.3：当日 md 合并维护阈值——口径=stripCompactionDumps + 剥 intent 块后 ≥1500 触发（B 方案，用户 08-30 拍板）。
    // 1500 与注入端硬预算 CHAR_LIMIT.summary 同源：真实要点面装满注入窗口才压缩；阈值即节流不变（无时间冷却），
    // 余量 1500−合并上限1100≈400 字 ≈1-2 条收尾摘要才触发一次；compact 必写的 intent 块已剥出计数，不再乒乓复触发。
    const MAINT_TRIGGER_CHARS = 1500;
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
      const OWN_SECTIONS = /^##\s*(检查点（|本次目标|下一步行动|关键结论)/;
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
    function needMaintenanceMerge(fname) {
      const target = MEMORY_ROOT + "/sessions/" + fname;
      try {
        const raw = fs.readFileSync(portable(target), "utf8");
        if (injectedCharsOf(raw) >= MAINT_TRIGGER_CHARS) return true;   // 旧条件：真实要点面超预算
        // v2.4.4（B）：intent 撑爆注入面兜底
        if (countIntentBlocks(raw) >= 1) {
          const withIntent = stripCompactionDumps(raw).trim().length;
          if (withIntent >= MAINT_TRIGGER_CHARS && injectedCharsOf(raw) < MAINT_TRIGGER_CHARS) return true;
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
    function maintRetryResetIfStale() {
      const today = dateStr(new Date()) + ".md";
      if (MAINT_RETRY && MAINT_RETRY.day !== today) { MAINT_RETRY = null; MAINT_FUSED = false; }   // 跨日作废（机械收敛旗标同步复位）
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
      monitorEvent("maint-retry", "fail#" + MAINT_RETRY.attempts + " " + fname +
        " reason=" + MAINT_RETRY.lastReason + " backoff=" + Math.round(backoff / 60e3) + "m");
      // v2.4.5 第4层：达熔断上限 → 立即机械收敛（纯代码，零 LLM 依赖；compact 原文已在 dump 资产中逐字保留）
      if (MAINT_RETRY.attempts >= MAINT_RETRY_MAX) mechanicalConverge(fname);
    }
    function maintRetryClear() { MAINT_RETRY = null; }   // 成功落盘即清零
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
        const points = stripIntentBlocksForCount(stripCompactionDumps(existing)).trim();
        if (!points) return false;                       // 无要点可收（全在 dump 里），无需动作
        let kept = points;
        if (kept.length > 1050) {                        // 行界截断，绝不断句
          const cut = kept.lastIndexOf("\n", 1050);
          kept = (cut > 700 ? kept.slice(0, cut) : kept.slice(0, 1050)).trim();
        }
        // 提取 compaction dump 资产（与 runMaintenanceMerge 同边界规则：marker 开块、任意注释/H1/中文H2 止块）
        const lines = String(existing).split("\n");
        const dumps = [];
        let capturing = false;
        for (const ln of lines) {
          if (/^\s*<!-- compaction: /.test(ln)) { capturing = true; dumps.push(ln); continue; }
          if (!capturing) continue;
          if (/^\s*<!-- /.test(ln) || /^#\s/.test(ln) || (/^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln))) { capturing = false; continue; }
          dumps.push(ln);
        }
        const block = "## 当日要点（" + dateStr(new Date()) + " 机械收敛）\n\n" + kept + "\n";
        fs.writeFileSync(portable(target), block + (dumps.length ? "\n\n" + dumps.join("\n") : "") + "\n", "utf8");
        MAINT_FUSED = true;                              // 本文件本日至多机械收敛一次
        monitorEvent("maint-fallback", "mechanical " + fname + " kept=" + kept.length);
        clog("[dsh-memory] 合并维护熔断 → 机械收敛 sessions/" + fname + "（" + kept.length + " 字符，dump 资产完整保留）");
        try { refreshMemorySessionsIndex(); } catch (e2) {}
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 机械收敛失败:", e && e.message ? e.message : String(e));
        return false;
      }
    }
    // v2.4.2：合并维护任务书——不依赖宿主摘要（触发源是用户消息/compact，旧要点本身就是主体）：
    // 把当日 md 已积累的检查点/要点压缩去重，保持注入面不再膨胀
    const MAINT_MERGE_INSTRUCTION =
      "你是记忆维护压缩器。对以下「当日检查点现状」（当日会话摘要里已积累的旧检查点与要点）执行压缩合并，输出固定结构 Markdown（只输出下列三节）：\n" +
      "## 本次目标\n（保留仍有效的用户请求/主线目标原文，无则写「已完结」）\n" +
      "## 下一步行动\n（保留未决事项/衔接点，无则写「无明确下一步」）\n" +
      "## 关键结论\n（把旧要点合并去重：同主题取新、删重复客套、保留全部精确字面量——路径/ID/命令/数字/报错串逐字保留绝不概括）\n" +
      "纪律（严格）：三节合计 ≤1100 字符；「关键结论」必须逐条分行（每条一行、单条 ≤140 字，禁止写成一段超长单行）；宁删次要旧要点，绝不断句、绝不改写精确字面量；不编造新内容；只输出三节无任何额外说明。\n\n===== 当日检查点现状 =====\n";
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
    async function runMaintenanceMerge(fname, summaryText, parentAgent, sid8) {
      if (MAINT_RUNNING) return false;
      // v2.4.10：意图检查点运行中 → 跳过本轮（不登记失败）。maint 不依赖本轮宿主摘要（无摘要也照常合并旧要点），
      // 晚收敛无害——pre-step/下次 compact 自然再触发；同时杜绝两路「整文件重建写回」并发覆盖（陈旧快照竞态，
      // 实证：intent 先落盘则新检查点整块丢失、intent 后落盘则 maint 成果被回滚）。
      if (INTENT_RUNNING) return false;
      // v2.4.5：重试闸门——冷却窗口未到或当日已熔断则静默跳过（不占忙锁，不打日志刷屏）
      if (!maintRetryAllow(fname)) return false;
      MAINT_RUNNING = true;
      try {
        const subagents = ctx.get("subagents");
        if (!subagents || typeof subagents.start !== "function") {
          clog("[dsh-memory] 合并维护：subagents 不可用，跳过（下次触发再试）");
          maintRetryRecordFail(fname, "no-subagents");   // v2.4.5：登记退避，避免每条消息都撞一次空通道
          return false;
        }
        const target = MEMORY_ROOT + "/sessions/" + fname;
        let existing = "";
        try { existing = fs.readFileSync(portable(target), "utf8"); } catch (e) { existing = ""; }
        const existingStripped = stripCompactionDumps(existing);   // 旧要点（不喂 compaction dump 资产）
        if (existingStripped.trim().length < 60) return false;     // 无要点可合并（空或仅剩 dump）
        const prompt = MAINT_MERGE_INSTRUCTION + existingStripped +
          (summaryText ? "\n\n（另：本次压缩事件宿主摘要，可参考补充最新进展）\n" + smartTrim(summaryText, 20000, "sessions/" + fname + "（memory_search 可查）") : "");
        const sum = await compactOnce(subagents, parentAgent, prompt, "maint-" + fname.replace(/\..+$/, ""));
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
          const missing = checkTopicCoverage(existingStripped, sum);
          if (missing.length) {
            malformed = true;
            failReason = "topic-lost";
            const detail = missing.map((m) => m.head + " anchors=[" + m.anchors.join(",") + "]").join(" | ");
            clog("[dsh-memory] 合并维护：子代理输出丢主题，跳过落盘：" + detail);
            monitorEvent("maint", "topic-lost " + missing.length + "块 " + fname + " " + detail.slice(0, 160));
          }
        }
        if (!sum || malformed) {
          maintRetryRecordFail(fname, !sum ? "no-output" : failReason);   // v2.4.5 + v2.4.9 topic-lost
          return false;
        }
        let merged = sum.trim();
        if (merged.length > 1100) {
          const kIdx = merged.indexOf("## 关键结论");
          if (kIdx >= 0) {
            const head2 = merged.slice(0, kIdx);
            const kLines = merged.slice(kIdx).split("\n").filter((l) => l.trim() !== "");
            while (kLines.length > 0 && head2.length + kLines.join("\n").length > 1100) kLines.pop();   // v2.4.2.2：允许 pop 到空（原 >2 遇单行长节失效）
            merged = (head2 + kLines.join("\n")).trim();
          }
        }
        if (merged.length > 1100) {   // v2.4.2.2 兜底：节内单条超长行时 pop 无效——按换行边界硬切，保证 ≤1100（阈值即节流的收敛前提）
          const cut = merged.lastIndexOf("\n", 1100);
          merged = (cut > 700 ? merged.slice(0, cut) : merged.slice(0, 1100)).trim();
        }
        // v2.4.2：提取 compaction dump 资产（原文保留，与 stripCompactionDumps 同边界规则）
        function extractCompactionDumps(text) {
          const lines = String(text || "").split("\n");
          const out = [];
          let capturing = false;
          for (const ln of lines) {
            // v2.4.2.2：相邻 dump 块（marker 直接跟 marker/正文）——compaction marker 一律开启新捕获并保留自身，
            // 绝不能在捕获中被当成终止边界（19:20 真机事故：一半 dump 被写回丢弃）
            if (/^\s*<!-- compaction: /.test(ln)) { capturing = true; out.push(ln); continue; }
            if (!capturing) continue;
            const isH1 = /^#\s/.test(ln);
            const isOtherH2 = /^##\s/.test(ln) && !/^##\s*[A-Za-z]/.test(ln);
            const isOtherMarker = /^\s*<!-- /.test(ln);
            if (isOtherMarker || isH1 || isOtherH2) { capturing = false; continue; }
            out.push(ln);
          }
          return out.join("\n");
        }
        // 覆盖式写回：新要点块（merged，已并入旧要点）+ 完整 compaction dump 资产；旧 intent 块/旧要点/旧手工内容由 merged 吸收
        const block = "## 当日要点（" + dateStr(new Date()) + " 维护合并）\n\n" + merged + "\n";
        const dumps = extractCompactionDumps(existing);
        const finalText = block + (dumps ? "\n\n" + dumps : "") + "\n";
        fs.writeFileSync(portable(target), finalText, "utf8");
        // v2.4.9：落盘回读校验——读回与期望全文比对（OneDrive 占位/静默截断兜底）；失败不抛（dump 资产仍在下次重合并）
        if (!readbackVerify(portable(target), finalText)) {
          cwarn("[dsh-memory] 合并维护：写回回读不一致 sessions/" + fname + "，内容可能未持久化");
          monitorEvent("maint", "readback-mismatch " + fname);
        }
        clog("[dsh-memory] 合并维护完成 sessions/" + fname + "（" + merged.length + " 字符要点，注入面已收敛）");
        maintRetryClear();   // v2.4.5：成功落盘清零重试状态
        try { refreshMemorySessionsIndex(); } catch (e2) {}
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 合并维护失败:", e && e.message ? e.message : String(e));
        maintRetryRecordFail(fname, (e && (e.__maintFail || e.message)) ? String(e.__maintFail || e.message).slice(0, 60) : "throw");   // v2.4.5
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
      const blocks = [];
      const rest = [];
      let cur = null;
      for (const ln of lines) {
        const m = ln.match(MARK);
        if (m) { cur = { sid: m[1] || "legacy", lines: [ln] }; blocks.push(cur); continue; }
        if (cur && /^\s*<!-- /.test(ln)) { cur = null; rest.push(ln); continue; }
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
        if (!/^##\s*本次目标/.test(sum.trim())) {   // v2.3.8 F4: 格式护栏——拒绝非检查点文本入正文（ghost 轮跑题回复曾顶替正解落盘）
          monitorEvent("intent", "malformed " + String(compactionId).slice(0, 8) + " head=[" + sum.slice(0, 30).replace(/\n/g, " ") + "]");
          cwarn("[dsh-memory] 意图检查点：输出非检查点格式，跳过落盘 " + String(compactionId).slice(0, 8));
          return;
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
        fs.mkdirSync(targetFull.slice(0, Math.max(0, targetFull.lastIndexOf("/"))), { recursive: true });
        const finalIntentText = block + "\n" + stripOldIntentBlocks(existing, sid8);
        fs.writeFileSync(targetFull, finalIntentText, "utf8");
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
      const todayStr = new Date().toISOString().slice(0, 10);
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
          "   - 工具会校验完整性（含缺声明会话检查）+ 落盘（追加到目标文件，条目幂等）；失败会在工具结果返回错误清单，按清单修正后再次调用，可多次调用直到全部通过。\n";
        const label = "dsh-memory-漏网归档-" + sidList.length + "会话-批" + (batchIdx + 1);
        try {
          const spawnOpts = {
            label: label,
            prompt: [{ type: "text", text: promptText }],
            signal: new AbortController().signal,
            // v2.4.7（方案C·L4）：批已按预算确定性切小 → 二级拆分不再需要；工具面 = 只读+交付（allow 白名单规避
            //   dsh-alpha 的 subagent 非 restrictable + run_code PTC 红线双坑；allow 内均为宿主确定存在的名字）
            toolFilter: { allow: ["read", "grep", "glob", "memory_search", "memory_archive_checkpoint"] }
          };
          if (LAST_TOP_AGENT) spawnOpts.parent = LAST_TOP_AGENT;
          // v2.4.7.1（回归修复②）：本函数只做「发起」——subagents.start 秒级返回，供上层判定
          //   r.ok=已发起 并当场落节流戳；run.result 的长等待移进 settle 链后台跑。发起失败抛出交调用方收集。
          const run = await subagents.start("spawn", spawnOpts);
          return { run: run, label: label, batchIdx: batchIdx };
        } catch (e) {
          throw new Error(label + " - " + (e && e.message ? e.message : String(e)));
        }
      };
      // v2.4.7.1: 结算段（长，后台）——等子代理跑完，成功/失败只影响 batchResults 与消号判定
      const joinOneBatch = async (h) => {
        try {
          const result = await h.run.result;
          const outText = (result.output || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
          clog("[dsh-memory] 归档批完成（" + h.label + "，stopReason=" + result.stopReason + ", 输出 " + outText.length + " 字符）");
          return { ok: true, label: h.label };
        } catch (e) {
          cwarn("[dsh-memory] 归档批失败: " + h.label + " - " + (e && e.message ? e.message : String(e)));
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
          return { file: fname, text: stripCompactionDumps(text) };
        }
      }
      return null;
    }

    // v2.3.3: 剥离 compaction 原始 dump 块（详见 latestSessionSummary）——纯文本变换，供注入/超限检查统一使用
    function stripCompactionDumps(text) {
      const lines = String(text || "").split("\n");
      const out = [];
      let skip = false;
      for (const ln of lines) {
        const isMarker = /^\s*<!-- /.test(ln);
        const isH1 = /^#\s/.test(ln);
        // v2.3.5: dump 全文归档后节名不可枚举——块内英文 H2 一律视作 dump 正文，中文 H2/H1/marker 才是边界
        const isEnH2 = /^##\s*[A-Za-z]/.test(ln);
        const isOtherH2 = /^##\s/.test(ln) && !isEnH2;
        if (!skip) {
          if (/^\s*<!-- compaction: /.test(ln)) { skip = true; continue; }
          out.push(ln);
          continue;
        }
        // 在 compaction dump 块内：吞普通行 + 英文 H2（v2.3.5 全文归档后节名不可枚举）；遇边界（marker / H1 / 中文 H2）停止吞
        // v2.4.2.2：合并写回后 dump 块相邻（中间无中文 H2 分隔）——skip 中再遇 compaction marker 必须继续吞，
        // 否则其 dump 正文全泄漏进注入面（实测 31269 字符→超阈提醒+合并维护被反复误触发）
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

    // v7：软性维护阈值（字节，超过=该整理了，仅告警不截断）
    const SIZE_WARN = { "global.md": 4608, "index.md": 4608, summary: 4096 }; // v9.1: global 4096→4608B、摘要 2048→4096B（与注入截断对齐降噪音）；v10.1: index 3072→4608B（中文索引 3393B≈1130 字符，远低于注入预算 2000 字符，3072 为 v7 旧值）
    // v10.2：硬性注入预算（字符数，slice 截断点）——与 SIZE_WARN（软字节）区分：
    //   SIZE_WARN 是"该整理了"的维护信号（中文 4608B≈1500字，远低于硬预算）；
    //   CHAR_LIMIT 是"超过注入会被 slice 截断"的硬上限（global 3000 字≈9KB、index 2000 字≈6KB、摘要 1500 字≈4.5KB）。
    //   软信号 + 硬预算双轨并存：软阈值提醒整理，硬预算保证不丢内容。
    const CHAR_LIMIT = { "global.md": 3000, "index.md": 2000, summary: 1500 };
    // v7：轮转阈值（30 天）
    const ROTATE_DAYS = 30;

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
          issues.push(s);
        }
      }
      return issues;
    }

    // v7：sessions/ 轮转——超过 30 天的日期摘要复制到 archive/ 并清空原文件
        // v9：sessions/ 轮转检查（只读）——返回超过 ROTATE_DAYS 天的日期摘要文件列表
    async function findOldSessions() {
      try {
        const target = await ctx.fs.resolve(MEMORY_ROOT + "/sessions");
        const entries = await ctx.fs.listDir(target);
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
      for (const name of await listMdNames("knowledge")) put("knowledge/" + name, name.replace(/^MEMORY-/, "").replace(/\.md$/, ""));
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
        const names = oldSessions.map((s) => s.name).join("', '");
        parts.push(
          "【dsh-memory 轮转提醒】以下会话摘要超过 " + ROTATE_DAYS + " 天，请归档到 sessions/archive/ 并清空原文件（写 ~/.dsh 若被拒，同上升级审批）：\n" +
          "执行命令（" + (process.platform === "win32" ? "pwsh" : "bash") + "）：\n" +
          (process.platform === "win32"
            ? "foreach ($f in @('" + names + "')) { $s = '" + PS_MEMORY + "\\sessions\\' + $f; Copy-Item $s '" + PS_MEMORY + "\\sessions\\archive\\' -Force; Set-Content -Path $s -Value '' }"
            : "for f in " + oldSessions.map((x) => "'" + x.name + "'").join(" ") + "; do cp '" + MEMORY_ROOT + "/sessions/$f' '" + MEMORY_ROOT + "/sessions/archive/' && : > '" + MEMORY_ROOT + "/sessions/$f'; done") + "\n" +
          "（共 " + oldSessions.length + " 个，合计 " + oldSessions.reduce((a, s) => a + s.bytes, 0) + "B）"
        );
      }

      // v10.2：超限治理提醒（软字节阈值 + 硬字符预算 双轨报告）
      // v2.4.4（A）：summary 计数已剥 intent（见 checkSizeOverflow）；文案按 isToday 分流——
      //   当日摘要由合并维护子代理自动收敛（要点面≥1500 或 intent 块≥3 自动触发），无需手动 edit；
      //   非当日摘要（昨日及更早，合并只覆盖当日）与 global/index 仍须人工精简。
      const sizeIssues = await checkSizeOverflow();
      if (sizeIssues.length > 0) {
        const lines = sizeIssues.map((i) => {
          const status = i.truncated
            ? "⚠️ 字符超硬预算，注入已截断（完整内容可用 memory_search 读取）"
            : "⚠️ 字节超软阈值（未截断，但建议整理）";
          return "- " + i.label + "：字节 " + i.bytes + "B（软阈值 " + i.byteWarn + "B）/ 字符 " + i.chars + "（硬预算 " + i.charLimit + "）→ " + status +
            (i.key === "summary" && i.isToday ? "（当日：合并维护子代理自动收敛中）" : "");
        });
        const hasTodaySummary = sizeIssues.some((i) => i.key === "summary" && i.isToday);
        const hasManual = sizeIssues.some((i) => i.key !== "summary" || (i.key === "summary" && !i.isToday));
        const manualSuggest = sizeIssues.some((i) => i.key === "summary" && !i.isToday)
          ? "非当日摘要：把可下沉细节提升到 knowledge/ 或 projects/ 对应文件（合并维护只自动覆盖当日文件）"
          : "global/index 精简：把可下沉的踩坑/配置/清单提升到 knowledge/，稳定层只留高频通用要点";
        const text =
          "【dsh-memory 超限整理提醒】以下记忆文件超限（阈值=软信号，预算=硬截断）：\n" +
          lines.join("\n") + "\n" +
          (hasTodaySummary ? "当日摘要：超限由合并维护子代理自动收敛（真实要点面≥1500 或 intent 检查点≥3 即自动触发），无需手动 edit；若连续多日仍出现本条说明合并未生效，再考虑人工精简。\n" : "") +
          (hasManual ? "处理建议：1. " + manualSuggest + "；\n2. 用 edit 原位精简（先读全量，禁止局部读+整体覆写）；\n3. 目标 = 字节 < 软阈值 且 字符 < 硬预算。写 ~/.dsh 被拒时带 sandbox_permissions 升级重试。" : "");
        parts.push(text);
      }

      // v12：知识文件过期复核提醒（解析文件头"最后更新"日期，>180 天未更新列入）
      const stale = await checkStaleKnowledge();
      if (stale.length > 0) {
        const staleLines = stale.map((s) => "- " + s.label + " → " + s.file + "（" + s.ageDays + " 天未更新）");
        parts.push(
          "【dsh-memory 过期复核提醒】以下知识文件超过 " + STALE_DAYS + " 天未更新（依据文件头「最后更新」日期），请人工复核内容是否仍有效：\n" +
          staleLines.join("\n") + "\n" +
          "处理：仍有效 → 更新文件头日期；已过时 → 精简归档或删除（文件删除后索引自动失效，无需其他操作）。写 ~/.dsh 被拒时同上升级审批。"
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
          let injectMode = "full"; let mG = false; let mI = false; let mS = false; let snapT = 0;
          const sidOfInject = agent && agent.session ? agent.session.id : null;
          const hG = createHash("sha256").update(globalMd || "").digest("hex");
          const hI = createHash("sha256").update(indexMd || "").digest("hex");
          const hS = createHash("sha256").update((latest && latest.text) || "").digest("hex");
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
                if (!mG && !mI && !mS) injectMode = "silent";
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
            if (latest && latest.text && TOPSESSION) {   // v2.3.8 F1: 【上次会话摘要】进子代理曾直接诱发 ghost 轮重写（756123d9 事故）
              if (utf8Bytes(latest.text) > SIZE_WARN.summary) {
                sizeWarnThrottled(latest.file, "摘要 " + latest.file + " 超限 " + utf8Bytes(latest.text) + "B（阈值 " + SIZE_WARN.summary + "B），建议精简[会话: " + SESSION_LABEL + "]");
              }
              // v2.3.7 L3: 分节感知截断——检查点超纲不再挤爆当日摘要
              const sumSliced = sectionAwareSlice(latest.text, CHAR_LIMIT.summary, latest.file);
              agent.inject(makeMessage(
                "<system-reminder>\n【上次会话摘要】（" + latest.file + "，衔接上次的下一步行动）\n" + sumSliced.text + "\n</system-reminder>"
              ));
              injectedParts.push("摘要(" + latest.file.slice(0, 40) + ")");
            } else if (TOPSESSION) {
              cwarn("[dsh-memory] 未找到会话摘要");
            }
            if (TOPSESSION && injectedParts.length > 0 && sidOfInject) recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS });
          } else if (injectMode === "global") {
            // 三档之画像重发：只重发 gCut（与新会话逐字同款、确定性组装）；index/摘要只通知不重发——一次性 append，落历史即冻结
            agent.inject(makeMessage(
              "<system-reminder>\n以下为跨会话持久记忆更新（dsh-memory）：用户画像/偏好自本会话上次快照后有变化，重发最新画像：\n【全局记忆·用户画像】\n" + gCut +
              (mI || mS ? "\n\n另有变化（快照不重发，防历史膨胀）：" + (mI ? " 记忆索引已更新；" : "") + (mS ? " 最近摘要有推进（" + String((latest && latest.file) || "?").slice(0, 40) + "）；" : "") : "") +
              ledgerNote +
              "\n其余新内容按需 memory_search；需要完整快照请新开会话。</system-reminder>"
            ));
            injectedParts.push("画像重发");
            recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS });
          } else if (injectMode === "notice") {
            // 三档之纯通知：不带任何快照正文（几百字）；画像读失败降级到此档并说明
            agent.inject(makeMessage(
              "<system-reminder>\n【dsh-memory·记忆库更新通知】自本会话上次快照：" + (mI ? " 记忆索引已更新；" : "") + (mS ? " 最近摘要有推进（" + String((latest && latest.file) || "?").slice(0, 40) + "）；" : "") + (mG ? " 用户画像已更新但本轮读取失败，可 memory_search 查询；" : "") +
              ledgerNote +
              " 新内容按需 memory_search，无需通读全文。</system-reminder>"
            ));
            injectedParts.push("更新通知");
            recordInjectSnapshot(sidOfInject, { g: hG, i: hI, s: hS });
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
          if (!isTopLevelSession(agent)) return decision;   // v2.3.8 F1: A 类提醒只发顶层会话——子代理转写不留提醒痕迹，也防诱导轮
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

        // 组装提醒：记忆命中为必须，skill 命中为附带
        const memLines = memHits.map(h => "- 记忆: memory_search " + JSON.stringify(h.name) + "（" + h.file + "，踩坑/现成脚本/约定" + (h.parts && h.parts.length ? "；触发词: " + h.parts.join("、") : "") + "）").join("\n");
        const skillLines = skillHits.length > 0 ? "\n" + skillHits.map(s => "- skill: 技能目录加载 " + s + "（SKILL.md）").join("\n") : "";
        const hintText = "<system-reminder>\n【dsh-memory 提示】此任务可能涉及已知领域，建议先查再动手：\n" + memLines + skillLines + "\n（纯读零成本；若无关可忽略本条）\n</system-reminder>";
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
          monitorToolCall("memory_search", { query: q }, spSid);
        } else if (toolName === "skill") {
          monitorToolCall("skill", null, null, spSid);
        } else {
          monitorToolCall(toolName, null, exec.arguments, spSid);
        }
        // v1.12.16: 过程信号探针（影子）——覆盖被 isError 漏掉的失败形态（catch 吞错/exit码）
        try {
          const cw = agentSess && ((agentSess.header && agentSess.header.cwd) || agentSess.cwd);
          if (cw) spiralBucket(spSid).ws = String(cw).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "?";   // v1.12.16.1 诊断属性；v2.0.1 写入会话桶
          const spiralFirst = spiralObserve(toolName, exec.arguments, result, !!result.isError, spSid);
          // v2.0.6: D 类提醒智能闸门——周期首次命中 × 开关 × 指数退避冷却（跟进复位/2h归零）× 批量进展豁免
          if (spiralFirst && PLUGIN_CFG.spiralRemind) {
            const nowMs = Date.now();
            const stR = SPIRAL_REMIND_AT.get(spSid) || { ts: 0, streak: 0 };
            const streak = (nowMs - stR.ts >= 120 * 60000) ? 0 : (stR.streak || 0);   // 2h 无新触发=新任务周期，退避自然归零
            const B2 = spiralBucket(spSid);
            const uniq = new Set(B2.win.map((w) => w.resKey)).size;
            const okN = B2.win.filter((w) => !w.neg).length;
            // 批量进展豁免：窗内结果多样且成功过半 → 批量循环而非空转，只记录不扰
            const batchLike = B2.win.length > 0 && uniq >= Math.ceil(B2.win.length / 2) && okN * 2 >= B2.win.length;
            const cdMs = Math.min(effectiveSpiralThresh().cooldownMin * Math.pow(2, streak), 60) * 60000;   // 指数退避 封顶60分
            if (!batchLike && nowMs - stR.ts >= cdMs) {
              SPIRAL_REMIND_AT.set(spSid, { ts: nowMs, streak: streak + 1 });
              monitorHintD();
              const agent2 = exec.agent;
              if (agent2 && typeof agent2.inject === "function") {
                const hintD = "<system-reminder>\n【dsh-memory 提示·LLM循环试错】检测到同类调用反复且负面结果占比高——大概率方向不对。建议暂停硬试：memory_search 搜当前任务关键词 + 查技能目录有无对应 skill，或换个思路/向用户确认。\n</system-reminder>";
                setTimeout(() => { try { agent2.inject(makeMessage(hintD)); } catch (e2) {} }, 0);
              }
            }
          }
        } catch (e) {}
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
        // v2.2.10 剥壳归一：run_code 内嵌套工具失败会上抛两条 isError 结果——内层裸错误（Error: X）
        // 与外层包装（Error: code run failed (exception): ToolCallError: X）。旧逻辑各记一个签名，
        // 同一错误第 2 次出现时两签名同时到 2 → 双横幅齐发（08-26 实证：hintB 全部成对、间隔 8ms）。
        const unwrapped = raw.slice(0, 300)
          .replace(/^Error:\s*code run failed \(exception\):\s*/i, "")
          .replace(/^ToolCallError:\s*/i, "")
          .replace(/^Error:\s*/i, "");
        if (!unwrapped.trim()) return;
        const disp = unwrapped.slice(0, 80);
        const sig = unwrapped.replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 150);
        if (!sig) return;
        const nowCnt = Date.now();
        const echo = MEMORY_HINT_ECHO.get(sid);
        if (echo && echo.sig === sig && nowCnt - echo.t < 1000) return;   // 同一次失败的另一条形态，不重复计数
        MEMORY_HINT_ECHO.set(sid, { sig, t: nowCnt });
        let counts = MEMORY_HINT_ERRORS.get(sid);
        if (!counts) { counts = new Map(); MEMORY_HINT_ERRORS.set(sid, counts); }
        const c = (counts.get(sig) || 0) + 1;
        counts.set(sig, c);
        if (counts.size > 50) { for (const k of counts.keys()) { if (counts.get(k) < c) counts.delete(k); } }
        // v2.2.10：异签名字段 10 分钟冷却——一个错误正在处置时，另一处旧账的错误不再插队轰炸；
        // 同签名升级（B→C）不受冷却限制，保持原有有界语义（每签名至多 B 一次 + C 一次）
        if (c === 2 || c === 3) {
          const prevBC = MEMORY_HINT_BC_LAST.get(sid);
          if (prevBC && prevBC.sig !== sig && Date.now() - prevBC.t < HINT_BC_COOLDOWN_MS) return;
          MEMORY_HINT_BC_LAST.set(sid, { t: Date.now(), sig });
          monitorHintBC(c === 2 ? "B" : "C", sig);
          const hint = c === 2
            ? "<system-reminder>\n【dsh-memory 提示】工具报错重复出现（" + disp + "）——大概率是以前踩过的坑。建议先 memory_search 搜该错误串 + 技能目录查相关 skill，再继续。\n</system-reminder>"
            : "<system-reminder>\n【dsh-memory 提示】同一工具错误已连续出现 3 次且未见根因——暂停硬试，强制建议：memory_search 搜该错误串 + 加载相关 skill（记忆里有踩坑记录大概率直接给出解法）。\n</system-reminder>";
          setTimeout(() => { try { agent.inject(makeMessage(hint)); } catch (e) {} }, 0);
        }
      } catch (e) { /* 监控/统计失败不影响会话 */ }
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

        // v1.2.0：node:fs 直写优先——摘要直接落盘 sessions/今日.md（真实 Node 环境，无沙箱限制）。
        // 不依赖 agent：即使找不到会话 agent（会话已结束/归档），摘要也已落盘，不丢记忆。
        // 成功 → 跳过提醒注入（零上下文成本、零缓存影响）；失败 → 回退 v9 提醒制（模型执行）。
        let directWritten = false;
        try {
          const marker = "<!-- compaction: " + compactionId + " -->";
          const targetPath = MEMORY_ROOT + "/sessions/" + fname;
          const targetFull = portable(targetPath);
          // 幂等：文件已含该 marker（插件重启/多会话并发）→ 跳过直写，视为已落盘
          const existing = (() => {
            try { return fs.readFileSync(targetFull, "utf8"); } catch (e) { return ""; }
          })();
          if (existing.includes(marker)) {
            directWritten = true;
            clog("[dsh-memory] 整合完成（幂等跳过）sessions/" + fname + "，大小 " + fs.statSync(targetFull).size + "B (" + compactionId + ")");
          } else {
            const archiveBlockBody = smartTrim(text, 16000, "");   // v2.3.5: 归档即全文（≤16000），memory_search 召回把手本体；注入前被 stripCompactionDumps 剥离不占预算
            const beforeLen = nodeFsWriteAppend(
              targetPath,
              "自动检查点（压缩归档）",
              marker + "\n\n" + archiveBlockBody
            );
            directWritten = true;
            clog("[dsh-memory] 完成整合 sessions/" + fname + "，大小 " + fs.statSync(targetFull).size + "B（新增摘要 " + archiveBlockBody.length + " 字符，追加前 " + beforeLen + " 字符）");
            // v1.10.0：直写后刷新 sessions 索引缓存（新摘要立即可见，漏网检测不误判）
            refreshMemorySessionsIndex();
          }
        } catch (e) {
          cwarn("[dsh-memory] node:fs 直写失败，回退提醒制:", e && e.message ? e.message : String(e));
        }

        // v2.3.3：意图检查点——压缩后异步 spawn 轻量子代理提炼「本次目标/下一步行动」，prepend 到今日摘要头部。
        // 不依赖会话 agent（parent 可空，compactOnce 内部 if(parent) 才挂）：即使会话已结束/归档也照常落盘。
        // 推迟到 setTimeout(0)，避开 session.append 发布窗口（子代理 spawn 经宿主 subagents 通道，fs 直写需窗口外）。
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

        // v9：找到该会话的 agent，注入落盘提醒（仅直写失败时）或刷新提示（直写成功时）
        const agent = agentsBySession.get(session.id);
        if (!agent || typeof agent.inject !== "function") {
          if (directWritten) {
            clog("[dsh-memory] 压缩检查点已直写（会话 agent 不可用，无需注入提醒）");
          } else {
            cwarn("[dsh-memory] 压缩检查点：直写失败且未找到会话 agent，摘要未落盘");
          }
          return;
        }
        const reminder =
          "<system-reminder>\n【dsh-memory 压缩检查点】检测到压缩事件（" + compactionId + "），以下为自动生成的会话摘要，请将其追加到记忆库 " +
          "sessions/" + fname + " 的末尾（若文件不存在则创建；已有内容先读全量再追加，禁止局部读+整体覆写）。\n" +
          "写入 ~/.dsh 若被沙箱拒绝，用 write/edit 工具带 sandbox_permissions danger-full-access + justification 升级重试（弹审批，点允许即可）。\n" +
          "小节标题建议：## 自动检查点（压缩归档）\n\n" +
          smartTrim(text, 1500, "sessions/" + fname + " 归档块") +
          "\n</system-reminder>";

        // v10.4：轻量记忆刷新提示——compact 是上下文重置点，记忆注入仍是会话开始快照；
        // 提示模型"记忆可能已更新"，需要最新内容时用 memory_search 实时读盘。
        // 不做全量重注入（成本高且多数时候文件没变）；只注入一行轻提示 + 可查清单。
        const refreshNote =
          "<system-reminder>\n【dsh-memory 记忆刷新提示】会话开始后，记忆库文件（global.md / index.md / knowledge/ / projects/ / sessions/）可能已被其他会话或本会话更新。\n" +
          "当前上下文中注入的记忆是会话开始时的快照。如需最新内容，用 memory_search 工具实时查询（如 memory_search 查 global / index / 具体主题）；\n" +
          "也可用 read 工具直接读 ~/.dsh/memory/ 下文件。\n" +
          "若你正准备写入/追加记忆（如本压缩检查点摘要），先 memory_search 或 read 读全量确认现状，避免覆盖其他会话的最新改动。\n</system-reminder>";

        // v10.5：session/event 在 session.append 发布窗口（appending=true）内同步派发；
        // 此时任何二次 session.append（agent.inject 经 Inbox.mutate 会 append 'agent/inbox/spliced'）
        // 都会触发 "session append cannot reenter" 重入异常，导致提醒注入失败、摘要永久丢失。
        // 故所有 inject 推迟到 setTimeout(0)（发布窗口之外的 macrotask）执行。
        const targetAgent = agent;
        setTimeout(() => {
          try {
            if (directWritten) {
              // v1.2.0：已直写，只注入轻量刷新提示（提醒制不再需要）
              targetAgent.inject(makeMessage(refreshNote));
              clog("[dsh-memory] 已注入记忆刷新提示（compact 后，检查点已直写）");
            } else {
              targetAgent.inject(makeMessage(reminder));
              clog("[dsh-memory] 已注入压缩检查点提醒（" + text.length + " 字符，目标 sessions/" + fname + "）");
              targetAgent.inject(makeMessage(refreshNote));
              clog("[dsh-memory] 已注入记忆刷新提示（compact 后）");
            }
          } catch (e) {
            cerr("[dsh-memory] 压缩提醒延迟注入失败:", e && e.message ? e.message : String(e));
          }
        }, 0);
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
          description: "提交记忆整合检查点（仅 dream 整合子代理使用）：把要写入记忆库的补丁装进 patches 参数。插件当场校验并落盘：成功返回 wrote 清单；失败返回错误清单（哪一条/哪个字段/为什么），请按清单修正后再次调用（可多次调用，直到全部通过）。file 必须是 ~/.dsh/memory/ 下相对路径（sessions|projects|knowledge|tools/ 或 global.md|index.md）；action ∈ replace|append|delete；content ≤128KB。",
          parameters: {
            type: "object",
            properties: {
              patches: {
                type: "array",
                description: "补丁数组，每个元素 { file, action, content, reason? }",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string", description: "记忆库相对路径" },
                    action: { type: "string", enum: ["replace", "append", "delete"], description: "replace=整文件覆盖 / append=末尾追加 / delete=删除 content 精确原文" },
                    content: { type: "string", description: "replace=新全文；append=追加内容；delete=要删除的精确原文块" },
                    reason: { type: "string", description: "变更理由（留痕）" }
                  },
                  required: ["file", "action", "content"]
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
          description: "搜索全局记忆库（~/.dsh/memory/）。参数 query：主题关键词或记忆文件相对路径（如 OA日志、长沙项目、global、index）。注意：本工具仅可在 run_code 程序内调用（await tools.memory_search({ query })），不可直接发起工具调用。",
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
        cerr("[dsh-memory] stale_archive 注册异常:", e && e.message ? e.message : String(e));
        cerr("[dsh-memory] stale_archive 注册异常:", e && e.message ? e.message : String(e));
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

      // v2.0.3：dsh_spiral_thresh —— D 类「LLM循环试错提醒」阈值自校准（/dream 整合代理分析监控数据后调用）
      // 插件侧钳制校验后写内存态+防抖落盘，规避子代理直写 .monitor.json 被插件内存态覆盖的竞态
      try {
        toolSvc.register({
          name: "dsh_spiral_thresh",
          description: "更新 D 类「LLM循环试错提醒」判定阈值（dsh-memory /dream 自校准专用）。全部字段可选；越界字段被拒绝并回退内置默认。",
          parameters: { type: "object", properties: {
            rep: { type: "number", description: "打转占比阈值 0.30~0.80（内置默认 0.45）" },
            neg: { type: "number", description: "负面结果占比阈值 0.20~0.80（内置默认 0.40）" },
            sim: { type: "number", description: "args 相似度阈值 0.50~0.90（内置默认 0.70）" },
            w: { type: "number", description: "滑窗大小 5~16（内置默认 8）" },
            cooldownMin: { type: "number", description: "同会话提醒冷却分钟数 5~60（内置默认 10）" },
            reason: { type: "string", description: "本次调整的一句话理由（记入变更日志，供审计）" }
          }, required: [] },
          output: { schema: { type: "string" }, render(_a, v) { return [{ type: "text", text: String(v) }] } },
          async execute(args) {
            const a = args || {};
            const bounds = { rep: [0.30, 0.80], neg: [0.20, 0.80], sim: [0.50, 0.90], w: [5, 16], cooldownMin: [5, 60] };
            const cur = effectiveSpiralThresh();
            const next = {}; const rejected = [];
            for (const k of ["rep", "neg", "sim", "w", "cooldownMin"]) {
              if (a[k] === undefined) continue;
              const v = k === "w" ? Math.round(a[k]) : a[k];
              if (typeof v !== "number" || !isFinite(v) || v < bounds[k][0] || v > bounds[k][1]) { rejected.push(k + "=" + a[k]); continue; }
              next[k] = v;
            }
            if (!Object.keys(next).length) return "未更新任何阈值。" + (rejected.length ? "越界被拒：" + rejected.join("、") + "。" : "") + "当前生效：rep≥" + cur.rep + " neg≥" + cur.neg + " sim≥" + cur.sim + " 窗=" + cur.w + " 冷却=" + cur.cooldownMin + "分";
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
            clog("[dsh-memory] D 类阈值变更: " + chgDesc + (a.reason ? "（" + String(a.reason).slice(0, 60) + "）" : ""));
            return "D 类阈值已更新并落盘（" + chgDesc + "）" + (rejected.length ? "，越界被拒：" + rejected.join("、") : "") + "。当前生效：rep≥" + et.rep + " neg≥" + et.neg + " sim≥" + et.sim + " 窗=" + et.w + " 冷却=" + et.cooldownMin + "分";
          }
        });
      } catch (e) {
        cerr("[dsh-memory] dsh_spiral_thresh 注册异常:", e && e.message ? e.message : String(e));
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
    function dreamProgressPatch(patch) {
      try {
        const st = readIntegrateState() || {};
        st.progress = Object.assign({}, st.progress || {}, patch, { updatedAt: Date.now() });
        writeIntegrateState(st);
      } catch (e) { /* 忽略 */ }
    }
    DREAM_PATCH = dreamProgressPatch;
    async function spawnIntegrate(agentForParent, reason) {
      const subagents = ctx.get("subagents");
      if (!subagents || typeof subagents.start !== "function") {
        cwarn("[dsh-memory] 自动整合：subagents 服务不可用，跳过");
        DREAM_TRACK = null;   // v2.2.4: 清占位防误锁
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
      let calibStats = "监控数据不足（spiralEvents<5 或无周期画像），跳过 D-threshold Self-Calibration 节";
      try {
        const md = readMonitorData();
        const se = Array.isArray(md.spiralEvents) ? md.spiralEvents : [];
        const tps = Array.isArray(md.turnProfiles) ? md.turnProfiles : [];
        if (se.length >= 5 && tps.length > 0) {
          const reps = se.map((x) => x.repRate || 0).sort((a2, b2) => a2 - b2);
          const medRep = reps[Math.floor(reps.length / 2)];
          const negs = se.map((x) => x.negRate || 0).sort((a2, b2) => a2 - b2);
          const medNeg = negs[Math.floor(negs.length / 2)];
          const spiralCycles = tps.filter((x) => x.spiralN > 0).length;
          const spiralPct = Math.round((spiralCycles / tps.length) * 100);
          const curTh = effectiveSpiralThresh();
          calibStats = "spiralEvents 共 " + se.length + " 条；repRate 中位数=" + medRep + "，negRate 中位数=" + medNeg + "；近 " + tps.length + " 个周期中打转周期占 " + spiralPct + "%；当前生效阈值 rep≥" + curTh.rep + "/neg≥" + curTh.neg + "/sim≥" + curTh.sim + "/窗" + curTh.w + "/冷却" + curTh.cooldownMin + "分";
        }
      } catch (e) { /* 统计失败按数据不足处理 */ }
      // v2.3.4(dream-hash): 候选清单注入——内容 hash 比对（账本无记录或内容变更才读；已整合且未变的自跳过）
      const stI = readIntegrateState() || {};
      const candI = listIntegrateCandidates(stI);
      const scopeText = "## Input Scope（插件已按内容 hash 比对算好，本轮只读下列文件）\n" +
        "- 必读稳定层: global.md, index.md\n" +
        (candI.sessionCands.length ? "- 候选会话: " + candI.sessionCands.join(", ") + "\n" : "- 候选会话: （无变化——已整合且内容未变的自动跳过）\n") +
        (candI.otherCands.length ? "- 其他变动: " + candI.otherCands.join(", ") + "\n" : "") +
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
"1. global.md 字符数 < 3000、index.md < 2000、每节保持精炼（对标 mimocode dream: MEMORY.md <200行/10KB）——超了就精简冗余文字、合并重复、下沉低频细节到 knowledge/，不丢事实；章节用 ## 明确分类（便于分区感知注入保留骨架）.\n" +
"2. sessions/当日文件保持 200-400 字要点+指向，细节归档 knowledge/ 或对应 project 文件.\n" +
"2b. 近3日 dump 保护（硬纪律，工具层会直接拒绝违例补丁）：今日/昨日/前日的 sessions/YYYY-MM-DD.md 中 <!-- compaction: 标记的 dump 块不得删除或减少——只可修剪要点块；清理超过 3 天文件的 dump 时须逐块给出去向指针（durable 事实已提升到哪个文件）.\n" +
"3. 移除：被新决定取代的条目、仅与单个会话相关不再成立的细节、与更强记忆重复的低信号条目.\n" +
"4. 只精简/合并/修剪，不删除仍有价值的事实；删除前 [unverified] 或明确标注.\n" +
"\n" +
"## Write Path（交付工具——落盘走 memory_dream_patch，本子代理无写文件工具）\n" +
"- 工具面：read/grep/glob/memory_search/dsh_spiral_thresh/memory_dream_patch；write/edit/pwsh/run_code 均不可用，不要尝试写文件.\n" +
"- 凡需写入/修改记忆库文件：调用 memory_dream_patch 工具，参数 { patches: [ { file, action, content, reason? } ] }——action ∈ replace|append|delete；file 为 ~/.dsh/memory/ 下相对路径（sessions|projects|knowledge|tools/ 或 global.md|index.md）；content ≤128KB.\n" +
"- 工具会当场校验并落盘：成功返回 wrote 清单；失败返回错误清单（哪一条/哪个字段/为什么）——按清单修正后再次调用，可多次调用直到全部通过.\n" +
"- 不要输出 JSON 文本/代码块；一切写入只走 memory_dream_patch 工具.\n" +
"\n" +
"\n" +
"## Efficiency\n" +"- 写入前先在内存拼好完整内容并量字符数（尤其 index.md <2000 上限），一次写对，避免写完再反复修剪.\n" +
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
"## Output — brief summary only\n" +
        "- Written files: 本次产出 DREAM_PATCH 检查点的目标文件相对路径列表（仅限 ~/.dsh/memory/ 内）\n" +
"- Consolidated: n entries added (按节列出)\n" +
"- Updated: n entries changed\n" +
"- Deleted: n entries removed\n" +
"- Skipped: reason if nothing changed\n" +
"- Health: global.md 字符/3000、index.md 字符/2000、sessions 每日字数大致范围";
      const startedAt = Date.now();
      try {
        const run = await subagents.start("spawn", {
          label: "dsh-memory-自动整合-" + reason,
          prompt: [{ type: "text", text: promptText }],
          parent: parent,
          signal: new AbortController().signal,
          maxDepth: 2,   // v2.1.0(E2): 允许一级二级拆分并发，禁更深嵌套
                    // v2.1.0(E1): 移除 write/edit——Write Path 本就要求 run_code node:fs 直写，物理杜绝沙箱写路径
          // v2.1.0(E1)+hotfix3 2026-08-28: 只物理移除 write/edit（写 ~/.dsh 必被沙箱拒）。
          //          宿主 tools.restrict(filter) 直收 toolFilter，filter 形态必须 { allow?, deny? } 对象；
          //          写 restrict: 数组会被解析成 {} → no-op 报错；写 allow: 会把 run_code 挤出工具集且不能点名补回。
          //          deny 只移除 write/edit，run_code 保留传输默认在工具集（宿主源码 dsh-tools/lib/index.js restrict() 实证）。
          // v2.3.2(dream-patch): 检查点模式后子代理零写需求 → 纯只读 allow 白名单（物理无 write/edit/pwsh），
          //          避免再出现 run_code/pwsh 绕行不确定性；run_code 为保留传输不可点名，此处亦无需它。
          toolFilter: { allow: ["read", "grep", "glob", "memory_search", "dsh_spiral_thresh", "memory_dream_patch"] },
        });
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
            const doneOk = LAST_DREAM_WROTE_AT >= startedAt;
            if (DREAM_PATCH) {
              DREAM_PATCH({
                status: doneOk ? "done" : "stopped:incomplete",
                finishedAt: Date.now(),
                durMin: u ? u.durMin : Math.round(((Date.now() - startedAt) / 60000) * 10) / 10,
                tokens: u ? ("totalIn " + (u.totalIn || u.input) + " (cache " + u.cache + ") / out " + u.output) : null,
                summary: outText.slice(0, 200)
              });
            }
            DREAM_TRACK = null;
            if (outText.length > 0 && outText.length <= 600) {
              clog("[dsh-memory] 整合报告: " + outText.replace(/\n/g, " | "));
            }
            const st = readIntegrateState() || {};
            st.lastIntegrateAt = Date.now();
            if (doneOk) { st.lastSuccessAt = Date.now(); st.integrateCount = (st.integrateCount || 0) + 1; delete st.lastFailAt; recordDreamedHashes(st); } // v2.3.3: 成功轮必须清除 lastFailAt，否则残留触发 2h 无限重试（每次烧数万 tokens）；v2.3.4: 成功即记全量 hash——下次只读内容变更过的
            else { st.lastFailAt = Date.now(); cwarn("[dsh-memory] 本次整合未通过 memory_dream_patch 落盘任何文件——2 小时后自动重试，请关注 progress.health"); }
            writeIntegrateState(st);
            trackMaintain("integ", u);
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
              if (health.length) {
                cwarn("[dsh-memory] 整合验收未过: " + health.join("; ") + "——下次整合优先处理");
                if (DREAM_PATCH) DREAM_PATCH({ health: health.join("; ").slice(0, 200) });
              } else if (dreamSnap["global.md"]) {
                clog("[dsh-memory] 整合验收通过: global/index 容量与时间戳行合规");
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
          } catch (e) {
            cwarn("[dsh-memory] 整合结算异常:", e && e.message ? e.message : String(e));
            try { const st = readIntegrateState() || {}; st.lastIntegrateAt = Date.now(); st.lastFailAt = Date.now(); writeIntegrateState(st); } catch (e2) {}
            DREAM_TRACK = null;
          }
        };
        run.result.then(async () => { await settleDream(); }).catch((e) => {
          cwarn("[dsh-memory] 自动整合子代理失败:", e && e.message ? e.message : String(e));
          if (DREAM_TRACK && DREAM_PATCH) { DREAM_PATCH({ status: "failed", error: String((e && e.message) || e).slice(0, 120) }); }
          DREAM_TRACK = null;
        });        // v2.2.4: DREAM_TRACK 占位已上移至 runDreamPipeline 入口（同步段），此处不再重设（避免刷新心跳基准）
        dreamProgressPatch({ status: "running", reason: reason, startedAt: Date.now(), steps: 0, lastTool: "-" });
        clog("[dsh-memory] 已发起自动整合子代理（" + reason + "，后台执行中；进度见 ~/.dsh/memory/.integrate.json progress 字段）");
        return true;
      } catch (e) {
        cwarn("[dsh-memory] 自动整合启动失败:", e && e.message ? e.message : String(e));
        DREAM_TRACK = null;   // v2.2.4: 启动异常清占位
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
    async function runDreamPipeline(reason, agentForParent) {
      const busyMsg = dreamBusyCheck();   // v2.2.4: 在途互斥检查
      if (busyMsg) {
        cwarn("[dsh-memory] dream 管线拒绝发起（" + reason + "）：" + busyMsg + "——已有整合在跑，等完成后再试");
        monitorEvent("integrate", "busy-rejected reason=" + reason + " (" + busyMsg + ")");
        return { ok: false, busy: true, msg: busyMsg };
      }
      DREAM_TRACK = { since: Date.now(), sessionId: null, steps: 0 };   // v2.2.4: 占位提前到同步段（原赋值在 await subagents.start 之后，快速连发存在双发窗口）
      ensureStaleNotified();
      let note = "";
      try {
        const pending = findStaleSessions(PLUGIN_CFG.staleSessionDays, getEnabledAt())
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
      return { ok: okStart === true, busy: false };
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
      ctx.interval(() => { checkIntegrate(); }, 3600000);
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
          description: "手动触发一次记忆整合（对标 mimocode /dream）：扫描历史会话，把跨会话成立的决策/踩坑/规律归类提升到 global/projects 并精简超限文件。",
          input: { hint: "/dream 无参数" },
          handler: async (inv) => {
            const r = await runDreamPipeline("手动", inv.agent);   // v2.2.4: 返回 {ok,busy,msg}
            if (r.busy) return { kind: "error", text: "已有一次整合在跑（" + r.msg + "），同一时刻只允许一条整合管线。进度见 ~/.dsh/memory/.integrate.json 的 progress 字段，等它完成后再执行 /dream。" };
            return r.ok
? { kind: "success", text: "已发起 dream 管线（后台执行中）：漏网会话先归档（silent 模式自动，其他模式待你确认后单独处理）→ 接续整合全部摘要。进度实时写入 ~/.dsh/memory/.integrate.json 的 progress 字段——任意会话问「dream 跑到哪了」即可查询；完成后控制台输出消耗报告与归档明细。" }
              : { kind: "error", text: "整合启动失败（无可用父 agent 或 subagents 服务不可用），请稍后重试。" };
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

    // v1.11.0：dispose 钩子 —— 不再置空 enabledAt！
    // DSH 退出/重启会触发 dispose，但「插件启停」已与「DSH 进程启停」解耦：
    // enabledAt 只由记忆活跃开关 active 驱动（settings watch 处理），DSH 退出不改变它。
    // dispose 只清理 /dream 命令注册，避免重复注册冲突。
    return () => {
      try { if (dreamDisposer) dreamDisposer(); } catch (e) { /* 命令清理失败不影响 */ }
      try { if (onboardDisposer) onboardDisposer(); } catch (e) { /* 同上 */ }
      try { if (updateDisposer) updateDisposer(); } catch (e) { /* 同上 */ }
    };
  }
};
