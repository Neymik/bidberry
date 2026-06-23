"""Telegram bot for querying WB Partners orders from the database."""

import csv
import io
import os
from datetime import datetime, timedelta
from functools import wraps

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.error import RetryAfter
from telegram.ext import Application, CommandHandler, ContextTypes

from db import get_recent_orders, get_orders_by_status, get_orders_by_date_range, get_stats
from cpo_chart import render_cpo_chart, build_cpo_caption

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Bidberry web app — used by the Telegram deep-link login flow. The bot is the
# only thing polling this token, so the website's "open Telegram to log in"
# button (t.me/<bot>?start=<token>) lands here as `/start <token>`. We forward
# the authenticated Telegram user to the app over localhost, gated by the shared
# secret, and the app runs the whitelist check + issues the session.
APP_INTERNAL_URL = os.getenv("APP_INTERNAL_URL", "http://127.0.0.1:3000")
TRIGGER_SECRET = os.getenv("TRIGGER_SECRET", "")


async def _confirm_web_login(token: str, user) -> str:
    """POST the login token + Telegram user to the app. Returns a status string
    ('confirmed' | 'denied' | 'expired') or raises on transport failure."""
    payload = {
        "token": token,
        "telegram_user": {
            "id": user.id,
            "username": user.username,
            "first_name": user.first_name,
            "last_name": user.last_name,
        },
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{APP_INTERNAL_URL}/api/auth/telegram/confirm",
            json=payload,
            headers={"X-Trigger-Secret": TRIGGER_SECRET},
        )
        data = resp.json()
        return data.get("status", "expired")


def restricted(func):
    """Only allow commands from the configured chat."""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if str(update.effective_chat.id) != TELEGRAM_CHAT_ID:
            return
        return await func(update, context)
    return wrapper


def format_order(o):
    """Format a DB row as a Telegram HTML message."""
    status = o["status"]
    emoji = {"Заказ": "\u2705", "Отказ": "\u274c", "Выкуп": "\U0001f4b0", "Возврат": "\u21a9\ufe0f"}.get(status, "\u2753")
    lines = [
        f"{emoji} <b>{status}</b>",
        f"\U0001f457 {o['product']}",
        f"\U0001f4e6 Артикул: <code>{o['article']}</code> | {o['vendor_code'] or ''}",
        f"\U0001f4cf Размер: {o['size']} | {o['quantity']}",
        f"\U0001f4b5 {o['price']}",
        f"\U0001f4c5 {o['date_raw']}",
    ]
    if o["arrival_city"]:
        lines.append(f"\U0001f4cd {o['arrival_city']}")
    if o["warehouse"]:
        lines.append(f"\U0001f3ed {o['warehouse']}")
    return "\n".join(lines)


async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Deep-link web login: /start <token>. Open to anyone (the app enforces the
    # whitelist) — this is NOT gated by TELEGRAM_CHAT_ID like the other commands.
    if context.args and context.args[0]:
        token = context.args[0]
        try:
            status = await _confirm_web_login(token, update.effective_user)
        except Exception as exc:
            print(f"  bot.py web login error: {type(exc).__name__}: {exc}")
            await update.message.reply_text(
                "⚠️ Не удалось связаться с сайтом. Попробуйте ещё раз."
            )
            return
        if status == "confirmed":
            await update.message.reply_text(
                "✅ Вход выполнен! Вернитесь на сайт — он откроется автоматически."
            )
        elif status == "denied":
            await update.message.reply_text(
                "⛔ Доступ запрещён: ваш аккаунт не в списке разрешённых."
            )
        else:
            await update.message.reply_text(
                "⌛ Ссылка для входа устарела. Обновите страницу входа и попробуйте снова."
            )
        return

    # Plain /start from the configured monitoring chat — show the welcome.
    if str(update.effective_chat.id) != TELEGRAM_CHAT_ID:
        return
    await update.message.reply_text(
        "\U0001f4e6 <b>WB Partners Monitor Bot</b>\n\n"
        "Используйте /help для списка команд",
        parse_mode="HTML",
    )


@restricted
async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "<b>Команды:</b>\n"
        "/orders [N] — последние N заказов (по умолчанию 5)\n"
        "/count — итоги за сегодня\n"
        "/count hour — итоги за последний час\n"
        "/count_yesterday — итоги за вчера\n"
        "/count ГГГГ-ММ-ДД — итоги за дату\n"
        "/count ГГГГ-ММ-ДД ГГГГ-ММ-ДД — итоги за период\n"
        "/cpo [часов] — график CPO по часам (по умолчанию 12)\n"
        "/status Заказ|Отказ|Выкуп|Возврат — фильтр по статусу\n"
        "/stats — сводка по заказам\n"
        "/csv [начало] [конец] — выгрузка CSV\n"
        "/csv_yesterday — выгрузка CSV за вчера\n"
        "/help — эта справка",
        parse_mode="HTML",
    )


