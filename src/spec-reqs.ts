/**
 * Stable requirement identities for a spec: REQ-<AREA>-NN ids, per-requirement
 * fingerprints and a committed baseline with DRIFT detection.
 *
 * The AC gate already proves that every acceptance criterion was tested, but it
 * operates on the ids the author happened to write. This module gives every
 * requirement block a STABLE id derived from its H2 section plus an ordinal, so
 * edits to unrelated parts of the spec never shuffle ids, and a requirement
 * whose text changed under an existing id becomes a visible DRIFT that forces a
 * decision (new id, or update the plan that referenced the old meaning).
 *
 * Baseline layout (one per spec directory):
 *
 *   specs/<NNN>-<slug>/req-baseline.json
 *   { "version": 1, "entries": { "REQ-AREA-01": { "fingerprint": "...", "firstSeen": "..." } } }
 *
 * @module dsh-odoo-sdd/spec-reqs
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";

/** One parsed requirement block of spec.md. */
export interface Requirement {
	/** Stable id: REQ-<AREA>-NN (AREA = slugified H2 heading, NN = ordinal in section). */
	reqId: string;
	/** Slug of the H2 section the block lives in (upper snake, ASCII). */
	area: string;
	/** 1-based ordinal of the block inside its section. */
	ordinal: number;
	/** Raw text of the block (trimmed). */
	text: string;
	/** SHA-256 of the normalized text. */
	fingerprint: string;
	/** AC ids the block declares (empty for non-criteria blocks). */
	acIds: string[];
	/** RFC 4280 modality verb, when the block carries one. */
	modality: "must" | "shall" | "should" | "may" | null;
}

/** Baseline entry: what a requirement looked like when it was first accepted. */
export interface BaselineEntry {
	fingerprint: string;
	firstSeen: string;
}

/** Parsed req-baseline.json. */
export interface ReqBaseline {
	version: 1;
	entries: Record<string, BaselineEntry>;
}

/** Result of comparing the current spec against the committed baseline. */
export interface DriftReport {
	/** Requirement ids whose text changed under an existing id (decision required). */
	drifted: string[];
	/** Requirement ids present in the baseline but gone from the spec. */
	removed: string[];
	/** Requirement ids the spec declares that the baseline never saw. */
	added: string[];
}

const MODALITY = /\b(must|shall|should|may)\b/i;
const FALLBACK_AREA = "GEN";

/**
 * Slugify one H2 heading into the AREA token of a REQ id: strip markdown
 * decoration, fold accents to ASCII (a Spanish heading still yields a plain
 * token), collapse everything non-alphanumeric to a single underscore.
 * @param heading - raw heading text without the leading `##`.
 * @returns upper-case ASCII token (e.g. `ACCEPTANCE_CRITERIA`).
 */
export function areaSlug(heading: string): string {
	const ascii = heading
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[`*_]/g, "")
		.trim();
	const slug = ascii.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
	return slug === "" ? FALLBACK_AREA : slug;
}

/**
 * Normalize requirement text for fingerprinting: collapse whitespace runs, fold
 * curly quotes and dashes, drop trailing separators. Pure formatting edits then
 * keep the fingerprint stable while any wording change moves it.
 * @param text - raw block text.
 * @returns the comparable text.
 */
function normalizeText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u2018\u2019\u201b]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether a list item is template scaffolding rather than a requirement.
 *
 * The generated spec.md ships placeholder items (`- [ ] AC1: ...`,
 * `- [ ] V: <V.0>`) that the author REPLACES with real content. Recording them
 * in the baseline would make their disappearance read as "a requirement was
 * removed", which is exactly backwards: the scaffolding is what must go.
 * @param text - raw list-item text.
 * @returns true when the item is a placeholder.
 */
function isScaffoldText(text: string): boolean {
	const body = text
		.replace(/^[-*+]\s+/, "")
		.replace(/^\[[ xX]\]\s*/, "")
		.trim();
	if (body === "") return true;
	// "AC1: ..." / "..." / "…" / "V: <V.0>"
	if (/^(?:AC[-_.]?\s*\d+[A-Za-z0-9._-]*\s*[:.)-])?\s*[.\u2026]+\s*$/.test(body)) return true;
	if (/^[A-Za-z]{1,4}\s*:\s*<[^>]*>\s*$/.test(body)) return true;
	return false;
}

/**
 * Parse spec.md into stable requirement blocks.
 *
 * A requirement block is one top-level list item under an H2 section; an AC
 * checklist line additionally exposes its AC id so callers can map AC -> parent
 * REQ. Sections without list items contribute nothing, and template
 * scaffolding is not a requirement.
 * @param specMd - full text of spec.md.
 * @returns requirements in document order.
 */
export function parseRequirements(specMd: string): Requirement[] {
	const out: Requirement[] = [];
	const counters = new Map<string, number>();
	let area = FALLBACK_AREA;
	for (const rawLine of specMd.split(/\r?\n/)) {
		const h2 = /^##\s+(.*)$/.exec(rawLine);
		if (h2 !== null) {
			area = areaSlug(h2[1]);
			continue;
		}
		// Top-level list items only: indented children belong to their parent.
		if (!/^(?:[-*+]\s+|\d+[.)]\s+)/.test(rawLine)) continue;
		if (isScaffoldText(rawLine)) continue;
		const ordinalNext = (counters.get(area) ?? 0) + 1;
		counters.set(area, ordinalNext);
		const acIds: string[] = [];
		for (const token of rawLine.match(/AC[-_.]?\s*\d+[A-Za-z0-9._-]*/gi) ?? []) {
			const id = token.replace(/[\s`*_]/g, "").toUpperCase().replace(/^AC[-_.]?/, "AC");
			if (!acIds.includes(id)) acIds.push(id);
		}
		const text = rawLine.trim();
		const m = MODALITY.exec(text);
		out.push({
			reqId: `REQ-${area}-${String(ordinalNext).padStart(2, "0")}`,
			area,
			ordinal: ordinalNext,
			text,
			fingerprint: createHash("sha256").update(normalizeText(text), "utf8").digest("hex"),
			acIds,
			modality: m === null ? null : (m[1].toLowerCase() as Requirement["modality"]),
		});
	}
	return out;
}

