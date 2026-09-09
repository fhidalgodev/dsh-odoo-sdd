---
name: odoo-sdd-workflow
description: Spec-Driven Development pipeline for Odoo modules on top of the dsh-odoo-sdd plugin. Use when developing, verifying, or fixing an Odoo module against a live instance with formal acceptance criteria. Enforces the 5-phase protocol with fail-closed gates, honest verdicts, and bounded fix loops.
---

# Odoo SDD Workflow (5 phases)

Mandatory protocol when using the `dsh-odoo-sdd` plugin. The specification is
the single source of truth and immutable: **the code adapts to the spec, the
spec never adapts to the code**.

## Global rules (non-negotiable)

1. **Credentials**: live only in the gitignored `.env` (chmod 600). NEVER ask
   for URL/user/password through chat, never write them into specs, logs,
   commits or code. If `odoo_connect` reports "NOT CONFIGURED", tell the
   developer to complete `.env` from `.env.example`.
2. **Disposable database**: the connected instance is dev/staging. Before
   phase 4, confirm with the developer that the database may receive
   installs/upgrades and test data.
3. **Fail-closed**: gated phases (`READ_SPEC`, `ARCHITECTURE`) advance only
   with the explicit `APPROVED` marker via `sdd_phase advance`. Ambiguity is
   never approval.
4. **Honest verdicts**: every verification persists through
   `sdd_phase fail|succeed`. A failure is NEVER reported as success. `DONE`
   is unreachable without a `PASSED` verdict on disk.
5. **Failure ladder**: 3 consecutive failures ⇒ `requireDiagnosis=true` ⇒ a
   consultant subagent must run root-cause analysis BEFORE another retry.
   Blind retries are forbidden.
6. **Iteration ceiling**: 5 verify/fix iterations per spec. On exhaustion the
   machine goes `BLOCKED`: escalate to the human with the KB and last verdict.
7. **stop.md**: if this file exists in the spec directory, stop immediately
   and report its content.
8. **Commits**: never automatic. Follow the project's contribution guidelines
   and the developer's own rules (message format, authorization policy).

## Tooling prerequisites (verify, then suggest)

Before phase 3, check the agent's skill catalog:

- **Odoo pattern skill**: a version-pinned Odoo patterns skill (e.g.
  `odoo-development-skill` or `unclecatvn/agent-skills`) should be available.
  If none is installed, SUGGEST installing one and continue only with explicit
  developer approval, e.g.:
  `npx skills add fhidalgodev/odoo-development-skill`
  Never silently require a specific third-party skill: this workflow must
  work without it (fall back to official Odoo documentation, see phase 2).
- **Playwright MCP** (optional, phase 4 UI layer): if the agent has no
  browser tool available, tell the developer UI click-testing is unavailable
  and mark UI scenarios in `test-plan.md` for manual verification instead of
  skipping them silently.
- **Specialist personas** (bundled): the pipeline assigns one role per
  subagent. Load its persona file and read it as the subagent's constitution:
  - `agents/architect.md` — designs `architecture.md` + `test-plan.md` (no
    code).
  - `agents/developer.md` — implements the approved design (no spec changes).
  - `agents/qa.md` — verifies per AC, honest verdicts, never repairs.
  - `agents/consultant.md` — deep root-cause analysis (failure ladder).
  - `agents/human-proxy.md` — answers gates in AUTONOMOUS mode (fail-closed).
  A missing persona file (broken package) → degrade to an inline role prompt;
  never silently run a role without its limits.
- **Logbook first**: before proposing ANY change, read the logbook
  (`kb.json`) — prior decisions, discarded options, blockers. Respect settled
  decisions or explicitly justify overriding one. `sdd_phase status` shows the
  recent logbook summary.

## Phase 1 — READ_SPEC

0. **Instance onboarding (once per project)**: run `odoo_setup mode=check`.
   If it reports `needs-setup` (or `deferred` while the developer is
   present), ask the developer ONCE how to proceed:
   - **Configure now** → collect ONLY the non-secret fields (url, db,
     username, scope) and run `odoo_setup mode=interactive`; the developer
     then fills `ODOO_PASSWORD` directly in the generated file. Never ask
     for the secret in chat.
   - **Configure later** → `odoo_setup mode=later` (re-asked before phase 4).
   - **Skip** → `odoo_setup mode=skip` (no instance; see the degraded path
     in phase 4).
   The decision is persisted — do not re-ask on later sessions unless
   `odoo_setup mode=reset` was used.
