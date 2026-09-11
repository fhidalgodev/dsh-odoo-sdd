/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Replicates the canonical dshmarket client shape:
 *   function apply(ctx)  with  ctx.effect / ctx.locale / ctx.slots.inject /
 *   ctx.inject(["settingsScope"]) .
 * It contributes:
 *   1. a **section** in Settings (slot `settings.section`) — "Odoo SDD",
 *      showing pipeline config and letting the user edit delegation, license
 *      and the mutation allowlist (persisted via the settings namespace);
 *   2. a **card** in Settings → Plugins → Plugin configuration
 *      (slot `settings.plugin.item`), keyed on the `odoo-sdd` namespace.
 *
 * `require("react")` and injected modules are supplied by the host at
 * runtime, so only `dsh plugin add` + a web restart are needed — no webapp
 * rebuild (the dshmarket precedent runs exactly like this).
 */
window.__ModuleLoader__.load({ id: "dsh-odoo-sdd", name: "odoo-sdd", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");
	require("@deepseek-ai/dsh-client-ui-primitives");

	var NS = "odoo-sdd";

	var zh = {
		"nav": "Odoo SDD",
		"connection": "Conexión",
		"delegation": "Delegación",
		"license": "Licencia",
		"allowlist": "Allowlist de mutaciones",
		"save": "Guardar",
		"pipelineHint": "Estado en vivo: usa la tool `sdd_phase status` en la sesión."
	};
	var en = {
		"nav": "Odoo SDD",
		"connection": "Connection",
		"delegation": "Delegation",
		"license": "Licensing",
		"allowlist": "Mutation allowlist",
		"save": "Save",
		"pipelineHint": "Live state: use the `sdd_phase status` tool in the session."
	};

	var pick = function (locales, key) {
		var d = (locales && locales.en) || en;
		return d[key] || en[key] || key;
	};

	/** The settings section body: state + editable delegation/license/allowlist. */
	var SddSection = function (props) {
		var t = props.t;
		var scope = props.scope;
		var snap = (scope && typeof scope.getSnapshot === "function") ? (scope.getSnapshot() || {}) : {};
		var projectRoot = snap.projectRoot || "";
		var specsDir = snap.specsDir || "specs";

		var state = react.useState({ mode: snap.mode || "supervised", licensed: snap.licensed || "community", allowlist: (Array.isArray(snap.executeAllowlist) ? snap.executeAllowlist : []).join(", ") });
		var form = state[0];
		var setForm = state[1];

		if (react.useEffect && scope && typeof scope.subscribe === "function") {
			react.useEffect(function () {
				return scope.subscribe(function () {
					var next = (scope.getSnapshot && scope.getSnapshot()) || {};
					setForm({ mode: next.mode || "supervised", licensed: next.licensed || "community", allowlist: (Array.isArray(next.executeAllowlist) ? next.executeAllowlist : []).join(", ") });
				});
			}, [scope]);
		}

		var canWrite = scope && typeof scope.replace === "function";
		var save = function () {
			if (!canWrite) return;
			var allowVals = (form.allowlist || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
			scope.replace({ mode: form.mode, licensed: form.licensed, executeAllowlist: allowVals, projectRoot: projectRoot, specsDir: specsDir });
		};
		var onChange = function (field) { return function (e) { var n = {}; n[field] = e.target.value; setForm(Object.assign({}, form, n)); }; };

		return react.createElement("div", { style: { flexDirection: "column", gap: 14, padding: "12px 4px 24px", display: "flex" } },
			react.createElement("h3", { style: { margin: 0 } }, t("connection")),
			react.createElement("div", { style: { fontSize: 13, color: "#6b7280" } }, "projectRoot=" + projectRoot + " · specsDir=" + specsDir),
			react.createElement("h3", { style: { margin: 0 } }, t("delegation")),
			react.createElement("select", { value: form.mode, onChange: onChange("mode"), disabled: !canWrite },
				react.createElement("option", { value: "supervised" }, "supervised"),
				react.createElement("option", { value: "autonomous" }, "autonomous")),
			react.createElement("h3", { style: { margin: 0 } }, t("license")),
			react.createElement("select", { value: form.licensed, onChange: onChange("licensed"), disabled: !canWrite },
				react.createElement("option", { value: "enterprise" }, "enterprise"),
				react.createElement("option", { value: "oca" }, "oca"),
				react.createElement("option", { value: "community" }, "community")),
			react.createElement("h3", { style: { margin: 0 } }, t("allowlist")),
			react.createElement("input", { type: "text", value: form.allowlist, onChange: onChange("allowlist"), disabled: !canWrite, placeholder: "sale.order, stock.move", style: { boxSizing: "border-box", width: "100%", padding: "6px 8px" } }),
			react.createElement("button", { onClick: save, disabled: !canWrite, style: { alignSelf: "flex-start" } }, t("save")),
			react.createElement("div", { style: { fontSize: 12, color: "#9ca3af" } }, t("pipelineHint"))
		);
	};

	/** apply(): contribute the section + the config card, market-style. */
	function apply(ctx) {
		try {
			ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, "odoo-sdd: dictionaries");
			var t = ctx.locale.bind(NS);

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
					return react.createElement(SddSection, { t: t });
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
						return react.createElement(SddSection, { t: t });
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
	// Services the host injects into the `ctx` passed to `apply()`. Without
	// this list, `ctx.locale` / `ctx.slots` are unavailable — exactly why
	// apply() failed with "cannot get property locale without inject".
	var inject = ["slots", "locale", "theme"];
	exports.apply = apply;
	exports.inject = inject;
	exports.name = "odoo-sdd";

	return module.exports;
}});