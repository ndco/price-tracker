# Price Tracker — Paper theme, 14 screens

Transcribed from the Claude Design "Final spec — Paper theme, 14 screens".
This is the authoritative visual reference. Follow it unless a platform limit
makes it impossible (those are listed at the bottom).

## Tokens

| Token | Hex | Use |
|---|---|---|
| SURFACE | `#F7F5EF` | popup ground (off-white paper) |
| PANEL | `#EFECE3` | header / footer / sub-panel bands |
| INK | `#1C1E1B` | text, primary dark button |
| DROP | `#1F7A4D` | forest green — price fell, at target, primary CTA |
| WARN | `#A4661A` | amber — needs attention, out of stock, low stock |
| RISE | `#B4441F` | rust red — price went up, destructive actions |

- Typeface: **JetBrains Mono** everywhere (bundle as woff2, OFL licensed).
- Popup width **340px**. Toast width **380px**.
- Single theme only. No dark mode — all other palettes were deliberately removed.
- Labels/eyebrows are UPPERCASE with letter-spacing. Prices are large and heavy.
- Numbers use `font-variant-numeric: tabular-nums`.

## Core rule — target price is optional

- **With a target:** the row gains a progress bar and a distance-to-target chip
  (`+28 TO TGT`).
- **Without a target:** the row shows `ANY DROP` and offers a `+ SET TARGET`
  inline button.

