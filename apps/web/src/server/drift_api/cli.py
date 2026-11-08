import argparse
import json
import os
import signal
import sys
import threading

from .database import close_database, collection, database, transaction
from .fixtures import seed_fixtures
from .validation import ApiError, require, timestamp


def provision(id, mode, run_id, start):
    require(mode in ("live", "replay"), "Explicit live/replay mode required")
    at = timestamp(start)
    transaction(
        lambda ctx: collection(ctx, "datasets").insert_one(
            {
                "_id": id,
                "id": id,
                "mode": mode,
                "run_id": run_id,
                "sequence": 0,
                "observed_at": at,
                "received_at": ctx.now,
            }
        )
    )


def check_clerk():
    import httpx

    from .auth import clerk_issuer

    secret = os.getenv("CLERK_SECRET_KEY", "")
    require(secret.startswith("sk_") and len(secret) > 30, "Complete Clerk secret required")
    response = httpx.get(
        "https://api.clerk.com/v1/jwks",
        headers={"Authorization": f"Bearer {secret}"},
        timeout=15,
        follow_redirects=False,
    )
    require(response.status_code == 200, "Clerk secret was not accepted")
    frontend = httpx.get(clerk_issuer() + "/.well-known/jwks.json", timeout=15, follow_redirects=False)
    require(frontend.status_code == 200, "Clerk public keys unavailable")

    def fingerprints(keys):
        return {(key.get("n"), key.get("e")) for key in keys["keys"] if key.get("kty") == "RSA"}

    require(
        fingerprints(response.json()) & fingerprints(frontend.json()),
        "Clerk keys belong to different applications",
    )
    print("Clerk secret accepted; public and private keys match the same application.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Drift Python API and database commands")
    parser.add_argument(
        "command",
        choices=[
            "serve",
            "config-check",
            "clerk-check",
            "db-check",
            "smoke-atlas",
            "migrate",
            "seed",
            "prepare",
            "provision",
            "cleanup",
        ],
    )
    parser.add_argument("args", nargs="*")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "3000")))
    options = parser.parse_args(argv)
    try:
        command = options.command
        if command == "serve":
            import uvicorn

            uvicorn.run(
                "drift_api.http:app",
                host=options.host,
                port=options.port,
                proxy_headers=False,
                access_log=False,
            )
        elif command == "config-check":
            for key in [
                "MONGODB_URI",
                "CLERK_SECRET_KEY",
                "TRACKING_INGEST_SECRET",
                "DRIFT_DATASET_ID",
                "S3_BUCKET",
                "S3_REGION",
                "S3_ACCESS_KEY_ID",
                "S3_SECRET_ACCESS_KEY",
            ]:
                print(f"{key}: {'set' if os.getenv(key) else 'missing'}")
        elif command == "clerk-check":
            check_clerk()
        elif command == "smoke-atlas":
            from .smoke import atlas_smoke

            atlas_smoke()
        elif command in ("db-check", "migrate"):
            database().command("ping")
            if command == "db-check":
                transaction(lambda ctx: collection(ctx, "transaction_guards").find_one({"_id": "backend"}))
            print("MongoDB connection, schema and indexes ready.")
        elif command in ("seed", "prepare"):
            print(
                f"Initialized {seed_fixtures(transaction)} synthetic fixture datasets; existing data preserved."
            )
            id = os.getenv("DRIFT_DATASET_ID", "troy-demo")
            if command == "prepare" and id.endswith("-demo"):

                def insert(ctx):
                    collection(ctx, "datasets").update_one(
                        {"_id": id},
                        {
                            "$setOnInsert": {
                                "id": id,
                                "mode": "replay",
                                "run_id": "regional-v1",
                                "sequence": 0,
                                "observed_at": timestamp("1970-01-01T00:00:00Z"),
                                "received_at": ctx.now,
                            }
                        },
                        upsert=True,
                    )

                transaction(insert)
        elif command == "provision":
            require(len(options.args) == 4, "Usage: drift provision DATASET_ID live|replay RUN_ID START_UTC")
            provision(*options.args)
            print("Provisioned dataset at sequence 0.")
        elif command == "cleanup":
            from .cleanup import cleanup

            stop = threading.Event()
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, lambda *_: stop.set())
            while not stop.is_set():
                print(json.dumps(transaction(cleanup)))
                if not options.watch:
                    break
                stop.wait(300)
        return 0
    except ApiError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 1
    except Exception as error:
        print(
            f"Command failed ({type(error).__name__}); check configuration and service access.",
            file=sys.stderr,
        )
        return 1
    finally:
        close_database()


if __name__ == "__main__":
    raise SystemExit(main())
