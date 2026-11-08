// v1.12.4-client: pad hoisted, lineHeight 22px, overflowWrap break-word
window.__ModuleLoader__.load({
	id: "dsh-memory-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let runtime_client = require("@deepseek-ai/dsh-client-store");
		// [memory-ops-toast] Toast 原语（holdMs 2000 + 默认 1000ms 淡出 = 3s）；旧宿主缺该基线模块时降级为无 Toast（不影响设置页）
		let primitives = null;
		try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (ePrim) { primitives = null; }

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

		// [settings-note-stat 2026-11-07] 设置页「会话笔记未提炼」一行（CRA: docs/audit/settings-note-stat_CRA_2026-11-07.md）
		//   数据源 GET /dsh-memory/note-stat.json（host 侧极小端点 ~25ms/~100B；不用 stats.json：1.4s/461KB）。
		//   降级纪律：fetch 失败 / 3s 超时 / ok!==true / disabled:true / ready:false / 零值 ⇒ 整行不渲染（绝不显示 undefined/报错）。
		function noteStatFmt(n) { try { return Number(n).toLocaleString("zh-CN"); } catch (e) { return String(n); } }
		function NoteStatRow(props) {
			const p = props || {};
			const [txt, setTxt] = react.useState("");
			react.useEffect(() => {
				let alive = true;
				const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
				const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) { /* 忽略 */ } }, 3000);
				try {
					fetch("/dsh-memory/note-stat.json", { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
						.then((r) => (r && r.ok ? r.json() : null))
						.then((j) => {
							if (!alive || !j || j.ok !== true || j.disabled === true || j.ready === false) return;
							const n = Number(j.topics), m = Number(j.sentences);
							if (!Number.isFinite(n) || !Number.isFinite(m)) return;
							if (n <= 0 && m <= 0) return;
							setTxt(noteStatFmt(n) + " 个主题 / " + noteStatFmt(m) + " 句");
						})
						.catch(() => { /* 静默：旧版桌面端/无 webServer/网络错误一律隐藏 */ })
						.finally(() => { try { clearTimeout(timer); } catch (e) { /* 忽略 */ } });
				} catch (e) { try { clearTimeout(timer); } catch (e2) { /* 忽略 */ } }
				return () => { alive = false; try { clearTimeout(timer); } catch (e) { /* 忽略 */ } try { ctrl && ctrl.abort(); } catch (e) { /* 忽略 */ } };
			}, []);
			if (!txt) return null;
			return react.createElement("div", { style: p.rowStyle },
				react.createElement("div", { style: p.labelStyle }, "会话笔记未提炼"),
				react.createElement("div", { style: p.descStyle }, txt)
			);
		}

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
					// [settings-note-stat 2026-11-07] 桌面端（dsh-app://app）的 fetch 经 Electron 协议处理器**转发给已认证 Host**
					//   （asar lib/main.js#20617-20626 / forwardWebRequest#15877-15907）⇒ /dsh-memory/* 可达；
					//   旧注释「桌面端 fetch 实测 400」是过期结论，已失效。
					//   仍保留：`<a target="_blank">` 被 setWindowOpenHandler 拦 ⇒ 桌面端点击给 /memory-panel 指引（链接只服务 web 端）。
					react.createElement("a", {
						href: "/dsh-memory/stats",
						target: "_blank",
						rel: "noopener noreferrer",
						onClick: (e) => {
							try {
								if (typeof location === "undefined" || location.protocol !== "dsh-app:") return;   // web 端走原生新标签页
								e.preventDefault();
								setSaveState(false, "桌面端请发 /memory-panel 打开（宿主调用系统浏览器；dsh-app 里 target=_blank 会被拦）");
							} catch (err) { /* 非浏览器环境忽略 */ }
						},
						style: { fontSize: "13px", color: "var(--dsw-alias-link, #3b82f6)", textDecoration: "underline", cursor: "pointer", whiteSpace: "nowrap" }
					}, "📊 打开详细统计面板")
				),
				// [settings-note-stat 2026-11-07] 会话笔记未提炼（只读一行；失败/未就绪/flag 关/零值 ⇒ 静默隐藏）
				react.createElement(NoteStatRow, { rowStyle: rowStyle, labelStyle: labelStyle, descStyle: descStyle }),
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

		// ═══ [header-memory-indicator 2026-11-07] 会话标题栏「本会话记忆状态」单枚胶囊 ═══
		//   形态（CRA 定稿 docs/audit/header-memory-indicator_CRA_2026-11-07.md）：正常态**整枚隐藏**；
		//   压缩等待 `⏳ 整理中 12s`（蓝，秒数递增 + 呼吸动画）；待整理积压 `30 句待整理`（黄）；优先级 等待 > 积压 > 隐藏。
		//   tooltip 用原生 title；点击 web 端新标签开 /dsh-memory/stats，桌面端（dsh-app:）给 /memory-panel 指引。
		//   数据源：GET /dsh-memory/wait.json（2s；仅 active 且 sid8 匹配当前会话才显示，别的会话压缩不串）/
		//           GET /dsh-memory/note-stat.json?sid=<sessionId>（15s；per-session 未提炼句数 ≥ 阈值才显示）。
		//   纪律：失败静默隐藏；sessionId 变化 ⇒ abort 旧请求 + 清旧值 + 立即重取；卸载必清 timer；页面隐藏暂停轮询。
		const HEADER_NOTE_MIN = 10;     // 积压阈值：<10 句不焦虑，避免标题栏常驻（CRA §6.4）
		const HEADER_WAIT_MS = 2000;
		const HEADER_NOTE_MS = 15000;
		function headerSid8(sessionId) {
			const s = String(sessionId || "").replace(/^session-/, "");
			const m = /^([0-9a-f]{8})/.exec(s);
			return m ? m[1] : "";
		}
		let headerStyleInjected = false;
		function ensureHeaderStyle() {
			try {
				if (headerStyleInjected || typeof document === "undefined" || !document.head) return;
				if (document.getElementById("dsh-memory-header-style")) { headerStyleInjected = true; return; }
				const st = document.createElement("style");
				st.id = "dsh-memory-header-style";
				st.textContent = "@keyframes dsh-memory-wait-breathe{0%,100%{opacity:.65}50%{opacity:1}}";
				document.head.appendChild(st);
				headerStyleInjected = true;
			} catch (e) { /* 忽略 */ }
		}
		function HeaderMemoryIndicator(props) {
			const sessionId = props && props.sessionId;
			const sid8 = headerSid8(sessionId);
			const [waitMs, setWaitMs] = react.useState(0);   // >0 = 正在等检查点（已等 ms）
			const [noteN, setNoteN] = react.useState(0);     // >0 = 本会话待提炼句数
			const [hint, setHint] = react.useState(false);   // 桌面端点击后的 /memory-panel 指引
			const [hovered, setHovered] = react.useState(false);   // hover 高亮（内联样式无 :hover）
			const genRef = react.useRef(0);
			const hintTimerRef = react.useRef(null);   // 桌面端指引自动消失（跨 effect 生命周期）
			react.useEffect(() => {
				ensureHeaderStyle();
				if (!sessionId) { setWaitMs(0); setNoteN(0); return undefined; }
				const gen = genRef.current + 1;
				genRef.current = gen;
				setWaitMs(0); setNoteN(0);   // 切会话：立即清旧值，不许显示上个会话残留
				let waitTimer = null, noteTimer = null, waitCtrl = null, noteCtrl = null;
				const alive = () => genRef.current === gen;
				const abortAll = () => {
					try { waitCtrl && waitCtrl.abort(); } catch (e) { /* 忽略 */ }
					try { noteCtrl && noteCtrl.abort(); } catch (e) { /* 忽略 */ }
				};
				const hidden = () => (typeof document !== "undefined" && document.visibilityState === "hidden");
				const tickWait = () => {
					if (hidden()) return;
					try {
						waitCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
						const ctrl = waitCtrl;
						fetch("/dsh-memory/wait.json", { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
							.then((r) => (r && r.ok ? r.json() : null))
							.then((j) => {
								if (!alive() || !j || j.ok !== true) return;
								const s8 = String(j.sid8 || "");
								if (j.active === true && s8 && s8 === sid8) setWaitMs(Math.max(0, Number(j.elapsedMs) || 0));
								else setWaitMs(0);
							})
							.catch(() => { if (alive()) setWaitMs(0); });
					} catch (e) { /* 静默 */ }
				};
				const tickNote = () => {
					if (hidden()) return;
					try {
						noteCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
						const ctrl = noteCtrl;
						fetch("/dsh-memory/note-stat.json?sid=" + encodeURIComponent(String(sessionId)), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
							.then((r) => (r && r.ok ? r.json() : null))
							.then((j) => {
								if (!alive() || !j || j.ok !== true || j.disabled === true || j.ready === false) return;
								const n = Number(j.sentences);
								setNoteN(Number.isFinite(n) && n >= HEADER_NOTE_MIN ? n : 0);
							})
							.catch(() => { if (alive()) setNoteN(0); });
					} catch (e) { /* 静默 */ }
				};
				const start = () => { abortAll(); tickWait(); tickNote(); };
				start();
				waitTimer = setInterval(tickWait, HEADER_WAIT_MS);
				noteTimer = setInterval(tickNote, HEADER_NOTE_MS);
				const onVis = () => { if (!hidden()) start(); };
				try { if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onVis); } catch (e) { /* 忽略 */ }
				return () => {
					genRef.current = gen + 1;   // 丢弃在途响应（generation）
					abortAll();
					try { clearInterval(waitTimer); } catch (e) { /* 忽略 */ }
					try { clearInterval(noteTimer); } catch (e) { /* 忽略 */ }
					try { clearTimeout(hintTimerRef.current); } catch (e) { /* 忽略 */ }
					try { if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("visibilitychange", onVis); } catch (e) { /* 忽略 */ }
				};
			}, [sessionId, sid8]);
			const waiting = waitMs > 0;
			if (!waiting && !(noteN > 0)) return null;   // 正常态：整枚隐藏（不留灰点噪音）
			const isWait = waiting;
			const secs = Math.max(0, Math.round(waitMs / 1000));
			const label = isWait ? ("⏳ 整理中 " + secs + "s") : (noteN + " 句待整理");
			const title = isWait
				? ("记忆：正在写入检查点 " + secs + "s / 上限 120s，完成后本会话记忆会刷新")
				: ("记忆：本会话有 " + noteN + " 句笔记尚未整理进长期记忆，建议跑 /dream");
			const onClick = (e) => {
				try {
					if (typeof location !== "undefined" && location.protocol === "dsh-app:") {
						e && e.preventDefault && e.preventDefault();
						setHint(true);   // 桌面端：不导航，给 /memory-panel 指引（dsh-app 里 target=_blank 会被拦）
						try { clearTimeout(hintTimerRef.current); } catch (e2) { /* 忽略 */ }
						hintTimerRef.current = setTimeout(() => { try { setHint(false); } catch (e3) { /* 忽略 */ } }, 5000);
						return;
					}
					if (typeof window !== "undefined" && window.open) window.open("/dsh-memory/stats", "_blank", "noopener");
				} catch (err) { /* 静默 */ }
			};
			const style = {
				display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center",
				borderRadius: 999, padding: "0 8px", fontSize: 12, lineHeight: "18px",
				whiteSpace: "nowrap", userSelect: "none", fontVariantNumeric: "tabular-nums", cursor: "pointer",
				// 主题变量（浅/深色自适应）：等待=蓝 business、积压=黄 warn-label（DSH 专为文字场景准备，浅色下对比更稳）
				color: isWait ? "var(--dsw-alias-state-business-primary, #3b82f6)" : "var(--dsw-alias-state-warn-label, #b45309)",
				background: hovered ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.20))" : "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
				animation: isWait ? "dsh-memory-wait-breathe 1.6s ease-in-out infinite" : "none"
			};
			const capsule = react.createElement("span", {
				"data-dsh-memory-status": "1",
				"data-session-id": String(sessionId || ""),
				"data-mode": isWait ? "wait" : "note",
				title: title,
				"aria-label": title,
				onClick: onClick,
				onMouseEnter: () => setHovered(true),
				onMouseLeave: () => setHovered(false),
				style: style
			}, label);
			if (!hint) return capsule;
			return react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
				capsule,
				react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" } }, "请发 /memory-panel 打开")
			);
		}

		
		// ═══ [memory-ops-toast 2026-11-08] 记忆类工具操作语义化 Toast ═══
		//   数据源：GET /dsh-memory/ops.json?since=<ms>（host 内存环形缓冲，零 token 成本）。
		//   形态：shell.overlay（kind:"list"，frame-wide 浮层，与 chat quota 提示互不顶掉）+ Toast（holdMs 2000 + 默认 1000 淡出 = 3s）。
		//   防抖（严格）：合并键=工具名+成败；2s 窗口同类累加 ×N；同时只显示 1 条；队列上限 3（超丢最旧）；失败永不合并、永不丢弃。
		//   状态放模块作用域（单模块闭包，跨工具调用天然共享同一队列）。
		const OPS_POLL_MS = 2000;
		const OPS_QUEUE_MAX = 3;
		const OPS_MERGE_MS = 2000;
		const OPS_HOLD_MS = 2000;   // Toast holdMs；+ 默认 1000ms 淡出 = 整条 3s
		const OPS_ACTION = {
			memory_search: "查询记忆",
			memory_read: "读取记忆",
			memory_note: "写入笔记",
			memory_topics: "浏览主题树",
			session_search: "检索会话原文",
			memory_onboard: "记忆自检"
		};
		const opsQueue = [];           // 待显示：{key, tool, ok, base, count, at}
		const opsListeners = new Set();
		let opsActive = null;         // 正在显示的 item（同一时刻只 1 条）
		let opsPollTimer = null, opsPollCtrl = null, opsLastTs = 0, opsStarted = false;
		function opsEmit() { opsListeners.forEach((fn) => { try { fn(); } catch (e) { /* 忽略 */ } }); }
		function opsActionName(tool) { return OPS_ACTION[String(tool || "")] || "记忆操作"; }
		function opsBaseText(op) {
			const tool = String((op && op.tool) || "");
			const ok = !(op && op.ok === false);
			const summary = String((op && op.summary) || "").trim();
			if (!ok) return "❌ " + opsActionName(tool) + "失败" + (summary ? " · " + summary : "");
			if (tool === "memory_search") return "🔍 已查询记忆" + (summary ? " · " + summary : "");
			if (tool === "memory_read") return "📖 已读取" + (summary ? " " + summary : "");
			if (tool === "memory_note") return "📝 已写入笔记" + (summary ? " · " + summary : "");
			if (tool === "memory_topics") return "🗂 已浏览主题树";
			if (tool === "session_search") return "🔎 已检索会话原文";
			if (tool === "memory_onboard") return "⚙️ 记忆自检";
			return "🧠 记忆操作";
		}
		function opsItemText(it) { return it.count > 1 ? (it.base + " ×" + it.count) : it.base; }
		function opsTrim() {
			// 队列上限只约束成功条目；失败条目永不丢弃（可能超上限，属于有意为之）
			let okN = 0;
			for (const it of opsQueue) if (it.ok) okN += 1;
			while (okN > OPS_QUEUE_MAX) {
				const idx = opsQueue.findIndex((x) => x.ok);
				if (idx < 0) break;
				opsQueue.splice(idx, 1);
				okN -= 1;
			}
		}
		function opsPump() {
			if (opsActive || !opsQueue.length) return;
			opsActive = opsQueue.shift();
			opsEmit();
		}
		function opsDone() {
			opsActive = null;
			opsEmit();
			setTimeout(() => { try { opsPump(); } catch (e) { /* 忽略 */ } }, 120);   // 两条之间留一口气，避免视觉粘连
		}
		function opsEnqueue(op) {
			try {
				const tool = String((op && op.tool) || "");
				const ok = !(op && op.ok === false);
				const base = opsBaseText(op);
				const now = Date.now();
				if (!ok) {   // 失败：永远单独提示（不合并、不丢弃、不参与队列上限淘汰）
					opsQueue.push({ key: tool + "|err", tool: tool, ok: false, base: base, count: 1, at: now });
					opsPump();
					return;
				}
				const key = tool + "|ok";
				const mergeTarget = (opsActive && opsActive.key === key && (now - opsActive.at) <= OPS_MERGE_MS)
					? opsActive
					: (opsQueue.length && opsQueue[opsQueue.length - 1].key === key && (now - opsQueue[opsQueue.length - 1].at) <= OPS_MERGE_MS)
						? opsQueue[opsQueue.length - 1] : null;
				if (mergeTarget) {
					mergeTarget.count += 1;
					mergeTarget.at = now;
					opsEmit();
					return;
				}
				opsQueue.push({ key: key, tool: tool, ok: true, base: base, count: 1, at: now });
				opsTrim();
				opsPump();
			} catch (e) { /* 静默 */ }
		}
		function opsTick() {
			try {
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return;   // 隐藏页暂停
				opsPollCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
				const ctrl = opsPollCtrl;
				fetch("/dsh-memory/ops.json?since=" + encodeURIComponent(String(opsLastTs)), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
					.then((r) => (r && r.ok ? r.json() : null))
					.then((j) => {
						if (!j || j.ok !== true || !Array.isArray(j.ops)) return;
						for (const op of j.ops) {
							const ts = Number(op && op.ts) || 0;
							if (ts > opsLastTs) opsLastTs = ts;
							opsEnqueue(op);
						}
					})
					.catch(() => { /* 静默：旧版桌面端/无 webServer 一律无提示 */ });
			} catch (e) { /* 静默 */ }
		}
		function startOpsPolling() {
			if (opsStarted) return;
			opsStarted = true;
			if (!opsLastTs) opsLastTs = Date.now();   // 只看页面加载后的新操作（不把历史 50 条一次弹完）
			opsTick();
			opsPollTimer = setInterval(opsTick, OPS_POLL_MS);
			try {
				if (typeof document !== "undefined" && document.addEventListener) {
					document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "hidden") opsTick(); });
				}
			} catch (e) { /* 忽略 */ }
		}
		function stopOpsPolling() {
			opsStarted = false;
			try { clearInterval(opsPollTimer); } catch (e) { /* 忽略 */ }
			opsPollTimer = null;
			try { opsPollCtrl && opsPollCtrl.abort(); } catch (e) { /* 忽略 */ }
			opsPollCtrl = null;
		}
		// shell.overlay（kind:"list"）：一次注册、常驻；队列里没东西时返回 null（不占位、不遮挡 chat）
		function MemoryOpsToast() {
			if (!primitives || typeof primitives.Toast !== "function") return null;
			const [item, setItem] = react.useState(opsActive);
			react.useEffect(() => {
				const fn = () => setItem(opsActive);
				opsListeners.add(fn);
				fn();
				return () => { opsListeners.delete(fn); };
			}, []);
			if (!item) return null;
			return react.createElement(primitives.Toast, {
				key: String(item.seq || item.at),
				text: opsItemText(item),
				holdMs: OPS_HOLD_MS,
				onDone: () => { opsDone(); }
			});
		}
		function apply(ctx) {
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
			// [header-memory-indicator 2026-11-07] 会话标题栏动作区（slot scope:session，props 带 sessionId）
			//   id 必须唯一（契约 registerOptions 要求），order 小、排在 shipped actions 之后，不抢标题。
			try {
				ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "dsh-memory-status",
					order: 20,
					label: "记忆状态"
				}, HeaderMemoryIndicator));
			} catch (eHeader) {
				console.warn("[dsh-memory-client] 标题栏记忆状态注册失败（忽略，不影响设置页）:", eHeader && eHeader.message ? eHeader.message : String(eHeader));
			}

			// [memory-ops-toast 2026-11-08] shell.overlay（kind:"list"）：记忆操作 Toast 常驻浮层
			try {
				if (primitives && typeof primitives.Toast === "function") ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-memory-ops-toast"
				}, MemoryOpsToast));
			} catch (eToast) {
				console.warn("[dsh-memory-client] 记忆操作 Toast 注册失败（忽略，不影响设置页/标题栏）:", eToast && eToast.message ? eToast.message : String(eToast));
			}
			// 轮询 ops.json（2s；隐藏页暂停；apply 卸载时清 timer）
			try { ctx.effect(() => { startOpsPolling(); return () => { stopOpsPolling(); }; }); } catch (ePoll) { /* 静默 */ }

			console.log("[dsh-memory-client] 设置行已注册（设置 → 通用设置 → 记忆）");
		}

		// [memory-ops-toast] 自测钩子（纯内存队列，生产行为不变；仅供 test/_memory-toast-selftest.mjs）
		exports.__opsTest = {
			enqueue: opsEnqueue,
			queue: opsQueue,
			active: () => opsActive,
			done: opsDone,
			baseText: opsBaseText,
			itemText: opsItemText,
			reset: () => { opsQueue.length = 0; opsActive = null; opsLastTs = 0; },
			mergeMs: OPS_MERGE_MS,
			queueMax: OPS_QUEUE_MAX,
			holdMs: OPS_HOLD_MS,
			pollMs: OPS_POLL_MS
		};

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
