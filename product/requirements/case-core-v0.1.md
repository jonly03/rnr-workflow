# Case Core Product Requirement v0.1

Status: DRAFT FOR HUMAN ACCEPTANCE

## 1. Problem / Desired Outcome

R&R currently needs one durable operational record that can carry an auto-glass job from intake through identification, sourcing, pricing, quote approval, ordering, installation, invoicing, and completion.

Today, different parts of that lifecycle can be represented by disconnected messages, supplier lookups, quotes, invoices, or manual knowledge.

Case Core v0.1 should establish the minimum shared product foundation for a single job record.

Desired outcome:

> Every R&R glass job has one canonical Case with a current workflow state and a durable event history that downstream product features can build on.

Case Core is not the complete R&R product. It is the operational spine that later features use.

---

## 2. Primary Users

### R&R Staff

Primary operational user.

Needs to:
- create and inspect a job;
- know its current stage/state;
- see the core vehicle/service context;
- understand what has happened to the job;
- take permitted business actions as later workflow slices are implemented.

### Direct Customer

Not a Case Core administrative user.

Later product experiences may project customer-friendly status and actions from the Case, but customers should not need to understand internal Case terminology.

### Auction Partner

Later auction experiences will consume the same Case data while using auction-specific terminology such as vehicle request, stock number, approval, and installation status.

### Insurance Partner

Later insurance experiences will consume the same Case data while using assignment, claim, authorization, scheduling, completion, and document terminology.

---

## 3. Required Capabilities

Case Core v0.1 must support:

### 3.1 Canonical Case Identity

Every job must have:
- an internal unique identifier;
- a human-readable R&R case/reference number.

Example:

`RRA-000123`

### 3.2 Channel

A Case must identify the business channel.

Initial supported values:

`DIRECT | AUCTION | INSURANCE`

The channel must not create separate case models.

### 3.3 Current Workflow State

A Case must store one authoritative current internal workflow state.

The state must use the accepted R&R workflow vocabulary.

Examples include:

`REQUEST_RECEIVED`

`GLASS_IDENTIFIED`

`AWAITING_APPROVAL`

`GLASS_ORDERED`

`INSTALLATION_COMPLETED`

`COMPLETED`

### 3.4 Core Vehicle / Service Context

The Case must be able to reference the minimum intake context required by the accepted workflow:

- Year
- Make
- Model
- VIN
- requested glass type

The initial accepted glass-type vocabulary includes:
- Windshield
- Back Glass
- Door Glass
- Quarter Glass
- Vent Glass

### 3.5 Durable Event History

Meaningful changes to the Case must create durable events.

The event history must support reconstruction of what happened without relying only on the latest Case row.

Examples of later events include:

- `CASE_CREATED`
- `YMM_SEARCH_STARTED`
- `YMM_SEARCH_COMPLETED`
- `VIN_LOOKUP_PERFORMED`
- `GLASS_SELECTED`
- `QUOTE_GENERATED`
- `CUSTOMER_QUOTE_APPROVED`
- `ORDER_PLACED`
- `INSTALLATION_COMPLETED`

Case Core v0.1 does not need to implement every future event type, but the model must support them.

### 3.6 Created / Updated Timestamps

The Case must record when it was created and when its current record was last updated.

Events must record when they occurred.

### 3.7 Readable Case Projection

The system must be able to return enough Case information for the R&R Staff UI to render:

- Case identifier;
- channel;
- current state;
- vehicle/service context;
- event/activity history.

---

## 4. Business Rules

### BR-001 — One operational truth

A job has one canonical Case even when multiple personas experience it differently.

### BR-002 — Internal state is authoritative

The backend owns the internal workflow state.

Frontend clients must not arbitrarily patch the Case into another state.

### BR-003 — Actions drive state changes

Future workflow progression should happen through explicit business actions, not direct state mutation.

Target interaction shape:

```http
POST /api/v1/cases/:id/actions
```

Example payload:

```json
{
  "action": "APPROVE_QUOTE"
}
```

Case Core v0.1 only needs to preserve this architectural direction. It does not need to implement the complete action catalog.

