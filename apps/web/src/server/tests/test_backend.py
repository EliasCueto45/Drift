import copy
import io
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from pymongo.errors import DuplicateKeyError
from drift_api.http import create_app
from drift_api.mutations import create_message, upvote, delete_message, create_cloud, delete_cloud
from drift_api.records import public_message, message_record, cloud_record
from drift_api.tracking import ingest, tracking_state
from drift_api.discovery import sky_freshness, message_page
from drift_api.pagination import snapshot_page
from drift_api.cleanup import cleanup
from drift_api.storage import inspect_media, upload_url, complete_asset, playback_url
from drift_api.validation import ApiError, now, timestamp, validate, message_input
from drift_tools.common import scenarios, haversine_m

ALICE = {"id": "user_test_alice", "displayName": "Alice", "avatarUrl": None}
BOB = {"id": "user_test_bob", "displayName": "Bob", "avatarUrl": None}


def scenario(name):
    return next(item for item in scenarios() if item["name"] == name)


def posted(run, user=ALICE):
    seed = scenario("scattered-advection")["meta"]["seed"]["messages"][0]
    return run(
        lambda ctx: create_message(
            ctx,
            seed["cloudId"],
            {"kind": "text", "body": "Python note", "anchor": seed["anchor"], "expectedCloudVersion": 1},
            user,
        )
    )["data"]


@pytest.mark.parametrize(
    "name",
    [
        "scattered-advection",
        "overcast",
        "merge",
        "split",
        "dissipation",
        "outage",
        "clear-sky",
        "created-cloud",
    ],
)
def test_all_lifecycle_scenarios(run, name):
    data = scenario(name)
    for entry in data["batches"]:
        batch = entry["body"]
        assert run(lambda ctx, batch=batch: ingest(ctx, batch)) == {"data": {"sequence": batch["sequence"]}}
        assert run(lambda ctx, batch=batch: ingest(ctx, batch)) == {"data": {"sequence": batch["sequence"]}}
    state = run(lambda ctx: tracking_state(ctx, {"datasetId": data["meta"]["datasetId"]}))["data"]
    assert state["sequence"] == data["batches"][-1]["body"]["sequence"]
    expected = data["meta"]["expect"]
    for id in expected.get("expiredCloudIds", []):
        assert run(lambda ctx, id=id: cloud_record(ctx, id))["expired"]
    for id, target in expected.get("messageCloud", {}).items():
        assert run(lambda ctx, id=id: message_record(ctx, id))["cloud_id"] == target
    for id in expected.get("expiredMessageIds", []):
        assert run(lambda ctx, id=id: message_record(ctx, id))["expired_at"]
    if name == "scattered-advection":
        for seed in data["meta"]["seed"]["messages"]:
            row = run(lambda ctx, seed=seed: message_record(ctx, seed["id"]))
            assert abs(haversine_m(seed["anchor"], row["payload"]["anchor"]) - 6000) < 100
    if name == "outage":
        row = run(lambda ctx: message_record(ctx, "msg_out_1"))
        assert row["held"] and not row["expired_at"]
        assert run(lambda ctx: public_message(ctx, row)) is None


def test_transaction_rolls_back_stale_batch(run, mongo):
    batch = copy.deepcopy(scenario("merge")["batches"][1]["body"])
    batch["anchorUpdates"][0]["expectedMessageVersion"] = 999
    with pytest.raises(ApiError) as raised:
        run(lambda ctx: ingest(ctx, batch))
    assert raised.value.code == "VERSION_CONFLICT"
    assert mongo.clouds.find_one({"_id": "cld_mg_a"})["payload"]["status"] == "active"
    assert not mongo.clouds.find_one({"_id": "cld_mg_m"})
    assert not mongo.tracking_batches.find_one({"_id": batch["batchId"]})


