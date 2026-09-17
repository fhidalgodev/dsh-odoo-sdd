/**
 * Import suite for `odoo_import` and the version contracts it depends on.
 *
 * No instance: the web route, the session file and the RPC layer are doubles.
 * What is asserted is what decides whether an import is safe:
 *
 *   - a version outside the verified families is REFUSED, with what to investigate;
 *   - the apply call follows each family's own signature (10-11 has no columns);
 *   - a JSONP body is parsed as data and executed never;
 *   - the session cookie goes out in the request and NEVER into the tool output;
 *   - a file that changed after the upload invalidates the mapping;
 *   - the mapping needs a decision per column, and the batch that applies it is an
 *     `apply` batch of the functional plan (never a discovery one).
 *
 * Usage: `node tests/import.mjs` (run after `npm run build`).
 *
 * @module dsh-odoo-sdd/tests/import
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const caps = await import(new URL("import-capabilities.js", libDir).href);
const imp = await import(new URL("odoo-import.js", libDir).href);
const fnMod = await import(new URL("functional.js", libDir).href);

let failures = 0;
/**
 * Assert one import invariant.
 * @param label - what is being checked.
 * @param cond - whether it holds.
 * @param detail - extra context, printed on failure.
 */
function check(label, cond, detail) {
	if (cond) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

console.log("== capabilities: the contract is per family, never guessed ==");
{
	const v17 = caps.importCapabilities("17.0");
	check("17 resolves to the modern family", v17.ok === true && v17.capabilities.family === "17-19");
	check("the modern upload uses ufile/id and JSON", v17.capabilities.upload.fileField === "ufile" && v17.capabilities.upload.response === "json");
	check("the modern apply is execute_import", v17.capabilities.apply.method === "execute_import");
	const v14 = caps.importCapabilities("14.0");
	check("14 resolves to the do() family", v14.ok === true && v14.capabilities.apply.method === "do");
	check("the older upload uses file/import_id and JSONP", v14.capabilities.upload.fileField === "file" && v14.capabilities.upload.response === "jsonp");
	const v11 = caps.importCapabilities("11.0");
	check(
		"10-11 has no separate columns argument",
		v11.ok === true && !v11.capabilities.apply.signature.includes("columns"),
		JSON.stringify(v11.ok ? v11.capabilities.apply.signature : v11),
	);
	const v9 = caps.importCapabilities("9.0");
	check("an unverified major is REFUSED", v9.ok === false && v9.reason === "unknown_family");
	check("the refusal says what to investigate", v9.ok === false && /base_import\/set_file/.test(v9.message));
	const junk = caps.importCapabilities("not-a-version");
	check("an unparsable version is refused", junk.ok === false && junk.reason === "unparsable_version");
	check("the edition suffix does not break detection", caps.majorVersion("16.0+e") === 16);
	check("a date suffix does not break detection", caps.majorVersion("19.0-20260101") === 19);
	check("the known majors are reported", caps.knownMajors().includes(10) && caps.knownMajors().includes(19));

	const modern = caps.applyArguments(v17.capabilities, { importId: 3, fields: ["f"], columns: ["c"], options: { o: 1 }, dryRun: true });
	check("the modern apply arguments follow the signature", JSON.stringify(modern) === JSON.stringify([3, ["f"], ["c"], { o: 1 }, true]), JSON.stringify(modern));
	const old = caps.applyArguments(v11.capabilities, { importId: 3, fields: ["f"], columns: ["c"], options: { o: 1 }, dryRun: false });
	check("the old apply arguments drop the columns token", JSON.stringify(old) === JSON.stringify([["f"], { o: 1 }, false]), JSON.stringify(old));
}

console.log("== JSONP and CSRF are data, never code ==");
{
	check("plain JSON is parsed", JSON.stringify(imp.parseJsonpAsData('{"id": 7}')) === JSON.stringify({ id: 7 }));
	check("a JSONP wrapper is parsed as data", JSON.stringify(imp.parseJsonpAsData('odoo.define("x", function () { return {"id": 9}; });')) === JSON.stringify({ id: 9 }));
	check("a bare object in text is found", JSON.stringify(imp.parseJsonpAsData('callback({"id": 1, "raw": "done"});')) === JSON.stringify({ id: 1, raw: "done" }));
	check("braces inside strings do not confuse the scanner", JSON.stringify(imp.parseJsonpAsData('cb({"a": "}", "b": 2})')) === JSON.stringify({ a: "}", b: 2 }));
	check(
		"the outermost payload wins over a nested fragment",
		JSON.stringify(imp.parseJsonpAsData('cb({"id": 1, "nested": {"id": 2}})')) === JSON.stringify({ id: 1, nested: { id: 2 } }),
	);
	check("a close with no open yields null", imp.parseJsonpAsData('cb("a": 1})') === null);
	check("an unbalanced body yields null instead of throwing", imp.parseJsonpAsData('cb({"a": 1') === null);
	check("empty text yields null", imp.parseJsonpAsData("   ") === null);
	// The point of "as data": a body that would be dangerous if evaluated is inert.
	const hostile = 'alert(1); cb({"ok": true})';
	check("a hostile body is only parsed", JSON.stringify(imp.parseJsonpAsData(hostile)) === JSON.stringify({ ok: true }));

	check("the CSRF token is read from odoo.csrf_token", imp.extractCsrfToken('var x; odoo.csrf_token = "abc123";') === "abc123");
	check("the CSRF token is read from a meta tag", imp.extractCsrfToken('<meta name="csrf-token" content="tok-9">') === "tok-9");
	check("a page without a token returns null", imp.extractCsrfToken("<html></html>") === null);
}

console.log("== the session stays private ==");
{
	const root = mkdtempSync(join(tmpdir(), "sdd-import-"));
	const proj = join(root, "project");
	mkdirSync(join(proj, ".sdd"), { recursive: true });
	check("no session file reads as no session", imp.readWebSession(proj) === null);
	writeFileSync(join(proj, ".sdd", "session.json"), "{ not json");
	check("a corrupt session file reads as no session", imp.readWebSession(proj) === null);
	writeFileSync(join(proj, ".sdd", "session.json"), JSON.stringify({ session_id: "", url: "http://x", db: "d" }));
	check("an empty cookie reads as no session", imp.readWebSession(proj) === null);
	writeFileSync(join(proj, ".sdd", "session.json"), JSON.stringify({ session_id: "SECRET-COOKIE", url: "http://127.0.0.1:8069", db: "dev" }));
	const session = imp.readWebSession(proj);
	check("a session is read with its target", session !== null && session.url === "http://127.0.0.1:8069" && session.db === "dev");

	console.log("== the file is checked before anything is uploaded ==");
	const csv = join(proj, "data.csv");
	writeFileSync(csv, "name,vat\nA,1\n");
	const ok = imp.checkImportFile(csv);
	check("a valid file passes with a fingerprint", ok.ok === true && typeof ok.sha256 === "string" && ok.bytes > 0);
	check("a missing file is refused", imp.checkImportFile(join(proj, "nope.csv")).ok === false);
	check("an empty file is refused", (() => {
		const empty = join(proj, "empty.csv");
		writeFileSync(empty, "");
		return imp.checkImportFile(empty).ok === false;
	})());
	check("a binary format is refused", (() => {
		const exe = join(proj, "data.exe");
		writeFileSync(exe, "MZ");
		return imp.checkImportFile(exe).reason.includes("not a format");
	})());
	const linked = join(proj, "link.csv");
	try {
		symlinkSync(csv, linked);
		check("a symlink is refused (the file cannot be swapped under an approval)", imp.checkImportFile(linked).ok === false && /symbolic link/.test(imp.checkImportFile(linked).reason));
	} catch {
		console.log("  SKIP  symlink assertion (no symlink support here)");
	}
	writeFileSync(csv, "name,vat\nA,2\n");
	check("changing the bytes changes the fingerprint", imp.checkImportFile(csv).sha256 !== ok.sha256);

	console.log("== the importer's answer is read, not reduced to a boolean ==");
	const outcome = imp.readImportOutcome({ ids: [1, 2, 3], messages: [{ record: 2, message: "missing required field" }], nextrow: 4 });
	check("created rows are counted from ids", outcome.created === 3);
	check("per-row messages are kept with their row", outcome.messages.length === 1 && /row 2/.test(outcome.messages[0]));
	check("nextrow is reported (the import can stop mid-file)", outcome.nextrow === 4);
	check("an empty answer reads as zero", imp.readImportOutcome({}).created === 0);

	// A completed apply is never indeterminate, and a `nextrow` is NOT a clean run.
	const clean = imp.reportAppliedImport(imp.readImportOutcome({ ids: [1, 2], messages: [] }));
	check("a clean apply is not partial", clean.partial === false && clean.created === 2);
	check("a clean apply reports no stopping row", clean.stoppedAtRow === undefined);
	const cut = imp.reportAppliedImport(imp.readImportOutcome({ created: 7, messages: [{ record: 9, message: "bad" }], nextrow: 9 }));
	check("a stopped import is partial", cut.partial === true && cut.stoppedAtRow === 9);
	check("a partial import still reports the rows that landed", cut.created === 7);
	const many = imp.reportAppliedImport(
		imp.readImportOutcome({ created: 1, messages: Array.from({ length: 9 }, (_v, i) => ({ record: i + 1, message: "e" })) }),
	);
	check("the messages are bounded in the report", many.messages.length === 5);
	check("the omitted messages are counted, not dropped", many.messagesOmitted === 4);

	console.log("== the tool: preparation is approved, bounded and honest ==");
	// fetch double: records the request and answers like the modern endpoint.
	const requests = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
		if (String(url).endsWith("/base_import/set_file")) {
			return new Response(JSON.stringify({ id: 55 }), { status: 200 });
		}
		return new Response('<html>odoo.csrf_token = "tok-1";</html>', { status: 200 });
	};
	try {
		const tools = new Map();
		const rpc = [];
		const approvals = [];
		let approveOutcome = "allowed-once";
		imp.registerImportTool({ tools: { register: (t) => tools.set(t.name, t) } }, {
			projectRoot: () => proj,
			specDir: (specId) => join(proj, "specs", specId),
			client: async () => ({
				client: {
					async executeKw(model, method, args) {
						rpc.push({ model, method, args });
						if (method === "create") return { ok: true, value: 77 };
						if (method === "get_fields" || method === "get_fields_tree") return { ok: true, value: [{ id: "name" }, { id: "vat" }] };
						if (method === "parse_preview") return { ok: true, value: { headers: ["name", "vat"], sheets: [{ name: "Sheet1", index: 0 }], preview: [["A", "1"]] } };
						return { ok: true, value: true };
					},
				},
				report: "configured",
				serverVersion: "17.0",
			}),
			approve: async (_exec, reason) => {
				approvals.push(reason);
				return approveOutcome;
			},
			authorisedFile: (p) => p.startsWith(proj),
			display: (v) => v,
		});
		const tool = tools.get("odoo_import");
		check("odoo_import is registered", tool !== undefined);

		const noPlan = await tool.execute({ use: "preview", spec_id: "001-imp", batch_id: "b1" });
		check("preview before planning is refused with the reason", noPlan.status === "no-plan");

		// The plan must exist before anything but prepare.
		fnMod.writeState(proj, "001-imp", "plan.json", { specId: "001-imp", environment: "dev", batches: [] });

		const noConfirm = await tool.execute({ use: "prepare", spec_id: "001-imp", batch_id: "b1", file_path: csv, model: "res.partner" });
		check("prepare without confirmation refuses to write", noConfirm.status === "needs-confirmation");
		check("nothing was uploaded", requests.length === 0);

		// Without a web session there is no import, and no password is requested.
		const savedSession = readFileSync(join(proj, ".sdd", "session.json"), "utf8");
		writeFileSync(join(proj, ".sdd", "session.json"), "{}");
		const noSession = await tool.execute({ use: "prepare", spec_id: "001-imp", batch_id: "b1", file_path: csv, model: "res.partner", confirm_destructive: true });
		check("prepare without a session returns NEEDS_WEB_SESSION", noSession.status === "needs-web-session" && /NEEDS_WEB_SESSION/.test(noSession.detail));
		check("no RPC was made without a session", rpc.length === 0);
		writeFileSync(join(proj, ".sdd", "session.json"), savedSession);

		// A file outside the authorised roots is refused.
		const foreign = join(tmpdir(), "outside.csv");
		writeFileSync(foreign, "x\n1\n");
		const notAuthorised = await tool.execute({ use: "prepare", spec_id: "001-imp", batch_id: "b1", file_path: foreign, model: "res.partner", confirm_destructive: true });
		check("a file outside the authorised roots is refused", notAuthorised.status === "not-authorised");

		// A refused human approval uploads nothing.
		approveOutcome = "rejected";
		const refused = await tool.execute({ use: "prepare", spec_id: "001-imp", batch_id: "b1", file_path: csv, model: "res.partner", confirm_destructive: true });
		check("a refused approval stops the preparation", refused.status === "not-approved" && requests.length === 0);

		approveOutcome = "allowed-once";
		const prepared = await tool.execute({ use: "prepare", spec_id: "001-imp", batch_id: "b1", file_path: csv, model: "res.partner", confirm_destructive: true });
		check("an approved preparation uploads the file", prepared.ok === true && prepared.status === "prepared", prepared.detail);
		check("the importer record was created and its id kept", prepared.importId === 55);
		const upload = requests.find((r) => r.url.endsWith("/base_import/set_file"));
		check("the upload used the modern field and the session cookie", upload !== undefined && upload.method === "POST" && String(upload.headers.cookie).includes("SECRET-COOKIE"));
		check("the CSRF token was fetched from /web first", requests.some((r) => r.url.endsWith("/web")));
		check("the cookie never appears in the tool output", !JSON.stringify(prepared).includes("SECRET-COOKIE"));
		check("the approval reason says what is being prepared", approvals.some((r) => /temporary importer/.test(r)));

		const preview = await tool.execute({ use: "preview", spec_id: "001-imp", batch_id: "b1" });
		check("preview reports the headers Odoo read", preview.ok === true && preview.headers.includes("vat"));
		check("preview reports the sheets and the importable fields", preview.sheets.length === 1 && preview.fields.includes("name"));
		check("preview does not apply anything", !rpc.some((c) => c.method === "execute_import" || c.method === "do"));

		const badMap = await tool.execute({ use: "map", spec_id: "001-imp", batch_id: "b1", columns: [{ column: "name", field: "name" }, { column: "vat" }] });
		check("a column without a decision blocks the mapping", badMap.status === "incomplete-mapping" && /vat/.test(badMap.detail));
		const mapped = await tool.execute({
			use: "map",
			spec_id: "001-imp",
			batch_id: "b1",
			columns: [{ column: "name", field: "name" }, { column: "vat", decision: "skip" }],
		});
		check("a complete mapping is recorded", mapped.ok === true && mapped.status === "mapped");

		// The file changed after the upload: the mapping no longer describes it.
		const before = readFileSync(csv, "utf8");
		writeFileSync(csv, before + "B,2\n");
		const changed = await tool.execute({ use: "map", spec_id: "001-imp", batch_id: "b1", columns: [{ column: "name", field: "name" }] });
		check("a file changed after the upload invalidates the mapping", changed.status === "file-changed", changed.detail);
		writeFileSync(csv, before);

		const planned = await tool.execute({ use: "plan", spec_id: "001-imp", batch_id: "b1" });
		check("the import becomes an apply batch of the plan", planned.ok === true && planned.status === "planned");
		const plan = fnMod.readPlan(proj, "001-imp");
		const batch = plan?.batches.find((b) => b.id === "b1");
		check("the batch declares an import operation", batch?.operations[0]?.kind === "import" && batch?.operations[0]?.import?.importId === 55);
		check("the batch scope is apply, never discovery", batch?.scope === "apply");
		check("the import declares how it is recovered", batch?.operations[0]?.recovery?.kind === "none" && String(batch?.operations[0]?.recovery?.note).length > 10);

		// The executor's own validation covers the import declaration.
		check("a well-formed import batch passes validation", fnMod.validateBatch(batch, "dev").filter((f) => f.severity === "ERROR").length === 0);
		const noMapping = { ...batch, operations: [{ ...batch.operations[0], import: { ...batch.operations[0].import, columns: [] } }] };
		check("an import with no mapping is rejected", fnMod.validateBatch(noMapping, "dev").some((f) => f.severity === "ERROR" && /column mapping/.test(f.message)));
		const inDiscovery = { ...batch, scope: "discovery" };
		check("an import cannot live in a discovery batch", fnMod.validateBatch(inDiscovery, "dev").some((f) => f.severity === "ERROR" && /discovery/.test(f.message)));
		const noRecovery = { ...batch, operations: [{ ...batch.operations[0], recovery: undefined }] };
		check("an import without recovery is rejected", fnMod.validateBatch(noRecovery, "dev").some((f) => f.severity === "ERROR" && /recovered/.test(f.message)));

		// ---- sample data is DECLARED, never guessed -------------------------
		// The plugin cannot tell a demo file from a customer list by reading it,
		// and the asymmetry decides the rule: demo rows land in the same tables as
		// real ones, and the journal does not undo a wrong dataset.
		const withKind = (kind) => ({
			...batch,
			operations: [
				{
					...batch.operations[0],
					import: { ...batch.operations[0].import, dataKind: kind },
				},
			],
		});
		const kindErrors = (b, env) => fnMod.validateBatch(b, env).filter((f) => f.severity === "ERROR" && /dataKind|sample/i.test(f.message));
		const sampleWarning = (b, env) => fnMod.validateBatch(b, env).some((f) => f.severity === "WARN" && /sample/i.test(f.message));
		const undeclared = { ...batch, operations: [{ ...batch.operations[0], import: { ...batch.operations[0].import } }] };
		delete undeclared.operations[0].import.dataKind;

		check("an undeclared import into production is refused", kindErrors(undeclared, "production").length === 1);
		check("an undeclared import in dev is not noise", kindErrors(undeclared, "dev").length === 0);
		check("real data in production passes", kindErrors(withKind("real"), "production").length === 0);
		check("sample data in production is refused", kindErrors(withKind("sample"), "production").length === 1);
		check(
			"sample data in staging is a confirmation, not a block",
			kindErrors(withKind("sample"), "staging").length === 0 && sampleWarning(withKind("sample"), "staging"),
		);
		check("an invented dataKind is rejected", kindErrors(withKind("fixture"), "dev").length === 1);
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log(`\n${failures === 0 ? "ALL IMPORT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
