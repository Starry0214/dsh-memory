# dsh-memory

让 DeepSeek Harness（DSH）真正**记住你**：跨会话、跨项目。装好后每个新会话自动带上你的画像、偏好和最近进展，AI 不用每次都从零开始。

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆（MIT 许可），针对 DSH 生态独立实现。
> 面向开发者/维护者的技术细节见 [docs/设计文档.md](docs/设计文档.md)。

## 它能做什么

| 功能 | 一句话说明 |
|---|---|
| 🧠 自动记 | 会话开始自动注入记忆（主题账本切片 + 最近摘要），跨会话衔接 |
| 🔍 随时查 | `memory_search` / `memory_read` 检索主题；`session_search` 回查原始会话 |
| 🪶 不丢记忆 | 会话压缩、归档、整理都写入 SQLite 主题库；md 只作导出视图与人工稳定层 |
| ⚡ 主动提醒 | 已知领域/重复错误/连续失败时提醒"先查记忆"；待归类主题单行提醒 |
| 📊 用量可见 | 设置 → 通用设置 → 记忆 与统计面板（`/dsh-memory/stats`） |
| 💰 更省钱 | 注入做前缀缓存优化，稳定层内容只在实质变化时更新 |

## 安装（一行命令，约 1 分钟）

**Windows（PowerShell）**：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
```

装完**重启 DSH**。重启后启动日志出现 `[dsh-memory]` 与版本号即安装成功。

安装器会自动：

1. 下载 `install-manifest.json` + payload zip，**先校验 sha256、再逐文件校验**（失败即中止，不会半装）；
2. **自动发现目标 profile**：已注册过 dsh-memory 的 profile 全部更新；全新用户 **桌面版优先用 `profiles/desktop`**，否则 `web`（不会再装到不生效的 profile）；
3. 备份旧插件到 `_backup-<时间戳>/`，写入 `index.js` + `client/` + `memtopic/src/`，合并注册 `cordis.patch.yml`，建 `profiles/node_modules/dsh-memory` junction；
4. 新用户写入 `~/.dsh/memory/.config.json` → `memoryTopicDbEnabled: true`（主题库默认开启），写 `AGENTS.md` v4 记忆协议；
5. 若检测到**旧版 md 记忆库还没迁移**：保持 md 模式，并登记一条"待迁移"（`~/.dsh/memory/.memtopic/migrate-pending.json`）——**重启 DSH 时插件会自动迁移**，旧 md 只读导入、不删除、可回滚。

也可以显式指定 profile：`-ProfileName desktop`（PowerShell）/ `--profile desktop`（bash）。

## 老用户升级（一条命令）

**不要**手动删旧记忆、**不要**手工搬文件。直接重跑安装命令即可，然后二选一：

| 情况 | 做法 |
|---|---|
| 安装时 DSH 开着（绝大多数） | 什么都不用做：安装器已登记 pending，**重启 DSH** 后插件自动迁移（先快照，失败自动回退 md 模式） |
| 想立刻迁移 | 完全退出 DSH，然后 `install.ps1 -Migrate --yes`（macOS/Linux：`bash install.sh --migrate --yes`） |
| 迁移后想确认 | 重跑安装器加 `-CheckOnly`（sh：`--check`），看「已迁移 / 已就绪」 |
| 想回滚 | `install.ps1 -Migrate -Rollback`（sh：`--migrate` + 手工 `migrate.mjs --rollback`） |

迁移只读取旧 md：**原文不删除、不改写**；迁移完**必须重启 DSH** 才切到主题库真源。重启前旧插件仍按 md 模式工作，`memory_search` 也仍能查到旧 md（插件有 md 兜底），记忆不会"消失"。

> macOS/Linux 的 `install.sh` 是"安装 + 校验 + 注册 + 迁移提示/登记"的完整实现；但目前**不提供 `--uninstall`**（Windows 的 `install.ps1 -Uninstall` 有），卸载请删注册行后移除插件目录。

## 首次使用（约 1 分钟）

重启后的第一个会话，插件会引导你做一次「记忆初始化」：AI 会一次性问几件事（怎么称呼你、在做什么项目、日常干什么、协作人、偏好），记下来后写入主题库。之后每个新会话都自动生效。

- 想补内容：随时说「初始化记忆」或输入 `/memory-init`
- 状态查看：设置 → 通用设置 → 记忆；或 `-CheckOnly` / `--check`
- 话题账本结构：`memory_topics`（域 → 项目线 → 明细）

## 日常使用

装好后基本什么都不用做：AI 会自己 `memory_write` 沉淀、`memory_search` 检索、会话结束 `memory_archive_checkpoint` 归档。

| 动作 | 效果 |
|---|---|
| 说"查一下 XX" | AI 实时检索主题库（`memory_search` → `memory_read`） |
| 输入 `/dream` | 手动触发一次记忆整合（`memory_dream_patch`，库内整理） |
| 输入 `/memory-migrate` | 老记忆迁移报告（`--apply` 执行） |
| 输入 `/memory-update` | 检查插件是否有新版本 |

记忆数据在哪：

```
~/.dsh/memory/
├── .memtopic/mem.db   # ★真源：SQLite 主题库（主题/句子/触发词/审计）
├── .config.json       # 插件开关（memoryTopicDbEnabled 等）
├── AGENTS.md          # 人工稳定层：会话自动注入的记忆协议
├── global.md / index.md   # 人工稳定层（可直接编辑）
├── _export/           # 导出视图（插件自动导出，勿手改）
├── projects/ sessions/ knowledge/ tools/   # 导出视图（由主题库导出）
└── .memtopic/migrate-pending.json          # 待迁移登记（迁移成功后自动删除）
```

## 常见问题

**装完 DSH 启动报错（`cordis.patch.yml` 解析失败）**——旧版安装脚本可能把配置文件写坏，一条命令修复：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
```

