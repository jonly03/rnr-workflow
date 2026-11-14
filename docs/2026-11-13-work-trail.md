# R&R Workflow — Work Trail: 2026-11-13

> **Purpose:** one trail so any Muse agent picking this up can see what was done on
> 2026-11-13, where it lives, what is verified, what is still open, and what NOT to
> redo. Read this file first, then the branch / chat / file it points to.
>
> **Date:** Friday 2026-11-13 (times EST unless noted; UTC is EST + 5h)
> **Owner:** Pedro Velez, R&R's Finest Auto Glass — 118 Terrace St, Roxbury MA 02120,
> (857) 266-1284, rrsfinest1@gmail.com
> **Repo:** `jonly03/rnr-workflow` (public, TypeScript, `main`)
> **Tester:** Lou — black-box tester for the MVPs. Nothing merges to `main`
> without Pedro **and** Lou.
> **Standing rule from Pedro, 2026-11-13 ~23:44 EST:** every time Muse claims to be
> done with a layer, give him a test URL for that layer, on its own, so he can show
> Lou. Test every layer independently.

## 0. Status at a glance

| Area | Status on 2026-11-13 late evening |
|---|---|
| Landing page / website | **Live.** `https://rrsfinestautoglass.com` and GitHub Pages `https://jonly03.github.io/rnr-workflow/r-r-s-finest-auto-glass.html` |
| Google Business Profile | **Live, website = rrsfinestautoglass.com** (verified on public Search 23:17 EST). Owner account is "Pvelez"; rrsfinest1@gmail.com is a Manager. |
| Intake (Case Core staging) | **Loads publicly, no Vercel login wall.** Health confirmed healthy 23:47 EST (`ok:true`, storage `postgres`) after the staging DB was resumed. |
| Layer 1 — Talking Intake | **Built, tested, pushed** (`mvp/layer-1-talking-intake`, `2f38a46`). Test URL pending — deploy run #139 was running 23:46 EST. |
| Layer 2 — VIN-to-Anything | **Built, tested, pushed** (`mvp/layer-2-vin-anything`, `9f2e30b4`). Public test URL live (Muse artifact mirror). |
| Layer 3 — Shop Ops | **Built, tested, pushed** (`mvp/layer-3-shop-ops`, `efc64b8`). Local-run test only, no Pages preview for `mvp/**`. |
| Layer 4 — Sellable API | **Built, tested, pushed** (`mvp/layer-4-sellable-api`, `87e70e39`). Local-run test only, no public URL. |
| Gateway / Door (the pivot) | **Code pushed** (`gateway/brain-door`, `58025f0`), **NOT yet verified end-to-end.** Two workflow runs failed on handoff/timeout, not on the code itself. Relaunch was in flight. |
| Old 4-branch workflow | **Stopped** by Pedro 23:23 EST. Inspect phase kept; fork/build-4-in-parallel stopped. |
| Market viability report | **Delivered, revised to whole-car** (24 pp., local PDF — not in this repo). |
| Patent check | **Done as research.** Conclusion: general-form idea very likely not patentable; protect by trade secret / trademark instead. |
| SEO / red-team audit | **Draft built, then sent back for corrections** — it wrongly claimed rrsfinestautoglass.com did not exist. Corrected PDF still pending at trail time. |

## 1. Ground rules — do not break these

1. **Update the existing listing/profile first; never create a duplicate.** Google
   Business Profile already exists. Do not create a new account, profile, or
   duplicate listing without Pedro's explicit yes.
2. **Do not overwrite root `index.html`.** It is the R&R Workflow demo suite
   (14 milestones). New pages go in as separate files (e.g.
   `r-r-s-finest-auto-glass.html`).
