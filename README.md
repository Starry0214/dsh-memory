# dsh-memory

DeepSeek Harness（DSH）全局自动记忆插件：会话开始自动注入记忆、`memory_search` 中文检索、压缩检查点自动落盘；v2.0 新增 **A/B/C 场景化自动提醒、提醒跟进判定、过程信号探针、dream 整合可观测与使用监控**——记忆系统从"被动存储"进化为"主动服务"。

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆功能（MIT 开源），针对 DSH 生态独立实现。
> 设计核心：**插件自持写入（node:fs 直写）+ 提醒制兜底**——压缩检查点由插件直接落盘，不依赖模型回合；写入失败时回退为可执行提醒注入会话。

## 简介

**dsh-memory** 让 DeepSeek Harness 真正"记住"你——跨会话、跨项目、零配置。每个新会话自动注入你的画像、偏好与最近进展，AI 不再每次都从零开始。

| 亮点 | 一句话价值 |
|---|---|
| 🧠 **跨会话记忆** | 会话开始自动注入记忆，经验无缝衔接，告别重复交代背景 |
| 🔍 **精准中文检索** | `memory_search` 分词 OR 匹配 + 相关度排序，中文友好、实时读盘 |
| 🪶 **自动落盘** | 压缩检查点插件直写，无需模型回合；写入失败自动回退提醒制 |
| 💰 **前缀缓存友好** | 稳定层只读 + 剥离时间戳，最大化缓存命中率，省 token 成本 |
| 🛡️ **记忆不丢失** | 压缩检查点 + 7 天备份 + 30 天轮转三重兜底 |
| ⚡ **场景化自动提醒** | 输入命中已知领域(A)/同一错误第 2 次(B)/连续失败 3 次(C) 时主动注入"先查记忆"+ 相关 skill，不靠模型自觉 |
| 📊 **使用监控** | 提醒次数/跟进率/查询词/打转探针全程量化落盘，数据驱动持续调优 |
| 🌙 **定期整合 (dream)** | 每 7 天自动将跨会话沉淀提升到全局/项目层，后台进度实时可见，消耗报告透明 |

