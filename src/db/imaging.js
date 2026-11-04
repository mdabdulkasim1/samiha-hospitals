'use strict';
/**
 * X-ray, ultrasound and Doppler, from the Manitham rate card.
 *
 * The clinic chose to adopt this card wholesale rather than merge it into
 * what was here. The two lists barely overlapped — 21 studies of 169 were
 * recognisably the same thing — because they are written for different
 * places: ours was a curated polyclinic list, this is a radiology network's
 * billing menu, with a separate line for every view and every combination.
 * Merging them would have put two names and two prices on the order form for
 * the same film, which is the one outcome worth avoiding.
 *
 * Priced at the card rate x 1.2, which is the rule the clinic set.
 *
 * The card rate is kept beside each one. These are read by a radiologist the
 * clinic pays, so the card rate is the cost of sale for every line here, and
 * the only thing that makes the margin on imaging knowable.
 *
 * Two studies appear twice on the card at different rates — chest PA at 200
 * and 450, abdomen-pelvis at 1000 and 2000. The clinic took the higher of
 * each; the lower rows are not loaded.
 *
 * Nothing is deleted. The 86 studies this replaces are switched off, not
 * removed: a report issued last year names the study it was issued for, and
 * that name has to keep resolving.
 *
 * Ordered down the body rather than down the alphabet, because that is how a
 * request is written and how a radiographer reads a list: the chest first,
 * since most of them are, then head and neck, the spine, the limbs, the
 * abdomen, and the contrast studies last because they are booked rather than
 * walked in. The card itself arrives in no order at all. The numbers are
 * gapped so the clinic can slot something between two of them later.
 */

