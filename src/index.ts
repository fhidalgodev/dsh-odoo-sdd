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
import { writeFileAtomic } from "./atomic.js";
import { purgeOwnedState, purgePlan, PRESERVED } from "./lifecycle.js";
import { withAudit } from "./audit.js";
import { registerRuntimeTools } from "./tools-runtime.js";
import { registerDocsTool } from "./docs-tool.js";
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
	isSafeSegment,
	type DataOp,
} from "./checkpoints.js";
import {
	fingerprintOf,
	hasValidGrant,
	writeGrant,
	revokeGrants,
} from "./grants.js";
import { scanModule } from "./security-scan.js";
import { OdooClient } from "./odoo-client.js";
import {
	loadState,
	saveState,
	initSpecDir,
	transition,
	recordFailure,
	recordSuccess,
	recordDiagnosis,
	recordFailedVerdict,
	summarize,
	kbRead,
	kbAppend,
	readVerdict,
	type Phase,
	PHASES,
} from "./sdd-state.js";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "odoo-sdd";

/** Services this plugin injects from the host. */
export const inject = ["tools", "skills"];

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
	documentationPolicy: z.string(),
	documentationLanguage: z.string(),
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
	/** Whether documentation blocks DONE: "required" | "optional" | "off". */
	documentationPolicy?: string;
	/** Documentation language; empty means resolve from project files, then "en". */
	documentationLanguage?: string;
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
	// An unvalidated spec id could escape the specs root (traversal). Reject it
	// fail-closed: map to a neutral dir so nothing real is created/read.
	const safe = isSafeSegment(specId) ? specId : "__invalid__";
	return join(root(config), config.specsDir ?? "specs", safe);
}

/** Outcome of a host approval request (mirrors @deepseek-ai/dsh-user-approval). */
type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** Minimal shape of the host's native approval seam. */
interface ApprovalApi {
	request(req: {
		agent?: unknown;
		toolName: string;
		callId?: unknown;
		reason?: string;
		signal?: unknown;
	}): Promise<ApprovalOutcome>;
}

/** Host tool-call id of an execution, when the host supplied one. */
function callIdOf(exec: unknown): string | undefined {
	const e = (exec ?? {}) as { callId?: unknown };
	return typeof e.callId === "string" ? e.callId : undefined;
}

/**
 * Ask the host's native approval seam for a one-shot human decision.
 *
 * Fail-CLOSED: no `ctx.approval` service, a thrown error, or any outcome other
 * than `'allowed-once'` is reported as `'unavailable'`/its own refusal — never
 * as consent. This is the only path that can mint a grant, and the model cannot
 * fabricate its outcome.
 * @param ctx - plugin context carrying the optional approval service.
 * @param exec - the running execution (agent, callId, signal).
 * @param toolName - tool the question is about (presentation and audit).
 * @param reason - human-readable explanation of why approval is needed.
 * @returns the approval outcome, or `'unavailable'` when it cannot be asked.
 */
