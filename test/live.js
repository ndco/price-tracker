// Runs the real extractor against pages captured from a real browser.
//
// Capture them with the snippet in docs/TESTING.md: a live https page cannot
// fetch() localhost, but a top-level form POST is a navigation rather than a
// subresource, so Chrome allows it. Some sites refuse even that — REI sets a
// CSP `form-action` — and those simply cannot be captured this way.
//
// One caveat worth holding on to. A DOMParser document has no layout, so the
// extractor's `LIVE` checks are off: nothing is "hidden" and no style is
// struck through. That makes this harness a pessimistic stand-in for the DOM
// heuristic, because in a real tab those candidates would be filtered out. The
// structured layers behave identically either way.
const out = document.getElementById("out");
const CASES = [
  ["20-walmart",       "https://www.walmart.com/ip/575389962"],
  ["22-target",        "https://www.target.com/p/-/A-88429520"],
  ["23-newegg",        "https://www.newegg.com/p/N82E16820147861"],
  ["24-backcountry",   "https://www.backcountry.com/patagonia-better-sweater-fleece-jacket-mens"],
  ["25-sephora",       "https://www.sephora.com/product/lip-sleeping-mask-P420652"],
  ["26-on",            "https://www.on.com/en-us/products/cloud-5-3MD10420553/mens/shoes-3MD10422290"],
  ["27-gap",           "https://www.gap.com/browse/product.do?pid=440760012"],
  ["28-lego",          "https://www.lego.com/en-us/product/millennium-falcon-75375"],
  ["29-etsy",          "https://www.etsy.com/listing/1030029805"],
  ["30-uniqlo",        "https://www.uniqlo.com/us/en/products/E459565-000/00"],
  ["31-wayfair",       "https://www.wayfair.com/furniture/pdp/sihoo-ergonomic-mesh-office-chair-w002291366.html"],
  ["32-bhphoto",       "https://www.bhphotovideo.com/c/product/1667800-REG/sony_ilce_7m4_b_alpha_a7_iv_mirrorless.html"],
  // Older captures, kept while their files are still around.
  ["04-zappos",        "https://www.zappos.com/p/mens-brooks-ghost-17/product/9993464"],
  ["11-ikea",          "https://www.ikea.com/us/en/p/malm-bed-frame-white-s69931603/"],
  ["14-duluth",        "https://www.duluthpack.com/products/patagonia-womens-better-sweater-fleece-jacket"],
  ["15-patagoniabend", "https://www.patagoniabend.com/products/ms-better-sweater-j"]
];

let SRC = null, LD = null;
async function extract(html, url) {
  if (!LD) { LD = await (await fetch("/price-tracker/ldparse.js")).text(); (0, eval)(LD); }
  if (!SRC) SRC = await (await fetch("/price-tracker/inject-extract.js")).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  window.__PT_DOC__ = doc;
  window.__PT_URL__ = url;
  try { return (0, eval)(SRC); }
  finally { delete window.__PT_DOC__; delete window.__PT_URL__; }
}

// A capture that is really a bot wall, not the product page.
function wallReason(html) {
  const t = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ""])[1].trim();
  if (html.length < 2000) return "empty response (" + html.length + " bytes)";
  if (/robot or human|just a moment|access (to this page has been )?denied|access denied/i.test(t))
    return "bot wall: " + t.slice(0, 40);
  if (/404 not found/i.test(t)) return "404 — product URL no longer valid";
  return null;
}

(async () => {
  out.innerHTML = "";
  const rows = [];
  for (const [name, url] of CASES) {
    let html = null;
    try { const r = await fetch("/fixtures/live/" + name + ".html"); if (r.ok) html = await r.text(); }
    catch (e) {}
    if (html == null) { rows.push({ name, status: "NOT CAPTURED" }); continue; }

    const wall = wallReason(html);
    if (wall) { rows.push({ name, status: "BLOCKED", note: wall }); continue; }

    let r = null, err = null;
    try { r = await extract(html, url); } catch (e) { err = e.message; }
    if (err) rows.push({ name, status: "THREW", note: err });
    else if (!r) rows.push({ name, status: "NO PRICE", note: "no layer matched the raw HTML" });
    else rows.push({ name, status: "OK", r });
  }

  const cell = (s, n) => String(s == null ? "" : s).slice(0, n).padEnd(n);
  let html = `<table><tr><th>page</th><th>price</th><th>was</th><th>cur</th>` +
             `<th>via</th><th>conf</th><th>stock</th><th>cands</th><th>title / note</th></tr>`;
  for (const row of rows) {
    if (row.status !== "OK") {
      html += `<tr class="bad"><td>${row.name}</td><td colspan="7">${row.status}</td>` +
              `<td>${row.note || ""}</td></tr>`;
      continue;
    }
    const r = row.r;
    html += `<tr class="${r.conf === "high" ? "good" : "warn"}">` +
      `<td>${row.name}</td><td><b>${r.price}</b></td><td>${r.list == null ? "—" : r.list}</td>` +
      `<td>${r.currency || "—"}</td><td>${r.via}</td><td>${r.conf}</td>` +
      `<td>${r.stock || "—"}</td><td>${r.candidates}</td>` +
      `<td>${String(r.title || "").slice(0, 46)}</td></tr>`;
  }
  html += "</table>";
  out.innerHTML = html;
  window.__RESULT__ = rows.map((x) => x.status === "OK"
    ? { n: x.name, price: x.r.price, list: x.r.list, via: x.r.via, conf: x.r.conf,
        stock: x.r.stock, cands: x.r.candidates, title: String(x.r.title || "").slice(0, 40) }
    : { n: x.name, status: x.status, note: x.note });
})().catch((e) => { out.textContent = "HARNESS ERROR: " + e.message;
                    window.__RESULT__ = { error: e.message }; });
