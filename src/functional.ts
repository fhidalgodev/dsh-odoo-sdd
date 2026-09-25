/**
 * `odoo_functional` — the batch executor of the functional path.
 *
 * A functional run changes a LIVE instance: it configures and it imports. The
 * difference between that and "an agent with RPC access" is entirely in this
 * module, and it is deliberate:
 *
 *   - nothing runs without a batch that a HUMAN approved, bound by hashes to the
 *     spec, the design, the plan and the operation list;
 *   - every operation is persisted BEFORE it is sent and after it returns, so a
 *     crash leaves a recorded intention, never a silent maybe;
 *   - a mutation whose answer never arrived is INDETERMINATE, not "failed": a
 *     blind retry can double-apply, so the batch stops and a human reconciles;
 *   - the declared environment gates the run (`dev`, `staging`, `production`),
 *     and production additionally needs a declared backup plus its own approval;
 *   - one writer at a time, and the compensation is another approved batch built
 *     from what the journal recorded.
 *
 * The plan, the run state and an import mapping live under
 * `.sdd/functional/<spec-id>/`, never inside the project's source tree.
 *
 * @module dsh-odoo-sdd/functional
 */
import {
	READ_METHODS,
	MUTATING_METHODS,
	isBusinessMethod,
	businessMethodAllowed,
	isIndeterminateFor,
} from "./method-classification.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readJsonWithRecovery, writeFileAtomic } from "./atomic.js";
import type { TargetEnvironment } from "./credentials.js";
import type { RpcErrorKind } from "./odoo-client.js";

/** What a batch is allowed to do. Each scope is approved separately. */
export type BatchScope = "discovery" | "import-prep" | "apply" | "compensate";

/** Method classification, shared with odoo_execute (fail-closed elsewhere). */

/**
 * How an operation is carried out.
 *
 * `method` is a business action — any method of any model that is neither a read
 * nor CRUD, and therefore not replayable from a pre-image. It runs only when the exact `model.method`
 * pair is allowlisted and both a precondition and a postcondition are declared
 * — see `validateBatch`.
 */
export type OperationKind = "execute" | "import" | "method";

/** What kind of data an import carries: real business data, or a sample. */
export type ImportDataKind = "real" | "sample";

/** The declaration of an `import` operation (Odoo's own importer). */
export interface ImportOperationSpec {
	/** Database id of the temporary `base_import.import` record holding the file. */
	importId: number;
	/** Original file name, for the report and the runbook. */
	fileName: string;
	/**
	 * Whether the file carries real business data or a sample/demo dataset.
	 *
	 * DECLARED, never guessed: the file name is a hint at most, and the cost of
	 * being wrong is asymmetric — loading demo rows into a production database is
	 * not undone by the plugin's journal. An undeclared import in production is
	 * therefore refused (see `validateBatch`).
	 */
	dataKind?: ImportDataKind;
	/** Column mapping: one decision per column of the file. */
	columns: unknown[];
	/** Importer options (headers, separator, encoding…). */
	options: Record<string, unknown>;
	/** True for a test run: Odoo executes the ORM logic but does not commit the rows. */
	dryRun: boolean;
}

/** One declared operation inside a batch. */
export interface BatchOperation {
	/**
	 * How the operation runs. `execute` (default) is a plain `execute_kw`;
	 * `import` drives Odoo's native importer through the web route, which needs a
	 * session and a version contract — the executor delegates it to the runner the
	 * registrant supplies, so the batch, the approval and the journal stay the same.
	 */
	kind?: OperationKind;
	/** Present when `kind === "import"`. */
	import?: ImportOperationSpec;
	/** What this operation is for, in business terms (it ends up in the runbook). */
	intent: string;
	model: string;
	method: string;
	/** Positional args EXACTLY as `execute_kw` expects them. */
	args?: unknown[];
	/** Keyword args (context is added from the batch, never per operation). */
	kwargs?: Record<string, unknown>;
	/**
	 * Records this operation acts on, declared as stable key/value pairs. Used by
	 * `reconcile` to decide an indeterminate outcome, and by the runbook.
	 */
	identity?: Array<{ field: string; value: unknown }>;
	/** Read that must hold BEFORE the operation runs. */
	precondition?: { domain: unknown[]; expect: "exists" | "missing" | "count"; count?: number };
	/**
	 * Read that must hold AFTER the operation ran, checked before it can be
	 * recorded as applied. Without it, "applied" would only mean "the RPC
	 * answered": an operation that returns `True` while leaving the records in
	 * their previous state would be indistinguishable from one that worked.
	 *
	 * Same shape as `precondition` on purpose — same helper, same semantics.
	 */
	postcondition?: { domain: unknown[]; expect: "exists" | "missing" | "count"; count?: number };
	/** What the operation is expected to produce. */
	expect?: { kind: "created" | "updated" | "deleted" | "count"; count?: number };
	/**
	 * How this operation is undone; `none` means "cannot be undone reliably" and
	 * `manual` that a person reverses it following the runbook.
	 */
	recovery?: { kind: "unlink_created" | "restore_preimage" | "none" | "manual"; note?: string };
}

/** One approved unit of work. */
export interface Batch {
	id: string;
	scope: BatchScope;
	title: string;
	/** Acceptance criteria (as written in test-plan.md) this batch is expected to satisfy. */
	acceptance: string[];
	/** Companies the batch may touch; empty means "the client's default company". */
	companies: number[];
	/** Odoo context for every operation of the batch (company/lang/tz). */
	context?: Record<string, unknown>;
	operations: BatchOperation[];
	/** High-risk work (fiscal, stock valuation, deletions, external effects). */
	highRisk?: boolean;
	/** Operator-confirmed backup identifier; REQUIRED for high risk in production. */
	backupReference?: string;
	/** Steps a human follows to reproduce this batch by hand (runbook material). */
	manualSteps?: string[];
}

/** The persisted plan of one functional spec. */
export interface FunctionalPlan {
	specId: string;
	/** Declared environment this plan was written for. */
	environment: TargetEnvironment;
	/** Detected server version the plan was written against. */
	serverVersion?: string;
	batches: Batch[];
}

/** State of one executed operation. */
export type OpState = "pending" | "in_progress" | "applied" | "failed" | "indeterminate";

/** Persisted record of one attempted operation. */
export interface OpRecord {
	batchId: string;
	scope: BatchScope;
	index: number;
	model: string;
	method: string;
	intent: string;
	state: OpState;
	/** ISO instant the send was started (persisted BEFORE the call). */
	attemptedAt?: string;
	/** ISO instant the result was persisted. */
	resultAt?: string;
	/** Sanitized error, when there was one. */
	error?: string;
	/** Ids the operation created (for compensation). */
	createdIds?: number[];
	/** Ids the operation touched. */
	ids?: number[];
	/** Pre-image rows captured before a write/unlink (for compensation). */
	preImage?: Array<Record<string, unknown>>;
	/** Result of the declared postcondition (evidence for verify and the runbook). */
	postcondition?: string;
	/** How it was resolved, when reconcile ran. */
	resolution?: string;
}

/** Durable run state of one spec. */
export interface FunctionalRun {
	specId: string;
	/** `running` while a batch is being applied, `idle` otherwise. */
	state: "idle" | "running" | "blocked" | "done";
	/** Lock identity: the tool call applying a batch, with when it took it. */
	lock?: { callId: string; at: string; batchId: string };
	/** Batch currently applied (or the last one). */
	batchId?: string;
	ops: OpRecord[];
	updatedAt: string;
}

