# CRA · 会话标题栏「记忆状态指示器」设计评审（含 per-session 修订）

- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（client 工作副本 `client/lib/client.js` 38,310B / sha8 **6DBCA193**，与已安装副本 `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js` 同 sha；index.js 侧 webServer 路由块）。
- 需求原话（逐字）：「因为其实很多用户是不会打开记忆面板看那么详细的数据的，并且对于正常使用来说也不用看那么详细的数据，所以我觉得倒是可以将对用户最有用的信息在我说的位置展示，包括压缩等待也可以移动」
- 补发口径（逐字）：「而且这个位置不就是天然的每个会话独立的吗」⇒ **指示器必须 per-session**；全局汇总留在面板，不进标题栏。
- 只读：未改代码、未构建、未部署、未写数据库。按 CRA 模板：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最小 diff + 浮层去留）。

---

## 0. 结论（先给判断）

1. **`conversation.session.header.actions` 确实可注入，且组件能拿到 `sessionId`**。DSH 插件 API 契约（asar `@deepseek-ai/dsh-cordis-client-runner/lib/client.js#4230-4290`）明确：该 slot `kind:"list"`、`scope:"session"`、`replaceRisk:"none"`、`registerOptions` 要求唯一 `id`；`standardProps` 含 `sessionId: SessionId`（`#4273`）。宿主渲染点 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js#20895` 的 `renderSlot("conversation.session.header.actions", {})` 位于每个会话的 header 内；已有多款官方插件注入（`agent-preset`/`job-list`/`subagent-catalog`/`agent-team`，契约 `#4282-4286`），且它们的组件直接解构 `sessionId`（`ui-agent-preset#1585`、`ui-jobs#323`）。**不是白名单，是通用 slots 服务**；插件 `client/package.json#16-25` 已 inject `@deepseek-ai/dsh-client-ui-slots`，`client.js#56` 已 `inject=["slots","configForms"]`。
2. **推荐形态：单枚「状态胶囊」，仅在非正常态出现**：压缩等待 `● 12s`（蓝，秒数）；本会话未提炼 `● 30`（黄，句数）；正常隐藏。用原生 `title` 做 hover（slot 契约明确 actions 溢出会被裁剪/淡出、自定义浮层必须 portal，原生 title 不需要）。不显示全局汇总、不显示全局自检红灯（无现成 per-session/自检 HTTP 数据源）。
3. **per-session 未提炼：选 B（端点加 `?sid=`）**。现有 `/dsh-memory/note-stat.json` 返回的是**全局计数且不返回 `items[]`**（`index.js#12633` 只回 `topics/sentences`），所以 lead 的 A「前端拿全局 items 过滤」**当前根本做不到**；即使补 items，`noteUnrefinedStats` 还会 `items.slice(0,20)`（`#3962`），会话多时会漏。B 后端按 `sid8` 过滤，实测单会话查询 ~24-30ms、响应 ~100B，准确且无 top-20 问题。
4. **浮层去留**：退役 **dsh-memory 自己的 DOM HUD**（`client.js#429-476`，全局 2s 轮询 `/dsh-memory/wait.json`，`#472` setInterval 无清理）；**保留** 独立的 `wait-float` 原生悬浮窗插件（`~/.dsh/profiles/web/plugins/wait-float/index.js#1-12`，是通用「等待选择/审批/后台任务」悬浮窗，`wait_float_open` 是它的工具；它不消费 dsh-memory 的 wait.json，见其仅有一处注释提到 dsh-memory `#253`）。不要顺手退役它——那不是本插件的浮层。
5. **最小 diff**：`index.js` 给 note-stat 加 `?sid=`（~10 行）；`client/lib/client.js` 加 `HeaderMemoryIndicator` 组件 + 一处 `ctx.slots.inject("conversation.session.header.actions", ...)`，并删掉 `mountWaitHud()` 调用（1 行，函数可留可删）。**无需重建 client bundle**（手写 module-loader bundle，`client.js#2-4`）；需 `node tools/sync-payload.mjs` 重生成 manifest/payload，复制到 `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js` 与 `.../memory/index.js`，重启 DSH。

