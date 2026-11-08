"""Explicit test-only API with an injected synthetic user and disposable MongoDB."""

import json
import os
import socket
import sys
import threading
import uvicorn
from drift_api.database import transaction, collection
from drift_api.http import create_app
from drift_api.validation import timestamp
from .testing import test_database


def main():
    with test_database() as db:
        id = os.getenv("TEST_DATASET", "backend-worker-demo")

        def run(fn):
            return transaction(fn, db)

        run(
            lambda ctx: collection(ctx, "datasets").insert_one(
                {
                    "_id": id,
                    "id": id,
                    "mode": os.getenv("TEST_MODE", "replay"),
                    "run_id": os.getenv("TEST_RUN", "run"),
                    "sequence": 0,
                    "observed_at": timestamp("1970-01-01T00:00:00Z"),
                    "received_at": ctx.now,
                }
            )
        )
        app = create_app(
            run=run,
            identity=lambda *_: {
                "id": "user_worker_test",
                "displayName": "Synthetic worker test",
                "avatarUrl": None,
            },
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            listener.listen(128)
            print(json.dumps({"base": f"http://127.0.0.1:{port}"}), flush=True)
            server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning"))

            def shutdown_on_input():
                sys.stdin.readline()
                server.should_exit = True

            threading.Thread(target=shutdown_on_input, daemon=True).start()
            server.run(sockets=[listener])


if __name__ == "__main__":
    main()
