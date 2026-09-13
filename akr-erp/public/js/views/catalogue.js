/* The item master: one code per item, used on both sides of the trade. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  const state = { q: '', category_id: '', application_id: '', subgroup_id: '', page: 1 };

  APP.register('catalogue', {
    title: 'Item Master',
    subtitle: 'The common item number — the same code on the LPO to the maker and the invoice to the client',

    async render(host) {
      const canEdit = APP.can(['kam', 'accounts']);
      APP.actions([
        canEdit ? { id: 'new', label: '+ New item', kind: 'gold', onClick: () => openItem(null) } : null,
        canEdit ? { id: 'import', label: 'Import a list', onClick: openImport } : null,
        { id: 'export', label: 'Export CSV',
          onClick: () => API.download('/api/items/export/csv', 'akr-item-master.csv') },
      ].filter(Boolean));

      const m = await APP.loadMasters();
      host.innerHTML = `
        <div class="card">
          <div class="filters">
            <label class="field grow"><span>Search</span>
              <input id="f-q" value="${esc(state.q)}" placeholder="Code, name, size, brand, standard…"></label>
            <label class="field"><span>Product line</span>
              <select id="f-cat"><option value="">All 14 lines</option>
                ${m.categories.map((c) => `<option value="${c.id}"${String(c.id) === state.category_id ? ' selected' : ''}>${esc(c.name)} (${c.item_count})</option>`).join('')}
              </select></label>
            <label class="field"><span>Application</span>
              <select id="f-app"><option value="">All applications</option>
                ${m.applications.map((a) => `<option value="${a.id}"${String(a.id) === state.application_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select></label>
            <label class="field"><span>Type</span>
              <select id="f-sub"><option value="">All types</option>
                ${m.subgroups.map((s) => `<option value="${s.id}"${String(s.id) === state.subgroup_id ? ' selected' : ''}>${esc(s.product_group)} — ${esc(s.name)}</option>`).join('')}
              </select></label>
          </div>
          <div id="items">${UI.loading()}</div>
        </div>`;

      const load = async () => {
        const box = document.getElementById('items');
        box.innerHTML = UI.loading();
        const res = await API.get('/api/items' + API.qs({
          q: state.q, category_id: state.category_id, application_id: state.application_id,
          subgroup_id: state.subgroup_id, withStock: true, limit: 300,
        }));
        const cols = [
          { label: 'Item code', render: (r) => `<span class="mono">${esc(r.item_code)}</span>` },
          { label: 'Description', render: (r) => `<b>${esc(r.name)}</b>
              <div class="muted small">${[r.size, r.material, r.pressure_class, r.standard]
              .filter(Boolean).map(esc).join(' · ')}</div>` },
          { label: 'Line', render: (r) => `${esc(r.category_name || '')}
              <div class="muted small">${esc(r.subgroup_name || '')}</div>` },
          { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
          { label: 'Unit', key: 'uom' },
          { label: 'In yard', num: true, render: (r) => UI.qty(r.on_hand) },
          { label: 'On order', num: true, render: (r) => (r.on_order ? UI.qty(r.on_order) : '—') },
          { label: 'Free', num: true, render: (r) => `<b>${UI.qty(r.free)}</b>` },
        ];
        if (APP.seesCost()) cols.push({ label: 'Cost', num: true, render: (r) => UI.money(r.cost_price, { symbol: false }) });
        if (APP.seesPrices()) cols.push({ label: 'Sell', num: true, render: (r) => UI.money(r.sell_price, { symbol: false }) });

        box.innerHTML = `<div class="row-between mb"><span class="muted small">${UI.num(res.total)} items</span></div>`
          + UI.table(cols, res.rows, { onRow: true, emptyText: 'No item matches that.' });
        UI.bindRows(box, res.rows, (row) => openItemDetail(row.id));
      };

      let timer = null;
      document.getElementById('f-q').addEventListener('input', (e) => {
        state.q = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(load, 250);
      });
      for (const [id, key] of [['f-cat', 'category_id'], ['f-app', 'application_id'], ['f-sub', 'subgroup_id']]) {
        document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.value; load(); });
      }
      await load();
    },
  });

  // ------------------------------------------------------------------ detail
  async function openItemDetail(id) {
    const data = await API.get(`/api/items/${id}`);
    const it = data.item;
    const s = data.stock;
    UI.modal({
      title: `${it.item_code} — ${it.name}`,
      size: 'wide',
      body: `
        <div class="grid g2">
          <div>${UI.facts([
            ['Product line', esc(it.category_name || '—')],
            ['Type', esc(it.subgroup_name || '—')],
            ['Application', it.application_name ? UI.badge(it.application_name, 'navy') : '—'],
            ['Size', esc(it.size || '—')],
            ['Material', esc(it.material || '—')],
            ['Pressure / class', esc(it.pressure_class || '—')],
            ['Standard', esc(it.standard || '—')],
            ['Brand / maker', esc([it.brand, it.manufacturer_name].filter(Boolean).join(' · ') || '—')],
            ['Maker part no.', esc(it.mfr_part_no || '—')],
            ['Unit', esc(it.uom)],
            ['HS code', esc(it.hs_code || '—')],
            APP.seesCost() ? ['Landed cost', UI.money(it.cost_price)] : null,
            APP.seesPrices() ? ['Selling price', UI.money(it.sell_price)] : null,
            ['Lead time', it.lead_time_days ? `${it.lead_time_days} days` : '—'],
            ['Reorder level', it.reorder_level ? UI.qty(it.reorder_level) : 'not stocked to a level'],
          ])}</div>
          <div>
            <div class="grid g2">
              ${UI.stat({ label: 'On order', value: UI.qty(s.on_order), note: 'LPOs sent, not received', kind: 'info' })}
              ${UI.stat({ label: 'In the yard', value: UI.qty(s.on_hand), kind: 'green' })}
              ${UI.stat({ label: 'Committed', value: UI.qty(s.committed), note: 'promised on client LPOs', kind: 'gold' })}
              ${UI.stat({ label: 'Free to sell', value: UI.qty(s.free), kind: s.free < 0 ? 'danger' : '' })}
            </div>
            <div class="muted small mt">Received to date ${UI.qty(s.received_total)} ·
              delivered ${UI.qty(s.delivered_total)}</div>
            ${data.suppliers.length ? `<div class="mt"><b class="small">Who makes it</b>${
              UI.table([
                { label: 'Manufacturer', key: 'partner_name' },
                { label: 'Their ref', key: 'supplier_ref' },
                { label: 'Last price', num: true, render: (r) => (r.last_price === null ? '—' : UI.money(r.last_price, { symbol: false })) },
                { label: 'Quoted', render: (r) => UI.date(r.last_quoted) },
              ], data.suppliers)}</div>` : ''}
          </div>
        </div>
        <h4 class="mt">Recent movement</h4>
        ${UI.table([
          { label: 'Date', render: (r) => UI.date(r.moved_on) },
          { label: 'What', render: (r) => UI.titleise(r.kind) },
          { label: 'Bucket', render: (r) => UI.badge(UI.titleise(r.bucket)) },
          { label: 'Document', key: 'ref_no' },
          { label: 'Party', key: 'partner_name' },
          { label: 'Qty', num: true, render: (r) => (r.qty > 0 ? '+' : '') + UI.qty(r.qty) },
        ], data.movements.slice(0, 12), { emptyText: 'This item has not moved yet.' })}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn ghost" data-act="stock">Stock register</button>
               ${APP.can(['kam', 'accounts']) ? '<button class="btn" data-act="edit">Edit</button>' : ''}`,
      onAction(act) {
        if (act === 'edit') { UI.closeAllModals(); openItem(it); return; }
        if (act === 'stock') { UI.closeAllModals(); APP.navigate('stock', { item: it.id }); }
      },
    });
  }

  // -------------------------------------------------------------- new / edit
  async function openItem(item) {
    const m = await APP.loadMasters();
    const partners = (await API.get('/api/partners?type=supplier&limit=500')).rows;
    const isNew = !item;
    const cat = item ? m.categories.find((c) => c.id === item.category_id) : null;

    UI.modal({
      title: isNew ? 'New item' : `Edit ${item.item_code}`,
      size: 'wide',
      body: `<form id="item-form">
        <div class="grid g2">
          <div>
            ${UI.field({ name: 'name', label: 'Item name', required: true, value: item ? item.name : '',
              placeholder: 'Resilient Seated Gate Valve' })}
            ${UI.field({ name: 'category_id', label: 'Product line', required: true,
              value: item ? item.category_id : '', blank: 'Choose a line…',
              options: m.categories.map((c) => ({ value: c.id, label: c.name })),
              hint: 'The line decides the middle of the item code — AKR-VLP-00001 is a potable-water valve.' })}
            ${UI.field({ name: 'subgroup_id', label: 'Type within the line',
              value: item ? item.subgroup_id : '', blank: 'None',
              options: m.subgroups.map((s) => ({ value: s.id, label: `${s.product_group} — ${s.name}` })) })}
            ${UI.field({ name: 'application_id', label: 'Application',
              value: item ? item.application_id : '', blank: 'Take it from the product line',
              options: APP.applicationOptions() })}
            ${UI.field({ name: 'size', label: 'Size', value: item ? item.size || '' : '', placeholder: 'DN150' })}
            ${UI.field({ name: 'material', label: 'Material', value: item ? item.material || '' : '',
              placeholder: 'Ductile Iron' })}
            ${UI.field({ name: 'pressure_class', label: 'Pressure / class',
              value: item ? item.pressure_class || '' : '', placeholder: 'PN16' })}
            ${UI.field({ name: 'standard', label: 'Standard', value: item ? item.standard || '' : '',
              placeholder: 'BS EN 1171' })}
          </div>
          <div>
            ${UI.field({ name: 'brand', label: 'Brand', value: item ? item.brand || '' : '' })}
            ${UI.field({ name: 'manufacturer_id', label: 'Manufacturer', blank: 'Not set',
              value: item ? item.manufacturer_id : '',
              options: partners.map((p) => ({ value: p.id, label: p.name })) })}
            ${UI.field({ name: 'mfr_part_no', label: "Manufacturer's part number",
              value: item ? item.mfr_part_no || '' : '' })}
            ${UI.field({ name: 'uom', label: 'Unit of measure', value: item ? item.uom : 'NOS',
              options: m.uoms.map((u) => ({ value: u, label: u })) })}
            ${UI.field({ name: 'hs_code', label: 'HS code', value: item ? item.hs_code || '' : '' })}
            ${APP.seesCost() ? UI.field({ name: 'cost_price', label: 'Landed cost', type: 'number',
              step: '0.01', value: item ? item.cost_price : 0,
              hint: 'Updated automatically from the last goods receipt.' }) : ''}
            ${UI.field({ name: 'sell_price', label: 'Selling price (list)', type: 'number', step: '0.01',
              value: item ? item.sell_price : 0 })}
            ${UI.field({ name: 'vat_percent', label: 'VAT %', type: 'number', step: '0.01',
              value: item ? item.vat_percent : APP.vatPercent })}
            <div class="grid g2">
              ${UI.field({ name: 'reorder_level', label: 'Reorder level', type: 'number', step: '0.001',
                value: item ? item.reorder_level : 0 })}
              ${UI.field({ name: 'lead_time_days', label: 'Lead time (days)', type: 'number',
                value: item ? item.lead_time_days : 0 })}
            </div>
          </div>
        </div>
        ${UI.field({ name: 'description', label: 'Description', rows: 2,
          value: item ? item.description || '' : '' })}
        ${isNew ? UI.field({ name: 'item_code', label: 'Item code',
          hint: 'Leave blank and the system issues the next code in the line.' }) : ''}
        ${item ? UI.checkbox({ name: 'active', label: 'Active in the catalogue', checked: !!item.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${isNew ? 'Create the item' : 'Save'}</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#item-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (item) values.active = form.querySelector('[name=active]').checked;
        const saved = item
          ? await API.patch(`/api/items/${item.id}`, values)
          : await API.post('/api/items', values);
        UI.ok(item ? 'Item saved.' : `Created ${saved.item_code}.`);
        LINES.refresh();
        APP.reload();
        return undefined;
      },
    });
  }

  // ---------------------------------------------------------------- import
  /*
   * Loading the company's own list.
   *
   * The list already exists — on the website, in a price list, in somebody's
   * workbook — and typing it in again is how a catalogue ends up with two codes
   * for the same valve. Paste it or drop the file in; an item code that is
   * already here is updated rather than duplicated, and a dry run says what
   * would happen before anything does.
   */
  function openImport() {
    UI.modal({
      title: 'Import items',
      size: 'wide',
      body: `
        <p class="muted">Paste the sheet as CSV, or choose a file. A row whose <code>item_code</code>
          is already in the master updates that item; a row without one is created and given the next
          code in its product line.</p>
        <div class="alert info">
          <b>Required columns:</b> <code>name</code> and <code>category_code</code> (the product line —
          VLP, VLI, VLS, VLD, GTP, GTI, GTS, MFW, MFO, GRL, FST, MFP, MFI, MFS).<br>
          <b>Also read:</b> item_code, description, application_code (PW, SW, SEW, DC, IRR), subgroup,
          brand, mfr_part_no, material, size, pressure_class, standard, uom, hs_code, cost_price,
          sell_price, vat_percent, reorder_level, lead_time_days.
        </div>
        <div class="btn-row mb">
          <button class="btn ghost sm" id="tpl">Download the template</button>
          <label class="btn ghost sm" style="cursor:pointer;margin:0">
            Choose a CSV file<input type="file" id="file" accept=".csv,text/csv" hidden></label>
        </div>
        <label class="field"><span>CSV</span>
          <textarea id="csv" rows="12" placeholder="item_code,name,description,category_code,..."></textarea></label>
        <div id="import-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn ghost" data-act="check">Check it first</button>
               <button class="btn" data-act="import">Import</button>`,
      onMount(modal) {
        modal.querySelector('#tpl').addEventListener('click', () =>
          API.download('/api/items/import/template', 'akr-item-import-template.csv'));
        modal.querySelector('#file').addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          modal.querySelector('#csv').value = await file.text();
        });
      },
      async onAction(act, modal) {
        if (act !== 'check' && act !== 'import') return undefined;
        const csv = modal.querySelector('#csv').value.trim();
        const out = modal.querySelector('#import-out');
        if (!csv) { out.innerHTML = '<div class="alert warn">There is nothing to import yet.</div>'; return 'keep'; }
        out.innerHTML = UI.loading();
        try {
          const res = await API.post('/api/items/import/csv', { csv, dryRun: act === 'check' });
          const skipped = res.skipped.length
            ? `<div class="mt small"><b>${res.skipped.length} row(s) skipped:</b><br>${
              res.skipped.slice(0, 20).map((s) => `line ${s.line} — ${esc(s.reason)}`).join('<br>')}</div>`
            : '';
          out.innerHTML = `<div class="alert ${res.skipped.length ? 'warn' : 'ok'}">
            <b>${act === 'check' ? 'Dry run' : 'Imported'}:</b> ${res.created} to create, ${res.updated} to update,
            out of ${res.rows} rows.${skipped}</div>`;
          if (act === 'import') { LINES.refresh(); UI.ok('Catalogue updated.'); }
        } catch (err) {
          out.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
        }
        return 'keep';
      },
    });
  }
})();
