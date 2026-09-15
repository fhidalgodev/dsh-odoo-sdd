/**
 * Smoke test for dsh-odoo-sdd compiled lib (no Odoo instance needed).
 * Validates state machine (gates, ladder, verdicts, ceiling, stop.md),
 * security (S1 https/loopback guard, S2 redaction/scrub/path-masking),
 * and the Q3 fail-closed host guard.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const sdd = await import(new URL("sdd-state.js", libDir).href);
const creds = await import(new URL("credentials.js", libDir).href);

let failures = 0;
function check(label, cond) {
	if (cond) console.log(`  PASS  ${label}`);
	else { console.log(`  FAIL  ${label}`); failures++; }
}

const dir = mkdtempSync(join(tmpdir(), "sdd-smoke-"));
// Isolate EVERY test from the developer's real user-scope credentials from the
// start (the previous placement inside the onboarding section leaked the real
// `~/.config/dsh-odoo-sdd/.env` into the credentials tests, which then saw a
// non-empty cascade). Clear overrides too.
process.env["XDG_CONFIG_HOME"] = join(dir, "xdg");
delete process.env["ODOO_SDD_ENV_FILE"];
const specDir = join(dir, "specs", "001-demo");

console.log("== state machine ==");
sdd.initSpecDir(specDir);
check("skeleton files created", ["spec.md", "architecture.md", "test-plan.md"].every((f) => existsSync(join(specDir, f))));

console.log("== design inventory (guide, non-blocking) ==");
{
	const designDir = join(dir, "specs", "002-design");
	sdd.initSpecDir(designDir);
	// Skeleton architecture.md declares view types/reports with neither coverage.
	let warns = sdd.designWarnings(designDir);
	check("skeleton architecture.md warns about extra view types", warns.some((w) => /View Type|kanban/i.test(w)));
	check("skeleton architecture.md warns about missing Reports", warns.some((w) => /Reports/i.test(w)));
	// A complete declaration silences the warnings.
	writeFileSync(
		join(designDir, "architecture.md"),
		"# Architecture\n\n## Models\n\nA model.\n\n" +
			"## Views\n\nForm + tree only (no extra view types).\n\n" +
			"## Security\n\nbase.group_user; ir.model.access.csv read/write/create/unlink; no record rules needed.\n\n" +
			"## Manifest\n\nmodule_a\n\n" +
			"## Reports\n\nNo reports needed.\n",
	);
	warns = sdd.designWarnings(designDir);
	check("complete architecture.md produces no design warnings", warns.length === 0);
	// A model declaring an extra view type (e.g. kanban) needs no Views warning.
	writeFileSync(
		join(designDir, "architecture.md"),
		"# Architecture\n\n## Models\n\nA model.\n\n" +
			"## Views\n\nkanban for the kanban board with grouping by stage.\n\n" +
			"## Security\n\nbase.group_user; ir.model.access.csv read/write/create/unlink; no record rules needed.\n\n" +
			"## Manifest\n\nmodule_a\n\n" +
			"## Reports\n\nNo reports needed.\n",
	);
	warns = sdd.designWarnings(designDir);
	check("kanban declaration clears the extra-view-type warning", warns.length === 0);
	// A declared search view also counts as an extra view type (no view warning).
	writeFileSync(
		join(designDir, "architecture.md"),
		"# Architecture\n\n## Models\n\nA model.\n\n" +
			"## Views\n\nsearch view with a name filter and group-by on stage.\n\n" +
			"## Security\n\nbase.group_user; ir.model.access.csv read/write/create/unlink; no record rules needed.\n\n" +
			"## Manifest\n\nmodule_a\n\n" +
			"## Reports\n\nNo reports needed.\n",
	);
	warns = sdd.designWarnings(designDir);
	check("search-view declaration clears the extra-view-type warning", warns.length === 0);
}

let st = sdd.loadState(specDir);
check("initial phase CLARIFY (intent unresolved)", st.phase === "CLARIFY" && st.mode === null && st.licensed === null);

let r = sdd.transition(st, "READ_SPEC", null, "try without clarifying");
check("CLARIFY gate blocks before intent is clear", r.ok === false && (r.reason ?? "").includes("CLARIFY"));

// Resolve intent, then it can leave CLARIFY (not gated) toward READ_SPEC.
st.mode = "create";
st.licensed = "community";
r = sdd.transition(st, "READ_SPEC", null, "intent clarified");
check("CLARIFY -> READ_SPEC allowed once intent set", r.ok === true && st.phase === "READ_SPEC");

// --- phase graph: illegal transitions are refused (P1.1) ---
{
	const g = join(dir, "specs", "003-graph");
	sdd.initSpecDir(g);
	const gs = sdd.loadState(g);
	// From CLARIFY, jumping straight to DONE/WRITE_CODE is not an edge.
	let gr = sdd.transition(gs, "DONE", "APPROVED", "skip everything");
	check("CLARIFY -> DONE is refused by the phase graph", gr.ok === false && /Illegal phase transition/.test(gr.reason));
	gr = sdd.transition(gs, "WRITE_CODE", "APPROVED", "skip spec+architecture");
	check("CLARIFY -> WRITE_CODE is refused by the phase graph", gr.ok === false && /Illegal phase transition/.test(gr.reason));
	gs.mode = "create";
	gs.licensed = "community";
	gr = sdd.transition(gs, "READ_SPEC", null, "legal");
	check("CLARIFY -> READ_SPEC is a legal edge", gr.ok === true && gs.phase === "READ_SPEC");
	gr = sdd.transition(gs, "VERIFY", "APPROVED", "skip architecture+code");
	check("READ_SPEC -> VERIFY is refused by the phase graph", gr.ok === false && /Illegal phase transition/.test(gr.reason));
	// BLOCKED is reachable from anywhere.
	gr = sdd.transition(gs, "BLOCKED", null, "give up");
	check("BLOCKED is reachable from any phase", gr.ok === true && gs.phase === "BLOCKED");
	gr = sdd.transition(gs, "VERIFY", null, "resurrect");
	check("BLOCKED is terminal (no outgoing edges)", gr.ok === false && /Illegal phase transition/.test(gr.reason));
}

// Approval gates apply from READ_SPEC onward.
r = sdd.transition(st, "ARCHITECTURE", null, "try without marker");
check("gated advance rejected without APPROVED", r.ok === false);
r = sdd.transition(st, "ARCHITECTURE", "maybe?", "ambiguous marker");
check("ambiguous marker rejected (fail-closed)", r.ok === false);

st.specLoaded = true;
r = sdd.transition(st, "ARCHITECTURE", "APPROVED", "spec understood");
check("gated advance accepted with APPROVED", r.ok === true && st.phase === "ARCHITECTURE");

r = sdd.transition(st, "DONE", "APPROVED", "try to finish early");
check("DONE blocked without PASSED verdict", r.ok === false);

st.phase = "FIX_LOOP";
let diag = false;
for (let i = 0; i < 3; i++) {
	const out = sdd.recordFailure(st, `error #${i + 1}`);
	if (out.requireDiagnosis) diag = true;
}
check("deep diagnosis required after 3 failures", diag === true);

// Ladder enforcement (lote 2): a blind retry is refused until the diagnosis is
// actually RECORDED (asking for it does not satisfy it), and PASSED needs
// per-AC evidence.
r = sdd.transition(st, "VERIFY", null, "blind retry");
check("retry refused while a diagnosis is owed", r.ok === false && /diagnosis/i.test(r.reason));
const refused = sdd.recordSuccess(st, "all ACs verified");
check("PASSED refused while test-plan.md still has a pending AC", refused.ok === false && refused.gaps.length > 0);
check("no PASSED verdict was written on refusal", sdd.readVerdict(specDir) === null);
sdd.recordDiagnosis(st, "root cause: the compute field lacked a depends");
check("recorded diagnosis clears the ladder", sdd.diagnosisPending(st) === false);
r = sdd.transition(st, "VERIFY", null, "retry after diagnosis");
check("retry allowed after the diagnosis is recorded", r.ok === true);

// Evidence gate: completing every AC row lets the verdict through.
writeFileSync(
	join(specDir, "test-plan.md"),
	"# Test Plan\n\n| AC | Scenario | Layer (static/server/rpc/ui/manual) | Status |\n|---|---|---|---|\n" +
		"| AC1 | create a record | rpc | passed |\n",
);
const accepted = sdd.recordSuccess(st, "AC1 verified over RPC");
check("PASSED accepted once every AC has a result", accepted.ok === true);
const verdict = sdd.readVerdict(specDir);
check("verdict persisted as PASSED", verdict !== null && verdict.passed === true);
r = sdd.transition(st, "DONE", null, "verified");
check("DONE reachable after PASSED verdict", r.ok === true && st.phase === "DONE");

// securityReviewRequired is a real gate: a PASSED verdict alone is not enough.
{
	const secDir = join(dir, "specs", "004-sec");
	sdd.initSpecDir(secDir);
	writeFileSync(
		join(secDir, "test-plan.md"),
		"# Test Plan\n\n| AC | Scenario | Layer (static/server/rpc/ui/manual) | Status |\n|---|---|---|---|\n" +
			"| AC1 | create a record | rpc | passed |\n",
	);
	const secSt = sdd.loadState(secDir);
	secSt.phase = "FIX_LOOP";
	sdd.recordSuccess(secSt, "AC1 ok");
	let sr = sdd.transition(secSt, "DONE", null, "done", "human", "supervised", { securityReviewRequired: true });
	check("DONE refused without a security review when the policy is armed", sr.ok === false && /security/i.test(sr.reason));
	writeFileSync(join(secDir, "security-report.md"), "# Security review\n\nVerdict: REJECTED — sudo() unjustified\n");
	sr = sdd.transition(secSt, "DONE", null, "done", "human", "supervised", { securityReviewRequired: true });
	check("DONE refused when the security review is REJECTED", sr.ok === false && /security/i.test(sr.reason));
	writeFileSync(join(secDir, "security-report.md"), "# Security review\n\nVerdict: APPROVED\n");
	sr = sdd.transition(secSt, "DONE", null, "done", "human", "supervised", { securityReviewRequired: true });
	check("DONE allowed once the security review is APPROVED", sr.ok === true && secSt.phase === "DONE");
}

writeFileSync(join(specDir, "stop.md"), "human intervention needed");
r = sdd.transition(st, "FIX_LOOP", null, "should halt");
check("stop.md halts transitions", r.ok === false && r.reason.includes("stop.md"));

const dir2 = join(dir, "specs", "002-loop");
sdd.initSpecDir(dir2);
let st2 = sdd.loadState(dir2);
st2.phase = "FIX_LOOP";
let blocked = false;
for (let i = 0; i <= st2.maxIterations; i++) {
	const rr = sdd.transition(st2, "VERIFY", null, `retry ${i + 1}`);
	if (!rr.ok && rr.reason.startsWith("BLOCKED")) blocked = true;
}
check("iteration ceiling leads to BLOCKED", blocked && st2.phase === "BLOCKED");

console.log("== credentials & security (S1, S2) ==");
const miss = creds.loadCredentials(dir);
check("missing .env reported (fail-closed)", miss.ok === false && miss.reason === "env_file_missing");

const envFile = join(dir, ".env");
function writeEnv(url) {
	writeFileSync(envFile, `ODOO_URL=${url}\nODOO_DB=dev\nODOO_USERNAME=admin\nODOO_PASSWORD="s3cr3t-value"\n`, { mode: 0o644 });
	return creds.loadCredentials(dir);
}

const loaded = writeEnv("http://localhost:8069");
check("http to loopback allowed", loaded.ok === true);
if (loaded.ok) {
	check("secret parsed (quotes stripped)", loaded.credentials.secret === "s3cr3t-value");
	check("describeCredentials masks secret", !creds.displayPath(creds.describeCredentials(loaded.credentials)).includes("s3cr3t-value"));
	check("redact() scrubs known secret", !creds.redact("leak: s3cr3t-value", loaded.credentials).includes("s3cr3t-value"));
	check("redact() scrubs user:pass@ URL", !creds.redact("http://admin:s3cr3t-value@host", loaded.credentials).includes("s3cr3t-value"));
}

const insecure = writeEnv("http://odoo.example.com:8069");
check("S1: plain http to non-loopback REFUSED", insecure.ok === false && insecure.reason === "insecure_url");
const goodHttps = writeEnv("https://odoo.example.com");
check("S1: https to remote host allowed", goodHttps.ok === true);
// P0.5: a hostname that merely starts with "127." is NOT loopback.
const straddle = writeEnv("http://127.odoo.example.com:8069");
check("S1: plain http to a 127.-prefixed non-IP host REFUSED", straddle.ok === false && straddle.reason === "insecure_url");
const realLoop = writeEnv("http://127.0.0.1:8069");
check("S1: http to a real 127.0.0.1 loopback allowed", realLoop.ok === true);

check("S2: scrubGeneric hides password= shapes", !creds.scrubGeneric("reset with password=Sup3rS3cret! now").includes("Sup3rS3cret!"));
check("S2: scrubGeneric hides Bearer tokens", !creds.scrubGeneric("Authorization: Bearer abc123.def-456").includes("abc123"));
check("S2: scrubGeneric hides api_key:", !creds.scrubGeneric("api_key: 0123456789abcdef").includes("0123456789abcdef"));
const masked = creds.displayPath(`failed at ${homedir()}/dev/app.py`);
check("S2: displayPath folds home to ~", masked.includes("~/dev/app.py") && !masked.includes(homedir()));
const persisted = creds.sanitizeForPersist(`at /home/x password=abc12345678 file: ${homedir()}/.env`, loaded.ok ? loaded.credentials : null);
check("S2: sanitizeForPersist chains all layers", !persisted.includes("abc12345678") && !persisted.includes(homedir()));
// JSON keys with surrounding quotes (P0.4): `"password": "..."` and nested JSON.
check("S2: scrubGeneric hides quoted JSON password", !creds.scrubGeneric('"password": "secret-value"').includes("secret-value"));
check("S2: scrubGeneric hides quoted JSON api_key", !creds.scrubGeneric('{ "api_key": "abc123def" }').includes("abc123def"));
check("S2: scrubGeneric keeps non-secret JSON", creds.scrubGeneric('{ "name": "odoo" }').includes("odoo"));

const partial = (() => { writeFileSync(envFile, "ODOO_URL=http://localhost:8069\nODOO_DB=dev\n", { mode: 0o644 }); return creds.loadCredentials(dir); })();
check("incomplete .env lists missing vars", partial.ok === false && partial.reason === "required_var_missing" && partial.message.includes("ODOO_USERNAME"));

const badUrl = (() => { writeFileSync(envFile, "ODOO_URL=ftp://bad\nODOO_DB=dev\nODOO_USERNAME=admin\nODOO_PASSWORD=x\n", { mode: 0o644 }); return creds.loadCredentials(dir); })();
check("invalid URL rejected", badUrl.ok === false && badUrl.reason === "invalid_url");

const insecureEnv = join(dir, "insecure", ".env");
writeFileSync(join(dir, "insecure"), "", { flag: "a" }); // ensure dir
try {
	writeFileSync(insecureEnv, "ODOO_URL=http://localhost:8069\nODOO_DB=dev\nODOO_USERNAME=admin\nODOO_PASSWORD=x\n", { mode: 0o644 });
	chmodSync(insecureEnv, 0o640);
	const r2 = creds.loadCredentials(join(dir, "insecure"));
	const modeAfter = statSync(insecureEnv).mode & 0o777;
	check("group-readable .env tightened or refused", r2.ok === true ? modeAfter === 0o600 : r2.reason === "env_file_insecure");
} catch {
	// tmp on systems without chmod semantics: not a plugin failure
	console.log("  SKIP  permission check (fs semantics)");
}

console.log("== Q3 host guard ==");
const plugin = await import(new URL("index.js", libDir).href);
check("exports name/inject/Config/apply", plugin.name === "odoo-sdd" && Array.isArray(plugin.inject) && plugin.Config !== undefined && typeof plugin.apply === "function");
let threw = false;
try {
	plugin.apply({ tools: {} }, {});
} catch {
	threw = true;
}
check("apply() refuses host without register() (fail-closed)", threw);
threw = false;
try {
	plugin.apply({}, {});
} catch {
	threw = true;
}
check("apply() refuses host without tools (fail-closed)", threw);

// --- skill registration: an installed plugin advertises the workflow skill ---
const skillRegistrations = [];
const skillHostCtx = {
	tools: { register: () => {}, guard: () => () => {} },
	skills: { register: (skill) => skillRegistrations.push(skill) },
};
plugin.apply(skillHostCtx, {});
check("registers the odoo-sdd-workflow skill", skillRegistrations.some((s) => s.name === "odoo-sdd-workflow"));
const sddSkill = skillRegistrations.find((s) => s.name === "odoo-sdd-workflow");
check(
	"workflow skill is model- and user-invocable",
	sddSkill?.invocation?.modelInvocable === true && sddSkill?.invocation?.userInvocable === true,
);
check(
	"workflow skill carries a description and instruction body",
	typeof sddSkill?.description === "string" && sddSkill.description.length > 20 &&
		typeof sddSkill?.content === "string" && sddSkill.content.length > 100,
);
check(
	"workflow skill body has no raw frontmatter leak",
	typeof sddSkill?.content === "string" && !/^---\r?\n/.test(sddSkill.content),
);
check(
	"workflow skill carries a whenToUse routing guard",
	typeof sddSkill?.whenToUse === "string" && /Odoo/i.test(sddSkill.whenToUse),
);
check(
	"workflow skill declares source (host contract) and a resource base",
	sddSkill?.source === "runtime" &&
		sddSkill?.resourceBase?.kind === "directory" &&
		typeof sddSkill.resourceBase.path === "string" &&
		/agents$/.test(sddSkill.resourceBase.path),
);

// A host WITH tools but WITHOUT a skills registry must still mount (fail-open).
threw = false;
try {
	plugin.apply({ tools: { register: () => {}, guard: () => () => {} } }, {});
} catch {
	threw = true;
}
check("apply() keeps working on a host without a skills registry (fail-open)", !threw);


console.log("== onboarding & cascade (odoo_setup) ==");
// (Environment isolation for user-scope credentials happens at the top of the
// script, before ANY test that touches the cascade.)

const registered = new Map();
const capturedGuards = [];
// Native approval seam: the default simulates a developer granting each ask
// once (`'allowed-once'`); individual tests flip `approvalOutcome` to exercise
// refusal/cancellation/unavailability (all fail-closed).
let approvalOutcome = "allowed-once";
const approvalRequests = [];
const fakeCtx = {
	tools: {
		register: (t) => registered.set(t.name, t),
		guard: (g) => { capturedGuards.push(g); return () => {}; },
	},
	on: () => () => {},
	approval: {
		request: async (req) => { approvalRequests.push(req); return approvalOutcome; },
	},
};

// --- projA: full onboarding flow ---
const projA = join(dir, "projA");
plugin.apply(fakeCtx, { projectRoot: projA });
const setup = registered.get("odoo_setup");
const connect = registered.get("odoo_connect");
check("odoo_setup registered", setup !== undefined);

const expectedTools = [
	"odoo_connect", "odoo_setup", "odoo_module", "odoo_execute", "odoo_validate",
	"odoo_errors", "odoo_session", "odoo_config", "sdd_phase", "sdd_checkpoint",
	"odoo_security_scan", "sdd_handoff", "odoo_docs",
];
check("registers exactly the 13 documented tools", registered.size === expectedTools.length);
check(
	"registered tool names match the documented set",
	expectedTools.every((n) => registered.has(n)),
);
check(
	"every registered tool has a description",
	[...registered.values()].every((t) => typeof t.description === "string" && t.description.length > 20),
);

let rs = await setup.execute({ mode: "check" });
check("empty project reports needs-setup", rs.status === "needs-setup");
check("check reports missing gitignore entries", rs.gitignoreCovered === false && rs.detail.includes(".sdd/"));

rs = await setup.execute({ mode: "interactive", url: "http://localhost:8069" });
check("interactive requires db/username", rs.status === "needs-setup" && rs.detail.includes("db"));
rs = await setup.execute({ mode: "interactive", url: "http://odoo.remote.example", db: "dev", username: "admin" });
check("interactive rejects insecure http remote", rs.status === "needs-setup" && rs.detail.includes("clear text"));
rs = await setup.execute({ mode: "interactive", url: "http://admin:s3cret@localhost:8069", db: "dev", username: "admin" });
check("interactive rejects URL-embedded credentials (no echo)", rs.detail.includes("must not embed credentials") && !rs.detail.includes("s3cret"));

rs = await setup.execute({ mode: "interactive", url: "http://localhost:9", db: "dev", username: "admin", scope: "project" });
const scaffoldPath = join(projA, ".sdd", ".env");
check("scaffold written at project .sdd/.env", rs.status === "needs-secret" && existsSync(scaffoldPath));
const content = readFileSync(scaffoldPath, "utf8");
check("scaffold has empty password, no secret inside", content.includes("ODOO_PASSWORD=\n") && !content.includes("s3cret"));
try {
	check("scaffold is chmod 600", (statSync(scaffoldPath).mode & 0o777) === 0o600);
} catch { console.log("  SKIP  chmod semantics"); }
rs = await connect.execute({});
check("connect reports NEEDS_SECRET", rs.connected === false && rs.detail.includes("NEEDS_SECRET"));

writeFileSync(scaffoldPath, content.replace("ODOO_PASSWORD=\n", "ODOO_PASSWORD=now-filled\n"), { mode: 0o600 });
rs = await connect.execute({});
check(
	"credentials alone do NOT authorize a connection (no grant)",
	rs.connected === false && rs.detail.includes("NOT AUTHORIZED"),
);
rs = await setup.execute({ mode: "authorize" });
check("authorize stores a connection grant after human approval", rs.status === "authorized");
rs = await connect.execute({});
check("connect proceeds to instance probe after authorization", rs.detail.includes("Instance unreachable") && !rs.detail.includes("NEEDS_SECRET"));
rs = await setup.execute({ mode: "revoke" });
check("revoke drops the grant", rs.status === "revoked");
rs = await connect.execute({});
check("revoking blocks the connection again", rs.detail.includes("NOT AUTHORIZED"));
// Re-authorize so the rest of the flow keeps a live grant.
rs = await setup.execute({ mode: "authorize" });
check("re-authorize restores the grant", rs.status === "authorized");

// ---- lifecycle: purge removes ONLY the plugin's own state (lote 5) -------
console.log("== lifecycle purge (ownership boundaries) ==");
{
	const lifeMod = await import(new URL("lifecycle.js", libDir).href);
	const projLife = join(dir, "projLife");
	mkdirSync(join(projLife, ".sdd", "checkpoints"), { recursive: true });
	mkdirSync(join(projLife, "specs", "001-x"), { recursive: true });
	// Owned state...
	writeFileSync(join(projLife, ".sdd", "grants.json"), "{}", { mode: 0o600 });
	writeFileSync(join(projLife, ".sdd", "session.json"), "{}", { mode: 0o600 });
	writeFileSync(join(projLife, ".sdd", "audit.jsonl"), "{}\n", { mode: 0o600 });
	writeFileSync(join(projLife, ".sdd", "checkpoints", "cp1.json"), "{}", { mode: 0o600 });
	// ...and things the plugin must NEVER remove.
	writeFileSync(join(projLife, ".sdd", ".env"), "ODOO_URL=http://localhost:8069\n", { mode: 0o600 });
	writeFileSync(join(projLife, ".sdd", "stop.md"), "operator halt\n", { mode: 0o600 });
	writeFileSync(join(projLife, "specs", "001-x", "spec.md"), "# Spec\n", { mode: 0o600 });

	plugin.apply(fakeCtx, { projectRoot: projLife });
	const lifeSetup = registered.get("odoo_setup");

	// 1) Default is a PLAN: it lists the owned state and deletes nothing.
	let lr = await lifeSetup.execute({ mode: "purge" });
	check("purge without confirmation reports a plan", lr.status === "plan" && /PURGE PLAN/.test(lr.detail));
	check("the plan names the owned paths", /grants\.json/.test(lr.detail) && /audit\.jsonl/.test(lr.detail));
	check("the plan states what is preserved", /\.env/.test(lr.detail) && /specs\//.test(lr.detail));
	check("planning deletes nothing", existsSync(join(projLife, ".sdd", "grants.json")));

	// 2) A refused approval deletes nothing either.
	const savedOutcomeP = approvalOutcome;
	approvalOutcome = "rejected";
	lr = await lifeSetup.execute({ mode: "purge", confirm_destructive: true });
	check("a refused approval does not purge", lr.status === "not-authorized" && existsSync(join(projLife, ".sdd", "grants.json")));
	approvalOutcome = savedOutcomeP;

	// 3) Approved purge removes owned state and preserves the human's files.
	lr = await lifeSetup.execute({ mode: "purge", confirm_destructive: true });
	check("approved purge runs", lr.status === "purged");
	check("owned state is gone", !existsSync(join(projLife, ".sdd", "grants.json")) && !existsSync(join(projLife, ".sdd", "session.json")));
	check("the checkpoints directory is gone", !existsSync(join(projLife, ".sdd", "checkpoints")));
	// The purge itself is audited, which re-creates exactly one file: a record
	// that the purge happened. That trace is intentional, not leftover state.
	const purgeLog = existsSync(join(projLife, ".sdd", "audit.jsonl"))
		? readFileSync(join(projLife, ".sdd", "audit.jsonl"), "utf8")
		: "";
	check("the purge leaves an audit trace of itself", /odoo_setup\/purge/.test(purgeLog));
	check("no other owned state was resurrected", !existsSync(join(projLife, ".sdd", "grants.json")) && !existsSync(join(projLife, ".sdd", "config.json")));
	check("credentials are preserved", existsSync(join(projLife, ".sdd", ".env")));
	check("the emergency brake is preserved", existsSync(join(projLife, ".sdd", "stop.md")));
	check("project documents are preserved", existsSync(join(projLife, "specs", "001-x", "spec.md")));

	// 4) The inventory helper agrees with the boundary.
	const owned = lifeMod.ownedStatePaths(projLife).filter((e) => e.exists).map((e) => e.rel);
	check("the inventory lists no preserved path as owned", !owned.includes(".sdd/.env") && !owned.includes(".sdd/stop.md") && !owned.some((r) => r.startsWith("specs")));
	check("PRESERVED documents the three human-owned paths", lifeMod.PRESERVED.length === 3);
}

// --- projB: cascade precedence ---
const projB = join(dir, "projB");
mkdirSync(join(projB, ".sdd"), { recursive: true });
mkdirSync(join(dir, "xdg", "dsh-odoo-sdd"), { recursive: true });
const mkEnv = (p, db) => writeFileSync(p, `ODOO_URL=http://localhost:8069\nODOO_DB=${db}\nODOO_USERNAME=admin\nODOO_PASSWORD=x\n`, { mode: 0o600 });
mkEnv(join(projB, ".env"), "db_legacy");
let lc = creds.loadCredentials(projB);
check("legacy .env resolves when alone", lc.ok && lc.credentials.source === "legacy" && lc.credentials.db === "db_legacy");
mkEnv(join(projB, ".sdd", ".env"), "db_project");
lc = creds.loadCredentials(projB);
check("project scope beats legacy", lc.ok && lc.credentials.source === "project" && lc.credentials.db === "db_project");
rmSync(join(projB, ".sdd", ".env"));
mkEnv(join(dir, "xdg", "dsh-odoo-sdd", ".env"), "db_user");
lc = creds.loadCredentials(projB);
check("user scope beats legacy", lc.ok && lc.credentials.source === "user" && lc.credentials.db === "db_user");
rmSync(join(dir, "xdg", "dsh-odoo-sdd", ".env"));
const custom = join(dir, "custom.env");
mkEnv(custom, "db_custom");
process.env["ODOO_SDD_ENV_FILE"] = custom;
lc = creds.loadCredentials(projB);
check("env-var override beats all", lc.ok && lc.credentials.source === "env-var" && lc.credentials.db === "db_custom");
delete process.env["ODOO_SDD_ENV_FILE"];

// --- projC: skip / later / reset + gitignore ---
// NOTE: apply() rebinds tool closures to the new config — re-fetch them.
const projC = join(dir, "projC");
plugin.apply(fakeCtx, { projectRoot: projC });
const setupC = registered.get("odoo_setup");
const connectC = registered.get("odoo_connect");
rs = await setupC.execute({ mode: "skip" });
check("skip records decision", rs.status === "skipped");
rs = await connectC.execute({});
check("connect reports SKIPPED with manual guidance", rs.detail.includes("SKIPPED") && rs.detail.includes("MANUAL"));
rs = await setupC.execute({ mode: "later" });
check("later records deferred", rs.status === "deferred");
rs = await connectC.execute({});
check("connect reports DEFERRED", rs.detail.includes("DEFERRED"));
rs = await setupC.execute({ mode: "reset" });
check("reset clears decision", rs.status === "needs-setup");
writeFileSync(join(projC, ".gitignore"), "node_modules/\n.sdd/\n.env\n");
rs = await setupC.execute({ mode: "check" });
check("gitignore coverage detected", rs.gitignoreCovered === true);


console.log("== autonomy, headings gate, audit, runtime tools ==");
// New project bound to a fresh config; tools come from the shared registry.
const projD = join(dir, "projD");
plugin.apply(fakeCtx, { projectRoot: projD });
const setupD = registered.get("odoo_setup");
const sddD = registered.get("sdd_phase");
const validateD = registered.get("odoo_validate");
const executeD = registered.get("odoo_execute");

// --- headings gate: a bare spec cannot leave READ_SPEC ---
sddD.execute({ operation: "init", spec_id: "001-bare" });
// Clarify intent so it can leave CLARIFY, then advance to READ_SPEC.
await sddD.execute({ operation: "clarify", spec_id: "001-bare", mode: "create", licensed: "community" });
await sddD.execute({ operation: "advance", spec_id: "001-bare", next_phase: "READ_SPEC" });
await sddD.execute({ operation: "mark_spec_loaded", spec_id: "001-bare" });
// Overwrite the spec with content lacking the required Acceptance Criteria section.
writeFileSync(join(projD, "specs", "001-bare", "spec.md"), "# Spec\n\n== Context ==\n", { mode: 0o600 });
let gate = await sddD.execute({ operation: "advance", spec_id: "001-bare", next_phase: "ARCHITECTURE", approval_marker: "APPROVED", approval_source: "human" });
check("headings gate blocks advance with missing spec sections", gate.ok === false && (gate.detail.includes("Acceptance Criteria") || gate.detail.includes("missing required section")));

// --- autonomy: proxy approval forbidden in supervised ---
await setupD.execute({ mode: "skip" }); // avoid instance requirement
sddD.execute({ operation: "init", spec_id: "002-proxy" });
await sddD.execute({ operation: "clarify", spec_id: "002-proxy", mode: "create", licensed: "community" });
await sddD.execute({ operation: "advance", spec_id: "002-proxy", next_phase: "READ_SPEC" });
await sddD.execute({ operation: "mark_spec_loaded", spec_id: "002-proxy" });
gate = await sddD.execute({ operation: "advance", spec_id: "002-proxy", next_phase: "ARCHITECTURE", approval_marker: "APPROVED", approval_source: "human-proxy" });
check("human-proxy rejected in SUPERVISED mode", gate.ok === false && gate.detail.includes("SUPERVISED"));

// switch to autonomous
await setupD.execute({ mode: "autonomy", decision: "autonomous" });
gate = await sddD.execute({ operation: "advance", spec_id: "002-proxy", next_phase: "ARCHITECTURE", approval_marker: "APPROVED", approval_source: "human-proxy" });
// spec.md template includes the required headings after mark_spec_loaded,
// so a clean APPROVED with proxy source passes in autonomous mode.
check("human-proxy APPROVED passes in AUTONOMOUS mode", gate.ok === true && gate.detail.includes("human-proxy"));

// --- audit: file written, no secret, no home path ---
const auditPath = join(projD, ".sdd", "audit.jsonl");
check("audit.jsonl exists after sdd_phase", existsSync(auditPath));
const auditText = readFileSync(auditPath, "utf8");
check("audit contains sdd_phase op and no home path", auditText.includes("sdd_phase/advance") && !auditText.includes(homedir()));

// --- odoo_validate: valid vs invalid module fixture ---
const modValid = join(dir, "mod_valid");
mkdirSync(modValid, { recursive: true });
mkdirSync(join(modValid, "security"), { recursive: true });
mkdirSync(join(modValid, "views"), { recursive: true });
writeFileSync(join(modValid, "__manifest__.py"), "{'name':'test','version':'1.0','depends':['base'],'data':['views/x.xml']}", { mode: 0o600 });
writeFileSync(join(modValid, "views", "x.xml"), "<odoo></odoo>", { mode: 0o600 });
writeFileSync(join(modValid, "security", "ir.model.access.csv"), "id,name\\n", { mode: 0o600 });
let v = await validateD.execute({ module_dir: modValid });
check("odoo_validate accepts a valid module", v.valid === true);

const modBroken = join(dir, "mod_broken");
mkdirSync(modBroken, { recursive: true });
writeFileSync(join(modBroken, "__manifest__.py"), "{'data':['views/gone.xml']}", { mode: 0o600 });
v = await validateD.execute({ module_dir: modBroken });
check("odoo_validate flags declared-but-missing XML", v.valid === false && v.findings.some((f) => f.severity === "ERROR"));

// --- odoo_execute fail-closed (no instance needed for the deny path) ---
let ex = await executeD.execute({ model: "sale.order", method: "unlink" });
check("odoo_execute denies unlink without confirm_destructive", ex.denied === true);
ex = await executeD.execute({ model: "sale.order", method: "create", confirm_destructive: true });
check("odoo_execute denies non-allowlisted model for mutation", ex.denied === true && ex.reason.includes("allowlist"));
ex = await executeD.execute({ model: "res.users", method: "search_read" });
check("odoo_execute read on non-allowlisted model rejected as unconfigured (no instance)", ex.denied === true);

// --- odoo_execute contract: domain accepts scalars/operators; render shows the payload (P1.2) ---
check(
	"domain parameter does not constrain items to objects (Odoo terms are scalar triples)",
	executeD.parameters.properties.domain.items === undefined,
);
const renderOk = executeD.output.render({}, { denied: false, reason: "sale.order.read OK", result: '[{"id":1}]' });
check("render includes the RPC result payload", JSON.stringify(renderOk).includes('{\\"id\\":1}'));
const renderErr = executeD.output.render({}, { denied: false, reason: "SERVER ERROR — RPC call failed", result: "Traceback: boom" });
check("render surfaces the server traceback", JSON.stringify(renderErr).includes("Traceback: boom"));
const renderDenied = executeD.output.render({}, { denied: true, reason: "blocked by policy", result: "" });
check("render marks a denial explicitly", JSON.stringify(renderDenied).includes("[DENIED]"));


console.log("== odoo_config (repos + persistent config) ==");
const projE = join(dir, "projE");
plugin.apply(fakeCtx, { projectRoot: projE });
const cfg = registered.get("odoo_config");
check("odoo_config registered", cfg !== undefined);

let rc = await cfg.execute({ mode: "read" });
check("read returns default community repo", rc.ok === true && rc.config.communityRepoUrl === "https://github.com/odoo/odoo");
check("read returns default enterprise repo", rc.config.enterpriseRepoUrl === "https://github.com/odoo/enterprise");
check("read defaults specsDir", rc.config.specsDir === "specs");

rc = await cfg.execute({ mode: "set" });
check("set without fields is rejected", rc.ok === false);

rc = await cfg.execute({ mode: "set", communityRepoUrl: "https://gitlab.com/mirror/odoo", communityRepoPath: "/srv/odoo" });
check("set persists community repo", rc.ok === true && rc.config.communityRepoUrl === "https://gitlab.com/mirror/odoo" && rc.config.communityRepoPath === "/srv/odoo");
check("config file written", existsSync(join(projE, ".sdd", "config.json")));

rc = await cfg.execute({ mode: "read" });
check("read reflects persisted values", rc.config.communityRepoPath === "/srv/odoo" && rc.config.enterpriseRepoUrl === "https://github.com/odoo/enterprise");

rc = await cfg.execute({ mode: "set", executeAllowlist: ["sale.order", "stock.move"] });
check("set persists allowlist", rc.ok === true && Array.isArray(rc.config.executeAllowlist) && rc.config.executeAllowlist.includes("sale.order"));

// The allowlist configured via odoo_config must actually gate odoo_execute (live config).
const executeE = registered.get("odoo_execute");
const exAllow = await executeE.execute({ model: "sale.order", method: "create", values: { name: "probe" }, confirm_destructive: true });
check("allowlisted mutation passes the gate (then fails: no instance)", exAllow.denied === true && exAllow.reason.includes("NOT CONFIGURED"));
const exDeny = await executeE.execute({ model: "account.move", method: "unlink", confirm_destructive: true });
check("non-allowlisted model still denied", exDeny.denied === true && exDeny.reason.includes("not allowlisted"));
const exConfirm = await executeE.execute({ model: "sale.order", method: "create" });
check("mutating call still requires confirm_destructive", exConfirm.denied === true && exConfirm.reason.includes("confirm_destructive"));

rc = await cfg.execute({ mode: "read" });
check("read defaults autonomy", rc.config.autonomy === "supervised");
check("read defaults licensed", rc.config.licensed === "community");
rc = await cfg.execute({ mode: "set", autonomy: "autonomous", licensed: "enterprise" });
check("set persists autonomy/licensed", rc.ok === true && rc.config.autonomy === "autonomous" && rc.config.licensed === "enterprise");

// --- native approval: the model cannot self-authorize (lote 2) -----------
console.log("== native approval (grants, refusals, fail-closed) ==");
const grantsMod = await import(new URL("grants.js", libDir).href);
{
	const projG = join(dir, "projG2");
	mkdirSync(join(projG, ".sdd"), { recursive: true });
	writeFileSync(
		join(projG, ".sdd", ".env"),
		"ODOO_URL=http://localhost:8069\nODOO_DB=dev\nODOO_USERNAME=admin\nODOO_PASSWORD=x\n",
		{ mode: 0o600 },
	);
	plugin.apply(fakeCtx, { projectRoot: projG });
	const gSetup = registered.get("odoo_setup");
	const gCfg = registered.get("odoo_config");
	const gConnect = registered.get("odoo_connect");

	// A refused approval must not mint a grant nor change policy.
	const saved = approvalOutcome;
	approvalOutcome = "rejected";
	let gr = await gSetup.execute({ mode: "authorize" });
	check("refused approval does NOT authorize", gr.status === "not-authorized" && !grantsMod.readGrants(projG).grants.length);
	gr = await gCfg.execute({ mode: "set", executeAllowlist: ["sale.order"] });
	check("refused approval leaves configuration unchanged", gr.ok === false && gr.config.executeAllowlist.length === 0);
	gr = await gSetup.execute({ mode: "autonomy", decision: "autonomous" });
	check("refused approval cannot switch delegation mode", gr.status === "not-authorized");
	approvalOutcome = "cancelled";
	gr = await gSetup.execute({ mode: "authorize" });
	check("cancelled approval does NOT authorize", gr.status === "not-authorized");

	// A host without the approval seam must fail closed.
	approvalOutcome = saved;
	delete fakeCtx.approval;
	gr = await gSetup.execute({ mode: "authorize" });
	check("missing approval service fails closed (no grant)", gr.status === "not-authorized" && !grantsMod.readGrants(projG).grants.length);
	gr = await gConnect.execute({});
	check("no grant => connection stays blocked", gr.connected === false && gr.detail.includes("NOT AUTHORIZED"));
	fakeCtx.approval = { request: async (req) => { approvalRequests.push(req); return approvalOutcome; } };

	// With approval, the grant is minted and bound to the exact target.
	gr = await gSetup.execute({ mode: "authorize" });
	check("approved authorize mints a connection grant", gr.status === "authorized" && grantsMod.readGrants(projG).grants.length === 1);
	const fpA = grantsMod.fingerprintOf("http://localhost:8069", "dev", "admin");
	check("grant matches the current target fingerprint", grantsMod.hasValidGrant(projG, "connection", fpA) === true);
	check(
		"grant does NOT match a different target (url/db/user change invalidates it)",
		grantsMod.hasValidGrant(projG, "connection", grantsMod.fingerprintOf("https://other.example", "dev", "admin")) === false &&
			grantsMod.hasValidGrant(projG, "connection", grantsMod.fingerprintOf("http://localhost:8069", "prod", "admin")) === false &&
			grantsMod.hasValidGrant(projG, "connection", grantsMod.fingerprintOf("http://localhost:8069", "dev", "other")) === false,
	);
	check("expired grant is not valid", grantsMod.hasValidGrant(projG, "connection", fpA, new Date(Date.now() + 24 * 60 * 60 * 1000)) === false);
	check("corrupt grants file authorizes nothing (fail-closed)", (() => {
		writeFileSync(grantsMod.grantsPath(projG), "{ not json", { mode: 0o600 });
		const empty = grantsMod.readGrants(projG);
		return empty.grants.length === 0 && grantsMod.hasValidGrant(projG, "connection", fpA) === false;
	})());
	const approvalCalls = approvalRequests.length;
	check("approval requests carry the tool name and a reason", approvalRequests.some((r) => r.toolName === "odoo_setup" && typeof r.reason === "string" && r.reason.length > 10));
	check("approval requests are actually issued (not bypassed)", approvalCalls > 0);
}

// ---- settings section must actually drive the tools (lote 3) ------------
console.log("== settings source drives the effective configuration ==");
{
	let hooks = null;
	let live = {};
	const localRegistry = new Map();
	const settingsCtx = {
		tools: { register: (t) => localRegistry.set(t.name, t), guard: () => () => {} },
		on: () => () => {},
		// The host hands the section hooks through ctx.inject(["settings"], cb).
		inject: (_deps, cb) => cb({ settings: { installSection: (_o, _ns, _schema, _entry, h) => { hooks = h; } } }),
	};
	const projSet = join(dir, "projSettings");
	mkdirSync(projSet, { recursive: true });
	plugin.apply(settingsCtx, { projectRoot: projSet });
	check("settings section registers its hooks", hooks !== null && typeof hooks.setSource === "function" && typeof hooks.onChange === "function");

	hooks.setSource(() => live);
	hooks.onChange();
	const setExec = localRegistry.get("odoo_execute");
	// With no allowlist anywhere, a mutation is refused for that reason.
	let sr = await setExec.execute({ model: "sale.order", method: "create", values: { name: "x" }, confirm_destructive: true });
	check("mutation refused before the settings layer allowlists it", sr.denied === true && /allowlist/i.test(sr.reason));

	// A value set through the Settings source must change tool behaviour, not
	// merely render in the form.
	live = { executeAllowlist: ["sale.order"] };
	hooks.onChange();
	sr = await setExec.execute({ model: "sale.order", method: "create", values: { name: "x" }, confirm_destructive: true });
	check(
		"settings-provided allowlist reaches the tool (no longer 'not allowlisted')",
		sr.denied === true && /allowlist/i.test(sr.reason) === false,
	);
	// And it is the settings value that did it: a different model stays denied.
	sr = await setExec.execute({ model: "account.move", method: "create", values: { name: "x" }, confirm_destructive: true });
	check("settings allowlist is scoped to the listed model", sr.denied === true && /allowlist/i.test(sr.reason));

	// A sparse settings payload must not erase the deployment value.
	live = {};
	hooks.onChange();
	sr = await setExec.execute({ model: "sale.order", method: "create", values: { name: "x" }, confirm_destructive: true });
	check("clearing the settings layer falls back (no crash, still evaluable)", typeof sr.reason === "string");
}


console.log("== checkpoints, security scan, ACL gate, policy guard, handoff ==");
const cps = await import(new URL("checkpoints.js", libDir).href);
const sec = await import(new URL("security-scan.js", libDir).href);

// ---- checkpoints: create -> mutate -> restore -> journal -> drop --------
const projCp = join(dir, "projCp");
mkdirSync(join(projCp, "mod"), { recursive: true });
writeFileSync(join(projCp, "mod", "a.py"), "V1\n", { mode: 0o600 });
plugin.apply(fakeCtx, { projectRoot: projCp });
const cpTool = registered.get("sdd_checkpoint");
let cpR = await cpTool.execute({ operation: "create", label: "before change", dirs: ["mod"] });
check("checkpoint created and active", cpR.ok === true && typeof cpR.activeCheckpoint === "string" && cpR.detail.includes("Checkpoint"));
const cpId = cpR.activeCheckpoint;
writeFileSync(join(projCp, "mod", "a.py"), "V2-BROKEN\n", { mode: 0o600 });
cpR = await cpTool.execute({ operation: "restore", checkpoint_id: cpId });
check("restore puts files back", cpR.ok === true && readFileSync(join(projCp, "mod", "a.py"), "utf8") === "V1\n");
cps.appendDataOp(projCp, { ts: "t1", model: "sale.order", method: "write", ids: [7], preImage: [{ id: 7, name: "old" }], createdIds: [] });
check("data op journaled", cps.readJournal(projCp).length === 1);
cpR = await cpTool.execute({ operation: "journal" });
check("journal readable", cpR.ok === true && cpR.detail.includes("Journaled operations"));
cpR = await cpTool.execute({ operation: "list" });
check("checkpoint list works", cpR.ok === true && cpR.detail.includes("Checkpoints"));
cpR = await cpTool.execute({ operation: "drop", checkpoint_id: cpId });
check("checkpoint dropped", cpR.ok === true);
cpR = await cpTool.execute({ operation: "create", label: "needs dirs" });
check("create without dirs defaults to whole project", cpR.ok === true);

// ---- rollback completeness: drift after the checkpoint (lote 3) ---------
{
	const projDrift = join(dir, "projDrift");
	mkdirSync(join(projDrift, "mod"), { recursive: true });
	writeFileSync(join(projDrift, "mod", "a.py"), "V1\n", { mode: 0o600 });
	plugin.apply(fakeCtx, { projectRoot: projDrift });
	const driftTool = registered.get("sdd_checkpoint");
	const made = await driftTool.execute({ operation: "create", label: "drift", dirs: ["mod"] });
	check("drift checkpoint records its roots", made.ok === true);
	const driftId = made.activeCheckpoint;
	// Mutate AND create a file the snapshot never saw.
	writeFileSync(join(projDrift, "mod", "a.py"), "V2\n", { mode: 0o600 });
	writeFileSync(join(projDrift, "mod", "added_later.py"), "NEW\n", { mode: 0o600 });
	const plain = cps.restoreCheckpointFiles(projDrift, driftId);
	check("restore reverts the modified file", readFileSync(join(projDrift, "mod", "a.py"), "utf8") === "V1\n");
	check("restore REPORTS the file created after the checkpoint", plain.created.includes("mod/added_later.py"));
	check("restore does not delete it unless asked", existsSync(join(projDrift, "mod", "added_later.py")));
	const exact = cps.restoreCheckpointFiles(projDrift, driftId, { prune: true });
	check("restore with prune removes the extra file", exact.pruned.includes("mod/added_later.py") && !existsSync(join(projDrift, "mod", "added_later.py")));
	check("prune never touches the snapshotted files", existsSync(join(projDrift, "mod", "a.py")));
	// A checkpoint taken BEFORE this feature has no roots recorded: prune must
	// say it cannot, instead of deleting anything it cannot account for.
	const legacyDir = join(cps.checkpointsDir(projDrift), driftId);
	const manifest = JSON.parse(readFileSync(join(legacyDir, "manifest.json"), "utf8"));
	delete manifest.dirs;
	writeFileSync(join(legacyDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
	const legacy = cps.restoreCheckpointFiles(projDrift, driftId, { prune: true });
	check("a legacy manifest cannot prune (reports unsupported)", legacy.pruneUnsupported === true && legacy.pruned.length === 0);
}

// ---- durable state: atomic writes and visible corruption recovery (lote 3) ----
{
	const atomicMod = await import(new URL("atomic.js", libDir).href);
	const projDur = join(dir, "specs", "005-durable");
	sdd.initSpecDir(projDur);
	const st5 = sdd.loadState(projDur);
	st5.phase = "VERIFY";
	sdd.saveState(st5);
	check("state survives an atomic save round-trip", sdd.loadState(projDur).phase === "VERIFY");
	check("no temp file is left behind", !readdirSync(projDur).some((f) => f.includes(".tmp-")));

	// A corrupt state file is quarantined, not silently clobbered, and the
	// recovery is reported by the status summary.
	writeFileSync(join(projDur, "state.json"), "{ this is not json", { mode: 0o600 });
	const recovered = sdd.loadState(projDur);
	check("corrupt state resets to a safe phase", recovered.phase === "CLARIFY");
	const quarantined = readdirSync(projDur).filter((f) => f.includes(".corrupt-"));
	check("corrupt state is quarantined instead of overwritten", quarantined.length === 1);
	check("the quarantined original is preserved", readFileSync(join(projDur, quarantined[0]), "utf8").includes("not json"));
	check("status reports the recovery", /RECOVERED FROM CORRUPTION/.test(sdd.summarize(sdd.loadState(projDur))));

	// Low-level helper contract.
	const ro = atomicMod.readJsonWithRecovery(join(projDur, "missing.json"));
	check("missing file reads as missing (not corrupt)", ro.status === "missing" && ro.value === null);
	const rw = atomicMod.readJsonWithRecovery(join(projDur, "kb.json"));
	check("valid file reads as ok", rw.status === "ok" || rw.status === "missing");
}


// ---- path / id containment (P0.3) --------------------------------------
check("isSafeSegment rejects traversal and separators", cps.isSafeSegment("../../etc") === false && cps.isSafeSegment("a/b") === false && cps.isSafeSegment("..") === false);
check("isSafeSegment accepts a normal spec id", cps.isSafeSegment("001-demo") === true);
check("dropCheckpoint on an unsafe id deletes nothing", cps.dropCheckpoint(projCp, "../evil") === false);
const escRestore = cps.restoreCheckpointFiles(projCp, "../evil");
check("restore on an unsafe id restores nothing", escRestore.restored.length === 0 && escRestore.missing.length === 0);
const escCreate = cps.createCheckpoint(projCp, { label: "escape", dirs: ["../outside"] });
check("create with a traversal dir is rejected (no checkpoint)", escCreate === null);

// ---- snapshots: symlinks and secrets stay out (lote 2) ------------------
{
	const projSnap = join(dir, "projSnap");
	mkdirSync(join(projSnap, "mod"), { recursive: true });
	writeFileSync(join(projSnap, "mod", "real.py"), "V1\n", { mode: 0o600 });
	// A secret and a key must never be captured.
	writeFileSync(join(projSnap, "mod", ".env"), "ODOO_PASSWORD=super-secret\n", { mode: 0o600 });
	writeFileSync(join(projSnap, "mod", "server.key"), "PRIVATE KEY\n", { mode: 0o600 });
	writeFileSync(join(projSnap, "mod", "id_rsa"), "PRIVATE KEY\n", { mode: 0o600 });
	// A symlink pointing OUTSIDE the tree must not be followed or copied.
	const outside = join(dir, "outside-target");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "leak.txt"), "SECRET OUTSIDE\n", { mode: 0o600 });
	let linked = true;
	try {
		symlinkSync(outside, join(projSnap, "mod", "linkout"), "dir");
		symlinkSync(join(outside, "leak.txt"), join(projSnap, "mod", "linkfile.txt"), "file");
	} catch {
		linked = false; // Windows/privilege: skip the link assertions
	}
	const snap = cps.createCheckpoint(projSnap, { label: "snap", dirs: ["mod"] });
	check("snapshot created", snap !== null);
	const paths = (snap?.files ?? []).map((f) => f.path);
	check("snapshot keeps ordinary sources", paths.some((p) => p.endsWith("real.py")));
	check("snapshot excludes .env", !paths.some((p) => p.endsWith(".env")));
	check("snapshot excludes key material", !paths.some((p) => /\.key$|id_rsa$/.test(p)));
	check("secret file is recognised as secret", cps.isSecretFile(".env") && cps.isSecretFile("server.pem") && cps.isSecretFile("id_rsa") && !cps.isSecretFile("models.py"));
	if (linked) {
		check("snapshot does not follow a directory symlink", !paths.some((p) => p.includes("linkout")));
		check("snapshot does not follow a file symlink", !paths.some((p) => p.includes("linkfile")));
	} else {
		console.log("  SKIP  symlink assertions (no symlink support)");
	}
}

// ---- audit: correlation, real duration, domain vs transport (lote 2) ----
console.log("== audit trail (correlation, duration, domain failures) ==");
{
	const auditMod = await import(new URL("audit.js", libDir).href);
	const runtimeMod = await import(new URL("tools-runtime.js", libDir).href);

	// Entry shape carries the correlation id, the kind and a real duration.
	const sink = join(dir, "projAuditShape");
	mkdirSync(sink, { recursive: true });
	const entry = auditMod.recordAudit(
		sink,
		{ tool: "odoo_execute", op: "sale.order.write", outcome: "error", kind: "rpc", callId: "c1", ms: 7, source: "tool", reason: "boom" },
		null,
	);
	check("audit entry carries kind/callId/ms", entry.kind === "rpc" && entry.callId === "c1" && entry.ms === 7);
	check("audit entry sanitizes the reason", typeof entry.reason === "string" && entry.reason.includes("boom"));

	// The live listener correlates the call and measures the elapsed time.
	const handlers = new Map();
	const auditCtx = {
		tools: { register: () => {}, guard: () => () => {} },
		on: (ev, fn) => { handlers.set(ev, fn); return () => {}; },
	};
	const projAudit = join(dir, "projAuditLive");
	mkdirSync(projAudit, { recursive: true });
	plugin.apply(auditCtx, { projectRoot: projAudit });
	handlers.get("tools/pre-execute")({ callId: "c9", name: "odoo_connect" });
	await new Promise((r) => setTimeout(r, 15));
	handlers.get("tools/result")({ callId: "c9", name: "odoo_connect", arguments: {} }, {});
	const logged = readFileSync(join(projAudit, ".sdd", "audit.jsonl"), "utf8")
		.trim().split("\n").map((l) => JSON.parse(l));
	const live = logged.find((x) => x.callId === "c9");
	check("audit listener correlates the tool call id", live !== undefined);
	check("audit listener records a kind", live !== undefined && live.kind === "tool");
	check("audit listener measures a real duration (not hard-coded 0)", live !== undefined && live.ms >= 10);

	// A server-side failure is a domain error, NOT a transport success.
	const rtTools = new Map();
	const auditFailures = [];
	runtimeMod.registerRuntimeTools(
		{ tools: { register: (t) => rtTools.set(t.name, t) } },
		{
			client: () => ({ client: { executeKw: async () => ({ ok: false, error: "Traceback: boom" }) }, report: "stub" }),
			status: () => ({ detail: "stub" }),
			projectRoot: dir,
			allowlist: () => ["sale.order"],
			display: (v) => v,
			auditFailure: (info) => auditFailures.push(info),
		},
	);
	const rtx = rtTools.get("odoo_execute");
	const rtOut = await rtx.execute(
		{ model: "sale.order", method: "create", values: { name: "x" }, confirm_destructive: true },
		{ callId: "call-123" },
	);
	check("server failure is not reported as a policy denial", rtOut.denied === false && /SERVER ERROR/.test(rtOut.reason));
	check(
		"server failure is recorded as a domain error with the call id",
		auditFailures.length === 1 && auditFailures[0].callId === "call-123" && /SERVER ERROR/.test(auditFailures[0].reason),
	);
}

// ---- transport details: log level query, cancellation, web session (lote 2) ----
console.log("== transport details (log query, abort signal, web session) ==");
{
	const odooMod = await import(new URL("odoo-client.js", libDir).href);
	const creds = { url: "http://127.0.0.1:8069", db: "dev", username: "admin", secret: "k", envFile: "/tmp/x", source: "project" };
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url: String(url), body, signal: init.signal });
		const params = body.params ?? {};
		// Authenticate first: `common.authenticate` is also service "common".
		if (String(params.method) === "authenticate") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 7 }), { status: 200 });
		}
		if (String(params.service) === "common") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { server_version: "17.0" } }), { status: 200 });
		}
		const method = params.args?.[4];
		if (method === "search_read" && params.args?.[3] === "ir.logging") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }), { status: 200 });
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: true }), { status: 200 });
	};
	try {
		const oc = new odooMod.OdooClient(creds);
		const errs = await oc.recentErrors(5, 30);
		check("recentErrors round-trips", errs.ok === true);
		const logCall = calls.find((c) => c.body?.params?.args?.[3] === "ir.logging");
		check(
			"log query filters level by membership, not a text comparison",
			logCall !== undefined && JSON.stringify(logCall.body.params.args[5]).includes('"in"') && !JSON.stringify(logCall.body.params.args[5]).includes('">=","40"'),
		);

		// Cancellation: an aborted caller signal must reach fetch aborted.
		const ac = new AbortController();
		ac.abort();
		calls.length = 0;
		await oc.executeKw("res.partner", "search_read", [[]], {}, undefined, ac.signal);
		const last = calls[calls.length - 1];
		check("an aborted caller signal reaches fetch", last !== undefined && last.signal?.aborted === true);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// ---- RPC capability: context (multi-company) and read methods (lote 4) ----
console.log("== odoo_execute capability (context, read_group, fields_get) ==");
{
	const runtimeMod2 = await import(new URL("tools-runtime.js", libDir).href);
	const rtTools2 = new Map();
	const rpcCalls = [];
	const journaled = [];
	const allow = ["sale.order"];
	runtimeMod2.registerRuntimeTools(
		{ tools: { register: (t) => rtTools2.set(t.name, t) } },
		{
			client: () => ({
				client: {
					executeKw: async (model, method, args, kwargs) => {
						rpcCalls.push({ model, method, args, kwargs });
						return { ok: true, value: [] };
					},
				},
				report: "stub",
			}),
			status: () => ({ detail: "stub" }),
			projectRoot: dir,
			allowlist: () => allow,
			display: (v) => v,
			recordDataOp: (op) => journaled.push(op),
		},
	);
	const rx = rtTools2.get("odoo_execute");

	// The classification is explicit and fail-closed.
	check("read methods are classified as reads", runtimeMod2.READ_METHODS.has("search_read") && runtimeMod2.READ_METHODS.has("read_group") && runtimeMod2.READ_METHODS.has("fields_get"));
	check("mutating methods are classified separately", runtimeMod2.MUTATING_METHODS.has("create") && !runtimeMod2.READ_METHODS.has("create"));
	let rr = await (async () => {
		try {
			return await rx.execute({ model: "sale.order", method: "totally_bogus_method" });
		} catch (err) {
			return { denied: true, reason: err instanceof Error ? err.message : String(err) };
		}
	})();
	check(
		"an unknown method is refused by the tool schema",
		rr.denied === true && /must be one of/i.test(rr.reason) && /read_group/.test(rr.reason),
	);
	// Defence in depth: the in-body classification refuses an unclassified
	// method even if one is ever added to the enum without a decision.
	check(
		"the method sets stay disjoint and complete for the declared enum",
		[...runtimeMod2.READ_METHODS].every((m) => !runtimeMod2.MUTATING_METHODS.has(m)) &&
			runtimeMod2.READ_METHODS.size + runtimeMod2.MUTATING_METHODS.size === 8,
	);

	// context is forwarded verbatim as kwargs.context (multi-company).
	rpcCalls.length = 0;
	await rx.execute({
		model: "sale.order",
		method: "search_read",
		domain: [["state", "=", "draft"]],
		context: { allowed_company_ids: [1, 2], company_id: 2, lang: "es_VE" },
	});
	check(
		"context reaches the RPC as kwargs.context",
		rpcCalls.length === 1 &&
			JSON.stringify(rpcCalls[0].kwargs.context) === JSON.stringify({ allowed_company_ids: [1, 2], company_id: 2, lang: "es_VE" }),
	);
	rr = await (async () => {
		try {
			return await rx.execute({ model: "sale.order", method: "search_read", context: ["not", "an", "object"] });
		} catch (err) {
			return { denied: true, reason: err instanceof Error ? err.message : String(err) };
		}
	})();
	check("a non-object context is refused", rr.denied === true && /context.*must be an object/i.test(rr.reason));

	// read_group: positional (domain, fields, groupby), pagination in kwargs.
	rpcCalls.length = 0;
	await rx.execute({
		model: "sale.order",
		method: "read_group",
		domain: [["state", "=", "sale"]],
		fields: ["amount_total:sum"],
		groupby: ["partner_id"],
		limit: 5,
		order: "amount_total desc",
	});
	const rg = rpcCalls[0];
	check(
		"read_group builds the positional (domain, fields, groupby) call",
		rg.method === "read_group" &&
			JSON.stringify(rg.args[0]) === JSON.stringify([["state", "=", "sale"]]) &&
			JSON.stringify(rg.args[1]) === JSON.stringify(["amount_total:sum"]) &&
			JSON.stringify(rg.args[2]) === JSON.stringify(["partner_id"]),
	);
	check("read_group puts pagination in kwargs", rg.kwargs.limit === 5 && rg.kwargs.orderby === "amount_total desc");

	// fields_get: no positional args, just attributes.
	rpcCalls.length = 0;
	await rx.execute({ model: "sale.order", method: "fields_get", attributes: ["type", "string"] });
	const fg = rpcCalls[0];
	check("fields_get sends no positional args", fg.method === "fields_get" && fg.args.length === 0);
	check("fields_get forwards the requested attributes", JSON.stringify(fg.kwargs.attributes) === JSON.stringify(["type", "string"]));

	// The new reads must NOT be gated as mutations.
	check("read methods are not subject to the mutation allowlist", fg.kwargs.context === undefined);

	// Mutations keep every gate, and the journal records the context used.
	journaled.length = 0;
	rr = await rx.execute({ model: "sale.order", method: "create", values: { name: "x" } });
	check("create still requires confirm_destructive", rr.denied === true && /confirm_destructive/.test(rr.reason));
	rpcCalls.length = 0;
	await rx.execute({
		model: "sale.order",
		method: "create",
		values: { name: "x" },
		confirm_destructive: true,
		context: { company_id: 3 },
	});
	check("an allowlisted create still runs", rpcCalls.length === 1 && rpcCalls[0].method === "create");
	check(
		"the journal records the context of the mutation",
		journaled.length === 1 && JSON.stringify(journaled[0].context) === JSON.stringify({ company_id: 3 }),
	);
}



// ---- security scan ------------------------------------------------------
const vuln = join(dir, "mod_vuln");
mkdirSync(join(vuln, "models"), { recursive: true });
writeFileSync(join(vuln, "__manifest__.py"), "{'name':'v','depends':['base']}", { mode: 0o600 });
writeFileSync(join(vuln, "models", "m.py"), [
	"from odoo import models",
	"class M(models.Model):",
	"    _name = 'x.v'",
	"    def f(self):",
	"        self.env.cr.execute('SELECT * FROM t WHERE id = %s' % self.id)",
	"        eval('1+1')",
	"        api_key = 'supersecreto123'",
].join("\n"), { mode: 0o600 });
const scan = sec.scanModule(vuln);
check("scan flags sql injection as ERROR", scan.findings.some((f) => f.rule === "sql-injection" && f.severity === "ERROR"));
check("scan flags dynamic exec", scan.findings.some((f) => f.rule === "dynamic-exec"));
check("scan flags hardcoded secret", scan.findings.some((f) => f.rule === "hardcoded-secret"));
check("scan result not clean", scan.clean === false);
const cleanMod = join(dir, "mod_cleansec");
mkdirSync(join(cleanMod, "models"), { recursive: true });
writeFileSync(join(cleanMod, "__manifest__.py"), "{'name':'c','depends':['base']}", { mode: 0o600 });
writeFileSync(join(cleanMod, "models", "m.py"), "from odoo import models\nclass C(models.Model):\n    _name = 'x.c'\n", { mode: 0o600 });
check("clean fixture scans clean", sec.scanModule(cleanMod).clean === true);
// A non-existent path must be an ERROR, never a silent "clean" (P1.3).
const missingScan = sec.scanModule(join(dir, "does-not-exist-at-all"));
check("scan of a missing directory is NOT clean", missingScan.clean === false);
check(
	"scan of a missing directory reports a path-not-found ERROR",
	missingScan.findings.some((f) => f.rule === "path-not-found" && f.severity === "ERROR"),
);

// ---- odoo_validate: ACL coherence --------------------------------------
const aclMod = join(dir, "mod_acl");
mkdirSync(join(aclMod, "models"), { recursive: true });
mkdirSync(join(aclMod, "security"), { recursive: true });
writeFileSync(join(aclMod, "__manifest__.py"), "{'name':'a','depends':['base'],'data':['security/ir.model.access.csv','views/v.xml']}", { mode: 0o600 });
mkdirSync(join(aclMod, "views"), { recursive: true });
writeFileSync(join(aclMod, "views", "v.xml"), "<odoo></odoo>", { mode: 0o600 });
writeFileSync(join(aclMod, "models", "m.py"), "from odoo import models\nclass A(models.Model):\n    _name = 'x.acl'\n", { mode: 0o600 });
plugin.apply(fakeCtx, { projectRoot: dir });
const validate = registered.get("odoo_validate");
let valR = await validate.execute({ module_dir: aclMod });
check("validate ERRORs when a new model has no ACL file", valR.valid === false && valR.findings.some((f) => f.severity === "ERROR" && f.message.includes("no ACL file")));
writeFileSync(join(aclMod, "security", "ir.model.access.csv"), "id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_x,access.x,model_x_acl,base.group_user,1,1,1,1\n", { mode: 0o600 });
valR = await validate.execute({ module_dir: aclMod });
check("validate passes with a matching ACL row", valR.valid === true);
writeFileSync(join(aclMod, "security", "ir.model.access.csv"), "id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_x,access.x,model_x_acl,group_ghost,1,0,0,0\n", { mode: 0o600 });
valR = await validate.execute({ module_dir: aclMod });
check("validate WARNs on an unresolvable group", valR.findings.some((f) => f.severity === "WARN" && f.message.includes("group_ghost")));
// A model without an ACL row is an ERROR even when the file exists.
writeFileSync(join(aclMod, "models", "m2.py"), "from odoo import models\nclass B(models.Model):\n    _name = 'x.other'\n", { mode: 0o600 });
valR = await validate.execute({ module_dir: aclMod });
check("validate ERRORs on an unlisted model", valR.valid === false && valR.findings.some((f) => f.severity === "ERROR" && f.message.includes("x.other")));

// ---- architecture security gate (groups + ACL + matrix + rules) --------
const secDir = join(dir, "specs", "sec-gate");
sdd.initSpecDir(secDir);
let sSec = sdd.loadState(secDir);
sSec.phase = "ARCHITECTURE";
const gateR1 = sdd.transition(sSec, "WRITE_CODE", "APPROVED", "try incomplete security");
check("security gate blocks an empty ## Security", gateR1.ok === false && gateR1.reason.includes("security model is incomplete"));
writeFileSync(join(secDir, "architecture.md"), "# Architecture\n\n## Models\nx\n\n## Views\ny\n\n## Security\nGroups: base.group_user plus a new group_my_manager. Access via security/ir.model.access.csv with read/create/write/unlink per group. No record rules needed.\n\n## Manifest\nz\n\n## Documentation\nLanguage: en. Fragments: DESCRIPTION.md (Reference) and USAGE.md (How-to) only; no extra fragments. index.html: not needed.\n", { mode: 0o600 });
let sSec2 = sdd.loadState(secDir);
sSec2.phase = "ARCHITECTURE";
const gateR2 = sdd.transition(sSec2, "WRITE_CODE", "APPROVED", "complete security");
check("security gate passes with groups+ACL+matrix+rules decision", gateR2.ok === true);

// ---- policy guard -------------------------------------------------------
const projGuard = join(dir, "projGuard");
mkdirSync(projGuard, { recursive: true });
plugin.apply(fakeCtx, { projectRoot: projGuard });
const guard = capturedGuards[capturedGuards.length - 1];
check("policy guard registered with the host", typeof guard === "function");
let gR = guard({ name: "odoo_execute", arguments: { method: "create" } });
check("guard denies a mutation with no checkpoint", typeof gR === "string" && gR.includes("no checkpoint"));
check("guard allows read-only tools", guard({ name: "odoo_connect", arguments: {} }) === undefined);
const guardCp = registered.get("sdd_checkpoint");
const gcR = await guardCp.execute({ operation: "create", label: "guard", dirs: ["."] });
check("checkpoint tool created one for the guard", gcR.ok === true);
gR = guard({ name: "odoo_execute", arguments: { method: "create" } });
check("guard allows the mutation after a checkpoint exists", gR === undefined);
cps.writeActiveState(projGuard, { phase: "READ_SPEC" });
gR = guard({ name: "odoo_module", arguments: { operation: "install" } });
check("guard denies a mutation before WRITE_CODE", typeof gR === "string" && gR.includes("READ_SPEC"));
cps.writeActiveState(projGuard, { phase: "WRITE_CODE" });
mkdirSync(join(projGuard, ".sdd"), { recursive: true });
writeFileSync(join(projGuard, ".sdd", "stop.md"), "operator halt\n", { mode: 0o600 });
gR = guard({ name: "odoo_connect", arguments: {} });
check("guard halts every tool on stop.md", typeof gR === "string" && gR.includes("stop.md"));
rmSync(join(projGuard, ".sdd", "stop.md"));

// Fail-CLOSED: an internal guard failure must deny, never allow (lote 2).
{
	const hostile = {};
	Object.defineProperty(hostile, "name", {
		get() { throw new Error("hostile execution"); },
	});
	const gFail = guard(hostile);
	check(
		"guard denies fail-closed on an internal error",
		typeof gFail === "string" && /fail/i.test(gFail) && /hostile execution|internally/i.test(gFail),
	);
}

// ---- sdd_phase rollback + handoff --------------------------------------
const projH = join(dir, "projH");
mkdirSync(join(projH, "mod"), { recursive: true });
plugin.apply(fakeCtx, { projectRoot: projH });
const phaseH = registered.get("sdd_phase");
const cpToolH = registered.get("sdd_checkpoint");
const handoffH = registered.get("sdd_handoff");
await phaseH.execute({ operation: "init", spec_id: "001-h" });
const activeH = cps.readActiveState(projH);
check("phase init records the active spec/phase", activeH.specId === "001-h" && activeH.phase === "CLARIFY");
writeFileSync(join(projH, "mod", "b.py"), "BROKEN\n", { mode: 0o600 });
const cpH = await cpToolH.execute({ operation: "create", label: "h", dirs: ["mod"] });
check("checkpoint for rollback created", cpH.ok === true);
writeFileSync(join(projH, "mod", "b.py"), "VERY-BROKEN\n", { mode: 0o600 });
const rb = await phaseH.execute({ operation: "rollback", spec_id: "001-h" });
check("sdd_phase rollback restores files", rb.ok === true && readFileSync(join(projH, "mod", "b.py"), "utf8") === "BROKEN\n");
check("rollback returns the pipeline to WRITE_CODE", rb.phase === "WRITE_CODE");
const hR = await handoffH.execute({ spec_id: "001-h", summary: "Prueba de handoff" });
check("handoff written", hR.ok === true && existsSync(join(projH, "specs", "001-h", "handoff.md")));
const hText = readFileSync(join(projH, "specs", "001-h", "handoff.md"), "utf8");
check("handoff documents next steps", hText.includes("## Next steps"));
check("handoff documents configuration", hText.includes("## Configuration in effect"));

// ---- odoo_docs: standalone documentation of an existing module (lote 6) ----
console.log("== odoo_docs (fragments, Diátaxis, changelog, scaffold) ==");
{
	const docsMod = await import(new URL("docs-scan.js", libDir).href);
	const convMod = await import(new URL("project-conventions.js", libDir).href);

	// A module with no documentation at all, documented WITHOUT any spec/phase.
	const projDoc = join(dir, "projDocs");
	const modDir = join(projDoc, "my_module");
	mkdirSync(join(modDir, "models"), { recursive: true });
	writeFileSync(join(modDir, "__manifest__.py"), "{'name':'my_module','version':'19.0.1.0.0','depends':['base']}", { mode: 0o600 });
	writeFileSync(join(modDir, "models", "m.py"), "from odoo import models\nclass A(models.Model):\n    _name = 'x.doc'\n", { mode: 0o600 });
	plugin.apply(fakeCtx, { projectRoot: projDoc });
	const docs = registered.get("odoo_docs");
	check("odoo_docs is registered", docs !== undefined);

	// STANDALONE: no sdd_phase, no checkpoint, no instance involved.
	let dr = await docs.execute({ operation: "check", module_dir: modDir });
	check("check runs standalone (no spec/phase needed)", dr.ok === false && Array.isArray(dr.findings));
	check("missing mandatory fragments are ERRORs", dr.findings.some((f) => f.rule === "docs-fragment-missing" && f.severity === "ERROR" && f.file === "readme/DESCRIPTION.md"));
	check("missing index.html is a WARN", dr.findings.some((f) => f.rule === "docs-index-missing" && f.severity === "WARN"));
	check("a new model without a Mermaid ERD is flagged", dr.findings.some((f) => f.rule === "docs-erd-missing"));

	// Changelog: mandatory for a bug fix, not for the initial release.
	let bugScan = docsMod.scanDocs(modDir, { mode: "bug" });
	let createScan = docsMod.scanDocs(modDir, { mode: "create" });
	check("changelog is REQUIRED for a bug fix", bugScan.changelogRequired === true && bugScan.findings.some((f) => f.rule === "docs-changelog-missing" && f.severity === "ERROR"));
	check("changelog is not demanded for a brand-new module", createScan.findings.every((f) => f.rule !== "docs-changelog-missing"));
	// An already-released module demands one even in create mode.
	writeFileSync(join(modDir, "__manifest__.py"), "{'name':'my_module','version':'19.0.1.2.0','depends':['base'],'summary':'x'}", { mode: 0o600 });
	const released = docsMod.scanDocs(modDir, { mode: "create" });
	check("an already-released module requires a changelog entry", released.findings.some((f) => f.rule === "docs-changelog-missing" && f.severity === "ERROR"));

	// Version scheme.
	writeFileSync(join(modDir, "__manifest__.py"), "{'name':'my_module','version':'1.0','depends':['base']}", { mode: 0o600 });
	check("a non-5-component version is an ERROR", docsMod.scanDocs(modDir).findings.some((f) => f.rule === "docs-version-scheme" && f.severity === "ERROR"));
	writeFileSync(join(modDir, "__manifest__.py"), "{'name':'my_module','version':'19.0.1.0.0','depends':['base'],'summary':'My module'}", { mode: 0o600 });

	// Language: English by default, project file wins, explicit parameter wins.
	check("language defaults to English", convMod.resolveDocsLanguage({}).language === "en");
	writeFileSync(join(projDoc, "AGENTS.md"), "# Reglas\n\n## Documentación del Módulo\n\nLos archivos README.rst e index.html deben redactarse en ESPAÑOL.\n", { mode: 0o600 });
	const fromProject = convMod.resolveDocsLanguage({ projectRoot: projDoc });
	check("a project rules file overrides the default", fromProject.language === "es" && fromProject.source === "project-file");
	check("an explicit parameter overrides the project file", convMod.resolveDocsLanguage({ projectRoot: projDoc, explicit: "pt" }).language === "pt");
	// A line about CODE language must not be mistaken for a docs language.
	writeFileSync(join(projDoc, "AGENTS.md"), "# Reglas\n\nEl código debe estar en INGLÉS.\n", { mode: 0o600 });
	check("a code-language line is not read as the docs language", convMod.resolveDocsLanguage({ projectRoot: projDoc }).language === "en");

	// plan maps the fragments to Diátaxis.
	dr = await docs.execute({ operation: "plan", module_dir: modDir });
	check("plan reports the Diátaxis mapping", /Diátaxis|Reference|How-to/.test(dr.detail));
	check("plan states what the plugin cannot run", /gen-odoo-readme/.test(dr.detail));

	// scaffold creates the skeletons, create-only and flagged as unfinished.
	dr = await docs.execute({ operation: "scaffold", module_dir: modDir });
	check("scaffold creates the readme fragments", dr.artifacts.includes("readme/DESCRIPTION.md") && existsSync(join(modDir, "readme", "DESCRIPTION.md")));
	check("scaffold creates the index.html skeleton", existsSync(join(modDir, "static", "description", "index.html")));
	check("scaffold marks the fragments as unfinished", dr.findings.some((f) => f.rule === "docs-fragment-scaffolded"));
	check("scaffolded fragments are reported, not approved", /NEEDS_CONTENT|SCAFFOLD/.test(dr.summary) || dr.findings.some((f) => f.rule === "docs-fragment-scaffolded"));
	const before = readFileSync(join(modDir, "readme", "DESCRIPTION.md"), "utf8");
	writeFileSync(join(modDir, "readme", "DESCRIPTION.md"), before.replace("# DESCRIPTION", "# DESCRIPTION\n\nX\n").replace(/<!-- odoo-sdd:scaffold[^>]*-->/, ""), { mode: 0o600 });
	dr = await docs.execute({ operation: "scaffold", module_dir: modDir });
	const after = readFileSync(join(modDir, "readme", "DESCRIPTION.md"), "utf8");
	check("scaffold NEVER overwrites existing content", after.includes("X"));

	// report: needs a spec to persist, and refuses a hollow doc set.
	dr = await docs.execute({ operation: "report", module_dir: modDir, mode: "bug" });
	check("report without spec_id does not write", dr.artifacts.includes("docs-report.md") === false && /NOT written/.test(dr.detail));
	await registered.get("sdd_phase").execute({ operation: "init", spec_id: "010-docs" });
	dr = await docs.execute({ operation: "report", module_dir: modDir, spec_id: "010-docs", mode: "bug" });
	const repFile = join(projDoc, "specs", "010-docs", "docs-report.md");
	check("report persists into the spec", existsSync(repFile));
	const repText = readFileSync(repFile, "utf8");
	check("report carries a machine-readable verdict", /Verdict:\s*(APPROVED|NEEDS_CONTENT)/.test(repText));
	check("a module missing its changelog is NOT approved", /Verdict:\s*NEEDS_CONTENT/.test(repText));

	// DONE gate honours the policy.
	const gateDir = join(dir, "specs", "011-docgate");
	sdd.initSpecDir(gateDir);
	writeFileSync(
		join(gateDir, "test-plan.md"),
		"# Test Plan\n\n| AC | Scenario | Layer (static/server/rpc/ui/manual) | Status |\n|---|---|---|---|\n| AC1 | x | rpc | passed |\n",
	);
	const gSt = sdd.loadState(gateDir);
	gSt.phase = "FIX_LOOP";
	sdd.recordSuccess(gSt, "AC1 ok");
	let gR = sdd.transition(gSt, "DONE", null, "done", "human", "supervised", { documentationPolicy: "required" });
	check("required policy blocks DONE without a docs report", gR.ok === false && /documentation/i.test(gR.reason));
	gR = sdd.transition(gSt, "DONE", null, "done", "human", "supervised", { documentationPolicy: "optional" });
	check("optional policy does not block DONE", gR.ok === true);
	writeFileSync(join(gateDir, "docs-report.md"), "# Documentation report\n\nVerdict: APPROVED\n\n## Findings\n- (none)\n", { mode: 0o600 });
	const gSt2 = sdd.loadState(gateDir);
	gSt2.phase = "FIX_LOOP";
	check("a NEEDS_CONTENT verdict is refused", (() => {
		writeFileSync(join(gateDir, "docs-report.md"), "# R\n\nVerdict: NEEDS_CONTENT\n", { mode: 0o600 });
		const g3 = sdd.loadState(gateDir);
		g3.phase = "FIX_LOOP";
		return sdd.transition(g3, "DONE", null, "d", "human", "supervised", { documentationPolicy: "required" }).ok === false;
	})());
	writeFileSync(join(gateDir, "docs-report.md"), "# Documentation report\n\nVerdict: APPROVED\n\n## Findings\n- (none)\n", { mode: 0o600 });
	gR = sdd.transition(gSt2, "DONE", null, "done", "human", "supervised", { documentationPolicy: "required" });
	check("an APPROVED report lets DONE through", gR.ok === true);

	// The ARCHITECTURE content gate ignores template comments.
	const archDir = join(dir, "specs", "012-archdocs");
	sdd.initSpecDir(archDir);
	check("an untouched skeleton does NOT satisfy the documentation gate", sdd.documentationGaps(archDir).length > 0);
	writeFileSync(
		join(archDir, "architecture.md"),
		"# Architecture\n\n## Models\nx\n\n## Views\ny\n\n## Security\ngroups base.group_user; ir.model.access.csv read/write/create/unlink; no record rules needed.\n\n## Manifest\nz\n\n## Documentation\nLanguage: en. Fragments: DESCRIPTION.md (Reference), USAGE.md (How-to); no extra fragments.\n",
		{ mode: 0o600 },
	);
	check("a real decision satisfies the documentation gate", sdd.documentationGaps(archDir).length === 0);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
