import json
import math
from typing import NoReturn
from datetime import UTC, datetime
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator, FormatChecker

from .config import ROOT

SCHEMA = json.loads((ROOT / "packages/contracts/schemas/drift.schema.json").read_text())
VALIDATORS = {
    name: Draft202012Validator(
        {"$defs": SCHEMA["$defs"], "$ref": f"#/$defs/{name}"}, format_checker=FormatChecker()
    )
    for name in SCHEMA["$defs"]
}


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def fail(status, code, message) -> NoReturn:
    raise ApiError(status, code, message)


def require(condition, message, code="INVALID", status=422):
    if not condition:
        fail(status, code, message)


def validate(name, value):
    require(VALIDATORS[name].is_valid(value), f"Invalid {name}")
    return value


def exact(value, keys):
    require(isinstance(value, dict), "Expected object")
    require(set(value) <= set(keys), "Unexpected field")


def now():
    return datetime.now(UTC)


def timestamp(value):
    require(isinstance(value, str) and value.endswith("Z"), "UTC timestamp required")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        fail(422, "INVALID", "UTC timestamp required")


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def number(value):
    try:
        n = float(value)
        require(math.isfinite(n), "Finite number required")
        return n
    except (TypeError, ValueError):
        fail(422, "INVALID", "Number required")


def location(params, required=True):
    lat, lng = params.get("lat"), params.get("lng")
    if not required and lat is None and lng is None:
        return None
    require(
        lat is not None and lng is not None and str(lat).strip() and str(lng).strip(), "lat and lng required"
    )
    return validate("Anchor", {"longitude": number(lng), "latitude": number(lat)})


def radius(params):
    n = number(params.get("radiusM", 25000))
    require(0 < n <= 50000, "radiusM must be positive and at most 50000")
    return n


def limit(params):
    n = number(params.get("limit", 50))
    require(n.is_integer() and 1 <= n <= 50, "limit must be 1..50")
    return int(n)


def outline_vertices(outline):
    validate("Polygon", outline)
    require(len(outline["coordinates"]) == 1, "Created outline must have one exterior ring")
    ring = outline["coordinates"][0]
    require(ring[0] == ring[-1], "Ring must be closed")
    vertices = ring[:-1]
    require(
        3 <= len(vertices) <= 256 and len({tuple(p) for p in vertices}) == len(vertices),
        "Outline requires 3..256 distinct vertices",
    )
    return vertices


def message_input(value):
    exact(
        value,
        [
            "kind",
            "anchor",
            "expectedCloudVersion",
            "body",
            "assetId",
            "songUrl",
            "artworkTransform",
            "strokes",
        ],
    )
    validate("CreateMessageRequest", value)
    fields = {
        "text": ["body"],
        "song": ["songUrl"],
        "audio": ["assetId"],
        "png": ["assetId", "artworkTransform"],
        "drawing": ["assetId", "artworkTransform", "strokes"],
    }[value["kind"]]
    for key in fields:
        require(key in value, f"{key} required")
    for key in ["body", "songUrl", "assetId", "artworkTransform", "strokes"]:
        require(key not in value or key in fields, f"{key} not allowed for this kind")
    if value["kind"] == "text":
        require(value["body"].strip(), "Text must not be blank")
    if value["kind"] == "song":
        try:
            url = urlsplit(value["songUrl"])
            require(
                url.scheme == "https"
                and not url.username
                and not url.password
                and url.port in (None, 443)
                and url.hostname
                in {
                    "open.spotify.com",
                    "music.apple.com",
                    "www.youtube.com",
                    "youtube.com",
                    "youtu.be",
                    "soundcloud.com",
                    "music.youtube.com",
                    "bandcamp.com",
                },
                "Song host is not allowed",
            )
        except ValueError:
            fail(422, "INVALID", "Invalid song URL")
    if value["kind"] == "drawing":
        count = 0
        require(value["strokes"], "Strokes required")
        for line in value["strokes"]:
            require(isinstance(line, list) and line, "Each stroke must be a nonempty polyline")
            for point in line:
                count += 1
                require(
                    isinstance(point, list)
                    and len(point) == 2
                    and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in point),
                    "Stroke points must be normalized [x,y]",
                )
        require(count <= 10000, "At most 10000 drawing points")
    return value
