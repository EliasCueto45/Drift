from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4
from fastapi.testclient import TestClient
import pytest
from drift_api.http import create_app
from drift_api.validation import validate, now
from drift_api.tracking import ingest
from drift_tools.common import scenarios

ALICE = {"id": "user_alice", "displayName": "Alice", "avatarUrl": None}
BOB = {"id": "user_bob", "displayName": "Bob", "avatarUrl": None}


def client(run):
    def identity(required, request):
        return {"Bearer alice": ALICE, "Bearer bob": BOB}.get(request.headers.get("authorization"))

    return TestClient(create_app(identity=identity, run=run))


def post_body():
    seed = next(s for s in scenarios() if s["name"] == "overcast")["meta"]["seed"]["messages"][0]
    return {"kind": "text", "body": "Retry-safe post", "anchor": seed["anchor"], "expectedCloudVersion": 1}


def headers(key="test-key", user="alice"):
    return {"Authorization": f"Bearer {user}", "Idempotency-Key": key}


def test_concurrent_retries_make_one_post_and_one_rate_charge(run, mongo):
    with client(run) as api:

        def post(_):
            return api.post("/api/v1/clouds/cld_overcast/messages", json=post_body(), headers=headers())

        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(post, range(8)))
        assert all(r.status_code == 201 for r in responses)
        ids = {r.json()["data"]["id"] for r in responses}
        assert len(ids) == 1
        assert mongo.messages.count_documents({"author_id": ALICE["id"]}) == 1
        assert mongo.create_receipts.count_documents({}) == 1
        assert mongo.rate_windows.find_one({"user_id": ALICE["id"], "action": "post"})["count"] == 1
        receipt = mongo.create_receipts.find_one({})
        assert not ({"body", "payload", "response", "anchor"} & receipt.keys())
        assert 23 * 3600 < (receipt["expires_at"] - now()).total_seconds() <= 24 * 3600


