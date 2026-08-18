const out = document.getElementById("out");
let pass = 0, fail = 0;
const log = (h) => { out.insertAdjacentHTML("beforeend", h); };

function check(name, got, want) {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  log(`<div class="${okv ? "pass" : "fail"}">${okv ? "PASS" : "FAIL"} <span class="name">${name}</span>` +
      (okv ? "" : ` — got <b>${JSON.stringify(got)}</b>, want <b>${JSON.stringify(want)}</b>`) + `</div>`);
}

// Run the real extension file against a parsed fixture document.
let SRC = null, LDSRC = null;
async function extract(html, url) {
  if (!LDSRC) { LDSRC = await (await fetch("/price-tracker/ldparse.js")).text(); (0, eval)(LDSRC); }
  if (!SRC) SRC = await (await fetch("/price-tracker/inject-extract.js")).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  window.__PT_DOC__ = doc;
  window.__PT_URL__ = url;
  try { return eval(SRC); } finally { delete window.__PT_DOC__; delete window.__PT_URL__; }
}

const F = {};
// Fixtures are captured pages and are not committed (see .gitignore). When they
// are missing, say so and skip those checks rather than failing on a 404 body.
async function load(n) {
  if (n in F) return F[n];
  try {
    const r = await fetch("/fixtures/" + n);
    const body = r.ok ? await r.text() : "";
    F[n] = body.length > 2000 ? body : null;
  } catch (e) { F[n] = null; }
  return F[n];
}
function skipped(name) {
  log(`<div class="name">SKIP ${name} — run <b>bash test/capture-fixtures.sh</b> first</div>`);
}

