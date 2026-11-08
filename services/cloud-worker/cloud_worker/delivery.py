"""Authenticated API client and durable outbox. No media or authors are logged."""
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

from shapely.geometry import shape
from shapely.ops import transform

from .models import Track, Parcel, timestamp
from .contracts import batch_validator, validate_batch


class Conflict(RuntimeError):
    pass


class TransportUnavailable(RuntimeError):
    """Transient network/service failure; the durable journal is safe to retry."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the worker bearer credential to a redirected endpoint.
        return None


class ApiClient:
    def __init__(self, base_url, secret, schema, attempts=4, timeout=20):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise ValueError("API must use HTTPS or loopback HTTP")
        if not secret or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("invalid API configuration")
        self.base, self.secret = base_url.rstrip("/"), secret
        self.attempts, self.timeout = attempts, timeout
        self.tracking_run_id = None
        self.opener = build_opener(NoRedirect())
        self.schema = schema
        self.validator = batch_validator(schema)

    def request(self, method, path, payload=None):
        body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode() if payload is not None else None
        for attempt in range(self.attempts):
            request = Request(self.base+path, body, {"Authorization": f"Bearer {self.secret}",
                              "Content-Type": "application/json"}, method=method)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    raw = response.read(20_000_001)
                    if len(raw) > 20_000_000:
                        raise RuntimeError("tracking API response exceeds 20 MB")
                    return json.loads(raw)
            except HTTPError as error:
                if error.code == 409:
                    raise Conflict("tracking state conflict; pending batch retained") from None
                if error.code not in (408, 429, 500, 502, 503, 504):
                    raise RuntimeError(f"tracking API returned HTTP {error.code}") from None
            except (URLError, TimeoutError, ConnectionError):
                pass
            if attempt+1 < self.attempts:
                time.sleep(min(2**attempt, 8))
        raise TransportUnavailable("tracking API unavailable; pending batch retained for retry")

    def send(self, batch):
        validate_batch(batch, self.schema)
        result = self.request("POST", "/api/internal/tracking/batches", batch)["data"]
        if (result.get("sequence") != batch["sequence"]
                or ("batchId" in result and result["batchId"] != batch["batchId"])
                or ("datasetId" in result and result["datasetId"] != batch["datasetId"])):
            raise RuntimeError("invalid batch acknowledgement; checkpoint not advanced")

    def state(self, dataset_id):
        clouds, messages, cursor, seen = [], [], None, set()
        identity = None
        while True:
            query = {"datasetId": dataset_id}
            if self.tracking_run_id:
                query["trackingRunId"] = self.tracking_run_id
            if cursor:
                query["cursor"] = cursor
            page = self.request("GET", "/api/internal/tracking/state?"+urlencode(query))
            data = page["data"]
            page_identity = (data["datasetId"], data["trackingRunId"], data["sequence"])
            if data["datasetId"] != dataset_id or (identity is not None and identity != page_identity):
                raise Conflict("dataset changed during paginated state read")
            identity = page_identity
            clouds.extend(data["clouds"])
            messages.extend(data["messages"])
            cursor = page.get("nextCursor")
            if not cursor:
                return {"datasetId": identity[0], "trackingRunId": identity[1], "sequence": identity[2],
                        "clouds": clouds, "messages": messages}
            if cursor in seen:
                raise RuntimeError("repeated state cursor")
            seen.add(cursor)


def synchronize(engine, state):
    """Reconcile new posts/deletions and synthetic clouds before every observation."""
    if (state["datasetId"], state["trackingRunId"], state["sequence"]) != (
            engine.dataset_id, engine.run_id, engine.sequence):
        raise Conflict("server/checkpoint sequence or producer differs; explicit recovery required")
    transform_geo = engine.grid.transformer().transform
    server_ids = set()
    for value in state["clouds"]:
        key = value["id"]
        server_ids.add(key)
        if value["kind"] == "created" or key not in engine.tracks:
            engine.tracks[key] = Track(key, transform(transform_geo, shape(value["geometry"])),
                                      value["wind"]["altitudeM"], timestamp(value["observedAt"]),
                                      timestamp(value["updatedAt"]), value["version"], value["kind"],
                                      value["status"], value["confidence"], value["parentIds"],
                                      timestamp(value["expiresAt"]) if value["expiresAt"] else None,
                                      value["creatorId"])
            engine.tracks[key].altitude=value.get('altitude')
        if value["status"] == "expired":
            engine.tracks[key].status = "expired"
    engine.tracks = {k: t for k, t in engine.tracks.items() if k in server_ids or t.status == "expired"}
    parcels = {}
    for value in state["messages"]:
        if value.get("expiredAt"):
            continue
        key = value["id"]
        x, y = transform_geo(value["anchor"]["longitude"], value["anchor"]["latitude"])
        controls = [transform_geo(p["longitude"], p["latitude"]) for p in
                    value.get("artworkControlPoints", (value.get("artworkTransform") or {}).get("controlPoints", []))]
        existing = engine.parcels.get(key)
        position_at = timestamp(value["positionAt"]) if value.get("positionAt") else (
            existing.position_at if existing else timestamp(value["updatedAt"]))
        parcels[key] = Parcel(key, value["cloudId"], x, y, value["version"], controls, position_at)
    engine.parcels = parcels
    engine.pending = {k: v for k, v in engine.pending.items() if k in parcels}
    engine.parcel_evidence = {k: v for k, v in engine.parcel_evidence.items() if k in parcels}


def flush(journal, sink):
    if journal.value["pending"]:
        sink.send(journal.value["pending"]["batch"])
        journal.acknowledge()


def deliver(journal, frame, winds, sink):
    flush(journal, sink)  # lost acknowledgements resend the exact durable batch first
    engine = journal.engine()
    if engine.previous and frame.observed_at <= engine.previous.observed_at:
        return False
    if hasattr(sink, "state"):
        synchronize(engine, sink.state(engine.dataset_id))
    batch = engine.step(frame, winds)
    journal.stage(batch, engine)
    try:
        flush(journal, sink)
    except Conflict:
        # A 409 is not permission to discard a batch possibly already applied.
        # Recompute only if the authoritative sequence still equals the checkpoint.
        refreshed = journal.engine()
        state = sink.state(refreshed.dataset_id)
        synchronize(refreshed, state)
        replacement = refreshed.step(frame, winds)
        versions = sorted((u["messageId"], u["expectedMessageVersion"]) for u in replacement["anchorUpdates"])
        from .association import stable_id
        replacement["batchId"] = stable_id(batch["batchId"], json.dumps(versions))
        journal.stage(replacement, refreshed)
        flush(journal, sink)
    return True
