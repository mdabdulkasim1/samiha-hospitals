/* Landing dashboard — the day at a glance. */
APP.register('dashboard', {
  title: 'Dashboard',
  subtitle: 'Today across the clinic',

  async render(el) {
    const [d, trend, departments] = await Promise.all([
      API.get('/api/reports/dashboard'),
      API.get('/api/reports/trend?days=14'),
      API.get('/api/masters/departments'),
    ]);

    const stat = (cls, label, value, foot) =>
      `<div class="stat ${cls}"><div class="label">${UI.esc(label)}</div>
       <div class="value">${value}</div><div class="foot">${foot || ''}</div></div>`;

    el.innerHTML = `
      <div class="grid c4 mb">
        ${stat('teal', 'OPD visits today', UI.num(d.opd.visits),
          `${UI.num(d.opd.in_progress || 0)} in progress · ${UI.num(d.opd.new_patients || 0)} new`)}
        ${stat('crimson', 'Appointments', UI.num(d.appointments.total),
          `${UI.num(d.appointments.via_whatsapp || 0)} via WhatsApp · ${UI.num(d.appointments.no_shows || 0)} no-show`)}
        ${stat('ok', 'Collected today', UI.money(d.revenue.collected),
          `${UI.num(d.revenue.receipts)} receipt(s) · ${UI.money(d.revenue.outstanding)} outstanding`)}
        ${stat('orange', 'Beds occupied', `${UI.num(d.ipd.beds.occupied)} / ${UI.num(d.ipd.beds.total)}`,
          `${d.ipd.beds.occupancyPct}% occupancy · ${UI.num(d.ipd.currentInPatients)} in-patient(s)`)}
      </div>

      ${d.insurance && d.insurance.receivable > 0 ? `<div class="alert info mb" style="cursor:pointer" onclick="APP.navigate('insurance')">
        <b>${UI.money(d.insurance.receivable)}</b> approved by insurers but not yet received.
        ${d.insurance.overdueClaims ? `<b>${d.insurance.overdueClaims}</b> claim(s) are past their settlement date.` : ''}
      </div>` : ''}

      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>Footfall &amp; collections — last 14 days</h3></div>
            <div class="card-body">
              <div class="muted small mb">Visits per day</div>
              ${UI.sparkline(trend.map((t) => t.visits), trend.map((t) => t.day))}
              <div class="muted small mb mt">Collections per day</div>
              ${UI.sparkline(trend.map((t) => t.collected), trend.map((t) => t.day))}
              <div class="row-between mt small muted">
                <span>${UI.esc(trend[0].day)}</span><span>${UI.esc(trend[trend.length - 1].day)}</span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Where patients are right now</h3>
              <a class="btn ghost sm" href="#/queue">Open queue board</a></div>
            <div class="card-body" id="mini-queue">${UI.loading()}</div>
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-head"><h3>Needs attention</h3></div>
            <div class="card-body">
              ${attentionList(d)}
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Concessions given today</h3></div>
            <div class="card-body">
              <dl class="kv">
                <dt>Billed</dt><dd>${UI.money(d.revenue.billed)}</dd>
                <dt>Sliding scale</dt><dd>${UI.money(d.revenue.slidingDiscount)}</dd>
                <dt>Assistance</dt><dd>${UI.money(d.revenue.assistanceCovered)}</dd>
              </dl>
              <div class="muted small mt">Recorded against completed financial screenings.</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Services offered</h3></div>
            <div class="card-body">
              ${serviceBoard(departments)}
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Quick actions</h3></div>
            <div class="card-body">
              <div class="btn-row">
                ${APP.can(['reception']) ? '<button class="btn sm" data-go="patients">Register patient</button>' : ''}
                ${APP.can(['reception','nurse','doctor','counselor','cashier']) ? '<button class="btn teal sm" data-go="appointments">Book appointment</button>' : ''}
                <button class="btn ghost sm" data-go="whatsapp">WhatsApp desk</button>
                <button class="btn ghost sm" data-go="workflow">Workflow map</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    el.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => APP.navigate(b.dataset.go)));

    // Mini queue, loaded after the shell so the page paints immediately.
    try {
      const board = await API.get('/api/visits/board');
      const active = board.rows.filter((r) => r.status !== 'checked_out');
      document.getElementById('mini-queue').innerHTML = active.length
        ? UI.table([
            { label: 'Token', render: (r) => `<span class="badge crimson">${UI.esc(r.token_no || '—')}</span>` },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_name || '—') },
            { label: 'Stage', render: (r) => UI.statusBadge(r.status) },
            { label: 'Waiting', render: (r) => UI.esc(UI.ago(r.arrived_at)) },
          ], active.slice(0, 8))
        : UI.empty('No patients in the clinic right now.', '🌤');
    } catch (err) {
      document.getElementById('mini-queue').innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`;
    }
  },
});

/** The clinic's own service board — specialist consulting and diagnostic counters. */
function serviceBoard(departments) {
  const group = (kind) => departments.filter((x) => x.kind === kind);
  const section = (label, rows, colour) => `
    <h4 style="color:${colour};font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;margin-bottom:7px">
      ${UI.esc(label)}</h4>
    <div style="display:grid;gap:5px;margin-bottom:14px">
      ${rows.map((x) => `<div class="row-between small">
        <span>${UI.esc(x.name)}</span>
        ${x.doctor_count ? UI.badge(x.doctor_count + ' doctor' + (x.doctor_count > 1 ? 's' : ''), 'teal') : ''}
      </div>`).join('')}
    </div>`;
  return section('Specialist categories', group('specialist'), 'var(--crimson)') +
         section('Diagnostic categories', group('diagnostic'), 'var(--teal)');
}

function attentionList(d) {
  const items = [];
  if (d.financialScreening.waiting) items.push(['orange', `${d.financialScreening.waiting} financial screening(s) waiting for a counselor`, 'financial']);
  if (d.financialScreening.docs_pending) items.push(['warn', `${d.financialScreening.docs_pending} screening(s) awaiting proof of income`, 'financial']);
  if (d.lab.pending) items.push(['info', `${d.lab.pending} diagnostic order(s) in progress`, 'lab']);
  if (d.pharmacy.lowStockCount) items.push(['danger', `${d.pharmacy.lowStockCount} medicine(s) at or below reorder level`, 'pharmacy']);
  if (d.enquiries.open) items.push(['info', `${d.enquiries.open} open enquiry/enquiries to follow up`, 'enquiries']);
  if (d.revenue.outstanding > 0) items.push(['warn', `${UI.money(d.revenue.outstanding)} outstanding across unpaid bills`, 'billing']);
  if (d.insurance) {
    const ins = d.insurance;
    if (ins.preauthQueries) items.push(['orange', `${ins.preauthQueries} pre-authorisation query/queries from insurers to answer`, 'insurance']);
    if (ins.claimQueries) items.push(['orange', `${ins.claimQueries} claim query/queries to answer`, 'insurance']);
    if (ins.preauthDraft) items.push(['info', `${ins.preauthDraft} pre-authorisation(s) drafted but not sent`, 'insurance']);
    if (ins.claimDraft) items.push(['info', `${ins.claimDraft} claim(s) built but not submitted`, 'insurance']);
    if (ins.overdueClaims) items.push(['danger', `${ins.overdueClaims} claim(s) past their settlement date — chase the insurer`, 'insurance']);
  }
  if (!items.length) return UI.empty('Nothing needs chasing. 👏', '✅');
  return items.map(([kind, text, route]) =>
    `<div class="alert ${kind}" style="cursor:pointer" onclick="APP.navigate('${route}')">${UI.esc(text)}</div>`).join('');
}
