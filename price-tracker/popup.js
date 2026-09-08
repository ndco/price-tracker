// Popup — Paper theme. Screens 01 (home), 02 (track new), 03 (row states),
// 04 (item detail), 07 (sort & filter), 08 (empty), 09 (no price found),
// 10 (snooze), 12 (settings). Derived values all come from PT (compute.js),
// charts from PTChart (chart.js), storage and the schema from Store (store.js).
// This file only renders and routes.

const $ = (sel) => document.querySelector(sel);

const state = {
  items: [],
  settings: null,
  tab: null,
  capture: { kind: "pending" }, // pending | none | found | noprice | tracked
  editing: null,                // id of the row with inline target entry open
  snoozing: null,               // id of the row with the SNOOZE FOR panel open
  confirmDelete: null,          // id of the row asking to confirm a delete
  // A deleted item and where it sat, kept only for the current popup session.
  // Price history cannot be rebuilt, so removal gets one chance to be undone.
  lastDeleted: null,            // { item, index }
  nextAt: null,
  // Screen 07's bar. `sort` and `filters` are mirrored into settings so the
  // view survives the popup closing; the search box is deliberately not.
  view: { q: "", sort: "newest", filters: [], seeAll: false },
  // The screen router. `list` is home (01/03/07/08/09/10); `track` is 02;
  // `detail` is 04; `settings` is 12.
  screen: { name: "list" }
};

// --- formatting ---------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const SYMBOLS = { USD: "$", CAD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };

// Settings' CURRENCY is the fallback for pages that print a number without ever
// naming the currency. An item that knows its own always wins.
function sym(code) {
  const settings = state.settings;
  return SYMBOLS[(code || (settings && settings.currency) || "").toUpperCase()] || "";
}

// Prices read better bare: 55, not 55.00. Cents show only when there are cents.
function fmtNum(n) {
  if (n == null || !isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function money(item, n) {
  return sym(item && item.currency) + fmtNum(n);
}

function deltaHtml(pct) {
  if (pct == null) return "";
  if (pct < 0) return `<span class="delta drop">▼${Math.abs(pct).toFixed(1)}%</span>`;
  if (pct > 0) return `<span class="delta rise">▲${pct.toFixed(1)}%</span>`;
  return `<span class="delta flat">0.0%</span>`;
}

function ago(t) {
  if (!t) return "NEVER";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "JUST NOW";
  const m = Math.round(s / 60);
  if (m < 60) return m + "M AGO";
  const h = Math.round(m / 60);
  if (h < 24) return h + "H AGO";
  const d = Math.round(h / 24);
  if (d < 30) return d + "D AGO";
  return Math.round(d / 30) + "MO AGO";
}

const pad = (n) => String(n).padStart(2, "0");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// "APR 02" — short enough for a 340px axis, unambiguous across locales.
function shortDate(t) {
  if (!t) return "—";
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())}`;
}

function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

// Date for a stat pair: today reads better as TODAY than as its own date.
function statDate(t) {
  if (!t) return "—";
  return sameDay(t, Date.now()) ? "TODAY" : shortDate(t);
}

// How much history the row's sparkline is actually showing. The spec draws
// "30D"; we print the real span rather than a window we don't apply.
function spanLabel(item) {
  const pts = PTChart.series(item);
  if (pts.length < 2) return "";
  const days = Math.round((pts[pts.length - 1].t - pts[0].t) / PT.DAY);
  if (days < 1) return "TODAY";
  return days + "D";
}

// "RESUMES IN 26 DAYS". Anything under a day rounds up to one rather than
// reading "IN 0 DAYS" while the item is plainly still asleep.
function daysUntil(t) {
  const ms = t - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.round(ms / PT.DAY));
}

function isSnoozed(item) {
  return (item.snoozeUntil || 0) > Date.now();
}

// Not being checked, for whatever reason the user chose. Failing sites are a
// different state — they stopped on their own.
function isResting(item) {
  return !!item.paused || isSnoozed(item);
}

function isMuted(item) {
  return item.muteUntilBelow != null;
}

// --- element helper -----------------------------------------------------------

function h(tag, className, html) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html != null) el.innerHTML = html;
  return el;
}

// --- data ---------------------------------------------------------------------

async function reload() {
  state.items = await Store.getItems();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Matched on the product key, so the same item reached through two different
// ad links is one entry — while two colours of the same style stay separate,
// because they carry separate prices.
function alreadyTracked(url, canonical) {
  const keys = [Store.productKey(url)];
  if (canonical) keys.push(Store.productKey(canonical));
  return state.items.find(
    (i) => keys.indexOf(i.key) >= 0 || (i.canonical && keys.indexOf(Store.productKey(i.canonical)) >= 0)
  );
}

// Read the current tab. Three outcomes the UI cares about: a product we can
// track, a page with no price (screen 09), and a page we can't script at all.
async function detectCurrentPage() {
  const tab = await activeTab();
  state.tab = tab;

  if (!tab || !/^https?:/i.test(tab.url || "")) {
    state.capture = { kind: "none" };
    return;
  }

  let detected = null;
  try {
    // ldparse.js must land in the PAGE first. The copy loaded by popup.html
    // lives in the popup's own context; the injected extractor runs in the
    // page's isolated world and cannot see it. Without this its JSON-LD layer
    // silently does nothing and the weakest layer answers instead.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["ldparse.js"]
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["inject-extract.js"]
    });
    detected = res && res.result ? res.result : null;
  } catch (e) {
    detected = null;
  }

  if (!detected || detected.price == null) {
    state.capture = { kind: "noprice" };
    return;
  }

  detected.url = tab.url;
  detected.canonical = detected.canonical || tab.url;
  detected.title = detected.title || tab.title || tab.url;

  const existing = alreadyTracked(detected.url, detected.canonical);
  state.capture = existing
    ? { kind: "tracked", detected, item: existing }
    : { kind: "found", detected };
}

// --- header + footer ----------------------------------------------------------

function renderHeader() {
  const items = state.items;
  const c = PT.counts(items);
  const badge = $("#trackedBadge");
  const checkNow = $("#checkNow");
  const subline = $("#subline");

  // With nothing tracked there is nothing to check, so the button gives way
  // to the count (screen 08).
  const empty = items.length === 0;
  badge.hidden = !empty;
  checkNow.hidden = empty;
  badge.textContent = "0 TRACKED";

  subline.hidden = empty;
  // Nothing to check means no interval and no countdown worth showing (spec 08).
  $(".footbar").hidden = empty;
  if (empty) return;

  const at = $("#atTargetCount");
  at.textContent = `${c.atTarget} AT TARGET`;
  at.classList.toggle("none", c.atTarget === 0);
  $("#trackedCount").textContent = `${c.tracked} TRACKED`;

  const today = PT.todaysChange(items);
  const el = $("#todayChange");
  el.classList.remove("drop", "rise", "flat");
  if (!today) {
    el.textContent = "NO CHANGE TODAY";
    el.classList.add("flat");
  } else {
    const s = sym(items[0] && items[0].currency);
    el.textContent = `${today < 0 ? "-" : "+"}${s}${fmtNum(Math.abs(today))} TODAY`;
    el.classList.add(today < 0 ? "drop" : "rise");
  }
}

function tick() {
  const el = $("#nextIn");
  if (!el) return;
  if (!state.nextAt) { el.textContent = "--:--"; return; }
  const left = Math.round((state.nextAt - Date.now()) / 1000);
  if (left <= 0) {
    el.textContent = "00:00";
    refreshNext();
    return;
  }
  const hrs = Math.floor(left / 3600);
  const min = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  el.textContent = hrs > 0 ? `${hrs}:${pad(min)}:${pad(sec)}` : `${pad(min)}:${pad(sec)}`;
}

async function refreshNext() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "nextCheck" });
    state.nextAt = r && r.scheduledTime ? r.scheduledTime : null;
  } catch (e) {
    state.nextAt = null;
  }
  tick();
}

// --- capture zone (screens 01 + 09) -------------------------------------------

function captureCard() {
  const d = state.capture.detected;
  const off = d.list != null && d.list > d.price ? PT.pctChange(d.list, d.price) : null;
  const tracked = state.capture.kind === "tracked";

  const card = h("section", "capture");
  card.innerHTML = `
    <span class="eyebrow capture-eyebrow">▸ THIS PAGE</span>
    <div class="capture-title">${escapeHtml(d.title)}</div>
    <div class="capture-line">
      <span class="capture-prices">
        <span class="price">${sym(d.currency)}${fmtNum(d.price)}</span>
        ${d.list != null && d.list > d.price ? `<s class="list">${sym(d.currency)}${fmtNum(d.list)}</s>` : ""}
        ${off != null ? `<span class="off">${off.toFixed(0)}%</span>` : ""}
      </span>
      ${tracked
        ? (state.capture.item && state.capture.item.target == null
            ? `<span class="capture-tracked">
                 <span class="tracking-note">✓ TRACKING</span>
                 <button class="btn-text" type="button" data-act="capture-target">SET TARGET ▸</button>
               </span>`
            : `<span class="tracking-note">✓ TRACKING</span>`)
        : `<button class="btn btn-solid" type="button" data-act="track">TRACK ↵</button>`}
    </div>
    ${d.seller ? `<span class="capture-seller">${escapeHtml(String(d.seller).toUpperCase())}</span>` : ""}
  `;
  return card;
}

function noPriceCard() {
  const card = h("section", "noprice");
  card.innerHTML = `
    <div class="noprice-head"><span aria-hidden="true">⚠</span> NO PRICE FOUND</div>
    <p class="noprice-body">
      This page doesn't publish a price we can read — it may be a category
      page rather than a single product. Open one item, or paste its link.
    </p>
    <div class="paste-row">
      <input id="pasteUrl" class="input" type="url" placeholder="Paste product URL" aria-label="Product URL" />
      <button class="btn btn-ink" type="button" data-act="add-url">ADD</button>
    </div>
    <p id="pasteError" class="form-error" hidden></p>
  `;
  return card;
}

// --- sort & filter (screen 07) ------------------------------------------------
// The bar is worth its space only once scrolling stops being enough. Below the
// threshold the list is left exactly as it was added — no sorting, no filtering,
// no truncation — so a filter set on a long list can never quietly hide rows
// after the list gets short again.

const SORT_BAR_MIN = 9; // "past ~8 items"
const LIST_CAP = 8;     // rows before SHOWING x OF y · SEE ALL

function listIsManaged() {
  return state.items.length >= SORT_BAR_MIN;
}

// A missing delta means nothing has moved yet, which belongs with the flat
// items rather than at either end.
function dropPct(item) {
  const d = PT.deltas(item).vsStart;
  return d == null ? 0 : d;
}

// NEAR TARGET ranks on progressToTarget, not on the currency distance: $5 to go
// means something different on a $20 kettle than on a $2,000 camera. The
// distance breaks ties. No target means no ranking, so those sort last.
function nearTargetCmp(a, b) {
  const pa = PT.progressToTarget(a);
  const pb = PT.progressToTarget(b);
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  if (pb !== pa) return pb - pa;
  return PT.distanceToTarget(a) - PT.distanceToTarget(b);
}

const SORTS = {
  drop: { label: "BIGGEST DROP", cmp: (a, b) => dropPct(a) - dropPct(b) },
  target: { label: "NEAR TARGET", cmp: nearTargetCmp },
  newest: { label: "NEWEST", cmp: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) },
  az: { label: "A–Z", cmp: (a, b) => String(a.title).localeCompare(String(b.title)) }
};

// `counted` follows the spec: AT TARGET and SNOOZED carry a number, IN STOCK
// does not. Stock is only known when the page publishes it, so IN STOCK means
// "known to be in stock" — unknowns are not quietly counted as available.
const FILTERS = {
  target: { label: "AT TARGET", counted: true, test: (it) => PT.isAtTarget(it) },
  stock: { label: "IN STOCK", counted: false, test: (it) => it.stock === "in" },
  snoozed: { label: "SNOOZED", counted: true, test: isResting }
};

function filterCount(key) {
  return state.items.reduce((n, it) => n + (FILTERS[key].test(it) ? 1 : 0), 0);
}

function visibleItems() {
  const all = state.items;
  if (!listIsManaged()) {
    return { shown: all, total: all.length, truncated: false, filtered: false };
  }
  const v = state.view;
  const q = v.q.trim().toLowerCase();
  const matched = all.filter((it) => {
    for (const key of v.filters) {
      const f = FILTERS[key];
      if (f && !f.test(it)) return false;
    }
    if (!q) return true;
    return String(it.title || "").toLowerCase().includes(q) ||
           String(it.seller || "").toLowerCase().includes(q);
  });
  const sorted = matched.slice().sort((SORTS[v.sort] || SORTS.newest).cmp);
  const truncated = !v.seeAll && sorted.length > LIST_CAP;
  return {
    shown: truncated ? sorted.slice(0, LIST_CAP) : sorted,
    total: sorted.length,
    truncated,
    filtered: !!q || v.filters.length > 0
  };
}

function listBar() {
  const v = state.view;
  const bar = h("section", "listbar");
  bar.innerHTML = `
    <div class="search-row">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input id="listSearch" class="input search" type="search"
             placeholder="Filter by name or site" aria-label="Filter by name or site"
             value="${escapeHtml(v.q)}" />
    </div>
    <div class="chip-row">
      ${Object.keys(SORTS).map((k) => `
        <button class="sortchip${v.sort === k ? " is-on" : ""}" type="button"
                data-act="sort" data-v="${k}" aria-pressed="${v.sort === k}">
          ${escapeHtml(SORTS[k].label)}
        </button>`).join("")}
    </div>
    <div class="chip-row">
      ${Object.keys(FILTERS).map((k) => {
        const on = v.filters.indexOf(k) >= 0;
        const n = FILTERS[k].counted ? " " + filterCount(k) : "";
        return `
        <button class="filterchip${on ? " is-on" : ""}" type="button"
                data-act="filter" data-v="${k}" aria-pressed="${on}">
          ${escapeHtml(FILTERS[k].label)}${n}${on ? ` <span class="chip-x" aria-hidden="true">✕</span>` : ""}
        </button>`;
      }).join("")}
    </div>
  `;
  return bar;
}

// `y` is the whole watchlist, not the filtered subset — "SHOWING 3 OF 3" would
// tell you nothing. The action follows what is actually hiding rows: the cap,
// or the filters.
function listFoot(shownCount, truncated) {
  const foot = h("div", "list-foot");
  const action = truncated
    ? `<button class="btn-text" type="button" data-act="see-all">SEE ALL ▸</button>`
    : state.view.seeAll && state.items.length > LIST_CAP
      ? `<button class="btn-text" type="button" data-act="see-less">SHOW LESS ◂</button>`
      : `<button class="btn-text" type="button" data-act="clear-view">CLEAR FILTERS</button>`;
  foot.innerHTML = `
    <span class="list-count">SHOWING ${shownCount} OF ${state.items.length}</span>
    <span class="dot" aria-hidden="true">·</span>
    ${action}
  `;
  return foot;
}

// Rebuilds only the rows, so typing in the search box keeps its caret.
function paintRows(container) {
  const { shown, total, truncated, filtered } = visibleItems();
  container.textContent = "";

  if (!shown.length) {
    const none = h("section", "no-match");
    none.innerHTML = `
      <p class="no-match-head">Nothing matches.</p>
      <button class="btn btn-outline" type="button" data-act="clear-view">CLEAR FILTERS</button>
    `;
    container.appendChild(none);
    return;
  }

  const list = h("div", "rows");
  for (const item of shown) list.appendChild(rowEl(item));
  container.appendChild(list);

  // The count line only says something once it has something to say: either the
  // list is cut short, or a filter is hiding part of it.
  if (listIsManaged() && (truncated || filtered || shown.length < state.items.length)) {
    container.appendChild(listFoot(shown.length, truncated));
  }
}

async function setView(patch) {
  Object.assign(state.view, patch);
  state.settings = await Store.setSettings({
    listSort: state.view.sort,
    listFilters: state.view.filters
  });
  render();
}

// --- watchlist rows (screens 01 + 03) -----------------------------------------

function chipFor(item, ctx) {
  if (ctx.stale) return `<span class="chip chip-stale">CAN'T CHECK</span>`;
  // The page loaded fine but showed a different thing, so nothing was recorded.
  if (ctx.mismatched) return `<span class="chip chip-stale">CAN'T VERIFY</span>`;
  // A reading the page would not let us pin down. Another check reads the same
  // ambiguous page, so this is not "confirming" — it is stuck until the site
  // changes or the user corrects it.
  if (ctx.pending && item.pendingKind === "unverified") {
    return `<span class="chip chip-stale">CAN'T VERIFY</span>`;
  }
  // A reading is waiting on a second opinion before it counts.
  if (ctx.pending) return `<span class="chip chip-pending">CONFIRMING</span>`;
  // Waiting for a sold-out item to return. Its price is irrelevant until then.
  if (item.watch === "stock") return `<span class="chip chip-pending">WAITING FOR STOCK</span>`;
  // Screen 10: a resting row says so first. Whether it is also at target can
  // wait until it wakes up.
  if (ctx.snoozed) return `<span class="chip chip-rest">SNOOZED</span>`;
  if (item.paused) return `<span class="chip chip-rest">PAUSED</span>`;
  if (ctx.atTarget) return `<span class="chip chip-hit">HIT</span>`;
  if (ctx.muted) return `<span class="chip chip-rest">MUTED</span>`;
  if (ctx.isNew) return `<span class="chip chip-new">NEW</span>`;
  if (item.target != null) {
    const away = PT.distanceToTarget(item);
    return `<span class="chip chip-tgt">+${fmtNum(away)} TO TGT</span>`;
  }
  return `<span class="chip chip-any">ANY DROP</span>`;
}

