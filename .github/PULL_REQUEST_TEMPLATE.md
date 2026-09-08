<!--
Fill in what you did and what you ran. Delete rows that do not apply, but do
not delete a row because it was inconvenient — an unticked box is information.
The testing guide is docs/TESTING.md, and the strategy behind it is
docs/TEST-PLAN.md.
-->

## What changed

<!-- One paragraph. What was wrong, and what this does about it. -->

## Why

<!-- What breaks for a user without this. If it is a bug, say how it reached
     production — that usually names the test that was missing. -->

## Testing

**Always:**

- [ ] `node test/run.js` passes

**If the extractor, `ldparse.js`, or the adapters changed:**

- [ ] Fixture suite passes — `node test/serve.js`, then `/test/extract.html`
- [ ] Result pasted below (`N passed, 0 failed`)

**If the popup changed:**

- [ ] Checked in `test/harness.html` — modes touched: <!-- list, empty, noprice, guards, soldout, lowconf -->
- [ ] No console errors

**If acquisition, ordering, injection, or storage changed:**

- [ ] A wiring assertion was added, not only a behaviour test
- [ ] **The new test was run against the unfixed code and failed.** Output pasted below.

**If a real site prompted this:**

- [ ] A fixture or a case reproducing that site's shape was added
- [ ] `node test/live-fetch.js` run, and anything it turned up is noted below

```
paste test output here
```

## Proof it bites

<!-- For any bug fix: the new test failing against the old code. A test you
     have never seen fail is a test you cannot trust. Skip this only for pure
     additions with nothing to regress. -->

```
paste the failing run here
```

## Not in scope

<!-- Anything you found and deliberately left alone. Say why. -->
