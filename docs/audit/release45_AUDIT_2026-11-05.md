# dsh-memory 4.0.1 → 4.5.0 发布变更风险审计（CRA）

- **审计对象**：`E:\工具\插件开发调整\dsh-memory-plugin`（branch `main`，HEAD `189b619`，**改动未提交**）
- **审计日期**：2026-11-05
- **审计员**：release45-cra（独立只读审计员；未改代码、未构建、未部署、未推送 git）
- **审计依据**：`change-risk-audit` skill 8 项清单 + 观测门 G-0/G-1/G-3/G-9/G-9.2
- **审计方式**：静态审阅（两安装器全分支）+ **安装器级实测**（在 `%TEMP%` 的一次性 `DSH_HOME` 沙箱内跑真实安装器，真机 `~/.dsh` 前后 sha 一致 `6b87ffe5…`，未受影响）+ 产出物逐字节校验
- **前提**：插件侧 4.5 行为（`memory_note` / 15% 提醒 / 拦截式重灌 / 漏网归档链删除 / 子代理摘要通道退役）按"已在此前部署验证"接受，本报告只审**发布与升级路径**，不重审这 5 项行为本身的语义。

---

## 0. 结论先行

### 判定：**PASS-with-findings（有条件批准发布）**

**批准发布，但发布前必须完成 4 项"必须修"**（其中 3 项是 1~3 行改动，1 项是一条 `git add` 命令）：

| 编号 | 必须修 | 为什么阻塞 | 成本 |
|---|---|---|---|
| **M1** | `git add payload/dsh-memory-4.5.0.zip` 后再提交；push 后 `curl -I` 验证远端 zip 200 | zip 当前是 **untracked**，而 `install-manifest.json` 是 tracked。若提交时漏掉 zip，**所有走远程安装的用户在 [2/8] 直接失败** | 1 条命令 |
| **M2** | `install.ps1` 的 `-CheckOnly` 补 `legacy-v4` 分支（并把 `legacy-v4` 计入体检 issues） | **已实测复现**：4.0.1 未改用户在 `-CheckOnly` 下被打印成 `WARN 无法读取`，而这正是文档推荐的验证入口 | 3 行 |
| **M3** | `install.sh` 的 `--check` 区分 `legacy-v4`（当前把"待升级的 4.0.1 模板"报成 `OK v4 协议`） | 与 M2 同源；sh 用户得到**相反方向的错误诊断**（以为已是最新） | 3 行 |
| **M4** | 安装模式对「marker=v4 但 sha≠payload 模板」的文件改文案：不再打印"已是 v4 协议（跳过）"，改为"检测到旧版 v4 模板/你改过 → 未覆盖，请手工合并 §2.5"并给出模板路径 | **已实测复现**：老用户只改了一个字（4.0.1 模板 + 1 处编辑）→ 安装器打印 `OK AGENTS.md 已是 v4 协议（跳过）`，**既没升级也没提示**；这正是"对 agent 有感"缺口的唯一可见性来源，当前是谎报 | 2 处文案/分支 |

> M2/M3/M4 都只影响**提示与诊断**，不改变写入语义（当前不会误覆盖用户文件）；但它们是本次发布核心诉求（老用户升级可感知、agent 协议不静默缺失）的直接落点，且成本极低，因此定为发布前必修。

**另有 6 项"强烈建议（不阻塞）"与 9 项"可接受但需记录"，见 §8 / §9。**

**是否批准发布**：✅ **批准**。在 M1~M4 完成后可提交并推送；不完成 M1 则**不可推送**（会发布一个远端装不上的版本）。

---

## 1. G-0 观测门：本次发布是否基于观测？

| 待证事实 | 结论 | 证据（实测） |
|---|---|---|
| 旧 v4 模板 sha `45463dd5…` 是**实测算出**而非猜测 | ✅ 成立，且比"算一遍"更强：**与 4.0.1 已发布 payload 内的字节完全一致** | 解压 `payload/dsh-memory-4.0.1.zip` 内 `AGENTS.template.md`（6038 B）→ raw sha256 = `45463dd5…`，归一化 sha256 = `45463dd5…`，与 `install.ps1#L254` 白名单逐字相同；且 `git log -- AGENTS.template.md` 显示该模板自 `c20c332`(v3.5.6) 起**再未修改**（4.0.0/4.0.1 沿用），故 4.0.x 未改用户**全部**被这一个 sha 覆盖 |
| `version.txt` 三段格式是脚本**实测要求** | ✅ 成立 | `tools/sync-payload.mjs#L118-123`：`if (!/^\d+\.\d+\.\d+$/.test(v)) fail("version.txt does not look like x.y.z: " + JSON.stringify(v))`；本次 `version.txt` 实测 5 bytes = `4.5.0`（无结尾换行，与 4.0.1 同格式，`git diff` 确认） |
| 归一化口径与白名单 sha 同源 | ✅ 成立 | 用 4 组 fixture 实测 `install.ps1#L316-327` 的 `Get-NormalizedAgentsText`：CRLF、BOM+CRLF+行尾空格+多余尾部空行 三种"用户被动改形"均还原为 `45463dd5…`；改一个字 → 不同（符合"保留"设计）；无结尾换行 → 不同（见 §9.1 的 ps1/sh 差异） |

> G-0 判定：**PASS**。本次发布的核心假设（旧模板 sha、version.txt 格式、归一化口径）全部有字节级实测支撑。

---

## 2. 表 1：调用链与语义（含可疑点）

### 2.1 安装器主链（install.ps1，install.sh 为镜像）

