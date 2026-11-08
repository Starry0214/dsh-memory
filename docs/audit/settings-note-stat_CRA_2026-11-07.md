# CRA · 设置页加「会话笔记未提炼」一行（只读审计）

- 需求（用户原话）：「那 dsh 的 ui 设置界面能加一个吗？一个简单的信息就行」——在 **DSH 设置页**显示 4.5.2 的「会话笔记未提炼 N 个主题 / M 句」，一行即可。
- 审计对象：`E:\工具\插件开发调整\dsh-memory-plugin`（工作副本）；运行中的 DSH Desktop 0.2.2-rc.1（`dsh-app://app`，Host PID 49100 / 127.0.0.1:59562）。
- 只读：未改代码、未构建、未部署、未动数据库。本报告按 `/change-risk-audit` 模板：表1 调用链 / 表2 状态 / 表3 边界 / 结论（推荐方案 + 最小 diff + 桌面端结论）。

---

## 0. 结论（先给判断）

**桌面端能真正实现**（当前 DSH 0.2.2-rc.1）。lead 引用的「桌面端 fetch `/dsh-memory/*` 实测 400」是 **client.js#160-163 的过期结论**：0.2.2-rc.1 的 `dsh-app` 协议处理器会把**所有非 app 文档/资源路径转发给已认证 Host**（asar `lib/main.js#20617-20626`），转发器允许 `origin=null` 或 `dsh-app://app`（`#15877-15907`）；实测桌面 Host（:59562）`GET /dsh-memory/stats.json` **200**、`GET /dsh-memory/config` **200/31ms**。client 现有设置页本来就在 fetch `/dsh-memory/config`（`client.js#471-479`、`#520-523`）——若桌面 fetch 不通，配置项早就不可用了。

**推荐方案**：新增**极小只读端点** `GET /dsh-memory/note-stat.json`（host 侧用 `store.be.listTopics()` + 15 个笔记主题 `readTopic` 计算，**实测 ≈25ms**、返回 ~100B），client 加一个 `NoteStatRow`（`useEffect` 一次 fetch、3s 超时、失败/未就绪/flag 关静默隐藏），插在「记忆使用统计」行之后。

**不要**直接用 `stats.json`：实测 **1,406ms / 461KB** 一次（为一行字太重）；也不要裸用 `noteUnrefinedStats(store)`（内部 `store.topics()` 实测 **1,241ms**）。

**最小 diff**：`client/lib/client.js`（新增 ~25 行组件 + 插入 1 行 + 更新过期注释）+ `index.js`（webServer 块新增 1 条 route，~20 行）；client.js 是手写 module-loader bundle，**无需构建**；但须 `node tools/sync-payload.mjs` 重生成 `install-manifest.json`/payload，部署到 `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js` 与 `.../web/plugins/memory/index.js`（desktop/web 共用），**重启 DSH** 生效。

---

## 1. 表 1 · 调用链与语义（全仓列点）