/** Where one spec's functional state lives. */
export function functionalDir(projectRoot: string, specId: string): string {
	return join(projectRoot, ".sdd", "functional", isSafeSegment(specId) ? specId : "__invalid__");
}

/** Narrow a value to a safe single path segment (mirrors checkpoints.ts). */
export function isSafeSegment(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		!value.includes("\0") &&
		value !== ".." &&
		value !== "." &&
		!value.includes("/") &&
		!value.includes("\\")
	);
}

/** Stable JSON of a value with object keys sorted, for hashing. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** sha256 of a string, hex. */
export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Fingerprint of one batch, bound to everything that must not change after
 * approval: the target, the spec and design hashes, the plan and the operations.
 */
export function batchFingerprint(input: {
	projectRoot: string;
	specId: string;
	target: string;
	environment: TargetEnvironment;
	specHash: string;
	designHash: string;
	planHash: string;
	batch: Batch;
}): string {
	return sha256(
		canonical({
			projectRoot: input.projectRoot,
			specId: input.specId,
			target: input.target,
			environment: input.environment,
			specHash: input.specHash,
			designHash: input.designHash,
			planHash: input.planHash,
			batchId: input.batch.id,
			scope: input.batch.scope,
			companies: [...input.batch.companies].sort((a, b) => a - b),
			context: input.batch.context ?? {},
			operations: input.batch.operations.map((op) => ({
				intent: op.intent,
				model: op.model,
				method: op.method,
				args: op.args ?? [],
				kwargs: op.kwargs ?? {},
			})),
		}),
	);
}

/** sha256 of a plan's batches (identity of the plan as approved). */
export function planHash(plan: FunctionalPlan): string {
	return sha256(canonical(plan.batches));
}

/** Read one file of the spec's functional state, tolerating absence/corruption. */
function readState<T>(projectRoot: string, specId: string, name: string): T | null {
	const file = join(functionalDir(projectRoot, specId), name);
	const result = readJsonWithRecovery<T>(file);
	return result.status === "ok" ? result.value : null;
}

/**
 * Persist one file of the spec's functional state (atomic; throws on failure).
 *
 * Exported because it is the module's storage contract: the registrant and the
 * tests must be able to write a plan/run without reaching into the path layout
 * by hand.
 * @param projectRoot - project root owning the state.
 * @param specId - spec id (validated as a single path segment).
 * @param name - file name inside `.sdd/functional/<specId>/`.
 * @param value - JSON-serializable content.
 */
