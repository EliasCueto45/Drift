"""Height conventions and reference geometry for the frontend AR handoff.

No screen projection here: Owner 1 owns the only SkyProjection implementation.
"""
import math
from pyproj import Transformer


def ellipsoidal_height(meters, reference, geoid_undulation_m=None):
    if not math.isfinite(meters):
        raise ValueError('height must be finite')
    if reference == 'wgs84_ellipsoid':
        return meters
    if reference == 'mean_sea_level' and geoid_undulation_m is not None and math.isfinite(geoid_undulation_m):
        return meters + geoid_undulation_m
    raise ValueError('unknown datum or missing local geoid undulation; use estimated alignment')


def direction_to_cloud(viewer, cloud):
    """Both tuples are (lon,lat,WGS84 ellipsoidal height meters)."""
    if not all(math.isfinite(v) for v in (*viewer,*cloud)):
        raise ValueError('non-finite position')
    ecef=Transformer.from_crs('EPSG:4979','EPSG:4978',always_xy=True)
    origin=ecef.transform(*viewer); target=ecef.transform(*cloud)
    x,y,z=(b-a for a,b in zip(origin,target))
    lon,lat=map(math.radians,viewer[:2])
    east=-math.sin(lon)*x+math.cos(lon)*y
    north=-math.sin(lat)*math.cos(lon)*x-math.sin(lat)*math.sin(lon)*y+math.cos(lat)*z
    up=math.cos(lat)*math.cos(lon)*x+math.cos(lat)*math.sin(lon)*y+math.sin(lat)*z
    distance=math.sqrt(east*east+north*north+up*up)
    if distance < 1e-6:
        raise ValueError('viewer and cloud coincide')
    return {'azimuthDeg':math.degrees(math.atan2(east,north))%360,
            'elevationDeg':math.degrees(math.atan2(up,math.hypot(east,north))),
            'distanceM':distance}
