/**
 * SDD phase state machine with fail-closed pipeline safety patterns.
 *
 * All state lives in files inside the spec directory, so any session (or a
 * fresh agent) can resume idempotently:
 *
 *   specs/<NNN>-<slug>/
 *   ├── spec.md            immutable specification + acceptance criteria
 *   ├── architecture.md    orchestrated model/view/security design
 *   ├── test-plan.md       UI/E2E scenarios derived from the spec
 *   ├── verify-verdict.txt honest persisted verdict of the last verification
 *   ├── state.json         THIS module's persisted phase/failure state
 *   └── kb.json            decision/blocker/learning graph (append-only)
 *
 * Pipeline safety invariants enforced here:
 *   - fail-closed phase gates: only an explicit `APPROVED` marker advances a
 *     gated phase; ambiguity or garbage never counts as approval;
 *   - failure ladder: N consecutive failures (default 3) force a deep
 *     diagnosis step before any further retry;
 *   - iteration cap: verify/fix loop is bounded (default 5 per criterion);
 *   - stop.md: an emergency-stop file checked between transitions;
 *   - honest verdicts: verification results persist to disk and a failed
 *     verify can never be rewritten as passed;
 *   - idempotent resume: completed phases carry a KB decision node and are
 *     skipped on re-entry;
 *   - regression gate: advancing past VERIFY requires the recorded test
 *     results to be green — never build on a broken base.
 *
 * @module dsh-odoo-sdd/sdd-state
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** Ordered pipeline phases (the 5 SDD steps + the CLARIFY entry + terminals). */
export const PHASES = [
	"CLARIFY",
	"READ_SPEC",
	"ARCHITECTURE",
	"WRITE_CODE",
	"VERIFY",
	"FIX_LOOP",
	"DONE",
	"BLOCKED",
] as const;

export type Phase = (typeof PHASES)[number];
/** Pipeline modality: create a new module, or resolve a bug on an existing one. */
export type PipelineMode = "create" | "bug";
/** Licensing / search strategy for reused functionality. */
export type LicenseStrategy = "enterprise" | "oca" | "community";

/** Non-terminal phases that require an explicit human/agent approval gate. */
export const GATED_PHASES: readonly Phase[] = ["READ_SPEC", "ARCHITECTURE"];

/** One node of the append-only knowledge-base graph. */
export interface KbNode {
	id: number;
	kind: "decision" | "blocker" | "learning" | "verdict" | "diagnosis" | "discarded";
	phase: Phase;
	summary: string;
	createdAt: string;
}

/** Persisted pipeline state for one spec. */
export interface SddState {
	/** Schema version for forward compatibility. */
	version: 1;
	specDir: string;
	phase: Phase;
	/** What job this pipeline run is doing. */
	mode: PipelineMode | null;
	/** Licensing strategy for reused functionality. */
	licensed: LicenseStrategy | null;
	/** Consecutive failures in the current verify/fix cycle. */
	failureCount: number;
	/** Total verify/fix iterations consumed for the current criterion set. */
	iterationsUsed: number;
	/** Iteration ceiling before the pipeline must go BLOCKED. */
	maxIterations: number;
	/** Failures that trigger forced deep diagnosis. */
	maxFailuresBeforeDiagnosis: number;
	/** True when the last verification produced a green verdict. */
	lastVerdictPassed: boolean | null;
	/** True once deep diagnosis has run for the current failure streak. */
	diagnosisDone: boolean;
	/** Whether the spec.md file exists and was read at least once. */
	specLoaded: boolean;
	updatedAt: string;
}

/** Result of a phase transition attempt. */
export type TransitionResult =
	| { ok: true; state: SddState; note: string }
	| { ok: false; reason: string; state: SddState };

const STATE_FILE = "state.json";
const KB_FILE = "kb.json";
const VERDICT_FILE = "verify-verdict.txt";
const STOP_FILE = "stop.md";

function nowIso(): string {
	return new Date().toISOString();
}

