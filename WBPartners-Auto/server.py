#!/usr/bin/env python3
"""
Server-only mode: runs API + Telegram bot (no emulator/monitor).
Use this on VPS where no Android emulator is available.
The monitor on your Mac syncs orders.db to this server.
"""

import os
import time
from dotenv import load_dotenv

from db import init_db
from bot import run_bot_thread
from api import run_api_thread, API_PORT

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


def main():
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env")
        return

    init_db()

    print("=" * 60)
    print("WB Partners Server (API + Bot)")
    print(f"API: http://0.0.0.0:{API_PORT}/docs")
    print("=" * 60)

    run_bot_thread()
    print("Telegram bot started")

    run_api_thread()
    print(f"REST API started on port {API_PORT}")

    # Keep main thread alive
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("\nShutting down...")


if __name__ == "__main__":
    main()
