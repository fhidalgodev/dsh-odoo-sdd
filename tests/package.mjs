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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let packed;
try {
	const out = execFileSync(npm, ["pack", "--dry-run", "--json"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 32 * 1024 * 1024,
	});
	packed = JSON.parse(out);
} catch (err) {
	console.error(`Could not run \`npm pack --dry-run --json\`: ${err instanceof Error ? err.message : String(err)}`);
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
]) {
	required.push(`agents/${agent}.md`);
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
