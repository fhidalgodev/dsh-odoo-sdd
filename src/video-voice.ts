/**
 * video-voice.ts — narración TTS conectable para los videos.
 *
 * The engine is an EXTERNAL command the developer configures (`ttsCommand`),
 * executed with spawn WITHOUT a shell: the template is split into argv and
 * the narration text travels as ONE argument or a temp file — it is never
 * interpolated into a shell string. Supported placeholders:
 *   {text}     one argv with the narration sentence
 *   {textFile} a UTF-8 file with the sentence (long texts, piper-style CLIs)
 *   {voice}    the resolved voice string (engine-specific naming)
 *   {out}      the .wav path the command must write
 *
 * Voice resolution (video contract): call param > ttsVoice config >, when the
 * template uses {voice}, NEEDS_TTS with per-language example voices.
 */

import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic } from "./atomic.js";
import { posixPath } from "./paths.js";
import { listVoicePresets } from "./video-voices.js";
import type { Flow } from "./manual-model.js";
import type { RpcResult } from "./manual-capture.js";

/** Example voices per language prefix, for the NEEDS_TTS remediation. */
const VOICE_EXAMPLES: Record<string, { piper: string; edge: string; label: string }> = {
	es: { piper: "es_ES-sharvard-medium", edge: "es-ES-ÁlvaroNeural", label: "Spanish" },
	en: { piper: "en_US-lessac-medium", edge: "en-US-GuyNeural", label: "English" },
	pt: { piper: "pt_BR-faber-medium", edge: "pt-BR-AntonioNeural", label: "Portuguese" },
	fr: { piper: "fr_FR-siwis-medium", edge: "fr-FR-DeniseNeural", label: "French" },
};

function languagePrefix(language: string | undefined): string {
	const lang = (language ?? "en").trim();
	return (lang.split(/[-_]/)[0] ?? "en").toLowerCase();
}

/** Per-language example voices for the remediation text (never a guess used silently). */
export function voiceExamples(language: string | undefined): string[] {
	const ex = VOICE_EXAMPLES[languagePrefix(language)];
	if (!ex) return ["(no bundled example for this language — list voices with your TTS engine and set ttsVoice)"];
	return [`piper-tts (offline): ${ex.piper}`, `edge-tts (cloud — sends the text to Microsoft): ${ex.edge}`];
}

/**
 * The NEEDS_TTS text, shared by voiceFlow and the tool layer (which resolves
 * the engine before calling). It lists every preset with the concrete voice
 * it would use for this language — recommended first — so the answer to "no
 * voice configured" is a choice, not a chore. The privacy line is part of the
 * contract: cloud presets send the narration text to Microsoft, and picking
 * one IS the developer's explicit decision.
 */
export function needsTtsMessage(language: string | undefined): string {
	const presets = listVoicePresets(language)
		.map(
			({ preset, voice }) =>
				`  - ${preset.id}${preset.recommended ? " (recommended)" : ""} [${preset.cloud ? "cloud" : "offline"}]${preset.gender ? ` ${preset.gender}` : ""} ${preset.style}: ${voice ?? preset.note}`,
		)
		.join("\n");
	return (
		"NEEDS_TTS — no voice engine is configured. Pick a voice preset (config key ttsPreset) or set a custom ttsCommand " +
		"(config key ttsCommand / env ODOO_SDD_TTS_CMD) with the placeholders {text}/{textFile}/{voice}/{out}.\n" +
		`Voice presets for this script's language:\n${presets}\n` +
		`Custom-engine example voices for this language: ${voiceExamples(language).join(" · ")}.\n` +
		"Privacy: the cloud presets send the narration text to Microsoft — choosing one is the developer's explicit decision. " +
		"The offline preset (piper) keeps the text on this machine and needs ttsVoice set to a .onnx model file."
	);
}

/**
 * Split a command template into argv WITHOUT a shell. Double-quoted segments
 * keep their spaces (paths like "C:\My Models\voice.onnx"); the quotes are
 * removed. Placeholders ({text}, {voice}, …) must be standalone tokens.
 */
