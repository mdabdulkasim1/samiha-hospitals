'use strict';
/*
 * Starter data.
 *
 * Everything here is the company's own structure — the five applications, the
 * fourteen product lines, the fabrication types, the payment terms — plus a
 * worked example of the trade running end to end so that a new install can be
 * opened and understood rather than stared at.
 *
 * The item catalogue is a starting point in the company's own shape, not the
 * company's real price list: load that over the top with Catalogue → Import,
 * which matches on item code and updates rather than duplicating.
 */
const { db, tx } = require('./index');
const config = require('../config');
const auth = require('../lib/auth');
const ids = require('../lib/ids');

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'akr@2026';

// ------------------------------------------------------------- applications
const APPLICATIONS = [
  ['PW', 'Potable Water', 1],
  ['SW', 'Storm Water', 2],
  ['SEW', 'Sewerage', 3],
  ['DC', 'District Cooling', 4],
  ['IRR', 'Irrigation', 5],
];

/*
 * The fourteen product lines the company trades in. The three-letter code is
 * not decoration: it becomes the middle of every item code in that line, so
 * AKR-VLP-00001 reads as "a potable-water valve" without looking anything up.
 */
const CATEGORIES = [
  ['VLP', 'Valves — Potable Water', 'Valves', 'PW', 1],
  ['VLI', 'Valves — Irrigation', 'Valves', 'IRR', 2],
  ['VLS', 'Valves — Storm & Sewerage', 'Valves', 'SEW', 3],
  ['VLD', 'Valves — District Cooling', 'Valves', 'DC', 4],
  ['GTP', 'Geotextiles — Potable Water', 'Geotextiles', 'PW', 5],
  ['GTI', 'Geotextile — Irrigation', 'Geotextiles', 'IRR', 6],
  ['GTS', 'Geotextile — Storm & Sewerage', 'Geotextiles', 'SEW', 7],
  ['MFW', 'Misc. Fabrication — Water', 'Misc. Fabrication', 'PW', 8],
  ['MFO', 'Misc. Fabrication — Other', 'Misc. Fabrication', null, 9],
  ['GRL', 'GRP Ladders', 'GRP Ladders', null, 10],
  ['FST', 'Fasteners', 'Fasteners', null, 11],
  ['MFP', 'Mechanical Fittings — Potable Water', 'Mechanical Fittings', 'PW', 12],
  ['MFI', 'Mechanical Fittings — Irrigation', 'Mechanical Fittings', 'IRR', 13],
  ['MFS', 'Mechanical Fittings — Stormwater & Sewerage', 'Mechanical Fittings', 'SEW', 14],
];

/* The types within a line. Fabrication is the company's own list. */
const SUBGROUPS = [
  ['Misc. Fabrication', [
    ['STRP', 'Strap'], ['AIRV', 'Air Vent'], ['HBAR', 'Handle Bar'], ['CCLP', 'C Clamp'],
    ['MCLP', 'MS Clamp'], ['SCLP', 'Spider Clamp'], ['GRAT', 'Gratings'],
    ['CHQP', 'Chequered Plate'], ['LADR', 'Ladder'], ['PBAR', 'Protection Barrier'],
    ['EXSP', 'Extension Spindles'], ['OTHR', 'Others'],
  ]],
  ['Valves', [
    ['GATE', 'Gate Valve'], ['BFLY', 'Butterfly Valve'], ['AIRR', 'Air Release Valve'],
    ['CHCK', 'Check / Non-Return Valve'], ['PENS', 'Penstock / Sluice Gate'],
    ['KNIF', 'Knife Gate Valve'], ['BALL', 'Ball Valve'], ['CTRL', 'Control Valve'],
    ['BALN', 'Balancing Valve'], ['STRN', 'Strainer'], ['HYDR', 'Fire Hydrant'],
    ['PRV', 'Pressure Reducing Valve'], ['OTHR', 'Others'],
  ]],
  ['Mechanical Fittings', [
    ['DJNT', 'Dismantling Joint'], ['FADP', 'Flange Adaptor'], ['CPLG', 'Coupling'],
    ['RCLP', 'Repair Clamp'], ['TEE', 'Tee'], ['BEND', 'Bend'], ['RDCR', 'Reducer'],
    ['SADL', 'Tapping Saddle'], ['OTHR', 'Others'],
  ]],
  ['Geotextiles', [
    ['NWOV', 'Non-Woven Geotextile'], ['WOVN', 'Woven Geotextile'], ['GMEM', 'Geomembrane'],
    ['GGRD', 'Geogrid'], ['OTHR', 'Others'],
  ]],
  ['GRP Ladders', [
    ['LADR', 'GRP Ladder'], ['STEP', 'GRP Step'], ['HRAL', 'GRP Handrail'],
    ['GRAT', 'GRP Grating'], ['OTHR', 'Others'],
  ]],
  ['Fasteners', [
    ['BOLT', 'Bolt & Nut Set'], ['ANCH', 'Anchor Bolt'], ['STUD', 'Stud'],
    ['WASH', 'Washer'], ['GSKT', 'Gasket'], ['OTHR', 'Others'],
  ]],
];

