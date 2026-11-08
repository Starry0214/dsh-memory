# digest 通道 vs session_search 覆盖分析（只读调研 + 实测）

- **对象**：`E:\工具\插件开发调整\dsh-memory-plugin`（index.js **21667 行**，2026-11-07 21:54）+ CLI `C:\Users\Starry\.dsh\tools\session-search\session-search.mjs`（766 行）+ 真机索引 `~/.dsh/session-text`（958 MB）+ 真机库 `~/.dsh/memory/.memtopic/mem.db`（只读 SQL）
- **方式**：只读代码 + 真跑命令/SQL/只读导入（未改仓库代码；原型脚本在 `%TEMP%`，不在仓库）
- **证据格式**：`index.js#行号` / `session-search.mjs#行号` / 实测命令与输出 / SQL 结果
- **关键前提（与任务书不同）**：digest 通道**已于 2026-11-05 停写**（starry 拍板、CRA 批准方案 B）：tick 调用点已注释（`index.js#16667`、`#21100`），`/subagents-archive` 已降级为下线 stub（`#21464-21476`）。代码/导出/测试仍在（`#6555-6796`、`#6847`、`#14272`、根目录 `_test-subagent-digest.mjs`）。因此本报告回答的是：**"删 digest 代码之前，session_search 是否已能覆盖它的能力"**。

## 1. 结论摘要（≤300 字）

**不能完全覆盖（当前 CLI 无 `list` 模式），但有 5 个具体缺口，最小补法是给 CLI 加 `--list` + 给 `session_search` 加 `list:true`（不新增工具，约 +140~190 行）。**
实测：digest 现成能力 = 按**活动 mtime** 列子代理 + 每会话首条任务/尾帧结论 + KB/帧/状态 + 排除插件子代理 + 落库可 memory_search + 幂等账本。session_search 的 `--replay` 虽能"列"，但按**会话首事件日**分桶：2026-11-06 磁盘上活跃 30 会话（11 顶层/19 子代理），replay 只覆盖 16 个（顶层 0/11、子代理 16/19），且只含 user 消息（无尾帧结论），也无 KB/帧/status/插件过滤（实测索引含 385 个插件子代理、198 个可被检索到）。补 `--list` 后：原型实测 **470 ms 列出 30 会话并抽出首条任务+尾帧结论**，可覆盖 digest 的列目录/首任务/尾结论/元信息/插件过滤；"落库可 memory_search"属架构差异（索引≠主题库），需接受。

## 2. digest 通道现状（要退役的对象）

| 项 | 证据 |
|---|---|
| 扫描：`~/.dsh/sessions/<ws>/<裸UUID>/`，跳过 `session-*` 顶层 | `subagentListDirs` `index.js#6647-6671`（`#6657` 跳过 session-*） |
| 排除插件子代理：读 `subagent/descriptor.label`，`^dsh-memory-` 判 plugin | `#6604`（取 label）、`#6609`（判 plugin）、`#6563`（正则）、`#6724`（跳过并记账） |
| 抽任务：前 12 帧内首条 `user/message`；抽结论：尾 5 帧内最后一条 `assistant/message`；状态：尾帧 `turn/end.reason.kind` | `#6597-6608`、`#6610-6623` |
| 元信息：sid8 · mtime · KB · 帧数 · status · label | `#6642-6646` |
| 按天聚合（按 **mtime**）：`subagentDateKey(c.mtime)` | `#6726`；块格式 `#6639-6646` |
| 落库：主题「子代理对话摘要」（T-0436）；`digest:<sid>` meta 幂等；已归档哨兵拒绝复活 | `digestBlocksToDb` `#6673-6704`（幂等 `#6695-6699`；哨兵 `#6680-6685`） |
| 触发：mtime 早于 `staleSessionDays` 天；单批 16；1h 节流；插件/过薄跳过 | `#6710-6715`、`#6724-6725`、`#6761-6774`；真机配置 `staleSessionDays=1` |
| 当前状态 | 停写：tick 注释 `#16667/#21100`；命令 stub `#21464-21476`；函数/导出仍在 `#6555-6796/#6847`；账本 `ARCHIVED_SESSIONS` `#1750/#1757-1784`；测试 `_test-subagent-digest.mjs` |

## 3. 逐条对测（#1–#10）

> 所有命令均真跑；`$cli` = `node C:\Users\Starry\.dsh\tools\session-search\session-search.mjs`。

### #1 按时间范围列举所有子代理会话（无关键词）

