# WB Partners Automation

## Project Goal
Automate the WB Partners (Wildberries) mobile Android app to count orders and extract data.

## Architecture
- **Android Emulator** running locally on macOS (Apple Silicon / arm64)
- **Python + uiautomator2** for UI automation and data extraction
- **ADB** for device/app management
- **pytesseract** as OCR fallback when UI hierarchy doesn't expose text

## Emulator Setup
- **AVD Name:** `wb_auto`
- **Device:** Pixel 6
- **Image:** `system-images;android-34;google_apis_playstore;arm64-v8a` (Android 14 with Play Store)
- **AVD Path:** `~/.android/avd/wb_auto.avd/`
- **Data is persistent** across restarts (don't use `-wipe-data`)

## Environment
- **ANDROID_HOME:** `/opt/homebrew/share/android-commandlinetools`
- **Java:** JDK 20 (system-installed at `/usr/bin/java`)
- **Platform:** macOS Darwin arm64

### Required PATH additions (~/.zshrc)
```bash
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin"
```

## Commands

### Launch emulator (with GUI, for login/setup)
```bash
emulator -avd wb_auto -gpu host -no-boot-anim &
```

### Launch emulator (headless, for automation)
```bash
emulator -avd wb_auto -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
```

### Wait for boot
```bash
adb wait-for-device shell 'while [[ -z $(getprop sys.boot_completed | tr -d "\r") ]]; do sleep 2; done'
adb shell input keyevent 82  # unlock screen
```

## Python Dependencies
```
uiautomator2
pytesseract
Pillow
```

## WB Partners App
- Installed via Google Play Store on the emulator
- Package name: TBD (check with `adb shell pm list packages | grep wildberries`)

## Order status tracking

`wb_order_monitor.py` runs three jobs through a single in-process orchestrator
(`orchestrator_loop`) so they share one ADB session and never overlap on the
device:

| Job | Cadence | What it does |
|-----|---------|--------------|
| `monitor` | `REFRESH_INTERVAL` (180s) | Refresh feed, parse top, save new orders, apply inline status transitions for cards still at the top of the feed |
| `rescan_shallow` | `RESCAN_SHALLOW_INTERVAL_SEC` (3600s default) | Scroll back ~24h: update statuses AND upsert missing orders (`insert_missing=True`) |
| `rescan_deep` | `RESCAN_DEEP_INTERVAL_SEC` (86400s default) | Same, ~72h lookback (`RESCAN_DEEP_MAX_SCROLLS`=1000 cap) — catches lingering transitions and deeper gaps |

Plus a one-shot **startup catch-up** (`run_startup_catchup`) before the loop: on
every (re)start it scrolls back to the newest order already in the DB minus a
margin and upserts anything missing, so an outage/deploy/manual-stop self-heals
without a manual `recount_today.py`.

Why two layers: `collect_new_orders` stops scrolling at the first known key it
encounters, so inline status detection only catches transitions for cards
above that boundary. Rescans cover everything below.

**No history table.** `orders.status` is always the latest observed status —
there is no `status_transitions` log. Transitions are observable only via
the per-cycle Telegram alerts (one message per inline transition; chunked
digest for rescan transitions) and the journalctl log lines.

**`update_order_status` guards against UI-glitch downgrades.** A "Заказ"
fallback (parser couldn't find a status badge) will never overwrite an
already-terminal status (Отказ/Выкуп/Возврат). The suppression logs to
journalctl, so parser drift is observable rather than absorbed.

**First deploy:** set `RESCAN_INITIAL_SILENT=1` in the env before restarting
`wb-monitor.service`. The initial reconcile will detect every
already-transitioned order at once — without the env var that's dozens of
Telegram messages and likely a 429. Drop the env var on the next restart
for normal alert behavior.

**Rescans now ALSO insert missing rows (self-recovery).** With
`insert_missing=True` (shallow, deep, and the startup catch-up), a card whose
key isn't in `known_orders` is upserted — so orders missed during a
downtime/stall are backfilled automatically (idempotent via UNIQUE key,
summarized as a single `🩹 added N` Telegram line, never per-order spam). The
adaptive scroll budget (loop exits on crossing `cutoff_dt`; deep/catch-up use a
larger cap) ensures high-volume gaps are actually reached — the June-15 gap
needed 734 scrolls, far past the old status-only 200 cap. `recount_today.py`
remains for manual one-off backfills but is no longer needed after a routine
outage.

**`recount_today.py` still requires the service to be stopped** (its
`is_service_active()` gate is unchanged). The new rescans run *inside*
the service so single-ownership of the device is preserved automatically.
