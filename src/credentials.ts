/**
 * Secure credential handling for the dsh-odoo-sdd plugin.
 *
 * Credentials live in a gitignored `.env` file provided by the developer.
 * This module is the ONLY place that reads them, and it enforces:
 *   - restrictive file permissions (refuses world/group-readable files);
 *   - redaction: secret values never leave this module in plain text, are
 *     never logged, and never appear in tool outputs or error messages;
 *   - fail-closed behavior: a missing or invalid .env yields a structured
 *     "not configured" result instructing the developer what to do, instead
 *     of prompting for secrets through the chat channel.
 *
 * Credential location cascade (first existing file wins):
 *   1. `ODOO_SDD_ENV_FILE` environment override (explicit, highest priority)
 *   2. `<projectRoot>/.sdd/.env`      (project scope, plugin-owned hidden dir)
 *   3. `$XDG_CONFIG_HOME/dsh-odoo-sdd/.env` or `~/.config/dsh-odoo-sdd/.env`
 *                                     (user scope — the generic default; one
 *                                      set of dev credentials serves every
 *                                      Odoo project on the machine)
 *   4. `<projectRoot>/.env`           (legacy location, kept for backwards
 *                                      compatibility; reported as legacy)
 *
 * @module dsh-odoo-sdd/credentials
 */
import { readFileSync, statSync, existsSync, chmodSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
// ONE session-identity convention for every per-session pointer (the spec pointer
// in checkpoints.ts uses the same function): a second sanitizer here would drift.
import { sessionFileKey } from "./checkpoints.js";

/** Where a resolved credential file came from in the cascade. */
export type CredentialSource =
	/** `$ODOO_SDD_ENV_FILE`: an explicit operator instruction, highest priority. */
	| "env-var"
	/** A target named explicitly on the call (authorize/revoke by name). */
	| "forced"
	/** The instance THIS session chose. */
	| "instance"
	/** The project's last-used instance, inherited by a session that chose none. */
	| "instance-inherited"
	/** `<root>/.sdd/.env`, the single-target layout. */
	| "project"
	/** `~/.config/dsh-odoo-sdd/.env`. */
	| "user"
	/** `<root>/.env`. */
	| "legacy";

/** One concrete credential location in the cascade. */
export interface CredentialLocation {
	/** Absolute path of the candidate .env file. */
	path: string;
	/** Which cascade tier produced it. */
	source: CredentialSource;
	/**
	 * Name of the instance this file belongs to, when there is one.
	 *
	 * A project can hold several targets (a local CE, a staging EE, a client's
	 * server), each in `.sdd/instances/<name>.env`. The legacy `<root>/.sdd/.env`
	 * is reported as the instance `default`, so an existing single-target project
	 * keeps working AND `instance=list` can offer to move that file.
	 */
	instance?: string;
}

/**
 * Whether a value may be used as an instance name.
 *
 * The name becomes a FILE NAME inside `.sdd/instances/`, so this is the guard
 * that stops a name from escaping that directory (`..`, a path separator, an
 * absolute path, a NUL byte). Deliberately conservative: it must start with a
 * letter or digit and may only contain letters, digits, dot, dash and underscore.
 * @param value - the candidate name.
 * @returns true when the name is safe to build a path with.
 */
export function isInstanceName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
		!value.includes("..")
	);
}

/** The connection data the pipeline needs to reach an existing Odoo instance. */
export interface OdooCredentials {
	/** Base URL of the Odoo instance, without trailing slash. */
	url: string;
	/** Target database name (must be a disposable dev/staging DB). */
	db: string;
	/** Login of the user the pipeline authenticates as. */
	username: string;
	/** Password or API key. NEVER serialize, log, or render this value. */
	secret: string;
	/**
	 * Which NAME the secret was declared under. Never the value itself: knowing
	 * that a credential is an API key is what lets the web-session path warn
	 * BEFORE calling, instead of surfacing an opaque failure afterwards.
	 */
	secretKind?: "password" | "api_key";
	/** Absolute path of the .env file the credentials were loaded from. */
	envFile: string;
	/** Cascade tier the .env file was loaded from. */
	source: CredentialSource;
	/**
	 * Name of the instance the credentials belong to, when the file is a named
	 * one (`.sdd/instances/<name>.env`). Undefined for the user/legacy tiers.
	 */
	instance?: string;
	/**
	 * Declared environment of the target (`ODOO_SDD_ENVIRONMENT`), when the
	 * developer declared one. UNDEFINED means "not declared": the functional
	 * executor refuses to apply anything until it is, because guessing `dev` on a
	 * production database is the most expensive mistake this plugin can make.
	 */
	environment?: TargetEnvironment;
}

/** Declared environment of a target instance. */
export type TargetEnvironment = "dev" | "staging" | "production";

/** Accepted environment values, in declaration order. */
export const TARGET_ENVIRONMENTS: readonly TargetEnvironment[] = ["dev", "staging", "production"];

