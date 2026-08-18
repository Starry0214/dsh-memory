# dsh-memory

DeepSeek Harness（DSH）全局自动记忆插件：会话开始自动注入记忆、提供 `memory_search` 检索工具、压缩检查点归档提醒。

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆功能（MIT 开源），针对 DSH 生态独立实现。
> 设计核心：**插件零写入、全部提醒制**——插件只做只读注入与检索，所有写入动作以可执行提醒注入会话，由模型执行（沙箱拒绝时升级审批一次即可）。

## 特性

| 能力 | 说明 |
|---|---|
| 会话开始注入记忆 | 稳定层（global.md + index.md）+ 最近会话摘要，自动注入到每个新会话 |
| memory_search 工具 | Unicode 分词 + OR 匹配 + 相关度排序（TF 加权 + 双分数下限），实时读盘（不依赖注入快照） |
| 检索质量升级 | 中英文混合词拆词、tools/ 记忆文件收录、多命中合并 top N、精确文件名返回全文、0 结果引导 |
| 过期复核提醒 | 知识文件头"最后更新"日期 >180 天未更新时注入人工复核提醒 |
| 压缩检查点归档 | 捕获 /compact 摘要事件，注入落盘提醒，防止压缩后摘要丢失 |
| 备份 / 轮转提醒 | 记忆库 7 天备份、会话摘要 30 天轮转，到期待办注入会话 |
| 超限双轨治理 | 软字节阈值（该整理了）+ 硬字符预算（注入截断点）双轨报告 |
| 多会话去重 | 维护提醒同实例只注入第一个顶层会话，避免并发整理同一文件 |
| 前缀缓存友好 | 稳定层剥离时间戳行，只读不写，DeepSeek 前缀缓存命中率高 |

## 安装（一行命令）

### Windows（PowerShell）

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

安装完成后**重启 DSH**，启动日志出现以下行即成功：

```
[dsh-memory] 已注入稳定层 (N 段)
[dsh-memory] 已注入摘要: YYYY-MM-DD.md
[dsh-memory] memory_search 工具已注册（ctx.tools）
```

## 使用

- 新会话自动注入稳定层 + 最近摘要（无需操作）；
- 需要细节时调用 `memory_search(query)`（如 `memory_search 查 OA日志`、`memory_search 查 global`）；
- 备份/轮转/超限/压缩归档均以 system-reminder 提醒注入，按提示执行即可。

## 为什么用 dsh-memory

- **零配置自动生效**：装好后什么都不用做，每个新会话自动注入记忆，跨会话经验无缝衔接；
- **随手检索**：会话中随时 `memory_search(query)` 查历史记忆，中文检索友好，实时读盘不依赖注入快照；
- **记忆不丢失**：压缩检查点、7 天备份、30 天轮转三重兜底；
- **省钱**：前缀缓存友好，最大化命中率（命中 0.1 元 vs 未命中 1 元/百万 tokens）；
- **可控不打扰**：写入全部走提醒制，审批频率极低，不后台偷偷改文件。

## 设计理念

### 插件零写入，全部提醒制

插件 `ctx.fs` 走部署默认沙箱（workspace-write），直接写 `~/.dsh` 会被拒绝且无审批通道——审批只存在于会话工具层。因此：

- 插件只做**只读**工作：注入记忆、注册 memory_search 工具、超限预警、轮转/备份到期检查；
- 所有**写入**（备份、sessions 轮转、压缩归档）改为注入可执行提醒（system-reminder），由会话模型执行写入；
- 沙箱拒绝时模型带 `sandbox_permissions` 升级重试，用户点一次审批即完成；
- 频率极低：备份 7 天/次、轮转 30 天/次、压缩 1 次/会话。

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
- 压缩检查点归档、备份 / 轮转提醒（插件零写入，全部提醒制）；
- 双轨超限治理（软字节阈值 + 硬字符预算）；
- 多会话去重、compact 记忆刷新、session/event 重入修复；
- 路径可移植：homedir() + 环境变量（DSH_HOME / DSH_MEMORY_ROOT / DSH_MEMORY_BACKUP_ROOT）。

## 许可证

MIT License