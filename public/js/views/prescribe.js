/*
 * The doctor's prescription pad.
 *
 * Medicines come from the pharmacy's own formulary, so what is written is what
 * the counter can actually hand over — and when the prescription belongs to a
 * visit, the lines land in the pharmacy queue without anyone re-typing them.
 *
 * The printed sheet follows the form an Indian patient expects: the polyclinic's
 * name and address at the top, the ℞ and the medicines in the middle, and a
 * blank box at the bottom for the doctor to stamp and sign by hand. No prices,
 * no pharmacy details, and nothing that identifies the doctor to the patient.
 */
(function () {
  'use strict';

  const FREQUENCIES = [
    { value: 'OD', label: 'OD — once a day', perDay: 1 },
    { value: 'BD', label: 'BD — twice a day', perDay: 2 },
    { value: 'TDS', label: 'TDS — three times a day', perDay: 3 },
    { value: 'QID', label: 'QID — four times a day', perDay: 4 },
    { value: 'HS', label: 'HS — at bedtime', perDay: 1 },
    { value: 'SOS', label: 'SOS — as needed', perDay: 1 },
    { value: 'STAT', label: 'STAT — at once', perDay: 1 },
  ];
  const ROUTES = ['oral', 'topical', 'inhalation', 'eye', 'ear', 'nasal', 'iv', 'im', 'sc', 'rectal'];
  const perDay = (f) => (FREQUENCIES.find((x) => x.value === f) || { perDay: 1 }).perDay;

  /**
   * Open the pad for a patient. `context` may carry a visitId (which puts the
   * medicines into the pharmacy queue) and an appointmentId.
   */
  async function open(patient, context = {}) {
    const drugs = await API.get('/api/pharmacy/drugs?limit=500');
    const lines = [];

    UI.modal({
      title: `Prescription — ${patient.first_name} ${patient.last_name || ''}`.trim(),
      size: 'wide',
      body: `
        <div class="row-between mb">
          <div class="muted small">
            ${UI.esc(patient.uhid || 'not registered')} ·
            ${UI.esc(patient.age_years || '—')} ${patient.age_years ? 'y' : ''} ·
            ${UI.esc(UI.titleise(patient.gender || '—'))}
            ${context.visitId ? ' · this visit' : ' · not tied to a visit'}
          </div>
          <div class="muted small">${UI.esc(APP.user.name)}</div>
        </div>
        ${patient.allergies ? `<div class="alert danger mb">
          <b>Recorded allergies:</b> ${UI.esc(patient.allergies)}</div>` : ''}

        <form id="rx-head">
          <div class="grid c2">
            ${UI.field({ name: 'complaints', label: 'Complaints', placeholder: 'Fever 3 days, dry cough' })}
            ${UI.field({ name: 'diagnosis', label: 'Diagnosis', placeholder: 'Acute viral pharyngitis' })}
          </div>
          ${UI.field({ name: 'findings', label: 'Examination findings',
            placeholder: 'Throat congested, chest clear, BP 124/80' })}
        </form>

        <div class="card"><div class="card-head"><h3>℞ Medicines</h3>
          <span class="muted small">From the clinic formulary — stock shown as you type</span></div>
          <div class="card-body">
            <div class="search-row">
              <input type="search" id="rx-q" placeholder="Search a medicine to add…" autocomplete="off" autofocus>
            </div>
            <div id="rx-results"></div>
            <div id="rx-lines" class="mt"></div>
          </div>
        </div>

        <form id="rx-foot">
          <div class="grid c2">
            ${UI.field({ name: 'advice', label: 'Advice', rows: 2,
              placeholder: 'Plenty of fluids, steam inhalation, rest' })}
            ${UI.field({ name: 'followUpDate', label: 'Review on', type: 'date' })}
          </div>
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save" disabled>Sign &amp; print</button>`,
      onMount(modal) {
        const saveBtn = document.querySelector('[data-act=save]');
        const linesHost = modal.querySelector('#rx-lines');
        const resultsHost = modal.querySelector('#rx-results');
        const search = modal.querySelector('#rx-q');

        const allergyHit = (drug) => {
          const terms = (patient.allergies || '').split(/[,;]/).map((a) => a.trim().toLowerCase()).filter(Boolean);
          const hay = `${drug.name} ${drug.generic_name || ''}`.toLowerCase();
          return terms.some((t) => t.length > 2 && hay.includes(t));
        };

        const draw = () => {
          linesHost.innerHTML = lines.length ? UI.table([
            { label: '#', render: (l, i) => String(i + 1) },
            { label: 'Medicine', render: (l) => `<b>${UI.esc(l.drugName)}</b>` +
              `<div class="muted small">${UI.esc(l.form || '')}` +
              `${l.scheduleType && ['H', 'H1', 'X'].includes(String(l.scheduleType).toUpperCase())
                ? ' · ' + UI.badge('Schedule ' + l.scheduleType, 'warn') : ''}` +
              `${l.allergy ? ' · ' + UI.badge('⚠ allergy', 'danger') : ''}</div>` },
            { label: 'Dose', render: (l, i) =>
              `<input type="text" value="${UI.esc(l.dose)}" data-f="dose" data-i="${i}" style="width:96px">` },
            { label: 'Frequency', render: (l, i) =>
              `<select data-f="frequency" data-i="${i}" style="width:130px">${FREQUENCIES.map((f) =>
                `<option value="${f.value}"${f.value === l.frequency ? ' selected' : ''}>${f.value}</option>`).join('')}</select>` },
            { label: 'Route', render: (l, i) =>
              `<select data-f="route" data-i="${i}" style="width:110px">${ROUTES.map((r) =>
                `<option value="${r}"${r === l.route ? ' selected' : ''}>${r.toUpperCase()}</option>`).join('')}</select>` },
            { label: 'Days', num: true, render: (l, i) =>
              `<input type="number" min="1" value="${UI.esc(l.durationDays)}" data-f="durationDays" data-i="${i}" style="width:64px;text-align:right">` },
            { label: 'Qty', num: true, render: (l, i) =>
              `<input type="number" min="0" value="${UI.esc(l.quantity)}" data-f="quantity" data-i="${i}" style="width:70px;text-align:right">` },
            { label: 'Instructions', render: (l, i) =>
              `<input type="text" value="${UI.esc(l.instructions)}" data-f="instructions" data-i="${i}" placeholder="after food" style="width:130px">` },
            { label: '', render: (l, i) => `<button type="button" class="btn ghost sm" data-rm="${i}">×</button>` },
          ], lines) : UI.empty('Search above and add the medicines you are prescribing.', '℞');

          linesHost.querySelectorAll('[data-f]').forEach((input) => {
            input.addEventListener('change', () => {
              const line = lines[Number(input.dataset.i)];
              line[input.dataset.f] = input.value;
              // Changing how long or how often re-suggests the quantity, unless
              // the doctor has already typed one of their own.
              if (['frequency', 'durationDays'].includes(input.dataset.f) && !line.qtyTouched) {
                line.quantity = perDay(line.frequency) * (Number(line.durationDays) || 0);
              }
              if (input.dataset.f === 'quantity') line.qtyTouched = true;
              setTimeout(draw, 0);
            });
          });
          linesHost.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
            lines.splice(Number(b.dataset.rm), 1);
            draw();
          }));
          saveBtn.disabled = !lines.length;
        };

        const add = (drug) => {
          if (lines.some((l) => l.drugId === drug.id)) return UI.warn(`${drug.name} is already on this prescription.`);
          lines.push({
            drugId: drug.id,
            drugName: `${drug.name}${drug.strength ? ' ' + drug.strength : ''}`,
            form: drug.form, scheduleType: drug.schedule_type,
            allergy: allergyHit(drug),
            dose: '1', frequency: 'BD', route: 'oral', durationDays: 5,
            quantity: 10, instructions: '',
          });
          if (allergyHit(drug)) UI.err(`⚠ ${drug.name} may conflict with a recorded allergy.`);
          search.value = '';
          resultsHost.innerHTML = '';
          draw();
          search.focus();
        };

        let timer;
        search.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const q = search.value.trim().toLowerCase();
            if (q.length < 2) return void (resultsHost.innerHTML = '');
            const hits = drugs.filter((dg) =>
              `${dg.name} ${dg.generic_name || ''} ${dg.code}`.toLowerCase().includes(q)).slice(0, 8);
            resultsHost.innerHTML = hits.length ? hits.map((dg) => `
              <button type="button" class="btn ghost sm block mb" data-add="${dg.id}" style="justify-content:space-between">
                <span>${UI.esc(dg.name)} ${UI.esc(dg.strength || '')}
                  <span class="muted">${UI.esc(dg.generic_name || '')}</span>
                  ${['H', 'H1', 'X'].includes(String(dg.schedule_type || '').toUpperCase())
                    ? `<span class="badge warn">Sch ${UI.esc(dg.schedule_type)}</span>` : ''}</span>
                <span class="muted small">${dg.on_hand > 0 ? dg.on_hand + ' in stock' : 'out of stock'}</span>
              </button>`).join('')
              : '<div class="muted small">Nothing in the formulary matched.</div>';
            resultsHost.querySelectorAll('[data-add]').forEach((b) =>
              b.addEventListener('click', () => add(drugs.find((dg) => dg.id === Number(b.dataset.add)))));
          }, 180);
        });
        search.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const first = resultsHost.querySelector('[data-add]');
            if (first) first.click();
          }
        });

        draw();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        if (!lines.length) { UI.err('Add at least one medicine.'); return 'keep'; }

        const payload = {
          patientId: patient.id,
          visitId: context.visitId || undefined,
          appointmentId: context.appointmentId || undefined,
          ...UI.formValues(modal.querySelector('#rx-head')),
          ...UI.formValues(modal.querySelector('#rx-foot')),
          items: lines.map((l) => ({
            drugId: l.drugId, dose: l.dose, frequency: l.frequency, route: l.route,
            durationDays: l.durationDays, quantity: l.quantity, instructions: l.instructions,
          })),
        };

        let sheet;
        try {
          sheet = await API.post('/api/prescriptions', payload);
        } catch (err) {
          if (err.status === 409 && /Safety check/.test(err.message)) {
            if (!(await UI.confirm(err.message, { title: 'Allergy warning', danger: true }))) return 'keep';
            sheet = await API.post('/api/prescriptions', { ...payload, acknowledgeWarnings: true });
          } else throw err;
        }

        UI.ok(`Prescription ${sheet.rx_no} signed.`);
        printSheet(sheet);
        if (context.onDone) context.onDone();
      },
    });
  }

  /**
   * The printed prescription.
   *
   * The page carries the polyclinic's name and address and nothing else that
   * identifies a doctor — no name, no qualification, no registration number and
   * no room. The doctor stamps and signs the sheet by hand after it comes off
   * the printer, which is what makes it theirs; the blank box at the bottom is
   * left for exactly that.
   *
   * A short doctor code is printed beside the prescription number so the clinic
   * can tell afterwards who wrote it. It means nothing to a patient, which is
   * the point: nobody should be able to read a doctor's details off a sheet
   * that leaves the building.
   */
  function printSheet(sheet) {
    const c = APP.clinic || {};
    const age = sheet.age_years ? `${sheet.age_years} yrs` : '—';

    UI.print(`
      <style>
        /* A5 is what the clinic's prescription pads are cut to. */
        .rx { width: 128mm; margin: 0 auto; font-family: Georgia, "Times New Roman", serif;
              color: #16232B; font-size: 11px; }
        .rx-head { text-align: center; border-bottom: 2px solid #9E1B34; padding-bottom: 6px; }
        .rx-head .clinic { font-size: 17px; font-weight: 700; letter-spacing: .5px; color: #9E1B34; }
        .rx-head .tag { font-size: 8px; letter-spacing: 1.4px; text-transform: uppercase; color: #176B7C; margin-top: 2px; }
        .rx-head .addr { font-size: 9.5px; color: #43555F; margin-top: 4px; }
        .rx-patient { display: flex; flex-wrap: wrap; gap: 3px 16px; padding: 8px 0;
          border-bottom: 1px dashed #B9C6CC; font-size: 10.5px; }
        .rx-patient span b { font-weight: 700; }
        .rx-note { font-size: 10.5px; margin: 7px 0 0; }
        .rx-note .k { color: #74858E; font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; }
        .rx-symbol { font-size: 26px; line-height: 1; margin: 9px 0 3px; color: #9E1B34; }
        table.rx-meds { width: 100%; border-collapse: collapse; font-size: 11px; }
        table.rx-meds td { padding: 4.5px 4px; vertical-align: top; border-bottom: 1px dotted #DFE6EA; }
        table.rx-meds .n { width: 22px; color: #74858E; }
        table.rx-meds .med { font-weight: 700; }
        table.rx-meds .sig { color: #43555F; font-size: 10px; }
        .rx-allergy { color: #B03A2E; font-weight: 700; font-size: 10.5px; margin-top: 5px; }
        /* Left blank on purpose: the doctor stamps and signs the printed sheet. */
        .rx-sign { margin-top: 16px; display: flex; justify-content: flex-end; }
        .rx-stamp { text-align: center; width: 58mm; }
        .rx-stamp-box { height: 22mm; border: 1px dashed #B9C6CC; border-radius: 3px; }
        .rx-stamp-label { margin-top: 3px; font-size: 8.5px; color: #74858E;
          letter-spacing: .06em; text-transform: uppercase; }
        .rx-foot { margin-top: 12px; border-top: 1px solid #DFE6EA; padding-top: 5px;
          font-size: 8.5px; color: #74858E; text-align: center; }
        @media print { @page { size: A5 portrait; margin: 9mm; } .rx { width: auto; } }
        @media screen { body { background: #eef1f3; padding: 14px 0; }
          .rx { background: #fff; padding: 9mm; box-shadow: 0 2px 14px rgba(0,0,0,.15); } }
      </style>
      <div class="rx">
        <div class="rx-head">
          <div class="clinic">${UI.esc(c.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS')}</div>
          <div class="tag">Care • Compassion • Commitment</div>
          <div class="addr">${UI.esc(c.address || '')}${c.phone ? ' · ' + UI.esc(c.phone) : ''}</div>
        </div>

        <div class="rx-patient">
          <span><b>${UI.esc(sheet.first_name)} ${UI.esc(sheet.last_name || '')}</b></span>
          <span>${UI.esc(age)} · ${UI.esc(UI.titleise(sheet.gender || '—'))}</span>
          ${sheet.uhid ? `<span>UHID ${UI.esc(sheet.uhid)}</span>` : ''}
          <span>${UI.esc(UI.date(sheet.created_at))}</span>
          <span>${UI.esc(sheet.rx_no)}${sheet.staff_code ? ' / ' + UI.esc(sheet.staff_code) : ''}</span>
        </div>

        ${sheet.allergies ? `<div class="rx-allergy">Allergic to: ${UI.esc(sheet.allergies)}</div>` : ''}
        ${sheet.complaints ? `<div class="rx-note"><span class="k">Complaints</span><br>${UI.esc(sheet.complaints)}</div>` : ''}
        ${sheet.findings ? `<div class="rx-note"><span class="k">On examination</span><br>${UI.esc(sheet.findings)}</div>` : ''}
        ${sheet.diagnosis ? `<div class="rx-note"><span class="k">Diagnosis</span><br><b>${UI.esc(sheet.diagnosis)}</b></div>` : ''}

        <div class="rx-symbol">℞</div>
        <table class="rx-meds"><tbody>
          ${sheet.items.map((it, i) => `<tr>
            <td class="n">${i + 1}.</td>
            <td>
              <div class="med">${UI.esc(it.drug_name)}</div>
              <div class="sig">${[
                it.dose ? `${UI.esc(it.dose)}` : '',
                it.frequency ? UI.esc(it.frequency) : '',
                it.route && it.route !== 'oral' ? UI.esc(it.route.toUpperCase()) : '',
                it.duration_days ? `× ${UI.esc(it.duration_days)} day(s)` : '',
                it.instructions ? `— ${UI.esc(it.instructions)}` : '',
              ].filter(Boolean).join(' · ')}</div>
            </td>
            <td class="sig" style="text-align:right;white-space:nowrap">
              ${it.quantity ? `Qty ${UI.esc(it.quantity)}` : ''}</td>
          </tr>`).join('')}
        </tbody></table>

        ${sheet.advice ? `<div class="rx-note" style="margin-top:16px">
          <span class="k">Advice</span><br>${UI.esc(sheet.advice)}</div>` : ''}
        ${sheet.follow_up_date ? `<div class="rx-note">
          <span class="k">Review on</span><br><b>${UI.esc(UI.date(sheet.follow_up_date))}</b></div>` : ''}

        <div class="rx-sign">
          <div class="rx-stamp">
            <div class="rx-stamp-box"></div>
            <div class="rx-stamp-label">Doctor's stamp &amp; signature</div>
          </div>
        </div>

        <div class="rx-foot">
          Not valid for medico-legal purposes. Take medicines only as directed and complete the course.
        </div>
      </div>`, `Prescription ${sheet.rx_no}`);
  }

  /** Reprint an already-signed prescription. */
  async function reprint(sheetId) {
    printSheet(await API.get(`/api/prescriptions/${sheetId}`));
  }

  window.Prescribe = { open, printSheet, reprint };
})();
