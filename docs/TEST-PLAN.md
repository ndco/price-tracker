# Test plan

## What this is protecting

One rule, from `CLAUDE.md`:

> Prefer refusing to record a price over recording a guess.

A wrong price is worse than no price. It corrupts history permanently while
looking correct, and it does so silently — the row keeps updating, the chart
keeps drawing, and nothing tells the user the number is invented.

Every test below exists to catch one of three failures, in this order:

1. **A wrong number recorded as fact.** The worst outcome. History is
   permanent and a bad point never announces itself.
2. **A right number never recorded.** The extension goes quiet. Users notice
   this eventually, but only after they miss the sale they were waiting for.
3. **A right number recorded late.** The confirmation gate doing its job.
   Acceptable, and not a bug.

## The four layers, and what each one cannot see

Each layer has a blind spot. Naming it is the point — the tab-load race
survived to production because every layer's blind spot covered it.

| Layer | Run by | Catches | Cannot see |
|---|---|---|---|
| Behaviour suites | `node test/run.js` | Logic: judgement, snooze, CSV, storage | Anything involving real Chrome ordering |
| Wiring checks | `node test/run.js` | Whether pieces are *connected* at all | Whether a connected piece is correct |
| Fixture suite | `test/extract.html` | Extraction against real captured pages | Pages nobody captured; anything client-rendered |
| Live probe | `node test/live-fetch.js` | What real sites do *today* | Nothing repeatable — sites change hourly |

**The rule that follows from this table:** when code depends on injection,
wiring, or load order, assert on the wiring itself, not only on the logic. A
test that supplies a dependency the real caller must supply will pass while
production is broken.

That is not a hypothetical. `test/pipeline.test.js` used to stub the tab like
this:

```js
onUpdated: { addListener: (fn) => setTimeout(() => fn(7, {status: "complete"}), 1) }
```

The page appeared to load *because the worker started listening*, which is the
one ordering guarantee Chrome does not give. Every logic test passed while the
checker silently retired items.

## Scenario matrix

Marked ✅ covered, ⚠️ partly covered, ❌ not covered.

### A. Acquisition — which source answered

| # | Scenario | Layer | State |
|---|---|---|---|
| A1 | Shopify `.json` endpoint answers with variants | pipeline | ✅ |
| A2 | Shopify handle redirects; canonical probe recovers it | pipeline | ✅ |
| A3 | Served HTML carries usable JSON-LD; no tab needed | pipeline | ✅ |
| A4 | Served HTML too weak; escalates to a tab | pipeline | ✅ |
| A5 | Known blocker skips the pointless fetch | pipeline | ✅ |
| A6 | Known blocker also skips the pointless *tab* | — | ❌ |
| A7 | Meta-tag-only page (no JSON-LD) | fixture | ✅ |
| A8 | State blob (`__NEXT_DATA__` / `__NUXT_DATA__`) | fixture | ⚠️ synthetic only |
| A9 | Site serves different HTML to fetch than to a browser | — | ❌ |

### B. Tab load ordering — where the bug lived

| # | Scenario | Layer | State |
|---|---|---|---|
| B1 | Page completes *after* the listener attaches | pipeline | ✅ |
| B2 | Page completes *before* the listener attaches | pipeline | ✅ |
| B3 | Page never signals complete; price still readable | pipeline | ✅ |
| B4 | Page never signals complete; nothing readable | pipeline | ✅ |
| B5 | `waitForComplete` consults tab status, not only events | wiring | ✅ |
| B6 | Tab is closed by the user mid-check | — | ❌ |
| B7 | Page redirects; `complete` fires for the interstitial | — | ❌ |
| B8 | Client-renders the price *after* the 1500 ms sleep | — | ❌ |

### C. Page shape — what the extractor is looking at

| # | Scenario | Layer | State |
|---|---|---|---|
| C1 | One offer, one price | fixture | ✅ |
| C2 | Many variants, all the same price (Allbirds, 14 sizes) | fixture | ✅ |
| C3 | Offers nested in `hasVariant` (on.com) | fixture | ✅ |
| C4 | Store serves a different colour than the URL asked for | fixture | ✅ |
| C5 | Category / shelf page — must refuse | fixture | ✅ |
| C6 | Recommendation carousel must not win | fixture | ✅ |
| C7 | Struck-through list price captured, not chosen | fixture | ✅ |
| C8 | **Many variants, different prices, all sharing one URL** | — | ❌ **see G1** |
| C9 | **Offers that are not product prices** (unit, installment) | — | ❌ **see G1** |
| C10 | Page with no `class*="price"` anywhere | — | ❌ **see G2** |
| C11 | Sold out; watched for return | pipeline | ✅ |

### D. Judgement — should this reading be believed

| # | Scenario | Layer | State |
|---|---|---|---|
| D1 | High confidence, believed at once | pipeline | ✅ |
| D2 | Medium confidence, small move, believed | pipeline | ✅ |
| D3 | Medium confidence, large move, held | pipeline | ✅ |
| D4 | Move over 60%, held for a second opinion | pipeline | ✅ |
| D5 | A real 70% clearance is delayed, not lost | pipeline | ✅ |
| D6 | Currency switch is not a price change | pipeline | ✅ |
| D7 | Identity mismatch stops the record | pipeline | ✅ |
| D8 | **Low confidence agreeing with a wrong baseline** | — | ❌ **see G1** |