| 环节 | 证据 | 结论/可疑点 |
|---|---|---|
| **client 半区加载** | `client/package.json#7-15` `exports["./client"] → ./lib/client.js`；`#16-26` `dsh.client`（platform=web + inject 4 个 client 包） | 设置 UI = `client/lib/client.js`（36,035B，module-loader bundle：`client.js#2-4 window.__ModuleLoader__.load({id, factory})`）；`client/lib/index.js`（255B）只是**宿主半区** `export function apply(){}`，与 UI 无关，不需改 |
| Host 侧 bundle 解析/服务 | asar `@deepseek-ai/dsh-client-modules/lib/index.js#129-135`（扫描 `dsh.client`）、`#199-209`（解析 `exports["./client"]`）、`#690-693`（读 bundle 字节）、`#187-232`（`/plugins/` 路由 + 内容 revision/immutable cache）、`#789-796`（按 package.json 定位 clientPath） | 第三方 client bundle 由 Host 读**文件字节**并挂 `/plugins/<pkg>/...`；无独立构建产物要求（本插件 client.js 是手写 bundle，直接改即可） |
| 桌面端加载路径 | Electron main asar `lib/main.js#20617-20626`：`dsh-app://app` 只本地服务 `/`、`/index.html`、`/assets/*`、favicon；**其余路径 `forwardWebRequest` 转发 Host**；`#15877-15907` 允许 origin null / `dsh-app://app` 并注入 Host cookie；`#20048-20058` scheme 权限 `supportFetchAPI/corsEnabled/standard` | 桌面 renderer 的相对 `fetch("/dsh-memory/*")` 会到 Host 插件路由 ⇒ **可 fetch**（过期注释见 §0） |
| 数据源 | `index.js#12451-12507` `/dsh-memory/stats.json`：flag 开时 `topicdb = topicDbStatsSnapshot()`（`#12487-12494`），含 `noteUnrefined`（`#9179/#9291`）；flag 关 `LIVE_STATS.topicdb=null`（`#12494`） | 数据现成，但 **stats.json 太重**（实测 1.4s/461KB），不适合设置页一行 |
| 既有 fetch 先例 | `client.js#471-479`（`fetchConfig` GET `/dsh-memory/config`，mount 时调用 `#520-523`）；`client.js#296`（CostPanel 展开时 fetch stats.json）；`index.js#7402`（stats 面板页同源 fetch） | 桌面端 fetch 的**已在生产使用的先例**；新行可复用同一通道 |
| 死通道（不可用） | `client.js#26/#47` store 有 `monitorSummary` 但**无任何渲染**；`index.js#7084/#7091-7094` 只读字段 + settings API 已删（`HOST_SETTINGS_SCOPE=null`，改走 LIVE_STATS） | 不能靠「宿主写 Config 只读字段」在桌面端显示；`monitorSummary` 是死字段 |
| 其他可达通道 | `dshDesktop` preload/`ipcMain boot` 只返回 `injections`/`streamBaseUrl`（asar `lib/main.js#20635-20642`），无统计；`configForms` 只给配置快照；`/dsh-memory/config` GET 返回 `{ok,cfg,...}`（`index.js#12637-12649`） | 服务端数据只有 fetch 一条实际通道；config GET 可扩展（见 §6 备选 C），但需改配置路由 |

**反直觉用法检查**：`client/lib/index.js` 是宿主半区，不是 UI（改它无效）；client.js 里 `inject = ["slots","configForms"]`（`#56`）只用于配置项，不提供统计数据；设置行组件注册在 `ctx.slots.inject("settings.general.item", ...)`（`#536-542`）。

---

## 2. 表 2 · 状态 / 生命周期 / 竞态

| 场景 | 证据/结论 | 风险/护栏 |
|---|---|---|
| 设置页每次打开是否重新挂载 | DSH settings-general 的 `GeneralSection` 在渲染通用页时 `renderSlot("settings.general.item")`（asar `dsh-client-ui-settings-general/lib/client.js#639-643`）；插件行即 slot item | 组件随通用页挂载/卸载；**用 `useEffect([])` 每挂载一次**；不要渲染期 fetch |
| fetch 放哪 | 现有 `injected()` 在 slot 注入时执行（`client.js#520-523`），已 fetch config；新组件可在 `useEffect` 内 fetch，或复用 config GET（备选 C） | 用局部 `useState` + `useEffect`；`[]` 依赖；`alive` 标记防卸载后 setState |
| 每次重渲染会不会重复请求 | 渲染期不 fetch；`useEffect([])` 只在 mount 执行；设置页交互（勾选/输入）只触发父组件重渲染，不重跑 effect | 不要用 `useEffect([someState])`；不要 useMemo 里 fetch |
| 与 config fetch 并发 | mount 时 config GET（31ms）与新 note-stat GET（~25ms）并发，互不依赖 | 两个独立请求可接受；不要串行等待 |
| 连续开关设置页 | 每次 mount 一次请求；本地 localhost ~25ms | 可选：模块级 30s 缓存去抖（非必须） |
| 桌面/Web 生命周期 | 桌面 renderer 从 `dsh-app://app` 启动（asar `lib/main.js#19371/#20744`），Host 在启动后才可转发（`#20622` 要求 hostUrl/hostCookie 已就绪） | 设置页在启动后打开 ⇒ 可转发；插件刚启动 topicdb 未就绪 ⇒ 端点返回 `ready:false`，前端隐藏 |

---

## 3. 表 3 · 边界场景（会发生什么 + 兜底）

