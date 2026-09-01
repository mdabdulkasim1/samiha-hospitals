/* Pharmacy: dispensing queue, stock, and the drug formulary. */
(function () {
  'use strict';

  APP.register('pharmacy', {
    title: 'Pharmacy',
    subtitle: 'Dispensing, stock and formulary',

    async render(el, params) {
      if (params.visitId) return renderDispense(el, Number(params.visitId));

      const [queue, alerts] = await Promise.all([
        API.get('/api/pharmacy/queue'),
        API.get('/api/pharmacy/stock/alerts'),
      ]);

      el.innerHTML = `
        <div class="grid c3 mb">
          <div class="stat crimson"><div class="label">Waiting to be dispensed</div>
            <div class="value">${UI.num(queue.length)}</div><div class="foot">Prescriptions from today</div></div>
          <div class="stat orange"><div class="label">At or below reorder level</div>
            <div class="value">${UI.num(alerts.lowStock.length)}</div><div class="foot">Raise a purchase order</div></div>
          <div class="stat teal"><div class="label">Expiring within 90 days</div>
            <div class="value">${UI.num(alerts.expiringSoon.length)}</div><div class="foot">Batches to rotate</div></div>
        </div>

        <div class="tabs" id="ph-tabs">
          <button class="active" data-tab="queue">Dispensing queue</button>
          <button data-tab="stock">Stock &amp; alerts</button>
          <button data-tab="formulary">Formulary</button>
        </div>
        <div id="ph-body"></div>`;

      const body = el.querySelector('#ph-body');

      const tabs = {
        queue() {
          body.innerHTML = `<div class="card"><div class="card-head"><h3>Prescriptions to dispense</h3></div>
            <div class="card-body tight" id="q-list"></div></div>`;
          const host = body.querySelector('#q-list');
          host.innerHTML = UI.table([
            { label: 'Token', render: (r) => `<span class="badge crimson">#${UI.esc(r.token_no || '—')}</span>` },
            { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient_name)}</b><div class="muted small">${UI.esc(r.uhid)}</div>` },
            { label: 'Visit', key: 'visit_no' },
            { label: 'Doctor', render: (r) => UI.esc(r.doctor_name || '—') },
            { label: 'Items', num: true, render: (r) => UI.esc(r.pending_items) },
            { label: 'Flags', render: (r) => r.allergies ? UI.badge('⚠ Allergy', 'danger') : '' },
            { label: '', render: (r) => `<button class="btn sm" data-open="${r.visit_id}">Dispense</button>` },
          ], queue, { emptyText: 'Nothing waiting at the pharmacy counter.' });
          host.querySelectorAll('[data-open]').forEach((b) =>
            b.addEventListener('click', () => APP.navigate('pharmacy', { visitId: b.dataset.open })));
        },

        stock() {
          body.innerHTML = `
            <div class="grid c2">
              <div class="card"><div class="card-head"><h3>Low stock</h3>
                ${APP.can(['pharmacy']) ? '<button class="btn ghost sm" id="receive">+ Receive stock</button>' : ''}</div>
                <div class="card-body tight">${UI.table([
                  { label: 'Medicine', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.strength || '')} ${UI.esc(d.form || '')}</div>` },
                  { label: 'On hand', num: true, render: (d) => `<b style="color:var(--danger)">${UI.esc(d.on_hand)}</b>` },
                  { label: 'Reorder at', num: true, render: (d) => UI.esc(d.reorder_level) },
                ], alerts.lowStock, { emptyText: 'All medicines are above their reorder level.' })}</div>
              </div>
              <div class="card"><div class="card-head"><h3>Expiring soon</h3></div>
                <div class="card-body tight">${UI.table([
                  { label: 'Medicine', render: (b) => `<b>${UI.esc(b.drug_name)}</b><div class="muted small">Batch ${UI.esc(b.batch_no)}</div>` },
                  { label: 'Expiry', render: (b) => UI.esc(UI.date(b.expiry_date)) },
                  { label: 'Qty', num: true, render: (b) => UI.esc(b.qty_available) },
                ], alerts.expiringSoon, { emptyText: 'No batch expires within 90 days.' })}</div>
              </div>
            </div>`;
          const rec = body.querySelector('#receive');
          if (rec) rec.addEventListener('click', openReceive);
        },

        async formulary() {
          body.innerHTML = `<div class="card">
            <div class="card-head"><h3>Drug formulary</h3>
              <input type="search" id="dq" placeholder="Search medicines…" style="max-width:260px">
              ${APP.can(['pharmacy']) ? '<button class="btn ghost sm" id="add-drug">+ Add medicine</button>' : ''}</div>
            <div class="card-body tight" id="d-list">${UI.loading()}</div></div>`;
          const load = async () => {
            const drugs = await API.get('/api/pharmacy/drugs' + API.qs({ q: body.querySelector('#dq').value.trim(), limit: 200 }));
            body.querySelector('#d-list').innerHTML = UI.table([
              { label: 'Code', render: (d) => `<code>${UI.esc(d.code)}</code>` },
              { label: 'Medicine', render: (d) => `<b>${UI.esc(d.name)}</b><div class="muted small">${UI.esc(d.generic_name || '')}</div>` },
              { label: 'Form', render: (d) => `${UI.esc(d.strength || '')} ${UI.esc(d.form || '')}` },
              { label: 'Schedule', render: (d) => d.schedule_type ? UI.badge(d.schedule_type, d.schedule_type === 'H' ? 'warn' : '') : '—' },
              { label: 'MRP', num: true, render: (d) => UI.money(d.mrp) },
              { label: 'On hand', num: true, render: (d) => d.on_hand <= d.reorder_level
                ? `<b style="color:var(--danger)">${UI.esc(d.on_hand)}</b>` : UI.esc(d.on_hand) },
              { label: 'Next expiry', render: (d) => d.next_expiry ? UI.esc(UI.date(d.next_expiry)) : '—' },
            ], drugs, { emptyText: 'No medicine matched.' });
          };
          let t;
          body.querySelector('#dq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
          const add = body.querySelector('#add-drug');
          if (add) add.addEventListener('click', openAddDrug);
          await load();
        },
      };

      el.querySelectorAll('#ph-tabs button').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('#ph-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        tabs[b.dataset.tab]();
      }));
      tabs.queue();
    },
  });

  // ------------------------------------------------------------- dispensing
  async function renderDispense(el, visitId) {
    const data = await API.get(`/api/pharmacy/prescriptions/${visitId}`);
    const visit = data.visit;
    APP.setSubtitle(`${visit.patient_name} · ${visit.uhid} · ${visit.visit_no}`);
    APP.actions([{ id: 'back', label: '← Pharmacy queue', onClick: () => APP.navigate('pharmacy') }]);

    el.innerHTML = `
      ${visit.allergies ? `<div class="alert danger">⚠ <b>Allergies:</b> ${UI.esc(visit.allergies)} — check every item before dispensing.</div>` : ''}
      <div class="card">
        <div class="card-head"><h3>Prescription</h3><span class="muted small">Tick what you are handing over</span></div>
        <div class="card-body tight">
          <div class="table-wrap"><table><thead><tr>
            <th></th><th>Medicine</th><th>Dose &amp; frequency</th><th class="num">Prescribed</th>
            <th class="num">Already given</th><th class="num">Dispense now</th><th class="num">Stock</th><th>Status</th>
          </tr></thead><tbody>
            ${data.prescriptions.map((p) => {
              const remaining = Math.max((p.quantity || 0) - (p.dispensed_qty || 0), 0);
              const canGive = p.drug_id && remaining > 0 && p.on_hand > 0;
              return `<tr>
                <td><input type="checkbox" data-rx="${p.id}" data-drug="${p.drug_id || ''}"${canGive ? ' checked' : ' disabled'}></td>
                <td><b>${UI.esc(p.drug_name)}</b><div class="muted small">${UI.esc(p.master_name ? p.strength || '' : 'not in formulary')}</div></td>
                <td>${UI.esc(p.dose || '')} ${UI.esc(p.frequency || '')} · ${UI.esc(p.duration_days || '?')} days
                  ${p.instructions ? `<div class="muted small">${UI.esc(p.instructions)}</div>` : ''}</td>
                <td class="num">${UI.esc(p.quantity || 0)}</td>
                <td class="num">${UI.esc(p.dispensed_qty || 0)}</td>
                <td class="num"><input type="number" data-qty="${p.id}" value="${canGive ? Math.min(remaining, p.on_hand) : 0}"
                  min="0" max="${Math.min(remaining, p.on_hand)}" style="width:80px;text-align:right"${canGive ? '' : ' disabled'}></td>
                <td class="num">${p.on_hand <= 0 ? '<b style="color:var(--danger)">0</b>' : UI.esc(p.on_hand)}</td>
                <td>${UI.statusBadge(p.status)}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="8">' + UI.empty('No prescription for this visit.', '💊') + '</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card-body">
          <div class="grid c3">
            ${UI.field({ name: 'discount', label: 'Discount on this bill', type: 'number', min: 0, value: 0 })}
            <div></div>
            <div style="display:flex;align-items:flex-end">
              <button class="btn block" id="do-dispense">Dispense &amp; bill</button>
            </div>
          </div>
          <div id="disp-out"></div>
        </div>
      </div>`;

    el.querySelector('#do-dispense').addEventListener('click', async (e) => {
      const items = [...el.querySelectorAll('[data-rx]:checked')].map((cb) => {
        const id = cb.dataset.rx;
        return {
          prescriptionId: Number(id),
          drugId: Number(cb.dataset.drug),
          qty: Number(el.querySelector(`[data-qty="${id}"]`).value),
        };
      }).filter((i) => i.qty > 0 && i.drugId);

      if (!items.length) return UI.err('Select at least one medicine with a quantity.');

      e.target.disabled = true;
      const send = async (acknowledge) => API.post('/api/pharmacy/dispense', {
        patientId: visit.patient_id, visitId,
        discount: Number(el.querySelector('[name=discount]').value || 0),
        items, acknowledgeWarnings: acknowledge,
      });

      try {
        let res;
        try {
          res = await send(false);
        } catch (err) {
          if (err.status === 409 && /Safety check/.test(err.message)) {
            if (!(await UI.confirm(err.message, { title: 'Safety check', danger: true }))) { e.target.disabled = false; return; }
            res = await send(true);
          } else throw err;
        }
        el.querySelector('#disp-out').innerHTML = `<div class="alert ok mt">
          <b>Dispensed.</b> Bill ${UI.esc(res.sale.bill_no)} for ${UI.money(res.sale.net)} added to invoice
          ${UI.esc(res.invoice.invoice_no)} (balance ${UI.money(res.invoice.balance)}).</div>`;
        UI.ok('Medicines dispensed and added to the bill.');
        setTimeout(() => APP.navigate('pharmacy'), 1600);
      } catch (err) {
        UI.err(err.message);
        e.target.disabled = false;
      }
    });
  }

  function openReceive() {
    API.get('/api/pharmacy/drugs?limit=300').then((drugs) => {
      UI.modal({
        title: 'Receive stock',
        body: `<form id="rc-form">
          ${UI.field({ name: 'drugId', label: 'Medicine', required: true,
            options: [{ value: '', label: '— select —' }].concat(drugs.map((d) =>
              ({ value: d.id, label: `${d.name} ${d.strength || ''} — on hand ${d.on_hand}` }))) })}
          <div class="grid c2">
            ${UI.field({ name: 'batchNo', label: 'Batch number', required: true })}
            ${UI.field({ name: 'expiryDate', label: 'Expiry date', type: 'date', required: true })}
          </div>
          <div class="grid c3">
            ${UI.field({ name: 'qty', label: 'Quantity', type: 'number', min: 1, required: true })}
            ${UI.field({ name: 'mrp', label: 'MRP per unit', type: 'number', step: '0.01' })}
            ${UI.field({ name: 'purchasePrice', label: 'Cost per unit', type: 'number', step: '0.01' })}
          </div>
          ${UI.field({ name: 'supplier', label: 'Supplier' })}
        </form>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Receive</button>`,
        async onAction(act, modal) {
          if (act !== 'save') return;
          const form = modal.querySelector('#rc-form');
          if (!form.reportValidity()) return 'keep';
          await API.post('/api/pharmacy/stock/receive', UI.formValues(form));
          UI.ok('Stock received.');
          APP.reload();
        },
      });
    });
  }

  function openAddDrug() {
    UI.modal({
      title: 'Add a medicine to the formulary',
      body: `<form id="ad-form">
        <div class="grid c2">
          ${UI.field({ name: 'code', label: 'Code', required: true })}
          ${UI.field({ name: 'name', label: 'Brand name', required: true })}
        </div>
        <div class="grid c3">
          ${UI.field({ name: 'genericName', label: 'Generic name' })}
          ${UI.field({ name: 'form', label: 'Form', options: ['tablet','capsule','syrup','injection','ointment','drops','sachet','inhaler'] })}
          ${UI.field({ name: 'strength', label: 'Strength' })}
        </div>
        <div class="grid c4">
          ${UI.field({ name: 'mrp', label: 'MRP', type: 'number', step: '0.01' })}
          ${UI.field({ name: 'purchasePrice', label: 'Cost', type: 'number', step: '0.01' })}
          ${UI.field({ name: 'taxPct', label: 'GST %', type: 'number', value: 12 })}
          ${UI.field({ name: 'reorderLevel', label: 'Reorder level', type: 'number', value: 20 })}
        </div>
        <div class="grid c2">
          ${UI.field({ name: 'manufacturer', label: 'Manufacturer' })}
          ${UI.field({ name: 'scheduleType', label: 'Schedule', options: ['', 'OTC', 'H', 'H1', 'X'] })}
        </div>
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button><button class="btn" data-act="save">Add</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#ad-form');
        if (!form.reportValidity()) return 'keep';
        await API.post('/api/pharmacy/drugs', UI.formValues(form));
        UI.ok('Medicine added to the formulary.');
        APP.reload();
      },
    });
  }
})();
