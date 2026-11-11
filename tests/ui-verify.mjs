/**
 * tests/ui-verify.mjs — the `odoo_ui_verify` layer: a fake Odoo 17 served with
 * node:http on loopback, verified through the real playwright pipeline.
 *
 * THE REGRESSION this suite pins: `captureFlow` reports `ok` on a screen that
 * shows a traceback — it photographs the error, it never asks. `runUiFlows`
 * drains the probe after every step, so the SAME page flips the step to
 * `error` with the right finding kind and freezes an `*-error.png`.
 *
 * Without any usable browser the browser-dependent section prints a visible
 * SKIP; with ODOO_SDD_REQUIRE_BROWSER=1 that SKIP is a failure (CI).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const libUrl = (name) => pathToFileURL(join(root, "lib", name)).href;
const capture = await import(libUrl("manual-capture.js"));
const uiv = await import(libUrl("ui-verify.js"));
const uivTool = await import(libUrl("ui-verify-tool.js"));
const sdd = await import(libUrl("sdd-state.js"));

let passed = 0;
const check = (name, cond, extra) => {
	passed += 1;
	assert.ok(cond, extra ? `${name} — ${extra}` : name);
	console.log(`  PASS  ${name}`);
};

// ---------------------------------------------------------------------------
// Unit layer: families, lint, safety, gates (no browser needed)
// ---------------------------------------------------------------------------
for (const major of [16, 17, 18, 19]) {
	const fam = capture.UI_FAMILIES[major];
	check(
		`family ${major} carries the UI error + step selectors`,
		fam !== undefined &&
			typeof fam.selectors.errorDialog === "string" &&
			typeof fam.selectors.dangerNotification === "string" &&
			fam.selectors.invalidField === ".o_field_invalid" &&
			typeof fam.selectors.dataRow === "string" &&
			typeof fam.selectors.saveButton === "string" &&
			typeof fam.selectors.discardButton === "string" &&
			typeof fam.selectors.switchView === "function" &&
			typeof fam.selectors.searchInput === "string" &&
			typeof fam.selectors.addRow === "string" &&
			typeof fam.selectors.statusbarCurrent === "string",
	);
}
check("16 names its own error dialog (not .o_error_dialog)", !capture.UI_FAMILIES[16].selectors.errorDialog.includes("o_error_dialog"));
check("17/18/19 share .o_error_dialog", [17, 18, 19].every((m) => capture.UI_FAMILIES[m].selectors.errorDialog === ".o_error_dialog"));

// ---- lintUiFlows -----------------------------------------------------------
{
	const bad = uiv.lintUiFlows(
		[
			{ id: "f1", steps: [{ id: "s01", kind: "bogus" }] },
			{ id: "f1", steps: [{ id: "s01", kind: "fill" }] },
			{ id: "f2", steps: [{ id: "s01", kind: "goto" }, { id: "s01", kind: "screenshot" }] },
			{ id: "f3", steps: [{ id: "s01", kind: "menu", target: { kind: "menu", xmlid: "x.y" } }, { id: "s02", kind: "screenshot" }] },
		],
		[{ ac: "AC1", layer: "ui" }],
	);
	const rules = bad.map((f) => `${f.severity}:${f.rule}`);
	check("lint flags an unknown step kind", rules.includes("ERROR:STEP-KIND"));
	check("lint flags a duplicated flow id", bad.filter((f) => f.rule === "FLOW-ID").length === 1);
	check("lint flags a duplicated step id", rules.includes("ERROR:STEP-ID"));
	check("lint flags a missing step payload (fill needs field+value)", rules.includes("ERROR:STEP-ARG"));
	check("lint flags a goto without a target", rules.filter((r) => r === "ERROR:STEP-ARG").length >= 2);
	check("lint warns a look-only flow", rules.includes("WARN:FLOW-LOOKS-ONLY"));
	check("lint warns an uncovered ui AC", rules.includes("WARN:AC-UNCOVERED"));
	const clean = uiv.lintUiFlows([{ id: "ok", ac: ["AC1"], steps: [{ id: "s01", kind: "expect_state", value: "Draft" }] }], [{ ac: "AC1", layer: "ui" }]);
	check("a verifying flow covering its AC lints clean", clean.length === 0, JSON.stringify(clean));
	// roles validation
	const roleLint = uiv.lintUiFlows([
		{ id: "r1", roles: { "m.g1": "yes" }, steps: [{ id: "s01", kind: "expect_state", value: "x" }] },
		{ id: "r2", roles: { "": "ok" }, steps: [{ id: "s01", kind: "expect_state", value: "x" }] },
		{ id: "r3", roles: { "m.g1": "denied" }, steps: [{ id: "s01", kind: "menu", target: { kind: "menu", xmlid: "x.y" } }] },
	]);
	const roleRules = roleLint.map((f) => `${f.severity}:${f.rule}`);
	check("lint rejects a role outcome that is not ok|denied", roleLint.some((f) => f.rule === "ROLE-OUTCOME" && /yes/.test(f.message)));
	check("lint rejects an empty roles key", roleLint.some((f) => f.rule === "ROLE-OUTCOME" && /empty roles key/.test(f.message)));
	check("lint warns a roles flow without expect_*", roleRules.includes("WARN:FLOW-ROLES-NO-EXPECT"));
}

// ---- classifyDenied (pure) --------------------------------------------------
{
	const deniedDialog = uiv.classifyDenied([{ id: "s01", kind: "menu", status: "error", error: "UI errors: Odoo Error", findings: [{ kind: "error-dialog", message: "Odoo Error — Access Error: you are not allowed" }] }]);
	check("an access error-dialog classifies as denied", deniedDialog === "denied", deniedDialog);
	const deniedRpc = uiv.classifyDenied([{ id: "s01", kind: "click", status: "error", error: "UI errors", findings: [{ kind: "rpc-error", message: "AccessError: you cannot read this record" }] }]);
	check("an rpc AccessError classifies as denied", deniedRpc === "denied", deniedRpc);
	const missingTarget = uiv.classifyDenied([{ id: "s01", kind: "menu", status: "error", error: "page.click: Timeout 15000ms exceeded." }]);
	check("a navigation step whose target never rendered classifies as denied", missingTarget === "denied", missingTarget);
	const noView = uiv.classifyDenied([{ id: "s01", kind: "goto", status: "error", error: "no view rendered within 15000ms" }]);
	check("a 'no view rendered' navigation classifies as denied", noView === "denied", noView);
	const clean = uiv.classifyDenied([{ id: "s01", kind: "menu", status: "ok" }, { id: "s02", kind: "expect_state", status: "ok" }]);
	check("a complete flow classifies as allowed", clean === "allowed", clean);
	const traceback = uiv.classifyDenied([{ id: "s01", kind: "click", status: "error", error: "UI errors", findings: [{ kind: "error-dialog", message: "Odoo Server Error — ValueError: bad value" }] }]);
	check("a non-access traceback classifies as other-error", traceback === "other-error", traceback);
}

// ---- uiStepSafety ----------------------------------------------------------
check("open_row/switch_view/search/expect_* are read-only", ["open_row", "switch_view", "search", "expect_state", "expect_field", "expect_visible", "expect_hidden"].every((k) => uiv.uiStepSafety({ kind: k }) === "read-only"));
check("save/discard/click_text/add_line are actions", ["save", "discard", "click_text", "add_line"].every((k) => uiv.uiStepSafety({ kind: k }) === "action"));
check("a tab-pinned click is read-only, a header click is an action", uiv.uiStepSafety({ kind: "click", tab: true }) === "read-only" && uiv.uiStepSafety({ kind: "click" }) === "action");

// ---- crawlFlowsFromCanon (pure) ---------------------------------------------
{
	const canon = {
		module: {
			menus: [{ xmlid: "my.menu_root", completeName: "My App / Records", actionXmlid: "my.action_records" }],
			actions: [{ xmlid: "my.action_records", kind: "ir.actions.act_window", model: "my.model", viewMode: "list,form" }],
			models: [
				{
					model: "my.model",
					pages: [{ name: "lines" }, { name: "notes" }],
					buttons: [{ name: "action_confirm" }, { name: "action_hidden", invisibleRaw: "state != 'draft'" }],
				},
			],
		},
	};
	const flows = uiv.crawlFlowsFromCanon(canon);
	check("the crawl emits one flow per menu that opens an act_window", flows.length === 1 && flows[0].id.startsWith("crawl-1-"));
	const kinds = flows[0].steps.map((s) => s.kind);
	check("the crawl navigates then visits every viewMode", kinds[0] === "menu" && kinds.filter((k) => k === "switch_view").length === 2);
	check("the crawl opens a record and visits every notebook page", kinds.includes("open_row") && flows[0].steps.filter((s) => s.tab === true).length === 2);
	check("the crawl never runs a header button — only expect_visible on the visible ones", flows[0].steps.filter((s) => s.kind === "expect_visible").length === 1);
	check("the whole crawl is read-only", flows[0].steps.every((s) => uiv.uiStepSafety(s) === "read-only"));
	check("a menu without an act_window produces no flow", uiv.crawlFlowsFromCanon({ module: { menus: [{ xmlid: "x", actionXmlid: "none" }], actions: [], models: [] } }).length === 0);
	check("a canon without a module produces no flow", uiv.crawlFlowsFromCanon({}).length === 0);
}

// ---- uiVerifyGaps (the sdd_phase succeed gate) ------------------------------
{
	const gapDir = mkdtempSync(join(tmpdir(), "uiv-gaps-"));
	const plan = (rows) =>
		writeFileSync(join(gapDir, "test-plan.md"), `# Test Plan\n\n| AC | Scenario | Layer | Status |\n|---|---|---|---|\n${rows}\n`);
	const arch = (views) => writeFileSync(join(gapDir, "architecture.md"), `# Architecture\n\n## Views\n\n${views}\n`);
	const report = (name, verdict) => {
		mkdirSync(join(gapDir, "ui-verify"), { recursive: true });
		writeFileSync(join(gapDir, "ui-verify", name), JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify/1", verdict, flows: [{ id: "f1", status: "error", steps: [{ id: "s01", findings: [{ kind: "error-dialog", message: "Odoo Error" }] }] }] }));
	};
	check("no Views and no ui rows: the gate does not apply", sdd.uiVerifyGaps(gapDir, "create").length === 0);
	plan("| AC1 | x | ui | pending |");
	check("a ui row without Views still requires UI evidence", sdd.uiVerifyGaps(gapDir, "create").some((g) => /report\.json is missing/.test(g)));
	check("functional specs are exempt", sdd.uiVerifyGaps(gapDir, "functional").length === 0);
	report("report.json", "FAILED");
	check("a FAILED report is a gap naming the finding", sdd.uiVerifyGaps(gapDir, "create").some((g) => /FAILED/.test(g) && /error-dialog/.test(g)));
	report("report.json", "NEEDS_BROWSER");
	check("NEEDS_BROWSER carries no automated gap of its own", sdd.uiVerifyGaps(gapDir, "create").length === 0);
	report("report.json", "PASSED");
	check("PASSED satisfies the gate", sdd.uiVerifyGaps(gapDir, "create").length === 0);
	report("crawl-report.json", "FAILED");
	check("a FAILED crawl is a gap even with a PASSED run", sdd.uiVerifyGaps(gapDir, "create").some((g) => /crawl/.test(g)));
	rmSync(join(gapDir, "ui-verify"), { recursive: true, force: true });
	arch("none — the module ships no screens");
	check("`## Views: none` is the honest opt-out", sdd.uiVerifyGaps(gapDir, "create").length === 0 || sdd.uiVerifyGaps(gapDir, "create").every((g) => /report\.json is missing/.test(g)));
	// `## Views: none` + NO ui row → fully exempt.
	plan("| AC1 | x | rpc | pending |");
	check("`## Views: none` + no ui row exempts the spec", sdd.uiVerifyGaps(gapDir, "create").length === 0);
	rmSync(gapDir, { recursive: true, force: true });
}

// ---- recordFailedVerdict archives the UI reports -----------------------------
{
	const stateDir = mkdtempSync(join(tmpdir(), "uiv-state-"));
	mkdirSync(join(stateDir, "ui-verify"), { recursive: true });
	writeFileSync(join(stateDir, "ui-verify", "report.json"), "{}");
	writeFileSync(join(stateDir, "ui-verify", "crawl-report.json"), "{}");
	const state = { specDir: stateDir, phase: "VERIFY", mode: "create", failureCount: 0, iterations: 0 };
	sdd.recordFailedVerdict(state, "the check failed");
	const leftovers = readdirSync(join(stateDir, "ui-verify"));
	check("a FAILED verdict archives both ui reports (rename, not delete)", !existsSync(join(stateDir, "ui-verify", "report.json")) && !existsSync(join(stateDir, "ui-verify", "crawl-report.json")) && leftovers.some((f) => /^report\.\d{4}-.*\.json$/.test(f)) && leftovers.some((f) => /^crawl-report\.\d{4}-.*\.json$/.test(f)), JSON.stringify(leftovers));
	rmSync(stateDir, { recursive: true, force: true });
}

// ---- the tool fences (fake deps, no browser needed) ---------------------------
{
	const specDir = mkdtempSync(join(tmpdir(), "uiv-spec-"));
	mkdirSync(join(specDir, "ui-verify"), { recursive: true });
	writeFileSync(
		join(specDir, "ui-verify", "flows.json"),
		JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify/flows/1", flows: [{ id: "f1", steps: [{ id: "s01", kind: "fill", field: "x", value: "y" }] }] }),
	);
	const registered = new Map();
	const mkDeps = (env) => ({
		projectRoot: () => specDir,
		specDir: () => specDir,
		client: () => ({ version: async () => ({ ok: true, value: { server_version: "17.0" } }), executeKw: async () => ({ ok: true, value: [] }) }),
		environment: () => env,
		credentials: () => null,
		webSession: async () => ({ ok: true, value: { baseUrl: "http://127.0.0.1:1", sessionId: "x", uid: 2 } }),
		display: (v) => v,
	});
	uivTool.registerUiVerifyTool({ tools: { register: (t) => registered.set(t.name, t) } }, mkDeps("dev"));
	const tool = registered.get("odoo_ui_verify");
	check("the tool registers as odoo_ui_verify", tool !== undefined);
	const noAllow = await tool.execute({ operation: "run", spec_id: "x" });
	check("ACTION steps without allow_actions are BLOCKED", noAllow.ok === false && /allow_actions is not true/.test(noAllow.detail), noAllow.detail);
	const noConfirm = await tool.execute({ operation: "run", spec_id: "x", allow_actions: true });
	check("allow_actions without confirm_destructive is CONFIRM_REQUIRED", noConfirm.ok === false && noConfirm.summary === "CONFIRM_REQUIRED", noConfirm.detail);
	const badRegex = await tool.execute({ operation: "run", spec_id: "x", ignore: ["(["] });
	check("an invalid ignore regex is BLOCKED before any browser work", badRegex.ok === false && /not a valid regex/.test(badRegex.detail));

	const prod = new Map();
	uivTool.registerUiVerifyTool({ tools: { register: (t) => prod.set(t.name, t) } }, mkDeps("production"));
	const prodRun = await prod.get("odoo_ui_verify").execute({ operation: "run", spec_id: "x", allow_actions: true, confirm_destructive: true });
	check("a production environment refuses the run outright", prodRun.ok === false && /production/.test(prodRun.detail), prodRun.detail);

	// NEEDS_BROWSER: read-only flows, a browser that cannot launch — the tool
	// must still WRITE the report the gate reads instead of guessing. The
	// launcher is injected: runners preinstall Chrome/Edge, so "a browser
	// choice that cannot exist" would make this check depend on the host.
	writeFileSync(
		join(specDir, "ui-verify", "flows.json"),
		JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify/flows/1", flows: [{ id: "f1", steps: [{ id: "s01", kind: "screenshot" }] }] }),
	);
	const noBrowser = new Map();
	uivTool.registerUiVerifyTool(
		{ tools: { register: (t) => noBrowser.set(t.name, t) } },
		{
			...mkDeps("dev"),
			launchBrowser: async () => ({ ok: false, error: "Executable doesn't exist at /nonexistent/playwright/chromium-1234/chrome-linux/chrome" }),
		},
	);
	const nb = await noBrowser.get("odoo_ui_verify").execute({ operation: "run", spec_id: "x" });
	const nbReport = existsSync(join(specDir, "ui-verify", "report.json")) ? JSON.parse(readFileSync(join(specDir, "ui-verify", "report.json"), "utf8")) : null;
	check("NEEDS_BROWSER still writes report.json for the gate", nb.ok === false && /NEEDS_BROWSER/.test(nb.detail) && nbReport?.verdict === "NEEDS_BROWSER", nb.detail.slice(0, 140));

	// plan: one skeleton flow per ui row, create-only.
	writeFileSync(join(specDir, "test-plan.md"), "# Test Plan\n\n| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | x | ui | pending |\n| AC2 | y | rpc | pending |\n");
	rmSync(join(specDir, "ui-verify", "flows.json"), { force: true });
	const planned = await tool.execute({ operation: "plan", spec_id: "x" });
	const flowsFile = JSON.parse(readFileSync(join(specDir, "ui-verify", "flows.json"), "utf8"));
	check("plan writes one skeleton flow per ui AC only", planned.ok && flowsFile.flows.length === 1 && flowsFile.flows[0].ac.includes("AC1"), JSON.stringify(flowsFile.flows));
	const linted = await tool.execute({ operation: "lint", spec_id: "x" });
	check("the skeleton is deliberately INVALID until the QA writes it", linted.ok === false && /ERROR/.test(linted.detail));
	rmSync(specDir, { recursive: true, force: true });
}

// ---- the matrix op (fake client, no browser needed) --------------------------
// A fake CanonClient that survives collectCanon (module anchor, langs,
// fields_get, get_views, inventories) and records every res.users call.
const mkMatrixClient = ({ groupRows, unlinkFails = false, writeFails = false }) => {
		const calls = [];
		let created = 0;
		return {
			calls,
			client: {
				version: async () => ({ ok: true, value: { server_version: "17.0" } }),
				currentUid: () => 2,
				executeKw: async (model, method, args = [], kwargs = {}) => {
					calls.push({ model, method, args, kwargs });
					if (method === "fields_get") return { ok: true, value: {} };
					if (method === "get_views") return { ok: true, value: { views: {} } };
					if (model === "res.lang") return { ok: true, value: [{ code: "en_US" }] };
					if (model === "ir.model") return { ok: true, value: [{ id: 1, model: "my.model", modules: "my_mod" }] };
					if (model === "ir.model.data" && method === "search_read") {
						const domain = args[0] ?? [];
						const isGroups = domain.some((d) => Array.isArray(d) && d[0] === "model" && d[2] === "res.groups");
						const byXmlid = domain.some((d) => Array.isArray(d) && d[0] === "name" && d[1] === "in");
						return { ok: true, value: isGroups && byXmlid ? groupRows : [] };
					}
					if (model === "res.users" && method === "create") {
						created += 1;
						return { ok: true, value: 100 + created };
					}
					if (model === "res.users" && method === "unlink") return unlinkFails ? { ok: false, error: "cannot unlink" } : { ok: true, value: true };
					if (model === "res.users" && method === "write") return writeFails ? { ok: false, error: "cannot write" } : { ok: true, value: true };
					return { ok: true, value: [] };
				},
			},
		};
	};
	const GROUP_ROWS = [
		{ module: "base", name: "group_user", res_id: 10 },
		{ module: "my_mod", name: "group_member", res_id: 11 },
		{ module: "my_mod", name: "group_locked", res_id: 12 },
	];
	const mkMatrixSpec = () => {
		const specDir = mkdtempSync(join(tmpdir(), "uiv-matrix-"));
		mkdirSync(join(specDir, "ui-verify"), { recursive: true });
		writeFileSync(
			join(specDir, "ui-verify", "flows.json"),
			JSON.stringify({
				schema: "dsh-odoo-sdd/ui-verify/flows/1",
				flows: [
					{ id: "as-member", roles: { "my_mod.group_member": "ok" }, steps: [{ id: "s01", kind: "screenshot" }] },
					{ id: "as-locked", roles: { "my_mod.group_locked": "denied" }, steps: [{ id: "s01", kind: "screenshot" }] },
				],
			}),
		);
		return specDir;
	};
	// runFlows fake: as-member runs clean, as-locked dies on an access dialog.
	const fakeRunFlows = async (opts) => ({
		ok: true,
		value: {
			schema: "dsh-odoo-sdd/ui-verify/1",
			mode: "flows",
			verdict: "PASSED",
			startedAt: "t",
			serverVersion: "17.0",
			flowsHash: "h",
			ignore: [],
			ignoredCount: 0,
			originLocked: true,
			evidence: {},
			flows: opts.flows.map((f) =>
				f.id === "as-locked"
					? { id: f.id, status: "error", findings: 1, steps: [{ id: "s01", kind: "screenshot", status: "error", error: "UI errors: Access Error", findings: [{ kind: "error-dialog", message: "Access Error: not allowed" }] }] }
					: { id: f.id, status: "ok", findings: 0, steps: [{ id: "s01", kind: "screenshot", status: "ok" }] },
			),
		},
	});
	const mkMatrixDeps = (specDir, { client, approve, audit, runFlows = fakeRunFlows, sessionFails = false }) => ({
		projectRoot: () => specDir,
		specDir: () => specDir,
		client: () => client,
		environment: () => "dev",
		credentials: () => ({ url: "http://fake", db: "qa", username: "adm", secret: "x", secretKind: "password", environment: "dev" }),
		webSession: async () => ({ ok: true, value: { baseUrl: "http://fake", sessionId: "x", uid: 2 } }),
		webSessionAs: async (login) => (sessionFails ? { ok: false, error: "login rejected" } : { ok: true, value: { baseUrl: "http://fake", sessionId: `sess-${login}`, uid: 7 } }),
		display: (v) => v,
		...(approve !== undefined ? { approve } : {}),
		...(audit !== undefined ? { audit } : {}),
		launchBrowser: async () => ({ ok: true, value: { close: async () => {} } }),
		runFlows,
	});
	const createCalls = (calls) => calls.filter((c) => c.model === "res.users" && c.method === "create");
	const registerMatrix = (deps) => {
		const reg = new Map();
		uivTool.registerUiVerifyTool({ tools: { register: (t) => reg.set(t.name, t) } }, deps);
		return reg.get("odoo_ui_verify");
	};

	// Approval gates: without the seam, or refused/cancelled/unavailable, not
	// one res.users.create may be sent — and a NOT_APPROVED report is written.
	for (const outcome of [undefined, "rejected", "cancelled", "unavailable"]) {
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS });
		const deps = mkMatrixDeps(specDir, { client, approve: outcome === undefined ? undefined : async () => outcome });
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		check(`matrix ${outcome === undefined ? "without approval service" : `approval=${outcome}`} creates ZERO users`, res.ok === false && /NOT_APPROVED/.test(res.summary) && createCalls(calls).length === 0, `${res.summary} creates=${createCalls(calls).length}`);
		const stub = JSON.parse(readFileSync(join(specDir, "ui-verify", "matrix-report.json"), "utf8"));
		check(`matrix ${outcome ?? "no-service"} still writes the NOT_APPROVED report`, stub.verdict === "NOT_APPROVED" && stub.createdUserIds.length === 0);
		rmSync(specDir, { recursive: true, force: true });
	}

	// allowed-once: creates one user per group, runs the matrix, deletes them.
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS });
		const auditLines = [];
		let approveReason = null;
		const deps = mkMatrixDeps(specDir, {
			client,
			approve: async (exec, reason) => {
				approveReason = reason;
				return "allowed-once";
			},
			audit: (exec, op, args, extra) => auditLines.push({ op, args, extra }),
		});
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		const creates = createCalls(calls);
		check("allowed-once creates ONE user per group", creates.length === 2, JSON.stringify(creates.map((c) => c.args)));
		check("the approval reason names the sddqa logins, groups and target", approveReason !== null && /sddqa_1_/.test(approveReason.en) && /my_mod\.group_member/.test(approveReason.en) && /db=qa/.test(approveReason.en) && typeof approveReason.es === "string" && typeof approveReason.zh === "string", JSON.stringify(approveReason).slice(0, 200));
		const report = JSON.parse(readFileSync(join(specDir, "ui-verify", "matrix-report.json"), "utf8"));
		check("the matrix verdict is PASSED and the report is complete", res.ok === true && report.schema === "dsh-odoo-sdd/ui-verify-matrix/1" && report.verdict === "PASSED" && report.groups.length === 2 && report.cleanup === "deleted" && report.createdUserIds.length === 2, `${res.summary} ${report.verdict}`);
		const locked = report.groups.find((g) => g.group === "my_mod.group_locked");
		check("the denied expectation is recorded as observed=denied", locked.flows[0].expected === "denied" && locked.flows[0].observed === "denied" && locked.flows[0].pass === true, JSON.stringify(locked.flows[0]));
		check("unlink removed every created user", calls.filter((c) => c.model === "res.users" && c.method === "unlink").length === 1 && calls.filter((c) => c.model === "res.users" && c.method === "unlink")[0].args[0].length === 2);
		check("each created user carries base.group_user + its group via groups_id", creates.every((c) => Array.isArray(c.args[0].groups_id) && c.args[0].groups_id[0][0] === 6), JSON.stringify(creates[0].args[0]));
		check("create used the no-mail context", creates.every((c) => c.kwargs.context?.no_reset_password === true && c.kwargs.context?.tracking_disable === true));
		check("creation and cleanup are audited", auditLines.some((a) => a.op === "odoo_ui_verify/matrix-users") && auditLines.some((a) => a.op === "odoo_ui_verify/matrix-cleanup"), JSON.stringify(auditLines.map((a) => a.op)));
		// THE password must not surface anywhere it was not needed.
		const pw = creates[0].args[0].password;
		check("the generated password is a random per-user secret", typeof pw === "string" && pw.length >= 30 && pw !== creates[1].args[0].password);
		const allWritten = readdirSync(specDir, { recursive: true }).map((f) => join(specDir, String(f))).filter((f) => f.endsWith(".json") || f.endsWith(".md")).map((f) => readFileSync(f, "utf8")).join("\n");
		const leaked = allWritten.includes(pw) || JSON.stringify(res).includes(pw) || JSON.stringify(auditLines).includes(pw) || JSON.stringify(report).includes(pw);
		check("the password appears in NO report, message, result or audit", !leaked);
		rmSync(specDir, { recursive: true, force: true });
	}

	// A flow that throws still gets the cleanup.
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS });
		const deps = mkMatrixDeps(specDir, {
			client,
			approve: async () => "allowed-once",
			runFlows: async () => { throw new Error("browser died"); },
		});
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		const unlinks = calls.filter((c) => c.model === "res.users" && c.method === "unlink");
		check("a throwing flow still unlinks the created users", res.ok === false && createCalls(calls).length === 2 && unlinks.length === 1, res.summary);
		rmSync(specDir, { recursive: true, force: true });
	}

	// unlink fails → archive fallback; both fail → CLEANUP_PENDING with ids.
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS, unlinkFails: true });
		const deps = mkMatrixDeps(specDir, { client, approve: async () => "allowed-once" });
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		const report = JSON.parse(readFileSync(join(specDir, "ui-verify", "matrix-report.json"), "utf8"));
		check("a failed unlink falls back to write active:false", calls.some((c) => c.model === "res.users" && c.method === "write" && c.args[1]?.active === false) && report.cleanup === "archived", JSON.stringify(report.cleanup));
		rmSync(specDir, { recursive: true, force: true });
	}
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS, unlinkFails: true, writeFails: true });
		const deps = mkMatrixDeps(specDir, { client, approve: async () => "allowed-once" });
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		const report = JSON.parse(readFileSync(join(specDir, "ui-verify", "matrix-report.json"), "utf8"));
		check("unlink+write failing is CLEANUP_PENDING naming the surviving users", res.ok === false && report.verdict === "CLEANUP_PENDING" && report.cleanup === "pending" && report.createdUserIds.length === 2 && /sddqa_/.test(res.detail) && /101|102/.test(res.detail), `${report.verdict} ${res.summary}`);
		rmSync(specDir, { recursive: true, force: true });
	}

	// production: refused before anything.
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS });
		const deps = { ...mkMatrixDeps(specDir, { client, approve: async () => "allowed-once" }), environment: () => "production" };
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		check("production refuses the matrix without a single RPC mutation", res.ok === false && /production/.test(res.detail) && calls.filter((c) => c.model === "res.users").length === 0, res.detail.slice(0, 120));
		rmSync(specDir, { recursive: true, force: true });
	}

	// unknown xmlid: BLOCKED before create (and before approval matters).
	{
		const specDir = mkMatrixSpec();
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS.filter((r) => r.name !== "group_locked") });
		const deps = mkMatrixDeps(specDir, { client, approve: async () => "allowed-once" });
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		check("an unknown group xmlid is BLOCKED with zero creates", res.ok === false && /unknown group xmlid/.test(res.detail) && createCalls(calls).length === 0, res.detail.slice(0, 160));
		rmSync(specDir, { recursive: true, force: true });
	}

	// no roles anywhere: BLOCKED with guidance.
	{
		const specDir = mkdtempSync(join(tmpdir(), "uiv-matrix-"));
		mkdirSync(join(specDir, "ui-verify"), { recursive: true });
		writeFileSync(join(specDir, "ui-verify", "flows.json"), JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify/flows/1", flows: [{ id: "f", steps: [{ id: "s01", kind: "screenshot" }] }] }));
		const { calls, client } = mkMatrixClient({ groupRows: GROUP_ROWS });
		const deps = mkMatrixDeps(specDir, { client, approve: async () => "allowed-once" });
		const res = await registerMatrix(deps).execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
		check("no roles declared is BLOCKED explaining roles", res.ok === false && /roles/.test(res.detail) && createCalls(calls).length === 0, res.detail.slice(0, 160));
		rmSync(specDir, { recursive: true, force: true });
	}

// ---- the matrix gate + archive ------------------------------------------------
{
	const gapDir = mkdtempSync(join(tmpdir(), "uiv-mgap-"));
	writeFileSync(join(gapDir, "test-plan.md"), "# Test Plan\n\n| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | x | ui | pending |\n");
	writeFileSync(join(gapDir, "architecture.md"), "# Architecture\n\n## Views\n\nList and form views.\n");
	mkdirSync(join(gapDir, "ui-verify"), { recursive: true });
	const flows = (withRoles) =>
		writeFileSync(join(gapDir, "ui-verify", "flows.json"), JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify/flows/1", flows: [{ id: "f", ...(withRoles ? { roles: { "m.g": "denied" } } : {}), steps: [] }] }));
	const mreport = (verdict) => writeFileSync(join(gapDir, "ui-verify", "matrix-report.json"), JSON.stringify({ schema: "dsh-odoo-sdd/ui-verify-matrix/1", verdict, groups: [], createdUserIds: [], cleanup: "none" }));
	const mfile = join(gapDir, "ui-verify", "matrix-report.json");
	const hasMatrixGap = () => sdd.uiVerifyGaps(gapDir, "create").some((g) => /matrix/i.test(g));

	flows(false);
	check("no roles + no matrix report: the matrix gate does not apply", !hasMatrixGap());
	flows(true);
	check("roles declared but no matrix-report.json is a gap", hasMatrixGap());
	mreport("FAILED");
	check("a FAILED matrix report is a gap", hasMatrixGap());
	mreport("CLEANUP_PENDING");
	check("a CLEANUP_PENDING matrix report is a gap", hasMatrixGap());
	mreport("NEEDS_BROWSER");
	check("a NEEDS_BROWSER matrix report is not a gap", !hasMatrixGap());
	mreport("PASSED");
	check("a PASSED matrix report satisfies the gate", !hasMatrixGap());
	mreport("NOT_APPROVED");
	check("NOT_APPROVED with roles declared is still a gap", hasMatrixGap());
	flows(false);
	check("NOT_APPROVED without roles does not create the gate", !hasMatrixGap());

	// recordFailedVerdict archives the matrix report too.
	mreport("FAILED");
	const state = { specDir: gapDir, phase: "VERIFY", mode: "create", failureCount: 0, iterations: 0 };
	sdd.recordFailedVerdict(state, "x");
	const left = readdirSync(join(gapDir, "ui-verify"));
	check("recordFailedVerdict archives matrix-report.json", !existsSync(mfile) && left.some((f) => /^matrix-report\.\d{4}-.*\.json$/.test(f)), JSON.stringify(left));
	rmSync(gapDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Browser layer: capture passes where verification must FAIL
// ---------------------------------------------------------------------------
const VIEW = `<div class="o_action_manager"><div class="o_list_view"><table><tr class="o_data_row"><td>r1</td></tr></table></div></div>`;
const PAGES = {
	"/web": `<!doctype html><html><body>${VIEW}</body></html>`,
	"/err-dialog": `<!doctype html><html><body>${VIEW}
		<div class="modal"><div class="o_error_dialog"><div class="modal-title">Odoo Error</div>
		<div class="alert">Traceback: something broke</div></div></div></body></html>`,
	"/err-notif": `<!doctype html><html><body>${VIEW}
		<div class="o_notification border-danger"><strong class="o_notification_title">Error</strong>
		<div class="o_notification_content">Invalid operation</div></div></body></html>`,
	"/err-js": `<!doctype html><html><body>${VIEW}
		<script>setTimeout(() => { throw new Error("uncaught boom"); }, 30);</script></body></html>`,
	"/err-rpc": `<!doctype html><html><body>${VIEW}
		<script>fetch("/web/dataset/call_kw/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });</script></body></html>`,
	"/rpc-ok": `<!doctype html><html><body>${VIEW}
		<script>fetch("/web/dataset/call_kw/ok", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });</script></body></html>`,
	"/err-invalid": `<!doctype html><html><body>${VIEW}
		<div class="o_field_char o_field_invalid" name="partner_id"><input name="partner_id"/></div></body></html>`,
	"/access-denied": `<!doctype html><html><body>${VIEW}
		<div class="modal"><div class="o_error_dialog"><div class="modal-title">Odoo Error</div>
		<div class="alert">Access Error: you are not allowed to access this view</div></div></div></body></html>`,
	"/form": `<!doctype html><html><body>
		<div class="o_action_manager"><div class="o_form_view">
		<header><div class="o_form_statusbar"><div class="o_statusbar_status">
		<span class="o_arrow_button_current">Draft</span></div></div></header>
		<div class="o_field_char" name="partner_id"><input name="partner_id" value="Acme"/></div>
		<table><tr class="o_data_row"><td>r1</td></tr></table>
		<button class="o_switch_view o_kanban"></button><input class="o_searchview_input"/>
		<button class="o_form_button_save"></button><button class="o_form_button_cancel"></button>
		<button class="header-btn">Confirm</button>
		</div></div></body></html>`,
};

const rpcHits = [];
const server = createServer((req, res) => {
	const url = req.url ?? "/";
	if (url.startsWith("/web/session/authenticate")) {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let login = "?";
			try {
				login = String(JSON.parse(body).params?.login ?? "?");
			} catch {
				/* keep the default */
			}
			const sessionId = `sess-${login}`;
			res.writeHead(200, { "content-type": "application/json", "set-cookie": `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax` });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: { uid: 7, session_id: sessionId } }));
		});
		return;
	}
	if (url.startsWith("/web/dataset/call_kw/x")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 200, message: "Odoo Server Error", data: { message: "boom rpc" } } }));
		return;
	}
	if (url.startsWith("/web/dataset/call_kw/ok")) {
		rpcHits.push(url);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: { ok: true } }));
		return;
	}
	const path = url.split("?")[0].split("#")[0];
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGES[path] ?? PAGES["/web"]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const session = { baseUrl, sessionId: "fakesession123", uid: 2 };
const fam17 = capture.familyFor("17.0").value.family;

