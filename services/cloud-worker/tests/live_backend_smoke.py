"""Manual online check: current NOAA -> actual backend -> embedded PostGIS.

Run from repo root after installing backend dependencies. This is not a deployed
Postgres/Clerk/S3 check. Uses an isolated disposable backend and new worker state.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from cloud_worker.live import main
from cloud_worker.contracts import DEFAULT_SCHEMA
from cloud_worker.delivery import ApiClient


def run():
    root=Path(__file__).resolve().parents[3]
    output=root/'services/cloud-worker/out'
    output.mkdir(exist_ok=True)
    state=Path(tempfile.mkdtemp(prefix='backend-live-',dir=output))
    env=dict(os.environ,TRACKING_INGEST_SECRET='isolated-live-smoke-only',
             TEST_DATASET='troy-backend-live',TEST_MODE='live',TEST_RUN='regional-v1')
    process=subprocess.Popen([shutil.which('node'),str(Path(__file__).with_name('backend-harness.mjs'))],
                             cwd=root,env=env,stdout=subprocess.PIPE,text=True)
    try:
        ready=process.stdout.readline()
        if not ready:
            raise RuntimeError('backend did not start')
        base=json.loads(ready)['base']
        os.environ['DRIFT_API_BASE_URL']=base
        os.environ['TRACKING_INGEST_SECRET']=env['TRACKING_INGEST_SECRET']
        result=main(['--once','--publish','--dataset','troy-backend-live','--state-dir',str(state)])
        if result:
            raise RuntimeError('current-sky publishing failed')
        api=ApiClient(base,env['TRACKING_INGEST_SECRET'],json.loads(DEFAULT_SCHEMA.read_text()))
        persisted=api.state('troy-backend-live')
        assert persisted['sequence']>0
        sky=api.request('GET','/api/v1/sky?lat=42.73&lng=-73.68&radiusM=50000&datasetId=troy-backend-live')
        print(json.dumps({'backend':'actual handlers, embedded PostGIS','sequence':persisted['sequence'],
                          'clouds':len(persisted['clouds']),'freshness':sky['data']['freshness'],
                          'stateDirectory':str(state)}),flush=True)
    finally:
        process.terminate();process.wait(timeout=15)
        process.stdout.close()


if __name__=='__main__':
    run()
