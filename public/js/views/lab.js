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

  async function printReport(order) {
    const o = await API.get(`/api/lab/orders/${order.id}/report`);
    const html = `<div class="doc">
      ${UI.docHeader('Diagnostic Report', [
        `Order: ${o.order_no}`, `Reported: ${UI.dateTime(o.reported_at || o.ordered_at)}`])}
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(o.first_name)} ${UI.esc(o.last_name || '')}</td>
            <th>UHID</th><td>${UI.esc(o.uhid)}</td></tr>
        <tr><th>Age / Sex</th><td>${UI.esc(o.age_years || '—')} / ${UI.esc(o.gender || '—')}</td>
            <th>Referred by</th><td>${UI.esc(o.doctor_name || '—')}</td></tr>
      </tbody></table>
      <table class="mt"><thead><tr><th>Investigation</th><th>Result</th><th>Unit</th><th>Reference range</th><th>Flag</th></tr></thead><tbody>
        ${o.items.map((i) => `<tr>
          <td><b>${UI.esc(i.test_name)}</b></td>
          <td><b>${UI.esc(i.result_value || '—')}</b></td>
          <td>${UI.esc(i.unit || '')}</td>
          <td>${UI.esc(i.ref_range || '')}</td>
          <td>${i.abnormal_flag && i.abnormal_flag !== 'normal' ? UI.esc(i.abnormal_flag.toUpperCase()) : ''}</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="sign"><div>Lab technician</div><div>Verified by<br>Consultant pathologist</div></div>
      <div class="foot-note">Results relate only to the sample received. Please correlate clinically.
        Report generated electronically.</div>
    </div>`;
    UI.print(html, 'Report ' + o.order_no);
  }
})();
