// v1.12.4-client: pad hoisted, lineHeight 22px, overflowWrap break-word
window.__ModuleLoader__.load({
	id: "dsh-memory-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let runtime_client = require("@deepseek-ai/dsh-client-store");

		// 设置命名空间（与宿主插件 installSettingsSection 注册的一致）
		const NS = "dsh-memory";

		// 行 store：镜像 settings 快照（由 apply 层 sync 写入）
		function createMemoryStore() {
			return runtime_client.defineStore({
				init: () => ({
					integrateEnabled: false,
					integrateDays: 7,
					monitorEnabled: true,
					// [CRA M1 修复 2026-11-05] `staleSessionDays` **不能删 UI**：审计证明它仍被子代理摘要通道
					//   真实读取（index.js#5969/#6025/#20219，当前 live 值=1 天）。删掉唯一 UI ⇒ 用户无法再从
					//   设置页调这个**仍生效**的参数。控件保留但改名为「子代理摘要回溯天数」（它的实际职责）。
					//   `staleAction`/`staleCount` 才是真死（后端无分支、恒 0），已删。
					staleSessionDays: 5,
					monitorSummary: "",
					revision: -1,
					status: "loading",
					// [2026-09-23] 编辑草稿：null=未编辑（跟随宿主值）；字符串=用户正在输入的中间态（允许空串）
					daysDraft: null,
					daysSaving: false,
					configError: ""
				}),
				actions: {
					// [2026-09-23] 草稿态 actions —— 输入期间只改草稿，不碰宿主值
					setDaysDraft: (d, text) => { d.daysDraft = text; d.configError = ""; },
					clearDaysDraft: (d) => { d.daysDraft = null; },
					setSaveState: (d, saving, error) => { d.daysSaving = !!saving; d.configError = error || ""; },
					sync: (d, next, revision) => {
						if (revision <= d.revision) return;
						// [2026-09-23] 宿主快照可能**不含**本命名空间的值（选项1后真值在我们的 .config.json 里）：
						//   原写法无条件写入 ⇒ undefined 覆盖 → 数字框被渲染成 "undefined"、再被浏览器 sanitize 成空串。
						if (typeof next.integrateEnabled === "boolean") d.integrateEnabled = next.integrateEnabled;
						if (typeof next.integrateDays === "number") d.integrateDays = next.integrateDays;
						if (typeof next.staleSessionDays === "number") d.staleSessionDays = next.staleSessionDays;   // [CRA M1]
						if (typeof next.monitorEnabled === "boolean") d.monitorEnabled = next.monitorEnabled;
						if (typeof next.monitorSummary === "string") d.monitorSummary = next.monitorSummary;
						d.status = next.status || "ready";
						d.revision = revision;
					}
				}
			});
		}

		// [2026-09-23 dsh 升级适配] settingsScope 服务已被删除，改用 configForms
		const inject = ["slots", "configForms"];

		// 通用设置 → 记忆（一行一项：每个配置项独立一行，左标签右控件 + 分割线）
		function MemorySettingsRow(props) {
			const { useStore, setConfigField } = props;
			// [2026-09-23 真机实测修复] 槽框架**不把 store 的 actions 注入 props**（只给 useStore/store + injected() 的返回值），
			//   原写法 setDaysDraft/clearDaysDraft/setSaveState 实为 undefined ⇒ onChange/onBlur 抛
			//   "TypeError: setDaysDraft is not a function"（浏览器现场捕获）⇒ 输入框永远弹回，一个字都敲不进去。
			//   改为组件内 useState 草稿态，不再依赖框架注入约定。
			const [saving, setSaving] = react.useState(false);
			const [errMsg, setErrMsg] = react.useState("");
			const setSaveState = (s, e) => { setSaving(!!s); setErrMsg(e || ""); };
			// [CRA M1 修复 2026-11-05] 子代理摘要回溯天数：本地草稿 + 失焦提交（沿用原漏网天数的交互口径，范围 1~90）。
			//   为什么保留：审计证明 `staleSessionDays` 仍被子代理摘要通道真实读取（index.js#5969/#6025/#20219）。
			const [daysDraft, setDaysDraft] = react.useState(null);
			const commitDays = (text) => {
				const raw = String(text == null ? "" : text).trim();
				const v = parseInt(raw, 10);
				if (!(Number.isFinite(v) && v >= 1 && v <= 90)) { setDaysDraft(null); return; }
				if (v === staleSessionDays) { setDaysDraft(null); return; }
				setSaveState(true, "");
				Promise.resolve(setConfigField("staleSessionDays", v)).then((r) => {
					if (r && r.ok === true) { setDaysDraft(null); setSaveState(false, ""); }
					else setSaveState(false, "保存失败：" + ((r && r.error) || ""));
				}).catch(() => { setSaveState(false, "保存失败"); });
			};
			const integrateEnabled = useStore((s) => s.integrateEnabled);
			const integrateDays = useStore((s) => s.integrateDays);
			const staleSessionDays = useStore((s) => s.staleSessionDays);   // [CRA M1]
			const monitorEnabled = useStore((s) => s.monitorEnabled);
			const status = useStore((s) => s.status);
			// [2026-09-23] 草稿/保存中/错误一律取组件本地态（原先读 store actions，实测未注入，全部 undefined）
			const configError = errMsg;

			// 每行：水平 flex + 下方分割线（对齐 DSH 原生行）
			const rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "12px 0", display: "flex", width: "100%" };
			const labelStyle = { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" };
			const titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 500, lineHeight: "22px" };
			const descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: 400, lineHeight: "18px" };
			const inputStyle = { width: "56px", height: "36px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "18px", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", padding: "0 12px", font: "inherit", textAlign: "center" };

			// 一行：标签（左）+ 控件（右）
			const itemRow = (label, controls) =>
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: labelStyle }, label),
					controls
				);

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", width: "100%" } },
				// 标题行
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: { flex: 1, minWidth: 0 } },
						react.createElement("div", { style: titleStyle },
							"记忆（dsh-memory）",
							status === "unavailable" ? "（设置不可用）" : ""
						)
					)
				),
				// [2026-09-23] 配置保存反馈（失败时显示；成功/未编辑时不占位）
				configError
					? react.createElement("div", { style: Object.assign({}, descStyle, { padding: "0 0 10px", color: "var(--dsw-alias-state-error-primary, #d32f2f)" }) }, "⚠️ " + configError)
					: null,
				// 行：子代理摘要回溯天数（[CRA M1] 该参数仍生效——被子代理摘要通道读取，不能删 UI）
				itemRow("子代理摘要回溯天数",
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
						react.createElement("input", {
							type: "number", min: 1, max: 90, style: inputStyle,
							value: daysDraft === null ? String(staleSessionDays == null ? 5 : staleSessionDays) : daysDraft,
							title: "子代理会话摘要的回溯天数（天，1~90）",
							onChange: (e) => { setDaysDraft(e.target.value); setSaveState(false, ""); },
							onBlur: () => commitDays(daysDraft)
						}),
						react.createElement("span", { style: descStyle }, "天")
					)
				),
				// 行：自动整合（开关 + 间隔）
				itemRow("自动整合记忆",
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
						react.createElement("input", {
							type: "checkbox", checked: !!integrateEnabled,
							title: "每 N 天自动整合记忆（提升/精简/去重，子代理执行）",
							style: { width: "16px", height: "16px", cursor: "pointer" },
							onChange: (e) => { Promise.resolve(setConfigField("integrateEnabled", e.target.checked)).then((r) => { if (!(r && r.ok === true)) setSaveState(false, "保存失败：" + ((r && r.error) || "")); else setSaveState(false, ""); }); }
						}),
						react.createElement("input", {
							type: "number", min: 1, max: 90, value: integrateDays, style: inputStyle,
							title: "自动整合间隔（天）", disabled: !integrateEnabled,
							onChange: (e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v) && v >= 1 && v <= 90) { Promise.resolve(setConfigField("integrateDays", v)).then((r) => { if (!(r && r.ok === true)) setSaveState(false, "保存失败：" + ((r && r.error) || "")); else setSaveState(false, ""); }); } }
						}),
						react.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" } }, "天/次")
					)
				),
				// 行：使用监控开关
				itemRow("使用监控",
					react.createElement("input", {
						type: "checkbox", checked: !!monitorEnabled,
						title: "记录提醒/查询/错误事件到 .monitor.json，供统计面板实时展示；用于使用一段时间后优化",
						style: { width: "16px", height: "16px", cursor: "pointer" },
						onChange: (e) => { Promise.resolve(setConfigField("monitorEnabled", e.target.checked)).then((r) => { if (!(r && r.ok === true)) setSaveState(false, "保存失败：" + ((r && r.error) || "")); else setSaveState(false, ""); }); }
					})
				),
				// 行：统计面板入口（v2.4.3 起设置页不再内嵌汇总文本，详情由面板实时展示）
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: labelStyle }, "记忆使用统计"),
					// [logpane 20260930] 桌面端（dsh-app://）里 `<a target="_blank">` 被 Electron 的 setWindowOpenHandler
					//   拦掉，且页面 fetch /dsh-memory/* 也到不了插件路由（协议处理器只服务 app 文档/资源，实测 HTTP 400）
					//   ⇒ 桌面端只能由宿主进程拉起系统浏览器，入口是宿主命令 /memory-panel（见插件 index.js）。
					//   此处链接只服务 web 端；桌面端点击给可执行指引。
					react.createElement("a", {
						href: "/dsh-memory/stats",
						target: "_blank",
						rel: "noopener noreferrer",
						onClick: (e) => {
							try {
								if (typeof location === "undefined" || location.protocol !== "dsh-app:") return;   // web 端走原生新标签页
								e.preventDefault();
								setSaveState(false, "桌面端请发 /memory-panel 打开（宿主调用系统浏览器；dsh-app:// 源访问不到插件路由，实测 400）");
							} catch (err) { /* 非浏览器环境忽略 */ }
						},
						style: { fontSize: "13px", color: "var(--dsw-alias-link, #3b82f6)", textDecoration: "underline", cursor: "pointer", whiteSpace: "nowrap" }
					}, "📊 打开详细统计面板")
				),
				// [P3-3 消耗记账] 「消耗」页签（追加段；只读，上方既有行与逻辑零改动）
				react.createElement(CostPanel, null)
			);
		}
		// ═══════════════════════ [P3-3 消耗记账]「消耗」页签（追加段） ═══════════════════════
		// 只读展示：GET /dsh-memory/stats.json 的 cost 段（结构见 13-p3-design.md §5.2）；
		// 不提供清空/改阈值按钮（阈值仍由 /dream 自校准）；只用 react.useState，展开/刷新时才 fetch。
		const COST_KINDS = [
			["checkpointWrite", "检查点写入"], ["rebuildInject", "压缩后重灌"], ["startupInject", "启动注入"], ["recallReminder", "定期轻提醒"],
			["hintA", "提醒 A"], ["hintB", "提醒 B"], ["hintC", "提醒 C"], ["memorySearch", "记忆检索"], ["dream", "dream 整合"],
			["maint", "合并维护"], ["export", "导出"]
		];
		// [G6][2026-11-05] kind → 中文名映射；**未知 kind 回落原字符串**（历史账本里可能还有已下线的 archive 等），
		//   绝不把 label 渲染成 undefined/空（旧写法靠 COST_KINDS 一一对应，删一项 ⇒ 该环节静默消失）。
		const COST_KIND_LABEL = (() => { const m = {}; for (const x of COST_KINDS) m[x[0]] = x[1]; return m; })();
		// 宿主 usage 三桶不属于插件自身开销（2026-11-03 用户口径），面板恒不展示；未知 kind 追加行时也要排除
		const COST_HIDDEN_KINDS = { hostUsage: 1, hostMain: 1, hostSub: 1 };
		function costKindLabel(k) { return COST_KIND_LABEL[k] || String(k); }
		const COST_TRIGGERS = [["T1", "阈值50%"], ["T2", "阈值75%"], ["T3", "阈值90%"], ["T4", "压缩"], ["T5", "收尾"]];
		function costNum(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
		function costPad(n) { return (n < 10 ? "0" : "") + n; }
		function costFmt(n) {
			n = costNum(n);
			const a = Math.abs(n), f = (v, u) => String(Math.round(v * 100) / 100) + u;
			return a >= 1e9 ? f(n / 1e9, "B") : a >= 1e6 ? f(n / 1e6, "M") : a >= 1e3 ? f(n / 1e3, "K") : String(Math.round(n));
		}
		function costDur(ms) {
			ms = costNum(ms);
			return ms <= 0 ? "-" : ms < 1000 ? Math.round(ms) + "ms" : ms < 60000 ? (ms / 1000).toFixed(1) + "s" : (ms / 60000).toFixed(1) + "min";
		}
		function costDayKey() { const d = new Date(); return d.getFullYear() + "-" + costPad(d.getMonth() + 1) + "-" + costPad(d.getDate()); }
		function costRec(map, kind) { return map && typeof map === "object" && map[kind] && typeof map[kind] === "object" ? map[kind] : {}; }
		// 宿主 stats.json 现行口径 = p3-cost.js 的 summarize() 输出（today/byKind/trend7d/topSessions）；
		// 同时兼容直接下发 §5.2 原始账本（daily/totals/events）的情况。
		function costDayMapOf(cost, key) {
			if (!cost || typeof cost !== "object") return null;
			if (cost.byKind && cost.today) {
				const map = {}, real = cost.today.real || {};
				for (const x of COST_KINDS) { const r = cost.byKind[x[0]]; if (r) map[x[0]] = r; }
				// [G6] 已知列表之外的历史 kind（如已下线的 archive）照原样带进 map，渲染层用原字符串兜底，不静默吞掉
				for (const k in cost.byKind) {
					if (!Object.prototype.hasOwnProperty.call(cost.byKind, k)) continue;
					if (map[k] || COST_KIND_LABEL[k] || COST_HIDDEN_KINDS[k]) continue;
					const r = cost.byKind[k];
					if (r && typeof r === "object") map[k] = r;
				}
				map.hostUsage = { inTokens: real.inTokens, outTokens: real.outTokens, cacheRead: real.cacheRead, totalTokens: real.totalTokens, turns: real.turns };
				return map;
			}
			return cost.daily && typeof cost.daily === "object" ? (cost.daily[key] || null) : null;
		}
		// 单日合计：真实 tokens 只来自 hostUsage；估算 tokens 累加各环节 estTokens
		function costSum(dayMap) {
			const out = { n: 0, est: 0, inChars: 0, outChars: 0, fail: 0, retry: 0, inTokens: 0, outTokens: 0, cacheRead: 0, totalTokens: 0, turns: 0 };
			for (const x of COST_KINDS) {
				const k = x[0], r = costRec(dayMap, k);
				out.est += costNum(r.estTokens);
				if (k !== "hostUsage") { out.n += costNum(r.n); out.inChars += costNum(r.inChars); out.outChars += costNum(r.outChars); out.fail += costNum(r.fail); out.retry += costNum(r.retry); continue; }
				out.inTokens += costNum(r.inTokens); out.outTokens += costNum(r.outTokens); out.cacheRead += costNum(r.cacheRead);
				out.totalTokens += costNum(r.totalTokens); out.turns += costNum(r.turns);
			}
			if (!out.totalTokens) out.totalTokens = out.inTokens + out.outTokens + out.cacheRead;
			return out;
		}
		// 最近 days 天趋势（升序；缺日补零）
		function costTrend(cost, days) {
			if (cost && Array.isArray(cost.trend7d) && cost.trend7d.length) return cost.trend7d.slice(-days).map((x) => ({ date: x.date, est: costNum(x.estTokens), n: costNum(x.n), real: costNum(x.real) }));
			const out = [], now = new Date();
			for (let i = days - 1; i >= 0; i--) {
				const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
				const key = d.getFullYear() + "-" + costPad(d.getMonth() + 1) + "-" + costPad(d.getDate());
				const s = costSum(costDayMapOf(cost, key));
				out.push({ date: key, est: s.est, n: s.n, real: s.totalTokens });
			}
			return out;
		}
		// 今日触发档位（summarize 已算好直接取；原始账本按事件 d 归集，全都不带 d 时退化为最近窗口）
		function costTriggers(cost) {
			if (cost && cost.today && cost.today.triggers) return cost.today.triggers;
			const evs = cost && Array.isArray(cost.events) ? cost.events : [], today = costDayKey(), hasD = evs.some((e) => e && typeof e.d === "string");
			const out = { total: 0 };
			for (let t = 0; t < COST_TRIGGERS.length; t++) out[COST_TRIGGERS[t][0]] = 0;
			for (let i = 0; i < evs.length; i++) {
				const ev = evs[i];
				if (!ev || ev.kind !== "checkpointWrite") continue;
				if (hasD && ev.d !== today) continue;
				let lv = typeof ev.trigger === "string" && /^T[1-6]$/.test(ev.trigger) ? ev.trigger : null;
				if (!lv && typeof ev.note === "string") { const m = /^(T[1-6])\b/.exec(ev.note.trim()); if (m) lv = m[1]; }
				if (lv) { out[lv] += 1; out.total += 1; }
			}
			return out;
		}
		// 今日检查点写入 Top 会话（summarize 已算好直接取；否则按事件聚合、估算 tokens 降序）
		function costTopSessions(cost, limit) {
			if (cost && Array.isArray(cost.topSessions)) return cost.topSessions.slice(0, limit).map((x) => ({ sid: x.sid, n: costNum(x.n), est: costNum(x.estTokens) }));
			const evs = cost && Array.isArray(cost.events) ? cost.events : [], today = costDayKey(), hasD = evs.some((e) => e && typeof e.d === "string");
			const bySid = {}, list = [];
			for (let i = 0; i < evs.length; i++) {
				const ev = evs[i];
				if (!ev || ev.kind !== "checkpointWrite") continue;
				if (hasD && ev.d !== today) continue;
				const sid = typeof ev.sid === "string" && ev.sid ? ev.sid : "（未知会话）";
				const a = bySid[sid] || (bySid[sid] = { sid: sid, n: 0, est: 0 });
				a.n += 1; a.est += costNum(ev.estTokens);
			}
			for (const k in bySid) if (Object.prototype.hasOwnProperty.call(bySid, k)) list.push(bySid[k]);
			list.sort((a, b) => (b.est - a.est) || (b.n - a.n));
			return list.slice(0, limit);
		}

		// 「消耗」页签本体：折叠行 + 展开的只读明细（今日 / 分环节 / 7 天趋势 / Top 会话）
		function CostPanel() {
			const [open, setOpen] = react.useState(false);
			const [cost, setCost] = react.useState(null);
			const [msg, setMsg] = react.useState("");
			const [at, setAt] = react.useState("");
			const load = () => {
				setMsg("读取中…");
				fetch("/dsh-memory/stats.json", { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("http " + r.status))))
					.then((j) => {
						const c = j && j.cost && typeof j.cost === "object" ? j.cost : null;
						setCost(c);
						setMsg(c ? "" : "宿主未下发 cost 段（尚未接线或尚无记账）");
						setAt(new Date().toLocaleTimeString());
					})
					.catch((e) => { setCost(null); setMsg("读取失败：" + ((e && e.message) || String(e))); setAt(new Date().toLocaleTimeString()); });
			};
			const toggle = () => { const next = !open; setOpen(next); if (next) load(); };
			const rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", display: "flex", alignItems: "center", gap: "8px", padding: "12px 0", width: "100%" };
			const labelStyle = { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" };
			const descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: 400, lineHeight: "18px" };
			const tabStyle = { height: "30px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "15px", background: "0 0", color: "var(--dsw-alias-label-primary)", cursor: "pointer", display: "inline-flex", alignItems: "center", font: "inherit", fontSize: "12px", padding: "0 12px", whiteSpace: "nowrap" };
			const tabOn = { background: "var(--dsw-alias-state-business-tertiary)", borderColor: "transparent", color: "var(--dsw-alias-state-business-primary)" };
			const boxStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", background: "var(--dsw-alias-bg-module-platform)", marginTop: "8px", padding: "10px 12px" };
			const thStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "11.5px", fontWeight: 500, padding: "4px 8px 4px 0", textAlign: "right", whiteSpace: "nowrap" };
			const tdStyle = { color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums", fontSize: "12px", padding: "4px 8px 4px 0", textAlign: "right", whiteSpace: "nowrap" };
			const h4Style = { color: "var(--dsw-alias-label-primary)", fontSize: "12.5px", fontWeight: 600, margin: "0 0 6px" };
			const cell = (v, first) => react.createElement("td", { style: first ? Object.assign({}, tdStyle, { textAlign: "left" }) : tdStyle }, v);

			const children = [react.createElement("div", { key: "head", style: rowStyle },
				react.createElement("div", { style: labelStyle },
					react.createElement("div", null, "消耗记账（只读）"),
					react.createElement("div", { style: descStyle }, "检查点写入 / 注入 / 提醒 / 检索 / dream 的 token 与耗时；真实 usage 来自宿主，注入面为字符数估算（≈4 字符/token）")
				),
				react.createElement("button", { type: "button", style: Object.assign({}, tabStyle, open ? tabOn : {}), "aria-pressed": open, onClick: toggle }, open ? "消耗 ▾" : "消耗 ▸")
			)];

			if (open) {
				const body = [react.createElement("div", { key: "meta", style: Object.assign({}, descStyle, { display: "flex", alignItems: "center", gap: "8px" }) },
					react.createElement("span", { style: { flex: 1, minWidth: 0 } }, msg || ("更新于 " + (at || "-") + " · 面板只读，阈值由 /dream 自校准")),
					react.createElement("button", { type: "button", style: Object.assign({}, tabStyle, { height: "24px", borderRadius: "12px", padding: "0 10px" }), onClick: load }, "刷新")
				)];
				if (cost) {
					const todayKey = (cost.today && cost.today.dateKey) || costDayKey();
					const dayMap = costDayMapOf(cost, todayKey), day = costSum(dayMap);
					const trig = costTriggers(cost), trend = costTrend(cost, 7), tops = costTopSessions(cost, 5);
					const trigText = COST_TRIGGERS.filter((x) => trig[x[0]] > 0).map((x) => x[1] + " " + trig[x[0]] + " 次").join(" · ") || "0 次";
					body.push(react.createElement("div", { key: "today", style: boxStyle },
						react.createElement("div", { style: h4Style }, "今日（" + todayKey + "）"),
						// [口径][2026-11-03 用户] 只展示**记忆代理自身**的消耗：
						//   宿主 usage（主会话对话 + 子代理混桶）不是插件开销，面板不再展示（原「真实 tokens」行已删）。
						react.createElement("div", { style: descStyle }, "插件自身估算 tokens：" + costFmt(day.est) + "（分环节见下表；只含检查点/注入/提醒/检索/dream/归档等插件行为）"),
						react.createElement("div", { style: descStyle }, "触发：" + trigText),
						react.createElement("div", { style: descStyle }, "失败：" + day.fail + " 次" + (day.retry > 0 ? "（已重试 " + day.retry + " 次）" : ""))
					));
					// [G6] 已知环节按固定顺序在前，历史未知 kind（如已下线的 archive）追加在后；label 回落原字符串，不崩不吞
					const extraKinds = dayMap ? Object.keys(dayMap).filter((k) => !COST_KIND_LABEL[k] && !COST_HIDDEN_KINDS[k]) : [];
					const rows = COST_KINDS.map((x) => x[0]).concat(extraKinds).map((k) => {
						const r = costRec(dayMap, k), n = costNum(r.n);
						return { kind: k, label: costKindLabel(k), n: n, inChars: costNum(r.inChars), outChars: costNum(r.outChars), est: costNum(r.estTokens), avg: n > 0 ? costNum(r.durMs) / n : 0, fail: costNum(r.fail) };
					}).filter((r) => r.n > 0 || r.est > 0 || r.inChars > 0 || r.fail > 0);
					body.push(react.createElement("div", { key: "kinds", style: boxStyle },
						react.createElement("div", { style: h4Style }, "分环节（今日）"),
						rows.length === 0
							? react.createElement("div", { style: descStyle }, "今日暂无记账")
							: react.createElement("table", { style: { borderCollapse: "collapse", width: "100%" } },
								react.createElement("thead", null, react.createElement("tr", null,
									react.createElement("th", { style: Object.assign({}, thStyle, { textAlign: "left" }) }, "环节"),
									react.createElement("th", { style: thStyle }, "次数"),
									react.createElement("th", { style: thStyle }, "输入字符"),
									react.createElement("th", { style: thStyle }, "输出字符"),
									react.createElement("th", { style: thStyle }, "估算tokens"),
									react.createElement("th", { style: thStyle }, "均时长"),
									react.createElement("th", { style: thStyle }, "失败")
								)),
								react.createElement("tbody", null, rows.map((r) => react.createElement("tr", { key: r.kind },
									cell(r.label, true), cell(r.n), cell(costFmt(r.inChars)), cell(costFmt(r.outChars)), cell(costFmt(r.est)), cell(costDur(r.avg)), cell(r.fail)
								)))
							)
					));
					const maxEst = Math.max.apply(null, trend.map((x) => x.est).concat([1]));
					body.push(react.createElement("div", { key: "trend", style: boxStyle },
						react.createElement("div", { style: h4Style }, "7 天趋势（估算 tokens / 次数）"),
						trend.map((x) => react.createElement("div", { key: x.date, style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "3px" } },
							react.createElement("span", { style: { width: "42px", color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" } }, x.date.slice(5)),
							react.createElement("div", { style: { flex: 1, height: "8px", borderRadius: "4px", background: "var(--dsw-alias-border-l2)", overflow: "hidden" } },
								react.createElement("div", { style: { width: Math.round((x.est / maxEst) * 100) + "%", height: "100%", background: "var(--dsw-alias-state-business-primary)" } })),
							react.createElement("span", { style: { width: "86px", color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", textAlign: "right", fontVariantNumeric: "tabular-nums" } }, costFmt(x.est) + " / " + x.n + "次")
						))
					));
					body.push(react.createElement("div", { key: "tops", style: boxStyle },
						react.createElement("div", { style: h4Style }, "Top 会话（今日检查点写入估算 tokens）"),
						tops.length === 0
							? react.createElement("div", { style: descStyle }, "今日暂无检查点写入事件")
							: tops.map((x) => react.createElement("div", { key: x.sid, style: Object.assign({}, descStyle, { display: "flex", gap: "8px" }) },
								react.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, x.sid),
								react.createElement("span", { style: { fontVariantNumeric: "tabular-nums" } }, x.n + " 次 · " + costFmt(x.est) + " tok")
							))
					));
				}
				children.push(react.createElement("div", { key: "body", style: { width: "100%" } }, body));
			}
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", width: "100%" } }, children);
		}

		// ═══════════ [R2 等待浮层] 压缩后等检查点写入时右下角显示进度 ═══════════
		// 用户原话（2026-11-02）：「等待的时候能不能弹一个悬浮窗告诉用户？不然用户以为卡死了」。
		// 数据源：GET /dsh-memory/wait.json（插件侧 R2_WAIT_STATE，每 2s 轮询）；只读、失败静默、零依赖。
		function mountWaitHud() {
			try {
				if (typeof document === "undefined" || !document.body) return;
				if (document.getElementById("dsh-memory-wait-hud")) return;
				const el = document.createElement("div");
				el.id = "dsh-memory-wait-hud";
				el.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483000;min-width:264px;max-width:348px;padding:12px 14px;border-radius:14px;"
					+ "background:rgba(18,22,38,.86);backdrop-filter:blur(14px) saturate(160%);-webkit-backdrop-filter:blur(14px) saturate(160%);"
					+ "border:1px solid rgba(120,160,255,.28);box-shadow:0 10px 32px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);"
					+ "color:#e8eefc;font:12.5px/1.55 system-ui,'Microsoft YaHei',sans-serif;display:none;pointer-events:none;";
				document.body.appendChild(el);
				const fmt = (ms) => String(Math.max(0, Math.round((Number(ms) || 0) / 1000)));
				const render = (j) => {
					if (!j || !j.active) {
						// 结束后保留 2.5s 结果提示（超时/成功两种口径）
						if (j && j.result && j.doneAt && (Date.now() - j.doneAt) < 2500) {
							el.style.display = "block";
							el.innerHTML = '<div style="font-weight:600;margin-bottom:2px">记忆检查点已就绪</div>'
								+ '<div style="opacity:.72">' + (j.result === "timeout" ? "等待超时，已用最近一份检查点续接" : "已写入并完成压缩后重灌") + "</div>";
							return;
						}
						el.style.display = "none";
						return;
					}
					el.style.display = "block";
					const pct = (Number(j.maxMs) > 0) ? Math.min(100, Math.round((Number(j.elapsedMs) || 0) / Number(j.maxMs) * 100)) : 0;
					const phaseTxt = (j.phase === "rehydrate") ? "压缩后重灌上下文" : ("等 writer 落库（最多 " + fmt(j.maxMs) + "s）");
					el.innerHTML = '<div style="font-weight:600;margin-bottom:4px">正在写入记忆检查点…</div>'
						+ '<div style="opacity:.72;margin-bottom:6px">' + phaseTxt + "</div>"
						+ '<div style="height:6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden">'
						+ '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#5b8cff,#7ee7d8);transition:width .3s"></div></div>'
						+ '<div style="opacity:.55;margin-top:5px">已等 ' + fmt(j.elapsedMs) + "s" + (Number(j.remainingMs) > 0 ? " · 剩 " + fmt(j.remainingMs) + "s" : "") + "</div>";
				};
				const tick = () => {
					Promise.resolve(fetch("/dsh-memory/wait.json", { cache: "no-store" }))
						.then((r) => r.json())
						.then(render)
						.catch(() => { /* 宿主未就绪 / 端点不存在 ⇒ 静默 */ });
				};
				tick();
				setInterval(tick, 2000);
			} catch (e) {
				console.warn("[dsh-memory-client] 等待浮层挂载失败（忽略）:", e && e.message ? e.message : String(e));
			}
		}

		function apply(ctx) {
			mountWaitHud();   // [R2 等待浮层] 与设置行解耦：失败也不影响设置面板
			const store = createMemoryStore();
			let revision = 0;
			let boundActions = null;

			let scope;
			try {
				// [2026-09-23] settingsScope.bind → configForms.get（dsh 升级改名）
				scope = ctx.configForms.get(NS);
			} catch (e) {
				console.warn("[dsh-memory-client] configForms.get 失败:", e && e.message ? e.message : String(e));
			}

			// [2026-10-06 修复] **快照不是本命名空间的真值来源**（这正是「设置了会自动变成默认值」的真因）：
			//   本插件自持久化在 ~/.dsh/memory/.config.json（宿主侧优先级最高），而宿主 settings 文档里只有
			//   loader/schema 层——cordis.patch.yml 里的配置默认值，加上
			//   schema 默认 `integrateEnabled: false` / `integrateDays: 7`。
			//   旧写法把快照 value 无条件写进 store（类型守卫只挡 undefined，挡不住这些**真实的默认值**），
			//   于是每次镜像刷新（设置页打开 / settings/document-updated / connection/reset）都会把用户刚设好
			//   的值盖回默认值。现在：快照只提供 status；配置字段一律以 fetchConfig() 的真值为准，并在每次
			//   快照推送后立刻重新断言（节流）。
			//   注：revision 原先是「有的调用点先自增再传、sync() 却传自增前的值」——同一刻度被两个约定混用，
			//   导致快照写入时灵时不灵。统一走 bump()：先自增再传，语义唯一。
			const bump = () => { revision += 1; return revision; };

			// [2026-09-23 选项1] 真值源头：拉 host 自持久化端点（/dsh-memory/config）刷进 store ——
			//   否则设置页只认宿主快照里那个（可能不存在的）值，用户看到的不是生效值（实测数字框渲染为空）。
			const fetchConfig = () => {
				return fetch("/dsh-memory/config", { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : null))
					.then((j) => {
						if (!j || j.ok !== true || !j.cfg || !boundActions) return;
						try { boundActions.sync(Object.assign({}, j.cfg, { status: "ready" }), bump()); } catch (e) {}
					})
					.catch(() => { /* 端点不可用（宿主降级）时静默，保持当前回显 */ });
			};

			// 真值拉取节流（1.5s）：镜像刷新可能很密集，避免把端点打爆
			let lastCfgFetchAt = 0;
			const refreshConfigThrottled = () => {
				const now = Date.now();
				if (now - lastCfgFetchAt < 1500) return;
				lastCfgFetchAt = now;
				Promise.resolve(fetchConfig()).catch(() => {});
			};

			// 把 settings 快照同步进 store（store 实例的 boundActions 由 slots 框架经 inject 工厂提供）
			//   **只同步 status**：配置字段绝不从快照取值（见上，快照里是本命名空间的默认层）。
			const sync = () => {
				if (!boundActions) return;
				const snap = scope ? scope.getSnapshot() : null;
				boundActions.sync({ status: (snap && snap.status) || "ready" }, bump());
				refreshConfigThrottled();   // 快照可能刚把回显改掉 → 立刻用真值覆盖回来
			};

			if (scope) {
				scope.subscribe(sync);
			}

			// [2026-09-23 选项1] 用户配置写入：POST 到 host 端点，成功后拉回生效值刷新 store
			const patchConfig = (patch) => {
				return fetch("/dsh-memory/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch)
				}).then((r) => r.json().then((j) => Object.assign({ httpOk: r.ok }, j)))
					.then((j) => {
						if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || "宿主拒绝写入" };
						if (j.cfg && boundActions) {
							try { boundActions.sync(Object.assign({}, j.cfg, { status: "ready" }), bump()); } catch (e) {}
						}
						return { ok: true };
					})
					.catch((e) => ({ ok: false, error: (e && e.message) ? e.message : String(e) }));
			};

			const injected = (actions) => {
				boundActions = actions;
				sync();
				Promise.resolve(fetchConfig()).catch(() => {});
				// [2026-09-23 修复] 原实现丢弃 scope.set() 的 Promise —— 它 resolve(false) 表示宿主拒绝，
				//   无人观察 ⇒ 写入静默失败且界面无提示。现统一返回 Promise<boolean>，由 UI 决定提示/保留草稿。
				//   注意：scope 为 undefined（configForms 不可用）时 resolve(false)，走同一条失败提示路径。
				return {
					// [2026-09-23 选项1] 写入改走 host 自持久化端点（POST /dsh-memory/config）：
					//   dsh 0.1.7 的 config-editor 写回校验走 composeEntries(55 层)，本地插件条目恒被拒
					//   （实测 docAfter 已改而 composed 为空 → 抛 overridden）。端点落盘 ~/.dsh/memory/.config.json，
					//   优先级高于 loader config；返回 ok:true/false 供 UI 反馈。
					setConfigField: (field, value) => patchConfig(JSON.parse("{\"" + field + "\":" + JSON.stringify(value) + "}"))
				};
			};

			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "dsh-memory",
				order: 12,
				store: store,
				inject: injected
			}, MemorySettingsRow));

			console.log("[dsh-memory-client] 设置行已注册（设置 → 通用设置 → 记忆）");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
