# dsh-memory 变更日志与技术参考

> 面向开发者/维护者。普通用户看 [README.md](../README.md) 即可。
> 架构与设计决策另见 [设计文档.md](设计文档.md)。
> （注：v2.4.1~v2.5.4 的逐版变更史记录于记忆库 knowledge/MEMORY-dsh-memory-v2.5.x-合并维护与dream修复.md 及 tools/记忆插件.md，本文件自 v2.5.5 起恢复同步。）

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