---

## 1. 表 1 · 调用链：slot 是否可注入、session 上下文从哪来

| 环节 | 证据 | 结论 |
|---|---|---|
| slot 声明 | asar `@deepseek-ai/dsh-cordis-client-runner/lib/client.js#4230-4290`：`key:"conversation.session.header.actions"`, `kind:"list"`, `scope:"session"`, `registerOptions:[id(required),order,label]`, `ownerProps: children?: never`, `standardProps` 含 `sessionId: SessionId`（`#4273`）, `replaceRisk:"none"`, `declaredBy: "an entry in 'conversation.session.header' ..."` | 存在、可注册；`id` 必须唯一；不重名就是新增一格，不会替换 shipped 项 |
| 宿主渲染 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js#20893-20896`：`<div className=headerActions>{renderSlot("conversation.session.header.actions", {})}</div>`；位于每会话 header 内 | 每个会话独立渲染；slot `scope:session` 由 owner 绑定当前 session |
| sessionId | 契约 `#4273`；已注入的 `AgentPresetLabel({sessionId,...})`（`ui-agent-preset#1585`）和 `JobListAction({sessionId,...})`（`ui-jobs#323`）直接使用 | **组件 props 直接有 `sessionId`**；无需从 URL/路由猜 |
| 插件侧能力 | `client/package.json#16-25` dsh.client.inject 含 `@deepseek-ai/dsh-client-ui-slots`；`client.js#56` `inject=["slots","configForms"]`；现有 `ctx.slots.inject("settings.general.item", ...)` `client.js#571-577` | 同一 `ctx.slots` 服务；加第二个 `inject` 即可 |
| 官方先例 | 契约 `#4282-4286` occupants：`agent-preset`、`job-list`、`subagent-catalog`、`agent-team`；`ui-agent-preset#3033` 的 `scope.slots.register({name:"conversation.session.header.actions", id:"agent-preset", order:-10,...}, AgentPresetLabel)` | 非白名单；官方插件就是这么注入的 |
| 可验证方式 | ① 契约文件即 DSH 插件 API 的 slot 清单（source `packages/client/ui-conversation/src/client/contract/slots.ts:247`）；② 运行时临时注册 `id:"dsh-memory-probe"` 的组件（`<span data-dsh-memory-probe>`），打开一个会话看 header DOM；③ 在 `ctx.slots.inject` 回调里 `console.log` 是否触发（owner 挂载后触发） | 三者任一可证；契约 `replaceRisk:"none"` 表示不会 shadow shipped UI |

**结论**：可以注入；`actions` 是标题右侧动作区、list 类型、溢出会被裁剪/淡出（契约 `#4233`），所以指示器必须极小，hover 用原生 `title`（自定义 popover 必须 portal，不建议为这枚小点引入）。

---

## 2. 表 2 · 状态与数据源（per-session 修订后）

### 2.1 压缩等待（per-session，已有 sid）

| 字段/语义 | 证据 | 用法 |
|---|---|---|
| `R2_WAIT_STATE` 全局单对象 `{active,phase,sid,since,deadlineAt,maxMs,result,doneAt,updatedAt}` | `index.js#15677` | 全局只有一个等待状态；per-session 指示器必须用 `sid` 过滤 |
| `active=true` 的区间 | `#18019-18023`：进入「等检查点」时打亮；`#18031-18035` finally 收灯，`phase="rehydrate"`、`result=ok/timeout`、`doneAt` | **`active` 只代表「正在等 writer 检查点」，不代表整个压缩/重灌完成**；收灯后重灌构建仍在 setTimeout 里（`#18000-18038`） |
| HTTP 端点 | `index.js#12645-12670` `/dsh-memory/wait.json`：返回上述字段 + `now/elapsedMs/remainingMs`；`sid8` 是 8 位 | 现有浮层每 2s 轮询（`client.js#431/#466/#472`） |
| per-session 过滤 | `sid8 = sessionId.replace(/^session-/,"").slice(0,8)`（与 `R2_WAIT_STATE.sid` 同口径，`#18020`）；`wait.json.sid8` 对比当前会话 sid8 | `active && sid8===当前sid8` 才显示；否则隐藏（别的会话在压缩时不串） |
| 完成态 | `!active && result && doneAt` 最近 2.5s（现有 HUD 的 completion 逻辑 `client.js#445-450`） | 可选：短暂显示「✓」/「超时降级」，随后隐藏；不建议常驻 |

