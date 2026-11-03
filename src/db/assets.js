'use strict';
/**
 * The equipment the clinic bought, as its purchase orders record it.
 *
 * Five confirmed orders, August and September 2026: hospital furniture from
 * Geeken and from Nilkamal, general medical and dental equipment from Royal
 * International, imaging and laboratory equipment from People Health Care, and
 * the digital radiography system with its X-ray room accessories.
 *
 * Only what the purchase orders actually say is filled in here — the item as
 * it was ordered, its model where one was quoted, the supplier, the PO number,
 * the order date, the quantity and the rate. Everything the paperwork cannot
 * know is left empty for the clinic: the serial number off the plate, which
 * room it ended up in, when it was last calibrated and when that runs out.
 * A blank is honest; a guess at a serial number is worse than nothing, because
 * somebody would act on it.
 *
 * `calibrate` marks the ones where calibration is not optional — the analyser
 * whose numbers go on a report, the X-ray unit under AERB licence, the pumps
 * that meter a dose, the monitors a decision is taken from. The interval is
 * the usual twelve months unless the trade says otherwise; the clinic can
 * change it per asset. A waiting-room chair is not on that list.
 */

/*
 * One row per item as the purchase order lists it. `qty` is what was ordered:
 * eight beds are one line here, because the PO bought them as one line and the
 * clinic will split them into individual assets only if it ever needs to track
 * them apart — at which point the serial numbers it enters are what separate
 * them anyway.
 */
