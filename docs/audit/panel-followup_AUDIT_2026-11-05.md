# 记忆面板跟随调整 · 变更风险审计（CRA）

> 审计对象：`.task/1101-dsh-mimo-survey/36-panel-followup-design.md`（设计，验收依据）
> 仓库：`E:\工具\插件开发调整\dsh-memory-plugin`（**未部署**，仅工作区）
> 审计方式：**只读**（不改代码、不构建、不部署）。所有结论均带 `文件#行号` 证据；凡推断均显式标注。
> 审计时间：2026-11-05 11:19–11:52（Asia/Shanghai）
> 审计基线：**已部署副本**（改动前）——
> · `C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js`（20322 行，mtime 2026-11-05 10:22:05）
> · `C:\Users\Starry\.dsh\profiles\web\plugins\dsh-memory-client\lib\client.js`（605 行，mtime 2026-11-03 20:59:41）
> 与仓库现状对比（`git diff --no-index`）：`index.js +39/−3`、`client.js +23/−111`（净 −52 行）；**SHA256 全量比对确认部署副本与仓库仅这 2 个文件不同** → 改动范围 = 2 文件，与任务描述一致。

---

## 0. 结论先行

**结论：PASS-with-findings（有条件通过，无高危阻断）。**

- 改动本身**语义正确、范围收敛、可回滚**：只增 `graph.json` 节点字段 + 纯前端颜色消费；删除的都是**后端已死**的 UI（`staleAction` 已无功能分支、`staleCount` 恒 0、`archive` 成本分类无新事件）。
- **没有发现高危问题**（无崩溃/数据损坏/核心记忆链波及）；`node --check` 双文件通过；图谱测试套件新代码与旧部署 **A/B 同为 75 PASS / 2 FAIL，2 项失败完全相同（既有测试漂移，非本次引入）**。
- 但有 **3 项中危需处置/记录**，其中 2 项建议**部署前修**：
  1. **M2 颜色冲突（中）**：新增 `KIND_COLOR` 的 `#22d3ee`/`#94a3b8` 与既有域调色板 `COLORS` 第 6/8 色**完全相同**；真实库 10 个域中恰好 2 个域命中这两个色 → 21 个普通主题节点会显示成「会话笔记」青色、8 个显示成「会话检查点」灰色，图例色块也重复。**该改动会让「颜色可区分」的语义部分失效。**
  2. **M4 观测门 G-0 未通过（中/流程）**：实现前**没有任何真机观测留档**；唯一观测脚本 `_verify/_q-kind-observ.mjs` 的 mtime（11:20:20）**晚于**实现（11:05/11:07），且它「复刻」规则而非调用真实 handler，无输出留档。本报告用真实 `graph.json` 载荷补做了等价观测（见 §5）。
  3. **M1 `staleSessionDays` 能力回归（中，需产品决策）**：设计 §4.3 断言该键「写了也没人读」**不成立**——它仍被子代理摘要通道真实读取（`index.js#5969/#6025/#20214`）。删掉唯一 UI 后，用户无法再从设置页调整该**仍生效**的参数（当前 live 值 = 1 天）。
- 另有 6 项低危（文档/注释失真、静默降级、图例恒显、字段名泛化、死 store 字段、成本总额口径）→ 见 §10「可接受但需记录」。

**建议：修 M2（改色值，约 2 行）→ 补 M4 观测留档（部署前后 curl 对照）→ M1 明确决策（加回最小控件 或 文档声明仅配置文件可改）→ 再部署。**

---

## 1. 表 1 · 调用链与语义（含可疑点）

### 1.1 谁消费 `/dsh-memory/graph.json`

| # | 消费方 | 位置 | 读什么 | 对新增 `kind` 的容忍度 | 反直觉用法 |
|---|---|---|---|---|---|
| 1 | 面板内嵌图谱 JS（**唯一生产消费方**） | `index.js#9931-9939`（fetch，`cache:"no-store"`）、`#9942-9960`（装载） | `nodes[].{id,name,level,domain,domainName,state,archived,sentences,chars,degree,parent,mergedInto,unmapped,triggers,genericTriggers}` + `links` + `stats`；`kind` 只经新 `kindOf` 消费（`#9835-9842`） | **完全容忍**：`load()` 只校验 `g.nodes` 存在（`#9943`），多余字段忽略；3D 侧 `Object.assign({}, n)` 原样带过去（`#10523-10535`），`3d-force-graph` 不读 `kind` | 无 |
| 2 | 图谱验收脚本 | `_verify/topicdb-graph-check.mjs#206/#242-249`、`#256-258` | 结构断言：只断言**必需字段存在**，不校验「字段集合精确相等」 | **容忍**（实测见 §5.2：新旧 A/B 同 75/2） | 无 |
| 3 | 观测脚本（实现者补写，非消费方） | `_verify/_q-kind-observ.mjs#23-30` | 自己复刻规则读 `store.topics()`，**不读 graph.json** | 不适用 | 用「复刻规则」冒充「真实 handler 产出」（可疑，见 §5.1） |
| 4 | 文档 | `README.md#111` | 仅描述端点存在 | 不适用 | 无 |
| 5 | 外部/第三方 | 仓库内无；端点被 README 文档化，外部消费方**未知** | 未知 | JSON 只增字段通常兼容；严格 schema/字节哈希会受影响（但该响应本身**逐请求不确定**：`stats.generatedAt`#9473、`stats.buildMs`#9461，见 §5.3） | 无证据 |
| 6 | `client.js`（设置页） | `client/lib/client.js#262/397/438/471` | **只** fetch `/stats.json`、`/wait.json`、`/config`；`graph` 出现次数 = **0** | 不涉及 | 无 |

