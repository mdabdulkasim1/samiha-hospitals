/*
 * Pharmacy stock register — barcodes, goods received, the register itself and
 * the physical stock take. Mounted as tabs inside the Pharmacy screen, but kept
 * in its own module because the purchase side of the pharmacy is a book of its
 * own: it answers to the supplier and the auditor, not to the patient queue.
 */
(function () {
  'use strict';

  const money = (v) => UI.money(v);
  const isPharmacist = () => APP.can(['pharmacy']);

  // ------------------------------------------------------------------ scan
  /** Renders the shared scan box. `onHit` receives the /scan payload. */
  function scanBox(host, { placeholder = 'Scan or type a barcode…', onHit }) {
    host.innerHTML = `
      <div class="search-row">
        <input type="search" id="sc-code" placeholder="${UI.esc(placeholder)}" autocomplete="off" autofocus>
        <button class="btn sm" id="sc-go">Look up</button>
      </div>
      <div id="sc-out" class="mt"></div>`;
    const input = host.querySelector('#sc-code');
    const out = host.querySelector('#sc-out');

    const lookup = async () => {
      const code = input.value.trim();
      if (!code) return;
      try {
        const hit = await API.get('/api/stock/scan' + API.qs({ code }));
        out.innerHTML = '';
        input.select();
        if (onHit) onHit(hit, out);
      } catch (err) {
        out.innerHTML = `<div class="alert danger">${UI.esc(err.message)}</div>`;
        input.select();
      }
    };

    // Barcode guns type the code and press Enter, so Enter is the whole UX.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); lookup(); }
    });
    host.querySelector('#sc-go').addEventListener('click', lookup);
    return { lookup, input };
  }

  /**
   * Draw one sticker. A medicine label carries the code we identify the drug
   * by; a batch label additionally carries the batch and expiry, which is what
   * the counter needs to sell the right box.
   */
  function labelCell(r, kind) {
    const code = r.barcode;
    const name = r.drug_name || r.name;
    return `
      <div class="label">
        <div class="label-head">${UI.esc(APP.clinic.name)}</div>
        <div class="label-name">${UI.esc(name)} ${UI.esc(r.strength || '')}</div>
        ${kind === 'batch'
          ? `<div class="label-meta">Batch ${UI.esc(r.batch_no)} · Exp ${UI.esc(UI.date(r.expiry_date))}</div>`
          : `<div class="label-meta">${UI.esc(r.form || '')} ${UI.esc(r.manufacturer || '')}</div>`}
        <div class="label-meta">MRP ${UI.esc(UI.money(r.mrp))}</div>
        ${code ? Barcode.svg(code, { module: 1.5, height: 40, fontSize: 9 })
               : '<div class="label-meta">No barcode — generate one first</div>'}
      </div>`;
  }

  /**
   * A printer-ready sheet. Works on a plain A4 sheet of sticker paper and on a
   * roll label printer alike — the columns setting is what changes between them.
   */
  function printLabels(rows, { kind = 'batch', copies = 1, columns = 3, title = 'Barcode labels' } = {}) {
    if (!rows || !rows.length) return UI.err('Nothing to print.');
    let cells = '';
    for (const r of rows) {
      for (let i = 0; i < Math.max(1, Number(copies) || 1); i += 1) cells += labelCell(r, kind);
    }
    UI.print(`
      <style>
        .labels { display:grid; grid-template-columns:repeat(${Number(columns) || 3}, 1fr); gap:4mm; }
        .label { border:1px dashed #999; padding:3mm; text-align:center; page-break-inside:avoid; }
        .label-head { font-size:8px; letter-spacing:1px; text-transform:uppercase; color:#9E1B34; }
        .label-name { font-weight:700; font-size:11px; margin:2px 0; line-height:1.2; }
        .label-meta { font-size:9px; color:#333; }
        .label svg { margin-top:2px; }
      </style>
      <div class="labels">${cells}</div>`, title);
  }

  /** Ask how many stickers and how they sit on the sheet, then print. */
  function openLabelDialog(rows, kind, title) {
    UI.modal({
      title: title || 'Print barcode labels',
      size: 'narrow',
      body: `<p class="muted">${UI.num(rows.length)} label design(s) ready. Load your sticker sheet or roll,
        then print — the browser's print dialog is where you pick the label printer.</p>
        <form id="lb-form">
          <div class="grid c2">
            ${UI.field({ name: 'copies', label: 'Copies of each', type: 'number', min: 1, value: 1 })}
            ${UI.field({ name: 'columns', label: 'Labels across the page', type: 'number', min: 1, max: 6, value: 3,
              hint: 'Use 1 for a roll printer' })}
          </div>
        </form>
        <div class="mt" style="max-width:180px">${labelCell(rows[0], kind)}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn" data-act="print">Print</button>`,
      onAction(act, modal) {
        if (act !== 'print') return;
        const v = UI.formValues(modal.querySelector('#lb-form'));
        printLabels(rows, { kind, copies: v.copies, columns: v.columns, title: title || 'Barcode labels' });
      },
    });
  }

  // -------------------------------------------------------------- barcodes
  /**
   * The barcode desk: which medicines can be scanned, which still need a
   * sticker, and the button that prints them.
   */
  async function barcodes(body) {
    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>Test a scan</h3>
        <span class="muted small">Point the scanner at a strip — this is what the counter will see</span></div>
        <div class="card-body" id="bc-scan"></div></div>

      <div class="card"><div class="card-head"><h3>Medicine barcodes</h3>
        <input type="search" id="bc-q" placeholder="Search medicines…" style="max-width:220px">
        ${isPharmacist() ? `
          <button class="btn ghost sm" id="bc-fill">Generate for every medicine missing one</button>
          <button class="btn sm" id="bc-print">Print label sheet</button>` : ''}</div>
        <div id="bc-stats"></div>
        <div class="card-body tight" id="bc-list">${UI.loading()}</div></div>`;

    scanBox(body.querySelector('#bc-scan'), {
      placeholder: 'Scan a medicine or batch label to check it…',
      onHit: (hit, out) => {
        out.innerHTML = `<div class="alert ok">
          Reads as <b>${UI.esc(hit.drug.name)} ${UI.esc(hit.drug.strength || '')}</b>
          — ${UI.esc(hit.onHand)} in stock${hit.match === 'batch'
            ? `, batch ${UI.esc(hit.batch.batch_no)} expiring ${UI.esc(UI.date(hit.batch.expiry_date))}` : ''}.
          ${hit.expired ? '<b> This batch has expired — do not sell it.</b>' : ''}</div>`;
      },
    });

    const selected = new Set();

    const load = async () => {
      const data = await API.get('/api/stock/barcodes' + API.qs({ q: body.querySelector('#bc-q').value.trim() }));
      body.querySelector('#bc-stats').innerHTML = `
        <div class="grid c3" style="padding:12px 16px 0">
          <div class="stat teal"><div class="label">Medicines</div><div class="value">${UI.num(data.total)}</div></div>
          <div class="stat ok"><div class="label">Scannable</div>
            <div class="value">${UI.num(data.total - data.missing)}</div><div class="foot">Barcode linked or printed</div></div>
          <div class="stat ${data.missing ? 'crimson' : ''}"><div class="label">Still without a code</div>
            <div class="value">${UI.num(data.missing)}</div><div class="foot">Generate and paste a label</div></div>
        </div>`;

      body.querySelector('#bc-list').innerHTML = UI.table([
        { label: '', render: (d) => d.barcode
          ? `<input type="checkbox" data-pick="${d.id}"${selected.has(d.id) ? ' checked' : ''}>` : '' },
        { label: 'Medicine', render: (d) => `<b>${UI.esc(d.name)}</b>` +
          `<div class="muted small"><code>${UI.esc(d.code)}</code> ${UI.esc(d.strength || '')} ${UI.esc(d.form || '')}</div>` },
        { label: 'Barcode', render: (d) => d.barcode
          ? `<div style="max-width:160px">${Barcode.svg(d.barcode, { module: 1.2, height: 30, fontSize: 9 })}</div>`
          : UI.badge('No code yet', 'danger') },
        { label: 'On hand', num: true, render: (d) => UI.num(d.on_hand) },
        { label: 'Batch labels', num: true, render: (d) => UI.num(d.labelled_batches) },
        { label: '', render: (d) => !isPharmacist() ? '' : (d.barcode
          ? `<button class="btn ghost sm" data-one="${d.id}">Print</button>`
          : `<button class="btn sm" data-gen="${d.id}">Generate</button>
             <button class="btn ghost sm" data-link="${d.id}">Scan pack</button>`) },
      ], data.rows, { emptyText: 'No medicine matched.' });

      body.querySelectorAll('[data-pick]').forEach((cb) => cb.addEventListener('change', () => {
        const id = Number(cb.dataset.pick);
        if (cb.checked) selected.add(id); else selected.delete(id);
      }));
      body.querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', async () => {
        const drug = await API.post(`/api/stock/barcodes/drug/${b.dataset.gen}/generate`, {});
        UI.ok(`${drug.name} is now ${drug.barcode}.`);
        await load();
        openLabelDialog([drug], 'drug', `Labels for ${drug.name}`);
      }));
      body.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', async () => {
        const code = prompt('Scan the barcode printed on the pack:');
        if (!code || !code.trim()) return;
        await API.post(`/api/stock/barcodes/drug/${b.dataset.link}`, { barcode: code.trim() });
        UI.ok('Pack barcode linked.');
        load();
      }));
      body.querySelectorAll('[data-one]').forEach((b) => b.addEventListener('click', async () => {
        const rows = await API.get('/api/stock/labels/drugs' + API.qs({ drugIds: b.dataset.one }));
        openLabelDialog(rows, 'drug', `Labels for ${rows[0].name}`);
      }));
    };

    let t;
    body.querySelector('#bc-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });

    const fill = body.querySelector('#bc-fill');
    if (fill) fill.addEventListener('click', async () => {
      if (!await UI.confirm('Generate a barcode for every medicine that has none? ' +
        'You can then print the sheet and paste one on each pack.', { title: 'Generate barcodes' })) return;
      const res = await API.post('/api/stock/barcodes/generate-missing', {});
      UI.ok(res.generated ? `${res.generated} barcode(s) generated.` : 'Every medicine already has a barcode.');
      await load();
      if (res.generated) {
        const rows = await API.get('/api/stock/labels/drugs' + API.qs({ drugIds: res.drugs.map((d) => d.id).join(',') }));
        openLabelDialog(rows, 'drug', 'Labels for the new barcodes');
      }
    });

    const printAll = body.querySelector('#bc-print');
    if (printAll) printAll.addEventListener('click', async () => {
      const rows = await API.get('/api/stock/labels/drugs' +
        (selected.size ? API.qs({ drugIds: [...selected].join(',') }) : ''));
      openLabelDialog(rows, 'drug', selected.size ? 'Labels for the selected medicines' : 'Labels for every medicine');
    });

    await load();
  }

  // ------------------------------------------------------------- purchases
  async function purchases(body) {
    body.innerHTML = UI.loading();
    const data = await API.get('/api/stock/purchases?limit=60');
    body.innerHTML = `
      <div class="grid c3 mb">
        <div class="stat teal"><div class="label">Goods-received notes</div>
          <div class="value">${UI.num(data.rows.length)}</div><div class="foot">Most recent first</div></div>
        <div class="stat crimson"><div class="label">Purchases booked</div>
          <div class="value">${money(data.totals.net)}</div><div class="foot">All suppliers</div></div>
        <div class="stat orange"><div class="label">Owed to suppliers</div>
          <div class="value">${money(data.totals.outstanding)}</div><div class="foot">Unpaid invoices</div></div>
      </div>
      <div class="card"><div class="card-head"><h3>Goods received</h3>
        <button class="btn ghost sm" id="pu-suppliers">Suppliers</button>
        ${isPharmacist() ? '<button class="btn sm" id="pu-new">+ Record goods received</button>' : ''}</div>
        <div class="card-body tight" id="pu-list"></div></div>`;

    body.querySelector('#pu-list').innerHTML = UI.table([
      { label: 'GRN', render: (r) => `<code>${UI.esc(r.grn_no)}</code>` },
      { label: 'Supplier', render: (r) => `<b>${UI.esc(r.supplier_name)}</b>` +
        `<div class="muted small">${UI.esc(r.invoice_no || 'no invoice number')}</div>` },
      { label: 'Received', render: (r) => UI.esc(UI.dateTime(r.received_at)) },
      { label: 'Lines', num: true, render: (r) => UI.esc(r.lines) },
      { label: 'Net', num: true, render: (r) => money(r.net) },
      { label: 'Paid', num: true, render: (r) => money(r.paid) },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      { label: '', render: (r) => `<button class="btn ghost sm" data-grn="${r.id}">Open</button>` },
    ], data.rows, { emptyText: 'No goods-received note recorded yet.' });

    body.querySelectorAll('[data-grn]').forEach((b) =>
      b.addEventListener('click', () => openPurchase(Number(b.dataset.grn))));
    body.querySelector('#pu-suppliers').addEventListener('click', openSuppliers);
    const add = body.querySelector('#pu-new');
    if (add) add.addEventListener('click', () => openGrn(() => purchases(body)));
  }

  async function openPurchase(id) {
    const p = await API.get(`/api/stock/purchases/${id}`);
    UI.modal({
      title: `Goods received ${p.grn_no}`,
      size: 'wide',
      body: `
        <div class="grid c3 mb">
          <div><div class="muted small">Supplier</div><b>${UI.esc(p.supplier_name)}</b>
            <div class="muted small">${UI.esc(p.gstin || '')}</div></div>
          <div><div class="muted small">Supplier invoice</div><b>${UI.esc(p.invoice_no || '—')}</b>
            <div class="muted small">${UI.esc(p.invoice_date ? UI.date(p.invoice_date) : '')}</div></div>
          <div><div class="muted small">Received by</div><b>${UI.esc(p.received_by || '—')}</b>
            <div class="muted small">${UI.esc(UI.dateTime(p.received_at))}</div></div>
        </div>
        ${UI.table([
          { label: 'Medicine', render: (i) => `<b>${UI.esc(i.drug_name)}</b>` +
            `<div class="muted small">${UI.esc(i.strength || '')} ${UI.esc(i.form || '')}</div>` },
          { label: 'Batch', render: (i) => `${UI.esc(i.batch_no)}<div class="muted small">Exp ${UI.esc(UI.date(i.expiry_date))}</div>` },
          { label: 'Barcode', render: (i) => i.barcode ? `<code>${UI.esc(i.barcode)}</code>` : '—' },
          { label: 'Qty', num: true, render: (i) => `${UI.esc(i.qty)}${i.free_qty ? ` + ${UI.esc(i.free_qty)} free` : ''}` },
          { label: 'Cost', num: true, render: (i) => money(i.purchase_price) },
          { label: 'MRP', num: true, render: (i) => money(i.mrp) },
          { label: 'Amount', num: true, render: (i) => money(i.amount) },
        ], p.items)}
        <div class="totals mt">
          <div class="line"><span>Gross</span><span>${money(p.gross)}</span></div>
          <div class="line"><span>Discount</span><span>− ${money(p.discount)}</span></div>
          <div class="line"><span>Tax</span><span>${money(p.tax)}</span></div>
          <div class="line grand"><span>Net</span><span>${money(p.net)}</span></div>
          <div class="line"><span>Paid</span><span>${money(p.paid)}</span></div>
          <div class="line"><span>Outstanding</span><span>${money(p.net - p.paid)}</span></div>
        </div>`,
      footer: `<button class="btn ghost" data-act="labels">Print batch labels</button>
        ${isPharmacist() && p.net - p.paid > 0.009 ? '<button class="btn" data-act="pay">Record a payment</button>' : ''}
        <button class="btn ghost" data-act="__close">Close</button>`,
      async onAction(act) {
        if (act === 'labels') {
          const ids = p.items.map((i) => i.batch_id).filter(Boolean).join(',');
          if (!ids) return 'keep';
          openLabelDialog(await API.get('/api/stock/labels' + API.qs({ batchIds: ids })), 'batch', 'Batch labels');
          return 'keep';
        }
        if (act === 'pay') {
          const amount = prompt(`Amount paid to ${p.supplier_name} (outstanding ${p.net - p.paid}):`);
          if (amount === null) return 'keep';
          await API.post(`/api/stock/purchases/${p.id}/pay`, { amount });
          UI.ok('Payment recorded.');
          APP.reload();
        }
      },
    });
  }

  /** The goods-received note: one supplier invoice, many batches. */
  async function openGrn(onDone) {
    const [suppliers, drugs] = await Promise.all([
      API.get('/api/stock/suppliers'),
      API.get('/api/pharmacy/drugs?limit=400'),
    ]);
    if (!suppliers.filter((s) => s.active).length) {
      UI.warn('Add a supplier first — every delivery is booked against one.');
      return openSuppliers();
    }
    const lines = [];

    UI.modal({
      title: 'Record goods received',
      size: 'wide',
      body: `
        <form id="gr-head">
          <div class="grid c4">
            ${UI.field({ name: 'supplierId', label: 'Supplier', required: true,
              options: [{ value: '', label: '— select —' }].concat(
                suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))) })}
            ${UI.field({ name: 'invoiceNo', label: 'Supplier invoice no.' })}
            ${UI.field({ name: 'invoiceDate', label: 'Invoice date', type: 'date' })}
            ${UI.field({ name: 'dueDate', label: 'Payment due', type: 'date' })}
          </div>
        </form>
        <div class="card"><div class="card-head"><h3>Medicines delivered</h3></div>
          <div class="card-body">
            <form id="gr-line">
              <div class="grid c4">
                ${UI.field({ name: 'drugId', label: 'Medicine', required: true,
                  options: [{ value: '', label: '— select —' }].concat(
                    drugs.map((d) => ({ value: d.id, label: `${d.name} ${d.strength || ''}`.trim() }))) })}
                ${UI.field({ name: 'batchNo', label: 'Batch number', required: true })}
                ${UI.field({ name: 'expiryDate', label: 'Expiry', type: 'date', required: true })}
                ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', min: 1, required: true })}
              </div>
              <div class="grid c4">
                ${UI.field({ name: 'freeQty', label: 'Free quantity', type: 'number', min: 0, value: 0 })}
                ${UI.field({ name: 'purchasePrice', label: 'Cost per unit', type: 'number', step: '0.01' })}
                ${UI.field({ name: 'mrp', label: 'MRP per unit', type: 'number', step: '0.01' })}
                ${UI.field({ name: 'discountPct', label: 'Discount %', type: 'number', step: '0.01', value: 0 })}
              </div>
              <div class="grid c3">
                ${UI.field({ name: 'taxPct', label: 'GST %', type: 'number', step: '0.01', value: 12 })}
                ${UI.field({ name: 'packBarcode', label: 'Pack barcode',
                  hint: 'Scan the EAN on the strip — links it to this medicine for good' })}
                ${UI.field({ name: 'barcode', label: 'Batch barcode',
                  hint: 'Leave blank and we print our own label' })}
              </div>
              <button class="btn ghost sm" type="submit">+ Add this line</button>
            </form>
            <div id="gr-lines" class="mt"></div>
          </div>
        </div>
        <form id="gr-foot">
          <div class="grid c2">
            ${UI.field({ name: 'discount', label: 'Invoice-level discount', type: 'number', step: '0.01', value: 0 })}
            ${UI.field({ name: 'paid', label: 'Paid now', type: 'number', step: '0.01', value: 0 })}
          </div>
          ${UI.field({ name: 'notes', label: 'Notes', rows: 2 })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn" data-act="save">Book the delivery</button>`,
      onMount(modal) {
        const host = modal.querySelector('#gr-lines');
        const lineForm = modal.querySelector('#gr-line');

        const draw = () => {
          host.innerHTML = lines.length ? UI.table([
            { label: 'Medicine', render: (l) => UI.esc(l.drugName) },
            { label: 'Batch', render: (l) => `${UI.esc(l.batchNo)}<div class="muted small">Exp ${UI.esc(UI.date(l.expiryDate))}</div>` },
            { label: 'Qty', num: true, render: (l) => `${UI.esc(l.qty)}${Number(l.freeQty) ? ` + ${UI.esc(l.freeQty)}` : ''}` },
            { label: 'Cost', num: true, render: (l) => money(l.purchasePrice) },
            { label: 'MRP', num: true, render: (l) => money(l.mrp) },
            { label: 'Amount', num: true, render: (l) => money(lineAmount(l)) },
            { label: '', render: (l, i) => `<button class="btn ghost sm" type="button" data-rm="${i}">×</button>` },
          ], lines) : UI.empty('Add each batch as it comes out of the carton.', '📦');
          host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
            lines.splice(Number(b.dataset.rm), 1); draw();
          }));
        };

        lineForm.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!lineForm.reportValidity()) return;
          const v = UI.formValues(lineForm);
          const drug = drugs.find((d) => d.id === Number(v.drugId));
          lines.push({ ...v, drugName: `${drug.name} ${drug.strength || ''}`.trim() });
          lineForm.reset();
          lineForm.querySelector('[name=taxPct]').value = 12;
          lineForm.querySelector('[name=freeQty]').value = 0;
          lineForm.querySelector('[name=discountPct]').value = 0;
          draw();
        });
        draw();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const head = modal.querySelector('#gr-head');
        if (!head.reportValidity()) return 'keep';
        if (!lines.length) { UI.err('Add at least one medicine.'); return 'keep'; }
        const payload = {
          ...UI.formValues(head),
          ...UI.formValues(modal.querySelector('#gr-foot')),
          items: lines,
        };
        const res = await API.post('/api/stock/purchases', payload);
        UI.ok(`Booked ${res.purchase.grn_no} — ${UI.money(res.purchase.net)}.`);
        openLabelDialog(res.batches.map((b) => {
          const line = lines.find((l) => Number(l.drugId) === b.drug_id) || {};
          return { ...b, drug_name: line.drugName || '', strength: '' };
        }), 'batch', `Batch labels for ${res.purchase.grn_no}`);
        if (onDone) onDone();
      },
    });
  }

  function lineAmount(l) {
    const gross = Number(l.purchasePrice || 0) * Number(l.qty || 0);
    const disc = gross * (Number(l.discountPct || 0) / 100);
    return gross - disc + (gross - disc) * (Number(l.taxPct || 0) / 100);
  }

  async function openSuppliers() {
    const rows = await API.get('/api/stock/suppliers');
    UI.modal({
      title: 'Suppliers',
      size: 'wide',
      body: `<div id="sp-list">${UI.table([
        { label: 'Code', render: (s) => `<code>${UI.esc(s.code)}</code>` },
        { label: 'Supplier', render: (s) => `<b>${UI.esc(s.name)}</b>` +
          `<div class="muted small">${UI.esc(s.contact_person || '')} ${UI.esc(s.phone || '')}</div>` },
        { label: 'GSTIN', render: (s) => UI.esc(s.gstin || '—') },
        { label: 'Credit', num: true, render: (s) => `${UI.esc(s.credit_days)} d` },
        { label: 'Deliveries', num: true, render: (s) => UI.esc(s.purchases) },
        { label: 'Outstanding', num: true, render: (s) => money(s.outstanding) },
        { label: '', render: (s) => s.active ? UI.badge('Active', 'ok') : UI.badge('Inactive', '') },
      ], rows, { emptyText: 'No supplier on file yet.' })}</div>`,
      footer: `${isPharmacist() ? '<button class="btn" data-act="add">+ Add a supplier</button>' : ''}
        <button class="btn ghost" data-act="__close">Close</button>`,
      onAction(act) {
        if (act !== 'add') return;
        UI.closeAllModals();
        openAddSupplier();
      },
    });
  }

  function openAddSupplier() {
    UI.modal({
      title: 'Add a supplier',
      body: `<form id="sp-form">
        <div class="grid c2">
          ${UI.field({ name: 'name', label: 'Supplier name', required: true })}
          ${UI.field({ name: 'code', label: 'Code', hint: 'Left blank, we generate one' })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'contactPerson', label: 'Contact person' })}
          ${UI.field({ name: 'phone', label: 'Phone' })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'email', label: 'Email', type: 'email' })}
          ${UI.field({ name: 'creditDays', label: 'Credit days', type: 'number', value: 30 })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'gstin', label: 'GSTIN' })}
          ${UI.field({ name: 'dlNumber', label: 'Drug licence no.' })}
        </div>
        ${UI.field({ name: 'address', label: 'Address', rows: 2 })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn" data-act="save">Add supplier</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#sp-form');
        if (!form.reportValidity()) return 'keep';
        await API.post('/api/stock/suppliers', UI.formValues(form));
        UI.ok('Supplier added.');
        UI.closeAllModals();
        openSuppliers();
      },
    });
  }

  // -------------------------------------------------------- stock register
  async function register(body) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>Scan a medicine</h3>
        <span class="muted small">Pack barcode or one of our batch labels</span></div>
        <div class="card-body" id="sr-scan"></div></div>

      <div class="card"><div class="card-head"><h3>Stock register</h3>
        <input type="date" id="sr-from" value="${from}" style="max-width:165px">
        <input type="date" id="sr-to" value="${to}" style="max-width:165px">
        <input type="search" id="sr-q" placeholder="Filter medicines…" style="max-width:200px">
        ${isPharmacist() ? '<button class="btn ghost sm" id="sr-expiry">Write off expired</button>' : ''}
      </div>
        <div id="sr-totals"></div>
        <div class="card-body tight" id="sr-list">${UI.loading()}</div></div>`;

    scanBox(body.querySelector('#sr-scan'), {
      onHit: (hit, out) => {
        const d = hit.drug;
        out.innerHTML = `<div class="alert ${hit.expired ? 'danger' : 'ok'}">
          <b>${UI.esc(d.name)} ${UI.esc(d.strength || '')}</b> — ${UI.esc(hit.onHand)} in stock
          ${hit.match === 'batch'
            ? ` · batch ${UI.esc(hit.batch.batch_no)}, expiry ${UI.esc(UI.date(hit.batch.expiry_date))}` +
              (hit.expired ? ' <b>— EXPIRED, do not sell</b>' : '')
            : ''}
          <div class="mt"><button class="btn sm" id="sr-open">Open the register for this medicine</button></div>
        </div>`;
        out.querySelector('#sr-open').addEventListener('click', () => openMovements(d.id));
      },
    });

    const load = async () => {
      const params = {
        from: body.querySelector('#sr-from').value,
        to: body.querySelector('#sr-to').value,
        q: body.querySelector('#sr-q').value.trim(),
      };
      const data = await API.get('/api/stock/register' + API.qs(params));
      body.querySelector('#sr-totals').innerHTML = `
        <div class="grid c5" style="padding:12px 16px 0">
          <div class="stat teal"><div class="label">Medicines</div><div class="value">${UI.num(data.totals.medicines)}</div></div>
          <div class="stat ok"><div class="label">Received</div><div class="value">${UI.num(data.totals.inward)}</div></div>
          <div class="stat orange"><div class="label">Issued</div><div class="value">${UI.num(data.totals.outward)}</div></div>
          <div class="stat crimson"><div class="label">Stock value</div><div class="value">${money(data.totals.stockValue)}</div></div>
          <div class="stat"><div class="label">Expired on shelf</div><div class="value">${UI.num(data.totals.expiredQty)}</div></div>
        </div>`;
      body.querySelector('#sr-list').innerHTML = UI.table([
        { label: 'Medicine', render: (r) => `<b>${UI.esc(r.name)}</b>` +
          `<div class="muted small"><code>${UI.esc(r.code)}</code> ${UI.esc(r.strength || '')} ${UI.esc(r.form || '')}` +
          `${r.barcode ? ` · ${UI.esc(r.barcode)}` : ''}</div>` },
        { label: 'Opening', num: true, render: (r) => UI.num(r.opening) },
        { label: 'Received', num: true, render: (r) => UI.num(r.inward) },
        { label: 'Issued', num: true, render: (r) => UI.num(r.outward) },
        { label: 'Closing', num: true, render: (r) => `<b>${UI.num(r.closing)}</b>` },
        { label: 'On hand', num: true, render: (r) => r.on_hand <= r.reorder_level
          ? `<b style="color:var(--danger)">${UI.num(r.on_hand)}</b>` : UI.num(r.on_hand) },
        { label: 'Expired', num: true, render: (r) => r.expired_qty
          ? `<b style="color:var(--danger)">${UI.num(r.expired_qty)}</b>` : '—' },
        { label: 'Value', num: true, render: (r) => money(r.stock_value) },
        { label: '', render: (r) => `<button class="btn ghost sm" data-mv="${r.drug_id}">Movements</button>` },
      ], data.rows, { emptyText: 'No medicine matched.' });
      body.querySelectorAll('[data-mv]').forEach((b) =>
        b.addEventListener('click', () => openMovements(Number(b.dataset.mv), params)));
    };

    let t;
    body.querySelector('#sr-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
    body.querySelector('#sr-from').addEventListener('change', load);
    body.querySelector('#sr-to').addEventListener('change', load);
    const wipe = body.querySelector('#sr-expiry');
    if (wipe) wipe.addEventListener('click', async () => {
      if (!await UI.confirm('Write every expired batch off the shelf? The quantities stay in the ledger as an expiry loss.',
        { title: 'Write off expired stock', danger: true })) return;
      const res = await API.post('/api/stock/write-off-expired', {});
      UI.ok(res.written ? `${res.written} batch(es) written off — ${UI.money(res.value)}.` : 'No expired batch on the shelf.');
      load();
    });
    await load();
  }

  async function openMovements(drugId, range = {}) {
    const data = await API.get(`/api/stock/register/${drugId}/movements` + API.qs(range));
    const kinds = {
      purchase: 'Received', sale: 'Sold', return: 'Returned', adjustment: 'Adjusted',
      expiry: 'Expired', ip_issue: 'Issued to ward',
    };
    UI.modal({
      title: `${data.drug.name} ${data.drug.strength || ''} — stock register`,
      size: 'wide',
      body: `
        <div class="grid c2 mb">
          <div><div class="muted small">Pack barcode</div>
            ${data.drug.barcode ? Barcode.svg(data.drug.barcode, { module: 1.6, height: 40, fontSize: 10 })
              : `<div class="muted small">Not linked yet.
                 ${isPharmacist() ? '<button class="btn ghost sm" data-act="link">Link a barcode</button>' : ''}</div>`}</div>
          <div><div class="muted small">On hand</div>
            <div style="font-size:26px;font-weight:700">${UI.num(data.batches.reduce((s, b) => s + b.qty_available, 0))}</div>
            <div class="muted small">Reorder at ${UI.esc(data.drug.reorder_level)}</div></div>
        </div>

        <h4>Batches</h4>
        ${UI.table([
          { label: 'Batch', key: 'batch_no' },
          { label: 'Expiry', render: (b) => b.expiry_date < new Date().toISOString().slice(0, 10)
            ? `<b style="color:var(--danger)">${UI.esc(UI.date(b.expiry_date))}</b>` : UI.esc(UI.date(b.expiry_date)) },
          { label: 'Available', num: true, render: (b) => UI.num(b.qty_available) },
          { label: 'MRP', num: true, render: (b) => money(b.mrp) },
          { label: 'Cost', num: true, render: (b) => money(b.purchase_price) },
          { label: 'Barcode', render: (b) => b.barcode ? `<code>${UI.esc(b.barcode)}</code>`
            : `<button class="btn ghost sm" data-label="${b.id}">Print a label</button>` },
        ], data.batches, { emptyText: 'No batch on file.' })}

        <h4 class="mt">Movements</h4>
        ${UI.table([
          { label: 'When', render: (m) => UI.esc(UI.dateTime(m.created_at)) },
          { label: 'Movement', render: (m) => UI.badge(kinds[m.txn_type] || m.txn_type,
            m.qty_delta > 0 ? 'ok' : 'orange') },
          { label: 'Batch', render: (m) => UI.esc(m.batch_no || '—') },
          { label: 'Qty', num: true, render: (m) => `<b style="color:${m.qty_delta > 0 ? 'var(--ok)' : 'var(--danger)'}">` +
            `${m.qty_delta > 0 ? '+' : ''}${UI.num(m.qty_delta)}</b>` },
          { label: 'Balance', num: true, render: (m) => UI.num(m.balance_after) },
          { label: 'Note', render: (m) => UI.esc(m.notes || '') },
          { label: 'By', render: (m) => UI.esc(m.by_name || 'system') },
        ], data.movements, { emptyText: 'No movement in this period.' })}`,
      footer: `<button class="btn ghost" data-act="print">Print all labels</button>
        <button class="btn ghost" data-act="__close">Close</button>`,
      onMount(modal) {
        modal.querySelectorAll('[data-label]').forEach((b) => b.addEventListener('click', async () => {
          const batch = await API.post(`/api/stock/barcodes/batch/${b.dataset.label}`, {});
          openLabelDialog([batch], 'batch', 'Batch label');
          UI.closeAllModals();
          openMovements(drugId, range);
        }));
      },
      async onAction(act) {
        if (act === 'link') {
          const code = prompt('Scan or type the barcode printed on the pack:');
          if (!code) return 'keep';
          await API.post(`/api/stock/barcodes/drug/${drugId}`, { barcode: code.trim() });
          UI.ok('Barcode linked.');
          UI.closeAllModals();
          openMovements(drugId, range);
          return;
        }
        if (act === 'print') {
          const ids = data.batches.map((b) => b.id).join(',');
          if (!ids) return 'keep';
          openLabelDialog(await API.get('/api/stock/labels' + API.qs({ batchIds: ids })), 'batch', 'Batch labels');
          return 'keep';
        }
      },
    });
  }

  // ------------------------------------------------------------ stock take
  async function stocktake(body) {
    body.innerHTML = `
      <div class="grid sidebar-right">
        <div class="card"><div class="card-head"><h3>Physical count</h3>
          <input type="search" id="st-q" placeholder="Filter the sheet…" style="max-width:220px"></div>
          <div class="card-body">
            <div id="st-scan" class="mb"></div>
            <div id="st-sheet">${UI.loading()}</div>
          </div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>Post the count</h3></div>
            <div class="card-body">
              <div id="st-summary" class="mb"></div>
              <form id="st-form">${UI.field({ name: 'notes', label: 'Notes', rows: 3,
                placeholder: 'Monthly count, shelf A–D' })}</form>
              <button class="btn block" id="st-save" ${isPharmacist() ? '' : 'disabled'}>Post the stock take</button>
            </div>
          </div>
          <div class="card"><div class="card-head"><h3>Past counts</h3></div>
            <div class="card-body tight" id="st-past">${UI.loading()}</div></div>
        </div>
      </div>`;

    let sheet = [];
    const counts = {};   // batchId -> counted quantity
    const reasons = {};  // batchId -> reason for a difference

    const summarise = () => {
      const counted = Object.keys(counts).length;
      const variances = Object.entries(counts).filter(([id, v]) => {
        const row = sheet.find((r) => String(r.batch_id) === String(id));
        return row && Number(v) !== row.book_qty;
      });
      body.querySelector('#st-summary').innerHTML = `
        <div class="row-between"><span>Batches counted</span><b>${UI.num(counted)}</b></div>
        <div class="row-between"><span>Differences</span>
          <b style="color:${variances.length ? 'var(--danger)' : 'var(--ok)'}">${UI.num(variances.length)}</b></div>
        ${variances.length ? '<div class="alert warn mt">Give a reason for each difference — it is written to the ledger.</div>' : ''}`;
    };

    const drawSheet = () => {
      body.querySelector('#st-sheet').innerHTML = UI.table([
        { label: 'Medicine', render: (r) => `<b>${UI.esc(r.drug_name)}</b>` +
          `<div class="muted small">${UI.esc(r.strength || '')} ${UI.esc(r.form || '')}` +
          `${r.barcode ? ` · ${UI.esc(r.barcode)}` : ''}</div>` },
        { label: 'Batch', render: (r) => `${UI.esc(r.batch_no)}<div class="muted small">Exp ${UI.esc(UI.date(r.expiry_date))}</div>` },
        { label: 'Book', num: true, render: (r) => UI.num(r.book_qty) },
        { label: 'Counted', num: true, render: (r) =>
          `<input type="number" min="0" step="any" style="width:88px;text-align:right"
            data-count="${r.batch_id}" value="${counts[r.batch_id] === undefined ? '' : counts[r.batch_id]}">` },
        { label: 'Difference', num: true, render: (r) => {
          if (counts[r.batch_id] === undefined) return '—';
          const diff = Number(counts[r.batch_id]) - r.book_qty;
          if (!diff) return UI.badge('Matches', 'ok');
          return `<b style="color:var(--danger)">${diff > 0 ? '+' : ''}${UI.num(diff)}</b>`;
        } },
        { label: 'Reason', render: (r) => (counts[r.batch_id] !== undefined
            && Number(counts[r.batch_id]) !== r.book_qty)
          ? `<input type="text" data-reason="${r.batch_id}" placeholder="damaged / miscount / theft"
              value="${UI.esc(reasons[r.batch_id] || '')}" style="width:150px">`
          : '' },
      ], sheet, { emptyText: 'Nothing on the shelf to count.' });

      body.querySelectorAll('[data-count]').forEach((inp) => inp.addEventListener('change', () => {
        const id = inp.dataset.count;
        if (inp.value === '') delete counts[id];
        else counts[id] = Number(inp.value);
        // `change` fires while the input is losing focus, so redrawing the sheet
        // synchronously would tear the node out from under the blur. Let the
        // browser finish first.
        setTimeout(() => { drawSheet(); summarise(); }, 0);
      }));
      body.querySelectorAll('[data-reason]').forEach((inp) => inp.addEventListener('input', () => {
        reasons[inp.dataset.reason] = inp.value;
      }));
    };

    const loadSheet = async () => {
      sheet = await API.get('/api/stock/takes/new/sheet' + API.qs({ q: body.querySelector('#st-q').value.trim() }));
      drawSheet();
      summarise();
    };

    // Scanning a batch label jumps straight to its count box.
    scanBox(body.querySelector('#st-scan'), {
      placeholder: 'Scan a batch label to count it…',
      onHit: (hit, out) => {
        if (hit.match !== 'batch') {
          out.innerHTML = `<div class="alert warn">${UI.esc(hit.drug.name)} has no batch label on that code —
            scan the label printed for the batch you are counting.</div>`;
          return;
        }
        const input = body.querySelector(`[data-count="${hit.batch.id}"]`);
        if (!input) {
          out.innerHTML = '<div class="alert warn">That batch is not on the current sheet — clear the filter.</div>';
          return;
        }
        input.focus();
        input.select();
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    });

    let t;
    body.querySelector('#st-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadSheet, 220); });

    body.querySelector('#st-save').addEventListener('click', async () => {
      const items = Object.entries(counts).map(([batchId, countedQty]) =>
        ({ batchId: Number(batchId), countedQty, reason: reasons[batchId] || null }));
      if (!items.length) return UI.err('Count at least one batch first.');
      const missing = items.filter((i) => {
        const row = sheet.find((r) => r.batch_id === i.batchId);
        return row && Number(i.countedQty) !== row.book_qty && !i.reason;
      });
      if (missing.length) return UI.err('Give a reason for every difference.');
      if (!await UI.confirm(`Post ${items.length} counted batch(es)? Differences are adjusted on the shelf immediately.`,
        { title: 'Post the stock take' })) return;
      const take = await API.post('/api/stock/takes', { items, ...UI.formValues(body.querySelector('#st-form')) });
      UI.ok(`Stock take ${take.reference} posted — ${take.variances} difference(s).`);
      Object.keys(counts).forEach((k) => delete counts[k]);
      Object.keys(reasons).forEach((k) => delete reasons[k]);
      await loadSheet();
      await loadPast();
    });

    const loadPast = async () => {
      const rows = await API.get('/api/stock/takes?limit=15');
      body.querySelector('#st-past').innerHTML = UI.table([
        { label: 'Reference', render: (r) => `<code>${UI.esc(r.reference)}</code>` },
        { label: 'When', render: (r) => UI.esc(UI.dateTime(r.counted_at)) },
        { label: 'Lines', num: true, render: (r) => UI.num(r.lines) },
        { label: 'Diffs', num: true, render: (r) => r.variances
          ? `<b style="color:var(--danger)">${UI.num(r.variances)}</b>` : UI.badge('Clean', 'ok') },
      ], rows, { emptyText: 'No stock take posted yet.' });
    };

    await Promise.all([loadSheet(), loadPast()]);
  }

  window.StockUI = { barcodes, purchases, register, stocktake, scanBox, printLabels, openLabelDialog, openMovements, openGrn };
})();
