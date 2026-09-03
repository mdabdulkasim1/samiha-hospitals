/* Management reporting: trends, productivity, turnaround, revenue, audit. */
(function () {
  'use strict';

  const { who, source, documents } = Drilldown;

  /**
   * A report tile you can open. Same bargain as the dashboard's: the list it
   * opens adds up to the figure printed on it. The window travels with the
   * click, because the tabs do not agree on one — the footfall trend counts
   * the last thirty days including today, revenue and turnaround count back
   * thirty days from now — and a list answering for the wrong fortnight would
   * be worse than no list.
   */
  const rstat = (cls, label, value, foot, drill) => {
    const inner = `<div class="label">${UI.esc(label)}</div><div class="value">${value}</div>` +
      (foot ? `<div class="foot">${foot}</div>` : '');
    if (!drill || !canOpen(drill.metric)) return `<div class="stat ${cls}">${inner}</div>`;
    return `<button type="button" class="stat ${cls} drillable"
      data-report="${UI.esc(JSON.stringify(drill))}"
      title="Show what makes up ${UI.esc(label.toLowerCase())}">${inner}</button>`;
  };

  /*
   * Mirrors the guard on /api/reports/detail; the server is what decides.
   *
   * Rupees are for the desks that handle them. What the clinic took is not the
   * business of a technician or a nurse, so a money list is not offered to
   * them — and would be refused if it were.
   */
  const MGMT = ['admin', 'reception', 'cashier'];
  const MONEY = ['admin', 'cashier', 'counselor'];
  const OPEN_TO_ALL = ['trend_visits', 'trend_appointments', 'trend_admissions',
    'turnaround_visits', 'trend_lab'];
  const MONEY_METRICS = ['trend_collected', 'revenue_sliding', 'revenue_assistance',
    'revenue_outstanding', 'doctor_month_billed', 'doctor_month_collected'];
  const canOpen = (metric) => (MONEY_METRICS.includes(metric)
    ? APP.can(MONEY)
    : OPEN_TO_ALL.includes(metric) || APP.can(MGMT));

  const when = (r) => UI.esc(UI.dateTime(r.at));
  const mins = (v) => (v === null || v === undefined ? '—' : UI.num(v, 1) + ' min');

  /**
   * A figure inside a table that opens what it counts. Zero is left as a plain
   * dash: there is nothing behind it to look at, and a pressable nothing only
   * invites a wasted click.
   */
  const drillNum = (drill, value, fmt) => (Number(value)
    ? `<button type="button" class="linknum" data-report="${UI.esc(JSON.stringify(drill))}"
         title="Show what makes up this number">${fmt(value)}</button>`
    : '<span class="muted">—</span>');

  /** One day of the footfall table. */
  const dayCell = (r, metric, value, fmt) =>
    drillNum({ metric, from: r.day, to: r.day }, value, fmt);

  /** How each report list is read. */
  const RCOLUMNS = {
    visits: [
      { label: 'Visit', render: (r) => `<b>${UI.esc(r.visit_no)}</b>` },
      { label: 'Patient', render: who },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
      { label: 'Stage', render: (r) => UI.statusBadge(r.status) },
      { label: 'Arrived', render: when },
    ],
    appointments: [
      { label: 'Appointment', render: (r) => `<b>${UI.esc(r.appt_no)}</b>` },
      { label: 'When', render: when },
      { label: 'Patient', render: (r) => `<b>${UI.esc(r.name || '—')}</b>` +
        `<div class="muted small">${UI.esc(r.phone || 'no number')}</div>` },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
      { label: 'Booked via', render: (r) => source(r.source) },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
    ],
    receipts: [
      { label: 'Receipt', render: (r) => `<b>${UI.esc(r.receipt_no)}</b>` +
        (r.invoice_no ? `<div class="muted small">${UI.esc(r.invoice_no)}</div>` : '') },
      { label: 'Patient', render: who },
      { label: 'Mode', render: (r) => UI.badge(UI.titleise(r.mode || '—'), 'info') },
      { label: 'Taken by', render: (r) => UI.esc(r.taken_by || '—') },
      { label: 'When', render: when },
      { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.amount)}</b>` },
      documents,
    ],
    admissions: [
      { label: 'IP No', render: (r) => `<b>${UI.esc(r.ip_no)}</b>` },
      { label: 'Patient', render: who },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
      { label: 'Bed', render: (r) => UI.esc([r.ward, r.bed_no].filter(Boolean).join(' · ') || '—') },
      { label: 'Admitted', render: when },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
    ],
    turnaround: [
      { label: 'Visit', render: (r) => `<b>${UI.esc(r.visit_no)}</b>` },
      { label: 'Patient', render: who },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
      { label: 'Arrived', render: when },
      { label: 'With the doctor', num: true, render: (r) => mins(r.consult_minutes) },
      { label: 'Door to door', num: true, render: (r) => mins(r.door_to_door_minutes) },
    ],
    concessions: [
      { label: 'Invoice', render: (r) => `<b>${UI.esc(r.invoice_no)}</b>` +
        `<div class="muted small">${UI.esc(UI.titleise(r.kind || ''))}</div>` },
      { label: 'Patient', render: who },
      { label: 'Raised', render: (r) => UI.esc(UI.date(r.at)) },
      { label: 'Invoice total', num: true, render: (r) => UI.money(r.net) },
      { label: 'Given', num: true, render: (r) => `<b>${UI.money(r.amount)}</b>` },
      documents,
    ],
    invoices: [
      { label: 'Invoice', render: (r) => `<b>${UI.esc(r.invoice_no)}</b>` +
        `<div class="muted small">${UI.esc(UI.titleise(r.kind || ''))}</div>` },
      { label: 'Patient', render: who },
      { label: 'Raised', render: (r) => UI.esc(UI.date(r.at)) },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      { label: 'Billed', num: true, render: (r) => UI.money(r.net) },
      { label: 'Paid', num: true, render: (r) => UI.money(r.paid) },
      { label: 'Balance', num: true, render: (r) => `<b>${UI.money(r.balance)}</b>` },
      documents,
    ],
    labOrders: [
      { label: 'Order', render: (r) => `<b>${UI.esc(r.order_no)}</b>` +
        (r.priority && r.priority !== 'routine'
          ? ` ${UI.badge(UI.titleise(r.priority), 'danger')}` : '') },
      { label: 'Patient', render: who },
      { label: 'Tests', render: (r) => `<span class="small">${UI.esc(r.tests || '—')}</span>` },
      { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
      { label: 'Ordered', render: when },
      { label: 'Reported', render: (r) => (r.reported_at
        ? UI.esc(UI.dateTime(r.reported_at)) : '<span class="muted">—</span>') },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      documents,
    ],
    doctorVisits: [
      { label: 'Visit', render: (r) => `<b>${UI.esc(r.visit_no)}</b>` },
      { label: 'Patient', render: who },
      { label: 'Stage', render: (r) => UI.statusBadge(r.status) },
      { label: 'Arrived', render: when },
      { label: 'With the doctor', num: true, render: (r) => mins(r.consult_minutes) },
    ],
    billed: [
      { label: 'Invoice', render: (r) => `<b>${UI.esc(r.invoice_no)}</b>` +
        `<div class="muted small">${UI.esc(UI.titleise(r.kind || ''))}</div>` },
      { label: 'Patient', render: who },
      { label: 'Raised', render: (r) => UI.esc(UI.date(r.at)) },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      { label: 'Outstanding', num: true, render: (r) => UI.money(r.balance) },
      { label: 'Billed', num: true, render: (r) => `<b>${UI.money(r.amount)}</b>` },
      documents,
    ],
    collected: [
      { label: 'Invoice', render: (r) => `<b>${UI.esc(r.invoice_no)}</b>` +
        `<div class="muted small">${UI.esc(UI.titleise(r.kind || ''))}</div>` },
      { label: 'Patient', render: who },
      { label: 'Raised', render: (r) => UI.esc(UI.date(r.at)) },
      { label: 'Billed', num: true, render: (r) => UI.money(r.net) },
      { label: 'Received', num: true, render: (r) => `<b>${UI.money(r.amount)}</b>` },
      documents,
    ],
  };

  /** Which list each metric uses, and what to rule off underneath it. */
  const RSHAPE = {
    trend_visits:            { cols: 'visits' },
    trend_appointments:      { cols: 'appointments' },
    trend_collected:         { cols: 'receipts', total: { label: 'Collected', key: 'amount' } },
    trend_admissions:        { cols: 'admissions' },
    turnaround_visits:       { cols: 'turnaround' },
    revenue_sliding:         { cols: 'concessions', total: { label: 'Sliding-scale given', key: 'amount' } },
    revenue_assistance:      { cols: 'concessions', total: { label: 'Assistance given', key: 'amount' } },
    revenue_outstanding:     { cols: 'invoices', total: { label: 'Still to collect', key: 'balance' } },
    trend_lab:               { cols: 'labOrders' },
    doctor_lab:              { cols: 'labOrders' },
    doctor_visits:           { cols: 'doctorVisits' },
    doctor_month_booked:     { cols: 'appointments' },
    doctor_month_visits:     { cols: 'doctorVisits' },
    doctor_month_billed:     { cols: 'billed', total: { label: 'Billed', key: 'amount' } },
    doctor_month_collected:  { cols: 'collected', total: { label: 'Collected', key: 'amount' } },
  };

  function openReport(drill) {
    const shape = RSHAPE[drill.metric] || {};
    return Drilldown.open('/api/reports/detail' + API.qs(drill), {
      columns: RCOLUMNS[shape.cols],
      total: shape.total,
    });
  }

  /** Anything carrying a data-report payload opens it. */
  function wireDrills(scope) {
    scope.querySelectorAll('[data-report]').forEach((b) => {
      if (b.__wired) return;
      b.__wired = true;
      b.addEventListener('click', () => openReport(JSON.parse(b.dataset.report)));
    });
  }

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
            APP.can(MGMT) ? `
            ${APP.can(MONEY) ? '<button data-tab="revenue">Revenue</button>' : ''}
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
          // The takings only travel to the desks that may see them; when they
          // have not, the column is absent rather than zero.
          const money = rows.some((r) => r.collected !== undefined);
          // The window the tiles were added up over, sent along with any click.
          const w = { from: rows[0].day, to: rows[rows.length - 1].day };
          body.innerHTML = `
            <div class="grid ${money ? 'c5' : 'c4'} mb">
              ${rstat('teal', `Visits (${days} days)`, UI.num(total('visits')), '',
                { metric: 'trend_visits', ...w })}
              ${rstat('crimson', 'Appointments', UI.num(total('appointments')), '',
                { metric: 'trend_appointments', ...w })}
              ${rstat('info', 'Diagnostics', UI.num(total('lab_orders')), 'Lab and imaging orders',
                { metric: 'trend_lab', ...w })}
              ${money ? rstat('ok', 'Collected', UI.money(total('collected')), '',
                { metric: 'trend_collected', ...w }) : ''}
              ${rstat('orange', 'Admissions', UI.num(total('admissions')), '',
                { metric: 'trend_admissions', ...w })}
            </div>
            <div class="card"><div class="card-head"><h3>Daily visits</h3></div>
              <div class="card-body">${UI.sparkline(rows.map((r) => r.visits), rows.map((r) => r.day))}</div></div>
            ${money ? `<div class="card"><div class="card-head"><h3>Daily collections</h3></div>
              <div class="card-body">${UI.sparkline(rows.map((r) => r.collected), rows.map((r) => r.day))}</div></div>` : ''}
            <div class="card"><div class="card-head"><h3>Day by day</h3></div>
              <div class="card-body tight">${UI.table([
                { label: 'Date', render: (r) => UI.esc(UI.date(r.day)) },
                { label: 'Visits', num: true, render: (r) => dayCell(r, 'trend_visits', r.visits, UI.num) },
                { label: 'Appointments', num: true,
                  render: (r) => dayCell(r, 'trend_appointments', r.appointments, UI.num) },
                { label: 'Diagnostics', num: true,
                  render: (r) => dayCell(r, 'trend_lab', r.lab_orders, UI.num) },
                { label: 'Admissions', num: true,
                  render: (r) => dayCell(r, 'trend_admissions', r.admissions, UI.num) },
                ...(money ? [{ label: 'Collected', num: true,
                  render: (r) => dayCell(r, 'trend_collected', r.collected, UI.money) }] : []),
              ], [...rows].reverse())}</div></div>`;
          wireDrills(body);
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
              ${rstat('crimson', 'Door-to-door average',
                m.totalDoorToDoor !== null ? UI.num(m.totalDoorToDoor, 1) + ' min' : '—',
                `Across ${UI.num(t.sample)} completed visit(s)`,
                { metric: 'turnaround_visits', from: t.from, to: t.to })}
              ${rstat('teal', 'Time with the doctor',
                m.consultation !== null ? UI.num(m.consultation, 1) + ' min' : '—',
                'Average consultation length',
                { metric: 'turnaround_visits', from: t.from, to: t.to })}
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
          wireDrills(body);
        },

        async revenue() {
          const r = await API.get('/api/reports/revenue');
          body.innerHTML = `
            <div class="grid c4 mb">
              ${rstat('ok', 'Collected (30 days)',
                UI.money(r.byMode.reduce((s, m) => s + m.total, 0)), '',
                { metric: 'trend_collected', from: r.from, to: r.to })}
              ${rstat('teal', 'Sliding-scale given', UI.money(r.concessions.sliding_scale), '',
                { metric: 'revenue_sliding', from: r.from, to: r.to })}
              ${rstat('orange', 'Assistance &amp; write-offs', UI.money(r.concessions.assistance), '',
                { metric: 'revenue_assistance', from: r.from, to: r.to })}
              ${rstat('crimson', 'Outstanding', UI.money(r.outstanding.amount),
                `${UI.num(r.outstanding.invoices)} open invoice(s)`,
                { metric: 'revenue_outstanding', from: r.from, to: r.to })}
            </div>
            <div class="grid c2">
              <div class="card"><div class="card-head"><h3>Revenue by service line</h3></div>
                <div class="card-body">${UI.bars(r.byCategory.map((c) =>
                  ({ label: UI.titleise(c.category || 'other'), value: c.amount, display: UI.money(c.amount) })))}</div></div>
              <div class="card"><div class="card-head"><h3>Collections by mode</h3></div>
                <div class="card-body">${UI.bars(r.byMode.map((m) =>
                  ({ label: UI.titleise(m.mode), value: m.total, display: UI.money(m.total) })), { colour: 'crimson' })}</div></div>
            </div>`;
          wireDrills(body);
        },

        async doctors() {
          // The window is stated rather than left to the endpoint's default,
          // so a click can ask about exactly the period on screen.
          const to = UI.today();
          const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
          const rows = await API.get('/api/reports/doctor-productivity' + API.qs({ from, to }));
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Doctor productivity — last 30 days</h3>
              <span class="muted small">${UI.esc(UI.date(from))} to ${UI.esc(UI.date(to))}</span></div>
            <div class="card-body tight">${UI.table([
              { label: 'Doctor', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.department || '')}</div>` },
              { label: 'Visits', num: true, render: (d) =>
                drillNum({ metric: 'doctor_visits', doctorId: d.id, from, to }, d.visits, UI.num) },
              { label: 'Consultations', num: true, key: 'consultations' },
              { label: 'Admissions', num: true, key: 'admissions' },
              { label: 'Lab orders', num: true, render: (d) =>
                drillNum({ metric: 'doctor_lab', doctorId: d.id, from, to }, d.lab_orders, UI.num) },
              { label: 'Avg consult', num: true, render: (d) => d.avg_consult_minutes
                ? UI.num(d.avg_consult_minutes, 1) + ' min' : '—' },
            ], rows, { emptyText: 'No activity in this window.' })}</div></div>`;
          wireDrills(body);
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
            wireDrills(body);
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
        const METRIC_OF = { booked: 'doctor_month_booked', visits: 'doctor_month_visits',
          billed: 'doctor_month_billed', collected: 'doctor_month_collected' };
        // A cell counts only what falls inside the report's own window, so a
        // part month at either end opens the part, not the whole month.
        const monthWindow = (key) => {
          const [y, mo] = key.split('-').map(Number);
          const last = new Date(y, mo, 0).toISOString().slice(0, 10);
          return { from: `${key}-01` < data.from ? data.from : `${key}-01`,
                   to: last > data.to ? data.to : last };
        };
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
              return `<td class="num"${shade(v)}>${drillNum(
                { metric: METRIC_OF[metric], doctorId: r.id, ...monthWindow(m.key) }, v, cell)}</td>`;
            }).join('')}
            <td class="num"><b>${drillNum(
              { metric: METRIC_OF[metric], doctorId: r.id, from: data.from, to: data.to },
              r.total[metric], cell)}</b>
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
