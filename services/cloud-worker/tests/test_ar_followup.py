from datetime import timedelta
import json
import numpy as np
import pytest
from cloud_worker.altitude import ellipsoidal_height, direction_to_cloud
from cloud_worker.engine import Engine
from cloud_worker.models import Parcel
from cloud_worker.satellite import segment
from cloud_worker.state import encode, decode
from cloud_worker.wind import WindField
from cloud_worker.contracts import validate_batch
from test_engine import G,T,frame,seeded


def test_height_reference_and_viewer_elevation():
    assert ellipsoidal_height(100,'mean_sea_level',-30)==70
    with pytest.raises(ValueError):ellipsoidal_height(100,'unknown')
    with pytest.raises(ValueError):ellipsoidal_height(100,'mean_sea_level')
    overhead=direction_to_cloud((-73.68,42.73,100),(-73.68,42.73,2100))
    assert overhead['elevationDeg']==pytest.approx(90)
    assert overhead['distanceM']==pytest.approx(2000)
    east=direction_to_cloud((-73.68,42.73,100),(-73.67,42.73,2100))
    assert east['azimuthDeg']==pytest.approx(90,abs=.1)
    assert 0<east['elevationDeg']<90


def test_height_provenance_is_regional_and_survives_restart_split():
    e=seeded()
    f=frame(5);f.cloudy[:,7:9]=False
    f.measured_height=np.ones(G.shape,bool);f.measured_height[:,:7]=False
    f.height_reference='wgs84_ellipsoid';f.height_source='test-height-product'
    batch=e.step(f,WindField());validate_batch(batch)
    live=[c for c in batch['snapshots'] if c['status']=='active']
    assert {c['altitude']['estimated'] for c in live}=={True,False}
    assert all(c['altitude']['meters']==c['wind']['altitudeM'] for c in live)
    restored=decode(encode(e))
    assert {k:t.altitude for k,t in restored.tracks.items()}=={k:t.altitude for k,t in e.tracks.items()}
    assert restored.previous.height_reference=='wgs84_ellipsoid'


def test_content_mode_empty_detection_then_first_message_activates_tracking():
    e=Engine(G,'demo','run');e.content_only=True
    first=e.step(frame(0),WindField());validate_batch(first)
    cloud=first['snapshots'][0]
    second=e.step(frame(5),WindField())
    assert second['snapshots'][0]['id']==cloud['id']
    e.parcels['note']=Parcel('note',cloud['id'],602000,4702000,position_at=T+timedelta(minutes=5))
    split=frame(10);split.cloudy[:,7:9]=False
    third=e.step(split,WindField());validate_batch(third)
    assert any(event['type']=='split' for event in third['events'])
    assert len(third['anchorUpdates'])==1
    assert third['anchorUpdates'][0]['action']=='move'
    assert e.parcels['note'].cloud_id!=cloud['id']


def test_empty_cloud_changes_do_not_generate_merge_lineage_or_dissipation():
    e=Engine(G,'demo','run');e.content_only=True
    first=e.step(frame(0),WindField());old=first['snapshots'][0]['id']
    split=frame(5);split.cloudy[:,7:9]=False
    second=e.step(split,WindField());validate_batch(second)
    assert not any(event['type'] in ('merged','split','dissipated') for event in second['events'])
    assert any(c['id']==old and c['status']=='expired' for c in second['snapshots'])
    assert decode(encode(e)).content_only


def test_mixed_height_datum_stays_unknown():
    f=frame();f.measured_height=np.ones(G.shape,bool);f.measured_height[:8]=False
    f.height_reference='mean_sea_level'
    altitude=segment(f)[0].altitude
    assert altitude['reference']=='unknown' and altitude['estimated']


def test_parallax_ray_has_correct_direction_and_zero_height_identity():
    from cloud_worker.satellite import apparent_surface_point
    metadata={'semi_major_axis':6378137.,'semi_minor_axis':6356752.314245,
              'longitude_of_projection_origin':-75.,'perspective_point_height':35786023.}
    lon,lat=apparent_surface_point(-75.,42.,0.,metadata)
    assert float(lon)==pytest.approx(-75.,abs=1e-7)
    assert float(lat)==pytest.approx(42.,abs=1e-7)
    lon,lat=apparent_surface_point(-75.,42.,10000.,metadata)
    assert float(lat)>42.  # Surface navigation places elevated targets away from nadir.
    lon,lat=apparent_surface_point(-75.,0.,10000.,metadata)
    assert float(lon)==pytest.approx(-75.,abs=1e-7)
    assert float(lat)==pytest.approx(0.,abs=1e-7)


def test_content_empty_return_does_not_resurrect_retired_id():
    e=Engine(G,'demo','run');e.content_only=True
    first=e.step(frame(0),WindField());old=first['snapshots'][0]['id']
    split=frame(5);split.cloudy[:,7:9]=False
    e.step(split,WindField())
    # Simulate backend hydration retaining an expired empty record.
    from cloud_worker.models import Track
    from shapely.geometry import shape
    from shapely.ops import transform
    geometry=transform(G.transformer().transform,shape(first['snapshots'][0]['geometry']))
    e.tracks[old]=Track(old,geometry,2000,T,T,status='expired',version=2)
    returned=e.step(frame(10),WindField())
    assert all(c['id']!=old for c in returned['snapshots'] if c['status']=='active')
