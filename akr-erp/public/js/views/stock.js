/* The stock register: on order, received, delivered, committed, free. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const state = { q: '', category_id: '', application_id: '', tab: 'register' };

  APP.register('stock', {
    title: 'Stock Register',
    subtitle: 'What is on order with the makers, what is in the yard, and what has been promised out',

    async render(host, params) {
      if (params.item) { await showItem(params.item); }
      const m = await APP.loadMasters();
      APP.actions([
        APP.can(['logistics', 'kam'])
          ? { id: 'adjust', label: 'Adjust stock', onClick: openAdjustment } : null,
        { id: 'low', label: 'Below reorder', onClick: showReorder },
      ].filter(Boolean));

      host.innerHTML = `
        <div class="tabs">
          <button data-tab="register" class="${state.tab === 'register' ? 'active' : ''}">Register</button>
          <button data-tab="receipts" class="${state.tab === 'receipts' ? 'active' : ''}">Receiving</button>
          <button data-tab="deliveries" class="${state.tab === 'deliveries' ? 'active' : ''}">Delivery</button>
        </div>
        <div id="summary"></div>
        <div class="card">
          <div class="filters">
            <label class="field grow"><span>Search</span>
              <input id="f-q" value="${esc(state.q)}" placeholder="Code, name, size…"></label>
            <label class="field"><span>Product line</span>
              <select id="f-cat"><option value="">All lines</option>
                ${m.categories.map((c) => `<option value="${c.id}"${String(c.id) === state.category_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select></label>
            <label class="field"><span>Application</span>
              <select id="f-app"><option value="">All applications</option>
                ${m.applications.map((a) => `<option value="${a.id}"${String(a.id) === state.application_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select></label>
            <label class="field"><span>Show</span>
              <select id="f-moved"><option value="1">Only what has moved</option>
                <option value="">Every item in the master</option></select></label>
          </div>
          <div id="rows">${UI.loading()}</div>
        </div>`;

      const load = async () => {
        const box = document.getElementById('rows');
        box.innerHTML = UI.loading();
        if (state.tab === 'register') {
          const res = await API.get('/api/stock' + API.qs({
            q: state.q, category_id: state.category_id, application_id: state.application_id,
            onlyMoved: document.getElementById('f-moved').value, limit: 500 }));
          const cols = [
            { label: 'Item code', render: (r) => `<span class="mono">${esc(r.item_code)}</span>` },
            { label: 'Item', render: (r) => `<b>${esc(r.name)}</b>
                <div class="muted small">${esc(r.category || '')}${r.application ? ' · ' + esc(r.application) : ''}</div>` },
            { label: 'Unit', key: 'uom' },
            { label: 'On order', num: true, render: (r) => (r.on_order
              ? `<span class="badge info">${UI.qty(r.on_order)}</span>` : '—') },
            { label: 'Received', num: true, render: (r) => UI.qty(r.received_total) },
            { label: 'Delivered', num: true, render: (r) => UI.qty(r.delivered_total) },
            { label: 'In yard', num: true, render: (r) => `<b>${UI.qty(r.on_hand)}</b>` },
            { label: 'Committed', num: true, render: (r) => (r.committed
              ? `<span class="badge gold">${UI.qty(r.committed)}</span>` : '—') },
            { label: 'Free', num: true, render: (r) => (r.free < 0
              ? `<span class="badge danger">${UI.qty(r.free)}</span>` : `<b>${UI.qty(r.free)}</b>`) },
          ];
          if (APP.seesCost()) cols.push({ label: 'Value', num: true, render: (r) => UI.money(r.stock_value, { symbol: false }) });

          document.getElementById('summary').innerHTML = res.summary ? `<div class="grid g4 mb">
            ${UI.stat({ label: 'Items with movement', value: UI.num(res.summary.items) })}
            ${UI.stat({ label: 'Value in the yard', value: UI.money(res.summary.on_hand_value), kind: 'green' })}
            ${UI.stat({ label: 'Value on order', value: UI.money(res.summary.on_order_value), kind: 'info' })}
            ${UI.stat({ label: 'Below reorder', value: UI.num(res.summary.below_reorder),
              kind: res.summary.below_reorder ? 'danger' : '' })}
          </div>` : '';

          box.innerHTML = UI.table(cols, res.rows, { onRow: true,
            emptyText: 'Nothing has moved yet. An LPO you send will show here as material on order.' });
          UI.bindRows(box, res.rows, (row) => showItem(row.id));
        } else {
          const url = state.tab === 'receipts' ? '/api/stock/receipts' : '/api/stock/deliveries';
          const res = await API.get(url + API.qs({ from: UI.addDays(UI.today(), -90), to: UI.today() }));
          document.getElementById('summary').innerHTML = '';
          box.innerHTML = `<div class="muted small mb">${UI.date(res.from)} to ${UI.date(res.to)}</div>`
            + UI.table([
              { label: 'Date', render: (r) => UI.date(r.moved_on) },
              { label: 'Item', render: (r) => `<span class="mono small">${esc(r.item_code)}</span> ${esc(r.item_name)}` },
              { label: 'Qty', num: true, render: (r) => `${UI.qty(r.qty)} ${esc(r.uom)}` },
              { label: state.tab === 'receipts' ? 'From' : 'To', key: 'partner_name' },
              { label: 'Document', key: 'ref_no' },
              { label: 'Location', key: 'location_name' },
              { label: 'Note', key: 'notes' },
            ], res.rows, { emptyText: state.tab === 'receipts'
              ? 'Nothing received in this period.' : 'Nothing delivered in this period.' });
        }
      };

      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        APP.reload();
      }));
      let timer = null;
      document.getElementById('f-q').addEventListener('input', (e) => {
        state.q = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(load, 250);
      });
      document.getElementById('f-cat').addEventListener('change', (e) => { state.category_id = e.target.value; load(); });
      document.getElementById('f-app').addEventListener('change', (e) => { state.application_id = e.target.value; load(); });
      document.getElementById('f-moved').addEventListener('change', load);
      await load();
    },
  });

  async function showItem(id) {
    const d = await API.get(`/api/stock/items/${id}`);
    const b = d.balance;
    UI.modal({
      title: `${d.item.item_code} — ${d.item.name}`,
      size: 'wide',
      body: `
        <div class="grid g5 mb">
          ${UI.stat({ label: 'On order', value: UI.qty(b.on_order), note: 'LPOs sent, not yet in', kind: 'info' })}
          ${UI.stat({ label: 'In the yard', value: UI.qty(b.on_hand), kind: 'green' })}
          ${UI.stat({ label: 'Committed', value: UI.qty(b.committed), note: 'promised on client LPOs', kind: 'gold' })}
          ${UI.stat({ label: 'Free', value: UI.qty(b.free), kind: b.free < 0 ? 'danger' : '' })}
          ${UI.stat({ label: 'Can promise', value: UI.qty(b.available), note: 'free plus what is on order' })}
        </div>
        <div class="grid g2">
          <div><h4>Still to come in</h4>${UI.table([
            { label: 'LPO', key: 'lpo_no' },
            { label: 'Maker', key: 'supplier_name' },
            { label: 'Wanted by', render: (r) => (r.delivery_date ? UI.date(r.delivery_date) : '—') },
            { label: 'Outstanding', num: true, render: (r) => UI.qty(r.pending) },
          ], d.onOrder, { emptyText: 'Nothing on order.' })}</div>
          <div><h4>Promised out</h4>${UI.table([
            { label: 'Order', key: 'so_no' },
            { label: 'Client', key: 'client_name' },
            { label: 'By', render: (r) => (r.delivery_date ? UI.date(r.delivery_date) : '—') },
            { label: 'Outstanding', num: true, render: (r) => UI.qty(r.pending) },
          ], d.committed, { emptyText: 'Nothing committed.' })}</div>
        </div>
        <h4 class="mt">Movement</h4>
        ${UI.table([
          { label: 'Date', render: (r) => UI.date(r.moved_on) },
          { label: 'What', render: (r) => UI.titleise(r.kind) },
          { label: 'Bucket', render: (r) => UI.badge(UI.titleise(r.bucket),
            r.bucket === 'onhand' ? 'ok' : r.bucket === 'ordered' ? 'info' : 'gold') },
          { label: 'Document', key: 'ref_no' },
          { label: 'Party', key: 'partner_name' },
          { label: 'Qty', num: true, render: (r) => `${r.qty > 0 ? '+' : ''}${UI.qty(r.qty)}` },
          { label: 'By', key: 'by_name' },
          { label: 'Note', key: 'notes' },
        ], d.movements, { emptyText: 'No movement yet.' })}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${APP.can(['logistics', 'kam']) ? '<button class="btn ghost" data-act="adjust">Adjust</button>' : ''}`,
      onAction(act) {
        if (act === 'adjust') { UI.closeAllModals(); openAdjustment(d.item); }
      },
    });
  }

  async function openAdjustment(item) {
    const m = await APP.loadMasters();
    const items = await LINES.catalogue();
    UI.modal({
      title: 'Adjust stock',
      body: `<p class="muted">An adjustment is the only entry in the register with no document behind
        it, so the reason is compulsory — a correction without one cannot be told from a mistake.</p>
        <form id="a-form">
          ${UI.field({ name: 'item_id', label: 'Item', required: true,
            value: item ? item.id : '', blank: 'Choose an item…',
            options: items.slice(0, 800).map((i) => ({ value: i.id, label: `${i.item_code} — ${i.name} ${i.size || ''}` })) })}
          ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', step: '0.001', required: true,
            hint: 'Positive to add, negative to take out.' })}
          ${UI.field({ name: 'location_id', label: 'Location', blank: 'Main yard',
            options: m.locations.map((l) => ({ value: l.id, label: l.name })) })}
          ${UI.field({ name: 'moved_on', label: 'Date', type: 'date', value: UI.today() })}
          ${UI.field({ name: 'reason', label: 'Reason', required: true, rows: 2,
            placeholder: 'Stock count difference / damaged in the yard / found unbooked' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Post the adjustment</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#a-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post('/api/stock/adjustments', UI.formValues(form));
        UI.ok(`Adjusted — ${res.ref_no}. On hand is now ${res.balance.on_hand}.`);
        APP.reload();
      },
    });
  }

  async function showReorder() {
    const d = await API.get('/api/stock/reorder');
    UI.modal({
      title: 'Below the reorder level',
      size: 'wide',
      body: UI.table([
        { label: 'Item', render: (r) => `<span class="mono small">${esc(r.item_code)}</span> ${esc(r.name)}` },
        { label: 'Free', num: true, render: (r) => UI.qty(r.free) },
        { label: 'Reorder at', num: true, render: (r) => UI.qty(r.reorder_level) },
        { label: 'On order', num: true, render: (r) => UI.qty(r.on_order) },
      ], d.rows, { emptyText: 'Nothing is below its reorder level. Levels are set on the item itself.' }),
      footer: '<button class="btn ghost" data-act="__close">Close</button>',
    });
  }
})();
