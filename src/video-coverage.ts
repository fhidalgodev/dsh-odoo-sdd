/**
 * video-coverage.ts — the "nothing left out" contract of a video series.
 *
 * A module-scoped canon knows EVERYTHING the module owns (menus, actions,
 * views, fields, buttons, pages, crons, automations, templates, rules,
 * wizards, workflows). This module turns that inventory into a flat list of
 * refs, computes which ones the storyboard's NARRATED steps cover (a step
 * nobody narrates is seeded work, not coverage), which ones are deliberately
 * skipped (`videoSkip`, always with a reason), and which are still gaps.
 *
 * The seeding half closes the loop: for every gap it drafts a read-only
 * `highlight` step — `procedure: null` on purpose, so the SILENT-STEP lint
 * (and the pending bucket here) names exactly what the storyteller still
 * owes. Coverage is satisfied by construction; prose is the human part.
 */

import type { Flow, Step, Storyboard } from "./manual-model.js";
import type { VideoCanonSurface } from "./video-model.js";
import { nextStepId } from "./manual-model.js";

export type CoverageType = "menu" | "action" | "view" | "field" | "button" | "page" | "cron" | "automation" | "template" | "rule" | "wizard" | "workflow";

export interface CoverageItem {
	ref: string;
	type: CoverageType;
	label: string;
	xmlid?: string;
	model?: string;
	resId?: number;
}

export interface CoverageReport {
	items: CoverageItem[];
	covered: Set<string>;
	skipped: Record<string, string>;
	gaps: CoverageItem[];
	byType: Record<CoverageType, { total: number; covered: number }>;
	/** Refs reached by a step that is NOT narrated yet (seeded, pending prose). */
	pending: Set<string>;
}

// ---------------------------------------------------------------------------
// buildInventory — canon surface → flat ref list
// ---------------------------------------------------------------------------

/**
 * The refs a module-scoped canon demands. Items without an xml id cannot be
 * referenced at all, so they never enter (the lint already reports unnamed
 * menus/actions elsewhere). A per-model canon carries no inventory and
 * yields an empty list — coverage simply does not apply there.
 */
export function buildInventory(surface: VideoCanonSurface): CoverageItem[] {
	const items: CoverageItem[] = [];
	const module = surface.module;
	if (!module) return items;
	for (const m of module.menus ?? []) {
		if (m.xmlid) items.push({ ref: `menu:${m.xmlid}`, type: "menu", label: m.completeName || m.xmlid, xmlid: m.xmlid });
	}
	for (const a of module.actions ?? []) {
		if (a.xmlid) items.push({ ref: `action:${a.xmlid}`, type: "action", label: a.name || a.xmlid, xmlid: a.xmlid });
	}
	for (const v of module.views ?? []) {
		items.push({ ref: `view:${v.xmlid}`, type: "view", label: `${v.name || v.xmlid} (${v.type || "view"})`, xmlid: v.xmlid, model: v.model, resId: v.resId });
	}
	for (const model of module.models ?? []) {
		for (const f of model.fields ?? []) {
			items.push({ ref: `field:${model.model}.${f.name}`, type: "field", label: `${model.model}.${f.name}`, model: model.model });
		}
		for (const b of model.buttons ?? []) {
			if (b.name) items.push({ ref: `button:${model.model}.${b.name}`, type: "button", label: `${model.model}.${b.name}`, model: model.model });
		}
		for (const p of model.pages ?? []) {
			if (p.name) items.push({ ref: `page:${model.model}.${p.name}`, type: "page", label: `${model.model}.${p.name}`, model: model.model });
		}
		if (model.transient) items.push({ ref: `wizard:${model.model}`, type: "wizard", label: model.model, model: model.model });
		if (model.statusbar || (model.buttons?.length ?? 0) > 0) items.push({ ref: `workflow:${model.model}`, type: "workflow", label: model.model, model: model.model });
	}
	for (const c of module.crons ?? []) items.push({ ref: `cron:${c.xmlid}`, type: "cron", label: c.name || c.xmlid, xmlid: c.xmlid, model: c.model, resId: c.resId });
	for (const a of module.automations ?? []) items.push({ ref: `automation:${a.xmlid}`, type: "automation", label: a.name || a.xmlid, xmlid: a.xmlid, model: a.model, resId: a.resId });
	for (const t of module.templates ?? []) items.push({ ref: `template:${t.xmlid}`, type: "template", label: t.name || t.xmlid, xmlid: t.xmlid, model: t.model, resId: t.resId });
	for (const r of module.rules ?? []) items.push({ ref: `rule:${r.xmlid}`, type: "rule", label: r.name || r.xmlid, xmlid: r.xmlid, model: r.model, resId: r.resId });
	return items;
}

