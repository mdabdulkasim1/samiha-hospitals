/**
 * The sticker that goes on the thing itself.
 *
 * Fifty millimetres by twenty-five, which is small — about the size of two
 * postage stamps — and most of it has to be barcode, because the whole
 * point is that somebody with a scanner can find the asset without typing
 * anything. What is left over goes to the code in readable letters, since
 * the second most common way this label is used is somebody reading it out
 * over the phone.
 *
 * What is deliberately NOT on it: the make, the model, the price, the
 * purchase date in words. All of that is in the register, one scan away,
 * and a label crowded with it is a label whose barcode no longer scans.
 * The code itself already carries the item, the month and the branch.
 */
(function () {
  'use strict';

  const BADGE = 'SAMIHA HEALTHCARE';
  const SIZE = { w: 50, h: 25 };

  const esc = (s) => UI.esc(s === null || s === undefined ? '' : s);

  /**
   * One sticker.
   *
   * The barcode is Code 128-B of the asset code exactly — not the row id,
   * not the asset number. A label that scans as something else is worse
   * than one that does not scan at all, because the second gets checked by
   * hand and the first does not.
   */
  function label(asset) {
    const code = asset.asset_code || asset.asset_no;
    const bars = window.Barcode
      ? Barcode.svg(code, { module: 1.05, height: 26, showText: false })
      : '';
    return `
      <div class="asset-label">
        <div class="al-badge">${esc(BADGE)}</div>
        <div class="al-bars">${bars}</div>
        <div class="al-code">${esc(code)}</div>
        <div class="al-name">${esc(shorten(asset.name, 38))}</div>
      </div>`;
  }

  /*
   * The name is on the label as a courtesy to a person reading it, so it is
   * cut rather than wrapped: two lines of name would push the barcode down
   * and off a 25 mm sticker.
   */
  function shorten(name, max) {
    const s = String(name || '').split(/[—–(]/)[0].trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function styles() {
    return `<style>
      @page { size: ${SIZE.w}mm ${SIZE.h}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .asset-label {
        width: ${SIZE.w}mm; height: ${SIZE.h}mm; box-sizing: border-box;
        padding: 1.2mm 1.5mm; overflow: hidden; page-break-inside: avoid;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #000;
        display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .al-badge { font-size: 6.2px; font-weight: 700; letter-spacing: .09em; line-height: 1; }
      .al-bars { margin-top: .6mm; height: 26px; }
      .al-bars svg { display: block; }
      /* Tabular figures so a column of labels lines up on the roll. */
      .al-code { font-size: 8.6px; font-weight: 700; letter-spacing: .02em;
        font-variant-numeric: tabular-nums; margin-top: .3mm; }
      .al-name { font-size: 6px; color: #000; margin-top: .2mm; line-height: 1.1;
        max-width: 46mm; white-space: nowrap; overflow: hidden; }
      @media screen { .asset-label { border: 1px solid #DFE6EA; } }
    </style>`;
  }

  /**
   * Print labels: one asset many times, or many assets once each.
   *
   * No watermark and no application stylesheet. app.css carries an @page
   * rule that would quietly resize the roll, and a tint printed across a
   * barcode costs the scanner reads the label exists to make.
   */
  function print(assets, { copies = 1 } = {}) {
    const list = Array.isArray(assets) ? assets : [assets];
    const withCode = list.filter((a) => a.asset_code || a.asset_no);
    if (!withCode.length) {
      UI.err('None of these have an asset code yet — create the codes first.');
      return;
    }
    const n = Math.max(1, Math.min(40, Number(copies) || 1));
    const sheets = [];
    for (const asset of withCode) {
      for (let i = 0; i < n; i += 1) sheets.push(label(asset));
    }
    // A page break between stickers: a roll printer advances one label per
    // page, and without this they come out overlapping on one long sheet.
    const html = styles() + sheets.join('<div style="page-break-after:always"></div>');
    UI.print(html, withCode.length === 1
      ? `Asset label ${withCode[0].asset_code || withCode[0].asset_no}`
      : `Asset labels (${withCode.length})`,
    { standalone: true, watermark: false, width: 320, height: 520 });
  }

  /** On screen, at the size it will come out of the printer. */
  const preview = (asset) => `<div class="asset-label-preview">${styles()}${label(asset)}</div>`;

  window.AssetLabel = { print, preview, label, styles, SIZE };
}());
