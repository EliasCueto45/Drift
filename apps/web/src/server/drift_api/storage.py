import io
import math
import os
import warnings
from datetime import timedelta
from uuid import uuid4

import av
import boto3
from botocore.config import Config
from PIL import Image

from .auth import rate_limit
from .database import collection
from .records import cloud_record, message_record, public_message
from .validation import ApiError, exact, fail, iso, now, require

MIME_TYPES = {
    "png": ["image/png"],
    "drawing": ["image/png"],
    "audio": ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4"],
}


def asset_limit(kind):
    return (10 if kind == "audio" else 5) * 1024 * 1024


def upload_input(value):
    exact(value, ["kind", "mimeType", "sizeBytes"])
    require(value.get("mimeType") in MIME_TYPES.get(value.get("kind"), []), "Unsupported media type")
    require(
        type(value.get("sizeBytes")) is int and value["sizeBytes"] > 0, "sizeBytes must be positive integer"
    )
    if value["sizeBytes"] > asset_limit(value["kind"]):
        fail(413, "TOO_LARGE", "Media exceeds byte limit")


def storage_client():
    for key in ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]:
        if not os.getenv(key):
            fail(503, "NOT_CONFIGURED", "Storage is not configured")
    return boto3.client(
        "s3",
        region_name=os.environ["S3_REGION"],
        endpoint_url=os.getenv("S3_ENDPOINT") or None,
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if os.getenv("S3_ENDPOINT") else "auto"},
            connect_timeout=10,
            read_timeout=30,
        ),
    )


def object_args(key, **extra):
    return {"Bucket": os.environ["S3_BUCKET"], "Key": key, **extra}


def read_object(client, key, maximum):
    obj = client.get_object(**object_args(key))
    body = obj["Body"]
    try:
        require(obj.get("ContentLength", 0) <= maximum, "Stored object exceeds byte limit", "TOO_LARGE", 413)
        content = body.read(maximum + 1)
        require(len(content) <= maximum, "Stored object exceeds byte limit", "TOO_LARGE", 413)
        return content
    finally:
        body.close()


def inspect_media(content, asset):
    if asset["kind"] != "audio":
        require(content[:8] == b"\x89PNG\r\n\x1a\n", "PNG signature required")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(content)) as image:
                    require(
                        image.format == "PNG"
                        and getattr(image, "n_frames", 1) == 1
                        and 0 < image.width <= 4096
                        and 0 < image.height <= 4096,
                        "Single PNG up to 4096 pixels per side required",
                    )
                    image.load()
                    # A fresh image strips EXIF, text, ICC and other embedded metadata.
                    clean_image = Image.frombytes("RGBA", image.size, image.convert("RGBA").tobytes())
                    output = io.BytesIO()
                    clean_image.save(output, format="PNG")
                    clean = output.getvalue()
                    require(len(clean) <= asset_limit(asset["kind"]), "Re-encoded PNG exceeds size limit")
                    return clean, {"width": image.width, "height": image.height, "durationSec": None}
        except ApiError:
            raise
        except Exception:
            fail(422, "INVALID_MEDIA", "PNG could not be decoded")
    mime = asset["mimeType"]
    signatures = {
        "audio/wav": content[:4] == b"RIFF" and content[8:12] == b"WAVE",
        "audio/ogg": content[:4] == b"OggS",
        "audio/webm": content[:4] == b"\x1aE\xdf\xa3",
        "audio/mp4": content[4:8] == b"ftyp",
        "audio/mpeg": content[:3] == b"ID3"
        or (len(content) >= 2 and content[0] == 255 and content[1] & 224 == 224),
    }
    require(signatures.get(mime), "Audio signature does not match declared type")
    try:
        with av.open(io.BytesIO(content), mode="r") as container:
            require(
                len(container.streams.audio) == 1 and not container.streams.video, "One audio stream required"
            )
            seconds = 0.0
            for frame in container.decode(audio=0):
                seconds += frame.samples / frame.sample_rate
                require(seconds <= 60, "Audio duration must be at most 60 seconds")
            require(
                math.isfinite(seconds) and 0 < seconds <= 60,
                "Audio duration must be known and at most 60 seconds",
            )
            return content, {"width": None, "height": None, "durationSec": seconds}
    except ApiError:
        raise
    except Exception:
        fail(422, "INVALID_MEDIA", "Audio could not be decoded")


