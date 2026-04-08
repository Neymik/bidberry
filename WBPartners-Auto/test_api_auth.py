"""Tests for WBPartners-Auto FastAPI auth wiring."""
import os
import sys
from pathlib import Path

# Make the WBPartners-Auto dir importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ["API_KEY"] = "test-api-key-1234567890"

from fastapi.testclient import TestClient

import api as api_module  # noqa: E402

# Force re-read of API_KEY into the module
api_module.API_KEY = "test-api-key-1234567890"

client = TestClient(api_module.app)


def test_orders_requires_api_key():
    r = client.get("/orders")
    assert r.status_code in (401, 403), f"expected auth failure, got {r.status_code}: {r.text}"


def test_orders_rejects_wrong_api_key():
    r = client.get("/orders", headers={"X-API-Key": "wrong-key"})
    assert r.status_code == 403, f"expected 403, got {r.status_code}"


def test_stats_requires_api_key():
    r = client.get("/stats")
    assert r.status_code in (401, 403)


def test_stats_rejects_wrong_api_key():
    r = client.get("/stats", headers={"X-API-Key": "wrong-key"})
    assert r.status_code == 403


def test_export_csv_requires_api_key():
    r = client.get("/export/csv")
    assert r.status_code in (401, 403)


def test_orders_by_article_requires_api_key():
    r = client.get("/orders/12345")
    assert r.status_code in (401, 403)


def test_health_does_not_require_key():
    r = client.get("/health")
    assert r.status_code == 200


if __name__ == "__main__":
    # Cheap test runner — pytest is also fine if installed.
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                print(f"FAIL  {name}: {e}")
                failures += 1
    sys.exit(1 if failures else 0)
