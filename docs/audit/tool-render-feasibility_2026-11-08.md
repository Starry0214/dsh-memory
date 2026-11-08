# 记忆类工具「语义化提示 + 3 秒自动消失」可行性审计

- 日期：2026-11-08
- 类型：**只读调研**（未改任何宿主/插件代码、未构建、未部署）
- 宿主：`C:\Users\Starry\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，其 `dsh/package.json` = **`@deepseek-ai/dsh-desktop-runtime` 0.2.2-rc.1**（注意：与 npm CLI 装的 0.2.1-rc.5 不是同一版本，本文一律以 **asar 0.2.2-rc.1** 为准）
- 取证方式：用全局已装的 `@electron/asar@4.2.0` 把相关包解到临时目录后逐行读（`asar.listPackage` / `asar.extractFile`），**未修改 asar**。
  - 解包路径：`%TEMP%\dsh-asar-x\`
  - 引用格式：`asar:dsh/node_modules/@deepseek-ai/<包>/lib/<文件>#L<行>`
  - 前端打包产物是**压缩成一行**的，故用字节偏移标注：`index-BgUyXZcc.js@<offset>`
- 需求（修正版）：记忆类工具（`memory_search` / `memory_read` / `memory_note` / `memory_topics` / `session_search`）**操作完成后**弹一条**语义化中文提示**（如 `已查询记忆 · 命中 3 处`），**3 秒后自动消失**，**工具原始输出照常保留**，**纯 UI 层零上下文成本**；并且要**防抖合并**（2s 窗口按「工具名+成败」合并计数、同时只显示 1 条、队列上限 3、失败永不合并永不丢弃）。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 能不能做到「语义化提示 + 3 秒自动消失 + 零上下文成本」？ | **能**，而且 DSH 自带恰好语义的 `Toast` 原语（默认 hold 3s + 1s 淡出）。 |
| 走 `output.render` 行不行？ | **不行，方向要改**。`output.render` 返回的是**工具结果内容块**，即**模型看得见的那份文本**；改它 = 改模型上下文（有 token 成本、会让工具结果失去原文、并使后续前缀缓存失效）。 |
| 那 UI 提示该挂哪？ | `@deepseek-ai/dsh-client-ui-primitives` 的 **`Toast`** + **`shell.overlay`** slot（frame-wide 浮层，不随 Chat 面板消失）。插件 client 半区**已经声明**了 primitives 依赖，可直接 `require`。 |
| 能不能改工具调用行的显示名？ | 宿主工具定义**没有** `title`/`displayName` 字段；显示名要么是通用 `工具调用 · <toolName>`，要么由 **`tool.call.toolview` keyed slot 整体替换该行**（需要自己重画行）。 |
| 数据从 host 到 client 怎么走？ | 推荐 host 记「最近记忆操作」环形缓冲 + 一个 ~100B 轮询端点（复用现有 `wsrv.register` 模式），client 侧做合并/队列/Toast。 |
| 要不要重建 client bundle？ | **不要**。插件 client 半区是直接分发的 `lib/client.js`（`window.__ModuleLoader__.load` 自注册），改完刷新页面即可；无需 `pnpm build`。 |

---

## 1. Q1：`output.render` 到底控制什么

### 1.1 契约与调用点

- 工具定义**强制**要求 `output { schema, render, presentationMeta? }`：
  `asar:dsh-tools/lib/index.js#L436`
  ```js
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  ```
- `render` 的**唯一调用点**在成功结果的物化阶段：
  `asar:dsh-tools/lib/pipeline.js#L709-721`
  ```js
  709: 	/** Snapshot, validate, render, and optionally project one successful body value. */
  710: 	createSuccessResult(exec, tool, candidate) {
  711: 		const detached = snapshotToolValue(tool.name, candidate);
  712: 		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
  713: 		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
  714: 		const value = deepFreeze(detached);
  715: 		let rendered;
  716: 		try {
  717: 			rendered = tool.output.render(exec.arguments, value);
  718: 		} catch (error) {
  719: 			throw projectionError(tool.name, "render", error);
  720: 		}
  721: 		const content = snapshotProjection(tool.name, "render", rendered);
  ```
