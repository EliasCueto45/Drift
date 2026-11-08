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