/*
 * Payment terms — the list a quotation, an LPO or an invoice picks one from.
 * Every way the company actually trades is here: paid up front, cheque handed
 * over against the delivery note, thirty to a hundred and twenty days,
 * post-dated cheques, retention and a letter of credit.
 */
const PAYMENT_TERMS = [
  ['ADV100', '100% advance with order', 'advance', 0, 100, 0, 0, 'both',
    '100% advance payment along with the purchase order', 1],
  ['ADV50', '50% advance, 50% against delivery', 'milestone', 0, 50, 50, 0, 'both',
    '50% advance with order, balance 50% against delivery', 2],
  ['ADV30', '30% advance, balance 30 days', 'milestone', 30, 30, 0, 0, 'both',
    '30% advance with order, balance 30 days from invoice date', 3],
  ['CAD', 'Cash against delivery', 'on_delivery', 0, 0, 100, 0, 'both',
    'Payment in full at the time of delivery', 4],
  ['CHQD', 'Cheque against delivery', 'on_delivery', 0, 0, 100, 0, 'client',
    'Cheque collected against the signed delivery note', 5],
  ['NET0', 'Payable on invoice', 'credit', 0, 0, 0, 0, 'both',
    'Payable immediately against the tax invoice', 6],
  ['NET30', '30 days from invoice date', 'credit', 30, 0, 0, 0, 'both', null, 7],
  ['NET45', '45 days from invoice date', 'credit', 45, 0, 0, 0, 'both', null, 8],
  ['NET60', '60 days from invoice date', 'credit', 60, 0, 0, 0, 'both', null, 9],
  ['NET90', '90 days from invoice date', 'credit', 90, 0, 0, 0, 'both', null, 10],
  ['NET120', '120 days from invoice date', 'credit', 120, 0, 0, 0, 'both', null, 11],
  ['PDC30', '30 days by post-dated cheque', 'pdc', 30, 0, 0, 0, 'both',
    'Post-dated cheque dated 30 days from invoice date', 12],
  ['PDC60', '60 days by post-dated cheque', 'pdc', 60, 0, 0, 0, 'both',
    'Post-dated cheque dated 60 days from invoice date', 13],
  ['PDC90', '90 days by post-dated cheque', 'pdc', 90, 0, 0, 0, 'both',
    'Post-dated cheque dated 90 days from invoice date', 14],
  ['RET10', '90 days, 10% retention', 'milestone', 90, 0, 0, 10, 'client',
    '90 days from invoice date; 10% retained until the defects liability period ends', 15],
  ['LCSGT', 'Letter of credit at sight', 'lc', 0, 0, 0, 0, 'supplier',
    'Irrevocable letter of credit at sight', 16],
  ['LC90', 'Letter of credit, 90 days', 'lc', 90, 0, 0, 0, 'supplier',
    'Irrevocable letter of credit, 90 days from bill of lading', 17],
];

const EXPENSE_CATEGORIES = [
  ['RENT', 'Rent — office & yard', 'expense', 1],
  ['SAL', 'Salaries & wages', 'expense', 2],
  ['VISA', 'Visa, labour & medical', 'expense', 3],
  ['LIC', 'Trade licence & government fees', 'expense', 4],
  ['FRT', 'Freight & clearing', 'expense', 5],
  ['TRN', 'Transport & fuel', 'expense', 6],
  ['UTIL', 'Utilities', 'expense', 7],
  ['TEL', 'Telephone & internet', 'expense', 8],
  ['INS', 'Insurance', 'expense', 9],
  ['BANK', 'Bank charges & interest', 'expense', 10],
  ['PROF', 'Professional & audit fees', 'expense', 11],
  ['MKT', 'Marketing & tenders', 'expense', 12],
  ['REP', 'Repairs & maintenance', 'expense', 13],
  ['PTY', 'Petty cash & office', 'expense', 14],
  ['MISC', 'Other expenses', 'expense', 15],
  ['FRTI', 'Freight recovered from clients', 'income', 20],
  ['SCRP', 'Scrap & disposal', 'income', 21],
  ['OTHI', 'Other income', 'income', 22],
];

