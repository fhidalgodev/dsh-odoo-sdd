/**
 * video-layout.ts — the tutorial layout of an odoo_video, as ffmpeg filter
 * graphs (1920x1080, 25 fps).
 *
 *   title  — logo, eyebrow, "Tutorial NN", the title in the primary color,
 *            the summary and an accent rule, revealed one after another;
 *   step   — the recorded screen scaled into a browser frame on the theme
 *            canvas, "Step N" + chapter heading above, the acted-on element
 *            boxed in the primary color and a short pill naming the action;
 *   slide  — a row of cards or a checklist, revealed item by item;
 *   outro  — the closing line and "Next: Tutorial NN · …".
 *
 * Pure functions: every text goes through a text FILE (`ctx.textFile`) so no
 * user string is ever interpolated into the filter syntax, and colors are
 * validated `#RRGGBB` values (video-theme.ts) before they reach this module.
 */

import type { VideoSlide } from "./manual-model.js";
import { ffColor, onColor, type ResolvedTheme } from "./video-theme.js";

export const FRAME = { w: 1920, h: 1080, fps: 25 };
/** The recorded 1440x900 viewport, scaled into the browser frame. */
export const SHOT = { x: 296, y: 214, w: 1328, h: 830 };
const SOURCE = { w: 1440, h: 900 };
const BAR_H = 34;
const MARGIN_X = 160;

/** Step kinds whose element stays on screen after the action (box held). */
const HELD_BOX_KINDS = new Set(["fill", "select", "highlight"]);

export interface LayoutSegment {
	kind: "title" | "step" | "slide" | "outro";
	stepKind?: string;
	/** Element the step acted on, CSS px of the 1440x900 viewport. */
	focus?: { x: number; y: number; w: number; h: number };
	/** step: "Step N" (null = before the first chapter) + heading. */
	chapter?: { number: number | null; heading: string };
	/** step: the pill text, or null for no pill. */
	pill?: string | null;
	/** outro: the closing line. */
	text?: string | null;
	slide?: VideoSlide;
}

export interface LayoutContext {
	theme: ResolvedTheme;
	font: string;
	bold: string;
	/** Font with the ✓ glyph; null falls back to a bullet. */
	check: string | null;
	/** Absolute logo path, or null. */
	logo: string | null;
	words: { step: string; tutorial: string; next: string };
	title: string;
	number: number;
	eyebrow?: string;
	summary?: string;
	/** "Tutorial NN · Title" of the next video, for the outro. */
	nextTitle?: string;
	/** Writes `content` to a fresh temp file and returns its path. */
	textFile(content: string): string;
}

export interface SegmentGraph {
	/** The filter_complex; its output pad is [out]. */
	graph: string;
	/** Input 0 is the raw recording cut (step segments only). */
	usesRaw: boolean;
}

/** Quote a filesystem path for a filter option (drawtext fontfile/textfile). */
export const fq = (p: string): string => `'${p.replace(/([:'\\])/g, "\\$1")}'`;