### BR-004 — State and persona status are separate

Internal workflow state is not automatically the text shown to Direct, Auction, or Insurance users.

Persona-facing status remains a projection governed by the accepted persona communication rules.

### BR-005 — History must survive state changes

Changing current state must not erase prior meaningful history.

### BR-006 — Completed and Cancelled are terminal

The Case model must be able to represent terminal states without requiring later mutation back into an active workflow.

### BR-007 — Channel does not fork the domain model

DIRECT, AUCTION, and INSURANCE use the same Case Core.

Channel-specific terminology and UX are projections over that shared record.

### BR-008 — No paid VIN behavior belongs in Case Core

Case Core may later reference VIN lookup events/results, but the paid MyGrant VIN decision logic belongs to the glass-identification workflow, not the foundational Case entity.

---

## 5. Acceptance Criteria

Case Core v0.1 is acceptable when all of the following are true:

### AC-001
A new Case can be created with:
- channel;
- Year;
- Make;
- Model;
- VIN;
- requested glass type.

### AC-002
Creation produces:
- an internal unique ID;
- an R&R reference number;
- a valid initial workflow state.

### AC-003
A created Case can be retrieved by ID.

### AC-004
The retrieved Case exposes its current internal workflow state.

### AC-005
The retrieved Case exposes its core vehicle/service context.

### AC-006
Creating the Case records at least one durable event representing its creation.

### AC-007
Case events can be retrieved in deterministic chronological order.

### AC-008
A state change performed through an allowed application/service interface records the resulting event/history rather than silently overwriting the prior record.

### AC-009
A frontend can render the minimum R&R Case header and activity timeline without querying MyGrant.

### AC-010
DIRECT, AUCTION, and INSURANCE Cases can all be represented without separate persistence models.

### AC-011
Automated tests prove the accepted Case Core behavior.

### AC-012
No implementation in this slice consumes a real paid VIN lookup.

---

## 6. Out of Scope for Case Core v0.1

The following are intentionally excluded from this slice:

- MyGrant live integration;
- VIN lookup execution;
- YMM glass identification;
- glass candidate resolution;
- supplier offer searching;
- interchangeables;
- pricing formulas;
- profit calculation;
- tax rules;
- quote generation;
- quote delivery;
- quote approval UI;
- inventory recheck;
- purchasing;
- installation scheduling;
- final invoice generation;
- notifications;
- authentication/authorization design beyond what is required to safely develop the slice;
- final production infrastructure architecture;
- complete Direct/Auction/Insurance portals.

Those features will build on Case Core rather than being embedded into it.

---

## 7. Open Questions

These questions are intentionally left unresolved for human/product review before architecture freezes the implementation contract.

### OQ-001 — Human-readable Case number format

Working example: `RRA-000123`.

Need to confirm whether this is the desired permanent business-facing format.

### OQ-002 — Initial state

Should Case creation persist directly as `REQUEST_RECEIVED`, or should an earlier technical creation state exist?

Current product workflow begins with `REQUEST_RECEIVED`.

### OQ-003 — Customer identity in v0.1

Should Case Core v0.1 include basic customer/contact fields now, or should customer identity be modeled immediately as a separate referenced entity?

### OQ-004 — Vehicle representation

Should vehicle data initially live directly on the Case for speed, or should v0.1 introduce a separate Vehicle entity from the start?

The broader architecture anticipates a vehicle record, but this requirement does not force the persistence design.

### OQ-005 — Glass request representation

Should requested glass type initially be a Case field, or should the first implementation create a separate Glass Request entity immediately?

Again, this requirement defines product behavior rather than prescribing the storage layout.

### OQ-006 — Event immutability

The product intent is a durable history. Architecture must decide the exact technical guarantees around event immutability and correction.

---

## 8. Product Decision Boundary

Approval of this document means:

- the problem and outcome are accepted;
- the minimum user/product capabilities are accepted;
- the listed business rules are accepted;
- the acceptance criteria are sufficient to hand the slice to UX/Architecture;
- anything listed under Open Questions still requires an explicit decision before it can become an implementation assumption.

Approval does **not** authorize invention of unanswered business rules.
