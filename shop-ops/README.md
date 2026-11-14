# Shop Ops Brain — Layer 3 MVP

Standalone black-box for R&R's Finest Auto Glass (Pedro). Part of the
multi-agent workflow `rr-vin-brain-multi-agent`. Branch:
`mvp/layer-3-shop-ops`. **Nothing merges to main without Pedro + Lou
approval. Nothing in this MVP sends, orders, or invoices — every
order/invoice is a DRAFT preview only.**

## What it is

A static app (HTML/JS, no server, no other layer running) that runs
the shop's back office for one job, end to end:

1. **Referral auto-read** — drop a Safelite referral PDF (parsed in
   your browser with pdf.js) or paste the sheet text → job card.
2. **Job flow** — Referral Received → Scheduled → Installed - Awaiting
   Invoice → Invoiced - Awaiting Payment → Paid (business-system Lists
   values), with install/invoice dates, payment status, check fields.
3. **Mygrant order draft** — NAGS part, qty, ship-to C034125-001.
   Draft only, never a real order. Entering the glass cost records it
   against the job.
4. **Invoice draft** — 10-day clock from install date, W-9 reminder on
   the first Progressive invoice, all Safelite-required fields.
   Amount = approved amount, flagged as approved — never money
   received.
5. **True profit** — Invoice − Glass − Tax − Glue ($22.66/job) −
   Labor. Labor hours must be ENTERED, never invented; glue is
   counted exactly once (per-job column OR general expense).
6. **Daily brief + mobile route** — today's jobs, what to order, what
   to bill, overdue flags; Google Maps links from the shop. Built
   from the jobs data only — never from the (unreliable) calendar
   cache.
7. **Tech helper** — live free NHTSA VIN decode, urethane cure
   guidance, recalibration need/rate from the referral sheet. The VIN
   does not give the exact windshield variant — the app says so and
   asks for a photo where it matters.
8. **Pricing** — reads `config/pricing.json` (draft defaults: decode
   $0.15, decode+glass $0.85, full vehicle $1.25, location +$0.10).
   No prices are hardcoded in the app. Pedro has NOT set his prices.

## Run it (Lou — black-box, no repo knowledge needed)

```bash
git clone --branch mvp/layer-3-shop-ops https://github.com/jonly03/rnr-workflow.git
cd rnr-workflow/shop-ops
python3 -m http.server 8000
# open http://localhost:8000/ in a browser
```

Opening `index.html` straight from the file system also works for
most tabs; the Pricing tab and the fixture-file loads need the local
server above (browsers block `fetch()` of local files).

There is no GitHub Pages branch preview for this branch: the repo's
preview workflow (`pages-preview.yml`) only triggers on
`workflow/**`, `feature/**`, `fix/**`, `chore/**` branches, not
`mvp/**`. Local run above is the test route.

## Lou's black-box steps

1. **Intake — synthetic PDF.** Click **"Download a synthetic
   referral PDF"** (Sara Wilson, 2023 Honda HR-V, #700006). Drag the
   downloaded file back into the drop box. Expect: referral #700006,
   $1,117.58 approved, recalibration required, Progressive.
2. **Intake — paste.** Click **"Load synthetic sheet text"**, then
   **"Parse pasted text"**. Expect the same #700006 card. Click
   **"Create job from this referral"** — it appears in Jobs as
   Referral Received. (Creating it twice is refused, not duplicated.)
3. **Jobs — demo data.** Click **"Load 8 synthetic demo jobs"**.
   Jobs tab now shows 8 jobs (fake names/phones — no real customer
   PII anywhere in this repo). Open job #700006 (Sara Wilson):
   install date 2026-10-18, status Installed - Awaiting Invoice.
   Set labor hours (e.g. 2) and rate ($40/hr from the sheet) and
   save.
4. **Order draft.** Order tab → pick job #700002 (Jane Smith,
   Scheduled). Expect a draft: NAGS FW02584 GTY, qty 1, ship-to
   C034125-001. Enter a glass cost (e.g. 154.95) + tax (e.g. 4.46)
   and save — it lands on the job.
5. **Invoice draft.** Invoice tab → job #700006. Expect: deadline
   2026-10-28 (install 2026-10-18 + 10 days), W-9 reminder
   (Progressive, no W-9 on file), amount $1,117.58 flagged
   "approved amount, not confirmed billed total, NOT money
   received", VIN flagged as not on the sheet, recalibration
   $275/$300/$500 billed only for the type performed.
6. **True profit.** Profit tab → job #700007 (Mike Taylor,
   $642.75 invoiced). With glass $154.95, tax $4.46, 2h × $40 labor:
   gross $483.34, net $380.68 (glue $22.66 counted once). Flip a
   job's glue to "General expense" and its glue line becomes $0
   with a note — never double-counted.
7. **Daily brief.** Brief tab → date **2026-10-18**. Expect the
   HR-V install, its bill deadline 2026-10-28, and a Maps route
   link from the shop. Pick **2026-11-20** (no jobs): expect "No
   jobs in the jobs data for this date" — the app never claims the
   day is clear.
8. **Tech helper.** Enter VIN `1HGCM82633A004352` (public NHTSA
   example) → expect 2003 Honda Accord. Pick job #700006 → expect
   recalibration required (Static $300 / Dynamic $275 / Dual $500),
   Express 30 ~30-minute drive-away guidance, and the warning that
   the VIN does not give the exact windshield variant.
9. **Pricing.** Pricing tab → expect decode $0.15, decode+glass
   $0.85, full vehicle $1.25, location +$0.10, marked draft.

## What was reused (not reinvented)

- **Referral parser** — `shop-ops/parser.js` is a line-for-line port
  of the verified `referral_intake.py` `parse_sheet` (0 field
  mismatches across all 8 real referrals). The #833614 masked-number
  (XXXXXX) + truncated-name override is kept explicit in both.
- **Business-system formulas + Lists** — Jobs sheet cols A–AD;
  Gross = Invoice − Glass − Tax; Net = Gross − Glue − Other;
  Job/Payment Status values verbatim; glue $22.66/job (1.5 tubes).
- **Mygrant browser service** — `services/mygrant-browser` is a
  headless-Chromium fetcher that needs a deployed service + secrets.
  This static MVP cannot call it (no server, no live ordering
  allowed), so the order step drafts the order with the same
  semantics (NAGS part, ship-to C034125-001) and the README points
  at the service as the integration point for the merged build.
- **Case engine states** — the workflow states here are the
  business-system Lists values, which are the shop's operational
  states; the Case Core contract (`architecture/`) is the canonical
  spine for the merged build and was not forked into this MVP.

## Verification (run before reporting)

```bash
# 1. Extraction: real 8 PDFs vs data.json, Python parser AND JS parser
python3 shop-ops/tests/extract_test.py     # needs pypdf + node

# 2. Logic: invoice clock, profit math, glue-once, brief, PDF round-trip
node shop-ops/tests/logic_test.js          # NHTSA check is soft (SKIP offline)
```

Expected: `extract_test.py` → 8/8 referrals, 0 mismatches in all
three parts (incl. the #833614 overrides); `logic_test.js` → all
checks pass.

## Constraints kept

- Root `index.html` untouched. No merge to main. No real customer
  PII in the repo — synthetic fixtures only (fake names, 555-010
  phones, fake streets, referral numbers 700001–700008). Real
  referral PDFs stay in `~/workspace` only and are used by the
  tests, never committed.
- Nothing sends, orders, or invoices. No Mygrant login, no Gmail,
  no Safelite portal access in this MVP.
