// Service worker: schedules re-checks, reads prices, sends notifications.
importScripts("compute.js", "store.js", "ldparse.js", "rules.js", "adapters.js");

const ALARM = "recheck";

// A reading that moves the price more than this needs a second look before it
// becomes history. A parse error reading $1,299 as $12.99 is indistinguishable
// from the deal of the century, and only one of them is real.
const SANITY_PCT = 60;
// The notification's snooze button applies screen 10's "30 DAYS" chip, and takes
// its label from the same entry so the two can never drift apart.
const NOTIF_SNOOZE = "30";

// Paper palette, repeated here because the service worker never loads the CSS.
const DROP = "#1F7A4D";
const WARN = "#A4661A";
const SURFACE = "#F7F5EF";

// --- lifecycle ---------------------------------------------------------------
async function schedule() {
  const { intervalMinutes } = await Store.getSettings();
  chrome.alarms.create(ALARM, { periodInMinutes: intervalMinutes });
}

async function boot() {
  await schedule();
  await applyIconTheme();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) checkAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "checkAll") {
    checkAll().then((r) => sendResponse({ ok: true, ...r }));
    return true; // keep the channel open for the async response
  }
  if (msg.type === "checkOne") {
    checkOne(msg.id).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.type === "reschedule") {
    chrome.alarms.create(ALARM, { periodInMinutes: msg.minutes || 60 });
    sendResponse({ ok: true });
  }
  // Read a URL without storing anything. The pasted-link flow uses this so a
  // link goes through the same look-before-you-track path as the button does.
  if (msg.type === "peek") {
    acquire(msg.url)
      .then((r) => sendResponse(r.ok
        ? { ok: true, reading: r.reading }
        : { ok: false, error: r.error || "could not read that page" }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || "could not read that page" }));
    return true;
  }
  if (msg.type === "nextCheck") {
    chrome.alarms.get(ALARM).then((a) =>
      sendResponse({ ok: true, scheduledTime: a ? a.scheduledTime : null }));
    return true;
  }
  // The popup builds the CSV but cannot reliably save it: a popup closes the
  // moment it loses focus, which cancels a download it started. The worker
  // outlives the popup, so it does the saving.
  if (msg.type === "export") {
    saveCsv(msg.csv, msg.filename).then(sendResponse);
    return true;
  }
  // The worker cannot read the toolbar theme; the popup can, so it tells us.
  if (msg.type === "themeHint") {
    applyIconTheme(msg.dark).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Popup edits (adding, pausing, retargeting, deleting) land in storage without
// passing through here, so the badge follows storage rather than the checker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.items) return;
  updateBadge(changes.items.newValue || []);
});

// --- price reading -----------------------------------------------------------
// The tab starts loading the moment it is created, which is before this
// listener can attach. A cached or fast page reaches "complete" inside that
// gap and the event fires into a void — so ask the tab where it got to as
// well as listening for where it goes next. Without the second half, every
// fast page waited out the full timeout and was recorded as a failure.
function waitForComplete(tabId, timeoutMs) {
  const budget = timeoutMs == null ? 20000 : timeoutMs;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer != null) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(false), budget);
    // Listener first, then the status read: in that order a load that lands
    // between the two is caught by the listener rather than missed by both.
    Promise.resolve(chrome.tabs.get(tabId)).then(
      (t) => { if (t && t.status === "complete") finish(true); },
      () => {}
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw HTML, no rendering. Cheap enough to try on every check.
async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", credentials: "omit" });
    if (!r.ok) return null;
    if (!/html/i.test(r.headers.get("content-type") || "")) return null;
    return await r.text();
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

// Open the page in a background tab, run the full extractor, close the tab.
// `ldparse.js` goes in first: the injected extractor reads it from the page's
// isolated world, and both scripts share that world across the two calls.
async function readViaTab(url, timeoutMs) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    // A page that never signals "complete" is still worth reading. Slow beacons
    // and hung trackers hold the load event open long after the price is on
    // screen, so a timeout downgrades the attempt rather than ending it — we
    // only fail once the extractor has actually looked and found nothing.
    const loaded = await waitForComplete(tab.id, timeoutMs);
    await sleep(1500); // let client-rendered prices settle

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["ldparse.js"] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ["inject-extract.js"]
    });
    const reading = res && res.result ? res.result : null;
    if (!reading || reading.price == null) {
      return { ok: false, error: loaded
        ? "no price found on the page"
        : "the page did not finish loading, and no price was readable" };
    }
    return { ok: true, reading, usedTab: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "could not open the page" };
  } finally {
    if (tab && tab.id != null) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
}

