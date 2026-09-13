'use strict';
/*
 * The conditions the company already prints on its LPOs, and the ones it ought
 * to.
 *
 * The first block is lifted from AKR-FD26-016 and generalised: where that order
 * named a particular supplier and a particular authority, this names them with
 * placeholders, so a block copied onto the next order cannot carry the last
 * order's supplier with it — which is exactly what had happened on the original.
 *
 * The rest are the protections a trading company buying against a client's own
 * order needs and that the original block left open: what happens when a
 * delivery is late and the client back-charges, what the warranty is, what
 * makes an invoice payable, and whose law applies. Every one of them is
 * editable, and the ones that only apply to some orders start unticked.
 *
 * `is_default` is whether the clause is ticked when a new LPO is raised.
 */
const CLAUSES = {
  purchase_order: [
    // ---------------------------------------------- from the company's own LPO
    ['Specification & approval', 1,
      'All items shall be as per the approved drawing and requirement.'],
    ['Specification & approval', 1,
      'Production shall commence only after written confirmation from {{company}}.'],
    ['Specification & approval', 1,
      'No substitution of material, make or country of origin is permitted without the prior '
      + 'written approval of {{company}}.'],
    ['Specification & approval', 0,
      'Coating shall be a minimum of 300 microns at any tested area.'],

    ['Inspection & testing', 1,
      'Materials shall be delivered only after satisfactory SAT / FAT inspection by {{authority}}.'],
    ['Inspection & testing', 1,
      'Where {{authority}} SAT / FAT is required, {{company}} shall give {{supplier}} written '
      + 'confirmation so that the necessary arrangements can be made.'],
    ['Inspection & testing', 1,
      'Any repair or corrective action arising from inspection shall be carried out by {{supplier}} '
      + 'at their own cost and within their own responsibility.'],
    ['Inspection & testing', 0,
      '{{supplier}} shall provide a raw material sample for chemical analysis if required by {{authority}}.'],
    ['Inspection & testing', 1,
      '{{company}} and the end client reserve the right to inspect the goods at {{supplier}}’s '
      + 'works during manufacture, on reasonable notice.'],

    ['Quality & documents', 1,
      'Mill test certificates (MTC) shall be provided for all items upon delivery.'],
    ['Quality & documents', 1,
      'All items shall carry the {{supplier}} and {{company}} sticker.'],
    ['Quality & documents', 1,
      'Material not conforming to the specification will be rejected. Rejected material shall be '
      + 'collected and replaced at {{supplier}}’s cost within seven days of notification.'],
    ['Quality & documents', 1,
      'The goods are warranted against defects in material and workmanship for twelve months from '
      + 'the date of delivery, or eighteen months from the date of manufacture, whichever expires first.'],

    ['Packing & delivery', 1,
      'Materials are to be individually packed to avoid damage during transportation.'],
    ['Packing & delivery', 1,
      'Packed materials shall be placed on a wooden pallet and secured firmly to avoid falling '
      + 'during forklift handling.'],
    ['Packing & delivery', 1,
      'Every package, and all shipping documents, shall quote this order number ({{lpo_no}}) and the '
      + 'item codes stated above.'],
    ['Packing & delivery', 1,
      'The delivery date stated on this order is of the essence. Any anticipated delay must be '
      + 'advised to {{company}} in writing as soon as it is known.'],
    ['Packing & delivery', 1,
      'Goods travel at {{supplier}}’s risk and remain at their risk until received and accepted '
      + 'at the delivery address stated above.'],
    ['Packing & delivery', 1,
      'Partial delivery is accepted only with the prior written agreement of {{company}}.'],
    ['Packing & delivery', 0,
      'Deliveries to site shall comply with the site’s health, safety and access requirements, '
      + 'and with any permit the end client requires.'],

    ['Invoicing & payment', 1,
      'The original delivery note and tax invoice (where the supply is from within the UAE), together '
      + 'with one set of copies, are to be submitted to the office of {{company}}.'],
    ['Invoicing & payment', 1,
      'The supplier’s tax invoice must quote this order number ({{lpo_no}}) and show the '
      + 'supplier’s TRN. An invoice without them will be returned unpaid.'],
    ['Invoicing & payment', 1,
      'Payment falls due only on receipt of a complete set of documents — original tax invoice, '
      + 'signed delivery note and mill test certificates. An incomplete set defers the due date until '
      + 'it is made good.'],
    ['Invoicing & payment', 1,
      'Payment terms are {{payment_terms}}, and they supersede any terms printed on the supplier’s '
      + 'own documents.'],
    ['Invoicing & payment', 1,
      'Prices are firm for the duration of this order and are not subject to escalation.'],
    ['Invoicing & payment', 1,
      'No amount beyond the value of this order will be paid. Any change to specification, quantity, '
      + 'price or delivery date is valid only by a written amendment to this order issued by {{company}}.'],

    ['General', 1,
      'Acceptance of this order, or delivery against it, constitutes acceptance of these conditions '
      + 'in full.'],
    ['General', 1,
      'Sub-contracting any part of this order requires the prior written consent of {{company}}.'],
    ['General', 1,
      '{{supplier}} warrants that it holds a valid trade licence and every approval required for this '
      + 'supply, including those of the end client’s authority where applicable.'],
    ['General', 1,
      'Drawings, specifications and client information issued with this order are confidential, and '
      + 'shall not be used for any other purpose or disclosed to any third party.'],
    ['General', 1,
      '{{company}} reserves the right to claim from {{supplier}} any liquidated damages or '
      + 'back-charges levied on it by the end client on account of late or non-conforming delivery.'],
    ['General', 1,
      '{{company}} may cancel any undelivered part of this order, without liability, if the delivery '
      + 'date is exceeded by more than fifteen days.'],
    ['General', 1,
      'This order is governed by the laws of the United Arab Emirates and is subject to the '
      + 'jurisdiction of the courts of Dubai.'],
  ],

  /*
   * A quotation is an offer, not an order, so its conditions protect the price
   * and the promise rather than the goods.
   */
  sales_quotation: [
    ['Prices', 1, 'Prices are in AED and exclusive of 5% VAT unless expressly stated otherwise.'],
    ['Prices', 1,
      'This quotation is valid until the date stated above. Prices are subject to reconfirmation '
      + 'thereafter.'],
    ['Prices', 1,
      'Prices are based on the quantities quoted. A change in quantity or specification may change '
      + 'the price.'],
    ['Delivery', 1,
      'Delivery is ex-stock subject to prior sale; where an item is on indent, the lead time stated '
      + 'against the line applies from the date of a confirmed order.'],
    ['Delivery', 1,
      'Delivery periods are estimates given in good faith and run from receipt of the client’s '
      + 'purchase order and any advance payment called for by the payment terms.'],
    ['Payment', 1, 'Payment terms are {{payment_terms}}.'],
    ['Payment', 1,
      'Goods remain the property of {{company}} until they have been paid for in full.'],
    ['General', 1,
      'Any order placed against this quotation is subject to our standard terms of sale.'],
    ['General', 0,
      'Third-party inspection, testing or certification beyond the manufacturer’s standard '
      + 'certificate is chargeable in addition unless quoted above.'],
    ['General', 1,
      'Claims for shortage or transit damage must be notified in writing within three days of '
      + 'delivery.'],
  ],
};

/** Load the clause library. Skipped entirely if there is already one. */
function seedClauses(db) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM terms_clauses').get().c;
  if (existing > 0) return 0;

  const insert = db.prepare(
    `INSERT INTO terms_clauses (doc_type, clause_group, text, sort_order, is_default)
     VALUES (?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const [docType, rows] of Object.entries(CLAUSES)) {
    rows.forEach(([group, isDefault, text], i) => {
      insert.run(docType, group, text, (i + 1) * 10, isDefault);
      n += 1;
    });
  }
  return n;
}

module.exports = { CLAUSES, seedClauses };