**结论：仓库内没有把 graph 节点字段「当别的用」的消费方；节点 schema 是显式白名单（`index.js#9428-9434`，实测真实节点键集合 = `id,name,level,domain,domainName,state,archived,sentences,chars,degree,parent,mergedInto,unmapped,triggers,genericTriggers`），**原本没有 `kind` 字段，无覆盖冲突**（实测 `existingKindFieldCollisions=0`）。**

### 1.2 谁消费 `client.js` 设置页 store

| 消费方 | 位置 | 说明 |
|---|---|---|
| `MemorySettingsRow` 组件 | `client/lib/client.js#62-65` | `useStore` 只取 `integrateEnabled/integrateDays/monitorEnabled/status`；**不再取** stale* 三键 |
| 宿主槽框架 | `client/lib/client.js#502-508`（`ctx.slots.register({ store, inject })`） | store 由槽框架镜像；快照只提供 `status`（`#458-463`），配置真值走 `/dsh-memory/config`（`#437-445`） |
| 其它文件 | 全仓 grep：除本文件外**无** `useStore`/store 字段消费者 | 删字段不影响宿主 |

**反直觉用法/可疑点：**
- **S1（已证实，非缺陷）**：`p25Topics.isSessionTopicName("笔记·<wsKey>/<sid8>")` 返回 **true**。`parseSessionTopicName` 的正则是 `^([^\s/\\]{1,200})\/([0-9a-f]{8})(?:…)?$`（`p25-topics.js#244-247`），`笔记·` 前缀不排除 → 真实库 2/2 个笔记主题**同时满足**两条规则（本报告实测）。因此 handler **必须**先判 `笔记·` 再判 session（`index.js#9512-9513`）；若顺序反了，2 个笔记会静默变灰（checkpoint）。**当前顺序正确**，但这是隐性耦合，值得写进注释/测试。
- **S2**：`index.js#17711` 注释写「`笔记·` 独立前缀，**不会被** `isSessionTopicName` 误判」——与 S1 事实相反；只是靠 handler 的判断顺序兜住。注释误导后来人（低危，见 §10）。
- **S3**：`kind` 字段名过于通用；handler 无条件 `n.kind = kind`（`#9517`），未来若 `topicDbGraphBuild` 增加真正的 `kind` 字段会被**静默覆盖**（当前白名单无此字段，安全）。
- **S4**：`_verify/_q-kind-observ.mjs` 复刻规则（`#23` 注释自述），不是对真实 handler 的观测 → 不能作为「端点产出 kind」的证据。

---

## 2. 表 2 · 状态 / 线程竞态（风险等级 + 护栏）

| # | 关注点 | 事实与证据 | 风险 | 护栏 |
|---|---|---|---|---|
| 2.1 | `staleCount` 写/读 | 写入点仅初始化 `index.js#6471`（`LIVE_STATS.staleCount:0`，全仓无再赋值）；输出点 `#11766` → `stats.json.live.staleCount` **实测恒 0**；`.monitor.json` **无**该键（实测 0 次）；客户端读点已删（`client.js` grep `staleCount`=0） | 低（字段恒 0 保留，向后兼容） | 保留 `live.staleCount` 不删（设计 §4.3 要求 stats.json 不变）；未来可标注 deprecated |
| 2.2 | `syncLiveCount` 被删是否误删其它职责 | 改动前该函数只做「30s 节流 fetch stats.json → 取 `live.staleCount` → sync store」+ `setInterval(…,120000)`（基线 `client.js#558-572`）；删除后**唯一副作用是少一个 120s 轮询**（性能 +），无其它职责 | 无 | 无需 |
| 2.3 | `staleSessionDays` 状态 | **仍被真实读取**：`index.js#5969`（digest 窗口默认值）、`#6025`（每小时自动通道）、`#20214`（手动 `/subagents-archive`）；当前 live 值=1（`GET /dsh-memory/config` 实测）。UI 删除后仅剩 `.config.json` 手改 / `POST /dsh-memory/config`（`#11946-11948` WRITABLE） | **中（能力回归）** | 见 M1 |
| 2.4 | `staleAction` 状态 | 仅剩 schema 校验（`#6428-6429`、`#6510-6514`）与日志（`#6485-6486`、`#11718`）；**无任何功能分支** → 删 UI 安全 | 低 | 无需 |
| 2.5 | `kind` 与服务端缓存 | `TOPICDB_GRAPH_CACHE.base` 缓存 base（`#8958-8961`、`#9105-9106`、`#9336-9338`），但响应节点每次 `scopeNodes.map(...)` **新建**（`#9428-9434`）→ `n.kind=…` 只改本次响应对象，**不会污染缓存/跨请求** | 无 | 无需（已满足） |
| 2.6 | `kind` 与 `links`/`stats` | 字节级验证：`links`、`stats` 序列化后与基线**逐字相同**；仅 nodes 末尾追加字段（见 §5.3） | 无 | 无需 |
| 2.7 | `kind` 与 `colorOf` / `S.colors` | 域色分配发生在 `updateLegend()`（`#10832` 调 `colorOf`），`load()` 中顺序为 `layout(); updateLegend(); render(); render3D()`（`#9957-9960`）→ 调色板分配顺序**不变**；但新增两色与调色板撞色 | **中（M2）** | 改 `KIND_COLOR` 或从 `COLORS` 保留两色 |
| 2.8 | 前端 `fillOf` 纯函数 | 无状态、无 DOM、无异步；`kindOf` 用 `hasOwnProperty` 防原型污染（`#9837`）；实测 `__proto__`/`toString` 均回落 topic | 无 | 无需 |
| 2.9 | 3D 材质池 | 新增 2 个颜色键 → 多 2 份 glow 贴图/材质（`#10395-10412`），内存微增、无时序影响 | 低 | 无需 |
| 2.10 | 客户端 store 残留 | `daysDraft/daysSaving/setDaysDraft/clearDaysDraft/setSaveState`（`client.js#24-33`）在 2026-09-23 改本地态后已死；本次又删了组件侧草稿 → 彻底死代码；本地 `saving`（`#59`）只写不读 | 低 | 下次清理，非本次必需 |

