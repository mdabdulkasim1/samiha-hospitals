/*
 * The two things every bill in the clinic needs: a quick way to put a charge
 * on it, and a way to take something off before it is printed.
 *
 * Out-patient and in-patient bills are assembled at different desks and end up
 * in different places — an OPD charge goes straight onto the visit invoice, an
 * in-patient's onto the admission's charge sheet to be posted at discharge —
 * but the cashier's half of the job is identical, so it lives here once. The
 * caller says where a charge should go; this decides nothing about billing.
 */
(function () {
  'use strict';

  // Fetched once per session. The tariff changes when management changes it,
  // not while a bill is being made up, and re-fetching it for every bill would
  // put a hundred rows on the wire each time a desk opens a screen.
  let catalogue = null;

  async function loadCatalogue() {
    if (!catalogue) catalogue = await API.get('/api/masters/catalogue');
    return catalogue;
  }

  /** Drop the cached tariff, so a rate just edited is picked up. */
  function forgetCatalogue() { catalogue = null; }

  /**
   * The charge board: the groups as chips, then that group's items as buttons
   * with the rate on them. One press hands the item to `onAdd`.
   *
   * A desk keys in the same half-dozen charges all day, and hunting for each
   * one through a dropdown of a hundred was the slow part of the screen.
   */
  async function quickAdd(host, { onAdd, note } = {}) {
    let groups;
    try { groups = await loadCatalogue(); }
    catch (err) { host.innerHTML = `<div class="alert warn">${UI.esc(err.message)}</div>`; return; }

    if (!groups.length) {
      host.innerHTML = UI.empty('No services are set up yet. Add them under Services & Rates.', '₨');
      return;
    }

    let open = groups[0].group;

    const paint = () => {
      const group = groups.find((g) => g.group === open) || groups[0];
      host.innerHTML = `
        ${note ? `<div class="muted small mb">${note}</div>` : ''}
        <div class="chip-row mb">
          ${groups.map((g) => `<button type="button" class="chip${g.group === open ? ' on' : ''}"
            data-group="${UI.esc(g.group)}">${UI.esc(g.group)}
            <span class="chip-n">${UI.num(g.items.length)}</span></button>`).join('')}
        </div>
        <div class="item-grid">
          ${group.items.map((i) => `<button type="button" class="item-btn"
              data-kind="${i.kind}" data-id="${i.id}"
              data-name="${UI.esc(i.name)}" data-price="${i.price || 0}" data-tax="${i.tax_pct || 0}">
            <span class="item-name">${UI.esc(i.name)}</span>
            <span class="item-rate">${i.price ? UI.money(i.price) : 'no rate set'}</span>
          </button>`).join('')}
        </div>`;

      host.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
        open = b.dataset.group;
        paint();
      }));

      host.querySelectorAll('.item-btn').forEach((b) => b.addEventListener('click', async () => {
        const item = {
          kind: b.dataset.kind,
          id: Number(b.dataset.id),
          name: b.dataset.name,
          price: Number(b.dataset.price),
          taxPct: Number(b.dataset.tax),
        };
        // An item nobody has priced would go on the bill as nothing at all,
        // which is worse than refusing: it looks charged and is not.
        if (!item.price) {
          return UI.warn(`${item.name} has no rate set. Set one under Services & Rates first.`);
        }
        /*
         * Held down only while the charge is being put on the bill, so a slow
         * network cannot be double-pressed into two of the same line. It comes
         * back either way: a desk billing four dressings presses the same
         * button four times, and a button that stayed dead after the first
         * would look broken.
         */
        b.disabled = true;
        try {
          await onAdd(item);
        } catch (err) {
          UI.err(err.message);
        } finally {
          b.disabled = false;
        }
      }));
    };

    paint();
  }

  /** What the patient would be asked for, before any bill-level discount. */
  function chargeable(inv) {
    return Math.round((inv.gross - inv.discount - inv.sliding_discount
      - inv.assistance_covered - inv.insurance_covered + inv.tax) * 100) / 100;
  }

  /**
   * The discount the cashier gives before printing. Offered both ways because
   * a desk thinks in both — "give him fifty rupees off" and "ten percent for
   * staff" — and the bill records the rupees either way.
   */
  function discount(inv, refresh, { note } = {}) {
    const base = chargeable(inv);

    UI.modal({
      title: 'Give a discount', size: 'narrow',
      body: `${note ? `<div class="alert warn">${note}</div>` : ''}
        <div class="alert info">Bill before any discount: <b>${UI.money(base)}</b>
          ${inv.paid ? `<div class="small mt">${UI.money(inv.paid)} has already been paid, so at most
            <b>${UI.money(Math.max(base - inv.paid, 0))}</b> can be taken off here.</div>` : ''}</div>
        <form id="disc-form">
          ${UI.field({ name: 'mode', label: 'Give it as', value: 'amount',
            options: [{ value: 'amount', label: 'Rupees off' }, { value: 'pct', label: 'A percentage' }] })}
          ${UI.field({ name: 'value', label: 'Amount', type: 'number', step: '0.01', min: '0',
            value: inv.bill_discount || 0, required: true })}
          ${UI.field({ name: 'reason', label: 'Why', rows: 2,
            placeholder: 'Staff concession, goodwill, rounding — it goes on the record, not the bill' })}
        </form>
        <div class="muted small mt" id="disc-preview"></div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Apply discount</button>`,
      onMount(modal) {
        const mode = modal.querySelector('[name=mode]');
        const value = modal.querySelector('[name=value]');
        const preview = modal.querySelector('#disc-preview');
        const show = () => {
          const v = Number(value.value) || 0;
          const off = mode.value === 'pct' ? base * (v / 100) : v;
          preview.innerHTML = off > base
            ? '<b style="color:var(--danger)">That is more than the bill.</b>'
            : `Patient pays <b>${UI.money(Math.max(base - off, 0))}</b> after a discount of ${UI.money(off)}.`;
        };
        mode.addEventListener('change', () => {
          value.step = mode.value === 'pct' ? '0.5' : '0.01';
          value.max = mode.value === 'pct' ? '100' : '';
          show();
        });
        value.addEventListener('input', show);
        show();
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#disc-form');
        if (!form.reportValidity()) return 'keep';
        const v = UI.formValues(form);
        const payload = { reason: v.reason };
        if (v.mode === 'pct') payload.pct = Number(v.value);
        else payload.amount = Number(v.value);
        const updated = await API.post(`/api/billing/invoices/${inv.id}/bill-discount`, payload);
        UI.ok(Number(updated.bill_discount)
          ? `Discount of ${UI.money(updated.bill_discount)} applied — ${UI.money(updated.net)} to pay.`
          : 'Discount removed.');
        if (refresh) refresh();
      },
    });
  }

  /** The concession lines every bill shows the same way. */
  function concessionLines(inv, cls = 'row-between') {
    return `
      ${inv.discount ? `<div class="${cls}"><span>Line discounts</span><span>− ${UI.money(inv.discount)}</span></div>` : ''}
      ${inv.bill_discount ? `<div class="${cls}" style="color:var(--orange-dark)">
        <span>Discount${inv.bill_discount_reason ? ` — ${UI.esc(inv.bill_discount_reason)}` : ''}</span>
        <span>− ${UI.money(inv.bill_discount)}</span></div>` : ''}`;
  }

  window.BillingTools = { quickAdd, discount, chargeable, concessionLines, loadCatalogue, forgetCatalogue };
})();