- **参数**：`render(exec.arguments, value)`
  - 第 1 参 = **工具调用参数**（不是含耗时/时机的运行上下文对象）
  - 第 2 参 = `execute()` 的返回值（已按 `output.schema` 校验并深冻结）
- **返回值**：成为该次调用的 `content`，随后写入 `tool/result` 事件的 `message`：
  `asar:dsh-tools/lib/pipeline.js#L196-212`
  ```js
  199: agent.session.append("tool/result", {
  200: 	turn, step,
  202: 	message: createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError }),
  207: 	...result.error?.info ? { error: result.error.info } : {},
  208: 	...result.meta !== void 0 ? { meta: result.meta } : {}
  ```
  → 而模型历史由 `tool/result.message` 派生 ⇒ **`render` 的产物就是模型看到的内容**。
  官方 README 也逐字这么写：`asar:dsh-tools/README.zh.md#L36`
  > 规范值属于执行过程；Session 记录**渲染后的内容**及可选展示元数据。

- `render` 抛错 ⇒ 整次调用变成 `output.render failed: ...` 的失败结果（`#L718-720`、`projectionError` `#L782-784`）。

### 1.2 返回的块类型：只有 ContentBlock，没有「自定义组件」

`ContentBlockMap` 全量（`asar:dsh-llm/lib/typert.host.js#L319-325`）：

```
text | reasoning | image | file | tool-call | tool-addition | tool-removal
```

**没有任何「自定义组件 / 状态 / 组件描述符」类型**。想塞自定义 UI 结构，只能：
- 塞进 `text` → 但这段文本**会进模型上下文**（正是要避免的）；
- 或塞别的 type → 模型适配器/客户端按各自规则处理，未知块在失败消息里退化为 `[<type> content]`（`asar:dsh-tools/lib/pipeline.js#L824-828`）。

### 1.3 Web UI 不消费 `render` 的「展示意图」通道

- `presentCall()` / `presentResult()` 只给 Host 本地消费方，**内置 Web Client 不消费**：
  `asar:dsh-tools/README.zh.md#L98`
- Web Client 的卡片是**另一套**：按 `tool.call.toolview` 选 renderer，从「原始调用参数 + 结果内容 + 失败状态 + 持久 metadata」派生 props（同上）。
- `presentationMeta(args, value)` 的产物存进 `tool/result.data.meta`（`pipeline.js#L723-731`、`#L208`），**不进入 message ⇒ 模型看不见**，客户端可读（见 §4.2）。这是 host 侧唯一「零上下文」的展示通道。

### 1.4 对既定方向的纠正

> 「走 `output.render`（纯 UI 层，零上下文成本）」

**这条前提不成立**。`render` 是**上下文层**：
1. 它产出模型可见文本 → 改成 `已查询记忆 · 命中 3 处` 会让模型**看不到检索结果原文**，工具语义直接坏掉；
2. 即使只「追加」提示，也会增加每次请求的 token，并让 `tool/result` 内容变化 → 从该事件起的**前缀缓存失效**（DSH 的前缀缓存纪律见 `AGENTS.md`「缓存纪律」）。
3. 正确做法：`render` **保持原样**（返回 `String(v)`），另走 §2 的 UI 层。

---

## 2. Q2：DSH 有没有 toast / 通知 / 浮层 API？——有，而且现成

### 2.1 `Toast` 原语（`@deepseek-ai/dsh-client-ui-primitives`）

**(a) 它确实对插件 client 可用。** 平台共享模块表（外壳冻结的 seed 表）逐字包含它：

`asar:.../dsh-web-frontend/dist/assets/index-BgUyXZcc.js@947069`
```js
function YZ(){return{react:fk,"react/jsx-runtime":gk,"react-dom":xk,"react-dom/client":Ck,
"@deepseek-ai/cordis":Rb,zod:JS,"@tanstack/react-virtual":rI,
"@deepseek-ai/dsh-client-store":SI,"@deepseek-ai/dsh-client-ui-slots":MI,
"@deepseek-ai/dsh-client-ui-primitives":FU,"@deepseek-ai/dsh-client-ui-dockkit":WZ}}
```
模块解析顺序是「平台 seed 表 → 已记忆 → 启动图 row → 已注册 factory」（`asar:dsh-client-modules/README.zh.md#L78`），所以 client bundle 里 `require("@deepseek-ai/dsh-client-ui-primitives")` **一定能解析**。
本插件的 `client/package.json` **已经声明**了这个依赖（`"dsh".client.inject` 里第 4 项），连 manifest 都不用改。

