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

/** Timeout for a single JSON-RPC call. Install/upgrade calls are slower. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MODULE_OP_TIMEOUT_MS = 300_000;

/** Result of a JSON-RPC call: either the payload or a sanitized error. */
export type RpcResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

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
	| { ok: false; error: string; headers: Headers | null };

/** Client bound to one instance + database. Secret material stays private. */
export class OdooClient {
	#credentials: OdooCredentials;
	#uid: number | null = null;

	constructor(credentials: OdooCredentials) {
		this.#credentials = credentials;
	}

	/** Non-secret identity of the target instance, safe for logs. */
	get target(): string {
		return `${this.#credentials.url} db=${this.#credentials.db} user=${this.#credentials.username}`;
	}

	/** Low-level JSON-RPC POST with timeout and secret redaction. */
	async #rpc<T>(
		path: string,
		body: JsonRpcEnvelope | Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<RpcOutcome<T>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(this.#credentials.url + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await response.text();
			const sanitized = redact(text, this.#credentials);
			if (!response.ok) {
				return { ok: false, error: `HTTP ${response.status}: ${sanitized.slice(0, 4000)}`, headers: response.headers };
			}
			let payload: { result?: T; error?: { data?: { message?: string; debug?: string }; message?: string } };
			try {
				payload = JSON.parse(sanitized) as typeof payload;
			} catch {
				return { ok: false, error: `Non-JSON response: ${sanitized.slice(0, 2000)}`, headers: response.headers };
			}
			if (payload.error) {
				const data = payload.error.data;
				const detail = data?.debug ?? data?.message ?? payload.error.message ?? "unknown error";
				return { ok: false, error: String(detail).slice(0, 8000), headers: response.headers };
			}
			return { ok: true, value: payload.result as T, headers: response.headers };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: redact(`Request failed: ${message}`, this.#credentials), headers: null };
		} finally {
			clearTimeout(timer);
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

	/** Call a model method through the object service (execute_kw). */
	async executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs: Record<string, unknown> = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<RpcResult<T>> {
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
		}, timeoutMs);
		return res.ok ? { ok: true, value: res.value } : { ok: false, error: res.error };
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
		const res = await this.executeKw<Array<Record<string, unknown>>>("ir.logging", "search_read", [
			[["level", ">=", "40"], ["create_date", ">=", since]],
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
		if (!res.ok) return { ok: false, error: res.error };
		if (!res.value || typeof res.value.uid !== "number" || res.value.uid === 0) {
			return { ok: false, error: "Session authentication rejected (uid=0). Check .env values." };
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
