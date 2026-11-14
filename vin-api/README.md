# R&R VIN API — Layer 4 MVP (standalone black-box)

Sellable VIN-to-whole-car lookup from R&R's Finest Auto Glass
(118 Terrace St, Roxbury MA). A buyer sends a VIN and gets back everything
for that exact vehicle: exterior, interior, engine/motor, and mechanical —
exact part numbers, which variant fits, where it came from, and what to ask
when the VIN alone can't settle the variant. Glass is one category inside it.

**Status: MVP for black-box testing by Lou. Nothing is published, sold, or
charged.** No billing, no Stripe, no customer signups. Price and availability
are `null` until supplier feeds exist. Part numbers are never invented.

Spec: [`API_SPEC.md`](API_SPEC.md) v0.2 (whole-car). This README is the
black-box guide: how to run it, how to test it, and what it does and doesn't do.

## What was reused (not rewritten)

- **Spec v0.2** (`API_SPEC.md`) — endpoints, response shape, error codes,
  pricing tiers. Copied as-is from the Track 3 prototype work.
- **Catalog** (`data/catalog.json`) — the verified whole-car catalog from
  `demo-vehicles.json`: 4 vehicles, 37 part rows (2016–2023 Tacoma,
  2023–2025 HR-V, 2011–2016 Sienna, 2018 Camry). Every part number comes
  from R&R's own job records (Safelite referral sheets) or manufacturer
  specs. Nothing new was invented.
- **Lookup logic** (`server.js`) — NHTSA vPIC decode + catalog match from
  the prototype `api/lookup.js`, extended with the endpoints, auth, quota,
  rate limiting, check-digit validation, and pricing below.

## Quickstart (Lou — 2 minutes)

```bash
# Node 18+ required, no dependencies to install.
node vin-api/server.js
# → R&R VIN API 0.2-mvp listening on http://127.0.0.1:3000
```

In a second terminal:

```bash
curl http://127.0.0.1:3000/v1/health
curl -H "X-API-Key: rr-demo" \
  -X POST http://127.0.0.1:3000/v1/lookup \
  -H "Content-Type: application/json" \
  -d '{"vin":"3TMAZ5CN3GM000001"}'
```

Or run the full automated test (starts no server — run the server first):

```bash
npm --prefix vin-api test
# or: node vin-api/test/test-api.mjs
```

**Test URL (local only):** `http://127.0.0.1:3000` — there is no public URL
yet. Deploying one (Vercel or any Node host) is out of scope for this MVP
and needs Pedro's go-ahead. Restarting the server resets the in-memory
quotas and rate limits below.

## Auth — X-API-Key

Every `/v1/*` endpoint except `/v1/health` needs `X-API-Key: <key>`.
No key (or a bad key) → `401 unauthorized`.

Test keys (in `config/pricing.json` — test keys only, rotate before any
real buyer gets access):

| Key | Quota | For |
|---|---|---|
| `rr-demo` | 25 lookups/month | Normal testing (spec: free trial, 25/month) |
| `rr-test-low` | 1 lookup/month | Testing the `402` response |
| `rr-test-rate` | 10,000/month, 5 req/min | Testing the `429` response |

## Endpoints

### POST /v1/lookup — full lookup (main endpoint)

```json
{ "vin": "3TMAZ5CN3GM000001", "needs": ["exterior", "engine"], "location": { "lat": 42.36, "lng": -71.06 } }
```

- `vin` (required): 17 characters, no I/O/Q, correct check digit.
- `needs` (optional): which categories to return. Default: all.
  Values: `glass` (exterior glass only), `exterior`, `interior`, `engine`,
  `mechanical`, `location`.
- `location` (optional): lat/lng. Adds distance + estimated drive time to
  the shop (118 Terrace St, Roxbury MA). Distance is straight-line;
  drive time is an estimate until a routing feed exists (labeled in the
  response as `distance_note`).

Response (200): `vin`, `vehicle` (year/make/model/trim/body/engine/fuel/
transmission/drive/doors, decoded live from NHTSA), `categories`
(exterior/interior/engine/mechanical — only the ones asked for), `shop`,
`pricing_tier`, `price_usd`, `credits_used: 1`, `credits_remaining`.

Rules (from the spec): a part with no verified data returns `null`, never
a guess. `variant_status` is `exact` / `needs_confirmation` /
`variant_ambiguous` / `licensed_required` (NAGS feed not yet licensed).
A vehicle that decodes but isn't in the parts catalog returns 200 with
`categories: null` and a `catalog_note` — the decode still counts.

### GET /v1/lookup/{vin} — same lookup, URL form

```
GET /v1/lookup/3TMAZ5CN3GM000001?needs=exterior,engine&lat=42.36&lng=-71.06
```

### POST /v1/lookup/batch — fleets and auctions

