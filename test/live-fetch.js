#!/usr/bin/env node
// Runs the real DOM-free read against LIVE product pages:
//
//   node test/live-fetch.js              the default page list
//   node test/live-fetch.js <url> ...    whichever pages you name
//
// This is the service worker's cheap path exactly as it ships — fetchHtml,
// then the Shopify probe, then PTLd.fromHtml — so what it prints is what a
// real check would get before deciding whether to pay for a tab.
//
// It is a probe, not a suite. Live pages change prices hourly and go out of
// stock, so there is nothing here to assert against. Read the `WOULD DO`
// column: that is the decision `acquire()` makes for each site.
//
// A site that lands in the tab column is not a failure. It is a site whose
// price is built by JavaScript we did not run, which is what the tab path is
// for. What matters is that the split stays roughly where it was and that no
// page returns a *wrong* number with high confidence.

const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "price-tracker");

// rules.js and adapters.js reach for chrome.storage on load. Nothing here
// learns anything, so an empty in-memory shim is enough.
global.self = global;
const mem = {};
global.chrome = {
  storage: { local: {
    get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => o[x] = mem[x]); return o; },
    set: async (o) => Object.assign(mem, o)
  } }
};
for (const f of ["ldparse.js", "rules.js", "adapters.js"]) {
  (0, eval)(fs.readFileSync(path.join(EXT, f), "utf8"));
}
const { PTLd, Rules, Adapters } = global;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_PAGES = [
  ["allbirds",    "https://www.allbirds.com/products/mens-cruiser-medium-grey"],
  ["on",          "https://www.on.com/en-us/products/cloud-5-3MD10420553/mens/shoes-3MD10422290"],
  ["patagonia",   "https://www.patagonia.com/product/mens-better-sweater-fleece-jacket/25528.html"],
  ["rei",         "https://www.rei.com/product/235244/rei-co-op-trailmade-rain-jacket-mens"],
  ["uniqlo",      "https://www.uniqlo.com/us/en/products/E459565-000/00"],
  ["target",      "https://www.target.com/p/-/A-88429520"],
  ["walmart",     "https://www.walmart.com/ip/575389962"],
  ["bestbuy",     "https://www.bestbuy.com/product/sony-wh-1000xm5-wireless-noise-cancelling-over-the-ear-headphones-black/J7XSRH5CXG"],
  ["homedepot",   "https://www.homedepot.com/p/317987598"],
  ["ikea",        "https://www.ikea.com/us/en/p/malm-bed-frame-white-s69931603/"],
  ["bhphoto",     "https://www.bhphotovideo.com/c/product/1667800-REG/sony_ilce_7m4_b_alpha_a7_iv_mirrorless.html"],
  ["newegg",      "https://www.newegg.com/p/N82E16820147861"],
  ["sephora",     "https://www.sephora.com/product/lip-sleeping-mask-P420652"],
  ["wayfair",     "https://www.wayfair.com/furniture/pdp/sihoo-ergonomic-mesh-office-chair-w002291366.html"],
  ["zappos",      "https://www.zappos.com/p/mens-brooks-ghost-17/product/9993464"],
  ["etsy",        "https://www.etsy.com/listing/1030029805"],
  ["nike",        "https://www.nike.com/t/air-force-1-07-mens-shoes-5QFp5Z/CW2288-111"],
  ["lego",        "https://www.lego.com/en-us/product/millennium-falcon-75375"],
  ["backcountry", "https://www.backcountry.com/patagonia-better-sweater-fleece-jacket-mens"],
  ["gap",         "https://www.gap.com/browse/product.do?pid=440760012"]
];

// Is this HTML the product page, or the wall in front of it?
function wallReason(html, status) {
  if (status === 404) return "404 — product URL no longer valid";
  if (status >= 400) return "HTTP " + status;
  if (html.length < 2000) return "empty response (" + html.length + " bytes)";
  const t = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ""])[1].trim();
  if (/robot or human|just a moment|access (to this page has been )?denied|access denied|pardon our interruption|are you a human/i.test(t)) {
    return "bot wall: " + t.slice(0, 44);
  }
  if (/^404|not found/i.test(t)) return "404 page";
  return null;
}

