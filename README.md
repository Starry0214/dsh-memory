# dsh-memory

让 DeepSeek Harness（DSH）真正**记住你**：跨会话、跨项目。装好后每个新会话自动带上你的画像、偏好和最近进展，AI 不用每次都从零开始。

**当前版本：v4.0.1** ｜ 记忆真源 = SQLite 主题库（`.memtopic/mem.db`），md 只剩「人工稳定层 + 导出视图」

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆（MIT 许可），针对 DSH 生态独立实现。
> 技术细节：[设计文档](docs/设计文档.md) ｜ [变更日志](docs/CHANGELOG.md) ｜ [迁移指南](docs/迁移指南.md)

---

## ⚠️ 4.0 有什么不一样（从 3.x 升级必读）

4.0 是**破坏性变更**：三处行为变了，升级后你能直接感觉到。**数据不会丢**（md 原样保留，只是不再被当作真源读）。

| 变化 | 你会感觉到 | 怎么办 |
|---|---|---|
| md 导出视图不再可读 | AI 打不开 `~/.dsh/memory/projects/xxx.md`、`knowledge/xxx.md` | 让它按主题读：`memory_read <主题名>` / `memory_search <关键词>`（**更好用**，能跨文件命中） |
| 整理接口拒绝裸 md 路径 | `/dream` 里传 `projects/xxx.md` 会被整批拒绝（`EXPORT_VIEW_READONLY`） | 改用 `topic: "<主题名/ID>"` 寻址；错误信息里会给出提示 |
| 容量判据从「md 文件字节」改成「主题字符」三档 | 告警里出现的是**主题**（`T-0123`），不再是文件名 | 主主题 9,000 / 明细主题 40,000 / 索引类 200,000；超了用随包工具 `split-oversized.mjs` 分段（见下） |

**想回到 3.x 行为**：编辑 `~/.dsh/memory/.config.json`，把 `memoryTopicDbEnabled` 改成 `false`，重启 DSH。md 恢复为可读可写的主路径，主题库数据仍在（不删），随时可再开。

> 为什么这么改：md 时代「读文件 → 改主题库」两边错位，导致 dream 反复处理同一批"超限文件"却永远收不干净（真机实测：dream 读到 18KB 的文件，库里对应主题只有 74 字符）。4.0 把口径统一到主题，才真正收干净（告警 12 → 0）。

---

## 它能做什么

| 功能 | 一句话说明 |
|---|---|
| 🧠 自动记 | 会话开始自动注入记忆（主题切片 + 最近摘要），跨会话衔接 |
| 🔍 随时查 | `memory_search` / `memory_read` 检索主题；`session_search` 回查原始会话原文 |
| 🪶 不丢记忆 | 会话压缩、归档、整理全部写入 SQLite 主题库；md 只作导出视图与人工稳定层 |
| ⚡ 主动提醒 | 已知领域 / 重复错误 / 连续失败时提醒"先查记忆"；待归类主题单行提醒 |
| 📊 用量可见 | 设置 → 通用设置 → 记忆；统计面板 `http://127.0.0.1:<端口>/dsh-memory/stats`（内含**知识图谱**页签，数据接口 `/dsh-memory/graph.json`） |
| 💰 更省钱 | 注入做前缀缓存优化，稳定层只在实质变化时更新（改一次时间戳 = 全部缓存失效） |

---

## 安装（一行命令，约 1 分钟）

