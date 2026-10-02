---
name: odoo-sdd-workflow
description: Spec-Driven Development pipeline for Odoo modules on top of the dsh-odoo-sdd plugin. Enforces the 5-phase protocol with fail-closed gates, honest verdicts, and bounded fix loops.
whenToUse: Select this skill when the request is about developing, verifying, fixing, or auditing an Odoo module or an Odoo data model/security concern against a live instance, including the Odoo SDD workflow (spec, architecture, code, verification). Do not select it for tasks unrelated to Odoo — use it only when the deliverable is an Odoo module.
---

# Odoo SDD Workflow (CLARIFY + 5 phases)

Mandatory protocol when using the `dsh-odoo-sdd` plugin. The specification is the
single source of truth and immutable: **the code adapts to the spec, the spec
never adapts to the code**.

This body is the ROUTE: what the phases are, who owns each one, what is gated and
how a run closes. The WORK of a phase lives in the role that owns it — load
that file before executing the phase, never improvise its role.

## Where files live (never assume — it is reported)

The **project root is the folder open in the current session** (session cwd), not
a plugin-wide setting. Every tool result ends with a `Project root: <path>
[<provenance>]` line: read it. Fallback order: session cwd → root declared in
`.sdd/config.json` (or Settings/deployment) → process cwd, and the last is
reported as `LAST RESORT`. No tool takes a "work on that other folder" argument:
to work on another project, open that project's folder in a session.

Two spec layouts, chosen by the developer (Settings → Specs, or `odoo_config
mode=set specsMode=...`):

- `project` (default): `<projectRoot>/<specsDir>/<specId>` — specs travel with the code.
- `central`: `<specsRoot>/<projectSlug>/<specId>` — one folder per project, each
  with a `.dsh-project-root` marker; the slug may carry a hash on a name collision.

`.sdd/` (config, credentials, grants, audit, checkpoints, active run) ALWAYS stays
with the project. In this document `specs/<id>/...` means "the reported spec
directory": ask `odoo_config mode=read` or `sdd_phase status` for the real paths.

## Is this even a development job?

This workflow ends in **code**: a module (new or fixed) installed and verified on
a running instance. Check that BEFORE phase 1 — the mode is frozen once the spec
is loaded:

| The request is about… | Path |
|---|---|
| creating, extending, fixing or auditing a module, model, view or security rule | **this skill** (`mode=create` or `mode=bug`) |
| configuring an existing instance (company, users/access, taxes/localisation, routes, POS) or loading data into it (CSV/Excel imports, master data) | **`odoo-functional-sdd`** (`mode=functional`) |
| both — a configuration that also needs code | two specs: the functional one runs first and records the gap, then a technical spec is proposed and authorised separately |

If a development spec turns out to be configuration, do not stretch this
workflow: close or park the spec honestly and open a `functional` spec.

## Global rules (non-negotiable)

1. **Credentials**: live only in the gitignored `.env` (chmod 600). NEVER ask for
   URL/user/password through chat, never write them into specs, logs, commits or
   code. `NOT CONFIGURED` ⇒ tell the developer to complete `.env` from
   `.env.example`. `NOT AUTHORIZED` ⇒ credentials exist but no human authorized
   the target: run `odoo_setup mode=authorize` and let them approve.
   **Possessing credentials is never authorization.**
2. **Disposable database**: the connected instance is dev/staging. Before the
   VERIFY phase, confirm with the developer that it may receive installs/upgrades
   and test data.
3. **Fail-closed gates**: `READ_SPEC` and `ARCHITECTURE` advance only through the
   host's native approval. The model cannot self-approve: `approval_source` and
   `approval_marker` are a DECLARATION, and the plugin asks the human itself.
   When the host exposes no approval seam, only a literal `APPROVED` marker
   advances, and the answer says so.
4. **Honest verdicts**: every verification persists through `sdd_phase
   fail|succeed`. A failure is NEVER reported as success. `DONE` needs a `PASSED`
   verdict on disk, coverage of every AC the spec declares, and evidence that did
   not change after it was recorded.
5. **Failure ladder**: 3 consecutive failures ⇒ `requireDiagnosis=true` ⇒ a
   consultant root-cause analysis must be RECORDED before the next retry. The
   streak survives the `fail → FIX_LOOP → VERIFY` cycle; only a success or a
   recorded diagnosis starts it over.
6. **Iteration ceiling**: 5 verification attempts per spec — the budget counts
   attempts to VERIFY, not phase hops. On exhaustion the machine goes `BLOCKED`:
   escalate with the KB and the last verdict.
7. **stop.md**: if it exists in the spec directory or in `.sdd/`, stop immediately
   and report its content.
8. **Commits**: never automatic. Follow the project's contribution guidelines and
   the developer's rules (message format, authorization policy).

## Who owns which phase

Load the role file as the subagent's constitution before that phase runs. A
missing role file (broken package) ⇒ degrade to an inline role prompt; never run
a role without its limits.