// Screen 10's SNOOZE FOR block. Shown inside the row it belongs to, so the
// duration you pick is unmistakably attached to one item.
function snoozePanel(item) {
  const panel = h("div", "snooze-panel");
  const kinds = ["7", "30", "drop"];
  panel.innerHTML = `
    <div class="snooze-panel-head">
      <span class="eyebrow">SNOOZE FOR</span>
      <button class="btn-text" type="button" data-act="close-snooze" aria-label="Close">✕</button>
    </div>
    <div class="chip-row">
      ${kinds.map((k) => {
        // No price yet means nothing to hold the alerts against.
        const off = k === "drop" && !(item.lastPrice > 0);
        return `
        <button class="durchip${item.snoozeKind === k ? " is-on" : ""}" type="button"
                data-act="snooze" data-v="${k}" aria-pressed="${item.snoozeKind === k}"
                ${off ? "disabled" : ""}>
          ${escapeHtml(Store.SNOOZE[k].label)}
        </button>`;
      }).join("")}
    </div>
    <p class="snooze-help">7 and 30 days stop the checks and start them again on
      their own. UNTIL IT DROPS keeps checking — it holds the alerts until the
      price falls below ${escapeHtml(money(item, item.lastPrice))}.</p>
    ${isResting(item) ? "" : `
      <div class="snooze-panel-foot">
        <span class="eyebrow">OR STOP ALTOGETHER</span>
        <button class="btn btn-danger" type="button" data-act="ask-delete">DELETE</button>
      </div>`}
  `;
  return panel;
}

// The one destructive control in the list. It never sits next to a harmless
// button in the same shape: it is rust, and it asks first.
function deleteConfirm(item) {
  const box = h("div", "confirm-strip");
  box.innerHTML = `
    <span class="confirm-text">STOP TRACKING AND DELETE ITS HISTORY?</span>
    <span class="confirm-actions">
      <button class="btn btn-danger" type="button" data-act="confirm-delete">DELETE</button>
      <button class="btn btn-outline" type="button" data-act="cancel-delete">KEEP</button>
    </span>
  `;
  return box;
}

