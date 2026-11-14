# R&R Brain Gateway — the Door

One API + MCP in front of Muse, wrapping the existing rnr-workflow system.
Web, WhatsApp, Siri and phone all call the same door. Nothing here
re-implements the case engine — the gateway fronts it.

```
POST /brain          { tool, arguments, channel }  + X-API-Key header
GET  /brain/health                               (public, no key)
GET  /brain/tools                                (public MCP definitions)
GET  /                                          (service pointer)
```

## Run it

Node 18+. No dependencies (built-in `http` + `fetch` only).

```sh
PORT=3000 node server.js
```

Demo key: `rr-demo` (25 lookups/month). Staff key: `rr-staff`.
Low-quota test key: `rr-test-low` (quota 1). Rate test key:
`rr-test-rate` (5 requests/minute).

## Tools (see `tools.json` for the full MCP definitions)

| Tool | What it does | Price | Notes |
|---|---|---|---|
| `decode_vin` | VIN → year/make/model/trim via free NHTSA vPIC | decode $0.15 | Only on success |
| `get_vehicle` | Identify vehicle by VIN or YMM; catalog coverage | decode $0.15 | Only on success |
| `lookup_part` | Verified whole-car parts: glass, exterior, interior, engine, mechanical | decodeGlass $0.85 / fullVehicle $1.25 / decode $0.15 | Never guesses a variant |
| `quote` | Typical price range (guide, never final) | free | |
| `create_case` | Create a case via the intake (POST /api/v1/public/intake) | free | 20 per 10 min |
| `get_case_status` | Client-safe progress via intake-status token | free | |
| `order_glass` | Staff-only paid MyGrant VIN lookup ($1, spend-capped) | $1 on success | Gates enforced; live session not wired yet |

Every tool call is audited to `gateway/audit.log` (JSONL): timestamp,
request id, channel, tool, key label, HTTP status, error code, dollars
charged, duration. Phone numbers are masked (last 4 only), status tokens
truncated, street-level address dropped.

## The one rule that matters

The gateway **never guesses a variant**. When the exact glass depends on
unanswered questions (rain sensor, ADAS camera, heads-up display,
acoustic, heated), `lookup_part` returns `422 variant_ambiguous` with
`follow_up` questions and charges **$0**. A failed, invalid, ambiguous,
rate-limited or upstream-failed lookup never charges — only a successful
decode/lookup spends a credit.

## Pricing — one file, never hardcoded

All prices, keys, quotas, rate limits, quote ranges and the MyGrant spend
cap live in `gateway/config/pricing.json`. Pedro changes numbers there;
no code change is needed to change a price. Current defaults:

- decode $0.15, decode+glass $0.85, full vehicle $1.25, location +$0.10
- MyGrant VIN lookup $1, daily spend cap $10
- Customer quote ranges (placeholders Pedro sets): windshield $300–700,
  recalibration $275–500, chip repair $75–125

## What it reuses (nothing rebuilt from scratch)

- Auth / quota / rate limit / VIN check-digit / NHTSA decode / catalog
  match / pricing tiers: Layer 4 MVP server
  (`mvp/layer-4-sellable-api`, `vin-api/server.js`).
- Verified catalog, 4 vehicles / 37 part rows: Layer 2 MVP
  (`mvp/layer-2-vin-anything`, `vin-api/catalog.json` → `gateway/data/catalog.json`).
- Pricing defaults + quote ranges: Layer 1 shared config
  (`mvp/layer-1-talking-intake`, `config/vin-brain-pricing.json`).
- VIN gate (ISO 3779 check digit): `apps/api/src/vin-validation.ts`.
- NHTSA decode: `apps/api/src/vin-decode.ts`. NAGS decode:
  `apps/api/src/nags.ts`. Intake contract (zod fields, phone rule, 201
  shape, 20/10-min limit): `apps/api/src/app.ts`
  (`POST /api/v1/public/intake`, `GET /api/v1/public/intake-status/:token`).
- MyGrant $1 VIN lookup cost: `apps/api/src/mygrant.ts`.

`create_case` / `get_case_status` proxy to Case Core at
`RR_CASE_API_URL` (default `https://rnr-case-staging-zero-to100-edu.vercel.app`)
instead of re-implementing the case engine. Channel is pinned DIRECT and
state REQUEST_RECEIVED server-side; unknown argument keys are stripped, so
pricing, channel and case state can never be smuggled in. Photos cannot go
through the gateway — damage photos go through the web intake.

## Current upstream status (2026-11-14)

- Vercel Deployment Protection was turned OFF 2026-11-13 ~23:30 EST, so
  the staging intake page loads publicly and no bypass is needed.
- BUT the Case API behind it is erroring: `/api/v1/health` answers
  `500 INTERNAL_ERROR` ("The request could not be completed.") and the
  intake POST hangs. DIAGNOSED 2026-11-13 23:33 EST: it is a
  database-connection failure in the API itself, NOT the proxy — every DB
  call fails with tenant/user `postgres.tvfrfkxyvicnjibjhloa` not found
  (ENOTFOUND, FATAL) via PgCaseStore.health. The Supabase project behind
  that ref is most likely deleted, paused, or the connection string /
  pooler host is wrong. Fix is to point the API's DATABASE_URL at a live
  database and redeploy (not yet done). Until then, `create_case` and
  `get_case_status` honestly return `502 upstream_error` and charge $0 —
  the gateway never fakes a 201.
- `order_glass` enforces every gate (staff key, valid VIN, spend cap)
  and then returns `503 mygrant_not_configured`: the live MyGrant session
  is not wired in this standalone build. The real provider lives in
  `apps/api/src/mygrant.ts` (browser session); wiring it means running
  the gateway alongside apps/api with that provider.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `RR_CONFIG_PATH` | `gateway/config/pricing.json` | Pricing/keys/caps |
| `RR_CATALOG_PATH` | `gateway/data/catalog.json` | Verified parts catalog |
| `RR_TOOLS_PATH` | `gateway/tools.json` | MCP tool definitions |
| `RR_AUDIT_PATH` | `gateway/audit.log` | JSONL audit log |
| `RR_CASE_API_URL` | staging URL above | Case Core base URL |
| `RR_VERCEL_BYPASS_SECRET` | (unset) | Vercel protection bypass, if the wall returns |

## Tests

```sh
node --test test/test-gateway.mjs   # 23 tests, live NHTSA decode, needs internet
```

The suite starts the real server on a scratch port with the Case API
pointed at a dead port, so the `create_case` proxy error path is
exercised without creating a real case. Quota (402), rate limit (429),
auth (401), variant ambiguity (422, $0), NAGS decode, audit masking and
the smuggled-key strip are all covered.

## Example

```sh
curl -X POST http://127.0.0.1:3000/brain \
  -H 'Content-Type: application/json' -H 'X-API-Key: rr-demo' \
  -d '{"tool":"decode_vin","arguments":{"vin":"WDD5J5BB2LN065797"},"channel":"web"}'
# {"ok":true,"tool":"decode_vin","channel":"web","request_id":"…",
#  "result":{"vin":"WDD5J5BB2LN065797","vehicle":{"year":2020,
#  "make":"Mercedes-Benz","model":"CLA-Class",…}},
#  "usage":{"credits_used":1,"credits_remaining":24,"charged_usd":0.15}}
```

## Boundaries (from the map phase)

- Never guess a variant, never charge on a failed lookup.
- Never merge to main, never overwrite root `index.html` — branch only.
- No charging, no billing, no Stripe, no public launch, no customer
  signups. Price/availability are null until supplier feeds exist.
- Part numbers are never invented; unverified parts return null.
