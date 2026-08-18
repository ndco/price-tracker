// SVG price charts. Pure string generation — no DOM, no storage, no chrome APIs,
// so the popup can render it and Node can test it. Attaches to globalThis the
// same way compute.js does.
//
// Scaling note: both charts are emitted at their natural pixel size with a
// matching viewBox and the default `xMidYMid meet` aspect ratio. Stretching a
// chart with preserveAspectRatio="none" would smear stroke widths and squash the
// breakpoint dots into ellipses, so we don't. Stroked paths also carry
// vector-effect="non-scaling-stroke", which keeps hairlines at one device pixel
// if a container ever scales the whole drawing down.
(function (root) {
  "use strict";

  const DAY = 86400000;

  const PALETTE = {
    ink: "#1C1E1B",
    drop: "#1F7A4D",
    rise: "#B4441F",
    line: "rgba(28, 30, 27, 0.78)",
    faint: "rgba(28, 30, 27, 0.22)",
    zone: "rgba(31, 122, 77, 0.10)"
  };

  const SPARK = {
    width: 316, height: 36,
    // Enough room top and bottom that the endpoint dot never touches the frame.
    padL: 1, padR: 6, padT: 6, padB: 6,
    stroke: 1.5, dot: 3
  };

  const DETAIL = {
    width: 316, height: 132,
    padL: 4, padR: 8, padT: 10, padB: 10,
    stroke: 1.75, dot: 3.25, bigDot: 4.25, hit: 9,
    breakPct: 3
  };

  // --- helpers ------------------------------------------------------------------

  // Valid, chronological history. Everything downstream indexes into this, so
  // the popup uses `series()` too — a click on dot 3 always means point 3.
  function series(item) {
    const hist = (item && item.history) || [];
    return hist
      .filter((h) => h && isFinite(h.t) && isFinite(h.price))
      .slice()
      .sort((a, b) => a.t - b.t);
  }

  function num(v) {
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
  }

  function targetOf(item) {
    const t = item && item.target;
    return t == null || !isFinite(t) ? null : t;
  }

  // Map data space onto the box. Handles the three shapes that break naive
  // charting: no points, one point, and every price identical.
  function scaleFor(item, cfg) {
    const pts = series(item);
    const target = targetOf(item);
    const x0 = cfg.padL;
    const x1 = cfg.width - cfg.padR;
    const y0 = cfg.padT;
    const y1 = cfg.height - cfg.padB;

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.price < lo) lo = p.price;
      if (p.price > hi) hi = p.price;
    }
    if (!pts.length) {
      lo = hi = target != null ? target : 0;
    }
    // The target line has to be inside the frame or it means nothing.
    if (target != null) {
      lo = Math.min(lo, target);
      hi = Math.max(hi, target);
    }

    let span = hi - lo;
    if (!(span > 0)) {
      // Flat line: invent a symmetric window so the line sits mid-box instead
      // of dividing by zero.
      const pad = Math.max(1, Math.abs(hi) * 0.05);
      lo -= pad;
      hi += pad;
      span = hi - lo;
    }

    const first = pts.length ? pts[0].t : 0;
    const last = pts.length ? pts[pts.length - 1].t : 0;
    const tspan = last - first;

    function X(i) {
      if (pts.length <= 1) return x1;
      // Time-proportional when the stamps spread out, evenly spaced when they
      // don't (a burst of same-millisecond points still has to draw).
      const f = tspan > 0 ? (pts[i].t - first) / tspan : i / (pts.length - 1);
      return x0 + (x1 - x0) * f;
    }
    function Y(v) {
      return y1 - ((v - lo) / span) * (y1 - y0);
    }

    return { pts, target, x0, x1, y0, y1, lo, hi, span, X, Y };
  }

  // Points whose move from the previous reading is worth a fatter dot. Kept
  // local so this file stays dependency-free; compute.js owns the labels.
  function significant(item, minPct) {
    const pts = series(item);
    const threshold = minPct == null ? DETAIL.breakPct : minPct;
    const flags = pts.map(() => false);
    for (let i = 1; i < pts.length; i++) {
      const from = pts[i - 1].price;
      if (!(from > 0)) continue;
      const pct = ((pts[i].price - from) / from) * 100;
      if (Math.abs(pct) >= threshold) flags[i] = true;
    }
    return flags;
  }

  function atTarget(item) {
    const t = targetOf(item);
    if (t == null) return false;
    const pts = series(item);
    const last = pts.length ? pts[pts.length - 1].price : item && item.lastPrice;
    return isFinite(last) && last <= t;
  }

  function frame(cfg, inner, cls, label) {
    return (
      `<svg class="${cls}" width="${cfg.width}" height="${cfg.height}" ` +
      `viewBox="0 0 ${cfg.width} ${cfg.height}" ` +
      `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" ` +
      `role="img" aria-label="${label}">${inner}</svg>`
    );
  }

  // Target threshold: a tinted floor plus the dashed line that caps it.
  function targetLayer(s, colors) {
    if (s.target == null) return "";
    const y = num(s.Y(s.target));
    const height = num(Math.max(0, s.y1 - y));
    const zone = height > 0
      ? `<rect x="${num(s.x0)}" y="${y}" width="${num(s.x1 - s.x0)}" height="${height}" fill="${colors.zone}"/>`
      : "";
    return (
      zone +
      `<line x1="${num(s.x0)}" y1="${y}" x2="${num(s.x1)}" y2="${y}" ` +
      `stroke="${colors.drop}" stroke-width="1" stroke-dasharray="3 2" ` +
      `vector-effect="non-scaling-stroke"/>`
    );
  }

  function polyline(s, colors, width) {
    const coords = s.pts.map((p, i) => `${num(s.X(i))},${num(s.Y(p.price))}`).join(" ");
    return (
      `<polyline class="chart-line" points="${coords}" fill="none" stroke="${colors.line}" ` +
      `stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" ` +
      `vector-effect="non-scaling-stroke"/>`
    );
  }

  function endpoint(s, item, cfg, colors) {
    if (!s.pts.length) return "";
    const i = s.pts.length - 1;
    const hit = atTarget(item);
    const fill = hit ? colors.drop : colors.ink;
    return (
      `<circle class="chart-end" cx="${num(s.X(i))}" cy="${num(s.Y(s.pts[i].price))}" ` +
      `r="${cfg.dot}" fill="${fill}" stroke="#F7F5EF" stroke-width="1"/>`
    );
  }

  // --- public charts ------------------------------------------------------------

  // Row sparkline (screen 01). No dots but the endpoint — at 34px tall anything
  // more is mud.
  function sparkline(item, opts) {
    const cfg = Object.assign({}, SPARK, opts || {});
    const colors = Object.assign({}, PALETTE, (opts && opts.colors) || {});
    const s = scaleFor(item, cfg);

    let inner = targetLayer(s, colors);
    inner += polyline(s, colors, cfg.stroke);
    inner += endpoint(s, item, cfg, colors);
    return frame(cfg, inner, "spark", "Price history sparkline");
  }

  // Detail chart (screen 04). Every point gets a dot, and every dot gets an
  // oversized transparent hit circle so a 3px target is still clickable.
  function detail(item, opts) {
    const cfg = Object.assign({}, DETAIL, opts || {});
    const colors = Object.assign({}, PALETTE, (opts && opts.colors) || {});
    const s = scaleFor(item, cfg);
    const flags = significant(item, cfg.breakPct);
    const selected = opts && opts.selected != null ? opts.selected : null;
    const hit = atTarget(item);

    // A long history would turn into a solid bar of circles. Past the cap only
    // the meaningful moves and the endpoints keep their dot.
    const cap = cfg.maxDots == null ? 40 : cfg.maxDots;
    const dense = s.pts.length > cap;

    let inner = targetLayer(s, colors);

    // Baseline, so an all-equal history still reads as a chart.
    inner += `<line x1="${num(s.x0)}" y1="${num(s.y1)}" x2="${num(s.x1)}" y2="${num(s.y1)}" ` +
      `stroke="${colors.faint}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;

    inner += polyline(s, colors, cfg.stroke);

    for (let i = 0; i < s.pts.length; i++) {
      const isLast = i === s.pts.length - 1;
      const isFirst = i === 0;
      const show = !dense || flags[i] || isLast || isFirst || i === selected;
      if (!show) continue;

      const cx = num(s.X(i));
      const cy = num(s.Y(s.pts[i].price));
      const isSel = i === selected;
      const r = flags[i] ? cfg.bigDot : cfg.dot;

      // The last point is drawn by endpoint() below — drawing it twice would
      // muddy the emphasis. It still needs its hit circle.
      if (!isLast) {
        inner +=
          `<circle class="chart-dot${isSel ? " is-sel" : ""}" cx="${cx}" cy="${cy}" r="${r}" ` +
          `fill="${isSel ? colors.ink : "#F7F5EF"}" stroke="${colors.ink}" ` +
          `stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
      } else if (isSel) {
        inner +=
          `<circle class="chart-dot is-sel" cx="${cx}" cy="${cy}" r="${cfg.hit - 3}" ` +
          `fill="none" stroke="${hit ? colors.drop : colors.ink}" stroke-width="1" ` +
          `vector-effect="non-scaling-stroke"/>`;
      }
      inner +=
        `<circle class="chart-hit" cx="${cx}" cy="${cy}" r="${cfg.hit}" fill="transparent" ` +
        `data-act="point" data-i="${i}"><title>Point ${i + 1}</title></circle>`;
    }

    inner += endpoint(s, item, cfg, colors);
    return frame(cfg, inner, "detail-chart", "Price history chart");
  }

  root.PTChart = {
    DAY, PALETTE, SPARK, DETAIL,
    series, significant, atTarget, scaleFor,
    sparkline, detail
  };
})(typeof self !== "undefined" ? self : globalThis);
