/* Nurse station and the doctor's consultation desk. */
(function () {
  'use strict';

  const pickVisit = async (el, statuses, label, onPick) => {
    const board = await API.get('/api/visits/board');
    const rows = board.rows.filter((r) => statuses.includes(r.status));
    el.innerHTML = `<div class="card">
      <div class="card-head"><h3>${UI.esc(label)}</h3><span class="muted">${rows.length} waiting</span></div>
      <div class="card-body tight" id="pick-list"></div></div>`;
    const host = el.querySelector('#pick-list');
    host.innerHTML = UI.table([
      { label: 'Token', render: (r) => `<span class="badge crimson">#${UI.esc(r.token_no || '—')}</span>` },
      { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)} · ${UI.esc(r.age_years || '—')}${UI.esc((r.gender || '').charAt(0).toUpperCase())}</div>` },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor_name || '—') },
      { label: 'Reason', render: (r) => UI.esc(r.reason_for_visit || '—') },
      { label: 'Flags', render: (r) => [r.allergies ? UI.badge('⚠ Allergy', 'danger') : '',
          r.screening_due ? UI.badge('Screening due', 'orange') : ''].join(' ') },
      { label: 'Waiting', render: (r) => UI.esc(UI.ago(r.arrived_at)) },
      { label: '', render: (r) => `<button class="btn sm" data-open="${r.id}">Open</button>` },
    ], rows, { emptyText: 'Nobody is waiting at this station.' });
    host.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => onPick(Number(b.dataset.open))));
    UI.bindRows(host, rows, (r) => onPick(r.id));
  };

  // -------------------------------------------------------- nurse station
  APP.register('vitals', {
    title: 'Nurse Station',
    subtitle: 'Check vitals before the patient sees the provider',

    async render(el, params) {
      if (params.visitId) return renderVitalsForm(el, Number(params.visitId));
      if (params.patientId) return renderWalkInVitals(el, Number(params.patientId));

      /*
       * The queue is the usual way in, but it is not the only one. A patient
       * comes to this counter to have a blood pressure checked without seeing
       * anybody, a diabetic drops in for a sugar reading, and a ward patient
       * needs an observation taken between rounds — none of which appear in a
       * visit queue. Leaving the station empty in those cases meant the
       * reading was written on paper and never reached the record.
       */
      el.innerHTML = `
        <div class="card mb">
          <div class="card-head"><h3>Anyone else</h3>
            <span class="muted small">Search by name, UHID or mobile — no appointment needed</span></div>
          <div class="card-body">
            <div class="search-row">
              <input type="search" id="vs-q" placeholder="Name, UHID or mobile number…" autocomplete="off">
            </div>
            <div id="vs-results"></div>
          </div>
        </div>
        <div id="vs-queue"></div>`;

      let t;
      const results = el.querySelector('#vs-results');
      el.querySelector('#vs-q').addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = e.target.value.trim();
          if (q.length < 2) return void (results.innerHTML = '');
          let rows = [];
          try { rows = (await API.get('/api/patients' + API.qs({ q, limit: 8 }))).rows; }
          catch (err) { return void (results.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`); }
          results.innerHTML = rows.length ? rows.map((p) => `
            <button type="button" class="btn ghost sm block mb" data-pt="${p.id}"
              style="justify-content:space-between">
              <span><b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>
                <span class="muted small"> ${UI.esc(p.uhid)} · ${UI.esc(p.age_years || '—')}${
                  UI.esc((p.gender || '').charAt(0).toUpperCase())}</span></span>
              <span class="muted small">${UI.esc(p.phone || '')}</span>
            </button>`).join('')
            : '<div class="muted small">Nobody matched. Register them at the front desk first.</div>';
          results.querySelectorAll('[data-pt]').forEach((b) => b.addEventListener('click', () =>
            APP.navigate('vitals', { patientId: b.dataset.pt })));
        }, 220);
      });

      await pickVisit(el.querySelector('#vs-queue'), ['checked_in', 'vitals_done'],
        'Patients ready for vitals', (id) => APP.navigate('vitals', { visitId: id }));
    },
  });

  /*
   * The vitals form, shared by the queue and the walk-in counter.
   *
   * Every field carries the range it is read against. A nurse taking a hundred
   * readings a week knows them; the person covering the counter on a Saturday
   * may not, and a reading nobody recognises as abnormal is a reading that does
   * not get escalated. The ranges are the adult resting ones, and the BMI band
   * follows the Indian cut-offs the rest of the system uses.
   */
  const VITAL_FIELDS = [
    { name: 'bpSystolic', label: 'BP systolic', unit: 'mmHg', hint: 'under 120' },
    { name: 'bpDiastolic', label: 'BP diastolic', unit: 'mmHg', hint: 'under 80' },
    { name: 'pulse', label: 'Pulse', unit: 'bpm', hint: '60 – 100' },
    { name: 'respRate', label: 'Respiratory rate', unit: '/min', hint: '12 – 20' },
    { name: 'tempC', label: 'Temperature', unit: '°C', step: '0.1', hint: '36.1 – 37.2' },
    { name: 'spo2', label: 'SpO₂', unit: '%', hint: '95 – 100', min: 0, max: 100 },
    { name: 'heightCm', label: 'Height', unit: 'cm', step: '0.1', hint: 'for BMI' },
    { name: 'weightKg', label: 'Weight', unit: 'kg', step: '0.1', hint: 'each visit' },
    { name: 'bloodSugar', label: 'Blood sugar', unit: 'mg/dL', step: '0.1', hint: 'fasting 70 – 100' },
    { name: 'painScore', label: 'Pain score', unit: '0–10', hint: '0 is none', min: 0, max: 10 },
  ];

  const vitalsFields = (last = null) => `
    <div class="grid c4">
      ${VITAL_FIELDS.map((f) => UI.field({
        name: f.name,
        label: `${f.label} (${f.unit})`,
        type: 'number',
        step: f.step || '1',
        min: f.min,
        max: f.max,
        hint: f.hint,
        // Height is the one reading that barely moves, so it is carried
        // forward — the counter should not have to measure it every time.
        value: f.name === 'heightCm' && last ? (last.height_cm || '') : '',
      })).join('')}
    </div>`;

  /** BMI as the nurse types, banded the way every printed sheet bands it. */
  function wireBmi(form, out) {
    const show = () => {
      const h = Number(form.heightCm.value);
      const w = Number(form.weightKg.value);
      if (!(h > 0 && w > 0)) return void (out.innerHTML = '');
      const bmi = Math.round((w / ((h / 100) ** 2)) * 10) / 10;
      const band = bmi < 18.5 ? ['Underweight', 'warn']
        : bmi < 23 ? ['Normal', 'ok']
          : bmi < 25 ? ['Overweight', 'warn'] : ['Obese', 'danger'];
      out.innerHTML = `<div class="alert ${band[1]}">BMI <b>${bmi}</b> — ${band[0]}
        <span class="muted small">(Indian cut-offs: overweight 23, obesity 25)</span></div>`;
    };
    form.heightCm.addEventListener('input', show);
    form.weightKg.addEventListener('input', show);
    show();
  }

  /** The flags the server sends back, shown the way the station shows them. */
  function showAlerts(host, alerts) {
    host.innerHTML = (alerts && alerts.length)
      ? alerts.map((a) => `<div class="alert ${
        a.level === 'critical' ? 'danger' : a.level === 'warn' ? 'warn' : 'info'}">
        ${a.level === 'critical' ? '🚨' : a.level === 'warn' ? '⚠' : 'ℹ'} ${UI.esc(a.text)}</div>`).join('')
      : '<div class="alert ok">All readings within normal limits.</div>';
    if ((alerts || []).some((a) => a.level === 'critical')) {
      UI.err('Critical reading — inform the doctor immediately.');
    }
  }

  /**
   * Vitals for somebody who is not in a queue: a blood-pressure check at the
   * counter, a sugar reading, an observation between rounds. It writes to the
   * patient's own chart, which is where the dated readings live anyway.
   */
  async function renderWalkInVitals(el, patientId) {
    const patient = await API.get(`/api/patients/${patientId}`);
    APP.setSubtitle(`${patient.first_name} ${patient.last_name || ''} · ${patient.uhid}`);
    APP.actions([{ id: 'back', label: '← Nurse station', onClick: () => APP.navigate('vitals') }]);

    const chart = patient.vitals || [];
    const last = chart[0] || null;

    el.innerHTML = `
      ${patient.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(patient.allergies)}</div>` : ''}
      <div class="alert info">No visit is open for this patient, so this goes onto their chart
        as a dated reading. If they are here to see a doctor, book them in at the front desk
        instead so the reading joins the consultation.</div>

      <div class="grid sidebar-right">
        <div class="card">
          <div class="card-head"><h3>Record vitals</h3>
            <span class="muted small">${UI.esc(patient.first_name)} ${UI.esc(patient.last_name || '')} ·
              ${UI.esc(patient.age_years || '—')} yrs · ${UI.esc(UI.titleise(patient.gender || '—'))}</span></div>
          <div class="card-body">
            <form id="v-form">
              ${vitalsFields(last)}
              <div id="bmi-out"></div>
              <div class="grid c2">
                ${UI.field({ name: 'purpose', label: 'Why they came',
                  placeholder: 'BP check, sugar review, dressing — it goes on the chart' })}
                ${UI.field({ name: 'notes', label: 'Notes' })}
              </div>
              <button class="btn block" type="submit">Save to the chart</button>
            </form>
            <div id="v-alerts" class="mt"></div>
          </div>
        </div>

        <div>
          ${chart.length ? `<div class="card"><div class="card-head"><h3>Previous readings</h3></div>
            <div class="card-body tight">${UI.table([
              { label: 'When', render: (v) => UI.esc(UI.dateShort(v.recorded_at)) },
              { label: 'BP', render: (v) => `${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')}` },
              { label: 'Pulse', render: (v) => UI.esc(v.pulse || '—') },
              { label: 'Temp', render: (v) => UI.esc(v.temp_c || '—') },
              { label: 'SpO₂', render: (v) => UI.esc(v.spo2 || '—') },
              { label: 'Wt', render: (v) => UI.esc(v.weight_kg || '—') },
              { label: 'BMI', render: (v) => UI.esc(v.bmi || '—') },
            ], chart.slice(0, 10))}</div></div>`
            : `<div class="card"><div class="card-body">${
              UI.empty('No readings on this chart yet.', '📋')}</div></div>`}
        </div>
      </div>`;

    const form = el.querySelector('#v-form');
    wireBmi(form, el.querySelector('#bmi-out'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await API.post(`/api/patients/${patientId}/vitals`, UI.formValues(form));
        showAlerts(el.querySelector('#v-alerts'), res.alerts);
        UI.ok('Reading saved to the chart.');
        setTimeout(() => APP.navigate('vitals', { patientId }), 900);
      } catch (err) {
        UI.err(err.message);
        btn.disabled = false;
      }
    });
  }

  async function renderVitalsForm(el, visitId) {
    const visit = await API.get(`/api/visits/${visitId}`);
    APP.setSubtitle(`${visit.patient_name} · ${visit.uhid} · token #${visit.token_no || '—'}`);
    APP.actions([{ id: 'back', label: '← Vitals queue', onClick: () => APP.navigate('vitals') }]);

    const last = visit.vitals[0];
    el.innerHTML = `
      ${visit.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(visit.allergies)}</div>` : ''}
      ${visit.screening_due ? '<div class="alert warn">⏰ <b>Yearly screening is due</b> — flag this to the doctor.</div>' : ''}

      <div class="grid sidebar-right">
        <div class="card">
          <div class="card-head"><h3>Record vitals</h3></div>
          <div class="card-body">
            <form id="v-form">
              ${vitalsFields(last)}
              <div id="bmi-out"></div>
              ${UI.field({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2 })}
              <button class="btn block" type="submit">Save vitals</button>
            </form>
            <div id="v-alerts" class="mt"></div>
          </div>
        </div>

        <div>
          <div class="card"><div class="card-head"><h3>Update pharmacy details</h3></div>
            <div class="card-body">
              <div class="muted small mb">Workflow step: “Update patient pharmacy information”.</div>
              <form id="ph-form">
                ${UI.field({ name: 'pharmacyName', label: 'Preferred pharmacy', value: visit.pharmacy_name || '' })}
                ${UI.field({ name: 'pharmacyPhone', label: 'Pharmacy phone', value: visit.pharmacy_phone || '' })}
                <button class="btn ghost block" type="submit">Save</button>
              </form>
            </div>
          </div>

          ${visit.vitals.length ? `<div class="card"><div class="card-head"><h3>Previous readings</h3></div>
            <div class="card-body tight">${UI.table([
              { label: 'When', render: (v) => UI.esc(UI.dateShort(v.recorded_at)) },
              { label: 'BP', render: (v) => `${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')}` },
              { label: 'Pulse', render: (v) => UI.esc(v.pulse || '—') },
              { label: 'Wt', render: (v) => UI.esc(v.weight_kg || '—') },
              { label: 'BMI', render: (v) => UI.esc(v.bmi || '—') },
            ], visit.vitals)}</div></div>` : ''}
        </div>
      </div>`;

    const form = el.querySelector('#v-form');
    wireBmi(form, el.querySelector('#bmi-out'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await API.post(`/api/visits/${visitId}/vitals`, UI.formValues(form));
        showAlerts(el.querySelector('#v-alerts'), res.alerts);
        UI.ok('Vitals recorded — the patient can go through to the exam room.');
      } catch (err) {
        UI.err(err.message);
      } finally { btn.disabled = false; }
    });

    el.querySelector('#ph-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await API.patch(`/api/patients/${visit.patient_id}`, UI.formValues(e.target));
      UI.ok('Pharmacy details updated.');
    });
  }

  // ------------------------------------------------------------ consultation
  APP.register('consult', {
    title: 'Consultation',
    subtitle: 'Clinical care, diagnoses, prescriptions and orders',

    async render(el, params) {
      if (params.visitId) return renderConsult(el, Number(params.visitId));

      /*
       * The queue is the usual way in and not the only one.
       *
       * A review patient rings to say the sugars are up and needs a repeat
       * panel; a film has to be repeated a week after the clinic; a colleague
       * asks for a test on somebody who was seen yesterday. None of those is
       * in today's queue, and an empty station used to mean the doctor had no
       * way to order anything at all — so the request went on paper, or by
       * phone to the lab, and nothing about it reached the record.
       *
       * Searching finds any registered patient. From there a doctor can order
       * diagnostics or open the full record, both of which stand on their own
       * without a visit.
       */
      el.innerHTML = `
        <div class="card mb">
          <div class="card-head"><h3>Anyone else</h3>
            <span class="muted small">Search by name, UHID or mobile — order tests without a visit</span></div>
          <div class="card-body">
            <div class="search-row">
              <input type="search" id="cs-q" placeholder="Name, UHID or mobile number…" autocomplete="off">
            </div>
            <div id="cs-results"></div>
          </div>
        </div>
        <div id="cs-queue"></div>`;

      let t;
      const results = el.querySelector('#cs-results');
      el.querySelector('#cs-q').addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = e.target.value.trim();
          if (q.length < 2) return void (results.innerHTML = '');
          let rows = [];
          try { rows = (await API.get('/api/patients' + API.qs({ q, limit: 8 }))).rows; }
          catch (err) { return void (results.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`); }
          results.innerHTML = rows.length ? rows.map((p) => `
            <div class="row-between mb" style="gap:8px;align-items:center">
              <span><b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>
                <span class="muted small"> ${UI.esc(p.uhid)} · ${UI.esc(p.age_years || '—')}${
                  UI.esc((p.gender || '').charAt(0).toUpperCase())}${
                  p.phone ? ' · ' + UI.esc(p.phone) : ''}</span>
                ${p.allergies ? ' ' + UI.badge('⚠ Allergy', 'danger') : ''}</span>
              <span style="flex:none">
                <button class="btn sm" data-order="${p.id}"
                  data-name="${UI.esc(p.first_name + ' ' + (p.last_name || ''))}">Order tests</button>
                <button class="btn ghost sm" data-record="${p.id}">Record</button>
              </span>
            </div>`).join('')
            : '<div class="muted small">Nobody matched. Register them at the front desk first.</div>';

          results.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () =>
            openLabOrder({
              patientId: Number(b.dataset.order),
              patientName: b.dataset.name.trim(),
              onPlaced: () => APP.navigate('lab'),
            })));
          results.querySelectorAll('[data-record]').forEach((b) => b.addEventListener('click', () =>
            APP.navigate('patients', { id: b.dataset.record })));
        }, 220);
      });

      await pickVisit(el.querySelector('#cs-queue'),
        ['vitals_done', 'with_provider', 'checked_in'], 'Patients ready to be seen',
        (id) => APP.navigate('consult', { visitId: id }));
    },
  });

  async function renderConsult(el, visitId) {
    const [visit, drugs, tests] = await Promise.all([
      API.get(`/api/visits/${visitId}`),
      API.get('/api/pharmacy/drugs?limit=300'),
      API.get('/api/masters/lab-tests'),
    ]);
    const c = visit.consultation;
    const v = visit.vitals[0];

    APP.setSubtitle(`${visit.patient_name} · ${visit.uhid} · ${visit.age_years || '—'}/${(visit.gender || '').charAt(0).toUpperCase()}`);
    APP.actions([
      { id: 'back', label: '← Consultation queue', onClick: () => APP.navigate('consult') },
      { id: 'record', label: 'Patient record', onClick: () => APP.navigate('patients', { id: visit.patient_id }) },
    ]);

    el.innerHTML = `
      ${visit.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(visit.allergies)}</div>` : ''}
      ${visit.chronic_conditions ? `<div class="alert info"><b>Chronic conditions:</b> ${UI.esc(visit.chronic_conditions)}</div>` : ''}
      ${visit.screening_due ? '<div class="alert warn">⏰ Yearly screening is due — tick “screening done” once completed.</div>' : ''}
      ${c && c.signed_at ? '<div class="alert ok">This note is <b>signed</b>. Further edits will not change the signature time.</div>' : ''}

      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>Clinical note</h3><span class="muted small">SOAP</span></div>
            <div class="card-body">
              <form id="c-form">
                ${UI.field({ name: 'chiefComplaint', label: 'Chief complaint', value: c ? c.chief_complaint || '' : visit.reason_for_visit || '' })}
                ${UI.field({ name: 'subjective', label: 'S — history of present illness', type: 'textarea', rows: 3, value: c ? c.subjective || '' : '' })}
                ${UI.field({ name: 'objective', label: 'O — examination findings', type: 'textarea', rows: 3, value: c ? c.objective || '' : '' })}
                ${UI.field({ name: 'assessment', label: 'A — assessment', type: 'textarea', rows: 2, value: c ? c.assessment || '' : '' })}
                ${UI.field({ name: 'plan', label: 'P — plan', type: 'textarea', rows: 2, value: c ? c.plan || '' : '' })}
                ${UI.field({ name: 'advice', label: 'Advice to the patient', type: 'textarea', rows: 2, value: c ? c.advice || '' : '' })}
                <div class="grid c3">
                  ${UI.field({ name: 'followUpDays', label: 'Review in (days)', type: 'number', min: 0, value: c ? c.follow_up_days || '' : '' })}
                  ${UI.field({ name: 'referredTo', label: 'Referred to', value: c ? c.referred_to || '' : '' })}
                  <div>${UI.checkbox({ name: 'screeningDone', label: 'Yearly screening done', checked: c ? !!c.screening_done : false })}</div>
                </div>
              </form>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Diagnoses</h3>
              <button class="btn ghost sm" id="add-dx">+ Add diagnosis</button></div>
            <div class="card-body" id="dx-list"></div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Prescription</h3>
              <button class="btn ghost sm" id="add-rx">+ Add medicine</button></div>
            <div class="card-body" id="rx-list"></div>
          </div>
        </div>

        <div>
          <div class="card"><div class="card-head"><h3>Vitals today</h3></div>
            <div class="card-body">${v ? `<dl class="kv">
              <dt>BP</dt><dd>${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')} mmHg</dd>
              <dt>Pulse</dt><dd>${UI.esc(v.pulse || '—')} bpm</dd>
              <dt>Temp</dt><dd>${UI.esc(v.temp_c || '—')} °C</dd>
              <dt>SpO₂</dt><dd>${UI.esc(v.spo2 || '—')}%</dd>
              <dt>Wt / BMI</dt><dd>${UI.esc(v.weight_kg || '—')} kg / ${UI.esc(v.bmi || '—')}</dd>
              <dt>Sugar</dt><dd>${UI.esc(v.blood_sugar || '—')}</dd>
            </dl>` : '<div class="alert warn">No vitals recorded yet.</div>'}</div>
          </div>

          <div class="card"><div class="card-head"><h3>Diagnostic orders</h3>
            <button class="btn ghost sm" id="order-labs">+ Order tests</button></div>
            <div class="card-body" id="lab-list">
              ${visit.labOrders.length ? visit.labOrders.map((o) =>
                `<div class="mb small"><b>${UI.esc(o.order_no)}</b> ${UI.statusBadge(o.status)}
                 <div class="muted">${UI.esc(o.tests || '')}</div></div>`).join('')
                : '<div class="muted small">None ordered.</div>'}
            </div>
          </div>

          <div class="card"><div class="card-head"><h3>Actions</h3></div>
            <div class="card-body">
              <button class="btn block mb" id="save-note">Save clinical note</button>
              <button class="btn teal block mb" id="sign-note">Sign &amp; send to check-out</button>
              <button class="btn ghost block" id="print-rx">Print prescription</button>
            </div>
          </div>
        </div>
      </div>`;

    // ---- diagnoses -------------------------------------------------------
    let diagnoses = c && c.diagnoses ? c.diagnoses.map((d) => ({ icdCode: d.icd_code, title: d.title, kind: d.kind })) : [];
    const drawDx = () => {
      const host = el.querySelector('#dx-list');
      host.innerHTML = diagnoses.length ? diagnoses.map((d, i) =>
        `<div class="row-between mb"><span>${UI.badge(d.kind, 'teal')}
          <b>${UI.esc(d.icdCode || '')}</b> ${UI.esc(d.title)}</span>
          <button class="btn ghost sm" data-rm-dx="${i}">Remove</button></div>`).join('')
        : '<div class="muted small">No diagnosis recorded.</div>';
      host.querySelectorAll('[data-rm-dx]').forEach((b) => b.addEventListener('click', () => {
        diagnoses.splice(Number(b.dataset.rmDx), 1); drawDx();
      }));
    };
    drawDx();

    el.querySelector('#add-dx').addEventListener('click', () => {
      UI.modal({
        title: 'Add a diagnosis', size: 'narrow',
        body: `<div class="search-row"><input type="search" id="icd-q" placeholder="Search ICD-10 code or term…" autofocus></div>
               <div id="icd-res"></div>
               <fieldset class="mt"><legend>Or type it freely</legend>
                 ${UI.field({ name: 'title', label: 'Diagnosis' })}
                 ${UI.field({ name: 'kind', label: 'Type', value: 'provisional',
                   options: ['provisional','final','differential','comorbidity'].map((k) => ({ value: k, label: UI.titleise(k) })) })}
               </fieldset>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="add">Add</button>`,
        onMount(modal) {
          let t;
          modal.querySelector('#icd-q').addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(async () => {
              const res = await API.get('/api/masters/icd' + API.qs({ q: e.target.value.trim() }));
              const host = modal.querySelector('#icd-res');
              host.innerHTML = res.map((r) =>
                `<button type="button" class="btn ghost sm block mb" data-icd="${UI.esc(r.code)}" data-title="${UI.esc(r.title)}"
                  style="justify-content:flex-start"><b>${UI.esc(r.code)}</b>&nbsp;${UI.esc(r.title)}</button>`).join('')
                || '<div class="muted small">No match.</div>';
              host.querySelectorAll('[data-icd]').forEach((b) => b.addEventListener('click', () => {
                diagnoses.push({ icdCode: b.dataset.icd, title: b.dataset.title,
                  kind: modal.querySelector('[name=kind]').value });
                UI.closeModal(); drawDx();
              }));
            }, 200);
          });
        },
        onAction(act, modal) {
          if (act !== 'add') return;
          const values = UI.formValues(modal);
          if (!values.title) { UI.err('Enter a diagnosis.'); return 'keep'; }
          diagnoses.push({ icdCode: null, title: values.title, kind: values.kind });
          drawDx();
        },
      });
    });

    // ---- prescriptions ---------------------------------------------------
    let prescriptions = c ? c.prescriptions.map((p) => ({
      drugId: p.drug_id, drugName: p.drug_name, dose: p.dose, frequency: p.frequency,
      route: p.route, durationDays: p.duration_days, quantity: p.quantity, instructions: p.instructions,
    })) : [];

    const drawRx = () => {
      const host = el.querySelector('#rx-list');
      host.innerHTML = prescriptions.length ? UI.table([
        { label: 'Medicine', render: (r) => `<b>${UI.esc(r.drugName)}</b>` },
        { label: 'Dose', render: (r) => UI.esc(r.dose || '—') },
        { label: 'Freq', render: (r) => UI.esc(r.frequency || '—') },
        { label: 'Days', num: true, render: (r) => UI.esc(r.durationDays || '—') },
        { label: 'Qty', num: true, render: (r) => UI.esc(r.quantity || 0) },
        { label: 'Instructions', render: (r) => UI.esc(r.instructions || '') },
        { label: '', render: (r, i) => `<button class="btn ghost sm" data-rm-rx="${i}">×</button>` },
      ], prescriptions) : '<div class="muted small">No medicines prescribed.</div>';
      host.querySelectorAll('[data-rm-rx]').forEach((b) => b.addEventListener('click', () => {
        prescriptions.splice(Number(b.dataset.rmRx), 1); drawRx();
      }));
    };
    drawRx();

    el.querySelector('#add-rx').addEventListener('click', () => {
      UI.modal({
        title: 'Add a medicine',
        body: `<form id="rx-form">
          ${UI.field({ name: 'drugId', label: 'Medicine', required: true,
            options: [{ value: '', label: '— select from formulary —' }].concat(
              drugs.map((d) => ({ value: d.id, label: `${d.name} ${d.strength || ''} (${d.form || ''}) — stock ${d.on_hand}` }))) })}
          <div class="grid c3">
            ${UI.field({ name: 'dose', label: 'Dose', placeholder: 'e.g. 1 tablet' })}
            ${UI.field({ name: 'frequency', label: 'Frequency', value: 'BD',
              options: [{ value: 'OD', label: 'OD — once a day' }, { value: 'BD', label: 'BD — twice a day' },
                        { value: 'TDS', label: 'TDS — three times a day' }, { value: 'QID', label: 'QID — four times a day' },
                        { value: 'HS', label: 'HS — at bedtime' }, { value: 'SOS', label: 'SOS — as needed' },
                        { value: 'STAT', label: 'STAT — immediately' }] })}
            ${UI.field({ name: 'route', label: 'Route', value: 'oral',
              options: ['oral','iv','im','sc','topical','inhalation','eye','ear','rectal'].map((r) => ({ value: r, label: r.toUpperCase() })) })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'durationDays', label: 'Duration (days)', type: 'number', min: 1, value: 5 })}
            ${UI.field({ name: 'quantity', label: 'Quantity to dispense', type: 'number', min: 0, value: 10 })}
          </div>
          ${UI.field({ name: 'instructions', label: 'Instructions', placeholder: 'e.g. after food' })}
        </form>
        <div id="rx-warn"></div>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="add">Add to prescription</button>`,
        onMount(modal) {
          // Suggest a quantity from frequency × duration, and warn on allergies.
          const recalc = () => {
            const perDay = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, SOS: 1, STAT: 1 }[modal.querySelector('[name=frequency]').value] || 1;
            const days = Number(modal.querySelector('[name=durationDays]').value) || 0;
            modal.querySelector('[name=quantity]').value = perDay * days;
          };
          modal.querySelector('[name=frequency]').addEventListener('change', recalc);
          modal.querySelector('[name=durationDays]').addEventListener('input', recalc);
          modal.querySelector('[name=drugId]').addEventListener('change', (e) => {
            const drug = drugs.find((d) => d.id === Number(e.target.value));
            const warn = modal.querySelector('#rx-warn');
            const allergies = (visit.allergies || '').toLowerCase();
            const hit = drug && allergies && allergies.split(/[,;]/).some((a) =>
              a.trim().length > 2 && `${drug.name} ${drug.generic_name || ''}`.toLowerCase().includes(a.trim()));
            warn.innerHTML = hit
              ? `<div class="alert danger">⚠ This may conflict with a recorded allergy: <b>${UI.esc(visit.allergies)}</b></div>`
              : (drug && drug.on_hand <= 0 ? '<div class="alert warn">Out of stock in the clinic pharmacy.</div>' : '');
          });
        },
        onAction(act, modal) {
          if (act !== 'add') return;
          const form = modal.querySelector('#rx-form');
          if (!form.reportValidity()) return 'keep';
          const values = UI.formValues(form);
          const drug = drugs.find((d) => d.id === Number(values.drugId));
          prescriptions.push({ ...values, drugId: Number(values.drugId), drugName: drug ? drug.name : 'Medicine' });
          drawRx();
        },
      });
    });

    // ---- lab ordering ----------------------------------------------------
    el.querySelector('#order-labs').addEventListener('click', () => openLabOrder({
      patientId: visit.patient_id, visitId, patientName: visit.patient_name, tests,
      onPlaced: () => APP.reload(),
    }));

    // ---- save / sign -----------------------------------------------------
    const collect = () => ({ ...UI.formValues(el.querySelector('#c-form')), diagnoses, prescriptions });

    el.querySelector('#save-note').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await API.post(`/api/visits/${visitId}/consultation`, collect());
        UI.ok('Clinical note saved.');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    });

    el.querySelector('#sign-note').addEventListener('click', async (e) => {
      if (!(await UI.confirm('Sign this note and send the patient to the next step?'))) return;
      e.target.disabled = true;
      try {
        await API.post(`/api/visits/${visitId}/consultation`, collect());
        const res = await API.post(`/api/visits/${visitId}/consultation/sign`);
        UI.ok(`Signed. Next: ${UI.titleise(res.nextStep)}${res.labsOpen ? ` (${res.labsOpen} lab order open)` : ''}.`);
        APP.navigate('consult');
      } catch (err) { UI.err(err.message); e.target.disabled = false; }
    });

    el.querySelector('#print-rx').addEventListener('click', () => printPrescription(visit, diagnoses, prescriptions));
  }

  /**
   * Order diagnostics for a patient.
   *
   * Shared by the consultation and by the "anyone else" search on the
   * Consultation landing page, because ordering a test is not always part of
   * writing a note: a patient rings up about a sugar reading, a review patient
   * needs a repeat film, a colleague asks for a panel before the next clinic.
   * None of those has a visit open, and a lab order does not need one.
   *
   * What is deliberately not here is a rate. The doctor picks what the patient
   * needs; the cashier prices it and takes the money; the bench sees it after
   * that. The dialog says so rather than letting the order look finished.
   */
  async function openLabOrder({ patientId, visitId = null, patientName = '', tests = null, onPlaced }) {
    const catalogue = tests || await API.get('/api/masters/lab-tests');
    const chosen = new Set();
    // Prices only exist here for the desks that may see them; a doctor's copy
    // of the catalogue arrives with them blanked by the server.
    const prices = APP.seesPrices();

    UI.modal({
      title: `Order diagnostics${patientName ? ' — ' + patientName : ''}`,
      size: 'wide',
      body: `<div class="search-row"><input type="search" id="lt-q" placeholder="Filter tests…" autofocus>
          <select name="priority"><option value="routine">Routine</option>
            <option value="urgent">Urgent</option><option value="stat">STAT</option></select></div>
        <div id="lt-list" class="table-wrap" style="max-height:340px;overflow-y:auto"></div>
        ${UI.field({ name: 'clinicalNotes', label: 'Clinical notes for the lab', placeholder: 'e.g. fasting sample, suspected anaemia' })}
        <div id="lt-total" class="alert info" hidden></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="order">Place order</button>`,
      onMount(modal) {
        const draw = (filter = '') => {
          const rows = catalogue.filter((t) => !filter
            || t.name.toLowerCase().includes(filter) || t.code.toLowerCase().includes(filter));
          modal.querySelector('#lt-list').innerHTML = `<table><thead><tr>
            <th></th><th>Test</th><th>Category</th><th>Sample</th>${
              prices ? '<th class="num">Price</th>' : ''}<th class="num">TAT</th></tr></thead><tbody>
            ${rows.map((t) => `<tr><td><input type="checkbox" data-test="${t.id}"${chosen.has(t.id) ? ' checked' : ''}></td>
              <td><b>${UI.esc(t.name)}</b><div class="muted small">${UI.esc(t.code)}</div></td>
              <td>${UI.esc(UI.titleise(t.category))}</td><td>${UI.esc(t.sample_type || '—')}</td>
              ${prices ? `<td class="num">${UI.money(t.price)}</td>` : ''}<td class="num">${UI.esc(t.tat_hours)}h</td></tr>`).join('')}
            </tbody></table>`;
          modal.querySelectorAll('[data-test]').forEach((cb) => cb.addEventListener('change', () => {
            const id = Number(cb.dataset.test);
            if (cb.checked) chosen.add(id); else chosen.delete(id);
            const total = catalogue.filter((t) => chosen.has(t.id)).reduce((sum, t) => sum + (t.price || 0), 0);
            const out = modal.querySelector('#lt-total');
            out.hidden = !chosen.size;
            out.innerHTML = prices
              ? `${chosen.size} test(s) selected — <b>${UI.money(total)}</b> will be added to the bill.`
              : `${chosen.size} test(s) selected. The cashier prices these and takes the payment;
                 the lab starts once the bill is settled.`;
          }));
        };
        draw();
        modal.querySelector('#lt-q').addEventListener('input', (e) => draw(e.target.value.trim().toLowerCase()));
      },
      async onAction(act, modal) {
        if (act !== 'order') return;
        if (!chosen.size) { UI.err('Select at least one test.'); return 'keep'; }
        const values = UI.formValues(modal);
        const order = await API.post('/api/lab/orders', {
          patientId, visitId,
          tests: [...chosen].map((id) => ({ testId: id })),
          priority: values.priority, clinicalNotes: values.clinicalNotes,
        });
        UI.ok(`Order ${order.order_no} placed — it goes to the cashier, then the lab.`);
        if (onPlaced) onPlaced(order);
      },
    });
  }

  function printPrescription(visit, diagnoses, prescriptions) {
    const html = `<div class="doc">
      ${UI.docHeader('Prescription', [`Visit: ${visit.visit_no}`, `Date: ${UI.date(visit.arrived_at)}`])}
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(visit.patient_name)}</td><th>UHID</th><td>${UI.esc(visit.uhid)}</td></tr>
        <tr><th>Age / Sex</th><td>${UI.esc(visit.age_years || '—')} / ${UI.esc(visit.gender || '—')}</td>
            <th>Doctor</th><td>${UI.esc(visit.doctor_name || '—')}</td></tr>
      </tbody></table>
      ${visit.allergies ? `<p style="color:#C0392B"><b>Allergies:</b> ${UI.esc(visit.allergies)}</p>` : ''}
      ${diagnoses.length ? `<p><b>Diagnosis:</b> ${diagnoses.map((d) => UI.esc(`${d.icdCode || ''} ${d.title}`.trim())).join('; ')}</p>` : ''}
      <h4 class="mt" style="font-size:22px;font-family:Georgia,serif">℞</h4>
      <table><thead><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Route</th><th>Days</th><th>Instructions</th></tr></thead><tbody>
        ${prescriptions.map((p, i) => `<tr><td>${i + 1}</td><td><b>${UI.esc(p.drugName)}</b></td>
          <td>${UI.esc(p.dose || '')}</td><td>${UI.esc(p.frequency || '')}</td><td>${UI.esc((p.route || '').toUpperCase())}</td>
          <td>${UI.esc(p.durationDays || '')}</td><td>${UI.esc(p.instructions || '')}</td></tr>`).join('')}
      </tbody></table>
      <div class="sign"><div></div><div>${UI.esc(visit.doctor_name || '')}<br>Consulting doctor</div></div>
      <div class="foot-note">This prescription is valid for the condition assessed today. Do not self-medicate or
        repeat without review.</div>
    </div>`;
    UI.print(html, 'Prescription ' + visit.visit_no);
  }
})();
