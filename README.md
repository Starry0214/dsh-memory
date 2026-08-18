# dsh-memory

DeepSeek Harness（DSH）全局自动记忆插件：会话开始自动注入记忆、提供 `memory_search` 检索工具、压缩检查点归档提醒。

> 设计核心：**插件零写入、全部提醒制**——插件只做只读注入与检索，所有写入动作以可执行提醒注入会话，由模型执行（沙箱拒绝时升级审批一次即可）。

## 特性

| 能力 | 说明 |
|---|---|
| 会话开始注入记忆 | 稳定层（global.md + index.md）+ 最近会话摘要，自动注入到每个新会话 |
| memory_search 工具 | 主题索引 + 全文关键词搜索，实时读盘（不依赖注入快照） |
| 压缩检查点归档 | 捕获 /compact 摘要事件，注入落盘提醒，防止压缩后摘要丢失 |
| 备份 / 轮转提醒 | 记忆库 7 天备份、会话摘要 30 天轮转，到期待办注入会话 |
| 超限双轨治理 | 软字节阈值（该整理了）+ 硬字符预算（注入截断点）双轨报告 |
| 多会话去重 | 维护提醒同实例只注入第一个顶层会话，避免并发整理同一文件 |
| 前缀缓存友好 | 稳定层剥离时间戳行，只读不写，DeepSeek 前缀缓存命中率高 |

## 与 mimocode 的关系

本插件的**设计灵感来自 mimocode 的开源记忆功能**（[XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)，MIT 开源），但两者是独立的项目。

### mimocode 的记忆功能是什么

mimocode 内置**基于 SQLite FTS5 全文搜索的持久化记忆系统**，核心机制：

- **项目记忆 `MEMORY.md`** — 跨会话持久的项目知识、规则、架构决策；
- **会话检查点 `checkpoint.md`** — 结构化状态快照，由 checkpoint-writer 子智能体自动维护；
- **记忆自动注入** — 会话恢复时自动注入上下文，agent 无需重新理解项目背景；
- **预算化注入** — 用 token budget 控制注入大小、按重要性排序；
- **上下文重建/压缩** — 上下文接近上限时从 checkpoint + 记忆 + 近期消息重建，压缩点可调。

### dsh-memory 借鉴了什么

| mimocode 记忆功能 | dsh-memory 对应实现 |
|---|---|
| `MEMORY.md` 项目记忆 + 自动注入 | `global.md` + `index.md` 稳定层 + 21 个 `MEMORY-*.md` 知识文件，会话开始自动注入 |
| 记忆自动注入上下文 | session-start 注入稳定层 + 最近摘要（零操作自动生效） |
| 预算化注入（token budget） | 硬字符预算（`CHAR_LIMIT`：3000/2000/1500）+ 软字节阈值双轨治理 |
| 上下文重建/压缩点 | compact 记忆刷新提示 + 压缩检查点归档（摘要不丢失） |
| 跨会话记忆沉淀 | sessions 动态层 + 项目层分层记忆，30 天轮转归档 |

### 差异

- **生态**：mimocode 的终端 AI 编程助手；dsh-memory 是 DeepSeek Harness（Cordis 插件架构）宿主插件；
- **实现**：mimocode 用 SQLite FTS5 全文搜索 + 子智能体维护；dsh-memory 用 Markdown 文件分层 + 零写入提醒制（插件只读，写入由会话模型执行）；
- **自包含**：知识库完全在 `~/.dsh/memory/` 内，与 mimocode 目录无关，独立运行。

**一句话**：借鉴 mimocode 开源的持久化记忆设计理念（MEMORY.md + 自动注入 + 预算化注入），针对 DSH 生态独立实现，现已完全自包含。

## 优势

### 相比原生 DSH / 其他记忆方案

