"""Opt-in: requires Owner 2's npm ci and tests actual handlers/SQL, not the mock."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from cloud_worker.delivery import ApiClient, deliver
from cloud_worker.engine import Engine
from cloud_worker.state import Journal
from cloud_worker.contracts import DEFAULT_SCHEMA
from cloud_worker.wind import WindField
from test_engine import G, frame


@pytest.mark.skipif(os.getenv('DRIFT_TEST_BACKEND') != '1', reason='opt-in backend/PostGIS dependency install required')
def test_python_worker_against_backend_postgis(tmp_path):
    root=Path(__file__).resolve().parents[3]
    harness=Path(__file__).with_name('backend-harness.mjs')
    process=subprocess.Popen([shutil.which('node'),str(harness)],cwd=root,
                             env=dict(os.environ,TRACKING_INGEST_SECRET='backend-test-only'),
                             stdout=subprocess.PIPE,stderr=None,text=True)
    try:
        ready=process.stdout.readline()
        assert ready, 'backend harness exited before listening'
        base=json.loads(ready)['base']
        api=ApiClient(base,'backend-test-only',json.loads(DEFAULT_SCHEMA.read_text()))
        api.tracking_run_id='run'
        journal=Journal(tmp_path/'journal.json',Engine(G,'backend-worker-demo','run'))
        journal.value['checkpoint']['contentOnly']=True
        assert deliver(journal,frame(0),WindField(),api)
        state=api.state('backend-worker-demo')
        cloud=state['clouds'][0]
        lon,lat=G.transformer(True).transform(602000,4702000)
        message=api.request('POST',f"/api/v1/clouds/{cloud['id']}/messages",
                            {'kind':'text','body':'Persist across cloud split',
                             'anchor':{'longitude':lon,'latitude':lat},'expectedCloudVersion':cloud['version']})['data']
        api.request('PUT',f"/api/v1/messages/{message['id']}/upvote",{'active':True})
        mlon,mlat=G.transformer(True).transform(608000,4708000)
        orphan=api.request('POST',f"/api/v1/clouds/{cloud['id']}/messages",
                          {'kind':'text','body':'Hold then reconnect',
                           'anchor':{'longitude':mlon,'latitude':mlat},'expectedCloudVersion':cloud['version']})['data']
        split=frame(5);split.cloudy[:,7:9]=False
        assert deliver(journal,split,WindField(),api)
        state=api.state('backend-worker-demo')
        assert len(state['messages']) == 2
        moved=next(m for m in state['messages'] if m['id']==message['id'])
        assert moved['cloudId'] != cloud['id']
        visible=api.request('GET',f"/api/v1/clouds/{moved['cloudId']}/messages?scope=all")
        assert visible['data'][0]['voteCount']==1
        assert not deliver(journal,split,WindField(),api)
        split_again=frame(10);split_again.cloudy[:,7:9]=False
        assert deliver(journal,split_again,WindField(),api)
        assert deliver(journal,frame(15),WindField(),api)
        reunited=api.state('backend-worker-demo')
        assert len({m['cloudId'] for m in reunited['messages']})==1
        for minute in (20,25,30):
            assert deliver(journal,frame(minute,False),WindField(),api)
        assert api.state('backend-worker-demo')['messages']==[]
        assert journal.engine().sequence == 7
    finally:
        process.terminate();process.wait(timeout=15)
        process.stdout.close()