// Cheapest source that can answer confidently, escalating only when it cannot.
// A store's own JSON beats its markup; raw HTML beats rendering a whole page.
async function acquire(url) {
  const rule = await Rules.forUrl(url);

  if (rule.strategy === "shopify-json") {
    const s = await Adapters.fromShopify(url);
    if (s) return { ok: true, reading: withOrigin(s, url), usedTab: false };
  }

  // A stale `needsTab` gets one cheap probe before we pay for a tab again.
  if ((!rule.needsTab || Rules.shouldRetryCheapPath(rule)) && !rule.knownBlocker) {
    const html = await fetchHtml(url);
    if (html) {
      // Worth one probe: a Shopify store answers with variant-level data,
      // including sizes, which the markup never exposes.
      if (Adapters.looksShopify(html, url)) {
        // Probe the handle the store considers canonical: a link that redirects
        // (an old or shortened handle) would otherwise 404 the data endpoint.
        const canon = PTLd.canonicalFrom(html, url);
        const s = await Adapters.fromShopify(canon) ||
                  (canon !== url ? await Adapters.fromShopify(url) : null);
        if (s) return { ok: true, reading: withOrigin(s, url), usedTab: false };
      }
      const r = Rules.applyDistrust(rule, PTLd.fromHtml(html, url));
      // Anything short of high confidence means the price is probably built by
      // JavaScript we did not run, so pay for a tab rather than guess.
      if (r && r.conf === "high") return { ok: true, reading: withOrigin(r, url), usedTab: false };
    }
  }

  const t = await readViaTab(url);
  if (t.ok) Rules.applyDistrust(rule, t.reading);
  return t;
}

// Fill in the fields a DOM-free read cannot know for itself.
function withOrigin(reading, url) {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
  return Object.assign({ seller: host, canonical: url }, reading);
}

// --- checking ----------------------------------------------------------------
// Should this reading be believed straight away, or held for a second opinion?
// Held is not failed: the item stays healthy, it just writes no history and
// raises no alert until another check agrees with it.
function judge(item, reading) {
  const prev = item.lastPrice;
  const moved = prev != null && prev > 0 ? Math.abs(PT.pctChange(prev, reading.price) || 0) : 0;
  const confirmsPending = item.pendingPrice != null && item.pendingPrice === reading.price;

  // Low confidence means we could not tell which number on the page was the
  // price. A second look at the same page produces the same uncertainty, so
  // agreement proves nothing — a consistently wrong reading always agrees with
  // itself. That is exactly how $19.83 became the recorded price of a $79.95
  // jacket: the reading matched what we already had, so it was believed, and
  // what we already had came from the same weak source.
  //
  // So low confidence never establishes a price and never confirms one. It
  // parks the number where the row can show it and says plainly that we cannot
  // verify it. Only a stronger layer moves the item forward.
  if (reading.conf === "low") {
    return { hold: true, kind: "unverified",
             reason: "could not tell which number on the page is the price" };
  }

  if (moved > SANITY_PCT && !confirmsPending) {
    return { hold: true, kind: "confirming",
             reason: "price moved " + Math.round(moved) + "% — confirming before recording" };
  }
  if (reading.conf === "high" || confirmsPending) return { hold: false };
  if (reading.conf === "medium") {
    // A modest move read by a decent-but-not-certain layer is believable.
    if (prev != null && moved <= 20) return { hold: false };
    return { hold: true, kind: "confirming",
             reason: "read from a weaker source — confirming before recording" };
  }
  return { hold: true, kind: "unverified",
           reason: "could not tell which number on the page is the price" };
}

