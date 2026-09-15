/**
 * Documentation scanner for Odoo modules (OCA/Diátaxis conventions).
 *
 * Unlike the security scanner, most documentation rules are STRUCTURAL (a
 * fragment is absent, a version does not follow the 5-component scheme, a
 * changelog entry is missing) rather than per-line, so this module combines
 * tree-level checks with a few line-level ones (index.html, xpath comments,
 * OWL directives, docstrings).
 *
 * Source of the rules: the OCA readme fragments + Diátaxis quadrants, the Odoo
 * semantic version scheme, Google-style docstrings and Towncrier changelogs.
 *
 * Everything here is a HEURISTIC over text: no AST, no screenshot inspection,
 * and no shell. The strict linters (Ruff/pylint) and the README.rst compiler
 * (`gen-odoo-readme`) belong to the developer's toolchain and cannot be run by
 * this plugin.
 *
 * @module dsh-odoo-sdd/docs-scan
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

/** Severity of one finding; ERROR blocks `DONE` under the required policy. */
export type DocsSeverity = "ERROR" | "WARN" | "INFO";

/** One documentation finding, anchored to a file (and line when applicable). */
export interface DocsFinding {
	severity: DocsSeverity;
	rule: string;
	file: string;
	line: number;
	message: string;
	hint: string;
}

/** How the module is being changed; drives the changelog severity. */
export type ChangeMode = "create" | "bug";

/** Options for a documentation scan. */
export interface DocsScanOptions {
	/** "create" for a new module, "bug" for a change to an existing one. */
	mode?: ChangeMode;
	/** Resolved documentation language (informational). */
	language?: string;
}

/** Result of scanning a module's documentation. */
export interface DocsScanResult {
	findings: DocsFinding[];
	/** The OCA readme fragments that are present. */
	present: string[];
	/** The OCA readme fragments that are absent. */
	absent: string[];
	/** Fragments still carrying the scaffold marker (started, not finished). */
	scaffolded: string[];
	/** True when no ERROR was produced. */
	clean: boolean;
	/** True when the changelog obligation applies to this scan. */
	changelogRequired: boolean;
}

/** One OCA readme fragment mapped to its Diátaxis quadrant. */
export interface FragmentSpec {
	file: string;
	quadrant: "Tutorial" | "How-to" | "Reference" | "Explanation";
	/** ERROR for the two the OCA marks mandatory, WARN for the recommended ones. */
	severity: DocsSeverity;
	purpose: string;
}

/**
 * The OCA readme fragments. DESCRIPTION and CONTRIBUTORS are mandatory; the
 * rest are recommended and mapped here to their Diátaxis quadrant so a reader
 * can tell which audience each one serves.
 */
export const README_FRAGMENTS: readonly FragmentSpec[] = [
	{ file: "DESCRIPTION.md", quadrant: "Reference", severity: "ERROR", purpose: "what the module is and what it does" },
	{ file: "CONTRIBUTORS.md", quadrant: "Reference", severity: "ERROR", purpose: "credit list for the people involved" },
	{ file: "CONTEXT.md", quadrant: "Explanation", severity: "WARN", purpose: "why the module exists and the business need it covers" },
	{ file: "CONFIGURE.md", quadrant: "How-to", severity: "WARN", purpose: "pre-operational configuration and access rights" },
	{ file: "USAGE.md", quadrant: "How-to", severity: "WARN", purpose: "how the end user operates the feature day to day" },
	{ file: "INSTALL.md", quadrant: "How-to", severity: "WARN", purpose: "external dependencies for administrators" },
	{ file: "ROADMAP.md", quadrant: "Explanation", severity: "WARN", purpose: "known limitations and future direction" },
];

/** Towncrier fragment types produced by the OCA toolchain. */
export const CHANGELOG_TYPES: readonly string[] = [
	".feature",
	".bugfix",
	".doc",
	".removal",
	".misc",
	".security",
	".breaking",
];

/** Directory holding the changelog fragments. */
export const NEWSFRAGMENTS_DIR = join("readme", "newsfragments");

/** Odoo version scheme: <OdooMajor>.<api>.<feature>.<bugfix>.<revision>. */
const VERSION_SCHEME = /^\d+\.\d+\.\d+\.\d+\.\d+$/;

/** Placeholder markers that mean "not actually written". */
const PLACEHOLDER = /^\s*(?:<!--.*?-->\s*)?(?:todo|tbd|fixme|xxx|\.\.\.|-)?\s*$/i;

/**
 * Marker written into scaffolded skeletons. A fragment carrying it is a valid
 * starting point but NOT finished documentation, so it can never yield an
 * APPROVED documentation report.
 */
export const SCAFFOLD_MARKER = "odoo-sdd:scaffold";

