/* =============================================================================
   The documents this company puts its name on.
   One stylesheet and one letterhead, so a quotation, an LPO, a delivery note
   and a tax invoice read as one company's paperwork.
   ========================================================================== */
(function () {
  'use strict';
  const esc = (v) => UI.esc(v);

  /**
   * Open a window now, fill it later.
   *
   * A browser only allows window.open while it is still handling the click that
   * asked for it. Anything that has to fetch before it can print loses that
   * permission during the await, and the window is silently blocked — so the
   * window is claimed on the click and handed to render() when it is ready.
   */
  function openWindow() {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) { UI.err('Allow pop-ups to print this document.'); return null; }
    w.document.write('<!DOCTYPE html><html><head><title>Preparing…</title></head>'
      + '<body style="font:14px system-ui;padding:24px;color:#67788A">Preparing the document…</body></html>');
    w.document.close();
    return w;
  }

  function render(windowRef, title, bodyHtml) {
    const w = windowRef || window.open('', '_blank', 'width=900,height=1100');
    if (!w) return UI.err('Allow pop-ups to print this document.');
    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
      + styles() + `</head><body>${watermark()}${bodyHtml}</body></html>`);
    w.document.close();
    const go = () => { try { w.focus(); w.print(); } catch { /* window closed */ } };
    if (w.document.readyState === 'complete') setTimeout(go, 80);
    else w.addEventListener('load', go, { once: true });
  }

  /*
   * A4 portrait, because that is what a trading document is. The body is set in
   * a sans with lining, tabular figures: every number on these sheets is one
   * somebody has to read exactly, and a column of quantities that does not line
   * up is a column that gets misread.
   */
  function styles() {
    return `<style>
      @page { size: A4 portrait; margin: 12mm 12mm 16mm; }

      /*
       * The company's mark, ghosted behind the page.
       *
       * Fixed rather than absolute, so the browser repeats it on every sheet of
       * a document that runs to several pages; painted over the content rather
       * than under it, because the sheet draws its own white page and anything
       * beneath would simply be hidden; and at four to five per cent it tints
       * the paper without competing with a single line of text.
       */
      .watermark {
        position: fixed; inset: 0; z-index: 9999; pointer-events: none;
        display: flex; align-items: center; justify-content: center;
      }
      .watermark img {
        width: 58%; max-width: 125mm; opacity: .055;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      /* Ink is dearer than pixels, and paper shows a tint more readily. */
      @media print { .watermark img { opacity: .04; } }
      body {
        margin: 0; color: #16232B; background: #EEF2F5;
        font: 10.5px/1.45 "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
        font-variant-numeric: lining-nums tabular-nums; -webkit-font-smoothing: antialiased;
      }
      .doc { background: #fff; margin: 0 auto; }
      @media screen { body { padding: 16px 0; } .doc { width: 210mm; min-height: 297mm; padding: 12mm; box-sizing: border-box; box-shadow: 0 2px 16px rgba(0,0,0,.2); } }
      @media print { body { background: #fff; padding: 0; } .doc { width: auto; padding: 0; box-shadow: none; } }

      .head { display: flex; align-items: flex-start; gap: 14px; border-bottom: 2px solid #0E3A5C; padding-bottom: 9px; }
      .head .logo { width: 74px; flex: 0 0 74px; }
      .head .logo img { width: 100%; }
      .head .who { flex: 1; }
      .head .who .name { font: 700 17px Georgia, "Times New Roman", serif; color: #0E3A5C; letter-spacing: .4px; }
      .head .who .tag { font-size: 8px; letter-spacing: 1.6px; text-transform: uppercase; color: #14663F; margin-top: 2px; font-weight: 600; }
      .head .who .addr { font-size: 9px; color: #67788A; margin-top: 3px; line-height: 1.5; }
      .head .trn { text-align: right; font-size: 9.5px; }
      .head .trn b { display: block; font-size: 11px; color: #0E3A5C; }

      .doc-title {
        margin: 10px 0 2px; text-align: center; font-size: 12.5px; font-weight: 700;
        letter-spacing: 3.4px; text-transform: uppercase; color: #0E3A5C;
      }
      .doc-app {
        text-align: center; font-size: 9.5px; letter-spacing: 1.6px; text-transform: uppercase;
        color: #0E4E2F; background: #E3F0E9; border-radius: 3px; padding: 3px 8px;
        display: inline-block; margin: 0 auto 8px; font-weight: 700;
      }
      .app-wrap { text-align: center; }

      .parties { display: flex; gap: 12px; margin-top: 8px; }
      .parties .box { flex: 1; border: 1px solid #DDE5EC; border-radius: 4px; padding: 7px 9px; }
      .parties .box .k {
        font-size: 7.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #93A3B3;
        font-weight: 700; margin-bottom: 3px;
      }
      .parties .box .v { font-size: 11px; font-weight: 700; }
      .parties .box .m { font-size: 9.2px; color: #67788A; line-height: 1.5; margin-top: 2px; }

      .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 12px; margin-top: 8px; }
      .meta > div { min-width: 0; }
      .meta .k { font-size: 7.5px; letter-spacing: 1px; text-transform: uppercase; color: #93A3B3; font-weight: 700; }
      .meta .v { font-size: 10.5px; font-weight: 600; margin-top: 1px; }

      table.items { width: 100%; border-collapse: collapse; margin-top: 10px; }
      table.items th {
        background: #0E3A5C; color: #fff; font-size: 8px; letter-spacing: .8px; text-transform: uppercase;
        padding: 6px 5px; text-align: left; font-weight: 700;
      }
      table.items td { padding: 6px 5px; border-bottom: 1px solid #EDF2F6; vertical-align: top; font-size: 9.8px; }
      table.items tr:nth-child(even) td { background: #FAFCFD; }
      table.items .num { text-align: right; white-space: nowrap; }
      table.items .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9px; color: #16537F; }
      table.items .desc b { font-size: 10.2px; }
      table.items .desc .spec { color: #67788A; font-size: 9px; display: block; }

      .totals { display: flex; justify-content: flex-end; margin-top: 9px; }
      .totals table { border-collapse: collapse; min-width: 74mm; }
      .totals td { padding: 3.5px 9px; font-size: 10.2px; }
      .totals td.k { color: #67788A; }
      .totals td.v { text-align: right; font-weight: 600; }
      .totals tr.grand td { border-top: 1.4px solid #0E3A5C; font-size: 12px; font-weight: 700; padding-top: 6px; color: #0E3A5C; }
      .words { margin-top: 6px; font-size: 9.6px; font-style: italic; color: #16232B; }
      .words b { font-style: normal; }

      .block { margin-top: 11px; }
      .block .k {
        font-size: 7.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #93A3B3; font-weight: 700;
      }
      .block p { margin: 2px 0 0; white-space: pre-wrap; font-size: 9.6px; line-height: 1.6; }
      .terms-band {
        margin-top: 9px; background: #F4F8FA; border-left: 3px solid #14663F; border-radius: 3px;
        padding: 7px 10px; font-size: 9.6px;
      }
      .terms-band b { color: #0E3A5C; }

      .lead { margin-top: 8px; font-size: 10px; color: #16232B; }
      .block.terms ol { margin: 3px 0 0; padding-left: 15px; }
      .block.terms li { font-size: 8.8px; line-height: 1.5; margin-bottom: 2px; }
      .buyer {
        margin-top: 11px; border: 1px solid #DDE5EC; border-radius: 4px; padding: 7px 9px;
        font-size: 9.2px; color: #16232B; display: inline-block; min-width: 62mm;
      }
      .buyer .k {
        font-size: 7.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #93A3B3;
        font-weight: 700; margin-bottom: 3px;
      }

      .sign { display: flex; gap: 30px; margin-top: 20px; }
      .sign .box { flex: 1; }
      .sign .line { border-bottom: 1px solid #16232B; height: 16mm; }
      .sign .cap {
        margin-top: 4px; font-size: 8px; letter-spacing: 1px; text-transform: uppercase;
        color: #93A3B3; font-weight: 700;
      }
      .foot {
        margin-top: 14px; border-top: 1px solid #DDE5EC; padding-top: 6px; text-align: center;
        font-size: 8.2px; color: #93A3B3; line-height: 1.6;
      }
      .bank { margin-top: 9px; border: 1px dashed #DDE5EC; border-radius: 4px; padding: 7px 9px; font-size: 9.2px; }
      .bank .k { font-size: 7.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #93A3B3; font-weight: 700; margin-bottom: 2px; }
      .stamp-note { font-size: 8.6px; color: #93A3B3; margin-top: 3px; }
      .paid-mark {
        display: inline-block; border: 2px solid #14663F; color: #14663F; border-radius: 4px;
        padding: 2px 10px; font-size: 12px; font-weight: 700; letter-spacing: 2px; transform: rotate(-3deg);
      }
    </style>`;
  }

  // ------------------------------------------------------------- fragments
  /** The mark, laid faintly behind whatever is printed. */
  const logoSrc = () => location.origin
    + (((window.APP && APP.company && APP.company.logo) || '/assets/logo-icon.svg'));

  const watermark = () => `<div class="watermark"><img src="${logoSrc()}" alt=""></div>`;

  function letterhead(company) {
    const c = company || (window.APP && APP.company) || {};
    return `<div class="head">
      <div class="logo"><img src="${logoSrc()}" alt=""></div>
      <div class="who">
        <div class="name">${esc(c.name || 'AKR GENERAL TRADING L.L.C')}</div>
        <div class="tag">${esc((window.APP && APP.tagline) || 'Trusted Trading Partner for Valves, Fittings & Construction Materials')}</div>
        <div class="addr">${esc(c.address || '')}${c.phone ? ' · T ' + esc(c.phone) : ''}${c.email ? ' · ' + esc(c.email) : ''}${c.website ? ' · ' + esc(c.website) : ''}</div>
      </div>
      <div class="trn">${c.trn ? `<b>TRN ${esc(c.trn)}</b>` : '<b class="stamp-note">TRN not set</b>'}</div>
    </div>`;
  }

  const title = (text, application) =>
    `<div class="doc-title">${esc(text)}</div>` +
    (application ? `<div class="app-wrap"><span class="doc-app">Application — ${esc(application)}</span></div>` : '<div style="height:6px"></div>');

  function party(label, name, lines) {
    return `<div class="box"><div class="k">${esc(label)}</div><div class="v">${esc(name || '—')}</div>
      <div class="m">${lines.filter(Boolean).map(esc).join('<br>')}</div></div>`;
  }

  const meta = (pairs) => `<div class="meta">${pairs.filter(Boolean)
    .map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v || '—')}</div></div>`).join('')}</div>`;

  /** The line table. `money` is off for a delivery note, which carries no prices. */
  function itemsTable(items, { money = true, columns } = {}) {
    const cols = columns || (money
      ? ['#', 'Item code', 'Description', 'Qty', 'Unit', 'Rate', 'Disc.', 'Taxable', 'VAT', 'Amount']
      : ['#', 'Item code', 'Description', 'Qty', 'Unit', 'Remarks']);
    const body = items.map((i, n) => {
      const desc = `<div class="desc"><b>${esc(i.description || i.name || '')}</b>`
        + (i.application_name ? `<span class="spec">${esc(i.application_name)}</span>` : '')
        + (i.remarks ? `<span class="spec">${esc(i.remarks)}</span>` : '')
        + '</div>';
      if (!money) {
        return `<tr><td class="num">${n + 1}</td><td class="code">${esc(i.item_code || '')}</td>
          <td>${desc}</td><td class="num">${UI.qty(i.qty)}</td><td>${esc(i.uom || '')}</td>
          <td>${esc(i.remarks || '')}</td></tr>`;
      }
      return `<tr>
        <td class="num">${n + 1}</td>
        <td class="code">${esc(i.item_code || '')}</td>
        <td>${desc}</td>
        <td class="num">${UI.qty(i.qty)}</td>
        <td>${esc(i.uom || '')}</td>
        <td class="num">${UI.money(i.unit_price, { symbol: false })}</td>
        <td class="num">${i.discount ? UI.money(i.discount, { symbol: false }) : '—'}</td>
        <td class="num">${UI.money(i.taxable, { symbol: false })}</td>
        <td class="num">${UI.money(i.vat_amount, { symbol: false })}</td>
        <td class="num">${UI.money(i.total, { symbol: false })}</td>
      </tr>`;
    }).join('');
    return `<table class="items"><thead><tr>${cols.map((c, i) =>
      `<th${i >= 3 && c !== 'Unit' && c !== 'Remarks' && c !== 'Description' ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function totalsBlock(doc, { words } = {}) {
    const cur = doc.currency || 'AED';
    return `<div class="totals"><table>
      <tr><td class="k">Sub-total</td><td class="v">${UI.money(doc.subtotal, { symbol: false })}</td></tr>
      ${doc.discount ? `<tr><td class="k">Less discount</td><td class="v">− ${UI.money(doc.discount, { symbol: false })}</td></tr>` : ''}
      <tr><td class="k">Taxable amount</td><td class="v">${UI.money(doc.subtotal - doc.discount, { symbol: false })}</td></tr>
      <tr><td class="k">VAT @ 5%</td><td class="v">${UI.money(doc.vat_amount, { symbol: false })}</td></tr>
      <tr class="grand"><td class="k">Total (${esc(cur)})</td><td class="v">${UI.money(doc.total, { symbol: false })}</td></tr>
    </table></div>` + (words ? `<div class="words"><b>Amount in words:</b> ${esc(words)}</div>` : '');
  }

  const termsBand = (label, text) =>
    `<div class="terms-band"><b>${esc(label)}:</b> ${esc(text || 'As agreed')}</div>`;

  const notes = (label, text) => (text
    ? `<div class="block"><div class="k">${esc(label)}</div><p>${esc(text)}</p></div>` : '');

  /**
   * The conditions, numbered, one to a line.
   *
   * Numbered on purpose: when a supplier rings about clause nine, both sides
   * need to be looking at the same clause nine.
   */
  function conditions(label, text) {
    const points = String(text || '').split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter(Boolean);
    if (!points.length) return '';
    return `<div class="block terms"><div class="k">${esc(label)}</div>
      <ol>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></div>`;
  }

  /** Who the order is from, as their own LPO prints it at the foot. */
  const buyerBlock = (company) => {
    const c = company || (window.APP && APP.company) || {};
    return `<div class="buyer"><div class="k">Buyer details</div>
      <b>${esc(c.name || '')}</b><br>${esc(c.address || '')}
      ${c.trn ? `<br>TRN: ${esc(c.trn)}` : ''}</div>`;
  };

  const signatures = (left, right) => `<div class="sign">
    <div class="box"><div class="line"></div><div class="cap">${esc(left)}</div></div>
    <div class="box"><div class="line"></div><div class="cap">${esc(right)}</div></div>
  </div>`;

  const footer = (company, extra) => {
    const c = company || (window.APP && APP.company) || {};
    return `<div class="foot">${esc(c.name || '')}${c.address ? ' · ' + esc(c.address) : ''}
      ${c.phone ? ' · ' + esc(c.phone) : ''}${c.email ? ' · ' + esc(c.email) : ''}
      ${extra ? '<br>' + esc(extra) : ''}</div>`;
  };

  const bankBlock = (c) => (c && (c.iban || c.bank_name || c.bankName)
    ? `<div class="bank"><div class="k">Bank details for payment</div>
        ${esc(c.bank_name || c.bankName || '')}${(c.bank_account || c.bankAccount) ? ' · A/C ' + esc(c.bank_account || c.bankAccount) : ''}
        ${c.iban ? ' · IBAN ' + esc(c.iban) : ''}${c.swift ? ' · SWIFT ' + esc(c.swift) : ''}</div>`
    : '');

  // ------------------------------------------------------------ documents
  /*
   * Each document is a builder returning { title, body }, and DOCS wraps it in
   * the renderer. Splitting them means the markup of an invoice can be built
   * and checked without opening a print window.
   */
  const BUILD = {
    /** Our quotation to a client. */
    salesQuotation(data) {
      const q = data.quotation;
      const company = { name: q.company_name, trn: q.company_trn, address: q.company_address,
        ...(window.APP ? APP.company : {}), name2: null };
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title('Quotation', q.application_name)}
        <div class="parties">
          ${party('To', q.client_name, [q.client_address, q.attention ? 'Attn: ' + q.attention : '',
            q.client_trn ? 'TRN ' + q.client_trn : ''])}
          ${party('Project', q.project || '—', [q.subject || '', q.enquiry_no ? 'Your enquiry ref: ' + q.enquiry_no : ''])}
        </div>
        ${meta([
          ['Quotation no.', q.quote_no],
          ['Date', UI.date(q.quote_date)],
          ['Valid until', UI.date(q.valid_until)],
          ['Delivery', q.delivery_days ? `${q.delivery_days} days from order` : (q.delivery_terms || 'Ex-stock')],
        ])}
        ${itemsTable(data.items)}
        ${totalsBlock(q, { words: data.amountInWords })}
        ${termsBand('Payment terms', data.termsText)}
        ${notes('Notes', q.notes)}
        ${conditions('Terms & conditions', q.terms_text)}
        ${signatures('For ' + (APP.company.name || 'AKR General Trading L.L.C'), 'Accepted by (client)')}
        ${footer(APP.company, 'This quotation is not a tax invoice.')}
      </div>`;
      return { title: `Quotation ${q.quote_no}`, body };
    },

    /** Our LPO to a manufacturer. */
    purchaseOrder(data) {
      const o = data.order;
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title('Local Purchase Order', o.application_name)}
        <div class="parties">
          ${party('To (supplier)', o.supplier_name, [o.supplier_address,
            o.supplier_contact ? 'Attn: ' + o.supplier_contact : '',
            o.supplier_trn ? 'TRN ' + o.supplier_trn : ''])}
          ${party('Deliver to', o.delivery_location || 'Main Yard',
            [o.delivery_address, o.project ? 'Project: ' + o.project : ''])}
        </div>
        ${meta([
          ['LPO no.', o.lpo_no],
          ['Date', UI.date(o.lpo_date)],
          ['Attn', o.attention || '—'],
          ['Supplier TRN', o.supplier_trn || '—'],
          ['Your quotation', o.supplier_quote_no || '—'],
          ['SO reference', o.against_sales_order || '—'],
          ['Incoterms', o.incoterms || '—'],
          ['Required by', UI.date(o.delivery_date)],
        ])}
        <div class="lead">We are pleased to place order for the below items.</div>
        ${itemsTable(data.items)}
        ${totalsBlock(o, { words: data.amountInWords })}
        ${termsBand('Payment terms', data.termsText)}
        ${o.authority ? `<div class="terms-band"><b>Approving authority:</b> ${esc(o.authority)}</div>` : ''}
        ${notes('Notes', o.notes)}
        ${conditions('Conditions of this order', o.terms_text)}
        ${buyerBlock(APP.company)}
        ${signatures('Authorised for ' + (APP.company.name || 'AKR'), 'Supplier acknowledgement')}
        ${footer(APP.company, 'Please quote this LPO number on your delivery note and invoice.')}
      </div>`;
      return { title: `LPO ${o.lpo_no}`, body };
    },

    /** What went out of the yard. No prices: a driver's copy is not a quotation. */
    deliveryNote(data) {
      const d = data.delivery;
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title('Delivery Note', d.application_name)}
        <div class="parties">
          ${party('Delivered to', d.client_name, [d.delivery_address || d.client_address,
            d.client_trn ? 'TRN ' + d.client_trn : ''])}
          ${party('Against', d.client_lpo_no ? 'Your LPO ' + d.client_lpo_no : (d.so_no || '—'),
            [d.so_no ? 'Our order ' + d.so_no : '', d.project ? 'Project: ' + d.project : ''])}
        </div>
        ${meta([
          ['Delivery note no.', d.dn_no],
          ['Date', UI.date(d.delivery_date)],
          ['Location', d.delivery_location || '—'],
          ['Site contact', [d.delivery_contact, d.delivery_mobile].filter(Boolean).join(' · ') || '—'],
          ['Vehicle', d.vehicle_no || '—'],
          ['Driver', d.driver_name || '—'],
        ])}
        ${itemsTable(data.items, { money: false })}
        ${data.collectCheque
          ? '<div class="terms-band"><b>Collect payment on delivery:</b> this client\'s terms are payment '
            + 'against the signed delivery note. Do not leave the site without the cheque.</div>' : ''}
        ${notes('Notes', d.notes)}
        <div class="sign">
          <div class="box"><div class="line"></div><div class="cap">Delivered by (driver)</div></div>
          <div class="box"><div class="line"></div>
            <div class="cap">Received in good condition — name, signature, date &amp; company stamp</div></div>
        </div>
        ${footer(APP.company, 'Goods remain the property of the seller until paid for in full.')}
      </div>`;
      return { title: `Delivery Note ${d.dn_no}`, body };
    },

    /**
     * The tax invoice. Everything the UAE requires on one is printed from what
     * was written onto the invoice when it was issued, not from today's master
     * records — so a reprint is the document that was issued.
     */
    taxInvoice(data) {
      const i = data.invoice;
      const company = {
        name: i.company_name, trn: i.company_trn, address: i.company_address,
        phone: APP.company.phone, email: APP.company.email, website: APP.company.website,
      };
      const body = `<div class="doc">
        ${letterhead(company)}
        ${title('Tax Invoice', i.application_name)}
        <div class="parties">
          ${party('Bill to', i.client_name, [i.client_address, i.client_trn ? 'TRN ' + i.client_trn : 'TRN not provided'])}
          ${party('Reference', i.client_lpo_no ? 'Your LPO ' + i.client_lpo_no : (i.so_no || '—'),
            [i.dn_no ? 'Delivery note ' + i.dn_no : '', i.project ? 'Project: ' + i.project : '',
              i.place_of_supply ? 'Place of supply: ' + i.place_of_supply : ''])}
        </div>
        ${meta([
          ['Invoice no.', i.invoice_no],
          ['Invoice date', UI.date(i.invoice_date)],
          ['Due date', UI.date(i.due_date)],
          ['Currency', i.currency || 'AED'],
        ])}
        ${itemsTable(data.items)}
        ${totalsBlock(i, { words: data.amountInWords })}
        ${i.paid_amount > 0
          ? `<div class="words"><b>Received:</b> ${UI.money(i.paid_amount)} ${
            i.status === 'paid' ? '<span class="paid-mark">PAID</span>' : ''}</div>` : ''}
        ${termsBand('Payment terms', data.termsText)}
        ${bankBlock(APP.company)}
        ${notes('Notes', i.notes)}
        ${signatures('For ' + (i.company_name || 'AKR General Trading L.L.C'), 'Received by')}
        ${footer(company, 'This is a computer-generated tax invoice issued under the UAE VAT law.')}
      </div>`;
      return { title: `Tax Invoice ${i.invoice_no}`, body };
    },

    /** The receipt a client is given for money paid. */
    receipt(data) {
      const p = data.payment;
      const rows = (data.allocations || []).map((a) => `<tr>
        <td>${esc(a.doc_no || '')}</td><td>${UI.date(a.invoice_date)}</td>
        <td class="num">${UI.money(a.invoice_total, { symbol: false })}</td>
        <td class="num">${UI.money(a.amount, { symbol: false })}</td></tr>`).join('');
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title(p.direction === 'in' ? 'Receipt Voucher' : 'Payment Voucher')}
        <div class="parties">
          ${party(p.direction === 'in' ? 'Received from' : 'Paid to', p.partner_name, [p.partner_code || ''])}
          ${party('Amount', UI.money(p.amount), [data.amountInWords || ''])}
        </div>
        ${meta([
          ['Voucher no.', p.payment_no],
          ['Date', UI.date(p.payment_date)],
          ['Mode', UI.titleise(p.mode)],
          [p.mode === 'cheque' ? 'Cheque' : 'Reference',
            p.mode === 'cheque' ? `${p.cheque_no || ''} · ${UI.date(p.cheque_date)}` : (p.reference || '—')],
        ])}
        ${rows ? `<table class="items"><thead><tr><th>Against invoice</th><th>Invoice date</th>
          <th class="num">Invoice total</th><th class="num">Applied</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<div class="block"><p>Received on account — not yet applied to a specific invoice.</p></div>'}
        ${p.amount - p.allocated > 0.005
          ? `<div class="terms-band"><b>On account:</b> ${UI.money(p.amount - p.allocated)} of this
             ${p.direction === 'in' ? 'receipt' : 'payment'} is not yet applied to an invoice.</div>` : ''}
        ${notes('Notes', p.notes)}
        ${signatures('Received by', 'Authorised signatory')}
        ${footer(APP.company, p.mode === 'cheque'
          ? 'Cheques are subject to realisation.' : '')}
      </div>`;
      return { title: `${p.direction === 'in' ? 'Receipt' : 'Payment'} ${p.payment_no}`, body };
    },

    /** The statement a client is sent when they ask what they owe. */
    statement(data) {
      const l = data.ledger;
      const rows = l.rows.map((r) => `<tr>
        <td>${UI.date(r.date)}</td><td>${esc(r.particulars)}</td>
        <td>${r.due_date ? UI.date(r.due_date) : ''}</td>
        <td class="num">${r.debit ? UI.money(r.debit, { symbol: false }) : ''}</td>
        <td class="num">${r.credit ? UI.money(r.credit, { symbol: false }) : ''}</td>
        <td class="num">${UI.money(r.balance, { symbol: false })}</td></tr>`).join('');
      const a = data.ageing.buckets;
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title('Statement of Account')}
        <div class="parties">
          ${party('Account', data.partner.name, [data.partner.address || '',
            data.partner.trn ? 'TRN ' + data.partner.trn : '', data.partner.code])}
          ${party('Closing balance', UI.money(l.closing),
            [`As at ${UI.date(data.as_of)}`, l.closing >= 0 ? 'Due to us' : 'In their favour'])}
        </div>
        <table class="items"><thead><tr><th>Date</th><th>Particulars</th><th>Due</th>
          <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
          <tbody>
            <tr><td>${UI.date(l.rows.length ? l.rows[0].date : data.as_of)}</td>
              <td><i>Opening balance</i></td><td></td><td class="num"></td><td class="num"></td>
              <td class="num">${UI.money(l.opening, { symbol: false })}</td></tr>
            ${rows}
          </tbody></table>
        <div class="totals"><table>
          <tr><td class="k">Not yet due</td><td class="v">${UI.money(a.not_due, { symbol: false })}</td></tr>
          <tr><td class="k">1 – 30 days</td><td class="v">${UI.money(a.d0_30, { symbol: false })}</td></tr>
          <tr><td class="k">31 – 60 days</td><td class="v">${UI.money(a.d31_60, { symbol: false })}</td></tr>
          <tr><td class="k">61 – 90 days</td><td class="v">${UI.money(a.d61_90, { symbol: false })}</td></tr>
          <tr><td class="k">Over 90 days</td><td class="v">${UI.money(a.d90_plus, { symbol: false })}</td></tr>
          <tr class="grand"><td class="k">Outstanding</td><td class="v">${UI.money(data.ageing.total, { symbol: false })}</td></tr>
        </table></div>
        ${bankBlock(APP.company)}
        ${footer(APP.company, 'Please advise of any discrepancy within seven days of receipt.')}
      </div>`;
      return { title: `Statement — ${data.partner.name}`, body };
    },

    /** What came into the yard, and from whom. */
    grn(data) {
      const g = data.grn;
      const body = `<div class="doc">
        ${letterhead(APP.company)}
        ${title('Goods Receipt Note')}
        <div class="parties">
          ${party('Received from', g.supplier_name, [g.supplier_code || ''])}
          ${party('Against', g.lpo_no ? 'Our LPO ' + g.lpo_no : 'No LPO',
            [g.supplier_dn_ref ? 'Their DN ' + g.supplier_dn_ref : '', g.project ? 'Project: ' + g.project : ''])}
        </div>
        ${meta([
          ['GRN no.', g.grn_no],
          ['Received on', UI.date(g.received_date)],
          ['Location', g.location_name || '—'],
          ['Vehicle', g.vehicle_no || '—'],
        ])}
        <table class="items"><thead><tr><th class="num">#</th><th>Item code</th><th>Description</th>
          <th class="num">Accepted</th><th class="num">Rejected</th><th>Unit</th><th>Remarks</th></tr></thead>
          <tbody>${data.items.map((i, n) => `<tr><td class="num">${n + 1}</td>
            <td class="code">${esc(i.item_code || '')}</td><td>${esc(i.description || '')}</td>
            <td class="num">${UI.qty(i.qty)}</td><td class="num">${i.rejected_qty ? UI.qty(i.rejected_qty) : '—'}</td>
            <td>${esc(i.uom || '')}</td><td>${esc(i.remarks || '')}</td></tr>`).join('')}</tbody></table>
        ${notes('Notes', g.notes)}
        ${signatures('Inspected by ' + (g.inspected_by || ''), 'Store in-charge')}
        ${footer(APP.company)}
      </div>`;
      return { title: `GRN ${g.grn_no}`, body };
    },
  };

  /** Build a document and print it. `w` is a window claimed on the click. */
  const DOCS = {};
  for (const kind of Object.keys(BUILD)) {
    DOCS[kind] = (data, w) => {
      const doc = BUILD[kind](data);
      render(w, doc.title, doc.body);
      return doc;
    };
  }

  window.PRINT = { openWindow, render, styles, watermark, letterhead, BUILD, DOCS };
})();
