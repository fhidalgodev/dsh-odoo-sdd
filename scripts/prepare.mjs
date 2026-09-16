/**
 * Build `lib/` when it is needed, and stay out of the way when it is not.
 *
 * WHY THIS EXISTS
 * `lib/` is build output and is NOT committed, while `package.json` points
 * `main` at `lib/index.js`. That combination has a nasty failure mode: a
 * published tarball packed from a tree without `lib/` installs perfectly and
 * then never loads. Verified with a clean clone: `npm pack` produced 39 files
 * and ZERO files under `lib/`.
 *
 * npm's hooks cover the two ways the package is consumed:
 *   - `prepack` runs on `npm pack` and `npm publish`, so a published artifact
 *     is always built from the sources it ships (`--force`, no heuristics);
 *   - `prepare` runs on a `git`/directory install, so a consumer that installs
 *     straight from a repository gets a loadable package.
 *
 * WHY IT CANNOT JUST RUN `tsc`
 * `prepare` also fires for a `file:` dependency install, where the consumer has
 * no devDependencies and therefore no TypeScript. Failing there would break the
 * installation of an otherwise fine local plugin, so the missing compiler is
 * reported and skipped — never silently, and never as a success. A build that
 * IS attempted and fails exits non-zero: a broken compile must stop a publish.
 *
 * Usage: `node scripts/prepare.mjs [--force]` (`--force` = prepack: always
 * rebuild).
 *
 * @module dsh-odoo-sdd/scripts/prepare
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");
// Notices go to STDERR on purpose: `npm pack --json` (and any tool parsing it)
// reads stdout, and a lifecycle script that chats on stdout corrupts that JSON.
const log = (message) => console.error(`[dsh-odoo-sdd] ${message}`);

/** Every source module, recursively (the compiler mirrors this layout). */
function sourceModules(dir = join(root, "src")) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourceModules(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
	}
	return found;
}

/**
 * Whether every compiled module exists and is at least as new as its source.
 * @returns true when `lib/` can be trusted for the current sources.
 */
function compiledIsFresh() {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const declaredTypes = typeof manifest.types === "string" ? join(root, manifest.types) : null;
	if (declaredTypes !== null && !existsSync(declaredTypes)) return false;
	const inputs = [...sourceModules(), join(root, "tsconfig.json")];
	const newestInput = Math.max(...inputs.map((file) => statSync(file).mtimeMs));
	for (const source of sourceModules()) {
		const compiled = join(root, "lib", relative(join(root, "src"), source).replace(/\.ts$/, ".js"));
		if (!existsSync(compiled)) return false;
		if (statSync(compiled).mtimeMs < newestInput) return false;
	}
	return true;
}

/** The compiler shipped beside the project, if it was installed. */
function compiler() {
	for (const candidate of [join(root, "node_modules", "typescript", "bin", "tsc"), join(root, "node_modules", ".bin", "tsc")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

if (!force && compiledIsFresh()) {
	log("lib/ is up to date; nothing to build.");
	process.exit(0);
}

const tsc = compiler();
if (tsc === null) {
	// Reached on a `file:` install (no devDependencies). Not fatal on purpose:
	// the alternative is breaking the install. Say exactly what is missing.
	log("TypeScript is not installed here, so lib/ was NOT built.");
	if (!existsSync(join(root, "lib", "index.js"))) {
		log(`WARNING: ${join(root, "lib", "index.js")} is missing and "main" points at it.`);
		log("The plugin will not load until you run: npm install && npm run build");
	}
	process.exit(0);
}

log(force ? "building lib/ for packaging..." : "building lib/...");
try {
	execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
} catch (err) {
	log(`the build FAILED: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
if (!existsSync(join(root, "lib", "index.js"))) {
	log(`the build reported success but ${join(root, "lib", "index.js")} does not exist.`);
	process.exit(1);
}
log("lib/ built.");
