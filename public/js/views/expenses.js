(function () {
  'use strict';
  /**
   * The expense book, on screen.
   *
   * Three tabs, and they belong to different people on purpose.
   *
   * The book itself is the counter's: a bill arrives, somebody books it
   * under a heading and an item, and either pays it there or leaves it owed.
   * The form asks for what is on the piece of paper in front of them and
   * nothing else; the rest has defaults and can be filled in later by
   * whoever has the file.
   *
   * The month is management's. Setup apart from running costs, running costs
   * by heading and by department, and underneath them the three figures that
   * are not running costs but get asked about in the same breath — interest,
   * depreciation, and what is still owed.
   *
   * The headings are management's too, because every total on the report is
   * built on them. Adding one is a button; moving a shipped one between
   * groups is refused, which is the point.
   */

  const money = (n) => UI.money(Number(n) || 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  /** Management: the owner and the administrator, nobody else. */
  const isManagement = () => Boolean(APP.user && ['owner', 'admin'].includes(APP.user.role));

  let catalogue = null;
  const loadCatalogue = async (force) => {
    if (!catalogue || force) catalogue = await API.get('/api/expenses/categories');
    return catalogue;
  };
  const deptLabel = (key) => {
    const d = (catalogue && catalogue.departments || []).find((x) => x.key === key);
    return d ? d.label : key;
  };
  const allHeadings = () => (catalogue ? catalogue.groups.flatMap((g) => g.categories) : []);

  const STATUS = {
    unpaid: ['Unpaid', 'danger'],
    part_paid: ['Part paid', 'warn'],
    paid: ['Paid', 'ok'],
    void: ['Voided', ''],
  };
  const statusBadge = (row) => {
    const [label, tone] = STATUS[row.status] || [row.status, ''];
    return UI.badge(label, tone);
  };

  // ------------------------------------------------------------------- the book
  async function bookTab(body) {
    await loadCatalogue();
    const state = {
      from: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
      to: today(),
    };

    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>Expense book</h3>
        <input type="date" id="ex-from" value="${state.from}" style="max-width:160px">
        <input type="date" id="ex-to" value="${state.to}" style="max-width:160px">
        <select id="ex-group" style="max-width:190px">
          <option value="">Every heading</option>
          ${catalogue.groups.map((g) => `<option value="${UI.esc(g.key)}">${UI.esc(g.label)}</option>`).join('')}
        </select>
        <select id="ex-dept" style="max-width:200px">
          <option value="">Every department</option>
          ${catalogue.departments.map((d) =>
    `<option value="${UI.esc(d.key)}">${UI.esc(d.label)}</option>`).join('')}
        </select>
        <select id="ex-status" style="max-width:150px">
          <option value="">Paid or not</option>
          <option value="unpaid">Unpaid</option>
          <option value="part_paid">Part paid</option>
          <option value="paid">Paid</option>
        </select>
        <input type="search" id="ex-q" placeholder="Supplier, invoice no…" style="max-width:200px">
        <button class="btn sm" id="ex-add">+ Book an expense</button>
      </div>
        <div id="ex-totals"></div>
        <div class="card-body tight" id="ex-list">${UI.loading()}</div></div>
      <div class="muted small">A bill is booked on the day it is raised, whether or not it has been
        paid — that is how the month can be totalled before every supplier has been settled. Paying
        one here writes the cash book line for it, so nothing is entered twice.</div>`;

    const load = async () => {
      const data = await API.get('/api/expenses' + API.qs({
        from: body.querySelector('#ex-from').value,
        to: body.querySelector('#ex-to').value,
        group: body.querySelector('#ex-group').value,
        department: body.querySelector('#ex-dept').value,
        status: body.querySelector('#ex-status').value,
        q: body.querySelector('#ex-q').value.trim(),
        limit: 200,
      }));

      body.querySelector('#ex-totals').innerHTML = `
        <div class="grid c3" style="padding:12px 16px 0">
          <div class="stat"><div class="label">Billed in this window</div>
            <div class="value">${money(data.totals.billed)}</div>
            <div class="foot">${UI.num(data.totals.entries)} bills</div></div>
          <div class="stat teal"><div class="label">Paid</div>
            <div class="value">${money(data.totals.paid)}</div>
            <div class="foot">Out of the drawer or the bank</div></div>
          <div class="stat ${data.totals.outstanding > 0 ? 'crimson' : 'ok'}">
            <div class="label">Still owed</div>
            <div class="value">${money(data.totals.outstanding)}</div>
            <div class="foot">On bills raised in this window</div></div>
        </div>`;

      const host = body.querySelector('#ex-list');
      host.innerHTML = UI.table([
        { label: 'Date', render: (r) => UI.esc(UI.date(r.invoice_date)) },
        { label: 'Ref', render: (r) => `<code>${UI.esc(r.ref_no)}</code>` },
        { label: 'Heading', render: (r) => `${UI.esc(r.category_name)}${r.item_name
          ? `<div class="muted small">${UI.esc(r.item_name)}</div>` : ''}` },
        { label: 'Department', render: (r) => UI.esc(deptLabel(r.department)) },
        { label: 'Supplier', render: (r) => UI.esc(r.supplier_account || r.supplier_name || '—')
          + (r.invoice_no ? `<div class="muted small">${UI.esc(r.invoice_no)}</div>` : '') },
        { label: 'Total', num: true, render: (r) => money(r.total) },
        { label: 'Owed', num: true, render: (r) => (r.outstanding > 0.009
          ? `<b style="color:var(--danger)">${money(r.outstanding)}</b>` : '—') },
        { label: '', render: (r) => statusBadge(r) },
        { label: '', render: (r) => (r.attachments ? '📎' : '') },
      ], data.rows, { emptyText: 'Nothing booked in this window yet.' });
      UI.bindRows(host, data.rows, (r) => openExpense(r.id, load));
    };

    body.querySelectorAll('#ex-from, #ex-to, #ex-group, #ex-dept, #ex-status')
      .forEach((f) => f.addEventListener('change', load));
    let typing;
    body.querySelector('#ex-q').addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(load, 300);
    });
    body.querySelector('#ex-add').addEventListener('click', () => openForm(null, load));
    await load();
  }

  /**
   * Booking a bill.
   *
   * The heading picks the department and the items, because that is what
   * the heading is for — a laboratory reagent is the laboratory's cost
   * unless somebody says otherwise, and having to choose it every time is
   * how it ends up under Common Services by Friday.
   */
  function openForm(existing, onSaved) {
    const groups = catalogue.groups;
    const first = existing
      ? allHeadings().find((c) => c.id === existing.category_id)
      : null;

    const headingOptions = groups.map((g) =>
      `<optgroup label="${UI.esc(g.label)}">
         ${g.categories.map((c) => `<option value="${c.id}"${first && first.id === c.id ? ' selected' : ''}>
           ${UI.esc(c.name)}</option>`).join('')}
       </optgroup>`).join('');

    UI.modal({
      title: existing ? `Correct ${existing.ref_no}` : 'Book an expense',
      size: 'wide',
      body: `
        <form id="ex-form" class="grid c2">
          <label class="field"><span>Heading <span class="req">*</span></span>
            <select name="categoryId" required>${headingOptions}</select></label>
          <label class="field"><span>Item</span>
            <select name="itemId" id="ex-item"><option value="">Not itemised</option></select></label>
          <label class="field"><span>Department <span class="req">*</span></span>
            <select name="department" id="ex-dept-f">${catalogue.departments.map((d) =>
    `<option value="${UI.esc(d.key)}">${UI.esc(d.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Supplier or payee <span class="req">*</span></span>
            <input name="supplierName" required placeholder="Who it was paid to"
              value="${UI.esc((existing && (existing.supplier_account || existing.supplier_name)) || '')}"></label>

          <label class="field"><span>Invoice number</span>
            <input name="invoiceNo" value="${UI.esc((existing && existing.invoice_no) || '')}"
              placeholder="As printed on the bill"></label>
          <label class="field"><span>Invoice date <span class="req">*</span></span>
            <input type="date" name="invoiceDate" required max="${today()}"
              value="${UI.esc((existing && existing.invoice_date) || today())}"></label>

          <label class="field"><span>Amount before tax</span>
            <input type="number" step="0.01" min="0" name="taxable" id="ex-taxable"
              value="${existing ? existing.taxable : ''}"></label>
          <label class="field"><span>Tax</span>
            <input type="number" step="0.01" min="0" name="tax" id="ex-tax"
              value="${existing ? existing.tax : ''}"></label>
          <label class="field"><span>Invoice total <span class="req">*</span></span>
            <input type="number" step="0.01" min="0.01" name="total" id="ex-total" required
              value="${existing ? existing.total : ''}"></label>
          <label class="field"><span>Due date</span>
            <input type="date" name="dueDate" value="${UI.esc((existing && existing.due_date) || '')}"></label>

          <label class="field"><span>Billing period from</span>
            <input type="date" name="periodFrom" value="${UI.esc((existing && existing.period_from) || '')}"></label>
          <label class="field"><span>…to</span>
            <input type="date" name="periodTo" value="${UI.esc((existing && existing.period_to) || '')}"></label>

          <label class="field" style="grid-column:1/-1"><span>What it was for</span>
            <input name="description" value="${UI.esc((existing && existing.description) || '')}"
              placeholder="Reagent pack for the analyser, October rent, AMC for the X-ray unit…"></label>

          ${existing ? '' : `
          <fieldset style="grid-column:1/-1"><legend>Paid now?</legend>
            <div class="grid c3">
              <label class="field"><span>Amount paid</span>
                <input type="number" step="0.01" min="0" name="paidNow" id="ex-paid"
                  placeholder="Leave empty if it is on credit"></label>
              <label class="field"><span>How</span>
                <select name="mode">${catalogue.modes.map((m) =>
    `<option value="${m}">${UI.titleise(m)}</option>`).join('')}</select></label>
              <label class="field"><span>Reference</span>
                <input name="paymentReference" placeholder="UPI or cheque number"></label>
            </div>
            <div class="muted small">A bill left unpaid stays on the list of what the clinic owes,
              and still counts as a cost of this month.</div>
          </fieldset>`}
        </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">${existing ? 'Save the correction' : 'Book it'}</button>`,
      onMount(modal) {
        const heading = modal.querySelector('[name=categoryId]');
        const itemBox = modal.querySelector('#ex-item');
        const deptBox = modal.querySelector('#ex-dept-f');

        const fillItems = (keepItem) => {
          const chosen = allHeadings().find((c) => String(c.id) === heading.value);
          itemBox.innerHTML = '<option value="">Not itemised</option>'
            + (chosen ? chosen.items.map((i) =>
              `<option value="${i.id}"${keepItem === i.id ? ' selected' : ''}>${UI.esc(i.name)}</option>`).join('') : '');
          if (chosen && !keepItem) deptBox.value = chosen.default_department;
        };
        fillItems(existing ? existing.item_id : null);
        if (existing) deptBox.value = existing.department;
        heading.addEventListener('change', () => fillItems(null));

        /*
         * The counter types one number — the total on the bill — and the
         * other two follow it. Typing the same figure three times is how a
         * tax column ends up wrong, and the server checks the sum anyway.
         */
        const taxable = modal.querySelector('#ex-taxable');
        const tax = modal.querySelector('#ex-tax');
        const total = modal.querySelector('#ex-total');
        const sum = () => {
          if (taxable.value === '' && tax.value === '') return;
          total.value = (Math.round(((Number(taxable.value) || 0) + (Number(tax.value) || 0)) * 100) / 100)
            .toFixed(2);
        };
        taxable.addEventListener('input', sum);
        tax.addEventListener('input', sum);
        const paid = modal.querySelector('#ex-paid');
        if (paid) total.addEventListener('change', () => { if (paid.value) paid.value = total.value; });
      },
      async onAction(act, modal) {
        if (act !== 'save') return;
        const form = modal.querySelector('#ex-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        try {
          const saved = existing
            ? await API.patch(`/api/expenses/${existing.id}`, values)
            : await API.post('/api/expenses', values);
          UI.ok(existing ? 'Corrected.' : `Booked as ${saved.ref_no}.`);
          if (onSaved) await onSaved();
          if (!existing) openExpense(saved.id, onSaved);
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  /** One bill: what it was, what has been paid, and what is filed against it. */
  async function openExpense(id, onChanged) {
    const row = await API.get(`/api/expenses/${id}`);
    const owed = Number(row.outstanding) || 0;

    UI.modal({
      title: `${row.ref_no} · ${row.category_name}`,
      size: 'wide',
      body: `
        ${row.status === 'void' ? `<div class="alert danger">Voided — ${UI.esc(row.void_reason || '')}
          ${row.voided_by_name ? ` (${UI.esc(row.voided_by_name)})` : ''}</div>` : ''}
        <div class="grid c3 mb">
          <div class="stat"><div class="label">Invoice total</div>
            <div class="value">${money(row.total)}</div>
            <div class="foot">${row.tax ? `includes ${money(row.tax)} tax` : 'no tax claimed'}</div></div>
          <div class="stat teal"><div class="label">Paid</div>
            <div class="value">${money(row.paid)}</div>
            <div class="foot">${row.payments.length} payment(s)</div></div>
          <div class="stat ${owed > 0.009 ? 'crimson' : 'ok'}"><div class="label">Still owed</div>
            <div class="value">${money(owed)}</div>
            <div class="foot">${row.due_date ? `due ${UI.esc(UI.date(row.due_date))}` : 'no due date'}</div></div>
        </div>

        <table class="plain small mb"><tbody>
          <tr><td><b>Item</b></td><td>${UI.esc(row.item_name || 'Not itemised')}</td>
              <td><b>Department</b></td><td>${UI.esc(deptLabel(row.department))}</td></tr>
          <tr><td><b>Supplier</b></td><td>${UI.esc(row.supplier_account || row.supplier_name || '—')}</td>
              <td><b>Invoice</b></td><td>${UI.esc(row.invoice_no || '—')} ·
                ${UI.esc(UI.date(row.invoice_date))}</td></tr>
          <tr><td><b>For</b></td><td>${UI.esc(row.description || '—')}</td>
              <td><b>Period</b></td><td>${row.period_from
    ? `${UI.esc(UI.date(row.period_from))} – ${UI.esc(UI.date(row.period_to || row.period_from))}`
    : '—'}</td></tr>
          <tr><td><b>Booked by</b></td><td>${UI.esc(row.entered_by_name || '—')}</td>
              <td><b>Approved</b></td><td>${row.approved_at
    ? `${UI.esc(row.approved_by_name || '')} · ${UI.esc(UI.date(row.approved_at))}`
      + (row.approval_note ? `<div class="muted small">${UI.esc(row.approval_note)}</div>` : '')
    : '<span class="muted">not yet</span>'}</td></tr>
        </tbody></table>

        <h4>Payments</h4>
        <div id="ex-pays">${row.payments.length ? UI.table([
    { label: 'Date', render: (p) => UI.esc(UI.date(p.paid_on)) },
    { label: 'How', render: (p) => UI.titleise(p.mode) },
    { label: 'Reference', render: (p) => UI.esc(p.reference || '—') },
    { label: 'Cash book', render: (p) => `<code>${UI.esc(p.cash_ref || '—')}</code>` },
    { label: 'Amount', num: true, render: (p) => money(p.amount) },
    { label: '', render: (p) => (row.status === 'void' ? ''
      : `<button class="btn ghost sm" data-unpay="${p.id}">Take off</button>`) },
  ], row.payments) : '<p class="muted">Nothing paid against this yet.</p>'}</div>

        <h4 class="mt">Paperwork</h4>
        <div id="ex-files">${row.files.length ? row.files.map((f) =>
    `<div class="row-between" style="padding:4px 0">
           <span>📎 <a href="/api/expenses/attachments/${f.id}" target="_blank" rel="noopener">${UI.esc(f.filename)}</a>
             <span class="muted small">${UI.titleise(f.kind)} · ${Math.round(f.bytes / 1024)} KB</span></span>
           <button class="btn ghost sm" data-unfile="${f.id}">Remove</button>
         </div>`).join('')
    : '<p class="muted">No invoice or receipt filed against this yet.</p>'}</div>
        <div class="mt">
          <input type="file" id="ex-file" accept="image/*,application/pdf" style="max-width:260px">
          <select id="ex-file-kind" style="max-width:150px">
            <option value="invoice">Invoice</option>
            <option value="receipt">Receipt</option>
            <option value="approval">Approval</option>
            <option value="other">Other</option>
          </select>
          <button class="btn ghost sm" id="ex-upload">File it</button>
          <div class="muted small mt">A photograph of the bill is enough. Up to 6 MB.</div>
        </div>`,
      footer: `${row.status === 'void' ? '' : `
        ${owed > 0.009 ? '<button class="btn" data-act="pay">Pay</button>' : ''}
        <button class="btn ghost" data-act="edit">Correct it</button>
        ${isManagement() && !row.approved_at ? '<button class="btn teal" data-act="approve">Approve</button>' : ''}
        <button class="btn ghost" data-act="void">Void</button>`}
        <button class="btn ghost" data-act="__close">Close</button>`,
      onMount(modal) {
        modal.querySelectorAll('[data-unpay]').forEach((b) => b.addEventListener('click', async () => {
          const reason = prompt('Why is this payment being taken off?');
          if (!reason) return;
          try {
            await API.post(`/api/expenses/payments/${b.dataset.unpay}/void`, { reason });
            UI.ok('Taken off, and the cash book line voided with it.');
            UI.closeModal();
            if (onChanged) await onChanged();
            openExpense(id, onChanged);
          } catch (err) { UI.err(err.message); }
        }));

        modal.querySelectorAll('[data-unfile]').forEach((b) => b.addEventListener('click', async () => {
          try {
            await API.del(`/api/expenses/attachments/${b.dataset.unfile}`);
            UI.ok('Removed.');
            UI.closeModal();
            openExpense(id, onChanged);
          } catch (err) { UI.err(err.message); }
        }));

        modal.querySelector('#ex-upload').addEventListener('click', async () => {
          const input = modal.querySelector('#ex-file');
          const file = input.files && input.files[0];
          if (!file) return UI.warn('Choose the photograph or the PDF first.');
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('That file could not be read.'));
            reader.readAsDataURL(file);
          });
          try {
            await API.post(`/api/expenses/${id}/attachments`,
              { data, filename: file.name, kind: modal.querySelector('#ex-file-kind').value });
            UI.ok('Filed.');
            UI.closeModal();
            if (onChanged) await onChanged();
            openExpense(id, onChanged);
          } catch (err) { UI.err(err.message); }
          return undefined;
        });
      },
      async onAction(act) {
        if (act === 'edit') {
          UI.closeModal();
          openForm(row, onChanged);
          return undefined;
        }
        if (act === 'approve') {
          const note = prompt('Anything to note with the approval?') || '';
          await API.post(`/api/expenses/${id}/approve`, { note });
          UI.ok('Approved.');
          UI.closeModal();
          if (onChanged) await onChanged();
          openExpense(id, onChanged);
          return undefined;
        }
        if (act === 'void') {
          const reason = prompt('Why is this expense being voided?');
          if (!reason) return 'keep';
          await API.post(`/api/expenses/${id}/void`, { reason });
          UI.ok('Voided.');
          if (onChanged) await onChanged();
          return undefined;
        }
        if (act === 'pay') {
          UI.closeModal();
          openPayment(row, onChanged);
          return undefined;
        }
        return undefined;
      },
    });
  }

  function openPayment(row, onChanged) {
    UI.modal({
      title: `Pay ${row.ref_no}`,
      size: 'narrow',
      body: `<form id="pay-form">
        <p class="muted" style="margin-top:0">${UI.esc(row.supplier_account || row.supplier_name || '')}
          — ${money(row.outstanding)} outstanding of ${money(row.total)}.</p>
        ${UI.field({ name: 'amount', label: 'Amount', type: 'number', value: row.outstanding, required: true })}
        ${UI.field({ name: 'paidOn', label: 'Paid on', type: 'date', value: today(), required: true })}
        ${UI.field({ name: 'mode', label: 'How', options: catalogue.modes.map((m) =>
    ({ value: m, label: UI.titleise(m) })) })}
        ${UI.field({ name: 'reference', label: 'Reference', placeholder: 'UPI or cheque number' })}
      </form>
      <div class="muted small">This writes the cash book entry too, so the payment is recorded once.</div>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="pay">Pay</button>`,
      async onAction(act, modal) {
        if (act !== 'pay') return undefined;
        const form = modal.querySelector('#pay-form');
        if (!form.reportValidity()) return 'keep';
        try {
          await API.post(`/api/expenses/${row.id}/payments`, UI.formValues(form));
          UI.ok('Paid, and in the cash book.');
          if (onChanged) await onChanged();
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  // ---------------------------------------------------------------- the month
  async function reportTab(body) {
    await loadCatalogue();
    body.innerHTML = `
      <div class="card mb"><div class="card-head"><h3>Monthly expense report</h3>
        <input type="month" id="er-month" value="${thisMonth()}" style="max-width:170px">
        <button class="btn ghost sm" id="er-print">Print</button>
      </div><div class="card-body" id="er-body">${UI.loading()}</div></div>`;

    const draw = async () => {
      const period = body.querySelector('#er-month').value || thisMonth();
      const r = await API.get(`/api/expenses/report?period=${period}`);
      body.querySelector('#er-body').innerHTML = reportHtml(r);
    };
    body.querySelector('#er-month').addEventListener('change', draw);
    body.querySelector('#er-print').addEventListener('click', () => {
      const period = body.querySelector('#er-month').value || thisMonth();
      UI.print(`${UI.sheetStyles()}<div class="sheet" style="width:auto">
        ${UI.sheetHead('Monthly expense report')}
        ${body.querySelector('#er-body').innerHTML}</div>`,
      `Expenses ${period}`, { standalone: true, width: 1000 });
    });
    await draw();
  }

  const cell = (v) => `<td class="num">${v ? money(v) : '<span class="muted">—</span>'}</td>`;

  function groupTable(group) {
    const rows = group.categories.filter((c) => c.month.entries || c.ytd.entries);
    if (!rows.length) {
      return `<p class="muted small">Nothing booked under ${UI.esc(group.label.toLowerCase())} this year.</p>`;
    }
    return `<table class="plain small"><thead><tr>
        <th>Heading</th><th class="num">This month</th><th class="num">Paid</th>
        <th class="num">Still owed</th><th class="num">Year to date</th></tr></thead><tbody>
      ${rows.map((c) => `<tr>
        <td>${UI.esc(c.name)}
          ${c.items.length ? `<div class="muted small">${c.items.slice(0, 6).map((i) =>
    `${UI.esc(i.name)} ${money(i.billed)}`).join(' · ')}${c.items.length > 6 ? ' …' : ''}</div>` : ''}</td>
        ${cell(c.month.billed)}${cell(c.month.paid)}${cell(c.month.outstanding)}${cell(c.ytd.billed)}
      </tr>`).join('')}
      <tr class="strong"><td><b>${UI.esc(group.label)}</b></td>
        ${cell(group.month.billed)}${cell(group.month.paid)}${cell(group.month.outstanding)}
        ${cell(group.ytd.billed)}</tr>
    </tbody></table>`;
  }

  function reportHtml(r) {
    const group = (key) => r.groups.find((g) => g.key === key) || { categories: [], month: {}, ytd: {} };
    const sched = (s) => `<tr><td>${UI.esc(s.label)}</td>${cell(s.month.billed)}${cell(s.ytd.billed)}
      <td class="muted small">${UI.esc(s.note || '')}</td></tr>`;

    return `
      <div class="grid c4 mb">
        <div class="stat"><div class="label">Cost of running the clinic</div>
          <div class="value">${money(r.totals.operating)}</div>
          <div class="foot">year to date ${money(r.operating.ytd.billed)}</div></div>
        <div class="stat orange"><div class="label">Interest and finance</div>
          <div class="value">${money(r.totals.interest)}</div>
          <div class="foot">below the subtotal, not in it</div></div>
        <div class="stat"><div class="label">Depreciation</div>
          <div class="value">${money(r.totals.depreciation)}</div>
          <div class="foot">from the asset register</div></div>
        <div class="stat ${r.flags.unpaid.amount > 0 ? 'crimson' : 'ok'}">
          <div class="label">Owed to suppliers</div>
          <div class="value">${money(r.flags.unpaid.amount)}</div>
          <div class="foot">${r.flags.overdue.entries} bill(s) past their due date</div></div>
      </div>

      <h3>Monthly operating costs</h3>
      <p class="muted small">${UI.esc(group('operating').note || '')}</p>
      ${groupTable(group('operating'))}

      <h3 class="mt">By department</h3>
      <table class="plain small"><thead><tr><th>Department</th>
        <th class="num">Running costs</th><th class="num">Year to date</th>
        <th class="num">Everything booked</th></tr></thead><tbody>
        ${r.departments.map((d) => `<tr><td>${UI.esc(d.label)}</td>
          ${cell(d.month.billed)}${cell(d.ytd.billed)}${cell(d.allMonth.billed)}</tr>`).join('')}
      </tbody></table>
      <p class="muted small">A cost nobody could assign is under Administration &amp; Common Services,
        which is what makes it an overhead rather than a department's.</p>

      <h3 class="mt">Below the operating subtotal</h3>
      <table class="plain small"><thead><tr><th></th><th class="num">This month</th>
        <th class="num">Year to date</th><th></th></tr></thead><tbody>
        <tr><td>Loan interest and finance charges</td>${cell(r.belowTheLine.finance.month.billed)}
          ${cell(r.belowTheLine.finance.ytd.billed)}<td class="muted small">The price of the money</td></tr>
        <tr><td>Depreciation</td>${cell(r.belowTheLine.depreciation.month.billed)}
          ${cell(r.belowTheLine.depreciation.ytd.billed)}
          <td class="muted small">${UI.esc(r.belowTheLine.depreciation.note)}${
  r.belowTheLine.depreciation.guessedLives
    ? ` ${r.belowTheLine.depreciation.guessedLives} asset(s) on an assumed life.` : ''}</td></tr>
      </tbody></table>

      <h3 class="mt">Setup and pre-opening</h3>
      <p class="muted small">${UI.esc(group('setup').note || '')}</p>
      ${groupTable(group('setup'))}

      <h3 class="mt">Schedules — money out that is not a cost</h3>
      <table class="plain small"><thead><tr><th>Schedule</th><th class="num">This month</th>
        <th class="num">Year to date</th><th></th></tr></thead><tbody>
        ${sched(r.schedules.setup)}
        ${sched(r.schedules.stock)}
        ${sched(r.schedules.deposits)}
        ${sched(r.schedules.advances)}
        ${sched(r.schedules.loanPrincipal)}
      </tbody></table>

      <h3 class="mt">Patient discounts and refunds</h3>
      <table class="plain small"><tbody>
        <tr><td>Discounts given on bills</td>${cell(r.patients.discountsGiven.amount)}
          <td class="muted small">${UI.num(r.patients.discountsGiven.invoices)} bills</td></tr>
        <tr><td>Refunded to patients</td>${cell(r.patients.refunds.amount)}
          <td class="muted small">${UI.num(r.patients.refunds.entries)} refund(s)</td></tr>
      </tbody></table>
      <p class="muted small">${UI.esc(r.patients.note)}</p>

      ${r.flags.missingDocuments.entries ? `<div class="alert warn mt">
        <b>${UI.num(r.flags.missingDocuments.entries)}
        ${r.flags.missingDocuments.entries === 1 ? 'entry has' : 'entries have'} no invoice number
        or nothing filed against them</b> — ${money(r.flags.missingDocuments.amount)} in all.
        Filter the book by this month and look for the ones without a 📎.</div>` : ''}`;
  }

  // ------------------------------------------------------------- the headings
  async function headingsTab(body) {
    const draw = async () => {
      const data = await API.get('/api/expenses/categories?all=1');
      catalogue = await loadCatalogue(true);
      body.innerHTML = `
        <div class="card"><div class="card-head"><h3>Expense headings</h3>
          <button class="btn sm" id="hd-add">+ Add a heading</button></div>
          <div class="card-body">
            <p class="muted small">The reports total by these, so a heading that ships with the
              system can be reworded and switched off but not moved between groups. Add as many of
              your own as the clinic needs.</p>
            ${data.groups.map((g) => `
              <h4 class="mt">${UI.esc(g.label)}</h4>
              <p class="muted small">${UI.esc(g.note || '')}</p>
              <table class="plain small"><thead><tr><th>Heading</th><th>Department</th>
                <th>Items</th><th>Used</th><th></th></tr></thead><tbody>
                ${g.categories.map((c) => `<tr${c.active ? '' : ' class="muted"'}>
                  <td><b>${UI.esc(c.name)}</b> ${c.active ? '' : UI.badge('Off', 'warn')}
                    ${c.seeded ? '' : UI.badge('Yours', 'teal')}
                    ${c.note ? `<div class="muted small">${UI.esc(c.note)}</div>` : ''}</td>
                  <td>${UI.esc(deptLabel(c.default_department))}</td>
                  <td>${c.items.length}</td>
                  <td>${c.used}</td>
                  <td><button class="btn ghost sm" data-edit="${c.id}">Items &amp; name</button></td>
                </tr>`).join('')}
              </tbody></table>`).join('')}
          </div></div>`;

      body.querySelector('#hd-add').addEventListener('click', () => addHeading(draw));
      body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
        editHeading(Number(b.dataset.edit), draw)));
    };
    await draw();
  }

  function addHeading(onSaved) {
    UI.modal({
      title: 'Add an expense heading',
      body: `<form id="hd-form">
        ${UI.field({ name: 'name', label: 'Heading', required: true,
    placeholder: 'What the clinic calls this kind of spending' })}
        ${UI.field({ name: 'group', label: 'Where it belongs', options: catalogue.groups.map((g) =>
    ({ value: g.key, label: g.label })) })}
        ${UI.field({ name: 'nature', label: 'What kind of money this is',
    options: [
      { value: 'operating', label: 'A cost of running the clinic — counts in the subtotal' },
      { value: 'capital', label: 'Buying something that lasts — a schedule, then depreciation' },
      { value: 'stock', label: 'Stock bought for sale or use — counted when it is used' },
      { value: 'finance', label: 'Interest or finance charges — below the subtotal' },
      { value: 'deposit', label: 'A refundable deposit — the clinic still owns it' },
      { value: 'advance', label: 'An advance to a supplier — owed back to the clinic' },
      { value: 'financing_capital', label: 'Loan principal — not a cost at all' },
    ] })}
        ${UI.field({ name: 'department', label: 'Usual department',
    options: catalogue.departments.map((d) => ({ value: d.key, label: d.label })) })}
        ${UI.field({ name: 'items', label: 'Items under it', type: 'textarea', rows: 4,
    placeholder: 'One per line — the things the clinic actually buys under this heading' })}
      </form>`,
      footer: `<button class="btn ghost" data-act="__close">Cancel</button>
               <button class="btn" data-act="save">Add it</button>`,
      async onAction(act, modal) {
        if (act !== 'save') return undefined;
        const form = modal.querySelector('#hd-form');
        if (!form.reportValidity()) return 'keep';
        const values = UI.formValues(form);
        try {
          await API.post('/api/expenses/categories', {
            ...values,
            items: String(values.items || '').split('\n').map((s) => s.trim()).filter(Boolean),
          });
          UI.ok('Added. The counter can book to it now.');
          catalogue = null;
          if (onSaved) await onSaved();
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  async function editHeading(id, onSaved) {
    const data = await API.get('/api/expenses/categories?all=1');
    const row = data.groups.flatMap((g) => g.categories).find((c) => c.id === id);
    if (!row) return UI.err('That heading has gone.');

    UI.modal({
      title: row.name,
      size: 'wide',
      body: `
        <form id="hd-edit" class="grid c2">
          ${UI.field({ name: 'name', label: 'Heading', value: row.name, required: true })}
          ${UI.field({ name: 'department', label: 'Usual department',
    options: catalogue.departments.map((d) => ({ value: d.key, label: d.label })) })}
          ${UI.field({ name: 'note', label: 'Note for whoever books to it', value: row.note || '' })}
          <label class="field"><span>Offered to the counter</span>
            <select name="active"><option value="true"${row.active ? ' selected' : ''}>Yes</option>
              <option value="false"${row.active ? '' : ' selected'}>No — switched off</option></select></label>
        </form>
        ${row.seeded ? `<div class="muted small">This heading ships with the system. Its wording and
          its items are yours to change; which group and nature it has are what the reports are
          built on, so those stay.</div>` : ''}

        <h4 class="mt">Items</h4>
        <div id="hd-items">${row.items.length ? row.items.map((i) =>
    `<div class="row-between" style="padding:3px 0">
             <span${i.active ? '' : ' class="muted"'}>${UI.esc(i.name)}
               ${i.active ? '' : UI.badge('Off', 'warn')}</span>
             <button class="btn ghost sm" data-del-item="${i.id}">${i.active ? 'Remove' : 'Removed'}</button>
           </div>`).join('') : '<p class="muted">No items yet.</p>'}</div>
        <div class="mt">
          <input id="hd-new-item" placeholder="Add an item" style="max-width:260px">
          <button class="btn ghost sm" id="hd-add-item">Add</button>
        </div>`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="save">Save</button>`,
      onMount(modal) {
        modal.querySelector('[name=department]').value = row.default_department;
        modal.querySelector('#hd-add-item').addEventListener('click', async () => {
          const name = modal.querySelector('#hd-new-item').value.trim();
          if (!name) return;
          try {
            await API.post(`/api/expenses/categories/${id}/items`, { name });
            UI.ok('Added.');
            UI.closeModal();
            catalogue = null;
            await loadCatalogue(true);
            if (onSaved) await onSaved();
            editHeading(id, onSaved);
          } catch (err) { UI.err(err.message); }
        });
        modal.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', async () => {
          try {
            await API.del(`/api/expenses/items/${b.dataset.delItem}`);
            UI.ok('Taken off the list.');
            UI.closeModal();
            catalogue = null;
            await loadCatalogue(true);
            if (onSaved) await onSaved();
            editHeading(id, onSaved);
          } catch (err) { UI.err(err.message); }
        }));
      },
      async onAction(act, modal) {
        if (act !== 'save') return undefined;
        const values = UI.formValues(modal.querySelector('#hd-edit'));
        try {
          await API.patch(`/api/expenses/categories/${id}`, {
            ...values, active: values.active === 'true',
          });
          UI.ok('Saved.');
          catalogue = null;
          if (onSaved) await onSaved();
        } catch (err) {
          UI.err(err.message);
          return 'keep';
        }
        return undefined;
      },
    });
  }

  window.ExpenseBook = { bookTab, reportTab, headingsTab, openExpense, isManagement };
})();
