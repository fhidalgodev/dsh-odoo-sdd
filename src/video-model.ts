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
import { isSafeSegment, isWithinRoot, readStoryboard, type Storyboard, type StoryboardFinding } from "./manual-model.js";
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
}

export function readVideoCanonSurface(dir: string): VideoCanonSurface | null {
	const file = join(dir, CANON_FILE);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const actions = Array.isArray(raw["actions"]) ? (raw["actions"] as Record<string, unknown>[]) : [];
		const menus = Array.isArray(raw["menus"]) ? (raw["menus"] as Record<string, unknown>[]) : [];
		return {
			fingerprint: typeof raw["fingerprint"] === "string" ? (raw["fingerprint"] as string) : undefined,
			model: typeof raw["model"] === "string" ? (raw["model"] as string) : undefined,
			actionXmlids: actions.map((a) => String(a["xmlid"] ?? "")).filter((x) => x !== ""),
			menuXmlids: menus.map((m) => String(m["xmlid"] ?? "")).filter((x) => x !== ""),
		};
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
	for (const flow of sb.flows) {
		if (flow.steps.length === 0) {
			findings.push({ rule: "FLOW-EMPTY", severity: "ERROR", flow: flow.id, message: "flow has no steps — a video needs at least one" });
			continue;
		}
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
			if (t && t.kind === "record" && canon?.model && t.model && t.model !== canon.model) {
				findings.push({
					rule: "TARGET-UNKNOWN",
					severity: "ERROR",
					flow: flow.id,
					step: step.id,
					message: `record target model "${t.model}" is not the canon model "${canon.model}"`,
				});
			}
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
