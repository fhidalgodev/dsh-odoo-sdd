/**
 * manual-import.ts — Fase 4: a recorded Playwright demo becomes storyboard
 * steps, never its credentials.
 *
 * Understands the line dialect emitted by `playwright codegen` (both the
 * `@playwright/test` flavour and the plain library flavour), including
 * `getByRole/getByLabel/getByText/getByPlaceholder/locator` chains with
 * `.filter/.nth/.first/.last`, the actions `click/check/dblclick/dragTo/fill/
 * selectOption/press`, `page.goto` and `expect(...).toBeVisible()`.
 *
 * HARD RULE: a recording that touches credentials (a fill/selectOption over a
 * password-ish locator, an Authorization header, cookies/storage state) is
 * REJECTED whole — the offending line is never parsed further and its value
 * is never copied anywhere.
 */
import type { Canon } from "./manual-canon.js";
import type { Step, StepKind } from "./manual-model.js";

export interface ImportWarning {
	rule: string;
	message: string;
}

export type ImportResult =
	| { ok: true; steps: Step[]; warnings: ImportWarning[] }
	| { ok: false; error: string };

/** `fill`/`select` on anything that looks like a secret rejects the recording. */
const PASSWORDISH = /(password|passwd|pwd|secret|token|api[_-]?key|authorization)/i;

const MAX_RECORDING_CHARS = 1_000_000;

