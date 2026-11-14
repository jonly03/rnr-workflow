// R&R VIN API — Layer 4 MVP (standalone black-box server)
// Spec: vin-api/API_SPEC.md v0.2 (whole-car). Prototype logic reused from
// api/lookup.js (NHTSA vPIC decode + verified catalog) and extended here.
//
// What this MVP adds over the prototype:
//   - Standalone server: `node server.js` — no Vercel, no other layer needed.
//   - All endpoints: POST /v1/lookup, GET /v1/lookup/{vin},
//     POST /v1/lookup/batch, GET /v1/glass/{nags}, GET /v1/health.
//   - Auth (X-API-Key), per-key monthly quota (402) and rate limit (429).
//   - ISO 3779 VIN check-digit validation (400 invalid_vin).
//   - 422 variant_ambiguous top-level fallback (see below).
//   - Pricing from ONE config file (config/pricing.json) — never hardcoded.
//   - Credits: only a successful vehicle decode charges 1 credit.
//     Failed, invalid, not-found, ambiguous, rate-limited and upstream
//     lookups never charge a credit.
//
// What is NOT in this build (per spec): no charging, no billing, no Stripe,
// no public launch, no customer signups, no Mygrant ordering. Nothing takes
// money. Price/availability are null until supplier feeds exist. Part
// numbers are never invented; unverified parts return null.
//
// Node 18+. No dependencies (built-in http + fetch only).
//   PORT=3000 node server.js
//   RR_CONFIG_PATH=/path/to/pricing.json RR_CATALOG_PATH=/path/to/catalog.json

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = process.env.RR_CONFIG_PATH || path.join(__dirname, 'config', 'pricing.json');
const CATALOG_PATH = process.env.RR_CATALOG_PATH || path.join(__dirname, 'data', 'catalog.json');
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
const PORT = Number(process.env.PORT || 3000);

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

const CATEGORIES = ['glass', 'exterior', 'interior', 'engine', 'mechanical'];
const TOP_CATEGORIES = ['exterior', 'interior', 'engine', 'mechanical'];
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // 17 chars, no I/O/Q

// ---------------------------------------------------------------------------
// In-memory usage (MVP). Restarts reset counters — documented in README.
// ---------------------------------------------------------------------------
const usage = new Map(); // key -> { used, month }
const rateHits = new Map(); // key -> [epoch ms]

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function keyRecord(keyCfg) {
  const m = monthKey();
  let rec = usage.get(keyCfg.key);
  if (!rec || rec.month !== m) {
    rec = { used: 0, month: m };
    usage.set(keyCfg.key, rec);
  }
  return rec;
}

function creditsRemaining(keyCfg) {
  return Math.max(0, keyCfg.monthly_quota - keyRecord(keyCfg).used);
}

function charge(keyCfg, n = 1) {
  keyRecord(keyCfg).used += n;
}

function rateLimitPerMinute(keyCfg) {
  return keyCfg.rate_limit_per_minute || config.rate_limit.requests_per_minute;
}