| # | 调用点 / 函数 | 文件#行号 | 语义 | 可疑点 / 证据 |
|---|---|---|---|---|
| 1 | 模式分派 | `install.ps1#L2586-2598` | Uninstall / Migrate / CheckOnly / Install | 顶层 `try/catch` 只打印错误 + `exit 1`，**没有回滚**；异常发生在 [7/8] 时插件已被替换 |
| 2 | manifest 解析 | `#L1546-1553`；`ConvertTo-Manifest #L824-839` | 校验 `version/files/zip` 字段形状 | **不校验** `manifest.version` == payload 内 `version.txt`/`package.json`/`PLUGIN_VERSION`（见 S2） |
| 3 | zip 获取 + sha256 | `#L1555-1590` | 本地/远程取 zip，sha 不符 → **中止且未改任何文件** | 失败即停（fail-closed），✅ 安全 |
| 4 | 解压 + 逐文件 sha | `#L1592-1603`；`Test-PayloadFiles #L861-874` | 20 文件逐个 bytes+sha 校验 | 失败即停（fail-closed），✅ 安全 |
| 5 | 迁移预检 / schema-too-new | `#L1608-1635` | 在**碰插件之前**判断旧 md/库版本 | `SCHEMA_TOO_NEW` → `return 2` 且未写任何文件，✅ 顺序正确 |
| 6 | 备份 + 写插件文件 | `#L1637-1667`；`Backup-PluginDir #L876-892`；`Copy-PayloadToPlugin #L894-915` | 先备份再覆盖；`client/**` 落到**兄弟目录** `dsh-memory-client` | ①备份清单是 `index.js/package.json/memtopic/client/AGENTS.template.md`，但 **client 实际不在 `$PluginDir/client`** → 备份里没有 client；②`version.txt` 不在备份清单 → **回滚会留下新 version.txt**（见 §9.4） |
| 7 | 记忆库骨架 + `.config.json` + pending | `#L1669-1700` | 只补缺失的 key/文件；`memoryTopicDbEnabled` 已有则保留用户值 | 不覆盖用户设置，✅；pending 只服务"旧 md 迁移"，**不服务 AGENTS 升级** |
| 8 | **AGENTS.md 升级** | `#L1702-1716` → `Update-AgentsFile #L1008-1035` → `Get-AgentsState #L982-1006` → `Get-NormalizedAgentsText #L316-327` → 白名单 `#L251-255` | 6 分支：missing→写新模板；v4→跳过；legacy-v3/legacy-v4→备份+覆盖；其余→保留 | ⚠️ `v4` 分支对"4.0.1 模板 + 用户改过"**与"已是最新"不可区分**，都打印"已是 v4 协议（跳过）"（M4）；⚠️ `unreadable` 会落进 `Update-AgentsFile` 末尾的 `user-modified`（文案错误）；⚠️ 写入用 `Write-TextNoBom #L296-301`（`File.WriteAllText`，**非原子、无写后校验**） |
| 9 | patch 层注册 | `#L1718-1747` | 幂等注册 `cordis.patch.yml` | 失败 `return 1`，**不回滚**已写的插件/AGENTS（自愈路径=重跑） |
| 10 | `-CheckOnly` AGENTS 段 | `#L2062-2071`；issues `#L2135` | 只读体检 | 🔴 **`switch` 没有 `'legacy-v4'`** → 落 `default` 打印"无法读取"；issues 只判 `legacy-v3` → legacy-v4 不会出现在"体检结论"（M2，已实测复现） |

### 2.2 install.sh 镜像链

| # | 调用点 | 文件#行号 | 语义 | 与 ps1 的等价性 |
|---|---|---|---|---|
| 11 | payload 校验 | `install.sh#L487-495` | 逐文件 sha 不符 → `die`（未改文件） | ✅ 等价 |
| 12 | 插件写入顺序 | `#L521-593` | 备份→写插件→开关/pending→**AGENTS [7/8]** | ✅ 与 ps1 同序（AGENTS 最后） |
| 13 | AGENTS 升级 | `#L594-629` | missing→cp；v4 marker→判 `LEGACY_SHA_3` 决定升级/保留；否则 v3 白名单 | ✅ 语义等价；⚠️ 备份 `cp -f` **未加 `\|\| die`**，备份失败仍继续覆盖（S1） |
| 14 | `--check` AGENTS 段 | `#L340-347` | 只 `grep v4 marker` | 🔴 legacy-v4 被报成 `OK v4 协议`（M3） |
| 15 | 归一化 | `#L602-608` | sed 去 CR/行尾空白 + awk 去尾部空行 + 逐行 `print`（**每行必带 `\n`**） | ⚠️ 与 ps1 在"无结尾换行"文件上**不等价**（实测模拟，见 §9.1） |

### 2.3 产出物生产链

| # | 调用点 | 文件#行号 | 语义 | 可疑点 |
|---|---|---|---|---|
| 16 | payload 收集 | `tools/sync-payload.mjs#L103-116` | 固定 4 个根文件 + `client/**` + `memtopic/src/*.mjs` | ✅ 与 manifest 20 文件一致 |
| 17 | 版本读取 | `#L118-123` | 三段格式硬校验 | ✅ G-0 依据 |
| 18 | 一致性检查 | `#L304-343`（`--check`） | zip 必须等于"按当前源码重建"的字节；manifest `version/files/zip` 必须一致（`generatedAt` 豁免） | ✅ 强校验；⚠️ **`--check` 路径不调用 `versionHints()`**，三处版本不一致不报（S2） |
| 19 | 三处版本交叉校验 | `#L266-288`（`versionHints`） | `package.json` / `index.js PLUGIN_VERSION` ≠ `version.txt` → **仅 WARN** | ⚠️ 只在写入路径打印，不 fail-closed（S2） |

### 2.4 插件侧（4.5 行为面，仅列与发布/升级相关的接线）

