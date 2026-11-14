// R&R VIN API — Layer 4 MVP black-box test.
// Run the server first:  node vin-api/server.js
// Then:                 node vin-api/test/test-api.mjs   (or: npm --prefix vin-api test)
// Exits non-zero if any check fails. Uses live NHTSA decode.
// NOTE: successful lookups consume demo-key credits (8 on rr-demo per run).
// Restarting the server resets the in-memory quotas.

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';

const VINS = {
  tacoma: '3TMAZ5CN3GM000001', // 2016 Toyota Tacoma SR5, 3.5L V6 — catalog hit
  hrv: '3CZRZ1H55PM000001', // 2023 Honda HR-V Sport, 2.0L — catalog hit
  sienna: '5TDZK3DC8DS000001', // 2013 Toyota Sienna, 3.5L V6 — catalog hit
  camry: '4T1B11HK1JU000001', // 2018 Toyota Camry, 2.5L — catalog hit
  accord: '1HGCM82633A004352', // 2003 Honda Accord EX-V6 (NHTSA example) — decode only
};

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function call(method, path, { key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch { /* non-JSON */ }
  return { status: r.status, json, headers: r.headers };
}

// Independent check-digit implementation (ISO 3779) — verifies the
// server's validation against a second implementation, not itself.
const MAP = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
function checkDigit(vin) {
  let s = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    s += (/[0-9]/.test(ch) ? Number(ch) : MAP[ch]) * W[i];
  }
  const r = s % 11;
  return r === 10 ? 'X' : String(r);
}
function withCheckDigit(vin) {
  const base = vin.slice(0, 8) + '0' + vin.slice(9);
  return vin.slice(0, 8) + checkDigit(base) + vin.slice(9);
}

