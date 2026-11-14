// R&R VIN API — Layer 2 MVP (standalone, browser-side lookup)
// Reuses, does not rewrite:
//  - API_SPEC.md v0.2 (response shape, error cases, variant rules)
//  - catalog.json (demo-vehicles.json v0.2: 4 vehicles, 37 part rows)
//  - The prototype api/lookup.js flow: validate VIN -> NHTSA vPIC decode
//    -> match decoded vehicle against the verified catalog -> whole-car
//    categories (exterior, interior, engine, mechanical).
//  - The repo's apps/api/src/vin-decode.ts approach (NHTSA DecodeVinValues,
//    year/make/model/trim) and its VIN character rules (no I, O, Q).
//  - Pricing comes from config.json, never hardcoded here.
//
// Rules enforced here, same as the spec:
//  - A part variant is NEVER guessed. VIN + trim can't settle it ->
//    variant_status "needs_confirmation" / "variant_ambiguous" with
//    follow-up questions. A door-jamb label photo can settle tires.
//  - Unverified parts return null. price_range / availability return null
//    until a supplier feed exists.
//  - Failed / invalid / not-found lookups never charge a credit (and this
//    MVP charges nothing at all — it only quotes the tier price).
//  - Never return a customer's name, address, or phone from a VIN.
//
// This module is dependency-free and runs in the browser and in Node
// (tests import the pure functions). Browser wiring runs only when
// `document` exists.

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // 17 chars, no I/O/Q

export const CATEGORIES = ['glass', 'exterior', 'interior', 'engine', 'mechanical'];

export class LookupError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'LookupError';
    this.status = status;
    this.code = code;
  }
}

/** Validate format only. The check digit is verified by NHTSA's response. */
export function validateVin(raw) {
  const vin = String(raw || '').trim().toUpperCase();
  if (!VIN_RE.test(vin)) {
    throw new LookupError(
      400,
      'invalid_vin',
      'VIN must be 17 characters (letters and digits, no I, O, or Q). No credit charged.'
    );
  }
  return vin;
}