### E. Recovery — the ratchets

| # | Scenario | Layer | State |
|---|---|---|---|
| E1 | Failure streak retires an item after 3 | store | ✅ |
| E2 | A success clears the streak | pipeline | ✅ |
| E3 | Cheap-path success clears `needsTab` | pipeline | ✅ |
| E4 | A week-old `needsTab` earns a fresh probe | pipeline | ✅ |
| E5 | A known blocker is never re-probed | pipeline | ✅ |
| E6 | TRY AGAIN revives a retired item | manual (harness) | ⚠️ |
| E7 | Every worker message type has a sender | wiring | ✅ |

### F. Persistence and lifecycle

| # | Scenario | Layer | State |
|---|---|---|---|
| F1 | A throw mid-run keeps earlier readings | pipeline | ✅ |
| F2 | Worker terminated mid-`checkAll` | — | ❌ |
| F3 | Popup edits an item while a check is running | — | ❌ |
| F4 | Alarm survives a worker restart | — | ❌ |

## Gaps found by live testing, ranked

Run on 2026-09-07 against 20 live retail pages. Full method in
`test/live-fetch.js`; the rendered-page findings were taken by driving a real
browser.

### G1 — A confidently wrong price, recorded silently 🔴

Three of the sites tested publish JSON-LD offers that are **not the product's
price**, all carrying the page's own URL so nothing can tell them apart:

| Site | Offers | Prices published | Extractor picks | Page actually sells at |
|---|---|---|---|---|
| REI | 170 | 19.83 / 20.83 / 34.83 | **19.83** | $79.95 |
| Backcountry | 42 | 169 / 118.30 | **118.30** | $169 (meta agrees) |
| Sephora | 22 | 19.20 / 24 / 25 | **19.20** | $24–25 |

The reading is marked `conf: "low"`, so the gate holds it. That gate does not
hold for long:

```
after add:      lastPrice=19.83  history=1
check 1:        lastPrice=19.83  history=1  held=false  suspect=""
check 2:        lastPrice=19.83  history=1  held=false  suspect=""
```

`judge()` believes a low-confidence reading when it agrees with what we already
had. A *consistently* wrong reading always agrees with itself, so it launders
itself into history on the very next check. The row then shows no `CAN'T
VERIFY`, no `CONFIRMING`, nothing — a tracked item that looks completely
healthy and will never fire an alert.

This is the exact failure the product rule exists to prevent, and it is the
highest-value thing to fix next.

Worth testing as fixes: refuse rather than demote when tied offers disagree on
price and nothing distinguishes them; prefer the `og:price:amount` meta tag
when it disagrees with a tied-offer pick (it was right on Backcountry); and
never let "agrees with the last reading" alone promote a low-confidence read
that has *never* been corroborated by a stronger layer.

### G2 — The DOM heuristic cannot see modern storefronts 🟠

`PRICE_SEL` is `[class*="price" i],[id*="price" i]`. Measured on the live
rendered DOM:

| Site | Nodes matching `PRICE_SEL` |
|---|---|
| Walmart | 0 |
| REI | 0 |
| Sephora | 0 |
| Target | 2 |
| IKEA | 48 |
| Newegg | 72 |

Sites with hashed class names publish nothing containing "price". For Walmart
and Target there is also no JSON-LD and no price meta tag, so **every layer
fails** — rendered or not. Those two are currently unreadable, and no test says
so.

### G3 — The cheap path almost never wins in the wild 🟠

Of 20 live pages, **4 read without a tab**. The rest were bot-walled (403/429),
served no structured data, or returned markup with no price.

```
20 pages — 4 read without a tab, 16 would escalate, 0 threw
```

This makes the tab path the normal path, not the exception — which is why the
load-ordering bug was so damaging, and why the serial ~33 s-per-item loop
matters more than it looks. A 20-item watchlist is a ten-minute run of opening
and closing tabs in the user's browser.

## How to run

Before and after every change:

```bash
node test/run.js
```

The extractor fixture suite, which needs real DOM APIs:

```bash
node test/serve.js
```

Then open `http://localhost:8731/test/extract.html`.

Any popup screen, without loading the extension:

```bash
node test/serve.js
```

Then open `http://localhost:8731/test/harness.html?mode=guards`.

The live probe — occasionally, and never in CI:

```bash
node test/live-fetch.js
```

## Cadence

- **Every change:** `node test/run.js`. Non-negotiable, and fast.
- **Every extractor change:** the fixture suite as well.
- **Every acquisition or lifecycle change:** add the wiring assertion first,
  and confirm it fails before you fix the code. A wiring test you never saw
  fail is a wiring test you cannot trust.
- **Monthly, or after any "it stopped working" report:** the live probe. When a
  site has moved on, capture it into `fixtures/` and write the case — that is
  how every fixture in there was born.

## Adding a case

A new fixture earns its place by having broken something. Capture the page,
add it to `fixtures/`, and write the assertion that fails without the fix.

For anything touching ordering, injection, or storage, write the wiring
assertion too, and watch it fail first. The three checks in `test/run.js`
under **Injection wiring**, **Message wiring**, and **Tab load wiring** each
exist because something shipped broken and no behaviour test could have
noticed.
