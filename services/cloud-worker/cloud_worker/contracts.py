"""Use Owner 4's canonical validator in a checkout, or its supplied schema in a wheel."""
import importlib.util
import json
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SCHEMA = ROOT / "packages/contracts/schemas/drift.schema.json"


def batch_validator(schema):
    if "TrackingBatch" in schema.get("$defs", {}):
        schema = {"$schema": schema["$schema"], "$defs": schema["$defs"],
                  "$ref": "#/$defs/TrackingBatch"}
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


@lru_cache
def shared_validator():
    path = ROOT / "packages/contracts/python/drift_contracts.py"
    if not path.exists():
        raise ValueError("shared contracts not found; supply --batch-schema for standalone use")
    spec = importlib.util.spec_from_file_location("drift_contracts", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate


def validate_batch(batch, schema=None):
    # JSON transport normalizes Shapely's tuple coordinates into arrays.
    wire = json.loads(json.dumps(batch, allow_nan=False))
    if schema is not None:
        batch_validator(schema).validate(wire)
    else:
        errors = shared_validator()("TrackingBatch", wire)
        if errors:
            raise ValidationError("; ".join(errors))
