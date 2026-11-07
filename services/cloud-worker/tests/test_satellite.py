import numpy as np
import pytest
import xarray as xr
from cloud_worker.models import Frame, Grid, timestamp
from cloud_worker.satellite import segment, load_goes


def test_segmentation_preserves_hole_and_overcast_extent():
    g = Grid("EPSG:32618", 600000, 4700000, 1000, 8, 8)
    mask = np.ones(g.shape, bool)
    mask[3:5, 3:5] = False
    frame = Frame(timestamp("2026-11-07T12:00:00Z"), g, mask, np.ones(g.shape, bool),
                  np.full(g.shape, 2000), "test")
    regions = segment(frame)
    assert len(regions) == 1
    assert regions[0].geometry.area == 60_000_000
    assert len(regions[0].geometry.geoms[0].interiors) == 1


def test_goes_navigation_quality_and_acquisition_time(tmp_path):
    # Synthetic NetCDF exercises real CF geostationary navigation, not a mock reader.
    coords = np.linspace(-.02, .02, 21)
    mask = np.ones((21, 21), np.float32)
    mask[10, 10] = np.nan
    ds = xr.Dataset({"BCM": (("y", "x"), mask),
                     "DQF": (("y", "x"), np.zeros((21, 21))),
                     "goes_imager_projection": ((), 0)}, coords={"x": coords, "y": coords[::-1]},
                    attrs={"time_coverage_start": "2026-11-07T12:00:00Z"})
    ds.x.attrs["units"] = ds.y.attrs["units"] = "rad"
    ds.goes_imager_projection.attrs = {
        "grid_mapping_name": "geostationary", "perspective_point_height": 35786023.,
        "longitude_of_projection_origin": -75., "latitude_of_projection_origin": 0.,
        "sweep_angle_axis": "x", "semi_major_axis": 6378137., "semi_minor_axis": 6356752.31414}
    path = tmp_path / "mask.nc"
    ds.to_netcdf(path)
    g = Grid("+proj=aeqd +lat_0=0 +lon_0=-75 +datum=WGS84 +units=m", -100000, -100000, 10000, 20, 20)
    frame = load_goes(path, g)
    assert frame.observed_at.hour == 12
    assert frame.valid.any() and not frame.valid.all()
    assert frame.cloudy[frame.valid].all()
    assert frame.height_estimated
    assert frame.grid.transformer(True).transform(0, 0) == pytest.approx((-75, 0))
