# Case Core Architecture Contract v0.1

Status: PROPOSED FOR HUMAN ACCEPTANCE  
Issue: #24  
API namespace: `/api/v1`

Depends on:
- `product/requirements/case-core-v0.1.md`
- `ux/case-core-rnr-staff-v0.1.md`
- `docs/workflow/state-inventory-v0.1.md`
- `docs/workflow/transition-matrix-v0.1.md`
- `docs/workflow/persona-permissions-actions-matrix-v0.1.md`
- `validation/client-validation-register-v0.1.md`

## 1. Architectural outcome

Case Core is the canonical operational spine for one R&R auto-glass job.

The backend owns:
- canonical Case identity;
- current internal workflow state;
- durable event history;
- vehicle/service references;
- legal business-action execution;
- persistence boundaries.

Frontend and external channel experiences consume projections of the same Case. Channel does not fork the domain model.

## 2. Module boundary

Case Core is implemented as one module inside a modular monolith.

```text
Case Core
├── Case
├── Customer reference
├── Vehicle
├── Glass Request
├── Case Event
└── Action boundary
```

Provider-specific behavior such as MyGrant VIN lookup, sourcing, pricing, quote generation, purchasing, installation, and notifications stays outside Case Core and interacts through later accepted module contracts.

## 3. Canonical domain objects

### 3.1 Case

Required fields:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Internal immutable identity. |
| `reference` | string | Human-facing R&R reference. Working v0.1 format: `RRA-000123`. Provisional/client validation deferred. |
| `channel` | enum | `DIRECT | AUCTION | INSURANCE`. |
| `current_state` | string/enum | Canonical state from accepted workflow vocabulary. Initial working value: `REQUEST_RECEIVED`. Provisional/client validation deferred. |
| `customer_id` | UUID/null | Separate Customer reference. Optional in Case Core create because current accepted intake does not require customer fields. |
| `vehicle_id` | UUID | Reference to Vehicle entity. |
| `glass_request_id` | UUID | Reference to the single v0.1 Glass Request. |
| `created_at` | timestamp | Server generated UTC instant. |
| `updated_at` | timestamp | Server generated UTC instant for current record changes. |

Invariant:
- `current_state` cannot be set by arbitrary PATCH/PUT from clients.
- `COMPLETED` and `CANCELLED` are terminal business states.

### 3.2 Customer

Case Core establishes a separate identity boundary without forcing customer/contact capture into the current create flow.

Minimum contract:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Immutable identity. |

Additional customer/contact attributes are outside this slice until explicitly required.

### 3.3 Vehicle

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Immutable identity. |
| `year` | integer | Required intake value. |
| `make` | string | Required intake value. |
| `model` | string | Required intake value. |
| `vin` | string | Required intake value. Stored as intake identity; no paid lookup is performed by Case Core. |
| `created_at` | timestamp | Server generated. |
| `updated_at` | timestamp | Server generated. |

The Vehicle entity is separate from Case.

Whether a later Case reuses an existing Vehicle row by VIN or creates a new reference is a repository/persistence policy that remains reversible while client validation is deferred. Case Core v0.1 must not depend on destructive vehicle duplication or on a paid VIN provider.

### 3.4 Glass Request

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Immutable identity. |
| `case_id` | UUID | Owning Case. |
| `glass_type` | enum | `WINDSHIELD | BACK_GLASS | DOOR_GLASS | QUARTER_GLASS | VENT_GLASS`. |
| `created_at` | timestamp | Server generated. |
| `updated_at` | timestamp | Server generated. |

v0.1 cardinality:
- one active Glass Request per Case.

The separate entity preserves a future multi-glass extension without requiring that behavior now.

### 3.5 Case Event

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Immutable event identity. |
| `case_id` | UUID | Owning Case. |
| `sequence` | integer/bigint | Strictly increasing within one Case. Canonical deterministic order. |
| `event_type` | string | Durable business event vocabulary. |
| `occurred_at` | timestamp | Server-recorded occurrence instant. |
| `actor_type` | enum/string | `SYSTEM | RNR_STAFF | DIRECT_CUSTOMER | AUCTION | INSURANCE | TECHNICIAN` when known. |
| `actor_id` | string/null | Optional authenticated/external actor reference when available. |
| `payload` | JSON object | Event-specific context; must not be required to reconstruct the current Case identity/state alone. |
| `corrects_event_id` | UUID/null | Optional reference for a later corrective/superseding event. |

