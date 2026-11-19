/**
 * The token slip, for the 70 mm roll at the front desk.
 *
 * What a patient does with this is read one number off it and then look for
 * that number on a screen or listen for it being called. So the number is
 * the slip: as large as 70 mm of paper allows, and nothing is put near it
 * that competes for the eye. Underneath, in ordinary type, the three things
 * they will otherwise have to ask somebody — which clinic, which floor,
 * which room — and how many people are in front of them.
 *
 * A thermal head prints one shade of black with no greyscale worth the
 * name, so everything here is pure black on white: no tints, no logo
 * ghosted behind the number, no hairline rules that come out as speckle.
 * The roll is 70 mm wide and the head covers about 66 mm of it, which is
 * what the page is set to.
 */
(function () {
  'use strict';

  const BADGE = 'SAMIHA HEALTHCARE';
  // Printable width of a 70 mm roll. Set here rather than inline because a
  // clinic that later buys an 80 mm printer changes one number.
  const WIDTH_MM = 66;

  const esc = (s) => UI.esc(s === null || s === undefined ? '' : s);

  /** 'Booked 10:15' or nothing at all — a walk-in has no time to print. */
  function bookedLine(slip) {
    if (!slip.booked || !slip.scheduledAt) return '';
    return `<div class="t-line">Appointment ${esc(String(slip.scheduledAt).slice(11, 16))}</div>`;
  }

  /*
   * How many are in front of them, and — only where the morning has
   * actually produced enough consultations to measure — roughly how long
   * that is. A number of minutes invented from a slot length is a promise
   * the clinic never made, so without the measurement the slip says the
   * count and stops.
   */
  function waitLine(slip) {
    if (slip.ahead === null || slip.ahead === undefined) return '';
    if (slip.ahead === 0) return '<div class="t-line t-wait">You are next</div>';
    const people = `${slip.ahead} ahead of you`;
    return `<div class="t-line t-wait">${esc(people)}${slip.waitMinutes
      ? ` · about ${esc(Math.round(slip.waitMinutes))} min` : ''}</div>`;
  }

  function slipHtml(slip) {
    const when = String(slip.printedAt || '').slice(11, 16);
    const day = String(slip.printedAt || '').slice(0, 10);
    return `
      <div class="tslip">
        <div class="t-badge">${esc(slip.clinic || BADGE)}</div>
        <div class="t-sub">Nethaji Road, Melapalayam</div>
        <div class="t-rule"></div>

        <div class="t-cat">${esc(slip.category || '')}</div>
        <div class="t-number">${esc(slip.label)}</div>

        ${slip.room || slip.floor ? `<div class="t-room">
          ${esc(slip.floor || '')}${slip.floor && slip.room ? ' · ' : ''}${esc(slip.room || '')}
        </div>` : '<div class="t-room t-ask">Ask at the front desk for your room</div>'}
        ${slip.doctor ? `<div class="t-line">${esc(slip.doctor)}</div>` : ''}
        ${bookedLine(slip)}
        ${waitLine(slip)}

        <div class="t-rule"></div>
        ${slip.token && slip.token.patient_name
          ? `<div class="t-line t-small">${esc(slip.token.patient_name)}${slip.token.uhid
            ? ` · ${esc(slip.token.uhid)}` : ''}</div>` : ''}
        <div class="t-line t-small">${esc(day)} ${esc(when)}</div>
        <div class="t-foot">Please keep this slip and<br>watch for your number</div>
      </div>`;
  }

  function styles() {
    return `<style>
      @page { size: 70mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .tslip {
        width: ${WIDTH_MM}mm; margin: 0 auto; padding: 3mm 2mm 7mm;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: #000; text-align: center;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .t-badge { font-size: 12px; font-weight: 700; letter-spacing: .06em; }
      .t-sub { font-size: 9px; margin-top: 1px; }
      .t-rule { border-top: 1px dashed #000; margin: 2.5mm 0; }
      .t-cat { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
      /*
       * The number itself. Big enough to read from across a waiting room at
       * arm's length, and tabular figures so 08-111 is as wide as 08-999.
       */
      .t-number {
        font-size: 50px; line-height: 1.04; font-weight: 800; letter-spacing: .01em;
        margin: 1mm 0 1.5mm; font-variant-numeric: tabular-nums;
      }
      .t-room { font-size: 15px; font-weight: 700; }
      .t-ask { font-size: 11px; font-weight: 400; }
      .t-line { font-size: 11px; margin-top: 1mm; }
      .t-wait { font-weight: 700; }
      .t-small { font-size: 9.5px; }
      .t-foot { font-size: 9.5px; margin-top: 2mm; }
    </style>`;
  }

  /**
   * Print a slip, one copy per press.
   *
   * No watermark and no application stylesheet: app.css carries an @page
   * rule that would quietly resize the roll, and a ghosted logo behind a
   * 50-point number is how a thermal printer produces grey mush.
   */
  function print(slip, { copies = 1 } = {}) {
    const n = Math.max(1, Math.min(5, Number(copies) || 1));
    const html = styles() + Array.from({ length: n }, () => slipHtml(slip))
      .join('<div style="page-break-after:always"></div>');
    UI.print(html, `Token ${slip.label}`, { standalone: true, watermark: false,
      width: 320, height: 620 });
  }

  /** Fetch the live slip for a token and print it. */
  async function printToken(tokenId, opts) {
    const slip = await API.get(`/api/queue/tokens/${tokenId}/slip`);
    print(slip, opts);
    return slip;
  }

  /** The token a visit is holding — issued now if it has none — then printed. */
  async function printForVisit(visitId, opts) {
    const token = await API.post(`/api/queue/visits/${visitId}/token`, {});
    return printToken(token.id, opts);
  }

  /** On screen, at roughly the size it will come out of the printer. */
  function preview(slip) {
    return `<div class="tslip-preview">${styles()}${slipHtml(slip)}</div>`;
  }

  window.TokenSlip = { print, printToken, printForVisit, preview, slipHtml, styles, WIDTH_MM };
}());
