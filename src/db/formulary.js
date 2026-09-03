'use strict';
/*
 * Samiha Healthcare — the pharmacy's starter formulary.
 *
 * Taken from the clinic's own starter stock list. Ninety items: the sheet's
 * eighty-three lines, with the ones that name several sizes counted apart,
 * because a 18G cannula and a 22G are bought, priced and counted separately.
 *
 * Two things this file deliberately does not carry.
 *
 * No prices. A medicine's MRP is printed on the pack it arrives in and differs
 * between batches and brands, so it is recorded when the goods are received,
 * not guessed here. Until then an item can be prescribed and ordered but has
 * no rate.
 *
 * No stock. Loading a formulary is not the same as having the medicines on the
 * shelf: writing opening batches here would put quantities in the register
 * that nobody has counted and let the counter dispense against them. The
 * opening quantity from the sheet is kept as a suggestion instead — the
 * reorder level is set from it, and the pharmacy's opening-stock sheet offers
 * it as the proposed count when the shelf is first filled, for a pharmacist to
 * accept or type over. It becomes stock when a person says it is on the shelf,
 * and the adjustment carries their name.
 *
 * Columns: code, name, generic, form, strength, category, schedule, pack,
 * suggested opening quantity in units.
 */
module.exports = [
  // Analgesics / Antipyretics
  ['PARA-500MG-TAB', 'Paracetamol 500 mg', 'Paracetamol', 'tablet', '500 mg', 'Analgesics / Antipyretics', 'OTC', 'Strip of 10', 1000],
  ['PARA-650MG-TAB', 'Paracetamol 650 mg', 'Paracetamol', 'tablet', '650 mg', 'Analgesics / Antipyretics', 'OTC', 'Strip of 10', 500],
  ['IBU-400MG-TAB', 'Ibuprofen 400 mg', 'Ibuprofen', 'tablet', '400 mg', 'Analgesics / Antipyretics', 'OTC', 'Strip of 10', 500],
  ['DICLO-50MG-TAB', 'Diclofenac 50 mg', 'Diclofenac', 'tablet', '50 mg', 'Analgesics / Antipyretics', 'H', 'Strip of 10', 300],
  ['ACECLO-TAB', 'Aceclofenac + Paracetamol', 'Aceclofenac + Paracetamol', 'tablet', '', 'Analgesics / Antipyretics', 'H', 'Strip of 10', 300],
  ['TRAM-50MG-TAB', 'Tramadol 50 mg', 'Tramadol', 'tablet', '50 mg', 'Analgesics / Antipyretics', 'H1', 'Strip of 10', 100],
  ['PARA-SYR', 'Paracetamol', 'Paracetamol', 'syrup', '', 'Analgesics / Antipyretics', 'OTC', 'Bottle', 30],

  // Antibiotics
  ['AMOX-500MG-CAP', 'Amoxicillin 500 mg', 'Amoxicillin', 'capsule', '500 mg', 'Antibiotics', 'H', 'Strip of 10', 500],
  ['AMOXCLAV-625MG-TAB', 'Amoxicillin + Clavulanic Acid 625 mg', 'Amoxicillin + Clavulanic Acid', 'tablet', '625 mg', 'Antibiotics', 'H', 'Strip of 10', 500],
  ['AZI-500MG-TAB', 'Azithromycin 500 mg', 'Azithromycin', 'tablet', '500 mg', 'Antibiotics', 'H', 'Strip of 3/5', 90],
  ['CIPRO-500MG-TAB', 'Ciprofloxacin 500 mg', 'Ciprofloxacin', 'tablet', '500 mg', 'Antibiotics', 'H', 'Strip of 10', 300],
  ['METRO-400MG-TAB', 'Metronidazole 400 mg', 'Metronidazole', 'tablet', '400 mg', 'Antibiotics', 'H', 'Strip of 10', 300],
  ['CEFIX-200MG-TAB', 'Cefixime 200 mg', 'Cefixime', 'tablet', '200 mg', 'Antibiotics', 'H', 'Strip of 10', 300],
  ['DOXY-100MG-CAP', 'Doxycycline 100 mg', 'Doxycycline', 'capsule', '100 mg', 'Antibiotics', 'H', 'Strip of 10', 200],
  ['AMOX-SYR', 'Amoxicillin', 'Amoxicillin', 'syrup', '', 'Antibiotics', 'H', 'Bottle', 20],

  // Gastro-intestinal / Antacids
  ['PAN-40MG-TAB', 'Pantoprazole 40 mg', 'Pantoprazole', 'tablet', '40 mg', 'Gastro-intestinal / Antacids', 'H', 'Strip of 10', 500],
  ['OMEP-20MG-CAP', 'Omeprazole 20 mg', 'Omeprazole', 'capsule', '20 mg', 'Gastro-intestinal / Antacids', 'H', 'Strip of 10', 300],
  ['DOMP-10MG-TAB', 'Domperidone 10 mg', 'Domperidone', 'tablet', '10 mg', 'Gastro-intestinal / Antacids', 'H', 'Strip of 10', 300],
  ['ORS-SAC', 'ORS', 'ORS', 'sachet', '', 'Gastro-intestinal / Antacids', 'OTC', 'Box of 25', 250],
  ['ANTACID-SYR', 'Antacid (Al/Mg hydroxide)', 'Antacid (Al/Mg hydroxide)', 'syrup', '', 'Gastro-intestinal / Antacids', 'OTC', 'Bottle', 30],
  ['ONDA-4MG-TAB', 'Ondansetron 4 mg', 'Ondansetron', 'tablet', '4 mg', 'Gastro-intestinal / Antacids', 'H', 'Strip of 10', 200],
  ['LOPER-2MG-TAB', 'Loperamide 2 mg', 'Loperamide', 'tablet', '2 mg', 'Gastro-intestinal / Antacids', 'H', 'Strip of 10', 200],

  // Antihistamines / Cold & Cough
  ['CETZ-10MG-TAB', 'Cetirizine 10 mg', 'Cetirizine', 'tablet', '10 mg', 'Antihistamines / Cold & Cough', 'H', 'Strip of 10', 500],
  ['LEVOCET-5MG-TAB', 'Levocetirizine 5 mg', 'Levocetirizine', 'tablet', '5 mg', 'Antihistamines / Cold & Cough', 'H', 'Strip of 10', 300],
  ['CPM-SYR', 'Chlorpheniramine', 'Chlorpheniramine', 'syrup', '', 'Antihistamines / Cold & Cough', 'H', 'Bottle', 20],
  ['COUGHSYR-100ML-SOL', 'Cough syrup (Dextromethorphan) 100 ml', 'Cough syrup (Dextromethorphan)', 'syrup', '100 ml', 'Antihistamines / Cold & Cough', 'H', 'Bottle', 30],
  ['PARAPHEN-TAB', 'Paracetamol + Phenylephrine', 'Paracetamol + Phenylephrine', 'tablet', '', 'Antihistamines / Cold & Cough', 'OTC', 'Strip of 10', 300],

  // Anti-diabetics
  ['MET-500MG-TAB', 'Metformin 500 mg', 'Metformin', 'tablet', '500 mg', 'Anti-diabetics', 'H', 'Strip of 10', 500],
  ['GLIM-1MG-TAB', 'Glimepiride 1 mg', 'Glimepiride', 'tablet', '1 mg', 'Anti-diabetics', 'H', 'Strip of 10', 300],
  ['GLIM-2MG-TAB', 'Glimepiride 2 mg', 'Glimepiride', 'tablet', '2 mg', 'Anti-diabetics', 'H', 'Strip of 10', 300],
  ['INSUL-INJ', 'Human Insulin (Mixtard/Actrapid)', 'Human Insulin (Mixtard/Actrapid)', 'injection', '', 'Anti-diabetics', 'H', 'Vial', 10],
  ['GLUCOMET-CON', 'Glucometer strips', 'Glucometer strips', 'consumable', '', 'Anti-diabetics', '', 'Box of 25/50', 250],

  // Cardiac / Blood Pressure
  ['AMLO-5MG-TAB', 'Amlodipine 5 mg', 'Amlodipine', 'tablet', '5 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 500],
  ['ATEN-50MG-TAB', 'Atenolol 50 mg', 'Atenolol', 'tablet', '50 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 300],
  ['TELMI-40MG-TAB', 'Telmisartan 40 mg', 'Telmisartan', 'tablet', '40 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 300],
  ['ATOR-10MG-TAB', 'Atorvastatin 10 mg', 'Atorvastatin', 'tablet', '10 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 300],
  ['ATOR-20MG-TAB', 'Atorvastatin 20 mg', 'Atorvastatin', 'tablet', '20 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 300],
  ['ASP-75MG-TAB', 'Aspirin 75 mg', 'Aspirin', 'tablet', '75 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 14', 420],
  ['CLOPI-75MG-TAB', 'Clopidogrel 75 mg', 'Clopidogrel', 'tablet', '75 mg', 'Cardiac / Blood Pressure', 'H', 'Strip of 10', 200],

  // Vitamins & Supplements
  ['MVIT-TAB', 'Multivitamin', 'Multivitamin', 'tablet', '', 'Vitamins & Supplements', 'OTC', 'Strip of 15', 750],
  ['VITAMINB-TAB', 'Vitamin B-Complex', 'Vitamin B-Complex', 'tablet', '', 'Vitamins & Supplements', 'OTC', 'Strip / 10 amp', 30],
  ['VITAMINB-INJ', 'Vitamin B-Complex', 'Vitamin B-Complex', 'injection', '', 'Vitamins & Supplements', 'OTC', 'Strip / 10 amp', 30],
  ['VITAMIND-60000IU-SAC', 'Vitamin D3 60000 IU', 'Vitamin D3', 'sachet', '60000 IU', 'Vitamins & Supplements', 'OTC', 'Sachet', 30],
  ['CALCIUMV-TAB', 'Calcium + Vitamin D3', 'Calcium + Vitamin D3', 'tablet', '', 'Vitamins & Supplements', 'OTC', 'Strip of 15', 450],
  ['IRONFOLI-TAB', 'Iron + Folic Acid', 'Iron + Folic Acid', 'tablet', '', 'Vitamins & Supplements', 'OTC', 'Strip of 10', 300],
  ['FOLICACI-5MG-TAB', 'Folic Acid 5 mg', 'Folic Acid', 'tablet', '5 mg', 'Vitamins & Supplements', 'OTC', 'Strip of 10', 200],

  // Dermatology
  ['CLOTRI-CRM', 'Clotrimazole', 'Clotrimazole', 'cream', '', 'Dermatology', 'H', 'Tube', 20],
  ['BETA-CRM', 'Betamethasone', 'Betamethasone', 'cream', '', 'Dermatology', 'H', 'Tube', 20],
  ['POVID-CRM', 'Povidone Iodine', 'Povidone Iodine', 'cream', '', 'Dermatology', 'OTC', 'Tube', 20],
  ['CALAM-SOL', 'Calamine', 'Calamine', 'solution', '', 'Dermatology', 'OTC', 'Bottle', 10],
  ['FUSID-CRM', 'Fusidic Acid', 'Fusidic Acid', 'cream', '', 'Dermatology', 'H', 'Tube', 15],

  // Antiseptics & Wound Care
  ['POVID-SOL', 'Povidone Iodine', 'Povidone Iodine', 'solution', '', 'Antiseptics & Wound Care', 'OTC', 'Bottle', 20],
  ['HYDROGEN-SOL', 'Hydrogen Peroxide', 'Hydrogen Peroxide', 'solution', '', 'Antiseptics & Wound Care', 'OTC', 'Bottle', 10],
  ['SURGICAL-SOL', 'Surgical Spirit', 'Surgical Spirit', 'solution', '', 'Antiseptics & Wound Care', 'OTC', 'Bottle', 10],
  ['COTTONRO-CON', 'Cotton Roll', 'Cotton Roll', 'consumable', '', 'Antiseptics & Wound Care', '', 'Roll', 20],
  ['GAUZEBAN-CON', 'Gauze / Bandage Roll', 'Gauze / Bandage Roll', 'consumable', '', 'Antiseptics & Wound Care', '', 'Piece', 50],
  ['ADHESIVE-CON', 'Adhesive Tape', 'Adhesive Tape', 'consumable', '', 'Antiseptics & Wound Care', '', 'Roll', 20],
  ['STERILED-CON', 'Sterile Dressing Pads', 'Sterile Dressing Pads', 'consumable', '', 'Antiseptics & Wound Care', '', 'Piece', 50],
  ['BANDAID-CON', 'Adhesive Bandages (Band-Aid)', 'Adhesive Bandages (Band-Aid)', 'consumable', '', 'Antiseptics & Wound Care', '', 'Box', 5],

  // IV Fluids & Injectable Consumables
  ['NORMALSA-IV', 'Normal Saline 0.9%', 'Normal Saline 0.9%', 'iv_fluid', '', 'IV Fluids & Injectable Consumables', 'H', 'Bottle', 30],
  ['RINGERLA-IV', 'Ringer Lactate', 'Ringer Lactate', 'iv_fluid', '', 'IV Fluids & Injectable Consumables', 'H', 'Bottle', 20],
  ['DEXTROSE-IV', 'Dextrose 5%', 'Dextrose 5%', 'iv_fluid', '', 'IV Fluids & Injectable Consumables', 'H', 'Bottle', 20],
  ['IVCANNUL-18G-CON', 'IV Cannula 18 G', 'IV Cannula', 'consumable', '18 G', 'IV Fluids & Injectable Consumables', '', 'Piece', 20],
  ['IVCANNUL-20G-CON', 'IV Cannula 20 G', 'IV Cannula', 'consumable', '20 G', 'IV Fluids & Injectable Consumables', '', 'Piece', 20],
  ['IVCANNUL-22G-CON', 'IV Cannula 22 G', 'IV Cannula', 'consumable', '22 G', 'IV Fluids & Injectable Consumables', '', 'Piece', 20],
  ['DISPOSAB-2ML-CON', 'Disposable Syringes 2 ml', 'Disposable Syringes', 'consumable', '2 ml', 'IV Fluids & Injectable Consumables', '', 'Piece', 100],
  ['DISPOSAB-5ML-CON', 'Disposable Syringes 5 ml', 'Disposable Syringes', 'consumable', '5 ml', 'IV Fluids & Injectable Consumables', '', 'Piece', 100],
  ['DISPOSAB-10ML-CON', 'Disposable Syringes 10 ml', 'Disposable Syringes', 'consumable', '10 ml', 'IV Fluids & Injectable Consumables', '', 'Piece', 100],
  ['DISPOSAB-CON', 'Disposable Gloves', 'Disposable Gloves', 'consumable', '', 'IV Fluids & Injectable Consumables', '', 'Box of 100', 2000],
  ['ALCOHOLS-SAC', 'Alcohol Swabs', 'Alcohol Swabs', 'sachet', '', 'IV Fluids & Injectable Consumables', 'OTC', 'Box of 100', 500],

  // Emergency / Crash-Cart Medicines
  ['ADREN-1MGML-INJ', 'Adrenaline (Epinephrine) 1 mg/ml', 'Adrenaline (Epinephrine)', 'injection', '1 mg/ml', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],
  ['ATROP-INJ', 'Atropine Sulfate', 'Atropine Sulfate', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],
  ['HYDROCORT-100MG-INJ', 'Hydrocortisone 100 mg', 'Hydrocortisone', 'injection', '100 mg', 'Emergency / Crash-Cart Medicines', 'H', 'Vial', 10],
  ['DEXA-INJ', 'Dexamethasone', 'Dexamethasone', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],
  ['DIAZ-INJ', 'Diazepam', 'Diazepam', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H1', 'Ampoule', 5],
  ['FURO-INJ', 'Furosemide', 'Furosemide', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],
  ['DERIPH-INJ', 'Deriphylline', 'Deriphylline', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],
  ['PROMET-INJ', 'Promethazine', 'Promethazine', 'injection', '', 'Emergency / Crash-Cart Medicines', 'H', 'Ampoule', 10],

  // Gynae / Obstetric essentials
  ['IRONFOLI-TAB-2', 'Iron + Folic Acid (antenatal)', 'Iron + Folic Acid (antenatal)', 'tablet', '', 'Gynae / Obstetric essentials', 'OTC', 'Strip of 10', 300],
  ['PROGEST-TAB', 'Progesterone', 'Progesterone', 'tablet', '', 'Gynae / Obstetric essentials', 'H', 'Strip of 10', 200],
  ['ISOXS-TAB', 'Isoxsuprine', 'Isoxsuprine', 'tablet', '', 'Gynae / Obstetric essentials', 'H', 'Strip of 10', 200],

  // Pediatric Formulations
  ['PARA-DRP', 'Paracetamol', 'Paracetamol', 'drops', '', 'Pediatric Formulations', 'OTC', 'Bottle', 20],
  ['ZINCSULP-SYR', 'Zinc Sulphate', 'Zinc Sulphate', 'syrup', '', 'Pediatric Formulations', 'OTC', 'Bottle', 20],
  ['MVIT-DRP', 'Multivitamin', 'Multivitamin', 'drops', '', 'Pediatric Formulations', 'OTC', 'Bottle', 20],

  // OTC & Clinic Equipment
  ['DIGITALB-DEV', 'Digital BP Monitor', 'Digital BP Monitor', 'device', '', 'OTC & Clinic Equipment', '', 'Unit', 3],
  ['DIGITALT-DEV', 'Digital Thermometer', 'Digital Thermometer', 'device', '', 'OTC & Clinic Equipment', '', 'Unit', 5],
  ['PULSEOXI-DEV', 'Pulse Oximeter', 'Pulse Oximeter', 'device', '', 'OTC & Clinic Equipment', '', 'Unit', 3],
  ['FACEMASK-CON', 'Face Masks', 'Face Masks', 'consumable', '', 'OTC & Clinic Equipment', '', 'Box of 50', 500],
  ['HANDSANI-500ML-SOL', 'Hand Sanitizer 500 ml', 'Hand Sanitizer', 'solution', '500 ml', 'OTC & Clinic Equipment', 'OTC', 'Bottle', 10],
  ['NEBULIZE-CON', 'Nebulizer Kit / Masks', 'Nebulizer Kit / Masks', 'consumable', '', 'OTC & Clinic Equipment', '', 'Set', 10],
];
