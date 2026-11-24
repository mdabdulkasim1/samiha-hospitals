/* Printed stock sheets — the paper somebody walks the store with. */
(function () {
  'use strict';
  /**
   * A list on paper, with a column left empty on purpose.
   *
   * Both the consumables shelf and the asset register are checked the same
   * way: somebody takes a list round the building, counts what is actually
   * there, writes it in the margin, and then corrects the ERP from what they
   * wrote. So the sheet prints what the system currently believes beside a
   * ruled blank for what was found — a sheet without the system's figure is
   * a stocktake from scratch, and one without the blank is a report nobody
   * can do anything with while standing in the store room.
   *
   * It prints exactly the rows on the screen, under exactly the filters in
   * force, and says so at the top. A sheet that quietly printed everything
   * when the screen showed one cupboard would be checked against the wrong
   * shelf and come out "wrong" every time.
   */

  const esc = (s) => UI.esc(s == null ? '' : String(s));
  const num = (n) => UI.num(Math.round((Number(n) || 0) * 100) / 100);

  /** The house style for a sheet somebody writes on. */
  const styles = (landscape) => `
    <style>
      @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm 10mm; }
      body { font: 11px/1.35 "Segoe UI", system-ui, sans-serif; color: #111; margin: 0; }
      .cs-head { border-bottom: 2px solid #9E1B34; padding-bottom: 6px; margin-bottom: 10px; }
      .cs-clinic { font: 700 15px/1.2 Georgia, "Times New Roman", serif; color: #9E1B34;
        letter-spacing: .3px; }
      .cs-where { font-size: 10px; color: #444; margin-top: 1px; }
      .cs-title { font-size: 13px; font-weight: 700; margin-top: 6px; }
      .cs-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 10px;
        color: #444; margin-top: 3px; }
      .cs-meta b { color: #111; font-weight: 600; }

      table { width: 100%; border-collapse: collapse; }
      /* The headings have to come back at the top of every sheet, or page
         four is a grid of unlabelled numbers. */
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
      th, td { border: 1px solid #BBB; padding: 3px 5px; vertical-align: top; }
      th { background: #F2F4F5; font-size: 9.5px; text-transform: uppercase;
        letter-spacing: .4px; text-align: left;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
      .sub { font-size: 9px; color: #555; }
      /* The column that is the point of the sheet. Wide enough to write a
         number in with a pen, and tinted so nobody fills in the wrong one. */
      .write { background: #FFFDF2; min-width: 22mm;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .write-wide { background: #FFFDF2; min-width: 40mm;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .cs-note { font-size: 9.5px; color: #444; margin: 8px 0 0; }
      .cs-sign { display: flex; gap: 30px; margin-top: 16px; page-break-inside: avoid; }
      .cs-sign div { flex: 1; border-top: 1px solid #777; padding-top: 3px;
        font-size: 9.5px; color: #444; }
    </style>`;

  /** Who printed it, from where, under which filters, and when. */
  function head(title, filters, note) {
    const c = (window.APP && APP.clinic) || {};
    const branch = (window.APP && APP.branch) || null;
    const who = (window.APP && APP.user) ? APP.user.name : '';
    const at = new Date();
    const shown = Object.entries(filters || {})
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`);

    return `<div class="cs-head">
        <div class="cs-clinic">${esc(c.name || 'SAMIHA HEALTHCARE')}</div>
        <div class="cs-where">${esc(branch ? `${branch.name} (${branch.code})`
    : (c.address || ''))}</div>
        <div class="cs-title">${esc(title)}</div>
        <div class="cs-meta">
          <span><b>Printed:</b> ${esc(UI.dateShort(at.toISOString()))}
            ${esc(at.toTimeString().slice(0, 5))}</span>
          ${who ? `<span><b>By:</b> ${esc(who)}</span>` : ''}
          ${shown.join('')}
        </div>
      </div>
      ${note ? `<p class="cs-note">${note}</p>` : ''}`;
  }

  const sign = (left, right) => `<div class="cs-sign">
      <div>${esc(left)} — name, signature, date</div>
      <div>${esc(right)} — name, signature, date</div>
    </div>`;

  const CountSheet = {
    /**
     * The consumables shelf.
     *
     * Available is what the ERP makes it after every receipt and issue; the
     * blank beside it is what is actually on the shelf. The two differing is
     * the whole reason for walking round, so they are printed next to each
     * other rather than on separate lines.
     */
    consumables(rows, { filters = {}, title = 'Consumables — stock count sheet' } = {}) {
      if (!rows || !rows.length) return UI.err('Nothing to print.');

      const body = rows.map((r) => `
        <tr>
          <td>${esc(r.name)}${r.description ? `<div class="sub">${esc(r.description)}</div>` : ''}</td>
          <td>${esc(r.area_label || r.area || '')}</td>
          <td>${esc(r.unit || '')}</td>
          <td class="n">${r.movements ? num(r.on_hand) : '—'}</td>
          <td class="n">${num(r.indent_qty)}</td>
          <td class="write"></td>
          <td class="write-wide"></td>
        </tr>`).join('');

      UI.print(`${styles(false)}
        ${head(title, filters,
    'Walk the store with this. Write what you actually find in <b>Counted</b>, and anything '
          + 'worth saying — damaged, expired, found elsewhere — in <b>Remarks</b>. Then open '
          + 'Consumables Store in the ERP and press <b>Count</b> on each line that differs. '
          + 'Nothing changes in the system until somebody enters it.')}
        <table>
          <thead><tr>
            <th>Item</th><th>Where</th><th>Unit</th>
            <th class="n">ERP says</th><th class="n">Should hold</th>
            <th class="write">Counted</th><th class="write-wide">Remarks</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        <p class="cs-note">${UI.num(rows.length)} item(s) on this sheet.</p>
        ${sign('Counted by', 'Checked by')}`,
      title, { standalone: true, width: 900, watermark: false });
    },

    /**
     * The medicine shelf.
     *
     * The pharmacy's own list, as the stock register shows it: what the
     * month opened with, what came in, what went out, and what the ERP
     * therefore believes is on the shelf — with the blank beside it for
     * what is actually there. Expired stock gets its own column, because
     * the quantity that matters when ordering is the sellable one.
     *
     * The rate and the value print only when the person printing can see
     * them on the screen: a sheet that carried the stock's worth round the
     * building for anybody to read would be a different document.
     */
    medicines(rows, { filters = {}, withValue = false, totals = null,
      title = 'Pharmacy — stock list' } = {}) {
      if (!rows || !rows.length) return UI.err('Nothing to print.');

      const body = rows.map((r) => `
        <tr>
          <td>${esc(r.name)}<div class="sub">${esc(r.code || '')}${
    r.strength || r.form ? ` · ${esc([r.strength, r.form].filter(Boolean).join(' '))}` : ''}</div></td>
          <td class="n">${num(r.opening)}</td>
          <td class="n">${num(r.inward)}</td>
          <td class="n">${num(r.outward)}</td>
          <td class="n">${num(r.on_hand)}</td>
          <td class="n">${r.expired_qty ? num(r.expired_qty) : '—'}</td>
          ${withValue ? `<td class="n">${r.unit_rate > 0 ? num(r.unit_rate) : '—'}</td>
          <td class="n">${r.unit_rate > 0 ? num(r.value) : '—'}</td>` : ''}
          <td class="write"></td>
          <td class="write-wide"></td>
        </tr>`).join('');

      UI.print(`${styles(true)}
        ${head(title, filters,
    'What the ERP believes is on the shelf, medicine by medicine. Write what you actually '
          + 'count in <b>Counted</b> and anything worth saying — damaged, expired, wrong batch '
          + '— in <b>Remarks</b>. Then correct it in the ERP from Pharmacy → Stock register, '
          + 'where the on-hand figure can be set against each medicine.')}
        <table>
          <thead><tr>
            <th>Medicine</th>
            <th class="n">Opening</th><th class="n">Received</th><th class="n">Issued</th>
            <th class="n">ERP says</th><th class="n">Expired</th>
            ${withValue ? '<th class="n">Unit rate</th><th class="n">Value</th>' : ''}
            <th class="write">Counted</th><th class="write-wide">Remarks</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        <p class="cs-note">${UI.num(rows.length)} medicine(s) on this sheet.${
  totals && withValue ? ` Stock value as the ERP has it: ${esc(UI.money(totals.stockValue))}${
    totals.unrated ? ` — ${UI.num(totals.unrated)} medicine(s) have no unit rate and are not in it`
      : ''}.` : ''}</p>
        ${sign('Counted by', 'Checked by')}`,
      title, { standalone: true, width: 1100, watermark: false });
    },

    /**
     * The asset register.
     *
     * Physical verification rather than a count: each machine is either
     * there and working or it is not, so the blanks are "seen" and a line
     * for the condition. The asset code is printed because that is what is
     * on the sticker somebody will be reading off the machine.
     */
    assets(rows, { filters = {}, title = 'Asset register — verification sheet' } = {}) {
      if (!rows || !rows.length) return UI.err('Nothing to print.');

      const due = (r) => {
        if (!r.calibration_due) return r.needs_calibration ? 'No date yet' : '—';
        return UI.dateShort(r.calibration_due);
      };

      const body = rows.map((r) => `
        <tr>
          <td>${esc(r.name)}<div class="sub">${esc(r.asset_no || '')}${
    r.make || r.model ? ` · ${esc([r.make, r.model].filter(Boolean).join(' '))}` : ''}</div></td>
          <td>${esc(r.asset_code || '—')}${r.serial_no
    ? `<div class="sub">S/N ${esc(r.serial_no)}</div>` : ''}</td>
          <td>${esc(r.category || '')}</td>
          <td>${esc(r.location || r.department_name || '—')}</td>
          <td class="n">${num(r.quantity || 1)}</td>
          <td>${esc(UI.titleise(r.status || ''))}</td>
          <td>${esc(due(r))}</td>
          <td class="write"></td>
          <td class="write-wide"></td>
        </tr>`).join('');

      UI.print(`${styles(true)}
        ${head(title, filters,
    'Walk the building with this. Tick <b>Seen</b> against each machine you physically find, '
          + 'and note anything wrong — moved, not working, missing, due for service — in '
          + '<b>Condition / where found</b>. Then correct the register in the ERP: an asset '
          + 'that has moved needs its location changed, and one nobody can find should be '
          + 'marked accordingly rather than quietly left on the list.')}
        <table>
          <thead><tr>
            <th>Asset</th><th>Asset code</th><th>Category</th><th>Where the ERP says</th>
            <th class="n">Qty</th><th>Status</th><th>Calibration due</th>
            <th class="write">Seen</th><th class="write-wide">Condition / where found</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        <p class="cs-note">${UI.num(rows.length)} asset(s) on this sheet.</p>
        ${sign('Verified by', 'Checked by')}`,
      title, { standalone: true, width: 1100, watermark: false });
    },
  };

  window.CountSheet = CountSheet;
}());