/* Generated from Manitham_Rate_Card.xlsx — ROTN circle, Tirunelveli centre. */
const IMAGING = [
  { code: "USG-ABDOMENPELV",   name: "ABDOMEN PELVIS",                                          group: "Ultrasound & Doppler",    price:   960, rate:   800, tat:  3, sort:   10 },
  { code: "USG-ABDOMEN",       name: "ULTRASOUND ABDOMEN",                                      group: "Ultrasound & Doppler",    price:  1320, rate:  1100, tat:  3, sort:   20 },
  { code: "USG-WHOLEABDOME",   name: "ULTRASOUND WHOLE ABDOMEN",                                group: "Ultrasound & Doppler",    price:   720, rate:   600, tat:  3, sort:   30 },
  { code: "USG-WHOLEABDO2",    name: "Ultrasound \u2013 Whole Abdomen with PV Residual",        group: "Ultrasound & Doppler",    price:  1320, rate:  1100, tat:  3, sort:   40 },
  { code: "USG-WHOLEABDO3",    name: "Ultrasound- Whole Abdomen",                               group: "Ultrasound & Doppler",    price:   960, rate:   800, tat:  2, sort:   50 },
  { code: "USG-USWHOLEABDO",   name: "US - Whole Abdomen",                                      group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:   60 },
  { code: "USG-US4DABDOMEN",   name: "US 4D Abdomen Pelvis",                                    group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  3, sort:   70 },
  { code: "USG-USABDOMENPE",   name: "US Abdomen Pelvis",                                       group: "Ultrasound & Doppler",    price:  2400, rate:  2000, tat:  3, sort:   80 },
  { code: "USG-USABDOMEN2",    name: "US Abdomen Pelvis Screening",                             group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:   90 },
  { code: "USG-USABDOMEN3",    name: "US Abdomen Pelvis With TVS",                              group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  100 },
  { code: "USG-USKUB",         name: "US KUB",                                                  group: "Ultrasound & Doppler",    price:  1200, rate:  1000, tat:  3, sort:  110 },
  { code: "USG-USWHOLEAB2",    name: "US WHOLE ABDOMEN",                                        group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:  120 },
  { code: "USG-USANOMALY",     name: "US Anomaly",                                              group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  130 },
  { code: "USG-USANOMALYSC",   name: "US ANOMALY SCAN",                                         group: "Ultrasound & Doppler",    price:  1200, rate:  1000, tat:  3, sort:  140 },
  { code: "USG-USBASELINEF",   name: "US Baseline Follicular Study",                            group: "Ultrasound & Doppler",    price:   720, rate:   600, tat:  3, sort:  150 },
  { code: "USG-USFOLLICULA",   name: "US Follicular Study",                                     group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:  160 },
  { code: "USG-USOBST4D",      name: "US OBST 4D",                                              group: "Ultrasound & Doppler",    price:  2400, rate:  2000, tat:  3, sort:  170 },
  { code: "USG-USOBSTAFI",     name: "US OBST AFI",                                             group: "Ultrasound & Doppler",    price:  1080, rate:   900, tat:  3, sort:  180 },
  { code: "USG-USPELVIS",      name: "US Pelvis",                                               group: "Ultrasound & Doppler",    price:  1320, rate:  1100, tat:  3, sort:  190 },
  { code: "USG-USTVS",         name: "US TVS",                                                  group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:  200 },
  { code: "USG-USNTSCAN",      name: "US-NT Scan",                                              group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  210 },
  { code: "USG-TVS2",          name: "USG - TVS",                                               group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  220 },
  { code: "USG-ANTENATAL",     name: "USG ANTENATAL",                                           group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:  230 },
  { code: "USG-BREAST",        name: "ULTRASOUND BREAST",                                       group: "Ultrasound & Doppler",    price:  1200, rate:  1000, tat:  3, sort:  240 },
  { code: "USG-USARM",         name: "US Arm (Single)",                                         group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  250 },
  { code: "USG-USBOTHBREAS",   name: "us both breast",                                          group: "Ultrasound & Doppler",    price:  1200, rate:  1000, tat:  3, sort:  260 },
  { code: "USG-USBOTHBRE2",    name: "US Both Breasts",                                         group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  270 },
  { code: "USG-USBRAIN",       name: "US BRAIN",                                                group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  280 },
  { code: "USG-USBREAST",      name: "US BREAST",                                               group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  290 },
  { code: "USG-USHAND",        name: "US Hand (Single)",                                        group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  300 },
  { code: "USG-USKNEE",        name: "US Knee (Single)",                                        group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  310 },
  { code: "USG-USLEG",         name: "US Leg (Single)",                                         group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  320 },
  { code: "USG-USNECK",        name: "US Neck",                                                 group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  330 },
  { code: "USG-USNEWBORNHI",   name: "US Newborn Hip DDH",                                      group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  340 },
  { code: "USG-USORBITS",      name: "US Orbits (Single)",                                      group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  350 },
  { code: "USG-USPAROTID",     name: "US Parotid",                                              group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  360 },
  { code: "USG-USSCROTUM",     name: "US Scrotum",                                              group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  370 },
  { code: "USG-USSINGLEBRE",   name: "US Single Breast",                                        group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  380 },
  { code: "USG-USTHIGH",       name: "US Thigh (Single)",                                       group: "Ultrasound & Doppler",    price:  1800, rate:  1500, tat:  3, sort:  390 },
  { code: "USG-USTHYROID",     name: "US Thyroid",                                              group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  400 },
  { code: "USG-USWRIST",       name: "US Wrist (Single)",                                       group: "Ultrasound & Doppler",    price:  1920, rate:  1600, tat:  3, sort:  410 },
  { code: "USG-CHEST2",        name: "USG-CHEST",                                               group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  420 },
  { code: "USG-USFNAC",        name: "US FNAC",                                                 group: "Ultrasound & Doppler",    price:  3120, rate:  2600, tat:  3, sort:  430 },
  { code: "USG-ASPIRATION",    name: "USG - Aspiration",                                        group: "Ultrasound & Doppler",    price:  2880, rate:  2400, tat:  3, sort:  440 },
  { code: "USG-HYSTEROSALP",   name: "Hystero salpingo gram ( HSG )",                           group: "Ultrasound & Doppler",    price:  3600, rate:  3000, tat:  3, sort:  450 },
  { code: "USG-USCDRECORDI",   name: "US CD Recording",                                         group: "Ultrasound & Doppler",    price:   480, rate:   400, tat:  3, sort:  460 },
  { code: "USG-USTRS",         name: "US TRS",                                                  group: "Ultrasound & Doppler",    price:  2040, rate:  1700, tat:  3, sort:  470 },
  { code: "USG-USWA",          name: "US-WA",                                                   group: "Ultrasound & Doppler",    price:  1560, rate:  1300, tat:  3, sort:  480 },
  { code: "USG-OBSTERICS",     name: "USG-OBSTERICS",                                           group: "Ultrasound & Doppler",    price:  1440, rate:  1200, tat:  3, sort:  490 },
  { code: "DOP-CAROTIDDOPP",   name: "CAROTID DOPPLER",                                         group: "Ultrasound & Doppler",    price:  1200, rate:  1000, tat:  4, sort:  500 },
  { code: "DOP-COLORDOPPLE",   name: "COLOR DOPPLER",                                           group: "Ultrasound & Doppler",    price:  2520, rate:  2100, tat:  4, sort:  510 },
  { code: "DOP-FOETALECHO",    name: "Doppler - Foetal Echo",                                   group: "Ultrasound & Doppler",    price:  2280, rate:  1900, tat:  4, sort:  520 },
  { code: "DOP-CAROTIDANDV",   name: "Doppler Carotid And Vertebral",                           group: "Ultrasound & Doppler",    price:  2520, rate:  2100, tat:  4, sort:  530 },
  { code: "DOP-LOWERLIMBAR",   name: "Doppler Lower Limb Arteries Both",                        group: "Ultrasound & Doppler",    price:  4080, rate:  3400, tat:  4, sort:  540 },
  { code: "DOP-LOWERLIMB2",    name: "Doppler Lower Limb Arteries Single",                      group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  550 },
  { code: "DOP-LOWERLIMB3",    name: "Doppler Lower Limb Arterties + Veins Both",               group: "Ultrasound & Doppler",    price:  7440, rate:  6200, tat:  4, sort:  560 },
  { code: "DOP-LOWERLIMB4",    name: "Doppler Lower Limb Arterties + Veins Single",             group: "Ultrasound & Doppler",    price:  4080, rate:  3400, tat:  4, sort:  570 },
  { code: "DOP-LOWERLIMBVE",   name: "Doppler Lower Limb Veins Both",                           group: "Ultrasound & Doppler",    price:  4080, rate:  3400, tat:  4, sort:  580 },
  { code: "DOP-LOWERLIMB5",    name: "Doppler Lower Limb Veins Single",                         group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  590 },
  { code: "DOP-OBSTERIC",      name: "Doppler Obsteric",                                        group: "Ultrasound & Doppler",    price:  2520, rate:  2100, tat:  4, sort:  600 },
  { code: "DOP-PELVIS",        name: "Doppler Pelvis",                                          group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  610 },
  { code: "DOP-PENILE",        name: "Doppler Penile",                                          group: "Ultrasound & Doppler",    price:  3960, rate:  3300, tat:  4, sort:  620 },
  { code: "DOP-PORTALSYSTE",   name: "Doppler Portal System",                                   group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  630 },
  { code: "DOP-RENALARTERI",   name: "Doppler Renal Arteries",                                  group: "Ultrasound & Doppler",    price:  2520, rate:  2100, tat:  4, sort:  640 },
  { code: "DOP-RENALARTE2",    name: "Doppler Renal Arteries + Abdomen Pelvis",                 group: "Ultrasound & Doppler",    price:  5280, rate:  4400, tat:  4, sort:  650 },
  { code: "DOP-TESTISFORTO",   name: "Doppler Testis For Torsion",                              group: "Ultrasound & Doppler",    price:  3120, rate:  2600, tat:  4, sort:  660 },
  { code: "DOP-UPPERLIMBAR",   name: "Doppler Upper Limb Arteries + Veins Single",              group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  670 },
  { code: "DOP-UPPERLIMB2",    name: "Doppler Upper Limb Arteries Both",                        group: "Ultrasound & Doppler",    price:  4080, rate:  3400, tat:  4, sort:  680 },
  { code: "USG-UPPERLIMBAR",   name: "Doppler Upper Limb Arteries Single",                      group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  3, sort:  690 },
  { code: "DOP-UPPERLIMB3",    name: "Doppler Upper Limb Arterties + Veins Both",               group: "Ultrasound & Doppler",    price:  7440, rate:  6200, tat:  4, sort:  700 },
  { code: "DOP-UPPERLIMBVE",   name: "Doppler Upper Limb Veins Both",                           group: "Ultrasound & Doppler",    price:  4080, rate:  3400, tat:  4, sort:  710 },
  { code: "DOP-UPPERLIMB4",    name: "Doppler Upper Limb Veins Single",                         group: "Ultrasound & Doppler",    price:  2160, rate:  1800, tat:  4, sort:  720 },
  { code: "DOP-VARICOCELE",    name: "Doppler Varicocele",                                      group: "Ultrasound & Doppler",    price:  2640, rate:  2200, tat:  4, sort:  730 },
  { code: "XR-TNCMXRAYCHE",    name: "TNCM XRAY CHEST PA",                                      group: "X-ray",                   price:   480, rate:   400, tat:  3, sort:   10 },
  { code: "XR-CHEST2",         name: "X RAY CHEST",                                             group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:   20 },
  { code: "XR-CHEST3",         name: "X-RAY CHEST",                                             group: "X-ray",                   price:   240, rate:   200, tat:  3, sort:   30 },
  { code: "XR-CHESTAP",        name: "X-RAY Chest AP",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:   40 },
  { code: "XR-CHESTAPLAT",     name: "X-RAY CHEST AP LAT",                                      group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:   50 },
  { code: "XR-CHESTPA",        name: "X-RAY Chest PA",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:   60 },
  { code: "XR-CHEST4",         name: "XRAY CHEST",                                              group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:   70 },
  { code: "XR-BOTHMASTOID",    name: "X-RAY Both Mastoids LAT Oblique",                         group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:   80 },
  { code: "XR-MANDIBLEPA",     name: "X-RAY Mandible PA",                                       group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:   90 },
  { code: "XR-ORBITSAP",       name: "X-RAY Orbits AP",                                         group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  100 },
  { code: "XR-PNS2",           name: "X-RAY PNS",                                               group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  110 },
  { code: "XR-SKULLAPLAT",     name: "X-RAY Skull AP LAT",                                      group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  120 },
  { code: "XR-SKULLLAT",       name: "X-RAY Skull LAT",                                         group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  130 },
  { code: "XR-TMJOINTSBOT",    name: "X-RAY TM Joints Both LAT Oblique",                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  140 },
  { code: "XR-CERVICALSPI",    name: "X-RAY Cervical Spine AP",                                 group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  150 },
  { code: "XR-CERVICALS2",     name: "X-RAY CERVICAL SPINE AP LAT",                             group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  160 },
  { code: "XR-CERVICALS3",     name: "X-RAY Cervical Spine LAT",                                group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  170 },
  { code: "XR-NECKAP",         name: "X-RAY Neck AP",                                           group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  180 },
  { code: "XR-NECKAPLAT",      name: "X-RAY NECK AP LAT",                                       group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  190 },
  { code: "XR-NECKLAT",        name: "X-RAY Neck LAT",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  200 },
  { code: "XR-ARMAP",          name: "X-RAY ARM AP",                                            group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  210 },
  { code: "XR-ARMAPLAT",       name: "X-RAY ARM AP LAT",                                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  220 },
  { code: "XR-ARMLAT",         name: "X-RAY ARM LAT",                                           group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  230 },
  { code: "XR-BOTHARMAPLA",    name: "X-RAY BOTH ARM AP LAT",                                   group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  240 },
  { code: "XR-BOTHELBOWSA",    name: "X-RAY Both Elbows AP",                                    group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  250 },
  { code: "XR-BOTHSHOULDE",    name: "X-RAY BOTH SHOULDER",                                     group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  260 },
  { code: "XR-BOTHWRISTSA",    name: "X-RAY Both Wrists AP",                                    group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  270 },
  { code: "XR-CLAVICLESAP",    name: "X-RAY Clavicles AP",                                      group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  280 },
  { code: "XR-ELBOWAP",        name: "X-RAY ELBOW AP",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  290 },
  { code: "XR-ELBOWAPLAT",     name: "X-RAY Elbow AP LAT",                                      group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  300 },
  { code: "XR-FOREARMAP",      name: "X-RAY Forearm AP",                                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  310 },
  { code: "XR-FOREARMAPLA",    name: "X-RAY Forearm AP LAT",                                    group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  320 },
  { code: "XR-HANDAP",         name: "X-RAY Hand AP",                                           group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  330 },
  { code: "XR-HANDAPLAT",      name: "X-RAY Hand AP LAT",                                       group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  340 },
  { code: "XR-SHOULDERAP",     name: "X-RAY Shoulder AP",                                       group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  350 },
  { code: "XR-SHOULDERAPL",    name: "X-RAY SHOULDER AP LAT",                                   group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  360 },
  { code: "XR-THUMBAPLAT",     name: "X-RAY THUMB AP LAT",                                      group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  370 },
  { code: "XR-WRISTJOINTA",    name: "X-RAY Wrist Joint AP",                                    group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  380 },
  { code: "XR-COCCYXLAT",      name: "X-RAY Coccyx LAT",                                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  390 },
  { code: "XR-LUMBARSPINE",    name: "X-RAY Lumbar Spine AP",                                   group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  400 },
  { code: "XR-LUMBARSPI2",     name: "X-RAY LUMBAR SPINE AP LAT",                               group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  410 },
  { code: "XR-LUMBARSPI3",     name: "X-RAY LUMBAR SPINE AP/LAT",                               group: "X-ray",                   price:  1020, rate:   850, tat:  3, sort:  420 },
  { code: "XR-LUMBARSPI4",     name: "X-Ray Lumbar Spine LAT",                                  group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  430 },
  { code: "XR-SPINEAP",        name: "X-RAY Spine AP",                                          group: "X-ray",                   price:   600, rate:   500, tat:  3, sort:  440 },
  { code: "XR-SPINEAPLAT",     name: "X-RAY SPINE AP LAT",                                      group: "X-ray",                   price:   600, rate:   500, tat:  3, sort:  450 },
  { code: "XR-THORACICSPI",    name: "X-RAY Thoracic Spine AP",                                 group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  460 },
  { code: "XR-THORACOLUMB",    name: "X-RAY Thoraco Lumbar Spine AP",                           group: "X-ray",                   price:   480, rate:   400, tat:  3, sort:  470 },
  { code: "XR-THORACOLU2",     name: "X-RAY THORACO LUMBAR SPINE AP LAT",                       group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  480 },
  { code: "XR-THORACOLU3",     name: "X-RAY THORACO LUMBAR SPINE LAT",                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  490 },
  { code: "XR-ABDOMENPELV",    name: "X-RAY ABDOMEN PELVIS AP",                                 group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  500 },
  { code: "XR-ANKLEAP",        name: "X-RAY Ankle AP",                                          group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  510 },
  { code: "XR-ANKLEAPLAT",     name: "X-RAY Ankle AP LAT",                                      group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  520 },
  { code: "XR-BOTHKNEEAP",     name: "X-RAY Both Knee AP",                                      group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  530 },
  { code: "XR-BOTHKNEEAPL",    name: "X-RAY Both Knee AP LAT",                                  group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  540 },
  { code: "XR-BOTHKNEESAP",    name: "X-RAY BOTH KNEES AP/LATERAL",                             group: "X-ray",                   price:  1020, rate:   850, tat:  3, sort:  550 },
  { code: "XR-BOTHLEGAPLA",    name: "X-RAY BOTH LEG AP LAT",                                   group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  560 },
  { code: "XR-BOTHTHIGH",      name: "X-RAY BOTH THIGH",                                        group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  570 },
  { code: "XR-CALCANEUMLA",    name: "X-RAY Calcaneum LAT",                                     group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  580 },
  { code: "XR-FEMURAP",        name: "X-RAY Femur AP",                                          group: "X-ray",                   price:   360, rate:   300, tat:  3, sort:  590 },
  { code: "XR-FEMURAPLAT",     name: "X-RAY Femur AP LAT",                                      group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  600 },
  { code: "XR-FOOTAP",         name: "X-RAY FOOT AP",                                           group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  610 },
  { code: "XR-FOOTLAT",        name: "X-RAY FOOT LAT",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  620 },
  { code: "XR-HEELAPLAT",      name: "X-RAY HEEL AP LAT",                                       group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  630 },
  { code: "XR-HIPAP",          name: "X-RAY Hip AP",                                            group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  640 },
  { code: "XR-HIPAPLAT",       name: "X-RAY HIP AP LAT",                                        group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  650 },
  { code: "XR-HIPLAT",         name: "X-RAY Hip LAT",                                           group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  660 },
  { code: "XR-KNEEAP",         name: "X-RAY Knee AP",                                           group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  670 },
  { code: "XR-KNEEAPLAT",      name: "X-RAY Knee AP LAT",                                       group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  680 },
  { code: "XR-KNEELAT",        name: "X-RAY Knee LAT",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  690 },
  { code: "XR-KNEESKYLINE",    name: "X-RAY Knee Skyline Patella",                              group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  700 },
  { code: "XR-LEGAP",          name: "X-RAY Leg AP",                                            group: "X-ray",                   price:   660, rate:   550, tat:  3, sort:  710 },
  { code: "XR-LEGAPLATOBL",    name: "X-RAY LEG AP LAT OBLIQUE",                                group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  720 },
  { code: "XR-PELVISAP",       name: "X-RAY Pelvis AP",                                         group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  730 },
  { code: "XR-PELVISLAT",      name: "X-RAY PELVIS LAT",                                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  740 },
  { code: "XR-THIGHAP",        name: "X-RAY THIGH AP",                                          group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  750 },
  { code: "XR-THIGHAPLAT",     name: "X-RAY Thigh AP LAT",                                      group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  760 },
  { code: "XR-ABDOMENAPLA",    name: "X-RAY ABDOMEN AP LAT",                                    group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  770 },
  { code: "XR-KUB2",           name: "X-RAY KUB",                                               group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  780 },
  { code: "XR-BARIUMENEMA",    name: "X-RAY Barium Enema",                                      group: "X-ray",                   price:  1860, rate:  1550, tat:  3, sort:  790 },
  { code: "XR-BARIUMMEALU",    name: "X-RAY Barium Meal Upper GI",                              group: "X-ray",                   price:  1620, rate:  1350, tat:  3, sort:  800 },
  { code: "XR-BARIUMSWALL",    name: "X-RAY Barium Swallow",                                    group: "X-ray",                   price:  1860, rate:  1550, tat:  3, sort:  810 },
  { code: "XR-FISTULOGRAP",    name: "X-RAY Fistulography",                                     group: "X-ray",                   price:  1860, rate:  1550, tat:  3, sort:  820 },
  { code: "XR-HSG2",           name: "X-RAY H.S.G",                                             group: "X-ray",                   price:  2400, rate:  2000, tat:  3, sort:  830 },
  { code: "XR-INTRAVENOUS",    name: "X-RAY Intravenous Pyelogram (IVP)",                       group: "X-ray",                   price:  2940, rate:  2450, tat:  3, sort:  840 },
  { code: "XR-MICTCYSTOUR",    name: "X-RAY Mict. Cystourethrogram (MCU)",                      group: "X-ray",                   price:  3540, rate:  2950, tat:  3, sort:  850 },
  { code: "XR-RETROGRADEU",    name: "X-RAY Retrograde Urethrogram",                            group: "X-ray",                   price:  1980, rate:  1650, tat:  3, sort:  860 },
  { code: "XR-SIALOGRAM",      name: "X-RAY Sialogram",                                         group: "X-ray",                   price:  1860, rate:  1550, tat:  3, sort:  870 },
  { code: "XR-BONEDENSITY",    name: "Bone density test",                                       group: "X-ray",                   price:  1020, rate:   850, tat:  3, sort:  880 },
  { code: "XR-DIGITALXRAY",    name: "Digital Xray Mammogram",                                  group: "X-ray",                   price:  3948, rate:  3290, tat:  3, sort:  890 },
  { code: "XR-BOTHFEETAPL",    name: "X-RAY BOTH FEET AP LAT",                                  group: "X-ray",                   price:   900, rate:   750, tat:  3, sort:  900 },
  { code: "XR-EXTRAFILM",      name: "X-RAY Extra Film",                                        group: "X-ray",                   price:   780, rate:   650, tat:  3, sort:  910 },
  { code: "XR-MAXILLAPA",      name: "X-RAY MAXILLA PA",                                        group: "X-ray",                   price:   540, rate:   450, tat:  3, sort:  920 },
  { code: "XR-SINOGRAM",       name: "X-RAY Sinogram",                                          group: "X-ray",                   price:  1980, rate:  1650, tat:  3, sort:  930 },
  { code: "XR-ECG",            name: "Xray / ECG",                                              group: "X-ray",                   price:   600, rate:   500, tat:  3, sort:  940 },
];

