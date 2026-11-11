/**
 * ui-probe.ts — the UI error probe behind `odoo_ui_verify`.
 *
 * The capture engine photographs what a real browser shows, but nothing in it
 * ever asked whether the screen was reporting an error: a traceback dialog or
 * a red toast was captured as `status: "ok"`. This probe closes that gap by
 * accumulating findings from the page's own signals (uncaught exceptions,
 * error-level console lines, failed/erroring responses) and from a DOM scan
 * the runner performs after every step (error dialog, danger notification,
 * invalid field).
 *
 * Rules:
 *  - `drain()` returns the findings since the last drain PLUS the current DOM
 *    state, deduplicated by (kind, message, url) so a persistent dialog is
 *    reported once, not on every step.
 *  - Findings matching a caller `ignore` pattern are dropped but COUNTED
 *    (`ignoredCount()`): a silenced error is a decision the report records.
 *  - Messages are capped and passed through the project's secret scrubber —
 *    a finding quotes a title or first line, never a whole traceback.
 */
import { scrubGeneric } from "./credentials.js";
import type { PwPage, UiFamily } from "./manual-capture.js";

export type UiFindingKind =
	| "js-error"
	| "console-error"
	| "http-5xx"
	| "rpc-error"
	| "request-failed"
	| "error-dialog"
	| "danger-notification"
	| "invalid-field";

export interface UiFinding {
	kind: UiFindingKind;
	/** Capped at 300 chars and secret-scrubbed. */
	message: string;
	url?: string;
}

export interface UiProbe {
	/** Findings since the last drain, plus the current DOM scan. */
	drain(): Promise<UiFinding[]>;
	/** Findings a caller `ignore` pattern silenced so far. */
	ignoredCount(): number;
	/** Drop the buffered findings; the page owns its listeners. */
	dispose(): void;
}

/** JSON-RPC endpoints whose 200 answers can still carry an `error` member. */
const RPC_PATHS = /^\/web\/(dataset\/call_kw|dataset\/call_button|action\/load|webclient\/)/;

/** Console noise that is never a finding: optional resources and the bus. */
const CONSOLE_NOISE = /favicon|\.(png|jpe?g|gif|ico|svg|woff2?|ttf|map)(\?|$)|websocket|longpolling|\/bus\//i;
const CONSOLE_NOISE_TEXT = /download the react devtools|deprecat/i;

/** Loose page surface for the listener events (PwPage.on is capture-scoped). */
interface ProbeListeners {
	on(event: "pageerror", handler: (error: Error) => void): void;
	on(
		event: "console",
		handler: (msg: { type(): string; text(): string; location(): { url: string; lineNumber: number; columnNumber: number } }) => void,
	): void;
	on(event: "response", handler: (res: { url(): string; status(): number; json(): Promise<unknown> }) => void): void;
	on(event: "requestfailed", handler: (req: { url(): string; failure(): { errorText: string } | null }) => void): void;
	evaluate<T>(fn: string | ((arg: unknown) => T), arg?: unknown): Promise<T>;
}

const cap = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Attach the probe to a page. `baseUrl` scopes the request checks (the origin
 * lock aborts every off-origin request, so those failures are expected and
 * skipped). `ignore` silences findings the QA declared — dropped but counted.
 */
