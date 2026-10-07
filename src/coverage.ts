/**
 * Bidirectional requirement coverage between a spec and the module that
 * implements it.
 *
 * Direction 1 — spec → code: every requirement annotated with `REQ-<AREA>-NN`
 * in comments/docstrings of the module is "implemented"; one without any
 * annotation is not (or nobody proved it was).
 *
 * Direction 2 — code → spec: an annotation whose id no longer exists in the
 * requirement baseline is ORPHANED: it documents a requirement the spec no
 * longer declares, which is either a typo or a spec gone stale.
 *
 * Coverage floors by modality (RFC 4280 verbs): must/shall are mandatory —
 * 1.0 coverage blocks (ERROR); should targets 0.8 and is reported (WARN); may
 * is informational only. A gate that is waived twice stops being read, so the
 * mandatory floor is deliberately narrow: it only fails on what is truly
 * blocking.
 *
 * Status ladder per requirement:
 *   covered      — annotated in code AND its AC row carries an explicit pass
 *   untested     — neither the code annotation nor a passing AC row (blocks)
 *   test-only    — a passing AC row exists but no code annotation
 *   unimplemented — annotated in code but no passing AC row
 *
 * @module dsh-odoo-sdd/coverage
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseRequirements, readBaseline, type Requirement } from "./spec-reqs.js";

/** Status of one requirement in the ladder. */
export type ReqStatus = "covered" | "untested" | "test-only" | "unimplemented";

/** One requirement's coverage result. */
export interface CoverageRow {
	reqId: string;
	modality: Requirement["modality"];
	status: ReqStatus;
	annotatedFiles: string[];
}

/** Full coverage report of a module against a spec. */
export interface CoverageReport {
	rows: CoverageRow[];
	/** Annotation ids the spec does not declare (typos or stale spec). */
	orphans: string[];
	/** Mandatory (must/shall) coverage ratio, 0..1. */
	mandatoryRatio: number;
	/** Whether the mandatory floor (1.0, no orphans) holds. */
	ok: boolean;
	/** Human-readable summary, one line per fact. */
	summary: string[];
}

const REQ_ID = /REQ-[A-Z0-9_]+-\d{1,4}/g;
const SKIP_DIRS = new Set(["node_modules", "static", "i18n", "lib", ".git"]);

/**
 * REQ annotations of one requirement, split by where they live.
 *
 * Code and tests are both evidence, but they are NOT the same evidence: an
 * annotation in `tests/` says the behaviour is exercised, not that the module
 * implements it. Keeping them apart is what lets the ladder report `test-only`
 * instead of inventing either "implemented" or "missing".
 */
export interface ReqAnnotations {
	/** Files (relative) that annotate the id outside tests/. */
	code: string[];
	/** Files (relative) under tests/ that annotate the id. */
	test: string[];
}

/** Whether a module-relative path lives under a tests/ (or test/) directory. */
function isTestPath(rel: string): boolean {
	const segments = rel.split("/");
	return segments.slice(0, -1).some((segment) => segment === "tests" || segment === "test");
}
const CODE_EXT = new Set([".py", ".js", ".ts", ".jsx", ".tsx", ".xml"]);

/**
 * Extract the REQ ids a line mentions, but only when the mention sits in a
 * comment: Python `#`, JS/TS `//` and `/* *\/`, XML `<!-- -->`, or inside a
 * triple-quoted block (treated as a docstring). A REQ id inside executable
 * code or a plain string is NOT an annotation — it would let any string count
 * as coverage.
 * @param line - one source line.
 * @param inDocstring - whether the line is inside a triple-quoted block.
 * @returns the REQ ids the line annotates.
 */
function reqIdsInLine(line: string, inDocstring: boolean): string[] {
	const found: string[] = [];
	if (inDocstring) {
		for (const m of line.matchAll(REQ_ID)) found.push(m[0]);
		return found;
	}
	// Line comments: only what follows the marker counts.
	const hashAt = line.indexOf("#");
	if (hashAt !== -1) {
		for (const m of line.slice(hashAt).matchAll(REQ_ID)) found.push(m[0]);
	}
	const slashAt = line.indexOf("//");
	if (slashAt !== -1) {
		for (const m of line.slice(slashAt).matchAll(REQ_ID)) found.push(m[0]);
	}
	const blockAt = line.indexOf("/*");
	if (blockAt !== -1) {
		for (const m of line.slice(blockAt).matchAll(REQ_ID)) found.push(m[0]);
	}
	const xmlAt = line.indexOf("<!--");
	if (xmlAt !== -1) {
		for (const m of line.slice(xmlAt).matchAll(REQ_ID)) found.push(m[0]);
	}
	return found;
}

/**
 * Walk the module and collect every REQ annotation, split by code vs tests.
 * @param moduleDir - module directory (the one holding __manifest__.py).
 * @returns REQ id -> its annotations.
 */
