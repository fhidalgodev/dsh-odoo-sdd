/**
 * dsh-odoo-sdd — Spec-Driven Development pipeline for Odoo as a DSH plugin.
 *
 * Design (absorbs working patterns from the ecosystem, not third-party code):
 *   - CLOSED FEEDBACK LOOP: the agent installs/upgrades modules, runs
 *     verifications and reads server errors over JSON-RPC against a real,
 *     running Odoo instance. This plugin never starts Docker or odoo-bin; the
 *     developer supplies URL + credentials through a gitignored .env, and the
 *     tools return tracebacks verbatim (redacted) to the agent.
 *   - PIPELINE SAFETY: phases persist to disk (state.json + KB graph), gates
 *     are fail-closed on an explicit APPROVED marker, three consecutive
 *     failures force a deep-diagnosis step, verify/fix iterations are capped,
 *     stop.md halts everything, and verdicts are honest: a failed
 *     verification persists as FAILED and can never be reported as success.
 *
 * Registered tools (model-facing):
 *   - odoo_connect : probe instance, load credentials, authenticate (masked)
 *   - odoo_setup   : onboarding — configure now / defer / skip the instance
 *   - odoo_module  : module state / install / upgrade with server feedback
 *   - odoo_errors  : recent ir.logging error rows (redacted)
 *   - odoo_session : mint a passwordless UI session for Playwright tests
 *   - sdd_phase    : read/init/advance the SDD state machine with gates
 *
 * The plugin follows the DSH tool-plugin shape: named exports `name`,
 * `inject`, `Config`, and `apply(ctx, config)`.
 *
 * @module dsh-odoo-sdd
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	loadCredentials,
	describeCredentials,
	displayPath,
	sanitizeForPersist,
	credentialCandidates,
	targetEnvPath,
	parseInstanceUrl,
	type OdooCredentials,
} from "./credentials.js";
import {
	readSetupState,
	writeSetupState,
	resetSetupState,
	readAutonomy,
	type EffectiveSetupStatus,
	type AutonomyMode,
	type SetupStatus,
} from "./setup-state.js";
import { withAudit } from "./audit.js";
import { registerRuntimeTools } from "./tools-runtime.js";
import { appendAuditLine, recordAudit } from "./audit.js";
import {
	readActiveState,
	writeActiveState,
	createCheckpoint,
	listCheckpoints,
	restoreCheckpointFiles,
	dropCheckpoint,
	purgeCheckpoints,
	readJournal,
	writeJournal,
	appendDataOp,
	type DataOp,
} from "./checkpoints.js";
import { scanModule } from "./security-scan.js";
import { OdooClient } from "./odoo-client.js";
import {
	loadState,
	saveState,
	initSpecDir,
	transition,
	recordFailure,
	recordSuccess,
	recordFailedVerdict,
	summarize,
	kbRead,
	kbAppend,
	readVerdict,
	type Phase,
	PHASES,
} from "./sdd-state.js";
import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "odoo-sdd";

/** Services this plugin injects from the host. */
export const inject = ["tools"];

/** Deployment configuration schema (settable from cordis.patch.yml).
 * Schemastery convention: a property WITHOUT `.required()` is optional. */
export const Config = z.object({
	projectRoot: z.string(),
	specsDir: z.string(),
	executeAllowlist: z.array(z.string()),
	communityRepoUrl: z.string(),
	communityRepoPath: z.string(),
	enterpriseRepoUrl: z.string(),
	enterpriseRepoPath: z.string(),
	autonomy: z.string(),
	licensed: z.string(),
	requireCheckpointBeforeMutation: z.boolean(),
	securityReviewRequired: z.boolean(),
	securityInterviewRequired: z.boolean(),
	auditAllTools: z.boolean(),
	maxCheckpoints: z.number(),
});

/** Effective deployment configuration after validation. */
interface OdooSddConfig {
	projectRoot?: string;
	specsDir?: string;
	/** Models permitted for MUTATING calls (create/write/unlink) on odoo_execute. Empty = denied. */
	executeAllowlist?: string[];
	/** Odoo Community source: git URL or local path (empty when not set). */
	communityRepoUrl?: string;
	communityRepoPath?: string;
	/** Odoo Enterprise source: git URL or local path (empty when not set). */
	enterpriseRepoUrl?: string;
	enterpriseRepoPath?: string;
	/** Default delegation mode: supervised | autonomous. */
	autonomy?: string;
	/** Default licensing strategy: community | enterprise. */
	licensed?: string;
	/** Refuse mutating calls until a checkpoint exists (fail-closed). */
	requireCheckpointBeforeMutation?: boolean;
	/** Require a clean security review before DONE. */
	securityReviewRequired?: boolean;
	/** Require the security interview (groups/ACL/rules) in CLARIFY. */
	securityInterviewRequired?: boolean;
	/** Record every tool call of the run in the audit log. */
	auditAllTools?: boolean;
	/** How many checkpoints to retain. */
	maxCheckpoints?: number;
}

/** Minimal structural view of the host tool registry. */
interface ToolRegistry {
	register(tool: unknown): void;
	/** Monotonic execution guard: a returned string denies the call. */
	guard?(guard: (execution: unknown) => string | undefined): unknown;
}

