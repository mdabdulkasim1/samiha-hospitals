/* =============================================================================
   The buying side: ask the manufacturer for a price → confirm it → send the
   LPO (the material is then on order in the stock register) → take it in →
   book their invoice on their terms → pay them.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const listPage = (host, opts) => SELL.listPage(host, opts);

  // ====================================================== supplier quotations
  APP.register('supplier-quotations', {
    title: 'Supplier Quotations',
    subtitle: 'What we have asked the makers for, and what they came back with',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Status</span><select id="f-status">
            <option value="">All</option>
            ${['requested', 'received', 'approved', 'rejected', 'expired', 'ordered']
              .map((s) => `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
          </select></label>`,
        actions: APP.can(['kam'])
          ? [{ id: 'new', label: '+ Enter a price we asked for', kind: 'gold',
            onClick: async () => {
              // Their price answers an enquiry we raised; ask which one.
              const enquiry = await ENQUIRIES.pickOpen('supplier');
              if (enquiry) openSupplierQuotation(null, { enquiry });
            } }] : [],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/purchase/quotations' + API.qs({ q: v.q, status: v.status, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'Our ref', render: (r) => `<span class="mono">${esc(r.quote_no)}</span>` },
            { label: 'Manufacturer', render: (r) => `<b>${esc(r.supplier_name)}</b>
                <div class="muted small">${esc(r.supplier_ref ? 'their ref ' + r.supplier_ref : '')}</div>` },
            { label: 'Subject', render: (r) => `${esc(r.subject || '—')}
                <div class="muted small">${esc(r.project || '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Date', render: (r) => UI.date(r.quote_date) },
            { label: 'Valid until', render: (r) => UI.date(r.valid_until) },
            { label: 'Total', num: true, render: (r) => (r.total ? UI.money(r.total, { symbol: false }) : '—') },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No supplier quotations yet.' });
          UI.bindRows(box, res.rows, (row) => showSupplierQuotation(row.id));
        },
      });
    },
  });

  async function showSupplierQuotation(id) {
    const d = await API.get(`/api/purchase/quotations/${id}`);
    const q = d.quotation;
    UI.modal({
      title: `${q.quote_no} — ${q.supplier_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(q.status)}
            ${q.application_name ? UI.badge(q.application_name, 'navy') : ''}</div>
          <div class="muted small">Raised by ${esc(q.created_by_name || '')}</div>
        </div>
        ${q.status === 'received' ? '<div class="alert warn"><b>Price not confirmed yet.</b> '
          + 'No LPO can be raised from this quotation until somebody approves the price.</div>' : ''}
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Against our enquiry', q.enquiry_no
              ? `<span class="mono">${esc(q.enquiry_no)}</span>` : '—'],
            ['Their reference', esc(q.supplier_ref || '—')],
            ['Subject', esc(q.subject || '—')],
            ['Project', esc(q.project || '—')],
            ['Quoted on', UI.date(q.quote_date)],
            ['Valid until', UI.date(q.valid_until)],
            ['Lead time', q.delivery_days ? `${q.delivery_days} days` : '—'],
          ])}</div>
          <div>${UI.facts([
            ['Payment terms', esc(d.termsText)],
            ['Taxable', UI.money(q.subtotal - q.discount)],
            ['VAT', UI.money(q.vat_amount)],
            ['Total', `<b>${UI.money(q.total)}</b>`],
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Rate', num: true, render: (r) => (r.unit_price ? UI.money(r.unit_price, { symbol: false }) : '—') },
          { label: 'Lead', num: true, render: (r) => (r.lead_days ? `${r.lead_days} d` : '—') },
          { label: 'Amount', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
        ], d.items)}
        ${d.orders.length ? `<div class="alert ok mt">Ordered on
          ${d.orders.map((o) => `<b>${esc(o.lpo_no)}</b>`).join(', ')}</div>` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${APP.can(['kam']) && q.status !== 'ordered' ? '<button class="btn ghost" data-act="edit">Enter / edit prices</button>' : ''}
        ${APP.can(['kam']) && q.status === 'received' ? '<button class="btn green" data-act="approve">Confirm this price</button>' : ''}
        ${APP.can(['kam']) && q.status === 'approved' ? '<button class="btn gold" data-act="lpo">Raise the LPO</button>' : ''}`,
      async onAction(act) {
        if (act === 'edit') { UI.closeAllModals(); openSupplierQuotation(d); return; }
        if (act === 'approve') {
          const res = await API.post(`/api/purchase/quotations/${q.id}/approve`);
          UI.ok(res.message);
          APP.reload();
          return;
        }
        if (act === 'lpo') { UI.closeAllModals(); openPurchaseOrder(null, { fromSupplierQuote: d }); }
      },
    });
  }

  async function openSupplierQuotation(existing, { fromQuotation, enquiry } = {}) {
    const suppliers = (await API.get('/api/partners?type=supplier&limit=500')).rows;
    const q = existing ? existing.quotation : null;
    const sq = fromQuotation ? fromQuotation.quotation : null;
    // A new quotation always answers an enquiry: if the caller did not bring
    // one, ask which, rather than letting a price appear out of nowhere.
    if (!q && !enquiry) {
      enquiry = await ENQUIRIES.pickOpen('supplier');
      if (!enquiry) return;
    }

    UI.modal({
      title: q ? `${q.quote_no} — enter their prices`
        : `Their price against ${enquiry.enquiry_no}`,
      size: 'wide',
      body: `<form id="sq-form">
        <div class="grid g3">
          ${UI.field({ name: 'partner_id', label: 'Manufacturer / supplier', required: true,
            value: q ? q.partner_id : (enquiry ? enquiry.partner_id : ''), blank: 'Choose…',
            options: suppliers.map((s) => ({ value: s.id, label: s.name })),
            disabled: Boolean(q || (enquiry && enquiry.partner_id)) })}
          ${UI.field({ name: 'application_id', label: 'Application', blank: 'Take it from the lines',
            value: q ? q.application_id : (enquiry && enquiry.application_id)
              || (sq ? sq.application_id : ''), options: APP.applicationOptions() })}
          ${UI.field({ name: 'payment_terms_id', label: 'Their payment terms',
            blank: 'The terms on their account', value: q ? q.payment_terms_id : '',
            options: APP.termsOptions('supplier') })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'supplier_ref', label: 'Their quotation number',
            value: q ? q.supplier_ref || '' : '' })}
          ${UI.field({ name: 'quote_date', label: 'Date', type: 'date',
            value: q ? q.quote_date : UI.today() })}
          ${UI.field({ name: 'valid_until', label: 'Valid until', type: 'date',
            value: q ? q.valid_until : UI.addDays(UI.today(), 30) })}
        </div>
        <div class="grid g2">
          ${UI.field({ name: 'subject', label: 'Subject',
            value: q ? q.subject || '' : (enquiry && enquiry.subject) || (sq ? sq.subject || '' : '') })}
          ${UI.field({ name: 'project', label: 'Project',
            value: q ? q.project || '' : (enquiry && enquiry.project) || (sq ? sq.project || '' : '') })}
        </div>
        ${enquiry ? `<div class="alert info">Against our enquiry
          <b class="mono">${esc(enquiry.enquiry_no)}</b>${enquiry.requirement
            ? ` — ${esc(enquiry.requirement)}` : ''}</div>` : ''}
        <h4 class="mt">${q ? 'What we asked them to price' : 'What they have priced'}</h4>
        <div class="muted small mb">Enter the rate against each line as their quotation shows it. A
          line they have not priced yet can stay at zero and be filled in later — their price is also
          remembered against the item.</div>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2, value: q ? q.notes || '' : '' })}
        ${q ? UI.field({ name: 'status', label: 'Status', value: q.status,
          options: ['requested', 'received', 'approved', 'rejected', 'expired']
            .map((s) => ({ value: s, label: UI.titleise(s) })) }) : ''}
        ${sq ? `<input type="hidden" name="linked_sales_quotation_id" value="${sq.id}">` : ''}
        ${enquiry ? `<input type="hidden" name="enquiry_id" value="${enquiry.id}">` : ''}
      </form>`,
      onMount(modal) {
        const lines = existing ? existing.items
          : (fromQuotation ? fromQuotation.items.map((i) => ({
            item_id: i.item_id, item_code: i.item_code, description: i.description,
            application_id: i.application_id, qty: i.qty, uom: i.uom,
            unit_price: i.cost_price || 0 })) : []);
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), { side: 'buy', lines });
      },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${q ? 'Save' : 'Log their price'}</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#sq-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        // A disabled select is not submitted, and the supplier must not change.
        if (q) values.partner_id = q.partner_id;
        else if (enquiry && enquiry.partner_id) values.partner_id = enquiry.partner_id;
        const items = modal._lines.value();
        if (!items.length) { UI.err('List at least one item to be priced.'); return 'keep'; }
        const saved = q
          ? await API.patch(`/api/purchase/quotations/${q.id}`, { ...values, items })
          : await API.post('/api/purchase/quotations', { ...values, items });
        UI.ok(q ? 'Saved.' : `Logged as ${saved.quote_no}.`);
        APP.reload();
      },
    });
  }

  // ================================================================ our LPOs
  APP.register('purchase-orders', {
    title: 'Our LPOs',
    subtitle: 'Orders placed with the manufacturers — and the material they put on order in stock',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Status</span><select id="f-status">
            <option value="">All</option>
            ${['draft', 'sent', 'acknowledged', 'partial', 'received', 'closed', 'cancelled']
              .map((s) => `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
          </select></label>`,
        actions: APP.can(['kam'])
          ? [{ id: 'new', label: '+ New LPO', kind: 'gold', onClick: () => openPurchaseOrder() }] : [],
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/purchase/orders' + API.qs({ q: v.q, status: v.status, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'LPO', render: (r) => `<span class="mono">${esc(r.lpo_no)}</span>
                ${r.enquiry_no ? `<div class="muted small">${esc(r.enquiry_no)}</div>` : ''}` },
            { label: 'Manufacturer', render: (r) => `<b>${esc(r.supplier_name)}</b>
                <div class="muted small">${esc(r.project || '')}</div>` },
            { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
            { label: 'Date', render: (r) => UI.date(r.lpo_date) },
            { label: 'Wanted by', render: (r) => (r.delivery_date
              ? `${UI.date(r.delivery_date)}<div class="muted small">${esc(UI.dueIn(r.delivery_date))}</div>` : '—') },
            { label: 'Against', render: (r) => (r.against_sales_order
              ? `<span class="small">${esc(r.against_sales_order)}</span>` : '<span class="muted small">stock</span>') },
            { label: 'Terms', key: 'terms_name' },
            { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No LPOs raised yet.' });
          UI.bindRows(box, res.rows, (row) => showPurchaseOrder(row.id));
        },
      });
    },
  });

  async function showPurchaseOrder(id) {
    const d = await API.get(`/api/purchase/orders/${id}`);
    const o = d.order;
    UI.modal({
      title: `${o.lpo_no} — ${o.supplier_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(o.status)}
            ${o.application_name ? UI.badge(o.application_name, 'navy') : ''}</div>
          <div class="muted small">Raised by ${esc(o.created_by_name || '')}</div>
        </div>
        ${o.status === 'draft' ? '<div class="alert warn"><b>Not sent yet.</b> Sending it is what puts '
          + 'this material on order in the stock register.</div>' : ''}
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Our enquiry', o.enquiry_no
              ? `<span class="mono">${esc(o.enquiry_no)}</span>` : '—'],
            ['Their quotation', esc(o.supplier_quote_no || '—')
              + (o.supplier_quote_ref ? ` <span class="muted small">(their ${esc(o.supplier_quote_ref)})</span>` : '')],
            ['Project', esc(o.project || '—')],
            ['Against client order', esc(o.against_sales_order
              ? `${o.against_sales_order} (their LPO ${o.against_client_lpo || ''})` : 'bought for stock')],
            ['Date', UI.date(o.lpo_date)],
            ['For the attention of', esc(o.attention || '—')],
            ['Incoterms', esc(o.incoterms || '—')],
            ['Approving authority', esc(o.authority || '—')],
            ['Delivery wanted', o.delivery_date ? UI.date(o.delivery_date) : '—'],
            ['Deliver to', esc(o.delivery_location || o.delivery_address || '—')],
          ])}</div>
          <div>${UI.facts([
            ['Payment terms', esc(d.termsText)],
            ['Taxable', UI.money(o.subtotal - o.discount)],
            ['VAT', UI.money(o.vat_amount)],
            ['Total', `<b>${UI.money(o.total)}</b>`],
            d.schedule.advance ? ['Advance to pay', UI.money(d.schedule.advance)] : null,
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Ordered', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Received', num: true, render: (r) => UI.qty(r.received_qty) },
          { label: 'Outstanding', num: true, render: (r) => (r.pending_qty ? `<b>${UI.qty(r.pending_qty)}</b>` : '—') },
          { label: 'Rate', num: true, render: (r) => UI.money(r.unit_price, { symbol: false }) },
          { label: 'Amount', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
        ], d.items)}
        ${d.receipts.length ? `<h4 class="mt">Goods received</h4>${UI.table([
          { label: 'GRN', key: 'grn_no' }, { label: 'Date', render: (r) => UI.date(r.received_date) },
          { label: 'Their DN', key: 'supplier_dn_ref' }], d.receipts)}` : ''}
        ${d.invoices.length ? `<h4 class="mt">Their invoices</h4>${UI.table([
          { label: 'Our ref', key: 'bill_no' }, { label: 'Their no.', key: 'supplier_inv_no' },
          { label: 'Due', render: (r) => UI.date(r.due_date) },
          { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.invoices)}` : ''}
        <h4 class="mt">Conditions of this order</h4>
        <div class="muted small mb">${d.conditions.length} point${d.conditions.length === 1 ? '' : 's'},
          as this supplier received them.</div>
        <ol class="conditions">${d.conditions.map((c) => `<li>${esc(c)}</li>`).join('')
          || '<div class="muted">No conditions were printed on this order.</div>'}</ol>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print the LPO</button>
        ${APP.can(['kam']) && !['received', 'closed', 'cancelled'].includes(o.status)
          ? '<button class="btn ghost" data-act="terms">Edit the conditions</button>' : ''}
        ${APP.can(['kam']) && o.status === 'draft' ? '<button class="btn gold" data-act="send">Send it to the maker</button>' : ''}
        ${APP.can(['logistics', 'kam']) && ['sent', 'acknowledged', 'partial'].includes(o.status)
          ? '<button class="btn green" data-act="receive">Receive goods</button>' : ''}
        ${APP.can(['accounts']) && o.status !== 'draft' ? '<button class="btn ghost" data-act="bill">Book their invoice</button>' : ''}
        ${APP.can(['kam']) && !['received', 'closed', 'cancelled'].includes(o.status)
          ? '<button class="btn danger" data-act="cancel">Cancel</button>' : ''}`,
      async onAction(act) {
        if (act === 'print') { const w = PRINT.openWindow(); PRINT.DOCS.purchaseOrder(d, w); return 'keep'; }
        if (act === 'send') {
          const res = await API.post(`/api/purchase/orders/${o.id}/send`);
          UI.ok(res.message);
          APP.reload();
          return;
        }
        if (act === 'terms') { UI.closeAllModals(); editOrderTerms(d); return; }
        if (act === 'receive') { UI.closeAllModals(); openGrn(d); return; }
        if (act === 'bill') { UI.closeAllModals(); openSupplierBill(d); return; }
        if (act === 'cancel') {
          const sure = await UI.confirm(
            `Cancel ${o.lpo_no}? The material will come off the "on order" figure in the stock register.`,
            { danger: true, yes: 'Yes, cancel it' });
          if (!sure) return 'keep';
          const reason = window.prompt('Why is it being cancelled?') || '';
          const res = await API.post(`/api/purchase/orders/${o.id}/cancel`, { reason });
          UI.ok(res.message);
          APP.reload();
        }
      },
    });
  }

  async function openPurchaseOrder(existing, opts = {}) {
    const suppliers = (await API.get('/api/partners?type=supplier&limit=500')).rows;
    const m = await APP.loadMasters();
    const sq = opts.fromSupplierQuote ? opts.fromSupplierQuote.quotation : null;
    // The enquiry travels from the quotation onto the order; a direct LPO can
    // be given one so its reference is on the paper too.
    const enquiry = opts.enquiry || null;
    const enquiryNo = (sq && sq.enquiry_no) || (enquiry && enquiry.enquiry_no) || '';

    UI.modal({
      title: 'New LPO to a manufacturer',
      size: 'wide',
      body: `<form id="po-form">
        <div class="grid g3">
          ${UI.field({ name: 'partner_id', label: 'Manufacturer / supplier', required: true,
            value: sq ? sq.partner_id : (opts.partner_id || ''), blank: 'Choose…',
            options: suppliers.map((s) => ({ value: s.id, label: s.name })) })}
          ${UI.field({ name: 'application_id', label: 'Application', blank: 'Take it from the lines',
            value: sq ? sq.application_id : (opts.application_id || ''), options: APP.applicationOptions() })}
          ${UI.field({ name: 'payment_terms_id', label: 'Payment terms',
            blank: 'The terms on their account', value: sq ? sq.payment_terms_id : '',
            options: APP.termsOptions('supplier') })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'lpo_date', label: 'LPO date', type: 'date', value: UI.today(), required: true })}
          ${UI.field({ name: 'delivery_date', label: 'Delivery wanted by', type: 'date' })}
          ${UI.field({ name: 'delivery_location_id', label: 'Deliver to', blank: 'Main yard',
            options: m.locations.map((l) => ({ value: l.id, label: l.name })) })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'attention', label: 'For the attention of',
            placeholder: 'Mr. Sankar', hint: "Defaults to the supplier's contact." })}
          ${UI.field({ name: 'incoterms', label: 'Incoterms / delivery basis',
            placeholder: 'Delivery to site in DXB' })}
          ${UI.field({ name: 'authority', label: 'Approving authority',
            placeholder: 'DEWA', hint: 'Named in the inspection conditions below.' })}
        </div>
        <div class="grid g2">
          ${UI.field({ name: 'project', label: 'Project', value: sq ? sq.project || '' : (opts.project || '') })}
          ${UI.field({ name: 'delivery_address', label: 'Delivery address', rows: 2 })}
        </div>
        ${enquiryNo ? `<div class="alert info">This order carries our enquiry
          <b class="mono">${esc(enquiryNo)}</b> — it prints on the LPO, so the maker can see what
          they priced.</div>` : ''}
        <h4 class="mt">Lines</h4>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes to the maker', rows: 2 })}
        <h4 class="mt">Conditions of this order</h4>
        <div class="muted small mb">These come from the standard list under Masters → Terms &amp;
          conditions, with this supplier's name already filled in. Untick what does not apply, edit
          any point, or add one — what you leave here is what this supplier receives, and changing
          the standard list later will not alter it.</div>
        <div id="clauses">${UI.loading()}</div>
        ${sq ? `<input type="hidden" name="quotation_id" value="${sq.id}">` : ''}
        ${!sq && enquiry ? `<input type="hidden" name="enquiry_id" value="${enquiry.id}">` : ''}
        ${opts.salesOrderId ? `<input type="hidden" name="sales_order_id" value="${opts.salesOrderId}">` : ''}
      </form>`,
      onMount(modal) {
        const lines = opts.fromSupplierQuote ? opts.fromSupplierQuote.items : (opts.lines || []);
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), { side: 'buy', lines });

        /*
         * The conditions name the supplier and the authority, so they are
         * rebuilt whenever either changes — otherwise an order ends up telling
         * one manufacturer that another one is responsible for the repairs,
         * which is exactly what a copied block of terms does.
         */
        const host = modal.querySelector('#clauses');
        const partnerEl = modal.querySelector('[name=partner_id]');
        const authorityEl = modal.querySelector('[name=authority]');
        const termsEl = modal.querySelector('[name=payment_terms_id]');
        let touched = false;

        const load = async () => {
          const res = await API.get('/api/purchase/terms/default' + API.qs({
            partner_id: partnerEl.value,
            authority: authorityEl.value,
            payment_terms_id: termsEl.value,
            project: modal.querySelector('[name=project]').value,
          }));
          if (modal._clauses) modal._clauses.set(res.clauses);
          else {
            modal._clauses = CLAUSES.Editor(host, {
              clauses: res.clauses, onChange: () => { touched = true; },
            });
            touched = false;
          }
        };
        const reload = async () => {
          if (touched) {
            const keep = await UI.confirm(
              'The conditions have been edited by hand. Rebuild them for the supplier and authority '
              + 'now chosen? Your edits will be lost.',
              { title: 'Rebuild the conditions?', yes: 'Rebuild them' });
            if (!keep) return;
          }
          await load();
          touched = false;
        };
        partnerEl.addEventListener('change', reload);
        authorityEl.addEventListener('change', reload);
        termsEl.addEventListener('change', reload);
        load();
      },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ghost" data-act="draft">Save as a draft</button>
               <button class="btn gold" data-act="send">Save &amp; send</button>`,
      async onAction(act, modal) {
        if (act !== 'draft' && act !== 'send') return;
        const form = modal.querySelector('#po-form');
        if (!form.reportValidity()) return 'keep';
        const items = modal._lines.value();
        if (!items.length) { UI.err('An LPO needs at least one line.'); return 'keep'; }
        const conditions = modal._clauses ? modal._clauses.value() : [];
        const saved = await API.post('/api/purchase/orders', {
          ...UI.formValues(form), items, terms_text: conditions.join('\n'),
        });
        if (act === 'send') {
          const res = await API.post(`/api/purchase/orders/${saved.id}/send`);
          UI.ok(res.message);
          const w = PRINT.openWindow();
          PRINT.DOCS.purchaseOrder(await API.get(`/api/purchase/orders/${saved.id}`), w);
        } else {
          UI.ok(`${saved.lpo_no} saved as a draft — nothing is on order until it is sent.`);
        }
        APP.reload();
      },
    });
  }

  /**
   * Change the conditions on an order that already exists.
   *
   * Allowed until the goods are in, because a condition is often agreed after
   * the order goes out — but never silently: what it said before is kept in
   * the audit trail, and a sent order is marked as needing to be reissued.
   */
  function editOrderTerms(data) {
    const o = data.order;
    UI.modal({
      title: `Conditions of ${o.lpo_no}`,
      size: 'wide',
      body: `
        ${o.status !== 'draft' ? `<div class="alert warn"><b>This LPO has already gone to
          ${esc(o.supplier_name)}.</b> Changing the conditions here changes our record of the order —
          send them the amended copy as well, or they are working to the old one. The change is
          recorded in the audit trail either way.</div>` : ''}
        <form id="t-form">
          <div class="grid g3">
            ${UI.field({ name: 'attention', label: 'For the attention of', value: o.attention || '' })}
            ${UI.field({ name: 'incoterms', label: 'Incoterms / delivery basis', value: o.incoterms || '' })}
            ${UI.field({ name: 'authority', label: 'Approving authority', value: o.authority || '' })}
          </div>
        </form>
        <div id="clauses"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ghost" data-act="reset">Start again from the standard list</button>
               <button class="btn" data-act="save">Save the conditions</button>`,
      onMount(modal) {
        modal._clauses = CLAUSES.Editor(modal.querySelector('#clauses'), { clauses: data.conditions });
      },
      async onAction(act, modal) {
        if (act === 'reset') {
          const form = modal.querySelector('#t-form');
          const res = await API.get('/api/purchase/terms/default' + API.qs({
            partner_id: o.partner_id,
            authority: form.querySelector('[name=authority]').value,
            payment_terms_id: o.payment_terms_id,
            project: o.project,
          }));
          modal._clauses.set(res.clauses);
          UI.ok('Rebuilt from the standard list. Nothing is saved until you press save.');
          return 'keep';
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#t-form');
        await API.patch(`/api/purchase/orders/${o.id}`, {
          ...UI.formValues(form), terms: modal._clauses.value(),
        });
        UI.ok('Conditions saved.');
        APP.reload();
      },
    });
  }

  // ========================================================== goods receipts
  APP.register('goods-receipts', {
    title: 'Goods Receipts',
    subtitle: 'What has come into the yard, and against which LPO',

    render(host) {
      return listPage(host, {
        actions: APP.can(['logistics', 'kam'])
          ? [{ id: 'new', label: '+ Receive goods', kind: 'gold', onClick: () => openGrn(null) }] : [],
        async onLoad(box) {
          box.innerHTML = UI.loading();
          const res = await API.get('/api/purchase/grns?limit=200');
          box.innerHTML = UI.table([
            { label: 'GRN', render: (r) => `<span class="mono">${esc(r.grn_no)}</span>` },
            { label: 'From', render: (r) => `<b>${esc(r.supplier_name)}</b>` },
            { label: 'Against LPO', key: 'lpo_no' },
            { label: 'Their DN', key: 'supplier_dn_ref' },
            { label: 'Received', render: (r) => UI.date(r.received_date) },
            { label: 'Into', key: 'location_name' },
            { label: 'Qty', num: true, render: (r) => UI.qty(r.total_qty) },
            { label: 'By', key: 'received_by_name' },
          ], res.rows, { onRow: true, emptyText: 'Nothing has been received yet.' });
          UI.bindRows(box, res.rows, (row) => showGrn(row.id));
        },
      });
    },
  });

  async function showGrn(id) {
    const d = await API.get(`/api/purchase/grns/${id}`);
    const g = d.grn;
    UI.modal({
      title: `${g.grn_no} — ${g.supplier_name}`,
      size: 'wide',
      body: `<div class="grid g2 mb">
          <div>${UI.facts([
            ['Against LPO', esc(g.lpo_no || 'received without an LPO')],
            ['Their delivery note', esc(g.supplier_dn_ref || '—')],
            ['Received on', UI.date(g.received_date)],
            ['Into', esc(g.location_name || '—')],
          ])}</div>
          <div>${UI.facts([
            ['Vehicle', esc(g.vehicle_no || '—')],
            ['Inspected by', esc(g.inspected_by || '—')],
            ['Booked by', esc(g.received_by_name || '—')],
            ['Notes', esc(g.notes || '—')],
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Accepted', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Rejected', num: true, render: (r) => (r.rejected_qty ? UI.qty(r.rejected_qty) : '—') },
          { label: 'Remarks', key: 'remarks' },
        ], d.items)}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn ghost" data-act="print">Print</button>`,
      onAction(act) {
        if (act === 'print') { const w = PRINT.openWindow(); PRINT.DOCS.grn(d, w); return 'keep'; }
      },
    });
  }

  async function openGrn(orderData) {
    let order = orderData;
    if (!order) {
      const open = await API.get('/api/purchase/orders?open=1&limit=200');
      if (!open.rows.length) { UI.warn('There are no open LPOs to receive against.'); return; }
      const picked = await SELL.pickOne('Receiving against which LPO?', open.rows.map((r) => ({
        id: r.id, label: `${r.lpo_no} — ${r.supplier_name}`,
        note: r.delivery_date ? `wanted by ${UI.date(r.delivery_date)}` : '' })));
      if (!picked) return;
      order = await API.get(`/api/purchase/orders/${picked}`);
    }
    const o = order.order;
    const pending = order.items.filter((i) => i.pending_qty > 0);
    if (!pending.length) { UI.warn('Everything on this LPO has already been received.'); return; }
    const m = await APP.loadMasters();

    UI.modal({
      title: `Receive against ${o.lpo_no}`,
      size: 'wide',
      body: `<form id="g-form">
        <div class="grid g3">
          ${UI.field({ name: 'received_date', label: 'Received on', type: 'date', value: UI.today(), required: true })}
          ${UI.field({ name: 'supplier_dn_ref', label: "Their delivery note number" })}
          ${UI.field({ name: 'vehicle_no', label: 'Vehicle' })}
        </div>
        <div class="grid g2">
          ${UI.field({ name: 'location_id', label: 'Into', blank: 'Main yard',
            value: o.delivery_location_id || '',
            options: m.locations.map((l) => ({ value: l.id, label: l.name })) })}
          ${UI.field({ name: 'inspected_by', label: 'Inspected by', value: APP.user.name })}
        </div>
        <h4 class="mt">What arrived</h4>
        <div class="muted small mb">A short delivery is normal — enter what actually came, and the LPO
          stays open for the rest.</div>
        <div class="table-wrap"><table><thead><tr>
          <th>Item</th><th class="num">On the LPO</th><th class="num">Already in</th>
          <th class="num">Accepted now</th><th class="num">Rejected</th><th>Remarks</th></tr></thead><tbody>
          ${pending.map((i) => `<tr>
            <td><b>${esc(i.description)}</b><div class="muted small mono">${esc(i.item_code || '')}</div></td>
            <td class="num">${UI.qty(i.qty)} ${esc(i.uom)}</td>
            <td class="num">${UI.qty(i.received_qty)}</td>
            <td><input type="number" step="0.001" min="0" max="${i.pending_qty}"
                  data-po-item="${i.id}" data-rate="${i.unit_price}" value="${i.pending_qty}" style="width:104px"></td>
            <td><input type="number" step="0.001" min="0" data-reject="${i.id}" value="0" style="width:88px"></td>
            <td><input data-remark="${i.id}" placeholder="—"></td>
          </tr>`).join('')}
        </tbody></table></div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn green" data-act="save">Take it into stock</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#g-form');
        if (!form.reportValidity()) return 'keep';
        const items = [...form.querySelectorAll('[data-po-item]')].map((el) => {
          const id = Number(el.dataset.poItem);
          return {
            po_item_id: id,
            qty: Number(el.value) || 0,
            rate: Number(el.dataset.rate) || 0,
            rejected_qty: Number(form.querySelector(`[data-reject="${id}"]`).value) || 0,
            remarks: form.querySelector(`[data-remark="${id}"]`).value || null,
          };
        }).filter((l) => l.qty > 0 || l.rejected_qty > 0);
        if (!items.length) { UI.err('Nothing has been entered as received.'); return 'keep'; }
        const saved = await API.post('/api/purchase/grns', {
          ...UI.formValues(form), partner_id: o.partner_id, po_id: o.id, items });
        UI.ok(`${saved.grn_no} recorded — the material is in the yard.`);
        APP.reload();
      },
    });
  }

  // ========================================================= supplier bills
  APP.register('supplier-bills', {
    title: 'Supplier Bills',
    subtitle: 'What the manufacturers have invoiced us, and when it falls due on their terms',

    render(host) {
      return listPage(host, {
        filters: `<label class="field"><span>Show</span><select id="f-status">
            <option value="">All</option><option value="unpaid">Unpaid</option>
            <option value="partial">Part paid</option><option value="paid">Paid</option>
            <option value="disputed">Disputed</option></select></label>`,
        actions: [
          APP.can(['accounts'])
            ? { id: 'new', label: '+ Book an invoice', kind: 'gold', onClick: () => openSupplierBill(null) }
            : null,
          { id: 'due', label: 'What is due', onClick: showDue },
        ].filter(Boolean),
        async onLoad(box, values) {
          const v = values();
          box.innerHTML = UI.loading();
          const res = await API.get('/api/purchase/invoices' + API.qs({ q: v.q, status: v.status, limit: 200 }));
          box.innerHTML = UI.table([
            { label: 'Our ref', render: (r) => `<span class="mono">${esc(r.bill_no)}</span>` },
            { label: 'Their invoice', render: (r) => `<b>${esc(r.supplier_inv_no)}</b>
                <div class="muted small">${esc(r.supplier_name)}</div>` },
            { label: 'Against', key: 'lpo_no' },
            { label: 'Date', render: (r) => UI.date(r.invoice_date) },
            { label: 'Due', render: (r) => `${UI.date(r.due_date)}
                <div class="muted small">${esc(UI.dueIn(r.due_date))}</div>` },
            { label: 'Terms', key: 'terms_name' },
            { label: 'Total', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
            { label: 'Outstanding', num: true, render: (r) => (r.outstanding
              ? `<b>${UI.money(r.outstanding, { symbol: false })}</b>` : '—') },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
          ], res.rows, { onRow: true, emptyText: 'No supplier invoices booked yet.' });
          UI.bindRows(box, res.rows, (row) => showSupplierBill(row.id));
        },
      });
    },
  });

  async function showDue() {
    const d = await API.get('/api/purchase/payables/due');
    UI.modal({
      title: 'What is due to the manufacturers',
      size: 'wide',
      body: UI.table([
        { label: 'Our ref', key: 'bill_no' },
        { label: 'Their invoice', key: 'supplier_inv_no' },
        { label: 'Supplier', key: 'supplier_name' },
        { label: 'Due', render: (r) => `${UI.date(r.due_date)} <span class="muted small">${esc(UI.dueIn(r.due_date))}</span>` },
        { label: 'Terms', key: 'terms_name' },
        { label: 'Outstanding', num: true, render: (r) => `<b>${UI.money(r.outstanding, { symbol: false })}</b>` },
      ], d.rows, { emptyText: 'Nothing is outstanding.' })
        + `<div class="doc-footer"><table><tr class="grand"><td>Total due</td>
           <td class="num">${UI.money(d.total)}</td></tr></table></div>`,
      footer: '<button class="btn ghost" data-act="__close">Close</button>',
    });
  }

  async function showSupplierBill(id) {
    const d = await API.get(`/api/purchase/invoices/${id}`);
    const i = d.invoice;
    UI.modal({
      title: `${i.supplier_inv_no} — ${i.supplier_name}`,
      size: 'wide',
      body: `<div class="row-between mb"><div>${UI.statusBadge(i.status)}</div>
          <div class="muted small">Our reference ${esc(i.bill_no)}</div></div>
        <div class="grid g2 mb">
          <div>${UI.facts([
            ['Against LPO', esc(i.lpo_no || '—')],
            ['Goods receipt', esc(i.grn_no || '—')],
            ['Invoice date', UI.date(i.invoice_date)],
            ['Due date', `${UI.date(i.due_date)} <span class="muted small">(${esc(UI.dueIn(i.due_date))})</span>`],
            ['Payment terms', esc(d.termsText)],
          ])}</div>
          <div>${UI.facts([
            ['Taxable', UI.money(i.subtotal - i.discount)],
            ['VAT (input tax)', UI.money(i.vat_amount)],
            ['Total', `<b>${UI.money(i.total)}</b>`],
            ['Paid', UI.money(i.paid_amount)],
            ['Outstanding', `<b>${UI.money(i.total - i.paid_amount)}</b>`],
          ])}</div>
        </div>
        ${UI.table([
          { label: 'Code', render: (r) => `<span class="mono small">${esc(r.item_code || '')}</span>` },
          { label: 'Description', render: (r) => esc(r.description) },
          { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
          { label: 'Rate', num: true, render: (r) => UI.money(r.unit_price, { symbol: false }) },
          { label: 'VAT', num: true, render: (r) => UI.money(r.vat_amount, { symbol: false }) },
          { label: 'Amount', num: true, render: (r) => UI.money(r.total, { symbol: false }) },
        ], d.items)}
        ${d.payments.length ? `<h4 class="mt">Paid against it</h4>${UI.table([
          { label: 'Voucher', key: 'payment_no' }, { label: 'Date', render: (r) => UI.date(r.payment_date) },
          { label: 'Mode', render: (r) => UI.titleise(r.mode) },
          { label: 'Cheque', render: (r) => (r.cheque_no ? `${esc(r.cheque_no)} · ${UI.date(r.cheque_date)}` : '—') },
          { label: 'Amount', num: true, render: (r) => UI.money(r.amount, { symbol: false }) },
          { label: 'Status', render: (r) => UI.statusBadge(r.status) }], d.payments)}` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${APP.can(['accounts']) && i.status !== 'paid' ? '<button class="btn green" data-act="pay">Pay it</button>' : ''}
        ${APP.can(['accounts']) && i.status !== 'disputed' && i.status !== 'paid'
          ? '<button class="btn ghost" data-act="dispute">Mark disputed</button>' : ''}`,
      async onAction(act) {
        if (act === 'pay') {
          UI.closeAllModals();
          MONEY.openPayment({ direction: 'out', partner_id: i.partner_id,
            amount: Math.round((i.total - i.paid_amount) * 100) / 100,
            allocations: [{ invoice_side: 'purchase', invoice_id: i.id,
              amount: Math.round((i.total - i.paid_amount) * 100) / 100 }] });
          return;
        }
        if (act === 'dispute') {
          await API.patch(`/api/purchase/invoices/${i.id}`, { status: 'disputed' });
          UI.ok('Marked as disputed.');
          APP.reload();
        }
      },
    });
  }

  async function openSupplierBill(orderData) {
    let order = orderData;
    if (!order) {
      const open = await API.get('/api/purchase/orders?limit=200');
      const picked = await SELL.pickOne('Book the invoice against which LPO?', [
        ...open.rows.map((r) => ({ id: r.id, label: `${r.lpo_no} — ${r.supplier_name}`,
          note: UI.money(r.total) })),
      ]);
      if (!picked) return;
      order = await API.get(`/api/purchase/orders/${picked}`);
    }
    const o = order.order;

    UI.modal({
      title: `Book the invoice for ${o.lpo_no}`,
      size: 'wide',
      body: `<form id="b-form">
        <div class="grid g3">
          ${UI.field({ name: 'supplier_inv_no', label: 'Their invoice number', required: true })}
          ${UI.field({ name: 'invoice_date', label: 'Their invoice date', type: 'date',
            value: UI.today(), required: true })}
          ${UI.field({ name: 'payment_terms_id', label: 'Payment terms',
            blank: 'As on the LPO', value: o.payment_terms_id || '',
            options: APP.termsOptions('supplier'),
            hint: 'The due date is worked out from these.' })}
        </div>
        ${UI.field({ name: 'grn_id', label: 'Against goods receipt', blank: 'None',
          options: order.receipts.map((g) => ({ value: g.id, label: `${g.grn_no} — ${UI.date(g.received_date)}` })) })}
        <h4 class="mt">Lines as they invoiced them</h4>
        <div id="lines"></div>
        ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
      </form>`,
      onMount(modal) {
        modal._lines = LINES.LineEditor(modal.querySelector('#lines'), {
          side: 'buy',
          lines: order.items.filter((i) => i.qty - i.invoiced_qty > 0)
            .map((i) => ({ ...i, qty: i.qty - i.invoiced_qty })),
        });
      },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Book it</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#b-form');
        if (!form.reportValidity()) return 'keep';
        const items = modal._lines.value();
        if (!items.length) { UI.err('An invoice needs at least one line.'); return 'keep'; }
        const saved = await API.post('/api/purchase/invoices', {
          ...UI.formValues(form), partner_id: o.partner_id, po_id: o.id, items });
        UI.ok(`Booked as ${saved.bill_no}, due ${UI.date(saved.due_date)}.`);
        APP.reload();
      },
    });
  }

  window.BUY = { openSupplierQuotation, showSupplierQuotation, openPurchaseOrder, showPurchaseOrder,
    openGrn, openSupplierBill, editOrderTerms };
})();
