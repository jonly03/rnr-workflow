# R&R Case Transition Matrix v0.1

Status: Draft for review  
Depends on: `state-inventory-v0.1.md`, `communication-principles.md`

## Purpose

This matrix defines the legal business-state transitions for an R&R auto-glass case.

The workflow engine must only allow transitions represented here, plus the explicitly defined global exception transitions.

A transition consists of:

- current state;
- triggering event;
- guard or condition;
- actor/driver;
- next state.

The frontend may request an action, but it must not directly set workflow state.

---

## Global rules

1. `COMPLETED` and `CANCELLED` are terminal.
2. Missing required intake data blocks progression beyond Intake.
3. Required intake fields are Year, Make, Model, VIN, and Glass Type.
4. YMM search always occurs before any VIN lookup.
5. VIN lookup is eligible only for Windshield and Back Glass ambiguity.
6. Door, Quarter, and Vent Glass must never transition to `VIN_LOOKUP_REQUIRED`.
7. A successful VIN lookup is persisted to the case and must not be automatically repeated for that case.
8. Regional inventory is excluded from normal sourcing.
9. Quote history is immutable; a changed commercial offer produces a new quote version rather than rewriting an accepted historical quote.
10. Supplier purchase requires explicit R&R confirmation before money is committed.
11. Short-lived internal states do not automatically imply persona-visible status changes or notifications.

---

## Intake

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `REQUEST_RECEIVED` | `VALIDATE_REQUEST` | Always | Automatic | `REQUEST_VALIDATION_IN_PROGRESS` |
| `REQUEST_VALIDATION_IN_PROGRESS` | `VALIDATION_FAILED` | Any required field missing or invalid | Automatic | `REQUEST_VALIDATION_REQUIRED` |
| `REQUEST_VALIDATION_IN_PROGRESS` | `VALIDATION_PASSED` | Year, Make, Model, VIN, Glass Type all valid enough to continue | Automatic | `READY_FOR_YMM_SEARCH` |
| `REQUEST_VALIDATION_REQUIRED` | `REQUEST_DATA_UPDATED` | Missing/invalid intake data changed | Human/System | `REQUEST_VALIDATION_IN_PROGRESS` |
| `READY_FOR_YMM_SEARCH` | `START_YMM_SEARCH` | Intake remains valid | Automatic | `YMM_SEARCH_IN_PROGRESS` |

### Intake invariant

There is no legal transition from `REQUEST_VALIDATION_REQUIRED` directly to a search, pricing, quote, order, installation, or completion state.

---

