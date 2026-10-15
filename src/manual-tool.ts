/**
 * `odoo_manual` — the narrated user manual tool. Fase 1 registers the tool
 * with the `canon` operation: read the functional canon of a model from the
 * instance (NEVER invented), persist it with its fingerprint in the manual
 * workspace, and summarize it. Later phases add plan/lint/render/capture.
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveModuleDir } from "./paths.js";
import { writeFileAtomic } from "./atomic.js";
import {
	resolveManualWorkspace,
	readStoryboard,
	nextFlowId,
	stepSafety,
	writeStoryboard,
	planStoryboard,
	validateStoryboard,
	type ManualsMode,
	type Storyboard,
	type StoryboardFinding,
} from "./manual-model.js";
import { importRecording } from "./manual-import.js";
import {
	collectCanon,
	canonFingerprint,
	summarizeCanon,
	type Canon,
	type CanonClient,
} from "./manual-canon.js";
import { renderManual, collectProseFindings } from "./manual-render.js";
import { captureFlow, exploreScreen, familyFor, loadPlaywright, resolveBrowser } from "./manual-capture.js";

export interface ManualToolDeps {
	projectRoot: (exec?: unknown) => string;
	specDir: (specId: string | undefined, exec?: unknown) => string;
	/** Base directory that holds spec directories (project or central layout). */
	specsBase: (exec?: unknown) => string;
	manuals: (exec?: unknown) => { mode: ManualsMode; dir: string };
	configuredLanguage: (exec?: unknown) => string | undefined;
	/** The connected instance (clientForExec); undefined when not configured. */
	client: (exec?: unknown) => CanonClient | undefined;
	display: (value: string) => string;
	/** Local Community / Enterprise checkouts, for native error evidence. */
	repos?: (exec?: unknown) => { communityPath?: string; enterprisePath?: string };
	/**
	 * A web session for the browser: OdooClient.webLogin (in-memory cookie,
	 * never written when the host hands it over) or .sdd/session.json.
	 * An API-key credential fails here with NEEDS_WEB_SESSION.
	 */
	webSession: (exec?: unknown) => Promise<WebSessionResult>;
}

const CANON_FILE = "canon.json";

/** A web session for the browser, resolved by the host (in-memory preferred). */
export type WebSessionResult = { ok: true; value: import("./manual-capture.js").CaptureSession } | { ok: false; error: string; errorKind?: string };

/**
 * Register the `odoo_manual` tool.
 * @param ctx - registrant context exposing the tool registry.
 * @param deps - live configuration lookups.
 */
