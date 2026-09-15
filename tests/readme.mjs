/**
 * README contract test for dsh-odoo-sdd.
 *
 * The two READMEs are the shop window AND the reference: when the tool surface
 * changed, the tool table did not always follow (the old table listed 12 tools
 * while the plugin registered 13 — `odoo_config` was missing). This test ties
 * the documents to the code and to each other:
 *
 *   - the tool table must list EXACTLY the tools the compiled plugin registers,
 *     in both languages, and mention each one in its body text;
 *   - the two READMEs must keep the same section skeleton, so a section added to
 *     one is not silently forgotten in the other;
 *   - the house rules for the header hold (exact H1, no frontmatter, badge style,
 *     language link before the author, contributors image width, tail order).
 *
 * Usage: `node tests/readme.mjs` (run after `npm run build`).
 *
 * @module dsh-odoo-sdd/tests/readme
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;
/**
 * Assert one documentation invariant.
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

console.log("== README contract (structure + tool coverage) ==");

const FILES = [
	{ file: "README.md", h1: "# Spec-Driven Development for Odoo", lang: "en" },
	{ file: "README.es.md", h1: "# Spec-Driven Development para Odoo", lang: "es" },
];

// ---- the REAL registered tool names, straight from the compiled plugin.
if (!existsSync(join(root, "lib", "index.js"))) {
	console.error("lib/ is missing: run `npm run build` before this test.");
	process.exit(2);
}
const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
const registered = new Map();
plugin.apply(
	{ tools: { register: (t) => registered.set(t.name, t), guard: () => () => {} }, on: () => () => {} },
	{},
);
const toolNames = [...registered.keys()].sort();
check("the plugin registers 13 tools", toolNames.length === 13, `got ${toolNames.length}`);

/**
 * Line indexes that are OUTSIDE fenced code blocks. Every structural assertion
 * works on these, so a `#` comment inside a bash snippet or a `|` inside a YAML
 * block can never be mistaken for a heading or a table row.
 * @param lines - the document split into lines.
 * @returns the visible line indexes, in order.
 */
function visibleLines(lines) {
	const out = [];
	let fenced = false;
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i].startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) out.push(i);
	}
	return out;
}

/**
 * Extract the first-cell names of the table that follows the heading matching
 * `matcher`, stopping at the next same-or-higher heading.
 * @param text - full README text.
 * @param matcher - predicate over the heading line.
 * @returns the first-cell identifiers found.
 */
function tableAfter(text, matcher) {
	const lines = text.split("\n");
	const visible = visibleLines(lines);
	let at = -1;
	for (let k = 0; k < visible.length; k += 1) {
		if (/^#{2,3} /.test(lines[visible[k]]) && matcher(lines[visible[k]])) {
			at = k;
			break;
		}
	}
	if (at === -1) return [];
	const out = [];
	for (let k = at + 1; k < visible.length; k += 1) {
		const line = lines[visible[k]];
		if (/^#{2,3} /.test(line)) break;
		const m = /^\| `([a-z_]+)`/.exec(line);
		if (m) out.push(m[1]);
	}
	return out;
}

const docs = FILES.map((entry) => {
	const text = readFileSync(join(root, entry.file), "utf8");
	const lines = text.split("\n");
	const visible = visibleLines(lines);
	return {
		...entry,
		text,
		lines,
		tools: tableAfter(text, (h) => /tools/i.test(h)),
		headings: visible
			.map((i) => lines[i])
			.filter((l) => /^#{1,3} /.test(l))
			.map((l) => l.split(" ")[0]),
	};
});

for (const doc of docs) {
	check(`${doc.file}: exists and is not empty`, doc.text.length > 2000, `${doc.text.length} bytes`);
	check(`${doc.file}: starts with the exact H1`, doc.lines[0] === doc.h1, doc.lines[0]);
	check(`${doc.file}: no YAML frontmatter block`, !doc.text.startsWith("---"));
	check(`${doc.file}: badges use the for-the-badge style`, doc.text.includes("style=for-the-badge"));
	check(`${doc.file}: license badge points at the repo license`, doc.text.includes("img.shields.io/github/license/fhidalgodev/dsh-odoo-sdd"));
	check(`${doc.file}: contributors image is 480 wide`, doc.text.includes('width="480"'));
	check(`${doc.file}: no leftover template placeholder`, !/\bTODO\b|\bFIXME\b|<plugin>\/\.env\.example/.test(doc.text.replace("cp <plugin>/.env.example .env", "")));
	check(
		`${doc.file}: language link sits on its own line before the author`,
		(() => {
			const langIdx = doc.lines.findIndex((l) => /href="README\.(md|es\.md)"/.test(l));
			const authorIdx = doc.lines.findIndex((l) => /<b>(Author|Autor):<\/b>/.test(l));
			if (langIdx === -1 || authorIdx === -1 || langIdx >= authorIdx) return false;
			// Its own line means: not sharing a line with the badge row.
			const langLine = doc.lines[langIdx];
			return /<\/a>/.test(langLine) && !langLine.includes("img.shields.io");
		})(),
	);
	check(
		`${doc.file}: tail order is Star History then Acknowledgments then License`,
		(() => {
			const idx = (re) => doc.lines.findIndex((l) => re.test(l));
			const star = idx(/^## .*Star History/);
			const thanks = idx(/^## .*(Acknowledgments|Agradecimientos)/);
			const license = idx(/^## .*(License|Licencia)/);
			return star !== -1 && thanks !== -1 && license !== -1 && star < thanks && thanks < license;
		})(),
	);

	// ---- the tool table must match the code, exactly.
	const listed = [...doc.tools].sort();
	check(
		`${doc.file}: the tool table lists exactly the registered tools`,
		listed.length === toolNames.length && listed.every((n) => toolNames.includes(n)),
		`documented=[${listed.join(", ")}] registered=[${toolNames.join(", ")}]`,
	);
	for (const name of toolNames) {
		check(`${doc.file}: documents and names ${name}`, doc.text.includes(`\`${name}\``));
	}
}

// ---- both READMEs must stay in step with each other.
check(
	"both READMEs share the same section skeleton",
	docs[0].headings.length === docs[1].headings.length &&
		docs[0].headings.every((h, i) => h === docs[1].headings[i]),
	`en=${docs[0].headings.length} es=${docs[1].headings.length}`,
);
check(
	"both READMEs document the same tools",
	docs[0].tools.length === docs[1].tools.length &&
		[...docs[0].tools].sort().every((n, i) => n === [...docs[1].tools].sort()[i]),
);
check(
	"both READMEs carry the same badge set",
	(docs[0].text.match(/img.shields.io[^"]+/g) ?? []).length === (docs[1].text.match(/img.shields.io[^"]+/g) ?? []).length,
);

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
	console.error(`${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("ALL README CHECKS PASSED");
