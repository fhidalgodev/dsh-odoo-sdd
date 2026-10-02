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
 *   and never auto-compensated.
 *
 * A business method has two surfaces, with different contracts:
 * - a **functional batch** (`kind: "method"`) requires the exact `model.method`
 *   pair in the allowlist AND a precondition AND a postcondition (see
 *   `validateBatch`);
 * - the **ad-hoc RPC** (`odoo_execute`) runs it with the operator's explicit
 *   `confirm_destructive`, no allowlist — the state guard and the state proof are
 *   offered as optional parameters, and a missing postcondition is warned about.
 *
 * What NO surface can call is a private method, and the wall is Odoo's, not this
 * plugin's: `execute_kw` dispatches through `service/model.py::
 * get_public_method`, which refuses `_(...)` names, `@api.private` and the
 * `_UNSAFE_ATTRIBUTES` names with an `AccessError`. See
 * `isCallableMethodName` below.
 *
 * This module has no host dependency on purpose: `functional.ts` is imported by
 * tests without a running DSH, so it must not pull `@deepseek-ai/dsh-tools` in.
 *
 * @module dsh-odoo-sdd/method-classification
 */

/**
 * Methods that only read.
 *
 * A read is what a discovery batch may run and what needs no confirmation on the
 * ad-hoc surface. The list is the well-known public read API, not every method
 * that happens to have no side effect: an unknown name is treated as a business
 * method (confirmable, never silently trusted).
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
	"search",
	"search_read",
	"search_count",
	"read",
	"read_group",
	"fields_get",
	"name_get",
	"name_search",
	"default_get",
	"exists",
	"check_access_rights",
	"check_access_rule",
]);

/** The mutations the journal can replay: pre-image in, restore out. */
export const CRUD_METHODS: ReadonlySet<string> = new Set(["create", "write", "unlink"]);

/**
 * The read methods this server can actually answer, for advertising them in a
 * tool description. A retired name is left out instead of promised.
 * @param major - the ORM major version, when known.
 * @returns the callable read method names.
 */
export function advertisedReadMethods(major: number | null = null): string[] {
	return [...READ_METHODS].filter((method) => retiredReadReason(method, major) === null);
}

/**
 * Historical name kept for the surfaces that already use it. It means exactly
 * `CRUD_METHODS`: a business method is mutating too, but it is not *replayable*,
 * and conflating the two is what would make `compensate` lie.
 */
export const MUTATING_METHODS: ReadonlySet<string> = CRUD_METHODS;

/**
 * Methods the ORM CHANGED the visibility of, keyed by the first major where the
 * plugin's classification stops being true.
 *
 * Both entries were verified in the installed sources, not assumed:
 * - `exists` is `@api.private` since 19 (`odoo/orm/models.py`: the decorator sits
 *   right above it) and public in 18 (`odoo/models.py`, `@api.returns('self')`).
 *   `get_public_method` refuses private names, so calling it over RPC on 19 can
 *   only ever produce an AccessError.
 * - `name_get` left the core in 18 (it is in `odoo/models.py` up to 17,
 *   deprecated there, and absent from 18 on).
 *
 * Advertising them as free reads was the plugin's own version of a stale
 * assumption: the tool description promised a query the server would refuse.
 * With no version known the historical behaviour is kept, so a caller that never
 * resolves a version is never worse off than before.
 */
const READ_METHOD_RETIRED: ReadonlyMap<string, number> = new Map([
	["exists", 19],
	["name_get", 18],
]);

/** The replacement to point at, per retired method. */
const READ_METHOD_REPLACEMENT: ReadonlyMap<string, string> = new Map([
	["exists", "search_count with the same domain, or read the ids you already have"],
	["name_get", "read the `display_name` field, which is a stored computed field since 17"],
]);

/**
 * Why a read the plugin advertises cannot work on this server, if it cannot.
 *
 * The remedy is NOT to reclassify the method: `exists` is a harmless query, and
 * demanding `confirm_destructive` for something that only reads would train the
 * operator to confirm reflexively. The honest answer is to refuse it early, with
 * the name of what to use instead, instead of letting Odoo answer with an
 * `AccessError` about private methods.
 * @param method - the method name.
 * @param major - the ORM major version, or null when it is unknown.
 * @returns the refusal reason, or null when the method is usable.
 */
export function retiredReadReason(method: string, major: number | null): string | null {
	const retiredFrom = READ_METHOD_RETIRED.get(method);
	if (retiredFrom === undefined) return null;
	// No version to judge by: keep the historical answer rather than inventing a
	// restriction the server may not have.
	if (major === null || major < retiredFrom) return null;
	const replacement = READ_METHOD_REPLACEMENT.get(method);
	return (
		`"${method}" is classified as a read but this server (Odoo ${major}) does not expose it over ` +
		`RPC any more${method === "exists" ? ": it is @api.private since 19" : ": it left the core in 18"}. ` +
		`Use ${replacement ?? "a supported query"} instead — nothing was sent.`
	);
}

/**
 * True for a query method.
 *
 * Version-independent by design: this answers "what KIND of call is this", which
 * decides the confirmation policy. Whether the SERVER still offers it is a
 * separate question, answered by {@link retiredReadReason}.
 * @param method - the method name.
 * @returns true for the well-known public read API.
 */
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
 * Whether the RPC could call this method name at all.
 *
 * Mirrors Odoo's own rule instead of inventing one: `execute_kw` dispatches
 * through `get_public_method`, which refuses any name matching Odoo's
 * `regex_private = r'^(_.*|init)$'` — a leading underscore, the ORM initializer
 * `init`, `@api.private` methods (17+) and the `_UNSAFE_ATTRIBUTES` names. A
 * private method is therefore NOT callable remotely in any supported version
 * (10-13 checked it in `execute_kw`, 14+ in `service/model.py`), so refusing it
 * here saves a round trip and a red traceback, and the refusal can say where the
 * public wrapper is instead.
 *
 * `@api.private` cannot be detected from a name: that one is left to the server,
 * which reports it as an `AccessError` of its own.
 * @param method - the method name.
 * @returns true when the name is a candidate for a remote call.
 */
export function isCallableMethodName(method: string): boolean {
	return isAllowedMethodShape(method) && method !== "init";
}

/**
 * Whether a failed call must be treated as an UNKNOWN outcome.
 *
 * A transport or protocol failure after sending a mutation means the server may
 * have acted: reporting it as a plain failure would invite a retry of something
 * that already happened. Business methods are included because they mutate too —
 * they are simply not replayable.
 * @param method - the method that was sent.
 * @param errorKind - how the RPC failed.
 * @returns true when the outcome is indeterminate.
 */
export function isIndeterminateFor(method: string, errorKind: string | undefined): boolean {
	const sent = CRUD_METHODS.has(method) || isBusinessMethod(method);
	return sent && (errorKind === "transport" || errorKind === "protocol");
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
