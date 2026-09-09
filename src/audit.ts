/**
 * Append-only audit log for the dsh-odoo-sdd plugin.
 *
 * Every tool execution writes ONE line to `.sdd/audit.jsonl`
 * (`{"ts":..., "tool":..., "op":..., "args":..., "outcome":..., "ms":...}`),
 * sanitized through sanitizeForPersist so credentials, credential shapes and
 * home paths never land on disk.
 *
 * The audit log is a best-effort approximation of the project's logbook for
 * the developer's forensic use — it is never shown to the model and a write
 * failure NEVER blocks the tool that produced the entry.
 *
 * @module dsh-odoo-sdd/audit
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeForPersist, type OdooCredentials } from "./credentials.js";

/** One sanitized audit entry. */
interface AuditEntry {
	ts: string;
	tool: string;
	op: string;
	args: string;
	outcome: "ok" | "error";
	ms: number;
}

/** An operation wrapper: runs `fn`, records one audit line, returns result. */
async function withAudit<T>(
	projectRoot: string,
	tool: string,
	op: string,
	args: unknown,
	credentials: OdooCredentials | null,
	fn: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	let result: T;
	let outcome: "ok" | "error" = "ok";
	try {
		result = await fn();
		return result;
	} catch (err) {
		outcome = "error";
		throw err;
	} finally {
		const entry: AuditEntry = {
			ts: new Date().toISOString(),
			tool,
			op: sanitizeForPersist(op, credentials),
			args: sanitizeForPersist(JSON.stringify(args), credentials),
			outcome,
			ms: Date.now() - started,
		};
		appendAudit(projectRoot, entry, credentials);
	}
}

/** Append one entry best-effort; swallowing any filesystem error. */
function appendAudit(
	projectRoot: string,
	entry: AuditEntry,
	credentials: OdooCredentials | null,
): void {
	try {
		const file = join(projectRoot, ".sdd", "audit.jsonl");
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 } as never);
	} catch {
		// Best-effort only: an audit write failure must never break a tool.
	}
}

/**
 * Public best-effort audit writer: record ONE operation line, sanitized.
 * Used by tools that already know their credentials; never blocks the caller.
 * @returns the entry written, or null on failure.
 */
export function appendAuditLine(
	projectRoot: string,
	op: string,
	args: unknown,
	credentials: OdooCredentials | null,
): AuditEntry | null {
	const entry: AuditEntry = {
		ts: new Date().toISOString(),
		tool: "odoo-sdd",
		op: sanitizeForPersist(op, credentials),
		args: sanitizeForPersist(JSON.stringify(args), credentials),
		outcome: "ok",
		ms: 0,
	};
	appendAudit(projectRoot, entry, credentials);
	return entry;
}

export { withAudit };