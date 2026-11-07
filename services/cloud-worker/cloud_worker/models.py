"""Internal scientific types, not a duplicate public API contract."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import math

import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import MultiPolygon


def timestamp(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timestamps must include a UTC offset")
    return result.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("naive timestamp")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Grid:
    """Pixel edges in a local metric CRS. Row zero is the southern edge."""
    crs: str
    x0: float
    y0: float
    cell_m: float
    width: int
    height: int

    def __post_init__(self):
        crs = CRS.from_user_input(self.crs)
        if not crs.is_projected or any(a.unit_name != "metre" for a in crs.axis_info):
            raise ValueError("tracking grid must use a projected CRS in meters")
        if self.cell_m <= 0 or min(self.width, self.height) < 2:
            raise ValueError("invalid grid dimensions")
        if not all(math.isfinite(v) for v in (self.x0, self.y0, self.cell_m)):
            raise ValueError("grid coordinates must be finite")

    @property
    def shape(self):
        return self.height, self.width

    def centers(self):
        return np.meshgrid(self.x0 + (np.arange(self.width) + .5) * self.cell_m,
                           self.y0 + (np.arange(self.height) + .5) * self.cell_m)

    def transformer(self, inverse=False):
        return Transformer.from_crs(self.crs if inverse else "EPSG:4326",
                                    "EPSG:4326" if inverse else self.crs, always_xy=True)

    def cell(self, x, y):
        col, row = int(math.floor((x - self.x0) / self.cell_m)), int(math.floor((y - self.y0) / self.cell_m))
        return (row, col) if 0 <= row < self.height and 0 <= col < self.width else None


@dataclass
class Frame:
    observed_at: datetime
    grid: Grid
    cloudy: np.ndarray
    valid: np.ndarray
    altitude_m: np.ndarray
    source: str
    image: np.ndarray | None = None
    height_estimated: bool = False

    def __post_init__(self):
        iso(self.observed_at)
        for value in (self.cloudy, self.valid, self.altitude_m):
            if value.shape != self.grid.shape:
                raise ValueError("frame arrays must match grid")
        if self.image is not None and self.image.shape != self.grid.shape:
            raise ValueError("image must match grid")
        self.cloudy = self.cloudy.astype(bool)
        self.valid = self.valid.astype(bool)
        self.valid &= np.isfinite(self.altitude_m)


@dataclass
class Region:
    geometry: MultiPolygon  # metric CRS, never emitted directly
    mask: np.ndarray
    altitude_m: float


@dataclass
class Track:
    id: str
    geometry: MultiPolygon
    altitude_m: float
    observed_at: datetime
    position_at: datetime
    version: int = 1
    kind: str = "observed"
    status: str = "active"
    confidence: float = 1.0
    parents: list[str] = field(default_factory=list)
    expires_at: datetime | None = None
    creator_id: str | None = None


@dataclass
class Parcel:
    id: str
    cloud_id: str
    x: float
    y: float
    version: int = 1
    control_points: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class ClearEvidence:
    count: int = 0
    first_at: datetime | None = None
    last_at: datetime | None = None

    def reset(self):
        self.count, self.first_at, self.last_at = 0, None, None

    def observe(self, at: datetime, clear: bool) -> bool:
        if self.last_at is not None and at <= self.last_at:
            return False
        if not clear:
            self.reset()
            return False
        self.count += 1
        self.first_at = self.first_at or at
        self.last_at = at
        return self.count >= 3 and (at - self.first_at).total_seconds() >= 600
