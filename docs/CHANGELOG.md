# dsh-memory 变更日志与技术参考

> 面向开发者/维护者。普通用户看 [README.md](../README.md) 即可。
> 架构与设计决策另见 [设计文档.md](设计文档.md)。

## 版本（最新 v2.3.0）

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