function rowEl(item) {
  const stale = (item.failCount || 0) >= Store.MAX_FAILS;
  const isNew = (item.history || []).length < 2;
  // HIT is reserved for an explicit target being met (spec 01). An any-drop
  // item that fell keeps its ANY DROP label and lets the delta tell the story.
  const atTarget = PT.isAtTarget(item);
  const noPriceYet = isNew && !(item.lastPrice > 0);
  const snoozed = isSnoozed(item);
  const resting = snoozed || item.paused;
  const muted = isMuted(item);
  // Two ways a check can succeed and still refuse to record anything. Both are
  // silent by nature, so the row has to say them out loud.
  const mismatched = !!item.identityMismatch;
  const pending = item.pendingPrice != null;
  const ctx = { stale, isNew, atTarget, snoozed, muted, mismatched, pending };

  const row = h("article", "row" +
    (atTarget && !stale && !resting && !mismatched ? " is-hit" : "") +
    (stale || mismatched ? " is-stale" : "") +
    (pending && !stale && !mismatched ? " is-pending" : "") +
    (resting ? " is-resting" : ""));
  row.dataset.id = item.id;

  const head = h("div", "row-head");
  head.innerHTML = `
    <button class="row-title" type="button" data-act="open">${escapeHtml(item.title)}</button>
    ${chipFor(item, ctx)}
  `;
  row.appendChild(head);

  // Price line. A brand new item has no history to compare against yet, so it
  // shows the price alone rather than a 0.0% that means nothing.
  const d = PT.deltas(item);
  const prices = h("div", "row-prices");
  // Screen 10 puts the wake-up time where the delta usually sits: while an item
  // is asleep, when it comes back is the more useful number.
  const restNote = snoozed ? `RESUMES IN ${daysUntil(item.snoozeUntil)} DAY${
    daysUntil(item.snoozeUntil) === 1 ? "" : "S"}`
    : item.paused ? "PAUSED UNTIL YOU RESUME" : "";
  prices.innerHTML = `
    <span class="price">${noPriceYet ? "—" : money(item, item.lastPrice)}</span>
    ${!noPriceYet && item.list != null && item.list > item.lastPrice
      ? `<s class="list">${money(item, item.list)}</s>` : ""}
    <span class="spacer"></span>
    ${resting ? `<span class="rest-note">${escapeHtml(restNote)}</span>`
      : isNew ? "" : deltaHtml(d.vsStart)}
  `;
  row.appendChild(prices);

  // --- state block ---
  // Screen 01 puts a sparkline here once there are two points to join. With
  // sparklines switched off the row falls back to screen 03's progress bar.
  const sparks = !!(state.settings && state.settings.showSparklines);
  const showSpark = sparks && !isNew && !stale && !resting && state.editing !== item.id;

  if (state.confirmDelete === item.id) {
    row.appendChild(deleteConfirm(item));
  } else if (resting) {
    // Screen 10, top half: the two ways out, and the promise about history.
    const rest = h("div", "rest-block");
    rest.innerHTML = `
      <div class="rest-actions">
        <button class="btn btn-outline" type="button" data-act="resume">RESUME NOW</button>
        <button class="btn btn-danger" type="button" data-act="ask-delete">DELETE</button>
      </div>
      <p class="rest-help">HISTORY IS KEPT WHILE SNOOZED — CHECKS JUST PAUSE.</p>
    `;
    row.appendChild(rest);
  } else if (stale) {
    row.appendChild(h("p", "stale-note",
      `STOPPED AFTER ${Store.MAX_FAILS} FAILED CHECKS`));
  } else if (mismatched) {
    row.appendChild(h("p", "stale-note", escapeHtml(item.identityMismatch)));
  } else if (pending) {
    row.appendChild(h("p", "pending-note",
      `${money(item, item.pendingPrice)} seen — ${escapeHtml(item.suspect || "confirming before it counts")}`));
  } else if (isNew) {
    row.appendChild(h("p", "awaiting",
      `<span class="dots" aria-hidden="true">•••</span> AWAITING FIRST CHECK`));
  } else if (showSpark) {
    row.appendChild(h("div", "spark-wrap", PTChart.sparkline(item)));
    // An any-drop item keeps its inline way to add a target (screen 03).
    if (item.target == null) {
      const btn = h("button", "btn btn-dashed", "+ SET TARGET");
      btn.type = "button";
      btn.dataset.act = "set-target";
      row.appendChild(btn);
    }
  } else if (state.editing === item.id) {
    const entry = h("div", "target-entry");
    entry.innerHTML = `
      <span class="cur">${sym(item.currency) || "TGT"}</span>
      <input class="input" type="number" step="0.01" min="0" data-role="target-input"
             value="${item.target != null ? fmtNum(item.target) : ""}"
             placeholder="${fmtNum(Math.round(item.lastPrice * 0.9))}" aria-label="Target price" />
      <button class="btn btn-solid" type="button" data-act="save-target">SAVE</button>
      <button class="btn btn-outline" type="button" data-act="cancel-target" aria-label="Cancel">✕</button>
    `;
    row.appendChild(entry);
  } else if (item.target != null) {
    const pct = PT.progressToTarget(item);
    const bar = h("div", "bar");
    bar.innerHTML = `<div class="bar-fill" style="width:${pct}%"></div>`;
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(pct));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-label", "Progress to target");
    row.appendChild(bar);
  } else {
    const btn = h("button", "btn btn-dashed", "+ SET TARGET");
    btn.type = "button";
    btn.dataset.act = "set-target";
    row.appendChild(btn);
  }

  // --- foot ---
  // Screen 01: history span on the left, target and last check in the middle,
  // MORE on the right. Without a sparkline the left slot has nothing to caption.
  let meta = "";
  if (resting) {
    meta = item.target != null ? `TGT ${money(item, item.target)}` : "ANY DROP";
  } else if (muted) {
    meta = `ALERTS HELD UNTIL BELOW ${money(item, item.muteUntilBelow)}`;
  } else if (stale) {
    meta = `LAST GOOD ${money(item, item.lastPrice)} · ${ago(item.lastOk)}`;
  } else if (mismatched) {
    meta = `STILL SHOWING ${money(item, item.lastPrice)} · ${ago(item.lastOk)}`;
  } else if (pending) {
    meta = `HOLDING AT ${money(item, item.lastPrice)} · ${ago(item.lastChecked)}`;
  } else if (item.watch === "stock") {
    meta = `SOLD OUT · CHECKED ${ago(item.lastChecked)}`;
  } else if (isNew) {
    meta = item.seller ? String(item.seller).toUpperCase() : "";
  } else if (showSpark) {
    meta = item.target != null
      ? `TGT ${money(item, item.target)} · ${ago(item.lastChecked)}`
      : `ANY DROP · ${ago(item.lastChecked)}`;
  } else if (item.target != null && state.editing !== item.id) {
    meta = `TARGET ${money(item, item.target)} · ${PT.progressToTarget(item)}% THERE`;
  } else if (item.target == null) {
    meta = `FROM ${money(item, item.addedPrice)} · ${ago(item.lastChecked)}`;
  }

  const foot = h("div", "row-foot");
  foot.innerHTML = `
    <span class="row-span">${showSpark ? escapeHtml(spanLabel(item)) : ""}</span>
    <span class="row-meta">${escapeHtml(meta)}</span>
    <span class="row-actions">
      <button class="btn-text${state.snoozing === item.id ? " is-on" : ""}" type="button"
              data-act="open-snooze"
              aria-label="Snooze ${escapeHtml(item.title)}">SNOOZE ▾</button>
      <button class="btn-text" type="button" data-act="more">MORE ▸</button>
      <button class="btn-text btn-remove" type="button" data-act="ask-delete"
              title="Remove from list"
              aria-label="Remove ${escapeHtml(item.title)}">&#10005;</button>
    </span>
  `;
  row.appendChild(foot);

  if (state.snoozing === item.id) row.appendChild(snoozePanel(item));
  return row;
}

// --- empty state (screen 08) --------------------------------------------------

function emptyBlock(hasCapture) {
  const wrap = h("div", "");
  const box = h("section", "empty");
  box.innerHTML = `
    <svg class="empty-art" width="132" height="40" viewBox="0 0 132 40" fill="none" aria-hidden="true">
      <path d="M2 10 L18 16 L34 8 L50 22 L66 18 L82 30 L98 26 L114 34 L130 32"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="square" fill="none"/>
      <path d="M2 38 H130" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/>
      <circle cx="130" cy="32" r="3" fill="#1F7A4D"/>
    </svg>
    <p class="empty-head">Nothing tracked yet.</p>
    <p class="empty-body">${hasCapture
      ? "Hit TRACK above and we'll watch the price. We check on a schedule and tell you the moment it drops."
      : "Open any product page and hit Track. We check the price on a schedule and tell you the moment it drops."}</p>
    <button class="btn btn-ink" type="button" data-act="demo">TRY A DEMO ITEM</button>
  `;
  wrap.appendChild(box);

  const works = h("section", "works-on");
  works.innerHTML = `
    <span class="eyebrow">WORKS ON</span>
    <div class="works-chips">
      <span class="works-chip">ANY SITE WITH PRICE DATA</span>
    </div>
    <p class="works-note">Some retailers block automated checks. Those show a can't-check state.</p>
  `;
  wrap.appendChild(works);
  return wrap;
}

// --- screen 02: track a new item ----------------------------------------------

function screenBar(title, trailing) {
  const bar = h("section", "screenbar");
  bar.innerHTML = `
    <button class="backbtn" type="button" data-act="back" aria-label="Back">←</button>
    <span class="screen-title">${escapeHtml(title)}</span>
    ${trailing || ""}
  `;
  return bar;
}

// The primary button says what it will do, so it has to track the input as the
// user types. Cheaper than re-rendering the screen on every keystroke.
function trackButtonLabel() {
  const t = parsedTarget();
  const d = state.screen.detected || {};
  // Nothing to buy means nothing to price-watch — say what it will actually do.
  if (d.stock === "out") return "WATCH FOR STOCK";
  return t == null ? "TRACK ANY DROP" : `TRACK AT ${sym(d.currency)}${fmtNum(t)}`;
}

