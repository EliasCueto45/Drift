import math

from pyproj import CRS, Geod, Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform

from .validation import ApiError, require, validate

GEOD = Geod(ellps="WGS84")


def point_geometry(anchor):
    return {"type": "Point", "coordinates": [anchor["longitude"], anchor["latitude"]]}


def validate_geometry(geometry):
    validate("Polygon" if geometry.get("type") == "Polygon" else "MultiPolygon", geometry)
    try:
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        require(
            polygons and all(ring[0] == ring[-1] for polygon in polygons for ring in polygon),
            "Polygon rings must close",
        )
        polygon = shape(geometry)
        require(not polygon.is_empty and polygon.is_valid and polygon.area > 0, "Invalid geographic polygon")
    except ApiError:
        raise
    except Exception:
        require(False, "Invalid geographic polygon")


def covers(geometry, anchor):
    return shape(geometry).covers(Point(anchor["longitude"], anchor["latitude"]))


def distance_m(a, b):
    return GEOD.inv(a["longitude"], a["latitude"], b["longitude"], b["latitude"])[2]


def footprint_distance_m(geometry, anchor):
    if covers(geometry, anchor):
        return 0
    # Equidistant projection centered on the caller gives meter-based distance
    # to regional polygon edges, including holes, rather than its centroid.
    crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={anchor['latitude']} +lon_0={anchor['longitude']} +datum=WGS84 +units=m"
    )
    project = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    return transform(project, shape(geometry)).distance(Point(0, 0))


def artwork_corners(anchor, artwork):
    theta = math.radians(artwork["rotationDeg"])
    result = []
    for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        east = x * artwork["widthM"] / 2 * math.cos(theta) + y * artwork["heightM"] / 2 * math.sin(theta)
        north = -x * artwork["widthM"] / 2 * math.sin(theta) + y * artwork["heightM"] / 2 * math.cos(theta)
        lon, lat, _ = GEOD.fwd(
            anchor["longitude"],
            anchor["latitude"],
            math.degrees(math.atan2(east, north)),
            math.hypot(east, north),
        )
        result.append({"longitude": lon, "latitude": lat})
    return result
