# Agentic Delivery Control Plane v0.2

Status: CASE CORE PILOT

## Purpose

Use GitHub Issues as executable work packets, `workflow:*` labels as machine-readable routing, a vendor-neutral execution runtime, and GitHub Project #10 as the living delivery-state projection.

GitHub owns durable orchestration state.

The execution runtime is replaceable.

Current runtime:

`ChatGPT via connected GitHub tools`

Future runtimes may include an OpenAI API worker, Codex, another coding agent, or a human specialist without changing the issue/label/project model.

## State flow

```text
Backlog
  ↓ prerequisites satisfied
Ready
  ↓ approved runtime claims work with /agent start
In Progress
  ↓ linked PR opened
In Review
  ↓ real human/client decision required
Human Validation
  ↓ actual dependency / decision / failure
Blocked
  ↓ accepted/merged/closed
Done
```

`Ready` means **Ready for Agent / Runtime**.

It is not a blocked state.

## Routing

An executable issue must have exactly one `workflow:*` label.

The dispatcher maps that label to the lane instructions in:

`.github/agentic/lane-instructions.json`

When dependencies are satisfied, the dispatcher:

1. moves the issue to `Ready`;
2. writes a durable Agent Work Packet to the issue;
3. waits for an approved runtime to claim it.

The dispatcher does not require any specific vendor.

## Runtime claim protocol

An execution runtime claims ready work by posting:

`/agent start`

The `agent-runtime-state.yml` workflow moves the issue to:

`In Progress`

A runtime can release unstarted/paused work back to the queue with:

`/agent ready`

The runtime should identify itself in the same comment when practical.

## Human validation

`type:validation` issues are intentionally not eligible for automated execution.

They move to:

- Delivery Status: `Human Validation`
- Human Gate: `Client`
- Client Validation: `Pending`

This prevents an execution runtime from fabricating a consequential human/client decision.

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

Closing an issue causes the dispatcher to re-evaluate the pilot graph. Only newly unblocked work becomes Ready.

## Project status synchronization

`.github/scripts/project-status.sh` writes Project #10's `Delivery Status` and relevant human-validation fields.

`.github/workflows/agent-runtime-state.yml` handles runtime claim/release.

`.github/workflows/project-pr-status.yml` changes linked issues to:

- PR opened/updated → `In Review`
- PR closed unmerged → `In Progress`
- PR merged → `Done`

Issue-close events also set `Done` and release downstream dependencies.

## Safety rules

1. Exactly one workflow owner.
2. Dependencies gate dispatch.
3. Human/client validation cannot be synthesized by a runtime.
4. No live paid VIN or purchase side effects unless an issue explicitly authorizes them.
5. Runtime work starts from `main` unless explicitly stated otherwise.
6. Changes are delivered through focused PRs.
7. PRs must reference their issue.
8. Project status is a projection of delivery activity, not a substitute for canonical product/domain artifacts.
9. Runtime availability is not a business blocker. Ready work remains Ready until an approved runtime claims it.

## Expansion rule

Case Core is the pilot.

Do not auto-release the remaining milestones until this loop proves that:

- routing is correct;
- Project writes are reliable;
- work packets are durable and sufficient;
- runtime claiming works;
- PR status synchronization works;
- dependency release works;
- human gates stop automation correctly.
