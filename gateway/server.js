// R&R Brain Gateway — the Door (gateway/brain-door)
// ============================================================
// One API + MCP in front of Muse, wrapping the existing rnr-workflow
// system. Web, WhatsApp, Siri and phone all call the same door:
//
//   POST /brain   { tool, arguments, channel }   + X-API-Key header
//   GET  /brain/health                           (public, no key)
//   GET  /brain/tools                            (public MCP definitions)
//
// Reuse map (nothing rebuilt from scratch):
//   - Auth / quota / rate limit / VIN check-digit / NHTSA decode /
//     catalog match / pricing tiers: Layer 4 MVP server
//     (branch mvp/layer-4-sellable-api, vin-api/server.js).
//   - Verified catalog (4 vehicles, 37 part rows): Layer 2 MVP
//     (branch mvp/layer-2-vin-anything, vin-api/catalog.json).
//   - Pricing defaults + customer quote ranges: Layer 1 shared config
//     (branch mvp/layer-1-talking-intake, config/vin-brain-pricing.json).
//   - VIN gate (ISO 3779 check digit): apps/api/src/vin-validation.ts.
//   - NHTSA decode: apps/api/src/vin-decode.ts (decodeVinNhtsa).
//   - NAGS part decode: apps/api/src/nags.ts (decodeNagsPartNumber).
//   - Intake contract (zod fields, phone rule, 201 shape, rate limit):
//     apps/api/src/app.ts (publicIntakeSchema, POST /api/v1/public/intake).
//   - MyGrant $1 VIN lookup cost + spend cap: apps/api/src/mygrant.ts
//     (MYGRANT_VIN_LOOKUP_COST_USD = 1).
//   - Pricing config: gateway/config/pricing.json — the ONLY place prices,
//     keys and caps live. Never hardcoded.
//
// Rules the gateway never breaks (map phase):
//   - Never guess a variant: unanswered glass questions -> 422
//     variant_ambiguous with follow_up questions, charged $0.
//   - Never charge on a failed lookup: only a successful decode/lookup
//     charges a credit. Invalid, ambiguous, rate-limited, out-of-credits
//     and upstream failures charge $0.
//   - Never smuggle pricing/state: unknown argument keys are stripped;
//     channel is pinned DIRECT and state REQUEST_RECEIVED server-side.
//   - Never merge to main, never overwrite root index.html (branch only).
//
// Node 18+. No dependencies (built-in http + fetch only).
//   PORT=3000 node server.js
//   RR_CONFIG_PATH=/path/to/pricing.json RR_CATALOG_PATH=/path/to/catalog.json
//   RR_TOOLS_PATH=/path/to/tools.json RR_CASE_API_URL=https://...vercel.app
//   RR_AUDIT_PATH=/path/to/audit.log RR_VERCEL_BYPASS_SECRET=...

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = process.env.RR_CONFIG_PATH || path.join(__dirname, 'config', 'pricing.json');
const CATALOG_PATH = process.env.RR_CATALOG_PATH || path.join(__dirname, 'data', 'catalog.json');
const TOOLS_PATH = process.env.RR_TOOLS_PATH || path.join(__dirname, 'tools.json');
const AUDIT_PATH = process.env.RR_AUDIT_PATH || path.join(__dirname, 'audit.log');
// Case Core (apps/api) base URL. The gateway fronts it for create_case /
// get_case_status instead of re-implementing the case engine.
// NOTE 2026-11-13 ~23:30 EST: Pedro turned Vercel Deployment Protection
// OFF on rnr-case-web, so the staging intake now loads publicly and no
// bypass is needed. The Case API behind it was erroring (500
// INTERNAL_ERROR) because the staging database (Supabase
// rnr-case-core-staging, ref tvfrfkxyvicnjibjhloa, Free plan) was PAUSED
// after 7 days idle; every DB call failed ENOTFOUND. Pedro resumed it
// ~23:35 EST; restoration was CONFIRMED healthy 23:47 EST
// (/api/v1/health ok:true, storage postgres) and re-verified 2026-11-14
// ~04:50 EST by direct curl (ok:true, storage postgres). create_case /
// get_case_status now proxy live; the proxy still honestly returns 502
// upstream_error if the API ever goes down again — the gateway never
// fakes a 201. The bypass env is kept for a wall coming back.
const CASE_API_URL = (process.env.RR_CASE_API_URL || 'https://rnr-case-staging-zero-to100-edu.vercel.app').replace(/\/$/, '');
// Optional Vercel Deployment Protection bypass secret, sent as
// x-vercel-protection-bypass on proxied calls. The wall is OFF since
// 2026-11-13 ~23:30 EST, so the bypass is not needed right now; keep
// the env for a wall coming back, else the proxy returns 502
// upstream_error. Never commit the secret.
const VERCEL_BYPASS = process.env.RR_VERCEL_BYPASS_SECRET || '';
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
const PORT = Number(process.env.PORT || 3000);

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const toolDefs = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));

const VERSION = config.version || '0.3-gateway';
const CHANNELS = ['web', 'whatsapp', 'siri', 'phone'];
const GLASS_TYPES = ['WINDSHIELD', 'BACK_GLASS', 'DOOR_GLASS', 'QUARTER_GLASS', 'VENT_GLASS'];
const CATEGORIES = ['glass', 'exterior', 'interior', 'engine', 'mechanical'];
const TOP_CATEGORIES = ['exterior', 'interior', 'engine', 'mechanical'];
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // 17 chars, no I/O/Q
const MAX_VEHICLE_YEAR = new Date().getFullYear() + 1;

// Canonical windshield disambiguation questions, taken verbatim from the
// verified catalog (every windshield row carries the same three). Asked
// whenever the exact glass variant cannot be pinned down — the gateway
// never guesses rain sensor / ADAS / HUD / acoustic / heated.
const WINDSHIELD_QUESTIONS = [
  'Does the windshield have a rain sensor near the mirror?',
  'Is there a camera behind the windshield (lane assist / ADAS)?',
  'Heads-up display? Acoustic glass? Heated wiper area?',
];