function parsedTarget() {
  const raw = (state.screen.target || "").trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// What we read off the page, offered for a look before anything is tracked.
// Whatever stands here becomes the fingerprint every later check is compared
// against, so a correction now is worth more than any amount of guessing later.
function detailsBlock(d) {
  const box = h("section", "details");
  const sure = d.conf === "high";
  const editing = !!state.screen.editingDetails;
  // When we are confident and the page named the thing, the block stays out of
  // the way. When we guessed, it opens itself.
  const open = editing || !sure || !!state.screen.detailsOpen;

  const mark = (present) => present
    ? `<span class="ok" title="published by the site">✓</span>`
    : `<span class="guess" title="not published — our best read">?</span>`;

  const rows = [
    { k: "PRICE", v: sym(d.currency) + fmtNum(d.price), from: sure },
    d.list != null ? { k: "WAS", v: sym(d.currency) + fmtNum(d.list), from: true } : null,
    { k: "COLOUR", v: d.color || "—", from: !!d.color, missing: !d.color },
    { k: "SIZE", v: d.size || "not published on this page", from: !!d.size, missing: !d.size },
    { k: "IN STOCK", v: d.stock === "out" ? "no" : d.stock === "low" ? "low" : d.stock === "in" ? "yes" : "—",
      from: !!d.stock, missing: !d.stock }
  ].filter(Boolean);

  box.innerHTML = `
    <div class="details-head">
      <span class="eyebrow">CHECK THESE DETAILS</span>
      <button class="btn-text" type="button" data-act="${editing ? "cancel-details" : "edit-details"}">
        ${editing ? "DONE" : "✎ EDIT"}</button>
    </div>
    ${!sure ? `<p class="details-warn">We had to guess some of this — worth a look.</p>` : ""}
    ${open ? (editing ? editRows(d) : `
      <dl class="details-list">
        ${rows.map((r) => `
          <div class="details-row${r.missing ? " is-missing" : ""}">
            <dt>${r.k}</dt>
            <dd>${escapeHtml(String(r.v))} ${r.missing ? "" : mark(r.from)}</dd>
          </div>`).join("")}
      </dl>
      <p class="details-help">Not right? Tap EDIT and correct it.</p>`)
      : `<button class="btn-text details-peek" type="button" data-act="open-details">
           ${escapeHtml(sym(d.currency) + fmtNum(d.price))}${d.color ? " · " + escapeHtml(d.color) : ""}
           ${d.size ? " · " + escapeHtml(d.size) : ""} — show details ▾</button>`}
  `;
  return box;
}

// Only the fields a person can meaningfully correct.
function editRows(d) {
  const sizes = state.screen.variants || [];
  return `
    <div class="edit-grid">
      <label class="edit-row">
        <span class="eyebrow">PRICE</span>
        <input id="fixPrice" class="input" type="number" step="0.01" min="0" inputmode="decimal"
               value="${escapeHtml(fmtNum(d.price))}" aria-label="Correct the price" />
      </label>
      <label class="edit-row">
        <span class="eyebrow">WAS</span>
        <input id="fixList" class="input" type="number" step="0.01" min="0" inputmode="decimal"
               placeholder="none" value="${d.list != null ? escapeHtml(fmtNum(d.list)) : ""}"
               aria-label="Correct the original price" />
      </label>
      <label class="edit-row">
        <span class="eyebrow">COLOUR</span>
        <input id="fixColor" class="input" type="text" placeholder="not published"
               value="${escapeHtml(d.color || "")}" aria-label="Correct the colour" />
      </label>
      <label class="edit-row">
        <span class="eyebrow">SIZE</span>
        ${sizes.length
          ? `<select id="fixSize" class="select">
               <option value="">any size</option>
               ${sizes.map((v) => `<option value="${escapeHtml(v.title)}"
                 ${v.title === d.size ? "selected" : ""}${v.available ? "" : " disabled"}>
                 ${escapeHtml(v.title)}${v.available ? "" : " — sold out"}</option>`).join("")}
             </select>`
          : `<input id="fixSize" class="input" type="text" placeholder="not published"
                    value="${escapeHtml(d.size || "")}" aria-label="Correct the size" />`}
      </label>
    </div>
    <p class="details-help">Correcting the price tells us to read this site more
      carefully — future readings that look the same way get double-checked
      before they count.</p>
  `;
}

function trackScreen() {
  const d = state.screen.detected || {};
  const item = state.screen.item || null;
  const wrap = h("div", "screen");
  wrap.appendChild(screenBar("TRACK THIS ITEM"));

  // Summary. The thumbnail only exists when the page published one — an empty
  // frame would be worse than none (spec, platform limits).
  const summary = h("section", "track-summary");
  summary.innerHTML = `
    ${d.image ? `<img class="thumb" src="${escapeHtml(d.image)}" alt="" />` : ""}
    <div class="track-sum-body">
      <div class="track-title">${escapeHtml(d.title || "Untitled")}</div>
      <div class="track-prices">
        <span class="price">${sym(d.currency)}${fmtNum(d.price)}</span>
        ${d.list != null && d.list > d.price
          ? `<s class="list">${sym(d.currency)}${fmtNum(d.list)}</s>` : ""}
        <span class="spacer"></span>
        ${d.seller ? `<span class="track-seller">${escapeHtml(String(d.seller).toUpperCase())}</span>` : ""}
      </div>
    </div>
  `;
  wrap.appendChild(summary);

  // Sold out changes what tracking even means. Watching a price you cannot pay
  // is noise; what you actually want to know is when it comes back.
  if (d.stock === "out") {
    const gone = h("section", "soldout");
    gone.innerHTML = `
      <div class="soldout-head"><span aria-hidden="true">⚠</span> SOLD OUT</div>
      <p class="soldout-body">This isn't buyable right now. Track it and we'll
        tell you the moment it's back — and what it costs then.</p>
    `;
    wrap.appendChild(gone);
  }

  wrap.appendChild(detailsBlock(d));

  // Quick fills. MATCH LOW needs a real history to match; without one the chip
  // is left out rather than pointed at the current price.
  const low = item ? PT.allTimeLow(item) : null;
  // Rounded to whole units — a target is a decision, not a calculation, and
  // "260" is a better suggestion than "260.10".
  const chips = [
    { label: "-10%", value: Math.round(d.price * 0.9) },
    { label: "-20%", value: Math.round(d.price * 0.8) }
  ];
  if (low && low.price > 0 && low.price < d.price) {
    chips.push({ label: "MATCH LOW", value: low.price });
  }

  const form = h("section", "form");
  form.innerHTML = `
    <div class="field-head">
      <span class="eyebrow">TARGET PRICE</span>
      <span class="eyebrow faint">OPTIONAL</span>
    </div>
    <div class="target-box">
      <span class="cur">${sym(d.currency) || "$"}</span>
      <input id="targetInput" class="target-input" type="number" step="0.01" min="0"
             inputmode="decimal" placeholder="Any drop" aria-label="Target price"
             value="${escapeHtml(state.screen.target || "")}" />
      ${d.currency ? `<span class="cur-code">${escapeHtml(String(d.currency).toUpperCase())}</span>` : ""}
    </div>
    <div class="quick-row">
      ${chips.map((c) => `
        <button class="quick" type="button" data-act="quick" data-v="${c.value}">
          ${escapeHtml(c.label)} · ${fmtNum(c.value)}
        </button>`).join("")}
    </div>
    <p class="form-help">${d.stock === "out"
      ? "We'll tell you when it's back. Set a target and we'll keep watching the price from there."
      : "Leave empty and we'll alert you on any drop. You can add a target later."}</p>
    <div class="field-row">
      <span class="eyebrow">NOTIFY ME</span>
      <select id="notifySel" class="select">
        <option value="any">ON ANY DROP</option>
        <option value="target">ONLY AT TARGET</option>
      </select>
    </div>
    <div class="field-row">
      <span class="eyebrow">CHECK EVERY</span>
      <select id="trackInterval" class="select">
        <option value="30">30M</option>
        <option value="60">1H</option>
        <option value="180">3H</option>
        <option value="360">6H</option>
        <option value="720">12H</option>
        <option value="1440">24H</option>
      </select>
    </div>
  `;
  wrap.appendChild(form);

  const actions = h("section", "screen-actions");
  actions.innerHTML = `
    <button id="trackConfirm" class="btn btn-solid btn-wide" type="button" data-act="confirm-track">
      ${escapeHtml(trackButtonLabel())}
    </button>
    <button class="btn btn-outline" type="button" data-act="back">CANCEL</button>
  `;
  wrap.appendChild(actions);
  return wrap;
}

// Post-render wiring for screen 02: things that need a live element rather than
// a string.
function afterTrackScreen() {
  const img = $(".track-summary .thumb");
  // A hotlinked image can 404 or be blocked. Drop the frame rather than show a
  // broken one — inline handlers are barred by the extension CSP, so bind here.
  if (img) img.addEventListener("error", () => img.remove());

  const sel = $("#notifySel");
  if (sel) sel.value = state.screen.alertOn || "any";

  const iv = $("#trackInterval");
  if (iv) iv.value = String((state.settings && state.settings.intervalMinutes) || 60);

  // Bring the button label and the notify options in line with the field's
  // starting value, which may already hold a target.
  syncTrackButton();

  const input = $("#targetInput");
  if (input && state.screen.focusTarget) {
    input.focus();
    state.screen.focusTarget = false;
  }
}

// --- screen 04: item detail & history -----------------------------------------

function calloutHtml(item, pts, idx) {
  if (!pts.length) {
    return `<div class="callout"><span class="callout-main">No readings yet</span>
      <span class="callout-note">The first check will start the history.</span></div>`;
  }
  const i = Math.max(0, Math.min(pts.length - 1, idx == null ? pts.length - 1 : idx));
  const p = pts[i];
  const prev = i > 0 ? pts[i - 1].price : null;
  const pct = prev != null ? PT.pctChange(prev, p.price) : null;
  // Labels come from compute.js. We never invent a merchandising reason.
  const label = pct != null && Math.abs(pct) >= 3 ? PT.labelFor(pct)
    : i === 0 ? "FIRST READING"
    : pct ? "MINOR MOVE" : "NO CHANGE";
  const atTgt = item.target != null && p.price <= item.target;

  return `
    <div class="callout">
      <div class="callout-line">
        <span class="callout-date">${escapeHtml(shortDate(p.t))}</span>
        <span class="callout-price">${money(item, p.price)}</span>
        <span class="spacer"></span>
        ${pct != null ? deltaHtml(pct) : `<span class="delta flat">—</span>`}
      </div>
      <div class="callout-note">
        ${escapeHtml(label)}${atTgt ? " · AT OR BELOW YOUR TARGET" : ""}
      </div>
    </div>
  `;
}

function statPair(label, value, sub) {
  return `
    <div class="stat">
      <span class="eyebrow">${escapeHtml(label)}</span>
      <span class="stat-value">${value}</span>
      ${sub ? `<span class="stat-sub">${escapeHtml(sub)}</span>` : ""}
    </div>
  `;
}

function detailScreen() {
  const item = state.items.find((i) => i.id === state.screen.id);
  if (!item) {
    state.screen = { name: "list" };
    return listScreen();
  }

  const pts = PTChart.series(item);
  const sel = state.screen.sel == null ? pts.length - 1 : state.screen.sel;
  const atTarget = PT.isAtTarget(item);
  const d = PT.deltas(item);
  const low = PT.allTimeLow(item);
  const avg = PT.averageOver(item, 90);

  const wrap = h("div", "screen");
  wrap.appendChild(screenBar(item.title,
    atTarget ? `<span class="chip chip-hit">HIT</span>` : ""));

  // Headline: current price, merchant list, and the all-time move.
  const head = h("section", "detail-head");
  head.innerHTML = `
    <span class="price">${money(item, item.lastPrice)}</span>
    ${item.list != null && item.list > item.lastPrice
      ? `<s class="list">${money(item, item.list)}</s>` : ""}
    <span class="spacer"></span>
    <span class="alltime">${d.vsStart != null ? deltaHtml(d.vsStart) : ""}
      <span class="alltime-label">ALL-TIME</span></span>
  `;
  wrap.appendChild(head);

  // One reading is not a history. Drawing a full-height chart for it leaves a
  // large empty box, so say plainly that there is nothing to plot yet.
  const chart = h("section", "chart-block");
  if (pts.length < 2) {
    chart.classList.add("chart-empty");
    chart.innerHTML = `
      <p class="chart-none">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        Only one reading so far. The chart appears after the next check.
      </p>`;
  } else {
    chart.innerHTML =
      PTChart.detail(item, { selected: sel }) +
      `<div class="axis">
         <span>${escapeHtml(shortDate(pts[0].t))}</span>
         <span class="axis-mid">${item.target != null
           ? "TARGET " + escapeHtml(fmtNum(item.target)) : "NO TARGET"}</span>
         <span>${escapeHtml(shortDate(pts[pts.length - 1].t))}</span>
       </div>` +
      calloutHtml(item, pts, sel);
  }
  wrap.appendChild(chart);

  const stats = h("section", "stats");
  stats.innerHTML =
    statPair("FIRST TRACKED", money(item, item.addedPrice), statDate(item.createdAt)) +
    statPair("ALL-TIME LOW", low ? money(item, low.price) : "—",
      low ? statDate(low.t) : "") +
    statPair("90-DAY AVG", avg != null ? money(item, avg) : "—", "") +
    statPair("CHECKS", String(pts.length), pts.length === 1 ? "READING" : "READINGS");
  wrap.appendChild(stats);

  // Settings block. TARGET edits inline and can be cleared back to any-drop.
  const meta = h("section", "detail-meta");
  if (state.screen.editing) {
    meta.innerHTML = `
      <div class="meta-row meta-edit">
        <span class="eyebrow">TARGET</span>
        <input id="detailTarget" class="input" type="number" step="0.01" min="0"
               placeholder="Any drop" aria-label="Target price"
               value="${item.target != null ? fmtNum(item.target) : ""}" />
        <button class="btn btn-solid" type="button" data-act="save-detail-target">SAVE</button>
      </div>
      <p class="meta-help">Clear the field to alert on any drop instead.</p>
    `;
  } else {
    meta.innerHTML = `
      <div class="meta-row">
        <span class="eyebrow">TARGET</span>
        <span class="meta-value">${item.target != null
          ? money(item, item.target) : "ANY DROP"}</span>
        <button class="btn btn-outline" type="button" data-act="edit-detail-target">EDIT</button>
      </div>
    `;
  }
  meta.innerHTML += `
    <div class="meta-row">
      <span class="eyebrow">ALERT ON</span>
      <span class="spacer"></span>
      <select id="detailAlert" class="select">
        <option value="any">ANY DROP</option>
        <option value="target"${item.target == null ? " disabled" : ""}>ONLY AT TARGET</option>
      </select>
    </div>
    <div class="meta-row">
      <span class="eyebrow">SELLER / STOCK</span>
      <span class="spacer"></span>
      <span class="meta-value small">${escapeHtml(
        [item.seller ? String(item.seller).toUpperCase() : "UNKNOWN",
         stockLabel(item)].filter(Boolean).join(" · "))}</span>
    </div>
  `;
  wrap.appendChild(meta);

  // Breakpoints — real moves only, labelled by size (compute.js labelFor).
  const bps = PT.breakpoints(item);
  const bpBlock = h("section", "breakpoints");
  bpBlock.innerHTML = `<span class="eyebrow">BREAKPOINTS</span>` + (bps.length
    ? `<div class="bp-list">${bps.slice(0, 8).map((b) => `
        <div class="bp">
          <span class="bp-date">${escapeHtml(shortDate(b.t))}</span>
          <span class="bp-price">${fmtNum(b.price)}</span>
          <span class="bp-pct ${b.pct < 0 ? "drop" : "rise"}">${
            b.pct < 0 ? "▼" : "▲"}${Math.abs(b.pct).toFixed(0)}%</span>
          <span class="bp-label">${escapeHtml(b.label)}</span>
        </div>`).join("")}</div>`
    : `<p class="bp-none">No move over 3% yet. Small wobbles are left out.</p>`);
  wrap.appendChild(bpBlock);

  const actions = h("section", "screen-actions");
  actions.innerHTML = `
    <button class="btn btn-ink btn-wide" type="button" data-act="open-product">OPEN PRODUCT ↗</button>
    <button class="btn btn-outline" type="button" data-act="toggle-pause">${
      item.paused ? "RESUME" : "PAUSE"}</button>
    <button class="btn btn-danger" type="button" data-act="ask-delete">DELETE</button>
  `;
  wrap.appendChild(actions);
  if (state.confirmDelete === item.id) wrap.appendChild(deleteConfirm(item));

  // Whatever is holding this item back, say so here rather than leaving the
  // detail screen looking like a live item that simply never updates.
  if ((item.failCount || 0) >= Store.MAX_FAILS) {
    // Stopping is a judgement about the site, not a life sentence for the item.
    // Without a way back, a site that was briefly unreachable left the row dead
    // and the only cure was deleting and re-adding it.
    wrap.appendChild(h("p", "paused-note warn-note",
      `CHECKS STOPPED AFTER ${Store.MAX_FAILS} FAILURES — ${escapeHtml(item.lastError || "the site refused us")}.`));
    wrap.appendChild(h("div", "row-actions",
      `<button class="btn btn-outline" type="button" data-act="retry-item">TRY AGAIN</button>`));
  } else if (item.identityMismatch) {
    wrap.appendChild(h("p", "paused-note warn-note",
      `CAN'T VERIFY — ${escapeHtml(item.identityMismatch)}. NOTHING RECORDED WHILE THE PAGE SHOWS A DIFFERENT ITEM.`));
  } else if (item.pendingPrice != null && item.pendingKind === "unverified") {
    wrap.appendChild(h("p", "paused-note warn-note",
      `SAW ${money(item, item.pendingPrice)} — ${escapeHtml(item.suspect ||
        "could not tell which number on the page is the price")}. NOTHING IS RECORDED ` +
      `UNTIL THE PAGE IS CLEARER, BECAUSE A SECOND LOOK READS THE SAME PAGE.`));
  } else if (item.pendingPrice != null) {
    wrap.appendChild(h("p", "paused-note warn-note",
      `SAW ${money(item, item.pendingPrice)} — ${escapeHtml(item.suspect || "confirming")}. IT COUNTS ONCE A SECOND CHECK AGREES.`));
  } else if (isSnoozed(item)) {
    const n = daysUntil(item.snoozeUntil);
    wrap.appendChild(h("p", "paused-note",
      `SNOOZED — RESUMES IN ${n} DAY${n === 1 ? "" : "S"}. HISTORY IS KEPT.`));
  } else if (item.paused) {
    wrap.appendChild(h("p", "paused-note",
      "CHECKS ARE PAUSED. HISTORY IS KEPT."));
  } else if (isMuted(item)) {
    wrap.appendChild(h("p", "paused-note",
      `STILL CHECKING — ALERTS HELD UNTIL BELOW ${money(item, item.muteUntilBelow)}.`));
  }
  return wrap;
}

function stockLabel(item) {
  if (item.stock === "in") return "IN STOCK";
  if (item.stock === "out") return "OUT OF STOCK";
  if (item.stock === "low") return "LOW STOCK";
  return "STOCK UNKNOWN";
}

function afterDetailScreen() {
  const item = state.items.find((i) => i.id === state.screen.id);
  const sel = $("#detailAlert");
  if (sel && item) sel.value = item.target == null ? "any" : (item.alertOn || "target");
  const input = $("#detailTarget");
  if (input && state.screen.focusTarget) {
    input.focus();
    input.select();
    state.screen.focusTarget = false;
  }
}

// --- screen 12: settings ------------------------------------------------------

const INTERVALS = [[30, "30M"], [60, "1H"], [180, "3H"], [360, "6H"],
                   [720, "12H"], [1440, "24H"]];

const CURRENCIES = [["USD", "USD $"], ["EUR", "EUR €"], ["GBP", "GBP £"],
                    ["CAD", "CAD $"], ["AUD", "AUD $"], ["NZD", "NZD $"],
                    ["JPY", "JPY ¥"], ["INR", "INR ₹"]];

const RETENTIONS = [[90, "90 DAYS"], [365, "1 YEAR"], [730, "2 YEARS"], [0, "FOREVER"]];

const HOURS = Array.from({ length: 24 }, (_, i) => [i, pad(i) + ":00"]);

function selectHtml(key, options, value) {
  return `<select class="select" data-key="${key}">` +
    options.map(([v, label]) =>
      `<option value="${escapeHtml(v)}"${String(v) === String(value) ? " selected" : ""}>${
        escapeHtml(label)}</option>`).join("") +
    `</select>`;
}

function switchRow(label, key, on) {
  return `
    <div class="set-row">
      <span class="set-label">${escapeHtml(label)}</span>
      <button class="switch${on ? " is-on" : ""}" type="button" role="switch"
              aria-checked="${on ? "true" : "false"}" aria-label="${escapeHtml(label)}"
              data-act="toggle" data-key="${key}"><span class="switch-knob"></span></button>
    </div>
  `;
}

function selectRow(label, key, options, value) {
  return `
    <div class="set-row">
      <span class="set-label">${escapeHtml(label)}</span>
      ${selectHtml(key, options, value)}
    </div>
  `;
}

function settingsScreen() {
  const s = state.settings;
  const sc = state.screen;
  const wrap = h("div", "screen");
  wrap.appendChild(screenBar("SETTINGS"));

  // EMAIL DIGEST is missing on purpose: it needs a server we do not have, and
  // the spec's own rule is not to ship a control that does nothing.
  const alerts = h("section", "set-group");
  alerts.innerHTML =
    `<span class="eyebrow set-head">ALERTS</span>` +
    switchRow("DESKTOP NOTIFICATIONS", "notifications", s.notifications) +
    switchRow("QUIET HOURS", "quietOn", !!s.quietHours) +
    (s.quietHours ? `
      <div class="set-row set-sub">
        <span class="set-label muted">NO ALERTS BETWEEN</span>
        <span class="hour-range">
          ${selectHtml("quietStart", HOURS, s.quietHours.start)}
          <span class="dash" aria-hidden="true">–</span>
          ${selectHtml("quietEnd", HOURS, s.quietHours.end)}
        </span>
      </div>
      <p class="set-note">Checks still run in quiet hours. Only the notification
        waits.</p>` : "") +
    switchRow("ALERT ON PRICE RISE", "alertOnRise", s.alertOnRise) +
    `<p class="set-note">Tells you when a deal you were watching has ended.</p>`;
  wrap.appendChild(alerts);

  // AUTO-STOP AFTER PURCHASE is missing on purpose too: nothing we can observe
  // tells us you bought something. See the note in the report.
  const tracking = h("section", "set-group");
  tracking.innerHTML =
    `<span class="eyebrow set-head">TRACKING</span>` +
    selectRow("DEFAULT INTERVAL", "intervalMinutes", INTERVALS, s.intervalMinutes) +
    selectRow("CURRENCY", "currency", CURRENCIES, s.currency) +
    `<p class="set-note">Used only when a page prints a price without saying
      which currency it means.</p>` +
    selectRow("KEEP HISTORY", "retentionDays", RETENTIONS, s.retentionDays) +
    switchRow("SPARKLINES IN THE LIST", "showSparklines", s.showSparklines);
  wrap.appendChild(tracking);

  const data = h("section", "set-group");
  data.innerHTML =
    `<span class="eyebrow set-head">DATA</span>` +
    (sc.confirmClear
      ? `<div class="confirm-strip">
           <span class="confirm-text">DELETE ALL ${state.items.length} ITEMS AND THEIR HISTORY?</span>
           <span class="confirm-actions">
             <button class="btn btn-danger" type="button" data-act="confirm-clear">CLEAR ALL</button>
             <button class="btn btn-outline" type="button" data-act="cancel-clear">KEEP</button>
           </span>
         </div>`
      : `<div class="data-row">
           <button class="btn btn-outline" type="button" data-act="export">EXPORT CSV</button>
           <button class="btn btn-outline" type="button" data-act="import">IMPORT</button>
           <button class="btn btn-danger" type="button" data-act="ask-clear">CLEAR ALL</button>
         </div>`) +
    (sc.status
      ? `<p class="set-status ${sc.status.ok ? "ok" : "bad"}">${escapeHtml(sc.status.msg)}</p>`
      : "");

  // Chrome closes an extension popup the moment a file dialog takes focus, and
  // the picker's result dies with it. So import takes the file's text instead
  // of the file, and export offers the same box as its fallback.
  if (sc.paste != null) {
    const box = h("div", "paste-box");
    box.innerHTML = `
      <p class="form-help">${sc.pasteMode === "export"
        ? "Copy this and save it as a .csv file."
        : "Open an exported .csv or .json file in any text editor and paste it here."}</p>
      <textarea id="dataText" class="textarea" rows="5" spellcheck="false"
                aria-label="Import or export data">${escapeHtml(sc.paste)}</textarea>
      <div class="data-row">
        ${sc.pasteMode === "export"
          ? `<button class="btn btn-outline" type="button" data-act="close-paste">DONE</button>`
          : `<button class="btn btn-solid" type="button" data-act="confirm-import">IMPORT</button>
             <button class="btn btn-outline" type="button" data-act="close-paste">CANCEL</button>`}
      </div>
    `;
    data.appendChild(box);
  }
  wrap.appendChild(data);

  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
  const foot = h("section", "set-foot");
  foot.innerHTML = `
    <div class="set-foot-line">
      <span class="ver">V${escapeHtml(version)}</span>
      <button class="btn-text" type="button" data-act="privacy"
              aria-expanded="${!!sc.privacy}">PRIVACY ${sc.privacy ? "▾" : "▸"}</button>
    </div>
    ${sc.privacy ? `<p class="set-note privacy">Everything lives in this browser.
      There is no account and no server: your list, your history and your settings
      are in local extension storage and are never sent anywhere. Checking a price
      opens the product page in a background tab, exactly as if you had visited it
      yourself — the retailer sees an ordinary page view, and nobody else sees
      anything. EXPORT CSV gives you the lot; CLEAR ALL removes it.</p>` : ""}
  `;
  wrap.appendChild(foot);
  return wrap;
}

function afterSettingsScreen() {
  const box = $("#dataText");
  if (box && state.screen.focusPaste) {
    box.focus();
    if (state.screen.pasteMode === "export") box.select();
    state.screen.focusPaste = false;
  }
}

// --- render -------------------------------------------------------------------

function listScreen() {
  const frag = document.createDocumentFragment();
  if (state.lastDeleted) frag.appendChild(undoStrip());

  const kind = state.capture.kind;
  if (kind === "found" || kind === "tracked") frag.appendChild(captureCard());
  else if (kind === "noprice") frag.appendChild(noPriceCard());

  if (!state.items.length) {
    frag.appendChild(emptyBlock(kind === "found" || kind === "tracked"));
    return frag;
  }

  if (kind === "noprice") {
    frag.appendChild(h("div", "section-label", "MEANWHILE, ON YOUR LIST"));
  }

  if (listIsManaged()) frag.appendChild(listBar());

  const body = h("div", "list-body");
  paintRows(body);
  frag.appendChild(body);
  return frag;
}

function render() {
  const name = state.screen.name;
  const onList = name === "list";

  // Screens 02 and 04 take over the whole popup: the spec replaces the masthead
  // with a back bar and drops the interval footer.
  $(".masthead").hidden = !onList;
  $(".footbar").hidden = !onList;
  if (onList) renderHeader();
  else $("#subline").hidden = true;

  const body = $("#body");
  body.textContent = "";

  if (name === "track") {
    body.appendChild(trackScreen());
    afterTrackScreen();
    return;
  }
  if (name === "detail") {
    body.appendChild(detailScreen());
    afterDetailScreen();
    return;
  }
  if (name === "settings") {
    body.appendChild(settingsScreen());
    afterSettingsScreen();
    return;
  }
  body.appendChild(listScreen());
}

// --- actions ------------------------------------------------------------------

// TRACK ↵ no longer adds straight away — it opens screen 02 so a target can be
// set first. `item` is optional: pass one to set a target on something already
// tracked, which is also what gives MATCH LOW a real number.
function openTrackScreen(detected, item) {
  state.screen = {
    name: "track",
    detected,
    item: item || null,
    target: item && item.target != null ? String(item.target) : "",
    alertOn: (item && item.alertOn) || "any",
    variants: [],
    focusTarget: true
  };
  render();
  loadVariants(detected);
}

// A Shopify store answers with its full variant list, which is the only place
// sizes reliably exist. Fetched after the screen paints so it never delays it;
// if the store is not Shopify, nothing changes and the size field stays free text.
async function loadVariants(detected) {
  if (!detected || !detected.url || typeof Adapters === "undefined") return;
  if (!Adapters.shopifyJsonUrl(detected.url)) return;
  try {
    const r = await Adapters.fromShopify(detected.url);
    if (!r || !r.variants || !r.variants.length) return;
    if (!state.screen || state.screen.name !== "track") return;
    state.screen.variants = r.variants;
    // The store's own numbers outrank anything scraped from its markup.
    const d = state.screen.detected;
    if (d && r.price > 0) {
      d.price = r.price;
      d.list = r.list;
      d.conf = "high";
      d.via = "shopify-json";
      if (r.size && !d.size) d.size = r.size;
      if (r.color && !d.color) d.color = r.color;
      if (r.sku && !d.sku) d.sku = r.sku;
    }
    render();
  } catch (e) { /* not fatal: the screen already works without it */ }
}

// Fold whatever is in the edit fields back into the reading. Called before the
// block closes and again on save, so a correction cannot be lost by tapping
// TRACK without closing the editor first.
function applyDetailEdits() {
  const d = state.screen.detected;
  if (!d || !state.screen.editingDetails) return;

  const price = parseFloat(($("#fixPrice") || {}).value);
  if (Number.isFinite(price) && price > 0 && price !== d.price) {
    d.correctedFrom = d.via;  // the layer that got it wrong, for the site rule
    d.price = price;
    d.conf = "high";          // a person looked at it; that beats any layer
    d.correctedPrice = price;
  }
  const listRaw = (($("#fixList") || {}).value || "").trim();
  d.list = listRaw === "" ? null : (Number.isFinite(parseFloat(listRaw)) ? parseFloat(listRaw) : d.list);
  if (d.list != null && d.list <= d.price) d.list = null;

  const color = (($("#fixColor") || {}).value || "").trim();
  const size = (($("#fixSize") || {}).value || "").trim();
  d.color = color;
  d.size = size;
}

async function confirmTrack() {
  const d = state.screen.detected;
  if (!d) return;
  const target = parsedTarget();
  const alertOn = target == null ? "any" : ($("#notifySel") ? $("#notifySel").value : "any");

  // CHECK EVERY writes the one global schedule — there is a single alarm, and
  // faking a per-item interval would be a dead control.
  const minutes = parseInt($("#trackInterval") ? $("#trackInterval").value : "", 10);
  if (Number.isFinite(minutes) && minutes !== state.settings.intervalMinutes) {
    state.settings = await Store.setSettings({ intervalMinutes: minutes });
    $("#interval").value = String(minutes);
    try { await chrome.runtime.sendMessage({ type: "reschedule", minutes }); } catch (e) {}
  }

  if (state.screen.item) {
    await Store.updateItem(state.screen.item.id, (it) => ({
      target,
      alertOn,
      notified: false
    }));
  } else {
    const items = await Store.getItems();
    // `confirmed` records that a person saw these details and let them stand.
    const watch = d.stock === "out" ? "stock" : "price";
    items.push(Store.makeItem(d, target, { alertOn, watch, confirmed: true }));
    await Store.setItems(items);
    // A hand-typed price teaches this site's rule, so the next reading has
    // something to be checked against.
    if (d.correctedPrice != null) {
      try { await Rules.learnCorrection(d.url, d.correctedFrom); } catch (e) {}
    }
  }

  await reload();
  const added = state.items.find((i) => i.url === d.url || i.canonical === d.canonical);
  state.capture = state.capture.detected
    ? { kind: "tracked", detected: d, item: added || null }
    : state.capture;
  state.screen = { name: "list" };
  render();
  await refreshNext();
}

async function addPastedUrl() {
  const input = $("#pasteUrl");
  const err = $("#pasteError");
  const raw = (input.value || "").trim();
  const show = (msg) => { err.textContent = msg; err.hidden = false; };
  err.hidden = true;

  let url;
  try {
    url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error("bad protocol");
  } catch (e) {
    show("That doesn't look like a web address.");
    return;
  }
  if (alreadyTracked(url.href, url.href)) {
    show("Already on your list.");
    return;
  }

  // Read the page before anything is stored. A pasted link goes through the
  // same look-before-you-track path as the button on a product page, so a
  // sold-out or unreadable page is seen rather than silently added as a stub.
  const btn = document.querySelector('[data-act="add-url"]');
  if (btn) { btn.disabled = true; btn.textContent = "READING…"; }
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "peek", url: url.href });
  } catch (e) {
    res = null;
  }
  if (btn) { btn.disabled = false; btn.textContent = "ADD"; }

  if (!res || !res.ok || !res.reading) {
    show((res && res.error) ? "Couldn't read that page — " + res.error + "."
                            : "Couldn't read a price from that page.");
    return;
  }

  const d = Object.assign({}, res.reading, {
    url: url.href,
    canonical: res.reading.canonical || url.href,
    title: res.reading.title || url.hostname.replace(/^www\./, "") + url.pathname,
    seller: res.reading.seller || Store.sellerFromUrl(url.href)
  });
  openTrackScreen(d, null);
}

