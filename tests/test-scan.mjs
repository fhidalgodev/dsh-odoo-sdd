/**
 * Tests for the Odoo test-hygiene scanner and the `odoo_tests` tool: the
 * failures an install log cannot show (a test module nothing imports, a test
 * that asserts nothing, a swallowed exception, a commit that escapes the test
 * transaction) plus the acceptance-criterion mapping and the create-only
 * scaffold that produces RED stubs.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const scan = await import(new URL("test-scan.js", libDir).href);
const tool = await import(new URL("tests-tool.js", libDir).href);

let failures = 0;
function check(label, cond, detail) {
	if (cond) console.log(`  PASS  ${label}`);
	else {
		console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
		failures++;
	}
}

const dir = mkdtempSync(join(tmpdir(), "sdd-tests-"));

/** Build a module fixture: manifest + tests/ files. */
function makeModule(name, manifestVersion, initText, files) {
	const moduleDir = join(dir, name);
	mkdirSync(join(moduleDir, "tests"), { recursive: true });
	writeFileSync(join(moduleDir, "__manifest__.py"), `{'name':'${name}','version':'${manifestVersion}','depends':['base'],'data':[]}`, { mode: 0o600 });
	if (initText !== null) writeFileSync(join(moduleDir, "tests", "__init__.py"), initText, { mode: 0o600 });
	for (const [rel, body] of Object.entries(files)) {
		const full = join(moduleDir, "tests", rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, body, { mode: 0o600 });
	}
	return moduleDir;
}

console.log("== test scan: rules ==");
{
	const mod = makeModule("mod_rules", "17.0.1.0.0", "from . import test_a\n", {
		"test_a.py":
			"from odoo.tests import TransactionCase, tagged, HttpCase\n\n\n" +
			"class TestOk(TransactionCase):\n" +
			"    def test_reads_a_partner(self):\n" +
			"        self.assertTrue(self.env['res.partner'].search([]))\n\n" +
			"    def test_asserts_nothing(self):\n" +
			"        self.env['res.partner'].create({'name': 'x'})\n\n" +
			"    def test_trivial(self):\n" +
			"        self.assertTrue(True)\n\n" +
			"    def test_swallows(self):\n" +
			"        try:\n" +
			"            self.env['res.partner'].create({})\n" +
			"        except Exception:\n" +
			"            pass\n" +
			"        self.assertTrue(True)\n\n" +
			"    def test_commits(self):\n" +
			"        self.env.cr.commit()\n" +
			"        self.assertTrue(1)\n\n" +
			"    def test_sleeps(self):\n" +
			"        import time\n" +
			"        time.sleep(1)\n" +
			"        self.assertTrue(1)\n\n" +
			"    def test_1(self):\n" +
			"        self.assertTrue(1)\n\n" +
			"    @tagged('-at_install', 'post_install')\n" +
			"    def test_skipped(self):\n" +
			"        raise SkipTest('later')\n\n" +
			"class TestNotACase:\n" +
			"    def test_1(self):\n" +
			"        self.assertTrue(1)\n\n" +
			"class TestLegacy(TransactionCase):\n" +
			"    def test_2(self):\n" +
			"        self.assertTrue(1)\n",
		"test_orphan.py": "from odoo.tests import TransactionCase\n\n\nclass TestOrphan(TransactionCase):\n    def test_x(self):\n        self.assertTrue(1)\n",
	});
	const result = scan.scanModuleTests(mod);
	const messages = result.findings.map((f) => f.message);
	check("flags a test file nothing imports", messages.some((m) => /not imported by tests\/__init__\.py/.test(m)), JSON.stringify(messages));
	check("flags a class that is not an Odoo test case", messages.some((m) => /an Odoo test must inherit TransactionCase/.test(m)));
	check("flags a test that asserts nothing", messages.some((m) => /test_asserts_nothing\(\) asserts nothing/.test(m)));
	check("flags a trivially-true assertion", messages.some((m) => /trivially-true assertion/.test(m)));
	check("flags a swallowed exception", messages.some((m) => /no assertRaises/.test(m)));
	check("flags cr.commit() inside a test", messages.some((m) => /commits the transaction/.test(m)));
	check("flags time.sleep", messages.some((m) => /time\.sleep/.test(m)));
	check("flags a non-descriptive name", messages.some((m) => /test_1\(\) does not describe a behaviour/.test(m)));
	check("counts skipped tests", result.summary.some((l) => /skipped test/.test(l)), JSON.stringify(result.summary));
	check("reports assertion density", result.summary.some((l) => /density/.test(l)));
	const err = result.findings.filter((f) => f.severity === "ERROR").length;
	check("errors and warnings are separated", err > 0 && result.findings.length > err, `${err} errors of ${result.findings.length}`);
	check("line numbers point at the method", result.findings.filter((f) => f.line > 0).length > 0);
}

