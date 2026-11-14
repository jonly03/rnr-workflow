// R&R VIN API — Layer 2 MVP: door-jamb label reader
// Reuses the repo's apps/api/src/vin-ocr.ts approach: Tesseract OCR, and the
// same VIN normalization (O is never valid in a VIN -> treat as 0;
// I and Q are never valid -> treat as 1). The server module extracts a VIN
// from a dashboard/registration photo; this module reads a driver door-jamb
// label, which is what settles tires: tire size, cold pressures, GVWR,
// build date — plus the VIN printed on the same label.
//
// Rules, same as the rest of the MVP: OCR output is a *candidate*. Nothing
// the label didn't yield is filled in — a field the parsers can't find
// stays null, and the page offers manual entry with a clear source label
// ("manual entry (door-jamb label)"). Nothing is guessed.
//
// Browser OCR loads Tesseract.js from a CDN at first use (the server-side
// module bundles tessdata locally; the standalone page has no server, so the
// CDN is the standalone equivalent). If the CDN is unreachable, the page
// falls back to manual entry — the lookup still works without the photo.
//
// Pure parsers are exported for the Node tests; browser wiring runs only
// when `document` exists.

const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/;

/** Same normalization as apps/api/src/vin-ocr.ts extractVinCandidate. */
export function extractVinCandidate(text) {
  const normalized = String(text || '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IQ]/g, '1');
  const match = normalized.match(VIN_RE);
  return match ? match[0] : null;
}

/** Tire sizes: P245/75R16, 245/35 ZR19, 265/70R16, 235/40R19. Returns unique sizes in order. */
export function parseTireSizes(text) {
  const t = String(text || '').toUpperCase();
  const sizes = [];
  const re = /\bP?\s?(\d{3})\s*\/\s*(\d{2})\s*(?:Z\s?)?R\s?(\d{2})\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const size = `${m[1]}/${m[2]}R${m[3]}`;
    if (!sizes.includes(size)) sizes.push(size);
  }
  return sizes;
}

/**
 * Cold tire pressures. Door-jamb labels print them as PSI (US) and/or kPa.
 * Looks for numbers near PSI/kPa, and for FRONT/REAR rows. Returns psi or
 * null per axle. kPa is converted (1 psi = 6.89476 kPa).
 */
export function parsePressures(text) {
  const t = String(text || '').toUpperCase();
  const out = { front: null, rear: null };
  const psi = [...t.matchAll(/(\d{2,3})\s*PSI/g)].map((m) => Number(m[1]));
  const kpa = [...t.matchAll(/(\d{2,3})\s*KPA/g)].map((m) => Math.round(Number(m[1]) / 6.89476));
  const values = [...psi, ...kpa].filter((v) => v >= 20 && v <= 60);
  if (!values.length) return out;
  // Front/rear rows: "FRONT 35 PSI ... REAR 35 PSI" or a single value for both.
  const frontM = t.match(/FRONT[^0-9]{0,12}(\d{2,3})\s*(PSI|KPA)/);
  const rearM = t.match(/REAR[^0-9]{0,12}(\d{2,3})\s*(PSI|KPA)/);
  const toPsi = (n, unit) => (unit === 'KPA' ? Math.round(n / 6.89476) : n);
  if (frontM) out.front = toPsi(Number(frontM[1]), frontM[2]);
  if (rearM) out.rear = toPsi(Number(rearM[1]), rearM[2]);
  if (out.front == null && out.rear == null) {
    out.front = values[0];
    out.rear = values.length > 1 ? values[1] : values[0];
  } else if (out.front == null) {
    out.front = out.rear;
  } else if (out.rear == null) {
    out.rear = out.front;
  }
  return out;
}

/** GVWR / GAWR weights in lbs (labels also print kg — lbs is what the page shows). */
export function parseWeights(text) {
  const t = String(text || '').toUpperCase().replace(/,/g, '');
  const num = (re) => {
    const m = t.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    gvwr_lbs: num(/GVWR[^0-9]{0,20}(\d{4,6})\s*(LB|LBS)?/),
    gawr_front_lbs: num(/GAWR\s*(?:FRONT|FR)[^0-9]{0,20}(\d{4,6})\s*(LB|LBS)?/),
    gawr_rear_lbs: num(/GAWR\s*(?:REAR|RR)[^0-9]{0,20}(\d{4,6})\s*(LB|LBS)?/),
  };
}

