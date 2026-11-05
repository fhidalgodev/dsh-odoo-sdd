---
name: odoo-video
description: Produce a narrated VIDEO of Odoo flows with odoo_video — plan the storyboard (from the instance or imported from a manual with from_manual), voice each step's procedure sentence with a configured TTS command, capture the browser session with recording always on, and assemble video/<flow>.mp4 with ffmpeg plus SRT/VTT captions. Use when the user asks for a video, screencast or voiced walkthrough of a model or flow, alone or after a manual.
---

# Narrated flow video (odoo_video)

A video that shows behaviour the storyboard does not describe is FORBIDDEN —
and the storyboard may only describe what the canon (or the manual it was
imported from) shows. `odoo_video` never writes `MANUAL.md`: it is a sibling of
`odoo_manual`, not a mode of it. The pipeline is plan → voice → capture →
assemble; each tool call names its flow, and a step without a `procedure`
sentence stays silent in the video.

## Prerequisites (report and stop when one is missing)

- **TTS**: the `ttsCommand` config (or `ODOO_SDD_TTS_CMD`) names an external
  command; the tool runs it WITHOUT a shell, replacing `{text}`, `{textFile}`,
  `{voice}` and `{out}`. No command configured → `NEEDS_TTS`: show the message
  verbatim (it carries the per-language example voices) and let the DEVELOPER
  choose. **Privacy**: a cloud TTS (edge-tts…) sends the narration text to its
  provider — client data leaves the machine. That is the developer's explicit
  decision, never yours.
  Verified offline recipe (no cloud, no account): `python3 -m venv .venv`,
  `.venv/bin/pip install piper-tts`, download a voice (`<voice>.onnx` plus its
  `<voice>.onnx.json`, e.g. `es_ES-sharvard-medium` from the
  `rhasspy/piper-voices` Hugging Face repo), then set
  `ttsCommand = ".venv/bin/piper -m {voice} -i {textFile} -f {out}"` and
  `ttsVoice = "<path>/<voice>.onnx"`. Narrate ONE flow first and listen to the
  `.wav` files before committing to a whole demo.
- **ffmpeg**: system ffmpeg 4.x+ (config `ffmpegPath`). `NEEDS_FFMPEG` → report
  the install line. Recording additionally needs Playwright's BUNDLED ffmpeg
  (`npx playwright install ffmpeg`, a download separate from chromium).
- **A disposable database for action steps**: same rule as the manual. Read-only
  flows (goto/menu/screenshot) never need more.

## Phase 1 — PLAN (gate: storyboard.json exists)

Prefer the manual that already exists: `odoo_video operation=plan
from_manual=<slug>` copies the manual's canon + storyboard into
`<videosDir>/<video-slug>/` (import-once: it refuses to overwrite a video
storyboard — video-side edits must survive). The manual's narration sentences
become the video script as-is; the language is inherited.

Without a manual: `odoo_video operation=plan model=<model> language=<lang>`
(canon + skeleton, same interview options as the manual). The language is
FIXED here: param > imported manual > `documentationLanguage` > `en_US`. It
governs the narration and the captions; set it before writing sentences.

Then WRITE the narration: one `procedure` sentence per step — spoken-word
register, short enough to breathe ("Open the Sales orders list", not "The
Sales orders list can be opened by…"). A silent step (no sentence) plays a
fixed 2.5 s — acceptable for transitions, not for content. While RECORDING,
each step holds ~0.7 s after it completes, so the screen the sentence talks
about is actually on film before the frame freezes.

## Phase 2 — VOICE (gate: voice.json exists, per flow)

`odoo_video operation=voice flow=<id> voice=<voice>` narrates every sentenced
step into `voice/<flow>/<step>.wav` — idempotent: an existing `.wav` is never
regenerated (delete it to redo one step). The voice is a string the TTS engine
understands (`es-ES-ÁlvaroNeural` for edge-tts, `es_ES-sharvard-medium` for
piper); it is recorded next to the language, not validated against it.
**Test the voice on ONE short flow first**: a wrong voice is only audible
after listening, and re-voicing is cheap (delete the `.wav`s) while a
re-capture is not.

## Phase 3 — CAPTURE (gate: capture.json with a video entry)

`odoo_video operation=capture flow=<id> allow_actions=true
confirm_destructive=true` (action steps only, disposable DB; read-only flows
run without them). Recording is ALWAYS on: the tool writes
`video/raw/<flow>.webm` plus per-step `startMs`/`endMs` timestamps and PNG
stills. A failing step aborts the run; fix the storyboard and resume with
`from_step=<the failing step id>` — the timestamps before it stay valid.

A `goto` is not done when the HTML loads: the webclient mounts the action
afterwards, so capture waits for a rendered view AND for its records before the
step counts as OK (a slow instance simply takes longer; a URL that is not a
webclient action fails with "no view rendered within 30s"). Never work around a
blank page by shortening the wait: the blank frames would land in the mp4.

## Phase 4 — ASSEMBLE

`odoo_video operation=assemble flow=<id>` cuts the webm by step, freeze-frames
each clip to the narration length, and writes `video/<flow>.mp4` (faststart)
+ `.srt` + `.vtt` (ALWAYS — they are the export path to any video platform:
Synthesia, HeyGen, YouTube…). Optional `captions=true` burns them in. The
recording starts at its first painted frame, not at the context creation, so
assembly calibrates the wall-clock step offsets against the webm's real
duration and records any lead-in it removed as `captureOffsetSeconds` in
`video/video.json`; a `goto` keeps only the tail of its window (the mounted
view), which is what keeps the loading screen out of the video. The raw
webm is kept: re-assembly with another voice or timing reads it again.

## Return contract

Report per flow: voiced steps / total, capture status (truncated at which
step, if any), the mp4/SRT/VTT paths, and the voice + language used. Never
play, upload or "improve" the mp4 with other tools; if the narration is
wrong the fix is the storyboard sentence + delete the `.wav`s + re-voice +
re-assemble.
