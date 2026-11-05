# dsh-memory

让 DeepSeek Harness（DSH）真正**记住你**：跨会话、跨项目。装好后每个新会话自动带上你的画像、偏好和最近进展，AI 不用每次都从零开始。

**v4.5** ｜ 记忆真源 = **SQLite 主题库**（`.memtopic/mem.db`）｜ md 只剩「人工稳定层」与「导出视图」

> **4.5 更新**：会话笔记 `memory_note`（默认动作 + 15% 档位提醒）｜ 压缩后**拦截式重灌**（不再有失忆窗口）｜ 检查点/笔记/项目/画像**四段注入**（6100 字上限）｜ 流式文本退化熔断 ｜ 漏网归档链整体移除（-2860 行）。
> 从 4.0.x 升级：重跑安装命令 + 重启 DSH 即可，**无需迁移数据**（见[迁移指南](docs/迁移指南.md)）。

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

`/dream` 做四件事：**笔记提炼（4.5 主职责）→ 跨会话提升 → 去重/纠错 → 超限收敛**。

- **笔记优先**：候选 = 最多 10 个笔记主题 + 其他活跃主题补足到 20（无笔记时就是原来的 20 个，零回归）；会话检查点不进候选
- 任务书带「**会话笔记提炼**」块：读笔记主题 → 按**七类映射**写入对应项目主题 / `global.md`（工作风格与硬规则、跨任务可迁移事实、Bug + 修复、设计决策、精确字面量逐字复制、长期引文、不确定就保留原处），提炼后标「已提炼 → T-xxxx」
- **结论时效索引**：dream 每轮刷新主题 `结论时效表·自动索引`（哪些主题有「作废/失效/推翻/更正」标记、各几条），明细用 `memory_search` 现查

4.0 起在库模式下加了**两道硬闸**（避免"读导出视图、改主题库"的错位）：

| 闸 | 行为 |
|---|---|
| 写入口 | `memory_dream_patch` 收到**裸导出视图路径** ⇒ 整批拒绝（`EXPORT_VIEW_READONLY`），提示改用 `topic:"<主题名/ID>"`；先拒后写，**绝不半批落盘** |
| 读入口 | `read`/`grep`/`glob` 命中 `projects/`、`knowledge/` 下的 `.md` ⇒ 拒绝，提示用 `memory_read` / `memory_search` |

**放行**：`global.md` / `index.md`（人工稳定层）、`_export/**`（导出快照）、`sessions/**` 与 `tools/**`（导出视图，只读放行）。
实测证据：生成 dream 任务书全过程对导出视图 md 的读取 **0 次**。

### 5️⃣ 会话记忆流水：压缩不丢记忆

| 时机 | 落点 |
|---|---|
| 上下文压缩 | 检查点写入「会话检查点」线下的**当天主题**（`YYYY-MM-DD`），幂等键 = compactionId（同一压缩不重复写） |
| 压缩后（下一次请求前） | **拦截式重灌**：先等检查点写好（上限 120 秒，可中止），再一次性补回**四段**——检查点 2400 + 会话笔记 1900 + 项目 1150 + 画像 350（body 合计 5800，整块上限 6100 字）；带「以本段为准」优先级标注与截断恢复指针 |
| 会话进行中（随时） | 主 agent 用 `memory_note` 写本会话笔记（append-only、不进上下文；dream 整合时提炼进长期库） |
| 日摘要过期（>N 天） | 库内 `archiveTopic(pointer:true)`：状态置 archived、父主题留指针，**原文仍可 `memory_read`** |
| 会话结束 | 4.5 起**没有**自动归档工具：关键内容用 `memory_write`（长期）/ `memory_note`（暂存）；压缩检查点仍自动写 |

> 为什么压缩后要「等」：实测压缩 02:05:51 → 模型 02:06:53(+62s) 继续跑 → 重灌块 02:07:48(+117s) 才注入，前 55 秒是在失忆状态下思考。4.5 让宿主在下一次请求前等检查点写好（writer 实测 75.6 秒，上限 120 秒），超时自动降级、绝不卡会话。

