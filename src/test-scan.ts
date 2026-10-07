/**
 * Static, instance-free scan of a module's Python tests.
 *
 * Odoo only loads the test modules its `tests/__init__.py` imports, and a test
 * that asserts nothing passes for the wrong reason. Neither failure is visible
 * in an install log, so they are checked here — before anything reaches the
 * instance — with the same `file:line` finding shape the security scanner uses.
 *
 * The rules come from how Odoo's own suite is written (TransactionCase and the
 * rollback it gives every test, `@tagged`, tours executed through HttpCase) and
 * from the anti-patterns that make a green suite lie: a test that cannot fail, a
 * trivial assertion, conditional logic around the unit under test, sleeps,
 * skipped tests and an explicit `cr.commit()` that escapes the test transaction.
 *
 * @module dsh-odoo-sdd/test-scan
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** One test-hygiene finding. */
export interface TestFinding {
	severity: "ERROR" | "WARN";
	/** Path relative to the module directory. */
	file: string;
	/** 1-based line the finding points at (0 when it is about the file itself). */
	line: number;
	message: string;
}

/** Result of scanning one module's tests. */
export interface TestScanResult {
	findings: TestFinding[];
	/** Human-readable facts (counts, assertion density). */
	summary: string[];
	/** Number of `test_*` methods found. */
	testMethods: number;
	/** Number of assertions found across those methods. */
	assertions: number;
}

/** Base classes Odoo's own test cases derive from. */
const ODDO_TEST_BASES = ["TransactionCase", "HttpCase", "SavepointCase", "BaseCase", "Form"];

/** Odoo removed SavepointCase in 17 (TransactionCase covers the savepoint). */
const SAVEPOINT_REMOVED_MAJOR = 17;