// ---------------------------------------------------------------------------
// computeCoverage — what the narrated script already reaches
// ---------------------------------------------------------------------------

const narrated = (s: Step): boolean => (s.procedure ?? "").trim() !== "";

/**
 * The refs ONE step reaches on its own (before the `covers` list), resolved
 * against the model the flow lives on. `m` is the flow's model or the canon's
 * primary one; a `field` name that is not a field but IS a known button or
 * page of the model resolves to that kind instead — the writer says "the
 * Validate tab" and the inventory decides what it is.
 */
function stepRefs(step: Step, flow: Flow, surface: VideoCanonSurface): string[] {
	const out: string[] = [];
	const t = step.target;
	if (t?.xmlid && (t.kind === "action" || t.kind === "menu")) out.push(`${t.kind}:${t.xmlid}`);
	const m = flow.model ?? surface.model ?? "";
	const field = step.field ?? "";
	if (field !== "" && m !== "") {
		const model = surface.module?.models?.find((x) => x.model === m);
		if (step.kind === "click" || step.kind === "fill" || step.kind === "select" || step.kind === "highlight") {
			const isField = model?.fields?.some((f) => f.name === field) ?? false;
			const isButton = model?.buttons?.some((b) => b.name === field) ?? false;
			const isPage = model?.pages?.some((p) => p.name === field) ?? false;
			if (step.kind === "click") {
				if (isButton) out.push(`button:${m}.${field}`);
				else if (isPage) out.push(`page:${m}.${field}`);
				else out.push(`button:${m}.${field}`);
			} else {
				if (isButton && !isField) out.push(`button:${m}.${field}`);
				else if (isPage && !isField) out.push(`page:${m}.${field}`);
				else out.push(`field:${m}.${field}`);
			}
		}
	}
	for (const ref of step.covers ?? []) out.push(ref);
	return out;
}

/**
 * Compute the coverage matrix. A ref is `covered` only when a NARRATED step
 * reaches it; a seeded-but-silent step marks `pending`; a `videoSkip` entry
 * with a non-empty reason is `skipped` (a decision, never a gap).
 */
