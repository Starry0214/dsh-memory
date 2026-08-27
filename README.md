# dsh-memory

让 DeepSeek Harness（DSH）真正**记住你**：跨会话、跨项目、零配置。装好后每个新会话自动带上你的画像、偏好和最近进展，AI 不用每次都从零开始。

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆（MIT 许可），针对 DSH 生态独立实现。
> 面向开发者/维护者的技术细节见 [docs/设计文档.md](docs/设计文档.md)。

## 它能做什么

| 功能 | 一句话说明 |
|---|---|
| 🧠 自动记 | 会话开始自动注入你的记忆，跨会话衔接，不用重复交代背景 |
| 🔍 随时查 | 会话里说"查一下 OA 日志 / 查 global"，AI 会用 `memory_search` 实时检索记忆库 |
| 🪶 不丢记忆 | 会话压缩时自动落盘，即使会话立刻结束也不丢；另有备份与轮转兜底 |
| ⚡ 主动提醒 | 遇到已知领域/重复错误/连续失败时，AI 会自动提醒"先查记忆"，越用越准 |
| 📊 用量可见 | 设置界面可看提醒次数、检索次数、token 消耗等统计 |
| 💰 更省钱 | 记忆注入做前缀缓存优化，命中率高、成本低 |

## 安装（一行命令）

**Windows（PowerShell）**：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
```

装完**重启 DSH**。重启后启动日志出现下面几行即安装成功（没有则以"遇到问题"一节排查）：

```
[dsh-memory] 就绪 v2.3.0：...
[dsh-memory] memory_search ...
```

## 首次使用（约 1 分钟）

重启后的第一个会话，插件会引导你做一次「记忆初始化」：AI 会一次性问几件事（怎么称呼你、在做什么项目、日常干什么、协作人、偏好），记下来后写入记忆库。之后每个新会话都自动生效。

- 想补内容：随时说「初始化记忆」或输入 `/memory-init`
- 暂时不想弄：直接说"回头再说"，24 小时内不再打扰
- 状态查看：设置 → 通用设置 → 记忆

## 日常使用

装好后**基本什么都不用做**，记忆自动沉淀。偶尔想起来可以用：

| 动作 | 效果 |
|---|---|
| 普通对话 | 记忆已自动注入，正常聊即可 |
| 说"查一下 XX" | AI 实时检索记忆库里的相关历史 |
| 输入 `/dream` | 手动触发一次记忆整合（把散落经验提炼进全局记忆，后台执行） |
| 输入 `/memory-update` | 手动检查插件是否有新版本 |

## 遇到问题

**装完 DSH 启动报错（cordis.patch.yml 解析失败）**——旧版安装脚本可能把配置文件写坏，一条命令修复：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
```

**怎么看有没有装好**：重启后控制台搜 `[dsh-memory]`，看到 `就绪 v` 和 `memory_search` 即正常；命令行输入 `/memory-update` 应回复当前版本。

**感觉没生效**：确认是重启后的**新会话**（宿主插件改动需重启才加载），且记忆库目录 `~/.dsh/memory/` 下能看到 `global.md`、`index.md`。

**公司内网装不了（GitHub 不通）**：让能联网的同事把 `index.js`、`install.ps1`、`version.txt` 拷到内网，设置环境变量 `DSH_MEMORY_RAW` 指向内网地址再运行安装命令；或直接用 `DSH_MEMORY_LOCAL` 指定本地 `index.js` 文件离线安装（见下方环境变量表）。

## 升级

插件自带每日一次的新版本检查（离线/内网失败不打扰）。发现新版本时直接**重新运行安装命令**即可覆盖升级（安全幂等，不会写坏配置），升级后重启 DSH。

也可以随时输 `/memory-update` 手动检查。

## 高级设置（一般不用动）

默认值即可直接用；想调整去 **设置 → 通用设置 → 记忆**，或改 `cordis.patch.yml` 里 `dsh-memory` 插件的 `config:`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 超过 N 天没交互的会话提醒归档 |
| `staleAction` | `remind` | 漏网会话处理方式：仅提醒 / 后台自动归档 / 需确认后归档 |
| `integrateEnabled` | `false` | 是否开启定期自动记忆整合（默认手动 `/dream`） |
| `monitorEnabled` | `true` | 使用监控（提醒/检索统计）开关 |

安装脚本可配置环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | `web` | 安装到哪个 profile |
| `DSH_MEMORY_RAW` | GitHub raw | 插件文件下载源（内网可指镜像） |
| `DSH_MEMORY_LOCAL` | 空 | 本地 index.js 路径，设置后不联网直接安装 |

## 记忆库放在哪

```
~/.dsh/memory/
├── global.md     # 全局记忆：画像、偏好、跨项目经验
├── index.md      # 记忆索引
├── knowledge/    # 知识库（按主题分文件）
├── projects/     # 项目层记忆
├── sessions/     # 会话摘要（自动落盘）
└── tools/        # 自研工具/脚本登记
```

## 面向开发者

- 变更日志 / 版本历史 → [docs/CHANGELOG.md](docs/CHANGELOG.md)
- 架构与设计决策 → [docs/设计文档.md](docs/设计文档.md)
- 测试：`powershell -NoProfile -ExecutionPolicy Bypass -File test/patch-merge.tests.ps1`、`node test/onboard.unit.test.mjs`、`node test/plugin.smoke.test.mjs`

## 许可证

MIT License
