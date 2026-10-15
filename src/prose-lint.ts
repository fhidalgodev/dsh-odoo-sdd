/**
 * Advisory prose lint for the narrated manuals (Motor 2). Heuristics for the
 * AI-tell patterns in Spanish and English; ERROR is reserved for the two
 * STRUCTURAL rules the OCA format actually depends on (1 sentence / 1 image in
 * procedures, headings that interrupt a procedure). Everything else is WARN:
 * a warning never blocks a render, it tells the storyteller what to rewrite.
 */
import type { StoryboardFinding } from "./manual-model.js";

export interface ProseFinding extends StoryboardFinding {
	rule:
		| "ai-negative-parallelism"
		| "ai-filler"
		| "ai-dash-pileup"
		| "rhetorical-opening"
		| "sentence-length"
		| "readability"
		| "procedure-one-sentence"
		| "heading-in-narrative"
		| "label-not-in-canon";
	line: number;
}

interface RuleDef {
	rule: ProseFinding["rule"];
	re: RegExp;
	message: string;
	/** WARN unless the line carries a number or a canon label (test hueco vs ganado). */
	exceptData?: boolean;
}

const ES_FILLER =
	/\b(en el mundo (actual|de hoy)|cabe (destacar|señalar)|es importante (destacar|señalar|mencionar)|no cabe duda|en definitiva|sin duda alguna|en resumen,|de cara a|jugando un papel (crucial|importante)|desempeña un papel)\b/gi;
const EN_FILLER =
	/\b(it is important to note|it's worth noting|in today's (fast-paced )?world|delve|seamless(ly)?|unlock the (power|potential)|game-?changer|leverage the power|at the end of the day|needless to say)\b/gi;

const RULES: RuleDef[] = [
	{
		rule: "ai-negative-parallelism",
		re: /\bno solo\b[^.!?]{1,80}\bsino\b|\bnot just\b[^.!?]{1,80}\bbut\b|\bno se trata solo de\b[^.!?]{1,80}\bsino de\b/i,
		message: "negative parallelism (\"no solo X, sino Y\") reads as AI filler — keep it only when the sentence states a concrete gain (a number or a canon label).",
		exceptData: true,
	},
	{ rule: "ai-filler", re: ES_FILLER, message: "corporate filler / AI-tell phrase — rewrite in plain language." },
	{ rule: "ai-filler", re: EN_FILLER, message: "corporate filler / AI-tell phrase — rewrite in plain language." },
	{
		rule: "ai-dash-pileup",
		re: /(?:—|--)[^—]{1,120}(?:—|--)[^—]{1,120}(?:—|--)/,
		message: "three or more em dashes pile up in one line — restructure the sentence.",
	},
	{
		rule: "rhetorical-opening",
		re: /^\s*(¿sabías que|imagina(te)? (que|un|una)|has (pensado|notado)|picture this|have you ever|imagine a world)\b/i,
		message: "rhetorical opening — manuals state, they do not tease.",
	},
];

const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const countSyllablesEs = (w: string): number => {
	const x = w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	const groups = x.match(/[aeiou]+/g);
	return Math.max(1, groups ? groups.length : 1);
};

/**
 * Fernández-Huerta (Spanish) readability, the classic adaptation of Flesch:
 * higher = easier. The manual targets operating staff, so a score >= 70
 * (child-level simplicity) suggests the text was dumbified, not clarified.
 */
export function fernandezHuerta(text: string): number {
	const words = text.split(/\s+/).filter((w) => /[a-záéíóúüñ]/i.test(w));
	if (words.length === 0) return 100;
	const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length);
	const syllables = words.reduce((a, w) => a + countSyllablesEs(w), 0);
	return 206.84 - 0.6 * (syllables / words.length) * 100 - 1.02 * (words.length / sentences);
}

/** Flesch-Kincaid grade level (English); the "dumbify" ceiling is grade 8. */
export function fleschKincaidGrade(text: string): number {
	const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
	if (words.length === 0) return 0;
	const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length);
	const syllables = words.reduce((a, w) => {
		const groups = w.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").match(/[aeiouy]{1,2}/g);
		return a + Math.max(1, groups ? groups.length : 1);
	}, 0);
	return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