/*
 * Studies the card has no line for at all, kept on at the price the clinic
 * already charged.
 *
 * Adopting the card is a pricing decision, not a decision to stop doing
 * things. The card is a radiology network's menu and simply does not carry
 * these: it has no orthopantomogram and no intra-oral dental film, which at
 * a clinic with a dentist is not a gap anyone would choose; no sternum,
 * scapula or rib views; no transrectal prostate scan; and nothing for a
 * scan of a lump somebody walked in with. Switching them off would have
 * taken a service off the board rather than repriced it.
 */
const KEPT = [
  // Renumbered into the card's ordering rather than left on the old list's
  // numbers: two orderings interleaved is no ordering at all, and the chest
  // stops opening the list.
  { code: 'XR-RIBS',   sort:  72 },   // Ribs — with the chest
  { code: 'XR-STERN',  sort:  74 },   // Sternum
  { code: 'XR-OPG',    sort: 140 },   // Orthopantomogram — with the skull
  { code: 'XR-DENT',   sort: 142 },   // Dental X-ray (IOPA)
  { code: 'XR-SCAP',   sort: 282 },   // Scapula — with the clavicle
  { code: 'USG-SOFT',  sort: 432 },   // Soft tissue — with the small parts
  { code: 'USG-LOCAL', sort: 434 },   // Local part / swelling
  { code: 'USG-TRUS',  sort: 192 },   // Transrectal prostate — with the pelvis
];
const KEPT_CODES = KEPT.map((k) => k.code);