/** Create the initial state for a brand-new spec directory. */
export function initialState(specDir: string, overrides: Partial<SddState> = {}): SddState {
	return {
		version: 1,
		specDir,
		// The pipeline starts UNCLARIFIED, in the CLARIFY phase. mode and
		// licensed stay null (fail-closed) until the user answers the intent
		// questions via sdd_phase operation=clarify — nothing starts before
		// the intent is clear, except in AUTONOMOUS mode where they are
		// detected from the request.
		phase: "CLARIFY",
		mode: null,
		licensed: null,
		failureCount: 0,
		iterationsUsed: 0,
		maxIterations: Number(process.env["ODOO_SDD_MAX_ITERATIONS"] ?? 5),
		maxFailuresBeforeDiagnosis: Number(process.env["ODOO_SDD_MAX_FAILURES"] ?? 3),
		lastVerdictPassed: null,
		diagnosisDone: false,
		specLoaded: false,
		updatedAt: nowIso(),
		...overrides,
	};
}

/** Load persisted state, returning fresh state when none exists. */
export function loadState(specDir: string): SddState {
	const file = join(specDir, STATE_FILE);
	if (!existsSync(file)) return initialState(specDir);
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as SddState;
		if (parsed.version !== 1) return initialState(specDir);
		return { ...initialState(specDir), ...parsed, specDir };
	} catch {
		// A corrupted state file must never fake progress: start over.
		return initialState(specDir);
	}
}

/** Persist state atomically-enough (write tmp + rename is overkill here). */
export function saveState(state: SddState): void {
	mkdirSync(state.specDir, { recursive: true });
	writeFileSync(join(state.specDir, STATE_FILE), JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2));
}

/** Append a node to the KB graph (create the file when missing). */
export function kbAppend(state: SddState, kind: KbNode["kind"], summary: string): KbNode {
	const file = join(state.specDir, KB_FILE);
	let nodes: KbNode[] = [];
	if (existsSync(file)) {
		try {
			nodes = JSON.parse(readFileSync(file, "utf8")) as KbNode[];
		} catch {
			nodes = [];
		}
	}
	const node: KbNode = {
		id: nodes.length > 0 ? Math.max(...nodes.map((n) => n.id)) + 1 : 1,
		kind,
		phase: state.phase,
		summary,
		createdAt: nowIso(),
	};
	nodes.push(node);
	writeFileSync(file, JSON.stringify(nodes, null, 2));
	return node;
}

/** Read the KB graph (empty when absent). */
export function kbRead(specDir: string): KbNode[] {
	const file = join(specDir, KB_FILE);
	if (!existsSync(file)) return [];
	try {
		return JSON.parse(readFileSync(file, "utf8")) as KbNode[];
	} catch {
		return [];
	}
}

/**
 * Check the emergency stop file. Any content (or mere existence) halts the
 * pipeline; the reason is the file content for the human report.
 */
export function stopRequested(specDir: string): string | null {
	const file = join(specDir, STOP_FILE);
	if (!existsSync(file)) return null;
	const content = readFileSync(file, "utf8").trim();
	return content === "" ? "stop.md exists (no reason given)" : content;
}

/**
 * Persist the honest verification verdict. A failed verdict is written as
 * FAILED and can only be replaced by a new verification run — never edited
 * into a pass by the fix loop.
 */
export function writeVerdict(state: SddState, passed: boolean, detail: string): void {
	const header = passed ? "PASSED" : "FAILED";
	writeFileSync(
		join(state.specDir, VERDICT_FILE),
		`${header} at ${nowIso()}\n${detail.slice(0, 20000)}\n`,
	);
	state.lastVerdictPassed = passed;
}

/** Read the persisted verdict (null when no verification ran yet). */
export function readVerdict(specDir: string): { passed: boolean; text: string } | null {
	const file = join(specDir, VERDICT_FILE);
	if (!existsSync(file)) return null;
	const text = readFileSync(file, "utf8");
	return { passed: text.startsWith("PASSED"), text };
}

