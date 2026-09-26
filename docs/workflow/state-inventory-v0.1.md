# R&R Case State Inventory v0.1

Status: Draft for workflow modeling  
Scope: Canonical business states only; not implementation internals.

## Modeling rule

A state exists only when it matters to business progression, workflow recovery, auditability, an R&R operator, or an external persona.

Technical operations such as database writes are not business workflow states.

## Intake requirements

A request cannot progress unless all of the following are present and valid enough to continue:

- Year
- Make
- Model
- VIN
- Glass Type

Validation is automatic. Missing or invalid required intake data blocks progression until corrected.

## State inventory

| Stage | State | Meaning | Driver |
| --- | --- | --- | --- |
| Intake | `REQUEST_RECEIVED` | Request entered the system | Human/System |
| Intake | `REQUEST_VALIDATION_IN_PROGRESS` | System checks required intake fields | Automatic |
| Intake | `REQUEST_VALIDATION_REQUIRED` | One or more required fields are missing or invalid; progression is blocked | Automatic |
| Intake | `READY_FOR_YMM_SEARCH` | Year, Make, Model, VIN, and Glass Type are present and valid enough to continue | Automatic |
| Glass Identification | `YMM_SEARCH_IN_PROGRESS` | MyGrant Year/Make/Model search is running | Automatic |
| Glass Identification | `YMM_RESULTS_FOUND` | Candidate glass results returned | Automatic |
| Glass Identification | `GLASS_MATCH_EVALUATION` | System compares candidates, fit, and options | Automatic |
| Glass Identification | `VIN_LOOKUP_REQUIRED` | Windshield or Back Glass remains ambiguous and VIN can resolve it | Automatic decision |
| Glass Identification | `VIN_LOOKUP_IN_PROGRESS` | One paid VIN lookup is running | Automatic |
| Glass Identification | `HUMAN_GLASS_REVIEW_REQUIRED` | System cannot safely determine the glass automatically | R&R |
| Glass Identification | `GLASS_IDENTIFIED` | One or more equivalent valid glass candidates are established | Automatic/Human |
| Glass Identification | `GLASS_NOT_IDENTIFIED` | No valid glass can currently be established | R&R exception |
| Sourcing | `SOURCING_IN_PROGRESS` | Primary candidates and interchangeables are being searched | Automatic |
| Sourcing | `OFFERS_FOUND` | Supplier/warehouse offers returned | Automatic |
| Sourcing | `OFFER_EVALUATION` | Unavailable and excluded offers are removed and prices compared | Automatic |
| Sourcing | `GLASS_SELECTED` | Cheapest eligible available glass is selected | Automatic |
| Sourcing | `NO_ELIGIBLE_INVENTORY` | Nothing valid is available from eligible inventory | R&R exception |
| Pricing | `PRICING_IN_PROGRESS` | Glass cost, labor, target profit, and tax are being calculated | Automatic |
| Pricing | `PROFIT_REVIEW_REQUIRED` | Pricing falls into an exception requiring R&R judgment | R&R |
| Pricing | `PRICE_APPROVED` | Customer-facing price is established | Automatic/Human |
| Quote | `QUOTE_GENERATING` | Quote snapshot/document is being created | Automatic |
| Quote | `QUOTE_READY` | Quote exists and is ready to send | Automatic |
| Quote | `QUOTE_DELIVERY_FAILED` | Quote could not be delivered through the configured channel | R&R/System |
| Quote | `AWAITING_APPROVAL` | Quote delivered; waiting on the appropriate approver | Customer/Partner |
| Quote | `QUOTE_APPROVED` | Required approval received | Customer/Partner |
| Quote | `QUOTE_DECLINED` | Quote explicitly rejected | Customer/Partner |
| Quote | `QUOTE_EXPIRED` | Approval window elapsed | Automatic |
| Quote | `REQUOTE_REQUIRED` | Availability, price, or another approved input changed enough to require a new quote | Automatic/R&R |
| Procurement | `INVENTORY_RECHECK_IN_PROGRESS` | Saved selected part is being rechecked before purchase | Automatic |
| Procurement | `RESOURCING_REQUIRED` | Previously selected glass is no longer available | Automatic |
| Procurement | `READY_TO_ORDER` | Approved quote and currently valid inventory are ready for purchase | Automatic |
| Procurement | `PURCHASE_CONFIRMATION_REQUIRED` | R&R must authorize spending before supplier purchase | R&R |
| Procurement | `ORDER_IN_PROGRESS` | Supplier order operation is occurring | Automatic |
| Procurement | `ORDER_FAILED` | Purchase did not complete | R&R/System |
| Procurement | `GLASS_ORDERED` | Supplier order successfully placed | Automatic |
| Installation | `SCHEDULING_REQUIRED` | Job needs an installation appointment | R&R/Customer |
| Installation | `INSTALLATION_SCHEDULED` | Appointment is confirmed | R&R |
| Installation | `INSTALLATION_RESCHEDULE_REQUIRED` | Existing appointment cannot proceed as planned | R&R/Customer |
| Installation | `INSTALLATION_IN_PROGRESS` | Technician has started the job | Technician |
| Installation | `INSTALLATION_EXCEPTION` | A problem prevents normal installation completion | Technician/R&R |
| Installation | `INSTALLATION_COMPLETED` | Requested glass work is complete | Technician |
| Closeout | `FINAL_INVOICE_GENERATING` | Final financial/document record is being created | Automatic |
| Closeout | `FINAL_INVOICE_READY` | Final invoice exists | Automatic |
| Closeout | `JOB_PROFIT_RECORDED` | Actual job economics have been recorded | Automatic |
| Closeout | `COMPLETED` | Successful terminal state | Automatic |
| Global Exception | `CANCELLATION_REQUESTED` | Someone has requested cancellation | Human |
| Global Exception | `CANCELLED` | Case ended without completion | R&R |
| Global Exception | `SYSTEM_ATTENTION_REQUIRED` | Technical failure prevents safe automatic progression | R&R/System |

## Confirmed domain constraints represented by this inventory

- YMM search occurs before any paid VIN lookup.
- VIN lookup is conditional, not a normal lifecycle stage.
- VIN lookup may be used only for Windshield or Back Glass ambiguity.
- Door, Quarter, and Vent Glass ambiguity must not trigger VIN lookup; unresolved ambiguity routes to human review.
- A successful VIN lookup result belongs to the case and should not be automatically purchased again for the same case.
- Sourcing considers valid primary candidates and interchangeables.
- Excluded inventory such as Regional is not eligible for normal selection.
- No eligible inventory blocks normal quote progression.
- Pricing exceptions route to R&R review rather than inventing an unsupported formula.
- Quote approval, decline, expiration, re-quote, inventory change, order failure, rescheduling, installation exceptions, and cancellation are explicit workflow possibilities.

## Acceptance

This inventory remains draft until the transition matrix proves that every state has valid entry and exit behavior and no required business path is missing.
