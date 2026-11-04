'use strict';
/**
 * The send-out menu: what the clinic can order from its referral laboratory.
 *
 * The clinic runs a polyclinic bench, not a reference lab. Everything here is
 * collected at Samiha and sent to the referral laboratory in Tirunelveli, and
 * until now none of it was orderable in this system at all — the front desk
 * took the request on paper and the bill was written by hand.
 *
 * Priced at twice the laboratory's trade rate, which is the rule the owner
 * set. The trade figure is kept beside each one, not for sentiment: it is the
 * cost of sale for every one of these lines, and it is the only thing that
 * makes the margin on send-out work knowable. The commercial eye can read it
 * the day somebody wires it up.
 *
 * Two judgement calls are recorded rather than hidden. Where the trade list
 * quoted a range the LOWER figure was taken, because a price can be raised at
 * the counter and a quote already given cannot. And where a trade row turned
 * out to be a test the clinic already has under another name, the existing
 * row was repriced instead of a second one being added — a duplicate on the
 * order form is how two prices for one test get into a clinic.
 *
 * Sample type and turnaround are starting figures, grouped by what the name
 * says. They are what the clinic edits first; nothing here is a clinical
 * statement about how a specimen must be collected.
 */

/* Generated from the referral laboratory's B2B list dated 02.07.26. */
const SENDOUT = [
  { code: "SO-17OHPROGES",   name: "17 - OH PROGESTERONE",                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-ASOTITRE",     name: "A S O Titre",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-ACIDPHOSPH",   name: "Acid Phosphatase",                                        group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-ADAMTB",       name: "ADA -MTB",                                                group: "Blood tests",                sample: "Serum",          tat:  48, trade:   400, price:   800 },
  { code: "SO-AFBSTAIN",     name: "AFB STAIN",                                               group: "Blood tests",                sample: "As collected",   tat:  72, trade:   100, price:   200 },
  { code: "SO-ALLERGITES",   name: "ALLERGI TEST",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:  7600, price: 15200 },
  { code: "SO-ALPHAFETOP",   name: "Alphafetoprotein",                                        group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-AMMONIA",      name: "Ammonia",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   450, price:   900 },
  { code: "SO-AMYLASE",      name: "Amylase",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-ANABLOT",      name: "ANA BLOT",                                                group: "Blood tests",                sample: "As collected",   tat: 120, trade:  1500, price:  3000 },
  { code: "SO-ANAELISA",     name: "ANA ELISA",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   700, price:  1400 },
  { code: "SO-ANAIF",        name: "ANA-IF",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1800, price:  3600 },
  { code: "SO-ANCAELISA",    name: "ANCA - ELISA",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-ANTICARDIO",   name: "Anti Cardiolipin IgM,IgA,IgG",                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1000, price:  2000 },
  { code: "SO-ANTICCP",      name: "ANTI CCP(CYCLIC CITRULLINATED PEPTIDE)",                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   700, price:  1400 },
  { code: "SO-ANTIMULLER",   name: "Anti Mullerian Hormone",                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-ANTIPHOSPH",   name: "Anti phospholipid antibody",                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1000, price:  2000 },
  { code: "SO-ANTITHROMB",   name: "ANTI THROMBIN III",                                       group: "Blood tests",                sample: "Serum",          tat:  48, trade:  3100, price:  6200 },
  { code: "SO-ANTITHYROG",   name: "ANTI THYROGLOBULIN ANTIBODY",                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-ANTITPOANT",   name: "ANTI TPO ANTIBODY",                                       group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1000, price:  2000 },
  { code: "SO-APTT",         name: "APTT",                                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:   125, price:   250 },
  { code: "SO-BETA2GLYCO",   name: "Beta 2 Glycoprotein IgM",                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1500, price:  3000 },
  { code: "SO-BETA2MICRO",   name: "Beta 2-Microglobin",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1100, price:  2200 },
  { code: "SO-BILEPIGMEN",   name: "Bile Pigment",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:    25, price:    50 },
  { code: "SO-BILESALT",     name: "Bile Salt",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:    25, price:    50 },
  { code: "SO-BLEEDINGTI",   name: "Bleeding Time",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:    25, price:    50 },
  { code: "SO-BLOODCULTU",   name: "Blood Culture & sensitvity (AUTOMATIC)",                  group: "Blood tests",                sample: "As collected",   tat:  72, trade:   750, price:  1500 },
  { code: "SO-BLOODCUL2",    name: "Blood Culture & sensitvity (MANUAL)",                     group: "Blood tests",                sample: "As collected",   tat:  72, trade:   350, price:   700 },
  { code: "SO-BONEMARROW",   name: "BONE MARROW STUDY",                                       group: "Blood tests",                sample: "As collected",   tat: 120, trade:  1000, price:  2000 },
  { code: "SO-CANTIBODY",    name: "C ANTIBODY",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-CANCA",        name: "C-ANCA",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-CPEPTIDE",     name: "C-PEPTIDE",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-C3LEVEL",      name: "C3 Level (Method : RID)",                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-C4",           name: "C4",                                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   700, price:  1400 },
  { code: "SO-CA153",        name: "CA - 15.3",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1100, price:  2200 },
  { code: "SO-CA125",        name: "CA 125 (Ovarian Cancer)",                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-CA199",        name: "CA-19.9",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-CARDIOLIPI",   name: "CARDIOLIPIN ANTIBODY,IgA",                                group: "Blood tests",                sample: "Serum",          tat:  48, trade:   650, price:  1300 },
  { code: "SO-CEACARCINO",   name: "CEA - carcino Embryonic Antigen",                         group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-CELLCOUNT",    name: "Cell Count",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-CERULOPLAS",   name: "Ceruloplasmin",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-CKMB",         name: "CK - MB",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-CLOTTINGTI",   name: "Clotting Time",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:    25, price:    50 },
  { code: "SO-CORTISOLMO",   name: "CORTISOL,MORNING,SERUM",                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-CPKMB",        name: "CPK- MB",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-CPKTOTAL",     name: "CPK-TOTAL",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-DDIMER",       name: "D-Dimer",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-DENGUELISA",   name: "Dengu Elisa",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-DENGUEANTI",   name: "Dengue Antibody IgG",                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-DENGUEAN2",    name: "Dengue Antibody IgM",                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-DENGUENS1A",   name: "Dengue NS1 Antigen",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-DHEASULPHA",   name: "DHEA SULPHATE",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:  2600, price:  5200 },
  { code: "SO-DIRECTCOOM",   name: "Direct Coombs Test",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-DOUBLEMARK",   name: "DOUBLE MARKER",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1200, price:  2400 },
  { code: "SO-ELECTROPHO",   name: "ELECTROPHORESIS",                                         group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-ENAPROFILE",   name: "ENA PROFILE",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1750, price:  3500 },
  { code: "SO-ESTRADIOL",    name: "Estradiol",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   300, price:   600 },
  { code: "SO-FIBRINOGEN",   name: "Fibrinogen",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   300, price:   600 },
  { code: "SO-FOLICACID",    name: "FOLIC ACID",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-FREEPSA",      name: "FREE PSA",                                                group: "Blood tests",                sample: "Serum",          tat:  48, trade:   900, price:  1800 },
  { code: "SO-FREETESTOS",   name: "Free Testosterone",                                       group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-FSH",          name: "FSH",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-FT3",          name: "FT3",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-FT3FT4TSH",    name: "FT3 FT4 TSH",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-FT4",          name: "FT4",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-FUNGALCULT",   name: "FUNGAL CULTURE",                                          group: "Blood tests",                sample: "As collected",   tat:  72, trade:   400, price:   800 },
  { code: "SO-GAMMAGLUTA",   name: "Gamma Glutamyl Transferase",                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-GRAMSTAIN",    name: "GRAM STAIN",                                              group: "Blood tests",                sample: "As collected",   tat:  72, trade:   100, price:   200 },
  { code: "SO-GROWTHHORM",   name: "GROWTH HORMONE",                                          group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-GTT",          name: "GTT",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-HAVIGG",       name: "HAV IgG",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-HBELECTROP",   name: "HB ELECTROPHORESIS",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-HBEAG",        name: "HBeAg",                                                   group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-HBVDNAPCRQ",   name: "HBV -DNA PCR Quantitative",                               group: "Blood tests",                sample: "As collected",   tat: 120, trade:  3500, price:  7000 },
  { code: "SO-HCVELISA",     name: "HCV ELISA",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-HCVQUALITA",   name: "HCV QUALITATIVE PCR",                                     group: "Blood tests",                sample: "As collected",   tat: 120, trade:  2000, price:  4000 },
  { code: "SO-HCVQUANTIT",   name: "HCV QUANTITATIVE PCR",                                    group: "Blood tests",                sample: "As collected",   tat: 120, trade:  3000, price:  6000 },
  { code: "SO-HEVIGG",       name: "HEV IgG",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1350, price:  2700 },
  { code: "SO-HEVIGM",       name: "HEV IgM",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   550, price:  1100 },
  { code: "SO-HIVELISA",     name: "HIV -ELISA",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-HLAB27",       name: "HLAB27",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1200, price:  2400 },
  { code: "SO-HOMOCYSTIN",   name: "HOMOCYSTINE",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1000, price:  2000 },
  { code: "SO-HSCRP",        name: "hs CRP",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-HSVIIIIGMI",   name: "HSV I & II IgM & IgG",                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:  3000, price:  6000 },
  { code: "SO-IGE",          name: "IGE",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-IGG",          name: "IgG",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-IGM",          name: "IgM",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-IL6",          name: "IL - 6 ( INTERLEUKIN - 6 )",                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1750, price:  3500 },
  { code: "SO-IMMUNOGLOB",   name: "IMMUNOGLOBULIN IgE",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-INDIRECTCO",   name: "Indirect Coombs Test",                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-INSULIN",      name: "INSULIN",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-IRONPROFIL",   name: "Iron Profile",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-IRONTIBCRA",   name: "Iron TIBC Ratio",                                         group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-KARRYOTYPI",   name: "KARRYOTYPING",                                            group: "Blood tests",                sample: "As collected",   tat: 120, trade:  4000, price:  8000 },
  { code: "SO-LACTATE",      name: "Lactate",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-LDH",          name: "LDH",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-LEPTOSPIRA",   name: "Leptospira IgG / IgM (ICT)",                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-LH",           name: "LH",                                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-LIPASE",       name: "Lipase",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   300, price:   600 },
  { code: "SO-LITHIUM",      name: "LITHIUM",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-LUPURANTIC",   name: "LUPUR ANTICOAFULAT TEST",                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-MAGNESIUM",    name: "Magnesium",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-MICROALBUM",   name: "Micro Albumin",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-MYOGLOBIN",    name: "Myoglobin",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-PANCA",        name: "P - ANCA",                                                group: "Blood tests",                sample: "Serum",          tat:  48, trade:   800, price:  1600 },
  { code: "SO-PCV",          name: "PCV",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:    50, price:   100 },
  { code: "SO-PERIPHERAL",   name: "Peripheral Smear Study",                                  group: "Blood tests",                sample: "EDTA blood",     tat:  24, trade:   200, price:   400 },
  { code: "SO-PERIPHER2",    name: "Peripheral smear study",                                  group: "Blood tests",                sample: "EDTA blood",     tat:  24, trade:   200, price:   400 },
  { code: "SO-PERIPHER3",    name: "Peripheral smear with reticulocyte and MP/MF",            group: "Blood tests",                sample: "EDTA blood",     tat:  24, trade:   300, price:   600 },
  { code: "SO-PHOSPHORUS",   name: "Phosphorus",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-POTTASSIUM",   name: "Pottassium",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-PROCALCITO",   name: "PROCALCITONIN",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-PROGESTERO",   name: "Progesterone",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-PROLACTIN",    name: "Prolactin",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-PROTIENC",     name: "PROTIEN C",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:  2000, price:  4000 },
  { code: "SO-PROTIENS",     name: "PROTIEN S",                                               group: "Blood tests",                sample: "Serum",          tat:  48, trade:  2000, price:  4000 },
  { code: "SO-QUARDRUPLE",   name: "QUARDRUPLE MARKER",                                       group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1300, price:  2600 },
  { code: "SO-RAFACTOR",     name: "RA - FACTOR",                                             group: "Blood tests",                sample: "Serum",          tat:  48, trade:   150, price:   300 },
  { code: "SO-RETICULOCY",   name: "RETICULOCYTE COUNT",                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   250, price:   500 },
  { code: "SO-SCRUBTYPHU",   name: "Scrub Typhus",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-SERUMBILIR",   name: "SERUM BILIRUBIN",                                         group: "Blood tests",                sample: "Serum",          tat:  48, trade:   125, price:   250 },
  { code: "SO-SERUMCORTI",   name: "Serum Cortisol",                                          group: "Blood tests",                sample: "Serum",          tat:  48, trade:   500, price:  1000 },
  { code: "SO-SERUMELECT",   name: "Serum Electrophoresis for proteins",                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:   700, price:  1400 },
  { code: "SO-SGOT",         name: "SGOT",                                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-SGPT",         name: "SGPT",                                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-SRZINC",       name: "Sr.Zinc",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:   650, price:  1300 },
  { code: "SO-STONEANALY",   name: "Stone Analysis",                                          group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1050, price:  2100 },
  { code: "SO-STS",          name: "STS",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   200, price:   400 },
  { code: "SO-TSH",          name: "T.S.H",                                                   group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-T4",           name: "T4",                                                      group: "Blood tests",                sample: "Serum",          tat:  48, trade:    60, price:   120 },
  { code: "SO-TBCULTURE",    name: "TB CULTURE ( AFB )",                                      group: "Blood tests",                sample: "As collected",   tat:  72, trade:  1200, price:  2400 },
  { code: "SO-TBGOLD",       name: "TB GOLD",                                                 group: "Blood tests",                sample: "Serum",          tat:  48, trade:  2000, price:  4000 },
  { code: "SO-TBPCR",        name: "TB.PCR",                                                  group: "Blood tests",                sample: "As collected",   tat: 120, trade:  1750, price:  3500 },
  { code: "SO-THYROGLOBU",   name: "THYROGLOBULIN (Tg),",                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-TORCHPANEL",   name: "Torch Panel IgM",                                         group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-TORCHPAN2",    name: "Torch panel Igm / IgG",                                   group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1500, price:  3000 },
  { code: "SO-TOTALCHOLE",   name: "Total Cholesterol",                                       group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-TOTALPROTE",   name: "Total Protein",                                           group: "Blood tests",                sample: "Serum",          tat:  48, trade:   100, price:   200 },
  { code: "SO-TPHA",         name: "TPHA",                                                    group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-TPO",          name: "TPO",                                                     group: "Blood tests",                sample: "Serum",          tat:  48, trade:  1000, price:  2000 },
  { code: "SO-TRIGLICRID",   name: "Triglicrides",                                            group: "Blood tests",                sample: "Serum",          tat:  48, trade:    50, price:   100 },
  { code: "SO-TRIPLEHRAP",   name: "Triple - H Rapid",                                        group: "Blood tests",                sample: "Serum",          tat:  48, trade:   350, price:   700 },
  { code: "SO-TROPI",        name: "Trop I",                                                  group: "Blood tests",                sample: "Serum",          tat:  48, trade:   600, price:  1200 },
  { code: "SO-TROPONINT",    name: "Troponin T",                                              group: "Blood tests",                sample: "Serum",          tat:  48, trade:   750, price:  1500 },
  { code: "SO-WESTERNBLO",   name: "WESTERN BLOT",                                            group: "Blood tests",                sample: "As collected",   tat: 120, trade:  2000, price:  4000 },
  { code: "SO-APPENDIXBI",   name: "Appendix biopsy",                                         group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   400, price:   800 },
  { code: "SO-BIOPSY",       name: "Biopsy",                                                  group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:  1000, price:  2000 },
  { code: "SO-CERVIXBIOP",   name: "Cervix biopsy",                                           group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   400, price:   800 },
  { code: "SO-CIRCUMCISI",   name: "Circumcision biopsy",                                     group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-COLONBIOPS",   name: "Colon biopsy",                                            group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-CYTOLOGY",     name: "CYTOLOGY",                                                group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-DERMOIDCYS",   name: "Dermoid cyst specimen",                                   group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   400, price:   800 },
  { code: "SO-ENDOMETR2",    name: "Endometrium and cervix biopsy",                           group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   600, price:  1200 },
  { code: "SO-ENDOMETRIU",   name: "Endometrium biopsy",                                      group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   400, price:   800 },
  { code: "SO-FALLOPIANT",   name: "Fallopian tube biopsy",                                   group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   300, price:   600 },
  { code: "SO-FLUIDCYTOL",   name: "Fluid cytology",                                          group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-FNAC",         name: "FNAC",                                                    group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:  1000, price:  2000 },
  { code: "SO-FNACSLIDES",   name: "FNAC slides",                                             group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   600, price:  1200 },
  { code: "SO-GALLBLADDE",   name: "Gall bladder specimen",                                   group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-HEMITHYROI",   name: "Hemithyroidectomy specimen",                              group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-INCISIONAL",   name: "Incisional / skin biopsy",                                group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-LIPOMASPEC",   name: "Lipoma specimen",                                         group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   400, price:   800 },  // range on the trade list — lower figure taken
  { code: "SO-MRMWITHAXI",   name: "MRM with axillary node",                                  group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:  1500, price:  3000 },
  { code: "SO-OGDSCOPYBI",   name: "OGD scopy biopsy",                                        group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-ONCOLOGYSP",   name: "Oncology specimen",                                       group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:  1500, price:  3000 },  // range on the trade list — lower figure taken
  { code: "SO-ORCHIDECTO",   name: "Orchidectomy specimen",                                   group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   600, price:  1200 },
  { code: "SO-OVARIANCYS",   name: "Ovarian cyst specimen",                                   group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-PAPSMEARSL",   name: "Pap smear slide reading",                                 group: "Histopathology & cytology",  sample: "Cervical smear", tat:  72, trade:   400, price:   800 },
  { code: "SO-RESECTIONA",   name: "Resection and anastomosis of intestine",                  group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   700, price:  1400 },
  { code: "SO-SMALLWIDEL",   name: "Small wide local excision biopsy",                        group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-TOTALTHYRO",   name: "Total thyroidectomy specimen",                            group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   600, price:  1200 },
  { code: "SO-TRUCUTBIOP",   name: "Trucut biopsy",                                           group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   500, price:  1000 },
  { code: "SO-UTERUSCERV",   name: "Uterus, cervix and BSO",                                  group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   600, price:  1200 },
  { code: "SO-UTERUSCE2",    name: "Uterus, cervix and BSO with huge myoma or ovarian cyst",  group: "Histopathology & cytology",  sample: "Tissue",         tat: 120, trade:   700, price:  1400 },
  { code: "SO-ACETONE",      name: "ACETONE",                                                 group: "Urine & stool",              sample: "Urine",          tat:   6, trade:    50, price:   100 },
  { code: "SO-BENCEJONES",   name: "Bence Jones protein",                                     group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   200, price:   400 },
  { code: "SO-BODYFLUIDC",   name: "Body Fluid C/S",                                          group: "Urine & stool",              sample: "Swab / fluid",   tat:  72, trade:   150, price:   300 },
  { code: "SO-GCT",          name: "GCT",                                                     group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   150, price:   300 },
  { code: "SO-OGCT",         name: "OGCT",                                                    group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   150, price:   300 },
  { code: "SO-OVACYST",      name: "OVA&CYST",                                                group: "Urine & stool",              sample: "Urine",          tat:   6, trade:    50, price:   100 },
  { code: "SO-REDUCINGSU",   name: "Reducing Substance",                                      group: "Urine & stool",              sample: "Urine",          tat:   6, trade:    50, price:   100 },
  { code: "SO-ROWATERCS",    name: "RO Water C/S",                                            group: "Urine & stool",              sample: "Swab / fluid",   tat:  72, trade:   150, price:   300 },
  { code: "SO-STOOLCS",      name: "Stool C/S",                                               group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   150, price:   300 },
  { code: "SO-SWABPUSCS",    name: "Swab /Pus C/S",                                           group: "Urine & stool",              sample: "Swab / fluid",   tat:  72, trade:   150, price:   300 },
  { code: "SO-THEATRESWA",   name: "THEATRE SWAB",                                            group: "Urine & stool",              sample: "Swab / fluid",   tat:  72, trade:  2000, price:  4000 },
  { code: "SO-URINEACETO",   name: "URINE ACETONE",                                           group: "Urine & stool",              sample: "Urine",          tat:   6, trade:    50, price:   100 },
  { code: "SO-URINEANALY",   name: "URINE ANALYSIS",                                          group: "Urine & stool",              sample: "Urine",          tat:   6, trade:    75, price:   150 },
  { code: "SO-URINEBENCE",   name: "URINE Bence Jones Protein",                               group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   200, price:   400 },
  { code: "SO-URINEMICRO",   name: "Urine Micro Albumin",                                     group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   200, price:   400 },
  { code: "SO-URINEPCR",     name: "URINE PCR",                                               group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   100, price:   200 },
  { code: "SO-URINESODIU",   name: "Urine Sodium",                                            group: "Urine & stool",              sample: "Urine",          tat:   6, trade:   100, price:   200 },
];

/*
 * Trade rows that turned out to be a panel analyte the clinic already
 * reports. Repriced where they stand; adding them again would put the same
 * test on the order form twice at two different prices.
 */
const ANALYTE_REPRICE = [
  { code: "ALB",         price:   200, trade:   100 },  // Albumin
  { code: "ALP",         price:   200, trade:   100 },  // Alkaline Phosphatase
  { code: "CBC-AEOS",    price:   200, trade:   100 },  // Absolute eosinophil count
  { code: "CBC-LYMPP",   price:   200, trade:   100 },  // Lymphocytes
  { code: "EGFR",        price:   100, trade:    50 },  // EGFR
  { code: "FERRITIN",    price:   600, trade:   300 },  // FERRITIN
  { code: "LIP-TG",      price:   200, trade:   100 },  // Serum Triglycerides
];

/**
 * Load anything missing. Idempotent by code: a test already on the catalogue
 * is left exactly as it is, because by then the clinic owns its price.
 */
function load(db) {
  const exists = db.prepare('SELECT 1 FROM lab_tests WHERE code = ?');
  const insert = db.prepare(
    `INSERT INTO lab_tests (code, name, category, bill_group, sample_type, price, tat_hours, active)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, 1)`
  );
  const reprice = db.prepare(
    'UPDATE lab_tests SET price = ? WHERE code = ? AND price != ?');

  let added = 0;
  let repriced = 0;
  db.transaction(() => {
    for (const t of SENDOUT) {
      if (exists.get(t.code)) continue;
      insert.run(t.code, t.name, t.group, t.sample, t.price, t.tat);
      added += 1;
    }
    for (const r of ANALYTE_REPRICE) {
      repriced += reprice.run(r.price, r.code, r.price).changes;
    }
  })();
  return { added, repriced, total: SENDOUT.length };
}

module.exports = { SENDOUT, ANALYTE_REPRICE, load };
