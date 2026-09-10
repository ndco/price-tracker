// Storage access and schema migration. Shared by the popup and the service
// worker, so it attaches to globalThis instead of using module syntax.
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 2;
  const MAX_FAILS = 3; // stop checking a site that keeps refusing us
  const DAY = 86400000;

  // Screen 10's three durations. "drop" is not a duration at all — see the note
  // on `muteUntilBelow` in normalizeItem — so its `ms` is zero and the label
  // says what it really does.
  const SNOOZE = {
    "7": { ms: 7 * DAY, label: "7 DAYS" },
    "30": { ms: 30 * DAY, label: "30 DAYS" },
    drop: { ms: 0, label: "UNTIL IT DROPS" }
  };

  const DEFAULT_SETTINGS = {
    intervalMinutes: 60,
    showSparklines: true,
    notifications: true,
    alertOnRise: false,
    quietHours: null, // { start: 22, end: 8 }
    currency: "USD", // fallback symbol when a page doesn't say
    retentionDays: 730, // "2 years" in the settings screen
    // Screen 07's bar remembers where you left it.
    listSort: "newest",
    listFilters: []
  };

  async function getSettings() {
    const { settings = {} } = await chrome.storage.local.get("settings");
    return Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async function setSettings(patch) {
    const next = Object.assign({}, await getSettings(), patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  // Fill in every field a v2 item is expected to have. Safe to run repeatedly.
  function normalizeItem(raw) {
    const it = Object.assign({}, raw);

    it.id = it.id || newId();
    it.title = it.title || it.url || "Untitled";
    it.currency = it.currency || "";
    it.canonical = it.canonical || it.url || "";
    it.image = it.image || "";
    it.seller = it.seller || sellerFromUrl(it.url);
    // Recomputed every time: it is derived, so a changed rule fixes old items.
    it.key = productKey(it.url);

    it.addedPrice = num(it.addedPrice, num(it.lastPrice, 0));
    it.lastPrice = num(it.lastPrice, it.addedPrice);
    it.list = it.list != null ? num(it.list, null) : null;

    // v1 always stored a target. v2 allows null, meaning "alert on any drop".
    it.target = it.target === null || it.target === undefined ? null : num(it.target, null);

    // "target" fires only at the target price; "any" fires on any drop below
    // the starting price even when a target exists. Defaults to whatever the
    // item's shape already implied, so migrated items behave as before.
    it.alertOn = it.alertOn === "any" || it.alertOn === "target"
      ? it.alertOn
      : it.target == null ? "any" : "target";

    it.history = Array.isArray(it.history) && it.history.length
      ? it.history.filter((h) => h && isFinite(h.price) && isFinite(h.t))
      : [{ t: it.lastChecked || Date.now(), price: it.lastPrice }];

    it.createdAt = it.createdAt || (it.history[0] && it.history[0].t) || Date.now();
    it.lastChecked = it.lastChecked || it.createdAt;
    it.lastOk = it.lastOk || (it.failCount ? it.lastOk || 0 : it.lastChecked);

    it.stock = it.stock || "";

    // "price" watches the number; "stock" waits for a sold-out item to come
    // back and stays quiet about price until it does. Tracking a price on
    // something you cannot buy is noise.
    it.watch = it.watch === "stock" ? "stock" : "price";

    // What the page last told us this item is.
    it.sku = str(it.sku);
    it.color = str(it.color);
    it.size = str(it.size);

    // The identity the user confirmed when they added it. Re-checks compare
    // against this, so a site that quietly serves a different colour is caught
    // instead of being recorded as a price change.
    it.fpSku = str(it.fpSku);
    it.fpColor = str(it.fpColor);
    it.fpSize = str(it.fpSize);
    it.confirmed = !!it.confirmed;
    it.confirmedAt = num(it.confirmedAt, 0);
    it.identityMismatch = str(it.identityMismatch);

    // A reading held back for confirmation: either an implausible jump or a
    // low-confidence read. It is not history until a second check agrees.
    it.pendingPrice = it.pendingPrice == null ? null : num(it.pendingPrice, null);
    it.pendingSince = num(it.pendingSince, 0);
    // "confirming" — a second check can settle this. "unverified" — the page
    // never told us which number is the price, so waiting will not help.
    it.pendingKind = it.pendingKind === "unverified" ? "unverified"
      : it.pendingPrice != null ? "confirming" : "";
    it.suspect = str(it.suspect);

    it.paused = !!it.paused;
    it.snoozeUntil = it.snoozeUntil || 0;
    // Which chip on screen 10 put it to sleep, so the right one lights up when
    // the panel reopens. Inferring it from the remaining time would be wrong —
    // a 30-day snooze with 3 days left is still a 30-day snooze.
    it.snoozeKind = SNOOZE[it.snoozeKind] ? it.snoozeKind : "";
    // "UNTIL IT DROPS": a price, not a date. Checks carry on and history keeps
    // building; alerts are held until the price falls below this number, and
    // then the mute clears itself. We cannot see a sale without checking, so
    // this is the honest version of the spec's "until sale".
    it.muteUntilBelow = it.muteUntilBelow == null ? null : num(it.muteUntilBelow, null);
    it.failCount = num(it.failCount, 0);
    it.lastError = it.lastError || "";

    it.notified = !!it.notified;
    it.notifiedRise = !!it.notifiedRise;

    it.schemaVersion = SCHEMA_VERSION;
    return it;
  }

  function newId() {
    return "it_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  }

  function num(v, fallback) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function str(v) {
    return v == null ? "" : String(v).trim();
  }

  // A history point records not just the price but where it came from, so a
  // reading produced by a weak layer can be found and discarded later without
  // throwing away the whole series. Points written before this existed have no
  // `via` and are read as "legacy".
  function historyPoint(reading, t) {
    const p = { t: t || Date.now(), price: reading.price };
    if (reading.via) p.via = reading.via;
    if (reading.conf) p.conf = reading.conf;
    if (reading.raw) p.raw = String(reading.raw).slice(0, 24);
    if (reading.currency) p.cur = reading.currency;
    return p;
  }

  function sellerFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  // Ad and analytics parameters. They change every time a link is shared or
  // clicked through an ad, so two visits to the same product would otherwise
  // look like two different products.
  const TRACKING_EXACT = new Set([
    "gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "ttclid", "twclid",
    "igshid", "yclid", "epik", "srsltid", "s_kwcid", "cjevent", "irclickid",
    "ranmid", "raneaid", "ransiteid", "affid", "aff_id", "subid", "clickid",
    "ref", "referrer", "campaign", "cmpid", "mkwid", "pcrid",
    "gad_source", "gad_campaignid", "gclsrc", "cid", "mc_cid", "mc_eid"
  ]);
  const TRACKING_PREFIX = ["utm_", "_hs", "pk_", "hsa_", "oly_", "vero_"];

  function isTracking(name) {
    const k = name.toLowerCase();
    if (TRACKING_EXACT.has(k)) return true;
    return TRACKING_PREFIX.some((p) => k.startsWith(p));
  }

  // A stable identity for one buyable thing. Two links to the same product in
  // the same colour collapse to one key even when their ad parameters differ;
  // two colours of the same style stay apart, because on Zappos (and most
  // retailers) the colour sits in the path and carries its own price.
  function productKey(url) {
    if (!url) return "";
    let u;
    try { u = new URL(url); } catch (e) { return String(url); }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");

    const kept = [];
    u.searchParams.forEach((v, k) => { if (!isTracking(k)) kept.push([k.toLowerCase(), v]); });
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const query = kept.map(([k, v]) => k + "=" + v).join("&");

    return host + path + (query ? "?" + query : "");
  }

  // Same product, as far as we can tell.
  function sameProduct(a, b) {
    if (!a || !b) return false;
    return productKey(a) === productKey(b);
  }

  async function getItems() {
    const { items = [] } = await chrome.storage.local.get("items");
    let changed = false;
    const migrated = items.map((raw) => {
      if (raw && raw.schemaVersion === SCHEMA_VERSION) return raw;
      changed = true;
      return normalizeItem(raw);
    });
    // Persist the migration once so later reads are cheap.
    if (changed) await chrome.storage.local.set({ items: migrated });
    return migrated;
  }

  async function setItems(items) {
    await chrome.storage.local.set({ items });
  }

  // Reading the whole list, changing one entry and writing the whole list back
  // is only safe if nobody else does it at the same time. Three checks now run
  // at once, so they queue behind each other here.
  //
  // This cannot help across contexts — the popup is a separate page with its
  // own copy of this file, and `chrome.storage` has no transaction. What it
  // does is shrink the window from "the whole run" to "one write", and
  // `commitCheck` below closes the rest.
  let writeQueue = Promise.resolve();

  function serialized(work) {
    const next = writeQueue.then(work, work);
    writeQueue = next.then(noop, noop);
    return next;
  }

  function noop() {}

  async function updateItem(id, patch) {
    return serialized(async () => {
      const items = await getItems();
      const it = items.find((i) => i.id === id);
      if (!it) return null;
      Object.assign(it, typeof patch === "function" ? patch(it) : patch);
      await setItems(items);
      return it;
    });
  }

  async function removeItem(id) {
    return serialized(async () => {
      const items = (await getItems()).filter((i) => i.id !== id);
      await setItems(items);
      return items;
    });
  }

  // What a check is allowed to write. Everything else on an item belongs to
  // the person using it — the target, the title, whether it is paused — and a
  // check that has been running for half a minute must not put back the values
  // it read when it started.
  const CHECK_FIELDS = [
    "lastChecked", "lastOk", "lastError", "failCount",
    "identityMismatch", "suspect", "pendingPrice", "pendingSince", "pendingKind",
    "lastPrice", "list", "currency", "image", "stock", "sku", "color", "size",
    "history", "notified", "notifiedRise", "watch", "muteUntilBelow", "snoozeKind"
  ];

  // Write one finished check onto whatever is in storage *now*, rather than
  // onto the snapshot the run started from.
  //
  // Two things this gets right that a whole-list write could not. An item
  // deleted while it was being checked stays deleted, instead of reappearing
  // when the run catches up. And an edit made during the check — a new target,
  // a pause — survives, because only the fields above are copied across.
  async function commitCheck(checked) {
    if (!checked || !checked.id) return null;
    return serialized(async () => {
      const items = await getItems();
      const at = items.findIndex((i) => i.id === checked.id);
      if (at < 0) return null; // deleted mid-check; let it stay deleted
      const fresh = items[at];
      for (const key of CHECK_FIELDS) {
        if (key in checked) fresh[key] = checked[key];
      }
      await setItems(items);
      return fresh;
    });
  }

  // A tracked item is due for a check unless it is paused, snoozed, or has
  // failed enough times that we've stopped bothering the site.
  function isCheckable(item) {
    if (item.paused) return false;
    if (item.snoozeUntil && item.snoozeUntil > Date.now()) return false;
    if (item.failCount >= MAX_FAILS) return false;
    return true;
  }

  // `detected` is an extractor reading, optionally corrected by the user on the
  // confirm screen. Whatever it says at this moment becomes the fingerprint.
  function makeItem(detected, target, opts) {
    const o = opts || {};
    const now = Date.now();
    return normalizeItem({
      alertOn: o.alertOn,
      watch: o.watch,
      url: detected.url,
      canonical: detected.canonical || detected.url,
      title: detected.title,
      image: detected.image || "",
      seller: detected.seller || sellerFromUrl(detected.url),
      currency: detected.currency || "",
      list: detected.list != null ? detected.list : null,
      target: target == null ? null : target,
      addedPrice: detected.price,
      lastPrice: detected.price,
      stock: detected.stock || "",
      sku: detected.sku || "",
      color: detected.color || "",
      size: detected.size || "",
      // Only fields the page actually published can be verified later.
      fpSku: detected.sku || "",
      fpColor: detected.color || "",
      fpSize: detected.size || "",
      confirmed: !!o.confirmed,
      confirmedAt: o.confirmed ? now : 0,
      history: [historyPoint(detected, now)],
      lastChecked: now,
      lastOk: now,
      createdAt: now
    });
  }

  // Does a fresh reading describe the same thing the user confirmed? Only
  // compares fields present on both sides — a page that stops publishing its
  // SKU is not evidence of a different product.
  function identityMismatch(item, reading) {
    const pairs = [["fpSku", "sku"], ["fpColor", "color"], ["fpSize", "size"]];
    for (const [want, got] of pairs) {
      const a = str(item[want]).toLowerCase();
      const b = str(reading[got]).toLowerCase();
      if (a && b && a !== b) return { field: got, expected: item[want], found: reading[got] };
    }
    return null;
  }

  // --- export / import (screen 12, DATA) --------------------------------------
  // One row per item. History rides in a single column as `t:price|t:price`,
  // which keeps a spreadsheet readable and still round-trips exactly.

  const CSV_COLUMNS = [
    "id", "title", "url", "canonical", "seller", "image", "currency",
    "list", "target", "alertOn", "addedPrice", "lastPrice", "stock",
    "sku", "color", "size", "watch", "fpSku", "fpColor", "fpSize", "confirmed", "confirmedAt",
    "paused", "snoozeUntil", "snoozeKind", "muteUntilBelow",
    "pendingPrice", "suspect",
    "createdAt", "lastChecked", "lastOk", "failCount", "history"
  ];

  const CSV_NUM = ["list", "target", "addedPrice", "lastPrice", "snoozeUntil",
                   "muteUntilBelow", "createdAt", "lastChecked", "lastOk", "failCount",
                   "confirmedAt", "pendingPrice"];
  const CSV_BOOL = ["paused", "confirmed"];

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // `t:price` for a plain point, `t:price:via:conf` when provenance is known.
  // Neither timestamps nor prices contain a colon, so this splits cleanly, and
  // two-part points written by older versions still parse.
  function encodeHistory(hist) {
    return (hist || [])
      .filter((h) => h && Number.isFinite(h.t) && Number.isFinite(h.price))
      .map((h) => h.via ? [h.t, h.price, h.via, h.conf || ""].join(":") : h.t + ":" + h.price)
      .join("|");
  }

  function decodeHistory(s) {
    if (!s) return [];
    return String(s).split("|").map((pair) => {
      const parts = pair.split(":");
      if (parts.length < 2) return null;
      const t = parseFloat(parts[0]);
      const price = parseFloat(parts[1]);
      if (!Number.isFinite(t) || !Number.isFinite(price)) return null;
      const p = { t, price };
      if (parts[2]) p.via = parts[2];
      if (parts[3]) p.conf = parts[3];
      return p;
    }).filter(Boolean);
  }

  function toCsv(items) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const it of items || []) {
      lines.push(CSV_COLUMNS.map((c) =>
        csvCell(c === "history" ? encodeHistory(it.history) : it[c])).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  // RFC 4180: quoted fields may hold commas, newlines, and doubled quotes.
  function parseCsv(text) {
    const s = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function cellToValue(col, raw) {
    const s = raw == null ? "" : String(raw).trim();
    if (col === "history") return decodeHistory(s);
    if (CSV_BOOL.indexOf(col) >= 0) return /^(true|1|yes)$/i.test(s);
    if (CSV_NUM.indexOf(col) >= 0) {
      if (s === "" || /^(null|undefined)$/i.test(s)) return null;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    }
    return s;
  }

  function usableUrl(u) {
    try { return /^https?:$/.test(new URL(u).protocol); } catch (e) { return false; }
  }

  // Anything without a fetchable URL is not an item we could ever check, so it
  // is skipped and counted rather than imported as a broken row.
  function collect(records) {
    const out = [];
    let skipped = 0;
    for (const o of records) {
      if (!o || typeof o !== "object" || !usableUrl(o.url || o.canonical)) { skipped++; continue; }
      out.push(normalizeItem(o));
    }
    return { records: out, skipped, error: null };
  }

  function fromJson(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      return { records: [], skipped: 0, error: "That isn't valid JSON." };
    }
    const arr = Array.isArray(data) ? data
      : data && Array.isArray(data.items) ? data.items : null;
    if (!arr) {
      return { records: [], skipped: 0,
        error: "Expected a list of items, or an object with an \"items\" list." };
    }
    return collect(arr);
  }

  function fromCsvText(raw) {
    const rows = parseCsv(raw)
      .filter((r) => r.length && !(r.length === 1 && r[0].trim() === ""));
    if (rows.length < 2) {
      return { records: [], skipped: 0, error: "No rows found under the header." };
    }
    const idx = {};
    rows[0].forEach((name, i) => {
      const key = String(name).trim();
      if (key && CSV_COLUMNS.indexOf(key) >= 0) idx[key] = i;
    });
    if (idx.url == null && idx.canonical == null) {
      return { records: [], skipped: 0,
        error: "No \"url\" column — this doesn't look like an exported list." };
    }
    const objs = [];
    for (let r = 1; r < rows.length; r++) {
      const o = {};
      for (const col of Object.keys(idx)) o[col] = cellToValue(col, rows[r][idx[col]]);
      objs.push(o);
    }
    return collect(objs);
  }

  // Accepts our own CSV or a JSON dump — a v1-shaped export migrates on the way
  // in, because every record goes through normalizeItem.
  function itemsFromText(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return { records: [], skipped: 0, error: "There's nothing to import." };
    return raw[0] === "[" || raw[0] === "{" ? fromJson(raw) : fromCsvText(raw);
  }

  function keyOf(it) {
    return String(it.canonical || it.url || "").replace(/#.*$/, "");
  }

  // Pure, so the merge rules can be tested without storage. Something already on
  // the list wins: an import never overwrites live history.
  function mergeItems(existing, incoming) {
    const items = (existing || []).slice();
    const seen = new Set(items.map(keyOf));
    const ids = new Set(items.map((i) => i.id));
    let imported = 0, duplicates = 0;
    for (const it of incoming || []) {
      const key = keyOf(it);
      if (!key || seen.has(key)) { duplicates++; continue; }
      if (ids.has(it.id)) it.id = newId();
      seen.add(key);
      ids.add(it.id);
      items.push(it);
      imported++;
    }
    return { items, imported, duplicates };
  }

  async function importText(text) {
    const parsed = itemsFromText(text);
    if (parsed.error) {
      return { ok: false, error: parsed.error, imported: 0, duplicates: 0, skipped: 0 };
    }
    const merged = mergeItems(await getItems(), parsed.records);
    if (merged.imported) await setItems(merged.items);
    return { ok: true, error: null, imported: merged.imported,
             duplicates: merged.duplicates, skipped: parsed.skipped };
  }

  root.Store = {
    SCHEMA_VERSION, MAX_FAILS, DEFAULT_SETTINGS, SNOOZE, DAY,
    getSettings, setSettings,
    getItems, setItems, updateItem, removeItem, commitCheck, CHECK_FIELDS,
    normalizeItem, makeItem, isCheckable, sellerFromUrl, newId,
    productKey, sameProduct, historyPoint, identityMismatch,
    CSV_COLUMNS, toCsv, parseCsv, itemsFromText, mergeItems, importText
  };
})(typeof self !== "undefined" ? self : globalThis);
