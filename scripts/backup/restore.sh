#!/usr/bin/env bash
# Restore a bidberry snapshot from S3-compatible storage.
#
# Usage:
#   restore.sh <kind>/<label> [<target-dir>]
#   kind    = daily | weekly | monthly
#   label   = the folder name (e.g. 2026-04-20, 2026-W17, 2026-04)
#   target  = where to place decrypted artifacts (default: /tmp/bidberry-restore-<label>)
#
# This DOES NOT automatically restore MySQL or orders.db into running
# services — it only downloads, verifies, and decrypts artifacts, then
# prints the manual restore commands. Operator must stop services and
# apply intentionally.

set -euo pipefail

BIDBERRY_DIR=/home/ostap/bidberry
BACKUP_ENV=/etc/bidberry-backup.env
GPG_HOMEDIR=/home/ostap/.gnupg-bidberry-backup

SNAP="${1:-}"
TARGET="${2:-}"
[[ -n "$SNAP" ]] || { echo "usage: $0 <kind>/<label> [<target-dir>]" >&2; exit 2; }
KIND="${SNAP%%/*}"
LABEL="${SNAP#*/}"
case "$KIND" in daily|weekly|monthly) ;; *) echo "kind must be daily|weekly|monthly" >&2; exit 2 ;; esac

TARGET="${TARGET:-/tmp/bidberry-restore-${LABEL}}"
mkdir -p "$TARGET"

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
SRC="${S3_BASE}/${KIND}/${LABEL}"

echo "downloading $SRC -> $TARGET"
for f in mysql-all.sql.gz orders.db.gz envs.tar.gz.gpg manifest.txt; do
  "${AWS[@]}" cp --only-show-errors "$SRC/$f" "$TARGET/$f" || {
    echo "failed to download $f" >&2
    exit 1
  }
done

echo "verifying checksums…"
while IFS='=' read -r k v; do
  case "$k" in
    mysql_sha256)  want_mysql="$v" ;;
    orders_sha256) want_orders="$v" ;;
    envs_sha256)   want_envs="$v" ;;
  esac
done < "$TARGET/manifest.txt"
got_mysql=$(sha256sum "$TARGET/mysql-all.sql.gz" | cut -d' ' -f1)
got_orders=$(sha256sum "$TARGET/orders.db.gz"    | cut -d' ' -f1)
got_envs=$(sha256sum   "$TARGET/envs.tar.gz.gpg" | cut -d' ' -f1)
[[ "$got_mysql"  == "$want_mysql"  ]] || { echo "mysql checksum mismatch"  >&2; exit 1; }
[[ "$got_orders" == "$want_orders" ]] || { echo "orders checksum mismatch" >&2; exit 1; }
[[ "$got_envs"   == "$want_envs"   ]] || { echo "envs checksum mismatch"   >&2; exit 1; }
echo "  ok"

echo "decrypting envs…"
GNUPGHOME="$GPG_HOMEDIR" gpg --batch --yes \
  --decrypt --output "$TARGET/envs.tar.gz" "$TARGET/envs.tar.gz.gpg"

cat <<EOF

Snapshot downloaded & verified at: $TARGET
  mysql-all.sql.gz   gzipped mysqldump --all-databases
  orders.db.gz       gzipped SQLite online backup
  envs.tar.gz        decrypted .env bundle (tar -tzf to inspect)
  manifest.txt       metadata

Manual restore commands:

  # --- MySQL (will clobber databases) ---
  gunzip -c "$TARGET/mysql-all.sql.gz" | \\
    docker exec -i wb-analytics-mysql mysql -uroot -p"\$MYSQL_ROOT_PASSWORD"

  # --- orders.db (stop wb-monitor first) ---
  sudo systemctl stop wb-monitor.service
  gunzip -c "$TARGET/orders.db.gz" > "$BIDBERRY_DIR/WBPartners-Auto/orders.db"
  sudo systemctl start wb-monitor.service

  # --- .env files (review before overwriting!) ---
  tar -tzf "$TARGET/envs.tar.gz"
  tar -xzf "$TARGET/envs.tar.gz" -C "$BIDBERRY_DIR"
EOF