**线程与锁结论（第 3 项）：** 服务端是 Node 单线程同步循环，350 节点实测 **0.078 ms/请求**（1000 次 × 350 节点 = 78.26 ms，本报告实测）；相对既有图构建 150–180 ms 可忽略，无锁、无共享可变状态、无新增异步。前端 `fillOf` 是纯函数；3D 库异步加载/重绘时序未改（`#10479-10550` 仅把 `colorOf` 换成 `fillOf`）。**无竞态。**

---

## 3. 表 3 · 边界场景（会发生什么 + 兜底）

> 标「实测」的项由本报告用**真实代码抽取**执行（`new Function` 语法校验 + fake-React/fake-canvas 行为测试 + 真实 `graph.json` 载荷）；标「静态」的为读码判断。

| # | 场景 | 会发生什么 | 兜底 / 证据 |
|---|---|---|---|
| 3.1 | `kind` 缺失（旧后端） | 前端 `kindOf` → `"topic"` → 域色 | 实测：`#5b6478`（无域）/`#aaaaaa`（有域）；`index.js#9835-9842`（G3） |
| 3.2 | `kind:null` / `""` / `"weird"` / `"__proto__"` / `"toString"` | 一律 `"topic"` → 域色 | 实测全通过；`hasOwnProperty.call` 防原型链（`#9837`） |
| 3.3 | 节点为 `null`/非对象 | `fillOf(null)` → `#8b93a8`；后端循环 `if(!n||typeof n!=="object") continue`（`#9508`） | 实测 `#8b93a8` |
| 3.4 | `isSessionTopicName` 不存在（旧/瘦身版 p25-topics） | `typeof === "function"` 守卫（`#9513`）→ checkpoint 全部回落 `topic`（**静默**，仅视觉退化） | 静态；无日志（低危 M6） |
| 3.5 | `isSessionTopicName` 抛错 | 每节点内层 catch → `topic`（`#9510-9516`），图本体照常返回 | 静态；**静默**（无日志） |
| 3.6 | `out` 为错误对象 / `nodes` 非数组 / 空库 | `Array.isArray(out.nodes)?…:[]`（`#9506`）→ 循环空转；handler 照常 `res.end` | 图谱测试 G12（空库/单主题）PASS |
| 3.7 | `KIND_COLOR` 里没有的 kind | `kindOf` 白名单 → `topic` | 实测 3.2 |
| 3.8 | 旧后端 + 新前端 | 功能缺失（全 topic 色）但**不报错** | G3；静态 |
| 3.9 | 新后端 + 旧前端（灰度期） | 旧前端忽略 `kind`，正常工作 | 只增字段；静态 |
| 3.10 | 主题名同时满足 `笔记·` 与 session 规则 | **note 优先**（`#9512-9513`）→ 正确 | 实测真实库 2/2 笔记同时满足两条规则，均判 note |
| 3.11 | 主题名前后有空白（`" 笔记·x/y"`） | 后端前缀判断**不 trim**（`#9511-9512`），而 `isSessionTopicName` 会 trim（`p25-topics.js#245`）→ 该笔记会被判 **checkpoint** | 真实库 0 例（实测 leadingSpace=0/untrimmed=0）；属理论边界（低危） |
| 3.12 | 归档节点（`includeArchived=1`） | 也计算 `kind`；checkpoint 灰色填充 + 归档灰色虚线描边 → 两种「灰」语义叠加，可辨性下降 | 静态；视觉问题（低） |
| 3.13 | focus 子图 | 同一规则作用于子集，无特殊分支 | 静态 |
| 3.14 | 并发请求 | 每次 build 新建节点对象，无共享写 | 2.5 |
| 3.15 | 1000 节点（3D `maxNodes=1000`） | 响应 +15 KB 级；循环 <0.3 ms | 实测 0.078 ms/350 节点 |
| 3.16 | 图例在「无会话节点」时 | **仍固定显示**两行「会话笔记/会话检查点」（`#10844-10845` 无条件拼接）→ 空库/聚焦子图会误导 | 静态（低危 M7） |
| 3.17 | 成本面板历史 `archive` kind | 行仍渲染，label 回落英文 `"archive"`，不崩；host* 桶隐藏 | **实测**（fake-React 执行真实 `CostPanel`）：`archive` 行出现、`hostMain/hostSub/hostUsage` 不出现、`cost=null` 不抛 |
| 3.18 | 成本面板未知 kind 与「今日总额」 | 未知 kind 进「分环节」表，但 `costSum` 只累加 `COST_KINDS`（`client.js#196-207`）→ 总额**不含**未知 kind；构造数据实测总额 300 vs 明细 300+150+42 | 实测；当前真实「今日」无 archive 事件，故线上暂不显现（低危 M10） |

---

## 4. 设计 §6 护栏 G1–G8 逐条核对

