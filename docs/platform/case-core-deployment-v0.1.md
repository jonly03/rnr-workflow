# Case Core Deployment Foundation v0.1

Status: IMPLEMENTATION FOR ISSUE #93

## Topology

```text
Browser
  ↓
Vercel Web Project (apps/web)
  ↓ HTTPS
Vercel API Project (apps/api, Express)
  ↓
Supabase PostgreSQL
```

The frontend and backend are separate Vercel projects rooted at `apps/web` and `apps/api`.

## Release flow

```text
feature branch
  ↓ PR / CI
main
  ↓ deliberate promotion / merge
staging
  ↓ automatic Vercel preview deployment
live API health + live Playwright
  ↓ human-approved workflow_dispatch with exact staging SHA
production Vercel deployments
  ↓ production health + Playwright
Red Team #28
```

`main` does not deploy directly to production.

Production is rebuilt from the exact Git commit that is currently at `staging` and that passed staging validation.

## Persistence

Local development:
- `JsonCaseStore`

Staging / Production:
- `PgCaseStore`
- selected automatically when `DATABASE_URL` is present.

Migrations live under:

`apps/api/migrations/`

Run:

```bash
cd apps/api
DATABASE_URL=... npm run migrate
```

## Vercel projects

Create two Vercel projects from the same GitHub repository:

### rnr-case-web
- Root Directory: `apps/web`
- Framework: Vite
- Build: Vercel auto-detect / `npm run build`

### rnr-case-api
- Root Directory: `apps/api`
- Framework: Express
- Entry point: `index.ts`

Record:
- Vercel Organization ID
- Web Project ID
- API Project ID
- Vercel access token

## GitHub environments

Create GitHub environments:

### staging
Secrets:
- `VERCEL_TOKEN`
- `DATABASE_URL`

Variables:
- `VERCEL_ORG_ID`
- `VERCEL_WEB_PROJECT_ID`
- `VERCEL_API_PROJECT_ID`

### Glass catalog provider (MyGrant live sourcing)

The API sources glass data through a provider selected by `GLASS_CATALOG_PROVIDER`
(a repo/environment variable, **not** a secret):

- `mock` (default): deterministic mock catalog. No network, no charges. Safe
  for CI, staging demos, and client walkthroughs.
- `mygrant`: live MyGrant web automation. Requires secrets `MYGRANT_USERNAME`
  and `MYGRANT_PASSWORD` (the shop's MyGrant login, stored like the staff-auth
  secrets). Live mode fails LOUD: any auth, credit, site, or parse problem is
  a hard error — mock data is never served as live data.

MyGrant cost model: VIN lookups cost **$1 each**; YMM and part-number searches
are free. Guardrails (VIN path only):

- `MYGRANT_DAILY_SPEND_CAP_USD` (variable, default `25`): hard daily cap on
  recorded VIN-lookup spend (UTC day, DB-backed so it survives serverless
  cold starts). Breaches block the lookup before submission and surface as
  `SYSTEM_ATTENTION_REQUIRED` on the case.
- The VIN cache + single-flight claims already prevent duplicate charges for
  the same VIN + glass type; the spend ledger records every submitted paid
  lookup (including failures after submission, where the $1 may be consumed).

Optional: `MYGRANT_BASE_URL` (default `https://www.mygrantglass.com`),
`MYGRANT_TIMEOUT_MS` (default `30000`).

### production
Same names, but `DATABASE_URL` points to the production database.

Configure production environment protection / required reviewer when available.

## Staging

Any push to `staging` runs:

`.github/workflows/deploy-staging.yml`

It:
1. migrates the staging database;
2. deploys the API to Vercel preview;
3. builds/deploys the web app against that API URL;
4. calls `/health` and requires PostgreSQL;
5. runs Playwright against the live web URL;
6. stores deployment evidence;
7. comments evidence on issue #93.

## Production

Production never triggers from `main`.

Run:

`Promote Case Core Production`

and supply the exact SHA reported by the successful staging run.

The workflow refuses promotion unless that SHA is still the current `staging` HEAD.

It then:
1. migrates production Postgres;
2. deploys API with production settings;
3. deploys web against the production API;
4. runs live production health and Playwright;
5. records evidence on #93.

## Rollback

Vercel retains immutable deployments.

For an application rollback:
- use the prior known-good Vercel deployment in each project;
- restore/redirect production traffic to the prior deployment;
- do not roll back a database migration destructively without a separate reviewed migration.

For code-first recovery:
- move `staging` to a known-good commit;
- rerun staging;
- promote the verified commit.

## Safety boundary

This deployment enables Case Core only.

It does not enable:
- MyGrant login;
- paid VIN lookup;
- supplier ordering;
- purchases;
- production customer data ingestion beyond the Case Core demo flow.

Authentication remains a later launch-readiness requirement. Until then, production should be treated as an internal/demo environment, not an unrestricted customer-facing system.