def upload_url(ctx, value, user, client=None):
    upload_input(value)
    client = client or storage_client()
    rate_limit(ctx, user["id"], "upload", 10)
    id, created_at = str(uuid4()), now()
    expires_at = created_at + timedelta(minutes=5)
    asset = {"id": id, "ownerId": user["id"], **value, "state": "pending", "createdAt": iso(created_at)}
    upload_key, object_key = f"pending/{id}/{uuid4()}", f"ready/{id}/{uuid4()}"
    url = client.generate_presigned_url(
        "put_object",
        Params=object_args(upload_key, ContentType=value["mimeType"], ContentLength=value["sizeBytes"]),
        ExpiresIn=300,
    )
    collection(ctx, "assets").insert_one(
        {
            "_id": id,
            "id": id,
            "owner_id": user["id"],
            "payload": asset,
            "upload_key": upload_key,
            "object_key": object_key,
            "upload_expires_at": expires_at,
            "created_at": ctx.now,
            "attached_message_id": None,
            "staging_deleted": False,
        }
    )
    return {"data": {"assetId": id, "uploadUrl": url, "expiresAt": iso(expires_at)}}


def complete_asset(ctx, id, user, client=None):
    row = collection(ctx, "assets").find_one({"_id": id})
    if not row:
        fail(404, "NOT_FOUND", "Asset not found")
    require(row["owner_id"] == user["id"], "Asset owner only", "FORBIDDEN", 403)
    if row["payload"]["state"] == "ready":
        return {"data": row["payload"]}
    require(
        row["payload"]["state"] == "pending" and row["upload_expires_at"] > now(),
        "Upload expired",
        "UPLOAD_EXPIRED",
        410,
    )
    client = client or storage_client()
    content = read_object(client, row["upload_key"], asset_limit(row["payload"]["kind"]))
    require(len(content) == row["payload"]["sizeBytes"], "Uploaded size differs from declaration")
    clean, metadata = inspect_media(content, row["payload"])
    client.put_object(
        **object_args(
            row["object_key"],
            Body=clean,
            ContentType=row["payload"]["mimeType"],
            CacheControl="private, no-store",
        )
    )
    payload = {**row["payload"], **metadata, "sizeBytes": len(clean), "state": "ready"}
    collection(ctx, "assets").update_one({"_id": id}, {"$set": {"payload": payload}})
    return {"data": payload}


def playback_url(ctx, id, viewer, client=None):
    row = collection(ctx, "assets").find_one({"_id": id})
    if not row:
        fail(404, "NOT_FOUND", "Asset not found")
    require(
        row["payload"]["state"] == "ready" and row.get("attached_message_id"),
        "Asset unavailable",
        "CLOUD_EXPIRED",
        410,
    )
    message = message_record(ctx, row["attached_message_id"])
    require(
        public_message(ctx, message, viewer["id"] if viewer else None),
        "Content expired",
        "CLOUD_EXPIRED",
        410,
    )
    cloud, ttl = cloud_record(ctx, message["cloud_id"]), 60
    if cloud["payload"].get("expiresAt"):
        from .validation import timestamp

        ttl = min(
            ttl, math.floor((timestamp(cloud["payload"]["expiresAt"]) - cloud["ds"]["clock"]).total_seconds())
        )
    require(ttl > 0, "Content expired", "CLOUD_EXPIRED", 410)
    client = client or storage_client()
    url = client.generate_presigned_url(
        "get_object",
        Params=object_args(
            row["object_key"],
            ResponseCacheControl="private, no-store",
            ResponseContentType=row["payload"]["mimeType"],
        ),
        ExpiresIn=ttl,
    )
    return {"data": {"url": url, "expiresAt": iso(now() + timedelta(seconds=ttl))}}


def artwork(ctx, id, viewer):
    message = message_record(ctx, id)
    require(
        public_message(ctx, message, viewer["id"] if viewer else None),
        "Content expired",
        "CLOUD_EXPIRED",
        410,
    )
    require(message["payload"]["kind"] == "drawing", "Message is not a drawing")
    return {
        "data": {
            "strokes": message.get("strokes"),
            "artworkTransform": message["payload"]["artworkTransform"],
        }
    }
