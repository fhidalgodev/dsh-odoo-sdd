---
name: odoo-functional-sdd
description: Functional Odoo work on a running instance with dsh-odoo-sdd — discover what the version and the installed modules actually provide, then configure and import in human-approved batches, and close with an operational runbook a person can repeat.
whenToUse: Select this skill when the request is about configuring, parameterising, migrating or loading data INTO an existing Odoo instance (company setup, users and access, taxes and localisation, master data imports from CSV/Excel, inventory routes, POS configuration), rather than writing a module. If the deliverable is source code, use odoo-sdd-workflow instead. Do not select it for tasks unrelated to Odoo.
---

# Odoo Functional Workflow (CLARIFY + ARCHITECTURE + APPLY_CONFIG + VERIFY)

The protocol for a **functional** run: you change what is configured in a live
Odoo instance and what data it holds. It uses the same SDD machine as
development, with a different phase in the middle — `APPLY_CONFIG` instead of
`WRITE_CODE` — and different closing requirements.

You are the `agents/functional.md` persona. Read it before starting; it carries
the rules on facts vs hypotheses, fiscal data and production.

## Global rules (non-negotiable)

1. **No mutation without an approved batch.** Discovery is approved separately
   from the importer preparation, from the business application and from the
   compensation. `approval_marker=APPROVED` and `confirm_destructive=true` do
   **not** replace the per-batch human approval, and a human-proxy never grants
   it.
2. **One operation at a time.** Each batch is applied operation by operation,
   with the state persisted before the send and after the result. No "apply
   everything and see".
3. **An uncertain result is not a retry.** A timeout or a disconnect after a
   mutation may mean Odoo already committed: the operation is marked
   `indeterminate`, the batch stops and the run goes `BLOCKED` until a human
   reconciles.
4. **The environment is declared, never assumed.** `dev`, `staging` or
   `production`. Production additionally needs the declared backup, the impact
   review and its own approval; high-risk changes are proven in staging first.
5. **You never trigger a business action by editing configuration.** Making Odoo
   perform an action by temporarily changing an automation trigger, a server
   action or any other setting is forbidden: it mutates configuration the run did
   not declare and leaves the instance depending on something nobody reviewed.
   The action goes through an allowlisted `kind: "method"` operation (state guard
   plus state proof), or becomes a manual step with its exact button label.
6. **No invented data.** Fiscal country, taxes, legal identity and inventory
   valuation come from a named human, never from a page you read.
7. **Honest evidence.** Every acceptance criterion needs the layer that actually
   verified it (`rpc`, `ui`, `manual`) and a real result. `sdd_phase succeed`
   accepts only an explicit `pass` per row.
8. **The runbook is the deliverable.** A configuration nobody can repeat by hand
   is not delivered. `DONE` requires it, whatever the documentation policy says.
9. **`stop.md` and the iteration ceiling stay armed**, exactly as in development.

## Where files live

The project root is the folder open in the current session, and the spec
directory is whatever `odoo_config mode=read` reports (project or central
layout). Never reconstruct the path by hand. `.sdd/functional/<spec-id>/` holds
the plan, the run state and the mapping of an import; `.sdd/checkpoints/<id>/`
keeps the data journal used for compensation.

## Tools of this run

| Tool | Use it for |
| --- | --- |
| `odoo_config mode=read/set` | project root, specs layout, licensing, autonomy. |
| `sdd_phase` (+ `sdd_checkpoint`) | the phase machine and the data journal. |
| `odoo_connect`, `odoo_execute` | version/edition, and every read or declared mutation over JSON-RPC (the allowlist decides what may be written). |
| `odoo_session` | mint the web session cookie that the importer route needs; it is stored in `.sdd/session.json`, never printed. |
| `odoo_import use=prepare\|preview\|map\|plan\|status` | the native importer: upload the authorised file, read back what Odoo parsed, record a decision per column, and turn it into an `apply` batch. It never applies anything by itself. |
| `odoo_functional operations=plan\|approve\|apply\|inspect\|status\|reconcile\|verify\|compensate` | the batches: where they are declared, approved, executed operation by operation, reconciled when an outcome is unknown, and compensated. |
| `odoo_errors`, `odoo_docs`, `odoo_validate`, `odoo_security_scan` | server logs after a failure, and the module-level checks when the run also touches code. |

## Phase 1 — CLARIFY

1. `sdd_phase init spec_id=<NNN>-<slug> mode=functional` (the mode decides the
   template set, the phase graph and the gates, and it is frozen once the spec is
   loaded).
2. Interview the developer: objective, scope, instance, **environment**, edition,
   legal entities, country and fiscal regime, currencies, language, branches,
   users and roles, business flows, data volume, and the criteria that will prove
   success.
3. Detect the version and edition for real (`odoo_connect`), and which modules
   are installed — capability, not marketing.
4. Answer the **access and multi-company** questions: who may run these flows,
   which companies are touched, whether the permission model changes.