async function checkItem(item, settings) {
  const cfg = settings || (await Store.getSettings());
  fallbackCurrency = cfg.currency || "";
  const { ok, reading, error, usedTab } = await acquire(item.url);
  const now = Date.now();
  item.lastChecked = now;

  if (!ok) {
    item.failCount = (item.failCount || 0) + 1;
    item.lastError = error || "check failed";
    await Rules.recordFailure(item.url);
    return { changed: true, ok: false };
  }

  // Is this even the same thing the user confirmed? A retailer that serves a
  // different colour is not reporting a price change, and recording it as one
  // would quietly corrupt the history.
  const mismatch = Store.identityMismatch(item, reading);
  if (mismatch) {
    item.identityMismatch = mismatch.field + ' is "' + mismatch.found +
      '", you tracked "' + mismatch.expected + '"';
    item.lastOk = now;
    item.failCount = 0;
    return { changed: true, ok: true, rejected: "identity" };
  }
  item.identityMismatch = "";

  // Comparing across currencies would report a conversion as a price drop.
  if (item.currency && reading.currency && item.currency !== reading.currency) {
    item.suspect = "page is now priced in " + reading.currency;
    item.lastOk = now;
    item.failCount = 0;
    return { changed: true, ok: true, rejected: "currency" };
  }

  // A successful read clears any earlier failure streak.
  item.failCount = 0;
  item.lastError = "";
  item.lastOk = now;
  await Rules.recordSuccess(item.url, reading, usedTab);

  const verdict = judge(item, reading);
  if (verdict.hold) {
    item.pendingPrice = reading.price;
    if (!item.pendingSince) item.pendingSince = now;
    item.suspect = verdict.reason;
    // Whether a second check can resolve this, or whether the page itself is
    // the problem. The row says different things for the two, because
    // "confirming" on something that will never confirm is a quiet lie.
    item.pendingKind = verdict.kind || "confirming";
    return { changed: true, ok: true, held: true, kind: item.pendingKind };
  }
  item.pendingPrice = null;
  item.pendingSince = 0;
  item.pendingKind = "";
  item.suspect = "";

  const prevPrice = item.lastPrice;
  const prevStock = item.stock;
  item.lastPrice = reading.price;
  if (reading.list != null) item.list = reading.list;
  if (reading.currency && !item.currency) item.currency = reading.currency;
  if (reading.image && !item.image) item.image = reading.image;
  if (reading.stock) item.stock = reading.stock;
  if (reading.sku) item.sku = reading.sku;
  if (reading.color) item.color = reading.color;
  if (reading.size) item.size = reading.size;

  item.history = item.history || [];
  const last = item.history[item.history.length - 1];
  if (!last || last.price !== reading.price) {
    item.history.push(Store.historyPoint(reading, now));
  }
  item.history = PT.pruneHistory(item.history, cfg.retentionDays, 500);

  evaluateAlerts(item, prevPrice, cfg, prevStock);
  return { changed: true, ok: true };
}

// Decide whether this reading deserves a notification, and re-arm when the
// condition clears so the same item can alert again later.
function evaluateAlerts(item, prevPrice, cfg, prevStock) {
  // A sold-out item is watched for its return, not its price. Price history
  // keeps building quietly so the number is ready when it comes back.
  if (item.watch === "stock") {
    const wasGone = prevStock === "out" || prevStock === "";
    const isBack = item.stock === "in" || item.stock === "low";
    if (wasGone && isBack) {
      item.watch = "price";     // it is buyable again; resume normal watching
      item.notified = true;
      if (cfg.notifications && !inQuietHours(cfg)) notifyBackInStock(item);
    }
    return;
  }

  // "UNTIL IT DROPS" (screen 10). We cannot see a sale without looking, so this
  // is not a pause: checks carry on and history keeps building. What is held is
  // the alerting, until the price actually falls below what it was when the user
  // muted it — at which point the mute clears itself and the normal path runs.
  if (item.muteUntilBelow != null) {
    if (item.lastPrice < item.muteUntilBelow) {
      item.muteUntilBelow = null;
      item.snoozeKind = "";
    } else {
      item.notified = false;
      item.notifiedRise = false;
      return;
    }
  }

  // An item can hold a target and still ask to hear about every drop — that is
  // the NOTIFY ME control on the track-new screen. No target always means "any".
  const hasTarget = item.target != null;
  const onAny = !hasTarget || item.alertOn === "any";
  const met = onAny ? item.lastPrice < item.addedPrice : item.lastPrice <= item.target;

  if (met && !item.notified) {
    item.notified = true;
    if (cfg.notifications && !inQuietHours(cfg)) notifyDrop(item);
  } else if (!met && item.notified) {
    item.notified = false;
  }

  // The inverse alert: a deal we already flagged has ended.
  if (cfg.alertOnRise && prevPrice != null && item.lastPrice > prevPrice) {
    if (!item.notifiedRise) {
      item.notifiedRise = true;
      if (cfg.notifications && !inQuietHours(cfg)) notifyRise(item, prevPrice);
    }
  } else if (item.lastPrice <= prevPrice) {
    item.notifiedRise = false;
  }
}

