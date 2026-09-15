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