const MAX_DOC_BYTES = 1024 * 1024;

/** Read a file defensively (returns null when unreadable or symlinked). */
function readTextSafe(abs: string): string | null {
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_DOC_BYTES) return null;
		return readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/** Recursively collect files under a directory (symlink-free, bounded). */
function collectFiles(dir: string, rel: string, out: Array<{ abs: string; rel: string }>, depth = 0): void {
	if (depth > 12) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === "node_modules" || name === ".git" || name === "__pycache__") continue;
		const abs = join(dir, name);
		const childRel = rel === "" ? name : `${rel}/${name}`;
		let st;
		try {
			st = lstatSync(abs);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) collectFiles(abs, childRel, out, depth + 1);
		else if (st.isFile()) out.push({ abs, rel: childRel });
	}
}

/** Extract the `version` string from a Python manifest, or null. */
export function manifestVersion(manifestText: string): string | null {
	const m = /['"]version['"]\s*:\s*["']([^"']+)["']/.exec(manifestText);
	return m === null ? null : m[1]!.trim();
}

/**
 * Whether the module has already been RELEASED, so a change is an iteration
 * rather than a first publication.
 *
 * The initial release of a module is conventionally `<Major>.1.0.0` (the
 * feature component starts at 1), so "feature > 0" would misread a brand-new
 * module as released. Anything above that baseline — a bugfix, a later feature,
 * a technical revision — is a change existing users will receive.
 */
export function isExistingRelease(manifestText: string, moduleDir: string): boolean {
	const version = manifestVersion(manifestText);
	if (version !== null) {
		const parts = version.split(".");
		const feature = Number(parts[2] ?? "1");
		const bugfix = Number(parts[3] ?? "0");
		const revision = Number(parts[4] ?? "0");
		if (Number.isFinite(bugfix) && bugfix > 0) return true;
		if (Number.isFinite(revision) && revision > 0) return true;
		if (Number.isFinite(feature) && feature > 1) return true;
	}
	return existsSync(join(moduleDir, "HISTORY.rst"));
}

/** List the changelog fragments present, if the directory exists. */
export function changelogFragments(moduleDir: string): string[] {
	const dir = join(moduleDir, NEWSFRAGMENTS_DIR);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir).filter((f) => !f.startsWith(".") && f !== "TEMPFILE.rst");
	} catch {
		return [];
	}
}

/**
 * Scan one module's documentation.
 * @param moduleDir - module root (must hold `__manifest__.py`).
 * @param options - change mode and resolved language.
 * @returns findings plus fragment presence and the changelog obligation.
 */
