"""Shared hourly-CPO chart rendering.

ONE renderer for both the `/cpo` bot command (bot.py) and the hourly digest
(wb_order_monitor.py), so the two pictures never diverge. Both feed it the same
Bidberry `/api/trigger/cpo-hourly` JSON (points / totals / cabinetName), which
guarantees identical data on the image — no per-renderer drift.
"""

import io


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