const pw = await capture.loadPlaywright();
let browser = null;
if (pw.ok) {
	const opened = await capture.resolveBrowser(pw.value.chromium, "auto", false);
	if (opened.ok) browser = opened.value;
}

try {
	if (!browser) {
		console.log("  SKIP: no usable browser — browser-dependent checks skipped");
		if (process.env.ODOO_SDD_REQUIRE_BROWSER === "1") {
			throw new Error("ODOO_SDD_REQUIRE_BROWSER=1 but no browser is available");
		}
	} else {
		const wsBase = mkdtempSync(join(tmpdir(), "uiv-e2e-"));
		const uiFlow = (id, url, extra = []) => ({ id, steps: [{ id: "s01", kind: "goto", target: { kind: "url", url } }, ...extra] });
		const run = (id, url, opts = {}) =>
			uiv.runUiFlows({ session, browser, family: fam17, flows: [uiFlow(id, `${baseUrl}${url}`, opts.extra ?? [])], workspace: wsBase, serverVersion: "17.0", allowActions: opts.allowActions === true, continueOnError: opts.continueOnError === true, ignore: opts.ignore });
		const captureRun = (id, url) =>
			capture.captureFlow({ session, browser, family: fam17, flow: uiFlow(id, `${baseUrl}${url}`, [{ id: "s02", kind: "screenshot" }]), allowActions: false, headed: false, zoom: 1, workspace: wsBase });

		// THE REGRESSION: a plain capture says "ok" on screens the probe fails.
		const cases = [
			["/err-dialog", "error-dialog"],
			["/err-notif", "danger-notification"],
			["/err-js", "js-error"],
			["/err-rpc", "rpc-error"],
			["/err-invalid", "invalid-field"],
		];
		for (const [url, kind] of cases) {
			const cap = await captureRun(`cap-${kind}`, url);
			check(`capture reports ok on ${kind} (the bug this tool fixes)`, cap.ok === true && cap.value.steps.every((s) => s.status === "ok"), JSON.stringify(cap.ok ? cap.value.steps : cap.error));
			const ver = await run(`ver-${kind}`, url);
			const step = ver.ok ? ver.value.flows[0].steps[0] : null;
			check(`ui-verify FAILS ${url} with kind ${kind}`, ver.ok === true && ver.value.verdict === "FAILED" && (step?.findings ?? []).some((f) => f.kind === kind), JSON.stringify(step));
			check(`${kind} froze an -error.png of what the user saw`, existsSync(join(wsBase, "images", `ver-${kind}-s01-error.png`)));
		}

		const healthy = await run("healthy", "/web", { extra: [{ id: "s02", kind: "screenshot" }] });
		check("a clean screen passes end to end", healthy.ok === true && healthy.value.verdict === "PASSED" && healthy.value.originLocked === true, JSON.stringify(healthy.ok ? healthy.value.verdict : healthy.error));
		check("the report schema is dsh-odoo-sdd/ui-verify/1", healthy.ok === true && healthy.value.schema === "dsh-odoo-sdd/ui-verify/1");
		check("report.json lands in the workspace", existsSync(join(wsBase, "report.json")));

		// A HEALTHY RPC call the page makes is not a finding: the check fires on
		// the error BODY, not on the call existing.
		const rpcGood = await run("rpc-healthy", "/rpc-ok");
		check("a 200-with-result RPC body is NOT a finding", rpcGood.ok === true && rpcGood.value.verdict === "PASSED" && rpcHits.length >= 1, JSON.stringify(rpcGood.ok ? rpcGood.value.verdict : rpcGood.error));

		const rpcIgnored = await run("rpc-ignored", "/err-rpc", { ignore: [/boom rpc/] });
		check("ignore drops a declared finding AND counts it", rpcIgnored.ok === true && rpcIgnored.value.ignoredCount >= 1 && rpcIgnored.value.verdict === "PASSED", JSON.stringify(rpcIgnored.ok ? { v: rpcIgnored.value.verdict, i: rpcIgnored.value.ignoredCount } : rpcIgnored.error));

		// continueOnError: without it the flow stops at the failing step.
		const twoSteps = [{ id: "s02", kind: "expect_visible", text: "never-on-screen" }];
		const stopped = await run("stop", "/err-dialog", { extra: twoSteps });
		check("without continueOnError the flow stops at the first error", stopped.ok === true && stopped.value.flows[0].steps.length === 1);
		const kept = await run("keep", "/err-dialog", { extra: twoSteps, continueOnError: true });
		check("with continueOnError the flow runs to the end", kept.ok === true && kept.value.flows[0].steps.length === 2 && kept.value.verdict === "FAILED");

		// The verification-only steps on the fake form.
		const domFlow = {
			id: "dom",
			steps: [
				{ id: "s01", kind: "goto", target: { kind: "url", url: `${baseUrl}/form` } },
				{ id: "s02", kind: "expect_state", value: "Draft" },
				{ id: "s03", kind: "expect_field", field: "partner_id", value: "Acme" },
				{ id: "s04", kind: "expect_visible", text: "Confirm" },
				{ id: "s05", kind: "expect_hidden", text: "Invisible thing" },
				{ id: "s06", kind: "open_row", index: 0 },
				{ id: "s07", kind: "switch_view", view: "kanban" },
				{ id: "s08", kind: "search", value: "abc" },
			],
		};
		const dom = await uiv.runUiFlows({ session, browser, family: fam17, flows: [domFlow], workspace: wsBase, serverVersion: "17.0", allowActions: false });
		check("the new DOM-only steps run read-only on the fake form", dom.ok === true && dom.value.flows[0].steps.every((s) => s.status === "ok"), JSON.stringify(dom.ok ? dom.value.flows[0].steps.map((s) => `${s.id}:${s.status}:${s.error ?? ""}`) : dom.error));

		// An expect_* that does not hold is a step error, not a crash.
		const expectBad = await run("expbad", "/form", { extra: [{ id: "s02", kind: "expect_state", value: "Posted" }] });
		check("a failed expectation marks the step error", expectBad.ok === true && expectBad.value.flows[0].steps.some((s) => s.status === "error"));

		// Action gating at the runner level (second fence after the tool's).
		const gated = await uiv.runUiFlows({ session, browser, family: fam17, flows: [{ id: "g", steps: [{ id: "s01", kind: "save" }] }], workspace: wsBase, serverVersion: "17.0", allowActions: false });
		check("runUiFlows refuses ACTION steps without allowActions", gated.ok === false && /allow_actions/.test(gated.error));

		// ---- matrix end-to-end: real browser, real per-user web sessions -------
		{
			const clientLib = await import(libUrl("odoo-client.js"));
			const matrixClient = new clientLib.OdooClient({ url: baseUrl, db: "qa", username: "adm", secret: "x", secretKind: "password" });
			const mSpec = mkdtempSync(join(tmpdir(), "uiv-me2e-"));
			mkdirSync(join(mSpec, "ui-verify"), { recursive: true });
			const writeFlows = (lockedExpected) =>
				writeFileSync(
					join(mSpec, "ui-verify", "flows.json"),
					JSON.stringify({
						schema: "dsh-odoo-sdd/ui-verify/flows/1",
						flows: [
							{ id: "member-flow", roles: { "my_mod.group_member": "ok" }, steps: [{ id: "s01", kind: "goto", target: { kind: "url", url: `${baseUrl}/web` } }] },
							{ id: "locked-flow", roles: { "my_mod.group_locked": lockedExpected }, steps: [{ id: "s01", kind: "goto", target: { kind: "url", url: `${baseUrl}/access-denied` } }] },
						],
					}),
				);
			const { calls, client: rpcFake } = mkMatrixClient({ groupRows: GROUP_ROWS });
			const auditLines = [];
			const matrixDeps = {
				projectRoot: () => mSpec,
				specDir: () => mSpec,
				client: () => rpcFake,
				environment: () => "dev",
				credentials: () => ({ url: baseUrl, db: "qa", username: "adm", secret: "x", secretKind: "password", environment: "dev" }),
				webSession: async () => ({ ok: true, value: session }),
				webSessionAs: async (login, password) => {
					const loginRes = await matrixClient.webLoginWith(login, password);
					if (!loginRes.ok) return { ok: false, error: loginRes.error };
					return { ok: true, value: { baseUrl, sessionId: loginRes.value.sessionId, uid: loginRes.value.uid } };
				},
				display: (v) => v,
				approve: async () => "allowed-once",
				audit: (exec, op, args, extra) => auditLines.push({ op, args, extra }),
				launchBrowser: async () => capture.resolveBrowser(pw.value.chromium, "auto", false),
			};
			const reg = new Map();
			uivTool.registerUiVerifyTool({ tools: { register: (t) => reg.set(t.name, t) } }, matrixDeps);
			const mtool = reg.get("odoo_ui_verify");

			writeFlows("denied");
			const res1 = await mtool.execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
			const rep1 = existsSync(join(mSpec, "ui-verify", "matrix-report.json")) ? JSON.parse(readFileSync(join(mSpec, "ui-verify", "matrix-report.json"), "utf8")) : null;
			check("the e2e matrix PASSED: denied met its access dialog and ok ran clean", res1.ok === true && rep1?.verdict === "PASSED" && rep1.cleanup === "deleted", `${res1.summary} ${rep1?.verdict}`);
			const gLocked = rep1.groups.find((g) => g.group === "my_mod.group_locked");
			const gMember = rep1.groups.find((g) => g.group === "my_mod.group_member");
			check("the denied flow ran under its own user and observed=denied", gLocked.flows[0].expected === "denied" && gLocked.flows[0].observed === "denied" && gLocked.flows[0].pass === true, JSON.stringify(gLocked.flows[0]));
			check("the ok flow observed=allowed under its own user", gMember.flows[0].expected === "ok" && gMember.flows[0].observed === "allowed" && gMember.flows[0].pass === true, JSON.stringify(gMember.flows[0]));
			check("each user got a per-login session cookie from the fake server", gLocked.login !== gMember.login && rep1.groups.every((g) => typeof g.uid === "number"), JSON.stringify(rep1.groups.map((g) => g.login)));
			check("e2e created and deleted one user per group", createCalls(calls).length === 2 && calls.some((c) => c.model === "res.users" && c.method === "unlink"));
			check("e2e audited creation and cleanup without the passwords", auditLines.length >= 2 && !JSON.stringify(auditLines).includes(createCalls(calls)[0].args[0].password));

			// expected denied but the flow runs clean → FAILED.
			writeFileSync(
				join(mSpec, "ui-verify", "flows.json"),
				JSON.stringify({
					schema: "dsh-odoo-sdd/ui-verify/flows/1",
					flows: [{ id: "locked-flow", roles: { "my_mod.group_locked": "denied" }, steps: [{ id: "s01", kind: "goto", target: { kind: "url", url: `${baseUrl}/web` } }] }],
				}),
			);
			const res2 = await mtool.execute({ operation: "matrix", spec_id: "x", module: "my_mod" });
			const rep2 = JSON.parse(readFileSync(join(mSpec, "ui-verify", "matrix-report.json"), "utf8"));
			check("expected denied but the flow ran → FAILED matrix", res2.ok === false && rep2.verdict === "FAILED" && rep2.groups[0].flows[0].observed === "allowed" && rep2.groups[0].flows[0].pass === false, `${res2.summary} ${JSON.stringify(rep2.groups[0].flows[0])}`);
			rmSync(mSpec, { recursive: true, force: true });
		}

		rmSync(wsBase, { recursive: true, force: true });
	}
} finally {
	if (browser) await browser.close().catch(() => {});
	server.close();
}

console.log(`\nui-verify: ${passed} checks passed`);
