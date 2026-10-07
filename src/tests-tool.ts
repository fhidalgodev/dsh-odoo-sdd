/**
 * `odoo_tests` — the testing half of the pipeline: static hygiene of a module's
 * Python tests, the mapping between acceptance criteria and test methods, and a
 * create-only scaffold that turns each uncovered criterion into a test that
 * FAILS until someone implements it (a red test is a promise; a vacuous pass is
 * a lie).
 *
 * Usable on its own (no spec, phase or instance), like `odoo_docs`, so an
 * existing module can simply be checked.
 *
 * @module dsh-odoo-sdd/tests-tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { resolveModuleDir } from "./paths.js";
import { scanModuleTests, type TestFinding } from "./test-scan.js";
import { parseRequirements, type Requirement } from "./spec-reqs.js";
import { declaredAcIds } from "./sdd-state.js";

/** Live dependencies provided by the registrant. */
export interface TestsToolDeps {
	/** Project root of the CALLING SESSION (relative `module_dir` resolution). */
	projectRoot(exec?: unknown): string;
	/** Absolute spec directory for an id, honouring the configured layout. */
	specDir(specId: string, exec?: unknown): string;
	/** Path masking helper for display. */
	display(pathValue: string): string;
}

/** A criterion the tests do not cover yet. */
interface MissingCriterion {
	ac: string;
	/** The requirement that carries it, when the spec gives REQ ids. */
	requirement: Requirement | null;
}

/**
 * Every Python file under `tests/`, as module-relative paths.
 * @param moduleDir - module directory.
 * @returns the file paths (empty when there is no tests/ directory).
 */
function testFiles(moduleDir: string): string[] {
	const testsDir = join(moduleDir, "tests");
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				if (entry !== "__pycache__") walk(full);
			} else if (entry.endsWith(".py")) {
				out.push(relative(moduleDir, full).split("\\").join("/"));
			}
		}
	};
	walk(testsDir);
	return out;
}

/**
 * The acceptance criteria `spec.md` declares that no test mentions.
 *
 * A criterion counts as covered when its AC id (or the REQ id of the
 * requirement that carries it) appears anywhere in the module's tests: the
 * mapping is a reference the author writes, not a name the tool dictates.
 * @param moduleDir - module directory.
 * @param specDir - spec directory.
 * @returns the missing criteria with their parent requirement.
 */