Derived-value semantics (already implemented in `compute.js`, verified against
the spec's own numbers):
- Row delta % = **change since tracking began** (`deltas().vsStart`).
- Struck-through number = merchant **list price** (`item.list`).
- Progress bar = from `startPrice` (list, else addedPrice) down to `target`.

---

## 01 — Popup home (340px)

```
PRICE·TRK                        [ CHECK NOW ]
1 at target / 3 tracked              -$126 today
─────────────────────────────────────────────
▸ THIS PAGE
Barbour Bedale Waxed Jacket
289  340  -15%                    [ TRACK ↵ ]
─────────────────────────────────────────────
ALLBIRDS WOOL RUNNER                     [HIT]
55  110                                 ▼50.0%
<sparkline with dashed target line + tinted zone below>
30D          TGT 60 · 2M AGO         MORE ▸
─────────────────────────────────────────────
SONY WH-1000XM5                   [+28 TO TGT]
328  399                                 ▼6.0%
<sparkline, line stays above the dashed target>
30D          TGT 300 · 2M AGO        MORE ▸
─────────────────────────────────────────────
BARBOUR BEDALE JACKET                    [NEW]
289
••• AWAITING FIRST CHECK
                                     MORE ▸
─────────────────────────────────────────────
INTERVAL [1H ▾]                   NEXT 00:48
```

- `HIT` badge = solid green. `+28 TO TGT` chip = amber outline. `NEW` = muted.
- Header sub-line: at-target count in green, total tracked muted, today's
  currency change on the right (green when negative/falling).
- `MORE ▸` opens the item detail screen (04) in the same shell.

## 02 — Track new item (target optional)

```
← TRACK THIS ITEM
─────────────────────────────────────────────
[IMG]  Barbour Bedale Waxed Jacket
       $289  $340              BARBOUR.COM
─────────────────────────────────────────────
TARGET PRICE                          OPTIONAL
┌───────────────────────────────────────────┐
│ $  Any drop                           USD │
└───────────────────────────────────────────┘
[ -10% · 260 ] [ -20% · 231 ] [ MATCH LOW · 249 ]

Leave empty and we'll alert you on any drop. You
can add a target later.

NOTIFY ME                      [ ON ANY DROP ▾ ]
CHECK EVERY                              [1H ▾]
ALSO WATCH                    SIZE 10 · GREY ▾
─────────────────────────────────────────────
[ TRACK ANY DROP ]                   [ CANCEL ]
```

- The big input's placeholder is literally `Any drop`.
- Quick-fill chips compute from the current price: -10%, -20%, and `MATCH LOW`
  (the item's all-time low).
- Primary button label follows state: `TRACK ANY DROP` with no target, else
  `TRACK AT <price>`.
- **`ALSO WATCH` (variant picker) is deferred** — variant extraction is
  site-specific and unproven. Omit the row rather than faking it.

## 03 — Row states: target vs no target

With a target:
```
SONY WH-1000XM5                   [+28 TO TGT]
328  399                                 ▼6.0%
████████████████████░░░░░░░░  (progress bar)
TARGET 300 · 72% THERE                MORE ▸
```
Without a target:
```
BARBOUR BEDALE JACKET               ANY DROP
289  340                                ▼15.0%
[ + SET TARGET ]                      MORE ▸
```
`+ SET TARGET` is a dashed-outline button that opens inline target entry.

## 04 — Item detail & history

```
← ALLBIRDS WOOL RUNNER                   [HIT]
─────────────────────────────────────────────
55  110                        ▼50.0% ALL-TIME

<large chart: line with circular breakpoint dots,
 dashed target line, tinted zone below target,
 emphasised endpoint dot. Dots are clickable.>
APR 02          TARGET 60            JUL 11
┌───────────────────────────────────────────┐
│ Jul 11  55                          -24%  │
│ Clearance — below your target             │
└───────────────────────────────────────────┘
FIRST TRACKED        │ ALL-TIME LOW
110  APR 02          │ 55  TODAY
90-DAY AVG           │ CHECKS
89                   │ 4 / 128
─────────────────────────────────────────────
TARGET                          60   [ EDIT ]
ALERT ON                    [ ANY DROP ▾ ]
SELLER / STOCK      ALLBIRDS.COM · IN STOCK
─────────────────────────────────────────────
BREAKPOINTS
JUL 11   55   -24%                  CLEARANCE
JUN 24   72    -9%                    RESTOCK
JUN 07   79   -17%                       SALE
MAY 19   95   -14%                   MARKDOWN
─────────────────────────────────────────────
[ OPEN PRODUCT ↗ ]                  [ PAUSE ]
```

- Clicking a breakpoint dot fills the callout box above the stats.
- Breakpoint labels: use `compute.js` `labelFor()` (BIG DROP / DROP / DIP /
  PRICE UP / SHARP RISE). Do **not** invent merchandising reasons like
  "CLEARANCE" — we cannot observe those.

## 05 — Target-hit notification (380px toast)

```
TARGET HIT                  PRICE·TRK · NOW  ✕
[PRODUCT IMAGE]  Allbirds Wool Runner — Natural Grey
                 $55  $110  ▼50%         TGT $60
SAVES YOU  │ VS 90-DAY AVG │ HISTORY
$55        │ -38%          │ LOWEST EVER
ALLBIRDS.COM ● IN STOCK        SEEN 2 MIN AGO
[ BUY AT $55 ↗ ]  [ HISTORY ]  [ SNOOZE ]
```
Green header band.

## 06 — Price rose (380px toast)

```
PRICE WENT UP             PRICE·TRK · 6M AGO ✕
[PRODUCT IMAGE]  Sony WH-1000XM5 — Black
                 $369  $328  ▲12%      TGT $300
Deal ended after 4 days. This model has risen
after every sale in the last 90 days —
historically it drops again in ~3 weeks.
[ KEEP TRACKING ]  [ FIND CHEAPER ↗ ]  [ MUTE ]
```
Rust-red header band. `KEEP TRACKING` is the dark ink button.

## 07 — Sort & filter (appears past ~8 items)

```
PRICE·TRK                           24 TRACKED
⌕ Filter by name or site
[BIGGEST DROP] [NEAR TARGET] [NEWEST] [A–Z]
(AT TARGET 3 ✕) (IN STOCK) (SNOOZED 2)
─────────────────────────────────────────────
HARIO V60 KETTLE          62            ▼31%
PATAGONIA NANO PUFF      148            ▼26%
SONY WH-1000XM5          328             ▼6%
─────────────────────────────────────────────
SHOWING 4 OF 24 · SEE ALL ▸
```
Active sort chip = solid green. Filter chips = outline, removable with ✕.

## 08 — First run / empty

```
PRICE·TRK                            0 TRACKED

        <small sparkline illustration>

           Nothing tracked yet.
  Open any product page and hit Track. We check
  the price hourly and tell you the moment it drops.

            [ TRY A DEMO ITEM ]
─────────────────────────────────────────────
WORKS ON
[AMAZON] [BEST BUY] [ALLBIRDS] [+ 2,400 SITES]
```
**Copy correction:** `+ 2,400 SITES` is a marketing claim we cannot support.
Use honest copy, e.g. `ANY SITE WITH PRICE DATA`.

## 09 — No price on this page

```
PRICE·TRK                            3 TRACKED
⚠ NO PRICE FOUND
This looks like a category page, not a product.
Open a single item, or paste its link below.
[ Paste product URL             ] [ ADD ]
─────────────────────────────────────────────
MEANWHILE, ON YOUR LIST
ALLBIRDS WOOL RUNNER      55            ▼50%
─────────────────────────────────────────────
SITE NOT SUPPORTED?              REQUEST IT ▸
```
**`REQUEST IT` needs a backend — omit it or make it a mailto/no-op.**

## 10 — Snooze / pause a row

```
PATAGONIA NANO PUFF                  [SNOOZED]
148  199              RESUMES IN 26 DAYS
[ RESUME NOW ]                     [ DELETE ]
HISTORY IS KEPT WHILE SNOOZED — CHECKS JUST PAUSE.
─────────────────────────────────────────────
SNOOZE FOR
[ 7 DAYS ]  [ 30 DAYS ]  [ UNTIL SALE ]
```
Snoozed rows render muted/greyed. `DELETE` is rust red. Active duration = green.

## 11 — Cheaper elsewhere — **DEFERRED**

Requires cross-retailer product matching (a shopping API or backend). Not
buildable from page scraping. Do not implement; do not stub fake sellers.

## 12 — Settings

```
← SETTINGS
ALERTS
DESKTOP NOTIFICATIONS                    [on]
EMAIL DIGEST                       [ WEEKLY ▾ ]
QUIET HOURS                    22:00 – 08:00 ▾
ALERT ON PRICE RISE                     [off]
─────────────────────────────────────────────
TRACKING
DEFAULT INTERVAL                        [1H ▾]
CURRENCY                             [USD $ ▾]
KEEP HISTORY                        2 YEARS ▾
AUTO-STOP AFTER PURCHASE                 [on]
─────────────────────────────────────────────
DATA
[ EXPORT CSV ]  [ IMPORT ]  [ CLEAR ALL ]
─────────────────────────────────────────────
V2.4.0                            PRIVACY ▸
```
**`EMAIL DIGEST` needs a server — omit the row** (do not ship a dead control).
Version string should reflect `manifest.json`, not a hardcoded 2.4.0.

## 13 — Toolbar badge

- Green badge with a count = that many items at target.
- Amber badge = something needs attention (a tracked item went out of stock, or
  a site has failed 3 times and checking stopped).
- No badge = nothing new.

## 14 — Icon: solid tag

A filled tag shape in DROP green, single solid form, legible at 16px, with a
variant that reads on a dark toolbar. Sizes 16 / 48 / 128.

---

## Platform limits — adapt, don't fake

1. **Toasts 05/06 cannot be rendered as drawn.** `chrome.notifications` uses a
   fixed OS template and allows **at most two buttons**. Use the richest
   available template, fold the stat line into `message`, keep two buttons, and
   make the body click through to the product.
2. **Cheaper elsewhere (11)** — deferred, needs external data.
3. **Email digest** — deferred, needs a backend.
4. **`ALSO WATCH` variants** — deferred, site-specific.
5. **Stock, image, seller** only exist when the page publishes them. Degrade
   gracefully; never render an empty box where an image would be.
