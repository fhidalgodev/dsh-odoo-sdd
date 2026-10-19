/**
 * Data model and workspace resolution for the narrated user manuals
 * (`odoo_manual`). A storyboard is the durable artifact: flows of steps the
 * storyteller plans against the canon, the capturer photographs, and the
 * renderer compiles. Nothing here talks to Odoo — that is `manual-canon.ts`.
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomic.js";
import { canonFingerprint, NAVIGABLE_ACTIONS } from "./manual-canon.js";

// ---------------------------------------------------------------------------
// Storyboard types
// ---------------------------------------------------------------------------

/** Where the model wants to land. Every kind resolves WITHOUT inventing data. */
export interface Target {
	kind: "action" | "menu" | "url" | "record";
	/** xml id of `ir.actions.act_window` / `ir.ui.menu` (action/menu kinds). */
	xmlid?: string;
	/** Same-origin URL (url kind); anything else is rejected by the capturer. */
	url?: string;
	/** res.model of the screen (record kind). */
	model?: string;
	/** Database id when the flow targets one existing record. */
	recordId?: number;
}

/** The step vocabulary. Anything that mutates is gated by `allow_actions`. */
export type StepKind =
	| "goto"
	| "menu"
	| "new"
	| "fill"
	| "click"
	| "select"
	| "press"
	| "drag"
	| "wait"
	| "confirm"
	| "assert"
	| "explore"
	| "screenshot";

export interface Step {
	id: string;
	kind: StepKind;
	/**
	 * One-sentence narration of WHAT the user does and sees (the OCA
	 * "1 sentence / 1 image" rule). `null` marks a TODO for the storyteller.
	 */
	procedure: string | null;
	target?: Target;
	/** Canonical field name (fill/select), button method (click), etc. */
	field?: string;
	value?: string;
	/** Class of effect: mutating steps need the explicit action policy. */
	safety?: "read-only" | "action";
	/** Expected failure and what to do about it (the `recovery` rule). */
	note?: string;
}

/** Evidence that a screenshot was taken for one step. */
export interface CaptureRecord {
	stepId: string;
	/** Path of the PNG, relative to the manual workspace. */
	file: string;
	sha256?: string;
	width?: number;
	height?: number;
	takenAt?: string;
}

export interface Flow {
	id: string;
	title: string;
	/** What the flow documents: one record screen, one menu entry, one group walk. */
	kind?: "model" | "menu" | "group";
	/** res.model the flow lives on, when it is a record flow. */
	model?: string;
	/** res.groups xml id the flow is written for (top-down audience). */
	role?: string;
	audience?: string;
	steps: Step[];
	/** What to do when the flow's own action fails (recovery rule). */
	recovery?: string;
	captures?: CaptureRecord[];
}

/** The interview the storyboard declares (INTERVIEW-MISSING until it does). */
export interface StoryboardInterview {
	/** The user the manual documents (login or "admin"). */
	asUser: string | null;
	/** Whether that user is an administrator. */
	admin: boolean;
	/** Modules the manual covers. */
	modules: string[];
	/** Access groups to walk (xmlids). */
	groups: string[];
}

/** What the storyteller wrote for ONE model: prose only, never evidence. */
export interface ModelDocs {
	/** "What this field is for", by field name (the TYPE comes from the canon). */
	fields?: Record<string, string>;
	/** "What this button does", by button name. */
	buttons?: Record<string, string>;
	/** The workflow: how the record moves from state to state. */
	workflow?: string;
	/** Fields or buttons deliberately left out, with the reason. */
	skip?: Record<string, string>;
}

export interface StoryboardDocs {
	asUser?: string;
	admin?: boolean;
	modules?: string[];
	groups?: string[];
	/** Why the walk list is what it is (roles the manual cannot impersonate). */
	groupsWhy?: string;
	/** Per model technical name, the narrative the manual renders. */
	models?: Record<string, ModelDocs>;
}

