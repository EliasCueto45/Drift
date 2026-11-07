from datetime import timedelta
import pytest
from cloud_worker.cli import main, JsonlSink
from cloud_worker.delivery import deliver
from cloud_worker.state import Journal, decode, encode
from test_engine import seeded, frame, G, T
from cloud_worker.wind import WindField


def test_checkpoint_roundtrip_preserves_artwork_and_evidence():
    e = seeded()
    e.step(frame(5, False), WindField())
    restored = decode(encode(e))
    assert restored.sequence == 1
    assert restored.parcels["right"].control_points
    assert restored.parcel_evidence["left"].count == 1
    assert restored.previous.observed_at == T+timedelta(minutes=5)


def test_lost_ack_retries_identical_batch_without_advancing(tmp_path):
    journal = Journal(tmp_path/"journal.json", seeded())
    class Sink:
        def __init__(self):
            self.ids = []
        def send(self, batch):
            self.ids.append(batch["batchId"])
            if len(self.ids) == 1:
                raise RuntimeError("response lost")
    sink = Sink()
    with pytest.raises(RuntimeError):
        deliver(journal, frame(5), WindField(), sink)
    assert journal.engine().sequence == 0
    restarted = Journal(tmp_path/"journal.json", seeded())
    assert not deliver(restarted, frame(5), WindField(), sink)
    assert restarted.engine().sequence == 1
    assert sink.ids[0] == sink.ids[1]


def test_cli_replay_is_repeatable_and_refuses_live_fixture(tmp_path, capsys):
    args = ["--state-dir", str(tmp_path/"state"), "--output", str(tmp_path/"batches.jsonl")]
    assert main(args) == 0
    first = (tmp_path/"batches.jsonl").read_bytes()
    assert main(args) == 0
    assert (tmp_path/"batches.jsonl").read_bytes() == first
    assert len(first.splitlines()) == 8
    assert main(args+["--mode", "live"]) == 1