Event invariants:
- application flows do not UPDATE or DELETE historical Case Events;
- correction is another appended event;
- event ordering is `sequence ASC`, not timestamp alone;
- Case creation appends `CASE_CREATED`.

## 4. Aggregate and transaction boundaries

### 4.1 Case creation transaction

`POST /api/v1/cases` must atomically establish the v0.1 Case Core records:

1. create/reference Vehicle;
2. create Case with canonical ID/reference/channel/current state;
3. create one Glass Request;
4. append `CASE_CREATED` event with sequence 1.

If the transaction fails, the API must not return a successful Case that lacks its creation event.

No MyGrant/YMM/VIN/provider call occurs inside this transaction.

### 4.2 State-changing action transaction

Future legal actions follow:

```text
request business action
→ load Case
→ verify actor/channel permission
→ verify state transition/guard
→ perform module/domain work
→ update current_state if applicable
→ append durable event
→ commit atomically
```

The current-state update and resulting durable event must commit together.

## 5. API contract v1

Canonical machine-readable definition:

`architecture/openapi/case-core-v0.1.yaml`

### 5.1 Create Case

`POST /api/v1/cases`

Request:

```json
{
  "channel": "DIRECT",
  "vehicle": {
    "year": 2018,
    "make": "Jeep",
    "model": "Wrangler",
    "vin": "1C4HJXEG3JW224862"
  },
  "glass_request": {
    "glass_type": "WINDSHIELD"
  }
}
```

Success:
- HTTP 201;
- returns the canonical Case projection;
- includes `CASE_CREATED` in activity when events are embedded/returned by detail endpoint.

Validation failure:
- HTTP 400 or 422 according to implementation convention, consistently documented;
- no partial Case is persisted.

### 5.2 List Cases

`GET /api/v1/cases`

Minimum v0.1 result for R&R Staff:
- Case ID;
- reference;
- channel;
- current state;
- Year/Make/Model;
- glass type;
- created/updated timestamps.

Advanced filtering, pagination UX, metrics, and bulk operations are not required by this slice. Backend may implement basic pagination defensively without changing the product contract.

### 5.3 Get Case

`GET /api/v1/cases/{caseId}`

Returns:
- canonical Case identity;
- channel;
- current internal state;
- Vehicle projection;
- Glass Request projection;
- Customer reference if present;
- timestamps.

The R&R Staff frontend can render its header, vehicle/service summary, and current state from this response without MyGrant.

### 5.4 Get Case Events

`GET /api/v1/cases/{caseId}/events`

Returns durable events in deterministic `sequence ASC` order.

### 5.5 Business action boundary

Reserved canonical path:

`POST /api/v1/cases/{caseId}/actions`

Envelope:

```json
{
  "action": "ACTION_NAME",
  "input": {}
}
```

Rules:
- there is no public `PATCH /cases/{id}` contract for arbitrary `current_state` mutation;
- an action is accepted only when actor permission + current state + guard allow it;
- unknown/unimplemented actions return a non-success response and do not change state/history;
- future workflow modules add accepted action names without changing the Case identity/read contracts.

Case Core v0.1 does not require implementation of the complete workflow action catalog.

## 6. API error envelope