export function registerManualTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: ManualToolDeps,
): void {
	ctx.tools.register(
		defineTool({
			name: "odoo_manual",
			description:
				"Narrated user manuals built ON EVIDENCE: the functional canon of a model is read " +
				"from the instance (views, buttons, states, fields, groups, errors), the story is " +
				"planned against it and linted before it is written, and screens are captured with " +
				"an embedded read-only-first browser. operation=canon reads and persists the canon " +
				"(the entry point; the manual may only describe what it says). The manual lives " +
				"where Settings says: manualsMode specs (next to the spec, default), docs " +
				"(<projectRoot>/<manualsDir>) or module (OCA fragments under readme/manual/). " +
				"Standalone work without a spec is a first-class path: it never blocks on a missing spec.",
			parameters: {
				operation: {
					type: "string",
					required: true,
					enum: ["canon", "plan", "lint", "render", "explore", "capture", "import"],
					description:
						"canon: read the functional canon from the instance (entry point). " +
						"plan: draft the storyboard skeleton from the stored canon. " +
						"lint: check the narration (AI-tell heuristics WARN, structure ERROR) and the canon rules. " +
						"render: write MANUAL.md + index.html (hand-edited files are never overwritten without overwrite=true). " +
						"explore: read-only aria snapshot of one screen (menu/record/url of the SAME origin). " +
						"capture: run flow steps in a real browser; read-only steps always, ACTION steps only with allow_actions=true (and confirm_destructive=true). " +
						"import: turn a Playwright recording into storyboard steps (a recording that touches credentials is REJECTED whole).",
				},
				model: {
					type: "string",
					description: "Technical model name to read (e.g. sale.order). REQUIRED for operation=canon.",
				},
				slug: {
					type: "string",
					description: "Manual folder name (one safe segment). Defaults to manual-<model with dashes>.",
				},
				target: {
					type: "string",
					enum: ["standalone", "fragment"],
					description: "render target: standalone writes MANUAL.md + index.html in the workspace (default); fragment writes OCA-ready fragments.",
				},
				overwrite: {
					type: "boolean",
					description: "render: write the artifacts in the workspace itself and take over hand-edited files. Default false → <workspace>/render/ and hand edits are skipped.",
				},
				module_dir: {
					type: "string",
					description: "Project's own module directory (error evidence and manualsMode=module).",
				},
				spec_id: {
					type: "string",
					description: "When given, the manual lives next to that spec (manualsMode=specs).",
				},
				language: {
					type: "string",
					description: "Preferred language (res.lang code or prefix). Defaults to the configured documentation language, then en_US.",
				},
				flow: {
					type: "string",
					description: "capture: flow id in the storyboard (e.g. f1).",
				},
				from_step: {
					type: "string",
					description: "capture: resume from this step id (e.g. s03) after a failure.",
				},
				allow_actions: {
					type: "boolean",
					description: "capture: ALLOW the action steps (new/fill/select/press/click) to run. Default false — read-only capture only. Requires a DISPOSABLE database.",
				},
				confirm_destructive: {
					type: "boolean",
					description: "capture: REQUIRED true when allow_actions=true (UI clicks are not journalable — same contract as business actions).",
				},
				headed: {
					type: "boolean",
					description: "capture/explore: run the browser headed (visible). Default headless.",
				},
				zoom: {
					type: "number",
					description: "capture/explore: device scale factor 1..2 for the PNGs. Default 1.",
				},
				browser: {
					type: "string",
					enum: ["auto", "chromium", "chrome", "msedge"],
					description: "capture/explore: which browser. auto = bundled Chromium → Chrome → Edge.",
				},
				menu: {
					type: "string",
					description: "explore: menu xml id to open (e.g. sale.menu_action_quotations).",
				},
				record_model: {
					type: "string",
					description: "explore: model of the record screen to open (with record_id).",
				},
				record_id: {
					type: "number",
					description: "explore: database id of the record screen to open (with record_model).",
				},
				url: {
					type: "string",
					description: "explore: same-origin URL to open (anything leaving the instance is blocked).",
				},
				recording: {
					type: "string",
					description:
						"import: path of the Playwright recording (codegen @playwright/test or library dialect). " +
						"A recording that touches credentials is rejected whole and its value is never copied.",
				},
				replace: {
					type: "boolean",
					description: "import: replace an existing flow with the same id instead of refusing it (create-only by default).",
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
			async execute(args: {
				operation: "canon" | "plan" | "lint" | "render" | "explore" | "capture" | "import";
				model?: string;
				slug?: string;
				module_dir?: string;
				spec_id?: string;
				language?: string;
				target?: "standalone" | "fragment";
				overwrite?: boolean;
				flow?: string;
				from_step?: string;
				allow_actions?: boolean;
				confirm_destructive?: boolean;
				headed?: boolean;
				zoom?: number;
				browser?: "auto" | "chromium" | "chrome" | "msedge";
				menu?: string;
				record_model?: string;
				record_id?: number;
				url?: string;
				recording?: string;
				replace?: boolean;
			}, exec?: unknown) {
				const projectRoot = deps.projectRoot(exec);
				const manualsCfg = deps.manuals(exec);
				const moduleDir = args.module_dir ? resolveModuleDir(args.module_dir, projectRoot) : undefined;
				const slug = args.slug ?? (args.model ? `manual-${args.model.replace(/\./g, "-").replace(/[^A-Za-z0-9._-]/g, "-")}` : undefined);
				const artifacts: string[] = [];
				if (!slug) {
					return {
						ok: false,
						operation: args.operation,
						summary: "BLOCKED",
						artifacts,
						detail: "BLOCKED — name the manual: pass slug (or model, which defaults the slug). The workspace is resolved from the slug, not guessed.",
					};
				}

				const ws = resolveManualWorkspace({
					mode: manualsCfg.mode,
					dir: manualsCfg.dir,
					projectRoot,
					specsBase: deps.specsBase(exec),
					specDir: args.spec_id ? deps.specDir(args.spec_id, exec) : undefined,
					moduleDir,
					slug,
				});
				if (!ws.ok) {
					return {
						ok: false,
						operation: args.operation,
						summary: "BLOCKED",
						artifacts,
						detail: `BLOCKED — ${ws.blocked}`,
					};
				}
				if (args.operation === "explore" || args.operation === "capture") {
					return exploreCapture(args as ExploreCaptureArgs, ws.dir, slug, deps, artifacts, exec);
				}
				if (args.operation === "import") {
					return importRecordingOp(args.recording, args.flow, args.replace === true, ws.dir, slug, artifacts, deps, projectRoot);
				}
				if (args.operation !== "canon") {
					return planLintRender(args.operation, ws.dir, slug, args, deps, artifacts, manualsCfg.mode);
				}
				if (!args.model) {
					return {
						ok: false,
						operation: args.operation,
						summary: "BLOCKED",
						artifacts,
						detail: "BLOCKED — operation=canon needs model: the canon is read per model from the instance.",
					};
				}
				const client = deps.client(exec);
				if (client === undefined) {
					return {
						ok: false,
						operation: "canon" as string,
						summary: "NEEDS_INSTANCE",
						artifacts,
						detail:
							"The canon is read from a connected Odoo instance and none is configured: run the connection " +
							"onboarding (odoo_setup) first. The manual can be PLANNED without an instance, but every fact " +
							"it states must come from evidence.",
					};
				}

				const version = await client.version();
				if (!version.ok) {
					return {
						ok: false,
						operation: "canon" as string,
						summary: "INSTANCE UNREACHABLE",
						artifacts,
						detail: `Cannot probe the server version: ${version.error}`,
					};
				}
				const repos = deps.repos?.(exec);
				const result = await collectCanon(client, {
					model: args.model,
					serverVersion: version.value.server_version,
					language: args.language ?? deps.configuredLanguage(exec),
					moduleName: moduleDir ? basename(moduleDir) : undefined,
					moduleDir: moduleDir && existsSync(join(moduleDir, "__manifest__.py")) ? moduleDir : undefined,
					repos: repos ? { communityPath: repos.communityPath, enterprisePath: repos.enterprisePath } : undefined,
				});
				if (!result.ok) {
					return {
						ok: false,
						operation: "canon" as string,
						summary: "BLOCKED",
						artifacts,
						detail: `BLOCKED — ${result.blocked}`,
					};
				}
				const canon = result.canon;
				const fingerprint = canonFingerprint(canon);
				writeFileAtomic(
					join(ws.dir, CANON_FILE),
					JSON.stringify({ schema: "dsh-odoo-sdd/canon/1", fingerprint, collectedAt: new Date().toISOString(), ...canon }, null, 2) + "\n",
				);
				artifacts.push(`${slug}/${CANON_FILE}`);

				const summary = summarizeCanon(canon);
				const existing = (() => {
					try {
						return readStoryboard(ws.dir);
					} catch {
						return undefined;
					}
				})();
				const lines: string[] = [];
				lines.push(`Canon of ${canon.model} read from the instance (server ${canon.serverVersion}, language ${canon.language}).`);
				lines.push(`Workspace: ${deps.display(ws.dir)} (manualsMode=${manualsCfg.mode})`);
				lines.push(`Fingerprint: ${fingerprint.slice(0, 12)}… (a storyboard planned now records this; later CANON-STALE checks compare it)`);
				lines.push("");
				lines.push(`- Model modules: ${canon.modelModules || "(unknown)"}`);
				lines.push(`- Views parsed: ${canon.views.map((v) => v.type).join(", ") || "NONE"}`);
				lines.push(`- Form buttons: ${summary.buttons} (${summary.mutatingButtons} of type=object) — statusbar: ${summary.statusbar ? "yes" : "no"}`);
				lines.push(`- Required fields: ${summary.requiredFields.length > 0 ? summary.requiredFields.join(", ") : "(none)"}`);
				lines.push(`- Notebook pages: ${summary.pages.length > 0 ? summary.pages.join(", ") : "(none)"}`);
				lines.push(`- Window actions: ${canon.actions.length}${canon.actions[0]?.xmlid ? ` (e.g. ${canon.actions[0].xmlid})` : ""}`);
				lines.push(`- Menus: ${canon.menus.length > 0 ? canon.menus.map((m) => m.completeName).slice(0, 5).join(" | ") : "(none found)"}`);
				lines.push(`- Access rules: ${canon.access.access.length} ir.model.access, ${canon.access.rules.length} ir.rule, ${canon.access.groups.length} groups listed`);
				const ownErr = canon.errors.own;
				lines.push(
					`- Error evidence (own): ${ownErr ? (ownErr.path ? `${ownErr.errors.length} raise/constraint site(s) in ${deps.display(ownErr.path)}` : (ownErr.note ?? "not available")) : "no module_dir given"}`,
				);
				for (const src of [canon.errors.community, canon.errors.enterprise]) {
					if (src) lines.push(`- Native evidence: ${src.path ? `${src.errors.length} site(s) in ${deps.display(src.path)}` : (src.note ?? "not configured")}`);
				}
				if (existing) {
					lines.push("");
					lines.push(
						existing.canonFingerprint && existing.canonFingerprint !== fingerprint
							? `NOTE: an existing storyboard (${existing.flows.length} flow(s)) was planned against a DIFFERENT canon (fingerprint ${existing.canonFingerprint.slice(0, 12)}…) — it is now CANON-STALE and must be re-validated before rendering.`
							: `An existing storyboard (${existing.flows.length} flow(s)) matches this fingerprint.`,
					);
				}
				lines.push("");
				lines.push("Next: plan the storyboard against this canon (facts ONLY from here), then lint before writing prose.");
				return {
					ok: true,
					operation: "canon" as string,
					summary: `${canon.model}: ${summary.buttons} buttons, ${summary.requiredFields.length} required fields, ${summary.ownErrors} own error sites`,
					artifacts,
					detail: lines.join("\n"),
				};
			},
		}),
	);
}

/** Read a persisted canon file (for later motors and tests). */
export function readCanon(dir: string): (Record<string, unknown> & { fingerprint?: string }) | null {
	const file = join(dir, CANON_FILE);
	if (!existsSync(file)) return null;
	return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Parse the stored canon into the typed object (minus the envelope keys). */
function loadCanon(dir: string): { canon: Canon; fingerprint: string } | null {
	const rec = readCanon(dir);
	if (!rec) return null;
	const { schema: _schema, fingerprint, collectedAt: _collectedAt, ...canon } = rec;
	return { canon: canon as unknown as Canon, fingerprint: fingerprint ?? canonFingerprint(canon as unknown as Canon) };
}

// ---------------------------------------------------------------------------
// import — a recorded demo becomes storyboard steps, never its credentials
// ---------------------------------------------------------------------------

/**
 * Turn a Playwright recording into a new flow. The recording is read from a
 * REGULAR file inside the project (symlinks refused), the credential gate runs
 * before any parsing, and the flow is created with `procedure: null` so the
 * storyteller still writes every sentence.
 */
export function importRecordingOp(
	recording: string | undefined,
	flowTitle: string | undefined,
	replace: boolean,
	dir: string,
	slug: string,
	artifacts: string[],
	deps: ManualToolDeps,
	projectRoot: string,
): ManualToolResult {
	// `slug` is part of the public shape for callers that log it, but the
	// workspace itself was already resolved by the caller.
	void slug;	if (!recording) {
		return {
			ok: false,
			operation: "import",
			summary: "BLOCKED",
			artifacts,
			detail:
				"BLOCKED — import needs recording: the path of a Playwright recording (codegen dialect). " +
				"Record with `npx @playwright/cli open <url> --headed`, log in BY HAND, then recording-start / recording-stop.",
		};
	}
	const abs = recording.startsWith("/") ? recording : join(projectRoot, recording);
	let stat;
	try {
		stat = lstatSync(abs);
	} catch {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${deps.display(abs)} does not exist.` };
	}
	if (stat.isSymbolicLink()) {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${deps.display(abs)} is a symlink: recordings are read from regular files only.` };
	}
	if (!stat.isFile()) {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${deps.display(abs)} is not a file.` };
	}
	if (stat.size > 1_000_000) {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — the recording is ${stat.size} bytes; the limit is 1 MB. Split the demo.` };
	}
	const sb = readStoryboard(dir);
	if (!sb) {
		return {
			ok: false,
			operation: "import",
			summary: "BLOCKED",
			artifacts,
			detail: `BLOCKED — there is no storyboard.json in ${deps.display(dir)}: run operation=plan first (the imported flow is added to an existing storyboard, never invented).`,
		};
	}
	let text: string;
	try {
		text = readFileSync(realpathSync(abs), "utf8");
	} catch (e) {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${e instanceof Error ? e.message : String(e)}` };
	}
	const loaded = loadCanon(dir);
	const parsed = importRecording(text, loaded?.canon ?? undefined);
	if (!parsed.ok) {
		return { ok: false, operation: "import", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${parsed.error}` };
	}
	const title = flowTitle && flowTitle.trim() ? flowTitle.trim() : `Imported recording (${basename(abs)})`;
	const existing = sb.flows.find((f) => f.title === title);
	if (existing && !replace) {
		return {
			ok: false,
			operation: "import",
			summary: "BLOCKED",
			artifacts,
			detail: `BLOCKED — flow ${existing.id} already has the title "${title}": pass replace=true to take it over, or name the new flow differently.`,
		};
	}
	const flowId = existing?.id ?? nextFlowId(sb);
	const flow = {
		id: flowId,
		title,
		steps: parsed.steps.map((s) => ({ ...s, procedure: null })),
	};
	sb.flows = existing ? sb.flows.map((f) => (f.id === flowId ? flow : f)) : [...sb.flows, flow];
	writeStoryboard(dir, sb);
	artifacts.push("storyboard.json");
	const actions = flow.steps.filter((s) => stepSafety(s.kind as never) === "action").length;
	const mapped = flow.steps.filter((s) => s.field !== undefined).length;
	return {
		ok: true,
		operation: "import",
		summary: `Imported ${flow.steps.length} steps into flow ${flowId} (${mapped} mapped to the canon, ${actions} action steps need allow_actions).`,
		artifacts,
		detail: [
			`Flow ${flowId}: ${title}`,
			`Steps: ${flow.steps.map((s) => `${s.id} ${s.kind}${s.field ? `=${s.field}` : ""}`).join(", ")}`,
			...parsed.warnings.map((w) => `${w.rule}: ${w.message}`),
			"Every procedure is null on purpose: narrate each step (operation=lint catches TODOs).",
		].join("\n"),
	};
}

