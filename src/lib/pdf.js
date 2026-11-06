'use strict';
/**
 * A PDF, written by hand.
 *
 * The clinic's bills are printed from the browser, which is the right place
 * for paper. A bill sent to a patient's phone is a different problem: the
 * file has to exist on the server, be the same bill every time it is fetched,
 * and be built in the few hundred milliseconds a cashier waits at the counter
 * with the next patient already standing there.
 *
 * The obvious answer — drive a headless browser — is not available here. This
 * ERP has four dependencies and is rebuilt on every deploy; adding Chromium
 * would turn a thirty-second deploy into a five-minute one and a 90 MB image
 * into a 400 MB one, for one document. A PDF is a text format, and an invoice
 * is text in boxes, so it is written directly.
 *
 * What this supports is exactly what an invoice needs: Helvetica in two
 * weights, measured properly so figures line up on their right edge, lines,
 * boxes, a QR drawn as squares, and pages that break when the items run long.
 * There is no image support, no colour space but RGB, and no compression —
 * an invoice is twenty kilobytes either way.
 *
 * Text is encoded WinAnsi, which is what the base-14 fonts speak. It has no
 * rupee sign, so money is written "Rs." — the alternative is embedding and
 * subsetting a TrueType font, which is a great deal of machinery for one
 * glyph. Everything else a bill carries — the en dash, the curly quotes a
 * name might contain, °, ₹'s absence aside — maps straight through.
 */

/*
 * Glyph widths for Helvetica and Helvetica-Bold, from the Adobe font metrics,
 * in thousandths of the point size, as three hex digits per WinAnsi byte.
 * These are the real numbers, not an approximation: a column of figures that
 * is right-aligned with guessed widths is visibly ragged.
 */
const W_REGULAR =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  + '11611616322c22c37929b0bf14d14d18524811614d11611622c22c22c22c22c22c22c22c22c22c11611624824824822c'
  + '3f729b29b2d22d229b26330a2d21161f429b22c3412d230a29b30a2d229b2632d229b3b029b29b2631161161161d522c'
  + '14d22c22c1f422c22c11622c22c0de0de1f40de34122c22c22c22c14d1f411622c1f42d21f41f41f414e10414e24815e'
  + '22c15e0de22c14d3e822c22c14d3e829b14d3e815e26315e15e0de0de14d14d15e22c3e814d3e81f414d3b015e1f429b'
  + '11614d22c22c22c22c10422c14d2e117222c24814d2e114d19024814d14d14d22c21911614d14d16d22c342342342263'
  + '29b29b29b29b29b29b3e82d229b29b29b29b1161161161162d22d230a30a30a30a30a24830a2d22d22d22d229b29b263'
  + '22c22c22c22c22c22c3791f422c22c22c22c11611611611622c22c22c22c22c22c22c24826322c22c22c22c1f422c1f4';
const W_BOLD =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  + '11614d1da22c22c3792d20ee14d14d18524811614d11611622c22c22c22c22c22c22c22c22c22c14d14d248248248263'
  + '3cf2d22d22d22d229b26330a2d211622c2d22633412d230a29b30a2d229b2632d229b3b029b29b26314d11614d24822c'
  + '14d22c26322c26322c14d26326311611622c11637926326326326318522c14d26322c30a22c22c1f418511818524815e'
  + '22c15e11622c1f43e822c22c14d3e829b14d3e815e26315e15e1161161f41f415e22c3e814d3e822c14d3b015e1f429b'
  + '11614d22c22c22c22c11822c14d2e117222c24814d2e114d19024814d14d14d26322c11614d14d16d22c342342342263'
  + '2d22d22d22d22d22d23e82d229b29b29b29b1161161161162d22d230a30a30a30a30a24830a2d22d22d22d229b29b263'
  + '22c22c22c22c22c22c37922c22c22c22c22c11611611611626326326326326326326324826326326326326322c26322c';

const widthTable = (packed) => {
  const out = new Array(256);
  for (let i = 0; i < 256; i += 1) out[i] = parseInt(packed.slice(i * 3, i * 3 + 3), 16);
  return out;
};
const WIDTHS = { regular: widthTable(W_REGULAR), bold: widthTable(W_BOLD) };

/*
 * The seventeen places WinAnsi and Latin-1 disagree — the typographic range
 * Windows put at 0x80. A dash pasted out of Word reaches a bill through this.
 */