**(b) 导出名与实现。**
- 导出表：`index-BgUyXZcc.js@892052` → `...,Toast:sA,...`
- 实现：`index-BgUyXZcc.js@793611`
  ```js
  const iA=3e3,oA=1e3;
  function sA({text:e,icon:t,tone:r,anchor:i,holdMs:n=iA,actions:s,onDone:l}){
    const u=k.useRef(l);
    k.useLayoutEffect(()=>{u.current=l},[l]);
    k.useEffect(()=>{const g=setTimeout(()=>{u.current()},n+oA);return()=>{clearTimeout(g)}},[n]);
    ...
    Ln.createPortal(<div className={so.toast} role="alert"
        style={{...f===null?{}:{left:f},"--dsh-toast-hold":`${String(n)}ms`}}>...</div>, document.body)
  }
  ```

**(c) Props（全部）**

| prop | 类型 | 说明 |
|---|---|---|
| `text` | string | 正文（中文提示放这） |
| `icon` | ReactNode | 图标；`tone:"success"` 时自动换成对勾 |
| `tone` | `"success"` \| undefined | 成功色 |
| `anchor` | DOM 元素? | 传了就按该元素水平居中定位，否则 `left:50%` |
| `holdMs` | number | **默认 3000**；淡出动画从 `holdMs` 开始、持续 1s；`onDone` 在 `holdMs+1000` 触发 |
| `actions` | `{prefix,label,onClick}[]` | 行内按钮（容器 `pointer-events:none`，按钮自身恢复可点） |
| `onDone` | () => void | **必须由宿主卸载它**（Toast 自己不会消失，只回调） |

**(d) 计时器语义（直接回答「重渲染会不会重置」）**
- `useEffect` 依赖数组是 **`[n]`（holdMs）**，不是整个 props ⇒ **普通重渲染不会重置计时器**；
- `onDone` 存进 `useRef` 并在 layout effect 里更新 ⇒ **回调身份变化也不会重启计时器**；
- 卸载时 `clearTimeout`（return cleanup）⇒ 无泄漏；
- ⚠️ 只有 `holdMs` 变化才会重置 ⇒ 调用方**传常量**。

**(e) 视觉与位置（CSS）**
`asar:.../dsh-web-frontend/dist/assets/index-lh_YM6sT.css@43611`
```css
._toast_hr9yd_6{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;
  display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));
  padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);
  color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);
  transform:translate(-50%);
  animation:_dsh-toast-in .16s ease-out,_dsh-toast-fade 1s ease var(--dsh-toast-hold,3s) forwards}
```
- **顶部居中固定**（`top:40px`），`z-index:1100`，**portal 到 `document.body`** ⇒ 不会被 transcript 滚动容器裁剪。
- **多条 Toast 会完全重叠在同一位置** ⇒ 队列「同时只显示 1 条」不是可选项，是硬约束。
- 可见时长 = `holdMs`(3s) + 淡出 1s；若要求「整条 3 秒后消失」，传 **`holdMs={2000}`**（2s 停留 + 1s 淡出，`onDone` 恰在 3s）。

### 2.2 `shell.overlay` slot：frame-wide 浮层，正好放 Toast

`dsh-client-ui-chat` 自己的配额提示就是**标准范式**（可照抄）：

注册（`asar:dsh-client-ui-chat/lib/client.js#L15536-15559`）：
```js
ctx.slots.inject("shell.overlay", () => ctx.slots.register({
  name: "shell.overlay",
  id: "chat.quota-notice",
  locale: NS,
  children: { "shell.quota-notice": { kind: "chain", scope: "root" } },
  inject: () => ({ hooks: {...}, dismissNotice: () => {...}, keepNoticeOpen: () => {...} })
}, QuotaNoticeHost));
```
渲染 Toast（`#L13883-13887`）：
```js
fallback: jsx(_deepseek_ai_dsh_client_ui_primitives.Toast, {
  text: owner.message,
  icon: jsx(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, { size: 18 }),
  onDone: dismissNotice
})
```
说明：`shell.overlay` 是**根作用域常驻**条目，`dsh-client-ui-chat` 注释原文「outlives the Chat panel」（`#L13866-13868`）⇒ 离开聊天面板也不丢提示。

