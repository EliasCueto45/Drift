import json
from pathlib import Path

import pytest
from jsonschema.exceptions import ValidationError

from cloud_worker.contracts import DEFAULT_SCHEMA, batch_validator, validate_batch
from cloud_worker.delivery import ApiClient, synchronize
from cloud_worker.inputs import synthetic_inputs
from cloud_worker.engine import Engine
from cloud_worker.wind import from_direction, WindField
from test_engine import seeded, G, T

ROOT = Path(__file__).resolve().parents[3]


def test_worker_replay_against_shared_validator():
    fixture = Path(__file__).resolve().parents[1]/"cloud_worker/fixtures/troy-demo.json"
    engine = None
    for frame, winds in synthetic_inputs(fixture):
        engine = engine or Engine(frame.grid, "troy-demo", "regional-v1")
        batch = engine.step(frame, winds)
        validate_batch(batch)
        schema = json.loads(DEFAULT_SCHEMA.read_text())
        validate_batch(batch, schema)
        broken = dict(batch, sequence=0)
        with pytest.raises(ValidationError):
            validate_batch(broken, schema)


def test_every_shared_fixture_and_wind_case():
    for path in (ROOT/"fixtures/scenarios").glob("*/batch-*.json"):
        validate_batch(json.loads(path.read_text()))
    cases = json.loads((ROOT/"fixtures/wind-cases.json").read_text())
    # Compare with the canonical helper, without assuming fixture container shape.
    import importlib.util
    spec = importlib.util.spec_from_file_location("canonical", ROOT/"packages/contracts/python/drift_contracts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for case in cases["cases"]:
        actual = from_direction(case["speedMps"], case["fromDeg"])
        assert actual == pytest.approx(module.wind_to_uv(case["speedMps"], case["fromDeg"]))
        assert actual == pytest.approx((case["expected"]["uMps"], case["expected"]["vMps"]))


def test_minimal_ack_and_mismatched_ack(monkeypatch):
    client = ApiClient("http://localhost:3000", "test", json.loads(DEFAULT_SCHEMA.read_text()))
    frame, winds = next(synthetic_inputs(Path(__file__).resolve().parents[1]/"cloud_worker/fixtures/troy-demo.json"))
    batch = Engine(frame.grid,"demo","run").step(frame,winds)
    monkeypatch.setattr(client,"request",lambda *args: {"data":{"sequence":1}})
    client.send(batch)
    monkeypatch.setattr(client,"request",lambda *args: {"data":{"sequence":2}})
    with pytest.raises(RuntimeError,match="acknowledgement"):
        client.send(batch)


def test_state_uses_canonical_artwork_control_points():
    e = seeded()
    cloud = e.snapshot(e.tracks["a"], WindField(), T)
    lon, lat = G.transformer(True).transform(602000,4702000)
    point = {"longitude":lon,"latitude":lat}
    synchronize(e,{"datasetId":"demo","trackingRunId":"run","sequence":0,
                   "clouds":[cloud],"messages":[{"id":"art","cloudId":"a","version":1,
                   "anchor":point,"updatedAt":"2026-11-07T12:00:00Z",
                   "artworkTransform":{"controlPoints":[point]}}]})
    assert e.parcels["art"].control_points[0] == pytest.approx((602000,4702000))


def test_real_worker_posts_to_shared_node_mock(tmp_path, monkeypatch):
    import os
    import shutil
    import socket
    import subprocess
    import time
    import urllib.request
    node = shutil.which("node")
    if not node:
        pytest.skip("Node required for shared mock integration")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ, PORT=str(port), TRACKING_INGEST_SECRET="integration-test-only")
    process = subprocess.Popen([node, str(ROOT/"tools/mock-api.mjs")], cwd=ROOT, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(base+"/api/v1/sky?datasetId=worker-test-demo", timeout=.2):
                    break
            except OSError:
                if process.poll() is not None:
                    pytest.fail("shared mock exited during startup")
                time.sleep(.05)
        else:
            pytest.fail("shared mock did not start")
        client = ApiClient(base,"integration-test-only",json.loads(DEFAULT_SCHEMA.read_text()))
        engine = None
        fixture = Path(__file__).resolve().parents[1]/"cloud_worker/fixtures/troy-demo.json"
        for frame, winds in synthetic_inputs(fixture):
            engine = engine or Engine(frame.grid,"worker-test-demo","regional-v1")
            batch = engine.step(frame,winds)
            client.send(batch)
            client.send(batch)  # duplicate acknowledgement must remain compatible
        sky = client.request("GET","/api/v1/sky?datasetId=worker-test-demo")
        assert sky["data"]["clouds"] == []  # final confirmed dissipation
        from cloud_worker.cli import main
        monkeypatch.setenv("DRIFT_API_BASE_URL", base)
        monkeypatch.setenv("TRACKING_INGEST_SECRET", "integration-test-only")
        assert main(["--publish", "--dataset", "cli-integration-demo",
                     "--state-dir", str(tmp_path/"journal")]) == 0
        assert main(["--publish", "--dataset", "cli-integration-demo",
                     "--state-dir", str(tmp_path/"journal")]) == 0
        result = subprocess.run([node, str(ROOT/"tools/smoke.mjs")], cwd=ROOT,
                                env=dict(env,DRIFT_API_BASE_URL=base,SMOKE_AUTH_TOKEN="mock-user"),
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout+result.stderr
    finally:
        process.terminate()
        process.wait(timeout=10)
