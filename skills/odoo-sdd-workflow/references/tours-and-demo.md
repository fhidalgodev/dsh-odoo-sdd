# Web tours and demo data — the version contract, the traps, and what is *not* verified here

Reference for the development modes (see `../SKILL.md`). Two artifacts that most
Odoo modules get wrong in a way no test catches: a tour that never runs because
it was registered with the wrong API or left out of the test asset bundle, and
demo data that either fails to load or grants more access than the module does.

Read this before writing `## Tours` or `## Demo data` in `architecture.md`.

**How this file is meant to be used.** Everything under "Verified" was checked
against Odoo's own source on the branch named. Anything else is guidance and is
marked as such — the last section lists claims that circulate in blog posts and
AI summaries but could not be confirmed, so nobody turns them into a rule.

## Web tours: the registration API moved in 17, not 16

Verified against `addons/account/static/src/js/tours/account.js` in each branch:

| Versions | Registration | Module wrapper | Step actions |
| --- | --- | --- | --- |
| 14, 15, **16** | `require("web_tour.tour").register(name, {test: true, url}, steps)` | `odoo.define("module.name", function (require) {…})` | functions |
| **17**, 18, 19 | `registry.category("web_tour.tours").add(name, {test: true, url, steps: () => [...]})` | `/** @odoo-module **/` + `import { registry } from "@web/core/registry"` | strings (`"click"`, `"edit <value>"`) or functions |

Odoo **16 still uses `tour.register`**: the `odoo.define` wrapper is intact in
that branch. Writing the 17+ registry API into a 16 module does not fail loudly —
the tour is simply never registered, and the only symptom is a test that never
runs.

Two more boundaries worth knowing:

- The file layout changed with the API. 14–16 keep tours under
  `static/src/js/tours/`; from 17 the helper modules live elsewhere
  (`web_tour/static/src/tour_service/`) and **19 reorganised the tree again**
  (`tour_automatic`, `tour_interactive`, `tour_recorder`, `tour_utils.js`).
  Verify the import path against the target branch instead of copying it.
- `stepUtils` (helpers such as the apps-menu step) comes from
  `@web_tour/tour_utils` in the modern layout. Treat the exact path as
  version-specific.

### The asset bundle is what makes a tour run (and what keeps it out of production)

