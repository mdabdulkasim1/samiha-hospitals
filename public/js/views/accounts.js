/* Accounts & Expenses — the clinic's own cash book, and the picture it makes. */
(function () {
  'use strict';

  /*
   * Two jobs on one screen, and deliberately two different sets of people.
   *
   * Writing the book down — the rent, the salaries, the cash handed to a
   * supplier at the door — is the cashier's, the counsellor's and the
   * administrator's, because whoever handles the money knows what left the
   * drawer. Reading it as a whole is the administrator's and the financial
   * counsellor's: the overview answers "are we losing money", which is a
   * question the clinic is run from rather than one a counter is handed.
   *
   * The server enforces that split — the summary endpoint refuses a cashier —
   * and this screen simply does not offer a tab it knows will be refused.
   */
  const ENTRY = ['cashier', 'counselor'];
  const OVERVIEW = ['counselor'];

  /*
   * Money in and money out, in two colours that survive colour-blindness.
   *
   * Not the obvious green and red: that pair sits at a deutan separation of
   * about 6, which is the floor, and a clinic's accounts should not be the
   * place somebody discovers they cannot read a chart. Blue against burnt
   * orange — both already tokens in this app — separates at 23 under protan
   * and 25 under tritan, and the legend and the table carry the identity
   * besides, so nothing rests on colour alone.
   */

  const PERIOD = { day: 'day', week: 'week', month: 'month' };
  const money = (n) => UI.money(Number(n) || 0);
  const isEntry = () => APP.can(ENTRY);
  const isOverview = () => APP.can(OVERVIEW);

  APP.register('accounts', {
    title: 'Accounts & Expenses',
    subtitle: 'The clinic\'s cash book and where the money goes',

    async render(el, params) {
      const tabs = {};
      if (isOverview()) tabs.overview = overviewTab;
      if (isEntry()) tabs.book = bookTab;

      const names = Object.keys(tabs);
      if (!names.length) {
        el.innerHTML = '<div class="alert danger">Your role does not have access to the accounts.</div>';
        return;
      }
      const open = tabs[params.tab] ? params.tab : names[0];

      el.innerHTML = `
        <div class="tabs" id="ac-tabs">
          ${isOverview() ? `<button data-tab="overview" class="${open === 'overview' ? 'active' : ''}">Overview</button>` : ''}
          ${isEntry() ? `<button data-tab="book" class="${open === 'book' ? 'active' : ''}">Cash book</button>` : ''}
        </div>
        <div id="ac-body">${UI.loading()}</div>`;

      const body = el.querySelector('#ac-body');
      el.querySelectorAll('#ac-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#ac-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await tabs[open](body);
    },
  });

  // ------------------------------------------------------------- the cash book
  async function bookTab(body) {
    const state = {
      from: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      direction: '',
    };

    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>Cash book</h3>
        <input type="date" id="cb-from" value="${state.from}" style="max-width:165px">
        <input type="date" id="cb-to" value="${state.to}" style="max-width:165px">
        <select id="cb-dir" style="max-width:160px">
          <option value="">Everything</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
        <input type="search" id="cb-q" placeholder="Payee, reference…" style="max-width:190px">
        <button class="btn sm" id="cb-out">− Record an expense</button>
        <button class="btn sm teal" id="cb-in">+ Record income</button>
      </div>
        <div id="cb-totals"></div>
        <div class="card-body tight" id="cb-list">${UI.loading()}</div></div>
      <div class="muted small">Patient bills and pharmacy sales are <b>not</b> entered here — they are
        already recorded where they were taken, and the overview counts them from there. This book is
        for what the clinic spends, and for income no patient was billed for.</div>`;

    const load = async () => {
      const data = await API.get('/api/accounts/entries' + API.qs({
        from: body.querySelector('#cb-from').value,
        to: body.querySelector('#cb-to').value,
        direction: body.querySelector('#cb-dir').value,
        q: body.querySelector('#cb-q').value.trim(),
        limit: 200,
      }));

      body.querySelector('#cb-totals').innerHTML = `
        <div class="grid c3" style="padding:12px 16px 0">
          <div class="stat ok"><div class="label">Money in</div>
            <div class="value">${money(data.totals.money_in)}</div>
            <div class="foot">Entered in this book</div></div>
          <div class="stat orange"><div class="label">Money out</div>
            <div class="value">${money(data.totals.money_out)}</div>
            <div class="foot">${UI.num(data.totals.entries)} entries</div></div>
          <div class="stat ${data.totals.net < 0 ? 'crimson' : 'teal'}"><div class="label">Net in this book</div>
            <div class="value">${money(data.totals.net)}</div>
            <div class="foot">Before patient collections</div></div>
        </div>`;

      const host = body.querySelector('#cb-list');
      host.innerHTML = UI.table([
        { label: 'Date', render: (r) => UI.esc(UI.date(r.entry_date)) },
        { label: 'Ref', render: (r) => `<code>${UI.esc(r.ref_no)}</code>` },
        { label: 'Direction', render: (r) => r.direction === 'in'
          ? UI.badge('In', 'ok') : UI.badge('Out', 'orange') },
        { label: 'Heading', render: (r) => UI.esc(r.category) },
        { label: 'Paid to / from', render: (r) => UI.esc(r.payee || r.supplier_name || '—') +
          (r.reference ? `<div class="muted small">${UI.esc(r.reference)}</div>` : '') },
        { label: 'Mode', render: (r) => UI.badge(UI.titleise(r.mode), '') },
        { label: 'Amount', num: true, render: (r) => r.voided_at
          ? `<s class="muted">${money(r.amount)}</s>`
          : `<b style="color:${r.direction === 'in' ? 'var(--ok)' : 'var(--orange-dark)'}">${money(r.amount)}</b>` },
        { label: 'Entered by', render: (r) => `${UI.esc(r.entered_by_name || '—')}` +
          (r.voided_at
            ? `<div class="muted small">Voided by ${UI.esc(r.voided_by_name || '—')}` +
              `${r.void_reason ? ` — ${UI.esc(r.void_reason)}` : ''}</div>`
            : '') },
        { label: '', render: (r) => r.voided_at ? ''
          : `<div class="btn-row nowrap">
               <button class="btn ghost sm" data-edit="${r.id}">Edit</button>
               <button class="btn ghost sm danger" data-void="${r.id}">Void</button></div>` },
      ], data.rows, { emptyText: 'Nothing in the book for these dates.' });

      host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
        openEntry(data.rows.find((r) => String(r.id) === b.dataset.edit), load)));
      host.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', () =>
        openVoid(data.rows.find((r) => String(r.id) === b.dataset.void), load)));
    };

    body.querySelector('#cb-out').addEventListener('click', () => openEntry({ direction: 'out' }, load));
    body.querySelector('#cb-in').addEventListener('click', () => openEntry({ direction: 'in' }, load));
    ['#cb-from', '#cb-to', '#cb-dir'].forEach((s) =>
      body.querySelector(s).addEventListener('change', load));
    body.querySelector('#cb-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    await load();
  }

  /** One entry, going in or being corrected. */
  async function openEntry(entry, onDone) {
    const editing = Boolean(entry && entry.id);
    const { categories, modes } = await API.get('/api/accounts/categories');
    const direction = entry.direction || 'out';
    const today = new Date().toISOString().slice(0, 10);

    UI.modal({
      title: editing
        ? `Edit — ${entry.ref_no}`
        : (direction === 'out' ? 'Record an expense' : 'Record income'),
      size: 'narrow',
      body: `<form id="ce-form">
        ${UI.field({ name: 'direction', label: 'Direction', value: direction, required: true,
          options: [{ value: 'out', label: 'Money out — an expense' },
                    { value: 'in', label: 'Money in — income' }] })}
        ${UI.field({ name: 'category', label: 'Heading', required: true,
          value: entry.category || '', options: categories[direction] })}
        ${UI.field({ name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01',
          required: true, value: entry.amount || '' })}
        <div class="grid c2">
          ${UI.field({ name: 'entryDate', label: 'Date the money moved', type: 'date',
            required: true, value: entry.entry_date || today, max: today,
            hint: 'The day it actually moved, not today.' })}
          ${UI.field({ name: 'mode', label: 'Paid by', value: entry.mode || 'cash',
            options: modes.map((m) => ({ value: m, label: UI.titleise(m) })) })}
        </div>
        ${UI.field({ name: 'payee', label: 'Paid to / received from', value: entry.payee || '',
          placeholder: 'Name of the supplier, landlord, staff member…' })}
        ${UI.field({ name: 'reference', label: 'Reference', value: entry.reference || '',
          placeholder: 'Bill number, cheque number, UTR' })}
        ${UI.field({ name: 'notes', label: 'Note', type: 'textarea', rows: 2, value: entry.notes || '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${editing ? 'Save changes' : 'Record it'}</button>`,
      onMount(modal) {
        // The headings differ by direction, so the list follows the choice.
        const dir = modal.querySelector('[name=direction]');
        const cat = modal.querySelector('[name=category]');
        dir.addEventListener('change', () => {
          cat.innerHTML = categories[dir.value]
            .map((c) => `<option value="${UI.esc(c)}">${UI.esc(c)}</option>`).join('');
        });
      },
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#ce-form'));
        if (!(Number(v.amount) > 0)) throw new Error('Enter an amount greater than zero.');
        if (editing) await API.patch(`/api/accounts/entries/${entry.id}`, v);
        else await API.post('/api/accounts/entries', v);
        UI.ok(editing ? 'Entry updated.' : 'Recorded in the cash book.');
        if (onDone) onDone();
      },
    });
  }

  /*
   * Voiding, not deleting. A cash book that can lose a line cannot be
   * reconciled against anything, so the line stays, struck through, with the
   * reason and the name of whoever decided it.
   */
  function openVoid(entry, onDone) {
    UI.modal({
      title: `Void ${entry.ref_no}?`,
      size: 'narrow',
      body: `<p>${UI.esc(entry.category)} — <b>${money(entry.amount)}</b> on
          ${UI.esc(UI.date(entry.entry_date))}.</p>
        <p class="muted small">The line stays in the book, struck through, and stops counting towards
          any total. It is not deleted: "that one was a mistake" is itself something the clinic may
          need to show later.</p>
        ${UI.field({ name: 'reason', label: 'Why', required: true,
          placeholder: 'Entered twice, wrong amount, wrong heading…' })}`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn danger" data-act="void">Void the entry</button>`,
      onAction: async (act, modal) => {
        if (act !== 'void') return;
        const reason = UI.formValues(modal).reason;
        if (!reason) throw new Error('Say why it is being voided.');
        await API.post(`/api/accounts/entries/${entry.id}/void`, { reason });
        UI.ok('Entry voided.');
        if (onDone) onDone();
      },
    });
  }

  // --------------------------------------------------------------- the picture
  async function overviewTab(body) {
    let by = 'day';

    const draw = async () => {
      const d = await API.get('/api/accounts/summary' + API.qs({
        by, from: body.querySelector('#ov-from') ? body.querySelector('#ov-from').value : '',
        to: body.querySelector('#ov-to') ? body.querySelector('#ov-to').value : '',
      }));

      body.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat ok"><div class="label">Money in</div>
            <div class="value">${money(d.totals.income)}</div>
            <div class="foot">${money(d.totals.billed)} billed · ${money(d.totals.counter)} counter
              · ${money(d.totals.otherIncome)} other</div></div>
          <div class="stat orange"><div class="label">Money out</div>
            <div class="value">${money(d.totals.expense)}</div>
            <div class="foot">Entered in the cash book</div></div>
          <div class="stat ${d.totals.net < 0 ? 'crimson' : 'teal'}">
            <div class="label">${d.totals.net < 0 ? 'Shortfall' : 'Surplus'}</div>
            <div class="value">${money(d.totals.net)}</div>
            <div class="foot">Over ${UI.esc(UI.date(d.from))} – ${UI.esc(UI.date(d.to))}</div></div>
          <div class="stat crimson"><div class="label">Still owed to us</div>
            <div class="value">${money(d.totals.outstanding)}</div>
            <div class="foot">Unpaid and part-paid bills</div></div>
        </div>

        <div class="card mb">
          <div class="card-head"><h3>Money in against money out</h3>
            <div class="tabs inline" id="ov-by">
              <button data-by="day" class="${by === 'day' ? 'active' : ''}">Day by day</button>
              <button data-by="week" class="${by === 'week' ? 'active' : ''}">Week by week</button>
              <button data-by="month" class="${by === 'month' ? 'active' : ''}">Month by month</button>
            </div>
            <input type="date" id="ov-from" value="${d.from}" style="max-width:160px">
            <input type="date" id="ov-to" value="${d.to}" style="max-width:160px">
          </div>
          <div class="card-body">
            ${CHARTS.pairedColumns(d.points, by)}
          </div>
        </div>

        <div class="card mb"><div class="card-head"><h3>What was left each ${PERIOD[by]}</h3>
          <span class="muted small">Above the line is a surplus, below it a shortfall</span></div>
          <div class="card-body">${CHARTS.divergingColumns(d.points, by, {
            label: 'Left over', tip: (p) => [
              [p.net < 0 ? 'Shortfall' : 'Surplus', money(p.net)],
              ['Money in', money(p.income)], ['Money out', money(p.expense)]],
          })}</div></div>

        <div class="grid c2">
          <div class="card"><div class="card-head"><h3>Where the money went</h3>
            <span class="muted small">Biggest heading first</span></div>
            <div class="card-body">${UI.bars(d.spend.map((r) => ({
              label: r.category, value: r.amount, display: money(r.amount),
            })), { colour: 'expense' })}</div></div>
          <div class="card"><div class="card-head"><h3>Income not billed to a patient</h3></div>
            <div class="card-body">${d.otherIncome.length
              ? UI.bars(d.otherIncome.map((r) => ({
                  label: r.category, value: r.amount, display: money(r.amount),
                })), { colour: 'income' })
              : UI.empty('Everything that came in was billed to a patient.', '💰')}</div></div>
        </div>

        <details class="card mt"><summary class="card-head" style="cursor:pointer">
            <h3 style="display:inline">The same figures as a table</h3></summary>
          <div class="card-body tight">${flowTable(d.points, by)}</div></details>`;

      body.querySelectorAll('#ov-by button').forEach((b) => b.addEventListener('click', () => {
        by = b.dataset.by;
        body.innerHTML = UI.loading();
        draw();
      }));
      ['#ov-from', '#ov-to'].forEach((s) => body.querySelector(s).addEventListener('change', draw));
      CHARTS.wireHovers(body);
    };

    await draw();
  }

  // ------------------------------------------------------------------- charts
  /*
   * The drawing lives in public/js/charts.js, shared with the owner's board
   * so a column means the same thing on both and there is one place to fix
   * when it does not. What stays here is the one table that belongs to this
   * screen: the same figures as rows, so no value is reachable only by
   * hovering over a chart.
   */
  const flowTable = (points, by) => UI.table([
    { label: { week: 'Week beginning', month: 'Month', day: 'Date' }[by],
      render: (p) => UI.esc(by === 'month' ? CHARTS.bucketLabel(p.at, by) : UI.date(p.at)) },
    { label: 'Billed to patients', num: true, render: (p) => money(p.billed) },
    { label: 'Pharmacy counter', num: true, render: (p) => money(p.counter) },
    { label: 'Other income', num: true, render: (p) => money(p.otherIncome) },
    { label: 'Money in', num: true, render: (p) => `<b>${money(p.income)}</b>` },
    { label: 'Money out', num: true, render: (p) => money(p.expense) },
    { label: 'Left', num: true, render: (p) => `<b style="color:${
      p.net < 0 ? 'var(--danger)' : 'var(--ok)'}">${money(p.net)}</b>` },
  ], points.slice().reverse(), { emptyText: 'Nothing in this period.' });

})();
