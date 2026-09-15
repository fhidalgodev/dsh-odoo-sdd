/**
 * Human authorization receipts for dsh-odoo-sdd.
 *
 * Possessing credentials is NOT authorization. Before any tool may open a
 * socket towards the configured Odoo instance, a HUMAN must have approved the
 * exact target through the host's native approval seam; the outcome is stored
 * here as a receipt (a "grant") bound to a fingerprint of that target.
 *
 * The model can neither mint nor edit a receipt: only an approval settling
 * `'allowed-once'` writes one, and any change to url/db/username changes the
 * fingerprint, so a grant cannot be reused against a different target.
 *
 * Layout: `<projectRoot>/.sdd/grants.json` (mode 0600, gitignored).
 *
 * Fail-closed: a missing, unreadable or corrupt file yields NO grants. The
 * absence of evidence is treated as the absence of authorization.
 *
 * @module dsh-odoo-sdd/grants
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What a receipt authorizes. */
export type GrantKind = "connection" | "config";

/** One stored authorization receipt. Never contains secret material. */
export interface Grant {
	/** What this receipt authorizes. */
	kind: GrantKind;
	/** sha256 over the canonical target (see {@link fingerprintOf}). */
	fingerprint: string;
	/** ISO timestamp when the human approved. */
	createdAt: string;
	/** ISO timestamp after which the receipt is no longer valid. */
	expiresAt: string;
	/** Host tool-call id that produced the approval, for correlation. */
	callId?: string;
	/** Human-readable reason shown to the approver. */
	reason?: string;
}

/** On-disk shape of the receipts file. */
export interface GrantsFile {
	version: 1;
	grants: Grant[];
}

/** File name inside the plugin-owned `.sdd/` directory. */
const FILE_NAME = "grants.json";

/** A connection grant lasts a working session unless the caller says otherwise. */
const DEFAULT_TTL_MINUTES = 12 * 60;

/** Absolute path of the receipts file for a project. */
export function grantsPath(projectRoot: string): string {
	return join(projectRoot, ".sdd", FILE_NAME);
}

/** Empty, well-formed state. Used for absent/corrupt files (fail-closed). */
function emptyGrants(): GrantsFile {
	return { version: 1, grants: [] };
}

/**
 * Read the receipts file. A corrupt or malformed file yields an empty set
 * rather than throwing: no evidence of authorization means no authorization.
 * @param projectRoot - workspace root owning the `.sdd/` tree.
 * @returns the parsed receipts, or an empty set.
 */
export function readGrants(projectRoot: string): GrantsFile {
	const file = grantsPath(projectRoot);
	if (!existsSync(file)) return emptyGrants();
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as GrantsFile;
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.grants)) {
			return emptyGrants();
		}
		return {
			version: 1,
			grants: parsed.grants.filter(
				(g): g is Grant =>
					g !== null &&
					typeof g === "object" &&
					typeof g.fingerprint === "string" &&
					typeof g.expiresAt === "string" &&
					(g.kind === "connection" || g.kind === "config"),
			),
		};
	} catch {
		return emptyGrants();
	}
}

/** Persist the receipts with restrictive permissions. */
function persist(projectRoot: string, data: GrantsFile): void {
	const file = grantsPath(projectRoot);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		chmodSync(dirname(file), 0o700);
	} catch {
		// best effort; the file mode below still applies
	}
	writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort on filesystems without chmod semantics
	}
}

/**
 * Stable fingerprint of an Odoo target. Any change to the URL, database or
 * username produces a different fingerprint, which invalidates prior grants.
 * @param url - canonical instance URL.
 * @param db - target database name.
 * @param username - login user.
 * @returns a hex sha256 digest.
 */
export function fingerprintOf(url: string, db: string, username: string): string {
	return createHash("sha256").update(`${url}\u0000${db}\u0000${username}`).digest("hex");
}

/**
 * Whether a non-expired receipt of `kind` matches `fingerprint`.
 * @param projectRoot - workspace root owning the `.sdd/` tree.
 * @param kind - receipt kind to look for.
 * @param fingerprint - target fingerprint to match.
 * @param now - clock injection for tests.
 * @returns true only for an unexpired, matching receipt.
 */
export function hasValidGrant(
	projectRoot: string,
	kind: GrantKind,
	fingerprint: string,
	now: Date = new Date(),
): boolean {
	const stamp = now.getTime();
	return readGrants(projectRoot).grants.some((g) => {
		if (g.kind !== kind || g.fingerprint !== fingerprint) return false;
		const exp = Date.parse(g.expiresAt);
		return Number.isFinite(exp) && exp > stamp;
	});
}

/**
 * Record a human grant, replacing any previous receipt for the same
 * (kind, fingerprint) pair.
 * @param projectRoot - workspace root owning the `.sdd/` tree.
 * @param grant - kind, fingerprint and optional correlation/reason.
 * @returns the stored receipt.
 */
export function writeGrant(
	projectRoot: string,
	grant: { kind: GrantKind; fingerprint: string; ttlMinutes?: number; callId?: string; reason?: string },
): Grant {
	const now = new Date();
	const ttl = Math.max(1, grant.ttlMinutes ?? DEFAULT_TTL_MINUTES);
	const receipt: Grant = {
		kind: grant.kind,
		fingerprint: grant.fingerprint,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
		...(grant.callId !== undefined ? { callId: grant.callId } : {}),
		...(grant.reason !== undefined ? { reason: grant.reason } : {}),
	};
	const data = readGrants(projectRoot);
	data.grants = data.grants.filter(
		(g) => !(g.kind === receipt.kind && g.fingerprint === receipt.fingerprint),
	);
	data.grants.push(receipt);
	persist(projectRoot, data);
	return receipt;
}

/**
 * Drop every receipt, or only one kind.
 * @param projectRoot - workspace root owning the `.sdd/` tree.
 * @param kind - restrict the revocation to one kind.
 * @returns how many receipts were removed.
 */
export function revokeGrants(projectRoot: string, kind?: GrantKind): number {
	const data = readGrants(projectRoot);
	const before = data.grants.length;
	data.grants = kind === undefined ? [] : data.grants.filter((g) => g.kind !== kind);
	const removed = before - data.grants.length;
	if (removed > 0) persist(projectRoot, data);
	return removed;
}
