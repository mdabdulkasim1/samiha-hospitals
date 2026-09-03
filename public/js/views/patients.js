/* Patient registry: search, registration paperwork, and the 360° record. */
(function () {
  'use strict';

  APP.register('patients', {
    title: 'Patients',
    subtitle: 'Registry and medical records',

    async render(el, params) {
      if (params.id) return renderRecord(el, Number(params.id), params);

      APP.actions(APP.can(['reception'])
        ? [{ id: 'new', label: '+ Register patient', kind: '', onClick: openRegistration }]
        : []);

      const stage = params.stage || '';
      el.innerHTML = `
        <div class="tabs" id="stage-tabs">
          <button data-stage="" class="${stage === '' ? 'active' : ''}">All patients</button>
          <button data-stage="enquiry" class="${stage === 'enquiry' ? 'active' : ''}">Enquiries <span data-c="enquiry"></span></button>
          <button data-stage="registered" class="${stage === 'registered' ? 'active' : ''}">Registered <span data-c="registered"></span></button>
        </div>
        <div class="card mb phone-first"><div class="card-body">
          <label class="field"><span>Mobile number</span></label>
          <div class="search-row">
            <input type="tel" id="pmobile" inputmode="numeric" autocomplete="off" autofocus
                   placeholder="Type the mobile number — the way patients give it"
                   value="${UI.esc(params.phone || '')}">
            <button class="btn" id="pmobile-go">Find</button>
          </div>
          <div class="muted small">One number often covers a whole family. Everybody on it is listed
            below — pick the person who has come in.</div>
          <div id="family" class="mt"></div>
        </div></div>

        <div class="search-row">
          <input type="search" id="pq" placeholder="…or search by name or UHID" value="${UI.esc(params.q || '')}">
        </div>
        ${stage === 'enquiry' ? `<div class="alert info">These people have contacted the clinic but have not
          been registered yet. Open one and press <b>Complete registration</b> when they arrive — the enquiry,
          its source and any appointment already booked carry over to the same file.</div>` : ''}
        <div class="card"><div class="card-body tight" id="plist">${UI.loading()}</div></div>`;

      el.querySelectorAll('#stage-tabs button').forEach((b) => b.addEventListener('click', () =>
        APP.navigate('patients', { ...(b.dataset.stage ? { stage: b.dataset.stage } : {}) })));

      // ----------------------------------------------- mobile number first
      /*
       * The mobile number is what a patient knows by heart and what they give
       * on the phone and on WhatsApp, so it is the first thing on the screen.
       * A number may carry a whole household, so the desk is shown everybody on
       * it and picks the person standing in front of them.
       */
      const mobile = el.querySelector('#pmobile');
      const familyHost = el.querySelector('#family');

      const findFamily = async () => {
        const digits = mobile.value.replace(/\D/g, '');
        if (digits.length < 6) {
          familyHost.innerHTML = digits.length
            ? '<div class="muted small">Keep typing — at least six digits.</div>' : '';
          return;
        }
        const res = await API.get('/api/patients/by-phone' + API.qs({ phone: digits }));
        if (!res.members.length) {
          familyHost.innerHTML = `<div class="alert warn">
            Nobody is registered on <b>${UI.esc(digits)}</b>.
            ${APP.can(['reception'])
              ? '<button class="btn sm" id="fam-new" style="margin-left:8px">Register this number</button>' : ''}</div>`;
          const nw = familyHost.querySelector('#fam-new');
          if (nw) nw.addEventListener('click', () => openRegistration({ phone: digits }));
          return;
        }

        familyHost.innerHTML = `
          <div class="row-between mb">
            <b>${UI.num(res.members.length)} ${res.isFamily ? 'people' : 'person'} on ${UI.esc(res.phone)}</b>
            ${APP.can(['reception']) ? `<button class="btn ghost sm" id="fam-add">
              + Add another person on this number</button>` : ''}
          </div>
          <div class="family-list">${res.members.map((m) => `
            <button type="button" class="family-card" data-pick="${m.id}">
              <span class="fam-avatar">${UI.esc((m.first_name || '?').charAt(0).toUpperCase())}</span>
              <span class="fam-body">
                <span class="fam-name">${UI.esc(m.first_name)} ${UI.esc(m.last_name || '')}
                  ${m.stage === 'enquiry' ? UI.badge('Enquiry', 'orange') : ''}
                  ${m.allergies ? UI.badge('⚠ Allergy', 'danger') : ''}</span>
                <span class="muted small">${UI.esc(m.uhid)} ·
                  ${UI.esc(m.age_years || '—')}${m.age_years ? 'y' : ''} ·
                  ${UI.esc(UI.titleise(m.gender || '—'))}
                  ${m.relationship_to_primary ? ' · ' + UI.esc(m.relationship_to_primary) : ''}</span>
                <span class="muted small">
                  ${m.last_visit ? 'Last seen ' + UI.esc(UI.date(m.last_visit)) : 'Never visited'}
                  ${m.visit_count ? ` · ${UI.num(m.visit_count)} visit(s)` : ''}
                  ${m.next_appointment ? ` · <b>booked ${UI.esc(UI.date(m.next_appointment))}</b>` : ''}
                  ${m.outstanding > 0 ? ` · <b style="color:var(--danger)">${UI.money(m.outstanding)} due</b>` : ''}
                </span>
              </span>
            </button>`).join('')}</div>`;

        familyHost.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () =>
          APP.navigate('patients', { id: b.dataset.pick })));
        const addBtn = familyHost.querySelector('#fam-add');
        if (addBtn) addBtn.addEventListener('click', () => openRegistration({
          phone: res.phone, family: res.members,
          address: (res.members.find((m) => m.address) || {}).address,
          city: (res.members.find((m) => m.city) || {}).city,
        }));
      };

      let mt;
      mobile.addEventListener('input', () => { clearTimeout(mt); mt = setTimeout(findFamily, 260); });
      mobile.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findFamily(); } });
      el.querySelector('#pmobile-go').addEventListener('click', findFamily);
      if (params.phone) findFamily();

      const input = el.querySelector('#pq');
      const load = async () => {
        const host = el.querySelector('#plist');
        host.innerHTML = UI.loading();
        const res = await API.get('/api/patients' + API.qs({ q: input.value.trim(), stage, limit: 40 }));
        host.innerHTML = UI.table([
          { label: 'UHID', render: (p) => `<code>${UI.esc(p.uhid)}</code>` },
          { label: 'Name', render: (p) => `<b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>` },
          { label: 'Stage', render: (p) => p.stage === 'enquiry'
            ? UI.badge('Enquiry', 'orange') : UI.badge('Registered', 'ok') },
          { label: 'Age / Sex', render: (p) => `${UI.esc(p.age_years || '—')} / ${UI.esc(UI.titleise(p.gender || '—'))}` },
          { label: 'Phone', render: (p) => UI.esc(p.phone || '—') },
          { label: 'Came via', render: (p) => p.enquiry_source
            ? UI.badge(UI.titleise(p.enquiry_source), p.enquiry_source === 'whatsapp' ? 'wa' : 'info') : '—' },
          { label: 'Visits', num: true, render: (p) => UI.esc(p.visit_count || 0) },
          { label: 'Flags', render: (p) => p.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
          { label: 'Since', render: (p) => UI.esc(UI.date(p.stage === 'enquiry'
            ? (p.enquiry_at || p.registered_at) : p.registered_at)) },
        ], res.rows, { emptyText: stage === 'enquiry'
          ? 'No enquiries waiting to be registered.' : 'No patient matched that search.' });
        UI.bindRows(host, res.rows, (p) => APP.navigate('patients', { id: p.id }));

        el.querySelectorAll('[data-c]').forEach((sp) => {
          const n = res.counts[sp.dataset.c] || 0;
          sp.innerHTML = n ? ` <span class="badge ${sp.dataset.c === 'enquiry' ? 'orange' : 'ok'}">${n}</span>` : '';
        });
        APP.setSubtitle(`${res.counts.enquiry} enquiry · ${res.counts.registered} registered` +
          (input.value.trim() || stage ? ` · showing ${res.total}` : ''));
      };

      let t;
      input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
      await load();
    },
  });

  // ------------------------------------------------------- registration form
  /**
   * "Demographic, Med. History Paperwork" from the workflow. The same fields
   * serve a walk-in registration and the promotion of an existing enquiry, so
   * the two can never drift apart.
   */
  function registrationFields(p = {}) {
    const v = (k, d = '') => (p[k] === null || p[k] === undefined ? d : p[k]);
    return `
      <fieldset><legend>Personal &amp; demographic</legend>
        <div class="grid c4">
          ${UI.field({ name: 'title', label: 'Title', value: v('title'),
            options: ['', 'Mr', 'Mrs', 'Ms', 'Master', 'Baby', 'Dr'] })}
          ${UI.field({ name: 'firstName', label: 'First name (as on ID)', required: true, value: v('first_name') })}
          ${UI.field({ name: 'lastName', label: 'Last name', value: v('last_name') })}
          ${UI.field({ name: 'maritalStatus', label: 'Marital status', value: v('marital_status'),
            options: ['', 'Single', 'Married', 'Widowed', 'Divorced'] })}
        </div>
        <div class="grid c4">
          ${UI.field({ name: 'dob', label: 'Date of birth', type: 'date', value: v('dob'),
            hint: 'Verifies age and identity' })}
          ${UI.field({ name: 'age', label: 'Age (years)', type: 'number', min: 0, max: 130,
            value: v('age_years'), hint: 'Only if the date of birth is unknown' })}
          ${UI.field({ name: 'gender', label: 'Gender', required: true, value: v('gender'),
            options: [{ value: '', label: '— select —' }, { value: 'male', label: 'Male' },
                      { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] })}
          ${UI.field({ name: 'sexAtBirth', label: 'Sex at birth', value: v('sex_at_birth'),
            options: [{ value: '', label: '— select —' }, { value: 'male', label: 'Male' },
                      { value: 'female', label: 'Female' }, { value: 'intersex', label: 'Intersex' }],
            hint: 'Drives reference ranges and screening' })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'phone', label: 'Mobile', required: true, value: v('phone'),
            placeholder: '10-digit number',
            hint: 'How this patient is found at the desk — a family may share one' })}
          ${UI.field({ name: 'relationshipToPrimary', label: 'Relationship on this number',
            value: v('relationship_to_primary'),
            options: ['', 'Self', 'Spouse', 'Son', 'Daughter', 'Father', 'Mother',
                      'Brother', 'Sister', 'Grandparent', 'Guardian', 'Other'] })}
          ${UI.field({ name: 'whatsapp', label: 'WhatsApp number', value: v('whatsapp'),
            hint: 'Blank uses the mobile number' })}
          ${UI.field({ name: 'email', label: 'Email', type: 'email', value: v('email'),
            hint: 'Appointment reminders and reports' })}
        </div>
        ${UI.field({ name: 'address', label: 'Home address', type: 'textarea', rows: 2, value: v('address') })}
        <div class="grid c4">
          ${UI.field({ name: 'city', label: 'City', value: v('city') })}
          ${UI.field({ name: 'state', label: 'State', value: v('state') })}
          ${UI.field({ name: 'pincode', label: 'PIN code', value: v('pincode') })}
          ${UI.field({ name: 'bloodGroup', label: 'Blood group', value: v('blood_group'),
            options: ['', 'A+','A-','B+','B-','AB+','AB-','O+','O-'] })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'emergencyName', label: 'Emergency contact name', value: v('emergency_name') })}
          ${UI.field({ name: 'emergencyPhone', label: 'Emergency contact phone', value: v('emergency_phone') })}
          ${UI.field({ name: 'emergencyRelation', label: 'Relationship', value: v('emergency_relation'),
            placeholder: 'e.g. spouse, son, friend' })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'aadhaarNumber', label: 'Aadhaar number', value: v('aadhaar_number'),
            placeholder: '12 digits',
            hint: 'Checked against its own check digit. Only the last four are ever printed.' })}
          ${UI.field({ name: 'idType', label: 'Other photo ID', value: v('id_type'),
            options: ['', 'PAN', 'Voter ID', 'Passport', 'Driving licence', 'Ration card'] })}
          ${UI.field({ name: 'idNumber', label: 'ID number', value: v('id_number') })}
        </div>
      </fieldset>

      <fieldset><legend>Insurance &amp; billing</legend>
        ${UI.checkbox({ name: 'isUninsured', label: 'Patient is uninsured (routes them to financial screening)',
          checked: p.is_uninsured === undefined ? true : !!p.is_uninsured })}
        <div class="grid c3" id="ins-fields">
          ${UI.field({ name: 'insuranceProvider', label: 'Insurance provider', value: v('insurance_provider'),
            placeholder: 'The company paying for care' })}
          ${UI.field({ name: 'insurancePolicyNo', label: 'Policy / member ID', value: v('insurance_policy_no') })}
          ${UI.field({ name: 'insuranceValidTill', label: 'Valid until', type: 'date', value: v('insurance_valid_till') })}
        </div>
        ${UI.field({ name: 'billingAddress', label: 'Billing address', type: 'textarea', rows: 2,
          value: v('billing_address'), hint: 'Where invoices and claims are sent. Blank uses the home address.' })}
      </fieldset>

      <fieldset><legend>Medical history</legend>
        ${UI.field({ name: 'presentingComplaint', label: 'Current symptoms — why they are here today',
          type: 'textarea', rows: 2, value: v('presenting_complaint') })}
        <div class="grid c2">
          ${UI.field({ name: 'allergies', label: 'Allergies', value: v('allergies'),
            placeholder: 'Medication, food, latex — and the reaction' })}
          ${UI.field({ name: 'chronicConditions', label: 'Ongoing conditions', value: v('chronic_conditions'),
            placeholder: 'e.g. type 2 diabetes, hypertension' })}
        </div>
        ${UI.field({ name: 'currentMedications', label: 'Current medications', type: 'textarea', rows: 2,
          value: v('current_medications'), hint: 'Include vitamins and supplements, with doses' })}
        <div class="grid c2">
          ${UI.field({ name: 'pastIllness', label: 'Past illnesses', type: 'textarea', rows: 2 })}
          ${UI.field({ name: 'surgeries', label: 'Surgeries &amp; major health events', type: 'textarea', rows: 2 })}
        </div>
        ${UI.field({ name: 'familyHistory', label: 'Family medical history', type: 'textarea', rows: 2,
          placeholder: 'Conditions that run in the family' })}
        ${UI.field({ name: 'immunisations', label: 'Immunisation history', type: 'textarea', rows: 2,
          value: v('immunisations'), placeholder: 'e.g. childhood schedule complete; Td booster 2021' })}
      </fieldset>

      <fieldset><legend>Social history</legend>
        <div class="grid c3">
          ${UI.field({ name: 'occupation', label: 'Occupation', value: v('occupation') })}
          ${UI.field({ name: 'smokingStatus', label: 'Smoking', value: v('smoking_status'),
            options: [{ value: '', label: '— not asked —' }, { value: 'never', label: 'Never' },
                      { value: 'former', label: 'Former smoker' }, { value: 'current', label: 'Current smoker' },
                      { value: 'unknown', label: 'Unknown' }] })}
          ${UI.field({ name: 'alcoholUse', label: 'Alcohol', value: v('alcohol_use'),
            options: [{ value: '', label: '— not asked —' }, { value: 'never', label: 'Never' },
                      { value: 'occasional', label: 'Occasional' }, { value: 'regular', label: 'Regular' },
                      { value: 'former', label: 'Former' }, { value: 'unknown', label: 'Unknown' }] })}
        </div>
        ${UI.field({ name: 'socialHistory', label: 'Other social history', type: 'textarea', rows: 2,
          placeholder: 'Living situation, exposures at work, anything else relevant' })}
      </fieldset>

      <fieldset><legend>Baseline vital signs <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">— optional at the desk</span></legend>
        <div class="grid c4">
          ${UI.field({ name: 'vitalsHeightCm', label: 'Height (cm)', type: 'number', step: '0.1' })}
          ${UI.field({ name: 'vitalsWeightKg', label: 'Weight (kg)', type: 'number', step: '0.1' })}
          ${UI.field({ name: 'vitalsTempC', label: 'Temperature (°C)', type: 'number', step: '0.1' })}
          ${UI.field({ name: 'vitalsPulse', label: 'Heart rate (bpm)', type: 'number' })}
        </div>
        <div class="grid c4">
          ${UI.field({ name: 'vitalsBpSystolic', label: 'BP systolic', type: 'number' })}
          ${UI.field({ name: 'vitalsBpDiastolic', label: 'BP diastolic', type: 'number' })}
          ${UI.field({ name: 'vitalsSpo2', label: 'SpO₂ (%)', type: 'number', min: 0, max: 100 })}
          ${UI.field({ name: 'vitalsRespRate', label: 'Respiratory rate', type: 'number' })}
        </div>
        <div class="muted small">Leave blank if the nurse station will take these. BMI is worked out for you.</div>
      </fieldset>

      <fieldset><legend>Preferred pharmacy</legend>
        <div class="grid c3">
          ${UI.field({ name: 'pharmacyName', label: 'Pharmacy name', value: v('pharmacy_name') })}
          ${UI.field({ name: 'pharmacyPhone', label: 'Pharmacy phone', value: v('pharmacy_phone') })}
          ${UI.field({ name: 'pharmacyAddress', label: 'Pharmacy address', value: v('pharmacy_address') })}
        </div>
      </fieldset>

      <fieldset><legend>Consent</legend>
        <div class="alert info">Read these to the patient and tick what they agree to.
          <b>Treatment consent is required</b> — registration cannot be completed without it.</div>
        <label class="inline-check">
          <input type="checkbox" name="consentTreatment" required${p.consent_treatment ? ' checked' : ''}>
          <span><b>Consent to treatment</b> — the patient agrees to examination and treatment at this clinic.</span>
        </label>
        <label class="inline-check">
          <input type="checkbox" name="consentPrivacy"${p.consent_privacy ? ' checked' : ''}>
          <span><b>Privacy notice</b> — the patient has been told how their records are held and shared.</span>
        </label>
        <label class="inline-check">
          <input type="checkbox" name="consentContact"${p.consent_contact ? ' checked' : ''}>
          <span><b>Contact consent</b> — the patient agrees to reminders and reports by WhatsApp, SMS or email.</span>
        </label>
        ${UI.field({ name: 'consentSignedBy', label: 'Signed by', value: v('consent_signed_by'),
          placeholder: 'The patient, or the guardian who signed on their behalf' })}
        ${UI.field({ name: 'notes', label: 'Front-desk notes', value: v('notes') })}
      </fieldset>`;
  }

  /**
   * Keeps the cover fields coherent: filling in an insurer contradicts the
   * "uninsured" tick, and a patient recorded as uninsured should not carry a
   * policy number. Left inconsistent, this later mis-routes the financial
   * screening and the sliding-scale discount.
   */
  function wireCoverFields(scope) {
    const uninsured = scope.querySelector('[name=isUninsured]');
    const fields = scope.querySelector('#ins-fields');
    if (!uninsured || !fields) return;

    const provider = fields.querySelector('[name=insuranceProvider]');
    const policy = fields.querySelector('[name=insurancePolicyNo]');

    const paint = () => { fields.style.opacity = uninsured.checked ? '.45' : '1'; };
    uninsured.addEventListener('change', () => {
      if (uninsured.checked && (provider.value.trim() || policy.value.trim())) {
        UI.warn('Marked uninsured — the insurer details will not be saved as cover.');
      }
      paint();
    });

    // Typing an insurer means they are insured.
    for (const input of [provider, policy]) {
      if (!input) continue;
      input.addEventListener('input', () => {
        if (input.value.trim() && uninsured.checked) {
          uninsured.checked = false;
          paint();
        }
      });
    }
    paint();
  }

  /** Pulls the history lines out of the shared form into the API shape. */
  function collectRegistration(form) {
    const values = UI.formValues(form);
    // The vitals inputs are flat in the form; the API takes them nested.
    values.vitals = {};
    for (const key of Object.keys(values)) {
      if (!key.startsWith('vitals') || key === 'vitals') continue;
      const name = key.slice(6);
      values.vitals[name.charAt(0).toLowerCase() + name.slice(1)] = values[key];
      delete values[key];
    }
    return values;
  }

  /**
   * `seed` carries what the desk already knows — usually the mobile number they
   * searched, and the household already on it. Adding a second person to a
   * number is the ordinary case, not an exception, so the shared address comes
   * across and the desk is reminded who is already on the file.
   */
  function openRegistration(seed = {}) {
    const family = seed.family || [];
    UI.modal({
      title: family.length ? 'Add a person to this mobile number' : 'Register a new patient',
      size: 'wide',
      body: `${family.length ? `<div class="alert info">
          <b>${UI.num(family.length)} patient(s) already on ${UI.esc(seed.phone)}:</b>
          ${family.map((m) => UI.esc(`${m.first_name} ${m.last_name || ''} (${m.uhid})`)).join(' · ')}.
          This registers another person on the same number — open one of the above instead if
          they are already on file.</div>` : ''}
        <form id="reg-form">${registrationFields({
          phone: seed.phone, whatsapp: seed.phone, address: seed.address, city: seed.city,
        })}</form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${family.length
                 ? 'Add to this number' : 'Register patient'}</button>`,
      onMount(modal) { wireCoverFields(modal); },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#reg-form');
        if (!form.reportValidity()) return 'keep';
        const values = collectRegistration(form);

        try {
          const patient = await API.post('/api/patients',
            family.length ? { ...values, allowDuplicate: true } : values);
          UI.ok(`Registered — UHID ${patient.uhid}`);
          APP.navigate('patients', { id: patient.id });
        } catch (err) {
          if (err.status === 409) {
            const proceed = await UI.confirm(
              err.message + '\n\nAdd this person to that number anyway?',
              { title: 'This mobile is already on file' });
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
  async function renderRecord(el, id, params = {}) {
    const p = await API.get(`/api/patients/${id}`);
    const isEnquiry = p.stage === 'enquiry';
    APP.setSubtitle(`${p.uhid} · ${p.name}${isEnquiry ? ' · enquiry, not yet registered' : ''}`);
    APP.actions([
      { id: 'back', label: '← All patients', onClick: () => APP.navigate('patients') },
      ...(isEnquiry && APP.can(['reception'])
        ? [{ id: 'convert', label: 'Complete registration', kind: '', onClick: () => openConvert(p) }] : []),
      ...(APP.can(['reception', 'nurse', 'doctor', 'counselor'])
        ? [{ id: 'edit', label: 'Edit details', onClick: () => openEdit(p) }] : []),
      ...(!isEnquiry && APP.can(['reception'])
        ? [{ id: 'arrive', label: 'Record arrival', onClick: () => { APP.navigate('queue'); UI.toast('Use “+ Patient arrived” on the queue board.'); } }] : []),
    ]);

    // Deep link from the dashboard opens the registration form straight away.
    if (isEnquiry && params && params.register === '1' && APP.can(['reception'])) {
      setTimeout(() => openConvert(p), 80);
    }

    el.innerHTML = `
      ${isEnquiry ? `<div class="alert warn">
        <b>This is an enquiry, not a registered patient.</b>
        ${p.enquiry_at ? `First contacted ${UI.esc(UI.dateTime(p.enquiry_at))}.` : ''}
        They cannot be sent through to the clinic queue until the demographic and medical-history
        paperwork is completed. Everything already on file — the enquiry, its source and any
        appointment booked — carries over to the same record.
        ${APP.can(['reception']) ? '<div class="mt"><button class="btn sm" id="banner-convert">Complete registration now</button></div>' : ''}
      </div>` : ''}
      ${p.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(p.allergies)}</div>` : ''}
      ${p.outstanding > 0 ? `<div class="alert warn"><b>Outstanding balance:</b> ${UI.money(p.outstanding)} across unpaid bills.</div>` : ''}

      <div class="grid c4 mb">
        <div class="stat ${isEnquiry ? 'orange' : 'teal'}"><div class="label">UHID</div>
          <div class="value" style="font-size:19px">${UI.esc(p.uhid)}</div>
          <div class="foot">${isEnquiry
            ? 'Enquiry since ' + UI.esc(UI.date(p.enquiry_at || p.registered_at))
            : 'Registered ' + UI.esc(UI.date(p.registered_at))}</div></div>
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
        <button data-tab="chart">Vitals chart</button>
        <button data-tab="visits">Visits</button>
        <button data-tab="clinical">Clinical notes</button>
        <button data-tab="diagnostics">Diagnostics</button>
        <button data-tab="medicines">Medicines</button>
        <button data-tab="ipd">In-patient</button>
        ${p.invoices ? '<button data-tab="billing">Billing</button>' : ''}
        ${/* Means-testing and cashless cover are the counselling and cashless
              desks' business; the clinical tabs above are everyone's. */
          APP.can(['counselor', 'reception', 'cashier', 'ward'])
            ? `<button data-tab="financial">Financial screening</button>
        <button data-tab="insurance">Insurance</button>` : ''}
      </div>
      <div id="ptab-body"></div>`;

    const banner = el.querySelector('#banner-convert');
    if (banner) banner.addEventListener('click', () => openConvert(p));

    const tabs = {
      overview: () => `
        ${isEnquiry ? '' : consentCard(p)}
        <div class="grid c2">
          <div class="card"><div class="card-head"><h3>Personal &amp; contact</h3></div><div class="card-body"><dl class="kv">
            <dt>Full name</dt><dd>${UI.esc([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</dd>
            <dt>Date of birth</dt><dd>${p.dob ? UI.esc(UI.date(p.dob)) : '—'}${p.age_years ? ` · ${UI.esc(p.age_years)} yrs` : ''}</dd>
            <dt>Gender / sex</dt><dd>${UI.esc(UI.titleise(p.gender || '—'))}${p.sex_at_birth
              ? ` · sex at birth ${UI.esc(UI.titleise(p.sex_at_birth))}` : ''}</dd>
            <dt>Phone</dt><dd>${UI.esc(p.phone || '—')}</dd>
            <dt>WhatsApp</dt><dd>${UI.esc(p.whatsapp || '—')}</dd>
            <dt>Email</dt><dd>${UI.esc(p.email || '—')}</dd>
            <dt>Home address</dt><dd>${UI.esc([p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ') || '—')}</dd>
            <dt>Emergency</dt><dd>${UI.esc(p.emergency_name || '—')} ${UI.esc(p.emergency_phone || '')}
              ${p.emergency_relation ? '(' + UI.esc(p.emergency_relation) + ')' : ''}</dd>
            <dt>Photo ID</dt><dd>${UI.esc(p.id_type || '—')} ${UI.esc(p.id_number || '')}</dd>
            <dt>Blood group</dt><dd>${UI.esc(p.blood_group || '—')}</dd>
          </dl></div></div>

          <div class="card"><div class="card-head"><h3>Insurance &amp; billing</h3></div><div class="card-body"><dl class="kv">
            <dt>Cover</dt><dd>${p.is_uninsured ? UI.badge('Uninsured', 'orange') : UI.badge('Insured', 'ok')}</dd>
            <dt>Provider</dt><dd>${UI.esc(p.insurance_provider || '—')}</dd>
            <dt>Policy / member ID</dt><dd>${UI.esc(p.insurance_policy_no || '—')}</dd>
            <dt>Valid until</dt><dd>${p.insurance_valid_till ? UI.esc(UI.date(p.insurance_valid_till)) : '—'}</dd>
            <dt>Billing address</dt><dd>${UI.esc(p.billing_address || p.address || '—')}</dd>
            ${p.outstanding === null || p.outstanding === undefined ? '' : `
              <dt>Outstanding</dt><dd>${p.outstanding > 0
                ? `<b style="color:var(--danger)">${UI.money(p.outstanding)}</b>` : UI.money(0)}</dd>`}
          </dl></div></div>
        </div>

        <div class="grid c2">
          <div class="card"><div class="card-head"><h3>Medical history</h3></div><div class="card-body">
            <dl class="kv">
              <dt>Reason first seen</dt><dd>${UI.esc(p.presenting_complaint || '—')}</dd>
              <dt>Allergies</dt><dd>${p.allergies
                ? `<b style="color:var(--danger)">${UI.esc(p.allergies)}</b>` : 'None recorded'}</dd>
              <dt>Ongoing conditions</dt><dd>${UI.esc(p.chronic_conditions || 'None recorded')}</dd>
              <dt>Current medications</dt><dd>${UI.esc(p.current_medications || 'None recorded')}</dd>
              <dt>Immunisations</dt><dd>${UI.esc(p.immunisations || 'Not recorded')}</dd>
              <dt>Last screening</dt><dd>${p.last_screening_date
                ? UI.esc(UI.date(p.last_screening_date)) : UI.badge('Never', 'warn')}</dd>
            </dl>
            <h4 class="mt mb">Recorded history</h4>
            ${p.history.length ? p.history.map((h) =>
              `<div class="small mb"><b>${UI.esc(UI.titleise(h.kind))}:</b> ${UI.esc(h.detail)}
               <span class="muted">${UI.esc(UI.date(h.recorded_at))}</span></div>`).join('')
              : '<div class="muted small">No history recorded.</div>'}
          </div></div>

          <div class="card"><div class="card-head"><h3>Social history &amp; pharmacy</h3></div><div class="card-body">
            <dl class="kv">
              <dt>Occupation</dt><dd>${UI.esc(p.occupation || '—')}</dd>
              <dt>Smoking</dt><dd>${p.smoking_status
                ? UI.badge(UI.titleise(p.smoking_status), p.smoking_status === 'current' ? 'warn' : '') : '—'}</dd>
              <dt>Alcohol</dt><dd>${p.alcohol_use
                ? UI.badge(UI.titleise(p.alcohol_use), p.alcohol_use === 'regular' ? 'warn' : '') : '—'}</dd>
              <dt>Marital status</dt><dd>${UI.esc(p.marital_status || '—')}</dd>
              <dt>Preferred pharmacy</dt><dd>${UI.esc(p.pharmacy_name || '—')} ${UI.esc(p.pharmacy_phone || '')}</dd>
            </dl>
            <h4 class="mt mb">Latest vital signs</h4>
            ${p.vitals.length ? (() => { const v = p.vitals[0]; return `<dl class="kv">
              <dt>Taken</dt><dd>${UI.esc(UI.dateTime(v.recorded_at))}</dd>
              <dt>BP</dt><dd>${UI.esc(v.bp_systolic || '—')}/${UI.esc(v.bp_diastolic || '—')} mmHg</dd>
              <dt>Heart rate</dt><dd>${UI.esc(v.pulse || '—')} bpm</dd>
              <dt>Temperature</dt><dd>${UI.esc(v.temp_c || '—')} °C</dd>
              <dt>Weight / BMI</dt><dd>${UI.esc(v.weight_kg || '—')} kg / ${UI.esc(v.bmi || '—')}</dd>
            </dl>`; })() : '<div class="muted small">No vital signs recorded yet.</div>'}
          </div></div>
        </div>`,

      /*
       * The dated chart: weight, height, blood pressure and why the patient came
       * that day, newest first. This is the record a clinician flips through to
       * see whether the weight is going up and the pressure is coming down.
       */
      chart: () => {
        const rows = p.vitals || [];
        const withWeight = [...rows].filter((v) => v.weight_kg > 0).reverse();
        const withBp = [...rows].filter((v) => v.bp_systolic > 0).reverse();
        const latest = rows[0] || {};
        const first = rows[rows.length - 1] || {};
        const weightMove = (latest.weight_kg && first.weight_kg && rows.length > 1)
          ? Math.round((latest.weight_kg - first.weight_kg) * 10) / 10 : null;

        return `
          <div class="grid c4 mb">
            <div class="stat teal"><div class="label">Readings on file</div>
              <div class="value">${UI.num(rows.length)}</div>
              <div class="foot">${rows.length ? 'Since ' + UI.esc(UI.date(first.recorded_at)) : 'None yet'}</div></div>
            <div class="stat crimson"><div class="label">Latest blood pressure</div>
              <div class="value">${latest.bp_systolic
                ? `${UI.esc(latest.bp_systolic)}/${UI.esc(latest.bp_diastolic || '—')}` : '—'}</div>
              <div class="foot">${bpNote(latest)}</div></div>
            <div class="stat orange"><div class="label">Latest weight</div>
              <div class="value">${latest.weight_kg ? UI.esc(latest.weight_kg) + ' kg' : '—'}</div>
              <div class="foot">${weightMove === null ? 'No trend yet'
                : `${weightMove > 0 ? '+' : ''}${weightMove} kg since the first reading`}</div></div>
            <div class="stat ok"><div class="label">Latest BMI</div>
              <div class="value">${latest.bmi ? UI.esc(latest.bmi) : '—'}</div>
              <div class="foot">${bmiNote(latest.bmi)}</div></div>
          </div>

          ${withWeight.length > 1 || withBp.length > 1 ? `<div class="grid c2 mb">
            ${withWeight.length > 1 ? `<div class="card"><div class="card-head"><h3>Weight (kg)</h3></div>
              <div class="card-body">${UI.sparkline(withWeight.map((v) => v.weight_kg),
                withWeight.map((v) => UI.date(v.recorded_at)))}</div></div>` : ''}
            ${withBp.length > 1 ? `<div class="card"><div class="card-head"><h3>Systolic pressure (mmHg)</h3></div>
              <div class="card-body">${UI.sparkline(withBp.map((v) => v.bp_systolic),
                withBp.map((v) => UI.date(v.recorded_at)))}</div></div>` : ''}
          </div>` : ''}

          <div class="card"><div class="card-head"><h3>Date by date</h3>
            ${APP.can(['reception', 'nurse', 'doctor'])
              ? '<button class="btn sm" id="add-vitals">+ Record a reading</button>' : ''}</div>
            <div class="card-body tight">${UI.table([
              { label: 'Date', render: (v) => `<b>${UI.esc(UI.date(v.recorded_at))}</b>` +
                `<div class="muted small">${UI.esc(UI.dateTime(v.recorded_at).split(' ').slice(-2).join(' '))}</div>` },
              { label: 'Purpose', render: (v) => UI.esc(v.purpose || '—') +
                (v.visit_no ? `<div class="muted small">${UI.esc(v.visit_no)}${
                  v.doctor_name ? ' · ' + UI.esc(v.doctor_name) : ''}</div>` : '') },
              { label: 'Weight', num: true, render: (v) => v.weight_kg ? UI.esc(v.weight_kg) + ' kg' : '—' },
              { label: 'Height', num: true, render: (v) => v.height_cm ? UI.esc(v.height_cm) + ' cm' : '—' },
              { label: 'BMI', num: true, render: (v) => v.bmi
                ? `<span style="color:${bmiColour(v.bmi)}">${UI.esc(v.bmi)}</span>` : '—' },
              { label: 'BP', num: true, render: (v) => v.bp_systolic
                ? `<span style="color:${bpColour(v)}">${UI.esc(v.bp_systolic)}/${UI.esc(v.bp_diastolic || '—')}</span>` : '—' },
              { label: 'Pulse', num: true, render: (v) => v.pulse ? UI.esc(v.pulse) : '—' },
              { label: 'Temp', num: true, render: (v) => v.temp_c ? UI.esc(v.temp_c) + ' °C' : '—' },
              { label: 'SpO₂', num: true, render: (v) => v.spo2 ? UI.esc(v.spo2) + '%' : '—' },
              { label: 'Sugar', num: true, render: (v) => v.blood_sugar ? UI.esc(v.blood_sugar) : '—' },
              { label: 'By', render: (v) => UI.esc(v.recorded_by_name || '—') +
                (v.amended_by_name ? `<div class="muted small">completed by ${
                  UI.esc(v.amended_by_name)}</div>` : '') },
              /*
               * What is still blank on this reading, and the way to fill it.
               * A gap on a chart is usually a measurement taken a minute later
               * on a machine across the room, not a measurement nobody wants.
               */
              { label: '', render: (v) => {
                const missing = gapsIn(v);
                if (!APP.can(['reception', 'nurse', 'doctor'])) {
                  return missing.length
                    ? `<span class="muted small">${UI.num(missing.length)} not recorded</span>` : '';
                }
                return `<button class="btn ${missing.length ? '' : 'ghost '}sm" data-edit-vitals="${v.id}">${
                  missing.length ? `Fill in ${UI.num(missing.length)}` : 'Edit'}</button>`;
              } },
            ], rows, { emptyText: 'No reading has been taken yet.' })}</div></div>`;
      },

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

      insurance: () => card('Insurance', '<div id="ins-pane">' + UI.loading() + '</div>'),

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
      const addVitals = body.querySelector('#add-vitals');
      if (addVitals) addVitals.addEventListener('click', () => openVitals(p));
      body.querySelectorAll('[data-edit-vitals]').forEach((b) => b.addEventListener('click', () =>
        openVitals(p, p.vitals.find((v) => v.id === Number(b.dataset.editVitals)))));
      el.querySelectorAll('#ptabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (name === 'visits') UI.bindRows(body, p.visits, (v) => APP.openVisit(v.id));
      if (name === 'billing') UI.bindRows(body, p.invoices, (i) => APP.openInvoice(i.id));
      if (name === 'ipd') UI.bindRows(body, p.admissions, (a) => APP.navigate('ipd', { admissionId: a.id }));
      if (name === 'insurance') loadInsurancePane(p);
    };
    el.querySelectorAll('#ptabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show('overview');
  }

  /** Policies, pre-auths and claims for this patient, loaded on demand. */
  async function loadInsurancePane(patient) {
    const host = document.getElementById('ins-pane');
    if (!host) return;
    try {
      const ins = await API.get(`/api/insurance/patient/${patient.id}`);
      host.innerHTML = `
        <div class="card-body">
          <div class="row-between mb"><h4>Policies</h4>
            ${APP.can(['cashier', 'reception', 'counselor'])
              ? '<button class="btn ghost sm" id="add-policy">+ Add policy</button>' : ''}</div>
          ${ins.policies.length ? UI.table([
            { label: 'Insurer', render: (x) => `<b>${UI.esc(x.insurer_name)}</b> ${UI.badge(UI.titleise(x.insurer_kind), 'teal')}` },
            { label: 'Policy no.', render: (x) => `<code>${UI.esc(x.policy_no)}</code>` },
            { label: 'Sum insured', num: true, render: (x) => UI.money(x.sum_insured) },
            { label: 'Balance', num: true, render: (x) => UI.money(x.balance) },
            { label: 'Co-pay', num: true, render: (x) => `${UI.esc(x.copay_pct)}%` },
            { label: 'Valid to', render: (x) => UI.esc(x.valid_to ? UI.date(x.valid_to) : '—') },
            { label: 'Status', render: (x) => UI.statusBadge(x.status) },
          ], ins.policies) : UI.empty('No policy on file — this patient is treated as uninsured.', '🛡')}

          <h4 class="mt mb">Pre-authorisations</h4>
          ${UI.table([
            { label: 'Ref', render: (x) => `<code>${UI.esc(x.preauth_no)}</code>` },
            { label: 'Insurer', render: (x) => UI.esc(x.insurer_name) },
            { label: 'Diagnosis', render: (x) => UI.esc(x.diagnosis || '—') },
            { label: 'Requested', num: true, render: (x) => UI.money(x.requested_amount) },
            { label: 'Approved', num: true, render: (x) => UI.money(x.approved_amount) },
            { label: 'Status', render: (x) => UI.statusBadge(x.status) },
          ], ins.preauths, { emptyText: 'No pre-authorisation raised.' })}

          <h4 class="mt mb">Claims</h4>
          ${UI.table([
            { label: 'Claim', render: (x) => `<code>${UI.esc(x.claim_no)}</code>` },
            { label: 'Insurer', render: (x) => UI.esc(x.insurer_name) },
            { label: 'Bill', render: (x) => UI.esc(x.invoice_no || '—') },
            { label: 'Claimed', num: true, render: (x) => UI.money(x.claimed_amount) },
            { label: 'Approved', num: true, render: (x) => UI.money(x.approved_amount) },
            { label: 'Received', num: true, render: (x) => UI.money(x.settled_amount) },
            { label: 'Status', render: (x) => UI.statusBadge(x.status) },
          ], ins.claims, { emptyText: 'No claim raised.' })}
        </div>`;

      const add = host.querySelector('#add-policy');
      if (add) add.addEventListener('click', () => APP.openPolicyForm(patient, () => loadInsurancePane(patient)));

      const tables = host.querySelectorAll('.table-wrap');
      if (tables[1]) UI.bindRows(tables[1], ins.preauths, (x) => APP.openPreauth(x.id, () => loadInsurancePane(patient)));
      if (tables[2]) UI.bindRows(tables[2], ins.claims, (x) => APP.openClaim(x.id, () => loadInsurancePane(patient)));
    } catch (err) {
      host.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`;
    }
  }

  /** Consent is a legal record, so it is shown plainly with who signed and when. */
  function consentCard(p) {
    const yes = (on) => on ? UI.badge('Given', 'ok') : UI.badge('Not given', 'warn');
    if (!p.consent_treatment) {
      return `<div class="alert danger"><b>No treatment consent on file.</b>
        This record predates the consent requirement, or was imported. Capture it via
        <b>Edit details</b> before the next visit.</div>`;
    }
    return `<div class="card"><div class="card-head"><h3>Consent</h3>
        <span class="muted small">Signed by ${UI.esc(p.consent_signed_by || '—')}
          on ${UI.esc(UI.dateTime(p.consent_signed_at))}</span></div>
      <div class="card-body"><div class="grid c3">
        <div><b>Treatment</b><div>${yes(p.consent_treatment)}</div></div>
        <div><b>Privacy notice</b><div>${yes(p.consent_privacy)}</div></div>
        <div><b>Contact by message</b><div>${yes(p.consent_contact)}</div></div>
      </div></div></div>`;
  }

  /**
   * "They enquired, and now they have walked in." Same paperwork as a fresh
   * registration, pre-filled with whatever the enquiry already captured.
   */
  function openConvert(p) {
    UI.modal({
      title: `Complete registration — ${p.first_name} ${p.last_name || ''}`,
      size: 'wide',
      body: `<div class="alert info">
          This promotes the existing enquiry record (<b>${UI.esc(p.uhid)}</b>) to a registered patient.
          The UHID, the enquiry history and any appointment already booked all stay attached.
        </div>
        <form id="conv-form">${registrationFields(p)}</form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Register patient</button>`,
      onMount(modal) { wireCoverFields(modal); },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#conv-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post(`/api/patients/${p.id}/register`, collectRegistration(form));
        UI.ok(res.message);
        APP.reload();
      },
    });
  }

  function openEdit(p) {
    UI.modal({
      title: 'Edit — ' + p.name,
      size: 'wide',
      body: `<form id="ed-form">
        <div class="tabs" id="ed-tabs">
          <button type="button" class="active" data-ed="quick">Quick edit</button>
          <button type="button" data-ed="full">Full record</button>
        </div>
        <div id="ed-quick">
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
        </div>
        <div id="ed-full" hidden>
          <div class="grid c3">
            ${UI.field({ name: 'sexAtBirth', label: 'Sex at birth', value: p.sex_at_birth || '',
              options: [{ value: '', label: '— select —' }, { value: 'male', label: 'Male' },
                        { value: 'female', label: 'Female' }, { value: 'intersex', label: 'Intersex' }] })}
            ${UI.field({ name: 'smokingStatus', label: 'Smoking', value: p.smoking_status || '',
              options: [{ value: '', label: '— not asked —' }, { value: 'never', label: 'Never' },
                        { value: 'former', label: 'Former' }, { value: 'current', label: 'Current' },
                        { value: 'unknown', label: 'Unknown' }] })}
            ${UI.field({ name: 'alcoholUse', label: 'Alcohol', value: p.alcohol_use || '',
              options: [{ value: '', label: '— not asked —' }, { value: 'never', label: 'Never' },
                        { value: 'occasional', label: 'Occasional' }, { value: 'regular', label: 'Regular' },
                        { value: 'former', label: 'Former' }, { value: 'unknown', label: 'Unknown' }] })}
          </div>
          ${UI.field({ name: 'currentMedications', label: 'Current medications', type: 'textarea', rows: 2,
            value: p.current_medications || '' })}
          ${UI.field({ name: 'immunisations', label: 'Immunisation history', type: 'textarea', rows: 2,
            value: p.immunisations || '' })}
          ${UI.field({ name: 'billingAddress', label: 'Billing address', type: 'textarea', rows: 2,
            value: p.billing_address || '' })}
          <div class="grid c2">
            ${UI.field({ name: 'occupation', label: 'Occupation', value: p.occupation || '' })}
            ${UI.field({ name: 'idNumber', label: 'Photo ID number', value: p.id_number || '' })}
          </div>
          <fieldset><legend>Consent</legend>
            ${p.consent_treatment
              ? `<div class="muted small mb">Signed by ${UI.esc(p.consent_signed_by || '—')} on
                   ${UI.esc(UI.dateTime(p.consent_signed_at))}.</div>`
              : '<div class="alert warn">No treatment consent on file — capture it now.</div>'}
            ${UI.checkbox({ name: 'consentTreatment', label: 'Consent to treatment', checked: !!p.consent_treatment })}
            ${UI.checkbox({ name: 'consentPrivacy', label: 'Privacy notice given', checked: !!p.consent_privacy })}
            ${UI.checkbox({ name: 'consentContact', label: 'Agrees to reminders by message', checked: !!p.consent_contact })}
            ${UI.field({ name: 'consentSignedBy', label: 'Signed by', value: p.consent_signed_by || '' })}
          </fieldset>
        </div>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save changes</button>`,
      onMount(modal) {
        modal.querySelectorAll('#ed-tabs button').forEach((b) => b.addEventListener('click', () => {
          modal.querySelectorAll('#ed-tabs button').forEach((x) => x.classList.toggle('active', x === b));
          modal.querySelector('#ed-quick').hidden = b.dataset.ed !== 'quick';
          modal.querySelector('#ed-full').hidden = b.dataset.ed !== 'full';
        }));
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        await API.patch(`/api/patients/${p.id}`, UI.formValues(modal.querySelector('#ed-form')));
        UI.ok('Patient record updated.');
        APP.reload();
      },
    });
  }

  // ------------------------------------------------------- reading helpers
  /*
   * Plain clinical ranges, so a number on the chart says what it means without
   * anyone having to remember the thresholds. These are the ordinary adult
   * cut-offs; they are a prompt to look, never a diagnosis.
   */
  function bpColour(v) {
    if (!v || !v.bp_systolic) return 'inherit';
    if (v.bp_systolic >= 140 || v.bp_diastolic >= 90) return 'var(--danger)';
    if (v.bp_systolic >= 130 || v.bp_diastolic >= 85) return 'var(--warn)';
    if (v.bp_systolic < 90) return 'var(--warn)';
    return 'var(--ok)';
  }

  function bpNote(v) {
    if (!v || !v.bp_systolic) return 'Not recorded';
    if (v.bp_systolic >= 140 || v.bp_diastolic >= 90) return 'Hypertensive range — review';
    if (v.bp_systolic >= 130 || v.bp_diastolic >= 85) return 'Raised — keep watching';
    if (v.bp_systolic < 90) return 'Low';
    return 'Within range';
  }

  function bmiColour(bmi) {
    if (!bmi) return 'inherit';
    if (bmi >= 30 || bmi < 16) return 'var(--danger)';
    if (bmi >= 25 || bmi < 18.5) return 'var(--warn)';
    return 'var(--ok)';
  }

  function bmiNote(bmi) {
    if (!bmi) return 'Height and weight needed';
    if (bmi < 18.5) return 'Underweight';
    if (bmi < 25) return 'Healthy range';
    if (bmi < 30) return 'Overweight';
    return 'Obese range';
  }

  /** The measurements a reading can carry, and what each is called on screen. */
  const VITAL_FIELDS = [
    ['weightKg', 'weight_kg', 'Weight'], ['heightCm', 'height_cm', 'Height'],
    ['tempC', 'temp_c', 'Temperature'], ['bpSystolic', 'bp_systolic', 'BP systolic'],
    ['bpDiastolic', 'bp_diastolic', 'BP diastolic'], ['pulse', 'pulse', 'Pulse'],
    ['spo2', 'spo2', 'SpO₂'], ['respRate', 'resp_rate', 'Respiratory rate'],
    ['bloodSugar', 'blood_sugar', 'Blood sugar'],
  ];

  /** What was not taken on a given reading. */
  function gapsIn(v) {
    return VITAL_FIELDS
      .filter(([, column]) => v[column] === null || v[column] === undefined || v[column] === '')
      .map(([, , label]) => label);
  }

  /**
   * A dated reading — the weight, height, pressure and why they came.
   *
   * The same form takes a new reading and finishes an old one. A nurse takes
   * what the patient will stand still for; the cuff, the oximeter and the
   * sugar often come minutes later, and the chart should not be stuck with the
   * gap because the moment passed. Pass a reading and its boxes come up filled,
   * with the empty ones marked.
   */
  function openVitals(patient, existing = null) {
    const val = (column) => (existing && existing[column] !== null
      && existing[column] !== undefined ? existing[column] : '');
    const missing = existing ? gapsIn(existing) : [];
    const box = (name, column, label, opts = {}) => UI.field({
      name, label, type: 'number', value: val(column),
      ...opts,
      hint: opts.hint || (existing && missing.includes(label) ? 'Not recorded yet' : ''),
    });

    UI.modal({
      title: existing
        ? `${missing.length ? 'Complete' : 'Edit'} the reading of ${UI.date(existing.recorded_at)} — ${
          patient.first_name} ${patient.last_name || ''}`.trim()
        : `Record a reading — ${patient.first_name} ${patient.last_name || ''}`.trim(),
      body: `${existing ? `<div class="alert ${missing.length ? 'info' : 'ok'}">
          Taken by <b>${UI.esc(existing.recorded_by_name || 'somebody')}</b> on
          ${UI.esc(UI.dateTime(existing.recorded_at))}.
          ${missing.length
            ? `Still blank: <b>${UI.esc(missing.join(', '))}</b>. Fill in what you have — the rest is left as it is.`
            : 'Everything was recorded. Change a figure only to correct it.'}
        </div>` : ''}
        <form id="vt-form">
          ${UI.field({ name: 'purpose', label: 'Purpose of the visit', required: true,
            value: existing ? existing.purpose || '' : '',
            placeholder: 'BP check, weight review, fever, follow-up…' })}
          <div class="grid c3">
            ${box('weightKg', 'weight_kg', 'Weight', { label: 'Weight (kg)', step: '0.1' })}
            ${box('heightCm', 'height_cm', 'Height', { label: 'Height (cm)', step: '0.1',
              hint: existing ? '' : 'Blank keeps the last height on file' })}
            ${box('tempC', 'temp_c', 'Temperature', { label: 'Temperature (°C)', step: '0.1' })}
          </div>
          <div class="grid c3">
            ${box('bpSystolic', 'bp_systolic', 'BP systolic', { label: 'BP systolic', placeholder: '120' })}
            ${box('bpDiastolic', 'bp_diastolic', 'BP diastolic', { label: 'BP diastolic', placeholder: '80' })}
            ${box('pulse', 'pulse', 'Pulse', { label: 'Pulse (bpm)' })}
          </div>
          <div class="grid c3">
            ${box('spo2', 'spo2', 'SpO₂', { label: 'SpO₂ (%)', min: 0, max: 100 })}
            ${box('respRate', 'resp_rate', 'Respiratory rate', { label: 'Respiratory rate' })}
            ${box('bloodSugar', 'blood_sugar', 'Blood sugar', { label: 'Blood sugar (mg/dL)', step: '0.1' })}
          </div>
          ${UI.field({ name: 'notes', label: 'Notes', rows: 2,
            value: existing ? existing.notes || '' : '' })}
        </form>
        <div id="vt-read"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${
                 existing ? 'Save the reading' : 'Save the reading'}</button>`,
      onMount(modal) {
        // Say what the numbers mean as they are typed, so an out-of-range
        // reading is noticed at the desk rather than a week later.
        const read = () => {
          const v = UI.formValues(modal.querySelector('#vt-form'));
          const sys = Number(v.bpSystolic) || 0;
          const dia = Number(v.bpDiastolic) || 0;
          const w = Number(v.weightKg) || 0;
          const h = Number(v.heightCm) || 0;
          const bmi = w > 0 && h > 0 ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : null;
          const notes = [];
          if (sys) notes.push(`BP ${sys}/${dia || '—'} — ${bpNote({ bp_systolic: sys, bp_diastolic: dia })}`);
          if (bmi) notes.push(`BMI ${bmi} — ${bmiNote(bmi)}`);
          if (Number(v.tempC) >= 38) notes.push('Febrile');
          if (Number(v.spo2) && Number(v.spo2) < 94) notes.push('Low oxygen saturation');
          modal.querySelector('#vt-read').innerHTML = notes.length
            ? `<div class="alert ${/Hypertensive|Low oxygen|Obese|Febrile/.test(notes.join(' ')) ? 'warn' : 'ok'} mt">
                 ${notes.map((n) => UI.esc(n)).join(' · ')}</div>` : '';
        };
        modal.querySelectorAll('#vt-form input').forEach((i) => i.addEventListener('input', read));
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#vt-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (existing) {
          // Every box is sent, filled or not: an emptied one is a figure the
          // nurse is taking back out, and the server treats it that way.
          await API.patch(`/api/patients/${patient.id}/vitals/${existing.id}`, values);
          UI.ok('Reading updated on the chart.');
        } else {
          await API.post(`/api/patients/${patient.id}/vitals`, values);
          UI.ok('Reading saved to the chart.');
        }
        APP.reload();
      },
    });
  }
})();
