# Workflow Communication Principles

Status: Draft  
Applies to: R&R staff, Direct customers, Auction partners, Insurance partners, and future personas.

## Governing distinction

**Internal workflow state != persona-visible status != notification**

These are separate concerns and must not be collapsed into one model.

### 1. Internal workflow state

The system records the actual business state needed to drive progression, recovery, rules, audit history, and testing.

Example:

`INVENTORY_RECHECK_IN_PROGRESS`

### 2. Persona-visible status

A workflow state is surfaced only when knowing it is meaningful or actionable for that persona.

A persona may see:

- a precise internal-style status;
- a simplified friendly status;
- a broader phase that groups several internal states; or
- nothing at all.

`HIDDEN` is a valid presentation decision.

### 3. Notification

A visible status does not automatically generate a notification.

Notifications are reserved for events that reasonably require:

- attention;
- action;
- awareness of a meaningful change;
- confirmation of an important commitment; or
- awareness of an important exception.

`VISIBLE - NO NOTIFICATION` is a valid communication decision.

## Example

Internal progression:

`REQUEST_RECEIVED -> REQUEST_VALIDATION_IN_PROGRESS -> READY_FOR_YMM_SEARCH -> YMM_SEARCH_IN_PROGRESS`

A Direct customer does not need four announcements. A suitable external status may simply be:

> Request received - we're identifying the correct glass.

An R&R operator may see greater detail when useful, while short-lived automatic states can remain visually quiet.

## Communication pipeline

```
INTERNAL WORKFLOW STATE
        |
        v
PERSONA VISIBILITY RULE
        |
        v
PERSONA-FRIENDLY STATUS
        |
        v
NOTIFICATION RULE
```

## Design consequence

The later persona-message specification must not mechanically create a message for every state and persona.

For every persona/state combination, valid outcomes include:

- `HIDDEN`
- `VISIBLE - NO NOTIFICATION`
- `VISIBLE - NOTIFY`
- `ACTION REQUIRED - NOTIFY`

The workflow engine owns business truth. Presentation and notification layers translate that truth without changing it.
