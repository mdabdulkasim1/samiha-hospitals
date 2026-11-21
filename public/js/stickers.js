(function () {
  'use strict';
  /**
   * The two stickers that come off the printer when a patient is opened.
   *
   * **The file sticker** goes on the cover of the paper file. It is the
   * clinic's own design, printed with the patient's details already on it
   * instead of waiting to be written out by hand for the fiftieth time —
   * which is where "Fathima 32" and "Fathima 23" come from, and why two
   * files sometimes hold one person's history between them.
   *
   * **The sample sticker** goes on the tube, the urine container, the swab.
   * It carries the barcode, because the one thing that matters about a
   * sample is that the bench can prove whose it is, and a scanner never
   * misreads a 6 for a 0. Everything else on it — name, age, mobile — is
   * there so a human can check the same thing without a scanner, which is
   * what actually happens at eight in the morning.
   *
   * Both are drawn at real size in millimetres. A sticker that prints at
   * 95% of its sheet is a sticker that peels off crooked for a year.
   */

  const esc = (s) => UI.esc(s === null || s === undefined ? '' : s);

  /*
   * The mark on the file sticker. Short on purpose — it shares the top line
   * with the UHID, which is the one thing on the label that must never be
   * the part that gets cut off — and it is the group's name rather than the
   * clinic's full registered one, which is what the sticker is for.
   */
  const BADGE = 'SAMIHA HEALTHCARE';

  /** What a patient is called on a label: title, both names, nothing missing. */
  function fullName(p) {
    return [p.title, p.first_name, p.last_name].filter(Boolean).join(' ').trim()
      || p.name || '—';
  }

  /** "34 yrs · Female", or as much of it as the record actually holds. */
  function ageSex(p) {
    const age = p.age_years ? `${p.age_years} yrs` : '';
    const sex = p.gender ? UI.titleise(p.gender) : '';
    return [age, sex].filter(Boolean).join(' · ') || '—';
  }

  const addressOf = (p) => [p.address, p.city, p.pincode].filter(Boolean).join(', ');

  /** The name without the courtesy title: a tube has 50 mm, not a greeting. */
  const plainName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    || p.name || '—';

  /** The day the clinic opened the file: what the sticker calls Reg. Date. */
  const regDate = (p) => (p.registered_at || p.created_at || p.enquiry_at
    ? UI.date(p.registered_at || p.created_at || p.enquiry_at) : '');

  /**
   * The address over the two lines the design leaves for it, broken on a
   * comma rather than mid-word — a label that ends "Tirunel…" is one
   * somebody has to open the file to finish reading, which is the whole
   * thing the sticker is for.
   */
  function addressLines(p) {
    const parts = [p.address, p.city, p.pincode].filter(Boolean).join(', ').split(/,\s*/);
    if (!parts.length) return ['', ''];
    const out = ['', ''];
    for (const part of parts) {
      const at = out[0].length + part.length <= 34 && !out[1] ? 0 : 1;
      out[at] = out[at] ? `${out[at]}, ${part}` : part;
    }
    return out;
  }

  /**
   * The styles both stickers share.
   *
   * `@page` is set to the sticker itself so a label printer puts one on
   * each label and a sheet printer does not scale it. The dashed outline is
   * the cutting guide on plain paper; on die-cut stock it simply sits
   * inside the die.
   */
  const sheetStyles = (w, h, cols) => `
    <style>
      @page { size: ${w}mm ${h}mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
             color: #16232B; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .sheet { display: grid; grid-template-columns: repeat(${cols}, ${w}mm); }
      .sticker { width: ${w}mm; height: ${h}mm; page-break-inside: avoid; break-inside: avoid;
                 overflow: hidden; position: relative; }
      @media screen {
        body { background: #eef1f3; padding: 10px; }
        .sheet { gap: 6px; }
        .sticker { background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.18); }
      }
    </style>`;

  /**
   * The patient file sticker.
   *
   * The clinic's layout, to the millimetre: the UHID large across the top
   * with the clinic's badge beside it, then the fields on dotted leader
   * lines. The lines stay visible under the values — they are what makes
   * an empty one obviously empty, so whoever is holding the file knows to
   * write it in rather than assuming the system had nothing to say.
   */
  function fileSticker(p) {
    const guardian = [p.guardian_relation, p.guardian_name].filter(Boolean).join(' ')
      || (p.guardian_name || '');
    return `
      <div class="sticker file">
        <div class="frame">
          <div class="top">
            <div class="uhid"><span class="k">UHID</span><span class="v">${esc(p.uhid)}</span></div>
            <div class="badge">${esc(BADGE)}</div>
          </div>
          <div class="row"><span class="lab">Name</span><span class="val">${esc(fullName(p))}</span></div>
          <div class="row split">
            <span class="lab">Age</span><span class="val">${esc(p.age_years || '')}</span>
            <span class="lab second">Sex</span><span class="val">${esc(p.gender ? UI.titleise(p.gender) : '')}</span>
          </div>
          <div class="row"><span class="lab wide">S/o · D/o · W/o</span>
            <span class="val">${esc(guardian)}</span></div>
          <div class="row"><span class="lab">Address</span>
            <span class="val">${esc(addressLines(p)[0])}</span></div>
          <div class="row"><span class="lab blank"></span>
            <span class="val">${esc(addressLines(p)[1])}</span></div>
          <div class="row split">
            <span class="lab">Reg. Date</span><span class="val">${esc(regDate(p))}</span>
            <span class="lab second">Mob.</span><span class="val">${esc(p.phone || '')}</span>
          </div>
        </div>
      </div>`;
  }

  const FILE_STYLES = `
    <style>
      .file .frame { position: absolute; inset: 3mm; border: 0.4mm dashed #9aa7ad; border-radius: 2mm;
                     padding: 4mm 5mm; display: flex; flex-direction: column; justify-content: space-between; }
      .file .top { display: flex; align-items: center; justify-content: space-between; gap: 2mm;
                   overflow: hidden; }
      .file .uhid { display: flex; align-items: baseline; gap: 2.5mm; flex: 1 1 auto; min-width: 0; }
      .file .uhid .k { font-size: 5.4mm; font-weight: 800; color: #2C6B72; letter-spacing: .25mm;
                       flex: none; }
      /*
       * The one thing on the sticker that must never be the part that gets
       * cut off: a file number ending in an ellipsis is a file nobody can
       * find. It takes the room it needs and the badge gives way.
       */
      .file .uhid .v { flex: 1 1 auto; min-width: 0; border-bottom: 0.6mm solid #16232B;
                       font-size: 4mm; font-weight: 700; padding-bottom: 0.6mm;
                       white-space: nowrap; }
      .file .badge { background: #2C6B72; color: #fff; border-radius: 1.5mm; padding: 1.2mm 2mm;
                     font-size: 2.5mm; font-weight: 800; letter-spacing: .25mm; white-space: nowrap;
                     flex: none; }
      .file .row { display: flex; align-items: baseline; gap: 2mm; }
      .file .row.split { gap: 2mm; }
      .file .lab { font-weight: 800; font-size: 3.6mm; white-space: nowrap; }
      .file .lab.wide { font-size: 3.4mm; }
      .file .lab.second { margin-left: 3mm; }
      .file .lab.blank { width: 0; }
      .file .val { flex: 1; min-width: 0; border-bottom: 0.3mm dotted #8b9aa2; font-size: 3.3mm;
                   padding-bottom: 0.5mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    </style>`;

  /**
   * The sample sticker.
   *
   * Sized for a blood tube: 50 × 25 mm is what fits round a 13 mm vacutainer
   * without covering the window the technician reads the level through. The
   * barcode runs along the length because a tube is curved across it, and a
   * barcode bent round a curve is one a scanner refuses.
   *
   * The UHID is the only thing encoded. A sample tube needs to say whose it
   * is; which test it is for belongs to the order form that travels with it.
   */
  function sampleSticker(p, { collectedOn } = {}) {
    const bars = window.Barcode
      ? Barcode.svg(p.uhid, { module: 1.6, height: 34, showText: false })
      : '';
    /*
     * The name gets the whole width and the rest goes under it. On a tube
     * the name is what a human checks against the request form, and a name
     * that reads "Mrs. Ayes…" is one that has to be checked somewhere else
     * — which is the moment two samples get swapped.
     */
    return `
      <div class="sticker sample">
        <div class="frame">
          <div class="nm">${esc(plainName(p))}</div>
          <div class="meta">${esc(ageSex(p))}${p.phone ? ` · ${esc(p.phone)}` : ''}</div>
          <div class="bars">${bars}</div>
          <div class="foot">
            <span class="id">${esc(p.uhid)}</span>
            <span class="dt">${esc(UI.dateShort(collectedOn || new Date().toISOString()))}</span>
          </div>
        </div>
      </div>`;
  }

  const SAMPLE_STYLES = `
    <style>
      .sample .frame { position: absolute; inset: 1.2mm; border: 0.3mm dashed #b6c1c7; border-radius: 1mm;
                       padding: 1.2mm 1.8mm; display: flex; flex-direction: column; justify-content: space-between; }
      .sample .nm { font-weight: 800; font-size: 3.3mm; line-height: 1.1; max-height: 7.3mm;
                    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical; }
      .sample .meta { font-size: 2.5mm; color: #16232B; white-space: nowrap; overflow: hidden;
                      text-overflow: ellipsis; margin-top: 0.3mm; }
      .sample .bars { flex: 1; display: flex; align-items: center; justify-content: center;
                      min-height: 7mm; padding: 0.4mm 0; }
      .sample .bars svg { height: 100%; width: 100%; display: block; }
      .sample .foot { display: flex; align-items: baseline; justify-content: space-between; gap: 1.5mm;
                      font-size: 2.5mm; }
      .sample .id { font-family: ui-monospace, Menlo, monospace; font-weight: 700; letter-spacing: .1mm;
                    white-space: nowrap; }
      .sample .dt { color: #3a4a52; white-space: nowrap; }
    </style>`;

  const SIZES = {
    file: { w: 100, h: 65, cols: 1, styles: FILE_STYLES, render: fileSticker, title: 'File sticker' },
    sample: { w: 50, h: 25, cols: 2, styles: SAMPLE_STYLES, render: sampleSticker, title: 'Sample sticker' },
  };

  /**
   * Print one kind of sticker.
   *
   * No watermark and no application stylesheet: anything printed across a
   * barcode costs the scanner reads it exists to make, and app.css carries
   * an `@page` rule that would quietly resize the label.
   */
  function print(kind, patient, { copies = 1 } = {}) {
    const spec = SIZES[kind];
    if (!spec) return UI.err('Unknown sticker.');
    const n = Math.max(1, Math.min(Number(copies) || 1, 40));
    let cells = '';
    for (let i = 0; i < n; i += 1) cells += spec.render(patient, {});
    UI.print(
      sheetStyles(spec.w, spec.h, spec.cols) + spec.styles + `<div class="sheet">${cells}</div>`,
      `${spec.title} — ${patient.uhid}`,
      { standalone: true, watermark: false, width: 760, height: 620 }
    );
    return undefined;
  }

  /**
   * The dialog behind each button: how many, and a preview at real size.
   *
   * The preview matters more than it looks. A sticker is the one thing the
   * clinic prints that cannot be corrected afterwards — it is already on
   * the tube — so what is about to come out of the printer is shown first.
   */
  function open(kind, patient) {
    const spec = SIZES[kind];
    if (!spec) return UI.err('Unknown sticker.');
    const preview = () => `
      <div style="background:#eef1f3;padding:8px;border-radius:6px;overflow:auto">
        <div style="width:${spec.w}mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.18);
                    position:relative;height:${spec.h}mm">
          ${spec.render(patient, {}).replace('class="sticker', 'class="preview-sticker')}
        </div>
      </div>`;

    UI.modal({
      title: `${spec.title} — ${patient.uhid}`,
      size: 'narrow',
      body: `
        ${spec.styles.replace(/\.file |\.sample /g, (m) => m)}
        <style>
          .preview-sticker { width:${spec.w}mm; height:${spec.h}mm; position:relative; overflow:hidden; }
          .preview-sticker .frame { position:absolute; }
        </style>
        <p class="muted" style="margin-top:0">${kind === 'file'
    ? 'For the cover of the paper file. Prints at 100 × 65 mm.'
    : 'For the tube, the container or the swab. Prints at 50 × 25 mm, two across.'}</p>
        ${preview()}
        <div class="mt">${UI.field({ name: 'copies', label: 'How many', type: 'number',
    min: 1, max: 40, value: kind === 'sample' ? 3 : 1,
    hint: kind === 'sample' ? 'One for each tube or container being filled.' : '' })}</div>
        ${kind === 'sample' && !patient.uhid
    ? '<div class="alert warn mt">This record has no UHID, so there is nothing to barcode.</div>' : ''}`,
      footer: `<button class="btn ghost" data-act="__close">Close</button>
               <button class="btn" data-act="print">Print</button>`,
      onAction(act, modal) {
        if (act !== 'print') return undefined;
        const copies = Number(modal.querySelector('[name=copies]').value) || 1;
        print(kind, patient, { copies });
        return 'keep';
      },
    });
    return undefined;
  }

  window.Stickers = { open, print, fileSticker, sampleSticker, fullName };
})();