const PURCHASES = [
  // ---------------------------------------------- Geeken, PO AKB-SMC-010826-004
  {
    supplier: 'Geeken Seating Collection Pvt Ltd', po: 'AKB-SMC-010826-004',
    ordered: '2026-08-01', category: 'Furniture & fittings', make: 'Geeken',
    items: [
      ['Waiting area chairs — Fly-07 (4-chair set)', 'Fly-07', 6, 43248],
      ['Waiting area chairs — Fly-03 (4-chair set)', 'Fly-03', 3, 32470],
      ['Table — Numero 03 (1.2 × 0.6 × 0.75 m)', 'Numero 03', 3, 19686],
      ['Chair — GP 157', 'GP 157', 6, 13158],
      ['Digital podium', null, 1, 128000],
      ['Kiosk and signage, 55 inch', null, 1, 88400],
    ],
  },
  // ------------------------------- Nilkamal / Sai Medisupply, AKB-SMC-010826-005
  {
    supplier: 'Sai Medisupply (Nilkamal)', po: 'AKB-SMC-010826-005',
    ordered: '2026-08-01', category: 'Hospital furniture', make: 'Nilkamal',
    items: [
      ['Hospital cot — 2 function fully ABS manual, heavy duty IV pole', '9402', 8, 32200],
      ['Saline / IV stand — CB PCD450 SS, height 1300–2400 mm', 'WC-1011', 8, 3215.10],
      ['Overbed table — OBT pneumatic ABS', 'WF-1021K', 4, 10054.54],
      ['Bedside locker — Elite 2, door, drawer and open shelf, SS top', 'WF-0001', 4, 9034],
      ['Examination couch — adjustable backrest, 3 drawers, sliding step stool', 'EC-1132', 4, 25083.78],
      ['Wheelchair — aluminium foldable, safety belt, retractable footrest', 'ET 0121', 2, 12787.50],
      ['Crash cart — ABS / aluminium, SS guard rail, centralised drawer locking', 'WF-1021B', 1, 35000],
      ['Instrument trolley — medium SS 304, 760 × 510 × 910 mm, two shelves', 'WC-0011', 1, 13648],
    ],
  },
  // ------------------------------ Royal International, PO AKB-SMC-010826-006
  {
    supplier: 'Royal International', po: 'AKB-SMC-010826-006',
    ordered: '2026-08-01', category: 'Medical equipment',
    items: [
      ['BP apparatus — digital', 'AL-DBM', 8, 650],
      ['BP apparatus — digital, deluxe', 'AL-BMD', 1, 950],
      ['Pulse oximeter', 'AL-POM', 9, 150, { calibrate: 12 }],
      ['Digital thermometer — infrared forehead', 'AL-DT01', 8, 90, { calibrate: 12 }],
      ['Stethoscope — regular', 'AL-DS1', 6, 350],
      ['First-aid box', null, 1, 150],
      ['Temperature / humidity monitor', null, 1, 650, { calibrate: 12 }],
      ['Adult weighing scale', null, 4, 450, { calibrate: 12 }],
      ['Otoscope / ophthalmoscope set', null, 4, 2000],
      ['Examination torch', null, 3, 450],
      ['Instrument tray', null, 1, 350],
      ['IV stand — SS, plastic base', 'AL-IVSPS', 1, 998],
      ['Dressing / injection tray with cover, 12 × 8', 'AL-IT26', 1, 400],
      ['Emergency drug / dressing tray with cover, 10 × 8', 'AL-IT24', 2, 320],
      ['Needle destroyer / cutter', null, 1, 950],
      ['Portable suction machine — 0–690 mmHg', 'AL-PSM', 3, 2950, { calibrate: 12 }],
      ['Oxygen cylinder with flowmeter', null, 1, 6500, { calibrate: 12 }],
      ['Multiparameter patient monitor — 5 para (SpO2, PR/HR, NIBP, ECG, RESP, 2-temp)',
        'AL-PM5', 1, 14700, { calibrate: 12 }],
      ['Glucometer', null, 2, 450, { calibrate: 12 }],
      ['Nebuliser — high-performance compressor', 'AL-NB-X', 2, 550],
      ['Infusion pump — volumetric, safety alarms', 'AL-IP01', 2, 14000, { calibrate: 12 }],
      ['Syringe pump — speed / speed+time / speed+volume modes', 'AL-SP01', 2, 12000, { calibrate: 12 }],
      ['Crash cart — full SS', 'AL-CSS202', 1, 13125],
      ['Defibrillator — AED (View Plus)', 'AL-AED1', 1, 38500, { calibrate: 12 }],
      ['Ambu bag with mask set', null, 2, 750],
      ['Height scale', null, 1, 1500],
      // Dental room, same PO.
      ['Dentist stool', null, 1, 7500, { category: 'Dental equipment' }],
      ['Air compressor — Turbo X Pro 1.1 HP', null, 1, 22000,
        { category: 'Dental equipment', make: 'Waldent', calibrate: 12 }],
      ['Autoclave — electric cooker type, 12 × 12 aluminium', null, 1, 4700,
        { category: 'Dental equipment', calibrate: 12 }],
      ['Portable dental X-ray — RTA Smart Ray Pro', null, 1, 85000,
        { category: 'Dental equipment', make: 'Waldent', calibrate: 12,
          notes: 'AERB registration applies to this unit.' }],
      ['Ultrasonic scaler — Maxpiezo 4 + LED', null, 1, 15000,
        { category: 'Dental equipment', make: 'Waldent' }],
      ['Light cure unit — Maxcure 6', null, 1, 6500,
        { category: 'Dental equipment', make: 'Waldent', calibrate: 12 }],
      ['Micromotor kit — professional', null, 1, 6500,
        { category: 'Dental equipment', make: 'Waldent' }],
      ['Straight handpiece — premium', null, 1, 3500, { category: 'Dental equipment', make: 'Waldent' }],
      ['Dental chair unit — Eco Plus standard', 'W-112', 1, 2500,
        { category: 'Dental equipment', make: 'Waldent' }],
    ],
  },
  // -------------------- People Health Care, imaging & lab, AKB-SMC-010826-007
  {
    supplier: 'People Health Care', po: 'AKB-SMC-010826-007',
    ordered: '2026-08-01', category: 'Imaging & laboratory',
    items: [
      ['Ultrasound scanner — AeroScan CD25 with convex, TVS and linear probes, Canon printer',
        'CD25', 1, 1060000,
        { make: 'Konica Minolta', calibrate: 12, warrantyYears: 3,
          notes: 'Three probes supplied: convex, transvaginal, linear.' }],
      ['Defibrillator — CardioMax bi-phasic, with crash cart', 'CardioMax', 1, 190000,
        { make: 'Medion', calibrate: 12 }],
      ['ECG machine — 12 channel', null, 1, 55000, { make: 'Medion', calibrate: 12 }],
      ['Biochemistry analyser — Alpha Chem 200 Plus, fully automated', null, 1, 420000,
        { calibrate: 6, warrantyYears: 2,
          notes: 'Reported results depend on this being in calibration.' }],
    ],
  },
  // ------------- People Health Care, DR system & accessories, AKB-SMC-080926-021
  {
    supplier: 'People Health Care', po: 'AKB-SMC-080926-021',
    ordered: '2026-09-08', category: 'Imaging & laboratory',
    items: [
      ['Digital radiography system — Movx Mi 100 mA HF mobile 4.2 kW, with laptop integrator, table with chest stand, DR panel cover, Drypro single-tray printer, apron',
        'Movx Mi', 1, 1475000,
        { make: 'Konica', calibrate: 12, warrantyYears: 3,
          notes: 'AERB licence free for 5 years from installation. Quality-assurance test and AERB renewal both fall due — record them here.' }],
      ['TLD badges — through an AERB-approved laboratory', null, 4, null,
        { category: 'Radiation protection', calibrate: 3,
          notes: 'Arranged after AERB registration. Badges are exchanged on a cycle — set the interval the lab works to.' }],
      ['Lead apron 0.5 mm Pb', null, 3, 7900,
        { category: 'Radiation protection', calibrate: 12,
          notes: 'Integrity check for cracks is due periodically.' }],
      ['Thyroid collar shield 0.5 mm Pb', null, 2, 2205, { category: 'Radiation protection', calibrate: 12 }],
      ['Gonad shield 0.5 mm Pb', null, 2, 1680, { category: 'Radiation protection', calibrate: 12 }],
      ['Lead glass window / mobile barrier', null, 1, 18900, { category: 'Radiation protection' }],
      ['Radiation warning signage — English & Tamil', null, 4, 2000, { category: 'Radiation protection' }],
      ['Lead markers L & R', null, 4, 357, { category: 'Radiation protection' }],
      ['Positioning sponge set — foam wedges', null, 2, 2500, { category: 'Imaging & laboratory' }],
    ],
  },
];