/*
 * Everything else the old list carried, switched off when the card is
 * adopted. Listed explicitly rather than selected by bill group, so adopting
 * the card can never switch off a study the card itself just added.
 */
const RETIRED = [
  "USG-ABD", "USG-ABDW", "USG-ANOM", "USG-BRE",
  "USG-CHEST", "USG-DOP", "USG-DOPART", "USG-DOPCAR",
  "USG-DOPO", "USG-DOPREN", "USG-DOPSCR", "USG-DOPVEN",
  "USG-FOLLI", "USG-GROWTH", "USG-GUIDE", "USG-INFHIP",
  "USG-KUB", "USG-MSK", "USG-NEO", "USG-NT",
  "USG-OBS", "USG-PELVF", "USG-SCR", "USG-THY",
  "USG-TVS", "USG-UAP", "XR-ABD", "XR-ABD-BOTH",
  "XR-ABD-SUP", "XR-ANKLE", "XR-BAENEMA", "XR-BAMEAL",
  "XR-BAMFT", "XR-BASWA", "XR-CALC", "XR-CHEST",
  "XR-CHEST-AP", "XR-CHEST-BOTH", "XR-CHEST-LAT", "XR-CLAV",
  "XR-CSPINE", "XR-CSPINE-FLEX", "XR-CSPINE-OBL", "XR-DSPINE",
  "XR-ELBOW", "XR-FEMUR", "XR-FISTULO", "XR-FOOT",
  "XR-FOREARM", "XR-HAND", "XR-HIP", "XR-HIPS",
  "XR-HSG", "XR-HUM", "XR-IVP", "XR-KNEE",
  "XR-KUB", "XR-LEG", "XR-LIMB", "XR-LSPINE-FLEX",
  "XR-MAND", "XR-MASTOID", "XR-MCU", "XR-NASAL",
  "XR-NECK", "XR-ORBIT", "XR-PATELLA", "XR-PELV",
  "XR-PNS", "XR-RGU", "XR-SACRUM", "XR-SCOLI",
  "XR-SHOUL", "XR-SIALO", "XR-SKULL", "XR-SPINE",
  "XR-TMJ", "XR-WRIST",
];

