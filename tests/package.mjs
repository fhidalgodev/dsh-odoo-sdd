/**
 * Packaging contract test for dsh-odoo-sdd.
 *
 * A plugin can pass every unit test and still be broken for the people who
 * install it: the published package once shipped without `agents/` (the
 * personas the SKILL loads) and without `cordis.patch.yml`, because `files`
 * decides what `pnpm`/`npm` actually hardlink. Those bugs only surface after
 * installation, so this test asserts the tarball contents directly.
 *
 * It uses `npm pack --dry-run --json`, which reports the exact file list
 * WITHOUT writing an artifact to the working tree.
 *
 * Usage: `node tests/package.mjs` (run after `npm run build`).
 *
 * @module dsh-odoo-sdd/tests/package
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;

/**
 * Assert one packaging invariant.
 * @param name - what is being checked.
 * @param ok - whether it holds.
 * @param detail - extra context printed on failure.
 */
function check(name, ok, detail) {
	checks += 1;
	if (ok) {
		console.log(`  PASS  ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

console.log("== packaging contract (tarball contents) ==");

if (!existsSync(join(root, "lib", "index.js"))) {
	console.error("lib/ is missing: run `npm run build` before this test.");
	process.exit(2);
}

// `--dry-run` keeps the working tree clean (verified: no .tgz is created).
//
// HOW npm IS INVOKED (Windows matters here):
// spawning the `npm.cmd` shim directly throws `EINVAL` from Node 20.12/21.7.0
// onward — the CVE-2024-27980 fix refuses to launch a `.cmd` without a shell —
// and `shell: true` would concatenate the arguments into a command line. The
// npm CLI itself is plain JS shipped next to the running node, so execute it
// with `process.execPath`: no shim, no shell, identical on every platform.
/**
 * Resolve the npm invocation for this machine.
 *
 * Order of preference: the CLI npm itself says it is running from
 * (`npm_execpath`, set for every lifecycle script) → the CLI shipped beside the
 * running node (official Windows layout, then POSIX) → the platform shim with a
 * shell, which is the only case Windows needs one.
 * @returns the command, its arguments, whether a shell is required, and how it was found.
 */
function npmInvocation() {
	const args = (cli) => [cli, "pack", "--dry-run", "--json"];
	const bin = dirname(process.execPath);
	const execpath = (process.env["npm_execpath"] ?? "").trim();
	// Only trust it when it IS npm: under pnpm/yarn the same variable points at
	// their own CLI, whose `pack` flags and JSON shape differ.
	const fromExecpath = /[\\/]npm[\\/]|npm-cli\.js$/i.test(execpath) && /\.(c|m)?js$/i.test(execpath) && existsSync(execpath);
	if (fromExecpath) {
		return { command: process.execPath, args: args(execpath), shell: false, how: `node ${execpath}`, source: "npm_execpath" };
	}
	const layouts = [
		join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // official Windows layout
		join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // official POSIX layout
	];
	for (const cli of layouts) {
		if (existsSync(cli)) {
			return { command: process.execPath, args: args(cli), shell: false, how: `node ${cli}`, source: "node layout" };
		}
	}
	// Last resort: the platform shim. A shell is required on Windows (EINVAL),
	// and the arguments here are fixed literals, never user input.
	const shim = process.platform === "win32" ? "npm.cmd" : "npm";
	return { command: shim, args: ["pack", "--dry-run", "--json"], shell: process.platform === "win32", how: shim, source: "shim" };
}
const npm = npmInvocation();
// The bug this pins: a `.cmd`/`.bat` launched WITHOUT a shell throws EINVAL on
// Windows (Node >= 20.12/21.7.0). Spawning the shim with a shell is legitimate,
// so the invariant is about the combination, not about the name.
check(
	"a Windows .cmd shim is never spawned without a shell (EINVAL)",
	!(/\.(cmd|bat)$/i.test(npm.command) && npm.shell !== true),
	npm.how,
);
const providedPath = (process.env["npm_execpath"] ?? "").trim();
if (providedPath !== "" && /[\\/]npm[\\/]|npm-cli\.js$/i.test(providedPath)) {
	check("npm's own CLI is used when npm provides its path", npm.source === "npm_execpath", `source=${npm.source}, path=${providedPath}`);
}
console.log(`  INFO  npm invocation: ${npm.how} [${npm.source}]${npm.shell ? " (via shell)" : ""}`);

// Keep npm's cache INSIDE the project: `npm pack` otherwise writes to ~/.npm,
// which fails on a read-only $HOME sandbox (EROFS) and makes this check depend
// on the machine's global state instead of the package itself.
const cacheDir = join(root, "node_modules", ".cache", "npm-pack");
mkdirSync(cacheDir, { recursive: true });
let packed;
try {
	const out = execFileSync(npm.command, npm.args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, npm_config_cache: cacheDir },
		...(npm.shell ? { shell: true } : {}),
	});
	packed = JSON.parse(out);
} catch (err) {
	console.error(`Could not run \`npm pack --dry-run --json\` via ${npm.how}: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
}

const entry = Array.isArray(packed) ? packed[0] : packed;
const shipped = new Set((entry?.files ?? []).map((f) => f.path));
check("npm pack reports a file list", shipped.size > 0, `got ${shipped.size} entries`);

// Everything the runtime loads by path must be inside the package.
const required = [
	"package.json",
	"LICENSE",
	"README.md",
	"README.es.md",
	".env.example",
	"cordis.patch.yml",
	"client/client.js",
	"skills/odoo-sdd-workflow/SKILL.md",
	"lib/index.js",
	"lib/grants.js",
	"lib/atomic.js",
];
for (const agent of [
	"architect",
	"developer",
	"qa",
	"consultant",
	"human-proxy",
	"security-reviewer",
	"documentation",
	"functional",
]) {
	required.push(`agents/${agent}.md`);
}
// Both bundled skills travel with the package: the runtime reads them by path
// (the functional reference resolves through the skill's resource base).
for (const skillFile of [
	"skills/odoo-functional-sdd/SKILL.md",
	"skills/odoo-functional-sdd/references/functional-domains.md",
]) {
	required.push(skillFile);
}
for (const file of required) {
	check(`ships ${file}`, shipped.has(file));
}

// Every compiled module must correspond to a source module (catches a stale or
// partially published lib/).
const srcModules = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
const libModules = new Set(readdirSync(join(root, "lib")).filter((f) => f.endsWith(".js")));
check("src/ has modules to compare", srcModules.length > 0);
for (const file of srcModules) {
	const compiled = `${file.slice(0, -3)}.js`;
	check(`lib/${compiled} is built and shipped`, libModules.has(compiled) && shipped.has(`lib/${compiled}`));
}

// The mount contract: the bundle patch must be declared AND shipped.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patch = manifest?.dsh?.bundle?.patch;
check("package.json declares dsh.bundle.patch", typeof patch === "string" && patch.length > 0);
check(
	"the declared patch is inside the package",
	typeof patch === "string" && shipped.has(patch.replace(/^\.\//, "")),
	`patch=${String(patch)}`,
);
check(
	"the web client half is declared and shipped",
	Array.isArray(manifest?.dsh?.client?.inject) &&
		manifest.dsh.client.inject.length > 0 &&
		shipped.has("client/client.js"),
);
check(
	"peer packages stay optional (host provides them)",
	manifest?.peerDependenciesMeta?.["@deepseek-ai/dsh-tools"]?.optional === true,
);

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
	console.error(`${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("ALL PACKAGING CHECKS PASSED");
