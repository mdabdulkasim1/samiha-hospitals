/* Patient queue board — the live view of the clinic workflow, lane by lane. */
(function () {
  'use strict';

  // Lanes mirror the swimlanes of the clinic workflow chart.
  const LANES = [
    { key: 'waiting_room',        label: 'Waiting room',      lane: 'lane-checkin' },
    { key: 'financial_screening', label: 'Financial screening', lane: 'lane-finance' },
    { key: 'checked_in',          label: 'Checked in',        lane: 'lane-checkin' },
    { key: 'vitals_done',         label: 'Vitals done',       lane: 'lane-exam' },
    { key: 'with_provider',       label: 'With provider',     lane: 'lane-exam' },
    { key: 'labs_pending',        label: 'Diagnostics',       lane: 'lane-exam' },
    { key: 'pharmacy_pending',    label: 'Pharmacy',          lane: 'lane-exam' },
    { key: 'billing_pending',     label: 'Check-out desk',    lane: 'lane-checkout' },
    { key: 'checked_out',         label: 'Left the clinic',   lane: 'lane-checkout' },
  ];

  let timer = null;

  APP.register('queue', {
    title: 'Patient Queue',
    subtitle: 'Live board — arrival through to exit',

    async render(el, params) {
      const date = params.date || UI.today();

      APP.actions([
        ...(APP.can(['reception']) ? [{ id: 'arrive', label: '+ Patient arrived', kind: '', onClick: () => openArrival() }] : []),
        { id: 'refresh', label: 'Refresh', onClick: () => APP.reload() },
      ]);

      await draw(el, date);

      // Keep the board live without hammering the server.
      clearInterval(timer);
      timer = setInterval(() => {
        if (APP.route !== 'queue') return clearInterval(timer);
        draw(el, date, true).catch(() => {});
      }, 20000);
    },
  });

  async function draw(el, date, quiet) {
    if (!quiet) el.innerHTML = UI.loading();
    const board = await API.get('/api/visits/board' + API.qs({ date }));

    const waiting = board.rows.filter((r) => r.status !== 'checked_out').length;
    APP.setSubtitle(`${UI.dateTime(date + ' 00:00:00').split('·')[0].trim()} — ${waiting} patient(s) in the clinic, ${board.counts.checked_out || 0} left`);

    el.innerHTML = `
      <div class="search-row no-print">
        <input type="date" id="board-date" value="${UI.esc(date)}">
        <input type="search" id="board-search" placeholder="Filter by name, UHID or token…">
      </div>
      <div class="board" id="board">
        ${LANES.map((lane) => {
          const rows = board.rows.filter((r) => r.status === lane.key);
          return `<div class="board-col ${lane.lane}">
            <header>${UI.esc(lane.label)}<span class="n">${rows.length}</span></header>
            <div class="items">${rows.map(card).join('') || '<div class="muted small" style="padding:8px">—</div>'}</div>
          </div>`;
        }).join('')}
      </div>`;

    el.querySelector('#board-date').addEventListener('change', (e) =>
      APP.navigate('queue', { date: e.target.value }));

    el.querySelector('#board-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      el.querySelectorAll('.qcard').forEach((c) => {
        c.hidden = q ? !c.dataset.search.includes(q) : false;
      });
    });

    el.querySelectorAll('.qcard').forEach((c) =>
      c.addEventListener('click', () => openVisit(Number(c.dataset.visit))));
  }

  function card(r) {
    const tags = [];
    if (r.is_new_patient) tags.push(UI.badge('New patient', 'crimson'));
    if (r.screening_due) tags.push(UI.badge('Screening due', 'orange'));
    if (r.allergies) tags.push(UI.badge('⚠ Allergy', 'danger'));
    if (r.labs_open) tags.push(UI.badge(`${r.labs_open} lab`, 'warn'));
    if (r.rx_pending) tags.push(UI.badge(`${r.rx_pending} Rx`, 'warn'));
    if (r.invoice_balance > 0) tags.push(UI.badge(UI.money(r.invoice_balance) + ' due', 'danger'));
    if (r.screening_status && r.screening_status !== 'completed') tags.push(UI.badge(UI.titleise(r.screening_status), 'orange'));

    const search = `${r.patient_name} ${r.uhid} ${r.token_no || ''} ${r.doctor_name || ''}`.toLowerCase();
    return `<div class="qcard" data-visit="${r.id}" data-search="${UI.esc(search)}">
      <span class="token">#${UI.esc(r.token_no || '—')}</span>
      <div class="name">${UI.esc(r.patient_name)}</div>
      <div class="meta">${UI.esc(r.uhid)} · ${UI.esc(r.age_years || '—')}${UI.esc((r.gender || '').charAt(0).toUpperCase())}</div>
      <div class="meta">${UI.esc(r.doctor_name || 'Doctor not assigned')}${r.room_no ? ' · ' + UI.esc(r.room_no) : ''}</div>
      <div class="meta">Arrived ${UI.esc(UI.ago(r.arrived_at))}</div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------- patient arrival
  /** "Patient Walk In" — search the patient, then answer the decision diamonds. */
  async function openArrival() {
    UI.modal({
      title: 'Patient arrival',
      size: '',
      body: `
        <div class="alert info">Search for the patient. If they are not registered yet, register them first from
          <b>Patients → Register</b>, then come back here.</div>
        <div class="search-row"><input type="search" id="ar-q" placeholder="Name, UHID or phone…" autofocus></div>
        <div id="ar-results">${UI.empty('Start typing to search.', '🔎')}</div>
        <div id="ar-form"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>`,
      onMount(modal) {
        const input = modal.querySelector('#ar-q');
        let t;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = input.value.trim();
            const host = modal.querySelector('#ar-results');
            if (q.length < 2) return void (host.innerHTML = UI.empty('Type at least two characters.', '🔎'));
            host.innerHTML = UI.loading();
            const res = await API.get('/api/patients' + API.qs({ q, limit: 8 }));
            host.innerHTML = res.rows.length
              ? UI.table([
                  { label: 'UHID', key: 'uhid' },
                  { label: 'Name', render: (p) => `${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}` },
                  { label: 'Age/Sex', render: (p) => `${UI.esc(p.age_years || '—')} / ${UI.esc(p.gender || '—')}` },
                  { label: 'Phone', key: 'phone' },
                  { label: '', render: (p) => `<button class="btn sm" data-pick="${p.id}">Select</button>` },
                ], res.rows)
              : UI.empty('No patient matched. Register them first.', '🙋');
            host.querySelectorAll('[data-pick]').forEach((b) =>
              b.addEventListener('click', () => showArrivalForm(modal, res.rows.find((p) => p.id === Number(b.dataset.pick)))));
          }, 220);
        });
      },
    });
  }

  async function showArrivalForm(modal, patient) {
    const [doctors, screening] = await Promise.all([
      API.get('/api/masters/staff?role=doctor'),
      API.get(`/api/patients/${patient.id}/screening-status`),
    ]);

    modal.querySelector('#ar-results').innerHTML =
      `<div class="alert ok"><b>${UI.esc(patient.first_name)} ${UI.esc(patient.last_name || '')}</b> · ${UI.esc(patient.uhid)}
        · ${UI.esc(patient.age_years || '—')} / ${UI.esc(patient.gender || '—')}
        ${patient.is_uninsured ? ' · <b>Uninsured</b>' : ' · Insured'}
        ${patient.allergies ? ` · ⚠ Allergy: ${UI.esc(patient.allergies)}` : ''}</div>`;

    modal.querySelector('#ar-form').innerHTML = `
      <form id="arrival-form">
        <div class="grid c2">
          ${UI.field({ name: 'doctorId', label: 'Doctor', required: true,
            options: [{ value: '', label: '— select —' }].concat(doctors.map((d) => ({ value: d.id, label: `${d.name} · ${d.department_name || ''}` }))) })}
          ${UI.field({ name: 'visitType', label: 'Visit type', value: 'opd',
            options: [{ value: 'opd', label: 'OPD' }, { value: 'emergency', label: 'Emergency' },
                      { value: 'review', label: 'Review' }, { value: 'teleconsult', label: 'Teleconsult' }] })}
        </div>
        ${UI.field({ name: 'reasonForVisit', label: 'Reason for visit', required: true, placeholder: 'e.g. fever and body ache for 3 days' })}
        ${screening.due ? '<div class="alert warn">⏰ <b>Yearly screening is due</b> for this patient — flag it to the doctor.</div>' : ''}
        ${UI.checkbox({ name: 'financialSituationChanged', label: 'Financial situation has changed since the last visit' })}
        ${UI.checkbox({ name: 'needsFinancialAssistance', label: 'Needs financial assistance screening', checked: !!patient.is_uninsured })}
        <button class="btn block" type="submit">Record arrival</button>
      </form>`;

    modal.querySelector('#arrival-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const values = UI.formValues(e.target);
        const res = await API.post('/api/visits/arrive', { patientId: patient.id, ...values });
        UI.closeModal();
        UI.ok(`${patient.first_name} added to the queue — token #${res.visit.token_no}.`);
        if (res.nextStep === 'financial_screening') {
          UI.warn('Uninsured or changed circumstances — send the patient to financial screening.');
        }
        APP.reload();
      } catch (err) {
        UI.err(err.message);
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------- visit sheet
  /** The visit drawer: everything about this encounter plus the next actions. */
  async function openVisit(visitId) {
    const visit = await API.get(`/api/visits/${visitId}`);
    const v = visit.vitals[0];

    const actions = nextActions(visit);
    UI.modal({
      title: `${visit.patient_name} — ${visit.visit_no}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>
            <span class="badge crimson">Token #${UI.esc(visit.token_no || '—')}</span>
            ${UI.statusBadge(visit.status)}
            ${visit.is_new_patient ? UI.badge('New patient', 'crimson') : ''}
            ${visit.screening_due ? UI.badge('Yearly screening due', 'orange') : ''}
          </div>
          <a class="btn ghost sm" href="#/patients?id=${visit.patient_id}" onclick="UI.closeModal()">Open patient record</a>
        </div>

        ${visit.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(visit.allergies)}</div>` : ''}
        ${visit.chronic_conditions ? `<div class="alert info"><b>Chronic:</b> ${UI.esc(visit.chronic_conditions)}</div>` : ''}

        <div class="grid c2">
          <div>
            <fieldset><legend>Encounter</legend>
              <dl class="kv">
                <dt>UHID</dt><dd>${UI.esc(visit.uhid)}</dd>
                <dt>Age / Sex</dt><dd>${UI.esc(visit.age_years || '—')} / ${UI.esc(visit.gender || '—')}</dd>
                <dt>Doctor</dt><dd>${UI.esc(visit.doctor_name || '—')}</dd>
                <dt>Department</dt><dd>${UI.esc(visit.department_name || '—')}</dd>
                <dt>Reason</dt><dd>${UI.esc(visit.reason_for_visit || '—')}</dd>
                <dt>Arrived</dt><dd>${UI.esc(UI.time(visit.arrived_at))} (${UI.esc(UI.ago(visit.arrived_at))})</dd>
                ${visit.exit_pass_no ? `<dt>Exit pass</dt><dd>${UI.esc(visit.exit_pass_no)}</dd>` : ''}
              </dl>
            </fieldset>

            ${v ? `<fieldset><legend>Latest vitals</legend><dl class="kv">
              <dt>BP</dt><dd>${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')} mmHg</dd>
              <dt>Pulse</dt><dd>${UI.esc(v.pulse || '—')} bpm</dd>
              <dt>Temp</dt><dd>${UI.esc(v.temp_c || '—')} °C</dd>
              <dt>SpO₂</dt><dd>${UI.esc(v.spo2 || '—')} %</dd>
              <dt>Ht / Wt</dt><dd>${UI.esc(v.height_cm || '—')} cm / ${UI.esc(v.weight_kg || '—')} kg</dd>
              <dt>BMI</dt><dd>${UI.esc(v.bmi || '—')}</dd>
            </dl></fieldset>` : '<fieldset><legend>Vitals</legend><div class="muted">Not recorded yet.</div></fieldset>'}
          </div>

          <div>
            ${visit.consultation ? `<fieldset><legend>Consultation</legend>
              <dl class="kv">
                <dt>Complaint</dt><dd>${UI.esc(visit.consultation.chief_complaint || '—')}</dd>
                <dt>Assessment</dt><dd>${UI.esc(visit.consultation.assessment || '—')}</dd>
                <dt>Plan</dt><dd>${UI.esc(visit.consultation.plan || '—')}</dd>
                <dt>Signed</dt><dd>${visit.consultation.signed_at ? UI.esc(UI.time(visit.consultation.signed_at)) : UI.badge('Not signed', 'warn')}</dd>
              </dl>
              ${visit.consultation.diagnoses.length ? '<div class="mt small"><b>Diagnoses:</b> ' +
                visit.consultation.diagnoses.map((d) => UI.badge(`${d.icd_code || ''} ${d.title}`.trim(), 'teal')).join(' ') + '</div>' : ''}
            </fieldset>` : '<fieldset><legend>Consultation</legend><div class="muted">Not started.</div></fieldset>'}

            <fieldset><legend>Orders &amp; medicines</legend>
              ${visit.labOrders.length ? visit.labOrders.map((o) =>
                `<div class="small mb">${UI.esc(o.order_no)} — ${UI.esc(o.tests || '')} ${UI.statusBadge(o.status)}</div>`).join('')
                : '<div class="muted small">No diagnostics ordered.</div>'}
              <div class="mt">${visit.prescriptions.length ? visit.prescriptions.map((p) =>
                `<div class="small">${UI.esc(p.drug_name)} — ${UI.esc(p.dose || '')} ${UI.esc(p.frequency || '')} × ${UI.esc(p.duration_days || '?')}d ${UI.statusBadge(p.status)}</div>`).join('')
                : '<div class="muted small">No prescriptions.</div>'}</div>
            </fieldset>

            ${visit.invoices.length ? `<fieldset><legend>Billing</legend>${visit.invoices.map((i) =>
              `<div class="row-between small"><span>${UI.esc(i.invoice_no)} ${UI.statusBadge(i.status)}</span>
               <b>${UI.money(i.net)}</b></div>
               <div class="muted small">Paid ${UI.money(i.paid)} · Balance ${UI.money(i.balance)}</div>`).join('')}</fieldset>` : ''}
          </div>
        </div>

        <fieldset><legend>Workflow trail</legend>
          <ul class="timeline">${visit.timeline.map((t) =>
            `<li><b>${UI.esc(UI.titleise(t.stage))}</b>
             <div class="muted small">${UI.esc(t.detail || '')}</div>
             <span class="when">${UI.esc(UI.time(t.created_at))}${t.actor_name ? ' · ' + UI.esc(t.actor_name) : ''}</span></li>`).join('')}
          </ul>
        </fieldset>`,
      footer: actions.map((a) =>
        `<button class="btn ${a.kind || 'ghost'}" data-act="${a.id}">${UI.esc(a.label)}</button>`).join('') +
        `<button class="btn ghost" data-act="__close">Close</button>`,
      onAction(act) {
        const action = actions.find((a) => a.id === act);
        if (!action) return;
        action.run(visit);
        // Each action closes or replaces the modal itself; returning 'keep'
        // stops the generic handler from wiping the modal it just opened.
        return 'keep';
      },
    });
  }

  /** Suggest the next workflow step, filtered by what this user may do. */
  function nextActions(visit) {
    const out = [];
    const go = (route, params) => () => { UI.closeModal(); APP.navigate(route, params); };

    if (visit.status === 'financial_screening' && APP.can(['counselor', 'reception', 'cashier'])) {
      out.push({ id: 'fs', label: 'Financial screening', kind: '', run: go('financial', { visitId: visit.id, patientId: visit.patient_id }) });
    }
    if (['waiting_room', 'financial_screening'].includes(visit.status) && APP.can(['reception'])) {
      out.push({ id: 'ci', label: 'Check in', kind: 'teal', run: () => checkIn(visit) });
    }
    if (['checked_in'].includes(visit.status) && APP.can(['nurse', 'doctor'])) {
      out.push({ id: 'vi', label: 'Record vitals', kind: 'teal', run: go('vitals', { visitId: visit.id }) });
    }
    if (['vitals_done', 'with_provider'].includes(visit.status) && APP.can(['doctor'])) {
      out.push({ id: 'co', label: 'Consultation', kind: 'teal', run: go('consult', { visitId: visit.id }) });
    }
    if (visit.prescriptions.some((p) => p.status === 'pending') && APP.can(['pharmacy'])) {
      out.push({ id: 'ph', label: 'Dispense medicines', kind: 'teal', run: go('pharmacy', { visitId: visit.id }) });
    }
    if (visit.labOrders.length && APP.can(['lab'])) {
      out.push({ id: 'lb', label: 'Diagnostics', run: go('lab', { visitId: visit.id }) });
    }
    if (visit.status !== 'checked_out' && APP.can(['cashier', 'reception'])) {
      out.push({ id: 'bl', label: 'Check-out desk', kind: '', run: go('billing', { visitId: visit.id }) });
    }
    out.push({ id: 'rp', label: 'Results page', run: () => printResultsPage(visit.id) });
    return out;
  }

  async function checkIn(visit) {
    UI.modal({
      title: 'Check in — ' + visit.patient_name,
      size: 'narrow',
      body: `<div class="alert info">Confirm the reason for the visit before sending the patient to the vitals station.</div>
        <form id="ci-form">
          ${UI.field({ name: 'reasonForVisit', label: 'Reason for visit', required: true, value: visit.reason_for_visit || '' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn teal" data-act="go">Check in</button>`,
      async onAction(act, modal) {
        if (act !== 'go') return;
        const values = UI.formValues(modal.querySelector('#ci-form'));
        if (!values.reasonForVisit) { UI.err('Reason for visit is required.'); return 'keep'; }
        await API.post(`/api/visits/${visit.id}/check-in`, values);
        UI.ok('Checked in — the patient can move to the vitals station.');
        APP.reload();
      },
    });
  }

  /** "Provider Gives Results Page to Patient" — the printable carry sheet. */
  async function printResultsPage(visitId) {
    UI.closeModal();
    const p = await API.get(`/api/visits/${visitId}/results-page`);
    const v = p.vitals;
    const html = `<div class="doc">
      ${UI.docHeader('Visit Results Page', [
        `Visit: ${p.visit.visit_no}`, `Date: ${UI.date(p.visit.arrived_at)}`, `Token: ${p.visit.token_no || '—'}`])}
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(p.visit.first_name)} ${UI.esc(p.visit.last_name || '')}</td>
            <th>UHID</th><td>${UI.esc(p.visit.uhid)}</td></tr>
        <tr><th>Age / Sex</th><td>${UI.esc(p.visit.age_years || '—')} / ${UI.esc(p.visit.gender || '—')}</td>
            <th>Doctor</th><td>${UI.esc(p.visit.doctor_name || '—')}</td></tr>
      </tbody></table>

      ${v ? `<h4 class="mt">Vitals</h4><table><tbody><tr>
        <th>BP</th><td>${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')}</td>
        <th>Pulse</th><td>${UI.esc(v.pulse || '—')}</td>
        <th>Temp</th><td>${UI.esc(v.temp_c || '—')} °C</td>
        <th>SpO₂</th><td>${UI.esc(v.spo2 || '—')}%</td>
        <th>BMI</th><td>${UI.esc(v.bmi || '—')}</td></tr></tbody></table>` : ''}

      ${p.consultation ? `<h4 class="mt">Assessment &amp; plan</h4>
        <p><b>Complaint:</b> ${UI.esc(p.consultation.chief_complaint || '—')}</p>
        <p><b>Assessment:</b> ${UI.esc(p.consultation.assessment || '—')}</p>
        <p><b>Plan:</b> ${UI.esc(p.consultation.plan || '—')}</p>
        ${p.consultation.advice ? `<p><b>Advice:</b> ${UI.esc(p.consultation.advice)}</p>` : ''}
        ${p.consultation.follow_up_date ? `<p><b>Review on:</b> ${UI.esc(UI.date(p.consultation.follow_up_date))}</p>` : ''}` : ''}

      ${p.labOrders.length ? `<h4 class="mt">Diagnostic orders</h4>
        <table><thead><tr><th>Order</th><th>Tests</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
        ${p.labOrders.map((o) => `<tr><td>${UI.esc(o.order_no)}</td><td>${UI.esc(o.tests || '')}</td>
          <td>${UI.esc(UI.titleise(o.status))}</td><td class="num">${UI.money(o.total_price)}</td></tr>`).join('')}
        </tbody></table>` : ''}

      ${p.medicationList.length ? `<h4 class="mt">Medication list</h4>
        <table><thead><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Days</th><th>Instructions</th></tr></thead><tbody>
        ${p.medicationList.map((m) => `<tr><td>${UI.esc(m.drug_name)}</td><td>${UI.esc(m.dose || '')}</td>
          <td>${UI.esc(m.frequency || '')}</td><td>${UI.esc(m.duration_days || '')}</td>
          <td>${UI.esc(m.instructions || '')}</td></tr>`).join('')}
        </tbody></table>
        ${p.visit.pharmacy_name ? `<p class="small">Preferred pharmacy: <b>${UI.esc(p.visit.pharmacy_name)}</b> ${UI.esc(p.visit.pharmacy_phone || '')}</p>` : ''}` : ''}

      <div class="sign"><div>Patient / attendant signature</div><div>${UI.esc(p.visit.doctor_name || '')}<br>Consulting doctor</div></div>
      <div class="foot-note">Please hand this page to the check-out desk before leaving. Reports can also be
        received on WhatsApp.</div>
    </div>`;
    UI.print(html, `Results page ${p.visit.visit_no}`);
  }

  APP.openVisit = openVisit;
})();
