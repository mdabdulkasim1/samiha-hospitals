/* The owner's board — the whole business on one page. */
(function () {
  'use strict';

  /*
   * Nobody else's, including the administrator's.
   *
   * Everywhere else an admin passes every gate, because a short-staffed
   * polyclinic needs one account that can work any desk. Here that would
   * defeat the purpose: this page is what the clinic earns, what it costs to
   * run, which doctor brings in what and what the whole thing is worth. It
   * is the owner's to read and theirs to decide who else ever does. The
   * endpoint behind it refuses everyone else, so this is not a hidden menu
   * item — it is a closed door.
   *
   * Sale and cost are used carefully, because confusing them is how a clinic
   * talks itself into a profit it has not made. Sale is money that arrived;
   * an unpaid bill is a hope and is shown separately. Cost is money that
   * left, plus what the medicines sold had cost to buy.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const PERIOD = { day: 'day', week: 'week', month: 'month' };

  APP.register('owner', {
    title: 'Owner\'s board',
    subtitle: 'Sale against cost, and what the clinic is worth',

    async render(el) {
      let by = 'month';
      let from = '';
      let to = '';

      const draw = async () => {
        el.innerHTML = UI.loading();
        const d = await API.get('/api/owner/overview' + API.qs({ by, from, to }));
        from = d.from; to = d.to;
        const t = d.totals;
        const p = d.position;

        el.innerHTML = `
          <div class="card mb"><div class="card-body owner-filters">
            <div class="tabs inline" id="o-by">
              <button data-by="day" class="${by === 'day' ? 'active' : ''}">Day by day</button>
              <button data-by="week" class="${by === 'week' ? 'active' : ''}">Week by week</button>
              <button data-by="month" class="${by === 'month' ? 'active' : ''}">Month by month</button>
            </div>
            <input type="date" id="o-from" value="${d.from}">
            <input type="date" id="o-to" value="${d.to}">
            <span class="muted small">${UI.esc(UI.date(d.from))} – ${UI.esc(UI.date(d.to))}</span>
          </div></div>

          ${headline(t, p)}

          <div class="card mb"><div class="card-head"><h3>Sale against cost</h3>
            <span class="muted small">Money that arrived, against money that left</span></div>
            <div class="card-body">${CHARTS.pairedColumns(d.points, by, {
    a: { key: 'sale', label: 'Sale', hue: CHARTS.IN_HUE },
    b: { key: 'cost', label: 'Cost', hue: CHARTS.OUT_HUE },
    height: 220,
    tip: (x) => [['Sale', money(x.sale)], ['Cost', money(x.cost)],
      [x.profit < 0 ? 'Loss' : 'Profit', money(x.profit)], ['Margin', `${x.margin}%`]],
  })}</div></div>

          <div class="grid c2 mb">
            <div class="card"><div class="card-head"><h3>Profit each ${PERIOD[by]}</h3>
              <span class="muted small">Above the line is a profit</span></div>
              <div class="card-body">${CHARTS.divergingColumns(d.points, by, {
    key: 'profit', label: 'Profit',
    tip: (x) => [[x.profit < 0 ? 'Loss' : 'Profit', money(x.profit)],
      ['Sale', money(x.sale)], ['Cost', money(x.cost)]],
  })}</div></div>
            <div class="card"><div class="card-head"><h3>Margin</h3>
              <span class="muted small">What is left of every rupee taken</span></div>
              <div class="card-body">${CHARTS.lineSeries(d.points, by, {
    key: 'margin', label: 'Margin', hue: CHARTS.IN_HUE,
    format: (v) => `${Math.round(Number(v) || 0)}%`,
    tip: (x) => [['Margin', `${x.margin}%`], ['Sale', money(x.sale)], ['Cost', money(x.cost)]],
  })}</div></div>
          </div>

          <div class="grid c2 mb">
            <div class="card"><div class="card-head"><h3>Patients through the door</h3>
              <span class="muted small">Visits, ${PERIOD[by]} by ${PERIOD[by]}</span></div>
              <div class="card-body">${CHARTS.lineSeries(d.points, by, {
    key: 'visits', label: 'Visits', hue: CHARTS.OUT_HUE,
    format: (v) => String(Math.round(Number(v) || 0)),
    tip: (x) => [['Visits', UI.num(x.visits)], ['New patients', UI.num(x.patients)],
      ['Sale', money(x.sale)]],
  })}</div></div>
            <div class="card"><div class="card-head"><h3>What each visit is worth</h3>
              <span class="muted small">Sale divided by visits</span></div>
              <div class="card-body">${CHARTS.lineSeries(d.points, by, {
    key: 'perVisit', label: 'Per visit', hue: CHARTS.IN_HUE,
    format: (v) => `₹${CHARTS.compact(Number(v) || 0)}`,
    tip: (x) => [['Per visit', money(x.perVisit)], ['Visits', UI.num(x.visits)],
      ['Sale', money(x.sale)]],
  })}</div></div>
          </div>

          <div class="grid c2 mb">
            <div class="card"><div class="card-head"><h3>What sells</h3>
              <span class="muted small">Billed, by what it was for</span></div>
              <div class="card-body">${d.byCategory.length
    ? UI.bars(d.byCategory.map((c) => ({
      label: UI.titleise(c.category), value: c.amount, display: money(c.amount),
    })), { colour: 'income' })
    : UI.empty('Nothing billed in this period.', '🧾')}</div></div>
            <div class="card"><div class="card-head"><h3>Where it goes</h3>
              <span class="muted small">Biggest heading first</span></div>
              <div class="card-body">${d.spend.length
    ? UI.bars(d.spend.map((c) => ({
      label: c.category, value: c.amount, display: money(c.amount),
    })), { colour: 'expense' })
    : UI.empty('Nothing in the cash book for this period.', '💸')}</div></div>
          </div>

          ${pharmacyCard(d.pharmacy)}

          <div class="card mb"><div class="card-head"><h3>Doctor by doctor</h3>
            <span class="muted small">Visits seen and what those visits billed</span></div>
            <div class="card-body tight">${UI.table([
    { label: 'Doctor', render: (x) => `<b>${UI.esc(x.doctor)}</b>` +
      `<div class="muted small">${UI.esc(x.department || '—')}</div>` },
    { label: 'Visits', num: true, render: (x) => UI.num(x.visits) },
    { label: 'Billed', num: true, render: (x) => money(x.billed) },
    { label: 'Per visit', num: true, render: (x) =>
      money(x.visits ? x.billed / x.visits : 0) },
    { label: 'Share of billing', render: (x) => share(x.billed,
      d.byDoctor.reduce((s, y) => s + y.billed, 0)) },
  ], d.byDoctor, { emptyText: 'No consultations in this period.' })}</div></div>

          ${positionCard(p)}

          <details class="card"><summary class="card-head" style="cursor:pointer">
              <h3 style="display:inline">The same figures as a table</h3></summary>
            <div class="card-body tight">${table(d.points, by)}</div></details>`;

        el.querySelectorAll('#o-by button').forEach((b) => b.addEventListener('click', () => {
          by = b.dataset.by;
          // A new cut wants its own default window, not the last one's.
          from = ''; to = '';
          draw();
        }));
        el.querySelector('#o-from').addEventListener('change', (e) => { from = e.target.value; draw(); });
        el.querySelector('#o-to').addEventListener('change', (e) => { to = e.target.value; draw(); });
        CHARTS.wireHovers(el);
      };

      await draw();
    },
  });

  /** The four numbers an owner looks at before anything else. */
  const headline = (t, p) => `
    <div class="grid c4 mb">
      <div class="stat ok"><div class="label">Sale</div>
        <div class="value">${money(t.sale)}</div>
        <div class="foot">${money(t.billed)} billed · ${money(t.counter)} counter${
  t.otherIncome ? ` · ${money(t.otherIncome)} other` : ''}</div></div>
      <div class="stat orange"><div class="label">Cost</div>
        <div class="value">${money(t.cost)}</div>
        <div class="foot">${money(t.expense)} run the clinic · ${money(t.medicineCost)} medicines sold</div></div>
      <div class="stat ${t.profit < 0 ? 'crimson' : 'teal'}">
        <div class="label">${t.profit < 0 ? 'Loss' : 'Profit'}</div>
        <div class="value">${money(t.profit)}</div>
        <div class="foot">${UI.esc(t.margin)}% of everything taken</div></div>
      <div class="stat crimson"><div class="label">Owed to the clinic</div>
        <div class="value">${money(p.outstanding)}</div>
        <div class="foot">${UI.num(p.outstandingBills)} unpaid or part-paid bills</div></div>
    </div>
    <div class="grid c3 mb">
      <div class="stat teal"><div class="label">Patients seen</div>
        <div class="value">${UI.num(t.visits)}</div>
        <div class="foot">${UI.num(t.newPatients)} registered for the first time</div></div>
      <div class="stat teal"><div class="label">Sale per visit</div>
        <div class="value">${money(t.perVisit)}</div>
        <div class="foot">Across every visit in the period</div></div>
      <!-- Not "cash position": none of this is cash. It is money the clinic
           has already spent and is holding in a form it cannot pay a
           supplier with, which is the opposite thing. -->
      <div class="stat ok"><div class="label">Tied up in stock and kit</div>
        <div class="value">${money(p.stockValue + p.assetValue)}</div>
        <div class="foot">${money(p.stockValue)} on the shelf · ${money(p.assetValue)} in equipment</div></div>
    </div>`;

  /*
   * The medicine counter, where a true gross margin can be quoted — every
   * pack dispensed names the batch it came from and every batch carries what
   * it cost. Where a batch has no purchase price the cost is understated,
   * so the margin would read better than it is; the card says how many lines
   * that applies to rather than letting the figure stand unqualified.
   */
  const pharmacyCard = (ph) => `
    <div class="card mb"><div class="card-head"><h3>The medicine counter</h3>
      <span class="muted small">The one margin this system knows exactly</span></div>
      <div class="card-body">
        <div class="grid c4">
          <div class="stat ok"><div class="label">Sold</div>
            <div class="value">${money(ph.sold)}</div>
            <div class="foot">${UI.num(ph.lines)} lines dispensed</div></div>
          <div class="stat orange"><div class="label">Cost of those packs</div>
            <div class="value">${money(ph.cost)}</div>
            <div class="foot">What the clinic paid for them</div></div>
          <div class="stat teal"><div class="label">Gross</div>
            <div class="value">${money(ph.gross)}</div>
            <div class="foot">Before anything else the counter costs to run</div></div>
          <div class="stat ${ph.margin < 15 ? 'crimson' : 'ok'}"><div class="label">Margin</div>
            <div class="value">${UI.esc(ph.margin)}%</div>
            <div class="foot">On what went out of the door</div></div>
        </div>
        ${ph.unpriced_lines ? `<div class="alert warn mt">
          <b>${UI.num(ph.unpriced_lines)} of ${UI.num(ph.lines)} lines came from a batch with no
          purchase price on file.</b> Their cost counts as nothing, so the margin above reads
          better than the clinic actually earned. Enter the purchase price when stock is
          received and this figure becomes true.</div>` : ''}
      </div></div>`;

  const positionCard = (p) => `
    <div class="card mb"><div class="card-head"><h3>What the clinic is holding</h3>
      <span class="muted small">Not this period's trading — what is tied up and what is owed</span></div>
      <div class="card-body"><dl class="kv">
        <dt>Owed to the clinic</dt><dd><b>${money(p.outstanding)}</b>
          <span class="muted small">across ${UI.num(p.outstandingBills)} bills</span></dd>
        <dt>Owed to suppliers</dt><dd>${money(p.supplierDue)}</dd>
        <dt>Medicines on the shelf</dt><dd>${money(p.stockValue)}
          <span class="muted small">at what they cost</span></dd>
        <dt>Equipment and furniture</dt><dd>${money(p.assetValue)}
          <span class="muted small">at purchase price, before any depreciation</span></dd>
      </dl>
      <div class="muted small mt">None of these are in the profit above. A bill not yet paid has
        not been earned, and stock is money already spent and not yet sold.</div>
      </div></div>`;

  const share = (part, whole) => {
    const v = whole > 0 ? Math.round((part / whole) * 100) : 0;
    return `<span class="share"><i style="width:${v}%"></i></span><span class="muted small">${v}%</span>`;
  };

  const table = (points, by) => UI.table([
    { label: { week: 'Week beginning', month: 'Month', day: 'Date' }[by],
      render: (p) => UI.esc(by === 'month' ? CHARTS.bucketLabel(p.at, by) : UI.date(p.at)) },
    { label: 'Visits', num: true, render: (p) => UI.num(p.visits) },
    { label: 'Billed', num: true, render: (p) => money(p.billed) },
    { label: 'Counter', num: true, render: (p) => money(p.counter) },
    { label: 'Other', num: true, render: (p) => money(p.otherIncome) },
    { label: 'Sale', num: true, render: (p) => `<b>${money(p.sale)}</b>` },
    { label: 'Running costs', num: true, render: (p) => money(p.expense) },
    { label: 'Medicines sold', num: true, render: (p) => money(p.medicineCost) },
    { label: 'Cost', num: true, render: (p) => `<b>${money(p.cost)}</b>` },
    { label: 'Profit', num: true, render: (p) => `<b style="color:${
      p.profit < 0 ? 'var(--danger)' : 'var(--ok)'}">${money(p.profit)}</b>` },
    { label: 'Margin', num: true, render: (p) => `${UI.esc(p.margin)}%` },
  ], points.slice().reverse(), { emptyText: 'Nothing in this period.' });
})();
