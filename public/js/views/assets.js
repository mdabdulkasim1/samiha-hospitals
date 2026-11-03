/* Asset register — what the clinic owns, and whether it can be trusted today. */
(function () {
  'use strict';

  /*
   * The register exists for one column: when the calibration runs out.
   *
   * Everything else here — the model, the supplier, what it cost — is the
   * paperwork any asset list carries. The date is the part that changes what
   * somebody does today, because an analyser out of calibration goes on
   * printing numbers onto reports and an X-ray unit past its quality
   * assurance is a licence problem found during an inspection. So the list
   * sorts by that date, the overdue ones sit at the top in red, and the
   * summary counts them whether anybody opens this screen or not.
   */
  const KEEP = ['lab', 'pharmacy', 'ward', 'nurse'];
  const canKeep = () => APP.can(KEEP);

  const STATE = {
    expired: { label: 'Expired', kind: 'danger' },
    due_soon: { label: 'Due soon', kind: 'warn' },
    unset: { label: 'No date yet', kind: 'orange' },
    ok: { label: 'In date', kind: 'ok' },
  };

  let meta = null;

  APP.register('assets', {
    title: 'Assets & Calibration',
    subtitle: 'Machines, instruments and equipment — and when each is next due',

    async render(el, params) {
      if (params.id) return renderAsset(el, Number(params.id));
      meta = meta || await API.get('/api/assets/meta');

      APP.actions(canKeep()
        ? [{ id: 'add', label: '+ Add an asset', kind: '', onClick: () => openAsset({}, () => APP.reload()) }]
        : []);

      el.innerHTML = `
        <div id="a-tiles"></div>
        <div class="card"><div class="card-head"><h3>Asset register</h3>
          <input type="search" id="a-q" placeholder="Name, model, serial, supplier…" style="max-width:220px">
          <select id="a-cat" style="max-width:190px"><option value="">Every category</option>
            ${meta.categories.map((c) => `<option>${UI.esc(c)}</option>`).join('')}</select>
          <select id="a-due" style="max-width:190px"><option value="">Any calibration state</option>
            <option value="expired">Expired</option>
            <option value="due_soon">Due within ${UI.esc(meta.soonDays)} days</option>
            <option value="unset">No date entered yet</option>
            <option value="ok">In date</option></select>
          <select id="a-status" style="max-width:160px"><option value="">Any status</option>
            ${meta.statuses.map((s) => `<option value="${UI.esc(s)}">${UI.esc(UI.titleise(s))}</option>`).join('')}</select>
        </div>
          <div class="card-body tight" id="a-list">${UI.loading()}</div></div>`;

      const load = async () => {
        const data = await API.get('/api/assets' + API.qs({
          q: el.querySelector('#a-q').value.trim(),
          category: el.querySelector('#a-cat').value,
          due: el.querySelector('#a-due').value,
          status: el.querySelector('#a-status').value,
          limit: 500,
        }));
        el.querySelector('#a-tiles').innerHTML = tiles(data.summary);
        const host = el.querySelector('#a-list');
        host.innerHTML = UI.table(columns(), data.rows,
          { emptyText: 'Nothing on the register for this filter.' });
        UI.bindRows(host, data.rows, (a) => APP.navigate('assets', { id: a.id }));
        host.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          openEvent(data.rows.find((r) => String(r.id) === b.dataset.cal), 'calibration', load);
        }));
        // Clicking an alert tile filters the list to what it counted.
        el.querySelectorAll('[data-filter]').forEach((t) => t.addEventListener('click', () => {
          el.querySelector('#a-due').value = t.dataset.filter;
          load();
        }));
      };

      ['#a-cat', '#a-due', '#a-status'].forEach((s) =>
        el.querySelector(s).addEventListener('change', load));
      el.querySelector('#a-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
      await load();
    },
  });

  const tile = (cls, label, value, foot, filter) => {
    const body = `<div class="label">${UI.esc(label)}</div><div class="value">${value}</div>` +
      `<div class="foot">${foot || ''}</div>`;
    return filter
      ? `<button type="button" class="stat ${cls} drillable" data-filter="${filter}">${body}</button>`
      : `<div class="stat ${cls}">${body}</div>`;
  };

  const tiles = (s) => `
    <div class="grid c4 mb">
      ${tile('teal', 'Assets on the register', UI.num(s.assets),
        `${UI.num(s.units)} units${s.value !== null ? ` · ${UI.money(s.value)}` : ''}`)}
      ${tile(s.expired ? 'crimson' : 'ok', 'Calibration expired', UI.num(s.expired),
        s.expired ? 'Not to be relied on until recalibrated' : 'Nothing overdue', 'expired')}
      ${tile(s.dueSoon ? 'warn' : 'ok', 'Due soon', UI.num(s.dueSoon),
        'Within the next two months', 'due_soon')}
      ${tile(s.unset ? 'orange' : 'ok', 'No date entered', UI.num(s.unset),
        `of ${UI.num(s.needCalibration)} that need calibrating`, 'unset')}
    </div>`;

  const dueCell = (a) => {
    if (!a.needs_calibration) return '<span class="muted">not required</span>';
    const st = STATE[a.calibration_state] || STATE.unset;
    return UI.badge(st.label, st.kind) +
      (a.calibration_due ? `<div class="muted small">${UI.esc(UI.date(a.calibration_due))}</div>` : '') +
      (!a.calibration_due && a.calibration_months
        ? `<div class="muted small">every ${UI.esc(a.calibration_months)} months</div>` : '');
  };

  const columns = () => [
    { label: 'Asset', render: (a) => `<b>${UI.esc(a.name)}</b>` +
      `<div class="muted small"><code>${UI.esc(a.asset_no)}</code>` +
      `${a.make || a.model ? ` · ${UI.esc([a.make, a.model].filter(Boolean).join(' '))}` : ''}</div>` },
    { label: 'Category', render: (a) => UI.esc(a.category || '—') },
    { label: 'Where', render: (a) => UI.esc(a.location || a.department_name || '—') +
      (a.serial_no ? `<div class="muted small">SN ${UI.esc(a.serial_no)}</div>` : '') },
    { label: 'Qty', num: true, render: (a) => UI.num(a.quantity) },
    { label: 'Status', render: (a) => UI.badge(UI.titleise(a.status),
      a.status === 'in_use' ? 'ok' : a.status === 'under_repair' ? 'warn' : '') },
    { label: 'Calibration', render: dueCell },
    ...(canKeep() ? [{ label: '', render: (a) => a.needs_calibration
      ? `<button class="btn ghost sm" data-cal="${a.id}">Record calibration</button>` : '' }] : []),
  ];

  // ----------------------------------------------------------------- one asset
  async function renderAsset(el, id) {
    meta = meta || await API.get('/api/assets/meta');
    const a = await API.get(`/api/assets/${id}`);
    const st = a.needs_calibration ? (STATE[a.calibration_state] || STATE.unset) : null;
    APP.setSubtitle(`${a.asset_no} · ${a.name}`);
    APP.actions([
      { id: 'back', label: '← All assets', onClick: () => APP.navigate('assets') },
      ...(canKeep() ? [
        { id: 'edit', label: 'Edit details', onClick: () => openAsset(a, () => APP.reload()) },
        { id: 'cal', label: 'Record calibration', kind: '', onClick: () => openEvent(a, 'calibration', () => APP.reload()) },
        { id: 'svc', label: 'Record service or repair', onClick: () => openEvent(a, 'service', () => APP.reload()) },
      ] : []),
    ]);

    const row = (k, v) => `<dt>${UI.esc(k)}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
    el.innerHTML = `
      ${st && a.calibration_state === 'expired' ? `<div class="alert danger">
        <b>Calibration expired on ${UI.esc(UI.date(a.calibration_due))}.</b>
        Readings from this equipment should not be relied on until it has been recalibrated.</div>` : ''}
      ${st && a.calibration_state === 'due_soon' ? `<div class="alert warn">
        <b>Calibration due ${UI.esc(UI.date(a.calibration_due))}.</b> Book the engineer now —
        a certificate takes weeks to come back.</div>` : ''}
      ${st && a.calibration_state === 'unset' ? `<div class="alert orange">
        This needs calibrating${a.calibration_months ? ` every ${UI.esc(a.calibration_months)} months` : ''},
        and no date has been entered yet. Record the last calibration and the due date follows.</div>` : ''}

      <div class="grid c2">
        <div class="card"><div class="card-head"><h3>The equipment</h3></div>
          <div class="card-body"><dl class="kv">
            ${row('Asset number', `<code>${UI.esc(a.asset_no)}</code>`)}
            ${row('Name', UI.esc(a.name))}
            ${row('Category', UI.esc(a.category || ''))}
            ${row('Make &amp; model', UI.esc([a.make, a.model].filter(Boolean).join(' ')))}
            ${row('Serial number', a.serial_no ? UI.esc(a.serial_no) : '')}
            ${row('Quantity', UI.num(a.quantity))}
            ${row('Location', UI.esc(a.location || a.department_name || ''))}
            ${row('Status', UI.badge(UI.titleise(a.status), a.status === 'in_use' ? 'ok' : ''))}
            ${row('Notes', a.notes ? UI.esc(a.notes) : '')}
          </dl></div></div>

        <div class="card"><div class="card-head"><h3>Where it came from</h3></div>
          <div class="card-body"><dl class="kv">
            ${row('Supplier', UI.esc(a.supplier || ''))}
            ${row('Purchase order', a.po_no ? `<code>${UI.esc(a.po_no)}</code>` : '')}
            ${row('Invoice', a.invoice_no ? UI.esc(a.invoice_no) : '')}
            ${row('Ordered', a.purchase_date ? UI.esc(UI.date(a.purchase_date)) : '')}
            ${row('Rate', a.unit_cost !== null && a.unit_cost !== undefined ? UI.money(a.unit_cost) : '')}
            ${row('Warranty until', a.warranty_until ? UI.esc(UI.date(a.warranty_until)) : '')}
            ${row('AMC until', a.amc_until ? UI.esc(UI.date(a.amc_until)) : '')}
          </dl></div></div>
      </div>

      <div class="card mt"><div class="card-head"><h3>Calibration</h3>
        ${st ? UI.badge(st.label, st.kind) : '<span class="muted small">Not required for this asset</span>'}</div>
        <div class="card-body"><dl class="kv">
          ${row('Due every', a.calibration_months ? `${UI.esc(a.calibration_months)} months` : '')}
          ${row('Last calibrated', a.last_calibrated ? UI.esc(UI.date(a.last_calibrated)) : '')}
          ${row('Next due', a.calibration_due ? UI.esc(UI.date(a.calibration_due)) : '')}
          ${row('Calibrated by', UI.esc(a.calibration_by || ''))}
          ${row('Certificate', UI.esc(a.certificate_no || ''))}
        </dl></div></div>

      <div class="card mt"><div class="card-head"><h3>History</h3>
        <span class="muted small">Every calibration, service, repair and move</span></div>
        <div class="card-body tight">${UI.table([
          { label: 'Date', render: (e) => UI.esc(UI.date(e.happened_on)) },
          { label: 'What', render: (e) => UI.badge(UI.titleise(e.kind),
            e.kind === 'calibration' ? 'teal' : e.kind === 'repair' ? 'warn' : '') },
          { label: 'Detail', render: (e) => UI.esc(e.detail || '—') },
          { label: 'By', render: (e) => UI.esc(e.done_by || e.entered_by_name || '—') },
          { label: 'Reference', render: (e) => e.reference ? `<code>${UI.esc(e.reference)}</code>` : '—' },
          { label: 'Next due', render: (e) => e.next_due ? UI.esc(UI.date(e.next_due)) : '—' },
        ], a.events, { emptyText: 'Nothing recorded against this asset yet.' })}</div></div>`;
  }

  // --------------------------------------------------------------- the forms
  function openAsset(a, onDone) {
    const editing = Boolean(a && a.id);
    UI.modal({
      title: editing ? `Edit — ${a.name}` : 'Add an asset',
      size: 'wide',
      body: `<form id="as-form">
        <div class="grid c2">
          ${UI.field({ name: 'name', label: 'What it is', required: true, value: a.name || '',
            placeholder: 'e.g. Biochemistry analyser' })}
          ${UI.field({ name: 'category', label: 'Category', value: a.category || '',
            options: [''].concat(meta.categories) })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'make', label: 'Make', value: a.make || '' })}
          ${UI.field({ name: 'model', label: 'Model', value: a.model || '' })}
          ${UI.field({ name: 'serialNo', label: 'Serial number', value: a.serial_no || '',
            hint: 'Off the plate on the machine.' })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'quantity', label: 'Quantity', type: 'number', value: a.quantity || 1, min: 1 })}
          ${UI.field({ name: 'location', label: 'Where it stands', value: a.location || '',
            placeholder: 'e.g. Lab, X-ray room, OPD-1' })}
          ${UI.field({ name: 'departmentId', label: 'Department', value: a.department_id || '',
            options: [{ value: '', label: '— none —' }]
              .concat(meta.departments.map((d) => ({ value: d.id, label: d.name }))) })}
        </div>
        ${UI.field({ name: 'status', label: 'Status', value: a.status || 'in_use',
          options: meta.statuses.map((s) => ({ value: s, label: UI.titleise(s) })) })}

        <fieldset><legend>Where it came from</legend>
          <div class="grid c2">
            ${UI.field({ name: 'supplier', label: 'Supplier', value: a.supplier || '' })}
            ${UI.field({ name: 'poNo', label: 'Purchase order', value: a.po_no || '' })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'invoiceNo', label: 'Invoice', value: a.invoice_no || '' })}
            ${UI.field({ name: 'purchaseDate', label: 'Purchased', type: 'date', value: a.purchase_date || '' })}
            ${UI.field({ name: 'unitCost', label: 'Rate (₹)', type: 'number', step: '0.01',
              value: a.unit_cost === null || a.unit_cost === undefined ? '' : a.unit_cost })}
          </div>
          <div class="grid c2">
            ${UI.field({ name: 'warrantyUntil', label: 'Warranty until', type: 'date', value: a.warranty_until || '' })}
            ${UI.field({ name: 'amcUntil', label: 'AMC until', type: 'date', value: a.amc_until || '' })}
          </div>
        </fieldset>

        <fieldset><legend>Calibration</legend>
          ${UI.checkbox({ name: 'needsCalibration', label: 'This equipment has to be calibrated',
            checked: Boolean(a.needs_calibration) })}
          <div class="grid c2">
            ${UI.field({ name: 'calibrationMonths', label: 'Due every (months)', type: 'number',
              value: a.calibration_months || '', min: 1,
              hint: 'Leave the due date blank and it is worked out from this.' })}
            ${UI.field({ name: 'lastCalibrated', label: 'Last calibrated', type: 'date',
              value: a.last_calibrated || '' })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'calibrationDue', label: 'Next due', type: 'date', value: a.calibration_due || '',
              hint: 'A date typed here always wins.' })}
            ${UI.field({ name: 'calibrationBy', label: 'Calibrated by', value: a.calibration_by || '' })}
            ${UI.field({ name: 'certificateNo', label: 'Certificate number', value: a.certificate_no || '' })}
          </div>
        </fieldset>
        ${UI.field({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: a.notes || '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${editing ? 'Save changes' : 'Add it'}</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#as-form'));
        v.needsCalibration = Boolean(v.needsCalibration);
        if (editing) await API.patch(`/api/assets/${a.id}`, v);
        else await API.post('/api/assets', v);
        UI.ok(editing ? 'Asset updated.' : 'Added to the register.');
        if (onDone) onDone();
      },
    });
  }

  function openEvent(a, kind, onDone) {
    const today = new Date().toISOString().slice(0, 10);
    const isCal = kind === 'calibration';
    UI.modal({
      title: `${isCal ? 'Calibration' : 'Service or repair'} — ${a.name}`,
      size: 'narrow',
      body: `<form id="ae-form">
        ${UI.field({ name: 'kind', label: 'What was done', value: kind,
          options: meta.eventKinds.map((k) => ({ value: k, label: UI.titleise(k) })) })}
        ${UI.field({ name: 'happenedOn', label: 'Date', type: 'date', required: true,
          value: today, max: today })}
        ${isCal ? `<p class="muted small">Leave the next due date blank and it is set
          ${a.calibration_months ? `${a.calibration_months} months` : 'one interval'} on from the
          date above. The asset's own dates move with this entry.</p>` : ''}
        ${UI.field({ name: 'nextDue', label: 'Next due', type: 'date', value: '' })}
        ${UI.field({ name: 'doneBy', label: isCal ? 'Calibrated by' : 'Done by', value: '',
          placeholder: 'Engineer or agency' })}
        ${UI.field({ name: 'reference', label: isCal ? 'Certificate number' : 'Job / docket number', value: '' })}
        ${UI.field({ name: 'cost', label: 'Cost (₹)', type: 'number', step: '0.01', value: '' })}
        ${UI.field({ name: 'detail', label: 'Detail', type: 'textarea', rows: 2, value: '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Record it</button>`,
      onAction: async (act, modal) => {
        if (act !== 'save') return;
        await API.post(`/api/assets/${a.id}/events`, UI.formValues(modal.querySelector('#ae-form')));
        UI.ok('Recorded.');
        if (onDone) onDone();
      },
    });
  }
})();