/**
 * The Motor 2 operations: plan the storyboard against the stored canon, lint
 * narration and structure, render the artifacts. NONE of them talks to the
 * instance — the manual only ever describes what the canon says, and the canon
 * was already read (operation=canon) — so they work offline, including for
 * standalone manuals.
 */
async function planLintRender(
	operation: "plan" | "lint" | "render",
	dir: string,
	slug: string,
	args: { language?: string; target?: "standalone" | "fragment"; overwrite?: boolean },
	deps: ManualToolDeps,
	artifacts: string[],
	mode: ManualsMode,
): Promise<{ ok: boolean; operation: string; summary: string; artifacts: string[]; detail: string }> {
	const stored = loadCanon(dir);
	const existing = (() => {
		try {
			return readStoryboard(dir);
		} catch (e) {
			return { error: e } as const;
		}
	})();
	const lines: string[] = [];
	const head = `Manual ${slug} — ${deps.display(dir)} (manualsMode=${mode})`;
	lines.push(head, "");

	if (operation === "plan") {
		if (!stored) {
			return {
				ok: false,
				operation,
				summary: "BLOCKED",
				artifacts,
				detail: `BLOCKED — there is no canon.json in ${deps.display(dir)}: run operation=canon first. The plan is drafted from the canon, never from memory.`,
			};
		}
		if (existing && !("error" in existing)) {
			const findings = validateStoryboard(existing, stored.canon);
			lines.push(`A storyboard already exists (${existing.flows.length} flow(s)); planning is create-only, so it was left untouched.`);
			lines.push(...findingLines(findings));
			return { ok: true, operation, summary: `existing storyboard validated: ${findings.length} finding(s)`, artifacts, detail: lines.join("\n") };
		}
		const sb = planStoryboard(stored.canon, slug);
		sb.canonFingerprint = stored.fingerprint;
		sb.language = args.language ?? stored.canon.language;
		writeStoryboard(dir, sb);
		artifacts.push(`${slug}/storyboard.json`);
		const findings = validateStoryboard(sb, stored.canon);
		const steps = sb.flows.reduce((a, f) => a + f.steps.length, 0);
		lines.push(`Storyboard planned from the canon: ${sb.flows.length} flow(s), ${steps} step(s), fingerprint ${stored.fingerprint.slice(0, 12)}….`);
		lines.push(`Language: ${sb.language} (the narration must be written in this language).`);
		lines.push(...findingLines(findings));
		lines.push("");
		lines.push("Next: the storyteller writes procedure (ONE sentence per step) and recovery — never inventing behavior the canon does not show.");
		return { ok: true, operation, summary: `planned ${sb.flows.length} flow(s), ${steps} step(s); ${findings.length} finding(s) to clear`, artifacts, detail: lines.join("\n") };
	}

	if (existing && "error" in existing) {
		return { ok: false, operation, summary: "BLOCKED", artifacts, detail: `BLOCKED — storyboard.json is not readable: ${(existing.error as Error).message}` };
	}
	const sb: Storyboard | null = existing ?? null;
	if (!sb) {
		return {
			ok: false,
			operation,
			summary: "BLOCKED",
			artifacts,
			detail: `BLOCKED — there is no storyboard.json in ${deps.display(dir)}: run operation=plan first (against a canon).`,
		};
	}

	if (operation === "lint") {
		if (stored && sb.canonFingerprint && sb.canonFingerprint !== stored.fingerprint) {
			lines.push(`CANON-STALE: the storyboard fingerprint ${sb.canonFingerprint.slice(0, 12)}… does not match the stored canon ${stored.fingerprint.slice(0, 12)}… — re-plan before rendering.`);
		}
		const labels = canonLabels(stored?.canon);
		const manualFile = join(dir, "MANUAL.md");
		const rendered = existsSync(manualFile) ? readFileSync(manualFile, "utf8") : undefined;
		const findings = [...validateStoryboard(sb, stored?.canon ?? null), ...collectProseFindings(sb, rendered, labels)];
		const errors = findings.filter((f) => f.severity === "ERROR").length;
		lines.push(...findingLines(findings));
		if (!rendered) lines.push("", "(No MANUAL.md yet — prose heuristics ran on the storyboard narration only.)");
		lines.push("", `Verdict: ${errors > 0 ? `${errors} ERROR — fix before rendering` : "no structural errors; WARNs are advisory."}`);
		return { ok: errors === 0, operation, summary: `${findings.length} finding(s) (${errors} ERROR)`, artifacts, detail: lines.join("\n") };
	}

	// render
	const canon = stored?.canon ?? null;
	const result = renderManual(dir, sb, canon, { overwrite: args.overwrite, language: args.language });
	artifacts.push(...result.written.map((f) => `${slug}/render/${f}`));
	for (const w of result.written) lines.push(`written: ${w}`);
	for (const s of result.skipped) lines.push(`SKIPPED: ${s.file} — ${s.reason}`);
	if (!stored) lines.push("", "NOTE: rendered without a stored canon — facts beyond the storyboard are absent (run operation=canon for a complete manual).");
	const labels = canonLabels(canon);
	const findings = collectProseFindings(sb, undefined, labels);
	const errors = findings.filter((f) => f.severity === "ERROR").length;
	lines.push("", errors > 0 ? `RENDERED but ${errors} structural finding(s) remain — run operation=lint.` : "Rendered. Run operation=lint to audit the prose.");
	return {
		ok: true,
		operation,
		summary: `${result.written.length} file(s) written${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ""}`,
		artifacts,
		detail: lines.join("\n"),
	};
}