// ---------------------------------------------------------------- catalogue
const DN = (sizes) => sizes;

/**
 * The starter catalogue, written as a line's worth of products at a time.
 * `sizes` expands into one item per size, which is how a valve list actually
 * reads — the same valve in eight diameters, not eight different valves.
 */
const CATALOGUE = [
  // ---------------------------------------------------------- potable water
  { cat: 'VLP', sub: 'GATE', name: 'Resilient Seated Gate Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1171', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN80', 'DN100', 'DN150', 'DN200', 'DN250', 'DN300']), cost: [420, 560, 890, 1450, 2250, 3100] },
  { cat: 'VLP', sub: 'BFLY', name: 'Double Flanged Butterfly Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 593', uom: 'NOS', hs: '84818030',
    sizes: DN(['DN200', 'DN300', 'DN400', 'DN500', 'DN600']), cost: [1350, 2150, 3400, 5200, 7400] },
  { cat: 'VLP', sub: 'AIRR', name: 'Double Orifice Air Release Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1074-4', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN50', 'DN80', 'DN100']), cost: [640, 980, 1420] },
  { cat: 'VLP', sub: 'CHCK', name: 'Swing Check Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1074-3', uom: 'NOS', hs: '84813091',
    sizes: DN(['DN80', 'DN100', 'DN150', 'DN200']), cost: [520, 720, 1180, 1850] },
  { cat: 'VLP', sub: 'HYDR', name: 'Underground Fire Hydrant', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS 750', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN80', 'DN100']), cost: [1250, 1680] },
  { cat: 'VLP', sub: 'STRN', name: 'Y-Type Strainer', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1092-2', uom: 'NOS', hs: '84212900',
    sizes: DN(['DN80', 'DN100', 'DN150']), cost: [410, 560, 890] },
  { cat: 'VLP', sub: 'PRV', name: 'Pressure Reducing Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1074-5', uom: 'NOS', hs: '84811000',
    sizes: DN(['DN80', 'DN100', 'DN150']), cost: [2450, 3200, 4750] },

  // ------------------------------------------------------------- irrigation
  { cat: 'VLI', sub: 'GATE', name: 'Resilient Seated Gate Valve — Irrigation', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1171', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN80', 'DN100', 'DN150', 'DN200']), cost: [410, 545, 865, 1410] },
  { cat: 'VLI', sub: 'CTRL', name: 'Hydraulic Control Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'ISO 5208', uom: 'NOS', hs: '84811000',
    sizes: DN(['DN50', 'DN80', 'DN100', 'DN150']), cost: [980, 1650, 2200, 3400] },
  { cat: 'VLI', sub: 'AIRR', name: 'Combination Air Valve — Irrigation', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1074-4', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN50', 'DN80']), cost: [590, 910] },
  { cat: 'VLI', sub: 'BALL', name: 'Quick Coupling Valve', material: 'Brass',
    pressure: 'PN10', standard: null, uom: 'NOS', hs: '84818090',
    sizes: DN(['1"', '1.5"']), cost: [95, 145] },

  // -------------------------------------------------------- storm & sewage
  { cat: 'VLS', sub: 'PENS', name: 'Cast Iron Penstock (Sluice Gate)', material: 'Cast Iron',
    pressure: 'On-seating', standard: 'BS 7775', uom: 'NOS', hs: '84818090',
    sizes: DN(['300 x 300 mm', '450 x 450 mm', '600 x 600 mm', '900 x 900 mm']),
    cost: [2450, 3600, 5400, 9800] },
  { cat: 'VLS', sub: 'KNIF', name: 'Knife Gate Valve — Wafer Type', material: 'Stainless Steel 316',
    pressure: 'PN10', standard: 'MSS SP-81', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN100', 'DN150', 'DN200', 'DN300']), cost: [820, 1180, 1750, 3100] },
  { cat: 'VLS', sub: 'CHCK', name: 'Flap / Tidal Non-Return Valve', material: 'Ductile Iron',
    pressure: 'PN10', standard: 'BS EN 1074-3', uom: 'NOS', hs: '84813091',
    sizes: DN(['DN200', 'DN300', 'DN400', 'DN600']), cost: [1450, 2200, 3450, 6900] },
  { cat: 'VLS', sub: 'AIRR', name: 'Sewage Air Release Valve', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 1074-4', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN80', 'DN100']), cost: [1350, 1880] },

  // ------------------------------------------------------- district cooling
  { cat: 'VLD', sub: 'BFLY', name: 'Butterfly Valve — District Cooling', material: 'Ductile Iron',
    pressure: 'PN25', standard: 'BS EN 593', uom: 'NOS', hs: '84818030',
    sizes: DN(['DN150', 'DN200', 'DN300', 'DN400', 'DN500']), cost: [1580, 2350, 3900, 5900, 8400] },
  { cat: 'VLD', sub: 'BALN', name: 'Double Regulating Balancing Valve', material: 'Ductile Iron',
    pressure: 'PN25', standard: 'EN 1092-2', uom: 'NOS', hs: '84818090',
    sizes: DN(['DN80', 'DN100', 'DN150', 'DN200']), cost: [1250, 1620, 2450, 3800] },
  { cat: 'VLD', sub: 'CTRL', name: 'Pressure Independent Control Valve', material: 'Ductile Iron',
    pressure: 'PN25', standard: null, uom: 'NOS', hs: '84811000',
    sizes: DN(['DN50', 'DN80', 'DN100']), cost: [1950, 2850, 3950] },
  { cat: 'VLD', sub: 'STRN', name: 'Y-Strainer — District Cooling', material: 'Ductile Iron',
    pressure: 'PN25', standard: null, uom: 'NOS', hs: '84212900',
    sizes: DN(['DN100', 'DN150', 'DN200']), cost: [620, 980, 1520] },

  // ------------------------------------------------------------ geotextiles
  { cat: 'GTP', sub: 'NWOV', name: 'Non-Woven Geotextile', material: 'Polypropylene',
    pressure: null, standard: 'ASTM D4491', uom: 'SQM', hs: '56031300',
    sizes: DN(['150 gsm', '200 gsm', '300 gsm']), cost: [4.2, 5.6, 8.1] },
  { cat: 'GTP', sub: 'GMEM', name: 'HDPE Geomembrane Liner', material: 'HDPE',
    pressure: null, standard: 'GRI-GM13', uom: 'SQM', hs: '39204300',
    sizes: DN(['1.0 mm', '1.5 mm', '2.0 mm']), cost: [11.5, 16.4, 21.8] },
  { cat: 'GTI', sub: 'WOVN', name: 'Woven Geotextile — Irrigation', material: 'Polypropylene',
    pressure: null, standard: 'ASTM D4595', uom: 'SQM', hs: '56031400',
    sizes: DN(['200 gsm', '260 gsm']), cost: [5.9, 7.4] },
  { cat: 'GTI', sub: 'NWOV', name: 'Non-Woven Separation Fabric', material: 'Polypropylene',
    pressure: null, standard: 'ASTM D4491', uom: 'SQM', hs: '56031300',
    sizes: DN(['150 gsm', '200 gsm']), cost: [4.1, 5.4] },
  { cat: 'GTS', sub: 'NWOV', name: 'Geotextile Filter Fabric — Drainage', material: 'Polypropylene',
    pressure: null, standard: 'ASTM D4751', uom: 'SQM', hs: '56031300',
    sizes: DN(['200 gsm', '300 gsm', '400 gsm']), cost: [5.7, 8.3, 11.2] },
  { cat: 'GTS', sub: 'GGRD', name: 'Biaxial Geogrid', material: 'Polypropylene',
    pressure: null, standard: 'ASTM D6637', uom: 'SQM', hs: '39269099',
    sizes: DN(['30 kN/m', '40 kN/m']), cost: [9.8, 13.4] },

  // ---------------------------------------------------------- fabrication
  { cat: 'MFW', sub: 'STRP', name: 'Pipe Support Strap — Galvanised', material: 'Mild Steel, HDG',
    pressure: null, standard: 'BS EN ISO 1461', uom: 'NOS', hs: '73269099',
    sizes: DN(['DN100', 'DN150', 'DN200', 'DN300']), cost: [38, 52, 74, 118] },
  { cat: 'MFW', sub: 'AIRV', name: 'Fabricated Air Vent Assembly', material: 'Stainless Steel 316',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['DN80', 'DN100']), cost: [420, 560] },
  { cat: 'MFW', sub: 'HBAR', name: 'Handle Bar — Chamber Access', material: 'Stainless Steel 316',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['Standard']), cost: [165] },
  { cat: 'MFW', sub: 'CCLP', name: 'C Clamp', material: 'Mild Steel, HDG',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['DN100', 'DN150', 'DN200']), cost: [34, 46, 62] },
  { cat: 'MFW', sub: 'MCLP', name: 'MS Clamp', material: 'Mild Steel, HDG',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['DN100', 'DN200', 'DN300']), cost: [29, 55, 88] },
  { cat: 'MFW', sub: 'SCLP', name: 'Spider Clamp', material: 'Mild Steel, HDG',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['DN200', 'DN300', 'DN400']), cost: [96, 138, 186] },
  { cat: 'MFW', sub: 'GRAT', name: 'Steel Grating — Galvanised', material: 'Mild Steel, HDG',
    pressure: null, standard: 'BS 4592', uom: 'SQM', hs: '73084000',
    sizes: DN(['25 x 3 mm', '30 x 3 mm', '40 x 5 mm']), cost: [215, 248, 315] },
  { cat: 'MFW', sub: 'CHQP', name: 'Chequered Plate — Galvanised', material: 'Mild Steel, HDG',
    pressure: null, standard: 'BS EN 10025', uom: 'SQM', hs: '72085110',
    sizes: DN(['3 mm', '5 mm', '6 mm']), cost: [165, 235, 285] },
  { cat: 'MFW', sub: 'LADR', name: 'MS Ladder — Chamber', material: 'Mild Steel, HDG',
    pressure: null, standard: null, uom: 'MTR', hs: '73084000',
    sizes: DN(['Standard']), cost: [340] },
  { cat: 'MFW', sub: 'EXSP', name: 'Valve Extension Spindle', material: 'Stainless Steel 316',
    pressure: null, standard: null, uom: 'NOS', hs: '73269099',
    sizes: DN(['1.0 m', '1.5 m', '2.0 m', '3.0 m']), cost: [285, 365, 460, 640] },
  { cat: 'MFO', sub: 'PBAR', name: 'Protection Barrier — Road', material: 'Mild Steel, HDG',
    pressure: null, standard: null, uom: 'MTR', hs: '73089099',
    sizes: DN(['Standard']), cost: [285] },
  { cat: 'MFO', sub: 'OTHR', name: 'Fabricated Item — To Drawing', material: 'As specified',
    pressure: null, standard: null, uom: 'LOT', hs: '73269099',
    sizes: DN(['To drawing']), cost: [0] },

  // --------------------------------------------------------- GRP & fasteners
  { cat: 'GRL', sub: 'LADR', name: 'GRP Ladder — Chamber Access', material: 'GRP',
    pressure: null, standard: 'BS EN 14396', uom: 'MTR', hs: '39259080',
    sizes: DN(['Standard']), cost: [420] },
  { cat: 'GRL', sub: 'STEP', name: 'GRP Step Iron', material: 'GRP',
    pressure: null, standard: 'BS EN 13101', uom: 'NOS', hs: '39259080',
    sizes: DN(['Standard']), cost: [58] },
  { cat: 'GRL', sub: 'HRAL', name: 'GRP Handrail System', material: 'GRP',
    pressure: null, standard: null, uom: 'MTR', hs: '39259080',
    sizes: DN(['Standard']), cost: [275] },
  { cat: 'GRL', sub: 'GRAT', name: 'GRP Moulded Grating', material: 'GRP',
    pressure: null, standard: 'ASTM D638', uom: 'SQM', hs: '39259080',
    sizes: DN(['25 mm', '38 mm']), cost: [340, 460] },
  { cat: 'FST', sub: 'BOLT', name: 'Hex Bolt & Nut Set — SS316', material: 'Stainless Steel 316',
    pressure: null, standard: 'DIN 933', uom: 'SET', hs: '73181500',
    sizes: DN(['M16 x 70', 'M20 x 90', 'M24 x 110']), cost: [11.5, 18.4, 29.6] },
  { cat: 'FST', sub: 'BOLT', name: 'Hex Bolt & Nut Set — HDG', material: 'Carbon Steel, HDG',
    pressure: null, standard: 'DIN 933', uom: 'SET', hs: '73181500',
    sizes: DN(['M16 x 70', 'M20 x 90', 'M24 x 110']), cost: [4.2, 6.8, 10.9] },
  { cat: 'FST', sub: 'ANCH', name: 'Chemical Anchor Bolt', material: 'Stainless Steel 316',
    pressure: null, standard: null, uom: 'NOS', hs: '73181900',
    sizes: DN(['M12 x 160', 'M16 x 190']), cost: [14.5, 22.8] },
  { cat: 'FST', sub: 'GSKT', name: 'Full Face EPDM Gasket', material: 'EPDM',
    pressure: 'PN16', standard: 'BS EN 1514-1', uom: 'NOS', hs: '40169300',
    sizes: DN(['DN100', 'DN150', 'DN200', 'DN300']), cost: [9.5, 13.8, 19.4, 34.2] },

  // ----------------------------------------------------- mechanical fittings
  { cat: 'MFP', sub: 'DJNT', name: 'Dismantling Joint', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 545', uom: 'NOS', hs: '73079900',
    sizes: DN(['DN100', 'DN150', 'DN200', 'DN300']), cost: [640, 890, 1350, 2450] },
  { cat: 'MFP', sub: 'FADP', name: 'Flange Adaptor', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 545', uom: 'NOS', hs: '73079900',
    sizes: DN(['DN100', 'DN150', 'DN200', 'DN300']), cost: [285, 395, 610, 1120] },
  { cat: 'MFP', sub: 'CPLG', name: 'Universal Coupling', material: 'Ductile Iron',
    pressure: 'PN16', standard: 'BS EN 545', uom: 'NOS', hs: '73079900',
    sizes: DN(['DN100', 'DN150', 'DN200']), cost: [320, 445, 690] },
  { cat: 'MFP', sub: 'RCLP', name: 'Pipe Repair Clamp', material: 'Stainless Steel 304',
    pressure: 'PN16', standard: null, uom: 'NOS', hs: '73079900',
    sizes: DN(['DN100', 'DN150', 'DN200']), cost: [245, 340, 520] },
  { cat: 'MFI', sub: 'SADL', name: 'Tapping Saddle — Irrigation', material: 'Ductile Iron',
    pressure: 'PN16', standard: null, uom: 'NOS', hs: '73079900',
    sizes: DN(['DN100 x 1"', 'DN150 x 2"']), cost: [120, 165] },
  { cat: 'MFI', sub: 'CPLG', name: 'Compression Coupling — HDPE', material: 'Polypropylene',
    pressure: 'PN16', standard: 'ISO 14236', uom: 'NOS', hs: '39174000',
    sizes: DN(['63 mm', '90 mm', '110 mm']), cost: [42, 78, 118] },
  { cat: 'MFS', sub: 'CPLG', name: 'Flexible Coupling — Sewerage', material: 'Stainless Steel 304',
    pressure: 'PN10', standard: 'BS EN 295', uom: 'NOS', hs: '73079900',
    sizes: DN(['DN150', 'DN200', 'DN300', 'DN400']), cost: [185, 265, 445, 720] },
  { cat: 'MFS', sub: 'FADP', name: 'Flange Adaptor — Sewerage', material: 'Ductile Iron',
    pressure: 'PN10', standard: 'BS EN 545', uom: 'NOS', hs: '73079900',
    sizes: DN(['DN200', 'DN300', 'DN400']), cost: [580, 1050, 1680] },
];