- **CLI 无 list 模式**：无关键词直接退出 2（实测：`node $cli --since 2026-11-06` → 打印用法 + `exit=2`；用法见 `session-search.mjs#17-25`、`#733`）。唯一"列"的能力是 `--replay`：只导出 **user/message**（`#591`），且按**缓存日目录**过滤，而缓存日 = 会话**首事件日**（`buildOneSid` `#255-262`；replay `#574-597`）。
- **实测 2026-11-06**：`node $cli --replay --since 2026-11-06 --until 2026-11-06` → 296 ms、**72 条用户消息 / 3554 行 / 442,903 B / 17 个 distinct sid**。
- **对照磁盘活动日**（按日志最新 mtime 归日）：2026-11-06 有 **30 个会话**（顶层 11 / 子代理 19）。replay 覆盖：**顶层 0/11、子代理 16/19**；缺 14 个（11 顶层 + 3 子代理：`e4436494`(生于 11-02)、`99a80181`(生于 11-05)、`a9be5115`）。
- 缺的例子实测：`--replay --sid e4436494` → 107 条消息，日期显示 **2026-11-02**（首事件日），所以不会出现在 11-06 的 replay 里。
- **结论：不能按"活动日"列举**（顶层 0%、子代理 84%）。digest 按 `mtime` 归日（`#6726`），没有这个偏差。

### #2 每个会话的首条任务（不读全文）

- **能（需后处理）**：`--replay` 返回该会话全部 user/message，第一条即任务。实测 `--replay --sid 525919d9` → 首条 `只回复 OK 两个字母，不要调用任何工具。`（228 ms，6 条）。
- **但**：replay 不截断、也不区分"注入的 system-reminder"——实测顶层会话 `32ab5e8a` 的首条 user 消息是【记忆读取纪律】system-reminder，不是用户任务。digest 同样是"首条 user/message"（`#6605`），也会踩同一坑：实测 digest 对 `e4436494` 抽出的 prompt 是 `The working directory changed from ...`（工作目录变更通知，不是任务）。**两者质量等价，digest 只是多截断 300 字（`#6643`）。**

### #3 每个会话的尾帧结论（不读全文）

- **部分能，但无"取尾帧"接口**：
  - `--replay` **不含** assistant 消息（`#591` 只 push `user/message`）→ 无法从 replay 拿结论。
  - 有关键词时可以搜到：实测 `$cli "OFFICIAL_HDR_ON_SESSION_20261106" --json` → 1.28 s、13 处，其中 `sid=e4436494 kind=assistant/message fr=1666`。
  - 无关键词时只能 `--show`：实测 `$cli --show 525919d9 --frame 8 --json` → `{"kind":"assistant/message","text":"OK"}`；但**必须先知道帧号**（来自缓存目录里的 `manifest.json`：实测 sample `frames=9`，帧 0..8）。`--show 525919d9`（不给 frame）→ `该坐标在缓存中不存在`、`exit=5`（实测）。
- **结论：不能通用地取尾帧结论**（需 keyword 或外部读 manifest 再逐帧 show）；digest 直接取尾 5 帧（`#6610-6623`）。

### #4 元信息（大小/帧数/状态/mtime）

- **不能**。实测 search `--json` 行字段只有 `{sid,seg,line,k,fr,src,x}`；`--show --json` 只有 `{day,sid,seg,ln,file,frame,kind,text}`；`--status` 只有聚合：`days=87, sids=2845, bytes=958,849,318`（units：`61 天/724 sids/16,707,883 B`）。
- 大小/帧数只存在于缓存目录 `manifest.json`（实测 sample：`size=34197, frames=9, chars=21826`；`fileRec` 结构 `session-search.mjs#333`），**CLI 不暴露**；mtime 不在 manifest（`fileRec` 无 mtimeMs）。
- **status 根本未入索引**：`KEEP_KINDS` 不含 `turn/end`（`#122`）；实测 `--kind turn/end` → 参数非法、`exit=2`（合法值：user/assistant/system/message、tool/call、tool/result、compaction/summary、unit）。
- digest 块有 `sid8 · mtime · KB · 帧 · status`（`#6642-6646`；实测 636 会话 status 分布：completed 581 / error 27 / blocked 7 / aborted 3 / 空 18）。

### #5 按天汇总（"昨天所有子代理干了什么"一句话）

- **不能**。无 summary/list 模式；`--replay` 单日 2026-11-06 输出 **3554 行 / 442 KB**（实测），要模型自己再总结。
- digest 也不是 LLM 摘要，只是按天把每条 `任务+结论` 拼成主题块（`#6639-6646`）——但它是"现成可读块"，且已落库。
- **结论：不能**；补 `--list` 后可由 agent 对结构化结果再总结（与 digest 的实际产出粒度对齐）。

