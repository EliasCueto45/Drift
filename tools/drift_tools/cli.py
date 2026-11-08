import argparse
import os
from .common import scenarios, validate_fixtures
from .fixtures_gen import write_fixtures
from .replay import post_batch


def main(argv=None):
    parser = argparse.ArgumentParser(description="Drift Python development tools")
    parser.add_argument(
        "command", choices=["fixtures-gen", "fixtures-validate", "check-contracts", "replay", "smoke", "mock"]
    )
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--base", default=os.getenv("DRIFT_API_BASE_URL", "http://localhost:3000"))
    parser.add_argument("--through", type=int)
    parser.add_argument("--repeat", action="store_true")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "3000")))
    args = parser.parse_args(argv)
    if args.command == "fixtures-gen":
        print(f"Generated {write_fixtures()} synthetic fixture files.")
    elif args.command in ("fixtures-validate", "check-contracts"):
        if args.command == "check-contracts":
            write_fixtures(check=True)
        count, batches = validate_fixtures()
        print(f"Validated {count} synthetic scenarios and {batches} batches against canonical JSON Schema.")
    elif args.command == "replay":
        selected = [s for s in scenarios() if args.scenario in ("all", s["name"])]
        if not selected:
            parser.error("Unknown scenario")
        for scenario in selected:
            for entry in scenario["batches"]:
                batch = entry["body"]
                if args.through and batch["sequence"] > args.through:
                    break
                for _ in range(2 if args.repeat else 1):
                    response = post_batch(batch, args.base, os.environ["TRACKING_INGEST_SECRET"])
                    print(f"{scenario['name']}/{entry['file']} -> {response['status']}")
                    if response["status"] >= 300:
                        return 1
    elif args.command == "smoke":
        from .smoke import main as run_smoke

        return run_smoke()
    elif args.command == "mock":
        import uvicorn

        print("Synthetic fixture mock; development only.")
        uvicorn.run("drift_tools.mock:app", host="127.0.0.1", port=args.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