### 2.2 本会话未提炼（per-session，需要后端 B）

| 项 | 证据 | 结论 |
|---|---|---|
| 现有端点 | `index.js#12620-12638`：`GET /dsh-memory/note-stat.json` 返回 `{ok,disabled,ready,topics,sentences}`；**没有 items** | 全局计数，不能前端按 sid 过滤 |
| 全局统计实现 | `noteUnrefinedStats`（`index.js#3944-3965`）：遍历笔记主题、`noteUnrefinedCount`（`#3933-3941`，最后一条指针之后句数），items 排序后 `slice(0,20)`（`#3962`） | 即使端点补 items，top-20 也会漏会话 |
| 笔记主题命名 | `memory_note` 落点 `笔记·<wsKey>/<sid8>`（`index.js#18746`；命名注释 `#18687`）；`sid8Of` 在 `p25-topics.js#260-269`（UUID 前 8 位 / 8 位 hex） | B 方案可按 `name.endsWith("/"+sid8)` 精确过滤 |
| flag 关/未就绪 | `index.js#12626-12628`：返回 `{ok:true,disabled:true,ready:false,topics:0,sentences:0}`；异常 500 `{ok:false}` | 前端 `disabled/ready` 守卫，静默隐藏；不要显示 0 误导 |
| 实测 | 本机 Host `:56035`：全局 `/dsh-memory/note-stat.json` = 6 主题/47 句、67B/30ms；带 `?sid=...` 当前被忽略，仍返回全局 6/47 | **B 必须改 handler**；改后单会话查询 ~24-30ms（listTopics 2.8ms + 1 个 readTopic） |
| 单会话数据验证 | 真库副本：`笔记·E-工具-徕卡一瞬/1b736c53` 31 句、未提炼 **30** 句；其他会话 0-7 句 | per-session 数字是真实可算的；lead 例子 13 只是示例值 |

### 2.3 状态优先级与全局汇总

- **等待（且 sid 匹配）> 本会话积压（≥阈值）> 正常（隐藏）**。
- 全局汇总（6 主题/47 句）**留在面板/设置页**，不进标题栏（用户补发明确）。
- 「异常/自检 FAIL」**不建议进标题栏**：`runSelfCheck` 存在但只有升级提醒/`memory_onboard action=selfcheck` 通道（`index.js#19349`），**没有** `/dsh-memory/selfcheck.json` HTTP 路由（全仓 selfcheck 无 `wsrv.register`）；标题栏拿不到 per-session 自检结果。若一定要红灯，需要新增「最近一次自检结果」缓存端点，属于新数据源，超出「不新增端点」的设计。

---

## 3. 表 3 · 边界

