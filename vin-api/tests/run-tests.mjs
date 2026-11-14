// Layer 2 MVP test suite — run with: node tests/run-tests.mjs
// From the vin-api/ directory. No dependencies (Node 18+ for global fetch).
// Covers the Conditions of Done: NHTSA decode live, 4 demo vehicles pass,
// test VIN WDD5J5BB2LN065797 (2020 CLA35 AMG) decodes correctly, no
// unverified field filled, price/availability null until a supplier feed
// exists, pricing parameterized in config.json (not hardcoded in lookup.js).
//
// Exit code 0 = all pass, 1 = any fail. Prints one line per test.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  lookupVin,
  decodeVin,
  validateVin,
  matchCatalog,
  tierFor,
  LookupError,
} from '../lookup.js';
import {
  parseDoorJambText,
  extractVinCandidate,
  parseTireSizes,
  parsePressures,
  parseWeights,
  parseBuildDate,
} from '../door-jamb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(here, '..', 'catalog.json'), 'utf8'));
const config = JSON.parse(readFileSync(path.join(here, '..', 'config.json'), 'utf8'));
const lookupSrc = readFileSync(path.join(here, '..', 'lookup.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Live NHTSA decode: the 4 demo vehicles + the CLA35 test VIN --------
const DEMO_VINS = [
  { vin: '3TMAZ5CN6GM000123', year: 2016, make: 'TOYOTA', model: 'Tacoma', disp: 3.5 },
  { vin: '3CZRZ1H58PM000123', year: 2023, make: 'HONDA', model: 'HR-V', disp: 2.0 },
  { vin: '5TDZK3DC0DS000123', year: 2013, make: 'TOYOTA', model: 'Sienna', disp: 3.5 },
  { vin: '4T1B11HK4JU000123', year: 2018, make: 'TOYOTA', model: 'Camry', disp: 2.5 },
];

for (const d of DEMO_VINS) {
  try {
    const decoded = await decodeVin(d.vin, config.nhtsa.endpoint);
    check(
      `decodeVin ${d.vin} displacement ${d.disp}L`,
      decoded.engine_displacement_l === d.disp,
      `got ${decoded.engine_displacement_l}`
    );
    const r = await lookupVin(d.vin, { catalog, config });
    check(
      `NHTSA decode ${d.vin} -> ${d.year} ${d.make} ${d.model} ${d.disp}L`,
      r.vehicle.year === d.year &&
        r.vehicle.make.toUpperCase() === d.make.toUpperCase() &&
        r.vehicle.model.toUpperCase() === d.model.toUpperCase() &&
        r.categories !== null,
      JSON.stringify(r.vehicle)
    );
    check(
      `catalog match for ${d.year} ${d.model}`,
      matchCatalog(
        { ...r.vehicle, engine_displacement_l: d.disp },
        catalog
      ) !== null
    );
  } catch (e) {
    check(`NHTSA decode ${d.vin}`, false, e.message);
  }
}

// CLA35 test VIN: must decode correctly; not in catalog -> null categories.
try {
  const r = await lookupVin('WDD5J5BB2LN065797', { catalog, config });
  check(
    'CLA35 test VIN decodes (2020 Mercedes-Benz CLA-Class, AMG CLA35)',
    r.vehicle.year === 2020 &&
      r.vehicle.make.toUpperCase().includes('MERCEDES') &&
      r.vehicle.model.toUpperCase().includes('CLA') &&
      (r.vehicle.trim || '').includes('CLA35'),
    JSON.stringify(r.vehicle)
  );
  check(
    'CLA35 not in catalog -> categories null, catalog_note present',
    r.categories === null && typeof r.catalog_note === 'string' && r.catalog_note.length > 0,
    JSON.stringify(r.categories)
  );
} catch (e) {
  check('CLA35 test VIN decodes', false, e.message);
}

// --- Variant rules + verified part numbers --------------------------------
const tacoma = await lookupVin('3TMAZ5CN6GM000123', { catalog, config });
check(
  'Tacoma windshield FW04108 GTY, needs_confirmation, 3 questions',
  tacoma.categories.exterior.glass.windshield.part_number === 'FW04108 GTY' &&
    tacoma.categories.exterior.glass.windshield.variant_status === 'needs_confirmation' &&
    (tacoma.categories.exterior.glass.windshield.variant_questions || []).length >= 3
);
check(
  'Tacoma battery variant_ambiguous (24F or 35, never 34R)',
  tacoma.categories.engine.battery.variant_status === 'variant_ambiguous' &&
    !JSON.stringify(tacoma.categories.engine.battery).includes('34R')
);
check(
  'Tacoma front pads variant_ambiguous, three OEM numbers',
  tacoma.categories.mechanical.brakes.front_pads.variant_status === 'variant_ambiguous' &&
    tacoma.categories.mechanical.brakes.front_pads.part_number.includes('04465-04070')
);
check(
  'Tacoma front rotors 43512-04052 exact',
  tacoma.categories.mechanical.brakes.front_rotors.part_number === '43512-04052'
);
check(
  'Tacoma oil 0W-20, 6.2 qt',
  tacoma.categories.engine.oil.viscosity === '0W-20' && tacoma.categories.engine.oil.capacity_qt === 6.2
);

const sienna = await lookupVin('5TDZK3DC0DS000123', { catalog, config });
check(
  'Sienna windshield FW03760 GBY exact',
  sienna.categories.exterior.glass.windshield.part_number === 'FW03760 GBY' &&
    sienna.categories.exterior.glass.windshield.variant_status === 'exact'
);
check(
  'Sienna battery Group 35 exact',
  sienna.categories.engine.battery.group === '35' && sienna.categories.engine.battery.variant_status === 'exact'
);

const camry = await lookupVin('4T1B11HK4JU000123', { catalog, config });
check(
  'Camry oil is 0W-16, not 0W-20',
  camry.categories.engine.oil.viscosity === '0W-16' && camry.categories.engine.oil.capacity_qt === 4.8
);
check(
  'Camry windshield licensed_required, part_number null',
  camry.categories.exterior.glass.windshield.variant_status === 'licensed_required' &&
    camry.categories.exterior.glass.windshield.part_number === null
);

const hrv = await lookupVin('3CZRZ1H58PM000123', { catalog, config });
check(
  'HR-V windshield FW05907 GTY, needs_confirmation',
  hrv.categories.exterior.glass.windshield.part_number === 'FW05907 GTY' &&
    hrv.categories.exterior.glass.windshield.variant_status === 'needs_confirmation'
);
check(
  'HR-V cabin filter 80292-TF0-G01 exact',
  hrv.categories.interior.cabin_filter.part_number === '80292-TF0-G01'
);

// --- No unverified fields: prices/availability null everywhere -------------
let priceLeak = null;
function walk(node, pathStr) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'price_range' || k === 'availability') && v !== null) priceLeak = `${pathStr}.${k}=${v}`;
    if (k === 'part_number' && v !== null && (typeof v !== 'string' || !v.trim())) priceLeak = `${pathStr}.${k}=${JSON.stringify(v)}`;
    walk(v, `${pathStr}.${k}`);
  }
}
catalog.vehicles.forEach((v, i) => walk(v.categories, `vehicles[${i}]`));
check('price_range and availability are null everywhere in the catalog', priceLeak === null, priceLeak || '');
check(
  'no empty part_number strings in the catalog',
  !JSON.stringify(catalog).includes('"part_number":""') && !JSON.stringify(catalog).includes('"part_number": ""')
);

