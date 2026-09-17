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
import { readJsonWithRecovery, quarantinedSiblings, writeFileAtomic } from "./atomic.js";

/** Ordered pipeline phases (the 5 SDD steps + the CLARIFY entry + terminals). */
export const PHASES = [
	"CLARIFY",
	"READ_SPEC",
	"ARCHITECTURE",
	"APPLY_CONFIG",
	"WRITE_CODE",
	"VERIFY",
	"FIX_LOOP",
	"DONE",
	"BLOCKED",
] as const;

export type Phase = (typeof PHASES)[number];

/** Every pipeline modality. */
export const PIPELINE_MODES = ["create", "bug", "functional"] as const;

/**
 * Pipeline modality: create a new module, resolve a bug on an existing one, or
 * configure/import data on a running instance without writing code.
 */
export type PipelineMode = (typeof PIPELINE_MODES)[number];
/** Licensing strategy for reused functionality. OCA is ALWAYS searched too. */
export type LicenseStrategy = "community" | "enterprise";

/** Narrow an unknown value to a supported pipeline mode. */
export function isPipelineMode(value: unknown): value is PipelineMode {
	return typeof value === "string" && (PIPELINE_MODES as readonly string[]).includes(value);
}

/** Non-terminal phases that require an explicit human/agent approval gate. */
export const GATED_PHASES: readonly Phase[] = ["READ_SPEC", "ARCHITECTURE"];

/**
 * Explicit phase-transition graph for the DEVELOPMENT modes (create/bug).
 * `transition()` refuses a `next` that is not reachable from the current phase,
 * so a run cannot skip phases after CLARIFY (e.g. jump straight to DONE) or move
 * backwards arbitrarily. `BLOCKED` is a reachable escape from every non-terminal
 * phase; `DONE` is reachable from VERIFY/FIX_LOOP once the honest PASSED verdict
 * gate (checked separately) passes.
 *
 * `APPLY_CONFIG` is unreachable here: configuration/import belongs to the
 * functional graph, and keeping it empty is what makes crossing modes impossible.
 */
export const PHASE_EDGES: Record<Phase, readonly Phase[]> = {
	CLARIFY: ["READ_SPEC", "BLOCKED"],
	READ_SPEC: ["ARCHITECTURE", "BLOCKED"],
	ARCHITECTURE: ["WRITE_CODE", "BLOCKED"],
	APPLY_CONFIG: [],
	WRITE_CODE: ["VERIFY", "BLOCKED"],
	VERIFY: ["FIX_LOOP", "DONE", "BLOCKED"],
	FIX_LOOP: ["VERIFY", "DONE", "BLOCKED"],
	DONE: [],
	BLOCKED: [],
};

/**
 * Phase graph for the FUNCTIONAL mode: the deliverable is a configured/imported
 * instance, not source code, so `APPLY_CONFIG` takes the place of `WRITE_CODE`
 * and a fix iteration means preparing and approving ANOTHER batch.
 */
export const PHASE_EDGES_FUNCTIONAL: Record<Phase, readonly Phase[]> = {
	CLARIFY: ["READ_SPEC", "BLOCKED"],
	READ_SPEC: ["ARCHITECTURE", "BLOCKED"],
	ARCHITECTURE: ["APPLY_CONFIG", "BLOCKED"],
	APPLY_CONFIG: ["VERIFY", "BLOCKED"],
	WRITE_CODE: [],
	VERIFY: ["FIX_LOOP", "DONE", "BLOCKED"],
	FIX_LOOP: ["APPLY_CONFIG", "VERIFY", "DONE", "BLOCKED"],
	DONE: [],
	BLOCKED: [],
};

/**
 * Legal transitions out of a phase for one mode. A spec whose mode is still
 * unset (before CLARIFY resolves it) uses the development graph: functional is
 * opt-in, and the CLARIFY gate refuses to leave the phase without a mode anyway.
 */
export function edgesFor(phase: Phase, mode: PipelineMode | null): readonly Phase[] {
	const table = mode === "functional" ? PHASE_EDGES_FUNCTIONAL : PHASE_EDGES;
	return table[phase] ?? [];
}

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
	// A corrupt state file is QUARANTINED (not overwritten) and reported through
	// `corruptionNotes`, so a restart is never silent.
	const read = readJsonWithRecovery<SddState>(file);
	if (read.status === "missing" || read.value === null) return initialState(specDir);
	if (read.value.version !== 1) return initialState(specDir);
	return { ...initialState(specDir), ...read.value, specDir };
}

/** Corrupt state files set aside for this spec (newest first). */
export function corruptionNotes(specDir: string): string[] {
	return [
		...quarantinedSiblings(join(specDir, STATE_FILE)),
		...quarantinedSiblings(join(specDir, KB_FILE)),
	];
}

/** Persist state with an atomic replace (no torn file on crash). */
export function saveState(state: SddState): void {
	mkdirSync(state.specDir, { recursive: true });
	writeFileAtomic(join(state.specDir, STATE_FILE), JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2));
}

/** Append a node to the KB graph (create the file when missing). */
export function kbAppend(state: SddState, kind: KbNode["kind"], summary: string): KbNode {
	const file = join(state.specDir, KB_FILE);
	// Recovery read: a corrupt KB is quarantined so its history stays on disk
	// and the loss is visible in `sdd_phase status`.
	const read = readJsonWithRecovery<KbNode[]>(file);
	let nodes: KbNode[] = Array.isArray(read.value) ? read.value : [];
	const node: KbNode = {
		id: nodes.length > 0 ? Math.max(...nodes.map((n) => n.id)) + 1 : 1,
		kind,
		phase: state.phase,
		summary,
		createdAt: nowIso(),
	};
	nodes.push(node);
	writeFileAtomic(file, JSON.stringify(nodes, null, 2));
	return node;
}

