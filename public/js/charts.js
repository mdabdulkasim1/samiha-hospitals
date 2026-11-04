/* Chart primitives shared by the money screens. */
(function () {
  'use strict';

  /*
   * Money in and money out, in two colours that survive colour-blindness.
   *
   * Not the obvious green and red: that pair separates by about 6 under
   * deutan vision, which is the floor, and a clinic's accounts should not be
   * where somebody discovers they cannot read a chart. Blue against burnt
   * orange — both already tokens in this app — separates by 23 under protan
   * and 25 under tritan.
   *
   * There is no third colour, deliberately. A green added to these two drops
   * the worst pair to 3.6 under tritan, so a third measure gets a chart of
   * its own rather than a hue nobody can distinguish. Profit is drawn by
   * position above and below a zero line, which needs no colour at all.
   */
  const IN_HUE = '#1C6FB5';
  const OUT_HUE = '#A8500C';

  /*
   * A fixed canvas, scaled as a whole rather than stretched.
   *
   * Stretching an SVG to its container (preserveAspectRatio="none") distorts
   * everything in it — a 22-unit column becomes an 80px slab when there are
   * four of them, and the labels come out wide and wrong with it. A constant
   * viewBox scaled uniformly keeps a column a column: thin, capped, with the
   * rest of its band left as air.
   */
  const W = 1200;
  const MAX_BAR = 22;
  const GAP = 2;

  /**
   * A tick scale over a range that lands on round numbers, and reads 1K
   * rather than 1000.
   *
   * It takes both ends, not just the top, because a measure that can go
   * negative has to be drawn against a scale that reaches wherever it went.
   * Scaling from zero while the line dips to -246% squeezes every label on
   * the chart into the top quarter, and the reader is left with a row of
   * overlapping numbers instead of an axis.
   */
  function scale(lo, hi) {
    const range = (hi - lo) || Math.abs(hi) || 1;
    const raw = range / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    const bottom = Math.floor(lo / step) * step;
    const top = Math.ceil(hi / step) * step;
    const marks = [];
    for (let v = bottom; v <= top + step / 1000; v += step) marks.push(Math.round(v * 1e6) / 1e6);
    // A short chart has no room for eight labels; drop every other one
    // rather than print them on top of each other.
    return { bottom, top: top || 1, marks: marks.length > 6 ? marks.filter((_, i) => !(i % 2)) : marks };
  }

  /** The same, for the usual case of a measure that starts at zero. */
  function ticks(max) {
    if (max <= 0) return { top: 1, marks: [0, 1] };
    const { top, marks } = scale(0, max);
    return { top, marks };
  }

  const compact = (n) => {
    const a = Math.abs(n);
    if (a >= 1e7) return `${Math.round(n / 1e5) / 100}Cr`;
    if (a >= 1e5) return `${Math.round(n / 1e3)}K`;
    if (a >= 1e3) return `${Math.round(n / 100) / 10}K`;
    return String(Math.round(n));
  };

  /** The period a bucket stands for, however the series was cut. */
  const bucketLabel = (at, by) => {
    if (by === 'week') return `w/c ${UI.dateShort(at)}`;
    if (by === 'month') return new Date(`${at}T00:00:00`)
      .toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    return UI.dateShort(at);
  };

  const legend = (pairs) => `<div class="chart-legend">${pairs.map(([label, hue]) =>
    `<span><i style="background:${hue}"></i>${UI.esc(label)}</span>`).join('')}</div>`;

  /** A column with a rounded data end and a square foot on the baseline. */
  function columnPath(x, bar, top, baseline) {
    const r = Math.min(4, Math.abs(baseline - top) / 2);
    const up = top <= baseline;
    return up
      ? `M${x} ${baseline} L${x} ${top + r} Q${x} ${top} ${x + r} ${top}
         L${x + bar - r} ${top} Q${x + bar} ${top} ${x + bar} ${top + r} L${x + bar} ${baseline} Z`
      : `M${x} ${baseline} L${x} ${top - r} Q${x} ${top} ${x + r} ${top}
         L${x + bar - r} ${top} Q${x + bar} ${top} ${x + bar} ${top - r} L${x + bar} ${baseline} Z`;
  }

  const hit = (i, band, h, pad, tip) =>
    `<rect x="${i * band}" y="0" width="${band}" height="${h - pad}" class="c-hit" tabindex="0"
       data-tip="${UI.esc(JSON.stringify(tip))}"/>`;

  /*
   * The date rail. Each point gets an equal cell, so a label is only as wide
   * as the chart divided by the number of periods — at thirty days that is
   * sixteen pixels, and "6 Oct" does not fit in sixteen pixels. Printing
   * every other one does not help, because the hidden one does not give its
   * width to its neighbour. So the labels are allowed to overflow their cell
   * (see .chart-axis in app.css) and enough of them are dropped to leave the
   * survivors somewhere to overflow into.
   */
  const axis = (points, by) => {
    const stride = points.length <= 12 ? 1 : Math.ceil(points.length / 8);
    return `<div class="chart-axis" style="--n:${points.length}">${points.map((p, i) =>
      `<span>${i % stride ? '' : UI.esc(bucketLabel(p.at, by))}</span>`).join('')}</div>`;
  };

  const tickRail = (marks, y, h, fmt = compact) =>
    `<div class="chart-ticks">${marks.map((m) =>
      `<span style="top:${(y(m) / h) * 100}%">${UI.esc(fmt(m))}</span>`).join('')}</div>`;

  /**
   * Two measures per period, side by side on one scale.
   *
   * One scale because they are both rupees, and because a second y-axis would
   * let any pair of numbers be drawn as whatever story the axes were chosen to
   * tell. Labelled sparingly — the highest of each — since a number on every
   * column is noise; the rest are on hover and in the table underneath.
   */
  function pairedColumns(points, by, opts = {}) {
    const a = opts.a || { key: 'income', label: 'Money in', hue: IN_HUE };
    const b = opts.b || { key: 'expense', label: 'Money out', hue: OUT_HUE };
    const h = opts.height || 190;
    const pad = 26;
    if (!points.length) return UI.empty(opts.emptyText || 'Nothing in this period.', '📊');

    const { top, marks } = ticks(Math.max(...points.map((p) => Math.max(p[a.key], p[b.key])), 0));
    const band = W / points.length;
    const bar = Math.min(MAX_BAR, Math.max(6, (band - GAP - 10) / 2));
    const y = (v) => (h - pad) - (v / top) * (h - pad - 10);
    const peak = (key) => points.reduce((m, p) => (p[key] > m[key] ? p : m), points[0]);

    const col = (p, i, series, side) => {
      if (!(p[series.key] > 0)) return '';
      const x = i * band + band / 2 + (side === 'left' ? -(bar + GAP / 2) : GAP / 2);
      return `<path d="${columnPath(x, bar, y(p[series.key]), h - pad)}" fill="${series.hue}"/>`;
    };
    const tag = (p, i, series, side) => (p[series.key] > 0
      ? `<text x="${i * band + band / 2 + (side === 'left' ? -(bar / 2 + GAP / 2) : bar / 2 + GAP / 2)}"
           y="${y(p[series.key]) - 6}" class="c-tip-label" text-anchor="middle">${
        UI.esc(compact(p[series.key]))}</text>` : '');

    const pa = peak(a.key);
    const pb = peak(b.key);
    return `${legend([[a.label, a.hue], [b.label, b.hue]])}
      <div class="chart-wrap"><svg viewBox="0 0 ${W} ${h}" class="chart"
          preserveAspectRatio="xMidYMid meet" role="img"
          aria-label="${UI.esc(a.label)} against ${UI.esc(b.label)}, by ${UI.esc(by)}">
        ${marks.map((m) => `<line x1="0" x2="${W}" y1="${y(m)}" y2="${y(m)}" class="c-grid"/>`).join('')}
        ${points.map((p, i) => col(p, i, a, 'left')).join('')}
        ${points.map((p, i) => col(p, i, b, 'right')).join('')}
        ${tag(pa, points.indexOf(pa), a, 'left')}
        ${tag(pb, points.indexOf(pb), b, 'right')}
        ${points.map((p, i) => hit(i, band, h, pad, {
    at: bucketLabel(p.at, by),
    rows: (opts.tip ? opts.tip(p) : [
      [a.label, UI.money(p[a.key])], [b.label, UI.money(p[b.key])],
      [p[a.key] - p[b.key] < 0 ? 'Shortfall' : 'Surplus', UI.money(p[a.key] - p[b.key])],
    ]),
  })).join('')}
      </svg>
      ${axis(points, by)}
      ${tickRail(marks.slice().reverse(), y, h)}
      </div>`;
  }

  /** One measure that can go either way: above the line, or below it. */
  function divergingColumns(points, by, opts = {}) {
    const key = opts.key || 'net';
    const h = opts.height || 150;
    const pad = 24;
    if (!points.length) return UI.empty(opts.emptyText || 'Nothing in this period.', '📊');

    const { top } = ticks(Math.max(...points.map((p) => Math.abs(p[key])), 1));
    const band = W / points.length;
    const bar = Math.min(MAX_BAR, Math.max(6, band - 12));
    const zero = (h - pad) / 2 + 4;
    const y = (v) => zero - (v / top) * (zero - 8);

    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${h}" class="chart"
        preserveAspectRatio="xMidYMid meet" role="img" aria-label="${UI.esc(opts.label || 'Net')}">
      <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="c-zero"/>
      ${points.map((p, i) => (p[key]
    ? `<path d="${columnPath(i * band + (band - bar) / 2, bar, y(p[key]), zero)}"
         fill="${p[key] > 0 ? IN_HUE : OUT_HUE}"/>` : '')).join('')}
      ${points.map((p, i) => hit(i, band, h, pad, {
    at: bucketLabel(p.at, by),
    rows: (opts.tip ? opts.tip(p) : [[opts.label || 'Net', UI.money(p[key])]]),
  })).join('')}
    </svg>
    ${axis(points, by)}
    ${tickRail([top, 0, -top], y, h, (m) => (m > 0 ? `+${compact(m)}` : compact(m)))}
    </div>`;
  }

  /**
   * A rate over time — a margin, a share — as a 2px line with its end
   * labelled. A percentage is not money and does not belong on a rupee axis,
   * so it gets a chart of its own rather than a second scale on somebody
   * else's.
   */
  function lineSeries(points, by, opts = {}) {
    const key = opts.key || 'value';
    const h = opts.height || 150;
    const pad = 26;
    if (points.length < 2) return UI.empty(opts.emptyText || 'Not enough history yet to show a trend.', '📈');

    const values = points.map((p) => Number(p[key]) || 0);
    const { bottom, top, marks } = scale(Math.min(0, ...values), Math.max(...values, 1));
    const span = top - bottom || 1;
    const y = (v) => (h - pad) - ((v - bottom) / span) * (h - pad - 12);
    const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - 24) + 12);
    const hue = opts.hue || IN_HUE;
    const last = points[points.length - 1];

    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${h}" class="chart"
        preserveAspectRatio="xMidYMid meet" role="img" aria-label="${UI.esc(opts.label || 'Trend')}">
      ${marks.map((m) => `<line x1="0" x2="${W}" y1="${y(m)}" y2="${y(m)}" class="c-grid"/>`).join('')}
      <path d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(Number(p[key]) || 0)}`).join(' ')}"
        fill="none" stroke="${hue}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(points.length - 1)}" cy="${y(Number(last[key]) || 0)}" r="4.5"
        fill="${hue}" stroke="#fff" stroke-width="2"/>
      <text x="${x(points.length - 1) - 10}" y="${y(Number(last[key]) || 0) - 10}"
        class="c-tip-label" text-anchor="end">${UI.esc(opts.format ? opts.format(last[key]) : compact(last[key]))}</text>
      ${points.map((p, i) => `<rect x="${x(i) - (W / points.length) / 2}" y="0"
        width="${W / points.length}" height="${h - pad}" class="c-hit" tabindex="0"
        data-tip="${UI.esc(JSON.stringify({
    at: bucketLabel(p.at, by),
    rows: (opts.tip ? opts.tip(p)
      : [[opts.label || 'Value', opts.format ? opts.format(p[key]) : compact(p[key])]]),
  }))}"/>`).join('')}
    </svg>
    ${axis(points, by)}
    ${tickRail(marks.slice().reverse(), y, h, opts.format || compact)}
    </div>`;
  }

  /*
   * The hover layer. Every column answers for its whole bucket rather than
   * for the one series the pointer happens to be over — somebody comparing
   * two months wants both numbers at once — and the hit area is the full
   * band, not the painted pixels, so the figure does not depend on aim.
   * Keyboard focus shows the same thing.
   */
  function wireHovers(scope) {
    let tip = document.getElementById('chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'chart-tip';
      tip.className = 'chart-tip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    const show = (target, px, py) => {
      let data;
      try { data = JSON.parse(target.dataset.tip); } catch { return; }
      tip.textContent = '';
      const head = document.createElement('div');
      head.className = 'tip-head';
      // Labels come back from the server; they go in as text, never markup.
      head.textContent = data.at;
      tip.appendChild(head);
      for (const [label, value] of data.rows) {
        const row = document.createElement('div');
        row.className = 'tip-row';
        const v = document.createElement('b');
        v.textContent = value;
        const l = document.createElement('span');
        l.textContent = label;
        row.append(v, l);
        tip.appendChild(row);
      }
      tip.hidden = false;
      const box = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(px - box.width / 2, 8), window.innerWidth - box.width - 8)}px`;
      tip.style.top = `${Math.max(py - box.height - 14, 8)}px`;
    };
    const hide = () => { tip.hidden = true; };

    scope.querySelectorAll('.c-hit').forEach((el) => {
      el.addEventListener('pointermove', (e) => show(el, e.clientX, e.clientY));
      el.addEventListener('pointerleave', hide);
      el.addEventListener('focus', () => {
        const b = el.getBoundingClientRect();
        show(el, b.left + b.width / 2, b.top);
      });
      el.addEventListener('blur', hide);
    });
  }

  window.CHARTS = {
    IN_HUE, OUT_HUE, ticks, scale, compact, bucketLabel, legend,
    pairedColumns, divergingColumns, lineSeries, wireHovers,
  };
})();
