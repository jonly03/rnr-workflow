# R&R Case Core API v0.1

Runnable backend for issue #25.

## Run

```bash
cd apps/api
npm install
npm test
npm run start
```

Default API: `http://localhost:3001`

Default durable development store: `apps/api/data/cases.json`.

Set `CASE_STORE_FILE` to override the data file.

## Contract

Implements the accepted Case Core v0.1 surfaces:

- `POST /api/v1/cases`
- `GET /api/v1/cases`
- `GET /api/v1/cases/:caseId`
- `GET /api/v1/cases/:caseId/events`
- `POST /api/v1/cases/:caseId/actions` as a guarded reserved boundary

The action endpoint intentionally rejects unimplemented actions rather than exposing arbitrary state mutation.

No MyGrant or paid VIN call exists in this service.

## Brain Gateway ("the Door")

One endpoint in front of Muse: `POST /api/v1/brain` with an `X-API-Key`
header. Web, WhatsApp, Siri and phone all call the same gateway with a
`channel` of `web`, `whatsapp`, `siri`, `phone` or `direct`.

```bash
curl -X POST http://localhost:3001/api/v1/brain \
  -H "X-API-Key: dev-brain-key" -H "Content-Type: application/json" \
  -d '{"tool":"decode_vin","arguments":{"vin":"WDD5J5BB2LN065797"},"channel":"web"}'
```

Tools (see `GET /api/v1/brain/tools` for the MCP definitions):

- `decode_vin` — NHTSA VIN decode (charged: decode price; invalid VINs 400, never charged)
- `get_vehicle` — resolve a vehicle by VIN or year/make/model
- `create_case` — public-intake case creation (201, reference + status token)
- `get_case_status` — client-safe phase by reference or status token
- `lookup_part` — whole-car parts by category (exterior/interior/engine/mechanical)
- `quote` — case quote by reference, or a priced estimate by vehicle+glass
- `order_glass` — staff-only, INVOICED → PARTS_ORDERED; never runs a paid VIN lookup

Rules: never guess a variant (ambiguous parts return `variant_ambiguous` +
follow-up questions), never charge on a failed lookup, unknown argument keys
are stripped. Every call is audit-logged (JSONL, `data/gateway-audit.jsonl`,
no PII) and rate-limited (20 per 10 min per key). Usage prices live only in
`config/brain-pricing.json` (decode $0.15, decode+glass $0.85, full vehicle
$1.25, location addon $0.10 — draft defaults; Pedro sets the prices).
`GET /api/v1/brain/health` reports gateway status, pricing, catalog, and
audit counts. Keys come from `BRAIN_API_KEYS` (and `BRAIN_STAFF_API_KEYS`
for `order_glass`); see `.env.example`.
