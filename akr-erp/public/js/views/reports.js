/* The handful of reports the company actually runs. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  APP.register('reports', {
    title: 'Reports',
    subtitle: 'By application, by account, and what moved',

    async render(host) {
      const to = UI.today();
      const from = `${to.slice(0, 4)}-01-01`;
      host.innerHTML = `
        <div class="card">
          <div class="filters">
            <label class="field"><span>From</span><input id="f-from" type="date" value="${from}"></label>
            <label class="field"><span>To</span><input id="f-to" type="date" value="${to}"></label>
          </div>
        </div>
        <div id="out">${UI.loading()}</div>`;

      const load = async () => {
        const out = document.getElementById('out');
        out.innerHTML = UI.loading();
        const q = API.qs({
          from: document.getElementById('f-from').value,
          to: document.getElementById('f-to').value,
        });

        const jobs = [API.get('/api/reports/item-movement' + q)];
        if (APP.can(['kam', 'accounts', 'sales'])) {
          jobs.push(API.get('/api/reports/by-application' + q));
          jobs.push(API.get('/api/reports/quotation-conversion' + q));
        }
        if (APP.can(['kam', 'accounts'])) jobs.push(API.get('/api/reports/top-partners' + q));
        const [movement, byApp, conversion, top] = await Promise.all(jobs);

        out.innerHTML = `
          ${byApp ? `<div class="card">
            <h3>By application</h3>
            <div class="card-sub">The five applications the company trades into — what we sold and
              what we bought for each.</div>
            <div class="grid g2">
              <div><b class="small">Sold</b>${UI.table([
                { label: 'Application', key: 'application' },
                { label: 'Invoices', num: true, key: 'invoices' },
                { label: 'Revenue', num: true, render: (r) => UI.money(r.revenue, { symbol: false }) },
                APP.seesCost() ? { label: 'Margin', num: true,
                  render: (r) => `${UI.money(r.margin, { symbol: false })} <span class="muted small">${r.margin_percent}%</span>` } : null,
              ].filter(Boolean), byApp.sales, { emptyText: 'Nothing invoiced in this period.' })}</div>
              <div><b class="small">Bought</b>${UI.table([
                { label: 'Application', key: 'application' },
                { label: 'LPOs', num: true, key: 'orders' },
                { label: 'Value', num: true, render: (r) => UI.money(r.value, { symbol: false }) },
              ], byApp.purchases, { emptyText: 'Nothing ordered in this period.' })}</div>
            </div>
          </div>` : ''}

          ${top ? `<div class="card">
            <h3>Who we traded with</h3>
            <div class="grid g2">
              <div><b class="small">Clients</b>${UI.table([
                { label: 'Client', key: 'name' },
                { label: 'Invoices', num: true, key: 'invoices' },
                { label: 'Value', num: true, render: (r) => UI.money(r.value, { symbol: false }) },
                { label: 'Outstanding', num: true, render: (r) => (r.outstanding
                  ? `<b>${UI.money(r.outstanding, { symbol: false })}</b>` : '—') },
              ], top.clients, { emptyText: 'Nothing yet.' })}</div>
              <div><b class="small">Manufacturers</b>${UI.table([
                { label: 'Supplier', key: 'name' },
                { label: 'Invoices', num: true, key: 'invoices' },
                { label: 'Value', num: true, render: (r) => UI.money(r.value, { symbol: false }) },
                { label: 'Outstanding', num: true, render: (r) => (r.outstanding
                  ? `<b>${UI.money(r.outstanding, { symbol: false })}</b>` : '—') },
              ], top.suppliers, { emptyText: 'Nothing yet.' })}</div>
            </div>
          </div>` : ''}

          ${conversion ? `<div class="card">
            <h3>Quotations, and what came of them</h3>
            <div class="card-sub">Quoted against converted, per person.</div>
            ${UI.table([
              { label: 'Raised by', key: 'name' },
              { label: 'Quoted', num: true, key: 'quoted' },
              { label: 'Value quoted', num: true, render: (r) => UI.money(r.quoted_value, { symbol: false }) },
              { label: 'Won', num: true, key: 'won' },
              { label: 'Value won', num: true, render: (r) => UI.money(r.won_value, { symbol: false }) },
              { label: 'Lost', num: true, key: 'lost' },
              { label: 'Win rate', num: true, render: (r) => `${r.win_rate}%` },
            ], conversion.rows, { emptyText: 'No quotations in this period.' })}
          </div>` : ''}

          <div class="card">
            <h3>What moved</h3>
            <div class="card-sub">Received into the yard and delivered out, item by item.</div>
            ${UI.table([
              { label: 'Item', render: (r) => `<span class="mono small">${esc(r.item_code)}</span> ${esc(r.name)}` },
              { label: 'Line', key: 'category_name' },
              { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
              { label: 'Received', num: true, render: (r) => `${UI.qty(r.received)} ${esc(r.uom)}` },
              { label: 'Delivered', num: true, render: (r) => `<b>${UI.qty(r.delivered)}</b> ${esc(r.uom)}` },
            ], movement.rows, { emptyText: 'Nothing moved in this period.' })}
          </div>`;
      };

      host.querySelectorAll('.filters input').forEach((el) => el.addEventListener('change', load));
      await load();
    },
  });
})();
