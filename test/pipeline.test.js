// Exercises the real background.js pipeline with stubbed Chrome APIs.
const fs = require("fs");
const DIR = "/Users/ndco/Documents/dev/untitled/price-tracker/";
const FIX = "/Users/ndco/Documents/dev/untitled/fixtures/";

global.self = global;

let mem = {};
let tabsOpened = 0, fetches = [];
let fetchImpl = async () => null;
const notifs = [];

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
  tabs: {
    create: async () => { tabsOpened++; return { id: 7 }; },
    remove: async () => {},
    onUpdated: { addListener: (fn) => setTimeout(() => fn(7, { status: "complete" }), 1),
                 removeListener() {} }
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
  section("confidence: a low-confidence reading is not believed alone");
  reset();
  global.__TAB_READING__ = { price: 88, currency: "USD", via: "heuristic", conf: "low", raw: "$88" };
  item = Store.makeItem({ url: "https://shop.test/p/4", title: "T", price: 100, currency: "USD" }, null);
  r = await checkItem(item);
  ok("low confidence held", r.held === true && item.lastPrice === 100);
  r = await checkItem(item);
  ok("repeated low reading accepted", item.lastPrice === 88);

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

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
