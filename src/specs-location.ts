/**
 * Where the spec documents of a project live.
 *
 * The project root is not a plugin-wide constant: the developer opens a
 * different folder in every session, so the root is resolved per call (see
 * `rootFor` in the plugin entry point) and the spec folder is DERIVED from it.
 * Two layouts are supported, and the developer picks one in Settings:
 *
 *   - `project` (default): `<projectRoot>/<specsDir>/<specId>` — specs travel
 *     with the code, which is what a single repository wants.
 *   - `central`: `<specsRoot>/<projectSlug>/<specId>` — one folder collects the
 *     specs of EVERY project, each project in its own subfolder. This is for a
 *     developer with many module repositories who wants one place to search.
 *
 * A central folder is shared by unrelated projects, so ownership is recorded
 * explicitly rather than inferred:
 *   - each project folder carries a `.dsh-project-root` marker holding the
 *     absolute project root it belongs to;
 *   - two different projects whose directory name collides (`/a/odoo`,
 *     `/b/odoo`) get `<slug>-<hash8>` for the second one instead of silently
 *     reading and writing the first project's specs;
 *   - a non-empty folder with the SAME name but no marker is treated as
 *     foreign and never adopted — it is not ours to claim.
 *
 * @module dsh-odoo-sdd/specs-location
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isSafeSegment } from "./checkpoints.js";
import { writeFileAtomic } from "./atomic.js";

/** How specs are laid out on disk. */
export type SpecsMode = "project" | "central";

/** Marker file naming the project that owns a central specs folder. */
export const PROJECT_ROOT_MARKER = ".dsh-project-root";

/** Layout configuration derived from the effective settings + config file. */
export interface SpecsLayout {
	/** Absolute project root the current call acts on. */
	projectRoot: string;
	/** "project" (inside the project) or "central" (one shared folder). */
	specsMode: SpecsMode;
	/** Folder inside the project root when `specsMode === "project"`. */
	specsDir: string;
	/** Absolute folder collecting every project when `specsMode === "central"`. */
	specsRoot: string;
}

/** Default central folder when the developer enabled central mode but picked none. */
export function defaultSpecsRoot(): string {
	return join(homedir(), ".dsh-odoo-sdd", "specs");
}

/**
 * Narrow an unknown value to a supported specs mode.
 * @param value - candidate value from settings or config.json.
 * @returns the mode, defaulting to "project" for anything unrecognized.
 */
export function asSpecsMode(value: unknown): SpecsMode {
	return value === "central" ? "central" : "project";
}

/**
 * Filesystem-safe folder name for a project path.
 * @param projectRoot - absolute project root.
 * @returns a slug derived from the last path segment (never empty).
 */
export function projectSlug(projectRoot: string): string {
	const raw = basename(resolve(projectRoot));
	const slug = raw
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+/, "")
		.replace(/[-.]+$/, "")
		.slice(0, 48);
	return slug === "" ? "project" : slug;
}

/**
 * Short, stable digest of a path, used to disambiguate slug collisions.
 * @param text - text to digest.
 * @returns 8 lowercase hex characters.
 */
export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Read the owner recorded in a central project folder's marker. */
function readOwner(dir: string): string | null {
	try {
		const raw = readFileSync(join(dir, PROJECT_ROOT_MARKER), "utf8").trim();
		return raw === "" ? null : resolve(raw);
	} catch {
		return null;
	}
}

/** Write the owner marker (fail-soft: a folder without it is still usable). */
function writeOwner(dir: string, projectRoot: string): void {
	try {
		writeFileAtomic(join(dir, PROJECT_ROOT_MARKER), `${resolve(projectRoot)}\n`, 0o600);
	} catch {
		// An unwritable marker must not break spec creation: the layout stays
		// deterministic because the slug is derived from the path.
	}
}

