# R&R Workflow

R&R Finest Auto Glass workflow/domain model and implementation.

This repository is built from the business lifecycle outward: first define the workflow states, transitions, persona-visible statuses, actions, and notifications; then implement the case engine and user experiences against that accepted model.

## Build discipline

- `main` contains accepted integrated work.
- Workflow specification work is developed on focused branches.
- Each step is reviewed before the next dependent step begins.
- Tests are derived from the accepted workflow model before implementation.
- Internal workflow state, persona-visible status, and notifications are modeled separately.

## Client-facing milestones

The client-facing roadmap is tracked in:

`docs/client/client-milestone-roadmap-v0.1.md`

Key early visual milestones:

1. Product Definition v0.1
2. R&R Staff UX v0.1
3. **Brand Book v0.1**
4. **Design Guide / Design System v0.1**
5. Interactive Product Prototype
6. Case Core Architecture v0.1
7. Working Case Core
8. Glass Identification
9. Sourcing + Pricing
10. Quote / Approval
11. Ordering
12. Installation + Closeout
13. Full End-to-End Workflow
14. Production Deployment / Launch Readiness

The Brand Book and Design Guide are first-class client review milestones, not hidden supporting documents.

## Modeling sequence

1. State inventory
2. Transition matrix
3. Full case graph
4. Persona/status message matrix
5. Persona permissions/actions matrix
6. Freeze workflow specification v1
7. Implement Case Core
8. Implement workflow engine from the frozen model