/**
 * Parse the declared environment of a target.
 * @param raw - the raw `ODOO_SDD_ENVIRONMENT` value.
 * @returns the environment, or null when absent.
 * @throws TypeError through the caller when the value is not recognized (the
 *   caller reports it as a configuration problem instead of guessing).
 */
export function parseEnvironment(raw: string | undefined): TargetEnvironment | null {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "") return null;
	if (value === "development" || value === "local") return "dev";
	if (value === "stage" || value === "preprod" || value === "pre-production") return "staging";
	if (value === "prod") return "production";
	return (TARGET_ENVIRONMENTS as readonly string[]).includes(value) ? (value as TargetEnvironment) : null;
}

/** Structured "not configured" report returned instead of throwing. */
export interface CredentialsProblem {
	ok: false;
	/** Machine-readable reason code. */
	reason:
		| "env_file_missing"
		| "env_file_insecure"
		| "required_var_missing"
		| "invalid_url"
		| "insecure_url"
		| "invalid_environment"
		| "needs_instance";
	/** Developer-facing remediation instructions (never contains secrets). */
	message: string;
	/** Path of the .env file that was (or should be) used. */
	envFile: string;
}

export type CredentialsResult =
	| {
			ok: true;
			credentials: OdooCredentials;
			/**
			 * Present when the filesystem cannot express owner-only modes, so
			 * the .env could not be verified as private. Non-blocking: callers
			 * MUST surface it to the developer instead of silently ignoring it.
			 */
			permissionNote?: string;
			/**
			 * Present when the credential file carries something the developer should
			 * know about but that does not block the load (an ignored duplicate name,
			 * for instance). Non-secret by construction, so it may be shown.
			 */
			credentialNote?: string;
			/**
			 * Where the ENVIRONMENT came from, when that is worth saying out loud.
			 * A session that never chose one and inherited the project's last choice
			 * must be told so: otherwise "why is it pointing at another one?" has no
			 * answer anywhere in the output.
			 */
			sourceNote?: string;
	  }
	| CredentialsProblem;

/** Variables always required. The SECRET is checked separately: it has two names. */
const REQUIRED_VARS = ["ODOO_URL", "ODOO_DB", "ODOO_USERNAME"] as const;

/**
 * Accepted names of the secret, in precedence order.
 *
 * Odoo accepts an API key anywhere a password is accepted over RPC, so the field
 * has always CARRIED both — but it was only ever NAMED after one. A developer who
 * wrote the accurate name got "Missing required variable(s): ODOO_PASSWORD",
 * which is a naming failure, not a configuration one.
 */
const SECRET_VARS = ["ODOO_PASSWORD", "ODOO_API_KEY"] as const;

/**
 * Resolve the secret from either accepted name.
 * @param vars - parsed .env values.
 * @returns the value, its DECLARED kind, and a note when a name was ignored.
 */
function resolveSecret(vars: Record<string, string>): {
	value: string;
	kind: "password" | "api_key";
	note?: string;
} | null {
	const password = (vars["ODOO_PASSWORD"] ?? "").trim();
	const apiKey = (vars["ODOO_API_KEY"] ?? "").trim();
	// ODOO_PASSWORD wins: it is the historical name, and silently switching which
	// credential is in use would be the worst possible reading of an ambiguous file.
	if (password !== "") {
		return {
			value: vars["ODOO_PASSWORD"]!,
			kind: "password",
			...(apiKey === ""
				? {}
				: {
						note:
							"ODOO_API_KEY is also set and was IGNORED: ODOO_PASSWORD takes precedence. " +
							"Remove whichever one is stale, so the credential in use is unambiguous.",
					}),
		};
	}
	if (apiKey !== "") return { value: vars["ODOO_API_KEY"]!, kind: "api_key" };
	return null;
}

/** Hostnames treated as local for transport-security purposes (S1). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "ip6-localhost"]);

/** True when the host is loopback-shaped (explicit list, real IPv4 127/8, or *.localhost). */
function isLoopback(hostname: string): boolean {
	if (LOOPBACK_HOSTS.has(hostname)) return true;
	if (hostname.endsWith(".localhost")) return true;
	// A hostname that merely *starts* with "127." (e.g. "127.odoo.example.com")
	// is NOT loopback — only a genuine IPv4 in 127/8 qualifies.
	if (isIP(hostname) === 4) {
		const first = Number(hostname.split(".")[0]);
		return first === 127;
	}
	return false;
}

/**
 * Mask the user's home directory in any display string (privacy: log and
 * tool output should not disclose the developer's filesystem layout).
 * @param text - any text that may embed absolute paths.
 * @returns the text with home paths folded into `~`.
 */
export function displayPath(text: string): string {
	const home = homedir();
	if (home === "" || home === undefined) return text;
	return text.split(home).join("~");
}

