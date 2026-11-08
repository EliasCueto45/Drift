import copy
import json
from datetime import timedelta

from fastapi.testclient import TestClient
from drift_api.http import create_app
from drift_api.validation import iso, now
from drift_tools.common import scenarios
from pymongo.errors import ServerSelectionTimeoutError


def saved_clouds(tmp_path, monkeypatch):
    source = next(s for s in scenarios() if s["name"] == "scattered-advection")
    clouds = copy.deepcopy(source["batches"][0]["body"]["snapshots"])
    for cloud in clouds:
        cloud["datasetId"] = "test-live"
    path = tmp_path / "last-known.json"
    path.write_text(json.dumps({"datasetId": "test-live", "asOf": clouds[0]["observedAt"], "clouds": clouds}))
    monkeypatch.setenv("DRIFT_SKY_FALLBACK_FILE", str(path))
    return path, clouds


def test_cached_sky_survives_db_failure_without_identity_or_transaction(tmp_path, monkeypatch):
    saved_clouds(tmp_path, monkeypatch)

    def unavailable(*args):
        raise AssertionError("fallback must not access identity or Atlas")

    with TestClient(create_app(identity=unavailable, run=unavailable)) as api:
        url = "/api/v1/sky?lastKnown=1&datasetId=test-live&lat=42.73&lng=-73.68&radiusM=50000"
        for _ in range(2):
            response = api.get(url)
            assert response.status_code == 200
            data = response.json()["data"]
            assert data["freshness"] == "stale" and data["clouds"]
            assert all(item["previews"] == [] for item in data["clouds"])
            assert response.headers["cache-control"] == "private, no-store"
            assert response.headers["x-drift-sky-source"] == "last-known"
        assert api.get(url.replace("test-live", "other-live")).status_code == 503
        assert api.get(url.replace("radiusM=50000", "radiusM=999999")).status_code == 422


def test_fallback_filters_distance_expiry_and_corrupt_files(tmp_path, monkeypatch):
    path, clouds = saved_clouds(tmp_path, monkeypatch)
    clouds[0]["expiresAt"] = iso(now()-timedelta(hours=1))
    path.write_text(json.dumps({"datasetId": "test-live", "asOf": clouds[0]["observedAt"], "clouds": clouds}))
    with TestClient(create_app()) as api:
        url = "/api/v1/sky?lastKnown=1&datasetId=test-live&lat=42.73&lng=-73.68&radiusM=50000"
        data = api.get(url).json()["data"]
        assert clouds[0]["id"] not in {c["cloud"]["id"] for c in data["clouds"]}
        far = api.get(url.replace("lat=42.73&lng=-73.68", "lat=0&lng=0"))
        assert far.json()["data"]["clouds"] == []
        path.write_text("not json")
        assert api.get(url).status_code == 503


def test_normal_sky_read_falls_back_on_mongodb_outage(tmp_path, monkeypatch):
    saved_clouds(tmp_path, monkeypatch)

    def offline(fn):
        raise ServerSelectionTimeoutError("test database unavailable")

    with TestClient(create_app(identity=lambda *_: None, run=offline)) as api:
        response = api.get("/api/v1/sky?datasetId=test-live&lat=42.73&lng=-73.68&radiusM=50000")
        assert response.status_code == 200
        assert response.json()["data"]["freshness"] == "stale"
        assert response.json()["data"]["clouds"]
        assert response.headers["x-drift-sky-source"] == "last-known"