### 6️⃣ 主动提醒：在你犯同样错误之前

| 类型 | 触发 |
|---|---|
| A 关键词命中 | 当前任务涉及已登记领域（提示"先查记忆"） |
| B 重复错误 | 同一错误再次出现 |
| C 连续失败 | 同一步连续失败 |
| E/W 循环空转 | 重复占比 / 负面占比超阈值；长时间无介入 |
| 会话笔记 | 上下文占用每跨 **15%** 提醒一次（15/30/45/60/75/90%；同会话 60s 冷却；压缩后从 15% 重来） |
| 流式退化熔断 | 生成中途检测到同一句重复 ≥20 次 ⇒ **立即 cancel 本次生成**（不等整条消息落地） |
| 熔断 | 同指纹反复失败 ⇒ 停轮 / 停手 |

阈值可调（`dsh_spiral_thresh`），面板可见各类计数。

### 7️⃣ 前缀缓存优化：省的是真钱

DeepSeek 前缀缓存命中 **0.1 元/百万 tokens**，未命中 **1 元**——差 10 倍。插件把注入拆成
`[系统提示+工具定义] → [稳定记忆] → [最近摘要] → [用户消息]`，**稳定层只在实质变化时才改**（改一次时间戳 = 该文件及其后的缓存全部失效）。

### 8️⃣ 看得见：设置页 / 统计面板 / 知识图谱

- **设置 → 通用设置 → 记忆**：开关、阈值、用量、**子代理摘要回溯天数**
- **统计面板** `http://127.0.0.1:<端口>/dsh-memory/stats`：主题/句子规模、状态分布、TOP 命中、近 30 天事件量、熔断与告警计数
- **知识图谱**（统计面板内页签）：三级树 + 触发词/来源边，可交互缩放搜索；节点带 `kind`（笔记 / 检查点 / 普通主题**三色区分**）；数据接口 `/dsh-memory/graph.json`

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

装完**重启 DSH**；启动日志出现 `[dsh-memory] 就绪 v4.5（构建 <8 位指纹>）` 即成功。

安装器做的事（每步可复跑、幂等）：

1. 下载 `install-manifest.json` + payload zip → **先校验 zip sha256，再逐文件校验（20 个文件）**，失败即中止、不会半装；
2. **自动发现 profile**：已注册过 dsh-memory 的全部更新；全新用户**桌面版优先 `profiles/desktop`**，否则 `web`；
   若某 profile 用**绝对路径**引用别的 profile 的插件目录（多 profile 共用一份安装），按注册表解析真实目录，不误报、不装第二份；
3. 备份旧插件到 `_backup-<时间戳>/`，写入 `index.js` + `memtopic/src/*.mjs`；
4. 设置界面（`client/**`）装到 `plugins/dsh-memory-client/` 并注册 `- id: dsh-memory-client`；
5. 新用户写 `.config.json`（`memoryTopicDbEnabled: true`）+ `AGENTS.md` v4 记忆协议；
6. 检测到旧 md 记忆库未迁移 ⇒ 先保持 md 模式（行为零变化）+ 登记 `migrate-pending.json`，**下次启动自动迁移**；
7. **升级用户**：`AGENTS.md` 若仍是原始 v4 模板（sha256 `45463dd5…`）⇒ **自动替换为新版**；你改过的保留并提示（不覆盖）。**4.0.x → 4.5 无需迁移数据**。

显式指定 profile：`-ProfileName desktop`（sh：`--profile desktop`）。

### 首次使用

重启后第一个会话会引导一次「记忆初始化」：AI 一次性问几件事（怎么称呼你、在做什么项目、日常干什么、协作人、偏好），写入主题库后每个新会话自动生效。
补内容：说「初始化记忆」或 `/memory-init`。

---

## 四、从 3.x 升级