| 边界 | 会发生什么 | 显示/兜底 |
|---|---|---|
| **桌面端（当前 0.2.2-rc.1）** | fetch 经 `dsh-app://app` → protocol handler → Host 转发 → 200 | 正常显示「N 个主题 / M 句」；实测桌面 Host `/dsh-memory/stats.json` 200、noteUnrefined 6/32 |
| 桌面端旧版本/协议未转发 | fetch 失败（网络错误/400） | `catch` 静默 + 不渲染该行（绝不显示 undefined/错误） |
| **web 端** | 同源 fetch 200 | 正常显示 |
| 插件刚启动 / topicdb 未就绪 | 端点返回 `enabled:true, ready:false, topics:0, sentences:0`（参考 `topicDbStatsSnapshot#9138-9139/#9182-9187`） | `!ready` ⇒ 隐藏（或显示「—」）；不要显示 0 误导 |
| flag 关（`memoryTopicDbEnabled=false`） | 端点返回 `enabled:false`（参考 `#12494` topicdb=null） | 隐藏该行 |
| 无 webServer（CLI/headless） | 路由未注册 ⇒ fetch 404 | 隐藏 |
| 面板路由 `/dsh-memory/stats` 404 | 本需求不链接面板；既有「打开详细统计面板」入口保持原样 | 不影响 |
| 快速反复开关设置页 | 每次 mount 一次请求（~25ms/100B） | 可接受；可加 30s 模块缓存 |
| 桌面端 `<a target="_blank">` 被拦 | 既有统计面板链接仍显示桌面指引（`client.js#164-176`；asar `lib/main.js#13083` setWindowOpenHandler） | 本需求**不改**该入口，避免额外风险 |

---

## 4. 八项逐条回答（含行号）

1. **调用链/打包**：`client/package.json#7-15` 暴露 `./client → lib/client.js`；`#16-26` `dsh.client` 声明；Host `dsh-client-modules` 解析 `exports["./client"]`（asar `lib/index.js#199-209`）并读文件字节（`#690-693`），挂 `/plugins/<pkg>/`（`#187-232`）。**无需构建**（client.js 是手写 module-loader bundle，`client.js#2-4`）；但 `tools/sync-payload.mjs` 负责 payload zip + `install-manifest.json` sha（当前 `--check` OK，改动后必须重生成）；安装器按 manifest 校验 sha（`install.ps1#1965-1990`）并把 `client/**` 复制到 `<plugins>/dsh-memory-client/`（`#895-916`）、注册 patch（`#1493-1510`）。现有 desktop/web 实际加载 `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js`（desktop patch `#217-220`、web patch `#82-87`），其 sha 与工作副本一致（`4B21DA3B…` / 36,035B）⇒ 改完复制到该路径并**重启 DSH**（Host 启动时扫描 bundle 并算 revision；生产无文件热更）。
2. **可行性/桌面端**：**能**。桌面 Host 实测 :59562（PID 49100）`/dsh-memory/stats.json` 200、`/dsh-memory/config` 200/31ms；`dsh-app` 协议对非 app 路径转发（asar `lib/main.js#20617-20626`），转发器允许 `origin=null`/`dsh-app://app`（`#15877-15907`），scheme 支持 fetch（`#20048-20058`）。其他通道：`monitorSummary` 死字段（`client.js#26/#47` 无渲染；`index.js#7084/#7091-7094` settings API 已删）、`dshDesktop` boot 只有 injections/streamBaseUrl（asar `#20635-20642`）、configForms 只给配置快照 ⇒ **fetch 是最稳通道**（且 client 已在用 config fetch）。client.js#160-163 的「实测 400」需更新（旧版本/旧结论）。
3. **状态交互**：见 §2；设置页 `settings.general.item` 由 `GeneralSection` 渲染（asar `dsh-client-ui-settings-general/lib/client.js#639-643`）；组件随页面挂载/卸载；fetch 放 `useEffect([])`，一次/挂载；不随重渲染重复请求。
4. **正确性/降级**：`stats.json` 在 flag 关时**不产生 topicdb 段**（`index.js#12487-12494`）；`topicDbStatsSnapshot` 有 `enabled/ready`（`#9138-9139`），未就绪返回零值 + `error`（`#9182-9187`），`noteUnrefined` 默认零值（`#9179/#9291`）。前端**不要**直接用 stats.json（1.4s/461KB）；推荐端点返回 `{ok,enabled,ready,topics,sentences}`，前端 `Number.isFinite` + `ready/enabled` 守卫，缺失/失败隐藏，绝不渲染 `undefined`。
5. **四种边界**：见 §3（桌面成功/桌面失败隐藏/web 成功/未就绪隐藏；panel 404 不涉及）。
6. **方案对比**：
   - **A 只改 client，fetch `/dsh-memory/stats.json`**：diff 最小（1 文件），但实测 **1,406ms / 461KB**/次，且服务端为一行字跑全量 snapshot ⇒ **不推荐**。
   - **B（推荐）新增 `/dsh-memory/note-stat.json`**：host 用 `store.be.listTopics()`（实测 **2.77ms**，585 主题）+ 15 个笔记主题 `readTopic`（**25.9ms**）≈**24.6ms**，返回 ~100B；client 小 `NoteStatRow`；隔离好、不动配置路由。
   - **C 扩展 `/dsh-memory/config` GET**（client 已 fetch，无额外请求）：host 加廉价 note 统计（同样 ~25ms，config 31→~55ms），client store 加字段并渲染（`client.js#39-50/#471-479`）；diff 更小但耦合配置路由（写路径相关），语义略混。
   - **D 不加设置页**：面板页已有该行（`index.js#9473`），或 15% 提醒文案带出；不满足用户「设置界面一眼」。
   → **推荐 B**；若坚持零新增路由，选 C；A 仅当完全不能改 host 时的降级（但需接受 1.4s）。
