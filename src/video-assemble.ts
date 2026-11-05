/**
 * video-assemble.ts — ensambla el video final con ffmpeg.
 *
 * Inputs: the storyboard flow + capture.json (schema /2, with the recording
 * and per-step timestamps) + the voice report (optional — a silent video is
 * valid). Pipeline per step: cut the raw webm by timestamps, freeze the last
 * frame until the narration fits (`tpad=stop_mode=clone`), reencode to a
 * uniform h264/yuv420p/25fps, concat, then mux the voice track (narrations +
 * silences). SRT + VTT captions are ALWAYS derived (deterministic, no ffmpeg
 * needed to compute them) — they are also the export path to external video
 * platforms. Burning them in (drawtext) is opt-in and font-dependent.
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
import type { Flow } from "./manual-model.js";
import type { CaptureReport } from "./manual-capture.js";
import type { RpcResult } from "./manual-capture.js";
import { ffprobePathOf, probeDurationSeconds, readVoiceReport } from "./video-voice.js";

const FIXED_DWELL_SECONDS = 2.5;
/** Shortest window read from the raw recording (one step can beat one frame). */
const MIN_CUT_SECONDS = 0.5;
/** Trim the tail of a window: the next step starts painting on its first frame. */
const CUT_GUARD_SECONDS = 0.12;
/** For a `goto`, keep only this much of the window before its held end state. */
const NAV_TAIL_SECONDS = 0.9;
/** Voice tail after the last word, so a step never cuts the audio. */
const VOICE_TAIL_SECONDS = 0.35;

/** Common font files for the burned-in captions and pills (regular first). */
const FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/TTF/DejaVuSans.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
	"C:\\Windows\\Fonts\\arial.ttf",
	"/System/Library/Fonts/Supplemental/Arial.ttf",
];

/** Bold faces for the chapter pill, the hook title and the outro pill. */
const BOLD_FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
	"C:\\Windows\\Fonts\\arialbd.ttf",
	"/System/Library/Fonts/Supplemental/Arial Bold.ttf",
	...FONT_CANDIDATES,
];

const firstExisting = (paths: string[]): string | undefined => paths.find((f) => existsSync(f));