async function addDemoItem() {
  const now = Date.now();
  const DAY = 86400000;
  // Synthetic but internally consistent: list 399, added at 399, now 328,
  // target 300 → 72% of the way there, 28 to go.
  const path = [[62, 399], [55, 399], [48, 389], [41, 379], [34, 369],
                [27, 352], [20, 349], [13, 338], [6, 331], [0, 328]];
  const demo = Store.normalizeItem({
    url: "https://example.com/demo/wireless-headphones",
    canonical: "https://example.com/demo/wireless-headphones",
    title: "Demo — Wireless Headphones (sample data)",
    seller: "example.com",
    currency: "USD",
    list: 399,
    target: 300,
    addedPrice: 399,
    lastPrice: 328,
    stock: "in",
    history: path.map(([d, price]) => ({ t: now - d * DAY, price })),
    createdAt: now - 62 * DAY,
    lastChecked: now - 3600000,
    lastOk: now - 3600000,
    paused: true // never actually check example.com
  });
  const items = await Store.getItems();
  items.push(demo);
  await Store.setItems(items);
  await reload();
  render();
}

async function saveTarget(id, row) {
  const input = row.querySelector('[data-role="target-input"]');
  const raw = parseFloat(input.value);
  const target = Number.isFinite(raw) && raw > 0 ? raw : null;
  await Store.updateItem(id, (it) => {
    const met = target != null ? it.lastPrice <= target : it.lastPrice < it.addedPrice;
    return { target, notified: met ? it.notified : false };
  });
  state.editing = null;
  await reload();
  render();
}

