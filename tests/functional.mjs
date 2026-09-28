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
const clsMod = await import(new URL("method-classification.js", libDir).href);
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

/** Runs once after the next mutating send, so a test can tamper mid-batch. */
let tamperAfterSend = null;

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
		const result = respond(model, method, args);
		if (tamperAfterSend !== null && method !== "read" && method !== "search_count" && method !== "fields_get") {
			const run = tamperAfterSend;
			tamperAfterSend = null;
			run();
		}
		return result;
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

console.log("== apply: an accepted mutation keeps its receipt when the proof fails ==");
{
	// The server ACCEPTED the create and the postcondition did not hold. Those are
	// two different facts, and the ordering used to erase the second one's
	// evidence: the journal entry (created id + pre-image) was written AFTER the
	// postcondition check, so a failed proof left nothing to inspect or compensate
	// for a row that was already on the instance.
	const createOp = {
		intent: "create partner 501",
		model: "res.partner",
		method: "create",
		args: [{ name: "created but unproven" }],
		identity: [{ field: "id", value: 501 }],
		postcondition: { domain: [["id", "=", 501]], expect: "count", count: 1 },
		expect: { kind: "created", count: 1 },
		recovery: { kind: "unlink_created" },
	};
	const createBatch = {
		id: "b-create",
		scope: "apply",
		title: "create one partner whose proof will fail",
		acceptance: [],
		companies: [1],
		operations: [createOp],
	};
	const planned = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: createBatch });
	check("a create with postcondition, identity and recovery passes validation", planned.ok === true, planned.detail);
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-create", scope: "apply" });

	journaled.length = 0;
	countByState = { "501": 0 };
	const applied = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-create", confirm_destructive: true });
	countByState = {};
	check("the batch stops because the state it promised was not reached", applied.ok === false, applied.detail);

	const runAfter = readRun(proj, specId);
	const rec = runAfter.ops.filter((o) => o.batchId === "b-create").pop();
	check("the operation is reported as failed, never as applied", rec?.state === "failed", JSON.stringify(rec?.state));
	check("the failure still records that the server ACCEPTED the call", rec?.effect === "accepted", JSON.stringify(rec?.effect));
	check("the accepted create kept its id (the receipt survived the failed proof)", rec?.createdIds?.[0] === 501, JSON.stringify(rec?.createdIds));
	check(
		"the accepted create reached the data journal despite the failed postcondition",
		journaled.length === 1 && journaled[0].method === "create" && journaled[0].createdIds?.[0] === 501,
		JSON.stringify(journaled),
	);
	check(
		"the stop message says the effect is journaled and NOT verified",
		/journaled/i.test(String(applied.detail)) && /NOT verified/i.test(String(applied.detail)),
		applied.detail,
	);

	// Compensation must offer to undo what landed — including this one, whose
	// postcondition failed. Skipping it (the old `state === "applied"` filter)
	// reported "nothing to compensate" for a row that exists.
	const comp = await fn.execute({ operation: "compensate", spec_id: specId });
	// The compensation batch is read back from the PERSISTED plan, not from the
	// tool result: the output schema does not carry the batch object, so asserting
	// against `comp.batch` would pass on `undefined` and prove nothing.
	const compBatch = (readPlan(proj, specId)?.batches ?? []).find((b) => b.id === comp.batchId);
	const unlink501 = (compBatch?.operations ?? []).find((o) => o.method === "unlink" && JSON.stringify(o.args?.[0]) === "[501]");
	check("compensation offers to remove the created record even though the proof failed", unlink501 !== undefined, JSON.stringify(compBatch?.operations ?? []));
	check("compensation says which effect it included without verification", /postcondition failed/i.test(String(comp.detail)), comp.detail);

	// And the run does not present it as verified: `verify` is the evidence the
	// closing report is built from.
	const verify = await fn.execute({ operation: "verify", spec_id: specId });
	check("verify does not report the run as verified while an accepted effect is unproven", verify.status === "blocked", JSON.stringify({ status: verify.status }));
	check("verify names the unproven effect", /NOT verified/i.test(String(verify.detail)), verify.detail);
}

