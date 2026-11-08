"""Deterministic synthetic scenarios. Coordinates and clocks are never live data."""

import json
import math
from datetime import datetime, timedelta, timezone
from .common import ROOT, displace_meters, wind_to_uv

T0 = datetime(2026, 10, 24, 15, tzinfo=timezone.utc)
TROY = {"longitude": -73.6918, "latitude": 42.7284}
WEST = wind_to_uv(10, 270)


def iso(minutes):
    return (T0 + timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def rounded(value):
    result = math.floor(value * 1e6 + 0.5) / 1e6
    return int(result) if result.is_integer() else result


def at(east, north=0):
    return displace_meters(TROY, east, north)


def move(anchor, east, north=0):
    return displace_meters(anchor, east, north)


def anchor(point):
    return {key: rounded(value) for key, value in point.items()}


def square(center, half):
    ring = [
        [rounded(p["longitude"]), rounded(p["latitude"])]
        for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]
        for p in [move(center, x * half, y * half)]
    ]
    return {"type": "MultiPolygon", "coordinates": [[ring]]}


def cloud(
    id,
    center,
    minute,
    ds,
    version=1,
    status="active",
    half=2000,
    parents=None,
    kind="observed",
    confidence=0.85,
    wind_conf=0.8,
):
    return {
        "id": id,
        "version": version,
        "kind": kind,
        "status": status,
        "geometry": square(center, half),
        "observedAt": iso(minute),
        "updatedAt": iso(minute),
        "confidence": confidence,
        "wind": {
            "uMps": rounded(WEST["uMps"]),
            "vMps": rounded(WEST["vMps"]),
            "altitudeM": 2000,
            "source": "fixture:synthetic",
            "validAt": iso(minute),
            "confidence": wind_conf,
        },
        "parentIds": parents or [],
        "creatorId": "user_fixture_alice" if kind == "created" else None,
        "expiresAt": iso(1440) if kind == "created" else None,
        "datasetId": ds,
        "trackingRunId": ds + "-run1",
    }


def message(id, cloud_id, point, body):
    return {
        "id": id,
        "version": 1,
        "cloudId": cloud_id,
        "authorId": "user_fixture_alice",
        "kind": "text",
        "anchor": anchor(point),
        "createdAt": iso(-5),
        "updatedAt": iso(-5),
        "expiredAt": None,
        "voteCount": 0,
        "viewerHasUpvoted": False,
        "body": body,
        "assetId": None,
        "songUrl": None,
        "artworkTransform": None,
    }


def batch(ds, sequence, minute, snapshots, events=None, updates=None):
    return {
        "schemaVersion": 1,
        "batchId": f"{ds}-b{sequence:03}",
        "datasetId": ds,
        "trackingRunId": ds + "-run1",
        "sequence": sequence,
        "observedAt": iso(minute),
        "snapshots": snapshots,
        "events": events or [],
        "anchorUpdates": updates or [],
    }


def event(ds, n, kind, sources, targets, minute):
    return {
        "eventId": f"{ds}-e{n}",
        "type": kind,
        "sourceCloudIds": sources,
        "targetCloudIds": targets,
        "effectiveAt": iso(minute),
    }


def update(msg, action, target, point, version=1):
    return {
        "messageId": msg["id"],
        "expectedMessageVersion": version,
        "targetCloudId": target,
        "anchor": anchor(point),
        "action": action,
    }


