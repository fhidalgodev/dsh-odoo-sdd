/**
 * tests/manual.mjs — `odoo_manual` fase 1: canon collector, arch parser,
 * module error scan and the manual workspace resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
// import() needs a URL: a Windows drive path is not a valid specifier.
const libUrl = (name) => pathToFileURL(join(root, "lib", name)).href;
const lib = await import(libUrl("index.js"));
const sddState = await import(libUrl("sdd-state.js"));
const { initSpecDir, loadState, saveState } = sddState;
const cpsMod = await import(libUrl("checkpoints.js"));
// The lib entry re-exports the apply() mount; the canon internals live in the
// compiled module files, imported directly.
const canon = await import(libUrl("manual-canon.js"));
const model = await import(libUrl("manual-model.js"));

let passed = 0;
const check = (name, cond, extra) => {
	passed += 1;
	assert.ok(cond, extra ? `${name} — ${extra}` : name);
	console.log(`  PASS  ${name}`);
};

// ---------------------------------------------------------------------------
// parseArch — Odoo 17 style (plain invisible expressions) and 14–16 style
// (attrs JSON / states lists)
// ---------------------------------------------------------------------------
const ARCH17 = `
<form string="Sale Order">
  <header>
    <field name="state" widget="statusbar" statusbar_visible="draft,sent"/>
    <button name="action_confirm" type="object" string="Confirm" invisible="state not in ('draft', 'sent')"/>
    <button name="action_cancel" type="object" string="Cancel" confirm="Are you sure?" invisible="state == 'cancel'"/>
    <button name="action_draft" type="object" string="Set to Quotation" invisible="state in ('draft','sent')"/>
  </header>
  <sheet>
    <group>
      <field name="partner_id" required="1"/>
      <field name="validity_date" required="1" invisible="state != 'draft'"/>
      <field name="note"/>
    </group>
    <notebook>
      <page string="Order Lines" name="lines">
        <field name="order_line"/>
      </page>
      <page string="Other Info" name="other" invisible="1"/>
    </notebook>
  </sheet>
</form>`;

const ARCH15 = `
<form string="Sale Order">
  <header>
    <field name="state" widget="statusbar"/>
    <button name="action_confirm" type="object" states="draft,sent" string="Confirm"/>
    <button name="print_quotation" type="object" states="sent" string="Print"/>
  </header>
  <sheet>
    <field name="partner_id" attrs="{'required': [('state','in',('draft',))], 'invisible': [('state','not in',['draft','sent'])]}"/>
    <field name="amount_total"/>
  </sheet>
</form>`;

const LIST17 = `<list><field name="name"/><field name="amount_total" optional="1" invisible="1"/></list>`;
const SEARCH17 = `<search><field name="name"/><filter name="my" string="My Orders" domain="[('user_id','=','uid')]"/></search>`;

const form17 = canon.parseArch(ARCH17);
check("parseArch keeps the header buttons in document order", form17.buttons.map((b) => b.name).join() === "action_confirm,action_cancel,action_draft");
check("parseArch reads a simple invisible expression into visibleStates", form17.buttons[0].visibleStates?.join() === "draft,sent");
check("parseArch keeps the raw expression as evidence", form17.buttons[0].invisibleRaw === "state not in ('draft', 'sent')");
check("parseArch marks confirm buttons", form17.buttons[1].confirm === true);
check("parseArch treats invisible='state in (...)' as hidden states (no visibleStates)", form17.buttons[2].visibleStates === undefined);
check("parseArch reads the statusbar", form17.statusbar?.field === "state" && form17.statusbar.visibleStates?.join() === "draft,sent");
check("parseArch reads required fields", form17.fields.find((f) => f.name === "partner_id")?.required === true);
check("parseArch reads notebook pages", form17.pages.map((p) => p.string).join() === "Order Lines,Other Info");

const form15 = canon.parseArch(ARCH15);
check("parseArch reads legacy states= lists into visibleStates", form15.buttons[0].visibleStates?.join() === "draft,sent" && form15.buttons[1].visibleStates?.join() === "sent");
check("parseArch keeps legacy attrs JSON raw", (form15.fields[0].attrsRaw ?? "").includes("'invisible'"));
check("parseArch extracts simple state domains from attrs", form15.fields[0].visibleStates?.join() === "draft,sent");

const list17 = canon.parseArch(LIST17);
check("parseArch reads list columns with their optional flag", list17.listColumns[0].name === "name" && list17.listColumns[1].optional === true);
const search17 = canon.parseArch(SEARCH17);
check("parseArch reads search filters with their domain", search17.filters[0]?.name === "my" && (search17.filters[0]?.domain ?? "").includes("user_id"));

// ---------------------------------------------------------------------------
// scanModuleErrors — raise UserError/ValidationError and _sql_constraints
// ---------------------------------------------------------------------------
const modDir = mkdtempSync(join(tmpdir(), "manual-mod-"));
mkdirSync(join(modDir, "models"), { recursive: true });
writeFileSync(
	join(modDir, "models", "sale_order.py"),
	[
		"from odoo.exceptions import UserError, ValidationError",
		"class SaleOrder(models.Model):",
		"    _sql_constraints = [",
		"        ('name_uniq', 'unique(name)', 'The name must be unique'),",
		"    ]",
		"    def action_confirm(self):",
		"        raise UserError(_('You cannot confirm an empty order'))",
		"    def _check_qty(self):",
		"        raise ValidationError(_('Quantity must be positive'))",
	].join("\n"),
	{ mode: 0o600 },
);
const errs = canon.scanModuleErrors(modDir);
check("scanModuleErrors finds raises with file:line and method", errs.some((e) => e.kind === "raise" && e.method === "action_confirm" && e.line === 7 && e.file.endsWith("sale_order.py")));
check("scanModuleErrors tags ValidationError evidence", errs.some((e) => e.kind === "raise" && e.method === "_check_qty"));
check("scanModuleErrors finds _sql_constraints entries", errs.some((e) => e.kind === "constraint" && e.name === "name_uniq"));
check("scanModuleErrors on a missing directory returns nothing", canon.scanModuleErrors(join(modDir, "nope")).length === 0);

// ---------------------------------------------------------------------------
// collectCanon — the FIXED read list, per server version, with a fake client
// ---------------------------------------------------------------------------
const FORM_ARCH_19 = ARCH17.replace('invisible="state in (\'draft\',\'sent\')"', 'invisible="state in (\'draft\', \'sent\')"');
/** A fake client that records calls and answers with the minimum the collector reads. */
function fakeClient(major, options = {}) {
	const calls = [];
	const row = (obj) => ({ id: calls.length, ...obj });
	const client = {
		calls,
		version: async () => ({ ok: true, value: { server_version: `${major}.0` } }),
		...(options.connectedUser ? { currentUid: () => 7 } : {}),
		executeKw: async (m, method, args, kwargs) => {
			calls.push(`${m}.${method}`);
			const ctx = kwargs?.context ?? {};
			const lang = ctx.lang ?? "";
			if (m === "res.lang" && method === "search_read") {
				return { ok: true, value: [row({ code: "en_US" }), row({ code: "es_VE" })] };
			}
			if (lang === "") return { ok: false, error: "no context lang sent", errorKind: "protocol" };
			if (m === "ir.model") {
				if (kwargs?.context?.model !== undefined) throw new Error("ir.model must carry context.lang");
				// the collector filters by model; only sale.order exists here
				const [domain] = args;
				if (JSON.stringify(domain).includes('"no.model"')) return { ok: true, value: [] };
				// Module scope asks "what does this module implement" with a
				// `like` prefilter the collector then confirms exactly.
				if (options.module && JSON.stringify(domain).includes('"like"')) {
					return { ok: true, value: [
						row({ model: "sale.order", name: "Sales Order", modules: "sale,sale_stock" }),
						row({ model: "sale.report", name: "Sales Analysis", modules: "sale" }),
						row({ model: "stock.picking", name: "Transfer", modules: "sale_stock" }),
					] };
				}
				return { ok: true, value: [row({ modules: "sale" })] };
			}
			if (m === "ir.actions.act_window" && args[1]?.length === 1) {
				return { ok: true, value: [row({ name: "Orders", view_mode: "list,form", domain: "[]", context: "{}", target: "current" })] };
			}
			if (m === "ir.actions.act_window") {
				if (options.module) {
					// the module inventory reads by id: echo them, so xmlids map back
					const ids = (JSON.stringify(args).match(/"id","in",\[([^\]]*)\]/)?.[1] ?? "51").split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
					return { ok: true, value: ids.map((id) => row({ id, name: "Quotations", res_model: "sale.order", view_mode: "list,form", domain: "[]", context: "{}", target: "current" })) };
				}
				return { ok: true, value: [row({ id: 1 })] };
			}
			if (m === "ir.actions.server" && options.module) {
				return { ok: true, value: [row({ id: 52, name: "Confirm server", model_name: "sale.order", state: "code" })] };
			}
			if (m === "ir.ui.menu") {
				if (options.module) {
					// Every menu the module owns, in menu order, with the action it
					// opens: 41 opens a NATIVE action, 42 an owned one, 43 none.
					return { ok: true, value: [
						row({ id: 42, complete_name: "Sales/Orders/Quotations", sequence: 2, action: "ir.actions.act_window,51", groups_id: [[5, "User"]] }),
						row({ id: 41, complete_name: "Sales/Reporting", sequence: 1, action: "ir.actions.act_report,77", groups_id: [] }),
						row({ id: 43, complete_name: "Sales/Settings", sequence: 3, action: false, groups_id: [] }),
					] };
				}
				return { ok: true, value: [row({ complete_name: "Sales/Orders/Quotations" })] };
			}
			if (m === "res.users" && method === "read") {
				return { ok: true, value: [row({ login: options.connectedUser, groups_id: options.connectedAdmin ? [[4, "Settings"], [5, "User"]] : [[5, "User"]] })] };
			}
			if (m === "ir.model.access") return { ok: true, value: [row({ name: "sale.order.user", group_id: [5, "User"], perm_read: true, perm_write: true, perm_create: true, perm_unlink: false })] };
			if (m === "ir.rule") return { ok: true, value: [row({ name: "own orders", groups: [[5, "User"]], domain_force: "[('user_id','=',uid)]", active: true })] };
			if (m === "res.groups") return { ok: true, value: [row({ full_name: "Sales/User" })] };
			if (m === "ir.model.data") {
				// Module scope: what the module OWNS. The ir.qweb row proves
				// ownership is read from data, not matched by name.
				if (options.module && JSON.stringify(args[0]).includes(`["module","=","${options.module}"]`)) {
					return { ok: true, value: [
						row({ module: options.module, model: "ir.ui.menu", res_id: 41, name: "menu_reporting" }),
						row({ module: options.module, model: "ir.ui.menu", res_id: 42, name: "menu_quotations" }),
						row({ module: options.module, model: "ir.ui.menu", res_id: 43, name: "menu_settings" }),
						row({ module: options.module, model: "ir.actions.act_window", res_id: 51, name: "action_quotations" }),
						row({ module: options.module, model: "ir.actions.server", res_id: 52, name: "action_server_confirm" }),
						row({ module: options.module, model: "ir.qweb", res_id: 53, name: "not_a_menu_nor_action" }),
					] };
				}
				// echo the res_ids the domain asks for, so xmlids map back; a
				// module-owned record keeps the name the inventory gave it.
				const idsMatch = JSON.stringify(args).match(/"res_id","in",\[([^\]]*)\]/);
				const ids = idsMatch ? idsMatch[1].split(",").filter(Boolean) : [1];
				const owned = options.module ? { 41: "menu_reporting", 42: "menu_quotations", 43: "menu_settings", 51: "action_quotations", 52: "action_server_confirm" } : {};
				const native = { 4: ["base", "group_system"], 5: ["sales_team", "group_sale_salesman"] };
				return {
					ok: true,
					value: ids.map((id) => {
						const n = Number(id.trim());
						if (native[n]) return row({ module: native[n][0], name: native[n][1], res_id: n });
						return row({ module: options.module ?? "sale", name: owned[n] ?? `xml_${n}`, res_id: n });
					}),
				};
			}
			if (method === "fields_get" && options.module && m === "sale.report") {
				return { ok: false, error: "AccessError: you are not allowed to access this document", errorKind: "protocol" };
			}
			if (method === "fields_get") {
				const key = major >= 19 ? "group_ids" : "groups_id";
				return { ok: true, value: { partner_id: { string: "Customer", type: "many2one", required: true, relation: "res.partner", modules: "sale", [key]: [] }, note: { string: "Notes", type: "text", required: false, modules: "sale", [key]: [] } } };
			}
			if (method === "get_views") return { ok: true, value: { views: { form: { arch: FORM_ARCH_19 }, list: { arch: LIST17 }, search: { arch: SEARCH17 } } } };
			if (method === "load_views") return { ok: true, value: { fields_views: { form: { arch: ARCH15 }, list: { arch: LIST17 }, search: { arch: SEARCH17 } } } };
			return { ok: false, error: `unexpected call ${m}.${method}`, errorKind: "protocol" };
		},
	};
	return client;
}

