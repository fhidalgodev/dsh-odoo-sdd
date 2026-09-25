/**
 * Runtime tools of dsh-odoo-sdd: `odoo_execute` (generic RPC — reads, CRUD on an
 * allowlist, and any public business method behind an explicit confirmation) and
 * `odoo_validate` (local, instance-free module checks). Built here as functions
 * that receive the registrant context plus live dependencies, so the plugin entry
 * stays thin and these layers remain individually testable. Registration happens
 * from src/index.ts.
 *
 * @module dsh-odoo-sdd/tools-runtime
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveModuleDir } from "./paths.js";
import type { RpcErrorKind } from "./odoo-client.js";

/** Live dependencies provided by the registrant. */
export interface RuntimeDeps {
	/**
	 * Resolve and cache an OdooClient instance, or null when unconfigured.
	 * Receives the calling execution so the client — and therefore the
	 * credentials, the connection grant and the audit trail — belong to the
	 * SESSION's project rather than to a plugin-wide setting.
	 */
	client(exec?: unknown): {
		client: {
			executeKw<T>(
				model: string,
				method: string,
				args: unknown[],
				kwargs: Record<string, unknown>,
				timeoutMs?: number,
				signal?: AbortSignal,
				// `errorKind` is what tells a domain error (the server answered and
				// refused) from a transport/protocol failure (the outcome is UNKNOWN).
				// Without it in the type, odoo_execute could not report that
				// distinction for a business action.
			): Promise<{ ok: true; value: T } | { ok: false; error: string; errorKind?: RpcErrorKind }>;
		} | null;
		report: string;
	};
	/** Effective onboarding status, used in remediation text. */
	status(projectRoot: string): { detail: string };
	/** Project root the call acts on, resolved from the calling session. */
	projectRoot(exec?: unknown): string;
	/** Models allowed for MUTATING calls, resolved AT CALL TIME (live config). */
	allowlist(exec?: unknown): string[];
	/** Journal one applied mutation for the checkpoint rollback (best-effort). */
	recordDataOp?(
		op: {
			model: string;
			method: "create" | "write" | "unlink";
			ids: number[];
			preImage: Array<Record<string, unknown>>;
			createdIds: number[];
			context?: Record<string, unknown>;
		},
		exec?: unknown,
	): void;
	/** Path/display masking helper. */
	display(pathValue: string): string;
	/**
	 * Record a domain-level failure (the RPC reached the server and failed).
	 * The host's own result listener only sees transport success, so without
	 * this a server error would be audited as `ok`.
	 */
	auditFailure?(
		info: { tool: string; op: string; callId?: string; reason: string },
		exec?: unknown,
	): void;
}

/**
 * The read/mutating sets live in `method-classification.ts` — one source of
 * truth shared with the batch executor, because two copies of the same policy
 * drift. Re-exported here so this tool keeps its public shape.
 */
export {
	READ_METHODS,
	MUTATING_METHODS,
	CRUD_METHODS,
	isReadMethod,
	isCrudMutation,
	isBusinessMethod,
	isCallableMethodName,
	isIndeterminateFor,
} from "./method-classification.js";
import {
	READ_METHODS,
	MUTATING_METHODS,
	isReadMethod,
	isCallableMethodName,
	isBusinessMethod,
	isIndeterminateFor,
} from "./method-classification.js";
import { checkCondition } from "./functional.js";

