/* =============================================================================
   The selling side: enquiry → our quotation → the client's LPO → delivery →
   tax invoice. Each screen lists the documents and opens one; the forms share
   the line editor in doclines.js.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  /** A list screen with a search box and a filter row. */
  function listPage(host, { filters = '', onLoad, actions }) {
    APP.actions(actions || []);
    host.innerHTML = `
      <div class="card">
        <div class="filters">
          <label class="field grow"><span>Search</span><input id="f-q" placeholder="Number, client, project…"></label>
          ${filters}
        </div>
        <div id="rows">${UI.loading()}</div>
      </div>`;
    const box = document.getElementById('rows');
    const load = () => onLoad(box, () => {
      const values = {};
      host.querySelectorAll('.filters [id^="f-"]').forEach((el) => {
        values[el.id.slice(2)] = el.value;
      });
      return values;
    });
    let timer = null;
    host.querySelectorAll('.filters input').forEach((el) => el.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    }));
    host.querySelectorAll('.filters select').forEach((el) => el.addEventListener('change', load));
    return load();
  }

  // ================================================================ enquiries
  APP.register('enquiries', {
    title: 'Enquiries',
    subtitle: 'What clients have asked for, and what we have quoted against it',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Status</span><select id="f-status">
            <option value="">Open (not yet closed)</option>
            <option value="open">Open</option><option value="quoted">Quoted</option>
            <option value="won">Won</option><option value="lost">Lost</option>
          </select></label>`,
        actions: [{ id: 'new', label: '+ New enquiry', kind: 'gold', onClick: () => openEnquiry() }],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/sales/enquiries' + API.qs({
            q: v.q, status: v.status, open: v.status ? '' : '1', limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'No.', render: (r) => `<span class="mono">${esc(r.enquiry_no)}</span>` },
            { label: 'From', render: (r) => `<b>${esc(r.partner_name || r.client_name || '—')}</b>
                <div class="muted small">${esc(r.contact_person || '')}</div>` },
            { label: 'Subject / project', render: (r) => `${esc(r.subject || '—')}
                <div class="muted small">${esc(r.project || '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Received', render: (r) => UI.date(r.received_on) },
            { label: 'Wanted by', render: (r) => (r.due_on ? UI.date(r.due_on) : '—') },
            { label: 'With', key: 'owner_name' },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No enquiries logged yet.' });
          UI.bindRows(box, res.rows, (row) => openEnquiry(row));
        },
      });
    },
  });

  async function openEnquiry(enquiry) {
    const m = await APP.loadMasters();
    const clients = (await API.get('/api/partners?type=client&limit=500')).rows;
    const isNew = !enquiry;

    UI.modal({
      title: isNew ? 'New enquiry' : `${enquiry.enquiry_no}`,
      body: `<form id="e-form">
        ${UI.field({ name: 'partner_id', label: 'Client', blank: 'Not on the books yet',
          value: enquiry ? enquiry.partner_id : '',
          options: clients.map((c) => ({ value: c.id, label: c.name })) })}
        ${UI.field({ name: 'client_name', label: 'Or the name they gave',
          value: enquiry ? enquiry.client_name || '' : '' })}
        <div class="grid g2">
          ${UI.field({ name: 'contact_person', label: 'Contact', value: enquiry ? enquiry.contact_person || '' : '' })}
          ${UI.field({ name: 'phone', label: 'Phone', value: enquiry ? enquiry.phone || '' : '' })}
        </div>
        ${UI.field({ name: 'application_id', label: 'Application', blank: 'Not stated',
          value: enquiry ? enquiry.application_id : '', options: APP.applicationOptions() })}
        ${UI.field({ name: 'subject', label: 'Subject', value: enquiry ? enquiry.subject || '' : '' })}
        ${UI.field({ name: 'project', label: 'Project', value: enquiry ? enquiry.project || '' : '' })}
        ${UI.field({ name: 'requirement', label: 'What they need', rows: 4,
          value: enquiry ? enquiry.requirement || '' : '' })}
        <div class="grid g2">
          ${UI.field({ name: 'received_on', label: 'Received on', type: 'date',
            value: enquiry ? enquiry.received_on : UI.today() })}
          ${UI.field({ name: 'due_on', label: 'Quotation wanted by', type: 'date',
            value: enquiry ? enquiry.due_on || '' : '' })}
        </div>
        ${UI.field({ name: 'owner_id', label: 'Handled by', blank: 'Me',
          value: enquiry ? enquiry.owner_id : '',
          options: m.users.map((u) => ({ value: u.id, label: u.name })) })}
        ${enquiry ? UI.field({ name: 'status', label: 'Status', value: enquiry.status,
          options: ['open', 'quoted', 'won', 'lost', 'closed'].map((s) => ({ value: s, label: UI.titleise(s) })) }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        ${enquiry ? '<button class="btn gold" data-act="quote">Quote it</button>' : ''}
        <button class="btn" data-act="save">${isNew ? 'Log the enquiry' : 'Save'}</button>`,
      async onAction(act, modal) {
        if (act === 'quote') {
          UI.closeAllModals();
          openQuotation(null, { enquiry });
          return;
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#e-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (enquiry) await API.patch(`/api/sales/enquiries/${enquiry.id}`, values);
        else await API.post('/api/sales/enquiries', values);
        UI.ok('Saved.');
        APP.reload();
      },
    });
  }

  // =============================================================== quotations
  APP.register('quotations', {
    title: 'Our Quotations',
    subtitle: 'What we have offered clients, and at what price',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Status</span><select id="f-status">
            <option value="">All</option>
            ${['draft', 'sent', 'under_review', 'approved', 'rejected', 'expired', 'converted']
              .map((s) => `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Application</span><select id="f-application_id">
            <option value="">All</option>
            ${APP.applications().map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
          </select></label>`,
        actions: APP.can(['sales', 'kam'])
          ? [{ id: 'new', label: '+ New quotation', kind: 'gold', onClick: () => openQuotation() }] : [],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/sales/quotations' + API.qs({
            q: v.q, status: v.status, application_id: v.application_id, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'Quotation', render: (r) => `<span class="mono">${esc(r.quote_no)}</span>` },
            { label: 'Client', render: (r) => `<b>${esc(r.client_name)}</b>
                <div class="muted small">${esc(r.project || r.subject || '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Date', render: (r) => UI.date(r.quote_date) },
            { label: 'Valid until', render: (r) => UI.date(r.valid_until) },
            { label: 'Terms', key: 'terms_name' },
            { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No quotations yet.' });
          UI.bindRows(box, res.rows, (row) => showQuotation(row.id));
        },
      });
    },
  });

  async function showQuotation(id) {
    const d = await API.get(`/api/sales/quotations/${id}`);
    const q = d.quotation;
    const short = d.availability.filter((a) => a.available < a.qty);

    UI.modal({
      title: `${q.quote_no} — ${q.client_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(q.status)}
            ${q.application_name ? UI.badge(q.application_name, 'navy') : ''}</div>
          <div class="muted small">Raised by ${esc(q.created_by_name || '')} on ${UI.date(q.quote_date)}</div>
        </div>
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Project', esc(q.project || '—')],
            ['Subject', esc(q.subject || '—')],
            ['Attention', esc(q.attention || '—')],
            ['Valid until', UI.date(q.valid_until)],
            ['Delivery', q.delivery_days ? `${q.delivery_days} days from order` : (q.delivery_terms || '—')],
            ['Payment terms', esc(d.termsText)],
          ])}</div>
          <div>${UI.facts([
            ['Taxable', UI.money(q.subtotal - q.discount)],
            ['VAT', UI.money(q.vat_amount)],
            ['Total', `<b>${UI.money(q.total)}</b>`],
            d.margin ? ['Cost', UI.money(d.margin.cost)] : null,
            d.margin ? ['Margin', `<b>${UI.money(d.margin.margin)} (${d.margin.margin_percent}%)</b>`] : null,
          ])}</div>
        </div>
        ${short.length ? `<div class="alert warn"><b>Not all of this is available.</b>
          ${short.map((a) => `${esc(a.item_code)} — quoted ${UI.qty(a.qty)}, free ${UI.qty(a.free)},
            on order ${UI.qty(a.on_order)}`).join('<br>')}</div>` : ''}
        ${UI.table([
          { label: '#', num: true, render: (r, i) => i + 1 },
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Rate', num: true, render: (r) => UI.money(r.unit_price, { symbol: false }) },
          { label: 'Disc.', num: true, render: (r) => (r.discount ? UI.money(r.discount, { symbol: false }) : '—') },
          { label: 'VAT', num: true, render: (r) => UI.money(r.vat_amount, { symbol: false }) },
          { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.total, { symbol: false })}</b>` },
        ], d.items)}
        ${q.notes ? `<div class="mt"><b class="small">Notes</b><div class="muted small">${esc(q.notes)}</div></div>` : ''}
        ${d.conditions && d.conditions.length ? `<h4 class="mt">Terms &amp; conditions</h4>
          <ol class="conditions">${d.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>` : ''}
        ${d.orders.length ? `<div class="alert ok mt">The client ordered against this:
          ${d.orders.map((o) => `<b>${esc(o.so_no)}</b> (their LPO ${esc(o.client_lpo_no)})`).join(', ')}</div>` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print</button>
        ${APP.can(['sales', 'kam']) && q.status === 'draft' ? '<button class="btn ghost" data-act="edit">Edit</button>' : ''}
        ${APP.can(['sales', 'kam']) && q.status === 'draft' ? '<button class="btn ghost" data-act="send">Mark as sent</button>' : ''}
        ${APP.can(['sales', 'kam']) && q.status !== 'converted' ? '<button class="btn ghost" data-act="revise">Revise</button>' : ''}
        ${APP.can(['kam']) ? '<button class="btn ghost" data-act="buy">Ask a maker to price it</button>' : ''}
        ${APP.can(['sales', 'kam']) && q.status !== 'converted' ? '<button class="btn gold" data-act="order">Their LPO arrived</button>' : ''}`,
      async onAction(act) {
        if (act === 'print') {
          const w = PRINT.openWindow();
          PRINT.DOCS.salesQuotation(d, w);
          return 'keep';
        }
        if (act === 'edit') { UI.closeAllModals(); openQuotation(d); return; }
        if (act === 'send') {
          await API.post(`/api/sales/quotations/${q.id}/send`);
          UI.ok('Marked as sent.');
          APP.reload();
          return;
        }
        if (act === 'revise') {
          const revised = await API.post(`/api/sales/quotations/${q.id}/revise`);
          UI.ok(`Revision ${revised.quote_no} created as a draft.`);
          UI.closeAllModals();
          showQuotation(revised.id);
          return 'keep';
        }
        if (act === 'order') { UI.closeAllModals(); openOrder(null, { quotation: d }); return; }
        if (act === 'buy') { UI.closeAllModals(); BUY.openSupplierQuotation(null, { fromQuotation: d }); }
      },
    });
  }

  async function openQuotation(existing, { enquiry } = {}) {
    const clients = (await API.get('/api/partners?type=client&limit=500')).rows;
    const q = existing ? existing.quotation : null;
    const preset = enquiry || null;

    UI.modal({
      title: q ? `Edit ${q.quote_no}` : 'New quotation',
      size: 'wide',
      body: `<form id="q-form">
        <div class="grid g3">
          ${UI.field({ name: 'partner_id', label: 'Client', required: true,
            value: q ? q.partner_id : (preset ? preset.partner_id : ''), blank: 'Choose a client…',
            options: clients.map((c) => ({ value: c.id, label: c.name })) })}
          ${UI.field({ name: 'application_id', label: 'Application', blank: 'Take it from the lines',
            value: q ? q.application_id : (preset ? preset.application_id : ''),
            options: APP.applicationOptions(),
            hint: 'The title this quotation carries.' })}
          ${UI.field({ name: 'payment_terms_id', label: 'Payment terms', blank: "The client's own terms",
            value: q ? q.payment_terms_id : '', options: APP.termsOptions('client') })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'subject', label: 'Subject', value: q ? q.subject || '' : (preset ? preset.subject || '' : '') })}
          ${UI.field({ name: 'project', label: 'Project', value: q ? q.project || '' : (preset ? preset.project || '' : '') })}
          ${UI.field({ name: 'attention', label: 'For the attention of', value: q ? q.attention || '' : '' })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'quote_date', label: 'Date', type: 'date', value: q ? q.quote_date : UI.today() })}
          ${UI.field({ name: 'valid_until', label: 'Valid until', type: 'date',
            value: q ? q.valid_until : UI.addDays(UI.today(), 30) })}
          ${UI.field({ name: 'delivery_days', label: 'Delivery (days from order)', type: 'number',
            value: q ? q.delivery_days : 0 })}
        </div>
        <h4 class="mt">Lines</h4>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes for the client', rows: 2, value: q ? q.notes || '' : '' })}
        <h4 class="mt">Terms &amp; conditions</h4>
        <div class="muted small mb">From the standard list under Masters → Terms &amp; conditions.
          Untick what does not apply, or edit any point — what you leave here is what the client
          receives.</div>
        <div id="clauses">${UI.loading()}</div>
        ${preset && preset.id ? `<input type="hidden" name="enquiry_id" value="${preset.id}">` : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${q ? 'Save' : 'Create the quotation'}</button>`,
      async onMount(modal) {
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), {
          side: 'sell', lines: existing ? existing.items : [],
        });
        const host = modal.querySelector('#clauses');
        // An existing quotation keeps the points it was written with; a new one
        // starts from the standard list.
        if (existing && existing.conditions && existing.conditions.length) {
          modal._clauses = CLAUSES.Editor(host, { clauses: existing.conditions });
        } else {
          const lib = await API.get('/api/masters/terms?doc_type=sales_quotation');
          modal._clauses = CLAUSES.Editor(host, {
            clauses: lib.rows.filter((c) => c.is_default)
              .map((c) => ({ text: c.text, clause_group: c.clause_group })),
          });
        }
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#q-form');
        if (!form.reportValidity()) return 'keep';
        const items = modal._lines.value();
        if (!items.length) { UI.err('A quotation needs at least one priced line.'); return 'keep'; }
        const conditions = modal._clauses ? modal._clauses.value() : [];
        const values = { ...UI.formValues(form), items, terms_text: conditions.join('\n') };
        const saved = q
          ? await API.patch(`/api/sales/quotations/${q.id}`, values)
          : await API.post('/api/sales/quotations', values);
        UI.ok(q ? 'Quotation saved.' : `Created ${saved.quote_no}.`);
        APP.reload();
      },
    });
  }

  // ============================================================ client's LPO
  APP.register('orders', {
    title: 'Client LPOs',
    subtitle: 'Their purchase orders to us — confirmed, committed in stock, and due for delivery',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Status</span><select id="f-status">
            <option value="">All</option>
            ${['confirmed', 'partial', 'delivered', 'invoiced', 'closed', 'cancelled']
              .map((s) => `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
          </select></label>`,
        actions: APP.can(['sales', 'kam'])
          ? [{ id: 'new', label: '+ Record a client LPO', kind: 'gold', onClick: () => openOrder() }] : [],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/sales/orders' + API.qs({ q: v.q, status: v.status, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'Our ref', render: (r) => `<span class="mono">${esc(r.so_no)}</span>` },
            { label: 'Their LPO', render: (r) => `<b>${esc(r.client_lpo_no)}</b>
                <div class="muted small">${UI.date(r.client_lpo_date)}</div>` },
            { label: 'Client', render: (r) => `${esc(r.client_name)}
                <div class="muted small">${esc(r.project || '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Delivery by', render: (r) => (r.delivery_date ? UI.date(r.delivery_date) : '—') },
            { label: 'Terms', key: 'terms_name' },
            { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
            { label: 'Advance', num: true, render: (r) => (r.advance_required
              ? `${UI.money(r.advance_received, { symbol: false })} / ${UI.money(r.advance_required, { symbol: false })}` : '—') },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No client orders yet.' });
          UI.bindRows(box, res.rows, (row) => showOrder(row.id));
        },
      });
    },
  });

  async function showOrder(id) {
    const d = await API.get(`/api/sales/orders/${id}`);
    const o = d.order;
    const hold = !d.release.ok;

    UI.modal({
      title: `${o.so_no} — client LPO ${o.client_lpo_no}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(o.status)}
            ${o.application_name ? UI.badge(o.application_name, 'navy') : ''}</div>
          <div class="muted small">${esc(o.client_name)}</div>
        </div>
        ${hold ? `<div class="alert danger"><b>On hold for payment.</b> ${esc(d.release.reason)}</div>` : ''}
        ${d.schedule.on_delivery ? `<div class="alert warn"><b>Collect at delivery:</b>
          ${UI.money(d.schedule.on_delivery)} is payable against the delivery note.</div>` : ''}
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Their LPO', `<b>${esc(o.client_lpo_no)}</b> · ${UI.date(o.client_lpo_date)}`],
            ['Our quotation', esc(o.quote_no || '—')],
            ['Project', esc(o.project || '—')],
            ['Their purchase officer', esc([o.purchase_officer, o.purchase_officer_mobile]
              .filter(Boolean).join(' · ') || '—')],
            ['Delivery by', o.delivery_date ? UI.date(o.delivery_date) : '—'],
            ['Delivery location', esc(o.delivery_location || '—')],
            ['Site contact', esc([o.delivery_contact, o.delivery_mobile]
              .filter(Boolean).join(' · ') || '—')],
            ['Deliver to', esc(o.delivery_address || '—')],
            ['Payment terms', esc(d.termsText)],
          ])}</div>
          <div>${UI.facts([
            ['Taxable', UI.money(o.subtotal - o.discount)],
            ['VAT', UI.money(o.vat_amount)],
            ['Total', `<b>${UI.money(o.total)}</b>`],
            d.schedule.advance ? ['Advance wanted', `${UI.money(d.schedule.advance)} — received ${UI.money(o.advance_received)}`] : null,
            d.schedule.credit ? ['On credit', `${UI.money(d.schedule.credit)} · ${d.schedule.credit_days} days`] : null,
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Ordered', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Delivered', num: true, render: (r) => UI.qty(r.delivered_qty) },
          { label: 'Still to go', num: true, render: (r) => (r.pending_qty ? `<b>${UI.qty(r.pending_qty)}</b>` : '—') },
          { label: 'Rate', num: true, render: (r) => UI.money(r.unit_price, { symbol: false }) },
          { label: 'Amount', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
        ], d.items)}
        <h4 class="mt">Can we deliver it?</h4>
        ${UI.table([
          { label: 'Item', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span> ${esc(r.description)}` },
          { label: 'Still to deliver', num: true, render: (r) => UI.qty(r.pending) },
          { label: 'Free in yard', num: true, render: (r) => UI.qty(r.free) },
          { label: 'On order', num: true, render: (r) => UI.qty(r.on_order) },
          { label: '', render: (r) => (r.free >= r.pending ? UI.badge('Ready', 'ok')
            : (r.free + r.on_order >= r.pending ? UI.badge('On order', 'warn') : UI.badge('Must be bought', 'danger'))) },
        ], d.availability, { emptyText: 'No catalogue items on this order.' })}
        ${d.deliveries.length ? `<h4 class="mt">Deliveries</h4>${UI.table([
          { label: 'DN', key: 'dn_no' }, { label: 'Date', render: (r) => UI.date(r.delivery_date) },
          { label: 'Vehicle', key: 'vehicle_no' }, { label: 'Received by', key: 'received_by' },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.deliveries)}` : ''}
        ${d.invoices.length ? `<h4 class="mt">Tax invoices</h4>${UI.table([
          { label: 'No.', key: 'invoice_no' }, { label: 'Date', render: (r) => UI.date(r.invoice_date) },
          { label: 'Due', render: (r) => UI.date(r.due_date) },
          { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.invoices)}` : ''}
        ${d.purchaseOrders.length ? `<h4 class="mt">Bought in against this order</h4>${UI.table([
          { label: 'LPO', key: 'lpo_no' }, { label: 'Date', render: (r) => UI.date(r.lpo_date) },
          { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.purchaseOrders)}` : ''}
        <div id="so-attachments"></div>`,
      onMount(modal) {
        ATTACH.panel(modal.querySelector('#so-attachments'), {
          entityType: 'sales_order', entityId: o.id, kind: "Client's LPO",
          title: 'Their paperwork',
        });
      },
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${APP.can(['kam']) ? '<button class="btn ghost" data-act="plan">What to buy in</button>' : ''}
        ${APP.can(['accounts']) && d.schedule.advance > o.advance_received
          ? '<button class="btn ghost" data-act="advance">Record the advance</button>' : ''}
        ${APP.can(['logistics', 'kam']) && ['confirmed', 'partial'].includes(o.status)
          ? '<button class="btn gold" data-act="deliver">Deliver</button>' : ''}
        ${APP.can(['accounts']) ? '<button class="btn green" data-act="invoice">Raise the tax invoice</button>' : ''}`,
      async onAction(act) {
        if (act === 'deliver') { UI.closeAllModals(); openDelivery(d); return; }
        if (act === 'invoice') { UI.closeAllModals(); openInvoice(d); return; }
        if (act === 'advance') { UI.closeAllModals(); MONEY.openPayment({ direction: 'in',
          partner_id: o.partner_id, sales_order_id: o.id, kind: 'advance',
          amount: Math.max(0, d.schedule.advance - o.advance_received) }); return; }
        if (act === 'plan') {
          const plan = await API.get(`/api/sales/orders/${o.id}/purchase-plan`);
          UI.closeAllModals();
          showPurchasePlan(plan);
          return 'keep';
        }
      },
    });
  }

  function showPurchasePlan(plan) {
    UI.modal({
      title: `What to buy in for ${plan.order.so_no}`,
      size: 'wide',
      body: plan.plan.length
        ? `<p class="muted">These lines cannot be covered by free stock or by what is already on
             order, so an LPO has to go to a manufacturer.</p>` + UI.table([
          { label: 'Item', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span> ${esc(r.description)}` },
          { label: 'Ordered', num: true, render: (r) => `${UI.qty(r.ordered_qty)} ${esc(r.uom || '')}` },
          { label: 'Free', num: true, render: (r) => UI.qty(r.free_stock) },
          { label: 'On order', num: true, render: (r) => UI.qty(r.on_order) },
          { label: 'To buy', num: true, render: (r) => `<b>${UI.qty(r.to_buy)}</b>` },
          { label: 'Usual maker', render: (r) => (r.suggested_supplier
            ? `${esc(r.suggested_supplier.name)}${r.suggested_supplier.last_price
              ? ` <span class="muted small">last ${UI.money(r.suggested_supplier.last_price)}</span>` : ''}`
            : '<span class="muted">none on file</span>') },
        ], plan.plan)
        : '<div class="alert ok">Everything on this order is covered by free stock or by material already on order.</div>',
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${plan.plan.length ? '<button class="btn gold" data-act="lpo">Raise an LPO for these</button>' : ''}`,
      onAction(act) {
        if (act !== 'lpo') return;
        UI.closeAllModals();
        BUY.openPurchaseOrder(null, {
          salesOrderId: plan.order.id,
          project: plan.order.project,
          application_id: plan.order.application_id,
          lines: plan.plan.map((p) => ({
            item_id: p.item_id, item_code: p.item_code, description: p.description,
            qty: p.to_buy, uom: p.uom,
            unit_price: p.suggested_supplier ? p.suggested_supplier.last_price || 0 : 0,
          })),
          partner_id: (plan.plan.find((p) => p.suggested_supplier) || {}).suggested_supplier?.id,
        });
      },
    });
  }

  async function openOrder(existing, { quotation } = {}) {
    const clients = (await API.get('/api/partners?type=client&limit=500')).rows;
    const q = quotation ? quotation.quotation : null;

    UI.modal({
      title: 'Record the client\'s LPO',
      size: 'wide',
      body: `<form id="o-form">
        <div class="grid g3">
          ${UI.field({ name: 'partner_id', label: 'Client', required: true,
            value: q ? q.partner_id : '', blank: 'Choose a client…',
            options: clients.map((c) => ({ value: c.id, label: c.name })) })}
          ${UI.field({ name: 'client_lpo_no', label: 'Their LPO number', required: true,
            placeholder: 'ASC/LPO/2026/0912' })}
          ${UI.field({ name: 'client_lpo_date', label: 'Their LPO date', type: 'date', value: UI.today() })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'application_id', label: 'Application', blank: 'Take it from the lines',
            value: q ? q.application_id : '', options: APP.applicationOptions() })}
          ${UI.field({ name: 'payment_terms_id', label: 'Payment terms', blank: "The client's own terms",
            value: q ? q.payment_terms_id : '', options: APP.termsOptions('client'),
            hint: 'Decides the advance, the cheque at the gate and the due date.' })}
          ${UI.field({ name: 'delivery_date', label: 'Delivery wanted by', type: 'date' })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'project', label: 'Project', value: q ? q.project || '' : '' })}
          ${UI.field({ name: 'purchase_officer', label: 'Their purchase officer',
            placeholder: 'Name' })}
          ${UI.field({ name: 'purchase_officer_mobile', label: "Purchase officer's mobile",
            type: 'tel', placeholder: '05X XXX XXXX',
            hint: 'Who to ring about the order itself.' })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'delivery_location', label: 'Delivery location',
            placeholder: 'Mirdif, Dubai', hint: 'Where, in short — for the driver.' })}
          ${UI.field({ name: 'delivery_contact', label: 'Site contact', placeholder: 'Name' })}
          ${UI.field({ name: 'delivery_mobile', label: 'Delivery mobile', type: 'tel',
            placeholder: '05X XXX XXXX', hint: 'Who the driver rings at the gate.' })}
        </div>
        ${UI.field({ name: 'delivery_address', label: 'Full delivery address', rows: 2 })}
        <h4 class="mt">Lines</h4>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
        <h4 class="mt">The client's LPO document</h4>
        <div class="muted small mb">Attach their PDF once the order is saved — it is kept with the
          order so it can be opened years later.</div>
        <label class="dropzone" id="lpo-drop">
          <input type="file" hidden id="lpo-file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx">
          <span id="lpo-drop-text">Drop their LPO here, or <b>choose the file</b></span>
        </label>
        ${q ? `<input type="hidden" name="quotation_id" value="${q.id}">` : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Confirm the order</button>`,
      onMount(modal) {
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), {
          side: 'sell', lines: quotation ? quotation.items : [],
        });

        /*
         * The file is held until the order exists, because an attachment needs
         * something to be attached to. Chosen or dropped, either way.
         */
        const zone = modal.querySelector('#lpo-drop');
        const input = modal.querySelector('#lpo-file');
        const label = modal.querySelector('#lpo-drop-text');
        const take = (file) => {
          if (!file) return;
          modal._lpoFile = file;
          label.innerHTML = `<b>${UI.esc(file.name)}</b> — ${ATTACH.size(file.size)}, `
            + 'attached when the order is saved';
        };
        input.addEventListener('change', () => take(input.files[0]));
        ['dragenter', 'dragover'].forEach((e) => zone.addEventListener(e, (ev) => {
          ev.preventDefault();
          zone.classList.add('over');
        }));
        ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, (ev) => {
          ev.preventDefault();
          zone.classList.remove('over');
        }));
        zone.addEventListener('drop', (ev) => take(ev.dataTransfer.files[0]));
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#o-form');
        if (!form.reportValidity()) return 'keep';
        const items = modal._lines.value();
        if (!items.length) { UI.err('An order needs at least one line.'); return 'keep'; }
        const saved = await API.post('/api/sales/orders', { ...UI.formValues(form), items });
        UI.ok(`${saved.so_no} confirmed — the material is now committed in the stock register.`);

        // The order exists now, so the file has something to hang on. A failure
        // here must not read as a failure to record the order.
        if (modal._lpoFile) {
          try {
            const reader = new FileReader();
            const data = await new Promise((resolve, reject) => {
              reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
              reader.onerror = () => reject(new Error('That file could not be read.'));
              reader.readAsDataURL(modal._lpoFile);
            });
            await API.post(`/api/attachments/sales_order/${saved.id}`, {
              data, filename: modal._lpoFile.name, mime: modal._lpoFile.type || null,
              kind: "Client's LPO",
            });
            UI.ok('Their LPO is attached to the order.');
          } catch (err) {
            UI.err(`${saved.so_no} was saved, but the file was not attached: ${err.message}`);
          }
        }
        APP.reload();
      },
    });
  }

  // ============================================================== deliveries
  APP.register('deliveries', {
    title: 'Deliveries',
    subtitle: 'What has left the yard, against which order',

    render(host) {
      return listPage(host, {
        actions: APP.can(['logistics', 'kam'])
          ? [{ id: 'new', label: '+ New delivery', kind: 'gold', onClick: () => openDelivery(null) }] : [],
        async onLoad(box) {
          box.innerHTML = UI.loading();
          const res = await API.get('/api/sales/deliveries?limit=200');
          box.innerHTML = UI.table([
            { label: 'DN', render: (r) => `<span class="mono">${esc(r.dn_no)}</span>` },
            { label: 'Client', render: (r) => `<b>${esc(r.client_name)}</b>
                <div class="muted small">${esc(r.client_lpo_no ? 'their LPO ' + r.client_lpo_no : '')}</div>` },
            { label: 'Against', key: 'so_no' },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Date', render: (r) => UI.date(r.delivery_date) },
            { label: 'Vehicle', key: 'vehicle_no' },
            { label: 'Qty', num: true, render: (r) => UI.qty(r.total_qty) },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'Nothing has been delivered yet.' });
          UI.bindRows(box, res.rows, (row) => showDelivery(row.id));
        },
      });
    },
  });

  async function showDelivery(id) {
    const d = await API.get(`/api/sales/deliveries/${id}`);
    const n = d.delivery;
    UI.modal({
      title: `${n.dn_no} — ${n.client_name}`,
      size: 'wide',
      body: `
        ${d.collectCheque ? `<div class="alert warn"><b>Payment on delivery.</b> This client's terms are
          payment against the signed delivery note — the driver should not come back without it.</div>` : ''}
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Against', esc(n.so_no ? `${n.so_no} · their LPO ${n.client_lpo_no || ''}` : '—')],
            ['Delivered on', UI.date(n.delivery_date)],
            ['Address', esc(n.delivery_address || '—')],
            ['Site contact', esc([n.delivery_contact, n.delivery_mobile]
              .filter(Boolean).join(' · ') || '—')],
            ['Vehicle / driver', esc([n.vehicle_no, n.driver_name].filter(Boolean).join(' · ') || '—')],
          ])}</div>
          <div>${UI.facts([
            ['Received by', esc(n.received_by || 'not acknowledged yet')],
            ['Status', UI.statusBadge(n.status)],
            ['Invoice', d.invoice ? `${esc(d.invoice.invoice_no)} — ${UI.money(d.invoice.total)}`
              : '<span class="muted">not invoiced yet</span>'],
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Remarks', key: 'remarks' },
        ], d.items)}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print the delivery note</button>
        ${APP.can(['logistics', 'kam']) && n.status === 'delivered'
          ? '<button class="btn ghost" data-act="ack">Client signed for it</button>' : ''}
        ${APP.can(['accounts']) && !d.invoice ? '<button class="btn green" data-act="invoice">Raise the tax invoice</button>' : ''}`,
      async onAction(act, modal) {
        if (act === 'print') { const w = PRINT.openWindow(); PRINT.DOCS.deliveryNote(d, w); return 'keep'; }
        if (act === 'ack') {
          const who = window.prompt('Who signed for it?', n.received_by || '');
          if (who === null) return 'keep';
          await API.post(`/api/sales/deliveries/${n.id}/acknowledge`, { received_by: who });
          UI.ok('Acknowledged.');
          APP.reload();
          return;
        }
        if (act === 'invoice') {
          UI.closeAllModals();
          const order = n.so_id ? await API.get(`/api/sales/orders/${n.so_id}`) : null;
          openInvoice(order, { delivery: n });
        }
      },
    });
  }

  async function openDelivery(orderData) {
    let order = orderData;
    if (!order) {
      const open = await API.get('/api/sales/orders?open=1&limit=200');
      if (!open.rows.length) { UI.warn('There are no open client orders to deliver against.'); return; }
      const picked = await pickOne('Which order is being delivered?', open.rows.map((r) => ({
        id: r.id, label: `${r.so_no} — ${r.client_name}`, note: `their LPO ${r.client_lpo_no}` })));
      if (!picked) return;
      order = await API.get(`/api/sales/orders/${picked}`);
    }
    const o = order.order;
    const pending = order.items.filter((i) => i.pending_qty > 0);
    if (!pending.length) { UI.warn('Everything on this order has already been delivered.'); return; }
    const hold = !order.release.ok;

    UI.modal({
      title: `Deliver against ${o.so_no}`,
      size: 'wide',
      body: `
        ${hold ? `<div class="alert danger"><b>On hold.</b> ${esc(order.release.reason)}
          <div class="small mt">A manager can release it anyway by ticking the box below — the
          reason is recorded either way.</div></div>` : ''}
        ${order.schedule.on_delivery ? `<div class="alert warn"><b>Collect ${UI.money(order.schedule.on_delivery)}
          at the gate</b> — this client pays against the signed delivery note.</div>` : ''}
        <form id="d-form">
          <div class="grid g3">
            ${UI.field({ name: 'delivery_date', label: 'Delivery date', type: 'date', value: UI.today(), required: true })}
            ${UI.field({ name: 'vehicle_no', label: 'Vehicle number' })}
            ${UI.field({ name: 'driver_name', label: 'Driver' })}
          </div>
          ${UI.field({ name: 'delivery_address', label: 'Deliver to', rows: 2,
            value: o.delivery_address || '' })}
          <h4>What is going</h4>
          <div class="table-wrap"><table><thead><tr>
            <th>Item</th><th class="num">Ordered</th><th class="num">Already gone</th>
            <th class="num">Sending now</th></tr></thead><tbody>
            ${pending.map((i) => `<tr>
              <td><b>${esc(i.description)}</b>
                <div class="muted small mono">${esc(i.item_code || '')}</div></td>
              <td class="num">${UI.qty(i.qty)} ${esc(i.uom)}</td>
              <td class="num">${UI.qty(i.delivered_qty)}</td>
              <td><input type="number" step="0.001" min="0" max="${i.pending_qty}"
                    data-so-item="${i.id}" value="${i.pending_qty}" style="width:110px"></td>
            </tr>`).join('')}
          </tbody></table></div>
          ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
          ${hold ? UI.checkbox({ name: 'override_hold', label: 'Release this delivery despite the payment hold' }) : ''}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn gold" data-act="save">Record the delivery</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#d-form');
        if (!form.reportValidity()) return 'keep';
        const items = [...form.querySelectorAll('[data-so-item]')]
          .map((el) => ({ so_item_id: Number(el.dataset.soItem), qty: Number(el.value) || 0 }))
          .filter((l) => l.qty > 0);
        if (!items.length) { UI.err('Nothing has been entered to deliver.'); return 'keep'; }
        const values = UI.formValues(form);
        const saved = await API.post('/api/sales/deliveries', {
          ...values, partner_id: o.partner_id, so_id: o.id, items,
          override_hold: form.querySelector('[name=override_hold]')
            ? form.querySelector('[name=override_hold]').checked : false,
        });
        UI.ok(`${saved.dn_no} recorded — the material is out of the yard.`);
        const w = PRINT.openWindow();
        const full = await API.get(`/api/sales/deliveries/${saved.id}`);
        PRINT.DOCS.deliveryNote(full, w);
        APP.reload();
      },
    });
  }

  // ============================================================ tax invoices
  APP.register('invoices', {
    title: 'Tax Invoices',
    subtitle: `Issued to clients with ${APP.vatPercent}% VAT — and what is still to be collected`,

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Show</span><select id="f-status">
            <option value="">All</option><option value="unpaid">Unpaid</option>
            <option value="partial">Part paid</option><option value="overdue">Overdue</option>
            <option value="paid">Paid</option></select></label>`,
        actions: APP.can(['accounts'])
          ? [{ id: 'new', label: '+ New tax invoice', kind: 'gold', onClick: () => openInvoice(null) }] : [],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/sales/invoices' + API.qs({ q: v.q, status: v.status, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'Invoice', render: (r) => `<span class="mono">${esc(r.invoice_no)}</span>` },
            { label: 'Client', render: (r) => `<b>${esc(r.partner_name)}</b>
                <div class="muted small">${esc(r.client_lpo_no ? 'their LPO ' + r.client_lpo_no : '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Date', render: (r) => UI.date(r.invoice_date) },
            { label: 'Due', render: (r) => `${UI.date(r.due_date)}
                <div class="muted small">${esc(UI.dueIn(r.due_date))}</div>` },
            { label: 'VAT', num: true, render: (r) => UI.money(r.vat_amount, { symbol: false }) },
            { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
            { label: 'Outstanding', num: true, render: (r) => (r.outstanding
              ? `<b>${UI.money(r.outstanding, { symbol: false })}</b>` : '—') },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No invoices raised yet.' });
          UI.bindRows(box, res.rows, (row) => showInvoice(row.id));
        },
      });
    },
  });

  async function showInvoice(id) {
    const d = await API.get(`/api/sales/invoices/${id}`);
    const i = d.invoice;
    UI.modal({
      title: `Tax invoice ${i.invoice_no}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(i.status)}
            ${i.application_name ? UI.badge(i.application_name, 'navy') : ''}</div>
          <div class="muted small">${esc(i.client_name)}${i.client_trn ? ' · TRN ' + esc(i.client_trn) : ''}</div>
        </div>
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Their LPO', esc(i.client_lpo_no || '—')],
            ['Our order', esc(i.so_no || '—')],
            ['Delivery note', esc(i.dn_no || '—')],
            ['Invoice date', UI.date(i.invoice_date)],
            ['Due date', `${UI.date(i.due_date)} <span class="muted small">(${esc(UI.dueIn(i.due_date))})</span>`],
            ['Payment terms', esc(d.termsText)],
          ])}</div>
          <div>${UI.facts([
            ['Taxable', UI.money(i.subtotal - i.discount)],
            [`VAT @ ${APP.vatPercent}%`, UI.money(i.vat_amount)],
            ['Total', `<b>${UI.money(i.total)}</b>`],
            ['Received', UI.money(i.paid_amount)],
            ['Outstanding', `<b>${UI.money(i.total - i.paid_amount)}</b>`],
            d.margin ? ['Margin', `${UI.money(d.margin.margin)} (${d.margin.margin_percent}%)`] : null,
          ])}</div>
        </div>
        <div class="muted small mb">${esc(d.amountInWords)}</div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Rate', num: true, render: (r) => UI.money(r.unit_price, { symbol: false }) },
          { label: 'Taxable', num: true, render: (r) => UI.money(r.taxable, { symbol: false }) },
          { label: 'VAT', num: true, render: (r) => UI.money(r.vat_amount, { symbol: false }) },
          { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.total, { symbol: false })}</b>` },
        ], d.items)}
        ${d.receipts.length ? `<h4 class="mt">Received against it</h4>${UI.table([
          { label: 'Voucher', key: 'payment_no' }, { label: 'Date', render: (r) => UI.date(r.payment_date) },
          { label: 'Mode', render: (r) => UI.titleise(r.mode) },
          { label: 'Cheque', render: (r) => (r.cheque_no ? `${esc(r.cheque_no)} · ${UI.date(r.cheque_date)}` : '—') },
          { label: 'Amount', num: true, render: (r) => UI.money(r.amount, { symbol: false }) },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.receipts)}` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print</button>
        ${APP.can(['accounts']) && i.status !== 'paid' && i.status !== 'cancelled'
          ? '<button class="btn green" data-act="receipt">Record a receipt</button>' : ''}`,
      async onAction(act) {
        if (act === 'print') { const w = PRINT.openWindow(); PRINT.DOCS.taxInvoice(d, w); return 'keep'; }
        if (act === 'receipt') {
          UI.closeAllModals();
          MONEY.openPayment({ direction: 'in', partner_id: i.partner_id,
            amount: Math.round((i.total - i.paid_amount) * 100) / 100,
            allocations: [{ invoice_side: 'sales', invoice_id: i.id,
              amount: Math.round((i.total - i.paid_amount) * 100) / 100 }] });
        }
      },
    });
  }

  async function openInvoice(orderData, { delivery } = {}) {
    let order = orderData;
    if (!order && !delivery) {
      const open = await API.get('/api/sales/orders?limit=200');
      const picked = await pickOne('Invoice against which order?', open.rows.map((r) => ({
        id: r.id, label: `${r.so_no} — ${r.client_name}`, note: `their LPO ${r.client_lpo_no}` })));
      if (!picked) return;
      order = await API.get(`/api/sales/orders/${picked}`);
    }
    const o = order ? order.order : null;
    const deliveries = order ? order.deliveries.filter((x) => x.status !== 'cancelled') : [];

    UI.modal({
      title: 'Raise a tax invoice',
      size: 'wide',
      body: `<form id="i-form">
        <div class="alert info">A tax invoice cannot be edited once it is issued — under the VAT rules a
          wrong one is corrected with a credit note and a fresh invoice, not a quiet edit. Check the
          lines before you save.</div>
        <div class="grid g3">
          ${UI.field({ name: 'invoice_date', label: 'Invoice date', type: 'date', value: UI.today(), required: true })}
          ${UI.field({ name: 'payment_terms_id', label: 'Payment terms',
            blank: o ? "As on the client's order" : "The client's own terms",
            value: o ? o.payment_terms_id : '', options: APP.termsOptions('client') })}
          ${UI.field({ name: 'dn_id', label: 'Against delivery note',
            blank: deliveries.length ? 'Invoice the whole order' : 'None',
            value: delivery ? delivery.id : '',
            options: deliveries.map((x) => ({ value: x.id, label: `${x.dn_no} — ${UI.date(x.delivery_date)}` })),
            hint: 'Choosing one prices exactly what went out on that note.' })}
        </div>
        <div class="grid g2">
          ${UI.field({ name: 'client_lpo_no', label: "Client's LPO number",
            value: o ? o.client_lpo_no : (delivery ? delivery.client_lpo_no || '' : '') })}
          ${UI.field({ name: 'project', label: 'Project', value: o ? o.project || '' : '' })}
        </div>
        <h4 class="mt">Lines</h4>
        <div class="muted small mb">Leave these as they are to invoice exactly what the delivery note says.</div>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes on the invoice', rows: 2 })}
      </form>`,
      onMount(modal) {
        const lines = order
          ? order.items.filter((i) => i.qty - i.invoiced_qty > 0).map((i) => ({
            ...i, qty: i.qty - i.invoiced_qty }))
          : [];
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), { side: 'sell', lines });
      },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn green" data-act="save">Issue the invoice</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#i-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        const items = modal._lines.value();
        const payload = {
          ...values,
          partner_id: o ? o.partner_id : delivery.partner_id,
          so_id: o ? o.id : (delivery ? delivery.so_id : null),
          items: items.length ? items : undefined,
        };
        const saved = await API.post('/api/sales/invoices', payload);
        UI.ok(`${saved.invoice_no} issued.`);
        const w = PRINT.openWindow();
        const full = await API.get(`/api/sales/invoices/${saved.id}`);
        PRINT.DOCS.taxInvoice(full, w);
        APP.reload();
      },
    });
  }

  /** A one-off "which one?" list, for the times a screen is opened cold. */
  function pickOne(title, options) {
    return new Promise((resolve) => {
      UI.modal({
        title,
        size: 'narrow',
        body: options.length
          ? `<div class="alert-list">${options.map((o) => `
              <button type="button" class="alert-row" data-pick="${o.id}">
                <span class="alert-text"><b>${esc(o.label)}</b>
                <span class="muted small">${esc(o.note || '')}</span></span></button>`).join('')}</div>`
          : UI.empty('There is nothing to choose from.'),
        footer: '<button class="btn ghost" data-act="__close">Cancel</button>',
        onMount(modal) {
          modal.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
            resolve(Number(b.dataset.pick));
            UI.closeModal();
          }));
        },
        onClose: () => resolve(null),
      });
    });
  }

  window.SELL = { openQuotation, showQuotation, openOrder, showOrder, openDelivery, openInvoice, pickOne, listPage };
})();
