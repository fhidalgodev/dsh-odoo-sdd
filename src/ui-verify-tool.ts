/**
 * `odoo_ui_verify` — the QA layer that runs a flow in a REAL browser and fails
 * it when the INTERFACE reports an error: an error dialog, a danger
 * notification, an invalid field, an uncaught js error, a 5xx or a JSON-RPC
 * body with `error`. RPC evidence can pass while the screen shows a
 * traceback; this tool exists because that is exactly what a plain
 * `odoo_execute` verification can never see.
 *
 * Artifacts live in <specDir>/ui-verify/: flows.json (the QA-authored flows),
 * report.json (run), crawl-report.json (the canon smoke crawl),
 * matrix-report.json (the per-role run) and images/ (the automatic
 * *-error.png evidence shots).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileAtomic } from "./atomic.js";
import { presentCall } from "./present.js";
import { sanitizeForPersist, type OdooCredentials } from "./credentials.js";
import { planRows } from "./sdd-state.js";
import { familyFor, loadPlaywright, resolveBrowser, type PwBrowser, type RpcResult } from "./manual-capture.js";
import { collectCanon, type CanonClient, type Row } from "./manual-canon.js";
import type { WebSessionResult } from "./manual-tool.js";
import { uiVerifyUsersReason, type ApprovalReason } from "./approval-i18n.js";
import {
	crawlFlowsFromCanon,
	lintUiFlows,
	runUiFlows,
	runUiMatrix,
	uiStepSafety,
	type UiFlow,
	type UiMatrixAccount,
	type UiMatrixReport,
	type UiVerifyOptions,
	type UiVerifyReport,
} from "./ui-verify.js";

/** The host approval seam, as requestNativeApproval reports it. */
type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface UiVerifyToolDeps {
	projectRoot: (exec?: unknown) => string;
	specDir: (specId: string | undefined, exec?: unknown) => string;
	/** The connected instance (clientForExec); undefined when not configured. */
	client: (exec?: unknown) => CanonClient | undefined;
	/** Declared environment of the connected instance (production refuses run). */
	environment: (exec?: unknown) => string | null | undefined;
	/** Loaded credentials for output redaction (never returned). */
	credentials: (exec?: unknown) => OdooCredentials | null;
	webSession: (exec?: unknown) => Promise<WebSessionResult>;
	display: (value: string) => string;
	/**
	 * matrix: web login for a just-created temporary user (client.webLoginWith
	 * under the hood). The password never reaches the result — only the session.
	 */
	webSessionAs?: (login: string, password: string, exec?: unknown) => Promise<WebSessionResult>;
	/** matrix: human approval before the first res.users.create (fail-closed). */
	approve?: (exec: unknown, reason: ApprovalReason) => Promise<ApprovalOutcome>;
	/** matrix: audit sink for user creation/cleanup (index.ts appendAuditLine). */
	audit?: (exec: unknown, op: string, args: unknown, extra?: { outcome?: "ok" | "error" | "denied"; reason?: string }) => void;
	/** Test hook: browser launcher for matrix (defaults to the real one). */
	launchBrowser?: (opts: { headed: boolean; browser: string }) => Promise<RpcResult<PwBrowser>>;
	/** Test hook: flow runner inside the matrix (defaults to runUiFlows). */
	runFlows?: (opts: UiVerifyOptions) => Promise<RpcResult<UiVerifyReport>>;
}

const FLOWS_FILE = "flows.json";
const FLOWS_SCHEMA = "dsh-odoo-sdd/ui-verify/flows/1";
const REPORT_FILE = "report.json";
const CRAWL_REPORT_FILE = "crawl-report.json";
const MATRIX_REPORT_FILE = "matrix-report.json";

type ToolResult = { ok: boolean; operation: string; summary: string; artifacts: string[]; detail: string };
const blocked = (operation: string, detail: string, artifacts: string[] = [], summary = "BLOCKED"): ToolResult => ({
	ok: false,
	operation,
	summary,
	artifacts,
	detail,
});

interface FlowsFile {
	schema?: string;
	flows?: UiFlow[];
}

