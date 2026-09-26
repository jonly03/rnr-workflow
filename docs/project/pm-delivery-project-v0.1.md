# R&R PM Delivery Project v0.1

Status: WORKING BOARD CONTRACT

## Purpose

The GitHub Project is the PM's living operational status document for R&R Finest Auto Glass.

It answers:

- What are we building?
- Which milestone is each item part of?
- Which workflow owns it?
- What is ready, active, blocked, under review, waiting on a human, or done?
- What requires client validation?
- What requires Nelly/client attention?
- What should happen next?

Issues remain the detailed source of work. Labels remain the machine-readable routing mechanism. The Project is the current-state projection over that work.

## Project

Title:

`R&R Finest Auto Glass — Delivery`

Owner:

`jonly03`

## Canonical fields

### Delivery Status
Single select:

1. Backlog
2. Ready
3. In Progress
4. In Review
5. Human Validation
6. Blocked
7. Done

### Workflow
Single select:

- Product
- UX
- Brand
- Architecture
- Frontend
- Backend
- Integration
- Red Team
- Platform

### Milestone
Single select:

- Case Core
- Glass Identification
- Sourcing + Pricing
- Quote / Approval
- Ordering
- Installation + Closeout
- End-to-End
- Launch Readiness

### Priority
Single select:

- P0
- P1
- P2

### Type
Single select:

- Epic
- Feature
- Test
- Validation

### Dependency
Text.

### Client Validation
Single select:

- Not Needed
- Pending
- Validated
- Revised
- Deferred

### Human Gate
Single select:

- None
- Nelly
- Client

### Target Slice
Text.

## Label-to-field projection

Workflow labels:

- `workflow:product` → Product
- `workflow:ux` → UX
- `workflow:brand` → Brand
- `workflow:architecture` → Architecture
- `workflow:frontend` → Frontend
- `workflow:backend` → Backend
- `workflow:integration` → Integration
- `workflow:red-team` → Red Team
- `workflow:platform` → Platform

Milestone labels map directly to the Milestone field.

Priority labels:

- `priority:p0` → P0
- `priority:p1` → P1
- `priority:p2` → P2

Type labels:

- `type:epic` → Epic
- `type:feature` → Feature
- `type:test` → Test
- `type:validation` → Validation

## Initial status rule

- Existing open backlog items → Backlog.
- Closed issues → Done.
- Later automation may promote Backlog → Ready when prerequisites are satisfied.
- Agent/workflow dispatch will move Ready → In Progress.
- PR creation will move In Progress → In Review.
- Human acceptance gates will move In Review → Human Validation when needed.
- Blocking findings move any active item → Blocked.
- Accepted/merged work closes the issue and sets Done.

## Intended Project views

### PM — Milestone
Group by Milestone.
Secondary sort by Priority.

### Execution — Status
Board grouped by Delivery Status.

### Workflow — Team
Group by Workflow.
Filter out Done by default.

### Human Attention
Filter:
- Human Gate != None
OR
- Client Validation = Pending
OR
- Delivery Status = Blocked

### Milestone Health
Table grouped by Milestone with Delivery Status visible.

## Automation principle

The Project is not manually curated documentation.

Workflows and agents should update it as a side effect of delivery events.

The PM owns the semantics, but CI/agent automation owns routine synchronization.
