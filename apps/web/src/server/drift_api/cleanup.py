from datetime import timedelta
from typing import Any

from .database import collection, dataset_time
from .records import expire_message
from .storage import object_args, storage_client
from .validation import iso, timestamp


def cleanup(ctx, make_client=storage_client, batch_size=100):
    remaining = batch_size
    for cloud in collection(ctx, "clouds").find(
        {"$or": [{"deleted_at": {"$ne": None}}, {"payload.expiresAt": {"$type": "string"}}]}
    ):
        if remaining <= 0:
            break
        ds = dataset_time(ctx, cloud["dataset_id"])
        if not cloud.get("deleted_at") and timestamp(cloud["payload"]["expiresAt"]) > ds["clock"]:
            continue
        for message in (
            collection(ctx, "messages").find({"cloud_id": cloud["id"], "expired_at": None}).limit(remaining)
        ):
            expire_message(ctx, message["id"], iso(ds["clock"]))
            remaining -= 1
    completed, failed = 0, 0
    for job in collection(ctx, "cleanup_jobs").find({}).sort("queued_at", 1).limit(batch_size):
        message = collection(ctx, "messages").find_one({"_id": job["message_id"]})
        if not message:
            collection(ctx, "cleanup_jobs").delete_one({"_id": job["_id"]})
            continue
        asset = (
            collection(ctx, "assets").find_one({"_id": message["asset_id"]})
            if message.get("asset_id")
            else None
        )
        try:
            if asset:
                client = make_client()
                client.delete_object(**object_args(asset["upload_key"]))
                client.delete_object(**object_args(asset["object_key"]))
        except Exception:
            collection(ctx, "cleanup_jobs").update_one({"_id": job["_id"]}, {"$inc": {"attempts": 1}})
            failed += 1
            continue
        if asset:
            collection(ctx, "assets").update_one(
                {"_id": asset["id"]},
                {"$set": {"payload.state": "deleted", "attached_message_id": None, "staging_deleted": True}},
            )
        collection(ctx, "votes").delete_many({"message_id": message["id"]})
        collection(ctx, "messages").delete_one({"_id": message["id"]})
        collection(ctx, "cleanup_jobs").delete_one({"_id": job["_id"]})
        completed += 1
    orphans = (
        collection(ctx, "assets")
        .find(
            {
                "payload.state": {"$ne": "deleted"},
                "upload_expires_at": {"$lt": ctx.now},
                "$or": [
                    {"attached_message_id": {"$type": "string"}, "staging_deleted": {"$ne": True}},
                    {"attached_message_id": None, "created_at": {"$lt": ctx.now - timedelta(days=1)}},
                ],
            }
        )
        .limit(batch_size)
    )
    for asset in orphans:
        try:
            client = make_client()
            client.delete_object(**object_args(asset["upload_key"]))
            if not asset.get("attached_message_id"):
                client.delete_object(**object_args(asset["object_key"]))
        except Exception:
            failed += 1
            continue
        fields: dict[str, Any] = {"staging_deleted": True}
        if not asset.get("attached_message_id"):
            fields["payload.state"] = "deleted"
        collection(ctx, "assets").update_one({"_id": asset["id"]}, {"$set": fields})
    for name in ("query_snapshots", "snapshot_items", "rate_windows", "create_receipts"):
        collection(ctx, name).delete_many({"expires_at": {"$lt": ctx.now}})
    return {"completed": completed, "failed": failed}