/**
 * Generic credential-shape scrubber (S2): masks `key=value`/`key: value`
 * shapes for common secret key names, `Bearer <token>` headers, and
 * `user:pass@host` URL shapes, independently of the loaded secret. This is
 * applied to text the AGENT supplies (phase notes, verdict details), which
 * the plugin must persist only after scrubbing.
 * @param text - text that may embed credential shapes.
 * @returns the scrubbed text.
 */
export function scrubGeneric(text: string): string {
	// Covers `password=value`, `password: value`, `"password": "value"` (JSON),
	// and `'password': 'value'`. The leading/trailing quotes group matches the
	// same quote character on both sides via backreference.
	let out = text.replace(
		/(["']?)(password|passwd|pwd|secret|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|session[-_]?id|session_id|cookie)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi,
		(_m, q: string, key: string, sep: string) => `${q}${key}${q}${sep}***REDACTED***`,
	);
	out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***REDACTED***");
	out = out.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@");
	return out;
}

/**
 * One-stop sanitizer for any string that may be persisted to the KB/verdicts
 * or shown to the model: known-secret redaction (when credentials are
 * loaded), generic shape scrubbing, and home-path masking.
 * @param text - raw text (agent note, server output, path...).
 * @param credentials - loaded credentials when available.
 * @returns the sanitized text.
 */
export function sanitizeForPersist(text: string, credentials?: OdooCredentials | null): string {
	const base = credentials ? redact(text, credentials) : text;
	return displayPath(scrubGeneric(base));
}

/** Directory holding user-scoped plugin configuration (XDG-aware). */
export function userConfigDir(): string {
	const xdg = process.env["XDG_CONFIG_HOME"];
	const base = xdg !== undefined && xdg.trim() !== "" ? xdg.trim() : join(homedir(), ".config");
	return join(base, "dsh-odoo-sdd");
}

/** Ordered credential search paths; the first existing file wins. */
export function credentialCandidates(
	projectRoot: string,
	options: { sessionId?: string; instance?: string; adoptProjectHint?: boolean; requireChoice?: boolean } = {},
): CredentialLocation[] {
	const candidates: CredentialLocation[] = [];
	const override = process.env["ODOO_SDD_ENV_FILE"];
	if (override !== undefined && override.trim() !== "") {
		candidates.push({ path: resolve(override.trim()), source: "env-var" });
	}
	// A target named EXPLICITLY (authorize/revoke by name) outranks every pointer:
	// asking about one environment must not answer about another.
	if (options.instance !== undefined) {
		const forced = instanceEnvPath(projectRoot, options.instance);
		if (forced !== null) {
			candidates.push({ path: forced, source: "forced", instance: options.instance });
		}
	}
	// THIS session's choice, then the project's last-used as the inherited default.
	// Named instances come before the legacy file because they are more specific,
	// and after the env-var because an explicit override is an operator instruction.
	const chosen = [
		{ name: readSessionInstance(projectRoot, options.sessionId), source: "instance" as const },
		{
			name: options.adoptProjectHint === false ? null : readActiveInstance(projectRoot),
			source: "instance-inherited" as const,
		},
	];
	const seen = new Set<string>();
	for (const entry of chosen) {
		if (entry.name === null || seen.has(entry.name)) continue;
		seen.add(entry.name);
		const path = instanceEnvPath(projectRoot, entry.name);
		if (path !== null) candidates.push({ path, source: entry.source, instance: entry.name });
	}
	candidates.push({ path: join(projectRoot, ".sdd", ".env"), source: "project", instance: "default" });
	candidates.push({ path: join(userConfigDir(), ".env"), source: "user" });
	candidates.push({ path: join(projectRoot, ".env"), source: "legacy" });
	return candidates;
}

/**
 * Instance names to choose from when the project has SEVERAL and chose none.
 *
 * This is the one state that must never be resolved by guessing: picking one by
 * alphabetical order would aim mutations at a target nobody selected. The legacy
 * single file does not count as an instance here — a project that never used the
 * feature has exactly one target and must keep working untouched.
 * @param projectRoot - workspace root.
 * @returns the names to choose from (empty when there is no ambiguity).
 */
export function ambiguousInstances(projectRoot: string): string[] {
	if (readActiveInstance(projectRoot) !== null) return [];
	const named = listInstances(projectRoot).filter((entry) => !entry.legacy);
	return named.length > 1 ? named.map((entry) => entry.name) : [];
}

/**
 * The named instances a session must choose FROM, or none when it already chose.
 *
 * Unlike {@link ambiguousInstances}, this does not require several: the point is
 * not that the choice is ambiguous, it is that a session which never chose must
 * not inherit one silently. Working in the wrong database is the failure; being
 * asked once is the price.
 * @param projectRoot - workspace root.
 * @param sessionId - the calling session.
 * @returns the instance names to choose from (empty when there is nothing to ask).
 */
export function instancesToChoose(
	projectRoot: string,
	sessionId: string | undefined,
): InstanceSummary[] {
	if (readSessionInstance(projectRoot, sessionId) !== null) return [];
	return listInstances(projectRoot).filter((entry) => !entry.legacy);
}

/**
 * The question a session that has not chosen its environment is asked.
 *
 * It is written for the MODEL to relay to the developer, which is why it carries
 * the non-secret identity of every option and both ways forward: pick one, or
 * declare a new one. It never blocks a tool that does not touch Odoo.
 * @param projectRoot - workspace root.
 * @param choices - the instances available.
 * @returns the asking message.
 */
export function describeInstanceChoice(projectRoot: string, choices: InstanceSummary[]): string {
	const suggested = readActiveInstance(projectRoot);
	const lines = choices.map((entry) => {
		const where = entry.url === null ? "unreadable" : `${entry.url} db=${entry.db ?? "?"} user=${entry.username ?? "?"}`;
		return `  - ${entry.name}${entry.name === suggested ? " (the project's last used)" : ""}: ${where}`;
	});
	return (
		`This session has no environment chosen yet, and this project defines ${choices.length} ` +
		`instance(s):\n${lines.join("\n")}\n` +
		"ASK THE DEVELOPER which one THIS session should use, then record the answer:\n" +
		"  - an existing one: `odoo_setup mode=instance instance=use name=<name>`\n" +
		"  - a new one: `odoo_setup mode=instance instance=add name=<name> url=<url> db=<db> username=<user>`, " +
		"fill its secret by hand, `mode=authorize name=<name>`, then `instance=use name=<name>`.\n" +
		"Nothing was sent anywhere. A session never inherits another session's environment silently: " +
		"doing so is how two sessions end up writing to the same database by accident."
	);
}

/** Resolve the first existing credential source in the cascade, or null. */
export function resolveCredentialSource(
	projectRoot: string,
	options: { sessionId?: string; instance?: string; adoptProjectHint?: boolean; requireChoice?: boolean } = {},
): CredentialLocation | null {
	for (const candidate of credentialCandidates(projectRoot, options)) {
		if (existsSync(candidate.path)) return candidate;
	}
	return null;
}

/**
 * Absolute path of a named instance's credential file.
 *
 * The name is validated here and NOT by the caller: every path in this module is
 * built from a checked name, so no call site can forget the check.
 * @param projectRoot - workspace root.
 * @param name - instance name (validated by {@link isInstanceName}).
 * @returns the absolute path, or null when the name is not usable.
 */
export function instanceEnvPath(projectRoot: string, name: unknown): string | null {
	if (!isInstanceName(name)) return null;
	return join(projectRoot, ".sdd", "instances", `${name}.env`);
}

/** Directory holding the named instances of one project. */
function instancesDir(projectRoot: string): string {
	return join(projectRoot, ".sdd", "instances");
}

/** File recording which instance the PROJECT last worked against. */
function activeInstanceFile(projectRoot: string): string {
	return join(instancesDir(projectRoot), "active.json");
}

/**
 * File recording which instance ONE session works against.
 *
 * The project file alone was the bug: it is rewritten by every session, so two
 * chats on one project could not use two environments — the last `use` decided
 * for everyone, and a session that had chosen `farmago` was silently pointed at
 * whatever another session picked. The spec pointer was scoped per session for
 * exactly this reason; this one was left behind.
 */
function sessionInstanceFile(projectRoot: string, sessionId: string | undefined): string {
	return sessionInstancePath(projectRoot, sessionId);
}

/**
 * Absolute path of one session's environment pointer.
 *
 * Exported for reporting and for tests: the sanitizer is applied HERE, so a
 * caller cannot build an escaping path by forgetting to check the identifier.
 * @param projectRoot - workspace root.
 * @param sessionId - the session, when it has one.
 * @returns the pointer path (always inside `.sdd/instances/`).
 */
export function sessionInstancePath(projectRoot: string, sessionId: string | undefined): string {
	return join(instancesDir(projectRoot), `active-${sessionFileKey(sessionId)}.json`);
}

/** The instance THIS session works against, when it chose one. */
export function readSessionInstance(projectRoot: string, sessionId: string | undefined): string | null {
	return readInstanceNameFile(sessionInstanceFile(projectRoot, sessionId));
}

/**
 * Record the session's instance, and keep the project's "last used" in step.
 *
 * The project file stays because a NEW session has to inherit somewhere: the last
 * environment someone worked in is a better starting point than the legacy
 * `.env`. It is a default, not an authority — a session that chooses overrides it.
 * @param projectRoot - workspace root.
 * @param sessionId - the writing session.
 * @param name - the instance to activate (validated by the path builder).
 * @returns true when the session pointer was written.
 */
export function writeSessionInstance(projectRoot: string, sessionId: string | undefined, name: string): boolean {
	if (instanceEnvPath(projectRoot, name) === null) return false;
	const payload = JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2) + "\n";
	let ok = false;
	try {
		const dir = instancesDir(projectRoot);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	} catch {
		// best effort: the write below reports the real failure
	}
	try {
		writeFileSync(sessionInstanceFile(projectRoot, sessionId), payload, { mode: 0o600 });
		ok = true;
	} catch {
		ok = false;
	}
	try {
		writeFileSync(activeInstanceFile(projectRoot), payload, { mode: 0o600 });
	} catch {
		// the project default is a convenience: losing it must not fail the session
	}
	return ok;
}

/** Read a `{ name }` pointer file, tolerating absence and corruption. */
function readInstanceNameFile(file: string): string | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown };
		return isInstanceName(raw.name) ? raw.name : null;
	} catch {
		return null;
	}
}

