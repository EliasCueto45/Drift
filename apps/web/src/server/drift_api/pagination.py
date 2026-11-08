from datetime import timedelta
from uuid import uuid4

from .database import collection
from .validation import compact, fail, require


def snapshot_page(ctx, binding, cursor, make, size=50):
    snapshots, items = collection(ctx, "query_snapshots"), collection(ctx, "snapshot_items")
    offset = 0
    if cursor:
        parts = cursor.split(".")
        require(
            len(parts) == 2 and parts[1].isascii() and parts[1].isdigit() and len(parts[1]) <= 16,
            "Invalid cursor",
        )
        id, offset = parts[0], int(parts[1])
        row = snapshots.find_one({"_id": id, "binding": binding, "expires_at": {"$gt": ctx.now}})
        if not row:
            fail(409, "CURSOR_EXPIRED", "Refresh this query")
        meta, count = row["meta"], row["count"]
    else:
        payload, id = make(), str(uuid4())
        meta, count = payload.get("meta"), len(payload["items"])
        expires_at = ctx.now + timedelta(minutes=5)
        snapshots.insert_one(
            {"_id": id, "binding": binding, "meta": meta, "count": count, "expires_at": expires_at}
        )
        for start in range(0, count, 100):
            items.insert_many(
                [
                    {
                        "_id": compact([id, start + index]),
                        "snapshot_id": id,
                        "ordinal": start + index,
                        "value": value,
                        "expires_at": expires_at,
                    }
                    for index, value in enumerate(payload["items"][start : start + 100])
                ]
            )
    require(offset <= count, "Invalid cursor offset")
    end = min(offset + size, count)
    rows = list(items.find({"snapshot_id": id, "ordinal": {"$gte": offset, "$lt": end}}).sort("ordinal", 1))
    require(len(rows) == end - offset, "Refresh this query", "CURSOR_EXPIRED", 409)
    return {
        "items": [row["value"] for row in rows],
        "meta": meta,
        "nextCursor": f"{id}.{end}" if end < count else None,
    }