| 边界 | 行为 | 兜底 |
|---|---|---|
| ① 从未压缩过 | `wait.json.active=false`；不显示等待 | 隐藏等待；只看 backlog |
| ② 压缩等待超时降级 | `active=false`、`result="timeout"`、`doneAt` 有值 | 短暂「已降级」/隐藏，不显示红色错误；不阻塞 |
| ③ 插件未加载 / 路由 404 / 桌面旧版 | `fetch` 失败或 404 | 全部静默隐藏；不显示红点/错误；不影响标题栏 |
| ④ 桌面端 vs web | 桌面 `dsh-app://app` fetch 经协议转发 Host（前 CRA 已验证；`client.js#193-196`）；`<a target="_blank">` 被 Electron `setWindowOpenHandler` 拦 | 数据两端都能取；**点击**：web 新标签打开面板；桌面显示 `/memory-panel` 指引，不导航、不劫持 |
| ⑤ 指示器显示期间切会话 | slot 是 per-session，组件 props `sessionId` 变化 | `useEffect([sessionId])` 立即清旧值并重取；旧请求用 generation/abort 丢弃；wait 响应再按 sid8 校验；不会串 |
| ⑥ 无笔记主题（新会话/子代理/纯问答） | `note-stat?sid=` 返回 0/无主题 | backlog 隐藏；若该会话正在压缩，wait 仍可显示（等待与笔记无关） |
| ⑦ 多标签页 | 每个 tab 独立组件/定时器；后端 stateless | 各自轮询；无共享状态；可加 `visibilitychange` 暂停隐藏页 |
| ⑧ 多会话同时压缩 | `R2_WAIT_STATE` 全局只有一个；`sid` 是最后打亮的 | 当前会话若不在最新 state，可能看不到自己的等待（已知限制）；不要用全局状态冒充 per-session |
| ⑨ 自检 FAIL | 无 HTTP 数据源 | 不进标题栏；留在面板/设置/升级提醒 |

---

## 4. 八项逐条回答

1. **调用链**：见 §1。`ctx.slots.inject` 是通用 slots 服务（非白名单）；`conversation.session.header.actions` 由 `conversation.session.header` owner 声明（契约 `#4281`），每个会话 header 内 `renderSlot`（`ui-conversation#20895`）；`standardProps` 含 `sessionId`（`#4273`），官方组件直接解构（`ui-agent-preset#1585`、`ui-jobs#323`）。可验证：契约文件、临时 probe id、运行时 DOM。
2. **状态交互**：现有 `mountWaitHud` 全局每 2s 轮询 `wait.json`（`client.js#432-472`）；若同时加 header 指示器会**重复请求**。建议退役 HUD（删 `mountWaitHud()` 调用 `#479`），header 成为唯一轮询方；`note-stat` 目前设置页只在挂载时 fetch（`client.js#62-80`），header 需新增按会话轮询。页面切换/会话切换：slot 组件随 header 挂载/卸载，`useEffect` 清理 interval/abort。
3. **线程与锁**：前端 `setInterval` 必须在 `useEffect` cleanup 中 `clearInterval`；用 `AbortController` 取消在途 fetch；`alive/generation` 防旧会话响应写新状态；多标签页各自独立；`document.visibilityState==="hidden"` 时暂停（恢复立即 tick）。现有 HUD 的 `setInterval` 没有清理（`#472`），退役后自然消失。
4. **正确性**：`wait.active` 只表示「等检查点」而非「整个重灌完成」（`#18019-18035`）；`note-stat` flag 关/未就绪返回 `disabled:true/ready:false` 零值（`#12626-12628`），前端必须按 `ok/disabled/ready` 守卫；优先级等待 > 积压 > 正常；自检 FAIL 无 per-session 数据源，不显示。全局 `note-stat` 不能当 per-session；B 方案按 `sid8` 过滤。
5. **边界**：见 §3（①-⑨）。
6. **方案对比**：
   - ① **圆点 + tooltip**：占位最小，但等待秒数/积压句数只能 hover 看；用户「一眼」价值弱。
   - ② **胶囊文字**（推荐）：等待 `● 12s`、积压 `● 30`；宽度约 40-60px；信息密度最好；仍远小于文字块。
   - ③ **只做等待态**：最省空间，但用户明确要「最有用的信息」包括待提炼；放弃 backlog 可惜。
   - ④ **保留浮层 + 只加全局未提炼**：全局、重复、且用户要「搬」不要「加」；不推荐。
   - **推荐 ②**，正常态隐藏；`title` 给完整解释；`order` 放在 shipped actions 之后（如 20/50），不抢标题。
