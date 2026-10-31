# dsh-memory

让 DeepSeek Harness（DSH）真正**记住你**：跨会话、跨项目。装好后每个新会话自动带上你的画像、偏好和最近进展，AI 不用每次都从零开始。

**v4.0.1** ｜ 记忆真源 = **SQLite 主题库**（`.memtopic/mem.db`）｜ md 只剩「人工稳定层」与「导出视图」

> 设计灵感来自 [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 的开源持久化记忆（MIT 许可），针对 DSH 生态独立实现。
> 技术细节 → [设计文档](docs/设计文档.md) ｜ 版本历史 → [变更日志](docs/CHANGELOG.md) ｜ 老库迁移 → [迁移指南](docs/迁移指南.md)

---

## 一、4.0 的核心变化：从「记文件」到「记主题」

3.x 时代，`~/.dsh/memory/*.md` 既当**存储**又当**注入源**：AI 读 md、改 md、把 md 塞进上下文。文件一多就散，容量靠"字节数"判，整理时**读的是文件、写的是别处**——真机实测 dream 读到 18KB 的文件，库里对应主题只有 74 字符，于是同一批"超限文件"永远收不干净。

4.0 把**真源**换成 SQLite 主题库，md 降级为两种只读角色：

| | 3.x | 4.0 |
|---|---|---|
| 真源 | `*.md` 文件 | **`.memtopic/mem.db`**（主题 + 句子 + 触发词 + 三级结构 + 审计） |
| 组织方式 | 平铺文件（按目录/日期） | **三级主题树**：域 → 项目线 → 明细 |
| 检索 | 关键词扫文件 | 主题检索（名称/触发词/正文），可跨文件命中 |
| 容量口径 | md 文件字节 | **主题字符**，按层级三档 |
| 整理 | 改文件 | 按**主题**增删改（CAS 校验，冲突整条回滚） |
| md 角色 | 存储 + 注入源 | **人工稳定层**（`global.md`/`index.md`/`AGENTS.md`）+ **导出视图**（`_export/`、`projects/`…） |

**收益**：数据一致（不再读 A 写 B）、可查询（三级树 + 触发词）、可治理（容量/归档按主题）、可回滚（每次写入留审计）。

---

## 二、核心特性

### 1️⃣ 三级主题树：结构化，而不是一堆文件

```
域（domain）→ 项目线（project）→ 明细（detail）
例：招投标与交易平台 → 长沙交易场地智能化 → 「招标文件解析」明细
```

- 真机实例规模：**10 域 / 36 项目线 / 410 明细 / 0 未归类**
- 每条明细可挂**触发词**（如 `OA日志`、`智检API`），会话里一提就命中
- 结构可维护：`memory_topics` 看全树；整理时按主题移动/合并/拆分

### 2️⃣ 唯一真源 + 导出视图（自动、只读）

- 所有写入都进主题库；`_export/<日期>/memory-export-*.md` 是**自动导出快照**（结构变更触发，**30 分钟节流**；会话触发额外要求距上次导出 **> 6 小时**）
- `projects/` `sessions/` `knowledge/` `tools/` 也是导出视图：**别手写**，改内容请改主题库
- 导出失败只告警，**绝不影响写入路径**

### 3️⃣ 容量三档治理：按主题算，不按文件算

| 层级 | 上限（字符） | 说明 |
|---|---|---|
| 主主题（域/项目线，会被注入切片） | **9,000** | 超了会催「连续 N 轮未处理」+ 建议 splitTopic/提炼 |
| 明细主题（`level=detail`） | **40,000** | 不进注入层、靠 `memory_read` 按需读；超了只提示分段，**不催轮次** |
| 索引类（如「精确字面量索引」） | **200,000** | §9.12③ 要求逐字保存、天生无限增长；只提示「按季度分片」 |

超限了用**随包工具**自救（默认 dry-run，先看计划；内置守恒校验）：

```bash
node <插件目录>/memtopic/src/split-oversized.mjs <db路径> --limit=40000 --ids=T-0123          # 演练
node <插件目录>/memtopic/src/split-oversized.mjs <db路径> --limit=40000 --ids=T-0123 --apply  # 落地
```

它会从**尾部**反复切走 ≤limit 的句块，子主题自动继承父节点（不产生孤儿），并校验「句数/字符数前后必须相等」。

### 4️⃣ dream 治理管线：只按主题整理，绝不读写错位

`/dream` 做四件事：**漏网会话归档 → 跨会话提升 → 去重/纠错 → 超限收敛**。

4.0 起在库模式下加了**两道硬闸**（避免"读导出视图、改主题库"的错位）：

| 闸 | 行为 |
|---|---|
| 写入口 | `memory_dream_patch` 收到**裸导出视图路径** ⇒ 整批拒绝（`EXPORT_VIEW_READONLY`），提示改用 `topic:"<主题名/ID>"`；先拒后写，**绝不半批落盘** |
| 读入口 | `read`/`grep`/`glob` 命中 `projects/`、`knowledge/` 下的 `.md` ⇒ 拒绝，提示用 `memory_read` / `memory_search` |

**放行**：`global.md` / `index.md`（人工稳定层）、`_export/**`（导出快照）、`sessions/**` 与 `tools/**`（漏网归档链路要用）。
实测证据：生成 dream 任务书全过程对导出视图 md 的读取 **0 次**。

### 5️⃣ 会话记忆流水：压缩不丢记忆

| 时机 | 落点 |
|---|---|
| 上下文压缩 | 检查点写入「会话检查点」线下的**当天主题**（`YYYY-MM-DD`），幂等键 = compactionId（同一压缩不重复写） |
| 日摘要过期（>N 天） | 库内 `archiveTopic(pointer:true)`：状态置 archived、父主题留指针，**原文仍可 `memory_read`** |
| 会话结束 | `memory_archive_checkpoint` 进归档队列（不写 `sessions/*.md`） |
| 漏网会话 | 超 `staleSessionDays` 天未交互 ⇒ 按 `staleAction` 提醒 / 自动归档 / 审批归档 |

### 6️⃣ 主动提醒：在你犯同样错误之前

| 类型 | 触发 |
|---|---|
| A 关键词命中 | 当前任务涉及已登记领域（提示"先查记忆"） |
| B 重复错误 | 同一错误再次出现 |
| C 连续失败 | 同一步连续失败 |
| E/W 循环空转 | 重复占比 / 负面占比超阈值；长时间无介入 |
| 熔断 | 同指纹反复失败 ⇒ 停轮 / 停手 |

阈值可调（`dsh_spiral_thresh`），面板可见各类计数。

### 7️⃣ 前缀缓存优化：省的是真钱

DeepSeek 前缀缓存命中 **0.1 元/百万 tokens**，未命中 **1 元**——差 10 倍。插件把注入拆成
`[系统提示+工具定义] → [稳定记忆] → [最近摘要] → [用户消息]`，**稳定层只在实质变化时才改**（改一次时间戳 = 该文件及其后的缓存全部失效）。

### 8️⃣ 看得见：设置页 / 统计面板 / 知识图谱

- **设置 → 通用设置 → 记忆**：开关、漏网策略、阈值、用量
- **统计面板** `http://127.0.0.1:<端口>/dsh-memory/stats`：主题/句子规模、状态分布、TOP 命中、近 30 天事件量、熔断与告警计数
- **知识图谱**（统计面板内页签）：三级树 + 触发词/来源边，可交互缩放搜索；数据接口 `/dsh-memory/graph.json`

---

## 三、快速开始（约 1 分钟）

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
```

装完**重启 DSH**；启动日志出现 `[dsh-memory]` 与版本号即成功。

安装器做的事（每步可复跑、幂等）：

1. 下载 `install-manifest.json` + payload zip → **先校验 zip sha256，再逐文件校验（20 个文件）**，失败即中止、不会半装；
2. **自动发现 profile**：已注册过 dsh-memory 的全部更新；全新用户**桌面版优先 `profiles/desktop`**，否则 `web`；
   若某 profile 用**绝对路径**引用别的 profile 的插件目录（多 profile 共用一份安装），按注册表解析真实目录，不误报、不装第二份；
3. 备份旧插件到 `_backup-<时间戳>/`，写入 `index.js` + `memtopic/src/*.mjs`；
4. 设置界面（`client/**`）装到 `plugins/dsh-memory-client/` 并注册 `- id: dsh-memory-client`；
5. 新用户写 `.config.json`（`memoryTopicDbEnabled: true`）+ `AGENTS.md` v4 记忆协议；
6. 检测到旧 md 记忆库未迁移 ⇒ 先保持 md 模式（行为零变化）+ 登记 `migrate-pending.json`，**下次启动自动迁移**。

显式指定 profile：`-ProfileName desktop`（sh：`--profile desktop`）。

### 首次使用

重启后第一个会话会引导一次「记忆初始化」：AI 一次性问几件事（怎么称呼你、在做什么项目、日常干什么、协作人、偏好），写入主题库后每个新会话自动生效。
补内容：说「初始化记忆」或 `/memory-init`。

---

## 四、从 3.x 升级

4.0 是**破坏性变更**，三处行为变了。**数据不会丢**（md 原样保留，只是不再当真源读）。

| 变化 | 你会感觉到 | 怎么办 |
|---|---|---|
| md 导出视图不再可读 | AI 打不开 `projects/xxx.md` | 用 `memory_read <主题名>` / `memory_search <关键词>`（更准） |
| 整理接口拒绝裸 md 路径 | `/dream` 传 `projects/xxx.md` 被整批拒 | 改用 `topic: "<主题名/ID>"`（错误信息里有提示） |
| 容量判据改成主题三档 | 告警里是 `T-0123` 而不是文件名 | 见「容量三档治理」，或直接忽略明细/索引类提示 |

**升级步骤**（不要手动删旧记忆、不要手工搬文件）：

| 情况 | 做法 |
|---|---|
| 安装时 DSH 开着（绝大多数） | 重跑安装命令即可：已登记 pending，**重启 DSH** 后自动迁移（先快照，失败自动回退 md 模式） |
| 想立刻迁移 | 完全退出 DSH → `install.ps1 -Migrate --yes`（sh：`bash install.sh --migrate --yes`） |
| 想确认状态 | `install.ps1 -CheckOnly`（sh：`--check`）：看「已迁移/已就绪」+ `20/20 文件 sha256 全部匹配` |
| 想回滚迁移 | `install.ps1 -Migrate -Rollback`（sh：`migrate.mjs --rollback`） |

迁移只**读**旧 md：原文不删不改；迁移完**必须重启**才切到主题库真源。重启前旧插件仍按 md 模式工作，`memory_search` 也能查到旧 md（有 md 兜底），记忆不会"消失"。

**想彻底回到 3.x 行为**：`.config.json` 里 `memoryTopicDbEnabled: false` + 重启。md 恢复为可读写主路径，主题库数据保留（不删），随时可再开。

---

## 五、日常使用

装好后基本什么都不用做：AI 会自己 `memory_write` 沉淀、`memory_search` 检索、会话结束 `memory_archive_checkpoint` 归档。

### 斜杠命令（7 个）

| 命令 | 作用 |
|---|---|
| `/dream` | 手动触发记忆整合（归档 → 提升 → 去重 → 收敛） |
| `/memory-search <词>` | 检索主题库；`-u` 关闭结果回传到会话 |
| `/session-search <词>` | 回查原始会话日志里的精确字面量（GUID/路径/报错串） |
| `/memory-migrate` | 老记忆迁移报告；`--apply` 执行 |
| `/memory-init` | 重走记忆初始化引导 |
| `/memory-update` | 检查插件新版本 |
| `/subagents-archive` | 归档漏网子代理会话 |

### 工具（13 个）

| 分组 | 工具 |
|---|---|
| 检索 | `memory_search` `memory_read` `memory_topics` `session_search` |
| 写入 | `memory_write` `memory_archive_checkpoint` |
| 整理 | `memory_dream_patch` `memory_size_preview` `memory_export` |
| 维护 | `stale_archive` `memory_onboard` `dsh_spiral_thresh` `dsh_maint_thresh` |

### 记忆数据在哪

```
~/.dsh/memory/
├── .memtopic/mem.db        # ★唯一真源：主题库（主题/句子/触发词/三级结构/审计）
├── .config.json            # 插件开关（memoryTopicDbEnabled 等）
├── AGENTS.md               # 人工稳定层：会话自动注入的记忆协议（定稿不改）
├── global.md / index.md    # 人工稳定层：可直接编辑（实质变化才动，别更新时间戳）
├── _export/<日期>/         # 导出快照（只读）
├── projects/ sessions/ knowledge/ tools/   # 导出视图（由主题库导出，勿手写）
└── .memtopic/migrate-pending.json          # 待迁移登记（迁移成功后自动删除）
```

---

## 六、常见问题

**AI 读不到 `projects/xxx.md` 了？** 那是导出视图，真源在主题库。让它 `memory_read <主题名>` 或 `memory_search <关键词>`——更准（跨文件命中、带来源）。`global.md` / `index.md` / `_export/**` / `sessions/**` / `tools/**` 不受限。

**主题超限了怎么办？** 见「容量三档治理」的 `split-oversized.mjs`；明细/索引类提示可以忽略（它们本来就不该被反复催）。

**装了但没生效 / 工具没出现**

1. 必须**重启 DSH**（插件代码不热更新）；
2. `install.ps1 -CheckOnly`（sh：`--check`）看四项：目标 profile 是否是实际启动那个 / `payload 完整性` 是否 **20/20** / `patch 层注册` 是否 `dsh-memory` 与 `dsh-memory-client` 各一行 / `junction` 是否指向插件目录；
3. 仍不行：看控制台 `[dsh-memory]` 报错，把 `-CheckOnly` 输出一起反馈。

**装完 DSH 启动报错（`cordis.patch.yml` 解析失败）** —— 旧版安装脚本可能写坏配置：

```powershell
irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
```

**国内网络装不上（GitHub raw 超时）**：安装器自带 **jsDelivr 兜底**；都失败时离线装：

- 下载 **`install-manifest.json` + `payload/dsh-memory-<版本>.zip`** 放同一目录（zip 放 `payload/` 子目录）；
- `install.ps1 -LocalPayload <路径>\payload\dsh-memory-<版本>.zip`（sh：`--local-payload`）；
- 或 `DSH_MEMORY_RAW` 指向内网镜像。

**报 "payload zip sha256 校验失败"**：镜像/CDN 还是旧版、代理改写内容或下载中断。换源重试；离线安装确认 manifest 与 zip 是**同一次发布**。

> 刚发版时 `raw.githubusercontent.com` 有约 **5 分钟 CDN 缓存**，可能读到上一版 manifest——等几分钟或重试。

**迁移要 node 吗？** 迁移引擎 `memtopic/src/migrate.mjs` 需要 node。安装器自动找：`DSH_MEMORY_NODE` → PATH 的 `node` → **DSH 桌面版自带 Electron-as-node**（`ELECTRON_RUN_AS_NODE=1`，临时设置、用完清理）。都没有也**不影响安装**，只是 `-Migrate` 会给手工方案（可先用 md 模式，之后再迁）。

**权限不足**：Windows 普通用户即可（都在用户目录）；macOS/Linux 只有装到系统目录才需要 sudo。写 `.config.json` / `AGENTS.md` 失败时 WARN 并继续。

---

## 七、高级设置（一般不用动）

默认即可用；想调整去 **设置 → 通用设置 → 记忆**，或改 `cordis.patch.yml` 里 `dsh-memory` 的 `config:`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `staleSessionDays` | `5` | 超过 N 天没交互的会话提醒归档 |
| `staleAction` | `remind` | 漏网会话处理：仅提醒 / 后台自动归档 / 需确认后归档 |
| `integrateEnabled` | `false` | 是否开启定期自动整合（默认手动 `/dream`） |
| `monitorEnabled` | `true` | 使用监控（提醒/检索统计） |
| `memoryTopicDbEnabled` | `true`（新装） | 主题库开关，真值在 `.config.json`；关掉立即回退 md 模式 |

安装脚本环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | 自动发现 | 仅日志提示；显式用 `-ProfileName` / `--profile` |
| `DSH_MEMORY_RAW` | GitHub raw | 插件下载源（内网可指镜像） |
| `DSH_MEMORY_LOCAL` | 空 | 本地 payload zip（等价 `-LocalPayload` / `--local-payload`） |
| `DSH_MEMORY_MANIFEST` | 空 | 离线安装显式指定 manifest |
| `DSH_MEMORY_NODE` | 自动 | 迁移用的 node |

---

## 八、面向开发者

**文档**：[设计文档](docs/设计文档.md)（含「主题库容量三档口径」「去 md 化硬闸」两节）｜ [变更日志](docs/CHANGELOG.md) ｜ [迁移指南](docs/迁移指南.md)

**测试矩阵**（全部可复跑；用临时 `DSH_HOME`，绝不动真实 `~/.dsh`）

| 套件 | 命令 | 断言数 |
|---|---|---|
| 插件侧 11 门 | `node _verify/<name>.mjs`（overlimit-tier / dream-nomd / sink / compat / migrate-notice / panel / dream-patch / p6 / p5 / intent / archive） | **481** |
| 安装器（PowerShell） | `pwsh -NoProfile -File tools/selftest-installer.ps1` | **85** |
| 安装器（bash） | `bash tools/selftest-installer.sh` | **37** |
| 拆分工具 | `node test/split-oversized.check.mjs` | **23** |
| 其他 | `node test/plugin.smoke.test.mjs`、`node test/onboard.unit.test.mjs`、`test/patch-merge.tests.ps1` | — |

**打包**：`node tools/sync-payload.mjs`（`--check` 校验、`--fixed-time` 可复现；当前 **20** 文件）

---

## 九、许可证

MIT License
