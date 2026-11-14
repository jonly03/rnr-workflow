# Layer 2 MVP — test report
Run: `node tests/run-tests.mjs` from `vin-api/` (Node 18+, no dependencies).
Date: 2026-11-14. NHTSA vPIC live. Branch: mvp/layer-2-vin-anything.

PASS  decodeVin 3TMAZ5CN6GM000123 displacement 3.5L
PASS  NHTSA decode 3TMAZ5CN6GM000123 -> 2016 TOYOTA Tacoma 3.5L
PASS  catalog match for 2016 Tacoma
PASS  decodeVin 3CZRZ1H58PM000123 displacement 2L
PASS  NHTSA decode 3CZRZ1H58PM000123 -> 2023 HONDA HR-V 2L
PASS  catalog match for 2023 HR-V
PASS  decodeVin 5TDZK3DC0DS000123 displacement 3.5L
PASS  NHTSA decode 5TDZK3DC0DS000123 -> 2013 TOYOTA Sienna 3.5L
PASS  catalog match for 2013 Sienna
PASS  decodeVin 4T1B11HK4JU000123 displacement 2.5L
PASS  NHTSA decode 4T1B11HK4JU000123 -> 2018 TOYOTA Camry 2.5L
PASS  catalog match for 2018 Camry
PASS  CLA35 test VIN decodes (2020 Mercedes-Benz CLA-Class, AMG CLA35)
PASS  CLA35 not in catalog -> categories null, catalog_note present
PASS  Tacoma windshield FW04108 GTY, needs_confirmation, 3 questions
PASS  Tacoma battery variant_ambiguous (24F or 35, never 34R)
PASS  Tacoma front pads variant_ambiguous, three OEM numbers
PASS  Tacoma front rotors 43512-04052 exact
PASS  Tacoma oil 0W-20, 6.2 qt
PASS  Sienna windshield FW03760 GBY exact
PASS  Sienna battery Group 35 exact
PASS  Camry oil is 0W-16, not 0W-20
PASS  Camry windshield licensed_required, part_number null
PASS  HR-V windshield FW05907 GTY, needs_confirmation
PASS  HR-V cabin filter 80292-TF0-G01 exact
PASS  price_range and availability are null everywhere in the catalog
PASS  no empty part_number strings in the catalog
PASS  config pricing defaults: 0.15 / 0.85 / 1.25 / +0.10
PASS  tierFor: all categories -> full_vehicle $1.25
PASS  tierFor: glass only -> decode_glass $0.85
PASS  tierFor: engine only -> decode $0.15
PASS  tierFor: full vehicle + location -> $1.35
PASS  lookup.js has no hardcoded price literals (0.15/0.85/1.25/0.10)
PASS  short VIN rejected (400 invalid_vin)
PASS  VIN with I rejected (400 invalid_vin)
PASS  parseTireSizes finds P245/75R16 and 245/35 ZR19
PASS  parsePressures FRONT/REAR PSI
PASS  parsePressures converts kPa (240 kPa -> 35 PSI)
PASS  parseWeights GVWR 4,850 LB
PASS  parseBuildDate MFD 11/19
PASS  extractVinCandidate normalizes O->0, I->1
PASS  parseDoorJambText full label
PASS  door-jamb tire size confirms Tacoma tires (was variant_ambiguous)
PASS  door-jamb section carries pressures, GVWR, build date

44 passed, 0 failed