5. `sdd_phase clarify spec_id=<id> mode=functional licensed=<...>`, then write
   `spec.md`.

**Writing code, or installing anything, in this phase is forbidden.**

## Phase 2 — READ_SPEC

`spec.md` carries `## Context`, `## Sources and Decisions`, `## Acceptance
Criteria` (numbered, verifiable in this instance), `## Constraints` and
`## Target Odoo Version` (with how it was detected). Every business fact is
labelled `source:`, `hypothesis:` or `confirmed by:`. Mark it loaded, then get
`APPROVED` to advance.

## Phase 3 — ARCHITECTURE

Write `architecture.md` with the seven required sections:

| Section | What it must decide |
|---|---|
| `## Functional Design` | the to-be process in business terms |
| `## Destination` | instance, database, environment, companies, capabilities the version provides |
| `## Operations` | the ordered batches: model/method/fields, dependencies, record identity, preconditions, expected result |
| `## Access and Companies` | who may run it, which companies, and whether ACLs/record rules change (or an explicit "none needed") |
| `## Validation` | how each batch is checked after applying it |
| `## Risks and Recovery` | risks, rollback limits, how each batch is undone, what cannot be undone |
| `## Documentation` | language, the runbook as the deliverable, and that no OCA fragments/index.html are produced |

`test-plan.md` gets one row per acceptance criterion. The content gates are real:
ARCHITECTURE does not advance while the access/companies or documentation
decisions are missing.

## Phase 4 — APPLY_CONFIG

1. **Discover (its own approved scope).** Before the first RPC, present what will
   be consulted: models, fields, record counts. Reads are not mutations, but an
   approved discovery scope is what stops a "just looking around" that turns into
   a change.
2. **Plan.** Turn the design into batches and save them in the plan. Each batch
   declares destination and environment, version/capabilities used, company and
   context, the acceptance criteria it covers, its ordered operations, values or
   references to private data, dependencies, record identity, preconditions,
   expected result, risks, recovery and manual steps. References to ids created
   earlier are resolved by declared rules, never by arbitrary code.
3. **Approve.** Show the exact batch and ask the human through the native
   approval seam. The receipt is bound to the hashes of the spec, the design, the
   plan and the batch, and to the destination and companies. Any change to any of
   them invalidates it.
4. **Apply.** Execute in order, checking the hashes again before every operation.
   Persist each operation's state before and after the call. An operation is
   recorded as applied **only after reading back the state it declared in its
   postcondition**: a call that answers while leaving the records untouched is a
   failure, and the batch stops saying so — the call WAS sent, so the instance may
   be half-changed and a blind retry is the wrong move. Imports go through
   the native Odoo importer (`odoo_import use=prepare` with its own approval,
   then `preview` to read the headers, sheets and importable fields, `map` for a
   decision per column and `plan` to obtain the batch; `odoo_functional` then
   approves and applies it), never through a hand-written parser. A file that
   changed after the upload invalidates the mapping, a `nextrow` in the answer
   means the importer stopped mid-file, and neither case is a licence to re-send
   the rows that already landed.
5. **Checkpoint first.** The policy guard blocks mutations until a checkpoint
   exists; a checkpoint is also what makes the data undo possible. The same
   guard also requires a spec in a writing phase (`APPLY_CONFIG` for this path)
   or a waiver approved for this session, and a follow-up request after the run
   closed is a NEW spec — `odoo_import use=prepare` counts as a mutation, while
   `preview`/`map` only read.
6. **Compensate** with an approved compensation batch built from the journal, and
   report what cannot be restored (new ids, installed modules, external effects).

## Phase 5 — VERIFY

1. Re-read the affected records and check the business result, not just the count
   of rows created.
2. Fill `test-plan.md` with the real status of every criterion: `pass` with
   evidence in parentheses, or the honest failure.
3. `sdd_phase succeed` (refused while any row is not an explicit pass), then the
   **security review** (mandatory) and the **runbook**.

## Phase 6 — closing

`DONE` requires all of it: verdict, every criterion passed, `security-report.md`
not rejected and `functional-runbook.md` complete (batches applied, procedures
with verified menu paths, verification evidence, recovery). If the run ends in
`BLOCKED`, deliver a partial report saying what was applied and what remains —
that report is the difference between a stopped run and a lost one.

## Reference

Domain checklists — questions, dependencies, verifications and risks per area
(company/multi-company, users, contacts, catalogue/UoM/variants/prices,
accounting/localisation/taxes, sales/CRM/purchases, inventory/routes/traceability,
POS, manufacturing, projects, HR) — live in
`references/functional-domains.md`. They are **checklists to investigate**, not
payloads: never treat one as a universal recipe, and never derive fiscal data
from them.

Declaring and proving a **business action** — any model's method that is neither
a read nor CRUD — has its own reference: `references/business-methods.md`. It is
domain-neutral on purpose: how to find what a method really does in the source of
the target version, how to declare it (allowlisted pair, state guard, state
proof) and the traps that apply to every non-idempotent method.