/**
 * Path of the baseline file inside a spec directory.
 * @param specDir - spec directory.
 */
export function baselinePath(specDir: string): string {
	return join(specDir, "req-baseline.json");
}

/**
 * Read the committed baseline.
 * @param specDir - spec directory.
 * @returns the baseline, or null when missing OR corrupt (the caller regenerates).
 */
export function readBaseline(specDir: string): ReqBaseline | null {
	let raw: string;
	try {
		raw = readFileSync(baselinePath(specDir), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as ReqBaseline;
		if (parsed === null || typeof parsed !== "object" || typeof parsed.entries !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Persist the baseline for the requirements the spec declares NOW.
 * @param specDir - spec directory.
 * @param reqs - parsed requirements.
 * @param previous - entries to carry over (firstSeen is preserved for known ids).
 */
export function writeBaseline(specDir: string, reqs: Requirement[], previous: ReqBaseline | null = null): ReqBaseline {
	const entries: Record<string, BaselineEntry> = {};
	const now = new Date().toISOString();
	for (const r of reqs) {
		entries[r.reqId] = {
			fingerprint: r.fingerprint,
			firstSeen: previous?.entries[r.reqId]?.firstSeen ?? now,
		};
	}
	const baseline: ReqBaseline = { version: 1, entries };
	writeFileAtomic(baselinePath(specDir), JSON.stringify(baseline, null, "\t") + "\n");
	return baseline;
}

/**
 * Compare the current spec requirements against the committed baseline.
 *
 * DRIFT is the decision-forcing case: the same id carries different text, so
 * either the change is intentional (update the baseline and the plan/tests that
 * referenced the old meaning) or the requirement is new work (give it a new id).
 * @param specDir - spec directory holding spec.md and req-baseline.json.
 * @param reqs - pre-parsed requirements (parsed from spec.md when omitted).
 * @returns the drift report; every list is empty when spec and baseline agree.
 */
export function driftReport(specDir: string, reqs?: Requirement[]): DriftReport {
	const baseline = readBaseline(specDir);
	if (baseline === null) return { drifted: [], removed: [], added: [] };
	let current = reqs;
	if (current === undefined) {
		try {
			current = parseRequirements(readFileSync(join(specDir, "spec.md"), "utf8"));
		} catch {
			return { drifted: [], removed: [], added: [] };
		}
	}
	const drifted: string[] = [];
	const added: string[] = [];
	const seen = new Set<string>();
	for (const r of current) {
		seen.add(r.reqId);
		const entry = baseline.entries[r.reqId];
		if (entry === undefined) added.push(r.reqId);
		else if (entry.fingerprint !== r.fingerprint) drifted.push(r.reqId);
	}
	const removed = Object.keys(baseline.entries).filter((id) => !seen.has(id));
	return { drifted, removed, added };
}

/**
 * Gate hook for phase transitions: create the baseline lazily on first sight
 * (old specs migrate), REFUSE to advance while any requirement drifted or was
 * removed, and otherwise fold newly written requirements into the baseline (so
 * the next reword of one of them is caught).
 * @param specDir - spec directory.
 * @returns null when the spec may advance, or the blocking reason.
 */
export function driftGate(specDir: string): string | null {
	let text: string;
	try {
		text = readFileSync(join(specDir, "spec.md"), "utf8");
	} catch {
		return null; // spec.md existence is already gated elsewhere
	}
	const reqs = parseRequirements(text);
	const baseline = readBaseline(specDir);
	if (baseline === null) {
		writeBaseline(specDir, reqs);
		return null;
	}
	const report = driftReport(specDir, reqs);
	if (report.drifted.length > 0 || report.removed.length > 0) {
		const parts: string[] = [];
		if (report.drifted.length > 0) {
			parts.push(
				`DRIFT: ${report.drifted.join(", ")} changed text under an existing requirement id. ` +
					"Decide: revert the wording, or accept it consciously by re-running the baseline refresh " +
					"and updating the tests/plan that referenced the old meaning.",
			);
		}
		if (report.removed.length > 0) {
			parts.push(`REMOVED: ${report.removed.join(", ")} disappeared from spec.md — a requirement cannot silently vanish.`);
		}
		return parts.join(" ");
	}
	// Additions are the normal way a spec grows BEFORE its content is frozen, so
	// they are accepted here and recorded now: without this, a later reword of a
	// requirement that never entered the baseline would read as "added" forever
	// and DRIFT could never fire for it.
	if (report.added.length > 0) writeBaseline(specDir, reqs, baseline);
	return null;
}

/**
 * Explicitly accept the current spec as the new baseline (the decision DRIFT asks for).
 * @param specDir - spec directory.
 * @returns the refreshed baseline.
 */
export function refreshBaseline(specDir: string): ReqBaseline {
	const text = existsSync(join(specDir, "spec.md")) ? readFileSync(join(specDir, "spec.md"), "utf8") : "";
	return writeBaseline(specDir, parseRequirements(text), readBaseline(specDir));
}
