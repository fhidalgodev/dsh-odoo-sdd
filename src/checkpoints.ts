/**
 * Checkpoints, data journal and the active-run state for dsh-odoo-sdd.
 *
 * A checkpoint is a labelled, on-disk snapshot of a module's source tree plus
 * (optionally) a journal of the data mutations performed through the plugin.
 * It is the plugin's answer to "any devolución": you can put the files back,
 * and best-effort undo the records the pipeline created or changed.
 *
 * Layout (all under the plugin-owned <projectRoot>/.sdd/ tree):
 *   .sdd/active.json                        current spec/phase/checkpoint
 *   .sdd/checkpoints/<id>/manifest.json     metadata + file list
 *   .sdd/checkpoints/<id>/files/...         copied source tree
 *   .sdd/checkpoints/<id>/journal.json      ordered data operations
 *
 * HONEST LIMITS (surfaced in the UI and README):
 *   - Files are restored; a module INSTALL/UPGRADE is NOT rolled back at the
 *     database level (that needs an explicit uninstall).
 *   - Data undo only covers mutations that went through `odoo_execute` and
 *     were journaled. Anything else is untouched.
 *
 * @module dsh-odoo-sdd/checkpoints
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	lstatSync,
	copyFileSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { writeFileAtomic } from "./atomic.js";

/** Directories never worth copying into a checkpoint (`.sdd` holds the checkpoints themselves). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".sdd", "__pycache__", ".mypy_cache", ".pytest_cache"]);

/**
 * Credential/secret file names that must never be copied into a checkpoint.
 * A snapshot is a convenience copy that may end up in a diff or an archive, so
 * secrets are excluded by default rather than by convention.
 */
const SECRET_EXACT = new Set([
	".env",
	".env.local",
	".env.production",
	".env.development",
	"credentials.json",
	"secrets.json",
	"session.json",
	".netrc",
	".pgpass",
]);
/** Patterns for key material whose exact names vary. */
const SECRET_PATTERNS: RegExp[] = [
	/^\.env\..+/i,
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
];

/** True when a file name holds credentials or key material. */
export function isSecretFile(name: string): boolean {
	if (SECRET_EXACT.has(name)) return true;
	return SECRET_PATTERNS.some((re) => re.test(name));
}

/** One journaled data mutation (used for best-effort undo). */
export interface DataOp {
	ts: string;
	/** Database the op was applied to, so a replay against another DB is caught. */
	db?: string;
	model: string;
	method: "create" | "write" | "unlink";
	ids: number[];
	/** Rows as they were BEFORE the mutation (for write/unlink). */
	preImage: Array<Record<string, unknown>>;
	/** Ids created by the mutation (for create-undo). */
	createdIds: number[];
	/** Odoo context the mutation ran under (company/lang), so an undo replays alike. */
	context?: Record<string, unknown>;
	/**
	 * Destination identity (`url+db+username` fingerprint) the op was applied to.
	 * The database alone cannot tell two users on the same database apart, and a
	 * replay under the wrong user may be refused by ACLs — or touch records the
	 * original writer never saw.
	 */
	target?: string;
	/**
	 * Instant this op was compensated. Marking each op as it is undone is what
	 * stops a failed replay from compensating the already-undone ones again when
	 * the operator retries.
	 */
	undoneAt?: string;
}

/** Minimal field metadata needed to turn a pre-image row back into write values. */
export interface FieldMeta {
	/** Odoo field type (`many2one`, `binary`, `char`…). */
	type?: string;
	/** True when the ORM refuses (or ignores) writes to the field. */
	readonly?: boolean;
	/** False for computed fields that are not stored. */
	store?: boolean;
}

/** Read-only/derived columns that must never be written back by a replay. */
const NON_WRITABLE_META = new Set([
	"id",
	"display_name",
	"__last_update",
	"create_date",
	"create_uid",
	"write_date",
	"write_uid",
]);

/**
 * Ids out of any of the shapes a `read` can return for an x2many: plain ids,
 * `[id, display_name]` pairs, or `{ id, name }` objects.
 * @param raw - the read value.
 * @returns the ids it carries (empty when it carries none).
 */
