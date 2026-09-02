/* The clinic's tariff: what every billable item costs. */
(function () {
  'use strict';

  APP.register('rates', {
    title: 'Services & Rates',
    subtitle: 'What the clinic charges, group by group',

    async render(el) {
      const groups = await API.get('/api/masters/catalogue');
      // Only management sets a rate. Everyone else at the counter needs to be
      // able to look one up, which is a different thing from changing it.
      const mayEdit = APP.can(['admin']);

      const count = groups.reduce((a, g) => a + g.items.length, 0);
      const unpriced = groups.reduce((a, g) => a + g.items.filter((i) => !i.price).length, 0);

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat teal"><div class="label">Billable items</div>
            <div class="value">${UI.num(count)}</div>
            <div class="foot">Across ${UI.num(groups.length)} groups</div></div>
          <div class="stat orange"><div class="label">No rate set</div>
            <div class="value">${UI.num(unpriced)}</div>
            <div class="foot">${unpriced ? 'These bill nothing until a rate is set' : 'Everything is priced'}</div></div>
          <div class="stat ok"><div class="label">Consultation — new</div>
            <div class="value">${UI.money(rateOf(groups, 'CONS-NEW'))}</div></div>
          <div class="stat crimson"><div class="label">Consultation — follow-up</div>
            <div class="value">${UI.money(rateOf(groups, 'CONS-FU'))}</div></div>
        </div>

        ${mayEdit ? `<div class="alert info mb">
          The rates below are starting figures, not the clinic's tariff — set your own.
          A rate takes effect on the next bill; bills already raised keep the rate they were
          charged at. ${unpriced ? `<b>${UI.num(unpriced)} item(s) have no rate</b> and will add
          nothing to a bill until you give them one.` : ''}</div>`
        : '<div class="alert info mb">Rates are set by management. This is the current tariff.</div>'}

        <div class="search-row">
          <input type="search" id="rt-q" placeholder="Search by name or code — X-ray, CBC, dressing…">
        </div>
        <div id="rt-groups"></div>`;

      const host = el.querySelector('#rt-groups');

      const draw = (needle) => {
        const q = String(needle || '').trim().toLowerCase();
        const shown = groups
          .map((g) => ({ ...g, items: g.items.filter((i) =>
            !q || i.name.toLowerCase().includes(q) || String(i.code).toLowerCase().includes(q)) }))
          .filter((g) => g.items.length);

        host.innerHTML = shown.length ? shown.map((g) => `
          <div class="card">
            <div class="card-head"><h3>${UI.esc(g.group)}</h3>
              <span class="muted small">${UI.num(g.items.length)} item(s)</span></div>
            <div class="card-body tight">${UI.table([
              { label: 'Code', render: (i) => `<code>${UI.esc(i.code)}</code>` },
              { label: 'Item', render: (i) => `<b>${UI.esc(i.name)}</b>` },
              { label: 'Kind', render: (i) => UI.badge(i.kind === 'test' ? 'Diagnostic' : 'Service',
                i.kind === 'test' ? 'teal' : 'info') },
              { label: 'Rate', num: true, render: (i) => (mayEdit
                ? `<input class="rate-input" type="number" min="0" step="1"
                     value="${i.price != null ? i.price : ''}" placeholder="not set"
                     data-kind="${i.kind}" data-id="${i.id}" data-was="${i.price}">`
                : (i.price ? UI.money(i.price) : '<span class="muted">not set</span>')) },
            ], g.items)}</div>
          </div>`).join('')
          : UI.empty('Nothing matches that.', '🔍');

        if (mayEdit) wireRates(host, groups);
      };

      el.querySelector('#rt-q').addEventListener('input', (e) => draw(e.target.value));
      draw('');
    },
  });

  function rateOf(groups, code) {
    for (const g of groups) {
      const hit = g.items.find((i) => i.code === code);
      if (hit) return hit.price || 0;
    }
    return 0;
  }

  /**
   * A rate saves when the cashier leaves the box, not on every keystroke — a
   * rate typed as 1200 would otherwise be saved as 1, then 12, then 120 on the
   * way. Nothing is sent if the number has not actually changed.
   */
  function wireRates(host, groups) {
    host.querySelectorAll('.rate-input').forEach((input) => {
      input.addEventListener('change', async () => {
        const was = Number(input.dataset.was);
        const now = Number(input.value);
        if (input.value === '' || Number.isNaN(now)) { input.value = was; return; }
        if (now === was) return;
        if (now < 0) { UI.err('A rate cannot be negative.'); input.value = was; return; }

        const path = input.dataset.kind === 'test'
          ? `/api/masters/lab-tests/${input.dataset.id}`
          : `/api/masters/services/${input.dataset.id}`;
        try {
          const saved = await API.patch(path, { price: now });
          input.dataset.was = saved.price;
          input.value = saved.price;
          input.classList.add('saved');
          setTimeout(() => input.classList.remove('saved'), 1200);
          // Keep the copy we are holding in step, so a search redraw does not
          // put the old rate back on screen.
          for (const g of groups) {
            const hit = g.items.find((i) => i.kind === input.dataset.kind
              && String(i.id) === input.dataset.id);
            if (hit) hit.price = saved.price;
          }
          UI.ok(`${saved.name} — ${UI.money(saved.price)}.`);
        } catch (err) {
          UI.err(err.message);
          input.value = was;
        }
      });
    });
  }
})();
