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
check("initial phase CLARIFY (intent unresolved)", st.phase === "CLARIFY" && st.mode === null && st.licensed === null);

let r = sdd.transition(st, "READ_SPEC", null, "try without clarifying");
check("CLARIFY gate blocks before intent is clear", r.ok === false && (r.reason ?? "").includes("CLARIFY"));

// Resolve intent, then it can leave CLARIFY (not gated) toward READ_SPEC.
st.mode = "create";
st.licensed = "community";
r = sdd.transition(st, "READ_SPEC", null, "intent clarified");
check("CLARIFY -> READ_SPEC allowed once intent set", r.ok === true && st.phase === "READ_SPEC");

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
const capturedGuards = [];
const fakeCtx = {
	tools: {
		register: (t) => registered.set(t.name, t),
		guard: (g) => { capturedGuards.push(g); return () => {}; },
	},
	on: () => () => {},
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
	"odoo_security_scan", "sdd_handoff",
];
check("registers exactly the 12 documented tools", registered.size === expectedTools.length);
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
writeFileSync(join(secDir, "architecture.md"), "# Architecture\n\n## Models\nx\n\n## Views\ny\n\n## Security\nGroups: base.group_user plus a new group_my_manager. Access via security/ir.model.access.csv with read/create/write/unlink per group. No record rules needed.\n\n## Manifest\nz\n", { mode: 0o600 });
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
let gR = guard({ name: "odoo_execute", args: { method: "create" } });
check("guard denies a mutation with no checkpoint", typeof gR === "string" && gR.includes("no checkpoint"));
check("guard allows read-only tools", guard({ name: "odoo_connect", args: {} }) === undefined);
const guardCp = registered.get("sdd_checkpoint");
const gcR = await guardCp.execute({ operation: "create", label: "guard", dirs: ["."] });
check("checkpoint tool created one for the guard", gcR.ok === true);
gR = guard({ name: "odoo_execute", args: { method: "create" } });
check("guard allows the mutation after a checkpoint exists", gR === undefined);
cps.writeActiveState(projGuard, { phase: "READ_SPEC" });
gR = guard({ name: "odoo_module", args: { operation: "install" } });
check("guard denies a mutation before WRITE_CODE", typeof gR === "string" && gR.includes("READ_SPEC"));
cps.writeActiveState(projGuard, { phase: "WRITE_CODE" });
mkdirSync(join(projGuard, ".sdd"), { recursive: true });
writeFileSync(join(projGuard, ".sdd", "stop.md"), "operator halt\n", { mode: 0o600 });
gR = guard({ name: "odoo_connect", args: {} });
check("guard halts every tool on stop.md", typeof gR === "string" && gR.includes("stop.md"));
rmSync(join(projGuard, ".sdd", "stop.md"));

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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
