/* The master records everything else is built on. Administrators only. */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);
  const state = { tab: 'companies' };

  const TABS = [
    ['companies', 'Group companies'],
    ['applications', 'Applications'],
    ['categories', 'Product lines'],
    ['subgroups', 'Types'],
    ['terms', 'Payment terms'],
    ['locations', 'Locations'],
    ['heads', 'Expense heads'],
  ];

  APP.register('masters', {
    title: 'Masters',
    subtitle: 'The six group companies, the five applications, the fourteen product lines and the payment terms',

    async render(host) {
      const m = await APP.loadMasters(true);
      host.innerHTML = `<div class="tabs">${TABS.map(([id, label]) =>
        `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>
        <div id="pane"></div>`;

      const paint = () => {
        const pane = document.getElementById('pane');
        const tab = state.tab;
        if (tab === 'companies') {
          APP.actions([{ id: 'add', label: '+ Company', kind: 'gold', onClick: () => editCompany() }]);
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
          UI.bindRows(pane, m.companies, (row) => editCompany(row));
          return;
        }
        if (tab === 'applications') {
          APP.actions([{ id: 'add', label: '+ Application', kind: 'gold', onClick: () => editApplication() }]);
          pane.innerHTML = `<div class="card">
            <div class="card-sub">The title every quotation, LPO, delivery note and invoice carries,
              so a storm-water job and a potable-water job never share a sheet of paper.</div>
            ${UI.table([
              { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
              { label: 'Application', key: 'name' },
              { label: 'Order', num: true, key: 'sort_order' },
              { label: '', render: (r) => (r.active ? '' : UI.badge('inactive')) },
            ], m.applications, { onRow: true })}</div>`;
          UI.bindRows(pane, m.applications, (row) => editApplication(row));
          return;
        }
        if (tab === 'categories') {
          APP.actions([{ id: 'add', label: '+ Product line', kind: 'gold', onClick: () => editCategory() }]);
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
          UI.bindRows(pane, m.categories, (row) => editCategory(row));
          return;
        }
        if (tab === 'subgroups') {
          APP.actions([{ id: 'add', label: '+ Type', kind: 'gold', onClick: () => editSubgroup() }]);
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
          UI.bindRows(pane, m.subgroups, (row) => editSubgroup(row));
          return;
        }
        if (tab === 'terms') {
          APP.actions([{ id: 'add', label: '+ Payment terms', kind: 'gold', onClick: () => editTerms() }]);
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
          UI.bindRows(pane, m.paymentTerms, (row) => editTerms(row));
          return;
        }
        if (tab === 'locations') {
          APP.actions([{ id: 'add', label: '+ Location', kind: 'gold', onClick: () => editLocation() }]);
          pane.innerHTML = `<div class="card">${UI.table([
            { label: 'Code', render: (r) => `<b class="mono">${esc(r.code)}</b>` },
            { label: 'Location', render: (r) => `${esc(r.name)}${r.is_default ? ' ' + UI.badge('default', 'ok') : ''}` },
            { label: 'Address', key: 'address' },
          ], m.locations)}</div>`;
          return;
        }
        APP.actions([{ id: 'add', label: '+ Head', kind: 'gold', onClick: () => editHead() }]);
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
