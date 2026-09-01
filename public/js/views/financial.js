/* Financial screening — the counselor lane of the clinic workflow. */
(function () {
  'use strict';

  APP.register('financial', {
    title: 'Financial Screening',
    subtitle: 'Sliding scale and assistance programmes',

    async render(el, params) {
      APP.actions([{ id: 'new', label: '+ Start screening', kind: '', onClick: () => openStart(params) },
                   { id: 'calc', label: 'Sliding-scale calculator', onClick: openCalculator }]);

      if (params.patientId && !params.opened) setTimeout(() => openStart(params), 60);

      const [list, scale, programs] = await Promise.all([
        API.get('/api/financial/screenings'),
        API.get('/api/masters/sliding-scale'),
        API.get('/api/masters/assistance-programs'),
      ]);

      const count = (s) => list.rows.filter((r) => r.status === s).length;

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat orange"><div class="label">Waiting for a counselor</div>
            <div class="value">${UI.num(count('awaiting_counselor'))}</div><div class="foot">Sitting in the waiting room</div></div>
          <div class="stat teal"><div class="label">With a counselor</div>
            <div class="value">${UI.num(count('with_counselor'))}</div><div class="foot">In progress</div></div>
          <div class="stat crimson"><div class="label">Awaiting documents</div>
            <div class="value">${UI.num(count('docs_pending'))}</div><div class="foot">No proof of income yet</div></div>
          <div class="stat ok"><div class="label">Completed</div>
            <div class="value">${UI.num(count('completed'))}</div><div class="foot">Band assigned</div></div>
        </div>

        <div class="grid sidebar-right">
          <div class="card">
            <div class="card-head"><h3>Screening queue</h3></div>
            <div class="card-body tight" id="fs-list"></div>
          </div>

          <div>
            <div class="card"><div class="card-head"><h3>Sliding-scale bands</h3></div>
              <div class="card-body tight">${UI.table([
                { label: 'Band', render: (b) => UI.badge('Band ' + b.band, 'teal') },
                { label: 'FPL range', render: (b) => `${UI.esc(b.fpl_min)}–${b.fpl_max > 9999 ? '∞' : UI.esc(b.fpl_max)}%` },
                { label: 'Discount', num: true, render: (b) => UI.esc(b.discount_pct) + '%' },
                { label: 'Flat fee', num: true, render: (b) => UI.money(b.flat_consult_fee) },
              ], scale.bands)}</div>
            </div>

            <div class="card"><div class="card-head"><h3>Assistance programmes</h3></div>
              <div class="card-body">
                ${programs.map((p) => `<div class="mb">
                  <b>${UI.esc(p.name)}</b> ${UI.badge(UI.esc(p.coverage_pct) + '% cover', 'ok')}
                  <div class="muted small">${UI.esc(p.description || '')}</div>
                  ${p.max_fpl_pct ? `<div class="muted small">Eligible up to ${UI.esc(p.max_fpl_pct)}% FPL</div>` : ''}
                </div>`).join('')}
              </div>
            </div>
          </div>
        </div>`;

      const host = el.querySelector('#fs-list');
      host.innerHTML = UI.table([
        { label: 'Ref', render: (s) => `<code>${UI.esc(s.screening_no)}</code>` },
        { label: 'Patient', render: (s) => `<b>${UI.esc(s.patient_name)}</b><div class="muted small">${UI.esc(s.uhid)}</div>` },
        { label: 'Visit', render: (s) => UI.esc(s.visit_no || '—') },
        { label: 'FPL %', render: (s) => s.fpl_pct !== null ? UI.esc(s.fpl_pct) + '%' : '—' },
        { label: 'Band', render: (s) => s.sliding_scale_band ? UI.badge('Band ' + s.sliding_scale_band, 'teal') : '—' },
        { label: 'Discount', num: true, render: (s) => UI.esc(s.discount_pct) + '%' },
        { label: 'Counselor', render: (s) => UI.esc(s.counselor_name || '—') },
        { label: 'Status', render: (s) => UI.statusBadge(s.status) },
        { label: 'Opened', render: (s) => UI.esc(UI.ago(s.created_at)) },
      ], list.rows, { emptyText: 'No screenings open.' });
      UI.bindRows(host, list.rows, (s) => openScreening(s.id, programs));
    },
  });

  /** "Uninsured / Needs Fin. Assistance?" → open the paperwork. */
  async function openStart(params) {
    UI.modal({
      title: 'Start a financial screening',
      body: `<div class="alert info">This opens the <b>Financial Screening Paperwork</b> step. If no counselor is
        free the patient waits in the waiting room and the case sits in the queue.</div>
        <div class="search-row"><input type="search" id="fs-q" placeholder="Search patient by name, UHID or phone…" autofocus></div>
        <div id="fs-res"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>`,
      onMount(modal) {
        const input = modal.querySelector('#fs-q');
        const pick = async (patient) => {
          const res = await API.post('/api/financial/screenings', {
            patientId: patient.id, visitId: params.visitId || null, uninsured: !!patient.is_uninsured,
          });
          UI.closeModal();
          if (res.counselorAvailable) UI.ok(`Screening ${res.screening.screening_no} opened — a counselor is free.`);
          else UI.warn(`Screening ${res.screening.screening_no} queued — no counselor free, send the patient to the waiting room.`);
          APP.reload();
        };
        let t;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = input.value.trim();
            const host = modal.querySelector('#fs-res');
            if (q.length < 2) return void (host.innerHTML = '');
            const res = await API.get('/api/patients' + API.qs({ q, limit: 6 }));
            host.innerHTML = res.rows.map((p) =>
              `<button type="button" class="btn ghost sm block mb" data-pid="${p.id}" style="justify-content:flex-start">
                ${UI.esc(p.first_name)} ${UI.esc(p.last_name || '')} · ${UI.esc(p.uhid)}
                ${p.is_uninsured ? ' · uninsured' : ' · insured'}</button>`).join('')
              || '<div class="muted small">No match.</div>';
            host.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', () =>
              pick(res.rows.find((p) => p.id === Number(b.dataset.pid))).catch((e) => UI.err(e.message))));
          }, 220);
        });
        if (params.patientId) {
          API.get(`/api/patients/${params.patientId}`).then((p) => pick(p)).catch((e) => UI.err(e.message));
        }
      },
    });
  }

  /** The counselor worksheet: assess → present options → record the decision. */
  async function openScreening(id, programs) {
    const s = await API.get(`/api/financial/screenings/${id}`);
    const closed = ['completed', 'declined'].includes(s.status);

    UI.modal({
      title: `${s.screening_no} — ${s.patient_name}`,
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div>${UI.statusBadge(s.status)} ${s.uninsured ? UI.badge('Uninsured', 'orange') : UI.badge('Insured', 'ok')}
            ${s.counselor_name ? UI.badge('Counselor: ' + s.counselor_name, 'teal') : ''}</div>
          <span class="muted small">Opened ${UI.esc(UI.dateTime(s.created_at))}</span>
        </div>

        ${s.status === 'awaiting_counselor' ? `<div class="alert warn">
          <b>Waiting for a counselor.</b> Claim this case to call the patient in.</div>` : ''}
        ${s.status === 'docs_pending' ? `<div class="alert orange">
          <b>No valid proof of income yet.</b> A pay stub or income certificate is needed before a sliding-scale
          band can be assigned.</div>` : ''}

        <div class="grid c2">
          <div>
            <fieldset><legend>Run eligible programmes</legend>
              <form id="fs-assess">
                <div class="grid c2">
                  ${UI.field({ name: 'householdSize', label: 'Household size', type: 'number', min: 1, max: 20,
                    value: s.household_size || 1, required: true })}
                  ${UI.field({ name: 'annualIncome', label: 'Annual household income', type: 'number', min: 0,
                    value: s.annual_income || '', required: true })}
                </div>
                ${UI.checkbox({ name: 'uninsured', label: 'Patient is uninsured', checked: !!s.uninsured })}
                ${UI.checkbox({ name: 'hasProofOfIncome', label: 'Has a pay stub or valid proof of income', checked: !!s.has_proof_of_income })}
                ${UI.field({ name: 'proofType', label: 'Proof type', value: s.proof_type || '',
                  options: ['', 'pay_stub', 'income_certificate', 'itr', 'employer_letter', 'ration_card', 'self_declaration']
                    .map((v) => ({ value: v, label: v ? UI.titleise(v) : '— select —' })) })}
                ${UI.field({ name: 'notes', label: 'Counselor notes', type: 'textarea', rows: 2, value: s.notes || '' })}
                ${closed ? '' : '<button class="btn teal block" type="submit">Determine sliding-scale position</button>'}
              </form>
            </fieldset>
          </div>

          <div id="fs-outcome">${outcomeCard(s, programs)}</div>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
        ${s.status === 'awaiting_counselor' && APP.can(['counselor']) ? '<button class="btn teal" data-act="claim">Claim &amp; call patient</button>' : ''}
        ${!closed && s.sliding_scale_band ? `
          <button class="btn ghost" data-act="decline">Patient declines</button>
          <button class="btn ghost" data-act="defer">Defer</button>
          <button class="btn" data-act="continue">Patient continues</button>` : ''}`,

      onMount(modal) {
        const form = modal.querySelector('#fs-assess');
        if (!form || closed) return;
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!form.reportValidity()) return;
          try {
            const res = await API.post(`/api/financial/screenings/${id}/assess`, UI.formValues(form));
            modal.querySelector('#fs-outcome').innerHTML = outcomeCard(
              { ...res.screening, patient_name: s.patient_name }, programs, res.assessment);
            if (res.note) UI.warn(res.note);
            else UI.ok(`Band ${res.assessment.band} — ${res.assessment.discountPct}% discount.`);
            // Re-open so the footer actions reflect the new state.
            setTimeout(() => openScreening(id, programs), 700);
          } catch (err) { UI.err(err.message); }
        });
      },

      async onAction(act, modal) {
        if (act === 'claim') {
          await API.post(`/api/financial/screenings/${id}/claim`);
          UI.ok('Case claimed — call the patient in.');
          APP.reload();
          return;
        }
        if (!['continue', 'defer', 'decline'].includes(act)) return;
        const programSelect = modal.querySelector('[name=assistanceProgramId]');
        await API.post(`/api/financial/screenings/${id}/decide`, {
          decision: act,
          assistanceProgramId: programSelect ? programSelect.value : null,
        });
        UI.ok(act === 'continue'
          ? 'Recorded — the patient continues. Discounts will apply automatically at billing.'
          : `Recorded — patient chose to ${act}.`);
        APP.reload();
      },
    });
  }

  function outcomeCard(s, programs, assessment) {
    const band = assessment ? assessment.band : s.sliding_scale_band;
    const discount = assessment ? assessment.discountPct : s.discount_pct;
    const fpl = assessment ? assessment.fplPct : s.fpl_pct;
    const eligible = assessment ? assessment.eligiblePrograms : (s.eligible_programs_detail || []).map((p) => ({
      id: p.id, code: p.code, name: p.name, coveragePct: p.coverage_pct, description: p.description,
    }));

    return `<fieldset><legend>Present financial assistance options</legend>
      ${fpl === null || fpl === undefined ? '<div class="muted">Run the assessment to see the position.</div>' : `
        <div class="grid c2 mb">
          <div class="stat teal"><div class="label">Income vs poverty line</div>
            <div class="value">${UI.esc(fpl)}%</div><div class="foot">of the guideline for this household</div></div>
          <div class="stat crimson"><div class="label">Sliding-scale band</div>
            <div class="value">${band ? UI.esc(band) : '—'}</div><div class="foot">${UI.esc(discount || 0)}% discount on services</div></div>
        </div>
        ${!band ? '<div class="alert warn">A band cannot be assigned until proof of income is on file.</div>' : ''}
        <h4 class="mb">Eligible programmes</h4>
        ${eligible.length ? `
          ${UI.field({ name: 'assistanceProgramId', label: 'Enrol the patient in',
            value: s.assistance_program_id || '',
            options: [{ value: '', label: '— none —' }].concat(eligible.map((p) =>
              ({ value: p.id, label: `${p.name} (${p.coveragePct}% cover)` }))) })}
          ${eligible.map((p) => `<div class="small mb">✓ <b>${UI.esc(p.name)}</b> — ${UI.esc(p.description || '')}</div>`).join('')}`
          : '<div class="muted small">No programme matches this income level.</div>'}
      `}
      ${s.patient_decision ? `<div class="alert ${s.patient_decision === 'continue' ? 'ok' : 'warn'} mt">
        Patient decided to <b>${UI.esc(s.patient_decision)}</b>.</div>` : ''}
    </fieldset>`;
  }

  /** Standalone calculator — useful at the front desk before opening a case. */
  function openCalculator() {
    UI.modal({
      title: 'Sliding-scale calculator',
      size: 'narrow',
      body: `<form id="calc-form">
        ${UI.field({ name: 'householdSize', label: 'Household size', type: 'number', value: 4, min: 1, required: true })}
        ${UI.field({ name: 'annualIncome', label: 'Annual household income', type: 'number', value: 300000, min: 0, required: true })}
        ${UI.checkbox({ name: 'uninsured', label: 'Uninsured', checked: true })}
        ${UI.checkbox({ name: 'hasProofOfIncome', label: 'Proof of income available', checked: true })}
        <button class="btn teal block" type="submit">Calculate</button>
      </form>
      <div id="calc-out" class="mt"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>`,
      onMount(modal) {
        const form = modal.querySelector('#calc-form');
        const run = async (e) => {
          if (e) e.preventDefault();
          const r = await API.post('/api/financial/sliding-scale/preview', UI.formValues(form));
          modal.querySelector('#calc-out').innerHTML = `
            <dl class="kv">
              <dt>Poverty line</dt><dd>${UI.money(r.povertyLine)}</dd>
              <dt>Income as % of line</dt><dd><b>${UI.esc(r.fplPct)}%</b></dd>
              <dt>Band</dt><dd>${r.band ? UI.badge('Band ' + r.band, 'teal') : '—'}</dd>
              <dt>Discount</dt><dd>${UI.esc(r.discountPct)}%</dd>
              <dt>Flat consult fee</dt><dd>${r.flatConsultFee !== null ? UI.money(r.flatConsultFee) : '—'}</dd>
            </dl>
            <h4 class="mt mb">Eligible programmes</h4>
            ${r.eligiblePrograms.length
              ? r.eligiblePrograms.map((p) => `<div class="small">✓ ${UI.esc(p.name)} (${UI.esc(p.coveragePct)}%)</div>`).join('')
              : '<div class="muted small">None at this income level.</div>'}`;
        };
        form.addEventListener('submit', run);
        run();
      },
    });
  }
})();