## Glass Identification

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `YMM_SEARCH_IN_PROGRESS` | `YMM_RESULTS_RETURNED` | Search completed with candidate results | Automatic | `YMM_RESULTS_FOUND` |
| `YMM_SEARCH_IN_PROGRESS` | `YMM_SEARCH_FAILED` | Provider/technical failure prevents safe continuation | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `YMM_RESULTS_FOUND` | `EVALUATE_GLASS_MATCHES` | Always | Automatic | `GLASS_MATCH_EVALUATION` |
| `GLASS_MATCH_EVALUATION` | `GLASS_RESOLVED` | One valid candidate or multiple equivalent valid candidates can proceed together | Automatic | `GLASS_IDENTIFIED` |
| `GLASS_MATCH_EVALUATION` | `VIN_NEEDED` | Glass Type is Windshield or Back Glass and YMM/options remain materially ambiguous | Automatic | `VIN_LOOKUP_REQUIRED` |
| `GLASS_MATCH_EVALUATION` | `HUMAN_REVIEW_NEEDED` | Ambiguity remains and VIN is prohibited or insufficient; includes Door/Quarter/Vent ambiguity | Automatic | `HUMAN_GLASS_REVIEW_REQUIRED` |
| `GLASS_MATCH_EVALUATION` | `NO_VALID_GLASS` | No valid candidate can be established | Automatic | `GLASS_NOT_IDENTIFIED` |
| `VIN_LOOKUP_REQUIRED` | `START_VIN_LOOKUP` | Eligible glass type, ambiguity documented, no saved successful VIN result for this case | Automatic | `VIN_LOOKUP_IN_PROGRESS` |
| `VIN_LOOKUP_REQUIRED` | `USE_SAVED_VIN_RESULT` | Successful VIN result already exists on case | Automatic | `GLASS_MATCH_EVALUATION` |
| `VIN_LOOKUP_IN_PROGRESS` | `VIN_RESULT_RETURNED` | Successful lookup persisted to case | Automatic | `GLASS_MATCH_EVALUATION` |
| `VIN_LOOKUP_IN_PROGRESS` | `VIN_LOOKUP_FAILED` | Provider/technical failure or result cannot safely resolve workflow | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `HUMAN_GLASS_REVIEW_REQUIRED` | `HUMAN_GLASS_SELECTED` | R&R selects a valid candidate with adequate basis | R&R | `GLASS_IDENTIFIED` |
| `HUMAN_GLASS_REVIEW_REQUIRED` | `HUMAN_CANNOT_IDENTIFY` | R&R cannot establish a valid candidate | R&R | `GLASS_NOT_IDENTIFIED` |
| `GLASS_NOT_IDENTIFIED` | `RETRY_IDENTIFICATION` | Corrected/new vehicle or glass information is available | R&R | `REQUEST_VALIDATION_IN_PROGRESS` |
| `GLASS_IDENTIFIED` | `START_SOURCING` | At least one valid glass candidate exists | Automatic | `SOURCING_IN_PROGRESS` |

### Glass-identification invariants

- `VIN_LOOKUP_REQUIRED` is not legal for Door, Quarter, or Vent Glass.
- A saved successful VIN lookup must be reused rather than automatically repurchased.
- `GLASS_IDENTIFIED` may represent one candidate or a set of equivalent valid candidates that can be sourced competitively.

---

## Sourcing

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `SOURCING_IN_PROGRESS` | `SUPPLIER_OFFERS_RETURNED` | Supplier search completed | Automatic | `OFFERS_FOUND` |
| `SOURCING_IN_PROGRESS` | `SOURCING_FAILED` | Provider/technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `OFFERS_FOUND` | `EVALUATE_OFFERS` | Always | Automatic | `OFFER_EVALUATION` |
| `OFFER_EVALUATION` | `ELIGIBLE_OFFER_SELECTED` | Offer is valid, available, non-Regional, and cheapest among eligible offers | Automatic | `GLASS_SELECTED` |
| `OFFER_EVALUATION` | `NO_ELIGIBLE_OFFERS` | No valid available non-Regional offer exists | Automatic | `NO_ELIGIBLE_INVENTORY` |
| `NO_ELIGIBLE_INVENTORY` | `RETRY_SOURCING` | R&R elects to retry after inventory/context change | R&R | `SOURCING_IN_PROGRESS` |
| `GLASS_SELECTED` | `START_PRICING` | Selected offer remains valid | Automatic | `PRICING_IN_PROGRESS` |

### Sourcing invariant

A Regional offer may be recorded for audit/reference if returned by the provider, but it is not eligible for normal automatic selection.

---

## Pricing

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `PRICING_IN_PROGRESS` | `STANDARD_PRICE_CALCULATED` | Pricing rule produces an acceptable standard result | Automatic | `PRICE_APPROVED` |
| `PRICING_IN_PROGRESS` | `PRICING_EXCEPTION_DETECTED` | Low-cost/profit or another rule explicitly requires human judgment | Automatic | `PROFIT_REVIEW_REQUIRED` |
| `PRICING_IN_PROGRESS` | `PRICING_FAILED` | Required inputs unavailable or technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `PROFIT_REVIEW_REQUIRED` | `PRICE_APPROVED_BY_RNR` | R&R explicitly accepts the proposed/adjusted customer price | R&R | `PRICE_APPROVED` |
| `PROFIT_REVIEW_REQUIRED` | `PRICE_REJECTED_BY_RNR` | R&R will not proceed at an acceptable price | R&R | `CANCELLATION_REQUESTED` |
| `PRICE_APPROVED` | `GENERATE_QUOTE` | Approved price snapshot exists | Automatic | `QUOTE_GENERATING` |