console.log("== test scan: clean module and __init__ coherence ==");
{
	const clean = makeModule("mod_clean", "17.0.1.0.0", "from . import test_ok\n", {
		"test_ok.py":
			"from odoo.tests import TransactionCase, tagged\n\n\n" +
			"class TestOk(TransactionCase):\n" +
			"    @tagged('post_install', '-at_install')\n" +
			"    def test_creates_a_partner(self):\n" +
			"        partner = self.env['res.partner'].create({'name': 'ACME'})\n" +
			"        self.assertEqual(partner.name, 'ACME')\n",
	});
	const result = scan.scanModuleTests(clean);
	check("a clean module produces no findings", result.findings.length === 0, JSON.stringify(result.findings));
	check("counts methods and assertions", result.testMethods === 1 && result.assertions === 1, `${result.testMethods}/${result.assertions}`);

	const broken = makeModule("mod_bad_init", "17.0.1.0.0", "from . import test_missing\n", {
		"test_ok.py": "from odoo.tests import TransactionCase\n\n\nclass TestOk(TransactionCase):\n    def test_x(self):\n        self.assertTrue(1)\n",
	});
	const bad = scan.scanModuleTests(broken);
	check("flags an import of a module that does not exist", bad.findings.some((f) => /is not a module under tests\//.test(f.message)), JSON.stringify(bad.findings.map((f) => f.message)));

	const noInit = makeModule("mod_no_init", "17.0.1.0.0", null, {
		"test_ok.py": "from odoo.tests import TransactionCase\n\n\nclass TestOk(TransactionCase):\n    def test_x(self):\n        self.assertTrue(1)\n",
	});
	const missing = scan.scanModuleTests(noInit);
	check("flags a missing tests/__init__.py", missing.findings.some((f) => /tests\/__init__\.py is missing/.test(f.message)));

	const legacy = makeModule("mod_legacy", "16.0.1.0.0", "from . import test_ok\n", {
		"test_ok.py": "from odoo.tests import SavepointCase\n\n\nclass TestOk(SavepointCase):\n    def test_x(self):\n        self.assertTrue(1)\n",
	});
	check("SavepointCase is accepted on 16", !scan.scanModuleTests(legacy).findings.some((f) => /SavepointCase/.test(f.message)));
	const modern = makeModule("mod_modern", "17.0.1.0.0", "from . import test_ok\n", {
		"test_ok.py": "from odoo.tests import SavepointCase\n\n\nclass TestOk(SavepointCase):\n    def test_x(self):\n        self.assertTrue(1)\n",
	});
	check("SavepointCase warns on 17", scan.scanModuleTests(modern).findings.some((f) => /SavepointCase was removed in Odoo 17/.test(f.message)));
}

console.log("== odoo_tests tool: plan and scaffold ==");
{
	const projectRoot = join(dir, "proj");
	const moduleDir = join(projectRoot, "mod_tool");
	mkdirSync(join(moduleDir, "models"), { recursive: true });
	writeFileSync(join(moduleDir, "__manifest__.py"), "{'name':'mod_tool','version':'17.0.1.0.0','depends':['base'],'data':[]}", { mode: 0o600 });
	const specDir = join(projectRoot, "specs", "001-x");
	mkdirSync(specDir, { recursive: true });
	writeFileSync(
		join(specDir, "spec.md"),
		"# Spec\n\n## Acceptance Criteria\n\n- [ ] AC1: The module shall reject unauthenticated calls.\n- [ ] AC2: The module shall log every rejection.\n",
		{ mode: 0o600 },
	);
	writeFileSync(join(specDir, "test-plan.md"), "| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | a | rpc | pass |\n| AC2 | b | rpc | pending |\n", { mode: 0o600 });

	const registered = new Map();
	tool.registerTestsTool(
		{ tools: { register: (t) => registered.set(t.name, t) } },
		{
			projectRoot: () => projectRoot,
			specDir: (id) => join(projectRoot, "specs", id),
			display: (v) => v,
		},
	);
	const tests = registered.get("odoo_tests");
	check("odoo_tests is registered", tests !== undefined);

	const plan = await tests.execute({ operation: "plan", module_dir: "mod_tool", spec_id: "001-x" });
	check("plan lists both criteria as uncovered", plan.ok === false && plan.findings.length === 2, JSON.stringify(plan.findings.map((f) => f.message)));
	check("plan names the requirement id", plan.findings.every((f) => /REQ-[A-Z_]+-\d\d/.test(f.message)), JSON.stringify(plan.findings.map((f) => f.message)));

	const made = await tests.execute({ operation: "scaffold", module_dir: "mod_tool", spec_id: "001-x" });
	const target = join(moduleDir, "tests", "test_mod_tool_sdd.py");
	check("scaffold writes the test file", made.ok === true && existsSync(target), made.detail);
	const body = readFileSync(target, "utf8");
	check("scaffolded tests are RED by construction", (body.match(/raise NotImplementedError/g) ?? []).length === 2, body);
	check("scaffolded tests are tagged post_install", (body.match(/@tagged\("post_install", "-at_install"\)/g) ?? []).length === 2);
	check("scaffold imports the new module in __init__.py", /from \. import test_mod_tool_sdd/.test(readFileSync(join(moduleDir, "tests", "__init__.py"), "utf8")));
	const stubScan = scan.scanModuleTests(moduleDir);
	check("the scaffolded module has no ERROR (a RED stub is a WARN, not a lie)", stubScan.findings.filter((f) => f.severity === "ERROR").length === 0, JSON.stringify(stubScan.findings));
	check("the stub is reported as unimplemented", stubScan.findings.some((f) => /unimplemented stub/.test(f.message)), JSON.stringify(stubScan.findings.map((f) => f.message)));
	check("the summary counts the stubs", stubScan.summary.some((l) => /unimplemented stub/.test(l)), JSON.stringify(stubScan.summary));

	// Idempotence: a second run must not duplicate methods.
	const again = await tests.execute({ operation: "scaffold", module_dir: "mod_tool", spec_id: "001-x" });
	const body2 = readFileSync(target, "utf8");
	check("scaffold is idempotent", (body2.match(/def test_ac1_/g) ?? []).length === 1 && (body2.match(/def test_ac2_/g) ?? []).length === 1, again.detail);
	check("...and it does not touch the existing methods", (body2.match(/raise NotImplementedError/g) ?? []).length === 2);

	// A test that mentions the criterion closes it: plan goes green.
	writeFileSync(
		join(moduleDir, "tests", "test_mod_tool_sdd.py"),
		"from odoo.tests import TransactionCase\n\n\nclass TestMod(TransactionCase):\n" +
			"    def test_ac1(self):\n        \"\"\"AC1\"\"\"\n        self.assertTrue(1)\n" +
			"    def test_ac2(self):\n        \"\"\"AC2\"\"\"\n        self.assertTrue(1)\n",
		{ mode: 0o600 },
	);
	const closed = await tests.execute({ operation: "plan", module_dir: "mod_tool", spec_id: "001-x" });
	check("plan closes criteria a test mentions", closed.ok === true && closed.findings.length === 0, JSON.stringify(closed.findings));

	const noSpec = await tests.execute({ operation: "plan", module_dir: "mod_tool" });
	check("plan without a spec says what it needs", noSpec.ok === false && /needs the spec/.test(noSpec.detail));
	const checked = await tests.execute({ operation: "check", module_dir: "mod_tool" });
	check("check runs without a spec", typeof checked.ok === "boolean" && checked.findings !== undefined);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
