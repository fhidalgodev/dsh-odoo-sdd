/**
 * Translation from the plugin's positional JSON-RPC call into the NAMED body the
 * JSON-2 API requires.
 *
 * WHY THIS EXISTS
 * Odoo 19 introduced `POST /json/2/<model>/<method>` (`addons/rpc/controllers/
 * json2.py`): an external API built around an API key sent as
 * `Authorization: Bearer`, with no `uid`, no `db` in the body and no positional
 * arguments — the controller does `signature.bind(records, **kwargs)`, so every
 * parameter travels BY NAME. The classic `execute_kw` takes `args` positionally.
 * Something has to hold that difference, and holding it in one table is what
 * keeps the two transports from drifting apart.
 *
 * WHY ONLY SOME METHODS
 * A table can only translate what it knows. The methods below are the ones whose
 * parameter names this plugin already pins down (they have dedicated branches in
 * `tools-runtime.ts`, built from the ORM signatures). A business action
 * (`action_*`, `button_*`) is called with caller-supplied positional `args`, and
 * JSON-2 has no positional form at all: guessing a position→name mapping there
 * would be exactly the kind of silent mis-send this plugin refuses. Those keep
 * going through `execute_kw`, and the caller of this module falls back when it
 * gets `null`.
 *
 * This module has no host dependency on purpose: it is imported by tests without
 * a running DSH.
 *
 * @module dsh-odoo-sdd/api-transport
 */

/** A plain JSON object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of record ids, as Odoo expects them. */
function isIdList(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

/** Keys of `kwargs` that the JSON-2 body carries verbatim. */
function pick(kwargs: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (kwargs[key] !== undefined) out[key] = kwargs[key];
	}
	return out;
}

/** The batch/company context, which JSON-2 takes as a top-level parameter. */
function contextOf(kwargs: Record<string, unknown>): Record<string, unknown> {
	return kwargs["context"] === undefined ? {} : { context: kwargs["context"] };
}

/**
 * Methods whose parameters this module can name, and therefore the only ones it
 * will move to JSON-2. Anything else returns `null` and stays on `execute_kw`.
 */
export const JSON2_METHODS: ReadonlySet<string> = new Set([
	"search",
	"search_read",
	"search_count",
	"read_group",
	"fields_get",
	"read",
	"create",
	"write",
	"unlink",
]);

/**
 * Whether a method can be expressed as a JSON-2 body.
 * @param method - the model method name.
 * @returns true when {@link planJson2Body} can translate it.
 */
export function isJson2Method(method: string): boolean {
	return JSON2_METHODS.has(method);
}

/**
 * Build the JSON-2 body for one call, or `null` when it cannot be expressed.
 *
 * Returning `null` is the SAFE outcome: the caller falls back to `execute_kw`
 * rather than sending a body whose shape it guessed. Every branch validates the
 * positional shape it expects, so a caller that invents a different one degrades
 * instead of mis-sending.
 *
 * `ids` is deliberately absent for the methods Odoo decorates `@api.model`
 * (`search*`, `read_group`, `fields_get`, `create`): the JSON-2 controller
 * rejects them with 422 "cannot call <model>.<method> with ids" (`json2.py`),
 * which is a hard failure, not a silent one — so it is never produced here.
 * Strictly, `search` is `@api.model` too, but the plugin has no dedicated branch
 * for it, so callers reach it through the generic positional path and it falls
 * back on its own.
 *
 * @param method - the model method name.
 * @param args - the positional arguments the plugin would have sent to `execute_kw`.
 * @param kwargs - the keyword arguments the plugin would have sent to `execute_kw`;
 *   optional, because plenty of calls carry none and an exported function should
 *   not make `undefined` a crash.
 * @returns the named body, or null to fall back to the classic transport.
 */
export function planJson2Body(
	method: string,
	args: unknown[],
	kwargs: Record<string, unknown> = {},
): Record<string, unknown> | null {
	switch (method) {
		case "search":
		case "search_read": {
			// search(domain, offset=0, limit=None, order=None)
			// search_read(domain=None, fields=None, offset=0, limit=None, order=None)
			if (args.length !== 1 || !Array.isArray(args[0])) return null;
			return {
				domain: args[0],
				...pick(kwargs, ["fields", "offset", "limit", "order"]),
				...contextOf(kwargs),
			};
		}
		case "search_count": {
			// search_count(domain, limit=None) — `offset` is NOT a parameter of this
			// method, so it is not forwarded: sending it made Odoo raise a TypeError.
			if (args.length !== 1 || !Array.isArray(args[0])) return null;
			return { domain: args[0], ...pick(kwargs, ["limit"]), ...contextOf(kwargs) };
		}
		case "read_group": {
			// read_group(domain, fields, groupby, offset=0, limit=None, orderby=False, lazy=True)
			if (args.length !== 3) return null;
			const [domain, fields, groupby] = args;
			if (!Array.isArray(domain) || !Array.isArray(fields) || !Array.isArray(groupby)) return null;
			return {
				domain,
				fields,
				groupby,
				...pick(kwargs, ["offset", "limit", "orderby", "lazy"]),
				...contextOf(kwargs),
			};
		}
		case "fields_get": {
			// fields_get(allfields=None, attributes=None) — @api.model: no ids.
			if (args.length !== 0) return null;
			return { ...pick(kwargs, ["allfields", "attributes"]), ...contextOf(kwargs) };
		}
		case "read": {
			// read(fields=None, load='_classic_read') — called ON the recordset.
			if (args.length !== 1 || !isIdList(args[0])) return null;
			return { ids: args[0], ...pick(kwargs, ["fields", "load"]), ...contextOf(kwargs) };
		}
		case "create": {
			// create(vals_list): the decorator accepts a single dict OR a list of
			// dicts (odoo/orm/decorators.py::model_create_multi), so what the caller
			// passed is forwarded as-is under the NAME the controller binds.
			if (args.length !== 1) return null;
			const vals = args[0];
			const single = isRecord(vals);
			const many = Array.isArray(vals) && vals.length > 0 && vals.every((entry) => isRecord(entry));
			if (!single && !many) return null;
			return { vals_list: vals, ...contextOf(kwargs) };
		}
		case "write": {
			// write(vals) — the parameter is `vals`, NOT the plugin's `values`.
			if (args.length !== 2 || !isIdList(args[0]) || !isRecord(args[1])) return null;
			return { ids: args[0], vals: args[1], ...contextOf(kwargs) };
		}
		case "unlink": {
			// unlink() takes no arguments: the recordset comes from `ids`.
			if (args.length !== 1 || !isIdList(args[0])) return null;
			return { ids: args[0], ...contextOf(kwargs) };
		}
		default:
			return null;
	}
}