for (const major of [15, 17, 19]) {
	const client = fakeClient(major);
	const r = await canon.collectCanon(client, { model: "sale.order", serverVersion: `${major}.0`, language: "es", moduleName: "sale", moduleDir: modDir });
	check(`collectCanon v${major} succeeds against the fixed read list`, r.ok === true, r.ok ? "" : r.blocked);
	if (!r.ok) continue;
	const viewMethod = major >= 16 ? "get_views" : "load_views";
	check(`collectCanon v${major} reads views through ${viewMethod}`, client.calls.includes(`sale.order.${viewMethod}`) && !client.calls.some((c) => c.endsWith(`.${major >= 16 ? "load_views" : "get_views"}`)));
	check(`collectCanon v${major} resolves the language by prefix`, r.canon.language === "es_VE");
	check(`collectCanon v${major} parses the form arch`, r.canon.views.find((v) => v.type === "form") !== undefined);
	check(`collectCanon v${major} records the access evidence`, r.canon.access.access[0]?.perms === "rwc-" && r.canon.access.rules[0]?.groups[0] === "User");
	check(`collectCanon v${major} scans own error evidence`, r.canon.errors.own?.path === modDir && r.canon.errors.own.errors.length === 3);
	check(`collectCanon v${major} reports native evidence as not configured`, (r.canon.errors.community?.note ?? "").includes("communityRepoPath"));
}
const r19 = await canon.collectCanon(fakeClient(19), { model: "sale.order", serverVersion: "19.0", language: "es", moduleName: "sale", moduleDir: modDir });
check("collectCanon v19 uses group_ids", r19.ok && r19.canon.groupsAttr === "group_ids");
const r17 = await canon.collectCanon(fakeClient(17), { model: "sale.order", serverVersion: "17.0", language: "es" });
check("collectCanon v17 uses groups_id", r17.ok && r17.canon.groupsAttr === "groups_id");
const rLang = await canon.collectCanon(fakeClient(17), { model: "sale.order", serverVersion: "17.0", language: "de" });
check("collectCanon BLOCKS on an installed-language miss", rLang.ok === false && rLang.blocked.includes("not installed"));
const rModel = await canon.collectCanon(fakeClient(17), { model: "no.model", serverVersion: "17.0", language: "en_US" });
check("collectCanon BLOCKS on an unknown model", rModel.ok === false && rModel.blocked.includes("does not exist"));

const canonObj = r17.ok ? r17.canon : null;
if (canonObj) {
	const fp1 = canon.canonFingerprint(canonObj);
	const fp2 = canon.canonFingerprint(canonObj);
	check("canonFingerprint is stable for the same canon", fp1 === fp2 && /^[0-9a-f]{64}$/.test(fp1));
	const summary = canon.summarizeCanon(canonObj);
	check("summarizeCanon stays bounded and readable", summary.model === "sale.order" && Array.isArray(summary.requiredFields) && typeof summary.buttons === "number");
}

