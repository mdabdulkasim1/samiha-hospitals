/* Enquiry desk — the first box of the workflow, whatever channel it came from. */
(function () {
  'use strict';

  APP.register('enquiries', {
    title: 'Enquiries',
    subtitle: 'Walk-in, phone, WhatsApp and web enquiries',

    async render(el, params) {
      APP.actions([{ id: 'new', label: '+ Log enquiry', kind: '', onClick: openNew }]);

      const [stats] = await Promise.all([API.get('/api/enquiries/stats')]);
      const byStatus = Object.fromEntries(stats.byStatus.map((r) => [r.status, r.c]));
      const bySource = Object.fromEntries(stats.bySource.map((r) => [r.source, r.c]));

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">Open</div><div class="value">${UI.num(byStatus.new || 0)}</div>
            <div class="foot">${UI.num(byStatus.contacted || 0)} contacted</div></div>
          <div class="stat ok"><div class="label">Converted</div><div class="value">${UI.num(byStatus.converted || 0)}</div>
            <div class="foot">Turned into appointments</div></div>
          <div class="stat teal"><div class="label">Via WhatsApp</div><div class="value">${UI.num(bySource.whatsapp || 0)}</div>
            <div class="foot">Self-service channel</div></div>
          <div class="stat orange"><div class="label">Follow-ups due</div><div class="value">${UI.num(stats.dueFollowUps)}</div>
            <div class="foot">Call these back</div></div>
        </div>

        <div class="search-row">
          <select id="f-status">
            <option value="">All statuses</option>
            ${['new','contacted','converted','closed','lost'].map((s) =>
              `<option value="${s}"${params.status === s ? ' selected' : ''}>${UI.titleise(s)}</option>`).join('')}
          </select>
          <select id="f-source">
            <option value="">All sources</option>
            ${['whatsapp','walk_in','phone','web','referral','camp'].map((s) =>
              `<option value="${s}"${params.source === s ? ' selected' : ''}>${UI.titleise(s)}</option>`).join('')}
          </select>
        </div>
        <div class="card"><div class="card-body tight" id="elist">${UI.loading()}</div></div>`;

      const load = async () => {
        const host = el.querySelector('#elist');
        host.innerHTML = UI.loading();
        const res = await API.get('/api/enquiries' + API.qs({
          status: el.querySelector('#f-status').value,
          source: el.querySelector('#f-source').value,
        }));
        host.innerHTML = UI.table([
          { label: 'Ref', render: (e) => `<code>${UI.esc(e.ref_no)}</code>` },
          { label: 'Source', render: (e) => UI.badge(UI.titleise(e.source), e.source === 'whatsapp' ? 'wa' : 'info') },
          { label: 'Name', render: (e) => `<b>${UI.esc(e.name)}</b>` +
            (e.uhid ? `<div class="muted small">${UI.esc(e.uhid)}</div>` : '') },
          { label: 'Patient', render: (e) => e.patient_stage === 'enquiry'
            ? UI.badge('Enquiry', 'orange')
            : e.patient_stage === 'registered' ? UI.badge('Registered', 'ok') : '—' },
          { label: 'Phone', render: (e) => UI.esc(e.phone || '—') },
          { label: 'Subject', render: (e) => UI.esc(e.subject || e.notes || '—') },
          { label: 'Status', render: (e) => UI.statusBadge(e.status) },
          { label: 'Appointment', render: (e) => e.appt_no ? UI.badge(e.appt_no, 'ok') : '—' },
          { label: 'Logged', render: (e) => UI.esc(UI.ago(e.created_at)) },
        ], res.rows, { emptyText: 'No enquiries match this filter.' });
        UI.bindRows(host, res.rows, openDetail);
      };

      el.querySelector('#f-status').addEventListener('change', load);
      el.querySelector('#f-source').addEventListener('change', load);
      await load();
    },
  });

  function openNew() {
    UI.modal({
      title: 'Log an enquiry',
      body: `<form id="enq-form">
        <div class="grid c2">
          ${UI.field({ name: 'source', label: 'Source', required: true,
            options: [{ value: 'walk_in', label: 'Walk-in' }, { value: 'phone', label: 'Phone' },
                      { value: 'whatsapp', label: 'WhatsApp' }, { value: 'web', label: 'Website' },
                      { value: 'referral', label: 'Referral' }, { value: 'camp', label: 'Health camp' }] })}
          ${UI.field({ name: 'name', label: 'Caller / patient name', required: true })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'phone', label: 'Phone' })}
          ${UI.field({ name: 'followUpAt', label: 'Follow up on', type: 'datetime-local' })}
        </div>
        ${UI.field({ name: 'subject', label: 'Subject', placeholder: 'e.g. wants a paediatric appointment' })}
        ${UI.field({ name: 'notes', label: 'Notes', type: 'textarea' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Log enquiry</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#enq-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (values.followUpAt) values.followUpAt = values.followUpAt.replace('T', ' ') + ':00';
        const e = await API.post('/api/enquiries', values);
        UI.ok(`Enquiry ${e.ref_no} logged.` + (e.patient
          ? ` ${e.patientStage === 'enquiry' ? 'Opened' : 'Linked to'} patient file ${e.patient.uhid}.` : ''));
        APP.reload();
      },
    });
  }

  function openDetail(e) {
    UI.modal({
      title: `${e.ref_no} — ${e.name}`,
      body: `
        <dl class="kv mb">
          <dt>Source</dt><dd>${UI.badge(UI.titleise(e.source), e.source === 'whatsapp' ? 'wa' : 'info')}</dd>
          <dt>Phone</dt><dd>${UI.esc(e.phone || '—')}</dd>
          <dt>Subject</dt><dd>${UI.esc(e.subject || '—')}</dd>
          <dt>Notes</dt><dd>${UI.esc(e.notes || '—')}</dd>
          <dt>Logged</dt><dd>${UI.esc(UI.dateTime(e.created_at))}</dd>
          ${e.uhid ? `<dt>Patient file</dt><dd>${UI.esc(e.uhid)} ${e.patient_stage === 'enquiry'
            ? UI.badge('Enquiry', 'orange') : UI.badge('Registered', 'ok')}</dd>` : ''}
          ${e.appt_no ? `<dt>Appointment</dt><dd>${UI.esc(e.appt_no)}</dd>` : ''}
        </dl>
        <form id="enq-update">
          <div class="grid c2">
            ${UI.field({ name: 'status', label: 'Status', value: e.status,
              options: ['new','contacted','converted','closed','lost'].map((s) => ({ value: s, label: UI.titleise(s) })) })}
            ${UI.field({ name: 'followUpAt', label: 'Follow up on', type: 'datetime-local' })}
          </div>
          ${UI.field({ name: 'notes', label: 'Add to notes', type: 'textarea', value: e.notes || '' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               ${e.patient_id ? '<button class="btn ghost" data-act="open">Open patient file</button>' : ''}
               ${e.patient_stage === 'enquiry' && APP.can(['reception'])
                 ? '<button class="btn" data-act="register">Register patient</button>' : ''}
               ${e.status !== 'converted' ? '<button class="btn teal" data-act="book">Book appointment</button>' : ''}
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act === 'open') {
          UI.closeAllModals();
          return APP.navigate('patients', { id: e.patient_id });
        }
        if (act === 'register') {
          UI.closeAllModals();
          return APP.navigate('patients', { id: e.patient_id, register: '1' });
        }
        if (act === 'book') {
          UI.closeAllModals();
          return APP.navigate('appointments', { enquiryId: e.id, name: e.name, phone: e.phone || '' });
        }
        if (act !== 'save') return;
        const values = UI.formValues(modal.querySelector('#enq-update'));
        if (values.followUpAt) values.followUpAt = values.followUpAt.replace('T', ' ') + ':00';
        await API.patch(`/api/enquiries/${e.id}`, values);
        UI.ok('Enquiry updated.');
        APP.reload();
      },
    });
  }
})();
