import copy
import pytest
from drift_api.validation import ApiError, validate
from drift_api.http import create_app
from drift_tools.common import scenarios, validate_fixtures, wind_to_uv, displace_meters, haversine_m, ROOT
from drift_tools.fixtures_gen import write_fixtures
from drift_tools.testing import running_api
from drift_tools.smoke import smoke


def test_generated_fixtures_current():
    assert write_fixtures(check=True) == 25
    assert validate_fixtures() == (8, 17)


def test_shared_geographic_math():
    import json

    for case in json.loads((ROOT / "fixtures/wind-cases.json").read_text())["cases"]:
        assert wind_to_uv(case["speedMps"], case["fromDeg"]) == pytest.approx(case["expected"])
    origin = {"longitude": -73.6918, "latitude": 42.7284}
    moved = displace_meters(origin, 6000, 0)
    assert abs(haversine_m(origin, moved) - 6000) < 1
    assert moved["longitude"] > origin["longitude"]


@pytest.mark.parametrize("case", range(9))
def test_invalid_contract_inputs_rejected(case):
    fixture = next(s for s in scenarios() if s["name"] == "scattered-advection")
    msg = fixture["meta"]["seed"]["messages"][0]
    batch = fixture["batches"][0]["body"]
    created = next(s for s in scenarios() if s["name"] == "created-cloud")["batches"][0]["body"]["snapshots"][
        0
    ]
    cases = [
        ("Message", {**msg, "body": None}),
        ("Message", {**msg, "kind": "song", "body": None, "songUrl": "http://x.test/a"}),
        ("Message", {**msg, "kind": "png", "body": None, "assetId": "a1"}),
        ("TrackingBatch", {**batch, "schemaVersion": 2}),
        ("TrackingBatch", {**batch, "sequence": 0}),
        (
            "AnchorUpdate",
            {
                "messageId": "m",
                "expectedMessageVersion": 1,
                "targetCloudId": None,
                "anchor": {"longitude": -73, "latitude": 42},
                "action": "move",
            },
        ),
        ("Cloud", {**created, "expiresAt": None}),
        (
            "CreateMessageRequest",
            {
                "kind": "text",
                "anchor": {"longitude": -73, "latitude": 42},
                "expectedCloudVersion": 1,
                "body": "x",
                "authorId": "forged",
            },
        ),
        (
            "Asset",
            {
                "id": "a",
                "ownerId": "u",
                "kind": "png",
                "mimeType": "image/png",
                "sizeBytes": 1,
                "state": "ready",
                "createdAt": "2026-01-01T00:00:00Z",
                "objectKey": "private/path",
            },
        ),
    ]
    with pytest.raises(ApiError):
        validate(*copy.deepcopy(cases[case]))


def test_python_smoke_against_real_api_and_mongodb(run, monkeypatch):
    monkeypatch.setenv("TRACKING_INGEST_SECRET", "smoke-worker-only")
    user = {"id": "user_smoke", "displayName": "Synthetic smoke", "avatarUrl": None}

    def identity(required, request):
        return user if request.headers.get("authorization") == "Bearer synthetic-test-only" else None

    with running_api(create_app(identity=identity, run=run)) as base:
        results = smoke(base, "smoke-worker-only", "synthetic-test-only")
    assert len(results) == 9
    assert all(item["status"] == "PASS" for item in results), results
