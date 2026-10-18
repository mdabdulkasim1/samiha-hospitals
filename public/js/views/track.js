/* Patient Track — one box, whichever number the patient has brought. */
(function () {
  'use strict';

  /*
   * Why this screen exists when there is already a patient registry.
   *
   * The registry is a list you browse and filter. This is the question asked
   * fifty times a day at a counter with somebody standing in front of you:
   * who is this, and what have we done for them before. Whoever is asked has
   * one identifier — whichever the patient happens to carry — and no reason
   * to know which box on which screen takes it, so there is one box and it
   * takes all three.
   *
   * It is open to everybody who works here, because everybody gets asked: the
   * technician about to draw a sample, the pharmacist holding a prescription,
   * the nurse before vitals. What each of them then sees is not the same.
   * The clinical history goes to all of them; what the patient owes is sent
   * by the server only to the money desks, and this screen shows a bill only
   * when the server has sent one rather than deciding a second time and
   * risking a different answer from the endpoint.
   */

  APP.register('track', {
    title: 'Patient Track',
    subtitle: 'Find a patient by mobile, register number or Aadhaar',

    async render(el, params) {
      el.innerHTML = `
        <div class="card mb phone-first"><div class="card-body">
          <label class="field"><span>Mobile number, register number or Aadhaar</span></label>
          <div class="search-row">
            <input type="search" id="tq" autocomplete="off" spellcheck="false" autofocus
                   placeholder="98400 12345  ·  SPD26000123  ·  2345 6789 0123"
                   value="${UI.esc(params.q || '')}">
            <button class="btn" id="tgo">Find patient</button>
          </div>
          <div class="muted small">Whichever one they have. A mobile number brings up everybody in
            the family on it; a register number or a whole Aadhaar opens the one file.</div>
        </div></div>
        <div id="tout"></div>`;

      const box = el.querySelector('#tq');
      const out = el.querySelector('#tout');

      const find = async () => {
        const q = box.value.trim();
        if (!q) { out.innerHTML = ''; return; }
        out.innerHTML = UI.loading();
        let res;
        try {
          res = await API.get(`/api/patients/lookup?q=${encodeURIComponent(q)}`);
        } catch (err) {
          out.innerHTML = `<div class="alert danger">${UI.esc(err.message)}</div>`;
          return;
        }
        if (!res.count) return noMatch(out, q);
        if (res.count === 1) return showRecord(out, res.patients[0].id);
        showChoices(out, res);
      };

      el.querySelector('#tgo').addEventListener('click', find);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
      if (params.q) find();
    },
  });

  function noMatch(out, q) {
    const digits = q.replace(/\D/g, '');
    out.innerHTML = `
      <div class="card"><div class="card-body">
        ${UI.empty(`Nobody on file for “${UI.esc(q)}”.`, '🔍')}
        <div class="muted small" style="text-align:center">
          ${digits.length === 12
            ? 'An Aadhaar has to match in full — a part of one is never searched.'
            : 'Try the mobile number they give out, or the register number on their clinic card.'}
          ${APP.can(['reception'])
            ? '<div class="mt"><button class="btn sm" id="t-new">Register them as a new patient</button></div>'
            : '<div class="mt">If they are new, the front desk registers them.</div>'}
        </div>
      </div></div>`;
    const btn = out.querySelector('#t-new');
    if (btn) btn.addEventListener('click', () => APP.navigate('patients'));
  }

  /** One mobile number is often one family: let the desk pick who came in. */
  function showChoices(out, res) {
    out.innerHTML = `<div class="card"><div class="card-head">
        <h3>${UI.num(res.count)} patients on this ${res.matchedOn === 'phone' ? 'number' : 'search'}</h3>
        <span class="muted small">Pick the person in front of you</span></div>
      <div class="card-body tight" id="t-list"></div></div>`;
    const host = out.querySelector('#t-list');
    host.innerHTML = UI.table([
      { label: 'Patient', render: (p) => `<b>${UI.esc(p.name)}</b>` +
        `<div class="muted small">${UI.esc(p.uhid)}</div>` },
      { label: 'Age / Sex', render: (p) => `${UI.esc(p.age_years || '—')} · ${UI.esc(UI.titleise(p.gender || '—'))}` },
      { label: 'Mobile', render: (p) => UI.esc(p.phone || p.whatsapp || '—') },
      { label: 'Visits', num: true, render: (p) => UI.num(p.visit_count) },
      { label: 'Last seen', render: (p) => p.last_visit
        ? UI.esc(UI.date(p.last_visit)) : '<span class="muted">never</span>' },
      { label: 'Stage', render: (p) => p.stage === 'enquiry'
        ? UI.badge('Enquiry', 'orange') : UI.badge('Registered', 'ok') },
    ], res.patients, { emptyText: 'Nobody on file.' });
    UI.bindRows(host, res.patients, (p) => showRecord(out, p.id));
  }

  // ------------------------------------------------------------ the history
  /**
   * What the clinic has done for this patient, newest first.
   *
   * A summary, not the file: the dates, the doctors, the diagnoses and the
   * results that came back, which is what somebody at a counter is actually
   * asking. The full record is one button away and is the same data — this
   * reads the very same endpoint, so the two can never drift apart.
   */
  async function showRecord(out, id) {
    out.innerHTML = UI.loading();
    const p = await API.get(`/api/patients/${id}`);
    const money = Boolean(p.invoices);
    const lastVisit = p.visits[0];
    const lastConsult = p.consultations[0];

    out.innerHTML = `
      ${p.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(p.allergies)}</div>` : ''}
      ${p.stage === 'enquiry' ? `<div class="alert warn">
        <b>An enquiry, not a registered patient.</b> They have contacted the clinic but the
        registration paperwork has not been completed.</div>` : ''}

      <div class="card mb"><div class="card-body">
        <div class="btn-row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h3 style="margin:0">${UI.esc(p.name)}</h3>
            <div class="muted small"><code>${UI.esc(p.uhid)}</code>
              · ${UI.esc(p.age_years || '—')} yrs · ${UI.esc(UI.titleise(p.gender || '—'))}
              ${p.blood_group ? ' · ' + UI.esc(p.blood_group) : ''}
              ${p.phone ? ' · ' + UI.esc(p.phone) : ''}</div>
          </div>
          <button class="btn" id="t-open">Open the full record →</button>
        </div>
      </div></div>

      <div class="grid c4 mb">
        <div class="stat teal"><div class="label">Visits</div>
          <div class="value">${UI.num(p.visits.length)}</div>
          <div class="foot">${lastVisit
            ? 'Last ' + UI.esc(UI.date(lastVisit.arrived_at || lastVisit.created_at))
            : 'Never seen yet'}</div></div>
        <div class="stat crimson"><div class="label">Consultations</div>
          <div class="value">${UI.num(p.consultations.length)}</div>
          <div class="foot">${lastConsult && lastConsult.doctor_name
            ? UI.esc(lastConsult.doctor_name) : '—'}</div></div>
        <div class="stat orange"><div class="label">Diagnostics</div>
          <div class="value">${UI.num(p.labOrders.length)}</div>
          <div class="foot">${UI.num(p.labTrends.length)} test(s) with a trend</div></div>
        ${money
          ? `<div class="stat ${p.outstanding > 0 ? 'crimson' : 'ok'}"><div class="label">Outstanding</div>
              <div class="value">${UI.money(p.outstanding || 0)}</div>
              <div class="foot">${UI.num(p.invoices.length)} bill(s) on file</div></div>`
          : `<div class="stat ok"><div class="label">Admissions</div>
              <div class="value">${UI.num(p.admissions.length)}</div>
              <div class="foot">In-patient stays</div></div>`}
      </div>

      <div class="grid c2">
        <div class="card"><div class="card-head"><h3>Recent visits</h3></div>
          <div class="card-body tight">${visitTable(p)}</div></div>
        <div class="card"><div class="card-head"><h3>Diagnoses on record</h3></div>
          <div class="card-body tight">${diagnosisTable(p)}</div></div>
      </div>

      <div class="card mt"><div class="card-head"><h3>Latest results</h3>
        <span class="muted small">Newest report first</span></div>
        <div class="card-body tight">${resultTable(p)}</div></div>

      ${money ? `<div class="card mt"><div class="card-head"><h3>Billing</h3>
        <span class="muted small">Cashier and administrator only</span></div>
        <div class="card-body tight">${invoiceTable(p)}</div></div>` : `
      <div class="muted small mt">Bills and balances are not shown here — they go to the cashier,
        the financial counsellor and the administrator.</div>`}`;

    out.querySelector('#t-open').addEventListener('click', () => APP.navigate('patients', { id: p.id }));
  }

  const visitTable = (p) => UI.table([
    { label: 'Date', render: (v) => UI.esc(UI.date(v.arrived_at || v.created_at)) },
    { label: 'Visit', render: (v) => `<code>${UI.esc(v.visit_no)}</code>` },
    { label: 'Department', render: (v) => UI.esc(v.department_name || '—') },
    { label: 'Doctor', render: (v) => UI.esc(v.doctor_name || '—') },
    { label: 'Status', render: (v) => UI.statusBadge(v.status) },
  ], p.visits.slice(0, 8), { emptyText: 'No visits on file yet.' });

  const diagnosisTable = (p) => UI.table([
    { label: 'Date', render: (c) => UI.esc(UI.date(c.created_at)) },
    { label: 'Diagnosis', render: (c) => c.diagnoses
      ? UI.esc(c.diagnoses) : '<span class="muted">not recorded</span>' },
    { label: 'Doctor', render: (c) => UI.esc(c.doctor_name || '—') },
  ], p.consultations.slice(0, 8), { emptyText: 'No consultations recorded yet.' });

  /*
   * Results, flattened out of their orders so the newest reading is the first
   * line rather than buried inside the most recent report. A value is shown
   * beside the range it was measured against at the time, never against
   * today's: a lab that changes its analyser changes its ranges, and a number
   * from three years ago read against this year's range means nothing.
   */
  function resultTable(p) {
    const rows = [];
    for (const o of p.labOrders) {
      for (const i of o.items || []) {
        if (i.result_value === null || i.result_value === '') continue;
        rows.push({ ...i, order_no: o.order_no, when: i.result_at || o.ordered_at });
        if (rows.length >= 14) break;
      }
      if (rows.length >= 14) break;
    }
    return UI.table([
      { label: 'Date', render: (r) => UI.esc(UI.date(r.when)) },
      { label: 'Test', render: (r) => UI.esc(r.test_name) },
      { label: 'Result', num: true, render: (r) => `<b>${UI.esc(r.result_value)}</b>` +
        (r.unit ? ` <span class="muted small">${UI.esc(r.unit)}</span>` : '') },
      { label: 'Reference', render: (r) => r.ref_range
        ? `<span class="muted small">${UI.esc(r.ref_range)}</span>` : '—' },
      { label: 'Flag', render: (r) => r.abnormal_flag && r.abnormal_flag !== 'normal'
        ? UI.badge(UI.titleise(r.abnormal_flag), r.abnormal_flag === 'critical' ? 'danger' : 'warn')
        : UI.badge('Normal', 'ok') },
      { label: 'Report', render: (r) => `<code>${UI.esc(r.order_no)}</code>` },
    ], rows, { emptyText: 'No results reported yet.' });
  }

  const invoiceTable = (p) => UI.table([
    { label: 'Date', render: (i) => UI.esc(UI.date(i.created_at)) },
    { label: 'Bill', render: (i) => `<code>${UI.esc(i.invoice_no)}</code>` },
    { label: 'Net', num: true, render: (i) => UI.money(i.net) },
    { label: 'Paid', num: true, render: (i) => UI.money(i.paid) },
    { label: 'Balance', num: true, render: (i) => i.balance > 0
      ? `<b style="color:var(--danger)">${UI.money(i.balance)}</b>` : UI.money(0) },
    { label: 'Status', render: (i) => UI.statusBadge(i.status) },
  ], p.invoices.slice(0, 10), { emptyText: 'No bills on file.' });
})();
