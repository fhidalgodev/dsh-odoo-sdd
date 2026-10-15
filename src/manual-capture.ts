/**
 * manual-capture.ts — Motor 3: annotated screenshots of a REAL Odoo session
 * driven by Playwright.
 *
 * Design rules (from the plan):
 *  - `playwright-core` is an OPTIONAL dependency, imported dynamically with
 *    minimal structural types — the plugin never hard-requires it.
 *  - The browser is launched `browser=auto` (bundled Chromium → system
 *    Chrome → Edge); without any, the answer is NEEDS_BROWSER, never a guess.
 *  - UI selectors are versioned (`UI_FAMILIES`): an unverified major is
 *    rejected instead of guessed.
 *  - Steps are classified by `stepSafety` (manual-model): action steps are
 *    REJECTED unless the caller passed `allow_actions: true` (the policy
 *    guard also classifies that call as mutating).
 *  - The navigation is origin-locked: any request that leaves the Odoo base
 *    URL is aborted.
 *  - The web session lives in memory (`webLogin`); the cookie is never
 *    returned to the model.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { stepSafety, type Flow, type Step } from "./manual-model.js";

/** The ONLY playwright-core line this plugin is tested against. */
export const PLAYWRIGHT_CORE_VERSION = "1.63.0";

/** Minimal structural types — no `any`, no full playwright type surface. */
interface PwPage {
	goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
	click(selector: string, options?: { timeout?: number }): Promise<void>;
	fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
	press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
	keyboard: { press(key: string): Promise<void> };
	evaluate<T>(fn: string | ((arg: unknown) => T), arg?: unknown): Promise<T>;
	waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	screenshot(options?: { path?: string; type?: string; fullPage?: boolean }): Promise<Buffer>;
	ariaSnapshot(options?: { scope?: string }): Promise<string>;
	on(event: string, handler: (info: { url: () => string }) => void): void;
	close(): Promise<void>;
}
interface PwRouteRequest {
	url(): string;
}
interface PwRoute {
	/**
	 * playwright-core exposes `request` as a property in the public API but
	 * older/newer builds hand back a method — the runtime compat helper below
	 * accepts both shapes.
	 */
	request: PwRouteRequest | (() => PwRouteRequest);
	abort(): Promise<void>;
	continue(): Promise<void>;
}
interface PwContext {
	newPage(options?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }): Promise<PwPage>;
	route(pattern: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
	close(): Promise<void>;
}
interface PwBrowser {
	newContext(options?: Record<string, unknown>): Promise<PwContext>;
	close(): Promise<void>;
}
interface PwChromium {
	launch(options?: { headless?: boolean; channel?: string; args?: string[] }): Promise<PwBrowser>;
}

/**
 * Read a value that some playwright-core builds expose as a plain property and
 * others as a method (the `route.request` compat case). A method is invoked
 * WITH its owner as `this`: playwright-core reads `this._initializer`, so an
 * unbound call throws "Cannot read properties of undefined".
 * @param value - the property, or the method returning it.
 * @param owner - the object the method belongs to.
 * @returns the resolved value.
 */
function readShaped<T>(value: T | (() => T), owner: unknown): T {
	if (typeof value !== "function") return value;
	return (value as () => T).call(owner);
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string; errorKind?: string };

/** Dynamic import of the optional dependency, with an actionable failure. */
export async function loadPlaywright(): Promise<RpcResult<{ chromium: PwChromium }>> {
	try {
		const pw = (await import("playwright-core")) as unknown as { chromium: PwChromium };
		if (!pw?.chromium) return { ok: false, error: `playwright-core ${PLAYWRIGHT_CORE_VERSION} is installed but exposes no chromium entry point.` };
		return { ok: true, value: pw };
	} catch {
		return {
			ok: false,
			errorKind: "needs_browser",
			error:
				`playwright-core ${PLAYWRIGHT_CORE_VERSION} is not installed. Install it with the plugin ` +
				"(`npm i -g dsh-odoo-sdd` pulls it as an optional dependency) and a browser " +
				"(`npx playwright-core install chromium`, or point the system Chrome/Edge channel).",
		};
	}
}

export type BrowserChoice = "auto" | "chromium" | "chrome" | "msedge";