@restricted
async def orders_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    limit = 5
    if context.args:
        try:
            limit = int(context.args[0])
            limit = min(limit, 50)
        except ValueError:
            pass

    orders = get_recent_orders(limit)
    if not orders:
        await update.message.reply_text("Заказов пока нет.")
        return

    for o in orders:
        await update.message.reply_text(format_order(o), parse_mode="HTML")


@restricted
async def status_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Укажите статус: /status Заказ")
        return

    status = context.args[0]
    valid = ("Заказ", "Отказ", "Выкуп", "Возврат")
    if status not in valid:
        await update.message.reply_text(f"Статус должен быть: {', '.join(valid)}")
        return

    orders = get_orders_by_status(status)
    if not orders:
        await update.message.reply_text(f"Нет заказов со статусом «{status}»")
        return

    header = f"\U0001f4cb <b>{status}</b> — {len(orders)} шт:\n"
    await update.message.reply_text(header, parse_mode="HTML")
    for o in orders[:10]:
        await update.message.reply_text(format_order(o), parse_mode="HTML")
    if len(orders) > 10:
        await update.message.reply_text(f"... и ещё {len(orders) - 10}")


@restricted
async def stats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    s = get_stats()
    lines = [
        f"\U0001f4ca <b>Статистика</b>\n",
        f"Всего заказов: <b>{s['total']}</b>",
        f"За сегодня: <b>{s['today']}</b>\n",
        "<b>По статусам:</b>",
    ]
    emoji_map = {"Заказ": "\u2705", "Отказ": "\u274c", "Выкуп": "\U0001f4b0", "Возврат": "\u21a9\ufe0f"}
    for status, count in s["by_status"]:
        e = emoji_map.get(status, "\u2753")
        lines.append(f"  {e} {status}: {count}")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


@restricted
async def csv_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    today = datetime.now().strftime("%Y-%m-%d")
    if len(context.args) == 2:
        start, end = context.args
    elif len(context.args) == 0:
        start = end = today
    else:
        await update.message.reply_text("Формат: /csv ГГГГ-ММ-ДД ГГГГ-ММ-ДД\nИли /csv без аргументов (сегодня)")
        return

    orders = get_orders_by_date_range(start, end)
    if not orders:
        await update.message.reply_text(f"Нет заказов за {start} — {end}")
        return

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Артикул", "Артикул продавца", "Товар", "Размер", "Кол-во", "Статус",
                      "Дата", "Цена", "Категория", "Склад", "Город", "Обнаружен"])
    for o in orders:
        writer.writerow([
            o["article"], o["vendor_code"] or "", o["product"], o["size"], o["quantity"], o["status"],
            o["date_raw"], o["price"], o["category"] or "", o["warehouse"] or "",
            o["arrival_city"] or "", o["first_seen"],
        ])

    doc = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    filename = f"orders_{start}_{end}.csv"
    await update.message.reply_document(document=doc, filename=filename)
    await update.message.reply_text(f"\U0001f4c4 {len(orders)} заказов за {start} — {end}")


def _format_revenue(cents):
    """Format kopecks as readable rubles: 123456789 -> '1 234 567 ₽'."""
    rubles = cents // 100
    s = str(rubles)
    # Add space as thousands separator
    parts = []
    while s:
        parts.append(s[-3:])
        s = s[:-3]
    return " ".join(reversed(parts)) + " ₽"