/*
 * Six health packages list an imaging study among their contents. Those
 * entries are pointed at the card's equivalent before the old study is
 * switched off — a package whose contents resolve to nothing is a package
 * the lab cannot work from.
 */
const PACKAGE_REMAP = {
  'USG-ABD': 'USG-USABDOMENPE',   // Abdomen & Pelvis  -> US Abdomen Pelvis
  'USG-BRE': 'USG-BREAST',        // Breast            -> Ultrasound breast
  'USG-PELVF': 'USG-USPELVIS',    // Pelvis (female)   -> US Pelvis
  'XR-CHEST': 'XR-CHESTPA',       // Chest PA          -> X-RAY Chest PA
};

/*
 * Adopting the card is a one-time event, and the marker is what makes it
 * one. Without it the retirement would run on every boot: a clinic that
 * switched dental X-ray back on because it still does them would find it
 * dark again the next morning, with nothing to say why. Everywhere else in
 * this system the clinic's own decision outranks the seed data, and
 * switching a study on is a decision.
 */
const ADOPTED = 'imaging.manitham_2026_11';

/**
 * Adopt the card. Idempotent in both directions: a study already on the
 * catalogue keeps the price the clinic gave it, and the retirement happens
 * once and is then the clinic's to undo.
 */
function load(db) {
  const exists = db.prepare('SELECT 1 FROM lab_tests WHERE code = ?');
  const insert = db.prepare(
    `INSERT INTO lab_tests (code, name, category, bill_group, price, tat_hours, sort_order, active)
     VALUES (?, ?, 'radiology', ?, ?, ?, ?, 1)`
  );
  const remap = db.prepare(
    'UPDATE lab_package_items SET test_code = ? WHERE test_code = ?');
  const retire = db.prepare(
    'UPDATE lab_tests SET active = 0 WHERE code = ? AND active = 1');
  const reorder = db.prepare('UPDATE lab_tests SET sort_order = ? WHERE code = ?');

  const seen = db.prepare('SELECT value FROM settings WHERE key = ?').get(ADOPTED);
  const mark = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  let added = 0;
  let switchedOff = 0;
  let remapped = 0;
  db.transaction(() => {
    for (const t of IMAGING) {
      if (exists.get(t.code)) continue;
      insert.run(t.code, t.name, t.group, t.price, t.tat, t.sort);
      added += 1;
    }
    /*
     * The repointing and the retirement only on the boot that adopts the
     * card. Both are decisions about what the clinic offers, and a decision
     * re-applied every morning is not a decision.
     */
    if (!seen) {
      // Only once the replacements exist can a package be pointed at them.
      for (const [from, to] of Object.entries(PACKAGE_REMAP)) {
        if (exists.get(to)) remapped += remap.run(to, from).changes;
      }
      for (const code of RETIRED) switchedOff += retire.run(code).changes;
      // The studies the card has no line for move into its ordering.
      for (const k of KEPT) reorder.run(k.sort, k.code);
      mark.run(ADOPTED, new Date().toISOString());
    }
  })();
  return { added, switchedOff, remapped, adopted: !seen, total: IMAGING.length };
}

module.exports = { IMAGING, RETIRED, KEPT, KEPT_CODES, PACKAGE_REMAP, ADOPTED, load };