| # | 位置 | 语义 | 对升级的意义 |
|---|---|---|---|
| 20 | `index.js#L635` | `PLUGIN_VERSION = "4.5.0"` | 三处版本之一；`/memory-update` 与 CheckOnly 用它判断已装版本 |
| 21 | `index.js#L17823-17917` | `memory_note` 工具注册（含 `SUBAGENT_SKIP` `#L17871`） | 老 AGENTS 未替换时，**这是 agent 仍能发现 memory_note 的第二来源** |
| 22 | `index.js#L16017-16023` | 每次顶层会话注入「读取纪律」，第 4 条即 `memory_note` 默认动作 | 同上，**G-3 退化的主要补偿** |
| 23 | `index.js#L1869-1921`、`#L4997-5004` | 15% 档位提醒（`NOTE_REMIND_STEP=0.15`，60s 冷却，`noteRemindState` 有 500 上限） | 同上 |
| 24 | `index.js#L20337-20339` | `/subagents-archive` 改为只回 hint 的 stub（`COMPAT_COMMAND_NAMES` `#L5078` 仍保留该名字） | 老 AGENTS 若提到该命令，不会报"未知命令"而是拿到下线提示 ✅ |
| 25 | `index.js#L6`、`#L1648` | `memory_archive_checkpoint` **只剩注释**，无工具注册、无兼容别名 | G-3 根因：调用即"工具不存在" |
| 26 | `index.js#L7192-7224` | topicdb 后端**懒加载** memtopic 模块；加载失败 → 回落 md 路径并 `cwarn` | 运行中安装可能让旧 index.js 懒加载到新 memtopic 模块 → 版本错配 → 回落 md（不致命，重启恢复） |

### 2.5 可疑点汇总（按严重度）

1. 🔴 `-CheckOnly` 两安装器都不能正确识别 `legacy-v4`（M2/M3，ps1 已实测）。
2. 🔴 安装模式对"改过的 4.0.1 v4 模板"谎报"已是 v4 协议（跳过）"，且不给合并路径（M4，已实测）。
3. 🟠 payload zip untracked，manifest tracked → 提交漏加即"发布一个远端装不上的版本"（M1）。
4. 🟠 AGENTS 写入非原子、无写后校验、无自动回滚（实测 read-only 失败后插件 4.5 / AGENTS 仍旧 / exit 1）。
5. 🟡 `Update-AgentsFile` 对 `unreadable` 误标 `user-modified`（文案错，行为安全）。
6. 🟡 `_backup-*` 每次安装无条件创建（实测 3 次安装 = 2 个备份，单个 1.96 MB）；且不含 client/version.txt → 回滚不完整。
7. 🟡 版本三处一致无 fail-closed 门（sync-payload 只 WARN，`--check` 不查）。
8. 🟡 ps1/sh 归一化在"无结尾换行"文件上不等价。

---

## 3. 表 2：状态交互 / 竞态（风险等级 + 护栏）

| # | 场景 | 机制 | 风险 | 证据 | 建议护栏 |
|---|---|---|---|---|---|
| S-1 | **AGENTS 升级中途失败**（写失败/断电/杀软占用） | 备份成功 → `WriteAllText` 截断+写（非原子）→ 抛异常 → 顶层 catch → exit 1 | **中** | **实测**：`AGENTS.md` 置只读 → 备份 `AGENTS.md.bak-20261105_190341` 生成、覆盖抛 `Access ... denied`、exit 1；此时插件已 4.5.0、AGENTS 仍 4.0.1（新旧错配）。重跑即自愈（legacy-v4 仍匹配） | 写临时文件 + 原子改名；写后重读比对模板 sha；失败自动从 `.bak` 恢复并明确提示"AGENTS 未升级，解锁后重跑" |
| S-2 | **DSH 运行中安装** | AGENTS 文件即时生效；插件代码只在启动时加载 | **中** | 静态：安装器只提示"重启 DSH 才加载新插件"（`#L1787`），不检测宿主是否在跑 | 检测宿主运行中时打印"重启前：新会话看到新协议、工具仍是旧的"；或提供 `-SkipAgents` |
| S-3 | 运行中安装 → 旧 index.js 懒加载新 memtopic 模块 | `index.js#L7192-7224` 懒加载；失败回落 md | **低** | 静态：`catch` 明确回落并 `cwarn`，不抛到会话 | 无需改（已有降级）；文档注明"装完尽快重启" |
| S-4 | **并发安装**（两个终端同时跑） | 无锁、无单实例保护 | **低** | 静态：两安装器均无 lockfile/mutex | plugin 目录下 lockfile（含 pid+时间），冲突即退出 |
| S-5 | 备份同名覆盖 | ps1 `Copy-Item -Force` / sh `cp -f`，文件名精确到**秒** | **低** | 静态：`#L1026`、`install.sh#L616` | 秒级+序号，或 `Test-Path` 存在则加 `-2` |
| S-6 | `.bak-*` / `_backup-*` 累积 | legacy 升级各建 1 个 AGENTS 备份（正常只 1 次）；`_backup-*` **每次安装无条件建** | **低**（磁盘） | **实测**：3 次安装 → 2 个 `_backup-*`，每个 1.96 MB；AGENTS 备份重跑不再增（幂等 ✅） | 已装版本==manifest 且文件全匹配 → 跳过备份；或只保留最近 2 个 |
| S-7 | pending marker 与 AGENTS 升级顺序 | `[6/8]` 写 pending → `[7/8]` 升 AGENTS | **低** | 静态：pending 只被 boot 消费（`index.js#L7187-7190`），与 AGENTS 无共享状态 | 无需改 |
| S-8 | 用户从 `.bak` 手工恢复旧模板后再装 | 恢复后仍是 legacy-v4 → 再次备份+升级 | **低** | 实测 A→D 逻辑可推 | 正常；备份会多一份，可接受 |
| S-9 | 用户文件被外部工具改成 CRLF/BOM | 归一化后仍命中白名单 → 升级 | **低（正向）** | **实测 fixture A/B** 均还原为 `45463dd5…` | 无需改 |
| S-10 | AGENTS.md 是符号链接/被 dotfiles 管理 | `WriteAllText` 跟随链接 → 改写链接目标（备份是内容拷贝） | **低** | 静态：`Get-AgentsState` 用 `Test-Path -PathType Leaf`，不识别 reparse point | 可选：检测 symlink 时警告 |

