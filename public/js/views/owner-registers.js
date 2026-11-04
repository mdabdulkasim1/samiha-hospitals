/* The six registers the owner's reports read from. */
(function () {
  'use strict';

  /*
   * A report with nothing behind it offers the book it reads from, right
   * there, rather than telling the owner to go and find a screen. The
   * registers are modals for the same reason: somebody is standing at the
   * report thinking "we should start recording this", and a journey through
   * the menu is where that thought dies.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const esc = (v) => UI.esc(v === null || v === undefined ? '' : v);
  const opts = (list) => list.map((v) => ({ value: v, label: UI.titleise(v) }));

  async function open(which, onDone) {
    const forms = { complaints, incidents, hygiene, compliance, attendance, payroll };
    const fn = forms[which];
    if (fn) await fn(onDone);
  }

  /* --------------------------------------------------------- complaints */
  async function complaints(onDone) {
    const meta = await API.get('/api/registers/complaints/meta');
    const rows = await API.get('/api/registers/complaints');
    UI.modal({
      title: 'Complaints register',
      size: 'wide',
      body: `
        <p class="muted small">What a patient or family said went wrong, and what was
          done about it. A rising count is often a clinic that has started listening —
          read it with how long things take to resolve, which is the part you control.</p>
        <form id="cp-form" class="register-form">
          <div class="grid c3">
            ${UI.field({ name: 'receivedOn', label: 'Received', type: 'date', value: today() })}
            ${UI.field({ name: 'channel', label: 'How it came in', value: 'in_person',
              options: opts(meta.channels) })}
            ${UI.field({ name: 'category', label: 'About', value: 'other',
              options: opts(meta.categories) })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'complainant', label: 'Who complained', value: '' })}
            ${UI.field({ name: 'contact', label: 'Contact', value: '' })}
            ${UI.field({ name: 'severity', label: 'Severity', value: 'minor',
              options: opts(meta.severities) })}
          </div>
          ${UI.field({ name: 'detail', label: 'What was said', type: 'textarea', rows: 2,
            required: true })}
          ${UI.field({ name: 'actionTaken', label: 'What was done at the time',
            type: 'textarea', rows: 2, value: '' })}
          <div class="grid c3">
            ${UI.field({ name: 'departmentId', label: 'Department', value: '',
              options: [{ value: '', label: '— none —' }]
                .concat(meta.departments.map((d) => ({ value: d.id, label: d.name }))) })}
            ${UI.field({ name: 'ownerName', label: 'Who will deal with it', value: '' })}
            ${UI.field({ name: 'dueDate', label: 'By when', type: 'date', value: '' })}
          </div>
        </form>
        <div class="register-list">${UI.table([
    { label: 'Ref', render: (r) => `<code>${esc(r.ref_no)}</code>` },
    { label: 'Received', render: (r) => esc(UI.date(r.received_on)) },
    { label: 'About', render: (r) => UI.badge(UI.titleise(r.category), 'teal') },
    { label: 'What was said', render: (r) => esc(r.detail) },
    { label: 'Status', render: (r) => UI.badge(UI.titleise(r.status),
      ['resolved', 'closed'].includes(r.status) ? 'ok' : 'warn') },
  ], rows, { emptyText: 'Nothing recorded yet.' })}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Record it</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        await API.post('/api/registers/complaints', UI.formValues(modal.querySelector('#cp-form')));
        UI.ok('Recorded.');
        if (onDone) onDone();
      },
    });
  }

  /* ---------------------------------------------------- safety incidents */
  async function incidents(onDone) {
    const meta = await API.get('/api/registers/incidents/meta');
    const rows = await API.get('/api/registers/incidents');
    UI.modal({
      title: 'Patient safety incidents',
      size: 'wide',
      body: `
        <p class="muted small">Anything that reached a patient, <b>or nearly did</b>. A near
          miss is the same failure with better luck and is worth as much as the rest —
          a clinic that only records harm learns nothing until somebody is hurt.</p>
        <form id="in-form" class="register-form">
          <div class="grid c3">
            ${UI.field({ name: 'happenedOn', label: 'When', type: 'date', value: today(), max: today() })}
            ${UI.field({ name: 'kind', label: 'Kind', value: 'other', options: opts(meta.kinds) })}
            ${UI.field({ name: 'harm', label: 'Harm caused', value: 'near_miss',
              options: opts(meta.harms),
              hint: 'Near miss counts. Record it.' })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'departmentId', label: 'Where', value: '',
              options: [{ value: '', label: '— none —' }]
                .concat(meta.departments.map((d) => ({ value: d.id, label: d.name }))) })}
            ${UI.field({ name: 'location', label: 'Exact place', value: '',
              placeholder: 'e.g. Sample collection, Bed 4' })}
          </div>
          ${UI.field({ name: 'detail', label: 'What happened', type: 'textarea', rows: 2,
            required: true, hint: 'Facts, not blame. The point is the system, not the person.' })}
          ${UI.field({ name: 'immediateAction', label: 'What was done straight away',
            type: 'textarea', rows: 2, value: '' })}
        </form>
        <div class="register-list">${UI.table([
    { label: 'Ref', render: (r) => `<code>${esc(r.ref_no)}</code>` },
    { label: 'When', render: (r) => esc(UI.date(r.happened_on)) },
    { label: 'Kind', render: (r) => UI.badge(UI.titleise(r.kind), 'teal') },
    { label: 'Harm', render: (r) => UI.badge(UI.titleise(r.harm),
      ['severe', 'death', 'moderate'].includes(r.harm) ? 'danger' : 'teal') },
    { label: 'What happened', render: (r) => esc(r.detail) },
    { label: 'Status', render: (r) => UI.badge(UI.titleise(r.status),
      r.status === 'closed' ? 'ok' : 'warn') },
  ], rows, { emptyText: 'Nothing recorded yet.' })}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Record it</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        await API.post('/api/registers/incidents', UI.formValues(modal.querySelector('#in-form')));
        UI.ok('Recorded.');
        if (onDone) onDone();
      },
    });
  }

  /* ------------------------------------------------------ hygiene rounds */
  async function hygiene(onDone) {
    const meta = await API.get('/api/registers/hygiene/meta');
    const rows = await API.get('/api/registers/hygiene');
    UI.modal({
      title: 'Housekeeping and infection control',
      size: 'wide',
      body: `
        <p class="muted small">An area that was never checked and an area that failed its
          check are different problems. Log the round either way — a score of 80 or more
          counts as a pass.</p>
        <form id="hy-form" class="register-form">
          <div class="grid c4">
            ${UI.field({ name: 'onDate', label: 'Date', type: 'date', value: today(), max: today() })}
            ${UI.field({ name: 'shift', label: 'Shift', value: 'morning', options: opts(meta.shifts) })}
            ${UI.field({ name: 'area', label: 'Area', required: true, value: '',
              options: [''].concat(meta.areas) })}
            ${UI.field({ name: 'kind', label: 'Check', value: 'housekeeping',
              options: opts(meta.kinds) })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'score', label: 'Score out of 100', type: 'number',
              min: 0, max: 100, value: '', hint: 'Leave blank for a check that is not scored.' })}
            ${UI.field({ name: 'doneBy', label: 'Done by', value: '' })}
            ${UI.checkbox({ name: 'passed', label: 'Passed (used when there is no score)',
              checked: true })}
          </div>
          ${UI.field({ name: 'issues', label: 'What was wrong', type: 'textarea', rows: 2, value: '' })}
          ${UI.field({ name: 'actionTaken', label: 'What was done', type: 'textarea', rows: 2, value: '' })}
        </form>
        <div class="register-list">${UI.table([
    { label: 'Date', render: (r) => esc(UI.date(r.on_date)) },
    { label: 'Area', render: (r) => `<b>${esc(r.area)}</b>` },
    { label: 'Check', render: (r) => UI.badge(UI.titleise(r.kind), 'teal') },
    { label: 'Score', num: true, render: (r) => (r.score === null ? '—' : esc(r.score)) },
    { label: 'Result', render: (r) => (r.passed === null ? '<span class="muted">—</span>'
      : UI.badge(r.passed ? 'Passed' : 'Failed', r.passed ? 'ok' : 'danger')) },
    { label: 'Issues', render: (r) => esc(r.issues || '—') },
  ], rows, { emptyText: 'No round logged yet.' })}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Log the round</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#hy-form'));
        v.passed = Boolean(v.passed);
        await API.post('/api/registers/hygiene', v);
        UI.ok('Logged.');
        if (onDone) onDone();
      },
    });
  }

  /* -------------------------------------------------- compliance register */
  async function compliance(onDone) {
    const meta = await API.get('/api/registers/compliance/meta');
    const rows = await API.get('/api/registers/compliance');
    UI.modal({
      title: 'Licence, insurance and compliance',
      size: 'wide',
      body: `
        <p class="muted small">Everything that expires and would stop the clinic if it
          lapsed. Equipment calibration lives on the asset register; this is the paperwork.</p>
        <form id="co-form" class="register-form">
          <div class="grid c3">
            ${UI.field({ name: 'name', label: 'What it is', required: true, value: '',
              options: [''].concat(meta.suggestions),
              hint: 'Pick one or type your own.' })}
            ${UI.field({ name: 'kind', label: 'Kind', value: 'licence', options: opts(meta.kinds) })}
            ${UI.field({ name: 'authority', label: 'Issued by', value: '' })}
          </div>
          <div class="grid c4">
            ${UI.field({ name: 'referenceNo', label: 'Reference number', value: '' })}
            ${UI.field({ name: 'issuedOn', label: 'Issued', type: 'date', value: '' })}
            ${UI.field({ name: 'validTill', label: 'Valid till', type: 'date', value: '' })}
            ${UI.field({ name: 'renewalNoticeDays', label: 'Warn me (days before)',
              type: 'number', value: 60, min: 1 })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'ownerName', label: 'Who renews it', value: '' })}
            ${UI.field({ name: 'cost', label: 'Renewal cost (₹)', type: 'number',
              step: '0.01', value: '' })}
          </div>
        </form>
        <div class="register-list">${UI.table([
    { label: 'Item', render: (r) => `<b>${esc(r.name)}</b>` },
    { label: 'Reference', render: (r) => (r.reference_no ? `<code>${esc(r.reference_no)}</code>` : '—') },
    { label: 'Valid till', render: (r) => (r.valid_till ? esc(UI.date(r.valid_till)) : '—') },
    { label: 'Days left', num: true, render: (r) => (r.days_left === null ? '—'
      : `<b style="color:${r.days_left < 0 ? 'var(--danger)' : r.days_left < 60 ? 'var(--orange-dark)' : 'inherit'}">${esc(r.days_left)}</b>`) },
    { label: 'Who renews', render: (r) => esc(r.owner_name || '—') },
  ], rows, { emptyText: 'Nothing on the register yet.' })}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Add it</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        await API.post('/api/registers/compliance', UI.formValues(modal.querySelector('#co-form')));
        UI.ok('Added to the register.');
        if (onDone) onDone();
      },
    });
  }

  /* ------------------------------------------------------- attendance */
  async function attendance(onDone) {
    const meta = await API.get('/api/registers/attendance/meta');
    const day = today();
    const data = await API.get(`/api/registers/attendance?date=${day}`);

    UI.modal({
      title: `Attendance — ${UI.date(day)}`,
      size: 'wide',
      body: `
        <p class="muted small">Mark the day. An unmarked day is not an absence and is not
          counted as one. Overtime hours here feed the owner's report; what they cost
          goes in payroll.</p>
        <label class="inline-label">Date
          <input type="date" id="at-date" value="${day}" max="${day}"></label>
        <table class="budget-table mt" id="at-table"><thead><tr>
          <th>Person</th><th>Shift</th><th>Status</th>
          <th class="num">Hours</th><th class="num">Overtime</th>
        </tr></thead><tbody>
          ${data.rows.map((r) => `<tr data-user="${r.user_id}">
            <td>${esc(r.name)}<div class="muted small">${UI.titleise(r.role)}</div></td>
            <td><select name="shift">${['general', 'morning', 'evening', 'night', 'on_call']
    .map((s) => `<option value="${s}" ${r.shift === s ? 'selected' : ''}>${UI.titleise(s)}</option>`).join('')}</select></td>
            <td><select name="status">${['present', 'absent', 'leave', 'week_off', 'holiday', 'half_day']
    .map((s) => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${UI.titleise(s)}</option>`).join('')}</select></td>
            <td class="num"><input type="number" step="0.25" name="workedHours"
              value="${r.worked_hours === null || r.worked_hours === undefined ? '' : r.worked_hours}" style="width:80px"></td>
            <td class="num"><input type="number" step="0.25" name="overtimeHours"
              value="${r.overtime_hours || ''}" style="width:80px"></td>
          </tr>`).join('')}
        </tbody></table>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Save the day</button>`,
      onMount: (modal) => {
        modal.querySelector('#at-date').addEventListener('change', async (e) => {
          const d = await API.get(`/api/registers/attendance?date=${e.target.value}`);
          const body = modal.querySelector('#at-table tbody');
          d.rows.forEach((r) => {
            const tr = body.querySelector(`tr[data-user="${r.user_id}"]`);
            if (!tr) return;
            tr.querySelector('[name="shift"]').value = r.shift || 'general';
            tr.querySelector('[name="status"]').value = r.status || 'present';
            tr.querySelector('[name="workedHours"]').value = r.worked_hours ?? '';
            tr.querySelector('[name="overtimeHours"]').value = r.overtime_hours || '';
          });
        });
      },
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const marks = [...modal.querySelectorAll('#at-table tbody tr')].map((tr) => ({
          userId: Number(tr.dataset.user),
          shift: tr.querySelector('[name="shift"]').value,
          status: tr.querySelector('[name="status"]').value,
          workedHours: tr.querySelector('[name="workedHours"]').value,
          overtimeHours: tr.querySelector('[name="overtimeHours"]').value,
        }));
        await API.put('/api/registers/attendance',
          { date: modal.querySelector('#at-date').value, marks });
        UI.ok(`Marked ${marks.length} people.`);
        if (onDone) onDone();
      },
    });
    return meta;
  }

  /* ---------------------------------------------------------- payroll */
  async function payroll(onDone) {
    const meta = await API.get('/api/registers/payroll/meta');
    const period = today().slice(0, 7);
    const data = await API.get(`/api/registers/payroll?period=${period}`);

    UI.modal({
      title: `Payroll — ${period}`,
      size: 'wide',
      body: `
        <p class="muted small">The cash book already has the total that left the bank. This
          is the only thing that can say whose it was, or whether one department's wage
          bill is growing. Net pay is worked out from the boxes, never typed.</p>
        <form id="py-form" class="register-form">
          <div class="grid c4">
            ${UI.field({ name: 'period', label: 'Month', type: 'month', value: period, required: true })}
            ${UI.field({ name: 'person', label: 'Person', required: true, value: '',
              options: [''].concat(meta.staff.map((s) => s.name)),
              hint: 'Pick a name or type one.' })}
            ${UI.field({ name: 'kind', label: 'Kind', value: 'salary', options: opts(meta.kinds) })}
            ${UI.field({ name: 'departmentId', label: 'Department', value: '',
              options: [{ value: '', label: '— none —' }]
                .concat(meta.departments.map((d) => ({ value: d.id, label: d.name }))) })}
          </div>
          <div class="grid c4">
            ${UI.field({ name: 'basic', label: 'Basic (₹)', type: 'number', step: '0.01', value: '' })}
            ${UI.field({ name: 'allowances', label: 'Allowances (₹)', type: 'number', step: '0.01', value: '' })}
            ${UI.field({ name: 'overtime', label: 'Overtime (₹)', type: 'number', step: '0.01', value: '' })}
            ${UI.field({ name: 'deductions', label: 'Deductions (₹)', type: 'number', step: '0.01', value: '' })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'paidOn', label: 'Paid on', type: 'date', value: '' })}
            ${UI.field({ name: 'mode', label: 'How', value: '',
              options: ['', 'bank', 'cash', 'upi', 'cheque'] })}
          </div>
        </form>
        <div class="register-list">${UI.table([
    { label: 'Person', render: (r) => `<b>${esc(r.person)}</b>` },
    { label: 'Kind', render: (r) => UI.badge(UI.titleise(r.kind), 'teal') },
    { label: 'Basic', num: true, render: (r) => money(r.basic) },
    { label: 'Overtime', num: true, render: (r) => money(r.overtime) },
    { label: 'Deductions', num: true, render: (r) => money(r.deductions) },
    { label: 'Net pay', num: true, render: (r) => `<b>${money(r.net_pay)}</b>` },
    { label: 'Paid', render: (r) => (r.paid_on ? esc(UI.date(r.paid_on)) : '—') },
  ], data.rows, { emptyText: 'Nothing entered for this month yet.' })}</div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Add the line</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        await API.post('/api/registers/payroll', UI.formValues(modal.querySelector('#py-form')));
        UI.ok('Added.');
        if (onDone) onDone();
      },
    });
  }

  /* ------------------------------------------------- the opening position */
  async function openPosition(onDone) {
    const d = await API.get('/api/owner/position');
    const have = {};
    for (const v of d.values) have[v.line] = v.amount;

    UI.modal({
      title: 'Opening position',
      size: 'wide',
      body: `
        <p class="muted small">The handful of figures a balance sheet needs and this system
          cannot see. Stock, what patients owe, what suppliers are owed and the equipment
          register are already computed and will fill themselves in — these are the ones
          somebody has to read off a bank statement or a loan account.</p>
        <label class="inline-label">These figures are true as at
          <input type="date" id="po-date" value="${esc(d.asOn || today())}" max="${today()}"></label>
        <form id="po-form">
          <table class="budget-table mt"><thead><tr>
            <th>Figure</th><th>Where it comes from</th><th class="num">Amount ₹</th>
          </tr></thead><tbody>
            ${d.lines.map((l) => `<tr>
              <td><b>${esc(l.label)}</b></td>
              <td class="muted small">${esc(l.hint)}</td>
              <td class="num"><input type="number" step="0.01" name="${esc(l.key)}"
                value="${have[l.key] === undefined ? '' : esc(have[l.key])}"></td>
            </tr>`).join('')}
          </tbody></table>
        </form>
        <p class="muted small mt">The balance sheet shows how old these are. One resting on
          a year-old bank balance should not be relied on, and it will say so.</p>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save the position</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const values = {};
        modal.querySelectorAll('#po-form input[name]').forEach((i) => {
          values[i.name] = i.value === '' ? null : i.value;
        });
        await API.put('/api/owner/position',
          { asOn: modal.querySelector('#po-date').value, values });
        UI.ok('Position saved.');
        if (onDone) onDone();
      },
    });
  }

  window.OWNER_REGISTERS = { open, openPosition };
})();
