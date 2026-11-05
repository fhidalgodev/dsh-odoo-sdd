/**
 * Append-only audit log for the dsh-odoo-sdd plugin.
 *
 * Every tool execution writes ONE JSON line to `.sdd/audit.jsonl`
 * (`{"ts","tool","op","args","outcome","ms","source","phase","specId","reason"}`),
 * sanitized through sanitizeForPersist so credentials, credential shapes and
 * home paths never land on disk.
 *
 * This is the plugin's concrete implementation of the harness principle
 * "Model-visible means logged": the global tool listener records every call this
 * plugin's own tools make, and — with `auditAllTools` on — every OTHER tool the
 * agent calls as well, so a run can be reconstructed from disk. Policy denials
 * are logged too, with their reason, and are never filtered out.
 *
 * The log is a LEDGER, not an archive: a file-writing tool's content is stored as
 * `{bytes, sha256}` (the bytes are the agent's, not an audit fact), and the file
 * rotates at {@link MAX_AUDIT_BYTES} keeping one generation.
 *
 * It remains best-effort: the log is never shown to the model and a write
 * failure NEVER blocks the tool that produced the entry.
 *
 * @module dsh-odoo-sdd/audit
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sanitizeForPersist, type OdooCredentials } from "./credentials.js";

/** Rotate at this size, keeping ONE previous generation (so the trail is capped). */
export const MAX_AUDIT_BYTES = 16 * 1024 * 1024;

/**
 * Tools whose arguments carry FILE CONTENT. Their payload is recorded as a
 * digest, never verbatim: the log exists to reconstruct what happened, and a
 * whole file body (or a whole file body twice, in `edit`) is how the log grew to
 * 72 MB in one project while adding nothing an auditor can use.
 */
const CONTENT_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "create_file"]);

/** `{bytes, sha256}` for a string payload, or null when the field is absent. */
function digestOf(value: unknown): { bytes: number; sha256: string } | null {
	if (typeof value !== "string") return null;
	return {
		bytes: Buffer.byteLength(value, "utf8"),
		sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
	};
}

/**
 * Replace a content-bearing argument object with a comparable digest.
 *
 * Recorded: the path, and per payload field its byte length and a truncated
 * sha256 — enough to prove WHAT was written and whether two writes of the same
 * path carried the same bytes. Not recorded: the bytes themselves.
 */
export function shapeArgs(tool: string, args: unknown): unknown {
	if (!CONTENT_TOOLS.has(tool) || args === null || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	const path = record["file_path"] ?? record["path"] ?? record["filename"];
	const shaped: Record<string, unknown> = { path: typeof path === "string" ? path : "?" };
	for (const field of ["content", "old_string", "new_string"]) {
		const digest = digestOf(record[field]);
		if (digest !== null) shaped[field] = digest;
	}
	return shaped;
}

/** Where an entry came from: a tool call, internal bookkeeping, or the guard. */
export type AuditSource = "tool" | "internal" | "policy";

/** What an entry records: a tool invocation, an RPC attempt, a decision, or a functional batch operation. */
export type AuditKind = "tool" | "rpc" | "policy" | "functional";

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
	/** What the entry records. Keeps a transport success distinct from a domain one. */
	kind: AuditKind;
	/** Host tool-call id, so an entry correlates with the session transcript. */
	callId?: string;
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
	kind?: AuditKind;
	callId?: string;
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
		// One generation of history: the log is a ledger, not an archive, and an
		// unbounded file eventually costs every append a full rewrite. The rename is
		// the same best-effort shape as the append — losing a rotation is survivable,
		// losing the tool call is not. `renameSync` overwrites the previous `.1`.
		try {
			if (statSync(file).size > MAX_AUDIT_BYTES) renameSync(file, `${file}.1`);
		} catch {
			// No file yet, or the rotation failed: keep appending.
		}
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
		args: sanitizeForPersist(safeJson(shapeArgs(input.tool, input.args)), credentials),
		outcome: input.outcome ?? "ok",
		ms: input.ms ?? 0,
		source: input.source ?? "internal",
		kind: input.kind ?? (input.source === "policy" ? "policy" : "tool"),
	};
	if (input.callId !== undefined) entry.callId = input.callId;
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
