# R&R VIN API — API Specification (Draft v0.2, 2026-11-13 — WHOLE CAR)

Sellable VIN-to-whole-car intelligence from R&R's Finest Auto Glass
(118 Terrace St, Roxbury MA). A buyer sends a VIN (+ what they need) and gets
back EVERYTHING for that exact vehicle: exterior, interior, engine/motor, and
underneath/mechanical — exact part numbers, which variant fits this VIN/trim,
where to source it, price range, availability, and what to ask when the VIN
alone can't settle the variant.

Glass is ONE category inside it, not the whole product.

Status: DRAFT for Pedro's review. Nothing is published, sold, or charged yet.
Prototype demo runs on NHTSA data (free) plus R&R's own verified job data.
The NAGS glass catalog and the wider parts catalogs are the licensed/paid
parts — see "Coverage by category" below. Live prototype catalog (synced
2026-11-13): 4 vehicles, 37 part rows — see `demo-vehicles.json`.

## Base URL (proposed, not yet live)

```
https://api.rrsfinest.com/v1
```

Prototype demo: hosted artifact (docs + live lookup). Production deploy target:
Vercel serverless function (see `api/lookup.js`) in repo `jonly03/rnr-workflow`.

## Auth

- Header: `X-API-Key: <key>`
- Keys are issued per buyer, with a monthly lookup quota and a rate limit
  (default 60 lookups/minute per key).
- No key = `401`. Out of credits = `402`. Over rate limit = `429`.

## Endpoints

### POST /v1/lookup — full lookup (main endpoint)

Request:

```json
{
  "vin": "1HGCM82633A004352",
  "needs": ["exterior", "engine", "mechanical"],
  "location": { "lat": 42.33, "lng": -71.10 }
}
```

- `vin` (required): 17-character VIN.
- `needs` (optional): which categories to return. Default: all.
  Values: `glass` (exterior glass only), `exterior`, `interior`, `engine`,
  `mechanical`, `location`.
- `location` (optional): buyer/customer lat/lng. When present, the response
  adds distance and drive time to R&R's shop (118 Terrace St, Roxbury MA).

Response (200) — whole-car model. Every part follows the same shape:

```json
{
  "vin": "1HGCM82633A004352",
  "vehicle": {
    "year": 2016, "make": "Toyota", "model": "Tacoma", "trim": "SR5",
    "body": "Pickup", "engine": "3.5L V6", "fuel": "Gasoline",
    "transmission": "Automatic", "drive": "4WD", "doors": 4
  },
  "categories": {
    "exterior": {
      "glass": {
        "windshield": {
          "part_number": "FW04108 GTY",
          "variant_status": "needs_confirmation",
          "variant_questions": [
            "Does the windshield have a rain sensor near the mirror?",
            "Is there a camera behind the windshield (lane assist / ADAS)?",
            "Heads-up display? Acoustic glass? Heated wiper area?"
          ],
          "source": "NAGS via R&R job #368700",
          "price_range": null,
          "availability": null
        },
        "back_glass": null,
        "door_glass": null,
        "quarter_glass": null,
        "vent_glass": null
      },
      "wipers": { "driver_in": 22, "passenger_in": 20, "part_numbers": "85222-04030 / 85212-04031", "source": "manufacturer spec" },
      "tires": { "size": "245/75R16 base fitment", "variant_status": "variant_ambiguous", "variant_questions": ["Send a photo of the tire size on the driver door-jamb label."], "source": "manufacturer spec" },
      "mirrors": null, "lights": null, "bumpers": null,
      "body_panels": null, "trim": null
    },
    "interior": {
      "cabin_filter": {
        "part_number": "88508-04010",
        "variant_status": "confirmed",
        "source": "manufacturer spec",
        "price_range": null, "availability": null
      },
      "seats": null, "dash": null, "airbags": null, "steering": null,
      "electronics": null, "infotainment": null, "hvac": null
    },
    "engine": {
      "oil": { "viscosity": "0W-20", "capacity_qt": 6.2, "capacity_note": "with filter; 6.1 without towing-package oil cooler", "source": "manufacturer spec" },
      "oil_filter": { "part_number": "04152-YZZA1", "type": "cartridge", "source": "manufacturer spec" },
      "air_filter": { "part_number": "17801-0P100", "source": "manufacturer spec" },
      "spark_plugs": { "part_number": "90919-01263", "brand": "DENSO FK20HBR8 iridium", "qty": 6, "interval_mi": 60000, "source": "manufacturer spec" },
      "coolant": { "type": "Toyota Super Long Life Coolant (pink) 50/50", "part_number": "00272-SLLC2", "source": "manufacturer spec" },
      "transmission_fluid": { "type": "Toyota ATF WS", "part_number": "00289-ATFWS", "drain_refill_qt": 4.2, "source": "manufacturer spec" },
      "battery": { "variant_status": "variant_ambiguous", "note": "Group 24F or Group 35 — fitment catalogs differ by trim; a photo of the battery label settles it", "source": "fitment catalogs" },
      "belts": null, "hoses": null
    },
    "mechanical": {
      "brakes": {
        "front_pads": { "part_number": "04465-04070 / 04465-04080 / 04465-04090", "variant_status": "variant_ambiguous", "variant_questions": ["Which cab and drivetrain — Access Cab or Double Cab, 2WD or 4WD? Or a photo of the caliper."], "source": "manufacturer spec" },
        "front_rotors": { "part_number": "43512-04052", "source": "manufacturer spec" },
        "rear": null
      },
      "suspension": null, "steering": null, "exhaust": null, "drivetrain": null
    }
  },
  "shop": {
    "name": "R&R's Finest Auto Glass",
    "address": "118 Terrace St, Roxbury MA 02120",
    "phone": "857-266-1284",
    "distance_miles": 3.1,
    "drive_minutes": 9,
    "mobile_available": true
  },
  "credits_used": 1,
  "credits_remaining": 199
}
```

