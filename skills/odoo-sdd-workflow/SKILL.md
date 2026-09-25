---
name: odoo-sdd-workflow
description: Spec-Driven Development pipeline for Odoo modules on top of the dsh-odoo-sdd plugin. Enforces the 5-phase protocol with fail-closed gates, honest verdicts, and bounded fix loops.
whenToUse: Select this skill when the request is about developing, verifying, fixing, or auditing an Odoo module or an Odoo data model/security concern against a live instance, including the Odoo SDD workflow (spec, architecture, code, verification). Do not select it for tasks unrelated to Odoo — use it only when the deliverable is an Odoo module.
---

# Odoo SDD Workflow (CLARIFY + 5 phases)

Mandatory protocol when using the `dsh-odoo-sdd` plugin. The specification is
the single source of truth and immutable: **the code adapts to the spec, the
spec never adapts to the code**.

Nothing starts (implementation, or even spec drafting) until **CLARIFY** has
resolved the intent — unless the pipeline is in AUTONOMOUS mode, where the
intent is detected from the request.

## Where files live (never assume — it is reported)

The **project root is the folder open in the current session** (the session
cwd), not a plugin-wide setting: open another folder and the tools act there.
Every tool result ends with a `Project root: <path> [<provenance>]` line; read
it instead of guessing. The fallback order is: session cwd → root declared in
`.sdd/config.json` (or the deployment/Settings value) → process cwd, and the last
one is reported as `LAST RESORT`, meaning the session cwd was unavailable. No
tool takes a "work on that other folder" argument: to work on another project,
open that project's folder in a session.

Two spec layouts exist, chosen by the developer (Settings → Specs, or
`odoo_config mode=set specsMode=...`):

- `project` (default): `<projectRoot>/<specsDir>/<specId>` — specs travel with
  the code.
- `central`: `<specsRoot>/<projectSlug>/<specId>` — every project's specs are
  collected in one folder, each project in its own subfolder carrying a
  `.dsh-project-root` marker. `<projectSlug>` may carry a hash suffix when two
  projects share a directory name.

`.sdd/` (config, credentials, grants, audit, checkpoints, active run) ALWAYS
stays with the project, in both layouts. A `sdd_checkpoint create` snapshots the
PROJECT tree, so with the central layout the spec documents are not part of that
snapshot — deliberate: the spec is the immutable source of truth and is never
rolled back. Ask `odoo_config mode=read` (it returns
`resolved.projectRoot`, `resolved.rootSource`, `resolved.specsBase`,
`resolved.specDir` and the config file path) or `sdd_phase status` (it echoes
the spec directory and the specs location) when you need concrete paths. In this
document `specs/<id>/...` means "the reported spec directory".

## Is this even a development job?

This workflow ends in **code**: a module (new or fixed) that is installed and
verified on a running instance. Before phase 1, check that the request really is
that, because the two paths are not interchangeable and the mode is frozen once
the spec is loaded:

| The request is about… | Path |
|---|---|
| creating, extending, fixing or auditing a module, a model, a view or a security rule | **this skill** (`mode=create` or `mode=bug`) |
| configuring an existing instance (company, users/access, taxes/localisation, routes, POS) or loading data into it (CSV/Excel imports, master data migration) | **`odoo-functional-sdd`** (`mode=functional`) |
| both — a configuration that also needs code | two specs: the functional one runs first and records the gap, then a technical spec is proposed and authorised separately |

If you already started a development spec and the work turns out to be
configuration, do not stretch this workflow: record what happened, close or park
the spec honestly, and open a `functional` spec with its own id.

## Global rules (non-negotiable)

