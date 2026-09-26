# R&R Persona Permissions & Actions Matrix v0.1

Status: PROPOSED FOR HUMAN ACCEPTANCE  
Issue: #23  
Depends on:
- `product/requirements/case-core-v0.1.md`
- `ux/case-core-rnr-staff-v0.1.md`
- `docs/workflow/transition-matrix-v0.1.md`
- `docs/workflow/persona-status-notification-matrix-v0.1.md`
- `validation/client-validation-register-v0.1.md`

## 1. Purpose

Freeze the v0.1 ownership and permission boundary for user-visible Case actions across:

- R&R Staff
- Direct Customer
- Auction
- Insurance

This matrix does not replace the workflow transition matrix.

It answers:

> Which persona is allowed to request, perform, confirm, approve, or view each user-visible action?

The workflow engine remains authoritative for whether the action is legal in the current state.

## 2. Governing rules

1. **Backend workflow state is never directly editable by a persona.**
   Personas request business actions; the workflow engine validates guards and performs state transitions.

2. **Internal workflow state != persona-visible status != notification.**
   Permission to view a persona-facing status does not imply permission to perform the underlying transition.

3. **R&R owns operational control.**
   Glass identification, sourcing, pricing exceptions, purchase confirmation, procurement recovery, installation exception handling, and final operational closeout remain R&R-controlled unless a later accepted requirement explicitly delegates them.

4. **External personas act only within their own Case/channel context.**
   Direct Customer, Auction, and Insurance must not access or mutate another channel's Case.

5. **Quote/authorization approval is channel-specific.**
   Direct approval, Auction approval, and Insurance authorization are related but not interchangeable semantics.

6. **Quote approval never authorizes supplier purchase.**
   Supplier purchase still requires explicit R&R purchase confirmation.

7. **Historical business events are append-only in normal application flows.**
   No persona may silently rewrite or delete the operational timeline. Corrections use later corrective/superseding events.

8. **Paid/provider side effects are not generic user actions.**
   VIN lookup eligibility, provider calls, sourcing, and purchase execution are controlled by workflow/service rules, not arbitrary UI buttons.

9. **Provisional client decisions remain provisional.**
   Where this matrix depends on a decision in the Client Validation Register, implementation must remain reversible/configurable and must not describe the decision as client-approved.

## 3. Permission legend

| Value | Meaning |
| --- | --- |
| **ALLOW** | Persona may perform/request this action when workflow guards allow it. |
| **CONDITIONAL** | Persona may perform/request it only when the Case/channel explicitly requires that persona's input. |
| **VIEW** | Persona may see the relevant projection/document but does not own the action. |
| **FORBIDDEN** | Persona must not be offered this action. |
| **SYSTEM** | Action is automatic/system-owned, not a persona permission. |

## 4. Core action ownership matrix