def test_desired_votes_concurrency_ownership_expiry(run, mongo):
    message = posted(run)

    def vote(index):
        user = {**ALICE, "id": f"user_voter_{index}"}
        for _ in range(2):
            run(lambda ctx: upvote(ctx, message["id"], {"active": True}, user))

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(vote, range(12)))
    assert mongo.votes.count_documents({"message_id": message["id"]}) == 12
    assert mongo.messages.find_one({"_id": message["id"]})["payload"]["version"] == 1
    with pytest.raises(ApiError) as raised:
        run(lambda ctx: delete_message(ctx, message["id"], BOB))
    assert raised.value.status == 403
    run(lambda ctx: delete_message(ctx, message["id"], ALICE))
    run(lambda ctx: delete_message(ctx, message["id"], ALICE))
    with pytest.raises(ApiError) as raised:
        run(lambda ctx: upvote(ctx, message["id"], {"active": True}, ALICE))
    assert raised.value.status == 410
    assert run(cleanup)["completed"] == 1
    assert not mongo.messages.find_one({"_id": message["id"]})
    assert mongo.votes.count_documents({"message_id": message["id"]}) == 0


def test_unique_indexes_and_cross_dataset_rollback(run, mongo):
    mongo.votes.insert_one({"_id": "a", "message_id": "m", "user_id": "u"})
    with pytest.raises(DuplicateKeyError):
        mongo.votes.insert_one({"_id": "b", "message_id": "m", "user_id": "u"})
    batch = copy.deepcopy(scenario("scattered-advection")["batches"][1]["body"])
    batch["snapshots"][0]["id"] = "cld_overcast"
    with pytest.raises(ApiError) as raised:
        run(lambda ctx: ingest(ctx, batch))
    assert raised.value.code == "DATASET_CONFLICT"
    assert mongo.datasets.find_one({"_id": "fx-scattered"})["sequence"] == 1


def test_cursor_is_frozen_bound_and_expires(run, mongo):
    # Separate documents exceed MongoDB's 16 MiB per-document limit safely.
    values = ["x" * 1000000 for _ in range(18)]
    page = run(lambda ctx: snapshot_page(ctx, "query-a", None, lambda: {"items": values}, 1))
    cursor = page["nextCursor"]
    assert (
        run(lambda ctx: snapshot_page(ctx, "query-a", cursor, lambda: pytest.fail("Snapshot rebuilt"), 1))[
            "items"
        ]
        == values[:1]
    )
    with pytest.raises(ApiError):
        run(lambda ctx: snapshot_page(ctx, "query-b", cursor, lambda: {}, 1))
    mongo.query_snapshots.update_many({}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
    with pytest.raises(ApiError) as raised:
        run(lambda ctx: snapshot_page(ctx, "query-a", cursor, lambda: {}, 1))
    assert raised.value.code == "CURSOR_EXPIRED"


def test_nearby_before_votes_and_stable_pages(run, mongo):
    data = scenario("overcast")["meta"]["seed"]["messages"]
    for i in range(4):
        mongo.votes.insert_one({"_id": str(i), "message_id": data[1]["id"], "user_id": str(i)})
    nearby = run(
        lambda ctx: message_page(
            ctx,
            "cld_overcast",
            {
                "lat": str(data[0]["anchor"]["latitude"]),
                "lng": str(data[0]["anchor"]["longitude"]),
                "radiusM": "1000",
            },
            None,
        )
    )
    assert [item["id"] for item in nearby["data"]] == [data[0]["id"]]
    page = run(lambda ctx: message_page(ctx, "cld_overcast", {"scope": "all", "limit": "1"}, None))
    assert page["data"][0]["id"] == data[1]["id"]
    mongo.votes.delete_many({})
    more = run(
        lambda ctx: message_page(
            ctx, "cld_overcast", {"scope": "all", "limit": "1", "cursor": page["nextCursor"]}, None
        )
    )
    assert more["data"][0]["id"] == data[0]["id"]


def test_worker_state_does_not_expose_author_body(run):
    data = run(lambda ctx: tracking_state(ctx, {"datasetId": "fx-overcast"}))["data"]
    assert data["messages"]
    for message in data["messages"]:
        assert not ({"body", "authorId", "assetId"} & message.keys())
        assert message["positionAt"]


def test_created_cloud_delete_and_logical_expiry(run, mongo, monkeypatch):
    monkeypatch.setenv("DRIFT_DATASET_ID", "fx-clear")
    outline = {
        "type": "Polygon",
        "coordinates": [[[-73.69, 42.72], [-73.68, 42.72], [-73.68, 42.73], [-73.69, 42.72]]],
    }
    created = run(lambda ctx: create_cloud(ctx, {"outline": outline, "assumedAltitudeM": 2000}, ALICE))[
        "data"
    ]
    assert timestamp(created["expiresAt"]) - timestamp(created["updatedAt"]) == timedelta(days=1)
    message = run(
        lambda ctx: create_message(
            ctx,
            created["id"],
            {
                "kind": "text",
                "body": "created",
                "anchor": {"longitude": -73.682, "latitude": 42.722},
                "expectedCloudVersion": 1,
            },
            BOB,
        )
    )["data"]
    with pytest.raises(ApiError):
        run(lambda ctx: delete_cloud(ctx, created["id"], BOB))
    run(lambda ctx: delete_cloud(ctx, created["id"], ALICE))
    assert mongo.messages.find_one({"_id": message["id"]})["expired_at"]
    assert run(lambda ctx: cloud_record(ctx, created["id"]))["expired"]


def test_rate_window_and_invalid_input(run):
    for _ in range(10):
        posted(run)
    with pytest.raises(ApiError) as raised:
        posted(run)
    assert raised.value.status == 429
    with pytest.raises(ApiError):
        message_input(
            {
                "kind": "song",
                "anchor": {"longitude": 0, "latitude": 0},
                "expectedCloudVersion": 1,
                "songUrl": "https://example.com",
            }
        )


def test_png_alpha_metadata_and_audio_duration():
    image = Image.new("RGBA", (3, 2), (23, 44, 55, 78))
    output = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "remove this")
    image.save(output, format="PNG", pnginfo=metadata)
    clean, info = inspect_media(output.getvalue(), {"kind": "png"})
    with Image.open(io.BytesIO(clean)) as result:
        assert result.getpixel((0, 0)) == (23, 44, 55, 78)
        assert not result.info
    assert info["width"] == 3
    for seconds in (1, 61):
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\x00\x00" * 8000 * seconds)
        if seconds == 1:
            assert inspect_media(audio.getvalue(), {"kind": "audio", "mimeType": "audio/wav"})[1][
                "durationSec"
            ] == pytest.approx(1)
        else:
            with pytest.raises(ApiError):
                inspect_media(audio.getvalue(), {"kind": "audio", "mimeType": "audio/wav"})