**装了但没生效 / 工具没出现**：

1. 必须**重启 DSH**（宿主插件代码不会热更新）；
2. 跑一次 `install.ps1 -CheckOnly`（或 `bash install.sh --check`），看这四项：
   - 目标 profile 是否是桌面版实际启动的那个（`profiles/desktop`）；
   - `payload 完整性` 是否 19/19 匹配；
   - `patch 层注册` 是否「已注册」；
   - `junction` 是否「指向插件目录」（包名注册依赖它，丢了会静默不加载）。
3. 仍然不行：看控制台是否有 `[dsh-memory]` 报错，把 `-CheckOnly` 输出一起反馈。

**国内网络装不上（GitHub raw 超时）**：安装器自带 **jsDelivr 兜底**；两个源都失败时：

- 让能联网的同事下载 **`install-manifest.json` + `payload/dsh-memory-<版本>.zip`** 放到同一目录（zip 放 `payload/` 子目录）；
- 然后离线安装：`install.ps1 -LocalPayload <路径>\payload\dsh-memory-<版本>.zip`（sh：`--local-payload`）；
- 或设置 `DSH_MEMORY_RAW` 指向内网镜像后重跑。

**报 "payload zip sha256 校验失败"**：镜像/CDN 还是旧版、代理改写内容或下载中断。换源重试；离线安装请确认 manifest 与 zip 是**同一次发布**（安装器只认 manifest 里的 sha）。

**权限不足**：Windows 普通用户即可（`profiles/` 与 `~/.dsh/memory` 都在用户目录）；macOS/Linux 若安装到系统目录才需要 sudo。写 `.config.json` / AGENTS.md 失败时安装器会 WARN 并继续，不会中断。

**迁移要 node 吗？** 迁移引擎 `memtopic/src/migrate.mjs` 需要 node。安装器会自动找：`DSH_MEMORY_NODE` → PATH 里的 `node` → **DSH 桌面版自带的 Electron-as-node**（`ELECTRON_RUN_AS_NODE=1`，临时设置、用完清理）。三者都没有时**不影响安装**，只是 `-Migrate` 会提示"未找到 node"并给出手工方案（可先用 md 模式，之后再迁）。

**公司内网 / 不想联网**：同上，用 `-LocalPayload` 离线安装；升级同理。

## 升级

插件自带每日一次的新版本检查（离线/内网失败不打扰）。发现新版本时**重新运行安装命令**即可覆盖升级（幂等：先备份、不写坏配置、patch 层不会重复注册），升级后重启 DSH。

## 高级设置（一般不用动）

默认值即可直接用；想调整去 **设置 → 通用设置 → 记忆**，或改 `cordis.patch.yml` 里 `dsh-memory` 插件的 `config:`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 超过 N 天没交互的会话提醒归档 |
| `staleAction` | `remind` | 漏网会话处理方式：仅提醒 / 后台自动归档 / 需确认后归档 |
| `integrateEnabled` | `false` | 是否开启定期自动记忆整合（默认手动 `/dream`） |
| `monitorEnabled` | `true` | 使用监控（提醒/检索统计）开关 |
| `memoryTopicDbEnabled` | `true`（新装） | 主题库开关，真值在 `~/.dsh/memory/.config.json`；关掉立即回退 md 模式 |

安装脚本可配置环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | 自动发现 | 仅作日志提示；显式指定用 `-ProfileName` / `--profile` |
| `DSH_MEMORY_RAW` | GitHub raw | 插件文件下载源（内网可指镜像） |
| `DSH_MEMORY_LOCAL` | 空 | 本地 payload zip 路径（等价 `-LocalPayload` / `--local-payload`） |
| `DSH_MEMORY_MANIFEST` | 空 | 离线安装时显式指定 manifest 路径 |
| `DSH_MEMORY_NODE` | 自动 | 迁移用的 node 可执行文件（默认自动找 PATH / DSH 桌面版） |

## 面向开发者

- 变更日志 / 版本历史 → [docs/CHANGELOG.md](docs/CHANGELOG.md)
- 架构与设计决策 → [docs/设计文档.md](docs/设计文档.md)
- 老记忆迁移指南 → [docs/迁移指南.md](docs/迁移指南.md)
- 打包 payload + manifest：`node tools/sync-payload.mjs`（`--check` 校验、`--fixed-time` 可复现）
- 安装器自测（临时 DSH_HOME，绝不动真实 `~/.dsh`）：`pwsh -NoProfile -File tools/selftest-installer.ps1`
- 测试：`powershell -NoProfile -ExecutionPolicy Bypass -File test/patch-merge.tests.ps1`、`node test/onboard.unit.test.mjs`

## 许可证

MIT License
