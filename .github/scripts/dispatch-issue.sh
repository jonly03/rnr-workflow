#!/usr/bin/env bash
set -euo pipefail

ISSUE_NUMBER="${1:?issue number required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATUS_WRITER="$ROOT/.github/scripts/project-status.sh"
LANES="$ROOT/.github/agentic/lane-instructions.json"
DEPS="$ROOT/.github/agentic/case-core-dependencies.json"
CONFIG="$ROOT/.github/agentic/dispatch-config.json"

comment_once() {
  local marker="$1"
  local body="$2"
  local found
  found="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json comments     --jq ".comments[].body | select(contains(\"$marker\"))" | head -n1 || true)"
  if [ -z "$found" ]; then
    gh issue comment "$ISSUE_NUMBER" --repo "$REPO" --body "$body" >/dev/null
  fi
}

issue_json="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json number,title,body,state,labels,assignees,url)"
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

Expected exactly one \`workflow:*\` label; found ${#workflow_labels[@]}.

The PM must correct workflow ownership before this issue can be dispatched."
  exit 0
fi

workflow_label="${workflow_labels[0]}"
lane="${workflow_label#workflow:}"

if ! jq -e --arg lane "$lane" 'has($lane)' "$LANES" >/dev/null; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Blocked"
  comment_once "<!-- rnr-dispatch-unknown-lane -->"     "<!-- rnr-dispatch-unknown-lane -->
**Dispatcher blocked this issue.**

No agent lane instructions exist for \`$workflow_label\`."
  exit 0
fi

# Dependency gate. Issues not present in the pilot manifest have no encoded prerequisites yet.
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
  comment_once "<!-- rnr-dispatch-dependency-wait -->"     "<!-- rnr-dispatch-dependency-wait -->
**Dependency gate:** this issue remains in **Backlog** until $joined $( [ ${#unresolved[@]} -eq 1 ] && echo 'is' || echo 'are' ) closed."
  exit 0
fi

labels="$(jq -r '.labels[].name' <<<"$issue_json")"

if grep -qx "type:validation" <<<"$labels"; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Human Validation" "Client" "Pending"
  comment_once "<!-- rnr-dispatch-human-validation -->"     "<!-- rnr-dispatch-human-validation -->
**Dispatcher: Human Validation gate**

This issue is ready, but it requires a real client/human decision. No coding agent was assigned.

1. Perform and record the validation required by the acceptance criteria.
2. Update canonical artifacts for any revisions.
3. Close this issue only when its acceptance criteria are actually satisfied.

Closing this issue automatically releases any Case Core work that depends on it."
  exit 0
fi

assignee="$(jq -r '.copilot_assignee' "$CONFIG")"
already_assigned="$(jq -r --arg a "$assignee" '.assignees[].login | select(. == $a or . == "copilot-swe-agent")' <<<"$issue_json" | head -n1 || true)"

if [ -n "$already_assigned" ]; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "In Progress"
  exit 0
fi

# Verify Copilot cloud agent is available before attempting assignment.
owner="${REPO%%/*}"
name="${REPO#*/}"
copilot_id="$(gh api graphql   -f query='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{login __typename ... on Bot{id} ... on User{id}}}}}'   -f owner="$owner" -f name="$name"   --jq '.data.repository.suggestedActors.nodes[] | select(.login == "copilot-swe-agent") | .id' | head -n1 || true)"

if [ -z "$copilot_id" ]; then
  "$STATUS_WRITER" "$ISSUE_NUMBER" "Blocked"
  comment_once "<!-- rnr-dispatch-agent-unavailable -->"     "<!-- rnr-dispatch-agent-unavailable -->
**Dispatcher blocked this issue.**

GitHub Copilot cloud agent is not currently available as an assignable actor for this repository/account. The workflow label was recognized as \`$workflow_label\`, but no real agent was dispatched."
  exit 0
fi

"$STATUS_WRITER" "$ISSUE_NUMBER" "Ready"

lane_instruction="$(jq -r --arg lane "$lane" '.[$lane]' "$LANES")"
title="$(jq -r '.title' <<<"$issue_json")"
custom_instructions="$lane_instruction

Orchestration context: You were dispatched by the R&R label router because this issue has $workflow_label. Work only on issue #$ISSUE_NUMBER: $title. Read the parent epic and linked canonical artifacts first. Follow Red → Green → Refactor → Integrate. Keep the change focused. Your pull request must reference issue #$ISSUE_NUMBER and use a closing keyword only when the issue acceptance criteria are genuinely satisfied."

payload="$(jq -n   --arg assignee "$assignee"   --arg repo "$REPO"   --arg instructions "$custom_instructions"   '{
    assignees: [$assignee],
    agent_assignment: {
      target_repo: $repo,
      base_branch: "main",
      custom_instructions: $instructions
    }
  }')"

gh api   --method POST   -H "Accept: application/vnd.github+json"   -H "X-GitHub-Api-Version: 2022-11-28"   "/repos/$REPO/issues/$ISSUE_NUMBER/assignees"   --input - <<<"$payload" >/dev/null

"$STATUS_WRITER" "$ISSUE_NUMBER" "In Progress"

comment_once "<!-- rnr-dispatch-agent -->"   "<!-- rnr-dispatch-agent -->
**Dispatcher → $workflow_label**

Dependencies are satisfied. GitHub Copilot cloud agent has been assigned using the **$lane** lane instructions.

Project status: **In Progress**.

The next automatic state transition is **In Review** when a linked pull request is opened."