### #6 落库后可被 memory_search 检索

- **不能（架构差异）**。digest 写主题库：T-0436 及拆分出的 T-0578/0579/0580 **全部 active**（SQL），`memory_search` 主题检索只跳过 archived（`index.js#7967-7973`）⇒ digest 内容可检索。session_search 的索引（958 MB）不是主题库，原文内容无法被 `memory_search` 检索。
- 但 digest 内容只是原文的**派生副本**（140 条 meta、约 140 KB 摘要）；原文检索路径 `session_search` 独立可用。是否接受该差异 = 产品取舍（见 §4/§6）。

### #7 幂等（已处理跳过，不重复消耗）

- digest：`digest:<sid>` meta 幂等（`#6695-6699`；实测 DB 中 **140 条** `digest:%` meta）+ `ARCHIVED_SESSIONS` 账本（`#6714`）。
- session_search：**查询无账本/无缓存**——同一查询连跑两次实测 **1517 ms / 1500 ms**（total 均 2633，完全等价）；索引构建有 manifest 水位增量（实测 `--build --sid 525919d9` → 357 ms，输出"日志 1236 个 / sid 1170 个 ⇒ 建 0，跳过 1，错 0，耗时 0.1s"）。
- **结论：查询幂等 N/A（每次全价）；构建幂等有（manifest 水位）**。

### #8 持久性（落库 vs 可重建索引）

- digest：内容在 SQLite 主题库（持久；当前 577 topics / 33564 sentences）。
- session_search：索引是**派生缓存**（958 MB，可 `--build` 重建；`#33` 有并发锁，`#269-283` manifest 增量）。实测索引有 **2845 个 sid**，而当前 sessions 目录只有 **1170 个**日志目录（**1676 个缓存 sid 已无对应日志目录**；反向仅 1 个磁盘 sid 未入索引）⇒ 索引会保留已删日志的内容，但**重建只扫现存日志（1170），这 1676 个会丢**。
- **结论：不同**；digest 对"日志已删"更稳，但它只覆盖 127/585 子代理会话（CRA digest-retire 已论证），原文才是真源。

### #9 排除插件自身子代理（`dsh-memory-*`）

- digest：按 `subagent/descriptor.label` 判 `^dsh-memory-`（`#6604/#6609/#6563`），跳过并记账（`#6724`）。实测 636 个子代理目录中 **385 个是插件子代理**（60.5%），251 个非插件。
- session_search：`walkLogs` 无 label 过滤（`#172-185`），索引全收。实测：搜 `"你是 dsh-memory 归档子代理"` → **259 处 / 198 个 distinct sid**；搜 `"Run one automatic memory consolidation pass"`（dream prompt）→ **142 处 / 128 个 distinct sid**；`--replay 2026-11-06` 输出里含 1 条 dream prompt。索引 `--kind` 无 `subagent/descriptor`（`#122`），所以**无法按 kind 过滤**。
- **结论：不能**（会混入 385 个插件子代理）；补 list 时可解码首帧 label 过滤（成本实测 digest 全量 636 会话 14.36 s、平均 22.6 ms/会话）。

### #10 成本（现成一句话 vs 检索 958 MB 索引）

| 操作 | 实测 |
|---|---|
| 全库检索（无日期） | 1284–1517 ms（3 次：`525919d9` 1321、`REIMB_TOTAL 360.00` 1390、`spawn_teammate` 1517/1500 两次） |
| 日期收窄检索（`--since/--until`） | **271–307 ms**（实测 2 次） |
| `--replay` 单日 | 260–296 ms（11-06：442 KB/3554 行；11-07：69 条/1962 行） |
| digest 抽取（一次性/增量） | 636 会话全量 **14,358 ms**（avg 22.6 ms/会话；单批 16 会话 ≈ 0.36 s） |
| digest 写入量 | 非插件 251 会话：任务 443,655 字 + 结论 340,234 字 = **783,889 字**（≈ 78 万字符） |
| list 原型（本报告 §5） | **470 ms** 列 30 会话并抽 first/last（cacheMap 21 / walk 369 / read 80 ms） |

**结论**：检索单次 0.3–1.5 s 可接受，但**没有 digest 那种"零查询现成块"**；若 agent 需要浏览一天 30 个会话，list 0.5 s 可接受。

## 4. 缺口清单（按严重度）