| 护栏 | 落实位置（改动后行号） | 结论 | 备注 |
|---|---|---|---|
| G1 `kind` 判断包 try/catch，异常回落 topic | `index.js#9505-9519`（外层 try 9505-9519 + 每节点内层 try 9510-9516） | **PASS** | 静默回落，无日志（低危 M6） |
| G2 只增字段，不改既有字段名/类型 | diff 仅新增；节点白名单 `#9428-9434` 原本无 `kind`；**字节级 only-append 证明**：把 `,"kind":"…"` 全部剥掉后与基线**逐字相等**（§5.3） | **PASS** | — |
| G3 前端 kind 缺失 ⇒ topic | `index.js#9835-9842`；边界实测（§3） | **PASS** | — |
| G4 store 不再引用 staleCount | `client/lib/client.js` grep `staleCount\|staleSessionDays\|staleAction` = **0**（本报告复跑） | **PASS** | — |
| G5 不再有 `setConfigField("stale…")` | grep = 0；执行 `MemorySettingsRow` 捕获到 `setConfigField` 调用仅 `integrateEnabled/integrateDays/monitorEnabled` | **PASS** | — |
| G6 历史 `archive` kind 仍能渲染 | `client.js#156-161`（label 映射 + 原串回落）、`#183-189`（byKind 未知 kind 带入）、`#310-315`（extraKinds 追加行） | **PASS（有口径瑕疵 M10）** | 行能渲染；但 `costSum` 不计未知 kind → 明细/总额可能不一致 |
| G7 设置页在 `staleSessionDays` 缺失时正常渲染 | 执行真实 `MemorySettingsRow`（全键缺失）→ 渲染「自动整合记忆/使用监控/记忆使用统计」，无 `漏网/stale/archive` 文本、不抛错 | **PASS（实测）** | — |
| G8 新增颜色不覆盖高亮/选中逻辑 | 只改 3 处填充：`#10395`（3D 神经元）、`#10487`（3D 内置球 nodeColor）、`#10671`（2D 圆点）；描边/高亮逻辑 `#10674-10692` **未动**；3D 选中不改色（`select()` `#10744-10749`）；图例域色块仍 `colorOf`（`#10832`） | **PASS** | 但撞色破坏「颜色可区分」语义（M2） |

---

## 5. 观测门（skill 强制项）

### 5.1 G-0 先观测后实现 —— **未通过（未做实现前观测）**

| 证据 | 内容 |
|---|---|
| 设计文档 mtime | `36-panel-followup-design.md` 2026-11-05 **10:58:27** |
| 实现 mtime | `client/lib/client.js` **11:05:41**、`index.js` **11:07:21** |
| 设计 §1「现状表」性质 | 逐行对照 605 行旧 client.js 的**代码阅读**（L18-19/L22/L41-45/L55-61/L79-83/L91-118/L135-137/L141-170/L239 与基线文件完全对得上）→ **不是真机观测** |
| 唯一观测脚本 | `_verify/_q-kind-observ.mjs` mtime **11:20:20**（**晚于**实现 13 分钟，也晚于本审计开始 11:19:42）；内容自述「复刻 handler 的 kind 规则」（`#23`），**不调用** `topicDbGraphHttpHandler`；仓库内**无该脚本输出留档** |
| 真机验证（设计 §7.5） | 无截图/无 DOM dump/无真机请求日志；`.task/1101-dsh-mimo-survey/` 下无本轮实现/验证报告（最新仍是 10:58 的设计） |

**判定：G-0 未通过。** 设计里的「现状表」只能算代码阅读；补写的观测脚本是事后复刻、且未留输出，不能替代「真机路径观测」。
**补救（部署前必做）：** ① `curl` 取当前（旧版）`graph.json` 基线并落盘；② 设置页真机截图/DOM 记录删前控件；③ 把 `_q-kind-observ.mjs` 改成**调用真实 `topicDbGraphHttpHandler`**（或部署后 curl 真机端点）并保存输出。

### 5.2 G-1 运行时验证门 —— **部分通过**

| 验证 | 结果 |
|---|---|
| `node --check index.js` / `node --check client/lib/client.js` | **exit 0 / exit 0**（本报告复跑） |
| 内嵌图谱 JS 语法 | `node --check index.js` **不覆盖模板字符串**；本报告抽取 54,248 字符做 `new Function` → **语法 OK** |
| 内嵌图谱 JS 运行 | `_verify/topicdb-graph-check.mjs` 的 G07b 用 mock canvas **真实执行**内嵌 JS：PASS（`legendLen=950`，含新图例） |
| 图谱套件回归 | 新代码 **75 PASS / 2 FAIL**；对**旧部署 index.js** 同套件 **75 PASS / 2 FAIL**，失败项**完全相同** → 非本次引入。2 项既有漂移：① G01 断言 `capsUsed.hardMaxNodes===600`，代码 2026-11-02 已改 600→2000（`index.js#8955`）；② G04 同上硬上限期望 600 vs 实际 2000 |
| client.js 组件 | 仓库**无**测试执行它（只有语法检查）；本报告用 fake-React 执行了 `MemorySettingsRow`（G7）与 `CostPanel`（G6）→ 行为符合设计；**真实浏览器/宿主槽框架渲染未验** |

### 5.3 G-9 产出物判据 —— **`/dsh-memory/graph.json` 返回字节会变：有意的、只增不改**

**真实基线（当前部署的旧版，2026-11-05 11:28 实测）：**
- HTTP 200，**168,338 B**，`nodes=350`、`links=665`、**无 `kind` 字段**（节点键集合见 §1.1）。
- 规则复刻（与 `index.js#9505-9519` 同序）跑真实载荷：`note=2`、`checkpoint=26`、`topic=322`。
- 预测改动后：**173,716 B（+5,378 B，+3.19%）**（topic +15 B/节点、note +14、checkpoint +20）。
- **only-append 证明**：对预测结果执行 `replace(/,"kind":"(note|checkpoint|topic)"/g,"")` → **与基线逐字相等（true）**；`links`、`stats` 序列化字节**不变**。
- 分类正确性旁证：真实库中 28 个会话节点 = 2 note（无域）+ 26 checkpoint（域 T-0421）；`nonDetailClassified=0`（域/项目线节点无被误判）；`existingKindFieldCollisions=0`。

**可执行验证命令与期望结果（部署前后各跑一次）：**

