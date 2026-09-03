/* Pharmacy: dispensing queue, stock, and the drug formulary. */
(function () {
  'use strict';

  /**
   * Share a discount given on the whole bill across its lines, in proportion
   * to what each costs — the same split the server does, so the total on
   * screen is the total that prints.
   *
   * It has to be split because GST is charged rate by rate: a 12% medicine and
   * a 5% one cannot have one lump taken off the bottom. The paise left over by
   * rounding go on the largest line, where they cannot make a small line
   * negative, so the parts always sum to the whole.
   */
  /**
   * What a quantity of one medicine comes to, taken out of the batches in the
   * order the counter will actually take them — earliest expiry first.
   *
   * A sale can straddle two packs bought at different prices, and the customer
   * pays what is printed on each. Pricing from the drug's own MRP instead
   * would quote one figure and print another.
   */
  function priceLine(drug, qty) {
    const batches = (drug.batches || []).slice();
    let left = qty;
    let total = 0;
    for (const b of batches) {
      if (left <= 0) break;
      const take = Math.min(left, b.qty);
      total += take * (b.mrp || drug.mrp || 0);
      left -= take;
    }
    // Anything beyond what is in stock is priced at the list rate; the server
    // will refuse the sale, and the till should not pretend it is free.
    if (left > 0) total += left * (drug.sale_mrp || drug.mrp || 0);
    return UI.round2(total);
  }

  function apportion(lineTotals, discount) {
    const total = UI.round2(lineTotals.reduce((a, n) => a + n, 0));
    const want = UI.round2(Math.min(Math.max(Number(discount) || 0, 0), total));
    if (!want || !total) return lineTotals.map(() => 0);
    const parts = lineTotals.map((n) => UI.round2((n / total) * want));
    const drift = UI.round2(want - parts.reduce((a, n) => a + n, 0));
    if (drift) {
      let biggest = 0;
      for (let i = 1; i < lineTotals.length; i += 1) {
        if (lineTotals[i] > lineTotals[biggest]) biggest = i;
      }
      parts[biggest] = UI.round2(parts[biggest] + drift);
    }
    return parts;
  }

  /**
   * The discount, offered both ways because a counter thinks in both — "give
   * him twenty rupees off" and "ten percent for staff" — and recorded as
   * rupees whichever way it was entered, so the bill says what was actually
   * given rather than a percentage that would drift if a line changed.
   */
  function discountFields(value = 0) {
    return `
      <div class="grid c2">
        ${UI.field({ name: 'discountMode', label: 'Discount', value: 'amount',
          options: [{ value: 'amount', label: 'Rupees off' }, { value: 'pct', label: 'A percentage' }] })}
        ${UI.field({ name: 'discountValue', label: 'How much', type: 'number',
          step: '0.01', min: '0', value })}
      </div>`;
  }

  /** What those two boxes come to in rupees, against this bill's MRP total. */
  function discountAsked(scope, mrpTotal) {
    const mode = scope.querySelector('[name=discountMode]');
    const box = scope.querySelector('[name=discountValue]');
    if (!box) return 0;
    const v = Math.max(Number(box.value) || 0, 0);
    // A percentage over a hundred is a typo, not a giveaway. It is left as
    // typed so the total says the discount is more than the bill and the
    // button refuses, rather than quietly making the medicines free.
    if (mode && mode.value === 'pct') return UI.round2(mrpTotal * (v / 100));
    return UI.round2(v);
  }

  /**
   * What the patient pays, worked out the way the bill works it out.
   *
   * MRP already contains the GST, so the tax is extracted from the price
   * rather than added to it, and the discount comes off before the extraction
   * — a discount shown on an invoice reduces the value the tax is charged on,
   * which is what section 15(3)(a) of the CGST Act requires. Only a thermal
   * cash bill settles to the rupee; a prescription bill is paid to the paisa.
   */
  function billTotals(lines, discount, { roundToRupee = false } = {}) {
    const totals = lines.map((l) => UI.round2(l.total));
    const mrpTotal = UI.round2(totals.reduce((a, n) => a + n, 0));
    const asked = UI.round2(Math.max(discount, 0));
    const off = Math.min(asked, mrpTotal);
    const shares = apportion(totals, off);

    let taxable = 0;
    let tax = 0;
    lines.forEach((l, i) => {
      const rate = Number(l.taxPct) || 0;
      const net = Math.max(totals[i] - shares[i], 0);
      const t = UI.round2((net * 100) / (100 + rate));
      taxable = UI.round2(taxable + t);
      tax = UI.round2(tax + UI.round2(net - t));
    });

    const payable = UI.round2(taxable + tax);
    const net = roundToRupee ? Math.round(payable) : payable;
    return { mrpTotal, asked, discount: off, taxable, tax, payable, net,
      roundOff: UI.round2(net - payable), tooMuch: asked > mrpTotal };
  }

  /** The same total, shown the same way, wherever the pharmacy bills. */
  function totalsBlock(t) {
    return `
      <div class="row-between"><span>MRP total</span><b>${UI.money(t.mrpTotal)}</b></div>
      ${t.discount ? `<div class="row-between" style="color:var(--orange-dark)">
        <span>Discount</span><span>− ${UI.money(t.discount)}</span></div>` : ''}
      <div class="row-between muted small"><span>Taxable value</span><span>${UI.money(t.taxable)}</span></div>
      <div class="row-between muted small"><span>GST included</span><span>${UI.money(t.tax)}</span></div>
      ${t.roundOff ? `<div class="row-between muted small"><span>Round off</span>
        <span>${t.roundOff > 0 ? '+' : '−'} ${UI.money(Math.abs(t.roundOff))}</span></div>` : ''}
      <div class="row-between" style="font-size:17px;border-top:1px solid var(--line);margin-top:6px;padding-top:8px">
        <b>To pay</b><b>${UI.money(t.net)}</b></div>
      ${t.tooMuch ? `<div class="alert warn mt">A discount of ${UI.money(t.asked)} is more
        than the bill. At most ${UI.money(t.mrpTotal)} can be taken off.</div>` : ''}`;
  }

  APP.register('pharmacy', {
    title: 'Pharmacy',
    subtitle: 'Dispensing, stock and formulary',

    async render(el, params) {
      if (params.visitId) return renderDispense(el, Number(params.visitId));
      // A prescription with no visit behind it — written for somebody who was
      // never booked in, or collected long after the visit closed.
      if (params.sheetId) return renderDispense(el, null, Number(params.sheetId));

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
          <button data-tab="prescriptions">Prescriptions</button>
          <button data-tab="sales">Bills</button>
          <button data-tab="stock">Stock &amp; alerts</button>
          <button data-tab="barcodes">Barcodes</button>
          <button data-tab="purchases">Purchases</button>
          <button data-tab="register">Stock register</button>
          <button data-tab="opening">Opening stock</button>
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
          // The discount in rupees, however it was entered — the percentage is
          // a way of typing it, not a thing the bill records.
          let cartDiscount = 0;

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
                      ${discountFields()}
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
              { label: 'MRP', num: true, render: (c) => UI.money(c.sale_mrp || c.mrp) },
              { label: 'Qty', num: true, render: (c, i) =>
                `<input type="number" min="1" max="${c.on_hand}" value="${c.qty}" data-qty="${i}" style="width:74px;text-align:right">` },
              { label: 'Stock', num: true, render: (c) => UI.esc(c.on_hand) },
              { label: 'Amount', num: true, render: (c) => UI.money(priceLine(c, c.qty)) },
              { label: '', render: (c, i) => `<button class="btn ghost sm" data-rm="${i}">×</button>` },
            ], cart);

            host.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('change', () => {
              const i = Number(inp.dataset.qty);
              cart[i].qty = Math.max(1, Math.min(Number(inp.value) || 1, cart[i].on_hand));
              // Redraw after the blur that delivered this event has finished,
              // or the browser is asked to remove the node it is blurring.
              setTimeout(drawCart, 0);
            }));
            host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
              cart.splice(Number(b.dataset.rm), 1); drawCart();
            }));

            // The same arithmetic the bill will use, so the figure on screen is
            // the figure that prints. A thermal cash bill settles to the rupee,
            // and the round-off is shown rather than quietly absorbed.
            const lines = cart.map((c) => ({ total: priceLine(c, c.qty), taxPct: c.tax_pct }));
            const mrpTotal = UI.round2(lines.reduce((a, l) => a + l.total, 0));
            const t = billTotals(lines, discountAsked(body, mrpTotal), { roundToRupee: true });
            const scheduled = cart.filter((c) => ['H', 'H1', 'X'].includes(String(c.schedule_type || '').toUpperCase()));

            body.querySelector('#cs-total').innerHTML = totalsBlock(t) + (scheduled.length
              ? `<div class="alert warn mt">
                  ${UI.esc(scheduled.map((c) => c.name).join(', '))} ${scheduled.length > 1 ? 'are' : 'is'}
                  prescription-only. Record the outside prescription before completing the sale.</div>`
              : '');
            // A discount bigger than the bill would be refused by the server
            // anyway; better to say so before the cashier presses the button.
            body.querySelector('#cs-save').disabled = t.tooMuch;
            cartDiscount = t.discount;
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
                  <span>${UI.money(d.sale_mrp || d.mrp)} · ${d.on_hand <= 0 ? 'out of stock' : `${d.on_hand} in stock`}</span>
                </button>`).join('') : '<div class="muted small">No medicine matched.</div>';

              host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
                addToCart(drugs.find((d) => d.id === Number(b.dataset.add)));
                body.querySelector('#cs-q').value = '';
                host.innerHTML = '';
              }));
            }, 200);
          });

          body.querySelectorAll('[name=discountValue], [name=discountMode]').forEach((f) =>
            f.addEventListener('input', drawCart));

          body.querySelector('#cs-pay').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = body.querySelector('#cs-save');
            btn.disabled = true;
            const payload = {
              ...UI.formValues(body.querySelector('#cs-form')),
              ...UI.formValues(body.querySelector('#cs-pay')),
              discount: cartDiscount,
              items: cart.map((c) => ({ drugId: c.id, qty: c.qty })),
            };
            delete payload.discountMode;
            delete payload.discountValue;
            try {
              const res = await API.post('/api/pharmacy/counter-sale', payload);
              body.querySelector('#cs-out').innerHTML = `<div class="alert ok mt">
                <b>Bill ${UI.esc(res.sale.bill_no)}</b> — ${UI.money(res.sale.net)}
                ${res.balance > 0 ? `· <b style="color:var(--danger)">${UI.money(res.balance)} still due</b>` : '· paid in full'}
                <div class="mt"><button class="btn sm" id="cs-print">Print the bill</button></div></div>`;
              UI.ok('Sale completed.');
              body.querySelector('#cs-print').addEventListener('click', () => printGstBill(res.sale.id));
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

        /**
         * Prescriptions the doctors have saved. A prescription written against
         * a visit is already in the dispensing queue; one written without a
         * visit only exists here, and this is where the counter finds it.
         */
        async prescriptions() {
          const rows = await API.get('/api/prescriptions?limit=60');
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Prescriptions from the doctors</h3>
              <span class="muted small">Newest first — open one to dispense against it</span></div>
            <div class="card-body tight" id="rx-list"></div></div>`;

          body.querySelector('#rx-list').innerHTML = UI.table([
            { label: 'Rx', render: (r) => `<code>${UI.esc(r.rx_no)}</code>` },
            { label: 'When', render: (r) => UI.esc(UI.dateTime(r.created_at)) },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b>` +
              `<div class="muted small">${UI.esc(r.uhid)} · ${UI.esc(r.age_years || '—')}` +
              `${r.age_years ? 'y' : ''} ${UI.esc(UI.titleise(r.gender || ''))}</div>` },
            { label: 'Diagnosis', render: (r) => UI.esc(r.diagnosis || '—') },
            { label: 'Medicines', render: (r) => `<div class="small">${UI.esc(r.medicines || '')}</div>` },
            { label: 'Signed', render: (r) => r.signed_at
              ? UI.badge('Signed', 'ok') : UI.badge('Not signed', '') },
            { label: '', render: (r) => `<button class="btn ghost sm" data-rx="${r.id}">Open</button>` },
          ], rows, { emptyText: 'No prescription has been written yet.' });

          body.querySelectorAll('[data-rx]').forEach((b) =>
            b.addEventListener('click', () => openPrescription(Number(b.dataset.rx))));
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
                { label: '', render: (r) => `<button class="btn ghost sm" data-bill="${r.id}">Print</button>` },
              ], data.rows, { emptyText: 'No pharmacy bills yet.' })}</div></div>`;

          // A tax invoice has to be reproducible on demand, so any bill reprints
          // exactly as it was issued.
          body.querySelectorAll('[data-bill]').forEach((b) =>
            b.addEventListener('click', () => printGstBill(Number(b.dataset.bill))));
        },

        /*
         * Everything this clinic has prescribed and not yet handed over —
         * today's patients at the top, then anyone who took their prescription
         * away and has not come back for it. A sheet stays here until it is
         * dispensed or the pharmacist says it is being filled somewhere else,
         * because a patient deciding to buy on Friday is not a reason for the
         * record to lose sight of it.
         */
        queue() {
          const waiting = queue.filter((r) => r.days_waiting >= 1).length;
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Prescriptions to dispense</h3>
              <span class="muted small">${UI.num(queue.length)} open${
                waiting ? ` · ${UI.num(waiting)} from an earlier day` : ''}</span></div>
            <div class="card-body tight" id="q-list"></div></div>`;
          const host = body.querySelector('#q-list');
          host.innerHTML = UI.table([
            { label: 'Token', render: (r) => (r.token_no
              ? `<span class="badge crimson">#${UI.esc(r.token_no)}</span>`
              : '<span class="muted small">walk-in</span>') },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b>` +
              `<div class="muted small">${UI.esc(r.uhid)}${r.phone ? ' · ' + UI.esc(r.phone) : ''}</div>` },
            { label: 'Prescription', render: (r) => `<code>${UI.esc(r.rx_no)}</code>` +
              (r.visit_no ? `<div class="muted small">${UI.esc(r.visit_no)}</div>` : '') },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_code || r.doctor_name || '—') },
            { label: 'Items', num: true, render: (r) => UI.esc(r.pending_items) },
            { label: 'Written', render: (r) => (r.days_waiting >= 1
              ? `<b style="color:var(--orange-dark)">${UI.esc(UI.ago(r.created_at))}</b>`
              : UI.esc(UI.ago(r.created_at))) },
            { label: 'Flags', render: (r) => r.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
            { label: '', render: (r) => `<button class="btn sm" data-open="${r.sheet_id}"
                data-visit="${r.visit_id || ''}">Dispense</button>` +
              (APP.can(['pharmacy'])
                ? ` <button class="btn ghost sm" data-skip="${r.sheet_id}"
                     title="Not being filled here">Not here</button>` : '') },
          ], queue, { emptyText: 'Nothing waiting at the pharmacy counter.' });

          host.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
            // A prescription raised during a visit dispenses against that
            // visit; one written without a visit dispenses on its own.
            if (b.dataset.visit) APP.navigate('pharmacy', { visitId: b.dataset.visit });
            else APP.navigate('pharmacy', { sheetId: b.dataset.open });
          }));
          host.querySelectorAll('[data-skip]').forEach((b) =>
            b.addEventListener('click', () => declinePrescription(
              queue.find((r) => String(r.sheet_id) === b.dataset.skip))));
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
        opening()   { return StockUI.opening(body); },
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
  async function renderDispense(el, visitId, sheetId = null) {
    const data = await API.get(visitId
      ? `/api/pharmacy/prescriptions/${visitId}`
      : `/api/pharmacy/sheet/${sheetId}`);
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
          <div class="grid sidebar-right">
            <div>
              ${discountFields()}
              <div class="grid c2">
                ${UI.field({ name: 'paymentMode', label: 'Paid by', value: 'cash',
                  options: ['cash','upi','card','netbanking','wallet'].map((m) => ({ value: m, label: UI.titleise(m) })) })}
                ${UI.field({ name: 'paymentReference', label: 'Reference', placeholder: 'UPI / card reference' })}
              </div>
              <div class="muted small">The money is taken here. The patient has already left the cash
                counter, so this bill is settled at the pharmacy and the receipt is printed with it.</div>
            </div>
            <div>
              <div id="disp-total" class="mb"></div>
              <button class="btn block" id="do-dispense">Dispense, bill &amp; collect</button>
            </div>
          </div>
          <div id="disp-out"></div>
        </div>
      </div>`;

    /*
     * What the patient will be asked for, kept in step with the boxes above.
     * The quantities are the pharmacist's to change and the discount is theirs
     * to give, so the total has to be re-read from the screen each time rather
     * than worked out once when it was drawn.
     */
    const chosen = () => [...el.querySelectorAll('[data-rx]:checked')].map((cb) => {
      const rx = data.prescriptions.find((p) => String(p.id) === cb.dataset.rx);
      const qty = Number(el.querySelector(`[data-qty="${cb.dataset.rx}"]`).value) || 0;
      return { rx, qty };
    }).filter((c) => c.rx && c.qty > 0);

    const drawTotal = () => {
      const lines = chosen().map((c) => ({ total: priceLine(c.rx, c.qty), taxPct: c.rx.tax_pct }));
      const mrpTotal = UI.round2(lines.reduce((a, l) => a + l.total, 0));
      const t = billTotals(lines, discountAsked(el, mrpTotal));
      el.querySelector('#disp-total').innerHTML = lines.length
        ? totalsBlock(t)
        : '<div class="muted small">Tick a medicine to see what the bill comes to.</div>';
      el.querySelector('#do-dispense').disabled = t.tooMuch;
      billDiscount = t.discount;
    };

    // The discount in rupees, whichever way it was typed.
    let billDiscount = 0;
    el.querySelectorAll('[data-rx], [data-qty], [name=discountValue], [name=discountMode]')
      .forEach((f) => {
        f.addEventListener('input', drawTotal);
        f.addEventListener('change', drawTotal);
      });
    drawTotal();

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
        // Without a visit the sale stands on its own; the medicines are still
        // billed and paid for at this counter either way.
        patientId: visit.patient_id, visitId: visitId || undefined,
        discount: billDiscount,
        paymentMode: el.querySelector('[name=paymentMode]').value,
        paymentReference: el.querySelector('[name=paymentReference]').value || undefined,
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
          <b>Dispensed.</b> Bill ${UI.esc(res.sale.bill_no)} for ${UI.money(res.sale.net)}
          ${res.receiptNo
            ? `— collected here, receipt ${UI.esc(res.receiptNo)}.`
            : `added to the hospital bill ${UI.esc(res.invoice.invoice_no)}, settled at discharge.`}
          ${res.invoice.balance > 0.009
            ? `<div class="mt"><b style="color:var(--danger)">${UI.money(res.invoice.balance)} still to collect.</b></div>` : ''}
          <div class="mt"><button class="btn sm" id="disp-print">Print the tax invoice</button>
            <button class="btn ghost sm" id="disp-back">Back to the queue</button></div></div>`;
        UI.ok(res.receiptNo ? 'Medicines dispensed and paid for.' : 'Medicines dispensed and billed.');
        el.querySelector('#disp-print').addEventListener('click', () => printGstBill(res.sale.id));
        el.querySelector('#disp-back').addEventListener('click', () => APP.navigate('pharmacy'));
      } catch (err) {
        UI.err(err.message);
        e.target.disabled = false;
      }
    });
  }

  /**
   * The pharmacy's GST tax invoice, laid out for an 80 mm thermal roll.
   *
   * A retail chemist's bill has to satisfy two rulebooks at once: Rule 46 of the
   * CGST Rules (supplier GSTIN, serial number, HSN, taxable value, rate-wise
   * CGST/SGST, total in words, place of supply, reverse-charge status) and the
   * Drugs & Cosmetics Rules (batch, expiry, drug licence numbers, and the
   * pharmacist who handed it over). Both are printed here.
   *
   * MRP already includes GST, so the tax is shown extracted from it — the
   * patient pays the printed MRP and not a paisa more.
   */
  async function printGstBill(saleId) {
    const inv = await API.get(`/api/pharmacy/sales/${saleId}/invoice`);
    const { supplier: sup, sale, items, summary, hsnSummary } = inv;
    const rs = (n) => `${inv.currencySymbol}${Number(n || 0).toFixed(2)}`;
    const isCounter = sale.sale_type === 'counter';

    const missing = [];
    if (!sup.gstin) missing.push('GSTIN');
    if (!sup.dlNumbers) missing.push('drug licence numbers');
    if (!sup.pharmacistName) missing.push('pharmacist name');

    const html = `
      <div class="receipt">
        <div class="r-head">
          <img class="r-logo" src="/assets/logo-pharmacy.svg" alt="">
          <div class="r-name">${UI.esc(sup.name)}</div>
          <div class="r-tag">${UI.esc(sup.tagline)}</div>
          <div class="r-line">${UI.esc(sup.address)}</div>
          <div class="r-line">Ph: ${UI.esc(sup.phone)}</div>
          ${sup.gstin ? `<div class="r-line">GSTIN: <b>${UI.esc(sup.gstin)}</b></div>` : ''}
          ${sup.dlNumbers ? `<div class="r-line">D.L. No: ${UI.esc(sup.dlNumbers)}</div>` : ''}
          ${sup.fssai ? `<div class="r-line">FSSAI: ${UI.esc(sup.fssai)}</div>` : ''}
          <div class="r-title">TAX INVOICE</div>
        </div>

        <div class="r-rule"></div>
        <table class="r-meta">
          <tr><td>Invoice</td><td class="r-r"><b>${UI.esc(sale.bill_no)}</b></td></tr>
          <tr><td>Date</td><td class="r-r">${UI.esc(UI.dateTime(sale.created_at))}</td></tr>
          <tr><td>${isCounter ? 'Customer' : 'Patient'}</td>
              <td class="r-r">${UI.esc(sale.patient_name || sale.customer_name || 'Cash / Walk-in')}</td></tr>
          ${sale.uhid ? `<tr><td>UHID</td><td class="r-r">${UI.esc(sale.uhid)}</td></tr>` : ''}
          ${(sale.customer_phone || sale.patient_phone)
            ? `<tr><td>Mobile</td><td class="r-r">${UI.esc(sale.customer_phone || sale.patient_phone)}</td></tr>` : ''}
          ${sale.customer_gstin ? `<tr><td>Cust. GSTIN</td><td class="r-r">${UI.esc(sale.customer_gstin)}</td></tr>` : ''}
          ${sale.doctor_name ? `<tr><td>Prescriber</td><td class="r-r">${UI.esc(sale.doctor_name)}</td></tr>` : ''}
          ${sale.rx_reference ? `<tr><td>Rx</td><td class="r-r">${UI.esc(sale.rx_reference)}</td></tr>` : ''}
          <tr><td>Place of supply</td><td class="r-r">${UI.esc(inv.placeOfSupply)}</td></tr>
          <tr><td>Reverse charge</td><td class="r-r">${UI.esc(inv.reverseCharge)}</td></tr>
        </table>

        <div class="r-rule"></div>
        <table class="r-items">
          <thead>
            <tr><th class="r-l">Item</th><th class="r-r">Qty</th><th class="r-r">MRP</th><th class="r-r">Amount</th></tr>
          </thead>
          <tbody>
            ${items.map((i, n) => `
              <tr class="r-item">
                <td colspan="4" class="r-l"><b>${n + 1}. ${UI.esc(i.drug_name)}</b>
                  ${i.strength ? ' ' + UI.esc(i.strength) : ''}</td>
              </tr>
              <tr class="r-sub">
                <td colspan="4" class="r-l">B: ${UI.esc(i.batch_no || '—')} ·
                  Exp: ${i.expiry_date ? UI.esc(monthYear(i.expiry_date)) : '—'} ·
                  HSN: ${UI.esc(i.hsn_code || '3004')} · GST ${UI.esc(i.tax_pct)}%</td>
              </tr>
              <tr>
                <td class="r-l">&nbsp;</td>
                <td class="r-r">${UI.esc(i.qty)}</td>
                <td class="r-r">${Number(i.mrp).toFixed(2)}</td>
                <td class="r-r"><b>${Number(i.mrp * i.qty).toFixed(2)}</b></td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div class="r-rule"></div>
        <table class="r-tot">
          ${sale.discount ? `
            <tr><td>MRP total</td><td class="r-r">${rs(summary.mrpTotal)}</td></tr>
            <tr><td>Less discount</td><td class="r-r">− ${rs(sale.discount)}</td></tr>` : ''}
          <tr><td>Taxable value</td><td class="r-r">${rs(summary.taxable)}</td></tr>
          <tr><td>CGST</td><td class="r-r">${rs(summary.cgst)}</td></tr>
          <tr><td>SGST</td><td class="r-r">${rs(summary.sgst)}</td></tr>
          ${sale.round_off ? `<tr><td>Round off</td><td class="r-r">${sale.round_off > 0 ? '+ ' : '− '}${rs(Math.abs(sale.round_off))}</td></tr>` : ''}
          <tr class="r-grand"><td>TOTAL</td><td class="r-r">${rs(sale.net)}</td></tr>
          ${isCounter ? `
            <tr><td>Paid (${UI.esc(UI.titleise(sale.payment_mode || 'cash'))})</td>
                <td class="r-r">${rs(sale.paid_amount)}</td></tr>
            ${sale.net - sale.paid_amount > 0.009
              ? `<tr><td><b>Balance due</b></td><td class="r-r"><b>${rs(sale.net - sale.paid_amount)}</b></td></tr>` : ''}
          ` : `<tr><td colspan="2" class="r-note">Charged to visit bill${sale.visit_no ? ' ' + UI.esc(sale.visit_no) : ''} — settle at the cash counter.</td></tr>`}
        </table>

        <div class="r-words">${UI.esc(inv.amountInWords)}</div>

        <div class="r-rule"></div>
        <div class="r-sub2">GST summary</div>
        <table class="r-hsn">
          <thead><tr><th class="r-l">HSN</th><th class="r-r">Rate</th><th class="r-r">Taxable</th>
            <th class="r-r">CGST</th><th class="r-r">SGST</th></tr></thead>
          <tbody>${hsnSummary.map((h) => `<tr>
            <td class="r-l">${UI.esc(h.hsn)}</td>
            <td class="r-r">${UI.esc(h.rate)}%</td>
            <td class="r-r">${Number(h.taxable).toFixed(2)}</td>
            <td class="r-r">${Number(h.cgst).toFixed(2)}</td>
            <td class="r-r">${Number(h.sgst).toFixed(2)}</td></tr>`).join('')}</tbody>
        </table>

        <div class="r-rule"></div>
        <div class="r-foot">
          <div>Prices are MRP inclusive of GST.</div>
          <div>Medicines once sold are not taken back. Check the expiry before use.
            Store as directed and keep out of reach of children.</div>
          ${items.some((i) => ['H', 'H1', 'X'].includes(String(i.schedule_type || '').toUpperCase()))
            ? '<div><b>Schedule H / H1 drug — sold on the prescription of a registered medical practitioner.</b></div>' : ''}
          <div class="r-sign">
            <div>${UI.esc(sup.pharmacistName || 'Pharmacist')}${sup.pharmacistRegNo ? ' · Reg. ' + UI.esc(sup.pharmacistRegNo) : ''}</div>
            <div class="r-line">Billed by ${UI.esc(sale.billed_by || '')}</div>
            <div class="r-line">for ${UI.esc(sup.name)}</div>
          </div>
          <div class="r-thanks">Thank you — get well soon.</div>
        </div>
      </div>`;

    if (missing.length) {
      UI.warn(`Bill printed, but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not configured — ` +
        'set them in the environment before issuing real tax invoices.');
    }
    // No watermark on the 80mm roll: a thermal head prints one shade of black,
    // so a ghosted logo comes out as speckle across the bill rather than a tint.
    UI.print(receiptStyles() + html, `Tax invoice ${sale.bill_no}`, { watermark: false });
  }

  /** Expiry on a medicine label is month and year, never a day. */
  function monthYear(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${m[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
  }

  /**
   * 80 mm roll styling. Thermal heads print 72 mm of the 80 mm paper, have no
   * colour and no greyscale worth the name, so everything is pure black on
   * white with a monospace body — which also keeps the money columns aligned.
   */
  /**
   * The patient is not buying here — they took the paper elsewhere, or thought
   * better of it, or we do not stock what was written. The reason is required
   * because it is the only record of what happened to the prescription.
   */
  function declinePrescription(row) {
    if (!row) return;
    UI.modal({
      title: `Not dispensing ${row.rx_no}`, size: 'narrow',
      body: `<div class="alert info">${UI.esc(row.patient_name)} ·
          ${UI.num(row.pending_items)} item(s) still waiting.</div>
        <form id="dc-form">
          ${UI.field({ name: 'reason', label: 'Why not', rows: 2, required: true,
            placeholder: 'Buying near home, changed their mind, we do not stock it…' })}
        </form>
        <div class="muted small mt">It comes off the queue and is recorded as filled
          elsewhere. The prescription itself is untouched.</div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Take it off the queue</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#dc-form');
        if (!form.reportValidity()) return 'keep';
        await API.post(`/api/pharmacy/prescriptions/${row.sheet_id}/decline`, UI.formValues(form));
        UI.ok(`${row.rx_no} taken off the queue.`);
        APP.reload();
      },
    });
  }

  function receiptStyles() {
    return `<style>
      @page { size: 80mm auto; margin: 0; }
      body { margin: 0; background: #fff; }
      .receipt {
        width: 72mm; margin: 0 auto; padding: 3mm 2mm 6mm;
        font-family: "DejaVu Sans Mono", "Courier New", monospace;
        font-size: 10px; line-height: 1.35; color: #000; -webkit-print-color-adjust: exact;
      }
      .receipt table { width: 100%; border-collapse: collapse; }
      .receipt td, .receipt th { padding: 0; vertical-align: top; font-weight: normal; }
      .r-l { text-align: left; }
      .r-r { text-align: right; white-space: nowrap; }
      .r-head { text-align: center; }
      .r-logo { display: block; width: 22mm; height: auto; margin: 0 auto 1mm; }
      .r-name { font-size: 13px; font-weight: 700; letter-spacing: .5px; }
      .r-tag { font-size: 8.5px; letter-spacing: .8px; text-transform: uppercase; margin-bottom: 1mm; }
      .r-line { font-size: 9px; }
      .r-title {
        margin: 1.5mm 0 0; padding: 0.7mm 0; font-size: 11px; font-weight: 700; letter-spacing: 2px;
        border-top: 1px solid #000; border-bottom: 1px solid #000;
      }
      .r-rule { border-top: 1px dashed #000; margin: 1.5mm 0; }
      .r-meta td { font-size: 9px; }
      .r-items thead th { font-size: 9px; border-bottom: 1px solid #000; padding-bottom: .5mm; }
      .r-items .r-item td { padding-top: 1mm; }
      .r-items .r-sub td { font-size: 8.5px; }
      .r-tot td { font-size: 10px; padding: .2mm 0; }
      .r-grand td { font-size: 12px; font-weight: 700; border-top: 1px solid #000;
        border-bottom: 1px solid #000; padding: .8mm 0; }
      .r-note { font-size: 8.5px; padding-top: 1mm; }
      .r-words { margin-top: 1mm; font-size: 9px; font-style: italic; }
      .r-sub2 { font-size: 9px; font-weight: 700; margin-bottom: .5mm; }
      .r-hsn th, .r-hsn td { font-size: 8.5px; }
      .r-hsn thead th { border-bottom: 1px solid #000; }
      .r-foot { font-size: 8.5px; text-align: center; }
      .r-foot > div { margin-top: 1mm; }
      .r-sign { margin-top: 4mm; text-align: right; }
      .r-sign > div:first-child { border-top: 1px solid #000; display: inline-block; padding-top: .5mm; }
      .r-thanks { margin-top: 2mm; font-size: 9.5px; font-weight: 700; }
      @media screen {
        body { background: #eef1f3; padding: 12px 0; }
        .receipt { background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.18); }
      }
    </style>`;
  }

  /**
   * One prescription, as the counter reads it: what to hand over, how much of
   * it, and the directions to repeat back to the patient.
   */
  async function openPrescription(id) {
    const rx = await API.get(`/api/prescriptions/${id}`);
    const slotText = (i) => {
      const per = [i.dose_morning, i.dose_afternoon, i.dose_night];
      return per.some((n) => n > 0) ? per.map((n) => Number(n) || 0).join('-') : (i.frequency || '');
    };
    const food = {
      after_food: 'after food', before_food: 'before food', with_food: 'with food',
      empty_stomach: 'on an empty stomach', bedtime: 'at bedtime', anytime: 'any time',
    };

    UI.modal({
      title: `${rx.rx_no} — ${rx.first_name} ${rx.last_name || ''}`.trim(),
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div class="muted small">${UI.esc(rx.uhid)} ·
            ${UI.esc(rx.age_years || '—')}${rx.age_years ? 'y' : ''} ·
            ${UI.esc(UI.titleise(rx.gender || '—'))} ·
            ${UI.esc(UI.dateTime(rx.created_at))}</div>
          <div class="muted small">${UI.esc(rx.doctor_code || '')}
            ${rx.signed_at ? UI.badge('Signed', 'ok') : UI.badge('Not signed', 'warn')}</div>
        </div>
        ${rx.allergies ? `<div class="alert danger">Allergic to: ${UI.esc(rx.allergies)}</div>` : ''}
        ${rx.diagnosis ? `<div class="alert info"><b>Diagnosis:</b> ${UI.esc(rx.diagnosis)}</div>` : ''}
        ${UI.table([
          { label: 'Medicine', render: (i) => `<b>${UI.esc(i.drug_name)}</b>` +
            `<div class="muted small">${UI.esc(i.form || '')}` +
            `${['H', 'H1', 'X'].includes(String(i.schedule_type || '').toUpperCase())
              ? ' · ' + UI.badge('Schedule ' + i.schedule_type, 'warn') : ''}</div>` },
          { label: 'How to take it', render: (i) => `<b>${UI.esc(slotText(i))}</b>` +
            `<div class="muted small">${UI.esc(food[i.food_relation] || '')}` +
            `${i.duration_days ? ` · ${UI.esc(i.duration_days)} day(s)` : ''}` +
            `${i.instructions ? ` · ${UI.esc(i.instructions)}` : ''}</div>` },
          { label: 'To hand over', num: true, render: (i) => `<b>${UI.esc(i.quantity)}</b> ` +
            `${UI.esc(i.dose_unit || '')}` },
          { label: 'Dispensed', num: true, render: (i) => UI.esc(i.dispensed_qty || 0) },
          { label: 'Status', render: (i) => UI.statusBadge(i.status) },
        ], rx.items)}
        ${rx.advice ? `<div class="mt"><span class="muted small">Advice</span>
          <div>${UI.esc(rx.advice)}</div></div>` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${rx.visit_id
          ? '<button class="btn" data-act="queue">Open the dispensing queue</button>'
          : '<button class="btn" data-act="counter">Dispense at the counter</button>'}`,
      onAction(act) {
        if (act === 'queue') return void APP.navigate('pharmacy', { visitId: rx.visit_id });
        if (act === 'counter') {
          // A prescription with no visit is settled at the counter, so the
          // medicines and the Rx number go across rather than being re-typed.
          UI.closeAllModals();
          APP.navigate('pharmacy');
          setTimeout(() => UI.warn(
            `Open Counter sale and quote ${rx.rx_no} as the prescription reference.`), 400);
        }
      },
    });
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
