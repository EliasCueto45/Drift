"""JSON checkpoints: atomic replacement, no unsafe pickle deserialization."""
from dataclasses import asdict
import json
from pathlib import Path
import os

import numpy as np
from shapely.geometry import shape, mapping

from .engine import Engine
from .models import ClearEvidence, Frame, Grid, Parcel, Track, iso, timestamp


def scientific_scalar(value):
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"Unsupported checkpoint type: {type(value).__name__}")


def frame_json(frame):
    if frame is None:
        return None
    return {"observedAt": iso(frame.observed_at), "grid": asdict(frame.grid),
            "cloudy": frame.cloudy.tolist(), "valid": frame.valid.tolist(),
            "altitudeM": frame.altitude_m.tolist(), "source": frame.source,
            "image": frame.image.tolist() if frame.image is not None else None,
            "heightEstimated": frame.height_estimated}


def read_frame(value):
    if value is None:
        return None
    return Frame(timestamp(value["observedAt"]), Grid(**value["grid"]),
                 np.array(value["cloudy"], bool), np.array(value["valid"], bool),
                 np.array(value["altitudeM"], float), value["source"],
                 np.array(value["image"], np.float32) if value["image"] is not None else None,
                 value["heightEstimated"])


def encode(engine):
    tracks = []
    for track in engine.tracks.values():
        value = asdict(track)
        value["geometry"] = mapping(track.geometry)
        for key in ("observed_at", "position_at", "expires_at"):
            value[key] = iso(value[key]) if value[key] else None
        tracks.append(value)
    parcels = []
    for parcel in engine.parcels.values():
        value = asdict(parcel)
        value["position_at"] = iso(parcel.position_at) if parcel.position_at else None
        parcels.append(value)
    def evidence(values):
        return {key: {"count": e.count, "first_at": iso(e.first_at) if e.first_at else None,
                      "last_at": iso(e.last_at) if e.last_at else None} for key, e in values.items()}
    return {"formatVersion": 1, "grid": asdict(engine.grid), "datasetId": engine.dataset_id,
            "runId": engine.run_id, "sequence": engine.sequence, "tracks": tracks,
            "parcels": parcels, "pending": engine.pending,
            "cloudEvidence": evidence(engine.cloud_evidence), "parcelEvidence": evidence(engine.parcel_evidence),
            "previous": frame_json(engine.previous)}


def decode(value):
    if value["formatVersion"] != 1:
        raise ValueError("unsupported worker checkpoint")
    engine = Engine(Grid(**value["grid"]), value["datasetId"], value["runId"])
    engine.sequence = value["sequence"]
    for item in value["tracks"]:
        t = dict(item)
        t["geometry"] = shape(t["geometry"])
        for key in ("observed_at", "position_at", "expires_at"):
            t[key] = timestamp(t[key]) if t[key] else None
        engine.tracks[t["id"]] = Track(**t)
    for item in value["parcels"]:
        p = dict(item)
        p["position_at"] = timestamp(p["position_at"]) if p["position_at"] else None
        engine.parcels[p["id"]] = Parcel(**p)
    for key, attr in (("cloudEvidence", "cloud_evidence"), ("parcelEvidence", "parcel_evidence")):
        setattr(engine, attr, {k: ClearEvidence(v["count"], timestamp(v["first_at"]) if v["first_at"] else None,
                                             timestamp(v["last_at"]) if v["last_at"] else None)
                              for k, v in value[key].items()})
    engine.pending = value["pending"]
    engine.previous = read_frame(value["previous"])
    return engine


class Journal:
    """One process per journal; stage before send, advance only after ack."""
    def __init__(self, path, initial):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.value = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {
            "checkpoint": encode(initial), "pending": None}

    def _write(self):
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(self.value, stream, allow_nan=False, separators=(",", ":"), default=scientific_scalar)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def engine(self):
        return decode(self.value["checkpoint"])

    def stage(self, batch, candidate):
        self.value["pending"] = {"batch": batch, "nextState": encode(candidate)}
        self._write()

    def acknowledge(self):
        if self.value["pending"] is None:
            raise ValueError("nothing to acknowledge")
        self.value = {"checkpoint": self.value["pending"]["nextState"], "pending": None}
        self._write()