一行命令安装，重启即用 → [安装](#安装一行命令)

## 特性

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

## 安装（一行命令）

### Windows（PowerShell）

推荐用「下载到文件再执行」方式（避免 PowerShell 5.1 下 `irm ... | iex` 直接管道交互脚本时出现的参数绑定报错）：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 -OutFile "$env:TEMP\dsh-memory-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dsh-memory-install.ps1"
```

也支持一行管道（安装脚本已改为非交互，5.1 下可正常跑）：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
```

脚本自动完成：下载插件 → 写入 `<profile>/plugins/memory/index.js` → 在 `cordis.patch.yml` 追加 insert 注册（幂等，重复执行安全）→ 提示重启。

可配置项（环境变量）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | `web` | 目标 profile |
| `DSH_MEMORY_RAW` | GitHub raw | 插件文件下载源（可指向镜像） |

### 插件可配置项

配置优先走 **设置 → 通用设置 → 记忆**（存 `~/.dsh/settings.yaml` 的 `dsh-memory` 命名空间，需安装 client 半区）；
也可在 `cordis.patch.yml` 的 `config:` 里配（作为默认层 base，settings.yaml 用户配置覆盖它）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 漏网会话检测阈值（天）：超过该天数无交互且未在记忆库落档的会话触发提醒 |
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

client 半区（设置界面入口）安装：复制 `client/` 到 `<profile>/plugins/dsh-memory-client/`，建 junction
`<profile>/profiles/node_modules/dsh-memory-client` → 它，并在 cordis.patch.yml 追加
`- insert: { id: dsh-memory-client, name: 'dsh-memory-client' }`。

安装完成后**重启 DSH**，启动日志出现以下行即成功：

```
[dsh-memory] 已注入稳定层 (N 段)
[dsh-memory] 已注入摘要: YYYY-MM-DD.md
[dsh-memory] memory_search 工具已注册（ctx.tools）
```

## 使用

- 新会话自动注入稳定层 + 最近摘要（无需操作）；
- 需要细节时调用 `memory_search(query)`（如 `memory_search 查 OA日志`、`memory_search 查 global`）；
- 压缩检查点由插件自动落盘；备份/轮转/超限以 system-reminder 提醒注入，按提示执行即可；
- `/dream` 手动触发记忆整合（后台执行，进度实时写入 `.integrate.json` 的 progress 字段——任意会话问"dream 跑到哪了"即可查询，完成后输出消耗报告）；
- 收到 A/B/C 记忆提醒后建议先 `memory_search` 再动手——插件的跟进率统计会让这套提醒越用越准。

## 为什么用 dsh-memory

- **零配置自动生效**：装好后什么都不用做，每个新会话自动注入记忆，跨会话经验无缝衔接；
- **随手检索**：会话中随时 `memory_search(query)` 查历史记忆，中文检索友好，实时读盘不依赖注入快照；
- **记忆不丢失**：压缩检查点插件直写落盘（无需模型回合）+ 7 天备份 + 30 天轮转三重兜底；
- **省钱**：前缀缓存友好，最大化命中率（命中 0.1 元 vs 未命中 1 元/百万 tokens）；
- **可控不打扰**：备份/轮转等低频维护走提醒制，审批频率极低，不后台偷偷改文件。

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

软阈值提醒整理，硬预算保证不丢内容；截断处加显式注记 `[注：原文 X 字符已截断]`，避免模型误以为"记忆就这么多"。

### 多会话并发安全

- 维护提醒同实例只注入第一个顶层会话（查 `SessionHeader.origin`），避免多个主会话并发整理同一文件；
- 写入前全量读后追加，防止覆盖其他会话的最新改动。

### compact 记忆刷新

compact 是上下文重置点，但记忆注入仍是会话开始快照（session-start 只触发一次）。故 compact 时注入轻提示"记忆可能已更新，用 memory_search 实时读盘"——不做全量重注入（浪费 token 且破坏前缀缓存）。

### 健壮性

- 修复 `session/event` 处理器内同步 `agent.inject` 触发的重入异常，所有 inject 推迟到 `setTimeout(0)`（发布窗口之外）执行，确保压缩检查点摘要不丢失；
- 路径可移植：`homedir()` + 环境变量推导，无硬编码绝对路径，克隆即用。

## 记忆库结构

```
~/.dsh/memory/
├── global.md        # 全局记忆：用户画像、通用偏好、跨项目经验（稳定层）
├── index.md         # 记忆索引：主题 → 知识文件路径（稳定层）
├── knowledge/       # 知识库（21 个 MEMORY-*.md，自包含）
├── projects/        # 项目层记忆
├── sessions/        # 会话摘要（动态层），30 天轮转到 archive/
└── tools/           # 自研工具/脚本登记
```

## 版本历史

### v2.0.0（2026-08-24 · 记忆系统完整形态）

v1.4 → v1.12 共 26 个迭代合并发布，核心跃迁：

- **A/B/C 自动提醒**（v1.12.0-11）：输入命中已知领域(A)/同一错误第 2 次(B)/连续失败 3 次(C) 时主动注入相关记忆与 skill 提示；检查/提醒解耦 + 冷却闸 + 领域去重 + 中文 bigram 关键词匹配（对标 MiMo-Code skill tokenize）；
- **提醒跟进判定四态**（v1.12.7/13/14/15/16）：followed/ignored/open/capped——任务周期窗口（A 类至下一条用户输入，B/C 类 8 调用）、未决窗口持久化跨重启续判、超限截断不计入分母；信号集扩展至 read/grep/glob 直读 .dsh/memory；
- **过程信号探针（影子模式）**（v1.12.16）：「参数打转 × 无产出」双条件识别 LLM 原地空转——回测验证试错链命中、正常翻页零误报；影子记录 turnProfiles/spiralEvents，为动态阈值自校准积累基线；
- **dream 全程可观测**（v1.12.17）：后台整合进度实时落盘 + 完成回执（tokens/时长/摘要）；消耗报告口径修正（总输入 = 未命中 + 缓存命中）+ 日志读取竞态兜底（v1.12.17.1）；
- **使用监控体系**（v1.12.0-9）：提醒/查询/错误事件全量记录，设置界面多行汇总（各类型最近触发时间/跟进率/领域分布），推送防刷屏（变化守卫 + 60s 节流）；
- **stale_archive 审批闭环 + 单主子代理归档编排**（v1.12.8）：漏网归档无感化，授权二级拆分，消除并发写竞态；
- **分区感知注入 + 整合容量修剪**（v1.12.0）：注入预算内保留章节骨架；整合 prompt 加运行时环境/写入路径/效率纪律三段（消除环境试探浪费）。

### v1.3.0（2026-08-20 · 合并发布：设置界面 + 漏网检测 + 自动整合 + 检索工具链完整版）

- **官方设置机制**：宿主插件 import `@deepseek-ai/dsh-settings` 的 `installSettingsSection`，注册 `dsh-memory` 设置命名空间（schemastery schema）；cordis.patch.yml 的 `config:` 作 base 默认层，`settings.yaml` 用户配置覆盖，`setSource` 实时生效；
- **client 半区**（`client/` 目录，独立包 `dsh-memory-client`）：声明 `dsh.client` + `exports['./client']`，DSH 前端自动加载手写 bundle（`window.__ModuleLoader__.load`），通过 `ctx.slots.inject('settings.general.item')` 在 **设置 → 通用设置 → 记忆** 注册配置行（漏网检测天数输入 + 动作下拉 remind/silent/approval），`ctx.settingsScope.bind` 读写宿主配置；无 client 半区时功能不受影响；
- **漏网会话检测**：扫描 ~/.dsh/sessions/ 下久未交互（超过 staleSessionDays 天）且未在记忆库落档的会话，注入提醒供 review 归档——兜住"没压缩 + 没自觉总结 + 已归档"的记忆死角；可配置 staleSessionDays（默认 5 天）+ staleAction（remind 仅提醒 / silent 后台静默子代理 / approval 审批后子代理）；内容导向去重（会话 id 已落档则跳过），同实例只提醒一次；
- **定期自动整合**（integrateEnabled，默认关闭）：以插件安装时间为起始，每 7 天整合一次全部记忆，触发后刷新缓存；
- **漏网归档根治 token 爆炸**：不再让子代理读原始大日志，改为插件先提取每个会话的对话消息流（过滤注入/工具噪音，8000 字符截断），再以仿真级 compact（DSH 官方同款 8 节指令）让子代理产出检查点落盘；
- **启用界限**：会话最后交互时间 < 插件最近启用时间（enabledAt）则跳过；enabledAt 由禁用→启用时刷新（与 DSH 启动解耦）；
- **性能与可观测**：sessions 索引启动缓存 + 写入后刷新；控制台输出统一时间戳（[HH:MM:SS] [dsh-memory]）。

### v1.2.0（2026-08-18 · 压缩检查点自动落盘）

- 宿主插件用 `node:fs` **直写**压缩检查点摘要到 `sessions/今日.md`（真实 Node 环境，绕过 ctx.fs 沙箱）；
- 不依赖模型回合：压缩后会话立即结束也不丢摘要（此前靠提醒制，无回合会丢失）；
- 幂等去重：带 `compactionId` 标记，重复触发/插件重启不重复追加；
- 提醒制降级为 fallback：直写失败才注入 system-reminder 由模型执行；
- 零上下文成本：直写成功时不注入摘要文本，不增加输入量、不破坏前缀缓存。

### v1.1.0（2026-08-18 · 检索质量升级）

- **memory_search 全面升级**（参考 MiMo-Code 记忆模块移植）：
  - Unicode 分词 + OR 匹配：中英文混合词拆词（"OA日志"→["OA","日志"]），修复纯子串匹配不命中；
  - 中文分段策略：1 字保留 / 2 字补单字 / 3+ 字完整段 + 首尾 2 字（去中间 bigram 噪音）；
  - 索引正则放宽：收录 `tools/*.md` 记忆文件（修复 记忆插件.md/dsh.md 永远搜不到的漏收录 bug）+ 中文文件名支持；
  - 多命中合并 top 8：TF 加权评分 + 相关度排序 + 相对下限（top×0.15）+ 绝对下限（0.6），不再"命中 1 个就返回"；
  - 精确文件名查询返回全文（保留 v8 行为）；0 结果输出升级引导（换罕见词 → read 直查 → 查 sessions）；
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