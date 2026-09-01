/* Insurance & TPA desk: policies, pre-authorisation, claims and receivables. */
(function () {
  'use strict';

  APP.register('insurance', {
    title: 'Insurance & TPA',
    subtitle: 'Policies, pre-authorisation, claims and receivables',

    async render(el, params) {
      if (params.preauthId) return openPreauth(Number(params.preauthId), () => APP.navigate('insurance'));
      if (params.claimId) return openClaim(Number(params.claimId), () => APP.navigate('insurance'));

      const [preauths, claims] = await Promise.all([
        API.get('/api/insurance/preauths'),
        API.get('/api/insurance/claims'),
      ]);
      const pc = preauths.counts;
      const cc = claims.counts;

      APP.actions([
        ...(APP.can(['cashier', 'reception', 'counselor'])
          ? [{ id: 'policy', label: '+ Add policy', onClick: () => openPolicyForm(null, () => APP.reload()) },
             { id: 'preauth', label: '+ Pre-authorisation', kind: '', onClick: () => openPreauthForm() }]
          : []),
      ]);

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat crimson"><div class="label">Pre-auth awaiting the insurer</div>
            <div class="value">${UI.num((pc.submitted || 0) + (pc.query_raised || 0))}</div>
            <div class="foot">${UI.num(pc.query_raised || 0)} with a query · ${UI.num(pc.draft || 0)} in draft</div></div>
          <div class="stat orange"><div class="label">Claims in progress</div>
            <div class="value">${UI.num((cc.submitted || 0) + (cc.under_process || 0) + (cc.query_raised || 0))}</div>
            <div class="foot">${UI.num(cc.draft || 0)} not yet sent</div></div>
          <div class="stat teal"><div class="label">Receivable from insurers</div>
            <div class="value">${UI.money(claims.totals.receivable)}</div>
            <div class="foot">Approved but not yet received</div></div>
          <div class="stat ok"><div class="label">Settled to date</div>
            <div class="value">${UI.money(claims.totals.settled)}</div>
            <div class="foot">${UI.money(claims.totals.disallowed)} disallowed</div></div>
        </div>

        <div class="tabs" id="ins-tabs">
          <button class="active" data-tab="preauths">Pre-authorisations</button>
          <button data-tab="claims">Claims</button>
          <button data-tab="policies">Policies</button>
          <button data-tab="receivables">Receivables</button>
          <button data-tab="insurers">Insurers &amp; TPAs</button>
        </div>
        <div id="ins-body"></div>`;

      const body = el.querySelector('#ins-body');
      const tabs = { preauths: preauthTab, claims: claimTab, policies: policyTab,
                     receivables: receivableTab, insurers: insurerTab };
      el.querySelectorAll('#ins-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#ins-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await preauthTab(body);
    },
  });

  // ------------------------------------------------------------- pre-auth tab
  async function preauthTab(body) {
    const { rows } = await API.get('/api/insurance/preauths');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Pre-authorisation requests</h3>
        <span class="muted small">Queries and pending submissions first</span></div>
      <div class="card-body tight" id="pa-list"></div></div>`;
    const host = body.querySelector('#pa-list');
    host.innerHTML = UI.table([
      { label: 'Ref', render: (r) => `<code>${UI.esc(r.preauth_no)}</code>` +
        (r.kind === 'enhancement' ? ' ' + UI.badge('Enhancement', 'orange') : '') },
      { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
      { label: 'Insurer / TPA', render: (r) => `${UI.esc(r.insurer_name)}<div class="muted small">${UI.esc(r.policy_no)}</div>` },
      { label: 'Episode', render: (r) => UI.esc(r.ip_no || r.visit_no || '—') },
      { label: 'Diagnosis', render: (r) => `<div class="small">${UI.esc(r.diagnosis || '')}</div>` },
      { label: 'Requested', num: true, render: (r) => UI.money(r.requested_amount) },
      { label: 'Approved', num: true, render: (r) => r.approved_amount
        ? `<b style="color:var(--ok)">${UI.money(r.approved_amount)}</b>` : '—' },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      { label: 'Pending', render: (r) => r.status === 'submitted' && r.hours_pending !== null
        ? `${UI.esc(r.hours_pending)} h${r.hours_pending > r.preauth_tat_hours ? ' ⚠' : ''}` : '—' },
    ], rows, { emptyText: 'No pre-authorisation requests yet.' });
    UI.bindRows(host, rows, (r) => openPreauth(r.id, () => preauthTab(body)));
  }

  // --------------------------------------------------------------- claims tab
  async function claimTab(body) {
    const { rows } = await API.get('/api/insurance/claims');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Claims</h3>
        ${APP.can(['cashier', 'reception', 'counselor'])
          ? '<button class="btn ghost sm" id="new-claim">+ Raise claim from a bill</button>' : ''}</div>
      <div class="card-body tight" id="cl-list"></div></div>`;
    const nc = body.querySelector('#new-claim');
    if (nc) nc.addEventListener('click', () => openClaimForm(() => claimTab(body)));

    const host = body.querySelector('#cl-list');
    host.innerHTML = UI.table([
      { label: 'Claim', render: (r) => `<code>${UI.esc(r.claim_no)}</code>` +
        (r.claim_type === 'reimbursement' ? ' ' + UI.badge('Reimb.', 'info') : '') },
      { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
      { label: 'Insurer', render: (r) => `${UI.esc(r.insurer_name)}<div class="muted small">${UI.esc(r.policy_no)}</div>` },
      { label: 'Bill', render: (r) => UI.esc(r.invoice_no || '—') },
      { label: 'Claimed', num: true, render: (r) => UI.money(r.claimed_amount) },
      { label: 'Approved', num: true, render: (r) => UI.money(r.approved_amount) },
      { label: 'Received', num: true, render: (r) => UI.money(r.settled_amount) },
      { label: 'Outstanding', num: true, render: (r) => {
        const out = r.approved_amount - r.settled_amount;
        return out > 0.009 ? `<b style="color:var(--danger)">${UI.money(out)}</b>` : UI.money(0);
      } },
      { label: 'Status', render: (r) => UI.statusBadge(r.status) },
      { label: 'Due', render: (r) => {
        if (!r.due_at) return '—';
        const overdue = r.due_at < UI.today() &&
          !['settled', 'rejected', 'closed', 'cancelled'].includes(r.status);
        return `<span${overdue ? ' style="color:var(--danger);font-weight:600"' : ''}>${UI.esc(UI.dateShort(r.due_at))}${overdue ? ' ⚠' : ''}</span>`;
      } },
    ], rows, { emptyText: 'No claims raised yet.' });
    UI.bindRows(host, rows, (r) => openClaim(r.id, () => claimTab(body)));
  }

  // ------------------------------------------------------------- policies tab
  async function policyTab(body) {
    const rows = await API.get('/api/insurance/policies');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Patient policies</h3>
        ${APP.can(['cashier', 'reception', 'counselor'])
          ? '<button class="btn ghost sm" id="new-policy">+ Add policy</button>' : ''}</div>
      <div class="card-body tight" id="pol-list"></div></div>`;
    const np = body.querySelector('#new-policy');
    if (np) np.addEventListener('click', () => openPolicyForm(null, () => policyTab(body)));

    const host = body.querySelector('#pol-list');
    host.innerHTML = UI.table([
      { label: 'Patient', render: (p) => `<b>${UI.esc(p.patient_name)}</b><div class="muted small">${UI.esc(p.uhid)}</div>` },
      { label: 'Insurer', render: (p) => `${UI.esc(p.insurer_name)} ${UI.badge(UI.titleise(p.insurer_kind), 'teal')}` },
      { label: 'Policy no.', render: (p) => `<code>${UI.esc(p.policy_no)}</code>` +
        (p.member_id ? `<div class="muted small">${UI.esc(p.member_id)}</div>` : '') },
      { label: 'Sum insured', num: true, render: (p) => UI.money(p.sum_insured) },
      { label: 'Balance', num: true, render: (p) => p.balance > 0
        ? `<b style="color:var(--ok)">${UI.money(p.balance)}</b>`
        : `<b style="color:var(--danger)">${UI.money(0)}</b>` },
      { label: 'Co-pay', num: true, render: (p) => `${UI.esc(p.copay_pct)}%` },
      { label: 'Room cap', num: true, render: (p) => p.room_rent_limit ? UI.money(p.room_rent_limit) : '—' },
      { label: 'Valid to', render: (p) => UI.esc(p.valid_to ? UI.date(p.valid_to) : '—') },
      { label: 'Status', render: (p) => UI.statusBadge(p.status) +
        (p.verified_at ? ' ' + UI.badge('Verified', 'ok') : ' ' + UI.badge('Unverified', 'warn')) },
    ], rows, { emptyText: 'No policies on file. Add one from a patient record or here.' });
    UI.bindRows(host, rows, (p) => openPolicy(p, () => policyTab(body)));
  }

  // ---------------------------------------------------------- receivables tab
  async function receivableTab(body) {
    const r = await API.get('/api/insurance/receivables');
    const a = r.ageing || {};
    body.innerHTML = `
      <div class="grid c4 mb">
        ${[['0–30 days', a.d0_30, 'ok'], ['31–60 days', a.d31_60, 'teal'],
           ['61–90 days', a.d61_90, 'orange'], ['Over 90 days', a.d90_plus, 'crimson']]
          .map(([label, value, cls]) => `<div class="stat ${cls}">
            <div class="label">${UI.esc(label)}</div><div class="value">${UI.money(value || 0)}</div></div>`).join('')}
      </div>

      <div class="card"><div class="card-head"><h3>Outstanding by insurer</h3></div>
        <div class="card-body">${UI.bars((r.byInsurer || []).map((i) =>
          ({ label: i.insurer_name, value: i.outstanding, display: UI.money(i.outstanding) })), { colour: 'crimson' })}
        </div>
        <div class="card-body tight">${UI.table([
          { label: 'Insurer / TPA', render: (i) => `<b>${UI.esc(i.insurer_name)}</b> ${UI.badge(UI.titleise(i.kind), 'teal')}` },
          { label: 'Open claims', num: true, key: 'open_claims' },
          { label: 'Claimed', num: true, render: (i) => UI.money(i.claimed) },
          { label: 'Outstanding', num: true, render: (i) => `<b>${UI.money(i.outstanding)}</b>` },
          { label: 'Avg days pending', num: true, render: (i) => UI.num(i.avg_days_pending, 0) },
        ], r.byInsurer, { emptyText: 'Nothing outstanding with any insurer.' })}</div>
      </div>

      <div class="card"><div class="card-head"><h3>Past their settlement date</h3>
        <span class="muted small">Chase these first</span></div>
        <div class="card-body tight">${UI.table([
          { label: 'Claim', render: (c) => `<code>${UI.esc(c.claim_no)}</code>` },
          { label: 'Patient', key: 'patient_name' },
          { label: 'Insurer', key: 'insurer_name' },
          { label: 'Was due', render: (c) => UI.esc(UI.date(c.due_at)) },
          { label: 'Outstanding', num: true, render: (c) => `<b style="color:var(--danger)">${UI.money(c.outstanding)}</b>` },
        ], r.overdue, { emptyText: 'Nothing is overdue. 👏' })}</div>
      </div>`;
  }

  // ------------------------------------------------------------ insurers tab
  async function insurerTab(body) {
    const rows = await API.get('/api/insurance/insurers');
    body.innerHTML = `<div class="card">
      <div class="card-head"><h3>Empanelled insurers, TPAs and schemes</h3>
        ${APP.can(['admin', 'cashier']) ? '<button class="btn ghost sm" id="new-insurer">+ Add</button>' : ''}</div>
      <div class="card-body tight" id="ins-list"></div></div>`;
    const ni = body.querySelector('#new-insurer');
    if (ni) ni.addEventListener('click', () => openInsurerForm(() => insurerTab(body)));

    const host = body.querySelector('#ins-list');
    host.innerHTML = UI.table([
      { label: 'Name', render: (i) => `<b>${UI.esc(i.name)}</b><div class="muted small">${UI.esc(i.code)}</div>` },
      { label: 'Type', render: (i) => UI.badge(UI.titleise(i.kind), i.kind === 'tpa' ? 'orange' : i.kind === 'government_scheme' ? 'info' : 'teal') },
      { label: 'Administered by', render: (i) => UI.esc(i.administered_by_name || '—') },
      { label: 'Cashless', render: (i) => i.cashless ? UI.badge('Yes', 'ok') : UI.badge('No', 'warn') },
      { label: 'Pre-auth TAT', num: true, render: (i) => `${UI.esc(i.preauth_tat_hours)} h` },
      { label: 'Settlement', num: true, render: (i) => `${UI.esc(i.settlement_days)} d` },
      { label: 'Policies', num: true, key: 'policy_count' },
      { label: 'Open claims', num: true, key: 'open_claims' },
      { label: 'Receivable', num: true, render: (i) => UI.money(i.receivable) },
    ], rows, { emptyText: 'No insurers configured.' });
  }

  // ============================================================ policy forms
  async function openPolicyForm(patient, onDone) {
    const insurers = await API.get('/api/insurance/insurers');
    const grouped = [{ value: '', label: '— select insurer, TPA or scheme —' }];
    for (const kind of ['insurer', 'tpa', 'government_scheme']) {
      const set = insurers.filter((i) => i.kind === kind);
      if (!set.length) continue;
      grouped.push({ value: '', label: `── ${UI.titleise(kind)} ──`, disabled: true });
      for (const i of set) grouped.push({ value: i.id, label: `   ${i.name}` });
    }

    UI.modal({
      title: patient ? `Add a policy — ${patient.first_name} ${patient.last_name || ''}` : 'Add a patient policy',
      size: 'wide',
      body: `
        ${patient ? '' : `<div class="search-row"><input type="search" id="pol-q" placeholder="Search patient by name, UHID or phone…" autofocus></div>
          <div id="pol-res"></div><div id="pol-chosen"></div>`}
        <form id="pol-form">
          <fieldset><legend>Cover</legend>
            <div class="grid c2">
              ${UI.field({ name: 'insurerId', label: 'Insurer / TPA / scheme', required: true, options: grouped })}
              ${UI.field({ name: 'scheme', label: 'Scheme type', value: 'retail',
                options: ['retail', 'corporate', 'group', 'government', 'esic', 'cghs']
                  .map((v) => ({ value: v, label: UI.titleise(v) })) })}
            </div>
            <div class="grid c3">
              ${UI.field({ name: 'policyNo', label: 'Policy number', required: true })}
              ${UI.field({ name: 'memberId', label: 'Member / employee ID' })}
              ${UI.field({ name: 'cardNumber', label: 'Health card number' })}
            </div>
          </fieldset>
          <fieldset><legend>Limits</legend>
            <div class="grid c3">
              ${UI.field({ name: 'sumInsured', label: 'Sum insured', type: 'number', step: '0.01', required: true })}
              ${UI.field({ name: 'sumUtilised', label: 'Already utilised this year', type: 'number', step: '0.01', value: 0 })}
              ${UI.field({ name: 'copayPct', label: 'Co-pay %', type: 'number', step: '0.1', value: 0,
                hint: "The patient's own share of every approved amount" })}
            </div>
            <div class="grid c3">
              ${UI.field({ name: 'roomRentLimit', label: 'Room rent cap per day', type: 'number', step: '0.01',
                hint: 'Exceeding it triggers a proportionate deduction' })}
              ${UI.field({ name: 'validFrom', label: 'Valid from', type: 'date' })}
              ${UI.field({ name: 'validTo', label: 'Valid to', type: 'date' })}
            </div>
            <div class="grid c2">
              ${UI.field({ name: 'policyHolder', label: 'Policy holder', hint: 'If not the patient' })}
              ${UI.field({ name: 'relationship', label: 'Relationship to holder', value: 'self',
                options: ['self', 'spouse', 'child', 'parent', 'other'].map((v) => ({ value: v, label: UI.titleise(v) })) })}
            </div>
            ${UI.field({ name: 'waitingTill', label: 'Initial waiting period until', type: 'date' })}
            ${UI.field({ name: 'notes', label: 'Notes' })}
          </fieldset>
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save policy</button>`,
      onMount(modal) {
        if (patient) { modal.__patient = patient; return; }
        let chosen = null;
        modal.__patient = null;
        let t;
        modal.querySelector('#pol-q').addEventListener('input', (e) => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = e.target.value.trim();
            const host = modal.querySelector('#pol-res');
            if (q.length < 2) return void (host.innerHTML = '');
            const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
            host.innerHTML = res.rows.map((p) =>
              `<button type="button" class="btn ghost sm block mb" data-pid="${p.id}" style="justify-content:flex-start">
                ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)} · ${UI.esc(p.phone || '')}</button>`).join('')
              || '<div class="muted small">No match.</div>';
            host.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', () => {
              chosen = res.rows.find((p) => p.id === Number(b.dataset.pid));
              modal.__patient = chosen;
              host.innerHTML = '';
              modal.querySelector('#pol-q').value = '';
              modal.querySelector('#pol-chosen').innerHTML =
                `<div class="alert ok"><b>${UI.esc(chosen.first_name)} ${UI.esc(chosen.last_name || '')}</b> · ${UI.esc(chosen.uhid)}</div>`;
            }));
          }, 220);
        });
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const chosen = modal.__patient;
        if (!chosen) { UI.err('Choose a patient first.'); return 'keep'; }
        const form = modal.querySelector('#pol-form');
        if (!form.reportValidity()) return 'keep';
        await API.post('/api/insurance/policies', { patientId: chosen.id, ...UI.formValues(form) });
        UI.ok('Policy saved. The patient is now marked as insured.');
        if (onDone) onDone();
      },
    });
  }

  function openPolicy(policy, onDone) {
    UI.modal({
      title: `${policy.insurer_name} — ${policy.policy_no}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(policy.status)}
            ${policy.verified_at ? UI.badge('Verified', 'ok') : UI.badge('Not verified', 'warn')}
            ${policy.cashless ? UI.badge('Cashless', 'teal') : UI.badge('Reimbursement only', 'orange')}</div>
          <span class="muted small">${UI.esc(policy.patient_name)} · ${UI.esc(policy.uhid)}</span>
        </div>
        <div class="grid c2">
          <fieldset><legend>Cover</legend><dl class="kv">
            <dt>Sum insured</dt><dd>${UI.money(policy.sum_insured)}</dd>
            <dt>Utilised</dt><dd>${UI.money(policy.sum_utilised)}</dd>
            <dt>Balance</dt><dd><b>${UI.money(policy.balance)}</b></dd>
            <dt>Co-pay</dt><dd>${UI.esc(policy.copay_pct)}%</dd>
            <dt>Room cap</dt><dd>${policy.room_rent_limit ? UI.money(policy.room_rent_limit) + ' / day' : 'none'}</dd>
            <dt>Valid</dt><dd>${UI.esc(policy.valid_from ? UI.date(policy.valid_from) : '—')} → ${UI.esc(policy.valid_to ? UI.date(policy.valid_to) : '—')}</dd>
            <dt>Member ID</dt><dd>${UI.esc(policy.member_id || '—')}</dd>
          </dl></fieldset>
          <fieldset><legend>Check cover for an episode</legend>
            <form id="elig-form">
              <div class="grid c3">
                ${UI.field({ name: 'estimate', label: 'Estimated bill', type: 'number', value: 50000 })}
                ${UI.field({ name: 'roomTariff', label: 'Room per day', type: 'number', value: 0 })}
                ${UI.field({ name: 'stayDays', label: 'Stay (days)', type: 'number', value: 3 })}
              </div>
              <button class="btn teal block" type="submit">Check eligibility</button>
            </form>
            <div id="elig-out" class="mt"></div>
          </fieldset>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${!policy.verified_at && APP.can(['cashier', 'reception', 'counselor'])
          ? '<button class="btn ghost" data-act="verify">Mark verified</button>' : ''}
        ${APP.can(['cashier', 'reception', 'counselor'])
          ? '<button class="btn" data-act="preauth">Raise pre-authorisation</button>' : ''}`,
      onMount(modal) {
        const form = modal.querySelector('#elig-form');
        const run = async (e) => {
          if (e) e.preventDefault();
          const v = UI.formValues(form);
          const r = await API.get(`/api/insurance/policies/${policy.id}/eligibility` + API.qs(v));
          modal.querySelector('#elig-out').innerHTML = eligibilityCard(r);
        };
        form.addEventListener('submit', run);
        run();
      },
      async onAction(act) {
        if (act === 'verify') {
          await API.post(`/api/insurance/policies/${policy.id}/verify`);
          UI.ok('Policy marked verified.');
          if (onDone) onDone();
          return;
        }
        if (act === 'preauth') {
          openPreauthForm(policy);
          return 'keep';
        }
      },
    });
  }

  function eligibilityCard(r) {
    if (!r) return '';
    return `
      ${r.blockers.length ? `<div class="alert danger"><b>Not usable:</b> ${r.blockers.map(UI.esc).join(' ')}</div>` : ''}
      ${r.warnings.map((w) => `<div class="alert warn">${UI.esc(w)}</div>`).join('')}
      <dl class="kv">
        <dt>Balance available</dt><dd><b>${UI.money(r.balance)}</b></dd>
        ${r.roomRent ? `<dt>Room cap</dt><dd>${UI.money(r.roomRent.limitPerDay)}/day vs ${UI.money(r.roomRent.chosenPerDay)}/day
          ${r.roomRent.withinLimit ? UI.badge('within limit', 'ok')
            : UI.badge(`${Math.round(r.roomRent.eligibleRatio * 100)}% eligible`, 'warn')}</dd>` : ''}
        <dt>Co-pay (${UI.esc(r.copayPct)}%)</dt><dd>${UI.money(r.copayAmount)}</dd>
        <dt>Insurer could bear</dt><dd><b style="color:var(--ok)">${UI.money(r.maxCashless)}</b></dd>
        <dt>Patient would bear</dt><dd><b style="color:var(--crimson)">${UI.money(r.patientBears)}</b></dd>
        ${r.alreadyCommitted ? `<dt>Already committed</dt><dd>${UI.money(r.alreadyCommitted)} on open approvals</dd>` : ''}
      </dl>`;
  }

  // ========================================================== pre-auth forms
  async function openPreauthForm(policy) {
    const policies = policy ? [policy] : await API.get('/api/insurance/policies');
    const usable = policies.filter((p) => p.status === 'active');
    if (!usable.length) {
      return UI.err('No active policy on file. Add one first.');
    }
    const doctors = await API.get('/api/masters/staff?role=doctor');

    UI.modal({
      title: 'Raise a pre-authorisation',
      size: 'wide',
      body: `<form id="pa-form">
        <fieldset><legend>Policy</legend>
          ${UI.field({ name: 'policyId', label: 'Policy', required: true, value: policy ? policy.id : '',
            options: [{ value: '', label: '— select —' }].concat(usable.map((p) =>
              ({ value: p.id, label: `${p.patient_name || ''} · ${p.insurer_name} · ${p.policy_no} (balance ${p.balance})` }))) })}
          <div id="pa-elig"></div>
        </fieldset>
        <fieldset><legend>Clinical</legend>
          <div class="grid c2">
            ${UI.field({ name: 'kind', label: 'Type', value: 'planned',
              options: ['planned', 'emergency', 'daycare'].map((k) => ({ value: k, label: UI.titleise(k) })) })}
            ${UI.field({ name: 'doctorId', label: 'Treating doctor',
              options: [{ value: '', label: '— select —' }].concat(doctors.map((d) => ({ value: d.id, label: d.name }))) })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'icdCode', label: 'ICD-10 code', placeholder: 'e.g. K80.2' })}
            ${UI.field({ name: 'diagnosis', label: 'Diagnosis', required: true })}
          </div>
          ${UI.field({ name: 'procedureName', label: 'Proposed procedure / line of treatment' })}
          ${UI.field({ name: 'treatmentPlan', label: 'Treatment plan', type: 'textarea', rows: 2 })}
          ${UI.field({ name: 'clinicalNotes', label: 'Clinical justification', type: 'textarea', rows: 3,
            hint: 'The insurer decides on this — be specific about findings and why admission is needed' })}
          ${UI.field({ name: 'pastHistory', label: 'Relevant past history', type: 'textarea', rows: 2,
            hint: 'Duration of symptoms matters for pre-existing-disease clauses' })}
        </fieldset>
        <fieldset><legend>Estimate</legend>
          <div class="grid c4">
            ${UI.field({ name: 'requestedAmount', label: 'Amount requested', type: 'number', step: '0.01', required: true })}
            ${UI.field({ name: 'estimatedStayDays', label: 'Expected stay (days)', type: 'number', value: 2 })}
            ${UI.field({ name: 'roomCategory', label: 'Room category',
              options: ['', 'General', 'Semi-private', 'Private', 'Deluxe', 'ICU'] })}
            ${UI.field({ name: 'roomTariffPerDay', label: 'Room tariff / day', type: 'number', step: '0.01' })}
          </div>
        </fieldset>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Create request</button>`,
      onMount(modal) {
        const check = async () => {
          const v = UI.formValues(modal.querySelector('#pa-form'));
          if (!v.policyId) return void (modal.querySelector('#pa-elig').innerHTML = '');
          const r = await API.get(`/api/insurance/policies/${v.policyId}/eligibility` +
            API.qs({ estimate: v.requestedAmount || 0, roomTariff: v.roomTariffPerDay || 0, stayDays: v.estimatedStayDays || 1 }));
          modal.querySelector('#pa-elig').innerHTML = eligibilityCard(r);
        };
        ['policyId', 'requestedAmount', 'roomTariffPerDay', 'estimatedStayDays'].forEach((n) => {
          const f = modal.querySelector(`[name=${n}]`);
          if (f) { f.addEventListener('change', check); f.addEventListener('input', check); }
        });
        check();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#pa-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post('/api/insurance/preauths', UI.formValues(form));
        UI.ok(`Pre-authorisation ${res.preauth.preauth_no} created — collect the documents, then submit.`);
        APP.navigate('insurance', { preauthId: res.preauth.id });
      },
    });
  }

  async function openPreauth(id, onDone) {
    const pa = await API.get(`/api/insurance/preauths/${id}`);
    const desk = APP.can(['cashier', 'reception', 'counselor']);

    UI.modal({
      title: `${pa.preauth_no} — ${pa.patient_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(pa.status)}
            ${pa.kind === 'enhancement' ? UI.badge('Enhancement on ' + pa.parent_no, 'orange') : UI.badge(UI.titleise(pa.kind), 'teal')}
            ${UI.badge(pa.insurer_name, 'info')}</div>
          <span class="muted small">${UI.esc(pa.uhid)} · ${UI.esc(pa.ip_no || pa.visit_no || 'no episode linked')}</span>
        </div>

        ${pa.status === 'query_raised' ? `<div class="alert warn"><b>The insurer has raised a query.</b>
          Answer it below, tick off anything extra they asked for, then re-submit.</div>` : ''}
        ${pa.status === 'approved' || pa.status === 'partially_approved' ? `<div class="alert ok">
          <b>Approved ${UI.money(pa.approved_amount)}</b>${pa.approval_no ? ` · approval ${UI.esc(pa.approval_no)}` : ''}
          ${pa.copay_amount ? ` · patient co-pay ${UI.money(pa.copay_amount)}` : ''}
          ${pa.valid_till ? ` · valid until ${UI.esc(UI.date(pa.valid_till))}` : ''}</div>` : ''}
        ${pa.status === 'rejected' ? `<div class="alert danger"><b>Rejected.</b> ${UI.esc(pa.rejection_reason || '')}</div>` : ''}

        <div class="grid c2">
          <div>
            <fieldset><legend>Request</legend><dl class="kv">
              <dt>Policy</dt><dd>${UI.esc(pa.policy_no)} ${pa.member_id ? '· ' + UI.esc(pa.member_id) : ''}</dd>
              <dt>Sum insured</dt><dd>${UI.money(pa.sum_insured)} (used ${UI.money(pa.sum_utilised)})</dd>
              <dt>Diagnosis</dt><dd>${UI.esc(pa.icd_code || '')} ${UI.esc(pa.diagnosis || '')}</dd>
              <dt>Procedure</dt><dd>${UI.esc(pa.procedure_name || '—')}</dd>
              <dt>Doctor</dt><dd>${UI.esc(pa.doctor_name || '—')}</dd>
              <dt>Stay / room</dt><dd>${UI.esc(pa.estimated_stay_days || '—')} day(s) · ${UI.esc(pa.room_category || '—')}</dd>
              <dt>Requested</dt><dd><b>${UI.money(pa.requested_amount)}</b></dd>
              ${pa.reference_no ? `<dt>Insurer ref.</dt><dd>${UI.esc(pa.reference_no)}</dd>` : ''}
            </dl>
            ${pa.treatment_plan ? `<div class="small mt"><b>Plan:</b> ${UI.esc(pa.treatment_plan)}</div>` : ''}
            ${pa.clinical_notes ? `<div class="small mt"><b>Justification:</b> ${UI.esc(pa.clinical_notes)}</div>` : ''}
            </fieldset>

            ${pa.enhancements.length ? `<fieldset><legend>Enhancements</legend>
              ${pa.enhancements.map((e) => `<div class="row-between small mb">
                <a href="#/insurance?preauthId=${e.id}" onclick="UI.closeAllModals()">${UI.esc(e.preauth_no)}</a>
                <span>${UI.money(e.requested_amount)} → ${UI.money(e.approved_amount)} ${UI.statusBadge(e.status)}</span>
              </div>`).join('')}</fieldset>` : ''}
          </div>

          <div>
            <fieldset><legend>Document checklist</legend>
              <div id="pa-docs">${docChecklist(pa.documents)}</div>
              ${desk ? '<button class="btn ghost sm block mt" id="add-doc">+ Add a document</button>' : ''}
            </fieldset>

            <fieldset><legend>History</legend>
              <ul class="timeline">${pa.events.map((e) => `<li>
                <b>${UI.esc(UI.titleise(e.event))}</b>
                <div class="muted small">${UI.esc(e.detail || '')}</div>
                <span class="when">${UI.esc(UI.dateTime(e.created_at))}${e.actor_name ? ' · ' + UI.esc(e.actor_name) : ''}</span>
              </li>`).join('')}</ul>
            </fieldset>
          </div>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print request</button>
        ${desk && ['draft', 'query_raised'].includes(pa.status) ? '<button class="btn teal" data-act="submit">Submit to insurer</button>' : ''}
        ${desk && pa.status === 'submitted' ? '<button class="btn ghost" data-act="query">Record a query</button>' : ''}
        ${desk && ['submitted', 'query_raised'].includes(pa.status) ? '<button class="btn" data-act="decision">Record decision</button>' : ''}
        ${desk && ['approved', 'partially_approved'].includes(pa.status) ? '<button class="btn ghost" data-act="enhance">Request enhancement</button>' : ''}
        ${desk && ['draft', 'submitted', 'query_raised'].includes(pa.status) ? '<button class="btn ghost" data-act="withdraw">Withdraw</button>' : ''}`,

      onMount(modal) {
        wireDocs(modal, () => { UI.closeAllModals(); openPreauth(id, onDone); });
        const add = modal.querySelector('#add-doc');
        if (add) add.addEventListener('click', async () => {
          const name = prompt('Document name?');
          if (!name) return;
          await API.post('/api/insurance/documents', { preauthId: id, docType: name });
          UI.closeAllModals(); openPreauth(id, onDone);
        });
      },

      async onAction(act) {
        const reopen = () => { UI.closeAllModals(); openPreauth(id, onDone); };
        if (act === 'print') { printPreauth(pa); return 'keep'; }
        if (act === 'submit') {
          try {
            await API.post(`/api/insurance/preauths/${id}/submit`, {
              referenceNo: prompt('Insurer reference number (optional)?') || null,
            });
            UI.ok('Submitted to the insurer.');
          } catch (err) {
            if (err.status === 409) {
              if (!(await UI.confirm(err.message, { title: 'Documents outstanding' }))) return 'keep';
              await API.post(`/api/insurance/preauths/${id}/submit`, { submitIncomplete: true });
              UI.warn('Submitted with documents outstanding.');
            } else throw err;
          }
          reopen(); return 'keep';
        }
        if (act === 'query') { openQueryForm('preauths', id, reopen); return 'keep'; }
        if (act === 'decision') { openPreauthDecision(pa, reopen); return 'keep'; }
        if (act === 'enhance') { openEnhanceForm(pa, reopen); return 'keep'; }
        if (act === 'withdraw') {
          if (!(await UI.confirm('Withdraw this pre-authorisation request?'))) return 'keep';
          await API.post(`/api/insurance/preauths/${id}/withdraw`, { reason: 'Withdrawn by the clinic' });
          UI.ok('Withdrawn.');
          if (onDone) onDone();
          return;
        }
      },
    });
  }

  function openPreauthDecision(pa, onDone) {
    UI.modal({
      title: `Record the insurer's decision — ${pa.preauth_no}`,
      body: `<div class="alert info">Requested <b>${UI.money(pa.requested_amount)}</b>.
          Co-pay of ${UI.esc(pa.copay_pct || 0)}% is worked out from whatever is approved.</div>
        <form id="dec-form">
          ${UI.field({ name: 'decision', label: 'Decision', required: true,
            options: [{ value: 'approved', label: 'Approved in full' },
                      { value: 'partially_approved', label: 'Partially approved' },
                      { value: 'rejected', label: 'Rejected' }] })}
          <div class="grid c2">
            ${UI.field({ name: 'approvedAmount', label: 'Amount approved', type: 'number', step: '0.01',
              value: pa.requested_amount, max: pa.requested_amount })}
            ${UI.field({ name: 'approvalNo', label: 'Approval / authorisation number' })}
          </div>
          ${UI.field({ name: 'validTill', label: 'Approval valid until', type: 'date' })}
          ${UI.field({ name: 'reason', label: 'Reason (if rejected)', type: 'textarea', rows: 2 })}
          ${UI.field({ name: 'remarks', label: 'Remarks' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Record decision</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#dec-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post(`/api/insurance/preauths/${pa.id}/decision`, UI.formValues(form));
        UI.ok(res.preauth.status === 'rejected'
          ? 'Rejection recorded — the bill falls to the patient.'
          : `Approved ${UI.money(res.preauth.approved_amount)}. The bill has been updated.`);
        if (onDone) onDone();
      },
    });
  }

  function openEnhanceForm(pa, onDone) {
    UI.modal({
      title: `Request an enhancement on ${pa.preauth_no}`,
      body: `<div class="alert info">Already approved: <b>${UI.money(pa.approved_amount)}</b>.
          An enhancement <b>adds to</b> that cover — it does not replace it.</div>
        <form id="enh-form">
          <div class="grid c2">
            ${UI.field({ name: 'requestedAmount', label: 'Additional amount', type: 'number', step: '0.01', required: true })}
            ${UI.field({ name: 'estimatedStayDays', label: 'Extra days', type: 'number', value: 2 })}
          </div>
          ${UI.field({ name: 'reason', label: 'Why more is needed', type: 'textarea', rows: 3, required: true,
            hint: 'e.g. converted to an open procedure; complication requiring ICU' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Raise enhancement</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#enh-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post(`/api/insurance/preauths/${pa.id}/enhance`, UI.formValues(form));
        UI.ok(`Enhancement ${res.preauth_no} raised.`);
        APP.navigate('insurance', { preauthId: res.id });
      },
    });
  }

  // ============================================================= claim forms
  async function openClaimForm(onDone) {
    const invoices = await API.get('/api/billing/invoices?limit=100');
    UI.modal({
      title: 'Raise a claim from a bill',
      body: `<div class="alert info">The claim is built from the bill's own lines. Obvious exclusions
          (registration, attendant charges) are pre-marked as non-admissible for you to confirm.</div>
        <div class="search-row"><input type="search" id="cl-q" placeholder="Search patient by name, UHID or phone…" autofocus></div>
        <div id="cl-res"></div>
        <div id="cl-form-host"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>`,
      onMount(modal) {
        let t;
        modal.querySelector('#cl-q').addEventListener('input', (e) => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = e.target.value.trim();
            const host = modal.querySelector('#cl-res');
            if (q.length < 2) return void (host.innerHTML = '');
            const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
            host.innerHTML = res.rows.map((p) =>
              `<button type="button" class="btn ghost sm block mb" data-pid="${p.id}" style="justify-content:flex-start">
                ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)}</button>`).join('')
              || '<div class="muted small">No match.</div>';
            host.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', async () => {
              const pid = Number(b.dataset.pid);
              const [ins, bills] = await Promise.all([
                API.get(`/api/insurance/patient/${pid}`),
                API.get('/api/billing/invoices' + API.qs({ patientId: pid })),
              ]);
              host.innerHTML = '';
              const claimable = bills.rows.filter((i) => i.status !== 'cancelled');
              if (!ins.policies.length) {
                modal.querySelector('#cl-form-host').innerHTML =
                  '<div class="alert warn">This patient has no policy on file. Add one first.</div>';
                return;
              }
              const approvedPreauths = ins.preauths.filter((p) =>
                ['approved', 'partially_approved'].includes(p.status));
              modal.querySelector('#cl-form-host').innerHTML = `
                <form id="claim-form">
                  ${UI.field({ name: 'policyId', label: 'Policy', required: true,
                    options: ins.policies.map((p) => ({ value: p.id, label: `${p.insurer_name} · ${p.policy_no} (balance ${p.balance})` })) })}
                  ${UI.field({ name: 'invoiceId', label: 'Bill to claim', required: true,
                    options: [{ value: '', label: '— select —' }].concat(claimable.map((i) =>
                      ({ value: i.id, label: `${i.invoice_no} · ${i.kind.toUpperCase()} · net ${i.net}` }))) })}
                  ${UI.field({ name: 'preauthId', label: 'Against pre-authorisation',
                    options: [{ value: '', label: '— none (reimbursement) —' }].concat(approvedPreauths.map((p) =>
                      ({ value: p.id, label: `${p.preauth_no} · approved ${p.approved_amount}` }))) })}
                  ${UI.field({ name: 'claimType', label: 'Claim type', value: 'cashless',
                    options: [{ value: 'cashless', label: 'Cashless — insurer pays the clinic' },
                              { value: 'reimbursement', label: 'Reimbursement — insurer pays the patient' }] })}
                  ${UI.field({ name: 'remarks', label: 'Remarks' })}
                  <button class="btn block" type="submit">Build the claim</button>
                </form>`;
              modal.querySelector('#claim-form').addEventListener('submit', async (ev) => {
                ev.preventDefault();
                try {
                  const claim = await API.post('/api/insurance/claims', UI.formValues(ev.target));
                  UI.ok(`Claim ${claim.claim_no} built from the bill.`);
                  APP.navigate('insurance', { claimId: claim.id });
                } catch (err) { UI.err(err.message); }
              });
            }));
          }, 220);
        });
      },
    });
    void onDone;
  }

  async function openClaim(id, onDone) {
    const c = await API.get(`/api/insurance/claims/${id}`);
    const desk = APP.can(['cashier', 'reception', 'counselor']);
    const outstanding = c.approved_amount - c.settled_amount;

    UI.modal({
      title: `${c.claim_no} — ${c.patient_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(c.status)}
            ${UI.badge(c.claim_type === 'cashless' ? 'Cashless' : 'Reimbursement', c.claim_type === 'cashless' ? 'teal' : 'info')}
            ${UI.badge(c.insurer_name, 'info')}
            ${c.preauth_no ? UI.badge('Pre-auth ' + c.preauth_no, 'orange') : ''}</div>
          <span class="muted small">${UI.esc(c.uhid)} · bill ${UI.esc(c.invoice_no || '—')}</span>
        </div>

        ${c.status === 'query_raised' ? '<div class="alert warn"><b>Query raised by the insurer</b> — see the history below.</div>' : ''}
        ${c.status === 'rejected' ? `<div class="alert danger"><b>Rejected.</b> ${UI.esc(c.rejection_reason || '')}
          The full amount has returned to the patient.</div>` : ''}
        ${c.status === 'partially_settled' && outstanding > 0 ? `<div class="alert warn">
          <b>${UI.money(outstanding)}</b> of the approved amount is still awaited.</div>` : ''}

        <div class="grid c4 mb">
          <div class="stat teal"><div class="label">Billed</div><div class="value" style="font-size:20px">${UI.money(c.billed_amount)}</div></div>
          <div class="stat orange"><div class="label">Claimed</div><div class="value" style="font-size:20px">${UI.money(c.claimed_amount)}</div></div>
          <div class="stat crimson"><div class="label">Approved</div><div class="value" style="font-size:20px">${UI.money(c.approved_amount)}</div>
            <div class="foot">Co-pay ${UI.money(c.copay_amount)}</div></div>
          <div class="stat ok"><div class="label">Received</div><div class="value" style="font-size:20px">${UI.money(c.settled_amount)}</div>
            <div class="foot">${c.utr_no ? 'UTR ' + UI.esc(c.utr_no) : c.tds_amount ? 'TDS ' + UI.money(c.tds_amount) : ''}</div></div>
        </div>

        <div class="grid sidebar-right">
          <div>
            <fieldset><legend>Claim lines</legend>
              <div class="table-wrap"><table><thead><tr>
                <th>Description</th><th class="num">Billed</th><th class="num">Claimed</th>
                <th class="num">Approved</th><th>Admissible</th><th></th>
              </tr></thead><tbody>
                ${c.items.map((i) => `<tr>
                  <td>${UI.esc(i.description)}${i.disallow_reason ? `<div class="muted small">${UI.esc(i.disallow_reason)}</div>` : ''}</td>
                  <td class="num">${UI.money(i.billed)}</td>
                  <td class="num">${UI.money(i.claimed)}</td>
                  <td class="num">${UI.money(i.approved)}</td>
                  <td>${i.admissible ? UI.badge('Yes', 'ok') : UI.badge('No', 'warn')}</td>
                  <td>${desk && !['settled', 'rejected', 'closed'].includes(c.status)
                    ? `<button class="btn ghost sm" data-item="${i.id}">Edit</button>` : ''}</td>
                </tr>`).join('')}
              </tbody></table></div>
            </fieldset>

            <fieldset><legend>History</legend>
              <ul class="timeline">${c.events.map((e) => `<li>
                <b>${UI.esc(UI.titleise(e.event))}</b>
                <div class="muted small">${UI.esc(e.detail || '')}</div>
                <span class="when">${UI.esc(UI.dateTime(e.created_at))}${e.actor_name ? ' · ' + UI.esc(e.actor_name) : ''}</span>
              </li>`).join('')}</ul>
            </fieldset>
          </div>

          <div>
            <fieldset><legend>Document checklist</legend>
              <div id="cl-docs">${docChecklist(c.documents)}</div>
            </fieldset>
            <fieldset><legend>Bill position</legend><dl class="kv">
              <dt>Bill net</dt><dd>${UI.money(c.invoice_net)}</dd>
              <dt>Patient balance</dt><dd><b style="color:${c.invoice_balance > 0 ? 'var(--danger)' : 'var(--ok)'}">${UI.money(c.invoice_balance)}</b></dd>
              <dt>Policy balance</dt><dd>${UI.money(c.sum_insured - c.sum_utilised)}</dd>
              ${c.due_at ? `<dt>Settlement due</dt><dd>${UI.esc(UI.date(c.due_at))}</dd>` : ''}
            </dl></fieldset>
          </div>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        <button class="btn ghost" data-act="print">Print claim</button>
        ${desk && ['draft', 'query_raised'].includes(c.status) ? '<button class="btn teal" data-act="submit">Submit to insurer</button>' : ''}
        ${desk && ['submitted', 'under_process'].includes(c.status) ? '<button class="btn ghost" data-act="query">Record a query</button>' : ''}
        ${desk && ['submitted', 'under_process', 'query_raised'].includes(c.status) ? '<button class="btn" data-act="decision">Record decision</button>' : ''}
        ${desk && ['approved', 'partially_settled'].includes(c.status) ? '<button class="btn ok" data-act="settle">Record settlement</button>' : ''}`,

      onMount(modal) {
        wireDocs(modal, () => { UI.closeAllModals(); openClaim(id, onDone); });
        modal.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => {
          const item = c.items.find((i) => i.id === Number(b.dataset.item));
          openClaimLine(c, item, () => { UI.closeAllModals(); openClaim(id, onDone); });
        }));
      },

      async onAction(act) {
        const reopen = () => { UI.closeAllModals(); openClaim(id, onDone); };
        if (act === 'print') { printClaim(c); return 'keep'; }
        if (act === 'submit') {
          try {
            await API.post(`/api/insurance/claims/${id}/submit`, { settlementDays: c.settlement_days });
            UI.ok('Claim dispatched to the insurer.');
          } catch (err) {
            if (err.status === 409) {
              if (!(await UI.confirm(err.message, { title: 'Documents outstanding' }))) return 'keep';
              await API.post(`/api/insurance/claims/${id}/submit`, { submitIncomplete: true });
              UI.warn('Submitted with documents outstanding.');
            } else throw err;
          }
          reopen(); return 'keep';
        }
        if (act === 'query') { openQueryForm('claims', id, reopen); return 'keep'; }
        if (act === 'decision') { openClaimDecision(c, reopen); return 'keep'; }
        if (act === 'settle') { openSettleForm(c, reopen); return 'keep'; }
      },
    });
  }

  function openClaimLine(claim, item, onDone) {
    UI.modal({
      title: 'Claim line', size: 'narrow',
      body: `<form id="li-form">
        <div class="muted mb">${UI.esc(item.description)} — billed ${UI.money(item.billed)}</div>
        ${UI.checkbox({ name: 'admissible', label: 'Admissible under the policy', checked: !!item.admissible })}
        ${UI.field({ name: 'claimed', label: 'Amount claimed', type: 'number', step: '0.01',
          value: item.claimed, max: item.billed })}
        ${UI.field({ name: 'approved', label: 'Amount approved', type: 'number', step: '0.01', value: item.approved })}
        ${UI.field({ name: 'disallowReason', label: 'Reason if disallowed', value: item.disallow_reason || '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        await API.patch(`/api/insurance/claims/${claim.id}/items/${item.id}`,
          UI.formValues(modal.querySelector('#li-form')));
        UI.ok('Claim line updated.');
        if (onDone) onDone();
      },
    });
  }

  function openClaimDecision(claim, onDone) {
    UI.modal({
      title: `Record the insurer's decision — ${claim.claim_no}`,
      body: `<div class="alert info">Claimed <b>${UI.money(claim.claimed_amount)}</b>.
          ${claim.claim_type === 'cashless'
            ? 'Approving updates the bill so the patient owes only their own share.'
            : 'This is a reimbursement claim — the bill is not affected.'}</div>
        <form id="cd-form">
          ${UI.field({ name: 'decision', label: 'Decision', required: true,
            options: [{ value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }] })}
          ${UI.field({ name: 'approvedAmount', label: 'Amount approved', type: 'number', step: '0.01',
            value: claim.claimed_amount, max: claim.claimed_amount })}
          ${UI.field({ name: 'disallowReason', label: 'Reason for any disallowance', type: 'textarea', rows: 2 })}
          ${UI.field({ name: 'reason', label: 'Reason (if rejected)', type: 'textarea', rows: 2 })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Record decision</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#cd-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post(`/api/insurance/claims/${claim.id}/decision`, UI.formValues(form));
        UI.ok(res.claim.status === 'rejected'
          ? 'Rejection recorded — the full amount returns to the patient.'
          : `Approved ${UI.money(res.claim.approved_amount)}.`);
        if (onDone) onDone();
      },
    });
  }

  function openSettleForm(claim, onDone) {
    const outstanding = claim.approved_amount - claim.settled_amount;
    UI.modal({
      title: `Record settlement — ${claim.claim_no}`,
      body: `<div class="alert info">Approved ${UI.money(claim.approved_amount)}, received so far
          ${UI.money(claim.settled_amount)}. Outstanding <b>${UI.money(outstanding)}</b>.</div>
        <form id="st-form">
          <div class="grid c2">
            ${UI.field({ name: 'settledAmount', label: 'Amount received', type: 'number', step: '0.01',
              value: outstanding.toFixed(2), required: true })}
            ${UI.field({ name: 'tdsAmount', label: 'TDS deducted', type: 'number', step: '0.01', value: 0 })}
          </div>
          ${UI.field({ name: 'utrNo', label: 'UTR / payment reference' })}
          ${UI.field({ name: 'disallowReason', label: 'Closing the claim short? Give the reason', type: 'textarea', rows: 2,
            hint: 'Leave blank if another tranche is still expected. Filling it in moves the shortfall onto the patient.' })}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ok" data-act="save">Record settlement</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#st-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.post(`/api/insurance/claims/${claim.id}/settle`, UI.formValues(form));
        UI.ok(`Recorded ${UI.money(res.receipt)}.`);
        if (res.note) UI.warn(res.note);
        if (onDone) onDone();
      },
    });
  }

  function openQueryForm(kind, id, onDone) {
    UI.modal({
      title: 'Record a query from the insurer', size: 'narrow',
      body: `<form id="q-form">
        ${UI.field({ name: 'query', label: 'What are they asking for?', type: 'textarea', rows: 3, required: true })}
        ${UI.field({ name: 'documents', label: 'Extra documents requested',
          hint: 'Separate several with a comma — each becomes a checklist item' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Record query</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#q-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        await API.post(`/api/insurance/${kind}/${id}/query`, {
          query: v.query,
          documentsRequested: (v.documents || '').split(',').map((s) => s.trim()).filter(Boolean),
        });
        UI.ok('Query recorded — answer it, then re-submit.');
        if (onDone) onDone();
      },
    });
  }

  // ------------------------------------------------------------- shared bits
  function docChecklist(docs) {
    if (!docs || !docs.length) return '<div class="muted small">No checklist.</div>';
    const done = docs.filter((d) => d.provided).length;
    return `<div class="muted small mb">${done} of ${docs.length} collected</div>` +
      docs.map((d) => `<label class="inline-check">
        <input type="checkbox" data-doc="${d.id}"${d.provided ? ' checked' : ''}>
        <span${d.provided ? ' style="color:var(--ink-3)"' : ''}>${UI.esc(d.doc_type)}</span>
      </label>`).join('');
  }

  function wireDocs(modal, onChange) {
    modal.querySelectorAll('[data-doc]').forEach((cb) => cb.addEventListener('change', async () => {
      try {
        await API.patch(`/api/insurance/documents/${cb.dataset.doc}`, { provided: cb.checked });
        if (onChange) onChange();
      } catch (err) { UI.err(err.message); cb.checked = !cb.checked; }
    }));
  }

  // ---------------------------------------------------------- printable docs
  function printPreauth(pa) {
    const html = `<div class="doc">
      ${UI.docHeader('Pre-Authorisation Request', [
        `Ref: ${pa.preauth_no}`, `Date: ${UI.date(pa.created_at)}`,
        pa.approval_no ? `Approval: ${pa.approval_no}` : ''].filter(Boolean))}
      <table><tbody>
        <tr><th>To</th><td colspan="3">${UI.esc(pa.insurer_name)}</td></tr>
        <tr><th>Patient</th><td>${UI.esc(pa.patient_name)}</td><th>UHID</th><td>${UI.esc(pa.uhid)}</td></tr>
        <tr><th>Age / Sex</th><td>${UI.esc(pa.age_years || '—')} / ${UI.esc(pa.gender || '—')}</td>
            <th>Contact</th><td>${UI.esc(pa.phone || '—')}</td></tr>
        <tr><th>Policy no.</th><td>${UI.esc(pa.policy_no)}</td><th>Member ID</th><td>${UI.esc(pa.member_id || '—')}</td></tr>
        <tr><th>Sum insured</th><td>${UI.money(pa.sum_insured)}</td>
            <th>Balance</th><td>${UI.money(pa.sum_insured - pa.sum_utilised)}</td></tr>
      </tbody></table>

      <h4 class="mt">Clinical details</h4>
      <table><tbody>
        <tr><th>Diagnosis</th><td>${UI.esc(pa.icd_code || '')} ${UI.esc(pa.diagnosis || '')}</td></tr>
        <tr><th>Proposed treatment</th><td>${UI.esc(pa.procedure_name || '—')}</td></tr>
        <tr><th>Treatment plan</th><td>${UI.esc(pa.treatment_plan || '—')}</td></tr>
        <tr><th>Clinical justification</th><td>${UI.esc(pa.clinical_notes || '—')}</td></tr>
        <tr><th>Past history</th><td>${UI.esc(pa.past_history || '—')}</td></tr>
        <tr><th>Expected stay</th><td>${UI.esc(pa.estimated_stay_days || '—')} day(s) · ${UI.esc(pa.room_category || '—')}</td></tr>
      </tbody></table>

      <h4 class="mt">Estimate</h4>
      <table><tbody>
        <tr><th>Amount requested</th><td style="font-size:16px"><b>${UI.money(pa.requested_amount)}</b></td></tr>
        ${pa.approved_amount ? `<tr><th>Amount approved</th><td><b>${UI.money(pa.approved_amount)}</b></td></tr>` : ''}
      </tbody></table>

      <h4 class="mt">Documents enclosed</h4>
      <ul style="font-size:12px">${pa.documents.map((d) =>
        `<li>${d.provided ? '☑' : '☐'} ${UI.esc(d.doc_type)}</li>`).join('')}</ul>

      <div class="sign"><div>${UI.esc(pa.doctor_name || '')}<br>Treating doctor</div>
        <div>For ${UI.esc(APP.clinic.name)}<br>Authorised signatory</div></div>
      <div class="foot-note">We confirm the above patient is admitted or scheduled for admission at this facility
        and the details furnished are true to the best of our knowledge.</div>
    </div>`;
    UI.print(html, 'Pre-authorisation ' + pa.preauth_no);
  }

  function printClaim(c) {
    const html = `<div class="doc">
      ${UI.docHeader('Insurance Claim', [`Claim: ${c.claim_no}`, `Date: ${UI.date(c.created_at)}`,
        c.preauth_no ? `Pre-auth: ${c.preauth_no}` : ''].filter(Boolean))}
      <table><tbody>
        <tr><th>To</th><td colspan="3">${UI.esc(c.insurer_name)}</td></tr>
        <tr><th>Patient</th><td>${UI.esc(c.patient_name)}</td><th>UHID</th><td>${UI.esc(c.uhid)}</td></tr>
        <tr><th>Policy no.</th><td>${UI.esc(c.policy_no)}</td><th>Member ID</th><td>${UI.esc(c.member_id || '—')}</td></tr>
        <tr><th>Episode</th><td>${UI.esc(c.ip_no || c.visit_no || '—')}</td>
            <th>Hospital bill</th><td>${UI.esc(c.invoice_no || '—')}</td></tr>
        <tr><th>Claim type</th><td>${UI.esc(UI.titleise(c.claim_type))}</td>
            <th>Approval no.</th><td>${UI.esc(c.approval_no || '—')}</td></tr>
      </tbody></table>

      <table class="mt"><thead><tr><th>#</th><th>Particulars</th><th class="num">Billed</th>
        <th class="num">Claimed</th><th>Admissible</th></tr></thead><tbody>
        ${c.items.map((i, n) => `<tr><td>${n + 1}</td><td>${UI.esc(i.description)}
          ${i.disallow_reason ? `<div style="font-size:10px;color:#74858E">${UI.esc(i.disallow_reason)}</div>` : ''}</td>
          <td class="num">${UI.money(i.billed)}</td><td class="num">${UI.money(i.claimed)}</td>
          <td>${i.admissible ? 'Yes' : 'No'}</td></tr>`).join('')}
      </tbody></table>

      <div class="totals">
        <div class="line"><span>Total billed</span><span>${UI.money(c.billed_amount)}</span></div>
        <div class="line"><span>Non-admissible</span><span>− ${UI.money(c.billed_amount - c.claimed_amount)}</span></div>
        <div class="line grand"><span>Amount claimed</span><span>${UI.money(c.claimed_amount)}</span></div>
        ${c.approved_amount ? `<div class="line"><span>Approved</span><span>${UI.money(c.approved_amount)}</span></div>` : ''}
        ${c.settled_amount ? `<div class="line"><span>Settled</span><span>${UI.money(c.settled_amount)}</span></div>` : ''}
      </div>

      <h4 class="mt">Documents enclosed</h4>
      <ul style="font-size:12px">${c.documents.map((d) =>
        `<li>${d.provided ? '☑' : '☐'} ${UI.esc(d.doc_type)}</li>`).join('')}</ul>

      <div class="sign"><div>Patient / claimant signature</div>
        <div>For ${UI.esc(APP.clinic.name)}<br>Authorised signatory</div></div>
    </div>`;
    UI.print(html, 'Claim ' + c.claim_no);
  }

  // Reachable from the patient record and the IPD screen.
  APP.openPreauth = openPreauth;
  APP.openClaim = openClaim;
  APP.openPolicyForm = openPolicyForm;
  APP.openPreauthForm = openPreauthForm;
})();