/** An assertion inside a test body: `self.assertX(...)`, `self.fail(...)` or a bare `assert x`. */
const ASSERTION = /\bself\.assert[A-Za-z]+\(|\bself\.fail\(|(^|[^\w.])assert\s+[^=]|assertRaises\b|assertRecordValues\b/;

/** A scaffolded stub: it fails by construction until someone implements it. */
const UNIMPLEMENTED_STUB = /raise\s+NotImplementedError/;

/** Assertions that are true no matter what the code does. */
const TRIVIAL_ASSERTIONS: RegExp[] = [
	/self\.assertTrue\(\s*True\s*\)/,
	/self\.assertFalse\(\s*False\s*\)/,
	/self\.assertEqual\(\s*(1|True)\s*,\s*(1|True)\s*\)/,
	/self\.assertEqual\(\s*(\w+)\s*,\s*\1\s*\)/,
];

/** Escaping the test transaction: the rollback that keeps tests independent. */
const COMMIT_IN_TEST = /\b(cr|self\.env\.cr)\.commit\(|cr\.execute\(\s*["']COMMIT["']/i;

/** Conditional logic around the unit under test. */
const CONDITIONAL = /^\s*(if|elif|else)\b/;
/** A `try:` that is not an assertion about the failure. */
const TRY_WITHOUT_ASSERT_RAISES = /^\s*try\s*:/;

/** Non-determinism. */
const SLEEP = /\btime\.sleep\(/;

/** Explicit skips, counted so "green" is not read as "everything ran". */
const SKIP = /@(unittest\.)?skip\b|raise\s+SkipTest\b/;

/** Names that describe nothing. */
const VAGUE_TEST_NAME = /^test_(\d+|it|case|ok|test|foo|bar)$/;

/**
 * Read the Odoo major version a module targets from its manifest.
 * @param manifestText - contents of `__manifest__.py`.
 * @returns the major (e.g. 17) or null when it cannot be read.
 */
function manifestMajor(manifestText: string): number | null {
	const m = /['"]version['"]\s*:\s*["'](\d+)\./.exec(manifestText);
	return m === null ? null : Number.parseInt(m[1]!, 10);
}

/**
 * The modules `tests/__init__.py` imports (`from . import a, b` and the
 * parenthesized form), which is exactly the set Odoo will load.
 * @param initText - contents of `tests/__init__.py`.
 * @returns imported module basenames.
 */
function initImports(initText: string): string[] {
	const names: string[] = [];
	const lines = initText.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = /^\s*from\s+\.+\s+import\s+(.*)$/.exec(line);
		if (m === null) continue;
		let rest = m[1]!;
		// A parenthesized list continues on the following lines.
		while (rest.includes("(") && !rest.includes(")")) {
			i += 1;
			if (i >= lines.length) break;
			rest += " " + lines[i]!;
		}
		for (const token of rest.replace(/[()]/g, " ").split(/[,\s]+/)) {
			const name = token.trim();
			if (name === "" || name.startsWith("#") || name === "*") continue;
			names.push(name);
		}
	}
	return [...new Set(names)];
}

/** A `class Name(Bases):` block found in a test file. */
interface TestClass {
	name: string;
	bases: string[];
	line: number;
	/** Methods of the class: name, start line, body lines and decorators. */
	methods: Array<{ name: string; line: number; body: string[]; decorators: string[] }>;
}

/**
 * Parse the test classes of one Python file (line-based on purpose: a full
 * parser is not needed to answer "does this method assert anything").
 * @param text - file contents.
 * @returns the classes in file order.
 */
function parseTestClasses(text: string): TestClass[] {
	const lines = text.split(/\r?\n/);
	const classes: TestClass[] = [];
	let current: TestClass | null = null;
	let method: TestClass["methods"][number] | null = null;
	let pendingDecorators: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const classMatch = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
		if (classMatch !== null) {
			current = { name: classMatch[1]!, bases: (classMatch[2] ?? "").split(",").map((b) => b.trim()).filter(Boolean), line: i + 1, methods: [] };
			classes.push(current);
			method = null;
			pendingDecorators = [];
			continue;
		}
		const methodMatch = /^\s+def\s+(test_\w+)\s*\(\s*self\b/.exec(line);
		if (methodMatch !== null && current !== null) {
			method = { name: methodMatch[1]!, line: i + 1, body: [], decorators: pendingDecorators };
			current.methods.push(method);
			pendingDecorators = [];
			continue;
		}
		if (/^\s*@/.test(line)) {
			pendingDecorators.push(line.trim());
			continue;
		}
		if (method !== null) method.body.push(line);
	}
	return classes;
}

/**
 * Scan the Python tests of a module.
 * @param moduleDir - module directory (the one holding `__manifest__.py`).
 * @returns findings, counts and a summary.
 */
export function scanModuleTests(moduleDir: string): TestScanResult {
	const findings: TestFinding[] = [];
	const testsDir = join(moduleDir, "tests");
	if (!existsSync(testsDir)) {
		return {
			findings: [{ severity: "WARN", file: "tests/", line: 0, message: "no tests/ directory: nothing verifies this module. Create tests/__init__.py and at least one test case, or say explicitly in the verification why a test is impossible." }],
			summary: ["No tests/ directory."],
			testMethods: 0,
			assertions: 0,
		};
	}
	const manifestPath = join(moduleDir, "__manifest__.py");
	const major = existsSync(manifestPath) ? manifestMajor(readFileSync(manifestPath, "utf8")) : null;
	const pyFiles: string[] = [];
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
				pyFiles.push(relative(moduleDir, full).split("\\").join("/"));
			}
		}
	};
	walk(testsDir);

	const initRel = pyFiles.find((f) => f === "tests/__init__.py");
	const testFiles = pyFiles.filter((f) => f.endsWith(".py") && f !== "tests/__init__.py");
	if (initRel === undefined) {
		findings.push({
			severity: "ERROR",
			file: "tests/__init__.py",
			line: 0,
			message: "tests/__init__.py is missing: Odoo loads ONLY the test modules it imports, so none of these tests would ever run.",
		});
	} else {
		const imported = initImports(readFileSync(join(moduleDir, initRel), "utf8"));
		const stems = new Set(testFiles.map((f) => f.replace(/^tests\//, "").replace(/\.py$/, "").split("/")[0]!));
		for (const file of testFiles) {
			const stem = file.replace(/^tests\//, "").replace(/\.py$/, "").split("/")[0]!;
			if (!imported.includes(stem)) {
				findings.push({
					severity: "ERROR",
					file,
					line: 0,
					message: `not imported by tests/__init__.py: Odoo never loads it, so this test never runs. Add \`from . import ${stem}\`.`,
				});
			}
		}
		for (const name of imported) {
			if (!stems.has(name)) {
				findings.push({
					severity: "ERROR",
					file: "tests/__init__.py",
					line: 0,
					message: `imports "${name}", which is not a module under tests/ — a broken import makes the whole test package fail to load.`,
				});
			}
		}
	}

	let testMethods = 0;
	let assertions = 0;
	let skipped = 0;
	let stubs = 0;
	for (const file of testFiles) {
		let text: string;
		try {
			text = readFileSync(join(moduleDir, file), "utf8");
		} catch {
			continue;
		}
		const classes = parseTestClasses(text);
		if (classes.length === 0 && /\bdef\s+test_/.test(text)) {
			findings.push({
				severity: "ERROR",
				file,
				line: 0,
				message: "has test methods but no `class …(TransactionCase)` — Odoo's runner only collects test cases, so these functions never run.",
			});
		}
		for (const klass of classes) {
			const isOdooCase = klass.bases.some((base) => ODDO_TEST_BASES.some((known) => base === known || base.endsWith(`.${known}`)));
			if (!isOdooCase) {
				findings.push({
					severity: "ERROR",
					file,
					line: klass.line,
					message: `class ${klass.name} inherits ${klass.bases.length === 0 ? "nothing" : klass.bases.join(", ")}: an Odoo test must inherit TransactionCase (or HttpCase/BaseCase) to get self.env and the per-test rollback.`,
				});
			}
			if (major !== null && major >= SAVEPOINT_REMOVED_MAJOR && klass.bases.includes("SavepointCase")) {
				findings.push({
					severity: "WARN",
					file,
					line: klass.line,
					message: `SavepointCase was removed in Odoo ${SAVEPOINT_REMOVED_MAJOR} (this module targets ${major}): use TransactionCase.`,
				});
			}
			const isHttpCase = klass.bases.some((base) => base === "HttpCase" || base.endsWith(".HttpCase"));
			for (const method of klass.methods) {
				testMethods += 1;
				const body = method.body.join("\n");
				const bodyCode = method.body.filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).join("\n");
				const assertCount = method.body.filter((l) => ASSERTION.test(l)).length;
				assertions += assertCount;
				const decorators = method.decorators.join("\n");
				const isSkipped = SKIP.test(decorators) || SKIP.test(body);
				if (isSkipped) skipped += 1;
				// A RED stub is not a "test that asserts nothing": it fails on
				// purpose, and saying so is the honest report — flagging it as an
				// error would push authors to fake an assertion to silence the gate.
				if (UNIMPLEMENTED_STUB.test(body)) {
					stubs += 1;
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() is an unimplemented stub: it fails until the criterion is implemented.`,
					});
					continue;
				}
				if (assertCount === 0 && !isSkipped) {
					findings.push({
						severity: "ERROR",
						file,
						line: method.line,
						message: `${method.name}() asserts nothing: a test that cannot fail is not evidence. Assert the behaviour (or mark it skipped explicitly).`,
					});
				}
				for (const trivial of TRIVIAL_ASSERTIONS) {
					if (trivial.test(body)) {
						findings.push({
							severity: "WARN",
							file,
							line: method.line,
							message: `${method.name}() contains a trivially-true assertion: it passes whatever the code does.`,
						});
						break;
					}
				}
				if (/^\s*pass\s*$/m.test(bodyCode) && assertCount === 0 && bodyCode.replace(/^\s*pass\s*$/m, "").trim() === "") {
					findings.push({
						severity: "ERROR",
						file,
						line: method.line,
						message: `${method.name}() has an empty body: it reports green without testing anything.`,
					});
				}
				if (COMMIT_IN_TEST.test(body)) {
					findings.push({
						severity: "ERROR",
						file,
						line: method.line,
						message: `${method.name}() commits the transaction: the per-test rollback is what keeps tests independent — committing leaks data into every later test.`,
					});
				}
				if (method.body.some((l) => CONDITIONAL.test(l))) {
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() branches with if/else: conditional logic inside a test can mask a failure (each test should have one path).`,
					});
				}
				if (method.body.some((l) => TRY_WITHOUT_ASSERT_RAISES.test(l)) && !/assertRaises/.test(body)) {
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() catches an exception with try/ but no assertRaises: an error the test swallows is an error the suite reports as success.`,
					});
				}
				if (SLEEP.test(body)) {
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() calls time.sleep(): a sleeping test is slow and flaky — wait on the state, not on the clock.`,
					});
				}
				if (VAGUE_TEST_NAME.test(method.name)) {
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() does not describe a behaviour: name it after what should happen (e.g. test_rejects_negative_amount).`,
					});
				}
				if (isHttpCase && !/start_tour\(/.test(body) && !/start_tour\(/.test(text)) {
					findings.push({
						severity: "WARN",
						file,
						line: method.line,
						message: `${method.name}() is an HttpCase without start_tour(): a tour only becomes a result when something executes it.`,
					});
				}
			}
		}
	}

	const errors = findings.filter((f) => f.severity === "ERROR").length;
	const warns = findings.length - errors;
	const density = testMethods === 0 ? 0 : assertions / testMethods;
	const summary = [
		`${testMethods} test method(s) in ${testFiles.length} file(s); ${assertions} assertion(s) (density ${density.toFixed(2)} per test).`,
		`${errors} ERROR(s), ${warns} WARN(s)${skipped > 0 ? `, ${skipped} skipped test(s) — a suite that skips is less green than it looks` : ""}` +
			`${stubs > 0 ? `, ${stubs} unimplemented stub(s) — they FAIL until the behaviour exists` : ""}.`,
	];
	return { findings, summary, testMethods, assertions };
}