export function writeState(projectRoot: string, specId: string, name: string, value: unknown): void {
	const dir = functionalDir(projectRoot, specId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileAtomic(join(dir, name), JSON.stringify(value, null, 2));
}

/** The persisted plan of a spec, or null. */
export function readPlan(projectRoot: string, specId: string): FunctionalPlan | null {
	return readState<FunctionalPlan>(projectRoot, specId, "plan.json");
}

/** The durable run state of a spec (a fresh one when absent). */
export function readRun(projectRoot: string, specId: string): FunctionalRun {
	const existing = readState<FunctionalRun>(projectRoot, specId, "run.json");
	if (existing !== null && Array.isArray(existing.ops)) return existing;
	return { specId, state: "idle", ops: [], updatedAt: new Date().toISOString() };
}

/** Persist the run state. STRICT: a failed write must stop the run, not be ignored. */
export function writeRun(projectRoot: string, run: FunctionalRun): void {
	writeState(projectRoot, run.specId, "run.json", { ...run, updatedAt: new Date().toISOString() });
}

/**
 * Whether a functional run is currently applying a batch for this project.
 * The policy guard uses it to close every OTHER mutation path while a run is
 * active, so an approved plan cannot be bypassed by calling `odoo_execute`.
 */
export function activeFunctionalRun(projectRoot: string): { specId: string; batchId: string } | null {
	const base = join(projectRoot, ".sdd", "functional");
	if (!existsSync(base)) return null;
	let entries: string[] = [];
	try {
		entries = readdirSync(base);
	} catch {
		return null;
	}
	for (const specId of entries) {
		const run = readState<FunctionalRun>(projectRoot, specId, "run.json");
		if (run !== null && run.state === "running" && run.lock !== undefined) {
			return { specId, batchId: run.lock.batchId };
		}
	}
	return null;
}

/** One validation finding over a plan or a batch. */
export interface PlanFinding {
	severity: "ERROR" | "WARN";
	where: string;
	message: string;
}

/** What the validator needs from the configuration to judge a batch. */
export interface ValidateOptions {
	/** Declared `"model.method"` pairs a business action may use. */
	methodAllowlist?: readonly string[];
}

/**
 * Validate one batch fail-closed, BEFORE it can be approved.
 *
 * Everything rejected here is something that would otherwise be discovered while
 * the batch is already mutating a live database: an unclassified method, a
 * missing recovery, a mutation hidden inside a discovery batch, a create with no
 * way to know what it created.
 * @param batch - the batch to validate.
 * @param environment - declared environment of the target.
 * @returns the findings (ERROR blocks approval).
 */
export function validateBatch(batch: Batch, environment: TargetEnvironment, options: ValidateOptions = {}): PlanFinding[] {
	const findings: PlanFinding[] = [];
	const allowedMethods = options.methodAllowlist ?? [];
	const where = `batch ${batch.id}`;
	if (batch.operations.length === 0) findings.push({ severity: "ERROR", where, message: "the batch has no operations" });
	if (batch.acceptance.length === 0) {
		findings.push({ severity: "WARN", where, message: "no acceptance criterion is claimed by this batch" });
	}
	if (batch.scope === "apply" && batch.companies.length === 0) {
		findings.push({
			severity: "WARN",
			where,
			message: "no company declared: the batch will run in the client's default company — state it explicitly",
		});
	}
	batch.operations.forEach((op, index) => {
		const at = `${where} op ${index + 1} (${op.model}.${op.method})`;
		if (op.kind === "import") {
			// An import is a mutation by definition, and it must carry what the
			// importer needs: a prepared file, a target model and a mapping where
			// every column has a decision.
			const spec = op.import;
			if (spec === undefined) {
				findings.push({ severity: "ERROR", where: at, message: "an import operation needs its `import` block (importId, fileName, columns, options)" });
			} else {
				if (!Number.isInteger(spec.importId) || spec.importId <= 0) {
					findings.push({ severity: "ERROR", where: at, message: "importId must be the id of a prepared base_import.import record" });
				}
				if ((spec.fileName ?? "").trim() === "") {
					findings.push({ severity: "ERROR", where: at, message: "fileName is required: the runbook has to name the file that was imported" });
				}
				if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
					findings.push({ severity: "ERROR", where: at, message: "an import needs a column mapping; a mapping with no columns imports nothing" });
				}
				if (spec.dryRun !== true) {
					findings.push({
						severity: "WARN",
						where: at,
						message: "this batch APPLIES the import; run a dry run (dryRun: true) first when the file or the mapping is new",
					});
				}
				// Sample data in a real environment. The declaration is the whole
				// point: the plugin cannot tell a demo file from a customer list by
				// reading it, and demo rows land in the same tables as real ones.
				if (spec.dataKind !== undefined && spec.dataKind !== "real" && spec.dataKind !== "sample") {
					findings.push({
						severity: "ERROR",
						where: at,
						message: `dataKind must be "real" or "sample" (got ${JSON.stringify(spec.dataKind)})`,
					});
				}
				if (environment === "production" && spec.dataKind === undefined) {
					findings.push({
						severity: "ERROR",
						where: at,
						message:
							"an import into production must declare `dataKind` (\"real\", or \"sample\" for a demo/test dataset): " +
							"the plugin cannot tell them apart from the file, and demo rows are not undone by the journal",
					});
				}
				if (spec.dataKind === "sample") {
					const looksReal = !/demo|sample|example|ejemplo|test|prueba|fixture/i.test(spec.fileName ?? "");
					if (environment === "production") {
						findings.push({
							severity: "ERROR",
							where: at,
							message:
								"sample/demo data cannot be imported into production: load it in dev or staging. " +
								"If this file really is business data, declare dataKind: \"real\".",
						});
					} else if (environment === "staging") {
						findings.push({
							severity: "WARN",
							where: at,
							message: "this batch loads sample/demo data into staging — confirm nobody will read it as real business data",
						});
					} else if (looksReal) {
						// The name is only a hint: it never decides, it only helps the
						// operator notice a mislabelled file before it lands.
						findings.push({
							severity: "WARN",
							where: at,
							message: `"${spec.fileName}" is declared as sample data but its name does not say so — confirm the declaration is right`,
						});
					}
				}
				const undecided = spec.columns.filter((c) => {
					const column = c as { field?: unknown; decision?: unknown };
					return String(column.field ?? "").trim() === "" && String(column.decision ?? "").trim() !== "skip";
				});
				if (undecided.length > 0) {
					findings.push({
						severity: "ERROR",
						where: at,
						message: `${undecided.length} column(s) have no decision (a target field or an explicit decision: skip)`,
					});
				}
			}
			if (op.recovery === undefined) {
				findings.push({ severity: "ERROR", where: at, message: "an import must declare how it is recovered (delete the created ids, or the declared backup)" });
			}
			if (batch.scope === "discovery") {
				findings.push({ severity: "ERROR", where: at, message: "a discovery batch may only read: an import cannot live there" });
			}
			if (batch.scope !== "apply") {
				findings.push({ severity: "ERROR", where: at, message: `an import runs in an "apply" batch, not in a "${batch.scope}" one` });
			}
			return;
		}
		// ---- a business action (kind: "method") --------------------------
		// It runs only when the operator allowlisted the exact pair, and only
		// with a state guard and a state proof: the return value of a method is
		// not evidence, and its effect cannot be replayed from a pre-image.
		if (op.kind === "method") {
			if (!businessMethodAllowed(allowedMethods, op.model, op.method)) {
				findings.push({
					severity: "ERROR",
					where: at,
					message:
						`business action "${op.model}.${op.method}" is not allowlisted — declare it with odoo_config ` +
						`mode=set methodAllowlist=["${op.model}.${op.method}"], or make it a manual step in the runbook`,
				});
			}
			const ids = Array.isArray(op.args?.[0]) ? (op.args[0] as unknown[]) : [];
			if (ids.length === 0) {
				findings.push({
					severity: "ERROR",
					where: at,
					message: "a business action needs the record ids as its first argument (Odoo dispatches the method on that recordset)",
				});
			}
			if (op.precondition === undefined) {
				findings.push({
					severity: "ERROR",
					where: at,
					message:
						"a business action must declare a precondition: most are not idempotent, and confirming an " +
						"already-confirmed document is a different operation, not a retry",
				});
			}
			if (op.postcondition === undefined) {
				findings.push({
					severity: "ERROR",
					where: at,
					message:
						"a business action must declare a postcondition (the state that proves it worked): its return " +
						"value is True/None/dict and proves nothing",
				});
			}
			if (op.recovery?.kind === "restore_preimage" || op.recovery?.kind === "unlink_created") {
				findings.push({
					severity: "ERROR",
					where: at,
					message:
						`recovery "${op.recovery.kind}" cannot undo a business action: the plugin never read the records it ` +
						'changes. Use "none" or "manual" and write the reversal into the runbook',
				});
			}
			if (batch.scope === "discovery") {
				findings.push({ severity: "ERROR", where: at, message: "a discovery batch may only read" });
			}
			if (batch.scope !== "apply") {
				findings.push({ severity: "ERROR", where: at, message: `a business action runs in an "apply" batch, not in a "${batch.scope}" one` });
			}
			return;
		}
		if (!READ_METHODS.has(op.method) && !MUTATING_METHODS.has(op.method)) {
			findings.push({
				severity: "ERROR",
				where: at,
				message:
					`method "${op.method}" is not classified; only ${[...READ_METHODS, ...MUTATING_METHODS].join(", ")} can run. ` +
					`For a business action declare kind: "method" with ${op.model}.${op.method} in the methodAllowlist; ` +
					"for something only a button does, declare it as a manual step",
			});
			return;
		}
		const mutating = MUTATING_METHODS.has(op.method);
		if (mutating && op.postcondition === undefined) {
			// A nudge, not a gate: existing plans keep running, but an operation
			// that cannot show the state it produced is the one that lies later.
			findings.push({
				severity: "WARN",
				where: at,
				message:
					"no postcondition declared: add the state that proves this operation worked " +
					"({domain, expect, count}), so \"applied\" means the state was reached and not just that the RPC answered",
			});
		}
		if (batch.scope === "discovery" && mutating) {
			findings.push({ severity: "ERROR", where: at, message: "a discovery batch may only read" });
		}
		if (batch.scope !== "discovery" && !mutating) {
			findings.push({ severity: "WARN", where: at, message: "a read inside a mutating batch: keep reads in discovery" });
		}
		if (mutating && op.recovery === undefined) {
			findings.push({ severity: "ERROR", where: at, message: "a mutating operation must declare how it is recovered" });
		}
		if (mutating && op.recovery?.kind === "none") {
			findings.push({
				severity: environment === "production" ? "ERROR" : "WARN",
				where: at,
				message:
					"this operation cannot be undone. In production an irreversible operation needs its own batch and " +
					"its own approval, never a line inside a larger one",
			});
		}
		if (op.method === "write" || op.method === "unlink") {
			const ids = Array.isArray(op.args?.[0]) ? op.args[0] : [];
			if (ids.length === 0) {
				findings.push({ severity: "ERROR", where: at, message: `${op.method} needs explicit ids as the first argument` });
			}
		}
		if (op.method === "write" && (op.args?.[1] === undefined || typeof op.args[1] !== "object")) {
			findings.push({ severity: "ERROR", where: at, message: "write needs a values object as its second argument" });
		}
		if (mutating && (op.identity === undefined || op.identity.length === 0)) {
			findings.push({
				severity: "WARN",
				where: at,
				message: "no stable identity declared: an indeterminate result will not be reconcilable",
			});
		}
	});
	if (environment === "production") {
		if (batch.highRisk === true && (batch.backupReference ?? "").trim() === "") {
			findings.push({
				severity: "ERROR",
				where,
				message: "a high-risk batch in production requires backupReference (confirmed by the operator)",
			});
		}
		if (batch.manualSteps === undefined || batch.manualSteps.length === 0) {
			findings.push({
				severity: "WARN",
				where,
				message: "no manual steps recorded: the runbook will be thin for a production change",
			});
		}
	}
	return findings;
}

