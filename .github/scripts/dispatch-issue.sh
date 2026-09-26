#!/usr/bin/env bash
set -euo pipefail

ISSUE_NUMBER="${1:?issue number required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATUS_WRITER="$ROOT/.github/scripts/project-status.sh"
LANES="$ROOT/.github/agentic/lane-instructions.json"
DEPS="$ROOT/.github/agentic/case-core-dependencies.json"

comment_once() {
  local marker="$1"
  local body="$2"
  local found
  found="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json comments     --jq ".comments[].body | select(contains(\"$marker\"))" | head -n1 || true)"
  if [ -z "$found" ]; then
    gh issue comment "$ISSUE_NUMBER" --repo "$REPO" --body "$body" >/dev/null
  fi
}

issue_json="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json number,title,body,state,labels,url)"
state="$(jq -r '.state' <<<"$issue_json")"

if [ "$state" = "CLOSED" ]; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Done"
  exit 0
fi

mapfile -t workflow_labels < <(jq -r '.labels[].name | select(startswith("workflow:"))' <<<"$issue_json")

if [ "${#workflow_labels[@]}" -ne 1 ]; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Blocked"
  comment_once "<!-- rnr-dispatch-routing-error -->"     "<!-- rnr-dispatch-routing-error -->
**Dispatcher blocked this issue.**

Expected exactly one `workflow:*` label; found ${#workflow_labels[@]}.

The PM must correct workflow ownership before this issue can be dispatched."
  exit 0
fi

workflow_label="${workflow_labels[0]}"
lane="${workflow_label#workflow:}"

if ! jq -e --arg lane "$lane" 'has($lane)' "$LANES" >/dev/null; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Blocked"
  comment_once "<!-- rnr-dispatch-unknown-lane -->"     "<!-- rnr-dispatch-unknown-lane -->
**Dispatcher blocked this issue.**

No agent lane instructions exist for `$workflow_label`."
  exit 0
fi

deps_json="$(jq -c --arg n "$ISSUE_NUMBER" '.[$n] // []' "$DEPS")"
unresolved=()

while read -r dep; do
  [ -z "$dep" ] && continue
  dep_state="$(gh issue view "$dep" --repo "$REPO" --json state --jq '.state')"
  if [ "$dep_state" != "CLOSED" ]; then
    unresolved+=("#$dep")
  fi
done < <(jq -r '.[]' <<<"$deps_json")

if [ "${#unresolved[@]}" -gt 0 ]; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Backlog"
  joined="$(IFS=', '; echo "${unresolved[*]}")"
  if [ "${#unresolved[@]}" -eq 1 ]; then verb="is"; else verb="are"; fi
  comment_once "<!-- rnr-dispatch-dependency-wait -->"     "<!-- rnr-dispatch-dependency-wait -->
**Dependency gate:** this issue remains in **Backlog** until $joined $verb closed."
  exit 0
fi

labels="$(jq -r '.labels[].name' <<<"$issue_json")"

if grep -qx "type:validation" <<<"$labels"; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Human Validation" "Client" "Pending"
  comment_once "<!-- rnr-dispatch-human-validation -->"     "<!-- rnr-dispatch-human-validation -->
**Dispatcher: Human Validation gate**

This issue requires a real client/human decision. No execution runtime may synthesize that decision.

Close the issue only after the validation is completed or deliberately deferred."
  exit 0
fi

"$STATUS_WRITER" "$ISSUE_NUMBER" "Ready"

lane_instruction="$(jq -r --arg lane "$lane" '.[$lane]' "$LANES")"
title="$(jq -r '.title' <<<"$issue_json")"

comment_once "<!-- rnr-agent-work-packet -->"   "<!-- rnr-agent-work-packet -->
## Agent work packet

**Issue:** #$ISSUE_NUMBER — $title  
**Lane:** `$workflow_label`  
**Delivery status:** **Ready**  
**Base branch:** `main`

### Lane contract

$lane_instruction

### Execution contract

- Work only on this issue and its acceptance criteria.
- Read the parent epic and relevant canonical artifacts first.
- Follow **Red → Green → Refactor → Integrate**.
- Preserve provisional business decisions as provisional.
- Do not create paid VIN lookups, purchases, or other live side effects unless explicitly authorized.
- Create a focused branch and pull request.
- Reference #$ISSUE_NUMBER in the pull request.
- Do not close the issue until its acceptance criteria are genuinely satisfied.

### Runtime claim

Any approved execution runtime may claim this packet by posting:

`/agent start`

The runtime-state workflow will move this issue to **In Progress**. A linked pull request moves it to **In Review**."

echo "Issue #$ISSUE_NUMBER is ready for an execution runtime in lane $workflow_label."