| # | 缺口 | 实测证据 | 严重度 |
|---|---|---|---|
| G1 | 不能按**活动日**列举（`--replay` 按首事件日） | 11-06：磁盘 30（11 top/19 sub）vs replay 17（top 0/11、sub 16/19），缺 3 子代理 | **高** |
| G2 | 无"取尾帧结论"能力（无 keyword 时） | replay 无 assistant；`--show` 需 frame 号（manifest 内部文件），无 frame → exit 5 | **高** |
| G3 | 无每会话元信息（KB/帧/status/mtime） | search/show JSON 无这些字段；status 未入 KEEP_KINDS，`--kind turn/end` exit 2 | 中 |
| G4 | 无按天聚合/一句话 | replay 11-06 3554 行/442 KB；无 summary 模式 | 中（digest 也只是拼接，不是 LLM 摘要） |
| G5 | 不排除插件自身子代理 | 索引含 385 个插件子代理；259 处/198 sid 可被搜到 | 中 |
| G6 | 不落库、不可 memory_search | 索引 ≠ 主题库；digest 内容在 active 主题可检索 | 低（架构取舍；原文检索独立可用） |
| G7 | 查询无幂等/缓存 | 同查询两次 1517/1500 ms | 低 |
| G8 | 索引可重建但会丢"日志已删"内容 | 缓存 2845 sid vs 现存 1170 日志目录（1676 stale） | 低 |

## 5. 最小补功能方案（评估 lead 的 `list` 模式想法）

**可行性：成立，且不需要新增工具。** 数据都在缓存里（manifest：`size/frames/chars` + segments：`k/fr/x`），活动 mtime 可 stat 源日志（实测 walk 1170 目录 369 ms），插件 label 可解码首帧（digest 已有同款逻辑 `#6597-6609`，avg 22.6 ms/会话）。

### 推荐方案：CLI 新增 `--list`，插件 `session_search` 加 `list:true`

| 改动点 | 位置 | 估计 |
|---|---|---|
| CLI 新函数 `cmdList({since,until,top/sub,excludePlugin,limit})`：① 扫 sessions 目录取日志 max mtime（活动日）② 建 `sid8→cacheDir` 映射（实测 21 ms）③ 读 manifest + segments，取首条 user/message、最后 assistant/message、size/frames/chars ④ 可选解码首帧 label 排除插件 ⑤ 输出 JSON/人读 | `session-search.mjs`：新增函数（放在 `cmdReplay` 附近 `#574-597`）+ main 分支（`#721-726` 旁）+ 参数白名单（`#729`） | **+120~160 行** |
| 插件工具加 `list:true`（+`since/until/exclude_plugin/limit`），execute 调 `$cli --list --json` 并格式化 | `index.js#18280-18305`（schema）+ `#18307-18484`（execute） | **+20~30 行** |
| 测试（list 覆盖：11-06 应 30 会话/11 top/19 sub；exclude_plugin 后数量 = 非插件子代理；首/尾字段非空率） | `test/` 新自测 | +80~120 行 |

- **原型实测**（临时脚本 `%TEMP%\list-proto.mjs`，未入库）：`2026-11-06` → **470 ms** 输出 30 会话（11 top/19 sub，含 replay 漏掉的 `32ab5e8a`/`38e5016d` 等跨日会话），每会话含 `firstUser`/`lastAssistant`/`size`/`frames`/`chars`/`mtime`。样本：`32ab5e8a` firstUser=【记忆读取纪律】system-reminder（同 digest 的质量坑）、lastAssistant=完整结论；`d374c9a8` 无 user/assistant（aborted，digest 也会输出"（未提取到首条 user/message）"）。
- **覆盖评估**：list 模式可覆盖 G1/G2/G3/G4/G5；G6（落库可 memory_search）与 G8（持久性）是架构差异，若坚持"完全等价 digest"需另加写回主题（非最小，且与"退役 digest"目标相悖）。G7 可忽略（0.5–1.5 s）。
- **更小替代（不推荐）**：
  1. 只给 `--show` 加 `--last`（按 sid 取最后 assistant）：约 40–60 行，覆盖 G2，但 G1/G3/G5 仍在。
  2. 给 `--replay` 加 `--json` + `--activity`（mtime 过滤）+ 补 assistant 尾条：约 60–80 行，但 replay 设计语义是"用户消息序列"，扩展后职责混乱，且仍无 per-session 元信息/插件过滤。
  3. 不改代码，教 agent 用 `--replay`+`--show`：G1（顶层 0%）与 G2 硬伤，不可行。

## 6. 退役路径（先停触发还是直接删？）

