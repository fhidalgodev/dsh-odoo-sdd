/**
 * JSON-RPC client for an EXISTING Odoo instance.
 *
 * The plugin never starts Docker containers or odoo-bin processes: the
 * developer supplies the URL and credentials of a running instance (see
 * credentials.ts), and this module talks to it over the standard Odoo
 * JSON-RPC endpoints:
 *   - POST /jsonrpc                     (common service: version, authenticate,
 *                                        object service: execute_kw)
 *   - POST /web/session/authenticate    (session cookie minting for UI tests)
 *
 * All returned text passes through the redaction helper before leaving this
 * module, so tracebacks or payloads that accidentally embed the secret are
 * sanitized.
 *
 * @module dsh-odoo-sdd/odoo-client
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OdooCredentials } from "./credentials.js";
import { redact } from "./credentials.js";
import { isJson2Method, planJson2Body } from "./api-transport.js";
import { majorVersion } from "./import-capabilities.js";

/** Timeout for a single JSON-RPC call. Install/upgrade calls are slower. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MODULE_OP_TIMEOUT_MS = 300_000;

/**
 * Why a call failed, when that is knowable.
 *
 * The distinction is not cosmetic: after a MUTATION, `transport` (the request was
 * sent and no answer came back) may mean the server already committed, so a
 * retry can double-apply. `server` means Odoo answered with an error and the
 * transaction was rolled back. `protocol` means we could not even read the
 * answer. Callers that only mutate must treat `transport`/`protocol` as
 * INDETERMINATE, never as a plain failure.
 */
export type RpcErrorKind = "transport" | "server" | "protocol";

/** Result of a JSON-RPC call: either the payload or a sanitized error. */
export type RpcResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; errorKind?: RpcErrorKind };

/**
 * Transport policy for model calls.
 *
 * - `auto` (default): use JSON-2 where the server offers it, fall back silently
 *   to classic JSON-RPC when it does not.
 * - `json2`: pinned. A missing route is REPORTED, never papered over — an
 *   operator who pinned a transport wants to know it is not there.
 * - `jsonrpc`: pinned to the classic transport (works on every version).
 */
export type ApiPreference = "auto" | "json2" | "jsonrpc";

/** First Odoo major that exposes `POST /json/2/<model>/<method>`. */
export const JSON2_MIN_MAJOR = 19;

/** Options for {@link OdooClient}. */
export interface OdooClientOptions {
	/** Transport policy; defaults to `auto`. */
	api?: ApiPreference;
}

/** Odoo server version info returned by `common.version`. */
export interface ServerVersion {
	server_version: string;
	server_serie: string;
	protocol_version: number;
}

/** Lifecycle state of an addon module as stored in ir.module.module. */
export type ModuleState = "uninstalled" | "to install" | "installed" | "to upgrade" | "to remove" | "unknown";

/** One module row projected from ir.module.module. */
export interface ModuleInfo {
	id: number;
	name: string;
	state: ModuleState;
	latest_version: string | null;
}

/** One server log row projected from ir.logging. */
export interface LogEntry {
	id: number;
	create_date: string;
	level: string;
	type: string;
	name: string;
	message: string;
	path: string | null;
	line: string | null;
	func: string | null;
}

interface JsonRpcEnvelope {
	jsonrpc: string;
	method: string;
	params: Record<string, unknown>;
	id: string;
}

/** Outcome of a low-level RPC call; headers are kept on both branches. */
type RpcOutcome<T> =
	| { ok: true; value: T; headers: Headers }
	| { ok: false; error: string; errorKind?: RpcErrorKind; headers: Headers | null };

/** Client bound to one instance + database. Secret material stays private. */
export class OdooClient {
	#credentials: OdooCredentials;
	#uid: number | null = null;
	#api: ApiPreference;
	/**
	 * Whether the JSON-2 route answered. `unknown` until a call tries it, so the
	 * very first eligible call decides with evidence instead of a guess — and a
	 * server that does not have the route costs ONE wasted request, once.
	 */
	#json2: "unknown" | "available" | "unavailable" = "unknown";
	/** Why JSON-2 was dropped, so the report explains instead of shrugging. */
	#json2Why: string | null = null;
	/**
	 * Major version of the server, once something asked for it (`version()` is
	 * called by `odoo_connect`). Left null otherwise: this class never spends a
	 * request just to learn a number it can discover by trying.
	 */
	#serverMajor: number | null = null;

