#!/usr/bin/env python3
"""
WB Partners order monitor sidecar.
Connects to a Redroid emulator via ADB, scrapes the WB Partners app
order feed using uiautomator2, and POSTs orders to a Bun HTTP API.
"""

import os
import sys
import signal
import time
import threading
import logging

import uiautomator2 as u2
import requests

from parser import parse_orders

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------
ADB_DEVICE = os.environ.get("ADB_DEVICE", "127.0.0.1:5555")
INGEST_URL = os.environ.get("INGEST_URL", "http://127.0.0.1:3000/api/orders/ingest")
HEARTBEAT_URL = os.environ.get("HEARTBEAT_URL", "http://127.0.0.1:3000/api/orders/heartbeat")
EMULATOR_KEY = os.environ.get("EMULATOR_KEY", "")
CABINET_ID = os.environ.get("CABINET_ID", "default")

REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", "180"))
MAX_SCROLLS = int(os.environ.get("MAX_SCROLLS", "10"))
SCROLL_PAUSE = 2

PID_FILE = "/var/run/wb-monitor.pid"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("wb-monitor")

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------
_running = True


def _shutdown(signum, frame):
    global _running
    sig_name = signal.Signals(signum).name
    log.info("Received %s — shutting down", sig_name)
    _running = False


signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT, _shutdown)


def _write_pid():
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
        log.info("PID %d written to %s", os.getpid(), PID_FILE)
    except OSError as exc:
        log.warning("Could not write PID file: %s", exc)


def _remove_pid():
    try:
        os.remove(PID_FILE)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Heartbeat thread
# ---------------------------------------------------------------------------
def _heartbeat_loop():
    headers = {}
    if EMULATOR_KEY:
        headers["X-Emulator-Key"] = EMULATOR_KEY

    while _running:
        try:
            resp = requests.post(HEARTBEAT_URL, headers=headers, timeout=10)
            if not resp.ok:
                log.warning("Heartbeat failed: %d %s", resp.status_code, resp.text[:200])
        except Exception as exc:
            log.warning("Heartbeat error: %s", exc)
        # Sleep in small increments so we can exit quickly
        for _ in range(30):
            if not _running:
                return
            time.sleep(1)


# ---------------------------------------------------------------------------
# Device helpers
# ---------------------------------------------------------------------------
def connect_device() -> u2.Device:
    log.info("Connecting to ADB device %s ...", ADB_DEVICE)
    d = u2.connect(ADB_DEVICE)
    info = d.info
    log.info("Connected: %s (serial=%s)", info.get("productName", "?"), ADB_DEVICE)
    return d


def pull_to_refresh(d: u2.Device):
    w, h = d.window_size()
    d.swipe(w // 2, int(h * 0.4), w // 2, int(h * 0.8), duration=0.3)
    time.sleep(3)


def scroll_down(d: u2.Device):
    w, h = d.window_size()
    d.swipe(w // 2, int(h * 0.75), w // 2, int(h * 0.3), duration=0.3)
    time.sleep(SCROLL_PAUSE)


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------
def post_orders(orders: list[dict]):
    if not orders:
        return
    headers = {"Content-Type": "application/json"}
    if EMULATOR_KEY:
        headers["X-Emulator-Key"] = EMULATOR_KEY
    payload = {"cabinet_id": CABINET_ID, "orders": orders}
    try:
        resp = requests.post(INGEST_URL, json=payload, headers=headers, timeout=30)
        if resp.ok:
            log.info("Ingested %d orders -> %d", len(orders), resp.status_code)
        else:
            log.warning("Ingest failed: %d %s", resp.status_code, resp.text[:300])
    except Exception as exc:
        log.error("Ingest error: %s", exc)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    _write_pid()
    log.info("=" * 60)
    log.info("WB Partners Monitor Sidecar")
    log.info("  ADB_DEVICE   = %s", ADB_DEVICE)
    log.info("  INGEST_URL   = %s", INGEST_URL)
    log.info("  HEARTBEAT_URL= %s", HEARTBEAT_URL)
    log.info("  CABINET_ID   = %s", CABINET_ID)
    log.info("  REFRESH_INTERVAL = %ds", REFRESH_INTERVAL)
    log.info("=" * 60)

    # Start heartbeat thread
    hb_thread = threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat")
    hb_thread.start()
    log.info("Heartbeat thread started (every 30s)")

    # Connect to emulator
    d = connect_device()

    cycle = 0
    while _running:
        cycle += 1
        log.info("--- Cycle %d ---", cycle)

        # Pull to refresh
        log.info("Refreshing feed...")
        pull_to_refresh(d)

        # Collect orders: parse current screen then scroll
        all_orders: dict[str, dict] = {}

        for scroll_i in range(MAX_SCROLLS + 1):
            try:
                xml = d.dump_hierarchy()
                page_orders = parse_orders(xml)
            except Exception as exc:
                log.error("Parse error on scroll %d: %s", scroll_i, exc)
                break

            new_in_scroll = 0
            for o in page_orders:
                key = o["dedup_key"]
                if key not in all_orders:
                    all_orders[key] = o
                    new_in_scroll += 1

            log.info("  Scroll %d: %d parsed, %d new", scroll_i, len(page_orders), new_in_scroll)

            if scroll_i < MAX_SCROLLS:
                if new_in_scroll == 0 and scroll_i > 0:
                    log.info("  No new orders after scroll — stopping")
                    break
                scroll_down(d)

        log.info("Total orders collected: %d", len(all_orders))

        # POST all orders to ingest endpoint
        if all_orders:
            post_orders(list(all_orders.values()))

        # Wait for next cycle
        log.info("Sleeping %ds until next cycle...", REFRESH_INTERVAL)
        for _ in range(REFRESH_INTERVAL):
            if not _running:
                break
            time.sleep(1)

    _remove_pid()
    log.info("Monitor stopped cleanly")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        _remove_pid()
