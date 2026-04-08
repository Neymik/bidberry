"""Telegram bot for querying WB Partners orders from the database."""

import csv
import io
import os
from datetime import datetime, timedelta
from functools import wraps

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from db import get_recent_orders, get_orders_by_status, get_orders_by_date_range, get_stats, get_totals, get_totals_by_article

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


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


@restricted
async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
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
        "/count ГГГГ-ММ-ДД — итоги за дату\n"
        "/count ГГГГ-ММ-ДД ГГГГ-ММ-ДД — итоги за период\n"
        "/status Заказ|Отказ|Выкуп|Возврат — фильтр по статусу\n"
        "/stats — сводка по заказам\n"
        "/csv [начало] [конец] — выгрузка CSV\n"
        "/help — эта справка",
        parse_mode="HTML",
    )


@restricted
async def orders_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    limit = 5
    if context.args:
        try:
            limit = max(1, min(int(context.args[0]), 50))
        except (TypeError, ValueError):
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


def _fetch_bidberry_report():
    """GET the formatted cabinet report from bidberry backend.
    Returns the message text or None if unavailable/empty."""
    cabinet_id = os.getenv("BIDBERRY_CABINET_ID")
    if not cabinet_id:
        return None
    secret = os.getenv("TRIGGER_SECRET")
    if not secret:
        print("  bidberry fetch skipped: TRIGGER_SECRET not set")
        return None
    base = os.getenv("BIDBERRY_URL", "http://127.0.0.1:3000")
    url = f"{base}/api/trigger/cabinet-report/{cabinet_id}"
    try:
        import requests
        r = requests.get(url, timeout=10, headers={"X-Trigger-Secret": secret})
        if r.status_code == 401:
            print("  bidberry fetch rejected: TRIGGER_SECRET mismatch")
            return None
        if not r.ok:
            return None
        data = r.json()
        if data.get("empty"):
            return None
        return data.get("text") or None
    except Exception as e:
        print(f"  bidberry fetch failed: {e}")
        return None


@restricted
async def count_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    now = datetime.now()
    args = context.args or []

    # Default /count (no args) or today: fetch rich bidberry report
    # (includes ad budget + CPO). Falls back to local SQLite summary.
    if not args or args[0].lower() in ("today", "сегодня", "день"):
        bidberry_text = _fetch_bidberry_report()
        if bidberry_text:
            await update.message.reply_text(bidberry_text, parse_mode="HTML")
            return
        # Fallback: local SQLite summary
        start = now.strftime("%Y-%m-%d") + " 00:00:00"
        end = now.strftime("%Y-%m-%d") + " 23:59:59"
        label = f"Сегодня ({now.strftime('%d.%m.%Y')})"
    elif args[0].lower() in ("hour", "час"):
        # Last hour
        hour_ago = now - timedelta(hours=1)
        start = hour_ago.strftime("%Y-%m-%d %H:%M:%S")
        end = now.strftime("%Y-%m-%d %H:%M:%S")
        label = f"Последний час ({hour_ago.strftime('%H:%M')}–{now.strftime('%H:%M')})"
    elif len(args) == 1:
        # Single date
        start = args[0] + " 00:00:00"
        end = args[0] + " 23:59:59"
        label = args[0]
    elif len(args) >= 2:
        # Date range
        start = args[0] + " 00:00:00"
        end = args[1] + " 23:59:59"
        label = f"{args[0]} — {args[1]}"
    else:
        await update.message.reply_text("Формат: /count [hour|ГГГГ-ММ-ДД|ГГГГ-ММ-ДД ГГГГ-ММ-ДД]")
        return

    totals = get_totals(start, end)
    by_article = get_totals_by_article(start, end)
    emoji_map = {"Заказ": "✅", "Отказ": "❌", "Выкуп": "💰", "Возврат": "↩️"}

    lines = [
        f"📊 <b>Итоги: {label}</b>\n",
        f"Заказов: <b>{totals['count']}</b>",
        f"Сумма: <b>{_format_revenue(totals['revenue_cents'])}</b>\n",
    ]
    if totals["by_status"]:
        lines.append("<b>По статусам:</b>")
        for status, cnt, rev in totals["by_status"]:
            e = emoji_map.get(status, "❓")
            lines.append(f"  {e} {status}: {cnt} шт — {_format_revenue(rev)}")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML")

    # Article summary table
    if not by_article:
        return

    if len(by_article) <= 3:
        # Send as text table
        table_lines = [f"<b>{label}</b>\n", "<b>Артикул | Арт.прод. | Кол-во | Сумма</b>"]
        for article, vc, cnt, rev in by_article:
            table_lines.append(f"<code>{article}</code> | {vc} | {cnt} шт | {_format_revenue(rev)}")
        await update.message.reply_text("\n".join(table_lines), parse_mode="HTML")
    else:
        # Send as CSV file
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter=";")
        writer.writerow(["Артикул", "Артикул продавца", "Кол-во заказов", "Сумма ₽"])
        for article, vc, cnt, rev in by_article:
            writer.writerow([article, vc, cnt, rev // 100])
        doc = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
        await update.message.reply_document(
            document=doc,
            filename=f"count_{label.replace(' ', '_')}.csv",
            caption=f"📋 {len(by_article)} артикулов за {label}",
        )


def build_app():
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("orders", orders_cmd))
    app.add_handler(CommandHandler("status", status_cmd))
    app.add_handler(CommandHandler("count", count_cmd))
    app.add_handler(CommandHandler("stats", stats_cmd))
    app.add_handler(CommandHandler("csv", csv_cmd))
    return app


def run_bot_thread():
    """Start the bot in a daemon thread using manual polling (no signal handlers)."""
    import threading
    import asyncio

    async def _poll():
        app = build_app()
        await app.initialize()
        await app.updater.start_polling()
        await app.start()
        # Keep running until thread is killed
        while True:
            await asyncio.sleep(1)

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_poll())

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t
