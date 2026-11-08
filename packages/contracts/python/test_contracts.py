import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drift_contracts import ROOT, validate, wind_to_uv  # noqa: E402

SCEN = sorted((ROOT / "fixtures/scenarios").iterdir())


def test_every_batch_and_seed_message_validates():
    n = 0
    for d in SCEN:
        meta = json.loads((d / "scenario.json").read_text())
        for f in meta["batches"]:
            assert validate("TrackingBatch", json.loads((d / f).read_text())) == [], f"{d.name}/{f}"
            n += 1
        for m in meta["seed"]["messages"]:
            assert validate("Message", m) == [], f"{d.name}/{m['id']}"
    assert n >= 8


def test_wind_cases_match_shared_conventions():
    cases = json.loads((ROOT / "fixtures/wind-cases.json").read_text())["cases"]
    for c in cases:
        u, v = wind_to_uv(c["speedMps"], c["fromDeg"])
        assert math.isclose(u, c["expected"]["uMps"], abs_tol=1e-9), c["name"]
        assert math.isclose(v, c["expected"]["vMps"], abs_tol=1e-9), c["name"]


def test_bad_inputs_rejected():
    assert validate("TrackingBatch", {"schemaVersion": 2})
    assert validate("Asset", {"id": "a", "ownerId": "u", "kind": "png", "mimeType": "image/png", "sizeBytes": 1,
                              "state": "ready", "createdAt": "2026-01-01T00:00:00Z", "objectKey": "secret"})
