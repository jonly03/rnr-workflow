# R&R Persona Status & Notification Matrix v0.1

Status: Draft for review  
Depends on: `communication-principles.md`, `state-inventory-v0.1.md`, `transition-matrix-v0.1.md`

## Governing rule

Internal workflow state, persona-visible status, and notification behavior are separate decisions.

For every state/persona combination, the UI must resolve to:

- a persona-facing status, or `Hidden`;
- a notification policy.

The four personas currently modeled are:

- R&R Staff
- Direct Customer
- Auction
- Insurance

## Notification semantics

- **No notification** — state may be visible, but no outbound alert should be generated.
- **Yes — confirmation** — notify because a meaningful commitment/result was reached.
- **Yes — action required** — notify because the persona must do something.
- **Yes — meaningful exception/change** — notify because the case materially deviated from the normal path.
- **Conditional** — notify only when the condition stated in the policy is true.

## Default behavior

Unless a state has an explicit override:

- R&R Staff: visible as an internal operational state; no notification.
- Direct Customer: hidden; no notification.
- Auction: hidden; no notification.
- Insurance: hidden; no notification.

This keeps short-lived automatic states from creating noise.

## Explicit persona policies

The canonical executable draft currently lives in the interactive explorer's `personaPolicy` mapping in `index.html`.

Key externally meaningful states include:

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

## Review rule

If a persona does not need to know a state changed, the correct result is `Hidden / No notification`.

If a persona can benefit from seeing progress but does not need interruption, the correct result is `Visible / No notification`.

Notifications should be driven by action, commitment, material exception, or meaningful completion — not by every state transition.
