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
const vvoices = await import(libUrl("video-voices.js"));
const vindex = await import(libUrl("video-index.js"));
const vcov = await import(libUrl("video-coverage.js"));
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
check(
	"GROUP-MISSING warns when a series has ungrouped flows (and only then)",
	(() => {
		const one = sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "x" }] }]);
		const twoUngrouped = sbOf([
			{ id: "f1", title: "a", steps: [{ id: "s01", kind: "goto", procedure: "x" }] },
			{ id: "f2", title: "b", steps: [{ id: "s01", kind: "goto", procedure: "x" }] },
		]);
		const twoGrouped = sbOf([
			{ id: "f1", title: "a", group: "G", steps: [{ id: "s01", kind: "goto", procedure: "x" }] },
			{ id: "f2", title: "b", group: "G", steps: [{ id: "s01", kind: "goto", procedure: "x" }] },
		]);
		return (
			vmodel.validateVideoStoryboard(one, null).every((f) => f.rule !== "GROUP-MISSING") &&
			vmodel.validateVideoStoryboard(twoUngrouped, null).some((f) => f.rule === "GROUP-MISSING" && f.severity === "WARN") &&
			vmodel.validateVideoStoryboard(twoGrouped, null).every((f) => f.rule !== "GROUP-MISSING")
		);
	})(),
);

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
check(
	"NEEDS_TTS lists the voice presets (recommended first, cloud/offline badges) and the privacy notice",
	!noTts.ok &&
		noTts.error.includes("viral-male") && noTts.error.includes("offline-piper") &&
		noTts.error.includes("recommended") && noTts.error.includes("cloud") && noTts.error.includes("offline") &&
		/Microsoft/.test(noTts.error) && noTts.error.indexOf("viral-male") < noTts.error.indexOf("calm-male"),
	noTts.error,
);
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
// The caption spans the RENDERED segment: the cut (2 s) beats the 1.35 s
// narration target, so the last entry ends at 7.35 s, not 6.7 s.
check(
	"SRT: one entry per narrated step, timeline includes silent steps",
	srt === "1\n00:00:00,000 --> 00:00:02,850\nHola mundo\n\n2\n00:00:05,350 --> 00:00:07,350\nFin del flujo\n",
	JSON.stringify(srt),
);
const vtt = vassemble.buildVtt(segs);
check("VTT: WEBVTT header and dot decimals", vtt.startsWith("WEBVTT\n\n") && vtt.includes("00:00:05.350 --> 00:00:07.350"));

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
	const noCapture = await vassemble.assembleVideo({ workspace: empty, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false, stem: "01-flujo" });
	rm(empty);
	const schema1 = mkCaptureWs();
	writeFileSync(join(schema1, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/1", flow: "f1", steps: [] }));
	const noVideo = await vassemble.assembleVideo({ workspace: schema1, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false, stem: "01-flujo" });
	rm(schema1);
	const otherFlow = mkCaptureWs();
	writeFileSync(join(otherFlow, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/2", flow: "f9", video: { file: "video/raw/f1.webm", bytes: 8 }, steps: [] }));
	const wrongFlow = await vassemble.assembleVideo({ workspace: otherFlow, flow: flowEs, language: "es-ES", ffmpegPath: "ffmpeg-none", captions: false, stem: "01-flujo" });
	rm(otherFlow);
	const broken = mkCaptureWs();
	writeFileSync(join(broken, "capture.json"), JSON.stringify({ schema: "dsh-odoo-sdd/capture/2", flow: "f1", video: { file: "video/raw/f1.webm", bytes: 8 }, steps: [{ id: "s01", kind: "goto", status: "ok", startMs: 100, endMs: 900 }] }));
	const noFfmpeg = await vassemble.assembleVideo({ workspace: broken, flow: flowEs, language: "es-ES", ffmpegPath: join(ws, "no", "ffmpeg"), captions: false, stem: "01-flujo" });
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
	const ares = await vassemble.assembleVideo({ workspace: aw, flow: flowThree, language: "es-ES", ffmpegPath: fakeFfmpeg, captions: false, stem: "01-flujo" });
	check("assemble succeeds against the fake ffmpeg", ares.ok, JSON.stringify(ares.ok ? ares.value : ares.error));
	if (ares.ok) {
		check("the video truncates at the failed step and keeps prior segments", ares.value.truncatedAt === "s03" && ares.value.segments === 2 && ares.value.narrated === true);
		check("the report names the series stem at the workspace root", ares.value.file === "01-flujo.mp4", ares.value.file);
		const mp4Abs = join(aw, ares.value.file);
		check("01-flujo.mp4 exists at the root (fake ffmpeg wrote it)", existsSync(mp4Abs) && readFileSync(mp4Abs).toString("ascii").startsWith("FAKE"));
		const srtText = readFileSync(join(aw, "01-flujo.srt"), "utf8");
		check("the SRT ships next to the mp4 with the narrated steps", srtText.includes("Abrimos la lista") && srtText.includes("00:00:00,000"));
		check("video.json records the video schema with language/voice", (() => {
			const report = JSON.parse(readFileSync(join(aw, "video", "video.json"), "utf8"));
			return report.schema === "dsh-odoo-sdd/video/1" && report.language === "es-ES" && report.voice === "es-ES-test" && report.truncatedAt === "s03";
		})());
		check("series.json merges the per-flow report", (() => {
			const series = JSON.parse(readFileSync(join(aw, "video", "series.json"), "utf8"));
			return series.schema === "dsh-odoo-sdd/series/1" && series.flows.f1?.file === "01-flujo.mp4";
		})());
		check("the tmp segment dir is cleaned", !existsSync(join(aw, "video", "tmp", "f1")));
		check("the raw webm is kept for re-assembly", existsSync(join(aw, "video", "raw", "f1.webm")));

		// Re-assembling under a NEW stem must remove the previous artifacts:
		// a rename that leaves the old file behind is exactly the orphan the
		// index operation then reports.
		const renamed = await vassemble.assembleVideo({ workspace: aw, flow: flowThree, language: "es-ES", ffmpegPath: fakeFfmpeg, captions: false, stem: "02-renombrado", previousFile: ares.value.file });
		check("re-assembly under a new stem succeeds", renamed.ok, JSON.stringify(renamed.ok ? "" : renamed.error));
		if (renamed.ok) {
			check("the previous mp4/srt/vtt are removed on rename", !existsSync(join(aw, "01-flujo.mp4")) && !existsSync(join(aw, "01-flujo.srt")) && !existsSync(join(aw, "01-flujo.vtt")));
			check("the new stem files exist at the root", existsSync(join(aw, "02-renombrado.mp4")) && existsSync(join(aw, "02-renombrado.srt")));
		}
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
	const areal = await vassemble.assembleVideo({ workspace: ew, flow: flowTwo, language: "es-ES", ffmpegPath: "ffmpeg", captions: false, stem: "01-flujo" });
	check("the REAL assembly produces a playable mp4 at the series root", areal.ok && areal.value.file === "01-flujo.mp4", JSON.stringify(areal.ok ? areal.value : areal.error));
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
		const vtt2 = readFileSync(join(ew, "01-flujo.vtt"), "utf8");
		check("the VTT ships alongside", vtt2.startsWith("WEBVTT") && vtt2.includes("Abrimos la lista"));
	}
	// Phase 5 creative pass: hook+outro cards, music bed, sfx, burned captions.
	const flowHooked = {
		...flowTwo,
		title: "Flujo demo",
		hook: { text: "Antes de empezar, esto es lo que vas a conseguir" },
		outro: { text: "Y así queda el presupuesto cerrado" },
	};
	const vhook = await vvoice.voiceFlow({ workspace: ew, flow: flowHooked, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: "ffmpeg" });
	const acreative = vhook.ok
		? await vassemble.assembleVideo({
				workspace: ew, flow: flowHooked, language: "es-ES", ffmpegPath: "ffmpeg",
				captions: true, stem: "02-creativo", title: flowHooked.title,
				chapterLabel: "02 · Demo — Flujo demo", nextTitle: "Siguiente video",
				music: true, sfx: true,
			})
		: vhook;
	check("the creative assembly succeeds with hook+outro+music+sfx", acreative.ok === true && acreative.value.hook && acreative.value.outro && acreative.value.music && acreative.value.sfx, JSON.stringify(acreative.ok ? acreative.value : acreative.error));
	if (acreative.ok) {
		const mp4 = join(ew, "02-creativo.mp4");
		check("audio and video still end together in the creative pass", (() => {
			const streams = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", mp4], { encoding: "utf8" }).stdout || "{}").streams ?? [];
			const vd = Number(streams.find((s) => s.codec_type === "video")?.duration);
			const ad = Number(streams.find((s) => s.codec_type === "audio")?.duration);
			return Math.abs(vd - ad) < 0.15;
		})());
		check("loudnorm lands near -14 LUFS (±1.5)", acreative.value.loudnessLufs !== undefined && Math.abs(acreative.value.loudnessLufs + 14) < 1.5, `lufs=${acreative.value.loudnessLufs}`);
		check("srt carries the hook first and the outro last", (() => {
			const srt = readFileSync(join(ew, "02-creativo.srt"), "utf8");
			return srt.indexOf("Antes de empezar") < srt.indexOf("Abrimos la lista") && srt.indexOf("presupuesto cerrado") > srt.indexOf("Abrimos la lista");
		})());
		check("captions report as burned when a font exists", acreative.value.captions === true || acreative.value.captionsNote !== undefined);
		const black = spawnSync("ffmpeg", ["-i", mp4, "-vf", "blackdetect=d=1.2:pix_th=0.10", "-an", "-f", "null", "-"], { encoding: "utf8" });
		check("blackdetect finds no black frame run ≥1.2s", !(black.stderr ?? "").includes("blackdetect"), (black.stderr ?? "").split("\n").find((l) => l.includes("blackdetect")) ?? "");
	}
	rm(ew);
}

// ---------------------------------------------------------------------------
// slugify — ASCII kebab stems
// ---------------------------------------------------------------------------
check("slugify strips accents and lowercases", vindex.slugify("Configuración del Medidor") === "configuracion-del-medidor", vindex.slugify("Configuración del Medidor"));
check("slugify folds ñ to n", vindex.slugify("Año Nuevo") === "ano-nuevo", vindex.slugify("Año Nuevo"));
check("slugify folds symbols into single dashes", vindex.slugify("Ventas: ¡Ahora!") === "ventas-ahora", vindex.slugify("Ventas: ¡Ahora!"));
{
	const long = "the quick brown fox jumps over the lazy dog and keeps running far beyond the hills";
	const s = vindex.slugify(long, 40);
	check("slugify truncates at a word boundary", s.length <= 40 && !s.endsWith("-") && long.replace(/[^a-z0-9]+/g, "-").startsWith(s), `${s.length} ${s}`);
}
check("slugify returns 'video' for an all-symbol title", vindex.slugify("★★★") === "video" && vindex.slugify("") === "video");

// ---------------------------------------------------------------------------
// numberFlows — group order, numbering width, collisions
// ---------------------------------------------------------------------------
{
	const flow = (id, title, extra) => ({ id, title, steps: [{ id: "s01", kind: "goto", procedure: "x" }], ...(extra ?? {}) });
	// Groups keep FIRST-APPEARANCE order, not alphabetical: "Zeta" was written
	// first, so its members are numbered before "Alfa" no matter the names.
	const sb = sbOf([flow("f1", "Uno", { group: "Zeta" }), flow("f2", "Dos", { group: "Alfa" }), flow("f3", "Tres", { group: "Zeta" })]);
	const numbered = vindex.numberFlows(sb);
	check(
		"numberFlows orders by first-appearance group, array order inside",
		numbered.ok && numbered.items.map((i) => i.flow.id).join(",") === "f1,f3,f2" && numbered.items[0].stem === "01-uno" && numbered.items[1].stem === "02-tres" && numbered.items[2].stem === "03-dos",
		JSON.stringify(numbered),
	);
	const ungrouped = vindex.numberFlows({ ...sb, slug: "mi-serie", flows: [flow("f1", "Uno"), flow("f2", "Dos", { group: "Alfa" })] });
	check(
		"an ungrouped flow is filed under the storyboard slug",
		ungrouped.ok && ungrouped.items[0].group === "mi-serie" && ungrouped.items[0].stem === "01-uno",
		JSON.stringify(ungrouped),
	);
	const many = sbOf(Array.from({ length: 105 }, (_, i) => flow(`f${i + 1}`, `Video ${i + 1}`)));
	const wide = vindex.numberFlows(many);
	check(
		"numbering pads to 3 digits once the series reaches 100+",
		wide.ok && wide.items[0].stem.startsWith("001-") && wide.items[104].stem.startsWith("105-"),
		wide.ok ? `${wide.items[0].stem} … ${wide.items[104].stem}` : wide.error,
	);
	const clash = vindex.numberFlows(sbOf([flow("f1", "Same Name"), flow("f9", "Same Name")]));
	check("a stem collision is an error naming both flows", !clash.ok && /f1/.test(clash.error) && /f9/.test(clash.error), JSON.stringify(clash));
	check("flow.slug overrides the title for the stem", (() => {
		const r = vindex.numberFlows(sbOf([flow("f1", "Título Con Tildes", { slug: "nombre-archivo" })]));
		return r.ok && r.items[0].stem === "01-nombre-archivo";
	})());
}

// ---------------------------------------------------------------------------
// renderReadme — the series guide
// ---------------------------------------------------------------------------
{
	const flowA = { id: "f1", title: "Crear | presupuesto", group: "Operaciones", summary: "Aprende a crear presupuestos.", steps: [{ id: "s01", kind: "goto", procedure: "x" }] };
	const flowB = { id: "f2", title: "Segundo video", group: "Operaciones", hook: { text: "El gancho" }, steps: [{ id: "s01", kind: "goto", procedure: "x" }] };
	const flowC = { id: "f3", title: "Tercero", group: "Ajustes", role: "sale.group_manager", steps: [{ id: "s01", kind: "goto", procedure: "x" }] };
	const sb = { ...sbOf([flowA, flowB, flowC]), slug: "video-ventas", language: "es" };
	const numbered = vindex.numberFlows(sb);
	check("the storyboard used below numbers without collisions", numbered.ok);
	const meta = { f1: { file: "01-crear-presupuesto.mp4", durationSeconds: 75, steps: 4 }, f2: { file: "02-segundo-video.mp4", durationSeconds: 45, steps: 3 }, f3: { file: "03-tercero.mp4", durationSeconds: null, steps: 2 } };
	const readme = vindex.renderReadme({ sb, items: numbered.items, meta, language: "es" });
	check("README is in the storyboard language", readme.includes("Cómo usar esta guía") && readme.includes("Qué aprenderás"), readme.slice(0, 200));
	check("README totals line counts videos and duration", /3 videos/.test(readme) && /2:00/.test(readme), readme.split("\n")[2]);
	check("README has a foldable section per group with the spec table", /<details open>/.test(readme) && readme.includes("| # | Video | Duración | Pasos | Qué aprenderás |") && readme.includes("### Operaciones") && readme.includes("### Ajustes"));
	check("README links the mp4 and its captions relatively", readme.includes("](01-crear-presupuesto.mp4)") && readme.includes("](01-crear-presupuesto.srt)"));
	check("README escapes pipes in cells", readme.includes("Crear \\| presupuesto"), readme.split("\n").find((l) => l.includes("presupuesto")) ?? "");
	check("README's 'what you'll learn' prefers summary then hook text", readme.includes("Aprende a crear presupuestos.") && readme.includes("El gancho"));
	check("README progress checklist carries the next-video link", /- \[ \] 01 .+Siguiente: \[Segundo video\]\(02-segundo-video\.mp4\)/.test(readme));
	check("README lists suggested paths when a flow names a role", readme.includes("Rutas sugeridas") && readme.includes("sale.group_manager"));
	const enReadme = vindex.renderReadme({ sb, items: numbered.items, meta, language: "en" });
	check("README renders in English", enReadme.includes("How to use this guide") && enReadme.includes("| # | Video | Duration | Steps | What you'll learn |"));
	const unknownLang = vindex.renderReadme({ sb, items: numbered.items, meta, language: "de_DE" });
	check("an unknown language falls back to English", unknownLang.includes("How to use this guide"));
	const noRole = vindex.renderReadme({ sb: { ...sb, flows: [flowA, flowB] }, items: vindex.numberFlows({ ...sb, flows: [flowA, flowB] }).items, meta, language: "en" });
	check("no suggested-paths section when no flow names a role/audience", !noRole.includes("Suggested paths"));
	check("shouldWriteReadme needs at least two videos", !vindex.shouldWriteReadme(vindex.numberFlows(sbOf([flowA])).items) && vindex.shouldWriteReadme(numbered.items));
}

// ---------------------------------------------------------------------------
// resolveVoiceEngine — preset > custom command, per-language voices
// ---------------------------------------------------------------------------
check(
	"a preset wins over a configured ttsCommand",
	(() => {
		const e = vvoices.resolveVoiceEngine({ ttsPreset: "viral-male", ttsCommand: "whatever {out}", language: "es_ES" });
		return e !== null && e.command.startsWith("edge-tts") && e.voice === "es-MX-JorgeNeural" && e.cloud === true && e.presetId === "viral-male";
	})(),
);
check("the edge template carries the rate as ONE token and writes {out}", (() => {
	const e = vvoices.resolveVoiceEngine({ ttsPreset: "viral-male", language: "es" });
	return e !== null && e.command.includes("--rate=+10%") && e.command.includes("{textFile}") && e.command.includes("{out}") && !e.command.includes("--rate ");
})());
check("voice resolution follows the storyboard language", (() => {
	const fr = vvoices.resolveVoiceEngine({ ttsPreset: "calm-female", language: "fr" });
	const de = vvoices.resolveVoiceEngine({ ttsPreset: "viral-male", language: "de" });
	return fr?.voice === "fr-FR-DeniseNeural" && de?.voice === "en-US-AndrewNeural";
})(), JSON.stringify([vvoices.resolveVoiceEngine({ ttsPreset: "calm-female", language: "fr" }), vvoices.resolveVoiceEngine({ ttsPreset: "viral-male", language: "de" })]));
check("offline-piper resolves with a null voice until ttsVoice is set", (() => {
	const noVoice = vvoices.resolveVoiceEngine({ ttsPreset: "offline-piper", language: "es" });
	const withVoice = vvoices.resolveVoiceEngine({ ttsPreset: "offline-piper", ttsVoice: "/models/es_ES.onnx", language: "es" });
	return noVoice !== null && noVoice.voice === null && noVoice.command.includes("piper") && withVoice?.voice === "/models/es_ES.onnx";
})());
check("custom preset uses ttsCommand/ttsVoice verbatim", (() => {
	const e = vvoices.resolveVoiceEngine({ ttsPreset: "custom", ttsCommand: "my-tts {out}", ttsVoice: "v1", language: "es" });
	return e !== null && e.command === "my-tts {out}" && e.voice === "v1" && e.cloud === false;
})());
check("no preset + no command resolves to null (NEEDS_TTS)", vvoices.resolveVoiceEngine({ ttsPreset: "", ttsCommand: "", language: "es" }) === null);
check("an unknown preset id resolves to null", vvoices.resolveVoiceEngine({ ttsPreset: "nope", ttsCommand: "x {out}" }) === null);
check("an explicit ttsVoice overrides only the concrete voice", (() => {
	const e = vvoices.resolveVoiceEngine({ ttsPreset: "viral-female", ttsVoice: "es-ES-ElviraNeural", language: "es" });
	return e !== null && e.voice === "es-ES-ElviraNeural" && e.presetId === "viral-female";
})());
check("listVoicePresets puts recommended first and names the concrete voice", (() => {
	const list = vvoices.listVoicePresets("es");
	return list[0].preset.recommended === true && list[0].voice === "es-MX-JorgeNeural" && list.some((x) => x.preset.id === "offline-piper" && x.voice === null);
})());

// ---------------------------------------------------------------------------
// Transcode: a non-RIFF TTS output is normalized to a real WAV via ffmpeg
// ---------------------------------------------------------------------------
if (canFakeBin) {
	const tw = mkdtempSync(join(tmpdir(), "video-tr-"));
	// A "TTS" that copies a non-RIFF payload (edge-tts writes MP3 under .wav).
	writeFileSync(join(tw, "payload.mp3"), Buffer.from("FAKEMP3DATA"));
	const trCmd = `${process.execPath} ${silentTts} --copy ${join(tw, "payload.mp3")} --out {out}`;
	const tres = await vvoice.voiceFlow({ workspace: tw, flow: flowEs, language: "es-ES", ttsCommand: trCmd, voice: null, ffmpegPath: fakeFfmpeg });
	check("a non-RIFF TTS output is handed to ffmpeg for transcoding", tres.ok && readFileSync(join(tw, tres.value.items[0].file)).toString("ascii") === "FAKE-FFMPEG-OUTPUT", JSON.stringify(tres.ok ? "" : tres.error));
	rm(tw);
} else {
	SKIP("non-RIFF transcode with the fake ffmpeg (POSIX-only fake binaries)");
}
const realFfmpegForTr = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (realFfmpegForTr.status === 0) {
	const tw = mkdtempSync(join(tmpdir(), "video-tr-real-"));
	const mp3 = join(tw, "payload.mp3");
	const gen = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", mp3], { encoding: "utf8" });
	check("a real MP3 payload is synthesized for the transcode test", gen.status === 0 && statSync(mp3).size > 100, gen.stderr?.slice(-200) ?? "");
	const trCmd = `${process.execPath} ${silentTts} --copy ${mp3} --out {out}`;
	const tres = await vvoice.voiceFlow({ workspace: tw, flow: flowEs, language: "es-ES", ttsCommand: trCmd, voice: null, ffmpegPath: "ffmpeg" });
	if (tres.ok) {
		const head = readFileSync(join(tw, tres.value.items[0].file)).subarray(0, 12).toString("ascii");
		check("the real ffmpeg transcodes the MP3 to a RIFF/WAVE file", head.startsWith("RIFF") && head.slice(8, 12) === "WAVE", head);
	} else {
		check("the real ffmpeg transcodes the MP3 to a RIFF/WAVE file", false, tres.error);
	}
	rm(tw);
} else {
	SKIP("non-RIFF transcode with the real ffmpeg (no ffmpeg on PATH)");
}

// ---------------------------------------------------------------------------
// POSIX report paths — the reports travel in JSON and docs read them as
// `video/…` URLs; a Windows run writing backslashes would break both.
// ---------------------------------------------------------------------------
check("series stems are POSIX-safe file names", (() => {
	const r = vindex.numberFlows(sbOf([{ id: "f1", title: "Cualquier cosa", steps: [{ id: "s01", kind: "goto", procedure: "x" }] }]));
	return r.ok && r.items.every((i) => /^\d+-[a-z0-9-]+$/.test(i.stem));
})());

// ---------------------------------------------------------------------------
// Phase 3: craft lints (hook/outro/sentence/filler) + module coverage
// ---------------------------------------------------------------------------
{
	const f = (id, extra) => ({ id, title: id, steps: [{ id: "s01", kind: "goto", procedure: "X." }], ...(extra ?? {}) });
	const has = (findings, rule, sev) => findings.some((x) => x.rule === rule && x.severity === sev);
	check("HOOK-MISSING/OUTRO-MISSING warn on a bare flow", (() => {
		const fs = vmodel.validateVideoStoryboard(sbOf([f("f1")]), null);
		return has(fs, "HOOK-MISSING", "WARN") && has(fs, "OUTRO-MISSING", "WARN");
	})());
	check("a hooked flow produces no hook findings", (() => {
		const fs = vmodel.validateVideoStoryboard(sbOf([f("f1", { hook: { text: "Verás el resultado primero." }, outro: { text: "Eso es todo." } })]), null);
		return !has(fs, "HOOK-MISSING", "WARN") && !has(fs, "OUTRO-MISSING", "WARN") && !has(fs, "HOOK-LONG", "WARN");
	})());
	check("HOOK-LONG warns over 20 words", has(vmodel.validateVideoStoryboard(sbOf([f("f1", { hook: { text: "uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno" } })]), null), "HOOK-LONG", "WARN"));
	check("SENTENCE-LONG warns over 28 words on procedure and outro", (() => {
		const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
		const fs = vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", outro: { text: long }, steps: [{ id: "s01", kind: "goto", procedure: long }] }]), null);
		return fs.filter((x) => x.rule === "SENTENCE-LONG").length === 2;
	})());
	check("FILLER catches video filler phrases (es and en)", (() => {
		const es = vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "Como puedes ver, esto abre la lista." }] }]), null);
		const en = vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "As you can see, this opens the list." }] }]), null);
		return has(es, "FILLER", "WARN") && has(en, "FILLER", "WARN");
	})());
	check("voiceFlow narrates hook and outro as _hook/_outro items", (async () => {
		const hw = mkdtempSync(join(tmpdir(), "video-hook-"));
		const hookFlow = { ...flowEs, hook: { text: "El gancho." }, outro: { text: "El cierre." } };
		const r = await vvoice.voiceFlow({ workspace: hw, flow: hookFlow, language: "es-ES", ttsCommand: ttsCmd, voice: "es-ES-test", ffmpegPath: canFakeBin ? fakeFfmpeg : "ffprobe-none" });
		const ids = r.ok ? r.value.items.map((i) => i.stepId) : [];
		rm(hw);
		return r.ok && ids.includes("_hook") && ids.includes("_outro") && ids.indexOf("_hook") < ids.indexOf("s01") && ids.indexOf("_outro") > ids.indexOf("s01");
	})());
}

