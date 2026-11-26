/**
 * video-assemble.ts — ensambla el video final con ffmpeg.
 *
 * Inputs: the storyboard flow + capture.json (schema /2, with the recording
 * and per-step timestamps) + the voice report (optional — a silent video is
 * valid) + the series style (theme colors, logo). The video is a TUTORIAL
 * (video-layout.ts): a title card, then every step's recorded screen framed
 * on the theme canvas — cut by timestamps, the last frame frozen until the
 * narration fits (`tpad=stop_mode=clone`) — with "Step N" + chapter heading,
 * the acted-on element boxed and a short pill; designed slides (cards or a
 * checklist) where the storyboard asks for them; and an outro naming the next
 * video. Every segment is reencoded to a uniform 1920x1080 h264/yuv420p/25fps,
 * concatenated, then muxed with the voice track (narrations + silences). SRT +
 * VTT captions are ALWAYS derived (deterministic, no ffmpeg needed to compute
 * them) — they are also the export path to external video platforms.
 *
 * Gates: no recorded capture → NEEDS_VIDEO_CAPTURE; no ffmpeg → NEEDS_FFMPEG.
 * A step that failed mid-capture truncates the video at the last OK step
 * (`truncatedAt` names the failing one). The raw webm is KEPT so a re-assembly
 * never needs a re-capture.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic } from "./atomic.js";
import { posixPath } from "./paths.js";
import type { Flow, VideoSlide, VideoStyle } from "./manual-model.js";
import type { CaptureReport } from "./manual-capture.js";
import type { RpcResult } from "./manual-capture.js";
import { ffprobePathOf, probeDurationSeconds, readVoiceReport } from "./video-voice.js";
import { segmentGraph, type LayoutContext } from "./video-layout.js";
import { layoutWords, openLookQuestions, resolveTheme, styleProblems } from "./video-theme.js";

const FIXED_DWELL_SECONDS = 2.5;
/** Title card and outro without narration hold this long. */
const CARD_SECONDS = 3.5;
/** Shortest window read from the raw recording (one step can beat one frame). */
const MIN_CUT_SECONDS = 0.5;
/** Trim the tail of a window: the next step starts painting on its first frame. */
const CUT_GUARD_SECONDS = 0.12;
/** For a `goto`, keep only this much of the window before its held end state. */
const NAV_TAIL_SECONDS = 0.9;
/** Voice tail after the last word, so a step never cuts the audio. */
const VOICE_TAIL_SECONDS = 0.35;

/** Font files for the layout text (regular face), most legible first. */
const FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
	"/usr/share/fonts/noto/NotoSans-Regular.ttf",
	"C:\\Windows\\Fonts\\segoeui.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/TTF/DejaVuSans.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
	"C:\\Windows\\Fonts\\arial.ttf",
	"/System/Library/Fonts/Supplemental/Arial.ttf",
];

/** Bold faces for headings, the title card and the pills. */
const BOLD_FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
	"/usr/share/fonts/noto/NotoSans-Bold.ttf",
	"C:\\Windows\\Fonts\\segoeuib.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
	"C:\\Windows\\Fonts\\arialbd.ttf",
	"/System/Library/Fonts/Supplemental/Arial Bold.ttf",
	...FONT_CANDIDATES,
];

/** Faces known to carry the ✓ glyph of the checklist slides. */
const CHECK_FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
	"C:\\Windows\\Fonts\\seguisym.ttf",
	"/System/Library/Fonts/Apple Symbols.ttf",
];

const firstExisting = (paths: string[]): string | undefined => paths.find((f) => existsSync(f));

export interface VideoSegment {
	stepId: string;
	/** Where the segment sits in the tutorial (title → steps/slides → outro). */
	kind: "title" | "step" | "slide" | "outro";
	/** The capture step kind (goto/click/highlight/…) — drives the SFX pick. */
	stepKind?: string;
	/** The narration sentence, or null for a silent segment. */
	text: string | null;
	/** Where the step starts inside the raw recording (0 for drawn segments). */
	cutStartSeconds: number;
	cutEndSeconds: number;
	/** How long the segment holds in the final video (>= narration). */
	targetSeconds: number;
	narrated: boolean;
	/** Element the step acted on (CSS px of the 1440x900 viewport): the box. */
	focus?: { x: number; y: number; w: number; h: number };
	/** step: "Step N" (null before the first chapter) + heading. */
	chapter?: { number: number | null; heading: string };
	/** step: the pill text (caption, or the narration when captions burn). */
	pill?: string | null;
	slide?: VideoSlide;
}

