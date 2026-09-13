/* The master records everything else is built on. Administrators only. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const state = { tab: null };

  const TABS = [
    ['companies', 'Group companies'],
    ['applications', 'Applications'],
    ['categories', 'Product lines'],
    ['subgroups', 'Types'],
    ['terms', 'Payment terms'],
    ['conditions', 'Terms & conditions'],
    ['numbers', 'Document numbers'],
    ['branding', 'Logo'],
    ['locations', 'Locations'],
    ['heads', 'Expense heads'],
  ];

  APP.register('masters', {
    title: 'Masters',
    subtitle: 'The six group companies, the five applications, the fourteen product lines and the payment terms',

    async render(host) {
      const m = await APP.loadMasters(true);
      const isAdmin = APP.can(['admin']);
      // A key account manager comes here for the conditions, not the companies.
      if (!state.tab) state.tab = isAdmin ? 'companies' : 'conditions';
      host.innerHTML = `<div class="tabs">${TABS.map(([id, label]) =>
        `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>
        <div id="pane"></div>`;

      const paint = () => {
        const pane = document.getElementById('pane');
        const tab = state.tab;
        if (tab === 'companies') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Company', kind: 'gold', onClick: () => editCompany() }] : []);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">One set of books, six companies. Every document is numbered and
              stamped with the company that issued it — AKR/LPO/2026/0042 — so no two of them can
              share a reference.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Name', render: (r) => `${esc(r.name)}${r.is_default ? ' ' + UI.badge('default', 'ok') : ''}` },
              { label: 'TRN', render: (r) => (r.trn ? `<span class="mono small">${esc(r.trn)}</span>`
                : '<span class="badge warn">not set</span>') },
              { label: 'VAT', num: true, render: (r) => `${r.vat_percent}%` },
              { label: 'Currency', key: 'currency' },
              { label: '', render: (r) => (r.active ? '' : UI.badge('inactive')) },
            ], m.companies, { onRow: true })}</div>`;
          if (isAdmin) UI.bindRows(pane, m.companies, (row) => editCompany(row));
          return;
        }
        if (tab === 'applications') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Application', kind: 'gold', onClick: () => editApplication() }] : []);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">The title every quotation, LPO, delivery note and invoice carries,
              so a storm-water job and a potable-water job never share a sheet of paper.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Application', key: 'name' },
              { label: 'Order', num: true, key: 'sort_order' },
              { label: '', render: (r) => (r.active ? '' : UI.badge('inactive')) },
            ], m.applications, { onRow: true })}</div>`;
          if (isAdmin) UI.bindRows(pane, m.applications, (row) => editApplication(row));
          return;
        }
        if (tab === 'categories') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Product line', kind: 'gold', onClick: () => editCategory() }] : []);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">The code is the middle of every item number in the line —
              AKR-<b>VLP</b>-00001 is a potable-water valve — so it is fixed once items exist.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Product line', key: 'name' },
              { label: 'Group', key: 'product_group' },
              { label: 'Application', render: (r) => (r.application_name
                ? UI.badge(r.application_name, 'navy') : '—') },
              { label: 'Items', num: true, key: 'item_count' },
            ], m.categories, { onRow: true })}</div>`;
          if (isAdmin) UI.bindRows(pane, m.categories, (row) => editCategory(row));
          return;
        }
        if (tab === 'subgroups') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Type', kind: 'gold', onClick: () => editSubgroup() }] : []);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">The types within a line — the fabrication list in particular:
              straps, air vents, handle bars, C clamps, MS clamps, spider clamps, gratings, chequered
              plates, ladders, protection barriers and extension spindles.</div>
            ${UI.table([
              { label: 'Group', key: 'product_group' },
              { label: 'Code', render: (r) => `<span class="mono">${esc(r.code)}</span>` },
              { label: 'Type', key: 'name' },
              { label: '', render: (r) => (r.active ? '' : UI.badge('inactive')) },
            ], m.subgroups, { onRow: true })}</div>`;
          if (isAdmin) UI.bindRows(pane, m.subgroups, (row) => editSubgroup(row));
          return;
        }
        if (tab === 'terms') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Payment terms', kind: 'gold', onClick: () => editTerms() }] : []);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">One of these is chosen on every quotation, LPO and invoice. They
              decide the advance an order waits for, the cheque collected at the gate, and the due
              date on the invoice.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Terms', key: 'name' },
              { label: 'Kind', render: (r) => UI.badge(UI.titleise(r.kind)) },
              { label: 'Advance', num: true, render: (r) => (r.advance_percent ? `${r.advance_percent}%` : '—') },
              { label: 'On delivery', num: true, render: (r) => (r.on_delivery_percent ? `${r.on_delivery_percent}%` : '—') },
              { label: 'Credit', num: true, render: (r) => (r.credit_days ? `${r.credit_days} days` : '—') },
              { label: 'Retention', num: true, render: (r) => (r.retention_percent ? `${r.retention_percent}%` : '—') },
              { label: 'Applies to', render: (r) => UI.titleise(r.applies_to) },
            ], m.paymentTerms, { onRow: true })}</div>`;
          if (isAdmin) UI.bindRows(pane, m.paymentTerms, (row) => editTerms(row));
          return;
        }
        if (tab === 'conditions') { paintConditions(pane); return; }
        if (tab === 'numbers') { paintNumbers(pane, isAdmin); return; }
        if (tab === 'branding') { paintBranding(pane, isAdmin); return; }
        if (tab === 'locations') {
          APP.actions(isAdmin ? [{ id: 'add', label: '+ Location', kind: 'gold', onClick: () => editLocation() }] : []);
          pane.innerHTML = `<div class="card">${UI.table([
            { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
            { label: 'Location', render: (r) => `${esc(r.name)}${r.is_default ? ' ' + UI.badge('default', 'ok') : ''}` },
            { label: 'Address', key: 'address' },
          ], m.locations)}</div>`;
          return;
        }
        APP.actions(isAdmin ? [{ id: 'add', label: '+ Head', kind: 'gold', onClick: () => editHead() }] : []);
        pane.innerHTML = `<div class="card">
          <div class="card-sub">What the group's spending is filed under.</div>
          ${UI.table([
            { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
            { label: 'Head', key: 'name' },
            { label: 'Kind', render: (r) => UI.badge(UI.titleise(r.kind), r.kind === 'income' ? 'ok' : '') },
          ], m.expenseCategories)}</div>`;
      };

      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        APP.reload();
      }));
      paint();
    },
  });

  /*
   * The clause library — the conditions that go at the foot of an LPO or a
   * quotation. Kept by the key account manager, not only by an administrator:
   * they are the ones who find out the hard way which condition was missing.
   */
  let conditionDoc = 'purchase_order';

  const DOC_LABELS = {
    purchase_order: 'LPO to a supplier',
    sales_quotation: 'Quotation to a client',
  };

  async function paintConditions(pane) {
    const canEdit = APP.can(['kam']);
    APP.actions(canEdit
      ? [{ id: 'add', label: '+ Add a point', kind: 'gold', onClick: () => editClause(null) }] : []);
    pane.innerHTML = UI.loading();
    const data = await API.get(`/api/masters/terms?doc_type=${conditionDoc}&includeInactive=1`);

    const rows = data.rows;
    let lastGroup = null;
    const list = rows.map((c, i) => {
      const header = c.clause_group && c.clause_group !== lastGroup
        ? `<tr><td colspan="5" style="padding-top:14px;border:0">
             <b class="small" style="color:var(--navy);letter-spacing:.8px;text-transform:uppercase">
             ${esc(c.clause_group)}</b></td></tr>` : '';
      lastGroup = c.clause_group || lastGroup;
      return header + `<tr data-clause="${c.id}" class="${c.active ? '' : 'dim'}">
        <td class="num muted" style="width:34px">${i + 1}</td>
        <td>${esc(c.text)}</td>
        <td style="width:110px">${c.is_default ? UI.badge('ticked by default', 'ok')
          : UI.badge('off by default')}</td>
        <td style="width:80px">${c.active ? '' : UI.badge('retired', 'danger')}</td>
        <td style="width:104px" class="nowrap">${canEdit
          ? `<button class="btn ghost sm" data-up="${c.id}" title="Move up">↑</button>
             <button class="btn ghost sm" data-down="${c.id}" title="Move down">↓</button>` : ''}</td>
      </tr>`;
    }).join('');

    pane.innerHTML = `
      <div class="card">
        <div class="row-between mb">
          <div>
            <b>Standard conditions</b>
            <div class="card-sub">What a new document starts with. A point edited here changes the
              next document raised; it never reaches back into an order a supplier already has.</div>
          </div>
          <label class="field" style="margin:0;min-width:220px"><span>These conditions go on</span>
            <select id="doc-type">
              ${Object.entries(DOC_LABELS).map(([k, label]) =>
                `<option value="${k}"${k === conditionDoc ? ' selected' : ''}>${esc(label)}</option>`).join('')}
            </select></label>
        </div>
        <div class="alert info small">
          <b>Placeholders</b> are filled in from the document itself, so a block copied onto the next
          order cannot carry the last order's supplier with it:
          ${Object.entries(data.placeholders).map(([k, note]) =>
            `<div><code>${esc(k)}</code> — ${esc(note)}</div>`).join('')}
        </div>
        <div class="table-wrap"><table><tbody>${list
          || '<tr><td class="muted">No conditions set up for this document yet.</td></tr>'}</tbody></table></div>
      </div>`;

    pane.querySelector('#doc-type').addEventListener('change', (e) => {
      conditionDoc = e.target.value;
      paintConditions(pane);
    });
    if (!canEdit) return;

    pane.querySelectorAll('tr[data-clause]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        editClause(rows.find((r) => String(r.id) === tr.dataset.clause));
      });
    });
    const move = async (id, delta) => {
      const order = rows.filter((r) => r.active).map((r) => r.id);
      const at = order.indexOf(Number(id));
      const to = at + delta;
      if (at === -1 || to < 0 || to >= order.length) return;
      order.splice(to, 0, order.splice(at, 1)[0]);
      await API.post('/api/masters/terms/reorder', { order });
      paintConditions(pane);
    };
    pane.querySelectorAll('[data-up]').forEach((b) =>
      b.addEventListener('click', () => move(b.dataset.up, -1)));
    pane.querySelectorAll('[data-down]').forEach((b) =>
      b.addEventListener('click', () => move(b.dataset.down, 1)));
  }

  function editClause(clause) {
    const groups = ['Specification & approval', 'Inspection & testing', 'Quality & documents',
      'Packing & delivery', 'Invoicing & payment', 'Prices', 'Delivery', 'Payment', 'General'];
    UI.modal({
      title: clause ? 'Edit this point' : 'Add a point',
      body: `<form id="cl-form">
        ${clause ? '' : UI.field({ name: 'doc_type', label: 'Goes on', value: conditionDoc,
          options: Object.entries(DOC_LABELS).map(([k, label]) => ({ value: k, label })) })}
        ${UI.field({ name: 'clause_group', label: 'Grouped under', blank: 'Ungrouped',
          value: clause ? clause.clause_group : '',
          options: groups.map((g) => ({ value: g, label: g })) })}
        ${UI.field({ name: 'text', label: 'The point, as it prints', rows: 4, required: true,
          value: clause ? clause.text : '',
          hint: 'You may use {{supplier}}, {{company}}, {{authority}}, {{lpo_no}}, {{project}} and {{payment_terms}}.' })}
        ${UI.checkbox({ name: 'is_default', label: 'Tick this point on a new document',
          checked: clause ? !!clause.is_default : true })}
        ${clause ? UI.checkbox({ name: 'active', label: 'Still in use',
          checked: !!clause.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        ${clause && clause.active ? '<button class="btn danger" data-act="retire">Retire it</button>' : ''}
        <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act === 'retire') {
          const sure = await UI.confirm(
            'Retire this point? It stops appearing on new documents, and stays exactly as it is on '
            + 'every order already issued with it.',
            { title: 'Retire this condition?', danger: true, yes: 'Retire it' });
          if (!sure) return 'keep';
          await API.del(`/api/masters/terms/${clause.id}`);
          UI.ok('Retired.');
          APP.reload();
          return;
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#cl-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        v.is_default = form.querySelector('[name=is_default]').checked;
        if (clause) v.active = form.querySelector('[name=active]').checked;
        else v.doc_type = v.doc_type || conditionDoc;
        if (clause) await API.patch(`/api/masters/terms/${clause.id}`, v);
        else await API.post('/api/masters/terms', v);
        UI.ok('Saved.');
        APP.reload();
      },
    });
  }

  /*
   * How each document is referenced.
   *
   * The company's own shapes — AKR-FD26-016 for an LPO, AKR-SO-082026-014 for a
   * client's order — are already on paper that suppliers and clients hold, so
   * they are the ones the system follows. A series can also be picked up from a
   * number already issued, which is what matters when the books move onto this
   * system halfway through a year.
   */
  async function paintNumbers(pane, isAdmin) {
    APP.actions([]);
    pane.innerHTML = UI.loading();
    const data = await API.get('/api/masters/document-numbers');
    pane.innerHTML = `
      <div class="card">
        <h3>Document numbers — ${esc(data.company.code)}</h3>
        <div class="card-sub">Every document carries a reference from its own series, so any of
          them can be traced back years later. ${isAdmin ? 'Click a row to change its shape or to '
          + 'continue it from a number already issued.' : 'An administrator keeps these.'}</div>
        <div class="alert info small">
          ${Object.entries(data.tokens).map(([k, note]) =>
            `<div><code>${esc(k)}</code> — ${esc(note)}</div>`).join('')}
          <div class="mt">Anything else in the pattern prints as it stands — which is how the
            <code>FD</code> in <b>AKR-FD26-016</b> survives.</div>
        </div>
        <div id="series-rows"></div>
      </div>`;

    const box = document.getElementById('series-rows');
    box.innerHTML = UI.table([
      { label: 'Document', render: (r) => `<b>${esc(r.label)}</b>
          <div class="muted small mono">${esc(r.pattern)}</div>
          ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ''}` },
      { label: 'Next reference', render: (r) => `<b class="mono">${esc(r.next_reference)}</b>` },
      { label: 'Issued so far', num: true, render: (r) => UI.num(r.issued) },
      { label: 'Restarts', render: (r) => ({ yearly: 'each January', monthly: 'each month',
        never: 'never' }[r.reset_on]) },
      { label: '', render: (r) => (r.is_default ? UI.badge('built-in default') : '') },
    ], data.rows, { onRow: isAdmin });
    if (isAdmin) UI.bindRows(box, data.rows, (row) => editSeries(row, data));
  }

  function editSeries(row, data) {
    UI.modal({
      title: row.label,
      body: `<form id="n-form">
        ${UI.field({ name: 'pattern', label: 'Pattern', required: true, value: row.pattern,
          hint: 'Must contain {n} — without a serial every document would read the same.' })}
        <div class="alert ok small" id="preview">Next reference: <b class="mono">${esc(row.next_reference)}</b></div>
        ${UI.field({ name: 'reset_on', label: 'The serial restarts', value: row.reset_on,
          options: data.resets })}
        ${UI.field({ name: 'next_number', label: 'Continue from this number', type: 'number', min: 1,
          value: row.next_number,
          hint: 'Set this to carry on from a reference already issued on paper. It only ever moves '
            + 'forward — handing out a number twice is the one thing a reference must never do.' })}
        ${UI.field({ name: 'note', label: 'Note', value: row.note || '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      onMount(modal) {
        const patternEl = modal.querySelector('[name=pattern]');
        const serialEl = modal.querySelector('[name=next_number]');
        const out = modal.querySelector('#preview');
        let timer = null;
        const refresh = async () => {
          try {
            const res = await API.get('/api/masters/document-numbers/preview' + API.qs({
              pattern: patternEl.value, doc_kind: row.doc_kind, serial: serialEl.value,
            }));
            out.className = 'alert ok small';
            out.innerHTML = `Next reference: <b class="mono">${UI.esc(res.example)}</b>`;
          } catch (err) {
            out.className = 'alert danger small';
            out.textContent = err.message;
          }
        };
        for (const el of [patternEl, serialEl]) {
          el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
        }
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#n-form');
        if (!form.reportValidity()) return 'keep';
        const res = await API.put(`/api/masters/document-numbers/${row.doc_kind}`, UI.formValues(form));
        if (res.carried && !res.carried.ok) UI.warn(res.carried.message);
        else UI.ok(`Saved. The next one will be ${res.next_reference}.`);
        APP.reload();
      },
    });
  }

  /*
   * The company's own artwork.
   *
   * A logo is a fact about the company, not source code, so it is uploaded
   * here rather than committed and deployed. Whatever is put here goes on the
   * sidebar, the sign-in page, the head of every printed document and the
   * watermark behind them, at once.
   */
  async function paintBranding(pane, isAdmin) {
    APP.actions([]);
    pane.innerHTML = UI.loading();
    const data = await API.get('/api/masters/branding');

    pane.innerHTML = `
      <div class="card">
        <h3>Logo</h3>
        ${data.ephemeral ? `<div class="alert danger"><b>Anything uploaded here will be lost on the
          next deploy.</b> No storage volume is mounted, so the artwork is written inside the
          container Railway replaces each time the app is deployed — which is why an uploaded logo
          can turn back into the bundled drawing on its own. The database has the same problem, so
          the real fix is a volume: Railway → the service → Variables/Volumes → <b>+ Volume</b>,
          mounted at <b>/data</b>.
          <br><br><b>Or give the logo to the deployment instead of uploading it.</b> Railway holds
          its variables outside the container, so a logo set there comes back on every deploy with
          no volume at all. On the service → Variables, add <b>one</b> of these and redeploy:
          <br>· <b>COMPANY_LOGO_URL</b> — a link to the artwork, or to a page it is on
          <br>· <b>COMPANY_LOGO_DATA</b> — the file itself: SVG markup, base64, or a data: URI
          <br>Neither overwrites what you upload here by hand.</div>` : ''}
        <div class="card-sub">The ERP ships with the AKR eagle drawn in the source, so the mark is
          on every screen and every printed page from the first run. It is a rendition, not the
          artwork file — upload the real one here and it takes over everywhere at once: the
          sidebar, the sign-in page, the head of every printed document, the watermark ghosted
          behind them, and the browser tab. <b>An SVG is best</b>: it is a
          drawing rather than a grid of pixels, so it is sharp at 44 pixels in the sidebar and at
          full size on a letterhead alike. A PNG works, at 480 pixels or more on its longer side.
          <b>A transparent background is worth asking for</b> — artwork with a solid background of
          its own prints as a coloured tile on white paper, and there is nothing this system can do
          about that after the fact.</div>
        <div class="grid g2">
          ${data.slots.map((s) => `
            <div class="brand-slot">
              <div class="k">${esc(s.label)}</div>
              <div class="brand-preview"><img src="${esc(s.url)}" alt=""></div>
              <div class="row-between mt">
                <span class="muted small">${s.uploaded
                  ? `${esc((s.mime || '').replace('image/', '').toUpperCase())} ·
                     ${Math.max(1, Math.round((s.size_bytes || 0) / 1024))} KB${
                       s.vector ? ' · vector, sharp at any size'
                         : (s.width ? ` · ${s.width} × ${s.height}` : '')}`
                  : 'the bundled drawing — upload the real artwork'}</span>
                ${isAdmin ? `<span class="btn-row">
                  <label class="btn ghost sm" style="cursor:pointer;margin:0">Upload
                    <input type="file" hidden data-slot="${esc(s.slot)}"
                           accept=".svg,.png,.jpg,.jpeg,.webp"></label>
                  ${s.uploaded ? `<button class="btn ghost sm" data-clear="${esc(s.slot)}">Revert</button>` : ''}
                </span>` : ''}
              </div>
              ${s.soft ? `<div class="alert warn small mt">This file is
                ${s.width} × ${s.height} — small for the head of an A4 document, where it prints
                about 20 mm wide. It will look soft there. Ask whoever drew it for the
                <b>SVG</b>, or a PNG at least 480 pixels on its longer side.</div>` : ''}
            </div>`).join('')}
        </div>
        ${isAdmin ? `<div class="drop-logo mt" id="brand-drop" tabindex="0">
          <b>Drop the file here, or paste it</b>
          <div class="muted small">Copy the logo anywhere — a message, a website, a document —
            then click here and press Ctrl+V (⌘V on a Mac). A file dragged onto this box works
            too. It goes in as the mark.</div>
        </div>
        <div class="mt">
          <label class="field"><span>Or take it from the company's website</span>
            <input id="brand-url" placeholder="https://www.akr365.com/" autocomplete="off"></label>
          <div class="btn-row">
            <button class="btn ghost sm" data-fetch="mark">Fetch as the mark</button>
            <button class="btn ghost sm" data-fetch="full">Fetch as the lock-up</button>
          </div>
          <div class="muted small mt">Paste the address of the site and the server looks for the
            logo the way a browser would; paste the address of the picture itself and it takes
            that. Whatever comes back is checked before it is kept.</div>
        </div>` : ''}
        <div id="brand-out"></div>
        <div class="mt">${UI.checkbox({ name: 'plate', label: 'Put a light plate behind it',
          checked: data.settings ? data.settings.plate !== false : true })}
          <div class="muted small">Leave this on for artwork with a transparent background, which
            would otherwise disappear into the dark sidebar. <b>Turn it off if the logo carries its
            own background</b> — otherwise it looks like a sticker stuck on the page.</div></div>
        <div class="muted small mt">The watermark uses the mark on its own, at four per cent —
          faint enough not to compete with a line of text. Whichever artwork has been uploaded is
          used everywhere: sidebar, sign-in page, every printed document and the browser tab.</div>
      </div>`;

    if (!isAdmin) return;
    const out = pane.querySelector('#brand-out');

    /*
     * Pasted or dropped, as well as picked from a file dialog.
     *
     * The artwork is usually already in somebody's hand — in a message, on the
     * website, in a letterhead they have open. Copy it and paste it here, and
     * it is in; a file dialog on a phone is the step where this keeps failing.
     */
    const drop = pane.querySelector('#brand-drop');
    const put = async (blob, name) => {
      out.innerHTML = UI.loading();
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
          reader.onerror = () => reject(new Error('That file could not be read.'));
          reader.readAsDataURL(blob);
        });
        await API.post('/api/masters/branding/mark', {
          data, mime: blob.type || null, filename: name || 'logo',
        });
        out.innerHTML = '';
        UI.ok('Logo updated. It is on every screen and every document from now on.');
        await APP.loadMasters(true);
        await APP.refreshShell();
      } catch (err) {
        out.innerHTML = `<div class="alert danger mt">${esc(err.message)}</div>`;
      }
    };
    if (drop) {
      drop.addEventListener('paste', (e) => {
        const item = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        put(item.getAsFile(), 'pasted-logo');
      });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const file = e.dataTransfer.files[0];
        if (file) put(file, file.name);
      });
      drop.addEventListener('click', () => drop.focus());
    }

    pane.querySelectorAll('[data-fetch]').forEach((b) => b.addEventListener('click', async () => {
      const url = pane.querySelector('#brand-url').value.trim();
      if (!url) { UI.err('Paste a web address first.'); return; }
      out.innerHTML = UI.loading();
      try {
        const saved = await API.post(`/api/masters/branding/${b.dataset.fetch}/from-url`, { url });
        UI.ok(`Taken from ${saved.taken_from}`);
        // The sidebar is painted from the session, so re-read it: otherwise the
        // logo changes everywhere except the one place they are looking.
        await APP.refreshShell();
      } catch (err) {
        out.innerHTML = `<div class="alert danger">${esc(err.message)}</div>`;
      }
    }));

    const plate = pane.querySelector('[name=plate]');
    if (plate) {
      plate.addEventListener('change', async () => {
        await API.patch('/api/masters/branding', { plate: plate.checked });
        UI.ok(plate.checked ? 'A plate goes behind it.' : 'The artwork stands on its own.');
        await APP.refreshShell();
      });
    }

    pane.querySelectorAll('input[data-slot]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        out.innerHTML = UI.loading();
        try {
          const reader = new FileReader();
          const data64 = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
            reader.onerror = () => reject(new Error('That file could not be read.'));
            reader.readAsDataURL(file);
          });
          await API.post(`/api/masters/branding/${input.dataset.slot}`, {
            data: data64, mime: file.type || null, filename: file.name,
          });
          out.innerHTML = '';
          UI.ok('Logo updated. It is on every screen and every document from now on.');
          // The shell is holding the old one — re-read the session rather than
          // reloading the page, which loses where they were.
          await APP.loadMasters(true);
          await APP.refreshShell();
        } catch (err) {
          out.innerHTML = `<div class="alert danger mt">${esc(err.message)}</div>`;
        }
      });
    });

    pane.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
      const sure = await UI.confirm('Go back to the bundled drawing of the mark?', { danger: true });
      if (!sure) return;
      await API.del(`/api/masters/branding/${b.dataset.clear}`);
      UI.ok('Reverted.');
      await APP.refreshShell();
    }));
  }

  const save = async (label, fn) => {
    await fn();
    UI.ok(`${label} saved.`);
    await APP.loadMasters(true);
    APP.reload();
  };

  function editCompany(c) {
    UI.modal({
      title: c ? `${c.code} — ${c.name}` : 'New group company',
      size: 'wide',
      body: `<form id="c-form">
        <div class="grid g3">
          ${UI.field({ name: 'code', label: 'Code', required: true, value: c ? c.code : '',
            disabled: !!c, hint: 'Goes on every document number this company issues.' })}
          ${UI.field({ name: 'name', label: 'Name', required: true, value: c ? c.name : '' })}
          ${UI.field({ name: 'trn', label: 'TRN', value: c ? c.trn || '' : '',
            hint: 'Fifteen digits. A tax invoice is not valid without it.' })}
        </div>
        ${UI.field({ name: 'legal_name', label: 'Legal name', value: c ? c.legal_name || '' : '' })}
        ${UI.field({ name: 'address', label: 'Address', rows: 2, value: c ? c.address || '' : '' })}
        <div class="grid g3">
          ${UI.field({ name: 'phone', label: 'Telephone', value: c ? c.phone || '' : '' })}
          ${UI.field({ name: 'email', label: 'Email', value: c ? c.email || '' : '' })}
          ${UI.field({ name: 'website', label: 'Website', value: c ? c.website || '' : '' })}
        </div>
        <div class="grid g4">
          ${UI.field({ name: 'bank_name', label: 'Bank', value: c ? c.bank_name || '' : '' })}
          ${UI.field({ name: 'bank_account', label: 'Account number', value: c ? c.bank_account || '' : '' })}
          ${UI.field({ name: 'iban', label: 'IBAN', value: c ? c.iban || '' : '' })}
          ${UI.field({ name: 'swift', label: 'SWIFT', value: c ? c.swift || '' : '' })}
        </div>
        <div class="grid g3">
          ${UI.field({ name: 'currency', label: 'Currency', value: c ? c.currency : 'AED' })}
          ${UI.field({ name: 'vat_percent', label: 'VAT %', type: 'number', step: '0.01',
            value: c ? c.vat_percent : 5 })}
          <div>${UI.checkbox({ name: 'is_default', label: 'The default company',
            checked: c ? !!c.is_default : false })}
          ${c ? UI.checkbox({ name: 'active', label: 'Active', checked: !!c.active }) : ''}</div>
        </div>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#c-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        v.is_default = form.querySelector('[name=is_default]').checked;
        if (c) v.active = form.querySelector('[name=active]').checked;
        await save('Company', () => (c ? API.patch(`/api/masters/companies/${c.id}`, v)
          : API.post('/api/masters/companies', v)));
      },
    });
  }

  function editApplication(a) {
    UI.modal({
      title: a ? `Application — ${a.name}` : 'New application',
      size: 'narrow',
      body: `<form id="a-form">
        ${UI.field({ name: 'code', label: 'Code', required: true, value: a ? a.code : '', disabled: !!a })}
        ${UI.field({ name: 'name', label: 'Application', required: true, value: a ? a.name : '' })}
        ${UI.field({ name: 'sort_order', label: 'Order', type: 'number', value: a ? a.sort_order : 99 })}
        ${a ? UI.checkbox({ name: 'active', label: 'Active', checked: !!a.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#a-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        if (a) v.active = form.querySelector('[name=active]').checked;
        await save('Application', () => (a ? API.patch(`/api/masters/applications/${a.id}`, v)
          : API.post('/api/masters/applications', v)));
      },
    });
  }

  function editCategory(c) {
    UI.modal({
      title: c ? `Product line — ${c.name}` : 'New product line',
      body: `<form id="l-form">
        ${UI.field({ name: 'code', label: 'Code (2–4 letters)', required: true, value: c ? c.code : '',
          disabled: !!c, hint: 'Becomes the middle of every item code in this line, and cannot change afterwards.' })}
        ${UI.field({ name: 'name', label: 'Line', required: true, value: c ? c.name : '',
          placeholder: 'Valves — Potable Water' })}
        ${UI.field({ name: 'product_group', label: 'Product group', required: true,
          value: c ? c.product_group : '', placeholder: 'Valves' })}
        ${UI.field({ name: 'application_id', label: 'Application', blank: 'None in particular',
          value: c ? c.application_id : '', options: APP.applicationOptions() })}
        ${UI.field({ name: 'sort_order', label: 'Order', type: 'number', value: c ? c.sort_order : 99 })}
        ${c ? UI.checkbox({ name: 'active', label: 'Active', checked: !!c.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#l-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        if (c) v.active = form.querySelector('[name=active]').checked;
        await save('Product line', () => (c ? API.patch(`/api/masters/categories/${c.id}`, v)
          : API.post('/api/masters/categories', v)));
      },
    });
  }

  function editSubgroup(s) {
    const groups = [...new Set((APP.masters.categories || []).map((c) => c.product_group))];
    UI.modal({
      title: s ? `Type — ${s.name}` : 'New type',
      size: 'narrow',
      body: `<form id="s-form">
        ${UI.field({ name: 'product_group', label: 'Product group', required: true,
          value: s ? s.product_group : '', options: groups.map((g) => ({ value: g, label: g })),
          disabled: !!s })}
        ${UI.field({ name: 'code', label: 'Code', required: true, value: s ? s.code : '', disabled: !!s })}
        ${UI.field({ name: 'name', label: 'Type', required: true, value: s ? s.name : '',
          placeholder: 'Chequered Plate' })}
        ${UI.field({ name: 'sort_order', label: 'Order', type: 'number', value: s ? s.sort_order : 99 })}
        ${s ? UI.checkbox({ name: 'active', label: 'Active', checked: !!s.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#s-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        if (s) { v.active = form.querySelector('[name=active]').checked; }
        await save('Type', () => (s ? API.patch(`/api/masters/subgroups/${s.id}`, v)
          : API.post('/api/masters/subgroups', v)));
      },
    });
  }

  function editTerms(t) {
    UI.modal({
      title: t ? `Payment terms — ${t.name}` : 'New payment terms',
      body: `<form id="t-form">
        <div class="grid g2">
          ${UI.field({ name: 'code', label: 'Code', required: true, value: t ? t.code : '', disabled: !!t })}
          ${UI.field({ name: 'name', label: 'As it reads on a document', required: true,
            value: t ? t.name : '', placeholder: '60 days from invoice date' })}
        </div>
        ${UI.field({ name: 'kind', label: 'Kind', value: t ? t.kind : 'credit',
          options: [{ value: 'advance', label: 'Advance — paid before anything is ordered' },
            { value: 'on_delivery', label: 'On delivery — collected at the gate' },
            { value: 'credit', label: 'Credit — so many days from the invoice' },
            { value: 'pdc', label: 'Post-dated cheque' },
            { value: 'milestone', label: 'Split — advance, delivery and balance' },
            { value: 'lc', label: 'Letter of credit' }] })}
        <div class="grid g4">
          ${UI.field({ name: 'advance_percent', label: 'Advance %', type: 'number', step: '0.01',
            value: t ? t.advance_percent : 0 })}
          ${UI.field({ name: 'on_delivery_percent', label: 'On delivery %', type: 'number', step: '0.01',
            value: t ? t.on_delivery_percent : 0 })}
          ${UI.field({ name: 'retention_percent', label: 'Retention %', type: 'number', step: '0.01',
            value: t ? t.retention_percent : 0 })}
          ${UI.field({ name: 'credit_days', label: 'Credit days', type: 'number',
            value: t ? t.credit_days : 0 })}
        </div>
        ${UI.field({ name: 'applies_to', label: 'Offer these to', value: t ? t.applies_to : 'both',
          options: [{ value: 'both', label: 'Both sides' }, { value: 'client', label: 'Clients only' },
            { value: 'supplier', label: 'Suppliers only' }] })}
        ${UI.field({ name: 'description', label: 'The sentence printed on the document', rows: 2,
          value: t ? t.description || '' : '' })}
        ${UI.field({ name: 'sort_order', label: 'Order', type: 'number', value: t ? t.sort_order : 99 })}
        ${t ? UI.checkbox({ name: 'active', label: 'Offer these terms', checked: !!t.active }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#t-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        if (t) v.active = form.querySelector('[name=active]').checked;
        await save('Payment terms', () => (t ? API.patch(`/api/masters/payment-terms/${t.id}`, v)
          : API.post('/api/masters/payment-terms', v)));
      },
    });
  }

  function editLocation() {
    UI.modal({
      title: 'New location',
      size: 'narrow',
      body: `<form id="loc-form">
        ${UI.field({ name: 'code', label: 'Code', required: true })}
        ${UI.field({ name: 'name', label: 'Location', required: true })}
        ${UI.field({ name: 'address', label: 'Address', rows: 2 })}
        ${UI.checkbox({ name: 'is_default', label: 'Goods arrive here unless told otherwise' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#loc-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        v.is_default = form.querySelector('[name=is_default]').checked;
        await save('Location', () => API.post('/api/masters/locations', v));
      },
    });
  }

  function editHead() {
    UI.modal({
      title: 'New head',
      size: 'narrow',
      body: `<form id="h-form">
        ${UI.field({ name: 'code', label: 'Code', required: true })}
        ${UI.field({ name: 'name', label: 'Head', required: true })}
        ${UI.field({ name: 'kind', label: 'Kind', value: 'expense',
          options: [{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }] })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#h-form');
        if (!form.reportValidity()) return 'keep';
        await save('Head', () => API.post('/api/masters/expense-categories', UI.formValues(form)));
      },
    });
  }
})();