// ---- coverage: inventory, computation, seeding ------------------------------
const modSurface = {
	fingerprint: "fp1",
	model: "sale.order",
	actionXmlids: ["sale.action_quotations"],
	menuXmlids: ["sale.menu_quotations"],
	module: {
		name: "sale",
		menus: [{ xmlid: "sale.menu_quotations", completeName: "Sales/Orders/Quotations", actionXmlid: "sale.action_quotations", model: "sale.order" }],
		actions: [{ xmlid: "sale.action_quotations", name: "Quotations", kind: "ir.actions.act_window", model: "sale.order" }],
		models: [
			{ model: "sale.order", fields: [{ name: "partner_id" }, { name: "note" }], buttons: [{ name: "action_confirm" }], pages: [{ name: "order_lines" }], statusbar: { field: "state" } },
			{ model: "sale.wizard", transient: true, fields: [{ name: "x" }], buttons: [], pages: [] },
		],
		views: [{ xmlid: "sale.order_form", name: "Order form", model: "sale.order", type: "form", adds: ["note", "order_lines"], modifies: [] }],
		crons: [{ xmlid: "sale.cron_prune", name: "Prune drafts", model: "sale.order", active: true }],
		automations: [], templates: [], rules: [{ xmlid: "sale.rule_own", name: "Own orders", model: "sale.order" }],
	},
};
{
	const narratedStep = (id, kind, extra) => ({ id, kind, procedure: "Narrado.", ...(extra ?? {}) });
	const sbBase = () => ({ schema: "dsh-odoo-sdd/manual/1", slug: "video-sale", flows: [] });
	const cov1 = vcov.computeCoverage(sbBase(), modSurface);
	check("an empty storyboard leaves the whole inventory as gaps", cov1.items.length > 0 && cov1.gaps.length === cov1.items.length);
	const covered = sbBase();
	covered.flows.push({
		id: "f1", title: "q", kind: "menu", model: "sale.order", group: "G",
		hook: { text: "h" }, outro: { text: "o" },
		steps: [
			narratedStep("s01", "goto", { target: { kind: "action", xmlid: "sale.action_quotations" } }),
			narratedStep("s02", "fill", { field: "note" }),
			narratedStep("s03", "click", { field: "action_confirm" }),
			narratedStep("s04", "highlight", { field: "order_lines" }),
			narratedStep("s05", "highlight", { field: "partner_id", covers: ["cron:sale.cron_prune", "rule:sale.rule_own"] }),
		],
	});
	const cov2 = vcov.computeCoverage(covered, modSurface);
	check("goto covers action AND the menu that opens it", cov2.covered.has("action:sale.action_quotations") && cov2.covered.has("menu:sale.menu_quotations"));
	check("fill/highlight cover fields and pages", cov2.covered.has("field:sale.order.note") && cov2.covered.has("page:sale.order.order_lines"));
	check("click covers the button", cov2.covered.has("button:sale.order.action_confirm"));
	check("a view is covered when one of its adds is covered", cov2.covered.has("view:sale.order_form"));
	check("workflow:<m> is covered by a narrated click on its model", cov2.covered.has("workflow:sale.order"));
	check("explicit covers[] reach cron/rule refs", cov2.covered.has("cron:sale.cron_prune") && cov2.covered.has("rule:sale.rule_own"));
	check("a wizard without a flow stays a gap", cov2.gaps.some((g) => g.ref === "wizard:sale.wizard"));
	// pending: a seeded step without narration marks pending, not covered.
	const silent = sbBase();
	silent.flows.push({ id: "v1", title: "s", steps: [{ id: "s01", kind: "highlight", procedure: null, field: "note", covers: ["field:sale.order.note"] }] });
	const cov3 = vcov.computeCoverage(silent, modSurface);
	check("a silent seeded step is pending, not covered", cov3.pending.has("field:sale.order.note") && !cov3.covered.has("field:sale.order.note") && !cov3.gaps.some((g) => g.ref === "field:sale.order.note"));
	// videoSkip resolves a ref with a reason.
	const skipped = sbBase();
	skipped.videoSkip = { "cron:sale.cron_prune": "maintenance job, out of scope", "field:sale.order.note": "  " };
	const cov4 = vcov.computeCoverage(skipped, modSurface);
	check("videoSkip with a reason resolves the ref", cov4.skipped["cron:sale.cron_prune"] === "maintenance job, out of scope" && !cov4.gaps.some((g) => g.ref === "cron:sale.cron_prune") && cov4.gaps.some((g) => g.ref === "field:sale.order.note"));
	// seeding: drafts flows for the gaps, idempotent.
	const seedSb = sbBase();
	const first = vcov.seedCoverageFlows(seedSb, modSurface);
	check("seedCoverageFlows drafts v-id flows for the gaps", first > 0 && seedSb.flows.length > 0 && seedSb.flows.every((x) => /^v\d+$/.test(x.id)));
	check("seeded steps are silent highlights carrying covers", seedSb.flows.some((x) => x.steps.some((s) => s.kind === "highlight" && s.procedure === null && (s.covers ?? []).length > 0)));
	const second = vcov.seedCoverageFlows(seedSb, modSurface);
	check("seedCoverageFlows is idempotent (second call adds 0)", second === 0);
	const afterSeed = vcov.computeCoverage(seedSb, modSurface);
	check("after seeding every gap is pending narration", afterSeed.gaps.length === 0 && afterSeed.pending.size > 0);
	// VIDEO-COVERAGE lint: ERROR while gaps exist, gone when everything is
	// narrated (pending alone is only WARN).
	check("VIDEO-COVERAGE is an ERROR with gaps", vmodel.validateVideoStoryboard(sbBase(), modSurface).some((x) => x.rule === "VIDEO-COVERAGE" && x.severity === "ERROR"));
	check("VIDEO-COVERAGE warns (not errors) for pending-only", (() => {
		const fs = vmodel.validateVideoStoryboard(seedSb, modSurface);
		return fs.every((x) => x.rule !== "VIDEO-COVERAGE" || x.severity !== "ERROR") && fs.some((x) => x.rule === "VIDEO-COVERAGE" && x.severity === "WARN");
	})());
	check("narrating the seeded steps clears VIDEO-COVERAGE", (() => {
		for (const fl of seedSb.flows) for (const s of fl.steps) if (s.procedure === null) s.procedure = "Explicado.";
		return vmodel.validateVideoStoryboard(seedSb, modSurface).every((x) => x.rule !== "VIDEO-COVERAGE");
	})());
	check("record targets to inventory models are not TARGET-UNKNOWN", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "goto", procedure: "x", target: { kind: "record", model: "sale.wizard", recordId: 3 } }] }]), modSurface).every((x) => x.rule !== "TARGET-UNKNOWN"));
	check("a highlight over a name the model lacks is TARGET-UNKNOWN", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", model: "sale.order", steps: [{ id: "s01", kind: "highlight", procedure: "x", field: "no_such_field" }] }]), modSurface).some((x) => x.rule === "TARGET-UNKNOWN" && x.severity === "ERROR"));
	check("an unknown covers ref is COVERS-UNKNOWN", vmodel.validateVideoStoryboard(sbOf([{ id: "f1", title: "t", steps: [{ id: "s01", kind: "highlight", procedure: "x", field: "note", covers: ["cron:sale.nope"] }] }]), modSurface).some((x) => x.rule === "COVERS-UNKNOWN" && x.severity === "WARN"));
	check("formatCoverage prints the matrix and the gaps", vcov.formatCoverage(vcov.computeCoverage(sbBase(), modSurface)).some((l) => l.startsWith("total:")) && vcov.formatCoverage(vcov.computeCoverage(sbBase(), modSurface)).some((l) => l.includes("cron:sale.cron_prune")));
	check("README gains a coverage section naming the gaps", (() => {
		const step = { id: "s01", kind: "goto", procedure: "X." };
		const sbCov = sbOf([{ id: "f1", title: "Uno", steps: [step] }, { id: "f2", title: "Dos", steps: [step] }]);
		const items = vindex.numberFlows(sbCov).items;
		const md = vindex.renderReadme({ sb: sbCov, items, meta: {}, language: "es", coverage: { gaps: [{ ref: "cron:x.y", label: "job" }], total: 5, covered: 3 } });
		return md.includes("## Cobertura") && md.includes("`cron:x.y`");
	})());
}

