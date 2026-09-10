// Runs in the page context via chrome.scripting.executeScript({ files: [...] }),
// and against fetched HTML through a DOMParser document. The completion value of
// this IIFE is returned as injectionResults[0].result.
//
// Layers, first confident hit wins:
//   1 JSON-LD, including offers nested in hasVariant / isVariantOf
//   2 state blobs (__NEXT_DATA__ / __NUXT_DATA__ / __APOLLO_STATE__)
//   3 meta tags and microdata
//   4 a DOM heuristic, scoped to the product region so carousels can't win
//
// Every reading carries `via` (which layer), `conf` (high|medium|low) and `raw`
// (the string we parsed), so a wrong reading can be traced and quarantined later.
(() => {
  const DOC = typeof __PT_DOC__ !== "undefined" ? __PT_DOC__ : document;
  const HREF = typeof __PT_URL__ !== "undefined" ? __PT_URL__ : location.href;
  // A document parsed from fetched HTML has no window, so it has no layout:
  // every element would read as "hidden" and every style as empty. Visibility
  // and strikethrough tests only mean something on a rendered page.
  const VIEW = DOC && DOC.defaultView;
  const LIVE = !!VIEW;
  let PAGE;
  try { PAGE = new URL(HREF); } catch (e) { PAGE = { pathname: "", searchParams: new URLSearchParams() }; }

  // --- number parsing ---------------------------------------------------------
  // Delegates to ldparse.js so the page path and the worker's fetch path share
  // one parser. The fallback only matters if ldparse failed to inject, which
  // the build check now prevents.
  const MULTI = { allowMultiple: true };
  function parsePrice(v, opts) {
    if (LD) return LD.parsePrice(v, opts);
    if (v == null) return null;
    const m = String(v).replace(/[^\d.,]/g, "").match(/\d+(?:[.,]\d{1,2})?/);
    const n = m ? parseFloat(m[0].replace(",", ".")) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  const str = (v) => (v == null ? "" : String(v)).trim();

  // --- JSON-LD ----------------------------------------------------------------
  // Offer collection and variant scoring live in ldparse.js so the service
  // worker's fetch path runs the identical logic without a DOM. That file is
  // injected alongside this one.
  const LD = typeof PTLd !== "undefined" ? PTLd : null;

  function fromJsonLd() {
    if (!LD) return null;
    const texts = [];
    for (const b of DOC.querySelectorAll('script[type="application/ld+json"]')) {
      texts.push(b.textContent);
    }
    const all = LD.offersFrom(texts, DOC.title);
    const c = LD.pickForPage(all, HREF, canonicalUrl(), declaredPrices());
    if (!c) return null;
    return Object.assign({}, c, {
      via: all.length > 1 ? "jsonld-variant" : "jsonld",
      candidates: all.length
    });
  }

  // What the page says its own price is, in its own voice. This is what turns
  // a tie between variant offers into an answer instead of a guess.
  //
  // The meta tag first: it is a single authoritative field, and a store that
  // publishes one has told us which of its variants this page is about.
  // Failing that, the money actually printed in the product region — the
  // number the shopper is looking at. Both are independent of the JSON-LD, so
  // agreement between them and an offer is real corroboration.
  function declaredPrices() {
    const meta = parsePrice(
      metaContent('meta[property="product:price:amount"]') ||
      metaContent('meta[property="og:price:amount"]'), MULTI);
    if (meta != null && meta > 0) return [meta];
    return visiblePrices();
  }

  // Money printed inside the product region. Deliberately reuses the same
  // filters as the DOM heuristic — noise sections, non-money text, per-month
  // financing — so a hint can never come from somewhere the heuristic itself
  // would refuse to look.
  function visiblePrices() {
    let root;
    try { root = productRoot(); } catch (e) { return []; }
    if (!root || !root.querySelectorAll) return [];
    const out = [];
    for (const el of root.querySelectorAll(PRICE_SEL)) {
      if (LIVE && el.offsetParent === null &&
          (!el.getClientRects || el.getClientRects().length === 0)) continue;
      if (isNoise(el)) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 120) continue;
      if (EXCLUDE_RE.test(txt) || !MONEY_TEXT_RE.test(txt)) continue;
      const p = parsePrice(txt);
      if (p != null && p > 0) out.push(p);
    }
    return out;
  }

  // --- state blobs ------------------------------------------------------------
  // Nuxt/Next/Apollo apps often ship the price in a JSON island even when the
  // markup is built client-side. We only trust a blob when a single plausible
  // price key is present, so this never becomes a guessing game.
  function fromStateBlob() {
    const ids = ["__NEXT_DATA__", "__NUXT_DATA__"];
    for (const id of ids) {
      const el = DOC.getElementById(id);
      if (!el || !el.textContent) continue;
      let data;
      try { data = JSON.parse(el.textContent); } catch (e) { continue; }
      const hit = findPriceIn(data);
      if (hit) return { price: hit.price, raw: String(hit.raw), list: hit.list, currency: hit.currency || "",
                        title: DOC.title, image: "", stock: "", sku: "", color: "", size: "",
                        via: "state-blob", conf: "medium", candidates: 1 };
    }
    return null;
  }

  // Look for an object that carries a price alongside a currency, which is a
  // much stronger signal than a bare number called "price".
  function findPriceIn(root) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const n = stack.shift();
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n)) { for (const v of n) if (v && typeof v === "object") stack.push(v); continue; }
      const keys = Object.keys(n);
      const cur = n.currency || n.currencyCode || n.priceCurrency;
      const amount = n.price != null ? n.price : (n.amount != null ? n.amount : n.value);
      if (cur && amount != null) {
        const p = parsePrice(amount, MULTI);
        if (p != null && p > 0) {
          const list = parsePrice(n.compareAtPrice || n.listPrice || n.was || n.originalPrice, MULTI);
          return { price: p, raw: amount, currency: String(cur), list: list && list > p ? list : null };
        }
      }
      for (const k of keys) { const v = n[k]; if (v && typeof v === "object") stack.push(v); }
    }
    return null;
  }

  // --- meta / microdata -------------------------------------------------------
  function metaContent(sel) {
    const el = DOC.querySelector(sel);
    return (el && (el.content || el.getAttribute("content"))) || "";
  }

  function fromMeta() {
    const sel = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]'
    ];
    for (const s of sel) {
      const raw = metaContent(s);
      const price = parsePrice(raw, MULTI);
      if (price != null && price > 0) {
        return { price, raw: str(raw), list: null,
          currency: metaContent('meta[property="product:price:currency"]') ||
                    metaContent('meta[property="og:price:currency"]') || "",
          title: DOC.title, image: "", stock: "", sku: "", color: "", size: "",
          via: "meta", conf: "medium", candidates: 1 };
      }
    }
    return null;
  }

  function fromItemprop() {
    const el = DOC.querySelector('[itemprop="price"]');
    if (!el) return null;
    const raw = el.getAttribute("content") || el.textContent;
    const price = parsePrice(raw, MULTI);
    if (price == null || price <= 0) return null;
    return { price, raw: str(raw), list: null, currency: "", title: DOC.title,
      image: "", stock: "", sku: "", color: "", size: "",
      via: "microdata", conf: "medium", candidates: 1 };
  }

  // --- scoped DOM heuristic ---------------------------------------------------
  const NOISE_RE = /you may also like|recommend|related|similar|complete the look|customers also|pairs with|more from|recently viewed|others bought|you might|trending|bestseller/i;

  function isNoise(el) {
    for (let n = el, hops = 0; n && hops < 12; n = n.parentElement, hops++) {
      const label = ((n.getAttribute && (n.getAttribute("aria-label") || n.getAttribute("data-testid"))) || "") +
                    " " + (n.className || "") + " " + (n.id || "");
      if (NOISE_RE.test(String(label))) return true;
      // A heading inside the section names it.
      if (n.querySelector) {
        const head = n.querySelector(":scope > h2, :scope > h3, :scope > header h2");
        if (head && NOISE_RE.test(head.textContent || "")) return true;
      }
    }
    return false;
  }

  // Class and id first, then the automation hooks. A store that hashes its
  // class names to `ld_Ec` still ships stable `data-testid` attributes,
  // because its own QA depends on them — which makes them a better bet than
  // the class names, not a worse one. Walmart's price carries none of the
  // usual class hints and three separate data attributes naming it.
  const PRICE_SEL = '[class*="price" i],[id*="price" i],' +
    '[data-test*="price" i],[data-testid*="price" i],[data-test-id*="price" i],' +
    '[data-automation-id*="price" i],[itemprop="price"]';
  // Above this, an ancestor has stopped being "the product" and has started
  // being "the page": on.com's fifth ancestor from the title held 58 price
  // nodes, nearly all of them accessories in a carousel.
  const CROWDED = 6;

  // The control that buys the thing. On a deeply nested storefront this is a
  // far better landmark than the title: Walmart's h1 sits 32 hops from its own
  // price, while the Add to cart button sits 8 away. The price is next to the
  // button that charges it, which is the one arrangement every shop agrees on.
  const BUY_RE = /^\s*(?:add to (?:cart|bag|basket)|buy now|add to trolley)/i;

  function buyControl(scope) {
    const where = scope || DOC;
    if (!where.querySelectorAll) return null;
    for (const el of where.querySelectorAll('button,[role="button"],input[type="submit"]')) {
      const label = ((el.textContent || "") + " " +
                     (el.getAttribute("aria-label") || "") + " " +
                     (el.getAttribute("value") || "")).trim();
      if (BUY_RE.test(label)) return el;
    }
    return null;
  }

  // Climb from a landmark until prices appear, then stop before the branch
  // turns into the whole page.
  function climbFrom(start, limit) {
    let best = null;
    for (let n = start && start.parentElement, hops = 0; n && hops < limit;
         n = n.parentElement, hops++) {
      const found = n.querySelectorAll(PRICE_SEL).length;
      if (!found) continue;
      // The first ancestor that sees any price is the tightest useful scope.
      if (!best) best = n;
      // Keep widening only while the neighbourhood stays small enough to be
      // about one product; the moment it balloons, keep what we had.
      if (found > CROWDED) break;
      best = n;
    }
    return best;
  }

  // Elements that might be naming the product. An `<h1>` usually is, but not
  // always — Amazon's reads "Product summary presents key product information"
  // and exists for screen readers, while the real title sits in a span.
  const TITLE_SEL = 'h1,[itemprop="name"],#productTitle,[id*="productTitle" i],' +
    '[data-testid*="product-title" i],[data-test*="product-title" i]';

  // The heading the page agrees with. A document title is written to name the
  // thing being sold, so the element whose text turns up inside it is the one
  // naming the product. That single check tells Amazon's real title from its
  // accessibility heading without knowing anything about Amazon.
  function titleElement() {
    const h1 = DOC.querySelector("h1");
    const docTitle = String(DOC.title || "").toLowerCase();
    if (!docTitle) return h1;
    for (const el of DOC.querySelectorAll(TITLE_SEL)) {
      const text = (el.textContent || "").trim();
      if (text.length < 10 || text.length > 300) continue;
      if (docTitle.includes(text.toLowerCase().slice(0, 60))) return el;
    }
    return h1;
  }

  function priceCount(el) {
    return el && el.querySelectorAll ? el.querySelectorAll(PRICE_SEL).length : Infinity;
  }

  // Of two candidate regions, the one holding fewer prices is the one more
  // likely to be about a single product.
  function tighter(a, b) {
    if (!a) return b;
    if (!b) return a;
    return priceCount(b) < priceCount(a) ? b : a;
  }

  // Narrow the search to the region that describes THIS product, and say which
  // landmark anchored it — the ranking below measures distance from whichever
  // one actually found the region.
  function productScope() {
    const typed = DOC.querySelector('[itemtype*="Product" i]');
    if (typed) return { root: typed, anchor: titleElement() || typed };

    // Two landmarks, and neither is reliable alone. The title is the most
    // direct statement of what a page is about, and every fixture here leans
    // on it. The buy control wins where the markup is too deep for the title
    // to reach, as on a React storefront.
    const title = titleElement();
    const byTitle = title ? climbFrom(title, 8) : null;
    const buy = buyControl(DOC);
    const byBuy = buy ? climbFrom(buy, 10) : null;

    // Take whichever found the tighter region rather than whichever was tried
    // first. Climbing from Amazon's title lands on the whole product page —
    // 358 of its 413 prices — and ranking by distance inside that is a
    // lottery. The buy box is a fraction of the size.
    const best = tighter(byTitle, byBuy);
    if (best) {
      return { root: best, anchor: best === byBuy && buy ? buy : (title || buy) };
    }

    const fallback = DOC.querySelector("main") || DOC.body || DOC;
    return { root: fallback, anchor: title || fallback };
  }

  function productRoot() {
    return productScope().root;
  }

  // How far apart two nodes sit in the tree. The real price is a near neighbour
  // of the product title; a carousel price is many hops away through a shared
  // ancestor. Cheapness says nothing — the cheapest thing on a shoe page is a
  // sock — so distance is the signal we rank on.
  function hopsBetween(a, b) {
    if (!a || !b) return 99;
    const chain = [];
    for (let n = a, i = 0; n && i < 40; n = n.parentElement, i++) chain.push(n);
    for (let n = b, down = 0; n && down < 40; n = n.parentElement, down++) {
      const up = chain.indexOf(n);
      if (up >= 0) return up + down;
    }
    return 99;
  }

  const ORIGINAL_RE = /was|original|list|msrp|regular|compare|strike|through|retail|old|before/i;
  const SALE_RE = /sale|now|current|final|deal|reduced|special/i;
  // Either a currency marker, or an amount written with cents. A bare integer
  // in a "price"-ish container is far more often a size, a capacity or a count.
  const MONEY_TEXT_RE = /[$€£¥₹₩]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|INR|KRW)\b|\d[.,]\d{2}(?!\d)/i;
  // Money that is not this product's price: a discount, a delivery charge, a
  // financing instalment, or a unit rate. Walmart prints "$25.00/qt" beside
  // the real price, and a shelf rate is not what anyone is tracking.
  const EXCLUDE_RE = /save|off\b|shipping|coupon|each|per\s|\/\s*(mo|month|yr|year|oz|qt|lb|kg|g|ml|l|ct|ea|sq\s?ft|ft)\b|installment|afterpay|klarna|affirm/i;

  // A category, search or collection page is full of prices, none of which is
  // "this page's price". Tier 1 already refuses when many offers exist and none
  // claims the page; this stops the DOM scan from stepping in and picking one
  // anyway. Structured evidence decides, and the URL only reinforces it — some
  // product pages carry no id in the path at all.
  function looksLikeShelf() {
    if (!LD) return false;
    const texts = [];
    for (const b of DOC.querySelectorAll('script[type="application/ld+json"]')) texts.push(b.textContent);

    const offers = LD.offersFrom(texts, "");
    // Something on the page claims to be the page's own product: not a shelf.
    // Ask whether an offer *claims* the page, not whether we could read a
    // price off it. A variant page whose offers disagree about the money is
    // still unambiguously one product — reading a refusal as evidence of a
    // category page would send the heuristic away exactly when it is needed.
    if (LD.pageIsClaimed(offers, HREF, canonicalUrl())) return false;
    // Exactly one offer is one product, whatever else the page carries.
    if (offers.length === 1) return false;

    // Declared as a collection, and nothing claimed the page. Note a listing's
    // products often hang off ItemList.itemListElement, which we do not walk,
    // so this fires with zero offers found as readily as with many.
    if (LD.hasListingType(texts)) return true;
    // Several unclaimed offers is a shelf regardless of what it calls itself.
    if (offers.length > 3) return true;
    // Nothing structured to go on — fall back to the shape of the address.
    if (!offers.length && LD.urlLooksLikeListing(HREF)) return true;
    return false;
  }

  function isHidden(el) {
    return LIVE && el.offsetParent === null &&
      (!el.getClientRects || el.getClientRects().length === 0);
  }

  function isStruck(el) {
    if (LIVE) {
      try {
        return String(VIEW.getComputedStyle(el).textDecorationLine || "").includes("line-through");
      } catch (e) { return false; }
    }
    // No layout to consult, so fall back to what the markup declares.
    const style = el.getAttribute && el.getAttribute("style");
    return !!style && /line-through/i.test(style);
  }

  // Turn one element into a ranked candidate, or nothing.
  function candidateFrom(el, anchor) {
    if (isHidden(el)) return null;
    const txt = (el.textContent || "").trim();
    if (!txt || !/\d/.test(txt) || txt.length > 120) return null;
    if (EXCLUDE_RE.test(txt)) return null;
    // A class merely containing "price" proves nothing — Newegg's capacity
    // buttons carry `price-padding` and read "1TB", which is a 1 to a naive
    // parser. Text that claims to be money has to look like money.
    if (!MONEY_TEXT_RE.test(txt)) return null;
    const price = parsePrice(txt);
    if (price == null || price <= 0) return null;
    const key = String((el.className || "") + " " + (el.id || ""));
    return { price, raw: txt.slice(0, 40),
             original: isStruck(el) || ORIGINAL_RE.test(key),
             sale: SALE_RE.test(key), hops: hopsBetween(anchor, el) };
  }

  function fromHeuristic() {
    if (looksLikeShelf()) return null;
    const scope = productScope();
    const root = scope.root;
    const anchor = scope.anchor || root;
    const nodes = root.querySelectorAll(PRICE_SEL);
    const cands = [];
    for (const el of nodes) {
      if (isNoise(el)) continue;
      const c = candidateFrom(el, anchor);
      if (c) { cands.push(c); continue; }
      // The container held more than one number, so `parsePrice` refused it.
      // That is usually markup, not ambiguity: Walmart prints the dollars and
      // the cents in separate spans and adds a screen-reader copy alongside,
      // so the container reads "$4033current price $40.33". Ask the leaves,
      // each of which holds one price and nothing else.
      if (!el.querySelectorAll) continue;
      for (const leaf of el.querySelectorAll("*")) {
        if (leaf.children && leaf.children.length) continue;
        const lc = candidateFrom(leaf, anchor);
        if (lc) cands.push(lc);
      }
    }
    if (!cands.length) return null;

    // Nearest to the landmark wins — the title on a page built out of
    // headings, the buy control on one that is not. Among equally near
    // candidates, one explicitly marked as the sale price wins, then the
    // lower number.
    const byNearness = (a, b) => a.hops - b.hops ||
      (b.sale ? 1 : 0) - (a.sale ? 1 : 0) || a.price - b.price;
    const pool = cands.filter((c) => !c.original);
    const chosen = (pool.length ? pool : cands).slice().sort(byNearness)[0];
    // The struck-through original belongs to the same corner of the page as
    // the price we picked, so rank it the same way.
    const listed = cands.filter((c) => c.original && c.price > chosen.price)
      .sort((a, b) => a.hops - b.hops || a.price - b.price)[0];

    // Being clearly the closest candidate is the evidence. A tie at the same
    // distance means several prices sit equally near the title and we are back
    // to guessing, which the caller should treat as unproven.
    const rivals = pool.filter((c) => c.hops === chosen.hops && c.price !== chosen.price);
    const conf = rivals.length === 0 ? "medium" : "low";

    return { price: chosen.price, raw: chosen.raw, list: listed ? listed.price : null,
      currency: "", title: DOC.title, image: "", stock: "", sku: "", color: "", size: "",
      via: "heuristic", conf, candidates: cands.length };
  }

  // --- assemble ---------------------------------------------------------------
  function canonicalUrl() {
    const el = DOC.querySelector('link[rel="canonical"]');
    const href = el && el.getAttribute("href");
    if (!href) return HREF;
    try { return new URL(href, PAGE.origin || undefined).href; } catch (e) { return HREF; }
  }

  const found = fromJsonLd() || fromStateBlob() || fromMeta() || fromItemprop() || fromHeuristic();
  if (!found) return null;

  let host = "";
  try { host = new URL(HREF).hostname.replace(/^www\./, ""); } catch (e) {}

  return {
    price: found.price,
    list: found.list != null ? found.list : null,
    currency: found.currency || metaContent('meta[property="product:price:currency"]') || "",
    title: found.title || DOC.title,
    image: found.image || metaContent('meta[property="og:image"]') || "",
    stock: found.stock || "",
    sku: found.sku || "",
    color: found.color || "",
    size: found.size || "",
    seller: host,
    canonical: canonicalUrl(),
    via: found.via,
    conf: found.conf,
    raw: found.raw || "",
    candidates: found.candidates || 1
  };
})();
