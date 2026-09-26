# R&R Case Core Web v0.1

React staff shell for issue #26.

## Run

```bash
cd apps/web
npm install
npm test
npm run dev
```

By default the UI expects the Case Core API at:

`http://localhost:3001/api/v1`

Override with:

`VITE_API_BASE_URL=https://example.com/api/v1`

## Implemented

- Case Queue using real API data
- New Case form
- required field validation
- Direct / Auction / Insurance channel selection
- Case Detail
- humanized state + canonical state ID
- full staff VIN display
- activity timeline newest-first
- responsive desktop/mobile layouts
- keyboard-visible focus states
- no paid VIN lookup
- no fabricated workflow actions