console.log("== apply: an edited document invalidates the approval ==");{
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

	// Reconcile: the DECLARED EFFECT is what can be proven, not the existence of a
	// record. This operation declares no postcondition, so a lookup that finds the
	// row proves nothing (it was there before the call — that is what a `write`
	// is), and the honest answer is "a human decides".
	rpcMode = "ok";
	calls.length = 0;
	const reconciled = await fn.execute({ operation: "reconcile", spec_id: specId, batch_id: "b-flaky" });
	check("reconcile consults the instance", calls.some((c) => c.method === "search_count"));
	check("the run STAYS blocked when the effect cannot be attributed", reconciled.ok === true && reconciled.status === "blocked", reconciled.detail);
	check(
		"an existing record is not accepted as proof that a write landed",
		/undecidable/i.test(reconciled.detail) && /existing record is not proof/i.test(reconciled.detail),
		reconciled.detail,
	);
	check("the resolution is recorded on the operation", readRun(proj, specId).ops.find((o) => o.batchId === "b-flaky")?.resolution !== undefined);

	// An undecidable result needs a HUMAN decision, and it is an explicit one.
	// Without this the run would block forever and the only way out would be
	// editing run.json by hand.
	const noConfirm = await fn.execute({ operation: "reconcile", spec_id: specId, resolution: "checked in the UI", decision: "applied" });
	check("a hand resolution needs confirm_destructive", noConfirm.ok === false && noConfirm.status === "needs-confirmation", noConfirm.detail);
	const badDecision = await fn.execute({
		operation: "reconcile", spec_id: specId, resolution: "checked in the UI", confirm_destructive: true,
	});
	check("a hand resolution without a decision is refused", badDecision.ok === false && /"applied" or "failed"/.test(badDecision.detail));
	const byHand = await fn.execute({
		operation: "reconcile", spec_id: specId, resolution: "the partner name is already 'after' in the UI", decision: "applied", confirm_destructive: true,
	});
	check("the operator can resolve it by hand and unblock the run", byHand.ok === true && byHand.status === "idle", byHand.detail);
	check(
		"a hand decision is recorded as a decision, never as a proof",
		/BY HAND/.test(String(readRun(proj, specId).ops.find((o) => o.batchId === "b-flaky")?.resolution)),
	);
	check("the manual resolution is not evidence that the call succeeded", /NOT evidence/i.test(byHand.detail), byHand.detail);
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
	// An unresolved operation blocks the run BY DESIGN, and the tests share one
	// spec: settle it here so the next block starts from a run that has no open
	// question. It is the operator path, the only one that can close an
	// "undecidable" outcome — there is no back door that resets the run.
	const settled = await fn2.execute({
		operation: "reconcile", spec_id: specId, batch_id: "b-audit2",
		resolution: "test fixture: the write outcome does not matter to the next block",
		decision: "failed", confirm_destructive: true,
	});
	check("an operator decision closes an undecidable outcome", settled.ok === true && settled.status === "idle", settled.detail);
	check("the audit kind exists for functional entries", typeof auditMod.recordAudit === "function");
}


// One rule for the ad-hoc RPC and the batch executor: a mutation that never
// answered is INDETERMINATE, and a business action counts as a mutation even
// though it is not CRUD. Two copies of this would drift into a retry of
// something that already happened on one surface and not on the other.
check(
	"the indeterminate rule is shared with the ad-hoc RPC",
	clsMod.isIndeterminateFor("action_run", "transport") === true &&
		clsMod.isIndeterminateFor("write", "protocol") === true &&
		clsMod.isIndeterminateFor("action_run", "server") === false &&
		clsMod.isIndeterminateFor("search_read", "transport") === false,
);
check(
	"a private name is not callable on any surface (Odoo refuses it over RPC)",
	clsMod.isCallableMethodName("action_confirm") === true &&
		clsMod.isCallableMethodName("_create_invoices") === false &&
		clsMod.isCallableMethodName("init") === false &&
		clsMod.isCallableMethodName("Action Confirm") === false,
);

