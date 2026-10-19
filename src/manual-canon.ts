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
	/**
	 * The uid this transport authenticated, when it knows it (OdooClient does).
	 * Optional so a test double stays a CanonClient; without it the interview
	 * records the connected login as unknown instead of guessing.
	 */
	currentUid?(): number | null;
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
	/** `groups` attribute: the groups that may see the button (raw xmlids). */
	groups?: string[];
}

export interface ArchField {
	name: string;
	string?: string;
	required?: boolean;
	readonly?: boolean;
	invisibleRaw?: string;
	visibleStates?: string[];
	attrsRaw?: string;
	/** `groups` attribute: the groups that may see the field (raw xmlids). */
	groups?: string[];
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

/** `groups="a,b"` → ["a", "b"]; empty pieces dropped, order kept. */
function splitGroups(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
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
				btn.groups = splitGroups(attrs["groups"]);
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
				f.groups = splitGroups(attrs["groups"]);
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

/** One menu of the module: what the user clicks, and what it opens. */
export interface CanonModuleMenu extends CanonMenu {
	/** `sequence` of ir.ui.menu — reading order among siblings. */
	sequence?: number;
	/** The action the menu opens, when it opens one. */
	actionXmlid?: string;
	actionName?: string;
	/** res_model of that action, when it has one. */
	model?: string;
	/** Groups allowed to see the menu (xmlids); absente = everyone. */
	groups?: string[];
}

/** One action of the module, whatever `ir.actions.*` it is. */
export interface CanonModuleAction extends CanonAction {
	/** The `ir.actions.*` model the row came from (act_window, server, report…). */
	kind: string;
	/** The model the action acts on, when it names one. */
	model?: string;
	/** Technical detail of the kind: server state, report_name, client tag, url. */
	detail?: string;
	/** Groups allowed to run the action (xmlids); absente = everyone. */
	groups?: string[];
}

/** One field of a model, with the evidence a manual may state. */
export interface CanonField {
	name: string;
	string: string;
	type: string;
	required: boolean;
	readonly?: boolean;
	selection?: Array<[string, string]>;
	relation?: string;
	/** `modules` of ir.model (model-level provenance), when the collector set it. */
	modules?: string;
	/** Groups allowed to see the field (xmlids). */
	groups?: string[];
}

/** What one group may do with one model (from ir.model.access). */
export interface CanonModelAccess {
	group: string;
	groupName: string;
	read: boolean;
	write: boolean;
	create: boolean;
	unlink: boolean;
}

/**
 * One model the module implements, read field by field: this is the surface the
 * manual must document (every field, every button, every state). `unreadable`
 * records a server that refused the reads instead of pretending the model has
 * no fields.
 */
export interface CanonModelDoc {
	model: string;
	name: string;
	transient: boolean;
	fields: CanonField[];
	buttons: ArchButton[];
	statusbar?: { field: string; visibleStates?: string[] };
	pages: ArchPage[];
	/** Per-group rights, one row per ir.model.access row of the model. */
	access: CanonModelAccess[];
	unreadable?: string;
}

/**
 * The module-wide inventory. A per-model canon answers "what does this screen
 * do"; this one answers "what does the MODULE have", so a manual can cover
 * every menu, every action, every field and every button instead of only the
 * ones that reach one model. It is built from the module's own xml ids, never
 * from a name match.
 */
export interface CanonModule {
	name: string;
	/** EVERY menu the module owns, in menu order. */
	menus: CanonModuleMenu[];
	/** EVERY action the module owns. */
	actions: CanonModuleAction[];
	/** EVERY model the module implements, with its fields, buttons and rights. */
	models: CanonModelDoc[];
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

/**
 * The interview answers the manual is written from. The tool records what it
 * was TOLD and what it could SEE (the connected login); it never invents the
 * rest — a missing answer stays null and `lint` reports INTERVIEW-MISSING.
 */
export interface CanonInterview {
	/** The user the manual documents (login or "admin"), as declared. */
	asUser: string | null;
	/** Where `asUser` came from: the caller, the connected session, or nowhere. */
	asUserSource: "declared" | "connected" | "unknown";
	/** true when the documenting user is an administrator. */
	admin: boolean;
	/** Login of the connected user, when the transport could read it. */
	connectedLogin: string | null;
	/** Modules the manual covers (technical names, in the order given). */
	modules: string[];
	/** Access groups to walk (xmlids); empty = every group the modules declare. */
	groups: string[];
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
	fields: CanonField[];
	/** The field-attribute key this server uses for group restriction. */
	groupsAttr: "groups_id" | "group_ids";
	actions: CanonAction[];
	menus: CanonMenu[];
	access: CanonAccess;
	errors: { own?: CanonErrorSource; community?: CanonErrorSource; enterprise?: CanonErrorSource };
	/** The interview: who it is written for, which modules, which groups. */
	interview?: CanonInterview;
	/**
	 * Present only when the canon was read with `module`: the whole module
	 * surface (every menu, every action, every model's fields and buttons). A
	 * manual planned against it must cover all of it — `validateStoryboard`
	 * reports MODULE-COVERAGE / FIELD-COVERAGE / BUTTON-COVERAGE /
	 * WORKFLOW-COVERAGE / GROUP-COVERAGE.
	 */
	module?: CanonModule;
	/** One inventory per covered module (module, and modules, in order). */
	modules?: CanonModule[];
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
		// Absent for a per-model canon: JSON.stringify drops the key, so every
		// storyboard planned before module scope existed keeps its fingerprint.
		module: canon.module,
		modules: canon.modules,
		// The interview is part of the documentation basis: a different audience
		// or walk list is another canon.
		interview: canon.interview,
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
	/** Present when the canon carries the module inventory (module scope). */
	module?: { name: string; menus: number; actions: number; models: number };
	/** One entry per covered module (module and modules). */
	modules?: Array<{ name: string; menus: number; actions: number; models: number }>;
	/** The interview answers, when the canon recorded them. */
	interview?: { asUser: string | null; admin: boolean; modules: string[]; groups: number };
}

/** Bounded summary for display paths — never the full canon. */
export function summarizeCanon(canon: Canon): CanonSummary {
	const formArch = canon.views.find((v) => v.type === "form")?.arch;
	const moduleLine = (m: CanonModule): { name: string; menus: number; actions: number; models: number } => ({
		name: m.name,
		menus: m.menus.length,
		actions: m.actions.length,
		models: m.models.length,
	});
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
		...(canon.module ? { module: moduleLine(canon.module) } : {}),
		...(canon.modules ? { modules: canon.modules.map(moduleLine) } : {}),
		...(canon.interview
			? { interview: { asUser: canon.interview.asUser, admin: canon.interview.admin, modules: canon.interview.modules, groups: canon.interview.groups.length } }
			: {}),
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
	/**
	 * Technical name of the module to inventory. Given it, the canon also
	 * carries EVERY menu and EVERY action the module owns (`canon.module`), and
	 * the storyboard is checked for coverage of all of them.
	 */
	module?: string;
	/** Every module to inventory (`modules`); `module` is kept for one module. */
	modules?: string[];
	/** The user the manual documents, as declared by the caller. */
	asUser?: string;
	/** Whether that user is an administrator, as declared by the caller. */
	admin?: boolean;
	/** Groups to walk (xmlids); empty = derive them from the modules' own menus. */
	groups?: string[];
	/** Local checkouts of Community / Enterprise, for native error evidence. */
	repos?: { communityPath?: string; enterprisePath?: string };
}

/**
 * The interview, as recorded in the canon: what the caller declared, plus the
 * connected login the transport could read. `unknown` is an answer — the tool
 * never turns a missing declaration into an invented one.
 */
async function collectInterview(client: CanonClient, request: CanonRequest, language: string, inventory: CanonModule[]): Promise<CanonInterview> {
	const declared = typeof request.asUser === "string" && request.asUser.trim() !== "" ? request.asUser.trim() : null;
	let connectedLogin: string | null = null;
	/** Whether the connected user is a Settings administrator (base.group_system). */
	let connectedIsAdmin: boolean | null = null;
	const uid = client.currentUid?.() ?? null;
	if (uid !== null) {
		const rows = await read(client, "res.users", "read", [[uid], ["login", "groups_id"]], language, "res.users(login)");
		const row = rows.ok ? rows.value[0] : undefined;
		if (row && typeof row["login"] === "string") connectedLogin = row["login"] as string;
		if (row && Array.isArray(row["groups_id"])) {
			const xmlids = await readGroupXmlids(client, (row["groups_id"] as unknown[]).map((g) => refId(g) ?? Number.NaN), language);
			connectedIsAdmin = (row["groups_id"] as unknown[]).some((g) => {
				const id = refId(g);
				return id !== undefined && xmlids.get(id) === "base.group_system";
			});
		}
	}
	const declaredGroups = (request.groups ?? []).filter((g) => g.trim() !== "");
	// Default walk list: every group the inventoried modules actually mention on
	// a menu, an action or a model access row — the module's own declaration.
	const derived = new Set<string>();
	for (const m of inventory) {
		for (const menu of m.menus) for (const g of menu.groups ?? []) derived.add(g);
		for (const action of m.actions) for (const g of action.groups ?? []) derived.add(g);
		for (const doc of m.models) for (const a of doc.access) if (a.group !== "everyone") derived.add(a.group);
	}
	return {
		asUser: declared ?? (connectedLogin !== null ? `The connected user (${connectedLogin})` : null),
		asUserSource: declared !== null ? "declared" : connectedLogin !== null ? "connected" : "unknown",
		admin: request.admin ?? connectedIsAdmin ?? false,
		connectedLogin,
		modules: inventory.map((m) => m.name),
		groups: declaredGroups.length > 0 ? declaredGroups : [...derived].sort((a, b) => a.localeCompare(b)),
	};
}

export type CanonResult = { ok: true; canon: Canon } | { ok: false; blocked: string };

export interface Row {
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

/** Field lists per `ir.actions.*` model: what that kind can honestly say. */
const ACTION_FIELDS: Record<string, string[]> = {
	"ir.actions.act_window": ["name", "res_model", "view_mode", "domain", "context", "target"],
	"ir.actions.server": ["name", "model_name", "state"],
	"ir.actions.client": ["name", "tag"],
	"ir.actions.report": ["name", "model", "report_name"],
	"ir.actions.act_url": ["name", "url", "target"],
	"ir.actions.url": ["name", "url", "target"],
};

/**
 * Navigable kinds: a flow can OPEN one with goto, so MODULE-COVERAGE can demand
 * a flow for them. A server action is triggered by a button, not navigated to,
 * and is reported as prose territory instead of an unfixable ERROR.
 */
export const NAVIGABLE_ACTIONS = new Set(["ir.actions.act_window", "ir.actions.act_url", "ir.actions.url", "ir.actions.client", "ir.actions.report"]);

/** The kind-specific detail: a server state, a client tag, a report name, a url. */
function actionDetail(kind: string, row: Row): string | undefined {
	const field =
		kind === "ir.actions.server" ? "state"
		: kind === "ir.actions.client" ? "tag"
		: kind === "ir.actions.report" ? "report_name"
		: kind === "ir.actions.act_url" || kind === "ir.actions.url" ? "url"
		: "";
	return field !== "" && typeof row[field] === "string" ? (row[field] as string) : undefined;
}

/**
 * Every menu and every action the module OWNS. `ir.model.data` is the authority
 * on ownership — a module that merely extends a native action does not own it —
 * so the inventory is built from the module's own xml ids, never from a name
 * match. Nothing is inferred: a read that fails is BLOCKED, and whatever lacks
 * an xml id is reported by the coverage rule instead of being guessed.
 */
/** id part of a Reference ("res.groups,4" or [4, "name"] or false). */
function refId(raw: unknown): number | undefined {
	if (Array.isArray(raw) && typeof raw[0] === "number") return raw[0];
	if (typeof raw === "string") {
		const comma = raw.indexOf(",");
		const id = comma > 0 ? Number(raw.slice(comma + 1)) : Number.NaN;
		if (Number.isFinite(id)) return id;
	}
	return undefined;
}

/** display name of a Reference, when the row carries one. */
function refName(raw: unknown): string | undefined {
	if (Array.isArray(raw) && typeof raw[1] === "string") return raw[1];
	return undefined;
}

/** xmlids of `res.groups` rows, by id. A failed read answers "unknown", not "none". */
async function readGroupXmlids(client: CanonClient, ids: number[], language: string): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	const wanted = [...new Set(ids.filter(Number.isFinite))];
	if (wanted.length === 0) return out;
	const rows = await read(client, "ir.model.data", "search_read", [[["model", "=", "res.groups"], ["res_id", "in", wanted]], ["module", "name", "res_id"]], language, "ir.model.data(groups)");
	if (!rows.ok) return out;
	for (const r of rows.value) out.set(Number(r["res_id"]), `${r["module"]}.${r["name"]}`);
	return out;
}

/**
 * The groups allowed to see rows of a model, when that model has the field.
 * `undefined` (no entry) means "not restricted, or the server refused the read"
 * — the manual never claims "everyone" from a read it did not get.
 */
async function readRowGroups(client: CanonClient, model: string, ids: number[], field: string, language: string): Promise<Map<number, string[]>> {
	const out = new Map<number, string[]>();
	if (ids.length === 0) return out;
	const rows = await read(client, model, "search_read", [[["id", "in", ids]], ["id", field]], language, `${model}(${field})`);
	if (!rows.ok) return out;
	const groupIds: number[] = [];
	for (const r of rows.value) {
		if (!Array.isArray(r[field])) continue;
		for (const g of r[field] as unknown[]) {
			const id = refId(g);
			if (id !== undefined) groupIds.push(id);
		}
	}
	const xmlids = await readGroupXmlids(client, groupIds, language);
	for (const r of rows.value) {
		if (!Array.isArray(r[field])) continue;
		const names = (r[field] as unknown[]).map((g) => (refId(g) !== undefined ? xmlids.get(refId(g) as number) : undefined)).filter((x): x is string => x !== undefined);
		if (names.length > 0) out.set(Number(r["id"]), names);
	}
	return out;
}

/** The form and list arches of one model, through the same version-aware call the canon uses. */
async function readModelArches(client: CanonClient, model: string, major: number, language: string): Promise<{ form?: ArchCanon; list?: ArchCanon }> {
	const wanted: Array<[false, "form" | "list"]> = [[false, "form"], [false, "list"]];
	const res = await
		(major >= 16
			? client.executeKw<{ views: Record<string, { arch: string }> }>(model, "get_views", [wanted], { options: { toolbar: true }, context: { lang: language } })
			: client.executeKw<{ fields_views: Record<string, { arch: string }> }>(model, "load_views", [wanted], { options: { toolbar: true, load_filters: true }, context: { lang: language } }));
	if (!res.ok) return {};
	const raw = major >= 16
		? (res.value as { views: Record<string, { arch: string }> }).views
		: (res.value as unknown as { fields_views: Record<string, { arch: string }> }).fields_views;
	return {
		...(raw["form"]?.arch ? { form: parseArch(String(raw["form"].arch)) } : {}),
		...(raw["list"]?.arch ? { list: parseArch(String(raw["list"].arch)) } : {}),
	};
}

/**
 * One model, read field by field: every field (with its type, its label, its
 * selection or relation, and its group restriction), every button of the form,
 * the statusbar the workflow runs through, and the per-group rights. This is
 * the surface the manual has to document — a model the server refuses is
 * recorded as `unreadable` instead of being reported as empty.
 */
async function collectModelDoc(
	client: CanonClient,
	row: Row,
	major: number,
	language: string,
	groupsAttr: "groups_id" | "group_ids",
): Promise<CanonModelDoc> {
	const model = String(row["model"] ?? "");
	const doc: CanonModelDoc = {
		model,
		name: String(row["name"] ?? model),
		transient: row["transient"] === true || String(row["transient"] ?? "") === "True",
		fields: [],
		buttons: [],
		pages: [],
		access: [],
	};
	const fg = await client.executeKw<Record<string, Row>>(model, "fields_get", [], {
		attributes: ["string", "type", "required", "readonly", "selection", "relation", "store", "modules", groupsAttr],
		context: { lang: language },
	});
	if (!fg.ok) {
		doc.unreadable = `fields_get: ${fg.error}`;
		return doc;
	}
	doc.fields = Object.entries(fg.value)
		.map(([name, def]) => ({
			name,
			string: String(def["string"] ?? name),
			type: String(def["type"] ?? ""),
			required: def["required"] === true,
			readonly: def["readonly"] === true,
			selection: Array.isArray(def["selection"]) ? (def["selection"] as Array<[string, string]>) : undefined,
			relation: typeof def["relation"] === "string" ? def["relation"] : undefined,
			modules: typeof def["modules"] === "string" ? def["modules"] : undefined,
			groups: Array.isArray(def[groupsAttr])
				? (def[groupsAttr] as unknown[]).map((g) => refName(g)).filter((n): n is string => typeof n === "string")
				: undefined,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const arches = await readModelArches(client, model, major, language);
	if (arches.form) {
		doc.pages = arches.form.pages;
		if (arches.form.statusbar) doc.statusbar = { field: arches.form.statusbar.field, visibleStates: arches.form.statusbar.visibleStates };
	}
	// Buttons of the form AND of the list: both are workflows a manual documents.
	const byName = new Map<string, ArchButton>();
	for (const b of [...(arches.form?.buttons ?? []), ...(arches.list?.buttons ?? [])]) {
		const key = `${b.name}|${b.type ?? "object"}|${b.string ?? ""}`;
		if (b.name && !byName.has(key)) byName.set(key, b);
	}
	doc.buttons = [...byName.values()];
	const accessRows = await read(client, "ir.model.access", "search_read", [[["model_id", "=", Number(row["id"])]], ["name", "group_id", "perm_read", "perm_write", "perm_create", "perm_unlink"]], language, "ir.model.access");
	if (accessRows.ok) {
		const xmlids = await readGroupXmlids(client, accessRows.value.map((r) => refId(r["group_id"]) ?? Number.NaN), language);
		doc.access = accessRows.value.slice(0, READ_LIMIT).map((r) => {
			const gid = refId(r["group_id"]);
			return {
				group: gid === undefined ? "everyone" : (xmlids.get(gid) ?? `res.groups,${gid}`),
				groupName: refName(r["group_id"]) ?? (gid === undefined ? "Everyone" : `Group ${gid}`),
				read: r["perm_read"] === true,
				write: r["perm_write"] === true,
				create: r["perm_create"] === true,
				unlink: r["perm_unlink"] === true,
			};
		});
	}
	return doc;
}

/**
 * Every menu and every action the module OWNS. `ir.model.data` is the authority
 * on ownership — a module that merely extends a native action does not own it —
 * so the inventory is built from the module's own xml ids, never from a name
 * match. Every model the module implements is then read field by field, so the
 * manual can cover every field, every button and every state. Nothing is
 * inferred: a read that fails is BLOCKED (or `unreadable` for one model), and
 * whatever lacks an xml id is reported by the coverage rules instead of guessed.
 */
async function collectModuleInventory(
	client: CanonClient,
	module: string,
	language: string,
	major: number,
	groupsAttr: "groups_id" | "group_ids",
): Promise<{ ok: true; value: CanonModule } | { ok: false; blocked: string }> {
	const dataRows = await read(client, "ir.model.data", "search_read", [[["module", "=", module]], ["module", "model", "res_id", "name"]], language, `ir.model.data(${module})`);
	if (!dataRows.ok) return { ok: false, blocked: dataRows.error };
	const ownedMenus: Array<{ resId: number; name: string }> = [];
	const ownedActions = new Map<string, Array<{ resId: number; name: string }>>();
	for (const r of dataRows.value) {
		const model = String(r["model"] ?? "");
		const resId = Number(r["res_id"]);
		if (!Number.isFinite(resId)) continue;
		if (model === "ir.ui.menu") ownedMenus.push({ resId, name: String(r["name"] ?? "") });
		else if (model.startsWith("ir.actions.")) {
			const list = ownedActions.get(model) ?? [];
			list.push({ resId, name: String(r["name"] ?? "") });
			ownedActions.set(model, list);
		}
	}

	// Actions: one read per `ir.actions.*` model the module actually owns. The
	// declared fields go first; a model that refuses one of them is read again
	// with just `name`, so its detail stays empty instead of being invented.
	const actions: CanonModuleAction[] = [];
	for (const [kind, rows] of ownedActions) {
		const ids = rows.map((r) => r.resId);
		const wanted = ACTION_FIELDS[kind] ?? ["name"];
		let readRows = await read(client, kind, "search_read", [[["id", "in", ids]], wanted], language, kind);
		if (!readRows.ok) readRows = await read(client, kind, "search_read", [[["id", "in", ids]], ["name"]], language, kind);
		if (!readRows.ok) return { ok: false, blocked: readRows.error };
		const groupRows = await readRowGroups(client, kind, ids, groupsAttr, language);
		const xmlByRes = new Map(rows.map((r) => [r.resId, `${module}.${r.name}`]));
		for (const r of readRows.value) {
			const xmlid = xmlByRes.get(Number(r["id"]));
			const modelField = kind === "ir.actions.server" ? r["model_name"] : (r["res_model"] ?? r["model"]);
			actions.push({
				xmlid,
				name: String(r["name"] ?? xmlid ?? "(unnamed)"),
				kind,
				model: typeof modelField === "string" && modelField !== "" ? modelField : undefined,
				viewMode: typeof r["view_mode"] === "string" ? r["view_mode"] : undefined,
				domain: typeof r["domain"] === "string" ? r["domain"] : undefined,
				context: typeof r["context"] === "string" ? r["context"] : undefined,
				target: typeof r["target"] === "string" ? r["target"] : undefined,
				detail: actionDetail(kind, r),
				groups: groupRows.get(Number(r["id"])),
			});
		}
	}
	actions.sort((a, b) => (a.xmlid ?? a.name).localeCompare(b.xmlid ?? b.name));

	// Menus, in menu order. `action` is a Reference ("ir.actions.act_window,42")
	// resolved through ir.model.data, so a menu may open a NATIVE action the
	// module reuses and still be covered by a flow.
	const menus: CanonModuleMenu[] = [];
	if (ownedMenus.length > 0) {
		const menuRows = await read(client, "ir.ui.menu", "search_read", [[["id", "in", ownedMenus.map((m) => m.resId)]], ["complete_name", "sequence", "action"]], language, `ir.ui.menu(${module})`);
		if (!menuRows.ok) return { ok: false, blocked: menuRows.error };
		const menuGroups = await readRowGroups(client, "ir.ui.menu", ownedMenus.map((m) => m.resId), groupsAttr, language);
		const refs = new Map<string, number[]>();
		const parsed = menuRows.value.map((row) => {
			const raw = typeof row["action"] === "string" ? row["action"] : "";
			const comma = raw.indexOf(",");
			const refModel = comma > 0 ? raw.slice(0, comma) : "";
			const refId = comma > 0 ? Number(raw.slice(comma + 1)) : Number.NaN;
			if (refModel !== "" && Number.isFinite(refId)) refs.set(refModel, [...(refs.get(refModel) ?? []), refId]);
			return { row, refModel, refId };
		});
		const xmlByRef = new Map<string, string>();
		for (const [refModel, refIds] of refs) {
			const rows = await read(client, "ir.model.data", "search_read", [[["model", "=", refModel], ["res_id", "in", refIds]], ["module", "name", "res_id"]], language, `ir.model.data(${refModel})`);
			if (!rows.ok) return { ok: false, blocked: rows.error };
			for (const r of rows.value) xmlByRef.set(`${refModel},${String(r["res_id"])}`, `${r["module"]}.${r["name"]}`);
		}
		const actionByXml = new Map(actions.filter((a) => a.xmlid).map((a) => [a.xmlid as string, a]));
		const xmlByMenuRes = new Map(ownedMenus.map((m) => [m.resId, `${module}.${m.name}`]));
		for (const { row, refModel, refId } of parsed) {
			const actionXmlid = refModel !== "" ? xmlByRef.get(`${refModel},${refId}`) : undefined;
			const action = actionXmlid ? actionByXml.get(actionXmlid) : undefined;
			menus.push({
				xmlid: xmlByMenuRes.get(Number(row["id"])),
				completeName: String(row["complete_name"] ?? row["name"] ?? ""),
				sequence: typeof row["sequence"] === "number" ? row["sequence"] : undefined,
				actionXmlid,
				actionName: action?.name,
				model: action?.model,
				groups: menuGroups.get(Number(row["id"])),
			});
		}
		menus.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.completeName.localeCompare(b.completeName));
	}

	// The models the module implements, read one by one: `ir.model.modules` is
	// a comma-separated list, so the `like` prefilter is confirmed exactly.
	const modelRows = await read(client, "ir.model", "search_read", [[["modules", "like", module]], ["id", "model", "name", "modules", "transient"]], language, `ir.model(${module})`);
	if (!modelRows.ok) return { ok: false, blocked: modelRows.error };
	const owned = modelRows.value.filter((r) => String(r["modules"] ?? "").split(",").map((s) => s.trim()).includes(module));
	const models: CanonModelDoc[] = [];
	for (const row of owned.sort((a, b) => String(a["model"]).localeCompare(String(b["model"])))) {
		models.push(await collectModelDoc(client, row, major, language, groupsAttr));
	}

	return { ok: true, value: { name: module, menus, actions, models } };
}

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

	// 6b. Module inventory — only when the canon was asked for a module: every
	//     menu, every action and every model's fields and buttons. This is the
	//     surface the coverage rules hold the storyboard to, so a failed read is
	//     BLOCKED (a silently smaller inventory would silently drop menus).
	const inventories: CanonModule[] = [];
	for (const name of [...new Set([...(request.modules ?? []), ...(request.module ? [request.module] : [])])].filter((m) => m.trim() !== "")) {
		const inventory = await collectModuleInventory(client, name, language, major, groupsAttr);
		if (!inventory.ok) return { ok: false, blocked: inventory.blocked };
		inventories.push(inventory.value);
	}
	const interview = await collectInterview(client, request, language, inventories);

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
			interview,
			...(inventories.length > 0 ? { module: inventories[0], modules: inventories } : {}),
		},
	};
}
