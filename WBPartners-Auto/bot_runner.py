#!/usr/bin/env python3
"""Entry point for wb-bot.service — runs ONLY the Telegram bot poller.

Split off from wb_order_monitor.py so /count (and every other slash command)
no longer dies along with the order monitor when ADB/device/uiautomator2
crashes, and vice versa. systemd handles restarts with a fixed RestartSec
instead of the in-process exponential backoff that previously hid the bot
for up to 5 minutes after a crash.
"""

import os
import sys

from dotenv import load_dotenv

from bot import run_bot_blocking

load_dotenv()


def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("ERROR: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env",
              file=sys.stderr)
        sys.exit(1)

    print("=" * 60)
    print("WB Partners Telegram Bot")
    print(f"Chat: {chat}")
    print("=" * 60)
    run_bot_blocking()


if __name__ == "__main__":
    main()
