# Technician + Dispatcher + Client Tracking — plan (branch: `plan/tech-dispatcher-tracking`)

**Goal:** three views driven by one status stream, built back-to-front so each
layer is demoable against a fake of the layer below it. Independently testable
with seeded data — no dependency on quote/order/install.

**The three views:**
1. **Technician (mobile):** "my jobs today" — tap `en route` → `arrived` → `complete`.
2. **Dispatcher (staff map monitor):** today's installs as pins colored by status,
   technician pins from their latest status tap, click a pin into the case. The
   Aspen Fleet Optimizer Map Monitor idea: the schedule visualized as it executes.
3. **Client tracking (Domino's / Amazon style):** "your technician is on the way"
   — a customer-facing timeline: confirmed → en route → arrived → job done.

All three read the same status events. One tap by the tech updates all three.

## Personas (not channels)

"Channel" in Case Core means *customer* channel (Direct/Auction/Insurance).
Technicians and dispatchers are **personas** (staff roles):
- `TECHNICIAN` — sees only their assigned jobs.
- Staff/dispatcher — sees the map monitor + all jobs.
- Client — sees only their own job's tracking timeline.

## Data (new, minimal)

- Appointments get a **service address** (captured at schedule time) + geocoded
  `lat/lng` (Nominatim/OpenStreetMap, free). Cases don't carry addresses today —
  this is new.
- Appointments get a **technician assignment** (at schedule time).
- Status events: `TECH_EN_ROUTE`, `TECH_ARRIVED`, `JOB_COMPLETE` with actor +
  timestamp. The tech's pin = location of their latest job's address while
  `en route` (status-driven — **no continuous GPS tracking in v1**).

## Statuses

`SCHEDULED → EN_ROUTE → ARRIVED → COMPLETE` (per appointment).
Illegal transitions blocked; staff can advance on a tech's behalf.

## API (planned actions)

`POST /api/v1/cases/:caseId/actions`: `tech_en_route`, `tech_arrived`,
`tech_complete`. Plus `GET /api/v1/dispatch/today` → today's appointments as
`{lat, lng, status, tech, case_ref}` for the map. (Endpoint shape only — build
comes after the plan.)

## Views

- **Tech view (mobile-first):** job list for the day (address, time window,
  customer, glass), big status buttons, works with touch.
- **Dispatcher map monitor:** Leaflet + OpenStreetMap (free, no Mapbox bill).
  Pins colored by status; tech pins distinct; click → case detail.
- **Client tracker:** vertical timeline with the four stages, live as the tech
  taps. Client sees *only* their job — no staff economics, no other customers.

## Build order (reverse-engineered — UI first, fake data inward)

1. Dispatcher map UI with **hard-coded pins** (demoable immediately).
2. `GET /dispatch/today` backed by **seeded appointments**.
3. Address capture + geocoding at schedule time (real pins).
4. Tech assignment at schedule time.
5. Tech mobile view + the three status actions (pins start moving).
6. Client tracker view on the same events.
7. Wire to the real install slice when Phase 4 core lands (integration later).

## Lou-testable independently

Seeded demo: dispatcher map shows today's fake jobs; tech view on a phone taps
through the statuses; the map pins move and the client tracker advances — all
without quote/order/install existing.

## Out of scope

Continuous GPS tracking, route optimization, automated dispatching, customer
notifications (SMS/email). The map is *visibility*, not optimization, in v1.