// ---------------------------------------------------------------------------
// NAGS tables — ported from apps/api/src/nags.ts (PREFIXES, COLORS,
// ATTACHMENTS, PREMIUMS). decodeNagsPartNumber below mirrors it exactly.
// ---------------------------------------------------------------------------
const NAGS_PREFIXES = {
  DW: { origin: 'Domestic', partType: 'Windshield', category: 'Windshield' },
  DL: { origin: 'Domestic', partType: 'Flat windshield', category: 'Laminated' },
  DT: { origin: 'Domestic', partType: 'Flat non-windshield glass', category: 'Flat tempered' },
  DB: { origin: 'Domestic', partType: 'Backlite / OE slider', category: 'Tempered' },
  DD: { origin: 'Domestic', partType: 'Door glass', category: 'Tempered' },
  DQ: { origin: 'Domestic', partType: 'Quarter glass', category: 'Tempered' },
  DR: { origin: 'Domestic', partType: 'Roof glass', category: 'Tempered' },
  DS: { origin: 'Domestic', partType: 'Side glass', category: 'Tempered' },
  DP: { origin: 'Domestic', partType: 'Partition glass', category: 'Tempered' },
  DV: { origin: 'Domestic', partType: 'Vent glass', category: 'Tempered' },
  DY: { origin: 'Domestic', partType: 'Aftermarket back slider', category: 'Tempered' },
  FW: { origin: 'Foreign', partType: 'Windshield', category: 'Windshield' },
  FL: { origin: 'Foreign', partType: 'Flat windshield', category: 'Laminated' },
  FT: { origin: 'Foreign', partType: 'Flat non-windshield glass', category: 'Flat tempered' },
  FB: { origin: 'Foreign', partType: 'Backlite / OE slider', category: 'Tempered' },
  FD: { origin: 'Foreign', partType: 'Door glass', category: 'Tempered' },
  FQ: { origin: 'Foreign', partType: 'Quarter glass', category: 'Tempered' },
  FR: { origin: 'Foreign', partType: 'Roof glass', category: 'Tempered' },
  FS: { origin: 'Foreign', partType: 'Side glass', category: 'Tempered' },
  FP: { origin: 'Foreign', partType: 'Partition glass', category: 'Tempered' },
  FV: { origin: 'Foreign', partType: 'Vent glass', category: 'Tempered' },
  FY: { origin: 'Foreign', partType: 'Aftermarket back slider', category: 'Tempered' },
  SP: { origin: 'Special', partType: '"S" flat glass part', category: 'Special' },
};
const NAGS_COLORS = {
  BB: 'Blue tint / blue shade', BG: 'Blue tint / green shade', BK: 'Blue tint / black frame',
  BP: 'Blue tint privacy', BT: 'Blue tint', BY: 'Blue tint / gray shade', BZ: 'Blue tint / bronze shade',
  CA: 'Clear / aluminum frame', CB: 'Clear / blue shade', CK: 'Clear / black frame', CL: 'Clear',
  GA: 'Green tint / aluminum frame', GB: 'Green tint / blue shade', GG: 'Green tint / green shade',
  GK: 'Green tint / black frame', GP: 'Green tint privacy', GT: 'Green tint', GY: 'Green tint / gray shade',
  GZ: 'Green tint / bronze shade', KP: 'Black privacy', PA: 'Privacy / aluminum frame',
  PK: 'Privacy / black frame', YA: 'Gray tint / aluminum frame', YB: 'Gray tint / blue shade',
  YK: 'Gray tint / black frame', YP: 'Gray tint privacy', YT: 'Gray tint', YY: 'Gray tint / gray shade',
  ZB: 'Bronze tint / blue shade', ZG: 'Bronze tint / green shade', ZP: 'Bronze tint privacy',
  ZT: 'Bronze tint', ZY: 'Bronze tint / gray shade', ZZ: 'Bronze tint / bronze shade',
};
const NAGS_ATTACHMENTS = {
  Y: 'Hardware included', N: 'No hardware included',
  1: 'Slider: 4-panel, full frame', 2: 'Slider: 4-panel, encapsulated',
  3: 'Slider: 4-panel, partial frame', 4: 'Slider: 3-panel, full frame',
  5: 'Slider: 3-panel, encapsulated', 6: 'Slider: 3-panel, partial frame',
  7: 'Slider: 2-panel, flush fit',
};
const NAGS_PREMIUMS = { Y: 'Manufacturer part (designer stamp)', N: 'Not a manufacturer-stamped part', P: 'Premium' };

function decodeNagsPartNumber(raw) {
  if (typeof raw !== 'string') return null;
  const compact = raw.toUpperCase().replace(/[\s-]/g, '');
  const m = /^([A-Z]{2})(\d{1,5})([A-Z0-9]*)$/.exec(compact);
  if (!m) return null;
  const [, prefix, digits, tailRaw] = m;
  const prefixInfo = NAGS_PREFIXES[prefix];
  if (!prefixInfo) return null;
  const numericCode = digits.padStart(5, '0');
  let tail = tailRaw;
  const warnings = [];
  let colorCode = null;
  if (tail.length >= 2 && NAGS_COLORS[tail.slice(0, 2)]) { colorCode = tail.slice(0, 2); tail = tail.slice(2); }
  let attachmentCode = null;
  if (tail.length >= 1 && NAGS_ATTACHMENTS[tail[0]]) { attachmentCode = tail[0]; tail = tail.slice(1); }
  let premiumCode = null;
  if (tail.length >= 1 && NAGS_PREMIUMS[tail[0]]) { premiumCode = tail[0]; tail = tail.slice(1); }
  if (tail.length > 0) warnings.push(`Suffix "${tail}" isn't in the NAGS tables — check the number.`);
  const color = colorCode ? NAGS_COLORS[colorCode] : null;
  const attachment = attachmentCode ? NAGS_ATTACHMENTS[attachmentCode] : null;
  const premium = premiumCode ? NAGS_PREMIUMS[premiumCode] : null;
  const normalized = prefix + numericCode + (colorCode ?? '') + (attachmentCode ?? '') + (premiumCode ?? '');
  const summary = [`${prefixInfo.origin} ${prefixInfo.partType.toLowerCase()}`, color, attachment, premium].filter(Boolean).join(' · ');
  return { input: raw, normalized, prefix, origin: prefixInfo.origin, partType: prefixInfo.partType, category: prefixInfo.category, numericCode, colorCode, color, attachmentCode, attachment, premiumCode, premium, warnings, summary };
}

