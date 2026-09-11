/**
 * Append-only audit log for the dsh-odoo-sdd plugin.
 *
 * Every tool execution writes ONE JSON line to `.sdd/audit.jsonl`
 * (`{"ts","tool","op","args","outcome","ms","source","phase","specId","reason"}`),
 * sanitized through sanitizeForPersist so credentials, credential shapes and
 * home paths never land on disk.
 *
 * This is the plugin's concrete implementation of the harness principle
 * "Model-visible means logged": the global tool listener records EVERY tool
 * call the agent makes (not only this plugin's), so the run can be
 * reconstructed from disk. Policy denials are logged too, with their reason.
 *
 * It remains best-effort: the log is never shown to the model and a write
 * failure NEVER blocks the tool that produced the entry.
 *
 * @module dsh-odoo-sdd/audit
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeForPersist, type OdooCredentials } from "./credentials.js";

/** Where an entry came from: a tool call, internal bookkeeping, or the guard. */
export type AuditSource = "tool" | "internal" | "policy";

/** One sanitized audit entry. */
export interface AuditEntry {
	ts: string;
	tool: string;
	op: string;
	args: string;
	outcome: "ok" | "error" | "denied";
	ms: number;
	/** Origin of the entry. */
	source: AuditSource;
	/** SDD phase active when the entry was written, when known. */
	phase?: string;
	/** Spec directory id when known. */
	specId?: string;
	/** Denial or error reason (sanitized), when applicable. */
	reason?: string;
}

/** Fields a caller supplies; the writer stamps `ts` and defaults. */
export interface AuditInput {
	tool: string;
	op?: string;
	args?: unknown;
	outcome?: "ok" | "error" | "denied";
	ms?: number;
	source?: AuditSource;
	phase?: string;
	specId?: string;
	reason?: string;
}

/** Absolute path of the audit log for a project. */
export function auditFile(projectRoot: string): string {
	return join(projectRoot, ".sdd", "audit.jsonl");
}

/** Append one entry best-effort; swallowing any filesystem error. */
function appendAudit(projectRoot: string, entry: AuditEntry): void {
	try {
		const file = auditFile(projectRoot);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 } as never);
	} catch {
		// Best-effort only: an audit write failure must never break a tool.
	}
}

/**
 * Record one audit line, sanitized. The single write path of this module.
 * @returns the entry written (also useful in tests).
 */
export function recordAudit(
	projectRoot: string,
	input: AuditInput,
	credentials: OdooCredentials | null,
): AuditEntry {
	const entry: AuditEntry = {
		ts: new Date().toISOString(),
		tool: input.tool,
		op: sanitizeForPersist(input.op ?? input.tool, credentials),
		args: sanitizeForPersist(safeJson(input.args), credentials),
		outcome: input.outcome ?? "ok",
		ms: input.ms ?? 0,
		source: input.source ?? "internal",
	};
	if (input.phase !== undefined) entry.phase = input.phase;
	if (input.specId !== undefined) entry.specId = input.specId;
	if (input.reason !== undefined) entry.reason = sanitizeForPersist(input.reason.slice(0, 500), credentials);
	appendAudit(projectRoot, entry);
	return entry;
}

/** JSON.stringify that never throws (circular or hostile input). */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return '"[unserializable]"';
	}
}

/**
 * An operation wrapper: runs `fn`, records one audit line, returns result.
 * Kept for tools that already know their credentials and want an inline record.
 */
async function withAudit<T>(
	projectRoot: string,
	tool: string,
	op: string,
	args: unknown,
	credentials: OdooCredentials | null,
	fn: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		const result = await fn();
		recordAudit(projectRoot, { tool, op, args, outcome: "ok", ms: Date.now() - started, source: "tool" }, credentials);
		return result;
	} catch (err) {
		recordAudit(
			projectRoot,
			{
				tool,
				op,
				args,
				outcome: "error",
				ms: Date.now() - started,
				source: "tool",
				reason: err instanceof Error ? err.message : String(err),
			},
			credentials,
		);
		throw err;
	}
}

/**
 * Public best-effort audit writer for internal events (phase changes,
 * clarifying decisions, checkpoints). Never blocks the caller.
 */
export function appendAuditLine(
	projectRoot: string,
	op: string,
	args: unknown,
	credentials: OdooCredentials | null,
	extra: { outcome?: "ok" | "error" | "denied"; phase?: string; specId?: string; reason?: string } = {},
): AuditEntry {
	return recordAudit(
		projectRoot,
		{
			tool: "odoo-sdd",
			op,
			args,
			source: "internal",
			outcome: extra.outcome ?? "ok",
			phase: extra.phase,
			specId: extra.specId,
			reason: extra.reason,
		},
		credentials,
	);
}

export { withAudit };
