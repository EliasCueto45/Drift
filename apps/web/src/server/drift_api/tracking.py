from datetime import timedelta
from typing import Any

from .database import collection, dataset_time
from .geometry import point_geometry
from .pagination import snapshot_page
from .records import contains, expire_message, save_cloud
from .validation import compact, fail, iso, limit, require, timestamp, validate


def unique(items, key):
    require(len({item[key] for item in items}) == len(items), f"Duplicate {key}")


def ingest(ctx, batch):
    validate("TrackingBatch", batch)
    observed_at = timestamp(batch["observedAt"])
    unique(batch["snapshots"], "id")
    unique(batch["events"], "eventId")
    unique(batch["anchorUpdates"], "messageId")
    clouds, messages, batches = (
        collection(ctx, "clouds"),
        collection(ctx, "messages"),
        collection(ctx, "tracking_batches"),
    )
    old = batches.find_one({"_id": batch["batchId"]})
    if old:
        require(
            old["dataset_id"] == batch["datasetId"],
            "Batch ID belongs to another dataset",
            "BATCH_CONFLICT",
            409,
        )
        return {"data": old["acknowledgement"]}
    ds = dataset_time(ctx, batch["datasetId"])
    if not ds:
        fail(409, "DATASET_NOT_READY", "Provision dataset/run before ingest")
    require(ds["run_id"] == batch["trackingRunId"], "Tracking run mismatch", "RUN_CONFLICT", 409)
    require(
        batch["sequence"] == ds["sequence"] + 1,
        f"Expected sequence {ds['sequence'] + 1}",
        "OUT_OF_ORDER",
        409,
    )
    require(observed_at >= ds["observed_at"], "Observation clock moved backwards", "OUT_OF_ORDER", 409)
    existing: dict[str, Any] = {}
    for cloud in batch["snapshots"]:
        validate("Cloud", cloud)
        updated_at, cloud_at = timestamp(cloud["updatedAt"]), timestamp(cloud["observedAt"])
        timestamp(cloud["wind"]["validAt"])
        require(
            cloud["datasetId"] == batch["datasetId"] and cloud["trackingRunId"] == batch["trackingRunId"],
            "Snapshot dataset/run mismatch",
        )
        prev = clouds.find_one({"_id": cloud["id"]})
        existing[cloud["id"]] = prev
        require(
            not prev or prev["dataset_id"] == batch["datasetId"],
            "Cross-dataset cloud",
            "DATASET_CONFLICT",
            409,
        )
        require(
            cloud["version"] == (prev["payload"]["version"] + 1 if prev else 1),
            "Cloud version conflict",
            "VERSION_CONFLICT",
            409,
        )
        if prev:
            require(
                (not prev.get("deleted_at") or cloud["status"] == "expired")
                and not (prev["payload"]["status"] == "expired" and cloud["status"] != "expired"),
                "Cloud cannot be resurrected",
                "VERSION_CONFLICT",
                409,
            )
            require(
                all(cloud[key] == prev["payload"][key] for key in ("kind", "creatorId", "expiresAt")),
                "Immutable cloud fields changed",
            )
        else:
            require(
                cloud["kind"] == "observed" and cloud["creatorId"] is None and cloud["expiresAt"] is None,
                "Worker cannot create user clouds",
            )
        require(updated_at <= observed_at and cloud_at <= observed_at, "Snapshot time exceeds batch")
        save_cloud(ctx, cloud)
    for cloud in batch["snapshots"]:
        for parent_id in cloud["parentIds"]:
            parent = clouds.find_one({"_id": parent_id})
            require(
                parent
                and parent["id"] != cloud["id"]
                and parent["dataset_id"] == batch["datasetId"]
                and parent["payload"]["kind"] == "observed"
                and cloud["kind"] == "observed",
                "Invalid lineage parent",
            )
        pending, seen = list(cloud["parentIds"]), set()
        while pending:
            id = pending.pop()
            require(id != cloud["id"], "Cyclic cloud lineage")
            if id in seen:
                continue
            seen.add(id)
            row = clouds.find_one({"_id": id})
            if row:
                pending.extend(row["payload"]["parentIds"])
    for event in batch["events"]:
        require(timestamp(event["effectiveAt"]) <= observed_at, "Event time exceeds batch")
        for id in event["sourceCloudIds"] + event["targetCloudIds"]:
            row = clouds.find_one({"_id": id})
            require(
                row and row["dataset_id"] == batch["datasetId"], "Event references foreign or unknown cloud"
            )
            if event["type"] in ("merged", "split"):
                require(row["payload"]["kind"] == "observed", "Created clouds cannot merge/split")
        if event["type"] in ("merged", "split"):
            require(
                event["sourceCloudIds"] and event["targetCloudIds"], "Lineage requires sources and targets"
            )
            for id in event["sourceCloudIds"]:
                require(
                    clouds.find_one({"_id": id})["payload"]["status"] == "expired",
                    "Lineage predecessors must retire",
                )
        require(
            not collection(ctx, "lifecycle_events").find_one({"_id": event["eventId"]}),
            "Event ID already used",
            "EVENT_CONFLICT",
            409,
        )
        collection(ctx, "lifecycle_events").insert_one(
            {"_id": event["eventId"], "dataset_id": batch["datasetId"], "payload": event}
        )
    for update in batch["anchorUpdates"]:
        row = messages.find_one({"_id": update["messageId"]})
        origin = clouds.find_one({"_id": row["cloud_id"]}) if row else None
        require(
            row
            and origin
            and origin["dataset_id"] == batch["datasetId"]
            and not row.get("expired_at")
            and row["payload"]["version"] == update["expectedMessageVersion"],
            "Message version conflict",
            "VERSION_CONFLICT",
            409,
        )
        assert row is not None and origin is not None
        old_origin = (existing.get(row["cloud_id"]) or origin)["payload"]
        end = (
            timestamp(origin["payload"]["updatedAt"])
            if old_origin["kind"] == "created"
            else min(observed_at, timestamp(old_origin["observedAt"]) + timedelta(minutes=30))
        )
        position_at = max(row["position_at"], end)
        target = row["cloud_id"]
        if update["targetCloudId"] is not None:
            cloud = clouds.find_one({"_id": update["targetCloudId"]})
            require(cloud and cloud["dataset_id"] == batch["datasetId"], "Invalid transfer target")
            require(
                cloud["payload"]["kind"] == origin["payload"]["kind"],
                "Cannot transfer between created/observed clouds",
            )
            if cloud["payload"]["kind"] == "created":
                require(cloud["id"] == row["cloud_id"], "Created clouds are independent")
            if update["action"] == "move":
                require(cloud["payload"]["status"] != "expired", "Cannot move into retired cloud")
                contains(ctx, cloud["id"], update["anchor"])
                target = cloud["id"]
        if row["payload"].get("artworkTransform") and update["action"] != "expire":
            require(
                len(update.get("artworkControlPoints", []))
                == len(row["payload"]["artworkTransform"].get("controlPoints", [])),
                "Artwork transport requires all control points",
            )
        payload = {
            **row["payload"],
            "cloudId": target,
            "anchor": update["anchor"],
            "version": row["payload"]["version"] + 1,
            "updatedAt": batch["observedAt"],
        }
        if "artworkControlPoints" in update:
            require(payload.get("artworkTransform"), "Control points require artwork")
            payload["artworkTransform"] = {
                **payload["artworkTransform"],
                "controlPoints": update["artworkControlPoints"],
            }
        if update["action"] == "expire":
            payload["expiredAt"] = batch["observedAt"]
        messages.update_one(
            {"_id": row["id"]},
            {
                "$set": {
                    "cloud_id": target,
                    "payload": payload,
                    "anchor": point_geometry(update["anchor"]),
                    "held": update["action"] == "hold",
                    "position_at": position_at,
                    "expired_at": timestamp(payload["expiredAt"]) if payload.get("expiredAt") else None,
                }
            },
        )
        if update["action"] == "expire":
            expire_message(ctx, row["id"], batch["observedAt"])
    for cloud in batch["snapshots"]:
        if cloud["status"] == "expired":
            require(
                not messages.find_one({"cloud_id": cloud["id"], "expired_at": None, "held": False}),
                "Retired cloud still has unresolved messages",
                "VERSION_CONFLICT",
                409,
            )
    collection(ctx, "datasets").update_one(
        {"_id": batch["datasetId"]},
        {"$set": {"sequence": batch["sequence"], "observed_at": observed_at, "received_at": ctx.now}},
    )
    ack = {"sequence": batch["sequence"]}
    batches.insert_one(
        {
            "_id": batch["batchId"],
            "dataset_id": batch["datasetId"],
            "sequence": batch["sequence"],
            "acknowledgement": ack,
        }
    )
    return {"data": ack}


