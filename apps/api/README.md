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
