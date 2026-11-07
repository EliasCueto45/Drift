"""Many-to-many geographic association, independent of persistence."""
from dataclasses import dataclass, replace
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from shapely.geometry import MultiPolygon
from shapely.ops import transform

from .models import Frame, Region, Track, iso
from .wind import advect


def stable_id(*parts):
    return str(uuid5(NAMESPACE_URL, "/".join(map(str, parts))))


def move_geometry(geometry, grid, field, altitude, start, end):
    def move(x, y, z=None):
        try:
            pairs = [advect(a, b, grid, field, altitude, start, end) for a, b in zip(x, y)]
            return tuple(zip(*pairs))
        except TypeError:
            return advect(x, y, grid, field, altitude, start, end)
    moved = transform(move, geometry)
    # No fabricated repair across self-intersecting deformation.
    if not moved.is_valid or moved.is_empty:
        return geometry
    return MultiPolygon([moved]) if moved.geom_type == "Polygon" else moved


@dataclass
class Association:
    tracks: dict[str, Track]
    successors: dict[str, list[str]]
    retired: dict[str, Track]
    events: list[dict]


def associate(tracks: dict[str, Track], regions: list[Region], frame: Frame, motion,
              dataset_id: str, run_id: str) -> Association:
    at, grid = frame.observed_at, frame.grid
    predicted = {}
    for key, track in tracks.items():
        if track.kind == "created" or track.status == "expired":
            continue
        end = min(at, track.observed_at+timedelta(minutes=30))
        end = max(track.position_at, end)
        geometry = move_geometry(track.geometry, grid, motion, track.altitude_m, track.position_at, end)
        predicted[key] = replace(track, geometry=geometry, position_at=end)
    edges = {key: set() for key in predicted}
    reverse = {i: set() for i in range(len(regions))}
    for key, track in predicted.items():
        for i, region in enumerate(regions):
            if abs(track.altitude_m-region.altitude_m) > 3000:
                continue
            overlap = track.geometry.intersection(region.geometry).area
            smaller = min(track.geometry.area, region.geometry.area)
            if smaller > 0 and overlap/smaller >= .05:
                edges[key].add(i)
                reverse[i].add(key)
    result, retired, successors, events = {}, {}, {}, []
    visited = set()
    for i in range(len(regions)):
        if i in visited:
            continue
        todo, children, parents = [i], set(), set()
        while todo:
            child = todo.pop()
            if child in children:
                continue
            children.add(child)
            parents |= reverse[child]
            for parent in reverse[child]:
                todo.extend(edges[parent]-children)
        visited |= children
        simple = len(parents) == len(children) == 1
        targets = []
        for child in sorted(children):
            region = regions[child]
            key = next(iter(parents)) if simple else stable_id(dataset_id, run_id, iso(at), child)
            prior = predicted.get(key)
            lon, lat = grid.transformer(True).transform(region.geometry.centroid.x, region.geometry.centroid.y)
            confidence = motion.at(lon, lat, region.altitude_m, at).confidence
            # Uncorrected parallax and estimated height cap advertised precision.
            confidence = min(.7 if frame.height_estimated else .85, max(.2, confidence))
            result[key] = Track(key, region.geometry, region.altitude_m, at, at,
                                version=prior.version+1 if prior else 1,
                                confidence=confidence,
                                parents=prior.parents if prior else sorted(parents))
            targets.append(key)
        for parent in parents:
            successors[parent] = sorted(targets)
            if not simple:
                retired[parent] = replace(predicted[parent], status="expired", version=predicted[parent].version+1)
        kinds = (["updated"] if simple else ["created"] if not parents else
                 (["merged"] if len(parents) > 1 else []) + (["split"] if len(children) > 1 else []))
        for kind in kinds:
            events.append({"eventId": stable_id(dataset_id, run_id, iso(at), kind, *targets),
                           "type": kind, "sourceCloudIds": sorted(parents),
                           "targetCloudIds": sorted(targets), "effectiveAt": iso(at)})
    for key, track in predicted.items():
        if not edges[key]:
            result[key] = replace(track, status="uncertain", confidence=track.confidence*.8,
                                  version=track.version+1)
            successors[key] = [key]
    return Association(result, successors, retired, events)
