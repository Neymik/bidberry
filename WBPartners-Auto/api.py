"""Private REST API for WB Partners order data."""

import csv
import io
import os
import time
import threading
from datetime import datetime
from typing import Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Security, status
from fastapi.responses import StreamingResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel

from db import (
    get_orders_by_article,
    get_orders_by_date_range,
    get_orders_by_status,
    get_recent_orders,
    get_stats,
)

load_dotenv()

API_KEY = os.getenv("API_KEY")
# Bind to loopback by default. Override only if you have a real reason
# to expose this API beyond the box (and you should still front it with auth).
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "22001"))

START_TIME = time.time()

# --- Models ---

class OrderResponse(BaseModel):
    id: int
    key: str
    article: str
    product: str
    size: str
    quantity: str
    status: str
    date_raw: str
    date_parsed: str
    price: str
    price_cents: int
    category: Optional[str] = None
    warehouse: Optional[str] = None
    arrival_city: Optional[str] = None
    first_seen: str


class StatusCount(BaseModel):
    status: str
    count: int


class StatsResponse(BaseModel):
    total: int
    today: int
    by_status: list[StatusCount]


class HealthResponse(BaseModel):
    status: str
    orders_in_db: int
    uptime_seconds: float


# --- Auth ---

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def verify_api_key(key: str = Security(api_key_header)):
    if not API_KEY:
        # Refuse to serve protected endpoints if the server itself has no key
        # configured — better to fail loud than auto-allow.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="API_KEY not configured on server")
    if not key or key != API_KEY:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")


# --- App ---

app = FastAPI(
    title="WB Partners Orders API",
    version="1.0.0",
    description="Private API for querying Wildberries Partners order data.",
)


@app.get("/health", response_model=HealthResponse)
def health():
    s = get_stats()
    return {
        "status": "ok",
        "orders_in_db": s["total"],
        "uptime_seconds": round(time.time() - START_TIME, 1),
    }


@app.get("/orders", response_model=list[OrderResponse], dependencies=[Depends(verify_api_key)])
def list_orders(
    limit: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end_date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    if status:
        rows = get_orders_by_status(status, limit)
    elif start_date and end_date:
        rows = get_orders_by_date_range(start_date, end_date)
    else:
        rows = get_recent_orders(limit)
    return [dict(r) for r in rows]


@app.get("/orders/{article}", response_model=list[OrderResponse], dependencies=[Depends(verify_api_key)])
def orders_by_article(article: str):
    rows = get_orders_by_article(article)
    if not rows:
        raise HTTPException(status_code=404, detail="No orders found for this article")
    return [dict(r) for r in rows]


@app.get("/stats", response_model=StatsResponse, dependencies=[Depends(verify_api_key)])
def stats():
    s = get_stats()
    return {
        "total": s["total"],
        "today": s["today"],
        "by_status": [{"status": st, "count": c} for st, c in s["by_status"]],
    }


@app.get("/export/csv", dependencies=[Depends(verify_api_key)])
def export_csv(
    start_date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end_date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    today = datetime.now().strftime("%Y-%m-%d")
    start = start_date or today
    end = end_date or today

    rows = get_orders_by_date_range(start, end)
    if not rows:
        raise HTTPException(status_code=404, detail=f"No orders for {start} — {end}")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "id", "article", "product", "size", "quantity", "status",
        "date", "price", "category", "warehouse", "arrival_city", "first_seen",
    ])
    for r in rows:
        d = dict(r)
        writer.writerow([
            d["id"], d["article"], d["product"], d["size"], d["quantity"],
            d["status"], d["date_raw"], d["price"], d["category"] or "",
            d["warehouse"] or "", d["arrival_city"] or "", d["first_seen"],
        ])

    output = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    filename = f"orders_{start}_{end}.csv"
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Thread runner ---

def run_api_thread():
    """Start FastAPI in a daemon thread."""
    def _run():
        uvicorn.run(app, host=API_HOST, port=API_PORT, log_level="info")

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t