	constructor(credentials: OdooCredentials, options: OdooClientOptions = {}) {
		this.#credentials = credentials;
		this.#api = options.api ?? "auto";
	}

	/**
	 * The JSON-2 body for this call, or null to stay on the classic transport.
	 * @param method - the model method name.
	 * @param args - positional arguments as the classic transport would send them.
	 * @param kwargs - keyword arguments as the classic transport would send them.
	 * @returns the named body, or null when JSON-2 must not be used.
	 */
	#planJson2(method: string, args: unknown[], kwargs: Record<string, unknown>): Record<string, unknown> | null {
		if (this.#api === "jsonrpc") return null;
		if (this.#json2 === "unavailable") return null;
		if (!isJson2Method(method)) return null;
		// A version we OBSERVED below the floor means the route cannot be there. It
		// is a hint, not a rule: `json2` pinned still tries, because a backport or a
		// custom build is the operator's call to make.
		if (this.#api !== "json2" && this.#serverMajor !== null && this.#serverMajor < JSON2_MIN_MAJOR) return null;
		return planJson2Body(method, args, kwargs);
	}

	/**
	 * Major version of the server, once it is known.
	 *
	 * Null until something asks (`version()`, which `odoo_connect` calls): the
	 * version-dependent rules are written so that "unknown" means "do not invent a
	 * restriction", never "assume the newest".
	 */
	get serverMajor(): number | null {
		return this.#serverMajor;
	}

	/** Transport this client is actually using, and why. */
	get transport(): { api: "json2" | "jsonrpc"; preference: ApiPreference; reason: string } {
		if (this.#api === "jsonrpc") {
			return { api: "jsonrpc", preference: this.#api, reason: "pinned by odooApi=jsonrpc" };
		}
		if (this.#json2 === "available") {
			return { api: "json2", preference: this.#api, reason: "the server answered POST /json/2" };
		}
		if (this.#json2 === "unavailable") {
			return { api: "jsonrpc", preference: this.#api, reason: this.#json2Why ?? "no /json/2 route on this server" };
		}
		return {
			api: "jsonrpc",
			preference: this.#api,
			reason:
				this.#serverMajor === null
					? "not exercised yet"
					: `server ${this.#serverMajor}${this.#serverMajor < JSON2_MIN_MAJOR ? " predates /json/2" : ""}`,
		};
	}

	/** Non-secret identity of the target instance, safe for logs. */
	get target(): string {
		return `${this.#credentials.url} db=${this.#credentials.db} user=${this.#credentials.username}`;
	}

	/** Low-level JSON-RPC POST with timeout, caller cancellation and redaction. */
	async #rpc<T>(
		path: string,
		body: JsonRpcEnvelope | Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		callerSignal?: AbortSignal,
	): Promise<RpcOutcome<T>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		// Forward the host's cancellation: when the caller aborts (turn
		// cancelled, disposal), the in-flight request must settle instead of
		// running to completion. `AbortSignal.any` keeps the timeout too.
		const signal =
			callerSignal === undefined
				? controller.signal
				: typeof AbortSignal.any === "function"
					? AbortSignal.any([controller.signal, callerSignal])
					: controller.signal;
		const onCallerAbort = (): void => controller.abort();
		if (callerSignal !== undefined) {
			if (callerSignal.aborted) controller.abort();
			else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
		}
		try {
			const response = await fetch(this.#credentials.url + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
				// Never follow redirects, which could re-send an authenticated
				// JSON-RPC body to an unintended host (307/308 preserve it).
				redirect: "error",
			});
			const text = await response.text();
			const sanitized = redact(text, this.#credentials);
			if (!response.ok) {
				return {
					ok: false,
					error: `HTTP ${response.status}: ${sanitized.slice(0, 4000)}`,
					errorKind: "server",
					headers: response.headers,
				};
			}
			let payload: { result?: T; error?: { data?: { message?: string; debug?: string }; message?: string } };
			try {
				payload = JSON.parse(sanitized) as typeof payload;
			} catch {
				return {
					ok: false,
					error: `Non-JSON response: ${sanitized.slice(0, 2000)}`,
					errorKind: "protocol",
					headers: response.headers,
				};
			}
			if (payload.error) {
				const data = payload.error.data;
				const detail = data?.debug ?? data?.message ?? payload.error.message ?? "unknown error";
				return {
					ok: false,
					error: String(detail).slice(0, 8000),
					errorKind: "server",
					headers: response.headers,
				};
			}
			return { ok: true, value: payload.result as T, headers: response.headers };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// The request may or may not have reached the server: nothing about the
			// outcome is knowable from here.
			return {
				ok: false,
				error: redact(`Request failed: ${message}`, this.#credentials),
				errorKind: "transport",
				headers: null,
			};
		} finally {
			clearTimeout(timer);
			if (callerSignal !== undefined) callerSignal.removeEventListener("abort", onCallerAbort);
		}
	}

	/** Query the server version without authenticating (connectivity probe). */
	async version(): Promise<RpcResult<ServerVersion>> {
		const res = await this.#rpc<ServerVersion>("/jsonrpc", {
			jsonrpc: "2.0",
			method: "call",
			params: { service: "common", method: "version", args: [] },
			id: randomUUID(),
		});
		if (res.ok && typeof res.value?.server_version === "string") {
			// Free evidence: this is the one place the version arrives unsolicited.
			this.#serverMajor = majorVersion(res.value.server_version);
		}
		return res.ok ? { ok: true, value: res.value } : { ok: false, error: res.error };
	}

	/**
	 * Authenticate and cache the uid. Uses the .env secret (password or API
	 * key). A failure is reported WITHOUT echoing the secret.
	 */
	async authenticate(): Promise<RpcResult<{ uid: number }>> {
		const res = await this.#rpc<number>("/jsonrpc", {
			jsonrpc: "2.0",
			method: "call",
			params: {
				service: "common",
				method: "authenticate",
				args: [
					this.#credentials.db,
					this.#credentials.username,
					this.#credentials.secret,
					{},
				],
			},
			id: randomUUID(),
		});
		if (!res.ok) return { ok: false, error: res.error };
		if (typeof res.value !== "number" || res.value === 0) {
			return {
				ok: false,
				error:
					"Authentication rejected (uid=0): wrong database, username, or " +
					"secret, or the user is archived. Verify the .env values — do " +
					"not paste them in chat.",
			};
		}
		this.#uid = res.value;
		return { ok: true, value: { uid: res.value } };
	}

