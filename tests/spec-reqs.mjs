/**
 * Tests for the requirement-stability layer: stable REQ-<AREA>-NN ids,
 * per-requirement fingerprints and the baseline with DRIFT detection,
 * bidirectional coverage with modality floors, and the ambiguity lint.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const reqs = await import(new URL("spec-reqs.js", libDir).href);
const cov = await import(new URL("coverage.js", libDir).href);
const lint = await import(new URL("ambiguity-lint.js", libDir).href);

let failures = 0;
function check(label, cond, detail) {
	if (cond) console.log(`  PASS  ${label}`);
	else {
		console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
		failures++;
	}
}

const dir = mkdtempSync(join(tmpdir(), "sdd-reqs-"));

console.log("== parse: stable ids, AC mapping, modality ==");
{
	const spec =
		"# Spec\n\n## Context\n\nSome context prose.\n\n" +
		"## Security\n\n- The module must resist CSRF on every route.\n" +
		"- Users outside group base.group_user may not read field X.\n\n" +
		"## Acceptance Criteria\n\n- [ ] AC1: The module shall reject an unauthenticated call.\n";
	const parsed = reqs.parseRequirements(spec);
	check("three requirement blocks", parsed.length === 3, `got ${parsed.length}`);
	check("ids are AREA + ordinal", parsed.map((r) => r.reqId).join(",") === "REQ-SECURITY-01,REQ-SECURITY-02,REQ-ACCEPTANCE_CRITERIA-01", parsed.map((r) => r.reqId).join(","));
	check("prose without a list contributes nothing", !parsed.some((r) => r.area === "CONTEXT"));
	check("AC id harvested", parsed[2].acIds.includes("AC1"), JSON.stringify(parsed[2].acIds));
	check("modality verbs detected", parsed[0].modality === "must" && parsed[2].modality === "shall", `${parsed[0].modality}/${parsed[2].modality}`);
	// Formatting-only edits keep the fingerprint: re-quote and re-space.
	const reformatted = spec.replace("must resist", "must  resist").replace(/"/g, '\u201c', 1);
	check("whitespace-only edit keeps fingerprint", reqs.parseRequirements(reformatted)[0].fingerprint === parsed[0].fingerprint);
	const reworded = spec.replace("must resist", "must withstand");
	check("wording change moves fingerprint", reqs.parseRequirements(reworded)[0].fingerprint !== parsed[0].fingerprint);
}

console.log("== baseline + DRIFT ==");
{
	const specDir = join(dir, "specs", "010-drift");
	mkdirSync(specDir, { recursive: true });
	const spec =
		"# Spec\n\n## Security\n\n- The module must resist CSRF.\n- Logs must be redacted.\n";
	writeFileSync(join(specDir, "spec.md"), spec);
	check("no baseline yet", reqs.readBaseline(specDir) === null);
	check("first gate creates the baseline (lazy migration)", reqs.driftGate(specDir) === null && existsSync(reqs.baselinePath(specDir)));
	// Same text: no drift.
	check("unchanged spec passes the gate", reqs.driftGate(specDir) === null);
	// Reword ONE requirement under the same id: DRIFT must block.
	writeFileSync(join(specDir, "spec.md"), spec.replace("must resist CSRF", "must resist XSS"));
	const blocked = reqs.driftGate(specDir);
	check("reworded requirement blocks with DRIFT", blocked !== null && blocked.includes("DRIFT") && blocked.includes("REQ-SECURITY-01"), blocked ?? "(no block)");
	// Removed requirement: also blocks.
	writeFileSync(join(specDir, "spec.md"), "# Spec\n\n## Security\n\n- The module must resist CSRF.\n");
	const removed = reqs.driftGate(specDir);
	check("removed requirement blocks", removed !== null && removed.includes("REMOVED"), removed ?? "(no block)");
	// Explicit refresh accepts the new wording (the decision DRIFT asks for).
	writeFileSync(join(specDir, "spec.md"), spec.replace("must resist CSRF", "must resist XSS"));
	reqs.refreshBaseline(specDir);
	check("refresh accepts the new wording", reqs.driftGate(specDir) === null);
	const report = reqs.driftReport(specDir);
	check("post-refresh report is clean", report.drifted.length === 0 && report.removed.length === 0, JSON.stringify(report));

	// A NEW requirement is accepted (specs grow) and recorded, so REWORDING that
	// same id afterwards is DRIFT — not "added forever".
	const grown = spec.replace("must resist CSRF", "must resist XSS") + "- Sessions must expire after 30 minutes of inactivity.\n";
	writeFileSync(join(specDir, "spec.md"), grown);
	check("a newly written requirement passes the gate", reqs.driftGate(specDir) === null);
	check("...and it entered the baseline", Object.keys(reqs.readBaseline(specDir).entries).includes("REQ-SECURITY-03"), JSON.stringify(Object.keys(reqs.readBaseline(specDir).entries)));
	writeFileSync(join(specDir, "spec.md"), grown.replace("30 minutes", "10 minutes"));
	const lateDrift = reqs.driftGate(specDir);
	check("reworking the new requirement now blocks", lateDrift !== null && lateDrift.includes("REQ-SECURITY-03"), lateDrift ?? "(no block)");
}

console.log("== coverage: both directions, modality floors ==");
{
	const specDir = join(dir, "specs", "020-cov");
	const moduleDir = join(dir, "module_a");
	mkdirSync(specDir, { recursive: true });
	mkdirSync(join(moduleDir, "models"), { recursive: true });
	writeFileSync(
		join(specDir, "spec.md"),
		"# Spec\n\n## Security\n\n- The module shall reject unauthenticated calls. (AC1)\n" +
			"- The module should log failures.\n- The module may cache lookups.\n",
	);
	writeFileSync(
		join(specDir, "test-plan.md"),
		"| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | rejects | rpc | pass |\n",
	);
	writeFileSync(join(moduleDir, "__manifest__.py"), "{}\n");
	writeFileSync(
		join(moduleDir, "models", "thing.py"),
		"NAME = 'x'\n# REQ-SECURITY-01: enforced here\n" +
			'"""Module doc.\nREQ-SECURITY-02 lives in the docstring.\n"""\n' +
			"url = 'REQ-SECURITY-03-in-a-string'\n",
	);
	const report = cov.coverageReport(moduleDir, specDir);
	const byId = Object.fromEntries(report.rows.map((r) => [r.reqId, r]));
	check("annotated+passing = covered", byId["REQ-SECURITY-01"]?.status === "covered", JSON.stringify(byId["REQ-SECURITY-01"]));
	check("annotated, no AC = unimplemented (should)", byId["REQ-SECURITY-02"]?.status === "unimplemented");
	check("may requirement unannotated = untested but not blocking", byId["REQ-SECURITY-03"]?.status === "untested");
	// The only must/shall requirement IS covered, so the mandatory floor holds —
	// while the incomplete "should" one is reported without blocking.
	check("mandatory floor holds when every must/shall is covered", report.ok === true && report.mandatoryRatio === 1, JSON.stringify(report.summary));
	check("should gap is reported, not blocking", report.summary.some((l) => l.includes("REQ-SECURITY-02") && l.includes("unimplemented")), JSON.stringify(report.summary));
	check("string REQ id is NOT an annotation (no orphan)", !report.orphans.includes("REQ-SECURITY-03"), JSON.stringify(report.orphans));
	// A SECOND mandatory requirement with no annotation and no passing row must
	// break the 1.0 floor.
	writeFileSync(
		join(specDir, "spec.md"),
		readFileSync(join(specDir, "spec.md"), "utf8") + "- The module shall audit every export. (AC9)\n",
	);
	const breached = cov.coverageReport(moduleDir, specDir);
	check("uncovered must/shall breaches the floor", breached.ok === false && breached.mandatoryRatio < 1, JSON.stringify(breached.summary));
	// Orphan direction: annotation for an id the spec never declared.
	writeFileSync(join(moduleDir, "models", "thing.py"), "# REQ-SECURITY-99: ghost\n");
	const ghost = cov.coverageReport(moduleDir, specDir);
	check("orphaned annotation detected", ghost.orphans.includes("REQ-SECURITY-99"), JSON.stringify(ghost.orphans));
	// Full mandatory coverage + no orphans -> ok.
	writeFileSync(join(moduleDir, "models", "thing.py"), "# REQ-SECURITY-01 done\n");
	writeFileSync(join(specDir, "test-plan.md"),
		"| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | rejects | rpc | pass (evidence) |\n");
	// Give the should requirement an AC too so it can be covered.
	writeFileSync(
		join(specDir, "spec.md"),
		"# Spec\n\n## Security\n\n- The module shall reject unauthenticated calls. (AC1)\n" +
			"- The module should log failures. (AC2)\n- The module may cache lookups.\n",
	);
	writeFileSync(join(specDir, "test-plan.md"),
		"| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | rejects | rpc | pass |\n| AC2 | logs | server | pass |\n");
	writeFileSync(join(moduleDir, "models", "thing.py"), "# REQ-SECURITY-01 done\n# REQ-SECURITY-02 done\n");
	const okReport = cov.coverageReport(moduleDir, specDir);
	check("all covered and no orphans -> ok", okReport.ok === true && okReport.mandatoryRatio === 1, JSON.stringify(okReport.summary));
}

console.log("== ambiguity lint ==");
{
	const spec =
		"# Spec\n\n## Requirements\n\n" +
		"- The dashboard must be fast.\n" +
		"- Some records are exported.\n" +
		"- TBD which printer.\n" +
		"- The file is uploaded.\n" +
		"- The wizard must validate and then post the entry.\n" +
		"- The module must expose `/api/v2/items`.\n";
	const findings = lint.lintAmbiguity(spec);
	const rules = findings.map((f) => f.rule);
	check("unquantified adjective flagged", rules.includes("unquantified-adjective"), JSON.stringify(rules));
	check("vague quantifier flagged", rules.includes("vague-quantifier"));
	check("placeholder flagged", rules.includes("placeholder"));
	check("passive without actor flagged", rules.includes("passive-no-actor"));
	check("compound modal requirement flagged", rules.includes("compound-requirement"));
	check("plain route line not flagged", !findings.some((f) => f.line === 10), JSON.stringify(findings.filter((f) => f.line === 10)));
	check("line numbers are 1-based", findings.every((f) => f.line >= 1 && f.line <= 10));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