export function computeCoverage(sb: Storyboard, surface: VideoCanonSurface): CoverageReport {
	const items = buildInventory(surface);
	const byRef = new Map(items.map((i) => [i.ref, i]));
	const covered = new Set<string>();
	const pending = new Set<string>();
	const skipped: Record<string, string> = {};
	for (const [ref, reason] of Object.entries(sb.videoSkip ?? {})) {
		if (byRef.has(ref) && reason.trim() !== "") skipped[ref] = reason.trim();
	}

	// Per-step refs, split by whether the step is narrated.
	const pendingSteps: Array<{ step: Step; flow: Flow }> = [];
	const clicksByModel = new Map<string, number>();
	const narratedFlowsByModel = new Map<string, number>();
	for (const flow of sb.flows) {
		const m = flow.model ?? surface.model ?? "";
		for (const step of flow.steps) {
			const refs = stepRefs(step, flow, surface);
			if (narrated(step)) {
				for (const ref of refs) covered.add(ref);
				if (step.kind === "click" && m !== "") clicksByModel.set(m, (clicksByModel.get(m) ?? 0) + 1);
				if (m !== "") narratedFlowsByModel.set(m, (narratedFlowsByModel.get(m) ?? 0) + 1);
			} else if (refs.length > 0) {
				pendingSteps.push({ step, flow });
			}
		}
	}
	for (const { step, flow } of pendingSteps) {
		for (const ref of stepRefs(step, flow, surface)) if (!covered.has(ref)) pending.add(ref);
	}

	// Derived coverage: a menu is covered when its action is (and vice versa),
	// a view when any of its adds/modifies is covered, a wizard when its model
	// is walked by a narrated flow, a workflow when a narrated click fires a
	// button of the model.
	const menuToAction = new Map<string, string>();
	const actionToMenu = new Map<string, string[]>();
	for (const m of surface.module?.menus ?? []) {
		if (!m.xmlid || !m.actionXmlid) continue;
		menuToAction.set(`menu:${m.xmlid}`, `action:${m.actionXmlid}`);
		const list = actionToMenu.get(`action:${m.actionXmlid}`) ?? [];
		list.push(`menu:${m.xmlid}`);
		actionToMenu.set(`action:${m.actionXmlid}`, list);
	}
	for (const [menu, action] of menuToAction) {
		if (covered.has(menu)) covered.add(action);
		if (covered.has(action)) covered.add(menu);
	}
	for (const [action, menus] of actionToMenu) if (covered.has(action)) for (const m of menus) covered.add(m);
	for (const v of surface.module?.views ?? []) {
		const ref = `view:${v.xmlid}`;
		if (covered.has(ref)) continue;
		const names = [...(v.adds ?? []), ...(v.modifies ?? [])];
		const hit = names.some((n) => covered.has(`field:${v.model}.${n}`) || covered.has(`button:${v.model}.${n}`) || covered.has(`page:${v.model}.${n}`));
		if (hit) covered.add(ref);
	}
	for (const item of items) {
		if (covered.has(item.ref)) continue;
		if (item.type === "wizard" && item.model && (narratedFlowsByModel.get(item.model) ?? 0) > 0) covered.add(item.ref);
		if (item.type === "workflow" && item.model && (clicksByModel.get(item.model) ?? 0) > 0) covered.add(item.ref);
	}

	const gaps = items.filter((i) => !covered.has(i.ref) && !pending.has(i.ref) && skipped[i.ref] === undefined);
	const byType = {} as CoverageReport["byType"];
	for (const type of ["menu", "action", "view", "field", "button", "page", "cron", "automation", "template", "rule", "wizard", "workflow"] as CoverageType[]) {
		const ofType = items.filter((i) => i.type === type);
		byType[type] = { total: ofType.length, covered: ofType.filter((i) => covered.has(i.ref) || skipped[i.ref] !== undefined).length };
	}
	return { items, covered, skipped, gaps, byType, pending };
}

// ---------------------------------------------------------------------------
// formatCoverage — the audit printout
// ---------------------------------------------------------------------------

