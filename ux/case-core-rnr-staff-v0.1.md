# Case Core / R&R Staff UX Specification v0.1

Status: ACCEPTED

Source: `product/requirements/case-core-v0.1.md` (ACCEPTED)

## 1. UX Objective

Give R&R Staff a clear operational view of a single auto-glass job without requiring them to understand database structure, supplier implementation details, or channel-specific external terminology.

The staff experience should answer, at a glance:

1. What job is this?
2. Where is it in the workflow?
3. What vehicle/service is involved?
4. What has happened so far?
5. What can I do next?
6. Is anything blocked or requiring attention?

Case Core v0.1 is intentionally narrow. This UX spec covers the minimum staff interaction needed to create and inspect a Case and understand its current state and history.

---

## 2. Primary Persona

### R&R Staff

Operational user working active auto-glass jobs.

Needs:
- fast recognition of the job;
- confidence that the vehicle/service context is correct;
- visibility into current workflow state;
- durable activity history;
- clear indication when no further action is currently available;
- future compatibility with workflow actions as later slices are implemented.

This UX must not expose Direct Customer, Auction, or Insurance terminology unless it is relevant to the selected Case channel.

---

## 3. Core Staff Flow

### 3.1 Create Case

Entry point:

`+ New Case`

Required form fields:

- Channel
- Year
- Make
- Model
- VIN
- Requested glass type

Primary action:

`Create Case`

Secondary action:

`Cancel`

Expected result:

- Case is created;
- user is routed to the Case Detail screen;
- the new R&R reference number is visible;
- the current state is visible;
- the creation event appears in activity history.

No MyGrant lookup is triggered by this action.

### 3.2 View Case

Entry points may include:
- Case Queue row;
- direct link;
- redirect immediately after creation.

The Case Detail screen becomes the canonical R&R Staff operational view for one job.

### 3.3 Inspect History

Activity is visible on the Case Detail screen in deterministic chronological order.

The user must be able to distinguish:
- what happened;
- when it happened;
- whether the event represents user/system activity when that information is available.

Case Core v0.1 does not require advanced filtering.

---

## 4. Information Architecture

The Case Detail screen should use this hierarchy:

### A. Case Header

Always visible near the top.

Display:
- R&R case/reference number;
- channel;
- current state;
- created timestamp;
- last updated timestamp.

Example:

`RRA-000123 · DIRECT`

Current state:

`REQUEST_RECEIVED`

Do not translate internal state names for R&R Staff in this initial internal tool. Staff may see the canonical state vocabulary.

### B. Vehicle / Service Summary

Display:
- Year;
- Make;
- Model;
- VIN;
- requested glass type.

Example:

`2018 Jeep Wrangler · Windshield`

VIN should be readable but visually de-emphasized relative to Year/Make/Model and glass type.

### C. Current Workflow Position

Show the current stage/state in context of the accepted workflow.

Minimum requirement:
- current stage;
- current state.

Preferred representation:
- horizontal stage strip or compact workflow indicator.

For narrow screens:
- allow horizontal scrolling or stacked representation;
- do not shrink text below comfortable readability.

### D. Next Action Area

Case Core v0.1 may have no implemented business actions beyond creation.

When no action exists:

`No staff action required at this step.`

When future actions exist, this area should be the stable location for them.

Do not fabricate action buttons for states whose business action is not implemented.

### E. Activity Timeline

Display durable events in chronological order.

Each event row should include:
- event label;
- timestamp;
- short context/details when available.

Example:

`CASE_CREATED`
`Sep 26, 2026 · 9:42 AM`

Later events should appear in the same timeline without redesigning the page.

---

## 5. Create Case Screen

### 5.1 Layout

Use a single focused form.

Recommended grouping:

#### Job Channel
- Channel selector

#### Vehicle
- Year
- Make
- Model
- VIN

#### Service
- Requested glass type

### 5.2 Field Behavior

Channel:
- required;
- options: DIRECT, AUCTION, INSURANCE.

