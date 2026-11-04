/* The commercial eye — whether the work was worth doing. */
(function () {
  'use strict';

  /*
   * The owner's headline board answers "what came in". This answers the
   * harder question, and it rests on three distinctions the screens repeat
   * out loud wherever they could be misread:
   *
   *   Billed is not collected. Everything here is revenue earned, net of
   *   discounts. A department's margin cannot be judged by how fast its
   *   patients happen to pay.
   *
   *   Purchased is not consumed. Medicines are charged at the cost of the
   *   packs that actually went out, priced at the batch they came from.
   *   What was bought is cash flow and is shown separately.
   *
   *   Direct is not overhead. Contribution is given first, because it is the
   *   number the department controls. Operating profit comes after shared
   *   costs are spread by revenue share, which is a convention and is
   *   labelled as one.
   *
   * Where the clinic does not record something, the screen says so rather
   * than printing a plausible number. An honest gap is a finding.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const pc = (v) => (v === null || v === undefined ? '—' : `${UI.esc(v)}%`);
  const signed = (n) => `${Number(n) > 0 ? '+' : ''}${money(n)}`;

  const CAUSE_LABEL = {
    volume: 'Patient volume', price: 'Pricing', discount: 'Discounts',
    mix: 'Service mix', purchase_cost: 'Purchase prices', wastage: 'Wastage',
    other: 'Something else',
  };

  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const monthName = (p) => new Date(`${p}-01T00:00:00`)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  /** Render the whole commercial eye into `host` for one month. */
  async function render(host, period, onPeriod) {
    host.innerHTML = UI.loading();
    const d = await API.get(`/api/owner/commercial${API.qs({ period })}`);

    host.innerHTML = `
      <div class="card mb"><div class="card-body owner-filters">
        <label class="inline-label">Month
          <input type="month" id="ce-period" value="${UI.esc(period)}" max="${UI.esc(thisMonth())}">
        </label>
        <span class="muted small">${UI.esc(monthName(period))} ·
          figures are what was <b>earned</b>, net of discounts — not what was collected</span>
        <button class="btn ghost sm" id="ce-budget" style="margin-left:auto">Set the budget</button>
      </div></div>

      ${breakEvenCard(d.breakEven, d.comparison)}
      ${departmentCard(d.departments)}
      ${comparisonCard(d.comparison)}
      ${indicatorCard(d.indicators)}
      ${slippingCard(d.slipping, d.departments)}
      ${actionCard(d.actions)}`;

    host.querySelector('#ce-period').addEventListener('change', (e) => {
      if (e.target.value) onPeriod(e.target.value);
    });
    host.querySelector('#ce-budget').addEventListener('click', () =>
      openBudget(period, () => onPeriod(period)));

    const add = host.querySelector('#ce-add-action');
    if (add) add.addEventListener('click', () => openAction({ period }, () => onPeriod(period)));
    host.querySelectorAll('[data-act-id]').forEach((b) => b.addEventListener('click', () => {
      const row = d.actions.find((a) => String(a.id) === b.dataset.actId);
      openAction(row, () => onPeriod(period));
    }));
    host.querySelectorAll('[data-raise]').forEach((b) => b.addEventListener('click', () => {
      openAction({
        period,
        area: b.dataset.raise,
        finding: b.dataset.finding || '',
      }, () => onPeriod(period));
    }));
    CHARTS.wireHovers(host);
  }

  /* ------------------------------------------------------------ break-even
   *
   * First on the page, because it is the one number that answers "did this
   * month pay for itself" before any of the detail explains why.
   */
  function breakEvenCard(b, c) {
    const pbt = c.rows.find((r) => r.key === 'profitBeforeTax') || {};
    const ahead = b.surplus !== null && b.surplus >= 0;
    /*
     * The rail is scaled to whichever is bigger, the revenue or the line it
     * had to clear, so both always fit and the gap between them is drawn to
     * scale. Filling the bar to 100% and putting the marker elsewhere made a
     * month that scraped over the line look identical to one that doubled it.
     */
    const span = Math.max(b.revenue, b.required || 0) || 1;
    const fill = Math.round((b.revenue / span) * 100);
    const mark = b.required === null ? null : Math.round((b.required / span) * 100);

    return `
      <div class="card mb"><div class="card-head"><h3>Did the month pay for itself?</h3>
        <span class="muted small">Break-even is fixed costs divided by the contribution margin</span></div>
        <div class="card-body">
          <div class="grid c4 mb">
            <div class="stat ok"><div class="label">Revenue earned</div>
              <div class="value">${money(b.revenue)}</div>
              <div class="foot">Net of discounts and refunds</div></div>
            <div class="stat orange"><div class="label">Break-even revenue</div>
              <div class="value">${b.required === null ? '—' : money(b.required)}</div>
              <div class="foot">${money(b.fixed)} of fixed cost ÷ ${pc(b.contributionRatio)} margin</div></div>
            <div class="stat ${ahead ? 'teal' : 'crimson'}">
              <div class="label">${ahead ? 'Clear of break-even by' : 'Short of break-even by'}</div>
              <div class="value">${b.surplus === null ? '—' : money(Math.abs(b.surplus))}</div>
              <div class="foot">${b.coverage === null ? 'No margin to divide by yet'
    : `Revenue reached ${pc(b.coverage)} of what was needed`}</div></div>
            <div class="stat ${Number(pbt.actual) < 0 ? 'crimson' : 'teal'}">
              <div class="label">${Number(pbt.actual) < 0 ? 'Loss before tax' : 'Profit before tax'}</div>
              <div class="value">${money(pbt.actual)}</div>
              <div class="foot">${pbt.previous !== undefined
    ? `${signed(pbt.change)} on last month` : ''}</div></div>
          </div>

          <div class="be-rail" title="Revenue against break-even">
            <i style="width:${fill}%" class="${ahead ? 'ok' : 'short'}"></i>
            ${mark === null ? '' : `<b style="left:${mark}%"></b>`}
          </div>
          <div class="be-legend muted small">
            <span>₹0</span>
            <span>${ahead ? 'Revenue' : 'Break-even'} ${money(Math.max(b.revenue, b.required || 0))}</span>
          </div>
          <div class="muted small" style="margin-top:4px">The marker is break-even
            ${b.required === null ? '' : `at ${money(b.required)}`}; the bar is what was
            actually earned.</div>

          <details class="mt"><summary class="muted small" style="cursor:pointer">
            What counts as a fixed cost here</summary>
            <div class="mt">${UI.table([
    { label: 'Heading', render: (r) => UI.esc(r.category) },
    { label: 'This month', num: true, render: (r) => money(r.amount) },
  ], b.fixedRows, { emptyText: 'No fixed costs recorded in the period.' })}
            <p class="muted small mt">${UI.esc(b.note)}
              Variable overheads of ${money(b.variableOverhead)} are left out of the
              fixed figure because they move with the work.</p></div>
          </details>
        </div></div>`;
  }

  /* --------------------------------------------- 1. department by department */
  function departmentCard(d) {
    const rows = d.rows;
    const chart = rows.filter((r) => r.revenue > 0);

    return `
      <div class="card mb"><div class="card-head"><h3>Department by department</h3>
        <span class="muted small">What each part earns, what it costs, and what is left</span></div>
        <div class="card-body">
          ${chart.length ? CHARTS.pairedColumns(
    chart.map((r) => ({ at: r.key, label: r.label, revenue: r.revenue, direct: r.direct,
      contribution: r.contribution, margin: r.margin })),
    'dept',
    {
      a: { key: 'revenue', label: 'Net revenue', hue: CHARTS.IN_HUE },
      b: { key: 'direct', label: 'Direct costs', hue: CHARTS.OUT_HUE },
      height: 210,
      labels: chart.map((r) => r.label),
      tip: (x) => [['Revenue', money(x.revenue)], ['Direct costs', money(x.direct)],
        ['Contribution', money(x.contribution)], ['Margin', pc(x.margin)]],
    }
  ) : UI.empty('Nothing billed in this month.', '🏥')}

          <div class="mt">${UI.table([
    { label: 'Department', render: (r) => `<b>${UI.esc(r.label)}</b>` +
      (r.exact ? '' : '<div class="muted small">⚠ see the note below</div>') },
    { label: 'Net revenue', num: true, render: (r) => money(r.revenue) },
    { label: 'Direct costs', num: true, render: (r) => (r.direct
      ? money(r.direct) : '<span class="muted">none recorded</span>') },
    { label: 'Contribution', num: true, render: (r) => `<b>${money(r.contribution)}</b>` },
    { label: 'Margin', num: true, render: (r) => pc(r.margin) },
    { label: 'Volume', num: true, render: (r) =>
      `${UI.num(r.units)}<div class="muted small">${UI.esc(r.unitPlural)}</div>` },
    { label: 'Contribution each', num: true, render: (r) => (r.perUnit === null
      ? '—' : `<b>${money(r.perUnit)}</b><div class="muted small">per ${UI.esc(r.unit)}</div>`) },
    { label: 'Share of overheads', num: true, render: (r) => money(r.allocated) },
    { label: 'Operating profit', num: true, render: (r) => `<b style="color:${
      r.operatingProfit < 0 ? 'var(--danger)' : 'var(--ok)'}">${money(r.operatingProfit)}</b>` +
      `<div class="muted small">${pc(r.operatingMargin)}</div>` },
  ], rows, { emptyText: 'Nothing billed in this month.' })}</div>

          <div class="grid c2 mt">
            <div>
              <h4 class="muted small">Totals</h4>
              <dl class="kv">
                <dt>Net revenue</dt><dd><b>${money(d.totals.revenue)}</b></dd>
                <dt>Direct costs</dt><dd>${money(d.totals.direct)}</dd>
                <dt>Contribution</dt><dd><b>${money(d.totals.contribution)}</b>
                  <span class="muted small">${pc(d.totals.margin)} of revenue</span></dd>
                <dt>Shared costs spread</dt><dd>${money(d.totals.allocated)}
                  <span class="muted small">including ${money(d.overhead.depreciation)} depreciation</span></dd>
                <dt>Operating profit</dt><dd><b>${money(d.totals.operatingProfit)}</b></dd>
              </dl>
              <p class="muted small mt">This will not equal the operating profit in the
                monthly statement below, and should not. Only what a patient was billed can
                be attributed to a department: income that was never billed to one — a
                health camp, rent received — and refunds taken off the top sit in the
                statement and not here.</p>
            </div>
            <div>
              <h4 class="muted small">What was spread, and how</h4>
              ${UI.bars(d.overhead.rows.slice(0, 6).map((r) => ({
    label: r.category, value: r.amount, display: money(r.amount),
  })), { colour: 'expense' })}
              <p class="muted small mt">${UI.esc(d.overhead.basis)}
                That is a convention, not a measurement — a busy department carries
                more of the rent simply for being busy.</p>
            </div>
          </div>

          ${d.wastage.total ? `<div class="alert warn mt">
            <b>${money(d.wastage.total)} of stock was written off this month.</b>
            ${money(d.wastage.expired)} expired and ${money(d.wastage.adjusted)} was
            adjusted out across ${UI.num(d.wastage.entries)} entries. This is the one
            cost on this page that is entirely avoidable.</div>` : ''}

          ${d.unmapped.length ? `<div class="alert warn mt">
            <b>${d.unmapped.length} spending heading${d.unmapped.length > 1 ? 's are' : ' is'}
            not classified yet</b> — ${UI.esc(d.unmapped.map((u) => u.category).join(', '))},
            ${money(d.unmapped.reduce((t, u) => t + u.amount, 0))} in all. They are being
            treated as shared overhead. If any is really the direct cost of one
            department, that department's margin is flattering until it is reclassified.</div>` : ''}

          ${rows.some((r) => r.caveats.length) ? `<div class="alert mt">
            <b>What these figures can and cannot know</b>
            <ul class="tight-list">${rows.filter((r) => r.caveats.length).map((r) =>
    `<li><b>${UI.esc(r.label)}:</b> ${r.caveats.map((c) => UI.esc(c)).join(' ')}</li>`).join('')}</ul>
          </div>` : ''}
        </div></div>`;
  }

  /* ----------------------------------------- 2. the monthly comparison report */
  function comparisonCard(c) {
    const cell = (r) => {
      if (r.difference === null) return '<span class="muted">not budgeted</span>';
      const good = r.favourable;
      return `<b style="color:${good ? 'var(--ok)' : 'var(--danger)'}">${signed(r.difference)}</b>` +
        (r.differencePct !== null ? `<div class="muted small">${pc(r.differencePct)}</div>` : '');
    };

    return `
      <div class="card mb"><div class="card-head"><h3>${UI.esc(monthName(c.period))} against budget</h3>
        <span class="muted small">and against ${UI.esc(monthName(c.previousPeriod))}</span></div>
        <div class="card-body tight">${UI.table([
    { label: 'Particulars', render: (r) => (r.kind === 'subtotal' || r.kind === 'total'
      ? `<b>${UI.esc(r.label)}</b>` : UI.esc(r.label)) },
    { label: 'Budget ₹', num: true, render: (r) => (r.budget === null
      ? '<span class="muted">—</span>' : money(r.budget)) },
    { label: 'Actual ₹', num: true, render: (r) => (r.kind === 'subtotal' || r.kind === 'total'
      ? `<b>${money(r.actual)}</b>` : money(r.actual)) },
    { label: 'Difference ₹', num: true, render: cell },
    { label: 'Previous month ₹', num: true, render: (r) => money(r.previous) },
    { label: 'Change', num: true, render: (r) => `<span style="color:${
      (r.kind === 'cost' ? r.change <= 0 : r.change >= 0) ? 'var(--ok)' : 'var(--danger)'
    }">${signed(r.change)}</span>` },
  ], c.rows, { emptyText: '' })}</div>

        <div class="card-body">
          <div class="alert">
            <b>How this statement is built</b>
            <ul class="tight-list">
              <li>${UI.esc(c.basis.revenue)}</li>
              <li>${UI.esc(c.basis.medicines)}</li>
              <li><b>${money(c.basis.purchases)}</b> of stock and equipment was bought this
                month. ${UI.esc(c.basis.purchasesNote)}</li>
              ${c.basis.refunds ? `<li>${money(c.basis.refunds)} of refunds has been taken
                off revenue rather than added to costs.</li>` : ''}
              ${c.basis.unpricedLines ? `<li><b>${UI.num(c.basis.unpricedLines)} medicine
                lines</b> came from a batch with no purchase price, so the medicines figure
                is understated and the profit above is flattering.</li>` : ''}
              <li>Depreciation is straight line over each asset's life.
                ${c.basis.depreciation.guessedLife
    ? `${UI.num(c.basis.depreciation.guessedLife)} of ${UI.num(c.basis.depreciation.assets)}
       assets have no life entered, so a default for their category was used.` : ''}
                ${c.basis.depreciation.noPrice
    ? `${UI.num(c.basis.depreciation.noPrice)}
       asset${c.basis.depreciation.noPrice > 1 ? 's have' : ' has'} no purchase price and
       could not be depreciated at all.` : ''}</li>
            </ul>
          </div>
        </div></div>`;
  }

  /* -------------------------------------------------- 3. the key indicators */
  function indicatorCard(list) {
    return `
      <div class="card mb"><div class="card-head"><h3>Cost-to-revenue indicators</h3>
        <span class="muted small">Each one shown with the two figures it came from</span></div>
        <div class="card-body"><div class="grid c3">
          ${list.map((i) => `
            <div class="ind">
              <div class="ind-head">
                <span class="label">${UI.esc(i.label)}</span>
                <b class="value">${i.value === null ? '—'
    : (i.unit === '₹' ? money(i.value) : `${UI.esc(i.value)}%`)}</b>
              </div>
              ${i.ofRevenue !== undefined && i.ofRevenue !== null
    ? `<div class="muted small">${pc(i.ofRevenue)} of revenue</div>` : ''}
              <dl class="kv tiny">${i.of.map(([k, v]) =>
    `<dt>${UI.esc(k)}</dt><dd>${v === null ? '—' : money(v)}</dd>`).join('')}</dl>
              <div class="muted small ind-why">${UI.esc(i.why)}</div>
              <div class="muted small ind-formula"><code>${UI.esc(i.formula)}</code></div>
              ${i.caveat ? `<div class="ind-caveat">⚠ ${UI.esc(i.caveat)}</div>` : ''}
            </div>`).join('')}
        </div>
        <p class="muted small mt">A ratio is a question, not a verdict. Ask whether the
          move came from patient volume, pricing, discounts, service mix, purchase prices
          or wastage before deciding what to do about it — and write the answer into the
          action log below, with a name and a date against it.</p>
        </div></div>`;
  }

  /* -------------------------------------------- departments going the wrong way */
  function slippingCard(rows) {
    if (!rows.length) {
      return `<div class="card mb"><div class="card-head"><h3>Margins going the wrong way</h3></div>
        <div class="card-body"><div class="alert ok-soft">No department's margin fell by more
          than two points against the previous month of the same length.</div></div></div>`;
    }
    return `
      <div class="card mb"><div class="card-head"><h3>Margins going the wrong way</h3>
        <span class="muted small">Against the previous period of the same length</span></div>
        <div class="card-body tight">${UI.table([
    { label: 'Department', render: (r) => `<b>${UI.esc(r.label)}</b>` },
    { label: 'Margin now', num: true, render: (r) => pc(r.margin) },
    { label: 'Was', num: true, render: (r) => pc(r.previous) },
    { label: 'Move', num: true, render: (r) =>
      `<b style="color:var(--danger)">${UI.esc(r.move)} pts</b>` },
    { label: 'Revenue now', num: true, render: (r) => money(r.revenue) },
    { label: 'Was', num: true, render: (r) => money(r.previousRevenue) },
    { label: '', render: (r) => `<button class="btn sm" data-raise="${UI.esc(r.key)}"
        data-finding="${UI.esc(`${r.label} margin fell ${Math.abs(r.move)} points, from ${r.previous}% to ${r.margin}%`)}"
        >Raise an action</button>` },
  ], rows, { emptyText: '' })}</div></div>`;
  }

  /* ------------------------------------------------- 4. what is being done */
  function actionCard(rows) {
    const overdue = (a) => a.due_date && a.status !== 'done' && a.status !== 'dropped'
      && a.due_date < new Date().toISOString().slice(0, 10);
    return `
      <div class="card mb"><div class="card-head"><h3>Corrective action</h3>
        <span class="muted small">A finding without a name and a date against it changes nothing</span>
        <button class="btn sm" id="ce-add-action" style="margin-left:auto">+ Raise an action</button></div>
        <div class="card-body tight">${UI.table([
    { label: 'What was seen', render: (a) => `<b>${UI.esc(a.finding)}</b>` +
      (a.area ? `<div class="muted small">${UI.esc(a.area)}${a.period ? ` · ${UI.esc(a.period)}` : ''}</div>` : '') },
    { label: 'Cause', render: (a) => (a.cause
      ? UI.badge(CAUSE_LABEL[a.cause] || a.cause, 'teal')
      : '<span class="muted">not yet established</span>') },
    { label: 'What is being done', render: (a) => UI.esc(a.action) },
    { label: 'Who', render: (a) => UI.esc(a.responsible) },
    { label: 'By when', render: (a) => (a.due_date
      ? `${UI.esc(UI.date(a.due_date))}${overdue(a) ? ' ' + UI.badge('Overdue', 'danger') : ''}`
      : '<span class="muted">no date</span>') },
    { label: 'Status', render: (a) => UI.badge(UI.titleise(a.status),
      a.status === 'done' ? 'ok' : a.status === 'open' ? 'warn' : a.status === 'dropped' ? '' : 'teal') },
    { label: '', render: (a) => `<button class="btn ghost sm" data-act-id="${a.id}">Update</button>` },
  ], rows, { emptyText: 'Nothing raised yet. Use "Raise" beside a department, or the button above.' })}</div></div>`;
  }

  /* --------------------------------------------------------------- the forms */

  async function openBudget(period, onDone) {
    const d = await API.get(`/api/owner/budget/${period}`);
    const have = {};
    for (const b of d.budget) have[b.line] = b.amount;

    UI.modal({
      title: `Budget for ${monthName(period)}`,
      size: 'wide',
      body: `<form id="bg-form">
        <p class="muted small">A budget is the one figure on the owner's board that cannot be
          measured — it is a decision. Leave a line blank and it reads "not budgeted" rather
          than as a budget of nothing, because the variance column has to tell those apart.
          Last month's actuals are beside each box as a starting point.</p>
        <table class="budget-table"><thead><tr>
          <th>Line</th><th class="num">Last month ₹</th><th class="num">Budget ₹</th>
        </tr></thead><tbody>
          ${d.lines.map((l) => `<tr>
            <td>${UI.esc(l.label)}</td>
            <td class="num muted">${money(d.previous[l.key])}</td>
            <td class="num"><input type="number" step="0.01" name="${UI.esc(l.key)}"
              value="${have[l.key] === undefined ? '' : UI.esc(have[l.key])}"
              placeholder="${UI.esc(Math.round(Number(d.previous[l.key]) || 0))}"></td>
          </tr>`).join('')}
        </tbody></table>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ghost" data-act="copy">Copy last month</button>
               <button class="btn" data-act="save">Save the budget</button>`,
      onAction: async (act, modal) => {
        if (act === 'copy') {
          modal.querySelectorAll('#bg-form input[name]').forEach((i) => {
            i.value = Math.round(Number(d.previous[i.name]) || 0);
          });
          // 'keep' is what holds a modal open; anything else closes it, and
          // filling the boxes in only to have the dialog vanish is not a
          // starting point, it is a lost one.
          return 'keep';
        }
        if (act !== 'save') return;
        const budget = {};
        modal.querySelectorAll('#bg-form input[name]').forEach((i) => {
          budget[i.name] = i.value === '' ? null : i.value;
        });
        await API.put(`/api/owner/budget/${period}`, { budget });
        UI.ok('Budget saved.');
        if (onDone) onDone();
      },
    });
  }

  function openAction(a, onDone) {
    const editing = Boolean(a && a.id);
    UI.modal({
      title: editing ? 'Update the action' : 'Raise an action',
      size: 'narrow',
      body: `<form id="ac-form">
        ${UI.field({ name: 'finding', label: 'What the numbers showed', required: true,
          type: 'textarea', rows: 2, value: a.finding || '',
          hint: 'The observation, not the fix.' })}
        ${UI.field({ name: 'cause', label: 'Where it came from', value: a.cause || '',
          options: [{ value: '', label: '— not yet established —' }]
            .concat(Object.entries(CAUSE_LABEL).map(([v, l]) => ({ value: v, label: l }))),
          hint: 'Ask Accounts to establish this before deciding what to do.' })}
        ${UI.field({ name: 'action', label: 'What is being done about it', required: true,
          type: 'textarea', rows: 2, value: a.action || '' })}
        <div class="grid c2">
          ${UI.field({ name: 'responsible', label: 'Who is doing it', required: true,
            value: a.responsible || '', placeholder: 'A name, not a department' })}
          ${UI.field({ name: 'dueDate', label: 'By when', type: 'date', value: a.due_date || '' })}
        </div>
        ${editing ? UI.field({ name: 'status', label: 'Status', value: a.status || 'open',
          options: ['open', 'in_progress', 'done', 'dropped']
            .map((s) => ({ value: s, label: UI.titleise(s) })) }) : ''}
        ${editing ? UI.field({ name: 'outcome', label: 'What happened', type: 'textarea',
          rows: 2, value: a.outcome || '' }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${editing ? 'Save' : 'Raise it'}</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#ac-form'));
        if (editing) await API.patch(`/api/owner/actions/${a.id}`, v);
        else await API.post('/api/owner/actions', { ...v, period: a.period, area: a.area });
        UI.ok(editing ? 'Updated.' : 'Raised.');
        if (onDone) onDone();
      },
    });
  }

  window.OWNER_COMMERCIAL = { render };
})();