function inQuietHours(cfg) {
  const q = cfg.quietHours;
  if (!q || q.start == null || q.end == null) return false;
  const h = new Date().getHours();
  // A window like 22->8 wraps past midnight.
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

async function checkAll() {
  const cfg = await Store.getSettings();
  const items = await Store.getItems();
  const due = items.filter(Store.isCheckable);
  let ok = 0, failed = 0;

  // Write after every item, not once at the end. A single throw part-way
  // through used to discard every reading the run had already earned, and a
  // long watchlist gives it plenty of chances to throw.
  for (const item of due) {
    try {
      const r = await checkItem(item, cfg);
      if (r.ok) ok++; else failed++;
    } catch (e) {
      failed++;
      item.lastChecked = Date.now();
      item.lastError = (e && e.message) || "the check could not be completed";
      item.failCount = (item.failCount || 0) + 1;
    }
    await Store.setItems(items);
  }
  await updateBadge(items);
  return { checked: due.length, ok, failed, skipped: items.length - due.length };
}

// One item on demand, from the popup. The reading has to be written back —
// checkItem only mutates the object it is handed.
async function checkOne(id) {
  const items = await Store.getItems();
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  await checkItem(item);
  await Store.setItems(items);
  await updateBadge(items);
  return true;
}

// --- export (screen 12, DATA) -------------------------------------------------
// A data: URL rather than a blob: URL — a blob URL belongs to the page that
// created it and dies with the popup, while a data: URL is the file itself.
// Service workers have no URL.createObjectURL either way.
async function saveCsv(csv, filename) {
  if (!chrome.downloads || !chrome.downloads.download) {
    return { ok: false, error: "this build has no downloads permission" };
  }
  try {
    const id = await chrome.downloads.download({
      url: "data:text/csv;charset=utf-8," + encodeURIComponent(String(csv || "")),
      filename: filename || "price-tracker.csv",
      saveAs: false
    });
    return id == null
      ? { ok: false, error: "the download did not start" }
      : { ok: true, id };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "the download was refused" };
  }
}

// --- toolbar badge (screen 13) -----------------------------------------------
// Green count = that many items sitting at or below their target. Amber "!" =
// something needs a look (out of stock, or a site that has refused us three
// times and is no longer being checked). Nothing new, no badge.
async function updateBadge(known) {
  if (!chrome.action) return null;
  const items = known || (await Store.getItems());
  const c = PT.counts(items);

  // The badge counts what you are tracking, so adding an item always moves it.
  // Colour carries the state: green normally, amber when something needs
  // looking at (a site that stopped responding, or an item gone out of stock).
  const text = c.tracked > 0 ? String(c.tracked) : "";
  const color = c.attention > 0 ? WARN : DROP;

  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color });
    // Chrome 110+. Without it the badge text is white anyway, which still
    // reads on both fills — so a missing API is not worth failing over.
    if (chrome.action.setBadgeTextColor) {
      try { await chrome.action.setBadgeTextColor({ color: SURFACE }); } catch (e) {}
    }
  }
  return { text, color: text ? color : null };
}

// --- icon (screen 14) ---------------------------------------------------------
const ICONS = {
  light: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png" },
  dark: { 16: "icons/icon16-dark.png", 32: "icons/icon32-dark.png", 48: "icons/icon48-dark.png" }
};

// `dark` comes from the popup's matchMedia; it is remembered so the icon is
// right on the next boot, before any popup has opened.
async function applyIconTheme(dark) {
  if (!chrome.action || !chrome.action.setIcon) return;
  if (dark != null) await chrome.storage.local.set({ toolbarDark: !!dark });
  const { toolbarDark } = await chrome.storage.local.get("toolbarDark");
  try {
    await chrome.action.setIcon({ path: toolbarDark ? ICONS.dark : ICONS.light });
  } catch (e) { /* icon files missing — keep the manifest default */ }
}

// --- notifications (screens 05, 06) -------------------------------------------
// The spec draws a 380px toast with three buttons and a stat table.
// `chrome.notifications` renders an OS template: no layout control, and two
// buttons at most. So the stat row is folded into the message, the footer line
// into contextMessage, and the third button (HISTORY / FIND CHEAPER) is dropped
// — the body itself clicks through to the product, which is what it did.