/** Build and register `odoo_execute` and `odoo_validate`. */
export function registerRuntimeTools(
	ctx: { tools: { register(tool: unknown): void } },
	deps: RuntimeDeps,
): void {
	// -----------------------------------------------------------------
	// odoo_execute — generic CRUD/RPC with a fail-closed allowlist
	// -----------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_execute",
		description:
			"Execute a JSON-RPC call (execute_kw) against the connected instance. ANY public method of the model is " +
			"callable, and what it needs is decided by what it is. " +
			`READS (${[...READ_METHODS].join(", ")}) run freely. ` +
			`CRUD mutations (${[...MUTATING_METHODS].join(", ")}) require confirm_destructive=true AND the model in ` +
			"executeAllowlist, and are journaled so sdd_checkpoint can undo them. Every OTHER method is a BUSINESS " +
			'ACTION (action_*, button_*, do_*…): it runs with confirm_destructive=true and NO allowlist, because the ' +
			"plugin cannot replay its effect — it is never journaled, no undo exists for it, and a timeout is " +
			"reported as an INDETERMINATE outcome instead of a plain failure. Declare `precondition` (checked before " +
			"the call) and `postcondition` (checked after) to carry a state guard and a state proof; without the " +
			"postcondition the result only means the server accepted the call. PRIVATE methods (`_name`) are refused: " +
			"Odoo's own dispatch does not allow them over RPC, so read the model in the source (the native/custom " +
			"repositories are reported by odoo_config mode=read) and call the public button or action that wraps it. " +
			'For several operations, or when a human approval per run is wanted, use a functional batch with kind: "method". ' +
			"`context` is forwarded verbatim (use it for allowed_company_ids/company_id on multi-company instances, " +
			"lang or tz); the server still applies its own ACL. Parameters are explicit to avoid guessing argument " +
			"shapes. Output is redacted. Target must be a disposable dev/staging DB.",
		parameters: {
			model: { type: "string", required: true, description: "Odoo model name." },
			method: {
				type: "string",
				required: true,
				description:
					"Method to call: any public method name of the model (see the tool description for what each kind " +
					"requires). A leading underscore is refused — Odoo does not allow private methods over RPC.",
			},
			// Odoo domains are lists of terms; a term is either a triple with a
			// SCALAR value (`["state","=","draft"]`) or a bare logical operator
			// (`"|"`, `"&"`, `"!"`). Constraining items to objects rejected every
			// valid domain, so the array is left unconstrained.
			domain: { type: "array", description: "search_read/search_count domain, e.g. [[\"state\",\"=\",\"draft\"]] or [\"|\",[\"a\",\"=\",1],[\"b\",\"=\",2]]." },
			ids: { type: "array", items: { type: "number" }, description: "Record ids (read/write/unlink)." },
			values: { type: "object", additionalProperties: true, description: "Field values (create/write)." },
			fields: { type: "array", items: { type: "string" }, description: "Fields to read." },
			order: { type: "string", description: "Order clause for search_read." },
			confirm_destructive: { type: "boolean", description: "REQUIRED true for create/write/unlink." },
			limit: { type: "number", description: "Row cap for reads (default 10)." },
			offset: { type: "number", description: "Rows to skip before the window (search_read/read_group/search_count), so a large model can be paged instead of relying on one truncated response." },
			groupby: { type: "array", items: { type: "string" }, description: "read_group: fields to group by, e.g. [\"state\"]." },
			// A business action takes the recordset as its first argument (Odoo
			// dispatches on `args[0]`), then whatever the method declares. `args`
			// carries the positionals AFTER the ids, `kwargs` the keywords, so
			// neither is guessed from `values`.
			args: { type: "array", description: "Business action: extra POSITIONAL arguments after the record ids (the recordset is always args[0])." },
			kwargs: { type: "object", additionalProperties: true, description: "Business action: keyword arguments of the method (forwarded verbatim, like `context`)." },
			// The same shape a batch operation declares, evaluated with the same
			// helper: a state guard before the call and a state proof after it.
			precondition: { type: "object", additionalProperties: true, description: "Read that must hold BEFORE the call: {domain, expect: exists|missing|count, count}. If it fails, nothing is sent." },
			postcondition: { type: "object", additionalProperties: true, description: "Read that must hold AFTER the call (the state that proves it worked): {domain, expect: exists|missing|count, count}. Without it, OK only means the server accepted the call." },
			attributes: { type: "array", items: { type: "string" }, description: "fields_get: attributes to return, e.g. [\"type\",\"string\",\"required\"]." },
			context: { type: "object", additionalProperties: true, description: "Odoo context forwarded verbatim as kwargs.context (allowed_company_ids, company_id, lang, tz)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					denied: { type: "boolean", required: true },
					reason: { type: "string", required: true },
					result: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				// The renderer must carry the actual payload/traceback: dropping
				// `result` broke the closed feedback loop (the model saw only the
				// reason line, never the data or the server error).
				const v = value as { denied: boolean; reason: string; result?: string };
				if (v.denied) return [{ type: "text", text: `[DENIED] ${v.reason}` }];
				const detail = typeof v.result === "string" && v.result !== "" ? v.result : "";
				return [{ type: "text", text: detail === "" ? v.reason : `${v.reason}\n\n${detail}` }];
			},
		},
		async execute(args: unknown, exec?: { callId?: unknown; signal?: unknown; agent?: unknown }) {
			const a = args as {
				model: string;
				method: string;
				domain?: unknown[];
				ids?: number[];
				values?: Record<string, unknown>;
				fields?: string[];
				order?: string;
				confirm_destructive?: boolean;
				limit?: number;
				offset?: number;
				groupby?: string[];
				attributes?: string[];
				context?: Record<string, unknown>;
				args?: unknown[];
				kwargs?: Record<string, unknown>;
				precondition?: unknown;
				postcondition?: unknown;
			};
			const model = a.model.trim();
			const method = a.method;
			// Pagination is validated up front, fail-closed: a fractional or
			// negative offset is a typo, not something to clamp silently (a wrong
			// window is a wrong answer, and it looks like a complete one).
			if (a.offset !== undefined && (!Number.isInteger(a.offset) || a.offset < 0)) {
				return {
					denied: true,
					reason: `\`offset\` must be a non-negative integer (got ${JSON.stringify(a.offset)}).`,
					result: "",
				};
			}
			// Classification (fail-closed). Two kinds are known by name, and
			// everything else is a business action — which the RPC CAN run, because
			// refusing it is what left the surface handcuffed. The only wall kept is
			// Odoo's own: a private name is not callable remotely at all, so refusing
			// it here turns a guaranteed server AccessError into an instruction.
			const isRead = isReadMethod(method);
			const isCrud = MUTATING_METHODS.has(method);
			let isBusiness = false;
			if (!isRead && !isCrud) {
				if (!isCallableMethodName(method)) {
					return {
						denied: true,
						reason:
							`Method "${method}" cannot be called over RPC. Odoo's own dispatch (get_public_method) refuses ` +
							"private names (`_…`), `init`, methods decorated `@api.private` and the internal attribute names — " +
							"the server would answer with an AccessError. Read the model's source (the native and custom " +
							"repositories are reported by `odoo_config mode=read`) and call the public button or action that " +
							"wraps it: `sale.order._create_invoices` is private, the `sale.advance.payment.inv` wizard exposes " +
							"the public `create_invoices()`.",
						result: "",
					};
				}
				isBusiness = true;
			}

			// ---- context (multi-company / lang / tz) -------------------------
			// Forwarded verbatim; the server still applies its own ACL and record
			// rules. Rejecting a non-object keeps the payload predictable.
			let callContext: Record<string, unknown> | undefined;
			if (a.context !== undefined) {
				if (a.context === null || typeof a.context !== "object" || Array.isArray(a.context)) {
					return { denied: true, reason: "`context` must be a plain JSON object when provided.", result: "" };
				}
				callContext = a.context;
			}

			// ---- policy (explicit confirmation, and the CRUD allowlist) ------
			if (isCrud) {
				if (a.confirm_destructive !== true) {
					return { denied: true, reason: "Mutating call requires confirm_destructive=true.", result: "" };
				}
				if (!deps.allowlist(exec).includes(model)) {
					return {
						denied: true,
						reason: `Model "${model}" is not allowlisted for mutations — add it via odoo_config mode=set executeAllowlist=[...] or run read-only.`,
						result: "",
					};
				}
			} else if (isBusiness) {
				// No allowlist: any public method runs. The confirmation IS the gate,
				// because nothing here can replay or undo what the call does.
				if (a.confirm_destructive !== true) {
					return {
						denied: true,
						reason:
							`"${model}.${method}" is neither a read nor CRUD: it runs code the plugin cannot replay, so it ` +
							"requires confirm_destructive=true. Declare `precondition` (checked before the call) and " +
							"`postcondition` (checked after) to carry a state guard and a state proof, or run it as a " +
							'functional batch with kind: "method" when an allowlisted pair and a human approval per run are wanted.',
						result: "",
					};
				}
			}

			// ---- build the positional call (no argument guessing) ------------
			let callArgs: unknown[];
			let callKwargs: Record<string, unknown> = {};
			if (method === "search_read" || method === "search_count") {
				callArgs = [Array.isArray(a.domain) ? a.domain : []];
				if (typeof a.offset === "number") callKwargs["offset"] = a.offset;
				if (method === "search_read") {
					if (Array.isArray(a.fields)) callKwargs["fields"] = a.fields;
					callKwargs["limit"] = typeof a.limit === "number" ? a.limit : 10;
					if (typeof a.order === "string" && a.order !== "") callKwargs["order"] = a.order;
				}
			} else if (method === "read_group") {
				// Aggregations: positional (domain, fields, groupby) with the
				// optional pagination/order in kwargs.
				callArgs = [
					Array.isArray(a.domain) ? a.domain : [],
					Array.isArray(a.fields) ? a.fields : [],
					Array.isArray(a.groupby) ? a.groupby : [],
				];
				if (typeof a.limit === "number") callKwargs["limit"] = a.limit;
				if (typeof a.offset === "number") callKwargs["offset"] = a.offset;
				if (typeof a.order === "string" && a.order !== "") callKwargs["orderby"] = a.order;
			} else if (method === "fields_get") {
				// Field discovery: no positional args, just the requested
				// attributes. Lets the pipeline stop guessing field names.
				callArgs = [];
				if (Array.isArray(a.attributes)) callKwargs["attributes"] = a.attributes;
			} else if (method === "read") {
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "read requires a non-empty `ids` array.", result: "" };
				}
				callArgs = [a.ids];
				if (Array.isArray(a.fields)) callKwargs["fields"] = a.fields;
			} else if (method === "create") {
				if (a.values === undefined || typeof a.values !== "object") {
					return { denied: true, reason: "create requires a `values` object.", result: "" };
				}
				callArgs = [a.values];
			} else if (method === "write") {
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "write requires a non-empty `ids` array.", result: "" };
				}
				if (a.values === undefined || typeof a.values !== "object") {
					return { denied: true, reason: "write requires a `values` object.", result: "" };
				}
				callArgs = [a.ids, a.values];
			} else if (method === "unlink") {
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "unlink requires a non-empty `ids` array.", result: "" };
				}
				callArgs = [a.ids];
			} else if (isBusiness || isRead) {
				// Everything else is called ON the recordset, with its own signature:
				// the public reads that the five ORM queries above do not cover
				// (`name_get`, `exists`, `check_access_rights`…) and every business
				// action. Odoo dispatches the method on the recordset built from
				// `args[0]` and then passes the rest, so the caller's positionals go
				// in `args` and the keywords in `kwargs` — never guessed from
				// `values`/`domain`, which would be silently ignored.
				const misplaced = (["values", "domain", "fields", "order", "groupby", "attributes"] as const).filter(
					(key) => (a as unknown as Record<string, unknown>)[key] !== undefined,
				);
				if (misplaced.length > 0) {
					return {
						denied: true,
						reason:
							`\`${misplaced.join("`, `")}\` belong to the classified read/CRUD calls (${[...READ_METHODS].concat([...MUTATING_METHODS]).join(", ")}), ` +
							`and "${method}" is called on the recordset with its own signature: pass its arguments positionally ` +
							"in `args` (after the ids) and its keywords in `kwargs`, so nothing is silently ignored.",
						result: "",
					};
				}
				if (a.args !== undefined && !Array.isArray(a.args)) {
					return { denied: true, reason: "`args` must be an array of positional arguments.", result: "" };
				}
				if (a.kwargs !== undefined && (a.kwargs === null || typeof a.kwargs !== "object" || Array.isArray(a.kwargs))) {
					return { denied: true, reason: "`kwargs` must be a plain JSON object.", result: "" };
				}
				// No `ids` means an empty recordset: some public methods are called on
				// the model itself, and the result says which one this was.
				callArgs = [Array.isArray(a.ids) ? a.ids : [], ...(Array.isArray(a.args) ? a.args : [])];
				if (a.kwargs !== undefined) callKwargs = { ...(a.kwargs as Record<string, unknown>) };
			} else {
				// Unreachable: the classification above denied every other name.
				return { denied: true, reason: `Method "${method}" was not classified.`, result: "" };
			}

			// ---- declared state guard / state proof (both optional) -----------
			// The same shape a batch declares. The schema cannot describe a domain
			// (its items are triples or bare operators), so it is validated here:
			// a malformed condition denies, it is never skipped.
			type Condition = { domain: unknown[]; expect: "exists" | "missing" | "count"; count?: number };
			const conditions: Record<"precondition" | "postcondition", Condition | undefined> = {
				precondition: undefined,
				postcondition: undefined,
			};
			for (const label of ["precondition", "postcondition"] as const) {
				const raw = label === "precondition" ? a.precondition : a.postcondition;
				if (raw === undefined) continue;
				if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
					return { denied: true, reason: `\`${label}\` must be an object: {domain, expect, count}.`, result: "" };
				}
				const raw2 = raw as { domain?: unknown; expect?: unknown; count?: unknown };
				if (!Array.isArray(raw2.domain)) {
					return { denied: true, reason: `\`${label}.domain\` must be an Odoo domain array, e.g. [["state","=","draft"]].`, result: "" };
				}
				if (raw2.expect !== "exists" && raw2.expect !== "missing" && raw2.expect !== "count") {
					return { denied: true, reason: `\`${label}.expect\` must be "exists", "missing" or "count".`, result: "" };
				}
				if (raw2.expect === "count" && (!Number.isInteger(raw2.count) || (raw2.count as number) < 0)) {
					return { denied: true, reason: `\`${label}.count\` must be a non-negative integer when expect="count".`, result: "" };
				}
				conditions[label] = {
					domain: raw2.domain,
					expect: raw2.expect,
					...(raw2.expect === "count" ? { count: raw2.count as number } : {}),
				};
			}
			const { precondition, postcondition } = conditions;

			if (callContext !== undefined) callKwargs["context"] = callContext;
			const { client, report } = deps.client(exec);
			if (client === null) {
				// `report` carries the real reason: NOT CONFIGURED (missing
				// credentials) or NOT AUTHORIZED (no live human grant).
				return { denied: true, reason: report, result: "" };
			}

			// The state guard runs BEFORE anything is sent: a declared precondition
			// that does not hold is a refusal with no side effect at all.
			if (precondition !== undefined) {
				const pre = await checkCondition(client, model, precondition, callContext);
				if (!pre.ok) {
					return { denied: true, reason: `Precondition not met (${pre.detail}): nothing was sent.`, result: "" };
				}
			}

			// ---- pre-image capture (for the rollback journal) ----------------
			// The pre-image MUST be read under the SAME context as the mutation:
			// with `allowed_company_ids`/`company_id` set, a plain read can return
			// nothing (record not visible in the default company) and the journal
			// would then hold an empty pre-image for a write it cannot undo.
			const withCallContext = (kwargs: Record<string, unknown>): Record<string, unknown> =>
				callContext === undefined ? kwargs : { ...kwargs, context: callContext };
			let preImage: Array<Record<string, unknown>> = [];
			if (isCrud && deps.recordDataOp) {
				const ids = Array.isArray(a.ids) ? a.ids : [];
				if (method === "write" && ids.length > 0) {
					const fields = Object.keys(a.values ?? {});
					const pre = await client.executeKw<Array<Record<string, unknown>>>(
						model,
						"read",
						[ids],
						withCallContext(fields.length > 0 ? { fields } : {}),
					);
					if (pre.ok && Array.isArray(pre.value)) preImage = pre.value;
				} else if (method === "unlink" && ids.length > 0) {
					const pre = await client.executeKw<Array<Record<string, unknown>>>(model, "read", [ids], withCallContext({}));
					if (pre.ok && Array.isArray(pre.value)) preImage = pre.value;
				}
			}

			// ---- execute ----------------------------------------------------
			const rpc = await client.executeKw<unknown>(model, method, callArgs, callKwargs, undefined, exec?.signal as AbortSignal | undefined);
			if (!rpc.ok) {
				// A business action that never answered is an UNKNOWN outcome, not a
				// failure: the call was sent and the server may have acted, so a retry
				// is the wrong move. (One rule, shared with the batch executor.)
				const unknownOutcome = isBusiness && isIndeterminateFor(method, rpc.errorKind);
				// Domain failure over a successful transport: keep `denied:false`
				// (this is NOT a policy denial) but mark it unmistakably so the
				// model, the renderer and any text consumer never read it as OK,
				// and record it as an ERROR in the audit trail.
				deps.auditFailure?.({
					tool: "odoo_execute",
					op: `${model}.${method}`,
					...(typeof exec?.callId === "string" ? { callId: exec.callId } : {}),
					reason: `${unknownOutcome ? "INDETERMINATE" : "SERVER ERROR"}: ${String(rpc.error).slice(0, 500)}`,
				}, exec);
				if (unknownOutcome) {
					return {
						denied: false,
						reason:
							`INDETERMINATE: "${model}.${method}" was sent and its outcome is UNKNOWN (transport/protocol ` +
							"failure, not a refusal). It was NOT retried: read the records it acts on before doing anything else.",
						result: rpc.error,
					};
				}
				return { denied: false, reason: "SERVER ERROR — RPC call failed", result: rpc.error };
			}

			// The state proof is read back BEFORE the call can be reported as OK:
			// without it, "OK" only means the server accepted the call.
			let proof: string | null = null;
			if (postcondition !== undefined) {
				const post = await checkCondition(client, model, postcondition, callContext);
				if (!post.ok) {
					return {
						denied: false,
						reason:
							`POSTCONDITION NOT MET: "${model}.${method}" ran, but the state it promised was not reached ` +
							`(${post.detail}). The call WAS sent, so the instance may be partially changed: inspect it ` +
							"before retrying anything.",
						result: JSON.stringify(rpc.value).slice(0, 4000),
					};
				}
				proof = post.detail;
			}

			// ---- journal the applied mutation (best-effort undo) ------------
			// CRUD only: a business action changes records the plugin never read, so
			// journaling it would promise an undo that cannot exist.
			if (isCrud && deps.recordDataOp) {
				const ids = Array.isArray(a.ids) ? a.ids : [];
				const createdIds = method === "create" && typeof rpc.value === "number" ? [rpc.value] : [];
				deps.recordDataOp({
					model,
					method: method as "create" | "write" | "unlink",
					ids,
					preImage,
					createdIds,
					...(callContext !== undefined ? { context: callContext } : {}),
				}, exec);
			}

			// What this call did NOT have is part of the answer: an agent that reads
			// "OK" for a business action must know there is no undo, no confirmation
			// of the starting state and no proof of the result.
			const notes: string[] = [];
			if (isBusiness) {
				notes.push("business action: NOT journaled, so no undo exists for this call");
				if (precondition === undefined) {
					notes.push("no precondition declared: the starting state was not confirmed (most business actions are not idempotent)");
				}
				if (postcondition === undefined) {
					notes.push("no postcondition declared: OK here only means the server accepted the call — declare `postcondition` to read back the state it promised");
				}
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					notes.push("no `ids` given: the method was called on an empty recordset");
				}
			}
			if (proof !== null) notes.push(`postcondition holds (${proof})`);
			const suffix = notes.length === 0 ? "" : "\n" + notes.map((n) => `- ${n}`).join("\n");
			return { denied: false, reason: `${model}.${method} OK${suffix}`, result: JSON.stringify(rpc.value).slice(0, 4000) };
		},
	}));

	// -----------------------------------------------------------------
	// odoo_validate — local, instance-free module structure validation
	// -----------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_validate",
		description:
			"Validate a module directory WITHOUT a running instance: __manifest__.py present, declared data " +
			"XML files exist, and the SECURITY model is coherent — every new model (models/*.py `_name`) must " +
			"have a line in security/ir.model.access.csv, and referenced group xmlids must resolve inside the " +
			"module (or be base.* groups). Returns file:line findings (ERROR/WARN). NO server required.",
		parameters: {
			module_dir: { type: "string", required: true, description: "Absolute path to the module directory (must contain __manifest__.py)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					valid: { type: "boolean", required: true },
					findings: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					detail: { type: "string", required: true },
					moduleDir: { type: "string", required: true },
					projectRoot: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				const v = value as { detail: string };
				return [{ type: "text", text: v.detail }];
			},
		},
		async execute(args: { module_dir: string }, exec?: unknown) {
			// Absolute (POSIX or Windows) as given; relative against the project
			// root OF THE CALLING SESSION, never against the process cwd.
			const projectRoot = deps.projectRoot(exec);
			const moduleDir = resolveModuleDir(args.module_dir, projectRoot);
			const moduleName = basename(moduleDir);
			const manifestPath = join(moduleDir, "__manifest__.py");
			const findings: Array<{ severity: string; file: string; message: string }> = [];
			if (!existsSync(manifestPath)) {
				findings.push({ severity: "ERROR", file: manifestPath, message: "__manifest__.py not found." });
				return {
					valid: false,
					findings,
					detail:
						"No __manifest__.py — invalid module.\n" +
						`Resolved module_dir: ${deps.display(moduleDir)} (project root: ${deps.display(projectRoot)})`,
					moduleDir,
					projectRoot,
				};
			}
			const manifestText = readFileSync(manifestPath, "utf8");
			if (!/'depends'\s*:/.test(manifestText)) {
				findings.push({ severity: "WARN", file: "__manifest__.py", message: "No 'depends' section." });
			}

			// ---- declared data files exist and parse -------------------------
			/**
			 * A declared file list (`data` or `demo`) must point at files that
			 * exist and look like Odoo XML. `label` says which key declared it, so
			 * a missing demo file does not read as a missing view.
			 */
			const checkDeclaredFiles = (key: string, label: string): string[] => {
				const match = new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]*)\\]`).exec(manifestText);
				const found: string[] = [];
				if (!match || match[1]!.trim() === "") return found;
				for (const tok of match[1]!.split(",")) {
					const rel = tok.replace(/['"\s]/g, "").trim();
					if (rel === "") continue;
					const filePath = join(moduleDir, rel);
					if (!existsSync(filePath)) {
						findings.push({
							severity: "ERROR",
							file: rel,
							message: `Declared ${label} file not found.`,
						});
						continue;
					}
					if (!rel.endsWith(".xml")) continue;
					found.push(rel);
					let xmlText = "";
					try {
						xmlText = readFileSync(filePath, "utf8");
					} catch {
						continue;
					}
					if (!/\s*<(openerp|odoo|record)\b/.test(xmlText)) {
						findings.push({ severity: "WARN", file: rel, message: `XML root not recognized (declared as ${label}).` });
					}
					ocaXmlRules(rel, xmlText);
				}
				return found;
			};
			/**
			 * The three OCA conventions that are mechanically checkable. They are
			 * WARN: a reviewer can accept an exception, but a silent violation is
			 * what makes a data file unreadable six months later. Both ordering
			 * rules compare POSITIONS inside the tag — an attribute that is present
			 * but late is exactly the case they exist for.
			 */
			const ocaXmlRules = (rel: string, xml: string): void => {
				const lateRecordId = [...xml.matchAll(/<record\b[^>]*>/g)].some((m) => {
					const tag = m[0];
					const modelAt = tag.indexOf("model=");
					if (modelAt === -1) return false;
					const idAt = tag.indexOf("id=");
					return idAt === -1 || idAt > modelAt;
				});
				if (lateRecordId) {
					findings.push({
						severity: "WARN",
						file: rel,
						message: "OCA: a <record> declares `model` before `id` — write `id` first so the record is identifiable at a glance.",
					});
				}
				const lateFieldName = [...xml.matchAll(/<field\b[^>]*>/g)].some((m) => {
					const tag = m[0];
					const evalAt = tag.indexOf("eval=");
					if (evalAt === -1) return false;
					const nameAt = tag.indexOf("name=");
					return nameAt === -1 || nameAt > evalAt;
				});
				if (lateFieldName) {
					findings.push({
						severity: "WARN",
						file: rel,
						message: "OCA: a <field> declares `eval` before `name` — write `name` first.",
					});
				}
				// Inside its own module, `<record id="my_module.x">` is redundant: the
				// module part is derived from the file's location.
				const prefix = `${moduleName}.`;
				for (const m of xml.matchAll(/<record[^>]*\bid=["']([^"']+)["']/g)) {
					const id = m[1]!;
					if (id.startsWith(prefix)) {
						findings.push({
							severity: "WARN",
							file: rel,
							message: `OCA: external id "${id}" repeats this module's own name — write id="${id.slice(prefix.length)}".`,
						});
						break;
					}
				}
			};
			const declaredXml: string[] = checkDeclaredFiles("data", "data");
			const declaredDemo = checkDeclaredFiles("demo", "demo");

			// ---- demo data: declared, or an orphan nobody loads ---------------
			const demoDir = join(moduleDir, "demo");
			if (existsSync(demoDir)) {
				let demoFiles: string[] = [];
				try {
					demoFiles = readdirSync(demoDir).filter((f) => f.endsWith(".xml"));
				} catch {
					demoFiles = [];
				}
				const declaredBare = new Set(declaredDemo.map((rel) => rel.replace(/^demo\//, "")));
				const orphans = demoFiles.filter((f) => !declaredBare.has(f));
				if (orphans.length > 0) {
					findings.push({
						severity: "WARN",
						file: `demo/${orphans[0]!}`,
						message:
							`${orphans.length} file(s) under demo/ are not declared in the manifest's "demo" key ` +
							`(${orphans.slice(0, 3).join(", ")}) — nothing loads them.`,
					});
				}
			}

			// ---- a tour that no asset bundle loads never runs -----------------
			const tourFiles: string[] = [];
			const collectTours = (rel: string): void => {
				const abs = join(moduleDir, rel);
				if (!existsSync(abs)) return;
				let stack = [abs];
				while (stack.length > 0) {
					const current = stack.pop()!;
					let entries: string[] = [];
					try {
						entries = readdirSync(current);
					} catch {
						continue;
					}
					for (const entry of entries) {
						const child = join(current, entry);
						let isDir = false;
						try {
							isDir = lstatSync(child).isDirectory();
						} catch {
							continue;
						}
						if (isDir) stack.push(child);
						else if (entry.endsWith(".js")) tourFiles.push(child.slice(moduleDir.length + 1));
					}
				}
			};
			collectTours(join("static", "src"));
			collectTours(join("static", "tests"));
			if (tourFiles.length > 0) {
				const bundled = /assets_tests/.test(manifestText) || /"assets"\s*:/.test(manifestText) || /'assets'\s*:/.test(manifestText);
				if (!bundled) {
					findings.push({
						severity: "WARN",
						file: tourFiles[0]!,
						message:
							`${tourFiles.length} JS file(s) under static/ (e.g. ${tourFiles[0]}) but the manifest declares no ` +
							'asset bundle — a tour outside "web.assets_tests" is never loaded by the test runner.',
					});
				}
			}

			// ---- new models declared in models/*.py --------------------------
			const newModels: Array<{ name: string; file: string }> = [];
			const modelsDir = join(moduleDir, "models");
			if (existsSync(modelsDir)) {
				for (const fileName of readdirSync(modelsDir)) {
					if (!fileName.endsWith(".py")) continue;
					let text = "";
					try {
						text = readFileSync(join(modelsDir, fileName), "utf8");
					} catch {
						continue;
					}
					for (const line of text.split(/\r?\n/)) {
						const m = /^\s*_name\s*=\s*["']([a-z0-9_.]+)["']/.exec(line);
						if (m) newModels.push({ name: m[1]!, file: `models/${fileName}` });
					}
				}
			}

			// ---- security coherence -----------------------------------------
			const aclPath = join(moduleDir, "security", "ir.model.access.csv");
			const aclExists = existsSync(aclPath);
			if (newModels.length > 0 && !aclExists) {
				findings.push({
					severity: "ERROR",
					file: "security/ir.model.access.csv",
					message: `Module declares ${newModels.length} new model(s) (${newModels.map((m) => m.name).join(", ")}) but has no ACL file.`,
				});
			}
			if (aclExists) {
				const acl = readFileSync(aclPath, "utf8");
				const aclLines = acl.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("id,"));
				const aclModels = new Set<string>();
				const referencedGroups = new Set<string>();
				// Odoo derives a model's xmlid from its name with dots as underscores.
				const modelKey = (name: string): string => name.replace(/\./g, "_").replace(/^model_/, "");
				for (const line of aclLines) {
					const parts = line.split(",");
					if (parts.length < 5) {
						findings.push({ severity: "WARN", file: "security/ir.model.access.csv", message: `Malformed ACL row (expected id,name,model_id:id,group_id:id,perm_*): ${line.slice(0, 60)}` });
						continue;
					}
					aclModels.add(modelKey(parts[2]!.trim()));
					const groupRef = parts[3]!.trim();
					if (groupRef !== "" && groupRef !== "group_id:id") referencedGroups.add(groupRef);
				}
				for (const model of newModels) {
					if (!aclModels.has(modelKey(model.name))) {
						findings.push({
							severity: "ERROR",
							file: "security/ir.model.access.csv",
							message: `New model "${model.name}" (${model.file}) has no ACL row — add model_${modelKey(model.name)}.`,
						});
					}
				}
				// Groups must resolve inside the module (declared res.groups records)
				// or be a base group; an external module cannot be verified locally.
				const declaredGroupIds = new Set<string>();
				for (const rel of declaredXml) {
					try {
						const xml = readFileSync(join(moduleDir, rel), "utf8");
						for (const m of xml.matchAll(/<record[^>]*\bid=["']([^"']+)["'][^>]*model=["']res\.groups["']/g)) declaredGroupIds.add(m[1]!);
						for (const m of xml.matchAll(/<record[^>]*\bmodel=["']res\.groups["'][^>]*\bid=["']([^"']+)["']/g)) declaredGroupIds.add(m[1]!);
					} catch {
						// unreadable file already reported
					}
				}
				for (const ref of referencedGroups) {
					const bare = ref.includes(".") ? ref.split(".").pop()! : ref;
					const isBase = ref.startsWith("base.") || ref.startsWith("base_");
					const isOwn = declaredGroupIds.has(bare) || ref === `${moduleName}.${bare}`;
					if (!isBase && !isOwn) {
						findings.push({
							severity: "WARN",
							file: "security/ir.model.access.csv",
							message: `Group "${ref}" is neither a base.* group nor a res.groups record declared by this module — verify it exists.`,
						});
					}
				}
			}

			// ---- record rules reference groups ------------------------------
			for (const rel of declaredXml) {
				let xml = "";
				try {
					xml = readFileSync(join(moduleDir, rel), "utf8");
				} catch {
					continue;
				}
				if (/model=["']ir\.rule["']/.test(xml) && !/groups/.test(xml)) {
					findings.push({
						severity: "WARN",
						file: rel,
						message: "Record rule (ir.rule) without an explicit `groups` field — it applies globally.",
					});
				}
			}

			const errors = findings.filter((f) => f.severity === "ERROR").length;
			const resolved = `Resolved module_dir: ${deps.display(moduleDir)} (project root: ${deps.display(projectRoot)})`;
			const detail = (findings.length === 0
				? `Module structure and security model OK (${newModels.length} new model(s), ACL present=${aclExists}).`
				: `${errors} ERROR(s), ${findings.length - errors} WARNING(s) — ${newModels.length} new model(s). Review findings.`) +
				`\n${resolved}`;
			return { valid: errors === 0, findings, detail, moduleDir, projectRoot };
		},
	}));
}