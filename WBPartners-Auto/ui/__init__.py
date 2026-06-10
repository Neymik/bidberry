"""Version-aware UI layer for the WB Partners app.

The production phone auto-updates WB Partners; navigation and feed layout change
between releases. Each supported layout lives in its own module (feed_v1, feed_v2)
and `detect_app_version()` picks the right one at runtime, so the emulator (2.31.x)
and the phone (2.34.x) work from one codebase.
"""

import re
import subprocess


def _adb(serial, *args):
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True)


def detect_app_version(serial=None):
    """Return the installed WB Partners versionName, e.g. '2.34.0' ('' if unknown)."""
    out = _adb(serial, "shell", "dumpsys", "package", "wb.partners").stdout
    m = re.search(rb"versionName=([\d.]+)", out)
    return m.group(1).decode() if m else ""


def version_tuple(version_str):
    return tuple(int(p) for p in version_str.split(".") if p.isdigit())


def get_feed_module(serial=None):
    """Pick the UI module matching the installed app version.

    >= 2.33 -> feed_v2 (date-picker feed, sorted by status date)
    else    -> feed_v1 (legacy dashboard feed, sorted by order date)
    Unknown version (adb hiccup) falls back to v1 — the historical default.
    """
    version = detect_app_version(serial)
    from . import feed_v1, feed_v2
    if version and version_tuple(version) >= (2, 33):
        return feed_v2
    return feed_v1