def test_retry_key_binding_scope_failure_and_expiry(run, mongo):
    path = "/api/v1/clouds/cld_overcast/messages"
    with client(run) as api:
        first = api.post(path, json=post_body(), headers=headers())
        altered = {**post_body(), "body": "Another request"}
        assert api.post(path, json=altered, headers=headers()).status_code == 409
        assert (
            api.post("/api/v1/clouds/another/messages", json=post_body(), headers=headers()).status_code
            == 409
        )
        other = api.post(path, json=post_body(), headers=headers(user="bob"))
        assert other.status_code == 201 and other.json()["data"]["id"] != first.json()["data"]["id"]
        assert api.post(path, json=post_body(), headers=headers("contains spaces")).status_code == 422
        invalid = {**post_body(), "expectedCloudVersion": 999}
        assert api.post(path, json=invalid, headers=headers("failed-attempt")).status_code == 409
        assert api.post(path, json=post_body(), headers=headers("failed-attempt")).status_code == 201
        mongo.create_receipts.update_many({}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
        renewed = api.post(path, json=post_body(), headers=headers())
        assert renewed.status_code == 201 and renewed.json()["data"]["id"] != first.json()["data"]["id"]


def test_deleted_receipt_never_resurrects_post_even_after_cleanup(run, mongo):
    path = "/api/v1/clouds/cld_overcast/messages"
    with client(run) as api:
        message = api.post(path, json=post_body(), headers=headers()).json()["data"]
        assert api.delete(f"/api/v1/messages/{message['id']}", headers=headers(user="bob")).status_code == 403
        assert api.delete(f"/api/v1/messages/{message['id']}", headers=headers()).status_code == 200
        assert api.post(path, json=post_body(), headers=headers()).status_code == 410
        mongo.messages.delete_one({"_id": message["id"]})
        assert api.post(path, json=post_body(), headers=headers()).status_code == 410
        assert not mongo.messages.find_one({"_id": message["id"]})


def test_lost_response_retry_survives_tracking_version_change(run, mongo):
    path = "/api/v1/clouds/cld_overcast/messages"
    with client(run) as api:
        original = api.post(path, json=post_body(), headers=headers()).json()["data"]
        batch = next(s for s in scenarios() if s["name"] == "overcast")["batches"][1]["body"]
        run(lambda ctx: ingest(ctx, batch))
        retry = api.post(path, json=post_body(), headers=headers())
        assert retry.status_code == 201 and retry.json()["data"]["id"] == original["id"]
        assert mongo.messages.count_documents({"author_id": ALICE["id"]}) == 1


def test_development_mock_supports_the_connected_ui_flows():
    from drift_tools.mock import create_mock

    body = {
        "datasetId": "fx-clear",
        "assumedAltitudeM": 2000,
        "outline": {
            "type": "Polygon",
            "coordinates": [[[-73.69, 42.72], [-73.68, 42.72], [-73.68, 42.73], [-73.69, 42.72]]],
        },
    }
    auth = {"Authorization": "Bearer dev-mock-only", "Idempotency-Key": "cloud"}
    with TestClient(create_mock()) as api:
        response = api.post("/api/v1/clouds", json=body, headers=auth)
        assert response.status_code == 201
        cloud = validate("Cloud", response.json()["data"])
        assert api.post("/api/v1/clouds", json=body, headers=auth).json()["data"]["id"] == cloud["id"]
        post = {
            "kind": "song",
            "songUrl": "https://open.spotify.com/track/test",
            "anchor": {"longitude": -73.682, "latitude": 42.722},
            "expectedCloudVersion": 1,
        }
        route = f"/api/v1/clouds/{cloud['id']}/messages"
        post_auth = {**auth, "Idempotency-Key": "post"}
        message = api.post(route, json=post, headers=post_auth).json()["data"]
        validate("Message", message)
        assert message["songUrl"] == post["songUrl"] and message["author"]["displayName"]
        assert api.post(route, json=post, headers=post_auth).json()["data"]["id"] == message["id"]
        assert len(api.get("/api/v1/messages", params={"id": message["id"]}).json()["data"]) == 1
        assert api.delete(f"/api/v1/clouds/{cloud['id']}", headers=auth).status_code == 200
        assert api.get("/api/v1/messages", params={"id": message["id"]}).json()["data"] == []
        assert api.post(route, json=post, headers=post_auth).status_code == 410


def test_cloud_creation_uses_displayed_dataset_and_creator_deletion(run, mongo, monkeypatch):
    monkeypatch.setenv("DRIFT_DATASET_ID", "fx-overcast")
    body = {
        "datasetId": "fx-clear",
        "assumedAltitudeM": 2000,
        "outline": {
            "type": "Polygon",
            "coordinates": [[[-73.69, 42.72], [-73.68, 42.72], [-73.68, 42.73], [-73.69, 42.72]]],
        },
    }
    with client(run) as api:
        first = api.post("/api/v1/clouds", json=body, headers=headers()).json()["data"]
        validate("Cloud", first)
        retry = api.post("/api/v1/clouds", json=body, headers=headers()).json()["data"]
        assert first["id"] == retry["id"] and first["datasetId"] == "fx-clear"
        assert api.delete(f"/api/v1/clouds/{first['id']}", headers=headers(user="bob")).status_code == 403
        assert api.delete(f"/api/v1/clouds/{first['id']}", headers=headers()).status_code == 200
        assert api.delete(f"/api/v1/clouds/{first['id']}", headers=headers()).status_code == 200
        assert api.post("/api/v1/clouds", json=body, headers=headers()).status_code == 410
        assert mongo.clouds.count_documents({"payload.creatorId": ALICE["id"]}) == 1
        assert (
            api.post(
                "/api/v1/clouds", json={**body, "datasetId": "not-provisioned"}, headers=headers(str(uuid4()))
            ).status_code
            == 409
        )


def test_public_author_and_lifecycle_lookup(run, mongo):
    with client(run) as api:
        message = api.post(
            "/api/v1/clouds/cld_overcast/messages", json=post_body(), headers=headers()
        ).json()["data"]
        assert message["author"] == ALICE
        mongo.profiles.update_one(
            {"_id": ALICE["id"]},
            {"$set": {"public_profile.email": "PRIVATE", "public_profile.location": "PRIVATE"}},
        )
        result = api.get("/api/v1/messages", params=[("id", message["id"]), ("id", "unknown")])
        assert result.status_code == 200 and len(result.json()["data"]) == 1
        validate("MessagesResponse", {**result.json(), "nextCursor": None})
        assert "PRIVATE" not in result.text and result.json()["data"][0]["author"] == ALICE
        assert api.get("/api/v1/messages", params=[("id", str(i)) for i in range(51)]).status_code == 422
        assert api.get("/api/v1/messages").status_code == 422
        api.delete(f"/api/v1/messages/{message['id']}", headers=headers())
        assert api.get(f"/api/v1/messages/{message['id']}").status_code == 410
        assert api.get("/api/v1/messages", params={"id": message["id"]}).json()["data"] == []


@pytest.mark.parametrize(
    "name,id", [("split", "msg_sp_l"), ("outage", "msg_out_1"), ("dissipation", "msg_ds_1")]
)
def test_lookup_follows_transport_hold_and_expiry(run, name, id):
    scenario = next(s for s in scenarios() if s["name"] == name)
    for entry in scenario["batches"][1:]:
        run(lambda ctx, body=entry["body"]: ingest(ctx, body))
    with client(run) as api:
        messages = api.get("/api/v1/messages", params={"id": id}).json()["data"]
        if name == "split":
            assert messages[0]["cloudId"] == "cld_sp_s1" and messages[0]["version"] == 2
        else:
            assert messages == []