export interface Storyboard {
	schema: "dsh-odoo-sdd/manual/1";
	slug: string;
	language?: string;
	flows: Flow[];
	/** The interview answers this manual was written for. */
	interview?: StoryboardInterview;
	/** The prose the storyteller wrote on top of the canon's evidence. */
	docs?: StoryboardDocs;
	/** Canon fingerprint this storyboard was planned against (CANON-STALE). */
	canonFingerprint?: string;
	updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Workspace resolution — the manuals live where Settings says
// ---------------------------------------------------------------------------

export type ManualsMode = "specs" | "docs" | "module";

export interface ResolveManualWorkspaceInput {
	mode: ManualsMode;
	/** `manualsDir` from the configuration (docs mode). */
	dir: string;
	projectRoot: string;
	/** Root that holds spec directories (project `specsDir` or central root). */
	specsBase: string;
	specDir?: string;
	moduleDir?: string;
	slug: string;
}

export type ManualWorkspaceResult =
	| { ok: true; dir: string }
	| { ok: false; blocked: string };

/**
 * A slug is one path segment of the manual folder: safe characters only, and
 * never an ascending reference, so a slug can never escape its base.
 */
export function isSafeSegment(slug: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..");
}

/** True when `p` is `root` or lives under it (lexically, after resolving). */
export function isWithinRoot(p: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(p));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Where the manual for `slug` lives, per the configured mode:
 *
 * - `specs` (default): `<specsBase>/manuals/<slug>/` — next to the spec that
 *   documents the change.
 * - `docs`: `<projectRoot>/<manualsDir>/<slug>/` — a documentation tree the
 *   project owns; `manualsDir` may not point outside the project.
 * - `module`: `<module_dir>/readme/manual/<slug>/` — OCA fragments shipped
 *   with the module. WITHOUT a `module_dir` this is BLOCKED: standalone work
 *   must pick specs or docs, never guess a module.
 *
 * A missing spec never blocks here: manuals are optional, and standalone
 * manuals (no spec at all) are a first-class path.
 */
export function resolveManualWorkspace(input: ResolveManualWorkspaceInput): ManualWorkspaceResult {
	if (!isSafeSegment(input.slug)) {
		return { ok: false, blocked: `slug "${input.slug}" is not a safe folder name (letters, digits, dot, dash, underscore).` };
	}
	// A configured path can arrive as something other than a string: the
	// Settings layer resolves a field it has no value for to a descriptor
	// object, and `node:path` answers that with "The \"path\" argument must be
	// of type string. Received an instance of Object" — a message that names
	// neither the setting nor the tool, and that took the whole manual surface
	// down. The shape is checked HERE, where the offending key can be named and
	// the developer told what to fix. Only the fields the chosen mode actually
	// reads are examined, so a broken setting this manual never touches cannot
	// block it.
	const shape = (value: unknown): string =>
		value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "number" ? "a number" : "an object";
	// Only the fields the chosen mode actually reads are examined, so a broken
	// setting this manual never touches cannot block it. A value that is simply
	// ABSENT is not a shape problem: the mode's own check explains what it needs
	// (module mode without a module_dir, for instance), which is a better
	// message than "undefined is not a folder".
	const checked: Array<[name: string, value: unknown, needed: boolean, optional: boolean]> = [
		["manualsDir", input.dir, input.mode === "docs", false],
		["specsBase", input.specsBase, input.mode === "specs", false],
		["projectRoot", input.projectRoot, input.mode === "docs", false],
		["specDir", input.specDir, input.mode === "specs", true],
		["module_dir", input.moduleDir, input.mode === "module", true],
	];
	const hint: Record<string, string> = {
		manualsDir: 'Set it in Settings → Odoo SDD or in the project\'s .sdd/config.json (for manualsDir, for example, "docs/manuals").',
		specsBase: "It is derived from specsMode/specsDir/specsRoot: check those in Settings → Odoo SDD or in the project's .sdd/config.json.",
		projectRoot: "It is the folder this session opened: open the project folder in the session, or configure projectRoot for headless hosts.",
		specDir: "It is derived from spec_id: name a spec that exists, or leave it out for a standalone manual.",
		module_dir: "It comes from module_dir: pass the folder that holds __manifest__.py.",
	};
	for (const [name, value, needed, optional] of checked) {
		if (!needed) continue;
		if (optional && (value === undefined || value === null)) continue;
		if (typeof value === "string" && value.trim() !== "") continue;
		return {
			ok: false,
			blocked:
				`${name} is not a folder path (it arrived as ${typeof value === "string" ? "an empty string" : shape(value)}), so the manual folder cannot be resolved. ` +
				(hint[name] ?? ""),
		};
	}
	if (input.mode === "module") {
		if (!input.moduleDir) {
			return {
				ok: false,
				blocked:
					"manualsMode=module needs module_dir: module manuals are OCA fragments under <module_dir>/readme/manual/ and there is no module to attach them to. Name a module_dir, or use manualsMode=specs|docs for standalone manuals.",
			};
		}
		return { ok: true, dir: join(input.moduleDir, "readme", "manual", input.slug) };
	}
	if (input.mode === "docs") {
		const base = isAbsolute(input.dir) ? input.dir : join(input.projectRoot, input.dir);
		if (!isWithinRoot(base, input.projectRoot)) {
			return {
				ok: false,
				blocked: `manualsDir "${input.dir}" resolves outside the project root; manuals in docs mode must stay inside the project.`,
			};
		}
		return { ok: true, dir: join(base, input.slug) };
	}
	// specs mode: next to the spec when there is one, in the shared manuals
	// tree of the specs layout otherwise (standalone work included).
	const base = input.specDir && isWithinRoot(input.specDir, input.specsBase) ? dirname(input.specDir) : input.specsBase;
	return { ok: true, dir: join(base, "manuals", input.slug) };
}

// ---------------------------------------------------------------------------
// Storyboard persistence (atomic, idempotent, create-only where noted)
// ---------------------------------------------------------------------------

export const STORYBOARD_FILE = "storyboard.json";

export function readStoryboard(dir: string): Storyboard | null {
	const file = join(dir, STORYBOARD_FILE);
	if (!existsSync(file)) return null;
	const raw = readFileSync(file, "utf8");
	const parsed = JSON.parse(raw) as Storyboard;
	if (parsed?.schema !== "dsh-odoo-sdd/manual/1") {
		throw new Error(`${file} is not a dsh-odoo-sdd manual storyboard (bad schema).`);
	}
	return parsed;
}

export function writeStoryboard(dir: string, sb: Storyboard): void {
	mkdirSync(dir, { recursive: true });
	sb.updatedAt = new Date().toISOString();
	writeFileAtomic(join(dir, STORYBOARD_FILE), JSON.stringify(sb, null, 2) + "\n");
}

/** Stable id for a new flow: `f1`, `f2`, … — never reused, create-only. */
export function nextFlowId(sb: Storyboard): string {
	let n = sb.flows.length + 1;
	while (sb.flows.some((f) => f.id === `f${n}`)) n += 1;
	return `f${n}`;
}

/** Stable id for a new step inside a flow: `s01`, `s02`, … */
export function nextStepId(flow: Flow): string {
	let n = flow.steps.length + 1;
	while (flow.steps.some((s) => s.id === `s${String(n).padStart(2, "0")}`)) n += 1;
	return `s${String(n).padStart(2, "0")}`;
}

export interface ManualRef {
	slug: string;
	dir: string;
	storyboard: Storyboard;
}

/** Every manual in a manuals tree (one level of slugs, storyboard only). */
export function listManuals(base: string): ManualRef[] {
	if (!existsSync(base)) return [];
	const out: ManualRef[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
		const dir = join(base, entry.name);
		const file = join(dir, STORYBOARD_FILE);
		if (!existsSync(file)) continue;
		try {
			out.push({ slug: entry.name, dir, storyboard: readStoryboard(dir) as Storyboard });
		} catch {
			// A broken storyboard is reported by its readers, not fatal here.
		}
	}
	return out;
}

/** sha256 of a rendered artifact — the render-protection fingerprint. */
export function sha256Of(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Planning and validation against the canon (Motor 2)
// ---------------------------------------------------------------------------

import type { Canon, CanonModule } from "./manual-canon.js";

/** Steps that only LOOK at the instance — always allowed to capture. */
export const READ_ONLY_KINDS: readonly StepKind[] = ["goto", "menu", "wait", "assert", "explore", "screenshot", "confirm"];
/** Steps that MUTATE the record — gated behind `allow_actions` (Fase 3). */
export const ACTION_KINDS: readonly StepKind[] = ["new", "fill", "select", "press", "click", "drag"];

export const stepSafety = (kind: StepKind): "read-only" | "action" =>
	(ACTION_KINDS as readonly string[]).includes(kind) ? "action" : "read-only";

export interface StoryboardFinding {
	/** Canon rules (plan/lint) or prose rules (prose-lint). */
	rule: string;
	severity: "ERROR" | "WARN";
	message: string;
	flow?: string;
	step?: string;
	line?: number;
}

/**
 * Draft the skeleton storyboard from the canon: one flow per model with a
 * statusbar — `goto` the action, `new`, `fill` every required field, then the
 * header buttons in state order. Narration stays `null` (the storyteller
 * writes it; TODO). Nothing here invents data: every target/field/button comes
 * from the canon or the step is not emitted.
 */
export function planStoryboard(canon: Canon, slug: string): Storyboard {
	const sb: Storyboard = { schema: "dsh-odoo-sdd/manual/1", slug, flows: [], canonFingerprint: undefined };
	// The interview the canon recorded becomes the draft's declaration: the
	// storyteller edits it, but a planned storyboard never starts empty.
	if (canon.interview) {
		sb.interview = { asUser: canon.interview.asUser, admin: canon.interview.admin, modules: canon.interview.modules, groups: canon.interview.groups };
	}
	// Module scope FIRST: one read-only flow per menu the module owns, so the
	// manual covers every entry point of the module. Planned before the form
	// guard — a module manual must not lose its menus because the model it was
	// read for happens to have no form view.
	for (const inventory of inventoriesOf(canon)) planMenuFlows(inventory, sb);
	planGroupFlows(canon, sb);
	sb.docs = seedDocs(canon);
	const form = canon.views.find((v) => v.type === "form");
	if (!form) return sb;
	const firstAction = canon.actions[0];
	const firstMenu = canon.menus[0];
	const statusbarStates = form.arch.statusbar?.visibleStates;
	const flow: Flow = {
		id: "f1",
		title: canon.model,
		kind: "model",
		model: canon.model,
		steps: [],
	};
	flow.steps.push({
		id: "s01",
		kind: firstAction?.xmlid ? "goto" : "menu",
		procedure: null,
		target: firstAction?.xmlid
			? { kind: "action", xmlid: firstAction.xmlid }
			: firstMenu?.xmlid
				? { kind: "menu", xmlid: firstMenu.xmlid }
				: undefined,
		safety: "read-only",
	});
	if (form.arch.statusbar) {
		flow.steps.push({ id: "s02", kind: "new", procedure: null, safety: "action" });
		let n = 2;
		for (const f of form.arch.fields) {
			const def = canon.fields.find((cf) => cf.name === f.name);
			if (!def?.required) continue;
			n += 1;
			flow.steps.push({
				id: `s${String(n).padStart(2, "0")}`,
				kind: def.type === "selection" ? "select" : "fill",
				procedure: null,
				field: f.name,
				value: def.selection?.[0]?.[0],
				safety: "action",
			});
		}
		// Header buttons in the order their visible states appear in the
		// statusbar; buttons with unknown states go last, in arch order.
		const stateRank = (states?: string[]): number => {
			if (!states?.length || !statusbarStates?.length) return Number.MAX_SAFE_INTEGER;
			const idx = statusbarStates.findIndex((s) => states.includes(s));
			return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
		};
		const buttons = [...form.arch.buttons]
			.filter((b) => b.type !== "object" || b.name)
			.map((b, i) => ({ b, i }))
			.sort((x, y) => stateRank(x.b.visibleStates) - stateRank(y.b.visibleStates) || x.i - y.i);
		for (const { b } of buttons) {
			n += 1;
			flow.steps.push({
				id: `s${String(n).padStart(2, "0")}`,
				kind: "click",
				procedure: null,
				field: b.name,
				note: b.confirm ? "Asks for confirmation" : undefined,
				safety: "action",
			});
		}
	}
	flow.steps.push({ id: nextStepId(flow), kind: "screenshot", procedure: null, safety: "read-only" });
	sb.flows.push(flow);
	return sb;
}

/** Every inventory the canon carries (one per covered module). */
function inventoriesOf(canon: Canon): CanonModule[] {
	return canon.modules ?? (canon.module ? [canon.module] : []);
}

/** The next free `mN` id, so several inventories never collide. */
function nextMenuIndex(sb: Storyboard): number {
	let n = 0;
	while (sb.flows.some((f) => f.id === `m${n + 1}`)) n += 1;
	return n;
}

/**
 * One `goto` + `screenshot` flow per menu an inventory owns (module scope only).
 * A menu with no action opens its own screen; one WITH an action targets the
 * action, so the flow survives a menu whose screen is reached by several menus.
 * Nothing is invented: a menu without an xml id cannot be targeted by a capture
 * and is left to MODULE-COVERAGE, which reports it instead of guessing.
 */
function planMenuFlows(inventory: CanonModule, sb: Storyboard): void {
	const already = new Set<string>();
	for (const flow of sb.flows) for (const step of flow.steps) if (step.target?.xmlid) already.add(step.target.xmlid);
	let n = nextMenuIndex(sb);
	for (const menu of inventory.menus) {
		if (!menu.xmlid) continue;
		const target: Target = menu.actionXmlid ? { kind: "action", xmlid: menu.actionXmlid } : { kind: "menu", xmlid: menu.xmlid };
		if (target.xmlid && already.has(target.xmlid)) continue;
		if (target.xmlid) already.add(target.xmlid);
		n += 1;
		sb.flows.push({
			id: `m${n}`,
			title: menu.completeName || menu.xmlid,
			kind: "menu",
			model: menu.model,
			steps: [
				{ id: "s01", kind: menu.actionXmlid ? "goto" : "menu", procedure: null, target, safety: "read-only" },
				{ id: "s02", kind: "screenshot", procedure: null, safety: "read-only" },
			],
		});
	}
}

/**
 * One `goto` + `screenshot` flow per group to walk (module scope only). The entry
 * point is the first menu that group sees — a menu it is restricted to, or an
 * unrestricted one (visible to everyone). A group with no menu evidence gets no
 * flow: GROUP-COVERAGE reports it and asks for a reason in `docs.groupsWhy`
 * instead of this function inventing a screen.
 */
function planGroupFlows(canon: Canon, sb: Storyboard): void {
	const groups = canon.interview?.groups ?? [];
	if (groups.length === 0) return;
	const menus: Array<{ xmlid: string; completeName: string; groups?: string[]; actionXmlid?: string; model?: string }> = [];
	for (const inventory of inventoriesOf(canon)) for (const menu of inventory.menus) if (menu.xmlid) menus.push({ xmlid: menu.xmlid, completeName: menu.completeName, groups: menu.groups, actionXmlid: menu.actionXmlid, model: menu.model });
	let n = 0;
	for (const group of groups) {
		const entry = menus.find((m) => m.groups?.includes(group)) ?? menus.find((m) => m.groups === undefined);
		if (!entry) continue;
		n += 1;
		const target: Target = entry.actionXmlid ? { kind: "action", xmlid: entry.actionXmlid } : { kind: "menu", xmlid: entry.xmlid };
		sb.flows.push({
			id: `g${n}`,
			title: `Walk as ${group}: ${entry.completeName}`,
			kind: "group",
			model: entry.model,
			role: group,
			steps: [
				{ id: "s01", kind: entry.actionXmlid ? "goto" : "menu", procedure: null, target, safety: "read-only" },
				{ id: "s02", kind: "screenshot", procedure: null, safety: "read-only" },
			],
		});
	}
}

/**
 * The empty prose slots the storyteller fills: one entry per model the canon
 * evidences, with every field and button already listed as UNWRITTEN (the
 * coverage rules then report exactly what is missing, and the storyteller
 * writes the "what it is for" of each item — the type is never the writer's to
 * choose, it is the canon's).
 */
function seedDocs(canon: Canon): StoryboardDocs {
	const models: Record<string, ModelDocs> = {};
	const add = (model: string, fields: string[], buttons: string[]): void => {
		if (models[model]) return;
		models[model] = {
			fields: Object.fromEntries(fields.map((f) => [f, ""])),
			buttons: Object.fromEntries(buttons.map((b) => [b, ""])),
			workflow: "",
		};
	};
	for (const inventory of inventoriesOf(canon)) {
		for (const doc of inventory.models) add(doc.model, doc.fields.map((f) => f.name), doc.buttons.map((b) => b.name).filter(Boolean));
	}
	const form = canon.views.find((v) => v.type === "form");
	add(canon.model, (form?.arch.fields ?? []).map((f) => f.name), (form?.arch.buttons ?? []).map((b) => b.name).filter(Boolean));
	return { modules: canon.interview?.modules ?? inventoriesOf(canon).map((m) => m.name), groups: canon.interview?.groups ?? [], models };
}

const PLACEHOLDER_RE = /\{\{[^}]*\}\}|<[a-z_ ]+>|\bTODO\b|\bTBD\b/i;

/**
 * Check a storyboard against its canon. The two structural rules are ERROR;
 * everything else is advisory. Every finding cites the flow/step it came from
 * and quotes the canon evidence that supports it.
 */
export function validateStoryboard(sb: Storyboard, canon: Canon | null): StoryboardFinding[] {
	const out: StoryboardFinding[] = [];
	if (canon && sb.canonFingerprint && sb.canonFingerprint !== fingerprintOf(canon)) {
		out.push({
			rule: "CANON-STALE",
			severity: "ERROR",
			message: `the storyboard was planned against a different canon (${sb.canonFingerprint.slice(0, 12)}… vs ${fingerprintOf(canon).slice(0, 12)}…): re-run operation=plan before trusting it.`,
		});
	}
	// INTERVIEW-MISSING: the canon knows who it documents; the storyboard must
	// say so before a single capture is trusted as evidence for that user.
	if (canon?.interview && (!sb.interview || sb.interview.asUser === null || sb.interview.asUser.trim() === "")) {
		out.push({
			rule: "INTERVIEW-MISSING",
			severity: "ERROR",
			message: "the storyboard does not declare who the manual documents: fill `interview` (asUser, admin, modules, groups) — the canon recorded the interview, the storyboard has not answered it.",
		});
	}
	// Module scope widens what the canon EVIDENCED: a menu/action the module
	// owns is a known target even when it belongs to another model, and a menu
	// that opens a native action makes that action known too (the reference is
	// read from ir.ui.menu.action, it is not a guess).
	const inventories = canon?.modules ?? (canon?.module ? [canon.module] : []);
	const moduleMenus = inventories.flatMap((m) => m.menus);
	const actionsXmlids = new Set([
		...(canon?.actions ?? []).map((a) => a.xmlid).filter(Boolean) as string[],
		...inventories.flatMap((m) => m.actions).map((a) => a.xmlid).filter(Boolean) as string[],
		...moduleMenus.map((m) => m.actionXmlid).filter(Boolean) as string[],
	]);
	const menusXmlids = new Set([
		...(canon?.menus ?? []).map((m) => m.xmlid).filter(Boolean) as string[],
		...moduleMenus.map((m) => m.xmlid).filter(Boolean) as string[],
	]);
	const fieldNames = new Set(canon?.fields.map((f) => f.name));
	const roleXmlids = new Set(canon?.access.groups.map((g) => g.xmlid).filter(Boolean) as string[]);
	const formButtons = new Set((canon?.views.find((v) => v.type === "form")?.arch.buttons ?? []).map((b) => b.name));
	// Methods whose source raises — evidence for the recovery rule.
	const raising = new Set<string>();
	for (const src of [canon?.errors.own, canon?.errors.community, canon?.errors.enterprise]) {
		for (const e of src?.errors ?? []) if (e.kind === "raise" && e.method) raising.add(e.method);
	}
	for (const flow of sb.flows) {
		if (flow.role && canon && roleXmlids.size > 0 && !roleXmlids.has(flow.role)) {
			const known = inventories.flatMap((m) => m.menus.flatMap((menu) => menu.groups ?? [])).includes(flow.role);
			if (!known) out.push({ rule: "ROLE-UNKNOWN", severity: "WARN", flow: flow.id, message: `role "${flow.role}" is not one of the groups the canon read for ${canon?.model ?? "this manual"}.` });
		}
		// ROLE-UNVERIFIED: one credential, so a role flow proves the screen, not
		// the role. Said out loud instead of implied.
		if (flow.role) {
			const who = canon?.interview?.connectedLogin;
			out.push({
				rule: "ROLE-UNVERIFIED",
				severity: "WARN",
				flow: flow.id,
				message: `role "${flow.role}" is declared, but captures run as the connected user${who ? ` (${who})` : ""}: the screenshot proves the screen, not that this group sees it.`,
			});
		}
		const clickMethods = flow.steps.filter((s) => s.kind === "click" && s.field);
		const hasImages = flow.steps.some((s) => s.kind === "screenshot") || (flow.captures?.length ?? 0) > 0;
		if (!hasImages) {
			out.push({ rule: "ACTS-MISSING", severity: "ERROR", flow: flow.id, message: "the flow has no screenshot step and no captures: the OCA rule is 1 sentence / 1 image, so there is nothing to render." });
		}
		for (const step of flow.steps) {
			if (step.procedure == null) {
				out.push({ rule: "TODO", severity: "WARN", flow: flow.id, step: step.id, message: `step ${step.id} (${step.kind}) has no narration yet — the storyteller writes it.` });
			} else if (PLACEHOLDER_RE.test(step.procedure)) {
				out.push({ rule: "PLACEHOLDER-UNBOUND", severity: "ERROR", flow: flow.id, step: step.id, message: `step ${step.id} still carries an unbound placeholder: "${step.procedure.slice(0, 80)}".` });
			}
			const t = step.target;
			if (t?.kind === "action" && t.xmlid && canon && !actionsXmlids.has(t.xmlid)) {
				out.push({ rule: "TARGET-UNKNOWN", severity: "ERROR", flow: flow.id, step: step.id, message: `action "${t.xmlid}" is not in the canon for ${canon.model}.` });
			}
			if (t?.kind === "menu" && t.xmlid && canon && !menusXmlids.has(t.xmlid)) {
				out.push({ rule: "TARGET-UNKNOWN", severity: "ERROR", flow: flow.id, step: step.id, message: `menu "${t.xmlid}" is not in the canon for ${canon.model}.` });
			}
			if ((step.kind === "fill" || step.kind === "select") && step.field && canon && !fieldNames.has(step.field)) {
				out.push({ rule: "TARGET-UNKNOWN", severity: "ERROR", flow: flow.id, step: step.id, message: `field "${step.field}" is not in the canon for ${canon.model}.` });
			}
			if (step.kind === "click" && step.field && canon && !formButtons.has(step.field)) {
				out.push({ rule: "TARGET-UNKNOWN", severity: "ERROR", flow: flow.id, step: step.id, message: `button "${step.field}" is not on the form the canon read.` });
			}
		}
		// RECOVERY-MISSING: ERROR when the evidence says the method raises.
		for (const step of clickMethods) {
			const method = step.field as string;
			if (flow.recovery) break;
			if (raising.has(method)) {
				out.push({ rule: "RECOVERY-MISSING", severity: "ERROR", flow: flow.id, step: step.id, message: `the canon's error catalog shows ${method}() raising — the flow needs a recovery (what the user does when it fails).` });
			} else if (formButtons.has(method)) {
				out.push({ rule: "RECOVERY-MISSING", severity: "WARN", flow: flow.id, step: step.id, message: `button ${method} calls a model method: a recovery note is expected for type=object buttons.` });
			}
		}
	}
	// MODULE-COVERAGE: with a module inventory, EVERY menu and EVERY action the
	// module owns is documentation surface, and a flow that opens it is the
	// evidence that it was documented. A navigable action can be opened by
	// goto; a server action cannot (a button triggers it), so it is WARN —
	// prose territory — instead of an ERROR nobody can fix.
	const referenced = new Set<string>();
	for (const flow of sb.flows) for (const step of flow.steps) if (step.target?.xmlid) referenced.add(step.target.xmlid);
	for (const inventory of inventories) {
		for (const menu of inventory.menus) {
			if (!menu.xmlid) continue;
			if (referenced.has(menu.xmlid) || (menu.actionXmlid !== undefined && referenced.has(menu.actionXmlid))) continue;
			out.push({
				rule: "MODULE-COVERAGE",
				severity: "ERROR",
				message: `menu "${menu.completeName}" (${menu.xmlid}) belongs to module ${inventory.name} and no flow opens it — run operation=plan, or write the flow for it.`,
			});
		}
		for (const action of inventory.actions) {
			if (!action.xmlid || referenced.has(action.xmlid)) continue;
			const navigable = NAVIGABLE_ACTIONS.has(action.kind);
			out.push({
				rule: "MODULE-COVERAGE",
				severity: navigable ? "ERROR" : "WARN",
				message: `${action.kind} "${action.name}" (${action.xmlid}${action.model ? `, ${action.model}` : ""}) belongs to module ${inventory.name} and no flow uses it${navigable ? " — a goto flow can open it" : "; it is not navigable, so document it where it is triggered (menu or button)"}.`,
			});
		}
		// FIELD / BUTTON / WORKFLOW coverage: the canon read the model field by
		// field, so the manual owes one sentence per field, one per button, and
		// the state workflow. `skip` is the documented exception, never silence.
		for (const doc of inventory.models) {
			if (doc.unreadable) {
				out.push({ rule: "MODEL-UNREADABLE", severity: "WARN", message: `model ${doc.model} of module ${inventory.name} could not be read (${doc.unreadable}): its fields stay undocumented until the read succeeds.` });
				continue;
			}
			const written = sb.docs?.models?.[doc.model];
			const skip = written?.skip ?? {};
			const missingFields = doc.fields.filter((f) => !(written?.fields?.[f.name] ?? "").trim() && !(skip[f.name] ?? "").trim());
			if (missingFields.length > 0) {
				out.push({
					rule: "FIELD-COVERAGE",
					severity: "ERROR",
					message: `${missingFields.length} of ${doc.fields.length} field(s) of ${doc.model} have no "what it is for" yet (${missingFields.slice(0, 8).map((f) => f.name).join(", ")}${missingFields.length > 8 ? ", …" : ""}) — write docs.models["${doc.model}"].fields, or list them in skip with a reason.`,
				});
			}
			const buttons = [...new Set(doc.buttons.map((b) => b.name).filter(Boolean))];
			const missingButtons = buttons.filter((b) => !(written?.buttons?.[b] ?? "").trim() && !(skip[b] ?? "").trim());
			if (missingButtons.length > 0) {
				out.push({
					rule: "BUTTON-COVERAGE",
					severity: "ERROR",
					message: `${missingButtons.length} of ${buttons.length} button(s) of ${doc.model} have no "what it does" yet (${missingButtons.slice(0, 8).join(", ")}${missingButtons.length > 8 ? ", …" : ""}) — write docs.models["${doc.model}"].buttons, or list them in skip with a reason.`,
				});
			}
			if ((doc.statusbar !== undefined || buttons.length > 0) && !(written?.workflow ?? "").trim()) {
				out.push({
					rule: "WORKFLOW-COVERAGE",
					severity: "ERROR",
					message: `model ${doc.model} has a state workflow and docs.models["${doc.model}"].workflow is empty: describe the states${doc.statusbar ? ` (${[doc.statusbar.field, ...(doc.statusbar.visibleStates ?? [])].filter(Boolean).join(" → ")})` : ""} and what moves a record between them.`,
				});
			}
		}
	}
	// GROUP-COVERAGE: every group in the walk list is documented by a flow that
	// walks it, or the exception is explained. A group nobody can impersonate is
	// still a group a reader may belong to.
	const walked = new Set(sb.flows.map((f) => f.role).filter(Boolean) as string[]);
	const groupsWhy = (sb.docs?.groupsWhy ?? "").trim();
	for (const group of canon?.interview?.groups ?? []) {
		if (walked.has(group)) continue;
		out.push({
			rule: "GROUP-COVERAGE",
			severity: groupsWhy === "" ? "ERROR" : "WARN",
			message: `group "${group}" is in the walk list and no flow documents what that group does${groupsWhy === "" ? " — plan a g* flow, or explain the exception in docs.groupsWhy" : ` — reason given: ${groupsWhy}`}.`,
		});
	}
	return out;
}

/** The same stable fingerprint the collector records (stable subset of canon). */
function fingerprintOf(canon: Canon): string {
	return canonFingerprint(canon);
}

/** `sep` re-exported for tests that build expectations portably. */
export { sep };
