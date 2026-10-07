# Tests and the red-green cycle (Odoo)

Everything this plugin expects of a module's tests, and the half of "test-first"
it can actually check. Read it before phase 3 (WRITE_CODE) for a bug spec, and
before phase 4 (VERIFY) for any spec.

An install that succeeds proves the module LOADS. It does not prove the
behaviour is right, and it cannot prove the defect is gone. That is what tests
are for, and why `test-plan.md` closes every acceptance criterion with a real
result instead of a hopeful one.

---

## 1. What Odoo actually runs

- Tests live under `<module>/tests/`, and **Odoo loads only the modules
  `tests/__init__.py` imports**. A test file nobody imports never runs, and
  nothing in the install log says so. `odoo_tests operation=check` reports it as
  an ERROR.
- A test case is a `class` inheriting one of Odoo's cases. A `def test_…` on a
  plain class (or on `unittest.TestCase`) is not collected by Odoo's runner:

| Case | Use it for |
|---|---|
| `TransactionCase` | Business logic, ORM, constraints, computes, workflows. Gives `self.env` and rolls the transaction back after EACH test. |
| `HttpCase` | Website routes, controllers, anything through HTTP, and tours (`start_tour`). |
| `SavepointCase` | Odoo ≤ 16 only: when the test must assert that a failed operation rolled back. Removed in 17 — `TransactionCase` covers the savepoint. |
| `BaseCase` | No transaction at all; almost never what you want. |

- Run them with `--test-enable` and select by tag:
  `--test-tags /my_module` or `--test-tags post_install,-at_install`. A test
  tagged `at_install` runs while modules are still being installed, with a
  partial registry — prefer `post_install`.
- A tour is not a result: it becomes evidence only when something executes it
  (`HttpCase.start_tour`). See `references/tours-and-demo.md` for the
  version-specific registration API.

## 2. Red, green, refactor

The cycle, as the pipeline uses it:

1. **RED — the test fails first.** Write the test that expresses the behaviour
   (or reproduces the defect) and RUN it. It must fail, and fail for the right
   reason: an assertion about the behaviour, not an import error and not a
   typo. The failure is the proof that the test can detect the problem.
2. **GREEN — the smallest change that makes it pass.** Implement, run again,
   watch it pass. Nothing else should change in the same step.
3. **REFACTOR — clean up with the test green.** Improve structure, re-run,
   keep it green. Refactoring is not optional; it is the phase that keeps the
   next change cheap.

For `mode=bug` the pipeline **enforces step 1**: leaving `WRITE_CODE` for
`VERIFY` is refused until `test-plan.md` records the reproduction that failed
first, in one of these two forms:

```markdown
| AC | Scenario | Layer | Status |
|---|---|---|---|
| AC1 | total applies the discount once | server | red (test_total_discount -> AssertionError: 90 != 100) |
```

```markdown
| AC | Scenario | Layer | Status |
|---|---|---|---|
| AC1 | total applies the discount once | server | pass (red first: 90 != 100) |
```

Both say the same thing and both are accepted. A bare `pass` is not: written
after the fix, it is indistinguishable from a test that never failed, and a
regression test that never failed proves nothing. If the defect is fixed by
configuration or data rather than code, run that work as `mode=functional` —
there is no code to test first.

For a NEW module (`mode=create`) the pipeline does not demand RED evidence:
there is no defect to reproduce, and inventing a ritual for every criterion
would just train everyone to write the row without doing the work. The cycle
still applies — it is how you find out the design is wrong before it is built —
but it is not a gate.

## 3. What makes a test trustworthy

- **It can fail.** A test with no assertion reports green whatever the code
  does. `odoo_tests operation=check` flags it, and flags the trivially-true
  forms (`assertTrue(True)`, `assertEqual(1, 1)`, an empty body).
- **It has one path.** `if/else` inside a test can silently skip the branch
  that would have failed. Test both branches as separate tests.
- **It does not swallow the error.** `try/` without `assertRaises` turns an
  exception into a passing test.
- **It is independent.** Odoo rolls the transaction back per test; a
  `cr.commit()` inside a test destroys that isolation and leaks data into every
  later test. Set up what you need in the test or in `setUpClass`.
- **It is deterministic.** No `time.sleep` (wait on the state, not the clock),
  no unseeded randomness, no dependency on the machine's locale or clock.
- **It names the behaviour.** `test_rejects_negative_amount` says what should
  happen; `test_1` says nothing to the person reading a red CI in six months.
- **Arrange–Act–Assert.** Set up the data, perform the one action, assert the
  observable outcome. Testing internals (`_compute_x` call counts) couples the
  test to the implementation and breaks on refactors that change nothing.
- **Skips are counted.** `@unittest.skip` / `SkipTest` are legitimate
  temporarily, but a suite that skips is less green than it looks — say why in
  the skip message.

## 4. Coverage, honestly

- Coverage is a **map of what nobody exercised**, not a score. A file covered by
  tests that assert nothing is worse than an uncovered file: it looks tested.
- Useful reference points, when you have a report: line coverage ~80%, branch
  coverage ~70%, and 100% on the paths where a mistake costs money or data
  (permissions, validation, anything that moves stock or money).
- **This plugin does not gate on line coverage.** A broad threshold gets waived
  the first time it is inconvenient, and after two waivers nobody reads it. What
  it gates on is narrower and checkable: the `must`/`shall` requirements of the
  spec must be covered (`odoo_validate` with `spec_dir`), and every acceptance
  criterion must carry a real result (`sdd_phase succeed`).
- To produce a report, run the suite with coverage in your own environment
  (`coverage run` around the Odoo test run, then `coverage xml`) and read the
  numbers there. The plugin does not run the test suite.

## 5. Working with the pipeline

```text
odoo_tests operation=check    module_dir=<module>                  # hygiene, no spec needed
odoo_tests operation=plan     module_dir=<module> spec_id=<spec>   # criterion -> test mapping
odoo_tests operation=scaffold module_dir=<module> spec_id=<spec>   # RED stubs for what is missing
```

- `plan` lists the acceptance criteria no test mentions (by AC id, or by the
  `REQ-<AREA>-NN` id of the requirement that carries it). The reference is what
  counts: putting `REQ-…`/`AC…` in the docstring is how a reader connects a test
  to the criterion it protects.
- `scaffold` writes `tests/test_<module>_sdd.py` with one method per uncovered
  criterion and a body that raises `NotImplementedError`: a **RED stub**, never
  a vacuous pass. Existing files are never overwritten — missing methods are
  appended — and the import is added to `tests/__init__.py` so the file actually
  loads. Run the suite and watch the new tests fail: that failure is the RED
  half of the cycle.
- Annotate the implementation with `REQ-<AREA>-NN` where it satisfies the
  requirement, and the tests that exercise it too. `odoo_validate` then reports,
  in both directions, what the spec asks for and what the code actually points
  at.
