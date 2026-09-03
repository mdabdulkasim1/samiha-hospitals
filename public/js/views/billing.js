/* Check-out desk: bill assembly, payment, payment plans and exceptions. */
(function () {
  'use strict';

  APP.register('billing', {
    title: 'Billing & Check-out',
    subtitle: 'Payments, plans and assistance cover',

    async render(el, params) {
      if (params.visitId) return renderCheckout(el, Number(params.visitId));
      if (params.invoiceId) return renderBill(el, Number(params.invoiceId));

      APP.actions([
        { id: 'new-bill', label: '+ New bill', onClick: openNewBill },
        { id: 'daybook', label: 'Day book', onClick: openDaybook },
      ]);

      const [invoices, plans, pending] = await Promise.all([
        API.get('/api/billing/invoices' + API.qs({ status: params.status })),
        API.get('/api/billing/payment-plans?status=active'),
        API.get('/api/billing/pending').catch(() => ({ rows: [], totals: {} })),
      ]);

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">To collect today</div>
            <div class="value">${UI.money(pending.totals.amountToCollect || 0)}</div>
            <div class="foot">${UI.num(pending.totals.toCollect || 0)} patient(s) with a bill to settle</div></div>
          <div class="stat orange"><div class="label">Waiting for a bill</div>
            <div class="value">${UI.num(pending.totals.awaitingBill || 0)}</div>
            <div class="foot">In the clinic, nothing raised yet</div></div>
          <div class="stat ok"><div class="label">Collected (all time)</div>
            <div class="value">${UI.money(invoices.totals.collected)}</div></div>
          <div class="stat teal"><div class="label">Outstanding (all time)</div>
            <div class="value">${UI.money(invoices.totals.outstanding)}</div>
            <div class="foot">${UI.num(plans.length)} payment plan(s) running</div></div>
        </div>

        <div class="tabs" id="b-tabs">
          <button class="active" data-tab="today">Today's collections${
            pending.totals.toCollect ? ` <span class="pill">${UI.num(pending.totals.toCollect)}</span>` : ''}</button>
          <button data-tab="raise">Raise a bill</button>
          <button data-tab="invoices">Invoices</button>
          <button data-tab="plans">Payment plans</button>
        </div>
        <div id="b-body"></div>`;

      const body = el.querySelector('#b-body');
      const tabs = {
        /**
         * The day, patient by patient: who is booked, who is in the building,
         * who has a bill waiting and who has paid. The desk's question is
         * "who do I still have to collect from", and it is answered by
         * reading down one list rather than by guessing which invoices belong
         * to people who are actually here.
         */
        today() {
          const t = pending.totals;
          const LABEL = {
            expected: ['Booked', 'info', 'Not arrived yet'],
            awaiting_bill: ['Needs a bill', 'warn', 'In the clinic'],
            to_collect: ['To collect', 'danger', 'Bill ready'],
            settled: ['Settled', 'ok', 'Nothing to collect'],
          };
          body.innerHTML = `
            ${t.toCollect
              ? `<div class="alert warn"><b>${UI.num(t.toCollect)} patient(s)</b> have a bill
                   waiting — ${UI.money(t.amountToCollect)} to collect.</div>`
              : '<div class="alert ok">Nothing waiting to be collected right now.</div>'}
            <div class="card"><div class="card-head"><h3>Today at the clinic</h3>
              <span class="muted small">${UI.num(t.expected || 0)} booked ·
                ${UI.num(t.awaitingBill || 0)} needing a bill ·
                ${UI.num(t.settled || 0)} settled</span></div>
              <div class="card-body tight" id="t-list"></div></div>`;

          const host = body.querySelector('#t-list');
          host.innerHTML = UI.table([
            { label: 'Time', render: (r) => `<b>${UI.esc(UI.time(r.at))}</b>` +
              (r.token_no ? `<div class="muted small">Token ${UI.esc(r.token_no)}</div>` : '') },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name || '—')}</b>` +
              `<div class="muted small">${UI.esc(r.uhid || 'not registered')}${
                r.phone ? ' · ' + UI.esc(r.phone) : ''}</div>` },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_code || r.doctor_name || '—') },
            { label: 'Where', render: (r) => (r.visit_status
              ? UI.statusBadge(r.visit_status)
              : `<span class="muted small">${UI.esc(LABEL[r.state][2])}</span>`) },
            { label: 'Bill', render: (r) => (r.invoice_no
              ? `<code>${UI.esc(r.invoice_no)}</code>` : '<span class="muted">—</span>') },
            { label: 'To collect', num: true, render: (r) => (r.state === 'to_collect'
              ? `<b style="color:var(--danger)">${UI.money(r.balance)}</b>`
              : (r.invoice_id ? UI.money(0) : '<span class="muted">—</span>')) },
            { label: 'Stage', render: (r) => UI.badge(LABEL[r.state][0], LABEL[r.state][1]) },
            { label: '', render: (r) => (r.visit_id
              ? `<button class="btn sm" data-visit="${r.visit_id}">${
                  r.state === 'to_collect' ? 'Collect' : 'Open'}</button>`
              : (r.patient_id
                ? `<button class="btn ghost sm" data-bill-for="${r.patient_id}">Raise bill</button>`
                : '')) },
          ], pending.rows, {
            emptyText: 'Nobody is booked and nobody has walked in today.',
          });
          host.querySelectorAll('[data-visit]').forEach((b) => b.addEventListener('click', () =>
            APP.navigate('billing', { visitId: b.dataset.visit })));
          host.querySelectorAll('[data-bill-for]').forEach((b) => b.addEventListener('click', () =>
            startBill(Number(b.dataset.billFor))));
        },

        raise() { return renderCounterDesk(body); },

        invoices() {
          body.innerHTML = `
            <div class="search-row"><select id="i-status">
              <option value="">All statuses</option>
              ${['unpaid','partial','paid','written_off','cancelled'].map((s) =>
                `<option value="${s}"${params.status === s ? ' selected' : ''}>${UI.titleise(s)}</option>`).join('')}
            </select></div>
            <div class="card"><div class="card-body tight" id="i-list"></div></div>`;
          body.querySelector('#i-status').addEventListener('change', (e) =>
            APP.navigate('billing', { status: e.target.value }));
          const host = body.querySelector('#i-list');
          host.innerHTML = UI.table([
            { label: 'Invoice', render: (i) => `<code>${UI.esc(i.invoice_no)}</code>` },
            { label: 'Patient', render: (i) => `<b>${UI.esc(i.patient_name)}</b><div class="muted small">${UI.esc(i.uhid)}</div>` },
            { label: 'Source', render: (i) => UI.esc(i.visit_no || i.ip_no || UI.titleise(i.kind)) },
            { label: 'Date', render: (i) => UI.esc(UI.date(i.created_at)) },
            { label: 'Gross', num: true, render: (i) => UI.money(i.gross) },
            { label: 'Concession', num: true, render: (i) =>
              UI.money(i.discount + (i.bill_discount || 0) + i.sliding_discount + i.assistance_covered) },
            { label: 'Net', num: true, render: (i) => `<b>${UI.money(i.net)}</b>` },
            { label: 'Balance', num: true, render: (i) => i.balance > 0
              ? `<b style="color:var(--danger)">${UI.money(i.balance)}</b>` : UI.money(0) },
            { label: 'Status', render: (i) => UI.statusBadge(i.status) },
          ], invoices.rows, { emptyText: 'No invoices yet.' });
          UI.bindRows(host, invoices.rows, (i) => APP.navigate('billing', { invoiceId: i.id }));
        },
        plans() {
          body.innerHTML = `<div class="card"><div class="card-head"><h3>Active payment-plan agreements</h3></div>
            <div class="card-body tight" id="p-list"></div></div>`;
          const host = body.querySelector('#p-list');
          host.innerHTML = UI.table([
            { label: 'Agreement', render: (p) => `<code>${UI.esc(p.agreement_no)}</code>` },
            { label: 'Patient', render: (p) => `<b>${UI.esc(p.patient_name)}</b><div class="muted small">${UI.esc(p.uhid)} · ${UI.esc(p.phone || '')}</div>` },
            { label: 'Invoice', key: 'invoice_no' },
            { label: 'Financed', num: true, render: (p) => UI.money(p.total_amount) },
            { label: 'Instalments', render: (p) => `${UI.esc(p.installments)} × ${UI.money(p.installment_amount)} (${UI.esc(p.frequency)})` },
            { label: 'Next due', render: (p) => p.next_due ? UI.esc(UI.date(p.next_due)) : '—' },
            { label: 'Outstanding', num: true, render: (p) => UI.money(p.invoice_balance) },
            { label: 'Status', render: (p) => UI.statusBadge(p.status) },
          ], plans, { emptyText: 'No active payment plans.' });
          UI.bindRows(host, plans, (p) => openInvoice(p.invoice_id));
        },
      };
      el.querySelectorAll('#b-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#b-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab]();
      }));
      tabs.today();
    },
  });

  // ---------------------------------------------------------- check-out desk
  /**
   * "Patient Gives Results Page To Check Out Desk" through to "Patient Leaves",
   * including all four payment branches of the flowchart.
   */
  async function renderCheckout(el, visitId) {
    const visit = await API.get(`/api/visits/${visitId}`);
    APP.setSubtitle(`${visit.patient_name} · ${visit.uhid} · ${visit.visit_no}`);
    APP.actions([{ id: 'back', label: '← Billing', onClick: () => APP.navigate('billing') }]);

    // The hospital bill for this visit. The pharmacy raises its own against
    // the same visit and collects at its own counter, so it is not the
    // cashier's to assemble, print or take money for.
    let invoice = visit.invoices.find((i) => i.status !== 'cancelled' && i.kind !== 'pharmacy') || null;

    const draw = async () => {
      el.innerHTML = `
        <div class="grid sidebar-right">
          <div>
            <div class="card">
              <div class="card-head"><h3>Bill</h3>
                <button class="btn ghost sm" id="prepare">${invoice ? 'Re-check charges' : 'Assemble bill'}</button>
                ${invoice ? '<button class="btn ghost sm" id="discount">Give a discount</button>' : ''}
                ${invoice ? '<button class="btn ghost sm" id="print-inv">Print invoice</button>' : ''}
              </div>
              <div class="card-body" id="inv-body">
                ${invoice ? '' : `<div class="alert info">Press <b>Assemble bill</b> to pull the
                  consultation fee and the diagnostics onto this bill, then add anything else
                  the patient had — dressing, injection, nebulisation — with the buttons below.
                  <div class="small mt">Medicines are not on this bill. An out-patient pays for
                  them at the pharmacy counter, on the pharmacy's own bill.</div></div>`}
              </div>
            </div>
            ${invoice ? `<div class="card">
              <div class="card-head"><h3>Add a charge</h3>
                <span class="muted small">Pick the group, then the item</span></div>
              <div class="card-body" id="quick-add">${UI.loading()}</div>
            </div>` : ''}
          </div>

          <div>
            <div class="card"><div class="card-head"><h3>Check-out</h3></div>
              <div class="card-body">
                ${visit.status === 'checked_out'
                  ? `<div class="alert ok"><b>Already checked out.</b><br>Exit pass ${UI.esc(visit.exit_pass_no || '')}</div>`
                  : `<div class="muted small mb">Book the review appointment, then release the patient.</div>
                     <div id="fu-block"></div>
                     <button class="btn block" id="do-checkout">Complete check-out</button>`}
              </div>
            </div>

            <div class="card"><div class="card-head"><h3>Visit summary</h3></div>
              <div class="card-body"><dl class="kv">
                <dt>Doctor</dt><dd>${UI.esc(visit.doctor_name || '—')}</dd>
                <dt>Reason</dt><dd>${UI.esc(visit.reason_for_visit || '—')}</dd>
                <dt>Diagnostics</dt><dd>${UI.num(visit.labOrders.length)} order(s)</dd>
                <dt>Medicines</dt><dd>${UI.num(visit.prescriptions.length)} item(s)</dd>
                ${visit.screening ? `<dt>Sliding scale</dt><dd>${visit.screening.sliding_scale_band
                  ? UI.badge('Band ' + visit.screening.sliding_scale_band + ' · ' + visit.screening.discount_pct + '%', 'teal')
                  : 'Not assigned'}</dd>` : ''}
              </dl></div>
            </div>
          </div>
        </div>`;

      if (invoice) await drawInvoice();
      wireCheckout();
    };

    const drawInvoice = async () => {
      const full = await API.get(`/api/billing/invoices/${invoice.id}`);
      invoice = full;
      el.querySelector('#inv-body').innerHTML = invoiceBody(full);
      wireInvoiceActions(full, () => draw());
    };

    const wireCheckout = () => {
      const prep = el.querySelector('#prepare');
      if (prep) prep.addEventListener('click', async () => {
        prep.disabled = true;
        try {
          invoice = await API.post(`/api/visits/${visitId}/prepare-bill`);
          UI.ok('Charges assembled.');
          await draw();
        } catch (err) { UI.err(err.message); prep.disabled = false; }
      });

      const printBtn = el.querySelector('#print-inv');
      if (printBtn) printBtn.addEventListener('click', () => printInvoice(invoice, UI.openPrintWindow()));

      const disc = el.querySelector('#discount');
      if (disc) disc.addEventListener('click', () => openBillDiscount(invoice, () => draw()));

      const quick = el.querySelector('#quick-add');
      if (quick) drawQuickAdd(quick, invoice, () => draw());

      const fu = el.querySelector('#fu-block');
      if (fu) {
        API.get('/api/masters/staff?role=doctor').catch(() => []).then((doctors) => {
          fu.innerHTML = `
            ${UI.field({ name: 'fuDoctorId', label: 'Follow-up with',
              options: [{ value: '', label: '— no follow-up —' }].concat(doctors.map((d) => ({ value: d.id, label: d.name }))),
              value: visit.doctor_id || '' })}
            ${UI.field({ name: 'fuAt', label: 'Follow-up date & time', type: 'datetime-local',
              value: visit.consultation && visit.consultation.follow_up_date
                ? visit.consultation.follow_up_date + 'T10:00' : '' })}`;
        }).catch(() => { fu.innerHTML = '<div class="muted small">Follow-up booking is unavailable for your role.</div>'; });
      }

      const out = el.querySelector('#do-checkout');
      if (out) out.addEventListener('click', async () => {
        const doctorId = el.querySelector('[name=fuDoctorId]') ? el.querySelector('[name=fuDoctorId]').value : '';
        const at = el.querySelector('[name=fuAt]') ? el.querySelector('[name=fuAt]').value : '';
        const payload = {};
        if (doctorId && at) payload.followUp = { doctorId, scheduledAt: at.replace('T', ' ') + ':00', reason: 'Review after this visit' };

        out.disabled = true;
        try {
          const res = await API.post(`/api/visits/${visitId}/check-out`, payload);
          UI.ok(`Checked out — exit pass ${res.exitPassNo}.${res.followUp ? ' Follow-up booked.' : ''}`);
          if (res.note) UI.warn(res.note);
          setTimeout(() => APP.navigate('queue'), 1400);
        } catch (err) {
          if (err.status === 409) {
            UI.err(err.message);
            UI.warn('Use “Payment plan” or “Document exception” on the bill to release the patient.');
          } else UI.err(err.message);
          out.disabled = false;
        }
      });
    };

    await draw();
  }

  // ------------------------------------------------------------ the counter
  /**
   * The cashier's own screen: every service the clinic charges for, as a
   * button with its rate on it.
   *
   * The question this answers is the one asked at the counter a hundred times
   * a day — "what did this patient have?" — and the answer is given by
   * pressing it. Charges go onto a running bill on the right, the patient is
   * named once, and one press raises the invoice, takes the money and prints
   * it. Nothing is typed but the discount and the amount received.
   *
   * The bill is built here before it exists in the database, because a cashier
   * changes their mind mid-bill and a half-made invoice nobody finished is
   * worse than no invoice at all. It reaches the server once, complete.
   */
  async function renderCounterDesk(body) {
    const draft = [];          // { kind, id, name, price, taxPct, qty }
    let patient = null;

    body.innerHTML = `
      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>What did the patient have?</h3>
              <span class="muted small">Press an item to put it on the bill — rates are the ones set
                under Services &amp; Rates</span></div>
            <div class="card-body" id="cd-board">${UI.loading()}</div>
          </div>
        </div>

        <div>
          <div class="card"><div class="card-head"><h3>Bill</h3>
              <button class="btn ghost sm" id="cd-clear">Clear</button></div>
            <div class="card-body tight" id="cd-lines"></div>
            <div class="card-body">
              <div id="cd-total"></div>
              <div class="mt" id="cd-who"></div>
              ${UI.field({ name: 'discountMode', label: 'Discount', value: 'amount',
                options: [{ value: 'amount', label: 'Rupees off' }, { value: 'pct', label: 'A percentage' }] })}
              ${UI.field({ name: 'discountValue', label: 'How much', type: 'number',
                step: '0.01', min: '0', value: 0 })}
              ${UI.field({ name: 'discountReason', label: 'Why', placeholder: 'Staff, goodwill, rounding' })}
              ${UI.field({ name: 'mode', label: 'Paid by', value: 'cash',
                options: ['cash', 'upi', 'card', 'netbanking', 'cheque', 'wallet']
                  .map((m) => ({ value: m, label: UI.titleise(m) })) })}
              ${UI.field({ name: 'reference', label: 'Reference', placeholder: 'UPI / card reference' })}
              <button class="btn block mt" id="cd-raise" disabled>Raise the bill &amp; collect</button>
              <button class="btn ghost block mt" id="cd-raise-only" disabled>Raise it without taking money</button>
              <div id="cd-out"></div>
            </div>
          </div>
        </div>
      </div>`;

    // ---- who it is for
    const who = body.querySelector('#cd-who');
    const drawWho = () => {
      who.innerHTML = patient
        ? `<div class="alert ok"><b>${UI.esc(patient.first_name)} ${UI.esc(patient.last_name || '')}</b>
             · ${UI.esc(patient.uhid)}${patient.phone ? ' · ' + UI.esc(patient.phone) : ''}
             <button class="btn ghost sm" id="cd-unpick" style="float:right">Change</button></div>`
        : `<div class="search-row">
             <input type="search" id="cd-q" placeholder="Whose bill is this? Name, UHID or mobile…"
               autocomplete="off"></div>
           <div id="cd-hits"></div>`;

      const un = who.querySelector('#cd-unpick');
      if (un) un.addEventListener('click', () => { patient = null; drawWho(); refresh(); });

      const input = who.querySelector('#cd-q');
      if (!input) return;
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          const hits = who.querySelector('#cd-hits');
          if (q.length < 2) return void (hits.innerHTML = '');
          let rows = [];
          try { rows = (await API.get('/api/patients' + API.qs({ q, limit: 6 }))).rows; }
          catch (err) { return void (hits.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`); }
          hits.innerHTML = rows.length ? rows.map((p) => `
            <button type="button" class="btn ghost sm block mb" data-pt="${p.id}"
              style="justify-content:space-between">
              <span><b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>
                <span class="muted small"> ${UI.esc(p.uhid)}</span></span>
              <span class="muted small">${UI.esc(p.phone || '')}</span></button>`).join('')
            : '<div class="muted small">Nobody matched. Register them at the front desk first.</div>';
          hits.querySelectorAll('[data-pt]').forEach((b) => b.addEventListener('click', () => {
            patient = rows.find((r) => r.id === Number(b.dataset.pt));
            drawWho();
            refresh();
          }));
        }, 220);
      });
    };

    // ---- the running bill
    const lineTotal = (l) => UI.round2(l.price * l.qty);
    const gross = () => UI.round2(draft.reduce((a, l) => a + lineTotal(l), 0));
    const taxOf = () => UI.round2(draft.reduce((a, l) => a + lineTotal(l) * ((l.taxPct || 0) / 100), 0));

    const discountOf = () => {
      const mode = body.querySelector('[name=discountMode]').value;
      const v = Math.max(Number(body.querySelector('[name=discountValue]').value) || 0, 0);
      const chargeable = UI.round2(gross() + taxOf());
      return { asked: mode === 'pct' ? UI.round2(chargeable * (v / 100)) : UI.round2(v), chargeable };
    };

    const refresh = () => {
      body.querySelector('#cd-lines').innerHTML = UI.table([
        { label: 'Item', render: (l) => `<b>${UI.esc(l.name)}</b>` },
        { label: 'Qty', num: true, render: (l, i) => `<input type="number" min="1" step="1"
            data-q="${i}" value="${l.qty}" style="width:64px;text-align:right">` },
        { label: 'Amount', num: true, render: (l) => UI.money(lineTotal(l)) },
        { label: '', render: (l, i) => `<button class="btn ghost sm" data-rm="${i}">Remove</button>` },
      ], draft, { emptyText: 'Nothing on the bill yet — press what the patient had.' });

      const d = discountOf();
      const off = Math.min(d.asked, d.chargeable);
      const net = UI.round2(d.chargeable - off);
      body.querySelector('#cd-total').innerHTML = `
        <div class="row-between"><span>Gross</span><b>${UI.money(gross())}</b></div>
        ${taxOf() ? `<div class="row-between muted small"><span>Tax</span><span>${UI.money(taxOf())}</span></div>` : ''}
        ${off ? `<div class="row-between" style="color:var(--orange-dark)">
          <span>Discount</span><span>− ${UI.money(off)}</span></div>` : ''}
        <div class="row-between" style="font-size:17px;border-top:1px solid var(--line);margin-top:6px;padding-top:8px">
          <b>To pay</b><b>${UI.money(net)}</b></div>
        ${d.asked > d.chargeable ? `<div class="alert warn mt">A discount of ${UI.money(d.asked)}
          is more than the bill.</div>` : ''}
        ${draft.length && !patient
          ? '<div class="alert info mt">Name the patient below and the bill can be raised.</div>' : ''}`;

      body.querySelectorAll('[data-q]').forEach((i) => i.addEventListener('input', () => {
        draft[Number(i.dataset.q)].qty = Math.max(Number(i.value) || 1, 1);
        refresh();
      }));
      body.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
        draft.splice(Number(b.dataset.rm), 1);
        refresh();
      }));

      const ready = Boolean(draft.length && patient && d.asked <= d.chargeable);
      body.querySelector('#cd-raise').disabled = !ready;
      body.querySelector('#cd-raise-only').disabled = !ready;
    };

    body.querySelectorAll('[name=discountValue], [name=discountMode]')
      .forEach((f) => f.addEventListener('input', refresh));
    body.querySelector('#cd-clear').addEventListener('click', () => {
      draft.length = 0;
      refresh();
    });

    // ---- the board itself
    BillingTools.quickAdd(body.querySelector('#cd-board'), {
      async onAdd(item) {
        const found = draft.find((l) => l.kind === item.kind && l.id === item.id);
        if (found) found.qty += 1;
        else draft.push({ ...item, qty: 1 });
        refresh();
      },
    });

    // ---- raising it
    const raise = async (collect) => {
      const btn = body.querySelector(collect ? '#cd-raise' : '#cd-raise-only');
      btn.disabled = true;
      try {
        const inv = await API.post('/api/billing/invoices', { patientId: patient.id, kind: 'opd' });
        for (const l of draft) {
          await API.post(`/api/billing/invoices/${inv.id}/items`, {
            refType: l.kind === 'test' ? 'lab' : 'service', refId: l.id,
            description: l.name, qty: l.qty, unitPrice: l.price, taxPct: l.taxPct,
          });
        }

        const d = discountOf();
        if (d.asked > 0) {
          await API.post(`/api/billing/invoices/${inv.id}/bill-discount`, {
            amount: Math.min(d.asked, d.chargeable),
            reason: body.querySelector('[name=discountReason]').value || 'Given at the counter',
          });
        }

        let full = await API.get(`/api/billing/invoices/${inv.id}`);
        let receipt = null;
        if (collect && full.balance > 0) {
          const paid = await API.post(`/api/billing/invoices/${inv.id}/payments`, {
            amount: full.balance,
            mode: body.querySelector('[name=mode]').value,
            reference: body.querySelector('[name=reference]').value || undefined,
          });
          receipt = paid.receiptNo || paid.receipt_no;
          full = await API.get(`/api/billing/invoices/${inv.id}`);
        }

        UI.ok(`${full.invoice_no} raised — ${UI.money(full.net)}${receipt ? `, receipt ${receipt}` : ''}.`);
        body.querySelector('#cd-out').innerHTML = `
          <div class="alert ok mt"><b>${UI.esc(full.invoice_no)}</b> — ${UI.money(full.net)}
            ${receipt ? `collected, receipt ${UI.esc(receipt)}.` : `raised, ${UI.money(full.balance)} to collect.`}
            <div class="mt">
              <button class="btn sm" id="cd-print">Print the invoice</button>
              <button class="btn ghost sm" id="cd-open">Open the bill</button>
              <button class="btn ghost sm" id="cd-next">Next patient</button>
            </div></div>`;
        // The window is claimed on the click itself: a browser only allows a
        // popup while it can still see the gesture, and the QR is fetched after.
        body.querySelector('#cd-print').addEventListener('click', () => {
          printInvoice(full, UI.openPrintWindow());
        });
        body.querySelector('#cd-open').addEventListener('click', () =>
          APP.navigate('billing', { invoiceId: full.id }));
        body.querySelector('#cd-next').addEventListener('click', () => {
          draft.length = 0;
          patient = null;
          body.querySelector('[name=discountValue]').value = 0;
          body.querySelector('[name=reference]').value = '';
          body.querySelector('#cd-out').innerHTML = '';
          drawWho();
          refresh();
        });

        // The bill is made; the board is ready for the next patient either way.
        draft.length = 0;
        refresh();
      } catch (err) {
        UI.err(err.message);
        btn.disabled = false;
      }
    };
    body.querySelector('#cd-raise').addEventListener('click', () => raise(true));
    body.querySelector('#cd-raise-only').addEventListener('click', () => raise(false));

    drawWho();
    refresh();
  }

  // ------------------------------------------------------------ counter bill
  /**
   * A bill made up by hand, service by service, off the clinic's own tariff.
   *
   * The cashier's usual bill comes off a visit and assembles itself. Plenty of
   * money is taken without one, though — a dressing, an injection, an ECG
   * somebody walked in for, a test paid for and taken away — and until now
   * there was nowhere to take it. This is that bill: pick the patient, press
   * what they had, take the money, print it.
   *
   * Every rate on the board is the one management set under Services & Rates.
   * Nothing is typed in at the counter, so two people billing the same dressing
   * on the same morning charge the same for it.
   */
  async function renderBill(el, invoiceId) {
    let inv = await API.get(`/api/billing/invoices/${invoiceId}`);
    const who = `${inv.first_name} ${inv.last_name || ''}`.trim();
    APP.setSubtitle(`${inv.invoice_no} · ${who} · ${inv.uhid}`);
    APP.actions([
      { id: 'back', label: '← Billing', onClick: () => APP.navigate('billing') },
      { id: 'print', label: 'Print invoice', onClick: () => printInvoice(inv, UI.openPrintWindow()) },
    ]);

    const draw = async () => {
      inv = await API.get(`/api/billing/invoices/${invoiceId}`);
      // A bill that is paid, cancelled or written off is a record, not a
      // working document: it can be read and reprinted, not added to.
      const open = !['paid', 'cancelled', 'written_off'].includes(inv.status);

      el.innerHTML = `
        <div class="grid sidebar-right">
          <div>
            <div class="card">
              <div class="card-head"><h3>Bill</h3>
                ${open ? '<button class="btn ghost sm" id="b-discount">Give a discount</button>' : ''}
                <button class="btn ghost sm" id="b-print">Print invoice</button>
              </div>
              <div class="card-body" id="b-inv">${invoiceBody(inv, { removable: open })}</div>
            </div>

            ${open ? `<div class="card">
              <div class="card-head"><h3>Add a service</h3>
                <span class="muted small">Pick the group, then the item</span></div>
              <div class="card-body" id="b-add">${UI.loading()}</div>
            </div>` : ''}
          </div>

          <div>
            <div class="card"><div class="card-head"><h3>To collect</h3></div>
              <div class="card-body">
                <div class="stat ${inv.balance > 0.009 ? 'crimson' : 'ok'}">
                  <div class="label">Balance</div>
                  <div class="value">${UI.money(inv.balance)}</div>
                  <div class="foot">${UI.money(inv.net)} billed · ${UI.money(inv.paid)} paid</div>
                </div>
                ${inv.balance > 0.009
                  ? `<button class="btn block mt" id="b-pay">Accept payment</button>`
                  : '<div class="alert ok mt">Settled in full. Print the invoice for the patient.</div>'}
                <button class="btn ghost block mt" id="b-print2">Print invoice</button>
              </div></div>

            <div class="card"><div class="card-head"><h3>Patient</h3></div>
              <div class="card-body"><dl class="kv">
                <dt>Name</dt><dd><b>${UI.esc(who)}</b></dd>
                <dt>UHID</dt><dd>${UI.esc(inv.uhid)}</dd>
                <dt>Phone</dt><dd>${UI.esc(inv.phone || '—')}</dd>
                <dt>Bill type</dt><dd>${UI.esc(UI.titleise(inv.kind))}</dd>
                ${inv.visit_no ? `<dt>Visit</dt><dd>${UI.esc(inv.visit_no)}</dd>` : ''}
              </dl>
              ${inv.visit_id ? `<button class="btn ghost block mt" id="b-visit">Open the visit</button>` : ''}
              </div></div>

            <div class="card"><div class="card-body">
              <div class="muted small">Medicines are not billed here. An out-patient pays the
                pharmacy at its own counter, on the pharmacy's own bill.</div>
            </div></div>
          </div>
        </div>`;

      wireInvoiceActions(inv, draw);

      const add = el.querySelector('#b-add');
      if (add) {
        BillingTools.quickAdd(add, {
          note: 'Rates are the ones set under Services &amp; Rates. To change one, change it there.',
          async onAdd(item) {
            await API.post(`/api/billing/invoices/${inv.id}/items`, {
              refType: item.kind === 'test' ? 'lab' : 'service',
              refId: item.id, description: item.name, qty: 1,
              unitPrice: item.price, taxPct: item.taxPct,
            });
            UI.ok(`${item.name} added — ${UI.money(item.price)}.`);
            draw();
          },
        });
      }

      const disc = el.querySelector('#b-discount');
      if (disc) disc.addEventListener('click', () => BillingTools.discount(inv, draw));
      el.querySelectorAll('#b-print, #b-print2').forEach((b) =>
        b.addEventListener('click', () => printInvoice(inv, UI.openPrintWindow())));
      const pay = el.querySelector('#b-pay');
      if (pay) pay.addEventListener('click', () => openPayment(inv, draw));
      const visit = el.querySelector('#b-visit');
      if (visit) visit.addEventListener('click', () =>
        APP.navigate('billing', { visitId: inv.visit_id }));
    };

    await draw();
  }

  /**
   * Open a bill for a patient who has not got one. Deliberately the only way
   * in: a bill needs a patient on it, because a receipt with no name on it is
   * money the clinic cannot account for later.
   */
  function openNewBill() {
    UI.modal({
      title: 'New bill', size: 'narrow',
      body: `<div class="muted small mb">Who is this bill for? Search by name, UHID or mobile.</div>
        <div class="search-row">
          <input type="search" id="nb-q" placeholder="Name, UHID or mobile number…" autocomplete="off">
        </div>
        <div id="nb-results" class="mt"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>`,
      onMount(modal) {
        const input = modal.querySelector('#nb-q');
        const results = modal.querySelector('#nb-results');
        let t;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = input.value.trim();
            if (q.length < 2) return void (results.innerHTML = '');
            let rows = [];
            try { rows = (await API.get('/api/patients' + API.qs({ q, limit: 8 }))).rows; }
            catch (err) { return void (results.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`); }
            results.innerHTML = rows.length ? rows.map((p) => `
              <button type="button" class="btn ghost sm block mb" data-pt="${p.id}"
                style="justify-content:space-between">
                <span><b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>
                  <span class="muted small"> ${UI.esc(p.uhid)}</span></span>
                <span class="muted small">${UI.esc(p.phone || '')}</span>
              </button>`).join('')
              : `<div class="muted small">Nobody matched. Register them at the front desk first.</div>`;
            results.querySelectorAll('[data-pt]').forEach((b) =>
              b.addEventListener('click', () => startBill(Number(b.dataset.pt))));
          }, 220);
        });
        setTimeout(() => input.focus(), 60);
      },
    });
  }

  async function startBill(patientId) {
    try {
      const inv = await API.post('/api/billing/invoices', { patientId, kind: 'opd' });
      UI.closeAllModals();
      UI.ok(`Bill ${inv.invoice_no} opened — add what the patient had.`);
      APP.navigate('billing', { invoiceId: inv.id });
    } catch (err) { UI.err(err.message); }
  }

  /** The charge board, posting straight onto this out-patient invoice. */
  function drawQuickAdd(host, inv, refresh) {
    return BillingTools.quickAdd(host, {
      async onAdd(item) {
        await API.post(`/api/billing/invoices/${inv.id}/items`, {
          refType: item.kind === 'test' ? 'lab' : 'service',
          refId: item.id, description: item.name, qty: 1,
          unitPrice: item.price, taxPct: item.taxPct,
        });
        UI.ok(`${item.name} added — ${UI.money(item.price)}.`);
        refresh();
      },
    });
  }

  const openBillDiscount = (inv, refresh) => BillingTools.discount(inv, refresh);

  // ---------------------------------------------------------------- invoice
  function invoiceBody(inv, opts) {
    const removable = !!(opts && opts.removable);
    return `
      <div class="row-between mb">
        <div><code>${UI.esc(inv.invoice_no)}</code> ${UI.statusBadge(inv.status)}</div>
        <span class="muted small">${UI.esc(UI.dateTime(inv.created_at))}</span>
      </div>

      <div class="table-wrap"><table><thead><tr>
        <th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>
        ${removable ? '<th></th>' : ''}
      </tr></thead><tbody>
        ${inv.items.map((i) => `<tr><td>${UI.esc(i.description)}</td>
          <td class="num">${UI.esc(i.qty)}</td><td class="num">${UI.money(i.unit_price)}</td>
          <td class="num">${UI.money(i.amount)}</td>
          ${removable ? `<td class="num"><button class="btn ghost sm" data-del-item="${i.id}"
            title="Take this off the bill">Remove</button></td>` : ''}</tr>`).join('')
          || `<tr><td colspan="${removable ? 5 : 4}" class="muted">Nothing on this bill yet —
               press a service below to put it on.</td></tr>`}
      </tbody></table></div>

      <div class="totals" style="margin-left:auto;width:320px;margin-top:14px">
        <div class="row-between"><span>Gross</span><b>${UI.money(inv.gross)}</b></div>
        ${BillingTools.concessionLines(inv)}
        ${inv.sliding_discount ? `<div class="row-between" style="color:var(--teal)"><span>Sliding-scale discount</span><span>− ${UI.money(inv.sliding_discount)}</span></div>` : ''}
        ${inv.assistance_covered ? `<div class="row-between" style="color:var(--ok)"><span>Assistance / exception</span><span>− ${UI.money(inv.assistance_covered)}</span></div>` : ''}
        ${inv.insurance_covered ? `<div class="row-between"><span>Insurance</span><span>− ${UI.money(inv.insurance_covered)}</span></div>` : ''}
        ${inv.tax ? `<div class="row-between"><span>Tax</span><span>+ ${UI.money(inv.tax)}</span></div>` : ''}
        <div class="row-between" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-size:16px">
          <b>Net payable</b><b>${UI.money(inv.net)}</b></div>
        <div class="row-between"><span>Paid</span><span>${UI.money(inv.paid)}</span></div>
        <div class="row-between" style="font-size:15px;color:${inv.balance > 0 ? 'var(--danger)' : 'var(--ok)'}">
          <b>Balance</b><b>${UI.money(inv.balance)}</b></div>
      </div>

      ${inv.payments.length ? `<h4 class="mt mb">Payments</h4>
        <div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Mode</th><th>Reference</th><th>By</th><th>When</th><th class="num">Amount</th></tr></thead><tbody>
        ${inv.payments.map((p) => `<tr><td><code>${UI.esc(p.receipt_no)}</code></td>
          <td>${UI.badge(UI.titleise(p.mode), 'teal')}</td><td>${UI.esc(p.reference || '—')}</td>
          <td>${UI.esc(p.received_by_name || '—')}</td><td>${UI.esc(UI.dateTime(p.paid_at))}</td>
          <td class="num">${UI.money(p.amount)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}

      ${inv.plan ? `<div class="alert info mt"><b>Payment plan ${UI.esc(inv.plan.agreement_no)}</b> —
        ${UI.esc(inv.plan.installments)} × ${UI.money(inv.plan.installment_amount)} ${UI.esc(inv.plan.frequency)},
        starting ${UI.esc(UI.date(inv.plan.start_date))}.
        <div class="table-wrap mt"><table><thead><tr><th>#</th><th>Due</th><th class="num">Amount</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead><tbody>
          ${(inv.plan.installments_list || []).map((i) => `<tr><td>${UI.esc(i.seq)}</td>
            <td>${UI.esc(UI.date(i.due_date))}</td><td class="num">${UI.money(i.amount)}</td>
            <td class="num">${UI.money(i.paid)}</td><td>${UI.statusBadge(i.status)}</td>
            <td>${i.status !== 'paid' ? `<button class="btn sm" data-pay-inst="${i.seq}" data-plan="${inv.plan.id}">Collect</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}

      ${inv.exceptions.length ? inv.exceptions.map((e) => `<div class="alert warn mt">
        <b>Payment exception:</b> ${UI.money(e.amount)} — ${UI.esc(e.reason)}
        <div class="muted small">${UI.esc(UI.dateTime(e.created_at))}</div></div>`).join('') : ''}

      <div class="btn-row mt no-print">
        ${inv.balance > 0 ? `
          <button class="btn" data-inv="pay">Accept payment</button>
          <button class="btn ghost" data-inv="plan">Payment plan agreement</button>
          <button class="btn ghost" data-inv="exception">Document exception</button>
          <button class="btn ghost" data-inv="assistance">Cover by assistance programme</button>` : ''}
        <button class="btn ghost" data-inv="item">Add a charge</button>
        <button class="btn ghost" data-inv="claim">Raise an insurance claim</button>
      </div>`;
  }

  function wireInvoiceActions(inv, refresh) {
    document.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.inv;
      if (act === 'pay') openPayment(inv, refresh);
      if (act === 'plan') openPlan(inv, refresh);
      if (act === 'exception') openException(inv, refresh);
      if (act === 'assistance') openAssistance(inv, refresh);
      if (act === 'item') openAddItem(inv, refresh);
      if (act === 'claim') openClaimFromInvoice(inv, refresh);
    }));
    document.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await API.del(`/api/billing/invoices/${inv.id}/items/${b.dataset.delItem}`);
        UI.ok('Charge taken off the bill.');
        refresh();
      } catch (err) { UI.err(err.message); b.disabled = false; }
    }));
    document.querySelectorAll('[data-pay-inst]').forEach((b) => b.addEventListener('click', async () => {
      const amount = prompt('Amount to collect for this instalment?');
      if (!amount) return;
      try {
        const r = await API.post(`/api/billing/payment-plans/${b.dataset.plan}/installments/${b.dataset.payInst}/pay`,
          { amount, mode: 'cash' });
        UI.ok(`Instalment collected — receipt ${r.receiptNo}.`);
        refresh();
      } catch (err) { UI.err(err.message); }
    }));
  }

  /** Branch: "Accept Payment". */
  function openPayment(inv, refresh) {
    UI.modal({
      title: 'Accept payment', size: 'narrow',
      body: `<div class="alert info">Outstanding balance: <b>${UI.money(inv.balance)}</b></div>
        <form id="pay-form">
          ${UI.field({ name: 'amount', label: 'Amount', type: 'number', step: '0.01', min: '0.01',
            max: inv.balance, value: inv.balance.toFixed(2), required: true })}
          ${UI.field({ name: 'mode', label: 'Mode', required: true,
            options: ['cash','upi','card','netbanking','cheque','insurance','wallet'].map((m) => ({ value: m, label: UI.titleise(m) })) })}
          ${UI.field({ name: 'reference', label: 'Reference / transaction ID' })}
          ${UI.field({ name: 'notes', label: 'Notes' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="pay">Record payment</button>`,
      async onAction(act, modal) {
        if (act !== 'pay') return;
        const form = modal.querySelector('#pay-form');
        if (!form.reportValidity()) return 'keep';
        const r = await API.post(`/api/billing/invoices/${inv.id}/payments`, UI.formValues(form));
        UI.ok(`Payment recorded — receipt ${r.receiptNo}. Sent to the patient on WhatsApp.`);
        printReceipt(r.receiptNo);
        refresh();
      },
    });
  }

  /** Branch: "No, or Not Completely" → "Payment Plan Agreement Form". */
  function openPlan(inv, refresh) {
    UI.modal({
      title: 'Payment plan agreement',
      body: `<div class="alert info">The patient cannot settle the full amount today. Record the instalment
          agreement they are signing — the balance stays on the invoice and is chased against the schedule.</div>
        <div class="alert warn">Balance to finance: <b>${UI.money(inv.balance)}</b></div>
        <form id="plan-form">
          <div class="grid c2">
            ${UI.field({ name: 'downPayment', label: 'Down payment today', type: 'number', step: '0.01', min: 0, value: 0 })}
            ${UI.field({ name: 'downPaymentMode', label: 'Down payment mode',
              options: ['cash','upi','card','netbanking'].map((m) => ({ value: m, label: UI.titleise(m) })) })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'installments', label: 'Number of instalments', type: 'number', min: 1, max: 60, value: 3, required: true })}
            ${UI.field({ name: 'frequency', label: 'Frequency', value: 'monthly',
              options: [{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }] })}
            ${UI.field({ name: 'startDate', label: 'First instalment on', type: 'date',
              value: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) })}
          </div>
          ${UI.field({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2 })}
        </form>
        <div id="plan-preview"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Create agreement</button>`,
      onMount(modal) {
        const preview = () => {
          const v = UI.formValues(modal.querySelector('#plan-form'));
          const financed = Math.max(inv.balance - Number(v.downPayment || 0), 0);
          const n = Number(v.installments) || 1;
          modal.querySelector('#plan-preview').innerHTML =
            `<div class="alert ok">Financing ${UI.money(financed)} over ${n} instalment(s) of
             about <b>${UI.money(financed / n)}</b> each, ${UI.esc(v.frequency || 'monthly')}.</div>`;
        };
        modal.querySelectorAll('#plan-form input, #plan-form select').forEach((i) => {
          i.addEventListener('input', preview); i.addEventListener('change', preview);
        });
        preview();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#plan-form');
        if (!form.reportValidity()) return 'keep';
        const r = await API.post(`/api/billing/invoices/${inv.id}/payment-plan`, UI.formValues(form));
        UI.ok(`Agreement ${r.plan.agreement_no} recorded — the patient can now be checked out.`);
        printAgreement(r);
        refresh();
      },
    });
  }

  /** Branch: "Document Payment Exception". */
  function openException(inv, refresh) {
    UI.modal({
      title: 'Document a payment exception', size: 'narrow',
      body: `<div class="alert warn">This writes off part or all of the outstanding balance. The reason is recorded
          against your name in the audit log.</div>
        <form id="exc-form">
          ${UI.field({ name: 'amount', label: 'Amount to write off', type: 'number', step: '0.01',
            min: '0.01', max: inv.balance, value: inv.balance.toFixed(2), required: true })}
          ${UI.field({ name: 'reason', label: 'Reason', type: 'textarea', rows: 3, required: true,
            placeholder: 'e.g. patient unable to pay, approved by clinic manager under the charity policy' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn warn" data-act="save">Record exception</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#exc-form');
        if (!form.reportValidity()) return 'keep';
        await API.post(`/api/billing/invoices/${inv.id}/exception`, UI.formValues(form));
        UI.ok('Exception documented — the patient can be checked out.');
        refresh();
      },
    });
  }

  /** Branch: "No Cost, Covered by Assistance Program". */
  async function openAssistance(inv, refresh) {
    const programs = await API.get('/api/masters/assistance-programs');
    UI.modal({
      title: 'Cover by assistance programme', size: 'narrow',
      body: `<div class="alert info">Applies the programme's coverage percentage to this bill.</div>
        <form id="as-form">${UI.field({ name: 'assistanceProgramId', label: 'Programme', required: true,
          options: [{ value: '', label: '— select —' }].concat(programs.map((p) =>
            ({ value: p.id, label: `${p.name} — ${p.coverage_pct}% cover` }))) })}</form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Apply cover</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#as-form');
        if (!form.reportValidity()) return 'keep';
        const r = await API.post(`/api/billing/invoices/${inv.id}/assistance-cover`, UI.formValues(form));
        UI.ok(`${r.program.name} applied — ${UI.money(r.covered)} covered.`);
        refresh();
      },
    });
  }

  async function openAddItem(inv, refresh) {
    const services = await API.get('/api/masters/services');
    UI.modal({
      title: 'Add a charge', size: 'narrow',
      body: `<form id="it-form">
        ${UI.field({ name: 'serviceId', label: 'Service',
          options: [{ value: '', label: '— free text —' }].concat(services.map((s) =>
            ({ value: s.id, label: `${s.name} — ${s.price}` }))) })}
        ${UI.field({ name: 'description', label: 'Description', required: true })}
        <div class="grid c2">
          ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1 })}
          ${UI.field({ name: 'unitPrice', label: 'Rate', type: 'number', step: '0.01', required: true })}
        </div>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Add</button>`,
      onMount(modal) {
        modal.querySelector('[name=serviceId]').addEventListener('change', (e) => {
          const s = services.find((x) => x.id === Number(e.target.value));
          if (!s) return;
          modal.querySelector('[name=description]').value = s.name;
          modal.querySelector('[name=unitPrice]').value = s.price;
        });
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#it-form');
        if (!form.reportValidity()) return 'keep';
        await API.post(`/api/billing/invoices/${inv.id}/items`, UI.formValues(form));
        UI.ok('Charge added.');
        refresh();
      },
    });
  }

  /** Shortcut from a bill straight into a claim, using the patient's policies. */
  async function openClaimFromInvoice(inv, refresh) {
    const ins = await API.get(`/api/insurance/patient/${inv.patient_id}`);
    if (!ins.policies.length) {
      return UI.err('No insurance policy on file for this patient. Add one under Insurance & TPA.');
    }
    const approved = ins.preauths.filter((p) => ['approved', 'partially_approved'].includes(p.status));
    UI.modal({
      title: `Raise a claim on ${inv.invoice_no}`,
      body: `<div class="alert info">The claim is built from this bill's own lines. Obvious exclusions are
          pre-marked as non-admissible for you to confirm.</div>
        <form id="cfi-form">
          ${UI.field({ name: 'policyId', label: 'Policy', required: true,
            options: ins.policies.map((p) => ({ value: p.id, label: `${p.insurer_name} · ${p.policy_no} (balance ${p.balance})` })) })}
          ${UI.field({ name: 'preauthId', label: 'Against pre-authorisation',
            options: [{ value: '', label: '— none —' }].concat(approved.map((p) =>
              ({ value: p.id, label: `${p.preauth_no} · approved ${p.approved_amount}` }))) })}
          ${UI.field({ name: 'claimType', label: 'Claim type', value: approved.length ? 'cashless' : 'reimbursement',
            options: [{ value: 'cashless', label: 'Cashless — insurer pays the clinic' },
                      { value: 'reimbursement', label: 'Reimbursement — insurer pays the patient' }] })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Build the claim</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#cfi-form');
        if (!form.reportValidity()) return 'keep';
        const claim = await API.post('/api/insurance/claims', {
          invoiceId: inv.id, ...UI.formValues(form),
        });
        UI.ok(`Claim ${claim.claim_no} built.`);
        APP.navigate('insurance', { claimId: claim.id });
      },
    });
    void refresh;
  }

  // ----------------------------------------------------------- invoice modal
  async function openInvoice(id) {
    const inv = await API.get(`/api/billing/invoices/${id}`);
    UI.modal({
      title: `${inv.invoice_no} — ${inv.first_name} ${inv.last_name || ''}`,
      size: 'wide',
      body: invoiceBody(inv),
      footer: `<button class="btn ghost" data-act="print">Print invoice</button>
               <button class="btn ghost" data-act="__close">Close</button>`,
      onMount() { wireInvoiceActions(inv, () => { UI.closeAllModals(); openInvoice(id); }); },
      onAction(act) { if (act === 'print') { printInvoice(inv, UI.openPrintWindow()); return 'keep'; } },
    });
  }
  APP.openInvoice = openInvoice;

  /*
   * Printing a bill or a receipt from somewhere else in the app — a report
   * list, a dashboard drill-down — where only its number is known.
   *
   * The caller claims the print window on the click and hands it over, because
   * the document has to be fetched first and a browser only allows a popup
   * while it can still see the gesture that asked for it.
   */
  APP.printInvoiceById = async (id, windowRef = null) => {
    const win = windowRef || UI.openPrintWindow();
    try {
      printInvoice(await API.get(`/api/billing/invoices/${id}`), win);
    } catch (err) {
      UI.err(err.message);
      if (win) win.close();
    }
  };
  APP.printReceipt = printReceipt;

  // ---------------------------------------------------------- printable docs
  /**
   * The bill. The treating doctor appears as their code — SPC-MHD-002 — and not
   * by name, the same rule the prescription and the report follow: a bill goes
   * home with the patient and on to their insurer.
   */
  async function printInvoice(inv, windowRef = null) {
    // Claim the window on the click, before the QR is fetched: a browser only
    // allows a popup while it can still see the gesture that asked for it.
    const win = windowRef || UI.openPrintWindow();
    let pay = null;
    try { pay = await API.get(`/api/billing/invoices/${inv.id}/upi`); } catch { pay = null; }

    const age = inv.age_years ? `${inv.age_years} yrs` : '—';
    const concessions = [
      ['Line discounts', inv.discount],
      [`Discount${inv.bill_discount_reason ? ' — ' + inv.bill_discount_reason : ''}`, inv.bill_discount],
      ['Sliding-scale concession', inv.sliding_discount],
      ['Assistance programme', inv.assistance_covered],
      ['Insurance', inv.insurance_covered],
    ].filter(([, v]) => Number(v) > 0);

    const html = `${UI.sheetStyles()}
      <style>
        .inv-tot { margin-top: 10px; margin-left: auto; width: 62mm; }
        .inv-tot .line { display: flex; justify-content: space-between; padding: 2px 0; }
        .inv-tot .line.off { color: #B06A00; }
        .inv-tot .line.grand {
          border-top: 1px solid #16232B; margin-top: 4px; padding-top: 5px;
          font-size: 13px; font-weight: 700;
        }
        .inv-tot .line.due { font-weight: 700; color: #9E1B34; }
        .inv-words { margin-top: 6px; font-size: 9px; color: #5A6B74; font-style: italic; }
        /* Pay-by-phone panel. The square has to survive being printed small and
           photographed off paper, so it is given room and a quiet border. */
        .inv-pay { display: flex; gap: 10px; align-items: center; margin-top: 12px;
                   border: 1px solid #E4EAED; border-radius: 4px; padding: 8px 10px; }
        .inv-pay .qr { width: 27mm; height: 27mm; flex: none; }
        .inv-pay .qr svg { width: 100%; height: 100%; display: block; }
        .inv-pay .k { font-size: 7.5px; letter-spacing: .9px; text-transform: uppercase;
                      color: #8B9AA2; font-weight: 600; }
        .inv-pay .vpa { font-weight: 700; font-size: 11.5px; }
        .inv-pay .amt { font-size: 13px; font-weight: 700; color: #9E1B34; }
        .inv-pay .how { font-size: 8.5px; color: #5A6B74; margin-top: 3px; line-height: 1.5; }
        .inv-paid { margin-top: 12px; text-align: center; font-weight: 700; color: #1B7A4B;
                    border: 1px dashed #1B7A4B; border-radius: 4px; padding: 6px; letter-spacing: 2px; }
      </style>
      <div class="sheet">
        ${UI.sheetHead('Tax Invoice')}

        <div class="who">
          <div style="grid-column:span 2">
            <div class="k">Patient</div>
            <div class="v lead">${UI.esc(inv.first_name)} ${UI.esc(inv.last_name || '')}</div>
          </div>
          <div><div class="k">Age / Sex</div>
            <div class="v">${UI.esc(age)} · ${UI.esc(UI.titleise(inv.gender || '—'))}</div></div>
          <div><div class="k">UHID</div><div class="v">${UI.esc(inv.uhid || '—')}</div></div>
          <div><div class="k">Invoice</div><div class="v">${UI.esc(inv.invoice_no)}</div></div>
          <div><div class="k">Date</div><div class="v">${UI.esc(UI.date(inv.created_at))}</div></div>
          <div><div class="k">Mobile</div><div class="v">${UI.esc(inv.phone || '—')}</div></div>
          <div><div class="k">Aadhaar</div><div class="v">${aadhaarDigits(inv.aadhaar_number)}</div></div>
          ${inv.visit_no || inv.ip_no
            ? `<div><div class="k">${inv.ip_no ? 'Admission' : 'Visit'}</div>
                 <div class="v">${UI.esc(inv.ip_no || inv.visit_no)}</div></div>` : ''}
          ${inv.doctor_code ? `<div><div class="k">Doctor code</div>
            <div class="v">${UI.esc(inv.doctor_code)}</div></div>` : ''}
          <div><div class="k">Bill type</div><div class="v">${UI.esc(UI.titleise(inv.kind))}</div></div>
        </div>

        <table class="mt"><thead><tr>
          <th style="width:16px">#</th><th>Particulars</th>
          <th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>
        </tr></thead><tbody>
          ${inv.items.map((i, n) => `<tr><td>${n + 1}</td>
            <td>${UI.esc(i.description)}</td>
            <td class="num">${UI.esc(i.qty)}</td>
            <td class="num">${UI.money(i.unit_price)}</td>
            <td class="num">${UI.money(i.amount)}</td></tr>`).join('')
            || '<tr><td colspan="5">No charges on this bill.</td></tr>'}
        </tbody></table>

        <div class="inv-tot">
          <div class="line"><span>Gross</span><span>${UI.money(inv.gross)}</span></div>
          ${concessions.map(([label, v]) =>
            `<div class="line off"><span>${UI.esc(label)}</span><span>− ${UI.money(v)}</span></div>`).join('')}
          ${inv.tax ? `<div class="line"><span>Tax</span><span>${UI.money(inv.tax)}</span></div>` : ''}
          <div class="line grand"><span>Net payable</span><span>${UI.money(inv.net)}</span></div>
          ${inv.paid ? `<div class="line"><span>Paid</span><span>${UI.money(inv.paid)}</span></div>` : ''}
          ${inv.balance > 0.009
            ? `<div class="line due"><span>Balance due</span><span>${UI.money(inv.balance)}</span></div>` : ''}
        </div>
        <div class="inv-words">Rupees ${UI.esc(rupeesInWords(inv.net))} only.</div>

        ${inv.balance > 0.009 && pay && pay.svg ? `
          <div class="inv-pay">
            <div class="qr">${pay.svg}</div>
            <div>
              <div class="k">Scan to pay by UPI</div>
              <div class="amt">${UI.money(pay.amount)}</div>
              <div class="vpa">${UI.esc(pay.upiId)}</div>
              <div class="how">Open any UPI app — GPay, PhonePe, Paytm, BHIM — scan this code and
                confirm. The amount and the invoice number ${UI.esc(inv.invoice_no)} are already in it.
                <br>Payable to ${UI.esc(pay.payee || '')}.</div>
            </div>
          </div>` : ''}
        ${inv.balance <= 0.009 && inv.net > 0 ? '<div class="inv-paid">PAID IN FULL</div>' : ''}

        ${inv.payments && inv.payments.length ? `
          <div class="block"><div class="k">Payments received</div>
            <table><tbody>
              ${inv.payments.map((p) => `<tr>
                <td>${UI.esc(UI.date(p.paid_at))} · ${UI.esc(UI.titleise(p.mode))}${
                  p.reference ? ' · ' + UI.esc(p.reference) : ''}</td>
                <td class="num">${UI.money(p.amount)}</td>
                <td class="num">${UI.esc(p.receipt_no)}</td></tr>`).join('')}
            </tbody></table></div>` : ''}

        <div class="stamp-row">
          <div class="stamp"><div class="box"></div>
            <div class="cap">For ${UI.esc((APP.clinic || {}).name || '')}</div></div>
        </div>

        <div class="note">Computer-generated invoice — valid without a signature.
          Please keep it for your records and for any insurance reimbursement.
          ${(APP.clinic || {}).gstin ? `GSTIN ${UI.esc(APP.clinic.gstin)}.` : ''}</div>
      </div>`;

    UI.printSheet(html, 'Invoice ' + inv.invoice_no, win);
  }

  /** Aadhaar as it is written on the card: four, four, four. */
  function aadhaarDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length !== 12) return '—';
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  }

  /**
   * The amount in words, which an invoice carries so a figure cannot be
   * altered after it is printed. Indian numbering: lakh and crore, not million.
   */
  function rupeesInWords(amount) {
    const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
      'nineteen'];
    const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? '-' + ONES[n % 10] : ''}`);
    const under1000 = (n) => [
      n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred` : '',
      n % 100 ? under100(n % 100) : '',
    ].filter(Boolean).join(' ');

    const whole = Math.floor(Math.abs(Number(amount) || 0));
    const paise = Math.round((Math.abs(Number(amount) || 0) - whole) * 100);
    if (!whole && !paise) return 'zero';

    const parts = [];
    const groups = [[10000000, 'crore'], [100000, 'lakh'], [1000, 'thousand']];
    let left = whole;
    for (const [size, label] of groups) {
      if (left >= size) {
        parts.push(`${under1000(Math.floor(left / size))} ${label}`);
        left %= size;
      }
    }
    if (left) parts.push(under1000(left));
    const words = parts.join(' ').replace(/\s+/g, ' ').trim();
    const capped = words.charAt(0).toUpperCase() + words.slice(1);
    return paise ? `${capped || 'Zero'} and ${under100(paise)} paise` : capped;
  }

  /**
   * The receipt. The cashier who took the money signs it — they are the clinic's
   * own counter — but the treating doctor appears only as their code, the same
   * rule the bill it settles follows.
   */
  async function printReceipt(receiptNo, windowRef = null) {
    const win = windowRef || UI.openPrintWindow();
    let r;
    try { r = await API.get(`/api/billing/receipts/${receiptNo}`); }
    catch (err) { UI.err(err.message); if (win) win.close(); return; }
    const html = `<div class="doc">
      ${UI.docHeader('Payment Receipt', [`Receipt: ${r.receipt_no}`, `Date: ${UI.dateTime(r.paid_at)}`])}
      <table><tbody>
        <tr><th>Received from</th><td>${UI.esc(r.first_name)} ${UI.esc(r.last_name || '')} (${UI.esc(r.uhid)})</td></tr>
        <tr><th>Against invoice</th><td>${UI.esc(r.invoice_no)}${
          r.visit_no || r.ip_no ? ` · ${UI.esc(r.visit_no || r.ip_no)}` : ''}</td></tr>
        ${r.doctor_code ? `<tr><th>Treating doctor</th><td>${UI.esc(r.doctor_code)}</td></tr>` : ''}
        <tr><th>Mode</th><td>${UI.esc(UI.titleise(r.mode))} ${r.reference ? '· ' + UI.esc(r.reference) : ''}</td></tr>
        <tr><th>Amount received</th><td style="font-size:19px"><b>${UI.money(r.amount)}</b></td></tr>
        <tr><th>Invoice balance</th><td>${UI.money(r.balance)}</td></tr>
      </tbody></table>
      <div class="sign"><div></div><div>${UI.esc(r.received_by_name || '')}<br>Received by</div></div>
      <div class="foot-note">Thank you. Cheques are subject to realisation.</div>
    </div>`;
    UI.print(html, 'Receipt ' + receiptNo, { windowRef: win });
  }

  function printAgreement(r) {
    const p = r.plan;
    const html = `<div class="doc">
      ${UI.docHeader('Payment Plan Agreement', [`Agreement: ${p.agreement_no}`, `Date: ${UI.date(p.created_at)}`])}
      <p>This agreement records the instalment arrangement between the patient and
         ${UI.esc(APP.clinic.name)} for the amount outstanding on invoice
         <b>${UI.esc(r.invoice.invoice_no)}</b>.</p>
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(r.invoice.first_name)} ${UI.esc(r.invoice.last_name || '')} (${UI.esc(r.invoice.uhid)})</td></tr>
        <tr><th>Amount financed</th><td><b>${UI.money(p.total_amount)}</b></td></tr>
        <tr><th>Down payment</th><td>${UI.money(p.down_payment)}</td></tr>
        <tr><th>Instalments</th><td>${UI.esc(p.installments)} × ${UI.money(p.installment_amount)}, ${UI.esc(p.frequency)}</td></tr>
        <tr><th>First due</th><td>${UI.esc(UI.date(p.start_date))}</td></tr>
      </tbody></table>
      <table class="mt"><thead><tr><th>#</th><th>Due date</th><th class="num">Amount</th></tr></thead><tbody>
        ${r.schedule.map((i) => `<tr><td>${UI.esc(i.seq)}</td><td>${UI.esc(UI.date(i.due_date))}</td>
          <td class="num">${UI.money(i.amount)}</td></tr>`).join('')}
      </tbody></table>
      <p class="mt small">I agree to pay the amounts above on or before the dates shown. I understand that
         missed instalments may be followed up by the clinic.</p>
      <div class="sign"><div>Patient / guarantor signature<br>Date: ____________</div>
        <div>For ${UI.esc(APP.clinic.name)}<br>Authorised signatory</div></div>
    </div>`;
    UI.print(html, 'Payment plan ' + p.agreement_no);
  }

  async function openDaybook() {
    const date = UI.today();
    const d = await API.get('/api/billing/daybook' + API.qs({ date }));
    UI.modal({
      title: `Day book — ${UI.date(date)}`,
      size: 'wide',
      body: `<div class="grid c2 mb">
          <div class="stat ok"><div class="label">Total collected</div><div class="value">${UI.money(d.total)}</div></div>
          <div class="stat teal"><div class="label">Receipts</div><div class="value">${UI.num(d.payments.length)}</div></div>
        </div>
        <h4 class="mb">By mode</h4>
        ${UI.bars(d.byMode.map((m) => ({ label: UI.titleise(m.mode), value: m.total, display: UI.money(m.total) })))}
        <h4 class="mt mb">By counter</h4>
        ${UI.bars(d.byUser.map((u) => ({ label: u.name || '—', value: u.total, display: UI.money(u.total) })), { colour: 'crimson' })}
        <h4 class="mt mb">Receipts</h4>
        ${UI.table([
          { label: 'Receipt', key: 'receipt_no' },
          { label: 'Patient', render: (p) => `${UI.esc(p.patient_name)} (${UI.esc(p.uhid)})` },
          { label: 'Invoice', key: 'invoice_no' },
          { label: 'Mode', render: (p) => UI.titleise(p.mode) },
          { label: 'Time', render: (p) => UI.time(p.paid_at) },
          { label: 'Amount', num: true, render: (p) => UI.money(p.amount) },
        ], d.payments, { emptyText: 'No payments taken today.' })}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>`,
    });
  }
  // Exposed so the browser checks can print without hunting for a button.
  window.__printInvoice = printInvoice;
  window.__printReceipt = printReceipt;
})();
