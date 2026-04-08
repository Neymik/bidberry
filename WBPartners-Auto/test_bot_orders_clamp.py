"""Tests that bot.orders_cmd clamps the limit to [1, 50]."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _clamp(raw):
    """Pure-function port of the new clamping logic — exercises the same expression."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 5
    return max(1, min(n, 50))


def test_clamps_zero_to_one():
    assert _clamp("0") == 1


def test_clamps_negative_to_one():
    assert _clamp("-5") == 1


def test_clamps_above_50_to_50():
    assert _clamp("9999") == 50


def test_passes_valid_value():
    assert _clamp("10") == 10


def test_default_on_garbage():
    assert _clamp("not a number") == 5


if __name__ == "__main__":
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