**`shell.overlay` 是「list」型 slot（可多条目并存）**——这一点已确证，不是推断：
`asar:dsh-client-ui-layout/lib/client.js#L725-728`
```js
725: 						"shell.overlay": {
726: 							kind: "list",
727: 							scope: "root"
728: 						},
```
且由外壳 `AppFrame` 统一渲染：`#L346` `const overlays = renderSlot("shell.overlay", {})`。
⇒ 插件新增一个 `shell.overlay` 条目**不会顶掉** `dsh-client-ui-chat` 的 quota-notice。

### 2.3 结论

**Q2 答案：有。** 插件 client 半区可以：
`require("@deepseek-ai/dsh-client-ui-primitives").Toast` → 在 `ctx.slots.inject("shell.overlay", …)` 注册的宿主组件里渲染 → 传 `text/holdMs/onDone`。
**3 秒自动消失 = 现成语义**（默认 3000ms 停留 + 1000ms 淡出；要精确 3s 总时长用 `holdMs:2000`）。

---

## 3. Q3：`render` 返回的组件能否自管理生命周期？

### 3.1 前提修正

`render` **不返回组件**（见 §1.2），它返回 ContentBlock 数组、且只在**执行成功结束后调用一次**（`pipeline.js#L710-721` 的 `createSuccessResult`）。所以「render 组件 3 秒后自隐藏」这个想法**在 DSH 里没有对应机制**。

### 3.2 真正能自管理的是 `tool.call.toolview` 的 React 组件

- 每个原子工具调用由 `ToolCallTree` 分发到一个 **keyed slot**：
  `asar:dsh-client-ui-tool/lib/client.js#L2009-2017`
  ```js
  2009: return jsxs("div", {
  2010:   className: ToolCallTree_module_css_default.callRow,
  2011:   "data-chat-anchor-key": `call:${callId}`,
  2012:   "data-chat-call-id": callId,
  2013:   children: [autoReviewDenied ? renderFallback(owner) : renderSlot("tool.call.toolview", owner, {
  2014:     entryKey: toolName,
  2015:     fallback: renderFallback(owner)
  2016:   }), children]
  2017: });
  ```
- 三个阶段：`preparing` / `start` / `result`（`#L1966-1978`），组件能拿到 `phase` 与对应 `block` ⇒ 可在 `result` 阶段触发副作用。
- 组件本身是普通 React 组件（`React.memo`，`#L1984`），**可以**持 state / 起 timer / 调 `useEffect`。

### 3.3 若组件「隐藏」会变成什么

- 返回 `null` 只是**没有内容**：外层 `<div class="callRow" data-chat-anchor-key="call:<id>">` 仍会渲染（`#L2009-2017`）⇒ 对话里**留一条空白行**（保留锚点/间距），**不会折叠、不会恢复默认渲染**。
- 想「隐藏后回到默认卡片」是做不到的：keyed slot 命中即**替换** generic 行（`#L106-109` 注释原文：「a keyed hit REPLACES the generic row」），fallback 只在该 key 无注册时使用。

### 3.4 重渲染/重挂载风险

- `ToolCall` 是 `React.memo`，`owner` 走 `useMemo`（`#L1985-2007`），`start→result` 会重渲染一次；**分页、虚拟滚动、历史窗口替换**都可能导致**卸载/重挂载**。
- ⇒ 在组件内 `setTimeout` 或「一挂载就弹 toast」会**重复触发**，必须按 `callId` 去重（模块级 `Set`）。
- ⇒ 也正因如此，**不推荐**用 toolview 承载 toast：transcript 行 ≠ 瞬时通知，且要自己重画整行。

### 3.5 结论

**Q3 答案：**
- `render` 不存在「组件自管理生命周期」这回事（不是组件，且只在结束后调用一次）。
- `toolview` 组件能自管理，但隐藏后**留空行**、且与虚拟滚动重挂载打架，**不适合**做「3 秒消失」。
- 「3 秒消失」**直接用 Toast 原语**（计时器已内建、不随重渲染重置、卸载自动清理），不要自己写 timer。

---

## 4. Q4：工具调用行的显示名能否自定义？

### 4.1 宿主侧：没有 `title` / `displayName` 字段

