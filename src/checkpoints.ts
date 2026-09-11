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
	statSync,
	copyFileSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/** Directories never worth copying into a checkpoint (`.sdd` holds the checkpoints themselves). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".sdd", "__pycache__", ".mypy_cache", ".pytest_cache"]);

/** One journaled data mutation (used for best-effort undo). */
export interface DataOp {
	ts: string;
	model: string;
	method: "create" | "write" | "unlink";
	ids: number[];
	/** Rows as they were BEFORE the mutation (for write/unlink). */
	preImage: Array<Record<string, unknown>>;
	/** Ids created by the mutation (for create-undo). */
	createdIds: number[];
}

/** Checkpoint metadata persisted beside the copied files. */
export interface CheckpointManifest {
	id: string;
	label: string;
	createdAt: string;
	phase: string | null;
	specId: string | null;
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
		writeFileSync(join(dir, ACTIVE_FILE), JSON.stringify(next, null, 2), { mode: 0o600 });
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
		const abs = join(src, name);
		const relPath = rel === "" ? name : `${rel}/${name}`;
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (st.isSymbolicLink && st.isSymbolicLink()) continue; // never follow links
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
			const abs = join(projectRoot, dir);
			if (!existsSync(abs)) continue;
			if (copyTree(abs, filesRoot, dir, files, budget)) truncated = true;
		}
		const manifest: CheckpointManifest = {
			id,
			label: options.label,
			createdAt: new Date().toISOString(),
			phase: options.phase ?? null,
			specId: options.specId ?? null,
			files,
			truncated,
		};
		writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
		writeFileSync(join(root, "journal.json"), JSON.stringify([] satisfies DataOp[], null, 2), { mode: 0o600 });
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
	const file = join(checkpointsDir(projectRoot), id, "manifest.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as CheckpointManifest;
	} catch {
		return null;
	}
}

/** Copy the checkpoint's files back over the project (files only). */
export function restoreCheckpointFiles(projectRoot: string, id: string): { restored: string[]; missing: string[] } {
	const manifest = readCheckpoint(projectRoot, id);
	const filesRoot = join(checkpointsDir(projectRoot), id, "files");
	const restored: string[] = [];
	const missing: string[] = [];
	if (manifest === null || !existsSync(filesRoot)) return { restored, missing };
	for (const entry of manifest.files) {
		const from = join(filesRoot, entry.path);
		const to = join(projectRoot, entry.path);
		try {
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			restored.push(entry.path);
		} catch {
			missing.push(entry.path);
		}
	}
	return { restored, missing };
}

/** Delete one checkpoint. */
export function dropCheckpoint(projectRoot: string, id: string): boolean {
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

/** Append one data operation to the ACTIVE checkpoint's journal. */
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
		writeFileSync(file, JSON.stringify(ops, null, 2), { mode: 0o600 });
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
		writeFileSync(join(checkpointsDir(projectRoot), active.checkpointId, "journal.json"), JSON.stringify(ops, null, 2), { mode: 0o600 });
	} catch {
		// best effort
	}
}

/** Relative path helper re-exported for tools that report restored files. */
export function relPath(projectRoot: string, abs: string): string {
	return relative(projectRoot, abs);
}