/** One short line per non-empty type, then the gap list grouped by type. */
export function formatCoverage(report: CoverageReport): string[] {
	const lines: string[] = [];
	for (const [type, t] of Object.entries(report.byType)) {
		if (t.total === 0) continue;
		lines.push(`${type}: ${t.covered}/${t.total}`);
	}
	const total = report.items.length;
	const resolved = report.items.filter((i) => report.covered.has(i.ref) || report.skipped[i.ref] !== undefined).length;
	lines.push(`total: ${resolved}/${total}${report.pending.size > 0 ? ` (${report.pending.size} pending narration)` : ""}`);
	if (Object.keys(report.skipped).length > 0) {
		lines.push("skipped (declared):");
		for (const [ref, reason] of Object.entries(report.skipped)) lines.push(`  - ${ref}: ${reason}`);
	}
	if (report.pending.size > 0) {
		lines.push("pending narration (seeded, still silent):");
		for (const ref of [...report.pending].sort()) lines.push(`  - ${ref}`);
	}
	if (report.gaps.length > 0) {
		lines.push("gaps:");
		for (const item of report.gaps) lines.push(`  - ${item.ref} — ${item.label}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// seedCoverageFlows — draft the missing videos
// ---------------------------------------------------------------------------

const SEED_GROUP_AUTOMATION = "Automatizaciones y reglas";
const SEED_GROUP_WIZARDS = "Asistentes";
const MAX_SEED_STEPS = 15;

/**
 * Next free `v<N>` id — seeded flows carry the v prefix so a human can tell
 * drafted coverage from authored flows at a glance (and an f-id flow is
 * never touched).
 */
function nextSeedId(sb: Storyboard): string {
	let n = 1;
	while (sb.flows.some((f) => f.id === `v${n}`)) n += 1;
	return `v${n}`;
}

/**
 * Draft flows for every gap the seed can express: one flow per view (its adds
 * AND modifies as highlight steps), one per automations/rules model group,
 * one per wizard. Narration stays `procedure: null` — the storyteller writes
 * the sentence; the refs are already `covers` so coverage is structural.
 * Idempotent and create-only: existing flows and their ids are never touched.
 * @returns how many steps were seeded (0 = nothing to do).
 */
export function seedCoverageFlows(sb: Storyboard, surface: VideoCanonSurface): number {
	const report = computeCoverage(sb, surface);
	if (report.gaps.length === 0) return 0;
	const module = surface.module;
	if (!module) return 0;

	// Refs already reached by ANY step (narrated or pending) are not re-seeded.
	const claimed = new Set<string>([...report.covered, ...report.pending]);
	const gapRefs = new Set(report.gaps.filter((g) => !claimed.has(g.ref)).map((g) => g.ref));
	if (gapRefs.size === 0) return 0;

	const actionByModel = new Map<string, string>();
	for (const a of module.actions ?? []) {
		if (a.xmlid && a.model && !actionByModel.has(a.model)) actionByModel.set(a.model, a.xmlid);
	}
	const menuByModel = new Map<string, string>();
	for (const m of module.menus ?? []) {
		if (m.xmlid && m.model && !menuByModel.has(m.model)) menuByModel.set(m.model, m.xmlid);
	}
	const modelDoc = (m: string | undefined) => module.models?.find((x) => x.model === m);

	let seeded = 0;
	const pushFlow = (flow: Flow): void => {
		sb.flows.push(flow);
	};
	const highlightStep = (flow: Flow, field: string, covers: string[]): Step => ({
		id: nextStepId(flow),
		kind: "highlight",
		procedure: null,
		field,
		covers,
		safety: "read-only",
	});
	const navTarget = (model: string | undefined, resId?: number): Step["target"] | undefined => {
		if (model && actionByModel.has(model)) return { kind: "action", xmlid: actionByModel.get(model) };
		if (model && menuByModel.has(model)) return { kind: "menu", xmlid: menuByModel.get(model) };
		if (model && resId !== undefined) return { kind: "record", model, recordId: resId };
		return undefined;
	};

	// One flow per gap view: every add/modify becomes a highlight step.
	for (const v of module.views ?? []) {
		const ref = `view:${v.xmlid}`;
		if (!gapRefs.has(ref)) continue;
		const names = [...(v.adds ?? []), ...(v.modifies ?? [])].filter((n) => gapRefs.has(`field:${v.model}.${n}`) || gapRefs.has(`button:${v.model}.${n}`) || gapRefs.has(`page:${v.model}.${n}`));
		const covers = [ref, ...names.flatMap((n) => [`field:${v.model}.${n}`, `button:${v.model}.${n}`, `page:${v.model}.${n}`]).filter((r) => gapRefs.has(r))];
		const flow: Flow = { id: "", title: `${v.name || v.xmlid}`, kind: "model", model: v.model || undefined, group: v.model || undefined, steps: [] };
		flow.id = nextSeedId(sb);
		const target = navTarget(v.model || undefined);
		if (target) flow.steps.push({ id: "s01", kind: "goto", procedure: null, target, safety: "read-only" });
		for (const n of names) flow.steps.push(highlightStep(flow, n, [ref]));
		if (flow.steps.length === 0) flow.steps.push({ id: "s01", kind: "highlight", procedure: null, field: names[0] ?? "", covers, safety: "read-only" });
		else flow.steps[flow.steps.length - 1].covers = [...(flow.steps[flow.steps.length - 1].covers ?? []), ...covers.filter((c) => !flow.steps.some((s) => (s.covers ?? []).includes(c)))];
		pushFlow(flow);
		seeded += 1;
	}

	// Automations / rules / crons / templates: one flow per model bucket.
	const buckets = new Map<string, CoverageItem[]>();
	for (const item of report.gaps) {
		if (!["cron", "automation", "template", "rule"].includes(item.type) || !gapRefs.has(item.ref)) continue;
		const key = item.model ?? "(sin modelo)";
		buckets.set(key, [...(buckets.get(key) ?? []), item]);
	}
	for (const [model, items] of [...buckets.entries()].sort()) {
		const group = SEED_GROUP_AUTOMATION;
		// Split into chunks so one flow never dwarfs the rest.
		for (let i = 0; i < items.length; i += MAX_SEED_STEPS) {
			const chunk = items.slice(i, i + MAX_SEED_STEPS);
			const flow: Flow = {
				id: nextSeedId(sb),
				title: `${SEED_GROUP_AUTOMATION}: ${model}${items.length > MAX_SEED_STEPS ? ` (${Math.floor(i / MAX_SEED_STEPS) + 1})` : ""}`,
				kind: "model",
				model: model !== "(sin modelo)" ? model : undefined,
				group,
				steps: [],
			};
			const target = navTarget(model !== "(sin modelo)" ? model : undefined, chunk[0]?.resId);
			if (target) flow.steps.push({ id: "s01", kind: "goto", procedure: null, target, safety: "read-only" });
			for (const item of chunk) {
				const step = highlightStep(flow, item.label.split(".").pop() ?? item.ref, [item.ref]);
				flow.steps.push(step);
			}
			pushFlow(flow);
			seeded += 1;
		}
	}

	// Wizards: one flow each (the flow.model link alone satisfies the ref once narrated).
	for (const item of report.gaps.filter((g) => g.type === "wizard" && gapRefs.has(g.ref))) {
		const doc = modelDoc(item.model);
		const flow: Flow = {
			id: nextSeedId(sb),
			title: `Asistente ${item.model}`,
			kind: "model",
			model: item.model,
			group: SEED_GROUP_WIZARDS,
			steps: [],
		};
		const target = navTarget(item.model);
		if (target) flow.steps.push({ id: "s01", kind: "goto", procedure: null, target, safety: "read-only" });
		for (const f of (doc?.fields ?? []).slice(0, MAX_SEED_STEPS)) flow.steps.push(highlightStep(flow, f.name, [item.ref]));
		if (flow.steps.length === 0) flow.steps.push({ id: "s01", kind: "highlight", procedure: null, covers: [item.ref], safety: "read-only" });
		pushFlow(flow);
		seeded += 1;
	}

	// Remaining gaps the seed cannot express (menus, actions, plain fields):
	// one read-only flow per leftover, grouped under the module name.
	const leftovers = report.gaps.filter((g) => gapRefs.has(g.ref));
	if (leftovers.length > 0) {
		for (let i = 0; i < leftovers.length; i += MAX_SEED_STEPS) {
			const chunk = leftovers.slice(i, i + MAX_SEED_STEPS);
			const flow: Flow = {
				id: nextSeedId(sb),
				title: `Cobertura: ${chunk[0]?.label ?? module.name}`,
				kind: "model",
				model: chunk[0]?.model ?? surface.model,
				group: module.name,
				steps: [],
			};
			const target = navTarget(flow.model, chunk[0]?.resId);
			if (target) flow.steps.push({ id: "s01", kind: "goto", procedure: null, target, safety: "read-only" });
			for (const item of chunk) flow.steps.push(highlightStep(flow, item.label.split(".").pop() ?? item.ref, [item.ref]));
			pushFlow(flow);
			seeded += 1;
		}
	}
	return seeded;
}
