# Agentic Delivery Control Plane v0.1

Status: CASE CORE PILOT

## Purpose

Use GitHub Issues as executable work packets, `workflow:*` labels as machine-readable routing, GitHub Copilot cloud agent as the initial asynchronous implementation agent, and GitHub Project #10 as the living delivery-state projection.

## State flow

```text
Backlog
  ↓ prerequisites satisfied
Ready
  ↓ agent assigned
In Progress
  ↓ linked PR opened
In Review
  ↓ real human/client decision required
Human Validation
  ↓ blocking condition
Blocked
  ↓ accepted/merged/closed
Done
```

Not every item visits every state.

## Routing

An executable issue must have exactly one `workflow:*` label.

The dispatcher maps that label to the lane instructions in:

`.github/agentic/lane-instructions.json`

The first agent runtime is GitHub Copilot cloud agent via GitHub's supported issue agent-assignment API.

## Human validation

`type:validation` issues are intentionally **not** assigned to a coding agent.

They move to:

- Delivery Status: `Human Validation`
- Human Gate: `Client`
- Client Validation: `Pending`

This prevents the automation from fabricating a consequential client decision.

## Case Core pilot graph

```text
#22 Client validation
  ↓
#23 Persona permissions/actions
  ↓
#24 Case Core architecture
  ├──────────────┐
  ↓              ↓
#25 Backend    #26 Frontend
  └──────┬───────┘
         ↓
#27 Integration / Playwright
         ↓
#28 Red Team
```

Encoded in:

`.github/agentic/case-core-dependencies.json`

Closing an issue causes the dispatcher to re-evaluate the pilot graph. Only newly unblocked work is dispatched.

## Project status synchronization

`.github/scripts/project-status.sh` writes Project #10's `Delivery Status` and relevant human-validation fields.

`.github/workflows/project-pr-status.yml` changes linked issues to:

- PR opened/updated → `In Review`
- PR closed unmerged → `In Progress`
- PR merged → `Done`

Issue-close events also set `Done` and release downstream dependencies.

## Safety rules

1. Exactly one workflow owner.
2. Dependencies gate dispatch.
3. Human/client validation cannot be synthesized by an agent.
4. No live paid VIN or purchase side effects unless an issue explicitly authorizes them.
5. Agents work from `main` and create focused PRs.
6. PRs must reference their issue.
7. Project status is a projection of delivery activity, not a substitute for canonical product/domain artifacts.

## Expansion rule

Case Core is the pilot.

Do not auto-release the remaining milestones until this loop proves that:

- routing is correct;
- Project writes are reliable;
- Copilot assignment works;
- PR status synchronization works;
- dependency release works;
- human gates stop automation correctly.