console.log("== limits of the batch: inspect is read-only, unresolved is not re-sent ==");
{
	// `inspect` runs DISCOVERY batches, which carry no approval, no confirmation
	// and no backup. It used to decide "is this mutating?" by asking only about
	// create/write/unlink, so a `kind: "method"` batch passed the check as a read
	// and the business action EXECUTED under the discovery path.
	methodAllowlist = ["example.model.action_run"];
	const methodForInspect = {
		id: "b-inspect-method",
		scope: "discovery",
		title: "a business action wearing a discovery badge",
		acceptance: [],
		companies: [],
		operations: [
			{
				kind: "method",
				intent: "run the action",
				model: "example.model",
				method: "action_run",
				args: [[11]],
				identity: [{ field: "id", value: 11 }],
				precondition: { domain: [["id", "=", 11]], expect: "exists" },
				postcondition: { domain: [["id", "=", 11], ["state", "=", "assigned"]], expect: "count", count: 1 },
				recovery: { kind: "none", note: "not undoable" },
			},
		],
	};
	const planInspect = await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: methodForInspect });
	check("a discovery batch carrying a business action does not validate", planInspect.ok === false && /discovery batch may only read/.test(planInspect.detail), planInspect.detail);

	// Even if such a batch reaches the plan (a hand-written file), `inspect` refuses it.
	const injected = { ...methodForInspect, scope: "apply" };
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: injected });
	calls.length = 0;
	const inspected = await fn.execute({ operation: "inspect", spec_id: specId, batch_id: "b-inspect-method" });
	check("inspect refuses a batch that mutates through a business action", inspected.ok === false && /READ-only/.test(inspected.detail), inspected.detail);
	check("inspect sent nothing at all", calls.length === 0);

	// And the reverse: `apply` is not a way to run a batch that only reads.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: writableBatch({ id: "b-readonly", operations: [{ intent: "count", model: "res.partner", method: "search_count", args: [[]] }] }) });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-readonly", scope: "apply" });
	calls.length = 0;
	const appliedRead = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-readonly", confirm_destructive: true });
	check("apply refuses a batch that changes nothing", appliedRead.ok === false && /operation=inspect/.test(appliedRead.detail), appliedRead.detail);
	check("nothing was sent for it either", calls.length === 0);
	methodAllowlist = [];

	// An operation that cannot be resolved if its answer is lost is refused at
	// PLAN time: neither a postcondition nor a stable identity is a dead end.
	// (`undefined` cannot ride through the host's lossless-JSON check, so the two
	// keys are removed by destructuring.)
	const baseOp = writableBatch().operations[0];
	const { identity: _dropIdentity, postcondition: _dropPost, ...opWithoutEither } = baseOp;
	const unresolvable = await fn.execute({
		operation: "plan",
		spec_id: specId,
		environment: "dev",
		batch: writableBatch({ id: "b-unresolvable", operations: [opWithoutEither] }),
	});
	check(
		"a mutation with no postcondition and no identity is refused (it could never be reconciled)",
		unresolvable.ok === false && /postcondition or a stable identity/.test(unresolvable.detail),
		unresolvable.detail,
	);
}

