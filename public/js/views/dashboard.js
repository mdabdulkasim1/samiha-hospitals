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

    // A doctor signed in sees their own clinic, not the whole rota.
    const isDoctor = APP.user.role === 'doctor';

    /**
     * A tile. Given a metric it becomes a button that opens the rows behind
     * the number, because "5 registered today" is only ever the beginning of
     * the question — the next one is always "which five?".
     *
     * A tile whose detail this user may not read stays a plain div: better an
     * honest number they cannot open than a button that refuses them.
     */
    const stat = (cls, label, value, foot, metric) => {
      const body = `<div class="label">${UI.esc(label)}</div>` +
        `<div class="value">${value}</div><div class="foot">${foot || ''}</div>`;
      return metric && canDrill(metric)
        ? `<button type="button" class="stat ${cls} drillable" data-metric="${metric}"
             title="Show the ${UI.esc(label.toLowerCase())} behind this number">${body}</button>`
        : `<div class="stat ${cls}">${body}</div>`;
    };

    /*
     * Whether this dashboard carries money at all.
     *
     * The server decides — it sends no revenue to a technician, a nurse or a
     * pharmacist — and the screen follows what it was given rather than
     * checking the role a second time and risking the two disagreeing.
     */
    const money = Boolean(d.revenue);

    el.innerHTML = `
      <div class="grid c4 mb">
        ${stat('orange', 'Enquiry patients', UI.num(d.patients ? d.patients.enquiry : 0),
          `${UI.num(d.patients ? d.patients.enquiryToday : 0)} new today · not yet registered`, 'enquiry_patients')}
        ${stat('ok', 'Registered patients', UI.num(d.patients ? d.patients.registered : 0),
          `${UI.num(d.patients ? d.patients.registeredToday : 0)} registered today`, 'registered_patients')}
        ${stat('teal', 'Converted from enquiry', UI.num(d.patients ? d.patients.convertedFromEnquiry : 0),
          d.patients && d.patients.enquiry + d.patients.convertedFromEnquiry > 0
            ? `${Math.round((d.patients.convertedFromEnquiry /
                (d.patients.enquiry + d.patients.convertedFromEnquiry)) * 100)}% of enquiries came in`
            : 'Enquiries who turned up', 'converted')}
        ${stat('crimson', 'Open enquiries', UI.num(d.enquiries.open || 0),
          `${UI.num(d.enquiries.via_whatsapp || 0)} via WhatsApp today`, 'open_enquiries')}
      </div>

      <div class="grid c4 mb">
        ${stat('teal', 'OPD visits today', UI.num(d.opd.visits),
          `${UI.num(d.opd.in_progress || 0)} in progress · ${UI.num(d.opd.new_patients || 0)} new`, 'opd_visits')}
        ${stat('crimson', 'Appointments', UI.num(d.appointments.total),
          `${UI.num(d.appointments.via_whatsapp || 0)} via WhatsApp · ${UI.num(d.appointments.no_shows || 0)} no-show`, 'appointments')}
        ${money
          ? stat('ok', 'Collected today', UI.money(d.revenue.collected),
            `${UI.num(d.revenue.receipts)} receipt(s) · ${UI.money(d.revenue.outstanding)} outstanding`, 'collections')
          : stat('teal', 'Diagnostics today', UI.num(d.lab ? d.lab.ordered_today || 0 : 0),
            `${UI.num(d.lab ? d.lab.pending || 0 : 0)} still to report`)}
        ${stat('orange', 'Beds occupied', `${UI.num(d.ipd.beds.occupied)} / ${UI.num(d.ipd.beds.total)}`,
          `${d.ipd.beds.occupancyPct}% occupancy · ${UI.num(d.ipd.currentInPatients)} in-patient(s)`, 'beds')}
      </div>

      ${money ? `
        <div class="grid c4 mb">
          ${stat('crimson', 'Still to collect', UI.money(d.revenue.outstanding),
            'Open invoices across the clinic', 'outstanding')}
          ${stat('ok', 'Taken today', UI.money(d.revenue.collected),
            `${UI.num(d.revenue.receipts)} receipt(s)`, 'collections')}
          ${stat('teal', 'Self-paying patients', UI.num(d.patients ? d.patients.uninsured : 0),
            'No insurance on file — they settle at the counter', 'self_paying')}
          ${stat('orange', 'With an insurer', UI.num(d.patients ? d.patients.insured : 0),
            d.insurance && d.insurance.receivable
              ? `${UI.money(d.insurance.receivable)} approved, not yet received` : 'Cashless and reimbursement', 'insured')}
        </div>` : ''}

      ${money && d.insurance && d.insurance.receivable > 0 ? `<div class="alert info mb" style="cursor:pointer" onclick="APP.navigate('insurance')">
        <b>${UI.money(d.insurance.receivable)}</b> approved by insurers but not yet received.
        ${d.insurance.overdueClaims ? `<b>${d.insurance.overdueClaims}</b> claim(s) are past their settlement date.` : ''}
      </div>` : ''}

      <div class="grid sidebar-right">
        <div>
          <div class="card">
            <div class="card-head"><h3>${money ? 'Footfall &amp; collections' : 'Footfall'} — last 14 days</h3></div>
            <div class="card-body">
              <div class="muted small mb">Visits per day</div>
              ${UI.sparkline(trend.map((t) => t.visits), trend.map((t) => t.day))}
              ${money ? `<div class="muted small mb mt">Collections per day</div>
              ${UI.sparkline(trend.map((t) => t.collected), trend.map((t) => t.day))}` : ''}
              <div class="row-between mt small muted">
                <span>${UI.esc(trend[0].day)}</span><span>${UI.esc(trend[trend.length - 1].day)}</span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>${isDoctor ? 'My clinic today' : 'Appointments by doctor today'}</h3>
              <span class="muted small">${isDoctor
                ? 'Your own list — a colleague\'s patients are not shown'
                : 'Who is sitting, and how full they are'}</span>
              <a class="btn ghost sm" href="#/${isDoctor ? 'myclinic' : 'appointments'}">${
                isDoctor ? 'Open my clinic' : 'Open the diary'}</a></div>
            <div class="card-body tight" id="doctor-board">${doctorBoard(d.byDoctor || [], isDoctor)}</div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Enquiries waiting to be registered</h3>
              <a class="btn ghost sm" href="#/patients?stage=enquiry">See all</a></div>
            <div class="card-body tight" id="enquiry-patients">${UI.loading()}</div>
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

          ${money ? `<div class="card">
            <div class="card-head"><h3>Concessions given today</h3></div>
            <div class="card-body">
              <dl class="kv">
                <dt>Billed</dt><dd>${UI.money(d.revenue.billed)}</dd>
                <dt>Sliding scale</dt><dd>${UI.money(d.revenue.slidingDiscount)}</dd>
                <dt>Assistance</dt><dd>${UI.money(d.revenue.assistanceCovered)}</dd>
              </dl>
              <div class="muted small mt">Recorded against completed financial screenings.</div>
            </div>
          </div>` : ''}

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
                ${APP.can(['cashier','reception','counselor']) ? '<button class="btn sm" data-go="billing">₹ Collect payment</button>' : ''}
                ${APP.can(['cashier','reception','counselor']) ? '<button class="btn ghost sm" data-go="insurance">Insurance &amp; TPA</button>' : ''}
                <button class="btn ghost sm" data-go="whatsapp">WhatsApp desk</button>
                <button class="btn ghost sm" data-go="workflow">Workflow map</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    el.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => APP.navigate(b.dataset.go)));

    // Every figure on the board opens the rows it was counted from.
    el.querySelectorAll('[data-metric]').forEach((b) =>
      b.addEventListener('click', () => openMetric(b.dataset.metric, d.date)));

    // "How many has Dr Sheikh got, and who?" — one click, without leaving the
    // dashboard or needing a doctor's own sign-in.
    el.querySelectorAll('[data-doc-day]').forEach((b) =>
      b.addEventListener('click', () => openDoctorDay(Number(b.dataset.docDay), d.date)));

    // Who enquired but has not been registered yet — the desk's follow-up list.
    try {
      const enq = await API.get('/api/patients' + API.qs({ stage: 'enquiry', limit: 8 }));
      document.getElementById('enquiry-patients').innerHTML = enq.rows.length
        ? UI.table([
            { label: 'Name', render: (p) => `<b>${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')}</b>` +
              `<div class="muted small">${UI.esc(p.uhid)}</div>` },
            { label: 'Phone', render: (p) => UI.esc(p.phone || '—') },
            { label: 'Came via', render: (p) => p.enquiry_source
              ? UI.badge(UI.titleise(p.enquiry_source), p.enquiry_source === 'whatsapp' ? 'wa' : 'info') : '—' },
            { label: 'Enquired', render: (p) => UI.esc(UI.ago(p.enquiry_at || p.registered_at)) },
            { label: '', render: (p) => APP.can(['reception'])
              ? `<button class="btn sm" data-reg="${p.id}">Register</button>` : '' },
          ], enq.rows)
        : UI.empty('No enquiries waiting — everyone who asked has been registered.', '✅');

      document.querySelectorAll('[data-reg]').forEach((b) => b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        APP.navigate('patients', { id: b.dataset.reg, register: '1' });
      }));
    } catch (err) {
      const host = document.getElementById('enquiry-patients');
      if (host) host.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`;
    }

    // Mini queue, loaded after the shell so the page paints immediately.
    try {
      const board = await API.get('/api/visits/board');
      const active = board.rows.filter((r) => r.status !== 'checked_out');
      // The user may have navigated on while this was in flight, in which case
      // the host is gone and there is nothing left to draw into.
      const queueHost = document.getElementById('mini-queue');
      if (!queueHost) return;
      queueHost.innerHTML = active.length
        ? UI.table([
            { label: 'Token', render: (r) => `<span class="badge crimson">${UI.esc(r.token_no || '—')}</span>` },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_name || '—') },
            { label: 'Stage', render: (r) => UI.statusBadge(r.status) },
            { label: 'Waiting', render: (r) => UI.esc(UI.ago(r.arrived_at)) },
          ], active.slice(0, 8))
        : UI.empty('No patients in the clinic right now.', '🌤');
    } catch (err) {
      const host = document.getElementById('mini-queue');
      if (host) host.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`;
    }
  },
});