// ---------------------------------------------------------------------------
// In-memory usage (MVP). Restarts reset counters — same documented limit
// as the Layer 4 server. Quota is per key per calendar month.
// ---------------------------------------------------------------------------
const usage = new Map(); // key -> { used, month }
const rateHits = new Map(); // key -> [epoch ms]
const createCaseHits = new Map(); // key + ip -> [epoch ms]
const mygrantSpend = { date: '', usd: 0 }; // daily MyGrant spend, USD

function monthKey() { return new Date().toISOString().slice(0, 7); }
function dayKey() { return new Date().toISOString().slice(0, 10); }
function keyRecord(keyCfg) {
  const m = monthKey();
  let rec = usage.get(keyCfg.key);
  if (!rec || rec.month !== m) { rec = { used: 0, month: m }; usage.set(keyCfg.key, rec); }
  return rec;
}
function creditsRemaining(keyCfg) { return Math.max(0, keyCfg.monthly_quota - keyRecord(keyCfg).used); }
function charge(keyCfg, n = 1) { keyRecord(keyCfg).used += n; }
function rateLimitPerMinute(keyCfg) { return keyCfg.rate_limit_per_minute || config.rate_limit.requests_per_minute; }
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
function checkCreateCaseRate(keyCfg, ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = config.create_case.rate_limit_per_10_min || 20;
  const bucketKey = `${keyCfg.key}|${ip}`;
  const hits = (createCaseHits.get(bucketKey) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    return { limited: true, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) };
  }
  hits.push(now);
  createCaseHits.set(bucketKey, hits);
  return { limited: false };
}

// ---------------------------------------------------------------------------
// VIN validation (ISO 3779 check digit, position 9) — mirrors
// apps/api/src/vin-validation.ts assertValidVin.
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
  if (typeof vin !== 'string' || !VIN_RE.test(vin.trim().toUpperCase())) return false;
  const v = vin.trim().toUpperCase();
  return checkDigit(v) === v[8];
}
function normalizeVin(vin) { return String(vin).trim().toUpperCase(); }

// ---------------------------------------------------------------------------
// Phone — mirrors apps/api/src/app.ts normalizeUsPhone: 10 digits, NANP
// area code (leading digit 2-9), leading 1 country code allowed.
// ---------------------------------------------------------------------------
function normalizeUsPhone(raw) {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[2-9]/.test(digits)) return null;
  return digits;
}

// ---------------------------------------------------------------------------
// NHTSA decode — mirrors apps/api/src/vin-decode.ts decodeVinNhtsa.
// Free public API, no key. Throws on network failure; returns null when
// NHTSA has no vehicle record for the VIN.
// ---------------------------------------------------------------------------
async function decodeVin(vin) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let r;
  try {
    r = await fetch(`${VPIC}/${vin}?format=json`, { signal: ctrl.signal });
  } finally { clearTimeout(t); }
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