/** Read the KB graph (empty when absent). A corrupt file is quarantined. */
export function kbRead(specDir: string): KbNode[] {
	const read = readJsonWithRecovery<KbNode[]>(join(specDir, KB_FILE));
	return Array.isArray(read.value) ? read.value : [];
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
	// Atomic: a torn verdict file could read as neither PASSED nor FAILED.
	writeFileAtomic(join(state.specDir, VERDICT_FILE), `${header} at ${nowIso()}\n${detail.slice(0, 20000)}\n`);
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
	policy?: { securityReviewRequired?: boolean; documentationPolicy?: string },
): TransitionResult {
	const stop = stopRequested(state.specDir);
	if (stop !== null) {
		kbAppend(state, "blocker", `Pipeline halted by stop.md: ${stop}`);
		saveState(state);
		return { ok: false, reason: `stop.md present — pipeline halted. Reason: ${stop}`, state };
	}

	// Phase-graph gate: `next` must be a legal transition from the current phase
	// (fail-closed). This prevents skipping phases after CLARIFY (e.g. a jump
	// straight to DONE) or moving backwards before the appropriate stage.
	if (next !== state.phase) {
		const allowed = edgesFor(state.phase, state.mode);
		if (!allowed.includes(next)) {
			return {
				ok: false,
				reason:
					`Illegal phase transition ${state.phase} -> ${next}. Allowed from ` +
					`${state.phase}: ${allowed.length > 0 ? allowed.join(", ") : "(none — terminal)"}.`,
				state,
			};
		}
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
		const headings = requiredHeadings(state.phase, state.mode);
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
		// Security content gate: a `## Security` heading with no decisions is
		// NOT a permission model — refuse to approve and say exactly what is
		// missing, so the agent asks instead of inventing.
		if (state.phase === "ARCHITECTURE") {
			const gaps = securityGaps(state.specDir, state.mode);
			if (gaps.length > 0) {
				return {
					ok: false,
					reason:
						"ARCHITECTURE cannot advance: the security model is incomplete. Missing: " +
						gaps.join("; ") +
						(state.mode === "functional"
							? ". Ask the developer which users/groups may run the configured flows and which " +
								"companies are touched, or record an explicit decision; never invent permissions."
							: ". Ask the developer (groups, CRUD matrix per group, record rules) or record an explicit decision; " +
								"never invent permissions."),
					state,
				};
			}
			// Documentation is the other decision ARCHITECTURE must record.
			const docGaps = documentationGaps(state.specDir, state.mode);
			if (docGaps.length > 0) {
				return {
					ok: false,
					reason:
						"ARCHITECTURE cannot advance: the documentation decisions are incomplete. Missing: " +
						docGaps.join("; ") +
						". State the documentation language, the OCA fragments that apply (with their audience) " +
						"and whether index.html, Web Tours and migrations apply — or record an explicit decision.",
					state,
				};
			}
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
		if (!isPipelineMode(state.mode)) unresolved.push("mode");
		if (state.licensed !== "community" && state.licensed !== "enterprise") unresolved.push("licensed");
		if (unresolved.length > 0) {
			return {
				ok: false,
				reason:
					`CLARIFY incomplete: before any work, the intent must be clear. ` +
					`Missing: ${unresolved.join(", ")}. In SUPERVISED mode, ask the ` +
					"developer (create vs bug vs functional/configuration; " +
					"enterprise/OCA/community licensing strategy). In AUTONOMOUS mode, " +
					"detect them from the request before proceeding.",
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
		// A FUNCTIONAL spec closes on its own terms, and they are not negotiable
		// by `documentationPolicy`: the runbook is the only way a human repeats a
		// configuration/import, and the batch executor can change business data,
		// so the security review is mandatory rather than policy-driven.
		if (state.mode === "functional") {
			const runbookGapList = runbookGaps(state.specDir);
			if (runbookGapList.length > 0) {
				return {
					ok: false,
					reason:
						"Cannot reach DONE (functional): the operational runbook is incomplete. " +
						runbookGapList.join(" "),
					state,
				};
			}
			const reviewGaps = securityReviewGaps(state.specDir);
			if (reviewGaps.length > 0) {
				return {
					ok: false,
					reason:
						"Cannot reach DONE (functional): a run that changed business data needs the security " +
						"review. " + reviewGaps.join(" "),
					state,
				};
			}
		}
		// Documentation is a declared policy too (required by default).
		if (state.mode !== "functional" && policy?.documentationPolicy === "required") {
			const docsGaps = documentationReviewGaps(state.specDir);
			if (docsGaps.length > 0) {
				return {
					ok: false,
					reason:
						"Cannot reach DONE: documentation is required but incomplete. " + docsGaps.join(" "),
					state,
				};
			}
		}
		// Security review is a declared policy, so it must be a real gate: with
		// `securityReviewRequired` armed a PASSED verdict alone is not enough.
		if (policy?.securityReviewRequired === true) {
			const gaps = securityReviewGaps(state.specDir);
			if (gaps.length > 0) {
				return {
					ok: false,
					reason:
						"Cannot reach DONE: securityReviewRequired is armed but the security review is " +
						"missing or rejected. " + gaps.join(" "),
					state,
				};
			}
		}
	}

	// Iteration ceiling: EVERY entry into the verify/fix cycle counts, no
	// matter the source phase — a stuck VERIFY→VERIFY loop cannot evade the
	// ceiling (caught by the smoke test).
	if (next === "VERIFY" || next === "FIX_LOOP") {
		// Failure ladder: retrying while a diagnosis is OWED is the "blind
		// retry" the ladder exists to prevent, so the transition is refused
		// until the diagnosis is recorded.
		if (diagnosisPending(state)) {
			return {
				ok: false,
				reason:
					`Retry refused: ${state.failureCount} consecutive failures reached the diagnosis threshold. ` +
					"Record a root-cause analysis first (sdd_phase operation=diagnose with the consultant's " +
					"findings) — blind retries are not allowed.",
				state,
			};
		}
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
 * Whether the failure ladder is waiting for a real diagnosis. Derived from the
 * failure streak and the recorded-diagnosis flag, so it can never be satisfied
 * by merely ASKING for the diagnosis.
 * @param state - current spec state.
 * @returns true while a recorded diagnosis is still owed.
 */
export function diagnosisPending(state: SddState): boolean {
	return state.failureCount >= state.maxFailuresBeforeDiagnosis && !state.diagnosisDone;
}

/**
 * Record one failed verification inside the fix loop. Implements the failure
 * ladder: after `maxFailuresBeforeDiagnosis` consecutive failures the caller
 * MUST run a deep-diagnosis step (root-cause analysis by a consultant role)
 * before any further blind retry. The ladder demanding a diagnosis does NOT
 * satisfy it — only {@link recordDiagnosis} does.
 * @returns guidance for the orchestrating agent.
 */
export function recordFailure(state: SddState, errorSummary: string): {
	requireDiagnosis: boolean;
	state: SddState;
} {
	state.failureCount += 1;
	state.lastVerdictPassed = false;
	kbAppend(state, "blocker", `Verification failure #${state.failureCount}: ${errorSummary.slice(0, 2000)}`);
	// NOTE: deliberately does NOT set `diagnosisDone` and does NOT write a
	// "diagnosis" node — this only records that one is OWED.
	const requireDiagnosis = diagnosisPending(state);
	if (requireDiagnosis) {
		kbAppend(
			state,
			"blocker",
			"Failure ladder triggered: a deep root-cause diagnosis must be RECORDED (sdd_phase operation=diagnose) before the next retry.",
		);
	}
	saveState(state);
	return { requireDiagnosis, state };
}

/**
 * Record the deep root-cause diagnosis owed after the failure ladder trips.
 * This is the only transition that clears {@link diagnosisPending}.
 * @param state - current spec state.
 * @param detail - the consultant's root-cause findings.
 * @returns the updated state.
 */
export function recordDiagnosis(state: SddState, detail: string): SddState {
	state.diagnosisDone = true;
	kbAppend(state, "diagnosis", detail.slice(0, 4000) || "root-cause diagnosis recorded");
	saveState(state);
	return state;
}

/**
 * Record one passed verification (persists the honest verdict).
 *
 * A PASSED verdict is an evidence claim, not a mood: every acceptance criterion
 * in `test-plan.md` must have moved past `pending`. When any is still open the
 * verdict is REFUSED and nothing is written, so a green verdict always maps to
 * a tested criterion.
 * @param state - current spec state.
 * @param detail - human-readable evidence summary.
 * @returns whether the verdict was persisted, the updated state, and the gaps.
 */
export function recordSuccess(state: SddState, detail: string): { ok: boolean; state: SddState; gaps: string[] } {
	const gaps = evidenceGaps(state.specDir);
	if (gaps.length > 0) {
		return { ok: false, state, gaps };
	}
	state.failureCount = 0;
	writeVerdict(state, true, detail);
	kbAppend(state, "verdict", "Verification PASSED.");
	saveState(state);
	return { ok: true, state, gaps: [] };
}

/** Record a failed verification (persists the honest FAILED verdict). */
export function recordFailedVerdict(state: SddState, detail: string): SddState {
	writeVerdict(state, false, detail);
	kbAppend(state, "verdict", "Verification FAILED (honest verdict persisted).");
	saveState(state);
	return state;
}

/** Required section headings per gated phase/output file. */
interface HeadingRule {
	phase: Phase;
	file: string;
	required: string[];
}

/** Headings the DEVELOPMENT modes (create/bug) must produce. */
const HEADING_REQUIREMENTS: HeadingRule[] = [
	{
		phase: "READ_SPEC",
		file: "spec.md",
		required: ["## Context", "## Acceptance Criteria", "## Constraints", "## Target Odoo Version"],
	},
	{
		phase: "ARCHITECTURE",
		file: "architecture.md",
		required: ["## Models", "## Views", "## Security", "## Manifest", "## Documentation"],
	},
	{
		phase: "ARCHITECTURE",
		file: "test-plan.md",
		required: ["| AC", "Scenario"],
	},
];

/**
 * Headings the FUNCTIONAL mode must produce.
 *
 * The gates are not disabled for a configuration/import run, they are REPLACED
 * by the decisions that run actually needs: what is configured, where it
 * applies, who may do it, in which companies, how it is validated and how it is
 * undone. Asking a functional run for `## Manifest` or an ACL CSV would be
 * asking it to invent a module that does not exist.
 */
const HEADING_REQUIREMENTS_FUNCTIONAL: HeadingRule[] = [
	{
		phase: "READ_SPEC",
		file: "spec.md",
		// `## Sources and Decisions` is the functional addition: business facts
		// must be traceable to a source, an explicit hypothesis or a confirmation.
		required: [
			"## Context",
			"## Sources and Decisions",
			"## Acceptance Criteria",
			"## Constraints",
			"## Target Odoo Version",
		],
	},
	{
		phase: "ARCHITECTURE",
		file: "architecture.md",
		required: [
			"## Functional Design",
			"## Destination",
			"## Operations",
			"## Access and Companies",
			"## Validation",
			"## Risks and Recovery",
			"## Documentation",
		],
	},
	{
		phase: "ARCHITECTURE",
		file: "test-plan.md",
		required: ["| AC", "Scenario"],
	},
];

/** The heading rules that apply to one mode. */
function headingRules(mode: PipelineMode | null): HeadingRule[] {
	return mode === "functional" ? HEADING_REQUIREMENTS_FUNCTIONAL : HEADING_REQUIREMENTS;
}

/**
 * Closing gate for a FUNCTIONAL spec: the runbook must exist and carry its
 * sections with real content (template comments do not count). The runbook IS
 * the documentation deliverable of a change that ships no code, so it is
 * required regardless of `documentationPolicy`.
 */
export const RUNBOOK_FILE = "functional-runbook.md";
export const RUNBOOK_REQUIREMENTS = [
	"## Batches applied",
	"## Procedures",
	"## Verification evidence",
	"## Recovery",
];

/**
 * List the unmet runbook requirements of a functional spec.
 * @param specDir - spec directory holding the runbook.
 * @returns the list of unmet requirements (empty when complete).
 */
export function runbookGaps(specDir: string): string[] {
	const path = join(specDir, RUNBOOK_FILE);
	if (!existsSync(path)) {
		return [
			`${RUNBOOK_FILE} is missing: a functional run closes only with a procedure a human can ` +
				"repeat (generate or refresh it with sdd_handoff).",
		];
	}
	const text = readFileSync(path, "utf8");
	const gaps: string[] = [];
	for (const heading of RUNBOOK_REQUIREMENTS) {
		const idx = text.indexOf(heading);
		if (idx < 0) {
			gaps.push(`${RUNBOOK_FILE}: ${heading} is missing`);
			continue;
		}
		const rest = text.slice(idx + heading.length);
		const next = rest.indexOf("\n## ");
		const body = (next < 0 ? rest : rest.slice(0, next)).replace(/<!--[\s\S]*?-->/g, "").trim();
		if (body === "" || /^\(none\)$/i.test(body)) {
			gaps.push(`${RUNBOOK_FILE}: ${heading} has no content`);
		}
	}
	return gaps;
}

/**
 * Content-level security gate for ARCHITECTURE: the `## Security` section must
 * actually say WHO may do WHAT. A heading alone is not a decision, and an
 * undefined permission model is exactly where an agent starts inventing one.
 * Each gap is reported with the concrete fix.
 */
/** Body of one `## <heading>` section, with template comments stripped. */
function sectionBody(text: string, heading: string): string {
	const idx = text.indexOf(heading);
	if (idx < 0) return "";
	const rest = text.slice(idx + heading.length);
	const next = rest.indexOf("\n## ");
	return (next < 0 ? rest : rest.slice(0, next)).replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Functional counterpart of the security gate: `## Access and Companies` must
 * decide WHO may run the configured flows, WHICH companies are touched, and
 * whether the permission model changes at all. Same fail-closed posture — a
 * heading with no decision is a gap — but the decisions are the ones a
 * configuration run can actually take (no ACL CSV exists to name).
 * @param text - architecture.md content.
 * @returns the list of missing decisions.
 */
function functionalAccessGaps(text: string): string[] {
	const section = sectionBody(text, "## Access and Companies");
	if (section === "") {
		return ["`## Access and Companies` is empty (template comments do not count as a decision)"];
	}
	const gaps: string[] = [];
	const lower = section.toLowerCase();
	// Who: a named user/group, a role, or an explicit "no access change" decision.
	const hasWho = /group|grupo|user|usuario|role|rol|permiso|access|acceso|administrador/i.test(section);
	if (!hasWho) gaps.push("`## Access and Companies`: state who may run the configured flows (users/groups/roles)");
	// Companies: multi-company is the classic silent disaster here.
	const hasCompanies = /compan(y|ies)|compa[ñn][íi]a|multicompany|multi-company|multiempresa|allowed_company_ids|company_id/i.test(section);
	if (!hasCompanies) gaps.push("`## Access and Companies`: state which company/companies the configuration touches");
	// The permission decision itself, in either direction.
	const aclChange = /ir\.model\.access|access\.csv|acl|record rule|ir\.rule|permiso|privilegio/i.test(section);
	const aclWaived = /(no|sin|not|ninguna|n\/a)\s+.{0,24}(acl|permiso|privilegio|access|record rule|regla)/i.test(lower);
	if (!aclChange && !aclWaived) {
		gaps.push("`## Access and Companies`: state whether the permission model changes, or that none is needed");
	}
	return gaps;
}

/**
 * Content-level security gate for ARCHITECTURE: the security section must
 * actually say WHO may do WHAT. A heading alone is not a decision, and an
 * undefined permission model is exactly where an agent starts inventing one.
 * Each gap is reported with the concrete fix.
 * @param specDir - spec directory holding architecture.md.
 * @param mode - pipeline mode; the functional mode checks access/companies.
 * @returns the list of missing decisions (empty when complete).
 */
export function securityGaps(specDir: string, mode: PipelineMode | null = null): string[] {
	const path = join(specDir, "architecture.md");
	if (!existsSync(path)) return ["architecture.md is missing"];
	const text = readFileSync(path, "utf8");
	if (mode === "functional") return functionalAccessGaps(text);
	const security = (() => {
		const idx = text.indexOf("## Security");
		if (idx < 0) return "";
		const rest = text.slice(idx + "## Security".length);
		const next = rest.indexOf("\n## ");
		return next < 0 ? rest : rest.slice(0, next);
	})();
	const gaps: string[] = [];
	const lower = security.toLowerCase();
	if (security.trim() === "") {
		gaps.push("`## Security` is empty");
		return gaps;
	}
	// Groups: a named group, an xmlid, or an explicit "no new groups" decision.
	const hasGroups = /group_|groups?\b|res\.groups|privilegio|permiso/i.test(security);
	// Access control: the ACL artifact must be named, with a CRUD matrix.
	const hasAcl = /ir\.model\.access|access\.csv|model_access|acl\b/i.test(security);
	const hasCrudMatrix = /\b(read|leer)\b/i.test(lower) && /\b(write|escribir)\b/i.test(lower) && /\b(create|crear)\b/i.test(lower);
	// Record rules: either defined, or explicitly declared unnecessary.
	const hasRules = /ir\.rule|record rule|regla(s)? de registro/i.test(security);
	const rulesWaived = /(no|sin|not|ninguna|n\/a)\s+.{0,20}(record rule|ir\.rule|regla)/i.test(security);
	if (!hasGroups) gaps.push("`## Security`: name the groups involved (existing xmlids or new groups to create)");
	if (!hasAcl) gaps.push("`## Security`: state the access-control artifact (`security/ir.model.access.csv`)");
	if (!hasCrudMatrix) gaps.push("`## Security`: give the per-group CRUD matrix (read/create/write/unlink)");
	if (!hasRules && !rulesWaived) gaps.push("`## Security`: define the record rules OR explicitly state that none are needed");
	return gaps;
}

/**
 * The ONLY status a test-plan row may carry to close its acceptance criterion.
 *
 * Fail-closed on purpose: the previous check listed the four values it rejected
 * (`""`, `pending`, `todo`, `-`), so every OTHER token — `failed`, `unknown`,
 * `manual`, `blocked`, a typo — passed the gate and let `sdd_phase succeed`
 * persist a PASSED verdict with an unverified (or explicitly failed) criterion.
 * An allowlist inverts that: anything that is not an explicit pass is a gap, and
 * an optional parenthetical carries the evidence without weakening the token.
 */
const AC_PASS_PATTERN = /^(pass|passed)(\s*\(.*\))?$/;

/**
 * Normalize one Status cell before matching: case, surrounding spaces, and the
 * markdown decorations an author may wrap the value in.
 * @param cell - raw cell text.
 * @returns the comparable value.
 */
function normalizeAcStatus(cell: string): string {
	return cell.replace(/[`*]/g, "").trim().toLowerCase();
}

/**
 * Evidence gate behind a PASSED verdict: every acceptance criterion in
 * `test-plan.md` must carry an explicit PASS. Returns one entry per gap so the
 * caller can name exactly what is untested.
 *
 * FAIL-CLOSED: only `pass` / `passed` (optionally `pass (evidence…)`) closes a
 * criterion. A pending, failed, unknown, manual-without-confirmation or
 * unrecognized status is a gap; a missing row set is a gap.
 * @param specDir - spec directory holding test-plan.md.
 * @returns the list of unmet evidence requirements (empty when complete).
 */
export function evidenceGaps(specDir: string): string[] {
	const path = join(specDir, "test-plan.md");
	if (!existsSync(path)) {
		return ["test-plan.md is missing: a PASSED verdict needs per-AC evidence."];
	}
	const text = readFileSync(path, "utf8");
	const gaps: string[] = [];
	let rows = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line.split("|");
		// Drop the empty fields produced by the outer pipes.
		const cols = cells.slice(1, cells.length - 1).map((c) => c.trim());
		if (cols.length < 4) continue;
		if (/^[-: ]+$/.test(cols[0])) continue; // markdown separator row
		if (/^ac$/i.test(cols[0])) continue; // header row
		rows += 1;
		const status = normalizeAcStatus(cols[3]);
		if (!AC_PASS_PATTERN.test(status)) {
			gaps.push(
				`AC "${cols[0]}" reads "${cols[3]}" in test-plan.md: only an explicit ` +
					'`pass` (optionally `pass (evidence…)`) closes an acceptance criterion — ' +
					"record the real result, and a manual criterion needs the human confirmation first.",
			);
		}
	}
	if (rows === 0) {
		gaps.push("test-plan.md has no AC rows: a PASSED verdict needs per-AC evidence.");
	}
	return gaps;
}

/**
 * Content gate for the `## Documentation` section of `architecture.md`.
 *
 * A heading alone is not a decision: the section must state the language, the
 * OCA fragments that apply (with their Diátaxis audience) and whether
 * `index.html`, Web Tours and migrations apply. An explicit "no extra
 * fragments" is a valid answer — silence is not.
 * @param specDir - spec directory holding architecture.md.
 * @returns the list of missing decisions (empty when complete).
 */
export function documentationGaps(specDir: string, mode: PipelineMode | null = null): string[] {
	const path = join(specDir, "architecture.md");
	if (!existsSync(path)) return ["architecture.md is missing"];
	const text = readFileSync(path, "utf8");
	if (mode === "functional") {
		const section = sectionBody(text, "## Documentation");
		if (section === "") {
			return ["`## Documentation` is empty (template comments do not count as a decision)"];
		}
		const gaps: string[] = [];
		if (!/\b(en|es|pt|fr|de|it)\b|english|espa[ñn]ol|spanish|language|idioma/i.test(section)) {
			gaps.push("state the language of the operational documentation (default English unless the project says otherwise)");
		}
		if (!/runbook|procedimiento|procedure|manual/i.test(section)) {
			gaps.push(`state that the deliverable is the operational runbook (${RUNBOOK_FILE})`);
		}
		// The "no module, no OCA fragments" decision must be explicit, so nobody
		// later interprets a missing README.rst as an omission.
		const noModule = /(no (oca )?(fragments?|readme|module)|sin (fragmentos|readme|m[óo]dulo)|not applicable)/i.test(section);
		if (!noModule) {
			gaps.push("state explicitly that no OCA fragments or index.html are produced (there is no module)");
		}
		return gaps;
	}
	const idx = text.indexOf("## Documentation");
	if (idx < 0) return ["`## Documentation` is missing"];
	const rest = text.slice(idx + "## Documentation".length);
	const next = rest.indexOf("\n## ");
	// Strip HTML comments: the template's own guidance is not a decision, so an
	// untouched skeleton must NOT satisfy the gate.
	const section = (next < 0 ? rest : rest.slice(0, next)).replace(/<!--[\s\S]*?-->/g, "").trim();
	if (section === "") return ["`## Documentation` is empty (template comments do not count as a decision)"];
	const gaps: string[] = [];
	// Language must be decided (a code such as en/es, or an explicit statement).
	if (!/\b(en|es|pt|fr|de|it)\b|english|espa[ñn]ol|spanish|language|idioma/i.test(section)) {
		gaps.push("state the documentation language (default English unless the project says otherwise)");
	}
	// The fragment decision must be explicit, in either direction.
	const namesFragments = /description\.md|usage\.md|context\.md|configure\.md|install\.md|roadmap\.md|contributors\.md/i.test(section);
	const statesNone = /(no (extra )?(fragments?|readme)|sin fragmentos|not applicable)/i.test(section);
	if (!namesFragments && !statesNone) {
		gaps.push("list the OCA fragments that apply (DESCRIPTION/USAGE/CONTEXT/…) or state \"no extra fragments\"");
	}
	// Audience mapping is what makes the section a Diátaxis decision.
	if (!/di[aá]taxis|tutorial|how-?to|reference|explanation|audiencia|audience/i.test(section)) {
		gaps.push("map each fragment to its audience (Diátaxis: Tutorial/How-to/Reference/Explanation)");
	}
	return gaps;
}

/**
 * Documentation gate for DONE when the policy is `required`: the review record
 * must exist with an APPROVED verdict and no ERROR findings.
 * @param specDir - spec directory holding docs-report.md.
 * @returns the list of unmet requirements (empty when clean).
 */
export function documentationReviewGaps(specDir: string): string[] {
	const path = join(specDir, "docs-report.md");
	if (!existsSync(path)) {
		return [
			"Run `odoo_docs operation=report spec_id=<id>` to record the documentation outcome " +
				"(fragments, changelog, findings) in specs/<id>/docs-report.md.",
		];
	}
	const text = readFileSync(path, "utf8");
	if (/\bREJECTED\b|\bFAILED\b/i.test(text)) {
		return ["docs-report.md records a REJECTED/FAILED verdict; fix the findings and re-run."];
	}
	if (/Verdict:\s*NEEDS_CONTENT/i.test(text)) {
		return ["docs-report.md verdict is NEEDS_CONTENT (a fragment is still a scaffold or an ERROR remains)."];
	}
	if (!/Verdict:\s*APPROVED/i.test(text)) {
		return ["docs-report.md carries no machine-readable `Verdict: APPROVED` line."];
	}
	return [];
}

/**
 * Security-review gate for DONE when `securityReviewRequired` is armed. A
 * REJECTED report always blocks; an absent report or one without a verdict
 * line blocks too (fail-closed), because "no finding" is not "reviewed".
 * @param specDir - spec directory holding security-report.md.
 * @returns the list of unmet requirements (empty when the review is clean).
 */
export function securityReviewGaps(specDir: string): string[] {
	const path = join(specDir, "security-report.md");
	if (!existsSync(path)) {
		return [
			"Write specs/<id>/security-report.md from the security-reviewer persona (groups, ACLs, " +
				"record rules, risky patterns) before claiming DONE.",
		];
	}
	const text = readFileSync(path, "utf8");
	if (/\bREJECTED\b|\bFAILED\b/i.test(text)) {
		return ["security-report.md records a REJECTED/FAILED verdict; fix the findings and re-review."];
	}
	if (!/\bAPPROVED\b|\bPASSED\b/i.test(text)) {
		return ["security-report.md carries no APPROVED/PASSED verdict line."];
	}
	return [];
}

const EXTRA_VIEW_TYPES =
	/\b(search|kanban|pivot|graph|calendar|dashboard|gantt|activity|map|cohort|funnel)\b/i;
const NO_EXTRA_VIEWS = /(form\s*\+\s*tree|no extra view|solo\s+form|only form)/i;
const REPORT_KEYWORDS =
	/\b(report|pdf|sql|csv|xlsx|export|qweb|ir\.actions\.report|\breport\b)\b/i;
const NO_REPORTS = /no reports needed|no report (is )?needed|sin reportes|no requiere reportes/i;
/** A tour decision can be refused explicitly, in either language. */
const NO_TOURS = /no tours?( needed| required)?|sin tours|no tours? (are )?needed/i;
/** The asset bundle is the part that makes a tour actually run. */
const TOUR_BUNDLE = /assets_tests|assets_backend|assets_frontend|web\.assets/i;
const NO_DEMO = /no demo( data)?|sin datos demo|no demo data|n\/a/i;

/**
 * Informational, NON-blocking design inventory for ARCHITECTURE. Unlike the
 * security model (which IS a fail-closed gate), extra view types and reports
 * are guide decisions the developer should answer, not hard gates: if the
 * architect did not ask/decide them, we surface a warning so the agent asks
 * instead of leaving an implicit assumption — but we never refuse to advance.
 */
export function designWarnings(specDir: string, mode: PipelineMode | null = null): string[] {
	// A functional spec ships no views and no reports: the inventory below would
	// warn about sections that must not exist there.
	if (mode === "functional") return [];
	const path = join(specDir, "architecture.md");
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const section = (heading: string): string => {
		const idx = text.indexOf(`## ${heading}`);
		if (idx < 0) return "";
		const rest = text.slice(idx + `## ${heading}`.length);
		const next = rest.indexOf("\n## ");
		return next < 0 ? rest : rest.slice(0, next);
	};
	const warnings: string[] = [];
	const views = section("Views");
	if (views.trim() !== "" && !EXTRA_VIEW_TYPES.test(views) && !NO_EXTRA_VIEWS.test(views)) {
		warnings.push(
			"`## Views`: no extra view type declared — confirm whether any model needs a search view " +
			"(custom filters/favorites), kanban/pivot/graph/calendar/dashboard/… beyond form/tree, or " +
			"write \"form + tree only (no extra view types)\".",
		);
	}
	const reports = section("Reports");
	if (reports.trim() === "") {
		warnings.push(
			"`## Reports` is missing — state which reports (PDF/SQL/CSV/XLSX/dashboard) are needed and in " +
			"which medium, or write \"no reports needed\".",
		);
	} else if (!NO_REPORTS.test(reports) && !REPORT_KEYWORDS.test(reports)) {
		warnings.push(
			"`## Reports` looks empty — name the report(s) and their medium, or write \"no reports needed\".",
		);
	}
	// Tours and demo data are asked only where they are a design decision: a bug
	// fix is scoped to a defect, and demanding a tour inventory there would be
	// noise. Views/Reports keep their existing behaviour in every dev mode.
	if (mode !== "bug") {
		const tours = section("Tours");
		const tourBody = tours.replace(/<!--[\s\S]*?-->/g, "").trim();
		if (tours.trim() === "") {
			warnings.push(
				"`## Tours` is missing — state which web tours ship (onboarding, test, or both), which asset " +
				"bundle loads each one, and on which versions, or write \"no tours needed\" (see " +
				"`skills/odoo-sdd-workflow/references/tours-and-demo.md`).",
			);
		} else if (tourBody === "") {
			warnings.push(
				"`## Tours` looks empty — name the tours and the bundle that loads them " +
				"(`web.assets_tests` for a test tour, backend/frontend for onboarding), or write \"no tours needed\".",
			);
		} else if (!NO_TOURS.test(tourBody) && !TOUR_BUNDLE.test(tourBody)) {
			// The trap this exists for: a tour file that no bundle loads is dead
			// code, and nothing else in the pipeline notices.
			warnings.push(
				"`## Tours` declares tours but no asset bundle — a tour outside its bundle never runs: name " +
				"`web.assets_tests` (test) or `web.assets_backend`/`web.assets_frontend` (onboarding), and the " +
				"`HttpCase` + `start_tour` that executes it.",
			);
		}
		const demo = section("Demo data");
		const demoBody = demo.replace(/<!--[\s\S]*?-->/g, "").trim();
		if (demo.trim() === "") {
			warnings.push(
				"`## Demo data` is missing — state whether the module ships demo data, in which files, and what " +
				"it is for, or write \"no demo data\". The functionality must never depend on it: production " +
				"databases are created without demo.",
			);
		} else if (demoBody === "") {
			warnings.push(
				"`## Demo data` looks empty — name the files and their purpose, or write \"no demo data\".",
			);
		}
	}
	return warnings;
}

/** Find which required headings are missing for advancing past `phase`. */
function requiredHeadings(
	phase: Phase,
	mode: PipelineMode | null,
): { file: string; missing: (specDir: string) => string[] } {
	const rules = headingRules(mode).filter((r) => r.phase === phase);
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
	const designWarn = state.phase === "ARCHITECTURE" ? designWarnings(state.specDir, state.mode) : [];
	if (designWarn.length > 0) {
		lines.push("design (guide, non-blocking):");
		for (const w of designWarn) lines.push(`  - ${w}`);
	}
	// A quarantined state/KB file means progress was lost: say so instead of
	// presenting a fresh state as if nothing happened.
	const corrupt = corruptionNotes(state.specDir);
	if (corrupt.length > 0) {
		lines.push("RECOVERED FROM CORRUPTION (state was reset; originals kept):");
		for (const c of corrupt.slice(0, 3)) lines.push(`  - ${c}`);
	}
	return lines.join("\n");
}

/** Ensure the spec directory exists with the skeleton files of one mode. */
export function initSpecDir(specDir: string, mode: PipelineMode | null = null): void {
	mkdirSync(specDir, { recursive: true });
	// The test plan is identical in every mode: an acceptance criterion is an
	// acceptance criterion, and the explicit-pass gate reads the same table.
	const testPlan: [string, string] = [
		"test-plan.md",
		"# Test Plan\n\n| AC | Scenario | Layer (static/server/rpc/ui/manual) | Status |\n|---|---|---|---|\n" +
			"| AC1 | ... | static | pending |\n\n" +
			"<!-- Status must become an explicit `pass` (optionally `pass (evidence: …)`) for\n" +
			"     every row: `sdd_phase succeed` refuses `pending`, `failed`, `unknown`,\n" +
			"     `manual` and anything it cannot read as a pass. -->\n",
	];
	const development: Array<[string, string]> = [
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
				"## Tours\n\n<!-- Onboarding and/or test web tours, each one with the asset bundle that\n" +
				"     loads it (web.assets_tests for a test tour, backend/frontend for onboarding) and\n" +
				"     the HttpCase + start_tour that executes it — or \"no tours needed\". A tour that no\n" +
				"     bundle loads never runs. See\n" +
				"     skills/odoo-sdd-workflow/references/tours-and-demo.md for the per-version API. -->\n\n" +
				"## Demo data\n\n<!-- Files under demo/ declared in the manifest's \"demo\" key and what they\n" +
				"     are for (fixtures, demonstration) — or \"no demo data\". The functionality must\n" +
				"     never depend on it: production databases are created without demo. -->\n\n" +
				"## Security\n\n<!-- Groups, ir.model.access.csv, record rules. -->\n\n" +
				"## Manifest\n\n<!-- Directory layout and exact depends + data. -->\n\n" +
				"## Documentation\n\n<!-- Language (default English unless the project says otherwise), the OCA\n" +
				"     readme fragments that apply mapped to their Diátaxis audience (Tutorial/How-to/\n" +
				"     Reference/Explanation), and whether index.html, Web Tours and migrations apply.\n" +
				"     Write \"no extra fragments\" explicitly when none are needed. -->\n",
		],
		testPlan,
	];
	/**
	 * Functional templates: the deliverables of a run that configures and
	 * imports, so the sections are the decisions it must take (destination,
	 * operations, access/companies, validation, recovery, runbook) instead of
	 * models/views/manifest for a module that will never exist.
	 */
	const functional: Array<[string, string]> = [
		[
			"spec.md",
			"# Functional specification\n\n## Context\n\n<!-- Current situation and why a change is needed. -->\n\n" +
				"## Sources and Decisions\n\n<!-- For every business fact: the SOURCE it came from (page, file,\n" +
				"     document, human), the HYPOTHESES still open, and the CONFIRMED decisions with who\n" +
				"     confirmed them. Never present a deduction as a confirmation. -->\n\n" +
				"## Acceptance Criteria\n\n- [ ] AC1: ...\n\n" +
				"## Constraints\n\n<!-- Non-negotiables: environment, company, users, fiscal/legal review, volume. -->\n\n" +
				"## Target Odoo Version\n\n- [ ] V: <detected, with how it was detected>\n",
		],
		[
			"architecture.md",
			"# Functional architecture\n\n## Functional Design\n\n<!-- The to-be process in business terms. -->\n\n" +
				"## Destination\n\n<!-- Instance, database, environment (dev/staging/production), companies and the\n" +
				"     modules/capabilities the version actually provides. -->\n\n" +
				"## Operations\n\n<!-- The ordered batches: model/method/fields, dependencies, record identity,\n" +
				"     preconditions, expected result. Import batches list their columns here and keep the\n" +
				"     machine-readable mapping in mapping.json. -->\n\n" +
				"## Access and Companies\n\n<!-- Who may run these flows (users/groups/roles), which companies are\n" +
				"     touched, and whether the permission model (ACLs, record rules) changes — or an explicit\n" +
				"     \"no permission change needed\". -->\n\n" +
				"## Validation\n\n<!-- How each batch is validated after applying it (re-reads, counts, business checks). -->\n\n" +
				"## Risks and Recovery\n\n<!-- Risks, rollback limits, how each batch is undone, and what CANNOT be undone. -->\n\n" +
				"## Documentation\n\n<!-- Language of the operational documentation, the runbook as the deliverable,\n" +
				"     and an explicit statement that no OCA fragments or index.html are produced (there is no\n" +
				"     module). -->\n",
		],
		testPlan,
	];
	for (const [name, body] of mode === "functional" ? functional : development) {
		const file = join(specDir, name);
		if (!existsSync(file)) writeFileSync(file, body);
	}
}

/**
 * Record the intent of a run (mode + licensing) exactly once.
 *
 * The mode decides which phase graph and which content gates apply, so it is
 * frozen the moment real work starts: while the spec is still in CLARIFY and
 * nothing was loaded, a change is allowed (the developer may correct the
 * request); afterwards it is refused — switching here would let a run change the
 * rules it is being judged by, and crossing development and functional is not a
 * change of plan but a different job.
 * @param state - the spec state to update (in place).
 * @param mode - requested mode.
 * @param licensed - requested licensing strategy.
 * @returns whether the intent was recorded, and why not when it was not.
 */
export function recordIntent(
	state: SddState,
	mode: PipelineMode,
	licensed: LicenseStrategy,
): { ok: boolean; reason?: string } {
	const settled = state.mode !== null && (state.phase !== "CLARIFY" || state.specLoaded);
	if (settled && state.mode !== mode) {
		return {
			ok: false,
			reason:
				`This spec is already running as "${state.mode}" (phase ${state.phase}` +
				`${state.specLoaded ? ", spec loaded" : ""}). The mode decides which phase graph and ` +
				"which gates apply, so it cannot change mid-run: create a new spec id for a " +
				`"${mode}" job.`,
		};
	}
	state.mode = mode;
	state.licensed = licensed;
	return { ok: true };
}