// Save the detail screen's target. An empty field means "any drop", which is a
// real setting, not a validation failure.
async function saveDetailTarget() {
  const input = $("#detailTarget");
  const raw = (input.value || "").trim();
  const n = parseFloat(raw);
  const target = raw && Number.isFinite(n) && n > 0 ? n : null;
  await Store.updateItem(state.screen.id, (it) => ({
    target,
    alertOn: target == null ? "any" : (it.alertOn || "target"),
    notified: false
  }));
  state.screen.editing = false;
  await reload();
  render();
}

// --- screen 10: snooze --------------------------------------------------------

async function applySnooze(id, kind) {
  const item = state.items.find((i) => i.id === id);
  const spec = Store.SNOOZE[kind];
  if (!item || !spec) return;

  // "UNTIL IT DROPS" is a mute against a price, so it needs a price to measure
  // against. The chip is disabled without one; this is the belt to that braces.
  if (kind === "drop" && !(item.lastPrice > 0)) return;

  const patch = kind === "drop"
    ? { snoozeUntil: 0, snoozeKind: "drop", muteUntilBelow: item.lastPrice,
        notified: false, notifiedRise: false }
    : { snoozeUntil: Date.now() + spec.ms, snoozeKind: kind, muteUntilBelow: null,
        notified: false, notifiedRise: false };

  await Store.updateItem(id, patch);
  state.snoozing = null;
  await reload();
  render();
}

