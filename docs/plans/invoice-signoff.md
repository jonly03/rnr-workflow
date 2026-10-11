# Invoice + In-App Sign-Off — build plan (branch: `feature/invoice-signoff`)

**Goal:** take any `PRICE_APPROVED` case (where `main` ends today) through
`INVOICED` → client signature → `CLOSED`, as an independently testable slice.
No dependency on quote/order/install — those land separately and integrate later.

**Decisions (Nelly, 2026-10-10):** in-app sign-off, not DocuSign. Signature pad +
typed name + timestamp, stored with the invoice (ESIGN-style record).

## State machine

`PRICE_APPROVED --generate_invoice--> INVOICED --sign_invoice--> INVOICED(signed) --close_case--> CLOSED`

- `INVOICED` without a signature cannot close. `CLOSED` is terminal.
- Re-invoicing (e.g. corrected actuals) creates a new invoice version; history is
  preserved, never mutated.

## Data model (new)

`invoices`: id, case_id, version, actuals JSON (line items copied from the price
calculation snapshot at generation), status (`DRAFT`/`SENT`/`SIGNED`),
`signature` JSON `{name, signed_at, attribution, signature_hash}` (the raw
signature image stored alongside, staff-visible only), created_at.

- **Actuals vs. quote:** today "actuals" = the price snapshot (install isn't
  built yet). When the install slice lands, `generate_invoice` reads the
  completed job's actuals instead. The invoice always records *which* source
  its numbers came from.

## API (`apps/api`)

New actions on `POST /api/v1/cases/:caseId/actions`:
- `generate_invoice` — allowed from `PRICE_APPROVED`. Snapshots actuals, creates
  invoice v1, emits `INVOICE_GENERATED`.
- `sign_invoice` — payload `{name, signature_data_url, attribution}`. Validates
  a non-empty signature + name, stores SHA-256 of the signature bytes, emits
  `INVOICE_SIGNED` with actor + timestamp. Idempotent (re-sign returns current).
- `close_case` — allowed only from `INVOICED` with a signature present. Emits
  `CASE_CLOSED`. Terminal.

Guards: unsigned invoice → `close_case` rejected with `INVOICE_NOT_SIGNED`.
All money math stays in integer cents.

## Web (`apps/web`)

- **Staff invoice card:** line items (actuals), "Generate invoice", invoice
  status, signature status ("awaiting signature" / "signed by {name} at {time}"),
  "Close case" (enabled only when signed). Staff-only economics note stays.
- **Client invoice view:** line items the client may see (sell price + tax —
  never supplier cost/margins), a signature pad (canvas, finger/stylus), typed
  printed-name field, "Sign" button. After signing: read-only receipt view.
- Signature pad must work with touch on a phone (Lou's counter scenario).

## Test plan (Lou-testable, phone-friendly)

1. Staff: open any `PRICE_APPROVED` case → invoice card → Generate invoice.
2. Staff: open the client invoice link on a phone → review totals → sign with
   finger + typed name → Sign.
3. Staff: case shows "signed by {name} at {time}" → Close case → `CLOSED`.
4. Refresh the case: invoice + signature persist; queue shows the case closed.
5. Negative: "Close case" before signing is rejected.

## Out of scope for this branch

Quote/order/install stages, 72h quote expiry, DocuSign, emailed invoices,
real payments. Those integrate later; this branch must merge cleanly without them.
