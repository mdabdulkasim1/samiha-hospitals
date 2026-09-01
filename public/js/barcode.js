/**
 * Code 128-B barcodes drawn as inline SVG.
 *
 * The pharmacy prints its own batch labels, and a printed label has to survive
 * a photocopier and a cheap laser scanner — so we draw crisp vector bars rather
 * than pulling in a font or an image library. Code 128-B covers digits and the
 * whole printable ASCII range, which is enough for our EAN-style batch codes
 * and for drug codes typed in by hand.
 */
(function () {
  'use strict';

  // Bar/space widths for values 0–106; the last entry is the stop pattern.
  const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 ' +
    '112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 ' +
    '321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
    '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 ' +
    '311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 ' +
    '141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 ' +
    '121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
    '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(/\s+/);

  const START_B = 104;
  const QUIET = 10; // quiet zone in module widths — scanners need the white space

  /** Encode a string as the sequence of Code 128 symbol values, with checksum. */
  function encode(text) {
    const values = [START_B];
    let sum = START_B;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 32 || code > 126) throw new Error(`Cannot barcode the character "${text[i]}".`);
      const value = code - 32;
      values.push(value);
      sum += value * (i + 1);
    }
    values.push(sum % 103);
    values.push(106); // stop
    return values;
  }

  /**
   * Draw `text` as an SVG barcode.
   * `module` is the width of the narrowest bar in user units; `height` the bar
   * height. The SVG scales to its container, so callers only set the box.
   */
  function svg(text, { module = 2, height = 56, showText = true, fontSize = 11 } = {}) {
    const value = String(text || '').trim();
    if (!value) return '';
    let values;
    try {
      values = encode(value);
    } catch (err) {
      return `<span class="muted small">${value} (not printable as a barcode)</span>`;
    }

    const widths = values.map((v) => PATTERNS[v]).join('');
    let x = QUIET;
    let bars = '';
    let isBar = true;
    for (const ch of widths) {
      const w = Number(ch);
      if (isBar) bars += `<rect x="${x * module}" y="0" width="${w * module}" height="${height}"/>`;
      x += w;
      isBar = !isBar;
    }

    const totalModules = x + QUIET;
    const width = totalModules * module;
    const textHeight = showText ? fontSize + 4 : 0;
    return `<svg class="barcode" viewBox="0 0 ${width} ${height + textHeight}" width="100%"
      preserveAspectRatio="xMidYMid meet" role="img" aria-label="Barcode ${escapeAttr(value)}"
      xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height + textHeight}" fill="#fff"/>
      <g fill="#000">${bars}</g>
      ${showText ? `<text x="${width / 2}" y="${height + fontSize}" text-anchor="middle"
        font-family="monospace" font-size="${fontSize}" letter-spacing="1">${escapeAttr(value)}</text>` : ''}
    </svg>`;
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.Barcode = { svg, encode };
})();
