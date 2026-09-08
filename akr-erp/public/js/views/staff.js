/* Staff, their desks, and the audit trail. Administrators only. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const state = { tab: 'staff' };

  APP.register('staff', {
    title: 'Staff',
    subtitle: 'Who works at which desk, and what each desk can do',

    async render(host) {
      const data = await API.get('/api/admin/users');
      APP.actions([{ id: 'new', label: '+ Add somebody', kind: 'gold',
        onClick: () => editUser(null, data.roles) }]);

      host.innerHTML = `
        <div class="tabs">
          <button data-tab="staff" class="${state.tab === 'staff' ? 'active' : ''}">Staff</button>
          <button data-tab="audit" class="${state.tab === 'audit' ? 'active' : ''}">Audit trail</button>
          <button data-tab="numbers" class="${state.tab === 'numbers' ? 'active' : ''}">Document numbers</button>
        </div>
        <div id="pane">${UI.loading()}</div>`;

      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        APP.reload();
      }));

      const pane = document.getElementById('pane');
      if (state.tab === 'staff') {
        pane.innerHTML = `
          <div class="card">
            <div class="card-sub">A desk decides what somebody can reach, and what they can see of the
              money. Logistics work in quantities and documents; prices and the books belong to the
              desks that negotiate and collect.</div>
            <div class="grid g5 mb">
              ${data.roles.map((r) => `<div class="stat">
                <div class="k">${esc(APP.roleLabel(r.value))}</div>
                <div class="n" style="margin-top:6px">${esc(r.note)}</div></div>`).join('')}
            </div>
            <div id="rows"></div>
          </div>`;
        const box = document.getElementById('rows');
        box.innerHTML = UI.table([
          { label: 'Code', render: (r) => `<span class="mono">${esc(r.staff_code)}</span>` },
          { label: 'Name', render: (r) => `<b>${esc(r.name)}</b>
              <div class="muted small">${esc(r.designation || '')}</div>` },
          { label: 'Email', key: 'email' },
          { label: 'Desk', render: (r) => UI.badge(APP.roleLabel(r.role), 'navy') },
          { label: 'Company', key: 'company_code' },
          { label: 'Last signed in', render: (r) => (r.last_login_at ? UI.dateTime(r.last_login_at) : 'never') },
          { label: '', render: (r) => (r.active ? '' : UI.badge('inactive', 'danger')) },
        ], data.rows, { onRow: true });
        UI.bindRows(box, data.rows, (row) => editUser(row, data.roles));
        return;
      }

      if (state.tab === 'audit') {
        const log = await API.get('/api/admin/audit?limit=200');
        pane.innerHTML = `<div class="card">
          <div class="card-sub">Every document raised, price confirmed, delivery released and payment
            recorded, with who did it.</div>
          ${UI.table([
            { label: 'When', render: (r) => UI.dateTime(r.created_at) },
            { label: 'Who', key: 'actor' },
            { label: 'Did', render: (r) => `<span class="mono small">${esc(r.action)}</span>` },
            { label: 'To', render: (r) => `${esc(r.entity || '')} ${esc(r.entity_id || '')}` },
            { label: 'Detail', render: (r) => `<span class="muted small">${esc((r.details || '').slice(0, 120))}</span>` },
          ], log.rows)}</div>`;
        return;
      }

      const counters = await API.get('/api/admin/counters');
      pane.innerHTML = `<div class="card">
        <div class="card-sub">Where each company's series has reached. Numbers are issued one at a
          time and never reused, so a printed document can always be found.</div>
        ${UI.table([
          { label: 'Series', render: (r) => `<span class="mono">${esc(r.name)}</span>` },
          { label: 'Issued', num: true, render: (r) => UI.num(r.value) },
        ], counters.rows, { emptyText: 'Nothing has been numbered yet.' })}</div>`;
    },
  });

  function editUser(user, roles) {
    const isNew = !user;
    UI.modal({
      title: isNew ? 'Add somebody' : `${user.name}`,
      body: `<form id="u-form">
        ${UI.field({ name: 'name', label: 'Name', required: true, value: user ? user.name : '' })}
        ${UI.field({ name: 'email', label: 'Email', type: 'email', required: true,
          value: user ? user.email || '' : '' })}
        ${UI.field({ name: 'phone', label: 'Phone', value: user ? user.phone || '' : '' })}
        ${UI.field({ name: 'designation', label: 'Designation', value: user ? user.designation || '' : '' })}
        ${UI.field({ name: 'role', label: 'Desk', required: true, value: user ? user.role : 'sales',
          options: roles.map((r) => ({ value: r.value, label: APP.roleLabel(r.value) })) })}
        <div class="muted small mb" id="role-note"></div>
        ${UI.field({ name: 'company_id', label: 'Company', blank: 'The default company',
          value: user ? user.company_id : '', options: APP.companyOptions() })}
        ${UI.password({ name: 'password', label: isNew ? 'Password' : 'New password (leave blank to keep it)',
          required: isNew, autocomplete: 'new-password', meter: true,
          hint: 'At least 8 characters, with a letter and a number.' })}
        ${user ? UI.checkbox({ name: 'active', label: 'Can sign in', checked: !!user.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${isNew ? 'Create the account' : 'Save'}</button>`,
      onMount(modal) {
        UI.wirePasswords(modal);
        const roleEl = modal.querySelector('[name=role]');
        const note = modal.querySelector('#role-note');
        const sync = () => {
          const r = roles.find((x) => x.value === roleEl.value);
          note.textContent = r ? r.note : '';
        };
        roleEl.addEventListener('change', sync);
        sync();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#u-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        if (user) v.active = form.querySelector('[name=active]').checked;
        if (user) await API.patch(`/api/admin/users/${user.id}`, v);
        else await API.post('/api/admin/users', v);
        UI.ok('Saved.');
        APP.reload();
      },
    });
  }
})();
