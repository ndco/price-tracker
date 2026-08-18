// Phase 5 verification: regressions from Phases 1-4 + new sort/filter/CSV logic.
global.self = global;
const DIR = "/Users/ndco/Documents/dev/untitled/price-tracker/";

const mem = {};
const notifs = [];
const badge = {};
let listeners = [];

global.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: mem[k] }),
      set: async (o) => {
        const changes = {};
        for (const k of Object.keys(o)) changes[k] = { newValue: o[k], oldValue: mem[k] };
        Object.assign(mem, o);
        listeners.forEach((fn) => fn(changes, "local"));
      }
    },
    onChanged: { addListener: (fn) => listeners.push(fn) }
  },
  alarms: { create() {}, get: async () => ({ scheduledTime: Date.now() + 6e4 }), onAlarm: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} },
             getManifest: () => ({ version: "0.1.0" }), lastError: null },
  notifications: { create: (id, o) => { notifs.push({ id, ...o }); }, clear() {},
                   onClicked: { addListener() {} }, onButtonClicked: { addListener() {} } },
  action: {
    setBadgeText: async (o) => { badge.text = o.text; },
    setBadgeBackgroundColor: async (o) => { badge.color = o.color; },
    setBadgeTextColor: async () => {},
    setIcon: async () => {}
  },
  tabs: { create: async () => ({ id: 1 }), remove: async () => {}, onUpdated: { addListener() {}, removeListener() {} } },
  scripting: { executeScript: async () => [{ result: null }] },
  downloads: { download: async () => 1 }
};

require(DIR + "compute.js");
require(DIR + "store.js");
require(DIR + "chart.js");

const PT = global.PT, Store = global.Store, PTChart = global.PTChart;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.log("  FAIL:", name)); };
const section = (s) => console.log("\n" + s);

