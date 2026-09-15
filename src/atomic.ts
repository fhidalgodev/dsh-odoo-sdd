/**
 * Durable, corruption-aware file primitives for dsh-odoo-sdd.
 *
 * The plugin keeps its pipeline state on disk (spec state, KB graph, active
 * run, grants, journal). A plain `writeFileSync` truncates first: a crash, a
 * full disk or a killed process between truncate and write leaves a half file,
 * and a half file used to be silently replaced by a fresh default — losing
 * progress without telling anyone.
 *
 * Two rules here:
 *   1. Writes go to a sibling temp file and are renamed into place, so readers
 *      observe either the old content or the new one, never a torn file.
 *   2. A corrupt file is QUARANTINED (renamed aside), not overwritten: the data
 *      stays recoverable on disk and the recovery is reported to the caller so
 *      the pipeline can surface it instead of pretending nothing happened.
 *
 * @module dsh-odoo-sdd/atomic
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Suffix used for files set aside after a failed parse. */
const QUARANTINE_SUFFIX = ".corrupt-";

/**
 * Write a file so that no reader can observe a partially written document:
 * write a sibling temp file, fsync-free but atomic `rename` into place.
 * @param file - destination path.
 * @param data - full content to write.
 * @param mode - file mode to apply (best effort on exotic filesystems).
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, data, { mode });
		renameSync(tmp, file);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// the temp file is best-effort cleanup
		}
		throw err;
	}
	try {
		chmodSync(file, mode);
	} catch {
		// best effort on filesystems without chmod semantics
	}
}

/** Outcome of a durable JSON read. */
export interface JsonReadResult<T> {
	/** Parsed value, or null when the file is absent/corrupt. */
	value: T | null;
	/** "missing" (nothing to read), "ok", or "corrupt" (quarantined). */
	status: "missing" | "ok" | "corrupt";
	/** Path of the quarantined file when `status === "corrupt"`. */
	quarantined?: string;
	/** Parse error message when `status === "corrupt"`. */
	detail?: string;
}

/**
 * Read and parse JSON, setting a corrupt file aside instead of clobbering it.
 * @param file - path to read.
 * @returns the parsed value plus how the read went.
 */
export function readJsonWithRecovery<T>(file: string): JsonReadResult<T> {
	if (!existsSync(file)) return { value: null, status: "missing" };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		return { value: null, status: "corrupt", detail: err instanceof Error ? err.message : String(err) };
	}
	try {
		return { value: JSON.parse(text) as T, status: "ok" };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const quarantined = `${file}${QUARANTINE_SUFFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`;
		try {
			renameSync(file, quarantined);
		} catch {
			// If it cannot be moved aside, still report the corruption; the
			// caller must not treat this as a clean read.
			return { value: null, status: "corrupt", detail };
		}
		return { value: null, status: "corrupt", quarantined, detail };
	}
}

/**
 * List the quarantined files next to `file`, newest first. Used to surface a
 * recovery in `sdd_phase status` instead of hiding it.
 * @param file - the state file that may have quarantined siblings.
 * @returns absolute paths of quarantined copies.
 */
export function quarantinedSiblings(file: string): string[] {
	const dir = dirname(file);
	const prefix = `${file.slice(dir.length + 1)}${QUARANTINE_SUFFIX}`;
	try {
		return readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.reverse()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}
