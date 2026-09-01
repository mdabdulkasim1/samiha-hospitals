/* Pharmacy: dispensing queue, stock, and the drug formulary. */
(function () {
  'use strict';

  APP.register('pharmacy', {
    title: 'Pharmacy',
    subtitle: 'Dispensing, stock and formulary',

    async render(el, params) {
      if (params.visitId) return renderDispense(el, Number(params.visitId));

      const [queue, alerts] = await Promise.all([
        API.get('/api/pharmacy/queue'),
        API.get('/api/pharmacy/stock/alerts'),
      ]);

      el.innerHTML = `
        <div class="grid c3 mb">
          <div class="stat crimson"><div class="label">Waiting to be dispensed</div>
            <div class="value">${UI.num(queue.length)}</div><div class="foot">Prescriptions from today</div></div>
          <div class="stat orange"><div class="label">At or below reorder level</div>
            <div class="value">${UI.num(alerts.lowStock.length)}</div><div class="foot">Raise a purchase order</div></div>
          <div class="stat teal"><div class="label">Expiring within 90 days</div>
            <div class="value">${UI.num(alerts.expiringSoon.length)}</div><div class="foot">Batches to rotate</div></div>
        </div>

        <div class="tabs" id="ph-tabs">
          <button class="active" data-tab="queue">Dispensing queue</button>
          <button data-tab="counter">Counter sale</button>
          <button data-tab="sales">Bills</button>
          <button data-tab="stock">Stock &amp; alerts</button>
          <button data-tab="barcodes">Barcodes</button>
          <button data-tab="purchases">Purchases</button>
          <button data-tab="register">Stock register</button>
          <button data-tab="stocktake">Stock take</button>
          <button data-tab="formulary">Formulary</button>
        </div>
        <div id="ph-body"></div>`;

      const body = el.querySelector('#ph-body');

      const tabs = {
        /**
         * Over-the-counter sale to a walk-in who is not our patient: no visit,
         * no file, no clinic invoice — just a bill settled at the counter.
         */
        async counter() {
          const drugs = await API.get('/api/pharmacy/drugs?limit=400');
          const cart = [];

          body.innerHTML = `
            <div class="grid sidebar-right">
              <div class="card">
                <div class="card-head"><h3>Counter sale</h3>
                  <span class="muted small">For anyone buying medicines — they need not be our patient</span></div>
                <div class="card-body">
                  <div class="search-row">
                    <input type="search" id="cs-scan" placeholder="Scan the barcode on the pack…" autofocus>
                    <input type="search" id="cs-q" placeholder="…or search by name">
                  </div>
                  <div id="cs-scan-out"></div>
                  <div id="cs-results"></div>
                  <div id="cs-cart" class="mt"></div>
                </div>
              </div>

              <div>
                <div class="card"><div class="card-head"><h3>Customer</h3></div>
                  <div class="card-body">
                    <form id="cs-form">
                      ${UI.field({ name: 'customerName', label: 'Name', placeholder: 'Optional, but useful on the bill' })}
                      ${UI.field({ name: 'customerPhone', label: 'Mobile' })}
                      ${UI.field({ name: 'rxReference', label: 'Outside prescription',
                        placeholder: 'Doctor and date, e.g. Dr A. Rahman, 28.08.2026',
                        hint: 'Required for Schedule H medicines' })}
                    </form>
                  </div>
                </div>

                <div class="card"><div class="card-head"><h3>Payment</h3></div>
                  <div class="card-body">
                    <div id="cs-total" class="mb"></div>
                    <form id="cs-pay">
                      ${UI.field({ name: 'discount', label: 'Discount', type: 'number', step: '0.01', value: 0 })}
                      ${UI.field({ name: 'paymentMode', label: 'Paid by', value: 'cash',
                        options: ['cash', 'upi', 'card', 'netbanking'].map((m) => ({ value: m, label: UI.titleise(m) })) })}
                      ${UI.field({ name: 'paidAmount', label: 'Amount received', type: 'number', step: '0.01',
                        hint: 'Leave blank to record the bill as paid in full' })}
                      ${UI.field({ name: 'paymentReference', label: 'Reference' })}
                      <button class="btn block" type="submit" id="cs-save" disabled>Complete sale</button>
                    </form>
                    <div id="cs-out"></div>
                  </div>
                </div>
              </div>
            </div>`;

          const drawCart = () => {
            const host = body.querySelector('#cs-cart');
            if (!cart.length) {
              host.innerHTML = UI.empty('Nothing on the bill yet — search for a medicine above.', '🧾');
              body.querySelector('#cs-total').innerHTML = '';
              body.querySelector('#cs-save').disabled = true;
              return;
            }
            host.innerHTML = UI.table([
              { label: 'Medicine', render: (c) => `<b>${UI.esc(c.name)}</b>` +
                `<div class="muted small">${UI.esc(c.strength || '')} ${UI.esc(c.form || '')}` +
                `${['H', 'H1', 'X'].includes(String(c.schedule_type || '').toUpperCase())
                    ? ' · ' + UI.badge('Schedule ' + c.schedule_type + ' — prescription only', 'warn')
                    : ''}</div>` },
              { label: 'MRP', num: true, render: (c) => UI.money(c.mrp) },
              { label: 'Qty', num: true, render: (c, i) =>
                `<input type="number" min="1" max="${c.on_hand}" value="${c.qty}" data-qty="${i}" style="width:74px;text-align:right">` },
              { label: 'Stock', num: true, render: (c) => UI.esc(c.on_hand) },
              { label: 'Amount', num: true, render: (c) => UI.money(c.qty * c.mrp * (1 + (c.tax_pct || 0) / 100)) },
              { label: '', render: (c, i) => `<button class="btn ghost sm" data-rm="${i}">×</button>` },
            ], cart);

            host.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('change', () => {
              const i = Number(inp.dataset.qty);
              cart[i].qty = Math.max(1, Math.min(Number(inp.value) || 1, cart[i].on_hand));
              drawCart();
            }));
            host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
              cart.splice(Number(b.dataset.rm), 1); drawCart();
            }));

            const gross = cart.reduce((s2, c) => s2 + c.qty * c.mrp, 0);
            const tax = cart.reduce((s2, c) => s2 + c.qty * c.mrp * ((c.tax_pct || 0) / 100), 0);
            const discount = Number(body.querySelector('[name=discount]').value || 0);
            const net = Math.max(gross + tax - discount, 0);
            const scheduled = cart.filter((c) => ['H', 'H1', 'X'].includes(String(c.schedule_type || '').toUpperCase()));

            body.querySelector('#cs-total').innerHTML = `
              <div class="row-between"><span>Gross</span><b>${UI.money(gross)}</b></div>
              <div class="row-between"><span>Tax</span><span>${UI.money(tax)}</span></div>
              ${discount ? `<div class="row-between"><span>Discount</span><span>− ${UI.money(discount)}</span></div>` : ''}
              <div class="row-between" style="font-size:17px;border-top:1px solid var(--line);margin-top:6px;padding-top:8px">
                <b>To pay</b><b>${UI.money(net)}</b></div>
              ${scheduled.length ? `<div class="alert warn mt">
                ${UI.esc(scheduled.map((c) => c.name).join(', '))} ${scheduled.length > 1 ? 'are' : 'is'}
                prescription-only. Record the outside prescription before completing the sale.</div>` : ''}`;
            body.querySelector('#cs-save').disabled = false;
          };

          /** Add a medicine to the bill, respecting what is actually in stock. */
          const addToCart = (drug) => {
            const existing = cart.find((c) => c.id === drug.id);
            if (existing) existing.qty = Math.min(existing.qty + 1, drug.on_hand);
            else cart.push({ ...drug, qty: 1 });
            drawCart();
          };

          // A barcode gun types the code and presses Enter, so Enter is the
          // whole interaction: scan, and the medicine drops onto the bill.
          const scanInput = body.querySelector('#cs-scan');
          const scanOut = body.querySelector('#cs-scan-out');
          scanInput.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const code = scanInput.value.trim();
            if (!code) return;
            try {
              const hit = await API.get('/api/stock/scan' + API.qs({ code }));
              if (hit.expired) throw new Error(`That batch expired on ${UI.date(hit.batch.expiry_date)} — pull it off the shelf.`);
              if (hit.onHand <= 0) throw new Error(`${hit.drug.name} is out of stock.`);
              const master = drugs.find((d) => d.id === hit.drug.id)
                || { ...hit.drug, on_hand: hit.onHand };
              master.on_hand = hit.onHand;
              addToCart(master);
              scanOut.innerHTML = `<div class="muted small">Added ${UI.esc(hit.drug.name)} ` +
                `${UI.esc(hit.drug.strength || '')}${hit.match === 'batch'
                  ? ` (batch ${UI.esc(hit.batch.batch_no)})` : ''}.</div>`;
            } catch (err) {
              scanOut.innerHTML = `<div class="alert danger">${UI.esc(err.message)}</div>`;
            }
            scanInput.value = '';
            scanInput.focus();
          });

          let t;
          body.querySelector('#cs-q').addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(() => {
              const q = e.target.value.trim().toLowerCase();
              const host = body.querySelector('#cs-results');
              if (q.length < 2) return void (host.innerHTML = '');
              const hits = drugs.filter((d) => `${d.name} ${d.generic_name || ''} ${d.code}`.toLowerCase().includes(q))
                .slice(0, 8);
              host.innerHTML = hits.length ? hits.map((d) => `
                <button type="button" class="btn ghost sm block mb" data-add="${d.id}"
                  style="justify-content:space-between"${d.on_hand <= 0 ? ' disabled' : ''}>
                  <span>${UI.esc(d.name)} ${UI.esc(d.strength || '')}
                    ${['H', 'H1', 'X'].includes(String(d.schedule_type || '').toUpperCase())
                      ? `<span class="badge warn">Sch ${UI.esc(d.schedule_type)}</span>` : ''}</span>
                  <span>${UI.money(d.mrp)} · ${d.on_hand <= 0 ? 'out of stock' : `${d.on_hand} in stock`}</span>
                </button>`).join('') : '<div class="muted small">No medicine matched.</div>';

              host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
                addToCart(drugs.find((d) => d.id === Number(b.dataset.add)));
                body.querySelector('#cs-q').value = '';
                host.innerHTML = '';
              }));
            }, 200);
          });

          body.querySelector('[name=discount]').addEventListener('input', drawCart);

          body.querySelector('#cs-pay').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = body.querySelector('#cs-save');
            btn.disabled = true;
            const payload = {
              ...UI.formValues(body.querySelector('#cs-form')),
              ...UI.formValues(body.querySelector('#cs-pay')),
              items: cart.map((c) => ({ drugId: c.id, qty: c.qty })),
            };
            try {
              const res = await API.post('/api/pharmacy/counter-sale', payload);
              body.querySelector('#cs-out').innerHTML = `<div class="alert ok mt">
                <b>Bill ${UI.esc(res.sale.bill_no)}</b> — ${UI.money(res.sale.net)}
                ${res.balance > 0 ? `· <b style="color:var(--danger)">${UI.money(res.balance)} still due</b>` : '· paid in full'}
                <div class="mt"><button class="btn sm" id="cs-print">Print the bill</button></div></div>`;
              UI.ok('Sale completed.');
              body.querySelector('#cs-print').addEventListener('click', () => printCounterBill(res));
              cart.length = 0;
              drawCart();
              body.querySelector('#cs-form').reset();
              body.querySelector('#cs-pay').reset();
            } catch (err) {
              body.querySelector('#cs-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
              btn.disabled = false;
            }
          });

          drawCart();
        },

        async sales() {
          const data = await API.get('/api/pharmacy/sales?limit=80');
          body.innerHTML = `
            <div class="grid c3 mb">
              <div class="stat teal"><div class="label">Prescription bills today</div>
                <div class="value">${UI.num(data.today.prescription.bills)}</div>
                <div class="foot">${UI.money(data.today.prescription.total)}</div></div>
              <div class="stat orange"><div class="label">Counter sales today</div>
                <div class="value">${UI.num(data.today.counter.bills)}</div>
                <div class="foot">${UI.money(data.today.counter.total)}</div></div>
              <div class="stat ok"><div class="label">Taken today</div>
                <div class="value">${UI.money(data.today.prescription.total + data.today.counter.total)}</div></div>
            </div>
            <div class="card"><div class="card-head"><h3>Pharmacy bills</h3></div>
              <div class="card-body tight">${UI.table([
                { label: 'Bill', render: (r) => `<code>${UI.esc(r.bill_no)}</code>` },
                { label: 'Type', render: (r) => r.sale_type === 'counter'
                  ? UI.badge('Counter', 'orange') : UI.badge('Prescription', 'teal') },
                { label: 'For', render: (r) => r.patient_name
                  ? `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>`
                  : `${UI.esc(r.customer_name || 'Walk-in')}<div class="muted small">${UI.esc(r.customer_phone || '')}</div>` },
                { label: 'Items', num: true, render: (r) => UI.esc(r.item_count) },
                { label: 'Net', num: true, render: (r) => UI.money(r.net) },
                { label: 'Paid', num: true, render: (r) => r.sale_type === 'counter'
                  ? UI.money(r.paid_amount) : UI.badge('On the visit bill', 'teal') },
                { label: 'By', render: (r) => UI.esc(r.by_name || '') },
                { label: 'When', render: (r) => UI.esc(UI.dateTime(r.created_at)) },
              ], data.rows, { emptyText: 'No pharmacy bills yet.' })}</div></div>`;
        },

        queue() {
          body.innerHTML = `<div class="card"><div class="card-head"><h3>Prescriptions to dispense</h3></div>
            <div class="card-body tight" id="q-list"></div></div>`;
          const host = body.querySelector('#q-list');
          host.innerHTML = UI.table([
            { label: 'Token', render: (r) => `<span class="badge crimson">#${UI.esc(r.token_no || '—')}</span>` },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
            { label: 'Visit', key: 'visit_no' },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_name || '—') },
            { label: 'Items', num: true, render: (r) => UI.esc(r.pending_items) },
            { label: 'Flags', render: (r) => r.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
            { label: '', render: (r) => `<button class="btn sm" data-open="${r.visit_id}">Dispense</button>` },
          ], queue, { emptyText: 'Nothing waiting at the pharmacy counter.' });
          host.querySelectorAll('[data-open]').forEach((b) =>
            b.addEventListener('click', () => APP.navigate('pharmacy', { visitId: b.dataset.open })));
        },

        stock() {
          body.innerHTML = `
            <div class="grid c2">
              <div class="card"><div class="card-head"><h3>Low stock</h3>
                ${APP.can(['pharmacy']) ? '<button class="btn ghost sm" id="receive">+ Quick receive</button>' +
                  '<button class="btn sm" id="grn">+ Goods received</button>' : ''}</div>
                <div class="card-body tight">${UI.table([
                  { label: 'Medicine', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.strength || '')} ${UI.esc(d.form || '')}</div>` },
                  { label: 'On hand', num: true, render: (d) => `<b style="color:var(--danger)">${UI.esc(d.on_hand)}</b>` },
                  { label: 'Reorder at', num: true, render: (d) => UI.esc(d.reorder_level) },
                ], alerts.lowStock, { emptyText: 'All medicines are above their reorder level.' })}</div>
              </div>
              <div class="card"><div class="card-head"><h3>Expiring soon</h3></div>
                <div class="card-body tight">${UI.table([
                  { label: 'Medicine', render: (b) => `<b>${UI.esc(b.drug_name)}</b><div class="muted small">Batch ${UI.esc(b.batch_no)}</div>` },
                  { label: 'Expiry', render: (b) => UI.esc(UI.date(b.expiry_date)) },
                  { label: 'Qty', num: true, render: (b) => UI.esc(b.qty_available) },
                ], alerts.expiringSoon, { emptyText: 'No batch expires within 90 days.' })}</div>
              </div>
            </div>`;
          const rec = body.querySelector('#receive');
          if (rec) rec.addEventListener('click', openReceive);
          const grn = body.querySelector('#grn');
          if (grn) grn.addEventListener('click', () => StockUI.openGrn(() => APP.reload()));
        },

        // The purchase side of the pharmacy lives in its own module — see
        // views/stock.js — but reads as four more tabs on this screen.
        barcodes()  { return StockUI.barcodes(body); },
        purchases() { return StockUI.purchases(body); },
        register()  { return StockUI.register(body); },
        stocktake() { return StockUI.stocktake(body); },

        async formulary() {
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Drug formulary</h3>
              <input type="search" id="dq" placeholder="Search medicines…" style="max-width:260px">
              ${APP.can(['pharmacy']) ? '<button class="btn ghost sm" id="add-drug">+ Add medicine</button>' : ''}</div>
            <div class="card-body tight" id="d-list">${UI.loading()}</div></div>`;
          const load = async () => {
            const drugs = await API.get('/api/pharmacy/drugs' + API.qs({ q: body.querySelector('#dq').value.trim(), limit: 200 }));
            body.querySelector('#d-list').innerHTML = UI.table([
              { label: 'Code', render: (d) => `<code>${UI.esc(d.code)}</code>` },
              { label: 'Medicine', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.generic_name || '')}</div>` },
              { label: 'Form', render: (d) => `${UI.esc(d.strength || '')} ${UI.esc(d.form || '')}` },
              { label: 'Schedule', render: (d) => d.schedule_type ? UI.badge(d.schedule_type, d.schedule_type === 'H' ? 'warn' : '') : '—' },
              { label: 'MRP', num: true, render: (d) => UI.money(d.mrp) },
              { label: 'On hand', num: true, render: (d) => d.on_hand <= d.reorder_level
                ? `<b style="color:var(--danger)">${UI.esc(d.on_hand)}</b>` : UI.esc(d.on_hand) },
              { label: 'Next expiry', render: (d) => d.next_expiry ? UI.esc(UI.date(d.next_expiry)) : '—' },
            ], drugs, { emptyText: 'No medicine matched.' });
          };
          let t;
          body.querySelector('#dq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
          const add = body.querySelector('#add-drug');
          if (add) add.addEventListener('click', openAddDrug);
          await load();
        },
      };

      el.querySelectorAll('#ph-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#ph-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab]();
      }));
      tabs.queue();
    },
  });

  // ------------------------------------------------------------- dispensing
  async function renderDispense(el, visitId) {
    const data = await API.get(`/api/pharmacy/prescriptions/${visitId}`);
    const visit = data.visit;
    APP.setSubtitle(`${visit.patient_name} · ${visit.uhid} · ${visit.visit_no}`);
    APP.actions([{ id: 'back', label: '← Pharmacy queue', onClick: () => APP.navigate('pharmacy') }]);

    el.innerHTML = `
      ${visit.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(visit.allergies)} — check every item before dispensing.</div>` : ''}
      <div class="card">
        <div class="card-head"><h3>Prescription</h3><span class="muted small">Tick what you are handing over</span></div>
        <div class="card-body tight">
          <div class="table-wrap"><table><thead><tr>
            <th></th><th>Medicine</th><th>Dose &amp; frequency</th><th class="num">Prescribed</th>
            <th class="num">Already given</th><th class="num">Dispense now</th><th class="num">Stock</th><th>Status</th>
          </tr></thead><tbody>
            ${data.prescriptions.map((p) => {
              const remaining = Math.max((p.quantity || 0) - (p.dispensed_qty || 0), 0);
              const canGive = p.drug_id && remaining > 0 && p.on_hand > 0;
              return `<tr>
                <td><input type="checkbox" data-rx="${p.id}" data-drug="${p.drug_id || ''}"${canGive ? ' checked' : ' disabled'}></td>
                <td><b>${UI.esc(p.drug_name)}</b><div class="muted small">${UI.esc(p.master_name ? p.strength || '' : 'not in formulary')}</div></td>
                <td>${UI.esc(p.dose || '')} ${UI.esc(p.frequency || '')} · ${UI.esc(p.duration_days || '?')} days
                  ${p.instructions ? `<div class="muted small">${UI.esc(p.instructions)}</div>` : ''}</td>
                <td class="num">${UI.esc(p.quantity || 0)}</td>
                <td class="num">${UI.esc(p.dispensed_qty || 0)}</td>
                <td class="num"><input type="number" data-qty="${p.id}" value="${canGive ? Math.min(remaining, p.on_hand) : 0}"
                  min="0" max="${Math.min(remaining, p.on_hand)}" style="width:80px;text-align:right"${canGive ? '' : ' disabled'}></td>
                <td class="num">${p.on_hand <= 0 ? '<b style="color:var(--danger)">0</b>' : UI.esc(p.on_hand)}</td>
                <td>${UI.statusBadge(p.status)}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="8">' + UI.empty('No prescription for this visit.', '💊') + '</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card-body">
          <div class="grid c3">
            ${UI.field({ name: 'discount', label: 'Discount on this bill', type: 'number', min: 0, value: 0 })}
            <div></div>
            <div style="display:flex;align-items:flex-end">
              <button class="btn block" id="do-dispense">Dispense &amp; bill</button>
            </div>
          </div>
          <div id="disp-out"></div>
        </div>
      </div>`;

    el.querySelector('#do-dispense').addEventListener('click', async (e) => {
      const items = [...el.querySelectorAll('[data-rx]:checked')].map((cb) => {
        const id = cb.dataset.rx;
        return {
          prescriptionId: Number(id),
          drugId: Number(cb.dataset.drug),
          qty: Number(el.querySelector(`[data-qty="${id}"]`).value),
        };
      }).filter((i) => i.qty > 0 && i.drugId);

      if (!items.length) return UI.err('Select at least one medicine with a quantity.');

      e.target.disabled = true;
      const send = async (acknowledge) => API.post('/api/pharmacy/dispense', {
        patientId: visit.patient_id, visitId,
        discount: Number(el.querySelector('[name=discount]').value || 0),
        items, acknowledgeWarnings: acknowledge,
      });

      try {
        let res;
        try {
          res = await send(false);
        } catch (err) {
          if (err.status === 409 && /Safety check/.test(err.message)) {
            if (!(await UI.confirm(err.message, { title: 'Safety check', danger: true }))) { e.target.disabled = false; return; }
            res = await send(true);
          } else throw err;
        }
        el.querySelector('#disp-out').innerHTML = `<div class="alert ok mt">
          <b>Dispensed.</b> Bill ${UI.esc(res.sale.bill_no)} for ${UI.money(res.sale.net)} added to invoice
          ${UI.esc(res.invoice.invoice_no)} (balance ${UI.money(res.invoice.balance)}).</div>`;
        UI.ok('Medicines dispensed and added to the bill.');
        setTimeout(() => APP.navigate('pharmacy'), 1600);
      } catch (err) {
        UI.err(err.message);
        e.target.disabled = false;
      }
    });
  }

  /** A counter bill for a walk-in, printable on the spot. */
  function printCounterBill(res) {
    const s = res.sale;
    const html = `<div class="doc">
      ${UI.docHeader('Pharmacy Bill', [`Bill: ${s.bill_no}`, `Date: ${UI.dateTime(s.created_at)}`,
        'Counter sale'])}
      <table><tbody>
        <tr><th>Customer</th><td>${UI.esc(s.customer_name || 'Walk-in')}</td>
            <th>Mobile</th><td>${UI.esc(s.customer_phone || '—')}</td></tr>
        ${s.rx_reference ? `<tr><th>Prescription</th><td colspan="3">${UI.esc(s.rx_reference)}</td></tr>` : ''}
      </tbody></table>
      <table class="mt"><thead><tr><th>#</th><th>Medicine</th><th>Batch</th><th>Expiry</th>
        <th class="num">Qty</th><th class="num">MRP</th><th class="num">Amount</th></tr></thead><tbody>
        ${res.items.map((i, n) => `<tr><td>${n + 1}</td><td>${UI.esc(i.drug_name)}</td>
          <td>${UI.esc(i.batch_no || '')}</td><td>${i.expiry_date ? UI.esc(UI.date(i.expiry_date)) : ''}</td>
          <td class="num">${UI.esc(i.qty)}</td><td class="num">${UI.money(i.mrp)}</td>
          <td class="num">${UI.money(i.amount)}</td></tr>`).join('')}
      </tbody></table>
      <div class="totals">
        <div class="line"><span>Gross</span><span>${UI.money(s.gross)}</span></div>
        ${s.discount ? `<div class="line"><span>Discount</span><span>− ${UI.money(s.discount)}</span></div>` : ''}
        <div class="line"><span>Tax</span><span>${UI.money(s.tax)}</span></div>
        <div class="line grand"><span>Total</span><span>${UI.money(s.net)}</span></div>
        <div class="line"><span>Paid (${UI.esc(UI.titleise(s.payment_mode || 'cash'))})</span><span>${UI.money(s.paid_amount)}</span></div>
        ${res.balance > 0 ? `<div class="line"><span>Balance</span><span>${UI.money(res.balance)}</span></div>` : ''}
      </div>
      <div class="sign"><div>Customer</div><div>For ${UI.esc(APP.clinic.name)}<br>Pharmacist</div></div>
      <div class="foot-note">Medicines once sold are not taken back. Please check the expiry date before use.
        Keep out of reach of children.</div>
    </div>`;
    UI.print(html, 'Pharmacy bill ' + s.bill_no);
  }

  function openReceive() {
    API.get('/api/pharmacy/drugs?limit=300').then((drugs) => {
      UI.modal({
        title: 'Receive stock',
        body: `<form id="rc-form">
          ${UI.field({ name: 'drugId', label: 'Medicine', required: true,
            options: [{ value: '', label: '— select —' }].concat(drugs.map((d) =>
              ({ value: d.id, label: `${d.name} ${d.strength || ''} — on hand ${d.on_hand}` }))) })}
          <div class="grid c2">
            ${UI.field({ name: 'batchNo', label: 'Batch number', required: true })}
            ${UI.field({ name: 'expiryDate', label: 'Expiry date', type: 'date', required: true })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', min: 1, required: true })}
            ${UI.field({ name: 'mrp', label: 'MRP per unit', type: 'number', step: '0.01' })}
            ${UI.field({ name: 'purchasePrice', label: 'Cost per unit', type: 'number', step: '0.01' })}
          </div>
          ${UI.field({ name: 'supplier', label: 'Supplier' })}
        </form>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Receive</button>`,
        async onAction(act, modal) {
          if (act !== 'save') return;
          const form = modal.querySelector('#rc-form');
          if (!form.reportValidity()) return 'keep';
          await API.post('/api/pharmacy/stock/receive', UI.formValues(form));
          UI.ok('Stock received.');
          APP.reload();
        },
      });
    });
  }

  function openAddDrug() {
    UI.modal({
      title: 'Add a medicine to the formulary',
      body: `<form id="ad-form">
        <div class="grid c2">
          ${UI.field({ name: 'code', label: 'Code', required: true })}
          ${UI.field({ name: 'name', label: 'Brand name', required: true })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'genericName', label: 'Generic name' })}
          ${UI.field({ name: 'form', label: 'Form', options: ['tablet','capsule','syrup','injection','ointment','drops','sachet','inhaler'] })}
          ${UI.field({ name: 'strength', label: 'Strength' })}
        </div>
        <div class="grid c4">
          ${UI.field({ name: 'mrp', label: 'MRP', type: 'number', step: '0.01' })}
          ${UI.field({ name: 'purchasePrice', label: 'Cost', type: 'number', step: '0.01' })}
          ${UI.field({ name: 'taxPct', label: 'GST %', type: 'number', value: 12 })}
          ${UI.field({ name: 'reorderLevel', label: 'Reorder level', type: 'number', value: 20 })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'manufacturer', label: 'Manufacturer' })}
          ${UI.field({ name: 'scheduleType', label: 'Schedule', options: ['', 'OTC', 'H', 'H1', 'X'] })}
        </div>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Add</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#ad-form');
        if (!form.reportValidity()) return 'keep';
        await API.post('/api/pharmacy/drugs', UI.formValues(form));
        UI.ok('Medicine added to the formulary.');
        APP.reload();
      },
    });
  }
})();
