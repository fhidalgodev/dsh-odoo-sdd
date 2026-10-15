# Screen capture (`explore` / `capture`)

Motor 3 of `odoo_manual`: it drives a REAL Odoo session with an embedded
browser and produces annotated captures + ARIA evidence. Golden rule: capture is
**read-only by default**; action steps are an explicit option, with double
confirmation and a disposable database.

## Destinations (all from the SAME origin)

| Destination | Parameters | URL that is opened |
|---|---|---|
| Menu | `menu: sale.menu_action_quotations` | `/web#menu_id=<xmlid>` |
| Record | `record_model: sale.order` + `record_id: 3` | `/web#id=3&model=sale.order&view_type=form` |
| Action | `{ kind: "action", xmlid }` in the step | `/web#action=<xmlid>` |
| URL | `url: /web#action=...` | same origin; anything that leaves the origin is aborted |

`operation=explore` writes `explore.txt` with the ARIA snapshot of
`.o_action_manager`. Use it BEFORE naming destinations in the storyboard: xml
ids, button names and field labels go in EXACTLY, never guessed.

## Step kinds and their safety class

Class `read-only` (always allowed): `goto`, `menu`, `wait`, `assert`,
`explore`, `screenshot`, `confirm` (accepts a modal).
Class `action` (they mutate; they require `allow_actions=true` AND
`confirm_destructive=true`): `new`, `fill`, `select`, `press`, `click`.

```json
{ "id": "s03", "kind": "fill",   "field": "partner_id", "value": "Acme", "procedure": "Type the customer." },
{ "id": "s04", "kind": "select", "field": "warehouse_id", "value": "Central Warehouse", "procedure": "Choose the warehouse." },
{ "id": "s05", "kind": "click",  "field": "action_confirm", "procedure": "Confirm the order.",
  "note": "If the customer is missing, Odoo raises ValidationError: check step s03." }
```

`procedure` is ONE sentence of what the user does and sees (OCA rule 1 sentence /
1 image); `null` marks a TODO for the storyteller. The generated image is
annotated with a `data-dsh-step` label that is removed before saving the PNG
(verified: `capture.json.overlaysRemoved === true`).

## UI families per version

`UI_FAMILIES` is indexed by major (15–19); a major with no family is
refused (`familyFor` → BLOCKED) instead of guessing selectors. Family 17
is **verified with E2E** (`tests/capture.mjs`); 15/16/18/19 share
equivalent selectors and are DECLARED UNTESTED: contrast them against
a real dev instance before capturing production. Browser `auto` =
Playwright's Chromium → system Chrome → Edge; with none of them, the answer
is `NEEDS_BROWSER` with the remedy (`npx playwright-core install chromium`).

## Session and privacy

- The session cookie lives IN MEMORY (`OdooClient.webLogin`); an API key
  credential cannot open a web session (Odoo refuses it on interactive
  logins) → `NEEDS_WEB_SESSION`. Alternative: `odoo_session` writes
  `.sdd/session.json` (chmod 600, value never returned to the model).
- The origin lock aborts every request outside the instance's baseUrl.
- Capture over a demo/disposable DB. Captures that go to
  `static/description/` are PUBLIC (Apps and GitHub): zero data of real
  people; `zoom` (1–2) only changes sharpness, it never crops identity.
- Language: the session opens in the configured user's language; if it differs
  from the manual's language, BLOCKED with remediation — it is never written to
  `res.users`.

## Resume

Capture stops at the first failing step and writes `capture.json`; run it again
with `from_step: "<failed step id>"` after fixing the storyboard.
Each PNG is recorded in `flow.captures` (create-only by `stepId`).

## Import an existing recording (`import`)

If there is already an `npx playwright codegen` recording (`@playwright/test` or
the library API), `operation=import` turns it into a storyboard flow
instead of capturing again: `recording` (path inside the project),
`flow_title` and `replace` (matching by title is create-only without it).

- The recording is read as TEXT and refused if it carries credentials:
  password fields, `addCookies`/`setExtraHTTPHeaders` with
  `Authorization` or any value that looks like a secret. The answer
  names the line and NEVER repeats the value.
- The steps come in with `procedure: null` and the raw locator in `note`:
  the storyteller names the field/button against the canon and writes the
  sentence. A locator that does not match a SINGLE canon field stays generic with
  WARN `import-unmapped-field`; a button that is not in the canon, with
  `import-unmapped-target` (it is never guessed).
- The imported flow goes through the SAME `lint` and the same capture as one
  written by hand; importing exempts you neither from `from_step` nor from the
  action gate.