/** Optional host services a plugin may opt into. */
interface HostContextServices {
	/** Cordis dependency injection of host services by name. */
	inject?<T = void>(deps: string[], callback: (services: T) => void): unknown;
	/** Cordis event subscription (e.g. `tools/result` for observation). */
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** A visible plain-text content block (dsh-llm TextBlock). */
function text(value: string): { type: "text"; text: string } {
	return { type: "text", text: value };
}

/** Resolve the effective project root for this activation. */
function root(config: OdooSddConfig): string {
	return resolve(config.projectRoot ?? process.cwd());
}

/** Resolve a spec directory under the configured specs dir. */
function specDirOf(config: OdooSddConfig, specId: string): string {
	return join(root(config), config.specsDir ?? "specs", specId);
}

/** Load credentials and build a client, or a remediation report. */
function clientFor(projectRoot: string): {
	client: OdooClient | null;
	report: string;
	credentials: OdooCredentials | null;
} {
	const loaded = loadCredentials(projectRoot);
	if (!loaded.ok) {
		return { client: null, report: `NOT CONFIGURED (${loaded.reason}): ${loaded.message}`, credentials: null };
	}
	return {
		client: new OdooClient(loaded.credentials),
		report: describeCredentials(loaded.credentials),
		credentials: loaded.credentials,
	};
}

/** JSON-value projection of a module row (matches the output schema). */
function moduleRecord(m: { id: number; name: string; state: string; latest_version: string | null }): Record<string, string | number | null> {
	return { id: m.id, name: m.name, state: m.state, latest_version: m.latest_version };
}

/** Effective onboarding status combining the decision marker with credential resolution. */
function setupStatusFor(projectRoot: string): { status: EffectiveSetupStatus; detail: string } {
	const loaded = loadCredentials(projectRoot);
	if (loaded.ok) {
		return {
			status: "configured",
			detail: `Credentials OK (${loaded.credentials.source}): ${describeCredentials(loaded.credentials)}`,
		};
	}
	const marker = readSetupState(projectRoot);
	if (loaded.reason === "required_var_missing" && loaded.message.includes("ODOO_PASSWORD")) {
		return {
			status: "needs-secret",
			detail:
				`NEEDS_SECRET: a credential scaffold exists at ${displayPath(loaded.envFile)} ` +
				"but ODOO_PASSWORD is empty. Ask the developer to fill it directly in the " +
				"file (never through chat), then retry odoo_connect.",
		};
	}
	if (marker?.status === "skipped") {
		return {
			status: "skipped",
			detail:
				"SKIPPED: the developer chose to work without an instance. Continue with " +
				"static layers only and mark RPC/UI scenarios for MANUAL verification in " +
				"the test plan.",
		};
	}
	if (marker?.status === "deferred") {
		return {
			status: "deferred",
			detail:
				"DEFERRED: the developer postponed instance setup until the VERIFY phase. " +
				"Continue; re-run odoo_setup before phase 4.",
		};
	}
	return { status: "needs-setup", detail: `NEEDS_SETUP (${loaded.reason}): ${loaded.message}` };
}

/** Check .gitignore coverage for the plugin-owned paths in the project. */
function gitignoreCoverage(projectRoot: string): { covered: boolean; missing: string[] } {
	const file = join(projectRoot, ".gitignore");
	const entries = existsSync(file)
		? readFileSync(file, "utf8")
				.split(/\r?\n/)
				.map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
				.filter((l) => l !== "" && !l.startsWith("#"))
		: [];
	const required: Array<[string, string]> = [
		[".sdd", ".sdd/"],
		[".env", ".env"],
	];
	const missing: string[] = [];
	for (const [key, display] of required) {
		if (!entries.includes(key)) missing.push(display);
	}
	return { covered: missing.length === 0, missing };
}

/**
 * Register every SDD tool on the host tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration from the patch layer.
 */
export function apply(ctx: { tools: ToolRegistry } & HostContextServices, config: OdooSddConfig): void {
	// Q3: fail-closed host guard — refuse to mount against a host that does
	// not expose the tools registry (older/incompatible harness) with a
	// clear message instead of a cryptic boot failure.
	if (ctx === null || typeof ctx !== "object" || ctx.tools === null || typeof ctx.tools.register !== "function") {
		throw new Error(
			"dsh-odoo-sdd requires a DSH host exposing the `tools` service " +
			"(dsh >= 0.1.2-rc.1). Refusing to mount against this host — " +
			"upgrade the harness or check the profile composition.",
		);
	}
	// S2: sanitizer for any agent-supplied text the pipeline persists.
	const sanitize = (textValue: string): string => {
		const loaded = loadCredentials(root(config));
		const credentials: OdooCredentials | null = loaded.ok ? loaded.credentials : null;
		return sanitizeForPersist(textValue, credentials);
	};

	// Fase 1: register the deployment configuration as an installable settings
	// section (namespace "odoo-sdd"). This makes dsh-odoo-sdd appear as a
	// configurable card in Settings → Plugins → Plugin configuration, exactly
	// like dsh-agent-loop / dsh-bash-local / dsh-llm-* do via installSection —
	// no browser half needed.
	const ODOO_SDD_NAMESPACE = "odoo-sdd";
	interface SddsSettingsHooks {
		setSource(current: () => unknown): void;
		onChange(): void;
	}
	type SddsSettingsProvider = {
		settings: {
			installSection(owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: SddsSettingsHooks): void;
		};
	};
	const sddsDefaultConfig = {
		projectRoot: config.projectRoot ?? "",
		specsDir: config.specsDir ?? "specs",
		executeAllowlist: config.executeAllowlist ?? [],
		communityRepoUrl: config.communityRepoUrl ?? "https://github.com/odoo/odoo",
		communityRepoPath: config.communityRepoPath ?? "",
		enterpriseRepoUrl: config.enterpriseRepoUrl ?? "https://github.com/odoo/enterprise",
		enterpriseRepoPath: config.enterpriseRepoPath ?? "",
		autonomy: config.autonomy ?? "supervised",
		licensed: config.licensed ?? "community",
		requireCheckpointBeforeMutation: config.requireCheckpointBeforeMutation ?? true,
		securityReviewRequired: config.securityReviewRequired ?? true,
		securityInterviewRequired: config.securityInterviewRequired ?? true,
		auditAllTools: config.auditAllTools ?? true,
		maxCheckpoints: config.maxCheckpoints ?? 5,
	};
	ctx.inject?.<SddsSettingsProvider>(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(
			ctx,
			ODOO_SDD_NAMESPACE,
			Config,
			sddsDefaultConfig,
			{
				setSource: () => {
					// The user may override deployment defaults from Settings;
					// a later step can bind this to the live tools resolver.
				},
				onChange: () => {
					// Bookmark for reacting to allowlist/delegation edits later.
				},
			},
		);
	});
	// ---------------------------------------------------------------------
	// odoo_connect — probe + authenticate (never echoes secrets)
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_connect",
		description:
			"Probe the developer-provided Odoo instance: load credentials from the gitignored .env, " +
			"query the server version and authenticate. Returns a masked report — secrets are never " +
			"echoed. When not configured, returns remediation instructions to ask the developer to " +
			"fill .env (never request credentials through chat).",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					connected: { type: "boolean", required: true },
					target: { type: "string", required: true },
					serverVersion: { type: "string" },
					uid: { type: "number" },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute() {
			const projectRoot = root(config);
			const { client, report } = clientFor(projectRoot);
			if (client === null) {
				const setup = setupStatusFor(projectRoot);
				return { connected: false, target: "", detail: setup.detail };
			}
			const version = await client.version();
			if (!version.ok) {
				return { connected: false, target: client.target, detail: `Instance unreachable: ${version.error}` };
			}
			const auth = await client.authenticate();
			if (!auth.ok) {
				return {
					connected: false,
					target: client.target,
					serverVersion: version.value.server_version,
					detail: `Version OK (${version.value.server_version}) but authentication failed: ${auth.error}`,
				};
			}
			return {
				connected: true,
				target: report,
				serverVersion: version.value.server_version,
				uid: auth.value.uid,
				detail: `Connected to ${version.value.server_version} as uid=${auth.value.uid}. Target: ${report}`,
			};
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_setup — onboarding: configure now, defer, or skip the instance
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_setup",
		description:
			"Onboarding for the Odoo instance connection. mode=check (default) reports the credential " +
			"cascade state (.sdd/.env → user config → legacy .env), the persisted setup decision, and " +
			".gitignore coverage. mode=interactive writes a chmod-600 .env scaffold with the NON-SECRET " +
			"fields (url, db, username) and leaves ODOO_PASSWORD empty for the developer to fill by hand " +
			"— secrets are never accepted as tool parameters. mode=later defers setup until the VERIFY " +
			"phase; mode=skip marks the project to run without an instance (manual verification); " +
			"mode=reset clears the persisted decision.",
		parameters: {
			mode: {
				type: "string",
				required: true,
				enum: ["check", "interactive", "later", "skip", "reset", "autonomy"],
				description: "Onboarding operation.",
			},
			url: { type: "string", description: "Instance base URL for mode=interactive (validated with the transport guard; no embedded credentials)." },
			db: { type: "string", description: "Target database for mode=interactive (disposable dev/staging)." },
			username: { type: "string", description: "Login user for mode=interactive." },
			scope: {
				type: "string",
				enum: ["user", "project"],
				description: "Where to write the scaffold: user (~/.config/dsh-odoo-sdd/.env, shared — default) or project (.sdd/.env, isolated).",
			},
			decision: {
				type: "string",
				enum: ["supervised", "autonomous"],
				description: "Delegation mode for mode=autonomy: supervised (human answers gates) or autonomous (human-proxy agent answers).",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: { type: "string", required: true },
					status: { type: "string", required: true },
					envFile: { type: "string" },
					gitignoreCovered: { type: "boolean" },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: {
			mode: "check" | "interactive" | "later" | "skip" | "reset" | "autonomy";
			url?: string;
			db?: string;
			username?: string;
			scope?: "user" | "project";
			decision?: "supervised" | "autonomous";
		}) {
			const projectRoot = root(config);
			const autonomyMode = readAutonomy(projectRoot);
			appendAuditLine(projectRoot, "odoo_setup/" + args.mode, args, clientFor(projectRoot).credentials);

			if (args.mode === "autonomy") {
				const decision: AutonomyMode = args.decision === "autonomous" ? "autonomous" : "supervised";
				const existing = readSetupState(projectRoot);
				writeSetupState(projectRoot, {
					...(existing ?? { status: "?" as SetupStatus }),
					decidedAt: existing?.decidedAt ?? new Date().toISOString(),
					scope: existing?.scope,
					envFile: existing?.envFile,
					autonomy: decision,
				});
				return {
					mode: "autonomy" as string,
					status: decision,
					detail:
						`Delegation mode set to ${decision.toUpperCase()}. ` +
						(decision === "autonomous"
							? "A human-proxy agent will answer the phase gates with only APP (line-start APPROVED) accepted, fail-closed. stop.md and iteration ceilings remain armed; BLOCKED escalates to a human."
							: "A human will answer each phase gate (ask_user_question). You may still switch to autonomous with mode=autonomy decision=autonomous."),
				};
			}

			if (args.mode === "check") {
				const setup = setupStatusFor(projectRoot);
				const coverage = gitignoreCoverage(projectRoot);
				const candidates = credentialCandidates(projectRoot)
					.map((c) => `${existsSync(c.path) ? "[x]" : "[ ]"} ${c.source}: ${displayPath(c.path)}`)
					.join("\n");
				const gitignoreNote = coverage.covered
					? ".gitignore covers .sdd/ and .env."
					: `MISSING .gitignore entries: ${coverage.missing.join(", ")} — add them before writing credentials.`;
				return {
					mode: "check" as string,
					status: setup.status,
					gitignoreCovered: coverage.covered,
					detail:
						`Delegation: ${autonomyMode.toUpperCase()}.\n${setup.detail}` +
						`\nCredential cascade:\n${candidates}\n${gitignoreNote}`,
				};
			}

			if (args.mode === "later") {
				const existing = readSetupState(projectRoot);
				writeSetupState(projectRoot, {
					...(existing ?? {}),
					status: "deferred",
					decidedAt: new Date().toISOString(),
					autonomy: existing?.autonomy ?? autonomyMode,
				});
				return {
					mode: "later" as string,
					status: "deferred",
					detail:
						"Decision recorded: setup deferred until the VERIFY phase. The pipeline " +
						"continues without an instance for now; odoo_setup check will be re-asked " +
						"before phase 4.",
				};
			}

			if (args.mode === "skip") {
				const existing = readSetupState(projectRoot);
				writeSetupState(projectRoot, {
					...(existing ?? {}),
					status: "skipped",
					decidedAt: new Date().toISOString(),
					autonomy: existing?.autonomy ?? autonomyMode,
				});
				return {
					mode: "skip" as string,
					status: "skipped",
					detail:
						"Decision recorded: no instance. Server/RPC/UI verification layers become " +
						"MANUAL developer checks — record that in the test plan and cite the human " +
						"confirmation in the final sdd_phase succeed detail.",
				};
			}

			if (args.mode === "reset") {
				const removed = resetSetupState(projectRoot);
				return {
					mode: "reset" as string,
					status: "needs-setup",
					detail: removed
						? "Setup decision cleared; odoo_setup check will report NEEDS_SETUP."
						: "No setup decision was recorded; nothing to clear.",
				};
			}

			// mode === "interactive" — non-secret fields only, by design.
			const missingFields = (["url", "db", "username"] as const).filter(
				(k) => (args[k] ?? "").trim() === "",
			);
			if (missingFields.length > 0) {
				return {
					mode: "interactive" as string,
					status: "needs-setup",
					detail:
						`mode=interactive requires: ${missingFields.join(", ")} ` +
						"(non-secret fields only — the password is never accepted here).",
				};
			}
			const parsed = parseInstanceUrl(args.url!.trim());
			if (!parsed.ok) {
				return {
					mode: "interactive" as string,
					status: "needs-setup",
					detail: `URL rejected: ${parsed.message}`,
				};
			}
			const parsedUrl = new URL(args.url!.trim());
			if (parsedUrl.username !== "" || parsedUrl.password !== "") {
				return {
					mode: "interactive" as string,
					status: "needs-setup",
					detail:
						"The URL must not embed credentials (user:pass@host). The secret belongs " +
						"only in the .env file.",
				};
			}
			const scope = args.scope ?? "user";
			const target = targetEnvPath(scope, projectRoot);
			if (existsSync(target)) {
				return {
					mode: "interactive" as string,
					status: "needs-secret",
					envFile: displayPath(target),
					detail:
						`A credential file already exists at ${displayPath(target)} — refusing to ` +
						"overwrite. Edit it manually or choose the other scope.",
				};
			}
			const scaffold = [
				"# dsh-odoo-sdd credentials — written by odoo_setup (mode=interactive).",
				"# Fill ODOO_PASSWORD below (an Odoo API key is recommended).",
				"# NEVER commit this file; it must stay chmod 600.",
				`ODOO_URL=${parsed.url}`,
				`ODOO_DB=${args.db!.trim()}`,
				`ODOO_USERNAME=${args.username!.trim()}`,
				"ODOO_PASSWORD=",
				"",
			].join("\n");
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			try {
				chmodSync(dirname(target), 0o700);
			} catch {
				// best effort on filesystems without chmod semantics
			}
			writeFileSync(target, scaffold, { mode: 0o600 });
			try {
				chmodSync(target, 0o600);
			} catch {
				// best effort
			}
			writeSetupState(projectRoot, {
				status: "needs-secret",
				decidedAt: new Date().toISOString(),
				scope,
				envFile: target,
			});
			const coverage = gitignoreCoverage(projectRoot);
			const gitignoreNote = coverage.covered
				? ""
				: `\nWARNING: .gitignore does not cover ${coverage.missing.join(", ")} — add the entries so the credential file can never be committed.`;
			return {
				mode: "interactive" as string,
				status: "needs-secret",
				envFile: displayPath(target),
				gitignoreCovered: coverage.covered,
				detail:
					`Scaffold written at ${displayPath(target)} (chmod 600). Ask the developer to ` +
					"fill ODOO_PASSWORD directly in that file — never through chat. Then run " +
					`odoo_connect to validate.${gitignoreNote}`,
			};
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_module — closed feedback loop: info / install / upgrade
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_module",
		description:
			"Operate Odoo modules on the connected instance over JSON-RPC. " +
			"operation=info returns lifecycle state; operation=install / upgrade execute the immediate " +
			"button and return the server's own output or traceback verbatim (redacted) — this is the " +
			"closed feedback loop of the SDD pipeline. Target DB must be a disposable dev/staging database.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["info", "install", "upgrade"],
				description: "info (read state) | install (button_immediate_install) | upgrade (button_immediate_upgrade).",
			},
			modules: {
				type: "array",
				required: true,
				description: "Technical module names, e.g. ['my_module', 'my_module_extra'].",
				items: { type: "string" },
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					operation: { type: "string", required: true },
					success: { type: "boolean", required: true },
					modules: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					output: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { output: string }).output)],
		},
		async execute(args: { operation: "info" | "install" | "upgrade"; modules: string[] }) {
			const { client, report } = clientFor(root(config));
			const fail = (output: string) => ({
				operation: args.operation as string,
				success: false,
				modules: [] as Array<Record<string, string | number | null>>,
				output,
			});
			if (client === null) return fail(report);
			if (args.modules.length === 0) return fail("No module names provided.");
			if (args.operation === "info") {
				const result = await client.moduleInfo(args.modules);
				if (!result.ok) return fail(`SERVER ERROR:\n${result.error}`);
				const modules = result.value.map(moduleRecord);
				return {
					operation: "info" as string,
					success: true,
					modules,
					output: modules.length > 0
						? modules.map((m) => `${String(m["name"])}: ${String(m["state"])} (v${String(m["latest_version"] ?? "?")})`).join("\n")
						: "No modules matched.",
				};
			}
			const result = args.operation === "install"
				? await client.installModules(args.modules)
				: await client.upgradeModules(args.modules);
			if (!result.ok) return fail(`SERVER ERROR:\n${result.error}`);
			return {
				operation: args.operation as string,
				success: true,
				modules: result.value.modules.map(moduleRecord),
				output:
					`${args.operation} OK\n` +
					result.value.modules.map((m) => `${m.name}: ${m.state}`).join("\n") +
					(result.value.output ? `\nserver: ${result.value.output}` : ""),
			};
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_errors — remote server-log reader
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_errors",
		description:
			"Read recent server-side ERROR/CRITICAL logs (ir.logging) from the connected instance, " +
			"redacted. Use after a failed install/upgrade or a UI error to obtain the Python traceback " +
			"that feeds the fix loop.",
		parameters: {
			limit: { type: "number", description: "Maximum rows to return (default 20)." },
			sinceMinutes: { type: "number", description: "Look-back window in minutes (default 30)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: { type: "number", required: true },
					logs: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: { limit?: number; sinceMinutes?: number }) {
			const { client, report } = clientFor(root(config));
			if (client === null) return { count: 0, logs: [] as Array<Record<string, string | number | null>>, detail: report };
			const result = await client.recentErrors(args.limit ?? 20, args.sinceMinutes ?? 30);
			if (!result.ok) return { count: 0, logs: [] as Array<Record<string, string | number | null>>, detail: `Failed to read ir.logging: ${result.error}` };
			const logs = result.value.map((l) => ({
				id: l.id,
				create_date: l.create_date,
				level: l.level,
				type: l.type,
				name: l.name,
				message: l.message,
				path: l.path,
				line: l.line,
				func: l.func,
			}));
			const detail = logs.length === 0
				? "No server errors in the requested window."
				: logs.map((l) => `[${l.create_date}] ${l.level} ${l.type} ${l.name}${l.path ? ` (${l.path}:${l.line ?? "?"} in ${l.func ?? "?"})` : ""}\n${l.message}`).join("\n---\n");
			return { count: logs.length, logs, detail };
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_session — passwordless session minting for Playwright UI tests
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_session",
		description:
			"Mint a passwordless web session on the connected instance (the connect_as_user pattern) and " +
			"store the cookie in .sdd/session.json (chmod 600, gitignored) for Playwright UI tests. The " +
			"cookie value is NEVER returned — only the file path. The UI test harness should load the " +
			"cookie from that file and navigate past /web/login.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					minted: { type: "boolean", required: true },
					sessionFile: { type: "string" },
					uid: { type: "number" },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute() {
			const projectRoot = root(config);
			const { client, report } = clientFor(projectRoot);
			if (client === null) return { minted: false, detail: report };
			const result = await client.mintSession(projectRoot);
			if (!result.ok) return { minted: false, detail: result.error };
			return {
				minted: true,
				sessionFile: displayPath(result.value.sessionFile),
				uid: result.value.uid,
				detail: `Session cookie stored at ${displayPath(result.value.sessionFile)} (uid=${result.value.uid}). Load it in the browser context; do not print its contents.`,
			};
		},
	}));

	// sdd_phase — the state machine with fail-closed gates
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "sdd_phase",
		description:
			"Drive the SDD pipeline state machine for one spec directory. Operations: init (create " +
			"specs/<id>/ skeleton), status (snapshot), mark_spec_loaded (spec.md assimilated), advance " +
			"(transition phase; gated phases need approval_marker='APPROVED' — fail-closed), fail " +
			"(record a failed verification; 3 consecutive failures force deep diagnosis), succeed " +
			"(record a passed verification with honest verdict). stop.md in the spec dir halts everything.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["init", "clarify", "status", "mark_spec_loaded", "advance", "fail", "succeed", "rollback"],
				description: "State-machine operation to perform.",
			},
			spec_id: {
				type: "string",
				required: true,
				description: "Spec directory id, e.g. '001-sale-order-approval'.",
			},
			mode: {
				type: "string",
				enum: ["create", "bug"],
				description: "Job type (for operation=clarify): create a new module, or resolve a bug on an existing one.",
			},
			licensed: {
				type: "string",
				enum: ["community", "enterprise"],
				description: "Licensing strategy (for operation=clarify): community or enterprise. OCA/community reuse is ALWAYS searched in addition.",
			},
			next_phase: {
				type: "string",
				enum: [...PHASES],
				description: "Target phase for operation=advance.",
			},
			approval_marker: {
				type: "string",
				description: "Verbatim approval marker for gated transitions; only 'APPROVED' is accepted.",
			},
			checkpoint_id: {
				type: "string",
				description: "Checkpoint to restore for operation=rollback (defaults to the active one).",
			},
			approval_source: {
				type: "string",
				enum: ["human", "human-proxy"],
				description: "Who approved this gate. In SUPERVISED mode only 'human' is accepted; in AUTONOMOUS mode both are. Recorded for audit.",
			},
			detail: {
				type: "string",
				description: "Note/verdict/error summary recorded in the KB graph.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					operation: { type: "string", required: true },
					phase: { type: "string", required: true },
					ok: { type: "boolean", required: true },
					requireDiagnosis: { type: "boolean", required: true },
					summary: { type: "string", required: true },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				const v = value as { summary: string; detail: string };
				return [text(`${v.summary}\n${v.detail}`)];
			},
		},
		async execute(args: {
			operation: "init" | "clarify" | "status" | "mark_spec_loaded" | "advance" | "fail" | "succeed" | "rollback";
			spec_id: string;
			mode?: "create" | "bug";
			licensed?: "community" | "enterprise";
			next_phase?: Phase;
			approval_marker?: string;
			approval_source?: "human" | "human-proxy";
			checkpoint_id?: string;
			detail?: string;
		}) {
			const specDir = specDirOf(config, args.spec_id);
			// S2: agent-supplied details are scrubbed (known secret, generic
			// credential shapes, home paths) BEFORE any KB/verdict persistence.
			const note = sanitize(args.detail ?? "");
			const projectRootForAudit = root(config);
			appendAuditLine(projectRootForAudit, "sdd_phase/" + args.operation, args, clientFor(projectRootForAudit).credentials);
			if (args.operation === "init") {
				initSpecDir(specDir);
				const state = loadState(specDir);
				saveState(state);
				writeActiveState(root(config), { specId: args.spec_id, phase: state.phase });
				return {
					operation: "init" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail: `Spec directory initialized at ${displayPath(specDir)} (spec.md, architecture.md, test-plan.md, state.json). Fill spec.md, then mark_spec_loaded.`,
				};
			}
			if (args.operation === "rollback") {
				const projectRoot = root(config);
				const active = readActiveState(projectRoot);
				const checkpointId = args.checkpoint_id ?? active.checkpointId ?? null;
				if (checkpointId === null) {
					return {
						operation: "rollback" as string, phase: loadState(specDir).phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(loadState(specDir)),
						detail: "No checkpoint to roll back to. Create one with sdd_checkpoint operation=create.",
					};
				}
				const restored = restoreCheckpointFiles(projectRoot, checkpointId);
				const st = loadState(specDir);
				st.phase = "WRITE_CODE";
				kbAppend(st, "blocker", `Rollback to ${checkpointId}: restored ${restored.restored.length} file(s). ${note}`.trim());
				saveState(st);
				writeActiveState(projectRoot, { specId: args.spec_id, phase: st.phase });
				appendAuditLine(projectRoot, "sdd_phase/rollback", { checkpoint: checkpointId, spec: args.spec_id }, clientFor(projectRoot).credentials, {
					phase: st.phase, specId: args.spec_id, reason: note,
				});
				return {
					operation: "rollback" as string, phase: st.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(st),
					detail:
						`Rolled back to ${checkpointId}: ${restored.restored.length} file(s) restored` +
						(restored.missing.length > 0 ? `, ${restored.missing.length} failed` : "") +
						`. Phase is now WRITE_CODE — re-apply the change and verify again. ` +
						"NOTE: a module install/upgrade is not reverted at the database level.",
				};
			}
			if (args.operation === "clarify") {
				const stateC = loadState(specDir);
				if (args.mode === undefined || args.licensed === undefined) {
					return {
						operation: "clarify" as string, phase: stateC.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(stateC),
						detail: "operation=clarify requires BOTH mode (create|bug) and licensed (enterprise|oca|community) to record the intent.",
					};
				}
				stateC.mode = args.mode;
				stateC.licensed = args.licensed;
				kbAppend(stateC, "decision", `Intent clarified: mode=${stateC.mode}, licensed=${stateC.licensed}. ${note}`);
				saveState(stateC);
				return {
					operation: "clarify" as string, phase: stateC.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(stateC),
					detail:
						`Intent recorded: mode=${stateC.mode}, licensed=${stateC.licensed}. ` +
						"The CLARIFY gate is satisfied — advance to READ_SPEC (approval_marker='APPROVED' in the relevant mode).",
				};
			}
			const state = loadState(specDir);
			if (args.operation === "status") {
				const kb = kbRead(specDir);
				const active = readActiveState(root(config));
				writeActiveState(root(config), { specId: args.spec_id, phase: state.phase });
				return {
					operation: "status" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail:
						`KB nodes: ${kb.length}. Last: ${kb.length > 0 ? kb[kb.length - 1]!.summary : "none"}` +
						`\nCheckpoint: ${active.checkpointId ?? "none (mutations are blocked while the policy requires one)"}`,
				};
			}
			if (args.operation === "mark_spec_loaded") {
				state.specLoaded = true;
				saveState(state);
				return {
					operation: "mark_spec_loaded" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail: "Spec marked as loaded. Advance with approval_marker='APPROVED' once the acceptance criteria are understood.",
				};
			}
			if (args.operation === "advance") {
				if (args.next_phase === undefined) {
					return {
						operation: "advance" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(state), detail: "next_phase is required for advance.",
					};
				}
				const result = transition(
					state,
					args.next_phase,
					args.approval_marker ?? null,
					note,
					args.approval_source ?? "human",
					readAutonomy(root(config)),
				);
				if (result.ok) {
					writeActiveState(root(config), { specId: args.spec_id, phase: result.state.phase });
				}
				return {
					operation: "advance" as string, phase: result.state.phase as string, ok: result.ok, requireDiagnosis: false,
					summary: summarize(result.state),
					detail: result.ok ? result.note : result.reason,
				};
			}
			if (args.operation === "fail") {
				recordFailedVerdict(state, note || "verification failed (no detail)");
				const { requireDiagnosis, state: updated } = recordFailure(state, note);
				return {
					operation: "fail" as string, phase: updated.phase as string, ok: true, requireDiagnosis,
					summary: summarize(updated),
					detail: requireDiagnosis
						? "DEEP DIAGNOSIS REQUIRED: 3 consecutive failures. Run a root-cause analysis (consultant subagent) before the next retry — no blind retries."
						: "Failure recorded (honest FAILED verdict persisted). Fix the code and re-verify.",
				};
			}
			// succeed
			const updated = recordSuccess(state, note || "verification passed");
			return {
				operation: "succeed" as string, phase: updated.phase as string, ok: true, requireDiagnosis: false,
				summary: summarize(updated),
				detail: "PASSED verdict persisted to verify-verdict.txt. The pipeline may now advance to DONE.",
			};
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_config — read/update persistent plugin configuration (repos, etc.)
	// Persists to <projectRoot>/.sdd/config.json — the same plugin-owned dir
	// as the rest of the SDD state. No secrets here (credentials live in .env).
	// ---------------------------------------------------------------------
	const configFile = (): string => join(root(config), ".sdd", "config.json");
	const loadConfigFile = (): Record<string, unknown> => {
		const file = configFile();
		if (!existsSync(file)) return {};
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	};
	const saveConfigFile = (data: Record<string, unknown>): void => {
		const file = configFile();
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
		try {
			chmodSync(file, 0o600);
		} catch {
			// best effort
		}
	};

	ctx.tools.register(defineTool({
		name: "odoo_config",
		description:
			"Read or update the persistent plugin configuration stored in <projectRoot>/.sdd/config.json. " +
			"mode=read returns the current values (community/enterprise repository URL + OS path, " +
			"projectRoot, specsDir, executeAllowlist). mode=set updates them — provide only the fields to " +
			"change. Singleton call for each repository source. Never accepts or returns secrets (those " +
			"live in the .env).",
		parameters: {
			mode: {
				type: "string",
				required: true,
				enum: ["read", "set"],
				description: "read (show current config) | set (update provided fields).",
			},
			communityRepoUrl: { type: "string", description: "Odoo Community repository URL (e.g. https://github.com/odoo/odoo)." },
			communityRepoPath: { type: "string", description: "Odoo Community local OS path (overrides URL when set)." },
			enterpriseRepoUrl: { type: "string", description: "Odoo Enterprise repository URL (e.g. https://github.com/odoo/enterprise)." },
			enterpriseRepoPath: { type: "string", description: "Odoo Enterprise local OS path (overrides URL when set)." },
			projectRoot: { type: "string", description: "Workspace root used by the tools." },
			specsDir: { type: "string", description: "Specs folder (default 'specs')." },
			executeAllowlist: { type: "array", items: { type: "string" }, description: "Models permitted for odoo_execute mutations." },
			autonomy: { type: "string", enum: ["supervised", "autonomous"], description: "Default delegation mode." },
			licensed: { type: "string", enum: ["community", "enterprise"], description: "Licensing strategy. OCA/community is always searched as well." },
			requireCheckpointBeforeMutation: { type: "boolean", description: "Refuse mutations until a checkpoint exists (fail-closed)." },
			securityReviewRequired: { type: "boolean", description: "Require a clean security review before DONE." },
			securityInterviewRequired: { type: "boolean", description: "Require the security interview (groups/ACL/rules) before ARCHITECTURE." },
			auditAllTools: { type: "boolean", description: "Record every tool call of the run in .sdd/audit.jsonl." },
			maxCheckpoints: { type: "number", description: "How many checkpoints to retain." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: { type: "string", required: true },
					ok: { type: "boolean", required: true },
					config: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							communityRepoUrl: { type: "string", required: true },
							communityRepoPath: { type: "string", required: true },
							enterpriseRepoUrl: { type: "string", required: true },
							enterpriseRepoPath: { type: "string", required: true },
							projectRoot: { type: "string", required: true },
							specsDir: { type: "string", required: true },
							executeAllowlist: { type: "array", required: true, items: { type: "string" } },
							autonomy: { type: "string", required: true },
							licensed: { type: "string", required: true },
							requireCheckpointBeforeMutation: { type: "boolean", required: true },
							securityReviewRequired: { type: "boolean", required: true },
							securityInterviewRequired: { type: "boolean", required: true },
							auditAllTools: { type: "boolean", required: true },
							maxCheckpoints: { type: "number", required: true },
						},
					},
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				const v = value as { config: Record<string, unknown>; detail: string; ok: boolean };
				return [text((v.ok ? "Config:\n" : "PROBLEM:\n") + JSON.stringify(v.config, null, 2) + "\n" + v.detail)];
			},
		},
		async execute(args: {
			mode: "read" | "set";
			communityRepoUrl?: string;
			communityRepoPath?: string;
			enterpriseRepoUrl?: string;
			enterpriseRepoPath?: string;
			projectRoot?: string;
			specsDir?: string;
			executeAllowlist?: string[];
			autonomy?: string;
			licensed?: string;
			requireCheckpointBeforeMutation?: boolean;
			securityReviewRequired?: boolean;
			securityInterviewRequired?: boolean;
			auditAllTools?: boolean;
			maxCheckpoints?: number;
		}) {
			/** Project the stored JSON onto the known, typed configuration shape. */
			const normalize = (data: Record<string, unknown>) => {
				const asString = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
				const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
				// Two-value strategy only; legacy "oca" migrates to "community".
				const asLicense = (v: unknown, fallback: string): string => (asString(v, fallback) === "enterprise" ? "enterprise" : "community");
				return {
					communityRepoUrl: asString(data["communityRepoUrl"], "https://github.com/odoo/odoo"),
					communityRepoPath: asString(data["communityRepoPath"], ""),
					enterpriseRepoUrl: asString(data["enterpriseRepoUrl"], "https://github.com/odoo/enterprise"),
					enterpriseRepoPath: asString(data["enterpriseRepoPath"], ""),
					projectRoot: asString(data["projectRoot"], ""),
					specsDir: asString(data["specsDir"], "specs"),
					executeAllowlist: asList(data["executeAllowlist"]),
					autonomy: asString(data["autonomy"], "supervised"),
					licensed: asLicense(data["licensed"], "community"),
					requireCheckpointBeforeMutation: typeof data["requireCheckpointBeforeMutation"] === "boolean" ? data["requireCheckpointBeforeMutation"] : true,
					securityReviewRequired: typeof data["securityReviewRequired"] === "boolean" ? data["securityReviewRequired"] : true,
					securityInterviewRequired: typeof data["securityInterviewRequired"] === "boolean" ? data["securityInterviewRequired"] : true,
					auditAllTools: typeof data["auditAllTools"] === "boolean" ? data["auditAllTools"] : true,
					maxCheckpoints: typeof data["maxCheckpoints"] === "number" ? data["maxCheckpoints"] : 5,
				};
			};

			if (args.mode === "read") {
				return {
					mode: "read" as string,
					ok: true,
					config: normalize(loadConfigFile()),
					detail: `Stored at ${displayPath(configFile())}.`,
				};
			}
			// mode=set
			const current = loadConfigFile();
			const updates: Record<string, unknown> = {};
			if (args.communityRepoUrl !== undefined) updates["communityRepoUrl"] = args.communityRepoUrl;
			if (args.communityRepoPath !== undefined) updates["communityRepoPath"] = args.communityRepoPath;
			if (args.enterpriseRepoUrl !== undefined) updates["enterpriseRepoUrl"] = args.enterpriseRepoUrl;
			if (args.enterpriseRepoPath !== undefined) updates["enterpriseRepoPath"] = args.enterpriseRepoPath;
			if (args.projectRoot !== undefined) updates["projectRoot"] = args.projectRoot;
			if (args.specsDir !== undefined) updates["specsDir"] = args.specsDir;
			if (args.executeAllowlist !== undefined) updates["executeAllowlist"] = args.executeAllowlist;
			if (args.autonomy !== undefined) updates["autonomy"] = args.autonomy;
			if (args.licensed !== undefined) updates["licensed"] = args.licensed;
			if (args.requireCheckpointBeforeMutation !== undefined) updates["requireCheckpointBeforeMutation"] = args.requireCheckpointBeforeMutation;
			if (args.securityReviewRequired !== undefined) updates["securityReviewRequired"] = args.securityReviewRequired;
			if (args.securityInterviewRequired !== undefined) updates["securityInterviewRequired"] = args.securityInterviewRequired;
			if (args.auditAllTools !== undefined) updates["auditAllTools"] = args.auditAllTools;
			if (args.maxCheckpoints !== undefined) updates["maxCheckpoints"] = args.maxCheckpoints;
			if (Object.keys(updates).length === 0) {
				return {
					mode: "set" as string,
					ok: false,
					config: normalize(current),
					detail: "mode=set requires at least one field to update.",
				};
			}
			const merged = Object.assign({}, current, updates);
			saveConfigFile(merged);
			return {
				mode: "set" as string,
				ok: true,
				config: normalize(merged),
				detail: `Updated ${displayPath(configFile())}.`,
			};
		},
	}));

	// ---------------------------------------------------------------------
	// Runtime tools: odoo_execute (CRUD/RPC allowlist) + odoo_validate (local)
	// ---------------------------------------------------------------------
	// Effective configuration: the persisted <projectRoot>/.sdd/config.json
	// (written by odoo_config) takes precedence over the deployment config
	// (cordis.patch.yml), which takes precedence over built-in defaults. It is
	// resolved on every call so live edits apply without a restart.
	const effectiveConfig = () => {
		const data = loadConfigFile();
		const asString = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
		const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
		const asNum = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
		return {
			projectRoot: asString(data["projectRoot"], config.projectRoot ?? root(config)),
			specsDir: asString(data["specsDir"], config.specsDir ?? "specs"),
			executeAllowlist: Array.isArray(data["executeAllowlist"]) ? asList(data["executeAllowlist"]) : (config.executeAllowlist ?? []),
			communityRepoUrl: asString(data["communityRepoUrl"], config.communityRepoUrl ?? "https://github.com/odoo/odoo"),
			communityRepoPath: asString(data["communityRepoPath"], config.communityRepoPath ?? ""),
			enterpriseRepoUrl: asString(data["enterpriseRepoUrl"], config.enterpriseRepoUrl ?? "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asString(data["enterpriseRepoPath"], config.enterpriseRepoPath ?? ""),
			autonomy: asString(data["autonomy"], config.autonomy ?? "supervised"),
			licensed: ((v: unknown, fb: string): string => (asString(v, fb) === "enterprise" ? "enterprise" : "community"))(data["licensed"], config.licensed ?? "community"),
			requireCheckpointBeforeMutation: asBool(data["requireCheckpointBeforeMutation"], config.requireCheckpointBeforeMutation ?? true),
			securityReviewRequired: asBool(data["securityReviewRequired"], config.securityReviewRequired ?? true),
			securityInterviewRequired: asBool(data["securityInterviewRequired"], config.securityInterviewRequired ?? true),
			auditAllTools: asBool(data["auditAllTools"], config.auditAllTools ?? true),
			maxCheckpoints: asNum(data["maxCheckpoints"], config.maxCheckpoints ?? 5),
		};
	};

	// ---------------------------------------------------------------------
	// sdd_checkpoint — snapshot / restore / journal (the rollback surface)
	// ---------------------------------------------------------------------
	/** Read one checkpoint's journal file directly (not the active one). */
	const readCheckpointJournalFile = (projectRoot: string, id: string): DataOp[] => {
		const file = join(projectRoot, ".sdd", "checkpoints", id, "journal.json");
		if (!existsSync(file)) return [];
		try {
			return JSON.parse(readFileSync(file, "utf8")) as DataOp[];
		} catch {
			return [];
		}
	};

	/**
	 * Best-effort undo of the journaled data operations, newest first:
	 *   create -> unlink the created ids;  write -> restore the pre-image;
	 *   unlink -> re-create the pre-image rows.
	 * What cannot be undone is reported, never silently swallowed.
	 */
	const undoJournal = async (projectRoot: string, checkpointId: string): Promise<{ undone: string[]; detail: string }> => {
		const ops = readCheckpointJournalFile(projectRoot, checkpointId);
		if (ops.length === 0) return { undone: [], detail: "nothing journaled" };
		const { client } = clientFor(projectRoot);
		if (client === null) return { undone: [], detail: "no instance configured — journal left intact" };
		const undone: string[] = [];
		const failed: string[] = [];
		for (const op of [...ops].reverse()) {
			try {
				if (op.method === "create" && op.createdIds.length > 0) {
					const r = await client.executeKw<unknown>(op.model, "unlink", [op.createdIds], {});
					if (r.ok) undone.push(`unlink ${op.model} ${JSON.stringify(op.createdIds)}`);
					else failed.push(`${op.model}.unlink: ${r.error.slice(0, 120)}`);
				} else if (op.method === "write" && op.preImage.length > 0) {
					for (const row of op.preImage) {
						const id = Number(row["id"]);
						if (!Number.isFinite(id)) continue;
						const values: Record<string, unknown> = { ...row };
						delete values["id"];
						const r = await client.executeKw<unknown>(op.model, "write", [[id], values], {});
						if (r.ok) undone.push(`restore ${op.model} ${id}`);
						else failed.push(`${op.model}.write ${id}: ${r.error.slice(0, 120)}`);
					}
				} else if (op.method === "unlink" && op.preImage.length > 0) {
					for (const row of op.preImage) {
						const values: Record<string, unknown> = { ...row };
						delete values["id"];
						const r = await client.executeKw<unknown>(op.model, "create", [values], {});
						if (r.ok) undone.push(`recreate ${op.model}`);
						else failed.push(`${op.model}.create: ${r.error.slice(0, 120)}`);
					}
				}
			} catch (err) {
				failed.push(err instanceof Error ? err.message.slice(0, 120) : String(err));
			}
		}
		if (failed.length === 0) {
			writeJournalForCheckpoint(projectRoot, checkpointId, []);
			return { undone, detail: `${undone.length} operation(s) undone` };
		}
		return {
			undone,
			detail: `${undone.length} undone, ${failed.length} FAILED (journal kept): ${failed.slice(0, 3).join("; ")}`,
		};
	};

	/** Replace one checkpoint's journal (after a clean undo). */
	const writeJournalForCheckpoint = (projectRoot: string, checkpointId: string, ops: DataOp[]): void => {
		try {
			writeFileSync(join(projectRoot, ".sdd", "checkpoints", checkpointId, "journal.json"), JSON.stringify(ops, null, 2), { mode: 0o600 });
		} catch {
			// best effort
		}
	};

	ctx.tools.register(defineTool({
		name: "sdd_checkpoint",
		description:
			"Snapshot and restore the work. operation=create copies the given directories into " +
			".sdd/checkpoints/<id>/ and makes that checkpoint ACTIVE (mutations are refused until one " +
			"exists when the policy requires it). operation=list shows the checkpoints. operation=restore " +
			"puts the files back and, with restore_data=true AND confirm_destructive=true, undoes the " +
			"journaled data mutations (best-effort). operation=drop removes one. operation=journal lists " +
			"the data operations recorded since the active checkpoint. Limits: files are restored; a " +
			"module install/upgrade is NOT reverted at the database level.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["create", "list", "restore", "drop", "journal"],
				description: "Checkpoint operation.",
			},
			label: { type: "string", description: "Human label for operation=create." },
			dirs: { type: "array", items: { type: "string" }, description: "Directories (relative to the project root) to snapshot; default [\".\"]." },
			spec_id: { type: "string", description: "Spec id recorded in the checkpoint metadata." },
			checkpoint_id: { type: "string", description: "Target checkpoint for restore/drop/journal." },
			restore_data: { type: "boolean", description: "Also undo journaled data mutations (restore only)." },
			confirm_destructive: { type: "boolean", description: "REQUIRED true when restore_data=true." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					operation: { type: "string", required: true },
					activeCheckpoint: { type: "string" },
					restored: { type: "array", required: true, items: { type: "string" } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: {
			operation: "create" | "list" | "restore" | "drop" | "journal";
			label?: string;
			dirs?: string[];
			spec_id?: string;
			checkpoint_id?: string;
			restore_data?: boolean;
			confirm_destructive?: boolean;
		}) {
			const cfg = effectiveConfig();
			const projectRoot = cfg.projectRoot;
			const active = readActiveState(projectRoot);

			if (args.operation === "list") {
				const all = listCheckpoints(projectRoot);
				const lines = all.map((c) => `${c.id}  [${c.phase ?? "?"}] ${c.label} — ${c.files.length} file(s)`);
				return {
					ok: true, operation: "list" as string, activeCheckpoint: active.checkpointId ?? undefined,
					restored: [] as string[],
					detail: `Active: ${active.checkpointId ?? "none"}\nCheckpoints (${all.length}):\n${lines.join("\n") || "(none)"}`,
				};
			}

			if (args.operation === "journal") {
				const ops = args.checkpoint_id ? readCheckpointJournalFile(projectRoot, args.checkpoint_id) : readJournal(projectRoot);
				const lines = ops.map((o) => `${o.ts} ${o.model}.${o.method} ids=${JSON.stringify(o.ids)} created=${JSON.stringify(o.createdIds)}`);
				return {
					ok: true, operation: "journal" as string, activeCheckpoint: active.checkpointId ?? undefined,
					restored: [] as string[],
					detail: `Journaled operations (${ops.length}):\n${lines.join("\n") || "(none)"}`,
				};
			}

			if (args.operation === "drop") {
				if (!args.checkpoint_id) {
					return { ok: false, operation: "drop" as string, restored: [] as string[], detail: "operation=drop requires checkpoint_id." };
				}
				const dropped = dropCheckpoint(projectRoot, args.checkpoint_id);
				return {
					ok: dropped, operation: "drop" as string,
					activeCheckpoint: readActiveState(projectRoot).checkpointId ?? undefined,
					restored: [] as string[],
					detail: dropped ? `Dropped ${args.checkpoint_id}.` : `Checkpoint ${args.checkpoint_id} not found.`,
				};
			}

			if (args.operation === "create") {
				const label = args.label ?? `before-change`;
				const dirs = Array.isArray(args.dirs) && args.dirs.length > 0 ? args.dirs : ["."];
				const specId = args.spec_id ?? active.specId ?? null;
				const manifest = createCheckpoint(projectRoot, {
					label,
					dirs,
					specId,
					phase: active.phase,
					maxBytes: 25 * 1024 * 1024,
				});
				if (manifest === null) {
					return { ok: false, operation: "create" as string, restored: [] as string[], detail: "Could not create the checkpoint (filesystem error)." };
				}
				const purged = purgeCheckpoints(projectRoot, cfg.maxCheckpoints);
				appendAuditLine(projectRoot, "sdd_checkpoint/create", { label, dirs }, clientFor(projectRoot).credentials, {
					phase: active.phase ?? undefined, specId: specId ?? undefined,
				});
				return {
					ok: true, operation: "create" as string, activeCheckpoint: manifest.id,
					restored: [] as string[],
					detail:
						`Checkpoint ${manifest.id} created at ${displayPath(join(projectRoot, ".sdd", "checkpoints", manifest.id))} ` +
						`(${manifest.files.length} file(s)${manifest.truncated ? ", TRUNCATED by size budget" : ""}).` +
						(purged > 0 ? ` Purged ${purged} old checkpoint(s) (maxCheckpoints=${cfg.maxCheckpoints}).` : ""),
				};
			}

			// restore
			if (!args.checkpoint_id) {
				return { ok: false, operation: "restore" as string, restored: [] as string[], detail: "operation=restore requires checkpoint_id." };
			}
			const files = restoreCheckpointFiles(projectRoot, args.checkpoint_id);
			const restoredData: string[] = [];
			let dataNote = "data restore not requested";
			if (args.restore_data === true) {
				if (args.confirm_destructive !== true) {
					return {
						ok: false, operation: "restore" as string, restored: files.restored,
						detail: `Files restored (${files.restored.length}). Data restore refused: restore_data=true requires confirm_destructive=true.`,
					};
				}
				const undo = await undoJournal(projectRoot, args.checkpoint_id);
				restoredData.push(...undo.undone);
				dataNote = undo.detail;
			}
			appendAuditLine(projectRoot, "sdd_checkpoint/restore", { checkpoint: args.checkpoint_id, restore_data: args.restore_data === true }, clientFor(projectRoot).credentials, {
				phase: active.phase ?? undefined, specId: active.specId ?? undefined,
			});
			return {
				ok: true, operation: "restore" as string, activeCheckpoint: readActiveState(projectRoot).checkpointId ?? undefined,
				restored: files.restored,
				detail:
					`Restored ${files.restored.length} file(s) from ${args.checkpoint_id}` +
					(files.missing.length > 0 ? `; ${files.missing.length} failed: ${files.missing.slice(0, 5).join(", ")}` : "") +
					`. Data undo: ${dataNote}` +
					(restoredData.length > 0 ? ` (${restoredData.length} record op(s))` : ""),
			};
		},
	}));

	// ---------------------------------------------------------------------
	// odoo_security_scan — local static security review of a module tree
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_security_scan",
		description:
			"Static security review of an Odoo module directory, WITHOUT an instance. Flags raw SQL built " +
			"by concatenation, dynamic execution/deserialization, hardcoded secrets, unjustified sudo(), " +
			"auth=\"none\" routes, disabled CSRF, QWeb t-raw (XSS) and leftover debug hooks. Returns " +
			"file:line findings; any ERROR blocks DONE under the securityReviewRequired policy.",
		parameters: {
			module_dir: { type: "string", required: true, description: "Module directory to scan (absolute, or relative to the project root)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					clean: { type: "boolean", required: true },
					scannedFiles: { type: "number", required: true },
					count: { type: "number", required: true },
					findings: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: { module_dir: string }) {
			const cfg = effectiveConfig();
			const moduleDir = args.module_dir.startsWith("/") ? args.module_dir : join(cfg.projectRoot, args.module_dir);
			const result = scanModule(moduleDir);
			const lines = result.findings.map((f) => `${f.severity} ${f.rule} ${f.file}:${f.line} — ${f.message}\n    hint: ${f.hint}`);
			return {
				clean: result.clean,
				scannedFiles: result.scannedFiles,
				count: result.findings.length,
				findings: result.findings.map((f) => ({ ...f })),
				detail:
					`Scanned ${result.scannedFiles} file(s) under ${displayPath(moduleDir)}${result.truncated ? " (truncated)" : ""}. ` +
					`${result.findings.length} finding(s); clean=${result.clean}.\n` +
					(lines.join("\n") || "No findings."),
			};
		},
	}));

	// ---------------------------------------------------------------------
	// sdd_handoff — clean closing report for the spec
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "sdd_handoff",
		description:
			"Write the closing handoff for a spec: final phase, honest verdict, KB decisions/blockers, " +
			"checkpoints, journaled data operations, effective configuration and next steps, into " +
			"specs/<id>/handoff.md. Use it when the pipeline reaches DONE or BLOCKED so the next session " +
			"(or a human) starts from a clean, readable state.",
		parameters: {
			spec_id: { type: "string", required: true, description: "Spec directory id." },
			summary: { type: "string", description: "Optional summary line(s) to lead the document." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					file: { type: "string", required: true },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: { spec_id: string; summary?: string }) {
			const cfg = effectiveConfig();
			const specDir = specDirOf(config, args.spec_id);
			const state = loadState(specDir);
			const verdict = readVerdict(specDir);
			const kb = kbRead(specDir);
			const checkpoints = listCheckpoints(cfg.projectRoot);
			const journal = readJournal(cfg.projectRoot);
			const blockers = kb.filter((n) => n.kind === "blocker");
			const decisions = kb.filter((n) => n.kind === "decision");
			const securityReport = join(specDir, "security-report.md");

			const lines: string[] = [];
			lines.push(`# Handoff — ${args.spec_id}`);
			lines.push("");
			if (args.summary) { lines.push(args.summary.trim()); lines.push(""); }
			lines.push(`- Generated: ${new Date().toISOString()}`);
			lines.push(`- Final phase: ${state.phase}`);
			lines.push(`- Verdict: ${verdict === null ? "none" : verdict.passed ? "PASSED" : "FAILED"}`);
			lines.push(`- Failures: ${state.failureCount}/${state.maxFailuresBeforeDiagnosis}; iterations: ${state.iterationsUsed}/${state.maxIterations}`);
			lines.push(`- Security report: ${existsSync(securityReport) ? "present" : "MISSING"}`);
			lines.push("");
			lines.push("## Configuration in effect");
			lines.push(`- autonomy=${cfg.autonomy} licensed=${cfg.licensed}`);
			lines.push(`- allowlist=${JSON.stringify(cfg.executeAllowlist)}`);
			lines.push(`- communityRepo=${cfg.communityRepoPath || cfg.communityRepoUrl}`);
			lines.push(`- enterpriseRepo=${cfg.enterpriseRepoPath || cfg.enterpriseRepoUrl}`);
			lines.push(`- requireCheckpointBeforeMutation=${cfg.requireCheckpointBeforeMutation} securityReviewRequired=${cfg.securityReviewRequired} auditAllTools=${cfg.auditAllTools}`);
			lines.push("");
			lines.push("## Checkpoints");
			lines.push(checkpoints.length === 0 ? "- (none)" : checkpoints.map((c) => `- ${c.id} — ${c.label} (${c.files.length} file(s))`).join("\n"));
			lines.push("");
			lines.push("## Journaled data operations");
			lines.push(journal.length === 0 ? "- (none)" : journal.slice(-20).map((o) => `- ${o.ts} ${o.model}.${o.method} ids=${JSON.stringify(o.ids)} created=${JSON.stringify(o.createdIds)}`).join("\n"));
			lines.push("");
			lines.push("## Decisions (logbook)");
			lines.push(decisions.length === 0 ? "- (none)" : decisions.slice(-20).map((d) => `- ${d.summary}`).join("\n"));
			lines.push("");
			lines.push("## Open blockers");
			lines.push(blockers.length === 0 ? "- (none)" : blockers.slice(-10).map((b) => `- ${b.summary}`).join("\n"));
			lines.push("");
			lines.push("## Next steps");
			if (state.phase === "DONE") lines.push("- Delivered. Review the diff and commit with the project's conventions.");
			else if (state.phase === "BLOCKED") lines.push("- Blocked: resolve the open blockers above (or remove stop.md) and resume the pipeline.");
			else lines.push(`- Resume at ${state.phase}. Check .sdd/audit.jsonl for the recorded activity.`);

			try {
				mkdirSync(specDir, { recursive: true });
				writeFileSync(join(specDir, "handoff.md"), lines.join("\n") + "\n", { mode: 0o600 });
			} catch (err) {
				return { ok: false, file: "", detail: `Could not write handoff.md: ${err instanceof Error ? err.message : String(err)}` };
			}
			appendAuditLine(cfg.projectRoot, "sdd_handoff", { spec: args.spec_id }, clientFor(cfg.projectRoot).credentials, {
				phase: state.phase, specId: args.spec_id,
			});
			return {
				ok: true,
				file: displayPath(join(specDir, "handoff.md")),
				detail: `Handoff written to ${displayPath(join(specDir, "handoff.md"))} (phase ${state.phase}, verdict ${verdict === null ? "none" : verdict.passed ? "PASSED" : "FAILED"}).`,
			};
		},
	}));

	// ---------------------------------------------------------------------
	// Policy guard + run-wide audit ("model-visible means logged").
	//
	// The guard is a MONOTONIC host guard: returning a reason denies the call
	// and no later listener can turn the denial back into a permission. It
	// enforces, fail-closed:
	//   - stop.md halts every tool;
	//   - mutating calls need a checkpoint when the policy requires one;
	//   - mutating calls are refused before WRITE_CODE.
	// The `tools/result` listener records EVERY tool call of the run (ours and
	// foreign), so the activity is reconstructable from .sdd/audit.jsonl.
	// Both are best-effort: a policy bug must never brick the tool surface.
	// ---------------------------------------------------------------------
	const isMutatingCall = (name: string, args: Record<string, unknown>): boolean => {
		if (name === "odoo_execute") {
			const method = String(args["method"] ?? "");
			return method === "create" || method === "write" || method === "unlink";
		}
		if (name === "odoo_module") {
			const op = String(args["operation"] ?? "");
			return op === "install" || op === "upgrade";
		}
		return false;
	};

	const denyWithAudit = (name: string, args: Record<string, unknown>, reason: string): string => {
		try {
			const cfg = effectiveConfig();
			const active = readActiveState(cfg.projectRoot);
			recordAudit(
				cfg.projectRoot,
				{
					tool: name,
					args,
					outcome: "denied",
					source: "policy",
					reason,
					phase: active.phase ?? undefined,
					specId: active.specId ?? undefined,
				},
				clientFor(cfg.projectRoot).credentials,
			);
		} catch {
			// auditing is best-effort
		}
		return reason;
	};

	try {
		if (typeof ctx.tools.guard === "function") {
			ctx.tools.guard((execution: unknown): string | undefined => {
				try {
					const call = (execution ?? {}) as { name?: unknown; args?: unknown };
					const name = String(call.name ?? "");
					const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
					const cfg = effectiveConfig();
					const active = readActiveState(cfg.projectRoot);

					// 1) Emergency stop halts every tool.
					const stopCandidates = [join(cfg.projectRoot, ".sdd", "stop.md")];
					if (active.specId !== null) {
						stopCandidates.push(join(cfg.projectRoot, cfg.specsDir, active.specId, "stop.md"));
					}
					for (const candidate of stopCandidates) {
						if (existsSync(candidate)) {
							return denyWithAudit(name, args, `stop.md present at ${displayPath(candidate)} — every tool is halted until it is removed.`);
						}
					}

					// 2) Mutation policy (checkpoint + phase).
					if (isMutatingCall(name, args)) {
						if (cfg.requireCheckpointBeforeMutation && active.checkpointId === null) {
							return denyWithAudit(
								name,
								args,
								"Mutation blocked by policy: no checkpoint exists. Run `sdd_checkpoint` with operation=create first " +
									"(requireCheckpointBeforeMutation=true), or disable that policy with odoo_config.",
							);
						}
						const allowedPhases = ["WRITE_CODE", "VERIFY", "FIX_LOOP"];
						if (active.phase !== null && !allowedPhases.includes(active.phase)) {
							return denyWithAudit(
								name,
								args,
								`Mutation blocked: the active spec is in phase ${active.phase}. Approve the spec/architecture first ` +
									"so the pipeline reaches WRITE_CODE.",
							);
						}
					}
					return undefined;
				} catch {
					// A guard failure must never brick the surface: allow and move on.
					return undefined;
				}
			});
		}

		if (typeof ctx.on === "function") {
			ctx.on("tools/result", (...eventArgs: unknown[]) => {
				try {
					const cfg = effectiveConfig();
					if (!cfg.auditAllTools) return;
					const execution = (eventArgs[0] ?? {}) as { name?: unknown; args?: unknown };
					const result = (eventArgs[1] ?? {}) as { isError?: unknown; error?: unknown };
					const active = readActiveState(cfg.projectRoot);
					const failed = Boolean(result.isError) || result.error !== undefined;
					recordAudit(
						cfg.projectRoot,
						{
							tool: String(execution.name ?? "unknown"),
							args: execution.args,
							outcome: failed ? "error" : "ok",
							source: "tool",
							phase: active.phase ?? undefined,
							specId: active.specId ?? undefined,
						},
						clientFor(cfg.projectRoot).credentials,
					);
				} catch {
					// auditing is best-effort
				}
			});
		}
	} catch {
		// Hosts without guard/events keep working; the policy is simply inactive.
	}

	registerRuntimeTools(ctx, {
		client: () => clientFor(effectiveConfig().projectRoot),
		status: (pr) => setupStatusFor(pr),
		projectRoot: effectiveConfig().projectRoot,
		allowlist: () => effectiveConfig().executeAllowlist,
		recordDataOp: (op) => {
			try {
				appendDataOp(effectiveConfig().projectRoot, { ts: new Date().toISOString(), ...op });
			} catch {
				// journaling is best-effort
			}
		},
		display: (v) => displayPath(v),
	});
}