function relationIds(raw: unknown): number[] {
	if (!Array.isArray(raw)) return [];
	const out: number[] = [];
	for (const entry of raw) {
		if (typeof entry === "number") out.push(entry);
		else if (Array.isArray(entry) && typeof entry[0] === "number") out.push(entry[0]);
		else if (entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "number") {
			out.push((entry as { id: number }).id);
		}
	}
	return out;
}

/**
 * Convert one pre-image row into values a `write`/`create` accepts.
 *
 * A pre-image comes from `read`, whose shapes are NOT write shapes: a many2one
 * arrives as `[id, display_name]` and an x2many as a list of ids, so replaying
 * the row verbatim fails (or writes nonsense). The conversion is driven by
 * `fields_get` metadata when available and falls back to the observable shape
 * otherwise, and every field it refuses to restore is REPORTED — an undo that
 * silently skips half a row is worse than one that says so.
 * @param row - one pre-image row.
 * @param fields - field metadata for the model, or `{}` when unavailable.
 * @param onSkip - called per field that is not restored, with the reason.
 * @returns the write values.
 */
export function toWriteValues(
	row: Record<string, unknown>,
	fields: Record<string, FieldMeta>,
	onSkip?: (field: string, why: string) => void,
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(row)) {
		if (NON_WRITABLE_META.has(name)) {
			// Structural/ORM-managed columns: `id` is the write TARGET and the
			// audit columns are owned by the ORM. Never restored, never reported
			// as a loss (that would bury the real ones in noise).
			continue;
		}
		const meta = fields[name];
		if (meta === undefined) {
			// No metadata for this field: shape-based conversion, so an untyped
			// relational value is never written raw. A conversion is not a loss,
			// so it is not reported as one.
			if (raw === null || raw === undefined) {
				values[name] = false;
			} else if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "number" && typeof raw[1] === "string") {
				values[name] = raw[0];
			} else if (Array.isArray(raw) && raw.every((e) => typeof e === "number")) {
				values[name] = [[6, 0, raw]];
			} else {
				values[name] = raw;
			}
			continue;
		}
		if (meta.readonly === true || meta.store === false) {
			onSkip?.(name, "read-only or non-stored field");
			continue;
		}
		if (meta.type === "binary") {
			onSkip?.(name, "binary content is not restorable");
			continue;
		}
		if (meta.type === "many2one") {
			values[name] = raw === null || raw === undefined || raw === false ? false : Array.isArray(raw) ? (raw[0] ?? false) : raw;
			continue;
		}
		if (meta.type === "one2many" || meta.type === "many2many") {
			values[name] = [[6, 0, relationIds(raw)]];
			continue;
		}
		values[name] = raw;
	}
	return values;
}

/**
 * Field metadata a replay needs, straight from the instance.
 *
 * `fields_get` is a READ method, so this never needs the mutation allowlist and
 * can be called before a compensating write is built.
 * @param client - RPC client for the destination.
 * @param model - Odoo model name.
 * @returns the metadata keyed by field name (empty when the call failed).
 */
export async function fieldMetaFor(
	client: {
		executeKw<T>(
			model: string,
			method: string,
			args: unknown[],
			kwargs: Record<string, unknown>,
		): Promise<{ ok: true; value: T } | { ok: false; error: string }>;
	},
	model: string,
): Promise<Record<string, FieldMeta>> {
	const res = await client.executeKw<Record<string, FieldMeta>>(model, "fields_get", [], {
		attributes: ["type", "readonly", "store"],
	});
	return res.ok && res.value !== null && typeof res.value === "object" ? res.value : {};
}

/**
 * Replace one checkpoint's journal file: used after each compensated op and to
 * clear it once nothing is left to undo.
 * @param projectRoot - project root owning the checkpoint.
 * @param checkpointId - checkpoint id.
 * @param ops - the journal to persist.
 */
export function writeCheckpointJournal(projectRoot: string, checkpointId: string, ops: DataOp[]): void {
	if (!isSafeSegment(checkpointId)) return;
	try {
		writeFileAtomic(join(checkpointsDir(projectRoot), checkpointId, "journal.json"), JSON.stringify(ops, null, 2));
	} catch {
		// best effort: the journal lives in .sdd/, never in the project tree
	}
}

