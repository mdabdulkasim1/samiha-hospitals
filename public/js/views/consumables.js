/* The consumables store: what the clinic holds, what came in, what went out. */
(function () {
  'use strict';
  /**
   * Three tabs, in the order somebody standing in the store needs them.
   *
   * The shelf is the list, filtered the way the question is usually asked —
   * what is low, what is finished, what in this cupboard. Receiving is a
   * whole delivery at once, because that is the shape of the piece of paper
   * in the storekeeper's hand. Usage is what went where, which is the only
   * way anybody ever finds out that one room is getting through four times
   * the gloves of the other two.
   *
   * Nothing on this screen lets anybody type what is on the shelf. Stock is
   * received, issued, wasted or counted, and the figure follows — so every
   * number on it has a name and a date behind it.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const num = (n) => UI.num(Math.round((Number(n) || 0) * 100) / 100);
  const today = () => new Date().toISOString().slice(0, 10);

  let meta = { areas: [], kinds: [] };
  /** The owner and the administrator; a nurse records movements, not balances. */
  const isManagement = () => Boolean(APP.user && ['owner', 'admin'].includes(APP.user.role));

  APP.register('consumables', {
    title: 'Consumables Store',
    subtitle: 'Gloves, dressings, lab and housekeeping supplies — what is held and what moves',

    async render(el, params) {
      const tabs = { shelf: shelfTab, receive: receiveTab, usage: usageTab };
      const open = tabs[params.tab] ? params.tab : 'shelf';

      el.innerHTML = `
        <div class="tabs" id="cs-tabs">
          <button data-tab="shelf" class="${open === 'shelf' ? 'active' : ''}">The shelf</button>
          <button data-tab="receive" class="${open === 'receive' ? 'active' : ''}">Receive a delivery</button>
          <button data-tab="usage" class="${open === 'usage' ? 'active' : ''}">What went where</button>
        </div>
        <div id="cs-body">${UI.loading()}</div>`;

      const body = el.querySelector('#cs-body');
      el.querySelectorAll('#cs-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#cs-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        body.innerHTML = UI.loading();
        tabs[b.dataset.tab](body);
      }));
      await tabs[open](body);
    },
  });

  // ------------------------------------------------------------- the shelf
  async function shelfTab(body) {
    const state = { area: '', q: '', filter: '' };

    const draw = async () => {
      const data = await API.get('/api/consumables' + API.qs({
        area: state.area, q: state.q,
        low: state.filter === 'low' ? 1 : '',
        out: state.filter === 'out' ? 1 : '',
      }));
      meta = { areas: data.areas, kinds: data.kinds };

      body.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat"><div class="label">Items on the list</div>
            <div class="value">${num(data.totals.items)}</div>
            <div class="foot">across ${data.areas.length} areas</div></div>
          <div class="stat ${data.totals.out ? 'crimson' : 'ok'}"><div class="label">Nothing left</div>
            <div class="value">${num(data.totals.out)}</div>
            <div class="foot">the shelf is empty</div></div>
          <div class="stat ${data.totals.low ? 'orange' : ''}"><div class="label">Running low</div>
            <div class="value">${num(data.totals.low)}</div>
            <div class="foot">below the re-order level</div></div>
          <div class="stat"><div class="label">Never counted</div>
            <div class="value">${num(data.totals.unknown)}</div>
            <div class="foot">on the list, not yet on the book</div></div>
        </div>

        ${data.totals.unknown ? `<div class="alert info">
          <b>${num(data.totals.unknown)} items have never been counted.</b> The list came off the
          purchase order, so it says what the clinic buys — not what is on the shelf today. Walk
          round with it and press <b>Count</b> on each one; from then on the figures are real.
          ${isManagement() ? `<div class="mt">
            <button class="btn ghost sm" id="cs-adopt">Start them at the ordered quantities</button>
            <span class="muted small">Writes the purchase order's quantity as an opening balance
              against each one, marked as coming from the order rather than from a count.</span>
          </div>` : ''}</div>` : ''}

        <div class="card"><div class="card-head"><h3>The store</h3>
          <select id="cs-area" style="max-width:260px">
            <option value="">Everywhere</option>
            ${meta.areas.map((a) => `<option value="${UI.esc(a.code)}"${
  state.area === a.code ? ' selected' : ''}>${UI.esc(a.label)} (${a.items})</option>`).join('')}
          </select>
          <select id="cs-filter" style="max-width:190px">
            <option value="">Everything</option>
            <option value="low"${state.filter === 'low' ? ' selected' : ''}>Running low</option>
            <option value="out"${state.filter === 'out' ? ' selected' : ''}>Nothing left</option>
          </select>
          <input type="search" id="cs-q" placeholder="Gauze, cannula, bin liner…"
            value="${UI.esc(state.q)}" style="max-width:220px">
          <button class="btn sm" id="cs-add">+ Add an item</button>
        </div>
        <div class="card-body tight" id="cs-list"></div></div>`;

      const host = body.querySelector('#cs-list');
      host.innerHTML = UI.table([
        { label: 'Item', render: (r) => `<b>${UI.esc(r.name)}</b>
          ${r.description ? `<div class="muted small">${UI.esc(r.description)}</div>` : ''}` },
        { label: 'Where', render: (r) => UI.esc(r.area_label || r.area) },
        { label: 'Unit', render: (r) => UI.esc(r.unit) },
        { label: 'On the shelf', num: true, render: (r) => (r.movements
          ? `<b${r.on_hand <= 0 ? ' style="color:var(--danger)"' : ''}>${num(r.on_hand)}</b>`
          : '<span class="muted">not counted</span>') },
        { label: 'Should hold', num: true, render: (r) => num(r.indent_qty) },
        { label: '', render: (r) => (!r.movements
          ? UI.badge('Not counted', '')
          : (r.on_hand <= 0
            ? UI.badge('Finished', 'danger')
            : (r.on_hand <= r.reorder_level ? UI.badge('Low', 'warn') : ''))) },
        { label: 'Last moved', render: (r) => (r.last_moved
          ? UI.esc(UI.dateShort(r.last_moved)) : '<span class="muted">—</span>') },
      ], data.rows, { emptyText: 'Nothing matches that.' });
      UI.bindRows(host, data.rows, (r) => openItem(r.id, draw));

      body.querySelector('#cs-area').addEventListener('change', (e) => {
        state.area = e.target.value; draw();
      });
      body.querySelector('#cs-filter').addEventListener('change', (e) => {
        state.filter = e.target.value; draw();
      });
      let typing;
      const search = body.querySelector('#cs-q');
      search.addEventListener('input', () => {
        clearTimeout(typing);
        typing = setTimeout(() => { state.q = search.value.trim(); draw(); }, 300);
      });
      body.querySelector('#cs-add').addEventListener('click', () => openNewItem(draw));

      const adopt = body.querySelector('#cs-adopt');
      if (adopt) {
        adopt.addEventListener('click', async () => {
          const ok = await UI.confirm('This writes the purchase order\'s quantity as the opening '
            + 'balance of every item that has never been counted. It is the best figure anybody '
            + 'has until the store is walked, and each one can be corrected by counting it.',
          { title: 'Start the store at the ordered quantities?' });
          if (!ok) return;
          try {
            const out = await API.post('/api/consumables/adopt-indent', {});
            UI.ok(`${out.opened} item(s) opened at the ordered quantity.`);
            await draw();
          } catch (err) { UI.err(err.message); }
        });
      }
    };

    await draw();
  }

  /** One item: what is on the shelf, and everything that has moved it. */
  async function openItem(id, onChanged) {
    const item = await API.get(`/api/consumables/${id}`);

    UI.modal({
      title: item.name,
      size: 'wide',
      body: `
        <p class="muted" style="margin-top:0">
          <code>${UI.esc(item.code)}</code> · ${UI.esc(item.area_label || item.area)}
          ${item.description ? ` · ${UI.esc(item.description)}` : ''}</p>

        <div class="grid c3 mb">
          <div class="stat ${item.movements && item.on_hand <= 0 ? 'crimson' : ''}">
            <div class="label">On the shelf</div>
            <div class="value">${item.movements ? num(item.on_hand) : '—'}</div>
            <div class="foot">${UI.esc(item.unit)}${item.movements ? '' : ' · never counted'}</div></div>
          <div class="stat"><div class="label">Should hold</div>
            <div class="value">${num(item.indent_qty)}</div>
            <div class="foot">from the purchase order</div></div>
          <div class="stat"><div class="label">Re-order at</div>
            <div class="value">${num(item.reorder_level)}</div>
            <div class="foot">${item.reorder_at === null ? 'a quarter of the order' : 'set by the clinic'}</div></div>
        </div>

        <div class="btn-row mb">
          <button class="btn sm" data-act="receipt">Received</button>
          <button class="btn sm teal" data-act="issue">Issued</button>
          <button class="btn ghost sm" data-act="count">Count</button>
          <button class="btn ghost sm" data-act="wastage">Damaged</button>
          <button class="btn ghost sm" data-act="edit">Edit the item</button>
        </div>
        <div id="cs-move"></div>

        <h4>What has moved it</h4>
        ${item.history.length ? UI.table([
    { label: 'Date', render: (m) => UI.esc(UI.dateShort(m.moved_on)) },
    { label: 'What', render: (m) => UI.esc((meta.kinds.find((k) => k.key === m.kind) || {}).label || m.kind) },
    { label: 'Qty', num: true, render: (m) => `${m.qty > 0 ? '+' : ''}${num(m.qty)}` },
    { label: 'Detail', render: (m) => UI.esc([m.supplier, m.invoice_no, m.issued_to, m.reason, m.notes]
      .filter(Boolean).join(' · ') || '—') },
    { label: 'By', render: (m) => UI.esc(m.by_name || '—') },
  ], item.history) : '<p class="muted">Nothing has moved yet.</p>'}`,
      footer: '<button class="btn ghost" data-act="__close">Close</button>',
      async onAction(act, modal) {
        if (act === '__close') return undefined;
        if (act === 'edit') {
          UI.closeModal();
          openEditItem(item, onChanged);
          return undefined;
        }
        if (!['receipt', 'issue', 'count', 'wastage'].includes(act)) return 'keep';

        const host = modal.querySelector('#cs-move');
        host.innerHTML = moveForm(act, item);
        host.querySelector('[data-save]').addEventListener('click', async () => {
          const values = UI.formValues(host);
          try {
            const out = await API.post(`/api/consumables/${id}/movements`, { kind: act, ...values });
            UI.ok(out.unchanged ? out.message
              : `${UI.titleise(act)} — ${num(out.on_hand)} ${item.unit} on the shelf now.`);
            UI.closeModal();
            if (onChanged) await onChanged();
            openItem(id, onChanged);
          } catch (err) {
            host.querySelector('#cs-move-err').innerHTML =
              `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
          }
        });
        return 'keep';
      },
    });
  }

  /**
   * The form for one movement.
   *
   * A count asks what is on the shelf, not what changed: the difference is
   * worked out and written as a correction, which is both easier to do
   * standing in a cupboard and honest about what happened.
   */
  function moveForm(kind, item) {
    const fields = {
      receipt: `${UI.field({ name: 'qty', label: 'Quantity', type: 'number', required: true,
    hint: `Counted in: ${item.unit}` })}
        ${UI.field({ name: 'supplier', label: 'From' })}
        ${UI.field({ name: 'invoiceNo', label: 'Invoice or DC number' })}
        ${UI.field({ name: 'unitCost', label: `Cost per ${item.unit}`, type: 'number',
    hint: 'Leave empty if the bill is not to hand — it is better empty than guessed.' })}`,
      issue: `${UI.field({ name: 'qty', label: 'Quantity', type: 'number', required: true,
    hint: `Counted in: ${item.unit}` })}
        ${UI.field({ name: 'issuedTo', label: 'Where it went', required: true,
    placeholder: 'OP room 2, ward, injection room, laboratory…' })}`,
      count: `${UI.field({ name: 'counted', label: 'How many are actually there',
    type: 'number', required: true,
    hint: `Counted in: ${item.unit}. What you can see on the shelf — the book is corrected to match it.` })}`,
      wastage: `${UI.field({ name: 'qty', label: 'Quantity', type: 'number', required: true,
    hint: `Counted in: ${item.unit}` })}
        ${UI.field({ name: 'reason', label: 'What happened to it', required: true,
    placeholder: 'Carton crushed, packet torn, past its date' })}`,
    };
    return `<div class="card mb"><div class="card-body">
      <h4 style="margin-top:0">${UI.esc((meta.kinds.find((k) => k.key === kind) || {}).label || kind)}</h4>
      <div class="grid c2">
        ${fields[kind]}
        ${UI.field({ name: 'movedOn', label: 'On', type: 'date', value: today(), required: true })}
      </div>
      ${UI.field({ name: 'notes', label: 'Note' })}
      <div id="cs-move-err"></div>
      <button class="btn mt" data-save="1">Save it</button>
    </div></div>`;
  }

  function openNewItem(onSaved) {
    UI.modal({
      title: 'Add an item to the store',
      body: `<form id="cs-new" class="grid c2">
        ${UI.field({ name: 'name', label: 'Item', required: true })}
        ${UI.field({ name: 'area', label: 'Where it is kept', required: true,
    options: meta.areas.map((a) => ({ value: a.code, label: a.label })) })}
        ${UI.field({ name: 'description', label: 'What it is',
    placeholder: 'Size, make, anything that tells one from another' })}
        ${UI.field({ name: 'unit', label: 'Counted in', value: 'Pcs',
    hint: 'Pcs, Box of 100, Roll, Pkt of 50 — whatever a count of it means.' })}
        ${UI.field({ name: 'indentQty', label: 'Should hold', type: 'number' })}
        ${UI.field({ name: 'openingQty', label: 'On the shelf now', type: 'number',
    hint: 'Leave empty if you have not counted it.' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Add it</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return undefined;
        const form = modal.querySelector('#cs-new');
        if (!form.reportValidity()) return 'keep';
        try {
          const made = await API.post('/api/consumables', UI.formValues(form));
          UI.ok(`${made.name} added as ${made.code}.`);
          if (onSaved) await onSaved();
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  function openEditItem(item, onSaved) {
    UI.modal({
      title: `Edit ${item.name}`,
      body: `<form id="cs-edit" class="grid c2">
        ${UI.field({ name: 'name', label: 'Item', value: item.name, required: true })}
        ${UI.field({ name: 'area', label: 'Where it is kept',
    options: meta.areas.map((a) => ({ value: a.code, label: a.label })) })}
        ${UI.field({ name: 'description', label: 'What it is', value: item.description || '' })}
        ${UI.field({ name: 'unit', label: 'Counted in', value: item.unit })}
        ${UI.field({ name: 'indentQty', label: 'Should hold', type: 'number', value: item.indent_qty })}
        ${UI.field({ name: 'reorderAt', label: 'Re-order at', type: 'number',
    value: item.reorder_at === null ? '' : item.reorder_at,
    hint: 'Left empty, a quarter of what it should hold.' })}
      </form>
      <p class="muted small">The quantity on the shelf is not edited here. Record what was
        received, issued or counted and the figure follows from it — that is what keeps a name
        and a date behind every number on this screen.</p>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Save</button>`,
      onMount(modal) { modal.querySelector('[name=area]').value = item.area; },
      async onAction(act, modal) {
        if (act !== 'save') return undefined;
        try {
          await API.patch(`/api/consumables/${item.id}`, UI.formValues(modal.querySelector('#cs-edit')));
          UI.ok('Saved.');
          if (onSaved) await onSaved();
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  // -------------------------------------------------------- a whole delivery
  /**
   * Receiving, as the delivery arrives: one supplier, one invoice, one date,
   * many lines. Typed line by line it is a delivery half typed.
   */
  async function receiveTab(body) {
    const data = await API.get('/api/consumables');
    meta = { areas: data.areas, kinds: data.kinds };
    const all = data.rows;
    const lines = [];

    body.innerHTML = `
      <div class="grid sidebar-right">
        <div class="card"><div class="card-head"><h3>What arrived</h3>
          <input type="search" id="rc-find" placeholder="Find an item…" style="max-width:260px">
        </div>
          <div class="card-body">
            <div id="rc-results" class="mb"></div>
            <div id="rc-lines"></div>
          </div></div>
        <div><div class="card"><div class="card-head"><h3>The delivery</h3></div>
          <div class="card-body">
            <form id="rc-head">
              ${UI.field({ name: 'supplier', label: 'From', placeholder: 'Royal International' })}
              ${UI.field({ name: 'invoiceNo', label: 'Invoice or DC number' })}
              ${UI.field({ name: 'movedOn', label: 'Received on', type: 'date', value: today(), required: true })}
              ${UI.field({ name: 'notes', label: 'Note' })}
            </form>
            <button class="btn block mt" id="rc-save" disabled>Take it in</button>
            <div id="rc-out"></div>
            <p class="muted small mt">Everything taken in here lands on the shelf straight away,
              with your name and the date against it.</p>
          </div></div></div>
      </div>`;

    const drawLines = () => {
      const host = body.querySelector('#rc-lines');
      host.innerHTML = lines.length ? UI.table([
        { label: 'Item', render: (l) => UI.esc(l.name) },
        { label: 'Unit', render: (l) => UI.esc(l.unit) },
        { label: 'Qty', render: (l) => `<input type="number" min="0.01" step="any" value="${l.qty}"
            data-qty="${l.id}" style="max-width:90px">` },
        { label: 'Cost each', render: (l) => `<input type="number" min="0" step="0.01"
            value="${l.unitCost === '' ? '' : l.unitCost}" data-cost="${l.id}"
            placeholder="—" style="max-width:100px">` },
        { label: '', render: (l) => `<button class="btn ghost sm" data-drop="${l.id}">Remove</button>` },
      ], lines) : '<p class="muted">Find the items above and add them.</p>';

      host.querySelectorAll('[data-qty]').forEach((i) => i.addEventListener('input', () => {
        const line = lines.find((l) => String(l.id) === i.dataset.qty);
        if (line) line.qty = i.value;
      }));
      host.querySelectorAll('[data-cost]').forEach((i) => i.addEventListener('input', () => {
        const line = lines.find((l) => String(l.id) === i.dataset.cost);
        if (line) line.unitCost = i.value;
      }));
      host.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
        const at = lines.findIndex((l) => String(l.id) === b.dataset.drop);
        if (at !== -1) lines.splice(at, 1);
        drawLines();
      }));
      body.querySelector('#rc-save').disabled = lines.length === 0;
    };

    const find = body.querySelector('#rc-find');
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase();
      const host = body.querySelector('#rc-results');
      if (q.length < 2) return void (host.innerHTML = '');
      const hits = all.filter((r) => `${r.name} ${r.description || ''} ${r.code}`.toLowerCase()
        .includes(q)).slice(0, 12);
      host.innerHTML = hits.length
        ? hits.map((r) => `<button class="btn ghost sm" data-pick="${r.id}" style="margin:2px">
            ${UI.esc(r.name)} <span class="muted">${UI.esc(r.unit)}</span></button>`).join('')
        : '<span class="muted small">Nothing matches. Add it on the shelf tab first.</span>';
      host.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
        const item = all.find((r) => String(r.id) === b.dataset.pick);
        if (!item || lines.some((l) => l.id === item.id)) return;
        lines.push({ id: item.id, name: item.name, unit: item.unit, qty: 1, unitCost: '' });
        find.value = '';
        host.innerHTML = '';
        drawLines();
      }));
    });

    body.querySelector('#rc-save').addEventListener('click', async () => {
      const head = UI.formValues(body.querySelector('#rc-head'));
      try {
        const out = await API.post('/api/consumables/deliveries', {
          ...head,
          lines: lines.map((l) => ({ itemId: l.id, qty: l.qty, unitCost: l.unitCost })),
        });
        body.querySelector('#rc-out').innerHTML = `<div class="alert ok mt">
          <b>${out.received} item(s) taken in.</b>
          ${out.items.map((i) => `${UI.esc(i.name)} — ${num(i.onHand)}`).join('<br>')}</div>`;
        UI.ok('On the shelf.');
        lines.length = 0;
        drawLines();
      } catch (err) {
        body.querySelector('#rc-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
      }
    });

    drawLines();
  }

  // ----------------------------------------------------------- what went where
  async function usageTab(body) {
    const to = today();
    const from = `${to.slice(0, 7)}-01`;

    body.innerHTML = `
      <div class="card"><div class="card-head"><h3>What went where</h3>
        <input type="date" id="us-from" value="${from}" style="max-width:165px">
        <input type="date" id="us-to" value="${to}" style="max-width:165px">
      </div><div class="card-body" id="us-body">${UI.loading()}</div></div>`;

    const draw = async () => {
      const r = await API.get('/api/consumables/usage' + API.qs({
        from: body.querySelector('#us-from').value,
        to: body.querySelector('#us-to').value,
      }));
      body.querySelector('#us-body').innerHTML = `
        <div class="grid c3 mb">
          <div class="stat"><div class="label">Movements recorded</div>
            <div class="value">${num(r.lines.reduce((t, l) => t + l.entries, 0))}</div>
            <div class="foot">in this window</div></div>
          <div class="stat teal"><div class="label">Spent on supplies</div>
            <div class="value">${money(r.spend)}</div>
            <div class="foot">where a cost was recorded</div></div>
          <div class="stat orange"><div class="label">Issued to the clinic</div>
            <div class="value">${num(Math.abs((r.lines.find((l) => l.kind === 'issue') || {}).qty || 0))}</div>
            <div class="foot">units, across all items</div></div>
        </div>

        <table class="plain small"><thead><tr><th>Movement</th>
          <th class="num">Entries</th><th class="num">Units</th><th class="num">Value</th></tr></thead><tbody>
          ${r.lines.filter((l) => l.entries).map((l) => `<tr>
            <td>${UI.esc(l.label)}</td><td class="num">${num(l.entries)}</td>
            <td class="num">${num(l.qty)}</td>
            <td class="num">${l.value ? money(l.value) : '<span class="muted">—</span>'}</td></tr>`).join('')
  || '<tr><td colspan="4" class="muted">Nothing moved in this window.</td></tr>'}
        </tbody></table>
        <p class="muted small">${UI.esc(r.note)}</p>

        <h4 class="mt">Where it went</h4>
        ${UI.table([
    { label: 'Place', render: (x) => UI.esc(x.place) },
    { label: 'Times', num: true, render: (x) => num(x.lines) },
    { label: 'Units', num: true, render: (x) => num(x.qty) },
  ], r.issuedTo, { emptyText: 'Nothing issued in this window.' })}

        <h4 class="mt">Going fastest</h4>
        ${UI.table([
    { label: 'Item', render: (x) => UI.esc(x.name) },
    { label: 'Unit', render: (x) => UI.esc(x.unit) },
    { label: 'Used', num: true, render: (x) => num(x.qty) },
  ], r.busiest, { emptyText: 'Nothing used in this window.' })}`;
    };

    body.querySelectorAll('#us-from, #us-to').forEach((f) => f.addEventListener('change', draw));
    await draw();
  }
})();
