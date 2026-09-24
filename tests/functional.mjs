/**
 * Executor suite for `odoo_functional` (the functional path's batch runner).
 *
 * No instance is involved: the RPC client is a double that records every call and
 * answers like Odoo would. What is being tested is not "does it call write" but
 * the properties that make a functional run safe:
 *
 *   - nothing mutates without a batch a human approved, bound by hashes;
 *   - editing the spec/design/plan after the approval invalidates it;
 *   - the declared environment gates the run, and production needs a backup;
 *   - every operation is persisted as in-progress BEFORE the call;
 *   - an answer that never came back is INDETERMINATE, never retried blind;
 *   - one writer at a time;
 *   - the compensation is derived from what was journaled, honestly reporting
 *     what cannot be undone.
 *
 * Usage: `node tests/functional.mjs` (run after `npm run build`).
 *
 * @module dsh-odoo-sdd/tests/functional
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const { registerFunctionalTool, functionalDir, readRun, readPlan } = await import(new URL("functional.js", libDir).href);
const { sha256 } = await import(new URL("functional.js", libDir).href);

let failures = 0;
/**
 * Assert one executor invariant.
 * @param label - what is being checked.
 * @param cond - whether it holds.
 * @param detail - extra context, printed on failure.
 */
function check(label, cond, detail) {
	if (cond) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

const root = mkdtempSync(join(tmpdir(), "sdd-functional-"));
const proj = join(root, "project");
mkdirSync(join(proj, ".sdd"), { recursive: true });

// ---- harness ---------------------------------------------------------------
let environment = "dev";
let approveOutcome = "allowed-once";
let rpcMode = "ok";
/** Per-state answers for search_count, so a postcondition can be exercised. */
let countByState = {};
/** Business actions the operator allowed for this run. */
let methodAllowlist = [];
const calls = [];
const grants = new Map();
// The REAL grants module is used for the round-trip tests below: an in-memory
// double once hid the fact that `readGrants` dropped a whole kind on read.
const grantsMod = await import(new URL("grants.js", libDir).href);
const journaled = [];

/** One recorded call as the executor sees the RPC result. */
function respond(model, method, args) {
	if (rpcMode === "transport-fail" && method !== "read" && method !== "search_count" && method !== "fields_get") {
		return { ok: false, error: "Request failed: socket hang up", errorKind: "transport" };
	}
	if (method === "search_count") {
		// A declared per-state answer lets a test exercise the postcondition: the
		// real instance would answer differently once the state changed.
		const state = /"state"\s*,\s*"="\s*,\s*"([a-z_]+)"/.exec(JSON.stringify(args?.[0] ?? []));
		if (state !== null && countByState[state[1]] !== undefined) return { ok: true, value: countByState[state[1]] };
		return { ok: true, value: 42 };
	}
	if (method === "create") return { ok: true, value: 501 };
	if (method === "read") return { ok: true, value: [{ id: 7, name: "before" }] };
	return { ok: true, value: true };
}

const client = {
	async executeKw(model, method, args, kwargs) {
		calls.push({ model, method, args, kwargs });
		return respond(model, method, args);
	},
};

const tools = new Map();
const ctx = { tools: { register: (t) => tools.set(t.name, t) } };
registerFunctionalTool(ctx, {
	projectRoot: () => proj,
	specDir: (specId) => join(proj, "specs", specId),
	client: () => ({
		client,
		report: "configured",
		target: "http://127.0.0.1:8069 db=dev user=admin",
		...(environment === undefined ? {} : { environment }),
	}),
	approve: async () => approveOutcome,
	methodAllowlist: () => methodAllowlist,
	hashes: (specId) => {
		const dir = join(proj, "specs", specId);
		const read = (name) => {
			try {
				return readFileSync(join(dir, name), "utf8");
			} catch {
				return "";
			}
		};
		return { specHash: sha256(read("spec.md")), designHash: sha256(read("architecture.md")) };
	},
	// REAL grant storage, not a double: the executor's whole point is that an
	// approval is persisted and re-checked, and an in-memory map cannot prove it
	// (it already hid a kind-filter bug in readGrants).
	grants: {
		write: (g) => {
			grants.set(g.fingerprint, g);
			grantsMod.writeGrant(proj, {
				kind: "batch",
				fingerprint: g.fingerprint,
				...(g.reason === undefined ? {} : { reason: g.reason }),
				...(g.details === undefined ? {} : { details: g.details }),
			});
		},
		valid: (fp) => grantsMod.hasValidGrant(proj, "batch", fp),
	},
	recordDataOp: (op) => journaled.push(op),
	display: (v) => v,
});

const fn = tools.get("odoo_functional");
check("odoo_functional is registered", fn !== undefined);

const specId = "001-load";
const specDir = join(proj, "specs", specId);
mkdirSync(specDir, { recursive: true });
writeFileSync(join(specDir, "spec.md"), "# Spec\n\n## Context\nfill partner master data\n");
writeFileSync(join(specDir, "architecture.md"), "# Functional architecture\n\n## Operations\nb1\n");
writeFileSync(
	join(specDir, "test-plan.md"),
	"# Test Plan\n\n| AC | Scenario | Layer | Status |\n|---|---|---|---|\n| AC1 | 42 partners exist | rpc | pending |\n",
);

/** A batch that mutates one field of one record, with everything declared. */
function writableBatch(overrides = {}) {
	return {
		id: "b1",
		scope: "apply",
		title: "fix one partner name",
		acceptance: ["AC1"],
		companies: [1],
		context: { allowed_company_ids: [1], company_id: 1 },
		operations: [
			{
				intent: "rename partner 7",
				model: "res.partner",
				method: "write",
				args: [[7], { name: "after" }],
				identity: [{ field: "id", value: 7 }],
				precondition: { domain: [["id", "=", 7]], expect: "exists" },
				expect: { kind: "updated", count: 1 },
				recovery: { kind: "restore_preimage" },
			},
		],
		...overrides,
	};
}

console.log("== plan: validation is fail-closed ==");
{
	const plan = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch() });
	check("a well-formed batch is stored", plan.ok === true && plan.status === "planned", plan.detail);
	// A mutation that cannot show the state it produced is the one that lies
	// later: it is a WARN (existing plans keep running), never silent.
	check(
		"a mutation without a postcondition is warned about, not blocked",
		(plan.findings ?? []).some((f) => f.severity === "WARN" && /no postcondition declared/.test(f.message)),
		JSON.stringify((plan.findings ?? []).map((f) => f.message.slice(0, 60))),
	);
	const withPost = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({
			id: "b-post",
			operations: [
				{
					...writableBatch().operations[0],
					postcondition: { domain: [["id", "=", 7], ["name", "=", "after"]], expect: "count", count: 1 },
				},
			],
		}),
	});
	check(
		"declaring the postcondition clears the warning",
		withPost.ok === true && !(withPost.findings ?? []).some((f) => /no postcondition declared/.test(f.message)),
	);
	check("the plan landed under .sdd/functional", existsSync(join(functionalDir(proj, specId), "plan.json")));
	check("nothing was sent to the instance while planning", calls.length === 0);

	const badMethod = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({ id: "b-bad", operations: [{ intent: "x", model: "res.partner", method: "sudo_bypass", args: [] }] }),
	});
	check("an unclassified method is rejected", badMethod.ok === false && /not classified/.test(badMethod.detail));
	check("the rejected batch was NOT stored", readPlan(proj, specId)?.batches.some((b) => b.id === "b-bad") === false);

	const hiddenMutation = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({
			id: "b-discovery",
			scope: "discovery",
			operations: [{ intent: "peek", model: "res.partner", method: "unlink", args: [[1]], recovery: { kind: "none" } }],
		}),
	});
	check("a mutation cannot hide inside a discovery batch", hiddenMutation.ok === false && /discovery batch may only read/.test(hiddenMutation.detail));

	const noRecovery = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({ id: "b-norec", operations: [{ intent: "x", model: "res.partner", method: "write", args: [[7], { name: "y" }] }] }),
	});
	check("a mutation without recovery is rejected", noRecovery.ok === false && /how it is recovered/.test(noRecovery.detail));

	const noIds = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({ id: "b-noids", operations: [{ intent: "x", model: "res.partner", method: "write", args: [[], { name: "y" }], recovery: { kind: "restore_preimage" } }] }),
	});
	check("write without ids is rejected", noIds.ok === false && /explicit ids/.test(noIds.detail));

	const prodNoBackup = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "production",
		batch: writableBatch({ id: "b-prod", highRisk: true }),
	});
	check("high risk in production without a backup is rejected", prodNoBackup.ok === false && /backupReference/.test(prodNoBackup.detail));
	const prodOk = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "production",
		batch: writableBatch({ id: "b-prod", highRisk: true, backupReference: "pgdump-2026-02-01", manualSteps: ["check the partner in the UI"] }),
	});
	check("high risk in production with a declared backup is accepted", prodOk.ok === true);
	// Back to a dev plan for the rest of the suite.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch() });
}

