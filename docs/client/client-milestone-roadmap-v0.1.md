# R&R Finest Auto Glass — Client Milestone Roadmap v0.1

Status: WORKING CLIENT-FACING ROADMAP

Purpose: provide a simple visual sequence of product milestones that can be reviewed with the client as the R&R platform moves from understanding and design into implementation and launch.

---

## Milestone 1 — Product Definition v0.1

**Client question:** Are we solving the right problem?

### Deliverables
- Case Core product requirement
- core users/personas
- required capabilities
- accepted business rules
- acceptance criteria
- explicit non-goals
- client-validation assumptions

### Client-visible outcome
A clear description of what the first operational product must do and what is intentionally deferred.

### Current state
**INTERNAL ACCEPTED — CLIENT VALIDATION PENDING FOR PROVISIONAL ASSUMPTIONS**

---

## Milestone 2 — R&R Staff UX v0.1

**Client question:** Does this match how R&R staff should actually work?

### Deliverables
- New Case flow
- Case Queue
- Case Detail
- workflow position
- current action area
- activity timeline
- loading/error/terminal states
- responsive behavior
- accessibility expectations

### Client-visible outcome
A concrete staff workflow showing how an R&R employee will create, find, inspect, and follow a job.

### Current state
**INTERNAL ACCEPTED — CLIENT VALIDATION PENDING FOR PROVISIONAL UX DECISIONS**

---

## Milestone 3 — Brand Book v0.1

**Client question:** Does this look, sound, and feel like R&R?

### Deliverables
- brand positioning
- brand promise
- personality
- tone of voice
- channel-specific language
- visual direction
- color direction
- typography direction
- logo/mark direction
- imagery guidance
- iconography direction
- accessibility brand principles

### Client-visible outcome
A visual and verbal identity system that establishes how R&R should present itself to staff, direct customers, auctions, and insurance partners.

### Presentation opportunity
This milestone should be shown visually with:
- logo/mark treatment
- palette swatches
- typography samples
- tone-of-voice examples
- channel examples
- light/dark direction
- imagery examples

### Current state
**INTERNAL ACCEPTED — CLIENT BRAND VALIDATION PENDING**

---

## Milestone 4 — Design Guide / Design System v0.1

**Client question:** Does this design language feel consistent, usable, and professional?

### Deliverables
- design principles
- design tokens
- color palette
- typography system
- spacing/radius/elevation rules
- layout system
- responsive breakpoints
- buttons
- inputs
- cards
- tables
- status badges
- alerts
- empty/loading/error states
- workflow stage pattern
- current action pattern
- activity timeline pattern
- accessibility rules
- channel density rules

### Client-visible outcome
A reusable visual system that turns the R&R brand into consistent product screens instead of designing each page independently.

### Presentation opportunity
This milestone should be shown as a visual component board containing:
- buttons and states
- form controls
- cards
- tables
- status chips
- alerts
- workflow stages
- activity events
- desktop/mobile treatments
- R&R Staff dark mode
- Direct Customer light mode

### Current state
**INTERNAL ACCEPTED — CLIENT DESIGN VALIDATION PENDING**

---

## Milestone 5 — Interactive Product Prototype

**Client question:** Does the product feel right when we move through it?

### Deliverables
- R&R Staff channel experience
- Direct Customer experience
- Auction experience
- Insurance experience
- interactive workflow explorer
- persona-specific status language

### Client-visible outcome
A clickable representation of the product before deeper backend implementation.

### Current state
**AVAILABLE FOR CLIENT REVIEW**

---

## Milestone 6 — Case Core Architecture v0.1

**Client question:** Usually not a visual approval milestone; this is the technical foundation that supports the approved experience.

### Deliverables
- Case domain contract
- Customer relationship
- Vehicle relationship
- Glass Request relationship
- event model
- state/action boundaries
- API contract
- persistence model
- tests derived from accepted requirements

### Client-visible outcome
Minimal. The value is that approved product behavior becomes a stable technical foundation.

### Current state
**NEXT**

---

## Milestone 7 — Working Case Core

**Client question:** Can R&R create and follow a real job in the system?

### Deliverables
- create Case
- persist Case
- retrieve Case
- Case Queue
- Case Detail
- durable event history
- workflow state
- responsive staff UI