const HIGH = {
  0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134,
  0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140,
  0x017d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149,
  0x2013: 150, 0x2014: 151, 0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155,
  0x0153: 156, 0x017e: 158, 0x0178: 159,
};

/**
 * One character as the byte a base-14 font will draw.
 *
 * A patient's name may arrive with anything in it. Rather than print a black
 * box or drop the letter silently, an unmappable character becomes a space —
 * on a bill a gap is honest and a question mark looks like a fault.
 */
function encodeChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x20b9) return null;                 // ₹ — written "Rs." instead
  if (cp < 256 && !(cp >= 128 && cp < 160)) return cp;
  if (HIGH[cp] !== undefined) return HIGH[cp];
  return 32;
}

/** The bytes of a string, as WinAnsi, with the rupee sign spelled out. */
function toBytes(text) {
  const out = [];
  for (const ch of String(text === null || text === undefined ? '' : text)) {
    const b = encodeChar(ch);
    if (b === null) { out.push(82, 115, 46); continue; }   // "Rs."
    out.push(b);
  }
  return out;
}

/** How wide a string sets, in points. */
function widthOf(text, font, size) {
  const table = WIDTHS[font === 'bold' ? 'bold' : 'regular'];
  let units = 0;
  for (const b of toBytes(text)) units += table[b] || 0;
  return (units * size) / 1000;
}

