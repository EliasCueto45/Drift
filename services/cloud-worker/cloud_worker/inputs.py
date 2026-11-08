"""Explicit local/NOAA product acquisition; no implicit synthetic live fallback."""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

import numpy as np

from .models import Grid
from .satellite import load_goes, load_dmw
from .state import read_frame
from .wind import WindField


def acquire(value, root, cache):
    parsed = urlparse(value)
    if not parsed.scheme or (len(parsed.scheme) == 1 and value[1:3] in (":\\", ":/")):
        path = Path(value)
        return path if path.is_absolute() else root/path
    host = parsed.hostname or ""
    noaa = host.endswith(".noaa.gov") or (host.startswith("noaa-goes") and host.endswith(".s3.amazonaws.com"))
    if parsed.scheme != "https" or not noaa or parsed.username or parsed.password:
        raise ValueError("remote satellite inputs must be HTTPS NOAA products")
    cache.mkdir(parents=True, exist_ok=True)
    path = cache/(hashlib.sha256(value.encode()).hexdigest()+".nc")
    if path.exists():
        return path
    temporary = path.with_suffix(".part")
    try:
        with urlopen(value, timeout=60) as response, temporary.open("wb") as stream:
            # Check final host too: reject redirects outside the source allowlist.
            final = urlparse(response.geturl())
            if final.hostname != host or final.scheme != "https":
                raise ValueError("satellite source redirected outside its host")
            size = 0
            while chunk := response.read(1024*1024):
                size += len(chunk)
                if size > 128*1024*1024:
                    raise ValueError("satellite input exceeds 128 MiB")
                stream.write(chunk)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def observation_inputs(manifest_path, cache):
    path = Path(manifest_path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    grid = Grid(**manifest["grid"])
    previous_at = None
    for item in manifest["observations"]:
        def product(name):
            return acquire(item[name], path.parent, cache) if item.get(name) else None
        mask = product("mask")
        frame = load_goes(mask, grid, height_path=product("height"), image_path=product("image"),
                          accepted_dqf=tuple(manifest.get("acceptedDqf", [0])),
                          assumed_height_m=manifest.get("assumedHeightM", 2000),
                          height_reference=manifest.get('heightReference'),
                          parallax=manifest.get('parallaxCorrection',False),
                          geoid_undulation_m=manifest.get('geoidUndulationM'))
        if previous_at is not None and frame.observed_at <= previous_at:
            raise ValueError("manifest products must have strictly increasing acquisition times")
        previous_at = frame.observed_at
        wind_path = product("wind")
        winds = load_dmw(wind_path) if item.get("windFormat") == "dmw" else WindField.from_json(wind_path) if wind_path else WindField()
        yield frame, winds


def synthetic_inputs(path):
    """Fixture files are explicitly synthetic, never presented as satellite history."""
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if value.get("synthetic") is not True:
        raise ValueError("synthetic fixture must label itself")
    grid = Grid(**value["grid"])
    for item in value["frames"]:
        mask, valid = np.zeros(grid.shape, bool), np.ones(grid.shape, bool)
        for x0, y0, x1, y1 in item.get("rectangles", []):
            mask[y0:y1, x0:x1] = True
        if item.get("outage"):
            valid[:] = False
        yield read_frame({"observedAt": item["at"], "grid": value["grid"], "cloudy": mask.tolist(),
                          "valid": valid.tolist(), "altitudeM": np.full(grid.shape, 2000).tolist(),
                          "source": "SYNTHETIC FIXTURE", "image": None, "heightEstimated": True}), WindField()
