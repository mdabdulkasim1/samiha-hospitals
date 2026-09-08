/* Following a reference back through everything it touched. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  APP.register('trace', {
    title: 'Trace a Reference',
    subtitle: 'Type any document number and see the whole story behind it',

    async render(host, params) {
      host.innerHTML = `
        <div class="card">
          <div class="card-sub">Ours or theirs — our LPO, our invoice, a client's own LPO number, a
            supplier's own invoice number. Part of a number will do.</div>
          <form id="t-form" class="row">
            <label class="field grow" style="margin:0">
              <span>Reference</span>
              <input name="ref" value="${esc(params.ref || '')}" placeholder="AKR-FD26-016"
                     autocomplete="off" autofocus>
            </label>
            <button class="btn" type="submit" style="margin-top:20px">Trace it</button>
          </form>
        </div>
        <div id="out"></div>`;

      const out = document.getElementById('out');
      const form = document.getElementById('t-form');

      const run = async (ref) => {
        if (!ref) { out.innerHTML = ''; return; }
        out.innerHTML = UI.loading();
        const res = await API.get('/api/reports/trace?ref=' + encodeURIComponent(ref));

        if (!res.found.length) {
          out.innerHTML = `<div class="card">${UI.empty(
            `Nothing in the system carries the reference “${ref}”.`, '🔍')}</div>`;
          return;
        }

        // Several possibilities, or only near-misses: let the person choose.
        if (!res.chain) {
          out.innerHTML = `<div class="card"><h3>Which one?</h3>
            <div class="card-sub">More than one document answers to that.</div>
            <div class="alert-list">${res.found.map((f) => `
              <button type="button" class="alert-row" data-pick="${esc(f.ref)}">
                <span class="alert-text"><b>${esc(f.ref)}</b>
                <span class="muted small">${esc(f.label)} · ${UI.date(f.on_date)}</span></span>
              </button>`).join('')}</div></div>`;
          out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
            form.querySelector('[name=ref]').value = b.dataset.pick;
            run(b.dataset.pick);
          }));
          return;
        }

        const chain = res.chain;
        const partner = chain.partner;
        out.innerHTML = `
          <div class="card">
            <div class="row-between mb">
              <div><h3>${esc(res.matched.label)} ${esc(res.matched.ref)}</h3>
                <div class="card-sub">${chain.steps.length} document${chain.steps.length === 1 ? '' : 's'}
                  in this chain${partner ? ' · ' + esc(partner.name) : ''}</div></div>
              ${partner ? `<button class="btn ghost sm" id="to-partner">Open the account</button>` : ''}
            </div>
            ${UI.table([
              { label: 'Date', render: (r) => UI.date(r.on_date) },
              { label: 'Step', render: (r) => `<b>${esc(r.label)}</b>` },
              { label: 'Reference', render: (r) => `<span class="mono">${esc(r.ref)}</span>
                  ${r.ref === res.matched.ref ? ' ' + UI.badge('you searched this', 'gold') : ''}
                  ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ''}` },
              { label: 'Who', render: (r) => esc(r.who || '') },
              { label: 'Amount', num: true, render: (r) => (r.amount === null || r.amount === undefined
                ? '' : UI.money(r.amount, { symbol: false })) },
              { label: 'Status', render: (r) => (r.status ? UI.statusBadge(r.status) : '') },
              { label: '', render: (r) => `<button class="btn ghost sm" data-open="${r.route}"
                  data-id="${r.id}">Open</button>` },
            ], chain.steps, { emptyText: 'Nothing is linked to this one yet.' })}
          </div>`;

        out.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
          APP.navigate(b.dataset.open, { id: b.dataset.id });
        }));
        const toPartner = document.getElementById('to-partner');
        if (toPartner) toPartner.addEventListener('click', () => APP.navigate('partners'));
      };

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const ref = form.querySelector('[name=ref]').value.trim();
        APP.navigate('trace', ref ? { ref } : {});
        run(ref);
      });
      if (params.ref) await run(params.ref);
    },
  });
})();