Use one stable v1 shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "VIN is required.",
    "details": {
      "field": "vehicle.vin"
    }
  }
}
```

Minimum error codes:
- `VALIDATION_ERROR`
- `CASE_NOT_FOUND`
- `ACTION_NOT_ALLOWED`
- `CONFLICT`
- `INTERNAL_ERROR`

Do not expose provider credentials, stack traces, or sensitive internal data.

## 7. Persistence contract

Logical persistence boundaries:

```text
customers
vehicles
cases
glass_requests
case_events
```

Required relationships:
- `cases.customer_id -> customers.id` nullable in current slice;
- `cases.vehicle_id -> vehicles.id`;
- `glass_requests.case_id -> cases.id`;
- `case_events.case_id -> cases.id`.

Required integrity:
- one Case has one current state;
- one v0.1 Case has one Glass Request;
- `case_events(case_id, sequence)` is unique;
- event rows are application-append-only;
- foreign keys prevent orphan Glass Requests and Case Events.

Physical SQL types/indexes are backend implementation details as long as these invariants hold.

## 8. Reference number boundary

Working v0.1 reference format:

`RRA-000123`

Architecture contract:
- reference is unique;
- generated server-side;
- independent of internal UUID;
- no client may select its own reference;
- formatting strategy must be isolated so the provisional prefix/width can change without changing Case identity.

## 9. State contract

The accepted state vocabulary is defined in:

`docs/workflow/state-inventory-v0.1.md`

Architecture must:
- store the canonical internal state value;
- reject arbitrary state names;
- keep persona-facing labels outside the canonical state field;
- preserve terminal-state rules;
- use the accepted transition matrix as the legal transition source once workflow actions are implemented.

Case Core creation uses the current working initial state `REQUEST_RECEIVED` while that client decision remains deferred/provisional.

## 10. Authorization boundary

From the accepted persona permissions matrix:

- R&R Staff may create and inspect canonical Cases.
- External personas do not receive Case Core administrative mutation APIs in v0.1.
- no persona directly sets `current_state`;
- forbidden actions must be enforced server-side, not only hidden in UI;
- external channel experiences later receive scoped projections rather than unrestricted canonical Case access.

Authentication/provider selection is out of scope for #24, but API handlers must preserve a place for actor/context enforcement rather than baking permissions into UI-only logic.

## 11. Event correction contract

Historical event correction is append-only.

Example:

```text
sequence 7  GLASS_SELECTED
sequence 8  EVENT_CORRECTED { corrects_event_id: <event-7>, reason: ... }
```

Rules:
- event 7 remains present;
- event 8 carries the corrective context;
- the current Case projection reflects the accepted current truth;
- normal application APIs expose no event UPDATE/DELETE endpoint.

Exact correction event vocabulary may be refined by later workflow slices without weakening append-only history.

## 12. Concurrency and idempotency boundary

Case Core v0.1 must avoid accidental duplicate creation from repeated client submission.

Minimum architecture requirement:
- backend implementation defines an idempotency strategy for create requests or an equivalent duplicate-submit guard;
- concurrent state-changing actions must not silently overwrite each other;
- event sequence allocation must remain deterministic and unique per Case.

The precise mechanism (idempotency key, transaction/locking strategy, version column) is a backend implementation choice documented in #25.

## 13. Security/data handling boundary

- VIN is operational data; authenticated R&R Staff may receive the full VIN under the accepted provisional UX decision.
- External persona projections should not inherit the canonical API response by accident.
- provider credentials/secrets never belong in Case/Event payloads.
- event payloads should contain the minimum durable business context needed for audit/reconstruction.

## 14. Frontend/backend parallelization contract

Backend #25 may proceed against:
- entity/invariant definitions in this document;
- OpenAPI v0.1;
- accepted workflow state vocabulary.

Frontend #26 may proceed using:
- OpenAPI v0.1 response/request shapes;
- accepted R&R Staff UX;
- humanized UI projections without changing canonical state IDs.

Neither team may:
- invent new business actions;
- add paid VIN behavior;
- fork Case by channel;
- allow arbitrary state mutation.

## 15. Deferred/provisional decisions

The following remain reversible because client validation was deferred in #22:

- human-readable reference format;
- initial state choice;
- customer identity details beyond a separate reference;
- vehicle reuse/deduplication policy;
- future multi-glass behavior;
- exact correction event naming;
- selected UX presentation decisions identified in the validation register.

Implementation may use the working defaults but must not encode them as irreversible client-approved policy.

## 16. Issue #24 acceptance checklist

- [x] Customer, Vehicle, Glass Request, Case, and Case Event relationships are explicit.
- [x] Create/read/list/event contracts are versioned.
- [x] State changes occur through business actions, not arbitrary patches.
- [x] Append-only event correction semantics are defined.
- [x] Contract is sufficient for frontend/backend parallel work.
- [ ] Human acceptance recorded before #25/#26 treat this contract as frozen.

## 17. Acceptance record

Pending human review.
