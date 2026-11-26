/**
 * video-theme.ts — the look of an odoo_video series: base colors, logo and
 * the localized words the layout paints ("Step", "Tutorial", "Next").
 *
 * The theme is a SERIES decision asked once at plan time: Odoo colors by
 * default, or the user's own base colors. Colors travel into ffmpeg filter
 * strings, so only strict `#RRGGBB` values are ever accepted — anything else
 * is a validation error, never interpolated.
 */

import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { VideoStyle, VideoTheme } from "./manual-model.js";

/** Odoo's own palette: brand purple, light canvas, dark text, teal accent. */
export const ODOO_THEME: ResolvedTheme = {
	primary: "#714B67",
	background: "#F2F3F5",
	text: "#1F2937",
	accent: "#017E84",
};

export interface ResolvedTheme {
	/** Eyebrows, the title accent, highlight boxes and pills. */
	primary: string;
	/** The canvas behind the framed screen and the slides. */
	background: string;
	/** Headings and body text. */
	text: string;
	/** Checklist marks. */
	accent: string;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Logo formats ffmpeg decodes without extra codecs. */
const LOGO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/** The colors the assembler paints with (custom values over the Odoo ones). */
export function resolveTheme(theme: VideoTheme | undefined): ResolvedTheme {
	if (!theme || theme.preset !== "custom") return ODOO_THEME;
	return {
		primary: theme.primary ?? ODOO_THEME.primary,
		background: theme.background ?? ODOO_THEME.background,
		text: theme.text ?? ODOO_THEME.text,
		accent: theme.accent ?? theme.primary ?? ODOO_THEME.accent,
	};
}

/** `#RRGGBB` → the `0xRRGGBB` form ffmpeg color options take. */
export function ffColor(hex: string, alpha?: number): string {
	return `0x${hex.slice(1).toUpperCase()}${alpha !== undefined ? `@${alpha}` : ""}`;
}

/** Text color that reads on top of `hex` (white on dark, theme text on light). */
export function onColor(hex: string, darkText: string): string {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.45 ? darkText : "#FFFFFF";
}

/**
 * Problems with the series style, as plain sentences (empty = valid).
 * `workspace` resolves the logo; without it the logo file is not checked.
 */
export function styleProblems(style: VideoStyle | undefined, workspace?: string): string[] {
	const out: string[] = [];
	const theme = style?.theme;
	if (theme) {
		if (theme.preset !== "odoo" && theme.preset !== "custom") {
			out.push(`theme.preset must be "odoo" or "custom", got ${JSON.stringify(theme.preset)}`);
		}
		if (theme.preset === "custom" && !theme.primary) out.push("a custom theme needs at least theme.primary (#RRGGBB)");
		for (const key of ["primary", "background", "text", "accent"] as const) {
			const value = theme[key];
			if (value !== undefined && !HEX.test(value)) out.push(`theme.${key} must be a #RRGGBB color, got ${JSON.stringify(value)}`);
		}
	}
	if (typeof style?.logo === "string") {
		const logo = style.logo;
		if (!LOGO_EXTENSIONS.has(extname(logo).toLowerCase())) out.push(`logo must be a .png or .jpg file, got ${JSON.stringify(logo)}`);
		if (workspace) {
			const abs = resolve(workspace, logo);
			const rel = relative(resolve(workspace), abs);
			if (rel.startsWith("..") || isAbsolute(rel)) out.push(`logo must live inside the video workspace, got ${JSON.stringify(logo)}`);
			else if (!existsSync(abs)) out.push(`logo file not found: ${logo}`);
			else if (statSync(abs).size > LOGO_MAX_BYTES) out.push(`logo is larger than 5 MiB: ${logo}`);
		}
	}
	return out;
}

/**
 * The look questions the USER still has to answer: the colors (Odoo or their
 * own) and whether the videos carry a logo. Empty = the look is decided.
 */
export function openLookQuestions(style: VideoStyle | undefined): ("theme" | "logo")[] {
	const open: ("theme" | "logo")[] = [];
	if (!style?.theme) open.push("theme");
	if (style?.logo === undefined) open.push("logo");
	return open;
}

/** The words the layout paints, per storyboard language (English fallback). */
const WORDS: Record<string, { step: string; tutorial: string; next: string }> = {
	es: { step: "Paso", tutorial: "Tutorial", next: "Siguiente" },
	en: { step: "Step", tutorial: "Tutorial", next: "Next" },
	pt: { step: "Passo", tutorial: "Tutorial", next: "Próximo" },
	fr: { step: "Étape", tutorial: "Tutoriel", next: "Suivant" },
	de: { step: "Schritt", tutorial: "Tutorial", next: "Weiter" },
};

export function layoutWords(language: string | undefined): { step: string; tutorial: string; next: string } {
	const prefix = (language ?? "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
	return WORDS[prefix] ?? (WORDS["en"] as { step: string; tutorial: string; next: string });
}
