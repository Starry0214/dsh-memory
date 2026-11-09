# 统计面板「消耗」区块（P3-3b）验收报告

- 任务：task-18（P3-3b 统计面板「消耗」区块）
- 实施：mem-cost-panel（team lead: lead）
- 日期：2026-11-02
- 唯一改动文件：`C:\Users\Starry\.dsh\memory\.stats-panel.html`（41,950 B → 69,285 B）
- 备份：`C:\Users\Starry\.dsh\memory\.stats-panel.html.bak-pre-cost-20261102-154948`（41,950 B，SHA256 `68E2CE77…B2321B`，与改动前原文逐字节一致）
- 回滚：`Copy-Item <备份> <原文件> -Force`（面板每请求实时读该文件，回滚后刷新浏览器即恢复）

## 一、改了哪些行（纯追加 × 2 块）

| 位置 | 新文件行号 | 内容 |
|---|---|---|
| 原 `</style></head>` 之间（原第 139/140 行之间） | **141–170** | `<style id="cost-panel-style">`：仅新增 `#cost-block` / `.cost-*` 选择器，未触碰任何既有选择器 |
| 原 `</script>` 与 `</body>` 之间（原第 510/511 行之间） | **542–955** | `<script id="cost-panel-script">`：纯函数渲染区（550–919 附近）+ 隔离 IIFE（DOM 挂载，不改既有 `load()/render()`） |

> 结构自检（机器验证）：把上述两个新增块整段剥离后，新文件与备份**逐字节完全一致**（`stripped === backup`）；
> 原有 **18 个 id、20 个函数名**全部保留，无重命名/删除/覆盖。

## 二、新增区块 id（全部新前缀 `cost-`）

静态：
- `#cost-panel-style`（新样式块）
- `#cost-panel-script`（新脚本块）

运行时（由新脚本追加进 `#app` 末尾，不占既有容器）：
- `#cost-block`（区块容器，`display:flex` 纵向 4 张卡片）
- `#cost-today` — 今日消耗：5 张 KPI（真实 tokens / 估算 tokens / 检查点触发 / 失败 / 环节记账次数）+ 累计行 + 口径说明
- `#cost-trend` — 近 7 天趋势：估算 tokens（蓝柱）+ 触发次数（橙柱），纯 CSS 柱状，悬停看当日明细
- `#cost-kinds` — 分环节表：13 环节固定顺序（以服务端 `kindList` 为准），列＝环节/次数/输入·注入字符/输出字符/真实 tokens 入·出/估算 tokens/均时长/失败
- `#cost-top` — Top 会话：按检查点写入估算 tokens 排序，最多 10 行
- `#cost-loading`（取数中的占位卡片，随后被真实内容替换）
- `#cost-degraded`（降级卡片，仅 cost 缺失/非法时出现）

数据源：同源 `GET /dsh-memory/stats.json` 的 `cost` 段（= `p3-cost.js summarize()` 输出）；
字段用法：`today`/`cumulative`/`byKind`/`trend7d`/`topSessions`/`kindList`/`limits`/`events`（真实 tokens 仅取 `real.*`，估算取 `est.*`）。

## 三、降级策略（契约：绝不抛错、绝不影响其他区块）

1. **判定层**：`costPanelHtml(cost)` 入口先 `try/catch`；`cost` 非对象、为 `null/undefined/数组/标量`，或一个结构字段都没有（`today/cumulative/byKind/trend7d/topSessions/events` 全缺）⇒ 直接返回 `#cost-degraded` 卡片，正文含「**暂无消耗数据**」，并附一行「面板已降级显示，其他区块不受影响」。
2. **字段层**：所有取数走 `costN()`（非有限数/字符串/布尔/`NaN`/`Infinity`/`null` 一律安全归 0），所有对象走 `costIsObj()`，数组走 `Array.isArray()`；缺段/缺字段 ⇒ 该卡片内部显示局部的「暂无…」文案，其余卡片照常渲染。已知真实数据里的 `avgDurMs: null`（服务端 `Math.round(undefined/n)` 序列化）也已兼容。
3. **接线层**：DOM 挂载整体包在独立 IIFE 内并 `try/catch`；`MutationObserver` 不可用或挂载失败时退化为「首屏/2.5s 兜底各挂一次」；观察器只订阅 `#app` 的 `childList`（不订阅 subtree），追加自身节点不会自激。任何异常都不外溢到既有 `load()/render()`。
4. **只读**：仅同源 `GET`（`fetch(..., {cache:"no-store"})`），无 POST/PUT/DELETE、无清空/改阈值按钮、无 localStorage/cookie 写入（脚本静态扫描验证：无外链 http(s)、无 XHR、无动态 import）。

## 四、为什么不会破坏现有功能（一句话论证）

**既有代码一个字节都没动（剥离新增块后与备份逐字节一致），新增逻辑全部在新前缀 id/函数内、且异常就地吞掉，仅向 `#app` 末尾追加一个兄弟节点——所以现有取数、渲染、刷新、日志轮询、主题库注入等逻辑路径完全不受影响。**

补充：与现有「刷新」按钮的协作方式是**零侵入**的——`load()` → `render()` 用 `innerHTML` 整体替换 `#app` 时，新脚本的 `MutationObserver` 察觉 `#cost-block` 被冲掉，再追加并复用同源 `stats.json` 刷新本区块（每次刷新多一次同源只读 GET，无副作用）。

## 五、我自己跑的验收（三层，全过）

