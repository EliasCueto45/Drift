import os
from typing import Any
from dataclasses import dataclass
from datetime import datetime
from threading import Lock

from pymongo import MongoClient
from pymongo.errors import CollectionInvalid, OperationFailure, PyMongoError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from .validation import fail, now

NAMES = [
    "profiles",
    "datasets",
    "clouds",
    "cloud_history",
    "assets",
    "messages",
    "votes",
    "tracking_batches",
    "lifecycle_events",
    "cleanup_jobs",
    "rate_windows",
    "query_snapshots",
    "snapshot_items",
    "schema_migrations",
    "transaction_guards",
]
_source = None
_lock = Lock()


@dataclass
class Context:
    db: Any
    session: Any
    now: datetime


class Collection:
    """Attach the transaction session to every operation, including reads."""

    def __init__(self, context, name):
        self.raw, self.session = context.db[name], context.session

    def __getattr__(self, name):
        method = getattr(self.raw, name)
        return lambda *a, **kw: method(*a, **{**kw, "session": self.session})


def collection(ctx, name):
    return Collection(ctx, name)


def initialize(db):
    for name in NAMES:
        try:
            db.create_collection(
                name,
                validator={
                    "$jsonSchema": {
                        "bsonType": "object",
                        "required": ["_id"],
                        "properties": {"_id": {"bsonType": "string"}},
                    }
                },
            )
        except CollectionInvalid:
            pass
        except OperationFailure as error:
            if error.code != 48:
                raise
    indexes: list[tuple[str, list[tuple[str, Any]], dict[str, Any]]] = [
        ("clouds", [("dataset_id", 1)], {}),
        ("clouds", [("footprint", "2dsphere")], {}),
        ("clouds", [("payload.parentIds", 1)], {}),
        ("messages", [("anchor", "2dsphere")], {}),
        ("messages", [("cloud_id", 1), ("expired_at", 1), ("held", 1)], {}),
        (
            "messages",
            [("asset_id", 1)],
            {"unique": True, "partialFilterExpression": {"asset_id": {"$type": "string"}}},
        ),
        ("cloud_history", [("cloud_id", 1), ("version", 1)], {"unique": True}),
        ("assets", [("upload_key", 1)], {"unique": True}),
        ("assets", [("object_key", 1)], {"unique": True}),
        (
            "assets",
            [("attached_message_id", 1)],
            {"unique": True, "partialFilterExpression": {"attached_message_id": {"$type": "string"}}},
        ),
        ("votes", [("message_id", 1), ("user_id", 1)], {"unique": True}),
        ("tracking_batches", [("dataset_id", 1), ("sequence", 1)], {"unique": True}),
        ("lifecycle_events", [("dataset_id", 1)], {}),
        ("cleanup_jobs", [("queued_at", 1)], {}),
        ("snapshot_items", [("snapshot_id", 1), ("ordinal", 1)], {"unique": True}),
    ]
    indexes += [
        (name, [("expires_at", 1)], {"expireAfterSeconds": 0})
        for name in ("query_snapshots", "snapshot_items", "rate_windows")
    ]
    for name, keys, options in indexes:
        db[name].create_index(keys, **options)
    db.transaction_guards.update_one({"_id": "backend"}, {"$setOnInsert": {"revision": 0}}, upsert=True)
    db.schema_migrations.update_one(
        {"_id": "002_mongodb"}, {"$setOnInsert": {"applied_at": now(), "version": 2}}, upsert=True
    )


def database():
    global _source
    if not os.getenv("MONGODB_URI"):
        fail(503, "NOT_CONFIGURED", "MONGODB_URI is required")
    with _lock:
        if _source is None:
            client: MongoClient = MongoClient(
                os.environ["MONGODB_URI"], maxPoolSize=10, serverSelectionTimeoutMS=10000, tz_aware=True
            )
            try:
                db = client[os.getenv("MONGODB_DB", "drift")]
                initialize(db)
                _source = db
            except PyMongoError:
                client.close()
                fail(
                    503,
                    "DATABASE_UNAVAILABLE",
                    "MongoDB is unavailable; check credentials and Atlas network access",
                )
    return _source


def transaction(fn, provided=None):
    db = provided if provided is not None else database()
    with db.client.start_session() as session:

        def execute(s):
            db.transaction_guards.update_one({"_id": "backend"}, {"$inc": {"revision": 1}}, session=s)
            return fn(Context(db, s, now()))

        return session.with_transaction(
            execute,
            read_concern=ReadConcern("snapshot"),
            write_concern=WriteConcern("majority"),
            max_commit_time_ms=10000,
        )


def close_database():
    global _source
    if _source is not None:
        _source.client.close()
        _source = None


def dataset_time(ctx, id):
    row = collection(ctx, "datasets").find_one({"_id": id})
    if row:
        row["clock"] = row["observed_at"] if row["mode"] == "replay" else ctx.now
    return row
