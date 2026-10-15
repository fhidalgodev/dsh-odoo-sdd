/**
 * Motor 1 of `odoo_manual`: the functional CANON of a model, read from the
 * instance itself. The manual may only describe what the canon says — the
 * collector therefore performs a FIXED list of read-only calls and reports
 * what is missing as BLOCKED instead of inventing it.
 *
 * Version awareness lives here: `load_views` up to 15 and `get_views` from 16;
 * `groups_id` versus `group_ids` per `fields_get` era; `attrs`/`states` in the
 * arch up to 16 and plain expressions from 17.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { RpcResult } from "./odoo-client.js";

/** The only client surface the canon needs (read-only executeKw). */
export interface CanonClient {
	/** Probe the server version once (used to pick the per-version calls). */
	version(): Promise<RpcResult<{ server_version: string }>>;
	executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs?: Record<string, unknown>,
	): Promise<RpcResult<T>>;
}

// ---------------------------------------------------------------------------
// Minimal XML tokenizer for the compiled arch
// ---------------------------------------------------------------------------

export interface ArchButton {
	name: string;
	type?: string;
	string?: string;
	/** Raw `invisible` expression or `attrs` JSON (verbatim evidence). */
	invisibleRaw?: string;
	/** When the expression is simple: the states where the button SHOWS. */
	visibleStates?: string[];
	statesRaw?: string;
	/** Asks for confirmation → a mutating button. */
	confirm?: boolean;
}

export interface ArchField {
	name: string;
	string?: string;
	required?: boolean;
	readonly?: boolean;
	invisibleRaw?: string;
	visibleStates?: string[];
	attrsRaw?: string;
}

export interface ArchPage {
	name?: string;
	string?: string;
	invisibleRaw?: string;
}

export interface ArchListColumn {
	name: string;
	optional?: boolean;
	invisibleRaw?: string;
}

export interface ArchFilter {
	name: string;
	string?: string;
	domain?: string;
}

export interface ArchCanon {
	buttons: ArchButton[];
	statusbar?: { field: string; visibleStates?: string[] };
	fields: ArchField[];
	pages: ArchPage[];
	listColumns: ArchListColumn[];
	filters: ArchFilter[];
}

interface Tag {
	name: string;
	attrs: Record<string, string>;
	selfClosing: boolean;
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of raw.matchAll(ATTR_RE)) {
		out[m[1]] = m[2] ?? m[3] ?? "";
	}
	return out;
}

/**
 * Extract the states a SIMPLE visibility expression admits, or null when the
 * expression is not one of the recognizable forms. Simple means: the operand
 * is the `state` field and the test is `in` / `not in` over a literal tuple
 * (`invisible="state not in ('draft','sent')"` → shows in draft, sent), or a
 * legacy `attrs` JSON with a single `('state','not in',[…])` leaf.
 */
export function simpleVisibleStates(expr: string | undefined, statesRaw?: string): string[] | undefined {
	const statesFrom = (items: string): string[] | undefined => {
		// Accepts both quoted tuples (`'draft','sent'`) and the bare legacy
		// `states="draft,sent"` list.
		const found = [...items.matchAll(/'([^']+)'/g)].map((m) => m[1]);
		if (found.length > 0) return found;
		const bare = items
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return bare.length > 0 ? bare : undefined;
	};
	if (statesRaw) return statesFrom(statesRaw);
	if (!expr) return undefined;
	const plain = expr.match(/^state\s+(not\s+in|in)\s*\(([^)]*)\)$/);
	if (plain) {
		const states = statesFrom(plain[2]);
		if (!states) return undefined;
		return plain[1] === "not in" ? states : undefined; // `in` = hidden there
	}
	const attrsLeaf = expr.match(/^.*?'state'\s*,\s*'(not in|in)'\s*,\s*\[([^\]]*)\].*$/);
	if (attrsLeaf) {
		const states = statesFrom(attrsLeaf[2]);
		if (!states) return undefined;
		return attrsLeaf[1] === "not in" ? states : undefined;
	}
	return undefined;
}