const SYMBOLS = { USD: "$", CAD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };

// Settings' CURRENCY is the fallback for pages that print a number and never
// say which currency it is. Refreshed on every check so it stays current.
let fallbackCurrency = "";

function sym(code) {
  return SYMBOLS[(code || fallbackCurrency || "").toUpperCase()] || "";
}

function fmtNum(n) {
  if (n == null || !isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function money(item, n) {
  return sym(item && item.currency) + fmtNum(n);
}

// Whole percents here — a toast is not the place for a decimal.
function pctText(pct) {
  if (pct == null) return "";
  const r = Math.round(Math.abs(pct));
  return (pct < 0 ? "▼" : pct > 0 ? "▲" : "") + r + "%";
}

const STOCK_WORDS = { in: "IN STOCK", low: "LOW STOCK", out: "OUT OF STOCK" };

function humanSpan(ms) {
  const h = ms / 3600000;
  // Under three quarters of an hour there is no span worth claiming — an item
  // added minutes ago has not had a deal that "lasted" anything.
  if (!(h >= 0.75)) return null;
  if (h < 20) {
    const n = Math.round(h);
    return n + (n === 1 ? " HOUR" : " HOURS");
  }
  const d = Math.round(h / 24);
  if (d <= 1) return "A DAY";
  if (d < 14) return d + " DAYS";
  const w = Math.round(d / 7);
  return w < 9 ? w + " WEEKS" : Math.round(d / 30) + " MONTHS";
}

function seenAgo(t) {
  if (!t) return null;
  const m = Math.round(Math.max(0, Date.now() - t) / 60000);
  if (m < 2) return "SEEN JUST NOW";
  if (m < 60) return "SEEN " + m + " MIN AGO";
  const h = Math.round(m / 60);
  return h < 24 ? "SEEN " + h + "H AGO" : "SEEN " + Math.round(h / 24) + "D AGO";
}

// `ALLBIRDS.COM ● IN STOCK        SEEN 2 MIN AGO` from screen 05.
function footerLine(item) {
  const bits = [];
  if (item.seller) bits.push(item.seller.toUpperCase());
  if (STOCK_WORDS[item.stock]) bits.push(STOCK_WORDS[item.stock]);
  const seen = seenAgo(item.lastChecked);
  if (seen) bits.push(seen);
  return bits.join(" · ");
}

// The `SAVES YOU / VS 90-DAY AVG / HISTORY` row. Each column only appears when
// the history can actually support it — a one-point history makes every price
// the "lowest ever", which would be a lie dressed up as a stat.
function dropStats(item) {
  const out = [];
  const saves = PT.savingsVsList(item);
  if (saves != null && saves > 0) out.push("SAVES YOU " + money(item, saves));

  if ((item.history || []).length >= 2) {
    const avg = PT.averageOver(item, 90);
    const vs = avg != null ? PT.pctChange(avg, item.lastPrice) : null;
    if (vs != null && Math.abs(vs) >= 1) {
      out.push(Math.round(Math.abs(vs)) + "% " + (vs < 0 ? "BELOW" : "ABOVE") + " 90-DAY AVG");
    }
    const low = PT.allTimeLow(item);
    if (low && item.lastPrice <= low.price) out.push("LOWEST EVER");
  }
  return out;
}

// Only a URL the browser can actually fetch. A broken imageUrl makes Chrome
// drop the whole notification, so anything doubtful falls back to `basic`.
function usableImage(url) {
  return typeof url === "string" && url.length < 2000 && /^https?:\/\/\S+$/i.test(url);
}

// Try the rich template, fall back to the plain one if the image will not load.
function createNotification(id, opts, image) {
  const rich = image
    ? Object.assign({}, opts, { type: "image", imageUrl: image })
    : null;
  const plain = Object.assign({}, opts, { type: "basic" });

  if (!rich) {
    chrome.notifications.create(id, plain, () => void chrome.runtime.lastError);
    return;
  }
  chrome.notifications.create(id, rich, (created) => {
    if (chrome.runtime.lastError || !created) {
      chrome.notifications.create(id, plain, () => void chrome.runtime.lastError);
    }
  });
}

function notifyDrop(item) {
  // "was" and the percent measure against the same number, so the arithmetic on
  // the line holds up: the merchant's list price when we have one, otherwise
  // what it cost when tracking began.
  const start = PT.startPrice(item);
  const pct = PT.pctChange(start, item.lastPrice);
  const head = [money(item, item.lastPrice)];
  if (start != null && start > item.lastPrice) head.push("was " + money(item, start));
  if (pct) head.push(pctText(pct));
  head.push(item.target != null ? "TGT " + money(item, item.target) : "ANY DROP");

  const message = [item.title, head.join("  "), dropStats(item).join(" · ")]
    .filter(Boolean).join("\n");

  createNotification(item.id, {
    iconUrl: "icons/icon128.png",
    title: (item.target != null ? "TARGET HIT" : "PRICE DROPPED") +
      " · " + money(item, item.lastPrice),
    message,
    contextMessage: footerLine(item),
    priority: 2,
    requireInteraction: true, // a price alert should wait to be read
    buttons: [
      { title: "BUY AT " + money(item, item.lastPrice) },
      { title: "SNOOZE " + Store.SNOOZE[NOTIF_SNOOZE].label }
    ]
  }, usableImage(item.image) ? item.image : null);
}

function notifyBackInStock(item) {
  const head = [money(item, item.lastPrice)];
  const start = PT.startPrice(item);
  if (start != null && start > item.lastPrice) head.push("was " + money(item, start));
  if (item.size) head.push("SIZE " + item.size);

  createNotification(item.id, {
    iconUrl: "icons/icon128.png",
    title: "BACK IN STOCK · " + money(item, item.lastPrice),
    message: [item.title, head.join("  ")].filter(Boolean).join("\n"),
    contextMessage: footerLine(item),
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: "BUY AT " + money(item, item.lastPrice) },
              { title: "SNOOZE " + Store.SNOOZE[NOTIF_SNOOZE].label }]
  }, usableImage(item.image) ? item.image : null);
}

