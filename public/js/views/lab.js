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
          <div class="stat ${c.awaiting_payment ? 'orange' : 'crimson'}">
            <div class="label">${c.awaiting_payment ? 'Waiting at the counter' : 'Awaiting sample'}</div>
            <div class="value">${UI.num(c.awaiting_payment ? c.awaiting_payment : (c.ordered || 0))}</div>
            <div class="foot">${c.awaiting_payment
              ? 'Ordered, not yet paid for'
              : 'Collect and label'}</div></div>
          <div class="stat orange"><div class="label">In process</div>
            <div class="value">${UI.num((c.sample_collected || 0) + (c.in_process || 0))}</div><div class="foot">On the analyser</div></div>
          <div class="stat teal"><div class="label">Awaiting verification</div><div class="value">${UI.num(c.result_entered || 0)}</div>
            <div class="foot">Results entered, not released</div></div>
          <div class="stat ok"><div class="label">Reported</div><div class="value">${UI.num(c.reported || 0)}</div>
            <div class="foot">Released to the patient</div></div>
        </div>

        <div class="tabs" id="l-tabs">
          <button class="active" data-tab="orders">Orders</button>
          ${APP.can(['lab', 'nurse', 'doctor'])
            ? '<button data-tab="record">Record tests done</button>' : ''}
        </div>
        <div id="l-body">
          <div class="search-row">
            <select id="l-status">
              <option value="">All statuses</option>
              ${['ordered','sample_collected','in_process','result_entered','reported','cancelled'].map((s) =>
                `<option value="${s}"${params.status === s ? ' selected' : ''}>${UI.titleise(s)}</option>`).join('')}
            </select>
          </div>

          <div class="card"><div class="card-body tight" id="lo-list"></div></div>
          <div id="lo-held"></div>
        </div>`;

      const body = el.querySelector('#l-body');
      const ordersHtml = body.innerHTML;

      /*
       * The bench's list is what has been paid for. What has not appears
       * below it as a count and a set of names, greyed and unopenable: the
       * technician should know work is coming — a STAT sample may need a tube
       * ready — without being able to start it before the counter has been
       * paid. Clicking one says where it is, rather than doing nothing.
       */
      const waiting = res.rows.filter((o) => !o.released);
      const work = res.rows.filter((o) => o.released);

      const drawOrders = (into) => { into.innerHTML = UI.table([
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
        ...(APP.seesPrices() ? [{ label: 'Amount', num: true, render: (o) => UI.money(o.total_price) }] : []),
      ], work, { emptyText: 'Nothing paid for is waiting to be run.' });
        UI.bindRows(into, work, (o) => openOrder(o.id));

        const heldHost = body.querySelector('#lo-held');
        if (!heldHost) return;
        if (!waiting.length) { heldHost.innerHTML = ''; return; }
        heldHost.innerHTML = `
          <div class="card">
          <div class="card-head"><h3>At the cash counter</h3>
            <span class="muted small">${UI.num(waiting.length)} order(s) ordered but not yet paid —
              the bench cannot start these</span></div>
          <div class="card-body tight" style="opacity:.62">${UI.table([
            { label: 'Order', render: (o) => `<code>${UI.esc(o.order_no)}</code>` +
              (o.priority !== 'routine'
                ? ' ' + UI.badge(o.priority.toUpperCase(), o.priority === 'stat' ? 'danger' : 'warn') : '') },
            { label: 'Patient', render: (o) => `<b>${UI.esc(o.patient_name)}</b>` +
              `<div class="muted small">${UI.esc(o.uhid)}</div>` },
            { label: 'Tests', render: (o) => `<div class="small">${UI.esc(o.tests || '')}</div>` },
            { label: 'Ordered by', render: (o) => UI.esc(o.doctor_code || o.doctor_name || '—') },
            { label: 'Ordered', render: (o) => UI.esc(UI.ago(o.ordered_at)) },
            { label: '', render: () => UI.badge('Awaiting payment', 'warn') },
          ], waiting, {})}</div></div>`;
      };

      const showOrders = () => {
        body.innerHTML = ordersHtml;
        body.querySelector('#l-status').addEventListener('change', (e) =>
          APP.navigate('lab', { status: e.target.value }));
        drawOrders(body.querySelector('#lo-list'));
      };

      el.querySelectorAll('#l-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#l-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        if (b.dataset.tab === 'record') return renderRecord(body);
        return showOrders();
      }));

      showOrders();
    },
  });

  // ------------------------------------------------------ recording the work
  /**
   * The technician's own board: every test the department does, as a button.
   *
   * A lab records what it ran, and the way to record it is to press it. What
   * is deliberately not on these buttons is the rate — the technician is not
   * pricing anything and the patient may be standing at the bench, so the
   * money belongs on the cashier's screen and nowhere near this one.
   *
   * A test the clinic has not priced yet still appears: the work happened and
   * the record should say so. It simply will not reach the bill until somebody
   * gives it a rate, which the screen says out loud rather than leaving the
   * counter to discover.
   */
  async function renderRecord(body) {
    body.innerHTML = UI.loading();

    let tests;
    try { tests = await API.get('/api/masters/lab-tests'); }
    catch (err) { body.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`; return; }

    // Grouped the way the department works rather than alphabetically: the
    // bench first, then the couch, then the scanner.
    const ORDER = ['Health packages', 'Blood tests', 'Urine & stool', 'X-ray',
      'Ultrasound & Doppler', 'ECG & heart'];
    const groups = [];
    for (const t of tests) {
      const label = t.bill_group || 'Other';
      let g = groups.find((x) => x.group === label);
      if (!g) groups.push((g = { group: label, items: [] }));
      g.items.push(t);
    }
    const rank = (name) => { const i = ORDER.indexOf(name); return i === -1 ? ORDER.length : i; };
    groups.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group));

    const picked = [];
    let patient = null;
    let open = groups.length ? groups[0].group : null;

    body.innerHTML = `
      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>What did you run?</h3>
              <span class="muted small">Press a test to add it — press again for another</span></div>
            <div class="card-body" id="lr-board"></div>
          </div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>This order</h3>
              <button class="btn ghost sm" id="lr-clear">Clear</button></div>
            <div class="card-body tight" id="lr-picked"></div>
            <div class="card-body">
              <div id="lr-who"></div>
              ${UI.field({ name: 'priority', label: 'Priority', value: 'routine',
                options: [{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' },
                  { value: 'stat', label: 'STAT' }] })}
              ${UI.field({ name: 'clinicalNotes', label: 'Note', rows: 2,
                placeholder: 'Fasting sample, repeat, sample haemolysed…' })}
              <button class="btn block mt" id="lr-save" disabled>Record these tests</button>
              <div id="lr-out"></div>
            </div>
          </div>
        </div>
      </div>`;

    // ---- the board
    const paintBoard = () => {
      const g = groups.find((x) => x.group === open) || groups[0];
      body.querySelector('#lr-board').innerHTML = groups.length ? `
        <div class="chip-row mb">
          ${groups.map((x) => `<button type="button" class="chip${x.group === open ? ' on' : ''}"
            data-group="${UI.esc(x.group)}">${UI.esc(x.group)}
            <span class="chip-n">${UI.num(x.items.length)}</span></button>`).join('')}
        </div>
        <div class="item-grid">
          ${g.items.map((t) => `<button type="button" class="item-btn" data-test="${t.id}">
            <span class="item-name">${UI.esc(t.name)}</span>
            <span class="item-rate">${UI.esc(t.sample_type || UI.titleise(t.category))}${
              APP.seesPrices() && !t.price ? ' · no rate set' : ''}</span>
          </button>`).join('')}
        </div>`
        : UI.empty('No diagnostics are set up yet.', '🧪');

      body.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
        open = b.dataset.group;
        paintBoard();
      }));
      body.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => {
        const t = tests.find((x) => x.id === Number(b.dataset.test));
        if (t && !picked.some((p) => p.id === t.id)) picked.push(t);
        paintPicked();
      }));
    };

    // ---- what has been picked
    const paintPicked = () => {
      body.querySelector('#lr-picked').innerHTML = UI.table([
        { label: 'Test', render: (t) => `<b>${UI.esc(t.name)}</b>` +
          (APP.seesPrices() && !t.price ? '<div class="muted small">no rate set — will not reach the bill</div>' : '') },
        { label: '', render: (t, i) => `<button class="btn ghost sm" data-rm="${i}">Remove</button>` },
      ], picked, { emptyText: 'Nothing picked yet.' });

      body.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
        picked.splice(Number(b.dataset.rm), 1);
        paintPicked();
      }));
      body.querySelector('#lr-save').disabled = !(picked.length && patient);
    };

    // ---- whose tests they are
    const paintWho = () => {
      const who = body.querySelector('#lr-who');
      who.innerHTML = patient
        ? `<div class="alert ok"><b>${UI.esc(patient.first_name)} ${UI.esc(patient.last_name || '')}</b>
             · ${UI.esc(patient.uhid)}
             <button class="btn ghost sm" id="lr-unpick" style="float:right">Change</button></div>`
        : `<div class="search-row">
             <input type="search" id="lr-q" placeholder="Whose sample? Name, UHID or mobile…"
               autocomplete="off"></div>
           <div id="lr-hits"></div>`;

      const un = who.querySelector('#lr-unpick');
      if (un) un.addEventListener('click', () => { patient = null; paintWho(); paintPicked(); });

      const input = who.querySelector('#lr-q');
      if (!input) return;
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          const hits = who.querySelector('#lr-hits');
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
            : '<div class="muted small">Nobody matched. The front desk registers a new patient.</div>';
          hits.querySelectorAll('[data-pt]').forEach((b) => b.addEventListener('click', () => {
            patient = rows.find((r) => r.id === Number(b.dataset.pt));
            paintWho();
            paintPicked();
          }));
        }, 220);
      });
    };

    body.querySelector('#lr-clear').addEventListener('click', () => {
      picked.length = 0;
      paintPicked();
    });

    body.querySelector('#lr-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const order = await API.post('/api/lab/orders', {
          patientId: patient.id,
          tests: picked.map((t) => ({ testId: t.id })),
          priority: body.querySelector('[name=priority]').value,
          clinicalNotes: body.querySelector('[name=clinicalNotes]').value || undefined,
        });
        const unpriced = APP.seesPrices() ? picked.filter((t) => !t.price) : [];
        UI.ok(`${order.order_no} recorded — ${picked.length} test(s).`);
        body.querySelector('#lr-out').innerHTML = `
          <div class="alert ok mt"><b>${UI.esc(order.order_no)}</b> raised for
            ${UI.esc(patient.first_name)} ${UI.esc(patient.last_name || '')}.
            ${unpriced.length ? `<div class="mt"><b>${UI.num(unpriced.length)} of them have no rate</b>
              and will not appear on the bill until one is set under Services &amp; Rates.</div>` : ''}
            <div class="mt"><button class="btn sm" id="lr-open">Enter the results</button>
              <button class="btn ghost sm" id="lr-next">Next patient</button></div></div>`;
        body.querySelector('#lr-open').addEventListener('click', () => openOrder(order.id));
        body.querySelector('#lr-next').addEventListener('click', () => {
          picked.length = 0;
          patient = null;
          body.querySelector('#lr-out').innerHTML = '';
          paintWho();
          paintPicked();
        });
        picked.length = 0;
        paintPicked();
      } catch (err) {
        UI.err(err.message);
        e.target.disabled = false;
      }
    });

    paintBoard();
    paintWho();
    paintPicked();
  }

  /** X-ray, ultrasound, ECG — reported in words rather than in numbers. */
  /**
   * Aadhaar in the 4-4-4 grouping it is written in, so it can be checked at a
   * glance against the card.
   */
  function formatAadhaar(value) {
    const raw = String(value || '').replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(raw)) return '';
    return `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8)}`;
  }

  /**
   * Weight and height on a lab sheet, and the BMI they come to.
   *
   * Not decoration: creatinine clearance is read against weight, a paediatric
   * dose is weight-based, and a radiographer sets an exposure by build. The
   * BMI band follows the Indian cut-offs — overweight at 23, obesity at 25 —
   * because those are the thresholds this population is screened against.
   */
  function bmiBand(bmi) {
    const n = Number(bmi) || 0;
    if (!n) return '';
    if (n < 18.5) return 'underweight';
    if (n < 23) return 'normal';
    if (n < 25) return 'overweight';
    return 'obese';
  }

  function measurements(v) {
    const vt = v || {};
    return `
      <div><div class="k">Weight</div><div class="v">${vt.weight_kg
        ? `${UI.esc(UI.num(vt.weight_kg, 1))} kg` : '—'}</div></div>
      <div><div class="k">Height</div><div class="v">${vt.height_cm
        ? `${UI.esc(UI.num(vt.height_cm, 0))} cm` : '—'}</div></div>
      <div><div class="k">BMI</div><div class="v">${vt.bmi
        ? `${UI.esc(UI.num(vt.bmi, 1))}<span class="bmi-band"> ${UI.esc(bmiBand(vt.bmi))}</span>`
        : '—'}</div></div>`;
  }

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

    UI.printSheet(`${UI.sheetStyles()}
      <style>
        .rq-test { font-weight: 700; }
        .rq-barcode { margin-top: 12px; text-align: center; }
        .rq-barcode svg { max-width: 62mm; }
      </style>
      <div class="sheet">
        ${UI.sheetHead('Investigation Request')}

        <div class="who">
          <div style="grid-column:span 2">
            <div class="k">Patient</div>
            <div class="v lead">${UI.esc(o.patient_name)}</div>
          </div>
          <div><div class="k">Age / Sex</div>
            <div class="v">${UI.esc(age)} · ${UI.esc(UI.titleise(o.gender || '—'))}</div></div>
          ${measurements(o.vitals)}
          <div><div class="k">UHID</div><div class="v">${UI.esc(o.uhid)}</div></div>
          <div><div class="k">Aadhaar</div><div class="v">${
            formatAadhaar(o.aadhaar_number) || '—'}</div></div>
          <div><div class="k">Ordered</div><div class="v">${UI.esc(UI.dateTime(o.ordered_at))}</div></div>
          <div><div class="k">Order</div><div class="v">${UI.esc(o.order_no)}</div></div>
          <div><div class="k">Ordered by</div><div class="v">${UI.esc(o.doctor_code || '—')}</div></div>
          ${o.visit_no || o.ip_no
            ? `<div><div class="k">Episode</div><div class="v">${UI.esc(o.visit_no || o.ip_no)}</div></div>` : ''}
        </div>

        ${o.priority && o.priority !== 'routine'
          ? `<div class="warn">${UI.esc(o.priority.toUpperCase())} — process ahead of the routine queue</div>` : ''}
        ${o.allergies ? `<div class="warn">Allergic to: ${UI.esc(o.allergies)}</div>` : ''}

        <table>
          <thead><tr><th style="width:16px"></th><th>Investigation requested</th><th>Sample</th></tr></thead>
          <tbody>${o.items.map((i, n) => `<tr>
            <td style="color:#8B9AA2">${n + 1}.</td>
            <td class="rq-test">${UI.esc(i.test_name)}</td>
            <td>${UI.esc(i.sample_type || '')}</td>
          </tr>`).join('')}</tbody>
        </table>

        ${o.clinical_notes ? `<div class="block"><div class="k">Clinical notes</div>
          <p>${UI.esc(o.clinical_notes)}</p></div>` : ''}

        ${sample ? `<div class="rq-barcode">
          ${window.Barcode ? Barcode.svg(sample.barcode, { module: 1.4, height: 32, fontSize: 8 })
                           : UI.esc(sample.barcode)}
          <div class="block" style="margin-top:2px"><div class="k">Sample collected</div>
            <p>${UI.esc(UI.dateTime(sample.collected_at))}</p></div>
        </div>` : `<div class="block"><div class="k">Sample</div>
          <p>Not yet collected — hand this slip in at the collection counter.</p></div>`}

        <div class="stamp-row">
          <div class="stamp"><div class="box"></div>
            <div class="cap">Collected by · stamp &amp; signature</div></div>
        </div>

        <div class="note">
          Fasting samples must be taken before any food or drink other than water.
          Bring this slip when you come to collect the report.
        </div>
      </div>`, `Order ${o.order_no}`);
  }

  /**
   * The diagnostic report: the polyclinic's name and address at the top, the
   * results in the middle, and a blank box at the bottom to be stamped and
   * signed by hand.
   *
   * The signature is the laboratory's, not a doctor's. Whoever ran the sample
   * and released the result is the one answering for what the report says, and
   * on a report a patient carries to another hospital the question asked of
   * that box is "which lab issued this" — so it names the lab in charge.
   *
   * The referring doctor is named in full at the top. A report travels: to a
   * specialist, to another hospital, back to the doctor who asked for it —
   * and every one of those readers needs to know who ordered it and why. A
   * code alone means nothing outside this building. (The prescription is the
   * opposite case and still carries the code: it goes home with the patient
   * and on to a pharmacist.)
   */
  async function printReport(order, windowRef = null) {
    /*
     * The window is claimed before the report is fetched — a browser only
     * allows a popup while it can still see the click that asked for it, and
     * an await in between loses that permission. A caller that already opened
     * one on its own click hands it over.
     */
    const win = windowRef || UI.openPrintWindow();
    let o;
    try { o = await API.get(`/api/lab/orders/${order.id}/report`); }
    catch (err) { UI.err(err.message); if (win) win.close(); return; }
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

    UI.printSheet(`${UI.sheetStyles()}
      <style>
        .lr-test { font-weight: 700; }
        .lr-val { font-weight: 700; }
        .lr-high { color: #B03A2E; }
        .lr-low { color: #B26A00; }
        .lr-scan { margin-top: 11px; }
        .lr-scan h3 {
          margin: 0 0 3px; font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase;
          color: #176B7C; border-bottom: 1px solid #E4EAED; padding-bottom: 2px; font-weight: 700;
        }
      </style>
      <div class="sheet">
        ${UI.sheetHead(title)}

        <div class="who">
          <div style="grid-column:span 2">
            <div class="k">Patient</div>
            <div class="v lead">${UI.esc(o.first_name)} ${UI.esc(o.last_name || '')}</div>
          </div>
          <div><div class="k">Age / Sex</div>
            <div class="v">${UI.esc(age)} · ${UI.esc(UI.titleise(o.gender || '—'))}</div></div>
          ${measurements(o.vitals)}
          <div><div class="k">UHID</div><div class="v">${UI.esc(o.uhid)}</div></div>
          <div><div class="k">Aadhaar</div><div class="v">${
            formatAadhaar(o.aadhaar_number) || '—'}</div></div>
          <div><div class="k">Reported</div>
            <div class="v">${UI.esc(UI.dateTime(o.reported_at || o.ordered_at))}</div></div>
          <div><div class="k">Order</div><div class="v">${UI.esc(o.order_no)}</div></div>
          <div><div class="k">Referred by</div><div class="v">${
            UI.esc(o.doctor_name || o.doctor_code || '—')}</div></div>
        </div>

        ${measured.length ? `<table>
          <thead><tr><th>Investigation</th><th class="num">Result</th>
            <th>Unit</th><th>Reference range</th><th class="num">Flag</th></tr></thead>
          <tbody>${measured.map((i) => {
            const flag = String(i.abnormal_flag || '').toLowerCase();
            const cls = flag === 'high' || flag === 'critical' ? 'lr-high' : (flag === 'low' ? 'lr-low' : '');
            return `<tr>
              <td class="lr-test">${UI.esc(i.test_name)}</td>
              <td class="num lr-val ${cls}">${UI.esc(i.result_value || '—')}</td>
              <td>${UI.esc(i.unit || '')}</td>
              <td>${UI.esc(i.ref_range || '')}</td>
              <td class="num ${cls}" style="font-weight:700">${
                flag && flag !== 'normal' ? UI.esc(flag.toUpperCase()) : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : ''}

        ${scans.map((i) => `<div class="lr-scan">
          <h3>${UI.esc(i.test_name)}</h3>
          <div class="block" style="margin-top:5px"><div class="k">Findings</div>
            <p>${UI.esc(i.result_value || 'Not reported.')}</p></div>
          ${i.result_notes ? `<div class="block"><div class="k">Impression</div>
            <p class="strong">${UI.esc(i.result_notes)}</p></div>` : ''}
        </div>`).join('')}

        ${abnormal.some((i) => !isImaging(i)) ? `<div class="block">
          <div class="k">Outside the reference range</div>
          <p>${abnormal.filter((i) => !isImaging(i))
            .map((i) => UI.esc(`${i.test_name} — ${i.result_value} ${i.unit || ''}`.trim())).join('; ')}</p>
        </div>` : ''}
        ${o.clinical_notes ? `<div class="block"><div class="k">Clinical notes</div>
          <p>${UI.esc(o.clinical_notes)}</p></div>` : ''}

        <div class="stamp-row">
          <div class="stamp"><div class="box"></div>
            <div class="cap">Lab in-charge · stamp &amp; signature</div></div>
        </div>

        <div class="note">
          ${scans.length && !measured.length
            ? (allCardiac
              ? 'This report is an interpretation of the tracing recorded at the time and is not a diagnosis on its own. Please correlate clinically.'
              : 'This report is an opinion on the images acquired and is not a diagnosis on its own. Please correlate clinically.')
            : 'Results relate only to the sample received. Please correlate clinically.'}
        </div>
      </div>`, `Report ${o.order_no}`, win);
  }

  /*
   * Printing a report from elsewhere in the app — a report list, a dashboard
   * drill-down — where only the order's id is known. The caller claims the
   * print window on its own click and passes it in.
   */
  APP.printLabReport = (orderId, windowRef = null) => printReport({ id: orderId }, windowRef);

  // Exposed so the browser checks can print a report without hunting for a button.
  window.__printReport = printReport;
  window.__openOrder = openOrder;
  window.__printRequisition = printRequisition;
})();
