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
import { canonFingerprint } from "./manual-canon.js";

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

export interface Storyboard {
	schema: "dsh-odoo-sdd/manual/1";
	slug: string;
	language?: string;
	flows: Flow[];
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

import type { Canon } from "./manual-canon.js";

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
	const form = canon.views.find((v) => v.type === "form");
	const firstAction = canon.actions[0];
	const firstMenu = canon.menus[0];
	if (!form) return sb;
	const statusbarStates = form.arch.statusbar?.visibleStates;
	const flow: Flow = {
		id: "f1",
		title: canon.model,
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
	const actionsXmlids = new Set(canon?.actions.map((a) => a.xmlid).filter(Boolean) as string[]);
	const menusXmlids = new Set(canon?.menus.map((m) => m.xmlid).filter(Boolean) as string[]);
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
			out.push({ rule: "ROLE-UNKNOWN", severity: "WARN", flow: flow.id, message: `role "${flow.role}" is not one of the groups the canon read for ${canon.model}.` });
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
	return out;
}

/** The same stable fingerprint the collector records (stable subset of canon). */
function fingerprintOf(canon: Canon): string {
	return canonFingerprint(canon);
}

/** `sep` re-exported for tests that build expectations portably. */
export { sep };