---

## Quote and Approval

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `QUOTE_GENERATING` | `QUOTE_CREATED` | Immutable quote version successfully created | Automatic | `QUOTE_READY` |
| `QUOTE_GENERATING` | `QUOTE_GENERATION_FAILED` | Document/data generation failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `QUOTE_READY` | `DELIVER_QUOTE` | Delivery destination/channel is available | Automatic/System | `AWAITING_APPROVAL` |
| `QUOTE_READY` | `QUOTE_DELIVERY_FAILED` | Delivery attempt fails | Automatic/System | `QUOTE_DELIVERY_FAILED` |
| `QUOTE_DELIVERY_FAILED` | `RETRY_QUOTE_DELIVERY` | Delivery issue corrected/retry requested | R&R/System | `QUOTE_READY` |
| `AWAITING_APPROVAL` | `QUOTE_APPROVED` | Valid approval received within current quote validity | Customer/Partner | `QUOTE_APPROVED` |
| `AWAITING_APPROVAL` | `QUOTE_DECLINED` | Explicit decline received | Customer/Partner | `QUOTE_DECLINED` |
| `AWAITING_APPROVAL` | `QUOTE_EXPIRED` | Quote validity window elapsed without valid approval | Automatic | `QUOTE_EXPIRED` |
| `AWAITING_APPROVAL` | `COMMERCIAL_INPUT_CHANGED` | Inventory/cost/scope change invalidates current offer before approval | Automatic/R&R | `REQUOTE_REQUIRED` |
| `QUOTE_DECLINED` | `REVISE_AND_REQUOTE` | R&R elects to revise commercial terms or scope | R&R | `REQUOTE_REQUIRED` |
| `QUOTE_DECLINED` | `CLOSE_DECLINED_CASE` | R&R accepts decline as end of job | R&R | `CANCELLATION_REQUESTED` |
| `QUOTE_EXPIRED` | `REQUOTE` | R&R elects to continue | R&R | `REQUOTE_REQUIRED` |
| `QUOTE_EXPIRED` | `CLOSE_EXPIRED_CASE` | R&R elects not to continue | R&R | `CANCELLATION_REQUESTED` |
| `REQUOTE_REQUIRED` | `RESOURCE_FOR_REQUOTE` | Inventory/offer must be refreshed | Automatic/R&R | `SOURCING_IN_PROGRESS` |
| `REQUOTE_REQUIRED` | `REPRICE_WITH_CURRENT_SELECTION` | Existing selected offer is still valid but commercial terms must change | R&R/System | `PRICING_IN_PROGRESS` |
| `QUOTE_APPROVED` | `START_INVENTORY_RECHECK` | Approval is valid | Automatic | `INVENTORY_RECHECK_IN_PROGRESS` |

### Quote invariants

- An approved/declined/expired quote version is never rewritten.
- Requote creates a new quote version after the necessary source/pricing steps.
- Quote expiration must not automatically trigger another VIN lookup.

---

