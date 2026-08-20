window.__ModuleLoader__.load({
	id: "dsh-memory-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let runtime_client = require("@deepseek-ai/dsh-client-runtime/client");

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
					revision: -1,
					status: "loading"
				}),
				actions: {
					sync: (d, next, revision) => {
						if (revision <= d.revision) return;
						d.staleSessionDays = next.staleSessionDays;
						d.staleAction = next.staleAction;
						if (typeof next.integrateEnabled === "boolean") d.integrateEnabled = next.integrateEnabled;
						if (typeof next.integrateDays === "number") d.integrateDays = next.integrateDays;
						if (typeof next.staleCount === "number") d.staleCount = next.staleCount;
						d.status = next.status || "ready";
						d.revision = revision;
					}
				}
			});
		}

		// 漏网处理动作选项（对齐原生 Menu 的 items 结构）
		const ACTION_OPTIONS = [
			{ id: "remind", label: "仅提醒" },
			{ id: "silent", label: "静默子代理" },
			{ id: "approval", label: "审批后子代理" }
		];
		const ACTION_LABEL = { remind: "仅提醒", silent: "静默子代理", approval: "审批后子代理" };

		const inject = ["slots", "settingsScope"];

		// 通用设置 → 记忆（一行一项：每个配置项独立一行，左标签右控件 + 分割线）
		function MemorySettingsRow(props) {
			const { useStore, setStaleSessionDays, setStaleAction, setIntegrateEnabled, setIntegrateDays } = props;
			const days = useStore((s) => s.staleSessionDays);
			const action = useStore((s) => s.staleAction);
			const integrateEnabled = useStore((s) => s.integrateEnabled);
			const integrateDays = useStore((s) => s.integrateDays);
			const staleCount = useStore((s) => s.staleCount);
			const status = useStore((s) => s.status);

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
						react.createElement("input", {
							type: "number", min: 1, max: 90, value: days, style: inputStyle, title: "漏网会话检测阈值（天）",
							onChange: (e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v) && v >= 1 && v <= 90) setStaleSessionDays(v); }
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
								onClick: () => setStaleAction(o.id)
							}, o.label)
						)
					)
				),
				// 行：自动整合（开关 + 间隔）
				itemRow("自动整合记忆",
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
						react.createElement("input", {
							type: "checkbox", checked: !!integrateEnabled,
							title: "每 N 天自动整合记忆（提升/精简/去重，子代理执行）",
							style: { width: "16px", height: "16px", cursor: "pointer" },
							onChange: (e) => setIntegrateEnabled(e.target.checked)
						}),
						react.createElement("input", {
							type: "number", min: 1, max: 90, value: integrateDays, style: inputStyle,
							title: "自动整合间隔（天）", disabled: !integrateEnabled,
							onChange: (e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v) && v >= 1 && v <= 90) setIntegrateDays(v); }
						}),
						react.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" } }, "天/次")
					)
				)
			);
		}
		function apply(ctx) {
			const store = createMemoryStore();
			let revision = 0;
			let boundActions = null;

			let scope;
			try {
				scope = ctx.settingsScope.bind({ namespace: NS });
			} catch (e) {
				console.warn("[dsh-memory-client] settingsScope 绑定失败:", e && e.message ? e.message : String(e));
			}

			// 把 settings 快照同步进 store（store 实例的 boundActions 由 slots 框架经 inject 工厂提供）
			const sync = () => {
				if (!boundActions || !scope) return;
				const snap = scope.getSnapshot();
				const next = Object.assign({}, snap.value || {}, { status: snap.status });
				boundActions.sync(next, revision);
				revision += 1;
			};

			if (scope) {
				scope.subscribe(sync);
			}

			const injected = (actions) => {
				boundActions = actions;
				sync();
				return {
					setStaleSessionDays: (value) => { if (scope) scope.set("staleSessionDays", value); },
					setStaleAction: (value) => { if (scope) scope.set("staleAction", value); },
					setIntegrateEnabled: (value) => { if (scope) scope.set("integrateEnabled", value); },
					setIntegrateDays: (value) => { if (scope) scope.set("integrateDays", value); }
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