def generate():
    # Existing scenario metadata supplies descriptions/acceptance expectations;
    # all time-varying cloud/message/batch data is constructed here.
    generated = {}
    ds, a, b = "fx-scattered", at(-6000), at(2000, 5000)
    ma, mb = (
        message("msg_scat_a1", "cld_scat_a", a, "hello from cloud A"),
        message("msg_scat_b1", "cld_scat_b", b, "hello from cloud B"),
    )
    generated["scattered-advection"] = (
        [ma, mb],
        [
            batch(
                ds,
                1,
                0,
                [cloud("cld_scat_a", a, 0, ds), cloud("cld_scat_b", b, 0, ds)],
                [
                    event(ds, 1, "created", [], ["cld_scat_a"], 0),
                    event(ds, 2, "created", [], ["cld_scat_b"], 0),
                ],
            ),
            batch(
                ds,
                2,
                10,
                [
                    cloud("cld_scat_a", move(a, 6000), 10, ds, 2),
                    cloud("cld_scat_b", move(b, 6000), 10, ds, 2),
                ],
                [
                    event(ds, 3, "updated", ["cld_scat_a"], ["cld_scat_a"], 10),
                    event(ds, 4, "updated", ["cld_scat_b"], ["cld_scat_b"], 10),
                ],
                [
                    update(ma, "move", "cld_scat_a", move(a, 6000)),
                    update(mb, "move", "cld_scat_b", move(b, 6000)),
                ],
            ),
        ],
    )
    ds, w, e = "fx-overcast", at(-10000), at(10000)
    mw, me = (
        message("msg_oc_w", "cld_overcast", w, "far west note"),
        message("msg_oc_e", "cld_overcast", e, "far east note"),
    )
    generated["overcast"] = (
        [mw, me],
        [
            batch(
                ds,
                1,
                0,
                [cloud("cld_overcast", at(0), 0, ds, half=25000)],
                [event(ds, 1, "created", [], ["cld_overcast"], 0)],
            ),
            batch(
                ds,
                2,
                10,
                [cloud("cld_overcast", at(3000), 10, ds, 2, half=22000)],
                [event(ds, 2, "updated", ["cld_overcast"], ["cld_overcast"], 10)],
                [
                    update(mw, "move", "cld_overcast", move(w, 6000)),
                    update(me, "move", "cld_overcast", move(e, 6000)),
                ],
            ),
        ],
    )
    ds, a, b = "fx-merge", at(-3000), at(3000)
    ma, mb = message("msg_mg_a", "cld_mg_a", a, "note on A"), message("msg_mg_b", "cld_mg_b", b, "note on B")
    generated["merge"] = (
        [ma, mb],
        [
            batch(
                ds,
                1,
                0,
                [cloud("cld_mg_a", a, 0, ds), cloud("cld_mg_b", b, 0, ds)],
                [event(ds, 1, "created", [], ["cld_mg_a"], 0), event(ds, 2, "created", [], ["cld_mg_b"], 0)],
            ),
            batch(
                ds,
                2,
                10,
                [
                    cloud("cld_mg_a", a, 10, ds, 2, "expired"),
                    cloud("cld_mg_b", b, 10, ds, 2, "expired"),
                    cloud("cld_mg_m", at(0), 10, ds, half=6000, parents=["cld_mg_a", "cld_mg_b"]),
                ],
                [event(ds, 3, "merged", ["cld_mg_a", "cld_mg_b"], ["cld_mg_m"], 10)],
                [update(ma, "move", "cld_mg_m", move(a, 500)), update(mb, "move", "cld_mg_m", move(b, -500))],
            ),
        ],
    )
    ds, left, right = "fx-split", at(-4000), at(4000)
    ml, mr = (
        message("msg_sp_l", "cld_sp_m", left, "west half note"),
        message("msg_sp_r", "cld_sp_m", right, "east half note"),
    )
    generated["split"] = (
        [ml, mr],
        [
            batch(
                ds,
                1,
                0,
                [cloud("cld_sp_m", at(0), 0, ds, half=7000)],
                [event(ds, 1, "created", [], ["cld_sp_m"], 0)],
            ),
            batch(
                ds,
                2,
                10,
                [
                    cloud("cld_sp_m", at(0), 10, ds, 2, "expired", 7000),
                    cloud("cld_sp_s1", at(-5000), 10, ds, half=3000, parents=["cld_sp_m"]),
                    cloud("cld_sp_s2", at(5000), 10, ds, half=3000, parents=["cld_sp_m"]),
                ],
                [event(ds, 2, "split", ["cld_sp_m"], ["cld_sp_s1", "cld_sp_s2"], 10)],
                [
                    update(ml, "move", "cld_sp_s1", move(left, -1000)),
                    update(mr, "move", "cld_sp_s2", move(right, 1000)),
                ],
            ),
        ],
    )
    ds, center = "fx-dissipation", at(0)
    msg = message("msg_ds_1", "cld_ds", center, "this one will clear")
    generated["dissipation"] = (
        [msg],
        [
            batch(
                ds,
                1,
                0,
                [cloud("cld_ds", center, 0, ds, confidence=0.6)],
                [event(ds, 1, "created", [], ["cld_ds"], 0)],
            ),
            *[
                batch(
                    ds,
                    seq,
                    minute,
                    [
                        cloud(
                            "cld_ds",
                            center,
                            minute,
                            ds,
                            seq,
                            "expired" if seq == 4 else "active",
                            confidence=0.6,
                        )
                    ],
                    [event(ds, 2, "dissipated", ["cld_ds"], [], minute)] if seq == 4 else [],
                    [update(msg, "expire" if seq == 4 else "hold", None, center, seq - 1)],
                )
                for seq, minute in [(2, 5), (3, 10), (4, 16)]
            ],
        ],
    )
    ds, center = "fx-outage", at(0)
    msg = message("msg_out_1", "cld_out", center, "survives the outage")
    generated["outage"] = (
        [msg],
        [
            batch(ds, 1, 0, [cloud("cld_out", center, 0, ds)], [event(ds, 1, "created", [], ["cld_out"], 0)]),
            batch(
                ds,
                2,
                45,
                [
                    cloud(
                        "cld_out", move(center, 18000), 45, ds, 2, "uncertain", confidence=0.2, wind_conf=0.3
                    )
                ],
                [event(ds, 2, "uncertain", ["cld_out"], ["cld_out"], 45)],
                [update(msg, "hold", "cld_out", center)],
            ),
        ],
    )
    generated["clear-sky"] = ([], [batch("fx-clear", 1, 0, [])])
    ds, center = "fx-created", at(0, 3000)
    msg = message("msg_cr_1", "cld_created", center, "my own cloud")
    generated["created-cloud"] = (
        [msg],
        [
            batch(
                ds,
                1,
                0,
                [
                    cloud("cld_created", center, 0, ds, half=2500, kind="created"),
                    cloud("cld_created_neighbor", move(center, 1500), 0, ds, half=3000),
                ],
                [event(ds, 1, "created", [], ["cld_created"], 0)],
            ),
            batch(
                ds,
                2,
                10,
                [
                    cloud("cld_created", move(center, 6000), 10, ds, 2, half=2500, kind="created"),
                    cloud("cld_created_neighbor", move(center, 7500), 10, ds, 2, half=3000),
                ],
                [event(ds, 2, "updated", ["cld_created"], ["cld_created"], 10)],
                [update(msg, "move", "cld_created", move(center, 6000))],
            ),
        ],
    )
    return generated


def write_fixtures(check=False):
    outputs = {}
    for name, (messages, batches) in generate().items():
        directory = ROOT / "fixtures/scenarios" / name
        # Metadata is maintained separately from generated batch/seed payloads.
        specs = json.loads((ROOT / "tools/drift_tools/scenarios.json").read_text())
        spec = specs[name]
        meta = {key: spec[key] for key in ("name", "description", "datasetId", "synthetic")}
        meta.update(
            batches=[f"batch-{b['sequence']:03}.json" for b in batches],
            seed={
                "users": [{"id": "user_fixture_alice", "displayName": "Alice (fixture)", "avatarUrl": None}],
                "messages": messages,
            },
            expect=spec["expect"],
        )
        outputs[directory / "scenario.json"] = meta
        outputs.update({directory / file: body for file, body in zip(meta["batches"], batches, strict=True)})
    for path, value in outputs.items():
        encoded = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        if check:
            assert path.is_file() and json.loads(path.read_text()) == value, (
                f"Generated fixture differs: {path.relative_to(ROOT)}"
            )
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(encoded, encoding="utf-8", newline="\n")
    return len(outputs)