/** Drop ONE session's instance pointer (the project default is left alone). */
export function clearSessionInstance(projectRoot: string, sessionId: string | undefined): void {
	try {
		rmSync(sessionInstanceFile(projectRoot, sessionId), { force: true });
	} catch {
		// an absent pointer is a valid state
	}
}

/** The instance the PROJECT last worked against, when one was chosen. */
export function readActiveInstance(projectRoot: string): string | null {
	return readInstanceNameFile(activeInstanceFile(projectRoot));
}

/**
 * Record the active instance. The name is validated by the path builder, so an
 * unusable name simply cannot be written.
 * @param projectRoot - workspace root.
 * @param name - instance to activate.
 * @returns true when it was recorded.
 */
export function writeActiveInstance(projectRoot: string, name: string): boolean {
	const target = instancesDir(projectRoot);
	if (instanceEnvPath(projectRoot, name) === null) return false;
	try {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
	} catch {
		// best effort: the file write below reports the real failure
	}
	try {
		writeFileSync(
			activeInstanceFile(projectRoot),
			JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2) + "\n",
			{ mode: 0o600 },
		);
		return true;
	} catch {
		return false;
	}
}

/** Drop the active-instance pointer (used when the active file disappears). */
export function clearActiveInstance(projectRoot: string): void {
	try {
		rmSync(activeInstanceFile(projectRoot), { force: true });
	} catch {
		// nothing to report: an absent pointer is a valid state
	}
}