/**
 * The only mutation path for phases. Enforces every gate:
 *   - stop.md halts everything;
 *   - gated phases need an explicit `APPROVED` marker (fail-closed);
 *   - READ_SPEC cannot advance before spec.md was actually loaded;
 *   - VERIFY -> DONE needs a persisted PASSED verdict (regression gate);
 *   - FIX_LOOP counts iterations and forces diagnosis after N failures;
 *   - exceeding the iteration ceiling moves the pipeline to BLOCKED.
 *
 * @param state - current persisted state (mutated and saved on success).
 * @param next - requested target phase.
 * @param approvalMarker - verbatim marker string when the caller claims a gate.
 * @param note - human-readable reason logged to the KB.
 */
export function transition(
	state: SddState,
	next: Phase,
	approvalMarker: string | null,
	note: string,
	approvalSource?: "human" | "human-proxy",
	mode?: "supervised" | "autonomous",
): TransitionResult {
	const stop = stopRequested(state.specDir);
	if (stop !== null) {
		kbAppend(state, "blocker", `Pipeline halted by stop.md: ${stop}`);
		saveState(state);
		return { ok: false, reason: `stop.md present — pipeline halted. Reason: ${stop}`, state };
	}

	// Fail-closed approval gates.
	if (GATED_PHASES.includes(state.phase) && next !== "BLOCKED") {
		// Provenance: in SUPERVISED mode the human must answer; the
		// human-proxy cannot approve. In AUTONOMOUS mode both are accepted
		// (view a human as always able to intervene with precedence).
		const who = approvalSource ?? "human";
		if (mode === "supervised" && who === "human-proxy") {
			return {
				ok: false,
				reason:
					`Phase ${state.phase}: approval claimed from the human-proxy in ` +
					"SUPERVISED mode. A human must answer this gate — ask the " +
					"developer (approval_source=human).",
				state,
			};
		}
		// Headings gate: gated phases must produce the required sections.
		// Headings gate: before EARNING approval for the CURRENT phase, its
		// deliverable (spec.md for READ_SPEC, architecture.md + test-plan.md
		// for ARCHITECTURE) must contain the required sections.
		const headings = requiredHeadings(state.phase);
		const missing = headings.missing(state.specDir);
		if (missing.length > 0) {
			return {
				ok: false,
				reason:
					`Phase ${state.phase} cannot advance: ${headings.file} is missing ` +
					`required section(s): ${missing.join(", ")}. Complete them before requesting approval.`,
				state,
			};
		}
		if ((approvalMarker ?? "").trim() !== "APPROVED") {
			return {
				ok: false,
				reason:
					`Phase ${state.phase} is gated: an explicit 'APPROVED' marker is ` +
					"required to advance. Ambiguous or missing approval never counts " +
					"(fail-closed). Re-review the phase output and retry with the " +
					"marker.",
				state,
			};
		}
	}

	// CLARIFY gate: nothing starts until the intent is clear. Leaving CLARIFY
	// requires the modality (create|bug) and licensing strategy to be
	// confirmed. In SUPERVISED mode that happens only after the user answers
	// the clarifying interview; an unresolved CLARIFY never auto-advances.
	if (state.phase === "CLARIFY" && next !== "BLOCKED") {
		const unresolved: string[] = [];
		if (state.mode !== "create" && state.mode !== "bug") unresolved.push("mode");
		if (state.licensed !== "enterprise" && state.licensed !== "oca" && state.licensed !== "community") unresolved.push("licensed");
		if (unresolved.length > 0) {
			return {
				ok: false,
				reason:
					`CLARIFY incomplete: before any work, the intent must be clear. ` +
					`Missing: ${unresolved.join(", ")}. In SUPERVISED mode, ask the ` +
					"developer (create vs bug; enterprise/OCA/community licensing " +
					"strategy). In AUTONOMOUS mode, detect them from the request " +
					"before proceeding.",
				state,
			};
		}
	}

	// Spec must be genuinely loaded before leaving READ_SPEC.
	if (state.phase === "READ_SPEC" && next !== "BLOCKED") {
		if (!state.specLoaded || !existsSync(join(state.specDir, "spec.md"))) {
			return {
				ok: false,
				reason: "READ_SPEC cannot advance: specs/<id>/spec.md is missing or was not loaded.",
				state,
			};
		}
	}

	// Regression gate: DONE only after an honest PASSED verdict on disk.
	if (next === "DONE") {
		const verdict = readVerdict(state.specDir);
		if (verdict === null || !verdict.passed) {
			return {
				ok: false,
				reason:
					"Cannot reach DONE: no persisted PASSED verdict in verify-verdict.txt. " +
					"A failed or absent verification can never be reported as success.",
				state,
			};
		}
	}

	// Iteration ceiling: EVERY entry into the verify/fix cycle counts, no
	// matter the source phase — a stuck VERIFY→VERIFY loop cannot evade the
	// ceiling (caught by the smoke test).
	if (next === "VERIFY" || next === "FIX_LOOP") {
		state.iterationsUsed += 1;
		if (state.iterationsUsed > state.maxIterations) {
			state.phase = "BLOCKED";
			kbAppend(
				state,
				"blocker",
				`Iteration ceiling reached (${state.maxIterations}). Last note: ${note}`,
			);
			saveState(state);
			return {
				ok: false,
				reason:
					`BLOCKED: ${state.maxIterations} verify/fix iterations exhausted without a ` +
					"PASSED verdict. Escalate to the developer with the KB and last verdict.",
				state,
			};
		}
	}

	state.phase = next;
	if (next !== "FIX_LOOP") {
		state.failureCount = 0;
		state.diagnosisDone = false;
	}
	kbAppend(state, "decision", `Phase -> ${next}. Approved by ${approvalSource ?? "human"}. ${note}`);
	saveState(state);
	return { ok: true, state, note: `Phase is now ${next}. (approved by ${approvalSource ?? "human"})` };
}

