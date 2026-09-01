/* Appointment scheduling with live slot availability. */
(function () {
  'use strict';

  APP.register('appointments', {
    title: 'Appointments',
    subtitle: 'Schedule and day list',

    async render(el, params) {
      APP.actions([{ id: 'new', label: '+ Book appointment', kind: '',
        onClick: () => openBooking(params) }]);

      const date = params.date || UI.today();
      if (params.enquiryId || params.name) setTimeout(() => openBooking(params), 60);

      el.innerHTML = `
        <div class="search-row">
          <input type="date" id="a-date" value="${UI.esc(date)}">
          <select id="a-status">
            <option value="">All statuses</option>
            ${['booked','confirmed','checked_in','completed','cancelled','no_show'].map((s) =>
              `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
          </select>
        </div>
        <div class="card"><div class="card-body tight" id="alist">${UI.loading()}</div></div>`;

      const load = async () => {
        const host = el.querySelector('#alist');
        host.innerHTML = UI.loading();
        const res = await API.get('/api/appointments' + API.qs({
          date: el.querySelector('#a-date').value,
          status: el.querySelector('#a-status').value,
        }));
        host.innerHTML = UI.table([
          { label: 'Time', render: (a) => `<b>${UI.esc(UI.time(a.scheduled_at))}</b>` },
          { label: 'Token', render: (a) => `<span class="badge crimson">#${UI.esc(a.token_no || '—')}</span>` },
          { label: 'Ref', render: (a) => `<code>${UI.esc(a.appt_no)}</code>` },
          { label: 'Patient', render: (a) => `<b>${UI.esc(a.display_name)}</b>` +
            `<div class="muted small">${UI.esc(a.uhid || 'Not registered')} · ${UI.esc(a.patient_phone || a.guest_phone || '')}</div>` },
          { label: 'Doctor', render: (a) => `${UI.esc(a.doctor_name || '—')}<div class="muted small">${UI.esc(a.department_name || '')}</div>` },
          { label: 'Source', render: (a) => UI.badge(UI.titleise(a.source), a.source === 'whatsapp' ? 'wa' : 'info') },
          { label: 'Status', render: (a) => UI.statusBadge(a.status) },
          { label: 'Reason', render: (a) => UI.esc(a.reason || '—') },
        ], res.rows, { emptyText: 'No appointments for this day.' });
        UI.bindRows(host, res.rows, openAppointment);
        APP.setSubtitle(`${res.rows.length} appointment(s) on ${UI.date(el.querySelector('#a-date').value)}`);
      };

      el.querySelector('#a-date').addEventListener('change', load);
      el.querySelector('#a-status').addEventListener('change', load);
      await load();
    },
  });

  // ------------------------------------------------------------- booking flow
  async function openBooking(params = {}) {
    const [doctors, departments] = await Promise.all([
      API.get('/api/masters/staff?role=doctor'),
      API.get('/api/masters/departments?kind=specialist'),
    ]);
    // Group the picker by the clinic's specialist categories.
    const doctorOptions = [{ value: '', label: '— select a doctor —' }];
    for (const dept of departments) {
      const inDept = doctors.filter((d) => d.department_id === dept.id);
      if (!inDept.length) continue;
      doctorOptions.push({ value: '', label: `── ${dept.name} ──`, disabled: true });
      for (const d of inDept) {
        doctorOptions.push({ value: d.id, label: `   ${d.name}${d.qualification ? ' · ' + d.qualification : ''}` });
      }
    }

    UI.modal({
      title: 'Book an appointment',
      size: 'wide',
      body: `
        <div class="grid c2">
          <div>
            <fieldset><legend>Patient</legend>
              <div class="tabs" id="pmode">
                <button class="active" data-mode="existing">Registered patient</button>
                <button data-mode="guest">New / unregistered</button>
              </div>
              <div id="pm-existing">
                <input type="search" id="bk-q" placeholder="Search name, UHID or phone…">
                <div id="bk-results" class="mt"></div>
                <div id="bk-chosen"></div>
              </div>
              <div id="pm-guest" hidden>
                ${UI.field({ name: 'guestName', label: 'Patient name', value: params.name || '' })}
                ${UI.field({ name: 'guestPhone', label: 'Mobile number', value: params.phone || '' })}
                <div class="muted small">The front desk will complete registration when they arrive.</div>
              </div>
            </fieldset>

            <fieldset><legend>Appointment</legend>
              ${UI.field({ name: 'doctorId', label: 'Doctor', required: true, options: doctorOptions })}
              <div class="grid c2">
                ${UI.field({ name: 'visitKind', label: 'Type', value: 'new',
                  options: [{ value: 'new', label: 'New consultation' }, { value: 'follow_up', label: 'Follow-up' },
                            { value: 'screening', label: 'Yearly screening' }, { value: 'procedure', label: 'Procedure' },
                            { value: 'teleconsult', label: 'Teleconsult' }] })}
                ${UI.field({ name: 'source', label: 'Booked via', value: 'reception',
                  options: [{ value: 'reception', label: 'Front desk' }, { value: 'phone', label: 'Phone' },
                            { value: 'whatsapp', label: 'WhatsApp' }, { value: 'web', label: 'Website' },
                            { value: 'walk_in', label: 'Walk-in' }] })}
              </div>
              ${UI.field({ name: 'reason', label: 'Reason for visit', placeholder: 'e.g. review with blood reports' })}
            </fieldset>
          </div>

          <div>
            <fieldset><legend>Pick a slot</legend>
              <div id="bk-dates" class="muted">Select a doctor to see available days.</div>
              <div id="bk-slots" class="mt"></div>
            </fieldset>
            <div id="bk-summary"></div>
          </div>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save" disabled>Confirm booking</button>`,
      onMount(modal) { wireBooking(modal, params); },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const state = modal.__booking;
        const values = UI.formValues(modal);
        const payload = {
          doctorId: values.doctorId,
          scheduledAt: `${state.date} ${state.time}:00`,
          visitKind: values.visitKind,
          source: values.source,
          reason: values.reason,
        };
        if (state.patient) payload.patientId = state.patient.id;
        else { payload.guestName = values.guestName; payload.guestPhone = values.guestPhone; }

        if (!payload.patientId && !payload.guestName) { UI.err('Choose a patient or enter a name.'); return 'keep'; }

        const appt = await API.post('/api/appointments', payload);
        if (params.enquiryId) {
          await API.patch(`/api/enquiries/${params.enquiryId}`, { status: 'converted' });
        }
        UI.ok(`Booked — ${appt.appt_no}, token #${appt.token_no}. Confirmation sent on WhatsApp.`);
        APP.reload();
      },
    });
  }

  function wireBooking(modal, params) {
    const state = { patient: null, date: null, time: null, mode: 'existing' };
    modal.__booking = state;
    const saveBtn = document.querySelector('[data-act=save]');

    const refresh = () => {
      const doctorChosen = modal.querySelector('[name=doctorId]').value;
      const patientChosen = state.mode === 'guest'
        ? !!modal.querySelector('[name=guestName]').value.trim()
        : !!state.patient;
      saveBtn.disabled = !(doctorChosen && patientChosen && state.date && state.time);

      modal.querySelector('#bk-summary').innerHTML = (state.date && state.time)
        ? `<div class="alert ok"><b>Selected:</b> ${UI.esc(UI.date(state.date))} at
             ${UI.esc(UI.time(state.date + ' ' + state.time + ':00'))}</div>`
        : '';
    };

    // Patient mode tabs
    modal.querySelectorAll('#pmode button').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      modal.querySelectorAll('#pmode button').forEach((x) => x.classList.toggle('active', x === b));
      modal.querySelector('#pm-existing').hidden = state.mode !== 'existing';
      modal.querySelector('#pm-guest').hidden = state.mode !== 'guest';
      refresh();
    }));
    if (params.name) modal.querySelector('[data-mode=guest]').click();
    modal.querySelector('[name=guestName]').addEventListener('input', refresh);

    // Patient search
    let t;
    modal.querySelector('#bk-q').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = e.target.value.trim();
        const host = modal.querySelector('#bk-results');
        if (q.length < 2) return void (host.innerHTML = '');
        const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
        host.innerHTML = res.rows.map((p) =>
          `<button type="button" class="btn ghost sm block mb" data-pid="${p.id}" style="justify-content:flex-start">
            ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)} · ${UI.esc(p.phone || '')}</button>`).join('')
          || '<div class="muted small">No match — use the “New / unregistered” tab.</div>';
        host.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', () => {
          state.patient = res.rows.find((p) => p.id === Number(b.dataset.pid));
          host.innerHTML = '';
          modal.querySelector('#bk-q').value = '';
          modal.querySelector('#bk-chosen').innerHTML =
            `<div class="alert ok"><b>${UI.esc(state.patient.first_name)} ${UI.esc(state.patient.last_name || '')}</b>
             · ${UI.esc(state.patient.uhid)} <button type="button" class="btn ghost sm" id="bk-clear">Change</button></div>`;
          modal.querySelector('#bk-clear').addEventListener('click', () => {
            state.patient = null;
            modal.querySelector('#bk-chosen').innerHTML = '';
            refresh();
          });
          refresh();
        }));
      }, 220);
    });

    // Doctor → available days → slots
    modal.querySelector('[name=doctorId]').addEventListener('change', async (e) => {
      state.date = null; state.time = null;
      modal.querySelector('#bk-slots').innerHTML = '';
      refresh();
      if (!e.target.value) return;
      const host = modal.querySelector('#bk-dates');
      host.innerHTML = UI.loading();
      const res = await API.get('/api/appointments/availability' + API.qs({ doctorId: e.target.value, count: 8 }));
      if (!res.dates.length) return void (host.innerHTML = '<div class="alert warn">No open days in the next 30 days.</div>');
      host.innerHTML = '<div class="btn-row">' + res.dates.map((d) =>
        `<button type="button" class="btn ghost sm" data-date="${UI.esc(d.date)}">${UI.esc(d.label)}<br><span class="muted small">${d.slots} free</span></button>`).join('') + '</div>';
      host.querySelectorAll('[data-date]').forEach((b) => b.addEventListener('click', async () => {
        host.querySelectorAll('[data-date]').forEach((x) => x.classList.toggle('teal', x === b));
        state.date = b.dataset.date; state.time = null;
        const slotHost = modal.querySelector('#bk-slots');
        slotHost.innerHTML = UI.loading();
        const s = await API.get('/api/appointments/availability' +
          API.qs({ doctorId: modal.querySelector('[name=doctorId]').value, date: state.date }));
        slotHost.innerHTML = '<div class="btn-row">' + s.slots.map((x) =>
          `<button type="button" class="btn ghost sm" data-time="${UI.esc(x.time)}">${UI.esc(x.label)}</button>`).join('') + '</div>';
        slotHost.querySelectorAll('[data-time]').forEach((tb) => tb.addEventListener('click', () => {
          slotHost.querySelectorAll('[data-time]').forEach((x) => x.classList.toggle('teal', x === tb));
          state.time = tb.dataset.time;
          refresh();
        }));
        refresh();
      }));
    });
  }

  // ------------------------------------------------------------ appointment
  function openAppointment(a) {
    UI.modal({
      title: `${a.appt_no} — ${a.display_name}`,
      body: `<dl class="kv mb">
          <dt>When</dt><dd>${UI.esc(UI.dateTime(a.scheduled_at))}</dd>
          <dt>Token</dt><dd>#${UI.esc(a.token_no || '—')}</dd>
          <dt>Doctor</dt><dd>${UI.esc(a.doctor_name || '—')}</dd>
          <dt>Department</dt><dd>${UI.esc(a.department_name || '—')}</dd>
          <dt>Source</dt><dd>${UI.badge(UI.titleise(a.source), a.source === 'whatsapp' ? 'wa' : 'info')}</dd>
          <dt>Status</dt><dd>${UI.statusBadge(a.status)}</dd>
          <dt>Reason</dt><dd>${UI.esc(a.reason || '—')}</dd>
          <dt>Contact</dt><dd>${UI.esc(a.patient_phone || a.guest_phone || '—')}</dd>
        </dl>
        ${!a.uhid ? '<div class="alert warn">This booking is for an <b>unregistered</b> patient — register them at arrival.</div>' : ''}
        ${a.visit_id ? '<div class="alert ok">The patient has already been checked in for this appointment.</div>' : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${['booked','confirmed'].includes(a.status) ? `
          <button class="btn ghost" data-act="cancel">Cancel appointment</button>
          <button class="btn ghost" data-act="noshow">Mark no-show</button>
          <button class="btn teal" data-act="confirm">Confirm</button>` : ''}`,
      async onAction(act) {
        if (act === 'cancel') {
          const reason = prompt('Reason for cancellation?') || 'Cancelled by clinic';
          await API.patch(`/api/appointments/${a.id}`, { status: 'cancelled', cancelReason: reason });
          UI.ok('Appointment cancelled — the patient has been notified.');
        } else if (act === 'noshow') {
          await API.patch(`/api/appointments/${a.id}`, { status: 'no_show' });
          UI.ok('Marked as no-show.');
        } else if (act === 'confirm') {
          await API.patch(`/api/appointments/${a.id}`, { status: 'confirmed' });
          UI.ok('Appointment confirmed.');
        } else return;
        APP.reload();
      },
    });
  }
})();
