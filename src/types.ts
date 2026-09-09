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
	operation: "status" | "init" | "advance" | "fail" | "succeed" | "mark_spec_loaded";
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

/** Deployment configuration schema of the plugin (cordis.patch.yml). */
export interface PluginConfig {
	/** Default workspace root used to locate .env and .sdd/ (falls back to cwd). */
	projectRoot?: string;
	/** Directory (relative to projectRoot) holding specs/<NNN>-<slug>/ folders. */
	specsDir?: string;
}

export type { ModuleInfo, LogEntry, Phase, KbNode, SddState };
