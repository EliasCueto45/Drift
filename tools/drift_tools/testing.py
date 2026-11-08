"""Disposable real MongoDB replica sets for tests; never uses MONGODB_URI."""

import os
import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4
import threading
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from drift_api.database import initialize
from .common import ROOT


@contextmanager
def test_database():
    uri = os.getenv("DRIFT_TEST_MONGODB_URI")
    process = None
    with tempfile.TemporaryDirectory(prefix="drift-mongo-") as directory:
        if not uri:
            binary = os.getenv("MONGOD_BINARY") or shutil.which("mongod")
            cached = (
                ROOT / "apps/web/src/server/node_modules/.cache/mongodb-binaries/mongod-x64-win32-8.2.6.exe"
            )
            if not binary and cached.is_file():
                binary = str(cached)
            if not binary:
                raise RuntimeError(
                    "Install mongod or set MONGOD_BINARY / DRIFT_TEST_MONGODB_URI to a disposable replica set"
                )
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            process = subprocess.Popen(
                [
                    binary,
                    "--replSet",
                    "drift-test",
                    "--bind_ip",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--dbpath",
                    directory,
                    "--logpath",
                    str(Path(directory) / "mongo.log"),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            uri = f"mongodb://127.0.0.1:{port}/?directConnection=true"
        client: MongoClient = MongoClient(
            uri, tz_aware=True, serverSelectionTimeoutMS=500, connectTimeoutMS=500
        )
        db = client["drift_test_" + uuid4().hex]
        try:
            deadline = time.monotonic() + 40
            initiated = False
            while time.monotonic() < deadline:
                try:
                    hello = client.admin.command("hello")
                    if hello.get("isWritablePrimary") and hello.get("logicalSessionTimeoutMinutes"):
                        # Standalone MongoDB is not enough: transactions require a replica set.
                        if client.admin.command("hello").get("setName"):
                            break
                    if process and not initiated:
                        client.admin.command(
                            "replSetInitiate",
                            {"_id": "drift-test", "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}]},
                        )
                        initiated = True
                except PyMongoError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("Disposable MongoDB replica set did not become ready")
            # Reconnect after election: connections opened before initialization
            # cached the standalone handshake, which does not support sessions.
            database_name = db.name
            client.close()
            client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=10000)
            db = client[database_name]
            initialize(db)
            yield db
        finally:
            try:
                client.drop_database(db.name)
            finally:
                client.close()
                if process:
                    process.terminate()
                    process.wait(timeout=15)


@contextmanager
def running_api(app):
    import uvicorn

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started:
                if time.monotonic() > deadline or not thread.is_alive():
                    raise RuntimeError("API did not start")
                time.sleep(0.02)
            yield f"http://127.0.0.1:{listener.getsockname()[1]}"
        finally:
            server.should_exit = True
            thread.join(timeout=15)