/** Parse one compiled view arch (form, list/tree or search). */
export function parseArch(arch: string): ArchCanon {
	const canon: ArchCanon = { buttons: [], fields: [], pages: [], listColumns: [], filters: [] };
	const noComments = arch.replace(/<!--[\s\S]*?-->/g, "");
	// Scope stack of open tag names; `header` and `notebook` only matter as
	// direct containers, so a flat set check is enough.
	const stack: string[] = [];
	for (const m of noComments.matchAll(TAG_RE)) {
		const closing = m[1] === "/";
		const name = m[2].toLowerCase();
		const selfClosing = m[4] === "/" || name === "img" || name === "br" || name === "hr" || name === "input";
		const attrs = parseAttrs(m[3] ?? "");
		if (closing) {
			const idx = stack.lastIndexOf(name);
			if (idx >= 0) stack.splice(idx);
			continue;
		}
		if (!selfClosing) stack.push(name);
		const inHeader = stack.includes("header");
		const inNotebook = stack.includes("notebook");
		const inList = stack.includes("list") || stack.includes("tree");
		const inSearch = stack.includes("search");
		switch (name) {
			case "button": {
				const btn: ArchButton = { name: attrs["name"] ?? "", type: attrs["type"], string: attrs["string"], confirm: attrs["confirm"] !== undefined };
				if (attrs["states"]) btn.statesRaw = attrs["states"];
				if (attrs["invisible"]) btn.invisibleRaw = attrs["invisible"];
				if (attrs["attrs"]) btn.invisibleRaw = btn.invisibleRaw ?? attrs["attrs"];
				btn.visibleStates = simpleVisibleStates(btn.invisibleRaw, btn.statesRaw);
				canon.buttons.push(btn);
				break;
			}
			case "field": {
				const fname = attrs["name"] ?? "";
				if (!fname) break;
				if (inList) {
					// list/tree column (same tag as a form field, different role)
					canon.listColumns.push({ name: fname, optional: attrs["optional"] === "1", invisibleRaw: attrs["invisible"] });
					break;
				}
				if (inHeader && attrs["widget"] === "statusbar") {
					canon.statusbar = { field: fname, visibleStates: attrs["statusbar_visible"] ? attrs["statusbar_visible"].split(",").map((s) => s.trim()) : undefined };
					break;
				}
				const f: ArchField = { name: fname, string: attrs["string"], required: attrs["required"] === "1" || attrs["required"] === "True", readonly: attrs["readonly"] === "1" || attrs["readonly"] === "True" };
				if (attrs["invisible"]) f.invisibleRaw = attrs["invisible"];
				if (attrs["attrs"]) f.attrsRaw = attrs["attrs"];
				f.visibleStates = simpleVisibleStates(f.invisibleRaw ?? f.attrsRaw);
				canon.fields.push(f);
				break;
			}
			case "page":
				if (inNotebook) {
					canon.pages.push({ name: attrs["name"], string: attrs["string"], invisibleRaw: attrs["invisible"] ?? attrs["attrs"] });
				}
				break;
			default:
				if (inSearch && (name === "filter" || name === "separator")) {
					if (name === "filter") {
						canon.filters.push({ name: attrs["name"] ?? "", string: attrs["string"], domain: attrs["domain"] });
					}
				}
		}
	}
	return canon;
}

// ---------------------------------------------------------------------------
// Module error scan (evidence for the recovery rule)
// ---------------------------------------------------------------------------

export interface ModuleError {
	file: string;
	line: number;
	method?: string;
	kind: "raise" | "constraint";
	name?: string;
	message: string;
}

