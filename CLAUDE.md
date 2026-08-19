# Price Tracker

A Manifest V3 Chrome extension that watches product prices. No account, no
server, no analytics — everything lives in `chrome.storage.local`.

## Before and after every change

```bash
node test/run.js
```

It checks syntax, resolves every manifest and `importScripts` reference, guards
against stray files reaching the bundle, and runs the behaviour suites. For the
extractor suite, which needs real DOM APIs:

```bash
node test/serve.js          # then open http://localhost:8731/test/extract.html
```

## Layout

`price-tracker/` is the extension, and the only thing that ships. Whatever sits
in that folder ends up in the store package, so tests, docs and notes belong
outside it. Tests are in `test/`, documents in `docs/`, captured pages in
`fixtures/` (gitignored — regenerate with `bash test/capture-fixtures.sh`).

## Looking at the UI

`test/harness.html` runs the real popup against a stubbed `chrome.*`, so any
screen can be inspected without loading the extension:

```bash
node test/serve.js          # then http://localhost:8731/test/harness.html?mode=guards
```

Modes: `list`, `empty`, `noprice`, `guards`, `soldout`, `lowconf`. Extend this
file rather than writing a new harness — it was rebuilt from scratch fifteen
times before anyone noticed it was infrastructure.

## The rule the product is built on

Prefer refusing to record a price over recording a guess. Price history is the
whole point, and a wrong number corrupts it permanently while looking correct.
That is why readings carry a confidence level, why an implausible jump waits for
a second opinion, and why a category page reports nothing rather than picking an
item off the shelf.

Nothing fails silently. When a check cannot proceed the row says so —
`CAN'T CHECK`, `CAN'T VERIFY`, `CONFIRMING`.

## Fixtures are real pages

Each captured page in `fixtures/` is kept because it broke the extractor once:
offers nested under `hasVariant` (on.com), a store serving a different colour
than the URL asked for (Zappos), fourteen size variants sharing one URL
(Allbirds). Add a fixture whenever a real site breaks something.
