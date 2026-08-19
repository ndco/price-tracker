# Price Tracker

A Chrome extension that watches prices on product pages and tells you when they
drop. Everything stays on your machine: no account, no server, no analytics.

![version](https://img.shields.io/badge/version-1.0.0-1F7A4D)
![manifest](https://img.shields.io/badge/manifest-v3-1C1E1B)
![chrome](https://img.shields.io/badge/chrome-110%2B-A4661A)

**Status:** v1.0.0, feature complete, 118 tests passing against real captured
product pages. Not yet submitted to the Chrome Web Store — the listing copy and
privacy policy are written and waiting in [`docs/`](docs/).

## What it does

- Reads the price off a product page and tracks it on a schedule
- Alerts on any drop, or only when it reaches a target you set
- Shows price history as a chart with your target drawn on it
- Watches sold-out items and tells you when they come back
- Snooze, pause, sort, filter, and CSV export/import

## Install

Not on the Chrome Web Store yet, so load it yourself:

```bash
git clone https://github.com/ndco/price-tracker.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the **`price-tracker/`** folder inside the clone

Point Chrome at `price-tracker/`, not the repository root. The extension is kept
in its own folder so the tests, docs and captured pages never end up inside the
packaged build — `node test/run.js` fails if anything strays in there.

Requires Chrome 110 or newer.

## How it reads a price

Structured data first, guessing last. The first layer that answers confidently wins.

| # | Source | Confidence |
|---|---|---|
| 1 | JSON-LD (`schema.org` Product/Offer, including `hasVariant`) | high |
| 2 | Platform data (Shopify's `.json` endpoint — gives per-size prices) | high |
| 3 | State blobs (`__NEXT_DATA__`, `__NUXT_DATA__`) | medium |
| 4 | Meta tags and microdata | medium |
| 5 | DOM scan, scoped to the product region | low/medium |

A scheduled check tries a plain `fetch` first and only opens a background tab
when the cheap path cannot answer confidently.

**It refuses rather than guesses.** On a category or search page — many offers,
none of which claims the page — it reports no price instead of picking a tile.

## Guards on the data

Price history is the whole point, and a wrong number corrupts it permanently.

- **Identity check** — a re-check that lands on a different colour or SKU than
  the one you confirmed is rejected, not recorded as a price change
- **Sanity gate** — a move over 60% is held until a second check agrees
- **Confidence gate** — anything below high confidence needs corroboration
- **Currency guard** — a page that switches currency is flagged, not compared
- **Provenance** — every history point records which layer produced it

Nothing fails silently: a stalled item says `CAN'T CHECK`, `CAN'T VERIFY`, or
`CONFIRMING` on its row.

## Layout

```
price-tracker/     the extension — this folder is what Chrome loads, and what
                   gets zipped for the store; nothing else ships
  manifest.json
  background.js    service worker: scheduling, checks, alerts, badge
  inject-extract.js  runs in the page; the 5-layer cascade
  ldparse.js       DOM-free JSON-LD parsing, shared by both paths
  adapters.js      Shopify and other platform endpoints
  rules.js         per-site rules: shipped, learned, and corrected
  store.js         storage, schema, migration, CSV
  compute.js       derived values (deltas, targets, history stats)
  chart.js         SVG sparklines and detail charts
  popup.*          the UI
docs/              design spec, privacy policy, store listing
fixtures/          real captured product pages used by the tests
test/              test runner and suites
```

## Tests

```bash
node test/run.js
```

Checks syntax, verifies every manifest and `importScripts` reference resolves,
guards against scratch files leaking into the bundle, and runs the behaviour
suites. The extractor suite needs real DOM APIs:

```bash
node test/run.js --serve
```

then open `http://localhost:8731/test/extract.html`.

Fixtures are real pages captured from on.com, Zappos and Allbirds, kept because
each one exposed a bug: variant offers nested under `hasVariant`, a store
serving a different colour than the URL asked for, and 14 size variants sharing
one URL.

## Known limits

- Sites that block automated requests (some large retailers) cannot be checked;
  the item says so rather than going quiet
- Size is only trackable when the page publishes it — reliable on Shopify,
  absent on many others
- No cross-retailer price comparison; that needs a data source this doesn't have

## Licence

Code: MIT. Bundled font: JetBrains Mono, SIL Open Font License (see
`price-tracker/fonts/OFL.txt`).