/**
 * Delete one named instance, releasing the pointer when it was the active one.
 *
 * Only the NAMED instance file is touched: the legacy `<root>/.sdd/.env` and the
 * user-scope file are refused by the caller, because deleting the only target a
 * project has is not a side effect this function may have.
 * @param projectRoot - workspace root.
 * @param name - instance to delete (validated here).
 * @returns true when it is gone (or was already).
 */
export function removeInstance(projectRoot: string, name: string): boolean {
	const path = instanceEnvPath(projectRoot, name);
	if (path === null) return false;
	try {
		rmSync(path, { force: true });
	} catch {
		return false;
	}
	if (readActiveInstance(projectRoot) === name) clearActiveInstance(projectRoot);
	return true;
}

/** One instance a project can target, WITHOUT its secret. */
export interface InstanceSummary {
	name: string;
	/** Absolute path of its .env file (the secret stays inside it). */
	path: string;
	/** Declared URL, or null when the file is unreadable/incomplete. */
	url: string | null;
	/** Declared database, or null. */
	db: string | null;
	/** Declared login, or null. */
	username: string | null;
	/** Declared environment (dev/staging/production), or null. */
	environment: TargetEnvironment | null;
	/** True when the file could be parsed as KEY=VALUE pairs. */
	readable: boolean;
	/** True when the legacy `<root>/.sdd/.env` produced this entry. */
	legacy: boolean;
	/** Whether the file is owner-only enough to be trusted (0600-ish). */
	secure: boolean;
}

/**
 * Enumerate the instances of one project.
 *
 * Only NON-SECRET fields are projected: the secret is read by
 * {@link loadCredentials} at call time and never leaves the file. A file that
 * cannot be parsed is still LISTED (with `readable: false`) so a broken instance
 * is visible instead of missing.
 * @param projectRoot - workspace root.
 * @returns the instances, sorted by name, with the legacy file as `default`.
 */
export function listInstances(projectRoot: string): InstanceSummary[] {
	const out: InstanceSummary[] = [];
	const dir = instancesDir(projectRoot);
	let names: string[] = [];
	try {
		names = readdirSync(dir)
			.filter((entry) => entry.endsWith(".env"))
			.map((entry) => entry.slice(0, -".env".length))
			.filter((name) => isInstanceName(name))
			.sort();
	} catch {
		names = [];
	}
	for (const name of names) {
		const path = join(dir, `${name}.env`);
		out.push(summarizeInstance(name, path, false));
	}
	// The legacy single-file layout, presented as an instance named `default` so it
	// is visible and can be adopted deliberately (never moved behind your back).
	const legacyPath = join(projectRoot, ".sdd", ".env");
	if (existsSync(legacyPath) && !names.includes("default")) {
		out.push(summarizeInstance("default", legacyPath, true));
	}
	return out;
}

