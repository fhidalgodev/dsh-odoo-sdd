/**
 * Ambiguity lint for spec.md: mechanical rules against the wording patterns
 * that make a requirement unverifiable.
 *
 * An unquantified adjective ("fast", "secure") is a feeling, not a requirement;
 * a passive verb with no actor hides WHO does it; an and/or compound cannot be
 * half-satisfied without lying about the other half; TBD is an open hole; a
 * vague quantifier ("some", "several") cannot be counted. Each finding carries
 * the line and a concrete suggestion (e.g. fast -> p95 < 200ms).
 *
 * This is a WARNING layer, never a gate: the lint advises the CLARIFY/READ_SPEC
 * phases, it does not block them.
 *
 * @module dsh-odoo-sdd/ambiguity-lint
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One ambiguity finding. */
export interface AmbiguityFinding {
	line: number;
	rule: string;
	message: string;
}

/** Adjective -> measurable rewrite suggestion. English and Spanish specs. */
const UNQUANTIFIED: Array<{ pattern: RegExp; suggestion: string }> = [
	{ pattern: /\b(fast|rapido|r[aá]pido)\b/i, suggestion: "quantify the bound (e.g. p95 < 200ms)" },
	{ pattern: /\b(slow|lento)\b/i, suggestion: "quantify the bound (e.g. p95 < 2s)" },
	{ pattern: /\b(secure|seguro|safe)\b/i, suggestion: "name the threat/actor it must resist (e.g. 'users outside group X cannot read field Y')" },
	{ pattern: /\b(scalable|escalable)\b/i, suggestion: "state the load target (e.g. 100 concurrent users)" },
	{ pattern: /\b(user[- ]?friendly|intuitivo|amigable)\b/i, suggestion: "name the measurable usability criterion (task completed without help in N steps)" },
];

/** Vague quantifiers that cannot be counted. */
const VAGUE_QUANTIFIER = /\b(some|several|various|many|few|algunos|varios|muchos|pocos|seg[uú]n corresponda)\b/i;

/** Passive voice with no explicit agent (English be+past-participle heuristic). */
const PASSIVE_NO_AGENT = /\b(is|are|was|were|be|been|must be|should be)\s+\w+(ed|en)\b(\s+by\b)?/i;

/** Open placeholders. */
const PLACEHOLDER = /\b(TBD|TODO|XXX|placeholder|por definir|pendiente)\b/i;

/** Compound requirement separators that allow half-satisfaction. */
const COMPOUND = /\band\/or\b/i;
/** An and-combination inside a modal requirement line (the compound risk case). */
const COMPOUND_MODAL =
	/^(?:[-*+]\s+|\d+[.)]\s+).*\b(must|shall|should|debe|deber[aá])\b.*\s(and|y|y luego)\s/i;

/**
 * Lint spec.md (or any requirement text) for ambiguity patterns.
 * @param specMd - full text of spec.md.
 * @returns findings with line numbers, in document order.
 */
export function lintAmbiguity(specMd: string): AmbiguityFinding[] {
	const findings: AmbiguityFinding[] = [];
	const lines = specMd.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Only requirement-bearing lines: headings and code fences are not
		// requirements and flagging them trains the reader to ignore the lint.
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const inFence = lines.slice(0, i).filter((l) => l.trim().startsWith("```")).length % 2 === 1;
		if (inFence) continue;
		for (const rule of UNQUANTIFIED) {
			if (rule.pattern.test(trimmed)) {
				findings.push({
					line: i + 1,
					rule: "unquantified-adjective",
					message: `"${trimmed.slice(0, 80)}": ${rule.suggestion}.`,
				});
				break; // one finding per line keeps the report readable
			}
		}
		if (PLACEHOLDER.test(trimmed)) {
			findings.push({ line: i + 1, rule: "placeholder", message: `"${trimmed.slice(0, 80)}": an open TBD is an unresolved decision, not a requirement.` });
			continue;
		}
		if (VAGUE_QUANTIFIER.test(trimmed)) {
			findings.push({ line: i + 1, rule: "vague-quantifier", message: `"${trimmed.slice(0, 80)}": count it or bound it (a number, all/none, or a list).` });
			continue;
		}
		if (PASSIVE_NO_AGENT.test(trimmed) && !/\bby\b|\bpor\b/i.test(trimmed)) {
			findings.push({ line: i + 1, rule: "passive-no-actor", message: `"${trimmed.slice(0, 80)}": say WHO performs the action.` });
			continue;
		}
		if (COMPOUND.test(trimmed) || COMPOUND_MODAL.test(trimmed)) {
			findings.push({ line: i + 1, rule: "compound-requirement", message: `"${trimmed.slice(0, 80)}": split and/or into separate requirements so each can be satisfied (and verified) on its own.` });
		}
	}
	return findings;
}

/**
 * Lint the spec.md of a spec directory.
 * @param specDir - spec directory holding spec.md.
 * @returns findings, or an empty list when spec.md is missing.
 */
export function lintSpecDir(specDir: string): AmbiguityFinding[] {
	try {
		return lintAmbiguity(readFileSync(join(specDir, "spec.md"), "utf8"));
	} catch {
		return [];
	}
}