// ---------------------------------------------------------------------------
// Catalog match — same rule as the Layer 4 server: same make/model, year
// inside the row's range, and when the decode gives an engine
// displacement it must match the row's engine (verified rows are for one
// engine each; a different engine on the same model is NOT a match).
// ---------------------------------------------------------------------------
function parseRange(range) {
  const m = String(range).match(/^(\d{4})(?:-(\d{4}))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || m[1])];
}
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
function hasContent(v) {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object') return true;
  return Object.values(v).some(hasContent);
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

// ---------------------------------------------------------------------------
// Pricing — from gateway/config/pricing.json ONLY. Never hardcoded.
// Tier rule (Layer 4): no catalog hit -> decode; glass only ->
// decodeGlass; all four whole-car categories -> fullVehicle; anything
// else partial -> decode until Pedro sets partial-category pricing.
// ---------------------------------------------------------------------------
function priceFor({ hit, needs, location }) {
  const p = config.pricing;
  let tier;
  let amount;
  const wanted = needs && needs.length ? needs : CATEGORIES;
  const allFour = TOP_CATEGORIES.every((c) => wanted.includes(c));
  if (!hit) { tier = 'decode'; amount = p.decode; }
  else if (allFour) { tier = 'fullVehicle'; amount = p.fullVehicle; }
  else if (wanted.length === 1 && wanted[0] === 'glass') { tier = 'decodeGlass'; amount = p.decodeGlass; }
  else { tier = 'decode'; amount = p.decode; }
  if (location) { tier += '+location'; amount += p.locationAddon; }
  return { tier, amount: Math.round(amount * 100) / 100 };
}
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function shopBlock(location) {
  const shop = { name: config.shop.name, address: config.shop.address, phone: config.shop.phone, mobile_available: true };
  if (location) {
    const miles = haversineMiles(location.lat, location.lng, config.shop.lat, config.shop.lng);
    shop.distance_miles = Math.round(miles * 10) / 10;
    shop.drive_minutes = Math.round((miles / 25) * 60); // ~25 mph urban estimate
    shop.distance_note = 'Straight-line distance; drive time is an estimate — no routing feed yet.';
  }
  return shop;
}

// ---------------------------------------------------------------------------
// HTTP helpers + audit log
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
      if (raw.length > 100_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// Audit log: ONE JSONL line per /brain call, including rejected ones.
// Phone numbers are masked (last 4 only), status tokens truncated, and
// street-level address detail is dropped — the audit proves what the
// gateway did, it is not a second copy of customer PII.
function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { fs.appendFileSync(AUDIT_PATH, line + '\n'); } catch (e) { console.error('audit log write failed:', e.message); }
}
function redactArgs(tool, args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  if (typeof out.customer_phone === 'string') {
    const d = out.customer_phone.replace(/\D/g, '');
    out.customer_phone = d.length >= 4 ? `***-***-${d.slice(-4)}` : '***';
  }
  if (typeof out.status_token === 'string') out.status_token = `${out.status_token.slice(0, 6)}…`;
  if (out.service_address && typeof out.service_address === 'object') {
    const { city, state, zip } = out.service_address;
    out.service_address = { ...(city ? { city } : {}), ...(state ? { state } : {}), ...(zip ? { zip } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argument validation — mirrors the intake zod contract in
// apps/api/src/app.ts. Unknown keys are STRIPPED (never honored): a
// caller cannot smuggle channel, state, pricing or a reference through.
// Returns { ok, args } or { ok:false, status, code, message, field }.
// ---------------------------------------------------------------------------
function stripUnknown(args, allowed) {
  const out = {};
  for (const k of allowed) if (args[k] !== undefined) out[k] = args[k];
  return out;
}
function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length >= 1 && (max === undefined || v.trim().length <= max);
}
function validateYmm(args, out) {
  // Year/make/model, required when no VIN is given. Mirrors the intake
  // schema: year 1950..next year, make/model 1..60 chars.
  if (args.year === undefined && !args.make && !args.model) return null;
  if (args.year === undefined || args.make === undefined || args.model === undefined) {
    return { status: 400, code: 'invalid_arguments', message: 'Give the vehicle: a VIN, or year, make and model together.', field: 'vehicle' };
  }
  const year = Number(args.year);
  if (!Number.isInteger(year) || year < 1950 || year > MAX_VEHICLE_YEAR) {
    return { status: 400, code: 'invalid_arguments', message: `Year must be between 1950 and ${MAX_VEHICLE_YEAR}.`, field: 'year' };
  }
  if (!isNonEmptyString(args.make, 60) || !isNonEmptyString(args.model, 60)) {
    return { status: 400, code: 'invalid_arguments', message: 'Make and model must be 1-60 characters.', field: 'make' };
  }
  out.year = year; out.make = String(args.make).trim(); out.model = String(args.model).trim();
  return null;
}
function validateServiceAddress(raw) {
  // Mirrors serviceAddressSchema: formatted required, the rest optional.
  if (!raw || typeof raw !== 'object') return { error: 'Tell us where we\'ll find the car — type your address, or pick it from the suggestions.' };
  const formatted = typeof raw.formatted === 'string' ? raw.formatted.trim() : '';
  if (!formatted || formatted.length > 400) return { error: 'Tell us where we\'ll find the car — type your address, or pick it from the suggestions.' };
  const addr = { formatted };
  if (typeof raw.place_id === 'string' && raw.place_id.trim()) addr.place_id = raw.place_id.trim().slice(0, 160);
  if (typeof raw.street === 'string' && raw.street.trim()) addr.street = raw.street.trim().slice(0, 200);
  if (typeof raw.city === 'string' && raw.city.trim()) addr.city = raw.city.trim().slice(0, 120);
  if (typeof raw.state === 'string' && raw.state.trim()) addr.state = raw.state.trim().slice(0, 80);
  if (typeof raw.zip === 'string' && /^\d{5}(-\d{4})?$/.test(raw.zip.trim())) addr.zip = raw.zip.trim();
  if (typeof raw.lat === 'number' && raw.lat >= -90 && raw.lat <= 90) addr.lat = raw.lat;
  if (typeof raw.lon === 'number' && raw.lon >= -180 && raw.lon <= 180) addr.lon = raw.lon;
  return { address: addr };
}
function parseLocationArg(loc) {
  if (loc === undefined || loc === null) return { location: null, error: null };
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { location: null, error: 'location lat/lng must be valid numbers.' };
  }
  return { location: { lat, lng }, error: null };
}

// ---------------------------------------------------------------------------
// Tool handlers. Each returns { status, body, charged, priceUsd }.
// charged=true means ONE credit was spent and priceUsd was earned.
// Nothing else ever charges.
// ---------------------------------------------------------------------------
async function toolDecodeVin(args) {
  const vin = normalizeVin(args.vin ?? '');
  if (!validVin(vin)) {
    return { status: 400, charged: false, body: errBody('invalid_vin', 'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit. No credit charged.') };
  }
  let decoded;
  try { decoded = await decodeVin(vin); }
  catch { return { status: 502, charged: false, body: errBody('upstream_error', 'NHTSA VIN decoder is down. Try again — no credit charged.') }; }
  if (!decoded) {
    return { status: 404, charged: false, body: errBody('vin_not_found', 'VIN looks valid but no vehicle record came back for it. No credit charged.') };
  }
  const { displacementL, ...vehicle } = decoded;
  return {
    status: 200, charged: true, priceUsd: config.pricing.decode,
    body: { vin, vehicle, pricing_tier: 'decode', price_usd: config.pricing.decode },
  };
}

async function toolGetVehicle(args) {
  let vehicle;
  let decoded = null;
  if (args.vin) {
    const vin = normalizeVin(args.vin);
    if (!validVin(vin)) {
      return { status: 400, charged: false, body: errBody('invalid_vin', 'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit. No credit charged.') };
    }
    try { decoded = await decodeVin(vin); }
    catch { return { status: 502, charged: false, body: errBody('upstream_error', 'NHTSA VIN decoder is down. Try again — no credit charged.') }; }
    if (!decoded) {
      return { status: 404, charged: false, body: errBody('vin_not_found', 'VIN looks valid but no vehicle record came back for it. No credit charged.') };
    }
    const { displacementL, ...v } = decoded;
    vehicle = { ...v, vin };
  } else {
    const out = {};
    const err = validateYmm(args, out);
    if (err) return { status: err.status, charged: false, body: errBody(err.code, err.message, { details: { field: err.field } }) };
    vehicle = out;
  }
  const hit = matchCatalog(decoded ?? vehicle);
  return {
    status: 200, charged: true, priceUsd: config.pricing.decode,
    body: {
      vehicle,
      in_catalog: Boolean(hit),
      catalog_range: hit ? (hit.range || String(hit.match.year)) : null,
      categories_available: hit ? Object.keys(hit.categories).filter((c) => hasContent(hit.categories[c])) : [],
      pricing_tier: 'decode', price_usd: config.pricing.decode,
    },
  };
}

async function toolLookupPart(args) {
  // NAGS-only lookup: decode the part number, cross-check the catalog.
  if (args.part && !args.vin && args.year === undefined && !args.make && !args.model) {
    const decoded = decodeNagsPartNumber(String(args.part));
    if (!decoded) {
      return { status: 400, charged: false, body: errBody('invalid_arguments', 'That does not look like a NAGS part number (two-letter prefix + digits, e.g. FW03760 GBY).', { details: { field: 'part' } }) };
    }
    const onFile = [];
    for (const row of catalog.vehicles || []) {
      const glass = row.categories?.exterior?.glass;
      if (!glass) continue;
      for (const [position, entry] of Object.entries(glass)) {
        if (entry && entry.part_number && entry.part_number.toUpperCase().replace(/[\s-]/g, '') === decoded.normalized) {
          onFile.push({ position, vehicle: { make: row.match.make, model: row.match.model, year_range: row.range || String(row.match.year) }, part: entry });
        }
      }
    }
    return { status: 200, charged: false, priceUsd: 0, body: { nags: decoded, on_file: onFile, pricing_tier: 'free', price_usd: 0 } };
  }

  const category = args.category || 'full';
  if (![...CATEGORIES, 'full'].includes(category)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'category must be glass, exterior, interior, engine, mechanical or full.', { details: { field: 'category' } }) };
  }
  const { location, error: locErr } = parseLocationArg(args.location);
  if (locErr) return { status: 400, charged: false, body: errBody('invalid_arguments', locErr, { details: { field: 'location' } }) };

  // Resolve the vehicle: VIN preferred (live NHTSA decode), else YMM.
  let vehicle;
  let decoded = null;
  if (args.vin) {
    const vin = normalizeVin(args.vin);
    if (!validVin(vin)) {
      return { status: 400, charged: false, body: errBody('invalid_vin', 'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit. No credit charged.') };
    }
    try { decoded = await decodeVin(vin); }
    catch { return { status: 502, charged: false, body: errBody('upstream_error', 'NHTSA VIN decoder is down. Try again — no credit charged.') }; }
    if (!decoded) {
      return { status: 404, charged: false, body: errBody('vin_not_found', 'VIN looks valid but no vehicle record came back for it. No credit charged.') };
    }
    const { displacementL, ...v } = decoded;
    vehicle = { ...v, vin };
  } else {
    const out = {};
    const err = validateYmm(args, out);
    if (err) return { status: err.status, charged: false, body: errBody(err.code, err.message, { details: { field: err.field } }) };
    vehicle = out;
  }
  const hit = matchCatalog(decoded ?? vehicle);
  const needs = category === 'full' ? CATEGORIES : [category];

  // ---- Glass: the variant gate. Never guess the exact glass. ----
  if (category === 'glass') {
    if (!args.glass_type || !GLASS_TYPES.includes(args.glass_type)) {
      return { status: 400, charged: false, body: errBody('invalid_arguments', 'glass_type is required when category is glass: WINDSHIELD, BACK_GLASS, DOOR_GLASS, QUARTER_GLASS or VENT_GLASS.', { details: { field: 'glass_type' } }) };
    }
    const position = args.glass_type.toLowerCase();
    const row = hit?.categories?.exterior?.glass?.[position] ?? null;
    const answers = args.variant_answers && typeof args.variant_answers === 'object' ? args.variant_answers : null;
    const answered = answers && ['rain_sensor', 'adas_camera', 'heads_up_display', 'acoustic', 'heated'].some((k) => answers[k] !== undefined);
    if (row && row.part_number && row.variant_status === 'exact') {
      const pricing = priceFor({ hit, needs, location });
      return {
        status: 200, charged: true, priceUsd: pricing.amount,
        body: { vehicle, category: 'glass', glass_type: args.glass_type, variant_status: 'exact', part: row, shop: shopBlock(location), pricing_tier: pricing.tier, price_usd: pricing.amount },
      };
    }
    if (row && row.part_number && row.variant_status === 'needs_confirmation' && answered) {
      const pricing = priceFor({ hit, needs, location });
      return {
        status: 200, charged: true, priceUsd: pricing.amount,
        body: { vehicle, category: 'glass', glass_type: args.glass_type, variant_status: 'exact', part: row, confirmed_from: 'variant_answers', note: 'Confirmed from the customer answers — staff still verify the exact glass on install.', shop: shopBlock(location), pricing_tier: pricing.tier, price_usd: pricing.amount },
      };
    }
    // No exact part: ask the follow-ups, charge nothing.
    const questions = row?.variant_questions?.length ? row.variant_questions : WINDSHIELD_QUESTIONS;
    const why = !hit
      ? 'This vehicle is not in the verified parts catalog yet, so the exact glass cannot be pinned down from the VIN alone.'
      : !row
        ? `No verified ${args.glass_type.toLowerCase().replace('_', ' ')} on file for this vehicle yet.`
        : row.variant_status === 'licensed_required'
          ? 'This part number needs the licensed NAGS feed before it can be confirmed.'
          : 'The exact glass depends on the factory options fitted to this car.';
    return {
      status: 422, charged: false,
      body: {
        error: { code: 'variant_ambiguous', message: `${why} Answer the follow-ups and the exact part can be settled — nothing is guessed. No credit charged.` },
        vehicle, variant_status: row?.variant_status ?? 'not_found',
        ...(row?.part_number ? { candidate_part_number: row.part_number } : {}),
        follow_up: questions,
      },
    };
  }

  // ---- Whole-car / single non-glass category ----
  if (!hit) {
    const pricing = priceFor({ hit, needs, location });
    return {
      status: 200, charged: true, priceUsd: pricing.amount,
      body: { vehicle, variant_status: 'not_found', categories: null, catalog_note: 'Vehicle decoded, but this year/make/model is not in the parts catalog yet. Categories return null — parts are never guessed.', shop: shopBlock(location), pricing_tier: pricing.tier, price_usd: pricing.amount },
    };
  }
  const categories = pickCategories(hit, needs);
  const requested = needs.filter((c) => c !== 'location');
  const anyContent = requested.some((c) => {
    if (c === 'glass') return hasContent(hit.categories?.exterior?.glass);
    return hasContent(hit.categories?.[c]);
  });
  if (!anyContent) {
    // Layer 4 convention: vehicle IS in the catalog but every requested
    // category is entirely empty — no verified data and no follow-up
    // questions, so no follow-up path exists.
    return {
      status: 422, charged: false,
      body: {
        error: { code: 'variant_ambiguous', message: `No verified data for ${requested.join(', ')} on this vehicle yet, and no follow-up questions can settle it. Send the trim, a door-jamb photo, or the exact part position. No credit charged.` },
        vehicle, variant_status: 'not_found', requested_categories: requested,
      },
    };
  }
  const pricing = priceFor({ hit, needs, location });
  return {
    status: 200, charged: true, priceUsd: pricing.amount,
    body: { vehicle, categories, shop: shopBlock(location), pricing_tier: pricing.tier, price_usd: pricing.amount },
  };
}

async function toolQuote(args) {
  if (!args.glass_type || !GLASS_TYPES.includes(args.glass_type)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'glass_type is required: WINDSHIELD, BACK_GLASS, DOOR_GLASS, QUARTER_GLASS or VENT_GLASS.', { details: { field: 'glass_type' } }) };
  }
  let vehicle;
  if (args.vin) {
    const vin = normalizeVin(args.vin);
    if (!validVin(vin)) {
      return { status: 400, charged: false, body: errBody('invalid_vin', 'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit.') };
    }
    let decoded;
    try { decoded = await decodeVin(vin); }
    catch { return { status: 502, charged: false, body: errBody('upstream_error', 'NHTSA VIN decoder is down. Try again.') }; }
    if (!decoded) {
      return { status: 404, charged: false, body: errBody('vin_not_found', 'VIN looks valid but no vehicle record came back for it.') };
    }
    const { displacementL, ...v } = decoded;
    vehicle = { ...v, vin };
  } else {
    const out = {};
    const err = validateYmm(args, out);
    if (err) return { status: err.status, charged: false, body: errBody(err.code, err.message, { details: { field: err.field } }) };
    vehicle = out;
  }
  const ranges = config.customer_quote_ranges || {};
  const isWindshield = args.glass_type === 'WINDSHIELD';
  const typical = isWindshield ? ranges.windshield_usd ?? null : null;
  return {
    status: 200, charged: false, priceUsd: 0,
    body: {
      vehicle, glass_type: args.glass_type,
      typical_range_usd: typical,
      recalibration_usd: isWindshield ? (ranges.recalibration_usd ?? null) : null,
      recalibration_note: isWindshield ? 'Only if the car has a forward camera / ADAS behind the windshield.' : null,
      note: typical
        ? 'Typical range, not a final price. R&R reviews the request and texts a firm quote — the customer approves before any work or charge.'
        : 'No typical range on file for this glass position yet — R&R will text a firm quote after review.',
      pricing_tier: 'free', price_usd: 0,
    },
  };
}

