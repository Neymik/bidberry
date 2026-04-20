#!/usr/bin/env bash
# Recount today's orders — stops wb-monitor, re-scans the feed, restarts service.
# Usage: bash recount_today.sh [--date YYYY-MM-DD]
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

echo ">>> Stopping wb-monitor.service..."
sudo systemctl stop wb-monitor.service

trap 'echo ">>> Restarting wb-monitor.service..."; sudo systemctl start wb-monitor.service' EXIT

sleep 2  # let ADB / uiautomator2 settle after monitor exits

echo ">>> Running recount..."
./venv/bin/python3 recount_today.py "$@"