// ---------------------------------------------------------------------------
// Manual workspace resolution — the 3 modes plus the rejections
// ---------------------------------------------------------------------------
const proj = mkdtempSync(join(tmpdir(), "manual-ws-"));
const specsBase = join(proj, "specs");
const specDir = join(specsBase, "001-demo");
mkdirSync(specDir, { recursive: true });
const wsSpec = model.resolveManualWorkspace({ mode: "specs", dir: "docs/manuals", projectRoot: proj, specsBase, specDir, slug: "quotations" });
check("workspace specs mode: next to the spec", wsSpec.ok && wsSpec.dir === join(specsBase, "manuals", "quotations"));
const wsStandalone = model.resolveManualWorkspace({ mode: "specs", dir: "docs/manuals", projectRoot: proj, specsBase, slug: "quotations" });
check("workspace specs mode WITHOUT a spec never blocks", wsStandalone.ok && wsStandalone.dir === join(specsBase, "manuals", "quotations"));
const wsDocs = model.resolveManualWorkspace({ mode: "docs", dir: "docs/manuals", projectRoot: proj, specsBase, slug: "quotations" });
check("workspace docs mode: under the configured folder", wsDocs.ok && wsDocs.dir === join(proj, "docs", "manuals", "quotations"));
const wsEscapes = model.resolveManualWorkspace({ mode: "docs", dir: "../outside", projectRoot: proj, specsBase, slug: "quotations" });
check("workspace docs mode rejects a manualsDir outside the project", wsEscapes.ok === false && wsEscapes.blocked.includes("outside the project"));
const moduleDir = join(proj, "my_module");
mkdirSync(moduleDir, { recursive: true });
const wsModule = model.resolveManualWorkspace({ mode: "module", dir: "docs/manuals", projectRoot: proj, specsBase, moduleDir, slug: "quotations" });
check("workspace module mode: OCA fragments under readme/manual", wsModule.ok && wsModule.dir === join(moduleDir, "readme", "manual", "quotations"));
const wsNoModule = model.resolveManualWorkspace({ mode: "module", dir: "docs/manuals", projectRoot: proj, specsBase, slug: "quotations" });
check("workspace module mode without module_dir is BLOCKED", wsNoModule.ok === false && wsNoModule.blocked.includes("module_dir"));
const wsBadSlug = model.resolveManualWorkspace({ mode: "specs", dir: "docs/manuals", projectRoot: proj, specsBase, slug: "../evil" });
check("workspace rejects an ascending slug", wsBadSlug.ok === false && wsBadSlug.blocked.includes("safe folder name"));
// A configured path that arrives as an object — the Settings layer resolves a
// field it has no value for that way — must BLOCK with the offending key named,
// never crash inside node:path with "The \"path\" argument must be of type
// string. Received an instance of Object".
const wsObjectDir = model.resolveManualWorkspace({ mode: "docs", dir: {}, projectRoot: proj, specsBase, slug: "quotations" });
check("workspace docs mode blocks a manualsDir that is not a string", wsObjectDir.ok === false && wsObjectDir.blocked.includes("manualsDir"));
const wsObjectBase = model.resolveManualWorkspace({ mode: "specs", dir: "docs/manuals", projectRoot: proj, specsBase: {}, slug: "quotations" });
check("workspace specs mode blocks a specsBase that is not a string", wsObjectBase.ok === false && wsObjectBase.blocked.includes("specsBase"));
const wsObjectModule = model.resolveManualWorkspace({ mode: "module", dir: "docs/manuals", projectRoot: proj, specsBase, moduleDir: {}, slug: "quotations" });
check("workspace module mode blocks a module_dir that is not a string", wsObjectModule.ok === false && wsObjectModule.blocked.includes("module_dir"));
check("workspace blocks an EMPTY configured folder instead of joining nothing", (() => {
	const r = model.resolveManualWorkspace({ mode: "docs", dir: "   ", projectRoot: proj, specsBase, slug: "quotations" });
	return r.ok === false && r.blocked.includes("empty string");
})());
check("a mode never reads a setting it does not use", (() => {
	// module mode does not join projectRoot, so a broken one cannot block it.
	const r = model.resolveManualWorkspace({ mode: "module", dir: {}, projectRoot: {}, specsBase: {}, moduleDir, slug: "quotations" });
	return r.ok === true && r.dir === join(moduleDir, "readme", "manual", "quotations");
})());

// Storyboard round-trip (atomic write, schema check, stable ids)
const sb = { schema: "dsh-odoo-sdd/manual/1", slug: "quotations", flows: [{ id: "f1", title: "Confirm a quotation", steps: [{ id: "s01", kind: "goto", procedure: null }] }] };
model.writeStoryboard(wsStandalone.dir, sb);
check("writeStoryboard persists atomically and readStoryboard round-trips", existsSync(join(wsStandalone.dir, "storyboard.json")) && model.readStoryboard(wsStandalone.dir).flows[0].id === "f1");
check("nextFlowId never reuses an id", model.nextFlowId({ ...sb, flows: [...sb.flows, { id: "f2" }] }) === "f3");
check("listManuals finds storyboards in a manuals tree", model.listManuals(join(specsBase, "manuals")).length === 1);
check("readStoryboard rejects a foreign schema", (() => {
	writeFileSync(join(wsStandalone.dir, "storyboard.json"), JSON.stringify({ schema: "other/1" }), { mode: 0o600 });
	try {
		model.readStoryboard(wsStandalone.dir);
		return false;
	} catch (e) {
		return String(e.message).includes("not a dsh-odoo-sdd manual storyboard");
	}
})());
check("listManuals skips a corrupt/foreign storyboard file instead of throwing", model.listManuals(join(specsBase, "manuals")).length === 0);

// ---------------------------------------------------------------------------
// The plugin mounts odoo_manual and honours the config keys
// ---------------------------------------------------------------------------
const capturedGuards = [];
const registered = new Map();
lib.apply(
	{ tools: { register: (t) => registered.set(t.name, t), guard: (g) => { capturedGuards.push(g); return () => {}; } }, on: () => () => {} },
	{},
);
check("the plugin registers odoo_manual", registered.has("odoo_manual"));
const manualTool = registered.get("odoo_manual");
check("odoo_manual exposes the seven motor operations", JSON.stringify(manualTool.parameters.properties.operation.enum) === JSON.stringify(["canon", "plan", "lint", "render", "explore", "capture", "import"]));
check("odoo_manual requires only the operation up front", Array.isArray(manualTool.parameters.required) && JSON.stringify(manualTool.parameters.required) === JSON.stringify(["operation"]));

const canonBlocked = await manualTool.execute({ operation: "canon", model: "sale.order" }, undefined);
check("odoo_manual canon NEEDS an instance instead of inventing", canonBlocked.ok === false && /instance|connection/i.test(canonBlocked.detail));