7. **护栏（必须）**：
   - client：`AbortController` 3s 超时；`catch` 静默；`alive` 防卸载后 setState；`useEffect([])` 只 fetch 一次；`Number.isFinite` + `enabled/ready` 守卫；失败/未就绪/flag 关**隐藏整行**；文案上限（一行、不列 items）；不轮询、不 toast、不阻塞渲染；`cache:"no-store"`。
   - host：只读、`try/catch` 兜底（异常返回 `{ok:false}` 或零值，不抛到 Host）；`cache-control:no-store`；优先 `store.be.listTopics()`（两后端均有：sqlite `backend-sqlite.mjs#108-110`、ledger `backend-ledger.mjs#135`），缺失才回落 `store.topics()`（慢但可用）；flag 关/库未就绪返回 `enabled/ready` 标志；**不改** stats.json/config POST/既有链接。
   - 发布：改后 `node tools/sync-payload.mjs`（当前 `--check` OK，改后必须重生成）；复制到 `~/.dsh/profiles/web/plugins/dsh-memory-client/lib/client.js` 与 `.../web/plugins/memory/index.js`；重启 desktop（及 web）DSH；回滚 = 还原两文件 + 重启（无 DB 变更）。
8. **影响面**：设置页渲染性能：一次异步 ~25ms/100B 请求，不阻塞；插件加载：多注册 1 条 exact 路由（无 webServer 时 no-op）；桌面端可用性：**提升**（可显示；旧版失败静默隐藏）；现有「打开详细统计面板」入口**不变**；`monitorSummary` 死字段不动；数据一致性：纯只读，无写。

---

## 5. 最小 diff 方案（推荐 B）

**文件 1：`client/lib/client.js`（唯一 UI 改动）**
- 在 `MemorySettingsRow` 前新增 `function NoteStatRow(props)`（~25 行）：
  - `const [txt,setTxt]=react.useState("")`；
  - `react.useEffect(()=>{ let alive=true; const ctrl=typeof AbortController!=="undefined"?new AbortController():null; const timer=setTimeout(()=>{try{ctrl&&ctrl.abort()}catch(e){}},3000); fetch("/dsh-memory/note-stat.json",{cache:"no-store",signal:ctrl?ctrl.signal:undefined}).then(r=>r.ok?r.json():null).then(j=>{ if(!alive||!j||j.ok!==true||j.enabled!==true||j.ready!==true) return; const n=Number(j.topics), m=Number(j.sentences); if(Number.isFinite(n)&&Number.isFinite(m)) setTxt("会话笔记未提炼："+n+" 个主题 / "+m+" 句"); }).catch(()=>{}).finally(()=>clearTimeout(timer)); return ()=>{alive=false; clearTimeout(timer); try{ctrl&&ctrl.abort()}catch(e){}}; },[]);`
  - `if(!txt) return null;` + 一行 `div`（复用 `props.rowStyle/labelStyle/descStyle`）。