## Procurement

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `INVENTORY_RECHECK_IN_PROGRESS` | `SELECTED_OFFER_STILL_AVAILABLE` | Approved selected offer remains valid and available | Automatic | `READY_TO_ORDER` |
| `INVENTORY_RECHECK_IN_PROGRESS` | `SELECTED_OFFER_UNAVAILABLE` | Selected offer is no longer available/valid | Automatic | `RESOURCING_REQUIRED` |
| `INVENTORY_RECHECK_IN_PROGRESS` | `INVENTORY_RECHECK_FAILED` | Provider/technical failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `RESOURCING_REQUIRED` | `START_RESOURCING` | Saved glass candidates/interchangeables available | Automatic | `SOURCING_IN_PROGRESS` |
| `READY_TO_ORDER` | `REQUEST_PURCHASE_CONFIRMATION` | Purchase details are complete | Automatic | `PURCHASE_CONFIRMATION_REQUIRED` |
| `PURCHASE_CONFIRMATION_REQUIRED` | `PURCHASE_CONFIRMED` | R&R explicitly authorizes purchase | R&R | `ORDER_IN_PROGRESS` |
| `PURCHASE_CONFIRMATION_REQUIRED` | `PURCHASE_NOT_CONFIRMED` | R&R decides not to place supplier order | R&R | `CANCELLATION_REQUESTED` |
| `ORDER_IN_PROGRESS` | `ORDER_SUCCEEDED` | Supplier confirms order | Automatic/System | `GLASS_ORDERED` |
| `ORDER_IN_PROGRESS` | `ORDER_FAILED` | Supplier purchase fails | Automatic/System | `ORDER_FAILED` |
| `ORDER_FAILED` | `RETRY_ORDER` | Failure is retryable and offer remains valid | R&R/System | `PURCHASE_CONFIRMATION_REQUIRED` |
| `ORDER_FAILED` | `RESOURCE_AFTER_ORDER_FAILURE` | Selected offer is no longer usable | R&R/System | `RESOURCING_REQUIRED` |
| `GLASS_ORDERED` | `REQUEST_SCHEDULING` | Ordered glass/job is ready to schedule | Automatic/R&R | `SCHEDULING_REQUIRED` |

### Procurement invariant

No transition may enter `ORDER_IN_PROGRESS` without passing through `PURCHASE_CONFIRMATION_REQUIRED` and receiving `PURCHASE_CONFIRMED`.

---

## Installation

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `SCHEDULING_REQUIRED` | `INSTALLATION_BOOKED` | Appointment accepted/confirmed | R&R/Customer | `INSTALLATION_SCHEDULED` |
| `INSTALLATION_SCHEDULED` | `RESCHEDULE_NEEDED` | Existing appointment can no longer proceed as planned | R&R/Customer/System | `INSTALLATION_RESCHEDULE_REQUIRED` |
| `INSTALLATION_SCHEDULED` | `START_INSTALLATION` | Technician begins work | Technician | `INSTALLATION_IN_PROGRESS` |
| `INSTALLATION_RESCHEDULE_REQUIRED` | `INSTALLATION_REBOOKED` | New appointment confirmed | R&R/Customer | `INSTALLATION_SCHEDULED` |
| `INSTALLATION_IN_PROGRESS` | `INSTALLATION_SUCCEEDED` | Requested installation completed | Technician | `INSTALLATION_COMPLETED` |
| `INSTALLATION_IN_PROGRESS` | `INSTALLATION_PROBLEM` | Problem prevents normal completion | Technician | `INSTALLATION_EXCEPTION` |
| `INSTALLATION_EXCEPTION` | `RESCHEDULE_AFTER_EXCEPTION` | Job can continue later with current procurement | R&R | `INSTALLATION_RESCHEDULE_REQUIRED` |
| `INSTALLATION_EXCEPTION` | `REPLACEMENT_GLASS_REQUIRED` | New sourcing/procurement is required | R&R | `RESOURCING_REQUIRED` |
| `INSTALLATION_EXCEPTION` | `CANNOT_COMPLETE_JOB` | R&R determines job cannot be completed | R&R | `CANCELLATION_REQUESTED` |
| `INSTALLATION_COMPLETED` | `GENERATE_FINAL_INVOICE` | Completion details recorded | Automatic | `FINAL_INVOICE_GENERATING` |

---

## Closeout

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| `FINAL_INVOICE_GENERATING` | `FINAL_INVOICE_CREATED` | Final invoice created successfully | Automatic | `FINAL_INVOICE_READY` |
| `FINAL_INVOICE_GENERATING` | `FINAL_INVOICE_FAILED` | Generation failure | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `FINAL_INVOICE_READY` | `RECORD_JOB_ECONOMICS` | Actual revenue/cost inputs are available | Automatic/System | `JOB_PROFIT_RECORDED` |
| `JOB_PROFIT_RECORDED` | `CLOSE_COMPLETED_JOB` | Required closeout records are complete | Automatic | `COMPLETED` |