export function splitTemplate(template: string): string[] {
	const argv: string[] = [];
	let cur = "";
	let quoted = false;
	let has = false;
	for (const ch of template) {
		if (ch === '"') {
			quoted = !quoted;
			has = true;
		} else if (ch === " " && !quoted) {
			if (has) argv.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) argv.push(cur);
	return argv;
}

export interface VoiceRun {
	ok: boolean;
	stderr: string;
}

/** Run the TTS command for one sentence. No shell, ever. */
export async function runTtsCommand(argv: string[], timeoutMs = 60_000): Promise<VoiceRun> {
	return new Promise((resolvePromise) => {
		const child = spawn(argv[0], argv.slice(1), { shell: false });
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolvePromise({ ok: false, stderr: `${e.message} — is the TTS command installed and on PATH?` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ ok: code === 0, stderr });
		});
	});
}

/** ffprobe lives next to ffmpeg: same dir, ffmpeg → ffprobe. */
export function ffprobePathOf(ffmpegPath: string): string {
	if (ffmpegPath === "ffmpeg") return "ffprobe";
	const parts = ffmpegPath.split(/[\\/]/);
	parts[parts.length - 1] = parts[parts.length - 1].replace(/^ffmpeg(\.exe)?$/, "ffprobe$1");
	return parts.join("/");
}

/** Duration of an audio/video file via ffprobe; null when it cannot be probed. */
export async function probeDurationSeconds(file: string, ffmpegPath: string): Promise<number | null> {
	const run = await new Promise<{ code: number | null; out: string }>((resolvePromise) => {
		const child = spawn(ffprobePathOf(ffmpegPath), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { shell: false });
		let out = "";
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.on("error", () => resolvePromise({ code: null, out: "" }));
		child.on("close", (code) => resolvePromise({ code, out }));
	});
	const value = Number.parseFloat(run.out.trim());
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** Read the first `n` bytes of a file without loading it whole. */
function fileHead(file: string, n: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(n);
		const got = readSync(fd, buf, 0, n, 0);
		return buf.subarray(0, got);
	} finally {
		closeSync(fd);
	}
}

/**
 * edge-tts writes an MP3 even when the output is named `.wav` — it only works
 * downstream because ffmpeg sniffs content. The voice directory, however, is
 * also read directly (durations, exports), so a non-RIFF file is normalized to
 * a REAL WAV (mono 24 kHz, enough for narration) through ffmpeg, written to a
 * sibling temp and renamed into place so a crash never leaves a half file.
 */
async function ensureWavFile(file: string, ffmpegPath: string): Promise<RpcResult<{ transcoded: boolean }>> {
	if (fileHead(file, 4).toString("ascii") === "RIFF") return { ok: true, value: { transcoded: false } };
	const tmp = `${file}.transcode.wav`;
	const run = await runTtsCommand([ffmpegPath, "-y", "-loglevel", "error", "-i", file, "-ar", "24000", "-ac", "1", tmp]);
	if (!run.ok || !existsSync(tmp)) {
		rmSync(tmp, { force: true });
		return {
			ok: false,
			error: `the TTS output was not a WAV and ffmpeg could not transcode it: ${run.stderr.slice(-400) || "(no stderr)"}. Check ffmpegPath.`,
		};
	}
	// Sibling temp + rename: readers see the old MP3 or the new WAV, never a
	// half-transcoded file.
	renameSync(tmp, file);
	return { ok: true, value: { transcoded: true } };
}

export interface VoiceItem {
	stepId: string;
	file: string;
	bytes: number;
	durationSeconds: number | null;
}

export interface VoiceReport {
	schema: "dsh-odoo-sdd/voice/1";
	flow: string;
	voice: string | null;
	language: string | undefined;
	generatedAt: string;
	items: VoiceItem[];
}

export interface VoiceOptions {
	workspace: string;
	flow: Flow;
	language?: string;
	/** Resolved `ttsCommand` (config or env); null → NEEDS_TTS. */
	ttsCommand: string | null;
	/** Call param if given, else the `ttsVoice` config; null allowed when the template has no {voice}. */
	voice: string | null;
	ffmpegPath: string;
}

/**
 * Narrate ONE flow: one .wav per step that has a procedure sentence. Steps
 * without narration are skipped here (the assembler gives them the fixed
 * dwell) and existing .wav files are NOT regenerated (delete a .wav to redo
 * it). Writes voice/<flow>/<step>.wav + voice/<flow>/voice.json.
 */