function checkRate(keyCfg) {
  const now = Date.now();
  const windowMs = 60_000;
  const hits = (rateHits.get(keyCfg.key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= rateLimitPerMinute(keyCfg)) {
    const retryAfter = Math.ceil((hits[0] + windowMs - now) / 1000);
    return { limited: true, retryAfter: Math.max(1, retryAfter) };
  }
  hits.push(now);
  rateHits.set(keyCfg.key, hits);
  return { limited: false };
}

// ---------------------------------------------------------------------------
// VIN validation (ISO 3779 check digit, position 9)
// ---------------------------------------------------------------------------
const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4,
  N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = /[0-9]/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    sum += val * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

function validVin(vin) {
  if (!VIN_RE.test(vin)) return false;
  return checkDigit(vin) === vin[8];
}

// ---------------------------------------------------------------------------
// NHTSA decode + catalog match
// ---------------------------------------------------------------------------
async function decodeVin(vin) {
  const r = await fetch(`${VPIC}/${vin}?format=json`);
  if (!r.ok) throw new Error(`vpic http ${r.status}`);
  const data = await r.json();
  const d = data.Results?.[0];
  if (!d || d.ErrorCode !== '0' || !d.Make) return null;
  const displacementL = d.DisplacementL ? Number(d.DisplacementL) : null;
  return {
    year: Number(d.ModelYear),
    make: d.Make,
    model: d.Model,
    trim: d.Trim || null,
    body: d.BodyClass || null,
    engine: [
      displacementL ? `${displacementL.toFixed(1)}L` : null,
      d.EngineCylinders ? `${d.EngineCylinders}-cyl` : null,
    ].filter(Boolean).join(' ') || null,
    fuel: d.FuelTypePrimary || null,
    transmission: d.TransmissionStyle || null,
    drive: d.DriveType || null,
    doors: d.Doors ? Number(d.Doors) : null,
    displacementL,
  };
}

function parseRange(range) {
  const m = String(range).match(/^(\d{4})(?:-(\d{4}))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || m[1])];
}

// Match rule (documented in README): same make/model, year inside the
// catalog row's range, and — when the decode gives an engine displacement —
// the displacement must match the row's engine (the verified rows are for
// one engine each; a different engine on the same model is NOT a match).
function matchCatalog(vehicle) {
  for (const row of catalog.vehicles || []) {
    const m = row.match;
    if (!m) continue;
    if (m.make.toLowerCase() !== String(vehicle.make).toLowerCase()) continue;
    if (m.model.toLowerCase() !== String(vehicle.model).toLowerCase()) continue;
    const range = parseRange(row.range || String(m.year));
    if (!range) continue;
    if (vehicle.year < range[0] || vehicle.year > range[1]) continue;
    if (m.engine && vehicle.displacementL) {
      const want = parseFloat(m.engine);
      if (Number.isFinite(want) && Math.abs(want - vehicle.displacementL) > 0.01) continue;
    }
    return row;
  }
  return null;
}

function pickCategories(hit, needs) {
  if (!hit) return null;
  const wanted = needs && needs.length ? needs : CATEGORIES;
  const out = {};
  for (const cat of TOP_CATEGORIES) {
    if (wanted.includes(cat) || (cat === 'exterior' && wanted.includes('glass'))) {
      out[cat] = hit.categories[cat];
      if (cat === 'exterior' && wanted.includes('glass') && !wanted.includes('exterior')) {
        out[cat] = { glass: hit.categories.exterior.glass };
      }
    }
  }
  return out;
}

function hasContent(v) {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object') return true;
  return Object.values(v).some(hasContent);
}

