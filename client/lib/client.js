// v1.12.4-client: pad hoisted, lineHeight 22px, overflowWrap break-word
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
					monitorEnabled: true,
					monitorSummary: "",
					initGuideEnabled: true,
					updateCheckEnabled: true,
					onboardSummary: "",
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
						if (typeof next.monitorEnabled === "boolean") d.monitorEnabled = next.monitorEnabled;
						if (typeof next.monitorSummary === "string") d.monitorSummary = next.monitorSummary;
						if (typeof next.initGuideEnabled === "boolean") d.initGuideEnabled = next.initGuideEnabled;
						if (typeof next.updateCheckEnabled === "boolean") d.updateCheckEnabled = next.updateCheckEnabled;
						if (typeof next.onboardSummary === "string") d.onboardSummary = next.onboardSummary;
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

		const inject = ["slots", "settingsScope"];

		// 通用设置 → 记忆（一行一项：每个配置项独立一行，左标签右控件 + 分割线）
		function MemorySettingsRow(props) {
			const { useStore, setStaleSessionDays, setStaleAction, setIntegrateEnabled, setIntegrateDays, setMonitorEnabled, setInitGuideEnabled, setUpdateCheckEnabled } = props;
			const days = useStore((s) => s.staleSessionDays);
			const action = useStore((s) => s.staleAction);
			const integrateEnabled = useStore((s) => s.integrateEnabled);
			const integrateDays = useStore((s) => s.integrateDays);
			const staleCount = useStore((s) => s.staleCount);
			const monitorEnabled = useStore((s) => s.monitorEnabled);
			const monitorSummary = useStore((s) => s.monitorSummary);
			const initGuideEnabled = useStore((s) => s.initGuideEnabled);
			const updateCheckEnabled = useStore((s) => s.updateCheckEnabled);
			const onboardSummary = useStore((s) => s.onboardSummary);
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
				// v1.12.18：漏网动作与 /dream 的联动说明（随选中值变化）
				react.createElement("div", { style: Object.assign({}, descStyle, { padding: "0 0 10px", marginTop: "-4px" }) },
					action === "silent"
						? "silent：后台自动归档漏网会话；/dream 会先归档再整合，一条命令完成。"
						: action === "approval"
							? "approval：检测到漏网仅提醒，你确认调用 stale_archive 后才归档；此模式下 /dream 不含归档。"
							: "remind：仅提醒不自动归档；此模式下 /dream 不含归档。"),
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
				),
				// v2.3.3 行：版本与记忆库状态（只读，宿主 pushOnboardSummary 写入）
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: { width: "100%" } },
						react.createElement("div", { style: labelStyle }, "版本与记忆库"),
						react.createElement("div", { style: { fontSize: "13px", lineHeight: "22px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "pre-wrap", overflowWrap: "break-word" } },
							onboardSummary || "读取中…（说「初始化记忆」可立即开始引导；/memory-update 可立即查新版）"
						)
					)
				),
				// 行：新装初始化引导开关
				itemRow("初始化引导",
					react.createElement("input", {
						type: "checkbox", checked: !!initGuideEnabled,
						title: "记忆库未初始化/不完整时，自动在会话里引导模型带你完成初始化（一天最多提一次）。关掉后仍可用 /memory-init 手动开始",
						style: { width: "16px", height: "16px", cursor: "pointer" },
						onChange: (e) => setInitGuideEnabled(e.target.checked)
					})
				),
				// 行：检查新版开关
				itemRow("检查新版",
					react.createElement("input", {
						type: "checkbox", checked: !!updateCheckEnabled,
						title: "每天最多一次向发布源核对 version.txt，有新版本在会话里提示一次；离线/内网失败静默。内网可把 DSH_MEMORY_RAW 指向镜像",
						style: { width: "16px", height: "16px", cursor: "pointer" },
						onChange: (e) => setUpdateCheckEnabled(e.target.checked)
					})
				),
				// 行：使用监控开关
				itemRow("使用监控",
					react.createElement("input", {
						type: "checkbox", checked: !!monitorEnabled,
						title: "记录提醒/查询/错误事件到 .monitor.json，设置界面显示汇总；用于使用一段时间后优化",
						style: { width: "16px", height: "16px", cursor: "pointer" },
						onChange: (e) => setMonitorEnabled(e.target.checked)
					})
				),
				// 行：监控统计（只读汇总）—— 垂直布局（label 在上、内容在下），避免横向 flex 挤压重叠
				react.createElement("div", { style: rowStyle },
					react.createElement("div", { style: { width: "100%" } },
						react.createElement("div", { style: labelStyle }, "记忆使用统计"),
						react.createElement("div", { style: { fontSize: "13px", lineHeight: "22px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "pre-wrap", overflowWrap: "break-word", marginTop: "4px" } },
							monitorSummary || "暂无统计（使用记忆/触发提醒后更新）"
						)
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
					setIntegrateDays: (value) => { if (scope) scope.set("integrateDays", value); },
					setMonitorEnabled: (value) => { if (scope) scope.set("monitorEnabled", value); },
					setInitGuideEnabled: (value) => { if (scope) scope.set("initGuideEnabled", value); },
					setUpdateCheckEnabled: (value) => { if (scope) scope.set("updateCheckEnabled", value); }
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
