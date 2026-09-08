// Exercises the real background.js pipeline with stubbed Chrome APIs.
const fs = require("fs");
const DIR = "/Users/ndco/Documents/dev/untitled/price-tracker/";
const FIX = "/Users/ndco/Documents/dev/untitled/fixtures/";

global.self = global;

let mem = {};
let tabsOpened = 0, fetches = [];
let fetchImpl = async () => null;
const notifs = [];

const TAB_ID = 7;
let tabLoadMode = "afterListener";
let tabsById = {};
const updateListeners = new Set();

global.importScripts = (...files) => files.forEach((f) => require(DIR + f));

global.chrome = {
  storage: {
    local: {
      get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => o[x] = mem[x]); return o; },
      set: async (o) => Object.assign(mem, o)
    },
    onChanged: { addListener() {} }
  },
  alarms: { create() {}, get: async () => ({ scheduledTime: Date.now() + 6e4 }), onAlarm: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} },
             onMessage: { addListener() {} }, lastError: null },
  notifications: { create: (id, o) => notifs.push({ id, title: o.title }), clear() {},
                   onClicked: { addListener() {} }, onButtonClicked: { addListener() {} } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
            setBadgeTextColor: async () => {}, setIcon: async () => {} },
  // A tab with a real load lifecycle. The old stub fired "complete" from
  // inside addListener, so the page appeared to load *because* the worker
  // started listening — which is the one guarantee Chrome does not give. That
  // made the listener race structurally untestable, and it shipped.
  //
  // `tabLoadMode` decides when the page finishes relative to the worker
  // attaching its listener:
  //   "afterListener"  — the ordinary case, the event lands while we listen
  //   "beforeListener" — a cached or fast page, already done at create time
  //   "never"          — a page that hangs and never signals complete
  tabs: {
    create: async ({ url }) => {
      tabsOpened++;
      const tab = { id: TAB_ID, url, status: "loading" };
      tabsById[TAB_ID] = tab;
      if (tabLoadMode === "beforeListener") {
        // Done before the worker can possibly be listening, so no event fires.
        tab.status = "complete";
      } else if (tabLoadMode === "afterListener") {
        setTimeout(() => {
          tab.status = "complete";
          for (const fn of updateListeners) fn(TAB_ID, { status: "complete" });
        }, 1);
      }
      return tab;
    },
    get: async (id) => tabsById[id] || null,
    remove: async (id) => { delete tabsById[id]; },
    onUpdated: {
      addListener: (fn) => updateListeners.add(fn),
      removeListener: (fn) => updateListeners.delete(fn)
    }
  },
  scripting: { executeScript: async () => [{ result: global.__TAB_READING__ || null }] },
  downloads: { download: async () => 1 }
};

global.fetch = async (url, opts) => {
  fetches.push(String(url));
  return fetchImpl(String(url), opts);
};

const htmlResponse = (body) => ({
  ok: true, url: "x",
  headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : "") },
  text: async () => body
});

// Load the worker into global scope so its top-level functions are callable.
(0, eval)(fs.readFileSync(DIR + "background.js", "utf8"));

const Store = global.Store, PT = global.PT;
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log("  FAIL:", n)); };
const section = (s) => console.log("\n" + s);

const ON_URL = "https://www.on.com/en-us/products/cloud-sky-3YD1144/unisex/black-eclipse-shoes-3YD11440106?variant=6";
const onHtml = fs.readFileSync(FIX + "on-com.html", "utf8");

function reset() {
  mem = { settings: { intervalMinutes: 60, retentionDays: 730, notifications: true, currency: "USD" } };
  tabsOpened = 0; fetches = []; notifs.length = 0;
  global.__TAB_READING__ = null;
  fetchImpl = async () => null;
  tabLoadMode = "afterListener";
  tabsById = {};
  updateListeners.clear();
}

