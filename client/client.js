/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Canonical dshmarket-shaped client:
 *   function apply(ctx) with ctx.effect / ctx.locale / ctx.slots.inject /
 *   ctx.inject(["settingsScope"]) / ctx.settingsScope.bind({ namespace }) /
 *   ctx.uiWorkspace.listDirectory (for the local-path folder browser).
 *
 * Contributes the "Odoo SDD" settings section (sidebar) and the matching card
 * in Settings → Plugins → Plugin configuration, both EDITABLE through the
 * bound settings scope (set()) so changes persist to the Host.
 *
 * UI/UX: theme-aware (host --dsw-alias-* tokens, light + dark), accessible
 * (labelled fields, visible focus, aria-live status, modal focus trap), smooth
 * 150-200ms transitions, prefers-reduced-motion respected, no emoji icons.
 */
window.__ModuleLoader__.load({ id: "dsh-odoo-sdd", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");
	var h = react.createElement;

	var NS = "odoo-sdd";

	var zh = {
		"nav": "Odoo SDD",
		"editable": "Editable",
		"readonly": "Solo lectura",
		"readonlyHint": "Este host no expone un settings scope; edita la configuración desde la conversación con odoo_config.",
		"delegation": "Delegación",
		"delegationHint": "Quién aprueba las fases del pipeline.",
		"supervised": "Supervisado",
		"autonomous": "Autónomo",
		"license": "Licencia",
		"licenseHint": "OCA/Comunidad se busca siempre, en ambos casos.",
		"community": "Community",
		"enterprise": "Enterprise",
		"allowlist": "Allowlist de mutaciones",
		"allowlistHint": "Modelos que odoo_execute puede crear/modificar/borrar. Vacío = solo lectura.",
		"repoCommunity": "Repositorio Odoo Community",
		"repoEnterprise": "Repositorio Odoo Enterprise",
		"repoHint": "Elige URL (git) o una ruta local del sistema operativo.",
		"useUrl": "URL",
		"usePath": "Ruta local",
		"browse": "Examinar…",
		"pipeline": "Pipeline",
		"pipelineHint": "Estado en vivo del SDD: usa la tool sdd_phase status en la sesión.",
		"save": "Guardar",
		"saving": "Guardando…",
		"saved": "Cambios guardados",
		"discard": "Descartar",
		"error": "No se pudo guardar",
		"noModels": "Sin modelos permitidos (solo lectura)",
		"pickTitle": "Seleccionar carpeta",
		"pickUp": "Subir",
		"pickHere": "Usar esta carpeta",
		"pickCancel": "Cancelar",
		"pickLoading": "Cargando…",
		"pickEmpty": "Sin subcarpetas",
		"pickPath": "Ruta",
		"pickGo": "Ir",
		"pickClose": "Cerrar",
		"pickError": "No se pudo listar la carpeta",
		"pickUnavailable": "El explorador del host no está disponible"
	};
	var en = {
		"nav": "Odoo SDD",
		"editable": "Editable",
		"readonly": "Read only",
		"readonlyHint": "This host exposes no settings scope; edit the configuration from the conversation with odoo_config.",
		"delegation": "Delegation",
		"delegationHint": "Who approves the pipeline phases.",
		"supervised": "Supervised",
		"autonomous": "Autonomous",
		"license": "Licensing",
		"licenseHint": "OCA/Community is always searched, in both cases.",
		"community": "Community",
		"enterprise": "Enterprise",
		"allowlist": "Mutation allowlist",
		"allowlistHint": "Models odoo_execute may create/write/unlink. Empty = read-only.",
		"repoCommunity": "Odoo Community repository",
		"repoEnterprise": "Odoo Enterprise repository",
		"repoHint": "Pick a git URL or a local operating-system path.",
		"useUrl": "URL",
		"usePath": "Local path",
		"browse": "Browse…",
		"pipeline": "Pipeline",
		"pipelineHint": "Live SDD state: use the sdd_phase status tool in the session.",
		"save": "Save",
		"saving": "Saving…",
		"saved": "Changes saved",
		"discard": "Discard",
		"error": "Could not save",
		"noModels": "No models allowed (read-only)",
		"pickTitle": "Select folder",
		"pickUp": "Up",
		"pickHere": "Use this folder",
		"pickCancel": "Cancel",
		"pickLoading": "Loading…",
		"pickEmpty": "No subfolders",
		"pickPath": "Path",
		"pickGo": "Go",
		"pickClose": "Close",
		"pickError": "Could not list the folder",
		"pickUnavailable": "The host folder browser is unavailable"
	};

	/** Theme-aware stylesheet, injected once. Uses host tokens with fallbacks. */
	var CSS = [
		".odoo-sdd-root{display:flex;flex-direction:column;gap:10px;padding:4px 4px 24px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.5}",
		".odoo-sdd-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}",
		".odoo-sdd-h1{margin:0;font-size:15px;font-weight:600}",
		".odoo-sdd-badge{font-size:11px;font-weight:600;border-radius:6px;padding:2px 8px;white-space:nowrap}",
		".odoo-sdd-badge--on{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent)}",
		".odoo-sdd-badge--off{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 12%,transparent)}",
		".odoo-sdd-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:12px 14px;transition:border-color .18s cubic-bezier(.16,1,.3,1)}",
		".odoo-sdd-card:hover{border-color:var(--dsw-alias-border-l3,#d9dde3)}",
		".odoo-sdd-title{margin:0 0 2px;font-size:13px;font-weight:600}",
		".odoo-sdd-sub{margin:0 0 6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
		".odoo-sdd-field{display:flex;flex-direction:column;gap:5px;margin-top:8px}",
		".odoo-sdd-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
		".odoo-sdd-input,.odoo-sdd-select{box-sizing:border-box;width:100%;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-layer-3,#fff);border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;transition:border-color .15s,box-shadow .15s}",
		".odoo-sdd-input:hover:not(:disabled),.odoo-sdd-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#b8bec7)}",
		".odoo-sdd-input:focus-visible,.odoo-sdd-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4f6ef7);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 22%,transparent)}",
		".odoo-sdd-input:disabled,.odoo-sdd-select:disabled{opacity:.6;cursor:not-allowed}",
		".odoo-sdd-input--mono{font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace);font-size:12px}",
		".odoo-sdd-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
		".odoo-sdd-seg-btn{font:inherit;font-size:12px;padding:5px 12px;min-height:30px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:background .15s,color .15s}",
		".odoo-sdd-seg-btn:hover:not(:disabled):not(.is-on){color:var(--dsw-alias-label-primary,#1f2328)}",
		".odoo-sdd-seg-btn.is-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}",
		".odoo-sdd-seg-btn:disabled{opacity:.55;cursor:not-allowed}",
		".odoo-sdd-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
		".odoo-sdd-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
		".odoo-sdd-chip{font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);font-size:11px;padding:1px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}",
		".odoo-sdd-btn{font:inherit;font-size:13px;padding:7px 16px;min-height:34px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s}",
		".odoo-sdd-btn--primary{background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-layer-1,#fff);font-weight:600}",
		".odoo-sdd-btn--primary:hover:not(:disabled){opacity:.88}",
		".odoo-sdd-btn--primary:disabled{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-tertiary,#8b93a1);cursor:not-allowed}",
		".odoo-sdd-btn--ghost{background:transparent;border-color:var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-btn--ghost:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#b8bec7);color:var(--dsw-alias-label-primary,#1f2328)}",
		".odoo-sdd-btn--small{min-height:30px;padding:5px 10px;font-size:12px}",
		".odoo-sdd-btn:disabled{opacity:.55;cursor:not-allowed}",
		".odoo-sdd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px}",
		".odoo-sdd-status{font-size:12px;min-height:16px}",
		".odoo-sdd-status--ok{color:var(--dsw-alias-state-success-primary,#16a34a)}",
		".odoo-sdd-status--err{color:var(--dsw-alias-state-error-primary,#dc2626)}",
		".odoo-sdd-banner{display:flex;flex-direction:column;gap:3px;padding:9px 12px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 22%,transparent)}",
		".odoo-sdd-overlay{position:fixed;inset:0;z-index:10000;background:#00000080;display:flex;align-items:center;justify-content:center;padding:16px}",
		".odoo-sdd-modal{display:flex;flex-direction:column;gap:10px;width:min(560px,100%);max-height:80vh;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:14px 16px}",
		".odoo-sdd-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
		".odoo-sdd-crumbs{display:flex;flex-wrap:wrap;gap:4px;font-size:12px}",
		".odoo-sdd-crumb{background:transparent;border:none;padding:1px 4px;border-radius:4px;color:var(--dsw-alias-brand-primary,#4f6ef7);cursor:pointer;font:inherit;font-size:12px}",
		".odoo-sdd-crumb:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
		".odoo-sdd-crumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
		".odoo-sdd-list{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;min-height:120px;max-height:46vh}",
		".odoo-sdd-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2,#f0f1f3);padding:8px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;transition:background .15s}",
		".odoo-sdd-item:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}",
		".odoo-sdd-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
		".odoo-sdd-empty{padding:14px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px}",
		"@media (prefers-reduced-motion:reduce){.odoo-sdd-card,.odoo-sdd-input,.odoo-sdd-btn,.odoo-sdd-seg-btn,.odoo-sdd-item{transition:none}}"
	].join("");

	function injectCss() {
		try {
			if (typeof document === "undefined" || document.getElementById("odoo-sdd-css")) return;
			var el = document.createElement("style");
			el.id = "odoo-sdd-css";
			el.textContent = CSS;
			document.head.appendChild(el);
		} catch (e) { /* styling is non-fatal */ }
	}

	/** Current, normalized snapshot of our namespace (defensive). */
	function readSnap(scope) {
		var s = {};
		try { s = (scope && typeof scope.getSnapshot === "function") ? (scope.getSnapshot() || {}) : {}; } catch (e) { s = {}; }
		var asStr = function (v, fb) { return typeof v === "string" ? v : fb; };
		var asList = function (v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : []; };
		var lic = asStr(s.licensed, "community");
		if (lic !== "enterprise") lic = "community";
		return {
			autonomy: asStr(s.autonomy, "supervised"),
			licensed: lic,
			executeAllowlist: asList(s.executeAllowlist),
			communityRepoUrl: asStr(s.communityRepoUrl, "https://github.com/odoo/odoo"),
			communityRepoPath: asStr(s.communityRepoPath, ""),
			enterpriseRepoUrl: asStr(s.enterpriseRepoUrl, "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asStr(s.enterpriseRepoPath, "")
		};
	}

	function toForm(snap) {
		return {
			autonomy: snap.autonomy,
			licensed: snap.licensed,
			allowlist: snap.executeAllowlist.join(", "),
			communityUse: snap.communityRepoPath ? "path" : "url",
			communityUrl: snap.communityRepoUrl,
			communityPath: snap.communityRepoPath,
			enterpriseUse: snap.enterpriseRepoPath ? "path" : "url",
			enterpriseUrl: snap.enterpriseRepoUrl,
			enterprisePath: snap.enterpriseRepoPath
		};
	}

	var SectionCard = function (props) {
		return h("section", { className: "odoo-sdd-card" },
			h("h3", { className: "odoo-sdd-title" }, props.title),
			props.hint ? h("p", { className: "odoo-sdd-sub" }, props.hint) : null,
			props.children);
	};

	/** Modal folder browser backed by the host directory service. */
	var DirPicker = function (props) {
		var t = props.t;
		var listDirectory = props.listDirectory;
		var st = react.useState({ path: props.initialPath || "", listing: null, loading: true, error: null, draft: props.initialPath || "" });
		var s = st[0];
		var set = st[1];

		var load = function (path) {
			if (typeof listDirectory !== "function") { set(function (v) { return Object.assign({}, v, { loading: false, error: t("pickUnavailable") }); }); return; }
			set(function (v) { return Object.assign({}, v, { loading: true, error: null }); });
			Promise.resolve().then(function () { return listDirectory(path || undefined); }).then(function (listing) {
				set(function (v) { return Object.assign({}, v, { listing: listing, loading: false, path: (listing && listing.path) || path || "", draft: (listing && listing.path) || path || "", error: null }); });
			}).catch(function (e) {
				set(function (v) { return Object.assign({}, v, { loading: false, error: (e && e.message) || t("pickError") }); });
			});
		};

		if (react.useEffect) {
			react.useEffect(function () { load(props.initialPath || ""); }, []);
			// Close on Escape for keyboard users.
			react.useEffect(function () {
				var onKey = function (ev) { if (ev.key === "Escape") props.onClose(); };
				if (typeof document !== "undefined") document.addEventListener("keydown", onKey);
				return function () { if (typeof document !== "undefined") document.removeEventListener("keydown", onKey); };
			}, []);
		}

		var listing = s.listing || {};
		var entries = Array.isArray(listing.entries) ? listing.entries : [];
		var crumbs = Array.isArray(listing.crumbs) ? listing.crumbs : [];
		var home = listing.home || null;

		var pickHere = function () { props.onPick(s.path); };

		return h("div", { className: "odoo-sdd-overlay", role: "dialog", "aria-modal": "true", "aria-label": t("pickTitle"), onClick: function (ev) { if (ev.target === ev.currentTarget) props.onClose(); } },
			h("div", { className: "odoo-sdd-modal" },
				h("div", { className: "odoo-sdd-modal-head" },
					h("h3", { className: "odoo-sdd-h1" }, t("pickTitle")),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: props.onClose }, t("pickClose"))),

				h("div", { className: "odoo-sdd-crumbs" },
					home ? h("button", { type: "button", className: "odoo-sdd-crumb", onClick: function () { load(home); } }, "~") : null,
					crumbs.map(function (c, i) {
						return h("button", { key: (c && c.path) || i, type: "button", className: "odoo-sdd-crumb", onClick: function () { load(c.path); } },
							(i > 0 ? " / " : "") + ((c && c.name) || (c && c.path) || ""));
					})),

				h("div", { className: "odoo-sdd-row" },
					h("label", { className: "odoo-sdd-label", htmlFor: "odoo-sdd-pick-path" }, t("pickPath")),
					h("input", {
						id: "odoo-sdd-pick-path", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono",
						style: { flex: "1 1 240px" }, value: s.draft, spellCheck: false, autoComplete: "off",
						onChange: function (ev) { var val = ev.target.value; set(function (v) { return Object.assign({}, v, { draft: val }); }); },
						onKeyDown: function (ev) { if (ev.key === "Enter") load(s.draft); }
					}),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: function () { load(s.draft); } }, t("pickGo")),
					crumbs.length > 1 ? h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: function () { var up = crumbs[crumbs.length - 2]; load((up && up.path) || home || ""); } }, t("pickUp")) : null),

				h("div", { className: "odoo-sdd-list" },
					s.loading ? h("div", { className: "odoo-sdd-empty" }, t("pickLoading"))
						: s.error ? h("div", { className: "odoo-sdd-empty", style: { color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, s.error)
							: entries.length === 0 ? h("div", { className: "odoo-sdd-empty" }, t("pickEmpty"))
								: entries.map(function (en, i) {
									var name = (en && en.name) || "";
									var p = (en && en.path) || "";
									return h("button", { key: p || name || i, type: "button", className: "odoo-sdd-item", title: p, onClick: function () { load(p); }, onDoubleClick: function () { props.onPick(p); } },
										h("span", { style: { fontFamily: "var(--dsw-alias-font-mono,ui-monospace,monospace)", fontSize: "12px" } }, name));
								})),

				h("div", { className: "odoo-sdd-actions" },
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--primary", disabled: !s.path || Boolean(s.error), onClick: pickHere }, t("pickHere")),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost", onClick: props.onClose }, t("pickCancel"))))
		);
	};

	var SddSection = function (props) {
		var t = props.t;
		var scope = props.scope;
		var prefix = props.idPrefix || "odoo-sdd";
		var listDirectory = props.listDirectory;
		var pickDirectory = props.pickDirectory;
		var canWrite = Boolean(scope) && typeof scope === "object" && typeof scope.set === "function";

		var st = react.useState(function () { return { form: toForm(readSnap(scope)), dirty: false, status: "idle", picker: null }; });
		var model = st[0];
		var setModel = st[1];
		var form = model.form;

		if (react.useEffect && scope && typeof scope.subscribe === "function") {
			react.useEffect(function () {
				return scope.subscribe(function () {
					setModel(function (m) { return Object.assign({}, m, { form: toForm(readSnap(scope)), dirty: false, status: "idle" }); });
				});
			}, [scope]);
		}

		var edit = function (patch) {
			setModel(function (m) { return { form: Object.assign({}, m.form, patch), dirty: true, status: "idle", picker: m.picker }; });
		};
		var onField = function (name) { return function (e) { var p = {}; p[name] = e.target.value; edit(p); }; };

		var persist = function () {
			if (!canWrite) return;
			var snap = readSnap(scope);
			var parseList = function (v) { return String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
			var target = {
				autonomy: form.autonomy,
				licensed: form.licensed,
				executeAllowlist: parseList(form.allowlist),
				communityRepoUrl: form.communityUse === "url" ? form.communityUrl : "",
				communityRepoPath: form.communityUse === "path" ? form.communityPath : "",
				enterpriseRepoUrl: form.enterpriseUse === "url" ? form.enterpriseUrl : "",
				enterpriseRepoPath: form.enterpriseUse === "path" ? form.enterprisePath : ""
			};
			var ops = [];
			Object.keys(target).forEach(function (k) {
				var before = Array.isArray(snap[k]) ? snap[k].join(",") : String(snap[k]);
				var after = Array.isArray(target[k]) ? target[k].join(",") : String(target[k]);
				if (before !== after) ops.push([k, target[k]]);
			});
			if (ops.length === 0) { setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved" }); }); return; }
			setModel(function (m) { return Object.assign({}, m, { status: "saving" }); });
			Promise.all(ops.map(function (pair) { return scope.set(pair[0], pair[1]); })).then(function () {
				setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved" }); });
			}).catch(function () {
				setModel(function (m) { return Object.assign({}, m, { status: "error" }); });
			});
		};

		var seg = function (name, value, options) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				options.map(function (o) {
					return h("button", {
						key: o.value, type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.value ? " is-on" : ""),
						"aria-pressed": value === o.value,
						onClick: function () { var p = {}; p[name] = o.value; edit(p); }
					}, o.label);
				}));
		};

		var repo = function (which) {
			var use = form[which + "Use"];
			var urlVal = form[which + "Url"];
			var pathVal = form[which + "Path"];
			var id = prefix + "-" + which;
			var onToggle = function (next) { var p = {}; p[which + "Use"] = next; edit(p); };
			var onVal = function (e) { var p = {}; p[which + (use === "url" ? "Url" : "Path")] = e.target.value; edit(p); };
			// Prefer the host-native chooser (works when the composed picker
			// serves "native"); fall back to the in-app listing dialog when the
			// composition serves "browse" instead.
			var canNative = typeof pickDirectory === "function";
			var canBrowseInApp = typeof listDirectory === "function";
			var canBrowse = use === "path" && canWrite && (canNative || canBrowseInApp);
			var doBrowse = function () {
				var setPath = function (chosen) {
					if (!chosen) return;
					var p = {};
					p[which + "Use"] = "path";
					p[which + "Path"] = chosen;
					edit(p);
				};
				if (canNative) {
					Promise.resolve().then(function () { return pickDirectory(); }).then(function (chosen) {
						if (chosen) setPath(chosen);
						// null = the operator cancelled the OS dialog: do nothing.
					}).catch(function () {
						// Native unavailable (remote browser, no OS chooser): try
						// the in-app listing dialog, else surface the failure.
						if (canBrowseInApp) setModel(function (m) { return Object.assign({}, m, { picker: { which: which } }); });
						else setModel(function (m) { return Object.assign({}, m, { status: "error" }); });
					});
					return;
				}
				setModel(function (m) { return Object.assign({}, m, { picker: { which: which } }); });
			};
			return h("div", null,
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: id }, use === "url" ? t("useUrl") : t("usePath")),
					h("div", { className: "odoo-sdd-row" },
						h("div", { className: "odoo-sdd-seg", role: "group" },
							["url", "path"].map(function (mode) {
								return h("button", {
									key: mode, type: "button", disabled: !canWrite,
									className: "odoo-sdd-seg-btn" + (use === mode ? " is-on" : ""),
									"aria-pressed": use === mode,
									onClick: function () { onToggle(mode); }
								}, mode === "url" ? t("useUrl") : t("usePath"));
							})),
						h("input", {
							id: id, type: "text", disabled: !canWrite, className: "odoo-sdd-input odoo-sdd-input--mono",
							style: { flex: "1 1 240px" },
							value: use === "url" ? urlVal : pathVal,
							placeholder: use === "url" ? "https://github.com/odoo/odoo" : "/opt/odoo",
							onChange: onVal, spellCheck: false, autoComplete: "off"
						}),
						canBrowse ? h("button", {
							type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small",
							"aria-label": t("browse"),
							onClick: doBrowse
						}, t("browse")) : null)));
		};

		var chips = String(form.allowlist || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
		var status = h("div", {
			className: "odoo-sdd-status" + (model.status === "saved" ? " odoo-sdd-status--ok" : model.status === "error" ? " odoo-sdd-status--err" : ""),
			role: "status", "aria-live": "polite"
		}, model.status === "saved" ? t("saved") : model.status === "error" ? t("error") : model.status === "saving" ? t("saving") : "");

		var pickerNode = null;
		if (model.picker) {
			var which = model.picker.which;
			var initial = form[which + "Path"] || form[which + "Url"] || "";
			pickerNode = h(DirPicker, {
				t: t, listDirectory: listDirectory, initialPath: initial,
				onClose: function () { setModel(function (m) { return Object.assign({}, m, { picker: null }); }); },
				onPick: function (chosen) {
					if (chosen) { var p = {}; p[which + "Use"] = "path"; p[which + "Path"] = chosen; edit(p); }
					setModel(function (m) { return Object.assign({}, m, { picker: null }); });
				}
			});
		}

		return h("div", { className: "odoo-sdd-root" },
			pickerNode,
			h("div", { className: "odoo-sdd-head" },
				h("h2", { className: "odoo-sdd-h1" }, t("nav")),
				h("span", { className: "odoo-sdd-badge " + (canWrite ? "odoo-sdd-badge--on" : "odoo-sdd-badge--off") },
					canWrite ? t("editable") : t("readonly"))),
			!canWrite ? h("div", { className: "odoo-sdd-banner" }, h("span", null, t("readonlyHint"))) : null,

			h(SectionCard, { title: t("delegation"), hint: t("delegationHint") },
				seg("autonomy", form.autonomy, [
					{ value: "supervised", label: t("supervised") },
					{ value: "autonomous", label: t("autonomous") }
				])),

			h(SectionCard, { title: t("license"), hint: t("licenseHint") },
				seg("licensed", form.licensed, [
					{ value: "community", label: t("community") },
					{ value: "enterprise", label: t("enterprise") }
				])),

			h(SectionCard, { title: t("allowlist"), hint: t("allowlistHint") },
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-allow" }, t("allowlist")),
					h("input", { id: prefix + "-allow", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono", value: form.allowlist, disabled: !canWrite, onChange: onField("allowlist"), placeholder: "sale.order, stock.move", spellCheck: false, autoComplete: "off" })),
				h("div", { className: "odoo-sdd-chips" },
					chips.length ? chips.map(function (c) { return h("span", { className: "odoo-sdd-chip", key: c }, c); })
						: h("span", { className: "odoo-sdd-sub" }, t("noModels")))),

			h(SectionCard, { title: t("repoCommunity"), hint: t("repoHint") }, repo("community")),
			h(SectionCard, { title: t("repoEnterprise"), hint: t("repoHint") }, repo("enterprise")),

			h(SectionCard, { title: t("pipeline"), hint: t("pipelineHint") }, null),

			h("div", { className: "odoo-sdd-actions" },
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--primary", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: persist },
					model.status === "saving" ? t("saving") : t("save")),
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: function () { setModel({ form: toForm(readSnap(scope)), dirty: false, status: "idle", picker: null }); } }, t("discard")),
				status)
		);
	};

	function apply(ctx) {
		try {
			ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, "odoo-sdd: dictionaries");
			var t = ctx.locale.bind(NS);
			injectCss();

			ctx.inject(["settingsScope"], function (scoped) {
				var scope = null;
				try {
					if (scoped && scoped.settingsScope && typeof scoped.settingsScope.bind === "function") {
						scope = scoped.settingsScope.bind({ namespace: NS });
					}
				} catch (e) {
					if (typeof console !== "undefined") console.warn("[dsh-odoo-sdd] settings scope bind failed:", e);
					scope = null;
				}

				// Host folder picking (optional): native OS chooser first, then
				// the in-app listing dialog — depending on the composed picker.
				var listDirectory = null;
				var pickDirectory = null;
				try {
					if (ctx.uiWorkspace && typeof ctx.uiWorkspace.listDirectory === "function") {
						listDirectory = function (path) { return ctx.uiWorkspace.listDirectory(path); };
					}
					if (ctx.uiWorkspace && typeof ctx.uiWorkspace.pickDirectory === "function") {
						pickDirectory = function () { return ctx.uiWorkspace.pickDirectory(); };
					}
				} catch (e) { listDirectory = null; pickDirectory = null; }

				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "odoo-sdd",
						order: 60,
						label: function () { return t("nav"); },
						locale: NS,
						inject: function () { return { t: t }; }
					}, function () { return h(SddSection, { t: t, scope: scope, listDirectory: listDirectory, pickDirectory: pickDirectory, idPrefix: "odoo-sdd-sec" }); });
				});

				scoped.slots.inject("settings.plugin.item", function () {
					return scoped.slots.register({
						name: "settings.plugin.item",
						key: NS,
						locale: NS,
						inject: function () { return { t: t }; }
					}, function () { return h(SddSection, { t: t, scope: scope, listDirectory: listDirectory, pickDirectory: pickDirectory, idPrefix: "odoo-sdd-card" }); });
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
			var nm = exports.REQUIRED_PRIMITIVES[i];
			if (!available || !available[nm]) missing.push(nm);
		}
		return missing;
	};
	var inject = ["slots", "locale", "theme", "uiWorkspace"];
	exports.apply = apply;
	exports.inject = inject;
	exports.name = "odoo-sdd";

	return module.exports;
}});