/**
 * Record one failed verification inside the fix loop. Implements the failure
 * ladder: after `maxFailuresBeforeDiagnosis` consecutive failures the caller
 * MUST run a deep-diagnosis step (root-cause analysis by a consultant role)
 * before any further blind retry.
 * @returns guidance for the orchestrating agent.
 */
export function recordFailure(state: SddState, errorSummary: string): {
	requireDiagnosis: boolean;
	state: SddState;
} {
	state.failureCount += 1;
	state.lastVerdictPassed = false;
	kbAppend(state, "blocker", `Verification failure #${state.failureCount}: ${errorSummary.slice(0, 2000)}`);
	let requireDiagnosis = false;
	if (state.failureCount >= state.maxFailuresBeforeDiagnosis && !state.diagnosisDone) {
		requireDiagnosis = true;
		state.diagnosisDone = true;
		kbAppend(
			state,
			"diagnosis",
			"Failure ladder triggered: deep root-cause diagnosis required before the next retry.",
		);
	}
	saveState(state);
	return { requireDiagnosis, state };
}

/** Record one passed verification (persists the honest verdict). */
export function recordSuccess(state: SddState, detail: string): SddState {
	state.failureCount = 0;
	writeVerdict(state, true, detail);
	kbAppend(state, "verdict", "Verification PASSED.");
	saveState(state);
	return state;
}

/** Record a failed verification (persists the honest FAILED verdict). */
export function recordFailedVerdict(state: SddState, detail: string): SddState {
	writeVerdict(state, false, detail);
	kbAppend(state, "verdict", "Verification FAILED (honest verdict persisted).");
	saveState(state);
	return state;
}