// --- Pricing is parameterized in config, not hardcoded ----------------------
check(
  'config pricing defaults: 0.15 / 0.85 / 1.25 / +0.10',
  config.pricing.decode === 0.15 &&
    config.pricing.decode_glass === 0.85 &&
    config.pricing.full_vehicle === 1.25 &&
    config.pricing.location_addon === 0.1
);
check(
  'tierFor: all categories -> full_vehicle $1.25',
  eq(tierFor(['exterior', 'interior', 'engine', 'mechanical'], config), { tier: 'full_vehicle', price: 1.25, currency: 'USD' })
);
check(
  "tierFor: glass only -> decode_glass $0.85",
  tierFor(['glass'], config).tier === 'decode_glass' && tierFor(['glass'], config).price === 0.85
);
check(
  "tierFor: engine only -> decode $0.15",
  tierFor(['engine'], config).tier === 'decode' && tierFor(['engine'], config).price === 0.15
);
check(
  'tierFor: full vehicle + location -> $1.35',
  tierFor(['exterior', 'interior', 'engine', 'mechanical', 'location'], config).price === 1.35
);
check(
  'lookup.js has no hardcoded price literals (0.15/0.85/1.25/0.10)',
  !lookupSrc.includes('0.15') && !lookupSrc.includes('0.85') && !lookupSrc.includes('1.25') && !lookupSrc.includes('0.10') && !lookupSrc.includes('0.1'),
  'price literals found in lookup.js'
);