---

## 4. 表 3：边界场景（8 类用户 × 会发生什么 + 兜底）

> 全部经过**沙箱实测**（`%TEMP%\cra-*` 一次性 `DSH_HOME`，`-LocalPayload` 指向本仓），标注"实测"者为真实运行结果。

| # | 用户形态 | 安装器行为（实测/静态） | 结果 | 兜底 / 备注 |
|---|---|---|---|---|
| 1 | **新用户（无 AGENTS.md）** | `missing` → `Write-TextNoBom` 写新模板 | ✅ 实测：7723 B / sha `2de634f5…` / `已写入 v4 记忆协议` | 无风险 |
| 2 | **老用户 4.0.1 未改过** | marker=v4 → 归一化 sha == `45463dd5…` → `legacy-v4` → 备份+覆盖 | ✅ 实测：升级为 7723 B / `2de634f5…`，备份 `AGENTS.md.bak-20261105_190142`，exit 0 | 无风险；**这是本次发布的主目标人群** |
| 3 | **老用户改过（任意实质改动，未合并 4.5）** | marker=v4 → sha 不匹配 → `v4` → 跳过 | ⚠️ 实测：保留 6050 B 用户文件（**不覆盖，正确**），但打印 `OK AGENTS.md 已是 v4 协议（跳过）` → **既没升级也没提示** | 兜底：插件每次会话注入「读取纪律」含 memory_note（`index.js#L16017-16023`）+ 15% 提醒 → memory_note 仍可达；**但旧 §3 会诱导调已删除的 `memory_archive_checkpoint`**。→ 必须靠 M4 提示 + 迁移指南 §6.2 手工合并 |
| 4 | **老用户已手工合并过 4.5（如本机 7926 B 变体）** | marker=v4、sha≠白名单 → `v4` → 跳过 | ✅ 实测：保留不动（sha `6b87ffe5…`），exit 0 | 正常；但注意**该机器从此不会再收到模板更新**（用户内容优先，设计如此） |
| 5 | **DSH 运行中安装（pending）** | 文件全部写入成功；pending 只在"旧 md 迁移"场景登记 | ⚠️ 静态：新会话拿到新 AGENTS（含 memory_note），但**进程内仍是 4.0.1 插件**（无 memory_note 工具）→ 重启前 agent 被要求用一个不存在的工具；pending 不覆盖此场景 | 兜底：重启即一致；安装器已打印"重启 DSH 才加载新插件"。建议 S6 显式提示错配方向 |
| 6 | **`-LocalPayload` 离线安装** | 本报告全部实测均走此路径：manifest+zip 从本地读，逐文件 sha 校验通过 | ✅ 实测：`-LocalPayload <repo>` 全程可用（也验证了"zip 同目录/上一级"两种查找） | 风险：本地 manifest 无签名，sha 只证明"与 manifest 一致"（完整性），不证明来源（真实性）——固有，非回归 |
| 7 | **重复安装幂等** | 第二次起 AGENTS `v4` → `current`（实测 `已是 v4 协议（跳过）`）；插件文件重写但 sha 相同；`_backup-*` 每次新增 | ✅ 实测：AGENTS sha 不变、无新 AGENTS 备份、exit 0 | ⚠️ `_backup-*` 无界累积（S6）；建议加"版本+文件全匹配则跳过备份" |
| 8 | **已有 AGENTS.md 但非本插件协议**（其他工具/skill 的全局 AGENTS.md） | 无 v4 marker、sha 不匹配 → `user-modified` → **不写记忆协议** | ⚠️ 静态：新用户会**静默拿不到记忆协议**（只有一行 WARN） | 建议：提示"检测到非本插件的 AGENTS.md，可参考模板手工追加协议章节"，或提供 `-ForceAgents` 显式覆盖 |

**补充边界（实测）**：AGENTS.md **只读/被占用** → 见 S-1（备份在、覆盖失败、exit 1、插件已升级、重跑自愈）；**unreadable**（权限拒绝读）→ `Get-AgentsState` 返回 `unreadable`，但 `Update-AgentsFile` 会落进 `user-modified` 分支（`#L1033`）→ 提示"你改过"（文案错，行为安全）。

---

## 5. G-3 能力可达性专节：`memory_archive_checkpoint` 消失对旧用户的影响

### 5.1 该能力服务什么

`memory_archive_checkpoint` 是 v2.3.2 起引入的**结构化会话归档检查点交付工具**：子代理/主代理按
`{ blocks: [ { file, sessionId, title, points[], skip?, reason? } ] }` 一次性提交整批会话要点，插件现场校验（A5 完整性）+ 条目级幂等 + 落"归档队列"（不写 `sessions/*.md`）。它服务三条链：

1. 会话结束把当日要点交到主题库归档队列（旧 AGENTS §2/§3）；
2. 子代理摘要通道（`/subagents-archive` 背后的归档子代理，`toolFilter.allow` 里曾包含该工具）；
3. 漏网归档链（`stale_archive` 工具 + `runStaleArchive` 等）。

### 5.2 全部调用路径（4.5 现状）