	/** Ensure an authenticated uid, authenticating lazily on first use. */
	async #ensureUid(): Promise<RpcResult<number>> {
		if (this.#uid !== null) return { ok: true, value: this.#uid };
		const auth = await this.authenticate();
		return auth.ok ? { ok: true, value: auth.value.uid } : auth;
	}

	/**
	 * Call a model method through the JSON-2 API (`POST /json/2/<model>/<method>`).
	 *
	 * Differences from the classic transport that this method owns:
	 * - the credential travels as `Authorization: Bearer`, so `db`/`uid`/`password`
	 *   never appear in the body and no `authenticate` round-trip is needed;
	 * - the body carries NAMED parameters (validated by the controller with
	 *   `signature.bind`), never positionals;
	 * - errors arrive as an HTTP status plus `{name, message, arguments, context,
	 *   debug}`, so the classification comes from the status instead of a JSON-RPC
	 *   envelope. A 4xx/5xx means Odoo answered and rolled the transaction back,
	 *   which is a DEFINITE failure — only a missing answer is indeterminate.
	 * @param model - Odoo model name.
	 * @param method - public method name.
	 * @param body - the named parameters plus optional `ids`/`context`.
	 * @param timeoutMs - request timeout.
	 * @param callerSignal - the caller's cancellation signal.
	 * @returns the value, a classified failure, or `fallback` when the route is absent.
	 */
	async #rpcJson2<T>(
		model: string,
		method: string,
		body: Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		callerSignal?: AbortSignal,
	): Promise<{ ok: true; value: T } | { ok: false; error: string; errorKind: RpcErrorKind; fallback?: true }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const signal =
			callerSignal === undefined
				? controller.signal
				: typeof AbortSignal.any === "function"
					? AbortSignal.any([controller.signal, callerSignal])
					: controller.signal;
		const onCallerAbort = (): void => controller.abort();
		if (callerSignal !== undefined) {
			if (callerSignal.aborted) controller.abort();
			else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
		}
		// The model and method are path segments: encode them so a name can never
		// rewrite the route it is addressed to.
		const path = `/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
		try {
			const response = await fetch(this.#credentials.url + path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// The one place the secret touches the wire on this transport. It is
					// never logged: `redact()` also scrubs `Bearer <token>` shapes.
					Authorization: `Bearer ${this.#credentials.secret}`,
				},
				body: JSON.stringify(body),
				signal,
				redirect: "error",
			});
			const text = await response.text();
			const sanitized = redact(text, this.#credentials);
			if (!response.ok) {
				// Distinguish "this server has no such ROUTE" from "the route answered
				// and refused". Only the former licenses a fallback: falling back on a
				// refusal would re-send a rejected mutation over another transport.
				let named: { name?: unknown; message?: unknown; debug?: unknown } | null = null;
				try {
					const parsed = JSON.parse(sanitized) as unknown;
					if (parsed !== null && typeof parsed === "object" && "name" in parsed) {
						named = parsed as { name?: unknown; message?: unknown; debug?: unknown };
					}
				} catch {
					named = null;
				}
				if (response.status === 404 && named === null) {
					return { ok: false, error: `no /json/2 route (HTTP 404)`, errorKind: "server", fallback: true };
				}
				const detail =
					(typeof named?.message === "string" && named.message) ||
					(typeof named?.debug === "string" && named.debug) ||
					sanitized.slice(0, 4000);
				const who = typeof named?.name === "string" ? `${named.name}: ` : "";
				if (response.status === 401) {
					// 401 is NOT a refusal: it means the request never ran. JSON-2 only
					// accepts an API key, so a target configured with an account PASSWORD
					// fails here on EVERY call — while the classic transport would work
					// with that same credential. Falling back is therefore both safe (no
					// handler executed, so no mutation to double-apply) and necessary.
					return {
						ok: false,
						error:
							`${who}${detail} — the JSON-2 API authenticates with an API key sent as ` +
							"`Authorization: Bearer` (Settings > Users > API Keys), so a password cannot be used on it",
						errorKind: "server",
						fallback: true,
					};
				}
				return { ok: false, error: `HTTP ${response.status}: ${who}${detail}`, errorKind: "server" };
			}
			try {
				return { ok: true, value: JSON.parse(sanitized) as T };
			} catch {
				// A 200 that is not JSON (a login page, a proxy notice) proves nothing
				// about what the server did.
				return { ok: false, error: `Non-JSON response: ${sanitized.slice(0, 2000)}`, errorKind: "protocol" };
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: redact(`Request failed: ${message}`, this.#credentials),
				errorKind: "transport",
			};
		} finally {
			clearTimeout(timer);
			if (callerSignal !== undefined) callerSignal.removeEventListener("abort", onCallerAbort);
		}
	}

	/** Call a model method through the object service (execute_kw). */
	async executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs: Record<string, unknown> = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<RpcResult<T>> {
		// ---- transport selection ---------------------------------------------
		// JSON-2 first when it is both allowed and expressible. `planJson2Body`
		// returns null for anything whose parameter names this plugin does not own
		// (business actions with caller-supplied positionals), and those keep the
		// classic transport: JSON-2 has no positional form, so translating them
		// would mean guessing.
		const body = this.#planJson2(method, args, kwargs);
		if (body !== null) {
			const json2 = await this.#rpcJson2<T>(model, method, body, timeoutMs, signal);
			if (json2.ok) {
				this.#json2 = "available";
				return { ok: true, value: json2.value };
			}
			if (json2.fallback !== true) {
				return { ok: false, error: json2.error, errorKind: json2.errorKind };
			}
			this.#json2 = "unavailable";
			this.#json2Why = json2.error;
			if (this.#api === "json2") {
				// Pinned by the operator: a silent downgrade would hide exactly what
				// they asked to be told.
				return {
					ok: false,
					error:
						`odooApi=json2 is pinned but this server has no POST /json/2 route: ${json2.error}. ` +
						"Set odooApi=auto (or jsonrpc) to use the classic transport.",
					errorKind: "server",
				};
			}
		}
		const uid = await this.#ensureUid();
		if (!uid.ok) return uid;
		const res = await this.#rpc<T>("/jsonrpc", {
			jsonrpc: "2.0",
			method: "call",
			params: {
				service: "object",
				method: "execute_kw",
				args: [this.#credentials.db, uid.value, this.#credentials.secret, model, method, args, kwargs],
			},
			id: randomUUID(),
		}, timeoutMs, signal);
		// The CLASSIFICATION travels with the failure, not just its message.
		// Dropping it here is what made every consumer below decide "plain
		// failure" for a mutation whose answer never came: `isIndeterminateFor()`
		// reads `errorKind`, and a retry of something the server may already have
		// committed is the one move that must not look safe.
		return res.ok ? { ok: true, value: res.value } : { ok: false, error: res.error, errorKind: res.errorKind };
	}

	/** Search ir.module.module by technical name(s) and project lifecycle info. */
	async moduleInfo(names: string[]): Promise<RpcResult<ModuleInfo[]>> {
		const res = await this.executeKw<Array<Record<string, unknown>>>("ir.module.module", "search_read", [
			[["name", "in", names]],
		], { fields: ["name", "state", "latest_version"], limit: Math.max(names.length, 1) });
		if (!res.ok) return res;
		return {
			ok: true,
			value: res.value.map((row) => ({
				id: Number(row["id"]),
				name: String(row["name"]),
				state: (row["state"] as ModuleState) ?? "unknown",
				latest_version: row["latest_version"] == null ? null : String(row["latest_version"]),
			})),
		};
	}

	/**
	 * Install modules by technical name (button_immediate_install). Blocks
	 * until the registry is reloaded; returns Odoo's own success output or
	 * the sanitized traceback — this is the closed feedback loop.
	 */
	async installModules(names: string[]): Promise<RpcResult<{ modules: ModuleInfo[]; output: string }>> {
		return this.#moduleAction(names, "button_immediate_install");
	}

	/** Upgrade modules by technical name (button_immediate_upgrade). */
	async upgradeModules(names: string[]): Promise<RpcResult<{ modules: ModuleInfo[]; output: string }>> {
		return this.#moduleAction(names, "button_immediate_upgrade");
	}

	/** Shared implementation of install/upgrade with a long timeout. */
	async #moduleAction(
		names: string[],
		method: "button_immediate_install" | "button_immediate_upgrade",
	): Promise<RpcResult<{ modules: ModuleInfo[]; output: string }>> {
		const found = await this.moduleInfo(names);
		if (!found.ok) return found;
		const missing = names.filter((n) => !found.value.some((m) => m.name === n));
		if (missing.length > 0) {
			return {
				ok: false,
				error:
					`Module(s) not found in the addons path of the instance: ` +
					`${missing.join(", ")}. The server cannot see the code yet — ` +
					"verify the addons path / deployment of the target instance.",
			};
		}
		const ids = found.value.map((m) => m.id);
		const res = await this.executeKw<unknown>("ir.module.module", method, [ids], {}, MODULE_OP_TIMEOUT_MS);
		if (!res.ok) return { ok: false, error: res.error };
		const after = await this.moduleInfo(names);
		if (!after.ok) return after;
		return {
			ok: true,
			value: {
				modules: after.value,
				output: redact(JSON.stringify(res.value ?? null).slice(0, 6000), this.#credentials),
			},
		};
	}

	/**
	 * Fetch recent server-side error logs (ir.logging) — the remote
	 * environment-log reader that closes the feedback loop.
	 */
	async recentErrors(limit = 20, sinceMinutes = 30): Promise<RpcResult<LogEntry[]>> {
		const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
		// `ir.logging.level` is a text column whose encoding varies by version:
		// named severities on recent releases, numeric Python levels on older
		// ones. Matching an explicit membership set covers both, where the old
		// `>= "40"` performed a lexicographic comparison on text.
		const res = await this.executeKw<Array<Record<string, unknown>>>("ir.logging", "search_read", [
			[
				["level", "in", ["ERROR", "CRITICAL", "error", "critical", "40", "50"]],
				["create_date", ">=", since],
			],
		], {
			fields: ["create_date", "level", "type", "name", "message", "path", "line", "func"],
			order: "create_date desc",
			limit,
		});
		if (!res.ok) return res;
		return {
			ok: true,
			value: res.value.map((row) => ({
				id: Number(row["id"]),
				create_date: String(row["create_date"]),
				level: String(row["level"]),
				type: String(row["type"]),
				name: String(row["name"]),
				message: redact(String(row["message"] ?? "").slice(0, 4000), this.#credentials),
				path: row["path"] == null ? null : String(row["path"]),
				line: row["line"] == null ? null : String(row["line"]),
				func: row["func"] == null ? null : String(row["func"]),
			})),
		};
	}

	/**
	 * Mint a passwordless web session (the connect_as_user pattern) and store
	 * the cookie in a chmod-600 runtime file for Playwright/UI tests. The
	 * cookie value itself is NEVER returned to the model — only the file path.
	 * @param projectRoot - workspace root; the cookie lands in .sdd/session.json.
	 * @returns the path of the session file and the authenticated uid.
	 */
	async mintSession(projectRoot: string): Promise<RpcResult<{ sessionFile: string; uid: number }>> {
		// `/web/session/authenticate` goes through `Session.authenticate`, which
		// authenticates with `{'interactive': True}` (odoo/http.py), and
		// `res.users._check_credentials` only consults the API-key table under
		// `if not interactive`. So an API key is REFUSED here by Odoo itself — and
		// when the credential was declared as one, the request is not even sent:
		// there is nothing to learn from a call that cannot succeed.
		if (this.#credentials.secretKind === "api_key") {
			return {
				ok: false,
				error:
					"A web session needs the account PASSWORD, and this target is configured with an API key " +
					"(ODOO_API_KEY): Odoo skips the API-key check for interactive logins, so the request was NOT " +
					"sent. Use an account password for the UI-test path, or create .sdd/session.json by hand. " +
					"The API key keeps working for JSON-RPC and for the JSON-2 API.",
			};
		}
		// NOTE: `/web/session/authenticate` authenticates a WEB session, which
		// expects the account password. An API key (recommended for JSON-RPC)
		// is generally NOT accepted here, so a failure gets an explicit hint
		// instead of an opaque error.
		const webHint =
			" A web session needs the account PASSWORD (or a dedicated service account): Odoo " +
			"authenticates interactive logins with `interactive: True` and only checks the API-key " +
			"table otherwise. The API key keeps working for JSON-RPC (odoo_module/odoo_execute/" +
			"odoo_errors) and for the JSON-2 API. UI tests can also run against a manually created session.";
		const res = await this.#rpc<{ uid: number; session_id?: string }>("/web/session/authenticate", {
			jsonrpc: "2.0",
			method: "call",
			params: {
				db: this.#credentials.db,
				login: this.#credentials.username,
				password: this.#credentials.secret,
			},
			id: randomUUID(),
		});
		if (!res.ok) return { ok: false, error: res.error + webHint };
		if (!res.value || typeof res.value.uid !== "number" || res.value.uid === 0) {
			return { ok: false, error: "Session authentication rejected (uid=0). Check .env values." + webHint };
		}
		// Prefer the real session cookie from Set-Cookie; fall back to the
		// session_id returned in the payload.
		const setCookie = res.headers?.getSetCookie?.() ?? [];
		const cookieHeader = setCookie.find((c) => c.startsWith("session_id=")) ?? null;
		const sessionId =
			cookieHeader?.split(";")[0]?.slice("session_id=".length) ?? res.value.session_id ?? null;
		if (sessionId == null) {
			return { ok: false, error: "Authenticated but no session_id cookie was returned." };
		}
		const sessionFile = join(projectRoot, ".sdd", "session.json");
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			JSON.stringify({ url: this.#credentials.url, db: this.#credentials.db, session_id: sessionId }, null, 2),
			{ mode: 0o600 },
		);
		chmodSync(sessionFile, 0o600);
		return { ok: true, value: { sessionFile, uid: res.value.uid } };
	}
}
