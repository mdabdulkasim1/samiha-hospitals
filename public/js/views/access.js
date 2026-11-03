/* Screen access — the owner decides what each role is shown. */
(function () {
  'use strict';

  /*
   * A grid of roles against screens, and a tick where the screen appears.
   *
   * Said plainly on the screen itself, because the distinction is easy to
   * get wrong and expensive to be wrong about: this sets what somebody is
   * shown, not what they are allowed to do. Every endpoint keeps enforcing
   * its own roles. A cashier with Billing hidden is still a cashier to the
   * server; the financial reports still refuse everybody except the owner,
   * the administrator and the counsellor. Unticking a box tidies a menu —
   * it does not lock a door, and nobody should plan as though it did.
   */

  APP.register('access', {
    title: 'Screen access',
    subtitle: 'What each role is shown — the owner\'s to set',

    async render(el) {
      const d = await API.get('/api/access');
      const hidden = JSON.parse(JSON.stringify(d.hidden || {}));
      const shows = (role, id) => !(hidden[role] || []).includes(id);

      // Only roles the screen is actually offered to: a tick-box for a screen
      // a nurse could never open either way is a decision with no effect.
      const relevant = (id) => d.roles.filter((r) => ROLE_SEES[id] === '*'
        || (ROLE_SEES[id] || []).includes(r));

      const groups = [...new Set(d.screens.map((s) => s.group))];

      el.innerHTML = `
        <div class="alert info">
          <b>This sets what each role is shown, not what they may do.</b>
          Unticking a screen takes it off that role's menu and out of their way. It does not
          change who the system lets near anything — every screen keeps its own rules underneath,
          so a cashier whose Billing is hidden is still a cashier, and the financial reports still
          go only to you, the administrator and the financial counsellor.
          <div class="mt">Your own menu is never affected. Account &amp; System stays on
            everyone's, because that is where a person changes their own password.</div>
        </div>

        ${groups.map((g) => `
          <div class="card mb"><div class="card-head"><h3>${UI.esc(g)}</h3></div>
            <div class="card-body tight"><div class="table-wrap"><table class="access-grid">
              <thead><tr><th>Screen</th>
                ${d.roles.map((r) => `<th class="num">${UI.esc(UI.titleise(r))}</th>`).join('')}
              </tr></thead>
              <tbody>${d.screens.filter((s) => s.group === g).map((s) => `
                <tr>
                  <td><b>${UI.esc(s.label)}</b></td>
                  ${d.roles.map((r) => `<td class="num">${
                    relevant(s.id).includes(r)
                      ? `<input type="checkbox" data-role="${UI.esc(r)}" data-screen="${UI.esc(s.id)}"
                           ${shows(r, s.id) ? 'checked' : ''}
                           aria-label="${UI.esc(s.label)} for ${UI.esc(r)}">`
                      : '<span class="muted" title="This role has no access to this screen anyway">—</span>'
                  }</td>`).join('')}
                </tr>`).join('')}
              </tbody>
            </table></div></div></div>`).join('')}

        <div class="btn-row">
          <button class="btn" id="ac-save">Save what each role sees</button>
          <button class="btn ghost" id="ac-all">Show everything to everyone</button>
          <span class="muted small" id="ac-note"></span>
        </div>`;

      const note = el.querySelector('#ac-note');
      el.querySelectorAll('input[type=checkbox]').forEach((box) => {
        box.addEventListener('change', () => {
          const { role, screen } = box.dataset;
          const list = new Set(hidden[role] || []);
          if (box.checked) list.delete(screen); else list.add(screen);
          hidden[role] = [...list];
          note.textContent = 'Not saved yet.';
        });
      });

      el.querySelector('#ac-all').addEventListener('click', () => {
        el.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = true; });
        for (const r of Object.keys(hidden)) delete hidden[r];
        note.textContent = 'Everything ticked. Not saved yet.';
      });

      el.querySelector('#ac-save').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await API.put('/api/access', { hidden });
          note.textContent = '';
          UI.ok('Saved. Each person sees the change when they next load the page.');
        } catch (err) {
          UI.err(err.message);
        } finally { e.target.disabled = false; }
      });
    },
  });

  /*
   * Which roles a screen is offered to at all, mirroring the navigation in
   * app.js. A screen a role can never open is shown as a dash rather than an
   * unticked box, so the grid says "not applicable" instead of implying the
   * owner has switched something off.
   */
  const ROLE_SEES = {
    dashboard: '*', queue: '*', patients: '*', track: '*',
    whatsapp: '*', reports: '*', workflow: '*', assets: '*',
    enquiries: ['admin', 'reception', 'counselor', 'cashier'],
    appointments: ['admin', 'reception', 'nurse', 'doctor', 'counselor', 'cashier'],
    vitals: ['admin', 'nurse', 'doctor'],
    myclinic: ['admin', 'doctor'],
    consult: ['admin', 'doctor'],
    lab: ['admin', 'lab', 'doctor', 'nurse', 'reception', 'cashier'],
    pharmacy: ['admin', 'pharmacy', 'nurse', 'reception', 'cashier'],
    ipd: ['admin', 'ward', 'nurse', 'doctor', 'reception', 'cashier'],
    billing: ['admin', 'cashier', 'counselor'],
    insurance: ['admin', 'cashier', 'reception', 'counselor'],
    rates: ['admin', 'cashier', 'reception'],
    financial: ['admin', 'counselor'],
    accounts: ['admin', 'counselor', 'cashier'],
    staff: ['admin'],
  };
})();