- A tour written for tests belongs to the **test** bundle
  (`web.assets_tests`, and the module's own `assets` entry): it must not be
  loaded for real users, and it must be present when the test runner loads the
  page.
- A tour written for **onboarding** belongs to a user-facing bundle
  (`web.assets_backend` / `web.assets_frontend`) and is not a test.
- `test: true` marks a tour as test-only: it stays out of the onboarding
  suggestions. That flag is not a substitute for the bundle.
- **The trap:** a tour file that exists but is not in any bundle is dead code.
  `odoo_validate` warns about it (see `## Tours` in `architecture.md`), because
  nothing else will.

### The Python side is what executes it

A tour is a script; the test runner executes it through `HttpCase`:

```python
from odoo.tests import HttpCase, tagged

@tagged("post_install", "-at_install")
class TestUi(HttpCase):
    def test_01_flow(self):
        self.start_tour("/web", "my_module_tour", login="admin")
```

- `@tagged("post_install", "-at_install")` is mandatory in practice: an
  `-at_install` HTTP case runs before every module has finished installing its
  views and menus, and the tour fails on a half-rendered interface. Odoo itself
  logs a warning when this is wrong.
- `start_tour` drives a headless browser through the DevTools protocol and waits
  for the tour to report success.
- Consequence for this pipeline: **a tour is not evidence until something runs
  it.** Without shell access to the instance there is no `--test-enable`, so the
  row stays `ui` evidence *declared* by a named human — see `agents/qa.md`.

### Designing steps that survive

- `trigger` is a CSS selector, `extra_trigger` is the stabiliser that must also
  be visible before the step acts — use it against race conditions (an animation
  in flight, a pending RPC).
- `content` is the tooltip in onboarding mode and the console breadcrumb in test
  mode: write it for the human who will debug the failure.
- `run` is a string (`"click"`, `"edit <value>"`) or a function that receives the
  anchor. Prefer the string forms: they survive refactors better.
- Selectors that last: technical identifiers and framework metadata
  (`[data-menu-xmlid=…]`, `.o_field_widget[name=…]`, `.o_list_button_add`).
  Selectors that rot: styling classes, colour/opacity attributes, deep
  `div > span > tr:nth-child(2)` chains. A routine SCSS change must not be able
  to break a tour.
- The last step exists to stabilise: a tour that finishes while the server is
  still writing fails later, in the teardown, with an error that points nowhere.
- `expectUnloadPage: true` on a step whose action navigates away: present in the
  current core tours (18/19). Confirm it exists before using it on an older
  branch.

## Demo data

Three purposes, and they pull in different directions:

1. **Fixtures** for tests and for manual QA, so a flow does not have to invent
   its own records.
2. **Demonstration** for sales and training: a database without records shows
   nothing.
3. **A boundary**: demo data is loaded only when the database is created with
   demo enabled. Nothing in the module's *functionality* may depend on it.

### What is verified about the switches

| Mechanism | Versions | What it really does |
| --- | --- | --- |
| Database created with demo (installer/DB manager) | all | demo data **is** loaded |
| `--without-demo=all` (or a comma-separated module list) | all | disables demo loading **for modules being installed**; the help text states it *requires `-d` and `-i`*. It is not a way to clean an existing database |
| `--with-demo` | **19 only** | `--with-demo`, "install demo data in new databases". It does **not** exist in 14–18 |

So: on 14–18 the demo decision is made when the database is created; on 19 there
is also a flag. Do not write "run with `--with-demo`" in a specification that
targets 16.

### Where demo data lives, and how it is declared

- Files go under `demo/`, declared in the manifest under **`"demo"`**, separate
  from `"data"`. A file in `demo/` that is not declared loads nothing; a declared
  file that does not exist breaks the install.
- **CSV** for flat, atomic records (currencies, countries, immutable tax rates,
  nomenclature codes): one row per record, first row = technical field names,
  plus the external id column.
- **XML** for anything relational: one2many/many2many graphs, base64 images,
  conditional records, `eval` expressions. This is the norm for demo data that
  has to look like a real business.
- **`noupdate="1"`** on a block means "insert once": later module upgrades will
  not overwrite what a human edited. Use it for demo records a consultant is
  expected to touch, and be aware that it also means a fix in the XML will not
  reach an existing database.
- **From 16, `Command` replaces the numeric tuples** (`Command.create(...)`,
  `Command.link(...)`, `Command.set([...])`). The old `(0, 0, {...})` /
  `(6, 0, [...])` spellings still work but are the legacy form the OCA guidelines
  replaced; write `Command`.

### The rules that are objectively checkable (and therefore enforced)

Three OCA XML conventions, mechanical enough to be verified by
`odoo_validate` — the rest of the guidelines need a human reviewer:

1. `id` before `model` inside `<record>`.
2. `name` before `eval` (and before other attributes) inside `<field>`.
3. **No redundant module prefix** in a local external id: inside
   `my_module/demo/foo.xml`, write `<record id="partner_demo">`, not
   `<record id="my_module.partner_demo">`. Odoo derives the module part from the
   file's location.

### The demo-data risks that deserve a second look

- Demo records that create **users, groups or ACL lines**: the most common way a
  demo dataset quietly grants access. `odoo_security_scan` flags them.
- Demo data that references `base.user_admin` or other production-ish records as
  if they were fixtures.
- Splitting demo data across files by domain, not one omnibus file: the OCA rule
  that makes a broken reference findable.
- Never treat demo data as the source of truth for configuration: if a setting is
  required for the module to work, it belongs in `data/`, not in `demo/`.

## Not verified here — do not turn these into rules

These circulate in guides and AI summaries. They may be true for a specific
version, but they were **not** confirmed against the source while writing this
file, so they are guidance at most:

- Step actions `editor {…}`, `selectByLabel {…}`, `selectByIndex {…}` — the
  string forms confirmed in current core tours are `"click"` and `"edit …"`.
- Registration options `skip_enabled`, `wait_for`, `sequence` — plausible, but
  confirm them in the target branch before relying on one.
- `web.qunit_suite_tests` as a bundle for tours: that bundle belongs to QUnit.
  Tours go in `web.assets_tests`.
- Any flag to "force" a `noupdate` record to be rewritten from the CLI.

If a specification needs one of these, verify it against the target branch first
and write the verified fact into `architecture.md`, not the claim.
