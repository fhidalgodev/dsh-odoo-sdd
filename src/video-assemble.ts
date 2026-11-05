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
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic } from "./atomic.js";
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

/** Common font files for the optional burned-in captions. */
const FONT_CANDIDATES = [
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/TTF/DejaVuSans.ttf",
	"/usr/share/fonts/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
	"C:\\Windows\\Fonts\\arial.ttf",
	"/System/Library/Fonts/Supplemental/Arial.ttf",
];

export interface VideoSegment {
	stepId: string;
	/** The narration sentence, or null for a silent step. */
	text: string | null;
	/** Where the step starts inside the raw recording. */
	cutStartSeconds: number;
	cutEndSeconds: number;
	/** How long the segment holds in the final video (>= narration). */
	targetSeconds: number;
	narrated: boolean;
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

/** SRT entries: one per narrated step, positioned by the segment timeline. */
export function buildSrt(segments: VideoSegment[]): string {
	const lines: string[] = [];
	let index = 1;
	let cursor = 0;
	for (const seg of segments) {
		const start = cursor;
		const end = cursor + seg.targetSeconds;
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
	/** Burn the captions in (drawtext). Default false — SRT/VTT always ship. */
	captions: boolean;
}

/**
 * Assemble ONE flow into video/<flow>.mp4 + .srt + .vtt + video.json.
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
			text,
			cutStartSeconds: cutStart,
			// A real step can finish inside one frame (<40 ms). Reading less than
			// MIN_CUT_SECONDS leaves the encoder nothing to show, so extend the
			// window forward: the state AFTER the step is the one being narrated.
			cutEndSeconds: windowEnd,
			targetSeconds: target,
			narrated,
		});
	}
	if (segments.length === 0) {
		return { ok: false, error: `no capturable step survived in capture.json (first failure: ${truncatedAt ?? "none"}) — nothing to assemble.` };
	}

	const tmp = join(opts.workspace, "video", "tmp", opts.flow.id);
	mkdirSync(tmp, { recursive: true });
	const outDir = join(opts.workspace, "video");
	mkdirSync(outDir, { recursive: true });

	let captionsBurned = false;
	let captionsNote: string | undefined;
	let fontFile: string | undefined;
	if (opts.captions) {
		fontFile = FONT_CANDIDATES.find((f) => existsSync(f));
		if (!fontFile) captionsNote = "captions were NOT burned in: no known font file found (DejaVu/Liberation/Arial) — the .srt/.vtt still ship.";
	}

	const videoList: string[] = [];
	const audioList: string[] = [];
	try {
		let index = 0;
		for (const seg of segments) {
			const tag = String(index).padStart(3, "0");
			const segFile = join(tmp, `seg-${tag}.mp4`);
			const cutDuration = seg.cutEndSeconds - seg.cutStartSeconds;
			const pad = Math.max(0, seg.targetSeconds - cutDuration);
			// Video: cut, freeze the last frame to fill the narration, uniform
			// reencode so the concat demuxer can stream-copy later.
			const filters = [`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`];
			if (opts.captions && fontFile && seg.text !== null) {
				const textFile = join(tmp, `cap-${tag}.txt`);
				writeFileSync(textFile, seg.text, { mode: 0o600 });
				filters.push(
					`drawtext=fontfile='${fontFile.replace(/([:'\\])/g, "\\$1")}':textfile='${textFile.replace(/([:'\\])/g, "\\$1")}'` +
						":fontsize=26:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-th-40",
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

			// Audio: the narration padded to the target, or pure silence.
			const audioFile = join(tmp, `aud-${tag}.m4a`);
			const voiceItem = seg.narrated ? voiceByStep.get(seg.stepId) : undefined;
			if (voiceItem && existsSync(join(opts.workspace, voiceItem.file))) {
				const a = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					"-i", join(opts.workspace, voiceItem.file),
					"-af", "apad", "-t", seg.targetSeconds.toFixed(3),
					"-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
					audioFile,
				]);
				if (!a.ok) return { ok: false, error: `audio for ${seg.stepId}: ${a.error}` };
			} else {
				const a = await runFfmpeg(opts.ffmpegPath, [
					"-y", "-loglevel", "error",
					"-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
					"-t", seg.targetSeconds.toFixed(3),
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

		const langTag = (opts.language ?? "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
		const finalFile = join("video", `${opts.flow.id}.mp4`);
		const m = await runFfmpeg(opts.ffmpegPath, [
			"-y", "-loglevel", "error",
			"-i", videoOnly, "-i", audioOnly,
			"-map", "0:v:0", "-map", "1:a:0",
			"-c:v", "copy", "-c:a", "copy",
			"-metadata:s:a:0", `language=${langTag}`,
			"-movflags", "+faststart", "-shortest",
			join(opts.workspace, finalFile),
		]);
		if (!m.ok) return { ok: false, error: `final mux: ${m.error}` };

		// Captions ALWAYS ship (they are also the export path for platforms).
		writeFileAtomic(join(opts.workspace, "video", `${opts.flow.id}.srt`), buildSrt(segments));
		writeFileAtomic(join(opts.workspace, "video", `${opts.flow.id}.vtt`), buildVtt(segments));

		const absFinal = join(opts.workspace, finalFile);
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
			...(captureOffset > 0 ? { captureOffsetSeconds: captureOffset, rawDurationSeconds: rawDuration } : {}),
			...(truncatedAt ? { truncatedAt } : {}),
			...(captionsNote ? { captionsNote } : {}),
		};
		writeFileAtomic(join(opts.workspace, "video", "video.json"), JSON.stringify(report, null, 2) + "\n");
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
