"""Initialize an explicitly configured disposable/local replica set; never Atlas."""

import os
import time
from pymongo import MongoClient
from pymongo.errors import PyMongoError


def main():
    uri = os.getenv("DRIFT_TEST_MONGODB_URI", "mongodb://127.0.0.1:27017/?directConnection=true")
    if not uri.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:")):
        raise ValueError("Local MongoDB URI required")
    client: MongoClient = MongoClient(uri, serverSelectionTimeoutMS=500)
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline:
            try:
                hello = client.admin.command("hello")
                if hello.get("setName"):
                    print("Local replica set configured.")
                    return
                client.admin.command(
                    "replSetInitiate",
                    {"_id": "drift-test", "members": [{"_id": 0, "host": "127.0.0.1:27017"}]},
                )
            except PyMongoError:
                pass
            time.sleep(0.2)
        raise RuntimeError("Local replica set initialization timed out")
    finally:
        client.close()


if __name__ == "__main__":
    main()
