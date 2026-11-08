from .database import collection, dataset_time
from .geometry import covers, distance_m, validate_geometry
from .validation import compact, fail, require, timestamp


def cloud_record(ctx, id):
    cloud = collection(ctx, "clouds").find_one({"_id": id})
    if not cloud:
        fail(404, "NOT_FOUND", "Cloud not found")
    ds = dataset_time(ctx, cloud["dataset_id"])
    elapsed = cloud["payload"].get("expiresAt") and timestamp(cloud["payload"]["expiresAt"]) <= ds["clock"]
    return {
        **cloud,
        "ds": ds,
        "expired": bool(cloud.get("deleted_at") or cloud["payload"]["status"] == "expired" or elapsed),
    }


def successors(ctx, id):
    return [row["id"] for row in collection(ctx, "clouds").find({"payload.parentIds": id}).sort("id", 1)]


def active_cloud(ctx, id, version=None):
    cloud, following = cloud_record(ctx, id), successors(ctx, id)
    if following:
        fail(409, "CLOUD_RETIRED", f"Cloud retired; successor IDs: {compact(following)}")
    if cloud["expired"]:
        fail(410, "CLOUD_EXPIRED", "Cloud expired")
    require(
        cloud["payload"]["status"] == "active", "Cloud is not eligible for posting", "CLOUD_UNAVAILABLE", 409
    )
    if version is not None:
        require(cloud["payload"]["version"] == version, "Cloud version changed", "VERSION_CONFLICT", 409)
    return cloud


def save_cloud(ctx, cloud):
    validate_geometry(cloud["geometry"])
    collection(ctx, "clouds").update_one(
        {"_id": cloud["id"]},
        {
            "$set": {
                "id": cloud["id"],
                "dataset_id": cloud["datasetId"],
                "payload": cloud,
                "footprint": cloud["geometry"],
            },
            "$setOnInsert": {"deleted_at": None},
        },
        upsert=True,
    )
    collection(ctx, "cloud_history").insert_one(
        {
            "_id": compact([cloud["id"], cloud["version"]]),
            "cloud_id": cloud["id"],
            "version": cloud["version"],
            "payload": cloud,
        }
    )


def contains(ctx, id, anchor):
    cloud = collection(ctx, "clouds").find_one({"_id": id})
    require(cloud and covers(cloud["footprint"], anchor), "Anchor must be inside cloud footprint")


def message_record(ctx, id):
    message = collection(ctx, "messages").find_one({"_id": id})
    if not message:
        fail(404, "NOT_FOUND", "Message not found")
    return message


def public_message(ctx, row, viewer_id=None):
    cloud = cloud_record(ctx, row["cloud_id"])
    if (
        row.get("expired_at")
        or row.get("held")
        or cloud["expired"]
        or cloud["payload"]["status"] == "out_of_region"
    ):
        return None
    votes = collection(ctx, "votes")
    return {
        **row["payload"],
        "driftDistanceM": distance_m(row["initial_anchor"], row["payload"]["anchor"])
        if row.get("initial_anchor") is not None else None,
        "author": public_author(ctx, row["author_id"]),
        "voteCount": votes.count_documents({"message_id": row["id"]}),
        "viewerHasUpvoted": bool(
            viewer_id and votes.find_one({"message_id": row["id"], "user_id": viewer_id})
        ),
    }


def public_author(ctx, id):
    if id.startswith("anon_"):
        return {"id": id, "displayName": "Anonymous", "avatarUrl": None}
    row = collection(ctx, "profiles").find_one({"_id": id})
    profile = (row or {}).get("public_profile", {})
    # Explicit allowlist: profile documents may gain private fields later.
    return {"id": id, "displayName": profile.get("displayName"), "avatarUrl": profile.get("avatarUrl")}


def expire_message(ctx, id, at):
    row = collection(ctx, "messages").find_one({"_id": id})
    if not row:
        return
    if not row.get("expired_at"):
        collection(ctx, "messages").update_one(
            {"_id": id},
            {
                "$set": {"expired_at": timestamp(at), "payload.expiredAt": at, "payload.updatedAt": at},
                "$inc": {"payload.version": 1},
            },
        )
    collection(ctx, "cleanup_jobs").update_one(
        {"_id": id}, {"$setOnInsert": {"message_id": id, "queued_at": ctx.now, "attempts": 0}}, upsert=True
    )