/**
 * Whether a file is already owner-only, WITHOUT touching it.
 *
 * `ensureSecurePermissions()` is a fixer (it chmods), which is right when the
 * plugin is about to READ a secret and wrong when it is merely listing: a
 * listing must not silently rewrite the permissions of every instance file.
 * @param path - file to inspect.
 * @returns "owner-only", "too-open" or "unknown" (platform without mode bits).
 */
function permissionState(path: string): "owner-only" | "too-open" | "unknown" {
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) === 0) return "owner-only";
		// Windows and FAT-like volumes cannot express POSIX bits; a chmod there
		// neither fixes nor proves anything, so this is reported as unknown.
		return process.platform === "win32" ? "unknown" : "too-open";
	} catch {
		return "unknown";
	}
}

/** Read one instance file into its non-secret summary. */
function summarizeInstance(name: string, path: string, legacy: boolean): InstanceSummary {
	const readable = permissionState(path) !== "too-open";
	let pairs: Record<string, string> | null = null;
	try {
		pairs = parseEnv(readFileSync(path, "utf8"));
	} catch {
		pairs = null;
	}
	const get = (key: string): string | null => {
		const raw = pairs?.[key];
		return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
	};
	return {
		name,
		path,
		url: get("ODOO_URL"),
		db: get("ODOO_DB"),
		username: get("ODOO_USERNAME"),
		environment: parseEnvironment(pairs?.["ODOO_SDD_ENVIRONMENT"]),
		readable: pairs !== null,
		legacy,
		secure: readable,
	};
}

/**
 * Where a setup flow should write a new .env for the requested scope.
 * @param scope - "user" (shared across projects, the generic default) or
 *   "project" (isolated per workspace, under the plugin-owned .sdd/ dir).
 * @param projectRoot - workspace root for project-scoped paths.
 * @param instance - when given (project scope), the named instance file under
 *   `.sdd/instances/`; omitted keeps the historical single-file location.
 */
export function targetEnvPath(scope: "project" | "user", projectRoot: string, instance?: string): string {
	if (scope === "user") return join(userConfigDir(), ".env");
	if (instance !== undefined) {
		return instanceEnvPath(projectRoot, instance) ?? join(projectRoot, ".sdd", ".env");
	}
	return join(projectRoot, ".sdd", ".env");
}

/**
 * Validate and normalize an instance URL. Enforces the transport guard:
 * http:// is only acceptable for loopback hosts; everything else must be
 * https:// (a remote http target would ship the API key in clear text).
 * @param raw - the URL as typed by the developer.
 * @returns the normalized URL or a machine-readable rejection reason.
 */
export function parseInstanceUrl(
	raw: string,
): { ok: true; url: string } | { ok: false; reason: "invalid_url" | "insecure_url"; message: string } {
	let url: URL;
	try {
		url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
	} catch {
		return {
			ok: false,
			reason: "invalid_url",
			message:
				`"${scrubGeneric(raw)}" is not a valid http(s) URL ` +
				"(example: http://localhost:8069).",
		};
	}
	if (url.protocol === "http:" && !isLoopback(url.hostname)) {
		return {
			ok: false,
			reason: "insecure_url",
			message:
				`http:// to the non-loopback host "${url.hostname}" is refused: ` +
				"the credential would travel in clear text. Use https:// (or keep " +
				"http only for localhost).",
		};
	}
	return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, "") };
}

/** Outcome of the .env permission check. */
export interface PermissionCheck {
	/**
	 * True when the file is verifiably owner-only, or when the filesystem
	 * does not implement POSIX permission bits at all (Windows, FAT/exFAT,
	 * some network mounts) — in that case there is nothing to enforce and
	 * refusing to work would be dishonest, not safe.
	 */
	enforced: boolean;
	/** Offending mode (octal string) when the bits are loose AND adjustable. */
	problem: string | null;
	/** Non-blocking explanation when the bits cannot be enforced here. */
	note?: string;
}

/** Note surfaced when the host filesystem cannot express owner-only modes. */
export const POSIX_MODE_NOTE =
	"POSIX file permissions are not enforceable on this filesystem, so the " +
	".env could not be verified as owner-only. Keep it inside a user profile " +
	"directory and out of any synchronized or shared folder.";

/**
 * Verify the .env file is only readable by its owner (mode <= 0600).
 * When the mode is looser, tighten it automatically and re-verify: a chmod
 * that "succeeds" but leaves the bits open (Windows, FAT/exFAT, some network
 * or container mounts) must be reported as NOT enforced rather than assumed
 * fixed. Fail-closed is kept exactly where it is real — a genuine POSIX
 * filesystem where the mode stays loose and cannot be tightened.
 * @param envFile - absolute path of the credential file.
 * @returns the verified permission outcome.
 */