### Client-visible outcome
The first genuinely operational vertical slice.

### Current state
**PLANNED**

---

## Milestone 8 — Glass Identification

**Client question:** Can the system correctly determine what glass is needed while minimizing unnecessary VIN lookup cost?

### Deliverables
- YMM-first search
- ambiguity handling
- VIN lookup guardrails
- saved VIN lookup results
- human review path
- glass selection

### Client-visible outcome
A working identification workflow based on the accepted R&R business process.

### Current state
**PLANNED**

---

## Milestone 9 — Sourcing + Pricing

**Client question:** Can the system find eligible inventory and produce the right economics?

### Deliverables
- supplier offers
- interchangeables
- Regional exclusion
- inventory filtering
- cheapest eligible selection
- labor
- profit review
- tax/pricing rules
- price approval

### Client-visible outcome
R&R can move from identified glass to a commercially usable price.

### Current state
**PLANNED**

---

## Milestone 10 — Quote / Approval

**Client question:** Can each channel receive and approve the right commercial artifact?

### Deliverables
- immutable/versioned quote
- Direct Customer quote
- Auction approval flow
- Insurance estimate/authorization flow
- quote expiry
- requote path
- approval history

### Client-visible outcome
A full commercial decision experience tailored by channel.

### Current state
**PLANNED**

---

## Milestone 11 — Ordering

**Client question:** Can R&R safely move an approved job into procurement?

### Deliverables
- inventory recheck
- resourcing
- R&R purchase confirmation
- order placement
- failure handling
- durable order history

### Client-visible outcome
Approved work can become an actual glass order without accidental duplicate or stale purchases.

### Current state
**PLANNED**

---

## Milestone 12 — Installation + Closeout

**Client question:** Can R&R finish the job and preserve the operational/economic record?

### Deliverables
- scheduling
- rescheduling
- installation state
- installation exceptions
- completion
- final invoice
- actual economics/profit
- closeout

### Client-visible outcome
The system manages the job through completion.

### Current state
**PLANNED**

---

## Milestone 13 — Full End-to-End Workflow

**Client question:** Does the complete R&R process work as one connected system?

### Deliverables
- Direct end-to-end flow
- Auction end-to-end flow
- Insurance end-to-end flow
- integration tests
- Playwright E2E tests
- failure/retry scenarios
- persona visibility validation
- Red Team findings resolved

### Client-visible outcome
A realistic job can travel from intake to completion through the same platform.

### Current state
**PLANNED**

---

## Milestone 14 — Production Deployment / Launch Readiness

**Client question:** Is the system safe and practical to run for real work?

### Deliverables
- production environment
- database
- secrets
- migrations
- CI/CD
- logging/monitoring
- backups
- rollback
- security review
- launch checklist
- operational handoff

### Client-visible outcome
R&R can begin using the system for real operations with an understood support/recovery path.

### Current state
**PLANNED**

---

# Client Presentation Sequence

For client review, present the early milestones in this order:

```text
1. Product Definition
        ↓
2. Staff UX
        ↓
3. Brand Book
        ↓
4. Design Guide
        ↓
5. Interactive Prototype
        ↓
6. Technical Foundation
        ↓
7+. Working Operational Slices
```

The first five milestones answer:

> Do we understand your business, your people, your brand, and the experience you want before we commit deeply to implementation?

---

# Visual Milestone Principle

The Brand Book and Design Guide are not supporting documents hidden behind engineering.

They are **first-class client milestones**.

They should be presented visually because they provide the client an early opportunity to validate:
- identity;
- tone;
- colors;
- typography;
- screen density;
- channel differences;
- component behavior;
- overall product feel.

These decisions are cheaper to revise before they are embedded across dozens of implemented screens.

---

# Validation Rule

A milestone may be:

- **INTERNAL ACCEPTED** — accepted by the product team;
- **CLIENT VALIDATED** — explicitly confirmed by the client;
- **REVISED** — changed after client feedback;
- **DEFERRED** — decision postponed while a reversible working assumption remains in use.

Client validation must update the corresponding canonical Product, UX, Brand, Design, or Engineering artifact rather than living only in meeting notes.