**现状 = 已"先停触发"**（2026-11-05）：tick 调用注释（`#16667/#21100`）、命令 stub（`#21464-21476`）、zstd 提示仍写"子代理摘要通道将跳过"（`#21488`）、banner 仍列 `subagents-archive`（`#21496`）、`COMPAT_COMMAND_NAMES` 仍含它（`#5671`）。**建议：先补 list 并验收，再删代码；不要现在直接删。**

1. **先做**：§5 的 `--list` + 验收（11-06：30 会话 / 11 top / 19 sub；exclude-plugin 后 = 251 非插件全集中的当日子集）。
2. **再删 digest 死代码**（确认 list 可用后）：
   - `index.js#6555-6796`（常量、`subagentDigestOf`、`subagentDigestBlock`、`subagentListDirs`、`digestBlocksToDb`、`runSubagentDigestBatch`、`runSubagentDigestTick`、`runSubagentDigestBackfill`）；
   - 导出 `#6847`；P5 测试钩子 `#14272`；
   - 账本 `ARCHIVED_SESSIONS` + `saveStaleNotified` + `ensureArchivedSessionsLoaded`（`#1750/#1757-1784`；**注意** `isArchivedAgent` 实际读 `workspace.json` 的 `readArchivedSessionIds()`（`#13007-13010`），不读该 Set，删除安全）；
   - 启动文案 `#21488` 与 banner `#21496` 的 `subagents-archive` 字样；
   - 测试：删/改根目录 `_test-subagent-digest.mjs`（引用 `#36/#109/#125/#137`）。
3. **必须保留**：`/subagents-archive` 命令注册 stub（`test/plugin.smoke.test.mjs#105` 期望 6 个命令含它；CRA digest-retire `#122` 也要求保留唯一"已下线"提示位）。不要删 `COMPAT_COMMAND_NAMES` 里的名字。
4. **T-0436 / T-0578 / T-0579 / T-0580 怎么处理**（实测现状）：
   - 四主题**全部 active**：T-0436 `子代理对话摘要` 43 句/39,579 字；T-0578/0579/0580 分别 40/40/21 句、39,864/39,134/21,782 字（父主题均为 T-0424，level=detail）；`digest:` meta **140 条**；审计 `topic.split` 3 次。
   - **F1 真记忆句未丢**：sentence id=33363（"存档完成…v3 通过"）现位于 **T-0578 ord=1**（拆分时迁移保留）；T-0436 ord=43 是拆分指针句（"已拆分 21 句至 T-0580…"）。
   - stub 写"观察 3 天后处理"（11-05 → **11-08 到期**）。
   - **推荐（A）**：先抽查（`session_search` 按 sid 抽 ≥10 个被摘要会话原文可检索；`memory_read` 抽查四主题无独有内容）→ **归档四主题**。理由：内容是原文派生副本、约 140 KB；归档后 `memory_search` 主题检索不可见（`#7967-7973`），但 `memory_read`/`_export` 仍可读；且当前 T-0436 **在 dream 候选里**（实测 2026-11-06 dream 任务书候选含 T-0436），保留 active 有被 dream 改写风险。注意归档不可逆（`TRANSITIONS.archived=[]`）。
   - **保守（B）**：保持 active 不再增长，但需把 `子代理对话摘要` 加入 dream 候选排除（小改动），否则会被 dream 当普通主题整理。
   - **不选**：直接删主题——无 deleteTopic 工具、不可逆，且会丢 F1 真记忆句。

## 7. 诚实缺口

1. **未跑完整 `--build`**（会写缓存/耗时 6 分钟级）：重建耗时引用两处不一致——工具描述"全库约 6 分钟"（`index.js#18274`）vs 插件注释"稳态 2.98s / 积压 8.92s / 冷建 115.2s"（`#18342`）；本次只实测单 sid 增量（357 ms，"跳过 1"）。
2. **未实测 `memory_search` 对 T-0436 的命中**（工具需在宿主 agent 内调用）；结论用"DB 四主题 active + 检索代码只排除 archived"（`#7967-7973`）推断，未跑真实工具。
3. **list 原型未实现插件 label 过滤**（prototype 只做 mtime+first/last）；插件排除成本引用 digest 实测（22.6 ms/会话、全量 14.36 s），非 list 模式实测。
4. **未做"按天一句话"的 LLM 总结实验**；但 digest 本身也不做总结（只拼 task/final），故认为 list 输出可等价。
5. 索引 stale 1676 个 sid 未逐日核对是否日志确已删除（按 sessions 目录对比推断）；重建会丢这部分内容属推断（`walkLogs` 只扫现存日志 `#172-185`、`#421-445`）。
6. 顶层会话首条任务质量未系统抽样（replay 首条可能是 system-reminder；digest 同样问题，`e4436494` 已实证）。