export interface VideoReport {
	schema: "dsh-odoo-sdd/video/1";
	flow: string;
	language?: string;
	voice: string | null;
	narrated: boolean;
	captions: boolean;
	file: string;
	bytes: number;
	durationSeconds: number | null;
	segments: number;
	/** Present when a capture step failed and the video stops before it. */
	truncatedAt?: string;
	/** Integrated loudness of the final audio (ffmpeg ebur128), when measured. */
	loudnessLufs?: number;
	/** The assembly carried a ducking music bed. */
	music: boolean;
	/** The assembly carried synthesized UI sfx. */
	sfx: boolean;
	/** The title card is narrated (the flow's hook). */
	hook: boolean;
	/** The video closes with an outro card. */
	outro: boolean;
	/**
	 * Lead-in removed from every step timestamp: the recording starts at its
	 * first painted frame, so a slow instance shifts the wall clock (video time
	 * = wall time - captureOffsetSeconds).
	 */
	captureOffsetSeconds?: number;
	/** Duration of the raw webm the segments were cut from. */
	rawDurationSeconds?: number | null;
}

function srtTime(seconds: number): string {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	const milli = ms % 1000;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

/** The rendered length of a segment: the cut, or the narration when longer. */
const segDuration = (seg: VideoSegment): number => Math.max(seg.cutEndSeconds - seg.cutStartSeconds, seg.targetSeconds);

/** SRT entries: one per narrated step, positioned by the segment timeline. */
export function buildSrt(segments: VideoSegment[]): string {
	const lines: string[] = [];
	let index = 1;
	let cursor = 0;
	for (const seg of segments) {
		const start = cursor;
		const end = cursor + segDuration(seg);
		cursor = end;
		if (seg.text === null) continue;
		lines.push(String(index++));
		lines.push(`${srtTime(start)} --> ${srtTime(end)}`);
		lines.push(seg.text.replace(/\r?\n/g, " "));
		lines.push("");
	}
	return lines.join("\n");
}

/** WebVTT variant of the same timeline. */
export function buildVtt(segments: VideoSegment[]): string {
	const body = buildSrt(segments)
		.split("\n")
		.map((line) => (line.includes(" --> ") ? line.replace(/,/g, ".") : line))
		.join("\n");
	return `WEBVTT\n\n${body}`;
}

async function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs = 300_000): Promise<RpcResult<{ stderr: string }>> {
	return new Promise((resolvePromise) => {
		const child = spawn(ffmpegPath, args, { shell: false });
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
			if (stderr.length > 8000) stderr = stderr.slice(-8000);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolvePromise({ ok: false, error: `${e.message} — is ffmpeg installed? (config key ffmpegPath / env ODOO_SDD_FFMPEG)` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise({ ok: true, value: { stderr } });
			else resolvePromise({ ok: false, error: `ffmpeg exited ${code}: ${stderr.slice(-600) || "(no stderr)"}` });
		});
	});
}

export interface AssembleOptions {
	workspace: string;
	flow: Flow;
	language?: string;
	ffmpegPath: string;
	/**
	 * Burn the narration into the step pills when a step has no caption of
	 * its own. Default true at the tool layer; captions always show.
	 */
	captions: boolean;
	/** Flow title for the title card and the steps before the first chapter. */
	title: string;
	/** The flow's number in the series ("Tutorial NN"). */
	number: number;
	/** Title-card eyebrow (series style eyebrow, or the flow group). */
	eyebrow?: string;
	/** Title-card subtitle (flow.summary). */
	summary?: string;
	/** Theme colors and logo (storyboard.video). Both must be decided. */
	style: VideoStyle | undefined;
	/** "Tutorial NN · Title" of the NEXT series video — the outro's "next" line. */
	nextTitle?: string;
	/** Synthesized music bed with voice ducking (deps.videoMusic default). */
	music: boolean;
	/** Synthesized UI sfx per step kind (deps.videoSfx default). */
	sfx: boolean;
	/**
	 * The series file stem (`NN-slug`, from numberFlows): the mp4/srt/vtt land
	 * at the workspace root under it, so the series sorts as its watch order.
	 */
	stem: string;
	/**
	 * The file this flow was last assembled as (from video/series.json), when
	 * it differs from the new stem — a renumbering must not strand the old
	 * file as an orphan the index then reports.
	 */
	previousFile?: string;
}