const unquote = (s: string | undefined): string =>
	s == null ? "" : s.replace(/^['"`]/, "").replace(/['"`]$/, "");

/**
 * Parse a recorded JS session into storyboard steps.
 * @param text - the recording source (no file I/O here: the tool enforces the
 *   size limit and the no-symlink rule on the path).
 * @param canon - optional canon for label → canonical-name mapping; a label
 *   with exactly one canon match maps to `field`, anything else stays
 *   generic with a WARN (the storyteller names it later).
 */
export function importRecording(text: string, canon?: Canon | null): ImportResult {
	if (text.length > MAX_RECORDING_CHARS) {
		return { ok: false, error: `recording is ${text.length} chars; the limit is ${MAX_RECORDING_CHARS} — split the demo into smaller recordings` };
	}
	// Credential gate FIRST, before any parsing: reject the whole recording.
	for (const [idx, rawLine] of text.split("\n").entries()) {
		const line = rawLine.trim();
		const cred = credentialViolation(line);
		if (cred) {
			return {
				ok: false,
				error: `recording rejected: line ${idx + 1} touches credentials (${cred}). Record the demo without the login step — a recording that carries secrets is never imported, not even partially.`,
			};
		}
	}

	const warnings: ImportWarning[] = [];
	const steps: Step[] = [];
	// A statement can span lines (codegen pretty-prints options); walk matches
	// over the whole text but keep line numbers for the warnings.
	const text_lineOf = (pos: number): number => text.slice(0, pos).split("\n").length;

	const actionRe =
		/page\.(getByRole|getByLabel|getByText|getByPlaceholder|locator)\(((?:[^()]|\([^()]*\))*?)\)((?:\.(?:filter|nth|first|last)\((?:[^()]|\([^()]*\))*?\))*)\s*\.\s*(click|check|dblclick|dragTo|fill|selectOption|press)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")?\s*[,)]/g;
	const gotoRe = /page\.goto\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
	const expectRe = /expect\(\s*page\.((?:getBy\w+|locator)\(((?:[^()]|\([^()]*\))*?)\)[^)]*)\s*\)\s*\.\s*toBeVisible\(\)/g;

	for (const m of text.matchAll(gotoRe)) {
		steps.push({ id: "", kind: "goto", procedure: null, target: { kind: "url", url: unquote(m[1]) } });
	}
	for (const m of text.matchAll(actionRe)) {
		const strategy = m[1];
		const strategyArg = m[2] ?? "";
		const chain = m[3] ?? "";
		const action = m[4];
		const value = unquote(m[5]);
		const line = text_lineOf(m.index ?? 0);
		let kind: StepKind;
		switch (action) {
			case "fill":
				kind = "fill";
				break;
			case "selectOption":
				kind = "select";
				break;
			case "press":
				kind = "press";
				break;
			case "dragTo":
				kind = "drag";
				break;
			default:
				// click / check / dblclick all reduce to "activate it"
				kind = "click";
		}
		const label = strategyArg.match(/name\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/)?.[1];
		const labelText = unquote(label) || strategyArg.replace(/^['"`]|['"`]$/g, "");
		const step: Step = { id: "", kind, procedure: null, safety: "action" };
		if (kind === "fill" || kind === "select") {
			if (PASSWORDISH.test(strategyArg + chain)) {
				return { ok: false, error: `recording rejected: line ${line} fills something that looks like a credential. Import the demo without the secret.` };
			}
			const mapped = mapField(labelText, strategy ?? "", canon);
			if (mapped) step.field = mapped;
			else warnings.push({ rule: "import-unmapped-field", message: `line ${line}: "${labelText}" has no single canon match — the storyteller must name the field` });
			step.value = value;
		} else if (kind === "click") {
			const mapped = mapButton(labelText, strategy ?? "", canon);
			if (mapped) step.field = mapped;
			else warnings.push({ rule: "import-unmapped-target", message: `line ${line}: "${labelText}" is not a canon button — left generic` });
		} else if (kind === "press") {
			step.value = value || "Enter";
		} else if (kind === "drag") {
			warnings.push({ rule: "import-drag", message: `line ${line}: dragTo becomes a planned drag step; capture does not automate drags — narrate it and screenshot the result` });
		}
		// keep the raw locator as evidence for the storyteller
		if (strategy) step.note = `${strategy}("${labelText}")${chain}`;
		steps.push(step);
	}
	for (const m of text.matchAll(expectRe)) {
		const labelText = unquote(m[2]);
		steps.push({ id: "", kind: "assert", procedure: null, value: labelText, safety: "read-only" });
	}
	if (steps.length === 0) {
		return { ok: false, error: "no page.goto / locator action / expect().toBeVisible() found — this does not look like a Playwright recording" };
	}
	// stable ids, assigned in document order
	steps.forEach((s, i) => {
		s.id = `s${String(i + 1).padStart(2, "0")}`;
	});
	return { ok: true, steps, warnings };
}

/** @returns a short reason when the line touches credentials, else null. */
function credentialViolation(line: string): string | null {
	const chain = line.match(/page\.((?:getBy\w+|locator)\([\s\S]*?\)[^.]*)\.(fill|selectOption)\s*\(/);
	if (chain && PASSWORDISH.test(chain[1])) return `${chain[2]} over a password-ish locator`;
	const val = line.match(/\.(fill|selectOption)\(\s*(['"`])([\s\S]*?)\2/);
	if (val && PASSWORDISH.test(val[3])) return `${val[1]} with a credential-looking value`;
	if (/setExtraHTTPHeaders/i.test(line) && /authorization/i.test(line)) return "an Authorization header";
	if (/(addCookies|storageState)/i.test(line)) return "cookies / storage state";
	return null;
}

/** Case-insensitive SINGLE-match mapping of a visible label to the canon. */
function mapField(label: string, strategy: string, canon?: Canon | null): string | undefined {
	if (!canon || !label || strategy === "locator") return undefined;
	const needle = label.toLowerCase();
	const hits = (canon.fields ?? []).filter((f) => (f.string ?? "").toLowerCase() === needle);
	return hits.length === 1 ? hits[0].name : undefined;
}

function mapButton(label: string, strategy: string, canon?: Canon | null): string | undefined {
	if (!canon || !label || strategy === "locator") return undefined;
	const needle = label.toLowerCase();
	// Buttons live inside the parsed form arch.
	const buttons = (canon.views ?? []).flatMap((v) => v.arch?.buttons ?? []);
	const hits = buttons.filter((b) => (b.string ?? "").toLowerCase() === needle);
	return hits.length === 1 ? hits[0].name : undefined;
}