Year:
- required;
- numeric or constrained text input.

Make:
- required.

Model:
- required.

VIN:
- required;
- do not perform paid VIN lookup during entry.

Requested glass type:
- required;
- accepted values:
  - Windshield
  - Back Glass
  - Door Glass
  - Quarter Glass
  - Vent Glass

### 5.3 Validation

Inline validation should appear near the affected field.

Examples:
- `VIN is required.`
- `Select a glass type.`

The form must not silently discard entered values when validation fails.

### 5.4 Submission States

While creating:
- disable repeated submit;
- show `Creating Case…`.

On success:
- route to Case Detail.

On failure:
- keep entered values;
- show a concise retryable error;
- do not imply the Case exists unless creation succeeded.

---

## 6. Case Queue / Entry Surface

Case Core v0.1 only requires enough queue behavior to let R&R Staff find and open created Cases.

Minimum row information:

- R&R reference number;
- Year / Make / Model;
- glass type;
- channel;
- current state;
- last updated.

Minimum action:

`Open`

No advanced filtering, sorting, bulk actions, or dashboard metrics are required in this slice.

Empty state:

`No cases yet.`

Primary CTA:

`Create first case`

---

## 7. Case Detail States

### 7.1 Loading

Show:
- stable page shell;
- skeleton/placeholder for Case content.

Do not flash fake values.

### 7.2 Case Not Found

Message:

`Case not found.`

Provide navigation back to Case Queue.

### 7.3 Read Failure

Message:

`We couldn't load this case.`

Action:

`Retry`

### 7.4 Empty Event History

This should be exceptional because Case creation should create an event.

If encountered:

`No activity recorded yet.`

Do not fabricate history.

### 7.5 Terminal State

If current state is `COMPLETED` or `CANCELLED`:
- visually indicate the Case is closed;
- do not present active workflow actions.

---

## 8. Responsive Behavior

### Desktop

Two-column Case Detail is acceptable:

- primary column: workflow + activity;
- secondary column: vehicle/service metadata + current action.

### Tablet

Collapse to one main column with metadata cards.

### Mobile

Prioritize:

1. Case reference
2. Vehicle/service
3. Current state
4. Next action
5. Activity timeline

Avoid dense tables.

Queue rows may become stacked cards.

Touch targets should remain comfortably tappable.

---

## 9. Accessibility / Human Interface Requirements

- All form controls require visible labels.
- State must not be communicated by color alone.
- Keyboard navigation must reach all interactive controls.
- Error messages must be associated with affected controls.
- Focus should move predictably after validation/submission.
- Contrast must remain readable in the existing dark R&R internal visual language.
- Internal state names may wrap; they must not clip or overflow.

---

## 10. Terminology

Use for R&R Staff:
- Case
- Current state
- Activity
- Vehicle
- Glass type
- Channel

Avoid introducing:
- Assignment, unless channel context is Insurance;
- Stock #, unless auction context later requires it;
- Customer-facing phrases such as `Your quote is ready` in the internal staff shell.

The UX must preserve the product rule:

`internal workflow state != persona-visible external status`

---

## 11. Explicit Non-Goals

This UX slice does not design:

- MyGrant search screens;
- VIN lookup UI;
- supplier offers;
- pricing/profit UI;
- quote creation;
- quote approval;
- purchasing;
- appointment scheduling;
- invoice generation;
- notifications;
- complete Direct Customer portal;
- complete Auction portal;
- complete Insurance portal;
- advanced case queue analytics.

Those experiences should attach to this shell later.

---

## 12. UX Acceptance Criteria

### UX-AC-001
R&R Staff can create a Case using all required Case Core fields.

### UX-AC-002
Validation errors are visible, field-specific, and do not discard valid entered data.

### UX-AC-003
Successful creation routes the user to the newly created Case.

### UX-AC-004
Case Detail clearly displays the human-readable Case reference.

### UX-AC-005
Case Detail clearly displays channel and current internal workflow state.