console.log("== approve: human approval bound to the content ==");
{
	approveOutcome = "rejected";
	const refused = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b1", scope: "apply" });
	check(
		"a refused approval writes no grant",
		refused.ok === false && refused.status === "not-approved" && grantsMod.readGrants(proj).grants.length === 0,
	);

	approveOutcome = "allowed-once";
	const approved = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b1", scope: "apply" });
	check(
		"an approved batch writes exactly one PERSISTED receipt",
		approved.ok === true && grantsMod.readGrants(proj).grants.filter((g) => g.kind === "batch").length === 1,
	);
	const receipt = grantsMod.readGrants(proj).grants.find((g) => g.kind === "batch");
	check("the receipt is a batch grant with its details", receipt.kind === "batch" && receipt.details?.batchId === "b1" && receipt.details?.scope === "apply");
	check("the receipt records the environment and destination", receipt.details?.environment === "dev" && /db=dev/.test(String(receipt.details?.target)));
	check("the receipt carries the three hashes", typeof receipt.details?.specHash === "string" && typeof receipt.details?.designHash === "string" && typeof receipt.details?.planHash === "string");

	const wrongScope = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b1", scope: "compensate" });
	check("approving a scope the batch does not have is refused", wrongScope.ok === false && wrongScope.status === "scope-mismatch");
}

