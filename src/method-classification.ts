/**
 * One source of truth for how an RPC method is classified.
 *
 * WHY THIS EXISTS
 * The read/mutating sets were declared twice — once in `tools-runtime.ts` (the
 * ad-hoc `odoo_execute` tool) and once in `functional.ts` (the batch executor).
 * Two copies of the same policy drift: adding a method to one surface and not
 * the other produces a plugin that refuses here and allows there, with nothing
 * failing to say so.
 *
 * THE THREE KINDS
 * - **read** — a query; safe in a discovery batch.
 * - **CRUD** — `create`/`write`/`unlink`: what the data journal can capture a
 *   pre-image for and replay, therefore the only thing `compensate` can undo.
 * - **business** — every other method: what a model exposes to *do* something
 *   (`action_*`, `button_*`, `do_*`…, the convention varies). It changes state
 *   through code the plugin cannot replay:
 *   its effect lands on records that were never read, so it is NEVER journaled
 *   and never auto-compensated. It runs only when the operator lists the exact
 *   `model.method` pair, and only with a precondition and a postcondition
 *   (see `validateBatch`).
 *
 * This module has no host dependency on purpose: `functional.ts` is imported by
 * tests without a running DSH, so it must not pull `@deepseek-ai/dsh-tools` in.
 *
 * @module dsh-odoo-sdd/method-classification
 */

/** Methods that only read. */
export const READ_METHODS: ReadonlySet<string> = new Set([
	"search_read",
	"read",
	"search_count",
	"read_group",
	"fields_get",
]);

/** The mutations the journal can replay: pre-image in, restore out. */
export const CRUD_METHODS: ReadonlySet<string> = new Set(["create", "write", "unlink"]);

/**
 * Historical name kept for the surfaces that already use it. It means exactly
 * `CRUD_METHODS`: a business method is mutating too, but it is not *replayable*,
 * and conflating the two is what would make `compensate` lie.
 */
export const MUTATING_METHODS: ReadonlySet<string> = CRUD_METHODS;

/** True for a query method. */
export function isReadMethod(method: string): boolean {
	return READ_METHODS.has(method);
}

/** True for a mutation the journal can replay. */
export function isCrudMutation(method: string): boolean {
	return CRUD_METHODS.has(method);
}

/**
 * True for a method that is neither a read nor replayable CRUD: a business
 * action. It is refused unless the operator allowlisted that exact pair, and it
 * is treated as mutating for the INDETERMINATE contract — a timeout after
 * sending one may mean the server already acted, and reporting it as a plain
 * failure would invite a retry of something that happened.
 */
export function isBusinessMethod(method: string): boolean {
	return !isReadMethod(method) && !isCrudMutation(method);
}

/** True when a method name may be allowlisted at all. */
export function isAllowedMethodShape(method: string): boolean {
	// A leading underscore is a private/ORM-internal name (`_compute_x`,
	// `_action_done`): calling one bypasses the public flow it belongs to.
	return /^[a-z][a-z0-9_]*$/.test(method);
}

/**
 * Build the lookup set from declared entries.
 *
 * The canonical form is `"model.method"` (e.g. `"res.partner.action_merge"` — any
 * model, any method of that model), and `"model:method"` is accepted too because a
 * colon reads better on a command line. Both normalise to the same key: a model name contains dots and a method
 * name cannot, so the last segment is always the method.
 * @param entries - declared entries.
 * @returns the normalised keys.
 */
export function methodAllowSet(entries: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const raw of entries) {
		const entry = String(raw).trim().replace(/:/g, ".");
		if (entry === "") continue;
		out.add(entry);
	}
	return out;
}

/**
 * Whether `model.method` is allowlisted for the business-method path.
 * @param entries - declared `"model.method"` entries.
 * @param model - the model being called.
 * @param method - the method being called.
 * @returns true when the pair (and only the pair) was declared.
 */
export function businessMethodAllowed(entries: readonly string[], model: string, method: string): boolean {
	if (!isAllowedMethodShape(method)) return false;
	return methodAllowSet(entries).has(`${model}.${method}`);
}
