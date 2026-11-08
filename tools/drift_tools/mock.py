"""DEV ONLY: fixture mock with synthetic users. Never imported by the real API."""

import copy
import os
import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from drift_api.validation import iso, now, validate, ApiError, timestamp, outline_vertices
from drift_api.geometry import validate_geometry
from drift_api.geometry import distance_m
from drift_api.anonymous import COOKIE, SESSION_DAYS, new_token
from drift_api.streaks import initial_streak, advance, streak_summary, time_zone
from .common import scenarios


def create_mock():
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    clouds: dict[str, Any] = {}
    messages: dict[str, Any] = {}
    initial_anchors: dict[str, Any] = {}
    sequences: dict[str, int] = {}
    batches: dict[str, Any] = {}
    votes: dict[str, bool] = {}
    receipts: dict[tuple, Any] = {}
    held: set[str] = set()
    sessions: dict[str, Any] = {}
    streaks: dict[str, Any] = {}
    profiles: dict[str, Any] = {
        "user_mock": {"id": "user_mock", "displayName": "Dev user (synthetic)", "avatarUrl": None}
    }
    for scenario in scenarios():
        profiles.update({user["id"]: user for user in scenario["meta"]["seed"]["users"]})
        messages.update({msg["id"]: copy.deepcopy(msg) for msg in scenario["meta"]["seed"]["messages"]})
        initial_anchors.update({msg["id"]: dict(msg["anchor"]) for msg in scenario["meta"]["seed"]["messages"]})
    secret = os.getenv("TRACKING_INGEST_SECRET", "dev-only-change-me")

    def error(status, code, message):
        return JSONResponse(
            {"error": {"code": code, "message": message, "requestId": "mock"}}, status_code=status
        )

    def visible(id):
        return sorted(
            [public(msg) for msg in messages.values() if msg["cloudId"] == id and available(msg)],
            key=lambda msg: (-msg["voteCount"], -now_parse(msg["createdAt"]), msg["id"]),
        )

    def available(msg):
        return (
            not msg["expiredAt"]
            and msg["id"] not in held
            and clouds.get(msg["cloudId"], {}).get("status") != "expired"
        )

    def public(msg):
        return {
            **msg,
            "driftDistanceM": distance_m(initial_anchors[msg["id"]], msg["anchor"])
            if msg["id"] in initial_anchors else None,
            "author": profiles.get(
                msg["authorId"], {"id": msg["authorId"], "displayName": None, "avatarUrl": None}
            ),
        }

    def now_parse(value):
        from drift_api.validation import timestamp

        return timestamp(value).timestamp()

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def handle(request: Request, path: str):
        auth, method = request.headers.get("authorization", ""), request.method
        parts = path.split("/")
        cookie_token = request.cookies.get(COOKIE, "")
        session = sessions.get(cookie_token)
        if session and session["expires"] <= now():
            session = None
        principal = "user_mock" if auth.startswith("Bearer ") else session["user"]["id"] if session and session["expires"] > now() else None
        if path == "api/v1/session/anonymous":
            if method == "GET":
                return {"data": session["user"] if session and session["expires"] > now() else None}
            if method == "POST":
                if await request.json() != {}:
                    return error(422, "INVALID", "Empty object required")
                token = cookie_token if session else new_token()
                user = session["user"] if principal and session else {"id": "anon_" + uuid4().hex, "displayName": "Anonymous", "avatarUrl": None, "isAnonymous": True}
                sessions[token] = {"user": user, "expires": now() + timedelta(days=SESSION_DAYS)}
                profiles[str(user["id"])] = {k: user[k] for k in ("id", "displayName", "avatarUrl")}
                response = JSONResponse({"data": user})
                response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", path="/api", secure=request.url.scheme == "https")
                return response
        if path == "api/v1/me/streak" and method == "GET":
            if not principal:
                return error(401, "UNAUTHENTICATED", "Posting session required")
            try:
                zone = time_zone(request.headers.get("x-drift-time-zone"))
            except ApiError as invalid:
                return error(invalid.status, invalid.code, invalid.message)
            row = streaks.setdefault(principal, initial_streak(principal, zone))
            return {"data": streak_summary(row, now(), principal.startswith("anon_"))}
        create = method == "POST" and (
            path == "api/v1/clouds"
            or len(parts) == 5
            and parts[:3] == ["api", "v1", "clouds"]
            and parts[4] == "messages"
        )
        key, digest = request.headers.get("idempotency-key"), None
        receipt_key = (principal, key)
        if create:
            if not principal:
                return error(401, "UNAUTHENTICATED", "Sign in")
            body = await request.json()
            digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            receipt = receipts.get(receipt_key) if key else None
            if receipt and receipt["expires"] > now():
                if receipt["path"] != path or receipt["digest"] != digest:
                    return error(409, "IDEMPOTENCY_CONFLICT", "Retry key already used")
                entity = (
                    clouds.get(receipt["id"]) if receipt["kind"] == "cloud" else messages.get(receipt["id"])
                )
                if not entity or (
                    entity.get("status") == "expired" if receipt["kind"] == "cloud" else not available(entity)
                ):
                    return error(410, "CONTENT_UNAVAILABLE", "Original content unavailable")
                return JSONResponse(
                    {"data": entity if receipt["kind"] == "cloud" else public(entity)}, status_code=201
                )

        def remember(id, kind):
            if key:
                receipts[receipt_key] = {
                    "path": path,
                    "digest": digest,
                    "id": id,
                    "kind": kind,
                    "expires": now() + timedelta(hours=24),
                }

        if path.startswith("api/internal/"):
            if auth != f"Bearer {secret}":
                return error(401, "UNAUTHENTICATED", "Worker secret required")
            if path == "api/internal/tracking/state" and method == "GET":
                ds = request.query_params.get("datasetId", "")
                selected = [c for c in clouds.values() if c["datasetId"] == ds]
                ids = {c["id"] for c in selected}
                return {
                    "data": {
                        "datasetId": ds,
                        "trackingRunId": selected[0]["trackingRunId"]
                        if selected
                        else request.query_params.get("trackingRunId", "regional-v1"),
                        "sequence": sequences.get(ds, 0),
                        "clouds": selected,
                        "messages": [
                            msg for msg in messages.values() if msg["cloudId"] in ids and not msg["expiredAt"]
                        ],
                    },
                    "nextCursor": None,
                }
            if path == "api/internal/tracking/batches" and method == "POST":
                batch = await request.json()
                if batch["batchId"] in batches:
                    return {"data": batches[batch["batchId"]]}
                if batch["sequence"] != sequences.get(batch["datasetId"], 0) + 1:
                    return error(409, "OUT_OF_ORDER", "Wrong sequence")
                for update in batch["anchorUpdates"]:
                    msg = messages.get(update["messageId"])
                    if msg and msg["version"] != update["expectedMessageVersion"]:
                        return error(409, "VERSION_CONFLICT", "Stale message")
                clouds.update({cloud["id"]: cloud for cloud in batch["snapshots"]})
                for update in batch["anchorUpdates"]:
                    msg = messages.get(update["messageId"])
                    if not msg:
                        continue
                    msg["version"] += 1
                    if update["action"] == "move":
                        msg.update(anchor=update["anchor"], cloudId=update["targetCloudId"])
                    if update["action"] == "hold":
                        held.add(msg["id"])
                    else:
                        held.discard(msg["id"])
                    if update["action"] == "expire":
                        msg["expiredAt"] = batch["observedAt"]
                sequences[batch["datasetId"]] = batch["sequence"]
                batches[batch["batchId"]] = {"sequence": batch["sequence"]}
                return {"data": batches[batch["batchId"]]}
        if path == "api/v1/sky" and method == "GET":
            ds = request.query_params.get("datasetId", "")
            return {
                "data": {
                    "clouds": [
                        {"cloud": cloud, "previews": visible(cloud["id"])[:3]}
                        for cloud in clouds.values()
                        if cloud["datasetId"] == ds and cloud["status"] != "expired"
                    ],
                    "asOf": iso(now()),
                    "weather": None,
                    "freshness": "replay",
                },
                "nextCursor": None,
            }
        if path == "api/v1/messages" and method == "GET":
            requested_ids = request.query_params.getlist("id")
            if not 1 <= len(requested_ids) <= 50:
                return error(422, "INVALID", "Supply 1..50 message IDs")
            return {
                "data": [
                    public(msg)
                    for id in dict.fromkeys(requested_ids)
                    if (msg := messages.get(id)) and available(msg)
                ]
            }
        if path == "api/v1/clouds" and method == "POST":
            try:
                validate("CreateCloudRequest", body)
                outline_vertices(body["outline"])
                validate_geometry(body["outline"])
            except ApiError as invalid:
                return error(invalid.status, invalid.code, invalid.message)
            id, ds = str(uuid4()), body.get("datasetId") or os.getenv("DRIFT_DATASET_ID", "troy-demo")
            existing = next((c for c in clouds.values() if c["datasetId"] == ds), None)
            at = existing["updatedAt"] if existing else iso(now())
            cloud = {
                "id": id,
                "version": 1,
                "kind": "created",
                "status": "active",
                "geometry": {"type": "MultiPolygon", "coordinates": [body["outline"]["coordinates"]]},
                "observedAt": at,
                "updatedAt": at,
                "confidence": 0,
                "wind": {
                    "uMps": 0,
                    "vMps": 0,
                    "altitudeM": 2000,
                    "source": "fixture:synthetic",
                    "validAt": at,
                    "confidence": 0,
                },
                "parentIds": [],
                "creatorId": principal,
                "expiresAt": iso(timestamp(at) + timedelta(days=1)),
                "datasetId": ds,
                "trackingRunId": existing["trackingRunId"] if existing else "regional-v1",
            }
            clouds[id] = cloud
            remember(id, "cloud")
            return JSONResponse({"data": cloud}, status_code=201)
        if len(parts) == 4 and parts[:3] == ["api", "v1", "clouds"] and method == "DELETE":
            if not principal:
                return error(401, "UNAUTHENTICATED", "Sign in")
            deleted_cloud = clouds.get(parts[3])
            if not deleted_cloud:
                return error(404, "NOT_FOUND", "Cloud not found")
            if deleted_cloud["kind"] != "created" or deleted_cloud["creatorId"] != principal:
                return error(403, "FORBIDDEN", "Creator only")
            deleted_cloud["status"] = "expired"
            for msg in messages.values():
                if msg["cloudId"] == deleted_cloud["id"]:
                    msg["expiredAt"] = iso(now())
            return {"data": {"id": deleted_cloud["id"], "expired": True}}
        if len(parts) == 4 and parts[:3] == ["api", "v1", "messages"] and method == "DELETE":
            if not principal:
                return error(401, "UNAUTHENTICATED", "Sign in")
            msg = messages.get(parts[3])
            if not msg:
                return error(404, "NOT_FOUND", "Post not found")
            if msg["authorId"] != principal:
                return error(403, "FORBIDDEN", "Author only")
            msg["expiredAt"] = iso(now())
            return {"data": {"id": msg["id"], "expired": True}}
        if len(parts) == 5 and parts[:3] == ["api", "v1", "clouds"] and parts[4] == "messages":
            if method == "GET":
                return {"data": visible(parts[3]), "nextCursor": None}
            if method == "POST":
                if not principal:
                    return error(401, "UNAUTHENTICATED", "Sign in")
                body = await request.json()
                if "authorId" in body:
                    return error(422, "INVALID", "Author is server derived")
                at, id = iso(now()), str(uuid4())
                msg = {
                    "id": id,
                    "version": 1,
                    "cloudId": parts[3],
                    "authorId": principal,
                    "kind": body["kind"],
                    "anchor": body["anchor"],
                    "createdAt": at,
                    "updatedAt": at,
                    "expiredAt": None,
                    "voteCount": 0,
                    "viewerHasUpvoted": False,
                    "body": body.get("body"),
                    "assetId": None,
                    "songUrl": body.get("songUrl"),
                    "artworkTransform": None,
                }
                try:
                    zone = time_zone(request.headers.get("x-drift-time-zone"))
                    streak = advance(streaks.get(principal) or initial_streak(principal, zone), now())
                except ApiError as invalid:
                    return error(invalid.status, invalid.code, invalid.message)
                messages[id] = msg
                initial_anchors[id] = dict(msg["anchor"])
                streaks[principal] = streak
                remember(id, "message")
                return JSONResponse({"data": public(msg)}, status_code=201)
        if (
            len(parts) == 5
            and parts[:3] == ["api", "v1", "messages"]
            and parts[4] == "upvote"
            and method == "PUT"
        ):
            if not principal:
                return error(401, "UNAUTHENTICATED", "Sign in")
            msg = messages.get(parts[3])
            if not msg:
                return error(404, "NOT_FOUND", "Message not found")
            if not auth.startswith("Bearer "):
                return error(401, "UNAUTHENTICATED", "Sign in to vote")
            active = (await request.json())["active"]
            votes[parts[3]] = bool(active)
            msg.update(voteCount=int(active), viewerHasUpvoted=bool(active))
            return {"data": {"voteCount": msg["voteCount"], "viewerHasUpvoted": msg["viewerHasUpvoted"]}}
        return error(404, "NOT_FOUND", "Route not found")

    return app


app = create_mock()
