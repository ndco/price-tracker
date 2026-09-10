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

  // ---- variant pages: corroboration, or refusal -----------------------------
  // Shapes measured on the live sites, 2026-09-07. In each one every offer
  // carries the page's own URL, so scoring alone cannot separate them. The old
  // code picked the cheapest and called it low confidence, which is how a
  // $169 jacket was tracked at $118.30 and a $79.95 one at $19.83.
  log("<h2>variant pages</h2>");

  const variantGroup = (url, rows) => ({
    "@context": "https://schema.org", "@type": "ProductGroup", url,
    name: "Better Sweater Fleece Jacket",
    hasVariant: rows.map((row, i) => ({
      "@type": "Product", sku: "SKU-" + i, color: row.color, size: row.size,
      name: "Better Sweater Fleece Jacket",
      offers: { "@type": "Offer", url, price: row.price, priceCurrency: "USD",
                availability: "https://schema.org/InStock" }
    }))
  });

  const bcRows = [];
  for (let i = 0; i < 36; i++) bcRows.push({ color: "Stonewash", size: "M", price: 169 });
  for (let i = 0; i < 6; i++) bcRows.push({ color: "Aquatic Blue", size: "L", price: 118.3 });
  const BC = "https://www.backcountry.com/patagonia-better-sweater-fleece-jacket-mens";

  // Backcountry publishes the price meta tag, and it names the price the page
  // is actually showing. That is a second, independent source.
  const bcPage = `<html><head><title>Better Sweater</title>
    <link rel="canonical" href="${BC}">
    <meta property="product:price:amount" content="169">
    <script type="application/ld+json">${JSON.stringify(variantGroup(BC, bcRows))}</script>
    </head><body><h1>Better Sweater Fleece Jacket</h1></body></html>`;
  const bc = await extract(bcPage, BC);
  check("meta tag corroborates one variant price", bc && bc.price, 169);
  check("corroborated variant reads as high confidence", bc && bc.conf, "high");

  // The same page without the meta tag, and with nothing on screen to check
  // against. Nothing can separate 169 from 118.30, so the JSON-LD layer must
  // stand down rather than pick one.
  const bcBare = `<html><head><title>Better Sweater</title>
    <link rel="canonical" href="${BC}">
    <script type="application/ld+json">${JSON.stringify(variantGroup(BC, bcRows))}</script>
    </head><body><h1>Better Sweater Fleece Jacket</h1></body></html>`;
  const bare = await extract(bcBare, BC);
  check("no corroboration anywhere -> no reading at all", bare, null);

  // REI: 170 offers at prices that are not the product's price, and no meta
  // tag. The displayed price is the only truth on the page, so the DOM
  // heuristic has to be allowed to answer — an ambiguous product page is not
  // a shelf, and must not be dismissed as one.
  const REI = "https://www.rei.com/product/235244/rei-co-op-trailmade-rain-jacket-mens";
  const reiRows = [];
  for (let i = 0; i < 170; i++) {
    reiRows.push({ color: "Black", size: "M", price: [19.83, 20.83, 34.83][i % 3] });
  }
  const reiPage = `<html><head><title>Trailmade Rain Jacket</title>
    <script type="application/ld+json">${JSON.stringify(variantGroup(REI, reiRows))}</script>
    </head><body><h1>REI Co-op Trailmade Rain Jacket</h1>
    <div class="pdp"><span class="price">$79.95</span></div></body></html>`;
  const rei = await extract(reiPage, REI);
  check("unreadable offers fall through to the displayed price", rei && rei.price, 79.95);
  check("and it is not one of the published offers",
        rei && [19.83, 20.83, 34.83].indexOf(rei.price) < 0, true);

  // The displayed price is itself corroboration when it names one of the
  // offers: then the JSON-LD layer can answer, with everything it knows.
  const seRows = [{ color: "A", size: "S", price: 19.2 }, { color: "B", size: "M", price: 24 },
                  { color: "C", size: "L", price: 25 }];
  const SE = "https://www.sephora.com/product/lip-sleeping-mask-P420652";
  const sePage = `<html><head><title>Lip Sleeping Mask</title>
    <script type="application/ld+json">${JSON.stringify(variantGroup(SE, seRows))}</script>
    </head><body><h1>Lip Sleeping Mask</h1>
    <div class="pdp"><span class="price">$24.00</span></div></body></html>`;
  const se = await extract(sePage, SE);
  check("the price on screen picks the matching offer", se && se.price, 24);
  check("and that is high confidence", se && se.conf, "high");
  check("with the variant's own details attached", se && se.sku, "SKU-1");

  // ---- storefronts with no semantic class names -----------------------------
  // Markup copied from the live pages on 2026-09-07. These sites hash their
  // class names, so nothing matches [class*="price"], and they nest the title
  // so far from the price that climbing from the h1 never reaches it. What
  // they do publish is automation hooks, and a buy button next to the price.
  log("<h2>hashed-class storefronts</h2>");

  // Wrap `inner` in `depth` anonymous divs, so a climb from the title cannot
  // reach the rest of the page inside its hop budget. Walmart's h1 sits 32
  // hops from its own price.
  const nest = (depth, inner) =>
    "<div>".repeat(depth) + inner + "</div>".repeat(depth);

  // The real Walmart price block, verbatim: dollars and cents in separate
  // spans, an aria-hidden visual copy, and a screen-reader sentence beside it.
  // The container therefore reads "$12995current price $129.95".
  const walmartPrice = `
    <div data-automation-id="product-price" class="mt1" data-test-id="gpt-global-product-price">
      <div class="flex flex-wrap justify-start items-baseline lh-title" data-test-id="gpt-price-flex-container">
        <div class="mr1 mr2-xl b black f7" aria-hidden="true" data-test-id="gpt-main-price-display">
          <span class="f7">$</span><span class="f4">129</span><span class="f7">95</span>
        </div>
        <span class="ld_Ec">current price $129.95</span>
      </div>
    </div>`;

  // A neutral-looking tile list, so only the buy-box scoping can save us —
  // the noise filter is deliberately given nothing to match on.
  const walmartTiles = ["40.33", "25.74", "6.92", "29.97", "49.97", "149.99"]
    .map((p) => `<div data-automation-id="product-price"><span class="ld_Ec">current price $${p}</span></div>`)
    .join("");

  const walmart = `<html><head><title>Instant Pot 6Qt DUO</title></head><body><main>
    ${nest(10, "<h1>Instant Pot 6Qt DUO 7-in-1 Multi-Cooker</h1>")}
    <div class="ld_A"><div class="ld_B">${walmartTiles}</div></div>
    <div class="ld_C"><div class="ld_D"><div data-testid="buyBox-container">
      ${walmartPrice}
      <div class="nearer-mid-gray">$25.00/qt</div>
      <button type="button">Add to cart</button>
    </div></div></div>
  </main></body></html>`;

  const wm = await extract(walmart, "https://www.walmart.com/ip/575389962");
  check("walmart price found with no price-shaped class name", wm && wm.price, 129.95);
  check("walmart via the DOM heuristic", wm && wm.via, "heuristic");
  check("walmart did not pick a cheaper tile", wm && wm.price > 100, true);
  check("walmart ignored the per-unit rate", wm && wm.price !== 25, true);

  // The split spans must not become candidates of their own: "$129" and "95"
  // are halves of a price, and "$12995" is neither.
  check("walmart did not read the split spans as prices",
        wm && [129, 95, 12995].indexOf(wm.price) < 0, true);

  // Target hashes its classes too, but the hash keeps the word: the class is
  // `styles_currentPriceFontSize__qSy6z`, and there is a data-test hook.
  const target = `<html><head><title>Stanley Quencher</title></head><body><main>
    <h1>Stanley 40 oz Quencher Tumbler</h1>
    <div class="styles_wrap__a1b">
      <span data-test="product-price" class="styles_currentPriceFontSize__qSy6z">$45.00</span>
    </div>
    <div><span>$RC("B:1","S:1")</span></div>
    <button type="button">Add to cart</button>
  </main></body></html>`;
  const tg = await extract(target, "https://www.target.com/p/-/A-88429520");
  check("target price found", tg && tg.price, 45);
  check("target ignored the streaming placeholder", tg && tg.price !== 1, true);

  // A page whose only price hook is a data attribute, with no buy button and
  // no useful title position, still must not invent a number from nothing.
  const nothing = `<html><head><title>Mystery</title></head><body><main>
    ${nest(10, "<h1>Mystery Item</h1>")}
    <div><span>ships in 2-3 days</span></div>
  </main></body></html>`;
  check("no money anywhere -> null",
        await extract(nothing, "https://shop.test/products/mystery-1234"), null);

  // ---- when the <h1> is not the product title -------------------------------
  // Amazon's h1 reads "Product summary presents key product information" and
  // exists for screen readers; the real title is a span. Climbing from that h1
  // reached the whole product page — 358 of its 413 price nodes — and ranking
  // by distance inside that picked $83.99 off a page selling at $119.99.
  log("<h2>pages whose h1 is not the title</h2>");

  const decoys = ["83.99", "21.99", "29.99", "16.99", "47.50", "12.00", "9.99"]
    .map((p) => `<div class="a-price"><span class="a-offscreen">$${p}</span></div>`).join("");

  const amazonish = `<html><head>
    <title>Shop.com: Heavy Duty Carbon Steel Microwave Stand, 2-Tier Adjustable</title>
    </head><body><div id="dp">
      <h1 class="a-sr-only">Product summary presents key product information. Keyboard shortcuts available.</h1>
      <span id="productTitle">Heavy Duty Carbon Steel Microwave Stand, 2-Tier Adjustable</span>
      <div class="sims">${decoys}</div>
      <div id="buybox">
        <div class="a-price apex-core-price">
          <span class="a-offscreen">$119.99</span>
          <span class="a-price-symbol">$</span><span class="a-price-whole">119.</span><span class="a-price-fraction">99</span>
        </div>
        <button type="button">Add to Cart</button>
      </div>
      <div class="more">${decoys}</div>
    </div></body></html>`;

  const az = await extract(amazonish, "https://shop.test/dp/B0H1PX5M1S/");
  check("the price agrees with the buy box, not a cheaper decoy", az && az.price, 119.99);
  check("no decoy from elsewhere on the page wins",
        az && [83.99, 21.99, 29.99, 16.99, 47.50, 12.00, 9.99].indexOf(az.price) < 0, true);
  check("the split whole/fraction spans are not read as prices",
        az && [119, 99, 11999].indexOf(az.price) < 0, true);

  // The same page with a title that genuinely names the product: behaviour
  // must not change, because the title is still the better landmark.
  const plain = `<html><head><title>Microwave Stand — Shop</title></head><body>
    <div class="pdp">
      <h1>Microwave Stand</h1>
      <span class="price">$119.99</span>
      <button type="button">Add to Cart</button>
    </div>
    <div class="sims">${decoys}</div>
  </body></html>`;
  const pl = await extract(plain, "https://shop.test/products/microwave-stand-1234");
  check("an honest h1 still anchors the search", pl && pl.price, 119.99);

  log(`<h2 class="${fail ? "fail" : "pass"}">${pass} passed, ${fail} failed</h2>`);
  window.__RESULT__ = { pass, fail };
})().catch(e => { log(`<div class="fail">HARNESS ERROR: ${e && e.message}</div>`);
                  window.__RESULT__ = { pass, fail, error: String(e && e.message) }; });
