/* Application shell: authentication, navigation, hash routing. */
(function () {
  'use strict';

  const NAV = [
    { group: 'Front office', items: [
      { id: 'dashboard',   label: 'Dashboard',        icon: '▦', roles: '*' },
      { id: 'queue',       label: 'Patient Queue',    icon: '⛭', roles: '*' },
      { id: 'enquiries',   label: 'Enquiries',        icon: '☏', roles: ['admin','reception','counselor','cashier'] },
      { id: 'appointments',label: 'Appointments',     icon: '▤', roles: ['admin','reception','nurse','doctor','counselor','cashier'] },
      { id: 'patients',    label: 'Patients',         icon: '☺', roles: '*' },
    ]},
    { group: 'Clinical', items: [
      { id: 'vitals',      label: 'Nurse Station',   icon: '♥', roles: ['admin','nurse','doctor'] },
      { id: 'myclinic',    label: 'My Clinic',        icon: '⌚', roles: ['admin','doctor'] },
      { id: 'consult',     label: 'Consultation',     icon: '✚', roles: ['admin','doctor'] },
      { id: 'financial',   label: 'Financial Screening', icon: '⚖', roles: ['admin','counselor','reception','cashier'] },
      { id: 'lab',         label: 'Diagnostics',      icon: '⚗', roles: ['admin','lab','doctor','nurse','reception','cashier'] },
      { id: 'pharmacy',    label: 'Pharmacy',         icon: '⚕', roles: ['admin','pharmacy','doctor','nurse','reception','cashier'] },
    ]},
    { group: 'In-patient', items: [
      { id: 'ipd',         label: 'Wards & Beds',     icon: '⌸', roles: ['admin','ward','nurse','doctor','reception','cashier'] },
    ]},
    { group: 'Money', items: [
      { id: 'billing',     label: 'Billing & Payments', icon: '₹', roles: ['admin','cashier','counselor'] },
      // Insurance is its own desk: plenty of patients pay for themselves, and
      // chasing a TPA is not a doctor's or a nurse's job.
      { id: 'insurance',   label: 'Insurance & TPA',    icon: '⛨', roles: ['admin','cashier','reception','counselor'] },
      // What the clinic charges for what. Management's to set, everyone
      // else's to bill against, so it is read-only unless you are an admin.
      { id: 'rates',       label: 'Services & Rates',   icon: '₨', roles: ['admin','cashier','reception'] },
    ]},
    { group: 'Channels & insight', items: [
      { id: 'whatsapp',    label: 'WhatsApp',         icon: '✆', roles: '*' },
      { id: 'reports',     label: 'Reports',          icon: '◔', roles: '*' },
      { id: 'workflow',    label: 'Workflow Map',     icon: '⇄', roles: '*' },
      { id: 'staff',       label: 'Staff & Doctors',  icon: '⚕', roles: ['admin'] },
      { id: 'account',     label: 'Account & System', icon: '⚙', roles: '*' },
    ]},
  ];

  const APP = {
    user: null,
    clinic: {},
    route: 'dashboard',
    params: {},
    badges: {},
    views: {},

    can(roles) {
      if (roles === '*') return true;
      if (!APP.user) return false;
      return APP.user.role === 'admin' || roles.includes(APP.user.role);
    },

    navigate(route, params) {
      const qs = params && Object.keys(params).length
        ? '?' + new URLSearchParams(params).toString() : '';
      window.location.hash = '#/' + route + qs;
    },

    /** Register a view: { render(container, params), title, subtitle }. */
    register(id, view) { APP.views[id] = view; },

    async boot() {
      // A reset link must work whether or not anyone is signed in.
      const reset = parseHash();
      if (reset.route === 'reset' && reset.params.token) {
        return renderReset(reset.params.token);
      }
      try {
        const me = await API.get('/api/auth/me');
        APP.user = me.user;
        APP.clinic = me.clinic;
        APP.whatsappProvider = me.whatsappProvider;
        renderShell();
        await router();
        refreshBadges();
        setInterval(refreshBadges, 45000);
      } catch {
        renderLogin();
      }
    },

    async logout() {
      try { await API.post('/api/auth/logout'); } catch { /* already gone */ }
      API.setToken(null);
      APP.user = null;
      renderLogin();
    },
  };
  window.APP = APP;

  // ------------------------------------------------------------------ login
  function renderLogin() {
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    document.getElementById('root').innerHTML = `
      <div class="login-shell">
        <div class="login-hero">
          <img class="logo-full" src="/assets/logo.svg" alt="Samiha Healthcare">
          <h1>Polyclinic &amp; Diagnostics ERP</h1>
          <p>One system from the first enquiry to the patient walking out — appointments, registration,
             financial screening, vitals, consultation, diagnostics, pharmacy, billing and in-patient care.</p>
          <ul>
            <li>✆ <span><b>WhatsApp booking</b> — patients book, confirm and cancel appointments in chat.</span></li>
            <li>⚖ <span><b>Financial screening</b> — sliding-scale bands and assistance programmes built in.</span></li>
            <li>⌸ <span><b>In-patient records</b> — beds, rounds, medication charts and discharge summaries.</span></li>
          </ul>
        </div>
        <div class="login-panel">
          <div class="login-card">
            <h2>Staff sign in</h2>
            <div class="muted">Use your staff email or employee code.</div>
            <form id="login-form">
              ${UI.field({ name: 'username', label: 'Email or staff code', required: true, placeholder: 'reception@samiha.local' })}
              ${UI.password({ name: 'password', label: 'Password', required: true })}
              <div class="row-between mb" style="margin-top:-6px">
                <span></span>
                <button type="button" class="link-btn" id="forgot-link">Forgotten your password?</button>
              </div>
              <button class="btn block" type="submit">Sign in</button>
            </form>
            <div id="login-error"></div>
            <div class="demo-accounts">
              <h4>Demo desks — password <code>samiha@123</code></h4>
              <div class="demo-grid">
                ${[['admin@samiha.local','Administrator'],['reception@samiha.local','Front desk'],
                   ['counselor@samiha.local','Financial counselor'],['nurse@samiha.local','Nurse / M.A.'],
                   ['imran@samiha.local','Dr. Imran (Medicine)'],['lab@samiha.local','Lab technician'],
                   ['pharmacy@samiha.local','Pharmacist'],['cashier@samiha.local','Cashier'],
                   ['ward@samiha.local','Ward sister']]
                  .map(([email, role]) => `<button data-email="${UI.esc(email)}"><b>${UI.esc(role)}</b>${UI.esc(email)}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>`;

    const form = document.getElementById('login-form');
    UI.wirePasswords(document.getElementById('root'));
    document.getElementById('forgot-link').addEventListener('click', () =>
      openForgotPassword(form.querySelector('[name=username]').value.trim()));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        const values = UI.formValues(form);
        const res = await API.post('/api/auth/login', values);
        API.setToken(res.token);
        await APP.boot();
      } catch (err) {
        // "Invalid credentials" most often means a mistyped password, so point
        // at the eye and the reset link rather than just restating the error.
        document.getElementById('login-error').innerHTML =
          `<div class="alert danger mt"><b>${UI.esc(err.message)}</b>
             <div class="small mt">Check the spelling, and use the eye icon to see what you typed.
             Caps Lock is a common culprit.
             <button type="button" class="link-btn" id="err-forgot">Reset your password</button>.</div>
           </div>`;
        const link = document.getElementById('err-forgot');
        if (link) link.addEventListener('click', () =>
          openForgotPassword(form.querySelector('[name=username]').value.trim()));
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });

    document.querySelectorAll('.demo-grid button').forEach((b) => {
      b.addEventListener('click', () => {
        form.querySelector('[name=username]').value = b.dataset.email;
        form.querySelector('[name=password]').value = 'samiha@123';
        form.querySelector('[name=password]').focus();
      });
    });
  }

  // ------------------------------------------------------- password recovery
  function openForgotPassword(prefill) {
    UI.modal({
      title: 'Reset your password',
      size: 'narrow',
      body: `<p class="muted">Enter your staff email or employee code. We will email a reset link to
          your address, with a copy to the clinic's recovery mailbox so you can always get back in.</p>
        <form id="fp-form">
          ${UI.field({ name: 'username', label: 'Email or staff code', required: true, value: prefill || '' })}
        </form>
        <div id="fp-out"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="send">Send reset link</button>`,
      onMount(modal) {
        const input = modal.querySelector('[name=username]');
        if (input && !prefill) input.focus();
      },
      async onAction(act, modal) {
        if (act !== 'send') return;
        const form = modal.querySelector('#fp-form');
        if (!form.reportValidity()) return 'keep';
        const out = modal.querySelector('#fp-out');
        out.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
        try {
          const res = await API.post('/api/auth/forgot-password', UI.formValues(form));
          out.innerHTML = `<div class="alert ok mt">${UI.esc(res.message)}</div>` +
            (res.devLink
              ? `<div class="alert warn"><b>Offline mode.</b> ${UI.esc(res.devNote || '')}
                   <div class="mt"><a href="${UI.esc(res.devLink)}" class="btn sm block">Open the reset link</a></div>
                 </div>`
              : '');
        } catch (err) {
          out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
        }
        return 'keep';
      },
    });
  }

  /**
   * The screen a reset link opens. Reachable signed out, so it lives outside
   * the normal router.
   */
  async function renderReset(token) {
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="login-shell">
        <div class="login-hero">
          <img class="logo-full" src="/assets/logo.svg" alt="Samiha Healthcare">
          <h1>Choose a new password</h1>
          <p>Pick something you have not used elsewhere. Everyone signed in with the old
             password will be signed out.</p>
        </div>
        <div class="login-panel">
          <div class="login-card" id="reset-card"><div class="loading"><span class="spinner"></span></div></div>
        </div>
      </div>`;

    const card = document.getElementById('reset-card');
    let info;
    try {
      info = await API.get(`/api/auth/reset-password/${encodeURIComponent(token)}`);
    } catch (err) {
      card.innerHTML = `<h2>Link no longer valid</h2>
        <div class="alert danger mt">${UI.esc(err.message)}</div>
        <button class="btn block mt" id="back-login">Back to sign in</button>`;
      document.getElementById('back-login').addEventListener('click', () => {
        window.location.hash = '';
        renderLogin();
      });
      return;
    }

    card.innerHTML = `
      <h2>New password</h2>
      <div class="muted mb">for <b>${UI.esc(info.name)}</b> · ${UI.esc(info.email || info.staffCode)}</div>
      <form id="reset-form">
        ${UI.password({ name: 'newPassword', label: 'New password', required: true,
          autocomplete: 'new-password', meter: true,
          hint: 'At least 8 characters, with a letter and a number.' })}
        ${UI.password({ name: 'confirm', label: 'Type it again', required: true, autocomplete: 'new-password' })}
        <button class="btn block" type="submit">Set the new password</button>
      </form>
      <div id="reset-out"></div>`;

    UI.wirePasswords(card);
    document.getElementById('reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = UI.formValues(e.target);
      const out = document.getElementById('reset-out');
      if (v.newPassword !== v.confirm) {
        out.innerHTML = '<div class="alert danger mt">The two passwords do not match. Use the eye icon to compare them.</div>';
        return;
      }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await API.post('/api/auth/reset-password', { token, newPassword: v.newPassword });
        out.innerHTML = `<div class="alert ok mt">${UI.esc(res.message)}</div>`;
        setTimeout(() => { window.location.hash = ''; renderLogin(); }, 1600);
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------------ shell
  function renderShell() {
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    document.getElementById('root').innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <div class="mark"><img src="/assets/logo-icon.svg" alt=""></div>
            <div class="brand-text"><strong>SAMIHA</strong><span>Healthcare</span></div>
          </div>
          <nav class="nav" id="nav"></nav>
          <div class="sidebar-foot">
            <div class="who">${UI.esc(APP.user.name)}</div>
            <div class="role">${UI.esc(APP.user.role)}${APP.user.departmentName ? ' · ' + UI.esc(APP.user.departmentName) : ''}</div>
            <div class="btn-row" style="margin-top:9px">
              <button id="my-account" style="flex:1">My account</button>
              <button id="logout" style="flex:1">Sign out</button>
            </div>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false">☰</button>
            <div class="titles">
              <h1 id="page-title">Dashboard</h1>
              <div class="sub" id="page-sub"></div>
            </div>
            <div class="spacer"></div>
            <div id="page-actions" class="btn-row"></div>
            <button class="bell" id="bell" title="Alerts" aria-label="Alerts">
              <span class="ico">🔔</span><span class="dot" id="bell-count" hidden></span>
            </button>
          </header>
          <div class="content" id="view"><div class="loading"><span class="spinner"></span></div></div>
        </div>
      </div>
      <div class="nav-backdrop" id="nav-backdrop"></div>`;

    renderNav();
    document.getElementById('logout').addEventListener('click', APP.logout);
    document.getElementById('my-account').addEventListener('click', () => APP.navigate('account'));
    document.getElementById('bell').addEventListener('click', openAlerts);
    startAlertPolling();

    // On a phone the navigation is a drawer; on a desktop the button is hidden
    // and this never fires.
    const toggle = document.getElementById('nav-toggle');
    const setDrawer = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setDrawer(!document.body.classList.contains('nav-open')));
    document.getElementById('nav-backdrop').addEventListener('click', () => setDrawer(false));
    // Choosing a destination is the end of navigating, so the drawer closes.
    document.getElementById('nav').addEventListener('click', (e) => {
      if (e.target.closest('a')) setDrawer(false);
    });
    window.addEventListener('hashchange', () => setDrawer(false));
  }

  // ----------------------------------------------------------------- alerts
  /**
   * The bell. A doctor who is not at the clinic still needs to know that the
   * front desk has just booked someone into their list, so the badge polls
   * quietly and the panel is one tap from anywhere in the ERP.
   */
  let alertTimer = null;

  function startAlertPolling() {
    clearInterval(alertTimer);
    refreshAlertCount();
    alertTimer = setInterval(refreshAlertCount, 60000);
    // Coming back to the tab is the moment people look, so refresh then too.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAlertCount();
    });
  }

  async function refreshAlertCount() {
    if (!APP.user) return;
    try {
      const { unread } = await API.get('/api/me/notifications/count');
      const dot = document.getElementById('bell-count');
      if (!dot) return;
      dot.textContent = unread > 99 ? '99+' : String(unread);
      dot.hidden = !unread;
      document.getElementById('bell').classList.toggle('has-unread', !!unread);
    } catch { /* a failed poll is not worth a toast */ }
  }
  APP.refreshAlerts = refreshAlertCount;

  async function openAlerts() {
    const data = await API.get('/api/me/notifications?limit=30');
    const body = data.rows.length ? data.rows.map((n) => `
      <button type="button" class="alert-row${n.read_at ? '' : ' unread'}" data-alert="${n.id}"
              data-route="${UI.esc(n.route || '')}">
        <span class="alert-text">
          <b>${UI.esc(n.title)}</b>
          <span class="muted small">${UI.esc(n.body || '')}</span>
          <span class="muted small">${UI.esc(UI.dateTime(n.created_at))}</span>
        </span>
        ${n.read_at ? '' : '<span class="unread-dot" aria-label="unread"></span>'}
      </button>`).join('')
      : UI.empty('Nothing has come in yet. Bookings made for you will appear here.', '🔔');

    UI.modal({
      title: 'Alerts',
      size: 'narrow',
      body: `<div class="alert-list">${body}</div>`,
      footer: `${data.unread ? '<button class="btn ghost" data-act="all">Mark all read</button>' : ''}
               <button class="btn" data-act="__close">Close</button>`,
      onMount(modal) {
        modal.querySelectorAll('[data-alert]').forEach((b) => b.addEventListener('click', async () => {
          await API.post(`/api/me/notifications/${b.dataset.alert}/read`, {});
          refreshAlertCount();
          const route = b.dataset.route;
          UI.closeAllModals();
          if (route) window.location.hash = route.replace(/^#/, '#');
        }));
      },
      async onAction(act) {
        if (act !== 'all') return;
        await API.post('/api/me/notifications/read-all', {});
        refreshAlertCount();
        UI.ok('All alerts marked read.');
      },
    });
  }

  function renderNav() {
    document.getElementById('nav').innerHTML = NAV.map((g) => {
      const items = g.items.filter((i) => APP.can(i.roles));
      if (!items.length) return '';
      return `<div class="nav-group"><h5>${UI.esc(g.group)}</h5>` + items.map((i) =>
        `<a href="#/${i.id}" data-nav="${i.id}"><span class="ico">${i.icon}</span>${UI.esc(i.label)}` +
        `<span class="pill" data-badge="${i.id}" hidden></span></a>`).join('') + '</div>';
    }).join('');
    highlightNav();
  }

  function highlightNav() {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.classList.toggle('active', a.dataset.nav === APP.route);
    });
  }

  /** Live counters shown on the sidebar so staff see work arriving. */
  async function refreshBadges() {
    if (!APP.user) return;
    try {
      const d = await API.get('/api/reports/dashboard');
      const set = (id, n) => {
        const el = document.querySelector(`[data-badge="${id}"]`);
        if (!el) return;
        el.hidden = !n;
        el.textContent = n > 99 ? '99+' : n;
      };
      set('queue', d.opd.in_progress || 0);
      set('enquiries', d.enquiries.open || 0);
      set('lab', d.lab.pending || 0);
      set('financial', (d.financialScreening.waiting || 0) + (d.financialScreening.docs_pending || 0));
      set('pharmacy', d.pharmacy.lowStockCount || 0);
      set('insurance', d.insurance ? (d.insurance.actionable || 0) : 0);
      APP.badges = d;
    } catch { /* the dashboard is best-effort */ }
  }
  APP.refreshBadges = refreshBadges;

  // ----------------------------------------------------------------- router
  function parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [path, query] = raw.split('?');
    const params = {};
    new URLSearchParams(query || '').forEach((v, k) => { params[k] = v; });
    return { route: path || 'dashboard', params };
  }

  async function router() {
    if (!APP.user) return;
    // Any dialog belongs to the page it was opened from — including when the
    // hash changes through the browser's back button rather than APP.navigate.
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    const { route, params } = parseHash();
    const view = APP.views[route];

    if (!view) {
      APP.route = 'dashboard';
      window.location.hash = '#/dashboard';
      return;
    }

    const navItem = NAV.flatMap((g) => g.items).find((i) => i.id === route);
    if (navItem && !APP.can(navItem.roles)) {
      document.getElementById('view').innerHTML =
        `<div class="alert danger">Your role (<b>${UI.esc(APP.user.role)}</b>) does not have access to ${UI.esc(navItem.label)}.</div>`;
      return;
    }

    APP.route = route;
    APP.params = params;
    highlightNav();

    document.getElementById('page-title').textContent = view.title || UI.titleise(route);
    document.getElementById('page-sub').textContent = view.subtitle || '';
    document.getElementById('page-actions').innerHTML = '';

    const container = document.getElementById('view');
    container.innerHTML = UI.loading();
    try {
      await view.render(container, params);
    } catch (err) {
      container.innerHTML = `<div class="alert danger"><b>Could not load this page.</b><br>${UI.esc(err.message)}</div>`;
    }
  }
  APP.reload = router;

  /** Set the buttons in the top bar for the current view. */
  APP.actions = function (buttons) {
    const host = document.getElementById('page-actions');
    if (!host) return;
    host.innerHTML = buttons.map((b) =>
      `<button class="btn ${b.kind || 'ghost'} ${b.size || ''}" data-action="${UI.esc(b.id)}">${UI.esc(b.label)}</button>`).join('');
    host.querySelectorAll('[data-action]').forEach((btn) => {
      const def = buttons.find((b) => b.id === btn.dataset.action);
      btn.addEventListener('click', () => def.onClick(btn));
    });
  };

  APP.setSubtitle = function (text) {
    const el = document.getElementById('page-sub');
    if (el) el.textContent = text;
  };

  window.addEventListener('hashchange', () => {
    const { route, params } = parseHash();
    if (route === 'reset' && params.token) return renderReset(params.token);
    router();
  });
  window.addEventListener('samiha:unauthorised', renderLogin);
  document.addEventListener('DOMContentLoaded', APP.boot);
  if (document.readyState !== 'loading') APP.boot();
})();
