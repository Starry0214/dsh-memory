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
					staleSessionDays: 5,
					staleAction: "remind",
					integrateEnabled: false,
					integrateDays: 7,
					staleCount: 0,
					monitorEnabled: true,
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
						if (typeof next.staleSessionDays === "number") d.staleSessionDays = next.staleSessionDays;
						if (typeof next.staleAction === "string") d.staleAction = next.staleAction;
						if (typeof next.integrateEnabled === "boolean") d.integrateEnabled = next.integrateEnabled;
						if (typeof next.integrateDays === "number") d.integrateDays = next.integrateDays;
						if (typeof next.staleCount === "number") d.staleCount = next.staleCount;
						if (typeof next.monitorEnabled === "boolean") d.monitorEnabled = next.monitorEnabled;
						if (typeof next.monitorSummary === "string") d.monitorSummary = next.monitorSummary;
						d.status = next.status || "ready";
						d.revision = revision;
					}
				}
			});
		}

		// 漏网处理动作选项（对齐原生 Menu 的 items 结构）
		const ACTION_OPTIONS = [
			{ id: "remind", label: "仅提醒·dream不含归档" },
			{ id: "silent", label: "静默归档·dream全包" },
			{ id: "approval", label: "审批归档·dream不含" }
		];
		const ACTION_LABEL = { remind: "仅提醒", silent: "静默归档", approval: "审批后归档" };

		// [2026-09-23 dsh 升级适配] settingsScope 服务已被删除，改用 configForms
		const inject = ["slots", "configForms"];

		// 通用设置 → 记忆（一行一项：每个配置项独立一行，左标签右控件 + 分割线）
		function MemorySettingsRow(props) {
			const { useStore, setConfigField } = props;
			// [2026-09-23 真机实测修复] 槽框架**不把 store 的 actions 注入 props**（只给 useStore/store + injected() 的返回值），
			//   原写法 setDaysDraft/clearDaysDraft/setSaveState 实为 undefined ⇒ onChange/onBlur 抛
			//   "TypeError: setDaysDraft is not a function"（浏览器现场捕获）⇒ 输入框永远弹回，一个字都敲不进去。
			//   改为组件内 useState 草稿态，不再依赖框架注入约定。
			const [draft, setDraftRaw] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [errMsg, setErrMsg] = react.useState("");
			const setDaysDraft = (text) => { setDraftRaw(text); setErrMsg(""); };
			const clearDaysDraft = () => setDraftRaw(null);
			const setSaveState = (s, e) => { setSaving(!!s); setErrMsg(e || ""); };
			const days = useStore((s) => s.staleSessionDays);
			const action = useStore((s) => s.staleAction);
			const integrateEnabled = useStore((s) => s.integrateEnabled);
			const integrateDays = useStore((s) => s.integrateDays);
			const staleCount = useStore((s) => s.staleCount);
			const monitorEnabled = useStore((s) => s.monitorEnabled);
			const status = useStore((s) => s.status);
			// [2026-09-23] 草稿/保存中/错误一律取组件本地态（原先读 store actions，实测未注入，全部 undefined）
			const daysDraft = draft;
			const daysSaving = saving;
			const configError = errMsg;

			// [2026-09-23] 漏网天数提交：仅接受 1~90 整数；非法或写入失败一律**保留用户输入**并提示，
			//   绝不静默回退旧值（旧实现的"静默丢弃"正是用户看到"填不进去"的直接原因）。
			const commitDays = (text) => {
				const v = parseInt(String(text).trim(), 10);
				if (Number.isNaN(v) || v < 1 || v > 90) {
					setSaveState(false, "请输入 1~90 之间的整数");
					return;
				}
				if (v === days) { clearDaysDraft(); setSaveState(false, ""); return; }
				setSaveState(true, "");
				Promise.resolve(setConfigField("staleSessionDays", v)).then((r) => {
					const ok = r && r.ok === true;
					if (!ok) setSaveState(false, "保存失败：" + ((r && r.error) || "宿主未接受本次写入"));
					else { clearDaysDraft(); setSaveState(false, ""); }
				}).catch((err) => {
					setSaveState(false, "保存失败：" + (err && err.message ? err.message : String(err)));
				});
			};

			// 每行：水平 flex + 下方分割线（对齐 DSH 原生行）
			const rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "12px 0", display: "flex", width: "100%" };
			const labelStyle = { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" };
			const titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 500, lineHeight: "22px" };
			const descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: 400, lineHeight: "18px" };
			const inputStyle = { width: "56px", height: "36px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "18px", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", padding: "0 12px", font: "inherit", textAlign: "center" };
			const segStyle = { height: "36px", border: "1px solid var(--dsw-alias-border-l2)", font: "inherit", color: "var(--dsw-alias-label-primary)", cursor: "pointer", background: "0 0", borderRadius: "18px", padding: "0 14px", fontSize: "13px", lineHeight: "22px", display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" };
			const segSelected = { background: "var(--dsw-alias-state-business-tertiary)", color: "var(--dsw-alias-state-business-primary)", borderColor: "transparent" };

			// 一行：标签（左）+ 控件（右）
			const itemRow = (label, controls) =>
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: labelStyle }, label),
					controls
				);

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", width: "100%" } },
				// 标题行 + 统计
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: { flex: 1, minWidth: 0 } },
						react.createElement("div", { style: titleStyle },
							"记忆（dsh-memory）",
							status === "unavailable" ? "（设置不可用）" : ""
						),
						react.createElement("div", { style: descStyle },
							(staleCount > 0
								? "⚠️ 有 " + staleCount + " 个会话未整合记忆（最后交互在插件启用后、且超过检测天数未落档）。"
								: "超过检测天数未交互且未在记忆库落档的会话，将触发漏网提醒。")
						)
					)
				),
				// 行：漏网检测天数
				itemRow("漏网会话检测天数",
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
						// [2026-09-23 修复] 原为受控直写：onChange 里校验，删空时 parseInt("")=NaN 被拒 →
						//   输入框立刻弹回旧值，第一个字符都敲不进去。改为「本地草稿 + 失焦/回车提交」：
						//   编辑期间只存草稿（允许空串中间态），提交失败**保留用户输入**并提示，不静默回退。
						react.createElement("input", {
							type: "number", min: 1, max: 90, style: inputStyle, title: "漏网会话检测阈值（天）",
							value: daysDraft === null ? String(days) : daysDraft,
							disabled: !!daysSaving,
							onChange: (e) => setDaysDraft(e.target.value),
							onBlur: (e) => commitDays(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); commitDays(e.currentTarget.value); e.currentTarget.blur(); } }
						}),
						react.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" } }, "天")
					)
				),
				// 行：漏网处理动作
				itemRow("漏网处理动作",
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
						ACTION_OPTIONS.map((o) =>
							react.createElement("button", {
								type: "button", key: o.id,
								style: Object.assign({}, segStyle, action === o.id ? segSelected : {}),
								"aria-pressed": action === o.id,
								onClick: () => { Promise.resolve(setConfigField("staleAction", o.id)).then((r) => { if (!(r && r.ok === true)) setSaveState(false, "保存失败：" + ((r && r.error) || "宿主未接受本次写入")); else setSaveState(false, ""); }); }
							}, o.label)
						)
					)
				),
				// v1.12.18：漏网动作与 /dream 的联动说明（随选中值变化）
				react.createElement("div", { style: Object.assign({}, descStyle, { padding: "0 0 10px", marginTop: "-4px" }) },
					action === "silent"
						? "silent：后台自动归档漏网会话；/dream 会先归档再整合，一条命令完成。"
						: action === "approval"
							? "approval：检测到漏网仅提醒，你确认调用 stale_archive 后才归档；此模式下 /dream 不含归档。"
							: "remind：仅提醒不自动归档；此模式下 /dream 不含归档。"),
				// [2026-09-23] 配置保存反馈（失败时显示；成功/未编辑时不占位）
				configError
					? react.createElement("div", { style: Object.assign({}, descStyle, { padding: "0 0 10px", color: "var(--dsw-alias-state-error-primary, #d32f2f)" }) }, "⚠️ " + configError)
					: null,
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
				)
			);
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
			//   loader/schema 层——cordis.patch.yml 的 `staleSessionDays: 5` / `staleAction: remind`，加上
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

			// [2026-09-23 dsh 0.1.7 适配] 只读统计（staleCount）不再进 settings 表单，改走 host 的 stats.json（同源 fetch，30s 节流 + 2 分钟轮询）
			let liveLastAt = 0;
			const syncLiveCount = () => {
				const now = Date.now();
				if (!boundActions || now - liveLastAt < 30000) return;
				liveLastAt = now;
				fetch("/dsh-memory/stats.json", { cache: "no-store" }).then((r) => {
					if (!r.ok) throw new Error("http " + r.status);
					return r.json();
				}).then((j) => {
					if (!boundActions) return;
					const n = j && j.live && typeof j.live.staleCount === "number" ? j.live.staleCount : null;
					if (n === null) return;
					try { boundActions.sync({ staleCount: n }, bump()); } catch (e) {}
				}).catch(() => { /* 面板未挂或无数据时静默 */ });
			};
			setInterval(syncLiveCount, 120000);

			const injected = (actions) => {
				boundActions = actions;
				sync();
				Promise.resolve(fetchConfig()).then(syncLiveCount).catch(() => {});
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