**Windows（PowerShell）**：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
```

装完**重启 DSH**。启动日志出现 `[dsh-memory]` 与版本号即成功。

安装器会做这些（每一步都可复跑、幂等）：

1. 下载 `install-manifest.json` + payload zip，**先校验 zip 的 sha256，再逐文件校验**（20 个文件；失败即中止，不会半装）；
2. **自动发现目标 profile**：已注册过 dsh-memory 的 profile 全部更新；全新用户**桌面版优先 `profiles/desktop`**，否则 `web`；
   - 若某个 profile 是用**绝对路径**引用别的 profile 的插件目录（常见于多 profile 共用一份安装），安装器会按注册表解析真实目录，不会误报"文件缺失"、也不会装出第二份副本；
3. 备份旧插件到 `_backup-<时间戳>/`，写入 `index.js` + `memtopic/src/*.mjs`；
4. 把设置界面（`client/**`）装到 `plugins/dsh-memory-client/` 并注册 `- id: dsh-memory-client`（**通用设置 → 记忆** 半区）；
5. 新用户写 `~/.dsh/memory/.config.json` → `memoryTopicDbEnabled: true`，写 `AGENTS.md` v4 记忆协议；
6. 若检测到**旧版 md 记忆库还没迁移**：先保持 md 模式（行为零变化），登记 `~/.dsh/memory/.memtopic/migrate-pending.json`——**下次启动 DSH 时插件自动迁移**。

显式指定 profile：`-ProfileName desktop`（PowerShell）/ `--profile desktop`（bash）。

---

## 老用户升级（一条命令）

**不要**手动删旧记忆、**不要**手工搬文件。重跑安装命令即可，然后二选一：

| 情况 | 做法 |
|---|---|
| 安装时 DSH 开着（绝大多数） | 什么都不用做：已登记 pending，**重启 DSH** 后自动迁移（先快照，失败自动回退 md 模式） |
| 想立刻迁移 | 完全退出 DSH，再 `install.ps1 -Migrate --yes`（sh：`bash install.sh --migrate --yes`） |
| 迁移后想确认 | `install.ps1 -CheckOnly`（sh：`--check`），看「已迁移 / 已就绪」与 `20/20 文件 sha256 全部匹配` |
| 想回滚 | `install.ps1 -Migrate -Rollback`（sh：`migrate.mjs --rollback`） |

迁移只**读**旧 md：原文不删除、不改写；迁移完**必须重启**才切到主题库真源。重启前旧插件仍按 md 模式工作，`memory_search` 也能查到旧 md（插件有 md 兜底），记忆不会"消失"。

> `install.sh` 是"安装 + 校验 + 注册 + 迁移提示/登记"的完整实现，但**不提供 `--uninstall`**（Windows 的 `install.ps1 -Uninstall` 有）；卸载请删注册行后移除插件目录。

---

## 首次使用（约 1 分钟）

重启后第一个会话，插件会引导做一次「记忆初始化」：AI 一次性问几件事（怎么称呼你、在做什么项目、日常干什么、协作人、偏好），写入主题库后每个新会话自动生效。

- 补内容：说「初始化记忆」或输入 `/memory-init`
- 看状态：设置 → 通用设置 → 记忆；或 `-CheckOnly` / `--check`
- 看结构：`memory_topics`（域 → 项目线 → 明细，三级树）

---

## 日常使用

装好后基本什么都不用做：AI 会自己 `memory_write` 沉淀、`memory_search` 检索、会话结束 `memory_archive_checkpoint` 归档。

**斜杠命令（7 个）**

| 命令 | 作用 |
|---|---|
| `/dream` | 手动触发一次记忆整合（库内整理、去重、提升、归档） |
| `/memory-search <词>` | 检索主题库；`-u` 可关闭结果回传到会话 |
| `/session-search <词>` | 回查原始会话日志里的精确字面量（GUID/路径/报错串） |
| `/memory-migrate` | 老记忆迁移报告；加 `--apply` 执行 |
| `/memory-init` | 重新走一遍记忆初始化引导 |
| `/memory-update` | 检查插件新版本 |
| `/subagents-archive` | 归档漏网子代理会话 |

**工具（13 个）**：`memory_search` `memory_read` `memory_write` `memory_topics` `memory_dream_patch` `memory_archive_checkpoint` `memory_export` `memory_size_preview` `memory_onboard` `session_search` `stale_archive` `dsh_spiral_thresh` `dsh_maint_thresh`

**记忆数据在哪**

```
~/.dsh/memory/
├── .memtopic/mem.db        # ★唯一真源：SQLite 主题库（主题/句子/触发词/三级结构/审计）
├── .config.json            # 插件开关（memoryTopicDbEnabled 等）
├── AGENTS.md               # 人工稳定层：会话自动注入的记忆协议（定稿不改）
├── global.md / index.md    # 人工稳定层：可直接编辑（实质变化才动，别更新时间戳）
├── _export/<日期>/         # 导出快照（只读，勿手改）
├── projects/ sessions/ knowledge/ tools/   # 导出视图（由主题库导出，勿手写）
└── .memtopic/migrate-pending.json          # 待迁移登记（迁移成功后自动删除）
```

---

## 常见问题

**为什么 AI 读不到 `projects/xxx.md` 了？**（4.0 起）

那是**导出视图**，真源在主题库。让它 `memory_read <主题名>` 或 `memory_search <关键词>`——比读文件更准（能跨文件命中、带来源）。`global.md` / `index.md` / `_export/**` / `sessions/**` / `tools/**` 不受限。

**主题超限了怎么办？**（告警里出现 `主题「X」（T-0123）已达 N 字符`）

用随包工具分段（默认 dry-run，先看计划再落库，内置守恒校验）：

```bash
node <插件目录>/memtopic/src/split-oversized.mjs <db路径> --limit=40000 --ids=T-0123          # 演练
node <插件目录>/memtopic/src/split-oversized.mjs <db路径> --limit=40000 --ids=T-0123 --apply  # 落地
```

主主题上限 9,000、明细 40,000、索引类 200,000。索引类（如「精确字面量索引」）天生无限增长，按季度分片即可，不用管告警。

**想彻底回到 md 模式？** 把 `.config.json` 的 `memoryTopicDbEnabled` 设为 `false` 并重启；库数据保留，可随时再开。

**装了但没生效 / 工具没出现**

1. 必须**重启 DSH**（插件代码不热更新）；
2. 跑 `install.ps1 -CheckOnly`（或 `bash install.sh --check`），看四项：
   - 目标 profile 是否是桌面版实际启动的那个；
   - `payload 完整性` 是否 **20/20** 匹配；
   - `patch 层注册` 是否「已注册」（`dsh-memory` 与 `dsh-memory-client` 各一行）；
   - `junction` 是否「指向插件目录」（包名注册依赖它，丢了会静默不加载）；
3. 仍不行：看控制台 `[dsh-memory]` 报错，把 `-CheckOnly` 输出一起反馈。

**装完 DSH 启动报错（`cordis.patch.yml` 解析失败）**——旧版安装脚本可能写坏配置，一条命令修复：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
```

**国内网络装不上（GitHub raw 超时）**：安装器自带 **jsDelivr 兜底**；两个源都失败时：

- 让能联网的同事下载 **`install-manifest.json` + `payload/dsh-memory-<版本>.zip`** 放到同一目录（zip 放 `payload/` 子目录）；
- 离线安装：`install.ps1 -LocalPayload <路径>\payload\dsh-memory-<版本>.zip`（sh：`--local-payload`）；
- 或设置 `DSH_MEMORY_RAW` 指向内网镜像后重跑。

**报 "payload zip sha256 校验失败"**：镜像/CDN 还是旧版、代理改写内容或下载中断。换源重试；离线安装请确认 manifest 与 zip 是**同一次发布**（安装器只认 manifest 里的 sha）。

> 刚发版时 `raw.githubusercontent.com` 有约 5 分钟 CDN 缓存，可能读到上一版 manifest——等几分钟或重试即可。

**权限不足**：Windows 普通用户即可（`profiles/` 与 `~/.dsh/memory` 都在用户目录）；macOS/Linux 只有装到系统目录才需要 sudo。写 `.config.json` / `AGENTS.md` 失败时安装器 WARN 并继续，不中断。

**迁移要 node 吗？** 迁移引擎 `memtopic/src/migrate.mjs` 需要 node。安装器自动找：`DSH_MEMORY_NODE` → PATH 里的 `node` → **DSH 桌面版自带的 Electron-as-node**（`ELECTRON_RUN_AS_NODE=1`，临时设置、用完清理）。三者都没有**不影响安装**，只是 `-Migrate` 会提示"未找到 node"并给手工方案（可先用 md 模式，之后再迁）。

**公司内网 / 不想联网**：同上，用 `-LocalPayload` 离线安装；升级同理。

---

## 升级

插件自带每日一次新版本检查（离线/内网失败不打扰）。发现新版本时**重跑安装命令**即可覆盖升级（幂等：先备份、不写坏配置、patch 不会重复注册），升级后重启 DSH。

---

## 高级设置（一般不用动）

默认值即可直接用；想调整去 **设置 → 通用设置 → 记忆**，或改 `cordis.patch.yml` 里 `dsh-memory` 插件的 `config:`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 超过 N 天没交互的会话提醒归档 |
| `staleAction` | `remind` | 漏网会话处理：仅提醒 / 后台自动归档 / 需确认后归档 |
| `integrateEnabled` | `false` | 是否开启定期自动记忆整合（默认手动 `/dream`） |
| `monitorEnabled` | `true` | 使用监控（提醒/检索统计）开关 |
| `memoryTopicDbEnabled` | `true`（新装） | 主题库开关，真值在 `~/.dsh/memory/.config.json`；关掉立即回退 md 模式 |

安装脚本环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | 自动发现 | 仅作日志提示；显式指定用 `-ProfileName` / `--profile` |
| `DSH_MEMORY_RAW` | GitHub raw | 插件文件下载源（内网可指镜像） |
| `DSH_MEMORY_LOCAL` | 空 | 本地 payload zip 路径（等价 `-LocalPayload` / `--local-payload`） |
| `DSH_MEMORY_MANIFEST` | 空 | 离线安装时显式指定 manifest 路径 |
| `DSH_MEMORY_NODE` | 自动 | 迁移用的 node（默认自动找 PATH / DSH 桌面版） |

---

## 面向开发者

- 变更日志 / 版本历史 → [docs/CHANGELOG.md](docs/CHANGELOG.md)
- 架构与设计决策（含**容量三档口径**、**去 md 化硬闸**）→ [docs/设计文档.md](docs/设计文档.md)
- 老记忆迁移指南 → [docs/迁移指南.md](docs/迁移指南.md)
- 打包 payload + manifest：`node tools/sync-payload.mjs`（`--check` 校验、`--fixed-time` 可复现；当前 20 文件）
- 安装器自测（临时 DSH_HOME，绝不动真实 `~/.dsh`）：
  - `pwsh -NoProfile -File tools/selftest-installer.ps1`（**85** 断言）
  - `bash tools/selftest-installer.sh`（**37** 断言，覆盖全新装 / 幂等 / 老用户迁移 / 宿主运行中安全降级 / consumer profile）
- 测试：`node test/split-oversized.check.mjs`（**23** 断言）、`node test/plugin.smoke.test.mjs`、`node test/onboard.unit.test.mjs`、`powershell -NoProfile -ExecutionPolicy Bypass -File test/patch-merge.tests.ps1`

---

## 许可证

MIT License