console.log("== apply: approval, hashes, order and journal ==");
{
	// Without confirm_destructive nothing is sent.
	const noConfirm = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b1" });
	check("a mutating batch needs the caller's explicit confirmation", noConfirm.ok === false && noConfirm.status === "needs-confirmation");
	check("nothing was sent", calls.length === 0);

	calls.length = 0;
	journaled.length = 0;
	const applied = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b1", confirm_destructive: true });
	check("the approved batch applies", applied.ok === true && applied.status === "applied", applied.detail);
	check("the pre-image was read under the batch context", (() => {
		const read = calls.find((c) => c.method === "read");
		return read !== undefined && JSON.stringify(read.kwargs.context) === JSON.stringify({ allowed_company_ids: [1], company_id: 1 });
	})());
	const write = calls.find((c) => c.method === "write");
	check("the write carries the batch context too", write !== undefined && write.kwargs.context?.company_id === 1);
	check("the mutation was journaled with its context", journaled.length === 1 && journaled[0].method === "write" && journaled[0].context?.company_id === 1);
	const run = readRun(proj, specId);
	check("every operation is recorded as applied", run.ops.every((o) => o.state === "applied") && run.ops.length >= 1);
	check("the run is idle and unlocked after a clean batch", run.state === "idle" && run.lock === undefined);
	check("the operation persisted an attempt and a result instant", run.ops[0].attemptedAt !== undefined && run.ops[0].resultAt !== undefined);
}

