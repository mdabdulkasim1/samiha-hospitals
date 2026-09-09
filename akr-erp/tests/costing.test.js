'use strict';
/*
 * How a selling rate is arrived at.
 *
 * The desk starts from the manufacturer's price and adds what it costs to land
 * the material — shipping, duty, freight, risk, the bank — then the margin. The
 * charges are not all reckoned the same way, which is the whole difficulty:
 * duty is a percentage of the material, a bank charge a percentage of the
 * running total, sea freight a lump sum for the shipment, transport so much a
 * piece. These hold that arithmetic, and hold the working to the line without
 * ever letting it onto the printed quotation.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('costing');
require('../src/db/seed');

const costing = require('../src/services/costing');

let h;
let sales;
let admin;
const ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  ctx.client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  ctx.item = (await admin.get('/api/items?limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

test('each charge is reckoned the way that charge is actually reckoned', () => {
  const b = costing.build({
    material: 500,
    qty: 10,
    profit_percent: 15,
    components: [
      { label: 'Sea cargo', basis: 'lump_sum', value: 1200 },
      { label: 'Custom duty', basis: 'percent_of_material', value: 5 },
      { label: 'Risk charge', basis: 'percent_of_running', value: 2 },
      { label: 'Inland transport', basis: 'per_unit', value: 12 },
    ],
  });

  assert.equal(b.steps[0].per_unit, 120, 'a lump sum is divided over the quantity');
  assert.equal(b.steps[1].per_unit, 25, 'duty is on the material, not on the running total');
  assert.equal(b.steps[2].per_unit, 12.9, 'risk is on everything above it — 2% of 645');
  assert.equal(b.steps[3].per_unit, 12, 'and an amount per piece is just that');

  assert.equal(b.landed_cost, 669.9, 'landed: 500 + 120 + 25 + 12.90 + 12');
  assert.equal(b.profit_per_unit, 100.49, '15% of the landed cost');
  assert.equal(b.rate, 770.39);
  assert.equal(b.line_total, 7703.9, 'and the line is that on every piece');
  assert.equal(b.margin_percent, 13.04, 'the margin is read on the selling rate');
});

test('the order the charges are listed in is the order they are applied', () => {
  const first = costing.build({ material: 100, qty: 1, components: [
    { label: 'Duty', basis: 'percent_of_material', value: 10 },
    { label: 'Bank', basis: 'percent_of_running', value: 10 },
  ] });
  const second = costing.build({ material: 100, qty: 1, components: [
    { label: 'Bank', basis: 'percent_of_running', value: 10 },
    { label: 'Duty', basis: 'percent_of_material', value: 10 },
  ] });
  assert.equal(first.landed_cost, 121, 'the bank charge counts the duty above it');
  assert.equal(second.landed_cost, 120, 'listed first, it does not');
});

test('a lump sum on no quantity does not divide by zero', () => {
  const b = costing.build({ material: 50, qty: 0, components: [
    { label: 'Sea cargo', basis: 'lump_sum', value: 900 } ] });
  assert.equal(b.steps[0].per_unit, 0);
  assert.equal(b.landed_cost, 50, 'and the rate is still a rate');
});

test('the desk can work a rate out on the screen', async () => {
  const built = await sales.post('/api/sales/costing', {
    material: 200, qty: 4, profit_percent: 20,
    components: [{ label: 'Air freight', basis: 'lump_sum', value: 400 }],
  });
  assert.equal(built.landed_cost, 300);
  assert.equal(built.rate, 360);

  const charges = await sales.get('/api/sales/costing/charges');
  assert.ok(charges.suggested.some((c) => c.label === 'Custom duty'));
  assert.ok(charges.suggested.some((c) => c.label === 'Sea cargo'));
  assert.ok(charges.suggested.some((c) => c.label === 'Bank charge'));
});

test('the working is kept on the line, and read back worked out', async () => {
  const quote = await sales.post('/api/sales/quotations', {
    partner_id: ctx.client.id,
    items: [{
      item_id: ctx.item.id, qty: 10, unit_price: 770.39, cost_price: 669.9,
      cost_build: {
        material: 500,
        profit_percent: 15,
        components: [
          { label: 'Sea cargo', basis: 'lump_sum', value: 1200 },
          { label: 'Custom duty', basis: 'percent_of_material', value: 5 },
          { label: 'Risk charge', basis: 'percent_of_running', value: 2 },
          { label: 'Inland transport', basis: 'per_unit', value: 12 },
        ],
      },
    }],
  });

  const full = await sales.get(`/api/sales/quotations/${quote.id}`);
  const build = full.items[0].cost_build;
  assert.ok(build, 'the line remembers how its rate was reached');
  assert.equal(build.material_rate, 500);
  assert.equal(build.landed_cost, 669.9, 'worked out again on the way out, not stored as an answer');
  assert.equal(build.rate, 770.39, 'and it agrees with the rate on the line');
  assert.equal(build.steps.length, 4);
  assert.equal(build.steps[1].label, 'Custom duty');
  ctx.quote = quote;
});

test('none of it reaches the client', async () => {
  const full = await sales.get(`/api/sales/quotations/${ctx.quote.id}`);
  // What the printed quotation is built from is the line as it stands: code,
  // description, quantity, rate, discount, VAT. The working is not among them.
  const printed = ['item_code', 'description', 'qty', 'uom', 'unit_price', 'discount',
    'vat_amount', 'total'];
  for (const key of printed) {
    assert.ok(full.items[0][key] !== undefined, `${key} is on the line, as it must be`);
  }
  const printer = require('fs').readFileSync('public/js/print.js', 'utf8');
  assert.ok(!/cost_build/.test(printer),
    'no printed document so much as mentions the working behind a rate');
  assert.ok(!/cost_price/.test(printer),
    'nor what the goods cost us');
});

test('a revision carries the working with it', async () => {
  const revised = await sales.post(`/api/sales/quotations/${ctx.quote.id}/revise`);
  const full = await sales.get(`/api/sales/quotations/${revised.id}`);
  assert.equal(full.items[0].cost_build.landed_cost, 669.9,
    'the next revision knows how the rate was built, without it being typed again');
});
