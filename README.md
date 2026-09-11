# Spec-Driven Development for Odoo

*From an idea to a tested Odoo module — with or without human intervention.*

<!-- Badges resolve once the package is published to npm and the repository is
     public on GitHub under fhidalgodev/dsh-odoo-sdd. Update the links if you
     publish under a different owner. -->
<p align="center">
  <a href="https://www.npmjs.com/package/dsh-odoo-sdd"><img src="https://img.shields.io/npm/v/dsh-odoo-sdd.svg?style=flat-square&color=cb3837&labelColor=161b22&logo=npm&logoColor=white" alt="npm version"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fhidalgodev/dsh-odoo-sdd/ci.yml?style=flat-square&label=ci&labelColor=161b22&logo=githubactions&logoColor=white" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <a href="https://www.npmjs.com/package/dsh-odoo-sdd"><img src="https://img.shields.io/npm/dm/dsh-odoo-sdd.svg?style=flat-square&color=3fb950&labelColor=161b22&label=downloads" alt="downloads"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/stargazers"><img src="https://img.shields.io/github/stars/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/graphs/contributors"><img src="https://img.shields.io/github/contributors/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=bc8cff&labelColor=161b22&logo=github&logoColor=white" alt="contributors"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/discussions"><img src="https://img.shields.io/github/discussions/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=58a6ff&labelColor=161b22&logo=github&logoColor=white" alt="Discussions"/></a>
</p>

English | [Español](README.es.md)

