# R&R Workflow

R&R Finest Auto Glass workflow/domain model and implementation.

This repository is built from the business lifecycle outward: first define the workflow states, transitions, persona-visible statuses, actions, and notifications; then implement the case engine and user experiences against that accepted model.

## Build discipline

- `main` contains accepted integrated work.
- Workflow specification work is developed on focused branches.
- Each step is reviewed before the next dependent step begins.
- Tests are derived from the accepted workflow model before implementation.
- Internal workflow state, persona-visible status, and notifications are modeled separately.

## Modeling sequence

1. State inventory
2. Transition matrix
3. Full case graph
4. Persona/status message matrix
5. Persona permissions/actions matrix
6. Freeze workflow specification v1
7. Implement Case Core
8. Implement workflow engine from the frozen model