// ---------------------------------------------------------------------------
// Phase 5 assembly contract — fake ffmpeg, deterministic
// ---------------------------------------------------------------------------
if (canFakeBin) {
	const pw = mkdtempSync(join(tmpdir(), "video-p5-"));
	const hooked = {
		...flowEs,
		title: "Flujo demo",
		hook: { text: "El gancho de apertura" },
		outro: { text: "El cierre del video" },
	};
	await vvoice.voiceFlow({ workspace: pw, flow: hooked, language: "es-ES", ttsCommand: ttsCmd, voice: "v", ffmpegPath: fakeFfmpeg });
	writeFileSync(
		join(pw, "capture.json"),
		JSON.stringify({
			schema: "dsh-odoo-sdd/capture/2",
			flow: "f1",
			video: { file: "video/raw/f1.webm", bytes: 8 },
			steps: [
				{ id: "s01", kind: "goto", status: "ok", startMs: 500, endMs: 2000 },
				{ id: "s02", kind: "screenshot", status: "ok", startMs: 2100, endMs: 3000 },
			],
		}),
	);
	mkdirSync(join(pw, "video", "raw"), { recursive: true });
	writeFileSync(join(pw, "video", "raw", "f1.webm"), "fake-webm");
	const opts = { workspace: pw, flow: hooked, language: "es-ES", ffmpegPath: fakeFfmpeg, captions: true, stem: "01-demo", title: hooked.title, chapterLabel: "01 · G — Flujo demo", nextTitle: "Otro", music: true, sfx: true };
	const ar = await vassemble.assembleVideo(opts);
	check("hook/outro/music/sfx flags land in the report", ar.ok && ar.value.hook === true && ar.value.outro === true && ar.value.music === true && ar.value.sfx === true, JSON.stringify(ar.ok ? ar.value : ar.error));
	check("segments = steps + hook + outro, in order", ar.ok && ar.value.segments === hooked.steps.length + 2);
	const srt = ar.ok ? readFileSync(join(pw, "01-demo.srt"), "utf8") : "";
	check("srt opens with the hook text and closes with the outro", srt.indexOf("gancho de apertura") < srt.indexOf("Abrimos la lista") && srt.indexOf("cierre del video") > srt.indexOf("Abrimos la lista"));
	const arNoMusic = await vassemble.assembleVideo({ ...opts, stem: "02-demo", music: false });
	check("music:false overrides the default on the report", arNoMusic.ok && arNoMusic.value.music === false);
	const arNoCaps = await vassemble.assembleVideo({ ...opts, stem: "03-demo", captions: false });
	check("captions:false skips burning but still writes srt/vtt", arNoCaps.ok && arNoCaps.value.captions === false && existsSync(join(pw, "03-demo.srt")) && existsSync(join(pw, "03-demo.vtt")));
	rm(pw);
}

rm(ws);
console.log(`\nvideo: ${passed} checks passed`);
