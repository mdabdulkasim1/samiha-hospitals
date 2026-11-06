'use strict';
/**
 * The bill, as the file a patient keeps.
 *
 * This is the same document the counter prints, laid out again for a page
 * rather than for a browser. It is deliberately the same shape — letterhead,
 * who the bill is for, what was charged, what it came to, what is still owed
 * — because a patient who is sent a bill and then asks for a printed one at
 * the next visit must be handed the same piece of paper.
 *
 * Two bills are built here. The clinic's tax invoice, which the cashier
 * raises, and the pharmacy's, which is a separate registration under its own
 * GSTIN and drug licences and has to carry the rate-wise tax split, the batch
 * numbers and the expiry dates the rules require.
 *
 * Money is written "Rs." rather than ₹: the fonts a PDF can use without
 * embedding have no rupee sign. See src/lib/pdf.js.
 */
const { Document } = require('./pdf');

const INK = '#16232B';
const QUIET = '#5A6B74';
const LABEL = '#8B9AA2';
const RULE = '#E4EAED';
const HAIR = '#EDF1F3';
const BRAND = '#9E1B34';
const TEAL = '#176B7C';

const n2 = (v) => Number(v || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
/** Money, with the unit spelled because the font has no rupee sign. */
const money = (v) => `Rs. ${n2(v)}`;
const plain = (v) => n2(v);

const dmy = (value) => {
  if (!value) return '—';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
};

const titleise = (s) => String(s || '').replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/*
 * How a payment was made, written the way it is said. Title case turns UPI
 * into "Upi" and NEFT into "Neft", which on a bill a patient keeps looks
 * like a typing mistake rather than a payment method.
 */
const MODES = { upi: 'UPI', neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', emi: 'EMI', tpa: 'TPA' };
const payMode = (s) => MODES[String(s || '').toLowerCase()] || titleise(s);

/** Aadhaar as it is written on the card: four, four, four. */
const aadhaar = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 12 ? `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}` : '—';
};

/**
 * The letterhead, repeated on every page.
 *
 * A bill that runs to two pages must say whose it is on both: the second
 * sheet is the one that ends up in an insurer's file on its own.
 */
function letterhead(doc, { name, address, phone, title, subtitle }) {
  doc.y = doc.margin;
  doc.text(name, doc.width / 2, doc.y + 11, {
    font: 'bold', size: 13.5, color: BRAND, align: 'center', width: 0,
  });
  doc.y += 15;
  if (subtitle) {
    doc.text(subtitle, doc.width / 2, doc.y + 6, {
      size: 6.4, color: TEAL, align: 'center', letterSpacing: 1.6,
    });
    doc.y += 9;
  }
  const line = [address, phone].filter(Boolean).join(' · ');
  if (line) {
    doc.text(line, doc.width / 2, doc.y + 6, { size: 7.6, color: QUIET, align: 'center' });
    doc.y += 10;
  }
  if (title) {
    doc.text(title, doc.width / 2, doc.y + 7, {
      font: 'bold', size: 8.4, color: TEAL, align: 'center', letterSpacing: 2.4,
    });
    doc.y += 11;
  }
  doc.line(doc.margin, doc.y, doc.right, doc.y, { color: BRAND, width: 1.3 });
  doc.y += 10;
}

/** A label above its value, which is how every field on these bills is set. */
function field(doc, x, y, w, label, value, { strong = false } = {}) {
  doc.text(String(label).toUpperCase(), x, y + 5, { size: 6.2, color: LABEL, font: 'bold', letterSpacing: .7 });
  const size = strong ? 10 : 8.6;
  const lines = doc.wrap(value === null || value === undefined || value === '' ? '—' : String(value),
    w, strong ? 'bold' : 'bold', size);
  doc.text(lines[0], x, y + 15, { font: 'bold', size, color: INK });
  return lines.length > 1 ? 1 : 0;
}

/** The grid of who the bill is for. Returns the height it took. */
function whoBlock(doc, fields) {
  const cols = 3;
  const gap = 10;
  const colW = (doc.inner - gap * (cols - 1)) / cols;
  const top = doc.y;
  let row = 0;
  let col = 0;
  for (const [label, value, span] of fields) {
    const width = span === 2 ? colW * 2 + gap : colW;
    if (col + (span === 2 ? 2 : 1) > cols) { col = 0; row += 1; }
    field(doc, doc.margin + col * (colW + gap), top + row * 22, width, label, value,
      { strong: span === 2 });
    col += span === 2 ? 2 : 1;
    if (col >= cols) { col = 0; row += 1; }
  }
  const height = (col === 0 ? row : row + 1) * 22 + 4;
  doc.y = top + height;
  doc.line(doc.margin, doc.y, doc.right, doc.y, { color: RULE, width: .6 });
  doc.y += 9;
  return height;
}

/**
 * A table whose rows break across pages.
 *
 * `columns` are {title, width, align, font}. The header is redrawn at the top
 * of each page, because a column of figures with no heading above it on the
 * second sheet is a column of unexplained numbers.
 */
function table(doc, columns, rows, { reserve = 0, rowGap = 5.5, size = 8.4 } = {}) {
  const header = () => {
    let x = doc.margin;
    for (const c of columns) {
      doc.text(String(c.title).toUpperCase(), c.align === 'right' ? x + c.width : x, doc.y + 6,
        { size: 6.2, color: LABEL, font: 'bold', letterSpacing: .7, align: c.align === 'right' ? 'right' : 'left' });
      x += c.width;
    }
    doc.y += 9;
    doc.line(doc.margin, doc.y, doc.right, doc.y, { color: INK, width: .7 });
    doc.y += 2;
  };
  header();

  for (const row of rows) {
    // How tall is this row? The description is the only thing that wraps.
    const heights = columns.map((c, i) => {
      const text = row[i] === null || row[i] === undefined ? '' : String(row[i]);
      return doc.wrap(text, c.width - 6, c.font || 'regular', size).length * (size * 1.25);
    });
    const h = Math.max(...heights, size * 1.25) + rowGap;
    if (doc.y + h > doc.bottom - reserve) { doc.newPage(); header(); }

    let x = doc.margin;
    columns.forEach((c, i) => {
      const text = row[i] === null || row[i] === undefined ? '' : String(row[i]);
      const lines = doc.wrap(text, c.width - 6, c.font || 'regular', size);
      lines.forEach((ln, k) => {
        doc.text(ln, c.align === 'right' ? x + c.width : x, doc.y + size * 0.95 + k * (size * 1.25), {
          size, color: c.color || INK, font: c.font || 'regular',
          align: c.align === 'right' ? 'right' : 'left',
        });
      });
      x += c.width;
    });
    doc.y += h;
    doc.line(doc.margin, doc.y - rowGap / 2, doc.right, doc.y - rowGap / 2, { color: HAIR, width: .5 });
  }
  doc.y += 2;
}

/** The totals block, right-aligned under the table. */
function totals(doc, lines, { width = 170 } = {}) {
  const left = doc.right - width;
  for (const [label, value, style] of lines) {
    if (style === 'grand') {
      doc.line(left, doc.y + 1, doc.right, doc.y + 1, { color: INK, width: .7 });
      doc.y += 4;
    }
    const bold = style === 'grand' || style === 'due';
    const size = style === 'grand' ? 10.5 : 8.6;
    const color = style === 'off' ? '#B06A00' : (style === 'due' ? BRAND : INK);
    doc.text(label, left, doc.y + size, { size, color, font: bold ? 'bold' : 'regular' });
    doc.text(value, doc.right, doc.y + size, { size, color, font: bold ? 'bold' : 'regular', align: 'right' });
    doc.y += size * 1.5;
  }
}

// ------------------------------------------------------------ clinic invoice
/**
 * The cashier's tax invoice.
 *
 * The treating doctor appears as their code and not by name — the same rule
 * the prescription follows, because a bill goes home with the patient and on
 * to their insurer.
 */
function clinicInvoice(inv, { clinic = {}, pay = null } = {}) {
  const doc = new Document({ size: 'A5', margin: 26 });
  doc.onPage = (d) => letterhead(d, {
    name: clinic.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS',
    subtitle: 'CARE • COMPASSION • COMMITMENT',
    address: clinic.address, phone: clinic.phone, title: 'TAX INVOICE',
  });
  letterhead(doc, {
    name: clinic.name || 'SAMIHA POLYCLINIC & DIAGNOSTICS',
    subtitle: 'CARE • COMPASSION • COMMITMENT',
    address: clinic.address, phone: clinic.phone, title: 'TAX INVOICE',
  });

  const who = [
    ['Patient', `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || '—', 2],
    ['Invoice', inv.invoice_no],
    ['Age / Sex', `${inv.age_years ? `${inv.age_years} yrs` : '—'} · ${titleise(inv.gender || '—')}`],
    ['UHID', inv.uhid],
    ['Date', dmy(inv.created_at)],
    ['Mobile', inv.phone],
    ['Aadhaar', aadhaar(inv.aadhaar_number)],
    ['Bill type', titleise(inv.kind)],
  ];
  if (inv.visit_no || inv.ip_no) who.push([inv.ip_no ? 'Admission' : 'Visit', inv.ip_no || inv.visit_no]);
  if (inv.doctor_code) who.push(['Doctor code', inv.doctor_code]);
  whoBlock(doc, who);

  const w = doc.inner;
  table(doc, [
    { title: '#', width: 16 },
    { title: 'Particulars', width: w - 16 - 36 - 62 - 66 },
    { title: 'Qty', width: 36, align: 'right' },
    { title: 'Rate', width: 62, align: 'right' },
    { title: 'Amount', width: 66, align: 'right' },
  ], (inv.items || []).map((i, k) => [
    k + 1, i.description, i.qty, plain(i.unit_price), plain(i.amount),
  ]), { reserve: 150 });

  if (!(inv.items || []).length) {
    doc.text('No charges on this bill.', doc.margin, doc.y + 9, { size: 8.4, color: QUIET });
    doc.y += 14;
  }

  const concessions = [
    ['Line discounts', inv.discount],
    [`Discount${inv.bill_discount_reason ? ' — ' + inv.bill_discount_reason : ''}`, inv.bill_discount],
    ['Sliding-scale concession', inv.sliding_discount],
    ['Assistance programme', inv.assistance_covered],
    ['Insurance', inv.insurance_covered],
  ].filter(([, v]) => Number(v) > 0);

  doc.ensure(40 + concessions.length * 13);
  doc.y += 6;
  totals(doc, [
    ['Gross', money(inv.gross)],
    ...concessions.map(([label, v]) => [label, `- ${money(v)}`, 'off']),
    ...(Number(inv.tax) ? [['Tax', money(inv.tax)]] : []),
    ['Net payable', money(inv.net), 'grand'],
    ...(Number(inv.paid) ? [['Paid', money(inv.paid)]] : []),
    ...(Number(inv.balance) > 0.009 ? [['Balance due', money(inv.balance), 'due']] : []),
  ]);

  doc.y += 2;
  doc.text(`Rupees ${rupeesInWords(inv.net)} only.`, doc.margin, doc.y + 8,
    { size: 7.8, color: QUIET });
  doc.y += 14;

  // Pay from the chair. The square is given room: it is scanned off a phone
  // screen as often as off paper.
  if (Number(inv.balance) > 0.009 && pay && pay.matrix) {
    doc.ensure(92);
    const h = 86;
    doc.rect(doc.margin, doc.y, doc.inner, h, { stroke: RULE, width: .6 });
    doc.qr(pay.matrix, doc.margin + 8, doc.y + 8, h - 16);
    const x = doc.margin + h - 16 + 20;
    doc.text('SCAN TO PAY BY UPI', x, doc.y + 16, { size: 6.2, color: LABEL, font: 'bold', letterSpacing: .7 });
    doc.text(money(pay.amount), x, doc.y + 31, { size: 12, font: 'bold', color: BRAND });
    doc.text(pay.upiId || '', x, doc.y + 44, { size: 9.5, font: 'bold' });
    doc.paragraph(`Open any UPI app — GPay, PhonePe, Paytm, BHIM — scan this code and confirm. `
      + `The amount and the invoice number ${inv.invoice_no} are already in it.`
      + (pay.payee ? ` Payable to ${pay.payee}.` : ''),
    x, doc.y + 50, doc.right - x - 10, { size: 7.2, color: QUIET });
    doc.y += h + 8;
  } else if (Number(inv.net) > 0 && Number(inv.balance) <= 0.009) {
    doc.ensure(26);
    doc.rect(doc.margin, doc.y, doc.inner, 20, { stroke: '#1B7A4B', width: .8, dash: '3 2' });
    doc.text('PAID IN FULL', doc.width / 2, doc.y + 14,
      { font: 'bold', size: 10, color: '#1B7A4B', align: 'center', letterSpacing: 2 });
    doc.y += 28;
  }

  if ((inv.payments || []).length) {
    doc.ensure(30 + inv.payments.length * 13);
    doc.text('PAYMENTS RECEIVED', doc.margin, doc.y + 6,
      { size: 6.2, color: LABEL, font: 'bold', letterSpacing: .7 });
    doc.y += 10;
    for (const p of inv.payments) {
      doc.text(`${dmy(p.paid_at)} · ${payMode(p.mode)}${p.reference ? ' · ' + p.reference : ''}`,
        doc.margin, doc.y + 8, { size: 8 });
      doc.text(p.receipt_no || '', doc.right - 90, doc.y + 8, { size: 8, color: QUIET, align: 'right' });
      doc.text(money(p.amount), doc.right, doc.y + 8, { size: 8, align: 'right' });
      doc.y += 12;
    }
    doc.y += 4;
  }

  footer(doc, [
    'Computer-generated invoice — valid without a signature.',
    'Please keep it for your records and for any insurance reimbursement.',
    clinic.gstin ? `GSTIN ${clinic.gstin}.` : '',
  ].filter(Boolean).join(' '));

  return doc.end();
}

/** The closing note, pinned to the bottom of the last page. */
function footer(doc, note) {
  const needed = doc.wrap(note, doc.inner, 'regular', 7).length * 9 + 10;
  if (doc.room < needed) doc.newPage();
  const y = Math.max(doc.y + 6, doc.bottom - needed);
  doc.line(doc.margin, y, doc.right, y, { color: RULE, width: .6 });
  const lines = doc.wrap(note, doc.inner, 'regular', 7);
  lines.forEach((ln, i) => doc.text(ln, doc.width / 2, y + 10 + i * 9,
    { size: 7, color: LABEL, align: 'center' }));
}

// ---------------------------------------------------------- pharmacy invoice
/**
 * The pharmacy's GST tax invoice.
 *
 * A retail chemist is a separate registration from the clinic, so this bill
 * carries its own name, GSTIN and drug licences, the batch and expiry of
 * every pack handed over, and the rate-wise tax split a GST invoice must
 * show. Tax is extracted out of the MRP rather than added to it: the MRP on
 * a pack is the most a patient may be charged.
 */
/*
 * The amount in words. The pharmacy service already writes its own, in its
 * own house style ("Sixty Rupees Only"), so that is used as it stands rather
 * than wrapped in a second "Rupees" and a second "only".
 */
function amountLine(given, amount) {
  const words = String(given || '').trim();
  if (words && /rupee/i.test(words)) return /only/i.test(words) ? `${words}.` : `${words} only.`;
  return `Rupees ${words || rupeesInWords(amount)} only.`;
}

const balanceOf = (sale) => Math.round((Number(sale.net || 0) - Number(sale.paid_amount || 0)) * 100) / 100;

function pharmacyInvoice(data) {
  const { supplier = {}, sale = {}, items = [], summary = {}, hsnSummary = [] } = data;
  const doc = new Document({ size: 'A5', margin: 26 });
  const head = (d) => letterhead(d, {
    name: supplier.name || 'SAMIHA PHARMACEUTICALS',
    subtitle: supplier.tagline || '',
    address: supplier.address, phone: supplier.phone, title: 'GST TAX INVOICE',
  });
  doc.onPage = head;
  head(doc);

  const licences = [
    supplier.gstin ? `GSTIN ${supplier.gstin}` : '',
    supplier.dlNumbers ? `DL ${supplier.dlNumbers}` : '',
    supplier.fssai ? `FSSAI ${supplier.fssai}` : '',
  ].filter(Boolean).join('  ·  ');
  if (licences) {
    doc.y += doc.paragraph(licences, doc.margin, doc.y, doc.inner, { size: 7, color: QUIET });
    doc.y += 2;
  }

  whoBlock(doc, [
    ['Patient', (sale.patient_name || '').trim() || sale.customer_name || 'Counter sale', 2],
    ['Bill no', sale.bill_no],
    ['Date', dmy(sale.created_at)],
    ['UHID', sale.uhid],
    ['Mobile', sale.patient_phone || sale.customer_phone],
    ['Place of supply', data.placeOfSupply],
    ['Reverse charge', data.reverseCharge || 'No'],
    ...(sale.visit_no ? [['Visit', sale.visit_no]] : []),
  ]);

  const w = doc.inner;
  table(doc, [
    { title: '#', width: 14 },
    { title: 'Medicine · batch · expiry', width: w - 14 - 30 - 46 - 34 - 56 },
    { title: 'Qty', width: 30, align: 'right' },
    { title: 'MRP', width: 46, align: 'right' },
    { title: 'GST', width: 34, align: 'right' },
    { title: 'Amount', width: 56, align: 'right' },
  ], items.map((i, k) => [
    k + 1,
    `${i.drug_name}${i.batch_no ? ` · B.No ${i.batch_no}` : ''}${i.expiry_date ? ` · Exp ${i.expiry_date}` : ''}`
      + `${i.hsn_code ? ` · HSN ${i.hsn_code}` : ''}`,
    i.qty, plain(i.mrp), `${Number(i.tax_pct || 0)}%`, plain(i.amount),
  ]), { reserve: 170 });

  doc.ensure(60);
  doc.y += 6;
  totals(doc, [
    ['Taxable value', money(summary.taxable)],
    ['CGST', money(summary.cgst)],
    ['SGST', money(summary.sgst)],
    ...(Number(sale.discount) ? [['Discount', `- ${money(sale.discount)}`, 'off']] : []),
    ['Net payable', money(sale.net), 'grand'],
    ...(Number(sale.paid_amount) ? [['Paid', money(sale.paid_amount)]] : []),
    ...(balanceOf(sale) > 0.009 ? [['Balance due', money(balanceOf(sale)), 'due']] : []),
  ]);

  doc.y += 2;
  doc.text(amountLine(data.amountInWords, sale.net), doc.margin, doc.y + 8,
    { size: 7.8, color: QUIET });
  doc.y += 14;

  if (hsnSummary.length) {
    doc.ensure(24 + hsnSummary.length * 14);
    doc.text('TAX SUMMARY', doc.margin, doc.y + 6, { size: 6.2, color: LABEL, font: 'bold', letterSpacing: .7 });
    doc.y += 10;
    table(doc, [
      { title: 'HSN', width: 70 },
      { title: 'Rate', width: 50, align: 'right' },
      { title: 'Taxable', width: (doc.inner - 120) / 3, align: 'right' },
      { title: 'CGST', width: (doc.inner - 120) / 3, align: 'right' },
      { title: 'SGST', width: (doc.inner - 120) / 3, align: 'right' },
    ], hsnSummary.map((r) => [r.hsn, `${r.rate}%`, plain(r.taxable), plain(r.cgst), plain(r.sgst)]),
    { reserve: 70, size: 8 });
  }

  const signed = [
    supplier.pharmacistName ? `Dispensed by ${supplier.pharmacistName}` : '',
    supplier.pharmacistRegNo ? `Reg. ${supplier.pharmacistRegNo}` : '',
  ].filter(Boolean).join(' · ');
  if (signed) {
    doc.ensure(18);
    doc.text(signed, doc.margin, doc.y + 8, { size: 7.4, color: QUIET });
    doc.y += 14;
  }

  footer(doc, 'Computer-generated tax invoice — valid without a signature. '
    + 'Medicines once sold are not taken back, except as the law requires. '
    + 'Keep this bill for any warranty or insurance claim.');

  return doc.end();
}

/**
 * The amount in words, which a bill carries so a figure cannot be altered
 * after it is printed. Indian numbering: lakh and crore, not million.
 */
function rupeesInWords(amount) {
  const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? '-' + ONES[n % 10] : ''}`);
  const under1000 = (n) => [
    n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred` : '',
    n % 100 ? under100(n % 100) : '',
  ].filter(Boolean).join(' ');

  const value = Math.abs(Number(amount) || 0);
  const whole = Math.floor(value);
  const paise = Math.round((value - whole) * 100);
  if (!whole && !paise) return 'zero';

  const parts = [];
  let left = whole;
  for (const [size, label] of [[10000000, 'crore'], [100000, 'lakh'], [1000, 'thousand']]) {
    if (left >= size) { parts.push(`${under1000(Math.floor(left / size))} ${label}`); left %= size; }
  }
  if (left) parts.push(under1000(left));
  const words = parts.join(' ').replace(/\s+/g, ' ').trim();
  const capped = words.charAt(0).toUpperCase() + words.slice(1);
  return paise ? `${capped || 'Zero'} and ${under100(paise)} paise` : capped;
}

module.exports = { clinicInvoice, pharmacyInvoice, rupeesInWords, money };