1. **零写入提醒制**：插件不在宿主沙箱写文件（沙箱写 `~/.dsh` 会被拒且无审批通道），改为注入可执行提醒，由会话模型带 `sandbox_permissions` 升级重试完成写入——审批一次即完成备份/归档，频率极低（7 天/次、30 天/次、压缩 1 次/会话）。
2. **前缀缓存友好**：稳定层注入前剥离时间戳行；文件只在实质变化时更新，不因"记录"而更新——避免任何字节变化导致 DeepSeek 前缀缓存全部失效（命中 0.1 元 vs 未命中 1 元/百万 tokens）。
3. **双轨超限治理**：软字节阈值（4608/4608/4096B，该整理了）+ 硬字符预算（3000/2000/1500 字符，注入截断点）分离，超限提醒注入会话而非仅 console.warn（模型不可见），截断处加显式注记。
4. **多会话去重**：维护提醒同实例只注入第一个顶层会话（查 SessionHeader.origin==='subagent'），防止多个主会话并发 edit 同一记忆文件。
5. **compact 记忆刷新**：compact 是上下文重置点但 session-start 只触发一次，故 compact 时注入轻提示"记忆可能已更新，用 memory_search 实时读盘"，避免模型基于过期快照写入。
6. **v10.5 重入修复**：修复 `session/event` 处理器内同步 `agent.inject` 触发的 "session append cannot reenter" 异常，所有 inject 推迟到 `setTimeout(0)`（发布窗口之外）执行——确保压缩检查点摘要不再丢失。
7. **路径可移植（v11）**：无硬编码绝对路径，`homedir()` + 环境变量推导，克隆即用。

### 相比 mimocode 原生记忆

- **检索**：mimocode 靠 SQLite FTS5 全文搜索；dsh-memory 除 memory_search 全文搜索外，还按主题索引（index.md 动态解析）直接命中文件，中文检索更友好。
- **维护**：mimocode 由内置子智能体自动维护；dsh-memory 用零写入提醒制 + 全量读后追加，多主会话并发安全（去重 + 防覆盖），备份一键（Copy-Item `~/.dsh/memory/*` 即含全部）。
- **自包含**：知识库完全在 `~/.dsh/memory/` 内，不依赖 mimocode 或其他工具目录。

## 安装

1. 将本仓库 `index.js` 放到 `~/.dsh/profiles/<profile>/plugins/memory/index.js`；
2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加（insert 语义，不能用覆盖写）：
   ```yaml
   - insert:
       - id: dsh-memory
         name: ./plugins/memory/index.js
         config: {}
   ```
3. 重启 DSH。启动日志出现以下行即成功：
   ```
   [dsh-memory] 已注入稳定层 (N 段)
   [dsh-memory] 已注入摘要: YYYY-MM-DD.md
   [dsh-memory] memory_search 工具已注册（ctx.tools）
   ```

## 配置

默认记忆库位置 `<homedir>/.dsh/memory/`，可用环境变量覆盖：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_HOME` | `<homedir>/.dsh` | DSH 主目录 |
| `DSH_MEMORY_ROOT` | `<DSH_HOME>/memory` | 记忆库根目录 |
| `DSH_MEMORY_BACKUP_ROOT` | `<DSH_HOME>/memory_backup` | 备份根目录 |

记忆库结构：

```
~/.dsh/memory/
├── global.md        # 全局记忆：用户画像、通用偏好、跨项目经验（稳定层）
├── index.md         # 记忆索引：主题 → 知识文件路径（稳定层）
├── knowledge/       # 知识库（21 个 MEMORY-*.md，v10 起自包含）
├── projects/        # 项目层记忆
├── sessions/        # 会话摘要（动态层）
└── tools/           # 自研工具/脚本登记
```

## 使用

- 新会话自动注入稳定层 + 最近摘要（无需操作）；
- 需要细节时调用 `memory_search(query)`（如 `memory_search 查 OA日志`、`memory_search 查 global`）；
- 备份/轮转/超限/压缩归档均以 system-reminder 提醒注入，按提示执行即可。

## 版本历史

| 版本 | 内容 |
|---|---|
| v5 | 注入（稳定层+摘要）+ memory_search 工具（固定 8 目标） |
| v6 | 压缩即归档（监听 compaction/summary 直接写 sessions/；v9 起改提醒制） |
| v7 | sessions 轮转 + 超限预警 |
| v8 | memory_search 动态解析 index.md 覆盖 21 知识文件 + 全文关键词搜索 + 备份（直接写，被沙箱拒） |
| v9 | 插件零写入，全部提醒制 |
| v9.1 | 摘要超限阈值 2048B → 4096B |
| v10 | 知识库自包含（21 个 MEMORY-*.md 复制到 knowledge/，与 mimocode 解耦） |
| v10.1 | index.md 超限阈值 3072B → 4608B |
| v10.2 | 超限治理提醒注入会话：软字节 + 硬字符双轨报告；截断注记 |
| v10.3 | 多主会话去重：维护提醒只注入第一个顶层会话；origin 判定 |
| v10.4 | compact 后轻量记忆刷新提示 |
| v10.5 | 修复 session/event 重入异常（inject 推迟到 setTimeout(0)） |
| v11 | 路径可移植化：homedir() + 环境变量，开源分发友好 |

## 许可证

MIT License