// ---------------------------------------------------------------------------
// Pricing (from config/pricing.json only — never hardcoded)
// ---------------------------------------------------------------------------
function priceFor({ hit, needs, location }) {
  const p = config.pricing;
  let tier;
  let amount;
  const wanted = needs && needs.length ? needs : CATEGORIES;
  const allFour = TOP_CATEGORIES.every((c) => wanted.includes(c));
  if (!hit) {
    tier = 'decode';
    amount = p.decode;
  } else if (allFour) {
    tier = 'full_vehicle';
    amount = p.full_vehicle;
  } else if (wanted.length === 1 && wanted[0] === 'glass') {
    tier = 'decode_glass';
    amount = p.decode_glass;
  } else {
    // Partial category set — no spec tier yet; priced as a decode until
    // Pedro sets partial-category pricing.
    tier = 'decode';
    amount = p.decode;
  }
  if (location) {
    tier += '+location';
    amount += p.location_addon;
  }
  return { tier, amount: Math.round(amount * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Location: straight-line distance to the shop + estimated drive time.
// Labeled as an estimate in the response until a routing feed exists.
// ---------------------------------------------------------------------------
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function shopBlock(location) {
  const shop = {
    name: config.shop.name,
    address: config.shop.address,
    phone: config.shop.phone,
    mobile_available: true,
  };
  if (location) {
    const miles = haversineMiles(location.lat, location.lng, config.shop.lat, config.shop.lng);
    shop.distance_miles = Math.round(miles * 10) / 10;
    shop.drive_minutes = Math.round((miles / 25) * 60); // ~25 mph urban estimate
    shop.distance_note = 'Straight-line distance; drive time is an estimate — no routing feed yet.';
  }
  return shop;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(payload);
}

function errBody(code, message, extra = {}) {
  return { error: { code, message }, ...extra };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function parseNeeds(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(',');
  return list.map((s) => String(s).trim().toLowerCase()).filter((s) => CATEGORIES.includes(s) || s === 'location');
}

function parseLocation(body, query) {
  const latRaw = body?.location?.lat ?? query.lat;
  const lngRaw = body?.location?.lng ?? query.lng;
  if (latRaw === undefined && lngRaw === undefined) return { location: null, error: null };
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { location: null, error: 'location lat/lng must be valid numbers.' };
  }
  return { location: { lat, lng }, error: null };
}

// ---------------------------------------------------------------------------
// Auth: returns the key config, or sends the 401 and returns null.
// ---------------------------------------------------------------------------
function authenticate(req, res) {
  const key = req.headers['x-api-key'];
  const keyCfg = (config.keys || []).find((k) => k.key === key);
  if (!keyCfg) {
    send(res, 401, errBody('unauthorized', 'Missing or bad API key.'));
    return null;
  }
  const rl = checkRate(keyCfg);
  if (rl.limited) {
    send(
      res,
      429,
      errBody('rate_limited', `Too many requests for this key. Try again in ${rl.retryAfter}s.`, {
        credits_used: 0,
        credits_remaining: creditsRemaining(keyCfg),
      }),
      { 'Retry-After': String(rl.retryAfter) }
    );
    return null;
  }
  if (creditsRemaining(keyCfg) <= 0) {
    send(res, 402, errBody('out_of_credits', 'Monthly quota used up for this key.', {
      credits_used: 0,
      credits_remaining: 0,
    }));
    return null;
  }
  return keyCfg;
}

// ---------------------------------------------------------------------------
// Core lookup: decode + catalog + categories. Shared by POST, GET, batch.
// Returns { status, body } — never charges a credit except on success.
// ---------------------------------------------------------------------------
async function doLookup(vin, needs, location) {
  if (!validVin(vin)) {
    return {
      status: 400,
      body: errBody(
        'invalid_vin',
        'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit. No credit charged.',
        { credits_used: 0 }
      ),
    };
  }
  let decoded;
  try {
    decoded = await decodeVin(vin);
  } catch {
    return {
      status: 502,
      body: errBody('upstream_error', 'NHTSA VIN decoder is down. Try again — no credit charged.', {
        credits_used: 0,
      }),
    };
  }
  if (!decoded) {
    return {
      status: 404,
      body: errBody('vin_not_found', 'VIN decoded cleanly but no vehicle record came back for it. No credit charged.', {
        credits_used: 0,
      }),
    };
  }
  const { displacementL, ...vehicle } = decoded;
  const hit = matchCatalog(decoded);
  const categories = pickCategories(hit, needs);

  // 422 top-level fallback (spec): the caller asked for specific categories,
  // the vehicle IS in the catalog, but every requested category is entirely
  // empty — no verified data and no follow-up questions, so no follow-up
  // path exists. (Normal ambiguity is per part, with a 200.)
  const requested = (needs && needs.length ? needs : CATEGORIES).filter((c) => c !== 'location');
  if (hit && requested.length && requested.length < CATEGORIES.length) {
    const anyContent = requested.some((c) => {
      if (c === 'glass') return hasContent(hit.categories?.exterior?.glass);
      return hasContent(hit.categories?.[c]);
    });
    if (!anyContent) {
      return {
        status: 422,
        body: {
          vin,
          vehicle,
          error: {
            code: 'variant_ambiguous',
            message: `No verified data for ${requested.join(', ')} on this vehicle yet, and no follow-up questions can settle it. Send the trim, a door-jamb photo, or the exact part position. No credit charged.`,
            requested_categories: requested,
          },
          credits_used: 0,
        },
      };
    }
  }

  const pricing = priceFor({ hit, needs, location });
  return {
    status: 200,
    charged: true,
    body: {
      vin,
      vehicle,
      categories,
      ...(hit
        ? {}
        : {
            catalog_note:
              'Vehicle decoded, but this year/make/model is not in the parts catalog yet. Categories return null — parts are never guessed.',
          }),
      shop: shopBlock(location),
      pricing_tier: pricing.tier,
      price_usd: pricing.amount,
      credits_used: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
let vpicCache = { at: 0, status: 'unknown' };
async function vpicStatus() {
  if (Date.now() - vpicCache.at < 60_000 && vpicCache.status !== 'unknown') return vpicCache.status;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes?format=json', { signal: ctrl.signal });
    clearTimeout(t);
    vpicCache = { at: Date.now(), status: r.ok ? 'ok' : 'degraded' };
  } catch {
    vpicCache = { at: Date.now(), status: 'degraded' };
  }
  return vpicCache.status;
}

const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams.entries());
  console.log(`${req.method} ${url.pathname}`);

  try {
    // Root — service pointer (no auth).
    if (pathParts.length === 0) {
      return send(res, 200, {
        service: "R&R VIN API",
        version: config.version,
        docs: 'See vin-api/README.md and vin-api/API_SPEC.md in repo jonly03/rnr-workflow, branch mvp/layer-4-sellable-api.',
        endpoints: [
          'POST /v1/lookup',
          'GET /v1/lookup/{vin}',
          'POST /v1/lookup/batch',
          'GET /v1/glass/{nags}',
          'GET /v1/health',
        ],
      });
    }

    // Health — public, no key (so Lou can check the service is up first).
    if (pathParts[0] === 'v1' && pathParts[1] === 'health' && req.method === 'GET') {
      return send(res, 200, {
        status: 'ok',
        version: config.version,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        vpic: await vpicStatus(),
        catalog_vehicles: (catalog.vehicles || []).length,
        pricing_version: config.version,
      });
    }

    if (pathParts[0] !== 'v1') {
      return send(res, 404, errBody('not_found', 'Unknown route.'));
    }

    // Everything below needs a key.
    const keyCfg = authenticate(req, res);
    if (!keyCfg) return;

    const remaining = () => creditsRemaining(keyCfg);

    // POST /v1/lookup
    if (pathParts[1] === 'lookup' && pathParts.length === 2 && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return send(res, 400, errBody('invalid_request', e.message === 'invalid json' ? 'Request body must be valid JSON.' : e.message, { credits_used: 0, credits_remaining: remaining() }));
      }
      const vin = String(body.vin || '').trim().toUpperCase();
      const needs = parseNeeds(body.needs);
      const { location, error: locErr } = parseLocation(body, query);
      if (locErr) {
        return send(res, 400, errBody('invalid_request', locErr, { credits_used: 0, credits_remaining: remaining() }));
      }
      const out = await doLookup(vin, needs, location);
      if (out.charged) {
        charge(keyCfg, 1);
        out.body.credits_remaining = remaining();
      } else {
        out.body.credits_remaining = remaining();
      }
      return send(res, out.status, out.body);
    }

    // GET /v1/lookup/{vin}
    if (pathParts[1] === 'lookup' && pathParts.length === 3 && req.method === 'GET') {
      const vin = decodeURIComponent(pathParts[2]).toUpperCase();
      const needs = parseNeeds(query.needs);
      const { location, error: locErr } = parseLocation(null, query);
      if (locErr) {
        return send(res, 400, errBody('invalid_request', locErr, { credits_used: 0, credits_remaining: remaining() }));
      }
      const out = await doLookup(vin, needs, location);
      if (out.charged) {
        charge(keyCfg, 1);
        out.body.credits_remaining = remaining();
      } else {
        out.body.credits_remaining = remaining();
      }
      return send(res, out.status, out.body);
    }

    // POST /v1/lookup/batch
    if (pathParts[1] === 'lookup' && pathParts[2] === 'batch' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return send(res, 400, errBody('invalid_request', e.message === 'invalid json' ? 'Request body must be valid JSON.' : e.message, { credits_used: 0, credits_remaining: remaining() }));
      }
      const vins = body.vins;
      if (!Array.isArray(vins) || vins.length === 0 || vins.length > 100) {
        return send(res, 400, errBody('invalid_request', 'Body must have "vins": an array of 1–100 VIN strings.', { credits_used: 0, credits_remaining: remaining() }));
      }
      const needs = parseNeeds(body.needs);
      const { location, error: locErr } = parseLocation(body, query);
      if (locErr) {
        return send(res, 400, errBody('invalid_request', locErr, { credits_used: 0, credits_remaining: remaining() }));
      }
      const results = [];
      let charged = 0;
      let priceTotal = 0;
      for (const raw of vins) {
        const v = String(raw ?? '').trim().toUpperCase();
        // Quota exhausted mid-batch: remaining decodable VINs get a
        // per-item out_of_credits error instead of a free lookup.
        if (remaining() - charged <= 0) {
          results.push({ vin: v, error: { code: 'out_of_credits', message: 'Monthly quota used up for this key.' }, credits_used: 0 });
          continue;
        }
        const out = await doLookup(v, needs, location);
        if (out.charged) {
          charged += 1;
          priceTotal += out.body.price_usd;
          results.push(out.body);
        } else {
          results.push({ vin: v, ...out.body });
        }
      }
      if (charged) charge(keyCfg, charged);
      return send(res, 200, {
        results,
        credits_used: charged,
        credits_remaining: remaining(),
        price_usd_total: Math.round(priceTotal * 100) / 100,
      });
    }

    // GET /v1/glass/{nags} — on-file NAGS numbers only (spec: phase 2).
    // Catalog reads do not charge a credit.
    if (pathParts[1] === 'glass' && pathParts.length === 3 && req.method === 'GET') {
      const nags = decodeURIComponent(pathParts[2]).trim().toUpperCase();
      for (const row of catalog.vehicles || []) {
        const glass = row.categories?.exterior?.glass;
        if (!glass) continue;
        for (const [position, entry] of Object.entries(glass)) {
          if (entry && entry.part_number && entry.part_number.toUpperCase() === nags) {
            return send(res, 200, {
              nags: entry.part_number,
              position,
              vehicle: { make: row.match.make, model: row.match.model, year_range: row.range || String(row.match.year) },
              part: entry,
              credits_used: 0,
              credits_remaining: remaining(),
            });
          }
        }
      }
      return send(res, 404, errBody('glass_not_found', `No glass on file for NAGS ${nags}. Only R&R-verified NAGS numbers are in the catalog until the licensed NAGS feed exists.`, {
        credits_used: 0,
        credits_remaining: remaining(),
      }));
    }

    return send(res, 404, errBody('not_found', 'Unknown route.'));
  } catch (e) {
    console.error(e);
    return send(res, 500, errBody('internal_error', 'Something went wrong. No credit charged.', { credits_used: 0 }));
  }
});

server.listen(PORT, () => {
  console.log(`R&R VIN API ${config.version} listening on http://127.0.0.1:${PORT}`);
  console.log(`Catalog: ${(catalog.vehicles || []).length} vehicles from data/catalog.json`);
  console.log(`Pricing: decode $${config.pricing.decode} / decode+glass $${config.pricing.decode_glass} / full vehicle $${config.pricing.full_vehicle} / location +$${config.pricing.location_addon} (config/pricing.json)`);
  console.log('Demo key: rr-demo (25/month). Low-quota test key: rr-test-low (quota 1). Rate test key: rr-test-rate (5/min).');
});
