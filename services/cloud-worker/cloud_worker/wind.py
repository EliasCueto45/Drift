"""Altitude/time-aware wind sampling and geodesic parcel transport."""
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
import json
import math
from pathlib import Path

from pyproj import Geod

from .models import Grid, timestamp

GEOD = Geod(ellps="WGS84")


@dataclass(frozen=True)
class Wind:
    u: float = 0
    v: float = 0
    confidence: float = 0
    altitude_m: float = 2000
    source: str = "unavailable"
    valid_at: datetime | None = None
    correlated: bool = False


@dataclass(frozen=True)
class Sample:
    longitude: float
    latitude: float
    altitude_m: float
    at: datetime
    wind: Wind


def from_direction(speed: float, from_degrees: float) -> tuple[float, float]:
    if speed < 0 or not all(math.isfinite(v) for v in (speed, from_degrees)):
        raise ValueError("invalid wind speed/direction")
    angle = math.radians(from_degrees)
    return -speed * math.sin(angle), -speed * math.cos(angle)


def blend(a: Wind, b: Wind, weight_b: float) -> Wind:
    w = weight_b
    return Wind(a.u * (1-w) + b.u * w, a.v * (1-w) + b.v * w,
                min(a.confidence, b.confidence), a.altitude_m * (1-w) + b.altitude_m * w,
                a.source if a.source == b.source else f"{a.source}+{b.source}",
                a.valid_at, a.correlated or b.correlated)


class WindField:
    def __init__(self, samples=(), max_age_s=3600, max_distance_m=100_000):
        self.samples = list(samples)
        self.max_age_s = max_age_s
        self.max_distance_m = max_distance_m
        for sample in self.samples:
            if not (-180 <= sample.longitude <= 180 and -90 <= sample.latitude <= 90):
                raise ValueError("invalid wind coordinate")
            if sample.at.tzinfo is None or not all(math.isfinite(v) for v in
                    (sample.altitude_m, sample.wind.u, sample.wind.v, sample.wind.confidence)):
                raise ValueError("invalid wind sample")
            if not 0 <= sample.wind.confidence <= 1 or sample.altitude_m < 0:
                raise ValueError("invalid wind quality/height")
        self.times = sorted({s.at for s in self.samples})
        self.buckets = {}
        for sample in self.samples:
            longitude = (sample.longitude+180) % 360-180
            self.buckets.setdefault((sample.at, math.floor(longitude), math.floor(sample.latitude)), []).append(sample)

    def _nearby(self, at, lon, lat):
        # Degree buckets prune full-disk DMW vectors before exact geodesic checks.
        lat_radius = self.max_distance_m/110_000 + .1
        lon_radius = min(180, lat_radius/max(.01, math.cos(math.radians(lat))))
        samples = []
        for x in range(math.floor(lon-lon_radius), math.floor(lon+lon_radius)+1):
            for y in range(math.floor(lat-lat_radius), math.floor(lat+lat_radius)+1):
                wrapped = (x+180) % 360-180
                samples.extend(self.buckets.get((at, wrapped, y), ()))
        return samples

    @classmethod
    def from_json(cls, path: str | Path):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("units") != "m/s" or data.get("heightUnits") != "m":
            raise ValueError("wind input requires m/s and geometric height in m")
        samples = []
        for item in data["samples"]:
            at = timestamp(item["validAt"])
            u, v = ((item["uMps"], item["vMps"]) if "uMps" in item else
                    from_direction(item["speedMps"], item["directionFromDeg"]))
            samples.append(Sample(item["longitude"], item["latitude"], item["altitudeM"], at,
                                  Wind(u, v, item["confidence"], item["altitudeM"],
                                       data["source"], at, data.get("correlatedWithImagery", False))))
        return cls(samples)

    def _spatial(self, samples, lon, lat, altitude):
        columns = {}
        for s in samples:
            columns.setdefault((s.longitude, s.latitude), []).append(s)
        candidates = []
        for (x, y), levels in columns.items():
            distance = GEOD.inv(lon, lat, x, y)[2]
            if distance > self.max_distance_m:
                continue
            levels.sort(key=lambda s: s.altitude_m)
            low = max((s for s in levels if s.altitude_m <= altitude),
                      key=lambda s: s.altitude_m, default=levels[0])
            high = min((s for s in levels if s.altitude_m >= altitude),
                       key=lambda s: s.altitude_m, default=levels[-1])
            if low.altitude_m != high.altitude_m:
                w = (altitude - low.altitude_m) / (high.altitude_m - low.altitude_m)
                wind = blend(low.wind, high.wind, w)
            else:
                # Nearest height and surface-only fallbacks explicitly lose confidence.
                penalty = 1 / (1 + abs(altitude - low.altitude_m) / 1500)
                wind = replace(low.wind, confidence=low.wind.confidence * penalty)
            candidates.append((distance, wind))
        if not candidates:
            return Wind(altitude_m=altitude)
        candidates.sort(key=lambda p: p[0])
        candidates = candidates[:4]
        if candidates[0][0] < 1:
            return candidates[0][1]
        weights = [1 / max(d, 1)**2 for d, _ in candidates]
        total = sum(weights)
        base = candidates[0][1]
        return replace(base, u=sum(w*s.u for w, (_, s) in zip(weights, candidates)) / total,
                       v=sum(w*s.v for w, (_, s) in zip(weights, candidates)) / total,
                       confidence=sum(w*s.confidence for w, (_, s) in zip(weights, candidates)) / total,
                       correlated=any(s.correlated for _, s in candidates))

    def at(self, lon: float, lat: float, altitude: float, at: datetime) -> Wind:
        times = [t for t in self.times if abs((t-at).total_seconds()) <= self.max_age_s]
        if not times:
            return Wind(altitude_m=altitude)
        before = max((t for t in times if t <= at), default=times[0])
        after = min((t for t in times if t >= at), default=times[-1])
        a = self._spatial(self._nearby(before, lon, lat), lon, lat, altitude)
        b = self._spatial(self._nearby(after, lon, lat), lon, lat, altitude)
        if before == after:
            age_penalty = max(0, 1 - abs((at-before).total_seconds()) / self.max_age_s)
            return replace(a, confidence=a.confidence * age_penalty)
        return blend(a, b, (at-before).total_seconds() / (after-before).total_seconds())


def advect(x: float, y: float, grid: Grid, field, altitude: float,
           start: datetime, end: datetime) -> tuple[float, float]:
    """Caller limits the total horizon; field is sampled at <=60s steps."""
    if end < start:
        raise ValueError("cannot advect backwards")
    to_geo, to_metric = grid.transformer(True), grid.transformer()
    at = start
    while at < end:
        dt = min(60, (end-at).total_seconds())
        lon, lat = to_geo.transform(x, y)
        wind = field.at(lon, lat, altitude, at + timedelta(seconds=dt/2))
        if wind.confidence > 0:
            azimuth = math.degrees(math.atan2(wind.u, wind.v))
            lon, lat, _ = GEOD.fwd(lon, lat, azimuth, math.hypot(wind.u, wind.v) * dt)
            x, y = to_metric.transform(lon, lat)
        at += timedelta(seconds=dt)
    return x, y
