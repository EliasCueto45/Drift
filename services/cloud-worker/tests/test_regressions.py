from datetime import timedelta
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import numpy as np
import pytest

from cloud_worker.cli import main
from cloud_worker.delivery import ApiClient, Conflict, deliver
from cloud_worker.models import Parcel, Track
from cloud_worker.state import Journal, decode, encode
from cloud_worker.wind import Wind, WindField
from test_engine import seeded, frame, G, T


class Constant:
    def at(self, *args):
        return Wind(10, 0, 1, 2000, "test", T)


def test_outage_freezes_at_thirty_minute_horizon():
    e = seeded()
    for minute in (10, 20, 30):
        e.step(frame(minute, False, False), Constant())
    frozen = e.parcels["left"].x, e.parcels["left"].y
    for minute in (40, 50, 60):
        e.step(frame(minute, False, False), Constant())
        assert (e.parcels["left"].x, e.parcels["left"].y) == frozen
        assert e.parcels["left"].position_at == T+timedelta(minutes=30)


def test_local_clear_parcel_expires_while_overcast_survives():
    e = seeded()
    for minute in (5, 10, 15):
        f = frame(minute)
        f.cloudy[:4, :4] = False
        batch = e.step(f, WindField())
    assert "left" not in e.parcels and "right" in e.parcels
    assert any(t.status == "active" for t in e.tracks.values())
    assert {u["messageId"]: u["action"] for u in batch["anchorUpdates"]}["left"] == "expire"


def test_pending_split_orphan_survives_restart_and_reassociates():
    e = seeded()
    e.parcels["middle"] = Parcel("middle", "a", 608000, 4708000)
    for minute in (5, 10):
        f = frame(minute)
        f.cloudy[:, 7:9] = False
        e.step(f, WindField())
        e = decode(encode(e))
        assert "middle" in e.parcels
        assert "middle" in e.pending
    batch = e.step(frame(15), WindField())
    assert "middle" not in e.pending
    assert next(u for u in batch["anchorUpdates"] if u["messageId"] == "middle")["action"] == "move"


def test_deleted_created_cloud_is_not_resurrected():
    e = seeded()
    e.tracks["a"].kind = "created"
    e.tracks["a"].expires_at = T+timedelta(hours=24)
    e.tracks["a"].status = "expired"
    batch = e.step(frame(5), Constant())
    assert all(u["action"] == "expire" for u in batch["anchorUpdates"])


def test_stale_versions_refresh_and_recompute_new_batch(tmp_path):
    journal = Journal(tmp_path/"journal.json", seeded())
    class Sink:
        def __init__(self):
            self.batches = []
        def state(self, dataset):
            e = seeded()
            clouds = [e.snapshot(t, WindField(), T) for t in e.tracks.values()]
            messages = []
            for p in e.parcels.values():
                lon, lat = G.transformer(True).transform(p.x, p.y)
                messages.append({"id": p.id, "cloudId": p.cloud_id,
                                 "version": 2 if self.batches else 1,
                                 "anchor": {"longitude":lon,"latitude":lat}, "updatedAt": "2026-11-07T12:00:00Z"})
            return {"datasetId": "demo", "trackingRunId": "run", "sequence": 0,
                    "clouds": clouds, "messages": messages}
        def send(self, batch):
            self.batches.append(batch)
            if len(self.batches) == 1:
                raise Conflict("concurrent vote")
    sink = Sink()
    deliver(journal, frame(5), WindField(), sink)
    assert len(sink.batches) == 2
    assert sink.batches[0]["batchId"] != sink.batches[1]["batchId"]
    assert sink.batches[1]["anchorUpdates"][0]["expectedMessageVersion"] == 2
    assert journal.engine().sequence == 1


def test_api_sends_bearer_retries_and_checks_acknowledgement():
    class Handler(BaseHTTPRequestHandler):
        calls = 0
        def log_message(self, *args):
            pass
        def do_POST(self):
            Handler.calls += 1
            assert self.headers["Authorization"] == "Bearer test-secret"
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if Handler.calls == 1:
                self.send_response(503)
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"data": {key:payload[key] for key in
                                                  ("batchId", "datasetId", "sequence")}}).encode())
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = ApiClient(f"http://127.0.0.1:{server.server_port}", "test-secret", {"type":"object"})
        client.send({"batchId":"batch", "datasetId":"demo", "sequence":1})
        assert Handler.calls == 2
        with pytest.raises(ValueError):
            ApiClient("http://example.com", "secret", {})
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_cli_rejects_checkpoint_destination_change(tmp_path):
    args = ["--state-dir", str(tmp_path/"state"), "--output", str(tmp_path/"one.jsonl")]
    assert main(args) == 0
    args[-1] = str(tmp_path/"two.jsonl")
    assert main(args) == 1