Rules for every part entry:
- `part_number` is an exact number, or `null` when not verified. Never invented.
- `variant_status`: `"confirmed"` / `"exact"` (VIN + trim settles it),
  `"needs_confirmation"` / `"variant_ambiguous"` (VIN alone doesn't —
  response carries `variant_questions`, and the buyer can send a photo), or
  `"licensed_required"` (the part needs a licensed catalog feed, e.g. NAGS
  glass). The lookup itself still returns 200; the ambiguity is per part,
  not per request.
- `price_range` and `availability` come from supplier feeds (Mygrant for
  glass, parts suppliers for the rest). Until a feed exists they return
  `null` — never a guessed price.
- A category the buyer didn't ask for (`needs`) is omitted. A part with no
  verified data returns `null` with no fake value.

### GET /v1/lookup/{vin} — same lookup, URL form

```
GET /v1/lookup/1HGCM82633A004352?needs=exterior,engine&lat=42.33&lng=-71.10
```

Same response shape as POST.

### POST /v1/lookup/batch — fleets and auctions

- Up to 100 VINs per request, one credit per VIN decoded.
- Request: `{ "vins": ["...", "..."], "needs": ["glass"] }`
- Response: `{ "results": [ {lookup...}, ... ], "credits_used": 2 }`
- Built for U-Haul lot scans and America's Auto Auction inventory — now
  whole-car, so one scan returns glass + service parts for every truck.

### GET /v1/glass/{nags} — glass detail (phase 2)

Returns options, Mygrant availability, and R&R price for one NAGS part number.
Depends on the licensed NAGS/Mygrant catalog feed.

### GET /v1/health

`{ "status": "ok", "uptime": "...", "vpic": "ok" }`