export function scanAnnotations(moduleDir: string): Map<string, ReqAnnotations> {
	const annotations = new Map<string, ReqAnnotations>();
	/** Depth-first walk skipping vendored/generated directories. */
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(entry)) walk(full);
				continue;
			}
			const ext = entry.slice(entry.lastIndexOf("."));
			if (!CODE_EXT.has(ext)) continue;
			let text: string;
			try {
				text = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			let inDocstring = false;
			for (const line of text.split(/\r?\n/)) {
				// Docstring boundaries: enter/leave on triple quotes (rarely more
				// than one toggle per line; a same-line close is handled by the exit
				// check on the NEXT line seeing no opener).
				const quotes = (line.match(/"""/g) ?? []).length;
				const ids = reqIdsInLine(line, inDocstring || (quotes > 0 && quotes % 2 === 1 && line.trimStart().startsWith('"""')));
				if (quotes % 2 === 1) inDocstring = !inDocstring;
				for (const id of ids) {
					const rel = relative(moduleDir, full).split("\\").join("/");
					const entry = annotations.get(id) ?? { code: [], test: [] };
					const list = isTestPath(rel) ? entry.test : entry.code;
					if (!list.includes(rel)) list.push(rel);
					annotations.set(id, entry);
				}
			}
		}
	};
	walk(moduleDir);
	return annotations;
}

/**
 * Read the AC ids that carry an explicit `pass` in test-plan.md.
 * @param specDir - spec directory holding test-plan.md.
 * @returns the passing normalized AC ids (empty when no plan).
 */
export function passingAcIds(specDir: string): Set<string> {
	const out = new Set<string>();
	let text: string;
	try {
		text = readFileSync(join(specDir, "test-plan.md"), "utf8");
	} catch {
		return out;
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const cols = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cols.length < 4 || /^[-: ]+$/.test(cols[0]) || /^ac$/i.test(cols[0])) continue;
		const status = cols[3].replace(/[`*]/g, "").trim().toLowerCase();
		if (/^(pass|passed)(\s*\(.*\))?$/.test(status)) {
			out.add(cols[0].replace(/[`*_\s]/g, "").toUpperCase().replace(/^AC[-_.]?/, "AC"));
		}
	}
	return out;
}

/**
 * Compute the bidirectional coverage of a module against a spec.
 * @param moduleDir - module directory.
 * @param specDir - spec directory (spec.md + test-plan.md + req-baseline.json).
 * @returns the coverage report with modality floors applied.
 */
export function coverageReport(moduleDir: string, specDir: string): CoverageReport {
	const specPath = join(specDir, "spec.md");
	const reqs: Requirement[] = existsSync(specPath) ? parseRequirements(readFileSync(specPath, "utf8")) : [];
	const annotations = scanAnnotations(moduleDir);
	const passing = passingAcIds(specDir);
	const rows: CoverageRow[] = [];
	const summary: string[] = [];
	let testOnlyAnnotations = 0;
	for (const r of reqs) {
		const entry = annotations.get(r.reqId) ?? { code: [], test: [] };
		const annotatedFiles = [...entry.code, ...entry.test];
		const inCode = entry.code.length > 0;
		const inTest = entry.test.length > 0;
		const passed = r.acIds.length > 0 && r.acIds.every((ac) => passing.has(ac));
		let status: ReqStatus;
		if (inCode && passed) status = "covered";
		else if (passed && !inCode) {
			// Passing, and either annotated in tests/ or not annotated at all:
			// evidence exists, but nothing in the module points at the
			// requirement — the state the code annotations are for.
			status = "test-only";
			if (inTest) testOnlyAnnotations += 1;
		} else if (inCode || inTest) status = "unimplemented";
		else status = "untested";
		rows.push({ reqId: r.reqId, modality: r.modality, status, annotatedFiles });
	}
	const declared = new Set(reqs.map((r) => r.reqId));
	const orphans = [...annotations.keys()].filter((id) => !declared.has(id)).sort();
	const mandatory = rows.filter((r) => r.modality === "must" || r.modality === "shall");
	const mandatoryCovered = mandatory.filter((r) => r.status === "covered").length;
	const mandatoryRatio = mandatory.length === 0 ? 1 : mandatoryCovered / mandatory.length;
	const shouldRows = rows.filter((r) => r.modality === "should");
	const shouldCovered = shouldRows.filter((r) => r.status === "covered").length;
	const ok = mandatoryRatio === 1 && orphans.length === 0;
	for (const r of rows) {
		if (r.status === "covered") continue;
		summary.push(`${r.reqId} [${r.modality ?? "unspecified"}]: ${r.status}`);
	}
	if (mandatory.length > 0) {
		summary.push(`Mandatory (must/shall) coverage: ${mandatoryCovered}/${mandatory.length} = ${mandatoryRatio.toFixed(2)} (floor 1.00).`);
	}
	if (shouldRows.length > 0) {
		summary.push(`Should coverage: ${shouldCovered}/${shouldRows.length} (floor 0.80, reported only).`);
	}
	if (orphans.length > 0) {
		summary.push(`ORPHANED annotations (not declared by the spec): ${orphans.join(", ")}.`);
	}
	if (testOnlyAnnotations > 0) {
		summary.push(
			`${testOnlyAnnotations} requirement(s) are annotated ONLY in tests/: the behaviour is exercised but no line of the ` +
				"module points at the requirement — add the reference where the code implements it, or accept test-only.",
		);
	}
	const baseline = readBaseline(specDir);
	if (baseline === null && reqs.length > 0) {
		summary.push("NOTE: no req-baseline.json — requirement ids are parsed fresh; run sdd_phase advance once to commit the baseline.");
	}
	return { rows, orphans, mandatoryRatio, ok, summary };
}
