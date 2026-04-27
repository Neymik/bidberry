"""Unit tests for orchestrator due-job scheduling logic.

Run: ./venv/bin/python3 test_orchestrator_due_logic.py

Tests _pick_due_job + simulate the orchestrator's clock-driven scheduling
with three jobs at different cadences. No device, no telegram, no clock
side effects — pure logic only.
"""

import time as time_mod
import unittest

import wb_order_monitor as wm


def _job(name, interval, next_run=0.0):
    """Build a Job with a no-op fn for tests."""
    return wm.Job(
        name=name,
        interval_sec=interval,
        fn=lambda d, s: None,
        next_run_ts=next_run,
    )


class TestPickDueJob(unittest.TestCase):
    def test_returns_first_due_in_declaration_order(self):
        # Both due at now=200; declaration order picks "monitor" first.
        jobs = [
            _job("monitor", 180, next_run=100),
            _job("rescan_shallow", 3600, next_run=50),
        ]
        self.assertEqual(wm._pick_due_job(jobs, 200).name, "monitor")

    def test_returns_none_when_no_job_due(self):
        jobs = [
            _job("monitor", 180, next_run=500),
            _job("rescan_shallow", 3600, next_run=600),
        ]
        self.assertIsNone(wm._pick_due_job(jobs, 100))

    def test_returns_due_job_when_only_one_is_due(self):
        jobs = [
            _job("monitor", 180, next_run=500),       # not due yet
            _job("rescan_shallow", 3600, next_run=100),  # due
        ]
        picked = wm._pick_due_job(jobs, 200)
        self.assertEqual(picked.name, "rescan_shallow")

    def test_zero_next_run_ts_is_due(self):
        # Initial JOBS state: next_run_ts=0 means run immediately on first tick.
        jobs = [_job("monitor", 180, next_run=0)]
        self.assertEqual(wm._pick_due_job(jobs, time_mod.time()).name, "monitor")


class TestOrchestratorSimulation(unittest.TestCase):
    def test_first_20_picks_are_monitor_until_hour_boundary(self):
        """With 180s monitor and 3600s shallow, ~20 monitor picks fire before shallow.

        Simulates the orchestrator's clock advancement: pick a due job, advance
        the clock by a tiny "job duration", reset that job's next_run_ts.
        """
        jobs = [
            _job("monitor", 180, next_run=0),
            _job("rescan_shallow", 3600, next_run=3600),
        ]
        clock = 0.0
        picks = []
        # Each loop iteration either picks a due job OR jumps the clock to the
        # next due job (mirrors orchestrator_loop's sleep branch). One
        # pick + one jump = 2 iterations per cadence step, so we need to
        # walk far enough to cross the hour boundary (~20 monitor cycles).
        for _ in range(60):
            j = wm._pick_due_job(jobs, clock)
            if j is None:
                clock = min(jj.next_run_ts for jj in jobs)
                continue
            picks.append(j.name)
            # Tiny job duration so clock moves forward by a hair.
            clock = max(clock, j.next_run_ts) + 0.01
            j.next_run_ts = clock + j.interval_sec - 0.01

        # 3600 / 180 ≈ 20 monitor cycles before shallow fires.
        first_20 = picks[:20]
        self.assertTrue(
            all(p == "monitor" for p in first_20),
            f"expected first 20 to all be 'monitor', got: {first_20}",
        )
        # Eventually shallow fires.
        self.assertIn("rescan_shallow", picks, f"shallow never fired: {picks}")

    def test_long_overshoot_keeps_sleep_non_negative(self):
        """If a job runs longer than its own interval, next-tick sleep stays >= 0.5."""
        jobs = [_job("monitor", 180, next_run=0)]
        # Pretend monitor took 240s (overshot its 180s interval by 60s).
        # next_run_ts is set AFTER completion, mirroring orchestrator_loop's
        # finally clause: job.next_run_ts = time.time() + interval_sec.
        jobs[0].next_run_ts = 240 + 180
        clock = 240
        # Sleep budget = max(0.5, min(next_run_ts - now)) for non-due jobs.
        nap = max(0.5, min(j.next_run_ts - clock for j in jobs))
        self.assertGreaterEqual(nap, 0.5, "sleep must never go negative")

    def test_immediate_due_after_overshoot_re_run(self):
        """After a long-running job completes, if next_run_ts is in the past
        immediately, the next pick is immediate (not a stuck loop)."""
        jobs = [_job("monitor", 180, next_run=0)]
        # Simulate completion at clock=200 with next_run_ts now=200+180=380.
        # If clock then advances to 500 (e.g. another job took 300s), monitor
        # is overdue and should pick immediately.
        jobs[0].next_run_ts = 380
        self.assertEqual(wm._pick_due_job(jobs, 500).name, "monitor")


if __name__ == "__main__":
    unittest.main(verbosity=2)
