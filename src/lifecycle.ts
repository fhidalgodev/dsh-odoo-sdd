/**
 * Lifecycle and ownership for dsh-odoo-sdd.
 *
 * The plugin writes private runtime state under `<projectRoot>/.sdd/`. That
 * state is useful while a project is being developed and undesirable once the
 * plugin is removed, so it needs an explicit, visible way out.
 *
 * Ownership rules encoded here:
 *   - PURGE only what this plugin created and owns.
 *   - NEVER touch the developer's credentials (`.sdd/.env`), the project
 *     documents (`specs/`), or the operator's emergency brake (`stop.md`):
 *     those belong to the human, not to the plugin.
 *   - Report a plan before acting, so nothing is deleted implicitly.
 *
 * @module dsh-odoo-sdd/lifecycle
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** What an owned path is, for a readable plan. */
export type OwnedKind =
	| "connection grants"
	| "UI session cookie"
	| "active run state"
	| "audit log"
	| "plugin configuration"
	| "setup decision"
	| "checkpoints";

/** One plugin-owned path. */
export interface OwnedPath {
	/** Path relative to the project root (display only). */
	rel: string;
	/** Human-readable purpose. */
	kind: OwnedKind;
	/** True when the entry is a directory. */
	dir: boolean;
	/** Whether it currently exists on disk. */
	exists: boolean;
	/** Approximate size in bytes (recursive for directories). */
	bytes: number;
}

/** Paths the plugin deliberately NEVER removes. */
export const PRESERVED: ReadonlyArray<{ rel: string; why: string }> = [
	{ rel: ".sdd/.env", why: "your credentials — the plugin never deletes them" },
	{ rel: ".sdd/stop.md", why: "your emergency brake — remove it yourself when you mean to resume" },
	{ rel: "specs/", why: "project documents (spec, architecture, verdicts, KB)" },
];

/** Recursive size of a file or directory, bounded and symlink-free. */
function treeSize(abs: string, seen = 0): number {
	if (seen > 20) return 0;
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink()) return 0;
		if (!st.isDirectory()) return st.size;
		let total = 0;
		for (const name of readdirSync(abs)) total += treeSize(join(abs, name), seen + 1);
		return total;
	} catch {
		return 0;
	}
}

/** Relative path of the plugin's private state directory. */
export function stateDirRel(): string {
	return ".sdd";
}

/** Enumerate the plugin-owned state, whether present or not. */
export function ownedStatePaths(projectRoot: string): OwnedPath[] {
	const defs: Array<{ rel: string; kind: OwnedKind; dir: boolean }> = [
		{ rel: ".sdd/grants.json", kind: "connection grants", dir: false },
		{ rel: ".sdd/session.json", kind: "UI session cookie", dir: false },
		{ rel: ".sdd/active.json", kind: "active run state", dir: false },
		{ rel: ".sdd/audit.jsonl", kind: "audit log", dir: false },
		{ rel: ".sdd/config.json", kind: "plugin configuration", dir: false },
		{ rel: ".sdd/setup-state.json", kind: "setup decision", dir: false },
		{ rel: ".sdd/checkpoints", kind: "checkpoints", dir: true },
	];
	return defs.map((d) => {
		const abs = join(projectRoot, d.rel);
		const present = existsSync(abs);
		return {
			rel: d.rel,
			kind: d.kind,
			dir: d.dir,
			exists: present,
			bytes: present ? treeSize(abs) : 0,
		};
	});
}

/** Outcome of a purge. */
export interface PurgeResult {
	/** Relative paths actually removed. */
	removed: string[];
	/** Relative paths that could not be removed. */
	failed: string[];
	/** Relative paths that did not exist. */
	absent: string[];
}

/**
 * Remove the plugin's own state. Refuses nothing: the caller is responsible for
 * confirming with the human first, and for reporting the plan from
 * {@link ownedStatePaths} beforehand.
 * @param projectRoot - workspace root.
 * @returns what was removed, what failed, and what was already absent.
 */
export function purgeOwnedState(projectRoot: string): PurgeResult {
	const removed: string[] = [];
	const failed: string[] = [];
	const absent: string[] = [];
	for (const entry of ownedStatePaths(projectRoot)) {
		const abs = join(projectRoot, entry.rel);
		if (!entry.exists) {
			absent.push(entry.rel);
			continue;
		}
		try {
			rmSync(abs, { recursive: entry.dir, force: true });
			removed.push(entry.rel);
		} catch {
			failed.push(entry.rel);
		}
	}
	return { removed, failed, absent };
}

/** Total bytes the plugin currently occupies on disk. */
export function ownedBytes(projectRoot: string): number {
	return ownedStatePaths(projectRoot)
		.filter((e) => e.exists)
		.reduce((sum, e) => sum + e.bytes, 0);
}

/** Human-readable byte count. */
export function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	try {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	} catch {
		return `${bytes} B`;
	}
}

/** Text of the purge plan: what would go, and what is deliberately kept. */
export function purgePlan(projectRoot: string): string {
	const entries = ownedStatePaths(projectRoot);
	const present = entries.filter((e) => e.exists);
	const lines: string[] = [];
	lines.push(`Owned state found: ${present.length}/${entries.length} path(s).`);
	for (const e of present) {
		lines.push(`  - ${e.rel} (${e.kind}, ${humanBytes(e.bytes)})`);
	}
	if (present.length === 0) lines.push("  (nothing to remove)");
	lines.push("Kept on purpose:");
	for (const p of PRESERVED) lines.push(`  - ${p.rel}: ${p.why}`);
	return lines.join("\n");
}
