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
	instanceEnvPath,
	listInstances,
	readActiveInstance,
	writeActiveInstance,
	removeInstance,
	ambiguousInstances,
	parseInstanceUrl,
	ensureSecurePermissions,
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
import { resolveModuleDir } from "./paths.js";
import {
	asSpecsMode,
	describeSpecsLocation,
	resolveRoot,
	sessionCwdOf,
	specDirFor,
	specsBaseFor,
	type ResolvedRoot,
	type RootSource,
	type SpecsLayout,
} from "./specs-location.js";
import { purgeOwnedState, purgePlan, PRESERVED } from "./lifecycle.js";
import { withAudit } from "./audit.js";
import { registerRuntimeTools } from "./tools-runtime.js";
import { isReadMethod, isCallableMethodName } from "./method-classification.js";
import { registerDocsTool } from "./docs-tool.js";
import { registerFunctionalTool, activeFunctionalRun, functionalDir, readPlan, readRun, countOps } from "./functional.js";
import { registerImportTool, readWebSession, capabilitiesFor, readImportOutcome, reportAppliedImport } from "./odoo-import.js";
import { applyArguments } from "./import-capabilities.js";
import { sha256 } from "./functional.js";
import { RUNBOOK_FILE, runbookGaps } from "./sdd-state.js";
import { appendAuditLine, recordAudit } from "./audit.js";
import {
	readActiveState,
	writeActiveState,
	writeActiveStateFor,
	resolveActiveState,
	clearActiveFieldEverywhere,
	activeSessionPath,
	listActiveSessions,
	activeSessionsDir,
	readWaiver,
	writeWaiver,
	clearWaiver,
	waiverCovers,
	createCheckpoint,
	listCheckpoints,
	restoreCheckpointFiles,
	dropCheckpoint,
	purgeCheckpoints,
	readJournal,
	writeJournal,
	appendDataOp,
	isSafeSegment,
	isWithinRoot,
	toWriteValues,
	fieldMetaFor,
	writeCheckpointJournal,
	type FieldMeta,
	type DataOp,
} from "./checkpoints.js";
import {
	fingerprintOf,
	hasValidGrant,
	writeGrant,
	revokeGrants,
	readGrants,
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
	recordIntent,
	isPipelineMode,
	verdictStaleness,
	declaredAcIds,
	GATED_PHASES,
	type Phase,
	type PipelineMode,
	PHASES,
	PIPELINE_MODES,
} from "./sdd-state.js";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "odoo-sdd";

/** Services this plugin injects from the host. */
export const inject = ["tools", "skills"];

/**
 * Mark a schema node as editable in Settings, when the schema library supports it.
 *
 * `.volatile()` is what the host's `volatileForm` looks for, and it exists from
 * schemastery 3.18.4 on. A host whose resolved copy is older (pnpm installed
 * 3.18.2 for a profile, for instance) would otherwise make this module THROW at
 * import time, taking the whole plugin down over a form marker — so the marker is
 * applied when available and skipped when not, with the reason reported once.
 * The tool surface and the pipeline never depend on it.
 * @param field - the schema node to mark.
 * @returns the same node, marked when the library supports it.
 */
let volatileWarningReported = false;
const markVolatile = <T>(field: T): T => {
	// The method is optional in the type on purpose: it is what an OLDER
	// schemastery lacks, and the whole point is to keep working there.
	const marker = (field as { volatile?: () => T }).volatile;
	if (typeof marker === "function") return marker.call(field);
	if (!volatileWarningReported) {
		volatileWarningReported = true;
		try {
			console.warn(
				"[dsh-odoo-sdd] this host resolves @deepseek-ai/schemastery without `.volatile()`, so the Settings form " +
					"will be incomplete or absent. dsh-settings needs schemastery >= 3.18.4. The tools and the pipeline " +
					"are unaffected; edit the configuration with `odoo_config mode=read|set`.",
			);
		} catch {
			// a host without console is not a reason to fail
		}
	}
	return field;
};

/**
 * Deployment configuration schema (settable from cordis.patch.yml).
 *
 * Schemastery convention: a property WITHOUT `.required()` is optional.
 *
 * `.volatile()` is what makes a field EDITABLE in Settings. The host derives the
 * plugin's form from this schema (`volatileForm` keeps only nodes flagged
 * volatile) and refuses the whole entry when none is: "Plugin entry has no
 * volatile fields". Without those markers the section has nothing to render, so
 * a host that relies on the schema would show no panel at all.
 *
 * `projectRoot` is deliberately NOT volatile: it is a fallback for hosts with no
 * session, and the effective root is the folder the developer opened in DSH —
 * offering it as a plugin-wide field would be wrong for every project but one.
 */
export const Config = z.object({
	projectRoot: z.string(),
	specsMode: markVolatile(z.string()),
	specsRoot: markVolatile(z.string()),
	specsDir: markVolatile(z.string()),
	executeAllowlist: markVolatile(z.array(z.string())),
	methodAllowlist: markVolatile(z.array(z.string())),
	communityRepoUrl: markVolatile(z.string()),
	communityRepoPath: markVolatile(z.string()),
	enterpriseRepoUrl: markVolatile(z.string()),
	enterpriseRepoPath: markVolatile(z.string()),
	autonomy: markVolatile(z.string()),
	requireCheckpointBeforeMutation: markVolatile(z.boolean()),
	requireSpecForChanges: markVolatile(z.boolean()),
	adoptProjectPointerHint: markVolatile(z.boolean()),
	odooApi: markVolatile(z.string()),
	securityReviewRequired: markVolatile(z.boolean()),
	securityInterviewRequired: markVolatile(z.boolean()),
	auditAllTools: markVolatile(z.boolean()),
	maxCheckpoints: markVolatile(z.number()),
	documentationPolicy: markVolatile(z.string()),
	documentationLanguage: markVolatile(z.string()),
});