```powershell
# ① 部署前基线（当前端口 = 本机 DSH Web GUI 同源；也可换成 /memory-panel 打开后的地址）
curl.exe -s "http://127.0.0.1:54923/dsh-memory/graph.json" -o "$env:TEMP\graph-before.json"

# ② 部署后（同一端口；重启后端口可能变化，用新 GUI URL）
curl.exe -s "http://127.0.0.1:<新端口>/dsh-memory/graph.json" -o "$env:TEMP\graph-after.json"

# ③ 结构断言（期望：true / 全部节点带合法 kind / note=2 checkpoint=26）
node -e "const fs=require('fs');const a=JSON.parse(fs.readFileSync(process.env.TEMP+'/graph-after.json','utf8'));const ok=a.nodes.every(n=>['note','checkpoint','topic'].includes(n.kind));const c={note:0,checkpoint:0,topic:0};a.nodes.forEach(n=>c[n.kind]++);console.log(JSON.stringify({allNodesHaveKind:ok,nodes:a.nodes.length,links:a.links.length,dist:c,bytes:fs.statSync(process.env.TEMP+'/graph-after.json').size}))"

# ④ 只增不改（若部署期间主题库无写入，期望 true；有写入则比较节点 id 交集上的字段）
node -e "const fs=require('fs');const a=fs.readFileSync(process.env.TEMP+'/graph-after.json','utf8');const b=fs.readFileSync(process.env.TEMP+'/graph-before.json','utf8');console.log('strip-kind==before:',a.replace(/,\"kind\":\"(note|checkpoint|topic)\"/g,'')===b)"
```

**期望结果：** `allNodesHaveKind=true`；`links`/`stats` 与基线结构一致；`strip-kind==before` 为 `true`（库无写入时）；字节约 +3.2%（本次基线 +5,378 B）。
**注意：** 该响应**逐请求就不确定**（`stats.generatedAt`#9473、`stats.buildMs`#9461），所以**不能**用整体 sha256 做 golden；必须用「剥掉 kind 后逐字相等」或结构比较。
**可能受影响消费方：** 仓库内只有面板与验收脚本（均容忍，已 A/B 验证）；外部未知（JSON 只增字段通常兼容；若外部做严格 schema/字节哈希会受影响，但字节哈希本就不可能稳定）。

### 5.4 G-3 删除型改动 —— 能力可达性证明（逐项）

| 被删 UI（基线行号） | 服务的能力 | 后端现状 | 现在还有别的入口吗 | 结论 |
|---|---|---|---|---|
| 标题下「⚠️ 有 N 个会话未整合…」提示（L135-137） | 展示未整合会话数 | `staleCount` 恒 0（§2.1） | 无（也不需要） | **安全删除** |
| 「漏网会话检测天数」输入框（L141-157）+ `commitDays`（L91-118） | 设置 `staleSessionDays` | **仍生效**（子代理摘要窗口 `#5969/#6025/#20214`；当前值 1） | ❌ **无 UI**；仅 `.config.json` 手改或 `POST /dsh-memory/config`（`#11946-11948`，未文档化） | **能力回归（M1）**：需决策加回最小控件或文档声明 |
| 「漏网处理动作」三按钮 + 联动说明（L158-176） | 设置 `staleAction` | **已无功能分支**（仅校验/日志 `#6510-6514`） | 无（不需要） | **安全删除** |
| `ACTION_OPTIONS/ACTION_LABEL`（L55-61）、`useStore` 三键（L79-83）、store 三键（L18-22/41-45） | 上述两行的支撑代码 | 同上 | — | **安全删除** |
| `syncLiveCount` + 120s 轮询（L558-572） | 刷新 `staleCount` 显示 | 恒 0 | 无 | **安全删除**（并少一次轮询） |
| 消耗分类 `["archive","漏网归档"]`（L239）+ T6 图例（L241） | 展示漏网归档成本/触发 | 归档链 2026-11-04 已整体删除（`index.js#1-14`），无新事件 | 历史账本仍可经 G6 渲染（英文 `archive`）；T6 历史计数不再显示 | **安全删除**（口径瑕疵 M10） |

**用户困惑风险：** `README.md#109`「设置 → 通用设置 → 记忆：开关、**漏网策略**、阈值、用量」、`#251`「想调整去 设置 → 通用设置 → 记忆」、`#255-256` 配置表仍把 stale 两键写成用户可调项；`package.json#6`、`client/package.json#3` 描述仍写「漏网会话检测」→ **删除 UI 后文档指向不存在的控件**（低危 M5，建议同批更新）。

---

## 6. G-9.2 反面问题：这项改动可能怎样让现有功能失效（≥3 条，实际列 8 条）

