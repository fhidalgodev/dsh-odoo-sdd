/**
 * Project convention resolution for documentation.
 *
 * The plugin defaults to ENGLISH documentation, and only changes when the human
 * says otherwise — either per call, through plugin configuration, or because the
 * project itself declares it in its own rules file.
 *
 * Two cautions shape this module:
 *   1. A project file can mention several languages in one page (e.g. "code in
 *      English, docs in Spanish"). We therefore only look at lines that talk
 *      about DOCUMENTATION, and ignore generic language lines.
 *   2. This is a heuristic over prose, not a parser. When it cannot tell, it
 *      returns nothing and the caller keeps the previous layer (or the default)
 *      instead of guessing.
 *
 * @module dsh-odoo-sdd/project-conventions
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Files inspected for a documentation-language directive, in priority order. */
const RULE_FILES = ["AGENTS.md", join(".windsurf", "rules", "odoo-conventions.md"), "CONTRIBUTING.md"];

/** Words that mean a language, mapped to the code to report. */
const LANGUAGE_WORDS: ReadonlyArray<{ re: RegExp; code: string; label: string }> = [
	{ re: /\bespa[ñn]ol\b|\bspanish\b/i, code: "es", label: "Spanish" },
	{ re: /\bingl[eé]s\b|\benglish\b/i, code: "en", label: "English" },
	{ re: /\bportugu[eé]s\b|\bportuguese\b/i, code: "pt", label: "Portuguese" },
	{ re: /\bfranc[eé]s\b|\bfrench\b/i, code: "fr", label: "French" },
	{ re: /\balem[aá]n\b|\bgerman\b/i, code: "de", label: "German" },
	{ re: /\bitaliano\b|\bitalian\b/i, code: "it", label: "Italian" },
];

/**
 * Lines only count when they talk about documentation. Matching a generic
 * "Idioma: ..." line would pick up the CODE language, which is the opposite of
 * what we want to resolve.
 */
const DOC_TOPIC = /\bdocumentaci[oó]n\b|\bdocumentation\b|readme\.rst|readme\.md|index\.html|\bdocs?\b/i;

/** What the project files declare about documentation language. */
export interface ProjectConventions {
	/** Language code declared for documentation, or null when nothing was found. */
	language: string | null;
	/** Human label of the declared language, for reporting. */
	label: string | null;
	/** Project file that declared it (relative path), when found. */
	source: string | null;
}

/** Read a rules file defensively (symlink-free, bounded). */
function readRuleFile(abs: string): string | null {
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink() || !st.isFile() || st.size > 512 * 1024) return null;
		return readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/**
 * Look for a documentation-language directive in the project's own rules files.
 * @param projectRoot - directory holding the project rules (usually the repo root).
 * @returns the declared language, or nulls when nothing conclusive was found.
 */
export function readProjectConventions(projectRoot: string): ProjectConventions {
	const none: ProjectConventions = { language: null, label: null, source: null };
	for (const rel of RULE_FILES) {
		const text = readRuleFile(join(projectRoot, rel));
		if (text === null) continue;
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.replace(/\*\*/g, ""); // markdown emphasis
			if (!DOC_TOPIC.test(line)) continue;
			for (const lang of LANGUAGE_WORDS) {
				if (lang.re.test(line)) return { language: lang.code, label: lang.label, source: rel };
			}
		}
	}
	return none;
}

/** Where a resolved language came from. */
export type LanguageSource = "parameter" | "project-file" | "configuration" | "default";

/** The resolved documentation language plus its provenance. */
export interface ResolvedLanguage {
	/** ISO-ish code to record in the docs decision. */
	language: string;
	/** Human label when known. */
	label: string;
	/** Which layer decided it. */
	source: LanguageSource;
	/** Project file that decided it, when applicable. */
	sourceFile?: string;
}

/**
 * Resolve the documentation language.
 *
 * Order (highest first): explicit parameter → the project's own rules file →
 * plugin configuration → the built-in default (`en`). The project file outranks
 * the plugin configuration because it is a standing instruction for that
 * repository, while the configuration is a generic default.
 * @param options - explicit value, project root and configured value.
 * @returns the language and the layer that decided it.
 */
export function resolveDocsLanguage(options: {
	explicit?: string | undefined;
	projectRoot?: string | undefined;
	configured?: string | undefined;
}): ResolvedLanguage {
	const explicit = (options.explicit ?? "").trim();
	if (explicit !== "") return { language: explicit, label: explicit, source: "parameter" };

	if (options.projectRoot !== undefined && options.projectRoot !== "") {
		const declared = readProjectConventions(options.projectRoot);
		if (declared.language !== null) {
			return {
				language: declared.language,
				label: declared.label ?? declared.language,
				source: "project-file",
				...(declared.source !== null ? { sourceFile: declared.source } : {}),
			};
		}
	}

	const configured = (options.configured ?? "").trim();
	if (configured !== "" && configured.toLowerCase() !== "en") {
		return { language: configured, label: configured, source: "configuration" };
	}

	return { language: "en", label: "English", source: "default" };
}
