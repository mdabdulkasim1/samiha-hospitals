'use strict';
/**
 * The headings the clinic's money is spent under.
 *
 * Written out from the accounts instruction of November 2026, which asked for
 * two things to be kept apart: what it cost to build the clinic, and what it
 * costs to run it. Those are different questions — one is an investment the
 * owner has made and expects back, the other is the bill for being open this
 * month — and a book that mixes them answers neither.
 *
 * Three further groups sit below the operating ones, and they are not costs
 * of running the clinic at all. Loan interest is the price of the money, not
 * of the month's work, so it is reported under the operating subtotal rather
 * than inside it. A loan principal repayment, a refundable deposit and an
 * advance to a supplier are money leaving the bank against something the
 * clinic still owns or is still owed — they belong on their own schedules,
 * and counting them as expenses would make a profitable month look like a
 * loss.
 *
 * Each heading carries an item list, because "Laboratory — 14,500" tells the
 * owner nothing and "Laboratory · reagents — 14,500" tells them where it
 * went. The lists are the ones the accounts letter gave, in its order, and
 * nothing has been invented to fill them out.
 *
 * `line` and `nature` are how a heading reaches the owner's board: `line` is
 * the row of the monthly comparison it adds to, and `nature` decides whether
 * it is a cost of the month at all. A heading the clinic adds itself inherits
 * sensible defaults and can be pointed at a line by management.
 */

/**
 * The departments an expense is booked against.
 *
 * The names are the clinic's, as the accounts letter set them. `commercial`
 * is which revenue department it answers to on the owner's board, where
 * income is measured — the board knows "Laboratory" and "X-ray / Scans /
 * ECG", and home sample collection is a way of getting samples to the
 * laboratory rather than a department that bills. Administration is nobody's
 * department on purpose: that is what makes it an overhead.
 */
const DEPARTMENTS = [
  { key: 'opd', label: 'OPD', commercial: 'consultation', sort: 1 },
  { key: 'treatment', label: 'Treatment & Day Care', commercial: 'procedures', sort: 2 },
  { key: 'laboratory', label: 'Laboratory', commercial: 'laboratory', sort: 3 },
  { key: 'radiology', label: 'Radiology', commercial: 'imaging', sort: 4 },
  { key: 'pharmacy', label: 'Pharmacy', commercial: 'pharmacy', sort: 5 },
  { key: 'home_collection', label: 'Home Sample Collection', commercial: 'laboratory', sort: 6 },
  { key: 'common', label: 'Administration & Common Services', commercial: null, sort: 7 },
];
const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);
/** Where a cost goes when nobody says whose it is. */
const DEFAULT_DEPARTMENT = 'common';

/**
 * What a heading is, for the purpose of the month's figures.
 *
 *   operating  — the cost of being open this month; it is in the subtotal
 *   capital    — building the clinic or buying a machine; a schedule, and
 *                it reaches the profit later as depreciation
 *   stock      — goods bought for resale or use; the cost lands when they
 *                are sold or used, not when they are bought, so counting the
 *                purchase here as well would charge the same rupee twice
 *   finance    — the price of borrowed money; reported below the subtotal
 *   financing_capital — a loan principal repayment; not a cost at all
 *   deposit    — refundable; the clinic still owns it
 *   advance    — paid before the goods; a debt owed to the clinic
 */
const NATURES = ['operating', 'capital', 'stock', 'finance', 'financing_capital', 'deposit', 'advance'];

/** The groups the report prints in, in order. */
const GROUPS = [
  { key: 'setup', label: 'Setup and pre-opening', sort: 1,
    note: 'What it cost to build and open the clinic. An investment, not a cost of this month.' },
  { key: 'operating', label: 'Monthly operating costs', sort: 2,
    note: 'The cost of being open. These make up the operating subtotal.' },
  { key: 'finance', label: 'Finance charges and depreciation', sort: 3,
    note: 'Reported below the operating subtotal, because neither is the cost of the month\'s work.' },
  { key: 'schedule', label: 'Schedules — not expenses', sort: 4,
    note: 'Money out against something the clinic still owns or is still owed.' },
];

/*
 * The headings themselves.
 *
 * `code` is what the reports key on, so it never changes once it has been
 * used. `name` is what the counter reads and management may reword.
 */
