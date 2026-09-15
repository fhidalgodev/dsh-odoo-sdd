/**
 * `odoo_docs` — the documentation tool of dsh-odoo-sdd.
 *
 * It is deliberately USABLE ON ITS OWN: documenting an existing module should
 * not require going through the SDD pipeline (a spec, a phase, a checkpoint or
 * even a connected instance). Everything here works from a `module_dir` alone.
 *
 * Operations:
 *   - check    : scan the module's documentation and report ERROR/WARN
 *   - plan     : map the module to Diátaxis and list what is missing
 *   - scaffold : create the missing OCA fragments and index.html skeleton
 *                (create-only: an existing file is never overwritten)
 *   - report   : persist the documentation record (optionally into a spec)
 *
 * What it CANNOT do, on purpose and honestly: compile `README.rst`
 * (`gen-odoo-readme`), run `towncrier`, or run Ruff/pylint. The plugin has no
 * shell; the fragments are the source of truth and the compilation is the
 * developer's step, recorded in the report.
 *
 * @module dsh-odoo-sdd/docs-tool
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveModuleDir } from "./paths.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	README_FRAGMENTS,
	SCAFFOLD_MARKER,
	NEWSFRAGMENTS_DIR,
	CHANGELOG_TYPES,
	manifestVersion,
	scanDocs,
	summarizeDocs,
	type ChangeMode,
	type DocsFinding,
	type DocsScanResult,
} from "./docs-scan.js";
import { resolveDocsLanguage, type ResolvedLanguage } from "./project-conventions.js";

/** Live dependencies provided by the registrant. */
export interface DocsToolDeps {
	/**
	 * Project root of the CALLING SESSION, used to resolve a relative
	 * `module_dir` and to read the project's own documentation rules.
	 */
	projectRoot(exec?: unknown): string;
	/**
	 * Absolute spec directory for an id, honouring the configured layout
	 * (inside the project, or inside the central specs folder).
	 */
	specDir(specId: string, exec?: unknown): string;
	/** Documentation language from the plugin configuration (may be empty). */
	configuredLanguage(): string;
	/** Path masking helper for display. */
	display(pathValue: string): string;
}

/** Default language the plugin assumes until something says otherwise. */
const DEFAULT_LANGUAGE = "en";

/** Minimal headings written into a scaffolded fragment, per Diátaxis quadrant. */
function scaffoldBody(file: string, quadrant: string, language: string): string {
	const marker = `<!-- ${SCAFFOLD_MARKER}: replace this skeleton with real content -->`;
	const heading = file.replace(/\.md$/, "");
	if (language === "es") {
		return `${marker}\n# ${heading}\n\n<!-- ${quadrant}. Escribí el contenido real; borrá este marcador al terminar. -->\n\n`;
	}
	return `${marker}\n# ${heading}\n\n<!-- ${quadrant}. Write the real content and remove this marker when done. -->\n\n`;
}

/** Skeleton for the Apps page, honest about being a starting point. */
function scaffoldIndexHtml(moduleName: string, language: string): string {
	const title = language === "es" ? "Descripción" : "Description";
	return [
		`<!-- ${SCAFFOLD_MARKER} -->`,
		'<section class="oe_container">',
		'  <div class="row oe_spaced">',
		'    <div class="col-12">',
		`      <h2 class="oe_slogan">${moduleName}</h2>`,
		'      <h3 class="oe_slogan">' + title + "</h3>",
		"    </div>",
		"  </div>",
		"</section>",
		'<section class="oe_container oe_dark">',
		'  <div class="row oe_spaced">',
		'    <div class="col-12">',
		'      <p class="oe_mt32"><!-- Lead with the business value for decision makers. --></p>',
		"    </div>",
		"  </div>",
		"</section>",
		"",
	].join("\n");
}

/**
 * Register the `odoo_docs` tool.
 * @param ctx - registrant context exposing the tool registry.
 * @param deps - live configuration lookups.
 */