- 工具定义契约只有 `name / description / parameters / output / execute`（`asar:dsh-tools/lib/index.js#L436` 强制 `output{schema,render,presentationMeta?}`；`defineTool` 示例见 `asar:dsh-tools/README.zh.md#L45-61`）。
- `title` 在本仓库只作为 **JSON-Schema 参数注解关键词**存在（`asar:dsh-tools/lib/schema.js#L5` `ANNOTATION_KEYS = ['description','title','default','examples']`；`json-schema.js#L38` 同）——是**参数**的 title，不是工具显示名。
- ⇒ **宿主无法给工具起显示名。**

### 4.2 客户端：显示名来自两张第一方硬编码表

- 通用行文案：`工具调用 · <toolName> · <参数摘要>`
  - 官方文档：`asar:dsh-client-ui-tool/README.zh.md#L32`「通用行显示为 `工具调用 · <工具名>`」
  - 代码：`asar:dsh-client-ui-tool/lib/client.js#L338`
    ```js
    const summary = [titleKey === "tool.title.generic" ? toolName : "", base].filter(Boolean).join(" · ");
    ```
- `TOOL_TITLE_KEYS`（`#L131-181`）把 60+ 个工具名映射到本地化标题（`session_search` → `tool.title.searchSessions` 等），**但 `memory_*` 不在表里**，所以落回 `tool.title.generic`（"工具调用"）+ 工具名。
- 这两张表（`TOOL_VARIANTS` `#L111-129`、`TOOL_TITLE_KEYS` `#L131-181`）是 `dsh-client-ui-tool` **内置的第一方常量**，**没有插件注册入口**。

### 4.3 唯一可行路径：注册 `tool.call.toolview`（整体替换该行）

官方写法（`asar:dsh-client-ui-tool/README.zh.md#L38-46`）：
```
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({ name: 'tool.call.toolview', key: '<wire tool name>' }, BusinessToolRow))
```
- owner 载荷 `ToolCallOwnerProps`：`callId`、`toolName`、`phase`、`block`、`cwd`、`home`、`loadImage`、`openFile`、`inspect`（README.zh.md#L48）。
- ⚠️ 代价：**替换**通用行，需要自己重画「图标 + 标题 + 参数摘要」；不重画则工具行会变成空白（只剩 `callRow` 包装）。

### 4.4 结论

**Q4 答案：** 不能通过宿主字段改名；只能注册 `tool.call.toolview` 把该工具的整行接管（自带中文标题），成本约 40–60 行，且要自己复刻通用行外观。**若目标只是「操作完成弹提示」，不要动行标题**——行标题与 toast 是两件事，改行标题反而增加回归面。

---

## 5. 防抖 / 合并方案（用户追加需求）

### 5.1 状态放哪：**client 插件模块作用域**，不放组件内

- 本插件 client 半区是**单模块自注册**：
  `dsh-memory-plugin/client/lib/client.js#L2-9`
  ```js
  window.__ModuleLoader__.load({
    id: "dsh-memory-client",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      let react = require("react");
      let runtime_client = require("@deepseek-ai/dsh-client-store");
  ```
  所有 slot 注册/组件都在这一个 factory 闭包里（现有 header 胶囊在 `#L429-520`、`#L664/674` 注册 slot）⇒ **模块作用域天然被所有组件共享**。
- 推荐结构（全部模块级，非 React state）：
  ```js
  const opQueue = {
    cursor: 0,                 // 轮询游标（host 侧单调递增 seq）
    pending: [],               // 待显示；success 最多 3 条，failure 单独且不截断
    merge: new Map(),          // key=`${tool}|${ok}` -> { count, timer }
    current: null,             // 正在显示的那条
    toasted: new Set(),        // 已处理 op id（防重复/防重挂载重放）
  };
  ```
- 只有 **1 个消费者**（`shell.overlay` 宿主组件），**1 个生产者**（同一模块里的轮询器）⇒ 不存在「多组件共享」难题。

### 5.2 跨工具合并：**可行**，且这是唯一不吵的做法

