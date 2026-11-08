import os
from datetime import timedelta
from uuid import uuid4

from .auth import rate_limit
from .database import collection, dataset_time
from .geometry import artwork_corners, distance_m, point_geometry, validate_geometry
from .records import (
    active_cloud,
    cloud_record,
    contains,
    expire_message,
    message_record,
    public_message,
    save_cloud,
)
from .validation import (
    compact,
    exact,
    fail,
    iso,
    message_input,
    outline_vertices,
    require,
    timestamp,
    validate,
)


def create_message(ctx, cloud_id, value, user):
    message_input(value)
    cloud = active_cloud(ctx, cloud_id, value["expectedCloudVersion"])
    contains(ctx, cloud_id, value["anchor"])
    rate_limit(ctx, user["id"], "post", 10)
    asset = None
    if value.get("assetId"):
        asset = collection(ctx, "assets").find_one({"_id": value["assetId"]})
        require(asset and asset["owner_id"] == user["id"], "Owned asset required", "FORBIDDEN", 403)
        require(
            asset["payload"]["state"] == "ready"
            and asset["payload"]["kind"] == value["kind"]
            and not asset.get("attached_message_id"),
            "Ready unused asset of matching kind required",
        )
    at, id = iso(cloud["ds"]["clock"]), str(uuid4())
    artwork = dict(value["artworkTransform"]) if value.get("artworkTransform") else None
    if artwork:
        artwork["controlPoints"] = artwork_corners(value["anchor"], artwork)
    message = validate(
        "Message",
        {
            "id": id,
            "version": 1,
            "cloudId": cloud_id,
            "authorId": user["id"],
            "kind": value["kind"],
            "anchor": value["anchor"],
            "createdAt": at,
            "updatedAt": at,
            "expiredAt": None,
            "voteCount": 0,
            "viewerHasUpvoted": False,
            "body": value.get("body"),
            "assetId": value.get("assetId"),
            "songUrl": value.get("songUrl"),
            "artworkTransform": artwork,
        },
    )
    collection(ctx, "messages").insert_one(
        {
            "_id": id,
            "id": id,
            "cloud_id": cloud_id,
            "author_id": user["id"],
            "asset_id": value.get("assetId"),
            "payload": message,
            "anchor": point_geometry(value["anchor"]),
            "strokes": value.get("strokes"),
            "position_at": timestamp(at),
            "expired_at": None,
            "held": False,
        }
    )
    if asset:
        collection(ctx, "assets").update_one({"_id": asset["id"]}, {"$set": {"attached_message_id": id}})
    return {"data": message}


def delete_message(ctx, id, user):
    row = message_record(ctx, id)
    require(row["author_id"] == user["id"], "Author only", "FORBIDDEN", 403)
    cloud = cloud_record(ctx, row["cloud_id"])
    expire_message(ctx, id, iso(cloud["ds"]["clock"]))
    return {"data": {"id": id, "expired": True}}


def upvote(ctx, id, value, user):
    exact(value, ["active"])
    require(type(value.get("active")) is bool, "active must be boolean")
    row = message_record(ctx, id)
    if not public_message(ctx, row, user["id"]):
        fail(410, "CLOUD_EXPIRED", "Message unavailable")
    votes = collection(ctx, "votes")
    existing = votes.find_one({"message_id": id, "user_id": user["id"]})
    if bool(existing) != value["active"]:
        rate_limit(ctx, user["id"], "vote", 60)
        if value["active"]:
            votes.insert_one({"_id": compact([id, user["id"]]), "message_id": id, "user_id": user["id"]})
        else:
            votes.delete_one({"message_id": id, "user_id": user["id"]})
    message = public_message(ctx, row, user["id"])
    return {"data": {"voteCount": message["voteCount"], "viewerHasUpvoted": message["viewerHasUpvoted"]}}


def create_cloud(ctx, value, user):
    exact(value, ["outline", "assumedAltitudeM"])
    validate("CreateCloudRequest", value)
    vertices = outline_vertices(value["outline"])
    validate_geometry(value["outline"])
    for lon, lat in vertices:
        for lng, latitude in vertices:
            require(
                distance_m({"longitude": lon, "latitude": lat}, {"longitude": lng, "latitude": latitude})
                <= 10000,
                "Outline diameter exceeds 10 km",
            )
    ds_id = os.getenv("DRIFT_DATASET_ID")
    if not ds_id:
        fail(503, "NOT_CONFIGURED", "DRIFT_DATASET_ID required")
    ds = dataset_time(ctx, ds_id)
    if not ds:
        fail(409, "DATASET_NOT_READY", "Initialize dataset before creating clouds")
    rate_limit(ctx, user["id"], "post", 10)
    at = iso(ds["clock"])
    cloud = validate(
        "Cloud",
        {
            "id": str(uuid4()),
            "version": 1,
            "kind": "created",
            "status": "active",
            "geometry": {"type": "MultiPolygon", "coordinates": [value["outline"]["coordinates"]]},
            "observedAt": at,
            "updatedAt": at,
            "confidence": 0,
            "wind": {
                "uMps": 0,
                "vMps": 0,
                "altitudeM": 2000,
                "source": "estimated:awaiting-wind",
                "validAt": at,
                "confidence": 0,
            },
            "parentIds": [],
            "creatorId": user["id"],
            "expiresAt": iso(ds["clock"] + timedelta(days=1)),
            "datasetId": ds_id,
            "trackingRunId": ds["run_id"],
        },
    )
    save_cloud(ctx, cloud)
    return {"data": cloud}


def delete_cloud(ctx, id, user):
    cloud = cloud_record(ctx, id)
    require(
        cloud["payload"]["kind"] == "created" and cloud["payload"]["creatorId"] == user["id"],
        "Created cloud creator only",
        "FORBIDDEN",
        403,
    )
    if not cloud.get("deleted_at"):
        at = iso(cloud["ds"]["clock"])
        save_cloud(
            ctx,
            {
                **cloud["payload"],
                "status": "expired",
                "version": cloud["payload"]["version"] + 1,
                "updatedAt": at,
            },
        )
        collection(ctx, "clouds").update_one({"_id": id}, {"$set": {"deleted_at": ctx.now}})
        for row in collection(ctx, "messages").find({"cloud_id": id}):
            expire_message(ctx, row["id"], at)
    return {"data": {"id": id, "expired": True}}
