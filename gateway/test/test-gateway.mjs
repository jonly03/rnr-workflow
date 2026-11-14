// Gateway black-box tests — node test/test-gateway.mjs
// Starts the real server on a scratch port (real config + catalog, temp
// audit log, Case API pointed at a dead port so the create_case proxy
// error path is exercised WITHOUT creating a real case), then calls
// POST /brain exactly as Web / WhatsApp / Siri / phone would.
//
// Live NHTSA decode is exercised for real — these tests need internet.
//   node test/test-gateway.mjs
//   node --test test/test-gateway.mjs   (same thing, TAP output)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const AUDIT = path.join(os.tmpdir(), `gateway-test-audit-${process.pid}.log`);

const DEMO = 'rr-demo';
const LOW = 'rr-test-low';
const RATE = 'rr-test-rate';
const STAFF = 'rr-staff';

// Real CLA35 VIN from R&R job history (2020 Mercedes CLA35 AMG).
const CLA35 = 'WDD5J5BB2LN065797';
// Real Sienna VIN shape from the referral sheet is not on file; the
// Sienna catalog row is reached by YMM instead.
const BAD_VIN = 'WDD5J5BB2LN065798'; // same shape, wrong check digit

let proc;

async function brain(tool, args, key = DEMO, channel = 'web', extra = {}) {
  const r = await fetch(`${BASE}/brain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({ tool, arguments: args, channel, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  if (fs.existsSync(AUDIT)) fs.unlinkSync(AUDIT);
  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RR_AUDIT_PATH: AUDIT,
      RR_CASE_API_URL: 'http://127.0.0.1:9', // dead port: proxy must 502, never fake a 201
    },
    stdio: 'ignore',
  });
  // Wait for health (server up), up to 15s.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/brain/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('gateway did not come up');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  proc?.kill();
  if (fs.existsSync(AUDIT)) fs.unlinkSync(AUDIT);
});

test('health is public and lists the tools', async () => {
  const r = await fetch(`${BASE}/brain/health`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.service, 'rr-brain-gateway');
  assert.equal(b.catalog_vehicles, 4);
  assert.deepEqual(b.tools, ['decode_vin', 'get_vehicle', 'lookup_part', 'quote', 'create_case', 'get_case_status', 'order_glass']);
});

test('tools list is public MCP definitions', async () => {
  const r = await fetch(`${BASE}/brain/tools`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.tools.length, 7);
  assert.ok(b.tools.every((t) => t.name && t.inputSchema && t.description));
});

test('missing key -> 401 invalid_api_key', async () => {
  const r = await fetch(`${BASE}/brain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'decode_vin', arguments: { vin: CLA35 } }),
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'invalid_api_key');
});

test('unknown tool -> 400 unknown_tool', async () => {
  const { status, body } = await brain('fly_to_moon', {});
  assert.equal(status, 400);
  assert.equal(body.error.code, 'unknown_tool');
});

test('bad channel -> 400', async () => {
  const { status, body } = await brain('decode_vin', { vin: CLA35 }, DEMO, 'smoke-signal');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'invalid_arguments');
});

test('decode_vin: live NHTSA decode of the 2020 CLA35', async () => {
  const { status, body } = await brain('decode_vin', { vin: CLA35 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.result.vehicle.year, 2020);
  assert.match(body.result.vehicle.make, /Mercedes/i);
  assert.match(body.result.vehicle.model, /CLA/i);
  assert.equal(body.usage.charged_usd, 0.15);
  assert.equal(body.usage.credits_used, 1);
});

test('decode_vin: bad check digit -> 400 invalid_vin, charged $0', async () => {
  const { status, body } = await brain('decode_vin', { vin: BAD_VIN });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'invalid_vin');
  assert.equal(body.usage.charged_usd, 0);
  assert.equal(body.usage.credits_used, 0);
});

