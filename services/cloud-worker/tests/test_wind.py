from datetime import timedelta
import pytest
from cloud_worker.models import Grid, timestamp
from cloud_worker.wind import Wind, Sample, WindField, from_direction, advect, GEOD

T = timestamp("2026-11-07T12:00:00Z")
GRID = Grid("EPSG:32618", 580000, 4730000, 1000, 100, 100)


def sample(height, u, at=T):
    return Sample(-73.68, 42.73, height, at, Wind(u, 0, 1, height, "model", at))


def test_west_wind_advects_six_km_east():
    u, v = from_direction(10, 270)
    assert u == pytest.approx(10)
    assert v == pytest.approx(0, abs=1e-12)
    class Constant:
        def at(self, *args):
            return Wind(u, v, 1)
    x, y = GRID.transformer().transform(-73.68, 42.73)
    end = advect(x, y, GRID, Constant(), 2000, T, T+timedelta(minutes=10))
    lon, lat = GRID.transformer(True).transform(*end)
    assert lon > -73.68
    assert GEOD.inv(-73.68, 42.73, lon, lat)[2] == pytest.approx(6000, abs=2)


def test_vertical_time_and_surface_fallback():
    field = WindField([sample(1000, 0), sample(3000, 20),
                       sample(1000, 10, T+timedelta(hours=1)),
                       sample(3000, 30, T+timedelta(hours=1))])
    assert field.at(-73.68, 42.73, 2000, T+timedelta(minutes=30)).u == 15
    surface = WindField([sample(10, -10)]).at(-73.68, 42.73, 8000, T)
    assert surface.confidence < .2
    assert field.at(-73.68, 42.73, 2000, T+timedelta(hours=3)).confidence == 0
    assert field.at(0, 0, 2000, T).confidence == 0


def test_missing_wind_holds_position():
    assert advect(600000, 4740000, GRID, WindField(), 2000, T,
                  T+timedelta(minutes=10)) == (600000, 4740000)
