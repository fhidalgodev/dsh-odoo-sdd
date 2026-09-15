/**
 * Public payload types of the dsh-odoo-sdd plugin.
 *
 * These are the model-facing shapes every tool returns. No secret material
 * (passwords, API keys, session cookies) is ever part of a public payload:
 * credentials are described masked, and minted sessions are referenced by
 * file path only.
 *
 * @module dsh-odoo-sdd/types
 */
import type { ModuleInfo, LogEntry } from "./odoo-client.js";
import type { Phase, KbNode, SddState } from "./sdd-state.js";

/** Result of the connectivity/credentials probe (tool `odoo_connect`). */
export interface ConnectReport {
	/** True when the instance answered and authentication succeeded. */
	connected: boolean;
	/** Masked, non-secret description of the target (url/db/user). */
	target: string;
	/** Odoo server version when reachable. */
	serverVersion: string | null;
	/** Authenticated user id when authentication succeeded. */
	uid: number | null;
	/** Sanitized diagnostic when not connected (remediation steps). */
	detail: string;
}

/** Result of a module state/install/upgrade operation (tool `odoo_module`). */
export interface ModuleReport {
	/** Operation that was performed. */
	operation: "info" | "install" | "upgrade";
	/** Post-operation module lifecycle states. */
	modules: ModuleInfo[];
	/** True when the operation completed without a server-side error. */
	success: boolean;
	/** Sanitized server output or traceback (the closed feedback loop). */
	output: string;
}

/** Result of the server log query (tool `odoo_errors`). */
export interface ErrorsReport {
	/** Recent server-side error log rows (redacted). */
	logs: LogEntry[];
	/** Window queried, in minutes. */
	sinceMinutes: number;
}

/** Result of session minting (tool `odoo_session`). */
export interface SessionReport {
	/** True when a session cookie was stored for UI tests. */
	minted: boolean;
	/** Path of the chmod-600 session file (the cookie itself is never returned). */
	sessionFile: string | null;
	/** Authenticated uid. */
	uid: number | null;
	/** Sanitized diagnostic on failure. */
	detail: string;
}

/** Result of a state-machine operation (tool `sdd_phase`). */
export interface PhaseReport {
	/** Operation performed on the state machine. */
	operation: "status" | "init" | "clarify" | "advance" | "fail" | "succeed" | "mark_spec_loaded" | "rollback";
	/** Full human-readable snapshot after the operation. */
	summary: string;
	/** Current phase. */
	phase: Phase;
	/** True when the operation changed state successfully. */
	ok: boolean;
	/** Gate rejection reason or transition note. */
	detail: string;
	/** True when the failure ladder demands a deep-diagnosis step next. */
	requireDiagnosis: boolean;
	/** KB nodes appended by this operation. */
	kbNodes: KbNode[];
}

/**
 * Result of `odoo_execute`.
 *
 * `denied` is a POLICY decision (allowlist, confirmation, missing checkpoint,
 * phase). A server-side failure is NOT a denial: it returns `denied:false` with
 * a `SERVER ERROR …` reason and the traceback in `result`, so a transport-level
 * success is never mistaken for a domain-level success.
 */
export interface ExecuteReport {
	/** True when the call was refused by policy (never leaves the process). */
	denied: boolean;
	/** Outcome line, or the policy/server-error reason. */
	reason: string;
	/** JSON payload of the RPC result, or the redacted server traceback. */
	result: string;
}

/** Deployment configuration schema of the plugin (cordis.patch.yml). */
export interface PluginConfig {
	/** Default workspace root used to locate .env and .sdd/ (falls back to cwd). */
	projectRoot?: string;
	/** Directory (relative to projectRoot) holding specs/<NNN>-<slug>/ folders. */
	specsDir?: string;
	/** Models permitted for MUTATING RPC calls. Empty means mutations are denied. */
	executeAllowlist?: string[];
	/** Odoo Community source, as a git URL. */
	communityRepoUrl?: string;
	/** Odoo Community source, as a local OS path (overrides the URL when set). */
	communityRepoPath?: string;
	/** Odoo Enterprise source, as a git URL. */
	enterpriseRepoUrl?: string;
	/** Odoo Enterprise source, as a local OS path (overrides the URL when set). */
	enterpriseRepoPath?: string;
	/** Delegation mode: human answers the gates, or a human-proxy does. */
	autonomy?: "supervised" | "autonomous";
	/** Licensing strategy; OCA/community is always searched in addition. */
	licensed?: "community" | "enterprise";
	/** Refuse mutations until a checkpoint exists (fail-closed). */
	requireCheckpointBeforeMutation?: boolean;
	/** Require a clean security review before DONE (fail-closed). */
	securityReviewRequired?: boolean;
	/** Require the security interview before ARCHITECTURE (fail-closed). */
	securityInterviewRequired?: boolean;
	/** Record every tool call of the run in .sdd/audit.jsonl. */
	auditAllTools?: boolean;
	/** How many checkpoints to retain. */
	maxCheckpoints?: number;
}

export type { ModuleInfo, LogEntry, Phase, KbNode, SddState };