/** Exact strings the canon read, for the label-not-in-canon heuristic. */
function canonLabels(canon: Canon | null | undefined): string[] {
	if (!canon) return [];
	return [
		...canon.fields.map((f) => f.string).filter((s): s is string => Boolean(s)),
		...(canon.views.find((v) => v.type === "form")?.arch.buttons.map((b) => b.string).filter((s): s is string => Boolean(s)) ?? []),
		...canon.access.groups.map((g) => g.fullName),
	];
}

function findingLines(findings: StoryboardFinding[]): string[] {
	if (findings.length === 0) return ["No findings."];
	return findings.map((f) => `- [${f.severity}] ${f.rule}${f.flow ? ` (${f.flow}${f.step ? `/${f.step}` : ""})` : ""}: ${f.message}`);
}

// ---------------------------------------------------------------------------
// explore / capture — Motor 3 (Playwright)
// ---------------------------------------------------------------------------

interface ExploreCaptureArgs {
	operation: string;
	flow?: string;
	from_step?: string;
	allow_actions?: boolean;
	confirm_destructive?: boolean;
	headed?: boolean;
	zoom?: number;
	browser?: "auto" | "chromium" | "chrome" | "msedge";
	menu?: string;
	record_model?: string;
	record_id?: number;
	url?: string;
}

