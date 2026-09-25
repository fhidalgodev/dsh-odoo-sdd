# Business methods — declaring any model's action, and proving it worked

Reference for functional runs (see `../SKILL.md`). It is deliberately
**domain-neutral**: which methods exist is a property of the model and the
version, never of this plugin. Nothing here names a module, and nothing here
should be read as a recipe for one.

## What a business method is

Every RPC method falls into exactly three kinds:

- **read** — a query: `search`, `search_read`, `search_count`, `read`,
  `read_group`, `fields_get`, `name_get`, `name_search`, `default_get`,
  `exists`, `check_access_rights`, `check_access_rule`. Safe in a discovery
  batch, and free of confirmation on the RPC.
- **CRUD** — `create`, `write`, `unlink`. The plugin can read a pre-image and
  replay it, which is why the data journal and `compensate` cover them.
- **business** — everything else: the methods a model exposes to *do* something
  (`action_*`, `button_*`, `do_*`… the naming convention varies by version and
  model). They run code the plugin cannot replay: the records they change are
  usually not the ones you passed in.

## Two ways to run one

| | Functional batch (`kind: "method"`) | Ad-hoc RPC (`odoo_execute`) |
| --- | --- | --- |
| Authorization | the exact `model.method` pair in `methodAllowlist`, decided once by a human | `confirm_destructive=true` on each call |
| Approval | the batch is approved (hashes bound to the spec/design) before it runs | none beyond the confirmation |
| State guard / proof | `precondition` and `postcondition` are **required** | both optional; a missing postcondition is warned about |
| Journal / undo | never journaled, never auto-compensated | same — the result says no undo exists |
| Indeterminate outcome | `indeterminate`, reconciled against the instance | reported as INDETERMINATE, never retried |
| Best for | several operations, a production target, a runbook a person repeats | one call, on a disposable dev/staging database, while you are reading the code |

Either way, the plugin never journals a business method and never pretends it can
undo one.

## Finding out what a method does — before declaring it

There is no RPC that lists methods, and guessing one is how a batch fails at the
worst moment. In order of reliability:

1. **The source of the exact version and edition you target.** The plugin's
   configuration already points at them (`communityRepoPath` / `communityRepoUrl`
   and the enterprise equivalents, set with `odoo_config`). Read the model:
   - what arguments it takes (the batch passes `args` positionally, and `args[0]`
     must be the record ids — Odoo dispatches the call on that recordset);
   - whether it returns anything meaningful (most return `True`/`None`/a dict:
     see "the return value is not evidence");
   - what it changes *besides* the records you passed (lines, moves, states on
     related models, downstream documents) — that is what your postcondition has
     to look at, and what decides the recovery;
   - whether it is guarded (`@api.model` methods ignore the recordset; a method
     that raises on the wrong state is telling you what the precondition is).
2. **Official documentation** for the version, when it exists.
3. **A read-only discovery batch** to confirm the fields and states you plan to
   assert on (`fields_get` for the field names, `search_read` for the states the
   records are actually in).

Never declare a method you have not read: an invented name is refused by the
executor, and a real name with the wrong expectations is worse — it runs.

### Private methods are not callable, and that is Odoo's rule

A name starting with `_` cannot be called over RPC at all. `execute_kw`
dispatches through `get_public_method` (`odoo/service/model.py`), which answers
`AccessError: Private methods (such as 'model._name') cannot be called remotely.`
for a leading underscore, for `init`, for methods decorated with `@api.private`
(17+) and for the internal attribute names; an inexistent method answers
`AttributeError` instead. Older series (10–13) checked the same thing inside
`execute_kw`. The plugin refuses it first so you get the reason locally, but no
amount of confirming changes the server's answer.

So when the source shows the work being done by a private method, read one step
outwards and call the public entry point that wraps it:

- a **wizard** method: `sale.order._create_invoices()` is private, while
  `create_invoices()` on the `sale.advance.payment.inv` wizard is public and
  takes the orders in its context;