// Case Core proxy: the gateway fronts apps/api instead of re-implementing
// the case engine. create_case mirrors POST /api/v1/public/intake
// (multipart, no photo bytes through the gateway — photos go through the
// web intake) and get_case_status mirrors GET /api/v1/public/intake-status.
function caseApiHeaders() {
  const h = {};
  if (VERCEL_BYPASS) h['x-vercel-protection-bypass'] = VERCEL_BYPASS;
  return h;
}
async function toolCreateCase(args, keyCfg, ip) {
  const rl = checkCreateCaseRate(keyCfg, ip);
  if (rl.limited) {
    return { status: 429, charged: false, retryAfter: rl.retryAfter, body: errBody('rate_limited', `Too many cases from this key. Try again in ${rl.retryAfter}s.`) };
  }
  if (!isNonEmptyString(args.customer_name) || args.customer_name.trim().length < 2 || args.customer_name.trim().length > 120) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'customer_name must be 2-120 characters.', { details: { field: 'customer_name' } }) };
  }
  if (!normalizeUsPhone(args.customer_phone)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'Enter a valid 10-digit US mobile number so we can text your quote.', { details: { field: 'customer_phone' } }) };
  }
  if (!args.glass_type || !GLASS_TYPES.includes(args.glass_type)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'glass_type must be WINDSHIELD, BACK_GLASS, DOOR_GLASS, QUARTER_GLASS or VENT_GLASS.', { details: { field: 'glass_type' } }) };
  }
  if (args.note !== undefined && (typeof args.note !== 'string' || args.note.trim().length > 1000)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'note must be at most 1000 characters.', { details: { field: 'note' } }) };
  }
  const { address, error: addrErr } = validateServiceAddress(args.service_address);
  if (addrErr) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', addrErr, { details: { field: 'service_address' } }) };
  }
  let vin = null;
  if (args.vin) {
    if (!validVin(String(args.vin))) {
      return { status: 400, charged: false, body: errBody('invalid_vin', 'That VIN doesn\'t look right — check the 17 characters and try again, or enter the vehicle\'s year, make and model instead.', { details: { field: 'vin' } }) };
    }
    vin = normalizeVin(args.vin);
  }
  const ymm = {};
  let ymmErr = null;
  if (!vin) {
    // No VIN: the intake requires a full year/make/model.
    ymmErr = validateYmm(args, ymm);
  } else if (args.year !== undefined && args.make && args.model) {
    // VIN + fully-specified YMM: the YMM must still be valid.
    ymmErr = validateYmm(args, ymm);
  } else if (args.year !== undefined || args.make || args.model) {
    // VIN + partial YMM: the intake decodes the VIN to fill the gaps,
    // so forward only the pieces the caller gave.
    if (args.year !== undefined) ymm.year = Number(args.year);
    if (typeof args.make === 'string') ymm.make = args.make.trim();
    if (typeof args.model === 'string') ymm.model = args.model.trim();
  }
  if (ymmErr) {
    return { status: ymmErr.status, charged: false, body: errBody(ymmErr.code, ymmErr.message, { details: { field: ymmErr.field } }) };
  }
  // Forward to Case Core. Channel/state are pinned server-side by the
  // intake itself (DIRECT / REQUEST_RECEIVED) — never taken from the call.
  const form = new FormData();
  form.append('customer_name', args.customer_name.trim());
  form.append('customer_phone', args.customer_phone.trim());
  form.append('glass_type', args.glass_type);
  if (args.note) form.append('note', args.note.trim());
  if (vin) form.append('vin', vin);
  if (ymm.year !== undefined) form.append('year', String(ymm.year));
  if (ymm.make) form.append('make', ymm.make);
  if (ymm.model) form.append('model', ymm.model);
  form.append('service_address', JSON.stringify(address));
  let upstream;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    upstream = await fetch(`${CASE_API_URL}/api/v1/public/intake`, { method: 'POST', headers: caseApiHeaders(), body: form, signal: ctrl.signal });
    clearTimeout(t);
  } catch {
    return { status: 502, charged: false, body: errBody('upstream_error', 'The case system is unreachable right now — your request was not created. Try again in a moment.') };
  }
  let payload = null;
  try { payload = await upstream.json(); } catch { payload = null; }
  if (upstream.status !== 201 || !payload?.ok) {
    const msg = payload?.error?.message || `Case system answered HTTP ${upstream.status}.`;
    return { status: 502, charged: false, body: errBody('upstream_error', `${msg} Your request was not created. The staging database was paused (free Supabase plan, 7 days idle) and is being restored — retry once it is healthy, or call R&R at 857-266-1284.`) };
  }
  return {
    status: 201, charged: false, priceUsd: 0,
    body: { reference: payload.reference, status_token: payload.status_token, message: payload.message, pricing_tier: 'free', price_usd: 0 },
  };
}