- 合并键 `toolName + ok` 在**轮询器**里统一生成（它看到的是「最近记忆操作」列表，不区分是哪个工具组件），所以 `memory_search` 与 `memory_read` 天然进同一个队列 ⇒ `已查询记忆 ×5` 可表达。
- **反例（明确不采用）**：给每个工具各注册一个 toolview、各自在组件里弹 toast ⇒ 每个工具一套状态、无法跨工具合并、还会因虚拟滚动重挂载重复弹 ⇒ 比不提示更吵。

### 5.3 计时器与重渲染

| 计时器 | 归属 | 清理要求 |
|---|---|---|
| Toast 停留 3s + 淡出 1s | **Toast 内部**（`holdMs` 常量，依赖 `[n]`） | 卸载自动 `clearTimeout`；**不要**传变化的 `holdMs` |
| 2s 合并窗口 | **模块作用域** `setTimeout`（`merge` map 里存 handle） | 插件卸载（`ctx.effect` cleanup）时全部 `clearTimeout` |
| 队列推进（下一条） | 模块作用域，在 `onDone` 里推进 | 同上 |
| 轮询 `setInterval` | 模块作用域 | `ctx.effect` 返回 disposer 里 `clearInterval` + `AbortController.abort()`（照抄现有 header 胶囊 `#L515-520` 的清理纪律） |

- React 重渲染**不会**重置 Toast 计时器（§2.1d）；但**必须给每条 toast 一个稳定且唯一的 `key`**（如 `key={current.id}`），否则 React 复用同一实例时 `holdMs` 不变、计时器不重启，会表现为「第二条不显示」或「第一条不消失」。
- 建议 Toast 由 `shell.overlay` 宿主组件**按 `current.id` 挂载/卸载**：`onDone` → 清 `current` → 取下一条。

### 5.4 与现有 header 胶囊的关系

- 现状：胶囊在 `conversation.session.header.actions`（`client/lib/client.js#L674`），轮询 `/dsh-memory/wait.json`（2s，`#L437`、`#L483`）与 `/dsh-memory/note-stat.json`（15s，`#L438`、`#L499`），表达的是**持续状态**（`⏳ 整理中 12s` / `30 句待整理`），正常态整枚隐藏（`#L429-435`）。
- 两者语义不同、**不冲突**：
  - 胶囊 = 状态（还在等 / 有积压）
  - Toast = 单次操作回执（刚查了 / 刚写了）
- 避免互相干扰的三条纪律：
  1. **不重复表达**：胶囊正在显示的「整理中」，toast 不再弹同类；
  2. **共用一次 tick**：把 ops 拉取并进现有 2s 轮询（或独立 1s），避免两个定时器同相位闪烁；
  3. **优先级**：胶囊优先（状态是底色），toast 用 `top:40px` 的独立层，二者位置不同（胶囊在标题栏），不会视觉打架。

---

## 6. 替代落点对比（含上下文成本 / 难度 / 前缀缓存）

| # | 方案 | 上下文成本 | 前缀缓存 | 实现难度 | 说明 |
|---|---|---|---|---|---|
| **A（推荐）** | host 记「最近记忆操作」环形缓冲 → 新增 `GET /dsh-memory/ops.json?since=`（~100B）→ client 模块级队列 + `shell.overlay` + `Toast` | **0** | **无影响**（不碰任何 message） | 中（host ~30 行 + client ~150-180 行） | 不动工具行；跨工具合并天然可行；延迟 ≤ 轮询周期（1s 可接受） |
| **B** | 注册 `tool.call.toolview`（每个记忆工具），组件在 `phase==='result'` 时推入模块级队列 | **0** | 无影响 | 中高（~120 行 + 需重画行 + `callId` 去重） | 零延迟，但**替换**通用行、虚拟滚动会重挂载、需去重 |
| **C** | host 给工具加 `presentationMeta`（`{kind:'memory-op', ok, hits}`）→ client toolview 读 `block.meta` 再弹 Toast | **0**（`meta` 不进 message） | 无影响 | 中（同 B 的 toolview 成本 + 每个工具 3-5 行） | 比 B 更稳（不靠解析结果文本），但仍要 toolview |
| **D** | 注入一次性 system-reminder / 改 `output.render` 文本 | **有**（每条都进上下文） | **会失效**（从该 tool/result 起前缀变化） | 低 | **最不推荐**，违背「零上下文成本」目标 |

> 说明：A 的轮询可以并进现有 2s tick（`wait.json` 同一个 handler 里带上 `ops` 字段），此时**零新增请求**；代价是延迟最多 2s。若要更跟手，独立 1s 端点。