// ------------------------------------------------------------------ people
const USERS = [
  ['admin@akr365.com', 'System Administrator', 'admin', 'Administrator'],
  ['kam@akr365.com', 'Key Account Manager', 'kam', 'Key Account Manager'],
  ['accounts@akr365.com', 'Accounts', 'accounts', 'Accountant'],
  ['sales@akr365.com', 'Sales Officer', 'sales', 'Sales Officer'],
  ['logistics@akr365.com', 'Logistics', 'logistics', 'Logistics Co-ordinator'],
];

const SUPPLIERS = [
  ['Gulf Valve Manufacturing L.L.C', 'Dubai Investment Park, Dubai', 'NET60', 'Valves'],
  ['Emirates Ductile Foundry L.L.C', 'Industrial Area 13, Sharjah', 'NET45', 'Valves & fittings'],
  ['Arabian Geosynthetics Industries', 'Al Quoz Industrial 3, Dubai', 'ADV50', 'Geotextiles'],
  ['Al Manar Steel Fabrication L.L.C', 'Jebel Ali Industrial 1, Dubai', 'NET30', 'Fabrication'],
  ['Composite GRP Industries F.Z.E', 'Hamriyah Free Zone, Sharjah', 'NET45', 'GRP'],
  ['Continental Fasteners Trading L.L.C', 'Deira, Dubai', 'CAD', 'Fasteners'],
];

