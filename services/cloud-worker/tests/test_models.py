from datetime import timedelta
import pytest
from cloud_worker.models import Grid, ClearEvidence, timestamp


def test_timestamps_and_grid_validation():
    assert timestamp("2026-11-07T12:00:00-05:00").hour == 17
    with pytest.raises(ValueError):
        timestamp("2026-11-07T12:00:00")
    with pytest.raises(ValueError):
        Grid("EPSG:4326", 0, 0, 1000, 20, 20)


def test_clear_evidence_needs_distinct_frames_and_duration():
    evidence = ClearEvidence()
    t = timestamp("2026-11-07T12:00:00Z")
    assert not evidence.observe(t, True)
    assert not evidence.observe(t, True)
    assert not evidence.observe(t + timedelta(minutes=5), True)
    assert evidence.observe(t + timedelta(minutes=10), True)
    evidence.observe(t + timedelta(minutes=15), False)
    assert evidence.count == 0