(async () => {
  // ---- fetch-first ----------------------------------------------------------
  section("fetch-first: on.com resolves without opening a tab");
  reset();
  fetchImpl = async (u) => (u.includes("on.com") ? htmlResponse(onHtml) : null);
  let item = Store.makeItem({ url: ON_URL, title: "Cloud Sky", price: 999, currency: "USD",
    canonical: ON_URL, seller: "on.com", sku: "3YD11440106", color: "Black | Eclipse" }, null,
    { confirmed: true });
  item.lastPrice = 75; item.addedPrice = 75;  // baseline matches so no sanity hold
  let r = await checkItem(item);
  ok("check succeeded", r.ok === true);
  ok("no tab was opened", tabsOpened === 0);
  ok("price is the sale price", item.lastPrice === 75);
  ok("list price captured", item.list === 110);
  ok("history point carries provenance", item.history.some(h => h.via === "jsonld-variant"));
  ok("rule learned the winning strategy", (mem.siteRules || {})["on.com"].strategy === "jsonld-variant");

  // ---- tab escalation -------------------------------------------------------
  section("escalation: unusable HTML falls back to a tab");
  reset();
  fetchImpl = async () => htmlResponse("<html><body>nothing priced here</body></html>");
  global.__TAB_READING__ = { price: 42, currency: "USD", via: "heuristic", conf: "medium",
                             raw: "$42", title: "T", sku: "", color: "", size: "", stock: "in" };
  item = Store.makeItem({ url: "https://shop.test/p/1", title: "T", price: 42, currency: "USD" }, null);
  r = await checkItem(item);
  ok("fell back to a tab", tabsOpened === 1);
  ok("reading accepted", item.lastPrice === 42);
  ok("needsTab remembered", (mem.siteRules || {})["shop.test"].needsTab === true);

  // ---- identity verification ------------------------------------------------
  section("identity: page serves a different colour");
  reset();
  fetchImpl = async () => htmlResponse(onHtml);
  item = Store.makeItem({ url: ON_URL, title: "Cloud Sky", price: 75, currency: "USD",
    sku: "3YD11440106", color: "Black | Eclipse" }, null, { confirmed: true });
  item.fpColor = "Dustrose | Terra";        // user confirmed a different colour
  item.fpSku = "3YD11443992";
  const before = item.lastPrice;
  r = await checkItem(item);
  ok("reading rejected", r.rejected === "identity");
  ok("price untouched", item.lastPrice === before);
  ok("mismatch explained", /you tracked/.test(item.identityMismatch));
  ok("not counted as a failure", item.failCount === 0);

  // ---- sanity gate ----------------------------------------------------------
  section("sanity: an implausible jump is held until confirmed");
  reset();
  fetchImpl = async () => null;
  global.__TAB_READING__ = { price: 12.99, currency: "USD", via: "jsonld", conf: "high", raw: "12.99" };
  item = Store.makeItem({ url: "https://shop.test/p/2", title: "T", price: 1299, currency: "USD" }, null);
  const hist0 = item.history.length;
  r = await checkItem(item);
  ok("held, not recorded", r.held === true);
  ok("price unchanged", item.lastPrice === 1299);
  ok("history not appended", item.history.length === hist0);
  ok("pending remembered", item.pendingPrice === 12.99);
  ok("reason is legible", /moved 99%/.test(item.suspect));
  ok("no alert fired", notifs.length === 0);

  r = await checkItem(item);   // same reading again -> confirmed
  ok("second identical reading accepted", item.lastPrice === 12.99);
  ok("pending cleared", item.pendingPrice === null);
  ok("history now appended", item.history.length === hist0 + 1);

  // ---- a genuine large clearance still lands, one cycle later ---------------
  section("sanity: a real 70% clearance is delayed, not lost");
  reset();
  global.__TAB_READING__ = { price: 30, currency: "USD", via: "jsonld", conf: "high", raw: "30" };
  item = Store.makeItem({ url: "https://shop.test/p/3", title: "T", price: 100, currency: "USD" }, 40);
  await checkItem(item);
  ok("first pass holds", item.lastPrice === 100 && item.pendingPrice === 30);
  await checkItem(item);
  ok("second pass accepts", item.lastPrice === 30);
  ok("alert fires once accepted", notifs.length === 1);

  // ---- confidence gate ------------------------------------------------------
  section("confidence: a low-confidence reading is never believed");
  reset();
  global.__TAB_READING__ = { price: 88, currency: "USD", via: "heuristic", conf: "low", raw: "$88" };
  item = Store.makeItem({ url: "https://shop.test/p/4", title: "T", price: 100, currency: "USD" }, null);
  r = await checkItem(item);
  ok("low confidence held", r.held === true && item.lastPrice === 100);
  // Repeating an uncertain reading does not make it certain. The second look
  // reads the same ambiguous page and reaches the same uncertainty.
  r = await checkItem(item);
  ok("repetition is not corroboration", item.lastPrice === 100 && r.held === true);
  ok("marked unverified, not confirming", item.pendingKind === "unverified");
  ok("the number is still shown", item.pendingPrice === 88);

  section("confidence: a wrong price cannot launder itself through the baseline");
  reset();
  // The G1 shape: the add flow captured a low-confidence price, so the
  // baseline itself is wrong. Every later reading agrees with it, because it
  // is the same misreading of the same page.
  global.__TAB_READING__ = { price: 19.83, currency: "USD", via: "jsonld-variant",
                             conf: "low", raw: "19.83", title: "Rain Jacket" };
  item = Store.makeItem({ url: "https://www.rei.com/product/235244/x", title: "Rain Jacket",
    price: 19.83, currency: "USD" }, null, { confirmed: true });
  for (let i = 0; i < 3; i++) await checkItem(item);
  ok("never written to history", item.history.length === 1);
  ok("row does not look healthy", item.pendingKind === "unverified");
  ok("and needs attention", PT.needsAttention(item) === true);

  section("confidence: a modest medium-confidence move is believed");
  reset();
  global.__TAB_READING__ = { price: 95, currency: "USD", via: "meta", conf: "medium", raw: "95" };
  item = Store.makeItem({ url: "https://shop.test/p/5", title: "T", price: 100, currency: "USD" }, null);
  r = await checkItem(item);
  ok("accepted immediately", item.lastPrice === 95 && !r.held);

  // ---- currency -------------------------------------------------------------
  section("currency: a switch is not a price change");
  reset();
  global.__TAB_READING__ = { price: 92, currency: "EUR", via: "jsonld", conf: "high", raw: "92" };
  item = Store.makeItem({ url: "https://shop.test/p/6", title: "T", price: 100, currency: "USD" }, null);
  r = await checkItem(item);
  ok("rejected", r.rejected === "currency");
  ok("price untouched", item.lastPrice === 100);
  ok("explained", /priced in EUR/.test(item.suspect));

  // ---- known blocker --------------------------------------------------------
  section("known blocker: skips the pointless fetch");
  reset();
  let fetchCalls = 0;
  fetchImpl = async () => { fetchCalls++; return null; };
  global.__TAB_READING__ = null;
  item = Store.makeItem({ url: "https://www.nordstromrack.com/s/x/123", title: "T", price: 10, currency: "USD" }, null);
  r = await checkItem(item);
  ok("no fetch attempted", fetchCalls === 0);
  ok("went straight to a tab", tabsOpened === 1);
  ok("failure recorded", item.failCount === 1);

  // ---- stock watch ----------------------------------------------------------
  section("stock watch: sold out waits for the return, not the price");
  reset();
  global.__TAB_READING__ = { price: 229.97, currency: "USD", via: "jsonld", conf: "high",
                             raw: "229.97", stock: "out", title: "Jacket" };
  item = Store.makeItem({ url: "https://shop.test/p/gone", title: "Jacket", price: 229.97,
    currency: "USD", stock: "out" }, null, { watch: "stock", confirmed: true });
  ok("stored as a stock watch", item.watch === "stock");
  r = await checkItem(item);
  ok("still sold out: no alert", notifs.length === 0);
  ok("still watching stock", item.watch === "stock");
  ok("price history still builds", item.history.length >= 1);

  global.__TAB_READING__ = { price: 199.97, currency: "USD", via: "jsonld", conf: "high",
                             raw: "199.97", stock: "in", title: "Jacket" };
  r = await checkItem(item);
  ok("back in stock fires exactly one alert", notifs.length === 1);
  ok("alert says back in stock", /BACK IN STOCK/.test(notifs[0].title));
  ok("switched to price watching", item.watch === "price");
  ok("new price recorded", item.lastPrice === 199.97);

  // ---- tab load wiring ------------------------------------------------------
  // These are about ordering, not logic. Each one failed before the fix, and
  // none of them could fail under the old stub.
  section("tab load: a page that finished before we listened is still read");
  reset();
  tabLoadMode = "beforeListener";
  global.__TAB_READING__ = { price: 42.5, currency: "USD", via: "jsonld", conf: "high",
                             raw: "42.50", title: "Fast Page" };
  item = Store.makeItem({ url: "https://shop.test/p/cached", title: "Fast Page", price: 42.5,
    currency: "USD" }, null, { confirmed: true });
  r = await checkItem(item);
  ok("the read succeeded", r.ok === true);
  ok("no failure recorded", item.failCount === 0);
  ok("the price was stored", item.lastPrice === 42.5);

  section("tab load: waitForComplete asks the tab, not only the event stream");
  reset();
  tabLoadMode = "beforeListener";
  await chrome.tabs.create({ url: "https://shop.test/p/x", active: false });
  ok("already-complete resolves without waiting", (await waitForComplete(TAB_ID, 40)) === true);

  reset();
  tabLoadMode = "never";
  await chrome.tabs.create({ url: "https://shop.test/p/x", active: false });
  ok("a hung page still times out", (await waitForComplete(TAB_ID, 40)) === false);

  section("tab load: a timeout is not a verdict — the page is read anyway");
  reset();
  tabLoadMode = "never";
  global.__TAB_READING__ = { price: 88, currency: "USD", via: "jsonld", conf: "high",
                             raw: "88.00", title: "Slow Page" };
  let slow = await readViaTab("https://shop.test/p/slow", 40);
  ok("a price on a hung page is still returned", slow.ok === true && slow.reading.price === 88);

  reset();
  tabLoadMode = "never";
  global.__TAB_READING__ = null;
  slow = await readViaTab("https://shop.test/p/blank", 40);
  ok("a hung page with no price still fails", slow.ok === false);
  ok("and says why", /did not finish loading/.test(slow.error));

  // ---- the ratchet ----------------------------------------------------------
  section("recovery: a success ends the failure streak");
  reset();
  await Rules.set("https://shop.test/p/x", { fails: 2 });
  await Rules.recordSuccess("https://shop.test/p/x",
    { via: "jsonld", price: 1 }, false);
  let rule = await Rules.forUrl("https://shop.test/p/x");
  ok("fails reset to zero", rule.fails === 0);
  ok("cheap-path success clears needsTab", rule.needsTab === false);

  section("recovery: a stale needsTab earns one more cheap probe");
  reset();
  await Rules.set("https://shop.test/p/y",
    { needsTab: true, lastFail: Date.now() - 8 * 24 * 3600 * 1000 });
  rule = await Rules.forUrl("https://shop.test/p/y");
  ok("a week-old verdict is retried", Rules.shouldRetryCheapPath(rule) === true);
  await Rules.set("https://shop.test/p/z", { needsTab: true, lastFail: Date.now() });
  rule = await Rules.forUrl("https://shop.test/p/z");
  ok("a fresh verdict stands", Rules.shouldRetryCheapPath(rule) === false);
  rule = await Rules.forUrl("https://www.nordstrom.com/s/x/1");
  ok("a known blocker is never re-probed", Rules.shouldRetryCheapPath(rule) === false);

  // ---- persistence ----------------------------------------------------------
  section("checkAll: a throw part-way through does not discard earlier work");
  reset();
  global.__TAB_READING__ = { price: 10, currency: "USD", via: "jsonld", conf: "high",
                             raw: "10.00", title: "A" };
  const a = Store.makeItem({ url: "https://shop.test/p/a", title: "A", price: 10,
    currency: "USD" }, null, { confirmed: true });
  const b = Store.makeItem({ url: "https://shop.test/p/b", title: "B", price: 10,
    currency: "USD" }, null, { confirmed: true });
  b.history = null; // force checkItem to throw on the second item
  Object.defineProperty(b, "history", {
    get() { throw new Error("boom"); }, set() {}, configurable: true
  });
  await Store.setItems([a, b]);
  await checkAll();
  const saved = await Store.getItems();
  ok("the first item was still written", saved[0].lastPrice === 10);
  ok("the failing item was counted, not lost", saved.length === 2);

  // ---- variant pages: corroboration, or refusal ------------------------------
  // Every shape below was measured on the live site on 2026-09-07. In each one
  // every offer carries the page's own URL, so scoring alone cannot separate
  // them — which is how the old code ended up picking the cheapest.
  section("variants: the page's own declared price breaks the tie");
  const PTLd = global.PTLd;
  const variantLd = (url, rows) => JSON.stringify({
    "@context": "https://schema.org", "@type": "ProductGroup", url,
    name: "Better Sweater Fleece Jacket",
    hasVariant: rows.map((row, i) => ({
      "@type": "Product", sku: "PAT02Y3-" + i, color: row.color, size: row.size,
      name: "Better Sweater Fleece Jacket",
      offers: { "@type": "Offer", url, price: row.price, priceCurrency: "USD",
                availability: "https://schema.org/InStock" }
    }))
  });

  // Backcountry: 42 offers across two price tiers, meta tag says 169.
  const BC = "https://www.backcountry.com/patagonia-better-sweater-fleece-jacket-mens";
  const bcRows = [];
  for (let i = 0; i < 36; i++) bcRows.push({ color: "Stonewash", size: "M", price: 169 });
  for (let i = 0; i < 6; i++) bcRows.push({ color: "Aquatic Blue", size: "L", price: 118.3 });
  let cands = PTLd.offersFrom([variantLd(BC, bcRows)], "Backcountry");
  ok("all 42 offers collected", cands.length === 42);
  let picked = PTLd.pickForPage(cands, BC, BC, [169]);
  ok("the declared price wins, not the cheapest", picked && picked.price === 169);
  ok("and that is high confidence", picked && picked.conf === "high");
  ok("marked as corroborated", picked && picked.corroborated === true);

  section("variants: nothing to corroborate with means refuse, not guess");
  // REI: 170 offers at 19.83 / 20.83 / 34.83. The page sells at $79.95 and
  // publishes no price meta tag, so none of these can be confirmed.
  const REI = "https://www.rei.com/product/235244/rei-co-op-trailmade-rain-jacket-mens";
  const reiRows = [];
  for (let i = 0; i < 170; i++) {
    reiRows.push({ color: "Black", size: "M", price: [19.83, 20.83, 34.83][i % 3] });
  }
  cands = PTLd.offersFrom([variantLd(REI, reiRows)], "REI");
  ok("all 170 offers collected", cands.length === 170);
  ok("refused with no hint", PTLd.pickForPage(cands, REI, REI, null) === null);
  ok("refused when the hint matches nothing",
     PTLd.pickForPage(cands, REI, REI, [79.95]) === null);
  ok("a hint that names one of them resolves it",
     (PTLd.pickForPage(cands, REI, REI, [34.83]) || {}).price === 34.83);

  section("variants: an ambiguous product page is not a shelf");
  // pickForPage refusing must not read as "this is a category page", or the
  // DOM heuristic gets sent away exactly when it is the only layer left.
  ok("offers claiming the page mark it claimed",
     PTLd.pageIsClaimed(cands, REI, REI) === true);
  const shelf = JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: [
      { "@type": "Product", name: "A", url: "https://s.test/p/a",
        offers: { "@type": "Offer", url: "https://s.test/p/a", price: 10, priceCurrency: "USD" } },
      { "@type": "Product", name: "B", url: "https://s.test/p/b",
        offers: { "@type": "Offer", url: "https://s.test/p/b", price: 20, priceCurrency: "USD" } }
    ] });
  const shelfCands = PTLd.offersFrom([shelf], "Shelf");
  ok("offers pointing elsewhere leave the page unclaimed",
     PTLd.pageIsClaimed(shelfCands, "https://s.test/category/x", "") === false);

  section("variants: agreement still needs no hint");
  // Allbirds' 14 sizes at one price were never ambiguous, and must not start
  // needing a tiebreaker now.
  const AB = "https://www.allbirds.com/products/mens-cruiser";
  const abRows = [];
  for (let i = 0; i < 14; i++) abRows.push({ color: "Grey", size: String(i + 6), price: 105 });
  cands = PTLd.offersFrom([variantLd(AB, abRows)], "Allbirds");
  picked = PTLd.pickForPage(cands, AB, AB, null);
  ok("one price across every size is unambiguous", picked && picked.price === 105);
  ok("high confidence without any hint", picked && picked.conf === "high");

  section("variants: the fetch path reads the meta tag as corroboration");
  const html = '<html><head><title>Better Sweater</title>' +
    '<link rel="canonical" href="' + BC + '">' +
    '<meta property="product:price:amount" content="169">' +
    '<meta property="product:price:currency" content="USD">' +
    '<script type="application/ld+json">' + variantLd(BC, bcRows) + '</script>' +
    '</head><body></body></html>';
  const fromHtml = PTLd.fromHtml(html, BC);
  ok("fromHtml resolves the variant page", fromHtml && fromHtml.price === 169);
  ok("at high confidence, so no tab is needed", fromHtml && fromHtml.conf === "high");

  // ---- parallel checking -----------------------------------------------------
  // A single offer resolves at high confidence, so these never reach for a tab
  // and the timing below is the runner's, not the extractor's.
  const soloLd = (url, price) => htmlResponse(
    '<html><head><title>T</title><link rel="canonical" href="' + url + '">' +
    '<script type="application/ld+json">' + JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "T", url,
      offers: { "@type": "Offer", url, price, priceCurrency: "USD",
                availability: "https://schema.org/InStock" }
    }) + "</script></head><body></body></html>");

  // Watch how many reads are in the air at once, and whether any two of them
  // are against the same store.
  function watchFetches(delayMs) {
    const state = { peak: 0, live: 0, perHost: {}, hostPeak: 0 };
    fetchImpl = async (u) => {
      const host = new URL(u).hostname;
      state.live++; state.perHost[host] = (state.perHost[host] || 0) + 1;
      state.peak = Math.max(state.peak, state.live);
      state.hostPeak = Math.max(state.hostPeak, state.perHost[host]);
      await new Promise((r) => setTimeout(r, delayMs));
      state.live--; state.perHost[host]--;
      return soloLd(u, 50);
    };
    return state;
  }

  const seed = (urls) => urls.map((u) => Store.makeItem(
    { url: u, title: "T", price: 50, currency: "USD" }, null, { confirmed: true }));

  section("parallel: separate stores are checked at the same time");
  reset();
  let watch = watchFetches(15);
  await Store.setItems(seed([
    "https://a.test/products/1", "https://b.test/products/1",
    "https://c.test/products/1", "https://d.test/products/1",
    "https://e.test/products/1", "https://f.test/products/1"
  ]));
  let run = await checkAll();
  ok("every item was checked", run.checked === 6 && run.ok === 6);
  ok("more than one at a time", watch.peak > 1);
  ok("never more than the lane limit", watch.peak <= 3);
  const savedRun = await Store.getItems();
  ok("every result was written", savedRun.filter((i) => i.lastPrice === 50).length === 6);

  section("parallel: one store is never hit twice at once");
  reset();
  watch = watchFetches(15);
  await Store.setItems(seed([
    "https://one.test/products/1", "https://one.test/products/2",
    "https://one.test/products/3", "https://one.test/products/4"
  ]));
  run = await checkAll();
  ok("all four checked", run.checked === 4 && run.ok === 4);
  ok("the same store saw one at a time", watch.hostPeak === 1);

  section("parallel: a stuck page does not hold up the run");
  reset();
  // withBudget is the seam the runner uses; exercise it directly so the test
  // does not have to wait out the real ceiling.
  let stuck = new Promise(() => {});
  let budgetErr = null;
  try { await withBudget(stuck, 30); } catch (e) { budgetErr = e.message; }
  ok("a hung check is given up on", /took too long/.test(budgetErr || ""));
  ok("a check that answers in time is untouched",
     (await withBudget(Promise.resolve("fine"), 200)) === "fine");

  section("parallel: rule writes do not overwrite each other");
  reset();
  // Every rule write is read-modify-write against one storage key. Run three
  // at once, as the lanes now do, and without a queue the last write wins and
  // the other two hosts are simply forgotten.
  await Promise.all([
    Rules.recordFailure("https://ra.test/products/1"),
    Rules.recordFailure("https://rb.test/products/1"),
    Rules.recordFailure("https://rc.test/products/1")
  ]);
  let learned = (await Rules.all()).learned;
  ok("all three hosts survived", Object.keys(learned).length === 3);
  ok("each counted its own failure",
     learned["ra.test"].fails === 1 && learned["rb.test"].fails === 1 &&
     learned["rc.test"].fails === 1);

  section("parallel: repeated failures on one host still add up");
  reset();
  await Promise.all([
    Rules.recordFailure("https://rd.test/products/1"),
    Rules.recordFailure("https://rd.test/products/2"),
    Rules.recordFailure("https://rd.test/products/3")
  ]);
  learned = (await Rules.all()).learned;
  ok("three failures counted as three", learned["rd.test"].fails === 3);
  ok("and that retires the cheap path", learned["rd.test"].needsTab === true);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