function notifyRise(item, prevPrice) {
  const pct = PT.pctChange(prevPrice, item.lastPrice);
  const head = [money(item, item.lastPrice), "was " + money(item, prevPrice)];
  if (pct) head.push(pctText(pct));
  if (item.target != null) head.push("TGT " + money(item, item.target));

  // Screen 06 promises history the spec cannot know ("drops again in ~3 weeks").
  // These are the parts the stored history really does answer.
  const facts = [];
  const lasted = humanSpan(PT.dealDuration(item));
  if (lasted) facts.push("DEAL LASTED " + lasted);
  const cutoff = Date.now() - 90 * PT.DAY;
  const drops = PT.breakpoints(item).filter((b) => b.pct < 0 && b.t >= cutoff).length;
  if (drops >= 2) facts.push(drops + " DROPS IN 90 DAYS");
  const low = PT.allTimeLow(item);
  if (low && low.price < item.lastPrice) facts.push("LOW " + money(item, low.price));

  const message = [item.title, head.join("  "), facts.join(" · ")]
    .filter(Boolean).join("\n");

  createNotification(item.id + "_rise", {
    iconUrl: "icons/icon128.png",
    title: "PRICE WENT UP · " + money(item, item.lastPrice),
    message,
    contextMessage: footerLine(item),
    priority: 1,
    buttons: [{ title: "KEEP TRACKING" },
              { title: "MUTE " + Store.SNOOZE[NOTIF_SNOOZE].label }]
  }, usableImage(item.image) ? item.image : null);
}

// Click the body to open the product page.
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const item = await itemForNotification(id);
  if (item) chrome.tabs.create({ url: item.url });
});

// Slot 0 is the affirmative action (BUY / KEEP TRACKING), slot 1 always steps
// the item back (SNOOZE / MUTE), so the same handler serves both toasts.
chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  chrome.notifications.clear(id);
  const item = await itemForNotification(id);
  if (!item) return;

  if (index === 1) {
    await Store.updateItem(item.id, {
      snoozeUntil: Date.now() + Store.SNOOZE[NOTIF_SNOOZE].ms,
      snoozeKind: NOTIF_SNOOZE,
      notified: false,
      notifiedRise: false
    });
    await updateBadge();
    return;
  }
  // KEEP TRACKING is a dismissal — the notification is already cleared.
  if (!/_rise$/.test(id)) chrome.tabs.create({ url: item.url });
});

async function itemForNotification(id) {
  const items = await Store.getItems();
  return items.find((i) => i.id === id.replace(/_rise$/, "")) || null;
}