test('get_vehicle by YMM finds the Tacoma in the catalog', async () => {
  const { status, body } = await brain('get_vehicle', { year: 2016, make: 'Toyota', model: 'Tacoma' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.in_catalog, true);
  assert.equal(body.usage.charged_usd, 0.15);
});

test('lookup_part glass: Sienna windshield is exact (FW03760 GBY)', async () => {
  const { status, body } = await brain('lookup_part', { year: 2013, make: 'Toyota', model: 'Sienna', category: 'glass', glass_type: 'WINDSHIELD' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.variant_status, 'exact');
  assert.equal(body.result.part.part_number, 'FW03760 GBY');
  assert.equal(body.usage.charged_usd, 0.85);
});

test('lookup_part glass: CLA35 is not in the catalog -> 422 variant_ambiguous with follow-ups, $0', async () => {
  const { status, body } = await brain('lookup_part', { vin: CLA35, category: 'glass', glass_type: 'WINDSHIELD' });
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(body.error.code, 'variant_ambiguous');
  assert.ok(Array.isArray(body.follow_up) && body.follow_up.length >= 3);
  assert.match(body.follow_up.join(' '), /rain sensor/i);
  assert.match(body.follow_up.join(' '), /ADAS/i);
  assert.equal(body.usage.charged_usd, 0);
  assert.equal(body.usage.credits_used, 0);
  assert.ok(!JSON.stringify(body).includes('FW0'), 'must not guess a part number');
});

test('lookup_part glass: Tacoma needs confirmation -> 422, then variant answers -> 200 exact', async () => {
  const first = await brain('lookup_part', { year: 2016, make: 'Toyota', model: 'Tacoma', category: 'glass', glass_type: 'WINDSHIELD' });
  assert.equal(first.status, 422);
  assert.equal(first.body.error.code, 'variant_ambiguous');
  assert.equal(first.body.usage.charged_usd, 0);
  const second = await brain('lookup_part', {
    year: 2016, make: 'Toyota', model: 'Tacoma', category: 'glass', glass_type: 'WINDSHIELD',
    variant_answers: { rain_sensor: true, adas_camera: false, heads_up_display: false, acoustic: false, heated: false },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.result.part.part_number, 'FW04108 GTY');
});

test('lookup_part full vehicle: Tacoma -> fullVehicle tier $1.25', async () => {
  const { status, body } = await brain('lookup_part', { year: 2016, make: 'Toyota', model: 'Tacoma', category: 'full' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.pricing_tier, 'fullVehicle');
  assert.equal(body.usage.charged_usd, 1.25);
  assert.ok(body.result.categories.engine?.oil_filter?.part_number, 'engine data present');
});

test('lookup_part by NAGS number decodes FW03760 GBY and cross-checks the catalog', async () => {
  const { status, body } = await brain('lookup_part', { part: 'FW03760 GBY' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.nags.partType, 'Windshield');
  assert.equal(body.result.nags.category, 'Windshield');
  assert.equal(body.result.nags.color, 'Green tint / blue shade');
  assert.equal(body.result.on_file.length, 1);
  assert.equal(body.result.on_file[0].vehicle.model, 'Sienna');
  assert.equal(body.usage.charged_usd, 0);
});

test('quote: Sienna windshield typical range $300-700, free', async () => {
  const { status, body } = await brain('quote', { year: 2013, make: 'Toyota', model: 'Sienna', glass_type: 'WINDSHIELD' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.result.typical_range_usd, [300, 700]);
  assert.deepEqual(body.result.recalibration_usd, [275, 500]);
  assert.equal(body.usage.charged_usd, 0);
});

test('create_case: bad phone -> 400, nothing created, $0', async () => {
  const { status, body } = await brain('create_case', {
    customer_name: 'Test Person', customer_phone: '123', glass_type: 'WINDSHIELD',
    service_address: { formatted: '1 Test St, Dorchester MA 02125' },
    year: 2020, make: 'Mercedes-Benz', model: 'CLA-Class',
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'invalid_arguments');
});

test('create_case: valid args but dead Case API -> 502 upstream_error, never a fake 201', async () => {
  const { status, body } = await brain('create_case', {
    customer_name: 'Test Person', customer_phone: '617-555-0100', glass_type: 'WINDSHIELD',
    service_address: { formatted: '1 Test St, Dorchester MA 02125' },
    vin: CLA35,
  });
  assert.equal(status, 502, JSON.stringify(body));
  assert.equal(body.error.code, 'upstream_error');
  assert.equal(body.usage.charged_usd, 0);
});

test('create_case: smuggled channel/state/pricing keys are stripped, not honored', async () => {
  const { status, body } = await brain('create_case', {
    customer_name: 'Test Person', customer_phone: '617-555-0100', glass_type: 'WINDSHIELD',
    service_address: { formatted: '1 Test St, Dorchester MA 02125' },
    vin: CLA35, channel: 'SAFELITE', state: 'INVOICED', price_usd: 0.01, reference: 'FAKE',
  });
  // Still reaches the upstream (502), not a validation error — the
  // smuggled keys were stripped before validation/proxy.
  assert.equal(status, 502);
  assert.equal(body.error.code, 'upstream_error');
});

test('get_case_status: missing token -> 400; bad token -> 404 or 502 (upstream), never 200', async () => {
  const missing = await brain('get_case_status', {});
  assert.equal(missing.status, 400);
  const bad = await brain('get_case_status', { status_token: 'no-such-token' });
  assert.ok([404, 502].includes(bad.status), `unexpected ${bad.status}: ${JSON.stringify(bad.body)}`);
});

test('order_glass: public key -> 403 forbidden', async () => {
  const { status, body } = await brain('order_glass', { vin: CLA35, glass_type: 'WINDSHIELD' }, DEMO);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'forbidden');
});

test('order_glass: staff key passes gates, then 503 mygrant_not_configured, $0', async () => {
  const { status, body } = await brain('order_glass', { vin: CLA35, glass_type: 'WINDSHIELD' }, STAFF);
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.error.code, 'mygrant_not_configured');
  assert.equal(body.usage.charged_usd, 0);
});

test('quota: rr-test-low (quota 1) decodes once, then 402 out_of_credits', async () => {
  const first = await brain('decode_vin', { vin: CLA35 }, LOW);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.usage.credits_remaining, 0);
  const second = await brain('decode_vin', { vin: CLA35 }, LOW);
  assert.equal(second.status, 402);
  assert.equal(second.body.error.code, 'out_of_credits');
  // Free tools still work after quota exhaustion.
  const free = await brain('quote', { year: 2013, make: 'Toyota', model: 'Sienna', glass_type: 'WINDSHIELD' }, LOW);
  assert.equal(free.status, 200);
});

test('rate limit: rr-test-rate (5/min) 429s on the 6th quick call', async () => {
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await brain('decode_vin', { vin: CLA35 }, RATE));
  }
  assert.equal(results[5].status, 429, JSON.stringify(results[5].body));
  assert.equal(results[5].body.error.code, 'rate_limited');
});

test('audit log: every /brain call logged, phone masked', async () => {
  // Give the appends a beat to flush (they are synchronous, but be safe).
  await new Promise((r) => setTimeout(r, 200));
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 20, `expected >=20 audit lines, got ${lines.length}`);
  assert.ok(lines.every((l) => l.tool && l.http_status && 'charged_usd' in l && l.channel));
  const createCaseLines = lines.filter((l) => l.tool === 'create_case');
  assert.ok(createCaseLines.length >= 2);
  const raw = fs.readFileSync(AUDIT, 'utf8');
  assert.ok(!raw.includes('617-555-0100'), 'full phone number must never land in the audit log');
  assert.ok(raw.includes('***-***-0100'), 'masked phone present');
});
