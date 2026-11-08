from copy import deepcopy
import pytest
from fastapi.testclient import TestClient

from drift_api.geometry import distance_m
from drift_api.http import create_app
from drift_api.records import message_record, public_message
from drift_api.tracking import ingest
from drift_api.validation import ApiError, validate
from drift_tools.common import scenarios


def scenario(name):
    return next(s for s in scenarios() if s["name"] == name)


def test_new_post_origin_survives_movement_and_create_retry(run, mongo):
    data = scenario("scattered-advection")
    seed = data["meta"]["seed"]["messages"][0]
    def identity(required, request):
        return {"id": "user_drift", "displayName": "Drifter", "avatarUrl": None}
    path = f"/api/v1/clouds/{seed['cloudId']}/messages"
    body = {"kind": "text", "body": "Travel with the cloud", "anchor": seed["anchor"], "expectedCloudVersion": 1}
    headers = {"Idempotency-Key": "drift-post"}
    with TestClient(create_app(identity=identity, run=run)) as api:
        created = api.post(path, json=body, headers=headers)
        assert created.status_code == 201
        post = created.json()["data"]
        assert post["driftDistanceM"] == 0
        batch = deepcopy(data["batches"][1]["body"])
        update = deepcopy(next(u for u in batch["anchorUpdates"] if u["messageId"] == seed["id"]))
        update["messageId"] = post["id"]
        batch["anchorUpdates"].append(update)
        run(lambda ctx: ingest(ctx, batch))
        run(lambda ctx: ingest(ctx, batch))
        moved = api.get(f"/api/v1/messages/{post['id']}").json()["data"]
        expected = distance_m(seed["anchor"], update["anchor"])
        assert moved["driftDistanceM"] == pytest.approx(expected)
        assert 5900 < expected < 6100
        validate("Message", moved)
        assert "initial_anchor" not in moved
        stored = mongo.messages.find_one({"_id": post["id"]})
        assert stored["initial_anchor"] == seed["anchor"]
        assert api.post(path, json=body, headers=headers).json()["data"]["driftDistanceM"] == pytest.approx(expected)
        # Reading repeatedly or changing the viewer adds no movement.
        assert api.get(f"/api/v1/messages/{post['id']}").json()["data"]["driftDistanceM"] == moved["driftDistanceM"]
        assert api.get("/api/v1/messages", params={"id": post["id"]}).json()["data"][0]["driftDistanceM"] == moved["driftDistanceM"]
        for latitude in (seed["anchor"]["latitude"], seed["anchor"]["latitude"] + 0.01):
            page = api.get(path, params={"scope": "nearby", "lat": latitude, "lng": update["anchor"]["longitude"], "radiusM": 50000}).json()["data"]
            found = next(p for p in page if p["id"] == post["id"])
            assert found["driftDistanceM"] == moved["driftDistanceM"]


@pytest.mark.parametrize("name", ["merge", "split", "created-cloud"])
def test_distance_uses_post_origin_through_lineage_and_created_cloud_motion(run, name):
    data = scenario(name)
    origins = {m["id"]: m["anchor"] for m in data["meta"]["seed"]["messages"]}
    for entry in data["batches"][1:]:
        run(lambda ctx, batch=entry["body"]: ingest(ctx, batch))
    for id, original in origins.items():
        row = run(lambda ctx, id=id: message_record(ctx, id))
        assert row["initial_anchor"] == original
        result = run(lambda ctx, row=row: public_message(ctx, row))
        if result:
            assert result["driftDistanceM"] == pytest.approx(distance_m(original, result["anchor"]))


def test_legacy_unknown_origin_and_rejected_batch_are_not_fabricated(run, mongo):
    data = scenario("scattered-advection")
    seed = data["meta"]["seed"]["messages"][0]
    mongo.messages.update_one({"_id": seed["id"]}, {"$unset": {"initial_anchor": ""}})
    result = run(lambda ctx: public_message(ctx, message_record(ctx, seed["id"])))
    assert result["driftDistanceM"] is None
    batch = deepcopy(data["batches"][1]["body"])
    batch["anchorUpdates"][0]["expectedMessageVersion"] = 999
    with pytest.raises(ApiError):
        run(lambda ctx: ingest(ctx, batch))
    row = run(lambda ctx: message_record(ctx, seed["id"]))
    assert row["payload"]["anchor"] == seed["anchor"]
    assert run(lambda ctx: public_message(ctx, row))["driftDistanceM"] is None


def test_net_displacement_handles_date_line_and_return_to_origin():
    origin = {"longitude": 179.99, "latitude": 0}
    current = {"longitude": -179.99, "latitude": 0}
    assert 2200 < distance_m(origin, current) < 2300
    assert distance_m(origin, origin) == 0


def test_synthetic_mock_reports_the_same_tracking_displacement(monkeypatch):
    from drift_tools.mock import create_mock
    monkeypatch.setenv("TRACKING_INGEST_SECRET", "drift-test-worker")
    data = scenario("scattered-advection")
    seed = data["meta"]["seed"]["messages"][0]
    with TestClient(create_mock()) as api:
        for entry in data["batches"]:
            response = api.post("/api/internal/tracking/batches", json=entry["body"], headers={"Authorization": "Bearer drift-test-worker"})
            assert response.status_code == 200
        result = api.get("/api/v1/messages", params={"id": seed["id"]}).json()["data"][0]
        assert 5900 < result["driftDistanceM"] < 6100