| # | 失效路径 | 触发条件 | 后果 | 现有兜底 | 等级 |
|---|---|---|---|---|---|
| F1 | **颜色语义误读**：`KIND_COLOR` 与 `COLORS` 撞色（`#22d3ee`/`#94a3b8` 分别是调色板第 6/8 色） | 任意库只要有 ≥6 个域（真实库 10 个） | 21 个普通节点显示成「会话笔记」色、8 个显示成「检查点」色；图例色块重复 → 用户把普通主题当会话记忆 | 无 | **中（M2）** |
| F2 | **笔记被判成检查点**：`笔记·` 前缀是唯一判别；若命名约定变化（前缀改 `笔记:`/`笔记-`/带前导空格） | 未来命名改动或导入带空白主题名 | 笔记静默变灰（checkpoint），无报错 | 当前顺序正确；真实库 0 例 | 中（注释/测试缺失） |
| F3 | **检查点静默变普通主题**：`p25Topics.isSessionTopicName` 被重命名/移除/抛错 | p25-topics 重构、或异常输入 | 26 个检查点全部回落 topic 色，无日志、无告警 | `typeof` 守卫 + 内层 catch（**静默**） | 低-中（M6） |
| F4 | **外部消费方严格校验**：若第三方脚本/未来代码对 graph.json 做 JSON-Schema `additionalProperties:false` 或字段集合精确比对 | 存在未知外部消费者 | 解析/校验失败 | 仓库内无此类消费方；只增字段 | 低（外部未知） |
| F5 | **成本面板总额与明细不一致**：`costSum` 只加 `COST_KINDS`，未知 kind 只进明细行 | 历史账本含 `archive`（或未来新增 kind）且走 raw daily 路径 | 今日/7 天总额小于明细之和 | G6 只保证「能渲染」，未保证「计入总额」 | 低（M10） |
| F6 | **`kind` 字段名冲突**：未来 graph 节点新增真实 `kind`（如节点类型） | 后续 schema 演进 | handler 无条件覆盖，上游值静默丢失 | 当前白名单无 kind | 低（M8） |
| F7 | **图例误导**：固定显示两行会话记忆图例 | 空库/聚焦子图/该子图无会话节点 | 用户以为图里有会话记忆 | 无 | 低（M7） |
| F8 | **`staleSessionDays` 不可调**：唯一 UI 删除 | 用户想调整子代理摘要窗口（当前 1 天） | 只能手改 `.config.json`（未文档化） | 配置文件/POST 端点仍在 | **中（M1）** |

---

## 7. 方案对比（≥2 个更小/更稳替代 + 推荐）

| 方案 | 改动面 | 产出物字节 | 优点 | 缺点/风险 | 评价 |
|---|---|---|---|---|---|
| **A（本次实现）** 后端 handler 加 `kind` + 前端 `fillOf` | index.js +39/−3、client.js +23/−111 | **graph.json +3.19%**（+5,378 B/350 节点） | 分类规则**单点**在后端；前端只消费；语义清晰；未来 CLI/其他前端可复用 | 产出字节变化（外部未知）；字段名泛化；需双端部署（已双向兼容） | **推荐（需修 M2）** |
| **B（更小/更稳）** 纯前端按 `name` 判断，不改 handler | 只改 index.js 内嵌 JS（约 +15 行） | **graph.json 字节零变化** | 不触碰任何消费方契约；G-9 直接「无变化」；部署只涉及一个文件 | 规则**双份**（`笔记·` 前缀 + 与 `p25-topics.js#244-247` 同构的正则），易漂移；S1 的顺序陷阱要在前端再实现一遍 | 若「最小风险」指产出物契约，B 更稳；但双份规则是长期债 |
| **C（最小）** 只删死 UI，不做图谱视觉区分 | client.js −88 行 | 无变化 | 风险最低 | 不满足需求（无视觉区分） | 不推荐（需求未达成） |
| **D（折中）** 后端只给 note/checkpoint 发 `kind`，topic 省略 | index.js +39/−3（微调） | +548 B（只 28 个节点） | 字节增量小 10 倍；G3 已支持缺失 | 前端 `kindOf` 已能处理；但「缺省=topic」隐式约定更重 | 可选优化，非必需 |

**推荐：A + 修 M2。** 理由（最小风险优先的排序依据）：
1. 仓库内 graph.json 消费方**全部容忍**只增字段（已 A/B 实测），且该响应**本就逐请求不确定**（generatedAt/buildMs）→ 「字节变化」不是新增风险面；
2. 而 B 的双份规则风险更高：真实库证明 `笔记·<wsKey>/<sid8>` **同时匹配** session 规则，顺序/正则任何一边改动都会造成静默误判（S1），单点规则更安全；
3. A 已实现且通过语法/图测试/边界实测，回退成本 = 恢复 2 个文件（部署副本即基线，见 §11）。

---

## 8. 影响面结论

| 维度 | 是否波及 | 依据 |
|---|---|---|
| ① 核心功能（记忆读写 / 压缩重灌） | **否** | diff 只触及 graph HTTP handler 与设置页 UI；无 DB 写路径、无 `topic.json/search.json/stats.json` 生成器改动（diff hunk 仅 `topicDbGraphHttpHandler` 与 `TOPICDB_GRAPH_JS`）；`node --check` + 图套件 75 PASS（与旧版 A/B 完全一致） |
| ② 相关子系统 | **是**：知识图谱（视觉 + graph.json 字节）、消耗面板（分类映射）、设置页（删 5 个可视元素）<br>**否**：搜索（topic.json/search.json 未动）、CLI（不读 graph.json）、启动注入 | §1、§5.3 |
| ③ 性能 | **否/可忽略** | 分类循环 0.078 ms/350 节点；graph.json +5.4 KB（+3.2%）；client.js 体积 38,535→33,668 B（−12.6%）；少一个 120s 轮询 |
| ④ 启动 | **否** | 无启动路径改动；handler 按需执行；client 插件只是变小 |
| ⑤ 数据一致性 | **否** | 只读派生字段，不落库；`stats.json` 输出未变（`live.staleCount` 仍 0）；配置键保留（`index.js#6428-6429/#6364/#11946-11948`） |

---

## 9. 必须修的 findings（中/高）

> 无「高」。以下 3 项中危：M2、M4 建议部署前修；M1 需产品决策并留档。

