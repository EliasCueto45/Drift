"""GOES ABI NetCDF ingestion using each file's navigation/flag metadata."""
from pathlib import Path

import cv2
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import MultiPolygon, box
from shapely.ops import unary_union
import xarray as xr

from .models import Frame, Grid, Region, timestamp
from .wind import Sample, Wind, WindField, from_direction


def _nearest(axis, values):
    axis = np.asarray(axis, dtype=float)
    if len(axis) < 2 or not (np.all(np.diff(axis) > 0) or np.all(np.diff(axis) < 0)):
        raise ValueError("satellite axes must be strictly monotonic")
    reverse = axis[0] > axis[-1]
    ordered = axis[::-1] if reverse else axis
    valid = np.isfinite(values) & (values >= ordered[0]) & (values <= ordered[-1])
    safe = np.where(np.isfinite(values), values, ordered[0])
    index = np.clip(np.searchsorted(ordered, safe), 1, len(axis)-1)
    index -= (np.abs(safe-ordered[index-1]) < np.abs(safe-ordered[index]))
    return (len(axis)-1-index if reverse else index), valid


def _sample(ds, variable, grid):
    var = ds[variable]
    mapping_name = var.attrs.get("grid_mapping", "goes_imager_projection")
    metadata = ds[mapping_name].attrs
    crs = CRS.from_cf(metadata)
    height = float(metadata["perspective_point_height"])
    xx, yy = grid.centers()
    sx, sy = Transformer.from_crs(grid.crs, crs, always_xy=True).transform(xx, yy)
    xunits, yunits = ds.x.attrs.get("units"), ds.y.attrs.get("units")
    if xunits not in ("rad", "radian", "radians", "m") or yunits != xunits:
        raise ValueError("unsupported satellite coordinate units")
    factor = height if xunits != "m" else 1
    cols, vx = _nearest(ds.x.values * factor, sx)
    rows, vy = _nearest(ds.y.values * factor, sy)
    data = np.asarray(var.transpose("y", "x").values)
    return data[rows, cols].astype(float), vx & vy


def load_goes(mask_path: str | Path, grid: Grid, *, height_path=None, image_path=None,
              accepted_dqf=(0,), assumed_height_m=2000, max_pair_age_s=300) -> Frame:
    """BCM=0 clear, BCM=1 cloudy; all other/missing values are unknown.

    Height and CMI are optional co-timed products with their own navigation.
    Unknown parallax is reported as uncertainty (height_estimated), not hidden.
    """
    with xr.open_dataset(mask_path) as ds:
        at = timestamp(ds.attrs["time_coverage_start"])
        bcm, inside = _sample(ds, "BCM", grid)
        dqf, _ = _sample(ds, "DQF", grid)
        valid = inside & np.isin(bcm, (0, 1)) & np.isin(dqf, accepted_dqf)
        cloudy = bcm == 1
        source = str(ds.attrs.get("dataset_name", Path(mask_path).name))
    heights = np.full(grid.shape, float(assumed_height_m))
    estimated = True
    if height_path:
        with xr.open_dataset(height_path) as ds:
            if abs((timestamp(ds.attrs["time_coverage_start"])-at).total_seconds()) > max_pair_age_s:
                raise ValueError("cloud height product is not co-timed")
            if ds["HT"].attrs.get("units") != "m":
                raise ValueError("cloud height units must be m")
            raw, inside = _sample(ds, "HT", grid)
            quality, _ = _sample(ds, "DQF", grid)
            good = inside & np.isfinite(raw) & (raw >= 0) & (raw <= 25000) & np.isin(quality, accepted_dqf)
            heights[good] = raw[good]
            estimated = not np.all(good[cloudy & valid])
    image = None
    if image_path:
        with xr.open_dataset(image_path) as ds:
            if abs((timestamp(ds.attrs["time_coverage_start"])-at).total_seconds()) > max_pair_age_s:
                raise ValueError("CMI product is not co-timed")
            raw, inside = _sample(ds, "CMI", grid)
            quality, _ = _sample(ds, "DQF", grid)
            good = inside & np.isfinite(raw) & np.isin(quality, accepted_dqf)
            # Flow must never infer vectors across missing radiances.
            valid &= good
            image = np.where(good, raw, 0).astype(np.float32)
    return Frame(at, grid, cloudy, valid, heights, source, image, estimated)


def segment(frame: Frame, min_pixels=2) -> list[Region]:
    """Connected components; polygonize pixel runs exactly, preserving holes."""
    count, labels = cv2.connectedComponents((frame.cloudy & frame.valid).astype(np.uint8), connectivity=8)
    result = []
    g = frame.grid
    for label in range(1, count):
        mask = labels == label
        if int(mask.sum()) < min_pixels:
            continue
        rectangles = []
        for row in np.where(mask.any(axis=1))[0]:
            padded = np.pad(mask[row].astype(np.int8), 1)
            edges = np.diff(padded)
            for start, end in zip(np.where(edges == 1)[0], np.where(edges == -1)[0]):
                rectangles.append(box(g.x0+start*g.cell_m, g.y0+row*g.cell_m,
                                      g.x0+end*g.cell_m, g.y0+(row+1)*g.cell_m))
        geometry = unary_union(rectangles)
        if geometry.geom_type == "Polygon":
            geometry = MultiPolygon([geometry])
        result.append(Region(geometry, mask, float(np.median(frame.altitude_m[mask]))))
    return result


def load_dmw(path: str | Path, min_quality=80) -> WindField:
    """ABI L2 DMW vectors; pressure-derived height is a low-confidence estimate.

    Products lacking expected variables/units fail explicitly, never silently map.
    """
    with xr.open_dataset(path) as ds:
        for name in ("wind_speed", "wind_direction", "pressure", "lat", "lon", "DQF"):
            if name not in ds:
                raise ValueError(f"missing DMW variable: {name}")
        if ds.wind_speed.attrs.get("units") not in ("m s-1", "m/s"):
            raise ValueError("DMW speed units must be m/s")
        if ds.pressure.attrs.get("units") not in ("hPa", "mb"):
            raise ValueError("DMW pressure units must be hPa")
        if ds.wind_direction.attrs.get("units") not in ("degrees", "degree", "degrees_north", "degree_true"):
            raise ValueError("DMW direction must use meteorological degrees from north")
        at = timestamp(ds.attrs["time_coverage_start"])
        arrays = [np.asarray(ds[n].values).ravel() for n in
                  ("lon", "lat", "wind_speed", "wind_direction", "pressure", "DQF")]
        if len({a.size for a in arrays}) != 1:
            raise ValueError("DMW vector arrays have different lengths")
        quality = np.asarray(ds["percent_good_retrieval"].values).ravel() if "percent_good_retrieval" in ds else None
        samples = []
        for i, (lon, lat, speed, direction, pressure, dqf) in enumerate(zip(*arrays)):
            if not all(np.isfinite(v) for v in (lon, lat, speed, direction, pressure, dqf)):
                continue
            if dqf != 0 or not 50 <= pressure <= 1100 or speed < 0:
                continue
            if quality is not None and (not np.isfinite(quality[i]) or quality[i] < min_quality):
                continue
            height = max(0, 44330 * (1 - (pressure/1013.25)**.1903))
            u, v = from_direction(float(speed), float(direction))
            wind = Wind(u, v, .5, height, "GOES-DMW:standard-atmosphere-height", at, True)
            samples.append(Sample(float(lon), float(lat), height, at, wind))
    return WindField(samples)
