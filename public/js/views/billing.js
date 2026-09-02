/* Check-out desk: bill assembly, payment, payment plans and exceptions. */
(function () {
  'use strict';

  APP.register('billing', {
    title: 'Billing & Check-out',
    subtitle: 'Payments, plans and assistance cover',

    async render(el, params) {
      if (params.visitId) return renderCheckout(el, Number(params.visitId));

      APP.actions([{ id: 'daybook', label: 'Day book', onClick: openDaybook }]);

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
                  r.state === 'to_collect' ? 'Collect' : 'Open'}</button>` : '') },
          ], pending.rows, {
            emptyText: 'Nobody is booked and nobody has walked in today.',
          });
          host.querySelectorAll('[data-visit]').forEach((b) => b.addEventListener('click', () =>
            APP.navigate('billing', { visitId: b.dataset.visit })));
        },

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
          UI.bindRows(host, invoices.rows, (i) => openInvoice(i.id));
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
      if (printBtn) printBtn.addEventListener('click', () => printInvoice(invoice));

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
  function invoiceBody(inv) {
    return `
      <div class="row-between mb">
        <div><code>${UI.esc(inv.invoice_no)}</code> ${UI.statusBadge(inv.status)}</div>
        <span class="muted small">${UI.esc(UI.dateTime(inv.created_at))}</span>
      </div>

      <div class="table-wrap"><table><thead><tr>
        <th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>
      </tr></thead><tbody>
        ${inv.items.map((i) => `<tr><td>${UI.esc(i.description)}</td>
          <td class="num">${UI.esc(i.qty)}</td><td class="num">${UI.money(i.unit_price)}</td>
          <td class="num">${UI.money(i.amount)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">No charges on this bill.</td></tr>'}
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
      onAction(act) { if (act === 'print') { printInvoice(inv); return 'keep'; } },
    });
  }
  APP.openInvoice = openInvoice;

  // ---------------------------------------------------------- printable docs
  /**
   * The bill. The treating doctor appears as their code — SPC-MHD-002 — and not
   * by name, the same rule the prescription and the report follow: a bill goes
   * home with the patient and on to their insurer.
   */
  function printInvoice(inv) {
    const html = `<div class="doc">
      ${UI.docHeader('Tax Invoice', [`Invoice: ${inv.invoice_no}`, `Date: ${UI.date(inv.created_at)}`,
        `Status: ${UI.titleise(inv.status)}`])}
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(inv.first_name)} ${UI.esc(inv.last_name || '')}</td>
            <th>UHID</th><td>${UI.esc(inv.uhid)}</td></tr>
        <tr><th>Phone</th><td>${UI.esc(inv.phone || '—')}</td>
            <th>Type</th><td>${UI.esc(inv.kind.toUpperCase())}</td></tr>
        ${inv.doctor_code ? `<tr><th>Treating doctor</th><td>${UI.esc(inv.doctor_code)}</td>
            <th>Visit</th><td>${UI.esc(inv.visit_no || inv.ip_no || '—')}</td></tr>` : ''}
      </tbody></table>
      <table class="mt"><thead><tr><th>#</th><th>Description</th><th class="num">Qty</th>
        <th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
        ${inv.items.map((i, n) => `<tr><td>${n + 1}</td><td>${UI.esc(i.description)}</td>
          <td class="num">${UI.esc(i.qty)}</td><td class="num">${UI.money(i.unit_price)}</td>
          <td class="num">${UI.money(i.amount)}</td></tr>`).join('')}
      </tbody></table>
      <div class="totals">
        <div class="line"><span>Gross</span><span>${UI.money(inv.gross)}</span></div>
        ${inv.discount ? `<div class="line"><span>Line discounts</span><span>− ${UI.money(inv.discount)}</span></div>` : ''}
        ${inv.bill_discount ? `<div class="line"><span>Discount</span><span>− ${UI.money(inv.bill_discount)}</span></div>` : ''}
        ${inv.sliding_discount ? `<div class="line"><span>Sliding-scale discount</span><span>− ${UI.money(inv.sliding_discount)}</span></div>` : ''}
        ${inv.assistance_covered ? `<div class="line"><span>Assistance programme</span><span>− ${UI.money(inv.assistance_covered)}</span></div>` : ''}
        ${inv.tax ? `<div class="line"><span>Tax</span><span>${UI.money(inv.tax)}</span></div>` : ''}
        <div class="line grand"><span>Net payable</span><span>${UI.money(inv.net)}</span></div>
        <div class="line"><span>Paid</span><span>${UI.money(inv.paid)}</span></div>
        <div class="line"><span>Balance</span><span>${UI.money(inv.balance)}</span></div>
      </div>
      <div class="sign"><div>Patient signature</div><div>For ${UI.esc(APP.clinic.name)}<br>Authorised signatory</div></div>
      <div class="foot-note">This is a computer-generated invoice. Please retain it for your records and for
        insurance reimbursement.</div>
    </div>`;
    UI.print(html, 'Invoice ' + inv.invoice_no);
  }

  /**
   * The receipt. The cashier who took the money signs it — they are the clinic's
   * own counter — but the treating doctor appears only as their code, the same
   * rule the bill it settles follows.
   */
  async function printReceipt(receiptNo) {
    const r = await API.get(`/api/billing/receipts/${receiptNo}`);
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
    UI.print(html, 'Receipt ' + receiptNo);
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
