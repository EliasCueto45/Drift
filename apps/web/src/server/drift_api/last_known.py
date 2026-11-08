"""Read-only public cloud fallback independent of Atlas; no message bodies are cached."""
import json
import os
from pathlib import Path

from .geometry import footprint_distance_m
from .validation import ApiError, fail, limit, location, now, radius, timestamp, validate


def last_known_sky(params):
    anchor, distance, size = location(params), radius(params), limit(params)
    configured = os.getenv("DRIFT_SKY_FALLBACK_FILE")
    if not configured:
        fail(503, "LAST_KNOWN_UNAVAILABLE", "No last-known sky is available on this server")
    try:
        path = Path(configured)
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("fallback too large")
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved["datasetId"] != params.get("datasetId"):
            raise ValueError("dataset mismatch")
        clock = now()
        if timestamp(saved["asOf"]) > clock:
            raise ValueError("future observation")
        clouds = []
        for cloud in saved["clouds"]:
            validate("Cloud", cloud)
            if cloud["datasetId"] != saved["datasetId"]:
                raise ValueError("mixed datasets")
            if cloud["status"] in ("expired", "out_of_region"):
                continue
            if cloud["expiresAt"] and timestamp(cloud["expiresAt"]) <= clock:
                continue
            if footprint_distance_m(cloud["geometry"], anchor) <= distance:
                clouds.append({"cloud": cloud, "previews": []})
        synthetic = saved["datasetId"].startswith("fx-") or saved["datasetId"].endswith("-demo")
        return validate("SkyResponse", {
            "data": {"clouds": sorted(clouds, key=lambda c: c["cloud"]["id"])[:size],
                     "asOf": saved["asOf"], "freshness": "replay" if synthetic else "stale", "weather": None},
            "nextCursor": None,
        })
    except (OSError, ValueError, KeyError, TypeError, ApiError):
        fail(503, "LAST_KNOWN_UNAVAILABLE", "Last-known sky is unavailable for this dataset")
