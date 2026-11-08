"""Transactional, user-scoped create receipts; never retain message bodies."""

import hashlib
import json
import re
from datetime import timedelta
from .database import collection
from .records import cloud_record, public_message
from .validation import compact, fail, require


def create_once(ctx, user, key, path, body, execute, kind):
    if key is None:
        return execute(ctx)
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key), "Invalid Idempotency-Key")
    try:
        encoded = json.dumps(
            body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
    except (ValueError, TypeError):
        fail(422, "INVALID", "Request contains invalid JSON values")
    digest = hashlib.sha256(encoded).hexdigest()
    receipts = collection(ctx, "create_receipts")
    id = compact([user["id"], key])
    row = receipts.find_one({"_id": id})
    if row and row["expires_at"] <= ctx.now:
        receipts.delete_one({"_id": id})
        row = None
    if row:
        require(
            row["path"] == path and row["digest"] == digest,
            "Retry key was already used for a different request",
            "IDEMPOTENCY_CONFLICT",
            409,
        )
        if row["kind"] == "cloud":
            cloud = cloud_record(ctx, row["entity_id"])
            require(not cloud["expired"], "Created cloud expired", "CLOUD_EXPIRED", 410)
            return {"data": cloud["payload"]}
        message = collection(ctx, "messages").find_one({"_id": row["entity_id"]})
        result = public_message(ctx, message, user["id"]) if message else None
        if result is None:
            fail(410, "CONTENT_UNAVAILABLE", "The original post is no longer available")
        return {"data": result}
    result = execute(ctx)
    receipts.insert_one(
        {
            "_id": id,
            "path": path,
            "digest": digest,
            "entity_id": result["data"]["id"],
            "kind": kind,
            "expires_at": ctx.now + timedelta(hours=24),
        }
    )
    return result
