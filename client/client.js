/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Canonical dshmarket-shaped client:
 *   function apply(ctx) with ctx.effect / ctx.locale / ctx.slots.inject /
 *   ctx.configForms.get(NS) / ctx.configForms.whileServed([NS], register) /
 *   ctx.uiWorkspace.listDirectory (for the local-path folder browser).
 *
 * Contributes the "Odoo SDD" settings section (sidebar), EDITABLE through the
 * config form of our namespace (getSnapshot/subscribe to read, set/unset to
 * write) so changes persist to the Host.
 *
 * WHY `configForms` AND NOT `settingsScope`: the host 0.2.0-rc.2 removed the
 * `settingsScope` service, and the section used to be registered INSIDE the
 * callback of `ctx.inject(["settingsScope"], …)`. An inject of a service that
 * does not exist never runs its callback, so the section silently vanished from
 * the sidebar — no error, no panel. `exports.inject` below is what makes
 * `ctx.configForms` resolvable, and its absence is now reported out loud.
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
	"editable": "可编辑",
	"readonly": "只读",
	"readonlyHint": "此宿主不提供配置表单；请在会话中通过 odoo_config 修改设置。",
	"delegation": "委派",
	"delegationHint": "由谁批准流水线的各个阶段。",
	"supervised": "受监督",
	"autonomous": "自主",
	"license": "许可",
	"licenseHint": "无论哪种情况，都会始终搜索 OCA/社区版。",
	"adoptHint": "新会话把项目最近的规范当作提示采用",
	"adoptHintHint": "选择「是」（默认）时，一个还没有自己指针的会话会从项目"
		+ "上次停下的地方继续，只要提示足够新且规范仍然存在。选择「否」时，每个会话在声明之前都没有"
		+ "规范：这样两个会话就永远不能拿对方的规范来授权改动。",
	"licensePerSpec": "Odoo 的版本不是插件设置：它在 CLARIFY 中按规范逐个回答"
		+ "（operation=clarify licensed=community|enterprise），因为同一个工作区可以同时容纳 EE 和 CE "
		+ "项目。不存在工作区级别的版本选择。",
	"community": "社区版",
	"enterprise": "企业版",
	"allowlist": "变更白名单",
	"allowlistHint": "odoo_execute 可以 create/write/unlink 的模型。留空 = 只读。",
	"methods": "业务动作",
	"methodsHint": "功能批次可以调用的 model.method 对：任意模型的任何动作（Odoo 的惯例通常是 action_*、button_*、do_*）。每一对都需要前置条件和后置条件。留空 = 无。",
	"noMethods": "不允许任何业务动作",
	"repoCommunity": "Odoo 社区版仓库",
	"repoEnterprise": "Odoo 企业版仓库",
	"repoHint": "选择 git URL 或本地操作系统路径。",
	"useUrl": "URL",
	"usePath": "本地路径",
	"browse": "浏览…",
	"pipeline": "流水线",
	"pipelineHint": "SDD 实时状态：在会话中使用 sdd_phase status 工具。",
	"policy": "策略",
	"specs": "规范",
	"specsHint": "项目来自本会话中打开的文件夹，因此不在这里配置。请选择规范文档的存放位置。",
	"specsMode": "位置",
	"specsModeProject": "项目内",
	"specsModeCentral": "中央文件夹",
	"specsRoot": "中央规范文件夹",
	"specsSubdir": "项目内的子文件夹",
	"specsProjectResolved": "每个项目把它的规范保存在 <project>/<subfolder>/<spec>。",
	"specsCentralResolved": "每个项目都把规范保存在 <central folder>/<project>/<spec> 下，各自位于自己的子文件夹中，并由一个 .dsh-project-root 文件标识。",
	"manuals": "手册",
	"manualsHint": "odoo_manual 把叙述式手册存放在哪里，以及它产出什么。",
	"manualsMode": "手册位置",
	"manualsSpecs": "与规范同目录",
	"manualsDocs": "文档树",
	"manualsModule": "模块片段",
	"manualsModeHint_specs": "每份手册位于 <specs>/manuals/<manual>，与记录该变更的规范放在一起。这是默认选项，也覆盖没有规范的独立工作：它绝不会因为缺少规范而被阻塞。",
	"manualsModeHint_docs": "每份手册位于项目文档树中的 <project>/<folder>/<manual>（默认为 docs/manuals）。canon 仍然从实例读取；改变的只是文件落地位置。",
	"manualsModeHint_module": "每份手册都是 <module>/readme/manual/<manual> 下的一个 OCA 片段，可与模块的 README 一起编译。每次调用都必须指定 module_dir。",
	"policyHint": "插件的 fail-closed 守卫：在守卫条件满足之前，它会阻止任何变更（实例变更与项目文件编辑）。",
	"docPolicy": "模块文档",
	"docRequired": "必需",
	"docOptional": "可选",
	"docOff": "关闭",
	"docLanguage": "文档语言",
	"docLanguageHint": "留空 = 默认英文，除非 AGENTS.md 或项目的其他文件另有规定。",
	"yes": "是",
	"no": "否",
	"checkpointRequired": "变更前要求创建检查点",
	"specRequired": "每次变更都要求规范",
	"specScope": "在何处询问",
	"specScopeHint": "「仅 Odoo 工作」只在显示出 Odoo 工作的文件夹中询问（保存了状态的 .sdd、__manifest__.py，或者已经在那里用过的某个 Odoo 工具）。「所有位置」则在任何文件夹中都会询问。",
	"scopeOdoo": "仅 Odoo 工作",
	"scopeEverywhere": "所有位置",
	"securityReview": "DONE 前要求安全审查",
	"securityInterview": "要求安全访谈（用户组/ACL）",
	"auditAll": "审计每一次工具调用",
	"maxCheckpoints": "保留的检查点数量",
	"save": "保存",
	"saving": "保存中…",
	"saved": "更改已保存",
	"discard": "丢弃",
	"error": "无法保存",
	"noModels": "没有允许的模型（只读）",
	"pickTitle": "选择文件夹",
	"pickUp": "上一级",
	"pickHere": "使用此文件夹",
	"pickCancel": "取消",
	"pickLoading": "加载中…",
	"pickEmpty": "没有子文件夹",
	"pickPath": "路径",
	"pickGo": "转到",
	"pickClose": "关闭",
	"pickError": "无法列出该文件夹",
	"pickUnavailable": "宿主文件夹浏览器不可用",
};
	var en = {
		"nav": "Odoo SDD",
		"editable": "Editable",
		"readonly": "Read only",
		"readonlyHint": "This host exposes no configuration forms; edit the settings from the conversation with odoo_config.",
		"delegation": "Delegation",
		"delegationHint": "Who approves the pipeline phases.",
		"supervised": "Supervised",
		"autonomous": "Autonomous",
		"license": "Licensing",
		"licenseHint": "OCA/Community is always searched, in both cases.",
		"adoptHint": "A new session adopts the project's last spec as a hint",
		"adoptHintHint": "With Yes (default), a session that has no pointer of its own continues where the project "
			+ "left off, as long as the hint is fresh and the spec still exists. With No, every session starts with "
			+ "no spec until it declares one: two sessions then can never authorize changes against each other's spec.",
		"licensePerSpec": "The Odoo edition is not a plugin setting: it is answered per spec in CLARIFY "
			+ "(operation=clarify licensed=community|enterprise), because one workspace can hold EE and CE "
			+ "projects at the same time. There is no workspace-wide edition.",
		"community": "Community",
		"enterprise": "Enterprise",
		"allowlist": "Mutation allowlist",
		"allowlistHint": "Models odoo_execute may create/write/unlink. Empty = read-only.",
		"methods": "Business actions",
		"methodsHint": "model.method pairs a functional batch may call: any action of any model (Odoo convention is usually action_*, button_*, do_*). Each pair needs a precondition and a postcondition. Empty = none.",
		"noMethods": "No business action allowed",
		"repoCommunity": "Odoo Community repository",
		"repoEnterprise": "Odoo Enterprise repository",
		"repoHint": "Pick a git URL or a local operating-system path.",
		"useUrl": "URL",
		"usePath": "Local path",
		"browse": "Browse…",
		"pipeline": "Pipeline",
		"pipelineHint": "Live SDD state: use the sdd_phase status tool in the session.",
		"policy": "Policy",
		"specs": "Specs",
		"specsHint": "The project comes from the folder open in this session, so it is not configured here. Choose where the spec documents are stored.",
		"specsMode": "Location",
		"specsModeProject": "Inside the project",
		"specsModeCentral": "Central folder",
		"specsRoot": "Central specs folder",
		"specsSubdir": "Subfolder inside the project",
		"specsProjectResolved": "Each project keeps its specs in <project>/<subfolder>/<spec>.",
		"specsCentralResolved": "Every project keeps its specs under <central folder>/<project>/<spec>, each in its own subfolder identified by a .dsh-project-root file.",
		"manuals": "Manuals",
		"manualsHint": "Where odoo_manual keeps the narrated manuals and what it produces.",
		"manualsMode": "Manuals location",
		"manualsSpecs": "Next to the spec",
		"manualsDocs": "Documentation tree",
		"manualsModule": "Module fragments",
		"manualsModeHint_specs": "Each manual lives at <specs>/manuals/<manual>, next to the spec documenting the change. This is the default and also covers standalone work without a spec: it never blocks on a missing one.",
		"manualsModeHint_docs": "Each manual lives at <project>/<folder>/<manual> inside the project's documentation tree (default docs/manuals). The canon is still read from the instance; only where files land changes.",
		"manualsModeHint_module": "Each manual is an OCA fragment at <module>/readme/manual/<manual>, ready to compile with the module's README. Each call must name a module_dir.",
		"policyHint": "Fail-closed plugin guards: the guard blocks every change (instance mutations and project file edits) until they are satisfied.",
		"docPolicy": "Module documentation",
		"docRequired": "Required",
		"docOptional": "Optional",
		"docOff": "Off",
		"docLanguage": "Documentation language",
		"docLanguageHint": "Empty = English by default, unless AGENTS.md or another project file says otherwise.",
		"yes": "Yes",
		"no": "No",
		"checkpointRequired": "Require a checkpoint before mutating",
		"specRequired": "Require a spec for every change",
		"specScope": "Where it is asked",
		"specScopeHint": "\"Odoo work only\" asks the question only in folders that show Odoo work (a .sdd holding state, a __manifest__.py, or an Odoo tool already used there). \"Everywhere\" asks it in any folder.",
		"scopeOdoo": "Odoo work only",
		"scopeEverywhere": "Everywhere",
		"securityReview": "Require the security review before DONE",
		"securityInterview": "Require the security interview (groups/ACL)",
		"auditAll": "Audit every tool call",
		"maxCheckpoints": "Checkpoints to retain",
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
		// A folder name, a language code or a small count does NOT need a
		// full-width box: `.odoo-sdd-input` is width:100% inside a column field,
		// so short values get an explicit, still-responsive cap.
		".odoo-sdd-input--short{width:min(100%,200px)}",
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
		".odoo-sdd-hint{margin-top:6px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:1.45}",
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

	/** Remove the stylesheet this plugin injected (dispose/HMR hygiene). */
	function removeCss() {
		try {
			if (typeof document === "undefined") return;
			var el = document.getElementById("odoo-sdd-css");
			if (el && el.parentNode) el.parentNode.removeChild(el);
		} catch (e) { /* styling is non-fatal */ }
	}

	/** Current, normalized snapshot of our namespace (defensive). */
	/**
	 * Read the config-form snapshot. The snapshot is NOT the section itself:
	 * it is { status, value, base, user, revision, writable, mode } — the
	 * section lives under `value`. Reading the snapshot as if it were the
	 * section yields undefined fields (and therefore composition defaults),
	 * which is why writes appeared "not to persist".
	 *
	 * `form` is the namespace controller from `ctx.configForms.get(NS)`. It
	 * exposes the same read/write face the previous `settingsScope.bind()`
	 * returned (getSnapshot/subscribe/set), which is why only the transport
	 * changed: `status: "unavailable"` still means "the Host does not serve this
	 * namespace", and the section renders read-only in that case.
	 */
	function scopeState(form) {
		var raw = {};
		try { raw = (form && typeof form.getSnapshot === "function") ? (form.getSnapshot() || {}) : {}; } catch (e) { raw = {}; }
		var value = (raw && typeof raw === "object" && raw.value && typeof raw.value === "object") ? raw.value : {};
		return {
			value: value,
			writable: !(raw && raw.writable === false),
			status: (raw && raw.status) || "ready"
		};
	}

	function readSnap(form) {
		var s = scopeState(form).value;
		var asStr = function (v, fb) { return typeof v === "string" ? v : fb; };
		var asList = function (v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : []; };
		var asBool = function (v, fb) { return typeof v === "boolean" ? v : fb; };
		return {
			autonomy: asStr(s.autonomy, "supervised"),
			executeAllowlist: asList(s.executeAllowlist),
			methodAllowlist: asList(s.methodAllowlist),
			projectRoot: asStr(s.projectRoot, ""),
			specsMode: s.specsMode === "central" ? "central" : "project",
			specsRoot: asStr(s.specsRoot, ""),
			specsDir: asStr(s.specsDir, "specs"),
			specPolicyScope: s.specPolicyScope === "everywhere" ? "everywhere" : "odoo",
			communityRepoUrl: asStr(s.communityRepoUrl, "https://github.com/odoo/odoo"),
			communityRepoPath: asStr(s.communityRepoPath, ""),
			enterpriseRepoUrl: asStr(s.enterpriseRepoUrl, "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asStr(s.enterpriseRepoPath, ""),
			requireCheckpointBeforeMutation: asBool(s.requireCheckpointBeforeMutation, true),
			requireSpecForChanges: asBool(s.requireSpecForChanges, true),
			adoptProjectPointerHint: asBool(s.adoptProjectPointerHint, true),
			securityReviewRequired: asBool(s.securityReviewRequired, true),
			securityInterviewRequired: asBool(s.securityInterviewRequired, true),
			auditAllTools: asBool(s.auditAllTools, true),
			maxCheckpoints: typeof s.maxCheckpoints === "number" ? s.maxCheckpoints : 5,
			documentationPolicy: (s.documentationPolicy === "optional" || s.documentationPolicy === "off") ? s.documentationPolicy : "required",
			documentationLanguage: asStr(s.documentationLanguage, ""),
			manualsMode: ["specs", "docs", "module"].indexOf(s.manualsMode) >= 0 ? s.manualsMode : "specs",
			manualsDir: asStr(s.manualsDir, "docs/manuals")
		};
	}

	function toForm(snap) {
		return {
			autonomy: snap.autonomy,
			allowlist: snap.executeAllowlist.join(", "),
			methods: snap.methodAllowlist.join(", "),
			communityUse: snap.communityRepoPath ? "path" : "url",
			communityUrl: snap.communityRepoUrl,
			specsMode: snap.specsMode,
			specsRoot: snap.specsRoot,
			specsDir: snap.specsDir,
			specPolicyScope: snap.specPolicyScope,
			communityPath: snap.communityRepoPath,
			enterpriseUse: snap.enterpriseRepoPath ? "path" : "url",
			enterpriseUrl: snap.enterpriseRepoUrl,
			enterprisePath: snap.enterpriseRepoPath,
			requireCheckpointBeforeMutation: snap.requireCheckpointBeforeMutation,
			requireSpecForChanges: snap.requireSpecForChanges,
			adoptProjectPointerHint: snap.adoptProjectPointerHint,
			securityReviewRequired: snap.securityReviewRequired,
			securityInterviewRequired: snap.securityInterviewRequired,
			auditAllTools: snap.auditAllTools,
			maxCheckpoints: String(snap.maxCheckpoints),
			documentationPolicy: snap.documentationPolicy,
			documentationLanguage: snap.documentationLanguage,
			manualsMode: snap.manualsMode,
			manualsDir: snap.manualsDir
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
		var formCtl = props.form;
		var prefix = props.idPrefix || "odoo-sdd";
		var listDirectory = props.listDirectory;
		var pickDirectory = props.pickDirectory;
		var ss = scopeState(formCtl);
		var canWrite = Boolean(formCtl) && typeof formCtl === "object" && typeof formCtl.set === "function" && ss.writable && ss.status !== "unavailable";

		var st = react.useState(function () { return { form: toForm(readSnap(formCtl)), dirty: false, status: "idle", picker: null }; });
		var model = st[0];
		var setModel = st[1];
		var form = model.form;

		if (react.useEffect && formCtl && typeof formCtl.subscribe === "function") {
			react.useEffect(function () {
				return formCtl.subscribe(function () {
					setModel(function (m) { return Object.assign({}, m, { form: toForm(readSnap(formCtl)), dirty: false, status: "idle" }); });
				});
			}, [formCtl]);
		}

		var edit = function (patch) {
			setModel(function (m) { return { form: Object.assign({}, m.form, patch), dirty: true, status: "idle", picker: m.picker }; });
		};
		var onField = function (name) { return function (e) { var p = {}; p[name] = e.target.value; edit(p); }; };

		var persist = function () {
			if (!canWrite) return;
			var snap = readSnap(formCtl);
			var parseList = function (v) { return String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
			var target = {
				autonomy: form.autonomy,
				executeAllowlist: parseList(form.allowlist),
				methodAllowlist: parseList(form.methods),
				communityRepoUrl: form.communityUse === "url" ? form.communityUrl : "",
				// The project root is deliberately NOT written from the panel: it
				// is resolved from the session's folder. Only the specs LAYOUT is
				// a plugin setting.
				specsMode: form.specsMode === "central" ? "central" : "project",
				specsRoot: form.specsMode === "central" ? (form.specsRoot || "") : "",
				specsDir: form.specsDir || "specs",
				specPolicyScope: form.specPolicyScope === "everywhere" ? "everywhere" : "odoo",
				communityRepoPath: form.communityUse === "path" ? form.communityPath : "",
				enterpriseRepoUrl: form.enterpriseUse === "url" ? form.enterpriseUrl : "",
				enterpriseRepoPath: form.enterpriseUse === "path" ? form.enterprisePath : "",
				requireCheckpointBeforeMutation: form.requireCheckpointBeforeMutation === true,
				requireSpecForChanges: form.requireSpecForChanges === true,
				adoptProjectPointerHint: form.adoptProjectPointerHint === true,
				securityReviewRequired: form.securityReviewRequired === true,
				securityInterviewRequired: form.securityInterviewRequired === true,
				auditAllTools: form.auditAllTools === true,
				maxCheckpoints: Number(form.maxCheckpoints) > 0 ? Number(form.maxCheckpoints) : 5,
				documentationPolicy: form.documentationPolicy === "optional" || form.documentationPolicy === "off" ? form.documentationPolicy : "required",
				documentationLanguage: form.documentationLanguage || "",
				manualsMode: ["specs", "docs", "module"].indexOf(form.manualsMode) >= 0 ? form.manualsMode : "specs",
				manualsDir: form.manualsMode === "docs" ? (form.manualsDir || "docs/manuals") : ""
			};
			var ops = [];
			Object.keys(target).forEach(function (k) {
				var before = Array.isArray(snap[k]) ? snap[k].join(",") : String(snap[k]);
				var after = Array.isArray(target[k]) ? target[k].join(",") : String(target[k]);
				if (before !== after) ops.push([k, target[k]]);
			});
			if (ops.length === 0) { setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved" }); }); return; }
			setModel(function (m) { return Object.assign({}, m, { status: "saving" }); });
			Promise.all(ops.map(function (pair) { return formCtl.set(pair[0], pair[1]); })).then(function () {
				setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved", errorText: "" }); });
			}).catch(function (err) {
				var msg = (err && err.message) ? String(err.message) : "";
				setModel(function (m) { return Object.assign({}, m, { status: "error", errorText: msg }); });
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

		/** Boolean toggle rendered as a Yes/No segmented control. */
		var boolSeg = function (name, value) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				[{ v: true, l: t("yes") }, { v: false, l: t("no") }].map(function (o) {
					return h("button", {
						key: String(o.v), type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.v ? " is-on" : ""),
						"aria-pressed": value === o.v,
						onClick: function () { var p = {}; p[name] = o.v; edit(p); }
					}, o.l);
				}));
		};

		/** A segmented control over an arbitrary set of string values. */
		var enumSeg = function (name, value, options) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				options.map(function (o) {
					return h("button", {
						key: o.v, type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.v ? " is-on" : ""),
						"aria-pressed": value === o.v,
						onClick: function () { var p = {}; p[name] = o.v; edit(p); }
					}, o.l);
				}));
		};

		/** One labelled policy row. */
		var policyRow = function (label, ctl, note) {
			return h("div", { className: "odoo-sdd-field" },
				h("span", { className: "odoo-sdd-label" }, label),
				ctl,
				note ? h("p", { className: "odoo-sdd-sub" }, note) : null);
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

		/** A directory field: type it, or pick it with the host's OS chooser. */
		var dirField = function (name, label, placeholder) {
			var id = prefix + "-" + name;
			var canPick = typeof pickDirectory === "function" && canWrite;
			var doPick = function () {
				Promise.resolve().then(function () { return pickDirectory(); }).then(function (chosen) {
					// null = the operator cancelled the OS dialog: do nothing.
					if (!chosen) return;
					var patch = {}; patch[name] = chosen; edit(patch);
				}).catch(function () {
					// Native chooser unavailable: the field stays typable.
				});
			};
			return h("div", { className: "odoo-sdd-field" },
				h("label", { className: "odoo-sdd-label", htmlFor: id }, label),
				h("div", { className: "odoo-sdd-row" },
					h("input", {
						id: id, type: "text", disabled: !canWrite, className: "odoo-sdd-input odoo-sdd-input--mono",
						style: { flex: "1 1 240px" }, value: form[name] || "", placeholder: placeholder,
						spellCheck: false, autoComplete: "off", onChange: onField(name)
					}),
					canPick ? h("button", {
						type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small",
						"aria-label": t("browse"), onClick: doPick
					}, t("browse")) : null));
		};

		var chips = String(form.allowlist || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
		var methodChips = String(form.methods || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
		var status = h("div", {
			className: "odoo-sdd-status" + (model.status === "saved" ? " odoo-sdd-status--ok" : model.status === "error" ? " odoo-sdd-status--err" : ""),
			role: "status", "aria-live": "polite"
		}, (model.status === "saved" ? t("saved") : model.status === "error" ? (t("error") + (model.errorText ? ": " + model.errorText : "")) : model.status === "saving" ? t("saving") : ""));

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

			h(SectionCard, { title: t("specs"), hint: t("specsHint") },
				policyRow(t("specsMode"), seg("specsMode", form.specsMode, [
					{ value: "project", label: t("specsModeProject") },
					{ value: "central", label: t("specsModeCentral") }
				])),
				form.specsMode === "central"
					? dirField("specsRoot", t("specsRoot"), "~/.dsh-odoo-sdd/specs")
					: h("div", { className: "odoo-sdd-field" },
						h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-specsDir" }, t("specsSubdir")),
						h("input", {
							id: prefix + "-specsDir", type: "text", disabled: !canWrite,
							className: "odoo-sdd-input odoo-sdd-input--mono odoo-sdd-input--short",
							maxLength: 64, value: form.specsDir || "specs",
							placeholder: "specs", spellCheck: false, autoComplete: "off",
							onChange: onField("specsDir")
						})),
				h("p", { className: "odoo-sdd-hint" },
					form.specsMode === "central" ? t("specsCentralResolved") : t("specsProjectResolved"))),
			h(SectionCard, { title: t("delegation"), hint: t("delegationHint") },
				seg("autonomy", form.autonomy, [
					{ value: "supervised", label: t("supervised") },
					{ value: "autonomous", label: t("autonomous") }
				])),

			// The Odoo edition is NOT a plugin setting: it is answered per spec in
			// CLARIFY (sdd_phase operation=clarify licensed=...), because one
			// workspace can hold EE and CE projects at the same time. The card is
			// kept as an explanation rather than a control that would lie about
			// being plugin-wide.
			h(SectionCard, { title: t("license"), hint: t("licenseHint") },
				h("p", { className: "odoo-sdd-sub" }, t("licensePerSpec"))),

			h(SectionCard, { title: t("allowlist"), hint: t("allowlistHint") },
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-allow" }, t("allowlist")),
					h("input", { id: prefix + "-allow", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono", value: form.allowlist, disabled: !canWrite, onChange: onField("allowlist"), placeholder: "my.model, other.model", spellCheck: false, autoComplete: "off" })),
				h("div", { className: "odoo-sdd-chips" },
					chips.length ? chips.map(function (c) { return h("span", { className: "odoo-sdd-chip", key: c }, c); })
						: h("span", { className: "odoo-sdd-sub" }, t("noModels")))),

			h(SectionCard, { title: t("methods"), hint: t("methodsHint") },
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-methods" }, t("methods")),
					h("input", { id: prefix + "-methods", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono", value: form.methods, disabled: !canWrite, onChange: onField("methods"), placeholder: "my.model.my_method, other.model.other_method", spellCheck: false, autoComplete: "off" })),
				h("div", { className: "odoo-sdd-chips" },
					methodChips.length ? methodChips.map(function (c) { return h("span", { className: "odoo-sdd-chip", key: c }, c); })
						: h("span", { className: "odoo-sdd-sub" }, t("noMethods")))),

			h(SectionCard, { title: t("repoCommunity"), hint: t("repoHint") }, repo("community")),
			h(SectionCard, { title: t("repoEnterprise"), hint: t("repoHint") }, repo("enterprise")),

			h(SectionCard, { title: t("policy"), hint: t("policyHint") },
				policyRow(t("checkpointRequired"), boolSeg("requireCheckpointBeforeMutation", form.requireCheckpointBeforeMutation)),
				policyRow(t("specRequired"), boolSeg("requireSpecForChanges", form.requireSpecForChanges)),
				policyRow(t("specScope"), enumSeg("specPolicyScope", form.specPolicyScope, [
					{ v: "odoo", l: t("scopeOdoo") },
					{ v: "everywhere", l: t("scopeEverywhere") },
				]), t("specScopeHint")),
				policyRow(t("adoptHint"), boolSeg("adoptProjectPointerHint", form.adoptProjectPointerHint), t("adoptHintHint")),
				policyRow(t("securityReview"), boolSeg("securityReviewRequired", form.securityReviewRequired)),
				policyRow(t("securityInterview"), boolSeg("securityInterviewRequired", form.securityInterviewRequired)),
				policyRow(t("auditAll"), boolSeg("auditAllTools", form.auditAllTools)),
				policyRow(t("docPolicy"), enumSeg("documentationPolicy", form.documentationPolicy, [
					{ v: "required", l: t("docRequired") },
					{ v: "optional", l: t("docOptional") },
					{ v: "off", l: t("docOff") }
				])),
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-doclang" }, t("docLanguage")),
					h("input", { id: prefix + "-doclang", type: "text", className: "odoo-sdd-input odoo-sdd-input--short", maxLength: 12, value: form.documentationLanguage, placeholder: "en", disabled: !canWrite, spellCheck: false, onChange: onField("documentationLanguage") }),
					h("div", { className: "odoo-sdd-hint" }, t("docLanguageHint"))),
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-maxcp" }, t("maxCheckpoints")),
					h("input", { id: prefix + "-maxcp", type: "number", min: "1", inputMode: "numeric", className: "odoo-sdd-input odoo-sdd-input--short", value: form.maxCheckpoints, disabled: !canWrite, onChange: onField("maxCheckpoints") }))),

			h(SectionCard, { title: t("manuals"), hint: t("manualsHint") },
				policyRow(t("manualsMode"), enumSeg("manualsMode", form.manualsMode, [
					{ v: "specs", l: t("manualsSpecs") },
					{ v: "docs", l: t("manualsDocs") },
					{ v: "module", l: t("manualsModule") }
				]), t("manualsModeHint_" + (["specs", "docs", "module"].indexOf(form.manualsMode) >= 0 ? form.manualsMode : "specs"))),
				form.manualsMode === "docs"
					? dirField("manualsDir", t("manualsDir"), "docs/manuals")
					: null),

			h(SectionCard, { title: t("pipeline"), hint: t("pipelineHint") }, null),

			h("div", { className: "odoo-sdd-actions" },
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--primary", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: persist },
					model.status === "saving" ? t("saving") : t("save")),
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: function () { setModel({ form: toForm(readSnap(formCtl)), dirty: false, status: "idle", picker: null }); } }, t("discard")),
				status)
		);
	};

	function apply(ctx) {
		try {
			// Spanish as a FIRST-CLASS language for the approval card. The host
			// ships only zh/en dictionaries for the `approval` namespace
			// (Waiting for approval / Reject / Allow once); the untyped register
			// overload exists precisely for language-pack contributions, and
			// `addLanguage` makes `es` selectable (and browser-derivable). The
			// plugin also sends `displayReason {en, es, zh}` on every approval,
			// so the QUESTION text localizes even without this registration —
			// this one localizes the CARD around it. Degrades silently on hosts
			// where the namespace or the seam is shaped differently.
			if (ctx.locale && typeof ctx.locale.addLanguage === "function") {
				ctx.effect(function () {
					var disposers = [];
					try { disposers.push(ctx.locale.addLanguage({ id: "es", label: "Español", fallback: "en" })); }
					catch (e) { /* id already occupied by another contributor: fine */ }
					try { disposers.push(ctx.locale.register("approval", "es", {
						waiting: "Esperando aprobación",
						"detail.aria": "Detalles de la aprobación",
						escalation: "La herramienta {toolName} solicita ejecución privilegiada",
						reject: "Rechazar",
						allowOnce: "Permitir una vez"
					})); }
					catch (e) { /* namespace shaped differently on this host: the card stays zh/en */ }
					return function () { disposers.forEach(function (d) { try { d(); } catch (e2) { /* noop */ } }); };
				}, "odoo-sdd: spanish approval card");
			}
			// NOTE: `es` above is registered as a first-class language pack
			// (`addLanguage`), so the Spanish copy lives under its own id — the
			// card localizes for real. The settings-panel dictionaries below stay
			// zh/en because the panel predates language packs; a follow-up can
			// migrate them the same way.
			ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, "odoo-sdd: dictionaries");
			var t = ctx.locale.bind(NS);
			// Registered as an effect so dispose/HMR removes the stylesheet it
			// injected instead of leaking it into the document head forever.
			ctx.effect(function () { injectCss(); return removeCss; }, "odoo-sdd: stylesheet");

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

			// `configForms` is a REQUIRED service (see `exports.inject`): without
			// it there is no namespace form to read or write. Failing loudly here
			// is deliberate — the previous contract made the whole section vanish
			// without a word, which is exactly how a host upgrade broke it.
			var configForms = ctx.configForms;
			if (!configForms || typeof configForms.get !== "function") {
				if (typeof console !== "undefined") {
					console.error(
						"[dsh-odoo-sdd] the `configForms` service is unavailable, so the \"Odoo SDD\" Settings section cannot be registered. " +
						"This host is older than the client contract (dsh >= 0.2.0-rc.1). The tools and the SDD pipeline keep working; " +
						"edit the configuration with `odoo_config mode=read|set` instead."
					);
				}
				return;
			}

			var sectionFor = function (form) {
				return function () {
					return h(SddSection, { t: t, form: form, listDirectory: listDirectory, pickDirectory: pickDirectory, idPrefix: "odoo-sdd-sec" });
				};
			};

			// The section is registered while the Host actually SERVES our
			// namespace, and disposed when it stops: a deployment that never
			// composed it shows no trace of the page. `whileServed` returns the
			// disposer and expects the caller to own it through `ctx.effect`.
			ctx.effect(function () {
				return configForms.whileServed([NS], function () {
					var form = configForms.get(NS);
					return ctx.slots.register({
						name: "settings.section",
						id: "odoo-sdd",
						order: 60,
						label: function () { return t("nav"); },
						locale: NS,
						inject: function () { return { t: t }; }
					}, sectionFor(form));
				});
			}, "odoo-sdd: settings section");

			// NOTE: deliberately NO `settings.plugin.item` registration — the
			// configuration lives in its own standalone Settings section (the
			// sidebar entry above), not as a card inside Settings → Plugins.
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
	var inject = ["slots", "locale", "theme", "uiWorkspace", "configForms"];
	exports.apply = apply;
	exports.inject = inject;
	exports.name = "odoo-sdd";

	return module.exports;
}});