/**
 * Lint a rendered or drafted manual. `canonLabels` are the exact strings the
 * canon read (field strings, button strings, group names): bold or quoted
 * terms should match one of them (WARN only — the canon never proves style).
 */
export function lintProse(markdown: string, opts?: { language?: string; canonLabels?: string[] }): ProseFinding[] {
	const out: ProseFinding[] = [];
	const lines = markdown.split("\n");
	const language = opts?.language ?? "en";
	const labels = opts?.canonLabels ?? [];
	const labelHit = (line: string): boolean =>
		labels.some((l) => l.length > 2 && line.toLowerCase().includes(l.toLowerCase()));

	let inProcedure = false;
	let readabilityText = "";
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		// fenced code never counts as prose
		if (/^```/.test(line.trim())) inProcedure = false;
		const numbered = /^\s*\d+\.\s/.test(line);
		if (numbered) inProcedure = true;
		// structural: a heading interrupts an open procedure (no blank line before it)
		if (/^#{1,6}\s/.test(line) && /^\s*\d+\.\s/.test(lines[i - 1] ?? "")) {
			out.push({ rule: "heading-in-narrative", severity: "ERROR", line: i + 1, message: "a heading interrupts the numbered procedure — close it with a normal line (or a blank line) first." });
		}
		// structural: 1 sentence / 1 image per numbered step
		if (numbered) {
			const body = line.replace(/^\s*\d+\.\s*/, "");
			const sentences = (body.match(/[.!?]+(\s|$)/g) ?? []).length;
			const hasImage = /!\[[^\]]*\]\([^)]+\)/.test(line);
			if (sentences > 1 && !hasImage) {
				out.push({ rule: "procedure-one-sentence", severity: "ERROR", line: i + 1, message: "one numbered step must be ONE sentence (OCA: 1 sentence / 1 image) — split it." });
			}
		}
		for (const r of RULES) {
			if (!r.re.test(line)) continue;
			if (r.exceptData && (/\d/.test(line) || labelHit(line))) continue;
			out.push({ rule: r.rule, severity: "WARN", line: i + 1, message: r.message });
		}
		// label-not-in-canon: bold or quoted emphasis that the canon cannot back
		for (const m of line.matchAll(/\*\*([^*]+)\*\*|«([^»]+)»|"([^"]{3,})"/g)) {
			const term = (m[1] ?? m[2] ?? m[3] ?? "").trim();
			if (term.length < 3 || labels.length === 0) continue;
			if (!labelHit(term) && !/^\d/.test(term)) {
				out.push({ rule: "label-not-in-canon", severity: "WARN", line: i + 1, message: `"${term}" is emphasized but is not a label the canon read — check the exact string on screen.` });
			}
		}
		// sentence-length: > 25 words in one sentence of a prose line
		if (!numbered && !/^#|\||```/.test(line) && line.trim().length > 0) {
			readabilityText += line + "\n";
			for (const sentence of line.split(/(?<=[.!?])\s+/)) {
				if (countWords(sentence) > 25) {
					out.push({ rule: "sentence-length", severity: "WARN", line: i + 1, message: "a sentence runs past 25 words — split it (the reader is operating, not studying)." });
					break;
				}
			}
		}
	}
	const spanish = language.startsWith("es");
	const score = spanish ? fernandezHuerta(readabilityText) : 100 - fleschKincaidGrade(readabilityText) * 5;
	const tooSimple = spanish ? score >= 70 : fleschKincaidGrade(readabilityText) > 0 && fleschKincaidGrade(readabilityText) <= 8;
	if (readabilityText.trim().length > 200 && tooSimple) {
		// The finding is reported in English like every other rule: the lint
		// inspects Spanish prose, but its report speaks one language.
		out.push({
			rule: "readability",
			severity: "WARN",
			line: lines.length,
			message: spanish
				? `Fernández-Huerta ${score.toFixed(0)} (>= 70, Spanish text): it reads dumbified — clarify, do not infantilize.`
				: `Flesch-Kincaid grade ${fleschKincaidGrade(readabilityText).toFixed(1)} (<= 8): it reads dumbified — clarify, do not infantilize.`,
		});
	}
	return out;
}
