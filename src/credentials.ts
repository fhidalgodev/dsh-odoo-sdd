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
import { readFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where a resolved credential file came from in the cascade. */
export type CredentialSource = "env-var" | "project" | "user" | "legacy";

/** One concrete credential location in the cascade. */
export interface CredentialLocation {
	/** Absolute path of the candidate .env file. */
	path: string;
	/** Which cascade tier produced it. */
	source: CredentialSource;
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
	/** Absolute path of the .env file the credentials were loaded from. */
	envFile: string;
	/** Cascade tier the .env file was loaded from. */
	source: CredentialSource;
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
		| "insecure_url";
	/** Developer-facing remediation instructions (never contains secrets). */
	message: string;
	/** Path of the .env file that was (or should be) used. */
	envFile: string;
}

export type CredentialsResult =
	| { ok: true; credentials: OdooCredentials }
	| CredentialsProblem;

const REQUIRED_VARS = ["ODOO_URL", "ODOO_DB", "ODOO_USERNAME", "ODOO_PASSWORD"] as const;

/** Hostnames treated as local for transport-security purposes (S1). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "ip6-localhost"]);

/** True when the host is loopback-shaped (explicit list or 127.x / *.localhost). */
function isLoopback(hostname: string): boolean {
	return (
		LOOPBACK_HOSTS.has(hostname) ||
		hostname.startsWith("127.") ||
		hostname.endsWith(".localhost")
	);
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
	let out = text.replace(
		/\b(password|passwd|pwd|secret|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|session[-_]?id|session_id|cookie)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi,
		(_m, key: string, sep: string) => `${key}${sep}***REDACTED***`,
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
export function credentialCandidates(projectRoot: string): CredentialLocation[] {
	const candidates: CredentialLocation[] = [];
	const override = process.env["ODOO_SDD_ENV_FILE"];
	if (override !== undefined && override.trim() !== "") {
		candidates.push({ path: resolve(override.trim()), source: "env-var" });
	}
	candidates.push({ path: join(projectRoot, ".sdd", ".env"), source: "project" });
	candidates.push({ path: join(userConfigDir(), ".env"), source: "user" });
	candidates.push({ path: join(projectRoot, ".env"), source: "legacy" });
	return candidates;
}

/** Resolve the first existing credential source in the cascade, or null. */
export function resolveCredentialSource(projectRoot: string): CredentialLocation | null {
	for (const candidate of credentialCandidates(projectRoot)) {
		if (existsSync(candidate.path)) return candidate;
	}
	return null;
}

/**
 * Where a setup flow should write a new .env for the requested scope.
 * @param scope - "user" (shared across projects, the generic default) or
 *   "project" (isolated per workspace, under the plugin-owned .sdd/ dir).
 * @param projectRoot - workspace root for project-scoped paths.
 */
export function targetEnvPath(scope: "project" | "user", projectRoot: string): string {
	return scope === "user"
		? join(userConfigDir(), ".env")
		: join(projectRoot, ".sdd", ".env");
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

/**
 * Verify the .env file is only readable by its owner (mode <= 0600).
 * When the mode is looser, tighten it automatically and report the fix.
 * @returns null when secure (or fixed), otherwise the offending mode string.
 */
function ensureSecurePermissions(envFile: string): string | null {
	let mode: number;
	try {
		mode = statSync(envFile).mode & 0o777;
	} catch {
		return null; // missing file is handled elsewhere
	}
	if ((mode & 0o077) === 0) return null;
	try {
		chmodSync(envFile, 0o600);
		return null;
	} catch {
		return `0${mode.toString(8)}`;
	}
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
export function loadCredentials(projectRoot: string): CredentialsResult {
	const location = resolveCredentialSource(projectRoot);
	if (location === null) {
		const suggested = targetEnvPath("user", projectRoot);
		return {
			ok: false,
			reason: "env_file_missing",
			envFile: suggested,
			message:
				"No credential file found in the cascade (.sdd/.env, " +
				`${displayPath(suggested)}, or legacy .env). Run the odoo_setup ` +
				"tool (mode=interactive) to scaffold one, or ask the developer to " +
				"create it from .env.example. Never ask for these values through " +
				"chat.",
		};
	}
	const envFile = location.path;
	const insecureMode = ensureSecurePermissions(envFile);
	if (insecureMode !== null) {
		return {
			ok: false,
			reason: "env_file_insecure",
			envFile,
			message:
				`Refusing to load ${displayPath(envFile)}: file mode ${insecureMode} is readable ` +
				"by group/others and could not be tightened. Ask the developer to " +
				"run: chmod 600 " + displayPath(envFile),
		};
	}
	const vars = parseEnv(readFileSync(envFile, "utf8"));
	const missing = REQUIRED_VARS.filter((name) => (vars[name] ?? "").trim() === "");
	if (missing.length > 0) {
		return {
			ok: false,
			reason: "required_var_missing",
			envFile,
			message:
				`Missing required variable(s) in ${displayPath(envFile)}: ${missing.join(", ")}. ` +
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
	return {
		ok: true,
		credentials: {
			url: parsed.url,
			db: vars["ODOO_DB"]!.trim(),
			username: vars["ODOO_USERNAME"]!.trim(),
			secret: vars["ODOO_PASSWORD"]!,
			envFile,
			source: location.source,
		},
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
	return (
		`url=${credentials.url} db=${credentials.db} user=${credentials.username} ` +
		`secret=***masked*** (source: ${credentials.source}, file: ` +
		displayPath(credentials.envFile) + ")" + legacyNote
	);
}