const CATEGORIES = [
  // ------------------------------------------------- setup and pre-opening
  {
    code: 'SETUP-BUILD', cash: 'Building & fit-out', group: 'setup', name: 'Building and fit-out',
    nature: 'capital', line: null, department: 'common',
    items: ['Civil works', 'Interiors', 'Flooring', 'Partitions', 'Electrical work', 'Plumbing',
      'Air conditioning', 'Lift', 'Fire safety systems', 'X-ray room shielding', 'Permanent signage'],
  },
  {
    code: 'SETUP-EQUIP', cash: 'Equipment purchase', group: 'setup', name: 'Medical equipment',
    nature: 'capital', line: null, department: 'common',
    items: ['X-ray unit', 'Ultrasound', 'ECG machine', 'Laboratory analysers', 'Patient beds',
      'Monitors', 'Sterilisers', 'Emergency equipment',
      'Delivery, installation and commissioning'],
    note: 'Record delivery, installation and commissioning against the purchase they belong to.',
  },
  {
    code: 'SETUP-FURN', cash: 'Furniture & IT hardware', group: 'setup', name: 'Furniture and IT hardware',
    nature: 'capital', line: null, department: 'common',
    items: ['Desks', 'Chairs', 'Storage', 'Computers', 'Printers', 'CCTV', 'Networking',
      'Token machines', 'Display screens'],
  },
  {
    code: 'SETUP-OPEN', cash: 'Pre-opening & inauguration', group: 'setup', name: 'Pre-opening and inauguration',
    nature: 'capital', line: null, department: 'common',
    items: ['Initial recruitment', 'Staff training', 'Trial runs', 'Opening publicity',
      'Invitations', 'Event arrangements', 'Refreshments', 'Gifts'],
  },

  // ----------------------------------------------------- monthly operating
  {
    code: 'OP-DOCTOR', cash: 'Doctor fees & honorarium', group: 'operating', name: 'Doctors and consultants',
    nature: 'operating', line: 'doctorPayout', department: 'opd', direct: true,
    items: ['Doctor salaries', 'Visiting consultant fees', 'Session fees', 'Consultation payments',
      'Procedure payments', 'On-call fees', 'Substitute doctors'],
  },
  {
    code: 'OP-CLINSTAFF', cash: 'Salaries & wages', group: 'operating', name: 'Clinical staff payroll',
    nature: 'operating', line: 'payroll', department: 'common', fixed: true,
    items: ['Nurses', 'Lab technicians', 'Radiographers', 'Pharmacists', 'Phlebotomists',
      'Clinical assistants', 'Overtime', 'Night duty allowance', 'Other allowances',
      'Employer contributions (PF / ESI)', 'Temporary cover'],
  },
  {
    code: 'OP-ADMINSTAFF', cash: 'Salaries & wages', group: 'operating', name: 'Admin and support payroll',
    nature: 'operating', line: 'payroll', department: 'common', fixed: true,
    items: ['Administration', 'Reception', 'Billing', 'Accounts', 'Security', 'Housekeeping staff',
      'Maintenance staff', 'Drivers', 'Allowances', 'Employer contributions (PF / ESI)',
      'Agency charges', 'Uniforms', 'Staff training'],
  },
  {
    code: 'OP-OPD', cash: 'Treatment consumables', group: 'operating', name: 'OPD, treatment and day care',
    nature: 'operating', line: 'medicinesConsumed', department: 'treatment', direct: true,
    items: ['Gloves', 'Masks', 'Syringes', 'Needles', 'Dressings', 'IV sets', 'Cannulas',
      'Other disposables', 'Medicines used in treatment', 'Oxygen',
      'Emergency trolley replenishment'],
    note: 'What is used on patients here, not what the pharmacy sells over its counter.',
  },
  {
    code: 'OP-LAB', cash: 'Lab reagents & kits', group: 'operating', name: 'Laboratory',
    nature: 'operating', line: 'medicinesConsumed', department: 'laboratory', direct: true,
    items: ['Reagents', 'Test kits', 'Sample tubes', 'Controls', 'Calibrators', 'Slides',
      'Pipette tips', 'Repeat tests', 'Quality checks', 'Analyser rentals', 'Outsourced tests',
      'Sample courier charges'],
  },
  {
    code: 'OP-RAD', cash: 'Radiology & ECG supplies', group: 'operating', name: 'Radiology and ECG',
    nature: 'operating', line: 'medicinesConsumed', department: 'radiology', direct: true,
    items: ['X-ray film and printing supplies', 'Ultrasound gel', 'ECG electrodes', 'ECG paper',
      'Outsourced reporting', 'Equipment rentals', 'Radiation monitoring (TLD badges)'],
  },
  {
    code: 'OP-PHARM', cash: 'Medicines & consumables', group: 'operating', name: 'Pharmacy',
    nature: 'stock', line: null, department: 'pharmacy',
    items: ['Medicines purchased for resale', 'Dispensing and packaging supplies', 'Expired stock',
      'Damaged stock', 'Shortages'],
    note: 'The cost of a medicine sold is taken from the batch it left, so a purchase booked here '
      + 'is a stock movement and not a second cost. Supplier returns and credits are money in.',
  },
  {
    code: 'OP-HOME', cash: 'Home collection costs', group: 'operating', name: 'Home sample collection',
    nature: 'operating', line: 'medicinesConsumed', department: 'home_collection', direct: true,
    items: ['Collection staff fees', 'Travel', 'Fuel', 'Collection kits', 'Specimen bags',
      'Cold packs', 'Courier charges'],
  },
  {
    code: 'OP-AMB', cash: 'Ambulance & transport', group: 'operating', name: 'Ambulance and patient transport',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common',
    items: ['Hired ambulance charges', 'Fuel', 'Servicing', 'Insurance', 'Cleaning'],
    note: 'Driver wages belong under admin and support payroll.',
  },
  {
    code: 'OP-RENT', cash: 'Rent', group: 'operating', name: 'Rent and premises charges',
    nature: 'operating', line: 'rentUtilities', department: 'common', fixed: true,
    items: ['Building rent', 'Common area charges', 'Other recurring premises charges'],
  },
  {
    code: 'OP-UTIL', cash: 'Electricity & water', group: 'operating', name: 'Utilities and fuel',
    nature: 'operating', line: 'rentUtilities', department: 'common', fixed: true,
    items: ['Electricity', 'Water', 'Internet', 'Telephone', 'Generator diesel',
      'Backup power running costs'],
  },
  {
    code: 'OP-CLEAN', cash: 'Housekeeping & security', group: 'operating', name: 'Cleaning, laundry and infection control',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common', fixed: true,
    items: ['Cleaning contract', 'Cleaning supplies', 'Disinfectants', 'Sanitizers',
      'Linen washing', 'Pest control', 'Sterilization supplies', 'Infection control checks'],
  },
  {
    code: 'OP-WASTE', cash: 'Waste disposal', group: 'operating', name: 'Waste disposal',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common', fixed: true,
    items: ['Biomedical waste collection', 'General waste collection', 'Treatment and disposal',
      'Segregation bags', 'Sharps containers', 'Bins'],
  },
  {
    code: 'OP-MAINT', cash: 'Equipment maintenance', group: 'operating', name: 'Maintenance and calibration',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common', fixed: true,
    items: ['AMC and CMC charges', 'Repairs', 'Spare parts', 'Servicing',
      'Calibration — medical equipment', 'Air conditioning', 'Lift', 'Generator', 'UPS', 'CCTV',
      'Electrical', 'Plumbing', 'Fire safety systems'],
  },
  {
    code: 'OP-SOFT', cash: 'Software & subscriptions', group: 'operating', name: 'Software and communications',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common', fixed: true,
    items: ['Hospital ERP', 'Laboratory software', 'Pharmacy software', 'Subscriptions',
      'Cloud hosting', 'Backups', 'Technical support', 'SMS', 'Appointment reminders'],
  },
  {
    code: 'OP-LIC', cash: 'Licences, taxes & insurance', group: 'operating', name: 'Licences, inspections and insurance',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common', fixed: true,
    items: ['Registration renewals', 'Inspection fees', 'Audit fees', 'Premises insurance',
      'Equipment insurance', 'Professional indemnity', 'Staff insurance'],
  },
  {
    code: 'OP-OFFICE', cash: 'Printing & stationery', group: 'operating', name: 'Office and patient amenities',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common',
    items: ['Stationery', 'Toner', 'Prescription pads', 'Patient files', 'Printing',
      'Drinking water', 'Patient refreshments', 'Staff pantry supplies'],
    note: 'A petty cash purchase is booked under what was actually bought, not as petty cash.',
  },
  {
    code: 'OP-MARKET', cash: 'Marketing & camps', group: 'operating', name: 'Marketing and outreach',
    nature: 'operating', line: 'marketing', department: 'common',
    items: ['Advertising', 'Posters', 'Flyers', 'Health camps', 'Community outreach',
      'Promotional materials'],
  },
  {
    code: 'OP-PROF', cash: 'Professional & audit fees', group: 'operating', name: 'Professional and outsourced services',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common',
    items: ['Accounting', 'Audit', 'Legal', 'HR', 'Consultancy', 'Outsourced clinical services'],
    note: 'An outsourced clinical service is booked to the department using it, not to Common.',
  },
  {
    code: 'OP-BANK', cash: 'Bank & payment charges', group: 'operating', name: 'Bank and payment charges',
    nature: 'operating', line: 'maintenanceAdmin', department: 'common',
    items: ['Bank fees', 'Card terminal rental', 'Payment gateway fees', 'Transaction charges'],
  },

  // -------------------------------------- below the operating subtotal
  {
    code: 'FIN-INT', cash: 'Bank charges & interest', group: 'finance', name: 'Loan interest and finance charges',
    nature: 'finance', line: 'interest', department: 'common', fixed: true,
    items: ['Loan interest', 'Processing fees', 'Late payment charges', 'Lease finance charges'],
    note: 'The price of the money, not of the month\'s work, so it is reported below the subtotal.',
  },

  // ------------------------------------------------ schedules, not expenses
  {
    code: 'SCH-LOAN', cash: 'Loan repayment', group: 'schedule', name: 'Loan principal repayment',
    nature: 'financing_capital', line: null, department: 'common',
    items: ['Term loan instalment', 'Equipment loan instalment', 'Overdraft repayment'],
    note: 'Money out, but not a cost: it reduces what the clinic owes.',
  },
  {
    code: 'SCH-DEPOSIT', cash: 'Deposit or advance paid', group: 'schedule', name: 'Refundable deposits',
    nature: 'deposit', line: null, department: 'common',
    items: ['Rent deposit', 'Electricity deposit', 'Equipment deposit', 'Other refundable deposit'],
    note: 'The clinic still owns this money; it comes back.',
  },
  {
    code: 'SCH-ADVANCE', cash: 'Deposit or advance paid', group: 'schedule', name: 'Supplier advances',
    nature: 'advance', line: null, department: 'common',
    items: ['Advance against order', 'Advance against service'],
    note: 'Paid before the goods arrived, so it is owed to the clinic until they do.',
  },
];