/** Counts of an operation set, for `status` and for the runbook. */
export function countOps(ops: OpRecord[]): Record<OpState, number> {
	const counts: Record<OpState, number> = { pending: 0, in_progress: 0, applied: 0, failed: 0, indeterminate: 0 };
	for (const op of ops) counts[op.state] += 1;
	return counts;
}

/** Minimal RPC surface this module needs (satisfied by OdooClient). */
export interface RpcLike {
	executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs: Record<string, unknown>,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<{ ok: true; value: T } | { ok: false; error: string; errorKind?: RpcErrorKind }>;
}

/** Outcome of one executed operation. */
export interface OpOutcome {
	ok: boolean;
	/** True when the outcome is UNKNOWABLE (sent, no answer): never retried blind. */
	indeterminate?: boolean;
	value?: unknown;
	error?: string;
}

/**
 * Execute one operation of a batch.
 *
 * The caller persists `in_progress` BEFORE calling this and the result after, so
 * the only state this function must get right is the classification: a transport
 * or protocol failure after a mutation is INDETERMINATE, while a server error is
 * a definite failure (Odoo answered and rolled the transaction back).
 * @param client - RPC client bound to the declared destination.
 * @param op - the declared operation.
 * @param context - batch context (company/lang/tz), applied to every call.
 * @returns the outcome, classified.
 */
export async function executeOperation(
	client: RpcLike,
	op: BatchOperation,
	context: Record<string, unknown> | undefined,
): Promise<OpOutcome> {
	const kwargs: Record<string, unknown> = { ...(op.kwargs ?? {}) };
	if (context !== undefined) kwargs["context"] = context;
	const res = await client.executeKw<unknown>(op.model, op.method, op.args ?? [], kwargs);
	if (res.ok) return { ok: true, value: res.value };
	// One rule for both surfaces: a timeout after sending a mutation means the
	// server may have acted, and calling that a plain failure would invite a retry
	// of something that already happened.
	const indeterminate = isIndeterminateFor(op.method, res.errorKind);
	return { ok: false, indeterminate, error: res.error };
}

/**
 * Evaluate a declared condition (a read) against the instance.
 *
 * One helper for both sides on purpose: `precondition` and `postcondition` are
 * the same assertion — a domain and how many records it must match — asked at
 * different moments. Two implementations would be two chances to disagree.
 * @param client - RPC client.
 * @param model - model the condition is about.
 * @param condition - domain plus the expected match.
 * @param context - batch context.
 * @returns whether it holds, and why not when it does not.
 */
export async function checkCondition(
	client: RpcLike,
	model: string,
	condition: { domain: unknown[]; expect: "exists" | "missing" | "count"; count?: number },
	context: Record<string, unknown> | undefined,
): Promise<{ ok: boolean; detail: string }> {
	const kwargs: Record<string, unknown> = {};
	if (context !== undefined) kwargs["context"] = context;
	const res = await client.executeKw<number>(model, "search_count", [condition.domain], kwargs);
	if (!res.ok) return { ok: false, detail: `the condition could not be checked: ${res.error}` };
	const found = typeof res.value === "number" ? res.value : 0;
	if (condition.expect === "exists" && found === 0) return { ok: false, detail: "expected at least one record and found none" };
	if (condition.expect === "missing" && found > 0) return { ok: false, detail: `expected no records and found ${found}` };
	if (condition.expect === "count" && typeof condition.count === "number" && found !== condition.count) {
		return { ok: false, detail: `expected ${condition.count} record(s) and found ${found}` };
	}
	return { ok: true, detail: `${found} record(s)` };
}

/**
 * Evaluate a precondition (a read) before an operation runs.
 * @param client - RPC client.
 * @param op - the operation carrying the precondition.
 * @param context - batch context.
 * @returns whether the precondition holds, and why not when it does not.
 */
export async function checkPrecondition(
	client: RpcLike,
	op: BatchOperation,
	context: Record<string, unknown> | undefined,
): Promise<{ ok: boolean; detail: string }> {
	const pre = op.precondition;
	if (pre === undefined) return { ok: true, detail: "no precondition declared" };
	const checked = await checkCondition(client, op.model, pre, context);
	if (!checked.ok) return checked;
	return { ok: true, detail: `precondition holds (${checked.detail})` };
}

/**
 * Evaluate the postcondition of an operation that has just run.
 *
 * A failure here is NOT a transport failure: the server answered, the call
 * happened, and the state it promised was not reached. That is why the caller
 * stops the batch and says so, instead of retrying something that already ran.
 * @param client - RPC client.
 * @param op - the operation carrying the postcondition.
 * @param context - batch context.
 * @returns whether it holds, and the evidence line for the run.
 */
export async function checkPostcondition(
	client: RpcLike,
	op: BatchOperation,
	context: Record<string, unknown> | undefined,
): Promise<{ ok: boolean; detail: string }> {
	const post = op.postcondition;
	if (post === undefined) return { ok: true, detail: "no postcondition declared" };
	return checkCondition(client, op.model, post, context);
}

/** Everything `odoo_functional` needs from the registrant. */
export interface FunctionalDeps {
	/** Project root of the calling session. */
	projectRoot(exec?: unknown): string;
	/** Absolute spec directory (honours the specs layout). */
	specDir(specId: string, exec?: unknown): string;
	/** Client for the session's project, or a report explaining why not. */
	client(exec?: unknown): { client: RpcLike | null; report: string; target?: string; environment?: TargetEnvironment };
	/** Ask the human through the host's native approval seam. */
	approve(exec: unknown, reason: string): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
	/** Declared `"model.method"` pairs a business action may use (empty = none). */
	methodAllowlist?(exec?: unknown): readonly string[];
	/** Hashes of the spec and design documents the approval is bound to. */
	hashes(specId: string, exec?: unknown): { specHash: string; designHash: string };
	/**
	 * Journal one applied mutation so the checkpoint data-undo can replay it.
	 * Receives the execution because the journal belongs to the SESSION's project.
	 */
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
	/** Grant helpers, so the receipts live in the same file as the others. */
	grants: {
		write(input: { kind: "batch"; fingerprint: string; ttlMinutes?: number; reason?: string; details?: Record<string, unknown> }): void;
		valid(fingerprint: string): boolean;
	};
	/**
	 * Run an `import` operation: the registrant owns the web session, the CSRF
	 * token and the version contract, and returns the classified outcome. Supplying
	 * it is what keeps a batch able to declare an import at all; without it an
	 * import operation is refused rather than silently skipped.
	 */
	runImport?(op: BatchOperation, exec?: unknown): Promise<OpOutcome>;
	/** Record one executed operation in the append-only audit log. */
	audit?(entry: {
		batchId: string;
		scope: BatchScope;
		model: string;
		method: string;
		state: OpState;
		index: number;
		reason?: string;
	}): void;
	/** Path masking for display. */
	display(pathValue: string): string;
}