class FakeS3:
    def __init__(self):
        self.objects, self.failure = {}, False

    def generate_presigned_url(self, operation, **kwargs):
        return "https://storage.test/signed"

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_object(self, **kwargs):
        data = self.objects[kwargs["Key"]]
        return {"Body": io.BytesIO(data), "ContentLength": len(data)}

    def delete_object(self, **kwargs):
        if self.failure:
            raise OSError("Storage offline")
        self.objects.pop(kwargs["Key"], None)


def test_media_completion_immutable_ready_key_and_cleanup_retry(run, mongo, monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "test-bucket")
    s3, output = FakeS3(), io.BytesIO()
    Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(output, format="PNG")
    content = output.getvalue()
    id = run(
        lambda ctx: upload_url(
            ctx, {"kind": "png", "mimeType": "image/png", "sizeBytes": len(content)}, ALICE, s3
        )
    )["data"]["assetId"]
    row = mongo.assets.find_one({"_id": id})
    s3.objects[row["upload_key"]] = content
    with pytest.raises(ApiError):
        run(lambda ctx: complete_asset(ctx, id, BOB, s3))
    assert run(lambda ctx: complete_asset(ctx, id, ALICE, s3))["data"]["state"] == "ready"
    s3.objects[row["upload_key"]] = b"overwritten"
    assert s3.objects[row["object_key"]] == content
    seed = scenario("overcast")["meta"]["seed"]["messages"][0]
    msg = run(
        lambda ctx: create_message(
            ctx,
            "cld_overcast",
            {
                "kind": "png",
                "anchor": seed["anchor"],
                "expectedCloudVersion": 1,
                "assetId": id,
                "artworkTransform": {"widthM": 100, "heightM": 100, "rotationDeg": 0},
            },
            ALICE,
        )
    )["data"]
    assert len(msg["artworkTransform"]["controlPoints"]) == 4
    assert run(lambda ctx: playback_url(ctx, id, None, s3))["data"]["url"]
    run(lambda ctx: delete_message(ctx, msg["id"], ALICE))
    with pytest.raises(ApiError):
        run(lambda ctx: playback_url(ctx, id, None, s3))
    s3.failure = True
    assert run(lambda ctx: cleanup(ctx, lambda: s3))["failed"] == 1
    s3.failure = False
    assert run(lambda ctx: cleanup(ctx, lambda: s3))["completed"] == 1
    assert not s3.objects


