# MyGrant HTML fixtures

Captured 2026-09-29 from the live MyGrant site (mygrantglass.com) using the
shop account. Exactly one $1 VIN lookup was ever made; everything else here
is from free pages (forms loaded without submitting, YMM search, part-number
searches).

## Provenance

| File | Source |
|---|---|
| `vin-search-form.html` | Sanitized verbatim capture of `searchvin.aspx` (form only, no submission) |
| `ymm-search-form.html` | Sanitized verbatim capture of `searchm.aspx` (form only, no submission) |
| `ymm-results-2020-honda-a.html` | Sanitized verbatim capture of `searchm.aspx?yr=2020&mk=Honda&md=A&smdo=Search` |
| `part-search-dw02415-gty.html` | Sanitized verbatim capture of `search.aspx?q=DW02415+GTY&sc=B036&do=Search` |
| `part-search-dw02416-gty.html` | Sanitized verbatim capture of `search.aspx?q=DW02416+GTY&sc=B036&do=Search` |
| `vin-results-wrangler-reconstructed.html` | **Reconstructed, not verbatim.** Built from field notes of the single $1 VIN lookup (2018 Jeep Wrangler, `1C4HJXEG3JW224862`, Windshield). All selectors are real; nesting is best-guess. |

## Sanitization

Redacted from every verbatim capture: login email, shop name, ship-to /
account ID, street address, phone number, quote timestamps, analytics and
tracking scripts (GTM, enzuzo), and password-manager injected markup. Header
navigation, cart sidebar chrome, footers, and help text were trimmed where
the parser does not depend on them. Each file's header comment records what
was removed and what transport facts were confirmed live.

## Rules for these fixtures

- CI must never make live or paid calls; tests use these fixtures only.
- `vin-results-wrangler-reconstructed.html` exists so parser logic can be
  exercised without spending another $1. Replace it with a sanitized
  verbatim capture the next time a real VIN lookup is legitimately run.
- Do not commit raw captures. Sanitize first, per this directory's pattern.
