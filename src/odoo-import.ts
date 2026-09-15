/**
 * `odoo_import` — CSV/XLS/XLSX imports through Odoo's OWN importer.
 *
 * The plugin never parses a spreadsheet: `base_import` does that, and this module
 * drives it. What it owns is the part that decides whether the import is safe:
 *
 *   - the file is uploaded with the WEB session (multipart), not with the API key:
 *     `/base_import/set_file` is a web route, so a session is required and an API
 *     key alone gets `NEEDS_WEB_SESSION` instead of a half-working import;
 *   - the session cookie and the CSRF token stay inside this module: they are read
 *     from the private `.sdd/session.json`, are never returned to the model, and
 *     never reach a log, a spec or an audit entry;
 *   - a JSONP answer is parsed as DATA — a bounded JSON object extracted from the
 *     text — and is never executed;
 *   - the apply call follows the version's own signature (see
 *     `import-capabilities.ts`), and a version outside the verified families is
 *     refused rather than guessed;
 *   - the MUTATION goes through the functional executor like any other batch
 *     operation: nothing here applies an import on its own.
 *
 * @module dsh-odoo-sdd/odoo-import
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	applyArguments,
	importCapabilities,
	knownMajors,
	type ImportCapabilities,
} from "./import-capabilities.js";
import { writeState, isSafeSegment, readPlan } from "./functional.js";

/** The web session of a target, read from the private session file. */
export interface WebSession {
	/** `session_id` cookie value. NEVER log, render or return this. */
	sessionId: string;
	/** Instance URL the session belongs to. */
	url: string;
	/** Database the session belongs to. */
	db: string;
	/** Absolute path of the file it was read from. */
	file: string;
}

/**
 * Read the web session stored by `odoo_session` (mode 0600, gitignored).
 * @param projectRoot - project root owning `.sdd/session.json`.
 * @returns the session, or null when there is none usable.
 */
export function readWebSession(projectRoot: string): WebSession | null {
	const file = join(projectRoot, ".sdd", "session.json");
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; db?: unknown; session_id?: unknown };
		if (typeof parsed.session_id !== "string" || parsed.session_id === "") return null;
		return {
			sessionId: parsed.session_id,
			url: typeof parsed.url === "string" ? parsed.url : "",
			db: typeof parsed.db === "string" ? parsed.db : "",
			file,
		};
	} catch {
		return null;
	}
}

/**
 * Extract the CSRF token from an Odoo web page.
 * @param html - the page body.
 * @returns the token, or null when the page does not carry one.
 */
export function extractCsrfToken(html: string): string | null {
	// Odoo renders `odoo.csrf_token = "…";` (and a meta tag on some versions).
	const patterns = [
		/odoo\.csrf_token\s*=\s*["']([^"']+)["']/,
		/csrf_token["']\s*[:=]\s*["']([^"']+)["']/,
		/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (match !== null && match[1] !== undefined && match[1] !== "") return match[1];
	}
	return null;
}

/**
 * Parse a JSONP-ish body as DATA.
 *
 * Older `base_import` uploads answer a JSON object wrapped in a call. This finds
 * the last balanced `{…}` object in the text and parses it; nothing is evaluated,
 * so a hostile body can at most fail to parse.
 * @param text - the response body.
 * @returns the parsed object, or null when no object could be read.
 */
export function parseJsonpAsData(text: string): unknown | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		// fall through to the brace scanner
	}
	// Every balanced `{…}` is a candidate: a wrapper such as
	// `define("x", function () { return {"id": 9}; })` yields the enclosing function
	// body and the payload inside it, and only the payload is JSON. The outermost
	// candidate wins when it parses, so the whole payload is returned rather than a
	// nested fragment of it.
	const starts: number[] = [];
	const candidates: string[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i += 1) {
		const ch = trimmed[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			starts.push(i);
			continue;
		}
		if (ch === "}") {
			const start = starts.pop();
			if (start === undefined) return null; // a close with no open: not a payload
			candidates.push(trimmed.slice(start, i + 1));
		}
	}
	if (starts.length > 0) return null; // an object was left open: the body is truncated
	for (let i = candidates.length - 1; i >= 0; i -= 1) {
		try {
			return JSON.parse(candidates[i]!) as unknown;
		} catch {
			// not this one: the wrapper is not JSON, keep looking inwards
		}
	}
	return null;
}

