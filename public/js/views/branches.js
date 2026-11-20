/* The branches: the clinic's own places, and who works in which. */
(function () {
  'use strict';
  /**
   * One screen for a question with two halves.
   *
   * The first is the list of places the clinic runs. A branch is not a
   * setting that can be tidied away later: its code is printed in the middle
   * of every asset label, it is stamped on every visit, payment and expense
   * recorded in it, and the owner's comparison of one month against another
   * is only as good as the fact that the two places were kept apart from the
   * first day. So it is opened here, named here, and never deleted.
   *
   * The second is who works where. Everybody signs in to exactly one branch
   * and sees that branch's day; the owner and the administrator may stand in
   * any of them. Everybody else is posted — normally to one place, sometimes
   * to two when a doctor or a radiographer covers both — and their home
   * branch is simply where their sign-in lands before they have chosen.
   */

  APP.register('branches', {
    title: 'Branches',
    subtitle: 'The places the clinic runs, and who works in which',

    async render(el, params) {
      const tabs = { places: placesTab, people: peopleTab };
      const open = tabs[params.tab] ? params.tab : 'places';

      el.innerHTML = `
        <div class="tabs" id="br-tabs">
          <button data-tab="places" class="${open === 'places' ? 'active' : ''}">The branches</button>
          <button data-tab="people" class="${open === 'people' ? 'active' : ''}">Who works where</button>
        </div>
        <div id="br-body">${UI.loading()}</div>`;

      const body = el.querySelector('#br-body');
      el.querySelectorAll('#br-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#br-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await tabs[open](body);
    },
  });

  // ------------------------------------------------------------- the branches
  async function placesTab(body) {
    const { rows } = await API.get('/api/branches?all=1');

    body.innerHTML = `
      <div class="alert info">
        A branch is stamped on everything recorded in it — every visit, bill, payment and
        expense — from the moment it is opened. The code is two to four letters and is
        printed in the middle of every asset label, so it is worth choosing one that will
        still make sense in five years. A branch is never deleted; one that closes is
        marked closed and its history stays where it is.
      </div>
      <div class="card">
        <div class="card-head">
          <h3>The clinic's places</h3>
          <button class="btn primary" id="br-new">Open a branch</button>
        </div>
        <table class="table">
          <thead><tr><th>Code</th><th>Branch</th><th>Where</th><th>Sign-in lands here</th>
            <th>Open</th><th></th></tr></thead>
          <tbody>${rows.map((b) => `
            <tr class="${b.active ? '' : 'muted'}">
              <td><b>${UI.esc(b.code)}</b></td>
              <td>${UI.esc(b.name)}</td>
              <td class="small">${UI.esc(b.address || '—')}</td>
              <td>${b.is_default ? '<span class="pill ok">Default</span>' : ''}</td>
              <td>${b.active ? '<span class="pill ok">Open</span>'
                : '<span class="pill">Closed</span>'}</td>
              <td class="right"><button class="btn small ghost" data-edit="${b.id}">Edit</button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

    body.querySelector('#br-new').addEventListener('click', () => edit(null, body));
    body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      edit(rows.find((r) => r.id === Number(b.dataset.edit)), body);
    }));
  }

  function edit(row, body) {
    UI.modal({
      title: row ? `${row.code} — ${row.name}` : 'Open a branch',
      body: `
        <div class="grid2">
          <label>Code
            <input name="code" value="${row ? UI.esc(row.code) : ''}" maxlength="4"
                   placeholder="MPM" style="text-transform:uppercase">
            <span class="hint">Two to four letters. It goes into every asset code.</span>
          </label>
          <label>Branch name
            <input name="name" value="${row ? UI.esc(row.name) : ''}"
                   placeholder="Samiha Healthcare, Melapalayam">
          </label>
        </div>
        <label>Address
          <textarea name="address" rows="2"
            placeholder="Nethaji Road, Melapalayam – 627 005">${row ? UI.esc(row.address || '') : ''}</textarea>
        </label>
        <label class="check"><input type="checkbox" name="isDefault"
          ${row && row.is_default ? 'checked' : ''}>
          Sign-ins land here when the person works in only one place</label>
        ${row ? `<label class="check"><input type="checkbox" name="active"
          ${row.active ? 'checked' : ''}> Open — staff may sign in and record work here</label>
          <div class="hint">Closing a branch keeps everything that happened there. It only
            stops new work being recorded against it.</div>` : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn primary" data-act="save">${row ? 'Save' : 'Open the branch'}</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const v = (n) => modal.querySelector(`[name="${n}"]`);
        const payload = {
          code: v('code').value, name: v('name').value, address: v('address').value,
          isDefault: v('isDefault').checked,
        };
        if (row) payload.active = v('active').checked;
        try {
          if (row) await API.patch(`/api/branches/${row.id}`, payload);
          else await API.post('/api/branches', payload);
          UI.ok(row ? 'Branch saved.' : 'Branch opened.');
          /*
           * The chip at the top of the screen and the picker both read the
           * list that came down at sign-in, so it is refreshed here rather
           * than left a rename behind.
           */
          try {
            const me = await API.get('/api/auth/me');
            APP.branches = me.branches || [];
            APP.branch = me.branch || APP.branch;
          } catch { /* the list refreshes at the next sign-in */ }
          await placesTab(body);
        } catch (err) { UI.err(err.message); return 'keep'; }
        return undefined;
      },
    });
  }

  // ---------------------------------------------------------- who works where
  async function peopleTab(body) {
    const [{ rows: branches }, staff] = await Promise.all([
      API.get('/api/branches'),
      API.get('/api/masters/staff'),
    ]);
    const people = (staff.rows || staff).filter((u) => u.active !== 0);

    const SEES_ALL = ['owner', 'admin'];
    const byId = new Map(branches.map((b) => [b.id, b]));
    const names = (u) => {
      if (SEES_ALL.includes(u.role)) return '<span class="pill ok">Every branch</span>';
      const list = (u.branch_ids || []).map((id) => byId.get(id)).filter(Boolean);
      if (!list.length) return '<span class="muted">Not posted — lands at the default</span>';
      return list.map((b) => `<span class="pill ${b.id === u.branch_id ? 'ok' : ''}">${
        UI.esc(b.code)}${b.id === u.branch_id ? ' · home' : ''}</span>`).join(' ')
        + (list.length > 1 && !u.branch_id ? ' <span class="muted small">asked each time</span>' : '');
    };

    body.innerHTML = `
      <div class="alert info">
        The owner and the administrator may sign in to any branch — that is what makes
        comparing them possible. Everybody else is posted to one, or to two when they
        genuinely cover both. Their home branch is where their sign-in lands before they
        choose anything.
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Name</th><th>Role</th><th>Posted to</th><th></th></tr></thead>
          <tbody>${people.map((u) => `
            <tr>
              <td><b>${UI.esc(u.name)}</b><div class="small muted">${UI.esc(u.staff_code || '')}</div></td>
              <td>${UI.esc(u.role)}</td>
              <td>${names(u)}</td>
              <td class="right"><button class="btn small ghost" data-post="${u.id}">${
                SEES_ALL.includes(u.role) ? 'Where they land' : 'Post'}</button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

    body.querySelectorAll('[data-post]').forEach((b) => b.addEventListener('click', () => {
      post(people.find((u) => u.id === Number(b.dataset.post)), branches, body);
    }));
  }

  function post(user, branches, body) {
    const held = new Set(user.branch_ids || (user.branch_id ? [user.branch_id] : []));
    const seesAll = ['owner', 'admin'].includes(user.role);
    UI.modal({
      title: `Where ${user.name} works`,
      size: 'narrow',
      body: `
        ${seesAll ? `<div class="alert info">As ${user.role === 'owner' ? 'the owner' : 'an administrator'}
          they may sign in to any branch whatever is set here. All this decides is where their
          sign-in lands; leave the home branch blank and they are asked each morning.</div>` : ''}
        <div class="grid">${branches.map((b) => `
          <label class="check"><input type="checkbox" name="b" value="${b.id}"
            ${held.has(b.id) ? 'checked' : ''}> <b>${UI.esc(b.code)}</b> — ${UI.esc(b.name)}</label>`).join('')}
        </div>
        <label class="mt">Home branch — where their sign-in lands
          <select name="home">
            <option value="" ${user.branch_id ? '' : 'selected'}>Ask them every time</option>
            ${branches.map((b) => `
            <option value="${b.id}" ${b.id === user.branch_id ? 'selected' : ''}>
              ${UI.esc(b.code)} — ${UI.esc(b.name)}</option>`).join('')}</select>
          <span class="hint">Somebody who genuinely splits their week between two places is
            better asked: a home branch they have to remember to change is a day's work
            filed under the wrong building.</span>
        </label>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn primary" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const ids = [...modal.querySelectorAll('[name="b"]:checked')].map((c) => Number(c.value));
        if (!ids.length) { UI.err('Post them to at least one branch.'); return 'keep'; }
        const chosen = modal.querySelector('[name="home"]').value;
        const homeId = chosen ? Number(chosen) : null;
        if (homeId && !ids.includes(homeId)) {
          UI.err('Their home branch has to be one of the branches they are posted to.');
          return 'keep';
        }
        try {
          await API.post(`/api/branches/staff/${user.id}`, { branchIds: ids, homeId });
          UI.ok(`${user.name} posted.`);
          await peopleTab(body);
        } catch (err) { UI.err(err.message); return 'keep'; }
        return undefined;
      },
    });
  }
}());
