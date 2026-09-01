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
          ${/* Money and colleague-by-colleague numbers are management's, not a
                doctor's — a doctor reads their own day in My Clinic. */
            APP.can(['admin', 'reception', 'cashier']) ? `
            <button data-tab="revenue">Revenue</button>
            <button data-tab="doctors">Doctor productivity</button>
            <button data-tab="doctorMonthly">Doctor month by month</button>` : ''}
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

        /**
         * Each doctor's month: how many patients they saw and what those
         * patients billed. Revenue follows the visit or admission the invoice
         * was raised against, so a pharmacy or lab line on an OPD bill counts
         * to the doctor whose consultation put it there.
         */
        async doctorMonthly() {
          body.innerHTML = `
            <div class="card"><div class="card-head"><h3>Doctor month by month</h3>
              <select id="dm-months" style="max-width:170px">
                <option value="3">Last 3 months</option>
                <option value="6" selected>Last 6 months</option>
                <option value="12">Last 12 months</option>
              </select>
              <select id="dm-metric" style="max-width:210px">
                <option value="booked">Patients booked</option>
                <option value="visits">Visits attended</option>
                <option value="billed">Billed</option>
                <option value="collected">Collected</option>
              </select>
              <button class="btn ghost sm" id="dm-print">Print</button></div>
              <div id="dm-body">${UI.loading()}</div></div>`;

          const load = async () => {
            const months = body.querySelector('#dm-months').value;
            const metric = body.querySelector('#dm-metric').value;
            const data = await API.get('/api/reports/doctor-monthly' + API.qs({ months }));
            body.querySelector('#dm-body').innerHTML = doctorMonthlyTable(data, metric);
            body.querySelector('#dm-print').onclick = () => printDoctorMonthly(data, metric);
          };
          body.querySelector('#dm-months').addEventListener('change', load);
          body.querySelector('#dm-metric').addEventListener('change', load);
          await load();
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

      // ---------------------------------------------- doctor month by month
      /**
       * A month-across matrix: one row per doctor, one column per month, the
       * chosen metric in each cell, and a total column. Money and headcount
       * read differently, so the cell formats itself to the metric.
       */
      function doctorMonthlyTable(data, metric) {
        if (!data.rows.length) {
          return `<div class="card-body">${UI.empty(
            'No doctor has an appointment or a bill in this window.', '📅')}</div>`;
        }
        const isMoney = metric === 'billed' || metric === 'collected';
        const cell = (v) => (isMoney ? UI.money(v) : UI.num(v));
        // Shade each cell against the busiest month anyone had, so the eye finds
        // the heavy months without reading every number.
        const peak = Math.max(...data.rows.flatMap((r) => data.months.map((m) => r.months[m.key][metric])), 1);
        const shade = (v) => (v > 0 ? ` style="background:rgba(23,107,124,${(0.06 + 0.34 * (v / peak)).toFixed(3)})"` : '');

        const head = `<tr><th class="l">Doctor</th>` +
          data.months.map((m) => `<th class="num">${UI.esc(m.label)}</th>`).join('') +
          `<th class="num">Total</th><th class="num">Per patient</th></tr>`;

        const body = data.rows.map((r) => `<tr>
            <td><b>${UI.esc(r.name)}</b>
              <div class="muted small">${UI.esc(r.specialization || r.department || '')}</div></td>
            ${data.months.map((m) => {
              const v = r.months[m.key][metric];
              return `<td class="num"${shade(v)}>${v ? cell(v) : '<span class="muted">—</span>'}</td>`;
            }).join('')}
            <td class="num"><b>${cell(r.total[metric])}</b>
              ${metric === 'booked' && r.total.cancelled + r.total.no_shows
                ? `<div class="muted small">${UI.num(r.total.cancelled)} canc · ${UI.num(r.total.no_shows)} n/s</div>` : ''}
              ${metric === 'billed' && r.total.outstanding
                ? `<div class="muted small">${UI.money(r.total.outstanding)} due</div>` : ''}</td>
            <td class="num">${UI.money(r.total.perPatient)}</td>
          </tr>`).join('');

        const t = data.totals;
        const foot = `<tr class="tfoot">
            <td><b>All doctors</b></td>
            ${data.months.map((m) => `<td class="num"><b>${cell(t.byMonth[m.key][metric])}</b></td>`).join('')}
            <td class="num"><b>${cell(t.overall[metric])}</b></td>
            <td class="num"><b>${UI.money(t.overall.perPatient)}</b></td>
          </tr>`;

        return `<div class="table-wrap"><table class="matrix">
            <thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>
          <div class="muted small" style="padding:10px 16px">
            ${UI.esc(UI.date(data.from))} to ${UI.esc(UI.date(data.to))}.
            Billing follows the visit or admission the invoice was raised against, so pharmacy and
            diagnostics ordered in a consultation count to that doctor.
            <b>${UI.money(t.overall.outstanding)}</b> of ${UI.money(t.overall.billed)} billed is still outstanding.
          </div>`;
      }

      /** The same matrix as a sheet the administrator can sign and file. */
      function printDoctorMonthly(data, metric) {
        const labels = { booked: 'Patients booked', visits: 'Visits attended',
          billed: 'Billed', collected: 'Collected' };
        const isMoney = metric === 'billed' || metric === 'collected';
        const cell = (v) => (isMoney ? UI.money(v) : UI.num(v));
        UI.print(`<div class="doc">
          ${UI.docHeader('Doctor performance — month by month', [
            labels[metric], `${UI.date(data.from)} to ${UI.date(data.to)}`,
            `Printed ${UI.dateTime(new Date().toISOString())}`])}
          <table><thead><tr><th>Doctor</th><th>Speciality</th>
            ${data.months.map((m) => `<th class="num">${UI.esc(m.label)}</th>`).join('')}
            <th class="num">Total</th></tr></thead>
            <tbody>${data.rows.map((r) => `<tr>
              <td>${UI.esc(r.name)}</td><td>${UI.esc(r.specialization || r.department || '')}</td>
              ${data.months.map((m) => `<td class="num">${cell(r.months[m.key][metric])}</td>`).join('')}
              <td class="num"><b>${cell(r.total[metric])}</b></td></tr>`).join('')}
              <tr><td colspan="2"><b>All doctors</b></td>
              ${data.months.map((m) => `<td class="num"><b>${cell(data.totals.byMonth[m.key][metric])}</b></td>`).join('')}
              <td class="num"><b>${cell(data.totals.overall[metric])}</b></td></tr>
            </tbody></table>
          <div class="foot-note">Billing follows the visit or admission each invoice was raised against.
            Billed ${UI.money(data.totals.overall.billed)} · collected ${UI.money(data.totals.overall.collected)} ·
            outstanding ${UI.money(data.totals.overall.outstanding)}.</div>
          <div class="sign"><div>Prepared by</div><div>For ${UI.esc(APP.clinic.name)}</div></div>
        </div>`, 'Doctor performance by month');
      }

      el.querySelectorAll('#r-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#r-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab]();
      }));
      await tabs.trend();
    },
  });
})();
