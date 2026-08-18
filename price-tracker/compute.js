// Derived values for tracked items. Pure functions, no storage access.
// Loaded by the popup via <script> and by the service worker via importScripts,
// so it attaches to globalThis rather than using module syntax.
(function (root) {
  "use strict";

  const DAY = 86400000;

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // Percent change from `from` to `to`. Negative means the price fell.
  function pctChange(from, to) {
    if (!isFinite(from) || !isFinite(to) || from <= 0) return null;
    return round2(((to - from) / from) * 100);
  }

  // The reference price a row measures against: the merchant's list price when
  // published, otherwise what it cost when tracking started.
  function startPrice(item) {
    if (item.list != null && item.list > 0) return item.list;
    return item.addedPrice;
  }

  // Three deltas, because they answer different questions. The UI picks one.
  //   vsStart  — moved since tracking began (the row's headline number)
  //   vsList   — off the merchant's list price (the "SALE" story)
  //   vsPrev   — moved at the most recent check (recent momentum)
  function deltas(item) {
    const now = item.lastPrice;
    const hist = item.history || [];
    const prev = hist.length > 1 ? hist[hist.length - 2].price : null;
    return {
      vsStart: pctChange(item.addedPrice, now),
      vsList: item.list != null ? pctChange(item.list, now) : null,
      vsPrev: prev != null ? pctChange(prev, now) : null
    };
  }

  function isAtTarget(item) {
    if (item.target == null) return false;
    return item.lastPrice <= item.target;
  }

  // "Any drop" mode: no target, so a drop below the starting price counts.
  function hasDropped(item) {
    return item.lastPrice < item.addedPrice;
  }

  // Anything that means this item is not quietly doing its job: a site that
  // stopped answering, a page now showing a different product, or a reading
  // held back for confirmation. All of these are silent without a signal.
  function needsAttention(item) {
    return item.failCount >= 3 || item.stock === "out" ||
      !!item.identityMismatch || item.pendingPrice != null;
  }

  // How far along the path from the starting price down to the target.
  // Clamped to 0-100 so a price above the start does not render a negative bar.
  function progressToTarget(item) {
    if (item.target == null) return null;
    const start = startPrice(item);
    const span = start - item.target;
    if (!(span > 0)) return item.lastPrice <= item.target ? 100 : 0;
    const moved = start - item.lastPrice;
    return Math.max(0, Math.min(100, Math.round((moved / span) * 100)));
  }

  // Currency distance still to go. Negative once the target is met.
  function distanceToTarget(item) {
    if (item.target == null) return null;
    return round2(item.lastPrice - item.target);
  }

  function savingsVsList(item) {
    if (item.list == null) return null;
    return round2(Math.max(0, item.list - item.lastPrice));
  }

  function allTimeLow(item) {
    const hist = item.history || [];
    if (!hist.length) return null;
    let low = hist[0];
    for (const h of hist) if (h.price < low.price) low = h;
    return { price: low.price, t: low.t };
  }

  function allTimeHigh(item) {
    const hist = item.history || [];
    if (!hist.length) return null;
    let high = hist[0];
    for (const h of hist) if (h.price > high.price) high = h;
    return { price: high.price, t: high.t };
  }

  // Time-weighted would be more correct, but checks are evenly spaced by the
  // alarm, so a plain mean over the window is honest enough.
  function averageOver(item, days) {
    const hist = item.history || [];
    const cutoff = Date.now() - days * DAY;
    const inWindow = hist.filter((h) => h.t >= cutoff);
    const pool = inWindow.length ? inWindow : hist;
    if (!pool.length) return null;
    const sum = pool.reduce((a, h) => a + h.price, 0);
    return round2(sum / pool.length);
  }

  // Price at or before a moment, for "how much did the list move today".
  function priceAt(item, when) {
    const hist = item.history || [];
    let found = null;
    for (const h of hist) {
      if (h.t <= when) found = h;
      else break;
    }
    return found ? found.price : null;
  }

  // Total currency change across the watchlist since midnight local time.
  function todaysChange(items) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.getTime();
    let total = 0;
    for (const it of items) {
      const before = priceAt(it, since);
      if (before == null) continue;
      total += it.lastPrice - before;
    }
    return round2(total);
  }

  function counts(items) {
    let atTarget = 0, attention = 0, active = 0;
    for (const it of items) {
      if (it.paused || (it.snoozeUntil && it.snoozeUntil > Date.now())) continue;
      active++;
      if (isAtTarget(it)) atTarget++;
      if (needsAttention(it)) attention++;
    }
    return { tracked: items.length, active, atTarget, attention };
  }

  // Meaningful moves in the history, newest first. Labels describe what we can
  // actually observe (size of the move), not merchandising intent we can't know.
  function breakpoints(item, minPct) {
    const hist = item.history || [];
    const threshold = minPct == null ? 3 : minPct;
    const out = [];
    for (let i = 1; i < hist.length; i++) {
      const from = hist[i - 1].price;
      const to = hist[i].price;
      const pct = pctChange(from, to);
      if (pct == null || Math.abs(pct) < threshold) continue;
      out.push({ t: hist[i].t, price: to, from, pct, label: labelFor(pct) });
    }
    return out.reverse();
  }

  // How long the price sat at or below the previous reading before the latest
  // one pushed it back up — the "deal lasted N days" line on the rise alert.
  // Returns milliseconds, or null when history is too thin to say honestly.
  function dealDuration(item) {
    const hist = item.history || [];
    if (hist.length < 2) return null;
    const end = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (end.price <= prev.price) return null; // not a rise; nothing ended
    let i = hist.length - 2;
    while (i > 0 && hist[i - 1].price <= prev.price) i--;
    const ms = end.t - hist[i].t;
    return ms > 0 ? ms : null;
  }

  function labelFor(pct) {
    if (pct > 0) return pct >= 15 ? "SHARP RISE" : "PRICE UP";
    const drop = Math.abs(pct);
    if (drop >= 30) return "BIG DROP";
    if (drop >= 15) return "DROP";
    return "DIP";
  }

  // Keep storage bounded: drop points older than the retention window, then
  // thin the remainder to `cap` points while always keeping the first and last.
  function pruneHistory(history, retentionDays, cap) {
    let hist = (history || []).slice();
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * DAY;
      const kept = hist.filter((h) => h.t >= cutoff);
      // Never prune down to nothing — a quiet item still needs its baseline.
      hist = kept.length ? kept : hist.slice(-1);
    }
    const limit = cap || 500;
    if (hist.length <= limit) return hist;
    const step = hist.length / limit;
    const thinned = [];
    for (let i = 0; i < limit; i++) thinned.push(hist[Math.floor(i * step)]);
    const last = hist[hist.length - 1];
    if (thinned[thinned.length - 1] !== last) thinned.push(last);
    return thinned;
  }

  root.PT = {
    DAY, round2, pctChange, startPrice, deltas,
    isAtTarget, hasDropped, needsAttention,
    progressToTarget, distanceToTarget, savingsVsList,
    allTimeLow, allTimeHigh, averageOver, priceAt, todaysChange,
    counts, breakpoints, labelFor, pruneHistory, dealDuration
  };
})(typeof self !== "undefined" ? self : globalThis);
