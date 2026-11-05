/**
 * video-model.ts — the VIDEO workspace: the script and artifacts of a
 * narrated video of an Odoo process, built on the SAME storyboard container
 * as the manuals (schema dsh-odoo-sdd/manual/1) but with a leaner contract:
 * no interview, no three acts, and NO manual is ever created here.
 *
 * Resolution rule (one, on purpose — unlike the manuals' three modes): the
 * video workspace is ALWAYS <projectRoot>/<videosDir>/<slug>, `videosDir`
 * defaulting to "docs/videos". The slug is one safe path segment and the
 * base must stay inside the project root.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isSafeSegment, isWithinRoot, readStoryboard, type Flow, type Storyboard, type StoryboardFinding } from "./manual-model.js";
import { ES_FILLER, EN_FILLER } from "./prose-lint.js";
import { computeCoverage } from "./video-coverage.js";
import type { RpcResult } from "./manual-capture.js";

const CANON_FILE = "canon.json";

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

export interface ResolveVideoWorkspaceInput {
	projectRoot: string;
	/** `videosDir` from the configuration (default "docs/videos"). */
	dir: string;
	slug: string;
}

export type VideoWorkspaceResult = { ok: true; dir: string } | { ok: false; blocked: string };

export function resolveVideoWorkspace(input: ResolveVideoWorkspaceInput): VideoWorkspaceResult {
	if (!isSafeSegment(input.slug)) {
		return { ok: false, blocked: `slug "${input.slug}" is not a safe folder segment (letters, digits, . _ - only)` };
	}
	const base = isAbsolute(input.dir) ? input.dir : resolve(input.projectRoot, input.dir);
	if (!isWithinRoot(base, input.projectRoot)) {
		return { ok: false, blocked: `videosDir "${input.dir}" resolves outside the project root — videos must live inside it` };
	}
	return { ok: true, dir: join(base, input.slug) };
}

// ---------------------------------------------------------------------------
// Validation — the VIDEO subset of the manual lint (lean on purpose)
// ---------------------------------------------------------------------------

/** The canon surface the video lint needs, read tolerantly from canon.json. */
export interface VideoCanonSurface {
	fingerprint?: string;
	model?: string;
	actionXmlids: string[];
	menuXmlids: string[];
	/**
	 * The module-wide inventory, when the canon was collected at module scope
	 * (`module` or `modules[]`). Loose shape on purpose: the file is authored
	 * by collectModuleInventory and re-read tolerantly, so a canon written by
	 * an older plugin version still parses — absent pieces just yield less
	 * coverage to demand.
	 */
	module?: {
		name?: string;
		menus?: Array<{ xmlid?: string; completeName: string; actionXmlid?: string; model?: string; groups?: string[] }>;
		actions?: Array<{ xmlid?: string; name: string; kind?: string; model?: string }>;
		models?: Array<{
			model: string;
			name?: string;
			transient?: boolean;
			fields?: Array<{ name: string }>;
			buttons?: Array<{ name?: string }>;
			pages?: Array<{ name?: string }>;
			statusbar?: unknown;
		}>;
		views?: Array<{ xmlid: string; resId?: number; name?: string; model: string; type?: string; inheritXmlid?: string; mode?: string; adds?: string[]; modifies?: string[] }>;
		crons?: Array<{ xmlid: string; resId?: number; name?: string; model?: string; active?: boolean }>;
		automations?: Array<{ xmlid: string; resId?: number; name?: string; model?: string; active?: boolean }>;
		templates?: Array<{ xmlid: string; resId?: number; name?: string; model?: string }>;
		rules?: Array<{ xmlid: string; resId?: number; name?: string; model?: string; domain?: string }>;
	};
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? (v as unknown[]).map((x) => String(x ?? "")).filter((x) => x !== "") : [];
}