7. **护栏**：轮询间隔下限（wait 2s 仅在 header 挂载且页面可见；note 15s）；卸载/切会话清理；失败静默隐藏；不阻塞渲染（纯异步，初始不显示）；点击不劫持（web 新标签；桌面仅提示）；不自定义 portal 浮层（用 `title`）；不显示全局汇总；`id` 唯一；`order` 小；`aria-label`/`title` 可访问；多标签页独立。
8. **影响面**：
   - 标题栏空间：`actions` 是独立 flex 区，溢出会裁剪/淡出（契约 `#4233`）；胶囊小，`order` 放后面；不会挤标题（标题在另一容器），也不会挤 shipped chip 到不可用（可能被裁剪，需实测窄窗）。
   - 请求频率：header 每个打开会话 1 个 wait 轮询/2s + note/15s；HUD 退役后总请求不增（原 HUD 全局 2s 被替换）；`wait.json` 169B、`note-stat` ~100B，后端极轻。
   - 前缀缓存：**UI 不进上下文，零影响**；不改 AGENTS.md/工具 schema/稳定层；只是 React 渲染与只读 GET。
   - 现有浮层用户：dsh-memory DOM HUD 消失（等待信息移到标题栏，符合「搬」）；独立 wait-float 原生窗不动（通用等待，不显示 dsh-memory 压缩等待）；若用户依赖 HUD 的完成 toast，可让胶囊短暂显示完成态 2.5s。

---

## 5. 特别回答

### 5.1 slot 能不能注入？退路？

- **能**：契约 `#4230-4290`、官方 occupants、`replaceRisk:"none"`、`ctx.slots.inject` 示例；组件 `sessionId` 来自 `standardProps`（`#4273`）。
- 退路：`conversation.session.header.corner`（single，`#4293-4300`，far-right 单控件，同样 session scope，适合一枚状态点）；`conversation.session.header.utilities`（session log 下载所在，`#20898`）也可，但 utilities 更偏工具；`actions` 是首选。
- 不建议 `conversation.session.header`（single，`replaceRisk:"shadows-shipped-ui"`，会替换整个标题/动作，风险大）。

### 5.2 浮层去留

- **dsh-memory DOM HUD（`client.js#429-476`）退役**：它是压缩等待专用，全局 2s 轮询、无 cleanup；标题栏 per-session 胶囊替代；删 `mountWaitHud()` 调用（`#479`）即可，函数可留可删。
- **独立 `wait-float` 原生悬浮窗保留**：它属于 `wait-float` 插件（profile patch `desktop/cordis.patch.yml#196-208`），显示通用「等待选择/审批/后台任务」，`wait_float_open` 是它的工具（`wait-float/index.js#284`），不消费 `/dsh-memory/wait.json`（全文件仅一处注释提到 dsh-memory `#253`）。它不是本插件的压缩浮层，不应随本需求退役。
- 权衡：原生 wait-float 在窗口失焦/最小化时仍可见，但它显示的是**通用等待**，不是 dsh-memory 的压缩等待；标题栏胶囊在窗口失焦时仍可见（只要窗口未最小化），最小化时两者都不显示。若用户要「压缩等待在最小化时也可见」，需要把 R2 状态接到原生 wait-float（跨插件），不是本次标题栏方案的范围。

### 5.3 最小 diff

1. `index.js`（webServer 的 note-stat route `#12620-12638`）：
   - 解析 `req.url` 的 `sid`；`sid8 = p25Topics.sid8Of(sid)`（`p25-topics.js#260-269`）；
   - `rows.filter(t => /^笔记·/.test(t.name) && String(t.name).endsWith("/"+sid8))`；`noteUnrefinedStats(store, filtered)`；
   - 返回 `{ok,disabled:false,ready:true,topics,sentences,sid8}`；无 sid 时保持原全局返回（设置页不变）；flag 关/未就绪仍 `disabled:true`。
   - 约 10-15 行；无新端点。