/* ------------------------------------------------------------------ drill-in
 * A dashboard figure is the answer to a counting question, and the very next
 * question is always which ones. These open that list without making anyone
 * go and rebuild the same filter by hand on another screen.
 *
 * The roles mirror the guard on /api/reports/dashboard/detail. The server is
 * what actually decides; this only decides whether the tile looks pressable,
 * so that nobody is offered a door that will be shut in their face.
 */
const DRILL_ROLES = {
  enquiry_patients:    ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  registered_patients: ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  converted:           ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  open_enquiries:      ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  opd_visits:          ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  appointments:        ['reception', 'counselor', 'nurse', 'doctor', 'cashier'],
  collections:         ['cashier', 'reception', 'counselor'],
  outstanding:         ['cashier', 'reception', 'counselor'],
  beds:                ['ward', 'nurse', 'reception', 'doctor'],
  self_paying:         ['cashier', 'reception', 'counselor'],
  insured:             ['cashier', 'reception', 'counselor'],
};

function canDrill(metric) {
  return !!DRILL_ROLES[metric] && APP.can(DRILL_ROLES[metric]);
}

const { who, source } = Drilldown;

/** What each list shows. Kept beside the tiles rather than in the API, so the
 *  server returns rows and the screen decides how to read them. */
const DRILL_COLUMNS = {
  enquiry_patients: [
    { label: 'Patient', render: who },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Came via', render: (r) => source(r.source) },
    { label: 'Enquired', render: (r) => UI.esc(UI.ago(r.at)) },
  ],
  registered_patients: [
    { label: 'Patient', render: who },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Visits', num: true, render: (r) => UI.num(r.visits || 0) },
    { label: 'Registered', render: (r) => UI.esc(UI.date(r.at)) },
  ],
  converted: [
    { label: 'Patient', render: who },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Came via', render: (r) => source(r.source) },
    { label: 'Registered', render: (r) => UI.esc(UI.date(r.at)) },
  ],
  open_enquiries: [
    { label: 'Ref', render: (r) => `<b>${UI.esc(r.ref_no)}</b>` },
    { label: 'Name', render: (r) => UI.esc(r.name || '—') },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Came via', render: (r) => source(r.source) },
    { label: 'About', render: (r) => UI.esc(r.subject || '—') },
    { label: 'Asked', render: (r) => UI.esc(UI.ago(r.at)) },
  ],
  opd_visits: [
    { label: 'Token', render: (r) => `<span class="badge crimson">${UI.esc(r.token_no || '—')}</span>` },
    { label: 'Patient', render: who },
    { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
    { label: 'Stage', render: (r) => UI.statusBadge(r.status) },
    { label: 'Arrived', render: (r) => UI.esc(UI.time(r.at)) },
  ],
  appointments: [
    { label: 'Token', render: (r) => `<span class="badge crimson">${UI.esc(r.token_no || '—')}</span>` },
    { label: 'Time', render: (r) => `<b>${UI.esc(UI.time(r.at))}</b>` },
    { label: 'Patient', render: (r) => `<b>${UI.esc(r.name || '—')}</b>` +
      `<div class="muted small">${UI.esc(r.phone || 'no number')}</div>` },
    { label: 'Doctor', render: (r) => UI.esc(r.doctor || '—') },
    { label: 'Booked via', render: (r) => source(r.source) },
    { label: 'Status', render: (r) => UI.statusBadge(r.status) },
  ],
  collections: [
    { label: 'Receipt', render: (r) => `<b>${UI.esc(r.receipt_no)}</b>` +
      (r.invoice_no ? `<div class="muted small">${UI.esc(r.invoice_no)}</div>` : '') },
    { label: 'Patient', render: who },
    { label: 'Mode', render: (r) => UI.badge(UI.titleise(r.mode || '—'), 'info') },
    { label: 'Taken by', render: (r) => UI.esc(r.taken_by || '—') },
    { label: 'Time', render: (r) => UI.esc(UI.time(r.at)) },
    { label: 'Amount', num: true, render: (r) => `<b>${UI.money(r.amount)}</b>` },
    Drilldown.documents,
  ],
  outstanding: [
    { label: 'Invoice', render: (r) => `<b>${UI.esc(r.invoice_no)}</b>` +
      `<div class="muted small">${UI.esc(UI.titleise(r.kind || ''))}</div>` },
    { label: 'Patient', render: who },
    { label: 'Raised', render: (r) => UI.esc(UI.date(r.at)) },
    { label: 'Status', render: (r) => UI.statusBadge(r.status) },
    { label: 'Billed', num: true, render: (r) => UI.money(r.net) },
    { label: 'Paid', num: true, render: (r) => UI.money(r.paid) },
    { label: 'Balance', num: true, render: (r) => `<b>${UI.money(r.balance)}</b>` },
    Drilldown.documents,
  ],
  beds: [
    { label: 'Bed', render: (r) => `<b>${UI.esc(r.bed_no)}</b>` +
      `<div class="muted small">${UI.esc(r.ward || '')}</div>` },
    { label: 'Status', render: (r) => UI.statusBadge(r.status) },
    { label: 'Patient', render: (r) => (r.name ? who(r) : '<span class="muted">—</span>') },
    { label: 'IP No', render: (r) => UI.esc(r.ip_no || '—') },
    { label: 'Since', render: (r) => (r.at ? UI.esc(UI.ago(r.at)) : '—') },
    { label: 'Per day', num: true, render: (r) => UI.money(r.tariff) },
  ],
  self_paying: [
    { label: 'Patient', render: who },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Registered', render: (r) => UI.esc(UI.date(r.at)) },
  ],
  insured: [
    { label: 'Patient', render: who },
    { label: 'Phone', render: (r) => UI.esc(r.phone || '—') },
    { label: 'Insurer', render: (r) => UI.esc(r.insurer || '—') },
    { label: 'Policy', render: (r) => UI.esc(r.policy_no || '—') },
    { label: 'Valid till', render: (r) => (r.valid_till ? UI.esc(UI.date(r.valid_till)) : '—') },
  ],
};

/** Which lists are worth a rupee total ruled off under them. */
const DRILL_TOTAL = {
  collections: { label: 'Collected', key: 'amount' },
  outstanding: { label: 'Still to collect', key: 'balance' },
};

function openMetric(metric, date) {
  return Drilldown.open('/api/reports/dashboard/detail' + API.qs({ metric, date }), {
    columns: DRILL_COLUMNS[metric],
    total: DRILL_TOTAL[metric],
  });
}

/**
 * Doctor by doctor for the day: booked, seen, and how much of the clinic is
 * still open. This is the question the front desk asks all morning — "how many
 * has Dr Sheikh got?" — so it belongs on the first screen rather than three
 * clicks into the diary.
 */
function doctorBoard(rows, isDoctor = false) {
  if (!rows.length) {
    return UI.empty(isDoctor
      ? 'You are not sitting today and nobody is booked with you.'
      : 'No doctor is sitting today, and nothing is booked. Fix visiting hours under Staff & Doctors.', '🗓');
  }

  const total = rows.reduce((a, r) => a + r.booked, 0);
  const seen = rows.reduce((a, r) => a + r.completed, 0);

  const table = UI.table([
    { label: 'Doctor', render: (r) => `<b>${UI.esc(r.name)}</b>` +
      (!isDoctor && APP.user && APP.user.id === r.id ? ' ' + UI.badge('you', 'teal') : '') +
      `<div class="muted small">${UI.esc(r.specialization || r.department_name || '')}` +
      `${r.room_no ? ' · ' + UI.esc(r.room_no) : ''}</div>` },
    { label: 'Hours', render: (r) => r.on_leave
      ? UI.badge('On leave', 'danger')
      : (r.hours ? `<span class="small">${UI.esc(r.hours)}</span>`
                 : '<span class="muted small">no hours fixed</span>') },
    { label: 'Booked', num: true, render: (r) => r.booked
      ? `<b style="font-size:15px">${UI.num(r.booked)}</b>` +
        (r.new_patients ? `<div class="muted small">${UI.num(r.new_patients)} new</div>` : '')
      : '<span class="muted">—</span>' },
    { label: 'Waiting', num: true, render: (r) => r.arrived ? UI.num(r.arrived) : '—' },
    { label: 'Seen', num: true, render: (r) => r.completed
      ? `<span style="color:var(--ok);font-weight:600">${UI.num(r.completed)}</span>` : '—' },
    { label: 'Free slots', num: true, render: (r) => {
      if (r.on_leave) return '—';
      if (!r.hours) return '<span class="muted">—</span>';
      return r.free ? UI.num(r.free) : UI.badge('Full', 'warn');
    } },
    { label: 'Missed', num: true, render: (r) => (r.cancelled + r.no_shows)
      ? `<span class="muted small">${UI.num(r.cancelled)} canc · ${UI.num(r.no_shows)} n/s</span>` : '' },
    { label: '', render: (r) => (r.booked && !isDoctor)
      ? `<button class="btn ghost sm" data-doc-day="${r.id}">List</button>` : '' },
  ], rows, { emptyText: 'Nothing booked with anybody today.' });

  return table + `<div class="row-between small muted" style="padding:8px 14px 2px;border-top:1px solid var(--line)">
    <span><b>${UI.num(total)}</b> patient(s) booked${isDoctor ? '' : ` across ${UI.num(rows.length)} doctor(s)`}</span>
    <span>${UI.num(seen)} seen so far</span>
  </div>`;
}

/** One doctor's list for the day, opened from the board. */
async function openDoctorDay(doctorId, date) {
  const day = await API.get('/api/appointments/my-day' + API.qs({ doctorId, date }));
  UI.modal({
    title: `${day.doctor.name} — ${day.label}`,
    size: 'wide',
    body: `
      <div class="row-between mb">
        <div class="muted small">${UI.esc(day.doctor.specialization || day.doctor.department_name || '')}
          ${day.doctor.room_no ? ' · Room ' + UI.esc(day.doctor.room_no) : ''}</div>
        <div class="muted small">${day.onLeave
          ? '<b style="color:var(--danger)">On leave</b>'
          : (day.hours ? 'Visiting hours ' + UI.esc(day.hours) : 'No hours fixed')}</div>
      </div>
      <div class="grid c4 mb">
        <div class="stat crimson"><div class="label">Booked</div><div class="value">${UI.num(day.summary.booked)}</div></div>
        <div class="stat teal"><div class="label">Arrived</div><div class="value">${UI.num(day.summary.arrived)}</div></div>
        <div class="stat ok"><div class="label">Seen</div><div class="value">${UI.num(day.summary.completed)}</div></div>
        <div class="stat orange"><div class="label">Cancelled / no-show</div>
          <div class="value">${UI.num(day.summary.cancelled + day.summary.noShow)}</div></div>
      </div>
      ${UI.table([
        { label: 'Token', render: (r) => `<span class="badge crimson">#${UI.esc(r.token_no || '—')}</span>` },
        { label: 'Time', render: (r) => `<b>${UI.esc(r.time)}</b>` },
        { label: 'Patient', render: (r) => `<b>${UI.esc(r.display_name)}</b>` +
          `<div class="muted small">${UI.esc(r.uhid || 'not registered yet')}</div>` },
        { label: 'Contact', render: (r) => UI.esc(r.patient_phone || r.guest_phone || '—') },
        { label: 'Reason', render: (r) => UI.esc(r.reason || '—') },
        { label: 'Flags', render: (r) => r.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
        { label: 'Status', render: (r) => UI.statusBadge(r.visit_status || r.status) },
      ], day.rows, { emptyText: 'Nobody is booked with this doctor today.' })}`,
    footer: `<button class="btn ghost" data-act="diary">Open the diary</button>
             <button class="btn" data-act="__close">Close</button>`,
    onAction(act) {
      if (act === 'diary') APP.navigate('appointments', { date });
    },
  });
}

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
  if (d.patients && d.patients.enquiry) {
    items.push(['orange', `${d.patients.enquiry} enquiry patient(s) not yet registered`, 'patients']);
  }
  // Only for the desks that would go and collect it.
  if (d.revenue && d.revenue.outstanding > 0) {
    items.push(['warn', `${UI.money(d.revenue.outstanding)} outstanding across unpaid bills`, 'billing']);
  }
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
