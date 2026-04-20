#!/usr/bin/env bash
# Daily backup of bidberry state to S3-compatible storage.
#
# Backs up: MySQL (all databases), WBPartners-Auto/orders.db (live SQLite .backup),
# and .env files (GPG-encrypted). Promotes the daily snapshot to weekly/monthly
# folders on Sundays and the 1st of the month respectively.
#
# Invoked by bidberry-backup.service (systemd timer fires daily).

set -euo pipefail

BIDBERRY_DIR=/home/ostap/bidberry
BACKUP_ENV=/etc/bidberry-backup.env
GPG_HOMEDIR=/home/ostap/.gnupg-bidberry-backup
GPG_RECIPIENT=backup@bidberry.local
MYSQL_CONTAINER=wb-analytics-mysql
ORDERS_DB="$BIDBERRY_DIR/WBPartners-Auto/orders.db"

log()  { printf '[backup %(%FT%T%z)T] %s\n' -1 "$*"; }
fail() { log "FAIL: $*"; LAST_ERR="$*"; exit 1; }

notify_fail() {
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && return 0
  local msg="🔴 bidberry backup FAILED on $(hostname) at $(date -u +%FT%TZ)"$'\n'"${1:-unknown error}"
  local proxy_opts=()
  [[ -n "${TELEGRAM_PROXY_URL:-}" ]] && proxy_opts=(--proxy "$TELEGRAM_PROXY_URL")
  curl -fsS --max-time 15 "${proxy_opts[@]}" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    >/dev/null 2>&1 || log "WARN telegram notify failed"
}

LAST_ERR=""
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    notify_fail "${LAST_ERR:-exited with status $rc}"
  fi
  [[ -n "${WORK:-}" && -d "$WORK" ]] && rm -rf "$WORK"
}
trap on_exit EXIT