export function ensureSecurePermissions(envFile: string): PermissionCheck {
	let mode: number;
	try {
		mode = statSync(envFile).mode & 0o777;
	} catch {
		return { enforced: true, problem: null }; // missing file is handled elsewhere
	}
	if ((mode & 0o077) === 0) return { enforced: true, problem: null };
	const octal = `0${mode.toString(8)}`;
	let chmodError = false;
	try {
		chmodSync(envFile, 0o600);
	} catch {
		chmodError = true;
	}
	if (!chmodError) {
		// Re-stat: the call returning without throwing is not proof of effect.
		let after: number;
		try {
			after = statSync(envFile).mode & 0o777;
		} catch {
			return { enforced: false, problem: null, note: POSIX_MODE_NOTE };
		}
		if ((after & 0o077) === 0) return { enforced: true, problem: null };
		// chmod reported success yet the bits are still open: the filesystem
		// does not implement them (Windows, FAT/exFAT, some bind mounts).
		return { enforced: false, problem: null, note: POSIX_MODE_NOTE };
	}
	if (process.platform === "win32") {
		// chmod threw on Windows: Node only emulates a read-only flag there,
		// so a throw means "this volume has no mode support", not a leak we
		// could have fixed.
		return { enforced: false, problem: null, note: POSIX_MODE_NOTE };
	}
	return { enforced: false, problem: octal };
}

/** Minimal KEY=VALUE .env parser (no interpolation, no multiline, strips quotes). */
function parseEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/**
 * Load and validate Odoo credentials from the developer's .env file,
 * resolving its location through the cascade. Fail-closed: any problem
 * returns a structured report with remediation instructions and NO secret
 * material.
 * @param projectRoot - workspace root used for project-scoped locations.
 * @returns the loaded credentials or a structured problem report.
 */