/** The series map persisted at video/series.json: flowId → its last report. */
export interface SeriesReport {
	schema: "dsh-odoo-sdd/series/1";
	flows: Record<string, VideoReport>;
}

/** Read the series map (empty when absent or unreadable). */
export function readSeries(workspace: string): SeriesReport {
	const file = join(workspace, "video", "series.json");
	if (!existsSync(file)) return { schema: "dsh-odoo-sdd/series/1", flows: {} };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as SeriesReport;
		return raw?.schema === "dsh-odoo-sdd/series/1" && raw.flows ? raw : { schema: "dsh-odoo-sdd/series/1", flows: {} };
	} catch {
		return { schema: "dsh-odoo-sdd/series/1", flows: {} };
	}
}

/**
 * Delete the artifacts of a PREVIOUS assembly of the same flow, but only the
 * media extensions the pipeline itself produces and only inside the
 * workspace: `previousFile` comes from a report on disk, and a hand-edited
 * report must never turn the assembler into an unlink primitive.
 */
function removePreviousArtifacts(workspace: string, previousFile: string): void {
	const abs = resolve(workspace, previousFile);
	const rel = relative(resolve(workspace), abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return;
	if (!/\.(mp4|srt|vtt)$/i.test(previousFile)) return;
	for (const ext of [".mp4", ".srt", ".vtt"]) {
		const target = abs.replace(/\.(mp4|srt|vtt)$/i, ext);
		if (existsSync(target)) rmSync(target, { force: true });
	}
}

// ---------------------------------------------------------------------------
// Phase 5 helpers — text wrapping, filter graphs, sfx/music, loudness
// ---------------------------------------------------------------------------

/**
 * SFX definition per capture step kind, as a lavfi source + per-segment
 * delay. All synthesized — no third-party assets, fully deterministic.
 * `ms` is when the sound lands inside the segment.
 */
function sfxFor(seg: VideoSegment): { src: string; filters: string; delayMs: number } | null {
	const k = seg.kind === "step" ? (seg.stepKind ?? "") : "whoosh";
	switch (k) {
		case "whoosh":
			return { src: "anoisesrc=color=pink:duration=0.5:amplitude=0.5", filters: "bandpass=f=800:w=600,volume=0.16,afade=t=in:d=0.15,afade=t=out:st=0.35:d=0.15", delayMs: 50 };
		case "highlight":
			return { src: "sine=frequency=1320:duration=0.4", filters: "volume=0.22,afade=t=out:st=0.08:d=0.3", delayMs: 500 };
		case "click":
		case "new":
		case "confirm":
		case "menu":
		case "fill":
		case "select":
			return { src: "anoisesrc=color=white:duration=0.05:amplitude=0.6", filters: "lowpass=f=3500,volume=0.28,afade=t=out:st=0.02:d=0.03", delayMs: 700 };
		default:
			return null;
	}
}

/** The 16 s looping pad bed: sine chords + slow tremolo, ~-28 dB. */
function musicBedFilters(): string {
	return (
		"aevalsrc='0.20*sin(2*PI*220*t)+0.14*sin(2*PI*261.63*t)+0.12*sin(2*PI*329.63*t)+0.08*sin(2*PI*440*t)':s=44100:d=16," +
		"pan=stereo|c0=c0|c1=c0,tremolo=f=0.25:d=0.4,lowpass=f=1800,volume=0.045"
	);
}

/** Parse the JSON loudnorm prints on stderr (pass 1 measurements). */
function parseLoudnorm(stderr: string): Record<string, number> | null {
	const m = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
	if (!m) return null;
	try {
		const raw = JSON.parse(m[0]) as Record<string, string>;
		const num = (k: string): number => Number.parseFloat(raw[k] ?? "");
		return {
			measured_i: num("input_i"),
			measured_tp: num("input_tp"),
			measured_lra: num("input_lra"),
			measured_thresh: num("input_thresh"),
			offset: num("target_offset"),
		};
	} catch {
		return null;
	}
}

/** Parse the integrated LUFS ebur128 prints in its summary block. */
function parseIntegratedLufs(stderr: string): number | undefined {
	const m = stderr.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
	return m ? Number.parseFloat(m[1]) : undefined;
}

/**
 * Assemble ONE flow into <workspace>/<stem>.mp4 + .srt + .vtt, merge the
 * report into video/series.json (per-flow map that survives re-assemblies of
 * its siblings) and keep video/video.json as the last-assembled report.
 */
export async function assembleVideo(opts: AssembleOptions): Promise<RpcResult<VideoReport>> {
	// Gate 1: a recorded capture for this flow.
	const captureFile = join(opts.workspace, "capture.json");
	if (!existsSync(captureFile)) {
		return {
			ok: false,
			errorKind: "needs_video_capture",
			error: "NEEDS_VIDEO_CAPTURE — there is no capture.json in the video workspace: run operation=capture (it records the browser session) first.",
		};
	}
	let capture: CaptureReport;
	try {
		capture = JSON.parse(readFileSync(captureFile, "utf8")) as CaptureReport;
	} catch {
		return { ok: false, error: "capture.json is not valid JSON — re-run operation=capture." };
	}
	if (capture.flow !== opts.flow.id) {
		return {
			ok: false,
			errorKind: "needs_video_capture",
			error: `NEEDS_VIDEO_CAPTURE — capture.json belongs to flow ${capture.flow}, not ${opts.flow.id}: re-run operation=capture for this flow.`,
		};
	}
	if (!capture.video) {
		return {
			ok: false,
			errorKind: "needs_video_capture",
			error: "NEEDS_VIDEO_CAPTURE — capture.json has no recording (schema /1, no video entry): re-run operation=capture, which always records.",
		};
	}

	// Gate 2: ffmpeg itself.
	const probe = await runFfmpeg(opts.ffmpegPath, ["-version"], 15_000);
	if (!probe.ok) {
		return { ok: false, errorKind: "needs_ffmpeg", error: `NEEDS_FFMPEG — ${probe.error}. ffmpeg 4.x+ is required (7.x verified); install it or set ffmpegPath.` };
	}

	// Gate 3: the series look. The colors are the USER's decision (Odoo by
	// default, or their own): the assembler never picks them silently.
	const openLook = openLookQuestions(opts.style);
	if (openLook.length > 0) {
		return {
			ok: false,
			errorKind: "needs_video_theme",
			error:
				`NEEDS_VIDEO_THEME — the series look is not decided (${openLook.join(", ")}): ask the user whether to keep the Odoo colors ` +
				"(default) or use their own base colors (#RRGGBB), and whether the videos carry a logo or none; then run operation=style.",
		};
	}
	const styleIssues = styleProblems(opts.style, opts.workspace);
	if (styleIssues.length > 0) return { ok: false, error: `the series style is invalid: ${styleIssues.join("; ")} — fix it with operation=style.` };

	// Gate 4: fonts. Every card and heading is drawn text.
	const fontFile = firstExisting(FONT_CANDIDATES);
	const boldFont = firstExisting(BOLD_FONT_CANDIDATES) ?? fontFile;
	if (!fontFile || !boldFont) {
		return { ok: false, errorKind: "needs_font", error: "NEEDS_FONT — no known font file was found (Noto Sans, DejaVu, Liberation, Segoe UI, Arial): install one of them." };
	}

	// The recording's t=0 is the FIRST PAINTED FRAME, not the context creation:
	// on a slow instance the wall-clock offsets can run past the end of the webm
	// (measured: 8.03 s of offsets in a 6.6 s file). Model it as one constant
	// lead-in and subtract it; clamp every cut to the file.
	const rawPath = join(opts.workspace, capture.video.file);
	if (!existsSync(rawPath)) return { ok: false, error: `the raw recording is missing: ${capture.video.file} — re-run operation=capture.` };
	const rawDuration = await probeDurationSeconds(rawPath, opts.ffmpegPath);
	const lastEndSeconds = capture.steps.reduce((max, s) => Math.max(max, (s.endMs ?? 0) / 1000), 0);
	const captureOffset =
		rawDuration !== null && lastEndSeconds > rawDuration ? Math.round((lastEndSeconds - rawDuration) * 1000) / 1000 : 0;
	const videoTime = (ms: number): number => Math.max(0, ms / 1000 - captureOffset);
	const videoLimit = rawDuration !== null ? Math.max(0.2, rawDuration - CUT_GUARD_SECONDS) : Number.POSITIVE_INFINITY;

	// Segments, in storyboard order: the title card, then every step (a
	// recorded step needs an OK capture with timestamps — the first failure
	// truncates the video) or drawn slide, then the outro.
	const voice = readVoiceReport(opts.workspace, opts.flow.id);
	const voiceByStep = new Map((voice?.items ?? []).map((i) => [i.stepId, i]));
	const clean = (value: string | null | undefined): string | null => {
		const text = (value ?? "").replace(/\s+/g, " ").trim();
		return text === "" ? null : text;
	};
	/** Segment length that fits the narration, or null when it is silent. */
	const narrationSeconds = (stepId: string, text: string | null): number | null => {
		const item = voiceByStep.get(stepId);
		return item && text !== null ? (item.durationSeconds ?? FIXED_DWELL_SECONDS) + VOICE_TAIL_SECONDS : null;
	};
	const segments: VideoSegment[] = [];
	const hookText = clean(opts.flow.hook?.text);
	const hookSeconds = narrationSeconds("_hook", hookText);
	segments.push({
		stepId: "_hook",
		kind: "title",
		text: hookSeconds !== null ? hookText : null,
		cutStartSeconds: 0,
		cutEndSeconds: 0,
		targetSeconds: hookSeconds ?? CARD_SECONDS,
		narrated: hookSeconds !== null,
	});
	const captured = new Map(capture.steps.map((s) => [s.id, s]));
	let chapterCount = 0;
	let chapter: { number: number | null; heading: string } = { number: null, heading: opts.title };
	let seenRecording = false;
	let truncatedAt: string | undefined;
	for (const step of opts.flow.steps) {
		const text = clean(step.procedure);
		const seconds = narrationSeconds(step.id, text);
		if (step.kind === "slide") {
			// A slide without its content is a lint ERROR; never draw a guess.
			if (!step.slide) continue;
			segments.push({
				stepId: step.id,
				kind: "slide",
				stepKind: "slide",
				text,
				cutStartSeconds: 0,
				cutEndSeconds: 0,
				targetSeconds: seconds ?? Math.max(3, step.slide.items.length * 1.2 + 1.5),
				narrated: seconds !== null,
				slide: step.slide,
			});
			continue;
		}
		const heading = clean(step.chapter);
		if (heading !== null) {
			chapterCount += 1;
			chapter = { number: chapterCount, heading };
		}
		const rec = captured.get(step.id);
		if (!rec) {
			// Steps before a resumed capture were not recorded in this run.
			if (!seenRecording) continue;
			truncatedAt = step.id;
			break;
		}
		seenRecording = true;
		if (rec.status !== "ok" || rec.startMs === undefined || rec.endMs === undefined) {
			truncatedAt = step.id;
			break;
		}
		if (videoTime(rec.startMs) >= videoLimit) {
			// The step happened after the recording stopped: nothing to show.
			truncatedAt = step.id;
			break;
		}
		const windowStart = videoTime(rec.startMs);
		const windowEnd = Math.min(videoLimit, Math.max(windowStart + MIN_CUT_SECONDS, videoTime(rec.endMs) - CUT_GUARD_SECONDS));
		// A `goto` spends its window loading: the first frames are the blank shell
		// (or the page being left). Only its tail — the mounted view held by the
		// recording dwell — is worth showing, so the video never opens on white.
		const cutStart = rec.kind === "goto" ? Math.max(windowStart, windowEnd - NAV_TAIL_SECONDS) : windowStart;
		const caption = clean(step.caption);
		segments.push({
			stepId: step.id,
			kind: "step",
			stepKind: rec.kind,
			text,
			cutStartSeconds: cutStart,
			// A real step can finish inside one frame (<40 ms). Reading less than
			// MIN_CUT_SECONDS leaves the encoder nothing to show, so extend the
			// window forward: the state AFTER the step is the one being narrated.
			cutEndSeconds: windowEnd,
			targetSeconds: seconds ?? FIXED_DWELL_SECONDS,
			narrated: seconds !== null,
			focus: rec.focus,
			chapter,
			pill: caption ?? (opts.captions ? text : null),
		});
	}
	if (!segments.some((s) => s.kind === "step")) {
		return { ok: false, error: `no capturable step survived in capture.json (first failure: ${truncatedAt ?? "none"}) — nothing to assemble.` };
	}
	const outroText = clean(opts.flow.outro?.text);
	const outroSeconds = narrationSeconds("_outro", outroText);
	if (outroText !== null || opts.nextTitle) {
		segments.push({
			stepId: "_outro",
			kind: "outro",
			text: outroSeconds !== null ? outroText : null,
			cutStartSeconds: 0,
			cutEndSeconds: 0,
			targetSeconds: outroSeconds ?? CARD_SECONDS,
			narrated: outroSeconds !== null,
		});
	}

	const tmp = join(opts.workspace, "video", "tmp", opts.flow.id);
	mkdirSync(tmp, { recursive: true });
	const outDir = join(opts.workspace, "video");
	mkdirSync(outDir, { recursive: true });

	let textFiles = 0;
	const layout: LayoutContext = {
		theme: resolveTheme(opts.style?.theme),
		font: fontFile,
		bold: boldFont,
		check: firstExisting(CHECK_FONT_CANDIDATES) ?? null,
		logo: opts.style?.logo ? resolve(opts.workspace, opts.style.logo) : null,
		words: layoutWords(opts.language),
		title: opts.title,
		number: opts.number,
		eyebrow: opts.eyebrow,
		summary: opts.summary,
		nextTitle: opts.nextTitle,
		textFile: (content) => {
			textFiles += 1;
			const file = join(tmp, `text-${String(textFiles).padStart(4, "0")}.txt`);
			writeFileSync(file, content, { mode: 0o600 });
			return file;
		},
	};
	const captionsBurned = segments.some((s) => Boolean(s.pill));

	const videoList: string[] = [];
	const audioList: string[] = [];
	try {
		let index = 0;
		for (const seg of segments) {
			const tag = String(index).padStart(3, "0");
			const segFile = join(tmp, `seg-${tag}.mp4`);
			const cutDuration = seg.kind === "step" ? seg.cutEndSeconds - seg.cutStartSeconds : 0;
			const pad = Math.max(0, seg.targetSeconds - cutDuration);
			const segDur = cutDuration + pad;
			const graph = segmentGraph(
				{ ...seg, text: seg.kind === "outro" ? outroText : seg.text },
				layout,
				segDur,
				pad,
			);
			// `-t` MUST be an INPUT option here (before -i): as an output option
			// it also caps the frames tpad appends, cutting the freeze short and
			// leaving the narration hanging over a shorter clip.
			const v = await runFfmpeg(opts.ffmpegPath, [
				"-y", "-loglevel", "error",
				...(graph.usesRaw ? ["-ss", seg.cutStartSeconds.toFixed(3), "-t", cutDuration.toFixed(3), "-i", rawPath] : []),
				...(layout.logo ? ["-i", layout.logo] : []),
				"-filter_complex", graph.graph, "-map", "[out]",
				"-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an",
				segFile,
			]);
			if (!v.ok) return { ok: false, error: `segment ${seg.stepId}: ${v.error}` };
			videoList.push(segFile);

			// Audio: voice chain (cleanup → pad → exact length) with the step's
			// own SFX mixed INSIDE the segment — a global sfx track would have
			// to survive every cut boundary instead. The segment audio is padded
			// to segDur, the REAL video length: padding only to targetSeconds
			// lets the audio run ahead of the video by every surplus frame of
			// window, and by the last segment the voice is seconds early.
			const audioFile = join(tmp, `aud-${tag}.m4a`);
			const voiceItem = seg.narrated ? voiceByStep.get(seg.stepId) : undefined;
			const voiceAbs = voiceItem && existsSync(join(opts.workspace, voiceItem.file)) ? join(opts.workspace, voiceItem.file) : null;
			const sfx = opts.sfx ? sfxFor(seg) : null;
			if (sfx) {
				const graph =
					`[0:a]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=10:release=200:makeup=2[v];` +
					`[1:a]${sfx.filters},adelay=${sfx.delayMs}|${sfx.delayMs}[s];` +
					`[v][s]amix=inputs=2:normalize=0,apad,atrim=0:${segDur.toFixed(3)},` +
					`aresample=44100,aformat=channel_layouts=stereo[out]`;
				const a = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					...(voiceAbs ? ["-i", voiceAbs] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]),
					"-f", "lavfi", "-i", sfx.src,
					"-filter_complex", graph, "-map", "[out]",
					"-c:a", "aac", "-b:a", "128k",
					audioFile,
				]);
				if (!a.ok) return { ok: false, error: `audio for ${seg.stepId}: ${a.error}` };
			} else if (voiceAbs) {
				const a = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					"-i", voiceAbs,
					"-af", "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=10:release=200:makeup=2,apad",
					"-t", segDur.toFixed(3),
					"-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
					audioFile,
				]);
				if (!a.ok) return { ok: false, error: `audio for ${seg.stepId}: ${a.error}` };
			} else {
				const a = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					"-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
					"-t", segDur.toFixed(3),
					"-c:a", "aac", "-b:a", "128k",
					audioFile,
				]);
				if (!a.ok) return { ok: false, error: `silence for ${seg.stepId}: ${a.error}` };
			}
			audioList.push(audioFile);
			index += 1;
		}

		// Concat both tracks, then mux with the language metadata + faststart.
		writeFileSync(join(tmp, "video.txt"), videoList.map(concatEntry).join("\n"), { mode: 0o600 });
		writeFileSync(join(tmp, "audio.txt"), audioList.map(concatEntry).join("\n"), { mode: 0o600 });
		const videoOnly = join(tmp, "track.mp4");
		const audioOnly = join(tmp, "track.m4a");
		let c = await runFfmpeg(opts.ffmpegPath, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "video.txt"), "-c", "copy", videoOnly]);
		if (!c.ok) return { ok: false, error: `video concat: ${c.error}` };
		c = await runFfmpeg(opts.ffmpegPath, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "audio.txt"), "-c", "copy", audioOnly]);
		if (!c.ok) return { ok: false, error: `audio concat: ${c.error}` };

		// The music bed ducks UNDER the voice: a video nobody narrates gets no
		// bed at all (a pad over silence would sound like a bug, not a bed).
		const totalSeconds = (await probeDurationSeconds(videoOnly, opts.ffmpegPath)) ?? segments.reduce((a, s) => a + Math.max(s.cutEndSeconds - s.cutStartSeconds, s.targetSeconds), 0);
		const hasVoice = segments.some((s) => s.narrated);
		let finalAudio = audioOnly;
		if (opts.music && hasVoice) {
			const bed = join(tmp, "bed.wav");
			const b = await runFfmpeg(opts.ffmpegPath, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", musicBedFilters(), bed]);
			if (b.ok) {
				const mixed = join(tmp, "mixed.m4a");
				const m2 = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					"-i", audioOnly, "-stream_loop", "-1", "-i", bed,
					"-filter_complex",
					`[1:a]atrim=0:${totalSeconds.toFixed(3)}[m];[0:a]asplit=2[v][k];` +
						`[m][k]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=400:makeup=1[d];` +
						`[v][d]amix=inputs=2:normalize=0[o]`,
					"-map", "[o]", "-c:a", "aac", "-b:a", "128k", mixed,
				]);
				if (m2.ok) finalAudio = mixed;
			}
		}

		// loudnorm, two real passes: measure the mix, then apply with the
		// measurements so the correction is linear (no pumping). A binary that
		// prints no measurements (the test double) just keeps the pre-norm mix.
		const measured = await runFfmpeg(opts.ffmpegPath, [
			"-y", "-loglevel", "info", "-i", finalAudio,
			"-af", "loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json", "-f", "null", "-",
		]);
		const loud = measured.ok ? parseLoudnorm(measured.value.stderr) : null;
		if (loud) {
			const norm = join(tmp, "norm.m4a");
			const n = await runFfmpeg(opts.ffmpegPath, [
				"-y", "-loglevel", "error", "-i", finalAudio,
				"-af",
				`loudnorm=I=-14:TP=-1.2:LRA=11:measured_I=${loud["measured_i"]}:measured_TP=${loud["measured_tp"]}:measured_LRA=${loud["measured_lra"]}:measured_thresh=${loud["measured_thresh"]}:offset=${loud["offset"]}:linear=true`,
				"-ar", "44100", "-c:a", "aac", "-b:a", "128k", norm,
			]);
			if (n.ok) finalAudio = norm;
		}

		const langTag = (opts.language ?? "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
		const finalFile = posixPath(`${opts.stem}.mp4`);
		const m = await runFfmpeg(opts.ffmpegPath, [
			"-y", "-loglevel", "error",
			"-i", videoOnly, "-i", finalAudio,
			"-map", "0:v:0", "-map", "1:a:0",
			"-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
			"-metadata:s:a:0", `language=${langTag}`,
			"-movflags", "+faststart", "-shortest",
			join(opts.workspace, finalFile),
		]);
		if (!m.ok) return { ok: false, error: `final mux: ${m.error}` };

		// Captions ALWAYS ship, next to the mp4 at the series root (they are
		// also the export path for external platforms).
		writeFileAtomic(join(opts.workspace, `${opts.stem}.srt`), buildSrt(segments));
		writeFileAtomic(join(opts.workspace, `${opts.stem}.vtt`), buildVtt(segments));

		// A renamed stem must not strand the old file: remove the previous
		// artifacts this flow left under its earlier name.
		if (opts.previousFile && opts.previousFile !== finalFile) removePreviousArtifacts(opts.workspace, opts.previousFile);

		const absFinal = join(opts.workspace, finalFile);
		// Measure what loudnorm actually produced on the shipped file: the
		// report claims evidence, never intent.
		const measure = await runFfmpeg(opts.ffmpegPath, ["-y", "-loglevel", "info", "-i", absFinal, "-af", "ebur128", "-f", "null", "-"]);
		const lufs = measure.ok ? parseIntegratedLufs(measure.value.stderr) : undefined;
		const report: VideoReport = {
			schema: "dsh-odoo-sdd/video/1",
			flow: opts.flow.id,
			language: opts.language,
			voice: voice?.voice ?? null,
			narrated: segments.some((s) => s.narrated),
			captions: captionsBurned,
			file: finalFile,
			bytes: statSync(absFinal).size,
			durationSeconds: await probeDurationSeconds(absFinal, opts.ffmpegPath),
			segments: segments.length,
			music: opts.music && hasVoice,
			sfx: opts.sfx,
			hook: segments.some((s) => s.kind === "title" && s.narrated),
			outro: segments.some((s) => s.kind === "outro"),
			...(lufs !== undefined ? { loudnessLufs: lufs } : {}),
			...(captureOffset > 0 ? { captureOffsetSeconds: captureOffset, rawDurationSeconds: rawDuration } : {}),
			...(truncatedAt ? { truncatedAt } : {}),
		};
		writeFileAtomic(join(opts.workspace, "video", "video.json"), JSON.stringify(report, null, 2) + "\n");
		// series.json is the durable per-flow map the index operation reads:
		// merging (not overwriting) is what lets each flow re-assemble alone.
		const series = readSeries(opts.workspace);
		series.flows[opts.flow.id] = report;
		writeFileAtomic(join(opts.workspace, "video", "series.json"), JSON.stringify(series, null, 2) + "\n");
		return { ok: true, value: report };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Re-exported for the tool layer: ffprobe path helper. */
export { ffprobePathOf };

/**
 * One line of an ffmpeg `concat` list.
 *
 * Only the BASENAME is written: the demuxer resolves a relative name against the
 * directory of the list file itself (verified against ffmpeg 7 — a list in
 * `/tmp/d` run from cwd `/` still found its siblings), and the list is written
 * beside the segments it names. Absolute paths are the cross-platform trap this
 * avoids: on Windows a backslash is an ESCAPE inside the quoted name and `C:` is
 * parsed as a PROTOCOL. That is a defect only a Windows runner could observe, and
 * until now none did.
 */
export function concatEntry(file: string): string {
	// Separator-agnostic on purpose: `path.basename` follows the RUNNING platform,
	// so on Linux it would keep a Windows path whole (and write the trap back into
	// the list). The codebase already splits /[\\/]/ for the same reason in
	// video-voice.ts.
	const name = file.split(/[\\/]/).pop() ?? file;
	return `file '${name.replace(/'/g, "'\\''")}'`;
}