(async () => {
  out.innerHTML = "";

  // ---- on.com: the reported failure ---------------------------------------
  log("<h2>on.com — offers nested in ProductGroup.hasVariant</h2>");
  const onHtml = await load("on-com.html");
  if (!onHtml) skipped("on.com fixture"); else {
  const on = await extract(onHtml,
    "https://www.on.com/en-us/products/cloud-sky-3YD1144/unisex/black-eclipse-shoes-3YD11440106?variant=6&utm_source=google&gclid=abc");
  log(`<pre>${JSON.stringify(on, null, 1)}</pre>`);
  check("on.com price is the sale price", on && on.price, 75);
  check("on.com list is the ListPrice", on && on.list, 110);
  check("on.com picked the right SKU", on && on.sku, "3YD11440106");
  check("on.com colour", on && on.color, "Black | Eclipse");
  check("on.com currency", on && on.currency, "USD");
  check("on.com via", on && on.via, "jsonld-variant");
  check("on.com confidence", on && on.conf, "high");
  check("on.com saw all 5 variants", on && on.candidates, 5);

  // a different variant of the SAME page must resolve differently
  const on2 = await extract(onHtml,
    "https://www.on.com/en-us/products/cloud-sky-3YD1144/unisex/dustrose-terra-shoes-3YD11443992");
  check("on.com second variant price", on2 && on2.price, 65);
  check("on.com second variant sku", on2 && on2.sku, "3YD11443992");
  }

  // ---- zappos: single offer, and the variant the page actually served ------
  log("<h2>zappos — page served a different colour than requested</h2>");
  const zHtml = await load("zappos.html");
  if (!zHtml) skipped("zappos fixture"); else {
  const z = await extract(zHtml,
    "https://www.zappos.com/p/womens-allbirds-wool-runner-hazy-indigo-blizzard/product/9973596/color/1090604");
  log(`<pre>${JSON.stringify(z, null, 1)}</pre>`);
  check("zappos price", z && z.price, 110);
  check("zappos sku", z && z.sku, "9973596");
  check("zappos colour is what the page served", z && z.color, "Dapple Grey (Cream)");
  check("zappos confidence", z && z.conf, "high");
  }

  // ---- allbirds: 14 size variants, one URL, all the same price -------------
  log("<h2>allbirds — 14 size variants at one URL, all $105</h2>");
  const aHtml = await load("allbirds.html");
  if (!aHtml) skipped("allbirds fixture"); else {
  const a = await extract(aHtml, "https://www.allbirds.com/products/mens-cruiser-medium-grey");
  log(`<pre>${JSON.stringify(a, null, 1)}</pre>`);
  check("allbirds price", a && a.price, 105);
  check("allbirds not marked ambiguous (tie, same price)", a && a.conf, "high");
  check("allbirds saw every variant", a && a.candidates, 15);
  }

  // ---- synthetic edge cases ------------------------------------------------
  log("<h2>edge cases</h2>");
  const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script>
    </head><body><h1>x</h1></body></html>`;

  const tie = await extract(ld([
    { "@type": "Product", name: "A", offers: { "@type": "Offer", price: 10, priceCurrency: "USD" } },
    { "@type": "Product", name: "B", offers: { "@type": "Offer", price: 99, priceCurrency: "USD" } }
  ]), "https://shop.test/p/unknown");
  // Two unclaimed offers that disagree about the money is a shelf, not a
  // product with an uncertain price. Refusing beats guessing.
  check("two offers, no match, different prices -> refuse", tie, null);

  const sameTie = await extract(ld([
    { "@type": "Product", name: "A", offers: { "@type": "Offer", price: 10, priceCurrency: "USD" } },
    { "@type": "Product", name: "B", offers: { "@type": "Offer", price: 10, priceCurrency: "USD" } }
  ]), "https://shop.test/p/unknown");
  check("two offers, same price -> high conf", sameTie && sameTie.conf, "high");

  const nested = await extract(ld({
    "@type": "ProductGroup", name: "G",
    hasVariant: [{ "@type": "Product", sku: "SKU-9", offers: { price: "42.50", priceCurrency: "EUR" } }]
  }), "https://shop.test/p/SKU-9");
  check("hasVariant with one variant", nested && nested.price, 42.5);
  check("hasVariant currency", nested && nested.currency, "EUR");

  const graph = await extract(ld({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "ProductGroup", hasVariant: [
      { "@type": "Product", sku: "Z1", offers: { price: 7, priceCurrency: "USD" } }] }]
  }), "https://shop.test/p/Z1");
  check("@graph + hasVariant together", graph && graph.price, 7);

  const none = await extract("<html><body><p>no products here</p></body></html>", "https://shop.test/x");
  check("page with no price returns null", none, null);

  const bad = await extract(`<html><head><script type="application/ld+json">{oops</script></head>
    <body><span class="price">$19.99</span></body></html>`, "https://shop.test/p/1");
  check("malformed JSON-LD falls through to heuristic", bad && bad.price, 19.99);

  // carousel noise must not win
  const noisy = `<html><body><h1>Real Product</h1>
    <div class="pdp"><span class="price">$75.00</span>
      <span class="price-original" style="text-decoration:line-through">$110.00</span></div>
    <section aria-label="You may also like">
      <span class="price">$9.99</span><span class="price">$12.99</span></section>
    </body></html>`;
  const nz = await extract(noisy, "https://shop.test/p/real");
  check("heuristic ignores the recommendations carousel", nz && nz.price, 75);
  check("heuristic keeps the struck-through list price", nz && nz.list, 110);

  // ---- shelf pages: a category/search page has prices but no price ----------
  log("<h2>listing pages must refuse, not pick an item</h2>");

  const shelf = await extract(ld({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "ItemList", itemListElement: [] },
      { "@type": "Product", name: "Shoe A", offers: { "@type": "Offer", price: 180, priceCurrency: "USD",
        url: "https://shop.test/products/a-1111" } },
      { "@type": "Product", name: "Shoe B", offers: { "@type": "Offer", price: 150, priceCurrency: "USD",
        url: "https://shop.test/products/b-2222" } },
      { "@type": "Product", name: "Shoe C", offers: { "@type": "Offer", price: 220, priceCurrency: "USD",
        url: "https://shop.test/products/c-3333" } }
    ]
  }), "https://shop.test/shop/shoes");
  check("category page with many unclaimed offers -> null", shelf, null);

  // the same markup, but the page IS one of those products
  const pdp = await extract(ld({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "ItemList", itemListElement: [] },
      { "@type": "Product", name: "Shoe A", offers: { "@type": "Offer", price: 180, priceCurrency: "USD",
        url: "https://shop.test/products/a-1111" } },
      { "@type": "Product", name: "Shoe B", offers: { "@type": "Offer", price: 150, priceCurrency: "USD",
        url: "https://shop.test/products/b-2222" } }
    ]
  }), "https://shop.test/products/a-1111");
  check("product page with a related-items carousel still extracts", pdp && pdp.price, 180);

  // one product plus a carousel: still a product page
  const oneOffer = await extract(ld({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "ItemList", itemListElement: [] },
      { "@type": "Product", name: "Only", offers: { "@type": "Offer", price: 42, priceCurrency: "USD" } }
    ]
  }), "https://shop.test/whatever");
  check("single offer beside an ItemList still extracts", oneOffer && oneOffer.price, 42);

  // no structured data at all, listing-shaped URL, plenty of price nodes
  const bareShelf = await extract(`<html><body><h1>Shoes</h1>
    <div class="tile"><span class="price">$180.00</span></div>
    <div class="tile"><span class="price">$150.00</span></div>
    <div class="tile"><span class="price">$220.00</span></div></body></html>`,
    "https://shop.test/en-us/shop/shoes");
  check("listing-shaped URL with no structured data -> null", bareShelf, null);

  // the same markup on a product-shaped URL should still work
  const bareProduct = await extract(`<html><body><h1>One Shoe</h1>
    <div class="pdp"><span class="price">$180.00</span></div></body></html>`,
    "https://shop.test/products/one-shoe-1234");
  check("product-shaped URL with only DOM prices still extracts", bareProduct && bareProduct.price, 180);

  log(`<h2 class="${fail ? "fail" : "pass"}">${pass} passed, ${fail} failed</h2>`);
  window.__RESULT__ = { pass, fail };
})().catch(e => { log(`<div class="fail">HARNESS ERROR: ${e && e.message}</div>`);
                  window.__RESULT__ = { pass, fail, error: String(e && e.message) }; });