## Error cases

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_vin` | VIN is not 17 chars, has bad characters, or fails the check digit |
| 404 | `vin_not_found` | VIN decoded cleanly by the decoder but no vehicle record came back |
| 401 | `unauthorized` | Missing or bad API key |
| 402 | `out_of_credits` | Monthly quota used up |
| 422 | `variant_ambiguous` | Top-level fallback: the requested category has no single answer and no follow-up path was possible — response includes the follow-up questions instead of a part number. (Normally ambiguity is per part via `variant_status` with a 200.) |
| 429 | `rate_limited` | Too many requests for this key |
| 502 | `upstream_error` | NHTSA decoder (or catalog) is down — retry, no credit charged |
| 500 | `internal_error` | Anything else — no credit charged |

Rules: failed, invalid, and not-found lookups never charge a credit.
Only a successful vehicle decode charges 1 credit.

## Coverage by category — which source covers what

| Category | Source | Status |
|---|---|---|
| Vehicle decode (year/make/model/engine/trim) | NHTSA vPIC API (`vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/{vin}?format=json`) | **Live** — verified 2026-11-13. Free, no key. Returns 80-140 attributes. No part numbers. |
| Glass — windshield, back, door, quarter, vent | NAGS catalog via Mygrant Glass | **Licensed** — needs the catalog feed. Demo: Sienna windshield FW03760 GBY is filled in from R&R's own job record (#833614); other glass shows `licensed_required` until the feed exists. Tacoma FW04108 GTY (#368700) and HR-V FW05907 GTY (#186114) are on file from R&R job records. Variant always confirmed by questions/photo. |
| Exterior — tires, wipers | Manufacturer specs / fitment catalogs | **Partial** — verified for demo vehicles (see below). Tire size varies by trim — door-jamb photo settles it. |
| Exterior — mirrors, lights, bumpers, body panels, trim | OEM EPC / aftermarket parts catalogs | **Roadmap** — needs a catalog feed. Returns `null` until then. |
| Interior — cabin filter | Manufacturer specs | **Partial** — Tacoma (88508-04010) and HR-V (80292-TF0-G01) verified. |
| Interior — seats, dash, airbags, steering, electronics, infotainment, HVAC | OEM EPC / parts catalogs | **Roadmap** — needs a catalog feed. Returns `null` until then. |
| Engine — oil, filters, spark plugs, coolant, transmission fluid, battery | Manufacturer specs | **Partial** — verified for demo vehicles (see below). Belts/hoses need a catalog feed. |
| Mechanical — brakes | Manufacturer specs / OEM EPC | **Partial** — Tacoma front pads/rotors verified. Suspension, steering, exhaust, drivetrain need a catalog feed. |
| Price range + availability (every part) | Supplier feeds — Mygrant for glass, parts suppliers for the rest | **Roadmap** — returned as `null` until feeds exist. Never guessed. |
| Distance / drive time | Geocoding + routing (Google Maps or OSRM) | **Roadmap** — from the request's lat/lng to 118 Terrace St. |

## Demo vehicles (verified — R&R's own jobs + manuals; full data in `demo-vehicles.json`)

**2016–2023 Toyota Tacoma 3.5L V6** (most complete demo vehicle, 12 part rows)
- Glass: windshield FW04108 GTY on file (R&R job #368700); live catalog
  shows `licensed_required` until the NAGS feed exists.
- Exterior: tires variant_ambiguous (245/75R16 base; TRD 265/70R16 or
  265/65R17 — door-jamb photo settles it); wipers 22" / 20"
  (85222-04030 / 85212-04031).
- Interior: cabin filter 88508-04010.
- Engine: oil 0W-20, 6.2 qt w/ filter; oil filter 04152-YZZA1 cartridge;
  air filter 17801-0P100; spark plugs 90919-01263 (DENSO FK20HBR8 iridium,
  qty 6, 60,000 mi); coolant Toyota SLLC pink 50/50, 00272-SLLC2
  (capacity omitted — sources conflict); transmission fluid Toyota ATF WS,
  00289-ATFWS, drain/refill ~4.2 qt; battery variant_ambiguous (Group 24F
  or 35 by trim).
- Mechanical: front brake pads variant_ambiguous (three OEM numbers fit:
  04465-04070 / 04080 / 04090 — cab/drivetrain or caliper photo settles
  it); front rotors 43512-04052.

**2023–2025 Honda HR-V 2.0L** (9 part rows)
- Glass: windshield FW05907 GTY on file (R&R job #186114); live catalog
  shows `licensed_required` until the NAGS feed exists.
- Exterior: tires variant_ambiguous (215/60R17 LX/EX-L or 225/55R18
  Sport); wipers 26" / 17" / 12" rear.
- Interior: cabin filter 80292-TF0-G01.
- Engine: oil 0W-20, 4.4 qt w/ filter; oil filter 15400-PLM-A02; air
  filter 17220-5BA-A00; coolant Honda Long-Life Type 2, 50/50, 1.57 gal;
  CVT fluid Honda HCF-2, 2.9 qt (2WD) / 3.7 qt (AWD) drain-and-fill.
- Spark plugs, battery: not verified yet — `null` / `variant_ambiguous`.

**2011–2016 Toyota Sienna 3.5L V6** (9 part rows)
- Glass: windshield FW03760 GBY — filled in live from R&R job #833614.
- Exterior: tires variant_ambiguous (P235/60R17 or P235/55R18 by trim,
  some run-flat); wipers 28" / 20" / 16" rear.
- Engine: oil 0W-20, 6.4 qt w/ filter; oil filter 04152-YZZA1 cartridge;
  spark plugs FK20HR11 (Denso iridium, gap 0.043, qty 6); coolant Toyota
  SLLC 00272-SLLC2; transmission fluid Toyota ATF WS 00289-ATFWS, 6.9 qt
  (2WD) / 7.1 qt (AWD); battery Group 35.

**2018 Toyota Camry 2.5L (A25A-FKS, gas non-hybrid)** (7 part rows)
- Glass: `licensed_required` until the NAGS feed exists.
- Exterior: tires variant_ambiguous (205/65R16 L/LE, 215/55R17 SE/XLE,
  235/45R18 or 235/40R19 XSE).
- Engine: oil 0W-16 (not 0W-20), 4.8 qt w/ filter; oil filter
  90915-YZZN1; spark plugs FC16HR-Q8 (Denso iridium, gap 0.031, qty 4);
  coolant Toyota SLLC 00272-SLLC2, 7.3 qt; transmission fluid Toyota ATF
  WS 00289-ATFWS, 7.7 qt reference.
- From R&R job #020545 (Bryelle Gomes, 2018 Camry).

NAGS numbers are from Pedro's Safelite referral sheets. Oil/fluid/filter/
brake specs verified against owner's-manual and dealer/maintenance spec
sources, Nov 2026. Fields shown as `null` are not verified yet — the API
returns them as `null`, never invented. Customer names never appear in the
shipped catalog — only internal job reference numbers.

## Pricing (DRAFT — Pedro sets the number)

Market grounding (researched Nov 2026): a bare VIN decode is a commodity.
NHTSA is free. Commercial decode-only APIs charge about $0.01–$0.10 per
lookup (1Lookup ~$0.01, MarketCheck $0.10 pay-as-you-go); richer decode
vendors (Vincario, CarsXE) charge $0.22–$0.49 per lookup on monthly tiers
($49/mo for 100–2,000 lookups). None of those include the glass NAGS part,
the parts mapping, or a local shop — that is what R&R sells. Whole-car
answers are worth more than a decode: the tiers below price by depth.

Draft pricing (Pedro to confirm or change — the prototype page carries the
same numbers in an editable draft with live revenue math):

| Lookup | Price |
|---|---|
| Decode only (vehicle data) | $0.15 |
| Decode + glass (NAGS part + variant check) | $0.85 |
| Full vehicle (decode + all four categories) | $1.25 |
| Location add-on (distance / drive time) | +$0.10 |
| Try it | Free, 25 lookups / month |

Bulk discount and a monthly minimum apply at volume; fleet / auction
(U-Haul, America's Auto Auction) is custom.

Failed/invalid lookups are never charged. A buyer only pays when a vehicle
comes back.

## Buyers (who pays)

Other auto glass shops, mechanics, dealerships, fleets (U-Haul Boston,
Greg Meneus), auctions (America's Auto Auction), parts stores. They already
pay for decodes that don't include glass — R&R's version answers the question
they actually ask: "what windshield and parts does this exact car take?"
Whole-car makes it useful to a mechanic or a fleet, not just a glass shop.

## What is NOT in this build

- No charging, no billing, no Stripe — nothing takes money until Pedro says go.
- No public launch, no customer signups.
- No Mygrant ordering from the API (Track 2, Shop Ops Brain, covers ordering).
- No customer data: the API takes a VIN and returns vehicle/parts data only.
  Never return a customer's name, address, or phone from a VIN.
- No invented part numbers, prices, or availability. `null` until verified
  or fed by a supplier catalog.