| 路径 | 现状 | 证据 |
|---|---|---|
| 工具注册 | **已删除**（4.5 漏网归档链整体移除） | `index.js#L6`、`#L1648` 只剩注释；全仓 grep 无 `name: "memory_archive_checkpoint"` 注册；`test/plugin.smoke.test.mjs#L100-107` 工具清单已不含它 |
| 兼容别名 / stub | **无**（不像 `/subagents-archive` 留了 stub） | 对比 `index.js#L20337-20339` 的 command stub；工具面无任何兼容层 |
| 旧 AGENTS.md §2 | **仍在**（未升级的用户）：`会话归档/要点 → memory_archive_checkpoint` | 4.0.1 模板 `AGENTS.template.md`（HEAD 版）L52 |
| 旧 AGENTS.md §3 | **仍在**：`用 memory_archive_checkpoint 提交当日要点（…）：` | 同上 L57-58 |
| 子代理归档提示词 | 已随链删除（4.5 无归档子代理） | `index.js` 无归档子代理 spawn 路径（仅历史注释） |
| 自动检查点（压缩点） | **仍可达**（与手动工具无关，插件自动写「会话检查点」主题） | `index.js#L17056-17058`（压缩后 `noteRemindReset` + 检查点链）；新模板 §3 明确"插件会自动写" |
| 替代手动通道 | `memory_write`（长期）/ `memory_note`（暂存） | 新模板 §2/§2.5/§3；`index.js#L17836` |

### 5.3 旧 AGENTS 未被替换（改过的用户）会发生什么

- 模型在会话结束按旧 §3 调 `memory_archive_checkpoint` → **宿主返回"工具不存在"错误**（插件未注册该名字，无兼容别名）；
- 后果：①浪费 1 轮工具调用；②该次"会话结束归档"不会落到归档队列（结构化投递能力已按设计移除，不产生数据损坏）；③模型可能反复重试或改用 `memory_write`（取决于模型行为，未实测）；
- **补偿（重要，避免高估风险）**：
  - 插件在**每个顶层会话开始**注入「读取纪律」，第 4 条明确 `memory_note` 默认动作（`index.js#L16017-16023`）；
  - 上下文每 15% 档位提醒一次 `memory_note`（`index.js#L1869-1921`、`#L4997-5004`）；
  - 工具描述本身即"默认动作"口径（`index.js#L17836` 附近）。
  → 因此 **`memory_note` 通道在旧 AGENTS 下依然可达**，退化限于"旧的归档指令指向已删工具"，不是"记忆能力整体失效"。
- 与部分失败叠加（S-1 实测）：插件 4.5 + 旧 AGENTS 的错配会**持续存在直到用户重跑安装器**；安装器当前不会主动指出"你的 AGENTS 还是旧的"（M4 要修的就是这个可见性）。

### 5.4 G-3 结论

- 删除**有明确的替代通道**（自动检查点 + `memory_write`/`memory_note`），能力整体**未失守**；
- 但**旧 AGENTS 的调用路径没有兼容层**，属于"能力可达性靠提示词补偿"的中等风险；
- 缓解手段优先级：M4（让安装器明确告知）> 迁移指南 §6.2（已有，要求手工合并两条）> 插件注入补偿（已有）。
- **不建议**为兼容再加一个 `memory_archive_checkpoint` stub：会复活刚删除的链语义，且与"漏网归档链删除"的发布目标冲突；**建议保持删除 + 修提示**。

---

## 6. G-9 产出物判据：manifest / payload 是否与新文件一致？

### 6.1 结论：✅ 全部一致（20/20，三重交叉验证）

| 校验项 | 结果 | 证据 |
|---|---|---|
| manifest 版本 | `4.5.0` | `install-manifest.json` `version` 字段 |
| manifest 文件数 | 20 | 同上 |
| **manifest 20 文件 vs 工作区磁盘** | **0 mismatch**（bytes + sha256 全等） | 逐项比对：`AGENTS.template.md` 7723/`2de634f5…`、`index.js` 1457431/`724fa1b2…`、`version.txt` 5/`75a2f501…` 等 |
| **manifest.zip vs 磁盘 zip** | bytes `708912`、sha256 `b04c93375fc2d7b18101c21bf61e90397be3c1d3416fe1aff0950b51e0833fee` **完全一致** | `payload/dsh-memory-4.5.0.zip` |
| **zip 内 20 条目 vs manifest** | **0 mismatch**（解压后逐文件 bytes+sha 比对） | 见下方可执行命令 |
| zip 内容 vs 工作区源文件 | 20/20 完全相同 | 同上 |
| zip 内 `version.txt` | `"4.5.0"`（5 B，无换行） | 解压读取 |
| zip 内 `index.js` | `const PLUGIN_VERSION = "4.5.0";` | 解压 grep |
| zip 内 `package.json` | `version: 4.5.0` | 解压解析 |
| zip 内 `AGENTS.template.md` | sha `2de634f5…`，含 §2.5、含 v4 marker、`memory_archive_checkpoint` 仅 1 处（"已移除"修订说明，非指令） | 解压读取 |
| **源码可复现性** | `node tools/sync-payload.mjs --check` → **CHECK OK**（zip 与"按当前源码重建"逐字节相等；manifest 三字段相等） | 实测 exit 0 |

### 6.2 可执行验证命令（复制即用）

```powershell
# ① 官方复现性检查（最强，一条命令）
cd "E:\工具\插件开发调整\dsh-memory-plugin"
node tools/sync-payload.mjs --check
# 期望：CHECK OK: payload + manifest are in sync with the sources

# ② manifest 与磁盘逐文件比对（PowerShell）
$m = Get-Content install-manifest.json -Raw | ConvertFrom-Json
$bad = 0
foreach ($f in $m.files) {
  $p = Join-Path (Get-Location) $f.path
  if (-not (Test-Path $p)) { "MISSING $($f.path)"; $bad++; continue }
  $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $f.sha256 -or (Get-Item $p).Length -ne $f.bytes) { "MISMATCH $($f.path)"; $bad++ }
}
"mismatches: $bad / $($m.files.Count)"; "zip sha ok: $((Get-FileHash payload/dsh-memory-4.5.0.zip -Algorithm SHA256).Hash.ToLower() -eq $m.zip.sha256)"

# ③ 解压 zip 比对（Linux/macOS 或 Git Bash）
unzip -q -o payload/dsh-memory-4.5.0.zip -d /tmp/rel45
diff -r /tmp/rel45 <(echo skip) 2>/dev/null || true
sha256sum /tmp/rel45/version.txt /tmp/rel45/AGENTS.template.md /tmp/rel45/index.js
# 期望：version.txt 内容 4.5.0；AGENTS sha 2de634f5…；index.js 内含 PLUGIN_VERSION = "4.5.0"

# ④ 发布后（push 之后）远端可用性
curl -sI https://raw.githubusercontent.com/Starry0214/dsh-memory/main/payload/dsh-memory-4.5.0.zip | Select-String '200|404'
curl -s https://raw.githubusercontent.com/Starry0214/dsh-memory/main/version.txt   # 期望 4.5.0
```