**Author:** [Franyer Hidalgo](https://github.com/fhidalgodev) — `fhidalgo.dev@gmail.com`

## Summary

`dsh-odoo-sdd` turns DeepSeek Harness into a specification-driven (SDD) Odoo
development pipeline built on two core principles:

- **Closed feedback loop**: the agent installs/upgrades modules, reads server
  tracebacks, and retries against a **real, running** Odoo instance. This
  plugin never starts Docker or `odoo-bin` processes: the developer supplies
  the URL and credentials of an existing instance (dev/staging) through a
  gitignored `.env`, and the tools speak standard JSON-RPC.
- **Pipeline safety**: phases persist to disk (`state.json` + KB graph), gates
  are fail-closed on an explicit `APPROVED` marker, three consecutive failures
  force a deep-diagnosis step, verify/fix iterations are capped, `stop.md`
  halts everything, and verdicts are honest: a failed verification persists as
  FAILED and can never be reported as success.

What it is NOT: an infrastructure orchestrator, a credential manager over
chat, or an auto-committer.

## Security & network posture

- **No phone-home**: the plugin's ONLY outbound network calls go to the
  instance URL the developer put in `.env`. No telemetry, no update checks,
  no third-party endpoints.
- **Transport guard (fail-closed)**: `http://` is accepted only for loopback
  hosts (`localhost`, `127.x`, `::1`, `*.localhost`); any other target must
  be `https://`, otherwise credential loading is refused (plain http to a
  remote host would ship the API key in clear text).
- **Secret containment**: the secret is read once by `credentials.ts` and
  only injected into RPC parameters. Every tool output passes through
  two-layer redaction (known secret + generic `password=` / `Bearer` /
  `api_key=` / `session_id` shapes) and home-path masking (`/home/user/...`
  → `~/...`) before being shown to the model or persisted to the KB.
- **Session cookies never reach the model**: `odoo_session` writes the
  cookie to `.sdd/session.json` (chmod 600) and returns only the path.
- **No build scripts**: the package executes no install scripts (market's
  pnpm ≥10 default stays in force); it ships source + documented build step.
- **Host requirement declared twice**, following dsh-market discovery
  conventions: `engines.dsh` (`>=0.1.2-rc.1`) and lockstep optional peer
  ranges on `@deepseek-ai/{cordis,dsh-tools,schemastery}`. On a host without
  the `tools` service the plugin refuses to mount with an explicit error
  instead of booting broken (fail-closed, like the market itself).

## Use this package

### 1. Configure credentials (once per project)

The easiest path is the onboarding tool: when the pipeline starts, the agent
runs `odoo_setup mode=check` and offers three choices — **configure now**
(collects only the non-secret fields and writes a chmod-600 scaffold; the
developer fills `ODOO_PASSWORD` by hand), **configure later** (re-asked before
the VERIFY phase), or **skip** (no instance; RPC/UI layers become manual
verification). The decision is persisted per project and never re-asked.

Credentials are resolved through a **location cascade** (first existing wins):

1. `ODOO_SDD_ENV_FILE` (explicit environment override)
2. `<project>/.sdd/.env` — project scope, plugin-owned hidden dir
3. `~/.config/dsh-odoo-sdd/.env` (`$XDG_CONFIG_HOME` honored) — user scope,
   the generic default: one set of dev credentials serves every project
4. `<project>/.env` — legacy location, still supported (reported as legacy)

Manual setup (alternative to the tool):

```bash
mkdir -p ~/.config/dsh-odoo-sdd && cd ~/.config/dsh-odoo-sdd
cp <plugin>/.env.example .env
chmod 600 .env
# The developer fills in: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD
# (an Odoo API key is recommended over the account password)
```

The plugin **refuses** a group/world-readable `.env`, **redacts** the secret
in every log/tool output, and **never** returns session cookies to the model
(they land in `.sdd/session.json`, mode 600, referenced only by path).

### 2. Compose the plugin into a DSH profile

```jsonc
// ~/.dsh/profiles/odoo/package.json
{
  "name": "dsh-profile-odoo",
  "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-odoo-sdd"
  ], "patchReload": "live" } }
}
```

```bash
dsh plugin --profile odoo add <path-or-package-spec>
dsh --profile odoo --dump-config   # inspect composition without booting
```

Bundles whose `dsh.bundle.patch` points at `cordis.patch.yml` insert their own
row, so no manual entry is needed once the package is installed.

Installing from a git clone? `lib/` is build output and is **not** committed, and
pnpm skips dependency build scripts by default — compile once before adding:

```bash
git clone https://github.com/fhidalgodev/dsh-odoo-sdd && cd dsh-odoo-sdd
npm install && npm run build     # emits lib/ (required: package main is lib/index.js)
dsh plugin --profile odoo add .
```

Optional configuration via the patch layer (`cordis.patch.yml`): `projectRoot`
(workspace root) and `specsDir` (specs folder, default `specs/`). The remaining
fields (execution allowlist, repositories, autonomy, licensing, the policy
guards) can be set with the `odoo_config` tool or in
**Settings → Odoo SDD**.

### 3. Registered tools (model-facing)

| Tool | Purpose |
|---|---|
| `odoo_connect` | Probe the instance: server version + authentication. Masked report; distinguishes `NEEDS_SETUP` / `NEEDS_SECRET` / `DEFERRED` / `SKIPPED` states (never asks for secrets in chat). |
| `odoo_setup` | Onboarding: `check` (cascade + gitignore + delegation mode), `interactive` (secret-free chmod-600 scaffold), `later`, `skip`, `reset`, `autonomy` (supervised | autonomous). Secrets are never accepted as parameters. |
| `odoo_module` | `info` / `install` / `upgrade` on `ir.module.module` (`button_immediate_*`). Returns the server's own output or traceback, redacted — the closed feedback loop. |
| `odoo_execute` | Generic CRUD/RPC (`execute_kw`) with a fail-closed allowlist: reads for allowlisted models, mutations (`create`/`write`/`unlink`) require `confirm_destructive=true` AND the model in `executeAllowlist`. No instance needed to evaluate denials. |
| `odoo_validate` | LOCAL, instance-free module structure check: `__manifest__.py` present + depends, declared data XML files exist, `security/ir.model.access.csv` when models declared. Returns file:line findings. |
| `odoo_errors` | Reads recent `ir.logging` server errors — the remote equivalent of fetching environment logs. |
| `odoo_session` | Mints a passwordless web session (the `connect_as_user` pattern) stored in `.sdd/session.json` (chmod 600) for Playwright UI tests. The cookie itself is never returned. |
| `sdd_phase` | The phase state machine: `init`, `status` (includes logbook summary), `mark_spec_loaded`, `advance` (fail-closed gates + `approval_source` provenance), `fail` (failure ladder + FAILED verdict), `succeed` (PASSED verdict), `rollback` (restore a checkpoint and return to WRITE_CODE). |
| `sdd_checkpoint` | The rollback surface: `create` (snapshots the workspace, becomes the active checkpoint), `list`, `restore` (files, plus — with `restore_data=true` and `confirm_destructive=true` — the journaled data mutations), `drop`, `journal`. |
| `odoo_security_scan` | Local static security review (no instance needed): raw SQL by concatenation, `eval`/`exec`/`pickle`, hardcoded secrets, unjustified `sudo()`, `auth="none"`, disabled CSRF, QWeb `t-raw`. Findings carry `file:line` + a fix hint; any ERROR blocks `DONE`. |
| `sdd_handoff` | Writes `specs/<id>/handoff.md` (final phase, verdict, decisions, blockers, checkpoints, journal, effective config, next steps) when the run closes. |

### 3b. Delegation mode (from one idea, supervised or autonomous)

The plugin starts by asking how much of the pipeline to delegate — recorded
once per project via `odoo_setup mode=autonomy decision=...`:

- **Supervised** (default): each gated phase asks the human for `APPROVED`.
- **Autonomous** (idea → architecture with no human in the loop): a
  **human-proxy** agent (`agents/human-proxy.md`) answers the gates, emitting
  only a fail-closed line-start `APPROVED` or `NEEDS_REVISION`. The human does
  the initial interview and leaves; `create_goal` continues unattended rounds
  until `DONE` or `BLOCKED`. Emergency brakes stay armed (stop.md, iteration
  ceilings, diagnosis ladder); `BLOCKED` is the only way to page a human.

### 3c. Context Engineering layers

| Layer | Component |
|---|---|
| **identity** | `agents/*.md` — architect, developer, qa, consultant, human-proxy personas with role + limits |
| **odoo_connection** | `odoo-client.ts` — JSON-RPC auth, execute_kw, session minting |
| **executors** | `odoo_module`, `odoo_execute`, `odoo_validate`, `odoo_errors` |
| **schemas** | staged templates with required sections; `transition()` rejects a phase whose deliverable lacks them |
| **knowledge** | version-pinned Odoo pattern skills (delegated, verified by the skill) |
| **skills** | `SKILL.md` — the 5-phase orchestration flow |
| **logbook** | `kb.json` — decisions, discarded options, blockers; read before proposing |
| **audit** | `.sdd/audit.jsonl` — sanitized append-only tool-activity log, written by a global `tools/result` listener (not just the Odoo tools) |
| **rollback** | `.sdd/checkpoints/<id>/` — manifest + file snapshot + data journal, restorable per spec |
| **security** | `odoo_security_scan` rules + the `security-reviewer` persona + the mandatory security interview in CLARIFY |
| **test** | `tests/smoke.mjs` — instance-free invariant suite |

### 3d. Safety, rollback and traceability

The pipeline assumes the agent will eventually be wrong, so every mutation path
has a way back and a way to prove what happened.

- **Checkpoint before mutating.** With `requireCheckpointBeforeMutation` on
  (default), `odoo_execute` mutations are denied until `sdd_checkpoint create`
  has snapshotted the active spec — and denied outright before `WRITE_CODE`.
- **File rollback.** `sdd_checkpoint restore` puts the snapshotted files back
  byte-for-byte; `sdd_phase rollback` returns the spec to `WRITE_CODE` with the
  failure recorded, so the loop restarts from a known state.
- **Data rollback (best effort).** Every `create`/`write`/`unlink` through
  `odoo_execute` records its pre-image in the checkpoint journal; `restore
  restore_data=true confirm_destructive=true` replays it in reverse. This covers
  data written through the plugin — **not** side effects of a module
  install/upgrade, which are not reverted at database level.
- **Security by construction.** CLARIFY must answer the security interview
  (groups, ACLs, record rules, `sudo()` justification, public routes) before
  ARCHITECTURE can be approved; `securityGaps()` fails the gate when those
  answers are missing from `architecture.md`, and `securityReviewRequired`
  forces the `security-reviewer` pass before `DONE`.
- **Traceability.** `.sdd/audit.jsonl` records every tool call with outcome
  (`ok` / `error` / `denied`), duration and phase; `sdd_phase status` prints the
  logbook; `sdd_handoff` freezes the whole run into `handoff.md`.
- **Emergency brakes.** `stop.md` (at `.sdd/stop.md` or `specs/<active>/stop.md`)
  halts every tool; iteration ceilings and the diagnosis ladder route to
  `BLOCKED` instead of looping forever.

### 4. Working protocol

The skill [`skills/odoo-sdd-workflow/SKILL.md`](skills/odoo-sdd-workflow/SKILL.md)
defines the 5-phase protocol the agent must follow:

1. **READ_SPEC** — assimilate `spec.md` (immutable); writing code is forbidden; `APPROVED` gate.
2. **ARCHITECTURE** — design models/views/security in `architecture.md` + `test-plan.md`; search existing functionality first; `APPROVED` gate.
3. **WRITE_CODE** — implement with version-pinned Odoo patterns; static gates first (pre-commit, pylint, ruff).
4. **VERIFY** — ascending pyramid: static → install/upgrade via `odoo_module` → RPC/data → UI (Playwright + `odoo_session`) only for critical flows.
5. **FIX_LOOP** — fix root causes; 3 failures ⇒ mandatory consultant diagnosis; 5 iterations ⇒ `BLOCKED`, escalate to the human.

Per-spec artifacts (everything on disk, resumable):

```
specs/<NNN>-<slug>/
├── spec.md · architecture.md · test-plan.md
├── verify-verdict.txt   # honest persisted verdict
├── state.json           # phase, failures, iterations
└── kb.json              # decisions, blockers, diagnoses, learnings
```

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Plugin shape

Follows the DSH tool-plugin convention (`dsh-tool-todo`, `dsh-tool-goal`):
named exports `name`, `inject` (`["tools"]`), `Config` (schemastery schema)
and `apply(ctx, config)`, registering each tool with `defineTool` from
`@deepseek-ai/dsh-tools`.

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: registration of the 12 tools, config resolution and the policy guard |
| `src/types.ts` | Public payload types (never contain secret material) |
| `src/credentials.ts` | Credential cascade, `.env` load/validation, 600 permissions, `redact()`, fail-closed |
| `src/odoo-client.ts` | JSON-RPC client: `common.version`, `authenticate`, `execute_kw`, `button_immediate_*`, `ir.logging`, `/web/session/authenticate` |
| `src/tools-runtime.ts` | Odoo-facing tool bodies: `odoo_execute` (allowlist + pre-image capture), `odoo_validate`, `odoo_module`, `odoo_errors` |
| `src/sdd-state.ts` | Phase machine, gates, append-only KB, verdicts, security content gate, `stop.md` |
| `src/checkpoints.ts` | Checkpoint store: manifest, file snapshot/restore, data journal, purge budget |
| `src/security-scan.ts` | Instance-free static security rules (`scanModule`) with `file:line` findings |
| `src/audit.ts` | Sanitized append-only audit log (`.sdd/audit.jsonl`) and the `withAudit` wrapper |
| `src/setup-state.ts` | Onboarding decision + delegation mode persistence (`.sdd/setup.json`) |

### Security decisions

- The secret only exists inside `credentials.ts` and the RPC call parameters;
  every output passes through `redact()` (including `user:pass@` URL shapes).
- The credential cascade is `ODOO_SDD_ENV_FILE` → `<project>/.sdd/.env` →
  `~/.config/dsh-odoo-sdd/.env` (XDG) → `<project>/.env`, and the transport guard
  rejects anything that is neither HTTPS nor loopback before authenticating.
- `mintSession` stores the cookie with mode 600 and returns only the path.
- Mutations are fail-closed twice over: the allowlist is read live from
  `.sdd/config.json` on every call, and the policy guard denies
  `create`/`write`/`unlink` unless a checkpoint exists and the spec is in
  `WRITE_CODE` or later.
- Secrets are never accepted as tool parameters, never written to the audit log,
  and never requested through chat.
- Corrupted state ⇒ restart (progress is never faked); ambiguous gate ⇒
  rejection; absent verification ⇒ `DONE` unreachable; security gap ⇒
  ARCHITECTURE gate rejected.

</details>

## Model Experience

The agent sees 12 tools with self-contained descriptions. Typical flow:
`sdd_phase init` → security interview + `odoo_connect` → gated phases with
`APPROVED` → `sdd_checkpoint create` → code → `odoo_security_scan` →
`odoo_module install` → on traceback, `odoo_errors` + `sdd_phase fail` (which
may force a diagnosis) → fix (or `sdd_phase rollback`) → re-verify →
`sdd_phase succeed` → `sdd_handoff` → `DONE`. Tool responses are actionable
text: server tracebacks, gate rejection reasons and remediation instructions.

## Known Limitations and Deferred Work

- **Remote tests**: without shell access to the instance there is no way to
  run `--test-enable`; layer 2 is RPC/UI testing. Pending: an optional
  `odoo_run_tests` tool if the developer exposes a test runner.
- **Data rollback is best effort**: tests write to the connected DB; there is no
  ephemeral cloning (design decision: the developer provisions and manages the
  target). `sdd_checkpoint` reverses data written through `odoo_execute`, but a
  module install/upgrade is **not** reverted at database level. Mitigation
  remains: use a disposable database.
- **Static security scan scope**: `odoo_security_scan` is rule-based over source
  text (no AST, no taint tracking), so it catches the common Odoo mistakes and
  not everything; it complements, never replaces, a human review.
- **Multi-instance**: one target per project (`.env`). Pending: instance
  profiles (`dev`, `staging`).
- No rich `presentCall`/UI renderer in the DSH web GUI (text render only).

## Star History

<a href="https://www.star-history.com/?repos=fhidalgodev%2Fdsh-odoo-sdd&type=date&legend=top-left">
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fhidalgodev/dsh-odoo-sdd&type=date&legend=top-left" />
</a>

> Chart generated live by the [star-history.com](https://star-history.com) API.

## Acknowledgments

Built for the Odoo developer community, this plugin rests on two ecosystems:

- **[Odoo Community Association (OCA)](https://github.com/OCA)** — the coding
  conventions, module layout and quality gates this pipeline enforces.
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai)** — the plugin
  architecture (Cordis tools/plugins, skills, subagents) this plugin runs on.

Thank you to everyone who contributes patterns, reviews, and ideas that shape
the SDD workflow. Contributors:

<p align="center">
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=fhidalgodev/dsh-odoo-sdd&max=100&columns=12" alt="Contributors to fhidalgodev/dsh-odoo-sdd" width="480"/>
  </a>
</p>

---

## License

MIT