/** Whether a directory exists and already holds something. */
function isNonEmptyDir(dir: string): boolean {
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

/**
 * Resolve the folder that holds the specs of ONE project inside the central
 * specs root, honouring markers and collisions.
 * @param specsRoot - absolute central specs root.
 * @param projectRoot - absolute project root of the calling session.
 * @param opts - `create` allows creating the folder and its marker.
 * @returns the absolute project folder inside the central root.
 */
export function centralProjectDir(
	specsRoot: string,
	projectRoot: string,
	opts?: { create?: boolean },
): string {
	const root = resolve(projectRoot);
	const slug = projectSlug(root);
	const preferred = join(specsRoot, slug);
	const owner = readOwner(preferred);
	let chosen: string;
	if (owner !== null) {
		// Owned: it is ours only when the recorded root matches.
		chosen = owner === root ? preferred : join(specsRoot, `${slug}-${shortHash(root)}`);
	} else if (!existsSync(preferred) || !isNonEmptyDir(preferred)) {
		// Absent or empty: claimable.
		chosen = preferred;
	} else {
		// Same slug, no marker, already full of someone's specs: never adopt it.
		chosen = join(specsRoot, `${slug}-${shortHash(root)}`);
	}
	if (opts?.create === true) {
		mkdirSync(chosen, { recursive: true, mode: 0o700 });
		if (readOwner(chosen) === null) writeOwner(chosen, root);
	}
	return chosen;
}

/**
 * Resolve the base folder that holds the spec directories of one project.
 * @param layout - effective layout configuration.
 * @param opts - `create` allows creating the central project folder.
 * @returns the absolute folder containing one subdirectory per spec.
 */
export function specsBaseFor(layout: SpecsLayout, opts?: { create?: boolean }): string {
	if (layout.specsMode === "central") {
		const root = layout.specsRoot.trim() === "" ? defaultSpecsRoot() : resolve(layout.specsRoot);
		return centralProjectDir(root, layout.projectRoot, opts);
	}
	// An absolute specsDir must not be concatenated under the root: `join(root,
	// '/abs')` yields `<root>/abs`, which is how specs once ended up in a bogus
	// /tmp/home/... tree.
	const dir = layout.specsDir.trim() === "" ? "specs" : layout.specsDir;
	return isAbsolute(dir) ? resolve(dir) : join(layout.projectRoot, dir);
}

/**
 * Resolve one spec directory.
 *
 * An unvalidated spec id could escape the specs root (path traversal), so an
 * invalid id maps to a neutral directory: nothing real is created or read.
 * @param layout - effective layout configuration.
 * @param specId - spec directory id, e.g. `001-sale-order-approval`.
 * @param opts - `create` allows creating the central project folder.
 * @returns the absolute spec directory.
 */
export function specDirFor(layout: SpecsLayout, specId: string, opts?: { create?: boolean }): string {
	const safe = isSafeSegment(specId) ? specId : "__invalid__";
	return join(specsBaseFor(layout, opts), safe);
}

/**
 * Human-readable account of where specs go, for tool output and for the
 * settings panel. Reporting the resolved location is what keeps the model (and
 * the developer) from guessing when several projects are open.
 * @param layout - effective layout configuration.
 * @param specId - optional spec id to append.
 * @returns a one-line description.
 */
export function describeSpecsLocation(layout: SpecsLayout, specId?: string): string {
	const base = specsBaseFor(layout);
	const mode =
		layout.specsMode === "central"
			? `central (${layout.specsRoot.trim() === "" ? `${defaultSpecsRoot()} [default]` : layout.specsRoot.trim()})`
			: "project";
	return specId === undefined ? `${base} [${mode}]` : `${join(base, specId)} [${mode}]`;
}

/** Which layer supplied the effective project root. */
export type RootSource = "argument" | "session" | "config" | "cwd";

/** The project root a tool call acts on, with its provenance. */
export interface ResolvedRoot {
	/** Absolute project root. */
	root: string;
	/** Which layer decided it (reported so nothing is guessed). */
	source: RootSource;
	/** Session id whose cwd won, when `source === "session"`. */
	sessionId?: string;
}

/**
 * The cwd recorded in a session header, when the host exposes a session store.
 *
 * A session's cwd IS the workspace path: the workspace registry only counts a
 * session as a member when the header cwd equals the workspace path. Reading it
 * is therefore the authoritative way to learn "which folder is open".
 * @param sessions - `ctx.sessions` (any shape; missing services are tolerated).
 * @param sessionId - candidate session id (`exec.agent.id`).
 * @returns the absolute cwd, or null when unavailable.
 */
export function sessionCwdOf(sessions: unknown, sessionId: unknown): string | null {
	if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
	const store = sessions as { get?: (id: string) => unknown } | null | undefined;
	if (store === null || store === undefined || typeof store.get !== "function") return null;
	try {
		const session = store.get(sessionId);
		const cwd = (session as { header?: { cwd?: unknown } } | undefined)?.header?.cwd;
		return typeof cwd === "string" && cwd.trim() !== "" ? resolve(cwd) : null;
	} catch {
		// A store that throws must not take the whole tool call down; the
		// configured root is used instead and reported as such.
		return null;
	}
}

/**
 * Resolve the project root for one call. The order is deliberate:
 *   1. an explicit argument (scripted/CI escape hatch, and the only way to
 *      address a folder the session is not in);
 *   2. the cwd of the calling session — the authoritative, per-folder answer;
 *   3. the configured root (Settings → `.sdd/config.json` → deployment), for
 *      hosts or contexts with no session (headless, tests);
 *   4. the process cwd, reported as a last resort so callers can say so.
 * @param input - the candidate layers.
 * @returns the absolute root plus which layer produced it.
 */
export function resolveRoot(input: {
	explicit?: string;
	sessions?: unknown;
	sessionId?: unknown;
	configured?: string;
	cwd?: string;
}): ResolvedRoot {
	const explicit = (input.explicit ?? "").trim();
	if (explicit !== "") return { root: resolve(explicit), source: "argument" };
	const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
	const cwd = sessionCwdOf(input.sessions, sessionId);
	if (cwd !== null) {
		return { root: cwd, source: "session", ...(sessionId === undefined ? {} : { sessionId }) };
	}
	const configured = (input.configured ?? "").trim();
	if (configured !== "") return { root: resolve(configured), source: "config" };
	return { root: resolve(input.cwd ?? process.cwd()), source: "cwd" };
}

