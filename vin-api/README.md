# R&R VIN API — Layer 2 MVP (standalone black box)

**Branch:** `mvp/layer-2-vin-anything` (cut from `main`). Nothing merges to
`main` without Pedro + Lou approval. Root `index.html` is untouched.
Staging/prod are untouched — this MVP runs on its own, no other layer needed.

**What it is:** VIN + door-jamb label photo → whole-car parts for that exact
vehicle: exterior, interior, engine, mechanical. Glass is one category inside
it. A buyer (or Lou, testing) types a VIN, optionally photographs the driver
door-jamb label, and gets back the vehicle decode plus every part the
catalog can verify — with the variant question when the VIN alone can't
settle it.

## Files

| File | What it is |
|---|---|
| `index.html` | The test page Lou opens. VIN form, door-jamb photo upload + manual fields, results, pricing panel. No build step. |
| `lookup.js` | Browser lookup: validate VIN → NHTSA vPIC decode → catalog match → categories → tier quote. ES module, also imported by the Node tests. |
| `door-jamb.js` | Door-jamb label reader: Tesseract.js OCR (CDN) + parsers for tire size, pressures, GVWR, build date, VIN. Manual entry fallback. |
| `catalog.json` | Verified demo catalog (copy of `demo-vehicles.json` v0.2): 4 vehicles, 37 part rows. |
| `config.json` | Parameterized pricing + shop + NHTSA endpoint. Prices live here, never in code. |
| `API_SPEC.md` | The v0.2 whole-car spec this MVP implements. |
| `tests/run-tests.mjs` | Node test suite (live NHTSA + catalog + variant + parser tests). Run with `node tests/run-tests.mjs`. See `tests/TEST_REPORT.md`. |

## What was reused (not rewritten)

- **Spec + catalog:** `~/workspace/your_files/vin-api/API_SPEC.md` (v0.2 whole-car)
  and `demo-vehicles.json` (4 vehicles, 37 part rows) — copied verbatim.
- **Prototype flow:** `api/lookup.js` (validate → NHTSA DecodeVinValues →
  catalog match → whole-car categories, never guess a variant).
- **Repo code:** `apps/api/src/vin-decode.ts` (NHTSA decode approach, YMM/trim),
  `apps/api/src/vin-validation.ts` (VIN character rules, no I/O/Q),
  `apps/api/src/vin-ocr.ts` (Tesseract pattern, O→0 / I,Q→1 normalization,
  OCR result is a candidate to confirm) — the door-jamb reader follows the
  same pattern for label text. `apps/api/src/nags.ts` documents the NAGS
  part-number format the glass answers use.
- **Pricing:** draft tiers from the spec — decode $0.15, decode+glass $0.85,
  full vehicle $1.25, location +$0.10 — now in `config.json` only.

## Run it

Deployed test URL: see the report in this chat (or open `index.html` from
any static server, e.g. `python3 -m http.server` in this folder, then
`http://localhost:8000/`). Opening the file directly (`file://`) will not
load `catalog.json`/`config.json` — use a server or the deployed URL.

## Black-box test steps for Lou

No setup, no login, no other layer running. Each step states what to check.

1. **Open the page.** The pricing panel shows Decode $0.15, Decode+glass
   $0.85, Full vehicle $1.25, Location +$0.10 (draft, from config).
2. **2016 Tacoma** — enter `3TMAZ5CN6GM000123`, Decode. Expect: 2016 Toyota
   Tacoma SR5/TRD, 3.5L V6. Windshield `FW04108 GTY` with "needs confirmation"
   and the rain-sensor / ADAS / HUD questions. Battery "variant ambiguous"
   (Group 24F or 35). Front brake pads "variant ambiguous" (three OEM numbers).
   Front rotors `43512-04052` confirmed. Oil 0W-20, 6.2 qt. Quote: full
   vehicle $1.25.
3. **2023 HR-V** — enter `3CZRZ1H58PM000123`. Expect: 2023 Honda HR-V Sport,
   2.0L. Windshield `FW05907 GTY`, needs confirmation. Cabin filter
   `80292-TF0-G01` confirmed. Tires "variant ambiguous" (215/60R17 or
   225/55R18) with the door-jamb question.
4. **2013 Sienna** — enter `5TDZK3DC0DS000123`. Expect: 2013 Toyota Sienna,
   3.5L V6. Windshield `FW03760 GBY` confirmed (from R&R job #833614).
   Battery Group 35 confirmed.
5. **2018 Camry** — enter `4T1B11HK4JU000123`. Expect: 2018 Toyota Camry,
   2.5L. Oil **0W-16** (not 0W-20), 4.8 qt. Windshield shows "license
   required" with no part number — the NAGS feed doesn't exist yet.
6. **2020 CLA35 AMG** — enter `WDD5J5BB2LN065797`. Expect: decodes correctly
   (2020 Mercedes-Benz CLA-Class, AMG CLA35 4M, 2.0L) and the page says the
   vehicle decoded but isn't in the parts catalog yet — all categories null,
   nothing guessed.
7. **Bad VIN** — enter `123` or a VIN with an `I` or `O`. Expect: `invalid_vin`,
   no charge, no partial result.
8. **Door-jamb photo** — pick a photo of a driver door-jamb label (or use the
   manual fields: tire `245/35 ZR19`, pressures 35 / 33 PSI, GVWR, build
   date). Run a lookup. Expect: a "Door-jamb label" section appears, and the
   Tires row changes to "confirmed" with the label's size and the label as
   source. If the camera misreads, correct the fields by hand — the result
   says "checked by hand".
9. **Prices** — every part shows no price and no availability ("supplier feed
   not connected"). The only money on the page is the lookup quote. If any
   part shows a price, that's a bug — report it.

The four demo VINs are synthetic test vectors (valid check digits) that
decode live to the demo vehicles; the CLA35 VIN is the real VIN from R&R job
(Charmaine McFarland, 2020 CLA35 AMG). The 2003 Accord
`1HGCM82633A004352` is NHTSA's own example VIN.

## What this MVP does NOT do

- No charging, billing, Stripe, signups, or API keys. No Mygrant ordering.
- No NAGS/Mygrant feed — glass without an R&R job record shows
  `licensed_required`, not a guessed number.
- No customer data: a VIN returns vehicle/parts data only, never a name,
  address, or phone.
- No invented part numbers, prices, or availability. `null` until verified
  or fed by a supplier catalog.
- The door-jamb photo is OCR'd in the browser; nothing is uploaded to R&R.
  The OCR library loads from a CDN on first use; if it can't load, manual
  entry still works.

## Branch rules for this MVP

- Work stays on `mvp/layer-2-vin-anything`. No merge to `main` without Pedro
  + Lou approval (PR, squash-merge, per `docs/branching.md`).
- Do not push to `staging` (that deploys the staging environment) or `prod`.
- Do not touch root `index.html`, `workflow-explorer.html`, or
  `r-r-s-finest-auto-glass.html` — the Pages deploy only syncs those files,
  and this MVP is deliberately outside that sync.
