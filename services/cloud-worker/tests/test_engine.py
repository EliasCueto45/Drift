from datetime import timedelta
import numpy as np
from shapely.geometry import MultiPolygon, box
from cloud_worker.engine import Engine
from cloud_worker.models import Grid, Frame, Track, Parcel, timestamp
from cloud_worker.wind import WindField
import pytest

T = timestamp("2026-11-07T12:00:00Z")
G = Grid("EPSG:32618", 600000, 4700000, 1000, 16, 16)


def frame(minutes=0, cloudy=True, valid=True):
    return Frame(T+timedelta(minutes=minutes), G, np.full(G.shape, cloudy),
                 np.full(G.shape, valid), np.full(G.shape, 2000), "synthetic")


def seeded():
    e = Engine(G, "demo", "run")
    e.tracks["a"] = Track("a", MultiPolygon([box(600000, 4700000, 616000, 4716000)]), 2000, T, T)
    e.parcels["left"] = Parcel("left", "a", 602000, 4702000)
    e.parcels["right"] = Parcel("right", "a", 614000, 4714000, control_points=[(613000, 4713000)])
    return e


def test_outage_does_not_delete_and_resets_consecutive_evidence():
    e = seeded()
    for minute, valid in ((5, True), (10, False), (15, True), (20, True)):
        batch = e.step(frame(minute, False, valid), WindField())
        assert all(u["action"] != "expire" for u in batch["anchorUpdates"])
    batch = e.step(frame(25, False), WindField())
    assert all(u["action"] == "expire" for u in batch["anchorUpdates"])
    assert not e.parcels


def test_overcast_keeps_distinct_anchors_and_artwork():
    e = seeded()
    batch = e.step(frame(5), WindField())
    assert len(batch["anchorUpdates"]) == 2
    assert e.parcels["right"].x - e.parcels["left"].x == 12000
    assert len(batch["anchorUpdates"][1]["artworkControlPoints"]) == 1


def test_split_transfers_each_parcel_once():
    e = seeded()
    f = frame(5)
    f.cloudy[:, 7:9] = False
    batch = e.step(f, WindField())
    assert len({p.cloud_id for p in e.parcels.values()}) == 2
    assert len(batch["anchorUpdates"]) == 2
    assert all(u["action"] == "move" for u in batch["anchorUpdates"])


def test_created_cloud_expires_independently_and_never_merges():
    e = seeded()
    e.tracks["a"].kind = "created"
    e.tracks["a"].creator_id = "user"
    e.tracks["a"].expires_at = T+timedelta(hours=24)
    batch = e.step(frame(5), WindField())
    assert len(batch["snapshots"]) == 2  # synthetic + observed overcast
    assert e.parcels["left"].cloud_id == "a"
    batch = e.step(frame(24*60), WindField())
    assert all(u["action"] == "expire" for u in batch["anchorUpdates"])


def test_expanded_satellite_coverage_recovers_held_anchor_without_snapping():
    from cloud_worker.wind import Wind

    class SouthWind:
        def at(self, *args):
            return Wind(0, -10, 1, 2000, "synthetic-wind", T)

    e = seeded()
    e.previous = frame()
    first = e.step(frame(5), SouthWind())
    assert next(u for u in first["anchorUpdates"] if u["messageId"] == "left")["action"] == "hold"
    outside = (e.parcels["left"].x, e.parcels["left"].y)
    assert G.cell(*outside) is None
    bigger = Grid(G.crs, G.x0-8000, G.y0-8000, G.cell_m, 32, 32)
    observed = Frame(T+timedelta(minutes=10), bigger, np.ones(bigger.shape, bool),
                     np.ones(bigger.shape, bool), np.full(bigger.shape, 2000), "synthetic-overcast")
    batch = e.step(observed, SouthWind())
    parcel = e.parcels["left"]
    assert next(u for u in batch["anchorUpdates"] if u["messageId"] == "left")["action"] == "move"
    assert parcel.cloud_id == "a" and "left" not in e.pending
    assert parcel.y < outside[1]  # It kept drifting; it was not snapped back inside the old crop.
    assert G.cell(parcel.x, parcel.y) is None
    assert bigger.cell(parcel.x, parcel.y) is not None
    assert e.sequence == 2 and e.tracks["a"].version == 3


@pytest.mark.parametrize("grid", [
    Grid(G.crs, G.x0+1000, G.y0, G.cell_m, 32, 32),
    Grid(G.crs, G.x0-500, G.y0, G.cell_m, 32, 32),
    Grid(G.crs, G.x0, G.y0, G.cell_m/2, 32, 32),
    Grid("EPSG:32619", G.x0, G.y0, G.cell_m, 32, 32),
])
def test_coverage_growth_rejects_shift_reprojection_or_resolution_change(grid):
    e = seeded()
    with pytest.raises(ValueError, match="only expand"):
        e.expand_grid(grid)
    assert e.grid == G
