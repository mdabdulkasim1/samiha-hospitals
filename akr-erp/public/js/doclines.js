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
        uom: 'NOS', unit_price: 0, cost_price: 0, discount_percent: 0, remarks: '',
        cost_build: null };
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
        // How the rate was arrived at, where somebody built one. Internal: it
        // is never printed and never leaves this grid except onto the line.
        cost_build: l.cost_build && l.cost_build.components
          ? { material: l.cost_build.material_rate !== undefined
                ? l.cost_build.material_rate : l.cost_build.material,
              profit_percent: l.cost_build.profit_percent || 0,
              components: (l.cost_build.components || l.cost_build.steps || [])
                .map((c) => ({ label: c.label, basis: c.basis, value: c.value })) }
          : null,
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
          <td>
            <input class="rate" type="number" step="0.01" min="0" data-f="unit_price" value="${row.unit_price}">
            ${state.side === 'sell' && !readonly ? `<button type="button" class="link-btn small"
              data-build="${i}" title="Work this rate out from the maker's price and the charges on it"
              >${row.cost_build ? 'rate built ✎' : 'build the rate'}</button>` : ''}
          </td>
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

      host.querySelectorAll('[data-build]').forEach((b) => b.addEventListener('click', () => {
        const i = Number(b.dataset.build);
        openRateBuilder(state.rows[i], (built) => {
          state.rows[i].unit_price = built.rate;
          // What the goods cost us, all in, is the landed cost — which is what
          // the margin on this quotation should be read against.
          state.rows[i].cost_price = built.landed_cost;
          state.rows[i].cost_build = {
            material: built.material_rate,
            profit_percent: built.profit_percent,
            components: built.steps.map((c) => ({ label: c.label, basis: c.basis, value: c.value })),
          };
          render();
        });
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
            cost_build: r.cost_build || null,
          }));
      },
      totals,
      /** Replace the lines — used when a quotation is copied into an order. */
      set(rows) { state.rows = rows.length ? rows.map(normalise) : [blank()]; render(); },
      rows: () => state.rows,
    };
  }


  /* ==========================================================================
     The rate builder.

     What a client is quoted is not what the manufacturer charges. It is that
     price plus what it costs to land the material — shipping, customs duty,
     the freight, an allowance for risk, the bank's charge — and then the margin
     the company wants. The desk does this on paper today; here it is done with
     the working kept, so the next person can see how a rate was reached.

     None of it is printed. The client's quotation shows the rate and nothing
     behind it, which is why this can hold what it holds.
     ====================================================================== */
  const BASIS_LABEL = {
    percent_of_material: '% of the material rate',
    percent_of_running: '% of the running total',
    per_unit: 'amount per unit',
    lump_sum: 'lump sum for the line',
  };

  let suggestedCharges = null;

  async function openRateBuilder(row, apply) {
    if (!suggestedCharges) {
      suggestedCharges = (await API.get('/api/sales/costing/charges')).suggested;
    }
    // What is already on the line, or the charges this trade meets on most
    // jobs, ready to be filled in or thrown away.
    const start = row.cost_build || {
      material: row.cost_price || 0,
      profit_percent: 0,
      components: suggestedCharges.map((c) => ({ ...c, value: 0 })),
    };
    const state = {
      material: start.material || 0,
      qty: row.qty || 1,
      profit_percent: start.profit_percent || 0,
      components: (start.components || []).map((c) => ({ ...c })),
    };

    const chargeRow = (c, i) => `<tr data-charge="${i}">
      <td><input data-c="label" value="${esc(c.label || '')}" placeholder="What the charge is"></td>
      <td><select data-c="basis">
        ${Object.entries(BASIS_LABEL).map(([k, label]) => `<option value="${k}"${
          k === c.basis ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select></td>
      <td><input class="rate" type="number" step="0.01" data-c="value" value="${c.value || 0}"></td>
      <td class="num" data-per-unit>—</td>
      <td><button type="button" class="btn ghost sm" data-drop-charge="${i}">×</button></td>
    </tr>`;

    UI.modal({
      title: 'Build the rate',
      size: 'wide',
      body: `<div class="muted small mb">Internal only — none of this is printed on the quotation.
        The client sees the rate; this is how it was reached.</div>
        <div class="grid g3">
          ${UI.field({ name: 'material', label: "Manufacturer's material rate", type: 'number',
            step: '0.01', value: state.material, hint: 'Per unit, as they quoted it.' })}
          ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', step: '0.001',
            value: state.qty, hint: 'A lump sum is divided over this.' })}
          ${UI.field({ name: 'profit_percent', label: 'Profit %', type: 'number', step: '0.01',
            value: state.profit_percent, hint: 'Added to the landed cost.' })}
        </div>
        <h4 class="mt">Charges on top</h4>
        <div class="muted small mb">In the order they are applied — a charge reckoned on the running
          total counts everything above it.</div>
        <div class="lines table-wrap"><table>
          <thead><tr><th>Charge</th><th>How it is reckoned</th><th class="num">Value</th>
            <th class="num">Per unit</th><th></th></tr></thead>
          <tbody id="charges">${state.components.map(chargeRow).join('')}</tbody>
        </table></div>
        <div class="btn-row mt"><button type="button" class="btn ghost sm" id="add-charge">
          + Add a charge</button></div>
        <div class="doc-footer mt"><table id="build-out"></table></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        <button class="btn" data-act="use">Use this rate</button>`,
      onMount(modal) {
        let built = null;
        let timer = null;

        const paint = () => {
          const out = modal.querySelector('#build-out');
          if (!built) { out.innerHTML = ''; return; }
          built.steps.forEach((step, i) => {
            const cell = modal.querySelector(`tr[data-charge="${i}"] [data-per-unit]`);
            if (cell) cell.textContent = UI.money(step.per_unit, { symbol: false });
          });
          out.innerHTML = `
            <tr><td class="muted">Material</td><td class="num">${UI.money(built.material_rate, { symbol: false })}</td></tr>
            <tr><td class="muted">Charges on it</td><td class="num">${UI.money(built.charges_per_unit, { symbol: false })}</td></tr>
            <tr><td class="muted"><b>Landed cost, per unit</b></td>
              <td class="num"><b>${UI.money(built.landed_cost, { symbol: false })}</b></td></tr>
            <tr><td class="muted">Profit @ ${built.profit_percent}%</td>
              <td class="num">${UI.money(built.profit_per_unit, { symbol: false })}</td></tr>
            <tr class="grand"><td>Rate to quote</td>
              <td class="num">${UI.money(built.rate, { symbol: false })}</td></tr>
            <tr><td class="muted small">On ${UI.qty(built.qty)} — cost / profit / value</td>
              <td class="num small">${UI.money(built.line_cost, { symbol: false })} ·
                ${UI.money(built.line_profit, { symbol: false })} ·
                <b>${UI.money(built.line_total, { symbol: false })}</b>
                <div class="muted">margin ${built.margin_percent}%</div></td></tr>`;
        };

        const recalc = async () => {
          built = await API.post('/api/sales/costing', {
            material: state.material, qty: state.qty,
            profit_percent: state.profit_percent, components: state.components,
          });
          paint();
        };
        const soon = () => { clearTimeout(timer); timer = setTimeout(recalc, 220); };

        const wireCharges = () => {
          modal.querySelectorAll('[data-charge]').forEach((tr) => {
            const i = Number(tr.dataset.charge);
            tr.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('input', () => {
              const f = el.dataset.c;
              state.components[i][f] = f === 'value' ? Number(el.value) || 0 : el.value;
              soon();
            }));
          });
          modal.querySelectorAll('[data-drop-charge]').forEach((b) => b.addEventListener('click', () => {
            state.components.splice(Number(b.dataset.dropCharge), 1);
            redrawCharges();
          }));
        };
        const redrawCharges = () => {
          modal.querySelector('#charges').innerHTML = state.components.map(chargeRow).join('');
          wireCharges();
          recalc();
        };

        modal.querySelectorAll('[name=material], [name=qty], [name=profit_percent]')
          .forEach((el) => el.addEventListener('input', () => {
            state[el.name] = Number(el.value) || 0;
            soon();
          }));
        modal.querySelector('#add-charge').addEventListener('click', () => {
          state.components.push({ label: '', basis: 'per_unit', value: 0 });
          redrawCharges();
        });
        wireCharges();
        recalc();
        modal._built = () => built;
      },
      async onAction(act, modal) {
        if (act !== 'use') return;
        const built = modal._built && modal._built();
        if (!built) return 'keep';
        if (!built.rate) {
          UI.err('There is no rate yet — put the material price in first.');
          return 'keep';
        }
        apply(built);
      },
    });
  }

  window.LINES = { LineEditor, catalogue, search, openRateBuilder,
    refresh: () => catalogue(true) };
})();
