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

  // Every write here is read-modify-write against one storage key, and checks
  // now run several at a time. Two hosts finishing together would both read
  // the same map and the second write would erase the first — the rule that
  // said "this site needs a tab" would simply vanish. So writes queue behind
  // each other. Reads are untouched; they are allowed to be slightly stale.
  let writeQueue = Promise.resolve();

  function serialized(work) {
    const next = writeQueue.then(work, work);
    // Keep the chain alive even when one write throws.
    writeQueue = next.then(noop, noop);
    return next;
  }

  function noop() {}

  async function set(url, patch) {
    const host = hostOf(url);
    if (!host) return null;
    return serialized(async () => {
      const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
      learned[host] = Object.assign({}, learned[host] || {}, patch, { updatedAt: Date.now() });
      await chrome.storage.local.set({ [KEY]: learned });
      return learned[host];
    });
  }

  async function clear(url) {
    const host = hostOf(url);
    return serialized(async () => {
      const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
      delete learned[host];
      await chrome.storage.local.set({ [KEY]: learned });
    });
  }

  // Remember what worked. A success ends the failure streak: the count exists
  // to escalate a site that is refusing us, and a site that just answered is
  // not refusing us. Leaving it to accumulate turned one bad afternoon into a
  // permanent verdict on the domain.
  //
  // `needsTab` still leans sticky — the cheap path failing is the expensive
  // thing to discover — but it is no longer a one-way door. Proof that the
  // cheap path works now beats the memory that it once did not.
  async function recordSuccess(url, reading, usedTab) {
    const patch = { strategy: reading.via, lastOk: Date.now(), fails: 0 };
    if (usedTab) patch.needsTab = true;
    else patch.needsTab = false;
    return set(url, patch);
  }

  // How long a `needsTab` verdict stands before the cheap path earns one more
  // try. Sites get rebuilt, and a store that went server-rendered should not
  // cost us a tab forever because of how it looked last month.
  const REPROBE_AFTER = 7 * 24 * 60 * 60 * 1000;

  // Is the expensive path still justified, or is this verdict stale enough to
  // re-test? A blocker is a standing refusal, not a stale observation.
  function shouldRetryCheapPath(rule) {
    if (!rule || !rule.needsTab || rule.knownBlocker) return false;
    const last = rule.lastFail || rule.updatedAt || 0;
    return !last || Date.now() - last > REPROBE_AFTER;
  }

  // Counting failures is only useful if the count changes what we do. After
  // enough of them the cheap fetch is clearly never going to work on this site,
  // so stop paying for it and go straight to a rendered tab.
  const GIVE_UP_ON_FETCH = 3;

  // The count has to be read and written as one step. Reading it outside the
  // queue and writing it inside means two failures on the same host can both
  // read 1 and both write 2, and a site that refused us three times looks like
  // it refused us once.
  async function recordFailure(url) {
    const host = hostOf(url);
    if (!host) return null;
    return serialized(async () => {
      const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
      const fails = ((learned[host] || {}).fails || 0) + 1;
      const patch = { fails, lastFail: Date.now() };
      if (fails >= GIVE_UP_ON_FETCH) patch.needsTab = true;
      learned[host] = Object.assign({}, learned[host] || {}, patch, { updatedAt: Date.now() });
      await chrome.storage.local.set({ [KEY]: learned });
      return learned[host];
    });
  }

  // A price corrected by hand tells us something durable: the layer that
  // produced the wrong number cannot be trusted on this site. We record that
  // rather than a CSS selector — stores ship build-hashed class names
  // (`_price_1d3gn_138`) that change on their next deploy, so a learned
  // selector is scrap almost immediately. Distrust survives redesigns.
  async function learnCorrection(url, badVia) {
    const host = hostOf(url);
    if (!host) return null;
    // Same reason as recordFailure: the list is appended to, so it has to be
    // read and written without anyone slipping in between.
    return serialized(async () => {
      const { [KEY]: learned = {} } = await chrome.storage.local.get(KEY);
      const prev = (learned[host] || {}).distrust || [];
      const distrust = badVia && prev.indexOf(badVia) < 0 ? prev.concat(badVia) : prev;
      learned[host] = Object.assign({}, learned[host] || {},
        { distrust, correctedAt: Date.now() }, { updatedAt: Date.now() });
      await chrome.storage.local.set({ [KEY]: learned });
      return learned[host];
    });
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

  root.Rules = { KEY, BUILT_IN, GIVE_UP_ON_FETCH, REPROBE_AFTER, hostOf, all, forUrl, set, clear,
                 recordSuccess, recordFailure, learnCorrection, applyDistrust,
                 shouldRetryCheapPath };
})(typeof self !== "undefined" ? self : globalThis);
