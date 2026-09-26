# R&R Finest Auto Glass Design Guide v0.1

Status: DRAFT FOR HUMAN ACCEPTANCE

Sources:
- `brand/brand-book-v0.1.md` (ACCEPTED)
- `ux/case-core-rnr-staff-v0.1.md` (ACCEPTED)

## 1. Purpose

This guide turns the accepted R&R brand direction into concrete product-interface rules.

It is the implementation bridge between:
- Brand;
- UX specifications;
- Frontend components;
- future channel experiences.

The goal is consistency without forcing every persona into the same screen density or wording.

---

## 2. Design Principles

### 2.1 Clarity before decoration
Operational meaning must remain obvious.

### 2.2 One product family, multiple channel experiences
Staff, Direct, Auction, and Insurance may differ in density, terminology, and emphasis while sharing the same visual system.

### 2.3 State must be understandable without color
Every status treatment requires text or iconography in addition to color.

### 2.4 Dense where useful, simple where necessary
R&R Staff and Auction may be information-dense.
Direct Customer should remain simple and action-focused.

### 2.5 Stable interaction locations
Primary actions, state, workflow position, and activity history should appear predictably.

### 2.6 Responsive by design
Do not treat mobile as a scaled-down desktop.

---

## 3. Foundational Design Tokens

These token names are canonical for v0.1.
Exact values may be tuned during implementation, but semantic meaning should remain stable.

### 3.1 Color Tokens

```text
--color-bg-primary
--color-bg-secondary
--color-surface
--color-surface-raised
--color-border
--color-text-primary
--color-text-secondary
--color-text-muted

--color-brand-primary
--color-brand-primary-hover
--color-brand-primary-active

--color-status-neutral
--color-status-progress
--color-status-success
--color-status-attention
--color-status-critical
--color-status-cancelled
```

Initial visual direction:
- background: deep navy / near-black for internal tools;
- surfaces: slightly elevated slate/navy;
- brand accent: cool blue / indigo;
- success: green / teal;
- attention: amber;
- critical: red / rose;
- neutrals: slate / cool gray.

Direct Customer may use a predominantly light surface mode while preserving the same semantic token roles.

### 3.2 Typography Tokens

```text
--font-family-sans
--font-size-xs
--font-size-sm
--font-size-md
--font-size-lg
--font-size-xl
--font-size-2xl

--font-weight-regular
--font-weight-medium
--font-weight-semibold
--font-weight-bold

--line-height-tight
--line-height-normal
--line-height-relaxed
```

Guidance:
- sans serif;
- highly legible;
- compact but readable in operations views;
- headings should establish hierarchy without oversized display typography.

### 3.3 Spacing Tokens

Use a simple 4px-based rhythm.

```text
--space-1: 4
--space-2: 8
--space-3: 12
--space-4: 16
--space-5: 20
--space-6: 24
--space-8: 32
--space-10: 40
--space-12: 48
```

Avoid arbitrary spacing values unless layout constraints require them.

### 3.4 Radius Tokens

```text
--radius-sm
--radius-md
--radius-lg
--radius-pill
```

Direction:
- moderate radius;
- compact operational controls;
- pills reserved mainly for badges/chips.

### 3.5 Elevation Tokens

```text
--shadow-sm
--shadow-md
```

Use sparingly.
Prefer borders and surface contrast over large shadows.

---

## 4. Layout System

### 4.1 Page Shell

Recommended structure:

```text
Application Header
└── Navigation
    └── Page Header
        ├── Context / identity
        ├── Status
        └── Primary action
            ↓
        Main content
```

### 4.2 Content Width

Internal operational views:
- allow wide layouts;
- prioritize information density.

Direct Customer:
- prefer constrained readable width;
- keep decisions visually focused.

### 4.3 Grid

Desktop:
- 12-column grid acceptable;
- two-column case-detail layouts preferred when useful.

Tablet:
- collapse secondary panels below primary content.

Mobile:
- one primary column;
- avoid horizontal dependence except deliberate workflow strips or dense data surfaces.

---

## 5. Responsive Breakpoints

Implementation may choose exact CSS values, but v0.1 behavior should map approximately to:

```text
mobile: < 640px
tablet: 640px–1023px
desktop: >= 1024px
```

Rules:
- controls remain tappable;
- labels wrap rather than clip;
- tables may collapse into cards;
- workflow stages may horizontally scroll if necessary;
- critical actions remain visible without excessive scrolling.

---

## 6. Core Component Rules

### 6.1 Buttons

Variants:
- Primary
- Secondary
- Destructive
- Ghost/Text

Primary button:
- one dominant primary action per local decision area.

Examples:
- Create Case
- Approve Quote
- Submit Estimate
- Send Quote

Do not use primary styling for multiple competing actions in the same group.

