/* =============================================================================
   The money desk: payments and receipts, the cheque book, the group's expenses
   and income, the ledgers, and the VAT return.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  // ================================================== payments and receipts
  APP.register('payments', {
    title: 'Payments & Receipts',
    subtitle: 'Money in from clients, money out to the manufacturers',

    async render(host) {
      APP.actions(APP.can(['accounts']) ? [
        { id: 'in', label: '+ Receipt from a client', kind: 'green',
          onClick: () => openPayment({ direction: 'in' }) },
        { id: 'out', label: '+ Payment to a supplier', kind: 'gold',
          onClick: () => openPayment({ direction: 'out' }) },
      ] : []);

      host.innerHTML = `
        <div class="card">
          <div class="filters">
            <label class="field grow"><span>Search</span>
              <input id="f-q" placeholder="Voucher, reference, cheque, party…"></label>
            <label class="field"><span>Direction</span><select id="f-direction">
              <option value="">Both ways</option><option value="in">Received</option>
              <option value="out">Paid</option></select></label>
            <label class="field"><span>Status</span><select id="f-status">
              <option value="">All</option><option value="pending">Pending (post-dated)</option>
              <option value="deposited">Deposited</option><option value="cleared">Cleared</option>
              <option value="bounced">Bounced</option></select></label>
          </div>
          <div id="rows">${UI.loading()}</div>
        </div>`;

      const load = async () => {
        const box = document.getElementById('rows');
        box.innerHTML = UI.loading();
        const q = document.getElementById('f-q').value;
        const res = await API.get('/api/accounts/payments' + API.qs({
          q, direction: document.getElementById('f-direction').value,
          status: document.getElementById('f-status').value, limit: 200 }));
        box.innerHTML = UI.table([
          { label: 'Voucher', render: (r) => `<span class="mono">${esc(r.payment_no)}</span>
              ${r.enquiry_no || r.allocated_enquiries
                ? `<div class="muted small">${esc(r.enquiry_no || r.allocated_enquiries)}</div>` : ''}` },
          { label: '', render: (r) => UI.badge(r.direction === 'in' ? 'Received' : 'Paid',
            r.direction === 'in' ? 'ok' : 'gold') },
          { label: 'Party', key: 'partner_name' },
          { label: 'Date', render: (r) => UI.date(r.payment_date) },
          { label: 'Mode', render: (r) => `${UI.titleise(r.mode)}
              <div class="muted small">${esc(r.cheque_no ? 'chq ' + r.cheque_no : r.reference || '')}</div>` },
          { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.amount, { symbol: false })}</b>` },
          { label: 'Unapplied', num: true, render: (r) => (r.unapplied > 0.005
            ? `<span class="badge warn">${UI.money(r.unapplied, { symbol: false })}</span>` : '—') },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) },
        ], res.rows, { onRow: true, emptyText: 'No money has been recorded yet.' });
        UI.bindRows(box, res.rows, (row) => showPayment(row.id));
      };

      let timer = null;
      document.getElementById('f-q').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(load, 250);
      });
      host.querySelectorAll('.filters select').forEach((el) => el.addEventListener('change', load));
      await load();
    },
  });

  async function showPayment(id) {
    const d = await API.get(`/api/accounts/payments/${id}`);
    const p = d.payment;
    // Which job the money belongs to: the enquiries behind the invoices it
    // settles, or — for an advance, paid before any invoice — its own.
    const jobs = [...new Set(d.allocations.map((a) => a.enquiry_no).filter(Boolean))];
    if (!jobs.length && p.enquiry_no) jobs.push(p.enquiry_no);
    UI.modal({
      title: `${p.payment_no} — ${p.direction === 'in' ? 'received from' : 'paid to'} ${p.partner_name || '—'}`,
      size: 'wide',
      body: `<div class="grid g2 mb">
          <div>${UI.facts([
            ['Amount', `<b>${UI.money(p.amount)}</b>`],
            ['Date', UI.date(p.payment_date)],
            ['Mode', UI.titleise(p.mode)],
            p.mode === 'cheque' ? ['Cheque', `${esc(p.cheque_no || '')} dated ${UI.date(p.cheque_date)}${p.bank_name ? ' · ' + esc(p.bank_name) : ''}`] : null,
            ['Reference', esc(p.reference || '—')],
            ['Our enquiry', jobs.length
              ? `<span class="mono">${esc(jobs.join(', '))}</span>` : '—'],
            ['Status', UI.statusBadge(p.status)],
          ])}</div>
          <div>${UI.facts([
            ['Applied', UI.money(p.allocated)],
            ['On account', UI.money(p.amount - p.allocated)],
            ['Kind', UI.titleise(p.kind)],
            ['Notes', esc(p.notes || '—')],
          ])}</div>
        </div>
        <div class="muted small mb">${esc(d.amountInWords)}</div>
        <h4>Applied against</h4>
        ${UI.table([
          { label: 'Invoice', key: 'doc_no' },
          { label: 'Date', render: (r) => UI.date(r.invoice_date) },
          { label: 'Our enquiry', render: (r) => (r.enquiry_no
            ? `<span class="mono small">${esc(r.enquiry_no)}</span>` : '—') },
          { label: 'Invoice total', num: true, render: (r) => UI.money(r.invoice_total, { symbol: false }) },
          { label: 'Applied', num: true, render: (r) => `<b>${UI.money(r.amount, { symbol: false })}</b>` },
        ], d.allocations, { emptyText: 'Nothing applied yet — this is sitting on account.' })}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print the voucher</button>
        ${APP.can(['accounts']) && p.amount - p.allocated > 0.005
          ? '<button class="btn ghost" data-act="apply">Apply it to invoices</button>' : ''}
        ${APP.can(['accounts']) && p.mode === 'cheque' && p.status !== 'cleared'
          ? '<button class="btn green" data-act="cleared">Cheque cleared</button>' : ''}
        ${APP.can(['accounts']) && p.status !== 'bounced'
          ? '<button class="btn danger" data-act="bounced">It bounced</button>' : ''}`,
      async onAction(act) {
        if (act === 'print') { const w = PRINT.openWindow(); PRINT.DOCS.receipt(d, w); return 'keep'; }
        if (act === 'apply') {
          const res = await API.post(`/api/accounts/payments/${p.id}/allocate`, {});
          UI.ok(`Applied ${UI.money(res.allocated)} to the oldest open invoices.`);
          APP.reload();
          return;
        }
        if (act === 'cleared') {
          await API.post(`/api/accounts/payments/${p.id}/status`, { status: 'cleared' });
          UI.ok('Marked as cleared.');
          APP.reload();
          return;
        }
        if (act === 'bounced') {
          const why = window.prompt('Why did it bounce? (the client will ask)');
          if (!why) return 'keep';
          await API.post(`/api/accounts/payments/${p.id}/status`, { status: 'bounced', notes: why });
          UI.warn('Recorded as bounced — the invoices it covered are open again.');
          APP.reload();
        }
      },
    });
  }

  /**
   * Record money moving. Left to itself it is applied to that party's oldest
   * open invoices, which is what actually happens when a round figure arrives
   * "against our account".
   */
  async function openPayment(opts = {}) {
    const direction = opts.direction || 'in';
    const type = direction === 'in' ? 'client' : 'supplier';
    const partners = (await API.get(`/api/partners?type=${type}&limit=500`)).rows;
    // An advance to a manufacturer goes out before any invoice exists, so the
    // voucher can be told which enquiry it belongs to; a settlement takes the
    // reference from the invoices it pays and needs no answer here.
    const openEnquiries = direction === 'out'
      ? (await API.get('/api/purchase/enquiries?limit=200')).rows : [];

    UI.modal({
      title: direction === 'in' ? 'Receipt from a client' : 'Payment to a supplier',
      size: 'wide',
      body: `<form id="p-form">
        <div class="grid g3">
          ${UI.field({ name: 'partner_id', label: direction === 'in' ? 'Client' : 'Supplier',
            required: true, value: opts.partner_id || '', blank: 'Choose…',
            options: partners.map((p) => ({ value: p.id, label: p.name })) })}
          ${UI.field({ name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true,
            value: opts.amount || '' })}
          ${UI.field({ name: 'payment_date', label: 'Date', type: 'date', value: UI.today(), required: true })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'mode', label: 'Mode', value: 'bank_transfer',
            options: [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' },
              { value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' },
              { value: 'lc', label: 'Letter of credit' }] })}
          ${UI.field({ name: 'reference', label: 'Reference' })}
          ${UI.field({ name: 'kind', label: 'This is', value: opts.kind || 'settlement',
            options: [{ value: 'settlement', label: 'Against invoices' },
              { value: 'advance', label: 'An advance' }, { value: 'refund', label: 'A refund' }] })}
        </div>
        <div class="grid g3" id="cheque-box" hidden>
          ${UI.field({ name: 'cheque_no', label: 'Cheque number' })}
          ${UI.field({ name: 'cheque_date', label: 'Cheque date', type: 'date', value: UI.today(),
            hint: 'A date in the future is held as a post-dated cheque.' })}
          ${UI.field({ name: 'bank_name', label: 'Bank' })}
        </div>
        ${openEnquiries.length ? UI.field({ name: 'enquiry_id', label: 'Against our enquiry',
          blank: 'Take it from the invoices this pays',
          hint: 'Worth setting on an advance, which has no invoice behind it yet.',
          options: openEnquiries.map((e) => ({ value: e.id,
            label: `${e.enquiry_no} — ${e.partner_name || e.client_name || ''} ${e.subject || ''}`.trim() })) }) : ''}
        <div id="open-invoices" class="mt"></div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
        ${opts.sales_order_id ? `<input type="hidden" name="sales_order_id" value="${opts.sales_order_id}">` : ''}
      </form>`,
      onMount(modal) {
        const modeEl = modal.querySelector('[name=mode]');
        const box = modal.querySelector('#cheque-box');
        const sync = () => { box.hidden = modeEl.value !== 'cheque'; };
        modeEl.addEventListener('change', sync);
        sync();

        const partnerEl = modal.querySelector('[name=partner_id]');
        const list = modal.querySelector('#open-invoices');
        const loadOpen = async () => {
          if (!partnerEl.value) { list.innerHTML = ''; return; }
          const side = direction === 'in' ? 'sales' : 'purchase';
          const res = await API.get(`/api/accounts/open-invoices?side=${side}&partner_id=${partnerEl.value}`);
          if (!res.rows.length) {
            list.innerHTML = '<div class="alert info">Nothing outstanding for this account — this will sit on account.</div>';
            return;
          }
          list.innerHTML = `<h4>Apply it to</h4>
            <div class="muted small mb">Leave every box blank and it is applied to the oldest first.</div>
            <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Due</th>
              <th class="num">Outstanding</th><th class="num">Apply</th></tr></thead><tbody>
              ${res.rows.map((r) => `<tr>
                <td class="mono small">${esc(r.doc_no)}</td>
                <td>${UI.date(r.invoice_date)}</td>
                <td>${UI.date(r.due_date)}<div class="muted small">${esc(UI.dueIn(r.due_date))}</div></td>
                <td class="num">${UI.money(r.outstanding, { symbol: false })}</td>
                <td><input type="number" step="0.01" min="0" max="${r.outstanding}" style="width:110px"
                      data-alloc="${r.id}" value="${(opts.allocations || []).find((a) => a.invoice_id === r.id)
                        ? (opts.allocations.find((a) => a.invoice_id === r.id).amount) : ''}"></td>
              </tr>`).join('')}
            </tbody></table></div>`;
        };
        partnerEl.addEventListener('change', loadOpen);
        loadOpen();
      },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn green" data-act="save">Record it</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#p-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        const side = direction === 'in' ? 'sales' : 'purchase';
        const allocations = [...form.querySelectorAll('[data-alloc]')]
          .map((el) => ({ invoice_side: side, invoice_id: Number(el.dataset.alloc), amount: Number(el.value) || 0 }))
          .filter((a) => a.amount > 0);
        const saved = await API.post('/api/accounts/payments', {
          ...values, direction, allocations: allocations.length ? allocations : undefined,
        });
        UI.ok(`${saved.payment_no} recorded.`);
        const w = PRINT.openWindow();
        PRINT.DOCS.receipt(await API.get(`/api/accounts/payments/${saved.id}`), w);
        APP.reload();
      },
    });
  }

  // ========================================================= cheque register
  APP.register('cheques', {
    title: 'Cheque Register',
    subtitle: 'Every cheque written or taken in, and when it falls due',

    async render(host) {
      const d = await API.get('/api/accounts/cheques');
      host.innerHTML = `
        <div class="grid g4 mb">
          ${UI.stat({ label: 'Coming in (post-dated)', value: UI.money(d.summary.incoming_pending), kind: 'green' })}
          ${UI.stat({ label: 'Going out (post-dated)', value: UI.money(d.summary.outgoing_pending), kind: 'gold' })}
          ${UI.stat({ label: 'Due within a week', value: UI.num(d.summary.due_this_week) })}
          ${UI.stat({ label: 'Bounced', value: UI.num(d.summary.bounced),
            kind: d.summary.bounced ? 'danger' : '' })}
        </div>
        <div class="card"><div id="rows"></div></div>`;
      const box = document.getElementById('rows');
      box.innerHTML = UI.table([
        { label: 'Cheque', render: (r) => `<b class="mono">${esc(r.cheque_no || '—')}</b>
            <div class="muted small">${esc(r.bank_name || '')}</div>` },
        { label: '', render: (r) => UI.badge(r.direction === 'in' ? 'In' : 'Out',
          r.direction === 'in' ? 'ok' : 'gold') },
        { label: 'Party', key: 'partner_name' },
        { label: 'Cheque date', render: (r) => `${UI.date(r.cheque_date)}
            <div class="muted small">${esc(UI.dueIn(r.cheque_date))}</div>` },
        { label: 'Voucher', key: 'payment_no' },
        { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.amount, { symbol: false })}</b>` },
        { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      ], d.rows, { onRow: true, emptyText: 'No cheques recorded yet.' });
      UI.bindRows(box, d.rows, (row) => showPayment(row.id));
    },
  });

  // ================================================== the group's own books
  APP.register('expenses', {
    title: 'Expenses & Income',
    subtitle: 'Everything the group spends and takes in outside the trade invoices — per company',

    async render(host) {
      const m = await APP.loadMasters();
      APP.actions(APP.can(['accounts']) ? [
        { id: 'exp', label: '+ Expense', kind: 'gold', onClick: () => openExpense('expense') },
        { id: 'inc', label: '+ Other income', kind: 'green', onClick: () => openExpense('income') },
      ] : []);

      host.innerHTML = `
        <div class="card">
          <div class="filters">
            <label class="field grow"><span>Search</span>
              <input id="f-q" placeholder="Voucher, description, payee…"></label>
            <label class="field"><span>Company</span><select id="f-company">
              <option value="">The whole group</option>
              ${m.companies.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.name)}</option>`).join('')}
            </select></label>
            <label class="field"><span>Head</span><select id="f-category">
              <option value="">All heads</option>
              ${m.expenseCategories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select></label>
            <label class="field"><span>From</span>
              <input id="f-from" type="date" value="${UI.today().slice(0, 4)}-01-01"></label>
            <label class="field"><span>To</span><input id="f-to" type="date" value="${UI.today()}"></label>
          </div>
          <div id="summary"></div>
          <div id="rows">${UI.loading()}</div>
        </div>`;

      const load = async () => {
        const box = document.getElementById('rows');
        box.innerHTML = UI.loading();
        const get = (id) => document.getElementById(id).value;
        const res = await API.get('/api/accounts/expenses' + API.qs({
          q: get('f-q'), company_id: get('f-company'), category_id: get('f-category'),
          from: get('f-from'), to: get('f-to'), limit: 300 }));
        document.getElementById('summary').innerHTML = `<div class="grid g3 mb">
          ${UI.stat({ label: 'Spent', value: UI.money(res.summary.spent), kind: 'gold' })}
          ${UI.stat({ label: 'Other income', value: UI.money(res.summary.earned), kind: 'green' })}
          ${UI.stat({ label: 'Recoverable input VAT', value: UI.money(res.summary.input_vat) })}
        </div>`;
        box.innerHTML = UI.table([
          { label: 'Voucher', render: (r) => `<span class="mono">${esc(r.voucher_no)}</span>` },
          { label: 'Company', render: (r) => UI.badge(r.company_code || '', 'navy') },
          { label: 'Date', render: (r) => UI.date(r.expense_date) },
          { label: 'Head', key: 'category_name' },
          { label: 'Description', render: (r) => `<b>${esc(r.description)}</b>
              <div class="muted small">${esc([r.payee, r.project].filter(Boolean).join(' · '))}</div>` },
          { label: 'Mode', render: (r) => UI.titleise(r.mode) },
          { label: 'Net', num: true, render: (r) => UI.money(r.amount, { symbol: false }) },
          { label: 'VAT', num: true, render: (r) => (r.vat_amount ? UI.money(r.vat_amount, { symbol: false }) : '—') },
          { label: 'Total', num: true, render: (r) => `<b class="${r.kind === 'income' ? '' : ''}">${
            r.kind === 'income' ? '+' : '−'}${UI.money(r.total, { symbol: false })}</b>` },
        ], res.rows, { onRow: true, emptyText: 'Nothing booked in this period.' });
        UI.bindRows(box, res.rows, (row) => openExpense(row.kind, row));
      };

      let timer = null;
      document.getElementById('f-q').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(load, 250);
      });
      host.querySelectorAll('.filters select, .filters input[type=date]')
        .forEach((el) => el.addEventListener('change', load));
      await load();
    },
  });

  async function openExpense(kind, existing) {
    const m = await APP.loadMasters();
    const partners = (await API.get('/api/partners?limit=500')).rows;
    const heads = m.expenseCategories.filter((c) => c.kind === (existing ? existing.kind : kind));

    UI.modal({
      title: existing ? `${existing.voucher_no}` : (kind === 'income' ? 'Other income' : 'New expense'),
      size: 'wide',
      body: `<form id="x-form">
        <div class="grid g3">
          ${UI.field({ name: 'company_id', label: 'Company', required: true,
            value: existing ? existing.company_id : (APP.user.companyId || ''),
            options: APP.companyOptions(),
            hint: 'Which of the group companies this belongs to.' })}
          ${UI.field({ name: 'category_id', label: 'Head', blank: 'Not classified',
            value: existing ? existing.category_id : '',
            options: heads.map((c) => ({ value: c.id, label: c.name })) })}
          ${UI.field({ name: 'expense_date', label: 'Date', type: 'date',
            value: existing ? existing.expense_date : UI.today(), required: true })}
        </div>
        ${UI.field({ name: 'description', label: 'Description', required: true,
          value: existing ? existing.description : '' })}
        <div class="grid g3">
          ${UI.field({ name: 'payee', label: kind === 'income' ? 'Received from' : 'Paid to',
            value: existing ? existing.payee || '' : '' })}
          ${UI.field({ name: 'partner_id', label: 'Or an account on the books', blank: 'None',
            value: existing ? existing.partner_id : '',
            options: partners.map((p) => ({ value: p.id, label: p.name })) })}
          ${UI.field({ name: 'project', label: 'Project', value: existing ? existing.project || '' : '' })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'amount', label: 'Amount (before VAT)', type: 'number', step: '0.01',
            required: true, value: existing ? existing.amount : '' })}
          ${UI.field({ name: 'vat_amount', label: 'VAT', type: 'number', step: '0.01',
            value: existing ? existing.vat_amount : 0,
            hint: `Leave at zero if there was none. ${APP.vatPercent}% is the standard rate.` })}
          ${UI.field({ name: 'mode', label: 'Paid by', value: existing ? existing.mode : 'bank_transfer',
            options: [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' },
              { value: 'cheque', label: 'Cheque' }, { value: 'card', label: 'Card' },
              { value: 'petty_cash', label: 'Petty cash' }] })}
        </div>
        <div class="grid g2">
          ${UI.field({ name: 'reference', label: 'Reference / bill no.',
            value: existing ? existing.reference || '' : '' })}
          ${UI.field({ name: 'attachment_ref', label: 'Where the paper is filed',
            value: existing ? existing.attachment_ref || '' : '' })}
        </div>
        ${(existing ? existing.kind : kind) === 'expense'
          ? UI.checkbox({ name: 'recoverable_vat', label: 'The VAT on this is recoverable',
            checked: existing ? !!existing.recoverable_vat : true }) : ''}
        <input type="hidden" name="kind" value="${existing ? existing.kind : kind}">
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        ${existing && APP.can(['accounts']) ? '<button class="btn danger" data-act="delete">Delete</button>' : ''}
        <button class="btn" data-act="save">${existing ? 'Save' : 'Book it'}</button>`,
      onMount(modal) {
        // Fill in the standard VAT once an amount is typed, so nobody has to
        // reach for a calculator — it is still editable.
        const amount = modal.querySelector('[name=amount]');
        const vat = modal.querySelector('[name=vat_amount]');
        amount.addEventListener('change', () => {
          if (!vat.value || Number(vat.value) === 0) {
            vat.value = (Math.round((Number(amount.value) || 0) * (APP.vatPercent / 100) * 100) / 100) || '';
          }
        });
      },
      async onAction(act, modal) {
        if (act === 'delete') {
          const sure = await UI.confirm(`Delete ${existing.voucher_no}?`, { danger: true });
          if (!sure) return 'keep';
          await API.del(`/api/accounts/expenses/${existing.id}`);
          UI.ok('Deleted.');
          APP.reload();
          return;
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#x-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        const box = form.querySelector('[name=recoverable_vat]');
        if (box) values.recoverable_vat = box.checked;
        if (existing) await API.patch(`/api/accounts/expenses/${existing.id}`, values);
        else await API.post('/api/accounts/expenses', values);
        UI.ok('Saved.');
        APP.reload();
      },
    });
  }

  // ============================================================== the ledgers
  APP.register('ledgers', {
    title: 'Ledgers & Ageing',
    subtitle: 'What each account owes, how long it has owed it, and every entry behind the figure',

    async render(host, params) {
      host.innerHTML = `
        <div class="tabs">
          <button data-t="receivable" class="active">Owed to us</button>
          <button data-t="payable">We owe</button>
        </div>
        <div id="ageing">${UI.loading()}</div>`;

      const paint = async (side) => {
        const box = document.getElementById('ageing');
        box.innerHTML = UI.loading();
        const d = await API.get(`/api/accounts/ageing/${side}`);
        const b = d.buckets;
        box.innerHTML = `
          <div class="grid g5 mb">
            ${UI.stat({ label: 'Not yet due', value: UI.money(b.not_due) })}
            ${UI.stat({ label: '1 – 30 days', value: UI.money(b.d0_30), kind: 'info' })}
            ${UI.stat({ label: '31 – 60 days', value: UI.money(b.d31_60), kind: 'gold' })}
            ${UI.stat({ label: '61 – 90 days', value: UI.money(b.d61_90), kind: 'gold' })}
            ${UI.stat({ label: 'Over 90 days', value: UI.money(b.d90_plus),
              kind: b.d90_plus ? 'danger' : '' })}
          </div>
          <div class="card flush">
            <div class="card-head"><b>By account</b> — ${UI.money(d.total)} outstanding at ${UI.date(d.as_of)}</div>
            <div id="by-partner"></div>
          </div>
          <div class="card flush">
            <div class="card-head"><b>Invoice by invoice</b></div>
            <div id="by-invoice"></div>
          </div>`;

        const partnerBox = document.getElementById('by-partner');
        partnerBox.innerHTML = UI.table([
          { label: 'Account', render: (r) => `<b>${esc(r.partner_name)}</b>
              <div class="muted small mono">${esc(r.partner_code)}</div>` },
          { label: 'Invoices', num: true, key: 'invoices' },
          { label: 'Not due', num: true, render: (r) => UI.money(r.not_due, { symbol: false }) },
          { label: '1–30', num: true, render: (r) => UI.money(r.d0_30, { symbol: false }) },
          { label: '31–60', num: true, render: (r) => UI.money(r.d31_60, { symbol: false }) },
          { label: '61–90', num: true, render: (r) => UI.money(r.d61_90, { symbol: false }) },
          { label: '90+', num: true, render: (r) => (r.d90_plus
            ? `<span class="badge danger">${UI.money(r.d90_plus, { symbol: false })}</span>` : '—') },
          { label: 'Total', num: true, render: (r) => `<b>${UI.money(r.total, { symbol: false })}</b>` },
        ], d.by_partner, { onRow: true, emptyText: 'Nothing outstanding.' });
        UI.bindRows(partnerBox, d.by_partner, (row) => showLedger(row.partner_id));

        document.getElementById('by-invoice').innerHTML = UI.table([
          { label: 'Invoice', render: (r) => `<span class="mono">${esc(r.doc_no)}</span>` },
          { label: 'Account', key: 'partner_name' },
          { label: 'Date', render: (r) => UI.date(r.invoice_date) },
          { label: 'Due', render: (r) => UI.date(r.due_date) },
          { label: 'Terms', key: 'terms_name' },
          { label: 'Age', num: true, render: (r) => (r.days_overdue > 0
            ? `<span class="badge ${r.days_overdue > 60 ? 'danger' : 'warn'}">${r.days_overdue} d</span>`
            : UI.badge('not due', 'ok')) },
          { label: 'Outstanding', num: true, render: (r) => `<b>${UI.money(r.outstanding, { symbol: false })}</b>` },
        ], d.rows, { emptyText: 'Nothing outstanding.' });
      };

      host.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
        host.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b));
        paint(b.dataset.t);
      }));
      await paint('receivable');
      if (params.partner) showLedger(params.partner);
    },
  });

  async function showLedger(partnerId) {
    const d = await API.get(`/api/partners/${partnerId}/ledger`);
    UI.modal({
      title: `Ledger — ${d.partner.name}`,
      size: 'wide',
      body: `<div class="grid g3 mb">
          ${UI.stat({ label: 'Opening', value: UI.money(d.opening) })}
          ${UI.stat({ label: 'Movement', value: `${UI.money(d.totals.debit)} / ${UI.money(d.totals.credit)}`,
            note: 'debit / credit' })}
          ${UI.stat({ label: 'Closing', value: UI.money(d.closing),
            kind: d.closing > 0 ? 'gold' : 'green',
            note: d.closing >= 0 ? 'due to us' : 'in their favour' })}
        </div>
        ${UI.table([
          { label: 'Date', render: (r) => UI.date(r.date) },
          { label: 'Particulars', render: (r) => esc(r.particulars) },
          { label: 'Due', render: (r) => (r.due_date ? UI.date(r.due_date) : '') },
          { label: 'Debit', num: true, render: (r) => (r.debit ? UI.money(r.debit, { symbol: false }) : '') },
          { label: 'Credit', num: true, render: (r) => (r.credit ? UI.money(r.credit, { symbol: false }) : '') },
          { label: 'Balance', num: true, render: (r) => `<b>${UI.money(r.balance, { symbol: false })}</b>` },
        ], d.rows, { emptyText: 'Nothing has passed on this account yet.' })}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="statement">Print the statement</button>`,
      async onAction(act) {
        if (act !== 'statement') return;
        const w = PRINT.openWindow();
        PRINT.DOCS.statement(await API.get(`/api/partners/${partnerId}/statement`), w);
        return 'keep';
      },
    });
  }

  // ================================================== VAT and what was made
  /** '2026-09' → 'September 2026'. */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  function monthName(ym) {
    const [y, m] = String(ym || '').split('-');
    return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : String(ym || '');
  }

  APP.register('vat', {
    title: 'VAT & Profit',
    subtitle: 'Output tax charged, input tax paid, and what the business made each month',

    async render(host) {
      const to = UI.today();
      const from = `${to.slice(0, 4)}-01-01`;
      host.innerHTML = `
        <div class="card">
          <div class="filters">
            <label class="field"><span>From</span><input id="f-from" type="date" value="${from}"></label>
            <label class="field"><span>To</span><input id="f-to" type="date" value="${to}"></label>
            <label class="field"><span>Company</span><select id="f-company">
              <option value="">The whole group</option>
              ${APP.companyOptions().map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}
            </select></label>
          </div>
        </div>
        <div id="out">${UI.loading()}</div>`;

      const quiet = { clients: true, suppliers: true };

      const load = async () => {
        const out = document.getElementById('out');
        out.innerHTML = UI.loading();
        const q = API.qs({
          from: document.getElementById('f-from').value,
          to: document.getElementById('f-to').value,
          company_id: document.getElementById('f-company').value,
        });
        const [vat, pl] = await Promise.all([
          API.get('/api/accounts/vat-return' + q),
          API.get('/api/accounts/profit-and-loss' + q),
        ]);

        /*
         * Every account is listed by default, quiet ones included: the owner
         * asked for the names, and an account that bought nothing this month is
         * itself a thing to notice. On a long list that becomes noise, so each
         * table can be folded down to the accounts that actually traded.
         */
        const clients = quiet.clients ? pl.clients : pl.clients.filter((r) => r.traded);
        const suppliers = quiet.suppliers ? pl.suppliers : pl.suppliers.filter((r) => r.traded);
        const sumOf = (rows, key) => rows.reduce((a, r) => a + (r[key] || 0), 0);
        const hideQuiet = (all, shown, key) => {
          const idle = all.filter((r) => !r.traded).length;
          if (!idle) return '';
          return `<button class="link-btn small mt" data-quiet="${key}">${quiet[key]
            ? `Hide the ${idle} account${idle === 1 ? '' : 's'} with nothing in this period`
            : `Show all ${all.length}, including the ${idle} with nothing in this period`}</button>`;
        };

        out.innerHTML = `
          <div class="card">
            <h3>VAT return</h3>
            <div class="card-sub">${UI.date(vat.from)} to ${UI.date(vat.to)} — output tax on our sales
              against input tax on purchases and expenses.</div>
            <div class="grid g4">
              ${UI.stat({ label: 'Standard-rated sales', value: UI.money(vat.sales.taxable),
                note: `${vat.sales.count} tax invoices` })}
              ${UI.stat({ label: 'Output tax', value: UI.money(vat.output_tax), kind: 'gold' })}
              ${UI.stat({ label: 'Input tax', value: UI.money(vat.input_tax),
                note: `${vat.purchases.count} bills, ${vat.expenses.count} expenses`, kind: 'info' })}
              ${UI.stat({ label: vat.net >= 0 ? 'Payable to the FTA' : 'Recoverable',
                value: UI.money(Math.abs(vat.net)), kind: vat.net >= 0 ? 'danger' : 'green' })}
            </div>
          </div>
          <div class="card">
            <h3>Month by month</h3>
            <div class="card-sub">Each month reads left to right the way the money moves: what we
              invoiced, what those goods cost, and that month's expenses taken off before the gross
              profit at the end. Enter the month's expenses and the final figure for that month is here.</div>
            ${UI.table([
              { label: 'Month', render: (r) => `<b>${esc(monthName(r.month))}</b>
                  ${r.revenue && !r.expenses_booked
                    ? `<div class="muted small">no expenses entered yet</div>` : ''}` },
              { label: 'Invoiced', num: true, render: (r) => UI.money(r.revenue, { symbol: false }) },
              { label: 'Cost of goods', num: true, render: (r) => `− ${UI.money(r.cost_of_sales, { symbol: false })}` },
              { label: 'Margin on goods', num: true, render: (r) => `${UI.money(r.trading_margin, { symbol: false })}
                  <div class="muted small">${r.gross_margin_percent}%</div>` },
              { label: 'Other income', num: true, render: (r) => (r.other_income
                ? `+ ${UI.money(r.other_income, { symbol: false })}` : '—') },
              { label: 'Expenses this month', num: true, render: (r) => (r.expenses
                ? `− ${UI.money(r.expenses, { symbol: false })}
                   <div class="muted small">${r.expense_count} entr${r.expense_count === 1 ? 'y' : 'ies'}</div>`
                : `<span class="badge warn">none entered</span>`) },
              { label: 'Gross profit', num: true, render: (r) => `<b>${UI.money(r.gross_profit, { symbol: false })}</b>` },
            ], pl.monthly.rows, { emptyText: 'Nothing invoiced or spent in this period yet.',
              foot: `<tr><td><b>Total</b></td>
                <td class="num">${UI.money(pl.monthly.total.revenue, { symbol: false })}</td>
                <td class="num">− ${UI.money(pl.monthly.total.cost_of_sales, { symbol: false })}</td>
                <td class="num">${UI.money(pl.monthly.total.trading_margin, { symbol: false })}</td>
                <td class="num">${pl.monthly.total.other_income ? '+ ' + UI.money(pl.monthly.total.other_income, { symbol: false }) : '—'}</td>
                <td class="num">− ${UI.money(pl.monthly.total.expenses, { symbol: false })}</td>
                <td class="num"><b>${UI.money(pl.monthly.total.gross_profit, { symbol: false })}</b></td></tr>` })}
            <div class="muted small mt">An expense counts in the month it is dated, whichever month
              the trade it paid for happened in — which is how it is entered and how the bank sees it.
              A month showing sales but no expenses is a month somebody has not finished entering.</div>
          </div>
          <div class="card">
            <h3>Revenue, client by client</h3>
            <div class="card-sub">Where the invoiced sales came from, with the cost of those
              particular goods against each account. Every trading client is listed — an account
              that bought nothing this period is worth seeing too. <b>Still owed</b> is where the
              account stands today, not a figure for the period.</div>
            ${UI.table([
              { label: 'Client', render: (r) => `<b>${esc(r.name)}</b>
                  <div class="muted small mono">${esc(r.code)}</div>` },
              { label: 'Invoices', num: true, render: (r) => (r.invoices || '—') },
              { label: 'Revenue', num: true, render: (r) => (r.revenue
                ? `<b>${UI.money(r.revenue, { symbol: false })}</b>` : '—') },
              { label: 'VAT charged', num: true, render: (r) => (r.vat
                ? UI.money(r.vat, { symbol: false }) : '—') },
              { label: 'Cost of those goods', num: true, render: (r) => (r.cost_of_sales
                ? `− ${UI.money(r.cost_of_sales, { symbol: false })}` : '—') },
              { label: 'Margin on goods', num: true, render: (r) => (r.revenue
                ? `${UI.money(r.margin, { symbol: false })}
                   <div class="muted small">${r.margin_percent}%</div>` : '—') },
              { label: 'Still owed', num: true, render: (r) => (r.outstanding > 0
                ? `<span class="badge warn">${UI.money(r.outstanding, { symbol: false })}</span>` : '—') },
            ], clients, { emptyText: 'No clients on the books yet.',
              foot: `<tr><td><b>Total</b></td>
                <td class="num">${clients.reduce((a, r) => a + r.invoices, 0) || '—'}</td>
                <td class="num"><b>${UI.money(sumOf(clients, 'revenue'), { symbol: false })}</b></td>
                <td class="num">${UI.money(sumOf(clients, 'vat'), { symbol: false })}</td>
                <td class="num">− ${UI.money(sumOf(clients, 'cost_of_sales'), { symbol: false })}</td>
                <td class="num">${UI.money(sumOf(clients, 'margin'), { symbol: false })}</td>
                <td class="num">${UI.money(sumOf(clients, 'outstanding'), { symbol: false })}</td></tr>` })}
            ${hideQuiet(pl.clients, clients, 'clients')}
          </div>
          <div class="card">
            <h3>What each manufacturer cost us</h3>
            <div class="card-sub">What every supplier billed us for material in this period, and
              what was booked against their account as an expense — freight, testing, a mobilisation
              charge. Together, what that manufacturer cost the group. <b>Still owed</b> is where
              the account stands today, not a figure for the period.</div>
            ${UI.table([
              { label: 'Manufacturer / supplier', render: (r) => `<b>${esc(r.name)}</b>
                  <div class="muted small mono">${esc(r.code)}</div>` },
              { label: 'LPOs', num: true, render: (r) => (r.orders
                ? `${r.orders}<div class="muted small">${UI.money(r.ordered, { symbol: false })}</div>` : '—') },
              { label: 'Bills', num: true, render: (r) => (r.bills || '—') },
              { label: 'Billed us', num: true, render: (r) => (r.billed
                ? `<b>${UI.money(r.billed, { symbol: false })}</b>` : '—') },
              { label: 'Input VAT', num: true, render: (r) => (r.input_vat
                ? UI.money(r.input_vat, { symbol: false }) : '—') },
              { label: 'Expenses', num: true, render: (r) => (r.expenses
                ? `${UI.money(r.expenses, { symbol: false })}
                   <div class="muted small">${r.expense_count} entr${r.expense_count === 1 ? 'y' : 'ies'}</div>` : '—') },
              { label: 'Cost to us', num: true, render: (r) => (r.total_cost
                ? `<b>${UI.money(r.total_cost, { symbol: false })}</b>` : '—') },
              { label: 'Still owed', num: true, render: (r) => (r.outstanding > 0
                ? `<span class="badge warn">${UI.money(r.outstanding, { symbol: false })}</span>` : '—') },
            ], suppliers, { emptyText: 'No suppliers on the books yet.',
              foot: `<tr><td><b>Total</b></td>
                <td class="num">${suppliers.reduce((a, r) => a + r.orders, 0) || '—'}</td>
                <td class="num">${suppliers.reduce((a, r) => a + r.bills, 0) || '—'}</td>
                <td class="num"><b>${UI.money(sumOf(suppliers, 'billed'), { symbol: false })}</b></td>
                <td class="num">${UI.money(sumOf(suppliers, 'input_vat'), { symbol: false })}</td>
                <td class="num">${UI.money(sumOf(suppliers, 'expenses'), { symbol: false })}</td>
                <td class="num"><b>${UI.money(sumOf(suppliers, 'total_cost'), { symbol: false })}</b></td>
                <td class="num">${UI.money(sumOf(suppliers, 'outstanding'), { symbol: false })}</td></tr>` })}
            ${hideQuiet(pl.suppliers, suppliers, 'suppliers')}
            <div class="muted small mt">This is not the same figure as the cost of sales above it,
              and should not be: cost of sales is what the goods <b>invoiced to clients</b> cost,
              whenever they were bought; this is what the makers <b>billed us in this period</b>,
              whenever those goods are sold. In a month where the yard fills or empties the two
              differ, and the difference is stock.</div>
          </div>
          <div class="card">
            <h3>By company</h3>
            <div class="card-sub">Invoiced sales less what those goods cost us, less the overheads
              booked to each company — read in the same order as the months above.</div>
            ${UI.table([
              { label: 'Company', render: (r) => `<b>${esc(r.code)}</b>
                  <div class="muted small">${esc(r.name)}</div>` },
              { label: 'Revenue', num: true, render: (r) => UI.money(r.revenue, { symbol: false }) },
              { label: 'Cost of sales', num: true, render: (r) => UI.money(r.cost_of_sales, { symbol: false }) },
              { label: 'Margin on goods', num: true, render: (r) => `${UI.money(r.gross_profit, { symbol: false })}
                  <div class="muted small">${r.gross_margin_percent}%</div>` },
              { label: 'Other income', num: true, render: (r) => UI.money(r.other_income, { symbol: false }) },
              { label: 'Expenses', num: true, render: (r) => UI.money(r.expenses, { symbol: false }) },
              { label: 'Gross profit', num: true, render: (r) => `<b>${
                UI.money(r.net_profit, { symbol: false })}</b>` },
            ], pl.companies, { emptyText: 'No companies set up.' })}
            <div class="doc-footer"><table>
              <tr><td class="muted">Group revenue</td><td class="num">${UI.money(pl.group.revenue, { symbol: false })}</td></tr>
              <tr><td class="muted">Margin on goods</td><td class="num">${UI.money(pl.group.gross_profit, { symbol: false })}
                (${pl.group.gross_margin_percent}%)</td></tr>
              <tr><td class="muted">Overheads</td><td class="num">${UI.money(pl.group.expenses, { symbol: false })}</td></tr>
              <tr class="grand"><td>Gross profit</td><td class="num">${UI.money(pl.group.net_profit, { symbol: false })}</td></tr>
            </table></div>
          </div>`;
      };

      host.querySelectorAll('.filters input, .filters select')
        .forEach((el) => el.addEventListener('change', load));
      host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-quiet]');
        if (!btn) return;
        quiet[btn.dataset.quiet] = !quiet[btn.dataset.quiet];
        load();
      });
      await load();
    },
  });

  window.MONEY = { openPayment, showPayment, showLedger, openExpense };
})();