2. `client/lib/client.js`：
   - 新增 `HeaderMemoryIndicator({ sessionId })`（约 70-90 行）：`useEffect([sessionId])` 立即 `tickWait/tickNote`；wait interval 2s、note interval 15s；`AbortController`/`alive`；wait 仅当 `active && sid8===当前`；note 用 `?sid=` 且 `disabled/ready` 守卫；`count>=阈值`（建议 10；可先 1）才显示 backlog；`title` 文案；点击 web `window.open("/dsh-memory/stats","_blank","noopener")`，桌面 `location.protocol==="dsh-app:"` 时只显示 `/memory-panel` 指引、不导航。
   - 在 `client.js#571` 之后加：
     ```js
     ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
       name: "conversation.session.header.actions",
       id: "dsh-memory-status",
       order: 20,
       label: "记忆状态",
     }, HeaderMemoryIndicator));
     ```
   - 删除 `mountWaitHud();`（`#479`）；`mountWaitHud` 函数可删除（~47 行）或留作未用。
3. 不改 `client/package.json`（`@deepseek-ai/dsh-client-ui-slots` 已 inject）；不改 settings `NoteStatRow`（全局汇总留在设置页）。
4. **无需构建**：client.js 是手写 module-loader bundle（`#2-4`）；但需 `node tools/sync-payload.mjs` 重生成 `install-manifest.json`/payload；复制 `client/lib/client.js` → `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js`，`index.js` → `~/.dsh/profiles/web/plugins/memory/index.js`；重启 DSH（Host 启动时扫描 client bundle/算 revision）。
5. 可选：版本 bump；`/dsh-memory/stats` 面板路由已存在（`index.js#12682`），无需新增。

---

## 6. 补发 · per-session 修订（新增 4 问）

### 6.1 slot 上下文是否带 session id？

- **带**：`conversation.session.header.actions` 的 `scope:"session"`，契约 `standardProps` 明确 `sessionId: SessionId`（asar `dsh-cordis-client-runner/lib/client.js#4273`）；已注入的 `AgentPresetLabel({ sessionId, ... })`（`ui-agent-preset#1585`）与 `JobListAction({ sessionId, ... })`（`ui-jobs#323`）直接使用。
- 运行时探测：临时注册 `id:"dsh-memory-probe"` 的组件，渲染 `<span data-dsh-memory-probe data-sid={sessionId}>`；在会话 header DOM 看 `data-sid`；或 `ctx.slots.inject` 回调里 `console.log("slot injected")`。无需从 URL/路由猜。
- 若 owner 不传（极老 DSH），退路：`conversation.session.header.corner`（同样 `scope:"session"`，标准 props 同样含 sessionId，契约 `#4293-4300`）；或从 `useSession`/`useSessions` 标准 props 取；不要解析 URL。

### 6.2 per-session 未提炼怎么算？A 还是 B？

- **A（前端拿全局 items 按 sid8 过滤）当前不可行**：`/dsh-memory/note-stat.json` 根本不返回 `items`（`index.js#12633` 只回 `topics/sentences`）；即使补 items，`noteUnrefinedStats` 把 items `slice(0,20)`（`#3962`），会话多时本会话可能被截掉；且全局计数与 per-session 过滤的口径容易漂移。
- **B（`?sid=` 后端只算本会话）推荐**：handler 按 `sid8` 过滤 `be.listTopics()` 的笔记主题（`name.endsWith("/"+sid8)`），再走 `noteUnrefinedStats`（`#3944-3965`）；`sid8Of` 用现成 `p25-topics.js#260-269`；单会话 ~24-30ms、~100B，准确无 top-20 问题；设置页无 sid 时保持全局返回，零行为变化。
- 多标签/会话切换准确性：每个请求带自己的 sid；后端 stateless；响应带 `sid8`，前端丢弃不匹配响应；切换会话立即清旧值重取，不会串。
- 不推荐把全局 items 加进端点再前端过滤（多标签下响应可能对应旧会话；仍受 top-20 限制）。

### 6.3 切会话时的行为

