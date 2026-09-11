/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Registers the "Odoo SDD" tab in the Plugins
 * settings section and wires it to the plugin's settings namespace so the
 * user can both see pipeline state and edit delegation/license/allowlist.
 *
 * Packaging mirrors dshmarket: a single self-contained bundle produced with
 * `window.__ModuleLoader__.load({ id, factory })`; `require("react")` and the
 * UI primitives are supplied by the host ModuleLoader at runtime, so no
 * rebuild of the webapp is needed — only `dsh plugin add` + web restart.
 */
window.__ModuleLoader__.load({ id: "dsh-odoo-sdd", name: "odoo-sdd", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;

	// DSH host modules available to browser halves at runtime.
	var react = require("react");
	var primitivesTS = parseInt(require("@deepseek-ai/dsh-client-ui-primitives").version || "0", 10);

	var NS = "odoo-sdd";
	var TAB_ID = "odoo-sdd";
	var name = "odoo-sdd";

	var t = function (key) {
		var dict = {
			"tab.label": "Odoo SDD",
			"sec.connection": "Connection",
			"sec.delegation": "Delegation",
			"sec.license": "Licensing",
			"sec.allowlist": "Mutation allowlist",
			"sec.pipeline": "Pipeline",
			"conn.configured": "configured",
			"conn.needsSetup": "needs setup",
			"conn.needsSecret": "needs secret",
			"conn.skipped": "skipped",
			"conn.unknown": "unknown",
			"mode.autonomous": "autonomous",
			"mode.supervised": "supervised",
			"save": "Save",
			"hint.named": "Selectors persist to the plugin settings."
		};
		return dict[key] || key;
	};

	/** Read current namespace snapshot (mirror) defensively. */
	var readValue = function (scope, field, fallback) {
		try {
			if (scope && typeof scope.getSnapshot === "function") {
				var snap = scope.getSnapshot();
				if (snap && typeof snap === "object" && field in snap) return snap[field];
			}
		} catch (e) { /* fall through */ }
		return fallback;
	};

	/** The Odoo SDD settings tab body. */
	var SddTab = function (props) {
		var scope = props.scope; // SettingsScope<T> when the namespace is served
		var reactUseState = react.useState;
		var reactUseEffect = react.useEffect;

		var snap = (scope && typeof scope.getSnapshot === "function") ? scope.getSnapshot() : {};
		var projectRoot = snap && snap.projectRoot || "";
		var specsDir = snap && snap.specsDir || "specs";
		var executeAllowlist = Array.isArray(snap && snap.executeAllowlist) ? snap.executeAllowlist.slice() : [];

		// Local form state for the editable fields.
		var state = reactUseState ? reactUseState({ mode: snap.mode || "supervised", licensed: snap.licensed || "community", allowlist: executeAllowlist.join(",") }) : null;
		var form = state ? state[0] : { mode: "supervised", licensed: "community", allowlist: "" };
		var setForm = state ? state[1] : function () {};

		// Re-sync local form when the served settings change.
		if (reactUseEffect) {
			reactUseEffect(function () {
				if (scope && typeof scope.subscribe === "function") {
					return scope.subscribe(function () {
						var next = (scope.getSnapshot && scope.getSnapshot()) || {};
						setForm({
							mode: next.mode || "supervised",
							licensed: next.licensed || "community",
							allowlist: (Array.isArray(next.executeAllowlist) ? next.executeAllowlist : []).join(","),
						});
					});
				}
			}, [scope]);
		}

		var save = function () {
			if (!scope || typeof scope !== "function" ? !scope : false) return;
			try {
				if (typeof scope.replace === "function") {
					var allowlistVals = (form.allowlist || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
					scope.replace({
						mode: form.mode,
						licensed: form.licensed,
						executeAllowlist: allowlistVals,
						projectRoot: projectRoot,
						specsDir: specsDir,
					});
				}
			} catch (e) { /* surface-write failure is non-fatal for the tab */ }
		};

		var disabled = !scope || typeof scope !== "object" || typeof scope.replace !== "function";

		var connLabel = { CONFIGURED: t("conn.configured"), NEEDS_SETUP: t("conn.needsSetup"), NEEDS_SECRET: t("conn.needsSecret"), SKIPPED: t("conn.skipped") }[snap && snap.connectionState || ""] || t("conn.unknown");

		return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14, padding: "12px 4px 24px" } },
			react.createElement("h3", { style: { margin: 0 } }, t("sec.connection")),
			react.createElement("div", { style: { fontSize: 13 } }, "State: " + connLabel + "  ·  projectRoot=" + projectRoot + "  ·  specsDir=" + specsDir),
			react.createElement("h3", { style: { margin: 0, marginTop: 6 } }, t("sec.delegation")),
			react.createElement("select", { value: form.mode, onChange: function (e) { setForm(Object.assign({}, form, { mode: e.target.value })); }, disabled: disabled },
				react.createElement("option", { value: "supervised" }, "supervised"),
				react.createElement("option", { value: "autonomous" }, "autonomous")),
			react.createElement("h3", { style: { margin: 0, marginTop: 6 } }, t("sec.license")),
			react.createElement("select", { value: form.licensed, onChange: function (e) { setForm(Object.assign({}, form, { licensed: e.target.value })); }, disabled: disabled },
				react.createElement("option", { value: "enterprise" }, "enterprise"),
				react.createElement("option", { value: "oca" }, "oca"),
				react.createElement("option", { value: "community" }, "community")),
			react.createElement("h3", { style: { margin: 0, marginTop: 6 } }, t("sec.allowlist")),
			react.createElement("div", { style: { fontSize: 12, color: "#6b7280" } }, "Models permitted for odoo_execute mutations (comma-separated)."),
			react.createElement("input", { type: "text", value: form.allowlist, placeholder: "sale.order, stock.move", onChange: function (e) { setForm(Object.assign({}, form, { allowlist: e.target.value })); }, disabled: disabled, style: { boxSizing: "border-box", width: "100%", padding: "6px 8px" } }),
			react.createElement("button", { onClick: save, disabled: disabled, style: { alignSelf: "flex-start" } }, t("save")),
			react.createElement("div", { style: { fontSize: 12, color: "#6b7280" } }, t("sec.pipeline") + " — use the SDD tools (`sdd_phase status`) for the live pipeline/logbook."),
			react.createElement("div", { style: { fontSize: 12, color: "#9ca3af" } }, t("hint.named"))
		);
	};

	/**
	 * apply() registers the tab contribution in the Plugins settings section.
	 * It mirrors the host contract: slots.inject("settings.plugins.tab", ...)
	 * with { id, order, label, inject } then a child slot for the tab content.
	 */
	function apply(id, modules, ctx, env) {
		if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
			try {
				ctx.slots.inject("settings.plugins.tab", function () {
					return ctx.slots.register({
						name: "settings.plugins.tab",
						id: TAB_ID,
						order: 60,
						label: function () { return t("tab.label"); },
						locale: NS,
						inject: function () {
							return { scope: resolveScope(ctx) };
						},
						children: { ["settings.plugins.tab." + TAB_ID]: { kind: "leaf", scope: "root" } }
					}, SddTab);
				});
			} catch (e) {
				// If the slot contract differs, surface the failure instead of
				// crashing the webapp: the tab just won't register.
				if (typeof console !== "undefined") console.error("[dsh-odoo-sdd] tab registration failed:", e);
			}
		}
	}

	/** Resolve the settings scope for our namespace, if the host exposes it. */
	function resolveScope(ctx) {
		try {
			if (ctx && ctx.scopes) return ctx.scopes.get(NS);
			if (ctx && ctx.settingsScope) return ctx.settingsScope.get(NS);
		} catch (e) { /* ignore */ }
		return null;
	}

	exports.REQUIRED_PRIMITIVES = ["@deepseek-ai/dsh-client-ui-primitives"];
	exports.missingPrimitives = function (available) {
		return [];
	};
	exports.name = name;
	exports.apply = apply;

	return module.exports;
}});