def _fetch_bidberry_report(start=None, end=None, label=None):
    """GET the formatted cabinet report from bidberry backend.

    Returns a (status, payload) tuple so the caller can tell apart success,
    "nothing to report", and failure — the three cases previously collapsed
    into a silent None. Prior silence caused the /count format to change
    under the user's feet with no explanation.

    When start/end/label are all provided, they're forwarded as query params
    so the same rich format (orders tel/API | budget | CPO) is returned for
    any MSK wall-clock window — not just "today". All three must be set or
    all must be None.

    status values:
      "ok"          — payload is the HTML message text
      "empty"       — bidberry explicitly had no phone orders in the window
      "unconfigured"— BIDBERRY_CABINET_ID not set
      "unavailable" — HTTP/network failure; payload is a short reason
    """
    cabinet_id = os.getenv("BIDBERRY_CABINET_ID")
    if not cabinet_id:
        return ("unconfigured", None)
    base = os.getenv("BIDBERRY_URL", "http://127.0.0.1:3000")
    url = f"{base}/api/trigger/cabinet-report/{cabinet_id}"
    secret = os.getenv("TRIGGER_SECRET", "")
    headers = {"X-Trigger-Secret": secret} if secret else {}
    params = {}
    if start and end and label:
        params = {"start": start, "end": end, "label": label}
    try:
        import requests
        r = requests.get(url, timeout=10, headers=headers, params=params)
        if not r.ok:
            body = (r.text or "")[:200].replace("\n", " ")
            reason = f"HTTP {r.status_code}"
            print(f"[count] bidberry unavailable: {reason} body={body!r}")
            return ("unavailable", reason)
        data = r.json()
        if data.get("empty"):
            print("[count] bidberry returned empty (no phone orders in window)")
            return ("empty", None)
        text = data.get("text") or None
        if not text:
            print(f"[count] bidberry returned no text field: {data!r}")
            return ("unavailable", "no text in response")
        return ("ok", text)
    except Exception as e:
        reason = f"{type(e).__name__}: {e}"
        print(f"[count] bidberry fetch failed: {reason}")
        return ("unavailable", reason)


def _fetch_cpo_hourly(hours=12):
    """GET the hourly CPO series from bidberry.

    Returns a (status, payload) tuple like _fetch_bidberry_report:
      "ok"          — payload is the parsed JSON dict (points/totals/...)
      "unconfigured"— BIDBERRY_CABINET_ID not set
      "unavailable" — HTTP/network failure; payload is a short reason
    """
    cabinet_id = os.getenv("BIDBERRY_CABINET_ID")
    if not cabinet_id:
        return ("unconfigured", None)
    base = os.getenv("BIDBERRY_URL", "http://127.0.0.1:3000")
    url = f"{base}/api/trigger/cpo-hourly/{cabinet_id}"
    secret = os.getenv("TRIGGER_SECRET", "")
    headers = {"X-Trigger-Secret": secret} if secret else {}
    try:
        import requests
        r = requests.get(url, timeout=15, headers=headers, params={"hours": hours})
        if not r.ok:
            body = (r.text or "")[:200].replace("\n", " ")
            reason = f"HTTP {r.status_code}"
            print(f"[cpo] bidberry unavailable: {reason} body={body!r}")
            return ("unavailable", reason)
        return ("ok", r.json())
    except Exception as e:
        reason = f"{type(e).__name__}: {e}"
        print(f"[cpo] bidberry fetch failed: {reason}")
        return ("unavailable", reason)