/** Checkpoint metadata persisted beside the copied files. */
export interface CheckpointManifest {
	id: string;
	label: string;
	createdAt: string;
	phase: string | null;
	specId: string | null;
	/** Roots that were snapshotted, relative to projectRoot. */
	dirs?: string[];
	files: Array<{ path: string; bytes: number }>;
	truncated: boolean;
}

/** Active-run state the guard consults before allowing mutations. */
export interface ActiveState {
	specId: string | null;
	phase: string | null;
	/** Id of the newest checkpoint created in this run. */
	checkpointId: string | null;
	updatedAt: string;
}

const SDD_DIR = ".sdd";
const ACTIVE_FILE = "active.json";

/** Absolute path of the plugin state directory. */
function sddDir(projectRoot: string): string {
	return join(projectRoot, SDD_DIR);
}

/** Read the active-run state (safe defaults when absent/corrupt). */
export function readActiveState(projectRoot: string): ActiveState {
	const file = join(sddDir(projectRoot), ACTIVE_FILE);
	const fallback: ActiveState = { specId: null, phase: null, checkpointId: null, updatedAt: "" };
	if (!existsSync(file)) return fallback;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ActiveState>;
		return {
			specId: typeof parsed.specId === "string" ? parsed.specId : null,
			phase: typeof parsed.phase === "string" ? parsed.phase : null,
			checkpointId: typeof parsed.checkpointId === "string" ? parsed.checkpointId : null,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch {
		return fallback;
	}
}

/** Merge and persist the active-run state. */
export function writeActiveState(projectRoot: string, patch: Partial<ActiveState>): ActiveState {
	const next: ActiveState = { ...readActiveState(projectRoot), ...patch, updatedAt: new Date().toISOString() };
	try {
		const dir = sddDir(projectRoot);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileAtomic(join(dir, ACTIVE_FILE), JSON.stringify(next, null, 2));
	} catch {
		// best effort: policy falls back to permissive-with-warning
	}
	return next;
}

/** Absolute path of the checkpoints root. */
export function checkpointsDir(projectRoot: string): string {
	return join(sddDir(projectRoot), "checkpoints");
}

/**
 * A developer's explicit decision to let this session work without a spec.
 *
 * WHY IT IS SESSION-SCOPED
 * "Leave it to your judgement" is a decision about ONE conversation: the next
 * chat is a new session and starts under the policy again. Scoping it to the
 * session id (the host's `agent.id`) is what makes that exact, instead of a
 * timer that would either expire mid-thought or outlive the conversation.
 */
export interface Waiver {
	/** Session that owns the waiver (the host agent/session id). */
	sessionId: string;
	/** What the developer said, kept verbatim. */
	reason: string;
	/** When it was granted (ISO). */
	at: string;
	/** Spec that was active when it was granted, when there was one. */
	specId?: string;
}

const WAIVER_FILE = "waiver.json";

/** Read the recorded waiver, or null when there is none (or it is unreadable). */
export function readWaiver(projectRoot: string): Waiver | null {
	const file = join(sddDir(projectRoot), WAIVER_FILE);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Waiver>;
		if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") return null;
		return {
			sessionId: parsed.sessionId,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			at: typeof parsed.at === "string" ? parsed.at : "",
			...(typeof parsed.specId === "string" ? { specId: parsed.specId } : {}),
		};
	} catch {
		// An unreadable waiver is NO waiver: the policy must not be bypassed by
		// corrupting the file.
		return null;
	}
}

/**
 * Whether a session may change things without a spec.
 * @param projectRoot - project holding the state.
 * @param sessionId - the calling session's id.
 * @returns true only for the session the developer granted it to.
 */
export function waiverCovers(projectRoot: string, sessionId: string | undefined): Waiver | null {
	if (sessionId === undefined || sessionId === "") return null;
	const waiver = readWaiver(projectRoot);
	return waiver !== null && waiver.sessionId === sessionId ? waiver : null;
}

/** Record a waiver for one session. */
export function writeWaiver(projectRoot: string, waiver: Waiver): void {
	const dir = sddDir(projectRoot);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileAtomic(join(dir, WAIVER_FILE), JSON.stringify(waiver, null, 2));
}