/** Manufacture / build date, MM/YY, usually near "MFD" or "DATE". */
export function parseBuildDate(text) {
  const t = String(text || '').toUpperCase();
  const near = t.match(/(?:MFD|MANUFACTURE|DATE)[^0-9]{0,20}(0[1-9]|1[0-2])\s*\/\s*(\d{2})/);
  if (near) return `${near[1]}/${near[2]}`;
  const any = t.match(/\b(0[1-9]|1[0-2])\/(\d{2})\b/);
  return any ? `${any[1]}/${any[2]}` : null;
}

/** Parse a whole label's OCR text into the door-jamb object the lookup consumes. */
export function parseDoorJambText(text, source = 'door-jamb label photo') {
  const rawText = String(text || '');
  const sizes = parseTireSizes(rawText);
  const pressures = parsePressures(rawText);
  const weights = parseWeights(rawText);
  return {
    vin: extractVinCandidate(rawText),
    tires: {
      front: sizes[0] || null,
      rear: sizes.length > 1 ? sizes[1] : sizes[0] || null,
      all: sizes,
    },
    pressures_psi: pressures,
    gvwr_lbs: weights.gvwr_lbs,
    gawr_front_lbs: weights.gawr_front_lbs,
    gawr_rear_lbs: weights.gawr_rear_lbs,
    build_date: parseBuildDate(rawText),
    raw_text: rawText,
    source,
  };
}

const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let tessPromise = null;

function loadTesseract() {
  if (typeof document === 'undefined') throw new Error('OCR needs a browser.');
  if (!tessPromise) {
    tessPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESS_CDN;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('Could not load the OCR library (CDN unreachable). Type the label values in manually instead.'));
      document.head.appendChild(s);
    });
  }
  return tessPromise;
}

/**
 * OCR a door-jamb label photo file. Returns parseDoorJambText() output.
 * The VIN in the result is a candidate — the page shows it for
 * confirmation before it is used anywhere. Browser only (needs the DOM
 * to load the OCR library); throws a clear error under Node.
 */
export async function ocrDoorJamb(file, onProgress) {
  if (typeof document === 'undefined') throw new Error('ocrDoorJamb needs a browser.');
  if (!file) throw new Error('No photo selected.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Photo too large (max 10MB).');
  const Tesseract = await loadTesseract(onProgress);
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => onProgress && onProgress(m),
  });
  try {
    const { data } = await worker.recognize(file);
    return parseDoorJambText(data.text || '');
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Browser OCR wiring (index.html). Skipped under Node so tests can import this.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {

  // Wire the page's photo controls. Kept tiny — the page owns the fields.
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('doorjamb-photo');
    const btn = document.getElementById('doorjamb-read');
    const status = document.getElementById('doorjamb-status');
    const out = document.getElementById('doorjamb-result');
    if (!input || !btn) return;
    btn.addEventListener('click', async () => {
      const file = input.files?.[0];
      if (!file) {
        status.textContent = 'Pick a photo of the door-jamb label first, or type the values in below.';
        return;
      }
      status.textContent = 'Reading the label… (first run downloads the OCR model, about 30 seconds)';
      btn.disabled = true;
      try {
        const dj = await ocrDoorJamb(file, (m) => {
          if (m.status === 'recognizing text') status.textContent = `Reading the label… ${Math.round((m.progress || 0) * 100)}%`;
        });
        window.__doorJamb = dj;
        const fill = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        fill('dj-tire-front', dj.tires.front);
        fill('dj-tire-rear', dj.tires.rear);
        fill('dj-pressure-front', dj.pressures_psi.front);
        fill('dj-pressure-rear', dj.pressures_psi.rear);
        fill('dj-gvwr', dj.gvwr_lbs);
        fill('dj-build-date', dj.build_date);
        fill('dj-vin', dj.vin);
        status.textContent = 'Label read. Check the values below — correct anything the camera misread, then run the lookup.';
        out.innerHTML = `<details><summary>OCR text (what the camera saw)</summary><pre>${dj.raw_text.replace(/</g, '&lt;')}</pre></details>`;
      } catch (e) {
        status.textContent = `Could not read the label: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}
