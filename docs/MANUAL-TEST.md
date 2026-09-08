# Manual test: first run in real Chrome

Everything in this project has been verified through Node harnesses and
DOMParser documents. This is the pass that uses a real browser, and it is the
last thing standing between here and a store submission.

Budget about 40 minutes. Work top to bottom — each section assumes the one
before it worked.

## 0. Automated first

Do not load anything until these are green. Two minutes.

```bash
node test/run.js
```

Expect `45 passed` (store), `76 passed` (pipeline), and `All checks passed`.

```bash
node test/serve.js
```

Open `http://localhost:8731/test/extract.html` — expect `47 passed, 0 failed`.
Leave the server running; section 5 uses it.

## 1. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → choose `/Users/ndco/Documents/dev/untitled/price-tracker`.

Chrome 110 or newer, per the manifest.

**What to check right here, before clicking anything:**

- [ ] No red **Errors** button on the extension card
- [ ] The card shows *Price Tracker 1.0.0*
- [ ] The toolbar icon appears (pin it — Chrome hides new extensions behind the
      puzzle piece)

Then open the service worker console and keep it open for the whole session —
it is where every failure will surface:

> On the extension card, click **service worker** under "Inspect views".

- [ ] It opens with no red errors
- [ ] `importScripts` did not fail — a failure here means nothing else works

If the card shows an error about a file or directory name, see section 7.

## 2. Smoke test the popup

Click the toolbar icon on a plain page (say `example.com`).

- [ ] The popup opens at roughly 380px wide, no layout collapse
- [ ] The **JetBrains Mono** font renders — if you see a system fallback, the
      bundled `.woff2` is being blocked by the extension CSP
- [ ] It says there is nothing to track, and offers the demo item
- [ ] No errors in the popup console (right-click inside the popup → Inspect)

Switch your OS between light and dark mode.

- [ ] The toolbar icon swaps and stays legible against the toolbar

## 3. The cases these fixes were about

This is the substance. For each site: open the product page, read the price
**off the page with your own eyes**, then open the popup and compare.

Prices move, so never check against a number in this document — check against
what the page in front of you is showing.

### 3a. Variant pages that used to report the cheapest thing on them

| Site | Try |
|---|---|
| REI | any product, e.g. a Co-op rain jacket |
| Backcountry | any Patagonia item with several colours |
| Sephora | any product sold in more than one size |

For each:

- [ ] The popup's detected price **matches the price on the page**
- [ ] If it cannot tell, it says so — *no price found*, or the row shows
      `CAN'T VERIFY`. That is a pass.
- [ ] It never shows a number far below the page price

A suspiciously low number here is the exact bug that was fixed. If you see one,
capture the URL — that is a regression and it matters more than anything else
on this list.

### 3b. A storefront with hashed class names

Walmart. Open any product page.

- [ ] The detected price matches the page
- [ ] It is not a per-unit rate (Walmart prints things like `$25.00/qt` beside
      the real price)
- [ ] It is not a price from a "customers also bought" tile

### 3c. Two variants of one product

on.com, or any store where colours have their own URLs. Track **two different
colours** of the same style.

- [ ] They are stored as two separate items, not merged into one
- [ ] Each shows its own correct price
- [ ] Neither shows the other's price

### 3d. The refusal path

Open a **category or search page** — not a product page — and click the
toolbar icon.

- [ ] It refuses. Expect the "no price on this page" screen.
- [ ] It does **not** offer to track something it picked off the shelf

### 3e. A page with no price at all

Open any article or a sold-out product.

- [ ] It says there is no price, rather than inventing one

## 4. Checking, and the tab-load fix

Track four or five items across different sites, then press **CHECK NOW**.

- [ ] Background tabs open and close on their own
- [ ] The run finishes and the list redraws
- [ ] **Nothing lands on `CAN'T CHECK`** — that chip after a single run is the
      old timeout bug, and it is what PR #1 fixed
- [ ] The service worker console shows no unhandled rejections

Press **CHECK NOW** a second time.

- [ ] Same result; no item degrades between runs

Now the case that used to fail hardest — a page already in Chrome's cache:

1. Visit a product page normally, so it is cached.
2. Track it.
3. Press **CHECK NOW**.

- [ ] It reads the price rather than sitting for 20 seconds and failing

### Provenance: the fastest way to see what really happened

Settings → **DATA** → **EXPORT CSV**. The `history` column encodes each reading
as `timestamp:price:via:conf`.

- [ ] `via` is what you would expect — `shopify-json`, `jsonld`,
      `jsonld-variant`, `meta`, or `heuristic`
- [ ] Nothing was recorded at `conf` of `low`. Low confidence must never reach
      history; if it did, that is a bug.

## 5. Screens you cannot reach naturally

Some states need a page to misbehave, so use the harness instead. With
`node test/serve.js` running:

```
http://localhost:8731/test/harness.html?mode=guards
```

- [ ] `CAN'T VERIFY` (identity mismatch) and `CAN'T VERIFY` (unreadable price)
      both render, and each explains itself differently
- [ ] `CONFIRMING` says a second check will settle it
- [ ] The unreadable-price row does **not** claim a second check will help
- [ ] `CAN'T CHECK` offers **TRY AGAIN**, and clicking it clears the state

Other modes: `list`, `empty`, `noprice`, `soldout`, `lowconf`.

## 6. Notifications and the alarm

Settings → **CHECK EVERY** → 1 minute, so you are not waiting an hour.

- [ ] Chrome asks for notification permission, or the toast appears
- [ ] Set a target above an item's current price, wait for the next check, and
      a **TARGET HIT** toast arrives
- [ ] The toast's two buttons work — BUY opens the product, SNOOZE rests the row
- [ ] The toolbar badge shows the tracked count and turns amber when something
      needs attention

Then the part that has never been tested at all — the MV3 service worker dying:

1. On the extension card, click **service worker** and leave it 30+ seconds
   until Chrome marks it inactive, or click **terminate** if offered.
2. Wait for the next alarm.

- [ ] Checks resume on their own
- [ ] Nothing was lost from the list or from history

Put **CHECK EVERY** back to 1 hour when you are done.

## 7. Before you ever package for the store

There is a nested git repository at `price-tracker/.git`, about 300 KB. Chrome
ignores it when loading unpacked, but anything inside `price-tracker/` ends up
in the store zip.

- [ ] Confirm it is excluded from whatever you zip, or removed first

## What to report

For anything that fails, capture:

- the URL
- what the page showed
- what the popup showed
- the `via` and `conf` from the CSV export
- anything red in the service worker console

A wrong price is the most valuable bug you can find here, and the hardest to
notice later. A refusal is not a bug — that is the extension working.