### UX-AC-006
Case Detail clearly displays Year, Make, Model, VIN, and requested glass type.

### UX-AC-007
The user can understand the Case's current workflow position without inspecting raw data.

### UX-AC-008
The activity timeline shows durable Case events in chronological order.

### UX-AC-009
The UI does not trigger a paid VIN lookup.

### UX-AC-010
The UI does not offer business actions that have not yet been implemented.

### UX-AC-011
The same staff shell can represent DIRECT, AUCTION, and INSURANCE Cases.

### UX-AC-012
The core staff experience remains usable on desktop, tablet, and mobile.

---

## 13. Open UX Questions

### UX-OQ-001 — Default landing page

Should R&R Staff land on:
- Case Queue, or
- an operational dashboard that contains the Case Queue?

Recommendation for v0.1: Case Queue.

### UX-OQ-002 — State presentation

Should internal workflow state remain raw uppercase identifiers everywhere, or should the UI display a humanized label while retaining the canonical value in a secondary/detail treatment?

Example:

`Request received`
secondary: `REQUEST_RECEIVED`

### UX-OQ-003 — Activity ordering

Product requires deterministic chronological order.

Should the default UI show:
- newest first, or
- oldest first?

Recommendation for operational use: newest first, while preserving deterministic timestamps/order.

### UX-OQ-004 — VIN masking

Should R&R Staff always see the full VIN, or should the default display partially mask it with a reveal action?

Product requirement only requires VIN availability; it does not resolve display privacy.

### UX-OQ-005 — Queue density

Should the first implementation optimize for:
- desktop table density, or
- responsive card consistency?

Recommendation: responsive table on desktop that collapses into cards on narrow screens.

---

## 14. UX Decision Boundary

Acceptance of this document means:

- the R&R Staff Case Core flow is accepted;
- the minimum create / queue / detail interaction model is accepted;
- the information hierarchy is accepted;
- responsive and error-state expectations are accepted;
- the UX acceptance criteria are sufficient for architecture/frontend planning.

Acceptance does not resolve the listed open UX questions unless explicitly decided.

Acceptance also does not authorize implementation of product capabilities that remain out of scope in the accepted Case Core Product Requirement.

## 15. Acceptance Record

Human acceptance recorded on 2026-09-26.

Accepted for progression to brand, design-system, architecture, and frontend planning. Open UX questions remain unresolved until explicitly decided.


---

## 16. Provisional UX Decisions Pending Client Validation

These are working UX decisions so design and implementation can proceed. They remain subject to client validation.

### UX-PD-001 — Default landing page
**Working decision:** R&R Staff land on the **Case Queue** in v0.1.

**Rationale:** It gets staff immediately to active work. A dashboard can be introduced later when there are meaningful cross-case metrics/actions to justify it.

### UX-PD-002 — State presentation
**Working decision:** Show a humanized state label as the primary UI text, with the canonical state ID available as secondary detail for staff/debugging.

Example:

`Request received`

secondary: `REQUEST_RECEIVED`

**Rationale:** Staff should not need to read machine identifiers to operate the product, but the canonical value remains useful for support and troubleshooting.

### UX-PD-003 — Activity ordering
**Working decision:** Show activity **newest first** by default.

**Rationale:** Operational users usually need to know what just happened and what changed most recently. Ordering remains deterministic through timestamps plus a stable event sequence.

### UX-PD-004 — VIN display
**Working decision:** Authenticated R&R Staff see the **full VIN** with an easy copy affordance. External persona experiences should mask VIN unless a business need requires full visibility.

**Rationale:** Staff regularly need VIN for vehicle/glass work; forcing reveal steps would slow operations. External exposure should be more conservative.

### UX-PD-005 — Queue density
**Working decision:** Use a responsive **desktop table that collapses into stacked cards on narrow screens**.

**Rationale:** Staff benefit from scanning density on desktop while mobile users still need a touch-friendly readable layout.

**Validation status:** CLIENT VALIDATION REQUIRED.
