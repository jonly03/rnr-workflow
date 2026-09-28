# R&R Case Workflow Specification

Status: Living specification (replaces the v0.1 doc set on 2026-09-26)
Acceptance: Persona permissions accepted by human review 2026-09-26 (PR #86); remainder draft for review.

## Supersession note

This document consolidates and replaces the following, which are archived in git history:

- `transition-matrix-v0.1.md` — legal state transitions (content preserved below)
- `state-inventory-v0.1.md` — canonical states (content preserved below)
- `persona-permissions-actions-matrix-v0.1.md` — persona action ownership (content preserved below)
- `persona-status-notification-matrix-v0.1.md` — persona status/notification policy (content preserved below)
- `communication-principles.md` — state/status/notification distinction (content preserved below)
- `case-graph-v0.1.md` — mermaid projection of the transition tables (removed as duplication; regenerable from the tables below)

Prior revisions referenced `product/requirements/case-core-v0.1.md`, `ux/case-core-rnr-staff-v0.1.md`, and `validation/client-validation-register-v0.1.md`. Those documents do not exist in this repo; the references are removed rather than carried forward as vapor. Where behavior depends on deferred client decisions, it is marked provisional inline.

## 1. Personas

- **R&R Staff** — owns operational control of the case.
- **Direct Customer** — owns approval/decline of the Direct quote for their own case.
- **Auction** — owns approval/decline of the Auction quote for their own case.
- **Insurance** — owns authorization/decline of the estimate/scope for their own case.

(Installation references a Technician driver; no separate Technician persona exists yet — see §9.)

## 2. Governing rules

1. **Personas request business actions; they never directly mutate workflow state.** The workflow engine validates guards and performs transitions. The frontend must not offer direct state patching.
2. **Internal workflow state ≠ persona-visible status ≠ notification.** Three separate decisions. Permission to view a status does not imply permission to perform the underlying transition.
3. **R&R owns operational control.** Glass identification, sourcing, pricing exceptions, purchase confirmation, procurement recovery, installation exception handling, and final closeout remain R&R-controlled unless a later accepted requirement explicitly delegates them.
4. **External personas act only within their own case/channel.** Direct Customer, Auction, and Insurance must not access or mutate another channel's case.
5. **Quote/authorization approval is channel-specific.** Direct approval, Auction approval, and Insurance authorization are related but not interchangeable.
6. **Quote approval never authorizes supplier purchase.** Purchase still requires explicit R&R confirmation.
7. **History is append-only.** No persona may rewrite or delete business events or historical quote versions. Corrections use later corrective/superseding events; requote creates a new version.
8. **Paid/provider side effects are not generic user actions.** VIN lookup eligibility, provider calls, sourcing, and purchase execution are controlled by workflow/service rules, not arbitrary UI buttons.
9. **Provisional client decisions remain provisional.** Anything depending on deferred client validation must stay reversible/configurable and must not be described as client-approved.

## 3. State inventory

A state exists only when it matters to business progression, workflow recovery, auditability, an R&R operator, or an external persona. Technical operations (e.g. database writes) are not business states.

Intake cannot progress unless Year, Make, Model, VIN, and Glass Type are present and valid enough to continue. Validation is automatic; missing/invalid data blocks progression until corrected.

| Stage | State | Meaning | Driver |
| --- | --- | --- | --- |
| Intake | `REQUEST_RECEIVED` | Request entered the system | Human/System |
| Intake | `REQUEST_VALIDATION_IN_PROGRESS` | System checks required intake fields | Automatic |
| Intake | `REQUEST_VALIDATION_REQUIRED` | Required fields missing/invalid; progression blocked | Automatic |
| Intake | `READY_FOR_YMM_SEARCH` | Intake valid enough to continue | Automatic |
| Glass Identification | `YMM_SEARCH_IN_PROGRESS` | Year/Make/Model search running | Automatic |
| Glass Identification | `YMM_RESULTS_FOUND` | Candidate glass results returned | Automatic |
| Glass Identification | `GLASS_MATCH_EVALUATION` | System compares candidates, fit, options | Automatic |
| Glass Identification | `VIN_LOOKUP_REQUIRED` | Windshield/Back Glass ambiguous; VIN can resolve | Automatic decision |
| Glass Identification | `VIN_LOOKUP_IN_PROGRESS` | One paid VIN lookup running | Automatic |
| Glass Identification | `HUMAN_GLASS_REVIEW_REQUIRED` | Cannot safely determine glass automatically | R&R |
| Glass Identification | `GLASS_IDENTIFIED` | One or more equivalent valid candidates established | Automatic/Human |
| Glass Identification | `GLASS_NOT_IDENTIFIED` | No valid glass currently establishable | R&R exception |
| Sourcing | `SOURCING_IN_PROGRESS` | Searching primary candidates and interchangeables | Automatic |
| Sourcing | `OFFERS_FOUND` | Supplier/warehouse offers returned | Automatic |
| Sourcing | `OFFER_EVALUATION` | Removing unavailable/excluded offers, comparing prices | Automatic |
| Sourcing | `GLASS_SELECTED` | Cheapest eligible available glass selected | Automatic |
| Sourcing | `NO_ELIGIBLE_INVENTORY` | Nothing valid available from eligible inventory | R&R exception |
| Pricing | `PRICING_IN_PROGRESS` | Calculating glass cost, labor, target profit, tax | Automatic |
| Pricing | `PROFIT_REVIEW_REQUIRED` | Pricing exception requiring R&R judgment | R&R |
| Pricing | `PRICE_APPROVED` | Customer-facing price established | Automatic/Human |
| Quote | `QUOTE_GENERATING` | Creating quote snapshot/document | Automatic |
| Quote | `QUOTE_READY` | Quote exists and is ready to send | Automatic |
| Quote | `QUOTE_DELIVERY_FAILED` | Quote could not be delivered | R&R/System |
| Quote | `AWAITING_APPROVAL` | Quote delivered; waiting on approver | Customer/Partner |
| Quote | `QUOTE_APPROVED` | Required approval received | Customer/Partner |
| Quote | `QUOTE_DECLINED` | Quote explicitly rejected | Customer/Partner |
| Quote | `QUOTE_EXPIRED` | Approval window elapsed | Automatic |
| Quote | `REQUOTE_REQUIRED` | Approved inputs changed enough to require a new quote | Automatic/R&R |
| Procurement | `INVENTORY_RECHECK_IN_PROGRESS` | Rechecking saved selected part before purchase | Automatic |
| Procurement | `RESOURCING_REQUIRED` | Previously selected glass no longer available | Automatic |
| Procurement | `READY_TO_ORDER` | Approved quote + valid inventory ready | Automatic |
| Procurement | `PURCHASE_CONFIRMATION_REQUIRED` | R&R must authorize spend before purchase | R&R |
| Procurement | `ORDER_IN_PROGRESS` | Supplier order operation occurring | Automatic |
| Procurement | `ORDER_FAILED` | Purchase did not complete | R&R/System |
| Procurement | `GLASS_ORDERED` | Supplier order placed | Automatic |
| Installation | `SCHEDULING_REQUIRED` | Job needs an installation appointment | R&R/Customer |
| Installation | `INSTALLATION_SCHEDULED` | Appointment confirmed | R&R |
| Installation | `INSTALLATION_RESCHEDULE_REQUIRED` | Existing appointment cannot proceed | R&R/Customer |
| Installation | `INSTALLATION_IN_PROGRESS` | Technician started the job | Technician |
| Installation | `INSTALLATION_EXCEPTION` | Problem prevents normal completion | Technician/R&R |
| Installation | `INSTALLATION_COMPLETED` | Requested glass work complete | Technician |
| Closeout | `FINAL_INVOICE_GENERATING` | Creating final financial/document record | Automatic |
| Closeout | `FINAL_INVOICE_READY` | Final invoice exists | Automatic |
| Closeout | `JOB_PROFIT_RECORDED` | Actual job economics recorded | Automatic |
| Closeout | `COMPLETED` | Successful terminal state | Automatic |
| Global Exception | `CANCELLATION_REQUESTED` | Cancellation requested | Human |
| Global Exception | `CANCELLED` | Case ended without completion | R&R |
| Global Exception | `SYSTEM_ATTENTION_REQUIRED` | Technical failure blocks safe automatic progression | R&R/System |

### Domain constraints

- YMM search occurs before any paid VIN lookup; VIN lookup is conditional, never a normal lifecycle stage.
- VIN lookup only for Windshield/Back Glass ambiguity. Door/Quarter/Vent ambiguity must not trigger VIN lookup; it routes to human review.
- A successful VIN lookup result belongs to the case and must not be automatically repurchased for that case.
- Sourcing considers valid primary candidates and interchangeables; Regional inventory is excluded from normal selection (may be recorded for audit).
- No eligible inventory blocks normal quote progression.
- Pricing exceptions route to R&R review rather than inventing an unsupported formula.
- Quote approval/decline/expiry/requote, inventory change, order failure, rescheduling, installation exceptions, and cancellation are explicit workflow possibilities — never silent mutations.

## 4. Transitions

The workflow engine must only allow the transitions below, plus the global exception transitions in §5. A transition is: current state → triggering event (+ guard/condition, driver) → next state.

Global rules: `COMPLETED` and `CANCELLED` are terminal. Short-lived internal states do not automatically imply persona-visible status changes or notifications.

### Intake

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `REQUEST_RECEIVED` | `VALIDATE_REQUEST` | Always | Automatic | `REQUEST_VALIDATION_IN_PROGRESS` |
| `REQUEST_VALIDATION_IN_PROGRESS` | `VALIDATION_FAILED` | Any required field missing or invalid | Automatic | `REQUEST_VALIDATION_REQUIRED` |
| `REQUEST_VALIDATION_IN_PROGRESS` | `VALIDATION_PASSED` | Year, Make, Model, VIN, Glass Type valid enough | Automatic | `READY_FOR_YMM_SEARCH` |
| `REQUEST_VALIDATION_REQUIRED` | `REQUEST_DATA_UPDATED` | Missing/invalid intake data changed | Human/System | `REQUEST_VALIDATION_IN_PROGRESS` |
| `READY_FOR_YMM_SEARCH` | `START_YMM_SEARCH` | Intake remains valid | Automatic | `YMM_SEARCH_IN_PROGRESS` |

Invariant: no legal transition from `REQUEST_VALIDATION_REQUIRED` directly to a search, pricing, quote, order, installation, or completion state.

### Glass Identification

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `YMM_SEARCH_IN_PROGRESS` | `YMM_RESULTS_RETURNED` | Search completed with candidates | Automatic | `YMM_RESULTS_FOUND` |
| `YMM_SEARCH_IN_PROGRESS` | `YMM_SEARCH_FAILED` | Provider/technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `YMM_RESULTS_FOUND` | `EVALUATE_GLASS_MATCHES` | Always | Automatic | `GLASS_MATCH_EVALUATION` |
| `GLASS_MATCH_EVALUATION` | `GLASS_RESOLVED` | One valid candidate, or multiple equivalent valid candidates | Automatic | `GLASS_IDENTIFIED` |
| `GLASS_MATCH_EVALUATION` | `VIN_NEEDED` | Windshield/Back Glass and YMM/options remain materially ambiguous | Automatic | `VIN_LOOKUP_REQUIRED` |
| `GLASS_MATCH_EVALUATION` | `HUMAN_REVIEW_NEEDED` | Ambiguity remains and VIN is prohibited or insufficient (incl. Door/Quarter/Vent) | Automatic | `HUMAN_GLASS_REVIEW_REQUIRED` |
| `GLASS_MATCH_EVALUATION` | `NO_VALID_GLASS` | No valid candidate establishable | Automatic | `GLASS_NOT_IDENTIFIED` |
| `VIN_LOOKUP_REQUIRED` | `START_VIN_LOOKUP` | Eligible glass type, ambiguity documented, no saved successful VIN result | Automatic | `VIN_LOOKUP_IN_PROGRESS` |
| `VIN_LOOKUP_REQUIRED` | `USE_SAVED_VIN_RESULT` | Successful VIN result already on case | Automatic | `GLASS_MATCH_EVALUATION` |
| `VIN_LOOKUP_IN_PROGRESS` | `VIN_RESULT_RETURNED` | Successful lookup persisted to case | Automatic | `GLASS_MATCH_EVALUATION` |
| `VIN_LOOKUP_IN_PROGRESS` | `VIN_LOOKUP_FAILED` | Provider/technical failure or unusable result | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `HUMAN_GLASS_REVIEW_REQUIRED` | `HUMAN_GLASS_SELECTED` | R&R selects a valid candidate with adequate basis | R&R | `GLASS_IDENTIFIED` |
| `HUMAN_GLASS_REVIEW_REQUIRED` | `HUMAN_CANNOT_IDENTIFY` | R&R cannot establish a valid candidate | R&R | `GLASS_NOT_IDENTIFIED` |
| `GLASS_NOT_IDENTIFIED` | `RETRY_IDENTIFICATION` | Corrected/new vehicle or glass information available | R&R | `REQUEST_VALIDATION_IN_PROGRESS` |
| `GLASS_IDENTIFIED` | `START_SOURCING` | At least one valid glass candidate exists | Automatic | `SOURCING_IN_PROGRESS` |

Invariants: `VIN_LOOKUP_REQUIRED` is not legal for Door, Quarter, or Vent Glass. A saved successful VIN lookup must be reused, never automatically repurchased. `GLASS_IDENTIFIED` may represent one candidate or a set of equivalent valid candidates sourced competitively.

Implementation note (Phase 2, v0.1): YMM identification runs synchronously inside case creation (the mock provider is deterministic and instant); the live MyGrant provider will move this to background processing without changing the API contract. `RETRY_IDENTIFICATION` re-enters `YMM_SEARCH_IN_PROGRESS` directly rather than routing through `REQUEST_VALIDATION_IN_PROGRESS`, since the retry re-runs identification against the current intake data. `USE_SAVED_VIN_RESULT` and `START_VIN_LOOKUP` both funnel back through `GLASS_MATCH_EVALUATION` after a VIN result, per the table above.

### Sourcing

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `SOURCING_IN_PROGRESS` | `SUPPLIER_OFFERS_RETURNED` | Supplier search completed | Automatic | `OFFERS_FOUND` |
| `SOURCING_IN_PROGRESS` | `SOURCING_FAILED` | Provider/technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `OFFERS_FOUND` | `EVALUATE_OFFERS` | Always | Automatic | `OFFER_EVALUATION` |
| `OFFER_EVALUATION` | `ELIGIBLE_OFFER_SELECTED` | Valid, available, non-Regional, cheapest among eligible | Automatic | `GLASS_SELECTED` |
| `OFFER_EVALUATION` | `NO_ELIGIBLE_OFFERS` | No valid available non-Regional offer | Automatic | `NO_ELIGIBLE_INVENTORY` |
| `NO_ELIGIBLE_INVENTORY` | `RETRY_SOURCING` | R&R retries after inventory/context change | R&R | `SOURCING_IN_PROGRESS` |
| `GLASS_SELECTED` | `START_PRICING` | Selected offer remains valid | Automatic | `PRICING_IN_PROGRESS` |

### Pricing

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `PRICING_IN_PROGRESS` | `STANDARD_PRICE_CALCULATED` | Pricing rule produces acceptable standard result | Automatic | `PRICE_APPROVED` |
| `PRICING_IN_PROGRESS` | `PRICING_EXCEPTION_DETECTED` | Rule explicitly requires human judgment | Automatic | `PROFIT_REVIEW_REQUIRED` |
| `PRICING_IN_PROGRESS` | `PRICING_FAILED` | Required inputs unavailable or technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `PROFIT_REVIEW_REQUIRED` | `PRICE_APPROVED_BY_RNR` | R&R explicitly accepts proposed/adjusted price | R&R | `PRICE_APPROVED` |
| `PROFIT_REVIEW_REQUIRED` | `PRICE_REJECTED_BY_RNR` | R&R will not proceed at an acceptable price | R&R | `CANCELLATION_REQUESTED` |
| `PRICE_APPROVED` | `GENERATE_QUOTE` | Approved price snapshot exists | Automatic | `QUOTE_GENERATING` |

### Quote and Approval

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `QUOTE_GENERATING` | `QUOTE_CREATED` | Immutable quote version created | Automatic | `QUOTE_READY` |
| `QUOTE_GENERATING` | `QUOTE_GENERATION_FAILED` | Document/data generation failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `QUOTE_READY` | `DELIVER_QUOTE` | Delivery destination/channel available | Automatic/System | `AWAITING_APPROVAL` |
| `QUOTE_READY` | `QUOTE_DELIVERY_FAILED` | Delivery attempt fails | Automatic/System | `QUOTE_DELIVERY_FAILED` |
| `QUOTE_DELIVERY_FAILED` | `RETRY_QUOTE_DELIVERY` | Delivery issue corrected/retry requested | R&R/System | `QUOTE_READY` |
| `AWAITING_APPROVAL` | `QUOTE_APPROVED` | Valid approval within quote validity | Customer/Partner | `QUOTE_APPROVED` |
| `AWAITING_APPROVAL` | `QUOTE_DECLINED` | Explicit decline received | Customer/Partner | `QUOTE_DECLINED` |
| `AWAITING_APPROVAL` | `QUOTE_EXPIRED` | Validity window elapsed without valid approval | Automatic | `QUOTE_EXPIRED` |
| `AWAITING_APPROVAL` | `COMMERCIAL_INPUT_CHANGED` | Inventory/cost/scope change invalidates offer before approval | Automatic/R&R | `REQUOTE_REQUIRED` |
| `QUOTE_DECLINED` | `REVISE_AND_REQUOTE` | R&R revises commercial terms/scope | R&R | `REQUOTE_REQUIRED` |
| `QUOTE_DECLINED` | `CLOSE_DECLINED_CASE` | R&R accepts decline as end of job | R&R | `CANCELLATION_REQUESTED` |
| `QUOTE_EXPIRED` | `REQUOTE` | R&R elects to continue | R&R | `REQUOTE_REQUIRED` |
| `QUOTE_EXPIRED` | `CLOSE_EXPIRED_CASE` | R&R elects not to continue | R&R | `CANCELLATION_REQUESTED` |
| `REQUOTE_REQUIRED` | `RESOURCE_FOR_REQUOTE` | Inventory/offer must be refreshed | Automatic/R&R | `SOURCING_IN_PROGRESS` |
| `REQUOTE_REQUIRED` | `REPRICE_WITH_CURRENT_SELECTION` | Selected offer still valid; terms must change | R&R/System | `PRICING_IN_PROGRESS` |
| `QUOTE_APPROVED` | `START_INVENTORY_RECHECK` | Approval is valid | Automatic | `INVENTORY_RECHECK_IN_PROGRESS` |

Invariants: an approved/declined/expired quote version is never rewritten — requote creates a new version. Quote expiration must not automatically trigger another VIN lookup.

### Procurement

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `INVENTORY_RECHECK_IN_PROGRESS` | `SELECTED_OFFER_STILL_AVAILABLE` | Approved offer remains valid and available | Automatic | `READY_TO_ORDER` |
| `INVENTORY_RECHECK_IN_PROGRESS` | `SELECTED_OFFER_UNAVAILABLE` | Offer no longer available/valid | Automatic | `RESOURCING_REQUIRED` |
| `INVENTORY_RECHECK_IN_PROGRESS` | `INVENTORY_RECHECK_FAILED` | Provider/technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `RESOURCING_REQUIRED` | `START_RESOURCING` | Saved candidates/interchangeables available | Automatic | `SOURCING_IN_PROGRESS` |
| `READY_TO_ORDER` | `REQUEST_PURCHASE_CONFIRMATION` | Purchase details complete | Automatic | `PURCHASE_CONFIRMATION_REQUIRED` |
| `PURCHASE_CONFIRMATION_REQUIRED` | `PURCHASE_CONFIRMED` | R&R explicitly authorizes purchase | R&R | `ORDER_IN_PROGRESS` |
| `PURCHASE_CONFIRMATION_REQUIRED` | `PURCHASE_NOT_CONFIRMED` | R&R decides not to order | R&R | `CANCELLATION_REQUESTED` |
| `ORDER_IN_PROGRESS` | `ORDER_SUCCEEDED` | Supplier confirms order | Automatic/System | `GLASS_ORDERED` |
| `ORDER_IN_PROGRESS` | `ORDER_FAILED` | Supplier purchase fails | Automatic/System | `ORDER_FAILED` |
| `ORDER_FAILED` | `RETRY_ORDER` | Failure retryable and offer still valid | R&R/System | `PURCHASE_CONFIRMATION_REQUIRED` |
| `ORDER_FAILED` | `RESOURCE_AFTER_ORDER_FAILURE` | Selected offer no longer usable | R&R/System | `RESOURCING_REQUIRED` |
| `GLASS_ORDERED` | `REQUEST_SCHEDULING` | Ordered glass/job ready to schedule | Automatic/R&R | `SCHEDULING_REQUIRED` |

Invariant: no transition may enter `ORDER_IN_PROGRESS` without passing through `PURCHASE_CONFIRMATION_REQUIRED` and receiving `PURCHASE_CONFIRMED`.

### Installation

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `SCHEDULING_REQUIRED` | `INSTALLATION_BOOKED` | Appointment accepted/confirmed | R&R/Customer | `INSTALLATION_SCHEDULED` |
| `INSTALLATION_SCHEDULED` | `RESCHEDULE_NEEDED` | Appointment can no longer proceed | R&R/Customer/System | `INSTALLATION_RESCHEDULE_REQUIRED` |
| `INSTALLATION_SCHEDULED` | `START_INSTALLATION` | Technician begins work | Technician | `INSTALLATION_IN_PROGRESS` |
| `INSTALLATION_RESCHEDULE_REQUIRED` | `INSTALLATION_REBOOKED` | New appointment confirmed | R&R/Customer | `INSTALLATION_SCHEDULED` |
| `INSTALLATION_IN_PROGRESS` | `INSTALLATION_SUCCEEDED` | Requested installation completed | Technician | `INSTALLATION_COMPLETED` |
| `INSTALLATION_IN_PROGRESS` | `INSTALLATION_PROBLEM` | Problem prevents normal completion | Technician | `INSTALLATION_EXCEPTION` |
| `INSTALLATION_EXCEPTION` | `RESCHEDULE_AFTER_EXCEPTION` | Job can continue later with current procurement | R&R | `INSTALLATION_RESCHEDULE_REQUIRED` |
| `INSTALLATION_EXCEPTION` | `REPLACEMENT_GLASS_REQUIRED` | New sourcing/procurement required | R&R | `RESOURCING_REQUIRED` |
| `INSTALLATION_EXCEPTION` | `CANNOT_COMPLETE_JOB` | R&R determines job cannot be completed | R&R | `CANCELLATION_REQUESTED` |
| `INSTALLATION_COMPLETED` | `GENERATE_FINAL_INVOICE` | Completion details recorded | Automatic | `FINAL_INVOICE_GENERATING` |

### Closeout

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `FINAL_INVOICE_GENERATING` | `FINAL_INVOICE_CREATED` | Final invoice created | Automatic | `FINAL_INVOICE_READY` |
| `FINAL_INVOICE_GENERATING` | `FINAL_INVOICE_FAILED` | Generation failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `FINAL_INVOICE_READY` | `RECORD_JOB_ECONOMICS` | Actual revenue/cost inputs available | Automatic/System | `JOB_PROFIT_RECORDED` |
| `JOB_PROFIT_RECORDED` | `CLOSE_COMPLETED_JOB` | Required closeout records complete | Automatic | `COMPLETED` |

## 5. Global exception transitions

**Cancellation** may be requested from any non-terminal state where cancellation is operationally valid. The engine must record who requested it, the reason, the state at request time, and whether financial/procurement cleanup is required. (Which post-order states need supplier/restocking handling is still open — see §10.)

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| Eligible non-terminal state | `REQUEST_CANCELLATION` | Cancellation permitted for current context | Human | `CANCELLATION_REQUESTED` |
| `CANCELLATION_REQUESTED` | `CANCELLATION_CONFIRMED` | Required cleanup/authorization completed | R&R | `CANCELLED` |
| `CANCELLATION_REQUESTED` | `CANCELLATION_REJECTED` | R&R determines case should continue | R&R | Prior recoverable state |

**System attention** is a safe blocked state for when the system cannot automatically progress without risking an invalid business action. The case must retain a `recover_to_state` value.

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| Any eligible automatic-processing state | `UNRECOVERABLE_AUTOMATION_ERROR` | Safe automatic progression impossible | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `SYSTEM_ATTENTION_REQUIRED` | `RETRY_FAILED_OPERATION` | Error corrected and retry is safe | R&R/System | `recover_to_state` |
| `SYSTEM_ATTENTION_REQUIRED` | `CANCEL_AFTER_SYSTEM_FAILURE` | R&R elects not to continue | R&R | `CANCELLATION_REQUESTED` |

## 6. Persona action ownership

Legend: **ALLOW** = may perform/request when workflow guards allow · **CONDITIONAL** = only when the case explicitly requires that persona's input · **VIEW** = may see the projection/document but does not own the action · **FORBIDDEN** = must not be offered · **SYSTEM** = automatic/system-owned.

| User-visible action | R&R Staff | Direct Customer | Auction | Insurance | Owning actor / rule |
| --- | --- | --- | --- | --- | --- |
| Create canonical Case | **ALLOW** | FORBIDDEN in v0.1 | FORBIDDEN in v0.1 | FORBIDDEN in v0.1 | R&R Staff. External intake must arrive through an accepted channel contract, never arbitrary mutation. |
| View own/current Case | **ALLOW** | VIEW own Direct Case | VIEW own Auction Case | VIEW own Insurance Case | Each external persona sees only its persona projection. |
| View canonical internal workflow state | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R Staff only; externals get friendly projected status. |
| Edit required intake data before progression | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | External persona supplies missing info only when the case explicitly asks that channel. |
| Trigger workflow validation | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after create/update. |
| Start YMM search | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after valid intake. |
| Request/force paid VIN lookup | FORBIDDEN as arbitrary action | FORBIDDEN | FORBIDDEN | FORBIDDEN | Only through eligibility/ambiguity rules. No generic paid-lookup button for any persona. |
| Reuse saved VIN result | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic; saved successful result must be reused. |
| Resolve ambiguous glass manually | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Retry identification after corrected data | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R action after new/corrected information. |
| Start sourcing | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after glass identification. |
| Retry sourcing | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Select supplier offer automatically | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | System evaluates eligible non-Regional offers under accepted rules. |
| Approve pricing/profit exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R commercial control. |
| Reject unacceptable price | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R may stop/cancel rather than proceed at an unacceptable price. |
| View current quote/estimate | **ALLOW** | **VIEW** | **VIEW** | **VIEW** | Wording/document projection varies by channel. |
| Approve/decline Direct quote | VIEW/record valid result | **ALLOW** | FORBIDDEN | FORBIDDEN | Direct Customer owns Direct quote approval/decline. |
| Approve/decline Auction quote | VIEW/record valid result | FORBIDDEN | **ALLOW** | FORBIDDEN | Auction counterparty owns Auction approval/decline. |
| Authorize/decline Insurance estimate/scope | VIEW/record valid result | FORBIDDEN | FORBIDDEN | **ALLOW** | Insurance authorization is distinct from Direct/Auction approval. |
| Rewrite an approved/declined/expired quote version | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | Quote history immutable; requote creates a new version. |
| Initiate requote after change/decline/expiry | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R decides whether to continue/requote; system may detect the need. |
| Start inventory recheck after approval | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after valid approval. |
| Confirm supplier purchase | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | Explicit R&R confirmation mandatory before money is committed. |
| Decline supplier purchase | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R may stop the job. |
| Retry failed order / re-source after order failure | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational recovery. |
| Place supplier order | SYSTEM after R&R confirmation | FORBIDDEN | FORBIDDEN | FORBIDDEN | Provider/service executes only after explicit R&R confirmation. |
| View glass ordered status | **ALLOW** | VIEW | VIEW | VIEW/conditional | Persona-facing projection follows §8 policy. |
| Propose/request appointment | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | R&R owns scheduling; external persona participates when the channel must coordinate a time. |
| Confirm/reschedule appointment | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | Channel/context dependent; R&R retains visibility/control. |
| Start/complete installation | **ALLOW**/record | FORBIDDEN | FORBIDDEN | FORBIDDEN | Operational/technician action; authenticated R&R records it until a Technician persona exists. |
| Record installation problem/exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Choose recovery path after exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R decides reschedule/replacement/cannot-complete. |
| Generate final invoice | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after completion details recorded. |
| View/receive final invoice | **ALLOW** | **VIEW** | **VIEW** | **VIEW** | Delivery semantics channel-specific. |
| Record job economics/profit | SYSTEM/R&R operational data | FORBIDDEN | FORBIDDEN | FORBIDDEN | Internal financial closeout only. |
| Close completed Case | SYSTEM when closeout complete | FORBIDDEN | FORBIDDEN | FORBIDDEN | External completion does not directly mutate terminal state. |
| Request cancellation | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** | External persona may request for its own case; R&R/workflow determines the final transition. |
| Finalize cancellation | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational authority. |
| Edit/delete historical Case events | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | Corrections via later append-only events. |
| Arbitrarily patch workflow state | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | All state changes through business actions + guards. |

### Approval semantics by channel

- **Direct Customer:** accepts/declines the current Direct quote. Applies only to the current valid quote version; expired/superseded quotes cannot be approved; a changed offer requires a new version. Approval does **not** authorize supplier purchase.
- **Auction:** the counterparty accepts/declines the current commercial quote for that vehicle/job. Recorded separately from Direct approval. Does **not** authorize supplier purchase.
- **Insurance:** the carrier authorizes/declines the current estimate/scope. Not modeled as a customer approval; reauthorization may be required after material changes. Does **not** authorize supplier purchase.
- **R&R Staff** may receive and record evidence of a valid external approval and continue/requote/close accordingly, and must confirm supplier purchase separately. Staff must never fabricate an external approval, treat one channel's approval as another's, or use purchase confirmation as a substitute for customer/partner approval.

### Channel data isolation (enforced)

1. **Staff without a `channels` claim** (the admin and current staff) have full access to all channels. This is the v0.1 default and is unchanged.
2. **Staff with a `channels` claim** (channel-scoped staff, stored on `staff_users.channels` and embedded in the session token) may only create, list, read, and act on cases in those channels. Cross-channel reads return 404 (not 403) so case existence cannot be probed across channels; cross-channel creation returns 403 `CHANNEL_FORBIDDEN`. The claim is backend-enforced on every `/api/v1/cases*` route.
3. **External approvers** never get a staff session. They receive an opaque, single-use, expiring approval token (`approval_tokens`: `rnappr_…`, only the sha256 hash stored) minted by staff for one case + one purpose (`quote-approval`). The token grants access to that case's approval action only — never channel-wide access, never internal workflow state, supplier offers, or margin data. Verification never consumes; the caller consumes after the approved action succeeds so a failed attempt can retry.
4. **Database:** RLS is enabled on `approval_tokens` (and all Case Core tables) with no anon/authenticated client policies — all access goes through the Express API. Direct Data API access is denied by default.

## 7. Forbidden boundaries

External personas (Direct Customer, Auction, Insurance) must never be offered controls to: directly set internal workflow state; choose glass candidates; run paid VIN lookup on demand; choose supplier offers; override Regional exclusion; approve internal profit exceptions; confirm supplier purchase; retry supplier orders directly; rewrite historical quote versions; edit/delete case events; record internal job profit; mark a case `COMPLETED`/`CANCELLED` directly.

R&R Staff must never be offered controls to: directly patch arbitrary workflow state; rewrite/delete historical business events; rewrite an accepted/declined/expired historical quote version; bypass purchase confirmation and commit supplier spend through an unguarded action.

Forbidden transition classes (invalid regardless of frontend behavior): intake-blocked → sourcing/pricing/quote/procurement/install/complete; any state → `VIN_LOOKUP_REQUIRED` for Door/Quarter/Vent; `VIN_LOOKUP_REQUIRED` → paid lookup when a reusable saved VIN result exists; any pre-approval state → supplier order; `READY_TO_ORDER` → `ORDER_IN_PROGRESS` without R&R purchase confirmation; `QUOTE_DECLINED`/`QUOTE_EXPIRED` → procurement without a subsequent valid approved quote; `NO_ELIGIBLE_INVENTORY` → pricing/quote unless sourcing later produces an eligible offer; `COMPLETED`/`CANCELLED` → any other state. Forbidden actions must be denied server-side even if a UI accidentally exposes them; architecture must not infer permissions from UI visibility alone.

## 8. Communication: internal state → persona status → notification

These are three separate decisions; they must not be collapsed into one model.

- **Internal workflow state** — the actual business state driving progression, recovery, rules, audit history, and testing (e.g. `INVENTORY_RECHECK_IN_PROGRESS`).
- **Persona-visible status** — surfaced only when knowing it is meaningful or actionable for that persona: a precise status, a simplified friendly status, a broader phase grouping several states, or nothing at all. `Hidden` is a valid decision.
- **Notification** — a visible status does not automatically generate one. Notifications are reserved for events requiring attention, action, awareness of a meaningful change, confirmation of an important commitment, or awareness of an important exception. `Visible — no notification` is a valid decision.

Pipeline: internal state → persona visibility rule → persona-friendly status → notification rule. The workflow engine owns business truth; presentation and notification layers translate it without changing it. The later persona-message specification must not mechanically create a message for every state and persona. Valid outcomes per persona/state: `Hidden`, `Visible — no notification`, `Visible — notify`, `Action required — notify`.

Notification semantics: **No notification** — visible but no outbound alert. **Yes — confirmation** — a meaningful commitment/result was reached. **Yes — action required** — the persona must do something. **Yes — meaningful exception/change** — the case materially deviated from the normal path. **Conditional** — notify only when the stated condition is true.

Default behavior (unless a state has an explicit override): R&R Staff sees the internal operational state, no notification. Direct Customer, Auction, and Insurance see hidden, no notification. This keeps short-lived automatic states from creating noise.

Review rule: if a persona does not need to know a state changed, the result is `Hidden / No notification`. If they can benefit from seeing progress without interruption, `Visible / No notification`.

### Explicit persona policy

Format: `persona-visible status / notification policy`.

| Internal state | R&R Staff | Direct Customer | Auction | Insurance |
| --- | --- | --- | --- | --- |
| `REQUEST_RECEIVED` | Request received / no alert | Request received / confirmation | Vehicle request received / confirmation | Assignment received / confirmation |
| `REQUEST_VALIDATION_REQUIRED` | Intake blocked / action required | Need more info / notify if customer owns missing info | Need more info / notify if auction owns missing info | Need more info / notify if carrier owns missing info |
| `YMM_SEARCH_IN_PROGRESS` | Searching YMM / no alert | Identifying correct glass / no alert | Glass identification in progress / no alert | Replacement identification in progress / no alert |
| `HUMAN_GLASS_REVIEW_REQUIRED` | Review required / action required | Verifying correct glass / no alert | Under review / no alert | Under review / no alert |
| `NO_ELIGIBLE_INVENTORY` | No eligible inventory / action required | Glass unavailable / meaningful exception | No eligible inventory / meaningful exception | Replacement unavailable / meaningful exception |
| `QUOTE_READY` | Quote ready / action if manual send | Quote ready / action required | Quote ready / action required | Estimate ready / authorization may be required |
| `AWAITING_APPROVAL` | Awaiting approval / no alert | Quote ready for review / action required | Awaiting quote approval / action required | Awaiting authorization / action required |
| `QUOTE_APPROVED` | Approved / meaningful change | Approved / confirmation | Approved / confirmation | Authorization received / confirmation |
| `QUOTE_DECLINED` | Declined / attention | Declined / confirmation | Declined / confirmation | Authorization/estimate declined / confirmation |
| `QUOTE_EXPIRED` | Expired / attention | Quote expired / meaningful change | Quote expired / meaningful change | Authorization window expired / meaningful change |
| `REQUOTE_REQUIRED` | Requote required / action | Updating quote / notify only if terms change | Updating quote / notify only if approval needed again | Updating estimate / notify only if reauthorization needed |
| `PURCHASE_CONFIRMATION_REQUIRED` | Purchase confirmation required / action required | Order prep in progress / no alert | Order prep in progress / no alert | Procurement prep / no alert |
| `ORDER_FAILED` | Supplier order failed / action required | Resolving ordering issue / notify only if customer impact | Ordering issue / notify only if partner impact | Procurement issue / notify only if authorization/schedule impact |
| `GLASS_ORDERED` | Glass ordered / confirmation | Glass ordered / confirmation | Glass ordered / confirmation | Replacement ordered / optional based on carrier workflow |
| `SCHEDULING_REQUIRED` | Scheduling required / action | Ready to schedule / action | Ready to schedule / action | Ready for scheduling / notify if coordination needed |
| `INSTALLATION_SCHEDULED` | Scheduled / confirmation | Scheduled / confirmation + reminder | Scheduled / confirmation | Scheduled / notify if carrier workflow requires |
| `INSTALLATION_RESCHEDULE_REQUIRED` | Reschedule required / action | Appointment needs reschedule / action | Reschedule required / action | Schedule changed / notify if carrier needs awareness |
| `INSTALLATION_EXCEPTION` | Installation exception / action | Issue encountered / notify if completion, schedule, or price changes | Exception / notify if completion/schedule changes | Exception / notify if authorization/scope/schedule changes |
| `INSTALLATION_COMPLETED` | Completed / confirmation | Installation complete / confirmation | Installation complete / confirmation | Installation complete / completion notice if required |
| `FINAL_INVOICE_READY` | Invoice ready / action if manual delivery | Final invoice ready / document alert | Final invoice ready / document alert | Invoice ready for submission / action alert |
| `COMPLETED` | Job closed / no alert | Service complete / final confirmation | Job complete / final confirmation | Work completed / final notice if required |
| `CANCELLATION_REQUESTED` | Cancellation requested / action required | Cancellation processing / confirmation | Cancellation processing / confirmation | Cancellation processing / confirmation when externally relevant |
| `CANCELLED` | Cancelled / confirmation | Service request cancelled / final confirmation | Job cancelled / final confirmation | Assignment closed/cancelled / final confirmation |
| `SYSTEM_ATTENTION_REQUIRED` | System attention / action required | Hidden unless timing affected | Hidden unless timing affected | Hidden unless service/authorization timing affected |

## 9. Technician boundary

`INSTALLATION_IN_PROGRESS` is driven by a Technician, but no separate authenticated Technician persona exists yet. Until one is defined and accepted: no separate technician role, portal, or permission set may be invented; installation transitions are attributed to an operational/technician driver and recorded by authenticated R&R Staff; the UI must not present installation completion as a generic action available to other personas.

## 10. Open questions

Intentionally unresolved rather than invented:

1. Exact lower-profit pricing formula when glass cost is under $50.
2. Exact taxable base for Massachusetts sales tax.
3. Whether 72 hours is the final quote-validity duration.
4. Which post-order cancellation scenarios incur supplier/restocking/cancellation consequences.
5. Whether an installation exception requiring new glass always requires a customer re-quote or can remain inside the accepted commercial amount.
6. How insurance authorization semantics differ when the carrier/work-order flow does not use a customer-facing quote.

These do not block the state machine topology but must be resolved before the relevant production rules are frozen.

## 11. Acceptance record

- Persona permissions (§6–§7): accepted by human review 2026-09-26 (PR #86).
- Remainder: draft for review. Frozen when every non-terminal state has a legal exit and entry path, YMM-first and VIN-protection rules cannot be bypassed, quote decline/expiry cannot reach procurement without re-approval, ordering cannot bypass R&R purchase confirmation, resourcing loops cannot trigger automatic repeat VIN purchases, exception states have explicit recovery/termination, and the owner confirms the paths match real R&R operations.
