/**
 * Manual audit (Fase 5): the documentation verdict covers a narrated manual
 * WHEN ONE EXISTS, and stays exactly as it was when none does. This module only
 * READS: it never renders, never captures and never rewrites a storyboard.
 *
 * Two rules keep the integration honest:
 * 1. A manual is optional. No storyboard anywhere means no finding at all.
 * 2. The audit reports what the manual IS (capture coverage, staleness against
 *    the canon, prose health) — deciding whether the manual is good remains
 *    the storyteller's job, and `odoo_manual operation=lint` is the gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listManuals, readStoryboard, type ManualsMode, type Storyboard } from "./manual-model.js";
import { lintProse } from "./prose-lint.js";

/** A finding shaped exactly like the docs scanner's own (same report table). */
export interface ManualAuditFinding {
	severity: "ERROR" | "WARN";
	rule: string;
	file: string;
	line: number;
	message: string;
	hint: string;
}

/** What the audit knows about ONE manual workspace. */
export interface ManualAudit {
	slug: string;
	dir: string;
	/** Storyboard path relative to the project root (what the report cites). */
	file: string;
	flows: number;
	steps: number;
	screenshots: number;
	captures: number;
	missingCaptures: number;
	unboundProcedures: number;
	actions: number;
	/** true when a canon.json exists and the storyboard was planned elsewhere. */
	canonStale: boolean;
	canonKnown: boolean;
	proseWarnings: number;
	findings: ManualAuditFinding[];
}

/** Where the manuals of a project live, honouring the configured mode. */
export interface ManualScope {
	mode: ManualsMode;
	/** Folder under the project root when mode is `docs`. */
	dir: string;
	projectRoot: string;
	/** Base folder of the specs tree (project or central layout). */
	specsBase: string;
	moduleDir?: string;
}

const rel = (from: string, to: string): string => {
	const r = relative(from, to);
	return r === "" ? "." : r;
};

/**
 * The manual workspaces that belong to the given module/spec, in a stable
 * order. Missing folders are not an error: an absent manual is the norm.
 * @param scope - the configured manuals layout and the roots it resolves against.
 * @returns absolute workspace directories that hold a storyboard.
 */
export function findManualsFor(scope: ManualScope): string[] {
	const base =
		scope.mode === "module"
			? scope.moduleDir === undefined
				? null
				: join(scope.moduleDir, "readme", "manual")
			: scope.mode === "docs"
				? join(scope.projectRoot, scope.dir)
				: join(scope.specsBase, "manuals");
	if (base === null || !existsSync(base)) return [];
	return listManuals(base).map((m) => m.dir);
}

/** Canon labels available to the prose lint, read WITHOUT trusting the file. */
function canonLabels(dir: string): string[] {
	const file = join(dir, "canon.json");
	if (!existsSync(file)) return [];
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as {
			fields?: { string?: string }[];
			views?: { arch?: { buttons?: { string?: string }[] } }[];
		};
		const labels: string[] = [];
		for (const f of raw.fields ?? []) if (f.string) labels.push(f.string);
		for (const v of raw.views ?? []) for (const b of v.arch?.buttons ?? []) if (b.string) labels.push(b.string);
		return labels;
	} catch {
		return [];
	}
}

function canonFingerprintOf(dir: string): string | null {
	const file = join(dir, "canon.json");
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { fingerprint?: string };
		return typeof raw.fingerprint === "string" ? raw.fingerprint : null;
	} catch {
		return null;
	}
}

/**
 * Audit ONE manual workspace. Returns null when there is no storyboard: an
 * absent manual is not a documentation defect.
 * @param dir - the manual workspace directory.
 * @param opts - project root (for relative paths), language and bounds.
 * @returns the audit, or null without a storyboard.
 */