/** Required section headings per gated phase/output file. */
const HEADING_REQUIREMENTS: Array<{
	phase: Phase;
	file: string;
	required: string[];
}> = [
	{
		phase: "READ_SPEC",
		file: "spec.md",
		required: ["## Context", "## Acceptance Criteria", "## Constraints", "## Target Odoo Version"],
	},
	{
		phase: "ARCHITECTURE",
		file: "architecture.md",
		required: ["## Models", "## Views", "## Security", "## Manifest"],
	},
	{
		phase: "ARCHITECTURE",
		file: "test-plan.md",
		required: ["| AC", "Scenario"],
	},
];

/** Find which required headings are missing for advancing past `phase`. */
function requiredHeadings(phase: Phase): { file: string; missing: (specDir: string) => string[] } {
	const rules = HEADING_REQUIREMENTS.filter((r) => r.phase === phase);
	if (rules.length === 0) {
		return { file: "", missing: () => [] };
	}
	return {
		file: rules.map((r) => r.file).join(" + "),
		missing: (specDir: string): string[] => {
			const missingFiles: string[] = [];
			const missing: string[] = [];
			for (const rule of rules) {
				const path = join(specDir, rule.file);
				if (!existsSync(path)) {
					missingFiles.push(rule.file);
					continue;
				}
				const text = readFileSync(path, "utf8");
				for (const heading of rule.required) {
					if (!text.includes(heading)) missing.push(`${rule.file}: ${heading}`);
				}
			}
			return missingFiles.map((f) => `${f}: (file missing)`).concat(missing);
		},
	};
}

/** Human-readable snapshot of the pipeline for tool output. */
export function summarize(state: SddState): string {
	const verdict = readVerdict(state.specDir);
	const kb = kbRead(state.specDir);
	const recent = kb.filter((n) => n.kind !== "verdict").slice(-4);
	const logbook =
		recent.length === 0
			? "logbook: (no decisions yet)"
			: "logbook:\n" + recent.map((n) => `  - [${n.kind}] ${n.summary.slice(0, 120)}`).join("\n");
	const lines = [
		`specDir: ${state.specDir}`,
		`phase: ${state.phase}`,
		`failures: ${state.failureCount}/${state.maxFailuresBeforeDiagnosis} (diagnosis ${state.diagnosisDone ? "done" : "pending"})`,
		`iterations: ${state.iterationsUsed}/${state.maxIterations}`,
		`verdict: ${verdict === null ? "none yet" : verdict.passed ? "PASSED" : "FAILED"}`,
		`stop.md: ${stopRequested(state.specDir) === null ? "absent" : "PRESENT — pipeline halted"}`,
		logbook,
	];
	return lines.join("\n");
}

/** Ensure the spec directory exists with its skeleton files. */
export function initSpecDir(specDir: string): void {
	mkdirSync(specDir, { recursive: true });
	for (const [name, body] of [
		[
			"spec.md",
			"# Specification\n\n## Context\n\n<!-- Business context: what problem, who uses it. -->\n\n" +
				"## Acceptance Criteria\n\n- [ ] AC1: ...\n\n## Constraints\n\n<!-- Non-negotiables (version, security, performance). -->\n\n" +
				"## Target Odoo Version\n\n- [ ] V: <V.0>\n",
		],
		[
			"architecture.md",
			"# Architecture\n\n## Models\n\n<!-- New/inherited models, fields, relations, constraints. -->\n\n" +
				"## Views\n\n<!-- XML IDs to inherit, form/tree changes, menus, actions. -->\n\n" +
				"## Security\n\n<!-- Groups, ir.model.access.csv, record rules. -->\n\n" +
				"## Manifest\n\n<!-- Directory layout and exact depends + data. -->\n",
		],
		[
			"test-plan.md",
			"# Test Plan\n\n| AC | Scenario | Layer (static/server/rpc/ui/manual) | Status |\n|---|---|---|---|\n" +
				"| AC1 | ... | static | pending |\n",
		],
	] as const) {
		const file = join(specDir, name);
		if (!existsSync(file)) writeFileSync(file, body);
	}
}