---

## Global cancellation path

Cancellation may be requested from any non-terminal state where cancellation is operationally valid.

The workflow engine must record:

- who requested cancellation;
- reason;
- current state at request time;
- whether financial/procurement cleanup is required.

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| Eligible non-terminal state | `REQUEST_CANCELLATION` | Cancellation permitted for current business context | Human | `CANCELLATION_REQUESTED` |
| `CANCELLATION_REQUESTED` | `CANCELLATION_CONFIRMED` | Required cleanup/authorization completed | R&R | `CANCELLED` |
| `CANCELLATION_REQUESTED` | `CANCELLATION_REJECTED` | R&R determines case should continue | R&R | Prior recoverable state |

The exact set of states where cancellation requires additional financial or supplier handling will be refined when order/payment behavior is implemented.

---

## System attention / recovery

`SYSTEM_ATTENTION_REQUIRED` is a safe blocked state used when the system cannot automatically progress without risking an invalid business action.

The case must retain a `recover_to_state` value identifying the state from which the failure occurred.

| Current state | Event | Guard / condition | Driver | Next state |
| --- | --- | --- | --- | --- |
| Any eligible automatic-processing state | `UNRECOVERABLE_AUTOMATION_ERROR` | Safe automatic progression is impossible | Automatic | `SYSTEM_ATTENTION_REQUIRED` |
| `SYSTEM_ATTENTION_REQUIRED` | `RETRY_FAILED_OPERATION` | Error corrected and retry is safe | R&R/System | `recover_to_state` |
| `SYSTEM_ATTENTION_REQUIRED` | `CANCEL_AFTER_SYSTEM_FAILURE` | R&R elects not to continue | R&R | `CANCELLATION_REQUESTED` |

---

## Explicitly forbidden transition classes

These are invalid regardless of frontend behavior:

- Intake blocked -> sourcing/pricing/quote/procurement/install/complete.
- Any state -> `VIN_LOOKUP_REQUIRED` for Door, Quarter, or Vent Glass.
- `VIN_LOOKUP_REQUIRED` -> paid VIN lookup when a successful reusable VIN result is already saved.
- Any pre-approval state -> supplier order.
- `READY_TO_ORDER` -> `ORDER_IN_PROGRESS` without R&R purchase confirmation.
- `QUOTE_DECLINED` -> procurement without a subsequent valid approved quote.
- `QUOTE_EXPIRED` -> procurement without a subsequent valid approved quote.
- `NO_ELIGIBLE_INVENTORY` -> pricing/quote unless sourcing later produces an eligible offer.
- `COMPLETED` -> any other workflow state.
- `CANCELLED` -> any other workflow state.

---

## Open questions exposed by the transition model

The matrix intentionally leaves these items unresolved rather than inventing rules:

1. Exact lower-profit pricing formula when glass cost is under $50.
2. Exact taxable base for Massachusetts sales tax.
3. Whether 72 hours is the final quote-validity duration.
4. Which post-order cancellation scenarios incur supplier/restocking/cancellation consequences.
5. Whether an installation exception that requires new glass always requires a customer re-quote or can sometimes remain inside the accepted commercial amount.
6. How insurance authorization semantics differ when the carrier/work-order flow does not use a customer-facing quote.

These do not block the topology of the current state machine but must be resolved before the relevant production rules are frozen.

---

## Acceptance criteria for Step 1

Step 1 is ready to freeze when:

- every non-terminal state has at least one legal exit;
- every state has a coherent legal entry path;
- YMM-first and VIN-protection rules cannot be bypassed;
- quote decline/expiration cannot reach procurement without re-approval;
- supplier ordering cannot bypass R&R purchase confirmation;
- resourcing loops do not trigger automatic repeat VIN purchases;
- exception states have explicit recovery or termination behavior;
- the owner confirms the business paths match real R&R operations.

Once accepted, this matrix becomes the source for Step 2: the full case graph.