/** Decode a VIN with NHTSA vPIC. Returns the vehicle block from the spec. */
export async function decodeVin(vin, endpoint, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${endpoint}/${encodeURIComponent(vin)}?format=json`);
  } catch (e) {
    throw new LookupError(502, 'upstream_error', 'Could not reach the NHTSA VIN decoder. Try again — no credit charged.');
  }
  if (!res.ok) {
    throw new LookupError(502, 'upstream_error', `NHTSA VIN decoder is down (HTTP ${res.status}). Try again — no credit charged.`);
  }
  const data = await res.json();
  const decoded = data.Results?.[0];
  if (!decoded || decoded.ErrorCode !== '0' || !decoded.Make) {
    throw new LookupError(
      404,
      'vin_not_found',
      `No vehicle record came back for this VIN (${decoded?.ErrorText || 'decoder error'}). No credit charged.`
    );
  }
  const engineParts = [
    decoded.DisplacementL ? `${Number(decoded.DisplacementL).toFixed(1)}L` : null,
    decoded.EngineCylinders ? `${decoded.EngineCylinders}-cyl` : null,
  ].filter(Boolean);
  return {
    year: Number(decoded.ModelYear),
    make: decoded.Make,
    model: decoded.Model,
    trim: decoded.Trim || null,
    body: decoded.BodyClass || null,
    engine: engineParts.join(' ') || null,
    engine_displacement_l: decoded.DisplacementL ? Number(decoded.DisplacementL) : null,
    fuel: decoded.FuelTypePrimary || null,
    transmission: decoded.TransmissionStyle || null,
    drive: decoded.DriveType || null,
    doors: decoded.Doors ? Number(decoded.Doors) : null,
  };
}

/** Pull the displacement number (e.g. 3.5) out of a catalog engine string like "3.5L V6". */
export function catalogDisplacement(engineStr) {
  if (!engineStr) return null;
  const m = String(engineStr).match(/(\d+(?:\.\d+)?)\s*L/i);
  return m ? Number(m[1]) : null;
}

/**
 * Match a decoded vehicle against the verified catalog.
 * Year + make + model must match; when the catalog entry states an engine,
 * the decoded displacement must agree. Returns the entry or null.
 * A null match is not an error — the vehicle decoded, it just isn't in the
 * parts catalog yet, so categories return null and are never guessed.
 */
export function matchCatalog(vehicle, catalog) {
  const vehicles = catalog?.vehicles || [];
  return (
    vehicles.find((entry) => {
      const m = entry.match || {};
      if (m.year !== vehicle.year) return false;
      if (String(m.make || '').toLowerCase() !== String(vehicle.make || '').toLowerCase()) return false;
      if (String(m.model || '').toLowerCase() !== String(vehicle.model || '').toLowerCase()) return false;
      const want = catalogDisplacement(m.engine);
      if (want != null && vehicle.engine_displacement_l != null && want !== vehicle.engine_displacement_l) return false;
      return true;
    }) || null
  );
}

/** Filter categories by the requested `needs` list (default: all). */
export function pickCategories(entry, needs) {
  if (!entry) return null;
  const wanted = needs && needs.length ? needs : CATEGORIES;
  const out = {};
  for (const cat of ['exterior', 'interior', 'engine', 'mechanical']) {
    if (wanted.includes(cat) || (cat === 'exterior' && wanted.includes('glass'))) {
      out[cat] = entry.categories[cat];
      if (cat === 'exterior' && wanted.includes('glass') && !wanted.includes('exterior')) {
        out[cat] = { glass: entry.categories.exterior.glass };
      }
    }
  }
  return out;
}

/**
 * Tier price for a lookup, computed from config — never hardcoded.
 * decode only -> decode; glass (or exterior) requested -> decode_glass;
 * all four categories -> full_vehicle; location adds location_addon.
 */
export function tierFor(needs, config) {
  const p = config?.pricing || {};
  const wanted = needs && needs.length ? needs : CATEGORIES;
  const hasLocation = wanted.includes('location');
  const core = wanted.filter((n) => n !== 'location');
  const allFour = ['exterior', 'interior', 'engine', 'mechanical'].every((c) => core.includes(c));
  let tier = 'decode';
  let price = p.decode ?? null;
  if (allFour) {
    tier = 'full_vehicle';
    price = p.full_vehicle ?? null;
  } else if (core.includes('glass') || core.includes('exterior')) {
    tier = 'decode_glass';
    price = p.decode_glass ?? null;
  }
  if (hasLocation && price != null && p.location_addon != null) price = +(price + p.location_addon).toFixed(2);
  return { tier, price, currency: p.currency || 'USD' };
}

/**
 * Apply door-jamb label data to a lookup result. A confirmed tire size from
 * the label settles the tires variant (was variant_ambiguous); pressures,
 * GVWR and build date land in a dedicated door_jamb section. Nothing is
 * filled when the label didn't yield it — null stays null.
 */
export function applyDoorJamb(result, doorJamb) {
  if (!doorJamb) return result;
  const dj = {
    vin_from_label: doorJamb.vin || null,
    tire_size_front: doorJamb.tires?.front || null,
    tire_size_rear: doorJamb.tires?.rear || null,
    tire_pressure_psi_front: doorJamb.pressures_psi?.front ?? null,
    tire_pressure_psi_rear: doorJamb.pressures_psi?.rear ?? null,
    gvwr_lbs: doorJamb.gvwr_lbs ?? null,
    build_date: doorJamb.build_date || null,
    source: doorJamb.source || 'door-jamb label photo',
  };
  result.door_jamb = dj;
  if (result.categories?.exterior?.tires && dj.tire_size_front) {
    const t = result.categories.exterior.tires;
    const size = dj.tire_size_rear && dj.tire_size_rear !== dj.tire_size_front
      ? `${dj.tire_size_front} front / ${dj.tire_size_rear} rear`
      : dj.tire_size_front;
    result.categories.exterior.tires = {
      ...t,
      size,
      variant_status: 'confirmed',
      variant_questions: [],
      source: dj.source,
    };
  }
  return result;
}

/** Full lookup: validate -> decode -> match -> categories -> tier quote. */
export async function lookupVin(rawVin, { needs, catalog, config, doorJamb, fetchFn = fetch } = {}) {
  const vin = validateVin(rawVin);
  const endpoint = config?.nhtsa?.endpoint || 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
  const vehicle = await decodeVin(vin, endpoint, fetchFn);
  const entry = matchCatalog(vehicle, catalog);
  const result = {
    vin,
    vehicle: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim,
      body: vehicle.body,
      engine: vehicle.engine,
      fuel: vehicle.fuel,
      transmission: vehicle.transmission,
      drive: vehicle.drive,
      doors: vehicle.doors,
    },
    categories: pickCategories(entry, needs),
    catalog_note: entry
      ? undefined
      : 'Vehicle decoded, but this year/make/model is not in the parts catalog yet. Categories return null — parts are never guessed.',
    shop: config?.shop || undefined,
    quote: tierFor(needs, config),
    credits_used: 0,
    demo_note: 'MVP demo — no charge. The quote is the draft tier price from config.json.',
  };
  return applyDoorJamb(result, doorJamb);
}

// ---------------------------------------------------------------------------
// Browser wiring (index.html). Skipped under Node so tests can import this.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const state = { catalog: null, config: null, lastResult: null, doorJamb: null };

  async function loadData() {
    const [cat, cfg] = await Promise.all([
      fetch('catalog.json').then((r) => r.json()),
      fetch('config.json').then((r) => r.json()),
    ]);
    state.catalog = cat;
    state.config = cfg;
    renderPricing();
  }

  function renderPricing() {
    const p = state.config?.pricing || {};
    const fmt = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
    const el = $('pricing');
    if (!el) return;
    el.innerHTML =
      `<div class="price-row"><span>Decode only</span><b>${fmt(p.decode)}</b></div>` +
      `<div class="price-row"><span>Decode + glass</span><b>${fmt(p.decode_glass)}</b></div>` +
      `<div class="price-row"><span>Full vehicle (all four categories)</span><b>${fmt(p.full_vehicle)}</b></div>` +
      `<div class="price-row"><span>Location add-on</span><b>+${fmt(p.location_addon)}</b></div>` +
      `<p class="muted">Draft pricing from config.json — Pedro sets the number. Free trial: ${p.free_trial_lookups_per_month ?? '—'} lookups / month. Nothing is charged in this demo.</p>`;
  }

  function badge(status) {
    const map = {
      exact: ['ok', 'confirmed'],
      confirmed: ['ok', 'confirmed'],
      needs_confirmation: ['warn', 'needs confirmation'],
      variant_ambiguous: ['warn', 'variant ambiguous'],
      licensed_required: ['dim', 'license required'],
    };
    const [cls, label] = map[status] || ['dim', status || 'not verified'];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function partRow(name, part) {
    if (part == null) return `<tr><td>${name}</td><td class="muted">not verified</td><td></td><td></td></tr>`;
    const pn = part.part_number || '—';
    const extra = part.note || part.type || part.viscosity || part.size || part.group || '';
    const qs = (part.variant_questions || []).map((q) => `<li>${q}</li>`).join('');
    return `<tr><td>${name}</td><td><b>${pn}</b>${extra ? `<div class="muted">${extra}</div>` : ''}</td><td>${badge(part.variant_status)}</td><td>${part.source || ''}${qs ? `<ul class="qs">${qs}</ul>` : ''}</td></tr>`;
  }

  function renderResult(r) {
    const v = r.vehicle;
    const cats = r.categories || {};
    const glass = cats.exterior?.glass || {};
    const eng = cats.engine || {};
    const mech = cats.mechanical || {};
    const inter = cats.interior || {};
    const dj = r.door_jamb;
    const sec = (title, rows) =>
      rows.length ? `<h3>${title}</h3><table><tr><th>Part</th><th>Part number</th><th>Variant</th><th>Source / follow-up</th></tr>${rows.join('')}</table>` : '';
    $('result').innerHTML =
      `<div class="card"><h2>${v.year} ${v.make} ${v.model}${v.trim ? ` — ${v.trim}` : ''}</h2>` +
      `<p class="muted">VIN ${r.vin} · ${v.body || ''} · ${v.engine || ''} · ${v.fuel || ''} · ${v.drive || ''}</p>` +
      (r.catalog_note ? `<p class="warn-box">${r.catalog_note}</p>` : '') +
      `<p>Quote for this lookup: <b>${r.quote.tier.replace(/_/g, ' ')}</b> — ${r.quote.price == null ? '—' : `$${Number(r.quote.price).toFixed(2)} ${r.quote.currency}`} <span class="muted">(demo, no charge)</span></p></div>` +
      sec('Exterior — glass', [
        partRow('Windshield', glass.windshield),
        partRow('Back glass', glass.back_glass),
        partRow('Door glass', glass.door_glass),
        partRow('Quarter glass', glass.quarter_glass),
        partRow('Vent glass', glass.vent_glass),
      ]) +
      sec('Exterior — tires & wipers', [
        partRow('Tires', cats.exterior?.tires),
        partRow('Wipers', cats.exterior?.wipers ? { part_number: cats.exterior.wipers.part_numbers || `${cats.exterior.wipers.driver_in || ''} / ${cats.exterior.wipers.passenger_in || ''}`, source: cats.exterior.wipers.source } : null),
      ]) +
      sec('Interior', [partRow('Cabin filter', inter.cabin_filter)]) +
      sec('Engine', [
        partRow('Oil', eng.oil ? { part_number: `${eng.oil.viscosity || ''} · ${eng.oil.capacity_qt ?? eng.oil.capacity_gal ?? ''} ${eng.oil.capacity_qt ? 'qt' : eng.oil.capacity_gal ? 'gal' : ''}`, source: eng.oil.source, note: eng.oil.capacity_note } : null),
        partRow('Oil filter', eng.oil_filter),
        partRow('Air filter', eng.air_filter),
        partRow('Spark plugs', eng.spark_plugs),
        partRow('Coolant', eng.coolant),
        partRow('Transmission fluid', eng.transmission_fluid),
        partRow('Battery', eng.battery),
      ]) +
      sec('Mechanical — brakes', [
        partRow('Front pads', mech.brakes?.front_pads),
        partRow('Front rotors', mech.brakes?.front_rotors),
      ]) +
      (dj ? `<h3>Door-jamb label</h3><table><tr><th>Field</th><th>Value</th><th>Source</th></tr>` +
        `<tr><td>Tire size (front)</td><td>${dj.tire_size_front || '—'}</td><td>${dj.source}</td></tr>` +
        `<tr><td>Tire size (rear)</td><td>${dj.tire_size_rear || '—'}</td><td>${dj.source}</td></tr>` +
        `<tr><td>Tire pressure front / rear</td><td>${dj.tire_pressure_psi_front ?? '—'} / ${dj.tire_pressure_psi_rear ?? '—'} PSI</td><td>${dj.source}</td></tr>` +
        `<tr><td>GVWR</td><td>${dj.gvwr_lbs ? `${dj.gvwr_lbs.toLocaleString()} lbs` : '—'}</td><td>${dj.source}</td></tr>` +
        `<tr><td>Build date</td><td>${dj.build_date || '—'}</td><td>${dj.source}</td></tr></table>` : '') +
      `<details><summary>Raw JSON</summary><pre>${JSON.stringify(r, null, 2)}</pre></details>`;
  }

  function needs() {
    return [...document.querySelectorAll('input[name="needs"]:checked')].map((el) => el.value);
  }

  function readDoorJambFields() {
    // Manual door-jamb fields (index.html). OCR fills them; the user can
    // correct them. Manual values win over OCR; source says so.
    const val = (id) => { const el = document.getElementById(id); return el && el.value.trim() ? el.value.trim() : null; };
    const num = (id) => { const v = val(id); return v == null ? null : Number(v); };
    const ocr = window.__doorJamb || null;
    const manual = {
      tires: { front: val('dj-tire-front'), rear: val('dj-tire-rear') },
      pressures_psi: { front: num('dj-pressure-front'), rear: num('dj-pressure-rear') },
      gvwr_lbs: num('dj-gvwr'),
      build_date: val('dj-build-date'),
      vin: val('dj-vin'),
    };
    const anyManual = Object.values(manual.tires).some(Boolean) || Object.values(manual.pressures_psi).some((v) => v != null) || manual.gvwr_lbs != null || manual.build_date || manual.vin;
    if (!ocr && !anyManual) return null;
    if (!ocr) return { ...manual, source: 'manual entry (door-jamb label)' };
    const edited = manual.tires.front || manual.tires.rear || manual.build_date || manual.vin || manual.pressures_psi.front != null || manual.pressures_psi.rear != null || manual.gvwr_lbs != null;
    return {
      vin: manual.vin || ocr.vin,
      tires: {
        front: manual.tires.front || ocr.tires.front,
        rear: manual.tires.rear || ocr.tires.rear,
        all: ocr.tires.all || [],
      },
      pressures_psi: {
        front: manual.pressures_psi.front ?? ocr.pressures_psi.front,
        rear: manual.pressures_psi.rear ?? ocr.pressures_psi.rear,
      },
      gvwr_lbs: manual.gvwr_lbs ?? ocr.gvwr_lbs,
      build_date: manual.build_date || ocr.build_date,
      source: edited ? 'door-jamb label photo (checked by hand)' : 'door-jamb label photo',
    };
  }

  async function runLookup() {
    const out = $('result');
    const err = $('error');
    err.textContent = '';
    out.innerHTML = '<p class="muted">Decoding…</p>';
    try {
      const r = await lookupVin($('vin').value, { needs: needs(), catalog: state.catalog, config: state.config, doorJamb: readDoorJambFields() });
      state.lastResult = r;
      renderResult(r);
    } catch (e) {
      out.innerHTML = '';
      err.textContent = e.code ? `${e.code}: ${e.message}` : `Error: ${e.message}`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadData().catch((e) => { $('error').textContent = `Could not load catalog/config: ${e.message}`; });
    $('lookup-form').addEventListener('submit', (ev) => { ev.preventDefault(); runLookup(); });
    document.querySelectorAll('[data-vin]').forEach((b) =>
      b.addEventListener('click', () => { $('vin').value = b.dataset.vin; runLookup(); })
    );
  });
}
