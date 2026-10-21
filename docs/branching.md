# Branch discipline — rnr-workflow

Established 2026-10-21 (Nelly's direction). This is the whole branching model;
anything not described here is not part of the flow.

## Long-lived branches — the only ones

| Branch | Meaning | How it moves |
| --- | --- | --- |
| `main` | The current state of the app. Every change lands here. | Only via PR (below). Never force-pushed. |
| `staging` | The demoable state: what the staging environment serves. Used for demos to Lou and other internal demos, and for end-to-end testing — automatic (the deploy workflow's browser smoke) and manual. | Fast-forwarded from `main` when a build is demoable. **Pushing to `staging` deploys the staging environment** (the Deploy Case Core Staging workflow triggers on push to this branch), which runs migrations and the full smoke. |
| `prod` | The live branch: exactly what production serves. | Moves only as the final step of a successful production promotion: fast-forward to the promoted SHA after the Promote workflow passes health + browser smoke. Nothing commits to `prod` directly. |
| `gh-pages` | Utility branch for GitHub Pages. Outside the app flow. | Managed by the Pages workflows. |

Initial state (2026-10-21): `staging` = `main` @ 1390e59. `prod` =
c3566a1c (deployed to production 2026-10-01; its health check passed at deploy
time, its browser smoke did not — and its API has since degraded; see the
production promotion runbook in the goal records). Nothing else is implied by a
branch existing: leftover branches with unmerged work are reviewed explicitly,
never bulk-deleted.

## Short-lived branches

- One branch per change, cut from a **freshly fetched** `origin/main`:
  `feature/<slug>`, `fix/<slug>`, `chore/<slug>`.
- Open a PR into `main`. CI must be green. **Verify the PR's actual file list**
  before merging — a branch cut from a stale base can silently revert unrelated
  files in a squash merge (learned 2026-10-20, PR #257).
- **Squash-merge.** `main` stays linear.
- **Head branches delete automatically on merge** (repo setting
  `delete_branch_on_merge`, on since 2026-10-21). A merged branch that survives
  is a bug in the process, not an archive — archives are tags or notes, not
  branches.

## The flow

```
feature/fix/chore ──PR──▶ main ──fast-forward──▶ staging ──(deploys staging env)──▶
automatic smoke + manual testing / demos ──Nelly's explicit go──▶
Promote workflow (pinned to the staging SHA) ──▶ production ──fast-forward──▶ prod
```

- Nothing reaches `staging` except by fast-forward from `main`, and nothing is
  promoted to production except the exact commit `staging` points at and the
  staging environment verified.
- Production promotion is never implied by a staging deploy. It happens only on
  Nelly's explicit word, via the Promote Case Core Production workflow.
- If `main` moves after `staging` was fast-forwarded, the promotion candidate is
  stale: fast-forward `staging` again and let it re-verify before promoting.