| User-visible action | R&R Staff | Direct Customer | Auction | Insurance | Owning actor / rule |
| --- | --- | --- | --- | --- | --- |
| Create canonical Case | **ALLOW** | FORBIDDEN in Case Core v0.1 | FORBIDDEN in Case Core v0.1 | FORBIDDEN in Case Core v0.1 | R&R Staff. External intake may originate a request later, but it must create a Case through an accepted channel contract rather than arbitrary Case mutation. |
| View own/current Case | **ALLOW** | VIEW own Direct Case | VIEW own Auction Case | VIEW own Insurance Case | Each external persona sees only its persona projection. |
| View canonical internal workflow state | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R Staff only. External personas receive friendly projected status. |
| Edit required intake data before progression | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | R&R may correct intake. External persona may supply missing information only when the Case explicitly asks that channel for it. |
| Trigger workflow validation | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after create/update. |
| Start YMM search | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after valid intake. |
| Request/force paid VIN lookup | FORBIDDEN as arbitrary action | FORBIDDEN | FORBIDDEN | FORBIDDEN | VIN lookup occurs only through accepted eligibility/ambiguity rules. No persona gets a generic paid-lookup button. |
| Reuse saved VIN result | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic; saved successful result must be reused. |
| Resolve ambiguous glass manually | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Retry identification after corrected data | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R action after new/corrected information exists. |
| Start sourcing | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after glass identification. |
| Retry sourcing | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Select supplier offer automatically | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | System evaluates eligible non-Regional offers under accepted rules. |
| Approve pricing/profit exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R commercial control. |
| Reject unacceptable price | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R may stop/cancel rather than proceed at an unacceptable price. |
| View current quote/estimate | **ALLOW** | **VIEW** | **VIEW** | **VIEW** | External wording/document projection varies by channel. |
| Approve/decline Direct quote | VIEW/record valid result | **ALLOW** | FORBIDDEN | FORBIDDEN | Direct Customer owns Direct quote approval/decline. |
| Approve/decline Auction quote | VIEW/record valid result | FORBIDDEN | **ALLOW** | FORBIDDEN | Auction counterparty owns Auction quote approval/decline. |
| Authorize/decline Insurance estimate/scope | VIEW/record valid result | FORBIDDEN | FORBIDDEN | **ALLOW** | Insurance authorization is distinct from Direct/Auction approval. |
| Rewrite an approved/declined/expired quote version | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | Quote history is immutable. Requote creates a new version. |
| Initiate requote after commercial change/decline/expiry | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R decides whether to continue/requote; system may detect the need. |
| Start inventory recheck after approval | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after valid approval. |
| Confirm supplier purchase | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | Explicit R&R confirmation is mandatory before money is committed. |
| Decline supplier purchase | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R may stop the job. |
| Retry failed order / re-source after order failure | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational recovery. |
| Place supplier order | SYSTEM after R&R confirmation | FORBIDDEN | FORBIDDEN | FORBIDDEN | Provider/service executes only after explicit R&R confirmation. |
| View glass ordered status | **ALLOW** | VIEW | VIEW | VIEW/conditional | Persona-facing projection follows status/notification policy. |
| Propose/request appointment | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | R&R owns scheduling workflow; external persona may participate when that channel must coordinate a time. |
| Confirm/reschedule appointment | **ALLOW** | CONDITIONAL | CONDITIONAL | CONDITIONAL | External participation is channel/context dependent; R&R retains operational visibility/control. |
| Start/complete installation | **ALLOW/record** | FORBIDDEN | FORBIDDEN | FORBIDDEN | Installation is an operational/technician action. Until a separate technician persona exists, authenticated R&R operations records it. |
| Record installation problem/exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational action. |
| Choose reschedule/replacement/cannot-complete path after exception | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R decides the operational recovery path. |
| Generate final invoice | SYSTEM | FORBIDDEN | FORBIDDEN | FORBIDDEN | Automatic after completion details are recorded. |
| View/receive final invoice | **ALLOW** | **VIEW** | **VIEW** | **VIEW** | Delivery semantics remain channel-specific. |
| Record job economics/profit | SYSTEM/R&R operational data | FORBIDDEN | FORBIDDEN | FORBIDDEN | Internal financial closeout only. |
| Close completed Case | SYSTEM when closeout complete | FORBIDDEN | FORBIDDEN | FORBIDDEN | External completion does not directly mutate canonical terminal state. |
| Request cancellation | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** | External persona may request cancellation for its own Case; R&R/workflow determines final cancellation transition. |
| Finalize cancellation | **ALLOW** | FORBIDDEN | FORBIDDEN | FORBIDDEN | R&R operational authority. |
| Edit/delete historical Case events | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | Corrections use later append-only corrective/superseding events. |
| Arbitrarily patch workflow state | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | All state changes occur through business actions + guards. |

## 5. Approval semantics by channel

### 5.1 Direct Customer

Meaning:

> The customer accepts or declines the current Direct quote for the requested work.

Rules:

- Approval applies only to the current valid quote version.
- Expired or superseded quotes cannot be approved.
- A changed commercial offer requires a new quote version.
- Customer quote approval does **not** authorize supplier purchase.
- R&R purchase confirmation remains required.

