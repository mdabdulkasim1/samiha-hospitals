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
      { id: 'vitals',      label: 'Vitals Station',   icon: '♥', roles: ['admin','nurse','doctor'] },
      { id: 'consult',     label: 'Consultation',     icon: '✚', roles: ['admin','doctor'] },
      { id: 'financial',   label: 'Financial Screening', icon: '⚖', roles: ['admin','counselor','reception','cashier'] },
      { id: 'lab',         label: 'Diagnostics',      icon: '⚗', roles: ['admin','lab','doctor','nurse','reception','cashier'] },
      { id: 'pharmacy',    label: 'Pharmacy',         icon: '⚕', roles: ['admin','pharmacy','doctor','nurse','reception','cashier'] },
    ]},
    { group: 'In-patient', items: [
      { id: 'ipd',         label: 'Wards & Beds',     icon: '⌸', roles: ['admin','ward','nurse','doctor','reception','cashier'] },
    ]},
    { group: 'Money', items: [
      { id: 'billing',     label: 'Billing & Payments', icon: '₹', roles: ['admin','cashier','reception','counselor'] },
      { id: 'insurance',   label: 'Insurance & TPA',    icon: '⛨', roles: ['admin','cashier','reception','counselor','doctor','ward','nurse'] },
    ]},
    { group: 'Channels & insight', items: [
      { id: 'whatsapp',    label: 'WhatsApp',         icon: '✆', roles: '*' },
      { id: 'reports',     label: 'Reports',          icon: '◔', roles: '*' },
      { id: 'workflow',    label: 'Workflow Map',     icon: '⇄', roles: '*' },
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
              ${UI.field({ name: 'password', label: 'Password', type: 'password', required: true })}
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
        document.getElementById('login-error').innerHTML =
          `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
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

  // ------------------------------------------------------------------ shell
  function renderShell() {
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
            <button id="logout">Sign out</button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="titles">
              <h1 id="page-title">Dashboard</h1>
              <div class="sub" id="page-sub"></div>
            </div>
            <div class="spacer"></div>
            <div id="page-actions" class="btn-row"></div>
          </header>
          <div class="content" id="view"><div class="loading"><span class="spinner"></span></div></div>
        </div>
      </div>`;

    renderNav();
    document.getElementById('logout').addEventListener('click', APP.logout);
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

  window.addEventListener('hashchange', router);
  window.addEventListener('samiha:unauthorised', renderLogin);
  document.addEventListener('DOMContentLoaded', APP.boot);
  if (document.readyState !== 'loading') APP.boot();
})();