### ① 语法：抽内联脚本 → `node --check`
- 从 HTML 精确抽取 `<script id="cost-panel-script">` 全部内容 → `panel-script.mjs`（21,784 字符）
- `node --check panel-script.mjs` → **exit 0**（语法合法；浏览器 API 仅运行期引用，不参与解析）

### ② 渲染单测：造模拟 `stats.json` 用 node 直接跑渲染函数
把纯函数区（`#cost-pure-begin`…`#cost-pure-end`，17,693 字符，不接触 DOM）抽成 ESM 后跑 `render-test.mjs`：
- **A. 实时数据**：HTTP 200 取 `stats.json` 的 `cost` 段 → 非空 HTML（6,316 字符），含「消耗 · 今日 / 宿主 usage / 近 7 天趋势」，重复渲染结果确定；
- **B. 完整 mock**（字段严格按 `p3-cost.js summarize()` 输出：13 环节、7 天趋势、10 个 Top 会话、T1/T4/T5/T6 触发、checkpointWrite 失败+重试、`avgDurMs:null`、`since` 有效）→ 非空 HTML（11,786 字符），断言命中所有区块标题/关键数值（`6.9万`、`994万`、`T1 阈值`、`记账起点`），趋势 7 根日期柱（14 个柱状元素），分环节+Top 会话行数 ≥10，无降级文案；
- **C. 降级边界**：`null / undefined / {} / [] / "oops" / 0 / false / {foo:1} / {today:null} / [1,2,3]` 共 10 种输入 → 全部**不抛异常**且显示「暂无消耗数据」；4 组脏类型（`Infinity`/`NaN`/错误类型/`byKind` 为数组等）→ 不抛异常且仍产出合法卡片；
- **D. 转义**：会话 id 注入 `<img onerror>` / `<script>` → 输出中无原样标签，已转义为 `&lt;img`；
- 汇总：**ALL RENDER TESTS PASSED**（exit 0）。

### ③ 真实浏览器：headless Chrome + CDP 打开 `GET /dsh-memory/stats`
- `/dsh-memory/stats` 返回 200 / 115,751 B，已含 `cost-panel-style`、`cost-panel-script`（**未重启 DSH**，插件每请求实时读覆盖文件）；
- 页面内实测：`#cost-block` 存在，4 张卡片（today/trend/kinds/top）齐全、无 `#cost-degraded`、5 张 KPI、14 根趋势柱、分环节+Top 表格行数=5；
- 实测文案：「5046.1万 真实 tokens · 今日 · 217 轮 / 2,558 估算 tokens / 3 检查点触发 / 0 失败 / 1 环节记账」；
- **JS/console errors = 0**；既有区块（近 30 天事件量 / 高频领域 TOP7 / 工具调用 TOP10 / 实时日志）全部照常渲染；
- 汇总：**BROWSER CHECK PASSED**（exit 0）。

### ④ 结构自检（附加）
`extract.mjs`：4 个新标记各唯一；剥离新增块后与备份逐字节一致；既有 18 id / 20 函数全保留；只读/零依赖静态扫描通过 → **ALL EXTRACT CHECKS PASSED**。

## 六、用户看到的效果

打开/刷新 `http://127.0.0.1:49396/dsh-memory/stats`，在原有面板最下方多出「消耗」区：

1. **今日卡片**：一排 5 个指标——真实 tokens（悬停看输入/输出/cache 读/写/轮次）、估算 tokens（悬停看检查点/注入/dream 分项与字符估算口径）、检查点触发次数（悬停看 T1–T6 明细）、失败数（悬停看环节与重试/超时）、环节记账次数；下面一行是累计真实/估算 tokens、累计失败、累计轮次与记账起点。
2. **近 7 天趋势**：7 组蓝/橙双柱（估算 tokens / 触发次数，各自标尺），悬停任意一天看当日估算、触发、记账次数与真实 tokens。
3. **分环节消耗表**：13 个环节按固定顺序，展示次数、输入/注入字符、输出字符、真实 tokens 入/出、估算 tokens、均时长、失败（失败红字，无失败但有重试会显示「重试 n」）；整行悬停看该环节全部非零字段。
4. **Top 会话**：按检查点写入估算 tokens 排序的前 10 个会话，显示写入次数、字符量、估算 tokens、均时长、失败。

所有区块只读；`cost` 数据还没产生时，对应卡片显示「暂无」而不是报错；即使 `stats.json` 完全没下发 `cost` 段，也只显示一张「暂无消耗数据」的降级卡片，原有面板所有功能与区块照常工作。

## 七、已知限制 / 备注

- 每次首屏与点「刷新」会多一次同源只读 `GET /dsh-memory/stats.json`（面板本身已有同类请求，量级相同，无写入副作用；>800ms 节流避免连点重复请求）。
- `since=0`（记账起点尚未写入）时显示「累计（记账起点未记录）」，不做时间猜测。
- 趋势图两条序列单位不同（估算 tokens vs 次数），故各自独立标尺；精确值都在悬停 tooltip 与「今日」卡片里，避免视觉误读。
- 分环节表里 `hostUsage` 行的「次数」列显示的是轮次（`turns`），其余环节为记账次数（`n`），行 tooltip 与表下注释已写明。
- 本次未改 `index.js`、未改其他插件文件；`_verify` 下仅新增本报告，node 临时验证脚本放在系统临时目录（`%TEMP%\dsh-cost-verify\`），未污染仓库。