---

## 7. 最小可行方案

### 7.1 改动清单

**Host（`dsh-memory-plugin/index.js`）** ≈ 30–40 行
1. 模块级环形缓冲（如 `const RECENT_OPS = []; let OP_SEQ = 0;`）。
2. 在记忆工具 `execute` 的统一出口记录（或 `ctx.on("tools/result", …)` 里按 `event.data` 判断工具名）：写入 `{ seq: ++OP_SEQ, ts, tool, ok, n?, sid8 }`，容量 ~20 条。
   - 注意：`tools/result` 的 payload 是 `{turn, step, message, error?, meta?}`（`asar:dsh-tools/lib/pipeline.js#L199-208`），**不带工具名**；工具名在 `tool/call` 事件里。用「工具 execute 内记录」更直接。
3. 复用现有 `wsrv.register` 模式新增端点（照抄 `#L12712-12738` 的 `wait.json`）：
   `GET /dsh-memory/ops.json?since=<seq>` → `{ ok:true, now, ops:[...] }`。
   - 纪律沿用现有注释：纯内存读、零 IO、异常吞掉（`#L12711`）。

**Client（`dsh-memory-plugin/client/lib/client.js`）** ≈ 150–180 行
4. `require("@deepseek-ai/dsh-client-ui-primitives")` 取 `Toast`（**manifest 已声明，无需改 `package.json`**）。
5. 模块级 `opQueue`（§5.1）+ 轮询器（1s，或并进现有 2s tick）+ 合并窗口（2s，按 `tool|ok` 聚合计数）。
6. `ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name:"shell.overlay", id:"memory-op-toast" }, MemoryOpToastHost))`（照抄 `dsh-client-ui-chat/lib/client.js#L15536` 形态）。
7. `MemoryOpToastHost`：渲染 `<Toast key={current.id} text={current.text} holdMs={2000} tone={current.ok?'success':undefined} icon={...} onDone={advance} />`。
8. 文案：`已查询记忆 · 命中 N 处` / `已读取记忆 · <主题>` / `已写入笔记` / `已修改记忆`（失败：`记忆操作失败 · <tool>`，红色 tone/图标，独立队列不合并）。
9. 清理：`ctx.effect` disposer 里 `clearInterval` + `abort()` + 清所有 timer（照抄 `#L515-520`）。

### 7.2 要不要重建 client bundle？

**不要。**
- 本插件的 client 半区是**直接分发**的 `client/lib/client.js`，格式是 `window.__ModuleLoader__.load({ id, factory })`（`#L2`），宿主按文件内容/mtime 派生 revision 直接 serve（`asar:dsh-client-modules/README.zh.md#L86` 描述 revision 由 `mtimeMs/ctimeMs/size` 派生）。
- 改完**刷新页面**即可；开发期若开 HMR 会自动热替换（同 README#L47）。
- **唯一要求**：保持 `__ModuleLoader__.load` 外壳与 `factory(require)` 形态，别改成裸 ESM。

### 7.3 生效方式
- host 侧：`patchReload=live` 时改完热生效；若未开则重启 DSH。
- client 侧：刷新页面。

### 7.4 建议的实施顺序
1. 先做 host 端点 + 一个最简 Toast（不做合并）→ 验证「能弹、3 秒消失、工具输出不变」；
2. 再加 2s 合并窗口 + 队列（上限 3、失败不合并）；
3. 最后调文案与图标，并和 header 胶囊做去重。

---

## 8. 未证实 / 风险清单（诚实标注）