Up to 100 VINs per request. One credit per VIN decoded; failed VINs are
free. If the quota runs out mid-batch, the remaining VINs come back as
per-item `out_of_credits` errors.

```json
{ "vins": ["3TMAZ5CN3GM000001", "3CZRZ1H55PM000001"], "needs": ["glass"] }
```

Response: `{ "results": [...], "credits_used": 2, "credits_remaining": 23, "price_usd_total": 1.70 }`

### GET /v1/glass/{nags} — glass detail (spec: phase 2)

Returns the on-file NAGS number with vehicle, position, variant status,
questions, and source. Catalog reads don't charge a credit. Unknown NAGS →
`404 glass_not_found`. Only R&R-verified NAGS numbers are in the catalog
until the licensed NAGS feed exists. On file now: `FW04108 GTY` (Tacoma),
`FW05907 GTY` (HR-V), `FW03760 GBY` (Sienna).

### GET /v1/health — public, no key

```json
{ "status": "ok", "version": "0.2-mvp", "uptime_seconds": 12, "vpic": "ok", "catalog_vehicles": 4, "pricing_version": "0.2-mvp" }
```

`vpic` reports whether the NHTSA decoder is reachable (`ok` / `degraded`).

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_vin` | VIN is not 17 chars, has bad characters, or fails the check digit |
| 400 | `invalid_request` | Bad JSON, bad batch (not 1–100 VINs), bad location |
| 401 | `unauthorized` | Missing or bad API key |
| 402 | `out_of_credits` | Monthly quota used up for this key |
| 404 | `vin_not_found` | VIN decoded cleanly but no vehicle record came back |
| 404 | `glass_not_found` | No glass on file for that NAGS number (MVP extension) |
| 404 | `not_found` | Unknown route |
| 422 | `variant_ambiguous` | See rule below |
| 429 | `rate_limited` | Too many requests for this key (with `Retry-After` header) |
| 500 | `internal_error` | Anything else |
| 502 | `upstream_error` | NHTSA decoder is down — retry |

**No charge on failures.** Only a successful vehicle decode charges
1 credit. Failed, invalid, not-found, ambiguous, rate-limited, and
upstream-error lookups never charge a credit. The test script verifies
this (`credits_remaining` unchanged across a run of failures).

**422 rule (MVP definition, spec-compatible):** the vehicle IS in the
catalog, the caller asked for specific categories, and EVERY requested
category is entirely empty — no verified data and no follow-up questions,
so no follow-up path exists. Example: `needs: ["mechanical"]` on the
HR-V (no verified mechanical data yet) → 422 with what to send instead.
Normal ambiguity is per part with a 200 (`variant_status` +
`variant_questions`). A vehicle NOT in the catalog returns 200 with a
`catalog_note`, never 422.

## Pricing — one config file, never hardcoded

`config/pricing.json` is the single source of prices. Change a number
there; no code change needed. Defaults (Pedro sets the real numbers later):

| Lookup | Price |
|---|---|
| Decode only (vehicle data) | $0.15 |
| Decode + glass | $0.85 |
| Full vehicle (all four categories) | $1.25 |
| Location add-on | +$0.10 |
| Try it | Free, 25 lookups/month |

The response reports `pricing_tier` and `price_usd` for every successful
lookup, so the price charged is always visible. Partial-category lookups
(other than glass-only) are priced as `decode` until Pedro sets
partial-category pricing. No money moves in this MVP — the price is
informational only.

## Test VINs (decode live via NHTSA)

These are synthetic test VINs: they decode to the right vehicles via
NHTSA's public decoder and carry no owner data. The last one is NHTSA's
own published example VIN.

| VIN | Decodes to | Catalog hit |
|---|---|---|
| `3TMAZ5CN3GM000001` | 2016 Toyota Tacoma SR5, 3.5L V6 | Yes — most complete (12 part rows) |
| `3CZRZ1H55PM000001` | 2023 Honda HR-V Sport, 2.0L | Yes |
| `5TDZK3DC8DS000001` | 2013 Toyota Sienna, 3.5L V6 | Yes |
| `4T1B11HK1JU000001` | 2018 Toyota Camry, 2.5L | Yes |
| `1HGCM82633A004352` | 2003 Honda Accord EX-V6 | No — decode only, `catalog_note` |

## What this MVP does NOT do

- No charging, billing, or Stripe. No money moves.
- No public launch or customer signups. Local only.
- No Mygrant ordering (that's Layer 3, Shop Ops Brain).
- No customer data: it takes a VIN and returns vehicle/parts data only.
  Never a customer name, address, or phone.
- No invented part numbers, prices, or availability — `null` until
  verified or fed by a supplier catalog.
- Quotas and rate limits are in-memory: restarting the server resets them.
  A production deploy needs a real store for keys and usage.
- Location distance is straight-line (haversine) with an estimated drive
  time — no routing feed yet.
