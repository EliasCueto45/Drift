from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import hashlib

from fastapi.testclient import TestClient
import pytest

from drift_api import database
from drift_api.anonymous import COOKIE
from drift_api.http import create_app
from drift_api.streaks import advance, initial_streak, streak_summary, time_zone
from drift_api.validation import ApiError, timestamp, validate
from drift_tools.common import scenarios


def at(value):
    return datetime.fromisoformat(value).astimezone(UTC)


def body():
    seed = next(s for s in scenarios() if s["name"] == "overcast")["meta"]["seed"]["messages"][0]
    return {"kind": "text", "body": "Hello anonymously", "anchor": seed["anchor"], "expectedCloudVersion": 1}


def app(run):
    def identity(required, request):
        return {"id": "user_alice", "displayName": "Alice", "avatarUrl": None} if request.headers.get("authorization") == "Bearer alice" else None
    return create_app(identity=identity, run=run)


@pytest.mark.parametrize("zone,before,after", [
    ("America/New_York", "2026-11-08T04:59:59+00:00", "2026-11-08T05:00:00+00:00"),
    ("Asia/Tokyo", "2026-11-08T14:59:59+00:00", "2026-11-08T15:00:00+00:00"),
])
def test_local_midnight_daily_credit_gap_and_longest(zone, before, after):
    row = advance(initial_streak("user", zone), at(before))
    row = advance(row, at(before))
    assert row["current_days"] == 1 and row["total_posts"] == 2
    row = advance(row, at(after))
    assert row["current_days"] == 2 and row["posting_days"] == 2
    summary = streak_summary(row, at(after) + timedelta(days=2))
    assert summary["currentDays"] == 0 and summary["longestDays"] == 2
    row = advance(row, at(after) + timedelta(days=2))
    assert row["current_days"] == 1 and row["longest_days"] == 2


@pytest.mark.parametrize("start,hours", [("2026-03-08T05:00:00+00:00", 23), ("2026-11-01T04:00:00+00:00", 25)])
def test_dst_midnight_reset(start, hours):
    clock = at(start)
    row = initial_streak("user", "America/New_York")
    assert timestamp(streak_summary(row, clock)["nextResetAt"]) - clock == timedelta(hours=hours)


def test_invalid_zone_and_backwards_clock():
    with pytest.raises(ApiError):
        time_zone("Invalid/Zone")
    row = advance(initial_streak("user", "UTC"), at("2026-11-08T12:00:00+00:00"))
    with pytest.raises(ApiError):
        advance(row, at("2026-11-07T12:00:00+00:00"))


def test_guest_cookie_ownership_and_public_label(run, mongo):
    with TestClient(app(run)) as guest, TestClient(app(run)) as other:
        assert guest.get("/api/v1/session/anonymous").json() == {"data": None}
        assert guest.get("/api/v1/me/streak").status_code == 401
        first = guest.post("/api/v1/session/anonymous", json={})
        user = validate("AnonymousSessionResponse", first.json())["data"]
        cookie = first.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/api" in cookie
        token = guest.cookies.get(COOKIE)
        assert token not in first.text
        stored = mongo.anonymous_sessions.find_one({})
        assert stored["_id"] == hashlib.sha256(token.encode()).hexdigest()
        assert guest.post("/api/v1/session/anonymous", json={}).json()["data"] == user
        assert guest.get("/api/v1/session/anonymous").json()["data"] == user
        response = guest.post("/api/v1/clouds/cld_overcast/messages", json=body())
        assert response.status_code == 201, response.text
        message = response.json()["data"]
        assert message["author"] == {"id": user["id"], "displayName": "Anonymous", "avatarUrl": None}
        assert not mongo.profiles.find_one({"_id": user["id"]})
        other.post("/api/v1/session/anonymous", json={})
        assert other.delete(f"/api/v1/messages/{message['id']}").status_code == 403
        assert guest.put(f"/api/v1/messages/{message['id']}/upvote", json={"active": True}).status_code == 401
        assert guest.post("/api/v1/assets/upload-url", json={}).status_code == 401
        assert guest.delete(f"/api/v1/messages/{message['id']}").status_code == 200
        assert guest.get("/api/v1/me/streak").json()["data"]["totalPosts"] == 1
        with TestClient(app(run)) as restored:
            restored.cookies.set(COOKIE, token)
            assert restored.get("/api/v1/me/streak").json()["data"]["totalPosts"] == 1