function objList(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

export function readVideoCanonSurface(dir: string): VideoCanonSurface | null {
	const file = join(dir, CANON_FILE);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const actions = objList(raw["actions"]);
		const menus = objList(raw["menus"]);
		const surface: VideoCanonSurface = {
			fingerprint: typeof raw["fingerprint"] === "string" ? (raw["fingerprint"] as string) : undefined,
			model: typeof raw["model"] === "string" ? (raw["model"] as string) : undefined,
			actionXmlids: actions.map((a) => String(a["xmlid"] ?? "")).filter((x) => x !== ""),
			menuXmlids: menus.map((m) => String(m["xmlid"] ?? "")).filter((x) => x !== ""),
		};
		// Module scope: `module` is the single-module inventory, `modules[]`
		// the multi one — merged here because coverage only asks "what exists".
		const invs = objList(raw["modules"]);
		const single = raw["module"] && typeof raw["module"] === "object" ? [raw["module"] as Record<string, unknown>] : [];
		const all = [...single, ...invs];
		if (all.length > 0) {
			surface.module = {
				menus: all.flatMap((m) =>
					objList(m["menus"]).map((x) => ({
						xmlid: x["xmlid"] !== undefined ? String(x["xmlid"]) : undefined,
						completeName: String(x["completeName"] ?? x["complete_name"] ?? ""),
						actionXmlid: x["actionXmlid"] !== undefined ? String(x["actionXmlid"]) : undefined,
						model: x["model"] !== undefined ? String(x["model"]) : undefined,
						groups: strArray(x["groups"]).length > 0 ? strArray(x["groups"]) : undefined,
					})),
				),
				actions: all.flatMap((m) =>
					objList(m["actions"]).map((x) => ({
						xmlid: x["xmlid"] !== undefined ? String(x["xmlid"]) : undefined,
						name: String(x["name"] ?? ""),
						kind: x["kind"] !== undefined ? String(x["kind"]) : undefined,
						model: x["model"] !== undefined ? String(x["model"]) : undefined,
					})),
				),
				models: all.flatMap((m) =>
					objList(m["models"]).map((x) => ({
						model: String(x["model"] ?? ""),
						name: x["name"] !== undefined ? String(x["name"]) : undefined,
						transient: x["transient"] === true,
						fields: objList(x["fields"]).map((f) => ({ name: String(f["name"] ?? "") })),
						buttons: objList(x["buttons"]).map((b) => ({ name: b["name"] !== undefined ? String(b["name"]) : undefined })),
						pages: objList(x["pages"]).map((p) => ({ name: p["name"] !== undefined ? String(p["name"]) : undefined })),
						statusbar: x["statusbar"],
					})),
				),
				views: all.flatMap((m) =>
					objList(m["views"]).map((x) => ({
						xmlid: String(x["xmlid"] ?? ""),
						resId: Number.isFinite(Number(x["resId"])) ? Number(x["resId"]) : undefined,
						name: x["name"] !== undefined ? String(x["name"]) : undefined,
						model: String(x["model"] ?? ""),
						type: x["type"] !== undefined ? String(x["type"]) : undefined,
						inheritXmlid: x["inheritXmlid"] !== undefined ? String(x["inheritXmlid"]) : undefined,
						mode: x["mode"] !== undefined ? String(x["mode"]) : undefined,
						adds: strArray(x["adds"]),
						modifies: strArray(x["modifies"]),
					})),
				),
				crons: all.flatMap((m) => objList(m["crons"]).map((x) => ({ xmlid: String(x["xmlid"] ?? ""), resId: Number.isFinite(Number(x["resId"])) ? Number(x["resId"]) : undefined, name: x["name"] !== undefined ? String(x["name"]) : undefined, model: x["model"] !== undefined ? String(x["model"]) : undefined, active: x["active"] === true }))),
				automations: all.flatMap((m) => objList(m["automations"]).map((x) => ({ xmlid: String(x["xmlid"] ?? ""), resId: Number.isFinite(Number(x["resId"])) ? Number(x["resId"]) : undefined, name: x["name"] !== undefined ? String(x["name"]) : undefined, model: x["model"] !== undefined ? String(x["model"]) : undefined, active: x["active"] === true }))),
				templates: all.flatMap((m) => objList(m["templates"]).map((x) => ({ xmlid: String(x["xmlid"] ?? ""), resId: Number.isFinite(Number(x["resId"])) ? Number(x["resId"]) : undefined, name: x["name"] !== undefined ? String(x["name"]) : undefined, model: x["model"] !== undefined ? String(x["model"]) : undefined }))),
				rules: all.flatMap((m) => objList(m["rules"]).map((x) => ({ xmlid: String(x["xmlid"] ?? ""), resId: Number.isFinite(Number(x["resId"])) ? Number(x["resId"]) : undefined, name: x["name"] !== undefined ? String(x["name"]) : undefined, model: x["model"] !== undefined ? String(x["model"]) : undefined, domain: x["domain"] !== undefined ? String(x["domain"]) : undefined }))),
			};
		}
		return surface;
	} catch {
		return null;
	}
}

/**
 * The VIDEO storyboard rules. Deliberately a SUBSET of the manual lint: the
 * three acts, the interview and the coverage walls are manual contracts — a
 * video only owes a navigable script (targets the canon knows) and knows
 * which steps will stay silent (fixed dwell instead of narration).
 */