async function toolGetCaseStatus(args) {
  const token = typeof args.status_token === 'string' ? args.status_token.trim() : '';
  if (!token) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'status_token is required.', { details: { field: 'status_token' } }) };
  }
  let upstream;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    upstream = await fetch(`${CASE_API_URL}/api/v1/public/intake-status/${encodeURIComponent(token)}`, { headers: caseApiHeaders(), signal: ctrl.signal });
    clearTimeout(t);
  } catch {
    return { status: 502, charged: false, body: errBody('upstream_error', 'The case system is unreachable right now — try again in a moment.') };
  }
  let payload = null;
  try { payload = await upstream.json(); } catch { payload = null; }
  if (upstream.status !== 200 || !payload) {
    if (upstream.status === 404 || upstream.status === 401) {
      return { status: 404, charged: false, body: errBody('invalid_status_token', 'That status link is not valid or has expired. Call R&R and we will look it up.') };
    }
    return { status: 502, charged: false, body: errBody('upstream_error', `Case system answered HTTP ${upstream.status}. Try again in a moment.`) };
  }
  return { status: 200, charged: false, priceUsd: 0, body: { ...payload, pricing_tier: 'free', price_usd: 0 } };
}

async function toolOrderGlass(args, keyCfg) {
  // Staff-only, spend-capped, paid MyGrant lookup — every gate runs
  // before any supplier call, and a failed lookup never charges.
  if (keyCfg.role !== 'staff') {
    return { status: 403, charged: false, body: errBody('forbidden', 'order_glass is staff-only. Use a staff-role API key.') };
  }
  if (!args.vin || !validVin(String(args.vin))) {
    return { status: 400, charged: false, body: errBody('invalid_vin', 'VIN must be 17 characters (letters and digits, no I, O, or Q) with a correct check digit.', { details: { field: 'vin' } }) };
  }
  if (!args.glass_type || !GLASS_TYPES.includes(args.glass_type)) {
    return { status: 400, charged: false, body: errBody('invalid_arguments', 'glass_type must be WINDSHIELD, BACK_GLASS, DOOR_GLASS, QUARTER_GLASS or VENT_GLASS.', { details: { field: 'glass_type' } }) };
  }
  const costUsd = config.mygrant?.vin_lookup_cost_usd ?? 1;
  const capUsd = config.mygrant?.daily_spend_cap_usd ?? 10;
  if (mygrantSpend.date !== dayKey()) { mygrantSpend.date = dayKey(); mygrantSpend.usd = 0; }
  if (mygrantSpend.usd + costUsd > capUsd) {
    return { status: 402, charged: false, body: errBody('mygrant_spend_cap_reached', `Daily MyGrant spend cap reached ($${mygrantSpend.usd.toFixed(2)} of $${capUsd.toFixed(2)} spent today). No lookup was run and nothing was charged.`) };
  }
  // Live MyGrant session is not wired in this standalone build — the real
  // provider lives in apps/api/src/mygrant.ts (browser session). Enforce
  // the gates, then say so plainly instead of pretending an order happened.
  return {
    status: 503, charged: false,
    body: errBody('mygrant_not_configured', 'MyGrant ordering is not wired to a live MyGrant session in this build. The staff key, VIN and spend-cap checks all passed; to wire it, run the gateway alongside apps/api with its MyGrant provider (see gateway/README.md). No lookup was run and nothing was charged.'),
  };
}