/** A PDF string literal: the three characters that end one, escaped. */
function literal(text) {
  let out = '';
  for (const b of toBytes(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

const f = (n) => {
  const r = Math.round(Number(n) * 1000) / 1000;
  return Number.isFinite(r) ? String(r) : '0';
};

/** '#16232B' as the three numbers a PDF operator wants. */
function rgb(hex) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const SIZES = {
  A4: [595.276, 841.89],
  A5: [419.528, 595.276],
  // 80 mm thermal roll, printable width 72 mm, on a page tall enough for a
  // long bill. A roll has no fixed length, so the page is given one.
  ROLL: [204.094, 841.89],
};

/**
 * A document being written.
 *
 * `y` runs from the top of the page downwards, because that is how a bill is
 * laid out and how everyone reading this code will think about it. It is
 * flipped on the way into the content stream.
 */
class Document {
  constructor({ size = 'A5', margin = 28, landscape = false } = {}) {
    const [w, h] = SIZES[size] || SIZES.A5;
    this.width = landscape ? h : w;
    this.height = landscape ? w : h;
    this.margin = margin;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.margin;
    this.page = this.pages.length;
    if (this.onPage) this.onPage(this);
    return this;
  }

  /** The width between the margins. */
  get inner() { return this.width - this.margin * 2; }
  get right() { return this.width - this.margin; }
  get bottom() { return this.height - this.margin; }
  /** What is left before the page runs out. */
  get room() { return this.bottom - this.y; }

  /** Start a new page unless `need` points still fit on this one. */
  ensure(need, reserve = 0) {
    if (this.y + need > this.bottom - reserve) this.newPage();
    return this;
  }

  down(n) { this.y += n; return this; }

  // ------------------------------------------------------------------ marks
  text(str, x, y, {
    font = 'regular', size = 9, color = '#16232B', align = 'left', width = 0,
    letterSpacing = 0,
  } = {}) {
    const s = String(str === null || str === undefined ? '' : str);
    if (!s) return 0;
    const w = widthOf(s, font, size) + letterSpacing * Math.max(0, toBytes(s).length - 1);
    let left = x;
    if (align === 'right') left = x - w;
    else if (align === 'center') left = x + (width - w) / 2;
    const [r, g, b] = rgb(color);
    this.ops.push(`BT /${font === 'bold' ? 'F2' : 'F1'} ${f(size)} Tf`
      + (letterSpacing ? ` ${f(letterSpacing)} Tc` : '')
      + ` ${f(r)} ${f(g)} ${f(b)} rg ${f(left)} ${f(this.height - y)} Td ${literal(s)} Tj`
      + (letterSpacing ? ' 0 Tc' : '') + ' ET');
    return w;
  }

  /** Text measured without drawing it — for deciding what fits. */
  widthOf(str, font = 'regular', size = 9) { return widthOf(str, font, size); }

  /**
   * A paragraph, broken to a width. Returns the height it took, so a caller
   * can go on underneath it without guessing.
   */
  paragraph(str, x, y, w, { font = 'regular', size = 9, color = '#16232B', leading = 1.35 } = {}) {
    const lines = this.wrap(str, w, font, size);
    const step = size * leading;
    lines.forEach((line, i) => this.text(line, x, y + size * 0.85 + i * step, { font, size, color }));
    return lines.length ? size * 0.85 + (lines.length - 1) * step + size * 0.35 : 0;
  }

  /** Break a string to a width, splitting a word only if it will not fit alone. */
  wrap(str, w, font = 'regular', size = 9) {
    const words = String(str === null || str === undefined ? '' : str).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    const fits = (s) => widthOf(s, font, size) <= w;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) { line = next; continue; }
      if (line) lines.push(line);
      if (fits(word)) { line = word; continue; }
      // A code or a URL with no space in it: cut it where it stops fitting.
      let part = '';
      for (const ch of word) {
        if (fits(part + ch)) { part += ch; continue; }
        lines.push(part);
        part = ch;
      }
      line = part;
    }
    if (line) lines.push(line);
    return lines;
  }

  line(x1, y1, x2, y2, { color = '#16232B', width = 0.6, dash = null } = {}) {
    const [r, g, b] = rgb(color);
    this.ops.push(`${f(r)} ${f(g)} ${f(b)} RG ${f(width)} w`
      + (dash ? ` [${dash}] 0 d` : '')
      + ` ${f(x1)} ${f(this.height - y1)} m ${f(x2)} ${f(this.height - y2)} l S`
      + (dash ? ' [] 0 d' : ''));
    return this;
  }

  rect(x, y, w, h, { fill = null, stroke = null, width = 0.6, dash = null } = {}) {
    const parts = [];
    if (fill) { const [r, g, b] = rgb(fill); parts.push(`${f(r)} ${f(g)} ${f(b)} rg`); }
    if (stroke) {
      const [r, g, b] = rgb(stroke);
      parts.push(`${f(r)} ${f(g)} ${f(b)} RG ${f(width)} w`);
      if (dash) parts.push(`[${dash}] 0 d`);
    }
    parts.push(`${f(x)} ${f(this.height - y - h)} ${f(w)} ${f(h)} re`);
    parts.push(fill && stroke ? 'B' : (fill ? 'f' : 'S'));
    if (dash && stroke) parts.push('[] 0 d');
    this.ops.push(parts.join(' '));
    return this;
  }

  /**
   * A QR code, as one filled square per dark module.
   *
   * Drawn at the exact module grid rather than scaled from an image, so it
   * stays sharp at any size and survives being photographed off a screen,
   * which is how most of these will be paid.
   */
  qr({ count, isDark }, x, y, side, { margin = 2, color = '#000000' } = {}) {
    const unit = side / (count + margin * 2);
    const [r, g, b] = rgb(color);
    const runs = [];
    for (let row = 0; row < count; row += 1) {
      let start = -1;
      for (let col = 0; col <= count; col += 1) {
        const dark = col < count && isDark(row, col);
        if (dark && start === -1) start = col;
        if (!dark && start !== -1) {
          const px = x + (start + margin) * unit;
          const py = this.height - (y + (row + margin) * unit) - unit;
          runs.push(`${f(px)} ${f(py)} ${f((col - start) * unit)} ${f(unit)} re`);
          start = -1;
        }
      }
    }
    if (runs.length) this.ops.push(`${f(r)} ${f(g)} ${f(b)} rg ${runs.join(' ')} f`);
    return this;
  }

  // ------------------------------------------------------------------ output
  /** The finished file. */
  end() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    const pageIds = [];
    const contentIds = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      contentIds.push(add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`));
      pageIds.push(null);   // placed below, once the Pages object has a number
    }
    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objects.length + this.pages.length + 1;

    this.pages.forEach((_, i) => {
      pageIds[i] = add(`<< /Type /Page /Parent ${pagesId} 0 R `
        + `/MediaBox [0 0 ${f(this.width)} ${f(this.height)}] `
        + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> `
        + `/Contents ${contentIds[i]} 0 R >>`);
    });
    const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] `
      + `/Count ${pageIds.length} >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [0];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i += 1) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`
      + `startxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { Document, widthOf, SIZES };