async function resumeItem(id) {
  await Store.updateItem(id, {
    snoozeUntil: 0, snoozeKind: "", muteUntilBelow: null, paused: false
  });
  await reload();
  render();
}

// Clear the failure streak, then check this one item straight away. Clearing
// first is what makes the check happen at all: `isCheckable` refuses an item
// that has already given up, so a retry that left the count alone would be a
// button that did nothing.
async function retryItem(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "CHECKING…"; }
  await Store.updateItem(id, { failCount: 0, lastError: "" });
  try {
    await chrome.runtime.sendMessage({ type: "checkOne", id });
  } catch (e) { /* worker asleep — the reload below still shows the cleared state */ }
  await reload();
  render();
}

async function deleteItem(id) {
  // Remember it before it goes, so UNDO can put it back where it was.
  const index = state.items.findIndex((i) => i.id === id);
  const item = index >= 0 ? state.items[index] : null;

  await Store.removeItem(id);
  state.confirmDelete = null;
  state.snoozing = null;
  state.lastDeleted = item ? { item, index } : null;
  // Deleting from the detail screen leaves nothing to look at.
  if (state.screen.name === "detail" && state.screen.id === id) {
    state.screen = { name: "list" };
  }
  await reload();
  // The page may now be trackable again.
  if (state.capture.kind === "tracked" && state.capture.item && state.capture.item.id === id) {
    state.capture = { kind: "found", detected: state.capture.detected };
  }
  render();
}

async function undoDelete() {
  const stash = state.lastDeleted;
  if (!stash) return;
  const items = await Store.getItems();
  // Guard against the same product having been re-added in the meantime.
  if (!items.some((i) => i.id === stash.item.id)) {
    items.splice(Math.min(stash.index, items.length), 0, stash.item);
    await Store.setItems(items);
  }
  state.lastDeleted = null;
  await reload();
  await detectCurrentPage();
  render();
}

// A restore offer, not a toast: it stays until used or dismissed, because a
// popup can close at any moment and a timed banner would be missed.
function undoStrip() {
  const box = h("div", "undo-strip");
  box.innerHTML = `
    <span class="undo-text">Removed ${escapeHtml(state.lastDeleted.item.title)}</span>
    <span class="undo-actions">
      <button class="btn btn-outline" type="button" data-act="undo-delete">UNDO</button>
      <button class="btn-text" type="button" data-act="dismiss-undo"
              aria-label="Dismiss">&#10005;</button>
    </span>
  `;
  return box;
}

// --- screen 12: settings actions ----------------------------------------------

async function toggleSetting(key) {
  const s = state.settings;
  const patch = key === "quietOn"
    ? { quietHours: s.quietHours ? null : { start: 22, end: 8 } }
    : { [key]: !s[key] };
  state.settings = await Store.setSettings(patch);
  render();
}

async function changeSetting(key, raw) {
  const s = state.settings;
  let patch = null;
  if (key === "intervalMinutes") {
    const minutes = parseInt(raw, 10);
    patch = { intervalMinutes: minutes };
    const foot = $("#interval");
    if (foot) foot.value = String(minutes);
    try { await chrome.runtime.sendMessage({ type: "reschedule", minutes }); } catch (e) {}
  } else if (key === "retentionDays") {
    patch = { retentionDays: parseInt(raw, 10) };
  } else if (key === "currency") {
    patch = { currency: String(raw) };
  } else if (key === "quietStart" || key === "quietEnd") {
    const q = Object.assign({ start: 22, end: 8 }, s.quietHours || {});
    q[key === "quietStart" ? "start" : "end"] = parseInt(raw, 10);
    patch = { quietHours: q };
  }
  if (!patch) return;
  state.settings = await Store.setSettings(patch);
  render();
  if (key === "intervalMinutes") await refreshNext();
}

function stampToday() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

async function exportCsv() {
  const csv = Store.toCsv(state.items);
  const filename = `price-tracker-${stampToday()}.csv`;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "export", csv, filename });
  } catch (e) {
    res = { ok: false, error: "the background worker didn't answer" };
  }
  if (res && res.ok) {
    state.screen.status = { ok: true, msg: `SAVED ${state.items.length} ITEMS · ${filename}` };
    state.screen.paste = null;
  } else {
    // Never a dead end: if the download will not start, hand over the text.
    state.screen.status = { ok: false,
      msg: "COULDN'T SAVE A FILE — " + String((res && res.error) || "unknown reason").toUpperCase() };
    state.screen.paste = csv;
    state.screen.pasteMode = "export";
    state.screen.focusPaste = true;
  }
  render();
}