Minimum states:
- default;
- hover;
- focus;
- disabled;
- loading.

Loading labels should be explicit:

`Creating Case…`

not just a spinner with no context.

### 6.2 Inputs

Required:
- visible label;
- clear focus state;
- inline validation;
- disabled state;
- error state.

Do not use placeholder text as the only label.

### 6.3 Select / Choice Controls

Use when options are constrained.

Examples:
- Channel;
- Glass Type;
- Status filter.

If fewer than roughly 5 options and space permits, segmented/radio controls may improve speed.

### 6.4 Cards / Panels

Use for:
- vehicle summary;
- current action;
- supplier decision;
- claim details;
- quote summary;
- activity groups.

Cards should group related meaning, not merely decorate the page.

### 6.5 Tables

Best for:
- Case Queue;
- Auction vehicle/job lists;
- dense operational comparisons.

Requirements:
- clear column labels;
- row hover/focus;
- entire row may be clickable only if keyboard behavior remains clear;
- collapse or transform on narrow screens.

### 6.6 Status Badge

A status badge includes:
- text;
- semantic color;
- optional icon.

Examples:
- In progress
- Needs approval
- Scheduled
- Completed
- Attention required

Do not rely on badge color alone.

### 6.7 Alert / Banner

Use for:
- required attention;
- blocking failure;
- recoverable warning;
- important confirmation.

Severity:
- informational;
- attention;
- critical;
- success.

Avoid using alerts for routine workflow information.

### 6.8 Modal / Dialog

Use only when:
- user confirmation is necessary;
- context should not be lost;
- action has meaningful consequence.

Avoid turning ordinary navigation into modal flows.

### 6.9 Empty State

Every major collection needs:
- plain description;
- next available action when appropriate.

Example:

`No cases yet.`

`Create first case`

### 6.10 Loading State

Prefer:
- skeletons for content layout;
- inline progress for actions.

Avoid flashing fabricated sample data.

### 6.11 Error State

State:
- what failed;
- whether user action is needed;
- what they can do next.

Example:

`We couldn't load this case.`

`Retry`

---

## 7. Navigation Patterns

### R&R Staff
Persistent app navigation is appropriate.

Candidate sections:
- Case Queue
- Needs Attention
- Quotes
- Orders
- Installations
- Invoices

Only implemented sections should appear as active destinations.

### Direct Customer
Minimal navigation.
The task or current service should dominate.

### Auction
Operational navigation with queue/list emphasis.

### Insurance
Assignment/document-oriented navigation.

---

## 8. Workflow / Progress Pattern

The product needs a reusable stage indicator.

Canonical high-level stages:

```text
Intake
Identify
Source
Price
Quote
Order
Install
Closeout
```

Rules:
- show current stage distinctly;
- completed stages should be distinguishable;
- future stages should remain visible when useful;
- exact internal state may appear beneath/alongside the stage in staff views;
- external personas should use persona-friendly wording.

For narrow screens:
- horizontal scroll is acceptable;
- do not compress labels into unreadability.

---

## 9. Current Action Pattern

Every operational case detail should have a stable area answering:

> What needs to happen next?

Possible states:

### Action available
Show:
- clear action title;
- short context;
- primary action;
- optional secondary action.

### Waiting / no action
Show:

`No staff action required at this step.`

### Blocked
Show:
- why;
- what is needed;
- who owns the next action if known.

Do not invent buttons for actions that do not exist in the domain contract.

---

## 10. Activity Timeline Pattern

Each event should include:
- event label;
- timestamp;
- useful short context;
- actor/system source when known.

Recommended visual hierarchy:

```text
EVENT_LABEL
Short human-readable context
timestamp · actor/source
```

Ordering remains an open UX question until explicitly decided.

---

## 11. Channel Density Rules

### R&R Staff
- high information density;
- operational vocabulary;
- dark internal surface allowed;
- workflow and action visibility prioritized.

### Direct Customer
- low-to-medium density;
- larger spacing;
- simpler language;
- quote/appointment/action focus;
- light visual mode recommended.

### Auction
- high density;
- table-first;
- fast scanning;
- stock # and bulk context supported.

### Insurance
- medium-to-high density;
- formal information hierarchy;
- assignment, claim, authorization, documents emphasized.

---

## 12. Semantic Status System

Use these interface semantics:

### Neutral
Informational or inactive.

### In Progress
Work is actively advancing.

### Success
Confirmed, completed, approved, available.

### Attention
Review, waiting, approval/action needed.

### Critical
Failed, blocked, severe exception.

### Cancelled
Stopped/closed without successful completion.

The workflow-to-semantic mapping should be maintained separately as implementation data, not scattered as CSS decisions.

---

## 13. Persona Status Rule

Canonical architecture:

