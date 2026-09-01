/* Staff & doctors — the administrator's directory, OPD sessions and leave. */
(function () {
  'use strict';

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const ROLES = [
    { value: 'doctor', label: 'Doctor — consults, prescribes, orders' },
    { value: 'reception', label: 'Front desk — enquiries, registration, check-in' },
    { value: 'nurse', label: 'Nurse / M.A. — vitals, ward care' },
    { value: 'counselor', label: 'Financial counselor — screening, assistance' },
    { value: 'lab', label: 'Lab technician — samples, results' },
    { value: 'pharmacy', label: 'Pharmacist — dispensing, stock' },
    { value: 'cashier', label: 'Cashier — billing, payments, insurance' },
    { value: 'ward', label: 'Ward sister — beds, admissions, rounds' },
    { value: 'admin', label: 'Administrator — full access' },
  ];

  APP.register('staff', {
    title: 'Staff & Doctors',
    subtitle: 'Add doctors, set their OPD sessions and manage access',

    async render(el, params) {
      if (params.id) return renderStaffMember(el, Number(params.id));

      APP.actions([
        { id: 'doctor', label: '+ Add doctor', kind: '', onClick: () => openStaffForm('doctor') },
        { id: 'staff', label: '+ Add other staff', onClick: () => openStaffForm(null) },
      ]);

      const [staff, departments] = await Promise.all([
        API.get('/api/masters/staff'),
        API.get('/api/masters/departments'),
      ]);
      const doctors = staff.filter((s) => s.role === 'doctor');
      const others = staff.filter((s) => s.role !== 'doctor');

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">Doctors</div>
            <div class="value">${UI.num(doctors.filter((d) => d.active).length)}</div>
            <div class="foot">${UI.num(doctors.filter((d) => !d.active).length)} disabled</div></div>
          <div class="stat teal"><div class="label">Other staff</div>
            <div class="value">${UI.num(others.filter((d) => d.active).length)}</div>
            <div class="foot">Across ${UI.num(new Set(others.map((o) => o.role)).size)} role(s)</div></div>
          <div class="stat orange"><div class="label">Specialist departments</div>
            <div class="value">${UI.num(departments.filter((d) => d.kind === 'specialist').length)}</div>
            <div class="foot">${UI.num(departments.filter((d) => d.kind === 'specialist' && !d.doctor_count).length)} with no doctor</div></div>
          <div class="stat ok"><div class="label">Total accounts</div>
            <div class="value">${UI.num(staff.length)}</div></div>
        </div>

        <div class="tabs" id="s-tabs">
          <button class="active" data-tab="doctors">Doctors</button>
          <button data-tab="staff">Other staff</button>
          <button data-tab="departments">Departments</button>
        </div>
        <div id="s-body"></div>`;

      const body = el.querySelector('#s-body');
      const tabs = {
        doctors() {
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Consulting doctors</h3>
              <span class="muted small">Open one to set OPD sessions and leave</span></div>
            <div class="card-body tight" id="d-list"></div></div>`;
          const host = body.querySelector('#d-list');
          host.innerHTML = UI.table([
            { label: 'Doctor', render: (d) => `<b>${UI.esc(d.name)}</b>` +
              `<div class="muted small">${UI.esc(d.qualification || '')}</div>` },
            { label: 'Code', render: (d) => d.doctor_code
              ? `<code>${UI.esc(d.doctor_code)}</code>` : '<span class="muted">—</span>' },
            { label: 'Department', render: (d) => UI.esc(d.department_name || '—') },
            { label: 'Speciality', render: (d) => UI.esc(d.specialization || '—') },
            { label: 'Room', render: (d) => UI.esc(d.room_no || '—') },
            { label: 'New', num: true, render: (d) => UI.money(d.consult_fee || 0) },
            { label: 'Follow-up', num: true, render: (d) => UI.money(d.follow_up_fee || 0) },
            { label: 'Slot', num: true, render: (d) => `${UI.esc(d.slot_minutes || 15)} min` },
            { label: 'Status', render: (d) => d.active ? UI.badge('Active', 'ok') : UI.badge('Disabled', 'danger') },
          ], doctors, { emptyText: 'No doctors yet — add the first one.' });
          UI.bindRows(host, doctors, (d) => APP.navigate('staff', { id: d.id }));
        },

        staff() {
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Other staff</h3></div>
            <div class="card-body tight" id="o-list"></div></div>`;
          const host = body.querySelector('#o-list');
          host.innerHTML = UI.table([
            { label: 'Name', render: (u) => `<b>${UI.esc(u.name)}</b>` +
              `<div class="muted small">${UI.esc(u.staff_code)}</div>` },
            { label: 'Role', render: (u) => UI.badge(UI.titleise(u.role), 'teal') },
            { label: 'Department', render: (u) => UI.esc(u.department_name || '—') },
            { label: 'Email', render: (u) => UI.esc(u.email || '—') },
            { label: 'Phone', render: (u) => UI.esc(u.phone || '—') },
            { label: 'Status', render: (u) => u.active ? UI.badge('Active', 'ok') : UI.badge('Disabled', 'danger') },
          ], others, { emptyText: 'No other staff accounts.' });
          UI.bindRows(host, others, (u) => APP.navigate('staff', { id: u.id }));
        },

        departments() {
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Departments</h3>
              ${APP.can(['admin']) ? '<button class="btn ghost sm" id="add-dept">+ Add department</button>' : ''}</div>
            <div class="card-body tight">${UI.table([
              { label: 'Name', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.code)}</div>` },
              { label: 'Type', render: (d) => UI.badge(
                d.kind === 'specialist' ? 'Specialist' : 'Diagnostic', d.kind === 'specialist' ? 'crimson' : 'teal') },
              { label: 'Doctors', num: true, render: (d) => d.kind === 'specialist'
                ? (d.doctor_count ? UI.esc(d.doctor_count) : '<span style="color:var(--danger)">0</span>') : '—' },
              { label: 'Bookable', render: (d) => d.kind === 'specialist' && d.doctor_count
                ? UI.badge('Yes', 'ok') : UI.badge('No', '') },
            ], departments)}</div></div>
            <div class="muted small mt">Only specialist departments with at least one doctor take consultations
              and appear in the WhatsApp booking menu.</div>`;
          const add = body.querySelector('#add-dept');
          if (add) add.addEventListener('click', openDepartmentForm);
        },
      };

      el.querySelectorAll('#s-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#s-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab]();
      }));
      tabs.doctors();
    },
  });

  // ------------------------------------------------------------ add / edit
  async function openStaffForm(fixedRole, existing) {
    const departments = await API.get('/api/masters/departments');
    const isDoctor = existing ? existing.role === 'doctor' : fixedRole === 'doctor';
    const editing = Boolean(existing);

    UI.modal({
      title: editing ? `Edit — ${existing.name}` : (isDoctor ? 'Add a doctor' : 'Add a staff member'),
      size: 'wide',
      body: `<form id="sf-form">
        <fieldset><legend>Person</legend>
          <div class="grid c2">
            ${UI.field({ name: 'name', label: 'Full name', required: true,
              value: existing ? existing.name : '', placeholder: isDoctor ? 'Dr. Firstname Lastname' : '' })}
            ${UI.field({ name: 'role', label: 'Role', required: true, disabled: editing,
              value: existing ? existing.role : (fixedRole || ''),
              options: (fixedRole ? ROLES.filter((r) => r.value === fixedRole) : ROLES) })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'email', label: 'Email', type: 'email', value: existing ? existing.email || '' : '',
              hint: 'Used to sign in and to receive password resets' })}
            ${UI.field({ name: 'phone', label: 'Mobile', value: existing ? existing.phone || '' : '' })}
            ${UI.field({ name: 'departmentId', label: 'Department',
              value: existing ? existing.department_id || '' : '',
              options: [{ value: '', label: '— none —' }].concat(departments.map((d) =>
                ({ value: d.id, label: `${d.name} (${d.kind === 'specialist' ? 'specialist' : 'diagnostic'})` }))) })}
          </div>
        </fieldset>

        <fieldset id="doc-fields"${isDoctor ? '' : ' hidden'}><legend>Doctor details</legend>
          <div class="grid c3">
            ${UI.field({ name: 'qualification', label: 'Qualification',
              value: existing ? existing.qualification || '' : '', placeholder: 'MBBS, MD (General Medicine)' })}
            ${UI.field({ name: 'specialization', label: 'Speciality',
              value: existing ? existing.specialization || '' : '', placeholder: 'Diabetes & thyroid' })}
            ${UI.field({ name: 'regNo', label: 'Medical council reg. no.',
              value: existing ? existing.reg_no || '' : '' })}
            ${UI.field({ name: 'doctorCode', label: 'Doctor code',
              value: existing ? existing.doctor_code || '' : '',
              placeholder: 'SPC-MHD-002',
              hint: 'Clinic · name · joining number. Blank generates one. Printed on every '
                + 'prescription and report, so change it only before the first is issued.' })}
          </div>
          <div class="grid c4">
            ${UI.field({ name: 'consultFee', label: 'New consultation fee', type: 'number', step: '0.01',
              value: existing ? existing.consult_fee || 0 : 500 })}
            ${UI.field({ name: 'followUpFee', label: 'Follow-up fee', type: 'number', step: '0.01',
              value: existing ? existing.follow_up_fee || 0 : 300 })}
            ${UI.field({ name: 'slotMinutes', label: 'Minutes per patient', type: 'number', min: 5, max: 120,
              value: existing ? existing.slot_minutes || 15 : 15,
              hint: 'Decides how many slots a session holds' })}
            ${UI.field({ name: 'roomNo', label: 'Consulting room',
              value: existing ? existing.room_no || '' : '' })}
          </div>
        </fieldset>

        <fieldset><legend>Access</legend>
          ${editing
            ? `${UI.checkbox({ name: 'active', label: 'Account is active (unticking blocks sign-in)', checked: !!existing.active })}
               <div class="muted small">To change the password, use <b>Account &amp; System → Staff access</b>
                 and send a reset link — nobody else needs to know it.</div>`
            : UI.password({ name: 'password', label: 'Temporary password', required: true,
                autocomplete: 'new-password', meter: true,
                hint: 'At least 8 characters with a letter and a number. Ask them to change it after the first sign-in.' })}
        </fieldset>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${editing ? 'Save changes' : 'Create account'}</button>`,
      onMount(modal) {
        UI.wirePasswords(modal);
        const role = modal.querySelector('[name=role]');
        if (role && !editing) {
          role.addEventListener('change', () => {
            modal.querySelector('#doc-fields').hidden = role.value !== 'doctor';
          });
        }
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#sf-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (editing) values.role = existing.role;   // the select is disabled, so re-attach it

        if (editing) {
          await API.patch(`/api/masters/staff/${existing.id}`, values);
          UI.ok('Saved.');
          APP.reload();
        } else {
          const created = await API.post('/api/masters/staff', values);
          UI.ok(`${values.name} added — staff code ${created.staffCode}.`);
          if (values.role === 'doctor') {
            UI.warn('Now set their OPD sessions, or they will have no bookable slots.');
            APP.navigate('staff', { id: created.id });
          } else {
            APP.reload();
          }
        }
      },
    });
  }

  /**
   * Fixing when a doctor actually sits. One date, or the same window repeated
   * across a range — "Tuesdays and Fridays, 6 to 8, for the next month" is one
   * entry, not twelve.
   */
  function openAvailability(doctor, onDone) {
    const today = UI.today();
    const monthOut = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    UI.modal({
      title: `Visiting hours — ${doctor.name}`,
      size: 'wide',
      body: `
        <div class="tabs" id="av-mode">
          <button class="active" data-mode="single">One day</button>
          <button data-mode="repeat">Repeat over a range</button>
        </div>

        <form id="av-form">
          <div id="av-single">
            ${UI.field({ name: 'date', label: 'Date', type: 'date', value: today, required: true })}
          </div>

          <div id="av-repeat" hidden>
            <div class="grid c2">
              ${UI.field({ name: 'from', label: 'From', type: 'date', value: today })}
              ${UI.field({ name: 'to', label: 'To', type: 'date', value: monthOut })}
            </div>
            <label class="field"><span>Days of the week</span></label>
            <div class="btn-row" id="av-days">
              ${DAYS.map((d, i) => `<button type="button" class="btn ghost sm" data-wd="${i}">${d.slice(0, 3)}</button>`).join('')}
            </div>
            <div class="muted small">Pick none to fix every day in the range.</div>
          </div>

          <div class="grid c4 mt">
            ${UI.field({ name: 'startTime', label: 'Starts at', type: 'time', value: '18:00', required: true })}
            ${UI.field({ name: 'endTime', label: 'Ends at', type: 'time', value: '20:00', required: true })}
            ${UI.field({ name: 'slotMinutes', label: 'Minutes per patient', type: 'number', min: 5, max: 120,
              value: doctor.slot_minutes || 15 })}
            ${UI.field({ name: 'maxTokens', label: 'Maximum patients', type: 'number', min: 0, value: 0,
              hint: '0 = as many as the hours hold' })}
          </div>
          ${UI.field({ name: 'note', label: 'Note', placeholder: 'Evening OPD, camp day…' })}
        </form>
        <div id="av-preview" class="alert ok"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Fix these hours</button>`,
      onMount(modal) {
        const weekdays = new Set();
        let mode = 'single';

        modal.querySelectorAll('#av-mode button').forEach((b) => b.addEventListener('click', () => {
          mode = b.dataset.mode;
          modal.querySelectorAll('#av-mode button').forEach((x) => x.classList.toggle('active', x === b));
          modal.querySelector('#av-single').hidden = mode !== 'single';
          modal.querySelector('#av-repeat').hidden = mode !== 'repeat';
          modal.querySelector('[name=date]').required = mode === 'single';
          preview();
        }));

        modal.querySelectorAll('#av-days [data-wd]').forEach((b) => b.addEventListener('click', () => {
          const wd = Number(b.dataset.wd);
          if (weekdays.has(wd)) weekdays.delete(wd); else weekdays.add(wd);
          b.classList.toggle('teal', weekdays.has(wd));
          preview();
        }));

        /** Say up front how many patients these hours will hold. */
        const preview = () => {
          const v = UI.formValues(modal.querySelector('#av-form'));
          const mins = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (h * 60) + (m || 0); };
          const span = mins(v.endTime) - mins(v.startTime);
          const step = Number(v.slotMinutes) || 15;
          const host = modal.querySelector('#av-preview');
          if (!(span > 0)) {
            host.className = 'alert danger';
            host.innerHTML = 'The end time must be after the start time.';
            return;
          }
          let fits = Math.floor(span / step);
          if (Number(v.maxTokens) > 0) fits = Math.min(fits, Number(v.maxTokens));
          const hours = (span / 60).toFixed(span % 60 ? 1 : 0);
          let days = 1;
          if (mode === 'repeat' && v.from && v.to) {
            days = 0;
            for (let d = new Date(v.from + 'T00:00:00'); d <= new Date(v.to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
              if (weekdays.size && !weekdays.has(d.getDay())) continue;
              days += 1;
            }
          }
          host.className = 'alert ok';
          host.innerHTML = `<b>${hours} hour(s)</b> per day — room for <b>${fits}</b> patient(s) each day` +
            (mode === 'repeat' ? ` across <b>${days}</b> day(s), <b>${fits * days}</b> appointments in all.` : '.');
        };

        modal.querySelectorAll('#av-form input, #av-form select')
          .forEach((i) => i.addEventListener('input', preview));
        preview();
        modal.__avail = { getWeekdays: () => [...weekdays], getMode: () => mode };
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#av-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        const { getWeekdays, getMode } = modal.__avail;

        const payload = {
          startTime: v.startTime, endTime: v.endTime,
          slotMinutes: v.slotMinutes, maxTokens: v.maxTokens, note: v.note,
        };
        if (getMode() === 'single') payload.date = v.date;
        else Object.assign(payload, { from: v.from, to: v.to, weekdays: getWeekdays() });

        const res = await API.post(`/api/masters/doctors/${doctor.id}/availability`, payload);
        UI.ok(`${res.added} visiting day(s) fixed.`);
        if (res.skipped.length) {
          UI.warn(`${res.skipped.length} day(s) skipped — hours already set: ` +
            res.skipped.slice(0, 3).map((x) => x.date).join(', ') + (res.skipped.length > 3 ? '…' : ''));
        }
        if (onDone) onDone();
      },
    });
  }

  function openDepartmentForm() {
    UI.modal({
      title: 'Add a department', size: 'narrow',
      body: `<form id="dp-form">
        ${UI.field({ name: 'code', label: 'Short code', required: true, placeholder: 'e.g. NEU' })}
        ${UI.field({ name: 'name', label: 'Name', required: true, placeholder: 'e.g. Neurology' })}
        ${UI.field({ name: 'kind', label: 'Type', value: 'specialist',
          options: [{ value: 'specialist', label: 'Specialist — takes consultations' },
                    { value: 'diagnostic', label: 'Diagnostic — a service counter' }] })}
        ${UI.field({ name: 'sortOrder', label: 'Order on the board', type: 'number', value: 50 })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Add department</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#dp-form');
        if (!form.reportValidity()) return 'keep';
        await API.post('/api/masters/departments', UI.formValues(form));
        UI.ok('Department added.');
        APP.reload();
      },
    });
  }

  // ---------------------------------------------------------- one staff member
  async function renderStaffMember(el, id) {
    const u = await API.get(`/api/masters/staff/${id}`);
    const isDoctor = u.role === 'doctor';
    APP.setSubtitle(`${u.name} · ${UI.titleise(u.role)}${u.department_name ? ' · ' + u.department_name : ''}`);
    APP.actions([
      { id: 'back', label: '← Staff list', onClick: () => APP.navigate('staff') },
      { id: 'edit', label: 'Edit details', onClick: () => openStaffForm(null, u) },
    ]);

    el.innerHTML = `
      ${u.active ? '' : '<div class="alert danger"><b>This account is disabled</b> — they cannot sign in, and a doctor will not appear for booking.</div>'}
      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>Details</h3></div>
            <div class="card-body"><dl class="kv">
              <dt>Name</dt><dd>${UI.esc(u.name)}</dd>
              <dt>Staff code</dt><dd><code>${UI.esc(u.staff_code)}</code></dd>
              ${isDoctor ? `<dt>Doctor code</dt><dd><code>${UI.esc(u.doctor_code || '—')}</code>
                <div class="muted small">The only thing that identifies this doctor on a printed
                  prescription or report. Patients cannot read a name from it.</div></dd>` : ''}
              <dt>Role</dt><dd>${UI.badge(UI.titleise(u.role), 'teal')}</dd>
              <dt>Department</dt><dd>${UI.esc(u.department_name || '—')}</dd>
              <dt>Email</dt><dd>${UI.esc(u.email || '—')}</dd>
              <dt>Phone</dt><dd>${UI.esc(u.phone || '—')}</dd>
              ${isDoctor ? `
                <dt>Qualification</dt><dd>${UI.esc(u.qualification || '—')}</dd>
                <dt>Speciality</dt><dd>${UI.esc(u.specialization || '—')}</dd>
                <dt>Reg. no.</dt><dd>${UI.esc(u.reg_no || '—')}</dd>
                <dt>Room</dt><dd>${UI.esc(u.room_no || '—')}</dd>
                <dt>Consultation</dt><dd>${UI.money(u.consult_fee || 0)} new · ${UI.money(u.follow_up_fee || 0)} follow-up</dd>
                <dt>Slot length</dt><dd>${UI.esc(u.slot_minutes || 15)} minutes</dd>` : ''}
              <dt>Last signed in</dt><dd>${u.last_login_at ? UI.esc(UI.dateTime(u.last_login_at)) : 'never'}</dd>
            </dl></div>
          </div>

          ${isDoctor ? `<div class="card">
            <div class="card-head"><h3>Visiting hours</h3>
              <span class="muted small">Fixed dates — what the appointment screen actually offers</span>
              <button class="btn sm" id="add-avail">+ Fix visiting hours</button></div>
            <div class="card-body">
              <p class="muted small">Our consultants sit for two or three hours on agreed days. A window set
                here <b>replaces</b> the weekly rota below for that date, so the front desk and the WhatsApp
                bot offer exactly these times and no more.</p>
              <div id="avail-list">${UI.loading()}</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Weekly rota</h3>
              <span class="muted small">Fallback for any date with no fixed hours</span>
              <button class="btn ghost sm" id="add-session">+ Add a session</button></div>
            <div class="card-body">
              ${(u.sessions.length || (u.availability || []).length) ? '' : `<div class="alert warn">
                <b>No hours set at all.</b> Until visiting hours are fixed above, or a weekly session is added
                here, this doctor has no bookable slots — they will not appear as available on the appointment
                screen or in the WhatsApp booking flow.</div>`}
              <div id="sess-list"></div>
            </div>
          </div>` : ''}
        </div>

        <div>
          ${isDoctor ? `
            <div class="card"><div class="card-head"><h3>Activity</h3></div>
              <div class="card-body"><dl class="kv">
                <dt>Appointments</dt><dd>${UI.num(u.stats.appointments)}</dd>
                <dt>Visits</dt><dd>${UI.num(u.stats.visits)}</dd>
                <dt>Consultations</dt><dd>${UI.num(u.stats.consultations)}</dd>
              </dl></div>
            </div>
            <div class="card"><div class="card-head"><h3>Leave &amp; blocked days</h3>
              <button class="btn ghost sm" id="add-leave">+ Block a day</button></div>
              <div class="card-body" id="leave-list"></div>
            </div>` : ''}
        </div>
      </div>`;

    if (!isDoctor) return;

    const drawSessions = () => {
      const host = el.querySelector('#sess-list');
      if (!u.sessions.length) return void (host.innerHTML = '');
      const byDay = {};
      for (const s of u.sessions) (byDay[s.weekday] ||= []).push(s);
      host.innerHTML = Object.keys(byDay).sort().map((wd) => `
        <div class="row-between mb" style="border-bottom:1px solid var(--line-2);padding-bottom:8px">
          <b style="min-width:110px">${UI.esc(DAYS[wd])}</b>
          <div style="flex:1">${byDay[wd].map((s) => `
            <div class="row-between small" style="padding:2px 0">
              <span>${UI.esc(UI.to12h ? UI.to12h(s.start_time) : s.start_time)} – ${UI.esc(s.end_time)}
                <span class="muted">· ${UI.esc(s.slot_minutes)} min slots · up to ${UI.esc(s.max_tokens)} tokens</span></span>
              <button class="btn ghost sm" data-del-sess="${s.id}">Remove</button>
            </div>`).join('')}</div>
        </div>`).join('');

      host.querySelectorAll('[data-del-sess]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await UI.confirm('Remove this OPD session? Existing appointments are not affected.'))) return;
        await API.del(`/api/masters/schedule/${b.dataset.delSess}`);
        UI.ok('Session removed.');
        APP.reload();
      }));
    };

    const drawLeave = () => {
      const host = el.querySelector('#leave-list');
      host.innerHTML = u.leaves.length
        ? u.leaves.map((l) => `<div class="row-between small mb">
            <span><b>${UI.esc(UI.date(l.leave_date))}</b>
              <div class="muted">${UI.esc(l.reason || '')}</div></span>
            <button class="btn ghost sm" data-del-leave="${UI.esc(l.leave_date)}">Release</button>
          </div>`).join('')
        : '<div class="muted small">No blocked days coming up.</div>';

      host.querySelectorAll('[data-del-leave]').forEach((b) => b.addEventListener('click', async () => {
        await API.del(`/api/masters/doctors/${id}/leave/${b.dataset.delLeave}`);
        UI.ok('Day released for booking.');
        APP.reload();
      }));
    };

    drawSessions();
    drawLeave();

    // ------------------------------------------------- fixed visiting hours
    const drawAvailability = async () => {
      const host = el.querySelector('#avail-list');
      const { rows } = await API.get(`/api/masters/doctors/${u.id}/availability`);
      if (!rows.length) {
        host.innerHTML = UI.empty('No visiting hours fixed yet. Set the dates this doctor sits.', '🗓');
        return;
      }
      host.innerHTML = UI.table([
        { label: 'Date', render: (r) => `<b>${UI.esc(UI.date(r.avail_date))}</b>` +
          `${r.on_leave ? ' ' + UI.badge('Blocked', 'danger') : ''}` +
          `${r.note ? `<div class="muted small">${UI.esc(r.note)}</div>` : ''}` },
        { label: 'Hours', render: (r) => `${UI.esc(UI.to12h(r.start_time))} – ${UI.esc(UI.to12h(r.end_time))}` +
          `<div class="muted small">${UI.esc(r.slot_minutes)} min per patient</div>` },
        { label: 'Holds', num: true, render: (r) => UI.num(r.capacity) },
        { label: 'Booked', num: true, render: (r) => UI.num(r.booked) },
        { label: 'Free', num: true, render: (r) => r.free
          ? UI.num(r.free) : UI.badge('Full', 'warn') },
        { label: '', render: (r) => `<button class="btn ghost sm" data-del-avail="${r.id}">Remove</button>` },
      ], rows);

      host.querySelectorAll('[data-del-avail]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await UI.confirm('Remove this visiting window? Nobody will be bookable in it.'))) return;
        try {
          await API.del(`/api/masters/availability/${b.dataset.delAvail}`);
        } catch (err) {
          if (!(await UI.confirm(`${err.message} Remove it anyway and leave those appointments in place?`,
            { title: 'Patients are booked', danger: true }))) return;
          await API.del(`/api/masters/availability/${b.dataset.delAvail}?force=1`);
        }
        UI.ok('Visiting window removed.');
        drawAvailability();
      }));
    };
    drawAvailability();

    el.querySelector('#add-avail').addEventListener('click', () => openAvailability(u, drawAvailability));

    el.querySelector('#add-session').addEventListener('click', () => {
      UI.modal({
        title: `OPD session — ${u.name}`,
        body: `<div class="alert info">A session is a block of consulting time on one weekday. Slots are
            generated from it automatically, so this is what makes the doctor bookable.</div>
          <form id="ses-form">
            ${UI.field({ name: 'weekday', label: 'Day of the week', required: true,
              options: DAYS.map((d, i) => ({ value: i, label: d })), value: 1 })}
            <div class="grid c2">
              ${UI.field({ name: 'startTime', label: 'Starts', type: 'time', value: '09:00', required: true })}
              ${UI.field({ name: 'endTime', label: 'Ends', type: 'time', value: '13:00', required: true })}
            </div>
            <div class="grid c2">
              ${UI.field({ name: 'slotMinutes', label: 'Minutes per patient', type: 'number', min: 5, max: 120,
                value: u.slot_minutes || 15 })}
              ${UI.field({ name: 'maxTokens', label: 'Maximum tokens', type: 'number', min: 1, value: 20 })}
            </div>
            <div id="ses-preview"></div>
          </form>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button>
                 <button class="btn" data-act="save">Add session</button>`,
        onMount(modal) {
          const preview = () => {
            const v = UI.formValues(modal.querySelector('#ses-form'));
            const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
            const span = mins(v.endTime) - mins(v.startTime);
            const per = Number(v.slotMinutes) || 15;
            modal.querySelector('#ses-preview').innerHTML = span > 0
              ? `<div class="alert ok">That is <b>${Math.floor(span / per)}</b> slot(s) of ${per} minutes
                   every ${UI.esc(DAYS[v.weekday] || '')}.</div>`
              : '<div class="alert danger">The session must end after it starts.</div>';
          };
          modal.querySelectorAll('#ses-form input, #ses-form select').forEach((i) => {
            i.addEventListener('input', preview); i.addEventListener('change', preview);
          });
          preview();
        },
        async onAction(act, modal) {
          if (act !== 'save') return;
          const form = modal.querySelector('#ses-form');
          if (!form.reportValidity()) return 'keep';
          await API.post(`/api/masters/doctors/${id}/schedule`, UI.formValues(form));
          UI.ok('Session added — the doctor is now bookable on that day.');
          APP.reload();
        },
      });
    });

    el.querySelector('#add-leave').addEventListener('click', () => {
      UI.modal({
        title: `Block a day — ${u.name}`, size: 'narrow',
        body: `<div class="alert info">No slots are offered on a blocked day, on any screen or in WhatsApp.
            Appointments already booked are not cancelled — move those yourself.</div>
          <form id="lv-form">
            ${UI.field({ name: 'date', label: 'Date', type: 'date', required: true, value: UI.today() })}
            ${UI.field({ name: 'reason', label: 'Reason', placeholder: 'e.g. conference, personal leave' })}
          </form>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button>
                 <button class="btn" data-act="save">Block the day</button>`,
        async onAction(act, modal) {
          if (act !== 'save') return;
          const form = modal.querySelector('#lv-form');
          if (!form.reportValidity()) return 'keep';
          await API.post(`/api/masters/doctors/${id}/leave`, UI.formValues(form));
          UI.ok('Day blocked.');
          APP.reload();
        },
      });
    });
  }
})();