async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ac.signal, redirect: "follow",
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9",
                 accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });
    const text = await r.text();
    return { status: r.status, url: r.url, text,
             ct: r.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, url, text: "", ct: "", error: e.message };
  } finally { clearTimeout(timer); }
}

// The same order acquire() uses, minus the rule lookups: Shopify's own JSON
// endpoint if the markup says Shopify, then JSON-LD, then meta tags.
async function cheapPath(url, html) {
  if (Adapters.looksShopify(html, url)) {
    const canon = PTLd.canonicalFrom(html, url);
    const s = await Adapters.fromShopify(canon) ||
              (canon !== url ? await Adapters.fromShopify(url) : null);
    if (s) return s;
  }
  return PTLd.fromHtml(html, url);
}

const pad = (s, n) => String(s == null ? "" : s).slice(0, n).padEnd(n);

(async () => {
  const args = process.argv.slice(2).filter((a) => /^https?:/i.test(a));
  const pages = args.length
    ? args.map((u) => [new URL(u).hostname.replace(/^www\./, "").split(".")[0], u])
    : DEFAULT_PAGES;

  console.log("\nLive read — the cheap path only, exactly as the worker runs it\n");
  console.log(pad("site", 13) + pad("price", 10) + pad("was", 9) + pad("cur", 5) +
              pad("via", 16) + pad("conf", 7) + pad("stock", 7) + pad("cnd", 5) + "would do");
  console.log("-".repeat(104));

  const rows = [];
  for (const [name, url] of pages) {
    const res = await fetchHtml(url);
    if (res.error) {
      rows.push({ name, url, outcome: "tab", note: "fetch failed: " + res.error });
      console.log(pad(name, 13) + pad("—", 10) + " ".repeat(37) + "TAB   fetch failed: " + res.error);
      continue;
    }
    const wall = wallReason(res.text, res.status);
    if (wall) {
      rows.push({ name, url, outcome: "tab", note: wall });
      console.log(pad(name, 13) + pad("—", 10) + " ".repeat(37) + "TAB   " + wall);
      continue;
    }

    let r = null, err = null;
    try { r = await cheapPath(url, res.text); } catch (e) { err = e.message; }
    if (err) {
      rows.push({ name, url, outcome: "threw", note: err });
      console.log(pad(name, 13) + pad("—", 10) + " ".repeat(37) + "THREW " + err);
      continue;
    }
    if (!r) {
      rows.push({ name, url, outcome: "tab", note: "no layer matched the served HTML" });
      console.log(pad(name, 13) + pad("—", 10) + " ".repeat(37) + "TAB   no layer matched the served HTML");
      continue;
    }

    // acquire() only accepts the cheap read at high confidence; anything less
    // means the price is probably built by JavaScript we did not run.
    const takesIt = r.conf === "high";
    rows.push({ name, url, outcome: takesIt ? "cheap" : "tab", r });
    console.log(pad(name, 13) + pad(r.price, 10) + pad(r.list == null ? "—" : r.list, 9) +
      pad(r.currency || "—", 5) + pad(r.via, 16) + pad(r.conf, 7) +
      pad(r.stock || "—", 7) + pad(r.candidates, 5) +
      (takesIt ? "CHEAP" : "TAB   conf=" + r.conf + ", needs rendering"));
  }

  const n = (k) => rows.filter((x) => x.outcome === k).length;
  console.log("\n" + rows.length + " pages — " + n("cheap") + " read without a tab, " +
              n("tab") + " would escalate, " + n("threw") + " threw");
  if (process.env.LIVE_JSON) {
    fs.writeFileSync(process.env.LIVE_JSON, JSON.stringify(rows, null, 2));
    console.log("wrote " + process.env.LIVE_JSON);
  }
})();