// A HOSTILE deployment config: every key the project's .sdd/config.json does
// not set arrives as a descriptor OBJECT (that is what took the whole manual
// surface down with "The \"path\" argument must be of type string. Received an
// instance of Object"). The guard must fall back to the declared default and
// keep working, naming a real folder — never pass the object to node:path.
const mountHostile = (deployment) => {
	const reg = new Map();
	lib.apply({ tools: { register: (t) => reg.set(t.name, t), guard: () => () => {} }, on: () => () => {} }, deployment);
	return reg.get("odoo_manual");
};
{
	const projHostile = mkdtempSync(join(tmpdir(), "manual-hostile-"));
	// docs mode with a broken manualsDir: this is the exact shape that crashed.
	const docsTool = mountHostile({ projectRoot: projHostile, manualsMode: "docs", manualsDir: { descriptor: "manualsDir" } });
	const docsRes = await docsTool.execute({ operation: "lint", model: "sale.order", slug: "probe" }, undefined);
	// The message is display-normalised (the home folder becomes "~"), and on
	// Windows tmpdir() lives UNDER the home, so the whole prefix is replaced:
	// assert on the tail of the folder instead of on the absolute path.
	check("a descriptor object in manualsDir falls back to the default folder", docsRes.ok === false && String(docsRes.detail).includes(join("docs", "manuals", "probe")));
	check("the crash message never reaches the developer", !/instance of Object/.test(String(docsRes.detail)));

	// Every path key broken at once: mode, specsDir and specsRoot are objects.
	const allTool = mountHostile({ projectRoot: projHostile, manualsMode: {}, manualsDir: {}, specsDir: {}, specsRoot: {} });
	const allRes = await allTool.execute({ operation: "lint", model: "sale.order", slug: "probe" }, undefined);
	check("broken mode/specsDir/specsRoot fall back to the built-in defaults", allRes.ok === false && String(allRes.detail).includes(join("specs", "manuals", "probe")));

	// A call that cannot resolve its folder at all still answers, explaining which key to fix.
	const none = model.resolveManualWorkspace({ mode: "docs", dir: {}, projectRoot: projHostile, specsBase: join(projHostile, "specs"), slug: "probe" });
	check("the fallback blocked message names the key and where to fix it", none.ok === false && none.blocked.includes("manualsDir") && /Settings → Odoo SDD|\.sdd\/config\.json/.test(none.blocked));
	rmSync(projHostile, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Guard classification: capture with actions is a MUTATION; read-only is not
// ---------------------------------------------------------------------------
{
	const projGuard = mkdtempSync(join(tmpdir(), "manual-guard-"));
	lib.apply({ tools: { register: () => {}, guard: (g) => { capturedGuards.push(g); return () => {}; } }, on: () => () => {} }, { projectRoot: projGuard });
	const guard = capturedGuards[capturedGuards.length - 1];
	check("the guard is registered per project", typeof guard === "function");
	const actionCap = guard({ name: "odoo_manual", arguments: { operation: "capture", allow_actions: true } });
	check("capture with allow_actions is classified as a MUTATION", typeof actionCap === "string" && /no spec for this project/.test(actionCap));
	check("read-only capture is NOT classified as a mutation", guard({ name: "odoo_manual", arguments: { operation: "capture" } }) === undefined);
	check("explore is NOT classified as a mutation", guard({ name: "odoo_manual", arguments: { operation: "explore", menu: "x" } }) === undefined);

	// With a writing spec, the checkpoint policy applies to action captures.
	const specDirG = join(projGuard, "specs", "001-manual");
	initSpecDir(specDirG);
	const stG = loadState(specDirG);
	stG.phase = "WRITE_CODE";
	saveState(stG);
	cpsMod.writeActiveState(projGuard, { specId: "001-manual", phase: "WRITE_CODE" });
	const afterSpec = guard({ name: "odoo_manual", arguments: { operation: "capture", allow_actions: true } });
	check("an action capture needs a checkpoint like any write", typeof afterSpec === "string" && afterSpec.includes("no checkpoint"));
	// The guard reads `active.checkpointId`, so point the active state at one.
	cpsMod.writeActiveStateFor(projGuard, undefined, { specId: "001-manual", phase: "WRITE_CODE", checkpointId: "cp-manual" });
	check("after the checkpoint the action capture is allowed", guard({ name: "odoo_manual", arguments: { operation: "capture", allow_actions: true } }) === undefined);
	check("confirm_destructive stays a TOOL-level fence (guard only sees allow_actions)", guard({ name: "odoo_manual", arguments: { operation: "capture", allow_actions: true } }) === undefined);

	// stop.md halts EVERYTHING, read-only captures included.
	writeFileSync(join(projGuard, ".sdd", "stop.md"), "halted", { mode: 0o600 });
	check("stop.md halts read-only capture too", typeof guard({ name: "odoo_manual", arguments: { operation: "capture" } }) === "string");
	rmSync(projGuard, { recursive: true, force: true });
}


// ---------------------------------------------------------------------------
// Fase 2 — plan / validate against the canon
// ---------------------------------------------------------------------------
const prose = await import(libUrl("prose-lint.js"));
const render = await import(libUrl("manual-render.js"));
const docsScan = await import(libUrl("docs-scan.js"));

// Re-collect WITH module_dir so the error evidence (raising methods) is in
// the fixture canon — the recovery rule depends on it.
const r17full = await canon.collectCanon(fakeClient(17), { model: "sale.order", serverVersion: "17.0", language: "es", moduleName: "sale", moduleDir: modDir });
const canon17 = r17full.ok ? r17full.canon : null;
check("fixture canon is available for Fase 2", canon17 !== null);
if (canon17) {
	const sbPlan = model.planStoryboard(canon17, "quotations");
	const steps = sbPlan.flows[0].steps;
	check("planStoryboard drafts goto → new → fill → clicks → screenshot", steps.map((s) => s.kind).join() === "goto,new,fill,click,click,click,screenshot", steps.map((s) => s.kind).join());
	check("planStoryboard orders header buttons by statusbar states (unknown last)", steps.filter((s) => s.kind === "click").map((s) => s.field).join() === "action_confirm,action_cancel,action_draft");
	check("planStoryboard only fills canon-required fields", steps.filter((s) => s.kind === "fill" || s.kind === "select").map((s) => s.field).join() === "partner_id");
	check("planStoryboard leaves narration null (TODO for the storyteller)", steps.every((s) => s.procedure === null));
	check("planStoryboard records the canon fingerprint", (() => {
		sbPlan.canonFingerprint = canon.canonFingerprint(canon17);
		return model.validateStoryboard(sbPlan, canon17).every((f) => f.rule !== "CANON-STALE");
	})());

	const findingsFresh = model.validateStoryboard(sbPlan, canon17);
	check("a fresh plan is TODO everywhere and needs recovery for the raising button", findingsFresh.some((f) => f.rule === "TODO" && f.severity === "WARN") && findingsFresh.some((f) => f.rule === "RECOVERY-MISSING" && f.severity === "ERROR" && (f.message ?? "").includes("action_confirm")) && findingsFresh.some((f) => f.rule === "RECOVERY-MISSING" && f.severity === "WARN"));

	const stale = { ...sbPlan, canonFingerprint: "0".repeat(64) };
	check("CANON-STALE is an ERROR against a different fingerprint", model.validateStoryboard(stale, canon17).some((f) => f.rule === "CANON-STALE" && f.severity === "ERROR"));

	const bad = JSON.parse(JSON.stringify(sbPlan));
	bad.flows[0].steps[0].target = { kind: "action", xmlid: "sale.not_in_canon" };
	bad.flows[0].steps[2].field = "nope_field";
	bad.flows[0].steps[3].field = "nope_button";
	bad.flows[0].role = "x.unknown_role";
	bad.flows[0].steps[1].procedure = "TODO: narrate later";
	const badFindings = model.validateStoryboard(bad, canon17);
	check("TARGET-UNKNOWN cites unknown action/field/button", ["action", "field", "button"].every((w) => badFindings.some((f) => f.rule === "TARGET-UNKNOWN" && f.message.includes(w))));
	check("ROLE-UNKNOWN warns on a group the canon did not read", badFindings.some((f) => f.rule === "ROLE-UNKNOWN"));
	check("PLACEHOLDER-UNBOUND is an ERROR", badFindings.some((f) => f.rule === "PLACEHOLDER-UNBOUND" && f.severity === "ERROR"));
}

// ---------------------------------------------------------------------------
// Module scope — EVERY menu and EVERY action the module owns is coverage surface
// ---------------------------------------------------------------------------
const rModule = await canon.collectCanon(fakeClient(17, { module: "sale" }), {
	model: "sale.order",
	serverVersion: "17.0",
	language: "es",
	module: "sale",
	moduleDir: modDir,
});
check("module canon succeeds", rModule.ok === true, rModule.ok ? "" : rModule.blocked);
if (rModule.ok) {
	const inv = rModule.canon.module;
	const moduleSb = model.planStoryboard(rModule.canon, "sale-module");
	const coverage = (sb) => model.validateStoryboard(sb, rModule.canon).filter((f) => f.rule === "MODULE-COVERAGE");
	check("module inventory is present and named", inv?.name === "sale");
	check(
		"module inventory reads EVERY menu the module owns, in menu order",
		(inv?.menus ?? []).map((m) => m.completeName).join(" | ") === "Sales/Reporting | Sales/Orders/Quotations | Sales/Settings",
		JSON.stringify(inv?.menus),
	);
	check("module inventory maps a menu to the action it opens", inv?.menus.find((m) => m.xmlid === "sale.menu_quotations")?.actionXmlid === "sale.action_quotations");
	check("module inventory keeps a menu that opens a NATIVE action", inv?.menus.find((m) => m.xmlid === "sale.menu_reporting")?.actionXmlid === "sale.xml_77");
	check("module inventory keeps a menu that opens nothing", inv?.menus.find((m) => m.xmlid === "sale.menu_settings")?.actionXmlid === undefined);
	check(
		"module inventory reads every action kind the module owns, and nothing else",
		(inv?.actions ?? []).map((a) => a.kind).join() === "ir.actions.act_window,ir.actions.server",
		JSON.stringify(inv?.actions),
	);
	check("module inventory records the model of an act_window action", inv?.actions.find((a) => a.xmlid === "sale.action_quotations")?.model === "sale.order");
	check("module inventory records the detail of a server action", inv?.actions.find((a) => a.kind === "ir.actions.server")?.detail === "code");
	check("module inventory lists ONLY the models whose modules contain the module", (inv?.models ?? []).map((m) => m.model).join() === "sale.order,sale.report", JSON.stringify(inv?.models));
	const summarized = canon.summarizeCanon(rModule.canon);
	check("summarizeCanon reports the module inventory", summarized.module?.menus === 3 && summarized.module.actions === 2 && summarized.module.models === 2);
	check("module canon fingerprints differently from the same canon without inventory", canon.canonFingerprint(rModule.canon) !== canon.canonFingerprint({ ...rModule.canon, module: undefined }));

	check("planStoryboard opens EVERY module menu with a read-only flow", moduleSb.flows.filter((f) => f.id.startsWith("m")).length === 3);
	check("a module menu flow is goto + screenshot, read-only, on the action it opens", (() => {
		const flow = moduleSb.flows.find((f) => f.title === "Sales/Orders/Quotations");
		return flow?.steps.map((s) => `${s.kind}:${s.safety}`).join() === "goto:read-only,screenshot:read-only" && flow.steps[0].target.xmlid === "sale.action_quotations";
	})());
	check("a menu with no action targets the menu itself", moduleSb.flows.find((f) => f.title === "Sales/Settings")?.steps[0].target.xmlid === "sale.menu_settings");
	check("a module canon with no form still plans its menus", model.planStoryboard({ ...rModule.canon, views: [] }, "x").flows.filter((f) => f.id.startsWith("m")).length === 3);
	const unknownTargets = model.validateStoryboard(moduleSb, rModule.canon).filter((f) => f.rule === "TARGET-UNKNOWN");
	check("module targets are KNOWN targets (no TARGET-UNKNOWN for a module menu/action)", unknownTargets.length === 0, JSON.stringify(unknownTargets));
	check("a fully planned module storyboard has no MODULE-COVERAGE ERROR", coverage(moduleSb).every((f) => f.severity !== "ERROR"), JSON.stringify(coverage(moduleSb)));

	const withoutSettings = { ...moduleSb, flows: moduleSb.flows.filter((f) => f.title !== "Sales/Settings") };
	check("a menu outside every flow is a MODULE-COVERAGE ERROR", coverage(withoutSettings).some((f) => f.severity === "ERROR" && f.message.includes("Sales/Settings")));
	const withoutReporting = { ...moduleSb, flows: moduleSb.flows.filter((f) => !f.steps.some((s) => s.target?.xmlid === "sale.xml_77")) };
	check("a menu whose flow is gone is an ERROR again", coverage(withoutReporting).some((f) => f.severity === "ERROR" && f.message.includes("Sales/Reporting")));
	const viaAction = {
		...moduleSb,
		flows: [
			...withoutReporting.flows,
			{
				id: "x1",
				title: "Reporting",
				steps: [
					{ id: "s01", kind: "goto", procedure: null, target: { kind: "action", xmlid: "sale.xml_77" }, safety: "read-only" },
					{ id: "s02", kind: "screenshot", procedure: null, safety: "read-only" },
				],
			},
		],
	};
	check("a menu is covered when a flow opens the action it points to", coverage(viaAction).every((f) => !(f.severity === "ERROR" && f.message.includes("Sales/Reporting"))));
	check("a non-navigable action nobody can open is a WARN, not an ERROR", coverage(withoutReporting).some((f) => f.severity === "WARN" && f.message.includes("ir.actions.server")), JSON.stringify(coverage(withoutReporting)));
	check("a per-model canon is unchanged: no inventory, no MODULE-COVERAGE", canon17?.module === undefined && model.validateStoryboard(model.planStoryboard(canon17, "quotations"), canon17).every((f) => f.rule !== "MODULE-COVERAGE"));
}

// ---------------------------------------------------------------------------
// 0.17.0 — the interview, field-by-field coverage and the group walk
// ---------------------------------------------------------------------------
const rIv = await canon.collectCanon(fakeClient(17, { module: "sale", connectedUser: "fhidalgo", connectedAdmin: true }), {
	model: "sale.order",
	serverVersion: "17.0",
	language: "es",
	module: "sale",
	moduleDir: modDir,
});
check("the interview canon succeeds", rIv.ok === true, rIv.ok ? "" : rIv.blocked);
if (rIv.ok) {
	const iv = rIv.canon.interview;
	check("the interview records the connected login and derives the administrator", iv?.connectedLogin === "fhidalgo" && iv.admin === true);
	check("an undeclared asUser comes from the connection (source=connected)", iv?.asUserSource === "connected" && (iv.asUser ?? "").includes("fhidalgo"));
	check("the walk groups are what the module declares, once each", JSON.stringify(iv?.groups) === JSON.stringify(["sales_team.group_sale_salesman"]), JSON.stringify(iv?.groups));
	check("the interview names the inventoried modules", (iv?.modules ?? []).join() === "sale");
	const doc = rIv.canon.modules?.[0]?.models.find((m) => m.model === "sale.order");
	check(
		"every field is read with its label, type and required flag",
		doc?.fields.some((f) => f.name === "partner_id" && f.string === "Customer" && f.type === "many2one" && f.required === true),
		JSON.stringify(doc?.fields),
	);
	check("a field restricted to groups carries them by name", doc?.fields.some((f) => f.name === "partner_id" && Array.isArray(f.groups)));
	check("the model doc carries the form AND list buttons", (doc?.buttons ?? []).some((b) => b.name === "action_confirm"));
	check("the model doc carries the statusbar states", Array.isArray(doc?.statusbar?.visibleStates) && doc?.statusbar.visibleStates.length > 0);
	check("the model doc carries the access matrix by group", doc?.access.some((a) => a.group === "sales_team.group_sale_salesman" && a.read === true && a.unlink === false));
	const denied = rIv.canon.modules?.[0]?.models.find((m) => m.model === "sale.report");
	check("a model the server denies is marked unreadable, never invented", (denied?.unreadable ?? "").includes("AccessError") && denied.fields.length === 0);

	const ivSb = model.planStoryboard(rIv.canon, "sale-interview");
	check("plan copies the interview into the storyboard", (ivSb.interview?.asUser ?? "").includes("fhidalgo") && ivSb.interview?.admin === true && (ivSb.interview?.modules ?? []).join() === "sale");
	check("plan opens one flow per walk group, with the group as role", (() => {
		const g = ivSb.flows.find((f) => f.id.startsWith("g"));
		return ivSb.flows.filter((f) => f.kind === "group").length === 1 && g?.role === "sales_team.group_sale_salesman" && g.steps[0].kind === "goto" && g.steps.some((s) => s.kind === "screenshot");
	})());
	check("plan seeds the docs checklist with every field and button", (() => {
		const seeded = ivSb.docs?.models?.["sale.order"];
		return seeded !== undefined && "partner_id" in (seeded.fields ?? {}) && Object.values(seeded.fields).every((v) => v === "") && Object.values(seeded.buttons ?? {}).every((v) => v === "");
	})());
	const findings0 = model.validateStoryboard(ivSb, rIv.canon);
	check("a freshly planned module manual OWES the field prose (FIELD-COVERAGE ERROR)", findings0.some((f) => f.rule === "FIELD-COVERAGE" && f.severity === "ERROR"));
	check("... and the button and workflow prose", findings0.some((f) => f.rule === "BUTTON-COVERAGE" && f.severity === "ERROR") && findings0.some((f) => f.rule === "WORKFLOW-COVERAGE" && f.severity === "ERROR"));
	check("a denied model is a MODEL-UNREADABLE WARN, not a coverage failure", findings0.some((f) => f.rule === "MODEL-UNREADABLE" && f.severity === "WARN"));
	check("a group flow runs as a role lint cannot verify from a capture (ROLE-UNVERIFIED WARN)", findings0.some((f) => f.rule === "ROLE-UNVERIFIED" && f.severity === "WARN"));
	check("INTERVIEW-MISSING is an ERROR when the storyboard drops the interview", model.validateStoryboard({ ...ivSb, interview: undefined }, rIv.canon).some((f) => f.rule === "INTERVIEW-MISSING" && f.severity === "ERROR"));

	const filled = JSON.parse(JSON.stringify(ivSb));
	for (const entry of Object.values(filled.docs.models)) {
		for (const k of Object.keys(entry.fields ?? {})) entry.fields[k] = "Guarda el dato que la operación necesita.";
		for (const k of Object.keys(entry.buttons ?? {})) entry.buttons[k] = "Avanza el documento al siguiente estado.";
		entry.workflow = "Nace en borrador, se confirma y termina bloqueado o cancelado.";
	}
	const findings1 = model.validateStoryboard(filled, rIv.canon);
	check("with every field, button and workflow written the coverage is clean", findings1.every((f) => !["FIELD-COVERAGE", "BUTTON-COVERAGE", "WORKFLOW-COVERAGE"].includes(f.rule)), JSON.stringify(findings1));
	const noGroups = { ...filled, flows: filled.flows.filter((f) => f.kind !== "group") };
	check("a group nobody walks is a GROUP-COVERAGE ERROR", model.validateStoryboard(noGroups, rIv.canon).some((f) => f.rule === "GROUP-COVERAGE" && f.severity === "ERROR"));
	check("docs.groupsWhy downgrades it to a WARN (a documented limitation)", model.validateStoryboard({ ...noGroups, docs: { ...filled.docs, groupsWhy: "La instancia tiene una sola credencial." } }, rIv.canon).some((f) => f.rule === "GROUP-COVERAGE" && f.severity === "WARN"));
	const skipped = JSON.parse(JSON.stringify(filled));
	for (const entry of Object.values(skipped.docs.models)) {
		entry.skip = { ...(entry.skip ?? {}), partner_id: "Campo técnico que no se edita a mano." };
		delete entry.fields.partner_id;
	}
	check("a skip WITH a reason is documented coverage, not an error", model.validateStoryboard(skipped, rIv.canon).every((f) => !(f.rule === "FIELD-COVERAGE" && f.message.includes("partner_id"))));

	// plan MERGES: the storyteller's work survives a re-plan against the canon
	const narrated = JSON.parse(JSON.stringify(filled));
	narrated.language = "es_VE";
	narrated.flows[0].steps[0].procedure = "Abre el listado de presupuestos.";
	narrated.flows[0].captures = [{ stepId: "s02", file: "shots/s02.png" }];
	narrated.docs.models["sale.order"].workflow = "Mi flujo real, escrito a mano.";
	const replanned = model.planStoryboard(rIv.canon, "sale-interview");
	const mergeMod = await import(libUrl("manual-tool.js"));
	const merged = mergeMod.mergeStoryboards(narrated, replanned);
	check("plan merge keeps the narration by step id", merged.flows[0].steps[0].procedure === "Abre el listado de presupuestos.");
	check("plan merge keeps the captures", (merged.flows[0].captures ?? [])[0]?.file === "shots/s02.png");
	check("plan merge keeps the written workflow prose", merged.docs?.models?.["sale.order"]?.workflow === "Mi flujo real, escrito a mano.");
	check("plan merge keeps a step the canon no longer plans? no: structure comes from the canon", merged.flows.every((f) => f.steps.every((s) => s.kind !== "wait")));
	check("plan merge keeps the interview and the language", (merged.interview?.asUser ?? "").includes("fhidalgo"));

	// Render: the type is evidence (canon), the purpose is prose (storyboard)
	const md = render.renderManualMarkdown(merged, rIv.canon);
	check("the rendered manual has a field table with type AND purpose", md.includes("| Campo | Etiqueta | Tipo |") && md.includes("| partner_id | Customer |") && md.includes("Guarda el dato que la operación necesita."));
	check("the rendered manual has a button table", md.includes("| Botón | Etiqueta | Estados |") && md.includes("Avanza el documento al siguiente estado."));
	check("the rendered manual quotes the workflow the author wrote", md.includes("Mi flujo real, escrito a mano."));
	check("the rendered manual has a section per access group", md.includes("Por cada grupo de acceso") && md.includes("sales_team.group_sale_salesman"));
	check("the Act I declares the audience", md.includes("**Para quién**"));
}

// ---------------------------------------------------------------------------
// Fase 2 — prose lint (es/en positives and negatives)
// ---------------------------------------------------------------------------

const pEs = prose.lintProse("No solo acelera el trabajo, sino que transforma la operación completa del área comercial.", { language: "es" });
check("ai-negative-parallelism WARNs on empty contrast (es)", pEs.some((f) => f.rule === "ai-negative-parallelism"));
const pEsData = prose.lintProse("No solo guarda 3 pasos, sino que evita reescribir el Cliente.", { language: "es", canonLabels: ["Cliente"] });
check("ai-negative-parallelism passes when the sentence carries data or a canon label", !pEsData.some((f) => f.rule === "ai-negative-parallelism"));
check("ai-filler catches corporate filler (es and en)", prose.lintProse("Es importante destacar que it is important to note this.", { language: "es" }).filter((f) => f.rule === "ai-filler").length >= 1);
check("rhetorical-opening is flagged", prose.lintProse("¿Sabías que puedes confirmar pedidos?").some((f) => f.rule === "rhetorical-opening"));
const longSentence = "Este " + "palabra ".repeat(30) + "termina.";
check("sentence-length WARNs past 25 words", prose.lintProse(longSentence).some((f) => f.rule === "sentence-length"));
check("procedure-one-sentence is an ERROR (1 sentence / 1 image)", prose.lintProse("1. Abre el presupuesto. Luego pulsa Confirmar.").some((f) => f.rule === "procedure-one-sentence" && f.severity === "ERROR"));
check("heading-in-narrative is an ERROR", prose.lintProse("1. Abre el presupuesto.\n### Otra sección").some((f) => f.rule === "heading-in-narrative" && f.severity === "ERROR"));
check("label-not-in-canon WARNs on emphasized terms the canon lacks", prose.lintProse("Revisa el **Cliente fantasma** antes de seguir.", { canonLabels: ["Customer"] }).some((f) => f.rule === "label-not-in-canon"));
const simpleEs = Array.from({ length: 12 }, (_, i) => `El sistema usa el dato y da el valor. Vea la lista de la casa del paso ${i}.`).join("\n");
check("readability WARNs when the Spanish text is dumbified (Fernández-Huerta >= 70)", prose.lintProse(simpleEs, { language: "es" }).some((f) => f.rule === "readability"));
check("clean procedural prose produces no findings", prose.lintProse("1. Abre el presupuesto y pulsa Confirmar ![presupuesto confirmado](images/s04.png)").filter((f) => f.severity === "ERROR").length === 0);

// ---------------------------------------------------------------------------
// Fase 2 — render: deterministic artifacts, hash protection, docs-scan clean
// ---------------------------------------------------------------------------
const wsRender = mkdtempSync(join(tmpdir(), "manual-render-"));
if (canon17) {
	const sb = model.planStoryboard(canon17, "quotations");
	sb.language = "es";
	sb.flows[0].title = "Confirmar un presupuesto";
	sb.flows[0].recovery = "Si el botón falla, revisa las líneas: el mensaje del canon lista las causas.";
	for (const s of sb.flows[0].steps) s.procedure = `Paso ${s.id}: executa la acción en pantalla.`;
	mkdirSync(join(wsRender, "images"), { recursive: true });
	writeFileSync(join(wsRender, "images", "s01.png"), "png", { mode: 0o600 });
	sb.flows[0].captures = [{ stepId: "s01", file: "images/s01.png" }];
	const r1 = render.renderManual(wsRender, sb, canon17);
	check("render writes MANUAL.md and index.html into <workspace>/render", r1.written.join() === "MANUAL.md,index.html" && existsSync(join(wsRender, "render", "MANUAL.md")));
	// the capturer drops captures into the workspace; the renderer references
	// them relative to the output, so copy the capture next to the render
	mkdirSync(join(wsRender, "render", "images"), { recursive: true });
	copyFileSync(join(wsRender, "images", "s01.png"), join(wsRender, "render", "images", "s01.png"));
	const manual = readFileSync(join(wsRender, "render", "MANUAL.md"), "utf8");
	check("MANUAL.md starts at H2 (the OCA bot owns the H1)", manual.startsWith("## "));
	check("MANUAL.md leads each flow with its title and quotes the Process block", manual.includes("### Confirmar un presupuesto") && manual.includes("> "));
	check("MANUAL.md renders the ERD from the canon relations", manual.includes("`sale.order` → `res.partner`"));
	check("MANUAL.md steps carry 1 sentence + 1 image with alt", /1\. Paso s01[^\n]*\!\[step s01\]\(images\/s01\.png\)/.test(manual));
	const html = readFileSync(join(wsRender, "render", "index.html"), "utf8");
	check("index.html uses oe_container/oe_slogan and no script or inline style", html.includes("oe_container") && html.includes("oe_slogan") && !/<script/i.test(html) && !/style="/i.test(html));
	// scanDocs lints module readme/ fragments; for the render output apply the
	// SAME content rules by hand: no H1, every image exists, every alt set.
	const imgFindings = docsScan.fragmentImages(docsScan.outsideCodeFences(manual))
		.filter((img) => !/^(?:[a-z]+:|#|\/)/i.test(img.target))
		.filter((img) => !existsSync(join(wsRender, "render", img.target)) || !img.alt);
	check("render output passes the docs-scan image rules (target exists, alt set)", imgFindings.length === 0, JSON.stringify(imgFindings));
	const r2 = render.renderManual(wsRender, sb, canon17);
	check("render is deterministic (same hash, nothing skipped)", r2.skipped.length === 0 && r2.written.length === 2);
	const manualPath = join(wsRender, "render", "MANUAL.md");
	writeFileSync(manualPath, readFileSync(manualPath, "utf8") + "\nEdición humana.\n", { mode: 0o600 });
	const r3 = render.renderManual(wsRender, sb, canon17);
	check("a hand-edited artifact is NEVER overwritten without overwrite", r3.skipped.some((s) => s.file === "MANUAL.md") && readFileSync(manualPath, "utf8").includes("Edición humana."));
	const r4 = render.renderManual(wsRender, sb, canon17, { overwrite: true });
	check("overwrite=true renders in place and takes the file over", r4.written.includes("MANUAL.md") && existsSync(join(wsRender, "MANUAL.md")));
}

// ---------------------------------------------------------------------------
// Fase 2 — the skill bundle registers through the skills API
// ---------------------------------------------------------------------------
{
	const skills = [];
	lib.apply(
		{ tools: { register: () => {}, guard: () => () => {} }, skills: { register: (s) => skills.push(s) }, on: () => () => {} },
		{},
	);
	const manualSkill = skills.find((s) => s.name === "odoo-user-manual");
	check("the odoo-user-manual skill is registered with frontmatter metadata", manualSkill !== undefined && typeof manualSkill.description === "string" && manualSkill.description.length > 20);
}

// ---------------------------------------------------------------------------
// Fase 4 — the Playwright recording import and its credential gate
// ---------------------------------------------------------------------------
const importMod = await import(libUrl("manual-import.js"));
const toolMod = await import(libUrl("manual-tool.js"));
{
	const codegenTest = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://acme.example.com/web#action=sale.action_quotations');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Customer').fill('Acme Corp');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Quotation')).toBeVisible();
});`;
	const lib = `const { chromium } = require('playwright');
(async () => {
  const page = await browser.newPage();
  await page.goto('https://acme.example.com/web#model=sale.order');
  await page.locator('input[name="partner_id"]').fill('Globex');
  await page.getByRole('button', { name: 'Confirm' }).press('Enter');
  await page.getByLabel('Warehouse').selectOption('Central');
})();`;
	// The canon used for label mapping (one "Customer" field, one "Confirm" button).
	const miniCanon = {
		model: "sale.order",
		serverVersion: "17.0",
		major: 17,
		language: "en_US",
		modelModules: "sale",
		views: [
			{
				type: "form",
				arch: {
					buttons: [
						{ name: "action_confirm", string: "Confirm" },
						{ name: "action_cancel", string: "Cancel" },
					],
					fields: [
						{ name: "partner_id", string: "Customer", type: "many2one", required: true, modules: "sale" },
						{ name: "validity_date", string: "Expiration Date", type: "date", required: false, modules: "sale" },
					],
					pages: [{ string: "Order Lines" }],
					listColumns: [],
					filters: [],
				},
			},
		],
		fields: [
			{ name: "partner_id", string: "Customer", type: "many2one", required: true, modules: "sale" },
			{ name: "validity_date", string: "Expiration Date", type: "date", required: false, modules: "sale" },
		],
		groupsAttr: "groups_id",
		actions: [],
		menus: [],
		access: { access: [], rules: [] },
		errors: {},
	};

	const p1 = importMod.importRecording(codegenTest, miniCanon);
	check("import parses a @playwright/test codegen recording", p1.ok === true, p1.ok ? "" : p1.error);
	if (p1.ok) {
		check("import keeps document order and stable ids", p1.steps.map((s) => s.id).join() === "s01,s02,s03,s04,s05");
		check("import maps goto to a URL target", p1.steps[0].kind === "goto" && p1.steps[0].target?.kind === "url" && (p1.steps[0].target?.url ?? "").includes("sale.action_quotations"));
		check("import keeps an unmapped click (New) generic with a WARN", p1.steps[1].kind === "click" && p1.steps[1].field === undefined && p1.warnings.some((w) => w.rule === "import-unmapped-target"));
		check("import maps a canon button by its visible label", p1.steps[3].kind === "click" && p1.steps[3].field === "action_confirm");
		check("import maps a canon field by its label", p1.steps[2].kind === "fill" && p1.steps[2].field === "partner_id" && p1.steps[2].value === "Acme Corp");
		check("import never invents a procedure", p1.steps.every((s) => s.procedure === null));
		check("import marks action steps as actions", p1.steps[2].safety === "action");
		check("import turns expect().toBeVisible() into an assert", p1.steps[4].kind === "assert" && p1.steps[4].value === "Quotation");
		check("import keeps the raw locator as evidence", (p1.steps[2].note ?? "").includes("getByLabel"));
	}
	const p2 = importMod.importRecording(lib, miniCanon);
	check("import parses the library dialect (locator/getByLabel)", p2.ok === true, p2.ok ? "" : p2.error);
	if (p2.ok) {
		check("a css locator stays generic with a WARN", p2.warnings.some((w) => w.rule === "import-unmapped-field") && p2.steps.some((s) => s.kind === "fill" && s.field === undefined));
		check("press keeps its key", p2.steps.some((s) => s.kind === "press" && s.value === "Enter"));
		check("selectOption becomes a select step", p2.steps.some((s) => s.kind === "select" && s.value === "Central"));
	}
	const noCanon = importMod.importRecording(codegenTest);
	check("import without a canon stays generic (WARN, never a guess)", noCanon.ok === true && noCanon.warnings.length > 0);

	const secrets = [
		`await page.getByLabel('Password').fill('hunter2');`,
		`await page.locator('input[name="password"]').fill('hunter2');`,
		`await page.setExtraHTTPHeaders({ Authorization: 'Bearer abcdef' });`,
		`await context.addCookies([{ name: 'session_id', value: 'abc' }]);`,
	];
	for (const [i, rec] of secrets.entries()) {
		const bad = importMod.importRecording(rec, miniCanon);
		check(`import REJECTS a credential recording (case ${i + 1})`, bad.ok === false && /credential|cookies|Authorization/i.test(bad.error), bad.ok ? "accepted!" : bad.error.slice(0, 80));
		check(`import never echoes the secret value (case ${i + 1})`, !JSON.stringify(bad).includes("hunter2"));
	}
	const junk = importMod.importRecording("console.log('hello world');");
	check("import rejects something that is not a recording", junk.ok === false && /does not look like a Playwright recording/.test(junk.error));
	const huge = importMod.importRecording("x".repeat(1_000_001));
	check("import enforces the size limit", huge.ok === false && /limit is 1000000/.test(huge.error));

	// The operation itself: create-only flow, replace, symlink and existence refusals.
	const impWs = mkdtempSync(join(tmpdir(), "manual-import-"));
	const recFile = join(impWs, "recording.ts");
	writeFileSync(recFile, codegenTest, { mode: 0o600 });
	const secretPath = join(impWs, "secret.ts");
	writeFileSync(secretPath, `await page.getByLabel('Password').fill('hunter2');`, { mode: 0o600 });
	const fakeDeps = { display: (v) => v };
	const art = [];
	const noSb = toolMod.importRecordingOp(recFile, "Demo", false, impWs, "imp", art, fakeDeps, impWs);
	check("import BLOCKS without a storyboard (plan first)", noSb.ok === false && /storyboard/i.test(noSb.detail));
	model.writeStoryboard(impWs, { schema: "dsh-odoo-sdd/manual/1", slug: "imp", flows: [] });
	const imp1 = toolMod.importRecordingOp("recording.ts", "Demo", false, impWs, "imp", art, fakeDeps, impWs);
	check("import adds the flow with a fresh id", imp1.ok === true && JSON.parse(readFileSync(join(impWs, "storyboard.json"), "utf8")).flows[0].id === "f1", imp1.ok ? "" : imp1.detail);
	const imp2 = toolMod.importRecordingOp(recFile, "Demo", false, impWs, "imp", art, fakeDeps, impWs);
	check("import is create-only by title unless replace=true", imp2.ok === false && /replace=true/.test(imp2.detail));
	const imp3 = toolMod.importRecordingOp(recFile, "Demo", true, impWs, "imp", art, fakeDeps, impWs);
	check("replace=true takes the existing flow over", imp3.ok === true && JSON.parse(readFileSync(join(impWs, "storyboard.json"), "utf8")).flows.length === 1);
	const impMissing = toolMod.importRecordingOp(join(impWs, "nope.ts"), "Otro", false, impWs, "imp", art, fakeDeps, impWs);
	check("import BLOCKS on a missing recording", impMissing.ok === false && /does not exist/.test(impMissing.detail));
	const link = join(impWs, "link.ts");
	symlinkSync(recFile, link);
	const impLink = toolMod.importRecordingOp(link, "Link", false, impWs, "imp", art, fakeDeps, impWs);
	check("import REFUSES a symlinked recording", impLink.ok === false && /symlink/.test(impLink.detail));
	const impSecret = toolMod.importRecordingOp(secretPath, "Secreto", false, impWs, "imp", art, fakeDeps, impWs);
	check("the tool surfaces the credential rejection", impSecret.ok === false && /credential/i.test(impSecret.detail));
	rmSync(impWs, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fase 5 — the documentation verdict covers the manual WHEN ONE EXISTS
// ---------------------------------------------------------------------------
const auditMod = await import(libUrl("manual-audit.js"));
{
	const aProj = mkdtempSync(join(tmpdir(), "manual-audit-"));
	const aSpecs = join(aProj, "specs");
	const dir = join(aSpecs, "manuals", "audit-demo");
	mkdirSync(join(dir, "render"), { recursive: true });
	const sbAudit = {
		schema: "dsh-odoo-sdd/manual/1",
		slug: "audit-demo",
		canonFingerprint: "ffffffffffffffff",
		flows: [
			{
				id: "f1",
				title: "Confirm a quotation",
				steps: [
					{ id: "s01", kind: "goto", procedure: "Abre la cotización." },
					{ id: "s02", kind: "screenshot", procedure: "Revisa el formulario." },
					{ id: "s03", kind: "screenshot", procedure: null },
				],
				captures: [{ stepId: "s01", file: "images/x.png", sha256: "aa" }],
			},
		],
	};
	model.writeStoryboard(dir, sbAudit);
	check("findManualsFor (specs mode) finds the workspace", auditMod.findManualsFor({ mode: "specs", dir: "docs/manuals", projectRoot: aProj, specsBase: aSpecs }).length === 1);
	check("findManualsFor (docs mode) honours manualsDir", auditMod.findManualsFor({ mode: "docs", dir: "docs/manuals", projectRoot: aProj, specsBase: aSpecs }).length === 0);
	const a1 = auditMod.auditManual(dir, { projectRoot: aProj, language: "es" });
	check("auditManual counts flows, steps and actions", a1 !== null && a1.flows === 1 && a1.steps === 3 && a1.actions === 0);
	check("auditManual reports capture coverage as captured/screenshots", a1.captures === 0 && a1.screenshots === 2 && a1.missingCaptures === 2);
	check("a screenshot without an image is an ERROR", a1.findings.some((f) => f.rule === "docs-manual-missing-capture" && f.severity === "ERROR"));
	check("procedure=null is a WARN, never an ERROR", a1.findings.some((f) => f.rule === "docs-manual-unbound-procedure" && f.severity === "WARN"));
	check("auditManual stays silent about a canon it cannot check", a1.canonKnown === false && a1.canonStale === false);

	// A canon.json beside the storyboard makes staleness checkable.
	writeFileSync(join(dir, "canon.json"), JSON.stringify({ schema: "dsh-odoo-sdd/canon/1", fingerprint: "0000000000000000", fields: [{ string: "Customer" }], views: [{ arch: { buttons: [{ string: "Confirm" }] } }] }), { mode: 0o600 });
	const a2 = auditMod.auditManual(dir, { projectRoot: aProj, language: "esh" });
	check("a storyboard planned against another canon is STALE (ERROR)", a2.canonKnown === true && a2.canonStale === true && a2.findings.some((f) => f.rule === "docs-manual-canon-stale" && f.severity === "ERROR"));
	check("the audit READS the canon but never rewrites the storyboard", JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")).canonFingerprint === "ffffffffffffffff");

	// Rendered prose flows through the same lint, and only WARNs block nothing.
	writeFileSync(join(dir, "render", "MANUAL.md"), "1. Haz clic en **Confirm** para confirmar el pedido.\n\nIt is important to note that this is a seamless workflow.\n", { mode: 0o600 });
	const a3 = auditMod.auditManual(dir, { projectRoot: aProj, language: "en" });
	check("prose findings appear as manual findings", a3.proseWarnings >= 1 && a3.findings.some((f) => f.rule === "docs-manual-ai-filler"));
	check("a canon label in bold is not flagged as unknown", !a3.findings.some((f) => f.rule === "docs-manual-label-not-in-canon" && f.message.includes("Confirm")));

	const section = auditMod.renderManualSection([a3]);
	check("the report section names coverage, prose and freshness", section[0] === "## User manual" && /captures 0\/2/.test(section[1]) && /CANON STALE|fresh against its canon/.test(section[1]));
	check("renderManualSection is empty without a manual", auditMod.renderManualSection([]).length === 0);
	check("manual findings merge into the docs findings shape", auditMod.manualAuditFindings([a3]).every((f) => typeof f.rule === "string" && typeof f.hint === "string" && (f.severity === "ERROR" || f.severity === "WARN")));

	// Regression: with NO manual the docs tool behaves exactly as before.
	const modForDocs = mkdtempSync(join(tmpdir(), "manual-docs-"));
	mkdirSync(join(modForDocs, "readme"), { recursive: true });
	for (const frag of ["DESCRIPTION", "INSTALL", "CONFIGURE", "USAGE", "ROADMAP", "DEVELOP", "CONTRIBUTORS", "CHANGELOG"]) {
		writeFileSync(join(modForDocs, "readme", `${frag}.md`), `## ${frag}\n\nContenido real de ${frag}.\n`, { mode: 0o600 });
	}
	mkdirSync(join(modForDocs, "static", "description"), { recursive: true });
	writeFileSync(join(modForDocs, "static", "description", "index.html"), "<div class=\"oe_container\"><p>x</p></div>", { mode: 0o600 });
	writeFileSync(join(modForDocs, "__manifest__.py"), "{'name': 'Docs', 'version': '17.0.1.0.0', 'license': 'AGPL-3'}", { mode: 0o600 });
	const docsTool = registered.get("odoo_docs");
	const noManual = await docsTool.execute({ operation: "check", module_dir: modForDocs }, undefined);
	check("odoo_docs still runs with no manual anywhere", typeof noManual.detail === "string" && noManual.detail.includes("Documentation check"));
	check("no manual means NO User manual section and no manual finding", !noManual.detail.includes("## User manual") && !noManual.findings.some((f) => String(f.rule).startsWith("docs-manual-")));
	rmSync(modForDocs, { recursive: true, force: true });
	rmSync(aProj, { recursive: true, force: true });
}

rmSync(proj, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });
rmSync(wsRender, { recursive: true, force: true });
console.log(`\nmanual: ${passed} checks passed`);