---

## 7. G-9.2 反面问题（必答）：这次发布**可能怎样让老用户升级失败或退化**？

| # | 失效路径 | 触发条件 | 后果 | 是否 fail-closed | 兜底 |
|---|---|---|---|---|---|
| F1 | **payload zip 未入库** | 提交时只 `git commit -am`（zip 是 untracked，`git ls-files payload/` 只有 4.0.1） | 远端安装 [2/8] `payload zip 下载失败` → **所有远程安装/升级失败** | ✅ 安全（未改任何文件） | M1：显式 `git add payload/dsh-memory-4.5.0.zip`；push 后跑 ④ 验证 |
| F2 | **AGENTS.md 改过 → 永远拿不到新协议** | 用户曾编辑过 `~/.dsh/AGENTS.md`（本机即此形态：7926 B 变体） | 无自动升级；旧 §3 指向已删工具；memory_note 仅靠插件注入补偿；**安装器还谎报"已是 v4"** | ✅ 不覆盖（安全） | M4 修提示 + 迁移指南 §6.2 手工合并；G-3 补偿链 |
| F3 | **AGENTS.md 半写/写失败 → 新旧错配** | 只读、杀软占用、断电、磁盘满 | **实测**：插件已 4.5 + AGENTS 仍 4.0.1 + exit 1；`memory_archive_checkpoint` 调用失败 | ⚠️ 插件已改（非全有或全无） | 备份在 `.bak-*`；重跑自愈；建议 S1 写后校验+自动恢复 |
| F4 | **payload 与 manifest 不一致（镜像/CDN 旧版、代理改写）** | RAW 与 jsDelivr 返回不同版本 / 下载中断 | zip sha 校验失败 → 中止 | ✅ 安全 | 安装器已提示"重试或换 -RawBase"；版本名内嵌 zip 文件名，跨版本混用概率低 |
| F5 | **DSH 运行中安装 → 重启前工具/协议错配** | 用户不重启就继续用 | 新会话看到新协议但插件还是 4.0.1（无 `memory_note`）；或反向（F3）旧协议 + 新插件 | ⚠️ 部分（文件已写） | 重启即一致；S6 建议显式提示 |
| F6 | **两安装器判定不一致导致"同机不同结果"** | 用户先用 ps1 再用 sh（或反之）且 AGENTS 无结尾换行 | ps1 判"改过→保留"、sh 判"原始→覆盖"（反之亦然） | ✅ 都不损坏（覆盖前有备份） | S6/S9：统一归一化语义 |
| F7 | **旧安装器把插件降级** | 用户重跑缓存里的 4.0.1 安装器 | 插件代码回退 4.0.1；AGENTS 因旧安装器把 v4 当"已是 v4"而**保留 4.5 模板** → 新协议 + 旧插件（缺 memory_note） | ⚠️ 非原子 | 无降级保护（S5）；建议加版本比较+`-Force` |
| F8 | **版本三处漂移**（忘改 package.json / index.js） | 只改 version.txt 就打包 | manifest 4.5.0 但 `/memory-update` 按 index.js 判断 → 误报"已是最新/可升级"；安装器仅 WARN | ❌ 不 fail-closed | S2：sync-payload 改 fail-closed + committed 测试 |
| F9 | **回滚不完整** | 装 4.5 后想回 4.0.1 | `_backup-*` **不含 client/** 与 version.txt → 回滚后旧 index.js + 新 client.js + 新 version.txt（更新检查误判） | ⚠️ | 手工再装 4.0.1 payload（库里有 `payload/dsh-memory-4.0.1.zip`）+ 手工还原 AGENTS `.bak`；建议 S4 补备份清单 |
| F10 | **新用户已有非本插件 AGENTS.md** | 用户 ~/.dsh/AGENTS.md 来自其他工具 | 不写记忆协议，仅一行 WARN | ⚠️ 静默 | 表 3-#8 建议提示/`-ForceAgents` |

---

## 8. 方案对比（≥2 个替代，最小风险优先）

### 8.1 识别"旧 v4 模板"的机制

| 方案 | 做法 | 优点 | 缺点 / 风险 | 结论 |
|---|---|---|---|---|
| **A. sha 白名单（现方案）** | 保持 marker=v4，白名单加 `45463dd5…`；命中→升级，不命中→保留 | **零误覆盖风险**；已实测通过；对 4.0.x 未改用户 100% 命中（4.0.1 payload 字节实证）；实现 3 行 | 每版都要追加一条 sha（白名单线性增长）；"改过"用户永不自动升级；CheckOnly 需额外分支（M2/M3） | ✅ **推荐保留** |
| B. marker 升到 `v4.5`/`v5` | 新模板换 marker，安装器识别新旧 marker | 语义直观；未来不必堆 sha | 旧安装器(4.0.1)遇到新 marker 会走"非 v4 → sha 比对 → user-modified → 保留"（安全但同样不升级）；**插件/面板/文档/更新检查对 marker 的依赖需全量排查**（当前 marker 只被安装器与文档使用，但改标记属于跨版本协议变更）；无净收益 | ❌ 本次不改（风险>收益） |
| C. 无条件覆盖 AGENTS.md | 忽略 sha，直接覆盖 | 协议永远最新 | 会摧毁用户定制（本机 7926 B 变体含「协作方式」章节；改过的用户普遍有本地增补）→ 违背"用户文件归用户"承诺 | ❌ 拒绝 |
| D. 追加式合并（缺 §2.5 就插入） | 解析结构，插入缺失章节 | 不丢用户内容且能补协议 | 格式脆弱、重复插入/错位风险高；Markdown 结构无契约 | ❌ 本次不做（可作为 4.6 议题） |
| **A+** | A + 用 `内容修订：` 行做**二级信号**：marker=v4 且内容修订≠4.5 → 只**提示**"旧版/已改，请合并"，绝不覆盖 | 零覆盖风险 + 解决 M4 的可见性 | 多 1 个正则 | ✅ **推荐：A + M4** |

### 8.2 升级失败时的写入策略

| 方案 | 做法 | 评价 |
|---|---|---|
| 现状 | 备份 → 覆盖（非原子），失败退出 1，靠重跑自愈 | 可接受但"半写"窗口存在 |
| **推荐** | 写 `<tmp>` → `Move-Item -Force`（同卷原子）→ 重读校验 sha == 模板 sha → 失败从 `.bak` 自动恢复并明确报错 | 成本 ~10 行，彻底消除 S-1 |
| 不做 | 直接覆盖不备份 | 拒绝 |

---

## 9. 护栏清单（实现需逐条落实）

### 9.1 必须修（发布前，阻塞）

- [ ] **M1 产出物入库**：`git add payload/dsh-memory-4.5.0.zip`；`git status` 确认 manifest + zip + install.ps1/sh 同批提交；push 后执行 §6.2-④，期望 zip 200 且 `version.txt`=4.5.0。
- [ ] **M2 ps1 CheckOnly**：`#L2065` switch 增加 `'legacy-v4' { Write-Warn2 ('旧 v4 模板（sha …）→ 重跑安装器会备份后升级到 4.5') }`；`#L2135` issues 条件改为 `@('legacy-v3','legacy-v4') -contains $agents.State`。
- [ ] **M3 sh CheckOnly**：`install.sh#L344-347` 用 `sha_of_normalized` 判 `LEGACY_SHA_3`，区分"待升级"与"已是最新"。
- [ ] **M4 旧版/改过提示**：两安装器在 `state=v4` 但归一化 sha ≠ 当前 payload 模板 sha（或 `内容修订：` ≠ 4.5）时，输出"检测到旧版 v4 模板或你改过 → 未覆盖；请参考 `<pluginDir>/AGENTS.template.md` 手工合并 §2.5（memory_note）"；**禁止**再打印"已是 v4 协议（跳过）"。

### 9.2 强烈建议（不阻塞，建议随发布）

- [ ] **S1** `install.sh#L616/L624` 备份改 `cp -f ... || die "备份 AGENTS.md 失败，已中止"`；两安装器在写 AGENTS 后**重读比对模板 sha**，不符则从 `.bak` 恢复 + 报错。
- [ ] **S2** `tools/sync-payload.mjs`：`versionHints()` 的版本不一致从 `WARN` 改 `fail`（并在 `--check` 路径也调用），使"三处一致"成为发布门。
- [ ] **S3** 把 4.5 自测（`test/_memory-note-selftest.mjs`、`test/_note-remind-selftest.mjs` 等）与 G-9 验证脚本纳入版本库（后者当前被 `.gitignore#L36 _verify/` 挡住；建议移到 `tools/verify-payload.mjs`）。
- [ ] **S4** `Backup-PluginDir` 备份清单补 `version.txt` + **兄弟目录 `dsh-memory-client`**（否则回滚不完整，见 F9）。
- [ ] **S5** 降级保护：`installedVersion > manifest.version` → 警告并要求 `-Force`（防 F7）。
- [ ] **S6** 检测 DSH 运行中（`migrate --detect` 已有 `host.running` 字段，`install.sh#L502` 已解析）→ 安装前打印"重启前新协议/旧工具会错配"。

### 9.3 可接受但需记录

1. ps1/sh 归一化在"无结尾换行"文件上不等价（实测：ps1→`1b41a81e…` 保留，sh 模拟→`45463dd5…` 覆盖）。模板均以换行结尾，实际影响仅限异常编辑过的文件；两安装器均先备份，**不损坏数据**。
2. `_backup-<ts>` 每次安装无条件创建（实测 3 次→2 个，1.96 MB/个），无清理；`AGENTS.md.bak-<ts>` 正常仅 1 个但无清理。
3. AGENTS 写入非原子、无写后校验（S1 修）。
4. `Update-AgentsFile` 把 `unreadable` 归入 `user-modified`（文案错，行为安全）。
5. 无安装锁 / 无单实例（S-4）。
6. `AGENTS.template.md` 的目录树把 `AGENTS.md` 画在 `~/.dsh/memory/` 内，实际在 `~/.dsh/AGENTS.md`（**旧模板既有错误**，4.5 沿用；`README#L221` 与 `迁移指南#L216` 是对的）。
7. 模板 L5 说"注入主题账本切片 + 最近摘要"，实际启动注入为「读取纪律 + 稳定层(global.md/index.md) + 主题注册表切片 + 最近摘要」（`index.js#L16017`、`#L15919`、`#L11410`）；旧模板写的是"global.md+index.md+最近摘要"。属描述精度问题，不影响 agent 行为。
8. 新模板仍含 `memory_archive_checkpoint` 字样 1 处（L7 修订说明"已随链移除"）；语义正确，但若担心模型误读可加"（不要调用）"。
9. `test/plugin.smoke.test.mjs#L100-107` 只把已删工具**从清单移除**，未断言"不存在"；建议补 `!tool(s.ctx,'memory_archive_checkpoint')` 断言。
10. 远端安装的信任模型：HTTPS + manifest 锁定 zip sha（完整性），无签名（真实性）——固有，非本次回归。

---

## 10. 影响面结论

| 面 | 是否波及 | 结论 |
|---|---|---|
| ① **新用户安装** | 是（正向） | 无 AGENTS.md → 写入 4.5 模板（实测）；插件/payload 校验链 fail-closed。唯一缺口：已有"其他用途 AGENTS.md"的新用户静默拿不到协议（表 3-#8） |
| ② **老用户升级** | 是（核心） | 4.0.x 未改 → **自动升级成功**（实测，含备份）；改过 → **安全保留但不升级**（设计取舍，需 M4 提示）；4.0.x 无数据迁移步骤 |
| ③ **已装用户数据（记忆库/配置）** | **否** | 4.5 无 DB schema 迁移；安装器只写插件目录 + `~/.dsh/AGENTS.md`（有备份）+ `.config.json`（仅缺失时补 key，已有值不动）。主题库 `mem.db` 原样读取 |
| ④ **运行中的 DSH** | 是（窗口期） | 插件代码不热更；AGENTS 文件即时生效 → 重启前协议/工具错配（S-2）；运行中安装可能触发懒加载版本错配 → 主题库回落 md（不致命，`index.js#L7219-7223`） |
| ⑤ **回滚能力** | 是（有缺口） | 插件目录 `_backup-<ts>` 可整体回滚（**但不含 client/ 与 version.txt**，F9）；AGENTS `.bak-<ts>` 可回滚；`payload/dsh-memory-4.0.1.zip` 仍在库可降级重装。**完整回滚步骤**：①装 4.0.1 payload ②还原 AGENTS.md.bak ③重启 DSH |

**总评**：本次发布的数据面是干净的（无迁移、无 schema 变更、AGENTS 替换有备份且只针对可证明的原始模板）；风险集中在**"提示与诊断"**（M2/M3/M4）与**"发布物料完整性"**（M1）。核心写入语义在沙箱实测中全部按设计工作（升级/保留/新建/幂等/失败中止）。

---

## 11. 诚实记录：本次未能验证的部分

1. **`install.sh` 全流程未实跑**：本机 `bash.exe` 是 WSL 存根且不可用（`wsl: 无法解析 localhost`），无法执行 sh 安装器。sh 侧结论来自**静态审阅 + 归一化函数的 PowerShell 忠实模拟**（fixture C 复现了 ps1/sh 差异）；sh 的 `cp`/`sed`/`awk` 真实行为未上机。
2. **未在真实运行中的 DSH 上执行安装**（避免部署动作）。S-2/S-3 为静态推断（懒加载失败回落 md 有代码依据 `index.js#L7192-7224`，但未触发）。
3. **未验证远端 raw/CDN 路径**：仓库未 push，远端 `main` 仍是 4.0.1；M1 的"push 后验证"是发布时动作。
4. **未重审 4.5 插件行为差异**：`client/lib/client.js`（+409 行）、`memtopic/src/split-oversized.mjs`（11 行）等按"已部署验证"前提接受，仅确认其 sha 已随 payload/manifest 一致。`index.js` 只做了与本审计相关的定点核对（工具注册/提醒/注入/懒加载），未做 7958 行全量行为审计。
5. **未做 Windows 锁文件/杀软实时扫描占用实测**：用"只读属性"模拟了写失败（S-1），未覆盖杀软拦截/独占锁。
6. **未验证 macOS/Linux 上 `unzip`/`sha256sum` 可用性**（脚本有 `unzip → python3 -m zipfile` 兜底 `install.sh#L482-486`，但未实测）。
7. **未验证"用户在安装器运行期间同时编辑 AGENTS.md"** 的竞态（窗口极短，未设计实验）。
8. 本报告所有实测均在 `%TEMP%\cra-*` 的一次性 `DSH_HOME` 内完成；**真机 `~/.dsh` 未被修改**（安装前后 `~/.dsh/AGENTS.md` sha 均为 `6b87ffe5…`，已复核）。

---

## 12. 附：关键实测记录（可复现）

| 实验 | 设置 | 结果 |
|---|---|---|
| A 老用户未改 | temp home + 4.0.1 原始模板 + `-LocalPayload <repo>` | `AGENTS.md 从旧模板升级为 v4（备份：…bak-20261105_190142）`；7723 B / `2de634f5…`；exit 0 |
| B 老用户改 1 处 | 4.0.1 模板把"主题库模式"→"主题库模式（已改）" | 保留 6050 B（sha `c06da8a1…`），打印 `OK 已是 v4 协议（跳过）`（M4 证据），exit 0 |
| C 新用户 | 空 temp home | `已写入 v4 记忆协议`；7723 B / `2de634f5…` |
| D 幂等 | A 后再装 2 次 | AGENTS sha 不变、无新 AGENTS 备份；每次新增 `_backup-<ts>`（1.96 MB） |
| E 已合并 4.5 | 复制本机 7926 B 变体 | 保留（sha `6b87ffe5…`），exit 0 |
| F 写失败注入 | AGENTS.md 置 `IsReadOnly` | 备份生成 → `WriteAllText` 抛 `Access denied` → `安装器异常终止` exit 1；插件已 4.5.0、AGENTS 仍 4.0.1（S-1 证据） |
| G CheckOnly(legacy-v4) | temp home + 4.0.1 原始模板 | `WARN 无法读取：…\AGENTS.md`（M2 复现）；体检结论未提示升级 |
| H CheckOnly(已升级) | A 之后 | `[2/11] 20/20 全部匹配`、`[9/11] OK v4 协议`、`一切就绪，无需操作` |
| I 产出物 | manifest/zip/磁盘/源码四向比对 + `sync-payload --check` | 0 mismatch；`CHECK OK` |
| J 4.0.1 出处 | 解压 `payload/dsh-memory-4.0.1.zip` 的 AGENTS 模板 | raw=normalized=`45463dd5…` = 白名单（G-0 证据） |

---

*本报告由 release45-cra 生成；只读审计，未修改任何仓库文件（本报告除外）。*
