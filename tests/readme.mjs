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
/** The version the documents must agree with (see the advertised-version check). */
const manifestVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

/** The closing sections, under any of the names the READMEs use for them. */
const TAIL = {
	thanks: /^## .*(Acknowledgments|Agradecimientos|致谢)/,
	license: /^## .*(License|Licencia|许可证)/,
};
/** The author line, under any of those languages. `[:：]` covers both colons. */
const AUTHOR = /<b>(Author|Autor|作者)[:：]<\/b>/;

const FILES = [
	{ file: "README.md", h1: "# Spec-Driven Development for Odoo", lang: "en", toolsHeading: (h) => /tools/i.test(h), toolCount: /\b(\d+)\s+tools\b/i },
	{ file: "README.es.md", h1: "# Spec-Driven Development para Odoo", lang: "es", toolsHeading: (h) => /tools/i.test(h), toolCount: /\b(\d+)\s+tools\b/i },
	{ file: "README.zh-CN.md", h1: "# 面向 Odoo 的规范驱动开发", lang: "zh", toolsHeading: (h) => /工具/.test(h), toolCount: /(\d+)\s*个工具/ },
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
check("the plugin registers 15 tools", toolNames.length === 15, `got ${toolNames.length}`);

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
 * Normalize line endings to `\n`.
 *
 * Windows git checks text files out with CRLF, so splitting the RAW content on
 * `"\n"` leaves a trailing `\r` on every line: `lines[0] === "# …"` then fails
 * with a message that looks identical, because the `\r` is invisible. Every
 * reader in this file normalizes, so the assertions are about the document and
 * not about the platform's checkout.
 * @param text - raw file content.
 * @returns the content with `\r\n` and lone `\r` folded to `\n`.
 */
function normalize(text) {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * Extract the first-cell names of the table that follows the heading matching
 * `matcher`, stopping at the next same-or-higher heading.
 * @param rawText - full README text (any line ending).
 * @param matcher - predicate over the heading line.
 * @returns the first-cell identifiers found.
 */
function tableAfter(rawText, matcher) {
	const lines = normalize(rawText).split("\n");
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

/** First line of a document, whatever its line endings are. */
function firstLine(rawText) {
	return normalize(rawText).split("\n")[0];
}

/** Heading level tokens (`#`, `##`, `###`) in document order, fences skipped. */
function headingLevels(rawText) {
	const lines = normalize(rawText).split("\n");
	return visibleLines(lines)
		.map((i) => lines[i])
		.filter((l) => /^#{1,3} /.test(l))
		.map((l) => l.split(" ")[0]);
}

const docs = FILES.map((entry) => {
	// A missing translation is a contract failure, not a crash: the readers below
	// used to throw ENOENT before a single check could report which file is gone.
	let raw = "";
	let missing = false;
	try {
		raw = readFileSync(join(root, entry.file), "utf8");
	} catch {
		missing = true;
	}
	const text = normalize(raw);
	const lines = text.split("\n");
	const visible = visibleLines(lines);
	return {
		...entry,
		missing,
		raw,
		text,
		lines,
		tools: tableAfter(raw, entry.toolsHeading),
		headings: headingLevels(raw),
	};
});

for (const doc of docs) {
	if (doc.missing) {
		check(`${doc.file}: the translation exists`, false, "file not found");
		continue;
	}
	check(`${doc.file}: exists and is not empty`, doc.text.length > 2000, `${doc.text.length} bytes`);
	// The house header is: the banner, then the exact H1. Both halves are pinned,
	// so a later edit can neither drop the banner nor push the title under it —
	// and a README that opens with something else entirely still fails.
	const imgLine = doc.lines.findIndex((l) => /<img src="assets\/odoo-sdd\.svg"/.test(l));
	const headingLine = doc.lines.findIndex((l) => /^# /.test(l));
	check(`${doc.file}: opens with the banner`, imgLine !== -1 && imgLine < headingLine, `img=${imgLine} h1=${headingLine}`);
	check(`${doc.file}: the H1 is the first heading, exactly`, doc.lines[headingLine] === doc.h1, doc.lines[headingLine]);
	check(`${doc.file}: no YAML frontmatter block`, !doc.text.startsWith("---"));
	// Windows git checks the file out with CRLF. Pin that the contract survives
	// it here, on Linux, instead of learning it from a red Windows CI run: the
	// failure mode is invisible (a trailing `\r` in an otherwise equal line).
	check(
		`${doc.file}: the contract holds with CRLF line endings (Windows checkout)`,
		(() => {
			const crlf = doc.text.replace(/\n/g, "\r\n");
			// The banner line has to survive the checkout too: it is the first line
			// now, so a stray `\r` would break the header exactly as it once broke
			// the H1 assertion.
			if (firstLine(crlf) !== doc.lines[0]) return false;
			const crlfLines = normalize(crlf).split("\n");
			if (crlfLines[imgLine] !== doc.lines[imgLine] || crlfLines[headingLine] !== doc.h1) return false;
			const crlfTools = [...tableAfter(crlf, doc.toolsHeading)].sort();
			if (crlfTools.length !== doc.tools.length || !crlfTools.every((n, i) => n === [...doc.tools].sort()[i])) return false;
			if (headingLevels(crlf).length !== doc.headings.length) return false;
			const langIdx = crlfLines.findIndex((l) => /href="README\.(md|es\.md|zh-CN\.md)"/.test(l));
			const authorIdx = crlfLines.findIndex((l) => AUTHOR.test(l));
			return langIdx !== -1 && authorIdx !== -1 && langIdx < authorIdx;
		})(),
	);
	check(`${doc.file}: badges use the for-the-badge style`, doc.text.includes("style=for-the-badge"));
	check(`${doc.file}: license badge points at the repo license`, doc.text.includes("img.shields.io/github/license/fhidalgodev/dsh-odoo-sdd"));
	check(`${doc.file}: contributors image is 480 wide`, doc.text.includes('width="480"'));
	// The two house assets, as RELATIVE paths in every language. An absolute
	// raw.githubusercontent URL would render today and rot quietly later (the
	// catalog's own screenshot convention says exactly this), and the packaging
	// test cannot see it because it only follows relative references.
	for (const asset of ["assets/odoo-sdd.svg", "assets/settings-panel.jpg"]) {
		check(`${doc.file}: references ${asset} relatively`, doc.text.includes(`src="${asset}"`));
	}
	// The pinnable install example names a released version, so it goes stale on
	// every release. Pinned to the manifest instead of to somebody's memory of
	// the last bump: the docs cannot advertise a version the package is not.
	const advertised = [...doc.text.matchAll(/dsh-odoo-sdd@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
	check(
		`${doc.file}: the version it advertises is the packaged one`,
		advertised.length > 0 && advertised.every((v) => v === manifestVersion),
		`advertised=${advertised.join(", ")} packaged=${manifestVersion}`,
	);
	check(`${doc.file}: no leftover template placeholder`, !/\bTODO\b|\bFIXME\b|<plugin>\/\.env\.example/.test(doc.text.replace("cp <plugin>/.env.example .env", "")));
	check(
		`${doc.file}: language link sits on its own line before the author`,
		(() => {
			const langIdx = doc.lines.findIndex((l) => /href="README\.(md|es\.md|zh-CN\.md)"/.test(l));
			const authorIdx = doc.lines.findIndex((l) => AUTHOR.test(l));
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
			const thanks = idx(TAIL.thanks);
			const license = idx(TAIL.license);
			return star !== -1 && thanks !== -1 && license !== -1 && star < thanks && thanks < license;
		})(),
	);

	// The number in the section title is documentation too: it went stale once
	// (the table said 12 while 13 were registered), so it is asserted.
	check(
		`${doc.file}: the tool-count in the section title matches the code`,
		(() => {
			const heading = doc.lines.find((l) => /^## /.test(l) && doc.toolsHeading(l)) ?? "";
			const match = doc.toolCount.exec(heading);
			return match !== null && Number(match[1]) === toolNames.length;
		})(),
	);

	// ---- the tool table must match the code, exactly.
	const listed = [...(doc.tools ?? [])].sort();
	check(
		`${doc.file}: the tool table lists exactly the registered tools`,
		listed.length === toolNames.length && listed.every((n) => toolNames.includes(n)),
		`documented=[${listed.join(", ")}] registered=[${toolNames.join(", ")}]`,
	);
	for (const name of toolNames) {
		check(`${doc.file}: documents and names ${name}`, doc.text.includes(`\`${name}\``));
	}

	// The change policy is a headline feature, not a footnote: every language
	// must document the switch, the waiver and the honest shell hole. A
	// translation that quietly omits them describes a plugin that gates
	// nothing, and no reader of that language would know.
	for (const token of ["requireSpecForChanges", ".sdd/waiver.json", "mode=bug", "sed -i"]) {
		check(`${doc.file}: documents ${token}`, doc.text.includes(token));
	}
	check(
		`${doc.file}: the waiver is an OPERATION of sdd_phase, not a promise`,
		/`waive`/.test(doc.text) && /`sdd_phase`/.test(doc.text),
	);
}

// ---- every README must stay in step with the others. These used to compare
// docs[0] with docs[1] by hand, which silently stopped checking the moment a
// third language appeared: the loop is the contract, not the pair.
const baseline = docs[0];
const skeletonCounts = (list) => list.map((doc) => `${doc.lang}=${doc.headings.length}`).join(" ");
check(
	"all READMEs share the same section skeleton",
	docs.every((doc) => doc.headings.length === baseline.headings.length && doc.headings.every((h, i) => h === baseline.headings[i])),
	skeletonCounts(docs),
);
check(
	"all READMEs document the same tools",
	docs.every((doc) => {
		const mine = [...(doc.tools ?? [])].sort();
		const reference = [...baseline.tools].sort();
		return mine.length === reference.length && mine.every((n, i) => n === reference[i]);
	}),
	docs.map((doc) => `${doc.lang}=${(doc.tools ?? []).length}`).join(" "),
);
check(
	"all READMEs carry the same badge set",
	new Set(docs.map((doc) => (doc.text.match(/img.shields.io[^"]+/g) ?? []).length)).size === 1,
	docs.map((doc) => `${doc.lang}=${(doc.text.match(/img.shields.io[^"]+/g) ?? []).length}`).join(" "),
);
// A switcher that forgets a language is the classic translation bug: the new
// file links to everyone and the existing ones keep linking to nobody.
for (const doc of docs) {
	const missing = FILES.filter((other) => !doc.text.includes(`href="${other.file}"`)).map((other) => other.file);
	check(`${doc.file}: the switcher links to every other language`, missing.length === 0, `missing: ${missing.join(", ")}`);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
	console.error(`${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("ALL README CHECKS PASSED");