// Allowed argument keys per tool — everything else is stripped.
const TOOL_ARGS = {
  decode_vin: ['vin'],
  get_vehicle: ['vin', 'year', 'make', 'model'],
  lookup_part: ['vin', 'year', 'make', 'model', 'category', 'glass_type', 'part', 'location', 'variant_answers'],
  quote: ['vin', 'year', 'make', 'model', 'glass_type'],
  create_case: ['customer_name', 'customer_phone', 'glass_type', 'note', 'vin', 'year', 'make', 'model', 'service_address'],
  get_case_status: ['status_token'],
  order_glass: ['vin', 'glass_type'],
};
// Tools that may spend a credit (quota gate applies). Free tools skip it
// so a customer can always check a case status or get a quote.
const CHARGING_TOOLS = new Set(['decode_vin', 'get_vehicle', 'lookup_part']);
const TOOL_HANDLERS = {
  decode_vin: (a, k, ip) => toolDecodeVin(a),
  get_vehicle: (a, k, ip) => toolGetVehicle(a),
  lookup_part: (a, k, ip) => toolLookupPart(a),
  quote: (a, k, ip) => toolQuote(a),
  create_case: (a, k, ip) => toolCreateCase(a, k, ip),
  get_case_status: (a, k, ip) => toolGetCaseStatus(a),
  order_glass: (a, k, ip) => toolOrderGlass(a, k),
};

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
  } catch { vpicCache = { at: Date.now(), status: 'degraded' }; }
  return vpicCache.status;
}