export function registerDocsTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: DocsToolDeps,
): void {
	ctx.tools.register(defineTool({
		name: "odoo_docs",
		description:
			"Documentation for an Odoo module, usable ON ITS OWN (no spec, phase, checkpoint or " +
			"connected instance required), so an existing module can simply be documented. " +
			"operation=check scans the OCA readme fragments (Diátaxis), the manifest version scheme, " +
			"static/description/index.html, docstrings, xpath comments, OWL directives and the " +
			"changelog, returning ERROR/WARN with file:line. operation=plan maps what is missing to " +
			"Diátaxis and resolves the documentation language. operation=scaffold creates the missing " +
			"fragments and the index.html skeleton (create-only, never overwrites). operation=report " +
			"persists the record (into specs/<id>/docs-report.md when spec_id is given) with a verdict " +
			"that is APPROVED only when there is no ERROR and no fragment is still a skeleton. " +
			"The plugin cannot run gen-odoo-readme/towncrier/Ruff (no shell): compiling README.rst is " +
			"the developer's step and is recorded, not performed.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["check", "plan", "scaffold", "report"],
				description: "What to do.",
			},
			module_dir: {
				type: "string",
				required: true,
				description: "Module directory (the one holding __manifest__.py).",
			},
			mode: {
				type: "string",
				enum: ["create", "bug"],
				description: "create (new module) or bug (change to an existing one). A bug makes the changelog entry mandatory.",
			},
			language: {
				type: "string",
				description: "Explicit documentation language (overrides project files and configuration). Defaults to en.",
			},
			spec_id: {
				type: "string",
				description: "operation=report only: write into specs/<spec_id>/docs-report.md instead of returning the text.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					operation: { type: "string", required: true },
					findings: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					summary: { type: "string", required: true },
					artifacts: { type: "array", required: true, items: { type: "string" } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { detail: string }).detail }],
		},
		async execute(args: {
			operation: "check" | "plan" | "scaffold" | "report";
			module_dir: string;
			mode?: ChangeMode;
			language?: string;
			spec_id?: string;
		}, exec?: unknown) {
			const projectRoot = deps.projectRoot(exec);
			const moduleDir = resolveModuleDir(args.module_dir, projectRoot);
			const moduleName = basename(moduleDir);
			const mode: ChangeMode = args.mode === "bug" ? "bug" : "create";
			const resolved: ResolvedLanguage = resolveDocsLanguage({
				explicit: args.language,
				projectRoot,
				configured: deps.configuredLanguage(),
			});
			const language = resolved.language === "" ? DEFAULT_LANGUAGE : resolved.language;
			const artifacts: string[] = [];

			const provenance =
				resolved.source === "project-file"
					? `from ${resolved.sourceFile}`
					: resolved.source === "parameter"
						? "from the explicit parameter"
						: resolved.source === "configuration"
							? "from the plugin configuration"
							: "default (English until something says otherwise)";

			// Reporting the resolved paths is what keeps the model from guessing
			// which project (and which folder) the run actually touched.
			const location = `Resolved module_dir: ${deps.display(moduleDir)}\nProject root: ${deps.display(projectRoot)}`;

			// ---- check -------------------------------------------------------
			if (args.operation === "check") {
				const scan = scanDocs(moduleDir, { mode, language });
				return {
					ok: scan.clean,
					operation: "check" as string,
					findings: jsonFindings(scan.findings),
					summary: summarizeDocs(scan),
					artifacts,
					detail:
						formatFindings(scan, `Documentation check — ${moduleName} (mode=${mode}, language=${language} ${provenance})`, deps) +
						`\n\n${location}`,
				};
			}

			// ---- plan --------------------------------------------------------
			if (args.operation === "plan") {
				const scan = scanDocs(moduleDir, { mode, language });
				const lines: string[] = [];
				lines.push(`Documentation plan — ${moduleName}`);
				lines.push(`Language: ${language} (${provenance}). Mode: ${mode}.`);
				lines.push(location.replace("\n", " — "));
				lines.push("");
				lines.push("Diátaxis coverage (OCA readme fragments):");
				for (const fragment of README_FRAGMENTS) {
					const state = scan.present.includes(fragment.file)
						? scan.scaffolded.includes(fragment.file)
							? "SCAFFOLD ONLY"
							: "present"
						: "MISSING";
					lines.push(`  - ${fragment.file} [${fragment.quadrant}] — ${state}: ${fragment.purpose}`);
				}
				lines.push("");
				lines.push(`Changelog: ${scan.changelogRequired ? "an entry is REQUIRED for this change" : "not required yet (initial release)"}.`);
				lines.push(`  Fragments live in ${NEWSFRAGMENTS_DIR}/<issue>.<type> with type in: ${CHANGELOG_TYPES.join(", ")}.`);
				lines.push("");
				lines.push("Not runnable by this plugin (no shell): gen-odoo-readme, towncrier, Ruff/pylint.");
				lines.push("The fragments are the source of truth; compiling README.rst is your step.");
				lines.push("");
				lines.push(summarizeDocs(scan));
				return {
					ok: scan.clean,
					operation: "plan" as string,
					findings: jsonFindings(scan.findings),
					summary: summarizeDocs(scan),
					artifacts,
					detail: lines.join("\n"),
				};
			}

			// ---- scaffold ----------------------------------------------------
			if (args.operation === "scaffold") {
				if (!existsSync(join(moduleDir, "__manifest__.py"))) {
					return {
						ok: false,
						operation: "scaffold" as string,
						findings: [],
						summary: "not a module directory",
						artifacts,
						detail: `${moduleDir} has no __manifest__.py — refusing to write documentation into a non-module directory.\n\n${location}`,
					};
				}
				const created: string[] = [];
				const kept: string[] = [];
				for (const fragment of README_FRAGMENTS) {
					const abs = join(moduleDir, "readme", fragment.file);
					if (existsSync(abs)) {
						kept.push(`readme/${fragment.file}`);
						continue;
					}
					mkdirSync(join(moduleDir, "readme"), { recursive: true });
					writeFileSync(abs, scaffoldBody(fragment.file, fragment.quadrant, language), { mode: 0o644 });
					created.push(`readme/${fragment.file}`);
					artifacts.push(`readme/${fragment.file}`);
				}
				const indexPath = join(moduleDir, "static", "description", "index.html");
				if (!existsSync(indexPath)) {
					mkdirSync(join(moduleDir, "static", "description"), { recursive: true });
					writeFileSync(indexPath, scaffoldIndexHtml(moduleName, language), { mode: 0o644 });
					created.push("static/description/index.html");
					artifacts.push("static/description/index.html");
				} else {
					kept.push("static/description/index.html");
				}
				// The changelog directory is created but NOT filled: writing a
				// changelog entry requires knowing what changed for whom.
				const newsDir = join(moduleDir, NEWSFRAGMENTS_DIR);
				if (!existsSync(newsDir)) {
					mkdirSync(newsDir, { recursive: true });
					created.push(`${NEWSFRAGMENTS_DIR}/`);
					artifacts.push(`${NEWSFRAGMENTS_DIR}/`);
				}
				const scan = scanDocs(moduleDir, { mode, language });
				return {
					ok: true,
					operation: "scaffold" as string,
					findings: jsonFindings(scan.findings),
					summary: summarizeDocs(scan),
					artifacts,
					detail:
						`Scaffolded ${created.length} path(s) in ${moduleName} (language=${language} ${provenance}):\n` +
						(created.length > 0 ? created.map((c) => `  + ${c}`).join("\n") : "  (nothing new to create)") +
						(kept.length > 0 ? `\nLeft untouched (already present):\n${kept.map((k) => `  = ${k}`).join("\n")}` : "") +
						"\n\nEvery generated fragment carries a scaffold marker: it is a STARTING POINT, not documentation. " +
						"Replace the content and remove the marker. Write each changelog entry yourself " +
						`(${NEWSFRAGMENTS_DIR}/<issue>.<type>) — only you know what changed and for whom.\n\n` +
						summarizeDocs(scan) +
						`\n\n${location}`,
				};
			}

			// ---- report ------------------------------------------------------
			const scan: DocsScanResult = scanDocs(moduleDir, { mode, language });
			const errors = scan.findings.filter((f) => f.severity === "ERROR").length;
			const warns = scan.findings.filter((f) => f.severity === "WARN").length;
			// APPROVED requires real content: a scaffolded fragment is not a pass.
			const verdict = errors === 0 && scan.scaffolded.length === 0 ? "APPROVED" : "NEEDS_CONTENT";
			const body: string[] = [];
			body.push(`# Documentation report — ${moduleName}`);
			body.push("");
			body.push(`Verdict: ${verdict}`);
			body.push("");
			body.push(`- Language: ${language} (${provenance})`);
			body.push(`- Change mode: ${mode}`);
			body.push(`- Module directory: ${moduleDir}`);
			body.push(`- Project root: ${projectRoot}`);
			body.push(`- Manifest version: ${manifestVersion(readManifest(moduleDir) ?? "") ?? "(none)"}`);
			body.push(`- Fragments present: ${scan.present.length}/${README_FRAGMENTS.length}${scan.scaffolded.length > 0 ? ` (${scan.scaffolded.length} still scaffolded)` : ""}`);
			body.push(`- Changelog entry required: ${scan.changelogRequired ? "yes" : "no"}`);
			body.push(`- Findings: ${errors} ERROR, ${warns} WARN`);
			body.push("");
			body.push("## Findings");
			if (scan.findings.length === 0) body.push("- (none)");
			for (const f of scan.findings) {
				body.push(`- [${f.severity}] ${f.rule} — ${f.file}${f.line > 0 ? `:${f.line}` : ""}: ${f.message}`);
				body.push(`  - fix: ${f.hint}`);
			}
			body.push("");
			body.push("## Not verifiable by this plugin");
			body.push("- README.rst compilation (`gen-odoo-readme`), Towncrier rendering and Ruff/pylint are your toolchain steps.");
			body.push("- Screenshot rules (zoom 110-125%, ALT text, one instruction per image) are a human checklist.");
			const text = body.join("\n");

			if (args.spec_id === undefined || args.spec_id.trim() === "") {
				return {
					ok: verdict === "APPROVED",
					operation: "report" as string,
					findings: jsonFindings(scan.findings),
					summary: `${summarizeDocs(scan)} Verdict: ${verdict}.`,
					artifacts,
					detail: `${text}\n\nNo spec_id given: the report was returned but NOT written. Pass spec_id to persist it at specs/<id>/docs-report.md.`,
				};
			}
			const specDir = deps.specDir(args.spec_id.trim(), exec);
			if (!existsSync(specDir)) {
				return {
					ok: false,
					operation: "report" as string,
					findings: jsonFindings(scan.findings),
					summary: "spec not found",
					artifacts,
					detail: `${deps.display(specDir)} does not exist — run sdd_phase operation=init first, or omit spec_id.`,
				};
			}
			const file = join(specDir, "docs-report.md");
			writeFileSync(file, text + "\n", { mode: 0o600 });
			artifacts.push("docs-report.md");
			return {
				ok: verdict === "APPROVED",
				operation: "report" as string,
				findings: jsonFindings(scan.findings),
				summary: `${summarizeDocs(scan)} Verdict: ${verdict}.`,
				artifacts,
				detail: `Documentation report written to ${deps.display(file)} with verdict ${verdict}.\n\n${text}`,
			};
		},
	}));
}

/** Project findings onto the JSON-safe shape the host output schema declares. */
function jsonFindings(findings: DocsFinding[]): Array<Record<string, string | number>> {
	return findings.map((f) => ({
		severity: f.severity,
		rule: f.rule,
		file: f.file,
		line: f.line,
		message: f.message,
		hint: f.hint,
	}));
}

/** Read the manifest defensively. */
function readManifest(moduleDir: string): string | null {
	try {
		return readFileSync(join(moduleDir, "__manifest__.py"), "utf8");
	} catch {
		return null;
	}
}

/** Render a scan as actionable text. */
function formatFindings(scan: DocsScanResult, title: string, deps: DocsToolDeps): string {
	const lines: string[] = [];
	lines.push(title);
	lines.push("");
	if (scan.findings.length === 0) {
		lines.push("No findings: the module documentation meets the checked conventions.");
	} else {
		for (const f of scan.findings) {
			lines.push(`[${f.severity}] ${f.rule} — ${deps.display(f.file)}${f.line > 0 ? `:${f.line}` : ""}`);
			lines.push(`  ${f.message}`);
			lines.push(`  fix: ${f.hint}`);
		}
	}
	lines.push("");
	lines.push(summarizeDocs(scan));
	return lines.join("\n");
}
