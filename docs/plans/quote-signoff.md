# Quote Sign-Off — build plan (branch: `feature/quote-signoff`)

**Correction (Nelly, 2026-10-11):** the client signs the QUOTE (signature =
approval), not the invoice. The signed quote is the authorization; the invoice
is generated later off the signed quote.

**Flow:**
`PRICE_APPROVED` → `generate_quote` → `QUOTE_SENT` → client signs →
`QUOTE_APPROVED` → [install happens later] → `generate_invoice` off the signed
quote → `INVOICED` → `close_case` → `CLOSED`.

## Quote model

`quotes` table: id, case_id, version (v1, v2… immutable — a requote supersedes,
never mutates), snapshot JSON (vehicle + part + economics at generation),
expires_at (72h default, configuration-driven via `QUOTE_EXPIRY_HOURS`),
status (`SENT`/`APPROVED`/`DECLINED`/`EXPIRED`), signature
`{name, signed_at, attribution, signature_hash (SHA-256), signature_data_url}`.

- A **signed quote never expires**. An unsigned quote past `expires_at` cannot
  be signed: the attempt marks it `QUOTE_EXPIRED` and is rejected (410).
- Expiry is checked at sign time; a background sweep is out of scope.

## Actions (`POST /api/v1/cases/:caseId/actions`)

- `generate_quote` — from `PRICE_APPROVED` (v1), `QUOTE_SENT` (re-generate),
  `QUOTE_DECLINED` / `QUOTE_EXPIRED` (requote). Sets `expires_at`.
- `sign_quote` — `{name, signature_data_url, attribution}`; validates non-empty
  name + drawn signature; idempotent; → `QUOTE_APPROVED`. Rejected if expired.
- `decline_quote` — → `QUOTE_DECLINED`.
- `requote` — alias for `generate_quote` from declined/expired (new version).
- `generate_invoice` — **requires a signed quote**; line items come from the
  signed quote's snapshot; records `quote_id` + `quote_version`. No invoice
  signature.
- `close_case` — from `INVOICED` only when the underlying quote is signed.
  Terminal `CLOSED`.

## Expiry / SLA

- **Client channel:** the quote view shows a live validity countdown and the
  expiry timestamp; an expired quote shows "ask staff for a new one".
- **Staff side:** the same 72h shows as an **SLA timer** on the quote card
  ("SLA: expires in 41h", "Expired — re-quote to proceed").

## Channel language (labels only)

- Direct → "quote" · Auction → "work request" · Insurance → "estimate".
  Applied to the staff quote card and the client quote view.

## Web

- **Staff quote card:** version, total, status, SLA countdown; Generate /
  Re-quote buttons; "Client sign-off view" opener.
- **Client quote view:** client-visible totals only (labor, tax, total — never
  glass cost/profit), signature pad (touch), typed name, Sign + Decline;
  read-only receipt after signing.
- **Staff invoice card:** generate from the signed quote (shows source quote
  version); Close case enabled only from `INVOICED` with a signed quote.

## Test plan (Lou-testable, phone-friendly)

1. Staff: open any `PRICE_APPROVED` case → quote card → Generate quote.
2. Staff: open the client quote view on a phone → review totals → sign with
   finger + typed name → Sign. (Or Decline to test that path.)
3. Staff: quote shows "Signed by {name}"; invoice card → Generate invoice →
   shows "from signed quote v1".
4. Staff: Close case → `CLOSED`. Refresh: everything persists.
5. Negative: sign an expired quote → rejected; close before invoice → rejected;
   invoice without a signed quote → rejected.

## Out of scope

Order/install stages, real geocoding/tracking, DocuSign, emailed quotes,
real payments. This branch merges cleanly without them; install later reads
the signed quote the same way the invoice does today.
