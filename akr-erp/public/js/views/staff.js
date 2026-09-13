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
            <div class="card-sub">A desk decides what somebody can see of the money — logistics work
              in quantities, prices and the books belong to the desks that negotiate and collect — and
              it sets the screens they start with. <b>What they can open is yours to change</b>, one
              person at a time: <b>what they can open</b> beside their name.</div>
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
          { label: 'Screens', render: (r) => `<button type="button" class="link-btn small"
              data-access="${r.id}">what they can open</button>` },
          { label: '', render: (r) => (r.active ? '' : UI.badge('inactive', 'danger')) },
        ], data.rows, { onRow: true });
        UI.bindRows(box, data.rows, (row) => editUser(row, data.roles));
        // The access list is its own thing, so opening it does not open the
        // account editor underneath.
        box.querySelectorAll('[data-access]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          editAccess(Number(b.dataset.access));
        }));
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


  /**
   * Which screens one person may open.
   *
   * Their desk gives them a sensible set; this is where the owner says
   * otherwise for somebody in particular — the sales officer who also follows
   * the buying side, the accounts clerk trusted with the profit page. Only the
   * difference from the desk's default is kept, so changing what a desk gives
   * still reaches everybody left on it.
   *
   * What this does not do is widen what somebody may change. A screen granted
   * here can be opened and read; entering a payment, confirming a price or
   * adding a member of staff still belongs to the desk that answers for it.
   */
  async function editAccess(userId) {
    const [catalogue, current] = await Promise.all([
      API.get('/api/admin/screens'),
      API.get(`/api/admin/users/${userId}/screens`),
    ]);
    const allowed = new Set(current.allowed);
    const base = new Set(current.role_default);
    const groups = [...new Set(catalogue.screens.map((s) => s.group))];

    const body = groups.map((g) => `<div class="mb">
      <h4>${esc(g)}</h4>
      <div class="grid g3">
        ${catalogue.screens.filter((s) => s.group === g).map((s) => `
          <label class="inline-check">
            <input type="checkbox" data-screen="${esc(s.id)}"${allowed.has(s.id) ? ' checked' : ''}
              ${s.id === 'account' ? ' disabled' : ''}>
            <span>${esc(s.label)}
              ${s.id === 'account' ? '<span class="muted small"> — always</span>'
                : (base.has(s.id) ? '' : '<span class="muted small"> — not on this desk</span>')}</span>
          </label>`).join('')}
      </div></div>`).join('');

    UI.modal({
      title: `${current.user.name} — what they can open`,
      size: 'wide',
      body: `<div class="muted small mb">Their desk is
        <b>${esc(APP.roleLabel(current.user.role))}</b>, which gives the screens ticked when this was
        opened. Tick or untick to suit them. Opening a screen is not the same as being able to change
        anything on it — that still follows their desk.</div>
        ${body}`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn ghost" data-act="reset">Back to the desk's default</button>
        <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act === 'reset') {
          await API.put(`/api/admin/users/${userId}/screens`, { reset: true });
          UI.ok("Back to the desk's default.");
          return;
        }
        if (act !== 'save') return;
        const screens = [...modal.querySelectorAll('[data-screen]')]
          .filter((el) => el.checked || el.disabled).map((el) => el.dataset.screen);
        await API.put(`/api/admin/users/${userId}/screens`, { screens });
        UI.ok('Saved. They will see it the next time they sign in.');
      },
    });
  }

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