@restricted
async def count_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    now = datetime.now()
    args = context.args or []

    # All /count variants go through the same bidberry endpoint so they return
    # the same rich format (orders tel/API | budget | CPO). Backend ranges are
    # half-open MSK wall-clock: [start, end).
    if not args or args[0].lower() in ("today", "сегодня", "день"):
        start = end = label = None  # backend default: MSK midnight..next midnight
        user_label = "сегодня"
    elif args[0].lower() in ("hour", "час"):
        hour_ago = now - timedelta(hours=1)
        start = hour_ago.strftime("%Y-%m-%d %H:%M:%S")
        end = now.strftime("%Y-%m-%d %H:%M:%S")
        label = f"Последний час ({hour_ago.strftime('%H:%M')}–{now.strftime('%H:%M')})"
        user_label = label
    elif args[0].lower() in ("yesterday", "вчера"):
        y = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        start = f"{y} 00:00:00"
        end = now.strftime("%Y-%m-%d") + " 00:00:00"
        label = y
        user_label = f"вчера ({y})"
    elif len(args) == 1:
        try:
            d = datetime.strptime(args[0], "%Y-%m-%d")
        except ValueError:
            await update.message.reply_text("Формат даты: ГГГГ-ММ-ДД")
            return
        start = d.strftime("%Y-%m-%d 00:00:00")
        end = (d + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
        label = args[0]
        user_label = args[0]
    elif len(args) >= 2:
        try:
            d1 = datetime.strptime(args[0], "%Y-%m-%d")
            d2 = datetime.strptime(args[1], "%Y-%m-%d")
        except ValueError:
            await update.message.reply_text("Формат даты: ГГГГ-ММ-ДД ГГГГ-ММ-ДД")
            return
        if d2 < d1:
            await update.message.reply_text("Конечная дата раньше начальной.")
            return
        start = d1.strftime("%Y-%m-%d 00:00:00")
        end = (d2 + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
        label = f"{args[0]} — {args[1]}"
        user_label = label
    else:
        await update.message.reply_text("Формат: /count [hour|ГГГГ-ММ-ДД|ГГГГ-ММ-ДД ГГГГ-ММ-ДД]")
        return

    status, payload = _fetch_bidberry_report(start=start, end=end, label=label)
    if status == "ok":
        await update.message.reply_text(payload, parse_mode="HTML")
    elif status == "empty":
        await update.message.reply_text(f"Нет заказов с телефона за {user_label}.")
    elif status == "unconfigured":
        await update.message.reply_text(
            "⚠️ BIDBERRY_CABINET_ID не настроен в WBPartners-Auto/.env"
        )
    else:
        await update.message.reply_text(f"⚠️ bidberry недоступен: {payload}")


@restricted
async def count_yesterday_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.args = ["yesterday"]
    await count_cmd(update, context)


@restricted
async def csv_yesterday_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    y = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    context.args = [y, y]
    await csv_cmd(update, context)


@restricted
async def cpo_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send an hourly CPO graph for the last N hours (default 12)."""
    hours = 12
    if context.args:
        try:
            hours = max(1, min(48, int(context.args[0])))
        except ValueError:
            pass

    status, payload = _fetch_cpo_hourly(hours)
    if status == "unconfigured":
        await update.message.reply_text("BIDBERRY_CABINET_ID не задан — график недоступен.")
        return
    if status != "ok" or not isinstance(payload, dict):
        await update.message.reply_text(f"Бэкенд недоступен: {payload}")
        return

    points = payload.get("points", [])
    if not points or all((p.get("orders", 0) == 0 and p.get("spend", 0) == 0) for p in points):
        await update.message.reply_text(f"Нет данных за последние {hours} ч.")
        return

    try:
        buf = render_cpo_chart(payload)
    except ImportError:
        await update.message.reply_text("matplotlib не установлен на сервере — не могу построить график.")
        return
    except Exception as e:
        print(f"[cpo] render failed: {type(e).__name__}: {e}")
        await update.message.reply_text("Не удалось построить график.")
        return

    # Same caption builder as the hourly digest, so the two never diverge.
    # transitions=None: the bot is a separate process and has no access to the
    # monitor's in-memory status-change list, so that line is omitted here.
    caption = build_cpo_caption(payload, hours=hours)
    await update.message.reply_photo(photo=buf, caption=caption)


async def _on_error(update, context):
    """Surface handler errors in monitor.log instead of silently swallowing them.

    Without this, a 429 (RetryAfter) raised from inside a CommandHandler gets
    absorbed by PTB's default error path and the user sees the bot "ignore"
    the command. Preventing 429s upstream (send_telegram retry + batching) is
    the real fix; this handler just ensures residual failures are visible.
    """
    err = context.error
    if isinstance(err, RetryAfter):
        print(f"  bot.py RetryAfter: {err.retry_after}s (reply dropped)")
    else:
        print(f"  bot.py handler error: {type(err).__name__}: {err}")


def build_app():
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("orders", orders_cmd))
    app.add_handler(CommandHandler("status", status_cmd))
    app.add_handler(CommandHandler("count", count_cmd))
    app.add_handler(CommandHandler("count_yesterday", count_yesterday_cmd))
    app.add_handler(CommandHandler("cpo", cpo_cmd))
    app.add_handler(CommandHandler("stats", stats_cmd))
    app.add_handler(CommandHandler("csv", csv_cmd))
    app.add_handler(CommandHandler("csv_yesterday", csv_yesterday_cmd))
    app.add_error_handler(_on_error)
    return app


async def _poll_forever():
    """Run the polling loop until cancelled/crashed. Used by both the legacy
    in-process thread starter and the standalone bot service."""
    import asyncio
    app = build_app()
    await app.initialize()
    await app.updater.start_polling()
    await app.start()
    while True:
        await asyncio.sleep(1)


def run_bot_blocking():
    """Foreground bot entry — runs polling in the current thread and lets
    exceptions propagate so the supervising process manager (systemd) restarts
    cleanly with a fixed RestartSec, instead of the in-process exponential
    backoff that could leave /count silent for up to 5 minutes."""
    import asyncio
    asyncio.run(_poll_forever())


def run_bot_thread():
    """Legacy in-process daemon-thread starter, kept for compatibility with
    server.py / older deployments that still embed the bot. Production now
    runs the bot under wb-bot.service via run_bot_blocking()."""
    import threading
    import asyncio
    import traceback

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        backoff = 10
        while True:
            try:
                loop.run_until_complete(_poll_forever())
            except Exception as e:
                print(f"Telegram bot crashed: {e.__class__.__name__}: {e}")
                traceback.print_exc()
                print(f"Restarting bot in {backoff}s...")
                import time
                time.sleep(backoff)
                backoff = min(backoff * 2, 300)
            else:
                break

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t
