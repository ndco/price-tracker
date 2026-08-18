// Per-domain extraction rules: what we ship, what we learn, what you correct.
// Data rather than code, so a site that changes can be fixed by editing a rule
// instead of shipping new logic. Loaded by the popup and the service worker.
(function (root) {
  "use strict";

  const KEY = "siteRules";

  // Shipped defaults. Only for things we have actually observed.
  const BUILT_IN = {
    // Refuses automated loads outright; a tab is no better than a fetch here,
    // but recording it stops us from retrying the cheap path forever.
    "nordstromrack.com": { knownBlocker: true },
    "nordstrom.com": { knownBlocker: true },
    // Prices live in ProductGroup.hasVariant and are present in the served HTML.
    "on.com": { strategy: "jsonld", needsTab: false },
    "zappos.com": { strategy: "jsonld", needsTab: false },
    "allbirds.com": { strategy: "jsonld", needsTab: false }
  };

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
    catch (e) { return ""; }
  }

  async function all() {
    const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
    return { learned, builtIn: BUILT_IN };
  }

  // Built-in first, learned on top: what we observed beats what we assumed.
  async function forUrl(url) {
    const host = hostOf(url);
    if (!host) return {};
    const { learned } = await all();
    return Object.assign({}, BUILT_IN[host] || {}, learned[host] || {});
  }

  async function set(url, patch) {
    const host = hostOf(url);
    if (!host) return null;
    const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
    learned[host] = Object.assign({}, learned[host] || {}, patch, { updatedAt: Date.now() });
    await chrome.storage.local.set({ [KEY]: learned });
    return learned[host];
  }

  async function clear(url) {
    const host = hostOf(url);
    const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
    delete learned[host];
    await chrome.storage.local.set({ [KEY]: learned });
  }

  // Remember what worked. `needsTab` is sticky in one direction only: once a
  // domain has needed a rendered page we keep paying for it, because the cheap
  // path failing is the expensive thing to discover.
  async function recordSuccess(url, reading, usedTab) {
    const patch = { strategy: reading.via, lastOk: Date.now() };
    if (usedTab) patch.needsTab = true;
    return set(url, patch);
  }

  // Counting failures is only useful if the count changes what we do. After
  // enough of them the cheap fetch is clearly never going to work on this site,
  // so stop paying for it and go straight to a rendered tab.
  const GIVE_UP_ON_FETCH = 3;

  async function recordFailure(url) {
    const host = hostOf(url);
    const { learned } = await all();
    const fails = ((learned[host] || {}).fails || 0) + 1;
    const patch = { fails, lastFail: Date.now() };
    if (fails >= GIVE_UP_ON_FETCH) patch.needsTab = true;
    return set(url, patch);
  }

  // A price corrected by hand tells us something durable: the layer that
  // produced the wrong number cannot be trusted on this site. We record that
  // rather than a CSS selector — stores ship build-hashed class names
  // (`_price_1d3gn_138`) that change on their next deploy, so a learned
  // selector is scrap almost immediately. Distrust survives redesigns.
  async function learnCorrection(url, badVia) {
    const host = hostOf(url);
    if (!host) return null;
    const { learned } = await all();
    const prev = (learned[host] || {}).distrust || [];
    const distrust = badVia && prev.indexOf(badVia) < 0 ? prev.concat(badVia) : prev;
    return set(url, { distrust, correctedAt: Date.now() });
  }

  // A reading from a layer this site has already got wrong is demoted, so the
  // existing confidence gate holds it for a second opinion instead of writing
  // it straight into history.
  function applyDistrust(rule, reading) {
    if (!rule || !reading) return reading;
    const bad = rule.distrust || [];
    if (reading.via && bad.indexOf(reading.via) >= 0) reading.conf = "low";
    return reading;
  }

  root.Rules = { KEY, BUILT_IN, GIVE_UP_ON_FETCH, hostOf, all, forUrl, set, clear,
                 recordSuccess, recordFailure, learnCorrection, applyDistrust };
})(typeof self !== "undefined" ? self : globalThis);
