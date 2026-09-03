/* My account, and — for administrators — recovery email, backups and mail health. */
(function () {
  'use strict';

  APP.register('account', {
    title: 'Account & System',
    subtitle: 'Your password, recovery email and backups',

    async render(el) {
      const isAdmin = APP.can(['admin']);
      el.innerHTML = `
        <div class="tabs" id="ac-tabs">
          <button class="active" data-tab="password">My password</button>
          ${isAdmin ? '<button data-tab="clinic">Clinic &amp; payments</button>' : ''}
          ${isAdmin ? '<button data-tab="system">Recovery &amp; email</button>' : ''}
          ${isAdmin ? '<button data-tab="backups">Backups</button>' : ''}
          ${isAdmin ? '<button data-tab="staff">Staff access</button>' : ''}
        </div>
        <div id="ac-body"></div>`;

      const body = el.querySelector('#ac-body');
      const tabs = { password: passwordTab, clinic: clinicTab, system: systemTab,
        backups: backupTab, staff: staffTab };
      el.querySelectorAll('#ac-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#ac-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await passwordTab(body);
    },
  });

  /**
   * What the clinic calls itself on paper, and where a patient's money goes.
   *
   * The UPI ID is the one thing here a patient acts on: it is drawn as the QR
   * code on every printed bill, and whatever it points at is where the money
   * lands. So it is checked for shape, and shown back as a live code to scan —
   * whoever sets it can hold their own phone to the screen and read the
   * account name before a single patient ever does.
   */
  async function clinicTab(body) {
    const draw = async () => {
      const data = await API.get('/api/admin/clinic');
      const field = (key) => data.fields.find((f) => f.key === key) || { value: '', fallback: '' };
      const box = (key, label, hint) => {
        const f = field(key);
        return UI.field({
          name: key, label, value: f.value,
          placeholder: f.fallback ? f.fallback : '',
          hint: hint || (f.fallback && !f.value ? `Leaving this blank uses “${f.fallback}”.` : ''),
        });
      };

      body.innerHTML = `
        <div class="grid c2">
          <div class="card">
            <div class="card-head"><h3>Collecting by UPI</h3>
              <span class="muted small">Printed as a QR code on every bill</span></div>
            <div class="card-body">
              ${data.upi.configured
                ? '<div class="alert ok">Bills print a scannable code for whatever is still to collect.</div>'
                : `<div class="alert warn">No UPI account is set, so bills print without a payment code.
                     Enter the clinic's collection ID below.</div>`}
              <form id="upi-form">
                ${box('clinic.upiId', 'UPI ID', 'The clinic\'s own collection ID — samiha@okicici, 7200750420@ybl.')}
                ${box('clinic.upiName', 'Payee name', 'What shows in the patient\'s app before they confirm.')}
                <button class="btn block" type="submit">Save</button>
              </form>
              ${data.upi.sampleSvg ? `
                <div class="mt" style="display:flex;gap:14px;align-items:center">
                  <div style="width:130px;flex:none">${data.upi.sampleSvg}</div>
                  <div class="muted small">A sample code for <b>₹1</b>. Scan it with your own phone:
                    the account name it offers to pay is the one every patient will see.
                    <div class="mt">Paying to <b>${UI.esc(data.profile.upiId)}</b></div></div>
                </div>` : ''}
              <div id="upi-out"></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>On every document</h3>
              <span class="muted small">Letterhead of the prescription, report and bill</span></div>
            <div class="card-body">
              <form id="cl-form">
                ${box('clinic.name', 'Clinic name')}
                ${box('clinic.address', 'Address')}
                ${box('clinic.phone', 'Phone')}
                ${box('clinic.email', 'Email')}
                ${box('clinic.gstin', 'GSTIN', 'Printed on the tax invoice when set.')}
                <button class="btn block" type="submit">Save</button>
              </form>
              <div class="alert info mt">Changes show on documents printed from a fresh sign-in.</div>
              <div id="cl-out"></div>
            </div>
          </div>
        </div>`;

      const save = async (formId, outId) => {
        const form = body.querySelector(formId);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          try {
            const patch = {};
            form.querySelectorAll('input, textarea').forEach((i) => { patch[i.name] = i.value; });
            await API.patch('/api/admin/clinic', patch);
            UI.ok('Saved.');
            await draw();
          } catch (err) {
            body.querySelector(outId).innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
            btn.disabled = false;
          }
        });
      };
      await save('#upi-form', '#upi-out');
      await save('#cl-form', '#cl-out');
    };

    await draw();
  }

  function passwordTab(body) {
    body.innerHTML = `
      <div class="grid c2">
        <div class="card">
          <div class="card-head"><h3>Change your password</h3></div>
          <div class="card-body">
            <form id="cp-form">
              ${UI.password({ name: 'currentPassword', label: 'Current password', required: true })}
              ${UI.password({ name: 'newPassword', label: 'New password', required: true,
                autocomplete: 'new-password', meter: true,
                hint: 'At least 8 characters, with a letter and a number.' })}
              ${UI.password({ name: 'confirm', label: 'Type the new one again', required: true,
                autocomplete: 'new-password' })}
              <button class="btn block" type="submit">Change password</button>
            </form>
            <div id="cp-out"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Signed in as</h3></div>
          <div class="card-body">
            <dl class="kv">
              <dt>Name</dt><dd>${UI.esc(APP.user.name)}</dd>
              <dt>Role</dt><dd>${UI.badge(UI.titleise(APP.user.role), 'teal')}</dd>
              <dt>Staff code</dt><dd><code>${UI.esc(APP.user.staffCode)}</code></dd>
              <dt>Email</dt><dd>${UI.esc(APP.user.email || '—')}</dd>
              ${APP.user.departmentName ? `<dt>Department</dt><dd>${UI.esc(APP.user.departmentName)}</dd>` : ''}
            </dl>
            <div class="alert info mt">
              Changing your password signs out every other device you are logged in on.
              A confirmation is emailed to you and to the clinic's recovery mailbox.
            </div>
          </div>
        </div>
      </div>`;

    UI.wirePasswords(body);
    body.querySelector('#cp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = UI.formValues(e.target);
      const out = body.querySelector('#cp-out');
      if (v.newPassword !== v.confirm) {
        out.innerHTML = '<div class="alert danger mt">The two new passwords do not match.</div>';
        return;
      }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await API.post('/api/auth/change-password', {
          currentPassword: v.currentPassword, newPassword: v.newPassword,
        });
        out.innerHTML = `<div class="alert ok mt">${UI.esc(res.note || 'Password changed.')}</div>`;
        e.target.reset();
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
      } finally { btn.disabled = false; }
    });
  }

  async function systemTab(body) {
    const s = await API.get('/api/admin/system');
    const h = s.mail.health;
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Recovery mailbox</h3></div>
        <div class="card-body">
          <div class="alert ${h.ok ? 'ok' : 'danger'}">
            <b>${UI.esc(s.recoveryEmail)}</b> —
            ${h.ok
              ? (h.provider === 'smtp'
                  ? `connected to ${UI.esc(h.host)} as ${UI.esc(h.user)}.`
                  : 'offline mode. Nothing is actually emailed; reset links appear in the WhatsApp/outbox list instead.')
              : `could not connect: ${UI.esc(h.error || '')}`}
          </div>
          <p class="muted small">Every password-reset link and every backup notice is copied to this
            address, so an account can be recovered even if the staff member has lost access to their
            own inbox.</p>

          <dl class="kv mt">
            <dt>Provider</dt><dd>${UI.esc(s.mail.provider)}</dd>
            <dt>From</dt><dd>${UI.esc(s.mail.from)}</dd>
            <dt>SMTP host</dt><dd>${UI.esc(s.mail.host)}</dd>
            <dt>SMTP user</dt><dd>${UI.esc(s.mail.user || '—')}</dd>
            <dt>Reset link expiry</dt><dd>${UI.esc(s.mail.resetTtlMinutes)} minutes</dd>
            <dt>App URL in links</dt><dd>${UI.esc(s.appUrl)}</dd>
          </dl>

          <div class="btn-row mt">
            <button class="btn ghost" id="test-mail">Send a test email</button>
          </div>
          <div id="mail-out"></div>

          ${s.mail.provider !== 'smtp' ? `<div class="alert warn mt">
            <b>To send real email</b>, set these in the environment and restart:
            <pre class="mono small" style="background:var(--line-2);padding:10px;border-radius:7px;overflow-x:auto;margin-top:8px">MAIL_PROVIDER=smtp
SMTP_USER=${UI.esc(s.recoveryEmail)}
SMTP_PASS=&lt;16-character Gmail App Password&gt;
APP_URL=https://your-domain</pre>
            <div class="small mt">Gmail needs an <b>App Password</b>, not the account password:
              Google Account → Security → 2-Step Verification → App passwords.</div>
          </div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>This installation</h3></div>
        <div class="card-body"><dl class="kv">
          <dt>Environment</dt><dd>${UI.esc(s.environment)}</dd>
          <dt>Database</dt><dd class="mono small">${UI.esc(s.database)}</dd>
          <dt>WhatsApp</dt><dd>${UI.esc(s.whatsappProvider)}</dd>
          <dt>Accounts</dt><dd>${UI.num(s.counts.users)}</dd>
          <dt>Patients</dt><dd>${UI.num(s.counts.patients)}</dd>
          <dt>Visits</dt><dd>${UI.num(s.counts.visits)}</dd>
          <dt>Invoices</dt><dd>${UI.num(s.counts.invoices)}</dd>
        </dl></div>
      </div>`;

    body.querySelector('#test-mail').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const out = body.querySelector('#mail-out');
      out.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
      try {
        const r = await API.post('/api/admin/system/test-email', {});
        out.innerHTML = r.ok
          ? `<div class="alert ok mt">${r.mocked
              ? 'Offline mode — the message was written to the outbox instead of being sent.'
              : `Sent to ${UI.esc(r.recipients.join(', '))}. Check the inbox.`}</div>`
          : `<div class="alert danger mt">Could not send: ${UI.esc(r.error)}</div>`;
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
      } finally { e.target.disabled = false; }
    });
  }

  async function backupTab(body) {
    const b = await API.get('/api/admin/backups');
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Database backups</h3>
          <button class="btn" id="take-backup">Take a backup now</button></div>
        <div class="card-body">
          <div class="alert info">
            Snapshots are written to <code>${UI.esc(b.dir)}</code> and the newest
            <b>${UI.esc(b.retention)}</b> are kept. A notice goes to the recovery mailbox each time.
            <div class="small mt"><b>Download a copy off this machine regularly</b> — a backup that
              lives only on the same disk as the database is not a backup.</div>
          </div>
          <div id="bk-out"></div>
        </div>
        <div class="card-body tight" id="bk-list"></div>
      </div>`;

    const draw = (rows) => {
      body.querySelector('#bk-list').innerHTML = UI.table([
        { label: 'File', render: (r) => `<code>${UI.esc(r.filename)}</code>` },
        { label: 'Taken', render: (r) => UI.esc(UI.dateTime(r.created_at)) },
        { label: 'Type', render: (r) => UI.badge(UI.titleise(r.kind), r.kind === 'scheduled' ? 'teal' : '') },
        { label: 'Size', num: true, render: (r) => r.status === 'ok' ? `${UI.esc(r.sizeMb)} MB` : '—' },
        { label: 'By', render: (r) => UI.esc(r.created_by_name || 'system') },
        { label: 'Status', render: (r) => r.status === 'ok'
          ? UI.statusBadge(r.onDisk ? 'ok' : 'closed')
          : `${UI.badge('Failed', 'danger')}<div class="muted small">${UI.esc(r.error || '')}</div>` },
        { label: '', render: (r) => r.status === 'ok' && r.onDisk
          ? `<div class="btn-row">
               <a class="btn ghost sm" href="/api/admin/backups/${encodeURIComponent(r.filename)}/download">Download</a>
               <button class="btn ghost sm" data-del="${UI.esc(r.filename)}">Delete</button>
             </div>` : '' },
      ], rows, { emptyText: 'No backups taken yet.' });

      body.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!(await UI.confirm(`Delete ${btn.dataset.del}? This cannot be undone.`, { danger: true }))) return;
        await API.del(`/api/admin/backups/${encodeURIComponent(btn.dataset.del)}`);
        UI.ok('Backup deleted.');
        backupTab(body);
      }));
    };
    draw(b.rows);

    body.querySelector('#take-backup').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const out = body.querySelector('#bk-out');
      out.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
      try {
        const made = await API.post('/api/admin/backups', {});
        out.innerHTML = `<div class="alert ok mt">Backup <code>${UI.esc(made.filename)}</code>
          (${UI.esc(made.sizeMb)} MB) taken${made.pruned && made.pruned.length
            ? `, ${made.pruned.length} old file(s) pruned` : ''}.</div>`;
        UI.ok('Backup taken.');
        backupTab(body);
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
        e.target.disabled = false;
      }
    });
  }

  async function staffTab(body) {
    const staff = await API.get('/api/masters/staff');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Staff access</h3>
        <span class="muted small">Send someone a reset link without knowing their password</span></div>
      <div class="card-body tight" id="st-list"></div></div>
      <div id="st-out"></div>`;

    body.querySelector('#st-list').innerHTML = UI.table([
      { label: 'Name', render: (u) => `<b>${UI.esc(u.name)}</b><div class="muted small">${UI.esc(u.staff_code)}</div>` },
      { label: 'Role', render: (u) => UI.badge(UI.titleise(u.role), 'teal') },
      { label: 'Email', render: (u) => UI.esc(u.email || '—') },
      { label: 'Department', render: (u) => UI.esc(u.department_name || '—') },
      { label: 'Active', render: (u) => u.active ? UI.badge('Yes', 'ok') : UI.badge('Disabled', 'danger') },
      { label: '', render: (u) => u.email && u.active
        ? `<button class="btn ghost sm" data-reset="${u.id}">Send reset link</button>` : '' },
    ], staff, { emptyText: 'No staff accounts.' });

    body.querySelectorAll('[data-reset]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const out = body.querySelector('#st-out');
      try {
        const r = await API.post(`/api/admin/users/${btn.dataset.reset}/send-reset`, {});
        out.innerHTML = `<div class="alert ok mt">${UI.esc(r.message)}</div>` +
          (r.devLink ? `<div class="alert warn">Offline mode — give them this link directly:
            <div class="mono small mt" style="word-break:break-all">${UI.esc(r.devLink)}</div></div>` : '');
        UI.ok('Reset link sent.');
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
      } finally { btn.disabled = false; }
    }));
  }
})();