### M2（中）新增色与域调色板撞色，破坏「颜色可区分」语义
- **证据**：`index.js#9784` 调色板 `COLORS` 已含 `#22d3ee`（第 6 色）与 `#94a3b8`（第 8 色），与 `#9834` 的 `KIND_COLOR` **完全相同**。
- **真实库实测**（基线 graph.json 350 节点、10 域，按 `updateLegend` 顺序复算）：域 `T-0408 → #22d3ee`、域 `T-0427 → #94a3b8`；因此 **21 个普通主题节点与「会话笔记」同色、8 个与「会话检查点」同色**；图例里这 2 个域色块与两个 kind 色块重复。会话节点本身可见变化：2 个笔记（无域 `#5b6478`→`#22d3ee`）、26 个检查点（域 T-0421 原 `#ffb454`→`#94a3b8`）。
- **修复（最小）**：把 `KIND_COLOR` 换成不在 `COLORS` 中的两色（并注意与 `#ffd84d` 搜索黄圈、`#5b6478` 无域灰区分），或从 `COLORS` 中移除/替换这两个色位（只影响 2 个域的颜色，需用户确认），或给会话节点加非颜色编码（如 note 实心环 / checkpoint 虚线圈）。
- **验收**：真实库渲染后，任意普通主题节点不得与 note/checkpoint 同色；图例色块无重复。

### M4（中/流程）G-0 观测门未通过；设计 §7.5 真机验证未做
- **证据**：§5.1（设计 10:58 → 实现 11:05/11:07 → 观测脚本 11:20 事后补写且是复刻规则、无输出留档；`.task` 无本轮实现/验证报告）。
- **修复**：部署前 ① 落盘旧版 `graph.json` 基线；② 设置页删前控件截图/DOM 留档；③ 观测脚本改为调用真实 handler（或部署后 curl 真机端点）并保存输出；④ 部署后补设计 §7.5 真机检查（设置页无漏网控件/无 JS 报错；图谱颜色可区分——注意先修 M2 再验，否则该项会被撞色打脸）。

### M1（中，需产品决策）`staleSessionDays` 从 UI 删除，但该参数仍生效
- **证据**：设计 §4.3（`36-panel-followup-design.md#60`）写「写了也没人读」→ **错误**：`index.js#5969`（`runSubagentDigestBatch` 的 `maxAgeDays` 默认值）、`#6025`（每小时自动摘要通道）、`#20214`（手动 `/subagents-archive`）真实读取；当前 live 配置 `staleSessionDays=1`（`GET /dsh-memory/config` 实测）；删除后唯一入口 = `.config.json` 手改 / `POST /dsh-memory/config`（`#11946-11948`，未文档化）。
- **二选一**：
  - **(a) 加回最小控件**：复用 `itemRow` 一行「子代理摘要窗口（天）」，仍写 `staleSessionDays`（约 +15 行，client.js 回到 ~532 行）；
  - **(b) 明确接受**：在 README/设计里声明「该参数仅可通过 `~/.dsh/memory/.config.json` 调整」，并更新 `README#255` 的措辞；同时评估当前值 1 天是否是要长期保留的语义。
- **建议**：(a)，因为该参数仍影响子代理归档范围，用户当前已显式调过（=1）。

---

## 10. 可接受但需记录（低）

| # | 事项 | 证据 | 建议 |
|---|---|---|---|
| L1 | 文档/元数据失真：README 仍教用户去设置页调漏网策略/天数 | `README.md#88/#109/#251/#255-256`；`package.json#6`；`client/package.json#3` | 与本批一起更新（用户困惑风险直接相关 G-3） |
| L2 | `index.js` 文件头注释已过时：仍说「client.js 设置面板仍显示漏网控件」 | `index.js#14` | 更新为「2026-11-05 已删除面板漏网 UI」 |
| L3 | 分类失败静默：`isSessionTopicName` 缺失/异常 → 全量回落 topic，无日志 | `index.js#9510-9516` | 首次异常 `cwarn` 一次（带计数），避免「悄悄全灰」 |
| L4 | 图例无条件显示两行会话记忆 | `index.js#10844-10845` | 仅当图中存在 note/checkpoint 节点时显示（或显示 0 计数） |
| L5 | 成本面板未知 kind 不计入总额/趋势 | `client.js#196-207` vs `#310-315`；实测总额 300 vs 明细 300+150+42 | `costSum` 遍历 `dayMap` 全键或把 extraKinds 传入；或 UI 标注「未知环节不计入合计」 |
| L6 | 历史 `archive` 显示为英文 `"archive"` 而非「漏网归档（历史）」 | `client.js#161` 回落 `String(k)`；实测输出 `archive` | 加一张 legacy label 映射（1 行） |
| L7 | `kind` 字段名过泛，未来可能被真实 schema 占用/覆盖 | `index.js#9517` 无条件赋值；白名单 `#9428-9434` 当前无 kind | 改名 `memKind` 或加断言 |
| L8 | 死 store 字段残留（本次删除后彻底无用） | `client.js#24-33`（`daysDraft/daysSaving/setDaysDraft/clearDaysDraft/setSaveState`）；`#59` 本地 `saving` 只写不读 | 下次清理（非本次回归） |
| L9 | 前缀判断不 trim，理论边界会把「带前导空白的笔记」判成 checkpoint | `index.js#9511-9512` vs `p25-topics.js#245`；真实库 0 例 | 用 `nm.trim().indexOf("笔记·")===0`（与 `isSessionTopicName` 的 trim 语义对齐） |
| L10 | 归档节点「灰虚线」与 checkpoint 灰填充语义叠加 | `index.js#10677-10683` + `#9834` | 视觉观察后再定；可给 checkpoint 用非灰描边 |
| L11 | 无 canvas 列表视图无 kind 区分（设计只要求图） | `index.js#10807-10820` | 可选：列表加「类型」列 |

---

## 11. 回滚与部署（G-5）

- **改动可独立回退**：仅 2 个文件，无 DB 迁移、无配置键删除；恢复部署副本即可：
  - `C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js`（20322 行基线，仍在）
  - `C:\Users\Starry\.dsh\profiles\web\plugins\dsh-memory-client\lib\client.js`（605 行基线，仍在）
