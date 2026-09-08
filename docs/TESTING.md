# Testing guide

What to run, when, and what counts as evidence. The strategy behind it — the
scenario matrix and the known gaps — is in [TEST-PLAN.md](TEST-PLAN.md).

## The one rule

**A test you have never seen fail is a test you cannot trust.**

Write the assertion, run it against the unfixed code, watch it fail, then fix
the code. Paste the failing output into the PR. This is not ceremony: the
tab-load race shipped because a stub made the bug impossible to reproduce, and
every test around it passed for months.

## Before and after every change

```bash
node test/run.js
```

Fast, no browser. It checks that every file parses, that every manifest and
`importScripts` reference resolves, that no stray file would reach the store
bundle, that the wiring holds, and it runs the behaviour suites.

## When the extractor changed

`ldparse.js`, `inject-extract.js`, `adapters.js` — anything that turns a page
into a price. The fixture suite needs real DOM APIs, so it runs in a browser:

```bash
node test/serve.js
```

Then open `http://localhost:8731/test/extract.html`. Expect `N passed, 0 failed`.

## When the popup changed

The harness runs the real popup against a stubbed `chrome.*`, so any screen can
be inspected without loading the extension:

```bash
node test/serve.js
```

Then open `http://localhost:8731/test/harness.html?mode=guards`.

Modes: `list`, `empty`, `noprice`, `guards`, `soldout`, `lowconf`. Extend
`test/harness.html` rather than writing a new harness — it was rebuilt from
scratch fifteen times before anyone noticed it was infrastructure.

## When a real site is involved

```bash
node test/live-fetch.js                 # the default page list
node test/live-fetch.js <url> <url>     # whichever pages you name
```

This is a probe, not a suite. Live prices change hourly, so there is nothing to
assert and it must never run in CI. Read the `WOULD DO` column — that is the
decision `acquire()` makes for each site.

Run it monthly, or whenever someone reports that checking stopped working.

## What kind of test to write

Match the test to the failure you are preventing.

| The change touches | Write |
|---|---|
| A calculation or a decision | A behaviour test in `store.test.js` or `pipeline.test.js` |
| How a page is read | A case in `test/extract.js`, against markup shaped like the real site |
| Whether two pieces are connected at all | A static check in `test/run.js` |
| Ordering, timing, or load lifecycle | Both: a wiring check *and* a behaviour test that can reproduce the bad order |

### Wiring, specifically

When code depends on injection, wiring, or load order, assert on the wiring
itself, not only on the logic. A test that supplies a dependency the real
caller must supply will pass while production is broken.

`test/run.js` already carries three of these, and each exists because something
shipped broken and no behaviour test could have noticed:

- **Injection wiring** — anything injecting `inject-extract.js` must inject
  `ldparse.js` first, or the JSON-LD layer silently does nothing.
- **Message wiring** — every `msg.type` the worker answers must have a sender.
  `checkOne` shipped with a handler and no caller, so retry did not exist.
- **Tab load wiring** — `waitForComplete` must consult the tab's status, not
  only the event stream, and a load timeout must not abandon a readable page.

Add to these when you add a seam.

### Stubs

A stub must not hand the code under test a guarantee the real world withholds.
The tab stub in `pipeline.test.js` models a load lifecycle with `tabLoadMode`
so the listener race is reproducible:

- `afterListener` — the ordinary case
- `beforeListener` — a cached page, already loaded before the worker listens
- `never` — a page that hangs

If a stub cannot express the failure you are worried about, fix the stub first.

## Adding a fixture

A fixture earns its place by having broken something. Capture the page, put it
in `fixtures/`, and write the case that fails without your fix.

```bash
bash test/capture-fixtures.sh
```

Captured pages are gitignored — they are large, and they go stale. The suite
asserts on structure and behaviour, not on the prices of the day, so update the
expected values in `test/extract.js` when a store has moved on.

## Before you open the PR

The template in `.github/PULL_REQUEST_TEMPLATE.md` asks for the runs above and
for the proof that your new test fails without your fix. Fill it in with real
output. An unticked box is information; a ticked box with no output is not.