function readFlowsFile(dir: string): { ok: true; flows: UiFlow[] } | { ok: false; error: string } {
	const file = join(dir, FLOWS_FILE);
	if (!existsSync(file)) return { ok: false, error: `there is no ${FLOWS_FILE} in the ui-verify workspace: run operation=plan first` };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as FlowsFile;
		if (parsed?.schema !== FLOWS_SCHEMA || !Array.isArray(parsed.flows)) {
			return { ok: false, error: `${FLOWS_FILE} is not a ${FLOWS_SCHEMA} document` };
		}
		return { ok: true, flows: parsed.flows };
	} catch (e) {
		return { ok: false, error: `${FLOWS_FILE} is not readable JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** Register the `odoo_ui_verify` tool. */
export function registerUiVerifyTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: UiVerifyToolDeps,
): void {
	ctx.tools.register(
		defineTool({
			name: "odoo_ui_verify",
			presentCall: (args: unknown) => presentCall("odoo_ui_verify", args),
			description:
				"UI verification in a real browser: fails a step when the interface reports an error " +
				"(error dialog, danger notification, invalid field, js error, 5xx, JSON-RPC error body) — " +
				"what RPC evidence cannot see. plan drafts flows.json from the ui rows of test-plan.md; " +
				"lint checks the flows; crawl runs a read-only smoke over every module menu (module=); " +
				"run executes the flows (ACTION steps need allow_actions + confirm_destructive); " +
				"matrix runs the role matrix in flows.json with one approved temporary user per group " +
				"(writes matrix-report.json); status summarizes the reports. Artifacts land in <spec>/ui-verify/.",
			parameters: {
				operation: {
					type: "string",
					required: true,
					enum: ["plan", "lint", "run", "crawl", "matrix", "status"],
					description:
						"plan: draft/merge flows.json from test-plan.md ui rows (create-only). " +
						"lint: check flows.json structure and AC coverage. " +
						"run: execute the flows (writes report.json; NEEDS_BROWSER when no browser). " +
						"crawl: read-only smoke over the module canon (writes crawl-report.json). " +
						"matrix: role matrix — one approved temporary sddqa_* user per group runs the flows " +
						"that declare its role (writes matrix-report.json; users are deleted afterwards). " +
						"status: summarize the persisted reports.",
				},
				spec_id: {
					type: "string",
					required: true,
					description: "Spec id whose directory holds the ui-verify workspace.",
				},
				flow: {
					type: "string",
					description: "run/matrix: a single flow id from flows.json (default: every flow).",
				},
				groups: {
					type: "array",
					items: { type: "string" },
					description:
						"matrix: group xmlids to verify (default: every group the flows declare in roles). " +
						"One temporary user is created per group after native approval.",
				},
				from_step: {
					type: "string",
					description: "run: resume the named flow from this step id.",
				},
				module: {
					type: "string",
					description: "crawl/matrix: technical module name to collect the canon for (required).",
				},
				modules: {
					type: "array",
					items: { type: "string" },
					description: "crawl: additional modules to inventory alongside module.",
				},
				allow_actions: {
					type: "boolean",
					description: "run: ALLOW action steps (fill/select/click/save/…). Requires confirm_destructive. DISPOSABLE database only.",
				},
				confirm_destructive: {
					type: "boolean",
					description: "run: REQUIRED true when allow_actions=true (UI effects are not journalable).",
				},
				headed: {
					type: "boolean",
					description: "run/crawl: run the browser headed (visible). Default headless.",
				},
				browser: {
					type: "string",
					enum: ["auto", "chromium", "chrome", "msedge"],
					description: "run/crawl: which browser. auto = bundled Chromium → Chrome → Edge.",
				},
				ignore: {
					type: "array",
					items: { type: "string" },
					description: "run/crawl: regex patterns for findings to silence (dropped but counted; justify each in the KB).",
				},
				continue_on_error: {
					type: "boolean",
					description: "run: keep executing after a failing step instead of stopping at the first error.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						operation: { type: "string", required: true },
						summary: { type: "string", required: true },
						artifacts: { type: "array", required: true, items: { type: "string" } },
						detail: { type: "string", required: true },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { detail: string }).detail }],
			},
			async execute(
				args: {
					operation: "plan" | "lint" | "run" | "crawl" | "matrix" | "status";
					spec_id: string;
					flow?: string;
					groups?: string[];
					from_step?: string;
					module?: string;
					modules?: string[];
					allow_actions?: boolean;
					confirm_destructive?: boolean;
					headed?: boolean;
					browser?: "auto" | "chromium" | "chrome" | "msedge";
					ignore?: string[];
					continue_on_error?: boolean;
				},
				exec?: unknown,
			): Promise<ToolResult> {
				const specDir = deps.specDir(args.spec_id, exec);
				if (!existsSync(specDir)) {
					return blocked(args.operation, `BLOCKED — spec ${args.spec_id} has no directory at ${deps.display(specDir)}.`);
				}
				const wsDir = join(specDir, "ui-verify");
				if (args.operation === "plan") return planOp(args.spec_id, specDir, wsDir);
				if (args.operation === "lint") return lintOp(args.spec_id, specDir, wsDir);
				if (args.operation === "status") return statusOp(wsDir, deps);
				if (args.operation === "matrix") return matrixOp(args, specDir, wsDir, deps, exec);
				return browserOp(args, specDir, wsDir, deps, exec);
			},
		}),
	);
}

// ---------------------------------------------------------------------------
// plan / lint / status — local operations (no instance, no browser)
// ---------------------------------------------------------------------------

/** plan: one skeleton flow per `ui` test-plan row — create-only merge. */
function planOp(specId: string, specDir: string, wsDir: string): ToolResult {
	const artifacts: string[] = [];
	const rows = planRows(specDir);
	const uiAcs = rows.filter((r) => /\bui\b/i.test(r.layer)).map((r) => r.ac);
	if (uiAcs.length === 0) {
		return blocked(
			"plan",
			"BLOCKED — test-plan.md has no row at layer `ui`: flows are planned per UI acceptance criterion, " +
				"not invented. Mark the AC rows a browser must prove with layer `ui` (or `rpc,ui`).",
		);
	}
	let flows: UiFlow[] = [];
	const existing = readFlowsFile(wsDir);
	if (existsSync(join(wsDir, FLOWS_FILE))) {
		if (!existing.ok) return blocked("plan", `BLOCKED — ${existing.error}`);
		flows = existing.flows;
	}
	const covered = new Set(flows.flatMap((f) => f.ac ?? []));
	const added: string[] = [];
	for (const ac of uiAcs) {
		if (covered.has(ac)) continue;
		const id = `ui-${ac.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
		flows.push({
			id,
			title: `Verify ${ac}`,
			ac: [ac],
			steps: [
				{
					id: "s01",
					kind: "goto",
					procedure: `TODO: complete the verification flow of ${ac} — a bare goto without a target is INVALID and lint reports it until the QA writes the real steps.`,
				},
			],
		});
		added.push(id);
	}
	if (added.length === 0 && existing.ok) {
		return { ok: true, operation: "plan", summary: `flows.json already covers every ui AC (${uiAcs.join(", ")})`, artifacts, detail: `No new flows needed: ${uiAcs.join(", ")} are all referenced by existing flows.` };
	}
	writeFileAtomic(join(wsDir, FLOWS_FILE), JSON.stringify({ schema: FLOWS_SCHEMA, flows }, null, 2) + "\n");
	artifacts.push(`ui-verify/${FLOWS_FILE}`);
	return {
		ok: true,
		operation: "plan",
		summary: `planned ${added.length} skeleton flow(s) for ${uiAcs.length} ui AC(s)`,
		artifacts,
		detail:
			`${FLOWS_FILE} now holds ${flows.length} flow(s); added: ${added.join(", ") || "(none)"}.\n` +
			"Each skeleton step is deliberately INVALID (a goto without a target): lint reports ERROR until the QA " +
			"writes the real steps. See references/ui-verify.md for the step vocabulary, then run operation=lint and " +
			"operation=run — the flows are evidence, so write what the user does, never a flow that hides an error.",
	};
}

/** lint: structural check + ui AC coverage of flows.json. */
function lintOp(specId: string, specDir: string, wsDir: string): ToolResult {
	const loaded = readFlowsFile(wsDir);
	if (!loaded.ok) return blocked("lint", `BLOCKED — ${loaded.error}`);
	const rows = planRows(specDir).map((r) => ({ ac: r.ac, layer: r.layer }));
	const findings = lintUiFlows(loaded.flows, rows);
	const errors = findings.filter((f) => f.severity === "ERROR").length;
	const lines = findings.length === 0 ? ["No findings."] : findings.map((f) => `- [${f.severity}] ${f.rule}${f.flow ? ` (${f.flow}${f.step ? `/${f.step}` : ""})` : ""}: ${f.message}`);
	return {
		ok: errors === 0,
		operation: "lint",
		summary: `${findings.length} finding(s) (${errors} ERROR)`,
		artifacts: [],
		detail: [...lines, "", errors > 0 ? `${errors} ERROR — fix flows.json before running.` : "Clean: the flows can run."].join("\n"),
	};
}

/** status: summarize whatever reports the workspace holds. */
function statusOp(wsDir: string, deps: UiVerifyToolDeps): ToolResult {
	const lines: string[] = [];
	const artifacts: string[] = [];
	const readReport = (file: string): UiVerifyReport | null => {
		const path = join(wsDir, file);
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as UiVerifyReport;
		} catch {
			return null;
		}
	};
	for (const [file, label] of [
		[REPORT_FILE, "run"],
		[CRAWL_REPORT_FILE, "crawl"],
	] as const) {
		const report = readReport(file);
		if (report === null) continue;
		artifacts.push(`ui-verify/${file}`);
		const findings = report.flows.flatMap((f) => f.steps.flatMap((s) => s.findings ?? []));
		lines.push(`[${label}] verdict ${report.verdict} — ${report.flows.length} flow(s), ${findings.length} finding(s), ignored: ${report.ignoredCount} (server ${report.serverVersion}${report.environment ? `, env ${report.environment}` : ""})`);
		for (const flow of report.flows) {
			lines.push(`  ${flow.id}: ${flow.status} (${flow.steps.length} steps, ${flow.findings} finding(s))`);
		}
		if (Object.keys(report.evidence).length > 0) {
			lines.push("  suggested evidence lines:");
			for (const [ac, ev] of Object.entries(report.evidence)) lines.push(`    ${ac}: ${ev}`);
		}
	}
	if (lines.length === 0) {
		return blocked("status", `BLOCKED — no ui-verify report yet in ${deps.display(wsDir)}: run operation=run or operation=crawl first.`);
	}
	return { ok: true, operation: "status", summary: "reports summarized", artifacts, detail: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// run / crawl — the browser operations
// ---------------------------------------------------------------------------

/**
 * Write the verdict the gate reads even when there is no browser: a
 * NEEDS_BROWSER report is the honest record of "verification required but the
 * tool could not run here", so `sdd_phase succeed` can reason about it.
 */
function writeNeedsBrowser(wsDir: string, mode: "flows" | "crawl", serverVersion: string, reason: string, environment?: string | null): void {
	const report: UiVerifyReport = {
		schema: "dsh-odoo-sdd/ui-verify/1",
		mode,
		verdict: "NEEDS_BROWSER",
		startedAt: new Date().toISOString(),
		serverVersion,
		...(environment ? { environment } : {}),
		flowsHash: "",
		ignore: [],
		ignoredCount: 0,
		originLocked: true,
		flows: [],
		evidence: {},
	};
	writeFileAtomic(join(wsDir, mode === "crawl" ? CRAWL_REPORT_FILE : REPORT_FILE), JSON.stringify({ ...report, reason }, null, 2) + "\n");
}

interface BrowserArgs {
	operation: "plan" | "lint" | "run" | "crawl" | "matrix" | "status";
	spec_id: string;
	flow?: string;
	groups?: string[];
	from_step?: string;
	module?: string;
	modules?: string[];
	allow_actions?: boolean;
	confirm_destructive?: boolean;
	headed?: boolean;
	browser?: "auto" | "chromium" | "chrome" | "msedge";
	ignore?: string[];
	continue_on_error?: boolean;
}

async function browserOp(
	args: BrowserArgs,
	specDir: string,
	wsDir: string,
	deps: UiVerifyToolDeps,
	exec?: unknown,
): Promise<ToolResult> {
	const artifacts: string[] = [];
	const client = deps.client(exec);
	if (client === undefined) {
		return blocked(args.operation, "NEEDS_INSTANCE — the browser needs the instance URL and version: run the connection onboarding (odoo_setup) first.", artifacts, "NEEDS_INSTANCE");
	}
	// A UI run can hold ACTION steps, which no journal can replay: production
	// is refused outright, and the two odoo_manual fences apply unchanged.
	const environment = deps.environment(exec) ?? null;
	if (args.operation === "run" && environment === "production") {
		return blocked(args.operation, "BLOCKED — the declared environment is production: an automated UI run (even read-only) is refused. Point the plugin at a disposable dev/staging database.");
	}
	// Validate the ignore patterns up front: a broken regex must not reach the probe.
	const ignore: RegExp[] = [];
	for (const raw of args.ignore ?? []) {
		try {
			ignore.push(new RegExp(raw));
		} catch (e) {
			return blocked(args.operation, `BLOCKED — ignore pattern ${JSON.stringify(raw)} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	let flows: UiFlow[];
	let mode: "flows" | "crawl";
	let flowsHash: string | undefined;
	if (args.operation === "run") {
		mode = "flows";
		const file = join(wsDir, FLOWS_FILE);
		const loaded = readFlowsFile(wsDir);
		if (!loaded.ok) return blocked("run", `BLOCKED — ${loaded.error}`);
		flows = loaded.flows;
		flowsHash = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
		const selected = args.flow === undefined ? flows : flows.filter((f) => f.id === args.flow);
		if (args.flow !== undefined && selected.length === 0) {
			return blocked("run", `BLOCKED — flow ${args.flow} is not in ${FLOWS_FILE}.`);
		}
	} else {
		mode = "crawl";
		const moduleName = args.module;
		if (!moduleName) {
			return blocked("crawl", "BLOCKED — crawl needs module: the canon smoke is generated from the module's own menus, actions and views (odoo_ui_verify operation=crawl module=<name>).");
		}
		const versionProbe = await client.version();
		if (!versionProbe.ok) {
			return blocked("crawl", `Cannot probe the server version: ${versionProbe.error}`, artifacts, "INSTANCE UNREACHABLE");
		}
		// The canon is read per model: the module's first model anchors it, same
		// rule odoo_manual uses for a module-first request.
		const pick = await client.executeKw<Row[]>("ir.model", "search_read", [[["modules", "like", moduleName]], ["model", "modules"]], { limit: 200 });
		if (!pick.ok) return blocked("crawl", `BLOCKED — could not list the module's models: ${pick.error}`);
		const first = pick.value.find((r) => String(r["modules"] ?? "").split(",").map((x) => x.trim()).includes(moduleName));
		if (!first) {
			return blocked("crawl", `BLOCKED — module "${moduleName}" declares no model in ir.model.modules: check the technical name.`);
		}
		const requestedModules = [...new Set([moduleName, ...(args.modules ?? [])])].filter((m) => m.trim() !== "");
		const result = await collectCanon(client, {
			model: String(first["model"] ?? ""),
			serverVersion: versionProbe.value.server_version,
			module: moduleName,
			modules: requestedModules,
			moduleName,
		});
		if (!result.ok) return blocked("crawl", `BLOCKED — ${result.blocked}`);
		flows = crawlFlowsFromCanon(result.canon);
		if (flows.length === 0) {
			return blocked(
				"crawl",
				`BLOCKED — the canon of ${moduleName} carries no menu that opens an act_window: there is no UI surface to smoke. ` +
					"If the module really has no views, say so in architecture.md `## Views` (\"none\") instead of running a crawl.",
			);
		}
	}

	// Gate 1 (run only): action steps need the explicit allow.
	const selectedFlows = args.operation === "run" && args.flow !== undefined ? flows.filter((f) => f.id === args.flow) : flows;
	if (args.operation === "run") {
		const gate = actionGate("run", selectedFlows, args);
		if (gate !== null) return gate;
	}

	const session = await deps.webSession(exec);
	if (!session.ok) {
		const kind = session.errorKind === "needs_session" ? "NEEDS_WEB_SESSION" : "BLOCKED";
		return blocked(args.operation, `${kind} — ${session.error}`, artifacts, kind);
	}
	const version = await client.version();
	if (!version.ok) return blocked(args.operation, `Cannot probe the server version: ${version.error}`, artifacts, "INSTANCE UNREACHABLE");
	const fam = familyFor(version.value.server_version);
	if (!fam.ok) return blocked(args.operation, `BLOCKED — ${fam.error}`);

	const pw = await loadPlaywright();
	if (!pw.ok) {
		writeNeedsBrowser(wsDir, mode, version.value.server_version, pw.error, environment);
		return blocked(args.operation, `NEEDS_BROWSER — ${pw.error} A NEEDS_BROWSER report was written so the verify gate records the requirement instead of guessing a pass.`, artifacts, "NEEDS_BROWSER");
	}
	const browserChoice = args.browser ?? "auto";
	const opened = await resolveBrowser(pw.value.chromium, browserChoice, args.headed === true);
	if (!opened.ok) {
		writeNeedsBrowser(wsDir, mode, version.value.server_version, opened.error, environment);
		return blocked(args.operation, `${opened.error} A NEEDS_BROWSER report was written so the verify gate records the requirement instead of guessing a pass.`, artifacts, "NEEDS_BROWSER");
	}

	const credentials = deps.credentials(exec);
	const res = await runUiFlows({
		session: session.value,
		browser: opened.value,
		family: fam.value.family,
		flows,
		mode,
		flow: args.operation === "run" ? args.flow : undefined,
		fromStep: args.from_step,
		allowActions: args.operation === "run" && args.allow_actions === true,
		continueOnError: args.operation === "crawl" ? true : args.continue_on_error === true,
		ignore,
		redact: (text) => sanitizeForPersist(text, credentials),
		workspace: wsDir,
		serverVersion: version.value.server_version,
		environment,
		flowsHash,
	}).finally(() => opened.value.close().catch(() => {}));

	if (!res.ok) return blocked(args.operation, `BLOCKED — ${res.error}`);
	const report = res.value;
	artifacts.push(`ui-verify/${mode === "crawl" ? CRAWL_REPORT_FILE : REPORT_FILE}`);
	const errorShots = report.flows.flatMap((f) => f.steps.filter((s) => s.capture).map((s) => `ui-verify/${s.capture}`));
	artifacts.push(...errorShots);
	const findingLines = report.flows.flatMap((f) =>
		f.steps.flatMap((s) => (s.findings ?? []).map((finding) => `  ${f.id}/${s.id} [${finding.kind}] ${finding.message}`)),
	);
	const detail = [
		`verdict: ${report.verdict} (${report.flows.filter((f) => f.status === "ok").length}/${report.flows.length} flow(s) clean, ignored findings: ${report.ignoredCount})`,
		...report.flows.map((f) => `${f.id}: ${f.status} — ${f.steps.length} step(s)${f.findings > 0 ? `, ${f.findings} finding(s)` : ""}`),
		...(findingLines.length > 0 ? ["findings:", ...findingLines.slice(0, 20)] : []),
		...(Object.keys(report.evidence).length > 0
			? ["evidence lines for test-plan.md:", ...Object.entries(report.evidence).map(([ac, ev]) => `  ${ac}: ${ev}`)]
			: []),
	].join("\n");
	return {
		ok: report.verdict === "PASSED",
		operation: args.operation,
		summary: `${report.verdict}: ${report.flows.length} flow(s) run, ${findingLines.length} finding(s)`,
		artifacts,
		detail,
	};
}

// ---------------------------------------------------------------------------
// matrix — role-based verification with approved temporary users
// ---------------------------------------------------------------------------

/**
 * The two fences every op that can run ACTION steps shares: action steps need
 * allow_actions=true, and allow_actions needs confirm_destructive=true (UI
 * effects are not journalable).
 * @returns the blocking result, or null when the gates pass.
 */
function actionGate(
	operation: string,
	flows: UiFlow[],
	args: { allow_actions?: boolean; confirm_destructive?: boolean },
): ToolResult | null {
	const hasActions = flows.some((f) => f.steps.some((s) => uiStepSafety(s) === "action"));
	if (hasActions && args.allow_actions !== true) {
		return blocked(
			operation,
			"BLOCKED — the flow set contains ACTION steps (new/fill/select/press/click/save/discard/click_text/add_line) and allow_actions is not true. " +
				"Write read-only flows (goto/menu/open_row/switch_view/search/expect_*/screenshot), or re-run with allow_actions=true AND confirm_destructive=true on a DISPOSABLE database: UI clicks are NOT journalable.",
		);
	}
	if (args.allow_actions === true && args.confirm_destructive !== true) {
		return blocked(
			operation,
			"CONFIRM_REQUIRED — allow_actions=true also needs confirm_destructive=true: the clicks are real UI effects on the instance that no journal can replay. Run against a disposable database.",
			[],
			"CONFIRM_REQUIRED",
		);
	}
	return null;
}

/**
 * Persist the matrix verdicts the runner never reached: NEEDS_BROWSER and
 * NOT_APPROVED still leave a report so the succeed gate can tell "attempted"
 * from "never ran".
 */
function writeMatrixStub(
	wsDir: string,
	verdict: "NEEDS_BROWSER" | "NOT_APPROVED",
	opts: { serverVersion?: string; environment?: string | null; accounts?: UiMatrixAccount[]; reason?: string },
): void {
	const report: UiMatrixReport = {
		schema: "dsh-odoo-sdd/ui-verify-matrix/1",
		mode: "matrix",
		verdict,
		startedAt: new Date().toISOString(),
		serverVersion: opts.serverVersion ?? "",
		...(opts.environment ? { environment: opts.environment } : {}),
		flowsHash: "",
		ignore: [],
		ignoredCount: 0,
		groups: (opts.accounts ?? []).map((a) => ({ group: a.xmlid, resId: a.resId, login: a.login, flows: [] })),
		createdUserIds: [],
		cleanup: "none",
		...(opts.reason !== undefined ? { error: opts.reason } : {}),
	};
	writeFileAtomic(join(wsDir, MATRIX_REPORT_FILE), JSON.stringify(report, null, "\t") + "\n");
}

/**
 * matrix: create one temporary `sddqa_*` user per group — ONLY after every
 * group xmlid is resolved and a human approved natively — run each group's
 * flows under its own web session, and always clean the users up.
 * Fail-closed: no approval ⇒ not a single `res.users.create`.
 */
async function matrixOp(
	args: BrowserArgs,
	specDir: string,
	wsDir: string,
	deps: UiVerifyToolDeps,
	exec?: unknown,
): Promise<ToolResult> {
	const artifacts: string[] = [];
	const client = deps.client(exec);
	if (client === undefined) {
		return blocked("matrix", "NEEDS_INSTANCE — the matrix creates users over RPC and logs them in: run the connection onboarding (odoo_setup) first.", artifacts, "NEEDS_INSTANCE");
	}
	// Creating users on a production database is refused outright — same as run.
	const environment = deps.environment(exec) ?? null;
	if (environment === "production") {
		return blocked("matrix", "BLOCKED — the declared environment is production: the role matrix creates temporary res.users records and runs a browser session, so it is refused. Point the plugin at a disposable dev/staging database.");
	}
	const credentials = deps.credentials(exec);
	const redact = (text: string) => sanitizeForPersist(text, credentials);

	// Validate the ignore patterns up front: a broken regex must not reach the probe.
	const ignore: RegExp[] = [];
	for (const raw of args.ignore ?? []) {
		try {
			ignore.push(new RegExp(raw));
		} catch (e) {
			return blocked("matrix", `BLOCKED — ignore pattern ${JSON.stringify(raw)} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Roles live in flows.json: without it there is nothing to verify per role.
	const loaded = readFlowsFile(wsDir);
	if (!loaded.ok) return blocked("matrix", `BLOCKED — ${loaded.error}`);
	const flows = args.flow === undefined ? loaded.flows : loaded.flows.filter((f) => f.id === args.flow);
	if (args.flow !== undefined && flows.length === 0) {
		return blocked("matrix", `BLOCKED — flow ${args.flow} is not in ${FLOWS_FILE}.`);
	}
	const declared = [...new Set(flows.flatMap((f) => Object.keys(f.roles ?? {})))];
	const xmlids = (args.groups ?? declared).filter((x) => typeof x === "string" && x.trim() !== "");
	if (xmlids.length === 0) {
		return blocked(
			"matrix",
			"BLOCKED — no role to verify: every matrix flow must declare the expected outcome per group, " +
				`e.g. "roles": {"my_module.group_manager": "ok", "my_module.group_user": "denied"}. ` +
				"Pass groups=[...] to pick a subset of the declared ones.",
		);
	}
	const moduleName = args.module;
	if (!moduleName) {
		return blocked("matrix", "BLOCKED — matrix needs module: the canon carries the group field name (groups_id / group_ids) for this server version.");
	}

	// The canon is read per model: the module's first model anchors it, same
	// rule odoo_manual uses for a module-first request.
	const pick = await client.executeKw<Row[]>("ir.model", "search_read", [[["modules", "like", moduleName]], ["model", "modules"]], { limit: 200 });
	if (!pick.ok) return blocked("matrix", `BLOCKED — could not list the module's models: ${pick.error}`);
	const first = pick.value.find((r) => String(r["modules"] ?? "").split(",").map((x) => x.trim()).includes(moduleName));
	if (!first) {
		return blocked("matrix", `BLOCKED — module "${moduleName}" declares no model in ir.model.modules: check the technical name.`);
	}
	const versionProbe = await client.version();
	if (!versionProbe.ok) {
		return blocked("matrix", `Cannot probe the server version: ${versionProbe.error}`, artifacts, "INSTANCE UNREACHABLE");
	}
	const canonRes = await collectCanon(client, {
		model: String(first["model"] ?? ""),
		serverVersion: versionProbe.value.server_version,
		module: moduleName,
		modules: [moduleName],
		moduleName,
	});
	if (!canonRes.ok) return blocked("matrix", `BLOCKED — ${canonRes.blocked}`);
	const groupsAttr = canonRes.canon.groupsAttr;

	// Resolve EVERY group xmlid before asking a human anything: an approver must
	// see the real list, and a typo must fail before the first create.
	const wanted = ["base.group_user", ...xmlids];
	const parts = wanted.map((x) => {
		const dot = x.indexOf(".");
		return { xmlid: x, module: dot === -1 ? "" : x.slice(0, dot), name: dot === -1 ? x : x.slice(dot + 1) };
	});
	const rows = await client.executeKw<Row[]>(
		"ir.model.data",
		"search_read",
		[
			[
				["model", "=", "res.groups"],
				["module", "in", [...new Set(parts.map((p) => p.module))]],
				["name", "in", [...new Set(parts.map((p) => p.name))]],
			],
		],
		{ fields: ["module", "name", "res_id"] },
	);
	if (!rows.ok) return blocked("matrix", `BLOCKED — could not resolve the group xmlids in ir.model.data: ${rows.error}`);
	const resolved = new Map<string, number>(
		(rows.value ?? []).map((r) => [`${String(r["module"])}.${String(r["name"])}`, Number(r["res_id"])]),
	);
	const missing = wanted.filter((x) => !resolved.has(x));
	if (missing.length > 0) {
		return blocked(
			"matrix",
			`BLOCKED — unknown group xmlid(s): ${missing.join(", ")}. Fix flows.json roles (or the groups argument) — no user was created.`,
		);
	}
	const accounts: UiMatrixAccount[] = xmlids.map((x, i) => ({
		xmlid: x,
		resId: resolved.get(x) ?? 0,
		login: `sddqa_${i + 1}_${randomBytes(2).toString("hex")}`,
	}));

	// Same two fences as run, over the flows the matrix will actually execute.
	const involved = flows.filter((f) => xmlids.some((x) => f.roles?.[x] !== undefined));
	const gate = actionGate("matrix", involved, args);
	if (gate !== null) return gate;

	// A deterministic blocker first: asking a human to approve a run this
	// machine cannot execute would be noise. The browser is launched BEFORE the
	// approval so NEEDS_BROWSER needs no human at all.
	const pw = await loadPlaywright();
	if (!pw.ok) {
		writeMatrixStub(wsDir, "NEEDS_BROWSER", { serverVersion: versionProbe.value.server_version, environment, accounts, reason: pw.error });
		return blocked("matrix", `NEEDS_BROWSER — ${pw.error} A NEEDS_BROWSER matrix report was written so the verify gate records the requirement instead of guessing a pass.`, artifacts, "NEEDS_BROWSER");
	}
	const launcher =
		deps.launchBrowser ??
		(async (o: { headed: boolean; browser: string }) => resolveBrowser(pw.value.chromium, o.browser as "auto", o.headed));
	const opened = await launcher({ headed: args.headed === true, browser: args.browser ?? "auto" });
	if (!opened.ok) {
		writeMatrixStub(wsDir, "NEEDS_BROWSER", { serverVersion: versionProbe.value.server_version, environment, accounts, reason: opened.error });
		return blocked("matrix", `${opened.error} A NEEDS_BROWSER matrix report was written so the verify gate records the requirement instead of guessing a pass.`, artifacts, "NEEDS_BROWSER");
	}
	const fam = familyFor(versionProbe.value.server_version);
	if (!fam.ok) {
		await opened.value.close().catch(() => {});
		return blocked("matrix", `BLOCKED — ${fam.error}`);
	}

	try {
		// Fail-closed: without an approval seam, or with anything but
		// "allowed-once", NOT A SINGLE res.users.create is sent.
		if (deps.approve === undefined || deps.webSessionAs === undefined) {
			writeMatrixStub(wsDir, "NOT_APPROVED", { serverVersion: versionProbe.value.server_version, environment, accounts, reason: "no approval service" });
			return blocked("matrix", "NOT_APPROVED — no approval service answered: the matrix creates users on the instance, so it refuses to run without a human gate. No user was created.", artifacts, "NOT_APPROVED");
		}
		const target = `${credentials?.url ?? "instance"} (db=${credentials?.db ?? "?"})`;
		const outcome = await deps.approve(
			exec,
			uiVerifyUsersReason({
				specId: args.spec_id,
				logins: accounts.map((a) => a.login),
				groups: xmlids,
				target,
				environment: environment ?? "unknown",
			}),
		);
		if (outcome !== "allowed-once") {
			writeMatrixStub(wsDir, "NOT_APPROVED", { serverVersion: versionProbe.value.server_version, environment, accounts, reason: `approval ${outcome}` });
			return blocked("matrix", `NOT_APPROVED — the temporary-user creation was ${outcome}: no user was created and nothing was written to the instance.`, artifacts, "NOT_APPROVED");
		}

		const report = await runUiMatrix({
			workspace: wsDir,
			flows,
			accounts,
			baseGroupId: resolved.get("base.group_user") ?? 0,
			groupsAttr,
			browser: opened.value,
			family: fam.value.family,
			executeKw: (model, method, kwArgs, kwargs) => client.executeKw(model, method, kwArgs, kwargs),
			sessionAs: (login, password) => deps.webSessionAs?.(login, password, exec) ?? Promise.resolve({ ok: false, error: "no webSessionAs dependency" }),
			audit: deps.audit === undefined ? undefined : (op, auditArgs, extra) => deps.audit?.(exec, op, auditArgs, extra),
			serverVersion: versionProbe.value.server_version,
			environment,
			allowActions: args.allow_actions === true,
			ignore,
			redact,
			runFlows: deps.runFlows,
		});
		artifacts.push(`ui-verify/${MATRIX_REPORT_FILE}`);

		const flowCount = report.groups.reduce((n, g) => n + g.flows.length, 0);
		const groupLines = report.groups.flatMap((g) =>
			[
				`${g.group} → ${g.login}${g.userId !== undefined ? ` (user ${g.userId})` : ""}${g.error !== undefined ? ` — ${g.error}` : ""}`,
				...g.flows.map((f) => `  ${f.id}: expected ${f.expected}, observed ${f.observed} — ${f.pass ? "pass" : "FAIL"}${f.note !== undefined ? ` (${f.note})` : ""} (${f.findings} finding(s))`),
			],
		);
		const detail = [
			`verdict: ${report.verdict} — ${report.groups.length} group(s), ${flowCount} flow run(s), cleanup: ${report.cleanup}`,
			...(report.error !== undefined ? [`error: ${report.error}`] : []),
			...groupLines,
			...(report.cleanup === "pending"
				? [`CLEANUP PENDING — remove these temporary users by hand: ${report.groups.map((g) => `${g.login} (id ${g.userId ?? "?"})`).join(", ")}`]
				: []),
		].join("\n");
		const ok = report.verdict === "PASSED";
		return {
			ok,
			operation: "matrix",
			summary:
				report.verdict === "CLEANUP_PENDING"
					? `CLEANUP_PENDING — matrix ${report.error !== undefined || resultsFailed(report) ? "ran with failures" : "ran"} but ${report.createdUserIds.length} temporary user(s) could not be removed: ${report.groups.map((g) => g.login).join(", ")}`
					: `${report.verdict}: ${report.groups.length} group(s), ${flowCount} flow run(s), users ${report.cleanup}`,
			artifacts,
			detail,
		};
	} finally {
		await opened.value.close().catch(() => {});
	}
}

function resultsFailed(report: UiMatrixReport): boolean {
	return report.groups.some((g) => g.flows.some((f) => !f.pass));
}