type ManualToolResult = {
	ok: boolean;
	operation: string;
	summary: string;
	artifacts: string[];
	detail: string;
};

/**
 * Shared runner for the two browser operations: resolves the UI family from
 * the live server version, opens a web session (in-memory; an API key is a
 * NEEDS_WEB_SESSION, not a guess), and gates the action steps BEFORE anything
 * is launched.
 */
async function exploreCapture(
	args: ExploreCaptureArgs,
	wsDir: string,
	slug: string,
	deps: ManualToolDeps,
	artifacts: string[],
	exec?: unknown,
): Promise<ManualToolResult> {
	const client = deps.client(exec);
	if (client === undefined) {
		return {
			ok: false,
			operation: args.operation,
			summary: "NEEDS_INSTANCE",
			artifacts,
			detail: "NEEDS_INSTANCE — the browser needs the instance URL and version: run the connection onboarding (odoo_setup) first.",
		};
	}
	const version = await client.version();
	if (!version.ok) {
		return { ok: false, operation: args.operation, summary: "INSTANCE UNREACHABLE", artifacts, detail: `Cannot probe the server version: ${version.error}` };
	}
	const fam = familyFor(version.value.server_version);
	if (!fam.ok) return { ok: false, operation: args.operation, summary: "BLOCKED", artifacts, detail: `BLOCKED — ${fam.error}` };

	const session = await deps.webSession(exec);
	if (!session.ok) {
		const kind = session.errorKind === "needs_session" ? "NEEDS_WEB_SESSION" : "BLOCKED";
		return { ok: false, operation: args.operation, summary: kind, artifacts, detail: `${kind} — ${session.error}` };
	}

	const pw = await loadPlaywright();
	if (!pw.ok) return { ok: false, operation: args.operation, summary: "NEEDS_BROWSER", artifacts, detail: `NEEDS_BROWSER — ${pw.error}` };
	const browserChoice = args.browser ?? "auto";
	const headed = args.headed === true;
	const opened = await resolveBrowser(pw.value.chromium, browserChoice, headed);
	if (!opened.ok) return { ok: false, operation: args.operation, summary: "NEEDS_BROWSER", artifacts, detail: opened.error };

	try {
		if (args.operation === "explore") {
			const target = args.menu
				? ({ kind: "menu", xmlid: args.menu } as const)
				: args.record_model && args.record_id
					? ({ kind: "record", model: args.record_model, recordId: args.record_id } as const)
					: args.url
						? ({ kind: "url", url: args.url } as const)
						: null;
			if (!target) {
				return {
					ok: false,
					operation: "explore",
					summary: "BLOCKED",
					artifacts,
					detail: "BLOCKED — explore needs ONE destination: menu (xml id), record_model+record_id, or a same-origin url.",
				};
			}
			const res = await exploreScreen({
				session: session.value,
				browser: opened.value,
				family: fam.value.family,
				headed,
				zoom: args.zoom ?? 1,
				target,
			});
			if (!res.ok) return { ok: false, operation: "explore", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${res.error}` };
			const out = join(wsDir, "explore.txt");
			writeFileAtomic(out, res.value.aria + "\n");
			artifacts.push("explore.txt");
			return {
				ok: true,
				operation: "explore",
				summary: `Explored ${target.kind} on Odoo ${fam.value.major} (read-only aria snapshot).`,
				artifacts,
				detail:
					`ARIA snapshot of the action manager (scope .o_action_manager), family ${fam.value.major} (${fam.value.family.verified}).\n` +
					"Use it to name EXACT targets (menu xml ids, button names, field labels) in the storyboard — never guess them.",
			};
		}

		// capture
		if (!args.flow) {
			return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: "BLOCKED — capture needs flow: the storyboard flow id to run (see operation=plan)." };
		}
		const sb = readStoryboard(wsDir);
		if (!sb) {
			return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${slug} has no storyboard: run operation=plan (and the storyteller pass) first.` };
		}
		const flow = sb.flows.find((f) => f.id === args.flow);
		if (!flow) {
			return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: `BLOCKED — flow ${args.flow} is not in the storyboard of ${slug}.` };
		}
		const hasActions = flow.steps.some((s) => stepSafety(s.kind) === "action");
		if (hasActions && args.allow_actions !== true) {
			return {
				ok: false,
				operation: "capture",
				summary: "BLOCKED",
				artifacts,
				detail:
					"BLOCKED — this flow contains ACTION steps (new/fill/select/press/click) and allow_actions is not true. " +
					"Capture read-only first (plan flows without actions, or drop to explore), or re-run with allow_actions=true AND confirm_destructive=true on a DISPOSABLE database: UI clicks are NOT journalable and cannot be undone by a checkpoint.",
			};
		}
		if (args.allow_actions === true && args.confirm_destructive !== true) {
			return {
				ok: false,
				operation: "capture",
				summary: "CONFIRM_REQUIRED",
				artifacts,
				detail:
					"CONFIRM_REQUIRED — allow_actions=true also needs confirm_destructive=true: the clicks are real UI effects on the instance that no journal can replay. Run against a disposable database.",
			};
		}
		const res = await captureFlow({
			session: session.value,
			browser: opened.value,
			family: fam.value.family,
			flow,
			fromStep: args.from_step,
			allowActions: args.allow_actions === true,
			headed,
			zoom: args.zoom ?? 1,
			workspace: wsDir,
		});
		if (!res.ok) return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${res.error}` };
		artifacts.push("capture.json", ...res.value.steps.filter((s) => s.screenshot).map((s) => s.screenshot?.file ?? ""));
		// record the evidence on the storyboard (create-only merge per step id)
		const captures = res.value.steps
			.filter((s): s is typeof s & { screenshot: NonNullable<typeof s.screenshot> } => s.screenshot !== undefined)
			.map((s) => ({ stepId: s.id, file: s.screenshot.file, width: s.screenshot.width, height: s.screenshot.height }));
		flow.captures = [...(flow.captures ?? []), ...captures.filter((c) => !(flow.captures ?? []).some((k) => k.stepId === c.stepId))];
		writeStoryboard(wsDir, sb);
		artifacts.push("storyboard.json");
		const failed = res.value.steps.find((s) => s.status === "error");
		return {
			ok: true,
			operation: "capture",
			summary: `Captured ${res.value.steps.filter((s) => s.status === "ok").length}/${flow.steps.length} steps of ${flow.id} (browser: ${browserChoice}, overlay removed: ${res.value.overlaysRemoved}).`,
			artifacts,
			detail:
				failed
					? `Stopped at step ${failed.id} (${failed.kind}): ${failed.error ?? "error"}\nRe-run with from_step="${failed.id}" after fixing the storyboard.`
					: `All steps captured. Screens: ${captures.map((c) => c.file).join(", ") || "none (add screenshot steps)"}`,
		};
	} finally {
		await opened.value.close().catch(() => {});
	}
}
