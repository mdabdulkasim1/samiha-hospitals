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

  /**
   * A medicine as it should read on a prescription. The clinic's own formulary
   * names carry the strength already ("Paracetamol 500 mg"), so adding it
   * again would print "Dolo 650 650 mg".
   */
  /**
   * The BMI bands used in India, which are not the WHO ones.
   *
   * South Asians carry more visceral fat and develop diabetes and heart
   * disease at a lower BMI, so the national guidelines cut overweight at 23
   * and obesity at 25 rather than 25 and 30. Printing a WHO band would tell a
   * patient at 24 that they are in the clear when they are not.
   */
  function bmiBand(bmi) {
    const n = Number(bmi) || 0;
    if (!n) return '';
    if (n < 18.5) return 'underweight';
    if (n < 23) return 'normal';
    if (n < 25) return 'overweight';
    return 'obese';
  }

  /**
   * Aadhaar, in the 4-4-4 grouping it is always written in.
   *
   * The clinic prints it whole: patients here are asked for it at the counter,
   * by the insurer and by the scheme desk, and a number they have to read back
   * off their own prescription is no use with two thirds of it crossed out.
   * That is the clinic's call to make, so the sheet carries it in the shape it
   * appears on the card, which is how somebody checks it at a glance.
   */
  function formatAadhaar(value) {
    const raw = String(value || '').replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(raw)) return '';
    return `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8)}`;
  }

  function drugLabel(drug) {
    const name = String(drug.name || '').trim();
    const strength = String(drug.strength || '').trim();
    if (!strength) return name;
    const squash = (x) => x.toLowerCase().replace(/\s+/g, '');
    return squash(name).endsWith(squash(strength)) ? name : `${name} ${strength}`;
  }

  const ROUTES = ['oral', 'topical', 'inhalation', 'eye', 'ear', 'nasal', 'iv', 'im', 'sc', 'rectal'];

  /*
   * A prescription is only as good as the patient's understanding of it, so
   * this is written the way it is read across India: a dose for the morning,
   * for midday and for the night — the familiar 1-0-1 — and whether it goes
   * before or after food. The clinical shorthand (OD, BD, TDS) follows from
   * that rather than being typed.
   */
  const SLOTS = [
    { key: 'doseMorning', label: 'Morning', hint: 'ā§å' },
    { key: 'doseAfternoon', label: 'Noon', hint: '' },
    { key: 'doseNight', label: 'Night', hint: '' },
  ];

  const FOOD = [
    { value: 'after_food', label: 'After food', plain: 'after food' },
    { value: 'before_food', label: 'Before food', plain: 'before food' },
    { value: 'with_food', label: 'With food', plain: 'with food' },
    { value: 'empty_stomach', label: 'Empty stomach', plain: 'on an empty stomach' },
    { value: 'bedtime', label: 'At bedtime', plain: 'at bedtime' },
    { value: 'anytime', label: 'Any time', plain: 'at any time' },
  ];

  /** As-needed medicines have no slots — they keep a plain frequency. */
  const AS_NEEDED = [
    { value: 'SOS', label: 'SOS — only if needed' },
    { value: 'STAT', label: 'STAT — one dose, at once' },
  ];

  /** What one dose is measured in, so "1" is never left to guesswork. */
  const UNIT_BY_FORM = {
    tablet: 'tablet', capsule: 'capsule', syrup: 'ml', suspension: 'ml', solution: 'ml',
    drops: 'drop', injection: 'dose', ointment: 'application', cream: 'application',
    gel: 'application', sachet: 'sachet', inhaler: 'puff', spray: 'spray',
    lotion: 'application', suppository: 'suppository',
  };
  const unitFor = (form) => UNIT_BY_FORM[String(form || '').toLowerCase()] || 'dose';

  /** Plural only where a patient would say it: 2 tablets, but 5 ml. */
  const unitLabel = (n, unit) =>
    (['ml', 'puff', 'spray'].includes(unit) || Number(n) === 1) ? unit : `${unit}s`;

  /** "1-0-1" — the pattern every patient recognises. */
  const pattern = (l) => [l.doseMorning, l.doseAfternoon, l.doseNight]
    .map((n) => (Number(n) === 0 ? '0' : String(Number(n)))).join(' - ');

  const perDayOf = (l) => Number(l.doseMorning || 0) + Number(l.doseAfternoon || 0) + Number(l.doseNight || 0);

  /**
   * The line the patient actually follows: how much, when in the day, and
   * where food comes into it.
   */
  function plainDirection(l) {
    const food = (FOOD.find((f) => f.value === l.foodRelation) || {}).plain;
    if (perDayOf(l) <= 0) {
      const when = l.frequency === 'STAT' ? 'Take one dose now' : 'Take only when needed';
      return `${when}${food && food !== 'at any time' ? ', ' + food : ''}`;
    }
    const parts = SLOTS
      .filter((sl) => Number(l[sl.key]) > 0)
      .map((sl) => `${Number(l[sl.key])} ${unitLabel(l[sl.key], l.unit)} in the ${sl.label.toLowerCase()}`);
    const joined = parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
      : parts[0];
    return `${joined}${food ? ', ' + food : ''}`;
  }

  /**
   * Open the pad for a patient. `context` may carry a visitId (which puts the
   * medicines into the pharmacy queue) and an appointmentId.
   */
  async function open(patient, context = {}) {
    const drugs = await API.get('/api/pharmacy/drugs?limit=500');

    /*
     * Correcting a prescription already written.
     *
     * A consultation is not filled in one pass: the dose is revised when the
     * weight comes back, a medicine is dropped when the patient says what they
     * already take, a duration typed as 5 was meant as 15. The pad reopens on
     * the sheet rather than starting a second one for the same consultation.
     *
     * A line the pharmacy has already dispensed comes back locked. The
     * medicine is in the patient's hand and the record has to say what they
     * were actually given.
     */
    const editing = context.sheet || null;
    const lockedOf = (item) => item.dispensed_qty > 0 || item.status === 'external';

    const allergyHit = (drug) => {
      const terms = (patient.allergies || '').split(/[,;]/).map((a) => a.trim().toLowerCase()).filter(Boolean);
      const hay = `${drug.name} ${drug.generic_name || ''}`.toLowerCase();
      return terms.some((t) => t.length > 2 && hay.includes(t));
    };

    const lines = editing ? (editing.items || []).map((it) => {
      const drug = drugs.find((d) => d.id === it.drug_id) || null;
      return {
        id: it.id,
        locked: lockedOf(it),
        dispensedQty: it.dispensed_qty,
        drugId: it.drug_id,
        drugName: it.drug_name,
        form: drug ? drug.form : null,
        scheduleType: drug ? drug.schedule_type : null,
        allergy: drug ? allergyHit(drug) : false,
        unit: it.dose_unit || (drug ? unitFor(drug.form) : 'dose'),
        doseMorning: it.dose_morning || 0,
        doseAfternoon: it.dose_afternoon || 0,
        doseNight: it.dose_night || 0,
        foodRelation: it.food_relation || 'after_food',
        frequency: it.frequency || 'SOS',
        route: it.route || 'oral',
        durationDays: it.duration_days || 1,
        quantity: it.quantity || 0,
        // Deliberately not marked as hand-set: the stored total stands until
        // something changes, and then it follows the new dose or duration —
        // a line changed to fifteen days should not still dispense ten days'
        // worth.
        instructions: it.instructions || '',
      };
    }) : [];

    // Coded diagnoses, in order; the first is the primary.
    const diagnoses = editing
      ? (editing.diagnoses || []).map((d) => ({ code: d.code, title: d.title }))
      : [];

    // The sheet, once saved. Signing and printing act on this rather than
    // creating a second prescription for the same consultation.
    let saved = null;
    let needsRefresh = false;

    UI.modal({
      title: editing
        ? `Correcting ${editing.rx_no} — ${patient.first_name} ${patient.last_name || ''}`.trim()
        : `Prescription — ${patient.first_name} ${patient.last_name || ''}`.trim(),
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
        ${editing ? `<div class="alert ${lines.some((l) => l.locked) ? 'warn' : 'info'} mb">
          Correcting <b>${UI.esc(editing.rx_no)}</b>, written
          ${UI.esc(UI.dateTime(editing.created_at))}. It keeps its number.
          ${lines.some((l) => l.locked)
            ? `<b>${UI.esc(lines.filter((l) => l.locked).map((l) => l.drugName).join(', '))}</b>
               ${lines.filter((l) => l.locked).length > 1 ? 'have' : 'has'} already left the pharmacy
               and cannot be changed.`
            : 'Nothing has been dispensed yet, so every line is still yours to change.'}
          ${editing.signed_at ? ' Saving clears the signature — sign and print it again.' : ''}
        </div>` : ''}

        <form id="rx-head">
          <div class="grid c2">
            ${UI.field({ name: 'complaints', label: 'Complaints', placeholder: 'Fever 3 days, dry cough',
              value: editing ? editing.complaints || '' : '' })}
            ${UI.field({ name: 'findings', label: 'Examination findings',
              placeholder: 'Throat congested, chest clear',
              value: editing ? editing.findings || '' : '' })}
          </div>
        </form>

        <div class="card"><div class="card-head"><h3>Diagnosis</h3>
          <span class="muted small">Coded, so it can be claimed and counted later</span></div>
          <div class="card-body">
            <div class="search-row">
              <input type="search" id="dx-q" placeholder="Search a diagnosis or an ICD-10 code…"
                autocomplete="off">
            </div>
            <div id="dx-results"></div>
            <div id="dx-list" class="mt"></div>
            ${UI.field({ name: 'diagnosis', label: 'Anything the codes do not cover',
              placeholder: 'In your own words — printed under the coded list' })}
          </div>
        </div>

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
              placeholder: 'Plenty of fluids, steam inhalation, rest',
              value: editing ? editing.advice || '' : '' })}
            ${UI.field({ name: 'followUpDate', label: 'Review on', type: 'date',
              value: editing ? editing.follow_up_date || '' : '' })}
          </div>
        </form>`,
      onClose() { if (needsRefresh && context.onDone) context.onDone(); },
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ghost" data-act="save" disabled>Save</button>
               <button class="btn teal" data-act="sign" disabled>Sign</button>
               <button class="btn" data-act="print" disabled>Print</button>`,
      onMount(modal) {
        const saveBtn = document.querySelector('[data-act=save]');
        const signBtn = document.querySelector('[data-act=sign]');
        const printBtn = document.querySelector('[data-act=print]');
        const linesHost = modal.querySelector('#rx-lines');
        const resultsHost = modal.querySelector('#rx-results');
        const search = modal.querySelector('#rx-q');

        /* ---------------------------------------------------------- diagnosis
         * Coded, because a diagnosis written out in a doctor's own words
         * cannot be claimed against, counted, or looked up a year later. The
         * first one added is the primary — the complaint the visit was for —
         * and the doctor can move another into that place.
         */
        const dxSearch = modal.querySelector('#dx-q');
        const dxResults = modal.querySelector('#dx-results');
        const dxHost = modal.querySelector('#dx-list');

        const drawDx = () => {
          dxHost.innerHTML = diagnoses.length ? `
            <table class="dx-table"><tbody>${diagnoses.map((d, i) => `<tr>
              <td>${i === 0
                ? UI.badge('Primary', 'crimson')
                : `<button type="button" class="btn ghost sm" data-dx-primary="${i}"
                     title="Make this the primary diagnosis">Secondary</button>`}</td>
              <td><code>${UI.esc(d.code || '—')}</code></td>
              <td><b>${UI.esc(d.title)}</b></td>
              <td class="num"><button type="button" class="btn ghost sm" data-dx-rm="${i}">×</button></td>
            </tr>`).join('')}</tbody></table>`
            : '<div class="muted small">No diagnosis coded yet — search above.</div>';

          dxHost.querySelectorAll('[data-dx-rm]').forEach((b) => b.addEventListener('click', () => {
            diagnoses.splice(Number(b.dataset.dxRm), 1); drawDx();
          }));
          dxHost.querySelectorAll('[data-dx-primary]').forEach((b) => b.addEventListener('click', () => {
            const i = Number(b.dataset.dxPrimary);
            diagnoses.unshift(diagnoses.splice(i, 1)[0]);
            drawDx();
          }));
        };

        let dxTimer;
        dxSearch.addEventListener('input', () => {
          clearTimeout(dxTimer);
          dxTimer = setTimeout(async () => {
            const q = dxSearch.value.trim();
            if (q.length < 2) return void (dxResults.innerHTML = '');
            let hits = [];
            try { hits = await API.get('/api/masters/icd' + API.qs({ q })); }
            catch { hits = []; }
            const already = new Set(diagnoses.map((d) => d.code));
            dxResults.innerHTML = hits.length ? hits.slice(0, 8).map((h) => `
              <button type="button" class="btn ghost sm block mb" data-dx-add="${UI.esc(h.code)}"
                style="justify-content:space-between"${already.has(h.code) ? ' disabled' : ''}>
                <span><code>${UI.esc(h.code)}</code> ${UI.esc(h.title)}</span>
                <span class="muted small">${UI.esc(h.chapter || '')}</span>
              </button>`).join('')
              : `<div class="muted small">Nothing matched. Type it into
                 “anything the codes do not cover” below instead.</div>`;

            dxResults.querySelectorAll('[data-dx-add]').forEach((b) => b.addEventListener('click', () => {
              const hit = hits.find((h) => h.code === b.dataset.dxAdd);
              if (hit) diagnoses.push({ code: hit.code, title: hit.title });
              dxSearch.value = '';
              dxResults.innerHTML = '';
              drawDx();
            }));
          }, 220);
        });
        drawDx();

        const draw = () => {
          if (!lines.length) {
            linesHost.innerHTML = UI.empty('Search above and add the medicines you are prescribing.', '℞');
            [saveBtn, signBtn, printBtn].forEach((b) => { if (b) b.disabled = true; });
            return;
          }

          // A card per medicine rather than a row: there is too much that
          // matters here to squeeze into a table, and this is the part the
          // patient has to be able to follow.
          linesHost.innerHTML = lines.map((l, i) => `
            <div class="rx-line">
              <div class="rx-line-head">
                <span class="rx-n">${i + 1}</span>
                <span class="rx-med">
                  <b>${UI.esc(l.drugName)}</b>
                  <span class="muted small">${UI.esc(l.form || '')}
                    ${l.scheduleType && ['H', 'H1', 'X'].includes(String(l.scheduleType).toUpperCase())
                      ? UI.badge('Schedule ' + l.scheduleType, 'warn') : ''}
                    ${l.allergy ? UI.badge('⚠ allergy', 'danger') : ''}</span>
                </span>
                ${l.locked
                  ? `<span class="badge ok" title="Already handed over — the record has to say what the patient was given">dispensed</span>`
                  : `<button type="button" class="btn ghost sm" data-rm="${i}" title="Remove">×</button>`}
              </div>

              <div class="rx-line-grid">
                <div class="rx-slots">
                  <label class="field"><span>How much, and when</span></label>
                  <div class="rx-slot-row">
                    ${SLOTS.map((sl) => `
                      <label class="rx-slot">
                        <span>${sl.label}</span>
                        <input type="number" min="0" step="0.5" data-f="${sl.key}" data-i="${i}"
                               value="${UI.esc(l[sl.key])}">
                      </label>`).join('')}
                    <span class="rx-unit">${UI.esc(unitLabel(2, l.unit))}</span>
                  </div>
                </div>

                <label class="field"><span>Food</span>
                  <select data-f="foodRelation" data-i="${i}">
                    ${FOOD.map((f) => `<option value="${f.value}"${
                      f.value === l.foodRelation ? ' selected' : ''}>${f.label}</option>`).join('')}
                  </select>
                </label>

                <label class="field"><span>For how many days</span>
                  <input type="number" min="1" data-f="durationDays" data-i="${i}" value="${UI.esc(l.durationDays)}">
                </label>

                <label class="field"><span>Total to dispense</span>
                  <input type="number" min="0" step="0.5" data-f="quantity" data-i="${i}" value="${UI.esc(l.quantity)}">
                </label>
              </div>

              <div class="rx-line-grid">
                <label class="field" style="grid-column:span 2"><span>Note for the patient</span>
                  <input type="text" data-f="instructions" data-i="${i}" value="${UI.esc(l.instructions)}"
                         placeholder="Finish the full course · plenty of water · do not chew">
                </label>
                <label class="field"><span>Only when needed?</span>
                  <select data-f="frequency" data-i="${i}"${perDayOf(l) > 0 ? ' disabled' : ''}>
                    ${AS_NEEDED.map((f) => `<option value="${f.value}"${
                      f.value === l.frequency ? ' selected' : ''}>${f.label}</option>`).join('')}
                  </select>
                </label>
                <label class="field"><span>Route</span>
                  <select data-f="route" data-i="${i}">
                    ${ROUTES.map((r) => `<option value="${r}"${r === l.route ? ' selected' : ''}>${
                      r.toUpperCase()}</option>`).join('')}
                  </select>
                </label>
              </div>

              <div class="rx-preview">
                <b>${UI.esc(pattern(l))}</b>
                <span>${UI.esc(plainDirection(l))}</span>
                <span class="muted">${l.durationDays ? `for ${UI.esc(l.durationDays)} day(s)` : ''}
                  ${l.quantity ? `· ${UI.esc(l.quantity)} ${UI.esc(unitLabel(l.quantity, l.unit))} in all` : ''}</span>
              </div>
            </div>`).join('');

          linesHost.querySelectorAll('[data-f]').forEach((input) => {
            if (lines[Number(input.dataset.i)].locked) input.disabled = true;
            input.addEventListener('change', () => {
              const line = lines[Number(input.dataset.i)];
              line[input.dataset.f] = input.value;
              if (input.dataset.f === 'quantity') line.qtyTouched = true;
              // Change how much or how long, and the total to dispense follows —
              // unless the doctor has set one of their own.
              if (!line.qtyTouched && input.dataset.f !== 'quantity') {
                line.quantity = Math.ceil(Math.max(perDayOf(line), 1) * (Number(line.durationDays) || 1));
              }
              setTimeout(draw, 0);
            });
          });
          linesHost.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
            lines.splice(Number(b.dataset.rm), 1);
            draw();
          }));
          [saveBtn, signBtn, printBtn].forEach((b) => { if (b) b.disabled = false; });
        };

        const add = (drug) => {
          if (lines.some((l) => l.drugId === drug.id)) return UI.warn(`${drug.name} is already on this prescription.`);
          // Twice a day after food for five days is the commonest thing an OPD
          // writes, so the line starts there and is changed from there.
          lines.push({
            drugId: drug.id,
            drugName: drugLabel(drug),
            form: drug.form, scheduleType: drug.schedule_type,
            allergy: allergyHit(drug),
            unit: unitFor(drug.form),
            doseMorning: 1, doseAfternoon: 0, doseNight: 1,
            foodRelation: 'after_food', frequency: 'SOS',
            route: 'oral', durationDays: 5, quantity: 10, instructions: '',
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
                <span>${UI.esc(drugLabel(dg))}
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
      /*
       * Three things a doctor does with a prescription, and they are not the
       * same thing:
       *   Save   — the pharmacy can see it and start dispensing
       *   Sign   — the doctor's own signature goes onto it
       *   Print  — the patient walks out with the paper
       *
       * Saving happens once; signing and printing act on what was saved, so a
       * doctor can save now, sign, and print later without a second sheet
       * being created.
       */
      async onAction(act, modal) {
        if (!['save', 'sign', 'print'].includes(act)) return;
        if (!lines.length) { UI.err('Add at least one medicine.'); return 'keep'; }

        // Claimed here, while the browser is still handling the press. An
        // unsaved sheet has to be saved before it can be printed, and by the
        // time that returns the permission to open a window is gone.
        const printWindow = act === 'print' && !saved
          ? UI.openPrintWindow({ width: 620, height: 900 }) : null;

        const save = async () => {
          if (saved && !editing) return saved;
          const payload = {
            patientId: patient.id,
            visitId: context.visitId || undefined,
            appointmentId: context.appointmentId || undefined,
            ...UI.formValues(modal.querySelector('#rx-head')),
            ...UI.formValues(modal.querySelector('#rx-foot')),
            // The free-text line sits in the diagnosis card, outside both
            // forms, so it is read on its own rather than swept up by one.
            diagnosis: (modal.querySelector('[name=diagnosis]') || {}).value || '',
            // First in the list is the primary; the rest follow it.
            diagnoses: diagnoses.map((d, i) => ({
              code: d.code, title: d.title, rank: i === 0 ? 'primary' : 'secondary',
            })),
            items: lines.map((l) => ({
              id: l.id, drugId: l.drugId, route: l.route, durationDays: l.durationDays,
              quantity: l.quantity, instructions: l.instructions,
              doseMorning: l.doseMorning, doseAfternoon: l.doseAfternoon, doseNight: l.doseNight,
              doseUnit: l.unit, foodRelation: l.foodRelation,
              // Only meaningful when no slot is ticked.
              frequency: l.frequency,
            })),
          };
          const send = (body) => (editing
            ? API.patch(`/api/prescriptions/${editing.id}`, body)
            : API.post('/api/prescriptions', body));
          try {
            saved = await send(payload);
          } catch (err) {
            if (err.status === 409 && /Safety check/.test(err.message)) {
              if (!(await UI.confirm(err.message, { title: 'Allergy warning', danger: true }))) return null;
              saved = await send({ ...payload, acknowledgeWarnings: true });
            } else throw err;
          }
          if (editing && saved.signatureCleared) {
            UI.warn('The signature was cleared — sign and print it again.');
          }
          // The caller usually refreshes the screen behind us, which would tear
          // this modal down mid-flow — so it is told once, on the way out.
          needsRefresh = true;
          return saved;
        };

        const sheet = await save();
        if (!sheet) {
          if (printWindow) printWindow.close();
          return 'keep';
        }

        if (act === 'save') {
          UI.ok(editing
            ? `Prescription ${sheet.rx_no} corrected — the pharmacy sees the new version.`
            : `Prescription ${sheet.rx_no} saved — the pharmacy can see it now.`);
          markSaved(modal, sheet, Boolean(editing));
          return 'keep';
        }

        if (act === 'sign') {
          let signed;
          try {
            signed = await API.post(`/api/prescriptions/${sheet.id}/sign`, {});
          } catch (err) {
            if (!/No signature on file/i.test(err.message)) throw err;
            // Nothing to sign with yet — take one now rather than sending them
            // away to a settings screen mid-consultation.
            const image = await captureSignature();
            if (!image) return 'keep';
            await API.put('/api/me/signature', { signature: image });
            signed = await API.post(`/api/prescriptions/${sheet.id}/sign`, {});
          }
          saved = signed;
          UI.ok(`Prescription ${signed.rx_no} signed.`);
          markSaved(modal, signed, Boolean(editing));
          return 'keep';
        }

        printSheet(saved, printWindow);
        markSaved(modal, saved, Boolean(editing));
        return 'keep';
      },
    });
  }

  /** Once saved, the sheet has a number and a state the doctor can see. */
  function markSaved(modal, sheet, editing = false) {
    const saveBtn = document.querySelector('[data-act=save]');
    // A new sheet is written once. A correction can be made twice — a doctor
    // who fixes the dose and then spots the duration should not have to close
    // the pad and open it again.
    if (saveBtn && !editing) { saveBtn.disabled = true; saveBtn.textContent = 'Saved'; }
    if (saveBtn && editing) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    const cancelBtn = document.querySelector('[data-act=__close]');
    if (cancelBtn && cancelBtn.textContent === 'Cancel') cancelBtn.textContent = 'Close';
    const signBtn = document.querySelector('[data-act=sign]');
    if (signBtn && sheet.signed_at) { signBtn.disabled = true; signBtn.textContent = 'Signed'; }

    let bar = modal.querySelector('#rx-state');
    if (!bar) {
      const head = modal.querySelector('#rx-head');
      bar = document.createElement('div');
      bar.id = 'rx-state';
      bar.className = 'alert ok mb';
      head.parentNode.insertBefore(bar, head);
    }
    bar.innerHTML = `<b>${UI.esc(sheet.rx_no)}</b> ${editing ? 'corrected' : 'saved'}
      — the pharmacy can see it.
      ${sheet.signed_at
        ? `Signed ${UI.esc(UI.dateTime(sheet.signed_at))}.`
        : 'Not signed yet — press <b>Sign</b> to add your signature, or stamp the printed sheet by hand.'}`;
  }

  /**
   * Take a signature. A doctor signs with a finger on a tablet or a mouse at a
   * desk, so the pad accepts either — and an uploaded scan of a signature they
   * already have, which is what most will do once.
   */
  function captureSignature() {
    return new Promise((resolve) => {
      let done = false;
      UI.modal({
        title: 'Your signature',
        size: 'narrow',
        body: `<p class="muted">Sign once and it goes onto everything you sign from now on.
          Draw it below, or upload a scan of your usual signature.</p>
          <canvas id="sig-pad" width="560" height="200" class="sig-pad"></canvas>
          <div class="btn-row mt">
            <button type="button" class="btn ghost sm" id="sig-clear">Clear</button>
            <label class="btn ghost sm" style="cursor:pointer">Upload an image
              <input type="file" id="sig-file" accept="image/png,image/jpeg" hidden>
            </label>
          </div>
          <div id="sig-out"></div>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button>
                 <button class="btn" data-act="use">Use this signature</button>`,
        onMount(modal) {
          const canvas = modal.querySelector('#sig-pad');
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 2.4;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = '#16232B';

          let drawing = false;
          let drawn = false;
          const at = (e) => {
            const r = canvas.getBoundingClientRect();
            const p = e.touches ? e.touches[0] : e;
            return { x: (p.clientX - r.left) * (canvas.width / r.width),
                     y: (p.clientY - r.top) * (canvas.height / r.height) };
          };
          const start = (e) => { e.preventDefault(); drawing = true; drawn = true;
            const p = at(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
          const move = (e) => { if (!drawing) return; e.preventDefault();
            const p = at(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
          const end = () => { drawing = false; };
          canvas.addEventListener('mousedown', start);
          canvas.addEventListener('mousemove', move);
          window.addEventListener('mouseup', end);
          canvas.addEventListener('touchstart', start, { passive: false });
          canvas.addEventListener('touchmove', move, { passive: false });
          canvas.addEventListener('touchend', end);

          modal.querySelector('#sig-clear').addEventListener('click', () => {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            drawn = false;
            modal.__uploaded = null;
            modal.querySelector('#sig-out').innerHTML = '';
          });

          modal.querySelector('#sig-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.size > 300 * 1024) return UI.err('Keep the image under 300 KB.');
            const reader = new FileReader();
            reader.onload = () => {
              modal.__uploaded = reader.result;
              modal.querySelector('#sig-out').innerHTML =
                `<div class="alert ok mt">Using the uploaded image.
                   <img src="${reader.result}" alt="" style="max-height:60px;display:block;margin-top:6px"></div>`;
            };
            reader.readAsDataURL(file);
          });

          modal.__signature = () => modal.__uploaded || (drawn ? canvas.toDataURL('image/png') : null);
        },
        onAction(act, modal) {
          if (act !== 'use') return;
          const image = modal.__signature();
          if (!image) { UI.err('Draw or upload a signature first.'); return 'keep'; }
          done = true;
          resolve(image);
        },
        onClose() { if (!done) resolve(null); },
      });
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
  function printSheet(sheet, windowRef = null) {
    const c = APP.clinic || {};
    const age = sheet.age_years ? `${sheet.age_years} yrs` : '—';
    const vt = sheet.vitals || {};

    UI.printSheet(`${UI.sheetStyles()}
      <style>
        .rx-symbol {
          font-family: Georgia, "Times New Roman", serif; font-size: 26px; line-height: 1;
          margin: 12px 0 2px; color: #9E1B34;
        }
        .rx-med { font-weight: 700; font-size: 11.5px; }
        .rx-how { margin-top: 2px; }
        .rx-pat {
          display: inline-block; font-weight: 700; letter-spacing: 1px; color: #9E1B34;
          border: 1px solid #9E1B34; border-radius: 3px; padding: 0 5px; margin-right: 7px;
          font-size: 10.5px;
        }
        .rx-sig { color: #5A6B74; font-size: 9.5px; margin-top: 2px; }
        .rx-key { margin-top: 5px; font-size: 8px; color: #8B9AA2; }
        /* Diagnosis, coded. Ranked first because a claim reads that column
           before it reads anything else, then the code, then the term. */
        .sheet table.dx { width: 100%; border-collapse: collapse; margin-top: 3px; }
        .sheet table.dx td { border: 0; padding: 2px 0; vertical-align: top; }
        .dx-rank { width: 62px; font-size: 8px; letter-spacing: .06em; text-transform: uppercase;
                   color: #8B9AA2; font-weight: 600; padding-top: 3px !important; }
        .dx-code { width: 58px; font-weight: 700; font-variant-numeric: lining-nums tabular-nums; }
        .dx-term { font-weight: 600; }
        .dx-note { margin-top: 4px; color: #5A6B74; font-size: 9.5px; }
        .rx-qty { font-weight: 600; }
      </style>
      <div class="sheet">
        ${UI.sheetHead('Prescription')}

        <div class="who">
          <div style="grid-column:span 2">
            <div class="k">Patient</div>
            <div class="v lead">${UI.esc(sheet.first_name)} ${UI.esc(sheet.last_name || '')}</div>
          </div>
          <div><div class="k">Age / Sex</div>
            <div class="v">${UI.esc(age)} · ${UI.esc(UI.titleise(sheet.gender || '—'))}</div></div>
          <div><div class="k">Weight</div><div class="v">${vt.weight_kg
            ? `${UI.esc(UI.num(vt.weight_kg, 1))} kg` : '—'}</div></div>
          <div><div class="k">Height</div><div class="v">${vt.height_cm
            ? `${UI.esc(UI.num(vt.height_cm, 0))} cm` : '—'}</div></div>
          <div><div class="k">BMI</div><div class="v">${vt.bmi
            ? `${UI.esc(UI.num(vt.bmi, 1))}<span class="bmi-band"> ${UI.esc(bmiBand(vt.bmi))}</span>`
            : '—'}</div></div>
          <div><div class="k">UHID</div><div class="v">${UI.esc(sheet.uhid || '—')}</div></div>
          <div><div class="k">Aadhaar</div><div class="v">${
            formatAadhaar(sheet.aadhaar_number) || '—'}</div></div>
          <div><div class="k">Date</div><div class="v">${UI.esc(UI.date(sheet.created_at))}</div></div>
          <div><div class="k">Prescription</div><div class="v">${UI.esc(sheet.rx_no)}</div></div>
          <div><div class="k">Doctor code</div><div class="v">${UI.esc(sheet.doctor_code || '—')}</div></div>
        </div>

        ${sheet.allergies ? `<div class="warn">Allergic to: ${UI.esc(sheet.allergies)}</div>` : ''}
        ${sheet.complaints ? `<div class="block"><div class="k">Complaints</div>
          <p>${UI.esc(sheet.complaints)}</p></div>` : ''}
        ${sheet.findings ? `<div class="block"><div class="k">On examination</div>
          <p>${UI.esc(sheet.findings)}</p></div>` : ''}
        ${(sheet.diagnoses && sheet.diagnoses.length) ? `<div class="block">
          <div class="k">Diagnosis</div>
          <table class="dx"><tbody>${sheet.diagnoses.map((d) => `<tr>
            <td class="dx-rank">${d.rank === 'primary' ? 'Primary' : 'Secondary'}</td>
            <td class="dx-code">${UI.esc(d.code || '—')}</td>
            <td class="dx-term">${UI.esc(d.title)}</td></tr>`).join('')}
          </tbody></table>
          ${sheet.diagnosis ? `<p class="dx-note">${UI.esc(sheet.diagnosis)}</p>` : ''}
        </div>` : (sheet.diagnosis ? `<div class="block"><div class="k">Diagnosis</div>
          <p class="strong">${UI.esc(sheet.diagnosis)}</p></div>` : '')}

        <div class="rx-symbol">℞</div>
        <table>
          <thead><tr><th style="width:16px"></th><th>Medicine and how to take it</th>
            <th class="num">Total</th></tr></thead>
          <tbody>${sheet.items.map((it, i) => {
            const line = {
              doseMorning: it.dose_morning, doseAfternoon: it.dose_afternoon, doseNight: it.dose_night,
              unit: it.dose_unit || 'dose', foodRelation: it.food_relation, frequency: it.frequency,
            };
            return `<tr>
              <td style="color:#8B9AA2">${i + 1}.</td>
              <td>
                <div class="rx-med">${UI.esc(it.drug_name)}</div>
                <div class="rx-how">
                  ${perDayOf(line) > 0 ? `<span class="rx-pat">${UI.esc(pattern(line))}</span>` : ''}
                  ${UI.esc(plainDirection(line))}
                </div>
                <div class="rx-sig">${[
                  it.duration_days ? `For ${UI.esc(it.duration_days)} day(s)` : '',
                  it.route && it.route !== 'oral' ? UI.esc(it.route.toUpperCase()) : '',
                  it.instructions ? UI.esc(it.instructions) : '',
                ].filter(Boolean).join(' · ')}</div>
              </td>
              <td class="num rx-qty">${it.quantity
                ? `${UI.esc(it.quantity)} ${UI.esc(unitLabel(it.quantity, line.unit))}` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <div class="rx-key">1 - 0 - 1 means morning – noon – night.</div>

        ${sheet.advice ? `<div class="block"><div class="k">Advice</div>
          <p>${UI.esc(sheet.advice)}</p></div>` : ''}
        ${sheet.follow_up_date ? `<div class="block"><div class="k">Review on</div>
          <p class="strong">${UI.esc(UI.date(sheet.follow_up_date))}</p></div>` : ''}

        <div class="stamp-row">
          <div class="stamp">
            <div class="box${sheet.signature_image ? ' signed' : ''}">
              ${sheet.signature_image
                ? `<img src="${UI.esc(sheet.signature_image)}" alt="">` : ''}
            </div>
            <div class="cap">${sheet.signature_image
              ? "Doctor's signature" : "Doctor's stamp &amp; signature"}</div>
          </div>
        </div>

        <div class="note">
          Not valid for medico-legal purposes. Take the medicines only as directed above
          and complete the full course.
        </div>
      </div>`, `Prescription ${sheet.rx_no}`, windowRef);
  }

  /** Reprint an already-signed prescription. */
  async function reprint(sheetId) {
    printSheet(await API.get(`/api/prescriptions/${sheetId}`));
  }

  /**
   * Reopen a prescription to correct it. The patient comes off the sheet, so
   * the caller needs nothing but its id.
   */
  async function edit(sheetId, context = {}) {
    const sheet = await API.get(`/api/prescriptions/${sheetId}`);
    if (sheet.status === 'cancelled') return UI.err('This prescription was cancelled.');
    return open({
      id: sheet.patient_id,
      first_name: sheet.first_name, last_name: sheet.last_name,
      uhid: sheet.uhid, age_years: sheet.age_years, gender: sheet.gender,
      allergies: sheet.allergies,
    }, { ...context, sheet, visitId: sheet.visit_id });
  }

  window.Prescribe = { open, printSheet, reprint, edit };
})();
