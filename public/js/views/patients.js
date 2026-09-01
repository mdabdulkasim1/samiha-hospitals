/* Patient registry: search, registration paperwork, and the 360° record. */
(function () {
  'use strict';

  APP.register('patients', {
    title: 'Patients',
    subtitle: 'Registry and medical records',

    async render(el, params) {
      if (params.id) return renderRecord(el, Number(params.id));

      APP.actions(APP.can(['reception'])
        ? [{ id: 'new', label: '+ Register patient', kind: '', onClick: openRegistration }]
        : []);

      el.innerHTML = `
        <div class="search-row">
          <input type="search" id="pq" placeholder="Search by name, UHID or phone…" value="${UI.esc(params.q || '')}" autofocus>
        </div>
        <div class="card"><div class="card-body tight" id="plist">${UI.loading()}</div></div>`;

      const input = el.querySelector('#pq');
      const load = async () => {
        const host = el.querySelector('#plist');
        host.innerHTML = UI.loading();
        const res = await API.get('/api/patients' + API.qs({ q: input.value.trim(), limit: 40 }));
        host.innerHTML = UI.table([
          { label: 'UHID', render: (p) => `<code>${UI.esc(p.uhid)}</code>` },
          { label: 'Name', render: (p) => `<b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>` },
          { label: 'Age / Sex', render: (p) => `${UI.esc(p.age_years || '—')} / ${UI.esc(UI.titleise(p.gender || '—'))}` },
          { label: 'Phone', render: (p) => UI.esc(p.phone || '—') },
          { label: 'Cover', render: (p) => p.is_uninsured
            ? UI.badge('Uninsured' + (p.sliding_scale_band ? ` · Band ${p.sliding_scale_band}` : ''), 'orange')
            : UI.badge('Insured', 'ok') },
          { label: 'Flags', render: (p) => p.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
          { label: 'Registered', render: (p) => UI.esc(UI.date(p.registered_at)) },
        ], res.rows, { emptyText: 'No patient matched that search.' });
        UI.bindRows(host, res.rows, (p) => APP.navigate('patients', { id: p.id }));
        APP.setSubtitle(`${res.total} patient(s) on file`);
      };

      let t;
      input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
      await load();
    },
  });

  // ------------------------------------------------------- registration form
  /** "Demographic, Med. History Paperwork" from the workflow. */
  function openRegistration() {
    UI.modal({
      title: 'Register a new patient',
      size: 'wide',
      body: `<form id="reg-form">
        <fieldset><legend>Demographics</legend>
          <div class="grid c4">
            ${UI.field({ name: 'title', label: 'Title', options: ['', 'Mr', 'Mrs', 'Ms', 'Master', 'Baby', 'Dr'] })}
            ${UI.field({ name: 'firstName', label: 'First name', required: true })}
            ${UI.field({ name: 'lastName', label: 'Last name' })}
            ${UI.field({ name: 'gender', label: 'Gender', required: true,
              options: [{ value: '', label: '— select —' }, { value: 'male', label: 'Male' },
                        { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] })}
          </div>
          <div class="grid c4">
            ${UI.field({ name: 'dob', label: 'Date of birth', type: 'date' })}
            ${UI.field({ name: 'age', label: 'Age (years)', type: 'number', min: 0, max: 130, hint: 'If DOB is unknown' })}
            ${UI.field({ name: 'bloodGroup', label: 'Blood group', options: ['', 'A+','A-','B+','B-','AB+','AB-','O+','O-'] })}
            ${UI.field({ name: 'maritalStatus', label: 'Marital status', options: ['', 'Single', 'Married', 'Widowed', 'Divorced'] })}
          </div>
        </fieldset>

        <fieldset><legend>Contact</legend>
          <div class="grid c3">
            ${UI.field({ name: 'phone', label: 'Mobile', required: true, placeholder: '10-digit number' })}
            ${UI.field({ name: 'whatsapp', label: 'WhatsApp number', hint: 'Leave blank to use the mobile number' })}
            ${UI.field({ name: 'email', label: 'Email', type: 'email' })}
          </div>
          ${UI.field({ name: 'address', label: 'Address', type: 'textarea', rows: 2 })}
          <div class="grid c4">
            ${UI.field({ name: 'city', label: 'City' })}
            ${UI.field({ name: 'state', label: 'State' })}
            ${UI.field({ name: 'pincode', label: 'PIN code' })}
            ${UI.field({ name: 'occupation', label: 'Occupation' })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'emergencyName', label: 'Emergency contact' })}
            ${UI.field({ name: 'emergencyPhone', label: 'Emergency phone' })}
            ${UI.field({ name: 'emergencyRelation', label: 'Relationship' })}
          </div>
        </fieldset>

        <fieldset><legend>Identity &amp; cover</legend>
          <div class="grid c2">
            ${UI.field({ name: 'idType', label: 'ID type', options: ['', 'Aadhaar', 'PAN', 'Voter ID', 'Passport', 'Driving licence'] })}
            ${UI.field({ name: 'idNumber', label: 'ID number' })}
          </div>
          ${UI.checkbox({ name: 'isUninsured', label: 'Patient is uninsured (routes to financial screening)', checked: true })}
          <div class="grid c3" id="ins-fields">
            ${UI.field({ name: 'insuranceProvider', label: 'Insurer / TPA' })}
            ${UI.field({ name: 'insurancePolicyNo', label: 'Policy number' })}
            ${UI.field({ name: 'insuranceValidTill', label: 'Valid until', type: 'date' })}
          </div>
        </fieldset>

        <fieldset><legend>Medical history</legend>
          <div class="grid c2">
            ${UI.field({ name: 'allergies', label: 'Known allergies', placeholder: 'e.g. penicillin, sulfa drugs' })}
            ${UI.field({ name: 'chronicConditions', label: 'Chronic conditions', placeholder: 'e.g. type 2 diabetes, hypertension' })}
          </div>
          ${UI.field({ name: 'pastIllness', label: 'Past illnesses / surgeries', type: 'textarea', rows: 2 })}
          ${UI.field({ name: 'familyHistory', label: 'Family history', type: 'textarea', rows: 2 })}
        </fieldset>

        <fieldset><legend>Preferred pharmacy</legend>
          <div class="grid c3">
            ${UI.field({ name: 'pharmacyName', label: 'Pharmacy name' })}
            ${UI.field({ name: 'pharmacyPhone', label: 'Pharmacy phone' })}
            ${UI.field({ name: 'pharmacyAddress', label: 'Pharmacy address' })}
          </div>
        </fieldset>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Register patient</button>`,
      onMount(modal) {
        const uninsured = modal.querySelector('[name=isUninsured]');
        const fields = modal.querySelector('#ins-fields');
        const sync = () => { fields.style.opacity = uninsured.checked ? '.45' : '1'; };
        uninsured.addEventListener('change', sync);
        sync();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#reg-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);

        values.history = [];
        if (values.pastIllness) values.history.push({ kind: 'past_illness', detail: values.pastIllness });
        if (values.familyHistory) values.history.push({ kind: 'family', detail: values.familyHistory });
        if (values.allergies) values.history.push({ kind: 'allergy', detail: values.allergies });
        delete values.pastIllness;
        delete values.familyHistory;

        try {
          const patient = await API.post('/api/patients', values);
          UI.ok(`Registered — UHID ${patient.uhid}`);
          APP.navigate('patients', { id: patient.id });
        } catch (err) {
          if (err.status === 409) {
            const proceed = await UI.confirm(err.message + '\n\nRegister anyway?', { title: 'Possible duplicate' });
            if (!proceed) return 'keep';
            const patient = await API.post('/api/patients', { ...values, allowDuplicate: true });
            UI.ok(`Registered — UHID ${patient.uhid}`);
            APP.navigate('patients', { id: patient.id });
            return;
          }
          throw err;
        }
      },
    });
  }

  // ------------------------------------------------------------ 360° record
  async function renderRecord(el, id) {
    const p = await API.get(`/api/patients/${id}`);
    APP.setSubtitle(`${p.uhid} · ${p.name}`);
    APP.actions([
      { id: 'back', label: '← All patients', onClick: () => APP.navigate('patients') },
      ...(APP.can(['reception', 'nurse', 'doctor', 'counselor'])
        ? [{ id: 'edit', label: 'Edit details', onClick: () => openEdit(p) }] : []),
      ...(APP.can(['reception'])
        ? [{ id: 'arrive', label: 'Record arrival', kind: '', onClick: () => { APP.navigate('queue'); UI.toast('Use “+ Patient arrived” on the queue board.'); } }] : []),
    ]);

    el.innerHTML = `
      ${p.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(p.allergies)}</div>` : ''}
      ${p.outstanding > 0 ? `<div class="alert warn"><b>Outstanding balance:</b> ${UI.money(p.outstanding)} across unpaid bills.</div>` : ''}

      <div class="grid c4 mb">
        <div class="stat teal"><div class="label">UHID</div><div class="value" style="font-size:19px">${UI.esc(p.uhid)}</div>
          <div class="foot">Registered ${UI.esc(UI.date(p.registered_at))}</div></div>
        <div class="stat crimson"><div class="label">Age / Sex</div><div class="value">${UI.esc(p.age_years || '—')}</div>
          <div class="foot">${UI.esc(UI.titleise(p.gender || '—'))}${p.blood_group ? ' · ' + UI.esc(p.blood_group) : ''}</div></div>
        <div class="stat orange"><div class="label">Cover</div>
          <div class="value" style="font-size:19px">${p.is_uninsured ? 'Uninsured' : 'Insured'}</div>
          <div class="foot">${p.is_uninsured
            ? (p.sliding_scale_band ? 'Sliding-scale band ' + UI.esc(p.sliding_scale_band) : 'No screening on file')
            : UI.esc(p.insurance_provider || '')}</div></div>
        <div class="stat ok"><div class="label">Visits</div><div class="value">${UI.num(p.visits.length)}</div>
          <div class="foot">${UI.num(p.admissions.length)} admission(s)</div></div>
      </div>

      <div class="tabs" id="ptabs">
        <button class="active" data-tab="overview">Overview</button>
        <button data-tab="visits">Visits</button>
        <button data-tab="clinical">Clinical notes</button>
        <button data-tab="diagnostics">Diagnostics</button>
        <button data-tab="medicines">Medicines</button>
        <button data-tab="ipd">In-patient</button>
        <button data-tab="billing">Billing</button>
        <button data-tab="financial">Financial screening</button>
      </div>
      <div id="ptab-body"></div>`;

    const tabs = {
      overview: () => `
        <div class="grid c2">
          <div class="card"><div class="card-head"><h3>Contact</h3></div><div class="card-body"><dl class="kv">
            <dt>Phone</dt><dd>${UI.esc(p.phone || '—')}</dd>
            <dt>WhatsApp</dt><dd>${UI.esc(p.whatsapp || '—')}</dd>
            <dt>Email</dt><dd>${UI.esc(p.email || '—')}</dd>
            <dt>Address</dt><dd>${UI.esc([p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ') || '—')}</dd>
            <dt>Emergency</dt><dd>${UI.esc(p.emergency_name || '—')} ${UI.esc(p.emergency_phone || '')}
              ${p.emergency_relation ? '(' + UI.esc(p.emergency_relation) + ')' : ''}</dd>
            <dt>ID</dt><dd>${UI.esc(p.id_type || '—')} ${UI.esc(p.id_number || '')}</dd>
            <dt>Occupation</dt><dd>${UI.esc(p.occupation || '—')}</dd>
          </dl></div></div>
          <div class="card"><div class="card-head"><h3>Clinical background</h3></div><div class="card-body">
            <dl class="kv">
              <dt>Allergies</dt><dd>${UI.esc(p.allergies || 'None recorded')}</dd>
              <dt>Chronic</dt><dd>${UI.esc(p.chronic_conditions || 'None recorded')}</dd>
              <dt>Last screening</dt><dd>${p.last_screening_date ? UI.esc(UI.date(p.last_screening_date)) : UI.badge('Never', 'warn')}</dd>
              <dt>Preferred pharmacy</dt><dd>${UI.esc(p.pharmacy_name || '—')} ${UI.esc(p.pharmacy_phone || '')}</dd>
            </dl>
            <h4 class="mt mb">History</h4>
            ${p.history.length ? p.history.map((h) =>
              `<div class="small mb"><b>${UI.esc(UI.titleise(h.kind))}:</b> ${UI.esc(h.detail)}
               <span class="muted">${UI.esc(UI.date(h.recorded_at))}</span></div>`).join('')
              : '<div class="muted small">No history recorded.</div>'}
          </div></div>
        </div>`,

      visits: () => card('Visits', UI.table([
        { label: 'Visit', key: 'visit_no' },
        { label: 'Date', render: (v) => UI.esc(UI.dateTime(v.arrived_at)) },
        { label: 'Doctor', render: (v) => UI.esc(v.doctor_name || '—') },
        { label: 'Reason', render: (v) => UI.esc(v.reason_for_visit || '—') },
        { label: 'Status', render: (v) => UI.statusBadge(v.status) },
      ], p.visits, { emptyText: 'No visits yet.' })),

      clinical: () => card('Consultations', p.consultations.length
        ? p.consultations.map((c) => `<fieldset><legend>${UI.esc(UI.date(c.created_at))} · ${UI.esc(c.doctor_name || '')}</legend>
            <dl class="kv">
              <dt>Complaint</dt><dd>${UI.esc(c.chief_complaint || '—')}</dd>
              <dt>History</dt><dd>${UI.esc(c.subjective || '—')}</dd>
              <dt>Examination</dt><dd>${UI.esc(c.objective || '—')}</dd>
              <dt>Assessment</dt><dd>${UI.esc(c.assessment || '—')}</dd>
              <dt>Plan</dt><dd>${UI.esc(c.plan || '—')}</dd>
              ${c.diagnoses ? `<dt>Diagnoses</dt><dd>${UI.esc(c.diagnoses)}</dd>` : ''}
              ${c.follow_up_date ? `<dt>Review</dt><dd>${UI.esc(UI.date(c.follow_up_date))}</dd>` : ''}
            </dl></fieldset>`).join('')
        : UI.empty('No consultations recorded.', '🩺')),

      diagnostics: () => card('Diagnostic orders', UI.table([
        { label: 'Order', key: 'order_no' },
        { label: 'Date', render: (o) => UI.esc(UI.date(o.ordered_at)) },
        { label: 'Tests', render: (o) => UI.esc(o.tests || '—') },
        { label: 'Status', render: (o) => UI.statusBadge(o.status) },
      ], p.labOrders, { emptyText: 'No diagnostics ordered.' })),

      medicines: () => card('Prescriptions', UI.table([
        { label: 'Medicine', key: 'drug_name' },
        { label: 'Dose', render: (r) => `${UI.esc(r.dose || '')} ${UI.esc(r.frequency || '')}` },
        { label: 'Duration', render: (r) => r.duration_days ? UI.esc(r.duration_days) + ' days' : '—' },
        { label: 'Qty', render: (r) => `${UI.esc(r.dispensed_qty)} / ${UI.esc(r.quantity)}` },
        { label: 'Status', render: (r) => UI.statusBadge(r.status) },
        { label: 'Prescribed', render: (r) => UI.esc(UI.date(r.created_at)) },
      ], p.prescriptions, { emptyText: 'No prescriptions on file.' })),

      ipd: () => card('Admissions', UI.table([
        { label: 'IP No', key: 'ip_no' },
        { label: 'Admitted', render: (a) => UI.esc(UI.dateTime(a.admitted_at)) },
        { label: 'Ward / Bed', render: (a) => `${UI.esc(a.ward_name || '')} / ${UI.esc(a.bed_no || '')}` },
        { label: 'Consultant', render: (a) => UI.esc(a.doctor_name || '—') },
        { label: 'Status', render: (a) => UI.statusBadge(a.status) },
        { label: 'Discharged', render: (a) => a.discharged_at ? UI.esc(UI.date(a.discharged_at)) : '—' },
      ], p.admissions, { emptyText: 'No in-patient admissions.' })),

      billing: () => card('Invoices', UI.table([
        { label: 'Invoice', key: 'invoice_no' },
        { label: 'Date', render: (i) => UI.esc(UI.date(i.created_at)) },
        { label: 'Type', render: (i) => UI.esc(i.kind.toUpperCase()) },
        { label: 'Net', num: true, render: (i) => UI.money(i.net) },
        { label: 'Paid', num: true, render: (i) => UI.money(i.paid) },
        { label: 'Balance', num: true, render: (i) => UI.money(i.balance) },
        { label: 'Status', render: (i) => UI.statusBadge(i.status) },
      ], p.invoices, { emptyText: 'No invoices raised.' })),

      financial: () => card('Financial screenings', UI.table([
        { label: 'Ref', key: 'screening_no' },
        { label: 'Date', render: (s) => UI.esc(UI.date(s.created_at)) },
        { label: 'FPL %', render: (s) => s.fpl_pct !== null ? UI.esc(s.fpl_pct) + '%' : '—' },
        { label: 'Band', render: (s) => s.sliding_scale_band ? UI.badge('Band ' + s.sliding_scale_band, 'teal') : '—' },
        { label: 'Discount', render: (s) => UI.esc(s.discount_pct) + '%' },
        { label: 'Decision', render: (s) => s.patient_decision ? UI.statusBadge(s.patient_decision) : '—' },
        { label: 'Status', render: (s) => UI.statusBadge(s.status) },
      ], p.screenings, { emptyText: 'No financial screening on file.' })),
    };

    const card = (title, inner) =>
      `<div class="card"><div class="card-head"><h3>${UI.esc(title)}</h3></div><div class="card-body tight">${inner}</div></div>`;

    const body = el.querySelector('#ptab-body');
    const show = (name) => {
      body.innerHTML = tabs[name]();
      el.querySelectorAll('#ptabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (name === 'visits') UI.bindRows(body, p.visits, (v) => APP.openVisit(v.id));
      if (name === 'billing') UI.bindRows(body, p.invoices, (i) => APP.openInvoice(i.id));
      if (name === 'ipd') UI.bindRows(body, p.admissions, (a) => APP.navigate('ipd', { admissionId: a.id }));
    };
    el.querySelectorAll('#ptabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show('overview');
  }

  function openEdit(p) {
    UI.modal({
      title: 'Edit — ' + p.name,
      size: 'wide',
      body: `<form id="ed-form">
        <div class="grid c3">
          ${UI.field({ name: 'firstName', label: 'First name', value: p.first_name, required: true })}
          ${UI.field({ name: 'lastName', label: 'Last name', value: p.last_name || '' })}
          ${UI.field({ name: 'age', label: 'Age', type: 'number', value: p.age_years || '' })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'phone', label: 'Mobile', value: p.phone || '' })}
          ${UI.field({ name: 'whatsapp', label: 'WhatsApp', value: p.whatsapp || '' })}
          ${UI.field({ name: 'email', label: 'Email', value: p.email || '' })}
        </div>
        ${UI.field({ name: 'address', label: 'Address', type: 'textarea', rows: 2, value: p.address || '' })}
        <div class="grid c2">
          ${UI.field({ name: 'allergies', label: 'Allergies', value: p.allergies || '' })}
          ${UI.field({ name: 'chronicConditions', label: 'Chronic conditions', value: p.chronic_conditions || '' })}
        </div>
        ${UI.checkbox({ name: 'isUninsured', label: 'Uninsured', checked: !!p.is_uninsured })}
        <div class="grid c2">
          ${UI.field({ name: 'insuranceProvider', label: 'Insurer / TPA', value: p.insurance_provider || '' })}
          ${UI.field({ name: 'insurancePolicyNo', label: 'Policy number', value: p.insurance_policy_no || '' })}
        </div>
        <fieldset><legend>Preferred pharmacy</legend>
          <div class="grid c3">
            ${UI.field({ name: 'pharmacyName', label: 'Name', value: p.pharmacy_name || '' })}
            ${UI.field({ name: 'pharmacyPhone', label: 'Phone', value: p.pharmacy_phone || '' })}
            ${UI.field({ name: 'pharmacyAddress', label: 'Address', value: p.pharmacy_address || '' })}
          </div>
        </fieldset>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save changes</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        await API.patch(`/api/patients/${p.id}`, UI.formValues(modal.querySelector('#ed-form')));
        UI.ok('Patient record updated.');
        APP.reload();
      },
    });
  }
})();
