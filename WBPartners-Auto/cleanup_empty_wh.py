#!/usr/bin/env python3
"""One-shot: delete orders rows with empty warehouse or arrival_city.

These rows are a consequence of the pre-gate parser saving partially-rendered
cards. After the parser is gated on full render, no new empty-wh/city rows
will appear; this script removes the historical backlog so the schema
migration can add NOT NULL + CHECK(length > 0) constraints.

Usage:
    python3 cleanup_empty_wh.py            # dry-run: print counts only
    python3 cleanup_empty_wh.py --confirm  # backup + delete
"""

import shutil
import sys
from datetime import datetime

from db import get_connection, DB_PATH


def counts(conn):
    def _q(sql):
        return conn.execute(sql).fetchone()[0]
    return {
        "total": _q("SELECT COUNT(*) FROM orders"),
        "empty_warehouse": _q("SELECT COUNT(*) FROM orders WHERE COALESCE(warehouse,'') = ''"),
        "empty_arrival_city": _q("SELECT COUNT(*) FROM orders WHERE COALESCE(arrival_city,'') = ''"),
        "to_delete": _q(
            "SELECT COUNT(*) FROM orders "
            "WHERE COALESCE(warehouse,'') = '' OR COALESCE(arrival_city,'') = ''"
        ),
    }


def main():
    confirm = "--confirm" in sys.argv[1:]
    conn = get_connection()
    try:
        before = counts(conn)
        print("Current DB state:")
        print(f"  total rows:           {before['total']}")
        print(f"  empty warehouse:      {before['empty_warehouse']}")
        print(f"  empty arrival_city:   {before['empty_arrival_city']}")
        print(f"  rows to be deleted:   {before['to_delete']}")
        print()

        if not confirm:
            print("(dry-run) Re-run with --confirm to actually delete.")
            return 0

        if before["to_delete"] == 0:
            print("Nothing to delete.")
            return 0

        backup_path = f"{DB_PATH}.pre-cleanup-{datetime.now().strftime('%Y-%m-%d')}"
        print(f"Backing up DB → {backup_path}")
        shutil.copy(DB_PATH, backup_path)

        conn.execute(
            "DELETE FROM orders "
            "WHERE COALESCE(warehouse,'') = '' OR COALESCE(arrival_city,'') = ''"
        )
        conn.commit()

        after = counts(conn)
        print("After cleanup:")
        print(f"  total rows:           {after['total']}")
        print(f"  empty warehouse:      {after['empty_warehouse']}")
        print(f"  empty arrival_city:   {after['empty_arrival_city']}")
        print(f"  deleted:              {before['total'] - after['total']}")
        assert after["empty_warehouse"] == 0 and after["empty_arrival_city"] == 0, \
            "cleanup did not remove all empties"
        print("OK")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
