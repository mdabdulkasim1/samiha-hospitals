/* In-patient: ward occupancy, admission, rounds, medication chart, discharge. */
(function () {
  'use strict';

  APP.register('ipd', {
    title: 'Wards & In-patients',
    subtitle: 'Beds, rounds, medication and discharge',

    async render(el, params) {
      if (params.admissionId) return renderAdmission(el, Number(params.admissionId));

      APP.actions(APP.can(['ward', 'nurse', 'doctor', 'reception'])
        ? [{ id: 'admit', label: '+ Admit patient', kind: '', onClick: openAdmit }] : []);

      const [wards, admissions] = await Promise.all([
        API.get('/api/ipd/wards'),
        API.get('/api/ipd/admissions?status=admitted'),
      ]);

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat teal"><div class="label">Total beds</div><div class="value">${UI.num(wards.summary.total)}</div></div>
          <div class="stat crimson"><div class="label">Occupied</div><div class="value">${UI.num(wards.summary.occupied)}</div>
            <div class="foot">${wards.summary.occupancyPct}% occupancy</div></div>
          <div class="stat ok"><div class="label">Vacant</div><div class="value">${UI.num(wards.summary.vacant)}</div></div>
          <div class="stat orange"><div class="label">In-patients</div><div class="value">${UI.num(admissions.length)}</div>
            <div class="foot">Currently admitted</div></div>
        </div>

        <div class="tabs" id="i-tabs">
          <button class="active" data-tab="beds">Bed board</button>
          <button data-tab="patients">In-patients</button>
        </div>
        <div id="i-body"></div>`;

      const body = el.querySelector('#i-body');
      const tabs = {
        beds() {
          body.innerHTML = wards.wards.map((w) => `<div class="card">
            <div class="card-head"><h3>${UI.esc(w.name)}</h3>
              ${UI.badge(UI.titleise(w.kind), 'teal')}
              <span class="muted small">${w.occupied}/${w.total} occupied${w.floor ? ' · ' + UI.esc(w.floor) + ' floor' : ''}</span></div>
            <div class="card-body"><div class="bed-grid">
              ${w.beds.map((b) => `<div class="bed ${b.status}" data-bed="${b.id}" data-admission="${b.admission_id || ''}">
                <b>${UI.esc(b.bed_no)}</b>
                <div>${UI.esc(UI.titleise(b.status))}</div>
                ${b.patient_name ? `<div class="who">${UI.esc(b.patient_name)}<br>${UI.esc(b.ip_no || '')}</div>` : ''}
                <div class="muted small">${UI.money(b.tariff_per_day)}/day</div>
              </div>`).join('')}
            </div></div></div>`).join('');

          body.querySelectorAll('[data-bed]').forEach((b) => b.addEventListener('click', () => {
            if (b.dataset.admission) APP.navigate('ipd', { admissionId: b.dataset.admission });
            else if (b.classList.contains('vacant')) openAdmit(Number(b.dataset.bed));
            else if (b.classList.contains('cleaning') && APP.can(['ward', 'nurse'])) releaseBed(Number(b.dataset.bed));
          }));
        },

        patients() {
          body.innerHTML = `<div class="card"><div class="card-body tight" id="a-list"></div></div>`;
          const host = body.querySelector('#a-list');
          host.innerHTML = UI.table([
            { label: 'IP No', render: (a) => `<code>${UI.esc(a.ip_no)}</code>` },
            { label: 'Patient', render: (a) => `<b>${UI.esc(a.patient_name)}</b><div class="muted small">${UI.esc(a.uhid)} · ${UI.esc(a.age_years || '—')}${UI.esc((a.gender || '').charAt(0).toUpperCase())}</div>` },
            { label: 'Ward / Bed', render: (a) => `${UI.esc(a.ward_name)} / ${UI.esc(a.bed_no)}` },
            { label: 'Consultant', render: (a) => UI.esc(a.doctor_name || '—') },
            { label: 'Admitted', render: (a) => UI.esc(UI.date(a.admitted_at)) },
            { label: 'Days', num: true, render: (a) => UI.esc(a.days) },
            { label: 'Flags', render: (a) => a.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
            { label: 'Balance', num: true, render: (a) => a.balance > 0
              ? `<b style="color:var(--danger)">${UI.money(a.balance)}</b>` : UI.money(0) },
          ], admissions, { emptyText: 'No patients currently admitted.' });
          UI.bindRows(host, admissions, (a) => APP.navigate('ipd', { admissionId: a.id }));
        },
      };
      el.querySelectorAll('#i-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#i-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab]();
      }));
      tabs.beds();
    },
  });

  async function releaseBed(bedId) {
    if (!(await UI.confirm('Mark this bed as cleaned and ready?'))) return;
    await API.patch(`/api/ipd/beds/${bedId}`, { status: 'vacant' });
    UI.ok('Bed released.');
    APP.reload();
  }

  // ---------------------------------------------------------------- admit
  async function openAdmit(bedId) {
    const [wards, doctors] = await Promise.all([
      API.get('/api/ipd/wards'), API.get('/api/masters/staff?role=doctor'),
    ]);
    const vacant = wards.wards.flatMap((w) => w.beds.filter((b) => b.status === 'vacant')
      .map((b) => ({ ...b, ward_name: w.name })));

    UI.modal({
      title: 'Admit a patient',
      body: `<div class="search-row"><input type="search" id="ad-q" placeholder="Search patient by name, UHID or phone…" autofocus></div>
        <div id="ad-res"></div><div id="ad-chosen"></div>
        <form id="ad-form">
          <div class="grid c2">
            ${UI.field({ name: 'bedId', label: 'Bed', required: true,
              value: typeof bedId === 'number' ? bedId : '',
              options: [{ value: '', label: '— select a vacant bed —' }].concat(vacant.map((b) =>
                ({ value: b.id, label: `${b.ward_name} · ${b.bed_no} — ${b.tariff_per_day}/day` }))) })}
            ${UI.field({ name: 'doctorId', label: 'Consultant', required: true,
              options: [{ value: '', label: '— select —' }].concat(doctors.map((d) =>
                ({ value: d.id, label: `${d.name} · ${d.department_name || ''}` }))) })}
          </div>
          ${UI.field({ name: 'admissionType', label: 'Admission type', value: 'planned',
            options: ['planned','emergency','daycare','maternity','observation'].map((t) => ({ value: t, label: UI.titleise(t) })) })}
          ${UI.field({ name: 'reason', label: 'Reason for admission', required: true })}
          ${UI.field({ name: 'provisionalDiagnosis', label: 'Provisional diagnosis' })}
          <div class="grid c2">
            ${UI.field({ name: 'attendantName', label: 'Attendant name' })}
            ${UI.field({ name: 'attendantPhone', label: 'Attendant phone' })}
          </div>
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Admit</button>`,
      onMount(modal) {
        let chosen = null;
        modal.__chosen = () => chosen;
        let t;
        modal.querySelector('#ad-q').addEventListener('input', (e) => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = e.target.value.trim();
            const host = modal.querySelector('#ad-res');
            if (q.length < 2) return void (host.innerHTML = '');
            const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
            host.innerHTML = res.rows.map((p) =>
              `<button type="button" class="btn ghost sm block mb" data-pid="${p.id}" style="justify-content:flex-start">
                ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)} · ${UI.esc(p.phone || '')}</button>`).join('')
              || '<div class="muted small">No match.</div>';
            host.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', () => {
              chosen = res.rows.find((p) => p.id === Number(b.dataset.pid));
              modal.__chosen = () => chosen;
              host.innerHTML = '';
              modal.querySelector('#ad-q').value = '';
              modal.querySelector('#ad-chosen').innerHTML =
                `<div class="alert ok"><b>${UI.esc(chosen.first_name)} ${UI.esc(chosen.last_name || '')}</b> · ${UI.esc(chosen.uhid)}
                 ${chosen.allergies ? ` · ⚠ ${UI.esc(chosen.allergies)}` : ''}</div>`;
            }));
          }, 220);
        });
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const chosen = modal.__chosen();
        if (!chosen) { UI.err('Select a patient first.'); return 'keep'; }
        const form = modal.querySelector('#ad-form');
        if (!form.reportValidity()) return 'keep';
        const a = await API.post('/api/ipd/admissions', { patientId: chosen.id, ...UI.formValues(form) });
        UI.ok(`Admitted — ${a.ip_no}.`);
        APP.navigate('ipd', { admissionId: a.id });
      },
    });
  }

  // ------------------------------------------------------------- admission
  async function renderAdmission(el, id) {
    const a = await API.get(`/api/ipd/admissions/${id}`);
    APP.setSubtitle(`${a.ip_no} · ${a.patient_name} · ${a.ward_name} / ${a.bed_no}`);
    APP.actions([
      { id: 'back', label: '← Wards', onClick: () => APP.navigate('ipd') },
      { id: 'summary', label: 'Discharge summary', onClick: () => printSummary(id) },
      ...(a.status === 'admitted' && APP.can(['doctor', 'ward', 'cashier'])
        ? [{ id: 'discharge', label: 'Discharge', kind: '', onClick: () => openDischarge(a) }] : []),
    ]);

    el.innerHTML = `
      ${a.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(a.allergies)}</div>` : ''}
      ${a.status !== 'admitted' ? `<div class="alert ok"><b>Discharged</b> ${UI.esc(UI.dateTime(a.discharged_at))} — ${UI.esc(UI.titleise(a.discharge_type || ''))}</div>` : ''}

      <div class="grid c4 mb">
        <div class="stat teal"><div class="label">IP number</div><div class="value" style="font-size:18px">${UI.esc(a.ip_no)}</div>
          <div class="foot">${UI.esc(UI.titleise(a.admission_type))}</div></div>
        <div class="stat crimson"><div class="label">Day</div><div class="value">${UI.num(a.days)}</div>
          <div class="foot">Since ${UI.esc(UI.date(a.admitted_at))}</div></div>
        <div class="stat orange"><div class="label">Bed</div><div class="value" style="font-size:18px">${UI.esc(a.bed_no)}</div>
          <div class="foot">${UI.esc(a.ward_name)} · ${UI.money(a.tariff_per_day)}/day</div></div>
        <div class="stat ${a.invoice && a.invoice.balance > 0 ? 'crimson' : 'ok'}"><div class="label">Bill so far</div>
          <div class="value">${a.invoice ? UI.money(a.invoice.net) : UI.money(0)}</div>
          <div class="foot">Balance ${a.invoice ? UI.money(a.invoice.balance) : UI.money(0)}</div></div>
      </div>

      <div class="tabs" id="ad-tabs">
        <button class="active" data-tab="overview">Overview</button>
        <button data-tab="notes">Rounds &amp; notes</button>
        <button data-tab="mar">Medication chart</button>
        <button data-tab="vitals">Vitals</button>
        <button data-tab="charges">Charges &amp; bill</button>
        <button data-tab="orders">Diagnostics</button>
        <button data-tab="insurance">Insurance</button>
      </div>
      <div id="ad-body"></div>`;

    const body = el.querySelector('#ad-body');
    const canWrite = a.status === 'admitted';

    const tabs = {
      overview() {
        body.innerHTML = `<div class="grid c2">
          <div class="card"><div class="card-head"><h3>Admission</h3></div><div class="card-body"><dl class="kv">
            <dt>Patient</dt><dd>${UI.esc(a.patient_name)} (${UI.esc(a.uhid)})</dd>
            <dt>Age / Sex</dt><dd>${UI.esc(a.age_years || '—')} / ${UI.esc(UI.titleise(a.gender || '—'))}</dd>
            <dt>Blood group</dt><dd>${UI.esc(a.blood_group || '—')}</dd>
            <dt>Consultant</dt><dd>${UI.esc(a.doctor_name || '—')}</dd>
            <dt>Admitted</dt><dd>${UI.esc(UI.dateTime(a.admitted_at))}</dd>
            <dt>Reason</dt><dd>${UI.esc(a.reason || '—')}</dd>
            <dt>Provisional Dx</dt><dd>${UI.esc(a.provisional_diagnosis || '—')}</dd>
            <dt>Attendant</dt><dd>${UI.esc(a.attendant_name || '—')} ${UI.esc(a.attendant_phone || '')}</dd>
          </dl>
          ${canWrite && APP.can(['ward','nurse','doctor']) ? '<button class="btn ghost mt" id="transfer">Transfer bed</button>' : ''}
          </div></div>
          <div class="card"><div class="card-head"><h3>Bed transfers</h3></div><div class="card-body">
            ${a.transfers.length ? a.transfers.map((t) => `<div class="small mb">
              ${UI.esc(t.from_bed || '—')} → <b>${UI.esc(t.to_bed)}</b>
              <div class="muted">${UI.esc(UI.dateTime(t.transferred_at))} · ${UI.esc(t.reason || '')}</div></div>`).join('')
              : '<div class="muted small">No transfers.</div>'}
          </div></div>
        </div>`;
        const tb = body.querySelector('#transfer');
        if (tb) tb.addEventListener('click', () => openTransfer(a));
      },

      notes() {
        body.innerHTML = `<div class="card">
          <div class="card-head"><h3>Progress notes</h3>
            ${canWrite && APP.can(['doctor','nurse','ward']) ? '<button class="btn ghost sm" id="add-note">+ Add note</button>' : ''}</div>
          <div class="card-body">${a.notes.length ? a.notes.map((n) => `<fieldset>
            <legend>${UI.esc(UI.titleise(n.note_type))} · ${UI.esc(UI.dateTime(n.created_at))}</legend>
            <div>${UI.esc(n.note)}</div>
            <div class="muted small mt">— ${UI.esc(n.by_name || '')}</div></fieldset>`).join('')
            : UI.empty('No progress notes yet.', '📝')}</div></div>`;
        const ab = body.querySelector('#add-note');
        if (ab) ab.addEventListener('click', () => openNote(a.id));
      },

      async mar() {
        body.innerHTML = `<div class="card">
          <div class="card-head"><h3>Medication administration record</h3>
            <input type="date" id="mar-date" value="${UI.today()}" style="max-width:170px">
            ${canWrite && APP.can(['doctor']) ? '<button class="btn ghost sm" id="add-med">+ Order medicine</button>' : ''}</div>
          <div class="card-body tight" id="mar-list">${UI.loading()}</div></div>
          <div class="card"><div class="card-head"><h3>Active medication orders</h3></div>
            <div class="card-body">${a.medicationOrders.length ? a.medicationOrders.map((m) =>
              `<div class="row-between mb"><span><b>${UI.esc(m.drug_name)}</b> ${UI.esc(m.dose || '')} ·
                ${UI.esc(m.frequency)} · ${UI.esc((m.route || '').toUpperCase())}
                <div class="muted small">${UI.esc(UI.date(m.start_date))} → ${m.end_date ? UI.esc(UI.date(m.end_date)) : 'ongoing'}
                  · ordered by ${UI.esc(m.ordered_by_name || '')}</div></span>
                ${UI.statusBadge(m.status)}</div>`).join('') : '<div class="muted small">No medication ordered.</div>'}
          </div></div>`;

        const loadMar = async () => {
          const date = body.querySelector('#mar-date').value;
          const rows = await API.get(`/api/ipd/admissions/${a.id}/mar` + API.qs({ date }));
          const host = body.querySelector('#mar-list');
          host.innerHTML = UI.table([
            { label: 'Due', render: (r) => `<b>${UI.esc(UI.time(r.due_at))}</b>` },
            { label: 'Medicine', render: (r) => `<b>${UI.esc(r.drug_name)}</b> ${UI.esc(r.dose || '')}` },
            { label: 'Route', render: (r) => UI.esc((r.route || '').toUpperCase()) },
            { label: 'Status', render: (r) => UI.statusBadge(r.status) },
            { label: 'Given by', render: (r) => r.by_name ? `${UI.esc(r.by_name)}<div class="muted small">${UI.esc(UI.time(r.administered_at))}</div>` : '—' },
            { label: '', render: (r) => r.status === 'due' && canWrite && APP.can(['nurse', 'ward'])
              ? `<div class="btn-row"><button class="btn sm" data-mar="${r.id}" data-st="given">Given</button>
                 <button class="btn ghost sm" data-mar="${r.id}" data-st="held">Held</button></div>` : '' },
          ], rows, { emptyText: 'Nothing scheduled for this day.' });
          host.querySelectorAll('[data-mar]').forEach((b) => b.addEventListener('click', async () => {
            await API.post(`/api/ipd/mar/${b.dataset.mar}`, { status: b.dataset.st });
            UI.ok(`Marked ${b.dataset.st}.`);
            loadMar();
          }));
        };
        body.querySelector('#mar-date').addEventListener('change', loadMar);
        const am = body.querySelector('#add-med');
        if (am) am.addEventListener('click', () => openMedOrder(a.id));
        await loadMar();
      },

      vitals() {
        body.innerHTML = `<div class="card">
          <div class="card-head"><h3>Vitals chart</h3>
            ${canWrite && APP.can(['nurse','ward','doctor']) ? '<button class="btn ghost sm" id="add-vitals">+ Record vitals</button>' : ''}</div>
          <div class="card-body tight">${UI.table([
            { label: 'When', render: (v) => UI.esc(UI.dateTime(v.recorded_at)) },
            { label: 'BP', render: (v) => `${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')}` },
            { label: 'Pulse', render: (v) => UI.esc(v.pulse || '—') },
            { label: 'Temp', render: (v) => UI.esc(v.temp_c || '—') },
            { label: 'SpO₂', render: (v) => UI.esc(v.spo2 || '—') },
            { label: 'RR', render: (v) => UI.esc(v.resp_rate || '—') },
            { label: 'Sugar', render: (v) => UI.esc(v.blood_sugar || '—') },
            { label: 'Notes', render: (v) => UI.esc(v.notes || '') },
          ], a.vitals, { emptyText: 'No vitals recorded.' })}</div></div>`;
        const av = body.querySelector('#add-vitals');
        if (av) av.addEventListener('click', () => openIpVitals(a.id));
      },

      charges() {
        body.innerHTML = `<div class="card">
          <div class="card-head"><h3>Charges</h3>
            ${canWrite && APP.can(['ward','nurse','cashier']) ? '<button class="btn ghost sm" id="add-charge">+ Add charge</button>' : ''}</div>
          <div class="card-body tight">${UI.table([
            { label: 'Date', render: (c) => UI.esc(UI.date(c.charge_date)) },
            { label: 'Description', key: 'description' },
            { label: 'Qty', num: true, render: (c) => UI.esc(c.qty) },
            { label: 'Rate', num: true, render: (c) => UI.money(c.unit_price) },
            { label: 'Amount', num: true, render: (c) => UI.money(c.amount) },
            { label: 'Billed', render: (c) => c.billed ? UI.badge('On invoice', 'ok') : UI.badge('Pending', 'warn') },
          ], a.charges, { emptyText: 'No additional charges.' })}</div>
          ${a.invoice ? `<div class="card-body">
            <div class="row-between"><span>Bed charges accrue at ${UI.money(a.tariff_per_day)}/day and are posted at discharge.</span>
            <button class="btn ghost sm" id="open-inv">Open invoice ${UI.esc(a.invoice.invoice_no)}</button></div></div>` : ''}
        </div>`;
        const ac = body.querySelector('#add-charge');
        if (ac) ac.addEventListener('click', () => openCharge(a.id));
        const oi = body.querySelector('#open-inv');
        if (oi) oi.addEventListener('click', () => APP.openInvoice(a.invoice.id));
      },

      async insurance() {
        body.innerHTML = UI.loading();
        const ins = await API.get(`/api/insurance/patient/${a.patient_id}`);
        const forThis = ins.preauths.filter((p) => p.admission_id === a.id);
        const covered = a.invoice ? a.invoice.insurance_covered : 0;
        body.innerHTML = `
          <div class="card">
            <div class="card-head"><h3>Cashless position</h3>
              ${canWrite && APP.can(['cashier', 'reception', 'counselor', 'ward'])
                ? '<button class="btn ghost sm" id="raise-pa">+ Pre-authorisation</button>' : ''}</div>
            <div class="card-body">
              ${ins.policies.length ? '' : '<div class="alert warn">No policy on file for this patient — the bill is entirely self-pay.</div>'}
              <div class="grid c3">
                <div class="stat teal"><div class="label">Bill so far</div>
                  <div class="value" style="font-size:20px">${a.invoice ? UI.money(a.invoice.gross) : UI.money(0)}</div></div>
                <div class="stat ok"><div class="label">Insurer carrying</div>
                  <div class="value" style="font-size:20px">${UI.money(covered)}</div>
                  <div class="foot">From approved pre-authorisation</div></div>
                <div class="stat crimson"><div class="label">Patient owes</div>
                  <div class="value" style="font-size:20px">${a.invoice ? UI.money(a.invoice.balance) : UI.money(0)}</div>
                  <div class="foot">Co-pay and non-admissible</div></div>
              </div>
            </div>
            <div class="card-body tight">${UI.table([
              { label: 'Ref', render: (p) => `<code>${UI.esc(p.preauth_no)}</code>` +
                (p.kind === 'enhancement' ? ' ' + UI.badge('Enhancement', 'orange') : '') },
              { label: 'Insurer', render: (p) => UI.esc(p.insurer_name) },
              { label: 'Requested', num: true, render: (p) => UI.money(p.requested_amount) },
              { label: 'Approved', num: true, render: (p) => UI.money(p.approved_amount) },
              { label: 'Co-pay', num: true, render: (p) => UI.money(p.copay_amount) },
              { label: 'Status', render: (p) => UI.statusBadge(p.status) },
            ], forThis, { emptyText: 'No pre-authorisation raised for this admission.' })}</div>
          </div>`;
        const tw = body.querySelector('.table-wrap');
        if (tw) UI.bindRows(tw, forThis, (p) => APP.openPreauth(p.id, () => tabs.insurance()));
        const raise = body.querySelector('#raise-pa');
        if (raise) raise.addEventListener('click', async () => {
          if (!ins.policies.length) return UI.err('Add a policy for this patient first.');
          const policies = await API.get(`/api/insurance/policies?patientId=${a.patient_id}`);
          APP.openPreauthForm(policies[0]);
        });
      },

      orders() {
        body.innerHTML = `<div class="card"><div class="card-head"><h3>Diagnostic orders</h3></div>
          <div class="card-body tight">${UI.table([
            { label: 'Order', key: 'order_no' },
            { label: 'Tests', render: (o) => UI.esc(o.tests || '') },
            { label: 'Ordered', render: (o) => UI.esc(UI.dateTime(o.ordered_at)) },
            { label: 'Status', render: (o) => UI.statusBadge(o.status) },
          ], a.labOrders, { emptyText: 'No diagnostics ordered for this admission.' })}</div></div>`;
      },
    };

    el.querySelectorAll('#ad-tabs button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('#ad-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      tabs[b.dataset.tab]();
    }));
    tabs.overview();
  }

  const simpleForm = (title, fields, submit) => UI.modal({
    title, body: `<form id="sf">${fields}</form>`,
    footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Save</button>`,
    async onAction(act, modal) {
      if (act !== 'save') return;
      const form = modal.querySelector('#sf');
      if (!form.reportValidity()) return 'keep';
      await submit(UI.formValues(form));
      APP.reload();
    },
  });

  const openNote = (id) => simpleForm('Add a progress note',
    UI.field({ name: 'noteType', label: 'Type', value: 'doctor_round',
      options: ['doctor_round','nursing','procedure','diet','physio','handover'].map((t) => ({ value: t, label: UI.titleise(t) })) }) +
    UI.field({ name: 'note', label: 'Note', type: 'textarea', rows: 4, required: true }),
    async (v) => { await API.post(`/api/ipd/admissions/${id}/notes`, v); UI.ok('Note added.'); });

  const openCharge = (id) => simpleForm('Add a charge',
    UI.field({ name: 'description', label: 'Description', required: true }) +
    `<div class="grid c2">${UI.field({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1 })}
     ${UI.field({ name: 'unitPrice', label: 'Rate', type: 'number', step: '0.01', required: true })}</div>`,
    async (v) => { await API.post(`/api/ipd/admissions/${id}/charges`, v); UI.ok('Charge added.'); });

  const openIpVitals = (id) => simpleForm('Record vitals',
    `<div class="grid c4">
      ${UI.field({ name: 'tempC', label: 'Temp (°C)', type: 'number', step: '0.1' })}
      ${UI.field({ name: 'pulse', label: 'Pulse', type: 'number' })}
      ${UI.field({ name: 'bpSystolic', label: 'BP sys', type: 'number' })}
      ${UI.field({ name: 'bpDiastolic', label: 'BP dia', type: 'number' })}
    </div><div class="grid c4">
      ${UI.field({ name: 'spo2', label: 'SpO₂ %', type: 'number' })}
      ${UI.field({ name: 'respRate', label: 'Resp rate', type: 'number' })}
      ${UI.field({ name: 'bloodSugar', label: 'Sugar', type: 'number', step: '0.1' })}
      ${UI.field({ name: 'painScore', label: 'Pain 0–10', type: 'number', min: 0, max: 10 })}
    </div>` + UI.field({ name: 'notes', label: 'Notes' }),
    async (v) => { await API.post(`/api/ipd/admissions/${id}/vitals`, v); UI.ok('Vitals recorded.'); });

  async function openMedOrder(id) {
    const drugs = await API.get('/api/pharmacy/drugs?limit=300');
    simpleForm('Order a medicine',
      UI.field({ name: 'drugId', label: 'Medicine',
        options: [{ value: '', label: '— free text —' }].concat(drugs.map((d) => ({ value: d.id, label: `${d.name} ${d.strength || ''}` }))) }) +
      UI.field({ name: 'drugName', label: 'Medicine name', required: true }) +
      `<div class="grid c3">
        ${UI.field({ name: 'dose', label: 'Dose', required: true })}
        ${UI.field({ name: 'frequency', label: 'Frequency', value: 'BD',
          options: ['OD','BD','TDS','QID','HS','SOS'].map((f) => ({ value: f, label: f })) })}
        ${UI.field({ name: 'route', label: 'Route', value: 'oral',
          options: ['oral','iv','im','sc','topical','inhalation'].map((r) => ({ value: r, label: r.toUpperCase() })) })}
      </div><div class="grid c2">
        ${UI.field({ name: 'startDate', label: 'Start', type: 'date', value: UI.today(), required: true })}
        ${UI.field({ name: 'endDate', label: 'End', type: 'date' })}
      </div>`,
      async (v) => { await API.post(`/api/ipd/admissions/${id}/medications`, v); UI.ok('Medication ordered — the chart is generated.'); });

    setTimeout(() => {
      const sel = document.querySelector('[name=drugId]');
      if (sel) sel.addEventListener('change', (e) => {
        const d = drugs.find((x) => x.id === Number(e.target.value));
        if (d) document.querySelector('[name=drugName]').value = `${d.name} ${d.strength || ''}`.trim();
      });
    }, 50);
  }

  async function openTransfer(a) {
    const wards = await API.get('/api/ipd/wards');
    const vacant = wards.wards.flatMap((w) => w.beds.filter((b) => b.status === 'vacant').map((b) => ({ ...b, ward_name: w.name })));
    simpleForm('Transfer to another bed',
      UI.field({ name: 'toBedId', label: 'New bed', required: true,
        options: [{ value: '', label: '— select —' }].concat(vacant.map((b) =>
          ({ value: b.id, label: `${b.ward_name} · ${b.bed_no} — ${b.tariff_per_day}/day` }))) }) +
      UI.field({ name: 'reason', label: 'Reason', required: true }),
      async (v) => { await API.post(`/api/ipd/admissions/${a.id}/transfer`, v); UI.ok('Patient transferred.'); });
  }

  // ------------------------------------------------------------- discharge
  function openDischarge(a) {
    UI.modal({
      title: `Discharge — ${a.patient_name} (${a.ip_no})`,
      size: 'wide',
      body: `<div class="alert info">Bed charges for ${UI.esc(a.days)} day(s) and any unbilled charges are posted to
          the invoice when you discharge. The bill must be settled, or carry a payment plan or documented exception.</div>
        <form id="dc-form">
          <div class="grid c2">
            ${UI.field({ name: 'dischargeType', label: 'Discharge type', value: 'recovered',
              options: ['recovered','referred','lama','absconded','transferred','expired'].map((t) => ({ value: t, label: UI.titleise(t) })) })}
            ${UI.field({ name: 'followUpDate', label: 'Review on', type: 'date',
              value: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) })}
          </div>
          ${UI.field({ name: 'finalDiagnosis', label: 'Final diagnosis', required: true })}
          ${UI.field({ name: 'courseInHospital', label: 'Course in hospital', type: 'textarea', rows: 3 })}
          ${UI.field({ name: 'dischargeMedication', label: 'Medicines on discharge', type: 'textarea', rows: 3 })}
          ${UI.field({ name: 'advice', label: 'Advice on discharge', type: 'textarea', rows: 2 })}
        </form>
        <div id="dc-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="go">Discharge</button>`,
      async onAction(act, modal) {
        if (act !== 'go') return;
        const form = modal.querySelector('#dc-form');
        if (!form.reportValidity()) return 'keep';
        try {
          const res = await API.post(`/api/ipd/admissions/${a.id}/discharge`, UI.formValues(form));
          if (res.error) {
            modal.querySelector('#dc-out').innerHTML =
              `<div class="alert danger mt"><b>${UI.esc(res.error)}</b><br>${UI.esc(res.hint)}
               <button class="btn sm mt" id="dc-bill">Open the bill</button></div>`;
            modal.querySelector('#dc-bill').addEventListener('click', () => { UI.closeAllModals(); APP.openInvoice(res.invoice.id); });
            return 'keep';
          }
          UI.ok(`Discharged after ${res.days} day(s). Bed released for cleaning.`);
          printSummary(a.id);
          APP.navigate('ipd');
        } catch (err) { UI.err(err.message); return 'keep'; }
      },
    });
  }

  /**
   * The discharge summary. Like the prescription and the report, it carries the
   * clinic's name and the consultant's code, and leaves a blank box for the
   * consultant to stamp and sign by hand once it is printed.
   */
  async function printSummary(id) {
    const a = await API.get(`/api/ipd/admissions/${id}/discharge-summary`);
    const html = `<div class="doc">
      ${UI.docHeader('Discharge Summary', [`IP No: ${a.ip_no}`, `UHID: ${a.uhid}`])}
      <table><tbody>
        <tr><th>Patient</th><td>${UI.esc(a.first_name)} ${UI.esc(a.last_name || '')}</td>
            <th>Age / Sex</th><td>${UI.esc(a.age_years || '—')} / ${UI.esc(a.gender || '—')}</td></tr>
        <tr><th>Ward / Bed</th><td>${UI.esc(a.ward_name)} / ${UI.esc(a.bed_no)}</td>
            <th>Blood group</th><td>${UI.esc(a.blood_group || '—')}</td></tr>
        <tr><th>Admitted</th><td>${UI.esc(UI.dateTime(a.admitted_at))}</td>
            <th>Discharged</th><td>${a.discharged_at ? UI.esc(UI.dateTime(a.discharged_at)) : '—'}</td></tr>
        <tr><th>Consultant</th><td>${UI.esc(a.doctor_code || '—')}</td>
            <th>Type</th><td>${UI.esc(UI.titleise(a.discharge_type || a.admission_type))}</td></tr>
      </tbody></table>

      <h4 class="mt">Reason for admission</h4><p>${UI.esc(a.reason || '—')}</p>
      <h4>Provisional diagnosis</h4><p>${UI.esc(a.provisional_diagnosis || '—')}</p>
      <h4>Final diagnosis</h4><p><b>${UI.esc(a.final_diagnosis || '—')}</b></p>
      <h4>Course in hospital</h4><p>${UI.esc(a.course_in_hospital || '—')}</p>

      ${a.investigations.length ? `<h4>Investigations</h4><table><thead><tr><th>Order</th><th>Results</th></tr></thead><tbody>
        ${a.investigations.map((i) => `<tr><td>${UI.esc(i.order_no)}</td><td>${UI.esc(i.results || '')}</td></tr>`).join('')}
      </tbody></table>` : ''}

      ${a.medications.length ? `<h4 class="mt">Medication given during stay</h4><table><thead>
        <tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Route</th><th>From</th><th>To</th></tr></thead><tbody>
        ${a.medications.map((m) => `<tr><td>${UI.esc(m.drug_name)}</td><td>${UI.esc(m.dose || '')}</td>
          <td>${UI.esc(m.frequency || '')}</td><td>${UI.esc((m.route || '').toUpperCase())}</td>
          <td>${UI.esc(UI.date(m.start_date))}</td><td>${m.end_date ? UI.esc(UI.date(m.end_date)) : '—'}</td></tr>`).join('')}
      </tbody></table>` : ''}

      <h4 class="mt">Medicines on discharge</h4><p>${UI.esc(a.discharge_medication || '—')}</p>
      <h4>Advice on discharge</h4><p>${UI.esc(a.discharge_advice || '—')}</p>
      ${a.follow_up_date ? `<p><b>Review on:</b> ${UI.esc(UI.date(a.follow_up_date))}</p>` : ''}

      <div class="sign"><div>Patient / attendant signature</div>
        <div class="stamp-box"></div></div>
      <div class="stamp-caption">Consultant's stamp &amp; signature</div>
      <div class="foot-note">Report to the clinic or the nearest emergency department if symptoms worsen.
        Bring this summary to every follow-up visit.</div>
    </div>`;
    UI.print(html, 'Discharge summary ' + a.ip_no);
  }
  // Exposed so the browser checks can print without hunting for a button.
  window.__printSummary = printSummary;
})();
