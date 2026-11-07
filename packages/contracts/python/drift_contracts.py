"""Python side of the Drift contract: validates against the SAME JSON Schema as TypeScript.
Owner 3 imports `validate("TrackingBatch", obj)` before posting; CI runs this on every fixture.
Add pydantic generation later if wanted (datamodel-code-generator reads the same schema)."""
import json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "packages/contracts/schemas/drift.schema.json").read_text())
from jsonschema import Draft202012Validator, FormatChecker  # noqa: E402


def validate(def_name: str, value) -> list[str]:
    """Return a list of error strings (empty = valid)."""
    if def_name not in SCHEMA["$defs"]:
        raise KeyError(def_name)
    wrapper = {"$schema": SCHEMA["$schema"], "$defs": SCHEMA["$defs"], "$ref": f"#/$defs/{def_name}"}
    v = Draft202012Validator(wrapper, format_checker=FormatChecker())
    return [f"{'/'.join(map(str, e.absolute_path)) or '/'}: {e.message}" for e in v.iter_errors(value)]


def wind_to_uv(speed_mps: float, from_deg: float) -> tuple[float, float]:
    """Meteorological 'from' direction (clockwise from true north) -> (u east, v north) m/s."""
    t = math.radians(from_deg)
    return (-speed_mps * math.sin(t), -speed_mps * math.cos(t))