### 5.2 Auction

Meaning:

> The Auction counterparty accepts or declines the current commercial quote for that vehicle/job.

Rules:

- Approval applies only to the current valid quote version.
- Auction approval is recorded separately from Direct Customer approval.
- Auction approval does **not** authorize supplier purchase.
- R&R purchase confirmation remains required.

### 5.3 Insurance

Meaning:

> The carrier/insurance counterparty authorizes or declines the current estimate/scope as required by the Insurance workflow.

Rules:

- Insurance authorization is not modeled as a Direct Customer approval.
- Authorization applies only to the valid estimate/quote context it references.
- Reauthorization may be required after material scope/commercial changes.
- Insurance authorization does **not** authorize supplier purchase.
- R&R purchase confirmation remains required.

### 5.4 R&R Staff

R&R Staff may:

- receive and record evidence of a valid external approval/authorization;
- continue/requote/close according to the accepted workflow after the result is recorded;
- confirm supplier purchase separately.

R&R Staff must not:

- fabricate an external approval;
- treat one channel's approval as another channel's approval;
- use purchase confirmation as a substitute for customer/partner approval.

## 6. Explicit forbidden-permission boundary

External personas — Direct Customer, Auction, Insurance — must never be offered controls to:

- directly set internal workflow state;
- choose glass candidates;
- run paid VIN lookup on demand;
- choose supplier offers;
- override Regional exclusion;
- approve internal profit exceptions;
- confirm supplier purchase;
- retry supplier orders directly;
- rewrite historical quote versions;
- edit/delete Case events;
- record internal job profit;
- mark a Case `COMPLETED` or `CANCELLED` directly.

R&R Staff must never be offered controls to:

- directly patch arbitrary workflow state;
- rewrite/delete historical business events;
- rewrite an accepted/declined/expired historical quote version;
- bypass purchase confirmation and commit supplier spend through an unguarded action.

## 7. Technician boundary

The accepted transition matrix includes a Technician driver for installation start/completion/problem events.

A separate authenticated Technician persona is **not** currently one of the four personas in the accepted persona model.

Working v0.1 treatment:

- installation actions remain operational actions;
- authenticated R&R Staff may record those technician events;
- this does not imply every R&R Staff user will ultimately have technician permissions;
- if a Technician persona is introduced, its authorization model must be added explicitly rather than inferred from this document.

This is an implementation boundary, not a client-validated organizational decision.

## 8. Provisional / deferred client decisions

Client validation for the broader provisional decision register was deferred in #22.

Therefore:

- the permissions above may be used for reversible v0.1 implementation;
- where behavior depends on deferred Product/UX/Brand/Design assumptions, keep the implementation replaceable/configurable;
- do not describe those assumptions as client-approved;
- any later client revision must propagate back into this matrix and its owning canonical artifact.

## 9. Authorization implementation contract

Architecture may treat the following as frozen **only after this artifact receives human acceptance**:

1. Personas request business actions; they do not directly mutate workflow state.
2. R&R owns internal operational actions.
3. Direct, Auction, and Insurance approval semantics are distinct.
4. Supplier purchase requires a separate R&R confirmation.
5. External personas are channel-scoped.
6. Historical events and historical quote versions are not destructively editable.
7. Forbidden actions must be denied server-side even if a UI accidentally exposes them.

Architecture must not infer additional permissions from UI visibility alone.

## 10. Acceptance checklist

- [x] Every currently modeled user-visible action has an owning persona or explicit SYSTEM owner.
- [x] Forbidden persona actions are explicit.
- [x] Direct, Auction, and Insurance approval semantics are distinct.
- [x] Deferred client assumptions remain explicitly provisional.
- [ ] Human acceptance recorded before Architecture treats this matrix as frozen.

## 11. Acceptance record

Pending human review.

When accepted, record:

- accepted by;
- date;
- any revisions;
- reference to the accepting PR/review.
