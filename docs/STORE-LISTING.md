# Chrome Web Store listing — copy and answers

Everything the submission form asks for. Paste each block into the matching
field. Nothing here is a placeholder.

---

## Name

```
Price Tracker
```

## Short description (132 char limit — this is 108)

```
Track prices on any product page and get told the moment they drop. No account, no server, nothing leaves your machine.
```

## Category

`Shopping`

## Language

`English (United States)`

---

## Detailed description

```
Price Tracker watches the price of things you want to buy and tells you when
they drop.

Open a product page, click Track, and set a target — or leave it empty and hear
about any drop at all. The extension checks on a schedule and sends a desktop
notification the moment your price is met.

WHAT IT DOES

• Reads the price straight off the product page
• Alerts on any drop, or only when it reaches your target
• Draws price history as a chart with your target line on it
• Watches sold-out items and tells you when they come back in stock
• Tracks size and colour where the store publishes them
• Snooze, pause, sort and filter your list
• Exports everything to CSV whenever you want it

BUILT NOT TO LIE TO YOU

A price tracker is only worth having if its history is correct, so this one
would rather say nothing than record a guess.

• It reads the store's own structured product data before ever guessing from
  the page layout
• On a category or search page it reports no price, instead of picking a
  random item off the shelf
• A price that jumps implausibly is held until a second check agrees
• If a store serves a different colour than the one you tracked, it says so
  instead of recording it as a price change
• When a site stops responding, the item tells you — it never just goes quiet

YOUR DATA STAYS YOURS

No account. No server. No analytics. No tracking.

Your list, your price history and your settings live in your own browser and
are never uploaded. The only requests the extension makes are to the product
pages you asked it to watch, sent without your cookies attached.

REQUIREMENTS

Chrome 110 or newer.

GOOD TO KNOW

Some large retailers block automated requests. When that happens the item says
so plainly rather than showing a stale price. Size can only be tracked when the
store publishes it.
```

---

## Single purpose

```
Price Tracker has one purpose: to monitor the price of product pages the user
has explicitly chosen, and notify them when the price changes in the way they
asked for.
```

---

## Permission justifications

Paste each into its box. Keep them literal — reviewers check the code against
the claim.

### `host_permissions` (`<all_urls>`)

```
Users track products from online stores, which exist on every domain. The
extension cannot know in advance which shops a user will want to watch, so it
cannot enumerate hosts ahead of time.

Access is only ever exercised on pages the user explicitly added to their list.
The extension does not read, collect or transmit anything from any other page,
and performs no background browsing.
```

### `scripting`

```
Reads the price from a product page the user is tracking. A small script runs
on the page and returns only the price, list price, currency, title, image URL,
availability and product identifiers. Nothing else is read and nothing is
modified on the page.
```

### `tabs`

```
Some stores render the price only after their own JavaScript runs, so a plain
network request returns no price. For those the extension opens the tracked
product page in a background tab, reads the price, and immediately closes the
tab. It is also used to read the URL of the current tab so the user can track
the product they are looking at.
```

### `storage`

```
Stores the user's tracked items, price history and settings locally. Nothing is
sent anywhere.
```

### `alarms`

```
Schedules the periodic price check at the interval the user selects.
```

### `notifications`

```
Sends a desktop notification when a tracked price meets the user's target,
when a price rises again, or when a sold-out item comes back in stock.
```

### `downloads`

```
Saves the user's CSV export to a file when they choose Export in settings. Used
for no other purpose.
```

---

## Data usage disclosures

Tick these on the form:

| Question | Answer |
|---|---|
| Does it collect personally identifiable information? | **No** |
| Health information? | **No** |
| Financial and payment information? | **No** |
| Authentication information? | **No** |
| Personal communications? | **No** |
| Location? | **No** |
| Web history? | **No** |
| User activity (clicks, mouse position, keystrokes)? | **No** |
| Website content (text, images)? | **No** — only the price fields of pages the user explicitly added |

Certifications, all three true:

- Not being sold to third parties, outside of the approved use cases — **yes**
- Not being used or transferred for purposes unrelated to the item's single purpose — **yes**
- Not being used or transferred to determine creditworthiness or for lending — **yes**

**Privacy policy URL:** point this at the hosted copy of `docs/PRIVACY.md`
(the raw file on the repository is acceptable).

---

## Screenshots

Five needed at **1280×800**. Take them from the loaded extension:

1. **The watchlist** — three or four items, one at target with its sparkline
2. **Confirm on track** — the `CHECK THESE DETAILS` block on a real product
3. **Item detail** — the price chart with the target line and breakpoints
4. **A drop notification** — the OS toast
5. **A guarded state** — a row showing `CAN'T VERIFY` or `CONFIRMING`

The popup is 340×560, so place it on a plain background rather than upscaling
it. Screenshot 5 is worth including: the honesty about failure is the product's
distinguishing feature.

---

## Before submitting

- [ ] Loaded unpacked and used for several days
- [ ] Tested on stores you actually shop
- [ ] Notification, badge and icon confirmed working in real Chrome
- [ ] `node test/run.js` passes
- [ ] Privacy policy hosted at a public URL
- [ ] Zip built from a clean checkout, not the working folder
- [ ] Developer account registered (one-time 5 USD fee)