- slot 是 per-session，组件 props `sessionId` 会随 header 切换；`useEffect([sessionId])` 里：先 `setState({wait:false,note:0})`（清旧会话残留）→ 立即 `tickWait/tickNote` → 重建 interval；旧请求用 `AbortController.abort()` + generation 丢弃；wait 响应再按 `sid8===sid8Of(sessionId)` 校验。
- 现有全局 HUD 若保留会显示上一个/别的会话的等待；**退役 HUD** 后不存在该问题。
- 多标签：每个 tab 独立组件/定时器；不共享内存；后端无状态；不会串。
- 已知限制：`R2_WAIT_STATE` 全局单对象（`index.js#15677`），若两个会话同时压缩，只有最后打亮的 sid 能被指示器看到；这是数据源限制，不要用全局状态冒充 per-session。

### 6.4 没有笔记主题的会话显示什么？

- **backlog 不显示**：新会话、子代理会话、纯问答没有 `笔记·<wsKey>/<sid8>` 主题，`?sid=` 返回 `topics:0,sentences:0`；隐藏。
- 若该会话正在压缩：wait 仍显示（等待与笔记无关）；否则整枚指示器隐藏（正常态不显示灰点，避免标题栏噪音）。
- 子代理会话若 header 可见，同样按无笔记/无等待隐藏；不要回退到全局计数。
- 建议阈值：per-session 未提炼 `sentences >= 10` 才显示黄色胶囊（少于 10 句不焦虑，避免标题栏常驻）；阈值可调，先按 10 实现。

---

## 7. 验证判据

1. **slot 注入**：打开一个会话，header 右侧出现 `[data-dsh-memory-status]`（仅非正常态）；DOM 中该元素 `data-session-id` 等于当前会话 id；切会话后属性变化。
2. **per-session 数字**：对会话 `1b736c53-...`，`/dsh-memory/note-stat.json?sid=session-1b736c53-...` 返回 `topics:1, sentences:30`（真库副本实测 30；当前全局 47）；切到无笔记会话返回 0 且隐藏。
3. **等待**：触发压缩；`wait.json.active=true && sid8===当前` 时胶囊显示 `● Ns`，2s 递增；`active=false` 后 2.5s 内隐藏/完成提示；别的会话压缩时当前会话不显示。
4. **切会话**：A 会话有 backlog，切 B（无笔记）后 <100ms 内指示器消失；再切回 A 立即显示，不显示 B 的旧值。
5. **失败**：停插件/改 404，指示器隐藏、控制台无未捕获异常；`disabled:true` 隐藏 backlog。
6. **无重复请求**：删 HUD 后，每个打开会话只有 header 的 wait 2s + note 15s 轮询；`wait.json` 请求数从「HUD 1/2s + header 1/2s」降为「header 1/2s」。
7. **点击**：web 新标签打开 `/dsh-memory/stats`（200）；桌面不导航、只显示 `/memory-panel` 指引。
8. **标题空间**：窄窗口下 shipped chip 不被挤掉/被裁剪；胶囊不超过 ~60px；`title` hover 完整。

---

## 8. 诚实缺口

1. 未改代码/未真机注入；slot 可注入性来自 DSH 插件 API 契约 + 官方 occupants + shipped 组件解构，属**高置信**，但未做运行时 probe。
2. 未实现 B 端点；单会话 30 句来自真库副本按同一指针口径重算，实际 `noteUnrefinedStats` 会复用 `readTopic`，数字应一致；建议改后以 `/note-stat.json?sid=` 实测。
3. `R2_WAIT_STATE` 全局单对象导致多会话同时压缩时的 per-session 可见性限制，未实测；需回归。
4. 桌面端点击无法自动打开系统浏览器面板（preload 未见 openExternal API；现有设置页同样只给 `/memory-panel` 指引）；若要求一键打开，需要宿主新增 API/命令，超出本次最小 diff。
5. 未验证窄窗 header actions 溢出对 shipped chip 的实际裁剪；契约说会裁剪/淡出，需真机看。
6. 「异常/自检 FAIL」没有 per-session HTTP 数据源，已从标题栏方案移除；若产品坚持要红灯，需要新增缓存端点，另做设计。
7. 浮层去留：只退役 dsh-memory DOM HUD；独立 wait-float 原生窗不在本仓，未改；若用户指的是它，需要另开任务。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
