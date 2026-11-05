---
name: odoo-video
description: Produce a narrated VIDEO SERIES of Odoo flows with odoo_video — plan the storyboard (from the instance or imported from a manual with from_manual) which seeds coverage flows and groups, audit until 100% of the module is covered or reasoned away, narrate hook/steps/outro with a selectable voice preset (viral-male/viral-female/calm-male/calm-female/offline-piper/custom), capture the browser session with recording always on and the live page held per narration, and assemble numbered NN-title.mp4 files plus a README series index. Use when the user asks for a video, screencast or voiced walkthrough of a model or flow, alone or after a manual.
---

# Narrated flow video series (odoo_video)

A video that shows behaviour the storyboard does not describe is FORBIDDEN —
and the storyboard may only describe what the canon (or the manual it was
imported from) shows. `odoo_video` never writes `MANUAL.md`: it is a sibling of
`odoo_manual`, not a mode of it. The pipeline is plan → audit → (per flow)
voice → capture → assemble → index; a step without a `procedure` sentence
stays silent, and the series index reports coverage X/Y of the module.

Before writing ANY narration read `resources/references/video-craft.md` —
hooks, didactics, rhythm and the spoken register every sentence must meet.

## Prerequisites (report and stop when one is missing)

- **Voice preset** (`ttsPreset` config, or `ODOO_SDD_TTS_PRESET`): the voice
  the series narrates with. There is NO default — without one the tool answers
  `NEEDS_TTS` listing the presets (recommended first, cloud/offline badges) and
  the DEVELOPER chooses:
  - `viral-male`, `viral-female` (recommended) — edge-tts voices tuned for
    punchy narration, per-language voice + rate resolved for you.
  - `calm-male`, `calm-female` — same engine, flat-rate voices.
  - `offline-piper` — local Piper; set `ttsVoice` to the `.onnx` path.
  - `custom` — your own `ttsCommand`/`ttsVoice` template, verbatim.
  The four edge presets are CLOUD: the narration text goes to Microsoft. That
  is an explicit developer decision, never yours — NEEDS_TTS says so too.
  `edge-tts` installs with `pipx install edge-tts` (or `pip install edge-tts`).
- **ffmpeg**: system ffmpeg 4.x+ (config `ffmpegPath`). `NEEDS_FFMPEG` → report
  the install line. Recording additionally needs Playwright's BUNDLED ffmpeg
  (`npx playwright install ffmpeg`, a download separate from chromium).
- **A disposable database for action steps**: same rule as the manual. Read-only
  flows (goto/menu/highlight/screenshot) never need more.

## Phase 1 — PLAN (gate: storyboard.json exists)

Prefer the manual that already exists: `odoo_video operation=plan
from_manual=<slug>` copies the manual's canon + storyboard into
`<videosDir>/<video-slug>/` (import-once: it refuses to overwrite a video
storyboard — video-side edits must survive). The manual's narration becomes
the video script as-is; the language is inherited.

Without a manual: `odoo_video operation=plan model=<model> module=<module>
language=<lang>` — the module canon inventories EVERYTHING the module owns
(menus, actions, views, fields, buttons, pages, crons, automations, templates,
rules, wizards, workflows). Plan then SEEDS coverage: silent `v<N>` flows of
`highlight` steps — `procedure: null`, refs already in `covers` — grouped by
model/automation/wizard; the script is still yours to write.

The language is FIXED at plan time: param > imported manual >
`documentationLanguage` > `en_US`.

Then WRITE: `procedure` per step (one spoken sentence), `hook.text`
(cold open over the flow's end state — the formulas and the 20-word cap are in
video-craft.md), `outro.text` (closing line), `summary` (one line for the
README table) and `group` (the README section; plan guesses it from the menu
or model — re-group by feature). `HOOK-LONG`/`SENTENCE-LONG`/`FILLER` WARN on
the spoken register; lint rules live in `validateVideoStoryboard`.

## Phase 2 — AUDIT (gate: 100% covered or reasoned)

`odoo_video operation=audit` prints the coverage matrix: per-type counts,
pending seeds, declared skips and gaps. A ref is covered only by a NARRATED
step (`goto`/`menu` covers its action and the menu that opens it,
fill/select/highlight cover the field/button/page of the flow's model, `click`
covers the button, `covers[]` adds explicit refs); a seeded-but-silent step is
PENDING; `videoSkip` (storyboard key, ref → non-empty reason) is a documented
skip, never a gap. `VIDEO-COVERAGE` ERRORs until the matrix reads total 100%.
`index` fails the same way once videos exist (`COVERAGE GAPS n`).

## Phase 3 — VOICE (gate: voice.json exists, per flow)

`odoo_video operation=voice flow=<id>` narrates `_hook.wav` FIRST, every
sentenced step, then `_outro.wav` LAST into `voice/<flow>/` — idempotent:
an existing `.wav` is never regenerated (delete it to redo). The preset (or a
`voice` param) picks the concrete voice; `piper`/`custom` take `ttsVoice`.
A non-WAV payload (edge-tts writes mp3 bytes even at a `.wav` path) is
transcoded to real 24 kHz mono WAV by ffmpeg automatically.
**Test the voice on ONE short flow first** — a wrong voice is only audible
after listening.

## Phase 4 — CAPTURE (gate: capture.json with a video entry)

`odoo_video operation=capture flow=<id> allow_actions=true
confirm_destructive=true` (action steps only, disposable DB; read-only flows
run without them). Recording is ALWAYS on: `video/raw/<flow>.webm`, per-step
`startMs`/`endMs`, and `focus` rects for the assembler's zoom. The overlay
(cursor, click wave, focus ring) is injected only while recording; every PNG
is shot with it hidden. Each step holds the LIVE page for its narration
length (voice first!) — without a voice report the dwell is a fixed ~0.7 s.

`highlight` resolves a field, a header button, a notebook tab, then a plain
menu item, hovers it and rings it on film; when nothing is on screen the step
ERRORS with the probe order — never narrate what is not visible.

A failing step aborts the run; fix the storyboard and resume with
`from_step=<the failing step id>` — earlier timestamps stay valid.

## Phase 5 — ASSEMBLE + INDEX (per flow, then the series)

`odoo_video operation=assemble flow=<id>` writes `<videosDir>/<slug>/NN-titulo.mp4`
+ `.srt` + `.vtt` at the workspace ROOT (numbered/grouped by `numberFlows`),
merges `video/series.json` and refreshes `README.md` when ≥2 videos exist.
The default dressing: entry zoom toward each step's `focus`, burned pill
captions (`captions=false` disables — srt/vtt always ship), chapter pill the
first 3 s, hook title card, outro "next" pill, synthesized SFX + music bed
with voice ducking (`music`/`sfx` params or the `videoMusic`/`videoSfx`
config), and 2-pass `loudnorm` to −14 LUFS.

`odoo_video operation=index` regenerates the README (groups, durations,
progress checkboxes, coverage section, suggested routes) and reports orphan
`NN-*.mp4/.srt/.vtt` files. It is `ok:false` while coverage gaps remain —
the README still documents them.

## Return contract

Per flow: voiced steps / total, capture status (truncated at which step, if
any), the mp4/srt/vtt paths (new numbered stem), assembly flags (hook, outro,
zoom, captions, music, sfx) and the measured LUFS. Per series: coverage X/Y,
pending seeds, declared skips, orphans. Never play, upload or "improve" the
mp4 with other tools; if the narration is wrong the fix is the storyboard
sentence + delete the `.wav`s + re-voice + re-assemble.
