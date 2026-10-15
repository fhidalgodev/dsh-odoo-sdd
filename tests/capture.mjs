/**
 * tests/capture.mjs — Motor 3 E2E: a fake Odoo 17 served with node:http on
 * loopback, captured through the real playwright browser pipeline.
 *
 * Without any usable browser the browser-dependent section prints a visible
 * SKIP; with ODOO_SDD_REQUIRE_BROWSER=1 that SKIP is a failure (CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const capture = await import(join(root, "lib", "manual-capture.js"));
const model = await import(join(root, "lib", "manual-model.js"));

let passed = 0;
const check = (name, cond, extra) => {
	passed += 1;
	assert.ok(cond, extra ? `${name} — ${extra}` : name);
	console.log(`  PASS  ${name}`);
};
const SKIP = (name) => {
	console.log(`  SKIP  ${name}`);
	return "skipped";
};

// ---------------------------------------------------------------------------
// Unit layer: families, PNG verification, safety gating (no browser needed)
// ---------------------------------------------------------------------------
const fam17 = capture.familyFor("17.0");
check("familyFor resolves 17.0 to the verified baseline", fam17.ok && fam17.value.major === 17);
check("familyFor resolves 19.0 (declared untested, still supported)", capture.familyFor("19.0+e").ok);
const fam14 = capture.familyFor("14.0");
check("familyFor REJECTS an unverified major", !fam14.ok && /not verified/.test(fam14.error));
const famBad = capture.familyFor("weird");
check("familyFor rejects a version string without a major", !famBad.ok);

const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
Buffer.from("IHDR").copy(png, 12);
png.writeUInt32BE(1440, 16);
png.writeUInt32BE(900, 20);
const pngOk = capture.verifyPng(png, 1440, 900);
check("verifyPng accepts a real PNG header at 1440x900", pngOk.ok);
const pngBad = capture.verifyPng(Buffer.from("<html>not a png</html>"));
check("verifyPng rejects a non-PNG", !pngBad.ok);
const dims = png.slice();
dims.writeUInt32BE(800, 16);
check("verifyPng rejects a wrong width", !capture.verifyPng(dims, 1440, 900).ok);

const ws = mkdtempSync(join(tmpdir(), "capture-ws-"));
const flowActions = {
	id: "f1",
	title: "Confirm a quotation",
	steps: [
		{ id: "s01", kind: "goto", procedure: null, target: { kind: "action", xmlid: "sale.action_quotations" } },
		{ id: "s02", kind: "fill", procedure: null, field: "partner_id", value: "Acme" },
		{ id: "s03", kind: "screenshot", procedure: null },
	],
};
const readOnly = await capture.captureFlow({
	session: { baseUrl: "http://127.0.0.1:1", sessionId: "x", uid: 2 },
	browser: { newContext: async () => ({ close: async () => {} }) },
	family: fam17.value.family,
	flow: flowActions,
	allowActions: false,
	headed: false,
	zoom: 1,
	workspace: ws,
});
check("an action flow is REJECTED before any browser work", !readOnly.ok && /allow_actions is not true/.test(readOnly.error));
check("zoom outside 1..2 is rejected", !(await capture.captureFlow({
	session: { baseUrl: "http://127.0.0.1:1", sessionId: "x", uid: 2 },
	browser: { newContext: async () => ({ close: async () => {} }) },
	family: fam17.value.family,
	flow: { id: "f0", steps: [] },
	allowActions: false,
	headed: false,
	zoom: 3,
	workspace: ws,
})).ok);
const badResume = await capture.captureFlow({
	session: { baseUrl: "http://127.0.0.1:1", sessionId: "x", uid: 2 },
	browser: { newContext: async () => ({ close: async () => {} }) },
	family: fam17.value.family,
	flow: flowActions,
	fromStep: "s99",
	allowActions: false,
	headed: false,
	zoom: 1,
	workspace: ws,
});
check("an unknown from_step is rejected", !badResume.ok && /from_step/.test(badResume.error));

// ---------------------------------------------------------------------------
// Browser layer against the fake Odoo
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html><html><head><title>Odoo</title></head><body>
<nav class="o_main_navbar"><span data-menu-xmlid="sale.sale_menu_root">Sales</span></nav>
<div class="o_action_manager"><div class="o_form_view">
<header><div class="o_form_statusbar"><span>Quotation</span></div>
<div class="o_statusbar_buttons"><button name="action_confirm" type="object">Confirm</button></div></header>
<div class="o_field_char" name="partner_id"><input name="partner_id"/></div>
<h1>Quotations</h1>
</div></div></body></html>`;

const server = createServer((req, res) => {
	if (req.url?.startsWith("/web/session/authenticate")) {
		res.writeHead(200, { "content-type": "application/json", "set-cookie": "session_id=fakesession123; Path=/" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { uid: 2 } }));
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const pw = await capture.loadPlaywright();
let browser = null;
if (pw.ok) {
	const opened = await capture.resolveBrowser(pw.value.chromium, "auto", false);
	if (opened.ok) browser = opened.value;
}
try {
	if (!browser) {
		const msg = "SKIP: no usable browser (install playwright-core chromium or Chrome) — browser-dependent checks skipped";
		console.log(`  ${msg}`);
		if (process.env.ODOO_SDD_REQUIRE_BROWSER === "1") {
			throw new Error("ODOO_SDD_REQUIRE_BROWSER=1 but no browser is available");
		}
	} else {
		const flow = {
			id: "f-ro",
			title: "Look at quotations",
			steps: [
				{ id: "s01", kind: "goto", procedure: null, target: { kind: "action", xmlid: "sale.action_quotations" } },
				{ id: "s02", kind: "screenshot", procedure: null },
			],
		};
		const outDir = mkdtempSync(join(tmpdir(), "capture-e2e-"));
		const res = await capture.captureFlow({
			session: { baseUrl, sessionId: "fakesession123", uid: 2 },
			browser,
			family: fam17.value.family,
			flow,
			allowActions: false,
			headed: false,
			zoom: 1,
			workspace: outDir,
		});
		check("the read-only capture runs", res.ok === true, res.ok ? "" : res.error);
		if (res.ok) {
			const shot = res.value.steps.find((s) => s.screenshot);
			check("the screenshot step produced a 1440x900 PNG", shot?.screenshot?.width === 1440 && shot?.screenshot?.height === 900, JSON.stringify(shot));
			const abs = join(outDir, shot.screenshot.file);
			check("the PNG exists and is a real PNG on disk", existsSync(abs) && capture.verifyPng(readFileSync(abs)).ok);
			check("the overlay is removed after every screenshot", res.value.overlaysRemoved === true);
			const report = JSON.parse(readFileSync(join(outDir, "capture.json"), "utf8"));
			check("capture.json is written with the capture schema", report.schema === "dsh-odoo-sdd/capture/1" && report.originLocked === true);
		}
		// Origin lock: an explicit external URL is refused before navigation.
		const external = await capture.captureFlow({
			session: { baseUrl, sessionId: "fakesession123", uid: 2 },
			browser,
			family: fam17.value.family,
			flow: { id: "f-ext", steps: [{ id: "s01", kind: "goto", procedure: null, target: { kind: "url", url: "http://example.invalid/web" } }, { id: "s02", kind: "screenshot", procedure: null }] },
			allowActions: false,
			headed: false,
			zoom: 1,
			workspace: outDir,
		});
		check("an external URL is refused by the origin lock", external.ok === false || external.value.steps[0].status === "error", JSON.stringify(external.ok ? external.value.steps[0] : external.error));
		// explore: aria snapshot of the action manager.
		const aria = await capture.exploreScreen({
			session: { baseUrl, sessionId: "fakesession123", uid: 2 },
			browser,
			family: fam17.value.family,
			headed: false,
			zoom: 1,
			target: { kind: "action", xmlid: "sale.action_quotations" },
		});
		check("explore returns an aria snapshot", aria.ok === true && /action_manager|Quotations/.test(aria.value.aria), aria.ok ? aria.value.aria.slice(0, 80) : aria.error);
		rmSync(outDir, { recursive: true, force: true });
	}
} finally {
	if (browser) await browser.close().catch(() => {});
	server.close();
}

check("the storyboard round-trips with capture evidence", (() => {
	const sbDir = join(ws, "sb");
	mkdirSync(sbDir, { recursive: true });
	model.writeStoryboard(sbDir, { schema: "dsh-odoo-sdd/manual/1", slug: "capture", flows: [{ id: "f1", title: "t", steps: [{ id: "s01", kind: "screenshot", procedure: null }], captures: [{ stepId: "s01", file: "images/x.png", sha256: "abc" }] }] });
	const back = model.readStoryboard(sbDir);
	return back.flows[0].captures[0].sha256 === "abc";
})());

rmSync(ws, { recursive: true, force: true });
console.log(`\ncapture: ${passed} checks passed`);
