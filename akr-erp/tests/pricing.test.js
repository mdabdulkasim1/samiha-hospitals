'use strict';
/* The arithmetic on a line, and the words at the foot of an invoice. */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv } = require('./helpers');

freshEnv('pricing');
const pricing = require('../src/services/pricing');
const v = require('../src/lib/validate');

test('VAT is charged on the discounted value, not the list value', () => {
  const line = pricing.priceLine({ qty: 10, unit_price: 125.5, discount_percent: 10 });
  assert.equal(line.gross, 1255);
  assert.equal(line.discount, 125.5);
  assert.equal(line.taxable, 1129.5);
  assert.equal(line.vat_amount, 56.48, '5% of the discounted 1,129.50');
  assert.equal(line.total, 1185.98);
});

test('a discount larger than the line is capped at the line', () => {
  const line = pricing.priceLine({ qty: 2, unit_price: 100, discount: 500 });
  assert.equal(line.discount, 200);
  assert.equal(line.taxable, 0);
  assert.equal(line.vat_amount, 0);
});

test('a document totals the sum of its rounded lines', () => {
  const lines = [
    pricing.priceLine({ qty: 3, unit_price: 33.33 }),
    pricing.priceLine({ qty: 7, unit_price: 12.05, discount_percent: 2.5 }),
  ];
  const t = pricing.totals(lines);
  assert.equal(t.taxable, pricing.round(lines[0].taxable + lines[1].taxable));
  assert.equal(t.vat_amount, pricing.round(lines[0].vat_amount + lines[1].vat_amount));
  assert.equal(t.total, pricing.round(t.taxable + t.vat_amount));
});

test('the amount in words reads the way an invoice writes it', () => {
  assert.equal(pricing.inWords(0), 'AED Zero Only');
  assert.equal(pricing.inWords(1), 'AED One Only');
  assert.equal(pricing.inWords(11088), 'AED Eleven Thousand Eighty Eight Only');
  assert.equal(pricing.inWords(1129.5), 'AED One Thousand One Hundred Twenty Nine and Fifty Fils Only');
  assert.equal(pricing.inWords(1000000.05),
    'AED One Million and Five Fils Only');
});

test('a date is a date, and a due date is arithmetic on it', () => {
  assert.equal(v.date('2026-09-08'), '2026-09-08');
  assert.equal(v.addDays('2026-09-08', 60), '2026-11-07');
  assert.equal(v.addDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => v.date('08/09/2026'), /YYYY-MM-DD/);
});

test('a TRN is fifteen digits or nothing at all', () => {
  assert.equal(v.trn(''), null);
  assert.equal(v.trn('100 1234 5670 0003'), '100123456700003');
  assert.throws(() => v.trn('123'), /fifteen digits/);
});

test('money and quantities are rounded the same way everywhere', () => {
  assert.equal(v.money(10.005), 10.01);
  assert.equal(v.money('12.344'), 12.34);
  assert.equal(v.qty(1.23456), 1.235, 'quantities keep three places — metres, tonnes');
});