1. **【未证实】`Toast` 在 `shell.overlay` 宿主里的实际层级表现**：CSS 是 `position:fixed;z-index:1100`，我未在运行中的界面实测它与标题栏/侧栏/模态的层级关系（`--dsh-frame-overlay-top` 等变量在 `dsh-client-ui-layout/README.zh.md#L47` 有描述，但未验证 Toast 是否受其影响）。
2. **【已证实】** ~~`ctx.slots.register` 在 `shell.overlay` 上是否允许多个插件条目并存~~ → **允许**：`shell.overlay` 声明为 `kind:"list"`（`asar:dsh-client-ui-layout/lib/client.js#L725-728`），由 `AppFrame` 用 `renderSlot("shell.overlay", {})` 统一渲染（`#L346`），可与 `dsh-client-ui-chat` 的 quota-notice 并存。**仍建议实施时实测一次**（list 的排序/层叠顺序未验证）。
3. **【未证实】host 侧 `tools/result` 事件里能否稳定拿到工具名**：payload 本身没有 `name`（`pipeline.js#L199-208`），我建议在工具 `execute` 出口记录，但未实测 `ctx.on("tools/result")` 的实际投递点与时机。
4. **【未证实】轮询端点与桌面端（`dsh-app://`）的兼容**：现有 `note-stat.json` 注释提到桌面端 fetch 经 Electron 协议转发给已认证 Host（`client/lib/client.js#L193`），新端点沿用同一模式应当可行，但未实测。
5. **版本漂移风险**：本审计基于 **asar 0.2.2-rc.1**；npm CLI 装的是 **0.2.1-rc.5**。若两者 `Toast`/`shell.overlay` 实现有差异，以运行中的桌面端为准（建议实施时用当前页面实测一次）。
6. **未读项**：`@deepseek-ai/dsh-client-ui-slots` 与 `dsh-client-ui-primitives` **未作为独立包随 asar 分发**（只在前端 bundle 里），因此没有它们的 README/类型声明可读；`slots` 的完整 API（`subscribe`/`entries` 等）只能从各 client bundle 的调用点反推。

---

## 附：关键证据索引

| 结论 | 证据 |
|---|---|
| `render` 契约与调用点 | `asar:dsh-tools/lib/index.js#L436`、`lib/pipeline.js#L709-721` |
| `render` 产物 = 模型可见内容 | `asar:dsh-tools/lib/pipeline.js#L196-212`、`asar:dsh-tools/README.zh.md#L36` |
| 块类型封闭（无自定义组件） | `asar:dsh-llm/lib/typert.host.js#L319-325` |
| Web Client 不消费 presentCall/presentResult | `asar:dsh-tools/README.zh.md#L98` |
| `presentationMeta` → `tool/result.meta`（模型不可见） | `asar:dsh-tools/lib/pipeline.js#L723-731`、`#L208` |
| 平台模块表含 primitives | `index-BgUyXZcc.js@947069` |
| `Toast` 导出 | `index-BgUyXZcc.js@892052`（`Toast:sA`） |
| `Toast` 实现（holdMs=3000+1000、timer 依赖 `[n]`、portal body） | `index-BgUyXZcc.js@793611` |
| Toast CSS（fixed top:40px z-1100） | `index-lh_YM6sT.css@43611` |
| `shell.overlay` 注册范式 | `asar:dsh-client-ui-chat/lib/client.js#L15536-15559` |
| `shell.overlay` 是 `kind:"list"`（可多条目） | `asar:dsh-client-ui-layout/lib/client.js#L725-728`、`#L346` |
| Toast 使用范式 | `asar:dsh-client-ui-chat/lib/client.js#L13883-13887` |
| toolview 分发 + callRow 包装 | `asar:dsh-client-ui-tool/lib/client.js#L2009-2017`、`#L1984` |
| keyed 命中即替换 generic 行 | `asar:dsh-client-ui-tool/lib/client.js#L106-109` |
| 通用行文案拼接 | `asar:dsh-client-ui-tool/lib/client.js#L338`；README.zh.md#L32 |
| 标题表是第一方硬编码 | `asar:dsh-client-ui-tool/lib/client.js#L111-181` |
| toolview 注册写法 | `asar:dsh-client-ui-tool/README.zh.md#L38-48` |
| 本插件 client 单模块结构 / slots 注入 | `dsh-memory-plugin/client/lib/client.js#L2-9`、`#L56`、`#L664`、`#L674` |
| 本插件已声明 primitives | `dsh-memory-plugin/client/package.json`（`dsh.client.inject` 第 4 项） |
| 现有 header 胶囊轮询与清理纪律 | `dsh-memory-plugin/client/lib/client.js#L429-520` |
| 现有 HTTP 端点注册模式 | `dsh-memory-plugin/index.js#L12695-12738` |
| 记忆工具 `output` 定义 | `dsh-memory-plugin/index.js#L12182`（`{schema:{type:"string"}, render(_a,v){...}}`） |