# --- load config ---
# Under systemd, EnvironmentFile=/etc/bidberry-backup.env populates S3_* already.
# When invoked manually, source the env file directly (requires readable perms —
# typically run via `sudo`).
if [[ -r "$BACKUP_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_ENV"; set +a
fi
: "${S3_ENDPOINT:?S3_ENDPOINT required (EnvironmentFile or sudo)}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY required}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_REGION:?S3_REGION required}"
# aws cli requires a scheme on the endpoint URL. Allow S3_ENDPOINT as bare host.
[[ "$S3_ENDPOINT" =~ ^https?:// ]] || S3_ENDPOINT="https://${S3_ENDPOINT}"

[[ -r "$BIDBERRY_DIR/.env" ]] || fail "$BIDBERRY_DIR/.env not readable"
# shellcheck disable=SC1090
set -a; source "$BIDBERRY_DIR/.env"; set +a

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$S3_REGION"
# aws-cli v2 ships its own CA bundle which lacks some roots the system has.
# Point it at the system trust store so custom S3 providers (e.g. firstvds) validate.
[[ -r /etc/ssl/certs/ca-certificates.crt ]] && export AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
AWS=(aws --endpoint-url "$S3_ENDPOINT" s3)
S3_BASE="s3://${S3_BUCKET}"

# --- sanity checks ---
command -v aws         >/dev/null || fail "aws CLI not installed"
command -v sqlite3     >/dev/null || fail "sqlite3 CLI not installed"
command -v gpg         >/dev/null || fail "gpg not installed"
command -v docker      >/dev/null || fail "docker not installed"
[[ -d "$GPG_HOMEDIR" ]]            || fail "GPG homedir missing: $GPG_HOMEDIR"
docker inspect "$MYSQL_CONTAINER" >/dev/null 2>&1 || fail "container $MYSQL_CONTAINER not found"
[[ -r "$ORDERS_DB" ]]              || fail "orders.db missing: $ORDERS_DB"

# --- work dir ---
WORK="$(mktemp -d /tmp/bidberry-backup.XXXXXX)"
cd "$WORK"

DATE_UTC=$(date -u +%F)              # YYYY-MM-DD
WEEK_UTC=$(date -u +%G-W%V)          # ISO year + week, e.g. 2026-W17
MONTH_UTC=$(date -u +%Y-%m)          # e.g. 2026-04
DOW=$(date -u +%u)                   # 1=Mon ... 7=Sun
DOM=$(date -u +%d)                   # 01..31

DAILY_PREFIX="daily/${DATE_UTC}"

log "start  target=${S3_BASE}/${DAILY_PREFIX}"

# --- 1. MySQL dump ---
log "mysqldump…"
docker exec -i "$MYSQL_CONTAINER" \
  mysqldump -uroot -p"${MYSQL_ROOT_PASSWORD}" \
    --all-databases --single-transaction --quick --triggers --routines --events \
  | gzip -6 > mysql-all.sql.gz
[[ -s mysql-all.sql.gz ]] || fail "mysqldump produced empty file"
log "  mysql-all.sql.gz $(du -h mysql-all.sql.gz | cut -f1)"

# --- 2. orders.db live backup (safe while wb-monitor writes) ---
log "sqlite3 .backup orders.db…"
sqlite3 "$ORDERS_DB" ".backup orders.db"
gzip -6 orders.db
log "  orders.db.gz $(du -h orders.db.gz | cut -f1)"

# --- 3. envs bundle, GPG-encrypted ---
log "bundling envs…"
tar -C "$BIDBERRY_DIR" -czf envs.tar.gz \
  .env \
  WBPartners-Auto/.env \
  2>/dev/null || fail "tar envs failed"
GNUPGHOME="$GPG_HOMEDIR" gpg --batch --yes --trust-model always \
  --encrypt --recipient "$GPG_RECIPIENT" --output envs.tar.gz.gpg envs.tar.gz
rm -f envs.tar.gz
[[ -s envs.tar.gz.gpg ]] || fail "envs encryption produced empty file"
log "  envs.tar.gz.gpg $(du -h envs.tar.gz.gpg | cut -f1)"

# --- 4. manifest ---
{
  echo "date_utc=$DATE_UTC"
  echo "host=$(hostname)"
  echo "gpg_recipient=$GPG_RECIPIENT"
  echo "gpg_fingerprint=$(GNUPGHOME="$GPG_HOMEDIR" gpg --list-keys --with-colons "$GPG_RECIPIENT" | awk -F: '/^fpr/ {print $10; exit}')"
  echo "mysql_sha256=$(sha256sum mysql-all.sql.gz | cut -d' ' -f1)"
  echo "orders_sha256=$(sha256sum orders.db.gz  | cut -d' ' -f1)"
  echo "envs_sha256=$(sha256sum envs.tar.gz.gpg | cut -d' ' -f1)"
} > manifest.txt

# --- 5. upload daily ---
log "upload daily…"
for f in mysql-all.sql.gz orders.db.gz envs.tar.gz.gpg manifest.txt; do
  "${AWS[@]}" cp --only-show-errors "$f" "${S3_BASE}/${DAILY_PREFIX}/$f" \
    || fail "upload $f failed"
done
log "  ok daily/${DATE_UTC}"

# --- 6. promote to weekly (on Sunday, DOW=7) and monthly (on 1st) ---
promote_to() {
  local kind=$1 label=$2
  log "promote → ${kind}/${label}"
  for f in mysql-all.sql.gz orders.db.gz envs.tar.gz.gpg manifest.txt; do
    "${AWS[@]}" cp --only-show-errors \
      "${S3_BASE}/${DAILY_PREFIX}/$f" \
      "${S3_BASE}/${kind}/${label}/$f" \
      || fail "promote $f to $kind/$label failed"
  done
}
if [[ "$DOW" == "7" ]]; then
  promote_to weekly  "$WEEK_UTC"
fi
if [[ "$DOM" == "01" ]]; then
  promote_to monthly "$MONTH_UTC"
fi

# --- 7. prune per retention policy ---
"$BIDBERRY_DIR/scripts/backup/prune.sh" || fail "prune failed"

log "done"
