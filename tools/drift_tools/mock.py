"""DEV ONLY: fixture mock with synthetic users. Never imported by the real API."""

import copy
import os
from typing import Any
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from drift_api.validation import iso, now
from .common import scenarios


def create_mock():
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    clouds: dict[str, Any] = {}
    messages: dict[str, Any] = {}
    sequences: dict[str, int] = {}
    batches: dict[str, Any] = {}
    votes: dict[str, bool] = {}
    for scenario in scenarios():
        messages.update({msg["id"]: copy.deepcopy(msg) for msg in scenario["meta"]["seed"]["messages"]})
    secret = os.getenv("TRACKING_INGEST_SECRET", "dev-only-change-me")

    def error(status, code, message):
        return JSONResponse(
            {"error": {"code": code, "message": message, "requestId": "mock"}}, status_code=status
        )

    def visible(id):
        return sorted(
            [msg for msg in messages.values() if msg["cloudId"] == id and not msg["expiredAt"]],
            key=lambda msg: (-msg["voteCount"], -now_parse(msg["createdAt"]), msg["id"]),
        )

    def now_parse(value):
        from drift_api.validation import timestamp

        return timestamp(value).timestamp()

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def handle(request: Request, path: str):
        auth, method = request.headers.get("authorization", ""), request.method
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
        parts = path.split("/")
        if len(parts) == 5 and parts[:3] == ["api", "v1", "clouds"] and parts[4] == "messages":
            if method == "GET":
                return {"data": visible(parts[3]), "nextCursor": None}
            if method == "POST":
                if not auth.startswith("Bearer "):
                    return error(401, "UNAUTHENTICATED", "Sign in")
                body = await request.json()
                if "authorId" in body:
                    return error(422, "INVALID", "Author is server derived")
                at, id = iso(now()), str(uuid4())
                msg = {
                    "id": id,
                    "version": 1,
                    "cloudId": parts[3],
                    "authorId": "user_mock",
                    "kind": body["kind"],
                    "anchor": body["anchor"],
                    "createdAt": at,
                    "updatedAt": at,
                    "expiredAt": None,
                    "voteCount": 0,
                    "viewerHasUpvoted": False,
                    "body": body.get("body"),
                    "assetId": None,
                    "songUrl": None,
                    "artworkTransform": None,
                }
                messages[id] = msg
                return JSONResponse({"data": msg}, status_code=201)
        if (
            len(parts) == 5
            and parts[:3] == ["api", "v1", "messages"]
            and parts[4] == "upvote"
            and method == "PUT"
        ):
            if not auth.startswith("Bearer "):
                return error(401, "UNAUTHENTICATED", "Sign in")
            msg = messages.get(parts[3])
            if not msg:
                return error(404, "NOT_FOUND", "Message not found")
            active = (await request.json())["active"]
            votes[parts[3]] = bool(active)
            msg.update(voteCount=int(active), viewerHasUpvoted=bool(active))
            return {"data": {"voteCount": msg["voteCount"], "viewerHasUpvoted": msg["viewerHasUpvoted"]}}
        return error(404, "NOT_FOUND", "Route not found")

    return app


app = create_mock()
