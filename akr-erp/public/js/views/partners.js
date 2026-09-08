/* Suppliers and clients — one screen, two sides of the same trade. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const state = { type: 'client', q: '' };

  APP.register('partners', {
    title: 'Suppliers & Clients',
    subtitle: 'Who we buy from, who we sell to, and the terms each of them is on',

    async render(host, params) {
      if (params.type) state.type = params.type;
      const canEdit = APP.can(['kam', 'accounts', 'sales']);
      APP.actions([
        canEdit ? { id: 'new', label: '+ New account', kind: 'gold', onClick: () => openEdit(null) } : null,
      ].filter(Boolean));

      host.innerHTML = `
        <div class="tabs">
          <button data-tab="client" class="${state.type === 'client' ? 'active' : ''}">Clients</button>
          <button data-tab="supplier" class="${state.type === 'supplier' ? 'active' : ''}">Suppliers &amp; manufacturers</button>
        </div>
        <div class="card">
          <div class="filters">
            <label class="field grow"><span>Search</span>
              <input id="f-q" value="${esc(state.q)}" placeholder="Name, code, TRN, contact…"></label>
          </div>
          <div id="rows">${UI.loading()}</div>
        </div>`;

      const load = async () => {
        const box = document.getElementById('rows');
        box.innerHTML = UI.loading();
        const res = await API.get('/api/partners' + API.qs({
          type: state.type, q: state.q, withBalance: APP.seesMoney(), limit: 300,
        }));
        const cols = [
          { label: 'Code', render: (r) => `<span class="mono">${esc(r.code)}</span>` },
          { label: 'Name', render: (r) => `<b>${esc(r.name)}</b>
              <div class="muted small">${[r.contact_person, r.phone || r.mobile, r.emirate]
              .filter(Boolean).map(esc).join(' · ')}</div>` },
          { label: 'TRN', render: (r) => (r.trn ? `<span class="mono small">${esc(r.trn)}</span>`
            : '<span class="muted small">not on file</span>') },
          { label: 'Payment terms', render: (r) => (r.terms_name ? esc(r.terms_name)
            : '<span class="muted">not set</span>') },
        ];
        if (APP.seesMoney()) {
          cols.push({ label: state.type === 'client' ? 'They owe us' : 'We owe them', num: true,
            render: (r) => {
              const amount = state.type === 'client' ? r.receivable : r.payable;
              return amount ? `<b>${UI.money(amount, { symbol: false })}</b>` : '—';
            } });
          if (state.type === 'client') {
            cols.push({ label: 'Credit limit', num: true,
              render: (r) => (r.credit_limit ? UI.money(r.credit_limit, { symbol: false })
                : '<span class="muted">none set</span>') });
          }
        }
        box.innerHTML = UI.table(cols, res.rows, { onRow: true,
          emptyText: state.type === 'client' ? 'No clients yet.' : 'No suppliers yet.' });
        UI.bindRows(box, res.rows, (row) => openDetail(row.id));
      };

      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.type = b.dataset.tab;
        APP.reload();
      }));
      let timer = null;
      document.getElementById('f-q').addEventListener('input', (e) => {
        state.q = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(load, 250);
      });
      await load();
    },
  });

  async function openDetail(id) {
    const d = await API.get(`/api/partners/${id}`);
    const p = d.partner;
    const isClient = p.type !== 'supplier';

    const docTable = (rows, cols) => UI.table(cols, rows, { emptyText: 'Nothing yet.' });

    UI.modal({
      title: `${p.code} — ${p.name}`,
      size: 'wide',
      body: `
        <div class="grid g2">
          <div>${UI.facts([
            ['Type', UI.badge(UI.titleise(p.type), p.type === 'client' ? 'ok' : 'navy')],
            ['TRN', p.trn ? `<span class="mono">${esc(p.trn)}</span>` : '<span class="muted">not on file</span>'],
            ['Contact', esc([p.contact_person, p.designation].filter(Boolean).join(', ') || '—')],
            ['Phone', esc(p.phone || p.mobile || '—')],
            ['Email', esc(p.email || '—')],
            ['Address', esc([p.address, p.city, p.emirate, p.country].filter(Boolean).join(', ') || '—')],
            ['Payment terms', d.terms ? `<b>${esc(d.terms.name)}</b><div class="muted small">${esc(d.terms.description || '')}</div>` : '<span class="muted">not set</span>'],
            isClient && APP.seesMoney() ? ['Credit limit', p.credit_limit ? UI.money(p.credit_limit) : 'none set'] : null,
            ['Account manager', esc(p.account_manager || '—')],
          ])}</div>
          <div>
            ${d.balance ? `<div class="grid g2">
              ${UI.stat({ label: 'They owe us', value: UI.money(d.balance.receivable),
                kind: d.balance.receivable ? 'gold' : '' })}
              ${UI.stat({ label: 'We owe them', value: UI.money(d.balance.payable),
                kind: d.balance.payable ? 'info' : '' })}
            </div>` : ''}
            ${p.notes ? `<div class="mt"><b class="small">Notes</b><div class="muted">${esc(p.notes)}</div></div>` : ''}
          </div>
        </div>
        <div class="tabs mt" id="p-tabs">
          <button data-pt="sell" class="active">Selling to them</button>
          <button data-pt="buy">Buying from them</button>
        </div>
        <div id="p-body"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${APP.seesMoney() ? '<button class="btn ghost" data-act="ledger">Ledger</button>' : ''}
        ${APP.seesMoney() ? '<button class="btn ghost" data-act="statement">Print statement</button>' : ''}
        ${APP.can(['kam', 'accounts', 'sales']) ? '<button class="btn" data-act="edit">Edit</button>' : ''}`,
      onMount(modal) {
        const body = modal.querySelector('#p-body');
        const paint = (which) => {
          if (which === 'sell') {
            body.innerHTML = `<h4>Quotations</h4>${docTable(d.sales.quotations, [
              { label: 'No.', key: 'quote_no' }, { label: 'Date', render: (r) => UI.date(r.quote_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}
              <h4 class="mt">Their LPOs</h4>${docTable(d.sales.orders, [
              { label: 'Our ref', key: 'so_no' }, { label: 'Their LPO', key: 'client_lpo_no' },
              { label: 'Date', render: (r) => UI.date(r.order_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}
              <h4 class="mt">Tax invoices</h4>${docTable(d.sales.invoices, [
              { label: 'No.', key: 'invoice_no' }, { label: 'Date', render: (r) => UI.date(r.invoice_date) },
              { label: 'Due', render: (r) => UI.date(r.due_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Outstanding', num: true, render: (r) => UI.money(r.total - r.paid_amount, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}`;
          } else {
            body.innerHTML = `<h4>Their quotations</h4>${docTable(d.purchase.quotations, [
              { label: 'No.', key: 'quote_no' }, { label: 'Date', render: (r) => UI.date(r.quote_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}
              <h4 class="mt">Our LPOs</h4>${docTable(d.purchase.orders, [
              { label: 'No.', key: 'lpo_no' }, { label: 'Date', render: (r) => UI.date(r.lpo_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}
              <h4 class="mt">Their invoices</h4>${docTable(d.purchase.invoices, [
              { label: 'Our ref', key: 'bill_no' }, { label: 'Their no.', key: 'supplier_inv_no' },
              { label: 'Date', render: (r) => UI.date(r.invoice_date) },
              { label: 'Due', render: (r) => UI.date(r.due_date) },
              { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) }])}`;
          }
        };
        paint('sell');
        modal.querySelectorAll('[data-pt]').forEach((b) => b.addEventListener('click', () => {
          modal.querySelectorAll('[data-pt]').forEach((x) => x.classList.toggle('active', x === b));
          paint(b.dataset.pt);
        }));
      },
      async onAction(act) {
        if (act === 'edit') { UI.closeAllModals(); openEdit(p); return; }
        if (act === 'ledger') { UI.closeAllModals(); APP.navigate('ledgers', { partner: p.id }); return; }
        if (act === 'statement') {
          const w = PRINT.openWindow();
          const data = await API.get(`/api/partners/${p.id}/statement`);
          PRINT.DOCS.statement(data, w);
          return 'keep';
        }
      },
    });
  }

  async function openEdit(partner) {
    const m = await APP.loadMasters();
    const isNew = !partner;
    const type = partner ? partner.type : 'client';

    UI.modal({
      title: isNew ? 'New account' : `Edit ${partner.code}`,
      size: 'wide',
      body: `<form id="p-form">
        <div class="grid g2">
          <div>
            ${UI.field({ name: 'type', label: 'This account is a', required: true, value: type,
              options: [{ value: 'client', label: 'Client — we sell to them' },
                { value: 'supplier', label: 'Supplier / manufacturer — we buy from them' },
                { value: 'both', label: 'Both' }] })}
            ${UI.field({ name: 'name', label: 'Registered name', required: true,
              value: partner ? partner.name : '' })}
            ${UI.field({ name: 'trade_name', label: 'Trading as', value: partner ? partner.trade_name || '' : '' })}
            ${UI.field({ name: 'trn', label: 'TRN', value: partner ? partner.trn || '' : '',
              hint: 'Fifteen digits. Without it their VAT cannot be reclaimed on our invoice.' })}
            ${UI.field({ name: 'contact_person', label: 'Contact person', value: partner ? partner.contact_person || '' : '' })}
            ${UI.field({ name: 'designation', label: 'Their designation', value: partner ? partner.designation || '' : '' })}
            ${UI.field({ name: 'phone', label: 'Telephone', value: partner ? partner.phone || '' : '' })}
            ${UI.field({ name: 'mobile', label: 'Mobile', value: partner ? partner.mobile || '' : '' })}
            ${UI.field({ name: 'email', label: 'Email', type: 'email', value: partner ? partner.email || '' : '' })}
          </div>
          <div>
            ${UI.field({ name: 'address', label: 'Address', rows: 2, value: partner ? partner.address || '' : '' })}
            ${UI.field({ name: 'emirate', label: 'Emirate / city', value: partner ? partner.emirate || '' : '' })}
            ${UI.field({ name: 'country', label: 'Country', value: partner ? partner.country : 'United Arab Emirates' })}
            ${UI.field({ name: 'payment_terms_id', label: 'Payment terms', blank: 'Not set',
              value: partner ? partner.payment_terms_id : '',
              options: m.paymentTerms.map((t) => ({ value: t.id, label: t.name })),
              hint: 'Every quotation, LPO and invoice for this account starts on these terms.' })}
            ${UI.field({ name: 'credit_limit', label: 'Credit limit', type: 'number', step: '0.01',
              value: partner ? partner.credit_limit : 0, hint: 'Zero means no limit has been decided.' })}
            ${UI.field({ name: 'account_manager_id', label: 'Account manager', blank: 'Not assigned',
              value: partner ? partner.account_manager_id : '',
              options: m.users.filter((u) => ['kam', 'sales', 'admin'].includes(u.role))
                .map((u) => ({ value: u.id, label: u.name })) })}
            ${UI.field({ name: 'bank_name', label: 'Bank', value: partner ? partner.bank_name || '' : '' })}
            ${UI.field({ name: 'iban', label: 'IBAN', value: partner ? partner.iban || '' : '' })}
            ${isNew ? UI.field({ name: 'opening_balance', label: 'Opening balance', type: 'number', step: '0.01',
              value: 0, hint: 'Positive if they owe us, negative if we owe them.' }) : ''}
          </div>
        </div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2, value: partner ? partner.notes || '' : '' })}
        ${partner ? UI.checkbox({ name: 'active', label: 'Active', checked: !!partner.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${isNew ? 'Create' : 'Save'}</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#p-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (partner) values.active = form.querySelector('[name=active]').checked;
        const saved = partner
          ? await API.patch(`/api/partners/${partner.id}`, values)
          : await API.post('/api/partners', values);
        UI.ok(partner ? 'Account saved.' : `Created ${saved.code}.`);
        APP.reload();
      },
    });
  }

  window.PARTNERS = { openDetail, openEdit };
})();
