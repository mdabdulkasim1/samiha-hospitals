/* =============================================================================
   The line editor every document shares.

   A quotation, an LPO, a client's order and an invoice differ in what they
   promise and who signs them; the grid of lines underneath is the same in all
   four — pick an item from the master, say how many, at what rate, and watch
   the 5% VAT and the total move as you type. Written once, here.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  let itemCache = null;

  /** The catalogue, fetched once per sign-in and searched in the browser. */
  async function catalogue(force) {
    if (itemCache && !force) return itemCache;
    const res = await API.get('/api/items?limit=1000&withStock=false');
    itemCache = res.rows;
    return itemCache;
  }

  function search(items, term) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return items.slice(0, 40);
    const words = q.split(/\s+/);
    return items.filter((i) => {
      const hay = `${i.item_code} ${i.name} ${i.size || ''} ${i.material || ''} ${i.brand || ''} `
        + `${i.category_name || ''} ${i.subgroup_name || ''} ${i.application_name || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 40);
  }

  /**
   * An editable set of lines.
   *
   * `side` decides which price the picker fills in: our selling price when we
   * are quoting a client, the last cost when we are buying. `showCost` puts the
   * cost and the margin on screen for the desks allowed to see them.
   */
  function LineEditor(host, {
    side = 'sell', lines = [], showCost = APP.seesCost(), readonly = false, onChange,
  } = {}) {
    const state = {
      rows: lines.length ? lines.map(normalise) : [blank()],
      side,
      showCost: showCost && side === 'sell',
    };

    function blank() {
      return { item_id: null, item_code: '', description: '', application_id: '', qty: 1,
        uom: 'NOS', unit_price: 0, cost_price: 0, discount_percent: 0, remarks: '' };
    }
    function normalise(l) {
      return {
        item_id: l.item_id || null,
        item_code: l.item_code || '',
        description: l.description || '',
        application_id: l.application_id || '',
        qty: Number(l.qty) || 0,
        uom: l.uom || 'NOS',
        unit_price: Number(l.unit_price) || 0,
        cost_price: Number(l.cost_price) || 0,
        // Documents store the discount as an amount; the grid takes a
        // percentage because that is how a discount is actually negotiated.
        discount_percent: l.discount_percent !== undefined
          ? Number(l.discount_percent) || 0
          : (l.qty && l.unit_price ? r2((Number(l.discount) || 0) / (l.qty * l.unit_price) * 100) : 0),
        remarks: l.remarks || '',
      };
    }

    /** The same arithmetic the server does, so the screen never disagrees. */
    function priced(row) {
      const gross = r2(row.qty * row.unit_price);
      const discount = r2(gross * ((Number(row.discount_percent) || 0) / 100));
      const taxable = r2(gross - discount);
      const vat = r2(taxable * (APP.vatPercent / 100));
      return { gross, discount, taxable, vat, total: r2(taxable + vat),
        cost: r2(row.qty * row.cost_price) };
    }

    function totals() {
      return state.rows.reduce((a, row) => {
        const p = priced(row);
        return {
          subtotal: r2(a.subtotal + p.gross),
          discount: r2(a.discount + p.discount),
          taxable: r2(a.taxable + p.taxable),
          vat: r2(a.vat + p.vat),
          total: r2(a.total + p.total),
          cost: r2(a.cost + p.cost),
        };
      }, { subtotal: 0, discount: 0, taxable: 0, vat: 0, total: 0, cost: 0 });
    }

    function render() {
      const apps = APP.applicationOptions();
      const body = state.rows.map((row, i) => {
        const p = priced(row);
        return `<tr data-line="${i}">
          <td class="num muted">${i + 1}</td>
          <td style="min-width:260px">
            <div class="picker">
              <input type="text" data-f="description" value="${esc(row.description)}"
                     placeholder="Search the item master, or type a description" autocomplete="off">
              <div class="picker-list" data-list hidden></div>
            </div>
            <div class="row small muted" style="gap:6px;margin-top:3px">
              <span class="mono" data-code>${esc(row.item_code || '—')}</span>
              <select data-f="application_id" style="width:auto;padding:2px 4px;font-size:11px">
                <option value="">Application…</option>
                ${apps.map((a) => `<option value="${a.value}"${String(a.value) === String(row.application_id) ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
              </select>
            </div>
          </td>
          <td><input class="qty" type="number" step="0.001" min="0" data-f="qty" value="${row.qty}"></td>
          <td><input style="width:74px" data-f="uom" value="${esc(row.uom)}"></td>
          ${state.showCost ? `<td><input class="rate" type="number" step="0.01" min="0" data-f="cost_price" value="${row.cost_price}"></td>` : ''}
          <td><input class="rate" type="number" step="0.01" min="0" data-f="unit_price" value="${row.unit_price}"></td>
          <td><input class="disc" type="number" step="0.01" min="0" max="100" data-f="discount_percent" value="${row.discount_percent}"></td>
          <td class="num" data-vat>${UI.money(p.vat, { symbol: false })}</td>
          <td class="num line-total" data-total>${UI.money(p.total, { symbol: false })}</td>
          <td><button type="button" class="btn ghost sm" data-drop="${i}" title="Remove this line">×</button></td>
        </tr>`;
      }).join('');

      const t = totals();
      host.innerHTML = `
        <div class="lines table-wrap">
          <table>
            <thead><tr>
              <th class="num">#</th><th>Item / description</th><th class="num">Qty</th><th>Unit</th>
              ${state.showCost ? '<th class="num">Cost</th>' : ''}
              <th class="num">Rate</th><th class="num">Disc %</th>
              <th class="num">VAT ${APP.vatPercent}%</th><th class="num">Amount</th><th></th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${readonly ? '' : '<div class="btn-row mt"><button type="button" class="btn ghost sm" data-add>+ Add a line</button></div>'}
        <div class="doc-footer"><table>
          <tr><td class="muted">Sub-total</td><td class="num" data-t="subtotal">${UI.money(t.subtotal, { symbol: false })}</td></tr>
          <tr><td class="muted">Discount</td><td class="num" data-t="discount">${UI.money(t.discount, { symbol: false })}</td></tr>
          <tr><td class="muted">Taxable</td><td class="num" data-t="taxable">${UI.money(t.taxable, { symbol: false })}</td></tr>
          <tr><td class="muted">VAT @ ${APP.vatPercent}%</td><td class="num" data-t="vat">${UI.money(t.vat, { symbol: false })}</td></tr>
          <tr class="grand"><td>Total</td><td class="num" data-t="total">${UI.money(t.total, { symbol: false })}</td></tr>
          ${state.showCost ? `<tr><td class="muted small">Cost / margin</td>
            <td class="num small" data-t="margin">${marginText(t)}</td></tr>` : ''}
        </table></div>`;

      wire();
    }

    function marginText(t) {
      const profit = r2(t.taxable - t.cost);
      const pct = t.taxable ? r2((profit / t.taxable) * 100) : 0;
      return `${UI.money(t.cost, { symbol: false })} · <b>${UI.money(profit, { symbol: false })} (${pct}%)</b>`;
    }

    /** Repaint only the figures — retyping the grid would eat the caret. */
    function refreshTotals() {
      state.rows.forEach((row, i) => {
        const tr = host.querySelector(`tr[data-line="${i}"]`);
        if (!tr) return;
        const p = priced(row);
        tr.querySelector('[data-vat]').textContent = UI.money(p.vat, { symbol: false });
        tr.querySelector('[data-total]').textContent = UI.money(p.total, { symbol: false });
        tr.querySelector('[data-code]').textContent = row.item_code || '—';
      });
      const t = totals();
      for (const key of ['subtotal', 'discount', 'taxable', 'vat', 'total']) {
        const cell = host.querySelector(`[data-t="${key}"]`);
        if (cell) cell.textContent = UI.money(t[key], { symbol: false });
      }
      const m = host.querySelector('[data-t="margin"]');
      if (m) m.innerHTML = marginText(t);
      if (onChange) onChange(t, state.rows);
    }

    function wire() {
      if (readonly) {
        host.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
        return;
      }
      const add = host.querySelector('[data-add]');
      if (add) add.addEventListener('click', () => { state.rows.push(blank()); render(); });

      host.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
        const i = Number(b.dataset.drop);
        state.rows.splice(i, 1);
        if (!state.rows.length) state.rows.push(blank());
        render();
      }));

      host.querySelectorAll('tr[data-line]').forEach((tr) => {
        const i = Number(tr.dataset.line);
        tr.querySelectorAll('[data-f]').forEach((el) => {
          el.addEventListener('input', () => {
            const f = el.dataset.f;
            state.rows[i][f] = ['qty', 'unit_price', 'cost_price', 'discount_percent'].includes(f)
              ? Number(el.value) || 0 : el.value;
            // Typing over a picked item's description unpicks it: the line is
            // then a free-text charge, not that item.
            if (f === 'description' && state.rows[i].item_id) {
              const picked = (itemCache || []).find((x) => x.id === state.rows[i].item_id);
              if (picked && el.value !== state.rows[i].description) {
                // keep the code — an edited description of the same item is fine
              }
            }
            refreshTotals();
          });
        });
        wirePicker(tr, i);
      });
    }

    function wirePicker(tr, index) {
      const input = tr.querySelector('[data-f="description"]');
      const list = tr.querySelector('[data-list]');
      let items = itemCache || [];

      const close = () => { list.hidden = true; list.innerHTML = ''; };
      const open = async () => {
        items = await catalogue();
        const found = search(items, input.value);
        if (!found.length) return close();
        list.innerHTML = found.map((it, n) => `
          <button type="button" data-pick="${it.id}" class="${n === 0 ? 'on' : ''}">
            <span class="code">${esc(it.item_code)}</span> ${esc(it.name)}
            <span class="meta">${[it.size, it.material, it.pressure_class, it.application_name]
              .filter(Boolean).map(esc).join(' · ')}${
              APP.seesPrices() && it.sell_price ? ' — ' + UI.money(it.sell_price) : ''}</span>
          </button>`).join('');
        list.hidden = false;
        list.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const it = items.find((x) => String(x.id) === b.dataset.pick);
          if (!it) return;
          const row = state.rows[index];
          row.item_id = it.id;
          row.item_code = it.item_code;
          row.description = [it.name, it.size, it.material, it.pressure_class, it.standard]
            .filter(Boolean).join(' · ');
          row.uom = it.uom || 'NOS';
          row.application_id = it.application_id || '';
          if (state.side === 'sell') {
            row.unit_price = Number(it.sell_price) || 0;
            row.cost_price = Number(it.cost_price) || 0;
          } else {
            row.unit_price = Number(it.cost_price) || 0;
          }
          close();
          render();
        }));
      };

      input.addEventListener('focus', open);
      input.addEventListener('input', open);
      input.addEventListener('blur', () => setTimeout(close, 120));
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }

    render();

    return {
      /** The lines in the shape the API takes them. */
      value() {
        return state.rows
          .filter((r) => r.description && Number(r.qty) > 0)
          .map((r) => ({
            item_id: r.item_id || null,
            item_code: r.item_code || null,
            description: r.description,
            application_id: r.application_id || null,
            qty: r.qty,
            uom: r.uom,
            unit_price: r.unit_price,
            cost_price: r.cost_price,
            discount_percent: r.discount_percent,
            remarks: r.remarks || null,
          }));
      },
      totals,
      /** Replace the lines — used when a quotation is copied into an order. */
      set(rows) { state.rows = rows.length ? rows.map(normalise) : [blank()]; render(); },
      rows: () => state.rows,
    };
  }

  window.LINES = { LineEditor, catalogue, search, refresh: () => catalogue(true) };
})();
