---
name: odoo-user-manual
description: Write a narrated Odoo user manual built ON EVIDENCE with odoo_manual — read the functional canon first, plan the storyboard against it, narrate (3 acts), capture screens, compile and audit. Use when the user asks for a user manual, guide, or OCA-ready documentation for a model or flow.
---

# Narrated user manual (odoo_manual)

A manual that describes behaviour the canon does not show is FORBIDDEN.
Every fact comes from the instance (operation=canon), from the cited code or from
a capture. The route has 5 phases with gates; do not advance a phase without
closing the previous one.

## Phase 1 — CANON (gate: canon.json exists)

Call `odoo_manual operation=canon model=<model>` (with spec_id, module_dir or
the configured manualsMode to resolve the workspace). If the tool returns
BLOCKED or NEEDS_INSTANCE, report it and stop: do NOT invent the view, the
buttons or the states. Read the full canon summary before writing a single
sentence: buttons with `visibleStates`, required fields, groups and the error
catalogue.

## Phase 2 — PLAN (gate: storyboard validated with no ERROR)

`odoo_manual operation=plan` generates the skeleton (goto → new → fill required →
header buttons in state order). Audience:

- **Bottom-up by use case**: what is the user trying to achieve? One flow
  per case, not one flow per button.
- **Top-down by res.groups**: assign `role` when the canon read groups; if a
  group does not see the button, do not narrate it for that role.

Diátaxis structure → CONTEXT, CONFIGURE, USAGE. Information Mapping: separate
Procedure (the user's steps) from Process (what Odoo does: it goes as a quote).
After narrating, `operation=lint`: the structural rules
(`procedure-one-sentence`, `heading-in-narrative`, `ACTS-MISSING`,
`RECOVERY-MISSING` with raise evidence) are ERROR; the rest is a warning.

**Approval gate**: in `supervised` mode, the developer approves the
outline (flows and titles) and then the narrated storyboard before capturing. In
`autonomous` mode, the storyteller role (resources/roles/storyteller.md) reviews
in audit mode and human-proxy authorizes the result.

## Phase 3 — NARRATIVE

Three acts: I CONTEXT (what for, who), II USAGE (procedure: 1 sentence per
step + 1 image), III RESOLUTION (error table from the canon + recovery).
Levers: lead with insight, gap vs gain (with a number or label from the canon,
never empty rhetoric), tension-turn-reward in act III. "What Odoo does"
goes as a quote, not as a step. Full reference:
resources/references/manual-writing.md. Language: the project's
(documentationLanguage); never mix languages in one flow.

## Phase 4 — CAPTURE (Motor 3)

1. Before writing ANY generic destination in the storyboard, run `operation=explore` over every destination screen (`menu`, `record_model`+`record_id` or `url` from the same origin) and copy from `explore.txt` the EXACT xml ids, button names and labels. A guessed destination = a step that fails during capture.
2. Add to each flow `screenshot` steps with a ONE-sentence `procedure`. Run `operation=capture` (read-only: `goto/menu/wait/assert/explore/screenshot/confirm` always run).
3. If the capture stops at a step, fix the storyboard and resume with `from_step`.
4. `allow_actions=true` ONLY with a disposable database AND `confirm_destructive=true`: the guard classifies that call as a mutation (checkpoint + spec in WRITE_CODE/VERIFY/FIX_LOOP or waiver, same as a business action) and the clicks are NOT journalable — there is no undo. Read `resources/references/manual-capture.md` for UI families, privacy (demo DB; `static/description` is public) and web session (`NEEDS_WEB_SESSION` with an API key).

## Phase 4b — IMPORT A RECORDING (if one already exists)

If the user already has an `npx playwright codegen` recording, `operation=import`
turns it into a flow (`recording` path INSIDE the project): the steps come in
with `procedure: null` and the raw locator in `note`, so naming the
field/button against the canon and writing the sentence is still the
storyteller's job. A recording with credentials (passwords, cookies,
`Authorization`) is REFUSED: ask for a recording over an already authenticated
session, without the login step. `replace=true` only when the user confirms that
the existing flow is replaced.

## Phase 5 — COMPILE AND AUDIT

`odoo_manual operation=render` writes MANUAL.md and index.html (files edited by
hand are not overwritten without `overwrite=true`). Run `operation=lint` again.
**The final verdict comes from `odoo_docs report`, never from this skill.**
If the manual lives in a module (manualsMode=module), the fragments start at `##`
and pass the odoo_docs rules (H1 from the OCA bot, images that exist, mandatory
alt).

## Return contract

Report: phases completed, open lint findings (rule + severity),
artifacts written and what is still pending human approval. When delegating to
subagents ask for SUMMARIES, not context dumps.
