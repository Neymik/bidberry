#!/usr/bin/env bash
# Retention pruning for S3 backups.
#
# Policy:
#   daily/   — keep newest 7
#   weekly/  — keep newest 4
#   monthly/ — keep newest 6
#
# Invoked at the end of backup.sh. Safe to re-run; lists sorted descending,
# drops first N, deletes the tail.

set -euo pipefail

BACKUP_ENV=/etc/bidberry-backup.env
if [[ -r "$BACKUP_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_ENV"; set +a
fi
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY required}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_REGION:?S3_REGION required}"
[[ "$S3_ENDPOINT" =~ ^https?:// ]] || S3_ENDPOINT="https://${S3_ENDPOINT}"
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$S3_REGION"
[[ -r /etc/ssl/certs/ca-certificates.crt ]] && export AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
AWS=(aws --endpoint-url "$S3_ENDPOINT" s3)
S3_BASE="s3://${S3_BUCKET}"

log() { printf '[prune %(%FT%T%z)T] %s\n' -1 "$*"; }

prune_kind() {
  local kind=$1 keep=$2
  # list top-level prefixes under kind/, extract folder names
  local prefixes
  prefixes=$("${AWS[@]}" ls "${S3_BASE}/${kind}/" 2>/dev/null \
    | awk '/PRE /{gsub("/","",$2); print $2}' \
    | sort -r) || true
  [[ -z "$prefixes" ]] && return 0

  local count=0
  while IFS= read -r p; do
    count=$((count+1))
    if (( count > keep )); then
      log "delete ${kind}/${p}"
      "${AWS[@]}" rm --recursive --only-show-errors "${S3_BASE}/${kind}/${p}/" || {
        log "WARN failed to delete ${kind}/${p}"
      }
    fi
  done <<< "$prefixes"
  log "${kind}: kept $(( count > keep ? keep : count )) of ${count}"
}

prune_kind daily   7
prune_kind weekly  4
prune_kind monthly 6