const startedAt = Date.now();
const TOOL_NAMES = (toolDefs.tools || []).map((t) => t.name);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathParts = url.pathname.split('/').filter(Boolean);
  console.log(`${req.method} ${url.pathname}`);

  try {
    // Root — service pointer (no auth).
    if (pathParts.length === 0) {
      return send(res, 200, {
        service: 'R&R Brain Gateway',
        version: VERSION,
        docs: 'See gateway/README.md in repo jonly03/rnr-workflow, branch gateway/brain-door.',
        endpoints: ['POST /brain', 'GET /brain/health', 'GET /brain/tools'],
        channels: CHANNELS,
      });
    }

    // Health — public, no key (so Lou can check the service is up first).
    if (pathParts[0] === 'brain' && pathParts[1] === 'health' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        service: 'rr-brain-gateway',
        version: VERSION,
        pricing_version: VERSION,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        vpic: await vpicStatus(),
        catalog_vehicles: (catalog.vehicles || []).length,
        tools: TOOL_NAMES,
        case_api_configured: Boolean(CASE_API_URL),
        timestamp: new Date().toISOString(),
      });
    }

    // MCP tool definitions — public, no key (clients list tools first).
    if (pathParts[0] === 'brain' && pathParts[1] === 'tools' && req.method === 'GET') {
      return send(res, 200, { tools: toolDefs.tools || [], version: VERSION });
    }

    if (pathParts[0] !== 'brain' || pathParts.length !== 1 || req.method !== 'POST') {
      return send(res, 404, errBody('not_found', 'Unknown route.'));
    }

    // ---- POST /brain: the one door ----
    const started = Date.now();
    const requestId = crypto.randomUUID();
    let body;
    try { body = await readJsonBody(req); }
    catch (e) {
      return send(res, 400, errBody('invalid_request', e.message === 'invalid json' ? 'Request body must be valid JSON.' : e.message));
    }
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const channel = typeof body.channel === 'string' ? body.channel : 'web';
    const clientRequestId = typeof body.request_id === 'string' ? body.request_id : requestId;
    const rawArgs = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};

    const finish = (status, payload, keyCfg, chargedUsd, errorCode, extraHeaders = {}) => {
      audit({
        request_id: clientRequestId, channel, tool: tool || null,
        key_label: keyCfg ? (keyCfg.label || keyCfg.key) : 'unknown',
        http_status: status, error_code: errorCode || null,
        charged_usd: chargedUsd, duration_ms: Date.now() - started,
        arguments: redactArgs(tool, rawArgs),
      });
      return send(res, status, payload, extraHeaders);
    };

    // Auth: X-API-Key, then per-key rate limit. Quota is checked only for
    // charging tools (below) so free tools always work.
    const key = req.headers['x-api-key'];
    const keyCfg = (config.keys || []).find((k) => k.key === key);
    if (!keyCfg) {
      return finish(401, errBody('invalid_api_key', 'Missing or bad API key.'), null, 0, 'invalid_api_key');
    }
    const rl = checkRate(keyCfg);
    if (rl.limited) {
      return finish(429, errBody('rate_limited', `Too many requests for this key. Try again in ${rl.retryAfter}s.`), keyCfg, 0, 'rate_limited', { 'Retry-After': String(rl.retryAfter) });
    }
    if (!CHANNELS.includes(channel)) {
      return finish(400, errBody('invalid_arguments', 'channel must be web, whatsapp, siri or phone.'), keyCfg, 0, 'invalid_arguments');
    }
    if (!tool || !TOOL_HANDLERS[tool]) {
      return finish(400, errBody('unknown_tool', `Unknown tool "${tool}". See GET /brain/tools. Tools: ${TOOL_NAMES.join(', ')}.`), keyCfg, 0, 'unknown_tool');
    }
    if (CHARGING_TOOLS.has(tool) && creditsRemaining(keyCfg) <= 0) {
      return finish(402, errBody('out_of_credits', 'Monthly quota used up for this key.', { credits_remaining: 0 }), keyCfg, 0, 'out_of_credits');
    }

    const args = stripUnknown(rawArgs, TOOL_ARGS[tool]);
    const out = await TOOL_HANDLERS[tool](args, keyCfg, req.socket.remoteAddress || 'unknown');
    const chargedUsd = out.charged ? (out.priceUsd ?? 0) : 0;
    if (out.charged) charge(keyCfg, 1);
    const remaining = creditsRemaining(keyCfg);
    const usageBlock = { credits_used: out.charged ? 1 : 0, credits_remaining: remaining, charged_usd: chargedUsd };

    if (out.status >= 200 && out.status < 300) {
      const payload = { ok: true, tool, channel, request_id: clientRequestId, result: out.body, usage: usageBlock };
      return finish(out.status, payload, keyCfg, chargedUsd, null);
    }
    const payload = { ok: false, tool, channel, request_id: clientRequestId, ...out.body, usage: usageBlock };
    if (out.retryAfter) return finish(out.status, payload, keyCfg, 0, out.body?.error?.code || null, { 'Retry-After': String(out.retryAfter) });
    return finish(out.status, payload, keyCfg, 0, out.body?.error?.code || null);
  } catch (e) {
    console.error(e);
    return send(res, 500, errBody('internal_error', 'Something went wrong. No credit charged.'));
  }
});

server.listen(PORT, () => {
  console.log(`R&R Brain Gateway ${VERSION} listening on http://127.0.0.1:${PORT}`);
  console.log(`Tools: ${TOOL_NAMES.join(', ')} (POST /brain, GET /brain/tools)`);
  console.log(`Catalog: ${(catalog.vehicles || []).length} vehicles from data/catalog.json`);
  console.log(`Pricing: decode $${config.pricing.decode} / decode+glass $${config.pricing.decodeGlass} / full vehicle $${config.pricing.fullVehicle} / location +$${config.pricing.locationAddon} (config/pricing.json)`);
  console.log(`Case API: ${CASE_API_URL}${VERCEL_BYPASS ? ' (Vercel bypass set)' : ''} — wall OFF since 2026-11-13 23:30 EST; staging DB restoration confirmed healthy 23:47 EST, create_case/get_case_status proxy live (502 upstream_error only if it goes down again)`);
  console.log('Demo key: rr-demo (25/month). Staff key: rr-staff. Low-quota test key: rr-test-low (quota 1). Rate test key: rr-test-rate (5/min).');
});
