/**
 * tests/video.mjs — odoo_video unit layer: workspace rules, the video
 * storyboard lint, the manual import bridge, the TTS command plumbing (with a
 * deterministic silent-WAV stub) and the assembler against a FAKE ffmpeg
 * binary — no media processing, fully deterministic. The real-ffmpeg E2E runs
 * only when ffmpeg is on PATH and ODOO_SDD_REQUIRE_FFMPEG=1 (CI job).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
// import() needs a URL: a Windows drive path is not a valid specifier.
const libUrl = (name) => pathToFileURL(join(root, "lib", name)).href;
const vmodel = await import(libUrl("video-model.js"));
const vvoice = await import(libUrl("video-voice.js"));
const vassemble = await import(libUrl("video-assemble.js"));
const mmodel = await import(libUrl("manual-model.js"));

let passed = 0;
const check = (name, cond, extra) => {
	passed += 1;
	assert.ok(cond, extra ? `${name} — ${extra}` : name);
	console.log(`  PASS  ${name}`);
};
const SKIP = (name) => {
	console.log(`  SKIP  ${name}`);
	return "skipped";
};

const fx = fileURLToPath(new URL("fixtures", import.meta.url));
const silentTts = join(fx, "silent-tts.mjs");
const failTts = join(fx, "fail-tts.mjs");
// The fake binaries are spawned DIRECTLY (no shell): POSIX shebang only.
const fakeFfmpeg = join(fx, "fakebin", "ffmpeg");
const canFakeBin = process.platform !== "win32";

const ws = mkdtempSync(join(tmpdir(), "video-ws-"));
const rm = (p) => rmSync(p, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Workspace rules (video-model)
// ---------------------------------------------------------------------------
const proj = mkdtempSync(join(tmpdir(), "video-proj-"));
const wsr = vmodel.resolveVideoWorkspace({ projectRoot: proj, dir: "docs/videos", slug: "video-sale-order" });
check("resolveVideoWorkspace builds <videosDir>/<slug> inside the root", wsr.ok && wsr.dir === join(proj, "docs", "videos", "video-sale-order"), JSON.stringify(wsr));
check("resolveVideoWorkspace rejects an unsafe slug", !vmodel.resolveVideoWorkspace({ projectRoot: proj, dir: "docs/videos", slug: "../evil" }).ok);
check("resolveVideoWorkspace rejects a videosDir outside the root", !vmodel.resolveVideoWorkspace({ projectRoot: proj, dir: "/definitely/not/inside", slug: "v" }).ok);
rm(proj);

// ---------------------------------------------------------------------------
// Video storyboard lint — a tolerant subset of the manual lint
// ---------------------------------------------------------------------------
const sbOf = (flows, fingerprint = "fp1") => ({ schema: "dsh-odoo-sdd/manual/1", slug: "s", flows, canonFingerprint: fingerprint });
const canonSurface = { fingerprint: "fp1", model: "sale.order", actionXmlids: ["sale.action_quotations"], menuXmlids: ["sale.sale_menu_root"] };
const cleanFindings = vmodel.validateVideoStoryboard(
	sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "Open the quotations list.", target: { kind: "action", xmlid: "sale.action_quotations" } }] }]),
	canonSurface,
);
check("a bound storyboard produces no ERROR findings", cleanFindings.every((f) => f.severity !== "ERROR"), JSON.stringify(cleanFindings));
const rules = [
	["CANON-STALE is an ERROR", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "screenshot", procedure: null }] }], "fp0"), canonSurface)],
	["TARGET-UNKNOWN is an ERROR", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "X.", target: { kind: "action", xmlid: "sale.nope" } }] }]), canonSurface)],
	["FLOW-EMPTY is an ERROR", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [] }]), canonSurface)],
].map(([name, findings]) => [name, findings.find((f) => f.rule === name.split(" ")[0] && f.severity === "ERROR")]);
for (const [name, hit] of rules) check(`${name} when violated`, Boolean(hit));
check("SILENT-STEP is only a WARN", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "screenshot", procedure: null }] }], "fp0"), null).every((f) => f.rule !== "CANON-STALE"));
check("a null canon surface disables the fingerprint check", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "screenshot", procedure: null }] }]), null).every((f) => f.rule !== "CANON-STALE"));

// ---------------------------------------------------------------------------
// importFromManual — the manual → video bridge
// ---------------------------------------------------------------------------
const manualDir = join(ws, "manual");
mkdirSync(manualDir, { recursive: true });
writeFileSync(join(manualDir, "canon.json"), JSON.stringify({ schema: "dsh-odoo-sdd/canon/1", fingerprint: "fp1", model: "sale.order" }));
mmodel.writeStoryboard(manualDir, {
	schema: "dsh-odoo-sdd/manual/1",
	slug: "manual-sale",
	language: "es-ES",
	flows: [{ id: "f1", title: "Flujo", steps: [{ id: "s01", kind: "goto", procedure: "Abrimos la lista.", target: { kind: "action", xmlid: "sale.action_quotations" } }, { id: "s02", kind: "screenshot", procedure: null }] }],
});
const vidDir = join(ws, "video-import");
const imp = vmodel.importFromManual(manualDir, vidDir);
check(
	"importFromManual copies canon+storyboard and inherits the language",
	imp.ok && imp.value.language === "es-ES" && imp.value.flows === 1 && imp.value.steps === 2 && imp.value.narrated === 1 && existsSync(join(vidDir, "storyboard.json")) && existsSync(join(vidDir, "canon.json")),
	JSON.stringify(imp.ok ? imp.value : imp.error),
);
const noCanon = vmodel.importFromManual(join(ws, "empty"), join(ws, "video-x"));
check("importFromManual without a canon is blocked with a remedy", !noCanon.ok && /canon/.test(noCanon.error));

// ---------------------------------------------------------------------------
// TTS plumbing (video-voice)
// ---------------------------------------------------------------------------
check(
	"splitTemplate keeps quoted segments whole",
	JSON.stringify(vvoice.splitTemplate('edge-tts --voice "es ES X" --text {text} --write-media {out}')) === JSON.stringify(["edge-tts", "--voice", "es ES X", "--text", "{text}", "--write-media", "{out}"]),
);
check("ffprobePathOf derives ffprobe next to ffmpeg", vvoice.ffprobePathOf("ffmpeg") === "ffprobe" && vvoice.ffprobePathOf("C:\\tools\\ffmpeg.exe") === "C:/tools/ffprobe.exe");

const flowEs = {
	id: "f1",
	title: "Flujo",
	steps: [
		{ id: "s01", kind: "goto", procedure: "Abrimos la lista de cotizaciones.", target: { kind: "action", xmlid: "sale.action_quotations" } },
		{ id: "s02", kind: "screenshot", procedure: null },
	],
};
const noTts = await vvoice.voiceFlow({ workspace: ws, flow: flowEs, language: "es-ES", ttsCommand: null, voice: null, ffmpegPath: "ffprobe-none" });
check("voiceFlow without ttsCommand → NEEDS_TTS with placeholders and per-language examples", !noTts.ok && noTts.errorKind === "needs_tts" && noTts.error.includes("{out}") && noTts.error.includes("es_ES-sharvard-medium"), JSON.stringify(noTts));
const noVoice = await vvoice.voiceFlow({ workspace: ws, flow: flowEs, language: "es-ES", ttsCommand: `${process.execPath} ${silentTts} --voice {voice} --out {out} --text {text}`, voice: null, ffmpegPath: "ffprobe-none" });
check("a {voice} template without a voice → NEEDS_TTS naming example voices", !noVoice.ok && noVoice.errorKind === "needs_tts" && noVoice.error.includes("es-ES-"), JSON.stringify(noVoice));

const vw = join(ws, "voice-run");
const ttsCmd = `${process.execPath} ${silentTts} --voice {voice} --out {out} --text {text}`;
const vres = await vvoice.voiceFlow({ workspace: vw, flow: flowEs, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: canFakeBin ? fakeFfmpeg : "ffprobe-none" });
check("voiceFlow narrates every step WITH a procedure (silent steps skipped)", vres.ok && vres.value.items.length === 1 && vres.value.items[0].stepId === "s01", JSON.stringify(vres.ok ? vres.value.items : vres.error));
if (vres.ok) {
	const wavAbs = join(vw, vres.value.items[0].file);
	const buf = readFileSync(wavAbs);
	check("the stub wrote a real RIFF/WAVE file", buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE");
	check("voice.json carries schema/voice/language", vres.value.schema === "dsh-odoo-sdd/voice/1" && vres.value.voice === "es-ES-test" && vres.value.language === "es-ES");
	if (canFakeBin) check("duration comes from ffprobe when present", vres.value.items[0].durationSeconds === 3.5, JSON.stringify(vres.value.items[0]));
	const mtimeBefore = statSync(wavAbs).mtimeMs;
	const rerun = await vvoice.voiceFlow({ workspace: vw, flow: flowEs, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: canFakeBin ? fakeFfmpeg : "ffprobe-none" });
	check("existing .wav files are NOT regenerated (delete one to redo)", rerun.ok && statSync(wavAbs).mtimeMs === mtimeBefore);
}
const failed = await vvoice.voiceFlow({ workspace: join(ws, "voice-fail"), flow: flowEs, language: "es-ES", ttsCommand: `${process.execPath} ${failTts} {out} {text}`, voice: null, ffmpegPath: "ffprobe-none" });
check("a failing TTS command reports its stderr and the {out} contract", !failed.ok && /synthetic TTS failure/.test(failed.error) && /\{out\}/.test(failed.error));

// ---------------------------------------------------------------------------
// SRT / VTT timelines (video-assemble)
// ---------------------------------------------------------------------------
const segs = [
	{ stepId: "s01", text: "Hola mundo", cutStartSeconds: 0, cutEndSeconds: 2, targetSeconds: 2.85, narrated: true },
	{ stepId: "s02", text: null, cutStartSeconds: 2, cutEndSeconds: 4, targetSeconds: 2.5, narrated: false },
	{ stepId: "s03", text: "Fin del flujo", cutStartSeconds: 4, cutEndSeconds: 6, targetSeconds: 1.35, narrated: true },
];
const srt = vassemble.buildSrt(segs);
check(
	"SRT: one entry per narrated step, timeline includes silent steps",
	srt === "1\n00:00:00,000 --> 00:00:02,850\nHola mundo\n\n2\n00:00:05,350 --> 00:00:06,700\nFin del flujo\n",
	JSON.stringify(srt),
);
const vtt = vassemble.buildVtt(segs);
check("VTT: WEBVTT header and dot decimals", vtt.startsWith("WEBVTT\n\n") && vtt.includes("00:00:05.350 --> 00:00:06.700"));

// ---------------------------------------------------------------------------
// Assembler gates + happy path against the FAKE ffmpeg
// ---------------------------------------------------------------------------
const mkCaptureWs = () => {
	const w = mkdtempSync(join(tmpdir(), "video-asm-"));
	mkdirSync(join(w, "video", "raw"), { recursive: true });
	writeFileSync(join(w, "video", "raw", "f1.webm"), Buffer.from("FAKEWEBM"));
	return w;
};
const gates = await (async () => {
	const empty = mkdtempSync(join(tmpdir(), "video-empty-"));
	const noCapture = await vassemble.assembleVideo({ workspace: empty, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false });
	rm(empty);
	const schema1 = mkCaptureWs();
	writeFileSync(join(schema1, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/1", flow: "f1", steps: [] }));
	const noVideo = await vassemble.assembleVideo({ workspace: schema1, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false });
	rm(schema1);
	const otherFlow = mkCaptureWs();
	writeFileSync(join(otherFlow, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/2", flow: "f9", video: { file: "video/raw/f1.webm", bytes: 8 }, steps: [] }));
	const wrongFlow = await vassemble.assembleVideo({ workspace: otherFlow, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false });
	rm(otherFlow);
	const broken = mkCaptureWs();
	writeFileSync(join(broken, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/2", flow: "f1", video: { file: "video/raw/f1.webm", bytes: 8 }, steps: [{ id: "s01", kind: "goto", status: "ok", startMs: 100, endMs: 900 }] }));
	const noFfmpeg = await vassemble.assembleVideo({ workspace: broken, flow: flowEs, language: "es-ES", ffmpegPath: join(ws, "no", "ffmpeg"), captions: false });
	rm(broken);
	return { noCapture, noVideo, wrongFlow, noFfmpeg };
})();
check("assemble without capture.json → NEEDS_VIDEO_CAPTURE", !gates.noCapture.ok && gates.noCapture.errorKind === "needs_video_capture", JSON.stringify(gates.noCapture));
check("assemble from a capture/1 (no recording) → NEEDS_VIDEO_CAPTURE", !gates.noVideo.ok && gates.noVideo.errorKind === "needs_video_capture", JSON.stringify(gates.noVideo));
check("assemble from another flow's capture → NEEDS_VIDEO_CAPTURE", !gates.wrongFlow.ok && gates.wrongFlow.errorKind === "needs_video_capture", JSON.stringify(gates.wrongFlow));
check("assemble with a broken ffmpeg → NEEDS_FFMPEG", !gates.noFfmpeg.ok && gates.noFfmpeg.errorKind === "needs_ffmpeg", JSON.stringify(gates.noFfmpeg));

if (canFakeBin) {
	const aw = mkCaptureWs();
	// s01 ok narrated, s02 ok silent, s03 ERROR → the video truncates at s03.
	writeFileSync(
		join(aw, "capture.json"),
		JSON.stringify({
			schema: "dsh-odoo-sdd/capture/2",
			flow: "f1",
			video: { file: "video/raw/f1.webm", bytes: 8 },
			steps: [
				{ id: "s01", kind: "goto", status: "ok", startMs: 500, endMs: 2500 },
				{ id: "s02", kind: "screenshot", status: "ok", startMs: 2600, endMs: 4000 },
				{ id: "s03", kind: "click", status: "error", error: "boom" },
			],
		}),
	);
	const flowThree = { ...flowEs, steps: [...flowEs.steps, { id: "s03", kind: "click", procedure: "Nunca llega.", field: "x" }] };
	const narrated = await vvoice.voiceFlow({ workspace: aw, flow: flowThree, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: fakeFfmpeg });
	check("voice over the assemble workspace prepared 2 narrations", narrated.ok && narrated.value.items.length === 2, JSON.stringify(narrated.ok ? narrated.value.items : narrated.error));
	const ares = await vassemble.assembleVideo({ workspace: aw, flow: flowThree, language: "es-ES", ffmpegPath: fakeFfmpeg, captions: false });
	check("assemble succeeds against the fake ffmpeg", ares.ok, JSON.stringify(ares.ok ? ares.value : ares.error));
	if (ares.ok) {
		check("the video truncates at the failed step and keeps prior segments", ares.value.truncatedAt === "s03" && ares.value.segments === 2 && ares.value.narrated === true);
		const mp4Abs = join(aw, ares.value.file);
		check("video/f1.mp4 exists (fake ffmpeg wrote it)", existsSync(mp4Abs) && readFileSync(mp4Abs).toString("ascii").startsWith("FAKE"));
		const srtText = readFileSync(join(aw, "video", "f1.srt"), "utf8");
		check("the SRT always ships with the narrated steps", srtText.includes("Abrimos la lista") && srtText.includes("00:00:00,000"));
		check("video.json records the video schema with language/voice", (() => {
			const report = JSON.parse(readFileSync(join(aw, "video", "video.json"), "utf8"));
			return report.schema === "dsh-odoo-sdd/video/1" && report.language === "es-ES" && report.voice === "es-ES-test" && report.truncatedAt === "s03";
		})());
		check("the tmp segment dir is cleaned", !existsSync(join(aw, "video", "tmp", "f1")));
		check("the raw webm is kept for re-assembly", existsSync(join(aw, "video", "raw", "f1.webm")));
	}
	rm(aw);
} else {
	SKIP("fake-ffmpeg assemble happy path (POSIX-only fake binaries)");
}

// ---------------------------------------------------------------------------
// The concat lists must never carry an absolute path
//
// The demuxer resolves a relative name against the list's own directory and the
// list is written beside the segments, so a basename is enough. An absolute
// Windows path is the trap: inside the quoted name a backslash is an ESCAPE and
// `C:` is parsed as a PROTOCOL — a defect only a Windows runner could observe.
// ---------------------------------------------------------------------------
{
	check(
		"a concat entry carries the basename only (POSIX)",
		vassemble.concatEntry("/tmp/video/tmp/f1/seg-000.mp4") === "file 'seg-000.mp4'",
	);
	const win = vassemble.concatEntry("C:\\Users\\dev\\video\\tmp\\f1\\seg-000.mp4");
	check("a concat entry carries the basename only (Windows)", win === "file 'seg-000.mp4'", win);
	check("no backslash and no drive colon survive into the concat list", !/[\\:]/.test(win), win);
	const quoted = vassemble.concatEntry("/tmp/a/it's.mp4");
	check("a quote in the name is escaped, not left to break the list", quoted === "file 'it'\\''s.mp4'", quoted);
}

// ---------------------------------------------------------------------------
// E2E with the REAL ffmpeg — only with ODOO_SDD_REQUIRE_FFMPEG=1 (CI)
// ---------------------------------------------------------------------------
const realFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (realFfmpeg.status !== 0) {
	SKIP("real-ffmpeg E2E (no ffmpeg on PATH)");
	if (process.env.ODOO_SDD_REQUIRE_FFMPEG === "1") {
		throw new Error("ODOO_SDD_REQUIRE_FFMPEG=1 but no usable ffmpeg is on PATH");
	}
} else {
	const ew = mkCaptureWs();
	const rawWebm = join(ew, "video", "raw", "f1.webm");
	const gen = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=8:size=1440x900:rate=25", "-pix_fmt", "yuv420p", rawWebm], { encoding: "utf8" });
	check("a synthetic 8s 1440x900 webm is generated", gen.status === 0 && statSync(rawWebm).size > 1000, gen.stderr?.slice(-300) ?? "");
	writeFileSync(
		join(ew, "capture.json"),
		JSON.stringify({
			schema: "dsh-odoo-sdd/capture/2",
			flow: "f1",
			video: { file: "video/raw/f1.webm", bytes: statSync(rawWebm).size },
			steps: [
				// Deliberately SHORT action windows: the padded narration, not the
				// cut, must own the timeline. Long cuts hid an output-side -t that
				// truncated the tpad freeze.
				{ id: "s01", kind: "goto", status: "ok", startMs: 300, endMs: 600 },
				{ id: "s02", kind: "screenshot", status: "ok", startMs: 700, endMs: 1000 },
			],
		}),
	);
	const flowTwo = { id: "f1", title: "F", steps: [flowEs.steps[0], { id: "s02", kind: "screenshot", procedure: "Vemos el resultado final del flujo." }] };
	const vreal = await vvoice.voiceFlow({ workspace: ew, flow: flowTwo, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: "ffmpeg" });
	check("voice over real ffprobe reports true WAV durations", vreal.ok && vreal.value.items.length === 2 && vreal.value.items.every((i) => i.durationSeconds !== null && i.durationSeconds > 0.3), JSON.stringify(vreal.ok ? vreal.value.items : vreal.error));
	check("the voice report stores POSIX paths", vreal.ok && vreal.value.items.every((i) => /^voice\/f1\/[^\\]+\.wav$/.test(i.file)), JSON.stringify(vreal.ok ? vreal.value.items.map((i) => i.file) : null));
	const areal = await vassemble.assembleVideo({ workspace: ew, flow: flowTwo, language: "es-ES", ffmpegPath: "ffmpeg", captions: false });
	check("the REAL assembly produces a playable mp4", areal.ok && areal.value.file === "video/f1.mp4", JSON.stringify(areal.ok ? areal.value : areal.error));
	if (areal.ok) {
		const mp4Abs = join(ew, areal.value.file);
		check("the mp4 is a real media file (synthetic testsrc compresses to ~20 KiB/s)", statSync(mp4Abs).size > 20_000);
		const expected = vreal.value.items.reduce((a, i) => a + i.durationSeconds + 0.35, 0);
		const got = areal.value.durationSeconds;
		check("the video duration matches the narration timeline (±0.6s, tpad included)", got !== null && Math.abs(got - expected) < 0.6, `expected ~${expected.toFixed(2)}s got ${got}`);
		const streams = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", mp4Abs], { encoding: "utf8" }).stdout || "{}").streams ?? [];
		const vdur = Number(streams.find((s) => s.codec_type === "video")?.duration);
		const adur = Number(streams.find((s) => s.codec_type === "audio")?.duration);
		check("video and audio streams end together (no -shortest truncation)", Math.abs(vdur - adur) < 0.3, `video=${vdur} audio=${adur}`);
		const vtt2 = readFileSync(join(ew, "video", "f1.vtt"), "utf8");
		check("the VTT ships alongside", vtt2.startsWith("WEBVTT") && vtt2.includes("Abrimos la lista"));
	}
	rm(ew);
}

rm(ws);
console.log(`\nvideo: ${passed} checks passed`);