3. **Nothing merges to `main` without Pedro + Lou.** MVP work lives on branches.
4. **No fork of your own repo.** GitHub will not fork `jonly03/rnr-workflow` into
   `jonly03`. Every layer tried it and failed (403 / "equivalent connector write
   already running" / GitHub refusing a self-fork). Branch-in-repo is the
   isolation. Do not re-attempt the fork as if it were a new idea.
5. **Nothing publishes, sends, orders, invoices, or charges without Pedro's
   explicit go-ahead.** Drafts only, unless he says go.
6. **Pricing is parameterized, never hardcoded.** One shared config per layer,
   draft defaults: decode $0.15, decode+glass $0.85, full vehicle $1.25,
   location +$0.10. Pedro has **not** set his prices yet.
7. **Never guess a variant.** If VIN + door jamb cannot settle rain sensor /
   ADAS camera / HUD / acoustic / heated glass (or a part variant), return
   `variant_ambiguous` / `needs_confirmation` + a follow-up question.
   Price / availability are `null` until a real supplier feed exists.
8. **Approved amount ≠ money received.** An approved referral/invoice amount is
   not a billed total and not cash in. Say which it is, every time.
9. **No real customer PII in the repo.** L3 uses synthetic fixtures only
   (fake names / 555 phones / fake streets, referral #s 700001–700008). One
   deliberate exception, ordered by the task: the #833614 parser override in
   `shop-ops/parser.js` carries one real name so that sheet parses correctly.
   Do not add more PII.
10. **Free Supabase projects pause after 7 days idle.** Staging goes down
    whenever nobody touches it for a week. See §4.

## 2. Timeline — 2026-11-13 (EST)

- **Morning / afternoon — VIN brain idea.** Pedro asked if a VIN scanned off the
  door jamb could drive a service telling a customer what windshield / parts /
  oil / filter their car takes, distance to the shop, and what to ask. Expanded
  to a conversational intake + MCP-powered shop brain + sellable API, with Muse
  as the brain in front of an API.
- **19:52 — Pedro approved all three tracks**, each in its own new chat:
  (1) R&R Chat Intake — Conversational VIN, (2) R&R Shop Ops Brain,
  (3) R&R VIN API — Sellable Service.
- **20:20 — Two more chats:** R&R Patent Check — VIN Brain, and R&R Market
  Research — VIN Brain TAM.
- **20:33 — SCOPE EXPANSION:** disassociate the VIN brain from windshield-only.
  Whole-car intelligence through the VIN + anything else needed: every part,
  exterior, interior, engine/motor, and everything in between, plus where to
  source each part. Glass is one category inside it. The VIN API, Market, and
  Patent chats were updated the same night.
- **~22:07 — Google profile website swapped** to the GitHub Pages landing page
  (see §3).
- **22:50 — Multi-agent workflow ordered:** fork first, understand the existing
  code before changing it, one branch per finished MVP of every layer so Lou
  can test each layer in its own standalone black box, integrate at the end.
  Workflow `rr-vin-brain-multi-agent`, run
  `workflow-run-3906f4c523b548429e00ba412f7b2b5d`, phases
  inspect → fork → build-mvp (4 parallel) → verify → integrate (plan only).
  Four MVP chats created (see §6).
- **23:23 — PIVOT: Gateway / Door first.** Pedro: "Aren't we going at it the hard
  way? … build an API or an MCP … just a door in front of you." Old 4-branch
  workflow **stopped** (inspect kept, fork dead). New workflow
  `rr-brain-gateway`, branch `gateway/brain-door` in the same repo, no fork.
  New chat: R&R Brain Gateway — The Door.
- **~23:30 — Pedro turned off Vercel Deployment Protection himself** on
  `rnr-case-web`. Intake loads publicly after that (see §4).
- **~23:35 — Pedro resumed the paused staging Supabase DB himself** (see §4).
- **23:43 — First gateway workflow run failed** at the build handback (builder
  returned prose instead of JSON; stopped before testing). Gateway code itself
  **was** built and pushed. Relaunched 23:44 as
  `workflow-run-687a018f490046aea3ef4533b5c1516b`, reusing the map result.
  A separate gateway workflow run also timed out after 20 min on build-door
  with no result — map completed, test-door never ran, no verified gateway
  from that run.
- **23:44 — Pedro's test-URL rule** (see header): a test URL per layer, every
  time done is claimed, so he can show Lou; asked whether the Vercel login
  could be bypassed without going to production. Answer: yes — it was a
  project setting, already switched off; previews open publicly.
- **23:46 — Deploy run #139** of `deploy-staging.yml` dispatched on the L1
  branch to produce a preview URL. A watch checks every 10 min until 00:46 EST
  and delivers the verified public URL to Pedro (tracked item
  `goal_005626418dba`).
- **23:47 — Staging DB health confirmed:** `/api/v1/health` returns
  `ok:true`, storage `postgres`.

## 3. Website, domain, Google profile

### Landing page

- Built 2026-11-13 (Muse artifact slug `r-r-s-finest-auto-glass-landing-page`):
  every main CTA links to the intake URL + call/text 857-266-1284, LocalBusiness
  + FAQ structured data, 18-town service area, 6 service sections with real
  install photos, insurance and shops/auctions/fleets sections, Google reviews
  (5.0, 2 reviews). Updated the same day with the intake's exact 3 steps in
  How It Works and a red "Start a Case" button on each of the 6 service cards.
- Public artifact link (hosted by Muse, live as long as the artifact exists;
  edits need re-sharing):
  `https://muse.ai/s/r-r-s-finest-auto-glass-landing-page-exa6xm6jxxxxxkig/v3OPxMZfgjPQrzbgTUEevfQT_ZSC-ap3xtrP07qeyUg`
- **In this repo (main):** `r-r-s-finest-auto-glass.html`, linked from the root
  homepage `index.html` ("R&R's Finest Auto Glass — Live site").
  Live: `https://jonly03.github.io/rnr-workflow/r-r-s-finest-auto-glass.html`
  (200, verified). Homepage `https://jonly03.github.io/rnr-workflow/` is live
  and links to it.
- It was initially 404 because `pages.yml` only synced app files. Fix approved
  by Pedro, but the API write failed 403 (Muse GitHub App lacks workflows
  permission). Fix done via browser 19:36 EST after Pedro signed in to GitHub
  as jonly03 with 2FA (edited `pages.yml` in the web UI).
- Work order Pedro set: (1) landing page into the repo + homepage points to it
  as the page to link on the Google profile, (2) then intake, (3) then
  operations / back end.

### Domain — rrsfinestautoglass.com

- Pedro approved buying it on Cloudflare Registrar, 1 year, **$11.17**.
  Registered and active. Charged to Mastercard ending 0322. Expires
  2026-11-13 → **2027-11-13**, auto-renew 2027-10-14 at $11.17.
  Order ID `05141640-…` (full ID in the domain chat — do not guess the tail).
  A 5-year purchase was not available in Cloudflare's cart; it auto-renews yearly.
- Live: `https://rrsfinestautoglass.com` opens the landing page over HTTPS, root
  redirecting to `rrsfinestautoglass.com/r-r-s-finest-auto-glass.html`.
- Evening graphics work on that site (all live): the "Bubba Head" / bubble-head
  3D owner illustration (cap on, muscles, suction lifter — **not** a buffer)
  is the hero, on a black background, with the car, red suction cup on a
  **spiderweb-cracked windshield** — Pedro: "we repair windshields, we don't
  just make them pretty when they're already not broken." Real logo is the
  header + tab icon; the chrome-badge sports-car logo is gone; the other car
  graphics added earlier were removed. Captions say "Fixing a cracked
  windshield with a suction lifter" / "Cracked windshield? We fix it right."
  The "Read or leave a review" link now points to the same direct review form
  as the QR code (not the listing page); "Find us on Google Maps" is the
  directions link and stays as-is. The share-card image still showed Pedro's
  real photo at last check — rebuilding it with Bubba Head was offered, not
  yet confirmed.

### Google Business Profile

- Listing already existed: R&R's Finest Auto Glass, 118 Terrace St,
  Boston MA 02120, 857-266-1284, Mon–Sat 8–6, Sun closed, 5.0 with 2 reviews
  (Courtney Cummings 5 stars with text, Elder Antunes 5 stars rating only),
  805 profile views in last 28 days, category "Auto glass repair service" only.
  Wrong attribute on Maps: "Has oil change" — flagged, not yet corrected.
- Ownership correction 2026-11-13: the profile is **not** under
  rrsfinest1@gmail.com (that account showed "0 businesses"). Owner account is
  "Pvelez" (Pedro's personal Google account; full email not confirmed — do not
  guess). Pedro added managing rights himself; rrsfinest1@gmail.com then showed
  1 business, Verified.
- Website field: first swapped 22:07 EST from
  `https://rr-finest-auto-glass.vercel.app/` to the GitHub Pages URL, verified
  live on Search + Maps 22:10 EST. Later the same night swapped again to
  `https://rrsfinestautoglass.com`, verified on a fresh public Google Search
  23:17 EST. Only the Website field changed each time; a separate pre-existing
  pending description edit was left untouched. The saved Secure Vault password
  for rrsfinest1@gmail.com was rejected by Google as "Wrong password" on
  2026-11-13 — outdated/wrong, do not reuse as-is.
- Maps listing link (for review asks):
  `https://www.google.com/maps/place/R%26R%E2%80%99s+Finest+Auto+Glass/@42.3283092,-71.1006893,17z/data=!3m1!4b1!4m6!3m5!1s0x89e379d93d34dd6d:0x93d3a1afa490a393!8m2!3d42.3283092!4d-71.098109!16s%2Fg%2F11y9grh500`
  — listing link, not a one-click write-a-review link (needs Google sign-in).
- Old Vercel site (the one that was on Google before):
  `https://rr-finest-auto-glass.vercel.app` — headline "MOBILE AUTO GLASS
  SERVICE IN MASSACHUSETTS", hours Mon–Fri 8–7, Sat 9–5, Sun closed
  (**conflicts** with Google Mon–Sat 8–6). Still in PREVIEW: gold banner on
  every page, Privacy page is DRAFT, /quote form does NOT send yet — visitors
  must call. Needs Pedro to confirm hours, address, and to make the quote form
  live before it can take leads.

## 4. Intake + Case Core downtime (the day's outage)

- Intake: `https://rnr-case-staging-zero-to100-edu.vercel.app/intake` —
  "R&R Case Operations", 3 steps, no case created until Step 3 Send request.
  Step 1 vehicle (VIN scan/photo of sticker or type VIN, or year/make/model);
  Step 2 glass (Windshield / Back glass / Door glass / Quarter glass / Vent
  glass, up to 6 damage photos optional); Step 3 contact (name, 10-digit mobile,
  service address); then R&R reviews it and texts a quote link; customer
  approves before any work/charge. No phone, email, hours, or service area on
  the intake page itself. Dashboard via header "All cases"; site root is
  staff-only sign-in.
- Funnel: browser → Vercel web → same-origin proxy → Vercel API → Supabase
  Postgres (project `rnr-case-core`); intake POST is
  `POST /api/v1/public/intake`. Last staging deploy #138 (Nov 3, 2026, commit
  `793e949`) was SUCCESS — all 22 steps green incl. DB migrate, live health,
  staff login, proxy check, live create-case check, Playwright smoke — and
  nothing had deployed to staging since.
- **Vercel Deployment Protection turned OFF 2026-11-13 ~23:30 EST** (Pedro
  signed in to Vercel himself; Vercel Authentication disabled on `rnr-case-web`
  — there is no separate Vercel project named
  `rnr-case-staging-zero-to100-edu`; the staging URL is a domain on the
  staging-branch Preview deployment of `rnr-case-web`). Intake now loads
  publicly, verified the same night.
- **Root cause, resolved 23:36 EST: the staging database was PAUSED, not
  deleted.** Supabase project `rnr-case-core-staging`
  (ref `tvfrfkxyvicnjibjhloa`, us-east-1, Free plan, org Zeroto100edy) was
  paused Nov 13, 2026 after 7 days inactivity. Free projects are deleted after
  90 days paused, so it would have been deleted Feb 11, 2027 if not restored.
  Pedro resumed it himself ~23:35 EST. **Restoration confirmed healthy
  23:47 EST** — `/api/v1/health` returns `ok:true`, storage `postgres`.
  Second project `rnr-case-core` (ref `eevizffcfuszebtwbhxo`) is also paused,
  resumable until Nov 12, 2027; it is NOT the staging DB.
- Supabase had a real incident Nov 12 (database connection errors + elevated
  API errors, resolved that evening) — that could have broken case creation
  Nov 12, but it is NOT the cause now; Supabase shows operational now.
  Vercel platform operational Nov 13/14, no incident.
- Earlier in the evening the intake + health returned the Vercel login wall to
  an unauthenticated visitor, so the intake POST never happened; once the wall
  came down, health answered with an internal error instead — the DB failure
  underneath (API logs: DB user does not exist at the address it connects to;
  intake error logged 23:17). That is now resolved by the resume above.
- **Vercel has NO GitHub integration** — no git repo connected to
  `rnr-case-web` / `rnr-case-api`, so pushing a branch deploys nothing
  (confirmed in Vercel dashboard 23:45 EST; only staging/main ever deployed,
  newest Nov 3; commit shows no checks even 23 min after push).

## 5. The VIN brain — what it is

- **Origin question:** VIN scanned off the door jamb → what windshield / parts /
  oil / filter the car takes, distance to the shop, what to ask.
- **Whole-car scope (from 20:33 EST):** every part, exterior, interior,
  engine/motor, and everything in between, plus where to source each part.
  Glass is one category inside it.
- **Key limit:** VIN alone does not give the exact windshield variant (rain
  sensor / ADAS camera / HUD / acoustic / heated) — follow-up questions or a
  photo are still needed.
- **What closes the gap:** (1) the build sheet / datacard — factory list for
  that exact VIN (option/package/paint/interior codes); (2) the OEM parts
  catalog / EPC — exploded diagrams showing where parts are; (3) the door-jamb
  label — proved live on VIN `WDD5J5BB2LN065797`, a 2020 Mercedes-Benz CLA-Class
  AMG CLA35 4M, 2.0L M260 turbo, 302 hp, built Kecskemét, Hungary: tires fully
  settled by the label (245/35 ZR19 (93Y) Extra Load front and rear, 44 PSI
  front, 41 PSI rear, no spare), plus GVWR / weights / build date.
- **Live catalog (synced 2026-11-13):** 4 vehicles, 37 part rows — Tacoma (most
  complete), HR-V, Sienna, plus 2018 Camry 2.5L from R&R job #020545
  (oil 0W-16, not 0W-20). Tacoma corrections: battery `variant_ambiguous`
  (Group 24F or 35 by trim, NOT 34R), front brake pads three OEM numbers
  (04465-04070 / 04080 / 04090, `variant_ambiguous`), coolant capacity omitted
  (sources conflict). Sienna windshield FW03760 GBY filled in live from the
  actual referral sheet. Customer names stripped from the shipped catalog
  (job reference numbers only).
- **Track 3 prototype** (artifact slug `r-r-vin-api`, live NHTSA decode verified
  on real VINs), spec v0.2 whole-car: response model has
  exterior / interior / engine / mechanical categories, every part with part
  number + `variant_status` + source, `price_range` / `availability` null until
  supplier feeds exist.
- **Track 1 voice design:** customer talks instead of typing; transcription
  happens on-device (same pattern as the Muse app's voice input) and only the
  transcribed text goes to the intake — audio never leaves the customer's
  phone; typed and spoken input converge on the same text pipeline.
- **Pricing draft (Pedro has NOT set his price):** $0.15 decode / $0.85
  decode+glass / $1.25 full vehicle / +$0.10 location.
- **Nothing in any track publishes, sends, orders, invoices, or charges
  without Pedro's explicit go-ahead.**

### Patent check — conclusion

- General-form idea very likely **not patentable**: all four pieces in general
  form — VIN lookup, chatbot intake, shop brain, pay-per-lookup API — very
  likely fail on novelty and on the rule that you cannot patent an abstract
  idea just by running it on a computer. A utility patent would run about
  **$15,000–$25,000 through grant (estimate, not a quote)** and take roughly
  2–3 years. Report's advice: spend the money building the service and protect
  it the cheap ways — trade secret for know-how and processes, trademark for
  the name/brand. Specific novel technical pieces could still be worth a
  separate look; the general idea as described is not the patent.

### Market / viability report — conclusion

- Delivered 2026-11-14, 21 pages, revised to whole-car (24 pages):
  local file `~/workspace/your_files/vin-brain-viability-report/vin-brain-viability-report.pdf`
  (not in this repo — copy it in if Pedro wants it here).
- Sequence: **build Layer 1 (talking intake) first, Layer 3 (shop ops)
  alongside, Layer 2 as the data foundation, Layer 4 (sell the API) last.**
- At the proven $1/lookup anchor, Layer 4 alone is only ~$50k/yr at 1% of US
  glass shops; its pricing cannot be set until Mitchell (NAGS licence) and
  Mygrant (live-cost feed) prices are quoted.
- US market $8.9bn (IBISWorld Feb 2026); MA ~$150–190m/yr and Boston metro
  ~$110–130m/yr are **labelled estimates** — no published MA/Boston figure
  exists.
- Whole-car revision: (a) glass alone, (b) whole-car parts TAM $229.31bn/yr
  parts-only (Mordor 2025) with MA ~$3.9bn/yr ESTIMATE, (c) whole-car API
  ceiling ~$281m/yr arithmetic at the $1.25 full-vehicle draft price × 2,500
  lookups/shop/yr × 89,895 core shops — 1% of New England alone ~$113k/yr.
  Layers 2 and 4 are now the big prize; sequence unchanged (Layer 1 first,
  Layer 4 last, licences priced first).

## 6. The four MVP layers — branches, commits, tests, test URLs

All four branches were cut fresh from `main @ 68a9fc83`. All four MVPs were
built, tested, and pushed. **Main is untouched by all four. No PR opened.
Nothing merges without Pedro + Lou.**

Fork note (applies to all four): a true fork was **not** possible — the
authenticated GitHub user is jonly03, own repo; GitHub will not fork your own
repo (403 / connector errors). Branch-in-repo is the isolation. Branch names
also deviate from `docs/branching.md`'s `feature/<slug>` convention per
Pedro's explicit instruction.

| Layer | Branch | Commit | Test URL for Lou | Tests |
|---|---|---|---|---|
| L1 Talking Intake | `mvp/layer-1-talking-intake` | `2f38a46` | **Pending** — deploy run #139, 23:46 EST (see below) | 155 passed, 0 failed; build passes |
| L2 VIN-to-Anything | `mvp/layer-2-vin-anything` | `9f2e30b4` | **Live:** https://muse.ai/s/r-r-vin-api-layer-2-mvp-wxz6xmdp5xvnwxo/aVI7KbPMUeOXoPC8auyLBhAqXVRV2mMHwqknawlFASc | 44 passed, 0 failed (live NHTSA) |
| L3 Shop Ops | `mvp/layer-3-shop-ops` | `efc64b8` (MVP `1865657`) | **Local only** — clone branch, `cd shop-ops`, `python3 -m http.server 8000`, open `http://localhost:8000/` | extract 8/8, logic 17/17, smoke 11/11 |
| L4 Sellable API | `mvp/layer-4-sellable-api` | `87e70e39` | **Local only** — `http://127.0.0.1:3000` (`node vin-api/server.js`) | 45 passed, 0 failed (live NHTSA) |

Branch SHAs verified via `git ls-remote` 2026-11-13 23:48 EST:
`main 66bab77`, `mvp/layer-1-talking-intake 2f38a46`,
`mvp/layer-2-vin-anything 9f2e30b`, `mvp/layer-3-shop-ops efc64b8`,
`mvp/layer-4-sellable-api 87e70e39`, `gateway/brain-door 58025f0`,
`staging 793e949`.

### L1 — Talking Intake (`mvp/layer-1-talking-intake`, `2f38a46`)

- Chat at `/chat` in `apps/web`: `ChatIntake.tsx` (1,254 lines),
  `chat-intake.ts` (438), tests (345); `IntakeLiveStatus` moved verbatim to its
  own module; `App.tsx` −95 net; styles +26; shared
  `config/vin-brain-pricing.json` with API prices + customer quote ranges.
  Pushed commit `2f38a4659c89837e8976c952eae813c293ba92e4`.
- What it does: chat in English or Spanish. Customer scans or types the VIN
  (or gives year/make/model), picks the glass, sends a damage photo, gets a
  chip-vs-replacement call, says insurance or cash, gives address and when,
  then name and phone. Creates the case the exact same way the form does today
  — same fields, same submit (`submitPublicIntake`, same FormData as the form;
  insurance/cash/when/verdict ride in `note`), then shows the quote link to
  sign. Reuses `VinStickerScanner`, NHTSA decode, `suggestAddresses`,
  `IntakeLiveStatus`.
- Voice honest limit: **no web API can prove on-device transcription**, so Talk
  stays OFF by default with a can't-verify badge pointing to the phone keyboard
  mic (the real on-device path); browser-cloud voice only as explicit labelled
  opt-in.
- Verified: `npm test` 155 passed 0 failed, `npm run build` passes,
  `/chat` + `/intake` serve 200 in local smoke test. **Not** claimed: no live
  mic test, no live NHTSA from a phone, no end-to-end submit against a running
  API, no 5 real customers — those are Lou's black-box steps.
- Test URL problem: Vercel has no GitHub integration (see §4), so pushing the
  branch deployed nothing; no preview showed on the commit page 23 min after
  push. Deploy run **#139** of `deploy-staging.yml` was dispatched 23:46 EST
  on the L1 branch to produce a preview URL. **Warning:** that workflow also
  moves the staging alias to the L1 build until staging is redeployed; the
  preview link itself is Lou's own and stays live either way. A watch checks
  every 10 min until 00:46 EST and delivers the verified public URL to Pedro.
- Lou's black-box steps: open the preview, talk or type through a full job,
  check the case lands in the dashboard with the right fields and the quote
  link comes up, try the voice button and note what the badge says, do it with
  5 real customers.
- L1 is parked on its branch per the 23:23 EST gateway pivot.

### L2 — VIN-to-Anything (`mvp/layer-2-vin-anything`, `9f2e30b4`)

- 9 files in `vin-api/`: `index.html`, `lookup.js`, `door-jamb.js`,
  `catalog.json`, `config.json`, `API_SPEC.md`, `README.md`, `tests/`.
- What it does: VIN + door-jamb photo returns **whole car**, categories
  exterior / interior / engine / mechanical. Every part: part number,
  `variant_status` confirmed vs `needs_confirmation`, source. Door jamb closes
  tires (e.g. 245/35 ZR19, pressures), weights/GVWR, build date.
- Verified: tests 44 passed, 0 failed (`node tests/run-tests.mjs`, NHTSA live;
  4 demo VINs + CLA35 `WDD5J5BB2LN065797` decode correctly). Reused: v0.2 spec
  and the 4-vehicle, 37-part catalog from the Track 3 files; prototype lookup
  flow (validate → NHTSA → catalog match); repo's own VIN code —
  `apps/api/src/vin-decode.ts`, `vin-validation.ts`, `vin-ocr.ts` (Tesseract
  pattern, O→0 / I,Q→1 fix).
- Test URL: public Muse artifact mirror of the branch code (branch is the
  source of truth):
  `https://muse.ai/s/r-r-vin-api-layer-2-mvp-wxz6xmdp5xvnwxo/aVI7KbPMUeOXoPC8auyLBhAqXVRV2mMHwqknawlFASc`
  — audit passed (no console errors; pricing panel $0.15/$0.85/$1.25/+$0.10;
  invalid VIN shows `invalid_vin`). Caveat: the audit sandbox blocked outbound
  calls so the live NHTSA decode could not be exercised inside it — the page
  surfaced the spec-correct `upstream_error` instead; live decode was verified
  separately at build time and by the branch suite (44/0).
- Lou's black-box steps (full list in the branch README): Tacoma (windshield
  FW04108 GTY `needs_confirmation`, battery `variant_ambiguous` 24F or 35,
  front pads `variant_ambiguous` 3 OEM numbers, rotors 43512-04052 confirmed,
  oil 0W-20 6.2 qt, full vehicle $1.25); HR-V (FW05907 GTY, cabin filter
  80292-TF0-G01 confirmed, tires `variant_ambiguous`); Sienna (FW03760 GBY
  confirmed, battery Group 35 confirmed); 2018 Camry (oil 0W-16 not 0W-20,
  4.8 qt; windshield "license required", no part number); CLA35 AMG (decodes
  right, all categories null with a note — not in catalog yet); bad VIN `123`
  → `invalid_vin`, no charge; door-jamb photo / manual fields flip Tires to
  confirmed; every part shows no price and no availability — if any part shows
  a price, that is a bug.

### L3 — Shop Ops (`mvp/layer-3-shop-ops`, `efc64b8`)

- 12 files in `shop-ops/`, +2,040 lines: `index.html`, `app.js`, `parser.js`,
  `logic.js`, `config/pricing.json`, fixtures
  (`synthetic-jobs.json` + `synthetic-referral-1.txt`, 8 synthetic jobs),
  `tests/`, `README.md`. Base: main @ `68a9fc8`. Commits `1865657` (MVP) +
  `efc64b8` (label cleanup). Root `index.html` untouched (zero diff on root files).
- What it does: Safelite referral PDF auto-read to job (referral #, customer,
  vehicle, NAGS, approved amount, insurer/deductible), Mygrant order draft from
  a booked job, invoice draft on the 10-day clock, true profit =
  invoice − glass − tax − glue ($22.66/job, 1.5 tubes) − labor, daily brief +
  mobile route, tech helper for an exact VIN (trim, cure time, recalibration).
  Drafts only — nothing sends, orders, or invoices.
- Reused: referral parser is a line-for-line port of verified
  `referral_intake.py` `parse_sheet` (not a new parser; #833614
  masked-number/truncated-name override kept explicit; #775727 `NO COV` mask);
  business-system formulas + Lists (Gross = Invoice − Glass − Tax;
  Net = Gross − Glue − Other); glue $22.66/job. Mygrant browser service was
  read (`services/mygrant-browser` — headless-Chromium fetcher needing a
  deployed service + secrets); it does not fit a static, no-server, no-live-
  ordering MVP, so ordering drafts with the same semantics (NAGS part, ship-to
  C034125-001) and the README names the service as the integration point.
  No live order, no login.
- Verified: extraction **8/8, 0 mismatches** (Python parser vs
  `safelite-jobs-data.json`, JS in-browser parser vs same ground truth,
  synthetic-PDF round-trip); profit example $642.75 − $154.95 − $4.46 − $22.66
  − 2h×$40 = **net $380.68**, glue counted once (glue-mode "general expense" →
  glue $0 here, flagged, net $403.34; labor unknown → net flagged "excludes
  labor", never invented); invoice draft install 2026-10-18 → deadline
  2026-10-28, due-today/overdue states, W-9 reminder on first Progressive
  invoice, amount flagged "approved amount, not confirmed billed total, NOT
  money received", VIN flagged as not on the sheet; daily brief right on
  2026-10-18 (HR-V install + bill deadline + Maps route link), and 2026-11-20
  (no jobs) says "No jobs in the jobs data for this date" — never claims the
  day is clear. `logic_test.js` 17/17 + `smoke_test.js` 11/11.
- Bugs found and fixed during verification: money math leaked binary floats
  ($483.34000000000003) — cents rounding added; a real syntax error in `app.js`
  (overdue branch, unclosed string) — caught by `node --check`, fixed, smoke
  test now exercises that branch; invoice draft showed "—" for not-yet-invoiced
  jobs — now drafts at the approved amount (flagged); brief `isEmpty` wrongly
  counted date-independent open items — now means nothing booked that date.
- Test URL: **no Pages preview for `mvp/**` branches** — the repo's preview
  workflow (`pages-preview.yml`) only triggers on `workflow/**`,
  `feature/**`, `fix/**`, `chore/**`. Lou runs it locally (see table).
  `index.html` from `file://` works for most tabs; Pricing tab and fixture
  loads need the server.
- Lou's black-box steps (9, full list in `shop-ops/README.md`): synthetic PDF
  drag-in → #700006, $1,117.58, recalibration required; paste sheet text →
  parse → create job (duplicate create refused); 8 synthetic demo jobs → set
  labor hours; order draft (NAGS FW02584 GTY, ship-to C034125-001) → enter
  glass $154.95 + tax $4.46 → lands in profit; invoice draft → deadline, W-9,
  approved-amount flag; profit tab → flip glue to "General expense" → never
  double-counted; brief for 2026-10-18 and a blank date; tech helper with VIN
  `1HGCM82633A004352` → 2003 Honda Accord (live NHTSA decode verified);
  pricing tab → $0.15 / $0.85 / $1.25 / +$0.10, marked draft.
- Open notes: the parser carries one real name in the #833614 override (see
  §1 rule 9); `/tmp/pdfvenv` (the `referral_intake.py` shebang path) no longer
  exists — the verified parser's documented runtime path is stale; worth a fix
  outside this MVP. L3 was finished and verified, but its workflow was stopped
  by the 23:23 pivot — Pedro to decide whether the branch stays as-is for
  later integration or stops here.

### L4 — Sellable API (`mvp/layer-4-sellable-api`, `87e70e39`)

- Files under `vin-api/` on its own branch: standalone Node server
  (`server.js`, no dependencies, no Vercel, no other layer),
  `config/pricing.json`, `data/catalog.json`, `API_SPEC.md`, `README.md`,
  `package.json`, `test/test-api.mjs`.
- Endpoints: `POST /v1/lookup`, `GET /v1/lookup/{vin}`,
  `POST /v1/lookup/batch`, `GET /v1/glass/{nags}`, `GET /v1/health`.
  X-API-Key auth, per-key monthly quota (402) and rate limit (429), ISO
  check-digit validation (400). Errors: 400 `invalid_vin` / 401 / 402
  out_of_credits / 404 vin_not_found / 422 `variant_ambiguous` / 429 / 502
  upstream. **Failed / invalid / not-found lookups never charge a credit** —
  only a successful decode charges 1 credit.
- Verified: tests **45 passed, 0 failed** (`node test/test-api.mjs`, live
  NHTSA). Test VINs: Tacoma `3TMAZ5CN3GM000001`, HR-V `3CZRZ1H55PM000001`,
  Sienna `5TDZK3DC8DS000001`, Camry `4T1B11HK1JU000001`,
  Accord `1HGCM82633A004352` (decode-only, not in catalog). Verified:
  no-charge-on-failure, 402, 429, batch charging, glass lookups free.
  Caveats: the 502 path is implemented but untested live (NHTSA stayed up);
  quotas are in-memory, so restarting the server resets them.
- Test URL: **local only** — `http://127.0.0.1:3000`. No public URL. Lou runs
  it himself; deploying one publicly is out of scope and needs Pedro's go-ahead.
  Lou steps: `git clone -b mvp/layer-4-sellable-api
  https://github.com/jonly03/rnr-workflow.git`, then `node vin-api/server.js`;
  `curl http://127.0.0.1:3000/v1/health` → `ok`, 4 catalog vehicles;
  `curl -H "X-API-Key: rr-demo" -X POST http://127.0.0.1:3000/v1/lookup
  -d '{"vin":"3TMAZ5CN3GM000001"}'` → Tacoma, windshield FW04108 GTY, $1.25;
  full suite `npm --prefix vin-api test` → 45 checks; error keys `rr-test-low`
  (quota 1 — second lookup is 402), `rr-test-rate` (5/min — 6th rapid request
  is 429). Full details in `vin-api/README.md` on the branch.
- **Integration conflict to reconcile later:** L2 also built its MVP under
  `vin-api/` on its own branch — the two `vin-api/` trees will need reconciling
  at integrate time.

## 7. Gateway / Door — the pivot (current direction)

- **Idea:** one door in front of Muse that wraps the existing system, so web,
  WhatsApp, Siri, and phone all talk to the same brain — instead of rebuilding
  the logic 4 times in 4 codebases. One thin door, one API, the app talks to that.
- **Branch:** `gateway/brain-door` in the same repo, no fork, no merge to main,
  root `index.html` untouched. HEAD `58025f0` (verified 23:48 EST).
  Commits: `1494ed8`, `7ab0fbb`, `8cde81e` (gateway MVP), plus `19d4a3a` and
  `58025f0` (bringing the branch up to main for landing-page graphics only).
- **What is on the branch:** `gateway/server.js`, `gateway/tools.json`,
  `gateway/config/pricing.json`, `gateway/data/catalog.json`,
  `gateway/test/test-gateway.mjs`, `gateway/README.md`, plus
  `apps/api/src/gateway.ts`, `gateway-audit.ts`, `gateway-catalog.ts`,
  `gateway-pricing.ts`, `apps/api/config/brain-pricing.json`,
  `apps/api/config/vehicle-parts-catalog.json`.
- **Build:** single gateway `POST /brain` + MCP tool definitions:
  `decode_vin`, `get_vehicle`, `create_case`, `get_case_status`,
  `lookup_part`, `quote`, `order_glass` (staff-only). X-API-Key auth, single
  pricing config (defaults $0.15 / $0.85 / $1.25 / +$0.10, parameterized),
  audit log every tool call, health endpoint.
- **Boundaries (from the already-completed inspect of main HEAD `68a9fc83` —
  do NOT re-inspect from scratch):**
  - Case creation is `POST /api/v1/public/intake`, no auth, rate limit 20/10 min,
    zod schema, `customer_name`, `customer_phone` (10 digits), `glass_type`
    WINDSHIELD | BACK_GLASS | DOOR_GLASS | QUARTER_GLASS | VENT_GLASS,
    `service_address` JSON, VIN 17-char check-digit OR year/make/model, photos
    max 6, vin_photo max 1. Channel DIRECT, state REQUEST_RECEIVED, reference
    RRA-style, 201 client-safe only.
  - VIN decode is NHTSA `decodeVinNhtsa` in `apps/api/src/vin-decode.ts`, free.
    Paid VIN→glass is MyGrant only, staff-only, WINDSHIELD/BACK_GLASS only,
    $1/lookup, spend-capped, cached.
  - State machine in `docs/workflow/workflow-spec.md` — extend it, never weaken
    it. Paid lookup only staff-confirmed.
  - Whole-car is NOT in the repo yet — only the glass model exists. The gateway
    must return categories exterior/interior/engine/mechanical with
    `variant_status` confirmed vs `needs_confirmation`, and never guess.
    Price/availability null until a supplier feed exists.
- **Proof test (not yet run end-to-end):** send plain language "2020 Mercedes
  CLA35 AMG VIN WDD5J5BB2LN065797 windshield cracked in Dorchester" — expect
  decode to 2020 CLA-Class AMG CLA35, ask follow-ups for rain sensor / ADAS,
  do NOT guess glass, then complete a case through the gateway and get a 201
  with reference + `status_token`. Lou will black-box test it.
- **Status — be honest about this:** the gateway **code is pushed**, but there
  is **no verified gateway from the workflow runs yet**. Run 1
  (`workflow-run-5644300ce00a4a0eae43adc1539ccc9f`, launched 23:24 EST) failed
  23:43 at the build handback — the build agent returned prose instead of JSON,
  so the run stopped before testing. Relaunched 23:44 as
  `workflow-run-687a018f490046aea3ef4533b5c1516b`, resuming from the failed run
  (map result reused), with recovery notes to finish the test URL and return
  JSON only. A separate gateway workflow run failed after the build-door agent
  timed out after 20 min with no result; test-door never ran. The gateway
  handles the paused staging DB with a simulated path and a re-check button in
  the meantime (DB is now healthy — see §4 — so re-check before relying on the
  simulated path).
- **Next step for the next agent:** check what is actually on
  `gateway/brain-door`, run the gateway in small pieces (not one 20-min build),
  finish the test URL, run the proof test above, and report branch + test URL +
  tools + Lou's steps. Do not re-run the whole workflow from scratch.

## 8. SEO / red-team audit (in progress, not finished)

- Pedro asked for a comprehensive red-team audit: crawlers on the site itself
  (titles, descriptions, share tags, structured data, headings, links, sitemap,
  mobile, quote form), on Google as a customer would search it (name + windshield
  / auto glass searches for Roxbury, Dorchester, Boston — rank, Maps pack, who
  beats him), and on every listing (Google, Yelp, …).
- Headline from the crawlers (unverified until the corrected PDF lands): on
  Google he basically only exists if someone already knows his name — out of
  10 searches tested, he showed up in 2, both branded, both just as a place
  card. On all 8 money searches (windshield replacement Roxbury, auto glass
  repair Boston, mobile auto glass, …) he was nowhere in the top results and
  not in any local pack.
- **The 12-page draft PDF was NOT handed to Pedro** — it was read first and
  found to have errors: it claimed rrsfinestautoglass.com does not exist yet
  and told him to register it as a fix (he bought it that night, it is live,
  and Google already points to it); it listed duplicate FAQ and hero sections
  as defects that a source check showed are not in the page at all; and it
  flagged the Yelp rating as not re-verified live that night. It was sent back
  for corrections on all of that.
- **Update (2026-11-14, after this trail was first written): the corrected
  audit was delivered** — overall **38/100**, "Findable by name. Invisible
  where it counts." Branded search passes (85/100); absent from all 8 generic
  money queries and both Boston best-of lists; root cause is review volume
  (Google 5.0 with only 2 reviews vs competitors' 44–103), single GBP
  category, no services list, no sitemap, single-page site, no prices. Yelp
  3.0/2 reviews was NOT re-verified live Nov 13–14. Branded merch on Instagram
  shows wrong phone 857-468-2946 — Pedro to confirm if old number or print
  error. Fix order: funnel health first, then review asks (drafts ready), then
  profile completion. Report:
  `~/workspace/goals/r-r-s-finest-auto-glass-marketing-launch/files/rr-finest-visibility-audit/visibility-audit.pdf`
  (12 pages). Quote the corrected report, not the draft.

## 9. Chats — where each thread lives

Chat IDs are Muse side-chat IDs, for the next agent to open with
`chat.read_messages`. The main chat holds the day's running record; these are
the dedicated threads.

| Chat | ID |
|---|---|
| R&R MVP L1 — Talking Intake Branch | `31944d64-041b-47aa-af42-dc8c9530e847` |
| R&R MVP L2 — VIN-to-Anything Branch | `cdf08cfc-985c-4878-838d-16b5e9740227` |
| R&R MVP L3 — Shop Ops Branch | `169c6e7c-d83b-48fd-86ce-9e7fe6e81586` |
| R&R MVP L4 — Sellable API Branch | `0227ce16-e12f-4243-8a98-25c30eb41b81` |
| R&R Brain Gateway — The Door | `a1120dbd-7449-42fd-a192-0583eec89f0c` |
| Vehicle parts lookup API (origin: 3 tracks, layers, pivot) | `144d4d14-c511-4afb-a4c1-23125e0751a9` |
| R&R Chat Intake — Conversational VIN (Track 1) | `de6e2d6b-e836-430d-a69e-415fff4e3114` |
| R&R Shop Ops Brain (Track 2) | `5bb8e2ba-bbf2-4492-a483-4c68b7e4db0d` |
| R&R VIN API — Sellable Service (Track 3) | `2f00ae59-0474-4126-85ea-eed1960f8628` |
| R&R Patent Check — VIN Brain | `0a624599-7e0b-403e-b167-8843cedce9d6` |
| R&R Market Research — VIN Brain TAM | `e3c6859f-a9cc-428b-8714-29daa0dd12c4` |
| Generate auto glass leads in Boston (landing page + Google profile) | `4a9d9f99-0ab3-4d20-88c8-d87c29d0b3b4` |
| Buy R&R's Finest domain (domain + Bubba Head graphics + review link) | `a374b92f-39ce-4865-b3fa-6f2f171fdc2d` |
| Troubleshoot Case Core downtime (Supabase pause + SEO audit) | `b1dd1a22-2402-4ab7-bf61-90ed2d76d4d7` |
| This trail — Document R&R workflow in repository | `2a9c3a1b-4989-40d9-95da-5c8307fb5551` |

## 10. Open items for the next agent

1. **L1 test URL:** deliver the verified public preview URL from deploy run
   #139 (watch until 00:46 EST). Confirm the staging alias side-effect with
   Pedro, and re-check case creation now the DB is healthy.
2. **Gateway:** verify `gateway/brain-door` in small pieces, finish the test
   URL, run the proof test in §7, report branch + test URL + tools + Lou steps.
   Do not re-run the whole workflow from scratch.
3. **L3 decision:** Pedro to decide — does `mvp/layer-3-shop-ops` stay as-is
   for later integration, or stop here, now the workflow that built it is stopped?
4. **L2 vs L4 `vin-api/` conflict:** reconcile the two `vin-api/` trees at
   integrate time (L2: static lookup page + catalog; L4: Node server + pricing).
5. **SEO audit:** deliver the corrected PDF; do not quote the draft.
6. **Google profile:** fix the wrong "Has oil change" attribute; confirm the
   share-card image (Bubba Head vs real photo) with Pedro; confirm hours
   (Google Mon–Sat 8–6 vs Vercel site Mon–Fri 8–7, Sat 9–5) and make the Vercel
   /quote form live before it can take leads.
7. **Pricing:** Pedro still has not set API prices — draft defaults only
   ($0.15 / $0.85 / $1.25 / +$0.10). Mitchell (NAGS licence) and Mygrant
   (live-cost feed) prices still need quoting before Layer 4 pricing can be set.
8. **Supabase:** staging will pause again after 7 days idle. Either touch it
   weekly or move it off the Free plan before it matters. `rnr-case-core`
   (non-staging) is also paused — resumable until Nov 12, 2027.
9. **Viability report PDF** lives only locally
   (`~/workspace/your_files/vin-brain-viability-report/vin-brain-viability-report.pdf`).
   Copy it into this repo if Pedro wants it here.
10. **L2 public URL:** the L2 test URL is a Muse artifact mirror, not a Vercel
    deploy (Vercel is not connected to GitHub). If Pedro wants it on Vercel,
    that needs his sign-in.

## 11. Repo map (main, at trail time)

- `index.html` — R&R Workflow demo suite homepage (do not overwrite).
  Now links to the landing page.
- `r-r-s-finest-auto-glass.html` — the live landing page.
- `apps/web/` — case web app, incl. L1 chat intake on its branch
  (`ChatIntake.tsx`, `chat-intake.ts`).
- `apps/api/` — Case Core API, incl. VIN decode (`src/vin-decode.ts`),
  gateway code on its branch (`src/gateway*.ts`, `config/brain-pricing.json`).
- `docs/` — workflow spec (`docs/workflow/workflow-spec.md`), branching
  (`docs/branching.md`), client / plans / platform / project docs.
- `services/mygrant-browser/` — Mygrant headless-Chromium fetcher (needs a
  deployed service + secrets; L3 names it as the integration point).
- `architecture/case-core-contract-v0.1.md`, `brand/brand-book-v0.1.md`,
  `design/design-guide-v0.1.md`, `product/requirements/`,
  `validation/client-validation-register-v0.1.md`.
- Branches (verified 2026-11-13 23:48 EST): `main 66bab77`,
  `staging 793e949`, `prod`, `gh-pages`, `plan/quote-to-closeout`,
  `plan/tech-dispatcher-tracking`, plus the four `mvp/*` branches and
  `gateway/brain-door` in §6–§7.

---

*Trail written 2026-11-13 (late evening EST) from the day's chats, the repo
(`git ls-remote`, branch logs), and Pedro's decisions as recorded that day.
Where a result was still pending at trail time (L1 preview URL, gateway
verification, corrected SEO audit), this file says so — do not present those
as done until they are verified and this file is updated.*