async function main() {
  console.log(`Testing ${BASE}\n`);

  // --- 0. Server up? -------------------------------------------------------
  let health;
  try {
    health = await call('GET', '/v1/health');
  } catch (e) {
    console.log('  FAIL  server not reachable — start it first: node vin-api/server.js');
    process.exit(1);
  }

  console.log('health + root');
  check('health 200, status ok', health.status === 200 && health.json.status === 'ok', JSON.stringify(health.json));
  check('health reports 4 catalog vehicles', health.json.catalog_vehicles === 4, JSON.stringify(health.json));
  check('health reports NHTSA reachable', health.json.vpic === 'ok', JSON.stringify(health.json));
  const root = await call('GET', '/');
  check('root 200, service pointer', root.status === 200 && /VIN API/.test(root.json.service || ''), JSON.stringify(root.json));

  console.log('auth');
  const noKey = await call('POST', '/v1/lookup', { body: { vin: VINS.accord } });
  check('no key → 401 unauthorized', noKey.status === 401 && noKey.json.error?.code === 'unauthorized', JSON.stringify(noKey.json));
  const badKey = await call('POST', '/v1/lookup', { key: 'nope', body: { vin: VINS.accord } });
  check('bad key → 401 unauthorized', badKey.status === 401 && badKey.json.error?.code === 'unauthorized', JSON.stringify(badKey.json));

  console.log('check digit (independent implementation)');
  check('Accord example VIN check digit is 3', checkDigit(VINS.accord) === '3');
  check('Tacoma test VIN check digit is 3', checkDigit(VINS.tacoma) === '3');
  check('HR-V test VIN check digit is 5', checkDigit(VINS.hrv) === '5');
  check('Sienna test VIN check digit is 8', checkDigit(VINS.sienna) === '8');
  check('Camry test VIN check digit is 1', checkDigit(VINS.camry) === '1');

  console.log('lookup — decode only (Accord, not in catalog)');
  const accord = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.accord } });
  check('Accord → 200', accord.status === 200, JSON.stringify(accord.json));
  check('Accord decodes 2003 Honda Accord EX-V6', accord.json.vehicle?.year === 2003 && accord.json.vehicle?.make === 'HONDA' && accord.json.vehicle?.model === 'Accord', JSON.stringify(accord.json.vehicle));
  check('Accord has catalog_note, categories null', accord.json.catalog_note && accord.json.categories === null, JSON.stringify(accord.json));
  check('Accord tier decode $0.15, 1 credit', accord.json.pricing_tier === 'decode' && accord.json.price_usd === 0.15 && accord.json.credits_used === 1, JSON.stringify(accord.json));
  const remainingAfterAccord = accord.json.credits_remaining;

  console.log('lookup — failures charge nothing');
  const short = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: 'SHORT' } });
  check('short VIN → 400 invalid_vin', short.status === 400 && short.json.error?.code === 'invalid_vin', JSON.stringify(short.json));
  const badCheck = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: '1HGCM82633A004353' } });
  check('bad check digit → 400 invalid_vin', badCheck.status === 400 && badCheck.json.error?.code === 'invalid_vin', JSON.stringify(badCheck.json));
  const bogusVin = withCheckDigit('ZZZZZZZZ0ZZZZZZZZ');
  const notFound = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: bogusVin } });
  check('valid-check-digit bogus VIN → 404 vin_not_found', notFound.status === 404 && notFound.json.error?.code === 'vin_not_found', JSON.stringify(notFound.json));
  const ambiguous = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.hrv, needs: ['mechanical'] } });
  check('HR-V mechanical (no data, no questions) → 422 variant_ambiguous', ambiguous.status === 422 && ambiguous.json.error?.code === 'variant_ambiguous', JSON.stringify(ambiguous.json));
  const tacoma = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.tacoma } });
  check('only successes charge: remaining fell by exactly 1', tacoma.json.credits_remaining === remainingAfterAccord - 1, `before ${remainingAfterAccord}, after ${tacoma.json.credits_remaining}`);

  console.log('lookup — catalog hits');
  check('Tacoma → 200', tacoma.status === 200, JSON.stringify(tacoma.json));
  check('Tacoma windshield FW04108 GTY', tacoma.json.categories?.exterior?.glass?.windshield?.part_number === 'FW04108 GTY', JSON.stringify(tacoma.json.categories?.exterior?.glass));
  check('Tacoma oil 0W-20, 6.2 qt', tacoma.json.categories?.engine?.oil?.viscosity === '0W-20' && tacoma.json.categories?.engine?.oil?.capacity_qt === 6.2, JSON.stringify(tacoma.json.categories?.engine?.oil));
  check('Tacoma battery variant_ambiguous (24F or 35, not 34R)', tacoma.json.categories?.engine?.battery?.variant_status === 'variant_ambiguous' && !JSON.stringify(tacoma.json.categories?.engine?.battery).includes('34R'), JSON.stringify(tacoma.json.categories?.engine?.battery));
  check('Tacoma tier full_vehicle $1.25', tacoma.json.pricing_tier === 'full_vehicle' && tacoma.json.price_usd === 1.25, JSON.stringify(tacoma.json));

  const hrvGlass = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.hrv, needs: ['glass'] } });
  check('HR-V glass-only → 200, only exterior.glass', hrvGlass.status === 200 && hrvGlass.json.categories?.exterior?.glass && !hrvGlass.json.categories?.engine, JSON.stringify(hrvGlass.json.categories));
  check('HR-V windshield FW05907 GTY', hrvGlass.json.categories?.exterior?.glass?.windshield?.part_number === 'FW05907 GTY', JSON.stringify(hrvGlass.json.categories?.exterior?.glass));
  check('HR-V glass tier decode_glass $0.85', hrvGlass.json.pricing_tier === 'decode_glass' && hrvGlass.json.price_usd === 0.85, JSON.stringify(hrvGlass.json));

  const siennaLoc = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.sienna, location: { lat: 42.36, lng: -71.06 } } });
  check('Sienna + location → 200 with distance + drive estimate', siennaLoc.status === 200 && typeof siennaLoc.json.shop?.distance_miles === 'number' && typeof siennaLoc.json.shop?.drive_minutes === 'number', JSON.stringify(siennaLoc.json.shop));
  check('Sienna location price $1.35 (full + location)', siennaLoc.json.price_usd === 1.35 && siennaLoc.json.pricing_tier === 'full_vehicle+location', JSON.stringify(siennaLoc.json));

  const camry = await call('POST', '/v1/lookup', { key: 'rr-demo', body: { vin: VINS.camry } });
  check('Camry oil is 0W-16 (not 0W-20)', camry.json.categories?.engine?.oil?.viscosity === '0W-16', JSON.stringify(camry.json.categories?.engine?.oil));
  check('Camry windshield licensed_required, part null', camry.json.categories?.exterior?.glass?.windshield?.variant_status === 'licensed_required' && camry.json.categories?.exterior?.glass?.windshield?.part_number === null, JSON.stringify(camry.json.categories?.exterior?.glass));

  console.log('GET lookup form');
  const getLookup = await call('GET', `/v1/lookup/${VINS.tacoma}?needs=exterior`, { key: 'rr-demo' });
  check('GET lookup → 200, only exterior', getLookup.status === 200 && getLookup.json.categories?.exterior && !getLookup.json.categories?.engine, JSON.stringify(getLookup.json.categories));

  console.log('batch');
  const batch = await call('POST', '/v1/lookup/batch', { key: 'rr-demo', body: { vins: [VINS.tacoma, 'BAD', VINS.sienna] } });
  check('batch → 200, 3 results', batch.status === 200 && batch.json.results?.length === 3, JSON.stringify(batch.json));
  check('batch charges 2 (bad VIN free)', batch.json.credits_used === 2, JSON.stringify(batch.json));
  check('batch price total $2.50', batch.json.price_usd_total === 2.5, JSON.stringify(batch.json));
  check('batch bad item carries invalid_vin error', batch.json.results?.[1]?.error?.code === 'invalid_vin', JSON.stringify(batch.json.results?.[1]));
  const batchBig = await call('POST', '/v1/lookup/batch', { key: 'rr-demo', body: { vins: Array(101).fill(VINS.accord) } });
  check('batch of 101 → 400 invalid_request', batchBig.status === 400 && batchBig.json.error?.code === 'invalid_request', JSON.stringify(batchBig.json));

  console.log('glass endpoint');
  const glass = await call('GET', '/v1/glass/FW03760%20GBY', { key: 'rr-demo' });
  check('glass FW03760 GBY → 200, Sienna windshield', glass.status === 200 && glass.json.position === 'windshield' && glass.json.vehicle?.model === 'Sienna', JSON.stringify(glass.json));
  check('glass lookup charges 0 credits', glass.json.credits_used === 0, JSON.stringify(glass.json));
  const glassMiss = await call('GET', '/v1/glass/NOPE123', { key: 'rr-demo' });
  check('glass unknown → 404 glass_not_found', glassMiss.status === 404 && glassMiss.json.error?.code === 'glass_not_found', JSON.stringify(glassMiss.json));

  console.log('402 out_of_credits (rr-test-low, quota 1)');
  const low1 = await call('POST', '/v1/lookup', { key: 'rr-test-low', body: { vin: VINS.accord } });
  check('low-quota key first lookup → 200', low1.status === 200, JSON.stringify(low1.json));
  const low2 = await call('POST', '/v1/lookup', { key: 'rr-test-low', body: { vin: VINS.accord } });
  check('low-quota key second lookup → 402 out_of_credits', low2.status === 402 && low2.json.error?.code === 'out_of_credits', JSON.stringify(low2.json));

  console.log('429 rate_limited (rr-test-rate, 5/min)');
  const rateStatuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call('GET', `/v1/lookup/${VINS.accord}`, { key: 'rr-test-rate' });
    rateStatuses.push(r.status);
  }
  check('6 rapid requests → first 5 pass, 6th is 429', JSON.stringify(rateStatuses) === JSON.stringify([200, 200, 200, 200, 200, 429]), JSON.stringify(rateStatuses));

  console.log('unknown route');
  const unknown = await call('GET', '/v1/nope', { key: 'rr-demo' });
  check('unknown route → 404 not_found', unknown.status === 404 && unknown.json.error?.code === 'not_found', JSON.stringify(unknown.json));

  console.log(`\n${pass} passed, ${fail} failed${fail ? ` — failed: ${failures.join(', ')}` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