def test_transactional_retry_streak_isolation_and_receipt_clock(run, mongo, monkeypatch):
    clock = [at("2026-11-08T04:59:59+00:00")]
    monkeypatch.setattr(database, "now", lambda: clock[0])
    with TestClient(app(run)) as guest:
        guest.post("/api/v1/session/anonymous", json={})
        headers = {"Idempotency-Key": "one", "X-Drift-Time-Zone": "America/New_York"}
        path = "/api/v1/clouds/cld_overcast/messages"
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda _: guest.post(path, json=body(), headers=headers), range(4)))
        assert all(r.status_code == 201 for r in responses)
        summary = guest.get("/api/v1/me/streak", headers=headers).json()["data"]
        assert summary["totalPosts"] == 1 and summary["currentDays"] == 1
        assert summary["lastPostedOn"] == "2026-11-07"
        clock[0] += timedelta(seconds=1)
        assert guest.post(path, json=body(), headers=headers).status_code == 201
        assert guest.get("/api/v1/me/streak").json()["data"]["postedToday"] is False
        headers.update({"Idempotency-Key": "two", "X-Drift-Time-Zone": "Asia/Tokyo"})
        assert guest.post(path, json=body(), headers=headers).status_code == 201
        summary = guest.get("/api/v1/me/streak").json()["data"]
        assert summary["currentDays"] == 2 and summary["totalPosts"] == 2
        assert summary["timeZone"] == "America/New_York"
        assert summary["lastPostedOn"] == "2026-11-08"
        invalid = guest.post(path, json={**body(), "expectedCloudVersion": 999}, headers={"Idempotency-Key": "bad"})
        assert invalid.status_code == 409
        assert guest.get("/api/v1/me/streak").json()["data"]["totalPosts"] == 2
        assert guest.get("/api/v1/me/streak", headers={"Authorization": "Bearer alice"}).json()["data"]["totalPosts"] == 0
        assert mongo.posting_streaks.count_documents({}) == 2
        assert mongo.posting_streaks.find_one({"_id": "user_alice"}).get("expires_at") is None


def test_https_csrf_expired_cookie_forged_credentials_and_invalid_zone(run, mongo, monkeypatch):
    monkeypatch.setenv("DRIFT_APP_ORIGIN", "https://drift.test")
    with TestClient(create_app(run=run), base_url="https://drift.test") as guest:
        assert guest.post("/api/v1/session/anonymous", json={}, headers={"Origin": "https://evil.test"}).status_code == 403
        response = guest.post("/api/v1/session/anonymous", json={})
        assert "Secure" in response.headers["set-cookie"]
        assert guest.get("/api/v1/me/streak", headers={"Authorization": "Bearer forged"}).status_code == 401
        assert guest.post("/api/v1/clouds/cld_overcast/messages", json=body(), headers={"X-Drift-Time-Zone": "Bad/Zone"}).status_code == 422
        assert mongo.messages.count_documents({"body": body()["body"]}) == 0
        mongo.anonymous_sessions.update_many({}, {"$set": {"expires_at": datetime(2000, 1, 1, tzinfo=UTC)}})
        assert guest.get("/api/v1/session/anonymous").json()["data"] is None
        assert guest.get("/api/v1/me/streak").status_code == 401
        assert guest.post("/api/v1/clouds/cld_overcast/messages", json=body()).status_code == 401


def test_anonymous_created_cloud_ownership_does_not_award_posting_day(run):
    outline = {
        "datasetId": "fx-clear", "assumedAltitudeM": 2000,
        "outline": {"type": "Polygon", "coordinates": [[[-73.69, 42.72], [-73.68, 42.72], [-73.68, 42.73], [-73.69, 42.72]]]},
    }
    with TestClient(app(run)) as guest, TestClient(app(run)) as other:
        principal = guest.post("/api/v1/session/anonymous", json={}).json()["data"]["id"]
        other.post("/api/v1/session/anonymous", json={})
        response = guest.post("/api/v1/clouds", json=outline)
        assert response.status_code == 201, response.text
        cloud = response.json()["data"]
        assert cloud["creatorId"] == principal
        assert guest.get("/api/v1/me/streak").json()["data"]["totalPosts"] == 0
        assert other.delete(f"/api/v1/clouds/{cloud['id']}").status_code == 403
        assert guest.delete(f"/api/v1/clouds/{cloud['id']}").status_code == 200


def test_mock_anonymous_streak_and_isolation():
    from drift_tools.mock import create_mock
    with TestClient(create_mock()) as guest:
        guest.post("/api/v1/session/anonymous", json={})
        headers = {"Idempotency-Key": "one", "X-Drift-Time-Zone": "Asia/Tokyo"}
        path = "/api/v1/clouds/cld_overcast/messages"
        a = guest.post(path, json=body(), headers=headers)
        b = guest.post(path, json=body(), headers=headers)
        assert a.status_code == 201 and a.json() == b.json()
        assert a.json()["data"]["author"]["displayName"] == "Anonymous"
        streak = guest.get("/api/v1/me/streak").json()["data"]
        assert streak["totalPosts"] == 1 and streak["timeZone"] == "Asia/Tokyo"
        assert guest.get("/api/v1/me/streak", headers={"Authorization": "Bearer dev-mock-only"}).json()["data"]["totalPosts"] == 0