export async function voiceFlow(opts: VoiceOptions): Promise<RpcResult<VoiceReport>> {
	if (!opts.ttsCommand || opts.ttsCommand.trim() === "") {
		return { ok: false, errorKind: "needs_tts", error: needsTtsMessage(opts.language) };
	}
	const argvTemplate = splitTemplate(opts.ttsCommand);
	if (argvTemplate.length === 0) return { ok: false, error: "ttsCommand is empty after parsing" };
	const usesVoice = argvTemplate.some((a) => a === "{voice}");
	if (usesVoice && (opts.voice === null || opts.voice.trim() === "")) {
		return {
			ok: false,
			errorKind: "needs_tts",
			error:
				"NEEDS_TTS — the ttsCommand uses {voice} but no voice is set (call param voice, or config ttsVoice / env ODOO_SDD_TTS_VOICE). " +
				`The voice string is engine-specific. Examples for language ${opts.language ?? "(unset)"}: ${voiceExamples(opts.language).join(" · ")}`,
		};
	}
	const voice = usesVoice ? opts.voice : null;

	const flowDir = join(opts.workspace, "voice", opts.flow.id);
	mkdirSync(flowDir, { recursive: true });
	const report: VoiceReport = {
		schema: "dsh-odoo-sdd/voice/1",
		flow: opts.flow.id,
		voice,
		language: opts.language,
		generatedAt: new Date().toISOString(),
		items: [],
	};

	// The script is not only the steps: the cold-open hook is narrated FIRST
	// (reserved stepId "_hook") and the closing line LAST ("_outro"), so the
	// assembler can lay each over its segment without inventing step ids.
	const script: Array<{ id: string; sentence: string | null | undefined }> = [
		{ id: "_hook", sentence: opts.flow.hook?.text },
		...opts.flow.steps.map((s) => ({ id: s.id, sentence: s.procedure })),
		{ id: "_outro", sentence: opts.flow.outro?.text },
	];
	for (const line of script) {
		const step = { id: line.id };
		const sentence = line.sentence;
		if (sentence === null || sentence === undefined || sentence.trim() === "") continue;
		const file = posixPath("voice", opts.flow.id, `${step.id}.wav`);
		const abs = join(opts.workspace, file);
		if (existsSync(abs)) {
			// Idempotent resume: an existing .wav is kept (delete it to redo).
			report.items.push({
				stepId: step.id,
				file,
				bytes: statSync(abs).size,
				durationSeconds: await probeDurationSeconds(abs, opts.ffmpegPath),
			});
			continue;
		}
		const text = sentence.replace(/\s+/g, " ").trim();
		let textFile: string | null = null;
		if (argvTemplate.some((a) => a === "{textFile}")) {
			textFile = `${abs}.txt`;
			writeFileSync(textFile, text, { mode: 0o600 });
		}
		const argv = argvTemplate.map((a) =>
			a === "{text}" ? text : a === "{textFile}" ? (textFile ?? text) : a === "{voice}" ? (voice ?? "") : a === "{out}" ? abs : a,
		);
		const run = await runTtsCommand(argv);
		// The sentence file is scaffolding: the .wav is the artifact, and a
		// stray .txt next to it would be committed by mistake.
		if (textFile !== null) rmSync(textFile, { force: true });
		if (!run.ok || !existsSync(abs)) {
			return {
				ok: false,
				error:
					`the TTS command failed for step ${step.id} (exit ${run.ok ? "0 without output" : "non-zero"}): ${run.stderr.slice(-500) || "(no stderr)"}. ` +
					`Check ttsCommand placeholders — the command must write exactly {out} (got: ${file}).`,
			};
		}
		const wav = await ensureWavFile(abs, opts.ffmpegPath);
		if (!wav.ok) return { ok: false, error: `step ${step.id}: ${wav.error}` };
		report.items.push({
			stepId: step.id,
			file,
			bytes: statSync(abs).size,
			durationSeconds: await probeDurationSeconds(abs, opts.ffmpegPath),
		});
	}

	writeFileAtomic(join(flowDir, "voice.json"), JSON.stringify(report, null, 2) + "\n");
	return { ok: true, value: report };
}

/** Read a persisted voice report (the assembler's input). */
export function readVoiceReport(workspace: string, flowId: string): VoiceReport | null {
	const file = join(workspace, "voice", flowId, "voice.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as VoiceReport;
	} catch {
		return null;
	}
}