async function runImport() {
  const box = $("#dataText");
  const text = box ? box.value : "";
  const r = await Store.importText(text);
  if (!r.ok) {
    state.screen.status = { ok: false, msg: r.error };
    render();
    return;
  }
  // Say what happened to every record, including the ones that did not land.
  const bits = [`IMPORTED ${r.imported}`];
  if (r.duplicates) bits.push(`${r.duplicates} ALREADY TRACKED`);
  if (r.skipped) bits.push(`${r.skipped} UNREADABLE`);
  state.screen.status = { ok: r.imported > 0, msg: bits.join(" · ") };
  if (r.imported) {
    state.screen.paste = null;
    await reload();
  }
  render();
}

async function clearAll() {
  await Store.setItems([]);
  await reload();
  state.screen.confirmClear = false;
  state.screen.status = { ok: true, msg: "LIST CLEARED" };
  if (state.capture.kind === "tracked") {
    state.capture = { kind: "found", detected: state.capture.detected };
  }
  render();
}

async function onBodyClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const row = btn.closest(".row");
  // Rows carry their own id; the detail screen is about a single item already.
  const id = (row && row.dataset.id) ||
    (state.screen.name === "detail" ? state.screen.id : null);

  // --- screen 02 -------------------------------------------------------------
  if (act === "back") {
    state.screen = { name: "list" };
    render();
    return;
  }
  if (act === "quick") {
    state.screen.target = btn.dataset.v;
    const input = $("#targetInput");
    if (input) input.value = btn.dataset.v;
    syncTrackButton();
    return;
  }
  if (act === "open-details") { state.screen.detailsOpen = true; render(); return; }
  if (act === "edit-details") { state.screen.editingDetails = true; render(); return; }
  if (act === "cancel-details") { applyDetailEdits(); state.screen.editingDetails = false; render(); return; }
  if (act === "confirm-track") { applyDetailEdits(); return confirmTrack(); }
  if (act === "capture-target") {
    return openTrackScreen(state.capture.detected, state.capture.item);
  }

  // --- screen 04 -------------------------------------------------------------
  if (act === "point") {
    const i = parseInt(btn.dataset.i, 10);
    if (Number.isFinite(i)) {
      state.screen.sel = i;
      render();
    }
    return;
  }
  if (act === "edit-detail-target") {
    state.screen.editing = true;
    state.screen.focusTarget = true;
    render();
    return;
  }
  if (act === "save-detail-target") return saveDetailTarget();
  if (act === "open-product") {
    const item = state.items.find((i) => i.id === state.screen.id);
    if (item) chrome.tabs.create({ url: item.url });
    return;
  }
  if (act === "toggle-pause") {
    const item = state.items.find((i) => i.id === state.screen.id);
    if (!item) return;
    await Store.updateItem(item.id, { paused: !item.paused });
    await reload();
    render();
    return;
  }
  if (act === "retry-item") return retryItem(state.screen.id, btn);

  // --- screen 01 -------------------------------------------------------------
  if (act === "track") {
    return openTrackScreen(state.capture.detected, null);
  }
  if (act === "add-url") return addPastedUrl();
  if (act === "demo") return addDemoItem();

  // --- screen 07 -------------------------------------------------------------
  if (act === "sort") return setView({ sort: btn.dataset.v, seeAll: false });
  if (act === "filter") {
    const key = btn.dataset.v;
    const filters = state.view.filters.slice();
    const at = filters.indexOf(key);
    if (at >= 0) filters.splice(at, 1); else filters.push(key);
    return setView({ filters, seeAll: false });
  }
  if (act === "see-all") { state.view.seeAll = true; render(); return; }
  if (act === "see-less") { state.view.seeAll = false; render(); return; }
  if (act === "clear-view") return setView({ q: "", filters: [], seeAll: false });

  // --- screen 10 -------------------------------------------------------------
  if (act === "open-snooze") {
    state.snoozing = state.snoozing === id ? null : id;
    state.confirmDelete = null;
    render();
    return;
  }
  if (act === "close-snooze") { state.snoozing = null; render(); return; }
  if (act === "snooze") return applySnooze(id, btn.dataset.v);
  if (act === "resume") return resumeItem(id);
  if (act === "ask-delete") { state.confirmDelete = id; render(); return; }
  if (act === "cancel-delete") { state.confirmDelete = null; render(); return; }
  if (act === "confirm-delete") return deleteItem(id);
  if (act === "undo-delete") return undoDelete();
  if (act === "dismiss-undo") { state.lastDeleted = null; render(); return; }

  // --- screen 12 -------------------------------------------------------------
  if (act === "toggle") return toggleSetting(btn.dataset.key);
  if (act === "export") return exportCsv();
  if (act === "import") {
    state.screen.paste = "";
    state.screen.pasteMode = "import";
    state.screen.focusPaste = true;
    state.screen.status = null;
    render();
    return;
  }
  if (act === "confirm-import") return runImport();
  if (act === "close-paste") {
    state.screen.paste = null;
    render();
    return;
  }
  if (act === "ask-clear") { state.screen.confirmClear = true; render(); return; }
  if (act === "cancel-clear") { state.screen.confirmClear = false; render(); return; }
  if (act === "confirm-clear") return clearAll();
  if (act === "privacy") {
    state.screen.privacy = !state.screen.privacy;
    render();
    return;
  }

  if (act === "open") {
    const item = state.items.find((i) => i.id === id);
    if (item) chrome.tabs.create({ url: item.url });
    return;
  }
  if (act === "set-target") {
    state.editing = id;
    render();
    const input = $(`.row[data-id="${CSS.escape(id)}"] [data-role="target-input"]`);
    if (input) input.focus();
    return;
  }
  if (act === "save-target") return saveTarget(id, row);
  if (act === "cancel-target") {
    state.editing = null;
    render();
    return;
  }
  if (act === "more") {
    state.screen = { name: "detail", id, sel: null, editing: false };
    render();
    return;
  }
}

// The primary button on screen 02 announces what it will do. Updating it in
// place keeps the caret where the user left it.
function syncTrackButton() {
  const b = $("#trackConfirm");
  if (b) b.textContent = trackButtonLabel();
  const sel = $("#notifySel");
  // "Only at target" is meaningless with no target, so it follows the field.
  if (sel) {
    const has = parsedTarget() != null;
    sel.querySelector('option[value="target"]').disabled = !has;
    if (!has) sel.value = "any";
    else if (state.screen.alertOn === "target") sel.value = "target";
  }
}

function onBodyInput(e) {
  if (e.target.id === "targetInput") {
    state.screen.target = e.target.value;
    syncTrackButton();
    return;
  }
  // Repaint the rows alone, so the caret stays where it is being typed.
  if (e.target.id === "listSearch") {
    state.view.q = e.target.value;
    state.view.seeAll = false;
    const body = $(".list-body");
    if (body) paintRows(body); else render();
  }
}

function onBodyChange(e) {
  if (e.target.dataset && e.target.dataset.key) {
    return changeSetting(e.target.dataset.key, e.target.value);
  }
  if (e.target.id === "notifySel") state.screen.alertOn = e.target.value;
  if (e.target.id === "detailAlert") {
    Store.updateItem(state.screen.id, { alertOn: e.target.value })
      .then(reload)
      .then(render);
  }
}

// Enter should commit the inline target, the pasted URL, and the two screens
// that have a single obvious primary action.
function onBodyKeydown(e) {
  if (e.key === "Escape" && state.screen.name !== "list") {
    state.screen = { name: "list" };
    render();
    return;
  }
  if (e.key !== "Enter") return;
  if (e.target.matches('[data-role="target-input"]')) {
    e.preventDefault();
    const row = e.target.closest(".row");
    saveTarget(row.dataset.id, row);
  } else if (e.target.id === "pasteUrl") {
    e.preventDefault();
    addPastedUrl();
  } else if (e.target.id === "targetInput") {
    e.preventDefault();
    confirmTrack();
  } else if (e.target.id === "detailTarget") {
    e.preventDefault();
    saveDetailTarget();
  }
}

// --- init ---------------------------------------------------------------------

// The service worker has no window, so it cannot tell a light toolbar from a
// dark one. The popup can, and reports it so the worker picks the right icon.
function reportToolbarTheme() {
  try {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    chrome.runtime.sendMessage({ type: "themeHint", dark }).catch(() => {});
  } catch (e) { /* worker asleep — it re-applies the stored hint on wake */ }
}

async function init() {
  state.settings = await Store.getSettings();
  $("#interval").value = String(state.settings.intervalMinutes);
  reportToolbarTheme();

  // Screen 07 picks up where it left off. Unknown names are dropped rather than
  // trusted, so an old or hand-edited setting cannot blank the list.
  if (SORTS[state.settings.listSort]) state.view.sort = state.settings.listSort;
  state.view.filters = (state.settings.listFilters || []).filter((k) => FILTERS[k]);

  $("#openSettings").addEventListener("click", () => {
    state.screen = { name: "settings" };
    render();
  });

  $("#body").addEventListener("click", onBodyClick);
  $("#body").addEventListener("keydown", onBodyKeydown);
  $("#body").addEventListener("input", onBodyInput);
  $("#body").addEventListener("change", onBodyChange);

  $("#checkNow").addEventListener("click", async () => {
    const b = $("#checkNow");
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "CHECKING…";
    try {
      await chrome.runtime.sendMessage({ type: "checkAll" });
    } catch (e) { /* worker asleep or no items — the list below still redraws */ }
    await reload();
    render();
    await refreshNext();
    b.disabled = false;
    b.textContent = label;
  });

  $("#interval").addEventListener("change", async (e) => {
    const minutes = parseInt(e.target.value, 10);
    await Store.setSettings({ intervalMinutes: minutes });
    try { await chrome.runtime.sendMessage({ type: "reschedule", minutes }); } catch (err) {}
    await refreshNext();
  });

  await reload();
  render();          // paint the list before the page probe returns
  await refreshNext();
  setInterval(tick, 1000);

  await detectCurrentPage();
  render();
}

init();
