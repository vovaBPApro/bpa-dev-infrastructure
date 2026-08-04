#!/usr/bin/env bash
# Publish an operator-signed, append-only unpark authorization. The landing gate
# consumes it; this command never edits review state or an existing park.
set -euo pipefail

usage() { echo "usage: gate/operator-unpark.sh --repo <path> --item-id <id> --decision-id <id> --authorized-by <principal> --authorized-at <iso-time> --signature <file>" >&2; exit 2; }
repo= item_id= decision_id= authorized_by= authorized_at= signature=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--item-id|--decision-id|--authorized-by|--authorized-at|--signature)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --repo) repo=$2;; --item-id) item_id=$2;; --decision-id) decision_id=$2;;
        --authorized-by) authorized_by=$2;; --authorized-at) authorized_at=$2;; --signature) signature=$2;;
      esac; shift 2;;
    *) usage;;
  esac
done
[ -n "$repo" ] && [ -n "$item_id" ] && [ -n "$decision_id" ] && [ -n "$authorized_by" ] && [ -n "$authorized_at" ] && [ -f "$signature" ] || usage
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
common_dir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "OPERATOR_UNPARK status=fail detail=repo-invalid" >&2; exit 2; }
allowed="$common_dir/bpa-operator-unpark.allowed-signers"
[ -f "$allowed" ] && [ ! -L "$allowed" ] || { echo "OPERATOR_UNPARK status=fail detail=operator-trust-root-missing" >&2; exit 2; }
allowed_mode=$(stat -c '%a' "$allowed")
if (( (8#$allowed_mode & 8#022) != 0 )); then echo "OPERATOR_UNPARK status=fail detail=operator-trust-root-unsafe" >&2; exit 2; fi
payload="$tmp/authorization"
printf 'operator-unpark-v1\nitem-id=%s\ndecision-id=%s\nauthorized-by=%s\nauthorized-at=%s\n' "$item_id" "$decision_id" "$authorized_by" "$authorized_at" > "$payload"
ssh-keygen -Y verify -f "$allowed" -I "$authorized_by" -n bpa-operator-unpark -s "$signature" < "$payload" >/dev/null || { echo "OPERATOR_UNPARK status=fail detail=operator-signature-invalid" >&2; exit 2; }
item_key=$(printf '%s' "$item_id" | git -C "$repo" hash-object --stdin)
decision_key=$(printf '%s' "$decision_id" | git -C "$repo" hash-object --stdin)
cp "$signature" "$tmp/signature"
blob_payload=$(git -C "$repo" hash-object -w "$payload")
blob_signature=$(git -C "$repo" hash-object -w "$tmp/signature")
tree=$(printf '100644 blob %s\tauthorization\n100644 blob %s\tsignature\n' "$blob_payload" "$blob_signature" | git -C "$repo" mktree)
commit=$(printf 'operator unpark\n\nitem=%s\ndecision=%s\n' "$item_id" "$decision_id" | git -C "$repo" commit-tree "$tree")
ref="refs/bpa-review-unparks/$item_key/$decision_key"
mirror="refs/bpa-review-unpark-mirrors/$item_key/$decision_key"
if git -C "$repo" ls-remote --exit-code --refs origin "$ref" "$mirror" >/dev/null 2>&1; then echo "OPERATOR_UNPARK status=fail detail=decision-already-recorded" >&2; exit 2; fi
git -C "$repo" push --atomic origin "$commit:$ref" "$commit:$mirror" >/dev/null
echo "OPERATOR_UNPARK status=recorded item=$item_id decision=$decision_id audit=$commit"