- **建议部署前**先把这两个基线文件各复制一份 `.bak`（部署会覆盖部署副本，覆盖后基线只剩仓库外这一份）。
- 部署方式（据 `install.ps1#896-901/#1473-1481`）：payload `client/**` → `<plugins>/dsh-memory-client/`，主插件 → `<plugins>/memory/`；**未发现独立构建脚本**（`client/package.json` 的 `exports` 直接指向 `lib/client.js`，无 build script）→ 设计 §8 的「重建 bundle」在本仓不成立/至少未找到；部署后需**重启宿主**并核对 `index.js` 启动日志的 `SELF_FP` 与文件 sha 一致。
- **部署顺序**：双向兼容（旧前端忽略 kind / 新前端缺 kind 回落 topic），可先 index.js 后 client.js，一次重启即可。

---

## 12. 诚实记录：本审计**没能验证**的部分

1. **未真机渲染**：设置页与知识图谱均未在真实浏览器/宿主槽框架里打开过；`client.js` 只有语法检查，本报告用 fake-React 执行了 `MemorySettingsRow`/`CostPanel`（逻辑层），但真实 DOM/React/宿主注入行为未验。
2. **未部署、未取到「新 graph.json 的真实字节」**：+5,378 B 是「真实基线载荷 + 与 handler 同序规则复刻」的**预测**；only-append 证明是对预测结果的（强）证据，但仍需部署后 curl 实测（§5.3 命令）。
3. **未独立复跑** P0 71/71、note 29/29、gate 18/18（已知证据来自实现者）；只独立跑了 `_verify/topicdb-graph-check.mjs` 的新旧 A/B。
4. **未验证外部/第三方** 对 `/dsh-memory/graph.json` 的消费（仓库内无，README 仅文档化；外部不可见）。
5. **未验证** 客户端插件在宿主中的加载/热更新/「bundle 重建」流程（未找到构建脚本；安装器复制路径见 §11）。
6. **未运行** `_verify/_q-kind-observ.mjs`（它会打开真实主题库；本报告改用真实 graph.json 载荷 + `p25-topics.js` 纯模块做等价观测，避免对用户记忆库产生任何写入）。
7. **未观测** `staleSessionDays` 删除后子代理摘要通道的**运行时**影响强度（代码路径已确认读取；实际归档行为/频率未观测）。
8. **`.monitor.json` 历史 `cost` 段**是否含 `archive` 事件未逐一核对（只确认文件无 `staleCount`；成本面板口径问题用构造数据验证）。
9. 3D 视觉（材质/颜色实际观感、归档灰与 checkpoint 灰的可辨性）未在真机看。

---

## 附录 A · 审计使用的证据命令（可复现）

```powershell
# 1) 改动范围 = 部署副本 vs 仓库（仅 2 文件不同）
git diff --no-index --numstat -- "C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js" index.js
git diff --no-index --numstat -- "C:\Users\Starry\.dsh\profiles\web\plugins\dsh-memory-client\lib\client.js" client\lib\client.js

# 2) 静态门（设计 §7.1-7.4）
node --check index.js
node --check client\lib\client.js
(Select-String -Path client\lib\client.js -Pattern "staleCount|staleSessionDays|staleAction" -AllMatches).Matches.Count   # 期望 0
(Select-String -Path client\lib\client.js -Pattern "漏网" -AllMatches).Matches.Count                                      # 期望 0

# 3) graph.json 真实基线
curl.exe -s "http://127.0.0.1:54923/dsh-memory/graph.json" -o "$env:TEMP\graph-before.json"
# 期望：168,338 B、nodes=350、无 kind

# 4) 图谱套件 A/B（新代码 vs 旧部署副本）
node _verify\topicdb-graph-check.mjs                                  # 75 PASS / 2 FAIL
# 把测试里的 PLUGIN 常量指向部署副本后再跑，期望同样 75 PASS / 2 FAIL 且失败项相同
```

## 附录 B · 关键行号索引（改动后）

- 后端：`index.js#327`（p25Topics import）、`#8954-8955`（caps 常量）、`#8992`（graph 路由）、`#9105-9106`/`#9336-9338`（base 缓存）、`#9325-9476`（build）、`#9428-9434`（节点白名单）、`#9479-9524`（handler）、`#9499-9519`（kind 标注）、`#11039-11042`（测试导出）。
- 前端图谱：`index.js#9784`（COLORS）、`#9831-9842`（KIND_COLOR/kindOf/fillOf）、`#9931-9960`（load）、`#10395`/`#10487`/`#10671`（3 处填充）、`#10674-10692`（描边/高亮）、`#10744-10749`（select）、`#10832`（域图例）、`#10843-10845`（kind 图例）。
- 客户端：`client.js#15-47`（store）、`#53-147`（MemorySettingsRow）、`#59`（saving 死状态）、`#98-143`（保留的三行 UI）、`#151-161`（COST_KINDS/G6 label）、`#178-207`（costDayMapOf/costSum）、`#255-358`（CostPanel）、`#310-315`（未知 kind 行）、`#409-511`（apply/injected）。
- 配置/统计：`index.js#5969/#6025/#20214`（staleSessionDays 真实读取）、`#6364`（DEFAULT_CFG）、`#6428-6429`（schema）、`#6463/#6471/#11766`（staleCount）、`#6510-6514`（staleAction 校验）、`#11946-11948`（WRITABLE）。
- 文档：`README.md#88/#109/#111/#251/#255-256`；`package.json#6`；`client/package.json#3`；`index.js#1-14`（头注释）；`client.js#1`（版本注释）。

---

*本报告为只读审计，未修改任何代码/配置，未部署。报告中所有「实测」均由独立命令产生（临时脚本位于 `%TEMP%`，不在仓库内）。*
