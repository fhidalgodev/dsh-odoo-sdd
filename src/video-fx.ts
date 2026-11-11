/**
 * video-fx.ts — the recording overlay (cursor, click wave, focus ring).
 *
 * Injected with `context.addInitScript` ONLY when a video capture is running
 * (`opts.video`); manual captures never see it. The script is a string on
 * purpose: this plugin compiles without the DOM lib, so the browser side is
 * plain JS text evaluated by Playwright inside the page.
 *
 * Everything lives in ONE host div appended to documentElement (not body —
 * Odoo replaces document.body while booting and the host would die with it),
 * rendered through a Shadow DOM so the app CSS can neither hide it nor restyle
 * it. pointer-events: none keeps every click real. The host survives
 * navigations by being re-created from a persistent listener: init scripts
 * re-run on every document, and each run builds its own host.
 *
 * window.__sddFx is the handle the runner drives:
 *   ring(rect, label?)  — dim the screen around rect + draw a pulsing ring
 *   clearRing()         — remove the ring and the dim
 *   hide() / show()     — around screenshots (never captured in a PNG)
 */
export const FX_INIT_SCRIPT = String.raw`
(() => {
	"use strict";
	if (window.__sddFx) return;
	const CSS = [
		":host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }",
		".cursor { position: fixed; width: 22px; height: 22px; margin: -2px 0 0 -2px;",
		"	transition: left 90ms linear, top 90ms linear; filter: drop-shadow(0 1px 2px rgba(0,0,0,.55)); }",
		".wave { position: fixed; width: 12px; height: 12px; margin: -6px 0 0 -6px;",
		"	border-radius: 50%; border: 3px solid rgba(56,132,255,.95);",
		"	animation: sdd-wave .55s ease-out forwards; }",
		".ring { position: fixed; border: 3px solid #ffd43b; border-radius: 8px;",
		"	box-shadow: 0 0 0 9999px rgba(0,0,0,.45), 0 0 14px rgba(255,212,59,.8);",
		"	animation: sdd-pulse 1.1s ease-in-out infinite; }",
		".tag { position: fixed; left: 0; top: 100%; margin-top: 8px; padding: 3px 10px;",
		"	background: #ffd43b; color: #1a1a1a; font: 600 15px/1.4 system-ui, sans-serif;",
		"	border-radius: 6px; white-space: nowrap; }",
		"@keyframes sdd-wave { from { transform: scale(1); opacity: .95; } to { transform: scale(4.5); opacity: 0; } }",
		"@keyframes sdd-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.035); } }",
	].join("\n");
	let hostEl = null;
	function mount() {
		if (!hostEl || hostEl.isConnected) return;
		const root = document.documentElement;
		// document_start runs before the parser creates <html>: appending the
		// host to document there makes the OVERLAY the document root and the
		// page is never parsed. Mount as soon as the parser gives us a root.
		if (!root) return;
		root.appendChild(hostEl);
	}
	function host() {
		if (hostEl) return hostEl;
		const existing = document.getElementById("__sddFxHost");
		if (existing) {
			hostEl = existing;
			return hostEl;
		}
		hostEl = document.createElement("div");
		hostEl.id = "__sddFxHost";
		hostEl.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = CSS;
		hostEl.shadowRoot.appendChild(style);
		const layer = document.createElement("div");
		hostEl.shadowRoot.appendChild(layer);
		mount();
		if (!hostEl.isConnected) {
			const obs = new MutationObserver(() => {
				mount();
				if (hostEl?.isConnected) obs.disconnect();
			});
			obs.observe(document, { childList: true, subtree: true });
		}
		return hostEl;
	}
	const layer = () => host().shadowRoot.lastElementChild;
	const cursor = () => {
		let c = layer().querySelector(".cursor");
		if (!c) {
			c = document.createElement("div");
			c.className = "cursor";
			c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L20 12 L13 13.5 L17 21 L14 22.5 L10 15 L4 19 Z" fill="#fff" stroke="#111" stroke-width="1.4"/></svg>';
			layer().appendChild(c);
			const saved = sessionStorage.getItem("__sddFxPos");
			const p = saved ? JSON.parse(saved) : { x: innerWidth / 2, y: innerHeight / 2 };
			c.style.left = p.x + "px"; c.style.top = p.y + "px";
		}
		return c;
	};
	addEventListener("mousemove", (e) => {
		const c = cursor();
		c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px";
		sessionStorage.setItem("__sddFxPos", JSON.stringify({ x: e.clientX, y: e.clientY }));
	}, true);
	addEventListener("mousedown", (e) => {
		const w = document.createElement("div");
		w.className = "wave";
		w.style.left = e.clientX + "px"; w.style.top = e.clientY + "px";
		layer().appendChild(w);
		setTimeout(() => w.remove(), 650);
	}, true);
	let ringEl = null;
	window.__sddFx = {
		ring(rect, label) {
			this.clearRing();
			ringEl = document.createElement("div");
			ringEl.className = "ring";
			const pad = 8;
			ringEl.style.left = (rect.x - pad) + "px";
			ringEl.style.top = (rect.y - pad) + "px";
			ringEl.style.width = (rect.w + 2 * pad) + "px";
			ringEl.style.height = (rect.h + 2 * pad) + "px";
			if (label) {
				const t = document.createElement("span");
				t.className = "tag"; t.textContent = label;
				ringEl.appendChild(t);
			}
			layer().appendChild(ringEl);
		},
		clearRing() { if (ringEl) { ringEl.remove(); ringEl = null; } },
		hide() { host().style.display = "none"; },
		show() { host().style.display = ""; },
	};
	cursor();
})();
`;