/** What the importer reported about one call. */
export interface ImportOutcome {
	/** Rows created. */
	created: number;
	/** Rows updated. */
	updated: number;
	/** Per-row messages (bounded). */
	messages: string[];
	/** Row the importer stopped at, when it did. */
	nextrow: number;
	/** Ids the importer reported, when it did. */
	ids: number[];
}

/**
 * Read the importer's answer into something the model can act on.
 *
 * `base_import` answers with counters, per-row messages and a `nextrow`; an HTTP
 * 200 with messages is NOT a success, so this keeps the messages instead of
 * reducing everything to a boolean.
 * @param raw - the parsed RPC result.
 * @returns the outcome, with what could be read.
 */
export function readImportOutcome(raw: unknown): ImportOutcome {
	const obj = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const messages = Array.isArray(obj["messages"])
		? (obj["messages"] as unknown[]).slice(0, 50).map((m) => {
				if (m !== null && typeof m === "object" && "message" in (m as Record<string, unknown>)) {
					const row = (m as { record?: unknown }).record;
					return `${row === undefined ? "" : `row ${String(row)}: `}${String((m as { message?: unknown }).message)}`;
				}
				return String(m);
			})
		: [];
	return {
		created: num(obj["ids"] !== undefined && Array.isArray(obj["ids"]) ? (obj["ids"] as unknown[]).length : obj["created"]),
		updated: num(obj["updated"]),
		messages,
		nextrow: num(obj["nextrow"]),
		ids: Array.isArray(obj["ids"]) ? (obj["ids"] as unknown[]).filter((v): v is number => typeof v === "number") : [],
	};
}

/** Per-row messages kept in the run report; the rest are counted, not dropped silently. */
const REPORTED_MESSAGES = 5;

/** How a completed apply is reported back to the batch. */
export interface AppliedImportReport {
	/** Rows created. */
	created: number;
	/** Rows updated. */
	updated: number;
	/** True when the importer stopped before the last row. */
	partial: boolean;
	/** Row it stopped at, present only when it did. */
	stoppedAtRow?: number;
	/** Per-row messages, bounded. */
	messages: string[];
	/** How many messages were left out of the report. */
	messagesOmitted?: number;
}

/**
 * Classify a COMPLETED apply: the rows Odoo reports landed, and whether it finished.
 *
 * Odoo answers an apply it ran, so this is never `indeterminate` — the rows counted
 * here are in the database and re-sending them would duplicate them. A `nextrow`
 * means the importer gave up after too many bad rows, which is reported as
 * `partial` rather than as a clean success.
 * @param outcome - what the importer answered.
 * @returns the report to store in the run.
 */
export function reportAppliedImport(outcome: ImportOutcome): AppliedImportReport {
	const partial = outcome.nextrow > 0;
	const messages = outcome.messages.slice(0, REPORTED_MESSAGES);
	return {
		created: outcome.created,
		updated: outcome.updated,
		partial,
		...(partial ? { stoppedAtRow: outcome.nextrow } : {}),
		messages,
		...(outcome.messages.length > messages.length ? { messagesOmitted: outcome.messages.length - messages.length } : {}),
	};
}

/** Extensions the native importer can read. Anything else is refused up front. */
const ALLOWED_EXTENSIONS = [".csv", ".xls", ".xlsx", ".txt", ".ods"];
/** Size ceiling: a spreadsheet bigger than this is not a configuration import. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Verdict on the file a batch wants to import. */
export interface FileCheck {
	ok: boolean;
	/** Reason when refused (never contains file content). */
	reason?: string;
	/** sha256 of the bytes, for change detection between steps. */
	sha256?: string;
	/** Size in bytes. */
	bytes?: number;
}