4.0 是**破坏性变更**，三处行为变了。**数据不会丢**（md 原样保留，只是不再当真源读）。

> **已经是 4.0.x？** 不用做下面的 md 迁移：重跑安装命令 + 重启 DSH 即可，**主题库数据原样保留**；`AGENTS.md` 若仍是原始 v4 模板会被自动替换，你改过的保留并提示。行为变化与逐步验证见[迁移指南第 6 节](docs/迁移指南.md)。

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

装好后基本什么都不用做：AI 会自己 `memory_write` 沉淀、`memory_search` 检索、随时 `memory_note` 记会话笔记（压缩时自动写检查点，并在压缩后拦截式重灌）。

### 斜杠命令（7 个）

| 命令 | 作用 |
|---|---|
| `/dream` | 手动触发记忆整合（笔记提炼 → 提升 → 去重 → 收敛） |
| `/memory-search <词>` | 检索主题库；`-u` 关闭结果回传到会话 |
| `/session-search <词>` | 回查原始会话日志里的精确字面量（GUID/路径/报错串） |
| `/memory-migrate` | 老记忆迁移报告；`--apply` 执行 |
| `/memory-init` | 重走记忆初始化引导 |
| `/memory-update` | 检查插件新版本 |
| `/subagents-archive` | **已下线（4.5）**：子代理摘要通道退役，只回一条提示；查子代理会话用 `session_search` |

### 工具（12 个，另有 2 个 dream 专用）

| 分组 | 工具 |
|---|---|
| 检索 | `memory_search` `memory_read` `memory_topics` `session_search` |
| 写入 | `memory_write` `memory_note` |
| 整理 | `memory_dream_patch` `memory_size_preview` `memory_export` |
| 维护 | `memory_onboard` `dsh_spiral_thresh` `dsh_maint_thresh` |

> `memory_split_topic` / `memory_review_topic` 仅 **dream 整合子代理**可用（普通会话调用返回 `DREAM_ONLY`），用于按语义分片主题、裁决待审队列。

### 记忆数据在哪

```
~/.dsh/
├── AGENTS.md               # 人工稳定层：会话自动注入的记忆协议（定稿不改；在 memory 同级）
└── memory/
    ├── .memtopic/mem.db        # ★唯一真源：主题库（主题/句子/触发词/三级结构/审计）
    ├── .config.json            # 插件开关（memoryTopicDbEnabled 等）
    ├── global.md / index.md    # 人工稳定层：可直接编辑（实质变化才动，别更新时间戳）
    ├── _export/<日期>/         # 导出快照（只读）
    ├── projects/ sessions/ knowledge/ tools/   # 导出视图（由主题库导出，勿手写）
    └── .memtopic/migrate-pending.json          # 待迁移登记（迁移成功后自动删除）
```

---

## 六、常见问题

**AI 读不到 `projects/xxx.md` 了？** 那是导出视图，真源在主题库。让它 `memory_read <主题名>` 或 `memory_search <关键词>`——更准（跨文件命中、带来源）。`global.md` / `index.md` / `_export/**` / `sessions/**` / `tools/**` 不受限。

**主题超限了怎么办？** 见「容量三档治理」的 `split-oversized.mjs`；明细/索引类提示可以忽略（它们本来就不该被反复催）。

**升级 4.5 后工具/命令变了？** `memory_archive_checkpoint`、`stale_archive` 已随漏网归档链删除；`/subagents-archive` 只回一条下线提示（查子代理会话用 `session_search`）；新增 `memory_note`。**数据不需要迁移**，详见[迁移指南第 6 节](docs/迁移指南.md)。

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
| `staleSessionDays` | `5` | **子代理摘要回溯天数**（4.5 起面板改名；不再是「漏网会话」检测阈值，漏网归档链已删除） |
| `staleAction` | `remind` | **已废弃（4.5）**：面板控件已删除、无行为分支；仅为兼容旧配置保留，改它没有效果 |
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
