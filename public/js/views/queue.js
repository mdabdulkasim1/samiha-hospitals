/* Patient queue board — the live view of the clinic workflow, lane by lane. */
(function () {
  'use strict';

  // Lanes mirror the swimlanes of the clinic workflow chart.
  /*
   * The lanes, left to right, as the patient actually walks them.
   *
   * `checked_in` is drawn as two lanes rather than one. The patient the front
   * desk has finished with and the patient the cashier has taken the fee from
   * are at the same point of the visit but standing in different queues, and
   * saying which queue somebody is in is the whole job of this board. Which of
   * the two is a question about the money, so the row carries the answer.
   */
  const LANES = [
    { key: 'waiting_room',     label: 'Waiting room',     lane: 'lane-checkin' },
    { key: 'checked_in',       label: 'Consultation fee', lane: 'lane-checkout',
      match: (r) => !r.consultation_paid, foot: 'At the cashier' },
    { key: 'checked_in',       label: 'For the nurse',    lane: 'lane-checkin',
      match: (r) => r.consultation_paid, foot: 'Fee paid' },
    { key: 'vitals_done',      label: 'Vitals done',      lane: 'lane-exam' },
    { key: 'with_provider',    label: 'With provider',    lane: 'lane-exam' },
    { key: 'billing_pending',  label: 'Cashier',          lane: 'lane-checkout',
      foot: 'Tests to pay for, or done' },
    { key: 'labs_pending',     label: 'Diagnostics',      lane: 'lane-exam' },
    { key: 'pharmacy_pending', label: 'Pharmacy',         lane: 'lane-exam' },
    { key: 'checked_out',      label: 'Left the clinic',  lane: 'lane-checkout' },
  ];

  let timer = null;

  const isManagement = () => Boolean(APP.user && ['owner', 'admin'].includes(APP.user.role));
  /*
   * Moving a clinic from one room to another is the front desk's call as
   * much as admin's: a doctor failing to arrive is a nine o'clock problem,
   * and the person who finds out is the receptionist. The room records and
   * the category codes themselves stay with admin.
   */
  const canSetup = () => isManagement() || APP.can(['reception']);

  APP.register('queue', {
    title: 'Patient Queue',
    subtitle: 'Tokens, the rooms they are called to, and the clinic floor',

    async render(el, params) {
      const date = params.date || UI.today();

      /*
       * Three views of the same morning, in the order somebody at the desk
       * needs them. "Now calling" is the queue itself — the numbers, who is
       * next, and the buttons that call them. "Clinic floor" is the older
       * lane board, which answers a different question: not who is next but
       * where in the building everybody has got to. Set-up is the rooms and
       * the category codes, which is a decision about the building and
       * belongs to admin.
       */
      const tabs = {
        calling: (host) => drawQueue(host, date),
        floor: (host) => draw(host, date),
        setup: (host) => drawSetup(host),
      };
      const open = tabs[params.tab] && (params.tab !== 'setup' || canSetup())
        ? params.tab : 'calling';

      APP.actions([
        ...(APP.can(['reception']) ? [{ id: 'arrive', label: '+ Patient arrived', kind: '', onClick: () => openArrival() }] : []),
        ...(APP.can(['reception', 'lab', 'pharmacy', 'nurse']) ? [{ id: 'token', label: 'Issue a token', onClick: () => openIssueToken() }] : []),
        { id: 'tv', label: 'Waiting-room screen', onClick: () => APP.navigate('display', {}) },
        { id: 'refresh', label: 'Refresh', onClick: () => APP.reload() },
      ]);

      el.innerHTML = `
        <div class="tabs" id="q-tabs">
          <button data-tab="calling" class="${open === 'calling' ? 'active' : ''}">Now calling</button>
          <button data-tab="floor" class="${open === 'floor' ? 'active' : ''}">Clinic floor</button>
          ${canSetup() ? `<button data-tab="setup" class="${open === 'setup' ? 'active' : ''}">${
            isManagement() ? 'Rooms &amp; codes' : 'Who sits where'}</button>` : ''}
        </div>
        <div id="q-body">${UI.loading()}</div>`;

      const body = el.querySelector('#q-body');
      el.querySelectorAll('#q-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#q-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        clearInterval(timer);
        body.innerHTML = UI.loading();
        current = b.dataset.tab;
        tabs[current](body);
        live(body, date, tabs, current);
      }));

      let current = open;
      await tabs[open](body);
      live(body, date, tabs, current);
    },
  });

  /*
   * Keep whichever board is open live without hammering the server. Ten
   * seconds on the queue, because a receptionist watching for the doctor to
   * finish should not have to press anything; twenty on the lane board,
   * which nobody stares at.
   */
  function live(body, date, tabs, tab) {
    clearInterval(timer);
    if (tab === 'setup') return;
    timer = setInterval(() => {
      if (APP.route !== 'queue') return clearInterval(timer);
      // A modal open over the board means somebody is mid-decision; redrawing
      // under them would close it.
      if (document.querySelector('#modal-root .modal')) return;
      tabs[tab](body).catch(() => {});
    }, tab === 'calling' ? 10000 : 20000);
  }

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
          const rows = board.rows.filter((r) =>
            r.status === lane.key && (!lane.match || lane.match(r)));
          return `<div class="board-col ${lane.lane}">
            <header>${UI.esc(lane.label)}<span class="n">${rows.length}</span></header>
            ${lane.foot ? `<div class="muted small" style="padding:0 8px 4px">${UI.esc(lane.foot)}</div>` : ''}
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

    el.querySelectorAll('.ring-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const visitId = btn.dataset.ring;
        btn.disabled = true;
        btn.textContent = 'Calling…';
        try {
          const res = await API.post(`/api/visits/${visitId}/call`);
          UI.toast(`Token #${res.tokenNo} called to TV Display!`);
          await draw(el, date, true);
        } catch (err) {
          UI.err(err.message);
          btn.disabled = false;
          btn.textContent = '🔔 Ring TV';
        }
      });
    });
  }

  function card(r) {
    const tags = [];
    if (r.is_new_patient) tags.push(UI.badge('New patient', 'crimson'));
    if (r.screening_due) tags.push(UI.badge('Screening due', 'orange'));
    if (r.allergies) tags.push(UI.badge('⚠ Allergy', 'danger'));
    if (r.labs_open) tags.push(UI.badge(`${r.labs_open} lab`, 'warn'));
    if (r.rx_pending) tags.push(UI.badge(`${r.rx_pending} Rx`, 'warn'));
    if (r.invoice_balance > 0) tags.push(UI.badge(UI.money(r.invoice_balance) + ' due', 'danger'));  // null unless the desk collects
    if (r.screening_status && r.screening_status !== 'completed') tags.push(UI.badge(UI.titleise(r.screening_status), 'orange'));

    const search = `${r.patient_name} ${r.uhid} ${r.token_no || ''} ${r.doctor_name || ''}`.toLowerCase();
    return `<div class="qcard" data-visit="${r.id}" data-search="${UI.esc(search)}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span class="token">#${UI.esc(r.token_no || '—')}</span>
        ${r.status !== 'checked_out' ? `<button class="btn xs ghost ring-btn" data-ring="${r.id}" title="Ring / Announce Token on TV Kiosk" style="padding:2px 6px;font-size:11px;">🔔 Ring TV</button>` : ''}
      </div>
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

        /*
         * The slip goes to the printer straight away, because the patient is
         * standing at the desk now and the number means nothing to them
         * until it is in their hand. Where the department has no category
         * yet, the reply says so and the desk is told rather than left
         * wondering why nothing printed.
         */
        if (res.queueToken) {
          UI.ok(`${patient.first_name} added to the queue — token ${res.queueToken.label}`
            + `${res.queueToken.room_name ? ` · ${res.queueToken.room_floor}, ${res.queueToken.room_name}` : ''}.`);
          try { await TokenSlip.printToken(res.queueToken.id); }
          catch (err) { UI.warn(`Token ${res.queueToken.label} issued, but the slip did not print.`); }
        } else {
          UI.ok(`${patient.first_name} added to the queue — token #${res.visit.token_no}.`);
          if (res.queueNote) UI.warn(res.queueNote);
        }

        if (res.flags && res.flags.mayNeedFinancialHelp) {
          // A note, not a diversion — they carry on to the counter either way.
          UI.warn('Uninsured or changed circumstances — worth offering financial assistance.');
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
            ${visit.queueToken
              ? `<span class="badge crimson">${UI.esc(visit.queueToken.label)}</span>
                 ${visit.queueToken.room_name
                   ? `<span class="badge teal">${UI.esc(visit.queueToken.room_floor)} · ${UI.esc(visit.queueToken.room_name)}</span>`
                   : ''}`
              : `<span class="badge crimson">Token #${UI.esc(visit.token_no || '—')}</span>`}
            ${UI.statusBadge(visit.status)}
            ${visit.is_new_patient ? UI.badge('New patient', 'crimson') : ''}
            ${visit.screening_due ? UI.badge('Yearly screening due', 'orange') : ''}
          </div>
          <div class="row-gap">
            ${APP.can(['reception', 'nurse', 'doctor', 'lab', 'pharmacy'])
              ? '<button class="btn ghost sm" data-act="slip">Print token slip</button>' : ''}
            <a class="btn ghost sm" href="#/patients?id=${visit.patient_id}" onclick="UI.closeAllModals()">Open patient record</a>
          </div>
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
        /*
         * Reprinting the slip: a patient who has lost theirs, or a second
         * copy for a relative gone to fetch the car. It is the same token,
         * never a new one — issuing a second number would put the same
         * person in the queue twice.
         */
        if (act === 'slip') {
          TokenSlip.printForVisit(visit.id).catch((err) => UI.err(err.message));
          return 'keep';
        }
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
    const go = (route, params) => () => { UI.closeAllModals(); APP.navigate(route, params); };

    if (['waiting_room', 'financial_screening'].includes(visit.status) && APP.can(['reception'])) {
      out.push({ id: 'ci', label: 'Check in', kind: 'teal', run: () => checkIn(visit) });
    }
    /*
     * The counter between the front desk and the nurse. The fee is offered
     * only while it is actually owed, and the nurse is not offered a patient
     * who has not been through it — the server refuses that anyway, and a
     * button that leads to a refusal is worse than no button.
     */
    if (visit.status === 'checked_in' && !visit.consultation_paid && APP.can(['cashier'])) {
      out.push({ id: 'cf', label: 'Collect consultation fee', kind: 'teal', run: () => collectFee(visit) });
    }
    if (visit.status === 'checked_in' && visit.consultation_paid && APP.can(['nurse', 'doctor'])) {
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

  /**
   * Take the consultation fee.
   *
   * Deliberately short: the amount is the rate card's and the mode is the only
   * question, because the queue at a clinic counter is not the place for a
   * form. The receipt prints straight away — the patient carries it to the
   * nurse, and it is what the next desk goes on.
   */
  function collectFee(visit) {
    UI.modal({
      title: 'Consultation fee — ' + visit.patient_name,
      size: 'narrow',
      body: `<div class="alert info">The fee is taken before the nurse station. It goes on this visit's
          bill at the rate on the card, and the patient goes on to vitals.</div>
        <form id="cf-form">
          ${UI.field({ name: 'mode', label: 'Mode', required: true,
            options: ['cash', 'upi', 'card', 'netbanking'].map((m) => ({ value: m, label: UI.titleise(m) })) })}
          ${UI.field({ name: 'reference', label: 'Reference / transaction ID' })}
        </form>
        <div id="cf-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn" data-act="take">Collect &amp; send to the nurse</button>`,
      async onAction(act, modal) {
        if (act !== 'take') return;
        try {
          const res = await API.post(`/api/visits/${visit.id}/consultation-fee`,
            UI.formValues(modal.querySelector('#cf-form')));
          UI.ok(`${UI.money(res.fee)} collected — receipt ${res.receiptNo}. Send them to the nurse.`);
          if (APP.printReceipt) APP.printReceipt(res.receiptNo);
          UI.closeAllModals();
          APP.reload();
        } catch (err) {
          modal.querySelector('#cf-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  async function checkIn(visit) {
    UI.modal({
      title: 'Check in — ' + visit.patient_name,
      size: 'narrow',
      body: `<div class="alert info">Confirm the reason for the visit. The patient then goes to the cashier for the consultation fee, and on to the nurse station.</div>
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
        UI.ok('Checked in — the patient can move to the nurse station.');
        UI.closeAllModals();
        APP.reload();
      },
    });
  }

  /** "Provider Gives Results Page to Patient" — the printable carry sheet. */
  async function printResultsPage(visitId) {
    UI.closeAllModals();
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
        <table><thead><tr><th>Order</th><th>Tests</th><th>Status</th>${
          APP.seesPrices() ? '<th class="num">Amount</th>' : ''}</tr></thead><tbody>
        ${p.labOrders.map((o) => `<tr><td>${UI.esc(o.order_no)}</td><td>${UI.esc(o.tests || '')}</td>
          <td>${UI.esc(UI.titleise(o.status))}</td>${
            APP.seesPrices() ? `<td class="num">${UI.money(o.total_price)}</td>` : ''}</tr>`).join('')}
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


  // =======================================================================
  // "Now calling" — the queue itself
  // =======================================================================

  /**
   * One lane per category that has anybody in it today.
   *
   * The lane is read top to bottom the way the room works: who is in with
   * the doctor, who has been called and is walking over, then the line in
   * the order it will be called. Each waiting row says why it is where it
   * is — "Booked 10:15", "Walk-in · waiting since 09:50" — because a
   * receptionist who cannot see the reason overrides the queue, and an
   * overridden queue is no queue at all.
   */
  async function drawQueue(host, date) {
    const board = await API.get('/api/queue/board' + API.qs({ date }));
    APP.setSubtitle(`${UI.num(board.totals.issued)} token(s) today · `
      + `${UI.num(board.totals.waiting)} waiting · ${UI.num(board.totals.done)} seen`);

    if (!board.lanes.length) {
      host.innerHTML = UI.empty(
        'No tokens issued today. Record an arrival, or press "Issue a token" for somebody '
        + 'walking up to a counter.', '🎫');
      return;
    }

    host.innerHTML = `<div class="q-lanes">${board.lanes.map(lane).join('')}</div>`;
    wireQueue(host, date);
  }

  function lane(l) {
    const calling = l.called.concat(l.serving);
    return `<section class="q-lane" data-category="${l.category.id}">
      <header>
        <div>
          <span class="q-code">${UI.esc(l.category.code)}</span>
          <b>${UI.esc(l.category.name)}</b>
          ${l.category.kind === 'service' ? UI.badge('Counter', 'teal') : ''}
        </div>
        <div class="muted small">${UI.num(l.counts.waiting)} waiting${l.averageMinutes
          ? ` · about ${UI.num(l.averageMinutes)} min each` : ''}</div>
      </header>

      <div class="q-now">
        ${calling.length ? calling.map(nowRow).join('')
          : '<div class="muted small">Nobody in the room.</div>'}
      </div>

      ${l.next ? `<div class="q-next">
        <div><span class="muted small">Next</span> <b>${UI.esc(l.next.label)}</b>
          <span class="muted small">${UI.esc(l.next.why)}</span></div>
        ${APP.can(['reception', 'nurse', 'doctor']) ? `<button class="btn sm teal"
          data-callnext="${l.category.id}">Call next</button>` : ''}
      </div>` : (l.counts.waiting ? `<div class="q-next">
        <div class="muted small">Nobody is due yet — the next booking has not come round.</div>
      </div>` : '')}

      <div class="q-line">${l.queue.map(waitingRow).join('')
        || '<div class="muted small" style="padding:6px 0">The line is empty.</div>'}</div>
    </section>`;
  }

  function nowRow(t) {
    const label = `<b class="q-label">${UI.esc(t.label)}</b>`;
    const who = t.patient_name
      ? `${UI.esc(t.patient_name)}<span class="muted small"> · ${UI.esc(t.uhid || '')}</span>`
      : '<span class="muted small">No patient attached</span>';
    return `<div class="q-row ${t.status}" data-token="${t.id}">
      <div>${label} ${t.status === 'serving' ? UI.badge('In the room', 'teal')
        : UI.badge(`Called${t.call_count > 1 ? ` ×${t.call_count}` : ''}`, 'orange')}</div>
      <div class="q-who">${who}${t.room_name
        ? `<span class="muted small"> · ${UI.esc(t.room_floor || '')} ${UI.esc(t.room_name)}</span>` : ''}</div>
      <div class="q-acts">
        ${APP.can(['reception', 'nurse', 'doctor']) ? `
          ${t.status === 'called' ? `<button class="btn sm ghost" data-act="serving" data-id="${t.id}">Came in</button>
            <button class="btn sm ghost" data-act="recall" data-id="${t.id}">Call again</button>
            <button class="btn sm ghost" data-act="pass" data-id="${t.id}">No answer</button>` : ''}
          <button class="btn sm" data-act="done" data-id="${t.id}">Done</button>` : ''}
      </div>
    </div>`;
  }

  function waitingRow(t) {
    return `<div class="q-row waiting" data-token="${t.id}">
      <div><span class="q-pos">${UI.num(t.position)}</span> <b class="q-label">${UI.esc(t.label)}</b>
        ${t.booked ? UI.badge('Booked', 'teal') : UI.badge('Walk-in', '')}
        ${t.call_count ? UI.badge('Called before', 'warn') : ''}</div>
      <div class="q-who">${t.patient_name
        ? `${UI.esc(t.patient_name)}<span class="muted small"> · ${UI.esc(t.uhid || '')}</span>`
        : '<span class="muted small">No patient attached</span>'}
        <span class="muted small"> · ${UI.esc(t.why)}${t.room_name
          ? ` · ${UI.esc(t.room_name)}` : ''}</span></div>
      <div class="q-acts">
        ${APP.can(['reception', 'nurse', 'doctor'])
          ? `<button class="btn sm ${t.callable ? 'teal' : 'ghost'}" data-act="call" data-id="${t.id}">Call</button>` : ''}
        <button class="btn sm ghost" data-act="slip" data-id="${t.id}">Slip</button>
        ${t.visit_id ? `<button class="btn sm ghost" data-act="visit" data-id="${t.visit_id}">Visit</button>` : ''}
      </div>
    </div>`;
  }

  function wireQueue(host, date) {
    host.querySelectorAll('[data-callnext]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const out = await API.post('/api/queue/call-next', { categoryId: Number(b.dataset.callnext) });
        UI.ok(`Calling ${out.token.label}.`);
        drawQueue(host, date);
      } catch (err) { UI.err(err.message); b.disabled = false; }
    }));

    host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      try {
        if (b.dataset.act === 'slip') return void await TokenSlip.printToken(id);
        if (b.dataset.act === 'visit') return void openVisit(id);
        if (b.dataset.act === 'pass') return void askPass(id, host, date);
        b.disabled = true;
        if (b.dataset.act === 'call' || b.dataset.act === 'recall') {
          const out = await API.post(`/api/queue/tokens/${id}/call`, {});
          UI.ok(`Calling ${out.token.label}.`);
          /*
           * Taken out of turn: said once, plainly, and not refused. The desk
           * can see the eight-month pregnant woman standing up; the software
           * cannot.
           */
          if (out.outOfTurn && out.expected) {
            UI.warn(`Out of turn — ${out.expected.label} was next (${out.expected.why}).`);
          }
        } else {
          await API.post(`/api/queue/tokens/${id}/${b.dataset.act}`, {});
        }
        drawQueue(host, date);
      } catch (err) { UI.err(err.message); b.disabled = false; }
    }));
  }

  /** Nobody answered. The reason is offered, not demanded. */
  function askPass(tokenId, host, date) {
    UI.modal({
      title: 'Nobody answered',
      size: 'narrow',
      body: `<div class="alert info">They stay in the queue. Their place is counted from now,
          so the people behind them are not overtaken twice when they come back.</div>
        <form id="qp-form">${UI.field({ name: 'reason', label: 'Note (optional)',
          placeholder: 'Did not answer · stepped out · at the pharmacy' })}</form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="go">Put them back in the queue</button>`,
      async onAction(act, modal) {
        if (act !== 'go') return;
        await API.post(`/api/queue/tokens/${tokenId}/pass`,
          UI.formValues(modal.querySelector('#qp-form')));
        UI.closeModal();
        drawQueue(host, date);
      },
    });
  }

  // =======================================================================
  // Issuing a token at a counter
  // =======================================================================

  /**
   * The button for somebody who walks up to a counter.
   *
   * A patient is optional on purpose. The laboratory queue moves faster
   * than anybody can type a name into it, and a token with no name is still
   * a fair place in a line — which is the whole job. Where a name is
   * attached, pressing the button twice returns the same token rather than
   * issuing a second one and leaving a gap in the queue.
   */
  async function openIssueToken(preset) {
    const cats = (await API.get('/api/queue/categories')).rows;
    const consult = cats.filter((c) => c.kind === 'consult');
    const service = cats.filter((c) => c.kind === 'service');
    const opt = (c) => `<option value="${c.id}">${UI.esc(c.code)} · ${UI.esc(c.name)}</option>`;

    UI.modal({
      title: 'Issue a token',
      size: '',
      body: `
        <form id="qi-form">
          <label>Queue
            <select name="categoryId" required>
              <option value="">— choose —</option>
              <optgroup label="Consultations">${consult.map(opt).join('')}</optgroup>
              <optgroup label="Counters &amp; services">${service.map(opt).join('')}</optgroup>
            </select>
          </label>
          ${UI.field({ name: 'note', label: 'Note (optional)', placeholder: 'e.g. fasting sample' })}
        </form>
        <fieldset class="mt"><legend>Patient (optional)</legend>
          <div class="search-row"><input type="search" id="qi-q" placeholder="Name, UHID or phone…"></div>
          <div id="qi-pick" class="muted small">No patient attached — the token is just a place in the line.</div>
          <div id="qi-results"></div>
        </fieldset>
        <div id="qi-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="issue">Issue &amp; print</button>`,
      onMount(modal) {
        if (preset && preset.categoryId) modal.querySelector('[name=categoryId]').value = preset.categoryId;
        modal.dataset.patient = (preset && preset.patientId) || '';
        const input = modal.querySelector('#qi-q');
        let t;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = input.value.trim();
            const out = modal.querySelector('#qi-results');
            if (q.length < 2) return void (out.innerHTML = '');
            const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
            out.innerHTML = res.rows.length ? res.rows.map((p) =>
              `<button type="button" class="btn sm ghost mt" data-p="${p.id}">
                 ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)}</button>`).join(' ')
              : '<div class="muted small mt">No patient matched.</div>';
            out.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
              modal.dataset.patient = b.dataset.p;
              modal.querySelector('#qi-pick').innerHTML = `<b>${b.textContent.trim()}</b>`;
              out.innerHTML = '';
              input.value = '';
            }));
          }, 220);
        });
      },
      async onAction(act, modal) {
        if (act !== 'issue') return;
        const form = modal.querySelector('#qi-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        try {
          const token = await API.post('/api/queue/tokens', {
            ...values, patientId: modal.dataset.patient || null,
          });
          UI.closeModal();
          UI.ok(`Token ${token.label}${token.room_name
            ? ` — ${token.room_floor}, ${token.room_name}` : ''}.`);
          await TokenSlip.printToken(token.id);
          APP.reload();
        } catch (err) {
          modal.querySelector('#qi-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  // =======================================================================
  // Set-up: the rooms, and the category codes
  // =======================================================================

  /**
   * What the clinic enters once.
   *
   * Two things, and the order matters: the category codes, which are what
   * gets printed on a token, and the rooms, which are where the token sends
   * people. Everything the patient is told afterwards is read back from
   * here, so the slip in their hand and the screen on the wall cannot
   * disagree about which floor Paediatrics is on.
   */
  async function drawSetup(host) {
    const [setup, depts] = await Promise.all([
      API.get('/api/queue/setup'),
      API.get('/api/masters/departments'),
    ]);
    const doctors = isManagement() ? await API.get('/api/masters/staff?role=doctor') : [];
    const cats = setup.categories;
    const rooms = setup.rooms.filter((r) => r.active);

    host.innerHTML = `
      <div class="alert info">A token is the category code and a number that starts again each
        morning — <b>08-001</b> is the day's first Paediatrics patient. The room against each
        specialty is what goes on the slip and on the waiting-room screen.</div>

      <h3>Who sits in which OP</h3>
      <div class="muted small mb">Change a room here whenever a doctor is away and their clinic
        moves. Anybody already waiting in that queue is sent to the new room with it —
        the ERP says how many, so the desk can call it out.</div>
      <div id="q-alloc"></div>

      ${isManagement() ? `
        <h3 class="mt">Consulting rooms</h3>
        <div class="q-rooms">${setup.rooms.map((r) => roomCard(r, cats, doctors)).join('')}</div>
        <button class="btn ghost mt" id="q-add-room">+ Add a room</button>

        <h3 class="mt">Category codes</h3>
        <div id="q-cats"></div>` : ''}`;

    drawAllocation(host, cats, rooms);
    loadDuty(host);
    if (!isManagement()) return;

    host.querySelector('#q-cats').innerHTML = UI.table([
      { label: 'Code', render: (c) => `<span class="q-code">${UI.esc(c.code)}</span>` },
      { label: 'Queue', key: 'name' },
      { label: 'Kind', render: (c) => (c.kind === 'service' ? 'Counter' : 'Consultation') },
      { label: 'Fed by', render: (c) => (c.departments
        ? UI.esc(c.departments)
        : '<span class="muted">no department points here yet</span>') },
      { label: 'Example', render: (c) => `${UI.esc(c.code)}-001` },
      { label: '', render: (c) => `${c.active ? '' : UI.badge('Off', 'warn')}
        <button class="btn sm ghost" data-cat="${c.id}">Edit</button>` },
    ], cats);

    host.querySelector('#q-add-room').addEventListener('click', () => editRoom(null, cats));
    host.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () =>
      editCategory(cats.find((c) => c.id === Number(b.dataset.cat)), depts)));
    host.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () =>
      editRoom(setup.rooms.find((r) => r.id === Number(b.dataset.room)), cats)));
    host.querySelectorAll('[data-room-doc]').forEach((sel) => sel.addEventListener('change', async () => {
      await API.post(`/api/queue/rooms/${sel.dataset.roomDoc}/doctors`,
        { doctorId: Number(sel.value) });
      UI.ok('Saved.');
      drawSetup(host);
    }));
  }

  /**
   * The allocation, as one line per specialty.
   *
   * Deliberately a table of dropdowns rather than four room cards with tick
   * boxes: the question being asked here is "where does Cardiology sit
   * today", and that is answered one specialty at a time. Swapping two
   * clinics is two changes on this screen, which is also how it happens in
   * the building.
   */
  function drawAllocation(host, cats, rooms) {
    const consult = cats.filter((c) => c.kind === 'consult' && c.active);
    const counters = cats.filter((c) => c.kind === 'service' && c.active);
    const where = {};
    for (const r of rooms) for (const c of r.categories) where[c.id] = r.id;

    host.querySelector('#q-alloc').innerHTML = `
      <div class="table-wrap"><table class="q-alloc">
        <thead><tr><th>Code</th><th>Specialty</th><th>Room</th>
          <th>Doctor on duty today</th><th>Token</th></tr></thead>
        <tbody>${consult.map((c) => `<tr>
          <td><span class="q-code">${UI.esc(c.code)}</span></td>
          <td>${UI.esc(c.name)}</td>
          <td><select data-alloc="${c.id}">
            <option value="">— not allocated —</option>
            ${rooms.map((r) => `<option value="${r.id}" ${where[c.id] === r.id ? 'selected' : ''}>
              ${UI.esc(r.name)} · ${UI.esc(r.floor)}</option>`).join('')}
          </select></td>
          <td class="q-duty" data-duty="${c.id}"><span class="muted small">…</span></td>
          <td class="muted">${UI.esc(c.code)}-001</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${counters.length ? `<div class="muted small mt">Counters are not consulting rooms, so they
        carry a floor instead: ${counters.map((c) => `${UI.esc(c.name)}${c.location
          ? ` — ${UI.esc(c.location)}` : ' — <i>no floor set</i>'}`).join(' · ')}</div>` : ''}`;

    host.querySelectorAll('[data-alloc]').forEach((sel) => {
      sel.dataset.was = sel.value;
      sel.addEventListener('change', () => moveSpecialty(host, sel, cats, rooms));
    });
  }

  /**
   * Who is actually sitting today, read from the hours on the staff screen.
   *
   * The whole point of putting it on this line: the room is only half the
   * answer to "where do I send this patient". A room with nobody's hours
   * against it today is a door the desk should not be sending anybody to,
   * and the only way to know is to join the two.
   */
  async function loadDuty(host) {
    let rows;
    try { rows = (await API.get('/api/queue/duty')).rows; } catch { return; }
    for (const row of rows) {
      const cell = host.querySelector(`[data-duty="${row.category.id}"]`);
      if (!cell) continue;

      if (!row.doctors.length) {
        cell.innerHTML = '<span class="muted small">Nobody is sitting today</span>';
        continue;
      }
      const one = (d) => `<div>${d.sittingNow ? '<b>' : ''}${UI.esc(d.name)}${d.sittingNow ? '</b>' : ''}
        <span class="muted small">${UI.esc(d.hours || '')}</span>
        ${d.sittingNow ? UI.badge('In now', 'teal') : ''}</div>`;
      cell.innerHTML = row.doctors.map(one).join('')
        + (row.elsewhere.length
          ? `<div class="small warn-text">⚠ ${row.elsewhere.map((e) =>
            `${UI.esc(e.name)} is set to sit in ${UI.esc(e.room)}`).join(', ')} — their patients
            are sent there, not to ${UI.esc(row.room ? row.room.name : 'this room')}.</div>`
          : '');
    }
  }

  async function moveSpecialty(host, sel, cats, rooms) {
    const cat = cats.find((c) => c.id === Number(sel.dataset.alloc));
    const roomId = sel.value ? Number(sel.value) : null;
    const room = rooms.find((r) => r.id === roomId);

    /*
     * How many people this will move, asked before it is done. Their slips
     * say the old room and they are sitting in front of the old door, so
     * this is a thing somebody has to announce — not a silent change.
     */
    let waiting = 0;
    try {
      waiting = (await API.get('/api/queue/queues' + API.qs({ categoryId: cat.id })))
        .counts.waiting;
    } catch { waiting = 0; }

    const go = async () => {
      try {
        const out = await API.post(`/api/queue/categories/${cat.id}/room`, { roomId });
        UI.ok(`${cat.name} ${room ? `now sits in ${room.name}, ${room.floor}` : 'has no room'}`
          + `${out.moved ? ` — ${out.moved} patient(s) waiting have been moved with it.` : '.'}`);
        drawSetup(host);
      } catch (err) {
        UI.err(err.message);
        sel.value = sel.dataset.was;
      }
    };

    if (!waiting) return go();
    UI.modal({
      title: `Move ${cat.name}?`,
      size: 'narrow',
      body: `<div class="alert warn"><b>${UI.num(waiting)} patient(s)</b> are waiting in this
          queue. Their slips say the room they were given at the desk, so somebody should call
          the change out in the waiting room.</div>
        <div class="small">${UI.esc(cat.name)} will be called to
          <b>${room ? `${UI.esc(room.name)}, ${UI.esc(room.floor)}` : 'no room'}</b> from now on.
          Anybody already called in, or with a doctor, stays where they are.</div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="go">Move the clinic and the queue</button>`,
      async onAction(act) {
        if (act !== 'go') { sel.value = sel.dataset.was; return; }
        UI.closeModal();
        await go();
      },
    });
  }

  function roomCard(r, cats, doctors) {
    const free = doctors.filter((d) => !d.op_room_id || d.op_room_id === r.id);
    return `<div class="q-room ${r.active ? '' : 'off'}">
      <header>
        <div><b>${UI.esc(r.floor)}</b> · ${UI.esc(r.name)} ${r.active ? '' : UI.badge('Off', 'warn')}</div>
        <button class="btn sm ghost" data-room="${r.id}">Edit</button>
      </header>
      <div class="small">${r.categories.length
        ? r.categories.map((c) => `<span class="q-chip">${UI.esc(c.code)} ${UI.esc(c.name)}</span>`).join(' ')
        : '<span class="muted">No specialty set — tokens for this room have nowhere to send people.</span>'}</div>
      <div class="mt small">${r.doctors.length
        ? `Sitting here: ${r.doctors.map((d) => UI.esc(d.name)).join(', ')}`
        : '<span class="muted">No doctor fixed to this room.</span>'}</div>
      <label class="mt small">Add a doctor
        <select data-room-doc="${r.id}">
          <option value="">— choose —</option>
          ${free.filter((d) => d.op_room_id !== r.id).map((d) =>
            `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('')}
        </select>
      </label>
    </div>`;
  }

  function editRoom(room, cats) {
    const chosen = new Set((room ? room.categories : []).map((c) => c.id));
    UI.modal({
      title: room ? `${room.floor} · ${room.name}` : 'Add a consulting room',
      size: '',
      body: `
        <form id="qr-form">
          <div class="grid c2">
            ${UI.field({ name: 'floor', label: 'Floor', required: true,
              value: room ? room.floor : '', placeholder: 'Ground Floor' })}
            ${UI.field({ name: 'name', label: 'Room', required: true,
              value: room ? room.name : '', placeholder: 'OP 1' })}
          </div>
          ${UI.field({ name: 'floorOrder', label: 'Floor order (1 = ground)', type: 'number',
            value: room ? room.floor_order : 1 })}
          ${UI.field({ name: 'note', label: 'Note', value: room ? (room.note || '') : '' })}
        </form>
        <fieldset><legend>Specialties that sit in this room</legend>
          <div class="muted small mb">Tick as many as use the room — four or more is normal.</div>
          <div class="q-pick">${cats.filter((c) => c.kind === 'consult').map((c) =>
            `<label class="q-tick"><input type="checkbox" value="${c.id}"
              ${chosen.has(c.id) ? 'checked' : ''}> ${UI.esc(c.code)} ${UI.esc(c.name)}</label>`).join('')}</div>
        </fieldset>
        ${room ? `<label class="mt"><input type="checkbox" id="qr-active"
          ${room.active ? 'checked' : ''}> In use</label>` : ''}
        <div id="qr-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        ${room ? '<button class="btn ghost" data-act="remove">Remove</button>' : ''}
        <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act === 'remove') {
          const out = await API.del(`/api/queue/rooms/${room.id}`);
          UI.ok(out.deactivated
            ? `${room.name} switched off — ${UI.num(out.tokens)} token(s) still point at it.`
            : `${room.name} removed.`);
          UI.closeModal();
          return void APP.reload();
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#qr-form');
        if (!form.reportValidity()) return 'keep';
        const body = {
          ...UI.formValues(form),
          categories: [...modal.querySelectorAll('.q-pick input:checked')].map((i) => Number(i.value)),
        };
        if (room) body.active = modal.querySelector('#qr-active').checked;
        try {
          if (room) await API.patch(`/api/queue/rooms/${room.id}`, body);
          else await API.post('/api/queue/rooms', body);
          UI.ok('Saved.');
          UI.closeModal();
          APP.reload();
        } catch (err) {
          modal.querySelector('#qr-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  function editCategory(cat, depts) {
    const mine = new Set(depts.filter((d) => d.queue_category_id === cat.id).map((d) => d.id));
    UI.modal({
      title: `${cat.code} · ${cat.name}`,
      size: '',
      body: `
        <form id="qc-form">
          <div class="grid c2">
            ${UI.field({ name: 'code', label: 'Code (two digits)', required: true, value: cat.code })}
            ${UI.field({ name: 'name', label: 'Queue name', required: true, value: cat.name })}
          </div>
          <div class="muted small">Tokens will read <b id="qc-eg">${UI.esc(cat.code)}-001</b>,
            ${UI.esc(cat.code)}-002, and so on, starting again each morning.</div>
          ${cat.kind === 'service' ? UI.field({ name: 'location', label: 'Where it is',
            value: cat.location || '', placeholder: 'Ground Floor',
            hint: 'A counter has no consulting room, so this is what the waiting-room screen '
              + 'and the token slip tell the patient.' }) : ''}
        </form>
        <fieldset class="mt"><legend>Departments that feed this queue</legend>
          <div class="muted small mb">A patient arriving under one of these is given a token in this
            queue automatically. General and Internal Medicine share one code, which is why this is a
            list rather than a single choice.</div>
          <div class="q-pick">${depts.map((d) =>
            `<label class="q-tick"><input type="checkbox" value="${d.id}" ${mine.has(d.id) ? 'checked' : ''}
              ${d.queue_category_id && d.queue_category_id !== cat.id
                ? `disabled title="Already on ${UI.esc(String(d.queue_category_code || 'another code'))}"` : ''}>
              ${UI.esc(d.name)}</label>`).join('')}</div>
        </fieldset>
        <label class="mt"><input type="checkbox" id="qc-active" ${cat.active ? 'checked' : ''}> In use</label>
        <div id="qc-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      onMount(modal) {
        const code = modal.querySelector('[name=code]');
        code.addEventListener('input', () => {
          modal.querySelector('#qc-eg').textContent = `${code.value}-001`;
        });
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#qc-form');
        if (!form.reportValidity()) return 'keep';
        try {
          await API.patch(`/api/queue/categories/${cat.id}`, {
            ...UI.formValues(form),
            active: modal.querySelector('#qc-active').checked,
            departments: [...modal.querySelectorAll('.q-pick input:checked')].map((i) => Number(i.value)),
          });
          UI.ok('Saved.');
          UI.closeModal();
          APP.reload();
        } catch (err) {
          modal.querySelector('#qc-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          return 'keep';
        }
      },
    });
  }

  APP.openIssueToken = openIssueToken;

  APP.openVisit = openVisit;
})();
