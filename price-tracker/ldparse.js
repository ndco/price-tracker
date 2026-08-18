// JSON-LD offer parsing with no DOM dependency, so the same logic serves both
// the injected page script and the service worker's fetch path (a worker has
// no DOMParser). Callers hand it the raw text of each ld+json block.
(function (root) {
  "use strict";

  function str(v) { return (v == null ? "" : String(v)).trim(); }

  function toNumber(token) {
    let num = token;
    if (num.includes(",") && num.includes(".")) {
      num = num.lastIndexOf(",") > num.lastIndexOf(".")
        ? num.replace(/\./g, "").replace(",", ".")
        : num.replace(/,/g, "");
    } else if (num.includes(",")) {
      num = /,\d{3}\b/.test(num) ? num.replace(/,/g, "") : num.replace(",", ".");
    }
    const val = parseFloat(num);
    return Number.isFinite(val) ? val : null;
  }

  const MULTI = { allowMultiple: true };
  const MONEY_RE = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

  // A single price, or nothing. Text holding two prices — a container that
  // wraps both the sale and the original, like "$14.00$30.00" — is refused
  // rather than guessed at: stripping the symbols first would turn that into
  // "14.0030.00" and read ".003" as a thousands group, inventing 14.003.
  // Callers also scan the leaf nodes, so the container declining to answer
  // simply lets the specific element win.
  function parsePrice(input, opts) {
    if (input == null) return null;
    // Some stores put the cents in their own element, so the text arrives as
    // "$ 388 .99". Rejoin those before splitting, or the halves read as two
    // separate prices and the whole thing looks ambiguous.
    const raw = String(input).replace(/(\d)\s+([.,]\d{1,2})(?!\d)/g, "$1$2");
    // Keep the symbols while splitting so adjacent amounts stay separate.
    const tokens = raw.replace(/[^\d.,\s]/g, " ").match(MONEY_RE) || [];
    if (!tokens.length) return null;

    const values = [];
    for (const t of tokens) {
      const v = toNumber(t);
      if (v != null && v > 0) values.push(v);
    }
    if (!values.length) return null;

    const distinct = Array.from(new Set(values));
    // Structured data is a single field by definition, so a lone value there
    // is safe even when the string is odd. Only free DOM text is ambiguous.
    if (distinct.length > 1 && !(opts && opts.allowMultiple)) return null;
    return distinct.length > 1 ? Math.min.apply(null, distinct) : distinct[0];
  }

  function listPriceOf(off, node) {
    const specs = off.priceSpecification
      ? (Array.isArray(off.priceSpecification) ? off.priceSpecification : [off.priceSpecification])
      : [];
    for (const sp of specs) {
      if (!sp) continue;
      if (/MSRP|ListPrice|List/i.test(str(sp.priceType))) {
        const lp = parsePrice(sp.price, MULTI);
        if (lp != null) return lp;
      }
    }
    if (off.highPrice != null) { const hp = parsePrice(off.highPrice, MULTI); if (hp != null) return hp; }
    if (node && node.listPrice != null) { const lp = parsePrice(node.listPrice, MULTI); if (lp != null) return lp; }
    return null;
  }

  function stockOf(off) {
    const raw = str(off && off.availability);
    if (!raw) return "";
    if (/OutOfStock|SoldOut|Discontinued/i.test(raw)) return "out";
    if (/LimitedAvailability|LowStock|BackOrder/i.test(raw)) return "low";
    if (/InStock|InStoreOnly|OnlineOnly|PreOrder/i.test(raw)) return "in";
    return "";
  }

  function imageOf(node) {
    const img = node && node.image;
    if (!img) return "";
    const first = Array.isArray(img) ? img[0] : img;
    if (!first) return "";
    const url = typeof first === "string" ? first : first.url || first.contentUrl || "";
    return typeof url === "string" ? url : "";
  }

  function sizeOf(node) {
    const s = node.size || null;
    if (typeof s === "string") return s.trim();
    if (s && typeof s === "object") return str(s.name || s.value);
    const props = node.additionalProperty
      ? (Array.isArray(node.additionalProperty) ? node.additionalProperty : [node.additionalProperty])
      : [];
    for (const p of props) if (p && /size/i.test(str(p.name))) return str(p.value);
    return "";
  }

  // Flatten every offer in the supplied ld+json blocks, descending @graph and
  // the variant nestings a ProductGroup uses.
  function offersFrom(jsonTexts, fallbackTitle) {
    const cands = [];
    for (const text of jsonTexts) {
      let data;
      try { data = JSON.parse(String(text).trim()); } catch (e) { continue; }
      const stack = Array.isArray(data) ? [...data] : [data];
      let guard = 0;
      while (stack.length && guard++ < 5000) {
        const node = stack.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) stack.push(...node["@graph"]);
        if (node.hasVariant) {
          stack.push(...(Array.isArray(node.hasVariant) ? node.hasVariant : [node.hasVariant]));
        }
        if (node.isVariantOf && typeof node.isVariantOf === "object") stack.push(node.isVariantOf);
        if (!node.offers) continue;

        const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
        for (const off of offers) {
          if (!off || typeof off !== "object") continue;
          const rawPrice = off.price != null ? off.price : off.lowPrice;
          const price = parsePrice(rawPrice, MULTI);
          if (price == null || price <= 0) continue;
          const list = listPriceOf(off, node);
          cands.push({
            price,
            raw: str(rawPrice),
            list: list != null && list > price ? list : null,
            currency: str(off.priceCurrency || node.priceCurrency),
            title: str(node.name) || fallbackTitle || "",
            image: imageOf(node),
            stock: stockOf(off),
            sku: str(node.sku || node.mpn || off.sku),
            color: str(node.color),
            size: sizeOf(node),
            url: str(off.url || node.url)
          });
        }
      }
    }
    return cands;
  }

  function pathOf(u, base) {
    try { return new URL(u, base || undefined).pathname; } catch (e) { return ""; }
  }

  // A product URL names one thing, usually through a segment like /product/ or
  // /dp/ followed by an id. A shelf URL names a section instead.
  const PRODUCT_PATH_RE = /\/(?:product|products|p|dp|ip|item|itm|prod|sku|pd|gp\/product)\//i;
  const PRODUCT_ID_RE = /\/[A-Za-z0-9][A-Za-z0-9._-]*\d{4,}[A-Za-z0-9._-]*(?:\/|\.html?|$)/;
  const LISTING_PATH_RE = /\/(?:shop|category|categories|c|collections|browse|search|results|catalog|department|deals|sale|clearance|new-arrivals|bestsellers|all)(?:\/|$)/i;

  // "Does this URL point at one item?" Shopify's /collections/x/products/y is a
  // product despite the collection segment, so a product marker always wins.
  function urlLooksLikeProduct(href) {
    let p = "";
    try { p = new URL(href).pathname; } catch (e) { p = String(href || ""); }
    if (PRODUCT_PATH_RE.test(p)) return true;
    if (LISTING_PATH_RE.test(p)) return false;
    return PRODUCT_ID_RE.test(p);
  }

  function urlLooksLikeListing(href) {
    let p = "";
    try { p = new URL(href).pathname; } catch (e) { p = String(href || ""); }
    if (PRODUCT_PATH_RE.test(p)) return false;
    return LISTING_PATH_RE.test(p) || p === "/" || p === "";
  }

  // Structured data that describes a collection of things. A product page can
  // carry one too — a "you may also like" carousel is an ItemList — so on its
  // own this proves nothing; it only matters when no offer claims the page.
  const LIST_TYPE_RE = /ItemList|CollectionPage|SearchResultsPage|OfferCatalog/i;
  function hasListingType(jsonTexts) {
    for (const text of jsonTexts) {
      let data;
      try { data = JSON.parse(String(text).trim()); } catch (e) { continue; }
      const stack = Array.isArray(data) ? [...data] : [data];
      let guard = 0;
      while (stack.length && guard++ < 3000) {
        const n = stack.shift();
        if (!n || typeof n !== "object") continue;
        if (Array.isArray(n["@graph"])) stack.push(...n["@graph"]);
        const t = n["@type"];
        const types = Array.isArray(t) ? t.join(" ") : String(t || "");
        if (LIST_TYPE_RE.test(types)) return true;
      }
    }
    return false;
  }

  // Decide which offer describes the page at `href`. Scoring beats taking the
  // first, because recommendation carousels publish offers too.
  // `alt` is the page's canonical URL when it differs from the address you
  // arrived on. Stores redirect shortened or legacy handles, and their offer
  // URLs point at the canonical — without it every offer looks unclaimed.
  function pickForPage(cands, href, alt) {
    if (!cands.length) return null;
    if (cands.length === 1) return Object.assign({ conf: "high" }, cands[0]);

    let origin = "", here = "", search = "";
    try { const u = new URL(href); origin = u.origin; here = u.pathname; search = u.search; } catch (e) {}
    let there = "";
    try { if (alt) there = new URL(alt, origin || undefined).pathname; } catch (e) {}
    const hay = (here + " " + search + " " + there).toLowerCase();
    const idM = here.match(/\/(?:product|dp|p|itm|products|prod)\/([A-Za-z0-9._-]+)/i);
    const colorM = here.match(/\/colou?r\/([A-Za-z0-9._-]+)/i);

    const scored = cands.map((c) => {
      let s = 0;
      const p = c.url ? pathOf(c.url, origin) : "";
      if (p && (p === here || (there && p === there))) s += 100;
      if (c.sku && hay.includes(c.sku.toLowerCase())) s += 80;
      if (colorM && p && p.includes(colorM[1])) s += 40;
      if (idM && p && p.includes(idM[1])) s += 30;
      if (c.color) {
        const words = c.color.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        if (words.length && words.every((w) => hay.includes(w))) s += 20;
      }
      return Object.assign({ _score: s }, c);
    });

    // Among equally-matching offers, one you can actually buy represents the
    // page better than one that is sold out. A Shopify product lists every
    // size as its own offer, and the first is often the size that ran out.
    const buyable = (c) => (c.stock === "in" ? 0 : c.stock === "low" ? 1 : c.stock === "out" ? 3 : 2);
    scored.sort((a, b) => b._score - a._score || buyable(a) - buyable(b) || a.price - b.price);
    const top = scored[0];
    const tied = scored.filter((c) => c._score === top._score);
    const prices = new Set(tied.map((c) => c.price));

    // Nothing on the page claimed any of these offers as its own, and they
    // disagree about the money. That is a shelf, not a product: a category or
    // search page listing many things. Refuse rather than pick one at random.
    if (top._score === 0 && cands.length > 1 && prices.size > 1) return null;

    // Tied offers that agree on price are not ambiguous: Allbirds lists 14 size
    // variants at one URL, all the same money.
    if (tied.length > 1 && prices.size > 1) return Object.assign({ conf: "low" }, top);
    return Object.assign({ conf: "high" }, top);
  }

  // Pull ld+json block contents out of raw HTML, for the DOM-free path.
  function jsonLdBlocks(html) {
    const out = [];
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  }

  // Minimal meta-tag reader for the same path.
  function metaFrom(html, prop) {
    const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let m = new RegExp('<meta[^>]+(?:property|itemprop|name)\\s*=\\s*["\']' + esc +
                       '["\'][^>]*content\\s*=\\s*["\']([^"\']*)', "i").exec(html);
    if (m) return m[1];
    m = new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|itemprop|name)\\s*=\\s*["\']' +
                   esc + '["\']', "i").exec(html);
    return m ? m[1] : "";
  }

  // Stores redirect old handles to a canonical one. The Shopify data endpoint
  // is keyed on that handle, so a probe built from the link you clicked 404s.
  function canonicalFrom(html, href) {
    const m = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)/i.exec(html) ||
              /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i.exec(html);
    if (!m) return href;
    try { return new URL(m[1], href).href; } catch (e) { return href; }
  }

  function titleFrom(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    return m ? m[1].trim().slice(0, 200) : "";
  }

  // The whole DOM-free read: JSON-LD first, then meta tags. Anything weaker
  // needs a rendered page, so we stop here and let the caller escalate.
  function fromHtml(html, href) {
    const blocks = jsonLdBlocks(html);
    const title = titleFrom(html);
    const cands = offersFrom(blocks, title);
    const picked = pickForPage(cands, href, canonicalFrom(html, href));
    if (picked) {
      return Object.assign({}, picked, {
        via: cands.length > 1 ? "jsonld-variant" : "jsonld",
        candidates: cands.length,
        title: picked.title || title
      });
    }
    const amount = metaFrom(html, "product:price:amount") || metaFrom(html, "og:price:amount");
    const price = parsePrice(amount, MULTI);
    if (price != null && price > 0) {
      return { price, raw: str(amount), list: null,
        currency: metaFrom(html, "product:price:currency") || metaFrom(html, "og:price:currency") || "",
        title, image: metaFrom(html, "og:image") || "", stock: "", sku: "", color: "", size: "",
        url: "", via: "meta", conf: "medium", candidates: 1 };
    }
    return null;
  }

  root.PTLd = { str, parsePrice, listPriceOf, stockOf, imageOf, sizeOf,
                offersFrom, pickForPage, pathOf, jsonLdBlocks, metaFrom, titleFrom,
                canonicalFrom, fromHtml, urlLooksLikeProduct, urlLooksLikeListing,
                hasListingType };
})(typeof self !== "undefined" ? self : globalThis);