/** Greedy word wrap to `max` characters per line, at most `maxLines` (… when cut). */
export function wrapText(text: string, max: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		if (cur !== "" && `${cur} ${word}`.length > max) {
			lines.push(cur);
			cur = word;
		} else {
			cur = cur === "" ? word : `${cur} ${word}`;
		}
	}
	if (cur !== "") lines.push(cur);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	const last = kept[maxLines - 1] as string;
	kept[maxLines - 1] = `${last.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
	return kept;
}

/** A fade-in starting at `start` seconds, as a drawtext alpha expression. */
const fadeIn = (start: number, length = 0.4): string => `'min(1,max(0,(t-${start.toFixed(2)})/${length.toFixed(2)}))'`;

interface TextSpec {
	text: string;
	font: string;
	size: number;
	color: string;
	x: number | string;
	y: number | string;
	lineSpacing?: number;
	alpha?: string;
	box?: { color: string; border: number };
}

function drawText(ctx: LayoutContext, spec: TextSpec): string {
	const file = ctx.textFile(spec.text);
	return (
		`drawtext=fontfile=${fq(spec.font)}:textfile=${fq(file)}:fontsize=${spec.size}:fontcolor=${spec.color}` +
		`:x=${spec.x}:y=${spec.y}` +
		(spec.lineSpacing !== undefined ? `:line_spacing=${spec.lineSpacing}` : "") +
		(spec.box ? `:box=1:boxcolor=${spec.box.color}:boxborderw=${spec.box.border}` : "") +
		(spec.alpha ? `:alpha=${spec.alpha}` : "")
	);
}

function drawBox(x: number, y: number, w: number, h: number, color: string, thickness: number | "fill", enable?: string): string {
	return (
		`drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:color=${color}:t=${thickness}` +
		(enable ? `:enable='${enable}'` : "")
	);
}

/** A soft drop shadow under a w×h rect at (x, y): three translucent layers. */
function shadow(x: number, y: number, w: number, h: number): string[] {
	return [
		drawBox(x - 14, y - 6, w + 28, h + 30, "black@0.03", "fill"),
		drawBox(x - 8, y - 3, w + 16, h + 18, "black@0.04", "fill"),
		drawBox(x - 3, y, w + 6, h + 8, "black@0.06", "fill"),
	];
}

/** The canvas: theme background for `seconds`. */
const canvas = (theme: ResolvedTheme, seconds: number): string =>
	`color=c=${ffColor(theme.background)}:s=${FRAME.w}x${FRAME.h}:r=${FRAME.fps}:d=${seconds.toFixed(3)}`;

/** Overlay the logo (scaled to `height`) at x/y, closing the chain at [out]. */
function withLogo(ctx: LayoutContext, chain: string, logoIndex: number, height: number, x: string, y: number): string {
	if (!ctx.logo) return `${chain}[out]`;
	return `${chain}[base];[${logoIndex}:v]scale=-1:${height}[logo];[base][logo]overlay=x=${x}:y=${y}[out]`;
}

function titleGraph(ctx: LayoutContext, seconds: number): SegmentGraph {
	const t = ctx.theme;
	const parts: string[] = [canvas(t, seconds)];
	let y = 380;
	if (ctx.eyebrow && ctx.eyebrow.trim() !== "") {
		parts.push(drawText(ctx, { text: ctx.eyebrow.trim(), font: ctx.bold, size: 30, color: ffColor(t.primary), x: MARGIN_X, y, alpha: fadeIn(0.15) }));
	}
	y += 50;
	parts.push(drawText(ctx, { text: `${ctx.words.tutorial} ${String(ctx.number).padStart(2, "0")}`, font: ctx.bold, size: 84, color: ffColor(t.text), x: MARGIN_X, y, alpha: fadeIn(0.3) }));
	y += 104;
	const titleLines = wrapText(ctx.title, 30, 2);
	parts.push(drawText(ctx, { text: titleLines.join("\n"), font: ctx.bold, size: 84, color: ffColor(t.primary), x: MARGIN_X, y, lineSpacing: 14, alpha: fadeIn(0.5) }));
	y += titleLines.length * 98 + 36;
	const summary = (ctx.summary ?? "").trim();
	if (summary !== "") {
		const lines = wrapText(summary, 70, 2);
		parts.push(drawText(ctx, { text: lines.join("\n"), font: ctx.font, size: 36, color: ffColor(t.text, 0.72), x: MARGIN_X, y, lineSpacing: 12, alpha: fadeIn(0.8) }));
		y += lines.length * 48 + 36;
	}
	parts.push(drawBox(MARGIN_X, y, 180, 6, ffColor(t.primary), "fill", "gte(t,1)"));
	return { graph: withLogo(ctx, parts.join(","), 0, 110, String(MARGIN_X), 200), usesRaw: false };
}

/** Map a viewport rect into the framed screen, padded and clamped to it. */
export function boxOnScreen(focus: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
	const s = SHOT.w / SOURCE.w;
	const pad = 7;
	const x0 = Math.max(SHOT.x, SHOT.x + focus.x * s - pad);
	const y0 = Math.max(SHOT.y, SHOT.y + focus.y * s - pad);
	const x1 = Math.min(SHOT.x + SHOT.w, SHOT.x + (focus.x + focus.w) * s + pad);
	const y1 = Math.min(SHOT.y + SHOT.h, SHOT.y + (focus.y + focus.h) * s + pad);
	return { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) };
}

function stepGraph(seg: LayoutSegment, ctx: LayoutContext, seconds: number, padSeconds: number): SegmentGraph {
	const t = ctx.theme;
	const shot =
		`[0:v]tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)},fps=${FRAME.fps},` +
		`scale=${SHOT.w}:${SHOT.h}:flags=lanczos,setsar=1[shot]`;
	const frame: string[] = [canvas(t, seconds)];
	const barY = SHOT.y - BAR_H;
	frame.push(...shadow(SHOT.x, barY, SHOT.w, SHOT.h + BAR_H));
	frame.push(drawBox(SHOT.x, barY, SHOT.w, BAR_H, "0x2B2F36", "fill"));
	for (let i = 0; i < 3; i += 1) frame.push(drawBox(SHOT.x + 16 + i * 18, barY + 12, 10, 10, "white@0.5", "fill"));
	const chapter = seg.chapter ?? { number: null, heading: ctx.title };
	if (chapter.number !== null) {
		frame.push(drawText(ctx, { text: `${ctx.words.step} ${chapter.number}`, font: ctx.bold, size: 28, color: ffColor(t.primary), x: SHOT.x, y: 84 }));
	}
	frame.push(drawText(ctx, { text: wrapText(chapter.heading, 52, 1).join(""), font: ctx.bold, size: 46, color: ffColor(t.text), x: SHOT.x, y: chapter.number !== null ? 120 : 110 }));
	const over: string[] = [`[frame][shot]overlay=${SHOT.x}:${SHOT.y}:shortest=1`];
	if (seg.focus) {
		const b = boxOnScreen(seg.focus);
		// A click/menu/new/confirm changes the screen: its box only marks the
		// target while the pointer travels to it. A filled field stays boxed.
		const enable = HELD_BOX_KINDS.has(seg.stepKind ?? "") ? "gte(t,0.15)" : "between(t,0.15,0.9)";
		over.push(drawBox(b.x, b.y, b.w, b.h, ffColor(t.primary), 4, enable));
	}
	if (seg.pill) {
		const focusBottom = seg.focus !== undefined && seg.focus.y + seg.focus.h / 2 > (SOURCE.h * 2) / 3;
		over.push(
			drawText(ctx, {
				text: wrapCaption(seg.pill),
				font: ctx.bold,
				size: 30,
				color: ffColor(onColor(t.primary, t.text)),
				x: SHOT.x + 30,
				y: focusBottom ? SHOT.y + 46 : `${SHOT.y + SHOT.h - 44}-th`,
				lineSpacing: 8,
				box: { color: ffColor(t.primary), border: 16 },
				alpha: fadeIn(0.2, 0.3),
			}),
		);
	}
	const chain = `${shot};${frame.join(",")}[frame];${over.join(",")}`;
	return { graph: withLogo(ctx, chain, 1, 44, `${SHOT.x + SHOT.w}-overlay_w`, 98), usesRaw: true };
}

/** When item `i` of `n` appears inside a slide of `seconds`. */
export function revealAt(i: number, n: number, seconds: number): number {
	const gap = Math.max(0.4, Math.min(1.8, (seconds - 1.3) / Math.max(1, n)));
	return 0.5 + i * gap;
}

function slideGraph(seg: LayoutSegment, ctx: LayoutContext, seconds: number): SegmentGraph {
	const t = ctx.theme;
	const slide = seg.slide as VideoSlide;
	const parts: string[] = [canvas(t, seconds)];
	if (slide.eyebrow && slide.eyebrow.trim() !== "") {
		parts.push(drawText(ctx, { text: slide.eyebrow.trim(), font: ctx.bold, size: 30, color: ffColor(t.primary), x: MARGIN_X, y: 120, alpha: fadeIn(0.1) }));
	}
	parts.push(drawText(ctx, { text: slide.title.trim(), font: ctx.bold, size: 72, color: ffColor(t.text), x: MARGIN_X, y: 165, alpha: fadeIn(0.2) }));
	const n = slide.items.length;
	if (slide.layout === "cards") {
		const gapX = 44;
		const w = Math.min(500, (FRAME.w - 2 * MARGIN_X - (n - 1) * gapX) / n);
		const h = 380;
		const y = 470;
		slide.items.forEach((item, i) => {
			const x = MARGIN_X + i * (w + gapX);
			const at = revealAt(i, n, seconds);
			const on = `gte(t,${at.toFixed(2)})`;
			parts.push(drawBox(x - 6, y + 2, w + 12, h + 12, "black@0.06", "fill", on));
			parts.push(drawBox(x, y, w, h, "white", "fill", on));
			parts.push(drawBox(x, y, w, 6, ffColor(t.primary), "fill", on));
			const titleLines = wrapText(item.title, Math.floor((w - 72) / 19), 2);
			parts.push(drawText(ctx, { text: titleLines.join("\n"), font: ctx.bold, size: 34, color: ffColor(t.text), x: x + 36, y: y + 56, lineSpacing: 8, alpha: fadeIn(at, 0.3) }));
			if (item.text && item.text.trim() !== "") {
				const body = wrapText(item.text, Math.floor((w - 72) / 14.5), 5);
				parts.push(drawText(ctx, { text: body.join("\n"), font: ctx.font, size: 27, color: ffColor(t.text, 0.72), x: x + 36, y: y + 56 + titleLines.length * 44 + 22, lineSpacing: 10, alpha: fadeIn(at, 0.3) }));
			}
		});
	} else {
		slide.items.forEach((item, i) => {
			const y = 330 + i * 92;
			const at = revealAt(i, n, seconds);
			parts.push(drawText(ctx, { text: ctx.check ? "✓" : "•", font: ctx.check ?? ctx.bold, size: 44, color: ffColor(t.accent), x: MARGIN_X, y, alpha: fadeIn(at, 0.3) }));
			parts.push(drawText(ctx, { text: wrapText(item.title, 70, 1).join(""), font: ctx.bold, size: 40, color: ffColor(t.text), x: MARGIN_X + 64, y: y + 4, alpha: fadeIn(at, 0.3) }));
		});
	}
	return { graph: withLogo(ctx, parts.join(","), 0, 44, `${FRAME.w - MARGIN_X}-overlay_w`, 70), usesRaw: false };
}

function outroGraph(seg: LayoutSegment, ctx: LayoutContext, seconds: number): SegmentGraph {
	const t = ctx.theme;
	const parts: string[] = [canvas(t, seconds)];
	let y = 400;
	const text = (seg.text ?? "").trim();
	if (text !== "") {
		const lines = wrapText(text, 40, 3);
		parts.push(drawText(ctx, { text: lines.join("\n"), font: ctx.bold, size: 64, color: ffColor(t.text), x: MARGIN_X, y, lineSpacing: 14, alpha: fadeIn(0.2) }));
		y += lines.length * 78 + 56;
	}
	if (ctx.nextTitle) {
		parts.push(drawBox(MARGIN_X, y, 120, 6, ffColor(t.primary), "fill", "gte(t,0.6)"));
		parts.push(drawText(ctx, { text: `${ctx.words.next}: ${ctx.nextTitle}`, font: ctx.bold, size: 40, color: ffColor(t.primary), x: MARGIN_X, y: y + 30, alpha: fadeIn(0.6) }));
	}
	return { graph: withLogo(ctx, parts.join(","), 0, 44, `${FRAME.w - MARGIN_X}-overlay_w`, 70), usesRaw: false };
}

/** Wrap a pill/caption to at most two lines of ~`max` characters. */
export function wrapCaption(text: string, max = 56): string {
	return wrapText(text, max, 2).join("\n");
}

/**
 * The filter graph of one segment. `seconds` is the segment's final length;
 * `padSeconds` (step only) is how long the last recorded frame is held.
 */
export function segmentGraph(seg: LayoutSegment, ctx: LayoutContext, seconds: number, padSeconds = 0): SegmentGraph {
	switch (seg.kind) {
		case "title":
			return titleGraph(ctx, seconds);
		case "slide":
			return slideGraph(seg, ctx, seconds);
		case "outro":
			return outroGraph(seg, ctx, seconds);
		default:
			return stepGraph(seg, ctx, seconds, padSeconds);
	}
}