export function auditManual(
	dir: string,
	opts: { projectRoot: string; language?: string; maxFindings?: number },
): ManualAudit | null {
	const sb: Storyboard | null = readStoryboard(dir);
	if (sb === null) return null;
	const file = rel(opts.projectRoot, join(dir, "storyboard.json"));
	const findings: ManualAuditFinding[] = [];
	const max = opts.maxFindings ?? 20;

	let steps = 0;
	let screenshots = 0;
	let captures = 0;
	let actions = 0;
	let unbound = 0;
	const missing: string[] = [];
	for (const flow of sb.flows) {
		const captured = new Set((flow.captures ?? []).map((c) => c.stepId));
		for (const step of flow.steps) {
			steps += 1;
			if (step.procedure === null) unbound += 1;
			if (step.kind === "screenshot") {
				screenshots += 1;
				if (captured.has(step.id)) captures += 1;
				else missing.push(`${flow.id}/${step.id}`);
			}
			if (step.safety === "action") actions += 1;
		}
	}
	for (const id of missing.slice(0, max)) {
		findings.push({
			severity: "ERROR",
			rule: "docs-manual-missing-capture",
			file,
			line: 0,
			message: `manual ${sb.slug}: step ${id} is a screenshot with no captured image.`,
			hint: "Run odoo_manual operation=capture for that flow (from_step resumes after a failure).",
		});
	}
	if (missing.length > max) {
		findings.push({
			severity: "ERROR",
			rule: "docs-manual-missing-capture",
			file,
			line: 0,
			message: `manual ${sb.slug}: ${missing.length - max} more screenshot step(s) without an image.`,
			hint: "Run odoo_manual operation=capture and re-run this report.",
		});
	}

	const canonFp = canonFingerprintOf(dir);
	const canonStale = canonFp !== null && sb.canonFingerprint !== undefined && sb.canonFingerprint !== canonFp;
	if (canonStale) {
		findings.push({
			severity: "ERROR",
			rule: "docs-manual-canon-stale",
			file,
			line: 0,
			message: `manual ${sb.slug}: the storyboard was planned against another canon (${sb.canonFingerprint?.slice(0, 12)}… vs ${canonFp?.slice(0, 12)}…).`,
			hint: "Re-run odoo_manual operation=canon and operation=plan, then lint again.",
		});
	}
	if (unbound > 0) {
		findings.push({
			severity: "WARN",
			rule: "docs-manual-unbound-procedure",
			file,
			line: 0,
			message: `manual ${sb.slug}: ${unbound} step(s) still have procedure=null.`,
			hint: "The storyteller writes one sentence per captured step (see the odoo-user-manual skill).",
		});
	}

	let proseWarnings = 0;
	const manualMd = join(dir, "render", "MANUAL.md");
	const alternative = join(dir, "MANUAL.md");
	const proseFile = existsSync(manualMd) ? manualMd : existsSync(alternative) ? alternative : null;
	if (proseFile !== null) {
		const findingsForProse = lintProse(readFileSync(proseFile, "utf8"), {
			language: opts.language ?? "en",
			canonLabels: canonLabels(dir),
		});
		for (const f of findingsForProse.slice(0, max)) {
			if (f.severity === "ERROR") {
				findings.push({
					severity: "ERROR",
					rule: `docs-manual-${f.rule}`,
					file: rel(opts.projectRoot, proseFile),
					line: f.line ?? 0,
					message: `manual ${sb.slug}: ${f.message}`,
					hint: "Fix the procedure in the storyboard and re-render; the lint drives the rewrite.",
				});
			} else {
				proseWarnings += 1;
				findings.push({
					severity: "WARN",
					rule: `docs-manual-${f.rule}`,
					file: rel(opts.projectRoot, proseFile),
					line: f.line ?? 0,
					message: `manual ${sb.slug}: ${f.message}`,
					hint: "Advisory only: rewrite if the sentence reads like a machine wrote it.",
				});
			}
		}
	}

	return {
		slug: sb.slug,
		dir,
		file,
		flows: sb.flows.length,
		steps,
		screenshots,
		captures,
		missingCaptures: missing.length,
		unboundProcedures: unbound,
		actions,
		canonStale,
		canonKnown: canonFp !== null,
		proseWarnings,
		findings,
	};
}

/** The `## User manual` section of the docs report (empty when no manual). */
export function renderManualSection(audits: ManualAudit[]): string[] {
	if (audits.length === 0) return [];
	const lines: string[] = [];
	lines.push("## User manual");
	for (const a of audits) {
		const freshness = !a.canonKnown
			? "no canon.json beside it (plan/lint could not be re-checked here)"
			: a.canonStale
				? "CANON STALE — re-plan before trusting it"
				: "fresh against its canon";
		lines.push(
			`- ${a.slug}: ${a.flows} flow(s), ${a.steps} step(s), ${a.actions} action step(s); ` +
				`captures ${a.captures}/${a.screenshots}; ${a.unboundProcedures} procedure(s) pending; ` +
				`${a.proseWarnings} prose warning(s); ${freshness} — ${a.file}`,
		);
	}
	const errors = audits.flatMap((a) => a.findings).filter((f) => f.severity === "ERROR").length;
	lines.push(
		errors === 0
			? "- The manual adds no ERROR. Its own gate is still `odoo_manual operation=lint`."
			: `- The manual adds ${errors} ERROR: fix them before this documentation is considered done.`,
	);
	return lines;
}

/** The manual findings, ready to merge into the documentation scan findings. */
export function manualAuditFindings(audits: ManualAudit[]): ManualAuditFinding[] {
	return audits.flatMap((a) => a.findings);
}