console.log("== apply: an edited document invalidates the approval ==");
{
	writeFileSync(join(specDir, "architecture.md"), "# Functional architecture\n\n## Operations\nb1 CHANGED after approval\n");
	const stale = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b1", confirm_destructive: true });
	check("editing the design after approval blocks the apply", stale.ok === false && stale.status === "not-approved", stale.detail);
	writeFileSync(join(specDir, "architecture.md"), "# Functional architecture\n\n## Operations\nb1\n");
	const reapproved = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b1", scope: "apply" });
	check("re-approving the restored content works", reapproved.ok === true);
}

console.log("== environment: declared, never assumed ==");
{
	const saved = environment;
	environment = undefined;
	const undeclared = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b1", confirm_destructive: true });
	check("an undeclared environment stops the run", undeclared.ok === false && undeclared.status === "needs-environment" && /NEEDS_ENVIRONMENT/.test(undeclared.detail));
	environment = saved;

	// A plan written for production cannot run against a target that declares dev:
	// the environment belongs to the TARGET, not to the plan the agent wrote.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "production", batch: writableBatch({ id: "b-prod2", highRisk: true, backupReference: "pgdump-x", manualSteps: ["check"] }) });
	const mismatchApprove = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-prod2", scope: "apply" });
	check(
		"a plan written for production cannot be approved against a dev target",
		mismatchApprove.ok === false && mismatchApprove.status === "environment-mismatch",
		mismatchApprove.detail,
	);

	// A receipt issued for one environment does not authorize another.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-env", highRisk: true, backupReference: "pgdump-y" }) });
	const approvedDev = await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-env", scope: "apply" });
	check("the batch is approved for the dev target", approvedDev.ok === true);
	environment = "staging";
	const movedTarget = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-env", confirm_destructive: true });
	check(
		"the target moving to another environment blocks the run",
		movedTarget.ok === false && movedTarget.status === "environment-mismatch",
		movedTarget.detail,
	);
	// Re-plan for the new environment so the mismatch is gone: the receipt must
	// STILL not authorize it, because the environment is part of the fingerprint.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "staging", batch: writableBatch({ id: "b-env", highRisk: true, backupReference: "pgdump-y" }) });
	const stillStale = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-env", confirm_destructive: true });
	check(
		"the receipt issued for dev does NOT authorize the staging target",
		stillStale.ok === false && stillStale.status === "not-approved",
		stillStale.detail,
	);
	environment = "dev";
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-env", highRisk: true, backupReference: "pgdump-y" }) });
}

console.log("== indeterminate: never retried blind ==");
{
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-flaky" }) });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-flaky", scope: "apply" });
	rpcMode = "transport-fail";
	calls.length = 0;
	const flaky = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-flaky", confirm_destructive: true });
	check("a transport failure on a mutation stops the batch", flaky.ok === false && flaky.status === "stopped");
	check("the operation is reported as INDETERMINATE", /UNKNOWN|indeterminate/i.test(flaky.detail));
	const runAfter = readRun(proj, specId);
	const op = runAfter.ops.find((o) => o.batchId === "b-flaky");
	check("the recorded state is indeterminate", op?.state === "indeterminate");
	check("the run is blocked until a human reconciles", runAfter.state === "blocked");
	check("the mutation was attempted exactly once", calls.filter((c) => c.method === "write").length === 1);

	// Reconcile: the declared identity answers whether it landed.
	rpcMode = "ok";
	calls.length = 0;
	const reconciled = await fn.execute({ operation: "reconcile", spec_id: specId, batch_id: "b-flaky" });
	check("reconcile looks the identity up on the instance", calls.some((c) => c.method === "search_count"));
	check("reconcile resolves the operation and unblocks the run", reconciled.ok === true && reconciled.status === "idle", reconciled.detail);
	check("the resolution is recorded on the operation", readRun(proj, specId).ops.find((o) => o.batchId === "b-flaky")?.resolution !== undefined);
}

