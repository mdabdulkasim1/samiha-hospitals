/* The clinic's tariff: what every billable item costs. */
(function () {
  'use strict';

  APP.register('rates', {
    title: 'Services & Rates',
    subtitle: 'What the clinic charges, group by group',

    async render(el) {
      // The whole catalogue, panel analytes included: this is the one screen
      // where a clinic decides which of them it also offers on its own, and it
      // decides that by giving one a rate.
      const groups = await API.get('/api/masters/catalogue?all=1');
      // Only management sets a rate. Everyone else at the counter needs to be
      // able to look one up, which is a different thing from changing it.
      const mayEdit = APP.can(['admin']);

      const count = groups.reduce((a, g) => a + g.items.length, 0);
      const unpriced = groups.reduce((a, g) =>
        a + g.items.filter((i) => i.active && !i.price).length, 0);
      const offered = groups.reduce((a, g) => a + g.items.filter((i) => i.active).length, 0);

      el.innerHTML = `
        <div class="grid c4 mb">
          <div class="stat teal"><div class="label">Offered</div>
            <div class="value">${UI.num(offered)}</div>
            <div class="foot">of ${UI.num(count)} in the catalogue,
              across ${UI.num(groups.length)} groups</div></div>
          <div class="stat orange"><div class="label">No rate set</div>
            <div class="value">${UI.num(unpriced)}</div>
            <div class="foot">${unpriced ? 'These bill nothing until a rate is set' : 'Everything is priced'}</div></div>
          <div class="stat ok"><div class="label">Consultation — new</div>
            <div class="value">${UI.money(rateOf(groups, 'CONS-NEW'))}</div></div>
          <div class="stat crimson"><div class="label">Consultation — follow-up</div>
            <div class="value">${UI.money(rateOf(groups, 'CONS-FU'))}</div></div>
        </div>

        ${mayEdit ? '<div id="rt-reprice" class="mb"></div>' : ''}

        ${mayEdit ? `<div class="alert info mb">
          A rate takes effect on the next bill. Bills already raised keep the rate they were
          charged at, and the panel above brings the unpaid ones onto this card when you want it. ${unpriced ? `<b>${UI.num(unpriced)} item(s) have no rate</b> and will add
          nothing to a bill until you give them one.` : ''}
          <div class="small mt">An item marked <b>Reported</b> is one analyte inside a panel —
            it prints on the report but is not sold on its own. Give it a rate and it becomes a
            test the clinic offers, on the order form and on the charge board.</div></div>`
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
              <span class="muted small">${UI.num(g.items.length)} item(s)</span>
              ${mayEdit && g.group === 'Health packages'
    ? '<button class="btn sm" id="rt-add-pkg" style="margin-left:auto">+ Build a package</button>'
    : ''}</div>
            <div class="card-body tight">${UI.table([
              { label: 'Code', render: (i) => `<code>${UI.esc(i.code)}</code>` },
              { label: 'Item', render: (i) => `<b>${UI.esc(i.name)}</b>` +
                (i.component_of ? `<div class="muted small">part of ${UI.esc(
                  panelName(groups, i.component_of))}</div>` : '') },
              { label: 'Kind', render: (i) => (i.component_of && !i.price
                ? UI.badge('Reported', 'warn')
                : UI.badge(i.kind === 'test' ? 'Diagnostic' : 'Service',
                  i.kind === 'test' ? 'teal' : 'info')) },
              { label: 'Rate', num: true, render: (i) => (mayEdit
                ? `<input class="rate-input" type="number" min="0" step="1"
                     value="${i.price != null ? i.price : ''}" placeholder="not set"
                     data-kind="${i.kind}" data-id="${i.id}" data-was="${i.price}">`
                : (i.price ? UI.money(i.price) : '<span class="muted">not set</span>')) },
              /*
               * Whether the clinic does this at all. A catalogue is written for
               * every clinic and no clinic does all of it — a department with
               * no fluoroscopy switches the barium studies off and they leave
               * the order form and the charge board, without being deleted:
               * bills already raised still name what they charged for.
               */
              { label: 'Offered', render: (i) => (mayEdit
                ? `<input type="checkbox" class="offer-input" title="Does the clinic do this?"
                     data-kind="${i.kind}" data-id="${i.id}"${i.active ? ' checked' : ''}>`
                : (i.active ? UI.badge('Yes', 'ok') : UI.badge('No', 'warn'))) },
              /*
               * The reference range, which is the laboratory's to set. NABH
               * asks a lab to verify its own intervals against its own
               * analysers and have the pathologist authorise them, and a range
               * moves with the kit — so what ships here is a starting point
               * and the clinic has to be able to correct it.
               */
              { label: 'Reference range', render: (i) => (i.kind !== 'test' ? '' : (mayEdit
                ? `<button class="btn ghost sm" data-range="${i.id}">${
                    rangeLabel(i)}</button>`
                : UI.esc(rangeLabel(i)))) },
            ], g.items)}</div>
          </div>`).join('')
          : UI.empty('Nothing matches that.', '🔍');

        if (mayEdit) { wireRates(host, groups); wireOffered(host, groups); wireRanges(host, groups); }
        const addPkg = host.querySelector('#rt-add-pkg');
        if (addPkg) addPkg.addEventListener('click', () => openPackage(null, () => APP.reload()));
      };

      el.querySelector('#rt-q').addEventListener('input', (e) => draw(e.target.value));
      draw('');
      if (mayEdit) drawReprice(el.querySelector('#rt-reprice'));
    },
  });

  /**
   * Building a health package.
   *
   * A package is two things and the form writes both: one line the counter
   * presses, and the list of tests the bench is then asked to run. Getting
   * only the first is how a package gets sold that nobody runs.
   *
   * The price is the clinic's decision, but it is not made in the dark: the
   * form adds up what the chosen tests cost one at a time and offers three
   * quarters of that, because a package nobody saves on is a package nobody
   * buys. The figure is a suggestion sitting in an editable box, and the
   * form says plainly when the price is above what the tests come to — a
   * package a patient can beat by asking for the tests separately is worth
   * knowing about before it goes on a poster.
   */
  async function openPackage(existing, onDone) {
    const choices = await API.get('/api/masters/packages/choices');
    const byGroup = {};
    for (const c of choices) (byGroup[c.bill_group] = byGroup[c.bill_group] || []).push(c);
    const chosen = new Set((existing && existing.members ? existing.members : []).map((m) => m.code));

    UI.modal({
      title: existing ? `Edit — ${existing.name}` : 'Build a health package',
      size: 'wide',
      body: `<form id="pk-form">
        <div class="grid c2">
          ${UI.field({ name: 'name', label: 'What it is called', required: true,
            value: existing ? existing.name : '',
            placeholder: 'e.g. Basic Health Check Up' })}
          ${UI.field({ name: 'strapline', label: 'One line for the poster', value: '',
            placeholder: 'e.g. The three numbers worth knowing' })}
        </div>
        <fieldset><legend>What it covers</legend>
          <input type="search" id="pk-q" placeholder="Search the catalogue…" class="mb">
          <div id="pk-list" class="pk-list">
            ${Object.keys(byGroup).sort().map((grp) => `
              <div class="pk-group" data-group="${UI.esc(grp)}">
                <h5>${UI.esc(grp)}</h5>
                ${byGroup[grp].map((c) => `
                  <label class="pk-item" data-name="${UI.esc(c.name.toLowerCase())}">
                    <input type="checkbox" value="${UI.esc(c.code)}" data-price="${c.price}"
                      ${chosen.has(c.code) ? 'checked' : ''}>
                    <span>${UI.esc(c.name)}</span>
                    <b>${UI.money(c.price)}</b>
                  </label>`).join('')}
              </div>`).join('')}
          </div>
        </fieldset>
        <div class="pk-sum" id="pk-sum"></div>
        ${UI.field({ name: 'price', label: 'Package price (₹)', type: 'number', min: 1,
          step: '1', required: true, value: existing ? existing.price : '' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn ghost" data-act="suggest">Use three quarters</button>
               <button class="btn" data-act="save">${existing ? 'Save' : 'Create it'}</button>`,
      onMount: (modal) => {
        const priceBox = modal.querySelector('[name="price"]');
        const sum = modal.querySelector('#pk-sum');
        const boxes = () => [...modal.querySelectorAll('#pk-list input:checked')];
        const total = () => boxes().reduce((t, b) => t + Number(b.dataset.price || 0), 0);

        const refresh = () => {
          const apart = total();
          const n = boxes().length;
          const price = Number(priceBox.value) || 0;
          const suggested = Math.round(apart * 0.75);
          const over = price > 0 && price > apart;
          sum.innerHTML = !n
            ? '<span class="muted">Nothing chosen yet.</span>'
            : `<b>${UI.num(n)} test(s)</b> — ${UI.money(apart)} bought one at a time.
               Three quarters of that is <b>${UI.money(suggested)}</b>.
               ${price ? `At ${UI.money(price)} the patient
                 ${over ? `<span style="color:var(--danger)">pays ${UI.money(price - apart)}
                   <b>more</b> than buying them separately</span>`
    : `saves ${UI.money(apart - price)} (${Math.round((1 - price / apart) * 100)}% off)`}.` : ''}`;
        };
        modal.querySelector('#pk-list').addEventListener('change', refresh);
        priceBox.addEventListener('input', refresh);
        modal.querySelector('#pk-q').addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          modal.querySelectorAll('.pk-item').forEach((it) => {
            it.hidden = Boolean(q) && !it.dataset.name.includes(q);
          });
          modal.querySelectorAll('.pk-group').forEach((grp) => {
            grp.hidden = ![...grp.querySelectorAll('.pk-item')].some((i) => !i.hidden);
          });
        });
        refresh();
      },
      onAction: async (act, modal) => {
        const members = [...modal.querySelectorAll('#pk-list input:checked')].map((b) => b.value);
        if (act === 'suggest') {
          const apart = [...modal.querySelectorAll('#pk-list input:checked')]
            .reduce((t, b) => t + Number(b.dataset.price || 0), 0);
          if (!apart) { UI.err('Choose the tests first.'); return 'keep'; }
          const box = modal.querySelector('[name="price"]');
          box.value = Math.round(apart * 0.75);
          box.dispatchEvent(new Event('input'));
          return 'keep';
        }
        if (act !== 'save') return;
        const v = UI.formValues(modal.querySelector('#pk-form'));
        const body = { name: v.name, strapline: v.strapline, price: v.price, members };
        if (existing) await API.patch(`/api/masters/packages/${existing.code}`, body);
        else await API.post('/api/masters/packages', body);
        UI.ok(existing ? 'Package saved.' : 'Package created.');
        if (onDone) onDone();
      },
    });
  }

  /**
   * Bringing bills that are still owing onto this card.
   *
   * Shown in full before it is done, and never done on its own — a rate card
   * changing under a deploy is one thing, a hundred patients' bills changing
   * with it is quite another, and the second should be somebody pressing a
   * button having read what it will do.
   *
   * Settled bills are not offered at all. The money is collected and the
   * receipt is in the patient's hand; a rewrite would leave the invoice, the
   * receipt and the day book disagreeing.
   */
  async function drawReprice(host) {
    if (!host) return;
    let plan;
    try { plan = await API.get('/api/billing/tariff/repricing'); }
    catch { return; }
    if (!plan.totals.invoices && !plan.skipped.length) return;

    const t = plan.totals;
    host.innerHTML = `<div class="card">
      <div class="card-head"><h3>Bills still owing, at the old rates</h3>
        <span class="muted small">Settled bills are never touched</span></div>
      <div class="card-body">
        ${t.invoices ? `<div class="alert warn">
          <b>${UI.num(t.invoices)} unpaid bill(s)</b> carry ${UI.num(t.lines)} line(s) priced before
          this card. Repricing them takes ${UI.money(t.was)} down to ${UI.money(t.becomes)} —
          <b>${UI.money(Math.abs(t.delta))} ${t.delta < 0 ? 'less' : 'more'}</b> to collect.
        </div>` : '<div class="alert ok">Every unpaid bill is already on this card.</div>'}

        ${t.invoices ? `<div class="table-wrap" style="max-height:260px;overflow-y:auto">${UI.table([
          { label: 'Bill', render: (r) => `<code>${UI.esc(r.invoiceNo)}</code>` },
          { label: 'Patient', render: (r) => `<b>${UI.esc(r.patient)}</b>` +
            `<div class="muted small">${UI.esc(r.uhid)}</div>` },
          { label: 'Lines', render: (r) => `<div class="small">${r.lines.map((l) =>
            `${UI.esc(l.description)} ${UI.money(l.was)} → <b>${UI.money(l.now)}</b>`).join('<br>')}</div>` },
          { label: 'Now', num: true, render: (r) => UI.money(r.net) },
          { label: 'Becomes', num: true, render: (r) => `<b>${UI.money(r.newNet)}</b>` },
        ], plan.invoices)}</div>` : ''}

        ${plan.skipped.length ? `<div class="alert info mt">
          <b>${UI.num(plan.skipped.length)} bill(s) are left for a person to look at.</b>
          ${plan.skipped.map((sk) => `<div class="small mt"><code>${UI.esc(sk.invoiceNo)}</code>
            ${UI.esc(sk.patient)} — ${UI.esc(sk.reason)}</div>`).join('')}
        </div>` : ''}

        ${t.invoices ? '<button class="btn mt" id="rt-do">Reprice these bills</button>' : ''}
        <div id="rt-out"></div>
      </div></div>`;

    const go = host.querySelector('#rt-do');
    if (!go) return;
    go.addEventListener('click', async () => {
      if (!await UI.confirm(
        `Reprice ${t.invoices} unpaid bill(s) to this card? `
        + `What the clinic is owed changes by ${UI.money(Math.abs(t.delta))}. Settled bills are not touched.`,
        { title: 'Reprice unpaid bills' })) return;
      go.disabled = true;
      try {
        const done = await API.post('/api/billing/tariff/reprice', {});
        UI.ok(`${done.totals.invoices} bill(s) repriced.`);
        drawReprice(host);
      } catch (err) {
        host.querySelector('#rt-out').innerHTML = `<div class="alert danger mt">${UI.esc(err.message)}</div>`;
        go.disabled = false;
      }
    });
  }

  /** The range as it reads on a report, or an invitation to set one. */
  function rangeLabel(i) {
    if (i.ref_text) return i.ref_text.length > 38 ? `${i.ref_text.slice(0, 36)}…` : i.ref_text;
    if (i.ref_low != null && i.ref_high != null) return `${i.ref_low} – ${i.ref_high} ${i.unit || ''}`.trim();
    if (i.ref_low != null) return `> ${i.ref_low} ${i.unit || ''}`.trim();
    if (i.ref_high != null) return `< ${i.ref_high} ${i.unit || ''}`.trim();
    return 'not set';
  }

  /**
   * Setting a test's reference range.
   *
   * Two things go in, and they do different jobs. The printed range is what
   * appears on the patient's report and may be a sentence, because that is how
   * some guidelines state it. The low and high are what a result is flagged
   * against, and they have to be numbers. A test can have both — a lipid
   * profile prints its bands and is flagged on the first of them.
   */
  function wireRanges(host, groups) {
    host.querySelectorAll('[data-range]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.range;
      let item = null;
      for (const g of groups) {
        const hit = g.items.find((i) => i.kind === 'test' && String(i.id) === id);
        if (hit) { item = hit; break; }
      }
      if (!item) return;

      UI.modal({
        title: item.name,
        size: 'narrow',
        body: `
          <div class="alert info">The figures shipped with this system are the ordinary adult
            intervals. Your laboratory verifies them against its own analysers and methods, and
            the pathologist in charge authorises them — a range you set here is never overwritten
            by an update.</div>
          ${UI.field({ name: 'unit', label: 'Unit', value: item.unit || '',
            placeholder: 'g/dL, mg/dL, %…' })}
          <div class="grid c2">
            ${UI.field({ name: 'refLow', label: 'Low', type: 'number', step: 'any',
              value: item.ref_low != null ? item.ref_low : '', placeholder: 'no lower limit' })}
            ${UI.field({ name: 'refHigh', label: 'High', type: 'number', step: 'any',
              value: item.ref_high != null ? item.ref_high : '', placeholder: 'no upper limit' })}
          </div>
          <div class="muted small mb">A result is flagged low or high against these. Leave a box
            empty where the test has no limit that side.</div>
          ${UI.field({ name: 'refText', label: 'Printed on the report', rows: 2,
            value: item.ref_text || '',
            placeholder: 'e.g. < 150 normal · 150–199 borderline high' })}
          <div class="muted small">Left empty, the report prints the low and high above.</div>`,
        footer: `<button class="btn ghost" data-act="__close">Cancel</button>
          <button class="btn" data-act="save">Save the range</button>`,
        async onAction(act, modal) {
          if (act !== 'save') return;
          const v = UI.formValues(modal);
          const low = v.refLow === '' ? null : Number(v.refLow);
          const high = v.refHigh === '' ? null : Number(v.refHigh);
          if (low !== null && high !== null && low > high) {
            UI.err('The low end cannot be above the high end.');
            return 'keep';
          }
          try {
            const saved = await API.patch(`/api/masters/lab-tests/${id}`, {
              unit: v.unit, refLow: low, refHigh: high, refText: v.refText,
            });
            Object.assign(item, saved);
            btn.textContent = rangeLabel(item);
            UI.ok(`${saved.name} — range saved.`);
          } catch (err) { UI.err(err.message); return 'keep'; }
        },
      });
    }));
  }

  /** The panel an analyte belongs to, by name rather than by code. */
  function panelName(groups, code) {
    for (const g of groups) {
      const hit = g.items.find((i) => i.kind === 'test' && i.code === code);
      if (hit) return hit.name;
    }
    return code;
  }

  function rateOf(groups, code) {
    for (const g of groups) {
      const hit = g.items.find((i) => i.code === code);
      if (hit) return hit.price || 0;
    }
    return 0;
  }

  /** Switching an item off takes it out of use without erasing what it was. */
  function wireOffered(host, groups) {
    host.querySelectorAll('.offer-input').forEach((box) => {
      box.addEventListener('change', async () => {
        const path = box.dataset.kind === 'test'
          ? `/api/masters/lab-tests/${box.dataset.id}`
          : `/api/masters/services/${box.dataset.id}`;
        try {
          const saved = await API.patch(path, { active: box.checked });
          for (const g of groups) {
            const hit = g.items.find((i) => i.kind === box.dataset.kind
              && String(i.id) === box.dataset.id);
            if (hit) hit.active = saved.active;
          }
          UI.ok(`${saved.name} — ${saved.active ? 'offered' : 'no longer offered'}.`);
        } catch (err) {
          UI.err(err.message);
          box.checked = !box.checked;
        }
      });
    });
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