/** Register `odoo_functional` on the host tool registry. */
export function registerFunctionalTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: FunctionalDeps,
): void {
	ctx.tools.register(defineTool({
		name: "odoo_functional",
		description:
			"Execute an APPROVED functional batch against the connected instance: plan, approve (native human " +
			"approval bound to hashes), apply, status, reconcile, verify and compensate. Nothing mutates without " +
			"the batch approval, operations run one at a time with their state persisted before and after the " +
			"call, and a mutation whose answer never arrived is reported as INDETERMINATE instead of retried. " +
			"The declared environment (ODOO_SDD_ENVIRONMENT) gates the run: production additionally needs a " +
			"declared backup and its own approval. While a batch is running, every other mutation path is denied.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["plan", "approve", "apply", "inspect", "status", "reconcile", "verify", "compensate"],
				description:
					"plan (validate and store a batch) | approve (native approval for one batch+scope) | apply " +
					"(execute an approved batch) | inspect (read-only discovery under its own scope) | status | " +
					"reconcile (decide indeterminate outcomes) | verify (evidence per AC) | compensate (build the " +
					"undo batch from the journal).",
			},
			spec_id: { type: "string", required: true, description: "Spec directory id, e.g. 001-company-setup." },
			batch: { type: "object", additionalProperties: true, description: "operation=plan: the full batch to validate and store." },
			batch_id: { type: "string", description: "Batch id for approve/apply/compensate." },
			scope: { type: "string", enum: ["discovery", "import-prep", "apply", "compensate"], description: "Scope to approve (approve/apply)." },
			environment: { type: "string", enum: ["dev", "staging", "production"], description: "Declared environment the plan targets (plan only)." },
			server_version: { type: "string", description: "Detected server version the plan was written against (plan only)." },
			release_stale_lock: { type: "boolean", description: "apply only: take over a lock left by an interrupted call (recorded in the audit)." },
			confirm_destructive: { type: "boolean", description: "apply/compensate: REQUIRED true to actually send mutations." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					operation: { type: "string", required: true },
					specId: { type: "string", required: true },
					batchId: { type: "string" },
					scope: { type: "string" },
					status: { type: "string", required: true },
					counts: { type: "object", additionalProperties: true },
					batches: { type: "array", items: { type: "object", additionalProperties: true } },
					findings: { type: "array", items: { type: "object", additionalProperties: true } },
					results: { type: "array", items: { type: "object", additionalProperties: true } },
					evidence: { type: "array", items: { type: "string" } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [text(String((value as { detail: string }).detail))],
		},
		async execute(args: {
			operation: "plan" | "approve" | "apply" | "inspect" | "status" | "reconcile" | "verify" | "compensate";
			spec_id: string;
			batch?: Record<string, unknown>;
			batch_id?: string;
			scope?: BatchScope;
			environment?: TargetEnvironment;
			server_version?: string;
			release_stale_lock?: boolean;
			confirm_destructive?: boolean;
		}, exec?: unknown) {
			const projectRoot = deps.projectRoot(exec);
			const specId = args.spec_id.trim();
			const base = { ok: false, operation: args.operation as string, specId, status: "error" as string };
			if (!isSafeSegment(specId)) {
				return { ...base, detail: `Invalid spec_id "${args.spec_id}": it must be a single path segment.` };
			}

			// ---- plan ---------------------------------------------------------
			if (args.operation === "plan") {
				if (args.environment === undefined) {
					return { ...base, detail: "operation=plan requires environment (dev|staging|production): the environment is declared, never assumed." };
				}
				const batch = args.batch as unknown as Batch | undefined;
				if (batch === undefined || typeof batch !== "object" || typeof batch.id !== "string") {
					return { ...base, detail: "operation=plan requires a batch object with at least { id, scope, title, operations }." };
				}
				const findings = validateBatch(batch, args.environment, { methodAllowlist: deps.methodAllowlist?.(exec) ?? [] });
				const errors = findings.filter((f) => f.severity === "ERROR");
				if (errors.length > 0) {
					return {
						...base,
						status: "rejected",
						findings: findings.map((f) => ({ ...f })),
						detail:
							`Batch ${batch.id} rejected (${errors.length} error(s)); nothing was stored:\n` +
							findings.map((f) => `- [${f.severity}] ${f.where}: ${f.message}`).join("\n"),
					};
				}
				const plan: FunctionalPlan = readPlan(projectRoot, specId) ?? {
					specId,
					environment: args.environment,
					batches: [],
				};
				plan.environment = args.environment;
				if (args.server_version !== undefined) plan.serverVersion = args.server_version;
				plan.batches = [...plan.batches.filter((b) => b.id !== batch.id), batch];
				writeState(projectRoot, specId, "plan.json", plan);
				const warns = findings.filter((f) => f.severity === "WARN");
				return {
					...base,
					ok: true,
					batchId: batch.id,
					scope: batch.scope,
					status: "planned",
					findings: findings.map((f) => ({ ...f })),
					detail:
						`Batch ${batch.id} (${batch.scope}, ${batch.operations.length} operation(s)) stored for spec ${specId} ` +
						`in ${deps.display(join(functionalDir(projectRoot, specId), "plan.json"))}.` +
						(warns.length > 0 ? `\nWarnings:\n${warns.map((f) => `- ${f.where}: ${f.message}`).join("\n")}` : "") +
						"\nNext: operation=approve with the same batch_id and scope (a human approves the exact content).",
				};
			}

			// ---- status -------------------------------------------------------
			if (args.operation === "status") {
				const plan = readPlan(projectRoot, specId);
				const run = readRun(projectRoot, specId);
				const counts = countOps(run.ops);
				return {
					...base,
					ok: true,
					status: run.state,
					counts: { ...counts },
					batches: (plan?.batches ?? []).map((b) => ({
						id: b.id,
						scope: b.scope,
						title: b.title,
						operations: b.operations.length,
						highRisk: b.highRisk === true,
					})),
					detail:
						`Spec ${specId}: ${plan === null ? "no plan yet" : `${plan.batches.length} batch(es) planned, environment=${plan.environment}`}\n` +
						`run state: ${run.state}${run.lock === undefined ? "" : ` (locked by ${run.lock.callId} since ${run.lock.at})`}\n` +
						`operations: ${run.ops.length} — applied ${counts.applied}, failed ${counts.failed}, ` +
						`indeterminate ${counts.indeterminate}, pending ${counts.pending}`,
				};
			}

			const plan = readPlan(projectRoot, specId);
			if (plan === null) {
				return { ...base, status: "no-plan", detail: `No plan stored for spec ${specId}. Run operation=plan first.` };
			}

			// Everything below talks to the instance: it needs the client AND a
			// declared environment.
			const { client, report, target, environment } = deps.client(exec);
			if (client === null) return { ...base, status: "not-connected", detail: report };
			/**
			 * The environment belongs to the TARGET, never to the plan.
			 *
			 * `operation=plan` takes an environment as an argument, and that
			 * argument came from the agent: letting it stand in for the target's
			 * declaration would let a model declare "dev" and mutate a production
			 * database. So the target declares it (`.env`), the plan must agree,
			 * and both are checked before anything is approved or sent.
			 */
			if (environment === undefined) {
				return {
					...base,
					status: "needs-environment",
					detail:
						"NEEDS_ENVIRONMENT: the target does not declare its environment. Add ODOO_SDD_ENVIRONMENT " +
						"dev|staging|production to the .env and retry: running a functional operation against an " +
						"unknown environment is how a production database gets configured by accident.",
				};
			}
			if (plan.environment !== environment) {
				return {
					...base,
					status: "environment-mismatch",
					detail:
						`The plan was written for environment "${plan.environment}" but the target declares ` +
						`"${environment}". Re-plan for the environment that actually is, or point .env at the ` +
						"instance you meant: the two cannot be reconciled by guessing.",
				};
			}
			const declared = environment;

			// ---- approve ------------------------------------------------------
			if (args.operation === "approve") {
				const batchId = args.batch_id ?? "";
				const batch = plan.batches.find((b) => b.id === batchId);
				if (batch === undefined) {
					return { ...base, status: "unknown-batch", detail: `Batch "${batchId}" is not in the plan of ${specId}.` };
				}
				if (args.scope !== undefined && args.scope !== batch.scope) {
					return {
						...base,
						status: "scope-mismatch",
						detail: `The batch declares scope "${batch.scope}" but scope "${args.scope}" was requested; approve the scope the batch actually has.`,
					};
				}
				const hashes = deps.hashes(specId, exec);
				const fingerprint = batchFingerprint({
					projectRoot,
					specId,
					target: target ?? "",
					environment: declared,
					specHash: hashes.specHash,
					designHash: hashes.designHash,
					planHash: planHash(plan),
					batch,
				});
				const outcome = await deps.approve(
					exec,
					`Approve batch ${batch.id} (${batch.scope}) for spec ${specId}: ${batch.operations.length} operation(s) ` +
						`against ${target ?? "the configured target"} in environment ${declared}` +
						`${batch.highRisk === true ? " — HIGH RISK" : ""}` +
						`${(batch.backupReference ?? "") === "" ? "" : `, backup: ${batch.backupReference}`}?`,
				);
				if (outcome !== "allowed-once") {
					return {
						...base,
						batchId,
						status: "not-approved",
						detail: `Batch ${batchId} NOT approved (outcome: ${outcome}). No grant was written; ask the developer to approve, then retry.`,
					};
				}
				deps.grants.write({
					kind: "batch",
					fingerprint,
					reason: `functional batch ${batch.id} (${batch.scope}) for spec ${specId}`,
					details: {
						specId,
						batchId: batch.id,
						scope: batch.scope,
						environment: declared,
						target: target ?? "",
						specHash: hashes.specHash,
						designHash: hashes.designHash,
						planHash: planHash(plan),
					},
				});
				return {
					...base,
					ok: true,
					batchId,
					scope: batch.scope,
					status: "approved",
					detail:
						`Batch ${batchId} approved for environment ${declared}. The receipt is bound to the spec, design, ` +
						"plan and batch hashes: editing any of them invalidates it and the batch has to be approved again.",
				};
			}

			// ---- apply / inspect ----------------------------------------------
			if (args.operation === "apply" || args.operation === "inspect") {
				const scope: BatchScope = args.operation === "inspect" ? "discovery" : (args.scope ?? "apply");
				const batchId = args.batch_id ?? "";
				const batch = plan.batches.find((b) => b.id === batchId);
				if (batch === undefined) {
					return { ...base, status: "unknown-batch", detail: `Batch "${batchId}" is not in the plan of ${specId}.` };
				}
				const mutating = batch.operations.some((op) => MUTATING_METHODS.has(op.method));
				if (args.operation === "inspect" && mutating) {
					return { ...base, status: "rejected", detail: "operation=inspect runs READ-only batches; this one mutates." };
				}
				if (mutating && args.confirm_destructive !== true) {
					return {
						...base,
						batchId,
						status: "needs-confirmation",
						detail: "Applying a batch that mutates requires confirm_destructive=true (it is the caller's explicit acknowledgement, separate from the human approval).",
					};
				}
				// Production needs more than an approval: a backup to come back to.
				if (declared === "production" && mutating) {
					if ((batch.backupReference ?? "").trim() === "") {
						return {
							...base,
							batchId,
							status: "needs-backup",
							detail: "A production batch needs backupReference: the operator-confirmed identifier of the backup to restore from.",
						};
					}
				}
				// Approval: recomputed from the CURRENT hashes, so any edit invalidates it.
				const hashes = deps.hashes(specId, exec);
				const currentPlan = readPlan(projectRoot, specId) ?? plan;
				const fingerprint = batchFingerprint({
					projectRoot,
					specId,
					target: target ?? "",
					environment: declared,
					specHash: hashes.specHash,
					designHash: hashes.designHash,
					planHash: planHash(currentPlan),
					batch,
				});
				if (!deps.grants.valid(fingerprint)) {
					return {
						...base,
						batchId,
						scope: batch.scope,
						status: "not-approved",
						detail:
							`Batch ${batchId} has no live approval for its CURRENT content (spec/design/plan/batch hashes, ` +
							"target and environment). If anything changed since the approval, run operation=approve again.",
					};
				}
				// One writer at a time.
				const run = readRun(projectRoot, specId);
				const callId = String((exec as { callId?: unknown } | undefined)?.callId ?? "unknown");
				if (run.lock !== undefined && run.lock.callId !== callId) {
					if (args.release_stale_lock !== true) {
						return {
							...base,
							batchId,
							status: "locked",
							detail:
								`Spec ${specId} is locked by call ${run.lock.callId} (batch ${run.lock.batchId}, since ${run.lock.at}). ` +
								"If that call is gone, pass release_stale_lock=true to take over — it is recorded.",
						};
					}
				}
				run.lock = { callId, at: new Date().toISOString(), batchId: batch.id };
				run.state = "running";
				run.batchId = batch.id;
				writeRun(projectRoot, run);

				const results: Array<Record<string, string | number | boolean | null>> = [];
				let stopped: string | null = null;
				try {
					for (let index = 0; index < batch.operations.length; index += 1) {
						// Brakes are checked BETWEEN operations, never inside one: the
						// operator can stop the run, but never mid-call, where the
						// outcome would become unknown for no good reason.
						if (existsSync(join(projectRoot, ".sdd", "stop.md"))) {
							stopped = "stop.md appeared: the pipeline halts here. Something was applied already — read the run state before resuming.";
							break;
						}
						const signal = (exec as { signal?: { aborted?: boolean } } | undefined)?.signal;
						if (signal?.aborted === true) {
							stopped = "the call was cancelled by the host between operations; the batch stopped where it was.";
							break;
						}
						const op = batch.operations[index]!;
						const record: OpRecord = {
							batchId: batch.id,
							scope: batch.scope,
							index,
							model: op.model,
							method: op.method,
							intent: op.intent,
							state: "in_progress",
							attemptedAt: new Date().toISOString(),
						};
						run.ops.push(record);
						// STRICT persistence: if the intention cannot be written, do
						// not send anything.
						writeRun(projectRoot, run);

						// An import is not an execute_kw call: it goes through the web route
						// and the version's contract, so it is delegated — but it is still
						// one operation of THIS batch, with the same state and journal.
						if (op.kind === "import") {
							if (deps.runImport === undefined) {
								record.state = "failed";
								record.resultAt = new Date().toISOString();
								record.error = "this host has no import runner wired";
								writeRun(projectRoot, run);
								results.push({ index, state: record.state, detail: record.error, value: null });
								stopped = `operation ${index + 1} is an import and no importer is available on this host.`;
								break;
							}
							const imported = await deps.runImport(op, exec);
							record.resultAt = new Date().toISOString();
							if (imported.ok) {
								record.state = "applied";
								deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "applied", index });
								results.push({ index, state: "applied", value: jsonScalar(imported.value) });
							} else if (imported.indeterminate === true) {
								record.state = "indeterminate";
								record.error = imported.error ?? "unknown";
								deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "indeterminate", index, reason: record.error });
								writeRun(projectRoot, run);
								results.push({ index, state: "indeterminate", detail: record.error, value: null });
								stopped =
									`operation ${index + 1} (import) was sent and its outcome is UNKNOWN. It was NOT retried: ` +
									"re-read the target model to see whether the rows landed, then reconcile.";
								break;
							} else {
								record.state = "failed";
								record.error = imported.error ?? "unknown";
								deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "failed", index, reason: record.error });
								writeRun(projectRoot, run);
								results.push({ index, state: "failed", detail: record.error, value: null });
								stopped = `operation ${index + 1} (import) failed: ${record.error}`;
								break;
							}
							writeRun(projectRoot, run);
							continue;
						}
						const pre = await checkPrecondition(client, op, batch.context);
						if (!pre.ok) {
							record.state = "failed";
							record.resultAt = new Date().toISOString();
							record.error = `precondition not met: ${pre.detail}`;
							writeRun(projectRoot, run);
							results.push({ index, state: record.state, detail: record.error, value: null });
							stopped = `operation ${index + 1} did not run: ${pre.detail}`;
							break;
						}

						// Pre-image capture for write/unlink (same shape the data
						// journal uses, under the batch context).
						if (op.method === "write" || op.method === "unlink") {
							const ids = Array.isArray(op.args?.[0]) ? (op.args[0] as number[]) : [];
							if (ids.length > 0) {
								const kwargs: Record<string, unknown> = {};
								if (batch.context !== undefined) kwargs["context"] = batch.context;
								const fields = op.method === "write" && typeof op.args?.[1] === "object" ? Object.keys(op.args[1] as object) : undefined;
								if (fields !== undefined && fields.length > 0) kwargs["fields"] = fields;
								const image = await client.executeKw<Array<Record<string, unknown>>>(op.model, "read", [ids], kwargs);
								if (image.ok && Array.isArray(image.value)) record.preImage = image.value;
								record.ids = ids;
							}
						}

						const outcome = await executeOperation(client, op, batch.context);
						record.resultAt = new Date().toISOString();
						if (outcome.ok) {
							// The state it promised, read back BEFORE the operation can
							// be called applied. Without this, "applied" only means the
							// RPC answered: an operation that returns True while leaving
							// the records untouched looks exactly like one that worked.
							const post = await checkPostcondition(client, op, batch.context);
							if (!post.ok) {
								record.state = "failed";
								record.error = `postcondition not met: ${post.detail}`;
								deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "failed", index, reason: record.error });
								writeRun(projectRoot, run);
								results.push({ index, state: "failed", detail: record.error, value: jsonScalar(outcome.value) });
								stopped =
									`operation ${index + 1} ran but did not reach the state it declared (${post.detail}). ` +
									"The call WAS sent, so the instance may be partially changed: inspect it before retrying.";
								break;
							}
							if (op.postcondition !== undefined) record.postcondition = post.detail;
							record.state = "applied";
							deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "applied", index });
							if (op.method === "create" && typeof outcome.value === "number") record.createdIds = [outcome.value];
							// Only replayable CRUD goes to the journal: a business action
							// changes records the plugin never read, so journaling it would
							// promise an undo that cannot exist.
							if (MUTATING_METHODS.has(op.method)) {
								deps.recordDataOp?.(
									{
										model: op.model,
										method: op.method as "create" | "write" | "unlink",
										ids: record.ids ?? [],
										preImage: record.preImage ?? [],
										createdIds: record.createdIds ?? [],
										...(batch.context === undefined ? {} : { context: batch.context }),
									},
									exec,
								);
							}
							results.push({ index, state: "applied", value: jsonScalar(outcome.value) });
						} else if (outcome.indeterminate === true) {
							// Sent, no answer: the server may have committed. Never retry.
							record.state = "indeterminate";
							record.error = outcome.error ?? "unknown";
							deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "indeterminate", index, reason: record.error });
							writeRun(projectRoot, run);
							results.push({ index, state: "indeterminate", detail: record.error, value: null });
							stopped =
								`operation ${index + 1} was sent and its outcome is UNKNOWN (transport/protocol failure). ` +
								"It was NOT retried: reconcile it against the instance before doing anything else.";
							break;
						} else {
							record.state = "failed";
							record.error = outcome.error ?? "unknown";
							deps.audit?.({ batchId: batch.id, scope: batch.scope, model: op.model, method: op.method, state: "failed", index, reason: record.error });
							results.push({ index, state: "failed", detail: record.error, value: null });
							stopped = `operation ${index + 1} failed: ${record.error}`;
							writeRun(projectRoot, run);
							break;
						}
						writeRun(projectRoot, run);
					}
				} finally {
					const after = readRun(projectRoot, specId);
					const counts = countOps(after.ops);
					after.state = stopped === null && counts.indeterminate === 0 ? "idle" : "blocked";
					delete after.lock;
					writeRun(projectRoot, after);
				}
				const finalRun = readRun(projectRoot, specId);
				const counts = countOps(finalRun.ops);
				const applied = results.filter((r) => r["state"] === "applied").length;
				return {
					...base,
					ok: stopped === null,
					batchId,
					scope: batch.scope,
					status: stopped === null ? "applied" : "stopped",
					counts: { ...counts },
					results,
					detail:
						`Batch ${batchId} (${batch.scope}) on ${deps.display(projectRoot)}: ${applied}/${batch.operations.length} ` +
						`operation(s) applied.${stopped === null ? " No stop condition was hit." : `\nSTOPPED: ${stopped}`}` +
						(counts.indeterminate > 0
							? "\nThe run is BLOCKED until a human reconciles the indeterminate operation (operation=reconcile)."
							: ""),
				};
			}

			// ---- reconcile ----------------------------------------------------
			if (args.operation === "reconcile") {
				const run = readRun(projectRoot, specId);
				const pending = run.ops.filter((o) => o.state === "indeterminate" || o.state === "in_progress");
				if (pending.length === 0) {
					return { ...base, ok: true, status: "nothing-to-reconcile", detail: "No indeterminate or in-flight operation to reconcile." };
				}
				const plan2 = readPlan(projectRoot, specId);
				const batch = plan2?.batches.find((b) => b.id === (args.batch_id ?? pending[0]!.batchId));
				const resolved: string[] = [];
				for (const op of pending) {
					const declaredOp = batch?.operations[op.index];
					if (declaredOp?.identity === undefined || declaredOp.identity.length === 0) {
						op.resolution = "undecidable: the operation declares no stable identity to look for";
						resolved.push(`op ${op.index + 1}: undecidable (no declared identity)`);
						continue;
					}
					const domain = declaredOp.identity.map((kv) => [kv.field, "=", kv.value]);
					const kwargs: Record<string, unknown> = {};
					if (batch?.context !== undefined) kwargs["context"] = batch.context;
					const found = await client.executeKw<number>(op.model, "search_count", [domain], kwargs);
					if (!found.ok) {
						op.resolution = `undecidable: the identity lookup failed (${found.error})`;
						resolved.push(`op ${op.index + 1}: undecidable (lookup failed)`);
						continue;
					}
					const count = typeof found.value === "number" ? found.value : 0;
					op.state = count > 0 ? "applied" : "failed";
					op.resolution = `reconciled: ${count} record(s) match the declared identity`;
					resolved.push(`op ${op.index + 1}: ${op.state} (${count} match(es))`);
				}
				run.state = run.ops.some((o) => o.state === "indeterminate" || o.state === "in_progress") ? "blocked" : "idle";
				writeRun(projectRoot, run);
				return {
					...base,
					ok: true,
					status: run.state,
					results: resolved.map((r) => ({ detail: r })),
					counts: { ...countOps(run.ops) },
					detail:
						`Reconciled ${pending.length} operation(s):\n${resolved.map((r) => `- ${r}`).join("\n")}\n` +
						`Run is now ${run.state}.` +
						(run.state === "blocked" ? " What remains undecidable needs a human decision, not another attempt." : ""),
				};
			}

			// ---- verify -------------------------------------------------------
			if (args.operation === "verify") {
				const run = readRun(projectRoot, specId);
				const appliedBatches = [...new Set(run.ops.filter((o) => o.state === "applied").map((o) => o.batchId))];
				const evidence: string[] = [];
				const specDir = deps.specDir(specId, exec);
				const testPlan = existsSync(join(specDir, "test-plan.md")) ? readFileSync(join(specDir, "test-plan.md"), "utf8") : "";
				for (const batchId of appliedBatches) {
					const b = plan.batches.find((x) => x.id === batchId);
					for (const ac of b?.acceptance ?? []) {
						const onPlan = testPlan.includes(ac);
						const ops = run.ops.filter((o) => o.batchId === batchId && o.state === "applied");
						// The postcondition is the part that means something: "applied"
						// alone says the RPC answered, not that the state was reached.
						const proofs = ops.filter((o) => o.postcondition !== undefined).map((o) => `op ${o.index + 1}: ${o.postcondition}`);
						evidence.push(
							`${ac}: batch ${batchId} applied (${ops.length} op(s))` +
								(proofs.length === 0 ? " — no postcondition declared, so 'applied' proves only that the call was accepted" : ` — ${proofs.join("; ")}`) +
								(onPlan ? "" : " — WARNING: this criterion is not in test-plan.md"),
						);
					}
				}
				const counts = countOps(run.ops);
				return {
					...base,
					ok: true,
					status: counts.indeterminate > 0 ? "blocked" : "verified",
					evidence,
					counts: { ...counts },
					detail:
						`Evidence for spec ${specId} (${run.ops.length} operation(s), ${counts.applied} applied):\n` +
						(evidence.length === 0 ? "- (no applied batch declares acceptance criteria)" : evidence.map((e) => `- ${e}`).join("\n")) +
						"\nRecord the real per-AC result in test-plan.md (an explicit `pass` per row) before sdd_phase succeed.",
				};
			}

			// ---- compensate ---------------------------------------------------
			if (args.operation === "compensate") {
				const run = readRun(projectRoot, specId);
				const applied = run.ops.filter((o) => o.state === "applied" && MUTATING_METHODS.has(o.method));
				// A business action changed records the plugin never read: it is not
				// compensated and, more importantly, it is not silently skipped.
				const businessDone = run.ops.filter((o) => o.state === "applied" && isBusinessMethod(o.method));
				const businessNote =
					businessDone.length === 0
						? ""
						: `\nNOT compensable by the plugin (${businessDone.length} business action(s) ran): ` +
							businessDone.map((o) => `${o.model}.${o.method}`).join(", ") +
							". Its effect is not reversible from a pre-image: reverse it by hand following the runbook.";
				if (applied.length === 0) {
					return { ...base, status: "nothing-to-compensate", detail: "No applied mutation to compensate." };
				}
				const operations: BatchOperation[] = [];
				const notUndoable: string[] = [];
				for (const op of [...applied].reverse()) {
					if (op.method === "create" && (op.createdIds ?? []).length > 0) {
						const created = op.createdIds ?? [];
						operations.push({
							intent: `undo: remove the records created by "${op.intent}"`,
							model: op.model,
							method: "unlink",
							args: [created],
							identity: [{ field: "id", value: created[0] ?? null }],
							expect: { kind: "deleted", count: created.length },
							recovery: { kind: "none", note: "removing the compensation would restore the created records by hand" },
						});
						continue;
					}
					if ((op.preImage ?? []).length > 0) {
						for (const row of op.preImage ?? []) {
							const values: Record<string, unknown> = { ...row };
							delete values["id"];
							operations.push({
								intent: `undo: restore the pre-image of "${op.intent}" (id ${String(row["id"])})`,
								model: op.model,
								method: "write",
								args: [[Number(row["id"])], values],
								identity: [{ field: "id", value: Number(row["id"]) }],
								expect: { kind: "updated", count: 1 },
								recovery: { kind: "restore_preimage", note: "the pre-image is the value AFTER this compensation" },
							});
						}
						continue;
					}
					notUndoable.push(`${op.model}.${op.method} (${op.intent})`);
				}
				if (operations.length === 0) {
					return {
						...base,
						status: "not-undoable",
						detail:
							"None of the applied mutations can be compensated reliably:\n" +
							notUndoable.map((n) => `- ${n}`).join("\n") +
							"\nRestore the declared backup (production) or fix forward with a new approved batch; do not guess.",
					};
				}
				const compensation: Batch = {
					id: args.batch_id ?? `compensate-${run.batchId ?? "run"}`,
					scope: "compensate",
					title: `Compensation of the applied batches of ${specId}`,
					acceptance: [],
					companies: [],
					...(run.ops.find((o) => o.state === "applied")?.ids === undefined ? {} : {}),
					operations,
					manualSteps: ["Verify in Odoo that the compensated records are back to their previous state."],
				};
				const plan3 = readPlan(projectRoot, specId) ?? plan;
				plan3.batches = [...plan3.batches.filter((b) => b.id !== compensation.id), compensation];
				writeState(projectRoot, specId, "plan.json", plan3);
				return {
					...base,
					ok: true,
					batchId: compensation.id,
					scope: "compensate",
					status: "planned",
					detail:
						`Compensation batch ${compensation.id} built with ${operations.length} operation(s) from the run journal.` +
						(notUndoable.length > 0
							? `\nNOT undoable (${notUndoable.length}): ${notUndoable.join(", ")} — report this honestly.`
							: "") +
						businessNote +
						"\nIt is a batch like any other: approve it (operation=approve) before applying it.",
				};
			}

			return { ...base, detail: `Unsupported operation "${args.operation}".` };
		},
	}));
}

/**
 * Project an arbitrary RPC value into something the tool output schema accepts.
 * A result can be an object graph; the model needs the shape, not the payload,
 * so anything non-scalar is rendered as bounded JSON text.
 */
function jsonScalar(value: unknown): string | number | boolean | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
	try {
		return JSON.stringify(value).slice(0, 500);
	} catch {
		return String(value).slice(0, 500);
	}
}

/** Minimal text block for the tool renderer. */
function text(value: string): { type: "text"; text: string } {
	return { type: "text", text: value };
}
