# Privacy Policy — Price Tracker

**Last updated:** 13 August 2026
**Applies to:** Price Tracker Chrome extension, version 1.0.0

## The short version

Price Tracker has no account, no server and no analytics. Everything it knows
about you stays in your own browser. Nothing is sent to the developer, and
nothing is sold or shared with anyone.

## What is stored, and where

All data lives in `chrome.storage.local` on your own computer. It is never
uploaded. Uninstalling the extension deletes it.

| Stored | Why |
|---|---|
| Product URLs you chose to track | To re-check the price |
| Title, image URL, price, list price, currency, stock, SKU, colour, size | To show the item and detect when the page changes |
| Price history (timestamp, price, and which method read it) | To draw the chart and compute changes |
| Your target price and alert preferences | To decide when to notify you |
| Per-site notes about which reading method worked | To read that site more reliably next time |
| Your settings (check interval, currency, quiet hours, retention) | To behave the way you asked |

## What leaves your computer

Exactly one kind of request: **the extension fetches the product pages you
asked it to track**, in order to read the current price.

- Requests go only to the sites whose product pages you added
- They are sent with `credentials: "omit"`, so your cookies and login session
  are not attached
- Some checks open the page in a background browser tab instead, when the price
  is only visible after the page's own scripts run
- For Shopify stores, the extension may request that store's public product
  data endpoint (the product URL with `.json` appended)

No request is ever made to the developer or to any third-party service. There
is no telemetry, no crash reporting, no advertising identifier, and no tracking
of your browsing.

## What is never collected

- Browsing history, or any page you did not explicitly add
- Passwords, payment details, addresses, or anything you type into a website
- Personal identifiers of any kind
- Content of pages other than the price, title, image URL, availability, and
  product identifiers on the product pages you track

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Keeps your list, history and settings on your machine |
| `alarms` | Schedules the periodic price check |
| `notifications` | Tells you when a price hits your target or an item returns to stock |
| `scripting` | Reads the price from a product page you are tracking |
| `tabs` | Opens a product page in a background tab when its price is only rendered by JavaScript, then closes it |
| `downloads` | Saves your CSV export when you ask for one |
| `<all_urls>` | Online stores live on every domain, so the extension cannot know in advance which sites you will want to track. Access is only ever used on pages you explicitly add. |

## Your data, your call

- **Export** — Settings → `EXPORT CSV` writes everything to a file you keep
- **Delete one item** — the `✕` on any row
- **Delete everything** — Settings → `CLEAR ALL`
- **Delete everything, permanently** — uninstall the extension

## Children

Price Tracker is not directed at children and collects no personal information
from anyone.

## Changes

If this policy changes, the date at the top changes with it, and the new version
ships with the extension update that introduces the change.

## Contact

Questions about this policy can be raised as an issue on the project's
repository.