console.log("== one writer at a time ==");
{
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-lock" }) });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-lock", scope: "apply" });
	// Simulate an interrupted call holding the lock.
	const held = readRun(proj, specId);
	held.state = "running";
	held.lock = { callId: "other-call", at: new Date().toISOString(), batchId: "b-lock" };
	writeFileSync(join(functionalDir(proj, specId), "run.json"), JSON.stringify(held, null, 2));
	const blocked = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-lock", confirm_destructive: true }, { callId: "my-call" });
	check("a foreign lock blocks the apply", blocked.ok === false && blocked.status === "locked");
	const took = await fn.execute(
		{ operation: "apply", spec_id: specId, batch_id: "b-lock", confirm_destructive: true, release_stale_lock: true },
		{ callId: "my-call" },
	);
	check("release_stale_lock takes it over explicitly", took.ok === true && took.status === "applied");
	check("the lock is cleared afterwards", readRun(proj, specId).lock === undefined);
}

console.log("== discovery: reads only ==");
{
	const discovery = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: {
			id: "d1",
			scope: "discovery",
			title: "what is installed",
			acceptance: [],
			companies: [],
			operations: [{ intent: "count partners", model: "res.partner", method: "search_count", args: [[]] }],
		},
	});
	check("a discovery batch plans without company or recovery", discovery.ok === true);
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "d1", scope: "discovery" });
	const inspected = await fn.execute({ operation: "inspect", spec_id: specId, batch_id: "d1" });
	check("inspect runs the read-only batch", inspected.ok === true && inspected.status === "applied", inspected.detail);
	check("inspect needed no confirm_destructive", calls.some((c) => c.model === "res.partner" && c.method === "search_count"));
	const mutated = await fn.execute({ operation: "inspect", spec_id: specId, batch_id: "b1" });
	check("inspect refuses a mutating batch", mutated.ok === false && /READ-only/.test(mutated.detail));
}

console.log("== verify and compensate ==");
{
	const verified = await fn.execute({ operation: "verify", spec_id: specId });
	check("verify reports evidence per applied batch", verified.ok === true && Array.isArray(verified.evidence) && verified.evidence.length > 0);
	check("verify names the acceptance criterion it can prove", String(verified.detail).includes("AC1"));

	const compensation = await fn.execute({ operation: "compensate", spec_id: specId });
	check("compensation is planned, not executed", compensation.ok === true && compensation.status === "planned");
	const plan = readPlan(proj, specId);
	const comp = plan.batches.find((b) => b.id === compensation.batchId);
	check("the compensation batch inverts the journaled mutations", comp !== undefined && comp.scope === "compensate" && comp.operations.length > 0);
	check(
		"a compensated write restores the pre-image value",
		comp.operations.some((o) => o.method === "write" && JSON.stringify(o.args[1]).includes("before")),
		JSON.stringify(comp.operations.map((o) => [o.method, o.args])),
	);
	check("the compensation still needs its own approval", comp.operations.length > 0 && readRun(proj, specId).state !== "running");

	const status = await fn.execute({ operation: "status", spec_id: specId });
	check("status reports the plan, the run and the counters", status.ok === true && Array.isArray(status.batches) && status.counts?.applied >= 1);
}

console.log("== brakes: stop.md and cancellation between operations ==");
{
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-stop" }) });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-stop", scope: "apply" });
	writeFileSync(join(proj, ".sdd", "stop.md"), "operator halt\n");
	calls.length = 0;
	const halted = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-stop", confirm_destructive: true });
	check("stop.md halts the batch before the next operation", halted.ok === false && /stop.md appeared/.test(halted.detail));
	check("nothing was sent to the instance", calls.length === 0);
	rmSync(join(proj, ".sdd", "stop.md"), { force: true });

	// Cancellation between operations: the signal is already aborted.
	const aborted = await fn.execute(
		{ operation: "apply", spec_id: specId, batch_id: "b-stop", confirm_destructive: true },
		{ callId: "cancel-call", signal: { aborted: true } },
	);
	check("a cancelled call stops between operations", aborted.ok === false && /cancelled by the host/.test(aborted.detail));
	check("nothing was sent on cancellation either", calls.length === 0);
}