/** Walk `.py` files of a module directory looking for raise/constraint evidence. */
export function scanModuleErrors(dir: string): ModuleError[] {
	const errors: ModuleError[] = [];
	const walk = (path: string): void => {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "static" || entry.name.startsWith(".")) continue;
				walk(full);
			} else if (entry.isFile() && extname(entry.name) === ".py") {
				scanFile(full);
			}
		}
	};
	const scanFile = (file: string): void => {
		let method: string | undefined;
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((text, i) => {
			const def = text.match(/^\s*(?:async\s+)?def\s+(_?\w+)/);
			if (def) method = def[1];
			const raise = text.match(/raise\s+(UserError|ValidationError)\s*\(\s*(_?\()\s*(?:_\s*\()?\s*[fF]?(?:['"]{1,3})([^'"]{0,160})/);
			if (raise) {
				errors.push({ file, line: i + 1, method, kind: "raise", message: raise[3] ?? "" });
				return;
			}
			const constraint = text.match(/^\s*\('(\w+)',\s*'([^']{0,160})'/);
			if (constraint && lines.slice(0, i + 1).reverse().some((l) => l.includes("_sql_constraints"))) {
				errors.push({ file, line: i + 1, kind: "constraint", name: constraint[1], message: constraint[2] });
			}
		});
	};
	walk(dir);
	return errors;
}

// ---------------------------------------------------------------------------
// The canon itself
// ---------------------------------------------------------------------------

export interface CanonView {
	type: "form" | "list" | "search";
	arch: ArchCanon;
}

export interface CanonAction {
	xmlid?: string;
	name: string;
	viewMode?: string;
	domain?: string;
	context?: string;
	target?: string;
}

export interface CanonMenu {
	xmlid?: string;
	completeName: string;
}

export interface CanonAccess {
	models: string; // ir.model.modules (own vs native at model level)
	access: Array<{ name: string; group?: string; perms: string }>;
	rules: Array<{ name: string; groups: string[]; domain: string; active: boolean }>;
	groups: Array<{ fullName: string; xmlid?: string }>;
}

export interface CanonErrorSource {
	path?: string;
	note?: string;
	errors: ModuleError[];
}

export interface Canon {
	model: string;
	serverVersion: string;
	major: number;
	/** Language actually used (exact res.lang code). */
	language: string;
	/** `modules` of ir.model — what is native and what is the project's own. */
	modelModules: string;
	views: CanonView[];
	fields: Array<{ name: string; string: string; type: string; required: boolean; selection?: Array<[string, string]>; relation?: string; modules: string; groups?: string[] }>;
	/** The field-attribute key this server uses for group restriction. */
	groupsAttr: "groups_id" | "group_ids";
	actions: CanonAction[];
	menus: CanonMenu[];
	access: CanonAccess;
	errors: { own?: CanonErrorSource; community?: CanonErrorSource; enterprise?: CanonErrorSource };
}

/** Stable fingerprint of the canon: storyboards record it (CANON-STALE). */
export function canonFingerprint(canon: Canon): string {
	const stable = {
		model: canon.model,
		serverVersion: canon.serverVersion,
		language: canon.language,
		modelModules: canon.modelModules,
		views: canon.views.map((v) => ({ type: v.type, arch: v.arch })),
		fields: canon.fields,
		actions: canon.actions,
		menus: canon.menus,
		access: canon.access,
		errors: canon.errors,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export interface CanonSummary {
	model: string;
	version: string;
	language: string;
	own: boolean;
	buttons: number;
	mutatingButtons: number;
	statusbar: boolean;
	requiredFields: string[];
	pages: string[];
	ownErrors: number;
	nativeErrorsKnown: boolean;
}

/** Bounded summary for display paths — never the full canon. */
export function summarizeCanon(canon: Canon): CanonSummary {
	const formArch = canon.views.find((v) => v.type === "form")?.arch;
	return {
		model: canon.model,
		version: canon.serverVersion,
		language: canon.language,
		own: canon.errors.own !== undefined,
		buttons: formArch?.buttons.length ?? 0,
		mutatingButtons: formArch?.buttons.filter((b) => (b.type ?? "object") === "object").length ?? 0,
		statusbar: formArch?.statusbar !== undefined,
		requiredFields: canon.fields.filter((f) => f.required).map((f) => f.name).slice(0, 15),
		pages: (formArch?.pages ?? []).map((p) => p.string ?? p.name ?? "?").slice(0, 15),
		ownErrors: canon.errors.own?.errors.length ?? 0,
		nativeErrorsKnown: canon.errors.community !== undefined || canon.errors.enterprise !== undefined,
	};
}

// ---------------------------------------------------------------------------
// collectCanon — the FIXED list of read-only calls
// ---------------------------------------------------------------------------

export interface CanonRequest {
	model: string;
	/** Full server version string, e.g. "17.0" or "16.0+e". */
	serverVersion: string;
	/** Preferred language (exact `res.lang` code or a prefix like "es"). */
	language?: string;
	/** Technical name of the project's own module, when known. */
	moduleName?: string;
	/** Local directory of the project's own module (own error evidence). */
	moduleDir?: string;
	/** Local checkouts of Community / Enterprise, for native error evidence. */
	repos?: { communityPath?: string; enterprisePath?: string };
}

export type CanonResult = { ok: true; canon: Canon } | { ok: false; blocked: string };

interface Row {
	[key: string]: unknown;
}

const READ_LIMIT = 200;

async function read(
	client: CanonClient,
	model: string,
	method: string,
	args: unknown[],
	lang: string,
	what: string,
): Promise<RpcResult<Row[]>> {
	return client.executeKw<Row[]>(model, method, args, { context: { lang } }).then((r) =>
		r.ok ? r : { ok: false, error: `${what}: ${r.error}`, errorKind: r.errorKind },
	);
}

/**
 * Read the canon of one model. Every call below is a plain READ; nothing here
 * mutates and nothing here guesses: a missing language or a failed read is
 * BLOCKED with the exact reason.
 */
export async function collectCanon(client: CanonClient, request: CanonRequest): Promise<CanonResult> {
	const major = Number.parseInt(request.serverVersion, 10);
	if (!Number.isFinite(major) || major < 13) {
		return { ok: false, blocked: `unsupported server version "${request.serverVersion}" — the canon collector knows 13+.` };
	}

	// 1. Language: exact code first, then prefix ("es" → "es_VE"), else BLOCKED.
	let language = "";
	const langs = await read(client, "res.lang", "search_read", [[], ["code"]], "en_US", "res.lang");
	if (!langs.ok) return { ok: false, blocked: langs.error };
	const codes = langs.value.map((r) => String(r["code"] ?? "")).filter(Boolean);
	if (request.language && codes.includes(request.language)) {
		language = request.language;
	} else if (request.language) {
		language = codes.find((c) => c.split("_")[0] === request.language?.split("_")[0]) ?? "";
	} else {
		language = codes.includes("en_US") ? "en_US" : (codes[0] ?? "");
	}
	if (!language) {
		return {
			ok: false,
			blocked: `language "${request.language ?? "(default)"}" is not installed on this instance. Installed: ${codes.join(", ")}. Install it, or pass a configured language that exists.`,
		};
	}

	// 2. The model row itself (id + which modules define it).
	const modelRows = await read(client, "ir.model", "search_read", [[["model", "=", request.model]]], language, "ir.model");
	if (!modelRows.ok) return { ok: false, blocked: modelRows.error };
	const modelRow = modelRows.value[0];
	if (!modelRow) return { ok: false, blocked: `model "${request.model}" does not exist on this instance (check the technical name).` };
	const modelId = Number(modelRow["id"]);
	const modelModules = String(modelRow["modules"] ?? "");

	// 3. fields_get — one call, with the translated labels.
	const groupsAttr = major >= 19 ? "group_ids" : "groups_id";
	const fg = await client.executeKw<Record<string, Row>>(request.model, "fields_get", [], {
		attributes: ["string", "type", "required", "readonly", "selection", "relation", "store", "modules", groupsAttr],
		context: { lang: language },
	});
	if (!fg.ok) return { ok: false, blocked: `fields_get: ${fg.error}` };
	const fields = Object.entries(fg.value)
		.map(([name, def]) => ({
			name,
			string: String(def["string"] ?? name),
			type: String(def["type"] ?? ""),
			required: def["required"] === true,
			selection: Array.isArray(def["selection"]) ? (def["selection"] as Array<[string, string]>) : undefined,
			relation: typeof def["relation"] === "string" ? def["relation"] : undefined,
			modules: String(def["modules"] ?? ""),
			groups: Array.isArray(def[groupsAttr]) ? (def[groupsAttr] as unknown[]).map((g) => JSON.stringify(g)) : undefined,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	// 4. Views: load_views up to 15, get_views from 16. Toolbar ON — the
	//    actions bound to the form are part of the canon.
	const wanted: Array<[false, "form" | "list" | "search"]> = [[false, "form"], [false, "list"], [false, "search"]];
	const viewsCall = await
		(major >= 16
			? client.executeKw<{ views: Record<string, { arch: string }> }>(request.model, "get_views", [wanted], { options: { toolbar: true }, context: { lang: language } })
			: client.executeKw<{ fields_views: Record<string, { arch: string }> }>(request.model, "load_views", [wanted], { options: { toolbar: true, load_filters: true }, context: { lang: language } }));
	if (!viewsCall.ok) return { ok: false, blocked: `views: ${viewsCall.error}` };
	const rawViews = major >= 16
		? (viewsCall.value as { views: Record<string, { arch: string }> }).views
		: (viewsCall.value as unknown as { fields_views: Record<string, { arch: string }> }).fields_views;
	const views: CanonView[] = (["form", "list", "search"] as const)
		.filter((t) => rawViews[t]?.arch)
		.map((t) => ({ type: t, arch: parseArch(String(rawViews[t].arch)) }));

	// 5. Window actions of the model + the menus that reach them.
	const actions: CanonAction[] = [];
	const actRows = await read(client, "ir.actions.act_window", "search_read", [[["res_model", "=", request.model]]], language, "ir.actions.act_window");
	if (actRows.ok) {
		const ids = actRows.value.map((r) => Number(r["id"])).filter(Number.isFinite);
		const xmlIds = ids.length
			? await read(client, "ir.model.data", "search_read", [[["model", "=", "ir.actions.act_window"], ["res_id", "in", ids]]], language, "ir.model.data(actions)")
			: { ok: true as const, value: [] as Row[] };
		const xmlByRes = new Map<number, string>();
		if (xmlIds.ok) {
			for (const r of xmlIds.value) xmlByRes.set(Number(r["res_id"]), `${r["module"]}.${r["name"]}`);
		}
		for (const r of actRows.value) {
			actions.push({
				xmlid: xmlByRes.get(Number(r["id"])),
				name: String(r["name"] ?? ""),
				viewMode: typeof r["view_mode"] === "string" ? r["view_mode"] : undefined,
				domain: typeof r["domain"] === "string" ? r["domain"] : undefined,
				context: typeof r["context"] === "string" ? r["context"] : undefined,
				target: typeof r["target"] === "string" ? r["target"] : undefined,
			});
		}
	}
	const menus: CanonMenu[] = [];
	const actionIds = (await read(client, "ir.actions.act_window", "search_read", [[["res_model", "=", request.model]], ["id"]], language, "ir.actions.act_window(ids)"));
	if (actionIds.ok && actionIds.value.length > 0) {
		const ids = actionIds.value.map((r) => Number(r["id"]));
		const menuRows = await read(client, "ir.ui.menu", "search_read", [[["action", "in", ids]]], language, "ir.ui.menu");
		if (menuRows.ok) {
			const menuIds = menuRows.value.map((r) => Number(r["id"]));
			const menuXml = menuIds.length
				? await read(client, "ir.model.data", "search_read", [[["model", "=", "ir.ui.menu"], ["res_id", "in", menuIds]]], language, "ir.model.data(menus)")
				: { ok: true as const, value: [] as Row[] };
			const menuXmlByRes = new Map<number, string>();
			if (menuXml.ok) for (const r of menuXml.value) menuXmlByRes.set(Number(r["res_id"]), `${r["module"]}.${r["name"]}`);
			for (const r of menuRows.value) {
				menus.push({ xmlid: menuXmlByRes.get(Number(r["id"])), completeName: String(r["complete_name"] ?? r["name"] ?? "") });
			}
		}
	}

	// 6. Access: ir.model.access + ir.rule + the group tree.
	const accessRows = await read(client, "ir.model.access", "search_read", [[["model_id", "=", modelId]]], language, "ir.model.access");
	if (!accessRows.ok) return { ok: false, blocked: accessRows.error };
	const ruleRows = await read(client, "ir.rule", "search_read", [[["model_id", "=", modelId]]], language, "ir.rule");
	if (!ruleRows.ok) return { ok: false, blocked: ruleRows.error };
	const groupRows = await read(client, "res.groups", "search_read", [[], ["full_name"]], language, "res.groups");
	if (!groupRows.ok) return { ok: false, blocked: groupRows.error };
	const groupIds = groupRows.value.slice(0, READ_LIMIT).map((r) => Number(r["id"])).filter(Number.isFinite);
	const groupXml = groupIds.length
		? await read(client, "ir.model.data", "search_read", [[["model", "=", "res.groups"], ["res_id", "in", groupIds]]], language, "ir.model.data(groups)")
		: { ok: true as const, value: [] as Row[] };
	const groupXmlByRes = new Map<number, string>();
	if (groupXml.ok) for (const r of groupXml.value) groupXmlByRes.set(Number(r["res_id"]), `${r["module"]}.${r["name"]}`);
	const access: CanonAccess = {
		models: modelModules,
		access: accessRows.value.slice(0, READ_LIMIT).map((r) => ({
			name: String(r["name"] ?? ""),
			group: typeof r["group_id"] === "object" && r["group_id"] !== null ? String((r["group_id"] as [number, string])[1]) : undefined,
			perms: `${r["perm_read"] ? "r" : "-"}${r["perm_write"] ? "w" : "-"}${r["perm_create"] ? "c" : "-"}${r["perm_unlink"] ? "d" : "-"}`,
		})),
		rules: ruleRows.value.slice(0, READ_LIMIT).map((r) => ({
			name: String(r["name"] ?? ""),
			groups: Array.isArray(r["groups"]) ? (r["groups"] as Array<[number, string]>).map((g) => g[1]) : [],
			domain: typeof r["domain_force"] === "string" ? r["domain_force"] : "[]",
			active: r["active"] !== false,
		})),
		groups: groupRows.value.slice(0, READ_LIMIT).map((r) => ({
			fullName: String(r["full_name"] ?? r["name"] ?? ""),
			xmlid: groupXmlByRes.get(Number(r["id"])),
		})),
	};

	// 7. Error evidence: the project's own module first, then the native
	//    checkouts when they are configured (never invented).
	const errors: Canon["errors"] = {};
	if (request.moduleDir && existsSync(request.moduleDir)) {
		errors.own = { path: request.moduleDir, errors: scanModuleErrors(request.moduleDir) };
	} else if (request.moduleName) {
		errors.own = { note: `module_dir for "${request.moduleName}" was not provided: own error evidence is not available.`, errors: [] };
	}
	const nativeDir = (base: string | undefined, name: string): string | undefined => {
		if (!base) return undefined;
		const dir = join(base, name);
		return existsSync(dir) ? dir : undefined;
	};
	errors.community = nativeDir(request.repos?.communityPath, request.model.split(".")[0])
		? { path: nativeDir(request.repos?.communityPath, request.model.split(".")[0]), errors: scanModuleErrors(nativeDir(request.repos?.communityPath, request.model.split(".")[0]) as string) }
		: { note: "communityRepoPath is not configured: native error evidence for this module is not available.", errors: [] };
	errors.enterprise = nativeDir(request.repos?.enterprisePath, request.model.split(".")[0])
		? { path: nativeDir(request.repos?.enterprisePath, request.model.split(".")[0]), errors: scanModuleErrors(nativeDir(request.repos?.enterprisePath, request.model.split(".")[0]) as string) }
		: undefined;

	return {
		ok: true,
		canon: {
			model: request.model,
			serverVersion: request.serverVersion,
			major,
			language,
			modelModules,
			views,
			fields,
			groupsAttr,
			actions,
			menus,
			access,
			errors,
		},
	};
}
