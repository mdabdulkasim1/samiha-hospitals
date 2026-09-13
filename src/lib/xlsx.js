'use strict';
const zlib = require('node:zlib');

/**
 * A workbook writer, in about two hundred lines and no dependencies.
 *
 * An .xlsx file is a zip of XML documents, and both halves of that are things
 * Node can already do: `zlib` deflates, and the zip container is a handful of
 * byte-for-byte headers. Reaching for a library here would have meant pulling
 * a few hundred packages into an app that runs on four, to write a file format
 * whose whole surface we need is "a grid of values with a name on it".
 *
 * Two deliberate simplifications keep it that size. Strings are written inline
 * rather than pooled into a shared-strings table — a larger file, and no index
 * to keep in step. And there is no styling beyond a bold header row and column
 * widths, because this produces data to be worked with rather than a document
 * to be read.
 */

// ------------------------------------------------------------------ the zip
/* CRC-32, table built once. The zip directory carries one per entry. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Zip the named entries into one buffer.
 *
 * Everything is deflated and everything is stored with a fixed 1980 timestamp:
 * a workbook built twice from the same data should be the same bytes, so that
 * a backup can be compared against its predecessor without the clock making
 * every one of them look different.
 */
function zip(entries) {
  const chunks = [];
  const directory = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // time — fixed, see above
    local.writeUInt16LE(33, 12);          // date — 1 Jan 1980
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field

    chunks.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  }

  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // no comment

  return Buffer.concat([...chunks, dir, end]);
}

// ------------------------------------------------------------------ the XML
const esc = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel refuses a file containing control characters, and free-text notes
  // typed at a counter do occasionally carry one.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A1, B1 … Z1, AA1 — the column letters a spreadsheet counts in. */
function cellRef(col, row) {
  let name = '';
  let n = col;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return `${name}${row}`;
}

/**
 * A sheet name Excel will actually accept: at most 31 characters, none of
 * []:*?/\, and not blank. Duplicates are numbered by the caller.
 */
function sheetName(raw, index) {
  const cleaned = String(raw || '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

/** One cell, typed. Numbers stay numbers so the spreadsheet can add them up. */
function cell(value, col, row) {
  const ref = cellRef(col, row);
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];

  /*
   * Column widths from the widest thing in each column, looking at a sample
   * rather than the lot — a hundred thousand rows would cost more to measure
   * than the workbook is worth, and the first few hundred settle it.
   */
  const sample = rows.slice(0, 500);
  const widths = columns.map((c, i) => {
    const longest = sample.reduce((max, r) => {
      const v = r[i];
      return Math.max(max, v === null || v === undefined ? 0 : String(v).length);
    }, String(c).length);
    return Math.min(Math.max(longest + 2, 9), 55);
  });

  const header = `<row r="1">${columns.map((c, i) =>
    `<c r="${cellRef(i, 1)}" t="inlineStr" s="1"><is><t>${esc(c)}</t></is></c>`).join('')}</row>`;

  const body = rows.map((r, ri) =>
    `<row r="${ri + 2}">${r.map((v, ci) => cell(v, ci, ri + 2)).join('')}</row>`).join('');

  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<cols>${widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    // The header row frozen, because every one of these is a list somebody
    // scrolls, and a list you scroll past its own headings is unreadable.
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>'
    + `<sheetData>${header}${body}</sheetData>`
    + (columns.length && rows.length
      ? `<autoFilter ref="A1:${cellRef(columns.length - 1, rows.length + 1)}"/>` : '')
    + '</worksheet>',
    'utf8'
  );
}

/**
 * Build a workbook.
 *
 * `sheets` is `[{ name, columns: ['Code', 'Name'], rows: [['A', 'B'], …] }]`.
 * A sheet with no rows is still written — "nothing dispensed this week" is an
 * answer, and a missing tab looks like a bug.
 */
function build(sheets) {
  const used = new Set();
  const named = (sheets.length ? sheets : [{ name: 'Empty', columns: [], rows: [] }])
    .map((s, i) => {
      let name = sheetName(s.name, i);
      let n = 2;
      while (used.has(name.toLowerCase())) {
        const suffix = ` (${n})`;
        name = sheetName(s.name, i).slice(0, 31 - suffix.length) + suffix;
        n += 1;
      }
      used.add(name.toLowerCase());
      return { ...s, name };
    });

  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + named.map((_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>', 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>', 'utf8'),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + named.map((s, i) =>
          `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>', 'utf8'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + named.map((_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>', 'utf8'),
    },
    {
      // Two formats only: the default, and a bold one for the header row.
      name: 'xl/styles.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
        + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
        + '<borders count="1"><border/></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        // Readers expect a named default style to exist even when nothing uses it.
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>', 'utf8'),
    },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];

  return zip(entries);
}

/** Rows of plain objects, in the key order given. */
function fromRows(name, rows, columns = null) {
  const keys = columns || (rows.length ? Object.keys(rows[0]) : []);
  return {
    name,
    columns: keys,
    rows: rows.map((r) => keys.map((k) => {
      const v = r[k];
      return v instanceof Date ? v.toISOString() : v;
    })),
  };
}

module.exports = { build, fromRows, sheetName, crc32 };