| Phase | Owner | What it produces |
|---|---|---|
| CLARIFY | you, with the developer | `mode`, `licensed`, the security interview |
| READ_SPEC | you, with the developer | `spec.md` (context, numbered ACs, constraints, target version) |
| ARCHITECTURE | `roles/architect.md` | `architecture.md` + `test-plan.md` |
| WRITE_CODE | `roles/developer.md` | the module: code, views, security, documentation |
| VERIFY | `roles/qa.md` (+ `roles/security-reviewer.md`, `roles/documentation.md`) | per-AC evidence, `security-report.md`, `docs-report.md` |
| FIX_LOOP | `roles/consultant.md` when a diagnosis is owed | the recorded root cause and the fix plan |
| any gate | `roles/human-proxy.md` | the gate verdict in AUTONOMOUS mode only |

**Tooling prerequisites (verify, then suggest)**: an Odoo pattern skill
(version-pinned) helps for phase 3 — if none is installed, SUGGEST one and
continue only with explicit approval (`npx skills add fhidalgodev/odoo-development-skill`);
without it, fall back to official Odoo documentation. A browser tool is optional
and only affects the UI layer of phase 4 (mark those rows for manual verification
instead of skipping them silently). **Logbook first**: read `kb.json` (or
`sdd_phase status`) before proposing ANY change — respect settled decisions or
justify overriding them.

## The route

Each row is a phase: its promise, and the file that owns the how.

| # | Phase | Deliverable and gate |
|---|---|---|
| 0 | `CLARIFY` | `sdd_phase status`; the pipeline CANNOT leave it until `mode` + `licensed` are confirmed (`sdd_phase clarify`) → `advance next_phase=READ_SPEC`. In SUPERVISED mode interview the developer (`ask_user_question`): create or bug, licensing, the security questions, TRANSLATIONS (see below), and an explicit "proceed?". In AUTONOMOUS mode detect `mode`/`licensed` from the request; if they are not confidently determinable, `advance next_phase=BLOCKED` — never invent them. |
| 1 | `READ_SPEC` | Onboarding once per project (`odoo_setup mode=check` → configure now / later / skip, and `mode=authorize` for the target, and `mode=autonomy` for delegation). Write `spec.md` with these sections (the runtime refuses the advance without them): `## Context`, `## Acceptance Criteria` (numbered `- [ ] AC1: …` — the closing gate matches them against `test-plan.md` row by row), `## Constraints`, `## Target Odoo Version`. **No implementation code in this phase.** Gate: `mark_spec_loaded` → `advance next_phase=ARCHITECTURE` with the host's approval (native when available). |
| 2 | `ARCHITECTURE` | `search before designing` — Odoo Community source for the target version, Enterprise only if licensed, and ALWAYS the OCA repositories. `roles/architect.md` owns the required sections (`## Models`, `## Views`, `## Tours`, `## Demo data`, `## Security`, `## Manifest`, `## Reports`, `## Documentation`), the per-model view-type decision, the reports, the design interview and the OCA module skeleton (`README.rst` + `static/description/index.html`) that `roles/documentation.md` writes. When CLARIFY declared `translations`, this phase also fixes WHICH strings are translatable (`translate=True` on the fields that carry user-visible text, `_()` on the Python literals) — the export can only find what is marked. The `## Security` decision and a real (non-comment) `## Documentation` decision are the two content gates this phase enforces. Derive `test-plan.md`, one row per AC. Gate: `advance next_phase=WRITE_CODE` with approval. |
| 3 | `WRITE_CODE` | `roles/developer.md` implements the approved design (English code/docstrings, version-pinned syntax, OCA ordering). Static gates before touching the instance: `odoo_validate`, `odoo_docs operation=check`, and the repo's own pre-commit/pylint/ruff when present. Confirm the instance sees the code (`odoo_module operation=info`). **Checkpoint before mutating** (the guard refuses otherwise). Then `advance next_phase=VERIFY`. |
| 4 | `VERIFY` | `roles/qa.md` walks the pyramid in ascending order — static, server (`odoo_module install|upgrade`, `odoo_errors` on traceback), data/RPC (`odoo_execute`: reads first, `fields_get` before asserting, `read_group` for aggregates, `context` on multi-company), security review, UI. Every AC row must read `pass` before `sdd_phase succeed`. Any failure ⇒ `sdd_phase fail` ⇒ phase 5. |
| 5 | `FIX_LOOP` | Respect `requireDiagnosis`: when the ladder trips, the retry is refused until the analysis is RECORDED (`sdd_phase operation=diagnose`). Without one: analyze against `architecture.md`, fix the defective fragment (**never** the spec), re-run static gates, return to phase 4. Prefer `sdd_phase operation=rollback` over layering another guess on a broken state. `BLOCKED` or ceiling ⇒ stop and hand over. |

**When the design itself is wrong**, do not quietly rewrite it: the spec is
immutable after approval and the phase graph has no way back. Stop the run
(`BLOCKED`), say why, and propose a SUCCESSOR spec that carries the corrected
design — linked in the KB and in the handoff. Never lower an acceptance criterion
to reach green.

### The translation question (CLARIFY)

Ask it in the interview like `licensed`, and record the answer with the intent:

> `sdd_phase operation=clarify spec_id=<id> mode=… licensed=… translations=["es_VE","es_PA"]`