export interface VideoSegment {
	stepId: string;
	/** Where the segment sits in the video's arc (hook → steps → outro). */
	kind: "hook" | "step" | "outro";
	/** The capture step kind (goto/click/highlight/…) — drives the SFX pick. */
	stepKind?: string;
	/** The narration sentence, or null for a silent step. */
	text: string | null;
	/** Where the step starts inside the raw recording. */
	cutStartSeconds: number;
	cutEndSeconds: number;
	/** How long the segment holds in the final video (>= narration). */
	targetSeconds: number;
	narrated: boolean;
	/** Element the step acted on (CSS px of the 1440x900 viewport): zoom target. */
	focus?: { x: number; y: number; w: number; h: number };
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
	/** Why burned-in captions were skipped although they were asked for. */
	captionsNote?: string;
	/** Integrated loudness of the final audio (ffmpeg ebur128), when measured. */
	loudnessLufs?: number;
	/** The assembly carried a ducking music bed. */
	music: boolean;
	/** The assembly carried synthesized UI sfx. */
	sfx: boolean;
	/** The video opens with a narrated hook card. */
	hook: boolean;
	/** The video closes with a narrated outro card. */
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
	/** Burn the captions in (drawtext). Default true at the tool layer. */
	captions: boolean;
	/** Flow title for the hook card (flow.title from the caller). */
	title: string;
	/** Chapter pill text ("NN · Group — Title") for the first seconds. */
	chapterLabel?: string;
	/** Title of the NEXT series video — paints the outro's "next" pill. */
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

/** Wrap a caption to at most two lines of ~`max` characters (… when cut). */
export function wrapCaption(text: string, max = 42): string {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let cur = "";
	let i = 0;
	for (; i < words.length; i += 1) {
		const w = words[i] as string;
		if (cur !== "" && `${cur} ${w}`.length > max) {
			lines.push(cur);
			cur = w;
			if (lines.length === 1) {
				// last line: fill it, then stop — the rest is dropped
				const rest = [cur, ...words.slice(i + 1)].join(" ");
				cur = rest;
				break;
			}
		} else {
			cur = cur === "" ? w : `${cur} ${w}`;
		}
	}
	if (cur !== "") {
		if (lines.length === 1 && cur.length > max) {
			lines.push(`${cur.slice(0, Math.max(0, max - 1)).trimEnd()}…`);
		} else if (lines.length === 1) {
			lines.push(cur);
		} else {
			lines.push(cur.length > max ? `${cur.slice(0, Math.max(0, max - 1)).trimEnd()}…` : cur);
		}
	}
	return lines.slice(0, 2).join("\n");
}

/** "Next" pill label per storyboard language (English fallback). */
const NEXT_WORD: Record<string, string> = { es: "Siguiente", en: "Next", pt: "Próximo", fr: "Suivant" };

/**
 * The per-segment zoompan graph: `pzoom` carries the previous output zoom so
 * the push is CONTINUOUS over video input (zoompan resets `zoom` per input
 * frame — the classic jitter trap, verified on ffmpeg 7.1). The crop is
 * clamped inside the frame around the focus point.
 */
function zoomFilter(seg: VideoSegment): string {
	const maxZ = seg.focus ? 1.15 : 1.04;
	const frames = Math.max(1, Math.round(seg.targetSeconds * 25));
	const rate = ((maxZ - 1) / frames).toFixed(6);
	const fx = seg.focus ? seg.focus.x + seg.focus.w / 2 : 720;
	const fy = seg.focus ? seg.focus.y + seg.focus.h / 2 : 450;
	return (
		`zoompan=z='min(pzoom+${rate},${maxZ})'` +
		`:x='max(0,min(iw-iw/zoom,${fx.toFixed(1)}-iw/zoom/2))'` +
		`:y='max(0,min(ih-ih/zoom,${fy.toFixed(1)}-ih/zoom/2))'` +
		`:d=1:s=1440x900:fps=25`
	);
}

/** Quote a filesystem path for a filter option (drawtext fontfile/textfile). */
const fq = (p: string): string => `'${p.replace(/([:'\\])/g, "\\$1")}'`;

/**
 * SFX definition per capture step kind, as a lavfi source + per-segment
 * delay. All synthesized — no third-party assets, fully deterministic.
 * `ms` is when the sound lands inside the segment.
 */
function sfxFor(seg: VideoSegment): { src: string; filters: string; delayMs: number } | null {
	const k = seg.kind === "hook" || seg.kind === "outro" ? "whoosh" : (seg.stepKind ?? "");
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

	// Segments: OK steps with timestamps, in order; truncate at the first failure.
	const voice = readVoiceReport(opts.workspace, opts.flow.id);
	const voiceByStep = new Map((voice?.items ?? []).map((i) => [i.stepId, i]));
	const segments: VideoSegment[] = [];
	let truncatedAt: string | undefined;
	for (const step of capture.steps) {
		if (step.status !== "ok" || step.startMs === undefined || step.endMs === undefined) {
			truncatedAt = step.id;
			break;
		}
		if (videoTime(step.startMs) >= videoLimit) {
			// The step happened after the recording stopped: nothing to show.
			truncatedAt = step.id;
			break;
		}
		const v = voiceByStep.get(step.id);
		const sentence = opts.flow.steps.find((s) => s.id === step.id)?.procedure ?? null;
		const text = sentence !== null && String(sentence).trim() !== "" ? String(sentence).replace(/\s+/g, " ").trim() : null;
		const narrated = Boolean(v && text !== null);
		const target = narrated ? (v?.durationSeconds ?? FIXED_DWELL_SECONDS) + VOICE_TAIL_SECONDS : FIXED_DWELL_SECONDS;
		const windowStart = videoTime(step.startMs);
		const windowEnd = Math.min(videoLimit, Math.max(windowStart + MIN_CUT_SECONDS, videoTime(step.endMs) - CUT_GUARD_SECONDS));
		// A `goto` spends its window loading: the first frames are the blank shell
		// (or the page being left). Only its tail — the mounted view held by the
		// recording dwell — is worth showing, so the video never opens on white.
		const cutStart =
			step.kind === "goto"
				? Math.max(windowStart, windowEnd - NAV_TAIL_SECONDS)
				: windowStart;
		segments.push({
			stepId: step.id,
			kind: "step",
			stepKind: step.kind,
			text,
			cutStartSeconds: cutStart,
			// A real step can finish inside one frame (<40 ms). Reading less than
			// MIN_CUT_SECONDS leaves the encoder nothing to show, so extend the
			// window forward: the state AFTER the step is the one being narrated.
			cutEndSeconds: windowEnd,
			targetSeconds: target,
			narrated,
			focus: step.focus,
		});
	}
	if (segments.length === 0) {
		return { ok: false, error: `no capturable step survived in capture.json (first failure: ${truncatedAt ?? "none"}) — nothing to assemble.` };
	}

	// The arc's bookends. The hook FREEZES the tail of the screen it talks
	// about (`hook.showStep`, or the last OK step) for the length of its
	// narration; the outro freezes the final frame for its closing line.
	// Both only exist when their voice was generated — a hook text without
	// _hook.wav stays a lint finding, not a silent title card.
	const voiceFileExists = (stepId: string): boolean => {
		const item = voiceByStep.get(stepId);
		return Boolean(item && existsSync(join(opts.workspace, item.file)));
	};
	const hookText = (opts.flow.hook?.text ?? "").trim();
	if (hookText !== "" && voiceFileExists("_hook")) {
		const showId = opts.flow.hook?.showStep;
		const base = (showId !== undefined ? segments.find((s) => s.stepId === showId) : undefined) ?? segments[segments.length - 1];
		const hookVoice = voiceByStep.get("_hook");
		segments.unshift({
			stepId: "_hook",
			kind: "hook",
			text: hookText,
			cutStartSeconds: Math.max(0, (base?.cutEndSeconds ?? 0) - 1.5),
			cutEndSeconds: base?.cutEndSeconds ?? 0.5,
			targetSeconds: (hookVoice?.durationSeconds ?? FIXED_DWELL_SECONDS) + VOICE_TAIL_SECONDS,
			narrated: true,
		});
	}
	const outroText = (opts.flow.outro?.text ?? "").trim();
	if (outroText !== "" && voiceFileExists("_outro")) {
		const last = segments[segments.length - 1];
		const outroVoice = voiceByStep.get("_outro");
		segments.push({
			stepId: "_outro",
			kind: "outro",
			text: outroText,
			cutStartSeconds: Math.max(0, (last?.cutEndSeconds ?? 0.5) - 0.5),
			cutEndSeconds: last?.cutEndSeconds ?? 0.5,
			targetSeconds: (outroVoice?.durationSeconds ?? FIXED_DWELL_SECONDS) + VOICE_TAIL_SECONDS,
			narrated: true,
		});
	}

	const tmp = join(opts.workspace, "video", "tmp", opts.flow.id);
	mkdirSync(tmp, { recursive: true });
	const outDir = join(opts.workspace, "video");
	mkdirSync(outDir, { recursive: true });

	let captionsBurned = false;
	let captionsNote: string | undefined;
	let fontFile: string | undefined;
	if (opts.captions) {
		fontFile = firstExisting(FONT_CANDIDATES);
		if (!fontFile) captionsNote = "captions were NOT burned in: no known font file found (DejaVu/Liberation/Arial) — the .srt/.vtt still ship.";
	}
	const boldFont = firstExisting(BOLD_FONT_CANDIDATES) ?? fontFile;

	const videoList: string[] = [];
	const audioList: string[] = [];
	try {
		let index = 0;
		for (const seg of segments) {
			const tag = String(index).padStart(3, "0");
			const segFile = join(tmp, `seg-${tag}.mp4`);
			const cutDuration = seg.cutEndSeconds - seg.cutStartSeconds;
			const pad = Math.max(0, seg.targetSeconds - cutDuration);
			const segDur = cutDuration + pad;
			// Video: cut → freeze the last frame → the zoompan push → overlays.
			// Uniform reencode so the concat demuxer can stream-copy later.
			const filters = [`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`, zoomFilter(seg)];
			if (index === 0 && opts.chapterLabel && boldFont) {
				const f = join(tmp, `chapter-${tag}.txt`);
				writeFileSync(f, opts.chapterLabel, { mode: 0o600 });
				filters.push(
					`drawtext=fontfile=${fq(boldFont)}:textfile=${fq(f)}:fontsize=20:fontcolor=white` +
						":box=1:boxcolor=black@0.55:boxborderw=10:x=18:y=18" +
						":alpha='if(lt(t,2.4),1,max(0,1-(t-2.4)/0.6))':enable='lt(t,3)'",
				);
			}
			if (seg.kind === "hook" && boldFont) {
				const f = join(tmp, `title-${tag}.txt`);
				writeFileSync(f, opts.title, { mode: 0o600 });
				filters.push(
					`drawtext=fontfile=${fq(boldFont)}:textfile=${fq(f)}:fontsize=48:fontcolor=white` +
						":borderw=2:bordercolor=black@0.7:x=(w-text_w)/2:y=h*0.16" +
						":alpha='min(1,t/0.5)'",
				);
			}
			if (seg.kind === "outro" && opts.nextTitle && boldFont) {
				const lang = (opts.language ?? "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
				const f = join(tmp, `next-${tag}.txt`);
				writeFileSync(f, `${NEXT_WORD[lang] ?? NEXT_WORD["en"]}: ${opts.nextTitle}`, { mode: 0o600 });
				filters.push(
					`drawtext=fontfile=${fq(boldFont)}:textfile=${fq(f)}:fontsize=28:fontcolor=white` +
						":box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-150" +
						":alpha='min(1,t/0.5)'",
				);
			}
			if (opts.captions && fontFile && seg.text !== null) {
				const textFile = join(tmp, `cap-${tag}.txt`);
				writeFileSync(textFile, wrapCaption(seg.text), { mode: 0o600 });
				// Bottom by default; when the focus lives in the bottom third the
				// pill would sit ON it, so the caption moves up.
				const focusBottom = seg.focus !== undefined && seg.focus.y + seg.focus.h / 2 > (900 * 2) / 3;
				const y = focusBottom ? "70" : "h-th-70";
				const fadeEnd = Math.max(0.5, segDur - 0.3).toFixed(3);
				filters.push(
					`drawtext=fontfile=${fq(fontFile)}:textfile=${fq(textFile)}:fontsize=30:fontcolor=white` +
						`:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=${y}` +
						`:alpha='if(lt(t,0.3),t/0.3,if(gt(t,${fadeEnd}),max(0,(${segDur.toFixed(3)}-t)/0.3),1))'`,
				);
				captionsBurned = true;
			}
			// `-t` MUST be an INPUT option here (before -i): as an output option
			// it also caps the frames tpad appends, cutting the freeze short and
			// leaving the narration hanging over a shorter clip.
			const v = await runFfmpeg(opts.ffmpegPath, [
				"-y", "-loglevel", "error",
				"-ss", seg.cutStartSeconds.toFixed(3), "-t", cutDuration.toFixed(3), "-i", rawPath,
				"-vf", filters.join(","),
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
			hook: segments.some((s) => s.kind === "hook"),
			outro: segments.some((s) => s.kind === "outro"),
			...(lufs !== undefined ? { loudnessLufs: lufs } : {}),
			...(captureOffset > 0 ? { captureOffsetSeconds: captureOffset, rawDurationSeconds: rawDuration } : {}),
			...(truncatedAt ? { truncatedAt } : {}),
			...(captionsNote ? { captionsNote } : {}),
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