/**
 * Validate the file before anything touches the instance.
 *
 * Checks the REAL path (a symlink is refused, so an import cannot be pointed at
 * something else between the approval and the upload), the extension the native
 * importer understands, the size, and it fingerprints the bytes so a later step
 * can prove the file did not change under an approval.
 * @param filePath - absolute path the operator authorised.
 * @returns the verdict plus the fingerprint.
 */
export function checkImportFile(filePath: string): FileCheck {
	let st: { isSymbolicLink(): boolean; isFile(): boolean; size: number };
	try {
		st = lstatSync(filePath);
	} catch {
		return { ok: false, reason: "the file does not exist or cannot be read" };
	}
	if (st.isSymbolicLink()) {
		return { ok: false, reason: "the path is a symbolic link; point the import at the real file" };
	}
	if (!st.isFile()) return { ok: false, reason: "the path is not a regular file" };
	const ext = extname(filePath).toLowerCase();
	if (!ALLOWED_EXTENSIONS.includes(ext)) {
		return { ok: false, reason: `"${ext || "(no extension)"}" is not a format the native importer reads (${ALLOWED_EXTENSIONS.join(", ")})` };
	}
	if (st.size > MAX_FILE_BYTES) {
		return { ok: false, reason: `the file is ${Math.round(st.size / 1024 / 1024)} MB, above the ${MAX_FILE_BYTES / 1024 / 1024} MB ceiling` };
	}
	if (st.size === 0) return { ok: false, reason: "the file is empty" };
	try {
		return { ok: true, sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"), bytes: st.size };
	} catch {
		return { ok: false, reason: "the file could not be read for hashing" };
	}
}

/** Upload one file to the instance's temporary importer. */
export interface UploadInput {
	/** Absolute path of the file the operator authorised. */
	filePath: string;
	/** Database id of the `base_import.import` record. */
	importId: number;
	/** Session of the target (never logged). */
	session: WebSession;
	/** CSRF token for the web route, when the version requires one. */
	csrfToken: string | null;
	/** Capability contract of this version. */
	capabilities: ImportCapabilities;
	/** Optional cancellation. */
	signal?: AbortSignal;
}

/** Result of an upload: the importer id and what the endpoint answered. */
export type UploadResult =
	| { ok: true; importId: number; parsed: unknown }
	| { ok: false; error: string; errorKind: "transport" | "server" | "protocol" };

/**
 * Upload the file bytes with the web session (multipart/form-data).
 *
 * `base_import.import.file` expects RAW BYTES, so the file is sent as a Blob and
 * never base64-encoded. The session cookie is used here and nowhere else.
 * @param input - file, session and capability contract.
 * @returns the outcome, with the id the endpoint assigned when it answers one.
 */
export async function uploadImportFile(input: UploadInput): Promise<UploadResult> {
	let bytes: Buffer;
	try {
		bytes = readFileSync(input.filePath);
	} catch (err) {
		return { ok: false, error: `cannot read the file: ${err instanceof Error ? err.message : String(err)}`, errorKind: "protocol" };
	}
	const form = new FormData();
	form.append(input.capabilities.upload.idField, String(input.importId));
	if (input.csrfToken !== null) form.append("csrf_token", input.csrfToken);
	form.append(
		input.capabilities.upload.fileField,
		new Blob([new Uint8Array(bytes)]),
		basename(input.filePath),
	);
	try {
		const response = await fetch(`${input.session.url}${input.capabilities.upload.path}`, {
			method: "POST",
			headers: { cookie: `session_id=${input.session.sessionId}` },
			body: form,
			redirect: "error",
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		const text = await response.text();
		if (!response.ok) {
			return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}`, errorKind: "server" };
		}
		const parsed = parseJsonpAsData(text);
		if (parsed === null) {
			return {
				ok: false,
				error:
					"the upload answered a body this plugin could not read as JSON or as a JSON object. " +
					`Verify the endpoint contract for this version. Body starts with: ${text.slice(0, 120)}`,
				errorKind: "protocol",
			};
		}
		const id = (parsed as { id?: unknown }).id;
		return { ok: true, importId: typeof id === "number" ? id : input.importId, parsed };
	} catch (err) {
		return {
			ok: false,
			error: `the upload failed: ${err instanceof Error ? err.message : String(err)}`,
			errorKind: "transport",
		};
	}
}

/** Resolve the version's capabilities or explain why the import cannot run. */
export function capabilitiesFor(serverVersion: string):
	| { ok: true; capabilities: ImportCapabilities }
	| { ok: false; message: string } {
	const result = importCapabilities(serverVersion);
	return result.ok ? { ok: true, capabilities: result.capabilities } : { ok: false, message: result.message };
}

/** Minimal client surface the import preparation needs. */
export interface ImportRpc {
	executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs: Record<string, unknown>,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<{ ok: true; value: T } | { ok: false; error: string; errorKind?: string }>;
}

/** Everything `odoo_import` needs from the registrant. */
export interface ImportDeps {
	/** Project root of the calling session. */
	projectRoot(exec?: unknown): string;
	/**
	 * RPC client for the session's project, plus the detected server version.
	 *
	 * Async because the version is probed on demand: the import contract is
	 * version-specific, and driving the importer blind is not an option.
	 */
	client(exec?: unknown): Promise<{ client: ImportRpc | null; report: string; serverVersion?: string }>;
	/** Ask the human for the preparation scope (a native approval). */
	approve(exec: unknown, reason: string): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
	/** Absolute path of the spec directory. */
	specDir(specId: string, exec?: unknown): string;
	/** Whether the imported file path is one the operator allowed. */
	authorisedFile?(path: string): boolean;
	/** Path masking for display. */
	display(pathValue: string): string;
}

/**
 * Register `odoo_import`.
 * @param ctx - registrant context exposing the tool registry.
 * @param deps - live configuration lookups.
 */
export function registerImportTool(ctx: { tools: { register(tool: unknown): void } }, deps: ImportDeps): void {
	ctx.tools.register(defineTool({
		name: "odoo_import",
		description:
			"Prepare a CSV/XLS/XLSX import through Odoo's OWN importer (base_import), never through a parser of " +
			"this plugin. use=prepare uploads the authorised file to a temporary importer record (multipart, web " +
			"session, its own approval); use=preview reads what Odoo sees (sheets, headers, a bounded sample, the " +
			"importable fields) so the mapping is decided from facts; use=map records the column mapping for a " +
			"batch; use=plan turns it into an APPLY batch of the functional plan, which odoo_functional must " +
			"approve and execute like any other — this tool never applies an import on its own. A JSONP answer is " +
			"parsed as data, the session cookie never leaves the plugin, and a version outside the verified " +
			"families is refused with what to investigate. Without a web session it returns NEEDS_WEB_SESSION.",
		parameters: {
			use: {
				type: "string",
				required: true,
				enum: ["prepare", "preview", "map", "plan", "status"],
				description: "prepare | preview | map | plan | status.",
			},
			spec_id: { type: "string", required: true, description: "Spec id the import belongs to." },
			batch_id: { type: "string", required: true, description: "Batch id this import will be applied as." },
			file_path: { type: "string", description: "Absolute path of the file (prepare/preview). It must be the file the operator authorised." },
			model: { type: "string", description: "Target model (e.g. res.partner)." },
			sheet: { type: "string", description: "Sheet/index to read (preview): name or 0-based index." },
			columns: { type: "array", items: { type: "object", additionalProperties: true }, description: "map: column → field mapping; every column needs a decision." },
			options: { type: "object", additionalProperties: true, description: "Importer options (headers, separator, encoding, ...)." },
			confirm_destructive: { type: "boolean", description: "prepare: REQUIRED true (it writes a temporary importer record)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					use: { type: "string", required: true },
					status: { type: "string", required: true },
					specId: { type: "string", required: true },
					batchId: { type: "string" },
					importId: { type: "number" },
					headers: { type: "array", items: { type: "string" } },
					sheets: { type: "array", items: { type: "object", additionalProperties: true } },
					sample: { type: "array", items: { type: "object", additionalProperties: true } },
					fields: { type: "array", items: { type: "string" } },
					capabilities: { type: "object", additionalProperties: true },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text(String((value as { detail: string }).detail))],
		},
		async execute(args: {
			use: "prepare" | "preview" | "map" | "plan" | "status";
			spec_id: string;
			batch_id: string;
			file_path?: string;
			model?: string;
			sheet?: string;
			columns?: Array<Record<string, unknown>>;
			options?: Record<string, unknown>;
			confirm_destructive?: boolean;
		}, exec?: unknown) {
			const projectRoot = deps.projectRoot(exec);
			const specId = args.spec_id.trim();
			const batchId = args.batch_id.trim();
			const base = { ok: false, use: args.use as string, status: "error" as string, specId, batchId };
			if (!isSafeSegment(specId) || !isSafeSegment(batchId)) {
				return { ...base, detail: "spec_id and batch_id must each be a single path segment." };
			}
			const plan = readPlan(projectRoot, specId);
			if (plan === null && args.use !== "prepare") {
				return { ...base, status: "no-plan", detail: `No functional plan for spec ${specId}: plan the batch with odoo_functional first.` };
			}

			// ---- status -------------------------------------------------------
			if (args.use === "status") {
				const session = readWebSession(projectRoot);
				const stored = plan?.batches.find((b) => b.id === batchId);
				return {
					...base,
					ok: true,
					status: session === null ? "needs-web-session" : "ready",
					detail:
						`Import batch ${batchId} of spec ${specId}: ${stored === undefined ? "not in the plan yet" : `${stored.operations.length} operation(s) declared`}.\n` +
						`Web session: ${session === null ? "NOT AVAILABLE (run odoo_session, or authenticate a web session) — an API key is not a web credential" : `present (${deps.display(session.file)})`}\n` +
						`Version families with a verified contract: ${knownMajors().join(", ")}.`,
				};
			}

			const { client, report, serverVersion } = await deps.client(exec);
			if (client === null) return { ...base, status: "not-connected", detail: report };

			// The version contract must be known BEFORE touching the importer.
			const caps = capabilitiesFor(serverVersion ?? "");
			if (!caps.ok) {
				return { ...base, status: "unsupported-version", detail: caps.message };
			}
			const capabilitySummary = {
				family: caps.capabilities.family,
				upload: `${caps.capabilities.upload.path} (${caps.capabilities.upload.fileField}, ${caps.capabilities.upload.response})`,
				apply: `${caps.capabilities.apply.method}(${caps.capabilities.apply.signature.join(", ")})`,
			};

			// ---- prepare ------------------------------------------------------
			if (args.use === "prepare") {
				if ((args.file_path ?? "").trim() === "") {
					return { ...base, status: "needs-file", detail: "use=prepare requires file_path." };
				}
				const filePath = args.file_path!;
				if (deps.authorisedFile !== undefined && !deps.authorisedFile(filePath)) {
					return { ...base, status: "not-authorised", detail: `The path ${deps.display(filePath)} is not one the operator authorised for this run.` };
				}
				if (args.confirm_destructive !== true) {
					return {
						...base,
						status: "needs-confirmation",
						detail:
							"use=prepare writes a temporary importer record on the instance, so it needs " +
							"confirm_destructive=true (the caller's acknowledgement) plus the human approval below.",
					};
				}
				const fileCheck = checkImportFile(filePath);
				if (!fileCheck.ok) {
					return { ...base, status: "invalid-file", detail: `Refusing ${deps.display(filePath)}: ${fileCheck.reason}.` };
				}
				const session = readWebSession(projectRoot);
				if (session === null) {
					return {
						...base,
						status: "needs-web-session",
						detail:
							"NEEDS_WEB_SESSION: uploading a file uses the web route /base_import/set_file, which needs a " +
							"session cookie. Run odoo_session (or authenticate a web session in the browser) and retry. " +
							"An API key authenticates JSON-RPC; it is not a web credential, and this plugin will not " +
							"ask for a password through chat.",
					};
				}
				const outcome = await deps.approve(
					exec,
					`Prepare a file import for spec ${specId} (batch ${batchId}): upload ${deps.display(filePath)} to the ` +
						"temporary importer of the instance? This writes a temporary record and nothing else.",
				);
				if (outcome !== "allowed-once") {
					return { ...base, status: "not-approved", detail: `Preparation NOT approved (outcome: ${outcome}). Nothing was uploaded.` };
				}
				if ((args.model ?? "").trim() === "") {
					return { ...base, status: "needs-model", detail: "use=prepare requires model (the target model)." };
				}
				// Create the temporary importer record, then upload the bytes into it.
				const created = await client.executeKw<number>("base_import.import", "create", [
					{ res_model: args.model!.trim(), file_name: basename(filePath), file_type: "text/csv" },
				], {});
				if (!created.ok) {
					return { ...base, status: "failed", detail: `Could not create the importer record: ${created.error}` };
				}
				const importId = typeof created.value === "number" ? created.value : 0;
				const csrf = await fetchCsrfToken(session, exec);
				const upload = await uploadImportFile({
					filePath,
					importId,
					session,
					csrfToken: csrf,
					capabilities: caps.capabilities,
					...(exec !== null && typeof exec === "object" && "signal" in exec
						? { signal: (exec as { signal?: AbortSignal }).signal }
						: {}),
				});
				if (!upload.ok) {
					return {
						...base,
						status: upload.errorKind === "transport" ? "indeterminate" : "failed",
						importId,
						capabilities: capabilitySummary,
						detail:
							`The upload ${upload.errorKind === "transport" ? "did not answer (its outcome is UNKNOWN: the file may or may not be on the instance)" : "failed"}: ${upload.error}`,
					};
				}
				// Remember the import id next to the batch so preview/plan can use it.
				writeState(projectRoot, specId, `import-${batchId}.json`, {
					batchId,
					model: args.model!.trim(),
					filePath,
					fileName: basename(filePath),
					fileSha256: fileCheck.sha256,
					fileBytes: fileCheck.bytes,
					importId: upload.importId,
					capabilities: capabilitySummary,
					preparedAt: new Date().toISOString(),
				});
				return {
					...base,
					ok: true,
					status: "prepared",
					importId: upload.importId,
					capabilities: capabilitySummary,
					detail:
						`File uploaded to the temporary importer (record ${upload.importId}) for model ${args.model!.trim()} ` +
						`using the ${caps.capabilities.family} contract.\n` +
						"Next: use=preview to see what Odoo reads (sheets, headers, sample, importable fields) BEFORE deciding " +
						"the mapping. Nothing was imported.",
				};
			}

			// ---- preview ------------------------------------------------------
			if (args.use === "preview") {
				const prepared = readState<{ importId: number; model: string }>(projectRoot, specId, `import-${batchId}.json`);
				if (prepared === null) {
					return { ...base, status: "not-prepared", detail: `No prepared file for batch ${batchId}. Run use=prepare first.` };
				}
				const fieldsResult = await client.executeKw<unknown>(
					"base_import.import",
					caps.capabilities.fieldsMethod,
					[],
					{},
				);
				const parseResult = await client.executeKw<unknown>(
					"base_import.import",
					"parse_preview",
					[prepared.importId, args.options ?? {}, args.sheet ?? false],
					{},
				);
				if (!parseResult.ok) {
					return { ...base, status: "failed", importId: prepared.importId, detail: `Odoo could not read the file: ${parseResult.error}` };
				}
				const preview = (parseResult.value ?? {}) as Record<string, unknown>;
				const headers = Array.isArray(preview["headers"])
					? (preview["headers"] as unknown[]).map((h) => String(h))
					: [];
				const sheets = Array.isArray(preview["sheets"]) ? (preview["sheets"] as Array<Record<string, unknown>>) : [];
				const rows = Array.isArray(preview["preview"]) ? (preview["preview"] as unknown[]).slice(0, 5) : [];
				const fields = Array.isArray(fieldsResult.ok ? fieldsResult.value : [])
					? ((fieldsResult.ok ? fieldsResult.value : []) as unknown[]).slice(0, 400).map((f) => {
							if (f !== null && typeof f === "object" && "id" in (f as Record<string, unknown>)) return String((f as { id: unknown }).id);
							return String(f);
						})
					: [];
				return {
					...base,
					ok: true,
					status: "previewed",
					importId: prepared.importId,
					headers,
					// Only scalars cross the tool boundary: the model needs to know WHICH
					// sheets exist, not carry Odoo's raw structures into a transcript.
					sheets: sheets.map((s) => ({
						name: String(s["name"] ?? ""),
						index: typeof s["index"] === "number" ? s["index"] : 0,
					})),
					sample: rows.map((r) => ({ row: JSON.stringify(r).slice(0, 300) })),
					fields,
					capabilities: capabilitySummary,
					detail:
						`Odoo read the file: ${headers.length} column(s), sheets: ${sheets.length === 0 ? "(single)" : sheets.map((s) => String(s["name"] ?? "?")).join(", ")}.\n` +
						`Headers: ${headers.join(" | ") || "(none detected)"}\n` +
						`Importable fields reported: ${fields.length}${fieldsResult.ok ? "" : " (the field list could not be read)"}\n` +
						"Next: use=map with a decision for EVERY column. No column is dropped without one, and ambiguous ones must be asked about.",
				};
			}

			// ---- map ----------------------------------------------------------
			if (args.use === "map") {
				const prepared = readState<{ importId: number; model: string; filePath: string; fileSha256?: string }>(
					projectRoot,
					specId,
					`import-${batchId}.json`,
				);
				if (prepared === null) {
					return { ...base, status: "not-prepared", detail: `No prepared file for batch ${batchId}. Run use=prepare first.` };
				}
				// The mapping is decided against the bytes that were uploaded: if the
				// file changed, the columns may no longer mean what they meant.
				const current = checkImportFile(prepared.filePath);
				if (!current.ok || (prepared.fileSha256 !== undefined && current.sha256 !== prepared.fileSha256)) {
					return {
						...base,
						status: "file-changed",
						detail:
							`The file at ${deps.display(prepared.filePath)} is not the one that was uploaded` +
							`${current.ok ? ` (its hash is now ${String(current.sha256).slice(0, 12)}…)` : ` (${current.reason})`}. ` +
							"Re-run use=prepare so the mapping and the upload refer to the same bytes.",
					};
				}
				const columns = Array.isArray(args.columns) ? args.columns : [];
				if (columns.length === 0) {
					return { ...base, status: "needs-mapping", detail: "use=map requires columns: one entry per column of the file." };
				}
				const undecided = columns.filter((c) => {
					const field = String((c as { field?: unknown }).field ?? "").trim();
					const decision = String((c as { decision?: unknown }).decision ?? "").trim();
					return field === "" && decision !== "skip";
				});
				if (undecided.length > 0) {
					return {
						...base,
						status: "incomplete-mapping",
						detail:
							`${undecided.length} column(s) have no decision: ${undecided.map((c) => String((c as { column?: unknown }).column ?? "?")).join(", ")}. ` +
							"Every column needs a target field or an explicit `decision: skip`, and an ambiguous match is a question for the developer.",
					};
				}
				writeState(projectRoot, specId, `mapping-${batchId}.json`, {
					batchId,
					importId: prepared.importId,
					model: prepared.model,
					columns,
					options: args.options ?? {},
					mappedAt: new Date().toISOString(),
				});
				return {
					...base,
					ok: true,
					status: "mapped",
					importId: prepared.importId,
					detail:
						`Mapping recorded for ${columns.length} column(s) (${undecided.length} left undecided: none). ` +
						"The mapping is stored under .sdd/functional/ and referenced by the batch: changing it invalidates the " +
						"batch approval, so re-approve after editing.",
				};
			}

			// ---- plan ---------------------------------------------------------
			if (args.use === "plan") {
				const prepared = readState<{ importId: number; model: string; fileName: string }>(projectRoot, specId, `import-${batchId}.json`);
				const mapping = readState<{ columns: unknown[]; options: Record<string, unknown> }>(projectRoot, specId, `mapping-${batchId}.json`);
				if (prepared === null || mapping === null) {
					return {
						...base,
						status: "not-ready",
						detail:
							"A batch can only be planned from a prepared file AND a complete mapping: " +
							`${prepared === null ? "the file is not prepared" : "the mapping is missing"}. ` +
							"Run use=prepare and use=map first.",
					};
				}
				const plan2 = readPlan(projectRoot, specId) ?? { specId, environment: plan?.environment ?? "dev", batches: [] };
				const batch = {
					id: batchId,
					scope: "apply" as const,
					title: `Import ${prepared.fileName} into ${prepared.model}`,
					acceptance: [],
					companies: [],
					operations: [
						{
							kind: "import" as const,
							intent: `import ${prepared.fileName} into ${prepared.model} through Odoo's importer`,
							model: prepared.model,
							method: "execute_import",
							import: {
								importId: prepared.importId,
								fileName: prepared.fileName,
								columns: mapping.columns,
								options: mapping.options,
								dryRun: false,
							},
							identity: [{ field: "id", value: null }],
							recovery: { kind: "none" as const, note: "an applied import is compensated by deleting the created ids, or by the declared backup" },
						},
					],
					highRisk: false,
					manualSteps: [`Open the ${prepared.model} list in Odoo and check the imported rows against ${prepared.fileName}.`],
				};
				plan2.batches = [...plan2.batches.filter((b) => b.id !== batchId), batch];
				writeState(projectRoot, specId, "plan.json", plan2);
				return {
					...base,
					ok: true,
					status: "planned",
					importId: prepared.importId,
					capabilities: capabilitySummary,
					detail:
						`Batch ${batchId} planned as an import of ${prepared.fileName} into ${prepared.model} ` +
						`(${mapping.columns.length} mapped column(s)).\n` +
						"It is a batch like any other: odoo_functional must approve it (the human decides) and apply it. " +
						"Use a dry run first with odoo_functional if the file is large or the mapping is new.",
				};
			}

			return { ...base, detail: `Unsupported use "${args.use}".` };
		},
	}));
}

/** Read one import artefact written by this module. */
function readState<T>(projectRoot: string, specId: string, name: string): T | null {
	const file = join(projectRoot, ".sdd", "functional", isSafeSegment(specId) ? specId : "__invalid__", name);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * Fetch the CSRF token the web route needs, if the version uses one.
 * @param session - the web session.
 * @param exec - the running execution, for cancellation.
 * @returns the token, or null when the page does not carry one (some versions do not).
 */
async function fetchCsrfToken(session: WebSession, exec?: unknown): Promise<string | null> {
	try {
		const signal = exec !== null && typeof exec === "object" && "signal" in exec ? (exec as { signal?: AbortSignal }).signal : undefined;
		const response = await fetch(`${session.url}/web`, {
			method: "GET",
			headers: { cookie: `session_id=${session.sessionId}` },
			redirect: "error",
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) return null;
		return extractCsrfToken(await response.text());
	} catch {
		return null;
	}
}

/** Minimal text block for the tool renderer. */
function text(value: string): { type: "text"; text: string } {
	return { type: "text", text: value };
}
