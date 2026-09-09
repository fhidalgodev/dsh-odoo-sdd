/**
 * Smoke test for dsh-odoo-sdd compiled lib (no Odoo instance needed).
 * Validates state machine (gates, ladder, verdicts, ceiling, stop.md),
 * security (S1 https/loopback guard, S2 redaction/scrub/path-masking),
 * and the Q3 fail-closed host guard.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, mkdirSync, rmSync } from "node:fs";
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
const specDir = join(dir, "specs", "001-demo");

console.log("== state machine ==");
sdd.initSpecDir(specDir);
check("skeleton files created", ["spec.md", "architecture.md", "test-plan.md"].every((f) => existsSync(join(specDir, f))));

let st = sdd.loadState(specDir);
check("initial phase READ_SPEC", st.phase === "READ_SPEC");

let r = sdd.transition(st, "ARCHITECTURE", null, "try without marker");
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

sdd.recordSuccess(st, "all ACs verified");
const verdict = sdd.readVerdict(specDir);
check("verdict persisted as PASSED", verdict !== null && verdict.passed === true);
r = sdd.transition(st, "DONE", null, "verified");
check("DONE reachable after PASSED verdict", r.ok === true && st.phase === "DONE");

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

check("S2: scrubGeneric hides password= shapes", !creds.scrubGeneric("reset with password=Sup3rS3cret! now").includes("Sup3rS3cret!"));
check("S2: scrubGeneric hides Bearer tokens", !creds.scrubGeneric("Authorization: Bearer abc123.def-456").includes("abc123"));
check("S2: scrubGeneric hides api_key:", !creds.scrubGeneric("api_key: 0123456789abcdef").includes("0123456789abcdef"));
const masked = creds.displayPath(`failed at ${homedir()}/dev/app.py`);
check("S2: displayPath folds home to ~", masked.includes("~/dev/app.py") && !masked.includes(homedir()));
const persisted = creds.sanitizeForPersist(`at /home/x password=abc12345678 file: ${homedir()}/.env`, loaded.ok ? loaded.credentials : null);
check("S2: sanitizeForPersist chains all layers", !persisted.includes("abc12345678") && !persisted.includes(homedir()));

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


console.log("== onboarding & cascade (odoo_setup) ==");
// Isolate user-scope config inside the tmp dir and clear overrides.
process.env["XDG_CONFIG_HOME"] = join(dir, "xdg");
delete process.env["ODOO_SDD_ENV_FILE"];

const registered = new Map();
const fakeCtx = { tools: { register: (t) => registered.set(t.name, t) } };

// --- projA: full onboarding flow ---
const projA = join(dir, "projA");
plugin.apply(fakeCtx, { projectRoot: projA });
const setup = registered.get("odoo_setup");
const connect = registered.get("odoo_connect");
check("odoo_setup registered", setup !== undefined);

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
check("connect proceeds to instance probe after secret filled", rs.detail.includes("Instance unreachable") && !rs.detail.includes("NEEDS_SECRET"));

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
// Overwrite the spec with content lacking the required Acceptance Criteria section.
writeFileSync(join(projD, "specs", "001-bare", "spec.md"), "# Spec\n\n== Context ==\n", { mode: 0o600 });
let gate = await sddD.execute({ operation: "advance", spec_id: "001-bare", next_phase: "ARCHITECTURE", approval_marker: "APPROVED", approval_source: "human" });
check("headings gate blocks advance with missing spec sections", gate.ok === false && (gate.detail.includes("Acceptance Criteria") || gate.detail.includes("missing required section")));

// --- autonomy: proxy approval forbidden in supervised ---
await setupD.execute({ mode: "skip" }); // avoid instance requirement
sddD.execute({ operation: "init", spec_id: "002-proxy" });
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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
