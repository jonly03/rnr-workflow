# mygrant-browser

Headless-Chromium service for MyGrant web automation. Deployed to Fly.io as `rnr-mygrant-browser`.

## Why this exists

MyGrant serves empty search results to datacenter HTTP clients (Vercel serverless `fetch()` calls) while working fine in a real browser. This service runs a real Chromium via Playwright, keeps a warm logged-in session, and returns rendered page HTML.

## Design

This service is intentionally **dumb**: it drives the browser and returns raw HTML. All parsing (vehicles, parts, pricing) and all business logic (cheapest-in-stock-wins, $1 VIN spend cap, audit) stays in the Case Core API (`apps/api`). If MyGrant redesigns their site, the parsers in the API are what change.

## API

All endpoints except `/health` require `Authorization: Bearer <SERVICE_SECRET>`.

- `GET /health` → `{ ok: true }`
- `POST /v1/fetch` `{ url }` → `{ html, finalUrl, bytes }`
  - `url` must be an `https://www.mygrantglass.com/` URL (SSRF guard).
  - Ensures the MyGrant session is logged in first; re-logs-in once if expired.

## Configuration (Fly.io secrets, set by the shop owner)

```
fly secrets set MYGRANT_USERNAME=... MYGRANT_PASSWORD=... SERVICE_SECRET=... -a rnr-mygrant-browser
```

- `MYGRANT_USERNAME` / `MYGRANT_PASSWORD` — MyGrant website login.
- `SERVICE_SECRET` — shared secret; the Case Core API sends it as a Bearer token. Must also be set as `MYGRANT_BROWSER_SECRET` in Vercel.

## Case Core API wiring

When `MYGRANT_BROWSER_URL` is set (e.g. `https://rnr-mygrant-browser.fly.dev`), the API's `MyGrantProvider` uses `BrowserServiceTransport` (in `apps/api/src/mygrant.ts`), which delegates page loads to this service. When unset, it falls back to direct HTTP.

## Deploy

```
fly deploy -a rnr-mygrant-browser
```

## Local dev

```
npm install
npx playwright install chromium
MYGRANT_USERNAME=... MYGRANT_PASSWORD=... SERVICE_SECRET=dev npx ts-node src/index.ts
```
