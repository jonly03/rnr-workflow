# R&R Client Validation Register v0.1

Status: ACCEPTED WORKING REGISTER — CLIENT VALIDATION REQUIRED

Purpose: collect all current educated assumptions that replaced previously open questions so the team can continue building without silently inventing product, UX, brand, or design decisions.

These are working defaults, not final client-approved decisions.

| ID | Area | Provisional decision | Client validation question |
|---|---|---|---|
| OQ-001 | Product | Use `RRA-000123` as the v0.1 human-readable case format. | Does this reference format work for R&R operations? |
| OQ-002 | Product | New Cases begin at `REQUEST_RECEIVED`. | Do you want any earlier business-visible state? |
| OQ-003 | Product | Customer identity is a separate referenced entity. | Should customer/contact data live independently from each Case? |
| OQ-004 | Product | Vehicle is a separate entity referenced by Case. | Do you want one vehicle record reusable across jobs? |
| OQ-005 | Product | Glass Request is a separate Case-owned record, one in v0.1. | Should one Case eventually support multiple glass requests? |
| OQ-006 | Product | Business events are append-only; corrections use later corrective events. | Is preserving complete operational history important enough to forbid ordinary event edits/deletes? |
| UX-OQ-001 | UX | Staff land on Case Queue. | Is the queue the right home screen, or do you want a dashboard first? |
| UX-OQ-002 | UX | Humanized state label primary; canonical state ID secondary. | Should staff see friendly labels or raw workflow codes by default? |
| UX-OQ-003 | UX | Activity timeline defaults newest-first. | Do you prefer latest activity first or chronological oldest-first? |
| UX-OQ-004 | UX | Full VIN for authenticated R&R Staff; external VIN masked by default. | Do staff need immediate full VIN visibility? |
| UX-OQ-005 | UX | Desktop table, mobile stacked cards. | Does this density/responsive behavior fit how staff work? |
| BR-OQ-001 | Brand | Current simple R&R mark is the v0.1 product mark. | Is the current mark acceptable until a formal logo redesign? |
| BR-OQ-002 | Brand | Blue/indigo remains the primary accent. | Does this color direction feel like R&R? |
| BR-OQ-003 | Brand | Direct Customer is light; internal operations are dark. | Do you want this channel-specific light/dark treatment? |
| BR-OQ-004 | Brand | Real R&R photography used selectively; transactional screens stay UI-led. | Do you want real business photography in customer/public surfaces? |
| BR-OQ-005 | Brand | No forced tagline in v0.1. | Do you want a public-facing tagline now? |
| DG-OQ-001 | Design | Navy/slate + indigo palette with semantic green/amber/red tokens. | Does this specific palette feel right when shown visually? |
| DG-OQ-002 | Design | Use a system-first sans-serif font stack. | Is a custom brand font important now? |
| DG-OQ-003 | Design | Light mode is default for Direct Customer. | Confirm light customer experience. |
| DG-OQ-004 | Design | Friendly state names primary; machine state IDs secondary. | Confirm staff-facing state treatment. |
| DG-OQ-005 | Design | Timeline newest-first. | Confirm event ordering preference. |
| DG-OQ-006 | Design | Full VIN for staff; masked externally unless required. | Confirm privacy/operational balance. |

## Validation Protocol

For each decision, record one of:

- **VALIDATED** — client accepts the working decision;
- **REVISED** — client provides a replacement decision;
- **DEFERRED** — client does not want to decide yet; retain the provisional default temporarily.

Any **REVISED** decision must be propagated back to the originating Product, UX, Brand, or Design artifact before implementation depending on it is considered final.

## Current Engineering Rule

Until client validation occurs:

> Provisional decisions may be used for reversible implementation work, but they must not be described as client-approved facts.

Architecture and frontend should prefer configurations, tokens, mappings, and replaceable abstractions where a provisional decision is likely to change.


## Acceptance Record

Human acceptance recorded on 2026-09-26.

This register is accepted as the current working assumption set for reversible implementation work pending client validation.
