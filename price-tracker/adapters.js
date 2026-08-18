// Platform adapters. These read a store's own data endpoint rather than its
// markup, which is both more reliable and cheaper than rendering a page.
// Service worker only — the popup gets the same data through a message.
(function (root) {
  "use strict";

  const UA_TIMEOUT = 12000;

  async function getJson(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), UA_TIMEOUT);
    try {
      const r = await fetch(url, { signal: ac.signal, credentials: "omit" });
      if (!r.ok) return null;
      const ct = r.headers.get("content-type") || "";
      if (!/json/i.test(ct)) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally { clearTimeout(t); }
  }

  // --- Shopify ----------------------------------------------------------------
  // Any Shopify product URL answers with JSON when `.json` is appended, giving
  // per-variant price, compare-at price and stock — including sizes, which are
  // usually invisible in the URL and therefore unreachable any other way.
  function shopifyJsonUrl(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^(.*\/products\/[^/]+?)(?:\.json)?$/i);
      if (!m) return null;
      return u.origin + m[1] + ".json";
    } catch (e) { return null; }
  }

  function looksShopify(html, url) {
    if (!/\/products\//i.test(url || "")) return false;
    return /cdn\.shopify\.com|Shopify\.theme|shopify-features|\/cdn\/shop\//i.test(html || "");
  }

  // Pick the variant the URL asks for, else the first available one.
  function pickVariant(product, url) {
    const variants = (product && product.variants) || [];
    if (!variants.length) return null;
    let wanted = null;
    try { wanted = new URL(url).searchParams.get("variant"); } catch (e) {}
    if (wanted) {
      const hit = variants.find((v) => String(v.id) === String(wanted));
      if (hit) return hit;
    }
    return variants.find((v) => v.available !== false) || variants[0];
  }

  async function fromShopify(url) {
    const endpoint = shopifyJsonUrl(url);
    if (!endpoint) return null;
    const data = await getJson(endpoint);
    const product = data && (data.product || data);
    if (!product || !product.variants) return null;

    const v = pickVariant(product, url);
    if (!v) return null;
    const price = parseFloat(v.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const cmp = parseFloat(v.compare_at_price);

    return {
      price,
      raw: String(v.price),
      list: Number.isFinite(cmp) && cmp > price ? cmp : null,
      currency: product.currency || "",
      title: product.title || "",
      image: (product.images && product.images[0] && (product.images[0].src || product.images[0])) || "",
      stock: v.available === false ? "out" : v.available === true ? "in" : "",
      sku: String(v.sku || v.id || ""),
      color: pickOption(product, v, /colou?r/i),
      size: pickOption(product, v, /size/i) || String(v.title === "Default Title" ? "" : v.title || ""),
      via: "shopify-json",
      conf: "high",
      candidates: product.variants.length,
      // Everything the confirm screen needs for a real size picker.
      variants: product.variants.map((x) => ({
        id: String(x.id), title: x.title, price: parseFloat(x.price),
        available: x.available !== false, sku: String(x.sku || "")
      }))
    };
  }

  // Shopify names its option columns per product, so match by the option's name.
  function pickOption(product, variant, re) {
    const names = (product.options || []).map((o) => (typeof o === "string" ? o : o.name) || "");
    for (let i = 0; i < names.length; i++) {
      if (re.test(names[i])) {
        const val = variant["option" + (i + 1)];
        if (val) return String(val);
      }
    }
    return "";
  }

  root.Adapters = { fromShopify, shopifyJsonUrl, looksShopify, pickVariant, getJson };
})(typeof self !== "undefined" ? self : globalThis);