console.log("== audit: every functional operation leaves a trace ==");
{
	const auditMod = await import(new URL("audit.js", libDir).href);
	// The dep is wired to the plugin's audit in production; here the suite's own
	// recorder proves the executor CALLS it with the operation identity.
	const audited = [];
	const tools2 = new Map();
	registerFunctionalTool({ tools: { register: (t) => tools2.set(t.name, t) } }, {
		projectRoot: () => proj,
		specDir: (id) => join(proj, "specs", id),
		client: () => ({ client, report: "ok", target: "http://127.0.0.1:8069 db=dev user=admin", environment: "dev" }),
		approve: async () => "allowed-once",
		hashes: () => ({ specHash: "s", designHash: "d" }),
		grants: { write: () => {}, valid: () => true },
		audit: (entry) => audited.push(entry),
		display: (v) => v,
	});
	const fn2 = tools2.get("odoo_functional");
	await fn2.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-audit" }) });
	await fn2.execute({ operation: "apply", spec_id: specId, batch_id: "b-audit", confirm_destructive: true });
	check("an applied operation is audited", audited.length === 1 && audited[0].state === "applied" && audited[0].model === "res.partner");
	rpcMode = "transport-fail";
	await fn2.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-audit2" }) });
	await fn2.execute({ operation: "apply", spec_id: specId, batch_id: "b-audit2", confirm_destructive: true });
	check("an indeterminate operation is audited as such", audited.some((a) => a.state === "indeterminate" && typeof a.reason === "string"));
	rpcMode = "ok";
	check("the audit kind exists for functional entries", typeof auditMod.recordAudit === "function");
}