// --- Invalid VINs ------------------------------------------------------------
try {
  validateVin('123');
  check('short VIN rejected (400 invalid_vin)', false);
} catch (e) {
  check('short VIN rejected (400 invalid_vin)', e instanceof LookupError && e.code === 'invalid_vin');
}
try {
  validateVin('1HGCM82633A00435I');
  check('VIN with I rejected (400 invalid_vin)', false);
} catch (e) {
  check('VIN with I rejected (400 invalid_vin)', e instanceof LookupError && e.code === 'invalid_vin');
}

// --- Door-jamb parsers (unit tests, no OCR needed) ---------------------------
check(
  'parseTireSizes finds P245/75R16 and 245/35 ZR19',
  eq(parseTireSizes('TIRE P245/75R16 245/35 ZR19'), ['245/75R16', '245/35R19'])
);
check(
  'parsePressures FRONT/REAR PSI',
  eq(parsePressures('FRONT 35 PSI REAR 33 PSI'), { front: 35, rear: 33 })
);
check(
  'parsePressures converts kPa (240 kPa -> 35 PSI)',
  eq(parsePressures('240 kPa 230 kPa'), { front: 35, rear: 33 })
);
check('parseWeights GVWR 4,850 LB', parseWeights('GVWR 4,850 LB').gvwr_lbs === 4850);
check('parseBuildDate MFD 11/19', parseBuildDate('MFD BY ... 11/19') === '11/19');
check(
  'extractVinCandidate normalizes O->0, I->1',
  extractVinCandidate('vin: 1HGCM82633AOO4352') === '1HGCM82633A004352'
);
const label = `MFD BY MERCEDES-BENZ 11/19
VIN WDD5J5BB2LN065797
TIRE 245/35 ZR19 FRONT 35 PSI REAR 33 PSI
GVWR 4,850 LB GAWR FRONT 2,500 LB GAWR REAR 2,600 LB`;
const dj = parseDoorJambText(label);
check(
  'parseDoorJambText full label',
  dj.vin === 'WDD5J5BB2LN065797' &&
    dj.tires.front === '245/35R19' &&
    dj.pressures_psi.front === 35 &&
    dj.pressures_psi.rear === 33 &&
    dj.gvwr_lbs === 4850 &&
    dj.build_date === '11/19',
  JSON.stringify(dj)
);

// Door-jamb application: confirmed tire size settles the Tacoma variant.
const withDj = await lookupVin('3TMAZ5CN6GM000123', {
  catalog,
  config,
  doorJamb: {
    vin: null,
    tires: { front: '265/70R16', rear: '265/70R16' },
    pressures_psi: { front: 32, rear: 32 },
    gvwr_lbs: 5600,
    build_date: '05/16',
    source: 'door-jamb label photo',
  },
});
check(
  'door-jamb tire size confirms Tacoma tires (was variant_ambiguous)',
  withDj.categories.exterior.tires.variant_status === 'confirmed' &&
    withDj.categories.exterior.tires.size === '265/70R16' &&
    withDj.categories.exterior.tires.source === 'door-jamb label photo'
);
check(
  'door-jamb section carries pressures, GVWR, build date',
  withDj.door_jamb.tire_pressure_psi_front === 32 &&
    withDj.door_jamb.gvwr_lbs === 5600 &&
    withDj.door_jamb.build_date === '05/16'
);

console.log(`\n${pass} passed, ${fail} failed${failures.length ? ` — failed: ${failures.join('; ')}` : ''}`);
process.exit(fail ? 1 : 0);