```text
INTERNAL WORKFLOW STATE
→ PERSONA VISIBILITY RULE
→ PERSONA-FRIENDLY STATUS
→ NOTIFICATION RULE
```

The Design System must support different labels over the same internal state.

Example:

```text
Internal: AWAITING_APPROVAL

R&R Staff:
Awaiting Approval

Direct:
Your quote is ready

Auction:
Needs approval

Insurance:
Awaiting authorization
```

The component system must not assume one universal user-facing string per internal state.

---

## 14. Iconography

Use a consistent icon set.

Recommended categories:
- Vehicle
- Quote / Document
- Calendar
- Order / Package
- Warning
- Complete / Check
- Phone / Message
- Activity / History
- Search
- Edit
- More actions

Rules:
- icon plus text where ambiguity exists;
- consistent size/stroke;
- no decorative icon overload.

---

## 15. Accessibility Requirements

Minimum expectations:
- WCAG-oriented color contrast;
- keyboard-accessible controls;
- visible focus;
- labels for controls;
- text alternatives where needed;
- no color-only status;
- minimum comfortable touch targets;
- error association with inputs;
- layout remains usable at text zoom;
- responsive wrapping instead of truncating important states.

Accessibility failures should be treated as product defects, not polish.

---

## 16. Motion

Use motion sparingly.

Allowed:
- short transitions for panel/state changes;
- loading feedback;
- subtle confirmation.

Avoid:
- decorative looping animation;
- large page motion;
- animation that delays task completion;
- motion as the only indicator of state change.

Respect reduced-motion preferences.

---

## 17. Content Rules

### Labels
Use short nouns or verbs.

Examples:
- Open Case
- Send Quote
- Approve Quote
- Schedule Installation

### Confirmation
Say what happened.

`Quote approved.`

### Error
Say what failed and what to do.

`We couldn't create this case. Check the highlighted fields and try again.`

### Dates
Use a consistent locale-aware format.

### Money
Always show currency consistently.

### VIN
Treat as operational vehicle identity data.
Masking behavior remains an open UX decision.

---

## 18. Design Tokens vs Business Logic

Frontend styling must not encode workflow rules.

Bad:
```js
if (state === "QUOTE_READY") color = "orange"
```

Preferred:
```js
semanticStatus = getPersonaPresentation(state, persona)
```

Then components render semantic tokens.

This keeps:
- workflow logic;
- persona mapping;
- visual semantics

separate.

---

## 19. Component Acceptance Checklist

A reusable component is acceptable when:
- default state exists;
- hover/focus behavior exists where relevant;
- disabled behavior exists where relevant;
- loading behavior exists where relevant;
- error behavior exists where relevant;
- responsive behavior is defined;
- keyboard behavior works;
- visual semantics do not embed business rules;
- text can wrap safely;
- channel reuse is possible where appropriate.

---

## 20. Initial Component Inventory

Frontend v0.1 should expect these shared primitives:

```text
AppShell
PageHeader
SideNav
Button
IconButton
TextInput
Select
FieldError
Card
StatusBadge
Alert
DataTable
EmptyState
LoadingSkeleton
WorkflowStageStrip
CurrentActionPanel
ActivityTimeline
CaseHeader
VehicleSummary
```

This is an initial inventory, not permission to build all components before they are needed.

---

## 21. Open Design Questions

### DG-OQ-001 — Exact brand palette
Brand direction is accepted; exact hex/RGB values remain to be frozen.

### DG-OQ-002 — Font family
Should the product use a system font stack or adopt a specific web font?

Recommendation for v0.1: system-first unless a formal brand typeface is selected.

### DG-OQ-003 — Direct Customer light mode
Brand Book recommends a predominantly light customer experience.

Need explicit approval before treating it as mandatory.

### DG-OQ-004 — State labels
Should R&R Staff see humanized labels by default with raw state IDs secondary?

### DG-OQ-005 — Timeline order
Newest-first or oldest-first remains unresolved.

### DG-OQ-006 — VIN masking
Full VIN vs partial masking/reveal remains unresolved.

---

## 22. Design Acceptance Criteria

Design Guide v0.1 is acceptable when:

- frontend can derive consistent tokens and components from it;
- brand and UX remain visibly connected;
- status semantics are reusable;
- channel experiences can differ without fragmenting the product;
- responsive behavior is defined;
- accessibility expectations are explicit;
- business logic remains separate from styling;
- unresolved design decisions remain visible rather than silently assumed.

---

## 23. Decision Boundary

Acceptance of this guide means:
- foundational design-system rules are accepted;
- frontend may implement shared primitives against these rules;
- future UX specifications should reference this guide;
- channel-specific components may extend, but should not contradict, these foundations.

Acceptance does not resolve the Open Design Questions unless explicitly decided.
