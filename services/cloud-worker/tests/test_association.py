from datetime import timedelta
import numpy as np
from shapely.geometry import MultiPolygon, box
from cloud_worker.association import associate
from cloud_worker.models import Frame, Grid, Track, Region, timestamp
from cloud_worker.motion import fuse, MotionField
from cloud_worker.wind import Wind, WindField

T = timestamp("2026-11-07T12:00:00Z")
G = Grid("EPSG:32618", 600000, 4700000, 1000, 32, 32)


def region(x0, x1):
    return Region(MultiPolygon([box(x0, 4700000, x1, 4704000)]), np.ones(G.shape, bool), 2000)


def frame(at=T):
    return Frame(at, G, np.ones(G.shape, bool), np.ones(G.shape, bool), np.full(G.shape, 2000), "test")


def test_merge_then_split_is_many_to_many_and_deterministic():
    a, b = region(600000, 604000), region(606000, 610000)
    tracks = {key: Track(key, r.geometry, 2000, T, T) for key, r in (("a", a), ("b", b))}
    merged = associate(tracks, [region(600000, 610000)], frame(T+timedelta(minutes=5)), WindField(), "demo", "run")
    assert len(merged.tracks) == 1
    assert set(merged.retired) == {"a", "b"}
    assert merged.successors["a"] == merged.successors["b"]
    split = associate(merged.tracks, [a, b], frame(T+timedelta(minutes=10)), WindField(), "demo", "run")
    assert len(split.tracks) == 2
    assert [e["type"] for e in split.events] == ["split"]
    assert associate(tracks, [region(600000, 610000)], frame(T+timedelta(minutes=5)), WindField(), "demo", "run").events == merged.events


def test_wind_image_disagreement_reduces_confidence():
    aligned = fuse(Wind(10, 0, .8), Wind(10, 0, .8))
    opposite = fuse(Wind(10, 0, .8), Wind(-10, 0, .8))
    assert opposite.confidence < aligned.confidence


def test_flow_measures_image_translation_and_rejects_flat_image():
    rng = np.random.default_rng(42)
    a = frame()
    b = frame(T+timedelta(minutes=5))
    a.image = (rng.random(G.shape)*255).astype(np.float32)
    b.image = np.roll(a.image, 2, axis=1)
    flow = MotionField(WindField(), a, b)
    assert flow.flow is not None
    assert np.median(flow.flow[8:-8, 8:-8, 0]) > 1
    a.image[:] = b.image[:] = 1
    assert MotionField(WindField(), a, b).flow is None
