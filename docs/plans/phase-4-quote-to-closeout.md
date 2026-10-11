# Phase 4: Quote → Closeout (build plan)

**Branch:** `plan/quote-to-closeout` (plan only — no code yet)
**Decisions locked 2026-10-10 (Nelly):**
- Client sign-off is **in-app** (signature pad + typed name + timestamp), not DocuSign.
- Quote **expires after 72 hours** — customer-facing expiry; on the staff side it shows as an **SLA timer**.
- Sequenced after the Jack Henry interview (Oct 14). Nelly tests the existing surface in parallel.

**Tracks epics:** #17 (Quote/Approval), #18 (Ordering), #19 (Installation + Closeout). Epic #20 is the full-lifecycle proof when this lands.

**Current state:** the product's implemented lifecycle ends at `PRICE_APPROVED`. The state machine already defines `PRICE_APPROVED --GENERATE_QUOTE--> QUOTE_GENERATING` (pricing.ts), but no action triggers it — the rest of the chain is unbuilt.

---

## 1. Quote (#17)

**States:** `PRICE_APPROVED` → `QUOTE_GENERATING` → `QUOTE_SENT` → `QUOTE_APPROVED` | `QUOTE_DECLINED` | `QUOTE_EXPIRED` → (requote) → `QUOTE_GENERATING` …

**Quote model (new table `quotes`):** id, case_id, version (v1, v2…), immutable snapshot JSON (vehicle + part + economics at generation), `expires_at`, status, channel language variant. Versions are immutable — a requote supersedes, never mutates.

**Channel language** (the #17 checklist semantics):
- Direct → "quote", customer approval
- Auction → "work request", partner approval
- Insurance → "estimate", authorization

**Expiry / SLA (the 72h rule):**
- Client channel: quote view shows a live countdown to expiry, approve/decline buttons.
- Staff side: the same 72h shows as an **SLA timer** on the case — "expires in 41h", an "expiring soon" warning state, and on breach → `QUOTE_EXPIRED` with the only allowed action being `requote`.
- 72h is configuration-driven (default), not hard-coded.

**Actions** (on `POST /api/v1/cases/:caseId/actions`): `generate_quote`, `approve_quote`, `decline_quote`, `requote`. Approval is idempotent; an approved quote cannot be silently modified.

## 2. Ordering (#18)

**States:** `QUOTE_APPROVED` → `ORDER_CONFIRMED` → `ORDER_PLACED` (failure → recoverable exception state, never a silent dead end).

- **Human purchase confirmation is a required gate** — explicit fields (supplier, part, price check) before anything is ordered.
- Inventory recheck after approval; if the selected offer lost stock → resourcing flow.
- Order request carries an **idempotency key**; retry after timeout is safe.
- Mock order provider. **Live MyGrant purchasing stays disabled until separately authorized** (same rule as the VIN lookup).

**Actions:** `confirm_purchase`, `place_order`.

## 3. Installation (#19a)

**States:** `ORDER_PLACED` → `INSTALL_SCHEDULED` → `INSTALL_COMPLETED` (exceptions → recoverable, no unsafe rewind).

- Scheduling creates durable appointment data; reschedule preserves history.
- Completion records event + timestamp; illegal completion transitions are blocked.

**Actions:** `schedule_install`, `reschedule_install`, `complete_install`.

### 3b. Technician view + staff map monitor (Phase 4b — after the core install slice)

Nelly built the Map Monitor at AspenTech (Fleet Optimizer): the dispatcher sees
groups, terminals, customers, and trucks live as the schedule executes. Same idea
for installs, scoped to a small shop:

- **Technician persona (new — not a customer channel).** "Channel" in Case Core
  means customer channel (Direct/Auction/Insurance). Technicians get their own
  mobile view: my jobs today, tap to advance status
  (`en route` → `arrived` → `complete`). Status taps are the location signal —
  no continuous GPS tracking in v1 (simpler, and respectful of the techs).
- **Service address on the appointment.** Cases don't carry an address today;
  scheduling needs one → geocode at schedule time → map pin.
- **Staff map monitor (dispatcher view):** today's installs as pins, colored by
  status; technician pins from their latest status tap; click a pin for case
  detail. This is the "visualize the schedule as it is being executed" view.
- **Stack:** Leaflet + OpenStreetMap (free; no Mapbox bill). Status-driven pins
  first; real-time tracking only if the shop ever asks for it.

**New actions:** `tech_en_route`, `tech_arrived` (both also usable by staff on
the tech's behalf).

## 4. Invoice + sign-off + closeout (#19b)

**States:** `INSTALL_COMPLETED` → `INVOICED` → `CLOSED` (terminal).

- **Invoice is generated from actuals** (completed job data), stored separately from the quote assumptions; job profit is recorded. Staff-only economics never leak to the client view.
- **In-app client sign-off:** signature pad (finger/stylus on the customer's phone or the shop tablet) + typed printed name + timestamp + device/IP attribution. The signature hash is stored with the invoice record. This satisfies the ESIGN Act (intent + attribution + retained record) — the same pattern field-service apps use. No per-envelope fees, no third party.
- **Closeout requires:** invoice generated + client signature captured + actual economics recorded. Only then → `CLOSED`.

**Actions:** `generate_invoice`, `sign_invoice`, `close_case`.

---

## UI surface

- **Staff:** quote card (version, validity, **SLA countdown**, send/preview), order card (purchase confirmation fields), schedule card, invoice card (actuals vs. quote), closeout checklist.
- **Client channel:** quote view (countdown, approve/decline), invoice view (review + sign pad).

## Build sequence

1. Quote model + actions + staff UI (vertical slice on mock) — includes the 72h expiry/SLA timer.
2. Channel language variants + client-facing quote view.
3. Ordering (confirm + place, mock provider, idempotency).
4. Installation (schedule / reschedule / complete).
5. Invoice from actuals + in-app signature + closeout.
6. **Phase 4b:** technician view + staff map monitor (needs 4 + addresses first).
7. Extend `case-core-e2e.mjs` through `CLOSED`; epic #20 proof across all three channels.

## Out of scope

- DocuSign / HelloSign integration — deferred until remote (emailed) signers are a real need.
- Live MyGrant purchasing — separately authorized, same as the $1 VIN lookup.
- Real customer notifications (email/SMS) — staff-driven for now.