console.log("== business actions: allowlisted, guarded, and PROVEN ==");
{
	// A business action is not CRUD: its effect cannot be replayed from a
	// pre-image, so it runs only with the exact pair allowlisted and only when it
	// can prove the state it produced.
	// `undefined` in an override REMOVES the key: the host validates tool
	// arguments as lossless JSON, so an explicit undefined is refused before the
	// plugin ever sees it.
	const methodOp = (over = {}) => {
		const op = {
			kind: "method",
			intent: "run the action on 3 records",
			model: "example.model",
			method: "action_run",
			args: [[11, 12, 13]],
			identity: [{ field: "id", value: 11 }],
			precondition: { domain: [["id", "in", [11, 12, 13]], ["state", "=", "draft"]], expect: "count", count: 3 },
			postcondition: { domain: [["id", "in", [11, 12, 13]], ["state", "=", "assigned"]], expect: "count", count: 3 },
			recovery: { kind: "none", note: "confirming moves is not undone by the plugin" },
		};
		for (const [key, value] of Object.entries(over)) {
			if (value === undefined) delete op[key];
			else op[key] = value;
		}
		return op;
	};
	const methodBatch = (over = {}) => ({ ...writableBatch(), id: "b-method", operations: [methodOp(over)] });

	// Denied without the allowlist, even with everything else declared.
	methodAllowlist = [];
	const denied = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: methodBatch() });
	check("a business action is refused when it is not allowlisted", denied.ok === false && /not allowlisted/.test(denied.detail), denied.detail);

	// Allowed, but the guard and the proof are not optional.
	methodAllowlist = ["example.model.action_run"];
	const noPre = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: methodBatch({ precondition: undefined }) });
	check("a business action without a precondition is refused", noPre.ok === false && /must declare a precondition/.test(noPre.detail));
	const noPost = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: methodBatch({ postcondition: undefined }) });
	check("a business action without a postcondition is refused", noPost.ok === false && /must declare a postcondition/.test(noPost.detail));
	const fakeRecovery = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: methodBatch({ recovery: { kind: "restore_preimage" } }),
	});
	check("a business action cannot claim a pre-image recovery", fakeRecovery.ok === false && /cannot undo a business action/.test(fakeRecovery.detail));
	const inDiscovery = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: { ...methodBatch(), scope: "discovery" } });
	check("a business action cannot live in a discovery batch", inDiscovery.ok === false && /discovery batch may only read/.test(inDiscovery.detail));

	// The happy path: declared, approved, applied — and the state was read back.
	const storable = methodBatch();
	const planned = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: storable });
	check("an allowlisted business action is stored in the plan", planned.ok === true, planned.detail);
	check("planning a business action sends nothing", calls.filter((c) => c.method === "action_run").length === 0);

	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-method", scope: "apply" });
	const journalBefore = journaled.length;
	countByState = { draft: 3, assigned: 3 };
	const applied = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-method", scope: "apply", confirm_destructive: true });
	check("the business action is applied", applied.ok === true && applied.status === "applied", applied.detail);
	check("the method WAS called on the recordset", calls.some((c) => c.method === "action_run" && Array.isArray(c.args?.[0]) && c.args[0].length === 3));
	const runAfter = readRun(proj, specId);
	const rec = runAfter.ops.find((o) => o.batchId === "b-method");
	check("the postcondition result is persisted as evidence", typeof rec?.postcondition === "string" && /3 record/.test(rec.postcondition), JSON.stringify(rec?.postcondition));
	check("a business action is NOT journaled (no pre-image exists for it)", journaled.length === journalBefore);

	// The state is not reached: the whole point of the change.
	countByState = { draft: 3, assigned: 0 };
	const notReached = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-method", scope: "apply", confirm_destructive: true });
	check("a batch whose state was not reached fails", notReached.ok === false, notReached.detail);
	const failedRun = readRun(proj, specId);
	const failedOp = failedRun.ops.filter((o) => o.batchId === "b-method").pop();
	check("the operation is recorded as failed, never applied", failedOp?.state === "failed");
	check("the failure names the postcondition", /postcondition not met/.test(String(failedOp?.error)), String(failedOp?.error));
	check(
		"the stop message says the call WAS sent (so nobody retries blindly)",
		/sent|partially changed/i.test(String(notReached.detail)),
		notReached.detail,
	);
	check("the applied state did NOT overwrite the failed one", failedOp?.postcondition === undefined || /0 record/.test(String(failedOp?.postcondition)) === false);

	// A timeout after sending it is INDETERMINATE, not a plain failure. The
	// precondition is a READ, so it still answers while the mutation times out:
	// that is exactly the shape of the real failure this guards against.
	countByState = { draft: 3, assigned: 3 };
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: methodBatch() });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-method", scope: "apply" });
	rpcMode = "transport-fail";
	const unknown = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-method", scope: "apply", confirm_destructive: true });
	rpcMode = "ok";
	const unknownRun = readRun(proj, specId);
	const unknownOp = unknownRun.ops.filter((o) => o.batchId === "b-method").pop();
	check("a business action that never answered is INDETERMINATE", unknownOp?.state === "indeterminate", JSON.stringify(unknownOp?.state));
	check("the indeterminate batch stops instead of retrying", unknown.ok === false);

	// Compensation: it cannot undo it, and it says so.
	const comp = await fn.execute({ operation: "compensate", spec_id: specId });
	check("compensation reports the business action it cannot undo", /NOT compensable/.test(String(comp.detail)), comp.detail);
	check("no compensation operation calls the business method again", !(comp.batch?.operations ?? []).some((o) => o.method === "action_run"));

	// The mechanism is model-agnostic by design: the same declaration must work
	// for ANY model, and the plugin must not know anything about the domain.
	methodAllowlist = ["example.model.action_run", "another.model.button_go"];
	const other = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: { ...writableBatch(), id: "b-other", operations: [{ ...methodOp(), model: "another.model", method: "button_go" }] },
	});
	check("a different model's method is equally declarable (no domain knowledge in the plugin)", other.ok === true, other.detail);
	const offList = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: { ...writableBatch(), id: "b-off", operations: [{ ...methodOp(), model: "third.model", method: "button_go" }] },
	});
	check("the allowlist is per pair, not per method name", offList.ok === false && /not allowlisted/.test(offList.detail));
	methodAllowlist = [];
	countByState = {};
}

console.log(`\n${failures === 0 ? "ALL FUNCTIONAL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