export function loadCredentials(
	projectRoot: string,
	options: { sessionId?: string; instance?: string; adoptProjectHint?: boolean; requireChoice?: boolean } = {},
): CredentialsResult {
	// Several instances and none chosen: refuse BEFORE picking one. Choosing by
	// order here would aim the pipeline at a target nobody selected, which is the
	// most expensive kind of guess this plugin can make. A target named explicitly
	// (or chosen by this session) is not ambiguous — it IS the choice.
	// A session that has not chosen is ASKED, not given a default. Inheriting the
	// project's last-used environment is convenient exactly once and dangerous
	// afterwards: another session switching targets would silently redirect this
	// one, and the tool answers would still just say "OK".
	// `requireInstanceChoice=false` restores the inheritance for whoever prefers it.
	const mustChoose = options.requireChoice !== false;
	const choices = options.instance !== undefined ? [] : instancesToChoose(projectRoot, options.sessionId);
	if (mustChoose && choices.length > 0) {
		return {
			ok: false,
			reason: "needs_instance",
			envFile: targetEnvPath("project", projectRoot, choices[0]!.name),
			message: describeInstanceChoice(projectRoot, choices),
		};
	}
	// With the choice waived, several instances and none active is still refused:
	// that one IS ambiguous, and picking by order would aim the pipeline at a
	// target nobody selected.
	const ambiguous =
		options.instance !== undefined || readSessionInstance(projectRoot, options.sessionId) !== null
			? []
			: ambiguousInstances(projectRoot);
	if (ambiguous.length > 0) {
		const suggested = targetEnvPath("project", projectRoot, ambiguous[0]!);
		return {
			ok: false,
			reason: "needs_instance",
			envFile: suggested,
			message:
				`This project has ${ambiguous.length} Odoo instances and none is active: ` +
				`${ambiguous.join(", ")}. Choose one with ` +
				"`odoo_setup mode=instance instance=use name=<name>` (each target needs its own " +
				"connection grant). Nothing was sent anywhere.",
		};
	}
	const location = resolveCredentialSource(projectRoot, options);
	if (location === null) {
		const suggested = targetEnvPath("user", projectRoot);
		return {
			ok: false,
			reason: "env_file_missing",
			envFile: suggested,
			message:
				"No credential file found in the cascade (.sdd/instances/<name>.env, " +
				`.sdd/.env, ${displayPath(suggested)}, or legacy .env). Run the odoo_setup ` +
				"tool (mode=interactive for the single-target layout, mode=instance " +
				"instance=add to create a named target) to scaffold one, or ask the developer " +
				"to create it from .env.example. Never ask for these values through chat.",
		};
	}
	const envFile = location.path;
	const permission = ensureSecurePermissions(envFile);
	if (permission.problem !== null) {
		return {
			ok: false,
			reason: "env_file_insecure",
			envFile,
			message:
				`Refusing to load ${displayPath(envFile)}: file mode ${permission.problem} is readable ` +
				"by group/others and could not be tightened. Ask the developer to " +
				"run: chmod 600 " + displayPath(envFile),
		};
	}
	const vars = parseEnv(readFileSync(envFile, "utf8"));
	const secret = resolveSecret(vars);
	// The secret has two accepted names, so it is reported as a choice rather than
	// as one variable: telling a developer their API key file lacks
	// "ODOO_PASSWORD" is what sent them looking for a password they never had.
	const missing = [
		...REQUIRED_VARS.filter((name) => (vars[name] ?? "").trim() === ""),
		...(secret === null ? [`${SECRET_VARS.join(" or ")}`] : []),
	];
	if (missing.length > 0) {
		return {
			ok: false,
			reason: "required_var_missing",
			envFile,
			message:
				`Missing required variable(s) in ${displayPath(envFile)}: ${missing.join(", ")}. ` +
				`The secret may be named ${SECRET_VARS[0]} (password) OR ${SECRET_VARS[1]} (API key; ` +
				"recommended, since Odoo accepts it wherever a password is accepted over RPC). " +
				"Ask the developer to complete the file directly (see " +
				".env.example). Do not request secret values through chat.",
		};
	}
	const parsed = parseInstanceUrl(vars["ODOO_URL"]!);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: parsed.reason,
			envFile,
			message: `Invalid ODOO_URL in ${displayPath(envFile)}: ${parsed.message}`,
		};
	}
	// The declared environment is never guessed: an unrecognized value is a
	// CONFIGURATION problem (someone meant production and typed "prod1"), so it is
	// reported instead of being read as "undeclared".
	const declaredEnv = (vars["ODOO_SDD_ENVIRONMENT"] ?? "").trim();
	const environment = parseEnvironment(declaredEnv);
	if (declaredEnv !== "" && environment === null) {
		return {
			ok: false,
			reason: "invalid_environment",
			envFile,
			message:
				`ODOO_SDD_ENVIRONMENT="${declaredEnv}" is not recognized in ${displayPath(envFile)}. ` +
				`Use one of: ${TARGET_ENVIRONMENTS.join(", ")} (or remove the line to leave it undeclared).`,
		};
	}
	return {
		ok: true,
		credentials: {
			url: parsed.url,
			db: vars["ODOO_DB"]!.trim(),
			username: vars["ODOO_USERNAME"]!.trim(),
			secret: secret!.value,
			secretKind: secret!.kind,
			envFile,
			source: location.source,
			...(location.instance === undefined ? {} : { instance: location.instance }),
			...(environment === null ? {} : { environment }),
		},
		...(permission.enforced ? {} : { permissionNote: permission.note ?? POSIX_MODE_NOTE }),
		...(secret!.note === undefined ? {} : { credentialNote: secret!.note }),
		...(location.source !== "instance-inherited" || location.instance === undefined
			? {}
			: {
					sourceNote:
						`environment "${location.instance}" was INHERITED from the project's last choice; this session ` +
						`had not picked one. Choose your own with \`odoo_setup mode=instance instance=use name=<name>\` — ` +
						"sessions no longer share the pointer.",
				}),
	};
}

/**
 * Redact any occurrence of the secret (and common credential URL shapes)
 * from a string before it may be logged, rendered, or returned to the model.
 * @param text - untrusted text that may embed secret material.
 * @param credentials - the credentials whose secret must never leak.
 * @returns the sanitized text.
 */
export function redact(text: string, credentials: OdooCredentials): string {
	let out = text;
	if (credentials.secret !== "") {
		out = out.split(credentials.secret).join("***REDACTED***");
	}
	// user:pass@host shapes inside URLs
	out = out.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@");
	return out;
}

/**
 * Safe, non-secret description of the current configuration, suitable for
 * tool output and logs.
 * @param credentials - loaded credentials.
 * @returns a display string with the secret masked.
 */
export function describeCredentials(credentials: OdooCredentials): string {
	const legacyNote =
		credentials.source === "legacy"
			? " — legacy location; consider moving it to " +
				displayPath(targetEnvPath("user", ""))
			: "";
	const environment =
		credentials.environment === undefined
			? " environment=UNDECLARED (the functional executor will refuse to apply batches)"
			: ` environment=${credentials.environment}`;
	const instanceNote = credentials.instance === undefined ? "" : ` instance=${credentials.instance}`;
	// The NAME the secret was declared under is not a secret, and it answers the
	// first question a failed web session raises ("is this an API key?").
	const kindNote = credentials.secretKind === undefined ? "" : ` secretKind=${credentials.secretKind}`;
	return (
		`url=${credentials.url} db=${credentials.db} user=${credentials.username} ` +
		`secret=***masked*** (source: ${credentials.source}${instanceNote}${kindNote}, file: ` +
		displayPath(credentials.envFile) + ")" + legacyNote + environment
	);
}