export function scanDocs(moduleDir: string, options: DocsScanOptions = {}): DocsScanResult {
	const mode = options.mode ?? "create";
	const findings: DocsFinding[] = [];
	const present: string[] = [];
	const absent: string[] = [];
	const scaffolded: string[] = [];

	if (!existsSync(moduleDir)) {
		findings.push({
			severity: "ERROR",
			rule: "path-not-found",
			file: moduleDir,
			line: 0,
			message: `Scan target does not exist: ${moduleDir}`,
			hint: "Pass an existing module directory (the one holding __manifest__.py).",
		});
		return { findings, present, absent, scaffolded, clean: false, changelogRequired: true };
	}

	const manifestPath = join(moduleDir, "__manifest__.py");
	const manifestText = existsSync(manifestPath) ? (readTextSafe(manifestPath) ?? "") : "";
	if (manifestText === "") {
		findings.push({
			severity: "ERROR",
			rule: "docs-manifest-missing",
			file: "__manifest__.py",
			line: 0,
			message: "__manifest__.py not found or unreadable.",
			hint: "Documentation checks need the manifest for version and summary.",
		});
	}

	// ---- readme/ fragments (Diátaxis mapping) ------------------------------
	const readmeDir = join(moduleDir, "readme");
	for (const fragment of README_FRAGMENTS) {
		const abs = join(readmeDir, fragment.file);
		const rel = `readme/${fragment.file}`;
		if (!existsSync(abs)) {
			absent.push(fragment.file);
			findings.push({
				severity: fragment.severity,
				rule: `docs-fragment-missing`,
				file: rel,
				line: 0,
				message: `Missing ${fragment.quadrant} fragment ${fragment.file} (${fragment.purpose}).`,
				hint:
					fragment.severity === "ERROR"
						? `Create ${rel}: the OCA marks this fragment mandatory. Run odoo_docs operation=scaffold to start it.`
						: `Create ${rel} (${fragment.quadrant}) or record in architecture.md why it does not apply.`,
			});
			continue;
		}
		present.push(fragment.file);
		const text = readTextSafe(abs);
		if (text === null || PLACEHOLDER.test(text)) {
			findings.push({
				severity: "ERROR",
				rule: "docs-fragment-placeholder",
				file: rel,
				line: 0,
				message: `${fragment.file} exists but has no real content (empty or placeholder).`,
				hint: `Write the ${fragment.quadrant} content: ${fragment.purpose}.`,
			});
		} else if (text.includes(SCAFFOLD_MARKER)) {
			// Scaffolding is a starting point, not documentation: report it so a
			// generated skeleton can never masquerade as finished content.
			scaffolded.push(fragment.file);
			findings.push({
				severity: "WARN",
				rule: "docs-fragment-scaffolded",
				file: rel,
				line: 0,
				message: `${fragment.file} is still the generated skeleton.`,
				hint: `Replace the scaffold with the real ${fragment.quadrant} content: ${fragment.purpose}.`,
			});
		}
	}

	// ---- semantic version scheme ------------------------------------------
	if (manifestText !== "") {
		const version = manifestVersion(manifestText);
		if (version === null) {
			findings.push({
				severity: "ERROR",
				rule: "docs-version-scheme",
				file: "__manifest__.py",
				line: 0,
				message: "The manifest declares no 'version'.",
				hint: "Use the Odoo scheme <OdooMajor>.<api>.<feature>.<bugfix>.<revision>, e.g. '19.0.1.0.0'.",
			});
		} else if (!VERSION_SCHEME.test(version)) {
			findings.push({
				severity: "ERROR",
				rule: "docs-version-scheme",
				file: "__manifest__.py",
				line: 0,
				message: `Version "${version}" does not follow the 5-component Odoo scheme.`,
				hint: "Expected <OdooMajor>.<api>.<feature>.<bugfix>.<revision>, e.g. '19.0.1.0.0'.",
			});
		}
		if (!/['"]summary['"]\s*:/.test(manifestText)) {
			findings.push({
				severity: "WARN",
				rule: "docs-manifest-summary",
				file: "__manifest__.py",
				line: 0,
				message: "The manifest declares no one-line 'summary'.",
				hint: "Add summary='<one line slogan>' — it is what the Apps list shows.",
			});
		}
	}

	// ---- changelog (mandatory for changes to existing modules) -------------
	const existing = isExistingRelease(manifestText, moduleDir);
	const changelogRequired = mode === "bug" || existing;
	const fragments = changelogFragments(moduleDir);
	if (changelogRequired && fragments.length === 0) {
		findings.push({
			severity: "ERROR",
			rule: "docs-changelog-missing",
			file: `${NEWSFRAGMENTS_DIR}/`,
			line: 0,
			message:
				mode === "bug"
					? "This is a bug fix but there is no changelog entry."
					: "This module has already been released but there is no changelog entry for the change.",
			hint:
				`Add one Towncrier fragment per change, e.g. ${NEWSFRAGMENTS_DIR}/1234.bugfix ` +
				`or 1234.feature (types: ${CHANGELOG_TYPES.join(", ")}).`,
		});
	}
	for (const fragment of fragments) {
		const ext = extname(fragment).toLowerCase();
		if (ext === ".rst" || ext === ".md") continue; // compiled/hand-written notes
		if (!CHANGELOG_TYPES.includes(ext)) {
			findings.push({
				severity: "WARN",
				rule: "docs-changelog-type",
				file: `${NEWSFRAGMENTS_DIR}/${fragment}`,
				line: 0,
				message: `Changelog fragment "${fragment}" has an unrecognized type "${ext}".`,
				hint: `Use one of: ${CHANGELOG_TYPES.join(", ")}.`,
			});
		}
	}

	// ---- static/description/index.html ------------------------------------
	const indexPath = join(moduleDir, "static", "description", "index.html");
	const indexRel = "static/description/index.html";
	if (!existsSync(indexPath)) {
		findings.push({
			severity: "WARN",
			rule: "docs-index-missing",
			file: indexRel,
			line: 0,
			message: "No static/description/index.html: the Apps page has no visual presentation.",
			hint: "Describe the value for decision makers using Odoo's CSS classes (see the documentation persona).",
		});
	} else {
		const html = readTextSafe(indexPath) ?? "";
		if (!/oe_dark/.test(html)) {
			findings.push({
				severity: "WARN",
				rule: "docs-index-dark-mode",
				file: indexRel,
				line: 0,
				message: "index.html does not handle Odoo's dark mode (no 'oe_dark' styles).",
				hint: "Add dark-mode rules alongside the light ones, as Odoo's own description pages do.",
			});
		}
		const lines = html.split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i]!;
			if (!/<img\b/i.test(line)) continue;
			// `alt` may sit on a continuation line of a multi-line tag.
			const window = lines.slice(i, Math.min(i + 4, lines.length)).join(" ");
			if (!/\balt\s*=/i.test(window)) {
				findings.push({
					severity: "WARN",
					rule: "docs-index-alt",
					file: indexRel,
					line: i + 1,
					message: "<img> without alt text.",
					hint: "Add alt=\"...\" describing the screenshot (accessibility and searchability).",
				});
			}
		}
	}

	// ---- line-level checks over views and Python models --------------------
	const files: Array<{ abs: string; rel: string }> = [];
	collectFiles(moduleDir, "", files);
	const newModels: string[] = [];
	for (const file of files) {
		const ext = extname(file.abs).toLowerCase();
		if (file.rel.startsWith("readme/") || file.rel.startsWith("static/description/")) continue;
		if (ext === ".xml") {
			const text = readTextSafe(file.abs);
			if (text === null) continue;
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				const line = lines[i]!;
				if (!/<xpath\b/i.test(line)) continue;
				// A comment on the same or the two previous lines explains WHY the
				// inherited view is altered, which is what prevents collisions on
				// migration.
				const prev = lines.slice(Math.max(0, i - 2), i).join("\n");
				if (!/<!--/.test(line) && !/<!--/.test(prev)) {
					findings.push({
						severity: "WARN",
						rule: "docs-xpath-uncommented",
						file: file.rel,
						line: i + 1,
						message: "Inherited view <xpath> without a comment explaining why it is changed.",
						hint: "Add an XML comment above the xpath stating the business reason (it prevents migration collisions).",
					});
				}
			}
			if (/<templates?\b/i.test(text) && /t-inherit|owl\s*=\s*["']1["']/.test(text) === false) continue;
			if (/<template\b/i.test(text) && !/owl\s*=\s*["']1["']/.test(text) && /owl/i.test(file.rel + text)) {
				findings.push({
					severity: "WARN",
					rule: "docs-owl-directive",
					file: file.rel,
					line: 0,
					message: "OWL template without the owl=\"1\" directive.",
					hint: 'Declare owl="1" on new OWL templates so the renderer treats them as OWL, not legacy.',
				});
			}
			continue;
		}
		if (ext !== ".py") continue;
		const text = readTextSafe(file.abs);
		if (text === null) continue;
		const lines = text.split(/\r?\n/);
		// New models declared in this module (used for the ERD expectation).
		for (const line of lines) {
			const m = /^\s*_name\s*=\s*["']([a-z0-9_.]+)["']/.exec(line);
			if (m && (file.rel.startsWith("models/") || file.rel.includes("/models/"))) newModels.push(m[1]!);
		}
		// Public model methods should carry a Google-style docstring.
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i]!;
			if (!/^\s{4}def\s+[a-z]\w*\s*\(/.test(line)) continue;
			const next = lines[i + 1] ?? "";
			if (/^\s*("""|''')/.test(next)) continue;
			findings.push({
				severity: "WARN",
				rule: "docs-docstring-google",
				file: file.rel,
				line: i + 1,
				message: "Public method without a docstring.",
				hint: 'Use Google style: a one-line imperative summary, then Args:/Returns:/Raises: as applicable.',
			});
		}
	}

	// ---- ERD for modules that declare their own models --------------------
	if (newModels.length > 0) {
		const contextText = readTextSafe(join(readmeDir, "CONTEXT.md")) ?? "";
		const hasErd = /```mermaid/i.test(contextText) && /erDiagram/i.test(contextText);
		if (!hasErd) {
			findings.push({
				severity: "WARN",
				rule: "docs-erd-missing",
				file: "readme/CONTEXT.md",
				line: 0,
				message: `The module declares ${newModels.length} new model(s) but CONTEXT.md has no Mermaid ERD.`,
				hint: "Embed a ```mermaid erDiagram``` block so the schema is versioned with the code.",
			});
		}
	}

	const order: Record<DocsSeverity, number> = { ERROR: 0, WARN: 1, INFO: 2 };
	findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
	return {
		findings,
		present,
		absent,
		scaffolded,
		clean: findings.every((f) => f.severity !== "ERROR"),
		changelogRequired,
	};
}

/** One-line summary of a scan, for tool output. */
export function summarizeDocs(result: DocsScanResult): string {
	const errors = result.findings.filter((f) => f.severity === "ERROR").length;
	const warns = result.findings.filter((f) => f.severity === "WARN").length;
	return (
		`documentation: ${errors} ERROR, ${warns} WARN. ` +
		`Fragments present: ${result.present.length}/${README_FRAGMENTS.length}` +
		(result.scaffolded.length > 0 ? `, ${result.scaffolded.length} still scaffolded` : "") +
		(result.changelogRequired ? "; a changelog entry is required." : "; no changelog required yet.")
	);
}
