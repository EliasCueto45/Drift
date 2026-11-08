import argparse
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

from .delivery import ApiClient, TransportUnavailable, deliver, flush
from urllib.error import HTTPError, URLError
from .engine import Engine
from .inputs import observation_inputs, synthetic_inputs
from .models import Grid
from .state import Journal
from jsonschema.exceptions import ValidationError, SchemaError
from .contracts import DEFAULT_SCHEMA, validate_batch


def bind_destination(state_dir, destination):
    """A checkpoint cannot silently skip delivery to a newly selected sink."""
    path = state_dir/"destination.json"
    if path.exists():
        if json.loads(path.read_text(encoding="utf-8")) != destination:
            raise ValueError("state directory belongs to another output/API; use a new state directory")
    else:
        path.write_text(json.dumps(destination), encoding="utf-8")


class JsonlSink:
    def __init__(self, path, schema=None):
        self.path = Path(path)
        self.schema = schema
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def send(self, batch):
        validate_batch(batch, self.schema)
        # Offline sink supports lost-ack retry without duplicate lines.
        existing = set()
        if self.path.exists():
            existing = {json.loads(line)["batchId"] for line in self.path.read_text(encoding="utf-8").splitlines()}
        if batch["batchId"] not in existing:
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(batch, allow_nan=False, separators=(",", ":"))+"\n")
                stream.flush()
                os.fsync(stream.fileno())


def main(argv=None, *, propagate_transport_errors=False):
    parser = argparse.ArgumentParser(description="Drift wind-assisted cloud worker")
    parser.add_argument("--mode", choices=("replay", "live"), default="replay")
    parser.add_argument("--dataset", default=os.getenv("DRIFT_DATASET_ID", "troy-demo"))
    parser.add_argument("--run-id", default="regional-v1")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--state-dir", type=Path, default=Path("services/cloud-worker/.worker-state"))
    parser.add_argument("--output", type=Path, default=Path("services/cloud-worker/out/batches.jsonl"))
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--max-observation-age-seconds", type=int)
    parser.add_argument("--batch-schema", type=Path)
    parser.add_argument('--tracking-policy',choices=('all','content'),default='all')
    args = parser.parse_args(argv)
    try:
        if args.mode == "live" and (not args.manifest or args.fixture):
            raise ValueError("live requires a GOES manifest and forbids synthetic fixtures")
        if args.mode == "replay" and not args.dataset.endswith("-demo"):
            raise ValueError("replay dataset IDs must end in -demo")
        if args.mode == "live" and args.dataset.endswith("-demo"):
            raise ValueError("live dataset cannot use a replay ID")
        if args.fixture and args.manifest:
            raise ValueError("choose fixture or manifest")
        fixture = args.fixture or Path(__file__).resolve().parent/"fixtures/troy-demo.json"
        metadata = json.loads((args.manifest or fixture).read_text(encoding="utf-8"))
        grid = Grid(**metadata["grid"])
        initial = Engine(grid, args.dataset, args.run_id)
        args.state_dir.mkdir(parents=True, exist_ok=True)
        # Exclusive process lock; a crashed process leaves a lock requiring explicit recovery.
        lock = args.state_dir/"worker.lock"
        with lock.open("x", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        try:
            journal = Journal(args.state_dir/"journal.json", initial)
            engine = journal.engine()
            if (engine.dataset_id, engine.run_id) != (args.dataset, args.run_id):
                raise ValueError("state directory belongs to another dataset/run/grid")
            engine.expand_grid(grid)
            if args.publish:
                schema = json.loads((args.batch_schema or DEFAULT_SCHEMA).read_text(encoding="utf-8"))
                sink = ApiClient(os.environ["DRIFT_API_BASE_URL"], os.environ["TRACKING_INGEST_SECRET"], schema)
                sink.tracking_run_id = args.run_id
                bind_destination(args.state_dir, {"api": sink.base})
            else:
                schema = json.loads(args.batch_schema.read_text(encoding="utf-8")) if args.batch_schema else None
                sink = JsonlSink(args.output, schema)
                bind_destination(args.state_dir, {"file": str(args.output.resolve())})
            flush(journal, sink)
            # Already-staged batches are acknowledged unchanged before policy switches.
            journal.value['checkpoint']['contentOnly']=args.tracking_policy=='content'
            inputs = observation_inputs(args.manifest, args.state_dir/"cache") if args.manifest else synthetic_inputs(fixture)
            count = 0
            for frame, winds in inputs:
                if args.mode == "live" and args.max_observation_age_seconds is not None:
                    age = (datetime.now(timezone.utc)-frame.observed_at).total_seconds()
                    if not 0 <= age <= args.max_observation_age_seconds:
                        raise ValueError("observation became stale during acquisition; not publishing as live")
                if deliver(journal, frame, winds, sink):
                    count += 1
            print(json.dumps({"mode": args.mode, "synthetic": not bool(args.manifest),
                              "datasetId": args.dataset, "batchesApplied": count,
                              "sequence": journal.engine().sequence, "published": args.publish}))
        finally:
            lock.unlink(missing_ok=True)
    except (ValidationError, SchemaError):
        print("worker stopped: batch/schema validation failed; checkpoint not advanced", file=sys.stderr)
        return 1
    except HTTPError as error:
        if propagate_transport_errors and error.code in (408, 429, 500, 502, 503, 504):
            raise
        print(f"worker stopped: remote HTTP {error.code}", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, ConnectionError, TransportUnavailable) as error:
        if propagate_transport_errors:
            raise
        print(f"worker stopped: {error}", file=sys.stderr)
        return 1
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        print(f"worker stopped: {error}", file=sys.stderr)
        return 1
    return 0