/**
 * Lay the purchased equipment into the asset register, once.
 *
 * Matched on the PO number and the item name together, so running again adds
 * nothing and — more to the point — never writes over a serial number, a room
 * or a calibration date the clinic has since entered. Consumables from the
 * same orders (X-ray film, envelopes, patient gowns) are deliberately left
 * out: they are stock that runs down, not assets that are tracked and
 * calibrated.
 */
function seedAssets(db, { generate, quiet = false } = {}) {
  const exists = db.prepare('SELECT id FROM assets WHERE po_no = ? AND name = ?');
  const insert = db.prepare(`
    INSERT INTO assets (asset_no, name, category, make, model, quantity, supplier, po_no,
                        purchase_date, unit_cost, warranty_until,
                        needs_calibration, calibration_months, notes)
    VALUES (@asset_no, @name, @category, @make, @model, @quantity, @supplier, @po_no,
            @purchase_date, @unit_cost, @warranty_until,
            @needs_calibration, @calibration_months, @notes)`);

  let added = 0;
  for (const order of PURCHASES) {
    for (const [name, model, quantity, unitCost, opts = {}] of order.items) {
      if (exists.get(order.po, name)) continue;
      const warranty = opts.warrantyYears
        ? new Date(new Date(`${order.ordered}T00:00:00Z`)
          .setUTCFullYear(new Date(`${order.ordered}T00:00:00Z`).getUTCFullYear() + opts.warrantyYears))
          .toISOString().slice(0, 10)
        : null;
      insert.run({
        asset_no: generate('asset'),
        name,
        category: opts.category || order.category,
        make: opts.make || order.make || null,
        model,
        quantity,
        supplier: order.supplier,
        po_no: order.po,
        purchase_date: order.ordered,
        unit_cost: unitCost,
        // Only where the order actually states a warranty period. Elsewhere
        // the paperwork says "standard manufacturer's warranty", which is not
        // a date and should not be turned into one.
        warranty_until: warranty,
        needs_calibration: opts.calibrate ? 1 : 0,
        calibration_months: opts.calibrate || null,
        notes: opts.notes || null,
      });
      added += 1;
    }
  }
  if (added && !quiet) console.log(`[assets] ${added} item(s) added from the purchase orders.`);
  return added;
}

module.exports = { PURCHASES, seedAssets };
