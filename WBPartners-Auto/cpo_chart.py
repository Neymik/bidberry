"""Shared hourly-CPO presentation (chart + caption).

ONE renderer AND one caption builder for both the `/cpo` bot command (bot.py)
and the hourly digest (wb_order_monitor.py), so the two never diverge — same
picture, same text. Both feed `render_cpo_chart` / `build_cpo_caption` the same
Bidberry `/api/trigger/cpo-hourly` JSON (points / totals / cabinetName).
"""

import io

# Mirrors the maps in bot.py / wb_order_monitor.py so the shared caption uses
# the same glyphs everywhere.
STATUS_EMOJI = {"Заказ": "✅", "Отказ": "❌", "Выкуп": "💰", "Возврат": "↩️"}


def build_cpo_caption(series, last_hour=None, today_total=None,
                      transitions=None, hours=12):
    """Build the merged CPO digest caption — identical text for the hourly
    digest and the /cpo command.

    Combines last-60-min order detail (count by status + top articles) with the
    Nh aggregate (orders / budget / CPO, from `series.totals`) and today's
    running total. Pulls last-hour + today from the phone DB itself unless the
    caller passes them in (the digest already has `last_hour`, so it avoids a
    re-query). `transitions` is the monitor's in-memory status-change list —
    the bot has no access to it and passes None, so that line is simply omitted.
    Returns an HTML string clamped to Telegram's 1024-char caption limit.
    """
    from datetime import datetime, timedelta
    from collections import Counter
    import db

    now = datetime.now()
    hour_ago = now - timedelta(hours=1)
    if last_hour is None:
        last_hour = db.get_live_orders_in_range(hour_ago.isoformat(), now.isoformat())
    if today_total is None:
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        today_total = db.count_live_orders_in_range(today_start.isoformat(), now.isoformat())

    totals = (series or {}).get("totals") or {}
    window = f"{hour_ago.strftime('%H:%M')}–{now.strftime('%H:%M')}"

    lines = ["📊 <b>Заказы — дайджест</b>"]
    if last_hour:
        by_status = Counter(r["status"] for r in last_hour)
        brk = " ".join(f"{STATUS_EMOJI.get(s, '❔')}{n}" for s, n in by_status.most_common())
        lines.append(f"🕐 За час ({window}): {len(last_hour)} новых {brk}")
    else:
        lines.append(f"🕐 За час ({window}): 0 новых")
    if transitions:
        by_new = Counter(t["new"] for t in transitions)
        tbrk = " ".join(f"{STATUS_EMOJI.get(s, '❔')}{n}" for s, n in by_new.most_common())
        lines.append(f"🔄 Смены статусов: {len(transitions)} ({tbrk})")
    if last_hour:
        top = Counter(r["article"] for r in last_hour).most_common(3)
        lines.append("🔝 за час: " + ", ".join(f"<code>{a}</code>×{n}" for a, n in top))

    if series:
        t_cpo = totals.get("cpo")
        t_cpo_str = f"{t_cpo} ₽" if t_cpo is not None else "—"
        lines.append(
            f"📈 За {hours}ч: заказы {totals.get('orders', 0)} · "
            f"бюджет {round(totals.get('spend', 0) or 0)} ₽ · CPO {t_cpo_str}"
        )
    lines.append(f"📦 Сегодня всего: {today_total}")
    return "\n".join(lines)[:1024]


def render_cpo_chart(data):
    """Render the hourly CPO series to a PNG (returns a seeked BytesIO).

    Orders are drawn as light bars (left axis, context); the CPO line (₽/order)
    is on the right axis, with hours that had no orders left as gaps. Totals go
    in the subtitle. matplotlib is imported lazily so a missing/broken install
    fails only the caller, not module import.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    points = data.get("points", [])
    labels = [p["label"] for p in points]
    orders = [p.get("orders", 0) for p in points]
    cpo = [p.get("cpo") for p in points]  # may contain None
    x = list(range(len(points)))

    fig, ax1 = plt.subplots(figsize=(10, 4.5))
    ax1.bar(x, orders, color="#cbd5e1", alpha=0.7, label="Заказы")
    ax1.set_ylabel("Заказы", color="#64748b")
    ax1.tick_params(axis="y", labelcolor="#64748b")
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
    ax1.set_ylim(bottom=0)

    ax2 = ax1.twinx()
    cx = [i for i, v in zip(x, cpo) if v is not None]
    cy = [v for v in cpo if v is not None]
    if cx:
        ax2.plot(cx, cy, color="#2563eb", marker="o", linewidth=2, label="CPO, ₽")
        for i, v in zip(cx, cy):
            ax2.annotate(f"{v}", (i, v), textcoords="offset points",
                         xytext=(0, 6), ha="center", fontsize=8, color="#1d4ed8")
    ax2.set_ylabel("CPO, ₽", color="#2563eb")
    ax2.tick_params(axis="y", labelcolor="#2563eb")
    ax2.set_ylim(bottom=0)

    totals = data.get("totals", {})
    tcpo = totals.get("cpo")
    tcpo_str = f"{tcpo}" if tcpo is not None else "—"
    title = f"CPO по часам — {data.get('cabinetName', '')} (МСК)"
    sub = (f"Σ заказы: {totals.get('orders', 0)}  ·  "
           f"Σ бюджет: {round(totals.get('spend', 0))} ₽  ·  CPO: {tcpo_str} ₽")
    ax1.set_title(f"{title}\n{sub}", fontsize=11)
    ax1.grid(axis="y", linestyle=":", alpha=0.3)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130)
    plt.close(fig)
    buf.seek(0)
    return buf
