#!/usr/bin/env bash
set -euo pipefail

ISSUE_NUMBER="${1:?issue number required}"
DELIVERY_STATUS="${2:?delivery status required}"
HUMAN_GATE="${3:-}"
CLIENT_VALIDATION="${4:-}"

OWNER="${PROJECT_OWNER:-@me}"
PROJECT_NUMBER="${PROJECT_NUMBER:-10}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
REPO_GH_TOKEN="${GH_TOKEN:?GH_TOKEN required for repository operations}"
PROJECT_GH_TOKEN="${PROJECT_GH_TOKEN:?PROJECT_GH_TOKEN required for Projects v2 operations}"

project_id="$(GH_TOKEN="$PROJECT_GH_TOKEN" gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq '.id')"

item_id="$(GH_TOKEN="$PROJECT_GH_TOKEN" gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 200 --format json   --jq ".items[] | select(.content.number == $ISSUE_NUMBER) | .id" | head -n1)"

if [ -z "$item_id" ]; then
  issue_url="$(GH_TOKEN="$REPO_GH_TOKEN" gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json url --jq '.url')"
  GH_TOKEN="$PROJECT_GH_TOKEN" gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$issue_url" >/dev/null
  item_id="$(GH_TOKEN="$PROJECT_GH_TOKEN" gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 200 --format json     --jq ".items[] | select(.content.number == $ISSUE_NUMBER) | .id" | head -n1)"
fi

if [ -z "$item_id" ]; then
  echo "Unable to resolve Project item for issue #$ISSUE_NUMBER" >&2
  exit 1
fi

fields_json="$(mktemp)"
trap 'rm -f "$fields_json"' EXIT
GH_TOKEN="$PROJECT_GH_TOKEN" gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json > "$fields_json"

field_id() {
  jq -r --arg n "$1" '.fields[] | select(.name == $n) | .id' "$fields_json" | head -n1
}

option_id() {
  local field="$1"
  local option="$2"
  jq -r --arg f "$field" --arg o "$option"     '.fields[] | select(.name == $f) | .options[]? | select(.name == $o) | .id' "$fields_json" | head -n1
}

set_select() {
  local field="$1"
  local value="$2"
  local fid oid
  fid="$(field_id "$field")"
  oid="$(option_id "$field" "$value")"

  if [ -z "$fid" ] || [ -z "$oid" ]; then
    echo "Missing Project field/option: $field=$value" >&2
    exit 1
  fi

  GH_TOKEN="$PROJECT_GH_TOKEN" gh project item-edit     --id "$item_id"     --project-id "$project_id"     --field-id "$fid"     --single-select-option-id "$oid" >/dev/null
}

set_select "Delivery Status" "$DELIVERY_STATUS"

if [ -n "$HUMAN_GATE" ]; then
  set_select "Human Gate" "$HUMAN_GATE"
fi

if [ -n "$CLIENT_VALIDATION" ]; then
  set_select "Client Validation" "$CLIENT_VALIDATION"
fi

echo "Project #$PROJECT_NUMBER: issue #$ISSUE_NUMBER -> $DELIVERY_STATUS"