function missingCriteria(moduleDir: string, specDir: string): MissingCriterion[] {
	const specPath = join(specDir, "spec.md");
	if (!existsSync(specPath)) return [];
	const requirements = parseRequirements(readFileSync(specPath, "utf8"));
	const declared = declaredAcIds(specDir);
	let corpus = "";
	for (const file of testFiles(moduleDir)) {
		try {
			corpus += "\n" + readFileSync(join(moduleDir, file), "utf8");
		} catch {
			// an unreadable file is already reported by the scan
		}
	}
	const out: MissingCriterion[] = [];
	for (const ac of declared) {
		const pattern = new RegExp(`\\b${ac.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		if (pattern.test(corpus)) continue;
		const requirement = requirements.find((r) => r.acIds.includes(ac)) ?? null;
		if (requirement !== null && new RegExp(`\\b${requirement.reqId}\\b`).test(corpus)) continue;
		out.push({ ac, requirement });
	}
	return out;
}

/** Snake-case a criterion's text into a readable method name fragment. */
function slugForMethod(text: string, fallback: string): string {
	const ascii = text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return (ascii.split("_").slice(0, 6).join("_") || fallback).slice(0, 48);
}

/**
 * One generated test method: it must FAIL until the behaviour exists, so the
 * body raises instead of passing vacuously.
 */
function methodFor(criterion: MissingCriterion): string {
	const requirement = criterion.requirement;
	const slug = slugForMethod(requirement?.text ?? "", criterion.ac.toLowerCase());
	const reqLine = requirement === null ? "" : `\n        ${requirement.reqId}`;
	return (
		`    @tagged("post_install", "-at_install")\n` +
		`    def test_${criterion.ac.toLowerCase()}_${slug}(self):\n` +
		`        """${criterion.ac}: ${requirement?.text ?? "..."}${reqLine}\n` +
		`        """\n` +
		`        raise NotImplementedError("${criterion.ac} is not implemented yet")\n`
	);
}

/**
 * Register the `odoo_tests` tool.
 * @param ctx - registrant context exposing the tool registry.
 * @param deps - live configuration lookups.
 */
export function registerTestsTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: TestsToolDeps,
): void {
	ctx.tools.register(defineTool({
		name: "odoo_tests",
		description:
			"Tests for an Odoo module, usable ON ITS OWN (no spec, phase or connected instance). operation=check " +
			"scans the Python tests for the failures an install log cannot show: a tests/*.py that tests/__init__.py " +
			"never imports (Odoo only loads what is imported, so the test never runs), a class that is not an Odoo " +
			"test case, a test_* method that asserts nothing or asserts something trivially true, a swallowed " +
			"exception, time.sleep, explicit skips, cr.commit() inside a test (it breaks the per-test rollback), " +
			"SavepointCase on 17+, an HttpCase without start_tour. operation=plan maps every acceptance criterion of " +
			"the spec to the test that mentions it and lists the criteria with no test at all. operation=scaffold " +
			"creates tests/test_<module>_sdd.py with one test method per uncovered criterion — each body raises " +
			"NotImplementedError, so a scaffolded test is RED until it is implemented (create-only: existing files " +
			"are never overwritten, only missing methods are appended).",
		parameters: {
			operation: { type: "string", required: true, enum: ["check", "plan", "scaffold"], description: "What to do." },
			module_dir: { type: "string", required: true, description: "Module directory (the one holding __manifest__.py)." },
			spec_id: { type: "string", description: "Spec id (plan/scaffold): read spec.md and test-plan.md from the configured specs layout." },
			spec_dir: { type: "string", description: "Alternative to spec_id: the spec directory as a path." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					operation: { type: "string", required: true },
					findings: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					summary: { type: "array", required: true, items: { type: "string" } },
					detail: { type: "string", required: true },
					moduleDir: { type: "string", required: true },
					projectRoot: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { detail: string }).detail }],
		},
		async execute(args: { operation: "check" | "plan" | "scaffold"; module_dir: string; spec_id?: string; spec_dir?: string }, exec?: unknown) {
			const projectRoot = deps.projectRoot(exec);
			const moduleDir = resolveModuleDir(args.module_dir, projectRoot);
			const moduleName = basename(moduleDir);
			const resolvedSpecDir =
				args.spec_id !== undefined && args.spec_id.trim() !== ""
					? deps.specDir(args.spec_id, exec)
					: args.spec_dir !== undefined && args.spec_dir.trim() !== ""
						? resolveModuleDir(args.spec_dir, projectRoot)
						: null;

			if (args.operation === "check") {
				const scan = scanModuleTests(moduleDir);
				// Plain object literals: the tool boundary serializes them as JSON.
				const findings = scan.findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, message: f.message }));
				const errors = findings.filter((f) => f.severity === "ERROR").length;
				return {
					ok: errors === 0,
					operation: "check",
					findings,
					summary: scan.summary,
					detail:
						(scan.findings.length === 0
							? "Test hygiene: no findings."
							: `Test hygiene: ${errors} ERROR(s), ${scan.findings.length - errors} WARN(s). ` +
								(scan.findings.length > 0 ? "An ERROR here is a test that cannot do its job." : "")) +
						"\n" +
						scan.summary.join("\n") +
						`\nResolved module_dir: ${deps.display(moduleDir)} (project root: ${deps.display(projectRoot)})`,
					moduleDir,
					projectRoot,
				};
			}

			if (resolvedSpecDir === null) {
				return {
					ok: false,
					operation: args.operation,
					findings: [],
					summary: [],
					detail: `operation=${args.operation} needs the spec: pass spec_id (or spec_dir). Without it there are no acceptance criteria to map.`,
					moduleDir,
					projectRoot,
				};
			}
			if (!existsSync(join(resolvedSpecDir, "spec.md"))) {
				return {
					ok: false,
					operation: args.operation,
					findings: [],
					summary: [],
					detail: `No spec.md in ${deps.display(resolvedSpecDir)}: nothing to map.`,
					moduleDir,
					projectRoot,
				};
			}
			const missing = missingCriteria(moduleDir, resolvedSpecDir);
			const declared = declaredAcIds(resolvedSpecDir);
			if (args.operation === "plan") {
				const covered = declared.length - missing.length;
				const findings = missing.map((c) => ({
					severity: "WARN",
					file: "tests/",
					line: 0,
					message: `${c.ac} has no test mentioning it${c.requirement === null ? "" : ` (${c.requirement.reqId})`}: write the test that would fail if this criterion regressed.`,
				}));
				return {
					ok: missing.length === 0,
					operation: "plan",
					findings,
					summary: [`${covered}/${declared.length} acceptance criterion/criteria referenced by a test.`],
					detail:
						`Criteria covered by a test: ${covered}/${declared.length}.` +
						(missing.length === 0
							? " Nothing missing."
							: `\nUncovered: ${missing.map((c) => c.ac).join(", ")}. Run odoo_tests operation=scaffold to create RED stubs for them.`),
					moduleDir,
					projectRoot,
				};
			}

			// scaffold — create-only: an existing file is extended, never rewritten.
			const created: string[] = [];
			const skipped: string[] = [];
			const testsDir = join(moduleDir, "tests");
			if (!existsSync(testsDir)) {
				mkdirSync(testsDir, { recursive: true });
				created.push("tests/");
			}
			const initPath = join(testsDir, "__init__.py");
			const targetName = `test_${moduleName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_sdd`;
			const targetRel = `tests/${targetName}.py`;
			const targetPath = join(moduleDir, targetRel);
			const usesHttp = missing.some((c) => /\b(tour|ui|browser|website|http)\b/i.test(c.requirement?.text ?? ""));
			const header =
				"# Generated by odoo_tests operation=scaffold: one test per acceptance criterion.\n" +
				"# Each body raises NotImplementedError on purpose — a scaffolded test is RED\n" +
				"# until someone implements the behaviour and asserts it.\n" +
				`from odoo.tests import ${usesHttp ? "HttpCase" : "TransactionCase"}, tagged\n\n\n` +
				`class Test${moduleName.replace(/(^|_)(\w)/g, (_m, _p, c: string) => c.toUpperCase())}( ${usesHttp ? "HttpCase" : "TransactionCase"}):\n`;
			const existingText = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
			const pending = missing.filter((c) => !new RegExp(`def\\s+test_${c.ac.toLowerCase()}_`).test(existingText));
			skipped.push(...missing.filter((c) => !pending.includes(c)).map((c) => c.ac));
			if (pending.length > 0) {
				const body = pending.map(methodFor).join("\n");
				if (existingText === "") {
					writeFileSync(targetPath, header + body, "utf8");
					created.push(targetRel);
				} else {
					writeFileSync(targetPath, existingText.replace(/\s*$/, "\n\n") + body, "utf8");
					created.push(`${targetRel} (appended ${pending.length} method(s))`);
				}
			}
			// The import is what makes Odoo load the module: without it the new file
			// is dead code, which is exactly the failure the check reports.
			if (existsSync(initPath)) {
				const initText = readFileSync(initPath, "utf8");
				if (!new RegExp(`^\\s*from\\s+\\.\\s+import\\s+.*\\b${targetName}\\b`, "m").test(initText)) {
					writeFileSync(initPath, initText.replace(/\s*$/, "\n") + `from . import ${targetName}\n`, "utf8");
					created.push("tests/__init__.py (import added)");
				}
			} else {
				writeFileSync(initPath, `from . import ${targetName}\n`, "utf8");
				created.push("tests/__init__.py");
			}
			return {
				ok: true,
				operation: "scaffold",
				findings: [],
				summary: [`${missing.length} uncovered criterion/criteria; ${pending.length} stub(s) written.`],
				detail:
					(created.length === 0
						? "Nothing to write: every declared criterion already has a test."
						: `Wrote: ${created.join(", ")}.`) +
					(skipped.length > 0 ? `\nAlready present (untouched): ${skipped.join(", ")}.` : "") +
					(pending.length > 0
						? "\nEach new test raises NotImplementedError: run the suite and watch them FAIL before implementing — that failure is the RED half of the cycle."
						: "") +
					`\nResolved module_dir: ${deps.display(moduleDir)}`,
				moduleDir,
				projectRoot,
			};
		},
	}));
}
