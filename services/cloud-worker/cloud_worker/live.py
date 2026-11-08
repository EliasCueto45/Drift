"""Discover current NOAA observations and drive the existing durable worker."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

from .cli import main as worker_main
from .delivery import TransportUnavailable
from .models import iso
from .state import decode

UTC = timezone.utc
GRID = {"crs":"EPSG:32618", "x0":548000, "y0":4678000, "cell_m":1000, "width":128, "height":128}


def coverage_grid(state_dir, margin_m=32000, max_axis_cells=512):
    """Keep a buffer around content; a crop edge is not a physical cloud edge.

    Expand only in whole 32-cell tiles. Existing checkpoints/pending batches keep
    their coordinate system, sequence, and geometry; no dataset reset is needed.
    """
    path = state_dir / "journal.json"
    if not path.exists():
        return dict(GRID)
    journal = json.loads(path.read_text(encoding="utf-8"))
    value = journal["pending"]["nextState"] if journal.get("pending") else journal["checkpoint"]
    engine = decode(value)
    g = engine.grid
    # A non-Troy run retains its own grid; never silently reproject a checkpoint.
    baseline = GRID if g.crs == GRID["crs"] and g.cell_m == GRID["cell_m"] else vars(g)
    x0, y0 = min(g.x0, baseline["x0"]), min(g.y0, baseline["y0"])
    x1 = max(g.x0+g.width*g.cell_m, baseline["x0"]+baseline["width"]*g.cell_m)
    y1 = max(g.y0+g.height*g.cell_m, baseline["y0"]+baseline["height"]*g.cell_m)
    for parcel in engine.parcels.values():
        x0, y0 = min(x0, parcel.x-margin_m), min(y0, parcel.y-margin_m)
        x1, y1 = max(x1, parcel.x+margin_m), max(y1, parcel.y+margin_m)
    tile = 32*g.cell_m
    x0 = g.x0-math.ceil((g.x0-x0)/tile)*tile
    y0 = g.y0-math.ceil((g.y0-y0)/tile)*tile
    width, height = math.ceil((x1-x0)/tile)*32, math.ceil((y1-y0)/tile)*32
    if max(width, height) > max_axis_cells:
        raise ValueError("content exceeds live coverage budget; widen/deploy regional tracking coverage")
    return {"crs":g.crs,"x0":x0,"y0":y0,"cell_m":g.cell_m,"width":width,"height":height}


def acquisition_time(key):
    match = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)", key)
    if not match:
        raise ValueError("unrecognized NOAA acquisition timestamp")
    year, day, hour, minute, second, tenth = map(int, match.groups())
    return datetime(year,1,1,tzinfo=UTC)+timedelta(days=day-1,hours=hour,minutes=minute,seconds=second,microseconds=tenth*100000)


class Catalog:
    def __init__(self, bucket="noaa-goes19"):
        if not re.fullmatch(r"noaa-goes\d{2}", bucket):
            raise ValueError("choose an explicit NOAA GOES bucket")
        self.base = f"https://{bucket}.s3.amazonaws.com"

    def keys(self, product, hour):
        prefix = f"{product}/{hour:%Y/%j/%H}/"
        token, result = None, []
        for _ in range(20):
            query = {"list-type":"2", "prefix":prefix}
            if token:
                query["continuation-token"] = token
            with urlopen(self.base+"/?"+urlencode(query),timeout=30) as response:
                raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise ValueError("catalog page too large")
            root = ET.fromstring(raw)
            result.extend(e.text for e in root.findall(".//{*}Key") if e.text.endswith(".nc"))
            new_token = root.findtext("{*}NextContinuationToken")
            if root.findtext("{*}IsTruncated") != "true":
                return result
            if not new_token or new_token == token:
                raise ValueError("invalid catalog pagination")
            token = new_token
        raise ValueError("catalog pagination limit reached")


def discover(catalog, now, grid=GRID, max_age_s=1200):
    """No archive/synthetic fallback. Keep newest two masks for motion correction."""
    products = {}
    for product in ("ABI-L2-ACMC","ABI-L2-ACHAC","ABI-L2-CMIPC","ABI-L2-DMWC"):
        keys = []
        for offset in (1,0):
            keys.extend(catalog.keys(product, now-timedelta(hours=offset)))
        if product == "ABI-L2-CMIPC":
            keys = [key for key in keys if re.search(r"-M\dC13_",key)]
        products[product] = sorted(set(keys),key=acquisition_time)
    masks = [key for key in products["ABI-L2-ACMC"]
             if 0 <= (now-acquisition_time(key)).total_seconds() <= max_age_s]
    if not masks:
        raise ValueError("no fresh NOAA cloud mask; current sky unavailable (no replay fallback)")
    observations = []
    for mask in masks[-2:]:
        at = acquisition_time(mask)
        item = {"mask":catalog.base+"/"+mask}
        for product, name, age in (("ABI-L2-ACHAC","height",300),
                                    ("ABI-L2-CMIPC","image",300), ("ABI-L2-DMWC","wind",3600)):
            candidates = [key for key in products[product] if 0 <= (at-acquisition_time(key)).total_seconds() <= age]
            if candidates:
                item[name] = catalog.base+"/"+candidates[-1]
                if name == "wind":
                    item["windFormat"] = "dmw"
        observations.append(item)
    return {"synthetic":False,"discoveredAt":iso(now),"grid":grid,"acceptedDqf":[0],
            "observations":observations}


def atomic_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data,indent=2),encoding="utf-8")
    temporary.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Current real-sky NOAA acquisition for Drift")
    parser.add_argument("--bucket",default="noaa-goes19")
    parser.add_argument("--dataset",default="troy-live")
    parser.add_argument("--run-id",default="regional-v1")
    parser.add_argument("--state-dir",type=Path,default=Path("services/cloud-worker/.worker-state/current-sky"))
    parser.add_argument("--output",type=Path,default=Path("services/cloud-worker/out/current-sky.jsonl"))
    parser.add_argument("--publish",action="store_true")
    parser.add_argument("--once",action="store_true")
    parser.add_argument('--tracking-policy',choices=('all','content'),default='content')
    parser.add_argument("--poll-seconds",type=int,default=300)
    args = parser.parse_args(argv)
    if args.dataset.endswith("-demo") or args.dataset.startswith("fx-") or args.poll_seconds < 60:
        parser.error("use a dedicated live dataset and polling interval >=60 seconds")
    catalog = Catalog(args.bucket)
    args.state_dir.mkdir(parents=True,exist_ok=True)
    lock = args.state_dir/"acquisition.lock"
    # Independent lock prevents two supervisors racing the manifest/journal.
    with lock.open("x",encoding="utf-8") as stream:
        import os
        stream.write(str(os.getpid()))
    try:
        while True:
            now = datetime.now(UTC)
            try:
                manifest = discover(catalog,now)
                manifest["grid"] = coverage_grid(args.state_dir)
                path = args.state_dir/"current-manifest.json"
                atomic_json(path,manifest)
                command = ["--mode","live","--dataset",args.dataset,"--run-id",args.run_id,
                           "--manifest",str(path),"--state-dir",str(args.state_dir),"--output",str(args.output),
                           "--max-observation-age-seconds","1200","--tracking-policy",args.tracking_policy]
                if args.publish:
                    command.append("--publish")
                code = worker_main(command, propagate_transport_errors=True)
                latest = acquisition_time(manifest["observations"][-1]["mask"])
                status = {"checkedAt":iso(datetime.now(UTC)),"observationAt":iso(latest),
                          "datasetId":args.dataset,"synthetic":False,"status":"live" if code == 0 else "error",
                          "windProductAvailable": "wind" in manifest["observations"][-1]}
            except (OSError,ValueError,ET.ParseError,TransportUnavailable) as error:
                code = 1
                status = {"checkedAt":iso(datetime.now(UTC)),"datasetId":args.dataset,
                          "synthetic":False,"status":"unavailable","reason":str(error)}
            atomic_json(args.state_dir/"acquisition-status.json",status)
            print(json.dumps(status),flush=True)
            if args.once:
                return code
            # Ingestion errors need operator reconciliation; don't overwrite a pending journal.
            if code and status["status"] == "error":
                return code
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        return 0
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