console.log("== the brakes and the authorization are re-checked BETWEEN operations ==");
{
	const twoOps = writableBatch({
		id: "b-two",
		operations: [
			{ ...writableBatch().operations[0], identity: [{ field: "id", value: 7 }] },
			{ intent: "rename partner 8", model: "res.partner", method: "write", args: [[8], { name: "after too" }], identity: [{ field: "id", value: 8 }], postcondition: { domain: [["id", "=", 8]], expect: "exists" }, recovery: { kind: "restore_preimage" } },
		],
	});

	// (a) The SPEC-level stop.md halts the loop. The project-level file used to be
	// the only one read, while the skill promised stop.md in the spec dir halts
	// everything.
	await fn.execute({ operation: "plan", spec_id: specId, environment: "dev", batch: twoOps });
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "b-two", scope: "apply" });
	writeFileSync(join(specDir, "stop.md"), "stop the spec\n");
	calls.length = 0;
	const specHalted = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-two", confirm_destructive: true });
	check("a stop.md inside the SPEC halts the batch", specHalted.ok === false && /stop\.md appeared/.test(specHalted.detail), specHalted.detail);
	check("nothing was sent while the spec brake was on", calls.length === 0);
	rmSync(join(specDir, "stop.md"), { force: true });

	// (b) Editing the plan between operations invalidates the approval for the
	// NEXT one. Checking only on entry made the receipt a key that stayed valid
	// while the approved content changed underneath it. The edit has to land AFTER
	// the first send, or the entry check would catch it first and the loop path
	// (the one the skill promises) would never be exercised.
	calls.length = 0;
	const originalPlan = readPlan(proj, specId);
	tamperAfterSend = () => {
		const tampered = JSON.parse(JSON.stringify(originalPlan));
		tampered.batches.find((b) => b.id === "b-two").operations[1].args = [[8], { name: "TAMPERED" }];
		writeFileSync(join(functionalDir(proj, specId), "plan.json"), JSON.stringify(tampered, null, 2));
	};
	const midEdit = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-two", confirm_destructive: true });
	tamperAfterSend = null;
	const writesSent = calls.filter((c) => c.method === "write");
	check("an edit to the plan between operations stops the batch", midEdit.ok === false && /approval no longer matches/.test(midEdit.detail), midEdit.detail);
	check("the edited plan was not sent after the edit", JSON.stringify(writesSent).includes("TAMPERED") === false, JSON.stringify(writesSent.map((c) => c.args)));
	// The first operation DID go out before the edit: the point is that the second
	// one did not, which is what "revalidated between operations" means.
	check("the operation that preceded the edit is the only one sent", writesSent.length === 1, JSON.stringify(writesSent.map((c) => c.args)));
	writeFileSync(join(functionalDir(proj, specId), "plan.json"), JSON.stringify(originalPlan, null, 2));

	// (c) An unresolved operation blocks a REPEAT of the batch. This is the
	// duplicate-effect case: the answer never arrived, so sending the batch again
	// is how one effect becomes two.
	countByState = {};
	rpcMode = "transport-fail";
	calls.length = 0;
	await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-two", confirm_destructive: true });
	rpcMode = "ok";
	check("the transport failure left an unresolved operation", readRun(proj, specId).ops.some((o) => o.state === "indeterminate" && o.decided === undefined));
	calls.length = 0;
	const repeated = await fn.execute({ operation: "apply", spec_id: specId, batch_id: "b-two", confirm_destructive: true });
	check("re-applying a batch with an unresolved outcome is refused", repeated.ok === false && repeated.status === "needs-reconcile", repeated.detail);
	check("NOTHING was re-sent by the repeat", calls.length === 0, JSON.stringify(calls.map((c) => c.method)));

	// A read-only batch carries no such risk: repeating a query cannot double-apply.
	// (Its approval is re-issued first: replacing the plan for another batch
	// invalidates every receipt bound to the previous plan hash — which is the
	// documented behaviour, not a wrinkle in this test.)
	await fn.execute({ operation: "approve", spec_id: specId, batch_id: "d1", scope: "discovery" });
	const repeatRead = await fn.execute({ operation: "inspect", spec_id: specId, batch_id: "d1" });
	check("a read-only batch can still be repeated", repeatRead.ok === true, repeatRead.detail);

	// The unresolved operation is settled by the operator before the next block.
	const settled = await fn.execute({
		operation: "reconcile", spec_id: specId, batch_id: "b-two",
		resolution: "test fixture: the interrupted write is undone, its outcome is irrelevant to the next block",
		decision: "failed", confirm_destructive: true,
	});
	check("the operator decision unblocks the shared run", settled.ok === true && settled.status === "idle", settled.detail);
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
