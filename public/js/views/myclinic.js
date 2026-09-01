/*
 * My Clinic — what a doctor opens on their phone.
 *
 * One question answered first and large: how many patients am I seeing, and
 * when. Everything else — the patient list, the days ahead, blocking a day —
 * sits under it. Built narrow-first because it is read on a mobile far more
 * often than at a desk.
 */
(function () {
  'use strict';

  APP.register('myclinic', {
    title: 'My Clinic',
    subtitle: 'Your patients, day by day',

    async render(el, params) {
      const date = params.date || UI.today();
      el.innerHTML = UI.loading();

      const data = await API.get('/api/appointments/my-day' + API.qs({
        date, doctorId: params.doctorId || undefined,
      }));

      APP.setSubtitle(`${data.doctor.name}${data.doctor.specialization ? ' · ' + data.doctor.specialization : ''}`);
      APP.actions([
        { id: 'settings', label: 'Alert settings', onClick: openAlertSettings },
        { id: 'leave', label: 'Block a day', onClick: () => openBlockDay(date) },
      ]);

      const s = data.summary;
      el.innerHTML = `
        <div class="card mb"><div class="card-body">
          <div class="row-between" style="flex-wrap:wrap;gap:10px">
            <div>
              <div class="muted small">Clinic day</div>
              <div style="font-size:20px;font-weight:700">${UI.esc(data.label)}</div>
              <div class="muted small">${data.onLeave
                ? '<b style="color:var(--danger)">You have blocked this day</b>'
                : (data.hours ? 'Visiting hours ' + UI.esc(data.hours) : 'No visiting hours fixed for this day')}
                ${data.doctor.room_no ? ' · Room ' + UI.esc(data.doctor.room_no) : ''}</div>
            </div>
            <div class="btn-row">
              <button class="btn ghost sm" id="d-prev">← Previous day</button>
              <input type="date" id="d-date" value="${UI.esc(date)}" style="max-width:165px">
              <button class="btn ghost sm" id="d-next">Next day →</button>
            </div>
          </div>
        </div></div>

        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">Patients booked</div>
            <div class="value">${UI.num(s.booked)}</div>
            <div class="foot">${UI.num(s.newPatients)} new · ${UI.num(s.booked - s.newPatients)} follow-up</div></div>
          <div class="stat teal"><div class="label">Arrived</div>
            <div class="value">${UI.num(s.arrived)}</div><div class="foot">Checked in at the desk</div></div>
          <div class="stat ok"><div class="label">Seen</div>
            <div class="value">${UI.num(s.completed)}</div><div class="foot">Consultation closed</div></div>
          <div class="stat orange"><div class="label">Cancelled / no-show</div>
            <div class="value">${UI.num(s.cancelled + s.noShow)}</div>
            <div class="foot">${UI.num(s.cancelled)} cancelled · ${UI.num(s.noShow)} did not come</div></div>
        </div>

        <div class="grid sidebar-right">
          <div class="card"><div class="card-head"><h3>Patients on ${UI.esc(data.label)}</h3></div>
            <div class="card-body tight" id="d-list"></div></div>

          <div>
            <div class="card"><div class="card-head"><h3>Your next clinic days</h3></div>
              <div class="card-body tight" id="d-upcoming"></div></div>
          </div>
        </div>`;

      el.querySelector('#d-list').innerHTML = UI.table([
        { label: 'Token', render: (r) => `<span class="badge crimson">#${UI.esc(r.token_no || '—')}</span>` },
        { label: 'Time', render: (r) => `<b>${UI.esc(r.time)}</b>` },
        { label: 'Patient', render: (r) => `<b>${UI.esc(r.display_name)}</b>` +
          `<div class="muted small">${UI.esc(r.uhid || 'not registered yet')}` +
          `${r.age_years ? ' · ' + UI.esc(r.age_years) + 'y' : ''}` +
          `${r.gender ? ' · ' + UI.esc(UI.titleise(r.gender)) : ''}</div>` },
        { label: 'Contact', render: (r) => UI.esc(r.patient_phone || r.guest_phone || '—') },
        { label: 'Reason', render: (r) => UI.esc(r.reason || '—') },
        { label: 'Kind', render: (r) => UI.badge(UI.titleise(r.visit_kind || 'new'),
          r.visit_kind === 'new' ? 'teal' : '') },
        { label: 'Flags', render: (r) => r.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
        { label: 'Status', render: (r) => UI.statusBadge(r.visit_status || r.status) },
        { label: '', render: (r) => r.visit_id
          ? `<button class="btn sm" data-visit="${r.visit_id}">Open</button>` : '' },
      ], data.rows, { emptyText: 'No patient is booked with you on this day.' });

      el.querySelectorAll('[data-visit]').forEach((b) => b.addEventListener('click', () =>
        APP.navigate('consult', { visitId: b.dataset.visit })));

      el.querySelector('#d-upcoming').innerHTML = UI.table([
        { label: 'Day', render: (u) => `<b>${UI.esc(u.label)}</b>` +
          `<div class="muted small">${UI.esc(u.hours)}</div>` },
        { label: 'Booked', num: true, render: (u) => UI.num(u.booked) },
        { label: 'Free', num: true, render: (u) => u.free
          ? UI.num(u.free) : UI.badge('Full', 'warn') },
      ], data.upcoming, { emptyText: 'No visiting hours are fixed ahead. Ask admin to set your days.' });

      el.querySelector('#d-upcoming').querySelectorAll('tbody tr').forEach((tr, i) => {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => APP.navigate('myclinic', { date: data.upcoming[i].date }));
      });

      const go = (d) => APP.navigate('myclinic', { date: d });
      el.querySelector('#d-date').addEventListener('change', (e) => go(e.target.value));
      el.querySelector('#d-prev').addEventListener('click', () => go(shift(date, -1)));
      el.querySelector('#d-next').addEventListener('click', () => go(shift(date, 1)));
    },
  });

  function shift(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Where a booking alert should reach this doctor. */
  async function openAlertSettings() {
    const s = await API.get('/api/me/alert-settings');
    UI.modal({
      title: 'How you hear about a booking',
      size: 'narrow',
      body: `<p class="muted">When the front desk books a patient with you, the ERP tells you
        straight away. The bell in the header always fires; these are the copies that reach
        your phone when you are not at the clinic.</p>
        <form id="al-form">
          ${UI.field({ name: 'whatsapp', label: 'WhatsApp number', value: s.whatsapp || s.phone || '',
            hint: 'Leave blank to use the mobile on your staff record' })}
          ${s.isDoctor ? `
            ${UI.checkbox({ name: 'notifyWhatsapp', label: 'Send me a WhatsApp for every booking',
              checked: !!s.notify_whatsapp })}
            ${UI.checkbox({ name: 'notifyEmail', label: `Email me as well${s.email ? ' (' + s.email + ')' : ''}`,
              checked: !!s.notify_email })}` : ''}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        await API.patch('/api/me/alert-settings', UI.formValues(modal.querySelector('#al-form')));
        UI.ok('Saved.');
      },
    });
  }

  function openBlockDay(defaultDate) {
    UI.modal({
      title: 'Block a clinic day',
      size: 'narrow',
      body: `<p class="muted">Nobody can be booked with you on a blocked day. Patients already
        booked stay booked — ask the front desk to move them.</p>
        <form id="bl-form">
          ${UI.field({ name: 'date', label: 'Date', type: 'date', value: defaultDate, required: true })}
          ${UI.field({ name: 'reason', label: 'Reason', placeholder: 'Conference, personal leave…' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Block the day</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#bl-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post('/api/me/leave', UI.formValues(form));
        UI.ok('Day blocked.');
        if (res.warning) UI.warn(res.warning);
        APP.reload();
      },
    });
  }
})();