def tracking_state(ctx, params):
    dataset_id = params.get("datasetId")
    require(dataset_id, "datasetId required")
    ds = dataset_time(ctx, dataset_id)
    if not ds:
        fail(404, "NOT_FOUND", "Dataset not provisioned")
    if "trackingRunId" in params:
        require(params["trackingRunId"] == ds["run_id"], "Tracking run mismatch", "RUN_CONFLICT", 409)
    size = limit(params)

    def make():
        rows = list(collection(ctx, "clouds").find({"dataset_id": dataset_id}).sort("id", 1))
        eligible = [
            cloud["id"]
            for cloud in rows
            if not cloud.get("deleted_at")
            and (
                not cloud["payload"].get("expiresAt")
                or timestamp(cloud["payload"]["expiresAt"]) > ds["clock"]
            )
        ]
        messages = [
            {
                "type": "message",
                "value": {
                    "id": row["id"],
                    "cloudId": row["cloud_id"],
                    "version": row["payload"]["version"],
                    "anchor": row["payload"]["anchor"],
                    "updatedAt": row["payload"]["updatedAt"],
                    "positionAt": iso(row["position_at"]),
                    "artworkControlPoints": (row["payload"].get("artworkTransform") or {}).get(
                        "controlPoints", []
                    ),
                    "expiredAt": None,
                },
            }
            for row in collection(ctx, "messages")
            .find({"cloud_id": {"$in": eligible}, "expired_at": None})
            .sort("id", 1)
        ]
        return {
            "items": [{"type": "cloud", "value": row["payload"]} for row in rows] + messages,
            "meta": {"datasetId": dataset_id, "trackingRunId": ds["run_id"], "sequence": ds["sequence"]},
        }

    page = snapshot_page(
        ctx, compact(["worker", dataset_id, ds["run_id"], size]), params.get("cursor"), make, size
    )
    return {
        "data": {
            **page["meta"],
            "clouds": [item["value"] for item in page["items"] if item["type"] == "cloud"],
            "messages": [item["value"] for item in page["items"] if item["type"] == "message"],
        },
        "nextCursor": page["nextCursor"],
    }