- **If CLARIFY recorded `translations`, the spec must say WHY those languages** (a client in Venezuela, a country rollout), and the `i18n/` files are part of the deliverable, not a bonus.
- **Omit `translations` when the work is not translated.** That is a normal answer (an internal fix), not a missing one: unlike `mode` and `licensed`, this is NOT a fail-closed gate.
- The languages are **gettext codes** (`ll` or `ll_CC`: `es_VE`, `es_PA`, `pt_BR`, `fr`). A malformed code is refused while it can still be corrected.
- They are recorded **per spec**, like the edition: one workspace can hold a Spanish-for-Venezuela client project and an untranslated internal one.
- When languages are declared, `test-plan.md` needs the matching acceptance criterion: *"`i18n/<lang>.po` exists and no exported term is left with an empty `msgstr`"* — `odoo_i18n operation=check` is what verifies it.
- Generating and updating those files is `odoo_i18n operation=export`: the terms come from Odoo's OWN export models, so the list stays correct as the module changes. It never overwrites a translation a person wrote.

## A new request after the run closed (the intake rule)

A request that arrives AFTER the pipeline closed ("now also change X") is a NEW
change: the finished spec does not authorize it, and with `requireSpecForChanges`
(default true) the guard refuses the Odoo tools AND the file editors until
something does. Decide the intake in one line BEFORE touching anything and say
which one you took:

1. **It does not fit the closed spec.** Do not reopen it: `DONE` stays the honest
   verdict of what was verified. A follow-up is its own spec.
2. **Small change** (a bug, a tweak, one behaviour): open a SMALL spec —
   `sdd_phase operation=init spec_id=<NNN>-<slug> mode=bug`. Short by
   construction, but still a spec: `spec.md` keeps its required sections and ONE
   acceptance criterion (`- [ ] AC1: …`), `test-plan.md` gets its row, and the
   phases are walked. Then `mark_spec_loaded` → `advance next_phase=WRITE_CODE`.
3. **The developer said not to spec it** ("do it your way", "no spec for this"):
   take the waiver — `sdd_phase operation=waive detail="<their exact words>"`. It
   needs THEIR approval, covers THIS session only, and you still record every
   change as a KB decision with how it was verified.
4. **The policy is off** (`requireSpecForChanges: false`, set by the developer):
   only then change things with neither spec nor waiver.

**Where it applies** (`specPolicyScope`, default `odoo`): a file edit is gated
only where the directory shows Odoo work — `.sdd/` with real plugin state (NOT
just `audit.jsonl`, which every tool call writes), a `__manifest__.py` here or one
level down, or an `odoo_*` tool already used here. An instance mutation is ALWAYS
gated: the `odoo_*` call is the evidence. Work unrelated to Odoo is not in the
plugin's way. `odoo_config mode=read` reports `specPolicyArmed` and why.

**A waiver needs no spec.** `sdd_phase operation=waive detail="…"` works where
there are no specs at all — the case it exists for — and `spec_id` is optional for
it and `waive revoke=true`; every other operation still requires one. It covers
the SESSION that asked, so a subagent stays under the policy: for work that spans
subagents, ask the developer for `requireSpecForChanges: false` in that project.

Never route around a refusal — no writing files through `bash`, no flipping the
policy yourself, no editing `.sdd/active.json`. The refusal names the three ways
out; take one, or ask. Whatever the intake: a checkpoint before mutating the
instance, an honest verdict, and the handoff updated.

## Closing the run (DONE or BLOCKED)

Before you stop, ALWAYS run `sdd_handoff spec_id=<id> summary="<one line>"`: it
records the final phase, the honest verdict, the KB decisions/blockers, the
checkpoints, the journaled data operations, the configuration in effect and the
next steps into `specs/<id>/handoff.md`. Then report to the developer: what was
delivered, what is verified, what is NOT (and why), and which checkpoint to roll
back to. A run that is still `BLOCKED`, in progress, or carrying an unresolved
indeterminate operation is never presented as verified.

## Per-spec artifacts

```
specs/<NNN>-<slug>/
├── spec.md             # immutable after APPROVED
├── architecture.md     # approved design (incl. the DECIDED ## Security model)
├── test-plan.md        # one row per AC, with the real result
├── docs-report.md      # documentation verdict (required when documentationPolicy=required)
├── security-report.md  # security review verdict (required when securityReviewRequired)
├── verify-verdict.txt  # honest persisted verdict (PASSED/FAILED + date)
├── handoff.md          # generated by sdd_handoff when the run closes
├── state.json          # phase, failures, iterations, evidence fingerprints
└── kb.json             # decisions, blockers, diagnoses, learnings

Outside the spec directory (plugin-owned, shared by the run):
.sdd/config.json        # persisted config (repos, allowlist, policy flags)
.sdd/active.json        # pointer to the active spec + checkpoint (the PHASE lives in state.json)
.sdd/waiver.json        # developer-approved exemption from the spec policy (THIS session only)
.sdd/checkpoints/<id>/  # file snapshots + data journal (rollback surface)
.sdd/audit.jsonl        # append-only record of EVERY tool call
```