- a **button/action** on the model: `action_*`/`button_*`, which is what the
  form view calls anyway (and what a batch's `args[0]` recordset targets);
- when only the private path exists and no public wrapper does, the honest answer
  is a **manual step** in the runbook with its exact button label — the
  postcondition read is still the evidence.

## Declaring the operation

```json
{
  "kind": "method",
  "intent": "what this achieves, in business terms (it ends up in the runbook)",
  "model": "<model>",
  "method": "<method>",
  "args": [[1, 2, 3]],
  "identity": [{ "field": "<stable field>", "value": "<value>" }],
  "precondition":  { "domain": [["id", "in", [1, 2, 3]], ["state", "=", "<before>"]] , "expect": "count", "count": 3 },
  "postcondition": { "domain": [["id", "in", [1, 2, 3]], ["state", "=", "<after>"]] , "expect": "count", "count": 3 },
  "recovery": { "kind": "none", "note": "how a person reverses this, or why it cannot be reversed" }
}
```

Rules the validator enforces, and why each one exists:

| Rule | Reason |
| --- | --- |
| The pair is in `methodAllowlist` | A method is code the plugin cannot replay. A human decides, once, which ones a run may call. |
| `args[0]` holds the record ids | Odoo dispatches the call on that recordset; without ids there is nothing to act on. |
| `precondition` is required | Most of these methods are **not idempotent**. The guard is also what stops a second run from repeating an action that already happened. |
| `postcondition` is required | `applied` must mean the state was reached. See below. |
| `recovery` is `none` or `manual` | `restore_preimage` is refused: the plugin never read the records the method changes, so it cannot promise that undo. |
| `apply` scope only | A business method is a mutation: it cannot live in a discovery batch. |

## Calling it from the RPC

```json
{
  "model": "<model>",
  "method": "<method>",
  "ids": [1, 2, 3],
  "args": ["<extra positional after the ids>"],
  "kwargs": { "<method keyword>": "<value>" },
  "precondition":  { "domain": [["state", "=", "<before>"]], "expect": "count", "count": 3 },
  "postcondition": { "domain": [["state", "=", "<after>"]], "expect": "count", "count": 3 },
  "confirm_destructive": true
}
```

- `args[0]` is the recordset (Odoo dispatches on it); `args` carries the
  positionals after it and `kwargs` the keywords. The read/CRUD parameters
  (`values`, `domain`, `fields`…) are **refused** here rather than ignored.
- No `ids` means an empty recordset. Some methods are called on the model itself;
  the result says so, so "I forgot the ids" cannot look like a success.
- The confirmation is the gate: without `confirm_destructive=true` nothing is
  sent at all.
- The state guard runs **before** the call (a failed precondition sends nothing)
  and the proof is read back **after** it (a failed postcondition is reported as
  "the call WAS sent", never as OK).
- A transport/protocol failure after sending one is reported as
  **INDETERMINATE**: the call may have happened. Read the records before doing
  anything else — never "run it again to see".

## The return value is not evidence

Most business methods return something that carries no proof: `True`, `None`, a
dict of counters, sometimes a wizard action. A method can return cleanly and
change nothing (a guard inside it decided the state was not right, a filter
skipped every record, a quantity was zero).

So the **postcondition is the only proof**, and the executor reads it back
before recording the operation as applied. If it does not hold:

- the operation is recorded as **failed**, with `postcondition not met: …`;
- the batch stops and says the call **was sent** — the instance may be
  half-changed, so a blind retry is the wrong move;
- the fix is to inspect the instance and reconcile, not to run it again.

Choose the assertion by asking "what would be different if this had NOT worked?":

- **state**, when the method moves a document through a workflow;
- **an exact `count`**, never "at least one", when the point is that every record
  in the set was affected — one of twenty left behind is the failure this catches;
- **a field on the records the method actually changes** (lines, related
  documents) when the passed-in records are not the ones that move;
- a **second operation whose postcondition** checks the downstream effect, when
  one assertion cannot cover both.

## Traps that apply to any model

- **Non-idempotence.** Running it twice is a different operation. The
  precondition is the guard; without it the plan is refused, not "carefully
  retried".
- **Partial effects.** The method may have touched some records and then raised.
  The run says so; the operator decides.
- **Multi-company.** Run the call and both conditions under the same declared
  company/context, or a read can see nothing and the postcondition fails for the
  wrong reason.
- **Downstream documents.** Some methods create or update records elsewhere
  (lines, follow-ups, backorders, journal entries). Name them in the runbook: the
  plugin cannot undo them.
- **Irreversibility.** When the state change cannot be reversed, declare
  `recovery: "none"` and, in production, give the operation its own batch with
  its own approval.
- **A button that only exists in the UI, or only inside a private method.** Some
  flows advance through a screen action with no clean RPC path, and some work is
  done by a `_private` method that `execute_kw` refuses to reach (see above).
  Declare it as a **manual step** with the exact label, and take the
  postcondition read as the evidence, naming who ran it.
- **Editing configuration to make Odoo do it.** Changing an automation trigger,
  a server action or any other setting so the instance performs the action is
  forbidden: it mutates configuration the run never declared. Use the
  allowlisted method or the manual step.
