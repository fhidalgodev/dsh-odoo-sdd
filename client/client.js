/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Replicates the canonical dshmarket client shape:
 *   function apply(ctx)  with  ctx.effect / ctx.locale / ctx.slots.inject /
 *   ctx.inject(["settingsScope"]) .
 * It contributes:
 *   1. a **section** in Settings (slot `settings.section`) — "Odoo SDD",
 *   2. a **card** in Settings → Plugins → Plugin configuration
 *      (slot `settings.plugin.item`), keyed on the `odoo-sdd` namespace.
 *
 * The section shows connection / delegation / licensing / allowlist state. It
 * becomes EDITABLE when the host exposes a settings scope for our namespace
 * (set()/replace()); otherwise it renders a polished read-only view with a
 * hint that editing happens in the session (odoo_setup / sdd_phase).
 *
 * `require("react")` and injected modules are supplied by the host at runtime.
 */
window.__ModuleLoader__.load({ id: "dsh-odoo-sdd", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");

	var NS = "odoo-sdd";

	var zh = {
		"nav": "Odoo SDD",
		"connection": "Conexión",
		"delegation": "Delegación",
		"license": "Licencia",
		"allowlist": "Allowlist de mutaciones",
		"save": "Guardar",
		"saved": "Guardado",
		"readonly": "Solo lectura",
		"readonlyHint": "Edita delegación, licencia y allowlist desde la conversación con odoo_setup / sdd_phase.",
		"pipeline": "Pipeline",
		"pipelineHint": "Estado en vivo: usa la tool `sdd_phase status` en la sesión.",
		"connConfigured": "Configurada",
		"connNeedsSetup": "Falta configurar",
		"connNeedsSecret": "Falta credencial",
		"connSkipped": "Sin instancia",
		"connUnknown": "Desconocida",
		"modeSupervised": "Supervisado",
		"modeAutonomous": "Autónomo",
		"licEnterprise": "Enterprise",
		"licOca": "OCA / Comunidad",
		"licCommunity": "Solo comunidad",
		"enterModels": "Modelos (separados por coma)",
		"repoCommunity": "Repositorio Odoo Community",
		"repoEnterprise": "Repositorio Odoo Enterprise",
		"repoUse": "Ruta local",
		"repoUrl": "URL del repositorio",
		"repoPath": "Ruta del sistema operativo",
		"repoUseUrl": "Usar URL",
		"repoUsePath": "Usar ruta local",
		"repoDefault": "(por defecto)"
	};
	var en = {
		"nav": "Odoo SDD",
		"connection": "Connection",
		"delegation": "Delegation",
		"license": "Licensing",
		"allowlist": "Mutation allowlist",
		"save": "Save",
		"saved": "Saved",
		"readonly": "Read only",
		"readonlyHint": "Edit delegation, licensing and allowlist from the conversation with odoo_setup / sdd_phase.",
		"pipeline": "Pipeline",
		"pipelineHint": "Live state: use the `sdd_phase status` tool in the session.",
		"connConfigured": "Configured",
		"connNeedsSetup": "Needs setup",
		"connNeedsSecret": "Needs secret",
		"connSkipped": "No instance",
		"connUnknown": "Unknown",
		"modeSupervised": "Supervised",
		"modeAutonomous": "Autonomous",
		"licEnterprise": "Enterprise",
		"licOca": "OCA / Community",
		"licCommunity": "Community only",
		"enterModels": "Models (comma separated)",
		"repoCommunity": "Odoo Community repository",
		"repoEnterprise": "Odoo Enterprise repository",
		"repoUse": "Local path",
		"repoUrl": "Repository URL",
		"repoPath": "OS path",
		"repoUseUrl": "Use URL",
		"repoUsePath": "Use local path",
		"repoDefault": "(default)"
	};

	var pick = function (locales, key) {
		var d = (locales && locales.en) || en;
		return d[key] || key;
	};

	var STYLE = {
		row: { marginBottom: 4 },
		cardHeader: { fontWeight: 600, fontSize: 13, color: "#1f2328", margin: "0 0 2px" },
		label: { fontSize: 12, color: "#6b7280" },
		hint: { fontSize: 12, color: "#9ca3af" },
		select: { boxSizing: "border-box", width: "100%", padding: "6px 8px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#1f2328", fontSize: 13 },
		input: { boxSizing: "border-box", width: "100%", padding: "6px 8px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#1f2328", fontSize: 13 },
		btn: { background: "#4f6ef7", color: "#fff", border: "none", borderRadius: 7, padding: "6px 14px", fontSize: 13, cursor: "pointer" },
		btnDisabled: { background: "#e5e7eb", color: "#9ca3af", border: "none", borderRadius: 7, padding: "6px 14px", fontSize: 13, cursor: "default" },
		card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", margin: "0 0 10px" },
		readonlyBanner: { background: "#fdf3e3", border: "1px solid #f3e3c3", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#b45309", display: "flex", flexDirection: "column", gap: 4 }
	};

	var statusColor = function (label) {
		// green / amber / red / gray for the connection badge.
		if (label === "connConfigured") return "#16a34a";
		if (label === "connNeedsSecret") return "#b45309";
		if (label === "connNeedsSetup" || label === "connUnknown") return "#dc2626";
		return "#6b7280"; // skipped
	};

	var Badge = function (props) {
		var color = props.color;
		var text = props.text;
		return react.createElement("span", {
			style: {
				display: "inline-flex", alignItems: "center", gap: 6, padding: "1px 8px",
				fontSize: 11, fontWeight: 600, borderRadius: 5, color: "#fff", background: color
			}
		}, text);
	};

	var SectionCard = function (props) {
		var t = props.t; var title = props.title; var children = props.children; var badge = props.badge;
		return react.createElement("div", { style: STYLE.card },
			react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
				react.createElement("span", { style: STYLE.cardHeader }, title),
				badge ? badge : null
			),
			children
		);
	};

	/** The settings section: state + editable-iff-scope delegation/license/allowlist. */
	var SddSection = function (props) {
		var t = props.t;
		var scope = props.scope;
		var snap = {};
		try { snap = (scope && typeof scope.getSnapshot === "function") ? (scope.getSnapshot() || {}) : {}; } catch (e) { snap = {}; }
		var projectRoot = snap.projectRoot || "";
		var specsDir = snap.specsDir || "specs";
		var connLabel = (snap.connectionState || "connUnknown");
		var canWrite = Boolean(scope) && typeof scope === "object" && (typeof scope.set === "function" || typeof scope.replace === "function");

		var state = react.useState({
			mode: snap.mode || "supervised",
			licensed: snap.licensed || "community",
			allowlist: (Array.isArray(snap.executeAllowlist) ? snap.executeAllowlist : []).join(", "),
			communityUse: (snap.communityRepoPath || "") ? "path" : "url",
			communityUrl: snap.communityRepoUrl || "",
			communityPath: snap.communityRepoPath || "",
			enterpriseUse: (snap.enterpriseRepoPath || "") ? "path" : "url",
			enterpriseUrl: snap.enterpriseRepoUrl || "",
			enterprisePath: snap.enterpriseRepoPath || "",
			saved: false
		});
		var form = state[0]; var setForm = state[1];

		if (react.useEffect && scope && typeof scope.subscribe === "function") {
			react.useEffect(function () {
				return scope.subscribe(function () {
					var next = {};
					try { next = (scope.getSnapshot && scope.getSnapshot()) || {}; } catch (e) { next = {}; }
					setForm({
						mode: next.mode || "supervised", licensed: next.licensed || "community",
						allowlist: (Array.isArray(next.executeAllowlist) ? next.executeAllowlist : []).join(", "),
						communityUse: (next.communityRepoPath || "") ? "path" : "url",
						communityUrl: next.communityRepoUrl || "", communityPath: next.communityRepoPath || "",
						enterpriseUse: (next.enterpriseRepoPath || "") ? "path" : "url",
						enterpriseUrl: next.enterpriseRepoUrl || "", enterprisePath: next.enterpriseRepoPath || "",
						saved: false
					});
				});
			}, [scope]);
		}

		var persist = function () {
			if (!canWrite) return;
			var allowVals = (form.allowlist || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
			var done = false;
			var payload = {
				mode: form.mode,
				licensed: form.licensed,
				executeAllowlist: allowVals,
				projectRoot: projectRoot,
				specsDir: specsDir,
				communityRepoUrl: form.communityUse === "url" ? form.communityUrl : "",
				communityRepoPath: form.communityUse === "path" ? form.communityPath : "",
				enterpriseRepoUrl: form.enterpriseUse === "url" ? form.enterpriseUrl : "",
				enterpriseRepoPath: form.enterpriseUse === "path" ? form.enterprisePath : ""
			};
			try {
				if (typeof scope.replace === "function") {
					scope.replace(payload);
					done = true;
				} else if (typeof scope.set === "function") {
					scope.set("mode", form.mode); scope.set("licensed", form.licensed); scope.set("executeAllowlist", allowVals);
					scope.set("communityRepoUrl", payload.communityRepoUrl); scope.set("communityRepoPath", payload.communityRepoPath);
					scope.set("enterpriseRepoUrl", payload.enterpriseRepoUrl); scope.set("enterpriseRepoPath", payload.enterpriseRepoPath);
					done = true;
				}
			} catch (e) { done = false; }
			if (done) setForm(Object.assign({}, form, { saved: true }));
		};

		var onChange = function (field) { return function (e) { var n = {}; n[field] = e.target.value; n.saved = false; setForm(Object.assign({}, form, n)); }; };

		var selectCtl = function (field, value, options, labels) {
			if (!canWrite) {
				var label = labels[value] || value;
				return react.createElement("div", { style: STYLE.label }, label);
			}
			return react.createElement("select", { value: value, onChange: onChange(field), disabled: !canWrite, style: STYLE.select },
				options.map(function (o) { return react.createElement("option", { value: o }, labels[o] || o); }));
		};

		var allowCtl;
		if (!canWrite) {
			var chips = (Array.isArray(snap.executeAllowlist) ? snap.executeAllowlist : []);
			allowCtl = react.createElement("div", {},
				chips.length === 0
					? react.createElement("span", { style: STYLE.hint }, "—")
					: chips.map(function (c) { return react.createElement("code", { style: { background: "#eef0f4", borderRadius: 5, padding: "0 5px", fontSize: 11 } }, c); } )
			);
		} else {
			allowCtl = react.createElement("input", { type: "text", value: form.allowlist, onChange: onChange("allowlist"), disabled: !canWrite, style: STYLE.input, placeholder: "sale.order, stock.move" });
		}

		// One repository configurator: toggle URL vs OS path, edit the active value.
		var repoCtl = function (prefix) {
			var use = form[prefix + "Use"] || "url";
			var urlVal = form[prefix + "Url"] || "";
			var pathVal = form[prefix + "Path"] || "";
			var toggle = function (nextUse) { var n = {}; n[prefix + "Use"] = nextUse; n.saved = false; setForm(Object.assign({}, form, n)); };
			var editVal = function (val) { var n = {}; n[prefix + (use === "url" ? "Url" : "Path")] = val; n.saved = false; setForm(Object.assign({}, form, n)); };

			if (!canWrite) {
				var shown = use === "url" ? urlVal : pathVal;
				return react.createElement("div", { style: STYLE.label }, (use === "url" ? t("repoUseUrl") + ": " + shown : t("repoUsePath") + ": " + shown));
			}

			var rows = [];
			rows.push(react.createElement("div", { style: { display: "flex", gap: 8 } },
				react.createElement("button", { type: "button", onClick: function () { toggle("url"); }, style: use === "url" ? STYLE.btn : STYLE.btnDisabled, disabled: use === "url" }, t("repoUseUrl")),
				react.createElement("button", { type: "button", onClick: function () { toggle("path"); }, style: use === "path" ? STYLE.btn : STYLE.btnDisabled, disabled: use === "path" }, t("repoUsePath"))
			));
			rows.push(react.createElement("input", {
				type: "text", value: use === "url" ? urlVal : pathVal,
				placeholder: use === "url" ? "https://github.com/odoo/odoo" : "/path/to/odoo",
				onChange: function (e) { editVal(e.target.value); },
				disabled: !canWrite, style: STYLE.input
			}));
			return react.createElement("div", { style: { flexDirection: "column", gap: 6, display: "flex" } }, rows);
		};

		var readonlyBanner = canWrite ? null : react.createElement("div", { style: STYLE.readonlyBanner },
			react.createElement("div", { style: { fontWeight: 600 } }, t("readonly")),
			react.createElement("div", { style: { fontSize: 12 } }, t("readonlyHint"))
		);

		var delta = {
			connConfigured: t("connConfigured"), connNeedsSetup: t("connNeedsSetup"),
			connNeedsSecret: t("connNeedsSecret"), connSkipped: t("connSkipped"), connUnknown: t("connUnknown")
		};
		var connText = delta[connLabel] || t("connUnknown");

		return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 20px" } },
			readonlyBanner,
			react.createElement(SectionCard, { t: t, title: t("connection"), badge: react.createElement(Badge, { color: statusColor(connLabel), text: connText }) },
				react.createElement("div", { style: STYLE.label }, "projectRoot=" + (projectRoot || "—") + " · specsDir=" + specsDir)),
			react.createElement(SectionCard, { t: t, title: t("delegation") },
				selectCtl("mode", form.mode, ["supervised", "autonomous"], { supervised: t("modeSupervised"), autonomous: t("modeAutonomous") })),
			react.createElement(SectionCard, { t: t, title: t("license") },
				selectCtl("licensed", form.licensed, ["enterprise", "oca", "community"], { enterprise: t("licEnterprise"), oca: t("licOca"), community: t("licCommunity") })),
			react.createElement(SectionCard, { t: t, title: t("allowlist") },
				react.createElement("div", { style: STYLE.label }, t("enterModels")),
				allowCtl,
				canWrite
					? react.createElement("div", { style: STYLE.row },
						react.createElement("button", { onClick: persist, style: form.saved ? STYLE.btnDisabled : STYLE.btn }, form.saved ? t("saved") : t("save")))
					: null),
			react.createElement(SectionCard, { t: t, title: t("repoCommunity") },
				repoCtl("community")),
			react.createElement(SectionCard, { t: t, title: t("repoEnterprise") },
				repoCtl("enterprise")),
			react.createElement(SectionCard, { t: t, title: t("pipeline") },
				react.createElement("div", { style: STYLE.hint }, t("pipelineHint")))
		);
	};

	/** Resolve the settings scope for NS when the host exposes it. */
	function resolveScope(ctx) {
		try {
			if (ctx && ctx.scopes && typeof ctx.scopes.get === "function") return ctx.scopes.get(NS);
			if (ctx && ctx.settingsScope && typeof ctx.settingsScope.get === "function") return ctx.settingsScope.get(NS);
		} catch (e) { /* no scope exposed -> read-only */ }
		return null;
	}

	function apply(ctx) {
		try {
			ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, "odoo-sdd: dictionaries");
			var t = ctx.locale.bind(NS);
			var scope = resolveScope(ctx);

			// 1) Settings section (sidebar entry under Settings).
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "odoo-sdd",
					order: 60,
					label: function () { return t("nav"); },
					locale: NS,
					inject: function () { return { t: t }; }
				}, function (ownerProps) {
					return react.createElement(SddSection, { t: t, scope: scope });
				});
			});

			// 2) Configurable card in Settings → Plugins → Plugin configuration.
			ctx.inject(["settingsScope"], function (scoped) {
				scoped.slots.inject("settings.plugin.item", function () {
					return scoped.slots.register({
						name: "settings.plugin.item",
						key: NS,
						locale: NS,
						inject: function () { return { t: t }; }
					}, function () {
						// Inside the settingsScope callback the scope for NS is
						// resolvable — use the resolver plus the injected scoped.
						var sc = scoped.get && typeof scoped.get === "function" ? (scoped.get(NS) || scope) : scope;
						return react.createElement(SddSection, { t: t, scope: sc });
					});
				});
			});
		} catch (e) {
			if (typeof console !== "undefined") console.error("[dsh-odoo-sdd] client apply failed:", e);
		}
	}

	exports.REQUIRED_PRIMITIVES = ["@deepseek-ai/dsh-client-ui-primitives"];
	exports.missingPrimitives = function (available) {
		var missing = [];
		for (var i = 0; i < exports.REQUIRED_PRIMITIVES.length; i++) {
			var name = exports.REQUIRED_PRIMITIVES[i];
			if (!available || !available[name]) missing.push(name);
		}
		return missing;
	};
	var inject = ["slots", "locale", "theme"];
	exports.apply = apply;
	exports.inject = inject;
	exports.name = "odoo-sdd";

	return module.exports;
}});