(async () => {
  const now = Date.now(), D = 86400000;

  // ---- Phase 1-3 regressions -------------------------------------------------
  section("Phase 1-3 regressions");
  ok("progressToTarget 72", PT.progressToTarget({ addedPrice: 349, list: 399, target: 300, lastPrice: 328 }) === 72);
  ok("distanceToTarget 28", PT.distanceToTarget({ target: 300, lastPrice: 328 }) === 28);
  ok("vsStart -50", PT.deltas({ addedPrice: 110, list: 110, lastPrice: 55,
      history: [{ t: now - D, price: 110 }, { t: now, price: 55 }] }).vsStart === -50);
  ok("labelFor exported", typeof PT.labelFor === "function");
  ok("dealDuration exported", typeof PT.dealDuration === "function");

  mem.items = [{ id: "v1", url: "https://a.com/p", title: "T", currency: "USD", list: 110, target: 60,
    addedPrice: 110, lastPrice: 55, history: [{ t: 1, price: 110 }, { t: 2, price: 55 }],
    lastChecked: 2, notified: true }];
  const mig = (await Store.getItems())[0];
  ok("v1 migrates lossless", mig.target === 60 && mig.list === 110 && mig.lastPrice === 55 && mig.history.length === 2);
  ok("v1 gains alertOn=target", mig.alertOn === "target");
  ok("v1 gains snoozeKind", mig.snoozeKind === "");
  ok("v1 gains muteUntilBelow null", mig.muteUntilBelow === null);
  ok("schemaVersion 2", mig.schemaVersion === 2);

  section("chart.js edge cases");
  const edges = [
    { name: "empty", it: { history: [], target: null } },
    { name: "single point", it: { history: [{ t: 1, price: 5 }], target: 5 } },
    { name: "flat", it: { history: [{ t: 1, price: 5 }, { t: 2, price: 5 }], target: null } },
    { name: "no target", it: { history: [{ t: 1, price: 9 }, { t: 2, price: 3 }], target: null } },
    { name: "with target", it: { history: [{ t: 1, price: 9 }, { t: 2, price: 3 }], target: 4 } }
  ];
  for (const e of edges) {
    let s = "";
    try { s = PTChart.sparkline(e.it) + PTChart.detail(e.it); } catch (err) { s = "THREW " + err.message; }
    ok("chart " + e.name, /^<svg|<svg/.test(s) && !/NaN|undefined|Infinity|THREW/.test(s));
  }

  // ---- Phase 5: snooze semantics --------------------------------------------
  section("Phase 5 — snooze");
  ok("SNOOZE has 7/30/drop", !!(Store.SNOOZE["7"] && Store.SNOOZE["30"] && Store.SNOOZE.drop));
  ok("drop label honest", /DROP/i.test(Store.SNOOZE.drop.label) && Store.SNOOZE.drop.ms === 0);
  const snoozed = Store.normalizeItem({ url: "https://a.com/x", lastPrice: 10, addedPrice: 10,
    snoozeUntil: now + 7 * D, snoozeKind: "7" });
  ok("snoozed not checkable", Store.isCheckable(snoozed) === false);
  ok("snoozeKind preserved", snoozed.snoozeKind === "7");
  const expired = Store.normalizeItem({ url: "https://a.com/y", lastPrice: 10, addedPrice: 10, snoozeUntil: now - D });
  ok("expired snooze checkable", Store.isCheckable(expired) === true);
  // "until it drops" keeps checking (it is a mute, not a pause)
  const muted = Store.normalizeItem({ url: "https://a.com/z", lastPrice: 100, addedPrice: 100, muteUntilBelow: 100 });
  ok("mute-until-drop still checkable", Store.isCheckable(muted) === true);

  // ---- Phase 5: CSV round trip ----------------------------------------------
  section("Phase 5 — CSV export/import");
  const rich = [
    Store.makeItem({ url: "https://shop.test/a", title: 'Widget, "deluxe"', price: 55, list: 110,
      currency: "USD", canonical: "https://shop.test/a", seller: "shop.test", stock: "in" }, 60),
    Store.makeItem({ url: "https://shop.test/b", title: "Plain\nMultiline", price: 20,
      currency: "USD", canonical: "", seller: "shop.test" }, null)
  ];
  rich[0].history = [{ t: now - 3 * D, price: 110 }, { t: now - D, price: 79 }, { t: now, price: 55 }];
  const csv = Store.toCsv(rich);
  ok("csv has header", csv.split("\n")[0].includes("id") && csv.includes("history"));
  ok("csv quotes embedded comma/quote", csv.includes('""deluxe""'));
  const back = Store.itemsFromText(csv);
  const list = back.records || [];
  ok("no import error", !back.error);
  ok("csv round-trips count", list.length === 2);
  const a = list.find((i) => i.url === "https://shop.test/a");
  ok("round-trip title exact", a && a.title === 'Widget, "deluxe"');
  ok("round-trip target", a && a.target === 60);
  ok("round-trip history", a && a.history.length === 3 && a.history[2].price === 55);
  const b = list.find((i) => i.url === "https://shop.test/b");
  ok("round-trip null target survives", b && b.target === null);
  ok("round-trip newline title", b && b.title.includes("Multiline"));

  section("Phase 5 — import validation");
  const junkResults = ["", "not a csv at all", "id,title\n", "{}"].map((s) => {
    try { const r = Store.itemsFromText(s); return (r.records || []).length; }
    catch (e) { return "threw"; }
  });
  ok("malformed input yields no items (no crash)", junkResults.every((r) => r === 0 || r === "threw"));
  // JSON import path
  try {
    const jr = Store.itemsFromText(JSON.stringify(rich));
    ok("json import works", (jr.records || []).length === 2 && !jr.error);
  } catch (e) { ok("json import works", false); }

  // ---- Phase 5: sort + filter semantics (via PT, as the popup uses them) -----
  section("Phase 5 — sort/filter inputs");
  const fixture = [
    { id: "1", title: "Alpha", seller: "a.com", addedPrice: 100, lastPrice: 50, target: 60, list: 100,
      history: [{ t: now - D, price: 100 }, { t: now, price: 50 }], stock: "in", paused: false, snoozeUntil: 0, failCount: 0, createdAt: now - 5 * D },
    { id: "2", title: "Beta", seller: "b.com", addedPrice: 100, lastPrice: 95, target: 90, list: 100,
      history: [{ t: now - D, price: 100 }, { t: now, price: 95 }], stock: "out", paused: false, snoozeUntil: 0, failCount: 0, createdAt: now - D },
    { id: "3", title: "Gamma", seller: "c.com", addedPrice: 100, lastPrice: 99, target: null, list: null,
      history: [{ t: now, price: 99 }], stock: "in", paused: false, snoozeUntil: now + D, failCount: 0, createdAt: now - 3 * D }
  ].map(Store.normalizeItem);

  const c = PT.counts(fixture);
  ok("counts.tracked 3", c.tracked === 3);
  ok("counts.atTarget 1 (Alpha)", c.atTarget === 1);
  ok("counts.attention >=1 (out of stock)", c.attention >= 1);
  ok("snoozed excluded from active", c.active === 2);

  const byDrop = [...fixture].sort((x, y) => (PT.deltas(x).vsStart ?? 0) - (PT.deltas(y).vsStart ?? 0));
  ok("biggest drop first = Alpha", byDrop[0].id === "1");
  const withTarget = fixture.filter((i) => i.target != null);
  const byNear = [...withTarget].sort((x, y) => PT.distanceToTarget(x) - PT.distanceToTarget(y));
  ok("near target first = Alpha(-10)", byNear[0].id === "1");
  const byNew = [...fixture].sort((x, y) => y.createdAt - x.createdAt);
  ok("newest first = Beta", byNew[0].id === "2");
  const byAZ = [...fixture].sort((x, y) => x.title.localeCompare(y.title));
  ok("A-Z first = Alpha", byAZ[0].id === "1");

  section("Phase 5 — settings");
  const st = await Store.getSettings();
  ok("listSort default present", "listSort" in st);
  ok("listFilters default array", Array.isArray(st.listFilters));
  ok("no dead autoStopAfterPurchase", !("autoStopAfterPurchase" in Store.DEFAULT_SETTINGS));
  ok("retentionDays default 730", st.retentionDays === 730);
  const st2 = await Store.setSettings({ listSort: "drop" });
  ok("setSettings persists", st2.listSort === "drop" && (await Store.getSettings()).listSort === "drop");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