1. **Credentials**: live only in the gitignored `.env` (chmod 600). NEVER ask
   for URL/user/password through chat, never write them into specs, logs,
   commits or code. If `odoo_connect` reports "NOT CONFIGURED", tell the
   developer to complete `.env` from `.env.example`. If it reports
   "NOT AUTHORIZED", the credentials exist but no human has authorized the
   target: run `odoo_setup mode=authorize` and let the developer approve.
   **Possessing credentials is never authorization.**
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
  - `agents/security-reviewer.md` — permission model + code-security gate
    (groups, ACL, record rules, risky patterns); produces `security-report.md`.
  - `agents/documentation.md` — OCA readme fragments, Diátaxis audiences,
    index.html, Google docstrings and the mandatory changelog.
  - `agents/human-proxy.md` — answers gates in AUTONOMOUS mode (fail-closed).
  A missing persona file (broken package) → degrade to an inline role prompt;
  never silently run a role without its limits.
- **Logbook first**: before proposing ANY change, read the logbook
  (`kb.json`) — prior decisions, discarded options, blockers. Respect settled
  decisions or explicitly justify overriding one. `sdd_phase status` shows the
  recent logbook summary.

## Phase 0 — CLARIFY (intent first)

Run `sdd_phase status`. The pipeline starts in `CLARIFY` and **cannot leave it
until `mode` and `licensed` are confirmed** (the `sdd_phase clarify` gate is
fail-closed — in SUPERVISED mode it never auto-advances).

**Intake first: is this a new change?** With a spec already active, decide
whether the request is part of it (same acceptance criteria → continue it) or a
NEW change — a follow-up edit, a second bug, "now also do X". A new change gets
its OWN spec (`sdd_phase operation=init spec_id=<NNN>-<slug>`, `mode=bug` for a
small one: one acceptance criterion, no design interview). Only a spec in a
writing phase authorizes changes, and a `DONE` spec never does; the developer's
"leave it to your judgement" is the waiver (`sdd_phase operation=waive`). See
"A new request after the run closed" below.

1. **Mode** — what is this run for?
   - `create` — build a new module from a spec.
   - `bug` — resolve a defect on an existing module. Record the bug, locate the
     affected module/files, reproduce if possible, then the failure ladder +
     consultant root-cause (phase 5) drive to a fix.
2. **Licensing strategy** — ASK the developer which source to honor when
   reusing functionality (do not decide for them). Exactly two options:
   - `enterprise` — Odoo Enterprise is available: search the Enterprise
     addons/repository in addition to the sources below.
   - `community` — no Enterprise; Odoo community core only.
   **In BOTH cases, ALWAYS also search OCA/community repositories** for an
   existing module to depend on or mirror before writing from scratch. OCA
   reuse is never skipped, so `licensed` only picks the *extra* source
   (Enterprise) — it never disables the OCA search.
2b. **Security interview (mandatory when `securityInterviewRequired`)** — the
   permission model must be a DECISION, never an invention. Ask the developer
   with `ask_user_question` and record the answers as `decision` nodes in the KB:
   - **Groups**: which existing groups apply (`base.group_user`,
     `sales_team.group_sale_manager`, …) and which NEW groups to create? A new
     group must be declared as a `res.groups` record with a real xmlid.
   - **Access matrix**: for every new model, WHO may read / create / write /
     unlink, per group. No model is delivered without its
     `security/ir.model.access.csv` rows.
   - **Record rules**: are they needed (multi-company, warehouse, owner-only)?
     If not, say so EXPLICITLY — "no record rules needed" is a decision too.
   - **Sensitive data**: does the module store personal, financial or secret
     data? If yes, the visibility/group restriction must be stated.
   - **Out of scope**: what must the module explicitly NOT do?
   If an answer is missing: in SUPERVISED mode ask again (never assume); in
   AUTONOMOUS mode advance to `BLOCKED` with reason "security undefined".
3. **SUPERVISED mode**: you MUST interview the developer with
   `ask_user_question` — (a) create or bug, (b) licensing strategy, (c) the
   security questions above, and (d) an explicit confirmation "proceed?" — and
   record the answers with `sdd_phase clarify mode=... licensed=...`. Do NOT
   start any work before this confirmation. If the developer is vague, restate
   the plan and ask again.