export function attachProbe(
	page: PwPage,
	family: UiFamily,
	opts: { baseUrl: string; ignore?: RegExp[]; redact?: (text: string) => string },
): UiProbe {
	const listeners = page as unknown as ProbeListeners;
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const ignore = opts.ignore ?? [];
	const redact = opts.redact ?? ((text: string) => scrubGeneric(text));
	let buffer: UiFinding[] = [];
	let ignored = 0;
	const seen = new Set<string>();

	const push = (kind: UiFindingKind, message: string, url?: string): void => {
		const clean = redact(cap(message));
		if (clean === "") return;
		if (ignore.some((re) => re.test(clean) || (url !== undefined && re.test(url)))) {
			ignored += 1;
			return;
		}
		const key = `${kind}${clean}${url ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		buffer.push({ kind, message: clean, ...(url === undefined ? {} : { url }) });
	};

	/**
	 * DOM findings dedupe against the CURRENT screen, not against history: a
	 * dialog that stays open reports once, but the SAME dialog re-opened by a
	 * later step is a new finding and must be seen.
	 */
	const domSeen = new Set<string>();
	const pushDom = (kind: UiFindingKind, message: string): void => {
		const clean = redact(cap(message));
		if (clean === "") return;
		if (ignore.some((re) => re.test(clean))) {
			ignored += 1;
			return;
		}
		const key = `${kind}${clean}`;
		if (domSeen.has(key)) return;
		domSeen.add(key);
		buffer.push({ kind, message: clean });
	};

	listeners.on("pageerror", (error) => {
		push("js-error", error?.message ?? String(error));
	});
	listeners.on("console", (msg) => {
		try {
			if (msg.type() !== "error") return;
			const loc = msg.location()?.url ?? "";
			if (CONSOLE_NOISE.test(loc) || CONSOLE_NOISE_TEXT.test(msg.text())) return;
			push("console-error", msg.text(), loc.startsWith(baseUrl) ? loc : undefined);
		} catch {
			// a console event must never take the runner down
		}
	});
	listeners.on("response", (res) => {
		void (async () => {
			try {
				const url = res.url();
				if (!url.startsWith(baseUrl)) return;
				const status = res.status();
				const path = url.slice(baseUrl.length).split(/[?#]/)[0] ?? "";
				// An RPC endpoint answers 200 with {error:…} for business failures:
				// read the body best-effort and report the error member when present.
				if (RPC_PATHS.test(path)) {
					let body: unknown = null;
					try {
						body = await res.json();
					} catch {
						body = null;
					}
					const rpcError = (body as { error?: { message?: string; data?: { message?: string; name?: string }; code?: unknown } } | null)?.error;
					if (rpcError !== undefined && rpcError !== null) {
						const text = rpcError.data?.message ?? rpcError.message ?? `code ${String(rpcError.code ?? "?")}`;
						push("rpc-error", `${path}: ${text}`, url);
						return;
					}
				}
				if (status >= 500) push("http-5xx", `HTTP ${status} ${path || url}`, url);
			} catch {
				// response listeners must never take the runner down
			}
		})();
	});
	listeners.on("requestfailed", (req) => {
		try {
			const url = req.url();
			// The origin lock aborts every off-origin request BY DESIGN — those
			// failures are the lock working, not the page failing.
			if (!url.startsWith(baseUrl)) return;
			const errorText = req.failure()?.errorText ?? "";
			if (errorText === "net::ERR_ABORTED") return;
			push("request-failed", `${errorText || "request failed"} ${url.slice(baseUrl.length) || url}`, url);
		} catch {
			// request listeners must never take the runner down
		}
	});

	const domScan = async (): Promise<UiFinding[]> => {
		// The page owns `document`; the selectors come from the verified family.
		const raw = await listeners.evaluate(
			`(() => {
				const out = [];
				const capT = (t) => (t || "").replace(/\\s+/g, " ").trim();
				const dlg = document.querySelector(${JSON.stringify(family.selectors.errorDialog)});
				if (dlg) {
					const title = capT(dlg.querySelector(".modal-title")?.textContent);
					const alert = [...dlg.querySelectorAll(".alert,[role=alert]")].find((a) => !a.classList.contains("o_error_detail"));
					const body = capT(alert?.textContent ?? dlg.textContent).slice(0, 200);
					out.push({ kind: "error-dialog", message: (title ? title + " — " : "") + body });
				}
				for (const n of document.querySelectorAll(${JSON.stringify(family.selectors.dangerNotification)})) {
					const t = capT((n.querySelector(".o_notification_title")?.textContent ?? "") + " " + (n.querySelector(".o_notification_content")?.textContent ?? n.textContent));
					out.push({ kind: "danger-notification", message: t.slice(0, 200) });
					if (out.length > 12) break;
				}
				for (const f of document.querySelectorAll(${JSON.stringify(family.selectors.invalidField)})) {
					const name = f.getAttribute("name") ?? f.querySelector("[name]")?.getAttribute("name") ?? capT(f.querySelector("label")?.textContent);
					out.push({ kind: "invalid-field", message: "invalid field: " + (name || "(unnamed)") });
					if (out.length > 16) break;
				}
				return out;
			})()`,
		).catch(() => [] as Array<{ kind: string; message: string }>);
		return (raw as Array<{ kind: string; message: string }>).map((f) => ({ kind: f.kind as UiFindingKind, message: f.message }));
	};

	return {
		async drain(): Promise<UiFinding[]> {
			// Let queued async response handlers land, then merge events + DOM.
			await new Promise((r) => setTimeout(r, 0));
			const domFindings = await domScan();
			const nowDom = new Set(domFindings.map((f) => `${f.kind}${redact(cap(f.message))}`));
			for (const key of [...domSeen]) if (!nowDom.has(key)) domSeen.delete(key);
			for (const f of domFindings) pushDom(f.kind, f.message);
			const out = buffer;
			buffer = [];
			return out;
		},
		ignoredCount(): number {
			return ignored;
		},
		dispose(): void {
			buffer = [];
		},
	};
}
