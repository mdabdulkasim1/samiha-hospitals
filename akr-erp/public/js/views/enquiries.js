/* =============================================================================
   Enquiries, on both sides of the trade.

   A client asks us to price something; we ask a manufacturer to price
   something. It is the same document read in two directions, so it is one
   screen with a side: the sell side lists what clients have asked for, the buy
   side what we have asked the makers for. Nothing but an enquiry can be quoted
   against on the buy side, which is why the screen offers "Get their price"
   rather than leaving somebody to raise a quotation out of nowhere.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  const SIDES = {
    client: {
      route: 'enquiries',
      api: '/api/sales/enquiries',
      title: 'Enquiries',
      subtitle: 'What clients have asked for, and what we have quoted against it',
      partnerType: 'client',
      partnerLabel: 'Client',
      partnerBlank: 'Not on the books yet',
      newLabel: '+ New enquiry',
      newTitle: 'New enquiry',
      dateLabel: 'Received on',
      dueLabel: 'Quotation wanted by',
      wants: 'What they need',
      empty: 'No enquiries logged yet.',
      searchHint: 'Number, client, project…',
      fromLabel: 'From',
      quoteLabel: 'Quote it',
      statuses: ['open', 'quoted', 'won', 'lost', 'closed'],
      filterStatuses: ['open', 'quoted', 'won', 'lost'],
      quote: (enquiry) => SELL.openQuotation(null, { enquiry }),
    },
    supplier: {
      route: 'supplier-enquiries',
      api: '/api/purchase/enquiries',
      title: 'Enquiries to Manufacturers',
      subtitle: 'What we have asked the makers to price — every supplier quotation answers one',
      partnerType: 'supplier',
      partnerLabel: 'Manufacturer / supplier',
      partnerBlank: 'Not on the books yet',
      newLabel: '+ New enquiry',
      newTitle: 'Ask a manufacturer for a price',
      dateLabel: 'Raised on',
      dueLabel: 'Price wanted by',
      wants: 'What we want priced',
      empty: 'No enquiries raised yet. Raise one before asking a maker for a price.',
      searchHint: 'Number, manufacturer, project…',
      fromLabel: 'To',
      quoteLabel: 'Enter their price',
      statuses: ['open', 'quoted', 'closed'],
      filterStatuses: ['open', 'quoted', 'closed'],
      quote: (enquiry) => BUY.openSupplierQuotation(null, { enquiry }),
    },
  };

  function register(side) {
    const S = SIDES[side];
    APP.register(S.route, {
      title: S.title,
      subtitle: S.subtitle,

      render(host) {
        return SELL.listPage(host, {
          searchHint: S.searchHint,
          filters: `<label class="field"><span>Status</span><select id="f-status">
              <option value="">Open (not yet closed)</option>
              ${S.filterStatuses.map((s) => `<option value="${s}">${UI.titleise(s)}</option>`).join('')}
            </select></label>`,
          actions: [{ id: 'new', label: S.newLabel, kind: 'gold', onClick: () => open(side) }],
          async onLoad(box, values) {
            const v = values();
            box.innerHTML = UI.loading();
            const res = await API.get(S.api + API.qs({
              q: v.q, status: v.status, open: v.status ? '' : '1', limit: 200 }));
            box.innerHTML = UI.table([
              { label: 'No.', render: (r) => `<span class="mono">${esc(r.enquiry_no)}</span>` },
              { label: S.fromLabel, render: (r) => `<b>${esc(r.partner_name || r.client_name || '—')}</b>
                  <div class="muted small">${esc(r.contact_person || '')}</div>` },
              { label: 'Subject / project', render: (r) => `${esc(r.subject || '—')}
                  <div class="muted small">${esc(r.project || '')}</div>` },
              { label: 'Application', render: (r) => (r.application_name ? UI.badge(r.application_name, 'navy') : '—') },
              { label: S.dateLabel, render: (r) => UI.date(r.received_on) },
              { label: 'Wanted by', render: (r) => (r.due_on ? UI.date(r.due_on) : '—') },
              { label: 'With', key: 'owner_name' },
              { label: 'Status', render: (r) => UI.statusBadge(r.status) },
            ], res.rows, { onRow: true, emptyText: S.empty });
            UI.bindRows(box, res.rows, (row) => open(side, row));
          },
        });
      },
    });
  }

  /**
   * The enquiry form, and the button that turns it into a quotation. A new one
   * may be prefilled — asking a maker to price what a client has asked us for
   * starts from our own quotation, and retyping it invites a mismatch.
   */
  async function open(side, enquiry, { prefill = {} } = {}) {
    const S = SIDES[side];
    const m = await APP.loadMasters();
    const partners = (await API.get(`/api/partners?type=${S.partnerType}&limit=500`)).rows;
    const isNew = !enquiry;

    UI.modal({
      title: isNew ? S.newTitle : `${enquiry.enquiry_no}`,
      body: `<form id="e-form">
        ${UI.field({ name: 'partner_id', label: S.partnerLabel, blank: S.partnerBlank,
          value: enquiry ? enquiry.partner_id : prefill.partner_id || '',
          options: partners.map((c) => ({ value: c.id, label: c.name })) })}
        ${UI.field({ name: 'client_name', label: 'Or the name they gave',
          value: enquiry ? enquiry.client_name || '' : prefill.client_name || '' })}
        <div class="grid g2">
          ${UI.field({ name: 'contact_person', label: 'Contact', value: enquiry ? enquiry.contact_person || '' : prefill.contact_person || '' })}
          ${UI.field({ name: 'phone', label: 'Phone', value: enquiry ? enquiry.phone || '' : prefill.phone || '' })}
        </div>
        ${UI.field({ name: 'application_id', label: 'Application', blank: 'Not stated',
          value: enquiry ? enquiry.application_id : prefill.application_id || '',
          options: APP.applicationOptions() })}
        ${UI.field({ name: 'subject', label: 'Subject', value: enquiry ? enquiry.subject || '' : prefill.subject || '' })}
        ${UI.field({ name: 'project', label: 'Project', value: enquiry ? enquiry.project || '' : prefill.project || '' })}
        ${UI.field({ name: 'requirement', label: S.wants, rows: 4,
          value: enquiry ? enquiry.requirement || '' : prefill.requirement || '' })}
        <div class="grid g2">
          ${UI.field({ name: 'received_on', label: S.dateLabel, type: 'date',
            value: enquiry ? enquiry.received_on : UI.today() })}
          ${UI.field({ name: 'due_on', label: S.dueLabel, type: 'date',
            value: enquiry ? enquiry.due_on || '' : '' })}
        </div>
        ${UI.field({ name: 'owner_id', label: 'Handled by', blank: 'Me',
          value: enquiry ? enquiry.owner_id : '',
          options: m.users.map((u) => ({ value: u.id, label: u.name })) })}
        ${enquiry ? UI.field({ name: 'status', label: 'Status', value: enquiry.status,
          options: S.statuses.map((s) => ({ value: s, label: UI.titleise(s) })) }) : ''}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
        ${enquiry ? `<button class="btn gold" data-act="quote">${S.quoteLabel}</button>` : ''}
        <button class="btn" data-act="save">${isNew ? 'Log the enquiry' : 'Save'}</button>`,
      async onAction(act, modal) {
        if (act === 'quote') {
          UI.closeAllModals();
          S.quote(enquiry);
          return;
        }
        if (act !== 'save') return;
        const form = modal.querySelector('#e-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        if (enquiry) {
          await API.patch(`${S.api}/${enquiry.id}`, values);
          UI.ok('Saved.');
        } else {
          const made = await API.post(S.api, values);
          UI.ok(`Logged as ${made.enquiry_no}.`);
        }
        APP.reload();
      },
    });
  }

  /**
   * Which enquiry is this price against? Asked wherever a quotation is being
   * raised without one already in hand, so nobody has to go and find the
   * number themselves.
   */
  async function pickOpen(side) {
    const S = SIDES[side];
    const res = await API.get(S.api + API.qs({ status: 'open', limit: 200 }));
    if (!res.rows.length) {
      const raise = await UI.confirm(
        "A manufacturer's quotation is always logged against an enquiry we raised, and there is "
        + 'no open one. Raise it now?',
        { title: 'No enquiry open', yes: 'Raise the enquiry' });
      if (raise) open(side);
      return null;
    }
    const id = await SELL.pickOne('Which enquiry is this price against?',
      res.rows.map((r) => ({
        id: r.id,
        label: `${r.enquiry_no} — ${r.partner_name || r.client_name || 'unnamed'}`,
        note: [r.subject, r.project, r.due_on ? `wanted by ${UI.date(r.due_on)}` : '']
          .filter(Boolean).join(' · '),
      })));
    return id ? res.rows.find((r) => r.id === id) : null;
  }

  register('client');
  register('supplier');

  window.ENQUIRIES = { open, pickOpen };
})();
