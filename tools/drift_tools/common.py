import json
import math
from pathlib import Path
from drift_api.validation import validate

ROOT = Path(__file__).resolve().parents[2]
RADIUS = 6371008.8


def scenarios():
    result = []
    for directory in sorted((ROOT / "fixtures/scenarios").iterdir()):
        meta = json.loads((directory / "scenario.json").read_text())
        result.append(
            {
                "name": directory.name,
                "meta": meta,
                "batches": [
                    {"file": file, "body": json.loads((directory / file).read_text())}
                    for file in meta["batches"]
                ],
            }
        )
    return result


def wind_to_uv(speed, degrees):
    angle = math.radians(degrees)
    return {"uMps": -speed * math.sin(angle), "vMps": -speed * math.cos(angle)}


def displace_meters(point, east, north):
    return {
        "longitude": point["longitude"]
        + math.degrees(east / (RADIUS * math.cos(math.radians(point["latitude"])))),
        "latitude": point["latitude"] + math.degrees(north / RADIUS),
    }


def haversine_m(a, b):
    dlat, dlon = math.radians(b["latitude"] - a["latitude"]), math.radians(b["longitude"] - a["longitude"])
    s = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(a["latitude"]))
        * math.cos(math.radians(b["latitude"]))
        * math.sin(dlon / 2) ** 2
    )
    return 2 * RADIUS * math.asin(math.sqrt(min(1, s)))


def validate_fixtures():
    all_scenarios = scenarios()
    assert all_scenarios, "No scenarios found"
    seen_batches, seen_events = set(), set()
    for scenario in all_scenarios:
        previous = 0
        for entry in scenario["batches"]:
            batch = validate("TrackingBatch", entry["body"])
            assert batch["sequence"] == previous + 1
            previous = batch["sequence"]
            assert batch["datasetId"] == scenario["meta"]["datasetId"]
            assert batch["batchId"] not in seen_batches
            seen_batches.add(batch["batchId"])
            for event in batch["events"]:
                assert event["eventId"] not in seen_events
                seen_events.add(event["eventId"])
            for cloud in batch["snapshots"]:
                assert (
                    cloud["datasetId"] == batch["datasetId"]
                    and cloud["trackingRunId"] == batch["trackingRunId"]
                )
                for polygon in cloud["geometry"]["coordinates"]:
                    for ring in polygon:
                        assert ring[0] == ring[-1]
                        assert all(-75 < lng < -72 and 42 < lat < 43.5 for lng, lat in ring)
        for message in scenario["meta"]["seed"]["messages"]:
            validate("Message", message)
            assert -75 < message["anchor"]["longitude"] < -72 and 42 < message["anchor"]["latitude"] < 43.5
    return len(all_scenarios), len(seen_batches)