/** browser=auto: bundled Chromium → system Chrome → system Edge; NEEDS_BROWSER otherwise. */
export async function resolveBrowser(chromium: PwChromium, choice: BrowserChoice, headed: boolean): Promise<RpcResult<PwBrowser>> {
	const attempts: Array<{ channel?: string; label: string }> =
		choice === "auto"
			? [{ label: "chromium" }, { channel: "chrome", label: "chrome" }, { channel: "msedge", label: "msedge" }]
			: choice === "chromium"
				? [{ label: "chromium" }]
				: [{ channel: choice, label: choice }];
	let last = "";
	for (const attempt of attempts) {
		try {
			const browser = await chromium.launch({ headless: !headed, ...(attempt.channel ? { channel: attempt.channel } : {}) });
			return { ok: true, value: browser };
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	return {
		ok: false,
		errorKind: "needs_browser",
		error:
			`NEEDS_BROWSER — no usable browser (${attempts.map((a) => a.label).join(" → ")}). Last error: ${last} ` +
			"Remedy: `npx playwright-core install chromium`, or install Google Chrome/Edge so the channel launch works.",
	};
}

/** One UI family per VERIFIED Odoo major; an unknown major is rejected. */
export interface UiFamily {
	selectors: {
		newRecord: string;
		headerButton: (name: string) => string;
		statusbar: string;
		field: (name: string) => string;
		notebookTab: (name: string) => string;
		menuXmlid: string;
		loading: string;
		modal: string;
		many2oneDropdown: string;
	};
	verified: string;
}
export const UI_FAMILIES: Record<number, UiFamily> = {
	17: {
		selectors: {
			newRecord: ".o-kanban-button-new, .o_list_button_add, .o_form_button_create",
			headerButton: (name) => `.o_statusbar_buttons button[name="${name}"], header button[name="${name}"]`,
			statusbar: ".o_form_statusbar",
			field: (name) => `[name="${name}"] input, [name="${name}"]`,
			notebookTab: (name) => `.nav-link[data-bs-target*="${name}"], .nav-link[name="${name}"]`,
			menuXmlid: `[data-menu-xmlid]`,
			loading: ".o_loader, .o_wait",
			modal: ".modal",
			many2oneDropdown: ".o_field_many2one input, .ui-autocomplete input",
		},
		verified: "E2E-tested against an Odoo 17 form (tests/capture.mjs) — the baseline family.",
	},
	16: {
		selectors: {
			newRecord: ".o-kanban-button-new, .o_list_button_add, .o_form_button_create",
			headerButton: (name) => `.o_statusbar_buttons button[name="${name}"], header button[name="${name}"]`,
			statusbar: ".o_form_statusbar",
			field: (name) => `[name="${name}"] input, [name="${name}"]`,
			notebookTab: (name) => `.nav-link[href*="${name}"], .nav-link[name="${name}"]`,
			menuXmlid: `[data-menu-xmlid]`,
			loading: ".o_loader, .o_wait",
			modal: ".modal",
			many2oneDropdown: ".o_field_many2one input, .ui-autocomplete input",
		},
		verified: "Same selectors as 17 (bootstrap 5 UI). Declared UNTESTED against a live 16 — verify on a dev instance before production captures.",
	},
	18: {
		selectors: {
			newRecord: ".o-kanban-button-new, .o_list_button_add, .o_form_button_create",
			headerButton: (name) => `.o_statusbar_buttons button[name="${name}"], header button[name="${name}"]`,
			statusbar: ".o_form_statusbar",
			field: (name) => `[name="${name}"] input, [name="${name}"]`,
			notebookTab: (name) => `.nav-link[name="${name}"]`,
			menuXmlid: `[data-menu-xmlid]`,
			loading: ".o_loader, .o_wait",
			modal: ".modal",
			many2oneDropdown: ".o_field_many2one input, .ui-autocomplete input",
		},
		verified: "Declared UNTESTED against a live 18 — verify on a dev instance before production captures.",
	},
	19: {
		selectors: {
			newRecord: ".o-kanban-button-new, .o_list_button_add, .o_form_button_create",
			headerButton: (name) => `.o_statusbar_buttons button[name="${name}"], header button[name="${name}"]`,
			statusbar: ".o_form_statusbar",
			field: (name) => `[name="${name}"] input, [name="${name}"]`,
			notebookTab: (name) => `[data-tab-id="${name}"], .nav-link[name="${name}"]`,
			menuXmlid: `[data-menu-xmlid]`,
			loading: ".o_loader, .o_wait",
			modal: ".modal",
			many2oneDropdown: ".o_field_many2one input, .ui-autocomplete input",
		},
		verified: "Declared UNTESTED against a live 19 — verify on a dev instance before production captures.",
	},
};

/** A major without a verified family is refused: no guessed selectors. */
export function familyFor(serverVersion: string): RpcResult<{ major: number; family: UiFamily }> {
	const match = serverVersion.match(/(\d+)\./);
	const major = match ? Number(match[1]) : NaN;
	const family = UI_FAMILIES[major];
	if (!family) {
		return {
			ok: false,
			error:
				`UI family for Odoo ${Number.isNaN(major) ? serverVersion : major} is not verified by this plugin ` +
				`(verified: ${Object.keys(UI_FAMILIES).join(", ")}). Capturing against an unverified family would guess selectors.`,
		};
	}
	return { ok: true, value: { major, family } };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function actionUrl(baseUrl: string, xmlid: string): string {
	return `${baseUrl.replace(/\/$/, "")}/web#action=${encodeURIComponent(xmlid)}`;
}
export function menuUrl(baseUrl: string, xmlid: string): string {
	return `${baseUrl.replace(/\/$/, "")}/web#menu_id=${encodeURIComponent(xmlid)}`;
}
export function recordUrl(baseUrl: string, model: string, id: number): string {
	return `${baseUrl.replace(/\/$/, "")}/web#id=${id}&model=${encodeURIComponent(model)}&view_type=form`;
}

/** PNG verification: signature + IHDR dimensions (what the reader gets). */
export function verifyPng(buf: Buffer, expectW?: number, expectH?: number): RpcResult<{ width: number; height: number }> {
	if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { ok: false, error: "the file is not a PNG" };
	}
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (expectW && width !== expectW) return { ok: false, error: `PNG width ${width} != expected ${expectW}` };
	if (expectH && height !== expectH) return { ok: false, error: `PNG height ${height} != expected ${expectH}` };
	return { ok: true, value: { width, height } };
}

// ---------------------------------------------------------------------------
// Session — in memory only
// ---------------------------------------------------------------------------

export interface CaptureSession {
	baseUrl: string;
	sessionId: string;
	uid: number;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface CaptureStepResult {
	id: string;
	kind: Step["kind"];
	status: "ok" | "error" | "skipped";
	error?: string;
	screenshot?: { file: string; width: number; height: number; bytes: number };
	aria?: string;
}

export interface CaptureReport {
	schema: "dsh-odoo-sdd/capture/1";
	slug: string;
	flow: string;
	startedAt: string;
	allowActions: boolean;
	browser: string;
	zoom: number;
	originLocked: true;
	steps: CaptureStepResult[];
	overlaysRemoved: boolean;
}

export interface CaptureOptions {
	session: CaptureSession;
	browser: PwBrowser;
	family: UiFamily;
	flow: Flow;
	/** resume from this step id (the storyboard step id, e.g. "s03") */
	fromStep?: string;
	allowActions: boolean;
	headed: boolean;
	zoom: number;
	/** workspace directory: captures land in <workspace>/images, report in <workspace>/capture.json */
	workspace: string;
	/** default viewport */
	viewport?: { width: number; height: number };
	/** abort signal from the host */
	signal?: AbortSignal;
}

const VIEWPORT = { width: 1440, height: 900 };

/**
 * Runs ONE flow and writes annotated PNGs + capture.json. Closes its context
 * in `finally`; the browser itself is owned by the caller. Action steps are
 * rejected up-front unless `allowActions` (the tool and the guard both check).
 */
export async function captureFlow(opts: CaptureOptions): Promise<RpcResult<CaptureReport>> {
	const { session, family } = opts;
	if (opts.zoom < 1 || opts.zoom > 2) return { ok: false, error: "zoom must be between 1 and 2" };
	const steps = opts.flow.steps;
	const startIdx = opts.fromStep ? steps.findIndex((s) => s.id === opts.fromStep) : 0;
	if (startIdx < 0) return { ok: false, error: `from_step ${String(opts.fromStep)} is not a step of flow ${opts.flow.id}` };
	if (!opts.allowActions && steps.slice(startIdx).some((s) => stepSafety(s.kind) === "action")) {
		return { ok: false, error: "the flow contains ACTION steps (fill/select/click/press/new) but allow_actions is not true — read-only captures cannot run them" };
	}

	const report: CaptureReport = {
		schema: "dsh-odoo-sdd/capture/1",
		slug: "",
		flow: opts.flow.id,
		startedAt: new Date().toISOString(),
		allowActions: opts.allowActions,
		browser: "",
		zoom: opts.zoom,
		originLocked: true,
		steps: [],
		overlaysRemoved: false,
	};

	let context: PwContext | null = null;
	try {
		context = await opts.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: opts.zoom });
		const baseUrl = session.baseUrl.replace(/\/$/, "");
		// ORIGIN LOCK: abort everything that leaves the Odoo base URL.
		await context.route("**/*", (route) => {
			// playwright-core changed `request` between method and getter across
			// versions — accept both shapes.
			const req = readShaped(route.request, route);
			const url = req.url();
			if (url.startsWith(baseUrl)) return route.continue();
			return route.abort();
		});
		const page = await context.newPage();
		const cookie = { name: "session_id", value: session.sessionId, url: baseUrl };
		const ctxWithCookies = context as unknown as { addCookies(cookies: unknown[]): Promise<void> };
		await ctxWithCookies.addCookies([cookie]);

		const imagesDir = join(opts.workspace, "images");
		mkdirSync(imagesDir, { recursive: true });

		for (const step of steps.slice(startIdx)) {
			if (opts.signal?.aborted) {
				report.steps.push({ id: step.id, kind: step.kind, status: "skipped", error: "aborted" });
				break;
			}
			const result = await runStep(page, step, family, { baseUrl, imagesDir, slug: opts.flow.id, zoom: opts.zoom });
			report.steps.push(result);
			if (result.status === "error") break;
		}
		// overlay hygiene: every data-dsh-step overlay must be gone after each screenshot
		report.overlaysRemoved = Boolean(await page.evaluate("document.querySelectorAll('[data-dsh-step]').length === 0"));
		await page.close();
		writeFileAtomic(join(opts.workspace, "capture.json"), JSON.stringify(report, null, 2) + "\n");
		return { ok: true, value: report };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		if (context) await context.close().catch(() => {});
	}
}

async function runStep(
	page: PwPage,
	step: Step,
	family: UiFamily,
	env: { baseUrl: string; imagesDir: string; slug: string; zoom: number },
): Promise<CaptureStepResult> {
	const base: CaptureStepResult = { id: step.id, kind: step.kind, status: "ok" };
	try {
		switch (step.kind) {
			case "goto": {
				const t = step.target;
				const url = !t
					? null
					: t.kind === "url"
						? new URL(t.url ?? "", env.baseUrl).toString()
						: t.kind === "action"
							? actionUrl(env.baseUrl, t.xmlid ?? "")
							: t.kind === "menu"
								? menuUrl(env.baseUrl, t.xmlid ?? "")
								: t.kind === "record"
									? recordUrl(env.baseUrl, t.model ?? "", t.recordId ?? 0)
									: null;
				if (!url) return { ...base, status: "error", error: `unsupported goto target` };
				// origin lock on explicit URLs too
				if (!url.startsWith(env.baseUrl)) return { ...base, status: "error", error: `origin lock: ${url} leaves ${env.baseUrl}` };
				await page.goto(url, { waitUntil: "load", timeout: 30_000 });
				await page.waitForSelector(family.selectors.loading, { state: "hidden", timeout: 15_000 }).catch(() => {});
				break;
			}
			case "menu": {
				await page.click(`${family.selectors.menuXmlid}[data-menu-xmlid="${step.target?.xmlid ?? ""}"]`, { timeout: 10_000 }).catch(async () => {
					// fall back to direct navigation when the menu is not rendered
					await page.goto(menuUrl(env.baseUrl, step.target?.xmlid ?? ""), { waitUntil: "load", timeout: 30_000 });
				});
				await page.waitForTimeout(500);
				break;
			}
			case "new": {
				await page.click(family.selectors.newRecord, { timeout: 10_000 });
				await page.waitForTimeout(500);
				break;
			}
			case "fill": {
				const sel = family.selectors.field(step.field ?? "");
				await page.click(sel, { timeout: 10_000 });
				await page.fill(sel, step.value ?? "", { timeout: 10_000 });
				break;
			}
			case "select": {
				const sel = family.selectors.field(step.field ?? "");
				await page.click(sel, { timeout: 10_000 });
				await page.fill(sel, step.value ?? "", { timeout: 10_000 });
				await page.keyboard.press("Enter");
				await page.waitForSelector(family.selectors.many2oneDropdown, { state: "hidden", timeout: 10_000 }).catch(() => {});
				break;
			}
			case "press": {
				await page.press("body", step.value ?? "Enter", { timeout: 10_000 });
				break;
			}
			case "click": {
				await page.click(family.selectors.headerButton(step.field ?? step.target?.xmlid ?? ""), { timeout: 15_000 });
				await page.waitForSelector(family.selectors.loading, { state: "hidden", timeout: 20_000 }).catch(() => {});
				break;
			}
			case "drag": {
				// drags stay PLANNED: capture never automates them (fragile across
				// Odoo versions); the step documents the move for the storyteller.
				return { ...base, status: "error", error: "drag steps are planned, not captured: narrate the drag and screenshot its result" };
			}
			case "confirm": {
				await page.click(`${family.selectors.modal} .btn-primary`, { timeout: 10_000 });
				await page.waitForSelector(family.selectors.modal, { state: "hidden", timeout: 20_000 }).catch(() => {});
				break;
			}
			case "wait": {
				await page.waitForTimeout(Number(step.value ?? 500));
				break;
			}
			case "assert": {
				await page.waitForSelector(`text=${step.value ?? ""}`, { state: "visible", timeout: 15_000 });
				break;
			}
			case "explore": {
				const aria = await page.ariaSnapshot({ scope: ".o_action_manager" }).catch(() => page.ariaSnapshot());
				return { ...base, aria: aria.slice(0, 8000) };
			}
			case "screenshot": {
				// annotate → shoot → strip. The overlay is the ONLY annotation
				// added to the page, and it never survives the step.
				const file = join("images", `${env.slug}-${step.id}.png`);
				// The page context owns `document` and this plugin compiles without
				// the DOM lib: build the annotator with new Function (its body is
				// never typechecked) and use plain EXPRESSION strings for the rest —
				// a string that looks like an arrow is evaluated as an expression,
				// so "() => x" silently returns the function, not x.
				const annotate = new Function(
					"label",
					"const d = document.createElement('div'); d.setAttribute('data-dsh-step', label || ''); " +
						"d.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;background:rgba(21,32,43,.85);color:#fff;padding:6px 10px;border-radius:6px;font:14px sans-serif;pointer-events:none'; " +
						"d.textContent = label || ''; document.body.appendChild(d);",
				) as unknown as (l: unknown) => void;
				await page.evaluate(annotate, step.procedure ?? step.id);
				const buf = await page.screenshot({ type: "png" });
				await page.evaluate("document.querySelectorAll('[data-dsh-step]').forEach((n) => n.remove())");
				const dims = verifyPng(buf, VIEWPORT.width, VIEWPORT.height);
				if (!dims.ok) return { ...base, status: "error", error: `screenshot invalid: ${dims.error}` };
				const abs = join(env.imagesDir, `${env.slug}-${step.id}.png`);
				writeFileSync(abs, buf, { mode: 0o600 });
				return { ...base, screenshot: { file, width: dims.value.width, height: dims.value.height, bytes: buf.length } };
			}
			default:
				return { ...base, status: "error", error: `step kind ${step.kind} is not implemented` };
		}
		return base;
	} catch (e) {
		return { ...base, status: "error", error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------------------------------------------------------------------------
// explore — read-only look at one screen
// ---------------------------------------------------------------------------

export interface ExploreOptions {
	session: CaptureSession;
	browser: PwBrowser;
	family: UiFamily;
	headed: boolean;
	zoom: number;
	target: Step["target"];
	signal?: AbortSignal;
}

/** Explore ONE screen read-only: navigate + aria snapshot of the action manager. */
export async function exploreScreen(opts: ExploreOptions): Promise<RpcResult<{ aria: string }>> {
	let context: PwContext | null = null;
	try {
		context = await opts.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: opts.zoom });
		const baseUrl = opts.session.baseUrl.replace(/\/$/, "");
		await context.route("**/*", (route) => {
			const req = readShaped(route.request, route);
			const url = req.url();
			return url.startsWith(baseUrl) ? route.continue() : route.abort();
		});
		const page = await context.newPage();
		const ctxWithCookies = context as unknown as { addCookies(cookies: unknown[]): Promise<void> };
		await ctxWithCookies.addCookies([{ name: "session_id", value: opts.session.sessionId, url: baseUrl }]);
		const nav: Step = { id: "explore", kind: "goto", target: opts.target, procedure: null };
		const res = await runStep(page, nav, opts.family, { baseUrl, imagesDir: "", slug: "explore", zoom: opts.zoom });
		if (res.status === "error") return { ok: false, error: res.error ?? "navigation failed" };
		const exp: Step = { id: "explore-aria", kind: "explore", procedure: null };
		const aria = await runStep(page, exp, opts.family, { baseUrl, imagesDir: "", slug: "explore", zoom: opts.zoom });
		return { ok: true, value: { aria: aria.aria ?? "" } };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		if (context) await context.close().catch(() => {});
	}
}
