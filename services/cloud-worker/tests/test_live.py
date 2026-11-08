from datetime import datetime, timezone
import pytest
from cloud_worker.live import acquisition_time, discover, Catalog

NOW = datetime(2026,11,7,23,15,tzinfo=timezone.utc)


def key(product, stamp, channel=""):
    return f"{product}/2026/311/23/OR_{product}-M6{channel}_G19_s{stamp}_e0_c0.nc"


class FakeCatalog:
    base = "https://noaa-goes19.s3.amazonaws.com"
    def keys(self, product, hour):
        if hour.hour != 23:
            return []
        return [key(product,"20263112300000","C13" if product == "ABI-L2-CMIPC" else ""),
                key(product,"20263112305000","C13" if product == "ABI-L2-CMIPC" else ""),
                key(product,"20263112310000","C13" if product == "ABI-L2-CMIPC" else "")]


def test_discovers_current_pairs_and_winds():
    manifest = discover(FakeCatalog(),NOW)
    assert manifest["synthetic"] is False
    assert len(manifest["observations"]) == 2
    assert all({"height","image","wind"} <= set(o) for o in manifest["observations"])
    assert acquisition_time(manifest["observations"][-1]["mask"]).minute == 10


def test_stale_masks_never_turn_into_live_replay():
    with pytest.raises(ValueError,match="no fresh"):
        discover(FakeCatalog(),NOW.replace(hour=1))


def test_missing_wind_is_explicit_and_future_masks_excluded():
    class NoWind(FakeCatalog):
        def keys(self,product,hour):
            return [] if product == "ABI-L2-DMWC" else super().keys(product,hour)
    manifest = discover(NoWind(),NOW.replace(minute=6))
    assert all("wind" not in o for o in manifest["observations"])
    assert acquisition_time(manifest["observations"][-1]["mask"]).minute == 5
    with pytest.raises(ValueError):
        Catalog("example.com")


def test_acquisition_gap_resets_clear_evidence():
    from test_engine import seeded, frame
    from cloud_worker.wind import WindField
    engine = seeded()
    for minute in (5,20,25):
        batch = engine.step(frame(minute,False),WindField())
        assert all(u["action"] != "expire" for u in batch["anchorUpdates"])
    batch = engine.step(frame(30,False),WindField())
    assert all(u["action"] == "expire" for u in batch["anchorUpdates"])


def test_supervisor_retries_download_dns_failure_without_discarding_journal(tmp_path, monkeypatch):
    import json
    from urllib.error import URLError
    from cloud_worker import live
    from cloud_worker.engine import Engine
    from cloud_worker.models import Grid
    from cloud_worker.state import encode

    journal = tmp_path / "journal.json"
    checkpoint = encode(Engine(Grid(**live.GRID), "troy-live", "regional-v1"))
    original = json.dumps({"checkpoint": checkpoint, "pending": {"batch": {"batchId": "keep"}, "nextState": checkpoint}})
    journal.write_text(original)
    monkeypatch.setattr(live, "discover", lambda *_: discover(FakeCatalog(), NOW))
    calls, statuses = [], []

    def run(command, *, propagate_transport_errors):
        assert propagate_transport_errors
        assert journal.read_text() == original
        calls.append(command)
        if len(calls) == 1:
            raise URLError("getaddrinfo failed")
        return 0

    def sleep(_):
        statuses.append(json.loads((tmp_path / "acquisition-status.json").read_text())["status"])
        if len(calls) == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(live, "worker_main", run)
    # Replace only the worker's module binding. Patching time.sleep globally
    # also changes PyMongo background threads in the combined integration suite.
    from types import SimpleNamespace
    monkeypatch.setattr(live, "time", SimpleNamespace(sleep=sleep))
    assert live.main(["--state-dir", str(tmp_path)]) == 0
    assert statuses == ["unavailable", "live"]
    assert not (tmp_path / "acquisition.lock").exists()


def test_supervisor_still_stops_on_nonretryable_worker_failure(tmp_path, monkeypatch):
    from cloud_worker import live

    monkeypatch.setattr(live, "discover", lambda *_: discover(FakeCatalog(), NOW))
    monkeypatch.setattr(live, "worker_main", lambda *a, **kw: 1)
    from types import SimpleNamespace
    monkeypatch.setattr(live, "time", SimpleNamespace(sleep=lambda _: pytest.fail("fatal error must not retry")))
    assert live.main(["--state-dir", str(tmp_path)]) == 1


def test_live_coverage_grows_around_content_and_preserves_pending_checkpoint(tmp_path):
    import json
    from cloud_worker.live import coverage_grid
    from cloud_worker.engine import Engine
    from cloud_worker.models import Grid, Parcel
    from cloud_worker.state import encode

    g = Grid("EPSG:32618", 580000, 4710000, 1000, 64, 64)
    e = Engine(g, "troy-live", "regional-v1")
    e.parcels["post"] = Parcel("post", "cloud", 628429, 4701161)
    next_state = encode(e)
    # Pending transport retries may already have expanded beyond the committed grid.
    next_state["grid"] = {"crs":g.crs,"x0":516000,"y0":4646000,"cell_m":1000,"width":192,"height":192}
    journal = {"checkpoint": encode(e), "pending": {"nextState": next_state}}
    path = tmp_path / "journal.json"
    original = json.dumps(journal)
    path.write_text(original)
    grown = Grid(**coverage_grid(tmp_path))
    assert grown.cell(628429, 4701161-32000) is not None
    assert grown.x0 <= 516000 and grown.y0 <= 4646000
    assert path.read_text() == original
    with pytest.raises(ValueError, match="coverage budget"):
        coverage_grid(tmp_path, max_axis_cells=128)


def test_last_known_export_uses_acknowledged_state_not_pending_batch(tmp_path):
    import json
    from cloud_worker.live import write_last_known_sky
    from cloud_worker.state import encode
    from cloud_worker.wind import WindField
    from test_engine import seeded, frame

    engine = seeded()
    engine.step(frame(5), WindField())
    committed = encode(engine)
    engine.step(frame(10), WindField())
    journal = {"checkpoint": committed, "pending": {"nextState": encode(engine)}}
    original = json.dumps(journal)
    (tmp_path / "journal.json").write_text(original)
    write_last_known_sky(tmp_path, engine.dataset_id, engine.run_id)
    saved = json.loads((tmp_path / "last-known-sky.json").read_text())
    assert saved["asOf"] == committed["previous"]["observedAt"]
    assert saved["clouds"][0]["version"] == 2
    assert "parcels" not in saved and "pending" not in saved and "messages" not in saved
    assert (tmp_path / "journal.json").read_text() == original