/** Drop the recorded waiver. Returns whether there was one. */
export function clearWaiver(projectRoot: string): boolean {
	const file = join(sddDir(projectRoot), WAIVER_FILE);
	if (!existsSync(file)) return false;
	try {
		rmSync(file, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Slugify a label for use inside a checkpoint id. */
function slug(label: string): string {
	return (label || "checkpoint").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "checkpoint";
}

/**
 * True when `value` is a safe single path SEGMENT: non-empty, bounded, no NUL,
 * no traversal (`..`), no separators and not absolute. Checkpoint ids and spec
 * ids are single segments and are fed straight into `join(...)`; an unvalidated
 * value could escape the checkpoint/spec root.
 */
export function isSafeSegment(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		!value.includes("\0") &&
		value !== ".." &&
		value !== "." &&
		!value.includes("/") &&
		!value.includes("\\")
	);
}

/**
 * True when `target` stays under `root` (containment, not lexical prefix).
 * `target` is absolute; the RELATIVE path must not climb via `..` and must not
 * resolve to an absolute path. Passing the root itself (rel === "") is allowed.
 */
export function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** Recursively copy a tree, skipping SKIP_DIRS, bounded by maxBytes. */
function copyTree(src: string, dst: string, rel: string, acc: Array<{ path: string; bytes: number }>, budget: { left: number }): boolean {
	let truncated = false;
	let entries: string[];
	try {
		entries = readdirSync(src);
	} catch {
		return truncated;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		if (isSecretFile(name)) continue; // never snapshot credentials/keys
		const abs = join(src, name);
		const relPath = rel === "" ? name : `${rel}/${name}`;
		let st;
		try {
			// lstat, NOT stat: stat follows the link, which made the symlink
			// check below dead code and let a snapshot copy content from
			// outside the project tree.
			st = lstatSync(abs);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) continue; // never follow links, in or out
		if (st.isDirectory()) {
			mkdirSync(join(dst, relPath), { recursive: true, mode: 0o700 });
			if (copyTree(abs, dst, relPath, acc, budget)) truncated = true;
			continue;
		}
		if (!st.isFile()) continue;
		if (st.size > budget.left) {
			truncated = true;
			continue;
		}
		try {
			mkdirSync(dirname(join(dst, relPath)), { recursive: true, mode: 0o700 });
			copyFileSync(abs, join(dst, relPath));
			budget.left -= st.size;
			acc.push({ path: relPath, bytes: st.size });
		} catch {
			truncated = true;
		}
	}
	return truncated;
}

/**
 * Create a checkpoint of the given directories (relative to projectRoot).
 * @param projectRoot - workspace root.
 * @param options - label, dirs to snapshot, specId/phase context, size budget.
 * @returns the manifest, or null when nothing could be written.
 */
export function createCheckpoint(
	projectRoot: string,
	options: { label: string; dirs: string[]; specId?: string | null; phase?: string | null; maxBytes?: number },
): CheckpointManifest | null {
	const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(options.label)}`;
	const root = join(checkpointsDir(projectRoot), id);
	const filesRoot = join(root, "files");
	const budget = { left: options.maxBytes ?? 25 * 1024 * 1024 };
	const files: Array<{ path: string; bytes: number }> = [];
	let truncated = false;
	try {
		mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
		for (const dir of options.dirs) {
			// Reject a directory that would escape the project root (traversal /
			// absolute path): never snapshot outside the workspace.
			if (dir === null || dir === undefined || typeof dir !== "string" || dir.includes("..") || isAbsolute(dir)) {
				return null;
			}
			const abs = join(projectRoot, dir);
			if (!existsSync(abs)) continue;
			if (!isWithinRoot(projectRoot, abs)) return null;
			if (copyTree(abs, filesRoot, dir, files, budget)) truncated = true;
		}
		const manifest: CheckpointManifest = {
			id,
			label: options.label,
			createdAt: new Date().toISOString(),
			phase: options.phase ?? null,
			specId: options.specId ?? null,
			dirs: [...options.dirs],
			files,
			truncated,
		};
		writeFileAtomic(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
		writeFileAtomic(join(root, "journal.json"), JSON.stringify([] satisfies DataOp[], null, 2));
		writeActiveState(projectRoot, { checkpointId: id, specId: options.specId ?? undefined, phase: options.phase ?? undefined });
		return manifest;
	} catch {
		return null;
	}
}

/** List checkpoints, newest first. */
export function listCheckpoints(projectRoot: string): CheckpointManifest[] {
	const root = checkpointsDir(projectRoot);
	if (!existsSync(root)) return [];
	const out: CheckpointManifest[] = [];
	let ids: string[];
	try {
		ids = readdirSync(root);
	} catch {
		return [];
	}
	for (const id of ids) {
		const file = join(root, id, "manifest.json");
		if (!existsSync(file)) continue;
		try {
			out.push(JSON.parse(readFileSync(file, "utf8")) as CheckpointManifest);
		} catch {
			// skip corrupt manifest
		}
	}
	return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Read one checkpoint manifest. */
export function readCheckpoint(projectRoot: string, id: string): CheckpointManifest | null {
	if (!isSafeSegment(id)) return null;
	const file = join(checkpointsDir(projectRoot), id, "manifest.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as CheckpointManifest;
	} catch {
		return null;
	}
}

/** Result of a file restore. */
export interface RestoreResult {
	/** Files rewritten from the snapshot. */
	restored: string[];
	/** Snapshot entries that could not be written back. */
	missing: string[];
	/** Files that exist now but were NOT in the snapshot (drift after it). */
	created: string[];
	/** Files actually removed (only when `prune` was requested). */
	pruned: string[];
	/** True when pruning was requested but the manifest predates `dirs`. */
	pruneUnsupported: boolean;
}

/**
 * Walk the snapshotted roots and list the files present now, relative to the
 * project root. Bounded and symlink-free, mirroring the snapshot rules.
 */
function listFilesUnder(projectRoot: string, dirs: string[], out: Set<string>): void {
	for (const dir of dirs) {
		const abs = join(projectRoot, dir);
		if (!isWithinRoot(projectRoot, abs) && abs !== projectRoot) continue;
		if (!existsSync(abs)) continue;
		const walk = (current: string, rel: string): void => {
			let entries: string[];
			try {
				entries = readdirSync(current);
			} catch {
				return;
			}
			for (const name of entries) {
				if (SKIP_DIRS.has(name) || isSecretFile(name)) continue;
				const childAbs = join(current, name);
				const childRel = rel === "" ? name : `${rel}/${name}`;
				let st;
				try {
					st = lstatSync(childAbs);
				} catch {
					continue;
				}
				if (st.isSymbolicLink()) continue;
				if (st.isDirectory()) walk(childAbs, childRel);
				else if (st.isFile()) out.add(childRel);
			}
		};
		walk(abs, dir);
	}
}

/**
 * Copy the checkpoint's files back over the project.
 *
 * A restore means "make the snapshotted roots look like the snapshot", so it
 * also DETECTS files created after the checkpoint. They are reported as
 * `created` and removed only when `prune` is requested: deleting working files
 * is destructive, so it never happens implicitly, but it can no longer be
 * silently forgotten either.
 * @param projectRoot - workspace root.
 * @param id - checkpoint id.
 * @param options - `prune: true` also removes the files created after it.
 * @returns restored/missing/created/pruned file lists.
 */
export function restoreCheckpointFiles(
	projectRoot: string,
	id: string,
	options: { prune?: boolean } = {},
): RestoreResult {
	const empty: RestoreResult = { restored: [], missing: [], created: [], pruned: [], pruneUnsupported: false };
	if (!isSafeSegment(id)) return empty;
	const manifest = readCheckpoint(projectRoot, id);
	const filesRoot = join(checkpointsDir(projectRoot), id, "files");
	if (manifest === null || !existsSync(filesRoot)) return empty;
	const restored: string[] = [];
	const missing: string[] = [];
	for (const entry of manifest.files) {
		// A hostile/edited manifest must not write outside the project root.
		if (
			!entry.path ||
			entry.path.includes("..") ||
			entry.path.includes("\0") ||
			isAbsolute(entry.path)
		) {
			missing.push(entry.path);
			continue;
		}
		const from = join(filesRoot, entry.path);
		const to = join(projectRoot, entry.path);
		if (!isWithinRoot(projectRoot, to)) {
			missing.push(entry.path);
			continue;
		}
		try {
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			restored.push(entry.path);
		} catch {
			missing.push(entry.path);
		}
	}

	// Drift detection: anything under the snapshotted roots that the snapshot
	// did not contain appeared afterwards.
	const snapshotted = new Set(manifest.files.map((f) => f.path));
	const dirs = Array.isArray(manifest.dirs) ? manifest.dirs.filter((d) => typeof d === "string") : [];
	if (dirs.length === 0) {
		return { restored, missing, created: [], pruned: [], pruneUnsupported: Boolean(options.prune) };
	}
	const present = new Set<string>();
	listFilesUnder(projectRoot, dirs, present);
	const created = [...present].filter((p) => !snapshotted.has(p)).sort();
	const pruned: string[] = [];
	if (options.prune === true) {
		for (const rel of created) {
			const abs = join(projectRoot, rel);
			// Never delete outside the roots the snapshot actually covered.
			if (!isWithinRoot(projectRoot, abs)) continue;
			try {
				rmSync(abs, { force: true });
				pruned.push(rel);
			} catch {
				// left in place; it stays visible in `created`
			}
		}
	}
	return { restored, missing, created, pruned, pruneUnsupported: false };
}

/** Delete one checkpoint. */
export function dropCheckpoint(projectRoot: string, id: string): boolean {
	if (!isSafeSegment(id)) return false; // never rm recursively on an unvalidated id
	const dir = join(checkpointsDir(projectRoot), id);
	if (!existsSync(dir)) return false;
	try {
		rmSync(dir, { recursive: true, force: true });
		const active = readActiveState(projectRoot);
		if (active.checkpointId === id) writeActiveState(projectRoot, { checkpointId: null });
		return true;
	} catch {
		return false;
	}
}

/** Keep only the newest `max` checkpoints. @returns how many were dropped. */
export function purgeCheckpoints(projectRoot: string, max: number): number {
	const all = listCheckpoints(projectRoot);
	let dropped = 0;
	for (const cp of all.slice(Math.max(max, 0))) {
		if (dropCheckpoint(projectRoot, cp.id)) dropped += 1;
	}
	return dropped;
}

/**
 * Append one data operation to the ACTIVE checkpoint's journal.
 *
 * IMPORTANT (design decision): the journal stores raw pre-images so a restore
 * can replay the exact prior values — redacting them here would break the data
 * rollback that is the whole point of the journal. Exposure is therefore
 * bounded to the local `.sdd/` directory, which is mode-0600 and gitignored
 * (captured in `.gitignore`), rather than to the model/handoff. Do NOT send
 * this journal through the model-facing content renderer.
 */
export function appendDataOp(projectRoot: string, op: DataOp): void {
	const active = readActiveState(projectRoot);
	if (active.checkpointId === null) return; // no checkpoint: nothing to journal against
	const file = join(checkpointsDir(projectRoot), active.checkpointId, "journal.json");
	let ops: DataOp[] = [];
	if (existsSync(file)) {
		try {
			ops = JSON.parse(readFileSync(file, "utf8")) as DataOp[];
		} catch {
			ops = [];
		}
	}
	ops.push(op);
	try {
		writeFileAtomic(file, JSON.stringify(ops, null, 2));
	} catch {
		// best effort
	}
}

/** Read the active checkpoint's journal. */
export function readJournal(projectRoot: string): DataOp[] {
	const active = readActiveState(projectRoot);
	if (active.checkpointId === null) return [];
	const file = join(checkpointsDir(projectRoot), active.checkpointId, "journal.json");
	if (!existsSync(file)) return [];
	try {
		return JSON.parse(readFileSync(file, "utf8")) as DataOp[];
	} catch {
		return [];
	}
}

/** Replace the active checkpoint's journal (after a successful undo). */
export function writeJournal(projectRoot: string, ops: DataOp[]): void {
	const active = readActiveState(projectRoot);
	if (active.checkpointId === null) return;
	try {
		writeFileAtomic(join(checkpointsDir(projectRoot), active.checkpointId, "journal.json"), JSON.stringify(ops, null, 2));
	} catch {
		// best effort
	}
}

/** Relative path helper re-exported for tools that report restored files. */
export function relPath(projectRoot: string, abs: string): string {
	return relative(projectRoot, abs);
}