export function validateVideoStoryboard(sb: Storyboard, canon: VideoCanonSurface | null): StoryboardFinding[] {
	const findings: StoryboardFinding[] = [];
	if (canon && sb.canonFingerprint && canon.fingerprint && sb.canonFingerprint !== canon.fingerprint) {
		findings.push({
			rule: "CANON-STALE",
			severity: "ERROR",
			message: `the storyboard fingerprint ${sb.canonFingerprint.slice(0, 12)}… does not match the stored canon ${canon.fingerprint.slice(0, 12)}… — re-plan before capturing`,
		});
	}
	const known = new Set<string>([...(canon?.actionXmlids ?? []), ...(canon?.menuXmlids ?? [])]);
	// A record target may point at ANY model the module inventory knows
	// (a cron/automation/template/rule screen lives on its own model), not
	// only at the canon's primary one.
	const knownModels = new Set<string>();
	if (canon?.model) knownModels.add(canon.model);
	for (const m of canon?.module?.models ?? []) if (m.model) knownModels.add(m.model);
	for (const list of [canon?.module?.crons ?? [], canon?.module?.automations ?? [], canon?.module?.templates ?? [], canon?.module?.rules ?? []]) {
		for (const row of list) if (row.model) knownModels.add(row.model);
	}
	const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;
	const esFiller = new RegExp(ES_FILLER.source, "i");
	const enFiller = new RegExp(EN_FILLER.source, "i");
	const proseCheck = (text: string | null | undefined, flow: Flow, stepId: string | undefined, label: string): void => {
		if (!text || text.trim() === "") return;
		if (countWords(text) > 28) {
			findings.push({ rule: "SENTENCE-LONG", severity: "WARN", flow: flow.id, step: stepId, message: `${label} is ${countWords(text)} words (max 28): narration must be spoken register — split or shorten it.` });
		}
		if (esFiller.test(text) || enFiller.test(text)) {
			findings.push({ rule: "FILLER", severity: "WARN", flow: flow.id, step: stepId, message: `${label} contains a filler phrase ("as you can see", "como puedes ver", …) — rewrite in plain language.` });
		}
	};
	for (const flow of sb.flows) {
		if (flow.steps.length === 0) {
			findings.push({ rule: "FLOW-EMPTY", severity: "ERROR", flow: flow.id, message: "flow has no steps — a video needs at least one" });
			continue;
		}
		// Hook/outro are the video contract (didactic craft), not prose the
		// manual owes — missing pieces are WARN, never blockers.
		const hookText = flow.hook?.text?.trim() ?? "";
		if (hookText === "") {
			findings.push({ rule: "HOOK-MISSING", severity: "WARN", flow: flow.id, message: "no hook.text — the first seconds should say why this video matters before any step runs." });
		} else if (countWords(hookText) > 20) {
			findings.push({ rule: "HOOK-LONG", severity: "WARN", flow: flow.id, message: `hook.text is ${countWords(hookText)} words (max 20): a hook is one spoken breath.` });
		}
		proseCheck(flow.hook?.text, flow, "_hook", "hook.text");
		if (!flow.outro?.text || flow.outro.text.trim() === "") {
			findings.push({ rule: "OUTRO-MISSING", severity: "WARN", flow: flow.id, message: "no outro.text — the last frame should close and point at the next video." });
		}
		proseCheck(flow.outro?.text, flow, "_outro", "outro.text");
		for (const step of flow.steps) {
			if (step.procedure === null || step.procedure === undefined || step.procedure.trim() === "") {
				findings.push({
					rule: "SILENT-STEP",
					severity: "WARN",
					flow: flow.id,
					step: step.id,
					message: "no narration sentence (procedure is null): the video will hold this step for the fixed dwell instead of a voice line",
				});
			}
			proseCheck(step.procedure, flow, step.id, "procedure");
			const t = step.target;
			if (t && (t.kind === "action" || t.kind === "menu") && t.xmlid && known.size > 0 && !known.has(t.xmlid)) {
				findings.push({
					rule: "TARGET-UNKNOWN",
					severity: "ERROR",
					flow: flow.id,
					step: step.id,
					message: `target ${t.kind} "${t.xmlid}" is not in the canon — the capturer would navigate by guess`,
				});
			}
			if (t && t.kind === "record" && t.model && knownModels.size > 0 && !knownModels.has(t.model)) {
				findings.push({
					rule: "TARGET-UNKNOWN",
					severity: "ERROR",
					flow: flow.id,
					step: step.id,
					message: `record target model "${t.model}" is not in the canon inventory`,
				});
			}
			// A highlight names a screen element: it must exist in the canon of
			// the model the step highlights — never narrate what is not there.
			if (step.kind === "highlight" && canon?.module?.models) {
				const m = flow.model ?? canon.model ?? "";
				const doc = canon.module.models.find((x) => x.model === m);
				if (doc && step.field && ![...(doc.fields ?? []), ...(doc.buttons ?? []), ...(doc.pages ?? [])].some((x) => x.name === step.field)) {
					findings.push({
						rule: "TARGET-UNKNOWN",
						severity: "ERROR",
						flow: flow.id,
						step: step.id,
						message: `highlight "${step.field}" is not a field, button or page of ${m} in the canon`,
					});
				}
			}
		}
	}
	// Explicit coverage refs must name real inventory items.
	if (canon?.module) {
		const report = computeCoverage(sb, canon);
		const known = new Set(report.items.map((i) => i.ref));
		for (const flow of sb.flows) {
			for (const step of flow.steps) {
				for (const ref of step.covers ?? []) {
					if (!known.has(ref)) {
						findings.push({ rule: "COVERS-UNKNOWN", severity: "WARN", flow: flow.id, step: step.id, message: `covers ref "${ref}" is not in the module inventory` });
					}
				}
			}
		}
		const byType = new Map<string, string[]>();
		for (const gap of report.gaps) byType.set(gap.type, [...(byType.get(gap.type) ?? []), gap.ref]);
		for (const [type, refs] of byType) {
			findings.push({
				rule: "VIDEO-COVERAGE",
				severity: "ERROR",
				message: `${refs.length} ${type} ref(s) not covered by any narrated step: ${refs.slice(0, 8).join(", ")}${refs.length > 8 ? ` (+${refs.length - 8} more)` : ""}. Narrate the seeded steps, add covers, or declare videoSkip with a reason.`,
			});
		}
		if (report.pending.size > 0) {
			findings.push({
				rule: "VIDEO-COVERAGE",
				severity: "WARN",
				message: `${report.pending.size} ref(s) are seeded but not narrated yet — write their procedure sentences.`,
			});
		}
	}
	// A single video needs no section; a series does. The ungrouped flows are
	// filed under the storyboard slug (see numberFlows), so this is a WARN:
	// the guide still renders, just without a section a human would choose.
	if (sb.flows.length >= 2) {
		const ungrouped = sb.flows.filter((f) => (f.group ?? "").trim() === "").map((f) => f.id);
		if (ungrouped.length > 0) {
			findings.push({
				rule: "GROUP-MISSING",
				severity: "WARN",
				message:
					`${ungrouped.length} flow(s) have no group (${ungrouped.join(", ")}): they will be filed under "${sb.slug}" in the series index. ` +
					"Set flow.group to name the section each video belongs to.",
			});
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------
// from_manual — the bridge to an existing manual (copy, never move)
// ---------------------------------------------------------------------------

export interface ImportSummary {
	flows: number;
	steps: number;
	narrated: number;
	language: string | undefined;
}

/**
 * Copies canon.json + storyboard.json from an EXISTING manual workspace into
 * the video workspace. The manual is read-only here: evidence and script are
 * reused, never mutated, and no MANUAL.md/index.html is ever produced.
 */
export function importFromManual(manualDir: string, videoDir: string): RpcResult<ImportSummary> {
	const canonFile = join(manualDir, CANON_FILE);
	const boardFile = join(manualDir, "storyboard.json");
	if (!existsSync(canonFile) || !existsSync(boardFile)) {
		return {
			ok: false,
			error:
				`the manual workspace has no canon.json/storyboard.json to import — run odoo_manual canon+plan there first, ` +
				`or plan this video from the instance (model/module) instead of from_manual`,
		};
	}
	const sb = readStoryboard(manualDir);
	if (!sb) return { ok: false, error: "the manual's storyboard.json is not a dsh-odoo-sdd/manual/1 storyboard" };
	mkdirSync(videoDir, { recursive: true });
	copyFileSync(canonFile, join(videoDir, CANON_FILE));
	copyFileSync(boardFile, join(videoDir, "storyboard.json"));
	const steps = sb.flows.flatMap((f) => f.steps);
	return {
		ok: true,
		value: {
			flows: sb.flows.length,
			steps: steps.length,
			narrated: steps.filter((s) => s.procedure !== null && s.procedure !== undefined && s.procedure.trim() !== "").length,
			language: sb.language,
		},
	};
}
