/* Management reporting: trends, productivity, turnaround, revenue, audit. */
(function () {
  'use strict';

  APP.register('reports', {
    title: 'Reports',
    subtitle: 'Operations, revenue and turnaround',

    async render(el) {
      el.innerHTML = `
        <div class="tabs" id="r-tabs">
          <button class="active" data-tab="trend">Footfall trend</button>
          <button data-tab="turnaround">Turnaround</button>
          <button data-tab="revenue">Revenue</button>
          <button data-tab="doctors">Doctor productivity</button>
          ${APP.can(['admin']) ? '<button data-tab="audit">Audit log</button>' : ''}
        </div>
        <div id="r-body">${UI.loading()}</div>`;

      const body = el.querySelector('#r-body');

      const tabs = {
        async trend() {
          const days = 30;
          const rows = await API.get(`/api/reports/trend?days=${days}`);
          const total = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
          body.innerHTML = `
            <div class="grid c4 mb">
              <div class="stat teal"><div class="label">Visits (30 days)</div><div class="value">${UI.num(total('visits'))}</div></div>
              <div class="stat crimson"><div class="label">Appointments</div><div class="value">${UI.num(total('appointments'))}</div></div>
              <div class="stat ok"><div class="label">Collected</div><div class="value">${UI.money(total('collected'))}</div></div>
              <div class="stat orange"><div class="label">Admissions</div><div class="value">${UI.num(total('admissions'))}</div></div>
            </div>
            <div class="card"><div class="card-head"><h3>Daily visits</h3></div>
              <div class="card-body">${UI.sparkline(rows.map((r) => r.visits), rows.map((r) => r.day))}</div></div>
            <div class="card"><div class="card-head"><h3>Daily collections</h3></div>
              <div class="card-body">${UI.sparkline(rows.map((r) => r.collected), rows.map((r) => r.day))}</div></div>
            <div class="card"><div class="card-head"><h3>Day by day</h3></div>
              <div class="card-body tight">${UI.table([
                { label: 'Date', render: (r) => UI.esc(UI.date(r.day)) },
                { label: 'Visits', num: true, key: 'visits' },
                { label: 'Appointments', num: true, key: 'appointments' },
                { label: 'Admissions', num: true, key: 'admissions' },
                { label: 'Collected', num: true, render: (r) => UI.money(r.collected) },
              ], [...rows].reverse())}</div></div>`;
        },

        async turnaround() {
          const t = await API.get('/api/reports/turnaround');
          const m = t.minutes;
          const stages = [
            ['Arrival → check-in', m.arrivalToCheckIn],
            ['Check-in → vitals', m.checkInToVitals],
            ['Vitals → provider', m.vitalsToProvider],
            ['Consultation', m.consultation],
            ['Provider → exit', m.providerToExit],
          ].filter(([, v]) => v !== null);

          body.innerHTML = `
            <div class="grid c2 mb">
              <div class="stat crimson"><div class="label">Door-to-door average</div>
                <div class="value">${m.totalDoorToDoor !== null ? UI.num(m.totalDoorToDoor, 1) + ' min' : '—'}</div>
                <div class="foot">Across ${UI.num(t.sample)} completed visit(s)</div></div>
              <div class="stat teal"><div class="label">Time with the doctor</div>
                <div class="value">${m.consultation !== null ? UI.num(m.consultation, 1) + ' min' : '—'}</div>
                <div class="foot">Average consultation length</div></div>
            </div>
            <div class="card"><div class="card-head"><h3>Where the time goes</h3>
              <span class="muted small">Average minutes per workflow stage</span></div>
              <div class="card-body">
                ${stages.length ? UI.bars(stages.map(([label, value]) =>
                  ({ label, value, display: UI.num(value, 1) + ' min' })), { colour: 'orange' })
                  : UI.empty('Not enough completed visits yet.', '⏱')}
                <div class="muted small mt">Long waits between two stages point at where to add a nurse or
                  a counselor — the same lanes as the workflow map.</div>
              </div></div>`;
        },

        async revenue() {
          const r = await API.get('/api/reports/revenue');
          body.innerHTML = `
            <div class="grid c4 mb">
              <div class="stat ok"><div class="label">Collected (30 days)</div>
                <div class="value">${UI.money(r.byMode.reduce((s, m) => s + m.total, 0))}</div></div>
              <div class="stat teal"><div class="label">Sliding-scale given</div>
                <div class="value">${UI.money(r.concessions.sliding_scale)}</div></div>
              <div class="stat orange"><div class="label">Assistance &amp; write-offs</div>
                <div class="value">${UI.money(r.concessions.assistance)}</div></div>
              <div class="stat crimson"><div class="label">Outstanding</div>
                <div class="value">${UI.money(r.outstanding.amount)}</div>
                <div class="foot">${UI.num(r.outstanding.invoices)} open invoice(s)</div></div>
            </div>
            <div class="grid c2">
              <div class="card"><div class="card-head"><h3>Revenue by service line</h3></div>
                <div class="card-body">${UI.bars(r.byCategory.map((c) =>
                  ({ label: UI.titleise(c.category || 'other'), value: c.amount, display: UI.money(c.amount) })))}</div></div>
              <div class="card"><div class="card-head"><h3>Collections by mode</h3></div>
                <div class="card-body">${UI.bars(r.byMode.map((m) =>
                  ({ label: UI.titleise(m.mode), value: m.total, display: UI.money(m.total) })), { colour: 'crimson' })}</div></div>
            </div>`;
        },

        async doctors() {
          const rows = await API.get('/api/reports/doctor-productivity');
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Doctor productivity — last 30 days</h3></div>
            <div class="card-body tight">${UI.table([
              { label: 'Doctor', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.department || '')}</div>` },
              { label: 'Visits', num: true, key: 'visits' },
              { label: 'Consultations', num: true, key: 'consultations' },
              { label: 'Admissions', num: true, key: 'admissions' },
              { label: 'Lab orders', num: true, key: 'lab_orders' },
              { label: 'Avg consult', num: true, render: (d) => d.avg_consult_minutes
                ? UI.num(d.avg_consult_minutes, 1) + ' min' : '—' },
            ], rows, { emptyText: 'No activity in this window.' })}</div></div>`;
        },

        async audit() {
          const rows = await API.get('/api/reports/audit?limit=200');
          body.innerHTML = `<div class="card"><div class="card-head"><h3>Audit log</h3>
            <span class="muted small">Most recent 200 actions</span></div>
            <div class="card-body tight">${UI.table([
              { label: 'When', render: (r) => UI.esc(UI.dateTime(r.created_at)) },
              { label: 'Who', render: (r) => UI.esc(r.actor || '—') },
              { label: 'Action', render: (r) => UI.badge(UI.titleise(r.action), 'teal') },
              { label: 'Entity', render: (r) => `${UI.esc(r.entity || '')} ${r.entity_id ? '#' + UI.esc(r.entity_id) : ''}` },
              { label: 'Details', render: (r) => `<div class="small muted">${UI.esc((r.details || '').slice(0, 100))}</div>` },
            ], rows, { emptyText: 'Nothing logged yet.' })}</div></div>`;
        },
      };

      el.querySelectorAll('#r-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#r-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab]();
      }));
      await tabs.trend();
    },
  });
})();
