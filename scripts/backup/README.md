# Bidberry backup system

Daily encrypted snapshot of stateful data → S3-compatible storage.

## What gets backed up

| Artifact | Source | Format |
|---|---|---|
| `mysql-all.sql.gz` | `docker exec wb-analytics-mysql mysqldump --all-databases` | gzipped SQL |
| `orders.db.gz` | SQLite `.backup` of `WBPartners-Auto/orders.db` (safe live) | gzipped SQLite |
| `envs.tar.gz.gpg` | `bidberry/.env` + `WBPartners-Auto/.env`, tar'd & GPG-encrypted | tar+gz+gpg |
| `manifest.txt` | sha256 of the above + GPG fingerprint | plaintext |

Source tree, logs, exports, Docker images, and node_modules are **not** backed up — they come from git / rebuild.

## Schedule

`bidberry-backup.timer` fires daily at **04:00 Europe/Moscow** (±5min jitter), invoking `bidberry-backup.service` which runs `backup.sh`.

Missed runs (host down at fire time) fire on next boot (`Persistent=true`).

## Retention

| Tier | Kept | Promotion trigger |
|---|---|---|
| `daily/YYYY-MM-DD/`   | newest 7 | every run |
| `weekly/YYYY-WNN/`    | newest 4 | when `date +%u == 7` (Sunday UTC) |
| `monthly/YYYY-MM/`    | newest 6 | when `date +%d == 01` (1st of month UTC) |

Pruning runs at the end of every backup (`prune.sh`).

## Encryption

- GPG asymmetric keypair, 4096-bit RSA, passphrase-less
- Fingerprint: `D65C 68B7 C206 4165 66E6 DEC6 8638 F629 B3C0 0857`
- Keyring: `/home/ostap/.gnupg-bidberry-backup/` (public key only needed at runtime)
- Private key exported to `/home/ostap/bidberry-backup-keys/private-key.asc`
- **Operator must move the private key off-server** for it to have DR value. A backup you can decrypt only on the machine that got wiped is not a backup.

## Config

### `/etc/bidberry-backup.env` (root:root 600)

```
S3_ENDPOINT=s3.firstvds.ru      # scheme is auto-prepended
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=bidberry
S3_REGION=ru-1
```

### `/home/ostap/bidberry/.env`

Backup script reads `MYSQL_ROOT_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` from the app's existing `.env`.

### systemd units (tracked at `systemd/*` for reproducibility)

Deploy from the repo:
```bash
sudo install -m 644 scripts/backup/systemd/bidberry-backup.service /etc/systemd/system/
sudo install -m 644 scripts/backup/systemd/bidberry-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bidberry-backup.timer
```

## Ops

```bash
# Force a run now (e.g. before a risky change)
sudo systemctl start bidberry-backup.service

# Watch the latest run
sudo journalctl -u bidberry-backup.service -n 50 --no-pager

# Upcoming fires
systemctl list-timers bidberry-backup.timer --no-pager

# Disable temporarily (e.g. during maintenance)
sudo systemctl stop bidberry-backup.timer

# List what's in S3
export AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
sudo -E bash -c '. /etc/bidberry-backup.env && \
  AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY \
  AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY \
  AWS_DEFAULT_REGION=$S3_REGION \
  aws --endpoint-url "https://$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/" --recursive'
```

## Restore

```bash
# download + verify checksums + decrypt envs (does NOT touch live services)
sudo /home/ostap/bidberry/scripts/backup/restore.sh daily/2026-04-20

# the script prints exact commands to apply the artifacts; run them manually
# after reviewing.
```

## Failure mode

- Script is `set -euo pipefail`. Any failure fires a Telegram message to the chat ID in `.env` (uses `TELEGRAM_PROXY_URL` if api.telegram.org is blocked — the server-level proxy used by `wb-monitor.service`).
- On success, the timer stays quiet. Check `list-timers` for cadence.
- SSL: aws cli ships its own CA bundle that lacks some common roots. `AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt` is exported so it validates against the system store.
