from .database import collection, dataset_time
from .geometry import footprint_distance_m
from .pagination import snapshot_page
from .records import cloud_record, public_message, successors
from .validation import compact, iso, limit, location, now, radius, require, timestamp


def sky_freshness(dataset, clouds, clock=None):
    if dataset["mode"] == "replay":
        return "replay"
    clock = clock or now()
    age = (clock - dataset["observed_at"]).total_seconds()
    if age > 1800:
        return "stale"
    if age < 0 or age > 600:
        return "estimated"
    observed = [cloud for cloud in clouds if cloud["kind"] == "observed"]
    if clouds and not observed:
        return "estimated"
    return (
        "live"
        if all(
            cloud["status"] == "active"
            and cloud["confidence"] >= 0.5
            and 0 <= (clock - timestamp(cloud["observedAt"])).total_seconds() <= 600
            for cloud in observed
        )
        else "estimated"
    )


def ranked_ids(ctx, cloud_id, anchor, distance):
    match = {"cloud_id": cloud_id, "expired_at": None, "held": False}
    if anchor:
        match["anchor"] = {
            "$geoWithin": {"$centerSphere": [[anchor["longitude"], anchor["latitude"]], distance / 6371008.8]}
        }
    return [
        row["id"]
        for row in collection(ctx, "messages").aggregate(
            [
                {"$match": match},
                {
                    "$lookup": {
                        "from": "votes",
                        "localField": "id",
                        "foreignField": "message_id",
                        "as": "rankingVotes",
                    }
                },
                {"$set": {"rankingCount": {"$size": "$rankingVotes"}}},
                {"$sort": {"rankingCount": -1, "payload.createdAt": -1, "id": 1}},
                {"$project": {"id": 1}},
            ],
            collation={"locale": "simple"},
        )
    ]


def message_page(ctx, id, params, viewer):
    cloud_record(ctx, id)
    scope = params.get("scope", "nearby")
    require(scope in ("nearby", "all"), "scope must be nearby or all")
    anchor = location(params) if scope == "nearby" else None
    distance, size, viewer_id = radius(params), limit(params), viewer["id"] if viewer else None
    binding = compact(["messages", id, scope, anchor, distance, viewer_id, size])
    page = snapshot_page(
        ctx, binding, params.get("cursor"), lambda: {"items": ranked_ids(ctx, id, anchor, distance)}, size
    )
    data = []
    for key in page["items"]:
        row = collection(ctx, "messages").find_one({"_id": key, "cloud_id": id})
        if row:
            message = public_message(ctx, row, viewer_id)
            if message:
                data.append(message)
    return {"data": data, "nextCursor": page["nextCursor"]}


def sky(ctx, params, viewer):
    anchor, distance, size, ds_id = location(params), radius(params), limit(params), params.get("datasetId")
    require(ds_id, "datasetId required")
    ds = dataset_time(ctx, ds_id)
    if not ds:
        return {
            "data": {"clouds": [], "asOf": iso(ctx.now), "weather": None, "freshness": "stale"},
            "nextCursor": None,
        }
    viewer_id = viewer["id"] if viewer else None
    binding = compact(["sky", ds_id, anchor, distance, viewer_id, size])

    def make():
        items = []
        for row in collection(ctx, "clouds").find({"dataset_id": ds_id}).sort("id", 1):
            if footprint_distance_m(row["footprint"], anchor) > distance:
                continue
            cloud = cloud_record(ctx, row["id"])
            if not cloud["expired"] and cloud["payload"]["status"] != "out_of_region":
                items.append({"id": row["id"], "previews": ranked_ids(ctx, row["id"], anchor, distance)[:3]})
        return {"items": items}

    page = snapshot_page(ctx, binding, params.get("cursor"), make, size)
    clouds = []
    for item in page["items"]:
        cloud = cloud_record(ctx, item["id"])
        if cloud["expired"] or cloud["payload"]["status"] == "out_of_region":
            continue
        previews = []
        for id in item["previews"]:
            row = collection(ctx, "messages").find_one({"_id": id, "cloud_id": item["id"]})
            if row:
                message = public_message(ctx, row, viewer_id)
                if message:
                    previews.append(message)
        clouds.append({"cloud": cloud["payload"], "previews": previews})
    return {
        "data": {
            "clouds": clouds,
            "asOf": iso(ds["observed_at"]),
            "freshness": sky_freshness(ds, [item["cloud"] for item in clouds], ctx.now),
            "weather": None,
        },
        "nextCursor": page["nextCursor"],
    }


def cloud_detail(ctx, id):
    cloud = cloud_record(ctx, id)
    lifecycle = [
        row["payload"]
        for row in collection(ctx, "lifecycle_events")
        .find({"$or": [{"payload.sourceCloudIds": id}, {"payload.targetCloudIds": id}]})
        .sort([("payload.effectiveAt", 1), ("_id", 1)])
    ]
    following = successors(ctx, id)
    return {
        "data": {"id": id, "status": "expired", "lifecycle": lifecycle, "successorIds": following}
        if cloud["expired"]
        else {"cloud": cloud["payload"], "lifecycle": lifecycle, "successorIds": following}
    }
