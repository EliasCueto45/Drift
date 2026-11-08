import json

from .auth import upsert_profile
from .config import ROOT
from .database import collection
from .geometry import point_geometry
from .records import save_cloud
from .validation import timestamp, validate


def seed_fixtures(run):
    count = 0
    for base in sorted((ROOT / "fixtures/scenarios").iterdir()):
        meta = json.loads((base / "scenario.json").read_text())
        batch = validate("TrackingBatch", json.loads((base / meta["batches"][0]).read_text()))
        if not meta["synthetic"] or not meta["datasetId"].startswith("fx-"):
            raise ValueError("Seed accepts synthetic fx-* datasets only")

        def insert(ctx, batch=batch, meta=meta):
            if collection(ctx, "datasets").find_one({"_id": batch["datasetId"]}):
                return False
            collection(ctx, "datasets").insert_one(
                {
                    "_id": batch["datasetId"],
                    "id": batch["datasetId"],
                    "mode": "replay",
                    "run_id": batch["trackingRunId"],
                    "sequence": batch["sequence"],
                    "observed_at": timestamp(batch["observedAt"]),
                    "received_at": ctx.now,
                }
            )
            for user in meta["seed"]["users"]:
                upsert_profile(ctx, user)
            for cloud in batch["snapshots"]:
                if cloud["creatorId"]:
                    upsert_profile(
                        ctx,
                        {
                            "id": cloud["creatorId"],
                            "displayName": "Synthetic fixture creator",
                            "avatarUrl": None,
                        },
                    )
                save_cloud(ctx, cloud)
            for message in meta["seed"]["messages"]:
                validate("Message", message)
                collection(ctx, "messages").insert_one(
                    {
                        "_id": message["id"],
                        "id": message["id"],
                        "cloud_id": message["cloudId"],
                        "author_id": message["authorId"],
                        "asset_id": message["assetId"],
                        "payload": message,
                        "anchor": point_geometry(message["anchor"]),
                        "position_at": timestamp(message["updatedAt"]),
                        "expired_at": None,
                        "held": False,
                        "strokes": None,
                    }
                )
            for event in batch["events"]:
                collection(ctx, "lifecycle_events").insert_one(
                    {"_id": event["eventId"], "dataset_id": batch["datasetId"], "payload": event}
                )
            collection(ctx, "tracking_batches").insert_one(
                {
                    "_id": batch["batchId"],
                    "dataset_id": batch["datasetId"],
                    "sequence": batch["sequence"],
                    "acknowledgement": {"sequence": batch["sequence"]},
                }
            )
            return True

        if run(insert):
            count += 1
    return count