4. **AUTONOMOUS mode**: detect `mode` and `licensed` from the request text; if
   they cannot be determined confidently, go `sdd_phase advance next_phase=BLOCKED`
   ("intent ambiguous") — never invent them.

Once clarified: `sdd_phase advance next_phase=READ_SPEC`.

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
0a. **Connection authorization (MANDATORY, once per target)**: credentials are
   NOT consent. Once `.env` holds the non-secret fields and the developer has
   filled the secret, run `odoo_setup mode=authorize`. That asks the DEVELOPER
   through the host's native approval seam and stores a receipt in
   `.sdd/grants.json` (0600) bound to `url + db + username`. Rules:
   - Without a live receipt, `clientFor` returns no client: every tool reports
     `NOT AUTHORIZED` and NO socket is opened, even in autonomous mode. Do not
     retry in a loop — report the state and ask the developer to approve.
   - Changing url/db/user invalidates the receipt: re-run `mode=authorize`.
   - `odoo_setup mode=revoke` drops it deliberately.
   - `odoo_config mode=set` and `odoo_setup mode=autonomy` also require native
     approval: the model may PROPOSE policy, never grant it.
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
   - Views (XML IDs to inherit — never replace) **with an explicit view-type
     decision per model**: which types beyond form/tree/list are needed (`search`
     for a custom filter/favorites bar, kanban, pivot, graph, calendar,
     dashboard, gantt, activity, map, cohort, funnel), each justified. If a
     model is form+tree only, say so: "form + tree only (no extra view types)".
   - `## Reports`: every report the module delivers (PDF via
     `ir.actions.report`/QWeb, SQL/raw query, CSV/XLSX export, web page,
     external tool), its source model/fields, and its trigger (menu/button/action
     or scheduled). If none, write exactly "no reports needed". **Never leave
     this section implied missing — always ask or state "no reports".**
   - `## Documentation`: the documentation DECISION — the language (English
     unless the project's own rules file says otherwise), the OCA readme
     fragments that apply mapped to their Diátaxis audience
     (Tutorial/How-to/Reference/Explanation), and whether `index.html`, Web
     Tours and migration scripts apply. Write "no extra fragments" explicitly
     when none are needed: the gate refuses a heading with only template
     comments, and only the security model gate is evaluated before it.
   - `## Tours`: which web tours ship (onboarding for the end user, test for CI,
     both) and the asset bundle that loads each one — `web.assets_tests` for a
     test tour, `web.assets_backend`/`frontend` for onboarding — plus the
     `HttpCase` + `start_tour` that executes it. A tour no bundle loads never
     runs. The registration API is version-specific (14–16 `tour.register`, 17+
     `registry.category("web_tour.tours")`): the verified matrix, the Python
     bridge and the traps are in `references/tours-and-demo.md`. If none, write
     exactly "no tours needed".
   - `## Demo data`: whether the module ships demo data, in which `demo/` files
     (declared in the manifest's `"demo"` key) and what for — plus the
     consequence: the functionality must never depend on demo data, because
     production databases are created without it. If none, write exactly
     "no demo data".
   - Security: groups, `ir.model.access.csv`, record rules.
   - Directory layout and exact `__manifest__.py` depends.
   - Localization: if extending a country localization, use the
     `l10n_<country>_` prefix convention on models/fields/methods.
2b. **Design interview (guide, does NOT block)**: before finalizing, ask the
   developer with `ask_user_question` about anything the spec left open — do not
   assume. Ask specifically (a) which **extra view types** any model needs
   beyond form/tree — including whether a **`search` view** is needed for custom
   filters/favorites on how the model is searched — (b) which **reports**
   (PDF/SQL/CSV/XLSX/dashboard) are needed and in which medium (Odoo
   `ir.actions.report` vs external), (c) whether the module needs a **tour**
   (onboarding, test, both or none) and whether the instance being verified can
   actually execute it (`--test-enable` needs shell access; without it a tour is
   evidence a human runs), and (d) whether it ships **demo data** and for what.
   Record the
   answer verbatim as `decision` nodes in the KB and mirror it in
   `architecture.md`. If the developer answers "no"/"form+tree only"/"no
   reports"/"no tours"/"no demo data", record that as an explicit decision; if
   they do not answer, record
   the assumed default and note it. Answers here are guidance, NOT a gate — the
   only fail-closed blocker for advancing ARCHITECTURE is the security model
   (see the `## Security` content gate).
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
3. **Module documentation** — load `agents/documentation.md` and follow the
   decision recorded in `## Documentation`:
   - `odoo_docs operation=scaffold module_dir=<module>` creates the missing OCA
     fragments and the `static/description/index.html` skeleton (create-only).
     A scaffold is a STARTING POINT, not documentation: replace the content and
     remove the marker, or `report` will never approve it.
   - Fragments: `DESCRIPTION.md` (Reference, mandatory), `CONTRIBUTORS.md`
     (Reference, mandatory), `CONTEXT.md` (Explanation, with a Mermaid ERD when
     new models are declared), `CONFIGURE.md` / `USAGE.md` / `INSTALL.md`
     (How-to), `ROADMAP.md` (Explanation).
   - **Changelog is mandatory for any change to a released module**, including a
     bug fix: one Towncrier fragment in `readme/newsfragments/<issue>.<type>`
     (`feature`/`bugfix`/`doc`/`removal`/`misc`/`security`/`breaking`). Write it
     yourself — only you know what changed and for whom.
   - Take author/maintainer/contributors from the project's own conventions
     (`.pylintrc`, `__manifest__.py`, `AGENTS.md`, LICENSE) and never hardcode a
     person. Language: the project's rules file wins over the plugin default.
   - This plugin cannot run `gen-odoo-readme`, `towncrier`, Ruff or pylint (no
     shell): the fragments are the source of truth and compiling `README.rst` is
     the developer's step.
4. Static gates BEFORE touching the instance (fast, cheap):
   - `odoo_validate module_dir=<module>` — local structural check (manifest,
     declared XML, ACL csv) with no server required
   - `odoo_docs operation=check module_dir=<module> mode=<create|bug>` — local
     documentation check (fragments, Diátaxis, version scheme, changelog,
     index.html, docstrings, xpath comments, OWL directive)
   - `pre-commit run -a` if the repo has the OCA template configured
   - `pylint --rcfile=.pylintrc-mandatory <module>/` when the file exists
   - `ruff check <module>/` on Odoo 18+ projects using it
   - XML syntax validation of every view file
5. `odoo_module operation=info modules=['<module>']` — confirm the instance
   actually sees the code (correct addons path / deployment).
6. **Checkpoint before mutating**: create one BEFORE the first write to the
   instance — `sdd_checkpoint operation=create label="before <change>"
   dirs=["<module_dir>"]`. With `requireCheckpointBeforeMutation` (default
   true) the policy guard REFUSES any `odoo_execute` mutation or
   `odoo_module install|upgrade` until a checkpoint exists. Re-create it before
   each new risky change; `sdd_checkpoint operation=journal` shows what has
   been applied since. With `requireSpecForChanges` (default true) the guard
   ALSO refuses any source edit (`write`/`edit`) and every instance mutation
   unless a spec is in a writing phase — or the developer waived the spec for
   this session. Writing `specs/` and `.sdd/` is always allowed.
7. `sdd_phase advance next_phase=VERIFY`.

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
   - **Documentation layer**: run
     `odoo_docs operation=check module_dir=<module> mode=<create|bug>`. Every
     ERROR blocks; every WARN needs a written resolution. A module changed
     without its changelog fragment is an ERROR, not a detail.
   - Close it with `odoo_docs operation=report module_dir=<module> spec_id=<id>`,
     which writes `specs/<id>/docs-report.md` with the verdict the DONE gate
     reads (`documentationPolicy=required` by default). A report is APPROVED
     only when there is no ERROR and no fragment is still a scaffold.
2. **Layer 2 (server)**: `odoo_module operation=install` (or `upgrade`).
   - Success ⇒ confirm state `installed` via `operation=info`.
   - Traceback ⇒ `odoo_errors` for the full server log ⇒ `sdd_phase fail`
     with the concrete error ⇒ go to phase 5.
3. **Layer 3 (data/RPC)**: exercise business logic via `odoo_execute` reads
   (search_read/read/search_count/read_group/fields_get) and, only for
   allowlisted models with `confirm_destructive=true`, the mutations the
   test-plan needs. Compare results against each AC.
   - Use `fields_get` to discover the real field names/types before asserting on
     them instead of guessing, and `read_group` for aggregations.
   - On a multi-company instance pass `context` (e.g.
     `{"allowed_company_ids":[1,2],"company_id":2}`); it is forwarded verbatim
     and the server still applies its own ACL. The context used by a mutation is
     journaled, so the data undo replays under the same company.
4. **Layer 4 (security review, MANDATORY when `securityReviewRequired`)**:
   load `agents/security-reviewer.md` and produce
   `specs/<id>/security-report.md` from evidence:
   - `odoo_security_scan module_dir=<module>` — any ERROR is blocking;
     every WARN needs an explicit written resolution.
   - `odoo_validate module_dir=<module>` — every new model must have an ACL
     row; every referenced group must resolve (in-module `res.groups` record
     or a `base.*` group); record rules must carry `groups` or be waived.
   - Cross-check the ACL against the DECIDED `## Security` matrix: the code may
     never be more permissive than the approved design.
   If the report is REJECTED ⇒ `sdd_phase fail` with the findings (→ phase 5).
5. **Layer 5 (UI, critical flows only)**: `odoo_session` ⇒ load the cookie
   from `.sdd/session.json` into Playwright's browser context, navigate past
   `/web/login`, and execute the UI scenarios from test-plan.md. Capture:
   Odoo Server Error modals, console tracebacks, non-rendering elements.
6. All green per AC by the QA persona ⇒ `sdd_phase succeed detail="<per-AC
   summary>"` ⇒ `sdd_phase advance next_phase=DONE`. `succeed` is REFUSED unless
   every AC row in `test-plan.md` reads an explicit `pass` (optionally
   `pass (evidence: …)`): `pending`, `failed`, `unknown`, `manual` and any
   unrecognized token leave the criterion open, because a green verdict must map
   to a tested criterion and the gate is an allowlist. A manual-layer row stays
   `pending` until a human confirms it, and only then is it written as `pass`.
   With `securityReviewRequired` armed, DONE additionally requires a
   `security-report.md` whose verdict is not REJECTED.
6. Any failure ⇒ `sdd_phase fail detail="<concrete error>"` ⇒ phase 5.
   (Gated advances pass `approval_source` — `human` in supervised mode, the
   human-proxy's verdict in autonomous mode.)

## Phase 5 — FIX_LOOP

1. Read state: `sdd_phase status`. Respect `requireDiagnosis`.
   When the ladder trips, the retry is BLOCKED until the root-cause analysis is
   actually recorded with `sdd_phase operation=diagnose detail="<findings>"` —
   asking for the diagnosis does not satisfy it, and blind retries are refused.
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
5. **Rollback instead of patching a broken state**: when a change made things
   worse and the cause is not obvious, restore the last checkpoint rather than
   layering another guess on top:
   - `sdd_checkpoint operation=list` → pick the checkpoint from BEFORE the
     change; `sdd_phase operation=rollback spec_id=<id> checkpoint_id=<cp>`
     restores the files and returns the pipeline to `WRITE_CODE`.
   - Journaled data mutations can be undone with
     `sdd_checkpoint operation=restore checkpoint_id=<cp> restore_data=true
     confirm_destructive=true`. The undo refuses if the journal was recorded
     against a different database. LIMIT: a module install/upgrade is NOT
     reverted at the database level — say so and let the developer decide
     (uninstall).
   - A restore REPORTS the files created after the checkpoint. If the tree must
     match the snapshot exactly, re-run with `remove_created=true`; never assume
     the workspace was reverted when new files survived it.
6. `BLOCKED` or ceiling reached ⇒ stop and hand to the developer: KB state,
   last FAILED verdict and diagnosis.

## A new request after the run closed (the intake rule)

A request that arrives AFTER the pipeline closed ("now also change X") is a NEW
change: the spec you finished does not authorize it, and with
`requireSpecForChanges` (default true) the guard refuses the Odoo tools AND the
file editors until something does. "Leave it to your judgement" is a decision
too — that is the waiver — but the default answer is a spec.

Decide the intake in one line BEFORE touching anything, and say which one you
took:

1. **It does not fit the closed spec.** Do not reopen it: `DONE` stays the
   honest verdict of what was verified. A follow-up is its own spec.
2. **Small change** (a bug, a tweak, one behaviour): open a SMALL spec —
   `sdd_phase operation=init spec_id=<NNN>-<slug> mode=bug`. A `bug` spec is
   short by construction: one acceptance criterion, no design interview, no
   architecture ceremony. One line of "what changes" and one of "how I will
   check it" in `spec.md`, then `mark_spec_loaded` → `advance` to `WRITE_CODE`.
3. **The developer said not to spec it** ("do it your way", "no spec for this"):
   take the waiver — `sdd_phase operation=waive detail="<their exact words>"`.
   It needs THEIR approval, it covers THIS session only, and you still record
   every change as a KB decision with how it was verified.
4. **The policy is off** (`requireSpecForChanges: false`, set by the developer):
   only then change things with neither spec nor waiver.

Never route around a refusal — no writing files through `bash`, no flipping the
policy yourself, no editing `.sdd/active.json`. The refusal names the three ways
out; take one, or ask. Whatever the intake, the rest of the rules still hold: a
checkpoint before mutating the instance, an honest verdict, and the handoff
updated (`sdd_handoff` copies the waiver, if any, into `handoff.md`).

## Closing the run (DONE or BLOCKED)

Before you stop, ALWAYS write the handoff:
`sdd_handoff spec_id=<id> summary="<one line>"`. It records the final phase,
the honest verdict, the KB decisions/blockers, the checkpoints, the journaled
data operations, the configuration in effect and the next steps into
`specs/<id>/handoff.md`, so the next session (or a human) starts from a clean,
readable state. Then report to the developer: what was delivered, what is
verified, what is NOT (and why), and which checkpoint to roll back to.

## Per-spec artifacts

```
specs/<NNN>-<slug>/
├── spec.md             # immutable after APPROVED
├── architecture.md     # approved design (incl. the DECIDED ## Security model)
├── test-plan.md        # scenarios per AC
├── security-report.md  # security review verdict + findings (required for DONE)
├── verify-verdict.txt  # honest persisted verdict (PASSED/FAILED + date)
├── handoff.md          # generated by sdd_handoff when the run closes
├── state.json          # phase, failures, iterations
└── kb.json             # decisions, blockers, diagnoses, learnings

Outside the spec directory (plugin-owned, shared by the run):
.sdd/config.json        # persisted config (repos, allowlist, policy flags)
.sdd/active.json        # active spec + phase + active checkpoint (policy input)
.sdd/waiver.json        # developer-approved exemption from the spec policy (THIS session only)
.sdd/checkpoints/<id>/  # file snapshots + data journal (rollback surface)
.sdd/audit.jsonl        # append-only record of EVERY tool call (append-only)
```
