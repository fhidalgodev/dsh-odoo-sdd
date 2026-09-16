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
 *     is always built from the sources it ships;
 *   - `prepare` runs on a `git`/directory install, so a consumer that installs
 *     straight from a repository gets a loadable package.
 *
 * THE INVARIANT THAT MATTERS
 * An install-time hook must WARN, never FAIL: `prepare` also fires for a
 * `file:` dependency install (where the consumer has no devDependencies) and
 * for `npm install` inside the repository, where the optional host peers that
 * provide the types are not installed yet — that second case broke every CI job
 * once, at the "Install dev dependencies" step, before the explicit typecheck
 * step could ever run. So `prepare` always exits 0 and says what it could not
 * do, while `prepack` always exits non-zero on failure: a publish must never
 * ship a build nobody typechecked.
 *
 * WHEN THE TYPES ARE MISSING the compiler cannot check anything, but it can
 * still EMIT (`--noCheck`, TypeScript >= 5.6): the peer imports survive into
 * the output exactly as written and the host provides them at runtime, so the
 * consumer gets a loadable plugin instead of nothing. That fallback is
 * announced, never silent, and it is never used for a publish.
 *
 * Usage: `node scripts/prepare.mjs [--force]` (`--force` = prepack: always
 * rebuild, always typecheck, always fatal on failure).
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

/** Modules the compile needs but that an install may legitimately not have. */
const HOST_PEERS = ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"];
const DEV_TYPES = ["@types/node"];
/** `--noCheck` (emit without checking) exists from TypeScript 5.6. */
const NO_CHECK_MIN = [5, 6];

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

/**
 * Which of the given modules are not installed here.
 * @param names - package names to look for.
 * @returns the missing ones, in the order given.
 */
function missingModules(names) {
	return names.filter((name) => !existsSync(join(root, "node_modules", ...name.split("/"))));
}

/**
 * Whether this TypeScript can emit without type checking.
 * @returns true when `--noCheck` is available.
 */
function canSkipChecking() {
	try {
		const manifest = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8"));
		const [major, minor] = String(manifest.version).split(".").map((part) => Number.parseInt(part, 10));
		return major > NO_CHECK_MIN[0] || (major === NO_CHECK_MIN[0] && minor >= NO_CHECK_MIN[1]);
	} catch {
		return false;
	}
}

/**
 * Run the compiler.
 * @param extra - extra CLI arguments (e.g. `--noCheck`).
 * @returns true when it succeeded and produced the entry point.
 */
function build(extra = []) {
	try {
		execFileSync(process.execPath, [compiler(), "-p", "tsconfig.json", ...extra], { cwd: root, stdio: "inherit" });
		return existsSync(join(root, "lib", "index.js"));
	} catch {
		return false;
	}
}

if (!force && compiledIsFresh()) {
	log("lib/ is up to date; nothing to build.");
	process.exit(0);
}

const tsc = compiler();
if (tsc === null) {
	if (force) {
		// Packaging with no compiler would ship whatever happens to be on disk.
		log("TypeScript is not installed, so lib/ cannot be built for packaging.");
		log("Install the toolchain first: npm install && npm run host:deps");
		process.exit(1);
	}
	log("TypeScript is not installed here, so lib/ was NOT built.");
	if (!existsSync(join(root, "lib", "index.js"))) {
		log(`WARNING: ${join(root, "lib", "index.js")} is missing and "main" points at it.`);
		log("The plugin will not load until you run: npm install && npm run build");
	}
	process.exit(0);
}

const missing = missingModules([...HOST_PEERS, ...DEV_TYPES]);

// ---------------------------------------------------------------------------
// prepack: strict, and fatal. A published version is immutable, so refusing to
// publish is better than shipping a build nobody checked.
// ---------------------------------------------------------------------------
if (force) {
	if (missing.length > 0) {
		log(`cannot typecheck: ${missing.join(", ")} not installed.`);
		log("Install the toolchain first: npm install && npm run host:deps");
		process.exit(1);
	}
	log("building lib/ for packaging (typechecked)...");
	if (!build()) {
		log("the build FAILED: nothing was packaged.");
		process.exit(1);
	}
	log("lib/ built and typechecked.");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// prepare: warn, never break the install.
// ---------------------------------------------------------------------------
if (missing.length === 0) {
	log("building lib/...");
	if (build()) {
		log("lib/ built.");
		process.exit(0);
	}
	// Everything is installed, so this is a real compile error in the sources:
	// say it loudly, but do not break an install over it. `npm run build` is the
	// gate that fails, and `prepack` refuses to publish.
	log("the build FAILED; lib/ was NOT rebuilt. Run `npm run build` to see the errors.");
	process.exit(0);
}

log(`lib/ was NOT typechecked: ${missing.join(", ")} not installed here.`);
log("That is expected for an install that provides no devDependencies and no host peers.");
if (!canSkipChecking()) {
	log("This TypeScript cannot emit without checking (needs >= 5.6), so nothing was built.");
	log("Run `npm install && npm run host:deps && npm run build` where the sources live.");
	process.exit(0);
}
log("emitting without type checking so the plugin still loads (the host provides those peers at runtime)...");
if (!build(["--noCheck"])) {
	log("the emit-only build FAILED as well; lib/ was NOT rebuilt.");
	process.exit(0);
}
log("lib/ emitted WITHOUT type checking. Build it properly before publishing.");