const CLIENTS = [
  ['Al Sahra Contracting L.L.C', 'Dubai', 'NET60', 500000],
  ['Desert Infrastructure Contracting L.L.C', 'Abu Dhabi', 'PDC90', 750000],
  ['Emirates Utilities Contracting L.L.C', 'Sharjah', 'CHQD', 250000],
  ['Northern Works Contracting L.L.C', 'Ras Al Khaimah', 'ADV50', 150000],
  ['Capital District Cooling Services L.L.C', 'Abu Dhabi', 'NET90', 1000000],
];

// =============================================================================
function seed() {
  const insertCompany = db.prepare(`
    INSERT INTO companies (code, name, legal_name, trn, address, phone, email, website,
      bank_name, bank_account, iban, swift, currency, vat_percent, is_default)
    VALUES (@code, @name, @legal_name, @trn, @address, @phone, @email, @website,
      @bank_name, @bank_account, @iban, @swift, @currency, @vat_percent, @is_default)`);

  // The trading company, and five more slots for the rest of the group. They
  // are deliberately named as placeholders: nobody should be issuing an
  // invoice under a company name this system invented.
  insertCompany.run({
    code: config.group.defaultCompany,
    name: config.company.name,
    legal_name: config.company.name,
    trn: config.company.trn || null,
    address: config.company.address,
    phone: config.company.phone,
    email: config.company.email,
    website: config.company.website,
    // The bank block printed at the foot of a tax invoice, so a client knows
    // where to send the money without ringing to ask.
    bank_name: config.company.bankName || null,
    bank_account: config.company.bankAccount || null,
    iban: config.company.iban || null,
    swift: config.company.swift || null,
    currency: config.vat.currency,
    vat_percent: config.vat.percent,
    is_default: 1,
  });
  for (let n = 2; n <= 6; n += 1) {
    insertCompany.run({
      code: `CO${n}`,
      name: `Group Company ${n} — rename under Masters → Companies`,
      legal_name: null, trn: null, address: null, phone: null, email: null, website: null,
      bank_name: null, bank_account: null, iban: null, swift: null,
      currency: config.vat.currency, vat_percent: config.vat.percent, is_default: 0,
    });
  }
  const akr = db.prepare('SELECT * FROM companies WHERE is_default = 1').get();

  for (const [code, name, order] of APPLICATIONS) {
    db.prepare('INSERT INTO applications (code, name, sort_order) VALUES (?, ?, ?)').run(code, name, order);
  }
  const appId = (code) => (code
    ? db.prepare('SELECT id FROM applications WHERE code = ?').get(code).id : null);

  for (const [code, name, group, app, order] of CATEGORIES) {
    db.prepare(
      'INSERT INTO item_categories (code, name, product_group, application_id, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(code, name, group, appId(app), order);
  }

  for (const [group, types] of SUBGROUPS) {
    types.forEach(([code, name], i) => {
      db.prepare('INSERT INTO item_subgroups (code, name, product_group, sort_order) VALUES (?, ?, ?, ?)')
        .run(code, name, group, i + 1);
    });
  }

  for (const t of PAYMENT_TERMS) {
    db.prepare(`INSERT INTO payment_terms (code, name, kind, credit_days, advance_percent,
        on_delivery_percent, retention_percent, applies_to, description, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...t);
  }
  const termId = (code) => db.prepare('SELECT id FROM payment_terms WHERE code = ?').get(code).id;

  for (const [code, name, kind, order] of EXPENSE_CATEGORIES) {
    db.prepare('INSERT INTO expense_categories (code, name, kind, sort_order) VALUES (?, ?, ?, ?)')
      .run(code, name, kind, order);
  }

  const clauses = require('./clauses-seed').seedClauses(db);

  /*
   * The reference shapes the company already uses. Written per company so each
   * of the six can be given its own, and so a series can be changed later
   * under Masters → Document numbers without touching the code.
   */
  const numbering = require('../services/numbering');
  for (const company of db.prepare('SELECT id, code FROM companies').all()) {
    for (const kind of numbering.KINDS) {
      numbering.save(company.id, kind, {
        pattern: numbering.DEFAULTS[kind].pattern,
        reset_on: numbering.DEFAULTS[kind].reset_on,
        note: numbering.DEFAULTS[kind].note || null,
      });
    }
  }

  db.prepare('INSERT INTO locations (code, name, address, is_default) VALUES (?, ?, ?, 1)')
    .run('YARD', 'Main Yard', config.company.address);
  db.prepare('INSERT INTO locations (code, name, address, is_default) VALUES (?, ?, ?, 0)')
    .run('TRANSIT', 'In Transit / Direct to Site', 'Delivered direct from the manufacturer to site');

  const passwordHash = auth.hashPassword(SEED_PASSWORD);
  for (const [email, name, role, designation] of USERS) {
    db.prepare(`INSERT INTO users (staff_code, name, email, password_hash, role, company_id, designation)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ids.staffCode(), name, email, passwordHash, role, akr.id, designation);
  }
  const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

  for (const [name, address, terms, note] of SUPPLIERS) {
    db.prepare(`INSERT INTO partners (code, type, name, address, emirate, payment_terms_id, currency, notes)
      VALUES (?, 'supplier', ?, ?, ?, ?, 'AED', ?)`).run(
      ids.partnerCode('supplier'), name, address, address.split(',').pop().trim(), termId(terms), note);
  }
  for (const [name, emirate, terms, limit] of CLIENTS) {
    db.prepare(`INSERT INTO partners (code, type, name, address, emirate, payment_terms_id,
        credit_limit, currency, account_manager_id)
      VALUES (?, 'client', ?, ?, ?, ?, ?, 'AED', ?)`).run(
      ids.partnerCode('client'), name, emirate, emirate, termId(terms), limit, userId('kam@akr365.com'));
  }

  // ------------------------------------------------------------- catalogue
  const catId = (code) => db.prepare('SELECT * FROM item_categories WHERE code = ?').get(code);
  const subId = (group, code) =>
    (db.prepare('SELECT id FROM item_subgroups WHERE product_group = ? AND code = ?').get(group, code) || {}).id
    || null;

  let items = 0;
  for (const line of CATALOGUE) {
    const category = catId(line.cat);
    const subgroup = subId(category.product_group, line.sub);
    line.sizes.forEach((size, i) => {
      const cost = Array.isArray(line.cost) ? (line.cost[i] ?? line.cost[0]) : line.cost;
      // A trading margin has to start somewhere: 28% over landed cost, which
      // the company then reprices item by item.
      const sell = Math.round(cost * 1.28 * 100) / 100;
      db.prepare(`INSERT INTO items (item_code, name, description, category_id, subgroup_id,
          application_id, material, size, pressure_class, standard, uom, hs_code, cost_price,
          sell_price, vat_percent, reorder_level, lead_time_days)
        VALUES (@item_code, @name, @description, @category_id, @subgroup_id, @application_id,
          @material, @size, @pressure_class, @standard, @uom, @hs_code, @cost_price, @sell_price,
          @vat_percent, @reorder_level, @lead_time_days)`).run({
        item_code: ids.itemCode(category.code, config.itemCodePrefix),
        name: line.name,
        description: [line.material, line.pressure, line.standard].filter(Boolean).join(', ') || null,
        category_id: category.id,
        subgroup_id: subgroup,
        application_id: category.application_id,
        material: line.material,
        size,
        pressure_class: line.pressure,
        standard: line.standard,
        uom: line.uom,
        hs_code: line.hs,
        cost_price: cost,
        sell_price: sell,
        vat_percent: config.vat.percent,
        // Left at zero on purpose: what is worth keeping on the shelf is the
        // company's decision, item by item, not this file's.
        reorder_level: 0,
        lead_time_days: 30,
      });
      items += 1;
    });
  }

  console.log(`[seed] ${db.prepare('SELECT COUNT(*) AS c FROM companies').get().c} companies, `
    + `${APPLICATIONS.length} applications, ${CATEGORIES.length} product lines, ${items} items, `
    + `${PAYMENT_TERMS.length} payment terms, ${USERS.length} users, `
    + `${SUPPLIERS.length + CLIENTS.length} trading accounts, ${clauses} standard clauses.`);
}

if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
  console.log('[seed] There are already accounts here — nothing was changed.');
} else {
  tx(seed)();
  console.log(`[seed] Sign in as admin@akr365.com with the password "${SEED_PASSWORD}".`);
}

module.exports = { seed, SEED_PASSWORD };
