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
        { label: 'Ordered by', render: (o) => o.doctor_code
          ? `<code>${UI.esc(o.doctor_code)}</code><div class="muted small">${UI.esc(o.doctor_name || '')}</div>`
          : UI.esc(o.doctor_name || '—') },
        { label: 'Status', render: (o) => UI.statusBadge(o.status) },
        { label: 'Ordered', render: (o) => UI.esc(UI.ago(o.ordered_at)) },
        { label: 'Amount', num: true, render: (o) => UI.money(o.total_price) },
      ], res.rows, { emptyText: 'No diagnostic orders match this filter.' });
      UI.bindRows(host, res.rows, (o) => openOrder(o.id));
    },
  });

  /** X-ray, ultrasound, ECG — reported in words rather than in numbers. */
  const isImaging = (item) => ['radiology', 'cardiology'].includes(String(item.category || '').toLowerCase());

  async function openOrder(id) {
    const o = await API.get(`/api/lab/orders/${id}`);
    const canEdit = APP.can(['lab']);

    const open = (i) => canEdit && ['in_process', 'sample_collected', 'result_entered'].includes(i.status);

    // A blood test has a value; an X-ray or a scan has findings and an
    // impression. The same screen has to take both.
    const rows = o.items.filter((i) => !isImaging(i)).map((i) => `<tr>
      <td><b>${UI.esc(i.test_name)}</b><div class="muted small">${UI.esc(i.ref_range || '')} ${UI.esc(i.unit || '')}</div></td>
      <td>${open(i)
        ? `<input type="text" data-item="${i.id}" value="${UI.esc(i.result_value || '')}" placeholder="value">`
        : `<b>${UI.esc(i.result_value || '—')}</b>`}</td>
      <td>${UI.esc(i.unit || '')}</td>
      <td>${UI.esc(i.ref_range || '—')}</td>
      <td>${i.abnormal_flag ? UI.badge(UI.titleise(i.abnormal_flag),
        i.abnormal_flag === 'critical' ? 'danger' : i.abnormal_flag === 'normal' ? 'ok' : 'warn') : '—'}</td>
      <td>${UI.statusBadge(i.status)}</td>
    </tr>`).join('');

    const imaging = o.items.filter(isImaging).map((i) => `
      <fieldset><legend>${UI.esc(i.test_name)} ${UI.statusBadge(i.status)}</legend>
        ${open(i) ? `
          ${UI.field({ name: `find-${i.id}`, label: 'Findings', rows: 5, value: i.result_value || '',
            placeholder: String(i.category || '').toLowerCase() === 'cardiology'
              ? 'Rate, rhythm, axis, intervals, ST-T changes…'
              : 'Technique, and what is seen — lung fields, cardiac silhouette, bony cage…' })}
          ${UI.field({ name: `imp-${i.id}`, label: 'Impression', value: i.result_notes || '',
            placeholder: 'The one line the referring doctor reads first' })}`
          : `<div class="muted small">Findings</div>
             <p style="white-space:pre-wrap">${UI.esc(i.result_value || '—')}</p>
             <div class="muted small">Impression</div>
             <p><b>${UI.esc(i.result_notes || '—')}</b></p>`}
      </fieldset>`).join('');

    UI.modal({
      title: `${o.order_no} — ${o.patient_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(o.status)}
            ${o.priority !== 'routine' ? UI.badge(o.priority.toUpperCase(), o.priority === 'stat' ? 'danger' : 'warn') : ''}
            ${UI.badge(o.uhid, 'teal')}</div>
          <span class="muted small">Ordered ${UI.dateTime(o.ordered_at)} by
            ${o.doctor_code ? `<code>${UI.esc(o.doctor_code)}</code> ` : ''}${UI.esc(o.doctor_name || '—')}</span>
        </div>
        ${o.clinical_notes ? `<div class="alert info"><b>Clinical notes:</b> ${UI.esc(o.clinical_notes)}</div>` : ''}
        ${o.samples.length ? `<div class="alert ok"><b>Sample:</b> <code>${UI.esc(o.samples[0].barcode)}</code>
          collected ${UI.esc(UI.dateTime(o.samples[0].collected_at))}</div>` : ''}

        ${rows ? `<div class="table-wrap"><table><thead><tr>
          <th>Test</th><th>Result</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Status</th>
        </tr></thead><tbody>${rows}</tbody></table></div>` : ''}
        ${imaging}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="requisition">Print the order</button>
        ${['result_entered','verified','reported'].includes(o.status) ? '<button class="btn ghost" data-act="print">Print report</button>' : ''}
        ${canEdit && o.status === 'ordered' ? '<button class="btn teal" data-act="collect">Collect sample</button>' : ''}
        ${canEdit && o.status === 'sample_collected' ? '<button class="btn teal" data-act="start">Start processing</button>' : ''}
        ${canEdit && ['in_process','sample_collected','result_entered'].includes(o.status) ? '<button class="btn" data-act="save">Save results</button>' : ''}
        ${APP.can(['lab','doctor']) && o.status === 'result_entered' ? '<button class="btn ok" data-act="verify">Verify &amp; release</button>' : ''}`,

      async onAction(act, modal) {
        if (act === 'print') return printReport(o);
        if (act === 'requisition') { printRequisition(o); return 'keep'; }
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
          // Imaging carries its findings in the value and its impression in the
          // notes, which is how the report prints them.
          for (const item of o.items.filter(isImaging)) {
            const findings = modal.querySelector(`[name="find-${item.id}"]`);
            if (!findings || !findings.value.trim()) continue;
            const impression = modal.querySelector(`[name="imp-${item.id}"]`);
            results.push({
              itemId: item.id, value: findings.value.trim(),
              notes: impression ? impression.value.trim() : null,
              abnormalFlag: 'normal',
            });
          }
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
   * The test order itself — the requisition the patient carries to the sample
   * counter, and the slip that goes with a sample sent out to a reference lab.
   *
   * Same form as the report and the prescription: the polyclinic's name and
   * address at the top, the tests in the middle, the ordering doctor as their
   * code and never by name, and a blank box for whoever collects the sample to
   * sign. Nothing about money is on it — the patient settles at the counter.
   */
  function printRequisition(o) {
    const c = APP.clinic || {};
    const age = o.age_years ? `${o.age_years} yrs` : '—';
    const sample = o.samples && o.samples[0];

    UI.print(`
      <style>
        @page { size: A5 portrait; margin: 9mm; }
        .rq { width: 128mm; margin: 0 auto; font-family: Georgia, "Times New Roman", serif;
              color: #16232B; font-size: 11px; }
        .rq-head { text-align: center; border-bottom: 2px solid #9E1B34; padding-bottom: 6px; }
        .rq-head .clinic { font-size: 17px; font-weight: 700; letter-spacing: .5px; color: #9E1B34; }
        .rq-head .tag { font-size: 8px; letter-spacing: 1.4px; text-transform: uppercase; color: #176B7C; margin-top: 2px; }
        .rq-head .addr { font-size: 9.5px; color: #43555F; margin-top: 3px; }
        .rq-title { margin-top: 6px; font-size: 11px; font-weight: 700; letter-spacing: 2.4px;
                    text-transform: uppercase; color: #176B7C; }
        .rq-patient { display: flex; flex-wrap: wrap; gap: 3px 16px; padding: 8px 0;
          border-bottom: 1px dashed #B9C6CC; font-size: 10.5px; }
        .rq-urgent { margin-top: 6px; font-weight: 700; color: #B03A2E; font-size: 11px;
          letter-spacing: .08em; text-transform: uppercase; }
        table.rq-tests { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
        table.rq-tests th { text-align: left; font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase;
          color: #74858E; border-bottom: 1px solid #16232B; padding: 0 4px 3px; font-weight: 600; }
        table.rq-tests td { padding: 5px 4px; border-bottom: 1px dotted #DFE6EA; vertical-align: top; }
        table.rq-tests .n { width: 22px; color: #74858E; }
        table.rq-tests .test { font-weight: 700; }
        .rq-note { font-size: 10px; margin-top: 8px; }
        .rq-note .k { color: #74858E; font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; }
        .rq-barcode { margin-top: 10px; text-align: center; }
        .rq-barcode .code { font-family: monospace; font-size: 10px; letter-spacing: .08em; }
        .rq-sign { margin-top: 16px; display: flex; justify-content: flex-end; }
        .rq-stamp { text-align: center; width: 58mm; }
        .rq-stamp-box { height: 20mm; border: 1px dashed #B9C6CC; border-radius: 3px; }
        .rq-stamp-label { margin-top: 3px; font-size: 8.5px; color: #74858E;
          letter-spacing: .06em; text-transform: uppercase; }
        .rq-foot { margin-top: 12px; border-top: 1px solid #DFE6EA; padding-top: 5px;
          font-size: 8.5px; color: #74858E; text-align: center; }
        @media screen { body { background: #eef1f3; padding: 14px 0; }
          .rq { background: #fff; padding: 9mm; box-shadow: 0 2px 14px rgba(0,0,0,.15); } }
      </style>
      <div class="rq">
        <div class="rq-head">
          <div class="clinic">${UI.esc(c.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS')}</div>
          <div class="tag">Care • Compassion • Commitment</div>
          <div class="addr">${UI.esc(c.address || '')}${c.phone ? ' · ' + UI.esc(c.phone) : ''}</div>
          <div class="rq-title">Investigation Request</div>
        </div>

        <div class="rq-patient">
          <span><b>${UI.esc(o.patient_name)}</b></span>
          <span>${UI.esc(age)} · ${UI.esc(UI.titleise(o.gender || '—'))}</span>
          <span>UHID ${UI.esc(o.uhid)}</span>
          <span>${UI.esc(UI.dateTime(o.ordered_at))}</span>
          <span>${UI.esc(o.order_no)}${o.doctor_code ? ' · Ordered by ' + UI.esc(o.doctor_code) : ''}</span>
          ${o.visit_no || o.ip_no ? `<span>${UI.esc(o.visit_no || o.ip_no)}</span>` : ''}
        </div>

        ${o.priority && o.priority !== 'routine'
          ? `<div class="rq-urgent">${UI.esc(o.priority)} — process ahead of the routine queue</div>` : ''}
        ${o.allergies ? `<div class="rq-urgent">Allergic to: ${UI.esc(o.allergies)}</div>` : ''}

        <table class="rq-tests">
          <thead><tr><th></th><th>Investigation requested</th><th>Sample</th></tr></thead>
          <tbody>${o.items.map((i, n) => `<tr>
            <td class="n">${n + 1}.</td>
            <td class="test">${UI.esc(i.test_name)}</td>
            <td>${UI.esc(i.sample_type || '')}</td>
          </tr>`).join('')}</tbody>
        </table>

        ${o.clinical_notes ? `<div class="rq-note">
          <span class="k">Clinical notes</span><br>${UI.esc(o.clinical_notes)}</div>` : ''}

        ${sample ? `<div class="rq-barcode">
          ${window.Barcode ? Barcode.svg(sample.barcode, { module: 1.4, height: 34, fontSize: 9 })
                           : `<div class="code">${UI.esc(sample.barcode)}</div>`}
          <div class="rq-note">Sample collected ${UI.esc(UI.dateTime(sample.collected_at))}</div>
        </div>` : `<div class="rq-note"><span class="k">Sample</span><br>Not yet collected —
          hand this slip in at the collection counter.</div>`}

        <div class="rq-sign">
          <div class="rq-stamp">
            <div class="rq-stamp-box"></div>
            <div class="rq-stamp-label">Collected by · stamp &amp; signature</div>
          </div>
        </div>

        <div class="rq-foot">
          Fasting samples must be taken before any food or drink other than water.
          Bring this slip when you come to collect the report.
        </div>
      </div>`, `Order ${o.order_no}`);
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
    // X-ray, ultrasound and ECG are reported in words. A mixed order prints the
    // measured tests as a table and the imaging as narrative sections below it.
    const measured = o.items.filter((i) => !isImaging(i));
    const scans = o.items.filter(isImaging);
    // An ECG is a tracing, not a picture, so it is not headed or footed as
    // imaging even though it is reported in words like one.
    const allCardiac = scans.length && scans.every((i) =>
      String(i.category || '').toLowerCase() === 'cardiology');
    const title = scans.length && !measured.length
      ? (allCardiac ? 'Cardiology Report'
        : scans.every((i) => /ultrasound|usg|doppler/i.test(i.test_name)) ? 'Ultrasound Report'
        : scans.every((i) => /x-ray|xray|iopa/i.test(i.test_name)) ? 'Radiology Report'
        : 'Imaging Report')
      : 'Diagnostic Report';

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
        .lr-scan { margin-top: 10px; }
        .lr-scan h3 { margin: 0 0 4px; font-size: 11.5px; letter-spacing: .06em;
          text-transform: uppercase; color: #176B7C; border-bottom: 1px solid #DFE6EA; padding-bottom: 2px; }
        .lr-scan .k { color: #74858E; font-size: 8.5px; text-transform: uppercase;
          letter-spacing: .06em; margin-top: 6px; }
        .lr-scan p { margin: 2px 0 0; white-space: pre-wrap; font-size: 10.5px; line-height: 1.45; }
        .lr-scan .imp { font-weight: 700; }
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
          <div class="lr-title">${UI.esc(title)}</div>
        </div>

        <div class="lr-patient">
          <span><b>${UI.esc(o.first_name)} ${UI.esc(o.last_name || '')}</b></span>
          <span>${UI.esc(age)} · ${UI.esc(UI.titleise(o.gender || '—'))}</span>
          <span>UHID ${UI.esc(o.uhid)}</span>
          <span>${UI.esc(UI.dateTime(o.reported_at || o.ordered_at))}</span>
          <span>${UI.esc(o.order_no)}${o.doctor_code ? ' · Ref ' + UI.esc(o.doctor_code) : ''}</span>
        </div>

        ${measured.length ? `<table class="lr-res">
          <thead><tr><th>Investigation</th><th style="text-align:right">Result</th>
            <th>Unit</th><th>Reference range</th><th style="text-align:right">Flag</th></tr></thead>
          <tbody>${measured.map((i) => {
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
        </table>` : ''}

        ${scans.map((i) => `<div class="lr-scan">
          <h3>${UI.esc(i.test_name)}</h3>
          <div class="k">Findings</div>
          <p>${UI.esc(i.result_value || 'Not reported.')}</p>
          ${i.result_notes ? `<div class="k">Impression</div>
            <p class="imp">${UI.esc(i.result_notes)}</p>` : ''}
        </div>`).join('')}

        ${abnormal.some((i) => !isImaging(i)) ? `<div class="lr-note">
          <span class="k">Outside the reference range</span><br>
          ${abnormal.filter((i) => !isImaging(i))
            .map((i) => UI.esc(`${i.test_name} — ${i.result_value} ${i.unit || ''}`.trim())).join('; ')}
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
          ${scans.length && !measured.length
            ? (allCardiac
              ? 'This report is an interpretation of the tracing recorded at the time and is not a diagnosis on its own. Please correlate clinically.'
              : 'This report is an opinion on the images acquired and is not a diagnosis on its own. Please correlate clinically.')
            : 'Results relate only to the sample received. Please correlate clinically.'}
        </div>
      </div>`, `Report ${o.order_no}`);
  }
  // Exposed so the browser checks can print a report without hunting for a button.
  window.__printReport = printReport;
  window.__openOrder = openOrder;
  window.__printRequisition = printRequisition;
})();