- 在 `MemorySettingsRow` 的 return 里、「记忆使用统计」行（`#157-177`）之后插入 `react.createElement(NoteStatRow,{rowStyle:rowStyle,labelStyle:labelStyle,descStyle:descStyle})`。
- 更新 `#160-163` 过期注释：0.2.2-rc.1 桌面端 fetch 可转发到 Host（仅 `<a target="_blank">` 仍被拦）；不改链接行为。

**文件 2：`index.js`（host 只读端点）**
- 在 `ctx.inject(["webServer"], ...)` 的 stats.json route（`#12466-12507`）之后加：
  ```js
  ctx.effect(() => wsrv.register({
    kind: "exact", path: "/dsh-memory/note-stat.json",
    handler: (_req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      try {
        if (!TOPICDB.enabled || !TOPICDB.ready || !TOPICDB.store) return res.end(JSON.stringify({ ok: true, enabled: !!TOPICDB.enabled, ready: false, topics: 0, sentences: 0 }));
        const store = TOPICDB.store;
        const rows = (store.be && typeof store.be.listTopics === "function") ? store.be.listTopics() : store.topics();
        const st = noteUnrefinedStats(store, rows);
        res.end(JSON.stringify({ ok: true, enabled: true, ready: true, topics: st.topics, sentences: st.sentences }));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
    },
  }), "dsh-memory: /dsh-memory/note-stat.json");
  ```
  （`noteUnrefinedStats` 模块级函数在 `index.js#3835-3856`，接受 rows 复用；`store.be.listTopics` 见 `backend-sqlite.mjs#108-110` / `backend-ledger.mjs#135`。）

**要不要重建**：**不需要构建 client bundle**（手写 module-loader 格式，直接改）。但必须：
1. `node tools/sync-payload.mjs`（重生成 `install-manifest.json` + `payload/dsh-memory-4.5.2.zip`；改前 `--check` OK，改后不重生成会校验失败）；
2. 复制 `client/lib/client.js` → `C:\Users\Starry\.dsh\profiles\web\plugins\dsh-memory-client\lib\client.js`（desktop patch `#217-220` 与 web patch `#82-87` 共用此文件；当前 sha 与 repo 一致）；
3. 复制 `index.js` → `C:\Users\Starry\.dsh\profiles\web\plugins\memory\index.js`（desktop/web 共用；`profiles/node_modules/dsh-memory` 是 junction 指向它）；
4. **重启 DSH Desktop**（Host 启动时扫描 client bundle/算 revision；生产无文件热更）；web profile 若也用则重启 web Host。
5. 若走安装器分发：`install.ps1` 会按 manifest 把 `client/**` 装到各 profile 的 `<plugins>/dsh-memory-client/`（`#895-916`、`#1493-1510`），并校验 sha（`#1965-1990`）。

**回滚**：还原两个文件（client.js/index.js）+ 重启；无数据库/配置变更。

---

## 6. 诚实缺口

1. 未在桌面 renderer 内直接执行 `fetch("/dsh-memory/note-stat.json")`（无法注入 devtools）；结论基于：桌面 Host 路由实测 200 + `dsh-app` 协议转发代码（asar `lib/main.js#20617-20626/#15877-15907`）+ client 现有 `/dsh-memory/config` fetch 生产使用。属**代码级确定 + Host 侧实测**，renderer 端建议改后目视/DevTools 复核一次。
2. 未实测旧版 DSH（0.2.1 及更早）的协议转发；旧版失败会静默隐藏（可接受）。
3. 未测 `note-stat.json` 在 ledger 后端下的真实耗时（sqlite 副本实测 ~25ms；ledger 的 `listTopics` 是内存 Map，推断更快）。
4. 未验证 settings 页多次挂载/快速切换下的实际请求次数（按 React/ slot 语义推断每次 mount 一次）。
5. 未跑客户端 UI 自动化（无 client 测试框架）；建议改后手动验收：桌面设置页显示 6/32、flag 关隐藏、web 端显示、CLI/headless 不显示。
6. 未评估把该行并入「记忆使用统计」同一行 vs 独立行的视觉细节（建议独立一行，样式复用现有 `rowStyle/labelStyle/descStyle`）。

---

*CRA 只读审计：未修改代码、未构建、未部署、未动数据库。*
