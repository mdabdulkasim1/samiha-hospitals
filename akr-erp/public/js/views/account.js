/* Your own account, and what this system is set up as. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  APP.register('account', {
    title: 'My Account',
    subtitle: 'Your sign-in, your desk, and how this system is configured',

    async render(host) {
      const c = APP.company || {};
      host.innerHTML = `
        <div class="grid g2">
          <div class="card">
            <h3>You</h3>
            <div class="card-sub">${esc(APP.user.name)} · ${esc(APP.roleLabel(APP.user.role))}</div>
            ${UI.facts([
              ['Staff code', `<span class="mono">${esc(APP.user.staffCode)}</span>`],
              ['Email', esc(APP.user.email || '—')],
              ['Company', esc(APP.user.companyName || '—')],
              ['Prices', APP.seesPrices() ? UI.badge('visible', 'ok') : UI.badge('hidden')],
              ['The books', APP.seesMoney() ? UI.badge('visible', 'ok') : UI.badge('hidden')],
              ['Costs & margin', APP.seesCost() ? UI.badge('visible', 'ok') : UI.badge('hidden')],
            ])}
            <h4 class="mt">Change your password</h4>
            <form id="pw-form">
              ${UI.password({ name: 'currentPassword', label: 'Current password', required: true })}
              ${UI.password({ name: 'newPassword', label: 'New password', required: true,
                autocomplete: 'new-password', meter: true,
                hint: 'At least 8 characters, with a letter and a number.' })}
              ${UI.password({ name: 'confirm', label: 'Type it again', required: true,
                autocomplete: 'new-password' })}
              <button class="btn mt" type="submit">Change it</button>
            </form>
            <div id="pw-out"></div>
          </div>
          <div class="card">
            <h3>This company</h3>
            <div class="card-sub">What is printed at the head of every document.</div>
            ${UI.facts([
              ['Name', esc(c.name || '—')],
              ['TRN', c.trn ? `<span class="mono">${esc(c.trn)}</span>`
                : UI.badge('not set — a tax invoice needs one', 'danger')],
              ['Address', esc(c.address || '—')],
              ['Telephone', esc(c.phone || '—')],
              ['Email', esc(c.email || '—')],
              ['Website', esc(c.website || '—')],
              ['Currency', esc(APP.currency)],
              ['VAT', `${APP.vatPercent}%`],
              ['Bank', esc([c.bankName, c.iban].filter(Boolean).join(' · ') || '—')],
            ])}
            ${APP.can(['admin']) ? '<button class="btn ghost mt" id="to-masters">Edit under Masters</button>' : ''}
            <h4 class="mt">The group</h4>
            <div class="muted small mb">Every document is numbered per company, so the six sets of
              books never share a reference.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Company', render: (r) => `${esc(r.name)}${r.is_default ? ' ' + UI.badge('default', 'ok') : ''}` },
            ], APP.group.companies || [])}
          </div>
        </div>`;

      UI.wirePasswords(host);
      const toMasters = document.getElementById('to-masters');
      if (toMasters) toMasters.addEventListener('click', () => APP.navigate('masters'));

      document.getElementById('pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = UI.formValues(e.target);
        const out = document.getElementById('pw-out');
        if (v.newPassword !== v.confirm) {
          out.innerHTML = '<div class="alert danger mt">The two passwords do not match.</div>';
          return;
        }
        try {
          const res = await API.post('/api/auth/change-password', v);
          out.innerHTML = `<div class="alert ok mt">${esc(res.message)}</div>`;
          e.target.reset();
        } catch (err) {
          out.innerHTML = `<div class="alert danger mt">${esc(err.message)}</div>`;
        }
      });
    },
  });
})();
