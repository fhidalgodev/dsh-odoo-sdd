/**
 * Setup decision marker for the dsh-odoo-sdd onboarding flow.
 *
 * The onboarding question ("configure the Odoo instance now, later, or skip
 * it") must be asked ONCE per project, not on every session. The developer's
 * answer is persisted to `<projectRoot>/.sdd/setup-state.json` so a fresh
 * agent can resume the decision instead of nagging.
 *
 * Statuses:
 *   - "configured"   credentials resolve and validate (derived, not stored)
 *   - "needs-secret" a scaffold .env was written but ODOO_PASSWORD is empty
 *   - "deferred"     the developer chose "configure later" — re-ask before
 *                    the VERIFY phase
 *   - "skipped"      the developer chose to work without an instance; the
 *                    pipeline degrades RPC/UI verification to manual checks
 *
 * The marker is not secret material, but home paths are still masked in all
 * tool-facing text (displayPath is applied by callers).
 *
 * @module dsh-odoo-sdd/setup-state
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

/** Decision statuses persisted by the onboarding flow. */
export type SetupStatus = "needs-secret" | "deferred" | "skipped";

/** Effective status after combining the marker with credential resolution. */
export type EffectiveSetupStatus = "configured" | SetupStatus | "needs-setup";

/** How much of the pipeline the developer delegates. */
export type AutonomyMode = "supervised" | "autonomous";

/** The persisted decision marker. */
export interface SetupState {
	status: SetupStatus;
	/** ISO timestamp of the decision. */
	decidedAt: string;
	/** Where the scaffold was (or will be) written. */
	scope?: "project" | "user";
	/** Absolute path of the scaffold .env (needs-secret only). */
	envFile?: string;
	/** Delegation mode: gates answered by the human ("supervised", default)
	 * or by the human-proxy agent ("autonomous"). */
	autonomy?: AutonomyMode;
}

const MARKER_NAME = "setup-state.json";

/** Absolute path of the marker file for a project. */
export function markerPath(projectRoot: string): string {
	return join(projectRoot, ".sdd", MARKER_NAME);
}

/** Read the persisted marker, or null when absent/corrupt (fail-safe). */
export function readSetupState(projectRoot: string): SetupState | null {
	const file = markerPath(projectRoot);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as SetupState;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			!["needs-secret", "deferred", "skipped"].includes(parsed.status)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/** Persist the decision marker (dir 700, file 600 — same hygiene as .env). */
export function writeSetupState(projectRoot: string, state: SetupState): void {
	const file = markerPath(projectRoot);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		chmodSync(dirname(file), 0o700);
	} catch {
		// best effort; the file mode below still applies
	}
	writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort on filesystems without chmod semantics
	}
}

/** Delete the marker (mode=reset). Never touches the real .env file. */
export function resetSetupState(projectRoot: string): boolean {
	const file = markerPath(projectRoot);
	if (!existsSync(file)) return false;
	rmSync(file);
	return true;
}

/**
 * Read the delegation mode, defaulting to "supervised" (fail-safe: autonomy
 * is opt-in; an absent or corrupt marker never unlocks autonomous approval).
 */
export function readAutonomy(projectRoot: string): AutonomyMode {
	const marker = readSetupState(projectRoot);
	return marker?.autonomy === "autonomous" ? "autonomous" : "supervised";
}