0b. **Delegation mode (once per project)**: ask the developer how much of the
   pipeline to delegate, and record it:
   - **Supervised** (default) → gates are answered by the HUMAN at each
     phase (`approval_source=human`).
   - **Autonomous** (siesta-style: human answers the initial interview then
     leaves) → run `odoo_setup mode=autonomy decision=autonomous`. Phase
     gates are answered by the **human-proxy** agent
     (load `agents/human-proxy.md`); only a line-start `APPROVED` advances
     (fail-closed). **Restrictions in autonomous mode:**
     - You may NOT call `ask_user_question` except for initial onboarding
       and BLOCKED escalation.
     - Create a DSH **goal** (`create_goal`) for the spec so rounds continue
       unattended; state is already on disk.
     - `stop.md`, iteration ceilings and the diagnosis ladder stay armed;
       BLOCKED is the ONLY way to page the human.
     - If the instance is `skipped`/unconfigured, you cannot self-certify
       RPC/UI layers: reverify restrictions push to BLOCKED at phase 4 unless
       the acceptance criteria are fully verifiable without an instance.
1. `sdd_phase init spec_id=<NNN>-<slug>` (first run).
2. Write/read `specs/<id>/spec.md`: business context, numbered acceptance
   criteria (AC1, AC2...), constraints, target Odoo version.
3. Interview the developer with concrete questions wherever ambiguous.
4. Detect the Odoo version: `__manifest__.py` of the project, or
   `odoo_connect` → `serverVersion` (only when an instance is configured).
   Record it in `spec.md`.
5. **Writing implementation code in this phase is forbidden.**
6. When the spec is complete: review it, ask the developer for approval and
   only with an explicit yes:
   `sdd_phase mark_spec_loaded` → `sdd_phase advance next_phase=ARCHITECTURE approval_marker=APPROVED`.

## Phase 2 — ARCHITECTURE

1. **Do not reinvent the wheel** — search existing functionality BEFORE
   designing anything:
   - **Odoo Community source** on GitHub by version:
     `https://github.com/odoo/odoo/tree/<V>.0/addons` (replace `<V>` with the
     target major, e.g. `18.0`).
   - **Odoo Enterprise** (only if the developer has access):
     `https://github.com/odoo/enterprise` (branch `<V>.0`).
   - **OCA repositories**: search `https://github.com/OCA` by keyword and by
     domain (`account-financial-tools`, `stock-logistics-workflow`,
     `sale-workflow`, `server-ux`, `l10n-<country>`, ...).
   - If the developer maintains local checkouts of these sources, search them
     first (faster); never assume any specific local path exists.
2. Write `specs/<id>/architecture.md`:
   - New/inherited models, fields, relations (Many2one/One2many), constraints,
     computed + depends.
   - Views (XML IDs to inherit — never replace), menus, actions.
   - Security: groups, `ir.model.access.csv`, record rules.
   - Directory layout and exact `__manifest__.py` depends.
   - Localization: if extending a country localization, use the
     `l10n_<country>_` prefix convention on models/fields/methods.
3. Derive `specs/<id>/test-plan.md`: one scenario per acceptance criterion,
   marking which are verifiable via RPC/data and which need UI (Playwright).
4. **Scaffolding**: if the module is brand new, prefer the OCA repository
   template (`https://github.com/OCA/oca-addons-repo-template`, applied via
   copier) so the project ships pre-commit, pylintrc and CI. If the target
   project already has a template or its own conventions, follow those
   instead — never assume a local copy exists.
5. Present the design to the developer; with explicit approval:
   `sdd_phase advance next_phase=WRITE_CODE approval_marker=APPROVED`.

## Phase 3 — WRITE_CODE

1. Implement `architecture.md` (Python, XML, JS/OWL, security). Code,
   variables and docstrings in ENGLISH.
2. Apply version-pinned syntax for the target Odoo version. If a patterns
   skill is installed (see prerequisites), consult it for the exact API;
   if unsure, verify against the official source (phase 2 links) or
   `https://www.odoo.com/documentation/<V>.0/` — never guess deprecated
   syntax (e.g. `<tree>` vs `<list>`, `attrs` vs direct expressions).