/**
 * Put the headings in the database, once.
 *
 * Insert-if-absent by code, and nothing is ever restated. A clinic that
 * renames "Utilities and fuel" to "EB and water", switches a heading off or
 * adds an item of its own must find its work there after the next restart —
 * a seed list that overwrites the clinic every boot is a seed list that
 * teaches people not to use the screen.
 *
 * Items are added if the category has none of that name, so a later release
 * can lengthen a list without disturbing what the clinic has done to it.
 */
function load(db) {
  const findCategory = db.prepare('SELECT id FROM expense_categories WHERE code = ?');
  const insertCategory = db.prepare(
    `INSERT INTO expense_categories
       (code, name, cost_group, nature, report_line, default_department, cash_category,
        is_direct, is_fixed, note, seeded, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const findItem = db.prepare(
    'SELECT id FROM expense_items WHERE category_id = ? AND LOWER(name) = LOWER(?)');
  const insertItem = db.prepare(
    'INSERT INTO expense_items (category_id, name, seeded, sort_order) VALUES (?, ?, 1, ?)');

  let added = 0;
  let items = 0;
  db.transaction(() => {
    CATEGORIES.forEach((c, i) => {
      let row = findCategory.get(c.code);
      if (!row) {
        insertCategory.run(c.code, c.name, c.group, c.nature, c.line || null,
          c.department || DEFAULT_DEPARTMENT, c.cash || 'Other expense',
          c.direct ? 1 : 0, c.fixed ? 1 : 0, c.note || null, (i + 1) * 10);
        row = findCategory.get(c.code);
        added += 1;
      }
      (c.items || []).forEach((name, k) => {
        if (findItem.get(row.id, name)) return;
        insertItem.run(row.id, name, (k + 1) * 10);
        items += 1;
      });
    });
  })();
  return { added, items };
}

module.exports = {
  DEPARTMENTS, DEPARTMENT_KEYS, DEFAULT_DEPARTMENT, GROUPS, NATURES, CATEGORIES, load,
};
