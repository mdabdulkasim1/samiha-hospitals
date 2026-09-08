/* Application shell: sign-in, navigation, hash routing. */
(function () {
  'use strict';

  /*
   * Who sees what. The lists mirror the role gates on the server (see
   * src/lib/auth.js and the route files) — hiding a screen here is a courtesy
   * so nobody is shown a door they cannot open, not the lock itself.
   */
  const NAV = [
    { group: 'Overview', items: [
      { id: 'dashboard', label: 'Dashboard', icon: '▦', roles: '*' },
    ] },
    { group: 'Selling — to our clients', items: [
      { id: 'enquiries', label: 'Enquiries', icon: '☏', roles: ['sales', 'kam'] },
      { id: 'quotations', label: 'Our Quotations', icon: '◫', roles: ['sales', 'kam', 'accounts'] },
      { id: 'orders', label: 'Client LPOs', icon: '✓', roles: ['sales', 'kam', 'accounts', 'logistics'] },
      { id: 'deliveries', label: 'Deliveries', icon: '⇥', roles: ['logistics', 'kam', 'sales', 'accounts'] },
      { id: 'invoices', label: 'Tax Invoices', icon: '₳', roles: ['accounts', 'kam', 'sales'] },
    ] },
    { group: 'Buying — from manufacturers', items: [
      { id: 'supplier-quotations', label: 'Supplier Quotations', icon: '◨', roles: ['kam', 'accounts'] },
      { id: 'purchase-orders', label: 'Our LPOs', icon: '⇧', roles: ['kam', 'logistics', 'accounts'] },
      { id: 'goods-receipts', label: 'Goods Receipts', icon: '⇤', roles: ['logistics', 'kam', 'accounts'] },
      { id: 'supplier-bills', label: 'Supplier Bills', icon: '⛁', roles: ['accounts', 'kam'] },
    ] },
    { group: 'Stock', items: [
      { id: 'stock', label: 'Stock Register', icon: '▤', roles: '*' },
      { id: 'catalogue', label: 'Item Master', icon: '⚙', roles: '*' },
    ] },
    { group: 'Money', items: [
      { id: 'payments', label: 'Payments & Receipts', icon: '⇄', roles: ['accounts', 'kam'] },
      { id: 'cheques', label: 'Cheque Register', icon: '✎', roles: ['accounts', 'kam'] },
      { id: 'expenses', label: 'Expenses & Income', icon: '⊟', roles: ['accounts', 'kam'] },
      { id: 'ledgers', label: 'Ledgers & Ageing', icon: '≡', roles: ['accounts', 'kam'] },
      // What the business made, and what it owes the FTA. The company's own
      // decision: this one is the administrator's alone.
      { id: 'vat', label: 'VAT & Profit', icon: '%', roles: ['admin'] },
    ] },
    { group: 'Accounts & setup', items: [
      { id: 'partners', label: 'Suppliers & Clients', icon: '☺', roles: '*' },
      { id: 'trace', label: 'Trace a Reference', icon: '⌕', roles: '*' },
      { id: 'reports', label: 'Reports', icon: '◔', roles: '*' },
      // The key account manager keeps the terms & conditions, so Masters is
      // open to them too — the other tabs there are read-only for anyone but
      // an administrator, which is the same rule the server enforces.
      { id: 'masters', label: 'Masters', icon: '⚒', roles: ['admin', 'kam'] },
      { id: 'staff', label: 'Staff', icon: '⚑', roles: ['admin'] },
      { id: 'account', label: 'My Account', icon: '⚙', roles: '*' },
    ] },
  ];

  const APP = {
    user: null,
    company: {},
    group: { companies: [] },
    currency: 'AED',
    currencySymbol: 'AED',
    vatPercent: 5,
    permissions: {},
    tagline: 'Trusted Trading Partner for Valves, Fittings & Construction Materials',
    route: 'dashboard',
    params: {},
    views: {},
    masters: null,

    can(roles) {
      if (roles === '*') return true;
      if (!APP.user) return false;
      return APP.user.role === 'admin' || roles.includes(APP.user.role);
    },
    canOpen(route) {
      const item = NAV.flatMap((g) => g.items).find((i) => i.id === route);
      return item ? APP.can(item.roles) : true;
    },
    seesPrices() { return Boolean(APP.permissions.seesPrices); },
    seesMoney() { return Boolean(APP.permissions.seesMoney); },
    seesCost() { return Boolean(APP.permissions.seesCost); },

    navigate(route, params) {
      const qs = params && Object.keys(params).length
        ? '?' + new URLSearchParams(params).toString() : '';
      window.location.hash = '#/' + route + qs;
    },

    register(id, view) { APP.views[id] = view; },

    /** Every dropdown's contents, fetched once and kept. */
    async loadMasters(force) {
      if (APP.masters && !force) return APP.masters;
      APP.masters = await API.get('/api/masters/bootstrap');
      return APP.masters;
    },
    /** The application titles — potable water, storm water, and the rest. */
    applications() { return (APP.masters && APP.masters.applications) || []; },
    paymentTerms(side) {
      const all = (APP.masters && APP.masters.paymentTerms) || [];
      return side ? all.filter((t) => t.applies_to === 'both' || t.applies_to === side) : all;
    },
    termsOptions(side) {
      return APP.paymentTerms(side).map((t) => ({ value: t.id, label: t.name }));
    },
    applicationOptions() {
      return APP.applications().map((a) => ({ value: a.id, label: a.name }));
    },
    companyOptions() {
      return (APP.group.companies || []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
    },

    async boot() {
      try {
        const me = await API.get('/api/auth/me');
        Object.assign(APP, me);
        await APP.loadMasters(true);
        renderShell();
        await router();
        refreshBadges();
        setInterval(refreshBadges, 60000);
      } catch {
        renderLogin();
      }
    },

    async logout() {
      try { await API.post('/api/auth/logout'); } catch { /* already gone */ }
      API.setToken(null);
      APP.user = null;
      APP.masters = null;
      renderLogin();
    },
  };
  window.APP = APP;

  /*
   * Where the mark lives. Signed out there is no company record yet, so the
   * sign-in page falls back to the file in assets; everywhere else it comes
   * from the company, which is what makes swapping the artwork a one-line
   * change rather than a search through the source.
   */
  const LOGO_FULL = '/api/branding/full';

  // ------------------------------------------------------------------ login
  function renderLogin() {
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    document.getElementById('root').innerHTML = `
      <div class="login-shell">
        <div class="login-hero">
          <img class="logo-full" src="${LOGO_FULL}" alt="AKR General Trading L.L.C"
               onerror="this.onerror=null;this.src='/assets/logo.svg'">
          <h1>Trading ERP</h1>
          <p>One system for both sides of the trade — the quotation you ask a manufacturer for and
             the LPO you send them, and the quotation you give a client and the LPO they send back —
             over one item master, one stock register and one set of books.</p>
          <ul>
            <li>⇄ <span><b>Both sides on one item code.</b> The same valve on your LPO to the maker
                and on the client's tax invoice.</span></li>
            <li>▤ <span><b>A stock register that counts what is coming.</b> An LPO you have sent shows
                as material on order, a receipt brings it into the yard, a delivery takes it out.</span></li>
            <li>% <span><b>5% VAT both ways, and payment terms per account.</b> Advance, cheque against
                delivery, 30 to 120 days, PDC or LC — chosen on every document.</span></li>
          </ul>
        </div>
        <div class="login-panel">
          <div class="login-card">
            <h2>Sign in</h2>
            <div class="muted mb">Use your work email or your employee code.</div>
            <form id="login-form">
              ${UI.field({ name: 'username', label: 'Email or staff code', required: true, placeholder: 'sales@akr365.com' })}
              ${UI.password({ name: 'password', label: 'Password', required: true })}
              <button class="btn block mt" type="submit">Sign in</button>
            </form>
            <div id="login-error"></div>
            <div class="demo-accounts">
              <h4>Desks in this system</h4>
              <div class="demo-grid">
                ${[['admin@akr365.com', 'Administrator'], ['kam@akr365.com', 'Key Account Manager'],
                   ['accounts@akr365.com', 'Accounts'], ['sales@akr365.com', 'Sales Officer'],
                   ['logistics@akr365.com', 'Logistics']]
                  .map(([email, role]) => `<button data-email="${UI.esc(email)}"><b>${UI.esc(role)}</b>${UI.esc(email)}</button>`).join('')}
              </div>
              <div class="muted small mt">Starter password <code>akr@2026</code> — change every one of
                them before this touches real trading data.</div>
            </div>
          </div>
        </div>
      </div>`;

    const form = document.getElementById('login-form');
    UI.wirePasswords(document.getElementById('root'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        const res = await API.post('/api/auth/login', UI.formValues(form));
        API.setToken(res.token);
        await APP.boot();
      } catch (err) {
        document.getElementById('login-error').innerHTML =
          `<div class="alert danger mt"><b>${UI.esc(err.message)}</b>
            <div class="small mt">Check the spelling, and use the eye to see what you typed —
            Caps Lock is the usual culprit.</div></div>`;
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });

    document.querySelectorAll('.demo-grid button').forEach((b) => {
      b.addEventListener('click', () => {
        form.querySelector('[name=username]').value = b.dataset.email;
        form.querySelector('[name=password]').focus();
      });
    });
  }

  // ------------------------------------------------------------------ shell
  function renderShell() {
    if (window.UI && UI.closeAllModals) UI.closeAllModals();
    document.getElementById('root').innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <div class="mark"><img src="${UI.esc(APP.company.logo || '/assets/logo-icon.svg')}" alt=""
                 onerror="this.onerror=null;this.src='/assets/logo-icon.svg'"></div>
            <div class="brand-text"><strong>AKR</strong><span>General Trading</span></div>
          </div>
          <nav class="nav" id="nav"></nav>
          <div class="sidebar-foot">
            <div class="who">${UI.esc(APP.user.name)}</div>
            <div class="role">${UI.esc(roleLabel(APP.user.role))}</div>
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
              🔔<span class="dot" id="bell-count" hidden></span>
            </button>
          </header>
          <div class="content" id="view">${UI.loading()}</div>
        </div>
      </div>
      <div class="nav-backdrop" id="nav-backdrop"></div>`;

    renderNav();
    document.getElementById('logout').addEventListener('click', APP.logout);
    document.getElementById('my-account').addEventListener('click', () => APP.navigate('account'));
    document.getElementById('bell').addEventListener('click', openAlerts);
    startAlertPolling();

    const toggle = document.getElementById('nav-toggle');
    const setDrawer = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setDrawer(!document.body.classList.contains('nav-open')));
    document.getElementById('nav-backdrop').addEventListener('click', () => setDrawer(false));
    document.getElementById('nav').addEventListener('click', (e) => {
      if (e.target.closest('a')) setDrawer(false);
    });
    window.addEventListener('hashchange', () => setDrawer(false));
  }

  function roleLabel(role) {
    return { admin: 'Administrator', kam: 'Key Account Manager', accounts: 'Accounts',
      sales: 'Sales Officer', logistics: 'Logistics' }[role] || UI.titleise(role);
  }
  APP.roleLabel = roleLabel;

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

  /** Live counters, so work arriving at a desk is visible from anywhere. */
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
      set('enquiries', d.sell.enquiries_open);
      set('orders', d.sell.awaiting_delivery);
      set('invoices', d.sell.awaiting_invoice);
      set('supplier-quotations', d.buy.quotations_to_approve);
      set('purchase-orders', d.buy.lpos_draft);
      set('supplier-bills', d.buy.bills_unbooked);
      set('cheques', d.cash ? d.cash.cheques_pending : 0);
      APP.dashboard = d;
    } catch { /* the dashboard is best-effort */ }
  }
  APP.refreshBadges = refreshBadges;

  // ----------------------------------------------------------------- alerts
  let alertTimer = null;
  function startAlertPolling() {
    clearInterval(alertTimer);
    refreshAlertCount();
    alertTimer = setInterval(refreshAlertCount, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAlertCount(); });
  }

  async function refreshAlertCount() {
    if (!APP.user) return;
    try {
      const { unread } = await API.get('/api/me/notifications/count');
      const dot = document.getElementById('bell-count');
      if (!dot) return;
      dot.textContent = unread > 99 ? '99+' : String(unread);
      dot.hidden = !unread;
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
        ${n.read_at ? '' : '<span class="unread-dot"></span>'}
      </button>`).join('')
      : UI.empty('Nothing has come in yet. Work sent to your desk will appear here.', '🔔');

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
          if (route) window.location.hash = route;
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
        `<div class="alert danger">Your desk (<b>${UI.esc(roleLabel(APP.user.role))}</b>) does not have
          access to ${UI.esc(navItem.label)}.</div>`;
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

  APP.actions = function (buttons) {
    const host = document.getElementById('page-actions');
    if (!host) return;
    host.innerHTML = buttons.filter(Boolean).map((b) =>
      `<button class="btn ${b.kind || 'ghost'} ${b.size || ''}" data-action="${UI.esc(b.id)}">${UI.esc(b.label)}</button>`).join('');
    host.querySelectorAll('[data-action]').forEach((btn) => {
      const def = buttons.find((b) => b && b.id === btn.dataset.action);
      btn.addEventListener('click', () => def.onClick(btn));
    });
  };

  APP.setSubtitle = function (text) {
    const el = document.getElementById('page-sub');
    if (el) el.textContent = text;
  };

  window.addEventListener('hashchange', router);
  window.addEventListener('akr:unauthorised', renderLogin);
  document.addEventListener('DOMContentLoaded', APP.boot);
  if (document.readyState !== 'loading') APP.boot();
})();
