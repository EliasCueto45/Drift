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


def apparent_surface_point(lon, lat, altitude_m, metadata):
    """Intersect satellite->cloud ray with the reference ellipsoid.

    Inputs require WGS84 ellipsoidal cloud heights; output is the apparent
    zero-height geolocation used by the satellite's fixed-grid navigation.
    """
    x,y,z=Transformer.from_crs('EPSG:4979','EPSG:4978',always_xy=True).transform(lon,lat,altitude_m)
    a=float(metadata['semi_major_axis']);b=float(metadata['semi_minor_axis'])
    angle=np.deg2rad(float(metadata['longitude_of_projection_origin']))
    radius=a+float(metadata['perspective_point_height'])
    sx,sy=radius*np.cos(angle),radius*np.sin(angle)
    dx,dy,dz=x-sx,y-sy,z
    aa=(dx*dx+dy*dy)/(a*a)+dz*dz/(b*b)
    bb=2*(sx*dx+sy*dy)/(a*a)
    cc=(sx*sx+sy*sy)/(a*a)-1
    discriminant=bb*bb-4*aa*cc
    t=(-bb-np.sqrt(np.maximum(0,discriminant)))/(2*aa)
    t=np.where(discriminant>=0,t,np.nan)
    lon2,lat2,_=Transformer.from_crs('EPSG:4978','EPSG:4979',always_xy=True).transform(sx+t*dx,sy+t*dy,t*dz)
    return lon2,lat2


def _sample(ds, variable, grid, ellipsoid_height_m=None):
    var = ds[variable]
    mapping_name = var.attrs.get("grid_mapping", "goes_imager_projection")
    metadata = ds[mapping_name].attrs
    crs = CRS.from_cf(metadata)
    height = float(metadata["perspective_point_height"])
    xx, yy = grid.centers()
    if ellipsoid_height_m is not None:
        lon,lat=grid.transformer(True).transform(xx,yy)
        lon,lat=apparent_surface_point(lon,lat,ellipsoid_height_m,metadata)
        sx,sy=Transformer.from_crs('EPSG:4326',crs,always_xy=True).transform(lon,lat)
    else:
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
              accepted_dqf=(0,), assumed_height_m=2000, max_pair_age_s=300,
              height_reference=None, parallax=False, geoid_undulation_m=None) -> Frame:
    """BCM=0 clear, BCM=1 cloudy; all other/missing values are unknown.

    Height and CMI are optional co-timed products with their own navigation.
    Unknown parallax is reported as uncertainty (height_estimated), not hidden.
    """
    if not np.isfinite(assumed_height_m) or not 0 <= assumed_height_m <= 25000:
        raise ValueError('assumed height must be finite and between 0 and 25000 meters')
    with xr.open_dataset(mask_path) as ds:
        at = timestamp(ds.attrs["time_coverage_start"])
        bcm, inside = _sample(ds, "BCM", grid)
        dqf, _ = _sample(ds, "DQF", grid)
        valid = inside & np.isin(bcm, (0, 1)) & np.isin(dqf, accepted_dqf)
        cloudy = bcm == 1
        source = str(ds.attrs.get("dataset_name", Path(mask_path).name))
    heights = np.full(grid.shape, float(assumed_height_m))
    estimated = True
    measured = np.zeros(grid.shape,bool)
    reference, height_source = 'mean_sea_level', 'assumed-2000m-plane'
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
            measured = good
            height_source = str(ds.attrs.get('dataset_name',Path(height_path).name))
            reference = {'height_above_mean_sea_level':'mean_sea_level',
                         'height_above_reference_ellipsoid':'wgs84_ellipsoid'}.get(ds.HT.attrs.get('standard_name'),'unknown')
            if height_reference is not None:
                reference=height_reference
            estimated = not np.all(good[cloudy & valid])
    ellipsoid_heights=None
    if parallax:
        if reference not in ('mean_sea_level','wgs84_ellipsoid'):
            raise ValueError('parallax requires a documented height reference')
        if (reference=='mean_sea_level' or not measured.all()) and geoid_undulation_m is None:
            raise ValueError('parallax requires local geoid undulation for sea-level/assumed heights')
        offset=float(geoid_undulation_m or 0)
        if not np.isfinite(offset):
            raise ValueError('non-finite geoid undulation')
        ellipsoid_heights=heights+(offset if reference=='mean_sea_level' else 0)
        ellipsoid_heights=np.where(measured,ellipsoid_heights,heights+offset)
        with xr.open_dataset(mask_path) as ds:
            bcm,inside=_sample(ds,'BCM',grid,ellipsoid_heights)
            dqf,_=_sample(ds,'DQF',grid,ellipsoid_heights)
            cloudy=bcm==1
            valid=inside & np.isin(bcm,(0,1)) & np.isin(dqf,accepted_dqf)
        if height_path:
            with xr.open_dataset(height_path) as ds:
                raw,inside=_sample(ds,'HT',grid,ellipsoid_heights)
                quality,_=_sample(ds,'DQF',grid,ellipsoid_heights)
                measured=inside & np.isfinite(raw) & (raw>=0) & (raw<=25000) & np.isin(quality,accepted_dqf)
                heights=np.where(measured,raw,float(assumed_height_m))
                estimated=not np.all(measured[cloudy & valid])
    image = None
    if image_path:
        with xr.open_dataset(image_path) as ds:
            if abs((timestamp(ds.attrs["time_coverage_start"])-at).total_seconds()) > max_pair_age_s:
                raise ValueError("CMI product is not co-timed")
            raw, inside = _sample(ds, "CMI", grid,ellipsoid_heights)
            quality, _ = _sample(ds, "DQF", grid,ellipsoid_heights)
            good = inside & np.isfinite(raw) & np.isin(quality, accepted_dqf)
            # Flow must never infer vectors across missing radiances.
            valid &= good
            image = np.where(good, raw, 0).astype(np.float32)
    return Frame(at, grid, cloudy, valid, heights, source, image, estimated,
                 reference,height_source,measured,parallax)


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
        meters=float(np.median(frame.altitude_m[mask]))
        measured_fraction=float(frame.measured_height[mask].mean()) if frame.measured_height is not None else 0.
        provenance={'meters':meters,'reference':frame.height_reference if measured_fraction in (0,1) else 'unknown',
                    'source':frame.height_source,'estimated':measured_fraction < 1,
                    'measuredFraction':measured_fraction,'parallaxCorrected':frame.parallax_corrected}
        if measured_fraction == 0:
            provenance.update(reference='mean_sea_level',source='assumed-plane')
        if provenance['reference']=='unknown':
            provenance['estimated']=True
        result.append(Region(geometry, mask, meters,provenance))
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