async function requestNativeApproval(
	ctx: unknown,
	exec: unknown,
	toolName: string,
	reason: string,
): Promise<ApprovalOutcome> {
	try {
		const api = (ctx as { approval?: ApprovalApi }).approval;
		if (api === null || api === undefined || typeof api.request !== "function") return "unavailable";
		const e = (exec ?? {}) as { agent?: unknown; signal?: unknown };
		const outcome = await api.request({
			agent: e.agent,
			toolName,
			...(callIdOf(exec) !== undefined ? { callId: callIdOf(exec) } : {}),
			reason,
			...(e.signal !== undefined ? { signal: e.signal } : {}),
		});
		return outcome === "allowed-once"
			? "allowed-once"
			: outcome === "rejected" || outcome === "cancelled" || outcome === "unavailable"
				? outcome
				: "unavailable";
	} catch {
		return "unavailable";
	}
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
	const creds = loaded.credentials;
	// Authorization is independent of credentials: possessing them is not
	// consent. Without a live human grant for THIS target, no client is handed
	// out, so no tool can open a socket. Credentials are still returned so
	// redaction keeps working on every output path.
	if (!hasValidGrant(projectRoot, "connection", fingerprintOf(creds.url, creds.db, creds.username))) {
		return {
			client: null,
			report:
				`NOT AUTHORIZED: no live human grant for ${creds.url} (db=${creds.db}, user=${creds.username}). ` +
				"Run odoo_setup mode=authorize and have the developer approve the connection; " +
				"credentials alone do not authorize access.",
			credentials: creds,
		};
	}
	return {
		client: new OdooClient(creds),
		report: describeCredentials(creds),
		credentials: creds,
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

interface SkillApi {
	register(skill: {
		name: string;
		description: string;
		content: string;
		whenToUse?: string;
		invocation?: { modelInvocable: boolean; userInvocable: boolean };
		source?: string;
		resourceBase?: { kind: "directory"; path: string };
		path?: string;
	}): () => void;
}

const ODOO_SDD_SKILL_NAME = "odoo-sdd-workflow";

/**
 * Register the bundled workflow as a runtime skill so DSH advertises it in the
 * model-facing catalog (modelInvocable) and the user-facing catalog
 * (userInvocable) on every new session. This is what makes the protocol
 * discoverable automatically after a user installs the plugin, instead of
 * requiring them to reach into `skills/odoo-sdd-workflow/SKILL.md` by hand.
 */
function registerOdooSddSkill(ctx: unknown): void {
	try {
		const c = ctx as { skills?: SkillApi };
		const skillPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"skills",
			"odoo-sdd-workflow",
			"SKILL.md",
		);
		const raw = readFileSync(skillPath, "utf8");
		// Strip the `---` frontmatter from the body and lift its single-line
		// keys into the registry summary, so the model sees a clean description
		// and the body is pure instructions.
		const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
		let name = ODOO_SDD_SKILL_NAME;
		let description = "";
		let whenToUse: string | undefined;
		let content = raw;
		if (front) {
			content = raw.slice(front[0].length);
			for (const line of front[1].split(/\r?\n/)) {
				const m = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
				if (!m) continue;
				const value = m[2].trim().replace(/^["']|["']$/g, "");
				if (m[1] === "name") name = value;
				else if (m[1] === "description") description += (description ? " " : "") + value;
				else if (m[1] === "whenToUse" || m[1] === "when-to-use") whenToUse = value;
			}
		}
		const api = c.skills;
		if (!api || typeof api.register !== "function") return; // fail-open: no skills host
		const pkgRoot = dirname(fileURLToPath(import.meta.url)); // .../lib
		api.register({
			name,
			description:
				description ||
				"Spec-Driven Development pipeline for Odoo modules on top of the dsh-odoo-sdd plugin.",
			...(whenToUse ? { whenToUse } : {}),
			content,
			invocation: { modelInvocable: true, userInvocable: true },
			// `source` is part of the host SkillRegistration contract (the
			// registry re-validates it when the definition is loaded); omitting
			// it can make the registry reject the skill even though apply ran.
			source: "runtime",
			// Resolve relative resources (agents/*.md) from the installed package
			// location, not from cwd.
			resourceBase: { kind: "directory", path: join(pkgRoot, "..", "agents") },
			path: skillPath,
		});
	} catch {
		// A missing/unreadable skill must never break the plugin mount; the
		// workflow stays available in the repository as a file.
	}
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
	// A skill registry is optional on some hosts; register the bundled workflow
	// when present so it is advertised to the model on every new session.
	registerOdooSddSkill(ctx);
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
		documentationPolicy: config.documentationPolicy ?? "required",
		documentationLanguage: config.documentationLanguage ?? "",
	};
	// Live source of the Settings section. The host hands us a THUNK returning
	// the currently authoritative value (the resolved user scope while attached,
	// the composition entry otherwise). Keeping the thunk — instead of ignoring
	// it — is what makes edits in Settings → Odoo SDD actually reach the tools.
	let settingsValues: (() => Record<string, unknown>) | null = null;
	ctx.inject?.<SddsSettingsProvider>(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(
			ctx,
			ODOO_SDD_NAMESPACE,
			Config,
			sddsDefaultConfig,
			{
				setSource: (current: () => unknown) => {
					settingsValues = () => {
						const value = current();
						return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
					};
				},
				onChange: () => {
					// effectiveConfig() resolves live on every call, so there is no
					// cached layer to invalidate; the next tool call sees the change.
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
			const { client, report, credentials } = clientFor(projectRoot);
			if (client === null) {
				// Two different situations share a null client:
				//  - credentials loaded but no live human grant => NOT AUTHORIZED
				//    (report says exactly that);
				//  - no usable credentials => surface the onboarding state
				//    (NEEDS_SECRET / DEFERRED / SKIPPED / needs-setup).
				if (credentials !== null) return { connected: false, target: "", detail: report };
				return { connected: false, target: "", detail: setupStatusFor(projectRoot).detail };
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
			"— secrets are never accepted as tool parameters. mode=authorize asks the DEVELOPER (native " +
			"approval) for a connection grant covering the current url/db/user: without it no tool may " +
			"open a socket, because possessing credentials is not authorization. mode=revoke drops the " +
			"stored grants. mode=later defers setup until the VERIFY phase; mode=skip marks the project " +
			"to run without an instance (manual verification); mode=reset clears the persisted decision. " +
			"mode=purge reports (and, with confirm_destructive=true plus human approval, removes) only the " +
			"plugin's own state under .sdd/ — credentials, stop.md and specs/ are always preserved.",
		parameters: {
			mode: {
				type: "string",
				required: true,
				enum: ["check", "interactive", "later", "skip", "reset", "autonomy", "authorize", "revoke", "purge"],
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
			confirm_destructive: {
				type: "boolean",
				description: "REQUIRED true to actually run mode=purge. Without it, purge only reports its plan.",
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
			mode: "check" | "interactive" | "later" | "skip" | "reset" | "autonomy" | "authorize" | "revoke" | "purge";
			url?: string;
			db?: string;
			username?: string;
			scope?: "user" | "project";
			decision?: "supervised" | "autonomous";
			confirm_destructive?: boolean;
		}, exec?: unknown) {
			const projectRoot = root(config);
			const autonomyMode = readAutonomy(projectRoot);
			appendAuditLine(projectRoot, "odoo_setup/" + args.mode, args, clientFor(projectRoot).credentials);

			if (args.mode === "authorize") {
				const loaded = loadCredentials(projectRoot);
				if (!loaded.ok) {
					return {
						mode: "authorize" as string,
						status: "not-authorized",
						detail:
							`Cannot authorize yet: credentials are not configured (${loaded.reason}). ` +
							"Complete .env first, then run mode=authorize.",
					};
				}
				const creds = loaded.credentials;
				const fingerprint = fingerprintOf(creds.url, creds.db, creds.username);
				const outcome = await requestNativeApproval(
					ctx,
					exec,
					"odoo_setup",
					`Authorize Odoo connection to ${creds.url} (db=${creds.db}, user=${creds.username})? ` +
						"The grant covers this exact target and expires; any change to url/db/user requires a new one.",
				);
				if (outcome !== "allowed-once") {
					return {
						mode: "authorize" as string,
						status: "not-authorized",
						detail:
							`Connection NOT authorized (approval outcome: ${outcome}). ` +
							"No socket will be opened towards the instance. Ask the developer to approve " +
							"mode=authorize from a session whose answerer is attached.",
					};
				}
				writeGrant(projectRoot, {
					kind: "connection",
					fingerprint,
					callId: callIdOf(exec),
					reason: "odoo_setup mode=authorize",
				});
				return {
					mode: "authorize" as string,
					status: "authorized",
					detail:
						`Connection AUTHORIZED by the developer for ${creds.url} (db=${creds.db}, ` +
						`user=${creds.username}). The grant is stored in .sdd/grants.json (0600, gitignored) ` +
						"and expires; revoke it with mode=revoke or by changing the target.",
				};
			}

			if (args.mode === "revoke") {
				const removed = revokeGrants(projectRoot);
				return {
					mode: "revoke" as string,
					status: "revoked",
					detail:
						`Revoked ${removed} stored grant(s). Every tool that would reach the Odoo instance ` +
						"is blocked until a new human authorization (mode=authorize).",
				};
			}

			if (args.mode === "purge") {
				// Always show the plan first: nothing is deleted implicitly.
				const plan = purgePlan(projectRoot);
				if (args.confirm_destructive !== true) {
					return {
						mode: "purge" as string,
						status: "plan",
						detail:
							"PURGE PLAN (dry run — nothing was deleted).\n" +
							plan +
							"\nRe-run with confirm_destructive=true to remove the owned state above. " +
							"The plan is shown first so a purge is never a surprise.",
					};
				}
				// Deleting the plugin's own state is destructive: a human approves.
				const outcome = await requestNativeApproval(
					ctx,
					exec,
					"odoo_setup",
					`Purge the plugin's own state under ${displayPath(join(projectRoot, ".sdd"))} ` +
						"(grants, session cookie, active run, audit log, configuration, setup marker, checkpoints)? " +
						"Your .env, stop.md and specs/ are preserved.",
				);
				if (outcome !== "allowed-once") {
					return {
						mode: "purge" as string,
						status: "not-authorized",
						detail:
							`Purge NOT performed (approval outcome: ${outcome}). Nothing was deleted.\n` + plan,
					};
				}
				const result = purgeOwnedState(projectRoot);
				appendAuditLine(projectRoot, "odoo_setup/purge", { removed: result.removed.length }, null);
				return {
					mode: "purge" as string,
					status: "purged",
					detail:
						`Purged ${result.removed.length} owned path(s)` +
						(result.removed.length > 0 ? `: ${result.removed.join(", ")}` : "") +
						(result.failed.length > 0 ? `. FAILED (left in place): ${result.failed.join(", ")}` : "") +
						(result.absent.length > 0 ? `. Absent already: ${result.absent.length}` : "") +
						".\nPreserved: " +
						PRESERVED.map((p) => p.rel).join(", ") +
						". The purge itself is recorded in .sdd/audit.jsonl (the only file it recreates). " +
						"The connection is now unauthorized: run mode=authorize again before any tool touches Odoo.",
				};
			}

			if (args.mode === "autonomy") {
				const decision: AutonomyMode = args.decision === "autonomous" ? "autonomous" : "supervised";
				// Delegation mode decides WHO answers every later gate, so the model
				// may not change it on its own authority: a human must approve.
				const outcome = await requestNativeApproval(
					ctx,
					exec,
					"odoo_setup",
					`Switch the delegation mode to ${decision.toUpperCase()}? This decides who answers every later phase gate.`,
				);
				if (outcome !== "allowed-once") {
					return {
						mode: "autonomy" as string,
						status: "not-authorized",
						detail:
							`Delegation mode unchanged (approval outcome: ${outcome}). A human must approve ` +
							"the switch; the model cannot relax the pipeline's own gates.",
					};
				}
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
						`Delegation mode set to ${decision.toUpperCase()} (approved by the developer). ` +
						(decision === "autonomous"
							? "A human-proxy agent will answer the phase gates with only a line-start APPROVED accepted, fail-closed. stop.md and iteration ceilings remain armed; BLOCKED escalates to a human. Connection grants do NOT cover this: a human still authorizes the instance once (mode=authorize)."
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
				enum: ["init", "clarify", "status", "mark_spec_loaded", "advance", "fail", "succeed", "rollback", "diagnose"],
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
			operation: "init" | "clarify" | "status" | "mark_spec_loaded" | "advance" | "fail" | "succeed" | "rollback" | "diagnose";
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
					{
						securityReviewRequired: effectiveConfig().securityReviewRequired,
						documentationPolicy: effectiveConfig().documentationPolicy ?? "required",
					},
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
			if (args.operation === "diagnose") {
				// The ladder owes a diagnosis; this is what actually clears it.
				const updatedD = recordDiagnosis(state, note || "root-cause diagnosis recorded");
				return {
					operation: "diagnose" as string, phase: updatedD.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(updatedD),
					detail:
						"Root-cause diagnosis recorded in the KB. The fix loop may resume — the retry gate is " +
						"open until the failure streak trips the ladder again.",
				};
			}
			// succeed
			const outcome = recordSuccess(state, note || "verification passed");
			if (!outcome.ok) {
				return {
					operation: "succeed" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
					summary: summarize(state),
					detail:
						"PASSED verdict REFUSED: the evidence is incomplete. " +
						outcome.gaps.join(" ") +
						" Record the real result of each acceptance criterion in test-plan.md, then retry. " +
						"A green verdict must map to a tested criterion.",
				};
			}
			return {
				operation: "succeed" as string, phase: outcome.state.phase as string, ok: true, requireDiagnosis: false,
				summary: summarize(outcome.state),
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
		writeFileAtomic(file, JSON.stringify(data, null, 2));
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
			documentationPolicy: { type: "string", enum: ["required", "optional", "off"], description: "Whether documentation blocks DONE." },
			documentationLanguage: { type: "string", description: "Documentation language; empty resolves from the project's own rules, then English." },
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
					documentationPolicy: { type: "string", required: true },
					documentationLanguage: { type: "string", required: true },
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
			documentationPolicy?: string;
			documentationLanguage?: string;
		}, exec?: unknown) {
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
					documentationPolicy: (() => {
						const v = asString(data["documentationPolicy"], "required");
						return v === "optional" || v === "off" ? v : "required";
					})(),
					documentationLanguage: asString(data["documentationLanguage"], ""),
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
			// Deployment policy is the model's to PROPOSE, not to grant. Changing
			// the allowlist or switching a fail-closed guard off requires a human
			// decision through the native approval seam.
			const outcome = await requestNativeApproval(
				ctx,
				exec,
				"odoo_config",
				"Apply plugin configuration changes (allowlist / policy guards / repositories)? " +
					"This alters which RPC mutations are permitted and which safety guards stay armed.",
			);
			if (outcome !== "allowed-once") {
				return {
					mode: "set" as string,
					ok: false,
					config: normalize(loadConfigFile()),
					detail:
						`Configuration unchanged (approval outcome: ${outcome}). A human must approve ` +
						"policy changes; ask the developer to confirm, then retry.",
				};
			}
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
			if (args.documentationPolicy !== undefined) updates["documentationPolicy"] = args.documentationPolicy;
			if (args.documentationLanguage !== undefined) updates["documentationLanguage"] = args.documentationLanguage;
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
		// Layer order (highest last): deployment config → Settings (human) →
		// .sdd/config.json (written by odoo_config, itself human-approved).
		// `undefined` values are dropped so a sparse settings payload cannot
		// erase a deployment value with nothing.
		const settings: Record<string, unknown> = (() => {
			try {
				return settingsValues?.() ?? {};
			} catch {
				return {};
			}
		})();
		const merged: Record<string, unknown> = { ...(config as Record<string, unknown>) };
		for (const [key, value] of Object.entries(settings)) {
			if (value !== undefined) merged[key] = value;
		}
		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined) merged[key] = value;
		}
		const asString = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
		const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
		const asNum = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
		return {
			projectRoot: asString(merged["projectRoot"], config.projectRoot ?? root(config)),
			specsDir: asString(merged["specsDir"], config.specsDir ?? "specs"),
			executeAllowlist: Array.isArray(merged["executeAllowlist"]) ? asList(merged["executeAllowlist"]) : (config.executeAllowlist ?? []),
			communityRepoUrl: asString(merged["communityRepoUrl"], config.communityRepoUrl ?? "https://github.com/odoo/odoo"),
			communityRepoPath: asString(merged["communityRepoPath"], config.communityRepoPath ?? ""),
			enterpriseRepoUrl: asString(merged["enterpriseRepoUrl"], config.enterpriseRepoUrl ?? "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asString(merged["enterpriseRepoPath"], config.enterpriseRepoPath ?? ""),
			autonomy: asString(merged["autonomy"], config.autonomy ?? "supervised"),
			licensed: ((v: unknown, fb: string): string => (asString(v, fb) === "enterprise" ? "enterprise" : "community"))(merged["licensed"], config.licensed ?? "community"),
			requireCheckpointBeforeMutation: asBool(merged["requireCheckpointBeforeMutation"], config.requireCheckpointBeforeMutation ?? true),
			securityReviewRequired: asBool(merged["securityReviewRequired"], config.securityReviewRequired ?? true),
			securityInterviewRequired: asBool(merged["securityInterviewRequired"], config.securityInterviewRequired ?? true),
			auditAllTools: asBool(merged["auditAllTools"], config.auditAllTools ?? true),
			maxCheckpoints: asNum(merged["maxCheckpoints"], config.maxCheckpoints ?? 5),
			documentationPolicy: asString(merged["documentationPolicy"], config.documentationPolicy ?? "required"),
			documentationLanguage: asString(merged["documentationLanguage"], config.documentationLanguage ?? ""),
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
		const { client, credentials } = clientFor(projectRoot);
		if (client === null) return { undone: [], detail: "no instance configured — journal left intact" };
		// Database identity: replaying a journal recorded against another database
		// would mutate the wrong instance, so refuse instead of guessing.
		const stamped = [...new Set(ops.map((o) => o.db).filter((d): d is string => typeof d === "string"))];
		const current = credentials?.db;
		if (stamped.length > 0 && current !== undefined && !stamped.includes(current)) {
			return {
				undone: [],
				detail:
					`refused: the journal was recorded against database "${stamped.join(", ")}" but the ` +
					`current target is "${current}". Point .env at the original database (or drop the ` +
					"journal) before undoing data.",
			};
		}
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
			writeFileAtomic(join(projectRoot, ".sdd", "checkpoints", checkpointId, "journal.json"), JSON.stringify(ops, null, 2));
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
			remove_created: { type: "boolean", description: "restore only: also delete files created AFTER the checkpoint, so the tree matches the snapshot exactly (destructive; off by default)." },
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
			remove_created?: boolean;
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
			const files = restoreCheckpointFiles(projectRoot, args.checkpoint_id, {
				prune: args.remove_created === true,
			});
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
			appendAuditLine(projectRoot, "sdd_checkpoint/restore", { checkpoint: args.checkpoint_id, restore_data: args.restore_data === true, remove_created: args.remove_created === true }, clientFor(projectRoot).credentials, {
				phase: active.phase ?? undefined, specId: active.specId ?? undefined,
			});
			// Drift after the checkpoint is always REPORTED; removing it is
			// destructive and only happens when explicitly requested.
			const drift =
				files.created.length === 0
					? " no files were created after this checkpoint."
					: ` ${files.created.length} file(s) were created AFTER this checkpoint: ` +
						`${files.created.slice(0, 5).join(", ")}${files.created.length > 5 ? ", …" : ""}. ` +
						(files.pruned.length > 0
							? `${files.pruned.length} removed (remove_created=true).`
							: "Pass remove_created=true to delete them and match the snapshot exactly.");
			return {
				ok: true, operation: "restore" as string, activeCheckpoint: readActiveState(projectRoot).checkpointId ?? undefined,
				restored: files.restored,
				detail:
					`Restored ${files.restored.length} file(s) from ${args.checkpoint_id}` +
					(files.missing.length > 0 ? `; ${files.missing.length} failed: ${files.missing.slice(0, 5).join(", ")}` : "") +
					`. Data undo: ${dataNote}` +
					(restoredData.length > 0 ? ` (${restoredData.length} record op(s))` : "") +
					drift,
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
			lines.push(decisions.length === 0 ? "- (none)" : decisions.slice(-20).map((d) => `- ${sanitize(d.summary)}`).join("\n"));
			lines.push("");
			lines.push("## Open blockers");
			lines.push(blockers.length === 0 ? "- (none)" : blockers.slice(-10).map((b) => `- ${sanitize(b.summary)}`).join("\n"));
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
					const call = (execution ?? {}) as { name?: unknown; arguments?: unknown };
					const name = String(call.name ?? "");
					// Host contract: dsh-tools 0.1.5 exposes `execution.arguments`
					// (readonly unknown). Reading `args` never reflected the real
					// payload, so the allowlist/phase/checkpoint gates were broken.
					// Fall back to `args` only for older/host-compat, never rely on it.
					const rawArgs = call.arguments ?? (call as { args?: unknown }).args ?? {};
					const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
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
				} catch (err) {
					// Fail-CLOSED: an internal guard failure must deny, never allow.
					// Allowing here would turn any bug (unreadable state, unexpected
					// shape) into a silent policy bypass.
					const detail = err instanceof Error ? err.message : String(err);
					return (
						"Mutation blocked: the policy guard failed internally " +
						`(${detail.slice(0, 200)}). Denying fail-closed — inspect .sdd/ and remove stop.md if it is stale.`
					);
				}
			});
		}

		if (typeof ctx.on === "function") {
			// Stamp the start of every call so the result entry carries a real
			// duration instead of the previous hard-coded 0.
			const startedAt = new Map<string, number>();
			ctx.on("tools/pre-execute", (...eventArgs: unknown[]) => {
				try {
					const exec = (eventArgs[0] ?? {}) as { callId?: unknown };
					if (typeof exec.callId === "string") startedAt.set(exec.callId, Date.now());
				} catch {
					// best-effort timing
				}
			});
			ctx.on("tools/result", (...eventArgs: unknown[]) => {
				try {
					const cfg = effectiveConfig();
					if (!cfg.auditAllTools) return;
					const execution = (eventArgs[0] ?? {}) as { name?: unknown; arguments?: unknown; callId?: unknown };
					const result = (eventArgs[1] ?? {}) as { isError?: unknown; error?: unknown };
					const active = readActiveState(cfg.projectRoot);
					const failed = Boolean(result.isError) || result.error !== undefined;
					const callId = typeof execution.callId === "string" ? execution.callId : undefined;
					const began = callId !== undefined ? startedAt.get(callId) : undefined;
					if (callId !== undefined) startedAt.delete(callId);
					recordAudit(
						cfg.projectRoot,
						{
							tool: String(execution.name ?? "unknown"),
							// `arguments` is the host contract; `args` is legacy.
							args: execution.arguments ?? (execution as { args?: unknown }).args,
							outcome: failed ? "error" : "ok",
							ms: began === undefined ? 0 : Math.max(0, Date.now() - began),
							source: "tool",
							kind: "tool",
							...(callId !== undefined ? { callId } : {}),
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

	registerDocsTool(ctx, {
		projectRoot: () => effectiveConfig().projectRoot,
		configuredLanguage: () => effectiveConfig().documentationLanguage,
		display: (v) => displayPath(v),
	});

	registerRuntimeTools(ctx, {
		client: () => clientFor(effectiveConfig().projectRoot),
		status: (pr) => setupStatusFor(pr),
		projectRoot: effectiveConfig().projectRoot,
		allowlist: () => effectiveConfig().executeAllowlist,
		recordDataOp: (op) => {
			try {
				const cfg = effectiveConfig();
				// Stamp the database so a replay against a DIFFERENT database can
				// be detected instead of silently mutating another instance.
				const db = clientFor(cfg.projectRoot).credentials?.db;
				appendDataOp(cfg.projectRoot, {
					ts: new Date().toISOString(),
					...(db !== undefined ? { db } : {}),
					...op,
				});
			} catch {
				// journaling is best-effort
			}
		},
		display: (v) => displayPath(v),
		auditFailure: (info) => {
			try {
				const cfg = effectiveConfig();
				const active = readActiveState(cfg.projectRoot);
				recordAudit(
					cfg.projectRoot,
					{
						tool: info.tool,
						op: info.op,
						outcome: "error",
						source: "tool",
						kind: "rpc",
						...(info.callId !== undefined ? { callId: info.callId } : {}),
						reason: info.reason,
						phase: active.phase ?? undefined,
						specId: active.specId ?? undefined,
					},
					clientFor(cfg.projectRoot).credentials,
				);
			} catch {
				// auditing is best-effort
			}
		},
	});
}