3. **Module documentation**: generate `README.rst` and `index.html` following
   the OCA format, written in the project's documentation language (or the
   language the developer requests). Take author/maintainer data from the
   project's own conventions (`.pylintrc`, `__manifest__.py` maintainers,
   LICENSE, or the developer's instruction) — never hardcode any specific
   person.
4. Static gates BEFORE touching the instance (fast, cheap):
   - `odoo_validate module_dir=<module>` — local structural check (manifest,
     declared XML, ACL csv) with no server required
   - `pre-commit run -a` if the repo has the OCA template configured
   - `pylint --rcfile=.pylintrc-mandatory <module>/` when the file exists
   - `ruff check <module>/` on Odoo 18+ projects using it
   - XML syntax validation of every view file
5. `odoo_module operation=info modules=['<module>']` — confirm the instance
   actually sees the code (correct addons path / deployment).
6. `sdd_phase advance next_phase=VERIFY`.

## Phase 4 — VERIFY (closed feedback loop)

0. **Setup re-check**: run `odoo_setup mode=check`.
   - `deferred` → ask the developer to configure now (`mode=interactive`)
     or explicitly confirm skipping.
   - `skipped` / unresolved `needs-secret` → DEGRADED PATH: layers 2–4
     become manual developer checks. Record in `test-plan.md` exactly which
     scenarios the developer verified by hand, and `sdd_phase succeed` must
     cite that human confirmation in its `detail`. The honest-verdict rule
     still applies: without any confirmation, report `fail` — never success.

Verification pyramid, ALWAYS in ascending order:

1. **Layer 1 (static)**: already passed in phase 3 (`odoo_validate` + lints).
   If it fails, do not continue.
2. **Layer 2 (server)**: `odoo_module operation=install` (or `upgrade`).
   - Success ⇒ confirm state `installed` via `operation=info`.
   - Traceback ⇒ `odoo_errors` for the full server log ⇒ `sdd_phase fail`
     with the concrete error ⇒ go to phase 5.
3. **Layer 3 (data/RPC)**: exercise business logic via `odoo_execute` reads
   (search_read/read/search_count) and, only for allowlisted models with
   `confirm_destructive=true`, the mutations the test-plan needs. Compare
   results against each AC.
4. **Layer 4 (UI, critical flows only)**: `odoo_session` ⇒ load the cookie
   from `.sdd/session.json` into Playwright's browser context, navigate past
   `/web/login`, and execute the UI scenarios from test-plan.md. Capture:
   Odoo Server Error modals, console tracebacks, non-rendering elements.
5. All green per AC by the QA persona ⇒ `sdd_phase succeed detail="<per-AC
   summary>"` ⇒ `sdd_phase advance next_phase=DONE`.
6. Any failure ⇒ `sdd_phase fail detail="<concrete error>"` ⇒ phase 5.
   (Gated advances pass `approval_source` — `human` in supervised mode, the
   human-proxy's verdict in autonomous mode.)

## Phase 5 — FIX_LOOP

1. Read state: `sdd_phase status`. Respect `requireDiagnosis`.
2. **No pending diagnosis**: analyze traceback/log against `architecture.md`,
   fix the defective fragment (NEVER the spec), re-run static gates, return to
   phase 4.
3. **With `requireDiagnosis=true`**: launch a **consultant** subagent (load
   `agents/consultant.md`) with spec.md + architecture.md + the last 3 KB
   errors + the implicated code. Demand the root cause (not symptoms) and a
   fix plan; register the conclusion as a `diagnosis` node and any rejected
   approach as a `discarded` node. No blind retries after diagnosis.
4. Regression: before accepting a fix, re-verify already-passed ACs — never
   build on a broken base.
5. `BLOCKED` or ceiling reached ⇒ stop and hand to the developer: KB state,
   last FAILED verdict and diagnosis.

## Per-spec artifacts

```
specs/<NNN>-<slug>/
├── spec.md             # immutable after APPROVED
├── architecture.md     # approved design
├── test-plan.md        # scenarios per AC
├── verify-verdict.txt  # honest persisted verdict (PASSED/FAILED + date)
├── state.json          # phase, failures, iterations
└── kb.json             # decisions, blockers, diagnoses, learnings
```
