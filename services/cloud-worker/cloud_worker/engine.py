"""One observation -> transactional batch; persistence lives in delivery.py."""
from dataclasses import replace
from datetime import timedelta

import numpy as np
import math
from shapely import intersects_xy
from shapely.geometry import Point, box, mapping
from shapely.ops import transform

from .association import associate, move_geometry, stable_id
from .models import ClearEvidence, Frame, Parcel, Track, iso
from .motion import MotionField
from .satellite import segment
from .wind import advect


class Engine:
    def __init__(self, grid, dataset_id, run_id):
        self.grid, self.dataset_id, self.run_id = grid, dataset_id, run_id
        self.tracks: dict[str, Track] = {}
        self.parcels: dict[str, Parcel] = {}
        self.cloud_evidence: dict[str, ClearEvidence] = {}
        self.parcel_evidence: dict[str, ClearEvidence] = {}
        self.pending: dict[str, list[str]] = {}
        self.previous: Frame | None = None
        self.sequence = 0
        self.content_only = False

    def expand_grid(self, grid):
        """Grow coverage without changing the metric coordinate system or losing state."""
        old = self.grid
        if grid == old:
            return
        aligned = all(math.isclose(value, round(value), abs_tol=1e-8) for value in
                      ((old.x0-grid.x0)/old.cell_m, (old.y0-grid.y0)/old.cell_m))
        if (grid.crs != old.crs or grid.cell_m != old.cell_m or not aligned
                or grid.x0 > old.x0 or grid.y0 > old.y0
                or grid.x0+grid.width*grid.cell_m < old.x0+old.width*old.cell_m
                or grid.y0+grid.height*grid.cell_m < old.y0+old.height*old.cell_m):
            raise ValueError("tracking coverage may only expand on the same aligned metric grid")
        self.grid = grid

    def _event(self, kind, sources, targets, at):
        return {"eventId": stable_id(self.dataset_id, self.run_id, iso(at), kind, *sources, *targets),
                "type": kind, "sourceCloudIds": sources, "targetCloudIds": targets, "effectiveAt": iso(at)}

    def _cloud_clear(self, track, frame):
        g = self.grid
        footprint = box(g.x0, g.y0, g.x0+g.width*g.cell_m, g.y0+g.height*g.cell_m)
        if not footprint.covers(track.geometry):
            return False
        x, y = g.centers()
        inside = intersects_xy(track.geometry, x, y)
        return bool(inside.any() and np.all(frame.valid[inside] & ~frame.cloudy[inside]))

    def snapshot(self, track, field, at):
        centroid = track.geometry.centroid
        lon, lat = self.grid.transformer(True).transform(centroid.x, centroid.y)
        wind = field.at(lon, lat, track.altitude_m, at)
        geometry = transform(self.grid.transformer(True).transform, track.geometry)
        altitude=track.altitude or {'meters':float(track.altitude_m),'reference':'unknown',
                                   'source':'legacy-or-server','estimated':True,
                                   'measuredFraction':0.,'parallaxCorrected':False}
        if track.kind == 'created':
            altitude={'meters':float(track.altitude_m),'reference':'mean_sea_level','source':'created-cloud-plane',
                      'estimated':True,'measuredFraction':0.,'parallaxCorrected':False}
        return {"id": track.id, "version": track.version, "kind": track.kind, "status": track.status,
                "altitude":altitude,
                "geometry": mapping(geometry), "observedAt": iso(track.observed_at),
                "updatedAt": iso(track.position_at), "confidence": float(track.confidence),
                "wind": {"uMps": float(wind.u), "vMps": float(wind.v), "altitudeM": float(track.altitude_m),
                         "source": wind.source, "validAt": iso(wind.valid_at or at),
                         "confidence": float(wind.confidence)}, "parentIds": track.parents,
                "creatorId": track.creator_id, "expiresAt": iso(track.expires_at) if track.expires_at else None,
                "datasetId": self.dataset_id, "trackingRunId": self.run_id}

    def step(self, frame, winds):
        if self.previous and frame.observed_at <= self.previous.observed_at:
            raise ValueError("observations must be strictly chronological")
        self.expand_grid(frame.grid)
        if self.previous and (frame.observed_at-self.previous.observed_at).total_seconds() > 450:
            # Five-minute CONUS acquisitions: an acquisition outage is unknown,
            # even when no invalid frame was delivered to the engine.
            self.cloud_evidence.clear()
            self.parcel_evidence.clear()
        at = frame.observed_at
        old = self.tracks
        active = {p.cloud_id for p in self.parcels.values()}
        active.update(c for ids in self.pending.values() for c in ids)
        inactive = {k:t for k,t in old.items() if self.content_only and k not in active
                    and t.kind == 'observed' and t.status != 'expired'}
        motion = MotionField(winds, self.previous if not self.content_only or active else None, frame)
        # Do not split an object merely because bad pixels punched holes in its mask.
        # Any invalid pixel intersecting a predicted track postpones association for it.
        safe, held = {}, {}
        x, y = self.grid.centers()
        for key, track in old.items():
            if key in inactive:
                continue
            horizon = min(at, track.observed_at+timedelta(minutes=30))
            predicted = move_geometry(track.geometry, self.grid, motion, track.altitude_m,
                                      track.position_at, max(track.position_at, horizon))
            touched = intersects_xy(predicted, x, y)
            if track.kind == "observed" and touched.any() and not np.all(frame.valid[touched]):
                held[key] = replace(track, geometry=predicted, position_at=max(track.position_at, horizon),
                                    status="uncertain", confidence=track.confidence*.8, version=track.version+1)
            else:
                safe[key] = track
        regions = [r for r in segment(frame) if not any(r.geometry.intersects(t.geometry) for t in held.values())]
        association = associate(safe, regions, frame, motion, self.dataset_id, self.run_id)
        current = association.tracks | held
        successors = association.successors | {key: [key] for key in held}
        retired = association.retired
        events = association.events
        if self.content_only:
            unoccupied={k for k,t in current.items() if k not in active and not t.parents}
            current={k:t for k,t in current.items() if k not in unoccupied}
            events=[e for e in events if not set(e['targetCloudIds']) & unoccupied]
            # Discovery remains regional; only occupied clouds use temporal matching.
            # Shape-derived empty IDs permit selection without inventing lineage.
            for region in regions:
                if any(region.geometry.intersects(t.geometry) for t in current.values()):
                    continue
                key=stable_id(self.dataset_id,self.run_id,'discovery',region.geometry.wkb_hex)
                same=next((k for k,t in inactive.items() if t.geometry.equals(region.geometry)),None)
                if same:
                    key=same
                elif key in old and old[key].status=='expired':
                    key=stable_id(key,iso(at))  # Never resurrect a retired server record.
                previous=old.get(key)
                current[key]=Track(key,region.geometry,region.altitude_m,at,at,
                                   version=previous.version+1 if previous else 1,
                                   confidence=.5,altitude=region.altitude)
                events.append(self._event('updated' if previous else 'created',
                                          [key] if previous else [],[key],at))
            for key,track in inactive.items():
                if key not in current:
                    retired[key]=replace(track,status='expired',version=track.version+1)
                    # Ending empty discovery is NOT evidence of atmospheric dissipation.
                    events.append(self._event('updated',[key],[],at))
        # Synthetic clouds never enter observed-region association.
        for key, track in old.items():
            if track.kind != "created":
                continue
            if track.expires_at is None:
                raise ValueError("created cloud needs expiresAt")
            end = max(track.position_at, min(at, track.observed_at+timedelta(minutes=30)))
            # A valid wind refresh extends the synthetic prediction window.
            lon, lat = self.grid.transformer(True).transform(track.geometry.centroid.x, track.geometry.centroid.y)
            wind = winds.at(lon, lat, track.altitude_m, at)
            if wind.confidence > 0:
                end = at
            geometry = move_geometry(track.geometry, self.grid, winds, track.altitude_m, track.position_at, end)
            expired = track.status == "expired" or at >= track.expires_at
            current[key] = replace(track, geometry=geometry, position_at=end, version=track.version+1,
                                   observed_at=at if wind.confidence > 0 else track.observed_at,
                                   status="expired" if expired else "active" if wind.confidence > 0 else "uncertain",
                                   confidence=wind.confidence)
            successors[key] = [key]
            if expired:
                events.append(self._event("dissipated", [key], [], at))
        # Whole-footprint evidence is separate from message-local clearing.
        for key, track in list(current.items()):
            if track.kind == "created" or track.status == "active":
                self.cloud_evidence.pop(key, None)
                continue
            footprint = box(self.grid.x0, self.grid.y0,
                            self.grid.x0+self.grid.width*self.grid.cell_m,
                            self.grid.y0+self.grid.height*self.grid.cell_m)
            evidence = self.cloud_evidence.setdefault(key, ClearEvidence())
            if not footprint.covers(track.geometry):
                track.status = "out_of_region"
            if evidence.observe(at, self._cloud_clear(track, frame)):
                track.status = "expired"
                events.append(self._event("dissipated", [key], [], at))
            else:
                events.append(self._event(track.status, [key], [key], at))
        updates = []
        for key, parcel in list(self.parcels.items()):
            origin = old.get(parcel.cloud_id)
            if origin is None:
                raise ValueError(f"parcel {key} references unknown cloud")
            end = min(at, origin.observed_at+timedelta(minutes=30)) if origin.kind == "observed" else current[origin.id].position_at
            start = parcel.position_at or origin.position_at
            end = max(start, end)
            field = winds if origin.kind == "created" else motion
            px, py = advect(parcel.x, parcel.y, self.grid, field, origin.altitude_m, start, end)
            controls = [advect(a, b, self.grid, field, origin.altitude_m, start, end) for a, b in parcel.control_points]
            candidates = set()
            for parent in self.pending.get(key, [parcel.cloud_id]):
                candidates.update(successors.get(parent, [parent]))
            point = Point(px, py)
            eligible = [current[c] for c in sorted(candidates) if c in current and current[c].status != "expired"
                        and current[c].geometry.covers(point)]
            eligible.sort(key=lambda t: (-t.geometry.intersection(origin.geometry).area, t.id))
            target = eligible[0].id if eligible else None
            action = "move" if target else "hold"
            cell = self.grid.cell(px, py)
            clear = bool(cell is not None and frame.valid[cell] and not frame.cloudy[cell])
            evidence = self.parcel_evidence.setdefault(key, ClearEvidence())
            if origin.kind == "observed" and evidence.observe(at, clear):
                action, target = "expire", None
            if origin.kind == "created" and current[origin.id].status == "expired":
                action, target = "expire", None
            if any(current[c].status == "expired" for c in candidates if c in current) and not eligible:
                action, target = "expire", None
            lon, lat = self.grid.transformer(True).transform(px, py)
            update = {"messageId": key, "expectedMessageVersion": parcel.version, "targetCloudId": target,
                      "anchor": {"longitude": lon, "latitude": lat}, "action": action}
            if controls:
                update["artworkControlPoints"] = [dict(zip(("longitude", "latitude"),
                                                   self.grid.transformer(True).transform(a, b))) for a, b in controls]
            updates.append(update)
            if action == "expire":
                del self.parcels[key]
                self.pending.pop(key, None)
                self.parcel_evidence.pop(key, None)
            else:
                # Keep a retired origin internally for orphaned parcels until reassociation.
                self.parcels[key] = replace(parcel, x=px, y=py, cloud_id=target or parcel.cloud_id,
                                            version=parcel.version+1, control_points=controls, position_at=end)
                if target:
                    self.pending.pop(key, None)
                else:
                    self.pending[key] = sorted(candidates)
        # Retired records remain available internally only while an orphan references them.
        needed = {p.cloud_id for p in self.parcels.values()}
        self.tracks = {k: v for k, v in current.items() if v.status != "expired" or k in needed}
        self.tracks.update({k: v for k, v in retired.items() if k in needed})
        self.tracks.update({k: v for k, v in old.items() if k in needed and k not in self.tracks})
        self.previous = frame
        self.sequence += 1
        snapshots = current | retired
        return {"schemaVersion": 1, "batchId": stable_id(self.dataset_id, self.run_id, self.sequence, iso(at)),
                "datasetId": self.dataset_id, "trackingRunId": self.run_id, "sequence": self.sequence,
                "observedAt": iso(at), "snapshots": [self.snapshot(t, motion, at) for _, t in sorted(snapshots.items())],
                "events": events, "anchorUpdates": updates}