/** Effective deployment configuration after validation. */
interface OdooSddConfig {
	/**
	 * Fallback project root: used ONLY when the calling session has no cwd
	 * (headless/CI) or when a tool call names one explicitly. The primary
	 * answer is always the session's own folder, which is why the Settings
	 * panel no longer exposes this as an editable field.
	 */
	projectRoot?: string;
	/** Where specs live: "project" (default) or "central". */
	specsMode?: string;
	/** Absolute folder collecting every project's specs in central mode. */
	specsRoot?: string;
	/** Folder name inside the project root in project mode (default "specs"). */
	specsDir?: string;
	/** Models permitted for MUTATING calls (create/write/unlink) on odoo_execute. Empty = denied. */
	executeAllowlist?: string[];
	/** Declared "model.method" pairs a functional batch may call as a business action. Empty = denied. */
	methodAllowlist?: string[];
	/** Odoo Community source: git URL or local path (empty when not set). */
	communityRepoUrl?: string;
	communityRepoPath?: string;
	/** Odoo Enterprise source: git URL or local path (empty when not set). */
	enterpriseRepoUrl?: string;
	enterpriseRepoPath?: string;
	/** Default delegation mode: supervised | autonomous. */
	autonomy?: string;
	/** No change — instance mutation or project file edit — without a spec that authorizes it, or a session waiver. */
	requireSpecForChanges?: boolean;
	/**
	 * Let a session with no pointer of its own adopt the project's last spec as a
	 * hint. On by default for continuity; turn it off to require every session to
	 * declare its own spec before anything authorizes a change.
	 */
	adoptProjectPointerHint?: boolean;
	/**
	 * Transport for model calls: "auto" (JSON-2 where the server offers it),
	 * "json2" (pinned; a missing route is reported) or "jsonrpc" (classic).
	 */
	odooApi?: string;
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
/**
 * The DEPLOYMENT root: the plugin's own `projectRoot`, else the process cwd.
 * Used only as the bootstrap/fallback for locating `.sdd/config.json` and as
 * the last-resort default for the effective root. An empty string must be
 * treated as "not set" — `'' ?? x` is `''`, which silently resolved to cwd.
 */
function baseRoot(config: OdooSddConfig): string {
	const declared = (config.projectRoot ?? "").trim();
	return declared === "" ? resolve(process.cwd()) : resolve(declared);
}

/**
 * Resolve a spec directory, given the EFFECTIVE project root and layout.
 * Kept as a thin wrapper so every call site reads from the same validated
 * layout object (project vs central) instead of re-deriving paths by hand.
 */
function specDirOf(
	projectRoot: string,
	specsDir: string | undefined,
	specId: string,
	layout?: { specsMode?: string; specsRoot?: string },
	opts?: { create?: boolean },
): string {
	return specDirFor(
		{
			projectRoot,
			specsMode: asSpecsMode(layout?.specsMode),
			specsDir: specsDir ?? "specs",
			specsRoot: layout?.specsRoot ?? "",
		},
		specId,
		opts,
	);
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
 * Read an OPTIONAL host service, whether or not it was declared in `inject`.
 *
 * Verified against cordis: `ctx.<name>` THROWS `cannot get property "<name>"
 * without inject` for any service the plugin did not declare, so a naive
 * property read silently degrades (or breaks the call). Declaring the service
 * in `inject` is not an option either: it would make the whole plugin refuse to
 * mount on a host that does not provide it. `ctx.get(name, false)` is cordis's
 * documented non-throwing read; plain objects (test doubles, minimal hosts) get
 * the property read as a second chance. Either way this never throws.
 * @param ctx - plugin context.
 * @param name - service name (e.g. "sessions", "approval").
 * @returns the service, or undefined when the host does not provide it.
 */
function optionalService(ctx: unknown, name: string): unknown {
	if (ctx === null || typeof ctx !== "object") return undefined;
	try {
		const api = (ctx as { get?: (n: string, strict?: boolean) => unknown }).get;
		if (typeof api === "function") {
			const value = api.call(ctx, name, false);
			if (value !== undefined && value !== null) return value;
		}
	} catch {
		// fall through to the property read
	}
	try {
		const value = (ctx as Record<string, unknown>)[name];
		return value === null ? undefined : value;
	} catch {
		// cordis throws here for a service that was not injected
		return undefined;
	}
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
		const api = optionalService(ctx, "approval") as ApprovalApi | undefined;
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
/**
 * Narrow a configured string to a transport preference.
 *
 * The configuration layer is a string (it comes from JSON/YAML), so the value is
 * validated at the boundary instead of being trusted: an unknown value degrades
 * to `auto`, which self-detects, rather than to a pinned transport nobody asked for.
 * @param value - the configured value.
 * @returns a valid preference.
 */
function asApiPreference(value: string | undefined): "auto" | "json2" | "jsonrpc" {
	return value === "json2" || value === "jsonrpc" ? value : "auto";
}

function clientFor(projectRoot: string, api?: "auto" | "json2" | "jsonrpc"): {
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
		client: new OdooClient(creds, { api: api ?? "auto" }),
		report:
			describeCredentials(creds) +
			(loaded.permissionNote === undefined ? "" : ` — NOTE: ${loaded.permissionNote}`) +
			(loaded.credentialNote === undefined ? "" : ` — WARNING: ${loaded.credentialNote}`),
		credentials: creds,
	};
}

/** JSON-value projection of a module row (matches the output schema). */
function moduleRecord(m: { id: number; name: string; state: string; latest_version: string | null }): Record<string, string | number | null> {
	return { id: m.id, name: m.name, state: m.state, latest_version: m.latest_version };
}

/**
 * One line naming the project root every tool call acted on and WHERE that
 * root came from. Reported on every tool result so "which project am I in?" is
 * never inferred: with several folders open, a silent wrong root is the most
 * expensive failure mode this plugin can have.
 * @param root - the resolved root plus its provenance.
 * @returns the human-readable note.
 */
function rootNote(root: ResolvedRoot): string {
	const why =
		root.source === "session"
			? `session cwd${root.sessionId === undefined ? "" : ` (${root.sessionId})`}`
			: root.source === "argument"
				? "explicit argument"
				: root.source === "config"
					? "configured fallback — no session cwd available"
					: "process cwd — LAST RESORT, no session cwd and no configured root";
	return `Project root: ${displayPath(root.root)} [${why}]`;
}

/** Effective onboarding status combining the decision marker with credential resolution. */
function setupStatusFor(projectRoot: string): { status: EffectiveSetupStatus; detail: string } {
	const loaded = loadCredentials(projectRoot);
	if (loaded.ok) {
		// Which instance is in play is part of the answer: with several targets
		// configured, "credentials OK" without naming the target is ambiguous.
		const others = listInstances(projectRoot).filter((entry) => entry.name !== loaded.credentials.instance);
		return {
			status: "configured",
			detail:
				`Credentials OK (${loaded.credentials.source}): ${describeCredentials(loaded.credentials)}` +
				(others.length === 0
					? ""
					: ` — this project also has: ${others.map((entry) => entry.name).join(", ")} ` +
						"(mode=instance instance=list to see them, instance=use name=<name> to switch)") +
				(loaded.permissionNote === undefined ? "" : ` — NOTE: ${loaded.permissionNote}`),
		};
	}
	const marker = readSetupState(projectRoot);
	if (loaded.reason === "required_var_missing" && loaded.message.includes("ODOO_PASSWORD")) {
		return {
			status: "needs-secret",
			detail:
				`NEEDS_SECRET: a credential scaffold exists at ${displayPath(loaded.envFile)} ` +
				"but neither ODOO_PASSWORD nor ODOO_API_KEY is filled. Ask the developer to fill ONE " +
				"of them directly in the file (an Odoo API key is recommended: Odoo accepts it wherever " +
				"a password is accepted over RPC). Never through chat, then retry odoo_connect.",
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
 * Skills this plugin bundles and registers at mount time.
 *
 * Each entry is a directory under `skills/` holding a `SKILL.md` with
 * frontmatter, plus the resource base its relative references resolve against.
 *
 * BOTH skills point at the shared `resources/` folder, and that is deliberate:
 * the host tells the model "resolve relative paths mentioned by this skill
 * against the base directory", so a reference only works if it resolves FROM
 * THAT BASE. The role files used to live at `agents/` while the technical skill
 * declared `agents` as its base, which made every `agents/*.md` reference
 * resolve to `agents/agents/*.md` — the paths happened to work only because the
 * process cwd was the repository root. One base, one shape of reference.
 */
const ODOO_SDD_SKILLS: Array<{ dir: string; resourceBase: string; fallbackDescription: string }> = [
	{
		dir: ODOO_SDD_SKILL_NAME,
		resourceBase: "resources",
		fallbackDescription:
			"Spec-Driven Development pipeline for Odoo modules on top of the dsh-odoo-sdd plugin.",
	},
	{
		dir: "odoo-functional-sdd",
		resourceBase: "resources",
		fallbackDescription:
			"Functional Odoo work on a running instance: discover what the version and the installed " +
			"modules actually provide, configure and import in human-approved batches, and close with an " +
			"operational runbook a person can repeat.",
	},
];

/**
 * Read one bundled skill and split its frontmatter from its instructions.
 * @param dir - skill directory under `skills/`.
 * @returns the parsed definition, or null when the file cannot be read.
 */
function readBundledSkill(dir: string): {
	name: string;
	description: string;
	whenToUse?: string;
	content: string;
	path: string;
} | null {
	const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", dir, "SKILL.md");
	let raw: string;
	try {
		raw = readFileSync(skillPath, "utf8");
	} catch {
		return null;
	}
	// Strip the `---` frontmatter from the body and lift its single-line keys
	// into the registry summary, so the model sees a clean description and the
	// body is pure instructions.
	const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	let name = dir;
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
	return { name, description, ...(whenToUse === undefined ? {} : { whenToUse }), content, path: skillPath };
}

/**
 * Register the bundled skills as runtime skills so DSH advertises them in the
 * model-facing catalog (modelInvocable) and the user-facing catalog
 * (userInvocable) on every new session. This is what makes the protocols
 * discoverable automatically after a user installs the plugin, instead of
 * requiring them to reach into `skills/<dir>/SKILL.md` by hand.
 *
 * Fail-open by design: a missing or unreadable skill must never break the
 * plugin mount — the file stays available in the repository either way.
 */
function registerOdooSddSkills(ctx: unknown): void {
	try {
		const api = (ctx as { skills?: SkillApi }).skills;
		if (!api || typeof api.register !== "function") return; // fail-open: no skills host
		const pkgRoot = dirname(fileURLToPath(import.meta.url)); // .../lib
		for (const entry of ODOO_SDD_SKILLS) {
			const skill = readBundledSkill(entry.dir);
			if (skill === null) continue;
			api.register({
				name: skill.name,
				description: skill.description || entry.fallbackDescription,
				...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
				content: skill.content,
				invocation: { modelInvocable: true, userInvocable: true },
				// `source` is part of the host SkillRegistration contract (the
				// registry re-validates it when the definition is loaded); omitting
				// it can make the registry reject the skill even though apply ran.
				source: "runtime",
				// Resolve relative resources from the installed package location,
				// not from cwd.
				resourceBase: { kind: "directory", path: join(pkgRoot, "..", entry.resourceBase) },
				path: skill.path,
			});
		}
	} catch {
		// A skills host that throws must not take the tool surface down with it.
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
	// A skill registry is optional on some hosts; register the bundled skills
	// (development workflow + functional workflow) when present so both are
	// advertised to the model on every new session.
	registerOdooSddSkills(ctx);
	// S2: sanitizer for any agent-supplied text the pipeline persists.
	// It takes the call's execution context because it resolves CREDENTIALS: with
	// the fallback root, a session working in project A would scrub the text with
	// project B's secret — the redaction would look like it ran and leak anyway.
	const sanitize = (textValue: string, exec?: unknown): string => {
		const loaded = loadCredentials(effectiveConfig(exec).projectRoot);
		const credentials: OdooCredentials | null = loaded.ok ? loaded.credentials : null;
		return sanitizeForPersist(textValue, credentials);
	};

	// Settings section. Two host contracts, one namespace ("odoo-sdd"):
	//
	//   - OLD (dsh <= 0.1.7): the plugin PUSHED its Config schema into the host
	//     with `settings.installSection(...)` and got a live thunk back.
	//   - NEW (dsh >= 0.2.0): that API was REMOVED, and the host now DERIVES the
	//     form from the plugin's own `Config` schema (dsh-settings reads
	//     `configEditor.configuration()` and keeps one form per profile entry,
	//     keyed by the entry id — our bundle patch declares `id: odoo-sdd`).
	//
	// There is nothing to REGISTER on the new host: the exported schema IS the
	// form, and the resolved values arrive as this plugin's `config` argument.
	// The old branch stays only so an instance running on an older host keeps
	// feeding live edits into `effectiveConfig()`.
	const ODOO_SDD_NAMESPACE = "odoo-sdd";
	interface SddsSettingsHooks {
		setSource(current: () => unknown): void;
		onChange(): void;
	}
	type SddsSettingsProvider = {
		settings: Partial<{
			installSection(owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: SddsSettingsHooks): void;
		}>;
	};
	const sddsDefaultConfig = {
		// Kept in the schema for headless/CI hosts, but NOT offered as an
		// editable field: the project root is resolved per session (the folder
		// the developer opened), so a plugin-wide value would be wrong for every
		// project but one.
		projectRoot: config.projectRoot ?? "",
		specsMode: config.specsMode ?? "project",
		specsRoot: config.specsRoot ?? "",
		specsDir: config.specsDir ?? "specs",
		executeAllowlist: config.executeAllowlist ?? [],
		methodAllowlist: config.methodAllowlist ?? [],
		communityRepoUrl: config.communityRepoUrl ?? "https://github.com/odoo/odoo",
		communityRepoPath: config.communityRepoPath ?? "",
		enterpriseRepoUrl: config.enterpriseRepoUrl ?? "https://github.com/odoo/enterprise",
		enterpriseRepoPath: config.enterpriseRepoPath ?? "",
		autonomy: config.autonomy ?? "supervised",
		requireCheckpointBeforeMutation: config.requireCheckpointBeforeMutation ?? true,
		requireSpecForChanges: config.requireSpecForChanges ?? true,
		adoptProjectPointerHint: config.adoptProjectPointerHint ?? true,
		odooApi: config.odooApi ?? "auto",
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
		// `Partial<>` plus this check: on the new host the service EXISTS but
		// carries a different surface, and calling a method that is not there
		// would throw during mount for a feature the host no longer needs.
		if (typeof settingsCtx.settings?.installSection !== "function") return;
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
					projectRoot: { type: "string" },
					rootSource: { type: "string" },
					activeInstance: { type: "string" },
					instances: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								url: { type: "string" },
								db: { type: "string" },
								username: { type: "string" },
								environment: { type: "string" },
								active: { type: "boolean" },
								authorized: { type: "boolean" },
								legacy: { type: "boolean" },
								secure: { type: "boolean" },
								readable: { type: "boolean" },
							},
						},
					},
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(_args: unknown, exec?: unknown) {
			const root = rootFor(exec);
			const projectRoot = root.root;
			const where = { projectRoot, rootSource: root.source as string };
			const { client, report, credentials } = clientFor(projectRoot, asApiPreference(effectiveConfig(exec).odooApi));
			if (client === null) {
				// Two different situations share a null client:
				//  - credentials loaded but no live human grant => NOT AUTHORIZED
				//    (report says exactly that);
				//  - no usable credentials => surface the onboarding state
				//    (NEEDS_SECRET / DEFERRED / SKIPPED / needs-setup).
				if (credentials !== null) {
					return { connected: false, target: "", detail: `${report}\n${rootNote(root)}`, ...where };
				}
				return {
					connected: false,
					target: "",
					detail: `${setupStatusFor(projectRoot).detail}\n${rootNote(root)}`,
					...where,
				};
			}
			const version = await client.version();
			if (!version.ok) {
				return {
					connected: false,
					target: client.target,
					detail: `Instance unreachable: ${version.error}\n${rootNote(root)}`,
					...where,
				};
			}
			const auth = await client.authenticate();
			if (!auth.ok) {
				return {
					connected: false,
					target: client.target,
					serverVersion: version.value.server_version,
					detail: `Version OK (${version.value.server_version}) but authentication failed: ${auth.error}\n${rootNote(root)}`,
					...where,
				};
			}
			// Prove the transport this session will actually use. `auto` decides from
			// the version plus a live attempt, so a key that works over JSON-RPC but
			// not over JSON-2 (or a route a proxy swallows) surfaces HERE, where the
			// developer is looking, instead of in the middle of a batch.
			let apiNote = "";
			const transport = client.transport;
			if (transport.api === "json2") {
				const probe = await client.executeKw<unknown>("res.users", "search_count", [[]], { limit: 1 });
				apiNote = probe.ok
					? ` Transport: JSON-2 (POST /json/2, Bearer API key) — verified with a live call.`
					: ` Transport: JSON-2 was reported available but a live call FAILED (${probe.error.slice(0, 200)}); ` +
						"the classic transport still works. Check that the API key is valid and not expired.";
			} else {
				apiNote = ` Transport: classic JSON-RPC (execute_kw) — ${transport.reason}.`;
			}
			const kindNote =
				credentials?.secretKind === "api_key"
					? " Credential: an API key (odoo_session/odoo_import need the account PASSWORD: Odoo skips the API-key check for interactive logins)."
					: "";
			return {
				connected: true,
				target: report,
				serverVersion: version.value.server_version,
				uid: auth.value.uid,
				detail:
					`Connected to ${version.value.server_version} as uid=${auth.value.uid}. Target: ${report}` +
					`${apiNote}${kindNote}\n${rootNote(root)}`,
				...where,
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
			"stored grants. mode=instance manages SEVERAL targets per project (list | show | use | add | " +
			"remove): each lives in its own .sdd/instances/<name>.env, one is active, and use requires a " +
			"live grant for that target. mode=later defers setup until the VERIFY phase; mode=skip marks the project " +
			"to run without an instance (manual verification); mode=reset clears the persisted decision. " +
			"mode=purge reports (and, with confirm_destructive=true plus human approval, removes) only the " +
			"plugin's own state under .sdd/ — credentials, stop.md and specs/ are always preserved.",
		parameters: {
			mode: {
				type: "string",
				required: true,
				enum: ["check", "interactive", "later", "skip", "reset", "autonomy", "authorize", "revoke", "purge", "instance"],
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
			instance: {
				type: "string",
				enum: ["list", "show", "use", "add", "remove"],
				description:
					"mode=instance only: list the project's Odoo instances | show the active one | " +
					"use <name> to activate one (requires a live grant for that target) | " +
					"add <name> to scaffold a new .env (non-secret fields) | remove <name> to delete it.",
			},
			name: {
				type: "string",
				description:
					"mode=instance only: instance name ([A-Za-z0-9][A-Za-z0-9._-]*, max 64). Its file is " +
					".sdd/instances/<name>.env. Required for use/add/remove and optional for show.",
			},
			confirm_destructive: {
				type: "boolean",
				description: "REQUIRED true to actually run mode=purge or mode=instance instance=remove. Without it, they only report their plan.",
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
					permissionsEnforced: { type: "boolean" },
					projectRoot: { type: "string" },
					rootSource: { type: "string" },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text((value as { detail: string }).detail)],
		},
		async execute(args: {
			mode: "check" | "interactive" | "later" | "skip" | "reset" | "autonomy" | "authorize" | "revoke" | "purge" | "instance";
			url?: string;
			db?: string;
			username?: string;
			scope?: "user" | "project";
			instance?: "list" | "show" | "use" | "add" | "remove";
			name?: string;
			decision?: "supervised" | "autonomous";
			confirm_destructive?: boolean;
		}, exec?: unknown) {
			const root = rootFor(exec);
			const projectRoot = root.root;
			const autonomyMode = readAutonomy(projectRoot);
			appendAuditLine(projectRoot, "odoo_setup/" + args.mode, args, clientFor(projectRoot).credentials);

			// ---- mode=instance: several targets in one project ---------------
			// Each target is its own file and its own connection grant, so a local
			// CE, a staging EE and a client's server can coexist without anyone
			// overwriting a credential file to switch.
			if (args.mode === "instance") {
				const operation = args.instance ?? "list";
				const named = (args.name ?? "").trim();
				const activeNow = readActiveInstance(projectRoot);
				const describe = (): Array<Record<string, unknown>> =>
					listInstances(projectRoot).map((entry) => ({
						name: entry.name,
						...(entry.url === null ? {} : { url: entry.url }),
						...(entry.db === null ? {} : { db: entry.db }),
						...(entry.username === null ? {} : { username: entry.username }),
						...(entry.environment === null ? {} : { environment: entry.environment }),
						active: entry.name === activeNow,
						// Authorization is per TARGET: two instances on the same server
						// are two different grants.
						authorized:
							entry.url !== null && entry.db !== null && entry.username !== null
								? hasValidGrant(projectRoot, "connection", fingerprintOf(entry.url, entry.db, entry.username))
								: false,
						legacy: entry.legacy,
						secure: entry.secure,
						readable: entry.readable,
					}));
				const action = args.name !== undefined ? ` ${named}` : "";
				appendAuditLine(projectRoot, `odoo_setup/instance-${operation}`, { name: named }, clientFor(projectRoot).credentials);

				if (operation === "list") {
					const found = listInstances(projectRoot);
					const ambiguous = ambiguousInstances(projectRoot);
					const lines = found.length === 0
						? ["No instance is configured in this project."]
						: found.map((entry) => {
							const flag = entry.name === activeNow ? " (ACTIVE)" : "";
							const where = entry.url === null ? "unreadable" : `${entry.url} db=${entry.db ?? "?"} user=${entry.username ?? "?"}`;
							const notes = [
								entry.legacy ? "legacy single file: `use` it or add a named instance and remove it" : "",
								entry.secure ? "" : "permissions too open (chmod 600)",
								entry.readable ? "" : "could not be parsed",
							].filter(Boolean);
							return `- ${entry.name}${flag}: ${where}${notes.length === 0 ? "" : ` — ${notes.join("; ")}`}`;
						});
					return {
						mode: "instance" as string,
						status: ambiguous.length > 0 ? "needs-instance" : "ok",
						activeInstance: activeNow ?? undefined,
						instances: describe(),
						detail:
							`Instances of ${projectRoot} (${found.length}):\n${lines.join("\n")}` +
							(ambiguous.length > 0
								? `\nSeveral instances and none active (${ambiguous.join(", ")}): every connection tool refuses ` +
									"until one is chosen with mode=instance instance=use name=<name>. Nothing is picked by order."
								: "") +
							(activeNow === null ? "" : `\nActive: ${activeNow}`),
					};
				}

				if (operation === "show") {
					const wanted = named === "" ? activeNow : named;
					if (wanted === null) {
						return {
							mode: "instance" as string,
							status: "needs-instance",
							instances: describe(),
							detail:
								"No instance is active" +
								(args.name === undefined ? "." : ` and "${named}" was not given as an existing name.`) +
								" Use mode=instance instance=list to see them, then instance=use name=<name>.",
						};
					}
					const entry = listInstances(projectRoot).find((candidate) => candidate.name === wanted);
					if (entry === undefined) {
						return {
							mode: "instance" as string,
							status: "unknown-instance",
							activeInstance: activeNow ?? undefined,
							instances: describe(),
							detail: `No instance named "${wanted}" in this project. Run mode=instance instance=list.`,
						};
					}
					return {
						mode: "instance" as string,
						status: "ok",
						activeInstance: activeNow ?? undefined,
						envFile: displayPath(entry.path),
						instances: describe(),
						detail:
							`Instance ${entry.name}${entry.name === activeNow ? " (ACTIVE)" : ""}: ` +
							`${entry.url ?? "unreadable"} db=${entry.db ?? "?"} user=${entry.username ?? "?"} ` +
							`environment=${entry.environment ?? "UNDECLARED"} ` +
							`(file: ${displayPath(entry.path)}${entry.legacy ? ", legacy location" : ""}). ` +
							"The secret is never read here: only the file that holds it is named.",
					};
				}

				if (operation === "use") {
					if (named === "") {
						return {
							mode: "instance" as string,
							status: "needs-instance",
							instances: describe(),
							detail: "instance=use requires name=<instance>.",
						};
					}
					if (instanceEnvPath(projectRoot, named) === null) {
						return {
							mode: "instance" as string,
							status: "invalid-name",
							detail:
								`"${named}" is not a usable instance name: letters, digits, dot, dash and underscore only, ` +
								"up to 64 characters, and no path separators (the name becomes a file name).",
						};
					}
					const entry = listInstances(projectRoot).find((candidate) => candidate.name === named);
					if (entry === undefined) {
						return {
							mode: "instance" as string,
							status: "unknown-instance",
							activeInstance: activeNow ?? undefined,
							instances: describe(),
							detail: `No instance named "${named}" in this project, so there is nothing to activate.`,
						};
					}
					// Activating decides WHERE mutations go, so it needs the same
					// authorization the connection itself needs: switching the pointer to
					// an unauthorized target would only move the failure one step later.
					const authorized =
						entry.url !== null && entry.db !== null && entry.username !== null
							? hasValidGrant(projectRoot, "connection", fingerprintOf(entry.url, entry.db, entry.username))
							: false;
					if (!authorized) {
						return {
							mode: "instance" as string,
							status: "not-authorized",
							activeInstance: activeNow ?? undefined,
							instances: describe(),
							detail:
								`Instance ${named} has no live connection grant, so it was NOT activated` +
								(entry.url === null ? " (and its file could not be read)." : ` (${entry.url} db=${entry.db}, user=${entry.username}).`) +
								" Each target is authorized on its own: activate it after the developer approves it " +
								"(complete its .env, then mode=authorize).",
						};
					}
					if (entry.legacy) {
						return {
							mode: "instance" as string,
							status: "legacy-target",
							envFile: displayPath(entry.path),
							activeInstance: activeNow ?? undefined,
							instances: describe(),
							detail:
								`"${named}" is the legacy <project>/.sdd/.env, which the cascade already uses when no ` +
								"named instance is active. To keep several targets, create a named one " +
								"(mode=instance instance=add name=<name>) and remove the legacy file yourself once the " +
								"new one is authorized — the plugin will not move a credential file on its own.",
						};
					}
					if (!writeActiveInstance(projectRoot, named)) {
						return {
							mode: "instance" as string,
							status: "error",
							detail: `Could not record "${named}" as the active instance: the pointer under .sdd/instances/ is not writable.`,
						};
					}
					return {
						mode: "instance" as string,
						status: "ok",
						activeInstance: named,
						envFile: displayPath(entry.path),
						instances: describe(),
						detail:
							`Active instance: ${named} (${entry.url ?? "unreadable"} db=${entry.db ?? "?"}). ` +
							"Every connection tool now uses it; the other instances stay configured and untouched.",
					};
				}

				if (operation === "add") {
					if (named === "") {
						return {
							mode: "instance" as string,
							status: "needs-instance",
							detail: "instance=add requires name=<instance> (for example: local, staging, client-acme).",
						};
					}
					const target = instanceEnvPath(projectRoot, named);
					if (target === null) {
						return {
							mode: "instance" as string,
							status: "invalid-name",
							detail:
								`"${named}" is not a usable instance name: letters, digits, dot, dash and underscore only, ` +
								"up to 64 characters, and no path separators (the name becomes a file name).",
						};
					}
					if (existsSync(target)) {
						return {
							mode: "instance" as string,
							status: "exists",
							envFile: displayPath(target),
							detail:
								`${displayPath(target)} already exists — refusing to overwrite a credential file. ` +
								"Edit it by hand, or pick another name.",
						};
					}
					// The scaffold carries the NON-SECRET fields only; the secret is filled
					// by hand, exactly like mode=interactive.
					mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
					writeFileSync(
						target,
						[
							`# dsh-odoo-sdd credentials — instance "${named}", written by odoo_setup (mode=instance).`,
							"# Fill the secret by hand: ODOO_PASSWORD=<account password>",
							"# or ODOO_API_KEY=<api key> — the API key is recommended, and Odoo accepts it",
							"# wherever a password is accepted over RPC (Settings > Users > API Keys).",
							"# NEVER commit this file; it must stay chmod 600.",
							`ODOO_URL=${args.url?.trim() ?? "http://localhost:8069"}`,
							`ODOO_DB=${args.db?.trim() ?? "dev_sdd"}`,
							`ODOO_USERNAME=${args.username?.trim() ?? "admin"}`,
							"ODOO_PASSWORD=",
							"# ODOO_SDD_ENVIRONMENT=dev",
							"",
						].join("\n"),
						{ mode: 0o600 },
					);
					const permission = ensureSecurePermissions(target);
					writeSetupState(projectRoot, {
						status: "needs-secret",
						decidedAt: new Date().toISOString(),
						scope: "project",
						envFile: target,
					});
					return {
						mode: "instance" as string,
						status: "needs-secret",
						envFile: displayPath(target),
						activeInstance: activeNow ?? undefined,
						permissionsEnforced: permission.enforced,
						instances: describe(),
						detail:
							`Scaffold written at ${displayPath(target)} for instance "${named}" ` +
							`(url/db/user ${args.url === undefined ? "are placeholders" : "as given"}). Fill ODOO_PASSWORD ` +
							"by hand, then run mode=authorize to authorize THIS target, and mode=instance instance=use " +
							`name=${named} to activate it.` +
							(permission.note === undefined ? "" : `\nWARNING: ${permission.note}`),
					};
				}

				// remove
				if (named === "") {
					return {
						mode: "instance" as string,
						status: "needs-instance",
						instances: describe(),
						detail: "instance=remove requires name=<instance> (and confirm_destructive=true to actually delete it).",
					};
				}
				const target = instanceEnvPath(projectRoot, named);
				if (target === null) {
					return {
						mode: "instance" as string,
						status: "invalid-name",
						detail: `"${named}" is not a usable instance name, so no file can be resolved for it.`,
					};
				}
				const entry = listInstances(projectRoot).find((candidate) => candidate.name === named);
				if (entry === undefined) {
					return {
						mode: "instance" as string,
						status: "unknown-instance",
						instances: describe(),
						detail: `No instance named "${named}" in this project.`,
					};
				}
				if (entry.legacy) {
					return {
						mode: "instance" as string,
						status: "legacy-target",
						envFile: displayPath(entry.path),
						detail:
							`"${named}" is the legacy <project>/.sdd/.env and this tool will not delete it: it is the ` +
							"only target you have until a named instance is authorized. Remove the file yourself when you " +
							"are sure.",
					};
				}
				if (args.confirm_destructive !== true) {
					return {
						mode: "instance" as string,
						status: "needs-confirmation",
						envFile: displayPath(entry.path),
						instances: describe(),
						detail:
							`This would delete ${displayPath(entry.path)} (instance "${named}"). Pass ` +
							"confirm_destructive=true to delete it. The stored connection grant for that target is not " +
							"touched: revoke it with mode=revoke if you also want access withdrawn.",
					};
				}
				if (!removeInstance(projectRoot, named)) {
					return {
						mode: "instance" as string,
						status: "error",
						detail: `Could not delete ${displayPath(entry.path)}.`,
					};
				}
				return {
					mode: "instance" as string,
					status: "removed",
					activeInstance: readActiveInstance(projectRoot) ?? undefined,
					instances: describe(),
					detail:
						`Instance "${named}" removed (${displayPath(entry.path)}).` +
						(readActiveInstance(projectRoot) === null && named === activeNow
							? " It was the active one, so nothing is active now: the connection tools will refuse until you choose another."
							: ""),
				};
			}

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
						(result.kept.length > 0
							? `. KEPT because it is evidence of a run that is not finished: ${result.kept.join(", ")} ` +
								"(reconcile or finish it, then purge again)"
							: "") +
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
					projectRoot,
					rootSource: root.source as string,
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
						"(non-secret fields only — neither the password nor the API key is ever " +
						"accepted here: they belong in the file, filled by hand).",
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
				"# Fill the secret by hand: ODOO_PASSWORD=<account password>",
				"# or ODOO_API_KEY=<api key> — the API key is recommended, and Odoo accepts it",
				"# wherever a password is accepted over RPC (Settings > Users > API Keys).",
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
			// Honest reporting: a chmod that "succeeds" is not proof of effect
			// (Windows / FAT / bind mounts cannot express POSIX mode bits).
			const permission = ensureSecurePermissions(target);
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
			const permissionNote =
				permission.note === undefined ? "" : `\nWARNING: ${permission.note}`;
			return {
				mode: "interactive" as string,
				status: "needs-secret",
				envFile: displayPath(target),
				gitignoreCovered: coverage.covered,
				permissionsEnforced: permission.enforced,
				projectRoot,
				rootSource: root.source as string,
				detail:
					`Scaffold written at ${displayPath(target)} ` +
					(permission.enforced
						? "(owner-only mode verified). "
						: "(owner-only mode requested). ") +
					"Ask the developer to " +
					"fill ODOO_PASSWORD directly in that file — never through chat. Then run " +
					`odoo_connect to validate.${permissionNote}${gitignoreNote}\n${rootNote(root)}`,
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
		async execute(args: { operation: "info" | "install" | "upgrade"; modules: string[] }, exec?: unknown) {
			const { client, report } = clientFor(rootFor(exec).root, asApiPreference(effectiveConfig(exec).odooApi));
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
		async execute(args: { limit?: number; sinceMinutes?: number }, exec?: unknown) {
			const { client, report } = clientFor(rootFor(exec).root);
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
		async execute(_args: unknown, exec?: unknown) {
			const projectRoot = rootFor(exec).root;
			const { client, report } = clientFor(projectRoot, asApiPreference(effectiveConfig(exec).odooApi));
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
			"(record a passed verification with honest verdict; refused unless every AC row in " +
			"test-plan.md reads an explicit `pass`), rollback (restore the active checkpoint), diagnose " +
			"(record the root-cause analysis the ladder demands). stop.md in the spec dir halts everything.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["init", "clarify", "status", "mark_spec_loaded", "advance", "fail", "succeed", "rollback", "diagnose", "waive"],
				description: "State-machine operation to perform.",
			},
			spec_id: {
				type: "string",
				required: true,
				description: "Spec directory id, e.g. '001-sale-order-approval'.",
			},
			mode: {
				type: "string",
				enum: [...PIPELINE_MODES],
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
				description: "Note/verdict/error summary recorded in the KB graph. Required for operation=waive: it carries what the developer said.",
			},
			revoke: {
				type: "boolean",
				description: "operation=waive only: drop the recorded waiver (tightening the policy needs no approval).",
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
			operation: "init" | "clarify" | "status" | "mark_spec_loaded" | "advance" | "fail" | "succeed" | "rollback" | "diagnose" | "waive";
			spec_id: string;
			mode?: PipelineMode;
			licensed?: "community" | "enterprise";
			next_phase?: Phase;
			approval_marker?: string;
			approval_source?: "human" | "human-proxy";
			checkpoint_id?: string;
			detail?: string;
			revoke?: boolean;
		}, exec?: unknown) {
			// The root comes from the CALLING SESSION: two open projects must
			// never read or write each other's spec state.
			const root = rootFor(exec);
			const cfgPhase = effectiveConfig(exec);
			const layout = { specsMode: cfgPhase.specsMode, specsRoot: cfgPhase.specsRoot };
			const projectRoot = root.root;
			// `create` only for the operation that actually creates the spec dir,
			// so a read-only status/rollback never claims a central folder.
			const specDir = specDirOf(projectRoot, cfgPhase.specsDir, args.spec_id, layout, {
				create: args.operation === "init",
			});
			// S2: agent-supplied details are scrubbed (known secret, generic
			// credential shapes, home paths) BEFORE any KB/verdict persistence.
			const note = sanitize(args.detail ?? "", exec);
			const projectRootForAudit = projectRoot;
			appendAuditLine(projectRootForAudit, "sdd_phase/" + args.operation, args, clientFor(projectRootForAudit).credentials);
			if (args.operation === "init") {
				// The mode decides the template set, the phase graph and the content
				// gates, so it is chosen HERE and frozen by recordIntent().
				const requested: PipelineMode | null =
					args.mode === undefined ? null : isPipelineMode(args.mode) ? args.mode : null;
				if (args.mode !== undefined && requested === null) {
					return {
						operation: "init" as string, phase: loadState(specDir).phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(loadState(specDir)),
						detail: `Unsupported mode "${String(args.mode)}" — expected one of: ${PIPELINE_MODES.join(", ")}.`,
					};
				}
				initSpecDir(specDir, requested);
				const state = loadState(specDir);
				if (requested !== null && state.mode !== null && state.mode !== requested) {
					return {
						operation: "init" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(state),
						detail:
							`This spec already runs as "${state.mode}" and init cannot change it to ` +
							`"${requested}": the mode decides the phase graph and the gates. Create a new spec id.`,
					};
				}
				if (requested !== null) state.mode = requested;
				saveState(state);
				writeActiveStateFor(projectRoot, sessionIdOf(exec), { specId: args.spec_id, phase: state.phase });
				return {
					operation: "init" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail:
						`Spec directory initialized at ${displayPath(specDir)} (spec.md, architecture.md, test-plan.md, state.json) ` +
						`for mode=${state.mode ?? "to be decided in CLARIFY"}. ` +
						`Fill spec.md, then mark_spec_loaded.\nSpecs location: ${describeSpecsLocation({ projectRoot, specsMode: cfgPhase.specsMode, specsDir: cfgPhase.specsDir, specsRoot: cfgPhase.specsRoot })}\n${rootNote(root)}`,
				};
			}
			if (args.operation === "rollback") {
				const active = activeFor(cfgPhase, exec).state;
				const checkpointId = args.checkpoint_id ?? active.checkpointId ?? null;
				if (checkpointId === null) {
					return {
						operation: "rollback" as string, phase: loadState(specDir).phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(loadState(specDir)),
						detail: "No checkpoint to roll back to. Create one with sdd_checkpoint operation=create.",
					};
				}
				// A checkpoint belongs to the spec that took it. Rolling this spec back
				// to another spec's snapshot restores that spec's files under this
				// spec's name — silently, and with the wrong provenance in the audit.
				const meta = listCheckpoints(projectRoot).find((c) => c.id === checkpointId) ?? null;
				if (meta === null) {
					return {
						operation: "rollback" as string, phase: loadState(specDir).phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(loadState(specDir)),
						detail:
							`Checkpoint "${checkpointId}" does not exist under .sdd/checkpoints. List them with ` +
							"sdd_checkpoint operation=list and roll back to one of those.",
					};
				}
				if (meta.specId !== null && meta.specId !== undefined && meta.specId !== args.spec_id) {
					return {
						operation: "rollback" as string, phase: loadState(specDir).phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(loadState(specDir)),
						detail:
							`Checkpoint "${checkpointId}" belongs to spec ${meta.specId}, not to ${args.spec_id}: ` +
							"rolling this spec back to it would restore another spec's files. Create a checkpoint of this spec.",
					};
				}
				const restored = restoreCheckpointFiles(projectRoot, checkpointId);
				const st = loadState(specDir);
				// Re-enter the phase this MODE works in. Forcing WRITE_CODE told a
				// functional spec to write code — a phase its own graph does not even
				// connect to APPLY_CONFIG — and the guard then read a phase the run
				// could not legitimately be in.
				st.phase = st.mode === "functional" ? "APPLY_CONFIG" : "WRITE_CODE";
				kbAppend(st, "blocker", `Rollback to ${checkpointId}: restored ${restored.restored.length} file(s). ${note}`.trim());
				saveState(st);
				writeActiveStateFor(projectRoot, sessionIdOf(exec), { specId: args.spec_id, phase: st.phase });
				appendAuditLine(projectRoot, "sdd_phase/rollback", { checkpoint: checkpointId, spec: args.spec_id }, clientFor(projectRoot).credentials, {
					phase: st.phase, specId: args.spec_id, reason: note,
				});
				return {
					operation: "rollback" as string, phase: st.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(st),
					detail:
						`Rolled back to ${checkpointId} (spec ${meta.specId ?? "unknown"}): ${restored.restored.length} file(s) restored` +
						(restored.missing.length > 0 ? `, ${restored.missing.length} failed` : "") +
						`. Phase is now ${st.phase} — re-apply the change and verify again. ` +
						"NOTE: a module install/upgrade is not reverted at the database level.",
				};
			}
			if (args.operation === "clarify") {
				const stateC = loadState(specDir);
				if (args.mode === undefined || args.licensed === undefined) {
					return {
						operation: "clarify" as string, phase: stateC.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(stateC),
						detail:
							`operation=clarify requires BOTH mode (${PIPELINE_MODES.join("|")}) and licensed ` +
							"(enterprise|community) to record the intent.",
					};
				}
				if (!isPipelineMode(args.mode)) {
					return {
						operation: "clarify" as string, phase: stateC.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(stateC),
						detail: `Unsupported mode "${String(args.mode)}" — expected one of: ${PIPELINE_MODES.join(", ")}.`,
					};
				}
				const intent = recordIntent(stateC, args.mode, args.licensed);
				if (!intent.ok) {
					return {
						operation: "clarify" as string, phase: stateC.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(stateC),
						detail: intent.reason ?? "the intent cannot be changed at this point.",
					};
				}
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
			if (args.operation === "waive") {
				// The developer's "leave it to your judgement" for THIS session.
				// It needs their approval: a policy the model can exempt itself
				// from is not a policy.
				if (args.revoke === true) {
					const dropped = clearWaiver(projectRoot);
					return {
						operation: "waive" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
						summary: summarize(state),
						detail: dropped
							? "Waiver revoked: this session is back under the spec policy."
							: "No waiver was recorded for this project.",
					};
				}
				const reason = (args.detail ?? "").trim();
				if (reason === "") {
					return {
						operation: "waive" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(state),
						detail:
							"operation=waive needs `detail` with what the developer said (\"leave it to your judgement\", " +
							"\"no spec for this one\"…). The reason is recorded: it is the only memory of why a change " +
							"happened outside the pipeline.",
					};
				}
				const active = activeFor(cfgPhase, exec).state;
				const sessionId = sessionIdOf(exec);
				if (sessionId === undefined) {
					return {
						operation: "waive" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(state),
						detail:
							"No session id in this call, so a waiver cannot be scoped: it would either apply to nobody or " +
							"to everybody. Run it from an interactive session.",
					};
				}
				const outcome = await requestNativeApproval(
					ctx,
					exec,
					"sdd_phase",
					`Allow THIS session to change the project without a spec.\n` +
						`Reason given by the developer: ${reason}\n` +
						`Scope: this chat only (session ${sessionId}); the next session starts under the policy again. ` +
						`Every change made under it still has to be recorded as a KB decision.`,
				);
				if (outcome !== "allowed-once") {
					return {
						operation: "waive" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
						summary: summarize(state),
						detail: `Waiver not granted (${outcome}). The spec policy stays armed for this session.`,
					};
				}
				writeWaiver(projectRoot, {
					sessionId,
					reason,
					at: new Date().toISOString(),
					...(active.specId === null ? {} : { specId: active.specId }),
				});
				kbAppend(state, "decision", `no spec for this session: ${reason.slice(0, 200)}`);
				return {
					operation: "waive" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail:
						`Waiver recorded for session ${sessionId} (approved by the developer).\n` +
						"Nothing else changes: the change still has to be recorded as a KB decision with how it was " +
						"verified, and this waiver does not survive into the next chat.",
				};
			}
			if (args.operation === "status") {
				const kb = kbRead(specDir);
				const resolved = activeFor(cfgPhase, exec);
				const active = resolved.state;
				const waiver = readWaiver(projectRoot);
				const sameSession = waiver !== null && waiver.sessionId === sessionIdOf(exec);
				writeActiveState(projectRoot, { specId: args.spec_id, phase: state.phase });
				return {
					operation: "status" as string, phase: state.phase as string, ok: true, requireDiagnosis: false,
					summary: summarize(state),
					detail:
						`KB nodes: ${kb.length}. Last: ${kb.length > 0 ? kb[kb.length - 1]!.summary : "none"}` +
						`\nCheckpoint: ${active.checkpointId ?? "none (mutations are blocked while the policy requires one)"}` +
						`\nSpec policy: ${cfgPhase.requireSpecForChanges ? "a spec in a writing phase (or a waiver) is required for every change" : "OFF — changes are not gated by the spec policy"}` +
						(state.phase === "DONE"
							? "\nThis spec is DONE: a new request needs a NEW spec (mode=bug for a small change) or a waiver."
							: "") +
						(waiver === null
							? ""
							: `\nWaiver: granted ${waiver.at} for session ${waiver.sessionId}` +
								`${sameSession ? " (this one)" : " (a different session)"} — reason: ${waiver.reason.slice(0, 120)}`) +
						`\nSpec directory: ${displayPath(specDir)}` +
						`\nSpecs location: ${describeSpecsLocation({ projectRoot, specsMode: cfgPhase.specsMode, specsDir: cfgPhase.specsDir, specsRoot: cfgPhase.specsRoot })}` +
						`\n${rootNote(root)}`,
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
				// A GATED phase is gated on a HUMAN, not on a word the caller writes.
				// `approval_marker`/`approval_source` are arguments of the model, so
				// validating them validated a declaration: the reproduction advanced
				// out of a gated phase with zero native approval requests, even with
				// an approver available that would have refused. The native request is
				// the provenance; the marker stays as the fail-closed backstop for
				// hosts that offer no approval API at all.
				const autonomy = readAutonomy(projectRoot);
				let approvalMarker = args.approval_marker ?? null;
				let approvalSource: "human" | "human-proxy" = args.approval_source ?? "human";
				if (GATED_PHASES.includes(state.phase) && args.next_phase !== "BLOCKED") {
					const asked = await requestNativeApproval(
						ctx,
						exec,
						"sdd_phase",
						`Approve the phase gate: leave ${state.phase} for ${args.next_phase} in spec ${args.spec_id}` +
							`${note.trim() === "" ? "" : ` — ${note.trim().slice(0, 300)}`}`,
					);
					if (asked === "rejected" || asked === "cancelled") {
						return {
							operation: "advance" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
							summary: summarize(state),
							detail:
								`Phase ${state.phase} -> ${args.next_phase} NOT approved (the human answered "${asked}"). ` +
								"The pipeline stays where it is; nothing was advanced by retrying with a different marker.",
						};
					}
					if (asked === "unavailable") {
						// No approval API to ask: the documented fallback is the explicit
						// marker, so a gate still cannot be crossed by doing nothing. It
						// is stated, never silent.
						if (autonomy === "autonomous") {
							approvalSource = approvalSource === "human-proxy" ? "human-proxy" : approvalSource;
						}
						if ((approvalMarker ?? "").trim() !== "APPROVED") {
							return {
								operation: "advance" as string, phase: state.phase as string, ok: false, requireDiagnosis: false,
								summary: summarize(state),
								detail:
									`Phase ${state.phase} is gated and this host offers no approval interface: pass ` +
									"approval_marker='APPROVED' to record the developer's decision explicitly. " +
									"(No native request could be made, so nothing was asked.)",
							};
						}
					} else {
						// The human said yes: the provenance is theirs. In autonomous
						// mode a proxy may answer the gate on their behalf, so it keeps
						// its declared provenance (which `transition()` then validates
						// against the mode) — in supervised mode the answer IS human.
						approvalSource = autonomy === "autonomous" && approvalSource === "human-proxy" ? "human-proxy" : "human";
						approvalMarker = "APPROVED";
					}
				}
				const result = transition(
					state,
					args.next_phase,
					approvalMarker,
					note,
					approvalSource,
					autonomy,
					{
						securityReviewRequired: cfgPhase.securityReviewRequired,
						documentationPolicy: cfgPhase.documentationPolicy ?? "required",
					},
				);
				// The ACTIVE pointer follows the canonical state even when the
				// transition FAILED: reaching BLOCKED is persisted by `transition()`
				// and returned with ok:false, and updating the pointer only on success
				// left the pointer describing a phase the spec had already left — the
				// guard then authorized a mutation from the stale copy.
				writeActiveStateFor(projectRoot, sessionIdOf(exec), { specId: args.spec_id, phase: result.state.phase });
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
	// Two roots can be in play: the DEPLOYMENT root (the plugin's own
	// projectRoot, else the process cwd) and the EFFECTIVE root (what the
	// resolved configuration says, which may come from the file itself or from
	// Settings). The file is looked up through candidates so a project whose
	// config lives next to the workspace is still found when the process runs
	// from somewhere else — and so a config already migrated into the project
	// keeps winning instead of the volatile cwd copy.
	const resolvedRoot: { value: string | null } = { value: null };
	/** projectRoot as declared by the Settings scope, without reading the file. */
	const settingsRoot = (): string => {
		try {
			const value = settingsValues?.()["projectRoot"];
			return typeof value === "string" ? value.trim() : "";
		} catch {
			return "";
		}
	};
	/**
	 * Candidate roots for locating `.sdd/config.json`. The CALLING SESSION's
	 * root comes first — that is the project whose config applies — followed by
	 * the migration/bootstrap candidates (deployment, Settings, a previously
	 * discovered root, process cwd) so a config written before this change is
	 * still found instead of being silently shadowed by a default.
	 */
	const rootCandidates = (activeRoot?: string): string[] => {
		const candidates: string[] = [];
		if (activeRoot !== undefined && activeRoot.trim() !== "") candidates.push(resolve(activeRoot));
		const deploy = (config.projectRoot ?? "").trim();
		// NOTE: `'' ?? x` is `''`, so an empty deployment root must be checked
		// explicitly; otherwise resolve('') silently becomes the process cwd.
		if (deploy !== "") candidates.push(resolve(deploy));
		// Settings may name the root; consulting it here breaks the
		// chicken-and-egg (the file lives under the root the file declares).
		const fromSettings = settingsRoot();
		if (fromSettings !== "") candidates.push(resolve(fromSettings));
		if (resolvedRoot.value !== null) candidates.push(resolvedRoot.value);
		candidates.push(resolve(process.cwd()));
		return [...new Set(candidates)];
	};
	const readConfigAt = (rootPath: string): Record<string, unknown> => {
		const file = join(rootPath, ".sdd", "config.json");
		if (!existsSync(file)) return {};
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	const loadConfigFile = (activeRoot?: string): Record<string, unknown> => {
		for (const candidate of rootCandidates(activeRoot)) {
			const data = readConfigAt(candidate);
			if (Object.keys(data).length === 0) continue;
			const declared = data["projectRoot"];
			// Remember the declared root so later lookups and writes converge on
			// the project instead of the process cwd.
			if (typeof declared === "string" && declared.trim() !== "") resolvedRoot.value = resolve(declared);
			return data;
		}
		return {};
	};
	/** Where configuration is WRITTEN: the root this call acts on. */
	const configFile = (activeRoot?: string): string =>
		join(activeRoot ?? effectiveConfig().projectRoot, ".sdd", "config.json");
	const saveConfigFile = (data: Record<string, unknown>, activeRoot?: string): void => {
		const file = configFile(activeRoot);
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
			"mode=read returns the current values (community/enterprise repository URL + OS path, specs layout, " +
			"executeAllowlist, methodAllowlist) AND the project root this call resolved — with its provenance " +
			"(session cwd, configured fallback or process cwd) and the effective spec directory — so 'which " +
			"project am I in?' is answered, never guessed. mode=set updates them — provide only the fields to " +
			"change. Singleton call for each repository source. Never accepts or returns secrets (those live in " +
			"the .env).",
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
			specsMode: { type: "string", enum: ["project", "central"], description: "'project' keeps specs inside each project; 'central' collects every project's specs under specsRoot." },
			specsRoot: { type: "string", description: "Absolute folder collecting every project's specs when specsMode=central." },
			projectRoot: { type: "string", description: "Fallback project root used only when the calling session has no cwd (headless/CI)." },
			specsDir: { type: "string", description: "Specs folder inside the project when specsMode=project (default 'specs')." },
			executeAllowlist: { type: "array", items: { type: "string" }, description: "Models permitted for odoo_execute mutations." },
			autonomy: { type: "string", enum: ["supervised", "autonomous"], description: "Default delegation mode." },
			licensed: {
				type: "string",
				enum: ["community", "enterprise"],
				description:
					"DEPRECATED and ignored: the Odoo edition is a per-spec decision, answered in CLARIFY " +
					"(sdd_phase operation=clarify licensed=...). A workspace can hold EE and CE projects at once, " +
					"so there is no plugin-wide edition." +
					".",
			},
			requireCheckpointBeforeMutation: { type: "boolean", description: "Refuse mutations until a checkpoint exists (fail-closed)." },
			odooApi: {
				type: "string",
				enum: ["auto", "json2", "jsonrpc"],
				description:
					"Transport for model calls. auto (default) uses Odoo's JSON-2 API " +
					"(POST /json/2, Bearer API key) on servers that offer it and classic JSON-RPC " +
					"elsewhere. json2 pins it and REPORTS a missing route instead of degrading; " +
					"jsonrpc pins the classic transport (works on every version).",
			},
			adoptProjectPointerHint: {
				type: "boolean",
				description:
					"Let a session with no pointer of its own adopt the project's last spec as a hint (only when it is " +
					"fresh and the spec still exists). Default true. Set false for strict per-session scope: a session " +
					"then has no spec until it names one, so two sessions can never authorize against each other's spec.",
			},
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
							specsMode: { type: "string", required: true },
							specsRoot: { type: "string", required: true },
							specsDir: { type: "string", required: true },
							executeAllowlist: { type: "array", required: true, items: { type: "string" } },
							methodAllowlist: { type: "array", items: { type: "string" } },
							autonomy: { type: "string", required: true },
							// Present only when a legacy key still sits in .sdd/config.json: it is
							// REPORTED so it can be deleted, never applied (the edition is per spec).
							licensed: { type: "string", description: "DEPRECATED legacy key, reported only." },
							requireCheckpointBeforeMutation: { type: "boolean", required: true },
							requireSpecForChanges: { type: "boolean" },
							adoptProjectPointerHint: { type: "boolean" },
							odooApi: { type: "string" },
							securityReviewRequired: { type: "boolean", required: true },
							securityInterviewRequired: { type: "boolean", required: true },
							auditAllTools: { type: "boolean", required: true },
					documentationPolicy: { type: "string", required: true },
					documentationLanguage: { type: "string", required: true },
							maxCheckpoints: { type: "number", required: true },
						},
					},
					/**
					 * What THIS call resolved — the answer to "which project am I
					 * in?", including the provenance of the root.
					 */
					resolved: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							projectRoot: { type: "string", required: true },
							rootSource: { type: "string", required: true },
							sessionId: { type: "string" },
							specsBase: { type: "string", required: true },
							specDir: { type: "string", required: true },
							specDirReason: { type: "string", required: true },
							configFile: { type: "string", required: true },
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
			specsMode?: string;
			specsRoot?: string;
			specsDir?: string;
			executeAllowlist?: string[];
			methodAllowlist?: string[];
			autonomy?: string;
			/** Legacy field: accepted and REPORTED, never applied. The edition lives in the spec. */
			licensed?: string;
			requireCheckpointBeforeMutation?: boolean;
			requireSpecForChanges?: boolean;
			adoptProjectPointerHint?: boolean;
			odooApi?: string;
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
				return {
					communityRepoUrl: asString(data["communityRepoUrl"], "https://github.com/odoo/odoo"),
					communityRepoPath: asString(data["communityRepoPath"], ""),
					enterpriseRepoUrl: asString(data["enterpriseRepoUrl"], "https://github.com/odoo/enterprise"),
					enterpriseRepoPath: asString(data["enterpriseRepoPath"], ""),
					projectRoot: asString(data["projectRoot"], ""),
					specsMode: asSpecsMode(data["specsMode"]),
					specsRoot: asString(data["specsRoot"], ""),
					specsDir: asString(data["specsDir"], "specs"),
					executeAllowlist: asList(data["executeAllowlist"]),
					methodAllowlist: asList(data["methodAllowlist"]),
					autonomy: asString(data["autonomy"], "supervised"),
					// Reported, never applied: the edition belongs to a spec, and a workspace
					// can hold EE and CE projects at the same time.
					...(typeof data["licensed"] === "string" ? { licensed: data["licensed"] } : {}),
					requireCheckpointBeforeMutation: typeof data["requireCheckpointBeforeMutation"] === "boolean" ? data["requireCheckpointBeforeMutation"] : true,
					requireSpecForChanges: typeof data["requireSpecForChanges"] === "boolean" ? data["requireSpecForChanges"] : true,
					adoptProjectPointerHint: typeof data["adoptProjectPointerHint"] === "boolean" ? data["adoptProjectPointerHint"] : true,
					odooApi: ((): string => {
						const v = asString(data["odooApi"], "auto");
						return v === "json2" || v === "jsonrpc" ? v : "auto";
					})(),
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

			/**
			 * What this call resolved, reported on EVERY return so the model and
			 * the developer can always tell which project is being configured.
			 */
			const resolution = () => {
				const cfg = effectiveConfig(exec);
				const layout: SpecsLayout = {
					projectRoot: cfg.projectRoot,
					specsMode: cfg.specsMode,
					specsDir: cfg.specsDir,
					specsRoot: cfg.specsRoot,
				};
				const active = activeFor(cfg, exec).state;
				const activeSpec = active.specId === null ? "000-unnamed" : active.specId;
				return {
					projectRoot: cfg.projectRoot,
					rootSource: String(cfg.rootSource),
					...(cfg.sessionId === undefined ? {} : { sessionId: cfg.sessionId }),
					specsBase: specsBaseFor(layout),
					specDir: specDirFor(layout, activeSpec),
					specDirReason:
						`${cfg.specsMode} layout; active spec = ${active.specId ?? "none"}` +
						(active.specId === null ? " (showing where a new spec would go)" : ""),
					configFile: configFile(cfg.projectRoot),
				};
			};
			if (args.mode === "read") {
				const cfgRead = effectiveConfig(exec);
				const stored = normalize(cfgRead as unknown as Record<string, unknown>);
				// A legacy key is REPORTED, not honoured: the Odoo edition is decided per spec in
				// CLARIFY, and a workspace-wide value would silently apply to every project here.
				const legacyNote =
					typeof stored.licensed === "string"
						? "\nNOTE: `licensed` is obsolete and was NOT applied — the edition is a per-spec decision " +
							`(the stored value says "${stored.licensed}"). Remove the key from the config file when convenient.`
						: "";
				return {
					mode: "read" as string,
					ok: true,
					// The EFFECTIVE values, not just the file: a value coming from
					// the deployment patch or Settings is in force too, and a
					// "read" that hid it would misreport the live configuration.
					config: stored,
					resolved: resolution(),
					detail:
						`Stored at ${displayPath(configFile(cfgRead.projectRoot))}.\n` +
						`${rootNote(rootFor(exec))}\n` +
						`Specs location: ${describeSpecsLocation({
							projectRoot: cfgRead.projectRoot,
							specsMode: cfgRead.specsMode,
							specsDir: cfgRead.specsDir,
							specsRoot: cfgRead.specsRoot,
						})}` +
						legacyNote,
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
					config: normalize(loadConfigFile(effectiveConfig(exec).projectRoot)),
					resolved: resolution(),
					detail:
						`Configuration unchanged (approval outcome: ${outcome}). A human must approve ` +
						"policy changes; ask the developer to confirm, then retry.",
				};
			}
			const setRoot = effectiveConfig(exec).projectRoot;
			const current = loadConfigFile(setRoot);
			const updates: Record<string, unknown> = {};
			if (args.communityRepoUrl !== undefined) updates["communityRepoUrl"] = args.communityRepoUrl;
			if (args.communityRepoPath !== undefined) updates["communityRepoPath"] = args.communityRepoPath;
			if (args.enterpriseRepoUrl !== undefined) updates["enterpriseRepoUrl"] = args.enterpriseRepoUrl;
			if (args.enterpriseRepoPath !== undefined) updates["enterpriseRepoPath"] = args.enterpriseRepoPath;
			if (args.projectRoot !== undefined) updates["projectRoot"] = args.projectRoot;
			if (args.specsMode !== undefined) updates["specsMode"] = asSpecsMode(args.specsMode);
			if (args.specsRoot !== undefined) updates["specsRoot"] = args.specsRoot;
			if (args.specsDir !== undefined) updates["specsDir"] = args.specsDir;
			if (args.executeAllowlist !== undefined) updates["executeAllowlist"] = args.executeAllowlist;
			if (args.methodAllowlist !== undefined) updates["methodAllowlist"] = args.methodAllowlist;
			if (args.autonomy !== undefined) updates["autonomy"] = args.autonomy;
			if (args.requireCheckpointBeforeMutation !== undefined) updates["requireCheckpointBeforeMutation"] = args.requireCheckpointBeforeMutation;
			if (args.requireSpecForChanges !== undefined) updates["requireSpecForChanges"] = args.requireSpecForChanges;
			if (args.adoptProjectPointerHint !== undefined) updates["adoptProjectPointerHint"] = args.adoptProjectPointerHint;
			if (args.odooApi !== undefined) updates["odooApi"] = args.odooApi;
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
					resolved: resolution(),
					detail: "mode=set requires at least one field to update.",
				};
			}
			const merged = Object.assign({}, current, updates);
			saveConfigFile(merged, setRoot);
			return {
				mode: "set" as string,
				ok: true,
				config: normalize(merged),
				resolved: resolution(),
				detail: `Updated ${displayPath(configFile(setRoot))}.`,
			};
		},
	}));

	// ---------------------------------------------------------------------
	// Runtime tools: odoo_execute (CRUD/RPC allowlist) + odoo_validate (local)
	// ---------------------------------------------------------------------
	/**
	 * Per-call project root.
	 *
	 * The root changes with every folder the developer opens, so it is NOT a
	 * plugin-wide setting: the authoritative value is the cwd of the calling
	 * session (`exec.agent.id` → `ctx.sessions`, whose header cwd is by
	 * definition the workspace path). Then the configured root, then the process
	 * cwd — and the provenance is always reported so neither the model nor the
	 * developer has to guess.
	 *
	 * `resolveRoot` also accepts an explicit override (highest priority). No
	 * tool exposes it: a caller that wants another project must open that
	 * project's folder, so the model cannot silently redirect a run.
	 */
	const rootFor = (exec?: unknown, explicit?: string): ResolvedRoot => {
		const e = (exec ?? {}) as { agent?: { id?: unknown } };
		// Optional read: a host without a session store still works, it just
		// falls back to the configured root (reported as such).
		const sessions = optionalService(ctx, "sessions");
		const sessionId = e.agent?.id;
		let configured = settingsRoot();
		if (configured === "") configured = config.projectRoot ?? "";
		if (sessionCwdOf(sessions, sessionId) === null) {
			// Bootstrap for hosts/contexts with no session (headless, CI, tests):
			// a root DECLARED in `.sdd/config.json` must still win over the
			// process cwd, which is how a root configured in the UI keeps
			// working. `loadConfigFile()` is what discovers the declared value.
			loadConfigFile();
			if (resolvedRoot.value !== null) configured = resolvedRoot.value;
		}
		return resolveRoot({ ...(explicit === undefined ? {} : { explicit }), sessions, sessionId, configured, cwd: process.cwd() });
	};

	// Effective configuration: the persisted <projectRoot>/.sdd/config.json
	// (written by odoo_config) takes precedence over the deployment config
	// (cordis.patch.yml), which takes precedence over built-in defaults. It is
	// resolved on every call so live edits apply without a restart — and the
	// root is resolved from the CALLING SESSION, so two open projects never
	// read or write each other's state.
	const effectiveConfig = (exec?: unknown, explicitRoot?: string) => {
		const resolved = rootFor(exec, explicitRoot);
		// With a SESSION root the project is known, so only THAT project's
		// `.sdd/config.json` may apply: the candidate scan exists to bootstrap a
		// declared root when no session says which project this is, and using it
		// here would let another folder's config leak into this run.
		const data = resolved.source === "session" ? readConfigAt(resolved.root) : loadConfigFile(resolved.root);
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
			// The RESOLVED root always wins: `projectRoot` in a config file can
			// only ever be a fallback for hosts without a session.
			projectRoot: resolved.root,
			rootSource: resolved.source as RootSource,
			sessionId: resolved.sessionId,
			specsMode: asSpecsMode(merged["specsMode"] ?? config.specsMode),
			specsRoot: asString(merged["specsRoot"], config.specsRoot ?? ""),
			specsDir: asString(merged["specsDir"], config.specsDir ?? "specs"),
			executeAllowlist: Array.isArray(merged["executeAllowlist"]) ? asList(merged["executeAllowlist"]) : (config.executeAllowlist ?? []),
			methodAllowlist: Array.isArray(merged["methodAllowlist"]) ? asList(merged["methodAllowlist"]) : (config.methodAllowlist ?? []),
			communityRepoUrl: asString(merged["communityRepoUrl"], config.communityRepoUrl ?? "https://github.com/odoo/odoo"),
			communityRepoPath: asString(merged["communityRepoPath"], config.communityRepoPath ?? ""),
			enterpriseRepoUrl: asString(merged["enterpriseRepoUrl"], config.enterpriseRepoUrl ?? "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asString(merged["enterpriseRepoPath"], config.enterpriseRepoPath ?? ""),
			autonomy: asString(merged["autonomy"], config.autonomy ?? "supervised"),
			requireCheckpointBeforeMutation: asBool(merged["requireCheckpointBeforeMutation"], config.requireCheckpointBeforeMutation ?? true),
			requireSpecForChanges: asBool(merged["requireSpecForChanges"], config.requireSpecForChanges ?? true),
			adoptProjectPointerHint: asBool(merged["adoptProjectPointerHint"], config.adoptProjectPointerHint ?? true),
			odooApi: ((): string => {
				const v = asString(merged["odooApi"], config.odooApi ?? "auto");
				return v === "json2" || v === "jsonrpc" ? v : "auto";
			})(),
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
	 *
	 * Four honesties this must keep, because a replay is the last line of defence:
	 *   - it runs under the SAME context (company/lang) the mutation ran under, so
	 *     a multi-company instance is not compensated in the wrong company;
	 *   - the pre-image is converted from read shapes to write shapes (relations
	 *     included) using field metadata, and everything it refuses to restore is
	 *     REPORTED instead of silently dropped;
	 *   - each op is marked as compensated and the journal is rewritten after it,
	 *     so a retry never compensates the same op twice;
	 *   - it refuses to touch a destination (db, or url+db+user) other than the
	 *     one the journal was recorded against.
	 * What cannot be undone is reported, never silently swallowed.
	 */
	const undoJournal = async (
		projectRoot: string,
		checkpointId: string,
		api?: "auto" | "json2" | "jsonrpc",
	): Promise<{ undone: string[]; detail: string }> => {
		const ops = readCheckpointJournalFile(projectRoot, checkpointId);
		if (ops.length === 0) return { undone: [], detail: "nothing journaled" };
		const { client, credentials } = clientFor(projectRoot, api);
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
		// Destination identity: the database alone cannot tell two users apart.
		const targets = [...new Set(ops.map((o) => o.target).filter((t): t is string => typeof t === "string"))];
		const currentTarget =
			credentials === null ? undefined : fingerprintOf(credentials.url, credentials.db, credentials.username);
		if (targets.length > 0 && currentTarget !== undefined && !targets.includes(currentTarget)) {
			return {
				undone: [],
				detail:
					"refused: the journal was recorded against a different destination (url+db+user) than the " +
					"current one. Point .env back at the original target (or drop the journal) before undoing " +
					"data: replaying under another user can be refused by ACLs or touch records you never saw.",
			};
		}

		const alreadyDone = ops.filter((o) => o.undoneAt !== undefined).length;
		const pending = ops.filter((o) => o.undoneAt === undefined);
		if (pending.length === 0) {
			writeCheckpointJournal(projectRoot, checkpointId, []);
			return { undone: [], detail: `${alreadyDone} operation(s) were already compensated — journal cleared` };
		}

		// Field metadata per model, fetched once per replay. A failed lookup is
		// NOT fatal: the conversion falls back to the observable shape and says so.
		const meta = new Map<string, Record<string, FieldMeta>>();
		const metaFor = async (model: string): Promise<Record<string, FieldMeta>> => {
			const cached = meta.get(model);
			if (cached !== undefined) return cached;
			const fetched = await fieldMetaFor(client, model);
			meta.set(model, fetched);
			return fetched;
		};

		const undone: string[] = [];
		const failed: string[] = [];
		const notRestored = new Map<string, string>();
		const withContext = (op: DataOp): Record<string, unknown> => (op.context === undefined ? {} : { context: op.context });
		/** Mark one op compensated and persist immediately (a crash must not lose it). */
		const markDone = (op: DataOp): void => {
			op.undoneAt = new Date().toISOString();
			writeCheckpointJournal(projectRoot, checkpointId, ops);
		};

		for (const op of [...pending].reverse()) {
			try {
				const fields = await metaFor(op.model);
				if (op.method === "create" && op.createdIds.length > 0) {
					const r = await client.executeKw<unknown>(op.model, "unlink", [op.createdIds], withContext(op));
					if (r.ok) {
						undone.push(`unlink ${op.model} ${JSON.stringify(op.createdIds)}`);
						markDone(op);
					} else {
						failed.push(`${op.model}.unlink: ${r.error.slice(0, 120)}`);
					}
				} else if (op.method === "write" && op.preImage.length > 0) {
					let ok = true;
					for (const row of op.preImage) {
						const id = Number(row["id"]);
						if (!Number.isFinite(id)) continue;
						const values = toWriteValues(row, fields, (field, why) => notRestored.set(`${op.model}.${field}`, why));
						if (Object.keys(values).length === 0) continue;
						const r = await client.executeKw<unknown>(op.model, "write", [[id], values], withContext(op));
						if (r.ok) undone.push(`restore ${op.model} ${id}`);
						else {
							ok = false;
							failed.push(`${op.model}.write ${id}: ${r.error.slice(0, 120)}`);
						}
					}
					if (ok) markDone(op);
				} else if (op.method === "unlink" && op.preImage.length > 0) {
					let ok = true;
					for (const row of op.preImage) {
						const values = toWriteValues(row, fields, (field, why) => notRestored.set(`${op.model}.${field}`, why));
						if (Object.keys(values).length === 0) continue;
						const r = await client.executeKw<number>(op.model, "create", [values], withContext(op));
						if (r.ok) {
							// The original id is NOT restored by a re-create; say the new one.
							undone.push(`recreate ${op.model} as id ${String(r.value)} (original id not preserved)`);
						} else {
							ok = false;
							failed.push(`${op.model}.create: ${r.error.slice(0, 120)}`);
						}
					}
					if (ok) markDone(op);
				} else {
					// Nothing compensable in this op (e.g. a create with no ids):
					// mark it so it does not keep the journal alive forever.
					markDone(op);
				}
			} catch (err) {
				failed.push(err instanceof Error ? err.message.slice(0, 120) : String(err));
			}
		}

		const skippedNote =
			notRestored.size === 0
				? ""
				: `; NOT restored (${notRestored.size} field(s)): ` +
					[...notRestored.entries()].slice(0, 5).map(([f, why]) => `${f} (${why})`).join(", ") +
					(notRestored.size > 5 ? ", …" : "");
		const remaining = readCheckpointJournalFile(projectRoot, checkpointId).filter((o) => o.undoneAt === undefined);
		if (remaining.length === 0) {
			writeCheckpointJournal(projectRoot, checkpointId, []);
			return {
				undone,
				detail: `${undone.length} operation(s) undone${alreadyDone > 0 ? `, ${alreadyDone} already compensated` : ""}${skippedNote}`,
			};
		}
		return {
			undone,
			detail:
				`${undone.length} undone, ${failed.length} FAILED (journal kept: the compensated ones are marked ` +
				`and will not be repeated): ${failed.slice(0, 3).join("; ")}${skippedNote}`,
		};
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
		}, exec?: unknown) {
			const root = rootFor(exec);
			const cfg = effectiveConfig(exec);
			const projectRoot = cfg.projectRoot;
			// The SNAPSHOTS are the project's, the pointer is this session's: two
			// sessions must not share "which checkpoint is my rollback target".
			const resolvedActive = activeFor(cfg, exec);
			const active = resolvedActive.state;
			/** The session's checkpoint, or the project's last one when it has none. */
			const checkpointRef = (): string | null => active.checkpointId ?? projectCheckpoint(projectRoot);

			if (args.operation === "list") {
				const all = listCheckpoints(projectRoot);
				const lines = all.map((c) => `${c.id}  [${c.phase ?? "?"}] ${c.label} — ${c.files.length} file(s)`);
				return {
					ok: true, operation: "list" as string, activeCheckpoint: checkpointRef() ?? undefined,
					restored: [] as string[],
					detail:
						`Active: ${checkpointRef() ?? "none"}` +
						(active.checkpointId === null && checkpointRef() !== null
							? " (this session has none of its own; that is the project's LAST checkpoint, created elsewhere)"
							: "") +
						`\nCheckpoints (${all.length}):\n${lines.join("\n") || "(none)"}\n${rootNote(root)}`,
				};
			}

			if (args.operation === "journal") {
				// The SESSION's journal, falling back to the project's LAST checkpoint so a
				// fresh session can still inspect what was recorded before it existed.
				const journalRef = args.checkpoint_id ?? checkpointRef();
				const ops = journalRef === null ? [] : readCheckpointJournalFile(projectRoot, journalRef);
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
					activeCheckpoint: checkpointRef() ?? undefined,
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
					// The snapshot is the project's; the pointer saying "this is MY rollback
					// target" is the calling session's, so a second session cannot treat
					// another change's checkpoint as its own.
					sessionId: sessionIdOf(exec),
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
						(purged > 0 ? ` Purged ${purged} old checkpoint(s) (maxCheckpoints=${cfg.maxCheckpoints}).` : "") +
						`\n${rootNote(root)}`,
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
				const undo = await undoJournal(projectRoot, args.checkpoint_id, asApiPreference(cfg.odooApi));
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
				ok: true, operation: "restore" as string, activeCheckpoint: checkpointRef() ?? undefined,
				restored: files.restored,
				detail:
					`Restored ${files.restored.length} file(s) from ${args.checkpoint_id}` +
					(files.missing.length > 0 ? `; ${files.missing.length} failed: ${files.missing.slice(0, 5).join(", ")}` : "") +
					`. Data undo: ${dataNote}` +
					(restoredData.length > 0 ? ` (${restoredData.length} record op(s))` : "") +
					// Name what was undone: a re-created record keeps a NEW id and
					// that caveat is worthless if it never reaches the operator.
					(restoredData.length === 0
						? ""
						: `\n${restoredData.slice(0, 10).map((u) => `  - ${u}`).join("\n")}` +
							(restoredData.length > 10 ? `\n  … and ${restoredData.length - 10} more` : "")) +
					drift +
					`\n${rootNote(root)}`,
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
		async execute(args: { module_dir: string }, exec?: unknown) {
			const root = rootFor(exec);
			const cfg = effectiveConfig(exec);
			// `isAbsolute` (via the shared helper) instead of a POSIX-only
			// startsWith("/"): a Windows drive or UNC path is absolute too.
			const moduleDir = resolveModuleDir(args.module_dir, cfg.projectRoot);
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
					(lines.join("\n") || "No findings.") +
					`\n${rootNote(root)}`,
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
		async execute(args: { spec_id: string; summary?: string }, exec?: unknown) {
			const root = rootFor(exec);
			const cfg = effectiveConfig(exec);
			const specDir = specDirOf(cfg.projectRoot, cfg.specsDir, args.spec_id, {
				specsMode: cfg.specsMode,
				specsRoot: cfg.specsRoot,
			});
			const state = loadState(specDir);
			const verdict = readVerdict(specDir);
			const kb = kbRead(specDir);
			const checkpoints = listCheckpoints(cfg.projectRoot);
			/**
			 * The COMPLETE data record of this spec: the active journal plus the
			 * journal of every checkpoint that belongs to it, deduplicated and in
			 * chronological order.
			 *
			 * Reading only the active checkpoint's last 20 ops loses the history
			 * exactly when it matters: a run that rolls back, creates a new
			 * checkpoint and carries on would hand off a report that cannot say
			 * what was applied to the instance.
			 */
			const specJournal = ((): DataOp[] => {
				const seen = new Set<string>();
				const all: DataOp[] = [];
				const add = (ops: DataOp[]): void => {
					for (const op of ops) {
						const key = `${op.ts}|${op.model}|${op.method}|${JSON.stringify(op.ids)}|${JSON.stringify(op.createdIds)}`;
						if (seen.has(key)) continue;
						seen.add(key);
						all.push(op);
					}
				};
				const activeId = activeFor(cfg, exec).state.checkpointId ?? projectCheckpoint(cfg.projectRoot);
				for (const checkpoint of checkpoints) {
					if (checkpoint.id === activeId) continue; // read once, below
					if (checkpoint.specId !== args.spec_id) continue;
					add(readCheckpointJournalFile(cfg.projectRoot, checkpoint.id));
				}
				// The active journal is what a naive read would use, and it belongs
				// to THIS spec only when it says so (or was created without one):
				// including another spec's ops here would put operations in the
				// handoff that this spec never applied.
				const activeManifest = checkpoints.find((c) => c.id === activeId);
				if (activeManifest === undefined || activeManifest.specId === null || activeManifest.specId === args.spec_id) {
					add(readJournal(cfg.projectRoot));
				}
				return all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
			})();
			const blockers = kb.filter((n) => n.kind === "blocker");
			const decisions = kb.filter((n) => n.kind === "decision");
			const securityReport = join(specDir, "security-report.md");

			/**
			 * Build the functional runbook from the plan and the durable run state.
			 *
			 * The runbook is the deliverable of a functional run: it is what a person
			 * follows by hand in Odoo. It is generated from real, recorded facts (who
			 * approved what, which operations applied, which criteria they cover) and
			 * it is explicit about what this plugin could NOT verify — a menu path
			 * needs a human or a browser, so it is marked as such instead of invented.
			 */
			const buildRunbook = (): string => {
				const plan = readPlan(cfg.projectRoot, args.spec_id);
				const run = readRun(cfg.projectRoot, args.spec_id);
				const counts = countOps(run.ops);
				const receipts = readGrants(cfg.projectRoot).grants.filter((g) => g.kind === "batch");
				const testPlan = existsSync(join(specDir, "test-plan.md")) ? readFileSync(join(specDir, "test-plan.md"), "utf8") : "";
				const acStatus = new Map<string, string>();
				for (const line of testPlan.split(/\r?\n/)) {
					if (!line.trim().startsWith("|")) continue;
					const cols = line.split("|").slice(1, -1).map((c) => c.trim());
					if (cols.length < 4 || /^[-: ]+$/.test(cols[0]) || /^ac$/i.test(cols[0])) continue;
					acStatus.set(cols[0], cols[3]);
				}
				const out: string[] = [];
				out.push(`# Functional runbook — ${args.spec_id}`);
				out.push("");
				out.push(`<!-- generated by sdd_handoff from .sdd/functional/${args.spec_id}/; it is regenerated on every handoff -->`);
				out.push("");
				out.push(`- Environment: ${plan?.environment ?? "(no plan)"}`);
				if (plan?.serverVersion !== undefined) out.push(`- Server version (as detected when planning): ${plan.serverVersion}`);
				out.push(`- Batches applied: ${new Set(run.ops.filter((o) => o.state === "applied").map((o) => o.batchId)).size}`);
				out.push(`- Operations: ${run.ops.length} — applied ${counts.applied}, failed ${counts.failed}, indeterminate ${counts.indeterminate}`);
				out.push(`- State: ${run.state}`);
				out.push("");

				out.push("## Batches applied");
				const appliedBatches = [...new Set(run.ops.filter((o) => o.state === "applied").map((o) => o.batchId))];
				if (appliedBatches.length === 0) {
					out.push("- (none)");
				} else {
					for (const batchId of appliedBatches) {
						const batch = plan?.batches.find((b) => b.id === batchId);
						const ops = run.ops.filter((o) => o.batchId === batchId);
						const receipt = receipts.find((g) => g.details?.["batchId"] === batchId);
						out.push(
							`- **${batchId}** — ${batch?.title ?? "(not in the plan)"} [${batch?.scope ?? "?"}]\n` +
								`  - Operations applied: ${ops.filter((o) => o.state === "applied").length}/${batch?.operations.length ?? ops.length}` +
								`${ops.some((o) => o.state !== "applied") ? ` (${ops.filter((o) => o.state !== "applied").length} not applied)` : ""}\n` +
								`  - Companies: ${(batch?.companies ?? []).join(", ") || "(default company of the connection)"}\n` +
								`  - Approved by a human: ${receipt === undefined ? "receipt not found in .sdd/grants.json" : `${receipt.createdAt} (expires ${receipt.expiresAt})`}` +
								`${batch?.highRisk === true ? `\n  - HIGH RISK${(batch.backupReference ?? "") === "" ? "" : `, backup: ${batch.backupReference}`}` : ""}`,
						);
					}
				}
				out.push("");

				out.push("## Procedures");
				const procedures: string[] = [];
				for (const batchId of appliedBatches) {
					const batch = plan?.batches.find((b) => b.id === batchId);
					if (batch === undefined) continue;
					procedures.push(`### ${batch.id} — ${batch.title}`);
					procedures.push(
						`Environment: ${plan?.environment ?? "?"} · Companies: ${(batch.companies ?? []).join(", ") || "(default)"} · ` +
							`Acceptance criteria: ${(batch.acceptance ?? []).join(", ") || "(none declared)"}`,
					);
					if ((batch.manualSteps ?? []).length > 0) {
						procedures.push("Steps declared in the plan:");
						for (const step of batch.manualSteps ?? []) procedures.push(`1. ${step}`);
					} else {
						procedures.push(
							"Steps: NOT DECLARED in the plan. This procedure cannot be completed from this document alone — " +
								"a human must write the menu path and the field labels before this batch can be repeated.",
						);
					}
					procedures.push("What the batch did, operation by operation:");
					for (const op of run.ops.filter((o) => o.batchId === batchId)) {
						procedures.push(
							`- [${op.state}] ${op.intent} — ${op.model}.${op.method}` +
								(op.ids === undefined || op.ids.length === 0 ? "" : ` ids=${JSON.stringify(op.ids)}`) +
								(op.createdIds === undefined || op.createdIds.length === 0 ? "" : ` created=${JSON.stringify(op.createdIds)}`) +
								(op.resolution === undefined ? "" : ` — ${op.resolution}`),
						);
					}
					procedures.push(
						"Verification route: MENU PATH NOT VERIFIED by this plugin (no browser, no instance): confirm it in the " +
							"instance, or record the source/documentation you used, before treating this procedure as complete.",
					);
					procedures.push("");
				}
				if (procedures.length === 0) {
					out.push("- (no applied batch: nothing to repeat yet)");
				} else {
					out.push(...procedures);
				}
				if (run.ops.some((o) => o.state === "indeterminate")) {
					out.push("> Operations with an UNKNOWN outcome are listed above as `indeterminate`; reconcile them before repeating anything.");
					out.push("");
				}

				out.push("## Verification evidence");
				const evidence: string[] = [];
				for (const batchId of appliedBatches) {
					const batch = plan?.batches.find((b) => b.id === batchId);
					for (const ac of batch?.acceptance ?? []) {
						const status = acStatus.get(ac);
						evidence.push(
							`- ${ac}: batch ${batchId} applied ${run.ops.filter((o) => o.batchId === batchId && o.state === "applied").length} operation(s)` +
								(status === undefined
									? " — WARNING: this criterion does not appear in test-plan.md"
									: ` — test-plan.md reads \`${status}\``),
						);
					}
				}
				out.push(evidence.length === 0 ? "- (no acceptance criterion is claimed by an applied batch)" : evidence.join("\n"));
				out.push("");

				out.push("## Recovery");
				const recovery: string[] = [];
				for (const batchId of appliedBatches) {
					const batch = plan?.batches.find((b) => b.id === batchId);
					const kinds = [...new Set((batch?.operations ?? []).map((o) => o.recovery?.kind ?? "undeclared"))];
					recovery.push(`- ${batchId}: ${kinds.join(", ")}${kinds.includes("none") ? " — some operations CANNOT be undone" : ""}`);
				}
				const compensation = plan?.batches.find((b) => b.scope === "compensate");
				if (compensation !== undefined) recovery.push(`- compensation batch prepared: ${compensation.id} (apply it only after its own approval)`);
				recovery.push(
					"- What cannot be undone by this plugin: module installs/upgrades, and anything an operation declared as " +
						"`none`. Compensation covers what the journal recorded, nothing else.",
				);
				if (plan?.environment === "production") {
					recovery.push("- Production: the declared backup is the recovery of last resort for what compensation cannot undo.");
				}
				out.push(recovery.join("\n"));
				return out.join("\n") + "\n";
			};

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
			lines.push(`- projectRoot=${cfg.projectRoot} (source: ${cfg.rootSource})`);
			lines.push(`- specs: ${describeSpecsLocation({ projectRoot: cfg.projectRoot, specsMode: cfg.specsMode, specsDir: cfg.specsDir, specsRoot: cfg.specsRoot })}`);
			lines.push(`- autonomy=${cfg.autonomy}`);
			lines.push(
				`- requireSpecForChanges=${cfg.requireSpecForChanges} ` +
					`adoptProjectPointerHint=${cfg.adoptProjectPointerHint}`,
			);
			lines.push(`- allowlist=${JSON.stringify(cfg.executeAllowlist)}`);
			if (cfg.methodAllowlist.length > 0) lines.push(`- method allowlist=${JSON.stringify(cfg.methodAllowlist)}`);
			lines.push(`- communityRepo=${cfg.communityRepoPath || cfg.communityRepoUrl}`);
			lines.push(`- enterpriseRepo=${cfg.enterpriseRepoPath || cfg.enterpriseRepoUrl}`);
			lines.push(`- requireCheckpointBeforeMutation=${cfg.requireCheckpointBeforeMutation} securityReviewRequired=${cfg.securityReviewRequired} auditAllTools=${cfg.auditAllTools}`);
			lines.push("");
			// A waiver is the one thing that lets work happen outside the pipeline:
			// the closing document has to carry it, with the reason the developer
			// gave, or the run reads as if every change had a spec.
			const handoffWaiver = readWaiver(cfg.projectRoot);
			if (handoffWaiver !== null) {
				lines.push("## Waivers (work done without a spec)");
				lines.push(
					`- Session ${handoffWaiver.sessionId}, granted ${handoffWaiver.at}` +
						`${handoffWaiver.specId === undefined ? "" : ` (spec ${handoffWaiver.specId} was active)`} — reason: ${handoffWaiver.reason}`,
				);
				lines.push("");
			}
			lines.push("## Checkpoints");
			lines.push(checkpoints.length === 0 ? "- (none)" : checkpoints.map((c) => `- ${c.id} — ${c.label} (${c.files.length} file(s))`).join("\n"));
			lines.push("");
			lines.push("## Journaled data operations");
			if (specJournal.length === 0) {
				lines.push("- (none)");
			} else {
				// The complete record, bounded with an EXPLICIT omission count and
				// where to read the rest (never a silent truncation).
				const shown = specJournal.slice(0, 50);
				lines.push(
					shown
						.map((o) => {
							const marks = [
								typeof o.db === "string" ? `db=${o.db}` : "",
								typeof o.target === "string" ? `target=${o.target.slice(0, 8)}…` : "",
								o.undoneAt === undefined ? "" : "compensated",
							].filter((m) => m !== "");
							return (
								`- ${o.ts} ${o.model}.${o.method} ids=${JSON.stringify(o.ids)} ` +
								`created=${JSON.stringify(o.createdIds)}${marks.length > 0 ? ` [${marks.join(", ")}]` : ""}`
							);
						})
						.join("\n"),
				);
				if (specJournal.length > shown.length) {
					lines.push(
						`- … and ${specJournal.length - shown.length} more (full record: .sdd/checkpoints/<id>/journal.json of this spec)`,
					);
				}
				lines.push(
					`- Total: ${specJournal.length} operation(s) across the active journal and ` +
						`${checkpoints.filter((c) => c.specId === args.spec_id).length} checkpoint(s) of this spec.`,
				);
			}
			lines.push("");
			lines.push("## Decisions (logbook)");
			lines.push(decisions.length === 0 ? "- (none)" : decisions.slice(-20).map((d) => `- ${sanitize(d.summary, exec)}`).join("\n"));
			lines.push("");
			lines.push("## Open blockers");
			lines.push(blockers.length === 0 ? "- (none)" : blockers.slice(-10).map((b) => `- ${sanitize(b.summary, exec)}`).join("\n"));
			lines.push("");
			lines.push("## Next steps");
			if (state.phase === "DONE") lines.push("- Delivered. Review the diff and commit with the project's conventions.");
			else if (state.phase === "BLOCKED") lines.push("- Blocked: resolve the open blockers above (or remove stop.md) and resume the pipeline.");
			else lines.push(`- Resume at ${state.phase}. Check .sdd/audit.jsonl for the recorded activity.`);

			// A functional spec also gets its RUNBOOK, regenerated from the plan and
			// the run state. A runbook a human wrote is never overwritten: it wins,
			// and the handoff only reports whether it satisfies the closing gate.
			let runbookNote = "";
			if (state.mode === "functional") {
				const runbookPath = join(specDir, RUNBOOK_FILE);
				const existing = existsSync(runbookPath) ? readFileSync(runbookPath, "utf8") : "";
				const isGenerated = existing === "" || existing.includes("generated by sdd_handoff");
				if (isGenerated) {
					try {
						mkdirSync(specDir, { recursive: true });
						writeFileSync(runbookPath, buildRunbook(), { mode: 0o600 });
						runbookNote = `${RUNBOOK_FILE} regenerated from the plan and the run state.`;
					} catch (err) {
						runbookNote = `could not write ${RUNBOOK_FILE}: ${err instanceof Error ? err.message : String(err)}`;
					}
				} else {
					runbookNote = `${RUNBOOK_FILE} was written by a human: left untouched.`;
				}
				lines.push("");
				lines.push("## Functional runbook");
				lines.push(`- ${runbookNote}`);
				const gaps = runbookGaps(specDir);
				lines.push(
					gaps.length === 0
						? "- The closing gate is satisfied: every required section has content."
						: `- Still missing for DONE:\n${gaps.map((g) => `  - ${g}`).join("\n")}`,
				);
				const applied = countOps(readRun(cfg.projectRoot, args.spec_id).ops).applied;
				lines.push(`- Operations recorded as applied: ${applied} (see .sdd/functional/${args.spec_id}/run.json).`);
			}

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
				detail: `Handoff written to ${displayPath(join(specDir, "handoff.md"))} (phase ${state.phase}, verdict ${verdict === null ? "none" : verdict.passed ? "PASSED" : "FAILED"}).\n${rootNote(root)}`,
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
	//   - mutating calls (CRUD and business actions alike) need a checkpoint when
	//     the policy requires one;
	//   - they are refused before WRITE_CODE and without an authorizing spec.
	// The `tools/result` listener records EVERY tool call of the run (ours and
	// foreign), so the activity is reconstructable from .sdd/audit.jsonl.
	// Both are best-effort: a policy bug must never brick the tool surface.
	// ---------------------------------------------------------------------
	const isMutatingCall = (name: string, args: Record<string, unknown>): boolean => {
		if (name === "odoo_execute") {
			const method = String(args["method"] ?? "");
			// A read is not a mutation. A name the RPC cannot call (private, `init`)
			// is refused by the tool before anything is sent, so it cannot mutate
			// either — leaving it "not mutating" here is what lets the tool give its
			// precise reason instead of the checkpoint message. Everything else —
			// CRUD AND every business action — mutates: the checkpoint policy, the
			// change policy and the phase rule apply to it like any other write.
			if (method === "") return false;
			return !isReadMethod(method) && isCallableMethodName(method);
		}
		if (name === "odoo_module") {
			const op = String(args["operation"] ?? "");
			return op === "install" || op === "upgrade";
		}
		if (name === "odoo_import" && String(args["use"] ?? "") === "prepare") {
			// The upload writes a temporary importer record on the instance: it is
			// the one mutating step of the import flow (preview/map/plan are local).
			return true;
		}
		if (name === "odoo_functional") {
			// The batch executor was MISSING from this classification, so its
			// mutations never met the checkpoint or spec policy the tool's own
			// description announces. `apply` is the operation that sends, and it can
			// run a mutating batch (a read-only one is refused by the executor
			// itself); `inspect` only reads; `plan`/`approve`/`verify`/`status`/
			// `reconcile` change local state, not the instance.
			return String(args["operation"] ?? "") === "apply";
		}
		return false;
	};

	/**
	 * Whether a call EDITS a file of the project.
	 *
	 * The host's own editors are the normal way a change lands on disk, and
	 * without this the pipeline could be bypassed entirely: the instance
	 * mutations were gated while the module source was not. The spec documents
	 * and the plugin's own state are always writable — the pipeline itself
	 * writes them — and anything outside the project is none of the plugin's
	 * business.
	 * @param name - tool name.
	 * @param args - tool arguments.
	 * @param cfg - the session's effective configuration.
	 * @returns true when the call edits a project file that a spec must authorize.
	 */
	const isSourceEdit = (name: string, args: Record<string, unknown>, cfg: ReturnType<typeof effectiveConfig>): boolean => {
		if (name !== "write" && name !== "edit") return false;
		const raw = args["file_path"];
		if (typeof raw !== "string" || raw.trim() === "") return false;
		let abs: string;
		try {
			abs = isAbsolute(raw) ? resolve(raw) : resolve(cfg.projectRoot, raw);
		} catch {
			return false;
		}
		if (!isWithinRoot(cfg.projectRoot, abs)) return false;
		try {
			const specsBase = specsBaseFor({
				specsMode: cfg.specsMode,
				specsRoot: cfg.specsRoot,
				specsDir: cfg.specsDir,
				projectRoot: cfg.projectRoot,
			});
			if (isWithinRoot(specsBase, abs)) return false;
		} catch {
			// An unresolvable specs base must not open the gate: fall through and
			// let the .sdd check decide.
		}
		return !isWithinRoot(join(cfg.projectRoot, ".sdd"), abs);
	};

	/** Session id of a tool call (the host's `agent.id` IS the session id). */
	/**
	 * The calling session's identity.
	 *
	 * `Agent.id` IS a `SessionId` (`dsh-agent/lib/types/types.d.ts`), and
	 * `Agent.session.id` carries the same value, so both work. `session.id` is read
	 * first because it is the one the host documents as "the live session this agent
	 * drives"; a plugin that loses this identity would fall back to a shared
	 * pointer, which is the failure this whole scoping exists to prevent.
	 * @param exec - the calling execution context.
	 * @returns the session id, or undefined when the host did not provide one.
	 */
	const sessionIdOf = (exec: unknown): string | undefined => {
		const agent = ((exec ?? {}) as { agent?: { id?: unknown; session?: { id?: unknown } } }).agent;
		const fromSession = agent?.session?.id;
		if (typeof fromSession === "string" && fromSession !== "") return fromSession;
		return typeof agent?.id === "string" && agent.id !== "" ? agent.id : undefined;
	};

	/**
	 * What a change must satisfy: a spec in an authorizing phase, or a waiver.
	 * @param waived - whether the developer already waived the spec requirement
	 * for this session, so the answer is known before the message is built.
	 */
	const changeGate = (
		cfg: ReturnType<typeof effectiveConfig>,
		active: ReturnType<typeof readActiveState>,
		waived: boolean,
	): string | undefined => {
		if (!cfg.requireSpecForChanges || waived) return undefined;
		const authorizedPhases = ["WRITE_CODE", "VERIFY", "FIX_LOOP", "APPLY_CONFIG"];
		// The CANONICAL phase, not the cached pointer. `.sdd/active.json` is a
		// pointer to the spec/checkpoint of the session; the phase lives in
		// `specs/<id>/state.json`, and reading the copy let a spec that had already
		// gone BLOCKED keep authorizing changes until something happened to rewrite
		// the pointer. The pointer cannot be a second authority.
		const phase = canonicalPhase(cfg, active);
		if (phase !== null && authorizedPhases.includes(phase)) return undefined;
		const where =
			active.specId === null
				? "there is no spec for this project"
				: phase === null
					? `the active spec ${active.specId} has no readable state.json`
					: `the active spec ${active.specId} is in ${phase}`;
		return (
			`Change blocked by policy: ${where}, so nothing authorizes it. Three ways out: ` +
			"(1) open a small spec for THIS change (sdd_phase operation=init spec_id=<NNN-slug>, then clarify mode=bug) " +
			"and advance it to WRITE_CODE, (2) if the change is one of the active spec's acceptance criteria, continue " +
			"that spec, or (3) ask the developer to let this session work without a spec (sdd_phase operation=waive " +
			'detail="<what they said>") — that needs their approval and covers this session only.'
		);
	};

	const denyWithAudit = (name: string, args: Record<string, unknown>, reason: string, exec?: unknown): string => {		try {
			const cfg = effectiveConfig(exec);
			const active = activeFor(cfg, exec).state;
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

	/**
	 * The phase the SPEC actually records, falling back to the cached pointer.
	 *
	 * `specs/<id>/state.json` is the canonical record; `.sdd/active.json` is a
	 * pointer to which spec/checkpoint the session is working on. When the two
	 * disagree the spec wins, because it is the file the pipeline writes on every
	 * transition — including the ones that end in BLOCKED. Reading the copy let a
	 * spec that had already gone BLOCKED keep authorizing changes.
	 * @param cfg - the session's effective configuration.
	 * @param active - the active pointer.
	 * @returns the phase to authorize against, or null when there is no spec.
	 */
	const canonicalPhase = (
		cfg: ReturnType<typeof effectiveConfig>,
		active: { specId: string | null; phase: string | null },
	): string | null => {
		if (active.specId === null) return active.phase;
		try {
			const dir = specDirOf(cfg.projectRoot, cfg.specsDir, active.specId, {
				specsMode: cfg.specsMode,
				specsRoot: cfg.specsRoot,
			});
			return loadState(dir).phase;
		} catch {
			// Unreadable canonical state must not open the gate: the pointer is the
			// best available answer, and the caller decides what it authorizes.
			return active.phase;
		}
	};

	/**
	 * The pointer THIS session works against, with its provenance.
	 *
	 * `.sdd/active.json` used to be the single authority, so two sessions in one
	 * project overwrote each other and a session could end up authorizing changes
	 * against a spec it had never opened. The pointer now lives per session
	 * (`.sdd/active/<sessionId>.json`); the project file survives only as a HINT
	 * for a session that has none — fresh, and naming a spec that still exists.
	 * @param cfg - the session's effective configuration.
	 * @param exec - the calling execution, source of the session identity.
	 * @returns the resolved pointer; `state.specId === null` means "no spec here".
	 */
	const activeFor = (cfg: ReturnType<typeof effectiveConfig>, exec?: unknown): ReturnType<typeof resolveActiveState> => {
		// "Exists" means the spec DIRECTORY is there, not that its state is readable:
		// a spec whose state.json is missing or corrupt must still be adoptable, and
		// the gate stays closed anyway because `canonicalPhase` then reads whatever
		// `loadState` can (CLARIFY by default), never the hint's phase.
		const specExists = (specId: string): boolean => {
			try {
				const dir = specDirOf(cfg.projectRoot, cfg.specsDir, specId, {
					specsMode: cfg.specsMode,
					specsRoot: cfg.specsRoot,
				}, { create: false });
				return existsSync(dir);
			} catch {
				return false;
			}
		};
		// `adoptProjectPointerHint=false` is the strict mode: a session without a
		// pointer of its own gets NO spec, so it can never authorize against the last
		// thing another session happened to touch.
		return resolveActiveState(cfg.projectRoot, sessionIdOf(exec), specExists, cfg.adoptProjectPointerHint);
	};

	/**
	 * The checkpoint the PROJECT last created, read from the summary file.
	 *
	 * Distinct from the session's own pointer on purpose: a NEW session that never
	 * created a checkpoint can still be shown ("and roll back to") the project's
	 * most recent snapshot. It is a fallback for read-only reporting and for an
	 * explicit restore — never the value the guard trusts for "a checkpoint
	 * exists", which is the session's own, because a session must not ride on a
	 * snapshot another one took for a different change.
	 * @param projectRoot - workspace root.
	 * @returns the last checkpoint id, or null.
	 */
	const projectCheckpoint = (projectRoot: string): string | null => readActiveState(projectRoot).checkpointId;

	/** Why the policy guard could not be installed, when that happened. */
	let guardUnavailable: string | null = null;
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
					// The guard runs for the SESSION's project: a guard that read a
					// plugin-wide root would arm the wrong project's policy.
					const cfg = effectiveConfig(execution);
					// The SESSION's pointer, not the project's shared file: with two
					// sessions open on one project, the shared file let one authorize
					// changes against the other's spec.
					const active = activeFor(cfg, execution).state;

					// 1) Emergency stop halts every tool.
					const stopCandidates = [join(cfg.projectRoot, ".sdd", "stop.md")];
					if (active.specId !== null) {
						stopCandidates.push(
							specDirOf(cfg.projectRoot, cfg.specsDir, active.specId, {
								specsMode: cfg.specsMode,
								specsRoot: cfg.specsRoot,
							}, { create: false }) + sep + "stop.md",
						);
					}
					for (const candidate of stopCandidates) {
						if (existsSync(candidate)) {
							return denyWithAudit(name, args, `stop.md present at ${displayPath(candidate)} — every tool is halted until it is removed.`, execution);
						}
					}

					// 2) While a FUNCTIONAL batch is being applied, the approved plan
					// is the ONLY mutation path: a direct call to any other tool would
					// bypass the batches, the hashes and the journal that make the run
					// auditable. Reads and local tools stay available.
					const functionalRun = activeFunctionalRun(cfg.projectRoot);
					if (functionalRun !== null) {
						const blockedByFunctional =
							(isMutatingCall(name, args) && name !== "odoo_functional") ||
							(name === "sdd_checkpoint" && args["operation"] === "restore" && args["restore_data"] === true);
						if (blockedByFunctional) {
							return denyWithAudit(
								name,
								args,
								`Blocked: a functional run (spec ${functionalRun.specId}, batch ${functionalRun.batchId}) is in ` +
									"progress and its approved batches are the only mutation path. Wait for it, or use " +
									"odoo_functional (approve a batch / compensate) instead of mutating directly.",
								execution,
							);
						}
					}

					// 3) Change policy: nothing changes without a spec that authorizes
					// it (a phase of writing) or a waiver the developer approved for
					// THIS session. Instance mutations and file edits are the same
					// question asked of two different surfaces.
					const waived = waiverCovers(cfg.projectRoot, sessionIdOf(execution)) !== null;
					const editsSource = isSourceEdit(name, args, cfg);
					if (isMutatingCall(name, args) || editsSource) {
						const gate = changeGate(cfg, active, waived);
						if (gate !== undefined) return denyWithAudit(name, args, gate, execution);
					}

					// 4) Mutation policy (checkpoint + phase). A checkpoint covers
					// instance mutations: a rollback needs the pre-image the journal
					// stores, while a file edit is not undone by it. The phase rule
					// belongs to the SPEC question, so the same two answers that open
					// the change gate (policy off, waiver for this session) open it
					// too; the checkpoint rule is its own policy and stays armed —
					// "no spec for this" was never "no rollback needed".
					if (isMutatingCall(name, args)) {
						if (cfg.requireCheckpointBeforeMutation && active.checkpointId === null) {
							return denyWithAudit(
								name,
								args,
								"Mutation blocked by policy: no checkpoint exists. Run `sdd_checkpoint` with operation=create first " +
									"(requireCheckpointBeforeMutation=true), or disable that policy with odoo_config.",
								execution,
							);
						}
						const allowedPhases = ["WRITE_CODE", "VERIFY", "FIX_LOOP", "APPLY_CONFIG"];
						const mutationPhase = canonicalPhase(cfg, active);
						if (cfg.requireSpecForChanges && !waived && mutationPhase !== null && !allowedPhases.includes(mutationPhase)) {
							return denyWithAudit(
								name,
								args,
								`Mutation blocked: the active spec is in phase ${mutationPhase}. Approve the spec/architecture first ` +
									"so the pipeline reaches WRITE_CODE.",
								execution,
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
		} else {
			guardUnavailable = "this host exposes no `tools.guard`, so nothing can refuse a mutation before it is sent";
		}
	} catch (err) {
		// A host that HAS the guard API and fails to install the listener is the
		// worse case of the two: the plugin would mount, the documentation would
		// describe an armed policy, and every mutation would go through unguarded.
		guardUnavailable = `installing the policy guard failed (${err instanceof Error ? err.message : String(err)})`;
	}

	// The event listeners are a SEPARATE concern from the guard: a host whose
	// event surface is missing or broken keeps working without the audit listener
	// (it is not a security guarantee), while a missing GUARD is refused below
	// when the policy it enforces is armed. Sharing one catch conflated the two.
	try {
		if (typeof ctx.on === "function") {
			// Stamp the start of every call so the result entry carries a real
			// duration instead of the previous hard-coded 0.
			const startedAt = new Map<string, number>();
			// `tools/pre-execute` is a WATERFALL (@mode waterfall): the listener
			// MUST forward `next()` and return its PreToolDecision. Returning
			// undefined leaves the pipeline without a decision, and the host then
			// throws `Cannot read properties of undefined (reading 'kind')` for
			// EVERY tool — the whole surface goes down.
			ctx.on("tools/pre-execute", async (...eventArgs: unknown[]) => {
				const next = eventArgs[eventArgs.length - 1];
				try {
					const exec = (eventArgs[0] ?? {}) as { callId?: unknown };
					if (typeof exec.callId === "string") startedAt.set(exec.callId, Date.now());
				} catch {
					// best-effort timing
				}
				return typeof next === "function" ? await (next as () => Promise<unknown>)() : undefined;
			});
			ctx.on("tools/result", (...eventArgs: unknown[]) => {
				try {
					const execution = (eventArgs[0] ?? {}) as { name?: unknown; arguments?: unknown; callId?: unknown };
					const cfg = effectiveConfig(execution);
					if (!cfg.auditAllTools) return;
					const result = (eventArgs[1] ?? {}) as { isError?: unknown; error?: unknown };
					const active = activeFor(cfg, execution).state;
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

	// The guard is a SECURITY guarantee, so its absence is not tolerated when the
	// policy it enforces is armed: mounting anyway would announce a policy the
	// plugin cannot deliver.
	if (guardUnavailable !== null) {
		const cfg = effectiveConfig();
		const armed = cfg.requireSpecForChanges || cfg.requireCheckpointBeforeMutation;
		if (armed) {
			throw new Error(
				`dsh-odoo-sdd cannot mount: ${guardUnavailable}. The configured policy is armed ` +
					`(requireSpecForChanges=${String(cfg.requireSpecForChanges)}, ` +
					`requireCheckpointBeforeMutation=${String(cfg.requireCheckpointBeforeMutation)}), and mounting without it would ` +
					"announce a guarantee this plugin cannot deliver. Either use a host that provides `tools.guard`, or turn the " +
					"policy off explicitly with odoo_config (which is a decision, recorded in .sdd/config.json).",
			);
		}
	}


	registerDocsTool(ctx, {
		projectRoot: (exec) => effectiveConfig(exec).projectRoot,
		// Documenting a spec honours the configured layout (project or central)
		// instead of assuming `<root>/specs`.
		specDir: (specId, exec) => {
			const cfg = effectiveConfig(exec);
			return specDirOf(cfg.projectRoot, cfg.specsDir, specId, {
			specsMode: cfg.specsMode,
			specsRoot: cfg.specsRoot,
		});
		},
		configuredLanguage: (exec) => effectiveConfig(exec).documentationLanguage,
		display: (v) => displayPath(v),
	});

	/**
	 * Detected server version per project, probed on demand and cached for the
	 * activation: the import contract is version-specific, and `common.version`
	 * needs no authentication.
	 */
	const versionCache = new Map<string, string>();
	const versionFor = async (projectRoot: string): Promise<string | undefined> => {
		const cached = versionCache.get(projectRoot);
		if (cached !== undefined) return cached;
		const { client } = clientFor(projectRoot);
		if (client === null) return undefined;
		const probed = await client.version();
		if (!probed.ok) return undefined;
		versionCache.set(projectRoot, probed.value.server_version);
		return probed.value.server_version;
	};

	// ---------------------------------------------------------------------
	// odoo_functional — the batch executor of the functional path
	// ---------------------------------------------------------------------
	registerFunctionalTool(ctx, {
		projectRoot: (exec) => effectiveConfig(exec).projectRoot,
		// The business-action allowlist belongs to the batch executor: it is the
		// surface with a precondition, a postcondition and a per-batch approval.
		methodAllowlist: (exec) => effectiveConfig(exec).methodAllowlist,
		specDir: (specId, exec) => {
			const cfg = effectiveConfig(exec);
			return specDirOf(cfg.projectRoot, cfg.specsDir, specId, {
			specsMode: cfg.specsMode,
			specsRoot: cfg.specsRoot,
		});
		},
		client: (exec) => {
			const cfg = effectiveConfig(exec);
			const { client, report, credentials } = clientFor(cfg.projectRoot, asApiPreference(cfg.odooApi));
			return {
			client,
			report,
			...(credentials === null
				? {}
				: {
						target: `${credentials.url} db=${credentials.db} user=${credentials.username}`,
						...(credentials.environment === undefined ? {} : { environment: credentials.environment }),
					}),
		};
		},
		approve: (exec, reason) => requestNativeApproval(ctx, exec, "odoo_functional", reason),
		hashes: (specId, exec) => {
			const cfg = effectiveConfig(exec);
			const dir = specDirOf(cfg.projectRoot, cfg.specsDir, specId, {
			specsMode: cfg.specsMode,
			specsRoot: cfg.specsRoot,
		});
			const read = (name: string): string => {
	try {
				return readFileSync(join(dir, name), "utf8");
			} catch {
				return "";
			}
		};
			return { specHash: sha256(read("spec.md")), designHash: sha256(read("architecture.md")) };
		},
		grants: {
			write: (input, exec) => {
			writeGrant(effectiveConfig(exec).projectRoot, {
				kind: "batch",
				fingerprint: input.fingerprint,
				...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes }),
				...(input.reason === undefined ? {} : { reason: input.reason }),
				...(input.details === undefined ? {} : { details: input.details }),
			});
		},
			valid: (fingerprint, exec) => hasValidGrant(effectiveConfig(exec).projectRoot, "batch", fingerprint),
		},
		audit: (entry, exec) => {
			const cfg = effectiveConfig(exec);
			const active = activeFor(cfg, exec).state;
			recordAudit(
			cfg.projectRoot,
			{
				tool: "odoo_functional",
				op: `${entry.batchId}[${entry.index + 1}] ${entry.model}.${entry.method}`,
				outcome: entry.state === "applied" ? "ok" : "error",
				source: "tool",
				kind: "functional",
				...(entry.reason === undefined ? {} : { reason: entry.reason }),
				phase: active.phase ?? undefined,
				specId: active.specId ?? undefined,
			},
			clientFor(cfg.projectRoot).credentials,
			);
		},
		recordDataOp: (op, exec) => {
			const cfg = effectiveConfig(exec);
			const credentials = clientFor(cfg.projectRoot).credentials;
			appendDataOp(cfg.projectRoot, {
			ts: new Date().toISOString(),
			...(credentials === null
				? {}
				: {
						db: credentials.db,
						target: fingerprintOf(credentials.url, credentials.db, credentials.username),
					}),
			...op,
		});
		},
		/**
		 * Run one declared import through Odoo's importer.
		 *
		 * The session, the CSRF token and the version contract live here (not in the
		 * executor), and the classification is the same contract as any other
		 * operation: a transport failure after the apply call is INDETERMINATE.
		 */
		runImport: async (op, exec) => {
			const cfg = effectiveConfig(exec);
			const { client } = clientFor(cfg.projectRoot, asApiPreference(cfg.odooApi));
			if (client === null) return { ok: false, error: "no instance configured" };
			const version = (await versionFor(cfg.projectRoot)) ?? "";
			const caps = capabilitiesFor(version);
			if (!caps.ok) return { ok: false, error: caps.message };
			const spec = op.import;
			if (spec === undefined) return { ok: false, error: "the import operation has no import block" };
			// The file is NOT re-uploaded here: the batch carries the id of the record
			// prepared and approved during the import-prep phase, so what the human
			// approved (file hash + mapping) is what runs. A re-upload at this point
			// would swap the content after the approval.
			const session = readWebSession(cfg.projectRoot);
			if (session === null) {
			return {
				ok: false,
				error:
					"NEEDS_WEB_SESSION: applying an import needs the web session cookie (the file route is a web " +
					"route). Run odoo_session and retry.",
			};
		}
			const signal = exec !== null && typeof exec === "object" && "signal" in exec ? (exec as { signal?: AbortSignal }).signal : undefined;
			const args = applyArguments(caps.capabilities, {
			importId: spec.importId,
			fields: [],
			columns: spec.columns,
			options: { ...spec.options, ...(spec.dryRun ? { dryrun: true } : {}) },
			dryRun: spec.dryRun,
		});
			const applied = await client.executeKw<unknown>(
			"base_import.import",
			caps.capabilities.apply.method,
			args,
			{},
			undefined,
			signal,
			);
			if (!applied.ok) {
			const kind = (applied as { errorKind?: string }).errorKind;
			return {
				ok: false,
				indeterminate: kind === "transport" || kind === "protocol",
				error: applied.error,
			};
		}
			const outcome = readImportOutcome(applied.value);
			// Odoo answered, so nothing is indeterminate: the rows it reports DID land and
			// must never be re-sent. The classification (clean vs partial) lives in
			// `reportAppliedImport`, which is unit-tested on its own.
			return { ok: true, value: reportAppliedImport(outcome) };
		},
		display: (v) => displayPath(v),
	});

	registerImportTool(ctx, {
		projectRoot: (exec) => effectiveConfig(exec).projectRoot,
		specDir: (specId, exec) => {
			const cfg = effectiveConfig(exec);
			return specDirOf(cfg.projectRoot, cfg.specsDir, specId, {
			specsMode: cfg.specsMode,
			specsRoot: cfg.specsRoot,
		});
		},
		client: async (exec) => {
			const cfg = effectiveConfig(exec);
			const { client, report } = clientFor(cfg.projectRoot, asApiPreference(cfg.odooApi));
			const version = await versionFor(cfg.projectRoot);
			return { client, report, ...(version === undefined ? {} : { serverVersion: version }) };
		},
		approve: (exec, reason) => requestNativeApproval(ctx, exec, "odoo_import", reason),
		authorisedFile: (filePath, exec) => {
			// Where the plugin is willing to READ from: the session's project or the OS
			// temp area (where attachments land). This is a guardrail against pointing an
			// import at an unrelated file on disk, not a sandbox — the operator's own
			// approval is what authorises the import itself.
			const cfg = effectiveConfig(exec);
	try {
			const resolved = resolve(filePath);
			return isWithinRoot(cfg.projectRoot, resolved) || isWithinRoot(resolve(tmpdir()), resolved);
		} catch {
			return false;
		}
		},
		display: (v) => displayPath(v),
	});

	registerRuntimeTools(ctx, {
		client: (exec) => clientFor(effectiveConfig(exec).projectRoot, asApiPreference(effectiveConfig(exec).odooApi)),
		status: (pr) => setupStatusFor(pr),
		projectRoot: (exec) => effectiveConfig(exec).projectRoot,
		allowlist: (exec) => effectiveConfig(exec).executeAllowlist,
		recordDataOp: (op, exec) => {
	try {
			const cfg = effectiveConfig(exec);
			// Stamp the destination so a replay against a DIFFERENT database or
			// a different user/url on the same database is detected instead of
			// silently mutating the wrong instance.
			const credentials = clientFor(cfg.projectRoot).credentials;
			const target =
				credentials === null ? undefined : fingerprintOf(credentials.url, credentials.db, credentials.username);
			appendDataOp(cfg.projectRoot, {
				ts: new Date().toISOString(),
				...(credentials !== null && credentials !== undefined ? { db: credentials.db } : {}),
				...(target !== undefined ? { target } : {}),
				...op,
			});
		} catch {
			// journaling is best-effort
		}
		},
		display: (v) => displayPath(v),
		auditFailure: (info, exec) => {
	try {
			const cfg = effectiveConfig(exec);
			const active = activeFor(cfg, exec).state;
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
