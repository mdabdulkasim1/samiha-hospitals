/* What each desk sees when they sign in. */
(function () {
  'use strict';

  APP.register('dashboard', {
    title: 'Dashboard',
    subtitle: 'Both sides of the trade, at a glance',

    async render(host) {
      const d = await API.get('/api/reports/dashboard');
      const money = APP.seesMoney();
      const m = (v) => (v === null || v === undefined ? '—' : UI.money(v));

      const sell = [
        UI.stat({ label: 'Open enquiries', value: UI.num(d.sell.enquiries_open),
          note: 'waiting for a quotation', route: '#/enquiries', kind: 'info' }),
        UI.stat({ label: 'Quotations out', value: UI.num(d.sell.quotations_open),
          note: money ? m(d.sell.quotations_value) + ' quoted' : 'awaiting the client',
          route: '#/quotations', kind: 'gold' }),
        UI.stat({ label: 'Client LPOs open', value: UI.num(d.sell.orders_open),
          note: money ? m(d.sell.orders_value) + ' on order' : 'confirmed and committed',
          route: '#/orders', kind: 'green' }),
        UI.stat({ label: 'Awaiting delivery', value: UI.num(d.sell.awaiting_delivery),
          note: 'orders with material still to go out', route: '#/orders' }),
        UI.stat({ label: 'Delivered, not invoiced', value: UI.num(d.sell.awaiting_invoice),
          note: 'delivery notes with no tax invoice', route: '#/invoices',
          kind: d.sell.awaiting_invoice ? 'danger' : '' }),
      ];

      const buy = [
        UI.stat({ label: 'Enquiries out', value: UI.num(d.buy.enquiries_open),
          note: 'asked of the makers, no price back yet', route: '#/supplier-enquiries',
          kind: 'info' }),
        UI.stat({ label: 'Prices to confirm', value: UI.num(d.buy.quotations_to_approve),
          note: 'supplier quotations in, not yet approved', route: '#/supplier-quotations',
          kind: d.buy.quotations_to_approve ? 'gold' : '' }),
        UI.stat({ label: 'LPOs in draft', value: UI.num(d.buy.lpos_draft),
          note: 'raised but not sent to the maker', route: '#/purchase-orders',
          kind: d.buy.lpos_draft ? 'danger' : '' }),
        UI.stat({ label: 'LPOs open', value: UI.num(d.buy.lpos_open),
          note: money ? m(d.buy.lpos_value) + ' on order' : 'material on its way in',
          route: '#/purchase-orders', kind: 'info' }),
        UI.stat({ label: 'Deliveries overdue', value: UI.num(d.buy.overdue_deliveries),
          note: 'past the date the maker promised', route: '#/purchase-orders',
          kind: d.buy.overdue_deliveries ? 'danger' : '' }),
        UI.stat({ label: 'Bills to book', value: UI.num(d.buy.bills_unbooked),
          note: 'goods received with no supplier invoice', route: '#/supplier-bills' }),
      ];

      const yard = [
        UI.stat({ label: 'Items in the master', value: UI.num(d.stock.items), route: '#/catalogue' }),
        UI.stat({ label: 'In the yard', value: APP.seesCost() ? m(d.stock.on_hand_value) : '—',
          note: 'at landed cost', route: '#/stock', kind: 'green' }),
        UI.stat({ label: 'On order', value: APP.seesCost() ? m(d.stock.on_order_value) : '—',
          note: 'material bought and coming in', route: '#/stock', kind: 'info' }),
        UI.stat({ label: 'Received today', value: UI.num(d.stock.received_today), route: '#/goods-receipts' }),
        UI.stat({ label: 'Delivered today', value: UI.num(d.stock.delivered_today), route: '#/deliveries' }),
      ];

      const cash = d.cash ? [
        UI.stat({ label: 'Owed to us', value: m(d.cash.receivable),
          note: d.cash.overdue_receivable ? m(d.cash.overdue_receivable) + ' overdue' : 'all within terms',
          route: '#/ledgers', kind: d.cash.overdue_receivable ? 'danger' : 'green' }),
        UI.stat({ label: 'We owe', value: m(d.cash.payable),
          note: d.cash.overdue_payable ? m(d.cash.overdue_payable) + ' overdue' : 'all within terms',
          route: '#/ledgers', kind: d.cash.overdue_payable ? 'gold' : '' }),
        UI.stat({ label: 'Collected this month', value: m(d.cash.collected_this_month),
          route: '#/payments', kind: 'green' }),
        UI.stat({ label: 'Paid out this month', value: m(d.cash.paid_this_month), route: '#/payments' }),
        UI.stat({ label: 'Cheques pending', value: UI.num(d.cash.cheques_pending),
          note: d.cash.cheques_bounced ? `${d.cash.cheques_bounced} bounced` : 'post-dated, not yet due',
          route: '#/cheques', kind: d.cash.cheques_bounced ? 'danger' : '' }),
      ] : [];

      const trading = d.trading ? `
        <div class="card">
          <h3>This month</h3>
          <div class="card-sub">Invoiced to clients against what the manufacturers and the overheads cost.</div>
          ${UI.bars([
            { label: 'Invoiced', value: d.trading.invoiced_this_month, display: m(d.trading.invoiced_this_month) },
            { label: 'Purchased', value: d.trading.purchased_this_month, display: m(d.trading.purchased_this_month) },
            { label: 'Expenses', value: d.trading.expenses_this_month, display: m(d.trading.expenses_this_month) },
          ], { colour: 'gold' })}
        </div>` : '';

      host.innerHTML = `
        <div class="card">
          <h3>Selling — to our clients</h3>
          <div class="card-sub">Enquiry → our quotation → their LPO → delivery → tax invoice → payment</div>
          <div class="grid g5">${sell.join('')}</div>
        </div>
        <div class="card">
          <h3>Buying — from the manufacturers</h3>
          <div class="card-sub">Their quotation → price confirmed → our LPO → goods in → their invoice → we pay</div>
          <div class="grid g5">${buy.join('')}</div>
        </div>
        <div class="card">
          <h3>Stock</h3>
          <div class="card-sub">What is on order, what is in the yard, and what moved today</div>
          <div class="grid g5">${yard.join('')}</div>
        </div>
        ${cash.length ? `<div class="card"><h3>Money</h3>
          <div class="card-sub">What is owed either way, and what has moved this month</div>
          <div class="grid g5">${cash.join('')}</div></div>` : ''}
        ${trading}`;

      UI.bindStats(host);
    },
  });
})();
