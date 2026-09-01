/* Diagnostics desk: order → sample → process → result → verify → report. */
(function () {
  'use strict';

  APP.register('lab', {
    title: 'Diagnostics',
    subtitle: 'Laboratory and radiology workflow',

    async render(el, params) {
      const res = await API.get('/api/lab/orders' + API.qs({ status: params.status, visitId: params.visitId }));
      const c = res.counts;

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">Awaiting sample</div><div class="value">${UI.num(c.ordered || 0)}</div>
            <div class="foot">Collect and label</div></div>
          <div class="stat orange"><div class="label">In process</div>
            <div class="value">${UI.num((c.sample_collected || 0) + (c.in_process || 0))}</div><div class="foot">On the analyser</div></div>
          <div class="stat teal"><div class="label">Awaiting verification</div><div class="value">${UI.num(c.result_entered || 0)}</div>
            <div class="foot">Results entered, not released</div></div>
          <div class="stat ok"><div class="label">Reported</div><div class="value">${UI.num(c.reported || 0)}</div>
            <div class="foot">Released to the patient</div></div>
        </div>

        <div class="search-row">
          <select id="l-status">
            <option value="">All statuses</option>
            ${['ordered','sample_collected','in_process','result_entered','reported','cancelled'].map((s) =>
              `<option value="${s}"${params.status === s ? ' selected' : ''}>${UI.titleise(s)}</option>`).join('')}
          </select>
        </div>

        <div class="card"><div class="card-body tight" id="lo-list"></div></div>`;

      el.querySelector('#l-status').addEventListener('change', (e) =>
        APP.navigate('lab', { status: e.target.value }));

      const host = el.querySelector('#lo-list');
      host.innerHTML = UI.table([
        { label: 'Order', render: (o) => `<code>${UI.esc(o.order_no)}</code>` +
          (o.priority !== 'routine' ? ' ' + UI.badge(o.priority.toUpperCase(), o.priority === 'stat' ? 'danger' : 'warn') : '') },
        { label: 'Patient', render: (o) => `<b>${UI.esc(o.patient_name)}</b><div class="muted small">${UI.esc(o.uhid)} · ${UI.esc(o.age_years || '—')}${UI.esc((o.gender || '').charAt(0).toUpperCase())}</div>` },
        { label: 'Source', render: (o) => UI.esc(o.ip_no || o.visit_no || '—') },
        { label: 'Tests', render: (o) => `<div class="small">${UI.esc(o.tests || '')}</div>` },
        { label: 'Doctor', render: (o) => UI.esc(o.doctor_name || '—') },
        { label: 'Status', render: (o) => UI.statusBadge(o.status) },
        { label: 'Ordered', render: (o) => UI.esc(UI.ago(o.ordered_at)) },
        { label: 'Amount', num: true, render: (o) => UI.money(o.total_price) },
      ], res.rows, { emptyText: 'No diagnostic orders match this filter.' });
      UI.bindRows(host, res.rows, (o) => openOrder(o.id));
    },
  });

  async function openOrder(id) {
    const o = await API.get(`/api/lab/orders/${id}`);
    const canEdit = APP.can(['lab']);

    const rows = o.items.map((i) => `<tr>
      <td><b>${UI.esc(i.test_name)}</b><div class="muted small">${UI.esc(i.ref_range || '')} ${UI.esc(i.unit || '')}</div></td>
      <td>${canEdit && ['in_process', 'sample_collected', 'result_entered'].includes(i.status)
        ? `<input type="text" data-item="${i.id}" value="${UI.esc(i.result_value || '')}" placeholder="value">`
        : `<b>${UI.esc(i.result_value || '—')}</b>`}</td>
      <td>${UI.esc(i.unit || '')}</td>
      <td>${UI.esc(i.ref_range || '—')}</td>
      <td>${i.abnormal_flag ? UI.badge(UI.titleise(i.abnormal_flag),
        i.abnormal_flag === 'critical' ? 'danger' : i.abnormal_flag === 'normal' ? 'ok' : 'warn') : '—'}</td>
      <td>${UI.statusBadge(i.status)}</td>
    </tr>`).join('');

    UI.modal({
      title: `${o.order_no} — ${o.patient_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(o.status)}
            ${o.priority !== 'routine' ? UI.badge(o.priority.toUpperCase(), o.priority === 'stat' ? 'danger' : 'warn') : ''}
            ${UI.badge(o.uhid, 'teal')}</div>
          <span class="muted small">Ordered ${UI.dateTime(o.ordered_at)} by ${UI.esc(o.doctor_name || '—')}</span>
        </div>
        ${o.clinical_notes ? `<div class="alert info"><b>Clinical notes:</b> ${UI.esc(o.clinical_notes)}</div>` : ''}
        ${o.samples.length ? `<div class="alert ok"><b>Sample:</b> <code>${UI.esc(o.samples[0].barcode)}</code>
          collected ${UI.esc(UI.dateTime(o.samples[0].collected_at))}</div>` : ''}

        <div class="table-wrap"><table><thead><tr>
          <th>Test</th><th>Result</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Status</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${['result_entered','verified','reported'].includes(o.status) ? '<button class="btn ghost" data-act="print">Print report</button>' : ''}
        ${canEdit && o.status === 'ordered' ? '<button class="btn teal" data-act="collect">Collect sample</button>' : ''}
        ${canEdit && o.status === 'sample_collected' ? '<button class="btn teal" data-act="start">Start processing</button>' : ''}
        ${canEdit && ['in_process','sample_collected','result_entered'].includes(o.status) ? '<button class="btn" data-act="save">Save results</button>' : ''}
        ${APP.can(['lab','doctor']) && o.status === 'result_entered' ? '<button class="btn ok" data-act="verify">Verify &amp; release</button>' : ''}`,

      async onAction(act, modal) {
        if (act === 'print') return printReport(o);
        if (act === 'collect') {
          const r = await API.post(`/api/lab/orders/${id}/collect`, { sampleType: 'blood' });
          UI.ok(`Sample collected — barcode ${r.barcode}.`);
        } else if (act === 'start') {
          await API.post(`/api/lab/orders/${id}/start`);
          UI.ok('Order moved to processing.');
        } else if (act === 'save') {
          const results = [...modal.querySelectorAll('[data-item]')]
            .filter((i) => i.value.trim())
            .map((i) => ({ itemId: Number(i.dataset.item), value: i.value.trim() }));
          if (!results.length) { UI.err('Enter at least one result.'); return 'keep'; }
          await API.post(`/api/lab/orders/${id}/results`, { results });
          UI.ok(`${results.length} result(s) saved.`);
        } else if (act === 'verify') {
          const r = await API.post(`/api/lab/orders/${id}/verify`);
          UI.ok('Report verified and released — the patient has been notified on WhatsApp.');
          if (r.criticalResults.length) {
            UI.err(`⚠ Critical: ${r.criticalResults.map((c) => `${c.test_name} ${c.result_value}`).join(', ')} — inform the doctor.`);
          }
        } else return;
        APP.reload();
      },
    });
  }

  /**
   * The diagnostic report, in the same form as the prescription: the
   * polyclinic's name and address at the top, the results in the middle, and a
   * blank box at the bottom for the reporting doctor to stamp and sign by hand.
   *
   * No doctor is named on it. The referring doctor appears as their code —
   * SPC-MHD-002 — which tells the clinic who ordered the test and tells a
   * patient nothing they could use to reach a doctor directly.
   */
  async function printReport(order) {
    const o = await API.get(`/api/lab/orders/${order.id}/report`);
    const c = APP.clinic || {};
    const age = o.age_years ? `${o.age_years} yrs` : '—';
    const abnormal = o.items.filter((i) => i.abnormal_flag && i.abnormal_flag !== 'normal');

    UI.print(`
      <style>
        @page { size: A5 portrait; margin: 9mm; }
        .lr { width: 128mm; margin: 0 auto; font-family: Georgia, "Times New Roman", serif;
              color: #16232B; font-size: 11px; }
        .lr-head { text-align: center; border-bottom: 2px solid #9E1B34; padding-bottom: 6px; }
        .lr-head .clinic { font-size: 17px; font-weight: 700; letter-spacing: .5px; color: #9E1B34; }
        .lr-head .tag { font-size: 8px; letter-spacing: 1.4px; text-transform: uppercase; color: #176B7C; margin-top: 2px; }
        .lr-head .addr { font-size: 9.5px; color: #43555F; margin-top: 3px; }
        .lr-title { margin-top: 6px; font-size: 11px; font-weight: 700; letter-spacing: 2.4px;
                    text-transform: uppercase; color: #176B7C; }
        .lr-patient { display: flex; flex-wrap: wrap; gap: 3px 16px; padding: 8px 0;
          border-bottom: 1px dashed #B9C6CC; font-size: 10.5px; }
        table.lr-res { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 8px; }
        table.lr-res th { text-align: left; font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase;
          color: #74858E; border-bottom: 1px solid #16232B; padding: 0 4px 3px; font-weight: 600; }
        table.lr-res td { padding: 5px 4px; border-bottom: 1px dotted #DFE6EA; vertical-align: top; }
        table.lr-res .test { font-weight: 700; }
        table.lr-res .val { font-weight: 700; text-align: right; white-space: nowrap; }
        table.lr-res .flag { text-align: right; font-weight: 700; font-size: 9.5px; white-space: nowrap; }
        table.lr-res .high { color: #B03A2E; }
        table.lr-res .low  { color: #B26A00; }
        .lr-note { font-size: 10px; margin-top: 8px; }
        .lr-note .k { color: #74858E; font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; }
        .lr-sign { margin-top: 16px; display: flex; justify-content: flex-end; }
        .lr-stamp { text-align: center; width: 58mm; }
        .lr-stamp-box { height: 22mm; border: 1px dashed #B9C6CC; border-radius: 3px; }
        .lr-stamp-label { margin-top: 3px; font-size: 8.5px; color: #74858E;
          letter-spacing: .06em; text-transform: uppercase; }
        .lr-foot { margin-top: 12px; border-top: 1px solid #DFE6EA; padding-top: 5px;
          font-size: 8.5px; color: #74858E; text-align: center; }
        @media screen { body { background: #eef1f3; padding: 14px 0; }
          .lr { background: #fff; padding: 9mm; box-shadow: 0 2px 14px rgba(0,0,0,.15); } }
      </style>
      <div class="lr">
        <div class="lr-head">
          <div class="clinic">${UI.esc(c.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS')}</div>
          <div class="tag">Care • Compassion • Commitment</div>
          <div class="addr">${UI.esc(c.address || '')}${c.phone ? ' · ' + UI.esc(c.phone) : ''}</div>
          <div class="lr-title">Diagnostic Report</div>
        </div>

        <div class="lr-patient">
          <span><b>${UI.esc(o.first_name)} ${UI.esc(o.last_name || '')}</b></span>
          <span>${UI.esc(age)} · ${UI.esc(UI.titleise(o.gender || '—'))}</span>
          <span>UHID ${UI.esc(o.uhid)}</span>
          <span>${UI.esc(UI.dateTime(o.reported_at || o.ordered_at))}</span>
          <span>${UI.esc(o.order_no)}${o.doctor_code ? ' · Ref ' + UI.esc(o.doctor_code) : ''}</span>
        </div>

        <table class="lr-res">
          <thead><tr><th>Investigation</th><th style="text-align:right">Result</th>
            <th>Unit</th><th>Reference range</th><th style="text-align:right">Flag</th></tr></thead>
          <tbody>${o.items.map((i) => {
            const flag = String(i.abnormal_flag || '').toLowerCase();
            const cls = flag === 'high' || flag === 'critical' ? 'high' : (flag === 'low' ? 'low' : '');
            return `<tr>
              <td class="test">${UI.esc(i.test_name)}</td>
              <td class="val ${cls}">${UI.esc(i.result_value || '—')}</td>
              <td>${UI.esc(i.unit || '')}</td>
              <td>${UI.esc(i.ref_range || '')}</td>
              <td class="flag ${cls}">${flag && flag !== 'normal' ? UI.esc(flag.toUpperCase()) : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>

        ${abnormal.length ? `<div class="lr-note">
          <span class="k">Outside the reference range</span><br>
          ${abnormal.map((i) => UI.esc(`${i.test_name} — ${i.result_value} ${i.unit || ''}`.trim())).join('; ')}
        </div>` : ''}
        ${o.clinical_notes ? `<div class="lr-note">
          <span class="k">Notes</span><br>${UI.esc(o.clinical_notes)}</div>` : ''}

        <div class="lr-sign">
          <div class="lr-stamp">
            <div class="lr-stamp-box"></div>
            <div class="lr-stamp-label">Doctor's stamp &amp; signature</div>
          </div>
        </div>

        <div class="lr-foot">
          Results relate only to the sample received. Please correlate clinically.
        </div>
      </div>`, `Report ${o.order_no}`);
  }
  // Exposed so the browser checks can print a report without hunting for a button.
  window.__printReport = printReport;
})();