def test_http_anonymous_worker_and_private_errors(run, monkeypatch):
    monkeypatch.setenv("TRACKING_INGEST_SECRET", "test-worker-secret")
    with TestClient(create_app(run=run)) as client:
        result = client.get("/api/v1/sky?lat=42.72&lng=-73.69&datasetId=fx-overcast")
        assert result.status_code == 200
        validate("SkyResponse", result.json())
        assert client.post("/api/v1/clouds", json={}).status_code == 401
        assert (
            client.post(
                "/api/v1/clouds", json={}, headers={"Authorization": "Bearer test-worker-secret"}
            ).status_code
            == 401
        )
        assert client.get("/api/internal/tracking/state?datasetId=fx-overcast").status_code == 401
        result = client.get(
            "/api/internal/tracking/state?datasetId=fx-overcast",
            headers={"Authorization": "Bearer test-worker-secret"},
        )
        assert result.status_code == 200
        assert result.json()["data"]["datasetId"] == "fx-overcast"

    def broken(fn):
        raise RuntimeError("PRIVATE_SECRET_AND_BODY")

    with TestClient(create_app(run=broken)) as client:
        result = client.get("/api/v1/sky?lat=42.72&lng=-73.69&datasetId=fx-overcast")
        assert result.status_code == 500 and "PRIVATE_SECRET" not in result.text


def test_http_invalid_json_origin_and_payload_size(run):
    with TestClient(create_app(identity=lambda *_: ALICE, run=run)) as client:
        assert (
            client.post("/api/v1/clouds", json={}, headers={"Origin": "https://evil.test"}).status_code == 403
        )
        assert (
            client.post(
                "/api/v1/clouds", content="{", headers={"Content-Type": "application/json"}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/clouds",
                content="x" * (2 * 1024 * 1024 + 1),
                headers={"Content-Type": "application/json"},
            ).status_code
            == 413
        )


def test_freshness_uses_observation_clock():
    clock = now()
    assert (
        sky_freshness(
            {"mode": "live", "observed_at": clock - timedelta(hours=1), "received_at": clock}, [], clock
        )
        == "stale"
    )
    assert sky_freshness({"mode": "replay", "observed_at": clock}, [], clock) == "replay"


def test_camera_ar_mvp_payloads_keep_geographic_placement(run):
    from drift_api.discovery import sky

    fixture = scenario("overcast")["meta"]["seed"]["messages"][0]
    anchor = fixture["anchor"]
    for kind, fields in [
        ("text", {"body": "A post on the sky"}),
        ("song", {"songUrl": "https://open.spotify.com/track/test"}),
    ]:
        message = run(
            lambda ctx, kind=kind, fields=fields: create_message(
                ctx,
                "cld_overcast",
                {"kind": kind, "anchor": anchor, "expectedCloudVersion": 1, **fields},
                ALICE,
            )
        )["data"]
        assert message["anchor"] == anchor
        assert message["kind"] == kind
    data = run(
        lambda ctx: sky(
            ctx,
            {"datasetId": "fx-overcast", "lat": str(anchor["latitude"]), "lng": str(anchor["longitude"])},
            None,
        )
    )["data"]
    cloud = data["clouds"][0]["cloud"]
    assert cloud["geometry"]["type"] == "MultiPolygon"
    assert cloud["wind"]["altitudeM"] == 2000
    assert cloud["observedAt"] and 0 <= cloud["confidence"] <= 1
    assert data["freshness"] == "replay"
